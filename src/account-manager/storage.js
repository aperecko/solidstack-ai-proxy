/**
 * Account Storage
 *
 * Handles loading and saving account configuration to disk.
 */

import { readFile, writeFile, mkdir, access, rename, open, unlink } from 'fs/promises';
import { constants as fsConstants } from 'fs';
import { dirname } from 'path';
import { ACCOUNT_CONFIG_PATH } from '../constants.js';
import { getAuthStatus } from '../auth/database.js';
import { logger } from '../utils/logger.js';

let writeLock = null;

/**
 * Cross-process advisory file lock using atomic `open('wx')`.
 *
 * Why: the in-process `writeLock` serializes writes only within one Node
 * process. Multiple proxies/processes writing the same account config must
 * coordinate on disk or they can corrupt each other (C7).
 *
 * `wx` fails if the lock file already exists => that's the atomic claim.
 * Stale locks (older than `maxAgeMs`) are broken so a crashed writer doesn't
 * deadlock the system permanently.
 */
export async function withFileLock(lockPath, fn, { maxAgeMs = 15000, retries = 40, delayMs = 125 } = {}) {
    await mkdir(dirname(lockPath), { recursive: true });
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const handle = await open(lockPath, 'wx');
            await handle.writeFile(String(Date.now()));
            await handle.close();
            try {
                return await fn();
            } finally {
                await unlink(lockPath).catch(() => {});
            }
        } catch (err) {
            if (err && (err.code === 'EEXIST' || err.code === 'ENOENT')) {
                // Break stale locks created more than maxAgeMs ago.
                try {
                    const h = await open(lockPath, 'r');
                    const st = await h.stat();
                    await h.close();
                    if (Date.now() - st.mtimeMs > maxAgeMs) {
                        await unlink(lockPath).catch(() => {});
                        continue;
                    }
                } catch {
                    // ignore stat race; fall through to retry
                }
                if (attempt >= retries) {
                    throw new Error(`Timed out acquiring lock ${lockPath}`);
                }
                await new Promise((r) => setTimeout(r, delayMs));
                continue;
            }
            throw err;
        }
    }
    throw new Error(`Timed out acquiring lock ${lockPath}`);
}

/**
 * Load accounts from the config file
 *
 * @param {string} configPath - Path to the config file
 * @returns {Promise<{accounts: Array, settings: Object, activeIndex: number}>}
 */
export async function loadAccounts(configPath = ACCOUNT_CONFIG_PATH) {
    try {
        // Check if config file exists using async access
        await access(configPath, fsConstants.F_OK);
        const configData = await readFile(configPath, 'utf-8');
        const config = JSON.parse(configData);

        const accounts = (config.accounts || []).map(acc => {
            let isInvalid = acc.isInvalid || false;
            let invalidReason = acc.invalidReason || null;
            if (invalidReason && (
                invalidReason.toLowerCase().includes('enotfound') ||
                invalidReason.toLowerCase().includes('etimedout') ||
                invalidReason.toLowerCase().includes('fetch failed') ||
                invalidReason.toLowerCase().includes('econnreset') ||
                invalidReason.toLowerCase().includes('econnrefused') ||
                invalidReason.toLowerCase().includes('socket hang up')
            )) {
                isInvalid = false;
                invalidReason = null;
            }
            return {
                ...acc,
                refreshToken: acc.refreshToken || acc.refresh_token || null,
                lastUsed: acc.lastUsed || null,
                enabled: acc.enabled !== false, // Default to true if not specified
                isInvalid,
                invalidReason,
                verifyUrl: acc.verifyUrl || null,
                modelRateLimits: acc.modelRateLimits || {},
                // New fields for subscription and quota tracking
                subscription: acc.subscription || { tier: 'unknown', projectId: null, detectedAt: null },
                quota: acc.quota || { models: {}, lastChecked: null },
                // Quota threshold settings (per-account and per-model overrides)
                quotaThreshold: acc.quotaThreshold,  // undefined means use global
                modelQuotaThresholds: acc.modelQuotaThresholds || {}
            };
        });

        const settings = config.settings || {};
        let activeIndex = config.activeIndex || 0;

        // Clamp activeIndex to valid range
        if (activeIndex >= accounts.length) {
            activeIndex = 0;
        }

        logger.info(`[AccountManager] Loaded ${accounts.length} account(s) from config`);

        return { accounts, settings, activeIndex };
    } catch (error) {
        if (error.code === 'ENOENT') {
            // No config file - return empty
            logger.info('[AccountManager] No config file found. Using Antigravity database (single account mode)');
            return { accounts: [], settings: {}, activeIndex: 0 };
        } else {
            logger.error('[AccountManager] FATAL: Failed to load config (corruption?):', error.message);
            throw error; // Throw so caller doesn't wipe in-memory token cache
        }
    }
}

/**
 * Load the default account from Antigravity's database
 *
 * @param {string} dbPath - Optional path to the database
 * @returns {{accounts: Array, tokenCache: Map}}
 */
export function loadDefaultAccount(dbPath) {
    try {
        const authData = getAuthStatus(dbPath);
        if (authData?.apiKey) {
            const account = {
                email: authData.email || 'default@antigravity',
                source: 'database',
                lastUsed: null,
                modelRateLimits: {}
            };

            const tokenCache = new Map();
            tokenCache.set(account.email, {
                token: authData.apiKey,
                extractedAt: Date.now()
            });

            logger.info(`[AccountManager] Loaded default account: ${account.email}`);

            return { accounts: [account], tokenCache };
        }
    } catch (error) {
        logger.error('[AccountManager] Failed to load default account:', error.message);
    }

    return { accounts: [], tokenCache: new Map() };
}

/**
 * Save account configuration to disk
 *
 * @param {string} configPath - Path to the config file
 * @param {Array} accounts - Array of account objects
 * @param {Object} settings - Settings object
 * @param {number} activeIndex - Current active account index
 */
export async function saveAccounts(configPath, accounts, settings, activeIndex) {
    // Serialize writes to prevent concurrent corruption (intra-process)
    const previousLock = writeLock;
    let resolve;
    writeLock = new Promise(r => { resolve = r; });

    try {
        if (previousLock) await previousLock;
    } catch {
        // Previous write failed, proceed anyway
    }

    // Acquire cross-process lock to coordinate with other proxy processes
    // sharing the same account config file (C7 atomicity).
    const lockPath = configPath + '.lock';
    let saved = false;
    try {
        await withFileLock(lockPath, async () => {
            await mkdir(dirname(configPath), { recursive: true });

            const config = {
                accounts: accounts.filter(acc => acc.source !== '1password' && acc.type !== 'apikey').map(acc => ({
                    email: acc.email,
                    source: acc.source,
                    enabled: acc.enabled !== false,
                    dbPath: acc.dbPath || null,
                    refreshToken: (acc.source === 'oauth' || acc.refreshToken?.startsWith('PENDING_AUTH')) ? acc.refreshToken : undefined,
                    apiKey: acc.source === 'manual' ? acc.apiKey : undefined,
                    projectId: acc.projectId || undefined,
                    addedAt: acc.addedAt || undefined,
                    isInvalid: acc.isInvalid || false,
                    invalidReason: acc.invalidReason || null,
                    verifyUrl: acc.verifyUrl || null,
                    modelRateLimits: acc.modelRateLimits || {},
                    lastUsed: acc.lastUsed,
                    subscription: acc.subscription || { tier: 'unknown', projectId: null, detectedAt: null },
                    quota: acc.quota || { models: {}, lastChecked: null },
                    quotaThreshold: acc.quotaThreshold,
                    modelQuotaThresholds: Object.keys(acc.modelQuotaThresholds || {}).length > 0 ? acc.modelQuotaThresholds : undefined,
                    disabledBy429: acc.disabledBy429 || false,
                    consecutiveFailures: acc.consecutiveFailures || 0
                })),
                settings: settings,
                activeIndex: activeIndex
            };

            const json = JSON.stringify(config, null, 2);

            // Validate JSON before writing (prevent saving corrupt data)
            JSON.parse(json);

            // Atomic write: write to temp file then rename
            const tmpPath = configPath + '.tmp';
            await writeFile(tmpPath, json);
            await rename(tmpPath, configPath);
            saved = true;
        });
    } catch (error) {
        logger.error('[AccountManager] Failed to save config (lock or write):', error.message);
    } finally {
        void saved;
        resolve();
    }
}
