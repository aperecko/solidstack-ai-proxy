/**
 * OpenAI-Compatible API Middleware
 * 
 * Adds POST /v1/chat/completions endpoint that accepts OpenAI-format requests,
 * translates them to Anthropic format, dispatches through the existing message
 * handlers, and translates responses back to OpenAI format.
 * 
 * This replaces the standalone ARC Gateway (arc-gateway.py) with native Express
 * middleware that supports real SSE streaming (not fake character-by-character).
 * 
 * Usage:
 *   import { mountOpenAICompat } from './openai-compat.js';
 *   mountOpenAICompat(app, accountManager, ensureInitialized, fallbackEnabled);
 */

import { sendMessage } from './cloudcode/message-handler.js';
import { sendMessageStream } from './cloudcode/streaming-handler.js';
import { config } from './config.js';
import { resolveModelMapping } from './constants.js';
import { globalThrottle } from './utils/throttle.js';
import { logger as baseLogger } from './utils/logger.js';
import { readNetworkGate, sendNetworkUnavailable } from './utils/network-gate.js';

// Wrap base logger with a prefix tag for this module
const logger = {
    info: (...args) => baseLogger.info('[OpenAI-Compat]', ...args),
    error: (...args) => baseLogger.error('[OpenAI-Compat]', ...args),
    warn: (...args) => baseLogger.warn('[OpenAI-Compat]', ...args),
    debug: (...args) => baseLogger.debug('[OpenAI-Compat]', ...args),
};

/**
 * Semantic model alias routing table
 */
export const SEMANTIC_MODEL_MAP = {
    'fast': 'meta/llama-3.2-11b-vision-instruct',
    'free': 'meta/llama-3.2-11b-vision-instruct',
    'fcc-fast': 'meta/llama-3.2-11b-vision-instruct',
    'cheap': 'gemini-2.5-flash',
    'coding': 'claude-3-5-sonnet-20241022',
    'reasoning': 'claude-3-7-sonnet-20250219',
    'vision': 'meta/llama-3.2-11b-vision-instruct',
    'default': 'claude-3-5-sonnet-20241022',
};

/**
 * Translate OpenAI tool definitions to Anthropic tool schema.
 * @param {Array} tools - OpenAI tool array
 * @returns {Array|undefined} Anthropic tool array
 */
export function translateOpenAITools(tools) {
    if (!Array.isArray(tools) || tools.length === 0) return undefined;
    const out = [];
    for (const t of tools) {
        if (!t || typeof t !== 'object') continue;
        if (t.type === 'function' && t.function) {
            out.push({
                name: t.function.name || '',
                description: t.function.description || '',
                input_schema: t.function.parameters || { type: 'object', properties: {} },
            });
        } else if (t.name) {
            out.push({
                name: t.name,
                description: t.description || '',
                input_schema: t.parameters || t.input_schema || { type: 'object', properties: {} },
            });
        }
    }
    return out.length > 0 ? out : undefined;
}

/**
 * Translate OpenAI tool_choice to Anthropic tool_choice.
 * @param {*} toolChoice - OpenAI tool_choice parameter
 * @returns {Object|undefined} Anthropic tool_choice object
 */
export function translateOpenAIToolChoice(toolChoice) {
    if (!toolChoice) return undefined;
    if (typeof toolChoice === 'string') {
        const map = { auto: 'auto', none: 'none', required: 'any' };
        return map[toolChoice] ? { type: map[toolChoice] } : { type: 'auto' };
    }
    if (typeof toolChoice === 'object') {
        if (toolChoice.type === 'function' && toolChoice.function?.name) {
            return { type: 'tool', name: toolChoice.function.name };
        }
        return toolChoice;
    }
    return undefined;
}

/**
 * Heuristically inspect messages and system prompt to pick best model for "auto".
 */
export function analyzeRequestForModel(messages = [], system = null) {
    let combined = (system || '').toLowerCase() + ' ';
    let hasVision = false;

    for (const msg of messages) {
        if (!msg) continue;
        const content = msg.content;
        if (typeof content === 'string') {
            combined += content.toLowerCase() + ' ';
        } else if (Array.isArray(content)) {
            for (const b of content) {
                if (typeof b === 'string') {
                    combined += b.toLowerCase() + ' ';
                } else if (b && typeof b === 'object') {
                    if (b.type === 'image_url' || b.type === 'input_image' || b.type === 'image') {
                        hasVision = true;
                    } else if (b.text) {
                        combined += b.text.toLowerCase() + ' ';
                    }
                }
            }
        }
    }

    if (hasVision) return { model: SEMANTIC_MODEL_MAP.vision, reason: 'vision content detected' };

    const codingRegex = /\b(code|function|class|def|import|debug|refactor|implement|algorithm|api|endpoint|typescript|javascript|python|rust|golang|sql)\b|```/;
    if (codingRegex.test(combined)) {
        if (/\b(complex|architecture|optimize|performance|recursion|distributed)\b/.test(combined)) {
            return { model: SEMANTIC_MODEL_MAP.reasoning, reason: 'complex coding task' };
        }
        return { model: SEMANTIC_MODEL_MAP.coding, reason: 'coding task detected' };
    }

    const reasoningRegex = /\b(analyze|explain|reason|think|compare|evaluate|strategy|plan|research|investigate|pros and cons)\b/;
    if (reasoningRegex.test(combined)) {
        return { model: SEMANTIC_MODEL_MAP.reasoning, reason: 'reasoning task detected' };
    }

    if (combined.split(/\s+/).filter(Boolean).length < 25) {
        return { model: SEMANTIC_MODEL_MAP.fast, reason: 'short simple query' };
    }

    return { model: SEMANTIC_MODEL_MAP.default, reason: 'default fallback routing' };
}

/**
 * Resolve semantic aliases, model mappings, and auto routing.
 */
export function resolveRequestedModel(requestedModel, messages = [], system = null) {
    if (!requestedModel || requestedModel === 'auto') {
        const analyzed = analyzeRequestForModel(messages, system);
        logger.info(`[Auto-Router] Selected '${analyzed.model}' — ${analyzed.reason}`);
        return analyzed.model;
    }

    const lower = requestedModel.toLowerCase();
    if (SEMANTIC_MODEL_MAP[lower]) {
        const resolved = SEMANTIC_MODEL_MAP[lower];
        logger.info(`[Alias-Router] Resolved alias '${requestedModel}' -> '${resolved}'`);
        return resolved;
    }

    const modelMapping = config.modelMapping || {};
    const target = resolveModelMapping(requestedModel, modelMapping);
    if (target !== requestedModel) {
        logger.info(`[Config-Router] Mapping model '${requestedModel}' -> '${target}'`);
        return target;
    }

    return requestedModel;
}

/**
 * Convert OpenAI-format messages to Anthropic format.
 * Extracts system messages, normalizes content blocks, and preserves tool calls.
 * 
 * @param {Array} messages - OpenAI-format messages
 * @returns {{ system: string|null, messages: Array }} Anthropic-format messages with extracted system prompt
 */
export function openaiToAnthropicMessages(messages) {
    let systemText = null;
    const anthropicMessages = [];

    for (const msg of messages) {
        if (!msg || typeof msg !== 'object') continue;
        const role = msg.role || 'user';
        let content = msg.content;

        if (role === 'system' || role === 'developer') {
            const sys = typeof content === 'string'
                ? content
                : (Array.isArray(content) ? content.map(b => b.text || '').join('\n') : String(content || ''));
            systemText = systemText ? `${systemText}\n${sys}` : sys;
            continue;
        }

        if (role === 'tool') {
            // OpenAI tool response message -> Anthropic tool_result
            anthropicMessages.push({
                role: 'user',
                content: [{
                    type: 'tool_result',
                    tool_use_id: msg.tool_call_id || msg.id || 'call_default',
                    content: typeof content === 'string' ? content : JSON.stringify(content || ''),
                }]
            });
            continue;
        }

        const blocks = [];
        if (typeof content === 'string' && content.length > 0) {
            blocks.push({ type: 'text', text: content });
        } else if (Array.isArray(content)) {
            for (const b of content) {
                if (typeof b === 'string') {
                    blocks.push({ type: 'text', text: b });
                } else if (b && typeof b === 'object') {
                    if (b.type === 'text' || b.type === 'input_text' || b.type === 'output_text') {
                        blocks.push({ type: 'text', text: b.text || '' });
                    } else if (b.type === 'image_url' || b.type === 'input_image') {
                        const url = b.image_url?.url || b.image_url || b.url || '';
                        if (typeof url === 'string' && url.startsWith('data:')) {
                            const [header, b64] = url.split(',', 2);
                            const mediaType = header.replace(/^data:/, '').split(';', 1)[0] || 'image/png';
                            blocks.push({
                                type: 'image',
                                source: { type: 'base64', media_type: mediaType, data: b64 || '' }
                            });
                        }
                    } else {
                        blocks.push(b);
                    }
                }
            }
        }

        // Check for OpenAI assistant tool_calls -> Anthropic tool_use blocks
        if (role === 'assistant' && Array.isArray(msg.tool_calls)) {
            for (const tc of msg.tool_calls) {
                let parsedInput = {};
                try {
                    parsedInput = typeof tc.function?.arguments === 'string'
                        ? JSON.parse(tc.function.arguments)
                        : (tc.function?.arguments || {});
                } catch {
                    parsedInput = { _raw: tc.function?.arguments };
                }
                blocks.push({
                    type: 'tool_use',
                    id: tc.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
                    name: tc.function?.name || 'function',
                    input: parsedInput,
                });
            }
        }

        if (blocks.length > 0) {
            anthropicMessages.push({ role: role === 'assistant' ? 'assistant' : 'user', content: blocks });
        }
    }

    return { system: systemText, messages: anthropicMessages };
}

/**
 * Extract text content from Anthropic response content blocks.
 * @param {Array} contentBlocks - Anthropic content blocks
 * @returns {string} Combined text content
 */
function extractTextFromBlocks(contentBlocks) {
    if (!Array.isArray(contentBlocks)) return '';
    return contentBlocks
        .filter(b => b.type === 'text')
        .map(b => b.text || '')
        .join('');
}

/**
 * Convert an Anthropic Messages API response to OpenAI chat.completion format.
 * Supports text and tool_use blocks.
 * @param {Object} anthropicResponse - Response from sendMessage()
 * @param {string} model - Model ID
 * @returns {Object} OpenAI-format response
 */
export function anthropicToOpenAIResponse(anthropicResponse, model) {
    const contentBlocks = anthropicResponse.content || [];
    const textParts = [];
    const toolCalls = [];

    for (const b of contentBlocks) {
        if (!b) continue;
        if (b.type === 'text') {
            textParts.push(b.text || '');
        } else if (b.type === 'tool_use') {
            toolCalls.push({
                id: b.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
                type: 'function',
                function: {
                    name: b.name || '',
                    arguments: JSON.stringify(b.input || {}),
                }
            });
        }
    }

    const text = textParts.join('');
    const usage = anthropicResponse.usage || {};
    const messageObj = { role: 'assistant' };
    if (text || toolCalls.length === 0) {
        messageObj.content = text;
    } else {
        messageObj.content = null;
    }
    if (toolCalls.length > 0) {
        messageObj.tool_calls = toolCalls;
    }

    let finishReason = 'stop';
    if (toolCalls.length > 0) {
        finishReason = 'tool_calls';
    } else if (anthropicResponse.stop_reason === 'max_tokens') {
        finishReason = 'length';
    }

    return {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: anthropicResponse.model || model,
        choices: [{
            index: 0,
            message: messageObj,
            finish_reason: finishReason,
        }],
        usage: {
            prompt_tokens: usage.input_tokens || 0,
            completion_tokens: usage.output_tokens || 0,
            total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
        },
    };
}

/**
 * Normalize a single Responses-API request item into an Anthropic message.
 * Accepts either a string (treated as a user message) or an object with
 * `role`, `content`, `type` and `text` fields per the Responses API.
 * @param {*} item - A Responses-API `input` item
 * @returns {Object|null} Anthropic message block, or null if skipped
 */
export function responsesItemToAnthropic(item) {
    if (typeof item === 'string') {
        return { type: 'text', text: item };
    }
    if (!item || typeof item !== 'object') return null;

    // Plain-text items: content is a plain string, or an array of parts.
    if (item.content && typeof item.content === 'string') {
        return { type: 'text', text: item.content };
    }

    // Non-string `content` arrays (the common Responses case).
    if (Array.isArray(item.content)) {
        if (item.content.length === 0) return null;
        return item.content.map(part => {
            if (typeof part === 'string') return { type: 'text', text: part };
            if (!part || typeof part !== 'object') return null;
            switch (part.type) {
                case 'input_text':
                case 'output_text':
                case 'text':
                    return { type: 'text', text: (part && (part.text ?? part.content)) || '' };
                case 'input_image':
                    return { type: 'image', source: { type: 'base64', media_type: part.mime_type || 'image/png', data: part.image_url || part.detail || '' } };
                case 'function_call':
                    return { type: 'tool_use', id: part.name || 'tool_use', name: part.name || 'function', input: part.arguments || {} };
                case 'function_call_output':
                    return { type: 'tool_result', tool_use_id: part.name || 'tool_use', content: part.output ?? '' };
                default:
                    return null;
            }
        }).filter(Boolean);
    }

    // Object that is itself a part (no `content` wrapper): function calls,
    // function outputs, or a direct `{type, text}` item.
    const { text, type } = item;
    if (type === 'function_call') {
        return { type: 'tool_use', id: item.name || 'tool_use', name: item.name || 'function', input: item.arguments || {} };
    }
    if (type === 'function_call_output') {
        return { type: 'tool_result', tool_use_id: item.name || 'tool_use', content: item.output ?? '' };
    }
    if (text && typeof text === 'string') {
        return { type: String(type === 'input_text' || type === 'output_text' ? 'text' : type || 'text'), text };
    }
    return null;
}

/**
 * Convert a Responses-API `input` into an Anthropic messages array.
 * @param {*} input - string, or array of items
 * @returns {{ system: string|null, messages: Array }}
 */
export function responsesInputToAnthropic(input, instructions) {
    let systemText = instructions ? (typeof instructions === 'string' ? instructions : String(instructions)) : null;
    const messages = [];
    const pushText = (role, contentBlocks) => {
        const blocks = (Array.isArray(contentBlocks) ? contentBlocks : [contentBlocks]).filter(Boolean);
        if (!blocks.length) return;
        messages.push({ role, content: blocks });
    };

    if (typeof input === 'string') {
        if (input.trim()) pushText('user', [{ type: 'text', text: input }]);
    } else if (Array.isArray(input)) {
        for (const item of input) {
            if (!item || typeof item !== 'object') continue;
            const blocks = responsesItemToAnthropic(item);
            if (!blocks) continue;
            const role = item.role || 'user';
            if (role === 'system') {
                // Fold system content into the system prompt unless one exists.
                const text = Array.isArray(blocks)
                    ? blocks.map(b => (b && b.text) || '').filter(Boolean).join('\n')
                    : (blocks && blocks.text) || '';
                if (text) systemText = systemText ? `${systemText}\n${text}` : text;
                continue;
            }
            const roleMap = { assistant: 'assistant', developer: 'user', user: 'user', system: 'user' };
            pushText(roleMap[role] || 'user', blocks);
        }
    }

    return { system: systemText, messages };
}

/**
 * Translate an Anthropic response into an OpenAI Responses-API item list.
 * @param {Object} anthropicResponse - Response from sendMessage()
 * @param {string} model - Model ID to stamp on the response
 * @returns {Object} OpenAI Responses-API-compatible object
 */
export function anthropicToResponsesResponse(anthropicResponse, model) {
    const text = extractTextFromBlocks(anthropicResponse.content || []);
    const usage = anthropicResponse.usage || {};
    const ts = Math.floor(Date.now() / 1000);
    const id = `resp_${Date.now()}`;
    const itemId = `msg_${Date.now()}`;

    return {
        id,
        object: 'response',
        created_at: ts,
        status: 'completed',
        model: anthropicResponse.model || model,
        output: [{
            id: itemId,
            type: 'message',
            role: 'assistant',
            content: text ? [{ type: 'output_text', text, annotations: [] }] : [],
        }],
        usage: {
            input_tokens: usage.input_tokens || 0,
            output_tokens: usage.output_tokens || 0,
            total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
        },
    };
}

/**
 * Emit an OpenAI Responses-API SSE event on `res`.
 * @param {import('stream').Writable} res - HTTP response stream
 * @param {string} event - SSE event type
 * @param {Object} data - Payload for `data:` line
 */
function writeResponsesEvent(res, event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    if (res.flush) res.flush();
}

/**
 * Mount the OpenAI Responses-API bridge (POST /v1/responses).
 *
 * Codex v0.146+ only speaks the Responses API (`wire_api = "chat"` was removed),
 * so this route translates Responses-API requests into the existing Anthropic
 * message pipeline and emits Responses-API-shaped JSON / SSE back. Reuses the
 * pool's load balancer, quota management, throttle and fallback unchanged.
 *
 * @param {Express.Application} app - Express app
 * @param {AccountManager} accountManager - Account manager instance
 * @param {Function} ensureInitialized - Async init guard
 * @param {boolean} fallbackEnabled - Whether model fallback is enabled
 */
export function mountResponsesCompat(app, accountManager, ensureInitialized, fallbackEnabled) {

    /**
     * POST /v1/responses — OpenAI Responses-API endpoint
     */
    app.post('/v1/responses', async (req, res) => {
        try {
            const gate = readNetworkGate();
            if (gate) return sendNetworkUnavailable(res, gate);
            await ensureInitialized();

            // Apply micro-delay throttle to pace burst requests (hard invariant).
            await globalThrottle.throttle();

            const {
                model,
                input = [],
                instructions,
                tools,
                tool_choice,
                stream = false,
                max_output_tokens = 4096,
                temperature = 1.0,
                top_p,
                top_k,
            } = req.body || {};

            const { system, messages } = responsesInputToAnthropic(input, instructions);
            if (!messages.length) {
                return res.status(400).json({
                    error: { message: 'input must be a non-empty string or array', type: 'invalid_request_error' }
                });
            }

            const requestedModel = resolveRequestedModel(model, messages, system);

            if (accountManager.isAllRateLimited(requestedModel)) {
                logger.warn(`[Responses-Compat] All accounts rate-limited for ${requestedModel}. Resetting state for optimistic retry.`);
                accountManager.resetAllRateLimits();
            }

            const anthropicRequest = {
                app: 'opencode',
                model: requestedModel,
                messages,
                max_tokens: max_output_tokens,
                temperature,
                top_p,
                top_k,
                stream,
            };
            if (system) anthropicRequest.system = system;

            const translatedTools = translateOpenAITools(tools);
            if (translatedTools) anthropicRequest.tools = translatedTools;
            const translatedToolChoice = translateOpenAIToolChoice(tool_choice);
            if (translatedToolChoice) anthropicRequest.tool_choice = translatedToolChoice;

            logger.info(`[API] Responses-compat request: model=${requestedModel}, stream=${!!stream}, items=${typeof input === 'string' ? 1 : (Array.isArray(input) ? input.length : 0)}, tools=${translatedTools ? translatedTools.length : 0}`);

            if (stream) {
                // ── SSE streaming ──
                const chatId = `resp_${Date.now()}`;
                const created = Math.floor(Date.now() / 1000);
                let inputTokens = 0;
                let outputTokens = 0;

                res.status(200);
                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');
                res.setHeader('X-Accel-Buffering', 'no');
                res.flushHeaders();

                const itemId = `msg_${Date.now()}`;
                const emitBase = { id: chatId, object: 'response', created_at: created, model: requestedModel };

                // 1) response.created
                writeResponsesEvent(res, 'response.created', { ...emitBase, status: 'in_progress', output: [], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } });

                // 2) response.output_item.added (message item header)
                writeResponsesEvent(res, 'response.output_item.added', {
                    ...emitBase,
                    output_index: 0,
                    item: { id: itemId, type: 'message', role: 'assistant', content: [], status: 'in_progress' },
                });

                // 3) response.content_part.added
                writeResponsesEvent(res, 'response.content_part.added', {
                    ...emitBase,
                    output_index: 0,
                    content_index: 0,
                    part: { type: 'output_text', text: '', annotations: [] },
                });

                try {
                    const generator = sendMessageStream(anthropicRequest, accountManager, fallbackEnabled);
                    const firstResult = await generator.next();

                    if (!firstResult.done) {
                        const ev = firstResult.value;
                        if (ev.type === 'message_start' && ev.message?.usage) {
                            inputTokens = ev.message.usage.input_tokens || 0;
                        } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
                            writeResponsesEvent(res, 'response.output_text.delta', {
                                ...emitBase,
                                output_index: 0,
                                content_index: 0,
                                delta: ev.delta.text,
                            });
                        }
                    }

                    for await (const ev of generator) {
                        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
                            writeResponsesEvent(res, 'response.output_text.delta', {
                                ...emitBase,
                                output_index: 0,
                                content_index: 0,
                                delta: ev.delta.text,
                            });
                        } else if (ev.type === 'message_delta' && ev.usage) {
                            outputTokens = ev.usage.output_tokens || 0;
                        } else if (ev.type === 'message_start' && ev.message?.usage) {
                            inputTokens = ev.message.usage.input_tokens || 0;
                        }
                    }

                    // 4) content_part.done
                    writeResponsesEvent(res, 'response.content_part.done', {
                        ...emitBase,
                        output_index: 0,
                        content_index: 0,
                        part: { type: 'output_text', text: '', annotations: [] },
                    });

                    // 5) output_item.done
                    writeResponsesEvent(res, 'response.output_item.done', {
                        ...emitBase,
                        output_index: 0,
                        item: { id: itemId, type: 'message', role: 'assistant', content: [], status: 'completed' },
                    });

                    // 6) response.completed
                    writeResponsesEvent(res, 'response.completed', {
                        ...emitBase,
                        status: 'completed',
                        output: [{
                            id: itemId,
                            type: 'message',
                            role: 'assistant',
                            content: [],
                            status: 'completed',
                        }],
                        usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens },
                    });

                } catch (error) {
                    logger.error('[Responses-Compat] Stream error:', error);
                    writeResponsesEvent(res, 'error', { message: error.message || 'upstream_error', type: 'upstream_error' });
                    writeResponsesEvent(res, 'response.completed', { ...emitBase, status: 'failed', output: [], error: { code: 'upstream_error', message: error.message } });
                }

                res.end();
            } else {
                // ── Non-streaming ──
                try {
                    const anthropicResponse = await sendMessage(anthropicRequest, accountManager, fallbackEnabled);
                    const responsesResponse = anthropicToResponsesResponse(anthropicResponse, requestedModel);
                    try {
                        const { logConversation } = await import('./conversation-logger.js');
                        logConversation(anthropicRequest, anthropicResponse, '', '', req);
                    } catch {}
                    res.json(responsesResponse);
                } catch (error) {
                    const statusCode = error.message?.includes('rate_limit') ? 429
                        : error.message?.includes('invalid') ? 400
                        : 502;
                    res.status(statusCode).json({
                        error: {
                            message: error.message || 'Internal proxy error',
                            type: statusCode === 429 ? 'rate_limit_error'
                                : statusCode === 400 ? 'invalid_request_error'
                                : 'upstream_error',
                        }
                    });
                }
            }
        } catch (error) {
            logger.error('[Responses-Compat] Error:', error);
            res.status(500).json({
                error: { message: error.message || 'Internal proxy error', type: 'api_error' }
            });
        }
    });

    logger.info('[Responses-Compat] Mounted POST /v1/responses');
}

/**
 * Mount OpenAI-compatible endpoints on the Express app.
 * 
 * @param {Express.Application} app - Express app
 * @param {AccountManager} accountManager - Account manager instance
 * @param {Function} ensureInitialized - Async init guard
 * @param {boolean} fallbackEnabled - Whether model fallback is enabled
 */
export function mountOpenAICompat(app, accountManager, ensureInitialized, fallbackEnabled) {

    /**
     * POST /v1/chat/completions — OpenAI-compatible chat endpoint
     * 
     * Accepts standard OpenAI ChatCompletion requests and routes them through
     * the Antigravity proxy's existing account pool and load balancer.
     */
    app.post('/v1/chat/completions', async (req, res) => {
        try {
            const gate = readNetworkGate();
            if (gate) return sendNetworkUnavailable(res, gate);
            await ensureInitialized();

            // Apply micro-delay throttle to pace burst requests
            await globalThrottle.throttle();

            const {
                model,
                messages: openaiMessages = [],
                max_tokens = 4096,
                temperature = 1.0,
                top_p,
                top_k,
                stream = false,
                tools: openaiTools,
                tool_choice: openaiToolChoice,
            } = req.body;

            const sessionId = req.headers['x-conversation-id'] || req.headers['x-session-id'] || req.headers['x-machine-session-id'] || req.headers['X-Conversation-Id'] || `chatcmpl-${Date.now()}`;
            logger.info(`[OpenAI-Compat] /v1/chat/completions Request from Session: ${sessionId}`);

            if (!openaiMessages.length) {
                return res.status(400).json({
                    error: { message: 'messages is required and must be a non-empty array', type: 'invalid_request_error' }
                });
            }

            // Translate OpenAI messages to Anthropic format
            const { system, messages: anthropicMessages } = openaiToAnthropicMessages(openaiMessages);

            // Resolve requested model with semantic aliases & auto-routing heuristics
            const requestedModel = resolveRequestedModel(model, openaiMessages, system);

            // Optimistic Retry: If all accounts are marked rate-limited for this model, reset them to force a fresh check
            if (accountManager.isAllRateLimited(requestedModel)) {
                logger.warn(`[OpenAI-Compat] All accounts rate-limited for ${requestedModel}. Resetting state for optimistic retry.`);
                accountManager.resetAllRateLimits();
            }

            // Translate tools & tool_choice
            const translatedTools = translateOpenAITools(openaiTools);
            const translatedToolChoice = translateOpenAIToolChoice(openaiToolChoice);

            // Build Anthropic-format request
            const anthropicRequest = {
                app: 'opencode',
                model: requestedModel,
                messages: anthropicMessages,
                max_tokens,
                temperature,
                top_p,
                top_k,
                stream,
            };
            if (system) anthropicRequest.system = system;
            if (translatedTools) anthropicRequest.tools = translatedTools;
            if (translatedToolChoice) anthropicRequest.tool_choice = translatedToolChoice;

            logger.info(`[API] OpenAI-compat request: model=${requestedModel}, stream=${!!stream}, messages=${openaiMessages.length}, tools=${translatedTools ? translatedTools.length : 0}`);

            if (stream) {
                // ── Real SSE streaming ──
                try {
                    const generator = sendMessageStream(anthropicRequest, accountManager, fallbackEnabled);
                    const firstResult = await generator.next();

                    // If we get here, the stream started successfully
                    res.status(200);
                    res.setHeader('Content-Type', 'text/event-stream');
                    res.setHeader('Cache-Control', 'no-cache');
                    res.setHeader('Connection', 'keep-alive');
                    res.setHeader('X-Accel-Buffering', 'no');
                    res.flushHeaders();

                    const chatId = `chatcmpl-${Date.now()}`;
                    const created = Math.floor(Date.now() / 1000);
                    let inputTokens = 0;
                    let outputTokens = 0;
                    let currentToolIndex = -1;

                    // Helper to write an OpenAI SSE chunk
                    const writeChunk = (delta, finishReason = null) => {
                        const chunk = {
                            id: chatId,
                            object: 'chat.completion.chunk',
                            created,
                            model: requestedModel,
                            choices: [{
                                index: 0,
                                delta,
                                finish_reason: finishReason,
                            }],
                        };
                        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                        if (res.flush) res.flush();
                    };

                    // Process incoming Anthropic streaming events
                    const processEvent = (event) => {
                        switch (event.type) {
                            case 'message_start':
                                // Send role delta
                                writeChunk({ role: 'assistant', content: '' });
                                if (event.message?.usage) {
                                    inputTokens = event.message.usage.input_tokens || 0;
                                }
                                break;
                            case 'content_block_start':
                                if (event.content_block?.type === 'tool_use') {
                                    currentToolIndex++;
                                    writeChunk({
                                        tool_calls: [{
                                            index: currentToolIndex,
                                            id: event.content_block.id || `call_${Date.now()}`,
                                            type: 'function',
                                            function: {
                                                name: event.content_block.name || '',
                                                arguments: '',
                                            }
                                        }]
                                    });
                                }
                                break;
                            case 'content_block_delta':
                                if (event.delta?.type === 'text_delta' && event.delta.text) {
                                    writeChunk({ content: event.delta.text });
                                } else if (event.delta?.type === 'input_json_delta' && event.delta.partial_json) {
                                    writeChunk({
                                        tool_calls: [{
                                            index: currentToolIndex,
                                            function: { arguments: event.delta.partial_json }
                                        }]
                                    });
                                }
                                break;
                            case 'message_delta':
                                if (event.usage) {
                                    outputTokens = event.usage.output_tokens || 0;
                                }
                                const reason = event.delta?.stop_reason === 'tool_use' ? 'tool_calls'
                                    : event.delta?.stop_reason === 'end_turn' ? 'stop'
                                    : event.delta?.stop_reason === 'max_tokens' ? 'length'
                                    : null;
                                if (reason) {
                                    writeChunk({}, reason);
                                }
                                break;
                            // content_block_stop, message_stop — skip
                        }
                    };

                    if (!firstResult.done) {
                        processEvent(firstResult.value);
                    }

                    for await (const event of generator) {
                        processEvent(event);
                    }
                    
                    // Log to SolidStack savings DB
                    try {
                        const Database = (await import('better-sqlite3')).default;
                        const fs = await import('fs');
                        const dbPath = '/Users/test/Projects/solidstack/registry/metrics/savings.db';
                        if (fs.existsSync(dbPath)) {
                            const db = new Database(dbPath);
                            // LORAX Real-Dollar Retail Pricing Map (per 1M tokens)
                            const pricing = {
                                'claude-3-5-sonnet': { in: 3.00, out: 15.00 },
                                'claude-3-opus': { in: 15.00, out: 75.00 },
                                'claude-3-5-haiku': { in: 0.25, out: 1.25 },
                                'gemini-pro': { in: 1.25, out: 5.00 },
                                'gemini-flash': { in: 0.075, out: 0.30 },
                                'gpt-4o': { in: 2.50, out: 10.00 },
                                'gpt-4o-mini': { in: 0.15, out: 0.60 },
                                'o1-preview': { in: 15.00, out: 60.00 },
                                'o1-mini': { in: 3.00, out: 12.00 },
                                'gpt-5': { in: 5.00, out: 20.00 },
                                'llama-3-405b': { in: 2.70, out: 2.70 },
                                'llama-3-70b': { in: 0.60, out: 0.60 },
                                'llama-3-8b': { in: 0.05, out: 0.05 },
                                'mixtral': { in: 0.50, out: 0.50 },
                                'deepseek-chat': { in: 0.14, out: 0.28 }
                            };
                            
                            let costIn = 0.50; let costOut = 1.50; // Fallback default
                            let matchModel = requestedModel.toLowerCase();
                            
                            if (matchModel.includes('sonnet')) { costIn = pricing['claude-3-5-sonnet'].in; costOut = pricing['claude-3-5-sonnet'].out; }
                            else if (matchModel.includes('opus')) { costIn = pricing['claude-3-opus'].in; costOut = pricing['claude-3-opus'].out; }
                            else if (matchModel.includes('haiku')) { costIn = pricing['claude-3-5-haiku'].in; costOut = pricing['claude-3-5-haiku'].out; }
                            else if (matchModel.includes('gpt-4o-mini')) { costIn = pricing['gpt-4o-mini'].in; costOut = pricing['gpt-4o-mini'].out; }
                            else if (matchModel.includes('gpt-4o')) { costIn = pricing['gpt-4o'].in; costOut = pricing['gpt-4o'].out; }
                            else if (matchModel.includes('o1-preview')) { costIn = pricing['o1-preview'].in; costOut = pricing['o1-preview'].out; }
                            else if (matchModel.includes('o1-mini')) { costIn = pricing['o1-mini'].in; costOut = pricing['o1-mini'].out; }
                            else if (matchModel.includes('gpt-5') || matchModel.includes('luna')) { costIn = pricing['gpt-5'].in; costOut = pricing['gpt-5'].out; }
                            else if (matchModel.includes('405b')) { costIn = pricing['llama-3-405b'].in; costOut = pricing['llama-3-405b'].out; }
                            else if (matchModel.includes('70b')) { costIn = pricing['llama-3-70b'].in; costOut = pricing['llama-3-70b'].out; }
                            else if (matchModel.includes('8b')) { costIn = pricing['llama-3-8b'].in; costOut = pricing['llama-3-8b'].out; }
                            else if (matchModel.includes('mixtral')) { costIn = pricing['mixtral'].in; costOut = pricing['mixtral'].out; }
                            else if (matchModel.includes('deepseek')) { costIn = pricing['deepseek-chat'].in; costOut = pricing['deepseek-chat'].out; }
                            else if (matchModel.includes('pro')) { costIn = pricing['gemini-pro'].in; costOut = pricing['gemini-pro'].out; }
                            else if (matchModel.includes('flash') || matchModel.includes('lite')) { costIn = pricing['gemini-flash'].in; costOut = pricing['gemini-flash'].out; }
                            
                            // Apply Tier Multipliers
                            let multiplier = 1.0;
                            if (matchModel.includes('medium')) { multiplier = 1.2; }
                            else if (matchModel.includes('high') || matchModel.includes('fast')) { multiplier = 1.5; }
                            
                            costIn = costIn * multiplier;
                            costOut = costOut * multiplier;
                            
                            const retailValue = (inputTokens / 1000000) * costIn + (outputTokens / 1000000) * costOut;
                            
                            const stmt = db.prepare("INSERT OR IGNORE INTO savings (session_id, timestamp, model, tokens_in, tokens_out, retail_value_saved) VALUES (?, ?, ?, ?, ?, ?)");
                            stmt.run(sessionId, new Date().toISOString(), requestedModel, inputTokens, outputTokens, retailValue);
                            db.close();
                        }
                    } catch (e) {
                        logger.error('[OpenAI-Compat] Failed to write to savings db: ', e.message);
                    }

                    // If client requested usage in the stream, send it as the final chunk
                    if (req.body.stream_options?.include_usage) {
                        const usageChunk = {
                            id: chatId,
                            object: 'chat.completion.chunk',
                            created,
                            model: requestedModel,
                            choices: [],
                            usage: {
                                prompt_tokens: inputTokens,
                                completion_tokens: outputTokens,
                                total_tokens: inputTokens + outputTokens
                            }
                        };
                        res.write(`data: ${JSON.stringify(usageChunk)}

`);
                        if (res.flush) res.flush();
                    }

                    // Send [DONE] marker
                    res.write('data: [DONE]\n\n');
                    res.end();

                } catch (error) {
                    if (!res.headersSent) {
                        logger.error('[OpenAI-Compat] Stream init error:', error);
                        return res.status(502).json({
                            error: { message: error.message, type: 'upstream_error' }
                        });
                    }
                    // Mid-stream error
                    logger.error('[OpenAI-Compat] Mid-stream error:', error);
                    res.write(`data: ${JSON.stringify({ error: { message: error.message } })}\n\n`);
                    res.write('data: [DONE]\n\n');
                    res.end();
                }

            } else {
                // ── Non-streaming ──
                const anthropicResponse = await sendMessage(anthropicRequest, accountManager, fallbackEnabled);
                const openaiResponse = anthropicToOpenAIResponse(anthropicResponse, requestedModel);
                
                // Calculate tokens
                const inputTokens = anthropicResponse.usage?.input_tokens || 0;
                const outputTokens = anthropicResponse.usage?.output_tokens || 0;
                
                try {
                    const { logConversation } = await import('./conversation-logger.js');
                    logConversation(anthropicRequest, anthropicResponse, '', '', req);
                } catch {}

                // Log to SolidStack savings DB
                try {
                    const Database = (await import('better-sqlite3')).default;
                    const fs = await import('fs');
                    const dbPath = '/Users/test/Projects/solidstack/registry/metrics/savings.db';
                    if (fs.existsSync(dbPath)) {
                        const db = new Database(dbPath);
                        const pricing = {
                            'claude-3-5-sonnet': { in: 3.00, out: 15.00 },
                            'claude-3-opus': { in: 15.00, out: 75.00 },
                            'gemini-pro': { in: 1.25, out: 5.00 },
                            'gemini-flash': { in: 0.075, out: 0.30 }
                        };
                        
                        let costIn = 0.50; let costOut = 1.50;
                        let matchModel = requestedModel.toLowerCase();
                        if (matchModel.includes('sonnet')) { costIn = pricing['claude-3-5-sonnet'].in; costOut = pricing['claude-3-5-sonnet'].out; }
                        else if (matchModel.includes('opus')) { costIn = pricing['claude-3-opus'].in; costOut = pricing['claude-3-opus'].out; }
                        else if (matchModel.includes('pro')) { costIn = pricing['gemini-pro'].in; costOut = pricing['gemini-pro'].out; }
                        else if (matchModel.includes('flash') || matchModel.includes('lite')) { costIn = pricing['gemini-flash'].in; costOut = pricing['gemini-flash'].out; }
                        
                        const retailValue = (inputTokens / 1000000) * costIn + (outputTokens / 1000000) * costOut;
                        const chatId = openaiResponse.id || `chatcmpl-${Date.now()}`;
                        
                        const stmt = db.prepare("INSERT OR IGNORE INTO savings (session_id, timestamp, model, tokens_in, tokens_out, retail_value_saved) VALUES (?, ?, ?, ?, ?, ?)");
                        stmt.run(sessionId, new Date().toISOString(), requestedModel, inputTokens, outputTokens, retailValue);
                        db.close();
                    }
                } catch (e) {
                    logger.error('[OpenAI-Compat] Failed to write to savings db: ', e.message);
                }

                res.json(openaiResponse);
            }

        } catch (error) {
            logger.error('[OpenAI-Compat] Error:', error);
            const statusCode = error.message?.includes('rate_limit') ? 429
                : error.message?.includes('invalid') ? 400
                : 502;
            res.status(statusCode).json({
                error: {
                    message: error.message || 'Internal proxy error',
                    type: statusCode === 429 ? 'rate_limit_error'
                        : statusCode === 400 ? 'invalid_request_error'
                        : 'upstream_error',
                }
            });
        }
    });

    logger.info('[OpenAI-Compat] Mounted POST /v1/chat/completions');
}
