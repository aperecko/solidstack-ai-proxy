/**
 * Account Manager
 * Manages multiple Antigravity accounts with configurable selection strategies,
 * automatic failover, and smart cooldown for rate-limited accounts.
 */

import { ACCOUNT_CONFIG_PATH } from '../constants.js';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

// SolidStack repo root, resolved from this module's location (NOT process.cwd(),
// which is "/" when spawned by launchd). Keeps .logs/routing-mode.json and .env
// at the unified source of truth so the SSC/dashboard/llm_aggregator all agree.
const SOLIDSTACK_BASE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
import { config } from '../config.js';
import { loadAccounts, loadDefaultAccount, saveAccounts } from './storage.js';
import {
    isAllRateLimited as checkAllRateLimited,
    getAvailableAccounts as getAvailable,
    getInvalidAccounts as getInvalid,
    clearExpiredLimits as clearLimits,
    resetAllRateLimits as resetLimits,
    markRateLimited as markLimited,
    markInvalid as markAccountInvalid,
    clearInvalid as clearAccountInvalid,
    getMinWaitTimeMs as getMinWait,
    getRateLimitInfo as getLimitInfo,
    getConsecutiveFailures as getFailures,
    resetConsecutiveFailures as resetFailures,
    incrementConsecutiveFailures as incrementFailures,
    markAccountCoolingDown as markCoolingDown,
    isAccountCoolingDown as checkCoolingDown,
    clearAccountCooldown as clearCooldown,
    getCooldownRemaining as getCooldownMs,
    CooldownReason
} from './rate-limits.js';
import {
    getTokenForAccount as fetchToken,
    getProjectForAccount as fetchProject,
    clearProjectCache as clearProject,
    clearTokenCache as clearToken
} from './credentials.js';
import { createStrategy, getStrategyLabel, DEFAULT_STRATEGY } from './strategies/index.js';
import { logger } from '../utils/logger.js';
import { logRoutingDecision, logRoutingTelemetry } from '../cloudcode/routing-logger.js';
import { getAntigravityAppEmail } from '../auth/database.js';

// Phase 2 (Identity Anchor): the primary contextual identity is pinned to a
// single account so generic pooled accounts (and stale Antigravity SQLite DB
// records) can never overwrite the account used for routing decisions.
const PRIMARY_NATIVE_ACCOUNT = 'adamtechnicalsolutions@gmail.com';
const DB_NATIVE_REATTRIBUTION_ENABLED = false;

export class AccountManager {
    #accounts = [];
    #currentIndex = 0;
    #configPath;
    #settings = {};
    #initialized = false;
    #strategy = null;
    #strategyName = DEFAULT_STRATEGY;
    #routingMetrics = {
        active_paths: [],
        shadow_tests: []
    };

    // Per-account caches
    #tokenCache = new Map(); // email -> { token, extractedAt }
    #projectCache = new Map(); // email -> projectId

    constructor(configPath = ACCOUNT_CONFIG_PATH, strategyName = null) {
        this.#configPath = configPath;
        // Strategy name can be set at construction or later via initialize
        if (strategyName) {
            this.#strategyName = strategyName;
        }
    }

    /**
     * Get routing and shadow testing metrics
     */
    getRoutingMetrics() {
        if (this.#strategy && typeof this.#strategy.getMetrics === 'function') {
            return this.#strategy.getMetrics();
        }
        return this.#routingMetrics;
    }

    /**
     * Initialize the account manager by loading config
     * @param {string} [strategyOverride] - Override strategy name (from CLI flag or env var)
     */
    async initialize(strategyOverride = null) {
        if (this.#initialized) return;

        const { accounts, settings, activeIndex } = await loadAccounts(this.#configPath);

        // Filter out any virtual accounts loaded from disk to refresh them dynamically
        this.#accounts = accounts.filter(a => !a.email.includes('virtual-gemini-key'));
        this.#settings = settings;
        this.#currentIndex = activeIndex;

        // Auto-load .env file from solidstack root if exists.
        // Prefer the repo root resolved from this module; fall back to walking
        // up from cwd (standalone usage).
        let rootDir = fs.existsSync(path.join(SOLIDSTACK_BASE_DIR, '.env'))
            ? SOLIDSTACK_BASE_DIR
            : process.cwd();
        for (let i = 0; i < 5; i++) {
            if (fs.existsSync(path.join(rootDir, '.env'))) {
                break;
            }
            rootDir = path.dirname(rootDir);
        }
        const envPath = path.join(rootDir, '.env');
        
        // Load persistent routing mode
        const routingModeFile = path.join(rootDir, '.logs', 'routing-mode.json');
        if (fs.existsSync(routingModeFile)) {
            try {
                const modeData = JSON.parse(fs.readFileSync(routingModeFile, 'utf8'));
                if (modeData.mode) {
                    this.#routingMode = modeData.mode;
                }
            } catch (e) {}
        }
        if (fs.existsSync(envPath)) {
            try {
                const content = fs.readFileSync(envPath, 'utf8');
                for (const line of content.split('\n')) {
                    const match = line.match(/^\s*([^#=\s]+)\s*=\s*(.*)$/);
                    if (match) {
                        const key = match[1];
                        let val = match[2].trim();
                        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
                            val = val.slice(1, -1);
                        }
                        if (!process.env[key]) {
                            process.env[key] = val;
                        }
                    }
                }
            } catch (e) {
                logger.error('[AccountManager] Failed to read .env file:', e.message);
            }
        }

        // Load virtual API key accounts from environment variables (replacing LiteLLM)
        for (let i = 1; i <= 8; i++) {
            let key = process.env[`GEMINI_API_KEY_${i}`];
            if (!key) {
                // Try reading from 1Password CLI as a fallback
                try {
                    const opQuery = i === 1
                        ? 'op read "op://SolidStack/gemini-key-prod-1/password" 2>/dev/null || op read "op://SolidStack/gemini-key-prod/apikey" 2>/dev/null'
                        : `op read "op://SolidStack/gemini-key-prod-${i}/password" 2>/dev/null`;
                    const opResult = execSync(opQuery, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
                    if (opResult) {
                        key = opResult;
                        process.env[`GEMINI_API_KEY_${i}`] = key;
                    }
                } catch (e) {
                    // Ignore 1Password CLI failures
                }
            }

            if (key) {
                const email = `virtual-gemini-key-${i}@solidstack.local`;
                if (!this.#accounts.some(a => a.email === email)) {
                    this.#accounts.push({
                        email,
                        type: 'apikey',
                        apiKey: key,
                        status: 'ok',
                        enabled: true,
                        source: '1password',
                        modelRateLimits: {}
                    });
                    logger.info(`[AccountManager] Registered virtual Gemini API key ${i}: ${email}`);
                }
            }
        }

        // If config exists but has no accounts, fall back to Antigravity database
        if (this.#accounts.length === 0) {
            logger.warn('[AccountManager] No accounts in config. Falling back to Antigravity database');
            const { accounts: defaultAccounts, tokenCache } = loadDefaultAccount();
            this.#accounts = defaultAccounts;
            this.#tokenCache = tokenCache;
        }

        // Determine strategy: CLI override > env var > config file > default
        const configStrategy = config?.accountSelection?.strategy;
        const envStrategy = process.env.ACCOUNT_STRATEGY;
        this.#strategyName = strategyOverride || envStrategy || configStrategy || this.#strategyName;

        // Create the strategy instance
        const strategyConfig = config?.accountSelection || {};
        this.#strategy = createStrategy(this.#strategyName, strategyConfig);
        logger.info(`[AccountManager] Using ${getStrategyLabel(this.#strategyName)} selection strategy`);

        // Clear any expired rate limits
        this.clearExpiredLimits();

        this.#initialized = true;
    }

    /**
     * Reload accounts from disk (force re-initialization)
     * Useful when accounts.json is modified externally (e.g., by WebUI)
     */
    async reload() {
        this.#initialized = false;
        await this.initialize();
        logger.info('[AccountManager] Accounts reloaded from disk');
    }

    /**
     * Get the number of accounts
     * @returns {number} Number of configured accounts
     */
    getAccountCount() {
        return this.#accounts.length;
    }

    /**
     * Get all configured accounts
     * @returns {Array<Object>} Array of all accounts
     */
    getAllAccounts() {
        return [...this.#accounts];
    }

    /**
     * Check if all accounts are rate-limited
     * @param {string} [modelId] - Optional model ID
     * @returns {boolean} True if all accounts are rate-limited
     */
    isAllRateLimited(modelId = null) {
        return checkAllRateLimited(this.#accounts, modelId);
    }

    /**
     * Get list of available (non-rate-limited, non-invalid) accounts
     * @param {string} [modelId] - Optional model ID
     * @returns {Array<Object>} Array of available account objects
     */
    getAvailableAccounts(modelId = null) {
        return getAvailable(this.#accounts, modelId);
    }

    /**
     * Get list of invalid accounts
     * @returns {Array<Object>} Array of invalid account objects
     */
    getInvalidAccounts() {
        return getInvalid(this.#accounts);
    }

    /**
     * Check if all enabled accounts are invalid (need user intervention).
     * Unlike rate limits, invalid accounts won't self-recover — waiting is pointless.
     * @returns {boolean} True if every enabled account is invalid
     */
    isAllAccountsInvalid() {
        const enabled = this.#accounts.filter(a => a.enabled !== false);
        return enabled.length > 0 && enabled.every(a => a.isInvalid);
    }

    /**
     * Clear expired rate limits
     * @returns {number} Number of rate limits cleared
     */
    clearExpiredLimits() {
        const cleared = clearLimits(this.#accounts);
        if (cleared > 0) {
            this.saveToDisk();
        }
        return cleared;
    }

    /**
     * Clear all rate limits to force a fresh check
     * (Optimistic retry strategy)
     * @returns {void}
     */
    resetAllRateLimits() {
        resetLimits(this.#accounts);
    }

    #routingMode = 'load_balancer';

    getRoutingMode() {
        return this.#routingMode;
    }

    setRoutingMode(mode) {
        if (!['load_balancer', 'native_bypass'].includes(mode)) {
            throw new Error(`Invalid routing mode: ${mode}`);
        }
        this.#routingMode = mode;
        logger.info(`[AccountManager] Routing mode set to ${mode.toUpperCase()}`);
    }

    // ── Native IDE account detection ──────────────────────────────────────────
    // The primary contextual identity is pinned to a single account (Phase 2).
    // Automatic reattribution from the Antigravity SQLite database (state.vscdb)
    // is disabled so generic pooled accounts can never overwrite it.
    #cachedNativeEmail = null;
    #nativeEmailCheckedAt = 0;
    #nativeEmailOverride = null;
    static NATIVE_EMAIL_TTL_MS = 60_000; // Re-check every 60 seconds

    /**
     * Set the native IDE account from the live incoming request token.
     * This is authoritative over the SQLite DB record, which can go stale
     * (state.vscdb is only written on AG auth events). Persists so the
     * unified routing-mode.json stays truthful and survives restarts.
     * @param {string|null} email
     */
    setNativeEmailOverride(email) {
        if (!email || email === this.#nativeEmailOverride) return;
        this.#nativeEmailOverride = email;
        logger.info(`[AccountManager] Native IDE account resolved from incoming token: ${email}`);
        this.#persistNativeEmail(email, 'token-resolution');
    }

    getNativeIdeAccount() {
        const now = Date.now();

        // 0. PHASE 2 PIN — the native account ALWAYS resolves to the pinned
        //    primary contextual identity. This short-circuits the incoming
        //    token override and the antigravity-database reattribution below;
        //    the later steps are only fallbacks if the pinned account is not
        //    present in the account pool.
        const pinnedAcc = this.#accounts.find(a => a.email === PRIMARY_NATIVE_ACCOUNT && a.enabled !== false);
        if (pinnedAcc) {
            if (this.#cachedNativeEmail !== PRIMARY_NATIVE_ACCOUNT) {
                this.#cachedNativeEmail = PRIMARY_NATIVE_ACCOUNT;
                logger.info(`[AccountManager] Native IDE account pinned to ${PRIMARY_NATIVE_ACCOUNT}`);
            }
            return pinnedAcc;
        }

        // Live override from the incoming request token (authoritative).
        //    The SQLite auth record can be stale; the token AG actually sends is not.
        if (this.#nativeEmailOverride) {
            const acc = this.#accounts.find(a => a.email === this.#nativeEmailOverride && a.enabled !== false);
            if (acc) return acc;
            // Override account not in the pool — fall through to DB/last-resort
            // routing, but keep the override so the penalty still targets it.
        }

        // 1. Primary: Read from Antigravity app's SQLite database (live truth)
        //    Cached with TTL to avoid reading the DB on every request.
        //    DISABLED in Phase 2 — automatic DB reattribution would let a
        //    generic pooled account overwrite the pinned identity.
        if (DB_NATIVE_REATTRIBUTION_ENABLED && now - this.#nativeEmailCheckedAt > AccountManager.NATIVE_EMAIL_TTL_MS) {
            this.#nativeEmailCheckedAt = now;
            try {
                const dbEmail = getAntigravityAppEmail();
                if (dbEmail && dbEmail !== this.#cachedNativeEmail) {
                    const oldEmail = this.#cachedNativeEmail;
                    this.#cachedNativeEmail = dbEmail;
                    if (oldEmail) {
                        logger.info(`[AccountManager] Native IDE account changed: ${oldEmail} → ${dbEmail}`);
                    } else {
                        logger.info(`[AccountManager] Native IDE account detected: ${dbEmail}`);
                    }
                    // Auto-update routing-mode.json so the static fallback stays in sync
                    this.#persistNativeEmail(dbEmail);
                } else if (dbEmail) {
                    this.#cachedNativeEmail = dbEmail;
                }
            } catch (e) {
                logger.debug(`[AccountManager] Could not read AG database: ${e.message}`);
            }
        }

        // If we have a cached email from the DB, find the matching account
        if (this.#cachedNativeEmail) {
            const acc = this.#accounts.find(a => a.email === this.#cachedNativeEmail && a.enabled !== false);
            if (acc) return acc;
        }

        // 2. Fallback: Check routing-mode.json (static config, survives restarts)
        try {
            const routingModeFile = path.join(SOLIDSTACK_BASE_DIR, '.logs', 'routing-mode.json');
            if (fs.existsSync(routingModeFile)) {
                const modeData = JSON.parse(fs.readFileSync(routingModeFile, 'utf8'));
                if (modeData.nativeAccount) {
                    const acc = this.#accounts.find(a => a.email === modeData.nativeAccount && a.enabled !== false);
                    if (acc) {
                        this.#cachedNativeEmail = modeData.nativeAccount;
                        return acc;
                    }
                }
            }
        } catch (e) {}

        // 3. Last resort: Most recently used OAuth account
        const oauthAccounts = this.#accounts.filter(a => a.type !== 'apikey' && a.enabled !== false);
        if (oauthAccounts.length > 0) {
            oauthAccounts.sort((a, b) => {
                const timeA = a.lastUsed ? new Date(a.lastUsed).getTime() : 0;
                const timeB = b.lastUsed ? new Date(b.lastUsed).getTime() : 0;
                return timeB - timeA;
            });
            return oauthAccounts[0];
        }
        return this.#accounts[0] || null;
    }

    /**
     * Persist the detected native email to routing-mode.json
     * so it survives proxy restarts as a fallback.
     * @private
     */
    #persistNativeEmail(email, source = 'antigravity-database') {
        try {
            // Phase 2: never let a generic pooled account overwrite the pinned
            // primary identity in routing-mode.json. Only the pinned account is
            // honored; anything else is reported but not persisted.
            const effectiveEmail = email === PRIMARY_NATIVE_ACCOUNT ? email : PRIMARY_NATIVE_ACCOUNT;
            if (email && email !== effectiveEmail) {
                logger.info(`[AccountManager] Blocked persist of native account ${email}; keeping pinned ${effectiveEmail}`);
            }
            const routingModeFile = path.join(SOLIDSTACK_BASE_DIR, '.logs', 'routing-mode.json');
            let modeData = { mode: this.#routingMode };
            if (fs.existsSync(routingModeFile)) {
                try { modeData = JSON.parse(fs.readFileSync(routingModeFile, 'utf8')); } catch {}
            } else {
                fs.mkdirSync(path.join(SOLIDSTACK_BASE_DIR, '.logs'), { recursive: true });
            }
            modeData.nativeAccount = effectiveEmail;
            modeData.detectedAt = new Date().toISOString();
            modeData.source = source;
            fs.writeFileSync(routingModeFile, JSON.stringify(modeData, null, 2));
        } catch (e) {
            logger.warn(`[AccountManager] Could not persist native email: ${e.message}`);
        }
    }

    /**
     * Select an account using the configured strategy.
     * This is the main method to use for account selection.
     * @param {string} [modelId] - Model ID for the request
     * @param {Object} [options] - Additional options
     * @param {string} [options.sessionId] - Session ID for cache continuity
     * @returns {{account: Object|null, waitMs: number}} Account to use and optional wait time
     */
    selectAccount(modelId = null, options = {}) {
        if (!this.#strategy) {
            throw new Error('AccountManager not initialized. Call initialize() first.');
        }

        // Proactively clear any expired rate limits or stale quotas across the pool
        this.clearExpiredLimits();

        // The incoming request token is the live truth for "who is signed into
        // AG" — adopt it as the native account before scoring/routing so both
        // native_bypass mode and the -300 penalty target the real account.
        if (options.incomingTokenEmail) {
            this.setNativeEmailOverride(options.incomingTokenEmail);
        }

        // Emergency Bypass Mode: Direct pass-through using primary native IDE account
        if (this.#routingMode === 'native_bypass') {
            const nativeAcc = this.getNativeIdeAccount();
            if (nativeAcc) {
                logRoutingDecision(modelId, nativeAcc.email, 999, 'native_bypass');
                logRoutingTelemetry('ROUTER_BYPASS', {
                    requestedModel: modelId,
                    actualModel: modelId,
                    nativeAccount: nativeAcc.email,
                    selectedAccount: nativeAcc.email,
                    reason: 'Emergency bypass mode — direct native account pass-through',
                });
                return { account: nativeAcc, waitMs: 0 };
            }
        }

        // Inject native account email so strategies can deprioritize it.
        // Accepts incomingTokenEmail (resolved from HTTP request header) as highest priority.
        const nativeAcc = this.getNativeIdeAccount();
        const strategyOptions = {
            currentIndex: this.#currentIndex,
            onSave: () => this.saveToDisk(),
            ...options,
            nativeAccountEmail: options.incomingTokenEmail || nativeAcc?.email || null,
        };

        const result = this.#strategy.selectAccount(this.#accounts, modelId, strategyOptions);

        this.#currentIndex = result.index;
        return { account: result.account, waitMs: result.waitMs || 0 };
    }

    /**
     * Notify the strategy of a successful request
     * @param {Object} account - The account that was used
     * @param {string} modelId - The model ID that was used
     */
    notifySuccess(account, modelId) {
        if (this.#strategy) {
            this.#strategy.onSuccess(account, modelId);
        }
        if (account?.email) {
            resetFailures(this.#accounts, account.email);
        }
        logRoutingDecision(modelId, account?.email, account?.lastScore, 'success');
    }

    /**
     * Notify the strategy of a rate limit
     * @param {Object} account - The account that was rate-limited
     * @param {string} modelId - The model ID that was rate-limited
     */
    notifyRateLimit(account, modelId) {
        if (this.#strategy) {
            this.#strategy.onRateLimit(account, modelId);
        }
        logRoutingDecision(modelId, account?.email, account?.lastScore, 'rate_limit');
    }

    /**
     * Notify the strategy of a failure
     * @param {Object} account - The account that failed
     * @param {string} modelId - The model ID that failed
     */
    notifyFailure(account, modelId) {
        if (this.#strategy) {
            this.#strategy.onFailure(account, modelId);
        }
        logRoutingDecision(modelId, account?.email, account?.lastScore, 'error');
    }


    /**
     * Get the consecutive failure count for an account
     * Used for progressive backoff calculation
     * @param {string} email - Account email
     * @returns {number} Number of consecutive failures
     */
    getConsecutiveFailures(email) {
        return getFailures(this.#accounts, email);
    }

    /**
     * Increment the consecutive failure count without marking as rate limited
     * Used for quick retries to track failures while staying on same account
     * @param {string} email - Account email
     * @returns {number} New consecutive failure count
     */
    incrementConsecutiveFailures(email) {
        return incrementFailures(this.#accounts, email);
    }

    /**
     * Get the current strategy name
     * @returns {string} Strategy name
     */
    getStrategyName() {
        return this.#strategyName;
    }

    /**
     * Get the strategy display label
     * @returns {string} Strategy display label
     */
    getStrategyLabel() {
        return getStrategyLabel(this.#strategyName);
    }

    /**
     * Get the health tracker from the current strategy (if available)
     * Used by handlers for consecutive failure tracking
     * Only available when using hybrid strategy
     * @returns {Object|null} Health tracker instance or null if not available
     */
    getHealthTracker() {
        if (this.#strategy && typeof this.#strategy.getHealthTracker === 'function') {
            return this.#strategy.getHealthTracker();
        }
        return null;
    }

    /**
     * Mark an account as rate-limited
     * @param {string} email - Email of the account to mark
     * @param {number|null} resetMs - Time in ms until rate limit resets (optional)
     * @param {string} [modelId] - Optional model ID to mark specific limit
     * @param {boolean} [autoDisable=true] - Whether to auto-disable account (set false for capacity/server-side limits)
     */
    markRateLimited(email, resetMs = null, modelId = null, autoDisable = true) {
        markLimited(this.#accounts, email, resetMs, modelId);
        
        // Auto-disable account on 429 rate limit to force active state switch
        // This ensures the backend proxy automatically switches states without relying on the UI
        const account = this.#accounts.find(a => a.email === email);
        if (account && account.enabled !== false && autoDisable) {
            account.enabled = false;
            account.disabledBy429 = true;
            logger.warn(`[AccountManager] Account ${email} automatically disabled due to 429 rate limit`);
        }

        this.saveToDisk();
    }

    /**
     * Mark an account as invalid (credentials need re-authentication)
     * @param {string} email - Email of the account to mark
     * @param {string} reason - Reason for marking as invalid
     * @param {string|null} verifyUrl - Optional verification URL (for 403 VALIDATION_REQUIRED)
     */
    markInvalid(email, reason = 'Unknown error', verifyUrl = null) {
        markAccountInvalid(this.#accounts, email, reason, verifyUrl);
        this.saveToDisk();
    }

    /**
     * Clear invalid status for an account (after user completes verification)
     * @param {string} email - Email of the account to clear
     */
    clearInvalid(email) {
        clearAccountInvalid(this.#accounts, email);
        this.saveToDisk();
    }

    /**
     * Get the minimum wait time until any account becomes available
     * @param {string} [modelId] - Optional model ID
     * @returns {number} Wait time in milliseconds
     */
    getMinWaitTimeMs(modelId = null) {
        return getMinWait(this.#accounts, modelId);
    }

    /**
     * Get rate limit info for a specific account and model
     * @param {string} email - Email of the account
     * @param {string} modelId - Model ID to check
     * @returns {{isRateLimited: boolean, actualResetMs: number|null, waitMs: number}} Rate limit info
     */
    getRateLimitInfo(email, modelId) {
        return getLimitInfo(this.#accounts, email, modelId);
    }

    // ============================================================================
    // Cooldown Methods (matches opencode-antigravity-auth)
    // ============================================================================

    /**
     * Mark an account as cooling down for a specified duration
     * Used for temporary backoff separate from rate limits
     * @param {string} email - Email of the account
     * @param {number} cooldownMs - Duration of cooldown in milliseconds
     * @param {string} [reason] - Reason for the cooldown (use CooldownReason constants)
     */
    markAccountCoolingDown(email, cooldownMs, reason = CooldownReason.RATE_LIMIT) {
        markCoolingDown(this.#accounts, email, cooldownMs, reason);
        try {
            import('../utils/event-logger.js').then(({ eventLogger }) => {
                eventLogger.logEvent('cooldown_set', { email, cooldownMs, reason });
            }).catch(() => {});
        } catch (e) {}
    }

    /**
     * Set a custom cooldown duration for an account (UI/API override)
     * @param {string} email - Email of the account
     * @param {number} cooldownMs - Cooldown duration in ms
     * @param {string} [reason] - Reason description
     */
    setAccountCooldown(email, cooldownMs, reason = 'manual_override') {
        const account = this.#accounts.find(a => a.email === email);
        if (!account) {
            throw new Error(`Account ${email} not found`);
        }
        this.markAccountCoolingDown(email, cooldownMs, reason);
    }

    /**
     * Check if an account is currently cooling down
     * @param {string} email - Email of the account
     * @returns {boolean} True if account is cooling down
     */
    isAccountCoolingDown(email) {
        const account = this.#accounts.find(a => a.email === email);
        return account ? checkCoolingDown(account) : false;
    }

    /**
     * Clear the cooldown for an account
     * @param {string} email - Email of the account
     */
    clearAccountCooldown(email) {
        const account = this.#accounts.find(a => a.email === email);
        if (account) {
            clearCooldown(account);
            try {
                import('../utils/event-logger.js').then(({ eventLogger }) => {
                    eventLogger.logEvent('cooldown_cleared', { email });
                }).catch(() => {});
            } catch (e) {}
        }
    }

    /**
     * Get time remaining until cooldown expires for an account
     * @param {string} email - Email of the account
     * @returns {number} Milliseconds until cooldown expires, 0 if not cooling down
     */
    getCooldownRemaining(email) {
        const account = this.#accounts.find(a => a.email === email);
        return account ? getCooldownMs(account) : 0;
    }

    /**
     * Get OAuth token for an account
     * @param {Object} account - Account object with email and credentials
     * @returns {Promise<string>} OAuth access token
     * @throws {Error} If token refresh fails
     */
    async getTokenForAccount(account) {
        if (account && account.type === 'apikey') {
            return account.apiKey;
        }
        return fetchToken(
            account,
            this.#tokenCache,
            (email, reason) => this.markInvalid(email, reason),
            () => this.saveToDisk()
        );
    }

    /**
     * Fast path for the token resolver: check whether an incoming AG token
     * matches a token we have already fetched for a pooled account.
     * @param {string} token - OAuth access token to match
     * @returns {string|null} Email of the matching account, or null
     */
    getEmailForToken(token) {
        if (!token) return null;
        for (const [email, entry] of this.#tokenCache) {
            if (entry && entry.token && token === entry.token) {
                return email;
            }
        }
        return null;
    }

    /**
     * Get project ID for an account
     * @param {Object} account - Account object
     * @param {string} token - OAuth access token
     * @returns {Promise<string>} Project ID
     */
    async getProjectForAccount(account, token) {
        if (account && account.type === 'apikey') {
            return null;
        }
        // Pass onSave callback to persist managedProjectId in refresh token
        return fetchProject(account, token, this.#projectCache, () => this.saveToDisk());
    }

    /**
     * Clear project cache for an account (useful on auth errors)
     * @param {string|null} email - Email to clear cache for, or null to clear all
     */
    clearProjectCache(email = null) {
        clearProject(this.#projectCache, email);
    }

    /**
     * Clear token cache for an account (useful on auth errors)
     * @param {string|null} email - Email to clear cache for, or null to clear all
     */
    clearTokenCache(email = null) {
        clearToken(this.#tokenCache, email);
    }

    /**
     * Set account enabled/disabled state in memory (and save to disk if file-backed)
     * @param {string} email - Account email
     * @param {boolean} enabled - Enabled state
     */
    async setAccountEnabled(email, enabled) {
        const account = this.#accounts.find(a => a.email === email);
        if (!account) {
            throw new Error(`Account ${email} not found`);
        }
        account.enabled = enabled;
        if (enabled && account.isInvalid) {
            // Re-enabling an account expresses intent to retry: clear the persisted
            // invalid marker so the pool can re-validate on next use. Without this,
            // the watchdog's pool-deadlock self-heal (toggle enable) can never
            // recover accounts stuck invalid after a transient token-refresh error.
            await this.clearInvalid(email);
        }
        if (account.type !== 'apikey') {
            try {
                await this.saveToDisk();
            } catch (e) {
                logger.warn(`[AccountManager] Could not persist enabled state to disk for ${email}: ${e.message}`);
            }
        }
        logger.info(`[AccountManager] Account ${email} ${enabled ? 'enabled' : 'disabled'}`);
    }

    /**
     * Save current state to disk (async)
     * @returns {Promise<void>}
     */
    async saveToDisk() {
        await saveAccounts(this.#configPath, this.#accounts, this.#settings, this.#currentIndex);
    }

    /**
     * Get status object for logging/API
     * @returns {{accounts: Array, settings: Object}} Status object with accounts and settings
     */
    getStatus() {
        const available = this.getAvailableAccounts();
        const invalid = this.getInvalidAccounts();

        // Count accounts that have any active model-specific rate limits
        const rateLimited = this.#accounts.filter(a => {
            if (!a.modelRateLimits) return false;
            return Object.values(a.modelRateLimits).some(
                limit => limit.isRateLimited && limit.resetTime > Date.now()
            );
        });

        return {
            total: this.#accounts.length,
            available: available.length,
            rateLimited: rateLimited.length,
            invalid: invalid.length,
            summary: `${this.#accounts.length} total, ${available.length} available, ${rateLimited.length} rate-limited, ${invalid.length} invalid`,
            accounts: this.#accounts.map(a => ({
                email: a.email,
                source: a.source,
                tier: a.subscription?.tier || 'free',
                enabled: a.enabled !== false,  // Default to true if undefined
                projectId: a.projectId || null,
                modelRateLimits: a.modelRateLimits || {},
                isInvalid: a.isInvalid || false,
                invalidReason: a.invalidReason || null,
                verifyUrl: a.verifyUrl || null,
                lastUsed: a.lastUsed,
                // Include quota threshold settings
                quotaThreshold: a.quotaThreshold,
                modelQuotaThresholds: a.modelQuotaThresholds || {}
            }))
        };
    }

    /**
     * Get settings
     * @returns {Object} Current settings object
     */
    getSettings() {
        return { ...this.#settings };
    }

    /**
     * Get strategy health data for the health inspector panel.
     * Only returns tracker data when using the hybrid strategy.
     * @returns {Object} Strategy health data
     */
    getStrategyHealthData() {
        const strategyName = this.#strategyName;

        // Only hybrid strategy has trackers
        if (!this.#strategy || typeof this.#strategy.getHealthTracker !== 'function') {
            return { strategy: strategyName, trackers: null };
        }

        const healthTracker = this.#strategy.getHealthTracker();
        const tokenBucketTracker = this.#strategy.getTokenBucketTracker();

        const accounts = this.#accounts
            .filter(a => a.enabled !== false)
            .map(account => {
                const email = account.email;
                const healthScore = healthTracker ? healthTracker.getScore(email) : null;
                const isUsable = healthTracker ? healthTracker.isUsable(email) : null;
                const consecutiveFailures = healthTracker ? healthTracker.getConsecutiveFailures(email) : 0;
                const tokens = tokenBucketTracker ? tokenBucketTracker.getTokens(email) : null;
                const hasTokens = tokenBucketTracker ? tokenBucketTracker.hasTokens(email) : null;
                const maxTokens = tokenBucketTracker ? tokenBucketTracker.getMaxTokens() : null;

                return {
                    email,
                    healthScore: healthScore != null ? Math.round(healthScore * 10) / 10 : null,
                    isUsable,
                    consecutiveFailures,
                    tokens: tokens != null ? Math.round(tokens * 10) / 10 : null,
                    hasTokens,
                    maxTokens
                };
            });

        return {
            strategy: strategyName,
            trackers: { accounts }
        };
    }

    /**
     * Get all accounts (internal use for quota fetching)
     * Returns the full account objects including credentials
     * @returns {Array<Object>} Array of account objects
     */
    getAllAccounts() {
        return this.#accounts;
    }
}

// Re-export CooldownReason for use by handlers
export { CooldownReason };

export default AccountManager;
