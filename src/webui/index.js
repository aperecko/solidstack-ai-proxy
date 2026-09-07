/**
 * WebUI Module - Optional web interface for account management
 *
 * This module provides a web-based UI for:
 * - Dashboard with real-time model quota visualization
 * - Account management (add via OAuth, enable/disable, refresh, remove)
 * - Live server log streaming with filtering
 * - Claude CLI configuration editor
 *
 * Usage in server.js:
 *   import { mountWebUI } from './webui/index.js';
 *   mountWebUI(app, __dirname, accountManager);
 */

import path from 'path';
import fs from 'fs';
import os from 'os';
import express from 'express';
import { getPublicConfig, saveConfig, config } from '../config.js';
import { DEFAULT_PORT, ACCOUNT_CONFIG_PATH, MAX_ACCOUNTS, DEFAULT_PRESETS, DEFAULT_SERVER_PRESETS } from '../constants.js';
import { readClaudeConfig, updateClaudeConfig, replaceClaudeConfig, getClaudeConfigPath, readPresets, savePreset, deletePreset } from '../utils/claude-config.js';
import { readServerPresets, saveServerPreset, updateServerPreset, deleteServerPreset } from '../utils/server-presets.js';
import { logger } from '../utils/logger.js';
import { getAuthorizationUrl, completeOAuthFlow, startCallbackServer } from '../auth/oauth.js';
import { loadAccounts, saveAccounts } from '../account-manager/storage.js';
import { discoverSwarmAccounts, provisionSwarmAccounts } from '../account-manager/swarm-admin.js';
import { getPackageVersion } from '../utils/helpers.js';
import { getRoutingStats, getSystemUsageReport } from '../cloudcode/routing-logger.js';
import { eventLogger } from '../utils/event-logger.js';
import { buildMonitorPage } from './monitor-page.js';
import { NATIVE_TOOLS, callNativeTool } from '../tool-catalog.js';

// Get package version
const packageVersion = getPackageVersion();

// OAuth state storage (state -> { server, verifier, state, timestamp })
// Maps state ID to active OAuth flow data
const pendingOAuthFlows = new Map();

function safeRuntimeInfo() {
    return {
        nodeVersion: process.version,
        execPath: process.execPath,
        cwd: process.cwd(),
        pid: process.pid,
        host: process.env.HOST || '0.0.0.0',
        port: process.env.PORT || DEFAULT_PORT,
        oauthCallbackPort: process.env.OAUTH_CALLBACK_PORT || '51121',
        oauthRedirectUri: `http://localhost:${process.env.OAUTH_CALLBACK_PORT || '51121'}/oauth-callback`,
        accountConfigPath: ACCOUNT_CONFIG_PATH
    };
}


/**
 * WebUI Helper Functions - Direct account manipulation
 * These functions work around AccountManager's limited API by directly
 * manipulating the accounts.json config file (non-invasive approach for PR)
 */

/**
 * Set account enabled/disabled state
 */
async function setAccountEnabled(email, enabled) {
    const { accounts, settings, activeIndex } = await loadAccounts(ACCOUNT_CONFIG_PATH);
    const account = accounts.find(a => a.email === email);
    if (!account) {
        throw new Error(`Account ${email} not found`);
    }
    account.enabled = enabled;
    await saveAccounts(ACCOUNT_CONFIG_PATH, accounts, settings, activeIndex);
    eventLogger.logEvent(enabled ? 're-enabled' : 'disabled', { email });
    logger.info(`[WebUI] Account ${email} ${enabled ? 'enabled' : 'disabled'}`);
}

/**
 * Remove account from config
 */
async function removeAccount(email) {
    const { accounts, settings, activeIndex } = await loadAccounts(ACCOUNT_CONFIG_PATH);
    const index = accounts.findIndex(a => a.email === email);
    if (index === -1) {
        throw new Error(`Account ${email} not found`);
    }
    accounts.splice(index, 1);
    // Adjust activeIndex if needed
    const newActiveIndex = activeIndex >= accounts.length ? Math.max(0, accounts.length - 1) : activeIndex;
    await saveAccounts(ACCOUNT_CONFIG_PATH, accounts, settings, newActiveIndex);
    eventLogger.logEvent('account_removed', { email });
    logger.info(`[WebUI] Account ${email} removed`);
}

/**
 * Add new account to config
 * @throws {Error} If MAX_ACCOUNTS limit is reached (for new accounts only)
 */
async function addAccount(accountData) {
    const { accounts, settings, activeIndex } = await loadAccounts(ACCOUNT_CONFIG_PATH);

    // Check if account already exists
    const existingIndex = accounts.findIndex(a => a.email === accountData.email);
    if (existingIndex !== -1) {
        // Update existing account
        accounts[existingIndex] = {
            ...accounts[existingIndex],
            ...accountData,
            enabled: true,
            isInvalid: false,
            invalidReason: null,
            addedAt: accounts[existingIndex].addedAt || new Date().toISOString()
        };
        eventLogger.logEvent('account_updated', { email: accountData.email });
        logger.info(`[WebUI] Account ${accountData.email} updated`);
    } else {
        // Check MAX_ACCOUNTS limit before adding new account
        if (accounts.length >= MAX_ACCOUNTS) {
            throw new Error(`Maximum of ${MAX_ACCOUNTS} accounts reached. Update maxAccounts in config to increase the limit.`);
        }
        // Add new account
        accounts.push({
            ...accountData,
            enabled: true,
            isInvalid: false,
            invalidReason: null,
            modelRateLimits: {},
            lastUsed: null,
            addedAt: new Date().toISOString()
        });
        eventLogger.logEvent('added', { email: accountData.email });
        logger.info(`[WebUI] Account ${accountData.email} added`);
    }

    await saveAccounts(ACCOUNT_CONFIG_PATH, accounts, settings, activeIndex);
}

/**
 * Auth Middleware - Password protection for WebUI & API endpoints
 * Supports WEBUI_PASSWORD / DASHBOARD_PASSWORD env vars or config.json.
 * Supports HTTP Basic Auth, x-webui-password header, and ?password= query param.
 * Allows optional localhost bypass when ALLOW_LOCALHOST_UNAUTH is set.
 */
function createAuthMiddleware() {
    return (req, res, next) => {
        const password = process.env.WEBUI_PASSWORD || process.env.DASHBOARD_PASSWORD || config.webuiPassword;
        if (!password) return next();

        // Optional localhost bypass for local developer convenience
        const allowLocalhost = process.env.ALLOW_LOCALHOST_UNAUTH !== 'false';
        const clientIp = req.ip || req.socket.remoteAddress || '';
        const isLocalhost = clientIp.includes('127.0.0.1') || clientIp.includes('::1') || clientIp === '::ffff:127.0.0.1';
        if (allowLocalhost && isLocalhost) {
            return next();
        }

        // Determine if this path should be protected
        const isApiRoute = req.path.startsWith('/api/');
        const isAuthUrl = req.path === '/api/auth/url';
        const isConfigGet = req.path === '/api/config' && req.method === 'GET';
        const isProtected = (isApiRoute && !isAuthUrl && !isConfigGet) || req.path === '/account-limits' || req.path === '/health';

        if (isProtected) {
            let providedPassword = req.headers['x-webui-password'] || req.query.password;

            // Check Basic Auth header (Authorization: Basic base64(user:password))
            const authHeader = req.headers.authorization;
            if (!providedPassword && authHeader && authHeader.startsWith('Basic ')) {
                try {
                    const credentials = Buffer.from(authHeader.substring(6), 'base64').toString('utf8');
                    const parts = credentials.split(':');
                    providedPassword = parts[1] || parts[0];
                } catch (e) {}
            }

            if (providedPassword !== password) {
                res.set('WWW-Authenticate', 'Basic realm="SolidStack Commander Dashboard"');
                return res.status(401).json({ status: 'error', error: 'Unauthorized: Valid password required' });
            }
        }
        next();
    };
}

/**
 * Validate server config fields from user input.
 * Shared by POST /api/config and PATCH /api/server/presets/:name.
 * @param {Object} input - Raw config fields to validate
 * @returns {Object} Validated updates object (only valid fields included)
 */
function validateConfigFields(input) {
    const updates = {};
    const { maxRetries, retryBaseMs, retryMaxMs, defaultCooldownMs, maxWaitBeforeErrorMs, maxAccounts, globalQuotaThreshold, accountSelection, rateLimitDedupWindowMs, maxConsecutiveFailures, extendedCooldownMs, maxCapacityRetries, switchAccountDelayMs, capacityBackoffTiersMs } = input;

    if (typeof maxRetries === 'number' && maxRetries >= 1 && maxRetries <= 20) {
        updates.maxRetries = maxRetries;
    }
    if (typeof retryBaseMs === 'number' && retryBaseMs >= 100 && retryBaseMs <= 10000) {
        updates.retryBaseMs = retryBaseMs;
    }
    if (typeof retryMaxMs === 'number' && retryMaxMs >= 1000 && retryMaxMs <= 120000) {
        updates.retryMaxMs = retryMaxMs;
    }
    if (typeof defaultCooldownMs === 'number' && defaultCooldownMs >= 1000 && defaultCooldownMs <= 300000) {
        updates.defaultCooldownMs = defaultCooldownMs;
    }
    if (typeof maxWaitBeforeErrorMs === 'number' && maxWaitBeforeErrorMs >= 0 && maxWaitBeforeErrorMs <= 600000) {
        updates.maxWaitBeforeErrorMs = maxWaitBeforeErrorMs;
    }
    if (typeof maxAccounts === 'number' && maxAccounts >= 1 && maxAccounts <= 100) {
        updates.maxAccounts = maxAccounts;
    }
    if (typeof globalQuotaThreshold === 'number' && globalQuotaThreshold >= 0 && globalQuotaThreshold < 1) {
        updates.globalQuotaThreshold = globalQuotaThreshold;
    }
    if (typeof rateLimitDedupWindowMs === 'number' && rateLimitDedupWindowMs >= 1000 && rateLimitDedupWindowMs <= 30000) {
        updates.rateLimitDedupWindowMs = rateLimitDedupWindowMs;
    }
    if (typeof maxConsecutiveFailures === 'number' && maxConsecutiveFailures >= 1 && maxConsecutiveFailures <= 10) {
        updates.maxConsecutiveFailures = maxConsecutiveFailures;
    }
    if (typeof extendedCooldownMs === 'number' && extendedCooldownMs >= 10000 && extendedCooldownMs <= 300000) {
        updates.extendedCooldownMs = extendedCooldownMs;
    }
    if (typeof maxCapacityRetries === 'number' && maxCapacityRetries >= 1 && maxCapacityRetries <= 10) {
        updates.maxCapacityRetries = maxCapacityRetries;
    }
    if (typeof switchAccountDelayMs === 'number' && switchAccountDelayMs >= 1000 && switchAccountDelayMs <= 60000) {
        updates.switchAccountDelayMs = switchAccountDelayMs;
    }
    if (Array.isArray(capacityBackoffTiersMs) && capacityBackoffTiersMs.length >= 1 && capacityBackoffTiersMs.length <= 10) {
        const allValid = capacityBackoffTiersMs.every(v => typeof v === 'number' && v >= 1000 && v <= 300000);
        if (allValid) {
            updates.capacityBackoffTiersMs = [...capacityBackoffTiersMs];
        }
    }
    // Account selection strategy and tuning validation
    if (accountSelection && typeof accountSelection === 'object') {
        const validStrategies = ['sticky', 'round-robin', 'hybrid'];
        const acctUpdate = {};

        if (accountSelection.strategy && validStrategies.includes(accountSelection.strategy)) {
            acctUpdate.strategy = accountSelection.strategy;
        }

        // Health score tuning
        if (accountSelection.healthScore && typeof accountSelection.healthScore === 'object') {
            const hs = accountSelection.healthScore;
            const hsUpdate = {};
            if (typeof hs.initial === 'number' && hs.initial >= 0 && hs.initial <= 100) hsUpdate.initial = hs.initial;
            if (typeof hs.successReward === 'number' && hs.successReward >= 0 && hs.successReward <= 20) hsUpdate.successReward = hs.successReward;
            if (typeof hs.rateLimitPenalty === 'number' && hs.rateLimitPenalty >= -50 && hs.rateLimitPenalty <= 0) hsUpdate.rateLimitPenalty = hs.rateLimitPenalty;
            if (typeof hs.failurePenalty === 'number' && hs.failurePenalty >= -50 && hs.failurePenalty <= 0) hsUpdate.failurePenalty = hs.failurePenalty;
            if (typeof hs.recoveryPerHour === 'number' && hs.recoveryPerHour >= 0 && hs.recoveryPerHour <= 20) hsUpdate.recoveryPerHour = hs.recoveryPerHour;
            if (typeof hs.minUsable === 'number' && hs.minUsable >= 0 && hs.minUsable <= 100) hsUpdate.minUsable = hs.minUsable;
            if (typeof hs.maxScore === 'number' && hs.maxScore >= 1 && hs.maxScore <= 200) hsUpdate.maxScore = hs.maxScore;
            if (Object.keys(hsUpdate).length > 0) acctUpdate.healthScore = hsUpdate;
        }

        // Token bucket tuning
        if (accountSelection.tokenBucket && typeof accountSelection.tokenBucket === 'object') {
            const tb = accountSelection.tokenBucket;
            const tbUpdate = {};
            if (typeof tb.maxTokens === 'number' && tb.maxTokens >= 5 && tb.maxTokens <= 200) tbUpdate.maxTokens = tb.maxTokens;
            if (typeof tb.tokensPerMinute === 'number' && tb.tokensPerMinute >= 1 && tb.tokensPerMinute <= 60) tbUpdate.tokensPerMinute = tb.tokensPerMinute;
            if (typeof tb.initialTokens === 'number' && tb.initialTokens >= 1 && tb.initialTokens <= 200) tbUpdate.initialTokens = tb.initialTokens;
            if (Object.keys(tbUpdate).length > 0) acctUpdate.tokenBucket = tbUpdate;
        }

        // Quota tuning
        if (accountSelection.quota && typeof accountSelection.quota === 'object') {
            const q = accountSelection.quota;
            const qUpdate = {};
            if (typeof q.lowThreshold === 'number' && q.lowThreshold >= 0 && q.lowThreshold < 1) qUpdate.lowThreshold = q.lowThreshold;
            if (typeof q.criticalThreshold === 'number' && q.criticalThreshold >= 0 && q.criticalThreshold < 1) qUpdate.criticalThreshold = q.criticalThreshold;
            if (typeof q.staleMs === 'number' && q.staleMs >= 30000 && q.staleMs <= 3600000) qUpdate.staleMs = q.staleMs;
            if (Object.keys(qUpdate).length > 0) acctUpdate.quota = qUpdate;
        }

        // Weights tuning
        if (accountSelection.weights && typeof accountSelection.weights === 'object') {
            const w = accountSelection.weights;
            const wUpdate = {};
            if (typeof w.health === 'number' && w.health >= 0 && w.health <= 20) wUpdate.health = w.health;
            if (typeof w.tokens === 'number' && w.tokens >= 0 && w.tokens <= 20) wUpdate.tokens = w.tokens;
            if (typeof w.quota === 'number' && w.quota >= 0 && w.quota <= 20) wUpdate.quota = w.quota;
            if (typeof w.lru === 'number' && w.lru >= 0 && w.lru <= 5) wUpdate.lru = w.lru;
            if (Object.keys(wUpdate).length > 0) acctUpdate.weights = wUpdate;
        }

        if (Object.keys(acctUpdate).length > 0) {
            updates.accountSelection = acctUpdate;
        }
    }

    return updates;
}

/**
 * Mount WebUI routes and middleware on Express app
 * @param {Express} app - Express application instance
 * @param {string} dirname - __dirname of the calling module (for static file path)
 * @param {AccountManager} accountManager - Account manager instance
 */
export function mountWebUI(app, dirname, accountManager) {
    // The legacy Commander dashboard is the primary :1987 experience.
    // Keep the React control plane available explicitly at /control-plane so
    // it cannot shadow the account-management dashboard at `/`.
    const distPath = path.join(dirname, '../../dist');
    if (fs.existsSync(distPath)) {
        app.use('/control-plane', express.static(distPath));
    }

    // Legacy Commander assets and views remain the default dashboard.
    app.use(express.static(path.join(dirname, '../public')));

    // React control-plane deep links resolve under its explicit prefix.
    if (fs.existsSync(distPath)) {
        app.get('/control-plane/*', (req, res) => res.sendFile(path.join(distPath, 'index.html')));
    }

    // ==========================================
    // UI Self-Improvement & Changes API
    // ==========================================
    const uiChangesLogPath = path.join(dirname, '../../.logs/ui-changes.jsonl');

    /**
     * POST /api/ui-changes - Append a UI state transition event
     */
    app.post('/api/ui-changes', (req, res) => {
        try {
            const event = req.body;
            if (!event || typeof event !== 'object') {
                return res.status(400).json({ status: 'error', error: 'Invalid event payload' });
            }
            const logDir = path.dirname(uiChangesLogPath);
            if (!fs.existsSync(logDir)) {
                fs.mkdirSync(logDir, { recursive: true });
            }
            const line = JSON.stringify({
                timestamp: event.timestamp || new Date().toISOString(),
                zoneId: event.zoneId || 'unknown',
                action: event.action || 'applied',
                secondsRemainingAtEvent: event.secondsRemainingAtEvent ?? null,
                note: event.note || null
            }) + '\n';
            fs.appendFileSync(uiChangesLogPath, line, 'utf8');
            res.json({ status: 'ok', logged: true });
        } catch (err) {
            logger.error('[WebUI] Failed to append ui-change log:', err);
            res.status(500).json({ status: 'error', error: err.message });
        }
    });

    /**
     * GET /api/ui-changes - Read back recent UI change log entries
     */
    app.get('/api/ui-changes', (req, res) => {
        try {
            const limit = parseInt(req.query.limit || '50', 10);
            if (!fs.existsSync(uiChangesLogPath)) {
                return res.json({ status: 'ok', entries: [] });
            }
            const content = fs.readFileSync(uiChangesLogPath, 'utf8');
            const lines = content.trim().split('\n').filter(Boolean);
            const entries = lines.slice(-limit).map(l => {
                try { return JSON.parse(l); } catch { return null; }
            }).filter(Boolean);
            res.json({ status: 'ok', entries });
        } catch (err) {
            res.status(500).json({ status: 'error', error: err.message });
        }
    });

    // ==========================================
    // Unified Tool Catalog API
    // ==========================================

    /**
     * GET /api/tools - Merged tool catalog: native UI/browser tools + SSmcp infra tools
     */
    app.get('/api/tools', async (req, res) => {
        try {
            const nativeList = [...NATIVE_TOOLS];
            let ssmcpTools = [];
            try {
                const ssmcpUrl = process.env.SSMCP_HTTP_TARGET || 'http://127.0.0.1:8765';
                const response = await fetch(`${ssmcpUrl}/tools/list`, { signal: AbortSignal.timeout(1500) });
                if (response.ok) {
                    const data = await response.json();
                    if (Array.isArray(data?.tools)) {
                        ssmcpTools = data.tools.map(t => ({ ...t, category: 'infra' }));
                    }
                }
            } catch (err) {
                // SSmcp offline or not reachable; proceed with native tools
            }
            res.json({
                status: 'ok',
                tools: [...nativeList, ...ssmcpTools]
            });
        } catch (err) {
            res.status(500).json({ status: 'error', error: err.message });
        }
    });

    /**
     * POST /api/tools/call - Dispatch tool execution by name
     */
    app.post('/api/tools/call', async (req, res) => {
        try {
            const { name, arguments: args } = req.body || {};
            if (!name) {
                return res.status(400).json({ status: 'error', error: 'Missing tool name' });
            }

            const isNative = NATIVE_TOOLS.some(t => t.name === name);
            if (isNative) {
                const result = await callNativeTool(name, args || {});
                return res.json(result);
            }

            // Forward to SSmcp server
            const ssmcpUrl = process.env.SSMCP_HTTP_TARGET || 'http://127.0.0.1:8765';
            const forwardRes = await fetch(`${ssmcpUrl}/tools/call`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, arguments: args || {} }),
                signal: AbortSignal.timeout(15000)
            });

            if (!forwardRes.ok) {
                const errText = await forwardRes.text();
                return res.status(forwardRes.status).json({ ok: false, error: errText });
            }

            const resultData = await forwardRes.json();
            res.json(resultData);
        } catch (err) {
            logger.error(`[Tool Catalog] Tool execution error for ${req.body?.name}:`, err);
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    // ==========================================
    // Account Management API
    // ==========================================

    /**
     * GET /api/utilization - Comprehensive per-account utilization snapshot
     *
     * Returns every signal that feeds into routing decisions:
     * - Per-model quota fractions + exact reset timestamps
     * - Rate-limit status + ms until reset
     * - Subscription tier (free/pro)
     * - Health scores (if hybrid strategy)
     * - Token bucket state
     * - Last-used timestamps
     * - Routing priority score breakdown
     *
     * Designed for the /monitor dashboard and external alerting.
     */
    app.get('/api/utilization', async (req, res) => {
        try {
            const allAccounts = accountManager.getAllAccounts();
            const now = Date.now();
            const healthData = accountManager.getStrategyHealthData();
            const healthByEmail = {};
            if (healthData?.trackers?.accounts) {
                for (const h of healthData.trackers.accounts) {
                    healthByEmail[h.email] = h;
                }
            }

            const accounts = allAccounts.map(account => {
                const email = account.email;
                const tier = account.subscription?.tier || 'unknown';

                // ── Rate limits ────────────────────────────────────────────
                const rateLimits = {};
                for (const [modelId, limit] of Object.entries(account.modelRateLimits || {})) {
                    const resetTime = limit.resetTime;
                    const isLimited = !!(limit.isRateLimited && resetTime && resetTime > now);
                    rateLimits[modelId] = {
                        isRateLimited: isLimited,
                        resetTime: resetTime || null,
                        resetInMs: isLimited ? Math.max(0, resetTime - now) : 0,
                        resetInSec: isLimited ? Math.ceil((resetTime - now) / 1000) : 0,
                        actualResetMs: limit.actualResetMs || null
                    };
                }

                // ── Quota ──────────────────────────────────────────────────
                const quota = {};
                const models = account.quota?.models || {};
                let geminiExhausted = 0, geminiTotal = 0;
                let claudeExhausted = 0, claudeTotal = 0;

                const isEligibleForClaude = account.type !== 'apikey' && (tier === 'pro' || tier === 'ultra' || tier === 'plus');

                for (const [modelId, q] of Object.entries(models)) {
                    const isClaude = modelId.toLowerCase().includes('claude');
                    const isGemini = modelId.toLowerCase().includes('gemini');

                    let frac = typeof q.remainingFraction === 'number' ? q.remainingFraction : null;
                    if (isClaude && !isEligibleForClaude) {
                        frac = 0;
                    }

                    const resetISO = q.resetTime || null;
                    const resetMs = resetISO ? Math.max(0, new Date(resetISO).getTime() - now) : null;
                    const isLimited = rateLimits[modelId]?.isRateLimited || false;
                    const exhausted = isLimited || (frac !== null && frac < 0.05);

                    quota[modelId] = {
                        remainingFraction: frac,
                        remainingPct: frac !== null ? Math.round(frac * 100) : null,
                        exhausted,
                        resetTime: resetISO,
                        resetInMs: resetMs,
                        resetInSec: resetMs !== null ? Math.ceil(resetMs / 1000) : null,
                        resetInMin: resetMs !== null ? Math.ceil(resetMs / 60000) : null
                    };

                    if (isGemini) { geminiTotal++; if (exhausted) geminiExhausted++; }
                    if (isClaude) { claudeTotal++; if (exhausted || !isEligibleForClaude) claudeExhausted++; }
                }

                const cooldownMs = accountManager.getCooldownRemaining(email);
                const isAccountActive = account.enabled !== false && !account.isInvalid && cooldownMs === 0;
                const geminiAvailable = isAccountActive && geminiTotal > 0 && geminiExhausted < geminiTotal;
                const claudeAvailable = isAccountActive && isEligibleForClaude && claudeTotal > 0 && claudeExhausted < claudeTotal;
                const fullyExhausted = isAccountActive && !geminiAvailable && !claudeAvailable;

                // ── Health tracker ─────────────────────────────────────────
                const health = healthByEmail[email] || null;

                // ── Next available time ────────────────────────────────────
                // The soonest any rate-limited/exhausted model resets
                const allResets = [
                    ...Object.values(rateLimits)
                        .filter(r => r.isRateLimited && r.resetTime)
                        .map(r => r.resetTime),
                    ...Object.values(quota)
                        .filter(q => q.exhausted && q.resetTime)
                        .map(q => new Date(q.resetTime).getTime())
                ].filter(Boolean);

                const nextResetMs = allResets.length > 0 ? Math.min(...allResets) : null;
                const nextResetIn = nextResetMs ? Math.max(0, nextResetMs - now) : null;

                return {
                    email,
                    tier,
                    enabled: account.enabled !== false,
                    isInvalid: account.isInvalid || false,
                    invalidReason: account.invalidReason || null,
                    lastUsed: account.lastUsed || null,
                    lastUsedAgo: account.lastUsed ? Math.floor((now - account.lastUsed) / 1000) : null,
                    cooldownMs,
                    isCoolingDown: cooldownMs > 0,
                    // Status summary
                    status: {
                        geminiAvailable,
                        claudeAvailable,
                        fullyExhausted,
                        geminiExhaustedCount: geminiExhausted,
                        geminiModelCount: geminiTotal,
                        claudeExhaustedCount: claudeExhausted,
                        claudeModelCount: claudeTotal,
                        nextResetMs,
                        nextResetInSec: nextResetIn !== null ? Math.ceil(nextResetIn / 1000) : null,
                        nextResetInMin: nextResetIn !== null ? Math.ceil(nextResetIn / 60000) : null
                    },
                    // Health tracker (hybrid strategy only)
                    health: health ? {
                        score: health.healthScore,
                        isUsable: health.isUsable,
                        consecutiveFailures: health.consecutiveFailures,
                        tokens: health.tokens,
                        hasTokens: health.hasTokens,
                        maxTokens: health.maxTokens
                    } : null,
                    rateLimits,
                    quota
                };
            });

            // ── Fleet-wide summary ─────────────────────────────────────────
            const freeAccounts = accounts.filter(a => a.tier === 'free');
            const proAccounts  = accounts.filter(a => a.tier === 'pro' || a.tier === 'plus' || a.tier === 'ultra');
            const fullyExhaustedCount = accounts.filter(a => a.status.fullyExhausted).length;
            const geminiAvailableCount = accounts.filter(a => a.status.geminiAvailable).length;
            const claudeAvailableCount = accounts.filter(a => a.status.claudeAvailable).length;

            const routingStats = getRoutingStats();
            const persistentEvents = eventLogger.getEvents(50);
            const systemUsage = await getSystemUsageReport();

            res.json({
                status: 'ok',
                generatedAt: new Date().toISOString(),
                fleet: {
                    total: accounts.length,
                    free: freeAccounts.length,
                    pro: proAccounts.length,
                    enabled: accounts.filter(a => a.enabled).length,
                    invalid: accounts.filter(a => a.isInvalid).length,
                    fullyExhausted: fullyExhaustedCount,
                    geminiAvailable: geminiAvailableCount,
                    claudeAvailable: claudeAvailableCount,
                    strategy: accountManager.getStrategyName()
                },
                routingStats,
                systemUsage,
                eventLog: persistentEvents,
                accounts
            });
        } catch (error) {
            logger.error('[WebUI] Error building utilization report:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * GET /api/system-usage - Real-time AI operations, accumulated tokens, and local vs remote workload breakdown
     */
    app.get('/api/system-usage', async (req, res) => {
        try {
            const usageReport = await getSystemUsageReport();
            res.json({
                status: 'ok',
                generatedAt: new Date().toISOString(),
                ...usageReport
            });
        } catch (error) {
            logger.error('[WebUI] Error building system usage report:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * POST /api/ui-changes - Append a UI change-log entry (from ChangeConfirmGate)
     * Appends as JSON lines to .logs/ui-changes.jsonl so AGY Desktop / OpenCode
     * can tail or read the file directly for fallback/fix context.
     */
    app.post('/api/ui-changes', (req, res) => {
        try {
            const entry = req.body;
            if (!entry || typeof entry !== 'object' || !entry.zoneId || !entry.action) {
                return res.status(400).json({ status: 'error', error: 'zoneId and action are required' });
            }
            const logDir = path.join(dirname, '../../.logs');
            if (!fs.existsSync(logDir)) {
                fs.mkdirSync(logDir, { recursive: true });
            }
            const logPath = path.join(logDir, 'ui-changes.jsonl');
            const line = JSON.stringify({
                timestamp: entry.timestamp || new Date().toISOString(),
                zoneId: entry.zoneId,
                action: entry.action,
                secondsRemainingAtEvent: entry.secondsRemainingAtEvent ?? null,
                note: entry.note || null,
            });
            fs.appendFileSync(logPath, line + '\n');
            res.json({ status: 'ok' });
        } catch (error) {
            logger.error('[WebUI] Error appending UI change log:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * GET /api/ui-changes - Read recent UI change-log entries
     * Convenience read endpoint for the Evolve drawer's history strip.
     */
    app.get('/api/ui-changes', (req, res) => {
        try {
            const limit = parseInt(req.query.limit || '100', 10);
            const logPath = path.join(dirname, '../../.logs', 'ui-changes.jsonl');
            if (!fs.existsSync(logPath)) {
                return res.json({ status: 'ok', entries: [] });
            }
            const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
            const entries = lines.slice(-limit).map((l) => {
                try { return JSON.parse(l); } catch { return null; }
            }).filter(Boolean);
            res.json({ status: 'ok', entries });
        } catch (error) {
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * GET /api/tools - Merged tool catalog: native tools + SSmcp's tools/list
     * One flat, categorized list so the chat agent (and the sidebar) can pick
     * from every available action - UI changes, browser control, and all
     * SSmcp infra tools - without knowing which backend each one lives on.
     */
    app.get('/api/tools', async (req, res) => {
        try {
            let mcpTools = [];
            try {
                const mcpRes = await fetch('http://127.0.0.1:8765/mcp', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/list', params: {} }),
                });
                const mcpData = await mcpRes.json();
                mcpTools = (mcpData?.result?.tools || []).map(t => ({ ...t, category: t.category || 'infra' }));
            } catch (e) {
                logger.warn('[WebUI] Could not reach SSmcp for tools/list (non-fatal):', e.message);
            }
            res.json({
                status: 'ok',
                tools: [...NATIVE_TOOLS, ...mcpTools],
                categories: ['ui', 'browser', 'infra'],
            });
        } catch (error) {
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * POST /api/tools/call - Dispatch a tool call by name
     * Native tools (modify_ui, open_chrome_profile) run locally.
     * Anything else is proxied to SSmcp's mcp-api tools/call.
     */
    app.post('/api/tools/call', async (req, res) => {
        try {
            const { name, arguments: args } = req.body || {};
            if (!name) {
                return res.status(400).json({ status: 'error', error: 'name is required' });
            }
            const isNative = NATIVE_TOOLS.some(t => t.name === name);
            if (isNative) {
                const result = await callNativeTool(name, args || {});
                return res.json({ status: result.ok ? 'ok' : 'error', ...result });
            }
            // Proxy to SSmcp
            const mcpRes = await fetch('http://127.0.0.1:8765/mcp', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: Date.now(),
                    method: 'tools/call',
                    params: { name, arguments: args || {} },
                }),
            });
            const mcpData = await mcpRes.json();
            res.json({ status: 'ok', result: mcpData?.result ?? mcpData });
        } catch (error) {
            logger.error('[WebUI] Error dispatching tool call:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * GET /api/events - Get persistent event log entries
     */
    app.get('/api/events', (req, res) => {
        try {
            const limit = parseInt(req.query.limit || '50', 10);
            res.json({
                status: 'ok',
                events: eventLogger.getEvents(limit)
            });
        } catch (error) {
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * POST /api/accounts/:email/cooldown - Custom cooldown override (set or clear)
     */
    app.post('/api/accounts/:email/cooldown', async (req, res) => {
        try {
            const { email } = req.params;
            const { cooldownMs, clear, reason } = req.body || {};

            if (clear) {
                if (accountManager && typeof accountManager.clearAccountCooldown === 'function') {
                    accountManager.clearAccountCooldown(email);
                }
                return res.json({
                    status: 'ok',
                    message: `Cooldown cleared for account ${email}`
                });
            }

            if (typeof cooldownMs !== 'number' || cooldownMs < 0) {
                return res.status(400).json({
                    status: 'error',
                    error: 'cooldownMs must be a non-negative number, or clear must be true'
                });
            }

            if (accountManager && typeof accountManager.setAccountCooldown === 'function') {
                accountManager.setAccountCooldown(email, cooldownMs, reason || 'manual_override');
            } else if (accountManager && typeof accountManager.markAccountCoolingDown === 'function') {
                accountManager.markAccountCoolingDown(email, cooldownMs, reason || 'manual_override');
            }

            res.json({
                status: 'ok',
                message: `Cooldown set to ${cooldownMs}ms for ${email}`,
                cooldownRemainingMs: accountManager.getCooldownRemaining(email)
            });
        } catch (error) {
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * GET / - Legacy Commander dashboard entry point.
     * Explicit route prevents a stale React dist index from becoming primary.
     */
    app.get('/', (req, res) => {
        res.sendFile(path.join(dirname, '../public/index.html'));
    });

    /**
     * GET /monitor - Standalone utilization monitoring page
     */
    app.get('/monitor', (req, res) => {
        res.send(buildMonitorPage());
    });

    /**
     * GET /api/accounts - List all accounts with status
     */
    app.get('/api/accounts', async (req, res) => {
        try {
            const status = accountManager.getStatus();
            res.json({
                status: 'ok',
                accounts: status.accounts,
                summary: {
                    total: status.total,
                    available: status.available,
                    rateLimited: status.rateLimited,
                    invalid: status.invalid
                }
            });
        } catch (error) {
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * POST /api/accounts/:email/refresh - Refresh specific account token
     */
    app.post('/api/accounts/:email/refresh', async (req, res) => {
        try {
            const { email } = req.params;
            accountManager.clearTokenCache(email);
            accountManager.clearProjectCache(email);

            // For verification errors (403 VALIDATION_REQUIRED), clear isInvalid on refresh.
            // The user has completed verification on Google's site and clicks Refresh to re-enable.
            // Auth errors (no verifyUrl) still require OAuth re-auth via FIX button.
            const account = accountManager.getAllAccounts().find(a => a.email === email);
            if (account && account.isInvalid) {
                accountManager.clearInvalid(email);
                account.isInvalid = false;
                account.invalidReason = null;
                await accountManager.saveToDisk().catch(() => {});
            }

            res.json({
                status: 'ok',
                message: `Token cache cleared for ${email}`
            });
        } catch (error) {
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * POST /api/accounts/:email/toggle - Enable/disable account
     */
    app.post('/api/accounts/:email/toggle', async (req, res) => {
        try {
            const { email } = req.params;
            const { enabled } = req.body;

            if (typeof enabled !== 'boolean') {
                return res.status(400).json({ status: 'error', error: 'enabled must be a boolean' });
            }

            if (accountManager && typeof accountManager.setAccountEnabled === 'function') {
                await accountManager.setAccountEnabled(email, enabled);
            } else {
                await setAccountEnabled(email, enabled);
                await accountManager.reload();
            }

            res.json({
                status: 'ok',
                message: `Account ${email} ${enabled ? 'enabled' : 'disabled'}`
            });
        } catch (error) {
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * DELETE /api/accounts/:email - Remove account
     */
    app.delete('/api/accounts/:email', async (req, res) => {
        try {
            const { email } = req.params;
            await removeAccount(email);

            // Reload AccountManager to pick up changes
            await accountManager.reload();

            res.json({
                status: 'ok',
                message: `Account ${email} removed`
            });
        } catch (error) {
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * PATCH /api/accounts/:email - Update account settings (thresholds)
     */
    app.patch('/api/accounts/:email', async (req, res) => {
        try {
            const { email } = req.params;
            const { quotaThreshold, modelQuotaThresholds } = req.body;

            const { accounts, settings, activeIndex } = await loadAccounts(ACCOUNT_CONFIG_PATH);
            const account = accounts.find(a => a.email === email);

            if (!account) {
                return res.status(404).json({ status: 'error', error: `Account ${email} not found` });
            }

            // Validate and update quotaThreshold (0-0.99 or null/undefined to clear)
            if (quotaThreshold !== undefined) {
                if (quotaThreshold === null) {
                    delete account.quotaThreshold;
                } else if (typeof quotaThreshold === 'number' && quotaThreshold >= 0 && quotaThreshold < 1) {
                    account.quotaThreshold = quotaThreshold;
                } else {
                    return res.status(400).json({ status: 'error', error: 'quotaThreshold must be 0-0.99 or null' });
                }
            }

            // Validate and update modelQuotaThresholds (full replacement, not merge)
            if (modelQuotaThresholds !== undefined) {
                if (modelQuotaThresholds === null || (typeof modelQuotaThresholds === 'object' && Object.keys(modelQuotaThresholds).length === 0)) {
                    // Clear all model thresholds
                    delete account.modelQuotaThresholds;
                } else if (typeof modelQuotaThresholds === 'object') {
                    // Validate all thresholds first
                    for (const [modelId, threshold] of Object.entries(modelQuotaThresholds)) {
                        if (typeof threshold !== 'number' || threshold < 0 || threshold >= 1) {
                            return res.status(400).json({
                                status: 'error',
                                error: `Invalid threshold for model ${modelId}: must be 0-0.99`
                            });
                        }
                    }
                    // Replace entire object (not merge)
                    account.modelQuotaThresholds = { ...modelQuotaThresholds };
                } else {
                    return res.status(400).json({ status: 'error', error: 'modelQuotaThresholds must be an object or null' });
                }
            }

            await saveAccounts(ACCOUNT_CONFIG_PATH, accounts, settings, activeIndex);

            // Reload AccountManager to pick up changes
            await accountManager.reload();

            logger.info(`[WebUI] Account ${email} thresholds updated`);

            res.json({
                status: 'ok',
                message: `Account ${email} thresholds updated`,
                account: {
                    email: account.email,
                    quotaThreshold: account.quotaThreshold,
                    modelQuotaThresholds: account.modelQuotaThresholds || {}
                }
            });
        } catch (error) {
            logger.error('[WebUI] Error updating account thresholds:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * GET /api/swarm/credentials/:email - Retrieve on-demand password and 2SV backup codes
     */
     app.get('/api/swarm/credentials/:email', async (req, res) => {
        try {
            const { email } = req.params;
            const vaultPath = path.join(os.homedir(), '.config', 'antigravity-proxy', 'swarm-recovery-vault.json');
            let vaultData = {};
            if (fs.existsSync(vaultPath)) {
                try {
                    vaultData = JSON.parse(fs.readFileSync(vaultPath, 'utf8'));
                } catch (e) {}
            }
            const accVault = vaultData[email] || {};
            res.json({
                status: 'ok',
                email,
                password: process.env.DEFAULT_PASSWORD || 'Swarmd6f9b714!!2026',
                recoveryEmail: accVault.recoveryEmail || 'apps@reseller.mysolidstate.ca',
                backupCodes: accVault.backupCodes || [],
                nextBackupCode: (accVault.backupCodes && accVault.backupCodes[0]) || null
            });
        } catch (error) {
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * POST /api/swarm/launch-clean-window - Launch clean window bypassing 10-account stack
     */
    app.post('/api/swarm/launch-clean-window', async (req, res) => {
        try {
            const { email, url } = req.body;
            const targetUrl = url || `https://accounts.google.com/AccountChooser?Email=${encodeURIComponent(email)}&continue=https://myaccount.google.com`;
            const { spawn } = await import('child_process');
            spawn('open', ['-a', 'Google Chrome', targetUrl], { detached: true, stdio: 'ignore' }).unref();
            res.json({ status: 'ok', message: `Launched clean window for ${email}` });
        } catch (error) {
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * POST /api/swarm/launch-admin-profile - Open Admin Console in the exact authenticated Super Admin Chrome profile
     */
    app.post('/api/swarm/launch-admin-profile', async (req, res) => {
        try {
            const { email } = req.body;
            let profileDirectory = 'Profile 8'; // adam@adamassist.com
            if (email.includes('@reseller.mysolidstate.ca')) {
                profileDirectory = 'Profile 13'; // apps@reseller.mysolidstate.ca
            } else if (email.includes('@mysolidstate.ca')) {
                profileDirectory = 'Profile 10'; // hub@mysolidstate.ca
            } else if (email.includes('@adamassist.com')) {
                profileDirectory = 'Profile 8'; // adam@adamassist.com
            }

            const targetUrl = `https://admin.google.com/ac/users/${encodeURIComponent(email)}/security`;
            const { spawn } = await import('child_process');
            spawn('open', ['-na', 'Google Chrome', '--args', `--profile-directory=${profileDirectory}`, targetUrl], { detached: true, stdio: 'ignore' }).unref();
            res.json({ status: 'ok', profileDirectory, targetUrl });
        } catch (error) {
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * GET /api/swarm/discover - Discover numeric/z-prefixed Workspace users.
     */
    app.get('/api/swarm/discover', async (req, res) => {
        try {
            const accounts = await discoverSwarmAccounts();
            res.json({ status: 'ok', accounts, count: accounts.length });
        } catch (error) {
            logger.error('[WebUI] Swarm discovery failed:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * POST /api/swarm/provision - Create swarm users through Google Admin SDK.
     */
    app.post('/api/swarm/provision', async (req, res) => {
        try {
            const { domain, prefix = '', startIdx = 1, count } = req.body || {};
            const normalizedCount = Number(count);
            const normalizedStart = Number(startIdx);
            if (!domain || !Number.isInteger(normalizedCount) || normalizedCount < 1 || normalizedCount > 100 || !Number.isInteger(normalizedStart) || normalizedStart < 0) {
                return res.status(400).json({ status: 'error', error: 'domain, integer startIdx, and count between 1 and 100 are required' });
            }
            const safePrefix = String(prefix);
            if (!/^[a-zA-Zz]*$/.test(safePrefix)) {
                return res.status(400).json({ status: 'error', error: 'prefix may contain letters only' });
            }
            const allowedDomains = ['mysolidstate.ca', 'reseller.mysolidstate.ca', 'adamassist.com'];
            if (!allowedDomains.includes(domain)) {
                return res.status(400).json({ status: 'error', error: `Unsupported domain: ${domain}` });
            }
            const created = await provisionSwarmAccounts(domain, safePrefix, normalizedStart, normalizedCount);
            res.json({ status: 'ok', domain, prefix: safePrefix, startIdx: normalizedStart, requested: normalizedCount, created });
        } catch (error) {
            logger.error('[WebUI] Swarm provisioning failed:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * POST /api/swarm/auto-onboard - Run autonomous zero-touch onboarding robot for an account
     */
    
    app.get('/api/swarm/next-pending', async (req, res) => {
        try {
            const rawDomain = req.query.domain || '';
            const domain = rawDomain.replace(/^@/, '').trim();
            const fs = await import('fs');
            const path = await import('path');
            const os = await import('os');
            const vaultPath = path.join(os.homedir(), '.config', 'antigravity-proxy', 'swarm-recovery-vault.json');
            const accountsPath = path.join(os.homedir(), '.config', 'antigravity-proxy', 'accounts.json');
            
            let vault = {};
            if (fs.existsSync(vaultPath)) {
                try { vault = JSON.parse(fs.readFileSync(vaultPath, 'utf8')); } catch (e) {}
            }
            let accountsData = { accounts: [] };
            if (fs.existsSync(accountsPath)) {
                try { accountsData = JSON.parse(fs.readFileSync(accountsPath, 'utf8')); } catch (e) {}
            }
            
            // 1. Check if any existing account for this domain genuinely needs to be logged in again (e.g. revoked token)
            const accountsNeedingRelogin = accountsData.accounts.filter(a => 
                (domain ? a.email.endsWith('@' + domain) : true) && 
                (a.isInvalid || a.status === 'invalid') &&
                (!a.refreshToken || (a.invalidReason && !a.invalidReason.includes('not eligible') && !a.invalidReason.includes('PERMISSION_DENIED')))
            );
            
            if (accountsNeedingRelogin.length > 0) {
                // Sort numerically so we re-login lowest index first
                accountsNeedingRelogin.sort((a, b) => {
                    const numA = parseInt(a.email.match(/^(\d+)/)?.[1] || '999999', 10);
                    const numB = parseInt(b.email.match(/^(\d+)/)?.[1] || '999999', 10);
                    return numA - numB;
                });
                return res.json({ 
                    status: 'ok', 
                    email: accountsNeedingRelogin[0].email,
                    action: 'relogin',
                    reason: accountsNeedingRelogin[0].invalidReason || 'Session needs re-authentication'
                });
            }
            
            // 2. Otherwise find the next sequential pending account from vault that is NOT yet added
            const alreadyAddedEmails = new Set(accountsData.accounts.map(a => a.email));
            const pending = Object.keys(vault)
                .filter(email => !alreadyAddedEmails.has(email) && (domain ? email.endsWith('@' + domain) : true))
                .sort((a, b) => {
                    const numA = parseInt(a.match(/^(\d+)/)?.[1] || '999999', 10);
                    const numB = parseInt(b.match(/^(\d+)/)?.[1] || '999999', 10);
                    return numA - numB;
                });
                
            if (pending.length > 0) {
                res.json({ 
                    status: 'ok', 
                    email: pending[0],
                    action: 'add_next',
                    remainingCount: pending.length
                });
            } else {
                res.status(404).json({ 
                    status: 'error', 
                    error: `All accounts for ${domain || 'fleet'} are active and logged in! (0 pending)` 
                });
            }
        } catch (error) {
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    app.post('/api/swarm/auto-onboard', async (req, res) => {
        try {
            const { email } = req.body;
            if (!email) {
                return res.status(400).json({ status: 'error', error: 'Email is required' });
            }
            const { spawn } = await import('child_process');
            const proc = spawn('node', ['ai-proxy/src/bulletproof-zero-touch.js', email], {
                cwd: '/Users/test/Projects/solidstack',
                detached: true,
                stdio: 'ignore'
            });
            proc.unref();
            res.json({ status: 'ok', message: `Autonomous zero-touch onboarding launched for ${email}` });
        } catch (error) {
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * GET /api/swarm/latest-verification-code - Intercept 6-digit Google verification code from recovery inbox
     */
    app.get('/api/swarm/latest-verification-code', async (req, res) => {
        try {
            const email = req.query.email || '';
            const timeout = req.query.timeout || '8';
            const projectRoot = '/Users/test/Projects/solidstack';
            const { exec } = await import('child_process');
            exec(`python3 ss/recovery_listener.py "${email}" ${timeout}`, { cwd: projectRoot }, (error, stdout) => {
                try {
                    // Extract json payload
                    const jsonMatch = stdout.match(/\{[\s\S]*\}/);
                    if (jsonMatch) {
                        const parsed = JSON.parse(jsonMatch[0]);
                        return res.json(parsed);
                    }
                    res.json({ status: 'error', raw: stdout });
                } catch (e) {
                    res.status(500).json({ status: 'error', error: stdout || error?.message });
                }
            });
        } catch (error) {
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * POST /api/accounts/reload - Reload accounts from disk
     */
    app.post('/api/accounts/reload', async (req, res) => {
        try {
            // Reload AccountManager from disk
            await accountManager.reload();

            const status = accountManager.getStatus();
            res.json({
                status: 'ok',
                message: 'Accounts reloaded from disk',
                summary: status.summary
            });
        } catch (error) {
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * GET /api/accounts/export - Export accounts
     */
    app.get('/api/accounts/export', async (req, res) => {
        try {
            const { accounts } = await loadAccounts(ACCOUNT_CONFIG_PATH);

            // Export only essential fields for portability
            const exportData = accounts
                .filter(acc => acc.source !== 'database')
                .map(acc => {
                    const essential = { email: acc.email };
                    // Use snake_case for compatibility
                    if (acc.refreshToken) {
                        essential.refresh_token = acc.refreshToken;
                    }
                    if (acc.apiKey) {
                        essential.api_key = acc.apiKey;
                    }
                    return essential;
                });

            // Return plain array for simpler format
            res.json(exportData);
        } catch (error) {
            logger.error('[WebUI] Export accounts error:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * POST /api/accounts/import - Batch import accounts
     */
    app.post('/api/accounts/import', async (req, res) => {
        try {
            // Support both wrapped format { accounts: [...] } and plain array [...]
            let importAccounts = req.body;
            if (req.body.accounts && Array.isArray(req.body.accounts)) {
                importAccounts = req.body.accounts;
            }

            if (!Array.isArray(importAccounts) || importAccounts.length === 0) {
                return res.status(400).json({
                    status: 'error',
                    error: 'accounts must be a non-empty array'
                });
            }

            const results = { added: [], updated: [], failed: [] };

            // Load existing accounts once before the loop
            const { accounts: existingAccounts } = await loadAccounts(ACCOUNT_CONFIG_PATH);
            const existingEmails = new Set(existingAccounts.map(a => a.email));

            for (const acc of importAccounts) {
                try {
                    // Validate required fields
                    if (!acc.email) {
                        results.failed.push({ email: acc.email || 'unknown', reason: 'Missing email' });
                        continue;
                    }

                    // Support both snake_case and camelCase
                    const refreshToken = acc.refresh_token || acc.refreshToken;
                    const apiKey = acc.api_key || acc.apiKey;

                    // Must have at least one credential
                    if (!refreshToken && !apiKey) {
                        results.failed.push({ email: acc.email, reason: 'Missing refresh_token or api_key' });
                        continue;
                    }

                    // Check if account already exists
                    const exists = existingEmails.has(acc.email);

                    // Add account
                    await addAccount({
                        email: acc.email,
                        source: apiKey ? 'manual' : 'oauth',
                        refreshToken: refreshToken,
                        apiKey: apiKey
                    });

                    if (exists) {
                        results.updated.push(acc.email);
                    } else {
                        results.added.push(acc.email);
                    }
                } catch (err) {
                    results.failed.push({ email: acc.email, reason: err.message });
                }
            }

            // Reload AccountManager
            await accountManager.reload();

            logger.info(`[WebUI] Import complete: ${results.added.length} added, ${results.updated.length} updated, ${results.failed.length} failed`);

            res.json({
                status: 'ok',
                results,
                message: `Imported ${results.added.length + results.updated.length} accounts`
            });
        } catch (error) {
            logger.error('[WebUI] Import accounts error:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    // ==========================================
    // Configuration API
    // ==========================================

    /**
     * GET /api/config - Get server configuration
     */
    app.get('/api/config', (req, res) => {
        try {
            const publicConfig = getPublicConfig();
            res.json({
                status: 'ok',
                config: publicConfig,
                version: packageVersion,
                note: 'Edit ~/.config/antigravity-proxy/config.json or use env vars to change these values'
            });
        } catch (error) {
            logger.error('[WebUI] Error getting config:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * POST /api/config - Update server configuration
     */
    app.post('/api/config', async (req, res) => {
        try {
            const { debug, devMode, logLevel, persistTokenCache, requestThrottlingEnabled, requestDelayMs } = req.body;

            // Validate tunable config fields via shared helper
            const updates = validateConfigFields(req.body);

            // Handle fields not covered by the shared helper
            if (typeof devMode === 'boolean') {
                updates.devMode = devMode;
                updates.debug = devMode;
                logger.setDebug(devMode);
            } else if (typeof debug === 'boolean') {
                updates.debug = debug;
                updates.devMode = debug;
                logger.setDebug(debug);
            }
            if (logLevel && ['info', 'warn', 'error', 'debug'].includes(logLevel)) {
                updates.logLevel = logLevel;
            }
            if (typeof persistTokenCache === 'boolean') {
                updates.persistTokenCache = persistTokenCache;
            }
            if (typeof requestThrottlingEnabled === 'boolean') {
                updates.requestThrottlingEnabled = requestThrottlingEnabled;
            }
            if (typeof requestDelayMs === 'number' && requestDelayMs >= 100 && requestDelayMs <= 5000) {
                updates.requestDelayMs = requestDelayMs;
            }

            if (Object.keys(updates).length === 0) {
                return res.status(400).json({
                    status: 'error',
                    error: 'No valid configuration updates provided'
                });
            }

            const success = saveConfig(updates);

            if (success) {
                // Hot-reload strategy if it was changed (no server restart needed)
                if (updates.accountSelection?.strategy && accountManager) {
                    await accountManager.reload();
                    logger.info(`[WebUI] Strategy hot-reloaded to: ${updates.accountSelection.strategy}`);
                }

                res.json({
                    status: 'ok',
                    message: 'Configuration saved. Restart server to apply some changes.',
                    updates: updates,
                    config: getPublicConfig()
                });
            } else {
                res.status(500).json({
                    status: 'error',
                    error: 'Failed to save configuration file'
                });
            }
        } catch (error) {
            logger.error('[WebUI] Error updating config:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * POST /api/config/password - Change WebUI password
     */
    app.post('/api/config/password', (req, res) => {
        try {
            const { oldPassword, newPassword } = req.body;

            // Validate input
            if (!newPassword || typeof newPassword !== 'string') {
                return res.status(400).json({
                    status: 'error',
                    error: 'New password is required'
                });
            }

            // If current password exists, verify old password
            if (config.webuiPassword && config.webuiPassword !== oldPassword) {
                return res.status(403).json({
                    status: 'error',
                    error: 'Invalid current password'
                });
            }

            // Save new password
            const success = saveConfig({ webuiPassword: newPassword });

            if (success) {
                // Update in-memory config
                config.webuiPassword = newPassword;
                res.json({
                    status: 'ok',
                    message: 'Password changed successfully'
                });
            } else {
                throw new Error('Failed to save password to config file');
            }
        } catch (error) {
            logger.error('[WebUI] Error changing password:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * GET /api/settings - Get runtime settings
     */
    app.get('/api/settings', async (req, res) => {
        try {
            const settings = accountManager.getSettings ? accountManager.getSettings() : {};
            res.json({
                status: 'ok',
                settings: {
                    ...settings,
                    port: process.env.PORT || DEFAULT_PORT
                }
            });
        } catch (error) {
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    // ==========================================
    // Claude CLI Configuration API
    // ==========================================

    /**
     * GET /api/claude/config - Get Claude CLI configuration
     */
    app.get('/api/claude/config', async (req, res) => {
        try {
            const claudeConfig = await readClaudeConfig();
            res.json({
                status: 'ok',
                config: claudeConfig,
                path: getClaudeConfigPath()
            });
        } catch (error) {
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * POST /api/claude/config - Update Claude CLI configuration
     */
    app.post('/api/claude/config', async (req, res) => {
        try {
            const updates = req.body;
            if (!updates || typeof updates !== 'object') {
                return res.status(400).json({ status: 'error', error: 'Invalid config updates' });
            }

            const newConfig = await updateClaudeConfig(updates);
            res.json({
                status: 'ok',
                config: newConfig,
                message: 'Claude configuration updated'
            });
        } catch (error) {
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * POST /api/claude/config/restore - Restore Claude CLI to default (remove proxy settings)
     */
    app.post('/api/claude/config/restore', async (req, res) => {
        try {
            const claudeConfig = await readClaudeConfig();

            // Proxy-related environment variables to remove when restoring defaults
            const PROXY_ENV_VARS = [
                'ANTHROPIC_BASE_URL',
                'ANTHROPIC_AUTH_TOKEN',
                'ANTHROPIC_MODEL',
                'CLAUDE_CODE_SUBAGENT_MODEL',
                'ANTHROPIC_DEFAULT_OPUS_MODEL',
                'ANTHROPIC_DEFAULT_SONNET_MODEL',
                'ANTHROPIC_DEFAULT_HAIKU_MODEL',
                'ENABLE_EXPERIMENTAL_MCP_CLI'
            ];

            // Remove proxy-related environment variables to restore defaults
            if (claudeConfig.env) {
                for (const key of PROXY_ENV_VARS) {
                    delete claudeConfig.env[key];
                }
                // Remove env entirely if empty to truly restore defaults
                if (Object.keys(claudeConfig.env).length === 0) {
                    delete claudeConfig.env;
                }
            }

            // Use replaceClaudeConfig to completely overwrite the config (not merge)
            const newConfig = await replaceClaudeConfig(claudeConfig);

            logger.info(`[WebUI] Restored Claude CLI config to defaults at ${getClaudeConfigPath()}`);

            res.json({
                status: 'ok',
                config: newConfig,
                message: 'Claude CLI configuration restored to defaults'
            });
        } catch (error) {
            logger.error('[WebUI] Error restoring Claude config:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    // ==========================================
    // Claude CLI Mode Toggle API (Proxy/Paid)
    // ==========================================

    /**
     * GET /api/claude/mode - Get current mode (proxy or paid)
     * Returns 'proxy' if ANTHROPIC_BASE_URL is set to localhost, 'paid' otherwise
     */
    app.get('/api/claude/mode', async (req, res) => {
        try {
            const claudeConfig = await readClaudeConfig();
            const baseUrl = claudeConfig.env?.ANTHROPIC_BASE_URL || '';

            // Determine mode based on ANTHROPIC_BASE_URL
            const isProxy = baseUrl && (
                baseUrl.includes('localhost') ||
                baseUrl.includes('127.0.0.1') ||
                baseUrl.includes('::1') ||
                baseUrl.includes('0.0.0.0')
            );

            res.json({
                status: 'ok',
                mode: isProxy ? 'proxy' : 'paid'
            });
        } catch (error) {
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * POST /api/claude/mode - Switch between proxy and paid mode
     * Body: { mode: 'proxy' | 'paid' }
     * 
     * When switching to 'paid' mode:
     * - Removes the entire 'env' object from settings.json
     * - Claude CLI uses its built-in defaults (official Anthropic API)
     * 
     * When switching to 'proxy' mode:
     * - Sets 'env' to the first default preset config (from constants.js)
     */
    app.post('/api/claude/mode', async (req, res) => {
        try {
            const { mode } = req.body;

            if (!mode || !['proxy', 'paid'].includes(mode)) {
                return res.status(400).json({
                    status: 'error',
                    error: 'mode must be "proxy" or "paid"'
                });
            }

            const claudeConfig = await readClaudeConfig();

            if (mode === 'proxy') {
                // Switch to proxy mode - use first default preset config (e.g., "Claude Thinking")
                claudeConfig.env = { ...DEFAULT_PRESETS[0].config };
            } else {
                // Switch to paid mode - remove env entirely
                delete claudeConfig.env;
            }

            // Save the updated config
            const newConfig = await replaceClaudeConfig(claudeConfig);

            logger.info(`[WebUI] Switched Claude CLI to ${mode} mode`);

            res.json({
                status: 'ok',
                mode,
                config: newConfig,
                message: `Switched to ${mode === 'proxy' ? 'Proxy' : 'Paid (Anthropic API)'} mode. Restart Claude CLI to apply.`
            });
        } catch (error) {
            logger.error('[WebUI] Error switching mode:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    // ==========================================
    // Claude CLI Presets API
    // ==========================================


    /**
     * GET /api/claude/presets - Get all saved presets
     */
    app.get('/api/claude/presets', async (req, res) => {
        try {
            const presets = await readPresets();
            res.json({ status: 'ok', presets });
        } catch (error) {
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * POST /api/claude/presets - Save a new preset
     */
    app.post('/api/claude/presets', async (req, res) => {
        try {
            const { name, config: presetConfig } = req.body;
            if (!name || typeof name !== 'string' || !name.trim()) {
                return res.status(400).json({ status: 'error', error: 'Preset name is required' });
            }
            if (!presetConfig || typeof presetConfig !== 'object') {
                return res.status(400).json({ status: 'error', error: 'Config object is required' });
            }

            const presets = await savePreset(name.trim(), presetConfig);
            res.json({ status: 'ok', presets, message: `Preset "${name}" saved` });
        } catch (error) {
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * DELETE /api/claude/presets/:name - Delete a preset
     */
    app.delete('/api/claude/presets/:name', async (req, res) => {
        try {
            const { name } = req.params;
            if (!name) {
                return res.status(400).json({ status: 'error', error: 'Preset name is required' });
            }

            const presets = await deletePreset(name);
            res.json({ status: 'ok', presets, message: `Preset "${name}" deleted` });
        } catch (error) {
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    // ==========================================
    // Server Configuration Presets API
    // ==========================================

    /**
     * GET /api/server/presets - List all server config presets
     */
    app.get('/api/server/presets', async (req, res) => {
        try {
            const presets = await readServerPresets();
            res.json({ status: 'ok', presets });
        } catch (error) {
            logger.error('[WebUI] Error reading server presets:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * POST /api/server/presets - Save a custom server config preset
     */
    app.post('/api/server/presets', async (req, res) => {
        try {
            const { name, config: presetConfig, description } = req.body;
            if (!name || typeof name !== 'string' || !name.trim()) {
                return res.status(400).json({ status: 'error', error: 'Preset name is required' });
            }
            if (name.trim().length > 50) {
                return res.status(400).json({ status: 'error', error: 'Preset name must be 50 characters or fewer' });
            }
            if (!presetConfig || typeof presetConfig !== 'object' || Array.isArray(presetConfig)) {
                return res.status(400).json({ status: 'error', error: 'Config object is required' });
            }

            const validatedConfig = validateConfigFields(presetConfig);
            if (Object.keys(validatedConfig).length === 0) {
                return res.status(400).json({ status: 'error', error: 'No valid config fields provided' });
            }

            const presets = await saveServerPreset(name.trim(), validatedConfig, description);
            res.json({ status: 'ok', presets, message: `Server preset "${name}" saved` });
        } catch (error) {
            const status = error.message.includes('built-in') ? 400 : 500;
            res.status(status).json({ status: 'error', error: error.message });
        }
    });

    /**
     * PATCH /api/server/presets/:name - Update custom preset metadata and/or config
     */
    app.patch('/api/server/presets/:name', async (req, res) => {
        try {
            const { name: currentName } = req.params;
            if (!currentName) {
                return res.status(400).json({ status: 'error', error: 'Preset name is required' });
            }

            const { name: newName, description, config: configInput } = req.body;
            if (typeof newName === 'string' && !newName.trim()) {
                return res.status(400).json({ status: 'error', error: 'Preset name is required' });
            }
            if (typeof newName === 'string' && newName.trim().length > 50) {
                return res.status(400).json({ status: 'error', error: 'Preset name must be 50 characters or fewer' });
            }
            const updates = {};
            if (newName !== undefined) updates.name = newName.trim();
            if (description !== undefined) updates.description = description;

            // Validate and include config updates if provided
            if (configInput && typeof configInput === 'object') {
                const validatedConfig = validateConfigFields(configInput);
                if (Object.keys(validatedConfig).length > 0) {
                    updates.config = validatedConfig;
                }
            }

            if (Object.keys(updates).length === 0) {
                return res.status(400).json({ status: 'error', error: 'No updates provided' });
            }

            const presets = await updateServerPreset(currentName, updates);
            res.json({ status: 'ok', presets, message: `Server preset "${currentName}" updated` });
        } catch (error) {
            const status = error.message.includes('built-in') || error.message.includes('not found') || error.message.includes('already exists') ? 400 : 500;
            res.status(status).json({ status: 'error', error: error.message });
        }
    });

    /**
     * DELETE /api/server/presets/:name - Delete a custom server config preset
     */
    app.delete('/api/server/presets/:name', async (req, res) => {
        try {
            const { name } = req.params;
            if (!name) {
                return res.status(400).json({ status: 'error', error: 'Preset name is required' });
            }

            const presets = await deleteServerPreset(name);
            res.json({ status: 'ok', presets, message: `Server preset "${name}" deleted` });
        } catch (error) {
            const status = error.message.includes('built-in') ? 400 : 500;
            res.status(status).json({ status: 'error', error: error.message });
        }
    });

    /**
     * POST /api/models/config - Update model configuration (hidden/pinned/alias)
     */
    app.post('/api/models/config', (req, res) => {
        try {
            const { modelId, config: newModelConfig } = req.body;

            if (!modelId || typeof newModelConfig !== 'object') {
                return res.status(400).json({ status: 'error', error: 'Invalid parameters' });
            }

            // Load current config
            const currentMapping = config.modelMapping || {};

            // Update specific model config
            currentMapping[modelId] = {
                ...currentMapping[modelId],
                ...newModelConfig
            };

            // Save back to main config
            const success = saveConfig({ modelMapping: currentMapping });

            if (success) {
                // Update in-memory config reference
                config.modelMapping = currentMapping;
                res.json({ status: 'ok', modelConfig: currentMapping[modelId] });
            } else {
                throw new Error('Failed to save configuration');
            }
        } catch (error) {
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    // ==========================================
    // Logs API
    // ==========================================

    /**
     * GET /api/logs - Get log history
     */
    app.get('/api/logs', (req, res) => {
        res.json({
            status: 'ok',
            logs: logger.getHistory ? logger.getHistory() : []
        });
    });

    /**
     * GET /api/logs/stream - Stream logs via SSE
     */
    app.get('/api/logs/stream', (req, res) => {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        const sendLog = (log) => {
            res.write(`data: ${JSON.stringify(log)}\n\n`);
        };

        // Send recent history if requested
        if (req.query.history === 'true' && logger.getHistory) {
            const history = logger.getHistory();
            history.forEach(log => sendLog(log));
        }

        // Subscribe to new logs
        if (logger.on) {
            logger.on('log', sendLog);
        }

        // Cleanup on disconnect
        req.on('close', () => {
            if (logger.off) {
                logger.off('log', sendLog);
            }
        });
    });

    // ==========================================
    // Strategy Health API (Developer Mode)
    // ==========================================

    /**
     * GET /api/strategy/health - Get strategy health data for the inspector panel
     * Only available when devMode is enabled
     */
    app.get('/api/strategy/health', (req, res) => {
        try {
            if (!config.devMode) {
                return res.status(403).json({
                    status: 'error',
                    error: 'Developer mode is not enabled'
                });
            }

            const healthData = accountManager.getStrategyHealthData();
            res.json({
                status: 'ok',
                ...healthData
            });
        } catch (error) {
            logger.error('[WebUI] Error fetching strategy health:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    // ==========================================
    // OAuth API
    // ==========================================

    // Safe diagnostics: runtime identity and OAuth callback configuration.
    // No credentials or tokens are returned.
    app.get('/api/diagnostics/runtime', (req, res) => {
        res.json({ status: 'ok', runtime: safeRuntimeInfo() });
    });


    /**
     * GET /api/auth/url - Get OAuth URL to start the flow
     * Uses CLI's OAuth flow (localhost:51121) instead of WebUI's port
     * to match Google OAuth Console's authorized redirect URIs
     */
    app.get('/api/auth/url', async (req, res) => {
        try {
            const loginHint = req.query.email || req.query.login_hint || null;

            // Clean up old flows (> 10 mins)
            const now = Date.now();
            for (const [key, val] of pendingOAuthFlows.entries()) {
                if (now - val.timestamp > 10 * 60 * 1000) {
                    pendingOAuthFlows.delete(key);
                }
            }

            // Use the registered callback URI deterministically. Do not silently
            // generate a URL for one port while listening on another.
            const callbackPort = Number(process.env.OAUTH_CALLBACK_PORT || 51121);
            const redirectUri = `http://localhost:${callbackPort}/oauth-callback`;
            const { url, verifier, state } = getAuthorizationUrl(redirectUri, loginHint);

            // Start the callback server on the same configured port. If that
            // port is occupied, fail instead of silently creating a mismatched
            // Google redirect URI.
            const { promise: serverPromise, abort: abortServer, getPort } = startCallbackServer(state, 600000); // 10 min timeout
            if (getPort() !== callbackPort) {
                abortServer();
                throw new Error(`OAuth callback port ${callbackPort} is unavailable; refusing fallback port ${getPort()} because Google redirect URIs must match exactly`);
            }

            // Store the flow data
            pendingOAuthFlows.set(state, {
                serverPromise,
                abortServer,
                verifier,
                state,
                timestamp: Date.now(),
                status: 'awaiting_callback',
                emailHint: loginHint
            });

            // Start async handler for the OAuth callback
            serverPromise
                .then(async (code) => {
                    try {
                        logger.info('[WebUI] Received OAuth callback, completing flow...');
                        const flow = pendingOAuthFlows.get(state);
                        if (flow) flow.status = 'completing';
                        const accountData = await completeOAuthFlow(code, verifier, redirectUri);

                        // Add or update the account with compound project binding
                        const compoundToken = accountData.refreshToken.includes('||')
                            ? accountData.refreshToken
                            : `${accountData.refreshToken}||aicode-consumers`;

                        await addAccount({
                            email: accountData.email,
                            picture: accountData.picture,
                            refreshToken: compoundToken,
                            projectId: 'aicode-consumers',
                            source: 'oauth'
                        });

                        // Reload AccountManager to pick up the new account
                        await accountManager.reload();

                        const completedFlow = pendingOAuthFlows.get(state);
                        if (completedFlow) {
                            completedFlow.status = 'completed';
                            completedFlow.email = accountData.email;
                            completedFlow.completedAt = Date.now();
                        }
                        logger.success(`[WebUI] Account ${accountData.email} added successfully`);
                    } catch (err) {
                        logger.error('[WebUI] OAuth flow completion error:', err);
                    } finally {
                        setTimeout(() => pendingOAuthFlows.delete(state), 10 * 60 * 1000);
                    }
                })
                .catch((err) => {
                    // Only log if not aborted (manual completion causes this)
                    if (!err.message?.includes('aborted')) {
                        logger.error('[WebUI] OAuth callback server error:', err);
                    }
                    pendingOAuthFlows.delete(state);
                });

            res.json({ status: 'ok', url, state });
        } catch (error) {
            logger.error('[WebUI] Error generating auth URL:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    app.get('/api/auth/status', (req, res) => {
        const state = req.query.state;
        if (!state) return res.status(400).json({ status: 'error', error: 'state is required' });
        const flow = pendingOAuthFlows.get(state);
        if (!flow) return res.json({ status: 'ok', state, phase: 'unknown' });
        res.json({ status: 'ok', state, phase: flow.status || 'awaiting_callback', email: flow.email || null, error: flow.error || null });
    });

    // REMOVED: POST /api/auth/launch-browser (temp-profile swarm browser + CDP password
    // injection via src/auth/cdp-injector.js). Superseded by the always-on Chrome fleet;
    // profile opening now goes through the open_chrome_profile native tool / fleet attach.

    /**
     * POST /api/auth/complete - Complete OAuth with manually submitted callback URL/code
     * Used when auto-callback cannot reach the local server
     */
    app.post('/api/auth/complete', async (req, res) => {
        try {
            const { callbackInput, state } = req.body;

            if (!callbackInput || !state) {
                return res.status(400).json({
                    status: 'error',
                    error: 'Missing callbackInput or state'
                });
            }

            // Find the pending flow
            const flowData = pendingOAuthFlows.get(state);
            if (!flowData) {
                return res.status(400).json({
                    status: 'error',
                    error: 'OAuth flow not found. The account may have been already added via auto-callback. Please refresh the account list.'
                });
            }

            const { verifier, abortServer } = flowData;

            // Extract code from input (URL or raw code)
            const { extractCodeFromInput, completeOAuthFlow } = await import('../auth/oauth.js');
            const { code } = extractCodeFromInput(callbackInput);

            // Complete the OAuth flow
            const callbackPort = Number(process.env.OAUTH_CALLBACK_PORT || 51121);
            const redirectUri = `http://localhost:${callbackPort}/oauth-callback`;
            const accountData = await completeOAuthFlow(code, verifier, redirectUri);

            // Add or update the account. Preserve the managed project binding
            // used by the automatic callback path so manual and automatic OAuth
            // produce the same Antigravity account record.
            const compoundToken = accountData.refreshToken.includes('||')
                ? accountData.refreshToken
                : `${accountData.refreshToken}||aicode-consumers`;
            await addAccount({
                email: accountData.email,
                picture: accountData.picture,
                refreshToken: compoundToken,
                projectId: accountData.projectId || 'aicode-consumers',
                source: 'oauth'
            });

            // Reload AccountManager to pick up the new account
            await accountManager.reload();

            // Abort the callback server since manual completion succeeded
            if (abortServer) {
                abortServer();
            }

            // Clean up
            pendingOAuthFlows.delete(state);

            logger.success(`[WebUI] Account ${accountData.email} added via manual callback`);

            res.json({
                status: 'ok',
                email: accountData.email,
                message: `Account ${accountData.email} added successfully`
            });
        } catch (error) {
            logger.error('[WebUI] Manual OAuth completion error:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * Note: /oauth/callback route removed
     * OAuth callbacks are now handled by the temporary server on port 51121
     * (same as CLI) to match Google OAuth Console's authorized redirect URIs
     */

    logger.info('[WebUI] Mounted at /');
}
