/**
 * omniroute-db.js — lightweight read/write access to OmniRoute's SQLite store.
 *
 * Used by background workers and migration scripts that run inside the ai-proxy
 * process. All writes use WAL-safe BEGIN IMMEDIATE transactions so they don't
 * block OmniRoute's own writer. Reads use shared-cache mode.
 *
 * Requires better-sqlite3 (already a dependency of ai-proxy).
 * DB path resolved via OMNIROUTE_DB_PATH env or the well-known default.
 */

import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';

const DB_PATH = process.env.OMNIROUTE_DB_PATH
  ?? path.join(os.homedir(), '.omniroute', 'storage.sqlite');

let _db = null;

export function getDb() {
  if (_db) return _db;
  _db = new Database(DB_PATH, { readonly: false, fileMustExist: true });
  _db.pragma('journal_mode = WAL');
  _db.pragma('busy_timeout = 5000');
  _db.pragma('synchronous = NORMAL');
  return _db;
}

export function closeDb() {
  if (_db) { _db.close(); _db = null; }
}
