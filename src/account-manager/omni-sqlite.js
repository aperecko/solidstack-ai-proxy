/**
 * omni-sqlite.js — Direct native SQLite reader for OmniRoute provider_connections.
 *
 * Reads directly from OmniRoute's SQLite database (~/.omniroute/storage.sqlite)
 * using Node's native `node:sqlite` (read-only mode), decrypting OAuth refresh
 * tokens on the fly using OmniRoute's AES-256-GCM storage encryption key.
 *
 * This establishes OmniRoute SQLite as the single operational source of truth
 * for accounts, making external accounts.json runtime sync obsolete.
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import crypto from 'crypto';
import { logger } from '../utils/logger.js';

const OMNI_ENV_PATH = path.join(homedir(), '.omniroute', 'server.env');
const OMNI_DB_PATH = path.join(homedir(), '.omniroute', 'storage.sqlite');

let _cachedKey = null;

function getDecryptionKey() {
    if (_cachedKey) return _cachedKey;
    if (!existsSync(OMNI_ENV_PATH)) return null;

    try {
        const envContent = readFileSync(OMNI_ENV_PATH, 'utf8');
        const match = envContent.match(/STORAGE_ENCRYPTION_KEY="?([^"\n]+)"?/);
        if (!match || !match[1]) return null;

        _cachedKey = crypto.scryptSync(match[1].trim(), 'omniroute-field-encryption-v1', 32, {
            N: 16384,
            r: 8,
            p: 1
        });
        return _cachedKey;
    } catch (err) {
        logger.warn(`[omni-sqlite] Failed to derive encryption key: ${err.message}`);
        return null;
    }
}

function decrypt(encrypted, key) {
    if (!encrypted || typeof encrypted !== 'string' || !encrypted.startsWith('enc:v1:')) {
        return encrypted;
    }
    const parts = encrypted.split(':');
    if (parts.length !== 5) return null;

    try {
        const iv = Buffer.from(parts[2], 'hex');
        const ct = Buffer.from(parts[3], 'hex');
        const tag = Buffer.from(parts[4], 'hex');
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
    } catch {
        return null;
    }
}

/**
 * Load accounts directly from OmniRoute's SQLite database.
 * @returns {Promise<{accounts: Array, settings: Object, activeIndex: number}|null>}
 */
export async function loadAccountsFromOmniRoute() {
    if (!existsSync(OMNI_DB_PATH)) {
        return null;
    }

    const key = getDecryptionKey();
    if (!key) {
        logger.warn('[omni-sqlite] Storage encryption key unavailable; cannot decrypt OmniRoute SQLite');
        return null;
    }

    let db;
    try {
        db = new DatabaseSync(OMNI_DB_PATH, { readOnly: true });
        const rows = db.prepare(`
            SELECT id, email, refresh_token, access_token, project_id, is_active, 
                   provider_specific_data, last_used_at, priority
            FROM provider_connections 
            WHERE provider = 'antigravity' AND is_active = 1
            ORDER BY priority ASC
        `).all();

        if (!rows || rows.length === 0) {
            return null;
        }

        const accounts = [];
        for (const row of rows) {
            const email = row.email || row.name;
            if (!email) continue;

            const rt = decrypt(row.refresh_token, key);
            let meta = {};
            if (row.provider_specific_data) {
                try {
                    meta = typeof row.provider_specific_data === 'string'
                        ? JSON.parse(row.provider_specific_data)
                        : row.provider_specific_data;
                } catch {}
            }

            accounts.push({
                email,
                source: 'oauth',
                enabled: Boolean(row.is_active),
                refreshToken: rt,
                projectId: row.project_id || meta.projectId || undefined,
                isInvalid: false,
                invalidReason: null,
                verifyUrl: null,
                modelRateLimits: {},
                lastUsed: row.last_used_at || null,
                priority: row.priority || 0,
                subscription: {
                    tier: meta.tier || 'unknown',
                    subscriptionTier: meta.subscriptionTier || 'Google AI Standard',
                    projectId: row.project_id || meta.projectId || null,
                    detectedAt: null
                },
                quota: { models: {}, lastChecked: null }
            });
        }

        logger.info(`[omni-sqlite] Successfully loaded and decrypted ${accounts.length} account(s) directly from OmniRoute SQLite`);
        return {
            accounts,
            settings: {},
            activeIndex: 0
        };
    } catch (err) {
        logger.error(`[omni-sqlite] Failed reading from OmniRoute SQLite: ${err.message}`);
        return null;
    } finally {
        if (db) {
            try { db.close(); } catch {}
        }
    }
}
