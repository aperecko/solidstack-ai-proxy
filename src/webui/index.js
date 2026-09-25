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
import { fileURLToPath } from 'url';
import express from 'express';
import { getPublicConfig, saveConfig, config } from '../config.js';
import { DEFAULT_PORT, ACCOUNT_CONFIG_PATH, MAX_ACCOUNTS, DEFAULT_PRESETS, DEFAULT_SERVER_PRESETS, getSwarmLoginUrl } from '../constants.js';

const OMNI_SYNC_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../account-manager/omniroute_sync.py');
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
import { clearAccountBrowserContext } from '../account-manager/logout.js';

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

    // Auto-assign corporateFootprint if not explicitly provided
    if (!accountData.corporateFootprint && accountData.email) {
        if (accountData.email.endsWith('@adamassist.com')) {
            accountData.corporateFootprint = {
                role: 'Swarm Worker',
                region: 'US-Detroit',
                egressNode: 'dtw.socks.privado.io'
            };
        } else if (accountData.email.endsWith('@reseller.mysolidstate.ca')) {
            accountData.corporateFootprint = {
                role: 'Swarm Worker',
                region: 'US-Dallas',
                egressNode: 'dfw.socks.privado.io'
            };
        } else {
            accountData.corporateFootprint = {
                role: 'Personal',
                region: 'Local',
                egressNode: 'local'
            };
        }
    }

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

    // Direct In-Line Sync to OmniRoute SQLite provider_connections
    try {
        const { execSync } = await import('child_process');
        execSync(`python3 "${OMNI_SYNC_SCRIPT}" "${accountData.email}"`, { stdio: 'inherit' });
        logger.info(`[WebUI] Direct In-Line Sync: Synced ${accountData.email} to OmniRoute SQLite.`);
    } catch (e) {
        logger.warn(`[WebUI] OmniRoute direct sync note for ${accountData.email}: ${e.message}`);
    }
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
        // Vite emits root-relative asset URLs. Mirror the built asset directory
        // under the gateway root so the prefixed control plane can load its CSS
        // and JS without changing the generated bundle.
        app.use('/assets', express.static(path.join(distPath, 'assets')));
    }

    // Legacy Commander assets and views remain the default dashboard.
    app.use(express.static(path.join(dirname, '../public')));

    // React control-plane deep links resolve under its explicit prefix.
    if (fs.existsSync(distPath)) {
        app.get('/control-plane/*', (req, res) => res.sendFile(path.join(distPath, 'index.html')));
    }
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
     * GET /monitor - Redirect to OmniRoute dashboard (full fleet management)
     * OmniRoute dashboard: http://127.0.0.1:20128/dashboard
     */
    app.get('/monitor', (req, res) => {
        res.redirect('http://127.0.0.1:20128/dashboard');
    });
    app.get('/dashboard', (req, res) => {
        res.redirect('http://127.0.0.1:20128/dashboard');
    });
    logger.info('[WebUI] Mounted at /');
}
