/**
 * Routing Logger
 * 
 * Tracks real-time routing decisions, health status, and success rates
 * of the load balancer for presentation in the Unified Dashboard.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';

// Resolve the solidstack repo root (NOT process.cwd()) so telemetry lands in
// the unified `.logs` directory even when launchd spawns the service with cwd=/.
const SOLIDSTACK_BASE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const MAX_HISTORY = 50;
const history = [];

let totalRequests = 0;
let successCount = 0;
let rateLimitCount = 0;
let failureCount = 0;
const requestCountByAccount = {};
const requestCountByModelFamily = {
    gemini: { total: 0, success: 0, rate_limit: 0, error: 0 },
    claude: { total: 0, success: 0, rate_limit: 0, error: 0 },
    other: { total: 0, success: 0, rate_limit: 0, error: 0 }
};
const requestCountByModel = {};

/**
 * Determine model family from model ID.
 * @param {string} model 
 * @returns {'gemini'|'claude'|'other'}
 */
function getModelFamily(model) {
    if (!model) return 'other';
    const m = model.toLowerCase();
    if (m.includes('claude')) return 'claude';
    if (m.includes('gemini')) return 'gemini';
    return 'other';
}

/**
 * Log a load balancer routing decision and its outcome.
 * 
 * @param {string} model - Requested model ID
 * @param {string} email - Selected account email
 * @param {number} score - Selection score
 * @param {string} status - Outcome status ('success', 'rate_limit', 'error')
 * @param {Object} [details] - Additional optional details (e.g. latency, error message)
 */
export function logRoutingDecision(model, email, score, status, details = {}) {
    totalRequests++;
    if (status === 'success') {
        successCount++;
    } else if (status === 'rate_limit') {
        rateLimitCount++;
    } else {
        failureCount++;
    }

    // Model family tracking
    const family = getModelFamily(model);
    requestCountByModelFamily[family].total++;
    if (status === 'success') {
        requestCountByModelFamily[family].success++;
    } else if (status === 'rate_limit') {
        requestCountByModelFamily[family].rate_limit++;
    } else {
        requestCountByModelFamily[family].error++;
    }

    // Specific model tracking
    if (model) {
        if (!requestCountByModel[model]) {
            requestCountByModel[model] = { total: 0, success: 0, rate_limit: 0, error: 0 };
        }
        requestCountByModel[model].total++;
        if (status === 'success') {
            requestCountByModel[model].success++;
        } else if (status === 'rate_limit') {
            requestCountByModel[model].rate_limit++;
        } else {
            requestCountByModel[model].error++;
        }
    }

    if (email) {
        if (!requestCountByAccount[email]) {
            requestCountByAccount[email] = { success: 0, rate_limit: 0, error: 0, total: 0 };
        }
        requestCountByAccount[email].total++;
        if (status === 'success') {
            requestCountByAccount[email].success++;
        } else if (status === 'rate_limit') {
            requestCountByAccount[email].rate_limit++;
        } else {
            requestCountByAccount[email].error++;
        }
    }

    const logEntry = {
        id: `route_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        timestamp: new Date().toISOString(),
        model,
        family,
        email,
        score: score != null ? Math.round(score * 10) / 10 : null,
        status,
        ...details
    };

    history.unshift(logEntry); // Newest first
    if (history.length > MAX_HISTORY) {
        history.pop();
    }
}
/**
 * Log structured telemetry event to .logs/routing-telemetry.jsonl for SSC (SolidStack Control).
 *
 * @param {'ROUTER_BYPASS'|'MODEL_FALLBACK'|'ALL_EXHAUSTED'|'NATIVE_ACCOUNT_DETECTED'} eventType
 * @param {Object} details - Event payload
 */
export function logRoutingTelemetry(eventType, details = {}) {
    try {
        const logsDir = path.join(SOLIDSTACK_BASE_DIR, '.logs');
        if (!fs.existsSync(logsDir)) {
            fs.mkdirSync(logsDir, { recursive: true });
        }

        const telemetryFile = path.join(logsDir, 'routing-telemetry.jsonl');
        const telemetryEntry = {
            timestamp: new Date().toISOString(),
            eventType,
            ...details
        };

        fs.appendFileSync(telemetryFile, JSON.stringify(telemetryEntry) + '\n', 'utf8');

        // Also update routing-mode.json metadata for SSC dashboard summary
        const routingModeFile = path.join(logsDir, 'routing-mode.json');
        let currentMode = {};
        if (fs.existsSync(routingModeFile)) {
            try { currentMode = JSON.parse(fs.readFileSync(routingModeFile, 'utf8')); } catch {}
        }
        currentMode.lastTelemetryEvent = {
            eventType,
            timestamp: telemetryEntry.timestamp,
            summary: details.reason || details.message || `${eventType} triggered`
        };
        fs.writeFileSync(routingModeFile, JSON.stringify(currentMode, null, 2), 'utf8');

        logger.info(`[Telemetry] Recorded ${eventType}: ${details.reason || details.message || 'Event logged'}`);
    } catch (e) {
        logger.warn(`[Telemetry] Failed to log telemetry: ${e.message}`);
    }
}

/**
 * Get aggregated load balancing statistics and recent history.
 * 
 * @returns {Object} Stats and history payload
 */
export function getRoutingStats() {
    return {
        totalRequests,
        successCount,
        rateLimitCount,
        failureCount,
        successRate: totalRequests > 0 ? Math.round((successCount / totalRequests) * 100) : 100,
        distribution: requestCountByAccount,
        byModelFamily: requestCountByModelFamily,
        byModel: requestCountByModel,
        history
    };
}

