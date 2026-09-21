/**
 * migration-tracker.js — records applied migrations into _omniroute_migrations.
 *
 * OmniRoute's _omniroute_migrations table exists but has never had rows written
 * into it by ai-proxy side migrations. This module provides:
 *
 *   runMigrations()  — apply all pending migrations in order, skip applied ones
 *   listMigrations() — return applied/pending status of all known migrations
 *
 * Each migration is a plain SQL string or a JS function(db) for complex logic.
 * Migrations are idempotent: running twice is safe.
 */

import path from 'path';
import os from 'os';
import { logger } from '../utils/logger.js';

const DB_PATH = process.env.OMNIROUTE_DB_PATH
  ?? path.join(os.homedir(), '.omniroute', 'storage.sqlite');

let _Database = null;
async function getDatabase() {
  if (!_Database) { const m = await import('better-sqlite3'); _Database = m.default ?? m; }
  return _Database;
}
let _db = null;
async function getDb() {
  if (_db) return _db;
  const D = await getDatabase();
  _db = new D(DB_PATH, { fileMustExist: true });
  _db.pragma('journal_mode = WAL');
  _db.pragma('busy_timeout = 5000');
  return _db;
}

// ---------------------------------------------------------------------------
// Migration registry — append-only, never reorder or edit existing entries
// ---------------------------------------------------------------------------
const MIGRATIONS = [
  {
    id: '001_hourly_summary_unique_index',
    description: 'Add UNIQUE constraint to hourly_usage_summary for ON CONFLICT upserts',
    sql: `
      CREATE UNIQUE INDEX IF NOT EXISTS
        idx_hus_hour_conn_window
      ON hourly_usage_summary(hour_key, connection_id, window_key)
    `
  },
  {
    id: '002_daily_summary_unique_index',
    description: 'Add UNIQUE constraint to daily_usage_summary for ON CONFLICT upserts',
    sql: `
      CREATE UNIQUE INDEX IF NOT EXISTS
        idx_dus_day_conn_window
      ON daily_usage_summary(day_key, connection_id, window_key)
    `
  },
  {
    id: '003_connection_runtime_state_seed',
    description: 'Seed connection_runtime_state rows for all active provider connections',
    fn(db) {
      const conns = db.prepare(
        `SELECT id FROM provider_connections WHERE is_active = 1`
      ).all();
      const insert = db.prepare(`
        INSERT OR IGNORE INTO connection_runtime_state
          (connection_id, refresh_circuit_streak, updated_at)
        VALUES (?, 0, datetime('now'))
      `);
      db.transaction(() => { for (const c of conns) insert.run(c.id); })();
      logger.info(`[migration] 003: seeded ${conns.length} connection_runtime_state rows`);
    }
  },
  {
    id: '004_quota_threshold_defaults',
    description: 'Backfill quota_window_thresholds_json with {warn:20, critical:5} for all active connections',
    fn(db) {
      const defaultThresholds = JSON.stringify({ warn: 20, critical: 5 });
      const info = db.prepare(`
        UPDATE provider_connections
        SET    quota_window_thresholds_json = ?,
               updated_at = datetime('now')
        WHERE  is_active = 1
          AND  quota_window_thresholds_json IS NULL
      `).run(defaultThresholds);
      logger.info(`[migration] 004: backfilled thresholds for ${info.changes} connections`);
    }
  },
  {
    id: '005_rollup_jobs_registration',
    description: 'Register quota rollup background jobs into OmniRoute jobs table',
    fn(db) {
      const insert = db.prepare(`
        INSERT OR IGNORE INTO jobs
          (id, type, interval_ms, enabled, config, created_at, updated_at)
        VALUES (?, 'interval', ?, 1, ?, datetime('now'), datetime('now'))
      `);
      db.transaction(() => {
        insert.run('quota_hourly_rollup',  3_600_000,       JSON.stringify({ description: 'Aggregate quota_snapshots → hourly_usage_summary' }));
        insert.run('quota_daily_rollup',   86_400_000,      JSON.stringify({ description: 'Aggregate hourly → daily_usage_summary' }));
        insert.run('quota_snapshot_prune', 21_600_000,      JSON.stringify({ description: 'Prune quota_snapshots > 7 days' }));
        insert.run('quota_state_seed',     300_000,         JSON.stringify({ description: 'Seed provider_quota_state from latest snapshots' }));
        insert.run('provider_limits_sync', 120_000,         JSON.stringify({ description: 'Parallel quota fetch across all active connections', workers: 50 }));
      })();
      logger.info('[migration] 005: registered 5 background jobs');
    }
  },
];

// ---------------------------------------------------------------------------
// Ensure the migrations table exists (it may be empty)
// ---------------------------------------------------------------------------
async function ensureMigrationsTable(db) {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS _omniroute_migrations (
      id          TEXT PRIMARY KEY,
      description TEXT,
      applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `).run();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export async function runMigrations() {
  const db = await getDb();
  await ensureMigrationsTable(db);

  const applied = new Set(
    db.prepare(`SELECT id FROM _omniroute_migrations`).all().map(r => r.id)
  );

  let ran = 0;
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) {
      logger.debug(`[migration] skip ${m.id} (already applied)`);
      continue;
    }
    try {
      if (m.fn) {
        m.fn(db);
      } else {
        db.prepare(m.sql).run();
      }
      db.prepare(`
        INSERT OR REPLACE INTO _omniroute_migrations (id, description, applied_at)
        VALUES (?, ?, datetime('now'))
      `).run(m.id, m.description);
      logger.info(`[migration] ✓ Applied ${m.id}: ${m.description}`);
      ran++;
    } catch (err) {
      logger.error(`[migration] ✗ Failed ${m.id}: ${err.message}`);
      throw err;
    }
  }

  if (ran === 0) logger.info('[migration] All migrations already applied, nothing to do');
  else logger.info(`[migration] Applied ${ran} migration(s) successfully`);
  return ran;
}

export async function listMigrations() {
  const db = await getDb();
  await ensureMigrationsTable(db);
  const applied = new Set(
    db.prepare(`SELECT id FROM _omniroute_migrations`).all().map(r => r.id)
  );
  return MIGRATIONS.map(m => ({
    id: m.id,
    description: m.description,
    status: applied.has(m.id) ? 'applied' : 'pending'
  }));
}
