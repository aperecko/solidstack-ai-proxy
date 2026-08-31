/**
 * Session Management for Cloud Code
 *
 * Handles session ID derivation for prompt caching continuity.
 * Session IDs are derived from the first user message to ensure
 * the same conversation uses the same session across turns.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';

const SESSION_DIR = path.join(os.homedir(), '.solidstack', 'sessions');
const SESSION_FILE = path.join(SESSION_DIR, 'cloudcode-sessions.json');

// Runtime storage for session IDs (per account)
// Key: accountEmail, Value: sessionId
const runtimeSessionStore = new Map();

function loadSessionsFromDisk() {
    try {
        if (fs.existsSync(SESSION_FILE)) {
            const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
            if (data && typeof data === 'object') {
                for (const [k, v] of Object.entries(data)) {
                    if (typeof v === 'string') {
                        runtimeSessionStore.set(k, v);
                    }
                }
            }
        }
    } catch (e) {
        // Non-fatal fallback
    }
}

function saveSessionsToDisk() {
    try {
        if (!fs.existsSync(SESSION_DIR)) {
            fs.mkdirSync(SESSION_DIR, { recursive: true });
        }
        const obj = Object.fromEntries(runtimeSessionStore);
        const tmpFile = `${SESSION_FILE}.tmp.${Date.now()}`;
        fs.writeFileSync(tmpFile, JSON.stringify(obj, null, 2), 'utf8');
        fs.renameSync(tmpFile, SESSION_FILE);
    } catch (e) {
        // Non-fatal fallback
    }
}

// Load existing active sessions on module load
loadSessionsFromDisk();

/**
 * Get or create a session ID for the given account.
 * 
 * Stored persistently across proxy restarts to ensure prompt caching
 * continuity with upstream providers (Google Cloud Code / Gemini / Anthropic).
 *
 * @param {Object} anthropicRequest - The Anthropic-format request
 * @param {string} accountEmail - The account email to scope the session ID
 * @returns {string} A stable session ID string matching binary format
 */
export function deriveSessionId(anthropicRequest, accountEmail) {
    if (!accountEmail) {
        return generateBinaryStyleId();
    }

    if (runtimeSessionStore.has(accountEmail)) {
        return runtimeSessionStore.get(accountEmail);
    }

    const newSessionId = generateBinaryStyleId();
    runtimeSessionStore.set(accountEmail, newSessionId);
    saveSessionsToDisk();

    return newSessionId;
}

/**
 * Generate a Session ID using the binary's exact logic.
 * logic: `rs() + Date.now()` where `rs()` is randomUUID
 */
function generateBinaryStyleId() {
    return crypto.randomUUID() + Date.now().toString();
}

/**
 * Clears all session IDs (e.g. useful for testing or explicit reset)
 */
export function clearSessionStore() {
    runtimeSessionStore.clear();
    saveSessionsToDisk();
}
