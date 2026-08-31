// quota-refresh.js — debounced on-demand quota refresh shared across request paths.
//
// The pool no longer refreshes every account's quota from Google on a tight 2-minute
// loop (that was ~720 token-authenticated probes/hour while idle). Instead:
//   - a long idle backstop (15 min) in server.js keeps state roughly fresh, and
//   - this module fires a single sweep on-demand whenever a request path observes a
//     quota-relevant event (429 / rate-limit mark / empty-pool 503), throttled to
//     at most one sweep per minute so a 429 storm doesn't turn into a probe storm.
//
// server.js registers the real implementation via setQuotaRefreshImpl().

let _impl = null;
let _timer = null;
let _lastRunAt = 0;
const ANTI_STAMPEDE_MS = 60 * 1000;
const SCHEDULE_DELAY_MS = 2 * 1000;

export function setQuotaRefreshImpl(fn) {
  _impl = fn;
}

export function quotaRefreshSoon() {
  if (!_impl) return;
  const now = Date.now();
  if (now - _lastRunAt < ANTI_STAMPEDE_MS) return;
  if (_timer) clearTimeout(_timer);
  _timer = setTimeout(() => {
    _lastRunAt = Date.now();
    _impl().catch(() => {});
  }, SCHEDULE_DELAY_MS);
}