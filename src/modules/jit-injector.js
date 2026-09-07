import fs from 'fs';
import path from 'path';
import os from 'os';
import { logger } from '../utils/logger.js';

const CONFIG_DIR = path.join(os.homedir(), '.config', 'antigravity-proxy');
const ACTIVE_RULES_PATH = path.join(CONFIG_DIR, 'active-rules.json');

let cachedRules = null;
let lastLoadTime = 0;
const CACHE_TTL = 60000; // 1 minute

function getActiveRules() {
    const now = Date.now();
    if (cachedRules && (now - lastLoadTime < CACHE_TTL)) {
        return cachedRules;
    }

    if (!fs.existsSync(ACTIVE_RULES_PATH)) {
        cachedRules = [];
        return cachedRules;
    }

    try {
        cachedRules = JSON.parse(fs.readFileSync(ACTIVE_RULES_PATH, 'utf8'));
        lastLoadTime = now;
    } catch (e) {
        logger.warn(`[JIT-Injector] Failed to load active rules: ${e.message}`);
        cachedRules = [];
    }
    return cachedRules;
}

/**
 * Parses Anthropic or Google API JSON payloads, semantically matches 
 * the prompt against active rules, and injects matched rules into the system block.
 * 
 * @param {string} bodyText - The raw JSON string of the request body
 * @returns {string} - The modified JSON string
 */
export function injectActiveRules(bodyText) {
    if (!bodyText) return bodyText;
    
    const rules = getActiveRules();
    if (rules.length === 0) return bodyText;

    try {
        const bodyObj = JSON.parse(bodyText);
        
        // Extract the user prompt (supports both Anthropic and Google API structures)
        let promptContent = '';
        if (Array.isArray(bodyObj.messages)) {
            // Anthropic format
            const lastMsg = bodyObj.messages[bodyObj.messages.length - 1];
            if (lastMsg && lastMsg.role === 'user') {
                promptContent = typeof lastMsg.content === 'string' ? lastMsg.content : JSON.stringify(lastMsg.content);
            }
        } else if (Array.isArray(bodyObj.contents)) {
            // Google format
            const lastMsg = bodyObj.contents[bodyObj.contents.length - 1];
            if (lastMsg && lastMsg.role === 'user' && Array.isArray(lastMsg.parts)) {
                promptContent = lastMsg.parts.map(p => p.text || '').join('\n');
            }
        }

        if (!promptContent || promptContent.length < 10) return bodyText;

        const lowerPrompt = promptContent.toLowerCase();
        const matchedRules = [];

        // Fast keyword matching (zero-overhead JIT)
        for (const r of rules) {
            for (const kw of r.keywords) {
                if (lowerPrompt.includes(kw.toLowerCase())) {
                    matchedRules.push(r.rule);
                    break;
                }
            }
        }

        if (matchedRules.length === 0) return bodyText;

        logger.info(`[JIT-Injector] Injected ${matchedRules.length} dynamic rules into prompt context.`);
        const injectedSystemText = `\n\n[DYNAMIC CONTEXT (JIT Rules)]\nYou must strictly adhere to the following user preferences for this task:\n` + matchedRules.map(r => `- ${r}`).join('\n');

        // Inject into Anthropic format
        if (Array.isArray(bodyObj.messages)) {
            if (!bodyObj.system) {
                bodyObj.system = injectedSystemText;
            } else if (typeof bodyObj.system === 'string') {
                bodyObj.system += injectedSystemText;
            } else if (Array.isArray(bodyObj.system)) {
                bodyObj.system.push({ type: 'text', text: injectedSystemText });
            }
            return JSON.stringify(bodyObj);
        }
        
        // Inject into Google format (SystemInstruction)
        if (Array.isArray(bodyObj.contents)) {
            if (!bodyObj.systemInstruction) {
                bodyObj.systemInstruction = { parts: [{ text: injectedSystemText }] };
            } else if (Array.isArray(bodyObj.systemInstruction.parts)) {
                bodyObj.systemInstruction.parts.push({ text: injectedSystemText });
            }
            return JSON.stringify(bodyObj);
        }

    } catch (e) {
        // Fallback to original body if parsing fails
    }

    return bodyText;
}
