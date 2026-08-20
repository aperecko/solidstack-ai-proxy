/**
 * Local Engine Fallback Driver
 * 
 * Provides dynamic offline & emergency fallback for SolidStack proxy using
 * Turbo Fieldfare (Apple Silicon streaming MoE engine) and Ollama / LocalAI engines.
 */

import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { streamSSEResponse } from './stream-handler-reexport.js';

/**
 * Convert Anthropic request payload to OpenAI format for local engines.
 * @param {Object} anthropicRequest 
 * @param {string} targetModel 
 * @returns {Object} OpenAI-compatible chat completion payload
 */
export function anthropicToOpenaiPayload(anthropicRequest, targetModel) {
    const { messages = [], system, max_tokens, temperature, stream } = anthropicRequest;
    const openaiMessages = [];

    if (system) {
        openaiMessages.push({ role: 'system', content: system });
    }

    for (const msg of messages) {
        const role = msg.role;
        let content = msg.content;

        if (Array.isArray(content)) {
            content = content.map(block => {
                if (typeof block === 'string') return block;
                return block.text || '';
            }).join('\n');
        }

        openaiMessages.push({ role, content });
    }

    const defaultModel = config?.localEngine?.defaultModel || 'gemma-4-26b-a4b';

    return {
        model: targetModel || defaultModel,
        messages: openaiMessages,
        max_tokens: max_tokens || 2048,
        temperature: temperature ?? 0.7,
        stream: !!stream
    };
}

/**
 * Check if Turbo Fieldfare is running locally.
 * @returns {Promise<boolean>}
 */
export async function isTurboFieldfareAvailable() {
    const endpoint = config?.localEngine?.turboEndpoint || 'http://127.0.0.1:8088/v1';
    try {
        const res = await fetch(`${endpoint.replace(/\/+$/, '')}/models`, { signal: AbortSignal.timeout(500) });
        return res.ok;
    } catch {
        return false;
    }
}

/**
 * Check if Ollama is running locally.
 * @returns {Promise<boolean>}
 */
export async function isOllamaAvailable() {
    const endpoint = config?.localEngine?.ollamaEndpoint || 'http://127.0.0.1:11434/v1';
    try {
        const baseUrl = endpoint.replace(/\/v1\/?$/, '');
        const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(500) });
        return res.ok;
    } catch {
        return false;
    }
}

/**
 * Resolve active local provider ('turbo-fieldfare' | 'ollama' | null)
 * @returns {Promise<{provider: string, endpoint: string}|null>}
 */
export async function resolveActiveLocalEngine() {
    const pref = config?.localEngine?.provider || 'auto';

    if (pref === 'turbo-fieldfare' || pref === 'auto') {
        if (await isTurboFieldfareAvailable()) {
            return {
                provider: 'turbo-fieldfare',
                endpoint: config?.localEngine?.turboEndpoint || 'http://127.0.0.1:8088/v1'
            };
        }
    }

    if (pref === 'ollama' || pref === 'auto') {
        if (await isOllamaAvailable()) {
            return {
                provider: 'ollama',
                endpoint: config?.localEngine?.ollamaEndpoint || 'http://127.0.0.1:11434/v1'
            };
        }
    }

    return null;
}

import { exec } from 'child_process';
import path from 'path';

/**
 * Attempt to auto-start local engines via bin/ss-local-engine if autoStart is enabled.
 */
async function autoStartLocalEngines() {
    if (config?.localEngine?.autoStart === false) return;
    try {
        const scriptPath = path.resolve(process.cwd(), 'bin/ss-local-engine');
        exec(`"${scriptPath}" start all`);
        await new Promise(r => setTimeout(r, 1000));
    } catch (e) {
        logger.warn(`[LocalEngineFallback] Auto-start attempt failed: ${e.message}`);
    }
}

let cachedEngineStatus = null;
let engineStatusTimestamp = 0;
const ENGINE_STATUS_TTL_MS = 15000; // 15 seconds

/**
 * Check if any local engine is available (with TTL caching).
 * @returns {Promise<boolean>}
 */
export async function isLocalEngineAvailable() {
    if (config?.localEngine?.enabled === false) return false;

    const now = Date.now();
    if (cachedEngineStatus !== null && (now - engineStatusTimestamp < ENGINE_STATUS_TTL_MS)) {
        return cachedEngineStatus;
    }

    let active = await resolveActiveLocalEngine();
    if (!active && config?.localEngine?.autoStart !== false) {
        logger.info('[LocalEngineFallback] No active engine detected. Attempting auto-spawn via SolidStack daemon controller...');
        await autoStartLocalEngines();
        active = await resolveActiveLocalEngine();
    }
    
    cachedEngineStatus = active !== null;
    engineStatusTimestamp = Date.now();
    
    return cachedEngineStatus;
}

/**
 * Send a non-streaming request to local engine.
 * @param {Object} anthropicRequest 
 * @param {string} targetModel 
 * @returns {Promise<Object>} Anthropic-formatted response
 */
export async function sendLocalEngineRequest(anthropicRequest, targetModel) {
    const active = await resolveActiveLocalEngine();
    if (!active) {
        throw new Error('No local engine (Turbo Fieldfare or Ollama) available.');
    }

    logger.info(`[LocalEngineFallback] Routing request to ${active.provider} at ${active.endpoint}...`);
    const payload = anthropicToOpenaiPayload(anthropicRequest, targetModel);

    const chatUrl = `${active.endpoint.replace(/\/+$/, '')}/chat/completions`;
    const res = await fetch(chatUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Local Engine (${active.provider}) Error (${res.status}): ${text}`);
    }

    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || '';

    return {
        id: `msg_local_${active.provider}_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        model: `${active.provider}-local`,
        content: [{ type: 'text', text }],
        stop_reason: 'end_turn',
        usage: {
            input_tokens: data.usage?.prompt_tokens || 0,
            output_tokens: data.usage?.completion_tokens || 0
        }
    };
}

/**
 * Send a streaming request to local engine.
 * @param {Object} anthropicRequest 
 * @param {string} targetModel 
 * @returns {AsyncGenerator} SSE stream generator
 */
export async function* sendLocalEngineStream(anthropicRequest, targetModel) {
    const active = await resolveActiveLocalEngine();
    if (!active) {
        throw new Error('No local engine (Turbo Fieldfare or Ollama) available for streaming.');
    }

    logger.info(`[LocalEngineFallback] Routing streaming request to ${active.provider} at ${active.endpoint}...`);
    const payload = anthropicToOpenaiPayload(anthropicRequest, targetModel);

    const chatUrl = `${active.endpoint.replace(/\/+$/, '')}/chat/completions`;
    const res = await fetch(chatUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Local Engine (${active.provider}) Stream Error (${res.status}): ${text}`);
    }

    yield* streamSSEResponse(res, `${active.provider}-local`);
}
