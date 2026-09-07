/**
 * Model Fallback Configuration (Dynamic)
 *
 * Builds fallback mappings dynamically from the live model list.
 * Falls back to heuristic-based matching if no live data is available.
 */

import { buildFallbackMap, getModelFamily, MODEL_TIERS } from './constants.js';
import { logger } from './utils/logger.js';

// Dynamic fallback map — populated from live model data
let dynamicFallbackMap = {};

// Static fallback cascade (spec-defined safety net). Applied BEFORE the
// dynamic map so the hand-tuned Opus → Sonnet → Gemini Pro → Flash order
// is preserved even when no live model list has been fetched yet.
// Model IDs match the real Cloud Code model list (e.g. claude-opus-4-6-thinking).
const FALLBACK_CASCADE = {
    'claude-opus-4-6-thinking': ['claude-sonnet-4-6', 'gemini-3.8-flash-high', 'gemini-3.7-flash-high'],
    'claude-opus-4-6': ['claude-sonnet-4-6', 'gemini-3.8-flash-high', 'gemini-3.7-flash-high'],
    'claude-sonnet-4-6': ['gemini-3.8-flash-high', 'gemini-3.7-flash-high', 'gemini-3.1-flash-lite'],
    'gemini-pro-agent': ['gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.7-flash-high', 'gemini-3.1-flash-lite'],
    'gemini-flash-agent': ['gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.7-flash-high', 'gemini-3.1-flash-lite'],
    'gemini-3.1-pro-high': ['gemini-3.8-flash-high', 'gemini-3.7-flash-high', 'gemini-3.1-flash-lite'],
    'gemini-3.1-pro-low': ['gemini-3.8-flash-medium', 'gemini-3.7-flash-medium', 'gemini-3.1-flash-lite'],
    'gemini-2.5-pro': ['gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.1-flash-lite'],
    'gemini-2.5-flash-thinking': ['gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.1-flash-lite'],
    'gemini-3.8-flash-high': ['gemini-3.8-flash-medium', 'gemini-3.8-flash-low', 'gemini-3.7-flash-high', 'gemini-3.1-flash-lite'],
    'gemini-3.8-flash-medium': ['gemini-3.8-flash-low', 'gemini-3.7-flash-medium', 'gemini-3.1-flash-lite'],
    // Was previously only a downstream target (never a key) - a 3.8-flash-low
    // quota exhaustion had no configured next hop and fell straight through to
    // the client as a raw 502 once account rotation was also exhausted.
    // 3.8/3.7 flash tiers are G1-gated or frequently exhausted on the free-tier
    // pool, so put the verified-working same-family model (3.1-flash-lite) FIRST
    // in each chain instead of dead-ending on an exhausted intermediate (M7b).
    'gemini-3.8-flash-low': ['gemini-3.1-flash-lite', 'gemini-3.7-flash-low', 'meta/llama-3.2-11b-vision-instruct'],
    'gemini-3.7-flash-high': ['gemini-3.1-flash-lite', 'gemini-3.7-flash-medium', 'gemini-3.7-flash-low', 'gemini-3.8-flash-high'],
    'gemini-3.7-flash-medium': ['gemini-3.1-flash-lite', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low', 'gemini-3.7-flash-low'],
    'gemini-3.7-flash-low': ['gemini-3.1-flash-lite', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low'],
    'gemini-3.6-flash-high': ['gemini-3.6-flash-medium', 'gemini-3.6-flash-low', 'gemini-3.8-flash-high', 'gemini-3.1-flash-lite'],
    'gemini-3.1-flash-lite': ['meta/llama-3.2-11b-vision-instruct', 'gemma-4-26b-a4b-it'],
    'fcc-fast': ['meta/llama-3.2-11b-vision-instruct', 'gemini-3.1-flash-lite'],
    'fcc-llama70b': ['meta/llama-3.2-11b-vision-instruct', 'gemini-3.1-flash-lite'],
    'fcc-deepseek': ['deepseek-ai/deepseek-v3', 'meta/llama-3.2-11b-vision-instruct'],
    'auto-economic': ['meta/llama-3.2-11b-vision-instruct', 'gemini-3.1-flash-lite'],
};

/**
 * Get an ordered list of fallback models for a given model ID.
 * 1. Static cascade (spec-defined Opus → Sonnet → Gemini Pro → Flash)
 * 2. Dynamic map (built from live data) appended as additional hops
 *
 * Fallbacks are STRICTLY same-family: a claude request may only fall back to
 * claude models, a gemini request only to gemini models, etc. Cross-family hops
 * (e.g. claude-sonnet-4-6 → gemini, or gemini-3.1-flash-lite → llama NIM) are
 * filtered out — they waste a pooled slot of one family on another's request.
 *
 * @param {string} model - Primary model ID
 * @returns {string[]} Ordered fallback model IDs (empty if none)
 */
export function getFallbackChain(model) {
    const chain = [];
    const seen = new Set([model]);
    const srcFamily = getModelFamily(model);

    for (const fb of FALLBACK_CASCADE[model] || []) {
        if (!seen.has(fb) && getModelFamily(fb) === srcFamily) {
            seen.add(fb);
            chain.push(fb);
        }
    }

    const dyn = dynamicFallbackMap[model];
    if (dyn && !seen.has(dyn) && getModelFamily(dyn) === srcFamily) {
        seen.add(dyn);
        chain.push(dyn);
    }

    return chain;
}

/**
 * Initialize the dynamic fallback map from a live model list.
 * Called on startup and periodically when the model cache refreshes.
 *
 * @param {string[]} liveModels - Array of model IDs from fetchAvailableModels()
 */
export function initFallbackMap(liveModels) {
    dynamicFallbackMap = buildFallbackMap(liveModels);
    const count = Object.keys(dynamicFallbackMap).length;
    logger.info(`[Fallback] Dynamic fallback map initialized with ${count} entries from ${liveModels.length} models`);
    logger.debug(`[Fallback] Map: ${JSON.stringify(dynamicFallbackMap)}`);
}

/**
 * Get fallback model for a given model ID (first hop of the cascade).
 * 1. Checks the static cascade
 * 2. Checks the dynamic map (built from live data)
 *
 * @param {string} model - Primary model ID
 * @returns {string|null} Fallback model ID or null if no fallback exists
 */
export function getFallbackModel(model) {
    const chain = getFallbackChain(model);
    return chain.length > 0 ? chain[0] : null;
}

/**
 * Check if a model has a fallback configured
 * @param {string} model - Model ID to check
 * @returns {boolean} True if fallback exists
 */
export function hasFallback(model) {
    return getFallbackChain(model).length > 0;
}

/**
 * Get the current fallback map (for diagnostics/UI)
 * @returns {Object} Current dynamic fallback map
 */
export function getFallbackMap() {
    return { ...dynamicFallbackMap };
}
