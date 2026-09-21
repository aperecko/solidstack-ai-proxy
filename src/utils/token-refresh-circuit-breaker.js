/**
 * token-refresh-circuit-breaker.js — guards against fleet-wide token refresh storms.
 *
 * Problem: The Antigravity token refresh scheduler fires every 2.8–5.1 seconds
 * for all 361 connections simultaneously because the scheduler reads `expires_at`
 * but writes `token_expires_at` after success — so the guard condition is never
 * satisfied and every tick re-queues the entire fleet.
 *
 * This module wraps the upstream refreshToken() call with two layers of protection:
 *
 *   1. Per-connection guard  — skip refresh when token_expires_at > now + 30 min
 *   2. Fleet circuit breaker — open if > FLEET_TRIP_THRESHOLD refreshes fire in
 *      any 60-second window, blocking all further refreshes until RESET_AFTER_MS.
 *
 * Usage (in antigravity-client.js or wherever refreshToken is called):
 *
 *   import { guardedRefresh, recordRefreshStart, recordRefreshEnd } from './token-refresh-circuit-breaker.js';
 *
 *   // Instead of: await refreshToken(conn)
 *   // Use:        await guardedRefresh(conn, refreshToken)
 */

import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Skip refresh if the stored token still has this many ms of life. */
const REFRESH_GUARD_MS = 30 * 60 * 1000; // 30 minutes

/** Maximum refreshes allowed per 60-second sliding window before tripping. */
const FLEET_TRIP_THRESHOLD = parseInt(process.env.REFRESH_TRIP_THRESHOLD ?? '20', 10);

/** How long the circuit breaker stays open once tripped. */
const RESET_AFTER_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// Per-connection last-refresh tracking (in-memory, survives scheduler loops)
// ---------------------------------------------------------------------------
const _lastRefreshed = new Map(); // connectionId → timestamp

// ---------------------------------------------------------------------------
// Fleet-level sliding-window counter
// ---------------------------------------------------------------------------
const _windowEvents = []; // timestamps of recent refresh STARTS
let   _circuitOpen   = false;
let   _tripTime       = 0;

function _pruneWindow() {
  const cutoff = Date.now() - 60_000;
  while (_windowEvents.length && _windowEvents[0] < cutoff) _windowEvents.shift();
}

function _shouldTripCircuit() {
  _pruneWindow();
  return _windowEvents.length >= FLEET_TRIP_THRESHOLD;
}

function _isCircuitOpen() {
  if (!_circuitOpen) return false;
  if (Date.now() - _tripTime > RESET_AFTER_MS) {
    _circuitOpen = false;
    _windowEvents.length = 0;
    logger.info('[RefreshCircuit] Circuit reset after cooling period — resuming refreshes');
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * shouldRefresh(connection) — returns true when the connection genuinely needs
 * a new token.  Call this BEFORE invoking the upstream refresh function.
 *
 * @param {Object} conn  — OmniRoute provider_connection row (has token_expires_at / expires_at)
 * @returns {boolean}
 */
export function shouldRefresh(conn) {
  // Circuit open — block everything
  if (_isCircuitOpen()) {
    logger.debug(`[RefreshCircuit] OPEN — skipping refresh for ${conn.id ?? conn.email}`);
    return false;
  }

  // Per-connection 30-min guard
  const expiresAt = conn.token_expires_at ?? conn.expires_at;
  if (expiresAt) {
    const expiresMs = typeof expiresAt === 'number' ? expiresAt : new Date(expiresAt).getTime();
    if (!isNaN(expiresMs) && expiresMs > Date.now() + REFRESH_GUARD_MS) {
      return false; // Plenty of life left — skip
    }
  }

  // In-memory last-refresh debounce (secondary guard for rapid-fire loops)
  const lastMs = _lastRefreshed.get(conn.id ?? conn.email) ?? 0;
  if (Date.now() - lastMs < REFRESH_GUARD_MS) {
    return false;
  }

  return true;
}

/**
 * recordRefreshStart(connectionId) — call when a refresh is about to execute.
 * Counts toward the fleet circuit breaker window.
 */
export function recordRefreshStart(connectionId) {
  const now = Date.now();
  _windowEvents.push(now);
  _lastRefreshed.set(connectionId, now);

  if (_shouldTripCircuit()) {
    _circuitOpen = true;
    _tripTime = now;
    logger.error(
      `[RefreshCircuit] TRIPPED — ${_windowEvents.length} refreshes in 60s ` +
      `(threshold=${FLEET_TRIP_THRESHOLD}). Blocking all refreshes for ${RESET_AFTER_MS / 60000} min.`
    );
  }
}

/**
 * recordRefreshEnd(connectionId, success) — call after a refresh completes.
 * On success, updates the last-refreshed timestamp.
 */
export function recordRefreshEnd(connectionId, success) {
  if (success) {
    _lastRefreshed.set(connectionId, Date.now());
  }
}

/**
 * guardedRefresh(conn, refreshFn) — wraps an existing refreshToken function
 * with the full guard + circuit logic.
 *
 * @param {Object}   conn       — connection object (must have .id and token_expires_at)
 * @param {Function} refreshFn  — async (conn) => void  (the real refresh implementation)
 * @returns {Promise<boolean>}  true = refreshed, false = skipped
 */
export async function guardedRefresh(conn, refreshFn) {
  if (!shouldRefresh(conn)) return false;

  const id = conn.id ?? conn.email ?? 'unknown';
  recordRefreshStart(id);
  try {
    await refreshFn(conn);
    recordRefreshEnd(id, true);
    return true;
  } catch (err) {
    recordRefreshEnd(id, false);
    logger.warn(`[RefreshCircuit] Refresh failed for ${id}: ${err.message}`);
    throw err;
  }
}

/**
 * getCircuitState() — diagnostic summary for health endpoints.
 */
export function getCircuitState() {
  _pruneWindow();
  return {
    open:         _isCircuitOpen(),
    windowCount:  _windowEvents.length,
    tripThreshold: FLEET_TRIP_THRESHOLD,
    resetAfterMs: RESET_AFTER_MS,
    guardMs:      REFRESH_GUARD_MS,
    tripTime:     _circuitOpen ? new Date(_tripTime).toISOString() : null,
  };
}
