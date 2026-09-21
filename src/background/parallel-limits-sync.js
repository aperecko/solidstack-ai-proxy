
import { logger } from "../utils/logger.js";

const WORKER_CONCURRENCY = parseInt(process.env.LIMITS_SYNC_WORKERS ?? "50", 10);

const _invalidated = new Set();

export function invalidateQuota(connectionId) {
  _invalidated.add(connectionId);
  logger.warn(`[ParallelSync] Event-driven quota invalidation for ${connectionId}`);
}

export function isInvalidated(connectionId) {
  return _invalidated.has(connectionId);
}

export function clearInvalidated(connectionId) {
  _invalidated.delete(connectionId);
}

export async function runParallelLimitsSync(connections, fetchQuotaFn) {
  let limitFn = null;
  try {
    const m = await import("p-limit");
    limitFn = (m.default ?? m)(WORKER_CONCURRENCY);
  } catch { /* run all parallel if p-limit unavailable */ }

  const start = Date.now();
  let ok = 0;
  const failedIds = [];

  const tasks = connections.map(conn =>
    (limitFn ? limitFn : fn => fn())(async () => {
      try {
        await fetchQuotaFn(conn);
        clearInvalidated(conn.id);
        ok++;
      } catch (err) {
        failedIds.push(conn.id);
        logger.warn(`[ParallelSync] FAIL connection_id=${conn.id} email=${conn.email ?? "?"}: ${err.message}`);
      }
    })
  );

  await Promise.allSettled(tasks);
  const elapsedMs = Date.now() - start;

  logger.info(
    `[ParallelSync] Cycle complete in ${(elapsedMs/1000).toFixed(1)}s ` +
    `${ok}/${connections.length} ok` +
    (failedIds.length ? `, ${failedIds.length} FAILED: [${failedIds.slice(0,5).join(", ")}${failedIds.length > 5 ? "..." : ""}]` : "")
  );

  return { ok, failed: failedIds.length, elapsedMs, failedIds };
}
