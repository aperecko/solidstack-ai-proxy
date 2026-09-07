/**
 * Local Engine Fallback Driver
 * 
 * Provides dynamic offline & emergency fallback for SolidStack proxy using
 * Turbo Fieldfare (Apple Silicon streaming MoE engine) and Ollama / LocalAI engines.
 */

import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { streamSSEResponse } from './stream-handler-reexport.js';
import { logRoutingDecision } from './routing-logger.js';

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

    const defaultModel = config?.localEngine?.defaultModel || 'gemma-4-26b-a4b-it';
    const modelToUse = isLocalModel(targetModel) 
        ? (targetModel === 'gemma-4-26b-a4b' ? 'gemma-4-26b-a4b-it' : targetModel) 
        : defaultModel;

    return {
        model: modelToUse,
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
export async function resolveActiveLocalEngine(targetModel = null) {
    const pref = config?.localEngine?.provider || 'auto';
    const lowerModel = (targetModel || '').toLowerCase();

    // If request explicitly targets Ollama or Ollama Cloud models, route directly to Ollama
    if (lowerModel.includes(':cloud') || lowerModel.includes('ollama') || lowerModel.includes('glm') || lowerModel.includes('minimax') || lowerModel.includes('qwen')) {
        if (await isOllamaAvailable()) {
            return {
                provider: 'ollama',
                endpoint: config?.localEngine?.ollamaEndpoint || 'http://127.0.0.1:11434/v1'
            };
        }
    }

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

let idleShutdownTimer = null;
const IDLE_SHUTDOWN_TIMEOUT_MS = Number(process.env.LOCAL_ENGINE_IDLE_TIMEOUT_MS || 5 * 60 * 1000); // 5 minutes default

/**
 * Check if a requested model ID is a local or ollama engine model.
 * @param {string} modelId
 * @returns {boolean}
 */
export function isLocalModel(modelId) {
    if (!modelId) return false;
    const lower = modelId.toLowerCase();
    return lower.includes('gemma-4') || 
           lower.includes('turbo-fieldfare') || 
           lower.includes('turbofieldfare') || 
           lower.includes(':cloud') ||
           lower.includes('glm') ||
           lower.includes('minimax') ||
           lower.startsWith('local/') ||
           lower.startsWith('ollama/');
}

/**
 * Touch local engine usage to postpone auto-shutdown.
 */
export function touchLocalEngineUsage() {
    if (idleShutdownTimer) {
        clearTimeout(idleShutdownTimer);
    }
    idleShutdownTimer = setTimeout(async () => {
        try {
            logger.info(`[LocalEngineFallback] Idle timeout (${IDLE_SHUTDOWN_TIMEOUT_MS / 1000}s) reached. Stopping Turbo Fieldfare to free system RAM...`);
            const scriptPath = path.resolve(process.cwd(), 'bin/ss-local-engine');
            exec(`"${scriptPath}" stop turbo`);
            cachedEngineStatus = null;
        } catch (e) {
            logger.warn(`[LocalEngineFallback] Idle shutdown error: ${e.message}`);
        }
    }, IDLE_SHUTDOWN_TIMEOUT_MS);
}

/**
 * Attempt to auto-start local engines via bin/ss-local-engine if autoStart is enabled.
 */
async function autoStartLocalEngines() {
    if (config?.localEngine?.autoStart === false) return;
    try {
        const scriptPath = path.resolve(process.cwd(), 'bin/ss-local-engine');
        exec(`"${scriptPath}" start turbo`);
        await new Promise(r => setTimeout(r, 1200));
        touchLocalEngineUsage();
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
    const startTime = Date.now();
    touchLocalEngineUsage();
    let active = await resolveActiveLocalEngine(targetModel);
    if (!active && config?.localEngine?.autoStart !== false) {
        await autoStartLocalEngines();
        active = await resolveActiveLocalEngine(targetModel);
    }
    if (!active) {
        throw new Error('No local engine (Turbo Fieldfare or Ollama) available.');
    }

    logger.info(`[LocalEngineFallback] Routing request to ${active.provider} at ${active.endpoint}...`);
    const payload = anthropicToOpenaiPayload(anthropicRequest, targetModel);

    const chatUrl = `${active.endpoint.replace(/\/+$/, '')}/chat/completions`;
    const res = await fetch(chatUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000)
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Local Engine (${active.provider}) Error (${res.status}): ${text}`);
    }

    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || '';
    const latency = Date.now() - startTime;
    const finalModel = targetModel || `${active.provider}-local`;

    logRoutingDecision(
        finalModel,
        null,
        null,
        'local_fallback',
        {
            latency,
            prompt_content: JSON.stringify(anthropicRequest.messages),
            response_content: text,
            isLocal: true,
            engine: active.provider,
            tokens: {
                input: data.usage?.prompt_tokens || 0,
                output: data.usage?.completion_tokens || 0
            }
        }
    );

    return {
        id: `msg_local_${active.provider}_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        model: finalModel,
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
    const startTime = Date.now();
    touchLocalEngineUsage();
    let active = await resolveActiveLocalEngine(targetModel);
    if (!active && config?.localEngine?.autoStart !== false) {
        await autoStartLocalEngines();
        active = await resolveActiveLocalEngine(targetModel);
    }
    if (!active) {
        throw new Error('No local engine (Turbo Fieldfare or Ollama) available for streaming.');
    }

    logger.info(`[LocalEngineFallback] Routing streaming request to ${active.provider} at ${active.endpoint}...`);
    const promptContent = JSON.stringify(anthropicRequest.messages);
    const payload = anthropicToOpenaiPayload(anthropicRequest, targetModel);

    const chatUrl = `${active.endpoint.replace(/\/+$/, '')}/chat/completions`;
    const res = await fetch(chatUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000)
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Local Engine (${active.provider}) Stream Error (${res.status}): ${text}`);
    }

    let fullResponse = '';
    const finalModel = targetModel || `${active.provider}-local`;


    try {
        for await (const chunk of streamOpenAISSEResponse(res, `${active.provider}-local`)) {
            if (chunk.type === 'content_block_delta' && chunk.delta?.text) {
                fullResponse += chunk.delta.text;
            }
            yield chunk;
        }
    } finally {
        const latency = Date.now() - startTime;
        logRoutingDecision(
            finalModel,
            null,
            null,
            'local_fallback',
            {
                latency,
                prompt_content: promptContent,
                response_content: fullResponse,
                isLocal: true,
                engine: active.provider,
                tokens: {
                    input: Math.round(promptContent.length / 4),
                    output: Math.round(fullResponse.length / 4)
                }
            }
        );
    }
}

/**
 * Parse OpenAI-compatible SSE stream into Anthropic events
 * @param {Response} response
 * @param {string} modelName
 * @returns {AsyncGenerator}
 */
export async function* streamOpenAISSEResponse(response, modelName) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let hasEmittedStart = false;
    let blockIndex = 0;
    const messageId = `msg_${Date.now()}`;
    let outputTokens = 0;

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || !trimmed.startsWith('data:')) continue;

                const jsonText = trimmed.slice(5).trim();
                if (!jsonText || jsonText === '[DONE]') continue;

                try {
                    const data = JSON.parse(jsonText);
                    const delta = data.choices?.[0]?.delta;
                    const text = delta?.content || '';

                    if (!hasEmittedStart) {
                        hasEmittedStart = true;
                        yield {
                            type: 'message_start',
                            message: {
                                id: messageId,
                                type: 'message',
                                role: 'assistant',
                                content: [],
                                model: modelName,
                                stop_reason: null,
                                stop_sequence: null,
                                usage: { input_tokens: 0, output_tokens: 0 }
                            }
                        };
                        yield {
                            type: 'content_block_start',
                            index: blockIndex,
                            content_block: { type: 'text', text: '' }
                        };
                    }

                    if (text) {
                        outputTokens += Math.max(1, Math.round(text.length / 4));
                        yield {
                            type: 'content_block_delta',
                            index: blockIndex,
                            delta: { type: 'text_delta', text }
                        };
                    }
                } catch (e) {
                    // Ignore malformed chunks
                }
            }
        }
    } finally {
        if (hasEmittedStart) {
            yield { type: 'content_block_stop', index: blockIndex };
            yield {
                type: 'message_delta',
                delta: { stop_reason: 'end_turn', stop_sequence: null },
                usage: { output_tokens: outputTokens }
            };
            yield { type: 'message_stop' };
        }
    }
}

