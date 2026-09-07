/**
 * Keyring Pool Manager
 * 
 * Manages free/open-tier API keys (NVIDIA NIM, OpenRouter Free, Groq, GitHub Models)
 * with rate-limit tracking, cooldown circuit breaking, round-robin rotation,
 * and persistent storage.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { logger } from '../utils/logger.js';
import { calculateTokenValue } from '../modules/pricing-catalog.js';

const CONFIG_DIR = path.join(os.homedir(), '.config', 'antigravity-proxy');
const KEYRING_FILE = path.join(CONFIG_DIR, 'keyring.json');

const DEFAULT_KEYRING = {
    providers: {
        nvidia: {
            enabled: true,
            endpoint: 'https://integrate.api.nvidia.com/v1',
            defaultModel: 'meta/llama-3.3-70b-instruct',
            rpmLimit: 40,
            keys: [],
            supportedModels: [
                'meta/llama-3.3-70b-instruct',
                'deepseek-ai/deepseek-r1',
                'deepseek-ai/deepseek-v3',
                'nvidia/llama-3.1-nemotron-70b-instruct',
                'qwen/qwen2.5-coder-32b-instruct',
                'mistralai/mistral-large-2-instruct'
            ]
        },
        openrouter: {
            enabled: true,
            endpoint: 'https://openrouter.ai/api/v1',
            defaultModel: 'meta-llama/llama-3.3-70b-instruct:free',
            rpmLimit: 20,
            keys: [],
            supportedModels: [
                'meta-llama/llama-3.3-70b-instruct:free',
                'deepseek/deepseek-r1:free',
                'deepseek/deepseek-chat:free',
                'qwen/qwen-2.5-coder-32b-instruct:free'
            ]
        },
        groq: {
            enabled: true,
            endpoint: 'https://api.groq.com/openai/v1',
            defaultModel: 'llama-3.3-70b-versatile',
            rpmLimit: 30,
            keys: [],
            supportedModels: [
                'llama-3.3-70b-versatile',
                'mixtral-8x7b-32768'
            ]
        }
    },
    stats: {
        totalRequests: 0,
        successfulRequests: 0,
        failedRequests: 0,
        tokensSaved: 0
    }
};

class KeyringManager {
    constructor() {
        this.data = { ...DEFAULT_KEYRING };
        this.keyIndexMap = new Map();
        this.init();
    }

    init() {
        try {
            if (!fs.existsSync(CONFIG_DIR)) {
                fs.mkdirSync(CONFIG_DIR, { recursive: true });
            }

            if (fs.existsSync(KEYRING_FILE)) {
                const fileData = JSON.parse(fs.readFileSync(KEYRING_FILE, 'utf-8'));
                this.data = {
                    ...DEFAULT_KEYRING,
                    ...fileData,
                    providers: {
                        ...DEFAULT_KEYRING.providers,
                        ...(fileData.providers || {})
                    },
                    stats: {
                        ...DEFAULT_KEYRING.stats,
                        ...(fileData.stats || {})
                    }
                };
            } else {
                this.save();
            }

            this.syncFromEnv();
            this.checkCycleRollover();
        } catch (e) {
            logger.warn(`[Keyring] Failed to load keyring from ${KEYRING_FILE}: ${e.message}`);
        }
    }

    syncFromEnv() {
        let changed = false;

        const envMap = [
            { provider: 'nvidia', envVar: 'NVIDIA_API_KEY', label: 'Env (NVIDIA_API_KEY)' },
            { provider: 'nvidia', envVar: 'NVIDIA_NIM_KEY', label: 'Env (NVIDIA_NIM_KEY)' },
            { provider: 'openrouter', envVar: 'OPENROUTER_API_KEY', label: 'Env (OPENROUTER_API_KEY)' },
            { provider: 'groq', envVar: 'GROQ_API_KEY', label: 'Env (GROQ_API_KEY)' }
        ];

        for (const item of envMap) {
            const val = process.env[item.envVar];
            if (val && typeof val === 'string' && val.trim().length > 5) {
                const keyVal = val.trim();
                const provider = this.data.providers[item.provider];
                if (provider && !provider.keys.some(k => k.key === keyVal)) {
                    provider.keys.push({
                        id: crypto.randomBytes(4).toString('hex'),
                        key: keyVal,
                        label: item.label,
                        addedAt: Date.now(),
                        cooldownUntil: 0,
                        requestsCount: 0,
                        lastUsed: 0,
                        cycleInfo: { unit: "credits", allotment: 0, cycleType: "monthly", cycleStart: Date.now(), cycleUsed: 0, wastedHistory: [] }
                    });
                    changed = true;
                    logger.info(`[Keyring] Auto-registered ${item.provider} key from ${item.envVar}`);
                }
            }
        }

        if (changed) {
            this.save();
        }
    }

    save() {
        try {
            fs.writeFileSync(KEYRING_FILE, JSON.stringify(this.data, null, 2));
        } catch (e) {
            logger.error(`[Keyring] Error saving keyring to ${KEYRING_FILE}: ${e.message}`);
        }
    }

    /**
     * Get the next usable API key for a provider with rotation and cooldown filtering.
     * @param {string} providerName ('nvidia' | 'openrouter' | 'groq')
     * @returns {{ key: string, id: string, endpoint: string, defaultModel: string, supportedModels: string[] } | null}
     */
    getNextKey(providerName) {
        const provider = this.data.providers[providerName];
        if (!provider || !provider.enabled || !provider.keys || provider.keys.length === 0) {
            return null;
        }

        const now = Date.now();
        const availableKeys = provider.keys.filter(k => (k.cooldownUntil || 0) <= now);

        if (availableKeys.length === 0) {
            return null;
        }

        let idx = this.keyIndexMap.get(providerName) || 0;
        idx = idx % availableKeys.length;
        const selected = availableKeys[idx];
        this.keyIndexMap.set(providerName, idx + 1);

        selected.lastUsed = now;
        selected.requestsCount = (selected.requestsCount || 0) + 1;
        this.data.stats.totalRequests = (this.data.stats.totalRequests || 0) + 1;

        return {
            id: selected.id,
            key: selected.key,
            endpoint: provider.endpoint,
            defaultModel: provider.defaultModel,
            supportedModels: provider.supportedModels
        };
    }

    /**
     * Check if a provider has active, non-cooldown keys.
     * @param {string} providerName 
     * @returns {boolean}
     */
    isProviderAvailable(providerName) {
        const provider = this.data.providers[providerName];
        if (!provider || !provider.enabled || !provider.keys || provider.keys.length === 0) {
            return false;
        }
        const now = Date.now();
        return provider.keys.some(k => (k.cooldownUntil || 0) <= now);
    }

    /**
     * Aggregate monthly-cycle usage for a provider across all its keys.
     * Used by callers that need to enforce a credit/request budget (e.g. the
     * AG->NIM overflow guard) without reaching into raw keyring internals.
     *
     * @param {string} providerName ('nvidia' | 'openrouter' | 'groq')
     * @returns {{available:boolean, unit:string, allotment:number, cycleUsed:number} | null}
     */
    getCycleUsage(providerName) {
        const provider = this.data.providers[providerName];
        if (!provider || !provider.enabled || !provider.keys || provider.keys.length === 0) {
            return null;
        }
        let allotment = 0;
        let cycleUsed = 0;
        let unit = 'requests';
        let hasCycleInfo = false;
        for (const k of provider.keys) {
            const ci = k.cycleInfo;
            if (ci) {
                hasCycleInfo = true;
                unit = ci.unit || unit;
                allotment += Number(ci.allotment || 0);
                cycleUsed += Number(ci.cycleUsed || 0);
            }
        }
        return {
            available: provider.keys.some(k => (k.cooldownUntil || 0) <= Date.now()),
            unit,
            allotment,
            cycleUsed,
            hasCycleInfo,
        };
    }

    /**
     * Record a successful request.
     */
    recordSuccess(providerName, keyId, inputTokens = 0, outputTokens = 0, equivalentModelId = null) {
        const provider = this.data.providers[providerName];
        if (!provider) return;

        const key = provider.keys.find(k => k.id === keyId);
        if (key) {
            key.cooldownUntil = 0;
        }

        const totalTokens = (inputTokens || 0) + (outputTokens || 0);
        this.data.stats.successfulRequests = (this.data.stats.successfulRequests || 0) + 1;
        this.data.stats.tokensSaved = (this.data.stats.tokensSaved || 0) + totalTokens;
        
        let valueSaved = 0;
        // Calculate dollar value saved
        if (!this.data.stats.dollarsSaved) this.data.stats.dollarsSaved = 0;
        try {
            valueSaved = calculateTokenValue(equivalentModelId || '_default_pro', inputTokens, outputTokens);
            this.data.stats.dollarsSaved = Number((this.data.stats.dollarsSaved + valueSaved).toFixed(6));
        } catch (err) {
            // Ignore pricing errors
        }

        if (key.cycleInfo) {
            if (key.cycleInfo.unit === 'requests') {
                key.cycleInfo.cycleUsed = (key.cycleInfo.cycleUsed || 0) + 1;
            } else if (key.cycleInfo.unit === 'tokens') {
                key.cycleInfo.cycleUsed = (key.cycleInfo.cycleUsed || 0) + totalTokens;
            } else if (key.cycleInfo.unit === 'credits') {
                key.cycleInfo.cycleUsed = (key.cycleInfo.cycleUsed || 0) + valueSaved;
            }
        }

        this.save();
    }

    /**
     * Record a failure and apply appropriate cooldown.
     * @param {string} providerName 
     * @param {string} keyId 
     * @param {number} statusCode 
     */
    recordFailure(providerName, keyId, statusCode) {
        const provider = this.data.providers[providerName];
        if (!provider) return;

        const key = provider.keys.find(k => k.id === keyId);
        if (!key) return;

        this.data.stats.failedRequests = (this.data.stats.failedRequests || 0) + 1;

        let cooldownSeconds = 60;
        if (statusCode === 429) {
            cooldownSeconds = 60;
            logger.warn(`[Keyring] Provider ${providerName} key ${key.label || key.id} hit 429 Rate Limit. Cooling down for 60s.`);
        } else if (statusCode === 401 || statusCode === 403) {
            cooldownSeconds = 3600;
            logger.error(`[Keyring] Provider ${providerName} key ${key.label || key.id} returned ${statusCode} (Unauthorized/Quota Expired). Cooling down for 1h.`);
        } else {
            cooldownSeconds = 15;
        }

        key.cooldownUntil = Date.now() + (cooldownSeconds * 1000);
        this.save();
    }

    /**
     * Add a key to a provider.
     */
    addKey(providerName, rawKey, label = 'Manual Key') {
        const provider = this.data.providers[providerName];
        if (!provider) {
            throw new Error(`Unknown provider: ${providerName}`);
        }

        const trimmed = rawKey.trim();
        if (provider.keys.some(k => k.key === trimmed)) {
            return { status: 'exists', message: 'Key already registered in keyring.' };
        }

        const newKeyObj = {
            id: crypto.randomBytes(4).toString('hex'),
            key: trimmed,
            label,
            addedAt: Date.now(),
            cooldownUntil: 0,
            requestsCount: 0,
            lastUsed: 0,
            cycleInfo: { unit: "credits", allotment: 0, cycleType: "monthly", cycleStart: Date.now(), cycleUsed: 0, wastedHistory: [] }
        };

        provider.keys.push(newKeyObj);
        this.save();
        logger.info(`[Keyring] Added new key to ${providerName} (${label})`);
        return { status: 'ok', keyId: newKeyObj.id };
    }

    /**
     * Remove a key.
     */

    /**
     * Update the cycle info/allotment for a specific key
     */
    setKeyCycleInfo(providerName, keyId, cycleData) {
        const provider = this.data.providers[providerName];
        if (!provider) return false;
        
        const key = provider.keys.find(k => k.id === keyId);
        if (!key) return false;
        
        key.cycleInfo = {
            ...(key.cycleInfo || {}),
            ...cycleData
        };
        
        // Reset cycle used if unit changes or requested
        if (cycleData.resetCycle) {
            key.cycleInfo.cycleUsed = 0;
            key.cycleInfo.cycleStart = Date.now();
        }
        
        this.save();
        return true;
    }

    removeKey(providerName, keyId) {
        const provider = this.data.providers[providerName];
        if (!provider) return false;

        const initialLen = provider.keys.length;
        provider.keys = provider.keys.filter(k => k.id !== keyId);
        if (provider.keys.length !== initialLen) {
            this.save();
            logger.info(`[Keyring] Removed key ${keyId} from ${providerName}`);
            return true;
        }
        return false;
    }

    /**
     * Toggle provider enabled/disabled.
     */
    setProviderEnabled(providerName, enabled) {
        const provider = this.data.providers[providerName];
        if (!provider) return false;
        provider.enabled = !!enabled;
        this.save();
        return true;
    }

    /**
     * Return safe public status telemetry.
     */

    /**
     * Checks all keys to see if their tracking cycle has rolled over.
     */
    checkCycleRollover() {
        let changed = false;
        const now = Date.now();
        for (const provider of Object.values(this.data.providers)) {
            for (const key of provider.keys || []) {
                if (!key.cycleInfo) {
                    key.cycleInfo = {
                        unit: 'credits',
                        allotment: 0,
                        cycleType: 'monthly',
                        cycleStart: now,
                        cycleUsed: 0,
                        wastedHistory: []
                    };
                    changed = true;
                }
                
                const info = key.cycleInfo;
                if (info.cycleType === 'none' || !info.cycleStart) continue;

                let shouldRollover = false;
                const startDate = new Date(info.cycleStart);
                
                if (info.cycleType === 'monthly') {
                    const nextMonth = new Date(startDate);
                    nextMonth.setMonth(nextMonth.getMonth() + 1);
                    if (now >= nextMonth.getTime()) {
                        shouldRollover = true;
                        info.cycleStart = nextMonth.getTime();
                    }
                } else if (info.cycleType === 'weekly') {
                    if (now >= startDate.getTime() + 7 * 24 * 60 * 60 * 1000) {
                        shouldRollover = true;
                        info.cycleStart = startDate.getTime() + 7 * 24 * 60 * 60 * 1000;
                    }
                } else if (info.cycleType === 'daily') {
                    if (now >= startDate.getTime() + 24 * 60 * 60 * 1000) {
                        shouldRollover = true;
                        info.cycleStart = startDate.getTime() + 24 * 60 * 60 * 1000;
                    }
                }

                if (shouldRollover) {
                    if (info.allotment > 0) {
                        const wasted = Math.max(0, info.allotment - (info.cycleUsed || 0));
                        info.wastedHistory = info.wastedHistory || [];
                        info.wastedHistory.push({
                            date: new Date(now).toISOString(),
                            wasted,
                            used: info.cycleUsed || 0,
                            allotment: info.allotment
                        });
                        if (info.wastedHistory.length > 12) {
                            info.wastedHistory.shift();
                        }
                    }
                    info.cycleUsed = 0;
                    changed = true;
                }
            }
        }
        if (changed) this.save();
    }

    /**
     * Get cycle analytics for the dashboard
     */
    getKeyringAnalytics() {
        this.checkCycleRollover();
        const analytics = {};
        const now = Date.now();
        
        for (const [providerName, provider] of Object.entries(this.data.providers)) {
            analytics[providerName] = {
                enabled: provider.enabled,
                keys: []
            };
            
            for (const key of provider.keys || []) {
                const info = key.cycleInfo || { allotment: 0, cycleType: 'none', cycleUsed: 0, wastedHistory: [] };
                
                let expectedUsage = 0;
                let recommendation = 'Unconfigured';
                let progress = 0;
                
                if (info.allotment > 0 && info.cycleType !== 'none' && info.cycleStart) {
                    const elapsed = Math.max(0, now - info.cycleStart);
                    let totalMs = 30 * 24 * 60 * 60 * 1000;
                    
                    if (info.cycleType === 'monthly') {
                        const start = new Date(info.cycleStart);
                        const end = new Date(start);
                        end.setMonth(end.getMonth() + 1);
                        totalMs = end.getTime() - start.getTime();
                    } else if (info.cycleType === 'weekly') {
                        totalMs = 7 * 24 * 60 * 60 * 1000;
                    } else if (info.cycleType === 'daily') {
                        totalMs = 24 * 60 * 60 * 1000;
                    }
                    
                    const timeProgress = Math.min(1, elapsed / totalMs);
                    expectedUsage = info.allotment * timeProgress;
                    progress = Math.min(1, (info.cycleUsed || 0) / info.allotment);
                    
                    if (info.cycleUsed < expectedUsage * 0.8) {
                        recommendation = 'Use More';
                    } else if (info.cycleUsed > expectedUsage * 1.2) {
                        recommendation = 'Use Less';
                    } else {
                        recommendation = 'On Track';
                    }
                    
                    if (info.cycleUsed >= info.allotment) {
                        recommendation = 'Exhausted';
                    }
                }
                
                const totalWasted = (info.wastedHistory || []).reduce((sum, record) => sum + (record.wasted || 0), 0);
                
                analytics[providerName].keys.push({
                    id: key.id,
                    label: key.label,
                    unit: info.unit || 'credits',
                    allotment: info.allotment || 0,
                    cycleType: info.cycleType || 'none',
                    cycleUsed: info.cycleUsed || 0,
                    expectedUsage,
                    progress,
                    recommendation,
                    totalWasted,
                    wastedHistory: info.wastedHistory || []
                });
            }
        }
        
        return analytics;
    }

    getStatus() {
        const now = Date.now();
        const providersStatus = {};

        for (const [name, p] of Object.entries(this.data.providers)) {
            const totalKeys = (p.keys || []).length;
            const availableKeys = (p.keys || []).filter(k => (k.cooldownUntil || 0) <= now).length;
            const inCooldown = totalKeys - availableKeys;

            providersStatus[name] = {
                enabled: p.enabled,
                endpoint: p.endpoint,
                defaultModel: p.defaultModel,
                supportedModels: p.supportedModels,
                totalKeys,
                availableKeys,
                inCooldown,
                keys: (p.keys || []).map(k => ({
                    id: k.id,
                    label: k.label,
                    requestsCount: k.requestsCount || 0,
                    inCooldown: (k.cooldownUntil || 0) > now,
                    cooldownSecondsRemaining: Math.max(0, Math.round(((k.cooldownUntil || 0) - now) / 1000)),
                    lastUsed: k.lastUsed ? new Date(k.lastUsed).toISOString() : null
                }))
            };
        }

        return {
            providers: providersStatus,
            stats: this.data.stats
        };
    }
}

export const keyringManager = new KeyringManager();
export default keyringManager;
