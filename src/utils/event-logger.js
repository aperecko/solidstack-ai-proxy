/**
 * Persistent Event Logger for AI Proxy
 * 
 * Manages an event log (account_used, 429, re-enabled, disabled, added, cooldown)
 * and persists the latest entries to disk so event history survives restarts.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { logger } from './logger.js';

const STORAGE_DIR = path.join(os.homedir(), '.antigravity-claude-proxy');
const EVENT_LOG_FILE = path.join(STORAGE_DIR, 'event-log.json');
const MAX_EVENTS = 100;

class PersistentEventLogger {
    #events = [];
    #saveTimer = null;

    constructor() {
        this.#loadFromDisk();
    }

    #loadFromDisk() {
        try {
            if (fs.existsSync(EVENT_LOG_FILE)) {
                const data = fs.readFileSync(EVENT_LOG_FILE, 'utf8');
                const parsed = JSON.parse(data);
                if (Array.isArray(parsed)) {
                    this.#events = parsed.slice(0, MAX_EVENTS);
                }
            }
        } catch (e) {
            logger.warn(`[EventLogger] Failed to load event log from disk: ${e.message}`);
            this.#events = [];
        }
    }

    #scheduleSave() {
        if (this.#saveTimer) return;
        this.#saveTimer = setTimeout(() => {
            this.#saveTimer = null;
            this.saveToDisk();
        }, 1000);
    }

    saveToDisk() {
        try {
            fs.mkdirSync(STORAGE_DIR, { recursive: true });
            fs.writeFileSync(EVENT_LOG_FILE, JSON.stringify(this.#events, null, 2), 'utf8');
        } catch (e) {
            logger.error(`[EventLogger] Failed to save event log to disk: ${e.message}`);
        }
    }

    /**
     * Log a new event and queue disk persistence.
     * @param {string} type - Event type (e.g. '429', 'disabled', 're-enabled', 'account_added', 'cooldown_set')
     * @param {Object} details - Additional event details (email, model, reason, etc.)
     * @returns {Object} The created event object
     */
    logEvent(type, details = {}) {
        const event = {
            id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
            timestamp: new Date().toISOString(),
            type,
            ...details
        };

        this.#events.unshift(event);
        if (this.#events.length > MAX_EVENTS) {
            this.#events.pop();
        }

        this.#scheduleSave();
        return event;
    }

    /**
     * Get recent events.
     * @param {number} [limit=50]
     * @returns {Array<Object>}
     */
    getEvents(limit = 50) {
        return this.#events.slice(0, limit);
    }

    /**
     * Clear all logged events.
     */
    clearEvents() {
        this.#events = [];
        this.saveToDisk();
    }
}

export const eventLogger = new PersistentEventLogger();
export default eventLogger;
