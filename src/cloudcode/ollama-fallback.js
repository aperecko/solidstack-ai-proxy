/**
 * Ollama Fallback Client
 * 
 * Routes requests to a local Ollama instance (localhost:11434)
 * as a last-resort offline fallback when all cloud accounts and API keys fail.
 */

import { logger } from '../utils/logger.js';
import { streamSSEResponse } from './stream-handler-reexport.js'; //workaround

/**
 * Convert Anthropic request payload to OpenAI format for Ollama.
 */
function anthropicToOpenaiPayload(anthropicRequest) {
    const { messages = [], system, max_tokens, temperature, stream } = anthropicRequest;
    const openaiMessages = [];

    if (system) {
        openaiMessages.push({ role: 'system', content: system });
    }

    for (const msg of messages) {
        const role = msg.role;
        let content = msg.content;

        if (Array.isArray(content)) {
            content = content.map(block => block.text || '').join('\n');
        }

        openaiMessages.push({ role, content });
    }

    return {
        model: 'llama3', // Default local model
        messages: openaiMessages,
        max_tokens: max_tokens || 2048,
        temperature: temperature || 0.7,
        stream: !!stream
    };
}

/**
 * Check if Ollama is running locally.
 * @returns {Promise<boolean>}
 */
export async function isOllamaAvailable() {
    try {
        const res = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(500) });
        return res.ok;
    } catch (e) {
        return false;
    }
}

/**
 * Send a request to local Ollama.
 */
export async function sendOllamaRequest(anthropicRequest) {
    logger.info('[OllamaFallback] Routing request to local Ollama...');
    const payload = anthropicToOpenaiPayload(anthropicRequest);

    const res = await fetch('http://127.0.0.1:11434/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Ollama API Error (${res.status}): ${text}`);
    }

    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || '';

    // Convert back to Anthropic response format
    return {
        id: `msg_local_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        model: 'ollama-local',
        content: [{ type: 'text', text }],
        stop_reason: 'end_turn',
        usage: {
            input_tokens: 0,
            output_tokens: 0
        }
    };
}

/**
 * Send a streaming request to local Ollama.
 */
export async function* sendOllamaStream(anthropicRequest) {
    logger.info('[OllamaFallback] Routing streaming request to local Ollama...');
    const payload = anthropicToOpenaiPayload(anthropicRequest);

    const res = await fetch('http://127.0.0.1:11434/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Ollama API Stream Error (${res.status}): ${text}`);
    }

    // Reuse streamSSEResponse which works with OpenAI SSE chunks too!
    yield* streamSSEResponse(res, 'ollama-local');
}
