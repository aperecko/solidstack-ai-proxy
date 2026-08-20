import fetch from 'node-fetch';
import { logger } from './utils/logger.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BASE_DIR = path.resolve(__dirname, '../../..');
const BRIDGE_STATE_FILE = path.join(BASE_DIR, '.logs', 'openclaw-bridge-state.json');

// OpenClaw native agent API (listening on port 18790)
const OPENCLAW_API = 'http://127.0.0.1:18790';

let isBridgeEnabled = true;

// Load persisted state
try {
    if (fs.existsSync(BRIDGE_STATE_FILE)) {
        const state = JSON.parse(fs.readFileSync(BRIDGE_STATE_FILE, 'utf8'));
        isBridgeEnabled = state.enabled !== false;
    }
} catch (e) {
    logger.error('[OpenClawBridge] Failed to load bridge state:', e);
}

function persistState() {
    try {
        fs.mkdirSync(path.dirname(BRIDGE_STATE_FILE), { recursive: true });
        fs.writeFileSync(BRIDGE_STATE_FILE, JSON.stringify({ enabled: isBridgeEnabled }, null, 2));
    } catch (e) {
        logger.error('[OpenClawBridge] Failed to save bridge state:', e);
    }
}

export function setBridgeEnabled(enabled) {
    isBridgeEnabled = enabled;
    persistState();
    logger.info(`[OpenClawBridge] Bridge is now ${enabled ? 'ENABLED' : 'DISABLED'}`);
}

export function getBridgeStatus() {
    return isBridgeEnabled;
}

/**
 * Emit an event to the OpenClaw native agent.
 * OpenClaw can subscribe to these via its event loop.
 */
export async function emitEvent(eventType, payload) {
    if (!isBridgeEnabled) {
        logger.debug(`[OpenClawBridge] Dropped event '${eventType}' (bridge disabled)`);
        return false;
    }

    try {
        // Attempt to POST to OpenClaw's generic webhook/event inlet
        const response = await fetch(`${OPENCLAW_API}/webhook/solidstack-event`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                source: 'solidstack',
                type: eventType,
                timestamp: new Date().toISOString(),
                data: payload
            }),
            timeout: 2000
        });

        if (!response.ok) {
            logger.warn(`[OpenClawBridge] Failed to emit event '${eventType}'. OpenClaw responded: ${response.status}`);
            return false;
        }

        logger.info(`[OpenClawBridge] Successfully emitted event '${eventType}' to OpenClaw`);
        return true;
    } catch (error) {
        logger.error(`[OpenClawBridge] Error emitting event '${eventType}':`, error.message);
        return false;
    }
}
