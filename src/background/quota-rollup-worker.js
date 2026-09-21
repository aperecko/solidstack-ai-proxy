/**
 * quota-rollup-worker.js — SQLite background worker for quota summary rollups.
 *
 * Implements two jobs registered into OmniRoute's jobs table:
 *   - quota_hourly_rollup  (every 60 min): aggregates quota_snapshots → hourly_usage_summary
 *   - quota_daily_rollup   (every 24 h):   aggregates hourly_usage_summary → daily_usage_summary
 *   - quota_snapshot_prune (every 6 h):    deletes snapshot rows older than 7 days
 *
 * Also seeds provider_quota_state from the freshest quota_snapshot per connection
 * so the UI can read live state instead of raw snapshots.
 *
 * Registration: called once at server startup from server.js (idempotent).
 * Execution: driven by OmniRoute's job scheduler via the jobs table, or called
 * directly from the exported run*() functions for testing.
 */

import path from 'path';
import os from 'os';
import { logger } from '../utils/logger.js';

const DB_PATH = process.env.OMNIROUTE_DB_PATH
  ?? path.join(os.homedir(), '.omniroute', 'storage.sqlite');

let _Database = null;
async function getDatabase() {
  if (!_Database) {
    const mod = await import('better-sqlite3');
    _Database = mod.default ?? mod;
  }
  return _Database;
}

let _db = null;
async function getDb() {
  if (_db) return _db;
  const Database = await getDatabase();
  _db = new Database(DB_PATH, { readonly: false, fileMustExist: true });
  _db.pragma('journal_mode = WAL');
  _db.pragma('busy_timeout = 5000');
  _db.pragma('synchronous = NORMAL');
  return _db;
}

// ---------------------------------------------------------------------------
// Job 1: Hourly rollup — quota_snapshots → hourly_usage_summary
// ---------------------------------------------------------------------------
export async function runHourlyRollup() {
  const db = await getDb();
  const now = new Date();
  // Round down to the start of the current hour
  const hourStart = new Date(now);
  hourStart.setMinutes(0, 0, 0);
  const hourKey = hourStart.toISOString().slice(0, 13); // "2026-09-19T21"

  const stmt = db.prepare(`
    INSERT INTO hourly_usage_summary
      (hour_key, connection_id, window_key, snapshot_count,
       exhausted_count, avg_remaining_pct, min_remaining_pct,
       max_remaining_pct, created_at)
    SELECT
      ? as hour_key,
      connection_id,
      window_key,
      COUNT(*)                                  as snapshot_count,
      SUM(is_exhausted)                         as exhausted_count,
      ROUND(AVG(remaining_percentage), 2)       as avg_remaining_pct,
      ROUND(MIN(remaining_percentage), 2)       as min_remaining_pct,
      ROUND(MAX(remaining_percentage), 2)       as max_remaining_pct,
      datetime('now')                           as created_at
    FROM quota_snapshots
    WHERE created_at >= ? AND created_at < ?
    GROUP BY connection_id, window_key
    ON CONFLICT(hour_key, connection_id, window_key) DO UPDATE SET
      snapshot_count    = excluded.snapshot_count,
      exhausted_count   = excluded.exhausted_count,
      avg_remaining_pct = excluded.avg_remaining_pct,
      min_remaining_pct = excluded.min_remaining_pct,
      max_remaining_pct = excluded.max_remaining_pct
  `);

  const windowEnd = new Date(hourStart.getTime() + 3_600_000).toISOString();
  const info = db.transaction(() =>
    stmt.run(hourKey, hourStart.toISOString(), windowEnd)
  )();

  logger.info(`[quota-rollup] Hourly rollup for ${hourKey}: ${info.changes} rows`);
  return info.changes;
}

// ---------------------------------------------------------------------------
// Job 2: Seed provider_quota_state from latest snapshots (live view table)
// ---------------------------------------------------------------------------
export async function runQuotaStateSeed() {
  const db = await getDb();

  // For each (connection_id, window_key), take the most recent snapshot
  // and upsert into provider_quota_state so the UI reads live data.
  const rows = db.prepare(`
    SELECT
      qs.connection_id,
      qs.window_key                           AS model,
      CAST(ROUND((1 - qs.remaining_percentage/100.0)
        * COALESCE(pc.token_limit, 1000000)) AS INTEGER) AS tokens_used,
      COALESCE(pc.token_limit, 1000000)       AS token_limit,
      CAST(strftime('%s', COALESCE(qs.next_reset_at, datetime('now','+1 hour'))) AS INTEGER) * 1000
                                              AS window_reset,
      CAST(strftime('%s', datetime('now','-1 hour')) AS INTEGER) * 1000
                                              AS window_start
    FROM (
      SELECT connection_id, window_key, remaining_percentage, next_reset_at,
             ROW_NUMBER() OVER (PARTITION BY connection_id, window_key
                                ORDER BY created_at DESC) as rn
      FROM quota_snapshots
    ) qs
    LEFT JOIN (
      SELECT id, 1000000 as token_limit FROM provider_connections
    ) pc ON pc.id = qs.connection_id
    WHERE qs.rn = 1
  `).all();

  const upsert = db.prepare(`
    INSERT INTO provider_quota_state
      (connection_id, model, tokens_used, token_limit, window_start, window_reset, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(connection_id, model) DO UPDATE SET
      tokens_used  = excluded.tokens_used,
      token_limit  = excluded.token_limit,
      window_start = excluded.window_start,
      window_reset = excluded.window_reset,
      updated_at   = excluded.updated_at
  `);

  let upserted = 0;
  db.transaction(() => {
    for (const row of rows) {
      upsert.run(
        row.connection_id, row.model,
        row.tokens_used, row.token_limit,
        row.window_start, row.window_reset
      );
      upserted++;
    }
  })();

  logger.info(`[quota-rollup] Seeded provider_quota_state: ${upserted} rows`);
  return upserted;
}

// ---------------------------------------------------------------------------
// Job 3: Daily rollup — hourly_usage_summary → daily_usage_summary
// ---------------------------------------------------------------------------
export async function runDailyRollup() {
  const db = await getDb();
  const today = new Date().toISOString().slice(0, 10); // "2026-09-19"

  const stmt = db.prepare(`
    INSERT INTO daily_usage_summary
      (day_key, connection_id, window_key, hour_count,
       exhausted_hours, avg_remaining_pct, min_remaining_pct, created_at)
    SELECT
      ? as day_key,
      connection_id,
      window_key,
      COUNT(*)                              as hour_count,
      SUM(CASE WHEN min_remaining_pct = 0 THEN 1 ELSE 0 END) as exhausted_hours,
      ROUND(AVG(avg_remaining_pct), 2)      as avg_remaining_pct,
      ROUND(MIN(min_remaining_pct), 2)      as min_remaining_pct,
      datetime('now')                       as created_at
    FROM hourly_usage_summary
    WHERE hour_key LIKE ?
    GROUP BY connection_id, window_key
    ON CONFLICT(day_key, connection_id, window_key) DO UPDATE SET
      hour_count        = excluded.hour_count,
      exhausted_hours   = excluded.exhausted_hours,
      avg_remaining_pct = excluded.avg_remaining_pct,
      min_remaining_pct = excluded.min_remaining_pct
  `);

  const info = db.transaction(() => stmt.run(today, `${today}%`))();
  logger.info(`[quota-rollup] Daily rollup for ${today}: ${info.changes} rows`);
  return info.changes;
}

// ---------------------------------------------------------------------------
// Job 4: Snapshot pruning — keep last 7 days
// ---------------------------------------------------------------------------
export async function runSnapshotPrune() {
  const db = await getDb();
  const stmt = db.prepare(
    `DELETE FROM quota_snapshots WHERE created_at < datetime('now', '-7 days')`
  );
  const info = db.transaction(() => stmt.run())();
  logger.info(`[quota-rollup] Pruned ${info.changes} stale snapshot rows`);
  return info.changes;
}

// ---------------------------------------------------------------------------
// Registration — idempotent INSERT OR IGNORE into jobs table
// ---------------------------------------------------------------------------
export async function registerRollupJobs() {
  const db = await getDb();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO jobs (id, type, interval_ms, enabled, config, created_at, updated_at)
    VALUES (?, 'interval', ?, 1, ?, datetime('now'), datetime('now'))
  `);

  db.transaction(() => {
    insert.run('quota_hourly_rollup',  60 * 60 * 1000,  JSON.stringify({ description: 'Aggregate quota_snapshots into hourly_usage_summary' }));
    insert.run('quota_daily_rollup',   24 * 60 * 60 * 1000, JSON.stringify({ description: 'Aggregate hourly_usage_summary into daily_usage_summary' }));
    insert.run('quota_snapshot_prune', 6 * 60 * 60 * 1000,  JSON.stringify({ description: 'Prune quota_snapshots older than 7 days' }));
    insert.run('quota_state_seed',     5 * 60 * 1000,        JSON.stringify({ description: 'Seed provider_quota_state from latest snapshots (live UI view)' }));
  })();

  logger.info('[quota-rollup] Registered 4 rollup jobs into jobs table');
}
