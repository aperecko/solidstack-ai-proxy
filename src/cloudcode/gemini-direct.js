/**
 * Gemini Direct Developer API Client
 * 
 * Routes requests through the SolidStack proxy (http://127.0.0.1:1987)
 * which handles authentication, thinking budget clamping, and model routing.
 */

import { convertAnthropicToGoogle, convertGoogleToAnthropic } from '../format/index.js';
import { streamSSEResponse } from './stream-handler-reexport.js'; // Helper re-export to avoid circular dependencies
import { logger } from '../utils/logger.js';

function mapToGoogleDevModel(model) {
    if (!model) return 'gemini-3.1-flash';
    const clean = model.replace(/^gemini\//, '').toLowerCase();
    if (clean.includes('3.1-pro') || clean.includes('3.7-pro') || clean.includes('pro-high') || clean.includes('pro-low') || clean.includes('pro-agent')) {
        return 'gemini-3.1-pro-preview';
    }
    if (clean.includes('flash') || clean.includes('gemini-2.5') || clean.includes('gemini-2.0')) {
        return 'gemini-3.1-flash';
    }
    if (clean.includes('claude') || clean.includes('gpt')) {
        return 'gemini-3.1-flash';
    }
    return clean;
}

/**
 * Send a non-streaming request to the SolidStack proxy.
 * 
 * @param {Object} anthropicRequest - Anthropic-format request payload
 * @returns {Promise<Object>} Anthropic-format response
 */
export async function sendGeminiDirect(anthropicRequest) {
    const rawModel = anthropicRequest.model || 'gemini-2.5-flash';
    const cleanModel = mapToGoogleDevModel(rawModel);
    const url = `http://127.0.0.1:1987/v1/models/${cleanModel}:generateContent`;

    const googlePayload = convertAnthropicToGoogle(anthropicRequest);

    logger.info(`[GeminiDirect] Dispatching non-stream to ${cleanModel} via proxy`);

    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(googlePayload)
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Gemini API Error (${res.status}): ${text}`);
    }

    const data = await res.json();
    return convertGoogleToAnthropic(data, rawModel);
}

/**
 * Send a streaming request to the SolidStack proxy.
 * Yields Anthropic-format SSE events.
 * 
 * @param {Object} anthropicRequest - Anthropic-format request payload
 * @yields {Object} Anthropic-format SSE events
 */
export async function* sendGeminiDirectStream(anthropicRequest) {
    const rawModel = anthropicRequest.model || 'gemini-2.5-flash';
    const cleanModel = mapToGoogleDevModel(rawModel);
    const url = `http://127.0.0.1:1987/v1/models/${cleanModel}:streamGenerateContent?alt=sse`;

    const googlePayload = convertAnthropicToGoogle(anthropicRequest);

    logger.info(`[GeminiDirect] Dispatching stream to ${cleanModel} via proxy`);

    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(googlePayload)
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Gemini API Stream Error (${res.status}): ${text}`);
    }

    // Reuse the existing sse-streamer.js stream parser!
    yield* streamSSEResponse(res, rawModel);
}
