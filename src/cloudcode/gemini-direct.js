/**
 * Gemini Direct Developer API Client
 * 
 * Routes requests directly to Google's Developer API (generativelanguage.googleapis.com)
 * using Gemini API keys. This replaces the LiteLLM proxy routing layer.
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
 * Send a non-streaming request to the Gemini Developer API.
 * 
 * @param {Object} anthropicRequest - Anthropic-format request payload
 * @param {string} apiKey - Gemini Developer API key
 * @returns {Promise<Object>} Anthropic-format response
 */
export async function sendGeminiDirect(anthropicRequest, apiKey) {
    const rawModel = anthropicRequest.model || 'gemini-2.5-flash';
    const cleanModel = mapToGoogleDevModel(rawModel);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${cleanModel}:generateContent?key=${apiKey}`;

    const googlePayload = convertAnthropicToGoogle(anthropicRequest);

    logger.info(`[GeminiDirect] Dispatching non-stream to ${cleanModel}`);

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
 * Send a streaming request to the Gemini Developer API.
 * Yields Anthropic-format SSE events.
 * 
 * @param {Object} anthropicRequest - Anthropic-format request payload
 * @param {string} apiKey - Gemini Developer API key
 * @yields {Object} Anthropic-format SSE events
 */
export async function* sendGeminiDirectStream(anthropicRequest, apiKey) {
    const rawModel = anthropicRequest.model || 'gemini-2.5-flash';
    const cleanModel = mapToGoogleDevModel(rawModel);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${cleanModel}:streamGenerateContent?alt=sse&key=${apiKey}`;

    const googlePayload = convertAnthropicToGoogle(anthropicRequest);

    logger.info(`[GeminiDirect] Dispatching stream to ${cleanModel}`);

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
    yield* streamSSEResponse(res, model);
}
