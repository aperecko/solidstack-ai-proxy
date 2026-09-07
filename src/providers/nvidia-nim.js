/**
 * NVIDIA NIM Provider Adapter
 * 
 * Translates Anthropic Messages API requests to NVIDIA NIM (OpenAI-compatible)
 * format and streams back Anthropic SSE events with full tool calling and thinking support.
 * Integrates directly with the KeyringManager for rate limits and failover.
 */

import crypto from 'crypto';
import { keyringManager } from './keyring-manager.js';
import { logger } from '../utils/logger.js';

export const NIM_DEFAULT_MODEL = 'meta/llama-3.2-11b-vision-instruct';
export const NIM_MAX_SAFE_TOKENS = 24000;

/**
 * Estimate approximate tokens from text or payload (heuristic: 1 token ~= 3.6 chars)
 */
export function estimatePayloadTokens(payload) {
    try {
        const text = JSON.stringify(payload);
        return Math.ceil(text.length / 3.6);
    } catch {
        return 0;
    }
}

/**
 * Check if a model or task is eligible to route to NVIDIA NIM / Tier 0 Keyring.
 */
export function isNimEligible(modelId, taskTier) {
    if (!modelId) return false;
    const lower = modelId.toLowerCase();

    // Explicit NIM / FCC models
    if (
        lower.startsWith('meta/') ||
        lower.startsWith('nvidia/') ||
        lower.startsWith('deepseek') ||
        lower.startsWith('qwen/') ||
        lower.startsWith('fcc-') ||
        lower.startsWith('nim/') ||
        lower === 'auto-economic'
    ) {
        return true;
    }

    // Grunt / background subagent tasks
    if (taskTier === 'background' || taskTier === 'grunt' || taskTier === 'research') {
        return true;
    }

    return false;
}

/**
 * Convert Anthropic request payload to OpenAI / NVIDIA NIM format.
 */
export function anthropicToNimPayload(anthropicRequest, targetModel = NIM_DEFAULT_MODEL) {
    const { messages = [], system, max_tokens, temperature, stream, tools, tool_choice } = anthropicRequest;
    const openaiMessages = [];

    // 1. System message
    if (system) {
        const systemText = typeof system === 'string' 
            ? system 
            : Array.isArray(system) 
                ? system.map(s => s.text || '').join('\n') 
                : String(system);
        openaiMessages.push({ role: 'system', content: systemText });
    }

    // 2. Chat messages
    for (const msg of messages) {
        const role = msg.role;
        const rawContent = msg.content;

        if (typeof rawContent === 'string') {
            openaiMessages.push({ role, content: rawContent });
            continue;
        }

        if (Array.isArray(rawContent)) {
            let textAcc = [];
            let toolCalls = [];

            for (const block of rawContent) {
                if (typeof block === 'string') {
                    textAcc.push(block);
                } else if (block.type === 'text') {
                    textAcc.push(block.text || '');
                } else if (block.type === 'tool_use') {
                    toolCalls.push({
                        id: block.id,
                        type: 'function',
                        function: {
                            name: block.name,
                            arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input || {})
                        }
                    });
                } else if (block.type === 'tool_result') {
                    let resContent = block.content;
                    if (Array.isArray(resContent)) {
                        resContent = resContent.map(b => b.text || JSON.stringify(b)).join('\n');
                    } else if (typeof resContent !== 'string') {
                        resContent = JSON.stringify(resContent || '');
                    }
                    openaiMessages.push({
                        role: 'tool',
                        tool_call_id: block.tool_use_id,
                        content: resContent
                    });
                }
            }

            if (textAcc.length > 0 || toolCalls.length > 0) {
                const openAiMsg = { role };
                if (textAcc.length > 0) openAiMsg.content = textAcc.join('\n');
                if (toolCalls.length > 0) openAiMsg.tool_calls = toolCalls;
                openaiMessages.push(openAiMsg);
            }
        }
    }

    // 3. Tools translation
    let openaiTools = undefined;
    if (Array.isArray(tools) && tools.length > 0) {
        openaiTools = tools.map(t => ({
            type: 'function',
            function: {
                name: t.name,
                description: t.description || '',
                parameters: t.input_schema || { type: 'object', properties: {} }
            }
        }));
    }

    // 4. Tool choice
    let openaiToolChoice = undefined;
    if (tool_choice) {
        if (typeof tool_choice === 'string') {
            openaiToolChoice = tool_choice;
        } else if (tool_choice.type === 'auto') {
            openaiToolChoice = 'auto';
        } else if (tool_choice.type === 'any') {
            openaiToolChoice = 'required';
        } else if (tool_choice.type === 'tool' && tool_choice.name) {
            openaiToolChoice = { type: 'function', function: { name: tool_choice.name } };
        }
    }

    // Resolve model alias
    let effectiveModel = targetModel;
    if (targetModel.startsWith('fcc-') || targetModel === 'auto-economic') {
        effectiveModel = NIM_DEFAULT_MODEL;
    } else if (targetModel.toLowerCase().includes('deepseek')) {
        effectiveModel = 'deepseek-ai/deepseek-v4-pro-0813';
    } else if (targetModel.toLowerCase().includes('qwen')) {
        effectiveModel = 'mistralai/codestral-22b-instruct-v0.1';
    }

    const payload = {
        model: effectiveModel,
        messages: openaiMessages,
        max_tokens: max_tokens || 4096,
        temperature: temperature ?? 0.7,
        stream: !!stream
    };

    if (openaiTools) payload.tools = openaiTools;
    if (openaiToolChoice) payload.tool_choice = openaiToolChoice;

    // Context guard check
    const estimatedTokens = estimatePayloadTokens(payload);
    if (estimatedTokens > NIM_MAX_SAFE_TOKENS) {
        const err = new Error(`Request payload (${estimatedTokens} tokens) exceeds safe NVIDIA NIM context threshold (${NIM_MAX_SAFE_TOKENS}).`);
        err.code = 'CONTEXT_OVERFLOW';
        err.estimatedTokens = estimatedTokens;
        throw err;
    }

    return payload;
}

/**
 * Send a non-streaming request to NVIDIA NIM.
 */
export async function sendNimRequest(anthropicRequest, targetModel = NIM_DEFAULT_MODEL) {
    const keyInfo = keyringManager.getNextKey('nvidia') || keyringManager.getNextKey('openrouter');
    if (!keyInfo) {
        throw new Error('No active API key available in Keyring for NVIDIA NIM / OpenRouter.');
    }

    const payload = anthropicToNimPayload(anthropicRequest, targetModel);
    const chatUrl = `${keyInfo.endpoint.replace(/\/+$/, '')}/chat/completions`;

    logger.info(`[NIM] Dispatching request (${payload.model}) to ${chatUrl} via key ${keyInfo.id}...`);

    let res;
    try {
        res = await fetch(chatUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${keyInfo.key}`
            },
            body: JSON.stringify(payload)
        });
    } catch (netErr) {
        keyringManager.recordFailure('nvidia', keyInfo.id, 500);
        throw netErr;
    }

    if (!res.ok) {
        const errText = await res.text();
        keyringManager.recordFailure('nvidia', keyInfo.id, res.status);
        throw new Error(`NVIDIA NIM API Error (${res.status}): ${errText}`);
    }

    const data = await res.json();
    const choice = data.choices?.[0] || {};
    const message = choice.message || {};

    const contentBlocks = [];
    if (message.content) {
        contentBlocks.push({ type: 'text', text: message.content });
    }

    if (Array.isArray(message.tool_calls)) {
        for (const tc of message.tool_calls) {
            let parsedInput = {};
            try {
                parsedInput = JSON.parse(tc.function.arguments || '{}');
            } catch {
                parsedInput = { raw: tc.function.arguments };
            }
            contentBlocks.push({
                type: 'tool_use',
                id: tc.id || `call_${crypto.randomBytes(6).toString('hex')}`,
                name: tc.function.name,
                input: parsedInput
            });
        }
    }

    let stopReason = 'end_turn';
    if (choice.finish_reason === 'tool_calls' || message.tool_calls?.length > 0) {
        stopReason = 'tool_use';
    } else if (choice.finish_reason === 'length') {
        stopReason = 'max_tokens';
    }

    const promptTokens = data.usage?.prompt_tokens || 0;
    const completionTokens = data.usage?.completion_tokens || 0;
    keyringManager.recordSuccess('nvidia', keyInfo.id, promptTokens, completionTokens);

    return {
        id: data.id || `msg_nim_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        model: payload.model,
        content: contentBlocks,
        stop_reason: stopReason,
        usage: {
            input_tokens: data.usage?.prompt_tokens || 0,
            output_tokens: data.usage?.completion_tokens || 0
        }
    };
}

/**
 * Stream an SSE response from NVIDIA NIM, converting OpenAI SSE chunks into Anthropic SSE events.
 */
export async function* sendNimStream(anthropicRequest, targetModel = NIM_DEFAULT_MODEL) {
    const keyInfo = keyringManager.getNextKey('nvidia') || keyringManager.getNextKey('openrouter');
    if (!keyInfo) {
        throw new Error('No active API key available in Keyring for NVIDIA NIM / OpenRouter.');
    }

    const payload = anthropicToNimPayload({ ...anthropicRequest, stream: true }, targetModel);
    const chatUrl = `${keyInfo.endpoint.replace(/\/+$/, '')}/chat/completions`;

    logger.info(`[NIM] Dispatching streaming request (${payload.model}) to ${chatUrl} via key ${keyInfo.id}...`);

    let res;
    try {
        res = await fetch(chatUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${keyInfo.key}`
            },
            body: JSON.stringify(payload)
        });
    } catch (netErr) {
        keyringManager.recordFailure('nvidia', keyInfo.id, 500);
        throw netErr;
    }

    if (!res.ok) {
        const errText = await res.text();
        keyringManager.recordFailure('nvidia', keyInfo.id, res.status);
        throw new Error(`NVIDIA NIM Stream Error (${res.status}): ${errText}`);
    }

    const messageId = `msg_nim_${crypto.randomBytes(12).toString('hex')}`;
    let hasEmittedStart = false;
    let textBlockStarted = false;
    let blockIndex = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    let currentToolCall = null;
    let stopReason = 'end_turn';

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

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
                try {
                    chunk = JSON.parse(jsonStr);
                } catch {
                    continue;
                }

                if (!hasEmittedStart) {
                    hasEmittedStart = true;
                    yield {
                        type: 'message_start',
                        message: {
                            id: messageId,
                            type: 'message',
                            role: 'assistant',
                            content: [],
                            model: payload.model,
                            stop_reason: null,
                            stop_sequence: null,
                            usage: { input_tokens: 0, output_tokens: 0 }
                        }
                    };
                }

                if (chunk.usage) {
                    promptTokens = chunk.usage.prompt_tokens || promptTokens;
                    completionTokens = chunk.usage.completion_tokens || completionTokens;
                }

                const choice = chunk.choices?.[0];
                if (!choice) continue;

                const delta = choice.delta || {};

                // 1. Text delta
                if (delta.content) {
                    if (!textBlockStarted) {
                        textBlockStarted = true;
                        yield {
                            type: 'content_block_start',
                            index: blockIndex,
                            content_block: { type: 'text', text: '' }
                        };
                    }
                    completionTokens += Math.max(1, Math.ceil(delta.content.length / 4));
                    yield {
                        type: 'content_block_delta',
                        index: blockIndex,
                        delta: { type: 'text_delta', text: delta.content }
                    };
                }

                // 2. Tool calls delta
                if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
                    for (const tc of delta.tool_calls) {
                        if (tc.id || !currentToolCall) {
                            // Close previous text block if open
                            if (textBlockStarted) {
                                yield { type: 'content_block_stop', index: blockIndex };
                                textBlockStarted = false;
                                blockIndex++;
                            }
                            // Close previous tool call if open
                            if (currentToolCall) {
                                yield { type: 'content_block_stop', index: blockIndex };
                                blockIndex++;
                            }

                            currentToolCall = {
                                id: tc.id || `call_${crypto.randomBytes(6).toString('hex')}`,
                                name: tc.function?.name || 'tool'
                            };

                            yield {
                                type: 'content_block_start',
                                index: blockIndex,
                                content_block: {
                                    type: 'tool_use',
                                    id: currentToolCall.id,
                                    name: currentToolCall.name,
                                    input: {}
                                }
                            };
                        }

                        if (tc.function?.arguments) {
                            yield {
                                type: 'content_block_delta',
                                index: blockIndex,
                                delta: {
                                    type: 'input_json_delta',
                                    partial_json: tc.function.arguments
                                }
                            };
                        }
                    }
                }

                if (choice.finish_reason) {
                    if (choice.finish_reason === 'tool_calls') {
                        stopReason = 'tool_use';
                    } else if (choice.finish_reason === 'length') {
                        stopReason = 'max_tokens';
                    } else {
                        stopReason = 'end_turn';
                    }
                }
            }
        }

        // Close any trailing blocks
        if (textBlockStarted || currentToolCall) {
            yield { type: 'content_block_stop', index: blockIndex };
        }

        // Final message_delta & message_stop
        yield {
            type: 'message_delta',
            delta: { stop_reason: stopReason, stop_sequence: null },
            usage: { output_tokens: completionTokens }
        };

        yield { type: 'message_stop' };

        keyringManager.recordSuccess('nvidia', keyInfo.id, promptTokens, completionTokens);
    } catch (streamErr) {
        keyringManager.recordFailure('nvidia', keyInfo.id, 500);
        throw streamErr;
    }
}
