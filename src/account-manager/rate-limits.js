/**
 * Rate Limit Management
 *
 * Handles rate limit tracking and state management for accounts.
 * All rate limits are model-specific.
 */

import { DEFAULT_COOLDOWN_MS } from '../constants.js';
import { formatDuration } from '../utils/helpers.js';
import { resolvePoolForAccount } from '../economic-engine.js';
import { logger } from '../utils/logger.js';
import { getG1CreditExhaustedRemaining } from './quota-store.js';

/**
 * Check if all accounts are rate-limited for a specific model
 *
 * @param {Array} accounts - Array of account objects
 * @param {string} modelId - Model ID to check rate limits for
 * @returns {boolean} True if all accounts are rate-limited
 */
export function isAllRateLimited(accounts, modelId) {
    if (accounts.length === 0) return true;
    if (!modelId) return false; // No model specified = not rate limited

    const isClaude = modelId.toLowerCase().includes('claude');

    return accounts.every(acc => {
        if (acc.isInvalid) return true; // Invalid accounts count as unavailable
        if (acc.enabled === false) return true; // Disabled accounts count as unavailable

        if (acc.type === 'apikey' || acc.email?.includes('virtual-gemini-key')) return true;

        if (isClaude) {
            const tier = (acc.subscription?.tier || acc.tier || '').toLowerCase();
            if (tier === 'free') return true;

            // Prefer live cached quotas over stale accounts.json data
            const cached = acc._cachedFormattedQuotas?.[modelId];
            const q = cached || acc.quota?.models?.[modelId];
            if (q && q.remainingFraction !== null && q.remainingFraction <= 0.05 && (q.resetTime || cached?.resetTime)) {
                const resetMs = new Date(q.resetTime || cached?.resetTime).getTime();
                if (!isNaN(resetMs) && resetMs > Date.now()) return true;
            }
        }

        const modelLimits = acc.modelRateLimits || {};
        const limit = modelLimits[modelId];
        return limit && limit.isRateLimited && limit.resetTime > Date.now();
    });
}

/**
 * Get list of available (non-rate-limited, non-invalid) accounts for a model
 *
 * @param {Array} accounts - Array of account objects
 * @param {string} [modelId] - Model ID to filter by
 * @returns {Array} Array of available account objects
 */
export function getAvailableAccounts(accounts, modelId = null) {
    const isClaude = modelId ? modelId.toLowerCase().includes('claude') : false;

    return accounts.filter(acc => {
        if (acc.isInvalid) return false;

        // WebUI: Skip disabled accounts
        if (acc.enabled === false) return false;

        if (acc.type === 'apikey' || acc.email?.includes('virtual-gemini-key')) return false;

        if (isClaude) {
            const tier = (acc.subscription?.tier || acc.tier || '').toLowerCase();
            if (tier === 'free') return false;
        }

        // Prefer live cached quotas over stale accounts.json data. This applies to
        // BOTH Claude and Gemini models: an exhausted model (remainingFraction ≈ 0
        // with a reset in the future) must be skipped so account selection and
        // fallback rewriting step down to healthier tiers instead of retrying a
        // starved model over and over (visible as endless -high ping-pong).
        const cached = acc._cachedFormattedQuotas?.[modelId];
        const q = cached || acc.quota?.models?.[modelId];
        if (q && q.remainingFraction !== null && q.remainingFraction <= 0.05 && (q.resetTime || cached?.resetTime)) {
            const resetMs = new Date(q.resetTime || cached?.resetTime).getTime();
            if (!isNaN(resetMs) && resetMs > Date.now()) return false;
        }

        if (modelId && acc.modelRateLimits && acc.modelRateLimits[modelId]) {
            const limit = acc.modelRateLimits[modelId];
            if (limit.isRateLimited && limit.resetTime > Date.now()) {
                return false;
            }
        }

        // G1-credit-exhaustion (INSUFFICIENT_G1_CREDITS_BALANCE / error 2008) is a
        // distinct, longer-lived state tracked in the quota-store. Exclude the
        // account for this model so fallback-rewrite and selection skip it instead
        // of choosing a model whose whole pool is credit-starved (→ 502).
        if (modelId && getG1CreditExhaustedRemaining('antigravity', acc.email, modelId) > 0) {
            return false;
        }

        return true;
    });
}

/**
 * Get list of invalid accounts
 *
 * @param {Array} accounts - Array of account objects
 * @returns {Array} Array of invalid account objects
 */
export function getInvalidAccounts(accounts) {
    return accounts.filter(acc => acc.isInvalid);
}

/**
 * Clear expired rate limits
 *
 * @param {Array} accounts - Array of account objects
 * @returns {number} Number of rate limits cleared
 */
export function clearExpiredLimits(accounts) {
    const now = Date.now();
    let cleared = 0;

    for (const account of accounts) {
        let hasActiveLimits = false;

        if (account.modelRateLimits) {
            for (const [modelId, limit] of Object.entries(account.modelRateLimits)) {
                if (limit.isRateLimited) {
                    if (limit.resetTime && limit.resetTime <= now) {
                        limit.isRateLimited = false;
                        limit.resetTime = null;
                        cleared++;
                        logger.success(`[AccountManager] Rate limit expired for: ${account.email} (model: ${modelId})`);
                    } else if (limit.resetTime && limit.resetTime > now) {
                        hasActiveLimits = true;
                    }
                }
            }
        }

        // Also clean up expired quota.models records
        if (account.quota && account.quota.models) {
            for (const [modelId, q] of Object.entries(account.quota.models)) {
                if (q.resetTime) {
                    const resetMs = new Date(q.resetTime).getTime();
                    if (!isNaN(resetMs) && resetMs <= now) {
                        q.resetTime = null;
                        q.remainingFraction = 1.0;
                        cleared++;
                        logger.success(`[AccountManager] Stale quota reset expired for: ${account.email} (model: ${modelId})`);
                    }
                }
            }
        }
        
        // Auto-heal account if no active rate limits remain.
        // Only accounts the SYSTEM disabled (429 auto-disable) are revived;
        // manual/administrative disables (enabled=false without disabledBy429)
        // must be respected, otherwise user-toggled accounts get resurrected
        // on the next selection cycle.
        if (!hasActiveLimits) {
            if (account.disabledBy429 === true) {
                account.enabled = true;
                account.disabledBy429 = false;
                logger.success(`[AccountManager] Auto re-enabled account ${account.email}`);
            }
            if (account.consecutiveFailures > 5) {
                account.consecutiveFailures = 0;
            }
            clearAccountCooldown(account);
        }
    }

    return cleared;
}

/**
 * Clear all rate limits to force a fresh check (optimistic retry strategy)
 *
 * @param {Array} accounts - Array of account objects
 */
export function resetAllRateLimits(accounts) {
    for (const account of accounts) {
        account.enabled = true;
        account.disabledBy429 = false;
        account.consecutiveFailures = 0;
        clearAccountCooldown(account);

        if (account.modelRateLimits) {
            for (const key of Object.keys(account.modelRateLimits)) {
                account.modelRateLimits[key] = { isRateLimited: false, resetTime: null };
            }
        }

        if (account.quota && account.quota.models) {
            for (const key of Object.keys(account.quota.models)) {
                account.quota.models[key].resetTime = null;
                account.quota.models[key].remainingFraction = 1.0;
            }
        }
    }
    logger.warn('[AccountManager] Reset all rate limits, quotas, and failures for optimistic retry');
}

/**
 * Mark an account as rate-limited for a specific model
 *
 * @param {Array} accounts - Array of account objects
 * @param {string} email - Email of the account to mark
 * @param {number|null} resetMs - Time in ms until rate limit resets (from API)
 * @param {string} modelId - Model ID to mark rate limit for
 * @returns {boolean} True if account was found and marked
 */
export function markRateLimited(accounts, email, resetMs = null, modelId) {
    const account = accounts.find(a => a.email === email);
    if (!account) return false;

    // Google returns weekly/daily reset timestamps (e.g. 3 days out) in 429 bodies.
    // Locking an account out for 3 days on a temporary rate-limit is fatal for the pool.
    // Cap cooldown to a maximum of 5 minutes (300,000ms).
    const MAX_COOLDOWN_MS = 5 * 60 * 1000;
    const requestedMs = (resetMs && resetMs > 0) ? resetMs : DEFAULT_COOLDOWN_MS;
    const actualResetMs = Math.min(requestedMs, MAX_COOLDOWN_MS);

    if (!account.modelRateLimits) {
        account.modelRateLimits = {};
    }

    account.modelRateLimits[modelId] = {
        isRateLimited: true,
        resetTime: Date.now() + actualResetMs,  // Actual reset time for decisions
        actualResetMs: actualResetMs             // Original duration from API
    };

    // FIX: If it's a true quota exhaustion (> 5 mins), update the quota model
    // so the dashboard accurately reflects 0% capacity and the true reset time.
    if (requestedMs > MAX_COOLDOWN_MS && account.quota && account.quota.models) {
        if (!account.quota.models[modelId]) {
            account.quota.models[modelId] = {};
        }
        account.quota.models[modelId].remainingFraction = 0;
        account.quota.models[modelId].resetTime = new Date(Date.now() + requestedMs).toISOString();
    }

    // Track consecutive failures for progressive backoff (matches opencode-antigravity-auth)
    account.consecutiveFailures = (account.consecutiveFailures || 0) + 1;

    // Log appropriately based on duration
    if (actualResetMs > DEFAULT_COOLDOWN_MS) {
        logger.warn(
            `[AccountManager] Quota exhausted: ${email} (model: ${modelId}). Resets in ${formatDuration(actualResetMs)}`
        );
    } else {
        logger.warn(
            `[AccountManager] Rate limited: ${email} (model: ${modelId}). Available in ${formatDuration(actualResetMs)}`
        );
    }

    return true;
}

/**
 * Mark an account as invalid (credentials need re-authentication)
 *
 * @param {Array} accounts - Array of account objects
 * @param {string} email - Email of the account to mark
 * @param {string} reason - Reason for marking as invalid
 * @param {string|null} verifyUrl - Optional verification URL (for 403 VALIDATION_REQUIRED)
 * @returns {boolean} True if account was found and marked
 */
export function markInvalid(accounts, email, reason = 'Unknown error', verifyUrl = null) {
    // Guard against marking accounts invalid due to transient network errors
    const lowerReason = String(reason).toLowerCase();
    if (
        lowerReason.includes('enotfound') ||
        lowerReason.includes('etimedout') ||
        lowerReason.includes('fetch failed') ||
        lowerReason.includes('econnreset') ||
        lowerReason.includes('econnrefused') ||
        lowerReason.includes('socket hang up') ||
        lowerReason.includes('503') ||
        lowerReason.includes('502') ||
        lowerReason.includes('504')
    ) {
        logger.warn(`[AccountManager] Transient network error for ${email} (${reason}) - skipping permanent invalidation`);
        markAccountCoolingDown(accounts, email, 30000, CooldownReason.SERVER_ERROR);
        return false;
    }

    const account = accounts.find(a => a.email === email);
    if (!account) return false;

    account.isInvalid = true;
    account.invalidReason = reason;
    account.invalidAt = Date.now();
    account.verifyUrl = verifyUrl || null;

    logger.error(
        `[AccountManager] ⚠ Account INVALID: ${email}`
    );
    logger.error(
        `[AccountManager]   Reason: ${reason}`
    );
    if (verifyUrl) {
        logger.error(
            `[AccountManager]   Verification URL: ${verifyUrl}`
        );
    }
    logger.error(
        `[AccountManager]   Run 'npm run accounts' to re-authenticate this account`
    );

    return true;
}

/**
 * Clear invalid status for an account (after user completes verification)
 *
 * @param {Array} accounts - Array of account objects
 * @param {string} email - Email of the account to clear
 * @returns {boolean} True if account was found and cleared
 */
export function clearInvalid(accounts, email) {
    const account = accounts.find(a => a.email === email);
    if (!account) return false;

    account.isInvalid = false;
    account.invalidReason = null;
    account.verifyUrl = null;

    logger.info(`[AccountManager] ✓ Account re-enabled: ${email}`);
    return true;
}

/**
 * Get the minimum wait time until any account becomes available for a model
 *
 * @param {Array} accounts - Array of account objects
 * @param {string} modelId - Model ID to check
 * @returns {number} Wait time in milliseconds
 */
export function getMinWaitTimeMs(accounts, modelId) {
    if (!isAllRateLimited(accounts, modelId)) return 0;

    const now = Date.now();
    let minWait = Infinity;
    let soonestAccount = null;

    for (const account of accounts) {
        if (modelId && account.modelRateLimits && account.modelRateLimits[modelId]) {
            const limit = account.modelRateLimits[modelId];
            if (limit.isRateLimited && limit.resetTime) {
                const wait = limit.resetTime - now;
                if (wait > 0 && wait < minWait) {
                    minWait = wait;
                    soonestAccount = account;
                }
            }
        }
    }

    if (soonestAccount) {
        logger.info(`[AccountManager] Shortest wait: ${formatDuration(minWait)} (account: ${soonestAccount.email})`);
    }

    return minWait === Infinity ? DEFAULT_COOLDOWN_MS : minWait;
}

/**
 * Get the rate limit info for a specific account and model
 * Returns the actual reset time from API, not capped
 *
 * @param {Array} accounts - Array of account objects
 * @param {string} email - Email of the account
 * @param {string} modelId - Model ID to check
 * @returns {{isRateLimited: boolean, actualResetMs: number|null, waitMs: number}} Rate limit info
 */
export function getRateLimitInfo(accounts, email, modelId) {
    const account = accounts.find(a => a.email === email);
    if (!account || !account.modelRateLimits || !account.modelRateLimits[modelId]) {
        return { isRateLimited: false, actualResetMs: null, waitMs: 0 };
    }

    const limit = account.modelRateLimits[modelId];
    const now = Date.now();
    const waitMs = limit.resetTime ? Math.max(0, limit.resetTime - now) : 0;

    return {
        isRateLimited: limit.isRateLimited && waitMs > 0,
        actualResetMs: limit.actualResetMs || null,
        waitMs
    };
}

/**
 * Get the consecutive failure count for an account
 * Used for progressive backoff calculation (matches opencode-antigravity-auth)
 *
 * @param {Array} accounts - Array of account objects
 * @param {string} email - Email of the account
 * @returns {number} Number of consecutive failures
 */
export function getConsecutiveFailures(accounts, email) {
    const account = accounts.find(a => a.email === email);
    return account?.consecutiveFailures || 0;
}

/**
 * Reset the consecutive failure count for an account
 * Called on successful request (matches opencode-antigravity-auth)
 *
 * @param {Array} accounts - Array of account objects
 * @param {string} email - Email of the account
 * @returns {boolean} True if account was found and reset
 */
export function resetConsecutiveFailures(accounts, email) {
    const account = accounts.find(a => a.email === email);
    if (!account) return false;
    account.consecutiveFailures = 0;
    return true;
}

/**
 * Increment the consecutive failure count for an account WITHOUT marking as rate limited
 * Used for quick retries where we want to track failures but not skip the account
 * (matches opencode-antigravity-auth behavior of always incrementing on 429)
 *
 * @param {Array} accounts - Array of account objects
 * @param {string} email - Email of the account
 * @returns {number} New consecutive failure count
 */
export function incrementConsecutiveFailures(accounts, email) {
    const account = accounts.find(a => a.email === email);
    if (!account) return 0;
    account.consecutiveFailures = (account.consecutiveFailures || 0) + 1;
    return account.consecutiveFailures;
}

// ============================================================================
// Cooldown Mechanism (matches opencode-antigravity-auth)
// Separate from rate limits - used for temporary backoff after failures
// ============================================================================

/**
 * Cooldown reasons for debugging/logging
 */
export const CooldownReason = {
    RATE_LIMIT: 'rate_limit',
    AUTH_FAILURE: 'auth_failure',
    CONSECUTIVE_FAILURES: 'consecutive_failures',
    SERVER_ERROR: 'server_error'
};

/**
 * Mark an account as cooling down for a specified duration
 * Used for temporary backoff separate from rate limits
 *
 * @param {Array} accounts - Array of account objects
 * @param {string} email - Email of the account
 * @param {number} cooldownMs - Duration of cooldown in milliseconds
 * @param {string} [reason] - Reason for the cooldown
 * @returns {boolean} True if account was found and marked
 */
export function markAccountCoolingDown(accounts, email, cooldownMs, reason = CooldownReason.RATE_LIMIT) {
    const account = accounts.find(a => a.email === email);
    if (!account) return false;

    account.coolingDownUntil = Date.now() + cooldownMs;
    account.cooldownReason = reason;

    logger.debug(`[AccountManager] Account ${email} cooling down for ${formatDuration(cooldownMs)} (reason: ${reason})`);
    return true;
}

/**
 * Check if an account is currently cooling down
 * Automatically clears expired cooldowns
 *
 * @param {Object} account - Account object
 * @returns {boolean} True if account is cooling down
 */
export function isAccountCoolingDown(account) {
    if (!account || account.coolingDownUntil === undefined) {
        return false;
    }

    const now = Date.now();
    if (now >= account.coolingDownUntil) {
        // Cooldown expired - clear it
        clearAccountCooldown(account);
        return false;
    }

    return true;
}

/**
 * Clear the cooldown for an account
 *
 * @param {Object} account - Account object
 */
export function clearAccountCooldown(account) {
    if (account) {
        delete account.coolingDownUntil;
        delete account.cooldownReason;
    }
}

/**
 * Get time remaining until cooldown expires for an account
 *
 * @param {Object} account - Account object
 * @returns {number} Milliseconds until cooldown expires, 0 if not cooling down
 */
export function getCooldownRemaining(account) {
    if (!account || account.coolingDownUntil === undefined) {
        return 0;
    }

    const remaining = account.coolingDownUntil - Date.now();
    return remaining > 0 ? remaining : 0;
}
