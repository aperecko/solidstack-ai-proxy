/**
 * Express Server - Anthropic-compatible API
 * Proxies to Google Cloud Code via Antigravity
 * Supports multi-account load balancing
 */

import express from 'express';
import cors from 'cors';
import path from 'path';
import https from 'https';
import { fileURLToPath } from 'url';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { sendMessage, sendMessageStream, listModels, fetchAvailableModels, getModelQuotas, getSubscriptionTier, isValidModel } from './cloudcode/index.js';
import { buildFallbackMap, buildPresets } from './constants.js';
import { initFallbackMap, getFallbackChain } from './fallback-config.js';
import { logRoutingTelemetry } from './cloudcode/routing-logger.js';
import { mountWebUI } from './webui/index.js';
import { config } from './config.js';
import { globalThrottle } from './utils/throttle.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import { forceRefresh } from './auth/token-extractor.js';
import { resolveTokenToEmail } from './auth/token-resolver.js';
import { REQUEST_BODY_LIMIT } from './constants.js';
import { AccountManager } from './account-manager/index.js';
import { clearThinkingSignatureCache } from './format/signature-cache.js';
import { formatDuration } from './utils/helpers.js';
import { logger } from './utils/logger.js';
import usageStats from './modules/usage-stats.js';
import { mountOpenAICompat, mountResponsesCompat } from './openai-compat.js';
import { createCommanderRouter } from './commander-api.js';
import {
    logConversation,
    initStreamingLog,
    accumulateStreamEvent,
    finalizeStreamingLog,
    createConversationRouter
} from './conversation-logger.js';

// Parse fallback flag directly from command line args to avoid circular dependency
const args = process.argv.slice(2);
const FALLBACK_ENABLED = args.includes('--fallback') || process.env.FALLBACK === 'true';

// Parse --strategy flag (format: --strategy=sticky or --strategy sticky)
let STRATEGY_OVERRIDE = null;
for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--strategy=')) {
        STRATEGY_OVERRIDE = args[i].split('=')[1];
    } else if (args[i] === '--strategy' && args[i + 1]) {
        STRATEGY_OVERRIDE = args[i + 1];
    }
}

const app = express();

// ─── Pre-create stable Google API proxy middleware instances ──────────────────
// http-proxy-middleware must be instantiated once at startup, not per-request.
// We create one proxy for each Google Cloud Code host we intercept.
const GOOGLE_PROXY_HOSTS = [
    'cloudcode-pa.googleapis.com',
    'daily-cloudcode-pa.googleapis.com',
];
const googleProxies = {};
for (const googleHost of GOOGLE_PROXY_HOSTS) {
    googleProxies[googleHost] = createProxyMiddleware({
        target: `https://${googleHost}`,
        changeOrigin: true,
        secure: true,
        on: {
            error: (err, req, res) => {
                logger.error(`[GUI Interceptor] Proxy error for ${googleHost}: ${err.message}`);
                if (!res.headersSent) {
                    res.status(502).json({ error: `Bad Gateway (${googleHost})` });
                }
            }
        }
    });
}

// Disable x-powered-by header for security
app.disable('x-powered-by');

// Initialize account manager (will be fully initialized on first request or startup)
export const accountManager = new AccountManager();

// Track initialization status
let isInitialized = false;
let initError = null;
let initPromise = null;

/**
 * Ensure account manager is initialized (with race condition protection)
 */
async function ensureInitialized() {
    if (isInitialized) return;

    // If initialization is already in progress, wait for it
    if (initPromise) return initPromise;

    initPromise = (async () => {
        try {
            await accountManager.initialize(STRATEGY_OVERRIDE);
            isInitialized = true;
            const status = accountManager.getStatus();
            logger.success(`[Server] Account pool initialized: ${status.summary}`);

            // Initialize dynamic model config (non-blocking)
            initDynamicModelConfig().catch(err => {
                logger.warn(`[Server] Dynamic model config init failed (non-fatal): ${err.message}`);
            });
        } catch (error) {
            initError = error;
            initPromise = null; // Allow retry on failure
            logger.error('[Server] Failed to initialize account manager:', error.message);
            throw error;
        }
    })();

    return initPromise;
}

// ─── Native Antigravity/Gemini GUI Interceptor ──────────────────────────────
// Mounted BEFORE express.json() so the proxy can stream raw binary/JSON bodies.
// Uses pre-created stable proxy instances (googleProxies) — NOT per-request creation.

// AI request bodies are buffered so the requested model can be extracted from
// the JSON body (v1internal:generateContent carries the model in the body) and
// so exhausted models can be transparently rewritten to a fallback model.
const MAX_INTERCEPT_BODY_BYTES = 50 * 1024 * 1024; // Match REQUEST_BODY_LIMIT (50mb)

function readRequestBody(req, maxBytes = MAX_INTERCEPT_BODY_BYTES) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let total = 0;
        let finished = false;
        req.on('data', (chunk) => {
            total += chunk.length;
            if (total > maxBytes) {
                finished = true;
                reject(new Error(`Request body exceeds ${maxBytes} bytes`));
                req.removeAllListeners('data');
                req.removeAllListeners('end');
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (finished) return;
            resolve(Buffer.concat(chunks));
        });
        req.on('error', reject);
    });
}

// Manual forward for AI requests whose body we buffered. Uses native https so
// the global DNS patch (src/index.js) still applies, consistent with httpxy.
function forwardToGoogle(hostName, req, res, bodyText) {
    const headers = { ...req.headers };
    delete headers['transfer-encoding'];
    delete headers['connection'];
    headers['content-length'] = Buffer.byteLength(bodyText);
    headers['host'] = hostName;

    const proxyReq = https.request({
        hostname: hostName,
        port: 443,
        method: req.method,
        path: req.url || req.originalUrl || '/',
        headers,
    }, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, sanitizeResponseHeaders(proxyRes.headers));
        proxyRes.pipe(res);
        proxyRes.on('error', (err) => {
            logger.error(`[GUI Interceptor] Response stream error from ${hostName}: ${err.message}`);
            res.destroy();
        });
    });

    // Mirror httpxy: tear down the upstream request if the client disconnects.
    res.on('close', () => {
        if (!res.writableFinished) proxyReq.destroy();
    });

    proxyReq.on('error', (err) => {
        logger.error(`[GUI Interceptor] Forward error to ${hostName}: ${err.message}`);
        if (!res.headersSent) {
            res.status(502).json({ error: `Bad Gateway (${hostName})` });
        } else {
            res.destroy();
        }
    });

    if (bodyText && bodyText.length > 0) {
        proxyReq.write(bodyText);
    }
    proxyReq.end();
}

// Synthetic healthy response for /v1internal:retrieveUserQuotaSummary. Mirrors the
// real shape (groups → buckets) with every bucket at full availability and a future
// reset, so AG's "model usage" panel never shows account-specific exhaustion.
function handleQuotaSummarySynthesis(req, res) {
    const now = Date.now();
    const toIso = (ms) => new Date(ms).toISOString();
    const resetWeekly = toIso(now + 7 * 24 * 3600 * 1000);
    const reset5h = toIso(now + 5 * 3600 * 1000);
    const bucketDesc = 'Managed by the SolidStack proxy: quota is aggregated across all pooled accounts, so usage is not tied to a single account.';
    const payload = {
        groups: [
            {
                buckets: [
                    { bucketId: 'gemini-weekly', displayName: 'Weekly Limit', window: 'weekly', resetTime: resetWeekly, description: bucketDesc, remainingFraction: 1.0 },
                    { bucketId: 'gemini-5h', displayName: 'Five Hour Limit', window: '5h', resetTime: reset5h, description: bucketDesc, remainingFraction: 1.0 },
                ],
                displayName: 'Gemini Models',
                description: 'Models within this group: Gemini Flash, Gemini Pro',
            },
            {
                buckets: [
                    { bucketId: '3p-weekly', displayName: 'Weekly Limit', window: 'weekly', resetTime: resetWeekly, description: bucketDesc, remainingFraction: 1.0 },
                    { bucketId: '3p-5h', displayName: 'Five Hour Limit', window: '5h', resetTime: reset5h, description: bucketDesc, remainingFraction: 1.0 },
                ],
                displayName: 'Claude and GPT models',
                description: 'Models within this group: Claude Opus, Claude Sonnet, GPT-OSS',
            },
        ],
        description: 'Within each group, models share a weekly limit and a 5-hour limit. Quota is consumed proportionally to the cost of the tokens. Managed by the SolidStack proxy.',
    };
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json(payload);
}

// Hop-by-hop headers must not be forwarded on responses; Node rejects a response
// carrying both `content-length` and `transfer-encoding` ("Content-Length can't be
// present with Transfer-Encoding"). The caller sets the final length itself.
function sanitizeResponseHeaders(headers, outLength) {
    const out = {};
    for (const [k, v] of Object.entries(headers || {})) {
        const lk = k.toLowerCase();
        if (['transfer-encoding', 'connection', 'keep-alive', 'proxy-connection', 'upgrade', 'trailer', 'te'].includes(lk)) continue;
        out[k] = v;
    }
    if (outLength != null) out['content-length'] = outLength;
    return out;
}

// Manual forward for fetchAvailableModels: extract the response, resolve every
// model's quotaInfo to healthy (remainingFraction = 1.0), and re-send so AG's
// model availability display is not locked to whichever pooled account served it.
function forwardAndNeutralizeQuota(hostName, req, res, bodyText) {
    const headers = { ...req.headers };
    delete headers['transfer-encoding'];
    delete headers['connection'];
    headers['content-length'] = Buffer.byteLength(bodyText);
    headers['accept-encoding'] = 'identity';
    headers['host'] = hostName;

    const proxyReq = https.request({
        hostname: hostName,
        port: 443,
        method: req.method,
        path: req.url || req.originalUrl || '/',
        headers,
    }, (proxyRes) => {
        const chunks = [];
        proxyRes.on('data', (c) => chunks.push(c));
        proxyRes.on('error', (err) => {
            logger.error(`[GUI Interceptor] Response stream error from ${hostName}: ${err.message}`);
            res.destroy();
        });
        proxyRes.on('end', () => {
            const raw = Buffer.concat(chunks);
            let out = raw;
            let neutralized = false;
            try {
                const data = JSON.parse(raw.toString('utf8'));
                if (data && data.models) {
                    for (const modelData of Object.values(data.models)) {
                        if (modelData && modelData.quotaInfo && typeof modelData.quotaInfo === 'object') {
                            modelData.quotaInfo.remainingFraction = 1.0;
                        }
                    }
                    out = Buffer.from(JSON.stringify(data));
                    neutralized = true;
                }
            } catch {
                // Non-JSON (or already consumed) — forward the raw response unchanged.
            }
            const outHeaders = sanitizeResponseHeaders(proxyRes.headers, out.length);
            if (!res.headersSent) res.writeHead(proxyRes.statusCode, outHeaders);
            res.end(out);
            if (neutralized) {
                logger.info(`[GUI Interceptor] 🧪 fetchAvailableModels quotaInfo neutralized (${proxyRes.statusCode})`);
            }
        });
    });

    res.on('close', () => {
        if (!res.writableFinished) proxyReq.destroy();
    });

    proxyReq.on('error', (err) => {
        logger.error(`[GUI Interceptor] Forward error to ${hostName}: ${err.message}`);
        if (!res.headersSent) {
            res.status(502).json({ error: `Bad Gateway (${hostName})` });
        } else {
            res.destroy();
        }
    });

    if (bodyText && bodyText.length > 0) {
        proxyReq.write(bodyText);
    }
    proxyReq.end();
}

app.use(async (req, res, next) => {
    const host = req.headers['host'] || '';
    // Identify the canonical Google host (strip port if present)
    const hostName = host.split(':')[0];
    const proxy = googleProxies[hostName];

    if (!proxy) {
        return next(); // Not a Google Cloud Code request — pass to normal routes
    }

    const reqPath = req.originalUrl;
    const reqPathLower = reqPath.toLowerCase();
    // Detect AI model queries (prediction / generation)
    const isAIRequest =
        reqPathLower.includes('predict') ||
        reqPathLower.includes('generatecontent') ||
        (reqPathLower.includes('/models/') && req.method === 'POST');

    // Detect metadata requests that also consume quota on the native account.
    // These must be routed through the pool to prevent native account depletion.
    // See: docs/scoring-model.md § "Native Account Protection"
    const isMetadataRequest = !isAIRequest && (
        reqPathLower.includes('fetchavailablemodels') ||
        reqPathLower.includes('loadcodeassist') ||
        reqPathLower.includes('onboarduser') ||
        reqPathLower.includes('retrieveuserquotasummary')
    );

    // Identity-bound endpoints (account sign-in / onboarding / model discovery)
    // MUST stay authenticated as the account that actually signed into AG. Routing
    // them through the pool with a swapped token breaks the connect-login flow
    // (Google would onboard / return data for the wrong account). These keep the
    // request's original Bearer token; the pool-swap below is skipped for them.
    const IDENTITY_ENDPOINT_MARKERS = ['onboarduser', 'loadcodeassist', 'fetchavailablemodels'];
    const isIdentityRequest = IDENTITY_ENDPOINT_MARKERS.some((m) => reqPathLower.includes(m));

    if (isAIRequest || isMetadataRequest) {
        // Bypass: the quota summary is scoped to whichever account authenticates,
        // so when routed through the rotating pool it looks "locked" to one account
        // regardless of the IDE login. Synthesize a neutral (healthy) response so
        // the usage panel is account-independent and the requirement is bypassed.
        if (reqPathLower.includes('retrieveuserquotasummary')) {
            logger.success(`[GUI Interceptor] 🧪 Quota summary synthesized (proxy-managed, account-independent)`);
            return handleQuotaSummarySynthesis(req, res);
        }
        try {
            await ensureInitialized();

            // 0. Apply micro-delay throttle to pace burst requests
            await globalThrottle.throttle();

            // Resolve which account AG is ACTUALLY authenticated as from the
            // live Bearer token (the SQLite auth record can be stale). This
            // powers the -300 native penalty and keeps routing-mode.json true.
            let incomingTokenEmail = null;
            const incomingAuth = req.headers['authorization'] || '';
            if (incomingAuth.startsWith('Bearer ')) {
                const incomingToken = incomingAuth.slice(7).trim();
                if (incomingToken) {
                    try {
                        incomingTokenEmail = await resolveTokenToEmail(incomingToken, accountManager);
                    } catch (e) {
                        logger.debug(`[GUI Interceptor] Token resolution failed: ${e.message}`);
                    }
                }
            }

            // 1. Extract the requested model. For /v1/models/{model}:generateContent
            //    URLs it is in the path; for v1internal:generateContent / streamGenerateContent
            //    it lives in the JSON body — buffer the body so we can do model-aware
            //    selection and transparent fallback rewriting.
            const urlModelMatch = reqPath.match(/\/v1\/models\/([^/?:]+)/);
            const urlModel = urlModelMatch ? urlModelMatch[1] : null;
            let requestedModel = urlModel;
            let requestBodyText = null;
            let requestBodyObj = null;

            // fetchAvailableModels must also be body-buffered so the manual
            // forward can neutralize its per-model quotaInfo response.
            const needsBodyBuffer = isAIRequest || reqPathLower.includes('fetchavailablemodels');
            if (needsBodyBuffer) {
                try {
                    const buf = await readRequestBody(req);
                    if (buf && buf.length > 0) {
                        requestBodyText = buf.toString('utf8');
                        try {
                            requestBodyObj = JSON.parse(requestBodyText);
                            if (requestBodyObj && typeof requestBodyObj.model === 'string') {
                                requestedModel = requestBodyObj.model;
                            }
                        } catch {
                            requestBodyObj = null;
                        }
                    }
                } catch (e) {
                    // The stream was consumed before the size cap — cannot forward it.
                    logger.warn(`[GUI Interceptor] Body buffering failed (${e.message}) — rejecting oversized request`);
                    return res.status(413).json({ error: `Request body too large to intercept (${e.message})` });
                }
            }

            // 2. Select the healthiest account from the load balancer (model-aware)
            let { account } = accountManager.selectAccount(requestedModel, {
                apiProfile: req?.apiProfile,
                incomingTokenEmail,
            });

            // 3. Automatic Model Fallback Injection: if the requested model has no
            //    available pool quota, transparently rewrite to a healthy fallback
            //    model (Opus → Sonnet → Gemini Pro → Flash). See implementation_plan.md.
            let fallbackModel = null;
            if (!account && isAIRequest && requestedModel) {
                for (const fb of getFallbackChain(requestedModel)) {
                    const fbResult = accountManager.selectAccount(fb, {
                        apiProfile: req?.apiProfile,
                        incomingTokenEmail,
                    });
                    if (fbResult.account) {
                        account = fbResult.account;
                        fallbackModel = fb;
                        break;
                    }
                }
            }

            const nativeAccount = incomingTokenEmail || accountManager.getNativeIdeAccount()?.email || null;

            if (!account) {
                if (isMetadataRequest) {
                    // Metadata requests can fall back to native token if pool is empty
                    logRoutingTelemetry('ROUTER_BYPASS', {
                        requestedModel,
                        actualModel: requestedModel,
                        nativeAccount,
                        selectedAccount: null,
                        reason: 'No pooled accounts — metadata pass-through with native token',
                    });
                    logger.warn(`[GUI Interceptor] No pooled accounts — metadata pass-through: ${req.method} ${reqPath}`);
                    // fetchAvailableModels body was already buffered — it can no longer
                    // fall through to httpxy (the stream is consumed). Forward manually
                    // with the native token, still neutralizing quotaInfo.
                    if (reqPathLower.includes('fetchavailablemodels') && requestBodyText != null) {
                        forwardAndNeutralizeQuota(hostName, req, res, requestBodyText);
                        return;
                    }
                } else {
                    logRoutingTelemetry('ALL_EXHAUSTED', {
                        requestedModel,
                        actualModel: requestedModel,
                        nativeAccount,
                        selectedAccount: null,
                        reason: 'No accounts available in pool and no fallback model available',
                    });
                    logger.warn(`[GUI Interceptor] No accounts available for AI request to ${reqPath}`);
                    return res.status(503).json({ error: 'No accounts available in pool' });
                }
            } else {
                // 4. Apply the fallback model rewrite (body model takes precedence)
                if (fallbackModel) {
                    if (requestBodyObj && requestBodyObj.model) {
                        requestBodyObj.model = fallbackModel;
                        requestBodyText = JSON.stringify(requestBodyObj);
                    } else if (urlModel && req.url) {
                        req.url = req.url.replace(urlModel, fallbackModel);
                    }
                    logRoutingTelemetry('MODEL_FALLBACK', {
                        requestedModel,
                        actualModel: fallbackModel,
                        nativeAccount,
                        selectedAccount: account.email,
                        reason: `Requested model has no available pool quota`,
                    });
                }

                // 5. Fetch a fresh OAuth token for that account
                // 6. Swap the IDE's native token with our pooled account token —
                //    EXCEPT for identity-bound endpoints, which keep their own
                //    native Bearer token so the connect-login flow works.
                if (!isIdentityRequest) {
                    const token = await accountManager.getTokenForAccount(account);
                    req.headers['authorization'] = `Bearer ${token}`;
                }

                const label = isIdentityRequest
                    ? '🔑 Identity'
                    : (fallbackModel ? '⚡ Fallback' : (isMetadataRequest ? '📋 Metadata' : '⚡ Balanced'));
                logger.success(`[GUI Interceptor] ${label} → ${reqPath}${requestedModel ? ` [${requestedModel}]` : ''}${fallbackModel ? ` (→${fallbackModel})` : ''}${isIdentityRequest ? ' (native token)' : ` via ${account.email}`}`);

                // 7. AI bodies were buffered — forward manually (native https, DNS patched)
                if (isAIRequest && requestBodyText != null) {
                    forwardToGoogle(hostName, req, res, requestBodyText);
                    return;
                }

                // 7b. fetchAvailableModels: route through the pool for the real model
                // list, but neutralize the per-model quotaInfo so AG's model availability
                // is not locked to whichever pooled account served the request.
                if (isMetadataRequest && reqPathLower.includes('fetchavailablemodels') && requestBodyText != null) {
                    forwardAndNeutralizeQuota(hostName, req, res, requestBodyText);
                    return;
                }
            }
        } catch (error) {
            if (isMetadataRequest) {
                // Metadata failures are non-fatal — fall through with native token
                logger.warn(`[GUI Interceptor] Metadata pool error (pass-through): ${error.message}`);
            } else {
                logger.error(`[GUI Interceptor] Error selecting account: ${error.message}`);
                return res.status(500).json({ error: error.message });
            }
        }
    } else {
        // Pure auth / OAuth callbacks / heartbeat — pass through with the original IDE token
        logger.info(`[GUI Interceptor] 🔑 Auth pass-through: ${req.method} ${reqPath}`);
    }

    // Forward to Google using the pre-created stable proxy instance
    proxy(req, res, next);
});
// ──────────────────────────────────────────────────────────────────────────────

// Middleware
app.use(cors());
app.use(express.json({ limit: REQUEST_BODY_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: REQUEST_BODY_LIMIT }));

// API Key authentication middleware for /v1/* endpoints
app.use('/v1', (req, res, next) => {
    // Skip API Key check for Google Cloud Code / Gemini GUI requests
    const host = req.headers['host'] || '';
    if (host.includes('cloudcode-pa.googleapis.com') || host.includes('daily-cloudcode-pa.googleapis.com')) {
        return next();
    }

    // Skip validation if apiKeys are not configured (and legacy apiKey is not configured)
    const hasKeysConfigured = (config.apiKeys && Object.keys(config.apiKeys).length > 0) || config.apiKey;
    if (!hasKeysConfigured) {
        return next();
    }

    const authHeader = req.headers['authorization'];
    const xApiKey = req.headers['x-api-key'];

    let providedKey = '';
    if (authHeader && authHeader.startsWith('Bearer ')) {
        providedKey = authHeader.substring(7);
    } else if (xApiKey) {
        providedKey = xApiKey;
    }

    let isValid = false;
    let apiProfile = null;

    if (providedKey) {
        if (config.apiKeys && config.apiKeys[providedKey]) {
            isValid = true;
            apiProfile = config.apiKeys[providedKey];
        } else if (config.apiKey && providedKey === config.apiKey) {
            isValid = true;
            apiProfile = { tier: 'legacy' }; // Legacy fallback
        }
    } else {
        // Fallback for local IDE requests that don't send an API key
        isValid = true;
        apiProfile = { tier: 'gui', fallback: true };
    }

    if (!isValid) {
        const isLocalhost = req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1';
        if (isLocalhost) {
            // Accept any key from localhost (useful for claude-code CLI sending OAuth tokens)
            isValid = true;
            apiProfile = { tier: 'cli', fallback: true };
        } else {
            logger.warn(`[API] Unauthorized request from ${req.ip}, invalid API key: ${providedKey.substring(0, 4)}...`);
            return res.status(401).json({
                type: 'error',
                error: {
                    type: 'authentication_error',
                    message: 'Invalid or missing API key'
                }
            });
        }
    }

    // Attach profile to request for load balancer routing
    req.apiProfile = apiProfile;
    next();
});

// Setup usage statistics middleware
usageStats.setupMiddleware(app);

/**
 * Silent handler for Claude Code CLI root POST requests
 * Claude Code sends heartbeat/event requests to POST / which we don't need
 * Using app.use instead of app.post for earlier middleware interception
 */
app.use((req, res, next) => {
    // Handle Claude Code event logging requests silently
    if (req.method === 'POST' && req.path === '/api/event_logging/batch') {
        return res.status(200).json({ status: 'ok' });
    }
    // Handle Claude Code root POST requests silently
    if (req.method === 'POST' && req.path === '/') {
        return res.status(200).json({ status: 'ok' });
    }
    next();
});

// ─── Dynamic Model Config ─────────────────────────────────────────────────────
// Populated on startup from live API data. Refreshed periodically.
let dynamicPresets = null;
let dynamicFallbackMapCache = null;

/**
 * Initialize dynamic model configuration from live API data.
 * Called once on startup after account manager is ready.
 */
async function initDynamicModelConfig() {
    try {
        const { account } = accountManager.selectAccount();
        if (!account) {
            logger.warn('[Server] No accounts available for dynamic model config');
            return;
        }
        const token = await accountManager.getTokenForAccount(account);
        const data = await fetchAvailableModels(token, account.subscription?.projectId);
        if (data && data.models) {
            const modelIds = Object.keys(data.models).filter(id => {
                const fam = id.toLowerCase();
                return fam.includes('claude') || fam.includes('gemini') || true; // include all
            });
            logger.info(`[Server] Discovered ${modelIds.length} models for dynamic config`);

            // Build and cache dynamic fallback map
            initFallbackMap(modelIds);
            dynamicFallbackMapCache = buildFallbackMap(modelIds);

            // Build and cache dynamic presets
            const port = process.env.PORT || 1987;
            dynamicPresets = buildPresets(modelIds, port);
            logger.success(`[Server] Dynamic presets generated: ${dynamicPresets.map(p => p.name).join(', ')}`);
        }
    } catch (error) {
        logger.warn(`[Server] Dynamic model config failed: ${error.message}`);
    }
}

// Refresh dynamic model config periodically (every 5 minutes)
setInterval(() => {
    if (isInitialized) {
        initDynamicModelConfig().catch(() => {});
    }
}, 5 * 60 * 1000);

/**
 * API: Get dynamically generated presets
 * Returns auto-generated presets based on live model data
 */
app.get('/webui/api/dynamic-presets', async (req, res) => {
    try {
        // If we have cached presets, return them immediately
        if (dynamicPresets) {
            return res.json({ presets: dynamicPresets, source: 'dynamic', modelCount: Object.keys(dynamicFallbackMapCache || {}).length });
        }

        // Otherwise try to generate on-demand
        await ensureInitialized();
        await initDynamicModelConfig();

        if (dynamicPresets) {
            return res.json({ presets: dynamicPresets, source: 'dynamic', modelCount: Object.keys(dynamicFallbackMapCache || {}).length });
        }

        // Fall back to static presets
        const { DEFAULT_PRESETS } = await import('./constants.js');
        res.json({ presets: DEFAULT_PRESETS, source: 'fallback', modelCount: 0 });
    } catch (error) {
        logger.error('[API] Error generating dynamic presets:', error);
        res.status(500).json({ error: error.message });
    }
});

// Mount Commander Dashboard API Router (replaces Python FastAPI backend)
app.use('/api', createCommanderRouter(accountManager, ensureInitialized));

// Mount Conversation History API (query logged conversations)
app.use('/api', createConversationRouter());

// Mount iMessage reader API (local iMessage database queries)
import { createIMessageRouter } from './imessage-reader.js';
app.use('/api', createIMessageRouter());

// Mount primary account Gemini conversation router
import { createGeminiConversationRouter } from './gemini-conversations.js';
app.use('/api/gemini', createGeminiConversationRouter());

// Mount unified search API (across conversations + iMessage)
import { createSearchRouter } from './api-search.js';
app.use('/api', createSearchRouter());


// Mount WebUI (optional web interface for account management)
mountWebUI(app, __dirname, accountManager);

// Mount OpenAI-compatible endpoint (replaces standalone ARC Gateway)
mountOpenAICompat(app, accountManager, ensureInitialized, FALLBACK_ENABLED);

// Mount OpenAI Responses-API bridge (Routes OpenAI Codex CLI through the pool)
mountResponsesCompat(app, accountManager, ensureInitialized, FALLBACK_ENABLED);

/**
 * Parse error message to extract error type, status code, and user-friendly message
 */
function parseError(error) {
    let errorType = 'api_error';
    let statusCode = 500;
    let errorMessage = error.message;

    if (error.message.includes('401') || error.message.includes('UNAUTHENTICATED')) {
        errorType = 'authentication_error';
        statusCode = 401;
        errorMessage = 'Authentication failed. Make sure Antigravity is running with a valid token.';
    } else if (error.message.includes('429') || error.message.includes('RESOURCE_EXHAUSTED') || error.message.includes('QUOTA_EXHAUSTED')) {
        errorType = 'invalid_request_error';  // Use invalid_request_error to force client to purge/stop
        statusCode = 400;  // Use 400 to ensure client does not retry (429 and 529 trigger retries)

        // Try to extract the quota reset time from the error
        const resetMatch = error.message.match(/quota will reset after ([\dh\dm\ds]+)/i);
        // Try to extract model from our error format "Rate limited on <model>" or JSON format
        const modelMatch = error.message.match(/Rate limited on ([^.]+)\./) || error.message.match(/"model":\s*"([^"]+)"/);
        const model = modelMatch ? modelMatch[1] : 'the model';

        if (resetMatch) {
            errorMessage = `RESOURCE_EXHAUSTED: You have exhausted your capacity on ${model}. Quota will reset after ${resetMatch[1]}.`;
        } else {
            errorMessage = `RESOURCE_EXHAUSTED: You have exhausted your capacity on ${model}. Please wait for your quota to reset.`;
        }
    } else if (error.message.includes('invalid_request_error') || error.message.includes('INVALID_ARGUMENT')) {
        errorType = 'invalid_request_error';
        statusCode = 400;
        const msgMatch = error.message.match(/"message":"([^"]+)"/);
        if (msgMatch) errorMessage = msgMatch[1];
    } else if (error.message.includes('All endpoints failed')) {
        errorType = 'api_error';
        statusCode = 503;
        errorMessage = 'Unable to connect to Claude API. Check that Antigravity is running.';
    } else if (error.message.includes('PERMISSION_DENIED')) {
        errorType = 'permission_error';
        statusCode = 403;
        errorMessage = errorMessage;
    }

    return { errorType, statusCode, errorMessage };
}

// Request logging middleware
app.use((req, res, next) => {
    const start = Date.now();

    // Log response on finish
    res.on('finish', () => {
        const duration = Date.now() - start;
        const status = res.statusCode;
        const logMsg = `[${req.method}] ${req.originalUrl} ${status} (${duration}ms)`;

        // Skip standard logging for event logging batch unless in debug mode
        if (req.originalUrl === '/api/event_logging/batch' || req.originalUrl.startsWith('/v1/messages/count_tokens') || req.originalUrl.startsWith('/.well-known/')) {
            if (logger.isDebugEnabled) {
                logger.debug(logMsg);
            }
        } else {
            // Colorize status code
            if (status >= 500) {
                logger.error(logMsg);
            } else if (status >= 400) {
                logger.warn(logMsg);
            } else {
                logger.info(logMsg);
            }
        }
    });

    next();
});

/**
 * Silent handler for Claude Code CLI root POST requests
 * Claude Code sends heartbeat/event requests to POST / which we don't need
 */
app.post('/', (req, res) => {
    res.status(200).json({ status: 'ok' });
});

/**
 * Test endpoint - Clear thinking signature cache
 * Used for testing cold cache scenarios in cross-model tests
 */
app.post('/test/clear-signature-cache', (req, res) => {
    clearThinkingSignatureCache();
    logger.debug('[Test] Cleared thinking signature cache');
    res.json({ success: true, message: 'Thinking signature cache cleared' });
});

/**
 * Health check endpoint - Detailed status
 * Returns status of all accounts including rate limits and model quotas
 */
app.get('/health', async (req, res) => {
    try {
        await ensureInitialized();
        const start = Date.now();

        // Get high-level status first
        const status = accountManager.getStatus();
        const allAccounts = accountManager.getAllAccounts();

        // Fetch quotas for each account in parallel to get detailed model info
        const accountDetails = await Promise.allSettled(
            allAccounts.map(async (account) => {
                // Check model-specific rate limits
                const activeModelLimits = Object.entries(account.modelRateLimits || {})
                    .filter(([_, limit]) => limit.isRateLimited && limit.resetTime > Date.now());
                const isRateLimited = activeModelLimits.length > 0;
                const soonestReset = activeModelLimits.length > 0
                    ? Math.min(...activeModelLimits.map(([_, l]) => l.resetTime))
                    : null;

                const baseInfo = {
                    email: account.email,
                    lastUsed: account.lastUsed ? new Date(account.lastUsed).toISOString() : null,
                    modelRateLimits: account.modelRateLimits || {},
                    rateLimitCooldownRemaining: soonestReset ? Math.max(0, soonestReset - Date.now()) : 0
                };

                // Skip invalid accounts for quota check
                if (account.isInvalid) {
                    const isBanned = account.invalidReason?.toLowerCase().includes('banned') || 
                                     account.invalidReason?.toLowerCase().includes('terms of service');
                    return {
                        ...baseInfo,
                        status: isBanned ? 'banned' : 'invalid',
                        error: account.invalidReason,
                        models: {}
                    };
                }

                try {
                    const token = await accountManager.getTokenForAccount(account);
                    const projectId = account.subscription?.projectId || null;
                    const quotas = await getModelQuotas(token, projectId);

                    // Format quotas for readability
                    const formattedQuotas = {};
                    for (const [modelId, info] of Object.entries(quotas)) {
                        formattedQuotas[modelId] = {
                            remaining: info.remainingFraction !== null ? `${Math.round(info.remainingFraction * 100)}%` : 'N/A',
                            remainingFraction: info.remainingFraction,
                            resetTime: info.resetTime || null
                        };
                    }

                    return {
                        ...baseInfo,
                        status: isRateLimited ? 'rate-limited' : 'ok',
                        models: formattedQuotas
                    };
                } catch (error) {
                    return {
                        ...baseInfo,
                        status: 'error',
                        error: error.message,
                        models: {}
                    };
                }
            })
        );

        // Process results
        const detailedAccounts = accountDetails.map((result, index) => {
            if (result.status === 'fulfilled') {
                return result.value;
            } else {
                const acc = allAccounts[index];
                return {
                    email: acc.email,
                    status: 'error',
                    error: result.reason?.message || 'Unknown error',
                    modelRateLimits: acc.modelRateLimits || {}
                };
            }
        });

        res.json({
            status: 'ok',
            timestamp: new Date().toISOString(),
            latencyMs: Date.now() - start,
            summary: status.summary,
            counts: {
                total: status.total,
                available: status.available,
                rateLimited: status.rateLimited,
                invalid: status.invalid
            },
            accounts: detailedAccounts
        });

    } catch (error) {
        logger.error('[API] Health check failed:', error);
        res.status(503).json({
            status: 'error',
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

/**
 * Account limits endpoint - fetch quota/limits for all accounts × all models
 * Returns a table showing remaining quota and reset time for each combination
 * Use ?format=table for ASCII table output, default is JSON
 */
app.get('/account-limits', async (req, res) => {
    try {
        await ensureInitialized();
        const allAccounts = accountManager.getAllAccounts();
        const format = req.query.format || 'json';
        const includeHistory = req.query.includeHistory === 'true';

        // Fetch quotas for each account in parallel
        const results = await Promise.allSettled(
            allAccounts.map(async (account) => {
                // Skip invalid accounts
                if (account.isInvalid) {
                    return {
                        email: account.email,
                        status: 'invalid',
                        error: account.invalidReason,
                        models: {}
                    };
                }

                if (account.type === 'apikey') {
                    const mockModels = {};
                    const modelsList = [
                        'gemini-2.5-flash',
                        'gemini-2.5-flash-lite',
                        'gemini-2.5-flash-thinking',
                        'gemini-2.5-pro',
                        'gemini-3.0-flash',
                        'gemini-3.1-flash-lite',
                        'gemini-3.1-pro-high'
                    ];
                    for (const m of modelsList) {
                        mockModels[m] = {
                            remaining: 15,
                            limit: 15,
                            remainingFraction: 1.0,
                            resetTime: Date.now() + 60000,
                            period: 'minute'
                        };
                    }
                    return {
                        email: account.email,
                        status: 'ok',
                        subscription: {
                            tier: 'Developer API Key',
                            projectId: 'virtual-api-key'
                        },
                        models: mockModels
                    };
                }

                try {
                    const token = await accountManager.getTokenForAccount(account);

                    // Fetch subscription tier first to get project ID
                    const subscription = await getSubscriptionTier(token);

                    // Then fetch quotas with project ID for accurate quota info
                    const quotas = await getModelQuotas(token, subscription.projectId);

                    // Update account object with fresh data
                    account.subscription = {
                        tier: subscription.tier,
                        projectId: subscription.projectId,
                        detectedAt: Date.now()
                    };
                    account.quota = {
                        models: quotas,
                        lastChecked: Date.now()
                    };

                    // Save updated account data to disk (async, don't wait)
                    accountManager.saveToDisk().catch(err => {
                        logger.error('[Server] Failed to save account data:', err);
                    });

                    return {
                        email: account.email,
                        status: 'ok',
                        subscription: account.subscription,
                        models: quotas
                    };
                } catch (error) {
                    // Detect ToS ban from quota/subscription fetch and mark account invalid
                    if (error.message?.startsWith('ACCOUNT_BANNED:')) {
                        accountManager.markInvalid(account.email, 'Account banned — Gemini disabled for Terms of Service violation');
                        return {
                            email: account.email,
                            status: 'banned',
                            error: 'Account banned — Gemini disabled for Terms of Service violation',
                            subscription: account.subscription || { tier: 'unknown', projectId: null },
                            models: {}
                        };
                    }
                    return {
                        email: account.email,
                        status: 'error',
                        error: error.message,
                        subscription: account.subscription || { tier: 'unknown', projectId: null },
                        models: {}
                    };
                }
            })
        );

        // Process results
        const accountLimits = results.map((result, index) => {
            if (result.status === 'fulfilled') {
                return result.value;
            } else {
                return {
                    email: allAccounts[index].email,
                    status: 'error',
                    error: result.reason?.message || 'Unknown error',
                    models: {}
                };
            }
        });

        // Collect all unique model IDs
        const allModelIds = new Set();
        for (const account of accountLimits) {
            for (const modelId of Object.keys(account.models || {})) {
                allModelIds.add(modelId);
            }
        }

        const sortedModels = Array.from(allModelIds).sort();

        // Return ASCII table format
        if (format === 'table') {
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');

            // Build table
            const lines = [];
            const timestamp = new Date().toLocaleString();
            lines.push(`Account Limits (${timestamp})`);

            // Get account status info
            const status = accountManager.getStatus();
            lines.push(`Accounts: ${status.total} total, ${status.available} available, ${status.rateLimited} rate-limited, ${status.invalid} invalid`);
            lines.push('');

            // Table 1: Account status
            const accColWidth = 25;
            const statusColWidth = 15;
            const lastUsedColWidth = 25;
            const resetColWidth = 25;

            let accHeader = 'Account'.padEnd(accColWidth) + 'Status'.padEnd(statusColWidth) + 'Last Used'.padEnd(lastUsedColWidth) + 'Quota Reset';
            lines.push(accHeader);
            lines.push('─'.repeat(accColWidth + statusColWidth + lastUsedColWidth + resetColWidth));

            for (const acc of status.accounts) {
                const shortEmail = acc.email.split('@')[0].slice(0, 22);
                const lastUsed = acc.lastUsed ? new Date(acc.lastUsed).toLocaleString() : 'never';

                // Get status and error from accountLimits
                const accLimit = accountLimits.find(a => a.email === acc.email);
                let accStatus;
                if (acc.isInvalid) {
                    accStatus = 'invalid';
                } else if (accLimit?.status === 'error') {
                    accStatus = 'error';
                } else {
                    // Count exhausted models (0% or null remaining)
                    const models = accLimit?.models || {};
                    const modelCount = Object.keys(models).length;
                    const exhaustedCount = Object.values(models).filter(
                        q => q.remainingFraction === 0 || q.remainingFraction === null
                    ).length;

                    if (exhaustedCount === 0) {
                        accStatus = 'ok';
                    } else {
                        accStatus = `(${exhaustedCount}/${modelCount}) limited`;
                    }
                }

                // Get reset time from quota API
                const claudeModel = sortedModels.find(m => m.includes('claude'));
                const quota = claudeModel && accLimit?.models?.[claudeModel];
                const resetTime = quota?.resetTime
                    ? new Date(quota.resetTime).toLocaleString()
                    : '-';

                let row = shortEmail.padEnd(accColWidth) + accStatus.padEnd(statusColWidth) + lastUsed.padEnd(lastUsedColWidth) + resetTime;

                // Add error on next line if present
                if (accLimit?.error) {
                    lines.push(row);
                    lines.push('  └─ ' + accLimit.error);
                } else {
                    lines.push(row);
                }
            }
            lines.push('');

            // Calculate column widths - need more space for reset time info
            const modelColWidth = Math.max(28, ...sortedModels.map(m => m.length)) + 2;
            const accountColWidth = 30;

            // Header row
            let header = 'Model'.padEnd(modelColWidth);
            for (const acc of accountLimits) {
                const shortEmail = acc.email.split('@')[0].slice(0, 26);
                header += shortEmail.padEnd(accountColWidth);
            }
            lines.push(header);
            lines.push('─'.repeat(modelColWidth + accountLimits.length * accountColWidth));

            // Data rows
            for (const modelId of sortedModels) {
                let row = modelId.padEnd(modelColWidth);
                for (const acc of accountLimits) {
                    const quota = acc.models?.[modelId];
                    let cell;
                    if (acc.status !== 'ok' && acc.status !== 'rate-limited') {
                        cell = `[${acc.status}]`;
                    } else if (!quota) {
                        cell = '-';
                    } else if (quota.remainingFraction === 0 || quota.remainingFraction === null) {
                        // Show reset time for exhausted models
                        if (quota.resetTime) {
                            const resetMs = new Date(quota.resetTime).getTime() - Date.now();
                            if (resetMs > 0) {
                                cell = `0% (wait ${formatDuration(resetMs)})`;
                            } else {
                                cell = '0% (resetting...)';
                            }
                        } else {
                            cell = '0% (exhausted)';
                        }
                    } else {
                        const pct = Math.round(quota.remainingFraction * 100);
                        cell = `${pct}%`;
                    }
                    row += cell.padEnd(accountColWidth);
                }
                lines.push(row);
            }

            return res.send(lines.join('\n'));
        }

        // Get account metadata from AccountManager
        const accountStatus = accountManager.getStatus();
        const accountMetadataMap = new Map(
            accountStatus.accounts.map(a => [a.email, a])
        );

        // Build response data
        const responseData = {
            timestamp: new Date().toLocaleString(),
            totalAccounts: allAccounts.length,
            routingMode: accountManager.getRoutingMode ? accountManager.getRoutingMode() : 'load_balancer',
            nativeAccount: accountManager.getNativeIdeAccount ? accountManager.getNativeIdeAccount()?.email : null,
            models: sortedModels,
            modelConfig: config.modelMapping || {},
            globalQuotaThreshold: config.globalQuotaThreshold || 0,
            accounts: accountLimits.map(acc => {
                // Merge quota data with account metadata
                const metadata = accountMetadataMap.get(acc.email) || {};
                return {
                    email: acc.email,
                    status: acc.status,
                    error: acc.error || null,
                    // Include metadata from AccountManager (WebUI needs these)
                    source: metadata.source || 'unknown',
                    enabled: metadata.enabled !== false,
                    projectId: metadata.projectId || null,
                    isInvalid: metadata.isInvalid || false,
                    invalidReason: metadata.invalidReason || null,
                    verifyUrl: metadata.verifyUrl || null,
                    lastUsed: metadata.lastUsed || null,
                    modelRateLimits: metadata.modelRateLimits || {},
                    // Quota threshold settings
                    quotaThreshold: metadata.quotaThreshold,
                    modelQuotaThresholds: metadata.modelQuotaThresholds || {},
                    // Subscription data (new)
                    subscription: acc.subscription || metadata.subscription || { tier: 'unknown', projectId: null },
                    // Quota limits
                    limits: Object.fromEntries(
                        sortedModels.map(modelId => {
                            const quota = acc.models?.[modelId];
                            if (!quota) {
                                return [modelId, null];
                            }
                            return [modelId, {
                                remaining: quota.remainingFraction !== null
                                    ? `${Math.round(quota.remainingFraction * 100)}%`
                                    : 'N/A',
                                remainingFraction: quota.remainingFraction,
                                resetTime: quota.resetTime || null
                            }];
                        })
                    )
                };
            })
        };

        // Optionally include usage history (for dashboard performance optimization)
        if (includeHistory) {
            responseData.history = usageStats.getHistory();
        }

        res.json(responseData);
    } catch (error) {
        res.status(500).json({
            status: 'error',
            error: error.message
        });
    }
});

/**
 * Force token refresh endpoint
 */
app.post('/refresh-token', async (req, res) => {
    try {
        await ensureInitialized();
        // Clear all caches
        accountManager.clearTokenCache();
        accountManager.clearProjectCache();
        // Force refresh default token
        const token = await forceRefresh();
        res.json({
            status: 'ok',
            message: 'Token caches cleared and refreshed',
            tokenPrefix: token.substring(0, 10) + '...'
        });
    } catch (error) {
        res.status(500).json({
            status: 'error',
            error: error.message
        });
    }
});

/**
 * List models endpoint (OpenAI-compatible format)
 */
app.get('/v1/models', async (req, res) => {
    try {
        await ensureInitialized();
        const { account } = accountManager.selectAccount(null, { apiProfile: req?.apiProfile });
        if (!account) {
            return res.status(503).json({
                type: 'error',
                error: {
                    type: 'api_error',
                    message: 'No accounts available'
                }
            });
        }
        const token = await accountManager.getTokenForAccount(account);
        const models = await listModels(token);
        res.json(models);
    } catch (error) {
        logger.error('[API] Error listing models:', error);
        res.status(500).json({
            type: 'error',
            error: {
                type: 'api_error',
                message: error.message
            }
        });
    }
});

/**
 * Count tokens endpoint - Anthropic Messages API compatible
 * Uses local tokenization with official tokenizers (@anthropic-ai/tokenizer for Claude, @lenml/tokenizer-gemini for Gemini)
 */
app.post('/v1/messages/count_tokens', (req, res) => {
    res.status(501).json({
        type: 'error',
        error: {
            type: 'not_implemented',
            message: 'Token counting is not implemented. Use /v1/messages with max_tokens or configure your client to skip token counting.'
        }
    });
});

/**
 * Main messages endpoint - Anthropic Messages API compatible
 */


/**
 * Anthropic-compatible Messages API
 * POST /v1/messages
 */
app.post('/v1/messages', async (req, res) => {
    try {
        // Ensure account manager is initialized
        await ensureInitialized();

        const {
            model,
            messages,
            stream,
            system,
            max_tokens,
            tools,
            tool_choice,
            thinking,
            top_p,
            top_k,
            temperature
        } = req.body;

        // Resolve model mapping if configured
        let requestedModel = model || 'claude-3-5-sonnet-20241022';
        const modelMapping = config.modelMapping || {};
        if (modelMapping[requestedModel] && modelMapping[requestedModel].mapping) {
            const targetModel = modelMapping[requestedModel].mapping;
            logger.info(`[Server] Mapping model ${requestedModel} -> ${targetModel}`);
            requestedModel = targetModel;
        }

        const modelId = requestedModel;

        // Validate model ID before processing
        const { account: validationAccount } = accountManager.selectAccount(modelId, { apiProfile: req?.apiProfile });
        if (validationAccount) {
            const token = await accountManager.getTokenForAccount(validationAccount);
            const projectId = validationAccount.subscription?.projectId || null;
            const valid = await isValidModel(modelId, token, projectId);

            if (!valid) {
                throw new Error(`invalid_request_error: Invalid model: ${modelId}. Use /v1/models to see available models.`);
            }
        }

        // Optimistic Retry: If ALL accounts are rate-limited for this model, reset them to force a fresh check.
        // If we have some available accounts, we try them first.
        if (accountManager.isAllRateLimited(modelId)) {
            logger.warn(`[Server] All accounts rate-limited for ${modelId}. Resetting state for optimistic retry.`);
            accountManager.resetAllRateLimits();
        }

        // Validate required fields
        if (!messages || !Array.isArray(messages)) {
            return res.status(400).json({
                type: 'error',
                error: {
                    type: 'invalid_request_error',
                    message: 'messages is required and must be an array'
                }
            });
        }

        // Filter out "count" requests (often automated background checks)
        if (messages.length === 1 && messages[0].content === 'count') {
            return res.json({});
        }

        // Build the request object
        const request = {
            model: modelId,
            messages,
            max_tokens: max_tokens || 4096,
            stream,
            system,
            tools,
            tool_choice,
            thinking,
            top_p,
            top_k,
            temperature,
            apiProfile: req?.apiProfile,
            taskTier: req?.headers?.['x-task-tier']
        };

        logger.info(`[API] Request for model: ${request.model}, stream: ${!!stream}`);

        // Debug: Log message structure to diagnose tool_use/tool_result ordering
        if (logger.isDebugEnabled) {
            logger.debug('[API] Message structure:');
            messages.forEach((msg, i) => {
                const contentTypes = Array.isArray(msg.content)
                    ? msg.content.map(c => c.type || 'text').join(', ')
                    : (typeof msg.content === 'string' ? 'text' : 'unknown');
                logger.debug(`  [${i}] ${msg.role}: ${contentTypes}`);
            });
        }

        if (stream) {
            // Handle streaming response
            // Do NOT flush headers immediately. We need to wait for the first chunk
            // to ensure we don't send a 200 OK if the upstream fails immediately (e.g. 429/503).

            const streamConvId = initStreamingLog(req, request.model, '', '');

            try {
                // Initialize the generator
                const generator = sendMessageStream(request, accountManager, FALLBACK_ENABLED);
                
                // BUFFERING STRATEGY:
                // Pull the first event *before* sending headers. 
                // If this throws, we can safely send a 4xx/5xx error JSON.
                const firstResult = await generator.next();

                // If we get here, the stream started successfully.
                res.status(200);
                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');
                res.setHeader('X-Accel-Buffering', 'no');
                res.flushHeaders();

                // If the generator isn't done, send the first chunk
                if (!firstResult.done) {
                    accumulateStreamEvent(streamConvId, firstResult.value);
                    res.write(`event: ${firstResult.value.type}\ndata: ${JSON.stringify(firstResult.value)}\n\n`);
                    if (res.flush) res.flush();
                }

                // Continue with the rest of the stream
                for await (const event of generator) {
                    accumulateStreamEvent(streamConvId, event);
                    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
                    if (res.flush) res.flush();
                }
                
                res.end();
                finalizeStreamingLog(streamConvId);

            } catch (error) {
                finalizeStreamingLog(streamConvId, error);
                // If we haven't sent headers yet, we can send a proper error status
                if (!res.headersSent) {
                    logger.error('[API] Initial stream error:', error);
                    const { errorType, statusCode, errorMessage } = parseError(error);
                    
                    return res.status(statusCode).json({
                        type: 'error',
                        error: {
                            type: errorType,
                            message: errorMessage
                        }
                    });
                }
                
                // If headers were already sent (should only happen if error occurs mid-stream),
                // we have to fallback to SSE error event
                logger.error('[API] Mid-stream error:', error);
                const { errorType, errorMessage } = parseError(error);

                res.write(`event: error\ndata: ${JSON.stringify({
                    type: 'error',
                    error: { type: errorType, message: errorMessage }
                })}\n\n`);
                res.end();
            }

        } else {
            // Handle non-streaming response
            const response = await sendMessage(request, accountManager, FALLBACK_ENABLED);
            logConversation(request, response, '', '', req);
            res.json(response);
        }

    } catch (error) {
        logger.error('[API] Error:', error);

        let { errorType, statusCode, errorMessage } = parseError(error);

        // For auth errors, try to refresh token
        if (errorType === 'authentication_error') {
            logger.warn('[API] Token might be expired, attempting refresh...');
            try {
                accountManager.clearProjectCache();
                accountManager.clearTokenCache();
                await forceRefresh();
                errorMessage = 'Token was expired and has been refreshed. Please retry your request.';
            } catch (refreshError) {
                errorMessage = 'Could not refresh token. Make sure Antigravity is running.';
            }
        }

        logger.warn(`[API] Returning error response: ${statusCode} ${errorType} - ${errorMessage}`);

        // Check if headers have already been sent (for streaming that failed mid-way)
        if (res.headersSent) {
            logger.warn('[API] Headers already sent, writing error as SSE event');
            res.write(`event: error\ndata: ${JSON.stringify({
                type: 'error',
                error: { type: errorType, message: errorMessage }
            })}\n\n`);
            res.end();
        } else {
            res.status(statusCode).json({
                type: 'error',
                error: {
                    type: errorType,
                    message: errorMessage
                }
            });
        }
    }
});

/**
 * Catch-all for unsupported endpoints
 */
usageStats.setupRoutes(app);

// ==========================================
// SolidStack Dashboard Reverse Proxy (Port 5001)
// ==========================================
const dashboardProxy = createProxyMiddleware({
    target: 'http://127.0.0.1:5001',
    changeOrigin: true,
    ws: true,
    pathRewrite: {
        '^/dashboard': '/'
    },
    on: {
        error: (err, req, res) => {
            logger.error(`[Dashboard Proxy] Error: ${err.message}`);
            if (!res.headersSent) {
                res.status(502).json({ error: 'Dashboard Offline' });
            }
        }
    }
});

app.use((req, res, next) => {
    const flaskRoutes = ['/api/stream', '/api/status', '/api/attention', '/api/heartbeats', '/api/nodes', '/api/services', '/api/containers', '/api/integrations', '/api/taxonomy', '/api/workflow', '/api/coordinator', '/api/agents', '/api/locks', '/api/worktrees', '/api/tasks', '/api/task-progress', '/api/handoffs', '/api/openclaw', '/api/blockers', '/api/service-mobility', '/api/ai-accounts', '/api/ai-proxy', '/api/token-usage', '/api/actions', '/api/discovered', '/api/discovered-devices', '/api/skills', '/api/model-logs', '/api/features', '/api/consideration', '/api/aggregator/status', '/api/local-engines', '/api/model-download-status'];
    
    if (req.path === '/dashboard' || req.path.startsWith('/dashboard/') || req.path.startsWith('/static/') || req.path.startsWith('/partials/')) {
        return dashboardProxy(req, res, next);
    }
    
    for (const route of flaskRoutes) {
        if (req.path === route || req.path.startsWith(route + '/')) {
            return dashboardProxy(req, res, next);
        }
    }
    
    next();
});

app.use('*', createProxyMiddleware({
    target: 'https://cloudcode-pa.googleapis.com',
    changeOrigin: true,
    secure: true,
    on: {
        proxyReq: (proxyReq, req, res) => {
            if (logger.isDebugEnabled) {
                logger.debug(`[Transparent Passthrough] Forwarding unknown route ${req.method} ${req.originalUrl} directly to Google`);
            }
        },
        error: (err, req, res) => {
            logger.error(`[Transparent Passthrough] Error forwarding ${req.originalUrl}: ${err.message}`);
            if (!res.headersSent) {
                res.status(502).json({ error: 'Bad Gateway via Transparent Proxy' });
            }
        }
    }
}));

export default app;