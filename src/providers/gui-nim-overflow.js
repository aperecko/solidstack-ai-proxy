/**
 * GUI (Antigravity IDE) NVIDIA NIM Overflow
 *
 * OPT-IN escape hatch (feature flag AG_NIM_OVERFLOW=1, DEFAULT OFF) that lets a
 * Gemini-native AG chat (POST /v1internal:streamGenerateContent) fall back to an
 * NVIDIA NIM / OpenRouter coding model when the Gemini account pool is exhausted.
 *
 * Why it's separate:
 *   - The existing NIM dispatchers (sendNimRequest / sendNimStream) speak the
 *     Anthropic Messages format. The AG GUI path sends Gemini-native payloads
 *     (contents/parts schema) and expects Gemini-format SSE back, so neither the
 *     existing payload converter nor the SSE emitter can be reused directly.
 *   - It is deliberately dormant unless AG_NIM_OVERFLOW is set, so it can be
 *     tested on demand without touching live traffic or silently burning credits.
 *
 * Safety / credit guard:
 *   - Honors the keyring's monthly credit cycle (NVIDIA free $5 tier). Once the
 *     guard reports exhaustion, the module returns false so the caller falls back
 *     to the standard 503 — no silent over-spend.
 */

import { keyringManager } from './keyring-manager.js';
import { logger } from '../utils/logger.js';

// Feature flag. Non-empty / "1" enables the overflow path. Default OFF.
export const AG_NIM_OVERFLOW_ENABLED = process.env.AG_NIM_OVERFLOW === '1';

// Model used for AG overflow (best coding model confirmed available on the key).
export const NIM_OVERFLOW_MODEL = process.env.NIM_OVERFLOW_MODEL || 'deepseek-ai/deepseek-v4-pro-0813';

// Guard: stop offloading once the provider's monthly credit allotment is this
// fraction used (default 0.7 => stop at ~70% of the monthly budget).
const CREDIT_GUARD_FRACTION = Number(process.env.NIM_CREDIT_GUARD || 0.7);

// Hard per-request safety cap on input tokens. AG agentic chats can be heavy;
// NIM context windows are limited, so we won't offload oversized payloads.
export const NIM_OVERFLOW_MAX_INPUT_TOKENS = Number(process.env.NIM_OVERFLOW_MAX_INPUT_TOKENS || 24000);

/**
 * Whether the model belongs to the NVIDIA NIM family
 * @param {string} modelId
 * @returns {boolean}
 */
export function isAgNimModel(modelId) {
    if (!modelId) return false;
    const lower = modelId.toLowerCase();
    return (
        lower.startsWith('meta/') ||
        lower.startsWith('nvidia/') ||
        lower.startsWith('deepseek') ||
        lower.startsWith('qwen/') ||
        lower.startsWith('mistralai/') ||
        lower.startsWith('fcc-') ||
        lower.includes('nim')
    );
}

/**
 * Resolve candidate model ID to the verified live NVIDIA NIM model endpoint.
 * Maps EOL or missing models to active production models on NIM.
 * @param {string} requestedModel
 * @returns {string} Live NVIDIA NIM model identifier
 */
export function resolveNimModel(requestedModel) {
    if (!requestedModel) return NIM_OVERFLOW_MODEL;
    const lower = requestedModel.toLowerCase();
    if (lower.includes('deepseek') || lower.includes('r1')) {
        return 'deepseek-ai/deepseek-v4-pro-0813';
    }
    if (lower.includes('nemotron')) {
        return 'nvidia/llama-3.1-nemotron-70b-instruct';
    }
    if (lower.includes('llama') || lower.includes('vision') || lower.startsWith('fcc-') || lower === 'meta/llama-3.2-11b-vision-instruct') {
        return 'meta/llama-3.2-11b-vision-instruct';
    }
    if (lower.includes('qwen')) {
        return 'deepseek-ai/deepseek-v4-pro-0813';
    }
    return requestedModel;
}

/**
 * Whether the overflow path is currently armed and allowed by the credit guard.
 * @param {string} [provider='nvidia']
 * @param {boolean} [isDirect=false] If true, user explicitly selected model; bypasses AG_NIM_OVERFLOW feature flag
 * @returns {boolean}
 */
export function isAgNimOverflowArmed(provider = 'nvidia', isDirect = false) {
    if (!isDirect && !AG_NIM_OVERFLOW_ENABLED) return false;
    const info = keyringManager?.getCycleUsage?.(provider);
    if (!info || !info.available) {
        // No usable key / provider unavailable -> cannot overflow.
        return false;
    }
    if (info.hasCycleInfo && info.allotment > 0) {
        const used = Number(info.cycleUsed || 0);
        if (used / info.allotment >= CREDIT_GUARD_FRACTION) {
            logger.warn(`[GuiNimOverflow] Credit guard tripped: ${used}/${info.allotment} ${info.unit} used on ${provider}; refusing overflow`);
            return false;
        }
    }
    return true;
}

/**
 * Convert a Gemini-native generateContent body into OpenAI chat messages.
 * Handles both prompt (single) and contents (multi-turn) forms.
 * @param {Object} body - Gemini generateContent request body
 * @returns {{messages:Array, system?:string}}
 */
export function geminiBodyToOpenAi(body = {}) {
    const messages = [];
    let system = null;

    const sys = body.systemInstruction || body.system_instruction;
    if (sys) {
        system = extractPartsText(sys.parts);
    }

    // Old single-"contents"(prompt) form
    if (body.contents && !Array.isArray(body.contents)) {
        messages.push({ role: 'user', content: extractPartsText(body.contents.parts) });
        return { messages, system };
    }

    // New multi-turn "contents" form
    if (Array.isArray(body.contents)) {
        for (const turn of body.contents) {
            const role = turn.role === 'model' ? 'assistant' : 'user';
            const text = extractPartsText(turn.parts);
            if (text) messages.push({ role, content: text });
        }
    }

    return { messages, system };
}

function extractPartsText(parts) {
    if (!Array.isArray(parts)) return '';
    return parts
        .map((p) => {
            if (p && typeof p.text === 'string') return p.text;
            if (p && typeof p.inlineData?.data === 'string') return '[inline image]';
            return '';
        })
        .filter(Boolean)
        .join('\n');
}

/**
 * Rough token estimate from a string (chars/4). Used as a cheap pre-flight guard.
 * @param {string} s
 */
export function estimateTokens(s = '') {
    return Math.ceil(s.length / 4);
}

/**
 * Stream a Gemini-native AG request to NVIDIA NIM, emitting Gemini-format SSE
 * lines suited to the IDE (same shape the proxy already relays from Google).
 *
 * @param {string} bodyText - Raw JSON body of the /v1internal request
 * @param {Object} options
 * @param {string} [options.model=NIM_OVERFLOW_MODEL]
 * @param {string} [options.provider='nvidia']
 * @returns {Promise<{ok:boolean, contentType:string, estimatedTokens:number, error?:string}>}
 */
export async function streamAgToNim(bodyText, options = {}) {
    const provider = options.provider || 'nvidia';
    const isDirect = !!options.isDirect;
    const model = resolveNimModel(options.model || NIM_OVERFLOW_MODEL);

    if (!isAgNimOverflowArmed(provider, isDirect)) {
        return { ok: false, contentType: null, estimatedTokens: 0, error: 'overflow-not-armed' };
    }

    let body;
    try {
        body = JSON.parse(bodyText);
    } catch {
        return { ok: false, contentType: null, estimatedTokens: 0, error: 'invalid-json' };
    }

    const { messages, system } = geminiBodyToOpenAi(body);
    const promptText = JSON.stringify(messages) + (system || '');
    const estimatedTokens = estimateTokens(promptText);

    if (estimatedTokens > NIM_OVERFLOW_MAX_INPUT_TOKENS) {
        logger.warn(`[GuiNimOverflow] Skipping overflow: ~${estimatedTokens} tokens exceeds cap ${NIM_OVERFLOW_MAX_INPUT_TOKENS}`);
        return { ok: false, contentType: null, estimatedTokens, error: 'over-token-cap' };
    }

    const keyInfo = keyringManager.getNextKey(provider);
    if (!keyInfo) {
        return { ok: false, contentType: null, estimatedTokens, error: 'no-key' };
    }

    const chatUrl = `${keyInfo.endpoint.replace(/\/+$/, '')}/chat/completions`;
    const payload = {
        model,
        stream: true,
        messages: system ? [{ role: 'system', content: system }, ...messages] : messages,
    };

    logger.info(`[GuiNimOverflow] Dispatching AG overflow (~${estimatedTokens} tok) -> ${model} via ${keyInfo.id}`);

    let res;
    try {
        res = await fetch(chatUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${keyInfo.key}` },
            body: JSON.stringify(payload),
        });
    } catch (netErr) {
        keyringManager.recordFailure(provider, keyInfo.id, 500);
        return { ok: false, contentType: null, estimatedTokens, error: `net: ${netErr.message}` };
    }

    if (!res.ok) {
        const errText = await res.text();
        keyringManager.recordFailure(provider, keyInfo.id, res.status);
        logger.warn(`[GuiNimOverflow] NIM error ${res.status}: ${errText.slice(0, 200)}`);
        return { ok: false, contentType: null, estimatedTokens, error: `${res.status}: ${errText.slice(0, 120)}` };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let promptTokens = 0;
    let completionTokens = 0;
    let first = true;

    // Return an async iterable so the caller can pump SSE into the Express response.
    return {
        ok: true,
        contentType: res.headers.get('content-type') || 'text/event-stream',
        estimatedTokens,
        stream: async function* () {
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || '';
                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (!trimmed.startsWith('data:')) continue;
                        const jsonStr = trimmed.slice(5).trim();
                        if (!jsonStr || jsonStr === '[DONE]') continue;
                        let chunk;
                        try { chunk = JSON.parse(jsonStr); } catch { continue; }

                        if (chunk.usage) {
                            promptTokens = chunk.usage.prompt_tokens || promptTokens;
                            completionTokens = chunk.usage.completion_tokens || completionTokens;
                        }
                        const choice = chunk.choices?.[0];
                        if (!choice) continue;
                        const delta = choice.delta || {};

                        if (delta.reasoning_content) {
                            const geminiSse = JSON.stringify({
                                response: {
                                    candidates: [{
                                        content: { role: 'model', parts: [{ text: delta.reasoning_content, thought: true }] },
                                        finishReason: 'STOP',
                                        index: 0,
                                    }],
                                },
                            });
                            yield `data: ${geminiSse}\n\n`;
                        }

                        if (delta.content) {
                            const geminiSse = JSON.stringify({
                                response: {
                                    candidates: [{
                                        content: { role: 'model', parts: [{ text: delta.content }] },
                                        finishReason: 'STOP',
                                        index: 0,
                                    }],
                                },
                            });
                            yield `data: ${geminiSse}\n\n`;
                        }

                        if (first) { first = false; }
                    }
                }
            } finally {
                keyringManager.recordSuccess(provider, keyInfo.id, promptTokens || Math.ceil(estimatedTokens / 2), completionTokens);
            }
        },
    };
}
