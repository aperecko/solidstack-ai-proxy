/**
 * Model API for Cloud Code
 *
 * Handles model listing and quota retrieval from the Cloud Code API.
 */

import {
    ANTIGRAVITY_ENDPOINT_FALLBACKS,
    ANTIGRAVITY_HEADERS,
    LOAD_CODE_ASSIST_ENDPOINTS,
    LOAD_CODE_ASSIST_HEADERS,
    CLIENT_METADATA,
    getModelFamily,
    MODEL_VALIDATION_CACHE_TTL_MS
} from '../constants.js';
import { logger } from '../utils/logger.js';
import { throttledFetch } from '../utils/helpers.js';

// Model validation cache
const modelCache = {
    validModels: new Set(),
    lastFetched: 0,
    fetchPromise: null  // Prevents concurrent fetches
};

/**
 * Check if a model is supported (Claude or Gemini)
 * @param {string} modelId - Model ID to check
 * @returns {boolean} True if model is supported
 */
function isSupportedModel(modelId) {
    const family = getModelFamily(modelId);
    const lower = (modelId || '').toLowerCase();
    return family === 'claude' || family === 'gemini' || lower.includes('gpt') || lower.includes('oss') || lower.includes('gemma-4') || lower.includes('turbo') || lower.includes('local') || lower.includes('glm') || lower.includes('minimax') || lower.includes('ollama');
}

/**
 * List available models in Anthropic API format
 * Fetches models dynamically from the Cloud Code API
 *
 * @param {string} token - OAuth access token
 * @returns {Promise<{object: string, data: Array<{id: string, object: string, created: number, owned_by: string, description: string}>}>} List of available models
 */
export async function listModels(token) {
    const data = await fetchAvailableModels(token);
    if (!data || !data.models) {
        return { object: 'list', data: [] };
    }

    const modelList = Object.entries(data.models)
        .filter(([modelId]) => isSupportedModel(modelId))
        .map(([modelId, modelData]) => ({
            id: modelId,
            object: 'model',
            created: Math.floor(Date.now() / 1000),
            owned_by: 'anthropic',
            description: modelData.displayName || modelId
        }));

    // Inject local on-demand models into the model list for Antigravity & clients
        modelList.push({
        id: 'auto',
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'solidstack',
        description: 'Auto (Dynamic MoE Smart Route)'
    });
    modelList.push({
        id: 'meta/llama-3.2-11b-vision-instruct',
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'nvidia-nim',
        description: 'Llama 3.2 11B Vision (NVIDIA NIM Free 40 RPM)'
    });
    modelList.push({
        id: 'fcc-fast',
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'nvidia-nim',
        description: 'Free Claude Code Fast (NVIDIA NIM Tier 0)'
    });
    modelList.push({
        id: 'gemma-4-26b-a4b-it',
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'local-turbofieldfare',
        description: 'Gemma 4 26B-A4B (Local Turbo Fieldfare MoE)'
    });
    modelList.push({
        id: 'gemma-4-26b-a4b',
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'local-turbofieldfare',
        description: 'Gemma 4 26B-A4B (Local Turbo Fieldfare MoE)'
    });
    
    // Inject Free Tier NIM / Hub models
    modelList.push({
        id: 'deepseek-ai/deepseek-v4-pro-0813',
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'nvidia-nim',
        description: 'DeepSeek V4 Pro (NVIDIA NIM)'
    });
    modelList.push({
        id: 'nvidia/llama-3.1-nemotron-70b-instruct',
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'nvidia-nim',
        description: 'Nemotron 70B (NVIDIA NIM)'
    });
    modelList.push({
        id: 'deepseek-ai/deepseek-r1',
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'nvidia-nim',
        description: 'DeepSeek R1 (NIM Free)'
    });
    modelList.push({
        id: 'qwen/qwen2.5-coder-32b-instruct',
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'nvidia-nim',
        description: 'Qwen 2.5 Coder 32B (NIM Free)'
    });

    // Warm the model validation cache
    modelCache.validModels = new Set(modelList.map(m => m.id));
    modelCache.lastFetched = Date.now();

    return {
        object: 'list',
        data: modelList,
        models: modelList
    };
}

/**
 * Fetch available models with quota info from Cloud Code API
 * Returns model quotas including remaining fraction and reset time
 *
 * @param {string} token - OAuth access token
 * @param {string} [projectId] - Optional project ID for accurate quota info
 * @returns {Promise<Object>} Raw response from fetchAvailableModels API
 */
export async function fetchAvailableModels(token, projectId = null) {
    const headers = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...ANTIGRAVITY_HEADERS
    };

    // Include project ID in body for accurate quota info (per Quotio implementation)
    const body = projectId ? { project: projectId } : {};

    for (const endpoint of ANTIGRAVITY_ENDPOINT_FALLBACKS) {
        try {
            const url = `${endpoint}/v1internal:fetchAvailableModels`;
            const response = await throttledFetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(5000)
            });

            if (!response.ok) {
                const errorText = await response.text();
                logger.warn(`[CloudCode] fetchAvailableModels error at ${endpoint}: ${response.status}`);
                // Detect permanent ToS ban — no point trying other endpoints
                if (response.status === 403) {
                    const lower = (errorText || '').toLowerCase();
                    if (lower.includes('has been disabled') && lower.includes('violation of terms of service')) {
                        throw new Error(`ACCOUNT_BANNED: ${errorText}`);
                    }
                }
                continue;
            }

            return await response.json();
        } catch (error) {
            logger.warn(`[CloudCode] fetchAvailableModels failed at ${endpoint}:`, error.message);
        }
    }

    throw new Error('Failed to fetch available models from all endpoints');
}

/**
 * Get model quotas for an account
 * Extracts quota info (remaining fraction and reset time) for each model
 *
 * @param {string} token - OAuth access token
 * @param {string} [projectId] - Optional project ID for accurate quota info
 * @returns {Promise<Object>} Map of modelId -> { remainingFraction, resetTime }
 */
export async function getModelQuotas(token, projectId = null, tier = null) {
    const data = await fetchAvailableModels(token, projectId);
    if (!data || !data.models) return {};

    const isFreeTier = tier === 'free';
    const quotas = {};
    for (const [modelId, modelData] of Object.entries(data.models)) {
        // Only include Claude and Gemini models
        if (!isSupportedModel(modelId)) continue;

        const isClaude = modelId.toLowerCase().includes('claude');
        if (isClaude && isFreeTier) {
            // Free tier accounts cannot generate content with Claude on Cloud Code API
            quotas[modelId] = {
                remainingFraction: 0,
                resetTime: null
            };
            continue;
        }

        if (modelData.quotaInfo) {
            quotas[modelId] = {
                // When remainingFraction is missing but resetTime is present, quota is exhausted (0%)
                remainingFraction: modelData.quotaInfo.remainingFraction ?? (isClaude ? 1.0 : (modelData.quotaInfo.resetTime ? 0 : null)),
                resetTime: modelData.quotaInfo.resetTime ?? null
            };
        } else {
            // Fallback for models without explicit quota limits (e.g. free tier or unlimited models)
            quotas[modelId] = {
                remainingFraction: isClaude ? 0 : 1.0,
                resetTime: null
            };
        }
    }


    // Cross-link G1 Credits quota: if any known G1-gated model (like claude-opus-4-6-thinking) 
    // has a quotaInfo, apply its remainingFraction to other G1-gated aliases (like gemini-pro-agent).
    const g1MetricModel = 'claude-opus-4-6-thinking';
    const g1Aliases = ['gemini-pro-agent', 'gpt-oss-120b-medium', 'claude-opus-4-6'];

    // Correlated canary check: if gemini-3.1-pro-high or gemini-2.5-pro is depleted (<= 0.05),
    // G1 pro balance is exhausted, so do not leave G1 models showing 1.0!
    const canaryQuota = quotas['gemini-3.1-pro-high'] || quotas['gemini-2.5-pro'];
    const isCanaryExhausted = canaryQuota && typeof canaryQuota.remainingFraction === 'number' && canaryQuota.remainingFraction <= 0.05;

    if (isCanaryExhausted) {
        if (quotas[g1MetricModel]) {
            quotas[g1MetricModel].remainingFraction = canaryQuota.remainingFraction;
            quotas[g1MetricModel].resetTime = canaryQuota.resetTime || quotas[g1MetricModel].resetTime;
        }
        for (const alias of g1Aliases) {
            if (quotas[alias]) {
                quotas[alias].remainingFraction = canaryQuota.remainingFraction;
                quotas[alias].resetTime = canaryQuota.resetTime || quotas[alias].resetTime;
            }
        }
    } else if (quotas[g1MetricModel]) {
        for (const alias of g1Aliases) {
            if (quotas[alias]) {
                quotas[alias].remainingFraction = quotas[g1MetricModel].remainingFraction;
                quotas[alias].resetTime = quotas[g1MetricModel].resetTime;
            }
        }
    }

    return quotas;

}

/**
 * Parse tier ID string to determine subscription level
 * @param {string} tierId - The tier ID from the API
 * @returns {'free' | 'pro' | 'ultra' | 'unknown'} The subscription tier
 */
export function parseTierId(tierId) {
    if (!tierId) return 'unknown';
    const lower = tierId.toLowerCase();

    if (lower.includes('ultra')) {
        return 'ultra';
    }
    if (lower.includes('pro') || lower.includes('premium')) {
        return 'pro';
    }
    if (lower.includes('plus') || lower.includes('starter') || lower.includes('advanced')) {
        return 'plus';
    }
    if (lower === 'standard-tier') {
        // standard-tier = "Gemini Code Assist" (paid, project-based)
        return 'pro';
    }
    if (lower === 'free-tier' || lower.includes('free')) {
        return 'free';
    }
    return 'unknown';
}

/**
 * Get subscription tier for an account
 * Calls loadCodeAssist API to discover project ID and subscription tier
 *
 * @param {string} token - OAuth access token
 * @returns {Promise<{tier: string, projectId: string|null}>} Subscription tier (free/pro/ultra) and project ID
 */
export async function getSubscriptionTier(token) {
    const headers = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...LOAD_CODE_ASSIST_HEADERS
    };

    for (const endpoint of LOAD_CODE_ASSIST_ENDPOINTS) {
        try {
            const url = `${endpoint}/v1internal:loadCodeAssist`;
            const response = await throttledFetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    metadata: CLIENT_METADATA,
                    mode: 1
                })
            });

            if (!response.ok) {
                const errorText = await response.text().catch(() => '');
                logger.warn(`[CloudCode] loadCodeAssist error at ${endpoint}: ${response.status}`);
                // Detect permanent ToS ban — no point trying other endpoints
                if (response.status === 403) {
                    const lower = (errorText || '').toLowerCase();
                    if (lower.includes('has been disabled') && lower.includes('violation of terms of service')) {
                        throw new Error(`ACCOUNT_BANNED: ${errorText}`);
                    }
                }
                continue;
            }

            const data = await response.json();

            // Debug: Log all tier-related fields from the response
            logger.debug(`[CloudCode] loadCodeAssist tier data: paidTier=${JSON.stringify(data.paidTier)}, currentTier=${JSON.stringify(data.currentTier)}, allowedTiers=${JSON.stringify(data.allowedTiers?.map(t => ({ id: t?.id, isDefault: t?.isDefault })))}`);

            // Extract project ID
            let projectId = null;
            if (typeof data.cloudaicompanionProject === 'string') {
                projectId = data.cloudaicompanionProject;
            } else if (data.cloudaicompanionProject?.id) {
                projectId = data.cloudaicompanionProject.id;
            }

            // Extract subscription tier
            // Priority: paidTier > currentTier > allowedTiers
            // - paidTier.id: "g1-pro-tier", "g1-ultra-tier" (Google One subscription)
            // - currentTier.id: "standard-tier" (pro), "free-tier" (free)
            // - allowedTiers: fallback when currentTier is missing
            // Note: paidTier is sometimes missing from the response even for Pro accounts
            let tier = 'unknown';
            let tierId = null;
            let tierSource = null;

            // 1. Check paidTier first (Google One AI subscription - most reliable)
            if (data.paidTier?.id) {
                tierId = data.paidTier.id;
                tier = parseTierId(tierId);
                tierSource = 'paidTier';
            }

            // 2. Fall back to currentTier if paidTier didn't give us a tier
            if (tier === 'unknown' && data.currentTier?.id) {
                tierId = data.currentTier.id;
                tier = parseTierId(tierId);
                tierSource = 'currentTier';
            }

            // 3. Fall back to allowedTiers (find the default or first non-free tier)
            if (tier === 'unknown' && Array.isArray(data.allowedTiers) && data.allowedTiers.length > 0) {
                // First look for the default tier
                let defaultTier = data.allowedTiers.find(t => t?.isDefault);
                if (!defaultTier) {
                    defaultTier = data.allowedTiers[0];
                }
                if (defaultTier?.id) {
                    tierId = defaultTier.id;
                    tier = parseTierId(tierId);
                    tierSource = 'allowedTiers';
                }
            }

            logger.debug(`[CloudCode] Subscription detected: ${tier} (tierId: ${tierId}, source: ${tierSource}), Project: ${projectId}`);

            return { tier, projectId };
        } catch (error) {
            logger.warn(`[CloudCode] loadCodeAssist failed at ${endpoint}:`, error.message);
        }
    }

    // Fallback: return default values if all endpoints fail
    logger.warn('[CloudCode] Failed to detect subscription tier from all endpoints. Defaulting to free.');
    return { tier: 'free', projectId: null };
}

/**
 * Populate the model validation cache
 * @param {string} token - OAuth access token
 * @param {string} [projectId] - Optional project ID
 * @returns {Promise<void>}
 */
async function populateModelCache(token, projectId = null) {
    const now = Date.now();

    // Check if cache is fresh
    if (modelCache.validModels.size > 0 && (now - modelCache.lastFetched) < MODEL_VALIDATION_CACHE_TTL_MS) {
        return;
    }

    // If already fetching, wait for it
    if (modelCache.fetchPromise) {
        await modelCache.fetchPromise;
        return;
    }

    // Start fetch
    modelCache.fetchPromise = (async () => {
        try {
            const data = await fetchAvailableModels(token, projectId);
            if (data && data.models) {
                const validIds = Object.keys(data.models).filter(modelId => isSupportedModel(modelId));
                modelCache.validModels = new Set(validIds);
                modelCache.lastFetched = Date.now();
                logger.debug(`[CloudCode] Model cache populated with ${validIds.length} models`);
            }
        } catch (error) {
            logger.warn(`[CloudCode] Failed to populate model cache: ${error.message}`);
            // Don't throw - validation should degrade gracefully
        } finally {
            modelCache.fetchPromise = null;
        }
    })();

    await modelCache.fetchPromise;
}

/**
 * Check if a model ID is valid (exists in the available models list)
 * Uses a cached model list with TTL-based refresh
 * @param {string} modelId - Model ID to validate
 * @param {string} token - OAuth access token for cache population
 * @param {string} [projectId] - Optional project ID
 * @returns {Promise<boolean>} True if model is valid
 */
export async function isValidModel(modelId, token, projectId = null) {
    try {
        // Populate cache if needed
        await populateModelCache(token, projectId);

        // If cache is populated, validate against it
        if (modelCache.validModels.size > 0) {
            return modelCache.validModels.has(modelId);
        }

        // Cache empty (fetch failed) - fail open, let API validate
        return true;
    } catch (error) {
        logger.debug(`[CloudCode] Model validation error: ${error.message}`);
        // Fail open - let the API validate
        return true;
    }
}
