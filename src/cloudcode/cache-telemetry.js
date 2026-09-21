/**
 * Cache Telemetry - Automated Prompt Caching Metrics
 *
 * Tracks per-request cache hit/miss events with TTFB latency, token savings,
 * and hit-rate rolling windows. Appends structured JSONL to
 * .logs/cache-telemetry.jsonl and emits live events on routingEvents.
 *
 * Telemetry shape per request:
 *   timestamp, requestId, model, family, accountEmail,
 *   cacheHit, cacheReadTokens, inputTokens, outputTokens,
 *   totalPromptTokens, cacheHitPct, savedTokens,
 *   ttfbMs, totalMs, latencyImpactMs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';
import { routingEvents } from './routing-logger.js';

const SOLIDSTACK_BASE_DIR = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)), '../../..'
);
const LOGS_DIR           = path.join(SOLIDSTACK_BASE_DIR, '.logs');
const CACHE_TELEMETRY_FILE = path.join(LOGS_DIR, 'cache-telemetry.jsonl');
const CACHE_STATS_FILE     = path.join(LOGS_DIR, 'cache-stats.json');

// Rolling windows keyed by model
// { [model]: { hits, misses, totalSavedTokens, hitTtfbSamples[], missTtfbSamples[],
//              avgHitTtfbMs, avgMissTtfbMs, lastUpdated } }
const rollingStats = {};

// In-flight request timers keyed by requestId
// { startMs: number, ttfbMs: number|null }
const inFlight = new Map();

/**
 * Mark start of a request (call when upstream HTTP request is dispatched).
 */
export function cacheTimerStart(requestId) {
    inFlight.set(requestId, { startMs: Date.now(), ttfbMs: null });
}

/**
 * Mark time of first content chunk - TTFB.
 * Call when first non-empty SSE content part is yielded.
 */
export function cacheTimerTTFB(requestId) {
    const entry = inFlight.get(requestId);
    if (entry && entry.ttfbMs === null) {
        entry.ttfbMs = Date.now() - entry.startMs;
    }
}

/**
 * Record completed request cache telemetry.
 * Call after stream finishes and usage is known.
 *
 * @param {Object} p
 * @param {string}  p.requestId
 * @param {string}  p.model
 * @param {string}  p.family           - 'claude' | 'gemini' | 'other'
 * @param {string}  [p.accountEmail]
 * @param {number}  p.inputTokens      - promptTokenCount - cachedContentTokenCount
 * @param {number}  p.outputTokens
 * @param {number}  p.cacheReadTokens  - cachedContentTokenCount
 */
export function recordCacheTelemetry({
    requestId, model, family, accountEmail = null,
    inputTokens = 0, outputTokens = 0, cacheReadTokens = 0
}) {
    const timer = inFlight.get(requestId);
    inFlight.delete(requestId);

    const now = Date.now();
    const totalMs         = timer ? (now - timer.startMs) : null;
    const ttfbMs          = timer ? (timer.ttfbMs ?? totalMs) : null;
    const totalPromptTokens = inputTokens + cacheReadTokens;
    const cacheHit        = cacheReadTokens > 0;
    const cacheHitPct     = totalPromptTokens > 0
        ? Math.round((cacheReadTokens / totalPromptTokens) * 10000) / 100
        : 0;

    // Update rolling stats
    if (!rollingStats[model]) {
        rollingStats[model] = {
            hits: 0, misses: 0,
            totalSavedTokens: 0,
            hitTtfbSamples: [], missTtfbSamples: [],
            avgHitTtfbMs: null, avgMissTtfbMs: null,
            lastUpdated: null
        };
    }
    const rs = rollingStats[model];
    if (cacheHit) {
        rs.hits++;
        rs.totalSavedTokens += cacheReadTokens;
        if (ttfbMs !== null) {
            rs.hitTtfbSamples.push(ttfbMs);
            if (rs.hitTtfbSamples.length > 100) rs.hitTtfbSamples.shift();
            rs.avgHitTtfbMs = Math.round(
                rs.hitTtfbSamples.reduce((a, b) => a + b, 0) / rs.hitTtfbSamples.length
            );
        }
    } else {
        rs.misses++;
        if (ttfbMs !== null) {
            rs.missTtfbSamples.push(ttfbMs);
            if (rs.missTtfbSamples.length > 100) rs.missTtfbSamples.shift();
            rs.avgMissTtfbMs = Math.round(
                rs.missTtfbSamples.reduce((a, b) => a + b, 0) / rs.missTtfbSamples.length
            );
        }
    }
    rs.lastUpdated = new Date().toISOString();

    // Latency impact vs miss baseline for same model
    const latencyImpactMs = (ttfbMs !== null && rs.avgMissTtfbMs !== null)
        ? ttfbMs - rs.avgMissTtfbMs
        : null;

    const telEntry = {
        timestamp: new Date().toISOString(),
        requestId, model, family, accountEmail,
        cacheHit, cacheReadTokens, savedTokens: cacheReadTokens,
        inputTokens, outputTokens, totalPromptTokens,
        cacheHitPct, ttfbMs, totalMs, latencyImpactMs
    };

    _appendTelemetry(telEntry);
    _saveStats();
    routingEvents.emit('CACHE_TELEMETRY', telEntry);

    if (cacheHit) {
        logger.info(
            `[CacheTelemetry] HIT model=${model} saved=${cacheReadTokens}tok ` +
            `pct=${cacheHitPct}% ttfb=${ttfbMs}ms impact=${latencyImpactMs}ms`
        );
    }
    return telEntry;
}

/**
 * Get current rolling cache stats for all models.
 */
export function getCacheStats() {
    const global = { totalHits: 0, totalMisses: 0, totalSavedTokens: 0, hitRate: 0 };
    for (const rs of Object.values(rollingStats)) {
        global.totalHits         += rs.hits;
        global.totalMisses       += rs.misses;
        global.totalSavedTokens  += rs.totalSavedTokens;
    }
    const total = global.totalHits + global.totalMisses;
    global.hitRate = total > 0 ? Math.round((global.totalHits / total) * 10000) / 100 : 0;
    return { byModel: { ...rollingStats }, global };
}

function _appendTelemetry(entry) {
    try {
        if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
        fs.appendFileSync(CACHE_TELEMETRY_FILE, JSON.stringify(entry) + '\n', 'utf8');
    } catch (e) {
        logger.warn(`[CacheTelemetry] appendTelemetry failed: ${e.message}`);
    }
}

function _saveStats() {
    try {
        if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
        const snapshot = { updatedAt: new Date().toISOString(), ...getCacheStats() };
        const tmp = `${CACHE_STATS_FILE}.tmp.${Date.now()}`;
        fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2), 'utf8');
        fs.renameSync(tmp, CACHE_STATS_FILE);
    } catch (e) {
        logger.warn(`[CacheTelemetry] saveStats failed: ${e.message}`);
    }
}
