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
    'claude-opus-4-6-thinking': ['claude-sonnet-4-6', 'gemini-3.1-pro-high', 'gemini-3.6-flash-high'],
    'claude-opus-4-6': ['claude-sonnet-4-6', 'gemini-3.1-pro-high', 'gemini-3.6-flash-high'],
    'claude-sonnet-4-6': ['gemini-3.1-pro-high', 'gemini-3.6-flash-high', 'gemini-3.6-flash-medium'],
    'gemini-3.1-pro-high': ['gemini-3.6-flash-high', 'gemini-3.6-flash-medium', 'gemini-2.5-flash'],
    'gemini-3.1-pro-low': ['gemini-3.6-flash-medium', 'gemini-3.6-flash-low', 'gemini-2.5-flash'],
    'gemini-3.6-flash-high': ['gemini-3.6-flash-medium', 'gemini-3.6-flash-low', 'gemini-2.5-flash'],
};

/**
 * Get an ordered list of fallback models for a given model ID.
 * 1. Static cascade (spec-defined Opus → Sonnet → Gemini Pro → Flash)
 * 2. Dynamic map (built from live data) appended as additional hops
 *
 * @param {string} model - Primary model ID
 * @returns {string[]} Ordered fallback model IDs (empty if none)
 */
export function getFallbackChain(model) {
    const chain = [];
    const seen = new Set([model]);

    for (const fb of FALLBACK_CASCADE[model] || []) {
        if (!seen.has(fb)) {
            seen.add(fb);
            chain.push(fb);
        }
    }

    const dyn = dynamicFallbackMap[model];
    if (dyn && !seen.has(dyn)) {
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
