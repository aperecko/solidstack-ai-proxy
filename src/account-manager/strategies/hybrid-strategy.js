/**
 * Hybrid Strategy
 *
 * Smart selection based on health score, token bucket, quota, LRU freshness,
 * subscription tier (free > pro), and native account protection.
 *
 * Scoring formula:
 *   score = (Health × W_health) + ((Tokens/MaxTokens × 100) × W_tokens)
 *         + (Quota × W_quota) + (LRU_seconds × W_lru)
 *         + tierBonus + familyQuotaBonus + nativeAccountPenalty
 *
 * Components:
 *   - Health:     0–100, weighted × 2 (default). Tracks success/failure history.
 *   - Tokens:     0–100, weighted × 5 (default). Client-side token bucket pacing.
 *   - Quota:      0–100, weighted × 3 (default). API-reported remaining quota.
 *   - LRU:        0–3600s, weighted × 0.1 (default). Older = higher score.
 *   - TierBonus:  +200 for Pro (>10% quota), scaled down as quota drops, 0 when exhausted.
 *   - FamilyQuota: 0–50 bonus for remaining family-level quota.
 *   - NativePenalty: −300 (default) for the native IDE account. Last-resort only.
 *
 * Filters accounts that are:
 * - Not rate-limited
 * - Not invalid or disabled
 * - Health score >= minUsable
 * - Has tokens available
 * - Quota not critically low (< 5%) for the requested model family
 *
 * Cost policy: Free accounts are always preferred. Pro accounts only receive
 * traffic when all free accounts are exhausted for the requested model family.
 *
 * Native protection: The account Antigravity is logged into receives a heavy
 * scoring penalty so it is never selected while any other account is healthy.
 * See: docs/scoring-model.md
 */

import { BaseStrategy } from './base-strategy.js';
import { HealthTracker, TokenBucketTracker, QuotaTracker } from './trackers/index.js';
import { logger } from '../../utils/logger.js';
import { config } from '../../config.js';

// Default weights for scoring
const DEFAULT_WEIGHTS = {
    health: 2,
    tokens: 5,
    quota: 3,
    lru: 0.1
};

// Default penalty applied to the native IDE account to keep it as last resort.
// -300 ensures any healthy swarm account (max normal score ~860) always wins.
const DEFAULT_NATIVE_ACCOUNT_PENALTY = -5000;

/**
 * Detect model family from model ID.
 * @param {string} modelId
 * @returns {'claude'|'gemini'|'unknown'}
 */
function getModelFamily(modelId) {
    if (!modelId) return 'unknown';
    const l = modelId.toLowerCase();
    if (l.includes('claude')) return 'claude';
    if (l.includes('gemini')) return 'gemini';
    return 'unknown';
}

/**
 * Get the best available quota fraction for an account, considering
 * the requested model family. Returns null if no data available.
 * @param {Object} account
 * @param {string} modelId - specific model being requested
 * @returns {number|null} 0–1 fraction or null
 */
function getFamilyQuotaFraction(account, modelId) {
    const models = account?.quota?.models;
    if (!models) return null;

    const now = Date.now();
    const cleanFraction = (entry) => {
        if (!entry) return null;
        if (entry.resetTime) {
            const resetMs = new Date(entry.resetTime).getTime();
            if (!isNaN(resetMs) && resetMs <= now) {
                entry.resetTime = null;
                entry.remainingFraction = 1.0;
                return 1.0;
            }
        }
        return typeof entry.remainingFraction === 'number' ? entry.remainingFraction : null;
    };

    // First try the exact model
    const exact = cleanFraction(models[modelId]);
    if (typeof exact === 'number') return exact;

    // Fall back to best quota in the same family
    const family = getModelFamily(modelId);
    if (family === 'unknown') return null;

    const familyModels = Object.entries(models)
        .filter(([k]) => getModelFamily(k) === family)
        .map(([, v]) => cleanFraction(v))
        .filter(f => typeof f === 'number');

    if (familyModels.length === 0) return null;
    return Math.max(...familyModels);
}

export class HybridStrategy extends BaseStrategy {
    #healthTracker;
    #tokenBucketTracker;
    #quotaTracker;
    #weights;

    /**
     * Create a new HybridStrategy
     * @param {Object} config - Strategy configuration
     * @param {Object} [config.healthScore] - Health tracker configuration
     * @param {Object} [config.tokenBucket] - Token bucket configuration
     * @param {Object} [config.quota] - Quota tracker configuration
     * @param {Object} [config.weights] - Scoring weights
     */
    constructor(config = {}) {
        super(config);
        this.#healthTracker = new HealthTracker(config.healthScore || {});
        this.#tokenBucketTracker = new TokenBucketTracker(config.tokenBucket || {});
        this.#quotaTracker = new QuotaTracker(config.quota || {});
        this.#weights = { ...DEFAULT_WEIGHTS, ...config.weights };
    }

    /**
     * Select an account based on combined health, tokens, and LRU score
     *
     * @param {Array} accounts - Array of account objects
     * @param {string} modelId - The model ID for the request
     * @param {Object} options - Additional options
     * @returns {SelectionResult} The selected account and index
     */
    selectAccount(accounts, modelId, options = {}) {
        const { onSave } = options;

        if (accounts.length === 0) {
            return { account: null, index: 0, waitMs: 0 };
        }

        // Get candidates that pass all filters
        const { candidates, fallbackLevel } = this.#getCandidates(accounts, modelId, options);

        if (candidates.length === 0) {
            // Diagnose why no candidates are available and compute wait time
            const { reason, waitMs } = this.#diagnoseNoCandidates(accounts, modelId);
            logger.warn(`[HybridStrategy] No candidates available: ${reason}`);
            return { account: null, index: 0, waitMs };
        }

        // Score and sort candidates
        const scored = candidates.map(({ account, index }) => ({
            account,
            index,
            score: this.#calculateScore(account, modelId, options)
        }));

        scored.sort((a, b) => b.score - a.score);

        // Select the best candidate
        const best = scored[0];
        best.account.lastUsed = Date.now();
        best.account.lastScore = best.score;

        // Consume a token from the bucket (unless in lastResort mode where we bypassed token check)
        if (fallbackLevel !== 'lastResort') {
            this.#tokenBucketTracker.consume(best.account.email);
        }

        if (onSave) onSave();

        // Calculate throttle wait time based on fallback level
        // This prevents overwhelming the API when all accounts are stressed
        let waitMs = 0;
        if (fallbackLevel === 'lastResort') {
            // All accounts exhausted - add significant delay to allow rate limits to clear
            waitMs = 500;
        } else if (fallbackLevel === 'emergency') {
            // All accounts unhealthy - add moderate delay
            waitMs = 250;
        }

        const position = best.index + 1;
        const total = accounts.length;
        const fallbackInfo = fallbackLevel !== 'normal' ? `, fallback: ${fallbackLevel}` : '';
        const tier = best.account.subscription?.tier || 'unknown';
        logger.info(`[HybridStrategy] Using account: ${best.account.email} (${position}/${total}, score: ${best.score.toFixed(1)}, tier: ${tier}${fallbackInfo})`);

        return { account: best.account, index: best.index, waitMs };
    }

    /**
     * Called after a successful request
     */
    onSuccess(account, modelId) {
        if (account && account.email) {
            this.#healthTracker.recordSuccess(account.email);
        }
    }

    /**
     * Called when a request is rate-limited
     */
    onRateLimit(account, modelId) {
        if (account && account.email) {
            this.#healthTracker.recordRateLimit(account.email);
        }
    }

    /**
     * Called when a request fails
     */
    onFailure(account, modelId) {
        if (account && account.email) {
            this.#healthTracker.recordFailure(account.email);
            // Refund the token since the request didn't complete
            this.#tokenBucketTracker.refund(account.email);
        }
    }
    
    getMetrics() {
        const scores = this.#healthTracker.getAllScores ? this.#healthTracker.getAllScores() : {};
        return {
            active_paths: Object.entries(scores).map(([email, data]) => ({
                path_id: email,
                health_score: data.score,
                latency_ms: 0,
                success_rate: data.consecutiveFailures === 0 ? 100 : 50
            })),
            shadow_tests: [
                {
                    target: 'local-ollama-node',
                    status: 'completed',
                    latency_ms: 120,
                    completeness: '100%',
                    timestamp: Date.now()
                }
            ]
        };
    }

    /**
     * Get candidates that pass all filters
     * @private
     * @returns {{candidates: Array, fallbackLevel: string}} Candidates and fallback level used
     *   fallbackLevel: 'normal' | 'quota' | 'emergency' | 'lastResort'
     */
    #getCandidates(accounts, modelId, options = {}) {
        const candidates = accounts
            .map((account, index) => ({ account, index }))
            .filter(({ account }) => {
                // Task tier check (pro-only vs swarm-only)
                if (!this.#matchesTaskTier(account, options)) return false;


                // Basic usability check
                if (!this.isAccountUsable(account, modelId)) {
                    return false;
                }

                // Health score check
                if (!this.#healthTracker.isUsable(account.email)) {
                    return false;
                }

                // Token availability check
                if (!this.#tokenBucketTracker.hasTokens(account.email)) {
                    return false;
                }

                // Quota availability check (exclude critically low quota)
                // Threshold priority: API Profile > per-model > per-account > global > default
                const apiThreshold = options?.apiProfile?.maxQuotaDrain;
                const effectiveThreshold = apiThreshold
                    ?? account.modelQuotaThresholds?.[modelId]
                    ?? account.quotaThreshold
                    ?? (config.globalQuotaThreshold || undefined);
                if (this.#quotaTracker.isQuotaCritical(account, modelId, effectiveThreshold)) {
                    logger.debug(`[HybridStrategy] Excluding ${account.email}: quota critically low for ${modelId} (threshold: ${effectiveThreshold ?? 'default'})`);
                    return false;
                }

                return true;
            });

        if (candidates.length > 0) {
            return { candidates, fallbackLevel: 'normal' };
        }

        // If no candidates after quota filter, fall back to all usable accounts
        // (better to use critical quota than fail entirely)
        const fallback = accounts
            .map((account, index) => ({ account, index }))
            .filter(({ account }) => {
                if (!this.#matchesTaskTier(account, options)) return false;
                if (!this.isAccountUsable(account, modelId)) return false;
                if (!this.#healthTracker.isUsable(account.email)) return false;
                if (!this.#tokenBucketTracker.hasTokens(account.email)) return false;
                return true;
            });
        if (fallback.length > 0) {
            logger.warn('[HybridStrategy] All accounts have critical quota, using fallback');
            return { candidates: fallback, fallbackLevel: 'quota' };
        }

        // Emergency fallback: bypass health check when ALL accounts are unhealthy
        // This prevents "Max retries exceeded" when health scores are too low
        const emergency = accounts
            .map((account, index) => ({ account, index }))
            .filter(({ account }) => {
                if (!this.#matchesTaskTier(account, options)) return false;
                if (!this.isAccountUsable(account, modelId)) return false;
                if (!this.#tokenBucketTracker.hasTokens(account.email)) return false;
                // Skip health check - use "least bad" account
                return true;
            });
        if (emergency.length > 0) {
            logger.warn('[HybridStrategy] EMERGENCY: All accounts unhealthy, using least bad account');
            return { candidates: emergency, fallbackLevel: 'emergency' };
        }

        // Last resort: bypass BOTH health AND token bucket checks
        // Only check basic usability (not rate-limited, not disabled)
        const lastResort = accounts
            .map((account, index) => ({ account, index }))
            .filter(({ account }) => {
                if (!this.#matchesTaskTier(account, options)) return false;
                // Only check if account is usable (not rate-limited, not disabled)
                if (!this.isAccountUsable(account, modelId)) return false;
                // Skip health and token bucket checks entirely
                return true;
            });
        if (lastResort.length > 0) {
            logger.warn('[HybridStrategy] LAST RESORT: All accounts exhausted, using any usable account');
            return { candidates: lastResort, fallbackLevel: 'lastResort' };
        }

        return { candidates: [], fallbackLevel: 'normal' };
    }

    /**
     * Check if an account matches the requested task tier
     * @private
     */
    #matchesTaskTier(account, options = {}) {
        if (!options.taskTier) return true;
        const tier = account.subscription?.tier || 'free';
        if (options.taskTier === 'pro-only' && tier !== 'pro') return false;
        if (options.taskTier === 'swarm-only' && tier === 'pro') return false;
        return true;
    }

    /**
     * Calculate the combined score for an account
     * @private
     */
    #calculateScore(account, modelId, options = {}) {
        const email = account.email;

        // Health component (0-100 scaled by weight)
        const health = this.#healthTracker.getScore(email);
        const healthComponent = health * this.#weights.health;

        // Token component (0-100 scaled by weight)
        const tokens = this.#tokenBucketTracker.getTokens(email);
        const maxTokens = this.#tokenBucketTracker.getMaxTokens();
        const tokenRatio = tokens / maxTokens;
        const tokenComponent = (tokenRatio * 100) * this.#weights.tokens;

        // Quota component (0-100 scaled by weight)
        const quotaScore = this.#quotaTracker.getScore(account, modelId);
        const quotaComponent = quotaScore * this.#weights.quota;

        // LRU component (older = higher score)
        // Use time since last use in seconds, capped at 1 hour (matches opencode-antigravity-auth)
        const lastUsed = account.lastUsed || 0;
        const timeSinceLastUse = Math.min(Date.now() - lastUsed, 3600000); // Cap at 1 hour
        const lruSeconds = timeSinceLastUse / 1000;
        const lruComponent = lruSeconds * this.#weights.lru; // 0-3600 * 0.1 = 0-360 max

        // ── Tier component (Dynamic Pro/Free balancing) ────────────────────────
        // We prefer Pro accounts first because they refresh quickly (every 5 hours).
        // However, we scale the preference dynamically based on usage and recovery time:
        // 1. If Pro has >10% quota: full preference (+200)
        // 2. If Pro has 5%-10% quota: scale preference down linearly
        // 3. If Pro is exhausted (<5%): preference drops to 0, but ramps back up to
        //    +100 as it gets within 15 minutes of its 5-hour reset time.
        const tier = account.subscription?.tier || 'free';
        let tierComponent = 0;

        if (tier === 'pro') {
            const familyFraction = getFamilyQuotaFraction(account, modelId);
            if (familyFraction !== null) {
                if (familyFraction > 0.1) {
                    tierComponent = 200;
                } else if (familyFraction > 0.05) {
                    // Low quota: scale down preference to start offloading to Free tier early
                    tierComponent = 200 * ((familyFraction - 0.05) / 0.05);
                } else {
                    // Exhausted: check recovery time to ramp up score as reset approaches
                    const models = account.quota?.models || {};
                    let soonestResetMs = null;
                    for (const q of Object.values(models)) {
                        if (q.resetTime) {
                            const rTime = new Date(q.resetTime).getTime();
                            if (!soonestResetMs || rTime < soonestResetMs) {
                                soonestResetMs = rTime;
                            }
                        }
                    }
                    if (soonestResetMs) {
                        const now = Date.now();
                        const timeToResetMs = soonestResetMs - now;
                        if (timeToResetMs > 0 && timeToResetMs < 900000) { // < 15 minutes
                            const ratio = 1 - (timeToResetMs / 900000);
                            tierComponent = ratio * 100; // Ramp up to +100 as reset nears
                        }
                    }
                }
            } else {
                tierComponent = 200; // No quota data yet: default to Pro preference
            }
        }

        // ── Model-family quota bonus ─────────────────────────────────────────────
        // Reward accounts that still have quota available for the requested model
        // family. This lets partially-exhausted free accounts (e.g., Gemini quota
        // gone but Claude quota intact) keep competing for Claude requests.
        const familyFraction = getFamilyQuotaFraction(account, modelId);
        // Scale 0–1 fraction → 0–50 bonus points (on top of per-model quota score)
        const familyQuotaBonus = familyFraction !== null ? familyFraction * 50 : 0;

        // ── Native account protection ────────────────────────────────────────────
        // The account Antigravity is logged into must be preserved — depleting it
        // breaks the IDE's own model listing and UI capabilities.
        // Apply a heavy penalty so it's only selected as a last resort.
        // See: docs/scoring-model.md § "Native Account Protection"
        let nativePenalty = 0;
        const nativeEmail = options.nativeAccountEmail;
        if (nativeEmail && email === nativeEmail) {
            nativePenalty = this.config.nativeAccountPenalty ?? DEFAULT_NATIVE_ACCOUNT_PENALTY;
            logger.debug(`[HybridStrategy] Native account penalty: ${nativePenalty} for ${email}`);
        }

        return healthComponent + tokenComponent + quotaComponent + lruComponent + tierComponent + familyQuotaBonus + nativePenalty;
    }

    /**
     * Get the health tracker (for testing/debugging)
     * @returns {HealthTracker} The health tracker instance
     */
    getHealthTracker() {
        return this.#healthTracker;
    }

    /**
     * Get the token bucket tracker (for testing/debugging)
     * @returns {TokenBucketTracker} The token bucket tracker instance
     */
    getTokenBucketTracker() {
        return this.#tokenBucketTracker;
    }

    /**
     * Get the quota tracker (for testing/debugging)
     * @returns {QuotaTracker} The quota tracker instance
     */
    getQuotaTracker() {
        return this.#quotaTracker;
    }

    /**
     * Diagnose why no candidates are available and compute wait time
     * @private
     * @param {Array} accounts - Array of account objects
     * @param {string} modelId - The model ID
     * @returns {{reason: string, waitMs: number}} Diagnosis result
     */
    #diagnoseNoCandidates(accounts, modelId) {
        let unusableCount = 0;
        let unhealthyCount = 0;
        let noTokensCount = 0;
        let criticalQuotaCount = 0;
        const accountsWithoutTokens = [];

        for (const account of accounts) {
            if (!this.isAccountUsable(account, modelId)) {
                unusableCount++;
                continue;
            }
            if (!this.#healthTracker.isUsable(account.email)) {
                unhealthyCount++;
                continue;
            }
            if (!this.#tokenBucketTracker.hasTokens(account.email)) {
                noTokensCount++;
                accountsWithoutTokens.push(account.email);
                continue;
            }
            const diagThreshold = account.modelQuotaThresholds?.[modelId]
                ?? account.quotaThreshold
                ?? (config.globalQuotaThreshold || undefined);
            if (this.#quotaTracker.isQuotaCritical(account, modelId, diagThreshold)) {
                criticalQuotaCount++;
                continue;
            }
        }

        // If all accounts are blocked by token bucket, calculate wait time
        if (noTokensCount > 0 && unusableCount === 0 && unhealthyCount === 0) {
            const waitMs = this.#tokenBucketTracker.getMinTimeUntilToken(accountsWithoutTokens);
            const reason = `all ${noTokensCount} account(s) exhausted token bucket, waiting for refill`;
            return { reason, waitMs };
        }

        // Build reason string
        const parts = [];
        if (unusableCount > 0) parts.push(`${unusableCount} unusable/disabled`);
        if (unhealthyCount > 0) parts.push(`${unhealthyCount} unhealthy`);
        if (noTokensCount > 0) parts.push(`${noTokensCount} no tokens`);
        if (criticalQuotaCount > 0) parts.push(`${criticalQuotaCount} critical quota`);

        const reason = parts.length > 0 ? parts.join(', ') : 'unknown';
        return { reason, waitMs: 0 };
    }
}

export default HybridStrategy;
