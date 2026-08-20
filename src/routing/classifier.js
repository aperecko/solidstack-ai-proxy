import { logger } from '../utils/logger.js';

/**
 * Sends a prompt to the local Turbo Fieldfare Gemma model to classify it as GENERIC or PERSONAL.
 * Uses a strict timeout to avoid blocking proxy operations if the local model is busy or offline.
 *
 * @param {string} prompt The user's prompt text to classify
 * @returns {Promise<string>} 'GENERIC' or 'PERSONAL'
 */
export async function classifyRequest(prompt) {
    if (!prompt || typeof prompt !== 'string') {
        return 'PERSONAL'; // Default to safe fallback
    }

    // Abort controller with 500ms timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 500);

    try {
        const response = await fetch('http://127.0.0.1:8088/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'gemma-4-26b-a4b-it',
                messages: [
                    { role: 'system', content: 'You are a routing classifier. Respond with exactly one word: GENERIC or PERSONAL.\nPERSONAL means the request references: the user\'s own architecture, SolidStack, SolidMirror, Freebuff, personal projects, or identity.\nGENERIC means anything else.' },
                    { role: 'user', content: prompt }
                ],
                max_tokens: 10,
                temperature: 0.1
            }),
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            logger.warn(`[Classifier] Local model returned error: ${response.status}`);
            return 'PERSONAL';
        }

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content?.trim()?.toUpperCase();

        if (content && (content.includes('GENERIC') || content === 'GENERIC')) {
            return 'GENERIC';
        }
        
        return 'PERSONAL';
    } catch (error) {
        clearTimeout(timeoutId);
        if (error.name === 'AbortError') {
            logger.warn(`[Classifier] Local classification timed out after 500ms, defaulting to PERSONAL.`);
        } else {
            logger.warn(`[Classifier] Local classification failed: ${error.message}, defaulting to PERSONAL.`);
        }
        return 'PERSONAL';
    }
}
