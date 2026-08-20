/**
 * Token Resolver
 *
 * Maps the OAuth access token that the Antigravity IDE actually sends with
 * every intercepted request to an account email. This is the live ground
 * truth for "which account is authenticated in AG" — the SQLite auth record
 * in state.vscdb is only written on AG auth events and can go stale, but the
 * Bearer token on each request is always current.
 *
 * Resolution order:
 *   1. In-memory cache (token → email, 1 hour TTL)
 *   2. AccountManager token cache (no network)
 *   3. Google userinfo endpoint (authoritative, network)
 *      → tokeninfo endpoint as a fallback
 *
 * Failures are non-fatal: callers treat a `null` result as "unknown" and
 * fall back to database detection.
 */

import { logger } from '../utils/logger.js';
import { throttledFetch } from '../utils/helpers.js';
import { OAUTH_CONFIG } from '../constants.js';

const RESOLVE_TTL_MS = 60 * 60 * 1000; // 1 hour
const RESOLVE_TIMEOUT_MS = 4000;
const cache = new Map(); // tokenKey -> { email, resolvedAt }

function cacheKey(token) {
    return token.length > 128 ? token.slice(0, 128) : token;
}

async function fetchEmailFromGoogle(token) {
    // 1. userinfo returns the email directly from a Bearer token.
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), RESOLVE_TIMEOUT_MS);
        try {
            const resp = await throttledFetch(OAUTH_CONFIG.userInfoUrl, {
                headers: { Authorization: `Bearer ${token}` },
                signal: controller.signal,
            });
            if (resp.ok) {
                const data = await resp.json();
                if (data?.email) return data.email;
            }
        } finally {
            clearTimeout(timer);
        }
    } catch (e) {
        logger.debug(`[TokenResolver] userinfo lookup failed: ${e.message}`);
    }

    // 2. tokeninfo (GET with query param) for tokens that fail userinfo.
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), RESOLVE_TIMEOUT_MS);
        try {
            const resp = await throttledFetch(
                `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`,
                { signal: controller.signal }
            );
            if (resp.ok) {
                const data = await resp.json();
                if (data?.email) return data.email;
            }
        } finally {
            clearTimeout(timer);
        }
    } catch (e) {
        logger.debug(`[TokenResolver] tokeninfo lookup failed: ${e.message}`);
    }

    return null;
}

/**
 * Resolve an OAuth access token to an account email, or null on failure.
 * @param {string} token - The raw Bearer token from the incoming request.
 * @param {Object} [accountManager] - Optional AccountManager for the token-cache fast path.
 * @returns {Promise<string|null>}
 */
export async function resolveTokenToEmail(token, accountManager = null) {
    if (!token || typeof token !== 'string') return null;
    const key = cacheKey(token);

    // 1. In-memory cache (avoids a network round-trip per request).
    const cached = cache.get(key);
    if (cached && Date.now() - cached.resolvedAt < RESOLVE_TTL_MS) {
        return cached.email;
    }

    // 2. AccountManager token cache (no network).
    if (accountManager && typeof accountManager.getEmailForToken === 'function') {
        try {
            const email = accountManager.getEmailForToken(token);
            if (email) {
                cache.set(key, { email, resolvedAt: Date.now() });
                return email;
            }
        } catch (e) {
            logger.debug(`[TokenResolver] AccountManager token cache lookup failed: ${e.message}`);
        }
    }

    // 3. Google (authoritative).
    const email = await fetchEmailFromGoogle(token);
    cache.set(key, { email, resolvedAt: Date.now() });
    return email;
}

export function clearTokenResolverCache() {
    cache.clear();
}

export default { resolveTokenToEmail, clearTokenResolverCache };
