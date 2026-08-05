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
import { globalThrottle } from './utils/throttle.js';
import { logger as baseLogger } from './utils/logger.js';

// Wrap base logger with a prefix tag for this module
const logger = {
    info: (...args) => baseLogger.info('[OpenAI-Compat]', ...args),
    error: (...args) => baseLogger.error('[OpenAI-Compat]', ...args),
    warn: (...args) => baseLogger.warn('[OpenAI-Compat]', ...args),
    debug: (...args) => baseLogger.debug('[OpenAI-Compat]', ...args),
};

/**
 * Convert OpenAI-format messages to Anthropic format.
 * Extracts system messages and normalizes content blocks.
 * 
 * @param {Array} messages - OpenAI-format messages
 * @returns {{ system: string|null, messages: Array }} Anthropic-format messages with extracted system prompt
 */
function openaiToAnthropicMessages(messages) {
    let systemText = null;
    const anthropicMessages = [];

    for (const msg of messages) {
        const role = msg.role || 'user';
        let content = msg.content || '';

        if (role === 'system') {
            // Extract system prompt (use last system message if multiple)
            systemText = typeof content === 'string'
                ? content
                : (Array.isArray(content) ? content.map(b => b.text || '').join('\n') : String(content));
            continue;
        }

        // Normalize content to Anthropic block format
        if (typeof content === 'string') {
            content = [{ type: 'text', text: content }];
        } else if (Array.isArray(content)) {
            content = content.map(block => {
                if (typeof block === 'string') return { type: 'text', text: block };
                if (block.type === 'text') return block;
                // Pass through image blocks, tool blocks, etc.
                return block;
            });
        }

        // Map OpenAI 'assistant' role to Anthropic 'assistant', 'user' stays 'user'
        anthropicMessages.push({ role, content });
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
 * @param {Object} anthropicResponse - Response from sendMessage()
 * @param {string} model - Model ID
 * @returns {Object} OpenAI-format response
 */
function anthropicToOpenAIResponse(anthropicResponse, model) {
    const text = extractTextFromBlocks(anthropicResponse.content || []);
    const usage = anthropicResponse.usage || {};

    return {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: anthropicResponse.model || model,
        choices: [{
            index: 0,
            message: { role: 'assistant', content: text },
            finish_reason: anthropicResponse.stop_reason === 'end_turn' ? 'stop'
                : anthropicResponse.stop_reason === 'max_tokens' ? 'length'
                : 'stop',
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
            await ensureInitialized();

            // Apply micro-delay throttle to pace burst requests (hard invariant).
            await globalThrottle.throttle();

            const {
                model,
                input = [],
                instructions,
                stream = false,
                max_output_tokens = 4096,
                temperature = 1.0,
                top_p,
                top_k,
            } = req.body || {};

            let requestedModel = model || 'claude-sonnet-4-6';
            if (requestedModel === 'auto') {
                requestedModel = 'claude-sonnet-4-6';
            }
            // Apply the same modelMapping indirection as chat completions,
            // so clients can request an unpooled model id (e.g. gpt-5.3-codex)
            // and transparently land on a pooled model.
            const modelMapping = config.modelMapping || {};
            if (modelMapping[requestedModel] && modelMapping[requestedModel].mapping) {
                const targetModel = modelMapping[requestedModel].mapping;
                logger.info(`Mapping model ${requestedModel} -> ${targetModel}`);
                requestedModel = targetModel;
            }

            const { system, messages } = responsesInputToAnthropic(input, instructions);
            if (!messages.length) {
                return res.status(400).json({
                    error: { message: 'input must be a non-empty string or array', type: 'invalid_request_error' }
                });
            }

            const anthropicRequest = {
                model: requestedModel,
                messages,
                max_tokens: max_output_tokens,
                temperature,
                top_p,
                top_k,
                stream,
            };
            if (system) anthropicRequest.system = system;

            logger.info(`[API] Responses-compat request: model=${requestedModel}, stream=${!!stream}, items=${typeof input === 'string' ? 1 : (Array.isArray(input) ? input.length : 0)}`);

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
            } = req.body;

            let requestedModel = model || 'claude-3-5-sonnet-20241022';
            if (requestedModel === 'auto') {
                requestedModel = 'claude-sonnet-4-6';
            }
            const modelMapping = config.modelMapping || {};
            if (modelMapping[requestedModel] && modelMapping[requestedModel].mapping) {
                const targetModel = modelMapping[requestedModel].mapping;
                logger.info(`Mapping model ${requestedModel} -> ${targetModel}`);
                requestedModel = targetModel;
            }

            if (!openaiMessages.length) {
                return res.status(400).json({
                    error: { message: 'messages is required and must be a non-empty array', type: 'invalid_request_error' }
                });
            }

            // Translate OpenAI messages to Anthropic format
            const { system, messages: anthropicMessages } = openaiToAnthropicMessages(openaiMessages);

            // Build Anthropic-format request
            const anthropicRequest = {
                model: requestedModel,
                messages: anthropicMessages,
                max_tokens,
                temperature,
                top_p,
                top_k,
                stream,
            };
            if (system) anthropicRequest.system = system;

            logger.info(`[API] OpenAI-compat request: model=${requestedModel}, stream=${!!stream}, messages=${openaiMessages.length}`);

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

                    // Process the first event
                    const processEvent = (event) => {
                        switch (event.type) {
                            case 'message_start':
                                // Send role delta
                                writeChunk({ role: 'assistant', content: '' });
                                if (event.message?.usage) {
                                    inputTokens = event.message.usage.input_tokens || 0;
                                }
                                break;
                            case 'content_block_delta':
                                if (event.delta?.type === 'text_delta' && event.delta.text) {
                                    writeChunk({ content: event.delta.text });
                                }
                                break;
                            case 'message_delta':
                                if (event.usage) {
                                    outputTokens = event.usage.output_tokens || 0;
                                }
                                const reason = event.delta?.stop_reason === 'end_turn' ? 'stop'
                                    : event.delta?.stop_reason === 'max_tokens' ? 'length'
                                    : null;
                                if (reason) {
                                    writeChunk({}, reason);
                                }
                                break;
                            // content_block_start, content_block_stop, message_stop — skip
                        }
                    };

                    if (!firstResult.done) {
                        processEvent(firstResult.value);
                    }

                    for await (const event of generator) {
                        processEvent(event);
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
                try {
                    const { logConversation } = await import('./conversation-logger.js');
                    logConversation(anthropicRequest, anthropicResponse, '', '', req);
                } catch {}
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
