/**
 * OmniRoute Bridge — connects ai-proxy's GUI Interceptor to OmniRoute's account pool.
 *
 * Instead of using ai-proxy's local 3-account AccountManager for Google Cloud Code
 * requests, the bridge queries OmniRoute's management API for the best available
 * Antigravity account (from 34 accounts) and returns a fresh OAuth access token.
 *
 * Falls back to the local AccountManager if OmniRoute is unreachable.
 */

import { logger } from './utils/logger.js';

const OMNIROUTE_BASE = process.env.OMNIROUTE_BASE_URL || 'http://127.0.0.1:20128';
const OMNIROUTE_KEY  = process.env.OMNIROUTE_API_KEY  || 'sk-omni-c8786fccb1e71c262854f247fc80c52be27722de31ed0d45';

// Cache for provider connections (refresh every 30s)
let _connectionsCache = null;
let _connectionsCacheTime = 0;
const CACHE_TTL_MS = 30_000;

// Token expiration safety buffer: refresh/skip tokens expiring within 10 minutes
const TOKEN_EXPIRY_BUFFER_MS = 600_000;

// Track per-connection usage for round-robin / LRU selection
const _lastUsed    = new Map();  // connectionId → timestamp
const _failureCounts = new Map(); // connectionId → consecutive failure count

// Bridge health tracking
let _bridgeHealthy = true;
let _lastHealthCheck = 0;
let _consecutiveBridgeFailures = 0;
const MAX_BRIDGE_FAILURES = 3; // Fall back to local pool after 3 consecutive failures

/**
 * Fetch all Antigravity connections from OmniRoute.
 * Caches results for CACHE_TTL_MS to avoid hammering the API.
 */
async function fetchConnections(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && _connectionsCache && (now - _connectionsCacheTime) < CACHE_TTL_MS) {
        return _connectionsCache;
    }

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);

        const res = await fetch(`${OMNIROUTE_BASE}/api/providers`, {
            headers: { 'Authorization': `Bearer ${OMNIROUTE_KEY}` },
            signal: controller.signal,
        });
        clearTimeout(timeout);

        if (!res.ok) {
            throw new Error(`OmniRoute API returned ${res.status}`);
        }

        const data = await res.json();
        // /api/providers returns { connections: [...] } — no accessToken in list
        // We cache connections for health/LRU tracking; tokens are handled by OmniRoute internally
        const connections = (data.connections || data || [])
            .filter(c => c.provider === 'antigravity' && c.isActive && c.testStatus === 'active');

        _connectionsCache = connections;
        _connectionsCacheTime = now;
        _bridgeHealthy = true;
        _consecutiveBridgeFailures = 0;

        return connections;
    } catch (err) {
        _consecutiveBridgeFailures++;
        if (_consecutiveBridgeFailures >= MAX_BRIDGE_FAILURES) {
            _bridgeHealthy = false;
        }
        logger.warn(`[OmniRoute Bridge] Failed to fetch connections (attempt ${_consecutiveBridgeFailures}): ${err.message}`);
        return _connectionsCache || []; // Return stale cache if available
    }
}

/**
 * Select the best Antigravity account from OmniRoute's pool.
 *
 * Strategy: health-aware least-recently-used (LRU) selection.
 *  1. Filter out accounts in excludeAccounts
 *  2. Filter out accounts with expired tokens
 *  3. Filter out accounts with high failure counts
 *  4. Pick the account with the oldest lastUsed timestamp (spread load evenly)
 *
 * @param {string} model - The model being requested (unused for now, could filter by model support)
 * @param {string[]} excludeAccounts - Emails to exclude (from retry loop)
 * @returns {{ account: { email, connectionId, accessToken, projectId, tier }, source: 'omniroute' } | null}
 */
async function selectAccount(model, excludeAccounts = []) {
    if (!_bridgeHealthy) {
        return null; // Signal caller to fall back to local pool
    }

    const connections = await fetchConnections();
    if (!connections || connections.length === 0) {
        return null;
    }

    const now = Date.now();
    const excludeSet = new Set(excludeAccounts.map(e => e.toLowerCase()));

    // Filter candidates
    const candidates = connections.filter(c => {
        // Skip excluded accounts
        if (excludeSet.has((c.email || c.name || '').toLowerCase())) return false;

        // Skip accounts without access tokens
        if (!c.accessToken) return false;

        // Skip accounts with expired tokens (with 10-min safety buffer)
        if (c.tokenExpiresAt) {
            const expiresAt = new Date(c.tokenExpiresAt).getTime();
            if (expiresAt < now + TOKEN_EXPIRY_BUFFER_MS) return false;
        }

        // Skip accounts with too many consecutive failures
        const failures = _failureCounts.get(c.id) || 0;
        if (failures >= 5) return false;

        // Skip accounts with high backoff
        if (c.backoffLevel >= 3) return false;

        return true;
    });

    if (candidates.length === 0) {
        logger.warn(`[OmniRoute Bridge] No eligible accounts (${connections.length} total, ${excludeAccounts.length} excluded)`);
        return null;
    }

    // Sort by: lowest failure count → least recently used → lowest backoff
    candidates.sort((a, b) => {
        const failA = _failureCounts.get(a.id) || 0;
        const failB = _failureCounts.get(b.id) || 0;
        if (failA !== failB) return failA - failB;

        const usedA = _lastUsed.get(a.id) || 0;
        const usedB = _lastUsed.get(b.id) || 0;
        if (usedA !== usedB) return usedA - usedB;

        return (a.backoffLevel || 0) - (b.backoffLevel || 0);
    });

    const selected = candidates[0];
    _lastUsed.set(selected.id, now);

    // Parse provider-specific data for tier info
    let tier = 'pro';
    try {
        const psd = typeof selected.providerSpecificData === 'string'
            ? JSON.parse(selected.providerSpecificData)
            : selected.providerSpecificData;
        tier = psd?.subscriptionTier || psd?.tier || 'pro';
    } catch {}

    return {
        account: {
            email: selected.email || selected.name,
            connectionId: selected.id,
            accessToken: selected.accessToken,
            projectId: selected.projectId || 'aicode-consumers',
            tier,
        },
        source: 'omniroute',
    };
}

/**
 * Report a successful request outcome to OmniRoute (via cache update).
 * Resets failure count for the connection.
 */
function reportSuccess(connectionId) {
    _failureCounts.delete(connectionId);
}

/**
 * Report a failed request outcome.
 * Increments failure count and optionally forces a cache refresh.
 */
function reportFailure(connectionId, errorType) {
    const current = _failureCounts.get(connectionId) || 0;
    _failureCounts.set(connectionId, current + 1);

    // Force cache refresh on rate limit or auth errors so we get updated health data
    if (errorType === 'rate_limit' || errorType === 'auth_error') {
        _connectionsCacheTime = 0; // Invalidate cache
    }

    logger.info(`[OmniRoute Bridge] Reported failure for ${connectionId} (type=${errorType}, count=${current + 1})`);
}

/**
 * Check if the OmniRoute bridge is healthy and usable.
 */
function isHealthy() {
    if (process.env.OMNIROUTE_DISABLED === '1' || process.env.OMNIROUTE_DISABLED === 'true') {
        return false;
    }
    return _bridgeHealthy;
}

/**
 * Get all available accounts from OmniRoute (for /api/accounts/available).
 */
async function getAvailableAccounts() {
    const connections = await fetchConnections();
    return connections.map(c => ({
        email: c.email || c.name,
        connectionId: c.id,
        isActive: c.isActive,
        testStatus: c.testStatus,
        backoffLevel: c.backoffLevel || 0,
        hasToken: !!c.accessToken,
        tier: (() => {
            try {
                const psd = typeof c.providerSpecificData === 'string'
                    ? JSON.parse(c.providerSpecificData)
                    : c.providerSpecificData;
                return psd?.subscriptionTier || psd?.tier || 'unknown';
            } catch { return 'unknown'; }
        })(),
    }));
}

/**
 * Get summary stats for the OmniRoute pool.
 */
async function getPoolSummary() {
    const connections = await fetchConnections();
    const now = Date.now();
    const active = connections.filter(c => c.isActive && c.testStatus === 'active');
    // OmniRoute manages credentials and OAuth refresh tokens internally in SQLite;
    // connections are valid worker routes when active and not in backoff cooldown.
    const withToken = active;
    const healthy = withToken.filter(c => {
        if (c.tokenExpiresAt && new Date(c.tokenExpiresAt).getTime() < now + TOKEN_EXPIRY_BUFFER_MS) return false;
        if (c.backoffLevel >= 3) return false;
        return true;
    });

    return {
        source: 'omniroute',
        baseUrl: OMNIROUTE_BASE,
        bridgeHealthy: _bridgeHealthy,
        total: connections.length,
        active: active.length,
        withToken: withToken.length,
        healthy: healthy.length,
        cacheAge: _connectionsCacheTime ? Math.round((now - _connectionsCacheTime) / 1000) : null,
    };
}

/**
 * Force a token refresh on all accounts via OmniRoute's test-batch API.
 */
async function refreshAllTokens() {
    try {
        const res = await fetch(`${OMNIROUTE_BASE}/api/providers/test-batch`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${OMNIROUTE_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ mode: 'provider', providerId: 'antigravity' }),
        });
        const data = await res.json();
        // Invalidate cache so next selectAccount() gets fresh data
        _connectionsCacheTime = 0;
        logger.info(`[OmniRoute Bridge] Token refresh complete: ${JSON.stringify(data?.summary || data)}`);
        return data;
    } catch (err) {
        logger.error(`[OmniRoute Bridge] Token refresh failed: ${err.message}`);
        throw err;
    }
}

// ── Recent Activity & Worker Telemetry ──────────────────────────────────────
let _lastActivity = {
    email: 'adamperecko@gmail.com',
    badge: '[adam·p] 🛡️',
    model: 'gemini-3.8-flash-high',
    timestamp: Date.now(),
    mode: 'Hybrid LRU + Quota-Aware',
    source: 'omniroute',
    statusCode: 200,
    latencyMs: 0
};

/**
 * Format email into a compact, distinct badge:
 *   - 000004@reseller.mysolidstate.ca -> [RS#004]
 *   - 01@adamassist.com               -> [AA#01]
 *   - assistaius@gmail.com            -> [assist·us]
 *   - adamtechnicalsolutions@gmail.com-> [adamtech]
 *   - apps000123000@gmail.com         -> [apps·123]
 *   - aptsoultuions@gmail.com         -> [aptsolutions]
 *   - adamperecko@gmail.com           -> [adam·p] 🛡️
 */
export function formatAccountBadge(email) {
    if (!email) return '[unknown]';
    const lower = email.toLowerCase().trim();
    
    // Reseller Swarm: 000001 - 000296
    const rsMatch = lower.match(/^(\d{4,6})@reseller/);
    if (rsMatch) {
        const num = parseInt(rsMatch[1], 10);
        return `[RS#${String(num).padStart(3, '0')}]`;
    }

    // AdamAssist Swarm: 01 - 48
    const aaMatch = lower.match(/^(\d{2})@adamassist/);
    if (aaMatch) {
        return `[AA#${aaMatch[1]}]`;
    }

    // MySolidState accounts
    if (lower.startsWith('adam@mysolidstate')) return '[adam·mss]';
    if (lower.startsWith('apps@reseller')) return '[reseller·admin]';
    if (lower.startsWith('adam@adamassist')) return '[adam·aa]';

    // Personal & Family Pro accounts
    if (lower.includes('assistaius')) return '[assist·us]';
    if (lower.includes('adamtechnicalsolutions')) return '[adamtech]';
    if (lower.includes('apps000123000')) return '[apps·123]';
    if (lower.includes('aptsoultuions')) return '[aptsolutions]';
    if (lower.includes('adampps')) return '[adampps]';
    if (lower.includes('haliburtonarcher')) return '[haliburton]';
    if (lower.includes('prettypaws')) return '[prettypaws]';
    if (lower.includes('adamperecko')) return '[adam·p] 🛡️';

    const userPart = lower.split('@')[0];
    return `[${userPart.slice(0, 10)}]`;
}

/**
 * Record worker activity for live HUD rendering.
 */
export function recordActivity({ email, model, mode = 'Hybrid LRU + Quota-Aware', source = 'omniroute', statusCode = 200, latencyMs = 0 }) {
    _lastActivity = {
        email: email || 'unknown',
        badge: formatAccountBadge(email),
        model: model || 'auto',
        timestamp: Date.now(),
        mode,
        source,
        statusCode,
        latencyMs
    };
}

export function getLastActivity() {
    return _lastActivity;
}


/**
 * createBridgedAccountManager — wraps the local AccountManager with a JS Proxy
 * that intercepts selectAccount() to try OmniRoute's pool first.
 *
 * Used for /v1/messages (AG chat, claude-code, subagents) so that those requests
 * also route through OmniRoute's 33-account pool instead of the local 3-account pool.
 *
 * The proxy is transparent — all other AccountManager methods pass through unchanged.
 *
 * How it works:
 *   1. On selectAccount(model, opts): try OmniRoute bridge first.
 *      If OmniRoute returns an account, we return a synthetic account object
 *      that carries the OmniRoute token internally.
 *   2. On getTokenForAccount(account): if the account has ._omnirouteToken,
 *      return it directly (no Google OAuth call needed — OmniRoute already did it).
 *   3. Everything else (getAvailableAccounts, notifySuccess, markRateLimited, etc.)
 *      delegates to the real accountManager unchanged.
 */
function createBridgedAccountManager(accountManager) {
    // Map from synthetic account object identity → OmniRoute connection data
    // We use WeakMap so synthetic accounts are GC'd when no longer in scope
    const omnirouteAccounts = new WeakMap();

    return new Proxy(accountManager, {
        get(target, prop) {
            // Intercept selectAccount to try OmniRoute first
            if (prop === 'selectAccount') {
                return function(model, opts = {}) {
                    // Return a thenable so callers can either await it or use .account directly
                    // The cloudcode module calls: const selected = accountManager.selectAccount(...)
                    // and then uses selected.account — so we need to return the same shape.
                    // We use a synchronous wrapper that schedules the async OmniRoute call
                    // and falls back synchronously to the local pool.
                    //
                    // Since message-handler.js does:
                    //   const selected = accountManager.selectAccount(model, opts);
                    //   ... (sync checks on selected.account) ...
                    //   const token = await accountManager.getTokenForAccount(account);
                    //
                    // We need selectAccount to be synchronous (returns {account}).
                    // The trick: pre-fetch from OmniRoute on a best-effort basis;
                    // if the cache is warm (30s TTL), we get the account synchronously.
                    // If cache is cold, fall back to local immediately and OmniRoute
                    // will warm up for the next call.

                    if (!_bridgeHealthy || !_connectionsCache) {
                        // Bridge unhealthy or cache cold → use local pool
                        return target.selectAccount.call(target, model, opts);
                    }

                    const now = Date.now();
                    const excludeSet = new Set((opts.excludeAccounts || []).map(e => e?.toLowerCase?.()));

                    // Try to find a candidate synchronously from warm cache
                    const candidates = _connectionsCache.filter(c => {
                        if (excludeSet.has((c.email || c.name || '').toLowerCase())) return false;
                        if (!c.accessToken) return false;
                        if (c.tokenExpiresAt && new Date(c.tokenExpiresAt).getTime() < now + TOKEN_EXPIRY_BUFFER_MS) return false;
                        const failures = _failureCounts.get(c.id) || 0;
                        if (failures >= 5) return false;
                        if (c.backoffLevel >= 3) return false;
                        return true;
                    }).sort((a, b) => {
                        const fA = _failureCounts.get(a.id) || 0;
                        const fB = _failureCounts.get(b.id) || 0;
                        if (fA !== fB) return fA - fB;
                        return (_lastUsed.get(a.id) || 0) - (_lastUsed.get(b.id) || 0);
                    });

                    if (candidates.length === 0) {
                        // No OmniRoute candidate → fall back to local pool
                        return target.selectAccount.call(target, model, opts);
                    }

                    const conn = candidates[0];
                    _lastUsed.set(conn.id, now);

                    // Parse tier
                    let tier = 'pro';
                    try {
                        const psd = typeof conn.providerSpecificData === 'string'
                            ? JSON.parse(conn.providerSpecificData)
                            : conn.providerSpecificData;
                        tier = psd?.subscriptionTier || psd?.tier || 'pro';
                    } catch {}

                    // Synthesize an account object compatible with AccountManager's interface
                    const syntheticAccount = {
                        email: conn.email || conn.name,
                        enabled: true,
                        isInvalid: false,
                        subscription: { tier },
                        _omnirouteToken: conn.accessToken,
                        _omnirouteConnectionId: conn.id,
                        // Mirror fields the cloudcode module inspects
                        source: 'omniroute',
                        healthScore: 100 - ((conn.backoffLevel || 0) * 20),
                    };

                    // Store OmniRoute connection data keyed to this account object
                    omnirouteAccounts.set(syntheticAccount, conn.id);

                    logger.info(`[OmniRoute Bridge] /v1/messages: selected ${syntheticAccount.email} (model: ${model || 'auto'})`);
                    return { account: syntheticAccount };
                };
            }

            // Intercept getTokenForAccount — return OmniRoute token if synthetic account
            if (prop === 'getTokenForAccount') {
                return async function(account) {
                    if (account?._omnirouteToken) {
                        // Report this as a "use" so success/failure tracking works
                        return account._omnirouteToken;
                    }
                    // Not an OmniRoute account — delegate to local
                    return target.getTokenForAccount.call(target, account);
                };
            }

            // Intercept notifySuccess to also report to OmniRoute bridge
            if (prop === 'notifySuccess') {
                return function(account, model, details) {
                    if (account?._omnirouteConnectionId) {
                        reportSuccess(account._omnirouteConnectionId);
                    }
                    return target.notifySuccess?.call(target, account, model, details);
                };
            }

            // Intercept markRateLimited to also report failure to OmniRoute
            if (prop === 'markRateLimited') {
                return function(email, cooldownMs, model) {
                    // Find connectionId for this email in cache
                    const conn = _connectionsCache?.find(c => c.email === email || c.name === email);
                    if (conn) {
                        reportFailure(conn.id, 'rate_limit');
                    }
                    return target.markRateLimited?.call(target, email, cooldownMs, model);
                };
            }

            // All other methods/properties pass through to real accountManager
            const value = target[prop];
            if (typeof value === 'function') {
                return value.bind(target);
            }
            return value;
        }
    });
}

export const OMNIROUTE_MODEL_MAP = {
    // ── Claude Family ──
    'claude-sonnet-4-6': 'antigravity/claude-sonnet-4-6',
    'claude-sonnet-4-6-high': 'antigravity/claude-sonnet-4-6-high',
    'claude-sonnet-4-6-medium': 'antigravity/claude-sonnet-4-6-medium',
    'claude-sonnet-4-6-low': 'antigravity/claude-sonnet-4-6-low',
    'claude-opus-4-6-thinking': 'antigravity/claude-opus-4-6-thinking',
    'claude-opus-4-6-thinking-high': 'antigravity/claude-opus-4-6-thinking-high',
    'claude-opus-4-6-thinking-medium': 'antigravity/claude-opus-4-6-thinking-medium',
    'claude-opus-4-6-thinking-low': 'antigravity/claude-opus-4-6-thinking-low',
    'claude-3-5-sonnet-20241022': 'antigravity/claude-sonnet-4-6',
    'claude-3-5-haiku-20241022': 'antigravity/gemini-3.7-flash-medium',

    // ── Gemini 3.8 / 3.7 Flash Variants ──
    'gemini-3.8-flash-high': 'antigravity/gemini-3.7-flash-high',
    'gemini-3.8-flash-medium': 'antigravity/gemini-3.7-flash-medium',
    'gemini-3.8-flash-low': 'antigravity/gemini-3.7-flash-low',
    'gemini-3.8-flash-tiered': 'antigravity/gemini-3.7-flash-tiered',
    'gemini-3.7-flash-high': 'antigravity/gemini-3.7-flash-high',
    'gemini-3.7-flash-medium': 'antigravity/gemini-3.7-flash-medium',
    'gemini-3.7-flash-low': 'antigravity/gemini-3.7-flash-low',
    'gemini-3.7-flash-tiered': 'antigravity/gemini-3.7-flash-tiered',

    // ── Gemini 3.6 / 3.5 Flash Variants ──
    'gemini-3.6-flash-high': 'antigravity/gemini-3.7-flash-high',
    'gemini-3.6-flash-medium': 'antigravity/gemini-3.7-flash-medium',
    'gemini-3.6-flash-low': 'antigravity/gemini-3.7-flash-low',
    'gemini-3.6-flash-tiered': 'antigravity/gemini-3.7-flash-tiered',
    'gemini-3.5-flash-low': 'antigravity/gemini-3.7-flash-low',
    'gemini-3.5-flash-lite': 'antigravity/gemini-3.1-flash-lite',
    'gemini-3.5-flash-extra-low': 'antigravity/gemini-3.1-flash-lite',

    // ── Gemini Pro & Agent Models ──
    'gemini-3.1-pro-high': 'antigravity/gemini-3.1-pro-low',
    'gemini-3.1-pro-low': 'antigravity/gemini-3.1-pro-low',
    'gemini-2.5-pro': 'antigravity/gemini-3.1-pro-low',
    'gemini-pro-agent': 'antigravity/gemini-pro-agent',

    // ── Gemini Lite / Fast / Image Models ──
    'gemini-3.1-flash-lite': 'antigravity/gemini-3.1-flash-lite',
    'gemini-3.1-flash-image': 'antigravity/gemini-3.1-flash-image',
    'gemini-3-flash': 'antigravity/gemini-3.7-flash-medium',
    'gemini-3-flash-agent': 'antigravity/gemini-pro-agent',
    'gemini-2.5-flash': 'antigravity/gemini-3.7-flash-medium',
    'gemini-2.5-flash-lite': 'antigravity/gemini-3.1-flash-lite',
    'gemini-2.5-flash-thinking': 'antigravity/gemini-3.7-flash-high',
    'fcc-fast': 'antigravity/gemini-3.1-flash-lite',

    // ── Open Weights / OSS Models ──
    'gpt-oss-120b-medium': 'antigravity/gpt-oss-120b-medium',
    'gemma-4-26b-a4b': 'auto/gemma',
    'gemma-4-26b-a4b-it': 'auto/gemma',

    // ── Auto Combos ──
    'auto': 'antigravity/gemini-3.7-flash-medium',
    'auto/gemini': 'antigravity/gemini-3.7-flash-medium',
    'auto/best-coding': 'antigravity/claude-sonnet-4-6',
    'auto/best-fast': 'antigravity/gemini-3.7-flash-medium',
    'auto/best-reasoning': 'antigravity/claude-opus-4-6-thinking'
};

/**
 * Resolves a requested model name from AG Desktop to an OmniRoute provider model.
 * @param {string} model - Requested model name
 * @returns {string} Fully qualified OmniRoute model ID
 */
export function resolveOmniRouteModel(model) {
    if (!model) return 'auto/gemini';
    if (model.startsWith('antigravity/') || model.startsWith('auto/') || model.startsWith('dva/')) {
        return model;
    }
    if (OMNIROUTE_MODEL_MAP[model]) {
        return OMNIROUTE_MODEL_MAP[model];
    }
    const lower = model.toLowerCase();
    if (lower.includes('opus')) return 'antigravity/claude-opus-4-6-thinking';
    if (lower.includes('sonnet')) return 'antigravity/claude-sonnet-4-6';
    if (lower.includes('120b') || lower.includes('oss')) return 'antigravity/gpt-oss-120b-medium';
    if (lower.includes('pro')) return 'antigravity/gemini-3.1-pro-low';
    if (lower.includes('lite')) return 'antigravity/gemini-3.1-flash-lite';
    if (lower.includes('flash') || lower.includes('gemini')) return 'antigravity/gemini-3.7-flash-medium';
    return `antigravity/${model}`;
}

export const omnirouteBridge = {
    selectAccount,
    reportSuccess,
    reportFailure,
    isHealthy,
    getAvailableAccounts,
    getPoolSummary,
    refreshAllTokens,
    fetchConnections,
    createBridgedAccountManager,
    resolveOmniRouteModel,
    recordActivity,
    getLastActivity,
    formatAccountBadge,
    modelMap: OMNIROUTE_MODEL_MAP,
};

export default omnirouteBridge;
