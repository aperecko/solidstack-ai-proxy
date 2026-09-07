/**
 * Express Server - Anthropic-compatible API
 * Proxies to Google Cloud Code via Antigravity
 * Supports multi-account load balancing
 */

import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import { createRequire } from 'module';
import https from 'https';
import { Transform } from 'stream';
import { fileURLToPath } from 'url';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { sendMessage, sendMessageStream, listModels, fetchAvailableModels, getModelQuotas, getSubscriptionTier, isValidModel } from './cloudcode/index.js';
import { parseResetTime } from './cloudcode/rate-limit-parser.js';
import { buildFallbackMap, buildPresets, getModelFamily, resolveModelMapping, GEMINI_SKIP_SIGNATURE } from './constants.js';
import { initFallbackMap, getFallbackChain } from './fallback-config.js';
import { logRoutingTelemetry } from './cloudcode/routing-logger.js';
import { mountWebUI } from './webui/index.js';
import { keyringManager } from './providers/keyring-manager.js';
import { config } from './config.js';
import { globalThrottle } from './utils/throttle.js';
import { recordRequest, getQuotaStatus, isG1CreditExhausted, markG1CreditExhausted, G1_CREDIT_EXHAUSTED_COOLDOWN_MS } from './account-manager/quota-store.js';
import { isAuthError, isRateLimitError, isCapacityExhaustedError, isAccountForbiddenError } from './errors.js';
import { quotaRefreshSoon, setQuotaRefreshImpl } from './utils/quota-refresh.js';
import { selectOptimalModel } from './routing/smart-router.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
import { forceRefresh } from './auth/token-extractor.js';
import { resolveTokenToEmail } from './auth/token-resolver.js';
import { REQUEST_BODY_LIMIT } from './constants.js';
import { AccountManager } from './account-manager/index.js';
import { clearThinkingSignatureCache, getCachedSignatureFamily } from './format/signature-cache.js';
import { formatDuration } from './utils/helpers.js';
import { logger } from './utils/logger.js';
import { readNetworkGate, sendNetworkUnavailable } from './utils/network-gate.js';
import proficiencyTracker from './modules/proficiency-tracker.js';
import usageStats from './modules/usage-stats.js';
import autonomousJudge from './modules/autonomous-judge.js';
import { injectActiveRules } from './modules/jit-injector.js';
import { mountOpenAICompat, mountResponsesCompat } from './openai-compat.js';
import { isNimEligible } from './providers/nvidia-nim.js';
import { streamAgToNim, isAgNimOverflowArmed, NIM_OVERFLOW_MODEL, isAgNimModel, resolveNimModel } from './providers/gui-nim-overflow.js';
import { createCommanderRouter } from './commander-api.js';
import { getVerifiedModels } from './cloudcode/model-tester.js';
import {
    logConversation,
    initStreamingLog,
    accumulateStreamEvent,
    finalizeStreamingLog,
    createConversationRouter
} from './conversation-logger.js';
import { startInFlight, endInFlight, recordTokenUsage } from './cloudcode/routing-logger.js';
import { requireBillingGate } from './auth/billing-gate.js';

// Parse fallback flag directly from command line args to avoid circular dependency
const args = process.argv.slice(2);

// Fallback is enabled by default to ensure resilience across exhausted models
const FALLBACK_ENABLED = process.env.FALLBACK !== 'false' && !args.includes('--no-fallback');

// Parse --strategy flag (format: --strategy=sticky or --strategy sticky)
let STRATEGY_OVERRIDE = null;
for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--strategy=')) {
        STRATEGY_OVERRIDE = args[i].split('=')[1];
    } else if (args[i] === '--strategy' && args[i + 1]) {
        STRATEGY_OVERRIDE = args[i + 1];
    }
}

// Tracks active mid-session model handovers per conversation to avoid duplicate banners on tool loops
// conversationId -> { fallbackSessionId, fallbackModel, notified: boolean, lastHandoverTime: number }
const activeSessionHandovers = new Map();

function extractConversationId(requestBodyObj) {
    if (!requestBodyObj) return null;
    const reqId = requestBodyObj.requestId || '';
    const m = reqId.match(/agent\/([a-f0-9-]+)\//i);
    return m ? m[1] : null;
}

function getOrCreateHandoverAdvisory(conversationId, requestBodyObj, fallbackModel) {
    const sessionsDir = path.join(os.homedir(), '.config', 'antigravity-proxy', 'saved-sessions');
    
    if (conversationId && activeSessionHandovers.has(conversationId)) {
        const existing = activeSessionHandovers.get(conversationId);
        // Already notified in this conversation — suppress repeated banners on tool calls
        if (existing.notified) {
            return {
                fallbackSessionId: existing.fallbackSessionId,
                injectedPrefixText: null
            };
        }
        existing.notified = true;
        return {
            fallbackSessionId: existing.fallbackSessionId,
            injectedPrefixText: `⚠️ **Capacity Advisory:** Your direct capacity for the requested model is temporarily depleted. To prevent interrupting your workflow, this response is provided by the fallback model (\`${fallbackModel}\`).\n\n💾 **Save Reference:** \`SESSION_${existing.fallbackSessionId}\` (You can use this reference to resume your original model when capacity is replenished).\n\n---\n\n`
        };
    }

    const fallbackSessionId = crypto.randomUUID();
    
    // Auto-save the request body payload so the user can easily replay it later
    // if the fallback model doesn't succeed.
    try {
        fs.mkdirSync(sessionsDir, { recursive: true });
        fs.writeFileSync(
            path.join(sessionsDir, `session_${fallbackSessionId}.json`),
            JSON.stringify(requestBodyObj, null, 2),
            'utf-8'
        );
    } catch (e) {
        logger.error(`[Fallback] Failed to save fallback session snapshot ${fallbackSessionId}: ${e.message}`);
    }

    if (conversationId) {
        activeSessionHandovers.set(conversationId, {
            fallbackSessionId,
            fallbackModel,
            notified: true,
            lastHandoverTime: Date.now()
        });
    }

    return {
        fallbackSessionId,
        injectedPrefixText: `⚠️ **Capacity Advisory:** Your direct capacity for the requested model is temporarily depleted. To prevent interrupting your workflow, this response is provided by the fallback model (\`${fallbackModel}\`).\n\n💾 **Save Reference:** \`SESSION_${fallbackSessionId}\` (You can use this reference to resume your original model when capacity is replenished).\n\n---\n\n`
    };
}

const app = express();

// or an upstream generation request is slow. These routes must not wait on the
// account manager or Google services.
app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok', service: 'ai-proxy', pid: process.pid });
});

// ─── Error classification helpers ─────────────────────────────────────────────

/**
 * Classify an error into { errorType, statusCode, errorMessage } using Anthropic-
 * style error types. Handles both structured errors from ./errors.js and legacy
 * string-marker errors (e.g. `QUOTA_EXHAUSTED:`, `CAPACITY_EXHAUSTED:`,
 * `AUTH_INVALID_PERMANENT:`, `invalid_request_error:`).
 * @param {Error} error
 * @returns {{errorType: string, statusCode: number, errorMessage: string}}
 */
function parseError(error) {
    const raw = error?.message || String(error || '');
    const lower = raw.toLowerCase();

    // Structured error classes first.
    if (isAuthError(error) || isAccountForbiddenError(error)) {
        return { errorType: 'authentication_error', statusCode: 401, errorMessage: raw };
    }
    if (isRateLimitError(error)) {
        return { errorType: 'rate_limit_error', statusCode: 429, errorMessage: raw };
    }
    if (isCapacityExhaustedError(error)) {
        return { errorType: 'rate_limit_error', statusCode: 429, errorMessage: raw };
    }
    if (error?.statusCode) {
        const sc = Number(error.statusCode);
        if (sc >= 400 && sc < 600) {
            const type = sc === 401 || sc === 403 ? 'authentication_error'
                : sc === 429 ? 'rate_limit_error'
                : sc === 400 ? 'invalid_request_error'
                : 'api_error';
            return { errorType: type, statusCode: sc, errorMessage: raw };
        }
    }

    // Legacy string markers.
    if (lower.includes('invalid_grant') || lower.includes('token refresh failed')
        || lower.includes('auth_invalid') || lower.includes('account_banned')
        || lower.includes('auth_invalid_permanent')) {
        return { errorType: 'authentication_error', statusCode: 401, errorMessage: raw };
    }
    if (lower.includes('quota_exhausted') || lower.includes('capacity_exhausted')
        || lower.includes('rate limit') || lower.includes('resource_exhausted')
        || lower.includes('rate_limited')) {
        return { errorType: 'rate_limit_error', statusCode: 429, errorMessage: raw };
    }
    if (lower.includes('no accounts available') || lower.includes('max retries exceeded')) {
        return { errorType: 'api_error', statusCode: 503, errorMessage: raw };
    }
    if (lower.includes('invalid_request_error')) {
        return { errorType: 'invalid_request_error', statusCode: 400, errorMessage: raw };
    }
    if (lower.startsWith('api error ')) {
        const m = /api error (\d{3})/.exec(lower);
        const sc = m ? Number(m[1]) : 500;
        return {
            errorType: sc >= 500 ? 'api_error' : (sc === 401 || sc === 403 ? 'authentication_error' : 'api_error'),
            statusCode: sc,
            errorMessage: raw,
        };
    }

    return { errorType: 'api_error', statusCode: 500, errorMessage: raw };
}


// ─── Pre-create stable Google API proxy middleware instances ──────────────────
// http-proxy-middleware must be instantiated once at startup, not per-request.
export function safeProxyErrorResponse(res, statusCode = 502, payload = { error: 'Bad Gateway' }) {
    if (!res) return;
    try {
        if (res.headersSent || res.writableEnded || res.destroyed) return;
        if (typeof res.status === 'function' && typeof res.json === 'function') {
            res.status(statusCode).json(payload);
        } else if (typeof res.writeHead === 'function') {
            const body = JSON.stringify(payload);
            res.writeHead(statusCode, {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body)
            });
            res.end(body);
        } else if (typeof res.end === 'function') {
            res.end();
        } else if (typeof res.destroy === 'function') {
            res.destroy();
        }
    } catch (e) {
        logger.error(`[Proxy] Error writing error response: ${e.message}`);
    }
}

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
        proxyTimeout: 120000,
        timeout: 120000,
        on: {
            error: (err, req, res) => {
                logger.error(`[GUI Interceptor] Proxy error for ${googleHost}: ${err.message}`);
                safeProxyErrorResponse(res, 502, { error: `Bad Gateway (${googleHost})` });
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

            // Start autonomous judge for event-driven telemetry evaluation
            autonomousJudge.start();

            // Prime quota state on boot so the pool isn't selectable-blind until
            // the first backstop/on-demand sweep fires. Non-blocking.
            refreshAllQuotas().catch(() => {});
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
        let total = 0;
        const chunks = [];
        const timer = setTimeout(() => {
            logger.warn(`[GUI Interceptor] Request body timeout: ${req.method} ${req.originalUrl || req.url}`);
            req.destroy(new Error('Request Timeout'));
        }, 60000);
        req.on('data', (chunk) => {
            total += chunk.length;
            if (total > maxBytes) {
                clearTimeout(timer);
                req.destroy(new Error('Payload Too Large'));
                reject(new Error('Payload Too Large'));
            } else {
                chunks.push(chunk);
            }
        });
        req.on('end', () => { clearTimeout(timer); resolve(Buffer.concat(chunks)); });
        req.on('error', (err) => { clearTimeout(timer); reject(err); });
    });
}

// Cross-family thought guard for raw-forwarded Google-format bodies.
// The GUI Interceptor forwards IDE bodies untouched (no convertAnthropicToGoogle),
// so a session whose earlier turns were served by Gemini carries Gemini
// thoughtSignatures. When such history is replayed against a Claude model,
// Vertex's Anthropic backend rejects it with 400 "thinking blocks ... cannot
// be modified". Mirrors the Anthropic-format guard in content-converter.js:
// for Claude targets, drop thought parts that are unsigned or whose signature
// family is unknown/non-claude (untrusted). Returns the original text when
// nothing needs to change.
function sanitizeThoughtPartsForClaude(modelName, bodyText) {
    try {
        if (!modelName || !modelName.toLowerCase().includes('claude')) return bodyText;
        let body;
        try { body = JSON.parse(bodyText); } catch { return bodyText; }
        const contentList = Array.isArray(body?.contents)
            ? body.contents
            : (Array.isArray(body?.request?.contents) ? body.request.contents : null);
        if (!contentList) return bodyText;

        let stripped = 0;
        for (const content of contentList) {
            if (!content || content.role !== 'model' || !Array.isArray(content.parts)) continue;
            const filtered = content.parts.filter(part => {
                if (!part || part.thought !== true) return true;
                // Unsigned or untrusted-family thought parts are dropped for Claude
                const trusted = part.thoughtSignature &&
                    getCachedSignatureFamily(part.thoughtSignature) === 'claude';
                if (!trusted) stripped++;
                return trusted;
            });
            if (filtered.length !== content.parts.length) {
                // Google API requires at least one part per content entry
                content.parts = filtered.length > 0 ? filtered : [{ text: '.' }];
            }
        }

        if (stripped === 0) return bodyText;
        logger.warn(`[GUI Interceptor] Stripped ${stripped} untrusted thought part(s) for Claude target ${modelName}`);
        return JSON.stringify(body);
    } catch (e) {
        logger.debug(`[GUI Interceptor] Thought sanitization skipped: ${e.message}`);
        return bodyText;
    }
}

// Gemini-native thought-signature guard for raw-forwarded Google-format bodies.
// The GUI Interceptor forwards the IDE's Gemini payload verbatim (no
// convertAnthropicToGoogle), so any tool_use/functionCall part that lacks a
// thoughtSignature passes through untouched — and Gemini 3+ rejects the whole
// request with 400 "Function call is missing a thought_signature". This happens
// with long mid-session replays (e.g. a Google built-in tool like
// default_api:manage_subagents persisted without its signature). Mirror the
// Gemini-side injection in content-converter.js: for every functionCall part
// missing a thoughtSignature, stamp it with GEMINI_SKIP_SIGNATURE (the same
// sentinel Google already accepts on the converted path). Safe for Gemini
// targets only; no-op when nothing needs it.
function injectThoughtSignaturesForGemini(modelName, bodyText) {
    try {
        if (!modelName || modelName.toLowerCase().includes('claude')) return bodyText;
        let body;
        try { body = JSON.parse(bodyText); } catch { return bodyText; }

        let modified = false;

        const contentList = Array.isArray(body?.contents)
            ? body.contents
            : (Array.isArray(body?.request?.contents) ? body.request.contents : null);

        if (contentList) {
            let injected = 0;
            for (const content of contentList) {
                if (!content || !Array.isArray(content.parts)) continue;
                for (const part of content.parts) {
                    if (!part || !part.functionCall) continue;
                    if (part.thoughtSignature) continue;
                    part.thoughtSignature = GEMINI_SKIP_SIGNATURE;
                    injected++;
                    modified = true;
                }
            }
            if (injected > 0) {
                logger.debug(`[GUI Interceptor] Injected skip thought_signature on ${injected} functionCall part(s) for Gemini target ${modelName}`);
            }
        }

        const toolsList = Array.isArray(body?.tools)
            ? body.tools
            : (Array.isArray(body?.request?.tools) ? body.request.tools : null);

        if (toolsList) {
            let stripped = 0;
            for (let i = toolsList.length - 1; i >= 0; i--) {
                const tool = toolsList[i];
                if (!tool || !Array.isArray(tool.functionDeclarations)) continue;
                const originalLength = tool.functionDeclarations.length;
                tool.functionDeclarations = tool.functionDeclarations.filter(decl => {
                    if (decl?.name && (decl.name.startsWith('default_api:') || decl.name === 'manage_subagents')) {
                        return false;
                    }
                    return true;
                });
                if (tool.functionDeclarations.length !== originalLength) {
                    stripped += (originalLength - tool.functionDeclarations.length);
                    modified = true;
                }
                if (tool.functionDeclarations.length === 0) {
                    toolsList.splice(i, 1);
                }
            }
            if (stripped > 0) {
                logger.debug(`[GUI Interceptor] Stripped ${stripped} default_api tool declaration(s) for Gemini target ${modelName}`);
            }
        }

        if (modified) return JSON.stringify(body);
        return bodyText;
    } catch (e) {
        logger.debug(`[GUI Interceptor] Signature injection skipped: ${e.message}`);
        return bodyText;
    }
}

function injectPromptAdvisory(bodyText, advisoryText) {
    if (!advisoryText || !bodyText) return bodyText;
    try {
        const bodyObj = JSON.parse(bodyText);
        const contents = bodyObj.request?.contents || bodyObj.contents;
        if (Array.isArray(contents) && contents.length > 0) {
            const lastContent = contents[contents.length - 1];
            if (Array.isArray(lastContent.parts) && lastContent.parts.length > 0) {
                lastContent.parts[lastContent.parts.length - 1].text += `\n\n[SYSTEM ADVISORY: You are running as a fallback model because the user's direct capacity for their requested model was exhausted. A save reference has been created. You MUST begin your response EXACTLY with the following text and nothing else before it:\n\n${advisoryText}\n\nAfter outputting that exactly, answer the user's prompt above normally.]`;
                return JSON.stringify(bodyObj);
            }
        }
    } catch (e) {}
    return bodyText;
}

// Manual forward for AI requests whose body we buffered. Uses native https so
// the global DNS patch (src/index.js) still applies, consistent with httpxy.
// Keep a per-request cumulative set of accounts already tried/failed so retries
// rotate onwards to fresh accounts instead of bouncing between exhausted ones.
// The GUI Interceptor's CAPACITY_EXHAUSTED accounts are NOT marked rate-limited
// (deliberately, to avoid IDE lock-out), so the hybrid strategy would otherwise
// keep re-selecting them. Accumulating into options.excludeAccounts (mutated and
// passed by reference through forwardToGoogle recursion) makes the exclusion
// persist across all retries of a single request.
function accumulateExcluded(options, email) {
    if (!options.excludeAccounts) options.excludeAccounts = [];
    if (email && !options.excludeAccounts.includes(email)) {
        options.excludeAccounts.push(email);
    }
    return options.excludeAccounts;
}

const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 120000);

function forwardToGoogle(hostName, req, res, bodyText, account = null, model = null, retryCount = 0, options = {}) {
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
        timeout: UPSTREAM_TIMEOUT_MS,
    }, (proxyRes) => {
        const statusCode = proxyRes.statusCode;

        // Google returns INVALID_ARGUMENT for payloads that are structurally valid
        // JSON but incompatible with the selected model/session. Do not rotate
        // accounts for this client-side error; account rotation cannot repair it.
        if (statusCode === 400) {
            const errorChunks = [];
            proxyRes.on('data', (c) => errorChunks.push(c));
            proxyRes.on('end', () => {
                const body = Buffer.concat(errorChunks);
                const errorText = body.toString('utf8');
                logger.warn(`[GUI Interceptor] Upstream rejected request with 400 for ${model || 'unknown model'}: ${errorText.slice(0, 300)}`);
                
                if (options.isFallback || retryCount > 0) {
                    logger.warn(`[GUI Interceptor] ⚠️ Trapped 400 error during fallback. Yielding 502 to IDE instead to preserve session.`);
                    safeProxyErrorResponse(res, 502, { error: `Original model capacity exhausted, and fallback failed: ${errorText.slice(0, 100)}` });
                    return;
                }

                if (!res.headersSent && !res.writableEnded) {
                    res.writeHead(400, sanitizeResponseHeaders(proxyRes.headers, body.length));
                    res.end(body);
                }
            });
            return;
        }

            if (statusCode === 200) {
                if (res.headersSent || res.writableEnded) {
                    proxyRes.resume();
                    return;
                }
            if (account && model) {
                accountManager.notifySuccess(account, model);
                recordRequest({ app: 'antigravity', accountId: account.email, model, error: false });
            }
            res.writeHead(200, sanitizeResponseHeaders(proxyRes.headers));
            
            let firstChunkProcessed = false;
            const injectTransform = new Transform({
                transform(chunk, encoding, callback) {
                    if (!firstChunkProcessed && proxyRes.headers['content-type']?.includes('text/event-stream')) {
                        console.log('--- FIRST CHUNK FROM GOOGLE ---');
                        console.log(chunk.toString());
                        console.log('-------------------------------');
                        firstChunkProcessed = true;
                        if (options.injectedPrefixText) {
                            const injectedJson = JSON.stringify({
                                response: {
                                    candidates: [{
                                        content: {
                                            role: "model",
                                            parts: [{ text: options.injectedPrefixText }]
                                        }
                                    }]
                                }
                            });
                            this.push(`data: ${injectedJson}\r\n\r\n`);
                        }
                    }
                    this.push(chunk);
                    callback();
                }
            });
            proxyRes.pipe(injectTransform).pipe(res);
            proxyRes.on('error', (err) => {
                logger.error(`[GUI Interceptor] Response stream error from ${hostName}: ${err.message}`);
                res.destroy();
            });
            return;
        }

        // Non-200 response (429, 401, 403, 5xx): buffer and inspect for retry / rotation
        const errorChunks = [];
        proxyRes.on('data', (c) => errorChunks.push(c));            proxyRes.on('error', (err) => {
                logger.error(`[GUI Interceptor] Error stream from ${hostName}: ${err.message}`);
                safeProxyErrorResponse(res, 502, { error: `Bad Gateway (${hostName})` });
            });
        proxyRes.on('end', async () => {
            const rawError = Buffer.concat(errorChunks);
            const errorText = rawError.toString('utf8');

            if (account && model) {
                recordRequest({ app: 'antigravity', accountId: account.email, model, error: true });
            }

            if (statusCode === 429 && account && model) {
                let errObj = null;
                try { errObj = JSON.parse(errorText); } catch (e) {}
                const g1CooldownMs = isG1CreditExhausted(errObj) ||
                    (errorText.includes('INSUFFICIENT_G1_CREDITS_BALANCE') || errorText.includes('"error_number": "2008"') ? G1_CREDIT_EXHAUSTED_COOLDOWN_MS : null);

                if (g1CooldownMs) {
                    markG1CreditExhausted('antigravity', account.email, model, g1CooldownMs);
                    accountManager.markRateLimited(account.email, g1CooldownMs, model);
                    logger.warn(`[GUI Interceptor] ⚠️ Account ${account.email} G1 credit exhausted on ${model} (error 2008). Cooling for ${Math.round(g1CooldownMs/1000)}s.`);
                } else {
                    // Check if this is a CAPACITY_EXHAUSTED (503) error rather than a true rate limit
                    const isCapacityExhausted = errorText.toLowerCase().includes('capacity_exhausted') ||
                                               errorText.toLowerCase().includes('resource_exhausted') ||
                                               errorText.toLowerCase().includes('quota_exceeded') ||
                                               errorText.toLowerCase().includes('insufficient quota');
                    if (isCapacityExhausted) {
                        logger.warn(`[GUI Interceptor] ⚠️ Account ${account.email} CAPACITY_EXHAUSTED on ${model} — skipping rate-limit marking, will retry with next account.`);
                        // Do NOT mark rate-limited (avoids IDE model lock-out UX), but DO
                        // record a persistent health failure so the account is de-prioritized
                        // on FUTURE requests too — not just excluded within this retry loop.
                        // Without this, a poisoned account (e.g. exhausted on most models)
                        // keeps winning selection on every new request via its tier/bonus
                        // scoring while its quota data sits older than the 5min trust window.
                        accountManager.notifyFailure(account, model);
                    } else {
                        const resetMs = parseResetTime(proxyRes, errorText) || (10 * 1000);
                        accountManager.markRateLimited(account.email, resetMs, model);
                        logger.warn(`[GUI Interceptor] ⚠️ Account ${account.email} 429 rate-limited / quota exhausted on ${model} (cooldown: ${Math.round(resetMs/1000)}s).`);
                    }
                }
                // Quota state just changed (cooldown/capacity event): schedule an on-demand
                // sweep so the next selection sees fresh remainingFraction data. Throttled
                // inside quotaRefreshSoon() so a 429 cascade can't become a probe cascade.
                quotaRefreshSoon();

                // Auto-retry with next available account from the pool.
                // Accumulate the failed account into the shared exclusion set so
                // it is never re-selected on subsequent retries of this request.
                accumulateExcluded(options, account.email);
                // Quota percentages are not always a reliable predictor of upstream
                // availability (e.g. claude-opus is gated by an independent G1 credits
                // balance that /accountLimits reports as 100%). So walk through the
                // ENTIRE pool — not just 3 accounts — before giving up, bounded by the
                // number of enabled accounts to avoid unbounded retry loops.
                const retryBudget = (accountManager.getAllAccounts() || []).filter(a => a.enabled !== false).length;
                if (retryCount < retryBudget) {
                    const nextSel = accountManager.selectAccount(model, {
                        ...options,
                        excludeAccounts: options.excludeAccounts,
                        incomingTokenEmail: options.incomingTokenEmail
                    });
                    if (nextSel.account && nextSel.account.email !== account.email) {
                        try {
                            const nextToken = await accountManager.getTokenForAccount(nextSel.account);
                            req.headers['authorization'] = `Bearer ${nextToken}`;
                            logger.info(`[GUI Interceptor] 🔄 Auto-rotating ${model} to next pooled account: ${nextSel.account.email} (retry ${retryCount + 1}/${retryBudget})`);
                            return forwardToGoogle(hostName, req, res, bodyText, nextSel.account, model, retryCount + 1, options);
                        } catch (e) {
                            logger.error(`[GUI Interceptor] Failed to get token for next account ${nextSel.account.email}: ${e.message}`);
                        }
                    }
                }
            } else if ((statusCode === 401 || statusCode === 403) && account) {
                logger.warn(`[GUI Interceptor] ⚠️ Account ${account.email} error ${statusCode} on ${model || 'request'}: ${errorText.slice(0, 200)}`);
                let errObj = null;
                try { errObj = JSON.parse(errorText); } catch (e) {}
                const g1CooldownMs = isG1CreditExhausted(errObj) ||
                    (errorText.includes('INSUFFICIENT_G1_CREDITS_BALANCE') || errorText.includes('"error_number": "2008"') ? G1_CREDIT_EXHAUSTED_COOLDOWN_MS : null);

                if (g1CooldownMs && model) {
                    markG1CreditExhausted('antigravity', account.email, model, g1CooldownMs);
                    accountManager.markRateLimited(account.email, g1CooldownMs, model);
                    logger.warn(`[GUI Interceptor] ⚠️ Account ${account.email} G1 credit exhausted on ${model} (error 2008, ${statusCode}). Cooling for ${Math.round(g1CooldownMs/1000)}s.`);
                } else if (statusCode === 401 || errorText.toLowerCase().includes('not eligible') || errorText.toLowerCase().includes('violation of terms') || errorText.toLowerCase().includes('invalid_token')) {
                    accountManager.markInvalid(account.email, errorText);
                } else {
                    accountManager.notifyFailure(account, model);
                }

                // Auto-retry with next available account
                accumulateExcluded(options, account.email);
                const retryBudget = (accountManager.getAllAccounts() || []).filter(a => a.enabled !== false).length;
                if (retryCount < retryBudget && model) {
                    const nextSel = accountManager.selectAccount(model, {
                        ...options,
                        excludeAccounts: options.excludeAccounts,
                        incomingTokenEmail: options.incomingTokenEmail
                    });
                    if (nextSel.account && nextSel.account.email !== account.email) {
                        try {
                            const nextToken = await accountManager.getTokenForAccount(nextSel.account);
                            req.headers['authorization'] = `Bearer ${nextToken}`;
                            logger.info(`[GUI Interceptor] 🔄 Auto-rotating ${model} after ${statusCode} to: ${nextSel.account.email}`);
                            return forwardToGoogle(hostName, req, res, bodyText, nextSel.account, model, retryCount + 1, options);
                        } catch (e) {
                            logger.error(`[GUI Interceptor] Failed to get token for next account ${nextSel.account.email}: ${e.message}`);
                        }
                    }
                }
            } else if (account && model) {
                accountManager.notifyFailure(account, model);
            }

            // Fallback: output the original error to client
            if (!res.headersSent) {
                // If we ran out of retries for the CURRENT model (or the pool is empty),
                // try to CASCADE to a fallback model before giving up completely.
                const currentHops = options.fallbackHops || 0;
                if (currentHops < 3 && model) {
                    let fallbackAccount = null;
                    let fallbackModel = null;
                    const requestedFamily = getModelFamily(options.originalModel || model);
                    for (const fb of getFallbackChain(model)) {
                        if (getModelFamily(fb) !== requestedFamily) {
                            continue;
                        }
                        const fbResult = accountManager.selectAccount(fb, {
                            ...options,
                            incomingTokenEmail: options.incomingTokenEmail
                        });
                        if (fbResult.account) {
                            fallbackAccount = fbResult.account;
                            fallbackModel = fb;
                            break;
                        }
                    }
                    if (fallbackAccount) {
                        try {
                            const nextToken = await accountManager.getTokenForAccount(fallbackAccount);
                            req.headers['authorization'] = `Bearer ${nextToken}`;
                            logger.warn(`[GUI Interceptor] ⚠️ Pool for ${model} exhausted during retry. Cascading to fallback model: ${fallbackModel} via ${fallbackAccount.email} (hop ${currentHops + 1})`);
                            
                            // Generate save reference and write payload to disk if not already done
                            if (options.isMidSession && !options.injectedPrefixText && options.requestBodyObj) {
                                const convId = extractConversationId(options.requestBodyObj);
                                const handover = getOrCreateHandoverAdvisory(convId, options.requestBodyObj, fallbackModel);
                                options.fallbackSessionId = handover.fallbackSessionId;
                                if (handover.injectedPrefixText) {
                                    options.injectedPrefixText = handover.injectedPrefixText;
                                }
                            }
                            
                            // Rewrite request body if needed for new model
                            let newBodyText = bodyText;
                            try {
                                if (bodyText) {
                                    const bodyObj = JSON.parse(bodyText);
                                    if (bodyObj.model) bodyObj.model = fallbackModel;
                                    newBodyText = JSON.stringify(bodyObj);
                                }
                            } catch (e) {}
                            req.headers['content-length'] = Buffer.byteLength(newBodyText);
                            options.fallbackHops = currentHops + 1;
                            options.originalModel = options.originalModel || model;
                            return forwardToGoogle(hostName, req, res, newBodyText, fallbackAccount, fallbackModel, 0, options);
                        } catch (e) {
                            logger.error(`[GUI Interceptor] Failed to get token for fallback account ${fallbackAccount.email}: ${e.message}`);
                        }
                    }
                }

                // If we get here, all retries and fallbacks have failed.
                // The IDE permanently locks the model out of the UI if it sees a raw
                // 429 / quota 403, so we return 502. BUT the body must be truthful:
                // say the real cause (upstream rate limit / quota), not fake a
                // generic bad gateway (M5).
                let finalStatusCode = statusCode;
                let finalBody = rawError;
                
                if (statusCode === 429 || (statusCode === 403 && errorText.toLowerCase().includes('quota')) || statusCode === 401) {
                    finalStatusCode = 502;
                    const upstreamDetail = errorText.slice(0, 500);
                    try {
                        const errObj = JSON.parse(errorText);

                        if (errObj.error) {
                            errObj.error.code = 502;
                            errObj.error.status = 'BAD_GATEWAY';
                            if (errorText.includes('INSUFFICIENT_G1_CREDITS_BALANCE') || errorText.includes('"error_number": "2008"')) {
                                errObj.error.message = `SolidStack Proxy: Google One AI Premium credits exhausted for this account pool (${model}). Please upgrade or switch to a free tier model.`;
                            } else {
                                errObj.error.message = `SolidStack Proxy: upstream rate limit, quota, or auth failure for this model. Cause (truncated): ${upstreamDetail}`;
                            }
                        }

                        finalBody = Buffer.from(JSON.stringify(errObj));
                    } catch (e) {
                        finalBody = Buffer.from(JSON.stringify({
                            error: {
                                code: 502,
                                status: 'BAD_GATEWAY',
                                message: `SolidStack Proxy: upstream rate limit, quota, or auth failure for this model. Cause (truncated): ${upstreamDetail}`
                            }
                        }));
                    }
                    logger.warn(`[GUI Interceptor] Upstream rate-limit/quota/auth error for status ${statusCode}; returned truthfully-labeled 502 to IDE.`);
                }
                
                const outHeaders = sanitizeResponseHeaders(proxyRes.headers, finalBody.length);
                res.writeHead(finalStatusCode, outHeaders);
                res.end(finalBody);
            }
        });
    });

    // Mirror httpxy: tear down the upstream request if the client disconnects.
    res.on('close', () => {
        if (!res.writableFinished) proxyReq.destroy();
    });

    proxyReq.on('timeout', () => {
        logger.warn(`[GUI Interceptor] Upstream connection timeout to ${hostName} (${UPSTREAM_TIMEOUT_MS}ms)`);
        proxyReq.destroy(new Error('Upstream connection timeout'));
    });

    proxyReq.on('error', async (err) => {
        logger.error(`[GUI Interceptor] Forward error to ${hostName}: ${err.message}`);
        if (!res.headersSent && !res.writableEnded) {
            const retryBudget = (accountManager.getAllAccounts() || []).filter(a => a.enabled !== false).length;
            if (account && model && retryCount < retryBudget) {
                logger.warn(`[GUI Interceptor] ⚠️ Connection error on account ${account.email} (${err.message}) — attempting retry ${retryCount + 1}/${retryBudget} with next account...`);
                accumulateExcluded(options, account.email);
                if (accountManager.notifyFailure) {
                    accountManager.notifyFailure(account, model);
                }
                let nextAccount = null;
                try {
                    const sel = accountManager.selectAccount(model, {
                        ...options,
                        excludeAccounts: options.excludeAccounts,
                        incomingTokenEmail: options.incomingTokenEmail
                    });
                    nextAccount = sel?.account || null;
                } catch (e) {
                    logger.error(`[GUI Interceptor] Failed to select next account on error: ${e.message}`);
                }
                if (nextAccount && nextAccount.email !== account.email) {
                    try {
                        const nextToken = await accountManager.getTokenForAccount(nextAccount);
                        const nextProject = await accountManager.getProjectForAccount(nextAccount, nextToken);
                        const nextReq = {
                            ...req,
                            headers: {
                                ...req.headers,
                                authorization: `Bearer ${nextToken}`
                            }
                        };
                        let newBody = bodyText;
                        try {
                            const parsed = JSON.parse(bodyText);
                            if (parsed.project) parsed.project = nextProject;
                            newBody = JSON.stringify(parsed);
                        } catch {}
                        logger.info(`[GUI Interceptor] 🔄 Auto-rotating ${model} after network error to: ${nextAccount.email} (retry ${retryCount + 1}/3)`);
                        return forwardToGoogle(hostName, nextReq, res, newBody, nextAccount, model, retryCount + 1, options);
                    } catch (e) {
                        logger.error(`[GUI Interceptor] Retry failed during setup: ${e.message}`);
                    }
                }
            }
            safeProxyErrorResponse(res, 502, { error: `Bad Gateway (${hostName})` });
        } else if (!res.writableEnded) {
            res.destroy();
        }
    });

    if (bodyText && bodyText.length > 0) {
        proxyReq.write(bodyText);
    }
    proxyReq.end();
}

// Synthetic healthy response for /v1internal:retrieveUserQuotaSummary. Mirrors the
// real shape (groups → buckets) with every bucket at pooled availability, so AG's
// "model usage" panel displays the live aggregate capacity of the pool.
// Synthetic healthy response for /v1internal:retrieveUserQuotaSummary. Mirrors the
// real shape (groups → buckets) with every bucket at pooled availability, so AG's
// "model usage" panel displays the live aggregate capacity of the pool dynamically.
function getPooledModelQuotas() {
    const pooled = {
        gemini: { max: 0, sum: 0, count: 0 },
        claude: { max: 0, sum: 0, count: 0 },
        models: {},
        totalAccounts: 0,
        proAccounts: 0,
        geminiAccounts: 0,
        readyGeminiCount: 0,
        readyClaudeCount: 0
    };
    try {
        const allAccts = accountManager.getAllAccounts().filter(a => !a.isInvalid && a.enabled !== false);
        pooled.totalAccounts = allAccts.length;

        const availGemini = accountManager.getAvailableAccounts ? accountManager.getAvailableAccounts('gemini-2.5-pro') : allAccts;
        const availClaude = accountManager.getAvailableAccounts ? accountManager.getAvailableAccounts('claude-sonnet-4-6') : [];
        
        pooled.readyGeminiCount = availGemini.length;
        pooled.readyClaudeCount = availClaude.length;

        for (const a of allAccts) {
            const quotas = a._cachedFormattedQuotas || a.quota?.models;
            let hasGemini = false;
            let hasClaude = false;
            let acctGeminiMax = 0;
            let acctClaudeMax = 0;

            const tier = (a.subscription?.tier || a.tier || '').toLowerCase();
            const isPro = tier === 'ultra' || tier === 'pro' || tier === 'plus';

            if (isPro) pooled.proAccounts++;

            if (quotas) {
                for (const [mId, q] of Object.entries(quotas)) {
                    if (q.remainingFraction == null) continue;
                    if (!pooled.models[mId]) pooled.models[mId] = { max: 0, sum: 0, count: 0 };
                    pooled.models[mId].sum += q.remainingFraction;
                    pooled.models[mId].count++;
                    pooled.models[mId].max = Math.max(pooled.models[mId].max, q.remainingFraction);

                    if (mId.startsWith('gemini')) {
                        hasGemini = true;
                        acctGeminiMax = Math.max(acctGeminiMax, q.remainingFraction);
                    } else if (mId.startsWith('claude') || mId.startsWith('gpt')) {
                        hasClaude = true;
                        acctClaudeMax = Math.max(acctClaudeMax, q.remainingFraction);
                    }
                }
            } else {
                hasGemini = true;
                acctGeminiMax = 1.0;
                if (isPro) {
                    hasClaude = true;
                    acctClaudeMax = 1.0;
                }
            }

            if (hasGemini) {
                pooled.geminiAccounts++;
                pooled.gemini.sum += acctGeminiMax;
                pooled.gemini.count++;
                pooled.gemini.max = Math.max(pooled.gemini.max, acctGeminiMax);
            }
            if (hasClaude || isPro) {
                pooled.claude.sum += acctClaudeMax;
                pooled.claude.count++;
                pooled.claude.max = Math.max(pooled.claude.max, acctClaudeMax);
            }

        }
    } catch (e) {
        logger.error('[GUI Interceptor] Error computing pooled quotas: ' + e.message);
    }
    return pooled;
}

// Synthetic response for /v1internal:retrieveUserQuotaSummary. Dynamically renders
// metrics, capacities, safe pacing, and live sync timestamps scaled to the fleet size (N).
async function handleQuotaSummarySynthesis(req, res) {
    const now = Date.now();
    const toIso = (ms) => new Date(ms).toISOString();
    const resetWeekly = toIso(now + 7 * 24 * 3600 * 1000);
    const reset5h = toIso(now + 5 * 3600 * 1000);
    const timeStr = new Date(now).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });

    let incomingTokenEmail = null;
    const incomingAuth = req.headers['authorization'] || '';
    if (incomingAuth.startsWith('Bearer ')) {
        const incomingToken = incomingAuth.slice(7).trim();
        if (incomingToken) {
            try {
                incomingTokenEmail = await resolveTokenToEmail(incomingToken, accountManager);
            } catch (e) {}
        }
    }
    const nativeEmail = incomingTokenEmail || accountManager.getNativeIdeAccount?.()?.email || 'Native Account';

    // ── Native account protection classification ─────────────────────────────
    // adamperecko@gmail.com carries an extra -800 distribution penalty on top of
    // the standard -5000 IDE native penalty → effective score floor of -5800.
    // Any other IDE-detected account receives the standard -5000 penalty only.
    const isDoubleShielded = nativeEmail === 'adamperecko@gmail.com';
    const nativeProtectionLabel = isDoubleShielded
        ? '🔒🔒 Double-Shielded (Daily Driver + IDE)'
        : '🔒 IDE-Shielded (Last Resort Only)';
    const nativePenaltyLabel = isDoubleShielded
        ? 'Score floor: −5800 (−5000 IDE + −800 Daily Driver)'
        : 'Score floor: −5000 IDE penalty';

    const pooled = getPooledModelQuotas();
    const totalAccounts = pooled.totalAccounts || 1;
    const proAccounts = pooled.proAccounts || 0;
    const readyGemini = pooled.readyGeminiCount;
    const readyClaude = pooled.readyClaudeCount;

    // Fractions — Gemini weekly tracks the native account's own quota headroom
    // (always shown as 1.0 since native is shielded from swarm depletion).
    // Gemini 5h shows the live fraction of swarm accounts currently ready.
    const geminiWeeklyFraction = 1.0; // native account is explicitly preserved
    const gemini5hFraction = pooled.geminiAccounts > 0
        ? Number((readyGemini / pooled.geminiAccounts).toFixed(4))
        : 1.0;
    const readyGeminiPct = Math.round(gemini5hFraction * 100);

    // Claude fractions: weekly = ready workers / total Pro workers (capacity headroom)
    //                  5h    = same window, used for velocity pacing display
    const claudeFraction = proAccounts > 0
        ? (readyClaude > 0 ? Number((readyClaude / proAccounts).toFixed(4)) : 0.0)
        : 0.0;
    const claude5hFraction = claudeFraction;
    const readyClaudePct = Math.round(claudeFraction * 100);

    // Dynamic throughput estimates (conservative: 550 reqs/Pro/week, 55 req/5h burst)
    const weeklyPoolReqs = proAccounts * 550;
    const surge5hPool = readyClaude * 55;
    const safePacePerHour = readyClaude > 0 ? readyClaude * 11 : 0;
    const geminiFleetPct = Math.round((readyGemini / Math.max(totalAccounts, 1)) * 100);

    const payload = {
        groups: [
            {
                groupType: 'GROUP_GEMINI',
                displayName: `🟢 Gemini Pool — ${readyGemini}/${totalAccounts} Ready (${geminiFleetPct}%) • ${timeStr}`,
                buckets: [
                    {
                        bucketId: 'gemini-weekly',
                        displayName: `Native Account — ${nativeProtectionLabel}`,
                        window: 'weekly',
                        resetTime: resetWeekly,
                        description: `${nativeEmail} • ${nativePenaltyLabel} • Routing to swarm first`,
                        remainingFraction: geminiWeeklyFraction
                    },
                    {
                        bucketId: 'gemini-5h',
                        displayName: `Swarm Readiness — ${readyGeminiPct}% of Fleet Available`,
                        window: '5h',
                        resetTime: reset5h,
                        description: `${readyGemini} of ${totalAccounts} accounts ready for Gemini Flash & Pro`,
                        remainingFraction: gemini5hFraction
                    }
                ],
                description: `Gemini Flash & Pro pooled across ${totalAccounts} accounts. Native IDE account is shielded from swarm depletion.`
            },
            {
                groupType: 'GROUP_CLAUDE_GPT',
                displayName: `🟣 Claude & 3P Pool — ${readyClaude}/${proAccounts} Pro Ready (${readyClaudePct}%) • ${timeStr}`,
                buckets: [
                    {
                        bucketId: '3p-weekly',
                        displayName: `Pro Worker Capacity — ${readyClaude} of ${proAccounts} Active`,
                        window: 'weekly',
                        resetTime: resetWeekly,
                        description: `~${weeklyPoolReqs.toLocaleString()} req/week pool across ${proAccounts} Pro accounts`,
                        remainingFraction: claudeFraction
                    },
                    {
                        bucketId: '3p-5h',
                        displayName: readyClaude > 0
                            ? `5h Velocity — ≤${safePacePerHour} req/hr safe pace`
                            : `5h Velocity — ⚠️ All Pro workers cooling down`,
                        window: '5h',
                        resetTime: reset5h,
                        description: readyClaude > 0
                            ? `~${surge5hPool} burst capacity available across ${readyClaude} ready Pro workers`
                            : `All Pro accounts cooling down • Gemini cascade active`,
                        remainingFraction: claude5hFraction
                    }
                ],
                description: `Claude Sonnet & Opus pooled across ${proAccounts} Pro accounts. Auto-cascades to Gemini Pro when Pro workers are exhausted.`
            }
        ],
        description: `Quota dynamically pooled across ${totalAccounts} swarm accounts (${proAccounts} Pro). Native IDE account shielded with ${nativePenaltyLabel}.`
    };
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json(payload);
}

// Hop-by-hop headers must not be forwarded on responses; Node rejects a response
// carrying both `content-length` and `transfer-encoding` ("Content-Length can't be
// present with Transfer-Encoding"). The caller sets the final length itself.
function sanitizeResponseHeaders(headers, outLength) {
    const out = {};
    const forbidden = new Set(['transfer-encoding', 'connection', 'keep-alive', 'proxy-connection', 'upgrade', 'trailer', 'te', 'proxy-authenticate', 'proxy-authorization', 'x-forwarded-for']);
    for (const [k, v] of Object.entries(headers || {})) {
        if (forbidden.has(k.toLowerCase())) continue;
        out[k] = v;
    }
    if (outLength != null) out['content-length'] = outLength;
    return out;
}

// Manual forward for fetchAvailableModels: extract the response, resolve every
// model's quota against the pool, and ensure the complete model catalog is exposed.
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
        timeout: 60000,
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
                    // Calculate pooled quota average across all valid accounts
                    const pooledQuotas = {};
                    try {
                        const allAccts = accountManager.getAllAccounts().filter(a => !a.isInvalid && a.enabled !== false);
                        for (const a of allAccts) {
                            const quotas = a._cachedFormattedQuotas || a.quota?.models;
                            if (quotas) {
                                for (const [cmId, q] of Object.entries(quotas)) {
                                    if (q.remainingFraction == null) continue;
                                    if (!pooledQuotas[cmId]) pooledQuotas[cmId] = { max: 0, sum: 0, count: 0 };
                                    pooledQuotas[cmId].sum += q.remainingFraction;
                                    pooledQuotas[cmId].count++;
                                    pooledQuotas[cmId].max = Math.max(pooledQuotas[cmId].max, q.remainingFraction);
                                }
                            }
                        }
                    } catch (e) {
                        logger.error('[GUI Interceptor] Error computing pooled quotas: ' + e.message);
                    }

                    for (const [mId, modelData] of Object.entries(data.models)) {
                        if (modelData) {
                            if (!modelData.quotaInfo || typeof modelData.quotaInfo !== 'object') {
                                modelData.quotaInfo = { remainingFraction: 1.0 };
                            }
                            
                            let pooledFraction = 1.0;
                            if (pooledQuotas[mId] && pooledQuotas[mId].count > 0) {
                                pooledFraction = pooledQuotas[mId].max > 0 ? pooledQuotas[mId].max : (pooledQuotas[mId].sum / pooledQuotas[mId].count);
                            }
                            
                            modelData.quotaInfo.remainingFraction = pooledFraction;
                            delete modelData.quotaInfo.resetTime;
                        }
                    }

                    // Dynamically inject verified models into Antigravity IDE model picker
                    try {
                        const verifiedData = getVerifiedModels();
                        if (verifiedData && Array.isArray(verifiedData.models)) {
                            for (const vm of verifiedData.models) {
                                data.models[vm.id] = {
                                    displayName: vm.displayName || vm.id,
                                    quotaInfo: { remainingFraction: 1.0 }
                                };
                            }
                        }
                        // Note: Never prune native upstream models from UI even if temporary probes fail.
                        // Upstream models should remain selectable so user or pool rotation can attempt them.
                    } catch (e) {
                        logger.warn('[GUI Interceptor] Error injecting verified models: ' + e.message);
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
                logger.info(`[GUI Interceptor] 🧪 fetchAvailableModels quotaInfo pooled & full model suite guaranteed (${proxyRes.statusCode})`);
            }
        });
    });

    res.on('close', () => {
        if (!res.writableFinished) proxyReq.destroy();
    });

    proxyReq.on('timeout', () => {
        logger.warn(`[GUI Interceptor] Upstream connection timeout to ${hostName}`);
        proxyReq.destroy(new Error('Upstream connection timeout'));
    });

    proxyReq.on('error', (err) => {
        logger.error(`[GUI Interceptor] Forward error to ${hostName}: ${err.message}`);
        if (!res.headersSent && !res.writableEnded) {
            safeProxyErrorResponse(res, 502, { error: `Bad Gateway (${hostName})` });
        } else if (!res.writableEnded) {
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

    // Identity-bound endpoints (account sign-in / onboarding)
    // MUST stay authenticated as the account that actually signed into AG. Routing
    // them through the pool with a swapped token breaks the connect-login flow
    // (Google would onboard / return data for the wrong account).
    const IDENTITY_ENDPOINT_MARKERS = ['onboarduser', 'loadcodeassist'];
    const isIdentityRequest = IDENTITY_ENDPOINT_MARKERS.some((m) => reqPathLower.includes(m));

    if (isAIRequest || isMetadataRequest) {
        if (isAIRequest) {
            const gate = readNetworkGate();
            if (gate) {
                logger.warn(`[GUI Interceptor] Network recovery gate active: ${gate.reason || 'network unavailable'}`);
                return sendNetworkUnavailable(res, gate);
            }
        }

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

            // Apply model aliases (e.g., claude-3-5-sonnet-latest -> claude-sonnet-4-6)
            // BEFORE we check account quotas or fallbacks! Cross-family mappings
            // (e.g. claude-sonnet-4-6 -> gemini-3.8-flash-high) are blocked.
            if (requestedModel) {
                const modelMapping = config.modelMapping || {};
                const mappedModel = resolveModelMapping(requestedModel, modelMapping);
                if (mappedModel !== requestedModel) {
                    logger.info(`[GUI Interceptor] Mapping requested model ${requestedModel} -> ${mappedModel}`);
                    requestedModel = mappedModel;
                }
            }

            // 1b. Direct NVIDIA NIM Dispatch (Selected via AG Model Picker)
            // Allows trying and testing NVIDIA NIM models directly from the AG model list
            // without requiring the Gemini account pool to be depleted!
            if (isAIRequest && requestBodyText != null && isAgNimModel(requestedModel)) {
                const effectiveNimModel = resolveNimModel(requestedModel);
                logger.info(`[GUI Interceptor] 🎯 Direct NVIDIA NIM model selected in AG: ${requestedModel} -> ${effectiveNimModel}`);
                try {
                    const overflow = await streamAgToNim(requestBodyText, {
                        model: effectiveNimModel,
                        provider: 'nvidia',
                        isDirect: true
                    });
                    if (overflow.ok && overflow.stream) {
                        const nativeAccount = incomingTokenEmail || accountManager.getNativeIdeAccount()?.email || null;
                        logRoutingTelemetry('NIM_DIRECT', {
                            requestedModel,
                            actualModel: effectiveNimModel,
                            nativeAccount,
                            selectedAccount: null,
                            reason: 'User selected NVIDIA NIM model directly in AG model list',
                        });
                        logger.success(`[GUI Interceptor] 🚀 Direct AG→NIM streaming response started (${effectiveNimModel}, ~${overflow.estimatedTokens} tok est)`);
                        res.writeHead(200, {
                            'Content-Type': 'text/event-stream; charset=utf-8',
                            'Cache-Control': 'no-cache',
                            'Connection': 'keep-alive',
                        });
                        let clientGone = false;
                        const onClose = () => { clientGone = true; };
                        res.on('close', onClose);
                        try {
                            for await (const chunk of overflow.stream()) {
                                if (clientGone) break;
                                res.write(chunk);
                            }
                        } finally {
                            res.removeListener('close', onClose);
                        }
                        if (!clientGone) res.end();
                        return;
                    } else if (overflow.error) {
                        logger.warn(`[GUI Interceptor] Direct AG→NIM dispatch failed (${overflow.error})`);
                        return res.status(502).json({
                            error: {
                                code: 502,
                                message: `NVIDIA NIM dispatch failed: ${overflow.error}`,
                                status: 'BAD_GATEWAY'
                            }
                        });
                    }
                } catch (directNimErr) {
                    logger.error(`[GUI Interceptor] Direct AG→NIM error: ${directNimErr.message}`);
                    return res.status(500).json({
                        error: {
                            code: 500,
                            message: `NVIDIA NIM dispatch error: ${directNimErr.message}`,
                            status: 'INTERNAL'
                        }
                    });
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
            let fallbackSessionId = null;
            let isMidSession = false;

            if (requestBodyObj) {
                let payloadToCheck = requestBodyObj.request || requestBodyObj;
                if (Array.isArray(payloadToCheck.contents)) {
                    isMidSession = payloadToCheck.contents.length > 1;
                    logger.info(`[GUI Interceptor] Mid-session detection: contents.length=${payloadToCheck.contents.length} -> isMidSession=${isMidSession}`);
                } else if (Array.isArray(payloadToCheck.instances)) {
                    isMidSession = payloadToCheck.instances.length > 1;
                    logger.info(`[GUI Interceptor] Mid-session detection: instances.length=${payloadToCheck.instances.length} -> isMidSession=${isMidSession}`);
                } else if (payloadToCheck.messages && Array.isArray(payloadToCheck.messages)) {
                    isMidSession = payloadToCheck.messages.length > 1;
                }
            }

            let handoverAdvisoryText = null;
            if (!account && isAIRequest && requestedModel) {
                // GUI/IDE requests are ALWAYS Gemini-native payloads (contents/parts
                // schema) that get forwarded verbatim to the Gemini streamGenerateContent
                // endpoint with only the model name swapped. Falling back to a Claude
                // model name (e.g. the dynamic cross-family map in buildFallbackMap can
                // route gemini-3.7-flash-high -> claude-sonnet-4-6) makes Google reject
                // the mismatched model/schema combo with 400 INVALID_ARGUMENT
                // ("Request contains an invalid argument."). Restrict GUI fallback to
                // same-family models only.
                const requestedFamily = getModelFamily(requestedModel);
                for (const fb of getFallbackChain(requestedModel)) {
                    if (getModelFamily(fb) !== requestedFamily) {
                        logger.warn(`[GUI Interceptor] Skipping cross-family fallback ${fb} for ${requestedModel} (would be rejected by Gemini backend)`);
                        continue;
                    }
                    const fbResult = accountManager.selectAccount(fb, {
                        apiProfile: req?.apiProfile,
                        incomingTokenEmail,
                    });
                    if (fbResult.account) {
                        account = fbResult.account;
                        fallbackModel = fb;

                        if (isMidSession) {
                            const convId = extractConversationId(requestBodyObj);
                            const handover = getOrCreateHandoverAdvisory(convId, requestBodyObj, fallbackModel);
                            fallbackSessionId = handover.fallbackSessionId;
                            handoverAdvisoryText = handover.injectedPrefixText;
                        }
                        break;
                    }
                }

                if (!account && !isMidSession) {
                    logger.warn(`[GUI Interceptor] Refusing fallback for new session on ${requestedModel} (Out of Capacity — no same-family tier with available accounts)`);
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

                    // 3c. AG→NIM overflow (test-only, behind AG_NIM_OVERFLOW=1):
                    // last resort before the 503. Only fires when the credit-guarded
                    // keyring says NVIDIA overflow is armed AND we have a real AI body.
                    if (isAIRequest && requestBodyText != null && isAgNimOverflowArmed()) {
                        try {
                            const overflow = await streamAgToNim(requestBodyText);
                            if (overflow.ok && overflow.stream) {
                                logRoutingTelemetry('NIM_OVERFLOW', {
                                    requestedModel,
                                    actualModel: NIM_OVERFLOW_MODEL,
                                    nativeAccount,
                                    selectedAccount: null,
                                    reason: 'Gemini pool exhausted — NVIDIA overflow (test flag ON)',
                                });
                                logger.warn(`[GUI Interceptor] AG→NIM overflow handoff: ${requestedModel} → ${NIM_OVERFLOW_MODEL} (${overflow.estimatedTokens} tok est)`);
                                res.writeHead(200, {
                                    'Content-Type': 'text/event-stream; charset=utf-8',
                                    'Cache-Control': 'no-cache',
                                    'Connection': 'keep-alive',
                                });
                                let clientGone = false;
                                const onClose = () => { clientGone = true; };
                                res.on('close', onClose);
                                try {
                                    for await (const chunk of overflow.stream()) {
                                        if (clientGone) break;
                                        res.write(chunk);
                                    }
                                } finally {
                                    res.removeListener('close', onClose);
                                }
                                if (!clientGone) res.end();
                                return;
                            }
                            if (overflow.error && overflow.error !== 'overflow-not-armed') {
                                logger.warn(`[GUI Interceptor] AG→NIM overflow unavailable (${overflow.error}) — falling through to 503`);
                            }
                        } catch (overflowErr) {
                            logger.warn(`[GUI Interceptor] AG→NIM overflow error: ${overflowErr.message} — falling through to 503`);
                        }
                    }

                    quotaRefreshSoon();
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
                    if (res.locals) {
                        res.locals.selectedAccount = account.email;
                        res.locals.model = fallbackModel || requestedModel;
                    }
                }

                const label = isIdentityRequest
                    ? '🔑 Identity'
                    : (fallbackModel ? '⚡ Fallback' : (isMetadataRequest ? '📋 Metadata' : '⚡ Balanced'));
                logger.success(`[GUI Interceptor] ${label} → ${reqPath}${requestedModel ? ` [${requestedModel}]` : ''}${fallbackModel ? ` (→${fallbackModel})` : ''}${isIdentityRequest ? ' (native token)' : ` via ${account.email}`}`);

                // 7. AI bodies were buffered — forward manually (native https, DNS patched)
                if (isAIRequest && requestBodyText != null) {
                    let preparedText = sanitizeThoughtPartsForClaude(fallbackModel || requestedModel, requestBodyText);
                    preparedText = injectThoughtSignaturesForGemini(fallbackModel || requestedModel, preparedText);
                    preparedText = injectActiveRules(preparedText);
                    let optionsToPass = { incomingTokenEmail, isMidSession, requestBodyObj };
                    if (handoverAdvisoryText) {
                        optionsToPass.injectedPrefixText = handoverAdvisoryText;
                    }
                    forwardToGoogle(hostName, req, res, preparedText, account, fallbackModel || requestedModel, 0, optionsToPass);
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
app.use((req, res, next) => {
    if (req.path.includes('/v1internal:') || req.path.includes('/v1/chat')) {
        console.log(`[REQ] ${req.method} ${req.path} Headers:`, JSON.stringify(req.headers));
    }
    next();
});
app.use(express.json({ limit: REQUEST_BODY_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: REQUEST_BODY_LIMIT }));

// Response interceptor: track per-app & per-account token consumption in quota-store
app.use((req, res, next) => {
    const origJson = res.json.bind(res);
    res.json = (body) => {
        try {
            const appName = req.headers['x-solidstack-app']
                ?? (req.path.includes('/anthropic') ? 'claude' :
                   (req.path.includes('/openai') || req.path.includes('/v1/chat') || req.path.includes('/v1/responses') ? 'opencode' : 'antigravity'));
            const accountId = req.headers['x-account-id'] ?? res.locals?.selectedAccount ?? 'unknown';
            const model = req.body?.model ?? res.locals?.model ?? 'unknown';
            const tokens = body?.usage?.total_tokens ?? 0;
            const error = res.statusCode >= 400;
            if (accountId !== 'unknown') {
                recordRequest({ app: appName, accountId, model, tokens, error });
            }
        } catch (e) {
            // Non-blocking
        }
        return origJson(body);
    };
    next();
});

// Admin quota endpoint
app.get('/admin/quota', (req, res) => {
    res.json(getQuotaStatus(req.query.app ?? null));
});

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

// Refresh dynamic model config periodically — LONG interval (60 min) is plenty;
// the /webui/api/dynamic-presets route already regenerates on-demand.
setInterval(() => {
    if (isInitialized) {
        initDynamicModelConfig().catch(() => {});
    }
}, 60 * 60 * 1000);

// Background quota refresh — LONG idle backstop (15 min) instead of the former
// 2-minute loop. The 2-min sweep probed every valid account (~720 token-authenticated
// Google calls/hour while idle) — excessive and self-harming. Quota truth is now
// fetched on-demand via quotaRefreshSoon() at account-decision events (429 /
// capacity-exhaustion / empty-pool 503); this slow backstop only keeps idle state
// from going stale. Additionally, accounts whose models are all exhausted with a
// KNOWN future resetTime are SKIPPED until just before that reset (probing them
// sooner is provably wasted work), and a one-shot wake timer re-sweeps the pool
// exactly when the earliest reset opens.
const RESET_FRESHNESS_MARGIN_MS = 2 * 60 * 1000;
const MAX_RESET_WAKE_DELAY_MS = 24 * 60 * 60 * 1000;
let _resetWakeTimer = null;
let _nextResetWakeAt = 0;

// If the account can't gain any quota before a known future reset, return the
// earliest safe re-probe time (~2 min before that reset); else null (= probe now).
// Only returns a deferral when EVERY tracked model is exhausted with a future
// reset — any availability, unknown quota, or already-due reset means probe.
function accountNextResetMs(account) {
    const models = account?.quota?.models;
    if (!models || typeof models !== 'object') return null;
    const entries = Object.entries(models);
    if (entries.length === 0) return null;
    const now = Date.now();
    let earliest = null;
    for (const [, q] of entries) {
        const frac = q?.remainingFraction;
        if (frac === null || frac === undefined) return null;   // unknown → keep probing
        if (frac > 0.05) return null;                            // real availability → track it
        const resetMs = q?.resetTime ? new Date(q.resetTime).getTime() : NaN;
        if (isNaN(resetMs) || resetMs <= now) return null;       // reset due/soon → probe now
        if (earliest === null || resetMs < earliest) earliest = resetMs;
    }
    return earliest - RESET_FRESHNESS_MARGIN_MS;
}

function scheduleResetWake(wakeAt) {
    if (_resetWakeTimer) {
        clearTimeout(_resetWakeTimer);
        _resetWakeTimer = null;
    }
    _nextResetWakeAt = wakeAt;
    const delay = Math.min(Math.max(wakeAt - Date.now(), 1000), MAX_RESET_WAKE_DELAY_MS);
    _resetWakeTimer = setTimeout(() => {
        _resetWakeTimer = null;
        refreshAllQuotas().catch(() => {});
    }, delay);
}

async function refreshAllQuotas() {
    if (!isInitialized) return;
    try {
        const allAccts = accountManager.getAllAccounts();
        const active = allAccts.filter(a => !a.isInvalid && a.enabled !== false);
        let nextWakeAt = 0;
        let probed = 0;
        let deferred = 0;
        await Promise.allSettled(active.map(async (account) => {
            try {
                // Reset-aware skip: known-locked accounts are deferred, not probed.
                const deferUntil = accountNextResetMs(account);
                if (deferUntil !== null && deferUntil > Date.now()) {
                    if (nextWakeAt === 0 || deferUntil < nextWakeAt) nextWakeAt = deferUntil;
                    deferred++;
                    return;
                }
                probed++;
                const token = await accountManager.getTokenForAccount(account);
                // The shared free-tier alias (aicode-consumers) is bound to every
                // account, but Google's fetchAvailableModels reports all-zeros for
                // that project even for models that generate fine. Quota truth is
                // per-account (null = account's own default project), so only use a
                // real per-account project when one exists; never probe the shared
                // alias (it self-poisons selection with fake 0% on every model).
                const storedProject = account.subscription?.projectId || null;
                const projectId = (storedProject && storedProject !== 'aicode-consumers') ? storedProject : null;
                const quotas = await getModelQuotas(token, projectId);
                const formattedQuotas = {};
                for (const [modelId, info] of Object.entries(quotas)) {
                    formattedQuotas[modelId] = {
                        remaining: info.remainingFraction !== null ? `${Math.round(info.remainingFraction * 100)}%` : 'N/A',
                        remainingFraction: info.remainingFraction,
                        resetTime: info.resetTime || null
                    };
                }
                account._cachedFormattedQuotas = formattedQuotas;
                account._lastQuotaFetchTime = Date.now();
                // Anti-poisoning guard: an all-zero result (every known model at 0%
                // with a future reset) is what the shared aicode-consumers alias
                // returns even for models that generate fine. Treat it as a failed
                // probe: keep prior quota state (or empty) instead of writing a
                // self-perpetuating all-locked state that benches every account.
                const tracked = Object.values(formattedQuotas).filter(q => q.remainingFraction !== null && q.remainingFraction !== undefined);
                const allZeroWithFutureReset = tracked.length > 0 &&
                    tracked.every(q => q.remainingFraction <= 0.05 && q.resetTime && new Date(q.resetTime).getTime() > Date.now());
                if (allZeroWithFutureReset) {
                    logger.warn(`[Server] Quota sweep for ${account.email}: all-zero result looks poisoned (project ${projectId || '(default)'}); keeping prior quota state.`);
                    return;
                }
                if (!account.quota) account.quota = {};
                if (!account.quota.models) account.quota.models = {};
                for (const [modelId, info] of Object.entries(formattedQuotas)) {
                    account.quota.models[modelId] = {
                        remainingFraction: info.remainingFraction,
                        resetTime: info.resetTime
                    };
                }
            } catch (e) {
                // Per-account failure is non-fatal
            }
        }));
        // Wake once when the earliest deferred account's reset opens.
        if (nextWakeAt > 0 && (_resetWakeTimer === null || nextWakeAt < _nextResetWakeAt)) {
            scheduleResetWake(nextWakeAt);
        }
        if (probed > 0 || deferred > 0) {
            logger.info(`[Server] Quota sweep: ${probed} probed, ${deferred} deferred (known future reset)`);
        }
    } catch (e) {
        logger.warn(`[Server] Background quota refresh error: ${e.message}`);
    }
}
setInterval(() => {
    refreshAllQuotas().catch(() => {});
}, 15 * 60 * 1000);
setQuotaRefreshImpl(refreshAllQuotas);

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

// Mount Voice Memos API (Apple Voice Memos query and audio streaming)
import voiceMemosRouter from './voice-memos-api.js';
app.use('/api/voicememos', voiceMemosRouter);

// Mount unified search API (across conversations + iMessage)
import { createSearchRouter } from './api-search.js';
app.use('/api', createSearchRouter());


// Mount WebUI (optional web interface for account management)
mountWebUI(app, __dirname, accountManager);

// Mount OpenAI and Responses API Wire Protocol Bridges
mountOpenAICompat(app, accountManager, ensureInitialized, FALLBACK_ENABLED);
mountResponsesCompat(app, accountManager, ensureInitialized, FALLBACK_ENABLED);


// --- Savings Dashboard ---

app.get('/api/admin/keyring-analytics', (req, res) => {
    try {
        const analytics = keyringManager.getKeyringAnalytics();
        res.json(analytics);
    } catch (e) {
        logger.error(`[API] Failed to get keyring analytics: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/keyring-config', (req, res) => {
    try {
        const { provider, keyId, cycleData } = req.body;
        if (!provider || !keyId || !cycleData) {
            return res.status(400).json({ error: 'Missing provider, keyId, or cycleData' });
        }
        
        const success = keyringManager.setKeyCycleInfo(provider, keyId, cycleData);
        if (success) {
            res.json({ status: 'ok', analytics: keyringManager.getKeyringAnalytics() });
        } else {
            res.status(404).json({ error: 'Key not found' });
        }
    } catch (e) {
        logger.error(`[API] Failed to set keyring config: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/savings-history', async (req, res) => {
    try {
        const fs = await import('fs');
        const dbPath = '/Users/test/Projects/solidstack/registry/metrics/savings.db';
        if (!fs.existsSync(dbPath)) {
            return res.json({ dates: [], tokens: [], savings: [], models: [] });
        }
        
        const Database = (await import('better-sqlite3')).default;
        const db = new Database(dbPath, { readonly: true });
        
        const daily = db.prepare(`SELECT substr(timestamp, 1, 10) as date, SUM(tokens_in + tokens_out) as tokens, SUM(retail_value_saved) as saved FROM savings GROUP BY date ORDER BY date ASC LIMIT 30`).all();
        const models = db.prepare(`SELECT model, SUM(tokens_in + tokens_out) as tokens FROM savings GROUP BY model ORDER BY tokens DESC`).all();
        
        db.close();
        
        res.json({
            dates: daily.map(r => r.date),
            tokens: daily.map(r => r.tokens),
            savings: daily.map(r => r.saved),
            models: models
        });
    } catch (error) {
        logger.error('Failed to load savings history', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/savings', (req, res) => {
    // Deprecated standalone HTML page. Redirecting to unified React dashboard.
    res.redirect('/dashboard');
});

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

// Expose routing appraisals to Commander
app.get('/api/metrics/routing', async (req, res) => {
    try {
        const testingMetrics = accountManager.getRoutingMetrics?.() || {
            active_paths: [],
            shadow_tests: []
        };
        res.json({
            status: 'ok',
            strategy: STRATEGY_OVERRIDE || 'hybrid',
            ...testingMetrics
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Fast liveness probe for watchdogs & load balancers (always non-blocking)
app.get('/ping', (req, res) => {
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

app.get('/health', async (req, res) => {
    try {
        await ensureInitialized();
        const start = Date.now();

        // Get high-level status first
        const status = accountManager.getStatus();
        const allAccounts = accountManager.getAllAccounts();

        // Fetch quotas for each account in parallel with per-account timeout protection
        const accountDetails = await Promise.allSettled(
            allAccounts.map(async (account) => {
                if (account.enabled === false) {
                    return {
                        email: account.email,
                        lastUsed: account.lastUsed ? new Date(account.lastUsed).toISOString() : null,
                        modelRateLimits: account.modelRateLimits || {},
                        rateLimitCooldownRemaining: 0,
                        status: 'disabled',
                        error: account.invalidReason || 'Account disabled in configuration',
                        models: {}
                    };
                }

                // Check model-specific rate limits
                const activeModelLimits = Object.entries(account.modelRateLimits || {})
                    .filter(([_, limit]) => limit.isRateLimited && limit.resetTime > Date.now());
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
                    const now = Date.now();
                    const cacheAge = now - (account._lastQuotaFetchTime || 0);
                    let formattedQuotas = account._cachedFormattedQuotas;

                    if (!formattedQuotas || cacheAge > 60000 || req.query.fresh === 'true') {
                        // Protect against hanging Google API requests with 2500ms timeout
                        const fetchPromise = (async () => {
                            const token = await accountManager.getTokenForAccount(account);
                            const projectId = account.subscription?.projectId || null;
                            return await getModelQuotas(token, projectId);
                        })();

                        const timeoutPromise = new Promise((_, reject) => 
                            setTimeout(() => reject(new Error('Quota probe timeout (2.5s)')), 2500)
                        );

                        try {
                            const quotas = await Promise.race([fetchPromise, timeoutPromise]);
                            formattedQuotas = {};
                            for (const [modelId, info] of Object.entries(quotas)) {
                                formattedQuotas[modelId] = {
                                    remaining: info.remainingFraction !== null ? `${Math.round(info.remainingFraction * 100)}%` : 'N/A',
                                    remainingFraction: info.remainingFraction,
                                    resetTime: info.resetTime || null
                                };
                            }
                            account._cachedFormattedQuotas = formattedQuotas;
                            account._lastQuotaFetchTime = now;
                            // Sync fresh quota data to account.quota.models so
                            // getAvailableAccounts() and getPoolModelQuotas() use
                            // the latest values (not stale accounts.json data).
                            if (!account.quota) account.quota = {};
                            if (!account.quota.models) account.quota.models = {};
                            for (const [modelId, info] of Object.entries(formattedQuotas)) {
                                account.quota.models[modelId] = {
                                    remainingFraction: info.remainingFraction,
                                    resetTime: info.resetTime
                                };
                            }
                        } catch (timeoutOrError) {
                            if (!formattedQuotas) {
                                formattedQuotas = { 'gemini-2.5-flash': { remaining: 'Available', remainingFraction: 1.0 } };
                            }
                        }
                    }

                    // An account is only fully rate-limited if all models with quota are rate-limited
                    const isAllRateLimited = accountManager.isAllRateLimited ? accountManager.isAllRateLimited() : false;
                    const accountStatus = isAllRateLimited ? 'rate-limited' : (activeModelLimits.length > 0 ? 'partial' : 'ok');

                    return {
                        ...baseInfo,
                        status: accountStatus,
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
                // Skip invalid accounts without refresh capability
                if (account.isInvalid && !account.refreshToken && req.query.force !== 'true') {
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

                // 5-minute smart quota cache to prevent API call limit exhaustion and ensure instant UI load
                const QUOTA_CACHE_TTL = 5 * 60 * 1000;
                const hasCachedQuota = account.quota?.models &&
                    Object.keys(account.quota.models).length > 0 &&
                    account.quota.lastChecked &&
                    (Date.now() - account.quota.lastChecked < QUOTA_CACHE_TTL);

                if (hasCachedQuota && req.query.force !== 'true') {
                    return {
                        email: account.email,
                        status: 'ok',
                        subscription: account.subscription || { tier: 'unknown', projectId: null },
                        models: account.quota.models
                    };
                }

                try {
                    const token = await accountManager.getTokenForAccount(account);
                    // Never probe the shared free-tier alias (aicode-consumers): it
                    // returns all-zeros even for models that generate fine, and its
                    // near-zero records self-persist here and bench selection. Use a
                    // real per-account project when one exists, else the account's
                    // own default (null).
                    const storedProject = account.subscription?.projectId || null;
                    const projectId = (storedProject && storedProject !== 'aicode-consumers') ? storedProject : null;

                    // Fetch fresh quotas using cached project ID
                    let quotas = {};
                    try {
                        quotas = await getModelQuotas(token, projectId, account.subscription?.tier || account.tier);
                    } catch (qErr) {
                        logger.warn(`[Server] Quota fetch error for ${account.email}: ${qErr.message}`);
                        // Fall back to previously cached models if available
                        quotas = account.quota?.models || {};
                    }

                    // If quotas returned empty, preserve previous cache if exists
                    if (Object.keys(quotas).length === 0 && account.quota?.models && Object.keys(account.quota.models).length > 0) {
                        quotas = account.quota.models;
                    }

                    // Anti-poisoning guard: an all-zero result (every model at 0%
                    // with a future reset) is the shared-alias lie pattern. Fall
                    // back to prior cache instead of persisting self-poisoning
                    // near-zero records.
                    const tracked = Object.values(quotas).filter(q => q && q.remainingFraction !== null && q.remainingFraction !== undefined);
                    const allZeroWithFutureReset = tracked.length > 0 &&
                        tracked.every(q => q.remainingFraction <= 0.05 && q.resetTime && new Date(q.resetTime).getTime() > Date.now());
                    if (allZeroWithFutureReset && account.quota?.models && Object.keys(account.quota.models).length > 0) {
                        logger.warn(`[Server] /account-limits quota for ${account.email}: all-zero result looks poisoned (project ${projectId || '(default)'}); keeping prior quota state.`);
                        quotas = account.quota.models;
                    }

                    // Update account object with quota data
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
                        subscription: account.subscription || { tier: 'unknown', projectId: null },
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
                    // Fall back gracefully to cached quota rather than erroring
                    const fallbackModels = account.quota?.models || {};
                    return {
                        email: account.email,
                        status: Object.keys(fallbackModels).length > 0 ? 'ok' : 'error',
                        error: error.message,
                        subscription: account.subscription || { tier: 'unknown', projectId: null },
                        models: fallbackModels
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
                const isClaude = modelId.toLowerCase().includes('claude');
                for (const acc of accountLimits) {
                    const quota = acc.models?.[modelId];
                    const isFree = (acc.subscription?.tier || 'free').toLowerCase() === 'free';
                    let cell;
                    if (acc.status !== 'ok' && acc.status !== 'rate-limited') {
                        cell = `[${acc.status}]`;
                    } else if (!quota) {
                        cell = '-';
                    } else if (isClaude && isFree) {
                        cell = '0% (N/A free)';
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
                const tier = (acc.subscription?.tier || metadata.subscription?.tier || metadata.tier || 'free').toLowerCase();
                const isFree = tier === 'free' || acc.email.includes('virtual-gemini-key');
                return {
                    email: acc.email,
                    status: acc.status,
                    error: acc.error || null,
                    // Include metadata from AccountManager (WebUI needs these)
                    source: metadata.source || 'unknown',
                    enabled: metadata.enabled !== false,
                    projectId: metadata.projectId || null,
                    isInvalid: (acc.status === 'invalid' || acc.status === 'banned') ? (metadata.isInvalid || true) : false,
                    invalidReason: (acc.status === 'invalid' || acc.status === 'banned') ? (metadata.invalidReason || null) : null,
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
                            const isClaude = modelId.toLowerCase().includes('claude');
                            const quota = acc.models?.[modelId];
                            if (!quota) {
                                return [modelId, null];
                            }
                            if (isClaude && isFree) {
                                return [modelId, {
                                    remaining: '0% (N/A)',
                                    remainingFraction: 0,
                                    resetTime: null
                                }];
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
        // Query models using a Pro account if available so Claude & full model suite are returned
        const accounts = accountManager.getAllAccounts();
        const proAccount = accounts.find(a => (a.subscription?.tier === 'pro' || a.email.includes('gmail')) && a.enabled !== false && !a.isInvalid);
        const { account } = proAccount ? { account: proAccount } : accountManager.selectAccount(null, { apiProfile: req?.apiProfile });
        
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
        const models = await listModels(token, account.subscription?.projectId);
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
app.post('/v1/messages', requireBillingGate, async (req, res) => {
    try {
        const gate = readNetworkGate();
        if (gate) return sendNetworkUnavailable(res, gate);
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

        // Resolve model mapping if configured (same-family only)
        let requestedModel = model || 'claude-3-5-sonnet-20241022';
        const modelMapping = config.modelMapping || {};
        const targetModel = resolveModelMapping(requestedModel, modelMapping);
        if (targetModel !== requestedModel) {
            logger.info(`[Server] Mapping model ${requestedModel} -> ${targetModel}`);
            requestedModel = targetModel;
        }

        if (requestedModel === 'auto' || requestedModel === 'antigravity/auto') {
            requestedModel = await selectOptimalModel(messages, req.body, accountManager);
            logger.info(`[Smart Router] 'auto' dynamically resolved to -> ${requestedModel}`);
        }

        const modelId = requestedModel;

        // Validate model ID before processing
        const isNim = isNimEligible(modelId, req.body?.taskTier);
        const { account: validationAccount } = isNim ? { account: null } : accountManager.selectAccount(modelId, { apiProfile: req?.apiProfile });
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
            app: 'antigravity',
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
        const inFlightId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        startInFlight(inFlightId, { model: request.model, isLocal: request.model.includes('local') || request.model.includes('ollama') || request.model.includes('turbo') });

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
                    if (event.type === 'message_start' && event.message?.usage) {
                        recordTokenUsage({ ...event.message.usage, model: request.model });
                    } else if (event.type === 'message_delta' && event.usage) {
                        recordTokenUsage({ ...event.usage, model: request.model });
                    }
                    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
                    if (res.flush) res.flush();
                }
                
                res.end();
                finalizeStreamingLog(streamConvId);
                endInFlight(inFlightId, { status: 'completed' });

            } catch (error) {
                finalizeStreamingLog(streamConvId, error);
                endInFlight(inFlightId, { status: 'error', error: error.message });
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
            try {
                const response = await sendMessage(request, accountManager, FALLBACK_ENABLED);
                if (response?.usage) {
                    recordTokenUsage({ ...response.usage, model: request.model });
                }
                logConversation(request, response, '', '', req);
                endInFlight(inFlightId, { status: 'completed' });
                res.json(response);
            } catch (err) {
                endInFlight(inFlightId, { status: 'error', error: err.message });
                throw err;
            }
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
// Initialize proficiency tracker
proficiencyTracker.init();

// Expose proficiency matrix API
app.get('/api/proficiency/matrix', (req, res) => {
    res.json(proficiencyTracker.getMatrix());
});

app.post('/api/proficiency/advise', express.json(), (req, res) => {
    try {
        const { current_model, task_type } = req.body;
        if (!current_model || !task_type) {
            return res.status(400).json({ error: 'Missing current_model or task_type' });
        }
        const routingMode = accountManager.getRoutingMode
            ? accountManager.getRoutingMode() : 'load_balancer';
        const recommendation = proficiencyTracker.advise(
            current_model, task_type, { routingMode }
        );
        res.json(recommendation);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

usageStats.setupRoutes(app);

// ==========================================
// SolidStack Dashboard & Subsystem Reverse Proxies
// ==========================================
const ssmcpProxy = createProxyMiddleware({
    target: process.env.SSMCP_HTTP_TARGET || 'http://127.0.0.1:8765',
    changeOrigin: true,
    on: {
        error: (err, req, res) => {
            logger.error(`[SSmcp Proxy] Error: ${err.message}`);
            safeProxyErrorResponse(res, 502, { error: 'SSmcp Server Offline (:8765)' });
        }
    }
});

const restreamRequestBody = (proxyReq, req, res) => {
    if (req.body && Object.keys(req.body).length > 0) {
        const bodyData = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
        proxyReq.setHeader('Content-Type', 'application/json');
        proxyReq.setHeader('Content-Length', Buffer.byteLength(bodyData));
        proxyReq.write(bodyData);
    }
};

const daemonProxy = createProxyMiddleware({
    target: 'http://127.0.0.1:18791',
    changeOrigin: true,
    pathRewrite: {
        '^/daemon-api': '/api'
    },
    on: {
        proxyReq: restreamRequestBody,
        error: (err, req, res) => {
            if (err.code === 'ECONNREFUSED') {
                logger.debug(`[Daemon Proxy] Service offline: ${err.message}`);
            } else {
                logger.error(`[Daemon Proxy] Error: ${err.message}`);
            }
            safeProxyErrorResponse(res, 502, { error: 'Commander Daemon Offline (:18791)' });
        }
    }
});

const mcpHttpProxy = createProxyMiddleware({
    target: 'http://127.0.0.1:8765',
    changeOrigin: true,
    pathRewrite: {
        '^/mcp-api': ''
    },
    on: {
        proxyReq: (proxyReq, req, res) => {
            console.log("[MCP] Headers from client:", req.headers);
            restreamRequestBody(proxyReq, req, res);
        },
        error: (err, req, res) => {
            if (err.code === 'ECONNREFUSED') {
                logger.debug(`[MCP Proxy] Service offline: ${err.message}`);
            } else {
                logger.error(`[MCP Proxy] Error: ${err.message}`);
            }
            safeProxyErrorResponse(res, 502, { error: 'SSmcp HTTP Server Offline (:8765)' });
        }
    }
});

const dashboardProxy = createProxyMiddleware({
    target: 'http://127.0.0.1:5001',
    changeOrigin: true,
    ws: true,
    pathRewrite: {
        '^/dashboard': '/'
    },
    on: {
        proxyReq: restreamRequestBody,
        proxyRes: (proxyRes, req, res) => {
            if (req.path === '/api/stream' || proxyRes.headers['content-type'] === 'text/event-stream') {
                proxyRes.headers['Cache-Control'] = 'no-cache';
                proxyRes.headers['X-Accel-Buffering'] = 'no';
                proxyRes.headers['Connection'] = 'keep-alive';
            }
        },
        error: (err, req, res) => {
            if (err.code === 'ECONNREFUSED') {
                logger.debug(`[Dashboard Proxy] Service offline: ${err.message}`);
            } else {
                logger.error(`[Dashboard Proxy] Error: ${err.message}`);
            }
            safeProxyErrorResponse(res, 502, { error: 'Dashboard Offline' });
        }
    }
});

app.use((req, res, next) => {
    const flaskRoutes = ['/api/stream', '/api/status', '/api/attention', '/api/heartbeats', '/api/nodes', '/api/services', '/api/containers', '/api/integrations', '/api/taxonomy', '/api/workflow', '/api/coordinator', '/api/locks', '/api/worktrees', '/api/tasks', '/api/task-progress', '/api/handoffs', '/api/openclaw', '/api/blockers', '/api/service-mobility', '/api/ai-accounts', '/api/ai-proxy', '/api/token-usage', '/api/discovered', '/api/discovered-devices', '/api/skills', '/api/model-logs', '/api/features', '/api/aggregator/status', '/api/local-engines', '/api/model-download-status'];
    
    if (req.path === '/daemon-api' || req.path.startsWith('/daemon-api/')) {
        return daemonProxy(req, res, next);
    }

    if (req.path === '/mcp-api' || req.path.startsWith('/mcp-api/')) {
        return mcpHttpProxy(req, res, next);
    }

    if (req.path === '/api/consideration' || req.path.startsWith('/api/consideration/')) {
        return ssmcpProxy(req, res, next);
    }

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
            logger.error(`[Transparent Passthrough] Error forwarding ${req?.originalUrl || req?.url}: ${err.message}`);
            safeProxyErrorResponse(res, 502, { error: 'Bad Gateway via Transparent Proxy' });
        }
    }
}));

export default app;