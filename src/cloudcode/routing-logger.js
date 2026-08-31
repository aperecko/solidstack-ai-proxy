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
    gemini: { total: 0, success: 0, rate_limit: 0, error: 0, tokens: 0 },
    claude: { total: 0, success: 0, rate_limit: 0, error: 0, tokens: 0 },
    other: { total: 0, success: 0, rate_limit: 0, error: 0, tokens: 0 }
};
const requestCountByModel = {};

// In-flight active operations
const inFlightRequests = new Map();

// Accumulated Tokens
const accumulatedTokens = {
    input: 0,
    output: 0,
    cache: 0,
    total: 0
};

// Local vs Remote Workload tracking
const localStats = {
    requests: 0,
    tokens: 0,
    byEngine: {
        ollama: { requests: 0, tokens: 0, inFlight: 0 },
        'turbo-fieldfare': { requests: 0, tokens: 0, inFlight: 0 }
    }
};

const remoteStats = {
    requests: 0,
    tokens: 0
};

/**
 * Determine model family from model ID.
 * @param {string} model 
 * @returns {'gemini'|'claude'|'local'|'other'}
 */
export function getModelFamily(model) {
    if (!model) return 'other';
    const m = model.toLowerCase();
    if (m.includes('ollama') || m.includes('turbo') || m.includes('local') || m.includes('gemma-4') || m.includes('qwen') || m.includes('llama')) return 'local';
    if (m.includes('claude')) return 'claude';
    if (m.includes('gemini')) return 'gemini';
    return 'other';
}

/**
 * Start tracking an in-flight operation
 * @param {string} id
 * @param {Object} metadata
 */
export function startInFlight(id, metadata = {}) {
    const entry = {
        id,
        startTime: Date.now(),
        model: metadata.model || 'unknown',
        family: getModelFamily(metadata.model),
        isLocal: !!metadata.isLocal,
        engine: metadata.engine || (metadata.isLocal ? 'ollama' : null),
        accountEmail: metadata.accountEmail || null
    };
    inFlightRequests.set(id, entry);
    if (entry.isLocal && entry.engine && localStats.byEngine[entry.engine]) {
        localStats.byEngine[entry.engine].inFlight++;
    }
    return entry;
}

/**
 * End tracking an in-flight operation
 * @param {string} id
 * @param {Object} outcome
 */
export function endInFlight(id, outcome = {}) {
    const entry = inFlightRequests.get(id);
    if (!entry) return;
    inFlightRequests.delete(id);
    if (entry.isLocal && entry.engine && localStats.byEngine[entry.engine]) {
        localStats.byEngine[entry.engine].inFlight = Math.max(0, localStats.byEngine[entry.engine].inFlight - 1);
    }
    const durationMs = Date.now() - entry.startTime;
    return { ...entry, durationMs, ...outcome };
}

/**
 * Record token consumption
 * @param {Object} usage
 */
export function recordTokenUsage(usage = {}) {
    const input = Number(usage.input_tokens || usage.inputTokens || usage.prompt_tokens || 0);
    const output = Number(usage.output_tokens || usage.outputTokens || usage.completion_tokens || 0);
    const cache = Number(usage.cache_read_input_tokens || usage.cacheTokens || 0);
    const total = input + output;

    accumulatedTokens.input += input;
    accumulatedTokens.output += output;
    accumulatedTokens.cache += cache;
    accumulatedTokens.total += total;

    const isLocal = !!usage.isLocal;
    const engine = usage.engine || (isLocal ? 'ollama' : null);
    const model = usage.model || '';
    const family = getModelFamily(model);

    if (isLocal) {
        localStats.tokens += total;
        if (engine && localStats.byEngine[engine]) {
            localStats.byEngine[engine].tokens += total;
        }
    } else {
        remoteStats.tokens += total;
        if (requestCountByModelFamily[family]) {
            requestCountByModelFamily[family].tokens += total;
        }
    }
}

/**
 * Log a load balancer routing decision and its outcome.
 * 
 * @param {string} model - Requested model ID
 * @param {string} email - Selected account email
 * @param {number} score - Selection score
 * @param {string} status - Outcome status ('success', 'rate_limit', 'error', 'local_fallback')
 * @param {Object} [details] - Additional optional details (e.g. latency, error message, isLocal, engine, tokens)
 */
export function logRoutingDecision(model, email, score, status, details = {}) {
    totalRequests++;
    if (status === 'success' || status === 'local_fallback' || status === 'native_bypass') {
        successCount++;
    } else if (status === 'rate_limit') {
        rateLimitCount++;
    } else {
        failureCount++;
    }

    const isLocal = !!details.isLocal || status === 'local_fallback' || (model && (model.includes('local') || model.includes('turbo') || model.includes('ollama')));
    const engine = details.engine || (isLocal ? 'ollama' : null);

    if (isLocal) {
        localStats.requests++;
        if (engine && localStats.byEngine[engine]) {
            localStats.byEngine[engine].requests++;
        }
    } else {
        remoteStats.requests++;
    }

    // Model family tracking
    const family = getModelFamily(model);
    if (requestCountByModelFamily[family]) {
        requestCountByModelFamily[family].total++;
        if (status === 'success' || status === 'local_fallback' || status === 'native_bypass') {
            requestCountByModelFamily[family].success++;
        } else if (status === 'rate_limit') {
            requestCountByModelFamily[family].rate_limit++;
        } else {
            requestCountByModelFamily[family].error++;
        }
    }

    // Specific model tracking
    if (model) {
        if (!requestCountByModel[model]) {
            requestCountByModel[model] = { total: 0, success: 0, rate_limit: 0, error: 0 };
        }
        requestCountByModel[model].total++;
        if (status === 'success' || status === 'local_fallback' || status === 'native_bypass') {
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
        if (status === 'success' || status === 'native_bypass') {
            requestCountByAccount[email].success++;
        } else if (status === 'rate_limit') {
            requestCountByAccount[email].rate_limit++;
        } else {
            requestCountByAccount[email].error++;
        }
    }

    if (details.tokens || details.usage) {
        recordTokenUsage({
            ...details.tokens,
            ...details.usage,
            isLocal,
            engine,
            model
        });
    }

    const logEntry = {
        id: `route_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        timestamp: new Date().toISOString(),
        model,
        family,
        isLocal,
        engine,
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
 * Probe local engines (Ollama & Turbo Fieldfare) with caching
 */
let cachedLocalStatus = null;
let lastProbeTime = 0;
const PROBE_TTL_MS = 4000;

export async function probeLocalEngines() {
    const now = Date.now();
    if (cachedLocalStatus && (now - lastProbeTime < PROBE_TTL_MS)) {
        return cachedLocalStatus;
    }

    const result = {
        ollama: {
            endpoint: 'http://127.0.0.1:11434',
            online: false,
            models: [],
            error: null
        },
        turboFieldfare: {
            endpoint: 'http://127.0.0.1:8088',
            online: false,
            models: [],
            error: null
        }
    };

    // Probe Ollama tags
    try {
        const res = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(600) });
        if (res.ok) {
            const data = await res.json();
            result.ollama.online = true;
            result.ollama.models = (data.models || []).map(m => ({
                name: m.name,
                size: m.size ? `${(m.size / (1024 * 1024 * 1024)).toFixed(1)} GB` : null,
                family: m.details?.family || 'unknown'
            }));
        }
    } catch (e) {
        result.ollama.error = e.message;
    }

    // Probe Turbo Fieldfare
    try {
        const res = await fetch('http://127.0.0.1:8088/v1/models', { signal: AbortSignal.timeout(600) });
        if (res.ok) {
            const data = await res.json();
            result.turboFieldfare.online = true;
            result.turboFieldfare.models = (data.data || []).map(m => ({
                name: m.id,
                family: 'turbo-gemma'
            }));
        }
    } catch (e) {
        result.turboFieldfare.error = e.message;
    }

    cachedLocalStatus = result;
    lastProbeTime = now;
    return result;
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

/**
 * Get comprehensive system usage report (operations, tokens, local vs remote breakdown)
 */
export async function getSystemUsageReport() {
    const localEngines = await probeLocalEngines();
    const totalOps = totalRequests;
    const localOps = localStats.requests;
    const remoteOps = remoteStats.requests;

    const localPct = totalOps > 0 ? Math.round((localOps / totalOps) * 100) : (localEngines.ollama.online ? 15 : 0);
    const remotePct = totalOps > 0 ? Math.round((remoteOps / totalOps) * 100) : (100 - localPct);

    return {
        operations: {
            inFlight: inFlightRequests.size,
            inFlightDetails: Array.from(inFlightRequests.values()),
            totalRequests,
            successCount,
            rateLimitCount,
            failureCount,
            successRate: totalRequests > 0 ? Math.round((successCount / totalRequests) * 100) : 100
        },
        tokens: {
            total: accumulatedTokens.total,
            input: accumulatedTokens.input,
            output: accumulatedTokens.output,
            cache: accumulatedTokens.cache
        },
        workloadSplit: {
            localPercent: localPct,
            remotePercent: remotePct,
            local: {
                totalRequests: localOps,
                totalTokens: localStats.tokens,
                inFlight: Array.from(inFlightRequests.values()).filter(r => r.isLocal).length,
                engines: {
                    ollama: {
                        online: localEngines.ollama.online,
                        models: localEngines.ollama.models,
                        requests: localStats.byEngine.ollama.requests,
                        tokens: localStats.byEngine.ollama.tokens,
                        inFlight: localStats.byEngine.ollama.inFlight
                    },
                    turboFieldfare: {
                        online: localEngines.turboFieldfare.online,
                        models: localEngines.turboFieldfare.models,
                        requests: localStats.byEngine['turbo-fieldfare'].requests,
                        tokens: localStats.byEngine['turbo-fieldfare'].tokens,
                        inFlight: localStats.byEngine['turbo-fieldfare'].inFlight
                    }
                }
            },
            remote: {
                totalRequests: remoteOps,
                totalTokens: remoteStats.tokens,
                inFlight: Array.from(inFlightRequests.values()).filter(r => !r.isLocal).length,
                families: requestCountByModelFamily
            }
        },
        recentActivity: history.slice(0, 20)
    };
}


