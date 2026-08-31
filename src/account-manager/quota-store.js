// quota-store.js — per-account, per-app usage tracking
// Tracks: Antigravity (Gemini), OpenCode, Claude, ChatGPT
import fs, { readFileSync } from 'fs';
import path, { join } from 'path';
import os from 'os';

const STORE_PATH = path.join(os.homedir(), '.config', 'solidstack', 'quota-store.json');
const STORE_DIR  = path.dirname(STORE_PATH);

// Path to the existing account-manager accounts.json
const ACCOUNTS_JSON = join(process.env.SOLIDSTACK_ROOT ?? `${os.homedir()}/Projects/solidstack`,
  'ai-proxy/src/account-manager/accounts.json');

export function loadAccountsJson() {
  const candidates = [
    ACCOUNTS_JSON,
    join(os.homedir(), '.config', 'antigravity-proxy', 'accounts.json'),
    join(os.homedir(), '.config', 'solidstack', 'accounts.json')
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        return JSON.parse(readFileSync(p, 'utf8'));
      }
    } catch {}
  }
  return {};
}

// Map accountId → { isInvalid, disabled, coolingUntil, lastError, eligibility }
export function buildEligibilityMap() {
  const raw = loadAccountsJson();
  const map = {};
  // accounts.json shape: { antigravity: [{email, isInvalid, disabled, coolingUntil, ...}], ... }
  // or { accounts: [{email, isInvalid, disabled, coolingUntil, ...}] }
  for (const [app, accounts] of Object.entries(raw)) {
    const appName = app === 'accounts' ? 'antigravity' : app;
    for (const acct of (Array.isArray(accounts) ? accounts : [])) {
      const id = acct.email ?? acct.id ?? acct.accountId;
      if (!id) continue;
      const tier = acct.subscription?.tier ?? acct.tier ?? 'free';
      const data = {
        isInvalid:    acct.isInvalid    ?? false,
        disabled:     (acct.disabled ?? (acct.enabled === false)) ?? false,
        coolingUntil: acct.coolingUntil ?? null,
        lastError:    acct.lastError ?? acct.invalidReason ?? null,
        eligibility:  acct.eligibility  ?? null,  // e.g. 'code_assist_eligible'
        tier:         String(tier).toLowerCase(),
      };
      map[`${appName}::${id}`] = data;
      if (appName !== 'antigravity' && !map[`antigravity::${id}`]) {
        map[`antigravity::${id}`] = data;
      }
    }
  }
  return map;
}

// Derive a single status string from merged state
export function deriveStatus(eligMap, app, accountId, rec, model = null) {
  const e = eligMap[`${app}::${accountId}`];
  if (!e) return 'unknown';               // not in accounts.json at all
  if (e.isInvalid)  return 'invalid';     // 403 / auth failure flagged
  if (e.disabled)   return 'disabled';    // manually turned off
  if ((e.coolingUntil && Date.now() < e.coolingUntil) || (rec?.cooldownUntil && Date.now() < rec.cooldownUntil)) return 'cooling';
  if (e.eligibility && e.eligibility !== 'code_assist_eligible') return 'ineligible';
  if (model && model.toLowerCase().includes('claude') && e.tier === 'free') return 'ineligible';
  if (rec && rec.errors > 0 && rec.reqs <= rec.errors) return 'erroring'; // all requests errored
  return 'ok';
}

// Default cooldown applied to an account when a retryable upstream failure is
// detected (429 rate limit / 503 MODEL_CAPACITY_EXHAUSTED / metadata error 2010).
// During cooldown the account is excluded from getBestAccount() selection.
export const RETRYABLE_FAILURE_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

// Max account rotations before propagating a retryable failure to the client.
export const MAX_RETRYABLE_ROTATIONS = 3;

// Rolling reset windows per provider (ms)
export const RESET_WINDOWS = {
  antigravity: 60 * 60 * 1000,     // 1 hr  (Gemini RPH)
  opencode:    24 * 60 * 60 * 1000,// 24 hr (daily)
  claude:       8 * 60 * 60 * 1000,// 8 hr  (Claude Pro)
  chatgpt:      3 * 60 * 60 * 1000 // 3 hr  (Plus rolling)
};

// Known limits per provider/model
export const KNOWN_LIMITS = {
  antigravity: {
    'gemini-2.5-pro':        { rpd: 25,   tpd: 250_000 },
    'gemini-2.5-flash':      { rpd: 500,  tpd: 1_000_000 },
    'gemini-2.5-flash-lite': { rpd: 1500, tpd: 3_000_000 },
    'gemini-3.7-flash-high': { rpd: 500,  tpd: 1_000_000 },
    'claude-opus-4-6-thinking': { per_window: 45 },
    'claude-sonnet-4-6':        { per_window: 200 }
  },
  opencode: {
    'gemini-2.5-pro':        { rpd: 25,   tpd: 250_000 },
    'gemini-2.5-flash':      { rpd: 500,  tpd: 1_000_000 },
    'claude-sonnet-4-6':     { per_window: 200 }
  },
  claude:  { 'claude-opus-4':  { per_window: 45 }, 'claude-sonnet-4': { per_window: 200 }, 'claude-sonnet-4-6': { per_window: 200 } },
  chatgpt: { 'gpt-4o':         { rpm: 80 },         'o1':              { per_window: 50 } },
};

let _store = null;
function load() {
  if (_store) return _store;
  try {
    if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true });
    _store = fs.existsSync(STORE_PATH) 
      ? JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'))
      : { accounts: {}, meta: { created: Date.now(), v: 1 } };
  } catch { _store = { accounts: {}, meta: { created: Date.now(), v: 1 } }; }
  return _store;
}

function save() {
  const tmp = STORE_PATH + '.tmp';
  try {
    if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(_store, null, 2));
    fs.renameSync(tmp, STORE_PATH);  // atomic write
  } catch (e) {
    // Non-blocking log
  }
}

// Rolling window for drain rate velocity calculation (5 minutes)
const DRAIN_VELOCITY_WINDOW_MS = 5 * 60 * 1000;

/**
 * Compute drain rate metrics for an account+model.
 * Uses the request history maintained by recordRequest() to calculate
 * requests-per-minute, window consumption ratio, remaining quota, and
 * projected time-to-depletion (ETA).
 *
 * @param {string} app - Provider/app scope (antigravity, opencode, claude, chatgpt)
 * @param {string} accountId - Account identifier (email)
 * @param {string} model - Model name
 * @returns {{rpm: number, windowRatio: number, remaining: number|null, etaMs: number|null, historyLen: number}}
 */
export function getDrainRate(app, accountId, model) {
  const s = load();
  const key = `${app}::${accountId}`;
  const rec = s.accounts[key]?.models?.[model];
  if (!rec) {
    return { rpm: 0, windowRatio: 0, remaining: null, etaMs: null, historyLen: 0 };
  }

  const now = Date.now();

  // Requests in the last 5 minutes (short-term velocity)
  const recentHistory = rec.history?.filter(h => now - h.ts < DRAIN_VELOCITY_WINDOW_MS) ?? [];
  const rpm = recentHistory.length > 0 ? recentHistory.length / (DRAIN_VELOCITY_WINDOW_MS / 60_000) : 0;

  // Full-window consumption ratio
  const limit = KNOWN_LIMITS[app]?.[model]?.rpd
    ?? KNOWN_LIMITS[app]?.[model]?.per_window
    ?? KNOWN_LIMITS[app]?.[model]?.rpm
    ?? null;
  const windowRatio = limit ? rec.reqs / limit : 0;

  // Remaining quota in the current window
  const remaining = limit ? Math.max(0, limit - rec.reqs) : null;

  // Projected time-to-depletion based on current velocity
  let etaMs = null;
  if (rpm > 0 && remaining !== null && remaining > 0) {
    etaMs = (remaining / rpm) * 60_000; // minutes → ms
  } else if (remaining === 0) {
    etaMs = 0;
  }

  return {
    rpm: Math.round(rpm * 100) / 100,
    windowRatio: Math.round(windowRatio * 1000) / 1000,
    remaining,
    etaMs: etaMs !== null ? Math.round(etaMs) : null,
    historyLen: recentHistory.length,
  };
}

function getRec(app, accountId, model) {
  const s = load(), key = `${app}::${accountId}`;
  s.accounts[key] ??= { app, accountId, models: {}, enabled: true };
  s.accounts[key].models[model] ??= { reqs: 0, tokens: 0, errors: 0, lastUsed: null, windowStart: Date.now(), history: [] };
  const rec = s.accounts[key].models[model];
  if (Date.now() - rec.windowStart > (RESET_WINDOWS[app] ?? 3_600_000)) {
    rec.reqs = 0; rec.tokens = 0; rec.errors = 0; rec.windowStart = Date.now();
  }
  return rec;
}

export function recordRequest({ app, accountId, model, tokens = 0, error = false }) {
  if (!app || !accountId || !model) return;
  const rec = getRec(app, accountId, model);
  rec.reqs++; 
  rec.tokens += tokens; 
  if (error) rec.errors++;
  rec.lastUsed = Date.now();
  rec.history.push({ ts: Date.now(), tokens, error });
  if (rec.history.length > 100) rec.history = rec.history.slice(-100);
  save();
}

/**
 * Temporarily mark an account as unavailable for a model.
 * While the cooldown is active, getBestAccount() excludes the account.
 * @param {string} app - Provider/app scope (antigravity, opencode, claude, chatgpt)
 * @param {string} accountId - Account identifier (email)
 * @param {string} model - Model name to scope the cooldown to
 * @param {number} ms - Cooldown duration in milliseconds
 */
export function setCooldown(app, accountId, model, ms) {
  if (!app || !accountId || !model || !ms || ms <= 0) return;
  const rec = getRec(app, accountId, model);
  rec.cooldownUntil = Date.now() + ms;
  save();
}

/**
 * Clear an account cooldown for a model (used by tests / manual override).
 * @param {string} app - Provider/app scope
 * @param {string} accountId - Account identifier (email)
 * @param {string} model - Model name
 */
export function clearCooldown(app, accountId, model) {
  if (!app || !accountId || !model) return;
  const s = load();
  const key = `${app}::${accountId}`;
  const rec = s.accounts[key]?.models?.[model];
  if (rec?.cooldownUntil) {
    delete rec.cooldownUntil;
    save();
  }
}

/**
 * Get the remaining cooldown for an account+model.
 * @param {string} app - Provider/app scope
 * @param {string} accountId - Account identifier (email)
 * @param {string} model - Model name
 * @returns {number} Milliseconds remaining in cooldown, 0 if none
 */
export function getCooldownRemaining(app, accountId, model) {
  if (!app || !accountId || !model) return 0;
  const rec = getRec(app, accountId, model);
  if (!rec.cooldownUntil) return 0;
  const remaining = rec.cooldownUntil - Date.now();
  return remaining > 0 ? remaining : 0;
}

/**
 * Detect retryable upstream failures that warrant account rotation:
 *  - HTTP 429 (rate limit)
 *  - HTTP 503 with error details reason MODEL_CAPACITY_EXHAUSTED
 *  - HTTP 503 with error details metadata.error_number === '2010'
 * @param {number} status - Upstream HTTP status code
 * @param {Object} [body] - Parsed upstream response body
 * @returns {boolean} True if the failure should trigger account rotation
 */
export const isShouldRotate = (status, body) => {
  if (status === 429) return true;
  if (status === 503) {
    const details = body?.error?.details ?? [];
    return details.some(d =>
      d.reason === 'MODEL_CAPACITY_EXHAUSTED' ||
      d.metadata?.error_number === '2010'
    );
  }
  return false;
};

export function getQuotaStatus(filterApp = null) {
  const s = load();
  const eligMap = buildEligibilityMap();   // ← new: load accounts.json once

  return Object.values(s.accounts)
    .filter(a => !filterApp || a.app === filterApp)
    .flatMap(a => Object.entries(a.models).map(([model, rec]) => {
      const L = KNOWN_LIMITS[a.app]?.[model];
      const winMs = RESET_WINDOWS[a.app] ?? 3_600_000;
      const limit = L?.rpd ?? L?.per_window ?? L?.rpm ?? null;
      const status = deriveStatus(eligMap, a.app, a.accountId, rec, model);  // ← merged
      const eInfo  = eligMap[`${a.app}::${a.accountId}`] ?? {};
      const cooldownUntilVal = eInfo.coolingUntil ?? (rec.cooldownUntil && rec.cooldownUntil > Date.now() ? rec.cooldownUntil : null);

      return {
        app:         a.app,
        accountId:   a.accountId,
        model,
        enabled:     a.enabled,
        status,                            // 'ok' | 'invalid' | 'disabled' | 'cooling' | 'ineligible' | 'erroring' | 'unknown'
        reqs:        rec.reqs,
        tokens:      rec.tokens,
        errors:      rec.errors,
        lastUsed:    rec.lastUsed ? new Date(rec.lastUsed).toISOString() : null,
        windowReset: new Date(rec.windowStart + winMs).toISOString(),
        limit,
        pct:         limit ? Math.round((rec.reqs / limit) * 100) : null,
        // eligibility metadata surfaced for the widget/MCP
        isInvalid:    eInfo.isInvalid    ?? null,
        coolingUntil: cooldownUntilVal ? new Date(cooldownUntilVal).toISOString() : null,
        cooldownRemainingMs: cooldownUntilVal ? Math.max(0, cooldownUntilVal - Date.now()) : 0,
        isCoolingDown: !!cooldownUntilVal,
        lastError:    eInfo.lastError    ?? null,
        eligibility:  eInfo.eligibility  ?? null,
      };
    }));
}

export function getBestAccount(app, model) {
  const s = load();
  const eligMap = buildEligibilityMap();
  const now = Date.now();

  const cands = Object.values(s.accounts)
    .filter(a => a.app === app && a.enabled)
    .map(a => {
      const rec   = a.models[model] ?? { reqs: 0, errors: 0, history: [] };
      const status = deriveStatus(eligMap, app, a.accountId, rec, model);
      const limit = KNOWN_LIMITS[app]?.[model]?.rpd ?? KNOWN_LIMITS[app]?.[model]?.per_window ?? Infinity;

      // Compute velocity from recent history (5-min rolling window)
      const recentHistory = rec.history?.filter(h => now - h.ts < DRAIN_VELOCITY_WINDOW_MS) ?? [];
      const rpm = recentHistory.length > 0 ? recentHistory.length / (DRAIN_VELOCITY_WINDOW_MS / 60_000) : 0;

      return {
        accountId: a.accountId,
        reqs:      rec.reqs,
        limit,
        status,
        rpm:       Math.round(rpm * 100) / 100,
      };
    })
    .filter(c => c.status === 'ok' && c.reqs < c.limit)
    // Velocity-aware sort: lower usage AND lower velocity = better
    // rpm * 0.1 scales velocity into the same magnitude as reqs/limit ratio
    .sort((a, b) => {
      const aLoad = (a.reqs / a.limit) + (a.rpm * 0.1);
      const bLoad = (b.reqs / b.limit) + (b.rpm * 0.1);
      return aLoad - bLoad;
    });

  return cands[0]?.accountId ?? null;
}
