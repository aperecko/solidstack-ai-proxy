/**
 * Pricing Catalog for SolidStack AI Proxy
 * Translates raw token counts into exact dollar values.
 * Prices are listed as USD per 1,000,000 tokens (1M).
 */

export const PRICING_CATALOG = {
    // Anthropic / Google Cloud Code Fleet (The models we save quota on)
    "claude-3-7-sonnet": {
        inputCostPerM: 3.00,
        outputCostPerM: 15.00
    },
    "claude-3-5-sonnet-v2": {
        inputCostPerM: 3.00,
        outputCostPerM: 15.00
    },
    "claude-opus-4-6": {
        inputCostPerM: 15.00,
        outputCostPerM: 75.00
    },
    "gemini-2.5-pro": {
        inputCostPerM: 1.25,
        outputCostPerM: 5.00
    },
    "gemini-3.1-pro": {
        inputCostPerM: 1.25,
        outputCostPerM: 5.00
    },
    "gemini-3.8-flash": {
        inputCostPerM: 0.075,
        outputCostPerM: 0.30
    },
    "gemini-3.1-flash-lite": {
        inputCostPerM: 0.075,
        outputCostPerM: 0.30
    },

    // Default Fallback Baseline (If we offset a request to a free tier, 
    // we assume it saved us standard mid-tier Pro tokens if unspecified)
    "_default_pro": {
        inputCostPerM: 3.00,
        outputCostPerM: 15.00
    },
    "_default_flash": {
        inputCostPerM: 0.075,
        outputCostPerM: 0.30
    }
};

/**
 * Calculate the dollar value of the tokens consumed.
 * @param {string} equivalentModelId - The model we would have paid for
 * @param {number} inputTokens - Number of input tokens
 * @param {number} outputTokens - Number of output tokens
 * @returns {number} Dollar value (float, rounded to 6 decimal places)
 */
export function calculateTokenValue(equivalentModelId, inputTokens, outputTokens) {
    let pricing = PRICING_CATALOG[equivalentModelId];
    
    if (!pricing) {
        // Fallback heuristics if the exact model isn't mapped
        if (equivalentModelId && equivalentModelId.includes('flash')) {
            pricing = PRICING_CATALOG['_default_flash'];
        } else {
            pricing = PRICING_CATALOG['_default_pro'];
        }
    }

    const inputCost = ((inputTokens || 0) / 1_000_000) * pricing.inputCostPerM;
    const outputCost = ((outputTokens || 0) / 1_000_000) * pricing.outputCostPerM;
    
    return Number((inputCost + outputCost).toFixed(6));
}
