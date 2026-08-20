import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { config } from '../config.js';

/**
 * Shared Utility Functions
 *
 * General-purpose helper functions used across multiple modules.
 */

/**
 * Get the package version from package.json
 * @param {string} [defaultVersion='1.0.0'] - Default version if package.json cannot be read
 * @returns {string} The package version
 */
export function getPackageVersion(defaultVersion = '1.0.0') {
    try {
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = path.dirname(__filename);
        const packageJsonPath = path.join(__dirname, '../../package.json');
        const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
        return packageJson.version || defaultVersion;
    } catch {
        return defaultVersion;
    }
}

/**
 * Format duration in milliseconds to human-readable string
 * @param {number} ms - Duration in milliseconds
 * @returns {string} Human-readable duration (e.g., "1h23m45s")
 */
export function formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    if (hours > 0) {
        return `${hours}h${minutes}m${secs}s`;
    } else if (minutes > 0) {
        return `${minutes}m${secs}s`;
    }
    return `${secs}s`;
}


/**
 * Sleep for specified milliseconds
 * @param {number} ms - Duration to sleep in milliseconds
 * @returns {Promise<void>} Resolves after the specified duration
 */
export function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Check if an error is a network error (transient)
 * @param {Error} error - The error to check
 * @returns {boolean} True if it is a network error
 */
export function isNetworkError(error) {
    const msg = error.message.toLowerCase();
    return (
        msg.includes('fetch failed') ||
        msg.includes('network error') ||
        msg.includes('econnreset') ||
        msg.includes('etimedout') ||
        msg.includes('socket hang up') ||
        msg.includes('timeout') ||
        msg.includes('timed out') ||
        msg.includes('self-signed certificate') ||
        msg.includes('depth_zero_self_signed_cert')
    );
}

import https from 'https';
import http from 'http';
import { Readable } from 'stream';

/**
 * Resilient native HTTPS/HTTP fetch transport that bypasses undici socket stalls on macOS/multi-WAN.
 * @param {string|URL} url - The URL to fetch
 * @param {RequestInit} [options] - Fetch options
 * @returns {Promise<Response>} Fetch response
 */
export async function throttledFetch(url, options = {}) {
    if (config.requestThrottlingEnabled) {
        const delayMs = config.requestDelayMs || 200;
        if (delayMs > 0) {
            await sleep(delayMs);
        }
    }

    return new Promise((resolve, reject) => {
        try {
            const u = new URL(url);
            const protocol = u.protocol === 'http:' ? http : https;
            const req = protocol.request(u, {
                method: options.method || 'GET',
                headers: options.headers || {},
                signal: options.signal,
                timeout: options.timeout || 60000
            }, (res) => {
                let bodyPromise = null;
                const getBuffer = () => {
                    if (bodyPromise) {
                        return bodyPromise;
                    }
                    bodyPromise = (async () => {
                        const reader = webStream.getReader();
                        const chunks = [];
                        try {
                            for (;;) {
                                const { done, value } = await reader.read();
                                if (done) {
                                    break;
                                }
                                chunks.push(Buffer.from(value));
                            }
                        } finally {
                            reader.releaseLock();
                        }
                        return Buffer.concat(chunks);
                    })();
                    return bodyPromise;
                };

                const webStream = Readable.toWeb(res);

                resolve({
                    ok: res.statusCode >= 200 && res.statusCode < 300,
                    status: res.statusCode,
                    statusText: res.statusMessage,
                    headers: {
                        get: (name) => res.headers[name.toLowerCase()] || null,
                        forEach: (cb) => Object.entries(res.headers).forEach(([k, v]) => cb(v, k)),
                        ...res.headers
                    },
                    text: async () => (await getBuffer()).toString('utf8'),
                    json: async () => JSON.parse((await getBuffer()).toString('utf8')),
                    body: webStream
                });
            });

            req.on('error', reject);
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Connection timed out'));
            });

            if (options.body) {
                if (typeof options.body === 'string' || Buffer.isBuffer(options.body)) {
                    req.write(options.body);
                } else if (options.body instanceof URLSearchParams || typeof options.body.toString === 'function' && options.body.constructor?.name === 'URLSearchParams') {
                    req.write(options.body.toString());
                } else {
                    req.write(JSON.stringify(options.body));
                }
            }
            req.end();
        } catch (err) {
            reject(err);
        }
    });
}

/**
 * Generate random jitter for backoff timing (Thundering Herd Prevention)
 * Prevents all clients from retrying at the exact same moment after errors.
 * @param {number} maxJitterMs - Maximum jitter range (result will be ±maxJitterMs/2)
 * @returns {number} Random jitter value between -maxJitterMs/2 and +maxJitterMs/2
 */
export function generateJitter(maxJitterMs) {
    return Math.random() * maxJitterMs - (maxJitterMs / 2);
}
