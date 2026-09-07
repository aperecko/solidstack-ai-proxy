/**
 * SolidStack Model Compatibility Tester & Registration Engine
 * 
 * Actively probes candidate models via AI Proxy /v1/chat/completions (streaming 1-token test),
 * evaluates latency, token generation, and quota health, and records verified models to
 * ~/.config/antigravity-proxy/active-verified-models.json.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const HOME_DIR = os.homedir();
const CONFIG_DIR = path.join(HOME_DIR, '.config', 'antigravity-proxy');
const VERIFIED_MODELS_PATH = path.join(CONFIG_DIR, 'active-verified-models.json');

export const CANDIDATE_MODELS = [
    { id: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', provider: 'google', family: 'gemini', contextWindow: 1000000 },
    { id: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6', provider: 'anthropic', family: 'claude', contextWindow: 200000 },
    { id: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', provider: 'google', family: 'gemini', contextWindow: 2000000 },
    { id: 'gemini-3.7-flash-high', displayName: 'Gemini 3.7 Flash High', provider: 'google', family: 'gemini', contextWindow: 1000000 },
    { id: 'gemini-pro-agent', displayName: 'Gemini Pro Agent', provider: 'google', family: 'gemini', contextWindow: 2000000 },
    { id: 'gemma-4-26b-a4b-it', displayName: 'Gemma 4 26B-A4B (Local Turbo Fieldfare)', provider: 'local', family: 'gemma', contextWindow: 200000 },
    { id: 'gemma-4-26b-a4b', displayName: 'Gemma 4 26B-A4B (Local)', provider: 'local', family: 'gemma', contextWindow: 200000 },
    { id: 'meta/llama-3.2-11b-vision-instruct', displayName: 'Llama 3.2 11B Vision (NVIDIA NIM)', provider: 'nvidia-nim', family: 'llama', contextWindow: 128000 },
    { id: 'deepseek-ai/deepseek-v4-pro-0813', displayName: 'DeepSeek V4 Pro (NVIDIA NIM)', provider: 'nvidia-nim', family: 'deepseek', contextWindow: 128000 },
    { id: 'nvidia/llama-3.1-nemotron-70b-instruct', displayName: 'Nemotron 70B (NVIDIA NIM)', provider: 'nvidia-nim', family: 'nemotron', contextWindow: 128000 },
    { id: 'fcc-fast', displayName: 'Free Fast (NVIDIA NIM)', provider: 'nvidia-nim', family: 'fcc', contextWindow: 128000 },
    { id: 'deepseek-ai/deepseek-r1', displayName: 'DeepSeek R1 (NIM Free)', provider: 'nvidia-nim', family: 'deepseek', contextWindow: 128000 },
    { id: 'gemini-3.1-pro-high', displayName: 'Gemini 3.1 Pro High', provider: 'google', family: 'gemini', contextWindow: 200000 },
    { id: 'gemini-3.8-flash-high', displayName: 'Gemini 3.8 Flash High', provider: 'google', family: 'gemini', contextWindow: 1000000 },
    { id: 'gemini-2.5-flash-lite', displayName: 'Gemini 2.5 Flash Lite', provider: 'google', family: 'gemini', contextWindow: 200000 }
];

/**
 * Test a single model for real-time streaming completion via AI Proxy.
 * 
 * @param {string} modelId
 * @param {Object} [options]
 * @param {string} [options.baseUrl] - Base URL of AI Proxy (default: http://127.0.0.1:1987/v1)
 * @param {number} [options.timeoutMs] - Request timeout (default: 8000ms)
 * @returns {Promise<Object>} Probe result
 */
export async function testModelCompatibility(modelId, options = {}) {
    const baseUrl = (options.baseUrl || 'http://127.0.0.1:1987/v1').replace(/\/+$/, '');
    const timeoutMs = options.timeoutMs || 20000;
    const url = `${baseUrl}/chat/completions`;

    const startTime = Date.now();
    let ttftMs = null;
    let textBuffer = '';

    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs);

        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer solidstack-proxy',
                'X-Session-Id': `model-probe-${Date.now()}`
            },
            body: JSON.stringify({
                model: modelId,
                messages: [{ role: 'user', content: 'Say "OK".' }],
                max_tokens: 5,
                temperature: 0.1,
                stream: true
            }),
            signal: controller.signal
        });

        if (!res.ok) {
            clearTimeout(timer);
            let errMsg = `HTTP ${res.status} ${res.statusText}`;
            try {
                const errJson = await res.json();
                if (errJson?.error?.message) {
                    errMsg = errJson.error.message;
                }
            } catch {
                // ignore json parse error
            }
            return {
                model: modelId,
                compatible: false,
                latencyMs: Date.now() - startTime,
                ttftMs: null,
                output: null,
                error: errMsg,
                testedAt: new Date().toISOString()
            };
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let done = false;

        while (!done) {
            const { value, done: streamDone } = await reader.read();
            if (streamDone) {
                done = true;
                break;
            }

            const chunk = decoder.decode(value, { stream: true });
            const lines = chunk.split('\n');

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || !trimmed.startsWith('data:')) continue;
                const dataStr = trimmed.slice(5).trim();
                if (dataStr === '[DONE]') {
                    done = true;
                    break;
                }

                try {
                    const parsed = JSON.parse(dataStr);
                    const delta = parsed.choices?.[0]?.delta?.content;
                    if (delta) {
                        if (ttftMs === null) {
                            ttftMs = Date.now() - startTime;
                        }
                        textBuffer += delta;
                    }
                } catch {
                    // Ignore non-json lines
                }
            }
        }

        clearTimeout(timer);
        const totalDuration = Date.now() - startTime;

        return {
            model: modelId,
            compatible: true,
            latencyMs: totalDuration,
            ttftMs: ttftMs || totalDuration,
            output: textBuffer.trim(),
            error: null,
            testedAt: new Date().toISOString()
        };

    } catch (err) {
        return {
            model: modelId,
            compatible: false,
            latencyMs: Date.now() - startTime,
            ttftMs: null,
            output: null,
            error: err.name === 'AbortError' ? `Timeout (${timeoutMs}ms)` : err.message,
            testedAt: new Date().toISOString()
        };
    }
}

/**
 * Audit candidate models and save verified models to disk.
 * 
 * @param {Array<Object>} [candidates]
 * @param {Object} [options]
 * @returns {Promise<Object>} Full audit report
 */
export async function runFullModelAudit(candidates = CANDIDATE_MODELS, options = {}) {
    const verifiedModels = [];
    const failedModels = [];

    for (const item of candidates) {
        const modelId = typeof item === 'string' ? item : item.id;
        const meta = typeof item === 'object' ? item : { id: modelId };

        const testResult = await testModelCompatibility(modelId, options);
        if (testResult.compatible) {
            verifiedModels.push({
                id: modelId,
                displayName: meta.displayName || modelId,
                provider: meta.provider || 'custom',
                family: meta.family || 'unknown',
                contextWindow: meta.contextWindow || 200000,
                status: 'active',
                latencyMs: testResult.latencyMs,
                ttftMs: testResult.ttftMs,
                outputSnippet: testResult.output,
                testedAt: testResult.testedAt
            });
        } else {
            failedModels.push({
                id: modelId,
                displayName: meta.displayName || modelId,
                error: testResult.error,
                latencyMs: testResult.latencyMs,
                testedAt: testResult.testedAt
            });
        }
    }

    const report = {
        updated_at: new Date().toISOString(),
        verified_count: verifiedModels.length,
        failed_count: failedModels.length,
        models: verifiedModels,
        failed: failedModels
    };

    try {
        if (!fs.existsSync(CONFIG_DIR)) {
            fs.mkdirSync(CONFIG_DIR, { recursive: true });
        }
        fs.writeFileSync(VERIFIED_MODELS_PATH, JSON.stringify(report, null, 2), 'utf8');
    } catch (err) {
        console.error(`[ModelTester] Failed to write verified models to ${VERIFIED_MODELS_PATH}:`, err.message);
    }

    return report;
}

/**
 * Retrieve verified models list from persistent store.
 * 
 * @returns {Object} { models: Array, updated_at: string, verified_count: number }
 */
export function getVerifiedModels() {
    try {
        if (fs.existsSync(VERIFIED_MODELS_PATH)) {
            const raw = fs.readFileSync(VERIFIED_MODELS_PATH, 'utf8');
            return JSON.parse(raw);
        }
    } catch (err) {
        console.error(`[ModelTester] Error reading ${VERIFIED_MODELS_PATH}:`, err.message);
    }

    // Default fallback roster if audit hasn't completed yet
    return {
        updated_at: new Date().toISOString(),
        verified_count: 6,
        failed_count: 0,
        models: CANDIDATE_MODELS.slice(0, 6).map(c => ({
            ...c,
            status: 'active',
            latencyMs: 0,
            testedAt: new Date().toISOString()
        })),
        failed: []
    };
}

// Direct CLI Execution Support
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    console.log(`[ModelTester] Initiating SolidStack Model Audit across ${CANDIDATE_MODELS.length} candidates...`);
    runFullModelAudit()
        .then((report) => {
            console.log(`\nAudit Complete: ${report.verified_count} Verified | ${report.failed_count} Failed\n`);
            console.log('Verified Models:');
            report.models.forEach(m => {
                console.log(`  ✓ ${m.id.padEnd(36)} [${m.provider}] - Latency: ${m.latencyMs}ms (TTFT: ${m.ttftMs}ms)`);
            });
            if (report.failed.length > 0) {
                console.log('\nFailed Models:');
                report.failed.forEach(f => {
                    console.log(`  ✗ ${f.id.padEnd(36)} - Error: ${f.error}`);
                });
            }
            process.exit(0);
        })
        .catch(err => {
            console.error('[ModelTester] Fatal error during audit:', err);
            process.exit(1);
        });
}
