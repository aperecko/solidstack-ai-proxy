import { GoogleGenAI } from '@google/genai';
import { logger } from '../utils/logger.js';

function prepareRequest(messages, options) {
    let systemInstruction = undefined;
    const contents = [];
    
    for (const msg of messages) {
        if (msg.role === 'system') {
            systemInstruction = typeof msg.content === 'string' ? msg.content : msg.content.map(c => c.text).join('\n');
            continue;
        }
        
        let role = msg.role === 'assistant' ? 'model' : 'user';
        let parts = [];
        
        if (typeof msg.content === 'string') {
            parts.push({ text: msg.content });
        } else if (Array.isArray(msg.content)) {
            for (const part of msg.content) {
                if (part.type === 'text') {
                    parts.push({ text: part.text });
                } else if (part.type === 'image_url') {
                    let mimeType = 'image/jpeg';
                    let data = '';
                    if (part.image_url && part.image_url.url && part.image_url.url.startsWith('data:')) {
                        const match = part.image_url.url.match(/^data:([^;]+);base64,(.+)$/);
                        if (match) {
                            mimeType = match[1];
                            data = match[2];
                        }
                    }
                    if (data) {
                        parts.push({ inlineData: { mimeType, data } });
                    }
                } else if (part.type === 'image') {
                    if (part.source && part.source.type === 'base64') {
                        parts.push({
                            inlineData: {
                                mimeType: part.source.media_type,
                                data: part.source.data
                            }
                        });
                    }
                }
            }
        }
        
        if (parts.length > 0) {
            contents.push({ role, parts });
        }
    }
    
    if (options.system && !systemInstruction) {
        systemInstruction = options.system;
    }
    
    const requestConfig = {};
    if (systemInstruction) requestConfig.systemInstruction = systemInstruction;
    if (options.temperature !== undefined) requestConfig.temperature = options.temperature;
    if (options.top_p !== undefined) requestConfig.topP = options.top_p;
    if (options.top_k !== undefined) requestConfig.topK = options.top_k;
    if (options.max_tokens !== undefined) requestConfig.maxOutputTokens = options.max_tokens;
    
    const targetModel = options.model || 'gemini-2.5-flash';
    return { contents, requestConfig, targetModel };
}

export async function generateContent(messages, apiKey, options = {}) {
    const ai = new GoogleGenAI({ apiKey });
    const { contents, requestConfig, targetModel } = prepareRequest(messages, options);
    
    logger.info(`[Gemini Studio] Sending request to ${targetModel} using raw API key`);
    
    const response = await ai.models.generateContent({
        model: targetModel,
        contents,
        config: requestConfig
    });
    
    return {
        id: `msg_gemini_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        content: [
            {
                type: 'text',
                text: response.text || ''
            }
        ],
        model: targetModel,
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: {
            input_tokens: response.usageMetadata?.promptTokenCount || 0,
            output_tokens: response.usageMetadata?.candidatesTokenCount || 0
        }
    };
}

export async function* generateContentStream(messages, apiKey, options = {}) {
    const ai = new GoogleGenAI({ apiKey });
    const { contents, requestConfig, targetModel } = prepareRequest(messages, options);
    
    logger.info(`[Gemini Studio] Sending streaming request to ${targetModel} using raw API key`);
    
    const stream = await ai.models.generateContentStream({
        model: targetModel,
        contents,
        config: requestConfig
    });
    
    const msgId = `msg_gemini_${Date.now()}`;
    
    yield `data: ${JSON.stringify({
        type: 'message_start',
        message: {
            id: msgId,
            type: 'message',
            role: 'assistant',
            model: targetModel,
            content: [],
            usage: { input_tokens: 0, output_tokens: 0 }
        }
    })}\n\n`;
    
    yield `data: ${JSON.stringify({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' }
    })}\n\n`;
    
    let finalUsage = { input_tokens: 0, output_tokens: 0 };
    for await (const chunk of stream) {
        if (chunk.usageMetadata) {
            finalUsage.input_tokens = chunk.usageMetadata.promptTokenCount || 0;
            finalUsage.output_tokens = chunk.usageMetadata.candidatesTokenCount || 0;
        }
        if (chunk.text) {
            yield `data: ${JSON.stringify({
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text: chunk.text }
            })}\n\n`;
        }
    }
    
    yield `data: ${JSON.stringify({
        type: 'content_block_stop',
        index: 0
    })}\n\n`;
    
    yield `data: ${JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: finalUsage
    })}\n\n`;
    
    yield `data: {"type": "message_stop"}\n\n`;
}
