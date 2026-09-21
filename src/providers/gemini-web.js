import { Client, Model } from '@jk.mrx/gemini.js';
import { logger } from '../utils/logger.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Format Anthropic/OpenAI messages into a single prompt string.
 */
function formatMessages(messages, system) {
    let prompt = '';
    
    if (system) {
        const systemText = typeof system === 'string' 
            ? system 
            : Array.isArray(system) 
                ? system.map(s => s.text || '').join('\n') 
                : String(system);
        prompt += `System: ${systemText}\n\n`;
    }

    if (Array.isArray(messages)) {
        for (const msg of messages) {
            const role = msg.role === 'assistant' ? 'Assistant' : 'User';
            prompt += `${role}: `;
            
            if (typeof msg.content === 'string') {
                prompt += `${msg.content}\n\n`;
            } else if (Array.isArray(msg.content)) {
                for (const block of msg.content) {
                    if (block.type === 'text') {
                        prompt += `${block.text}\n`;
                    }
                    // Ignore images for now, would need to save to tmp file and pass to client.ask
                }
                prompt += '\n';
            }
        }
    }
    
    // Add instruction to continue as assistant if the last message was from user
    if (messages.length > 0 && messages[messages.length - 1].role === 'user') {
        prompt += `Assistant: `;
    }
    
    return prompt.trim();
}

/**
 * Parse cookies to extract __Secure-1PSID and __Secure-1PSIDTS
 */
function parseCookies(cookies) {
    let psid, psidts;
    
    if (typeof cookies === 'string') {
        const parts = cookies.split(';');
        for (const part of parts) {
            const trimmed = part.trim();
            const idx = trimmed.indexOf('=');
            if (idx > -1) {
                const k = trimmed.substring(0, idx);
                const v = trimmed.substring(idx + 1);
                if (k === '__Secure-1PSID') psid = v;
                if (k === '__Secure-1PSIDTS') psidts = v;
            }
        }
    } else if (typeof cookies === 'object' && cookies !== null) {
        psid = cookies['__Secure-1PSID'];
        psidts = cookies['__Secure-1PSIDTS'];
    }
    
    return { psid, psidts };
}

/**
 * Generate content using Gemini Web API
 * @param {Array} messages - Anthropic/OpenAI formatted messages
 * @param {Object|String} cookies - Cookies object or string
 * @param {Object} options - Additional options (model, system, etc)
 */
export async function generateContent(messages, cookies, options = {}) {
    const { psid, psidts } = parseCookies(cookies);
    
    if (!psid) {
        throw new Error('Missing __Secure-1PSID cookie for Gemini Web');
    }
    
    const client = new Client(psid, psidts);
    await client.init();
    
    const prompt = formatMessages(messages, options.system);
    
    let gModel = Model.DEFAULT;
    if (options.model) {
        const lower = options.model.toLowerCase();
        if (lower.includes('pro-3') || lower.includes('3.0-pro')) gModel = Model.PRO_3;
        else if (lower.includes('pro-2.5') || lower.includes('2.5-pro')) gModel = Model.PRO_25;
        else if (lower.includes('flash-3') || lower.includes('3.0-flash')) gModel = Model.FLASH_3;
        else if (lower.includes('flash-2.5') || lower.includes('2.5-flash')) gModel = Model.FLASH_25;
    }
    
    logger.info(`[GeminiWeb] Sending request to Gemini Web API using model ${options.model || 'default'}`);
    
    const response = await client.ask(prompt, null, gModel);
    
    let content = [];
    
    if (response.think) {
        content.push({ type: 'thinking', text: response.think });
    }
    
    if (response.text) {
        content.push({ type: 'text', text: response.text });
    }
    
    return {
        id: response.rcid || `msg_gemweb_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        model: options.model || 'gemini-web',
        content: content,
        usage: {
            input_tokens: 0,
            output_tokens: 0
        }
    };
}
