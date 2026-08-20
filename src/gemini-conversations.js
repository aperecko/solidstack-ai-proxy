import express from 'express';
import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';
import { logger } from './utils/logger.js';

const BRAIN_DIR = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
const CONVERSATIONS_DB = path.join(os.homedir(), '.solidstack', 'conversations', 'conversations.db');

export function scanGeminiTranscripts(query = '', limit = 30) {
    if (!fs.existsSync(BRAIN_DIR)) return [];

    const results = [];
    const qLower = (query || '').toLowerCase().trim();

    try {
        const folders = fs.readdirSync(BRAIN_DIR, { withFileTypes: true });
        for (const f of folders) {
            if (!f.isDirectory()) continue;
            const convId = f.name;
            const transcriptPath = path.join(BRAIN_DIR, convId, '.system_generated', 'logs', 'transcript.jsonl');
            if (!fs.existsSync(transcriptPath)) continue;

            try {
                const stat = fs.statSync(transcriptPath);
                const fileContent = fs.readFileSync(transcriptPath, 'utf8');
                const lines = fileContent.split('\n');

                const userPrompts = [];
                const modelResponses = [];
                let firstPrompt = '';
                let lastTimestamp = stat.mtimeMs;

                for (const line of lines) {
                    if (!line.trim()) continue;
                    try {
                        const item = JSON.parse(line);
                        if (item.type === 'USER_INPUT') {
                            let text = item.content || '';
                            // Strip xml tags if present
                            text = text.replace(/<USER_REQUEST>/g, '').replace(/<\/USER_REQUEST>/g, '').trim();
                            if (text && !text.startsWith('<SYSTEM_MESSAGE') && !text.startsWith('Comments on artifact')) {
                                userPrompts.append ? userPrompts.push(text) : userPrompts.push(text);
                                if (!firstPrompt) firstPrompt = text;
                            }
                        } else if (item.type === 'PLANNER_RESPONSE') {
                            const respText = item.content || '';
                            if (respText) modelResponses.push(respText);
                        }
                    } catch (e) {}
                }

                if (userPrompts.length === 0) continue;

                const fullSearchText = `${firstPrompt} ${userPrompts.join(' ')} ${modelResponses.join(' ')}`.toLowerCase();

                if (qLower && !fullSearchText.includes(qLower)) {
                    continue;
                }

                const title = firstPrompt ? firstPrompt.slice(0, 100).replace(/\n/g, ' ') : `Gemini Session ${convId.slice(0, 8)}`;
                const summary = userPrompts.slice(0, 3).join(' | ').slice(0, 300);

                results.push({
                    id: convId,
                    source: 'gemini_brain',
                    title,
                    summary,
                    user_prompts: userPrompts,
                    model_responses_count: modelResponses.length,
                    updated_at: Math.floor(lastTimestamp),
                    date: new Date(lastTimestamp).toISOString(),
                });
            } catch (err) {
                logger.debug(`[GeminiConv] Error reading ${convId}: ${err.message}`);
            }
        }
    } catch (err) {
        logger.error('[GeminiConv] Error scanning brain directory:', err);
    }

    results.sort((a, b) => b.updated_at - a.updated_at);
    return results.slice(0, limit);
}

export function getGeminiSessionContext(convId) {
    const transcriptPath = path.join(BRAIN_DIR, convId, '.system_generated', 'logs', 'transcript.jsonl');
    if (!fs.existsSync(transcriptPath)) {
        return null;
    }

    const fileContent = fs.readFileSync(transcriptPath, 'utf8');
    const lines = fileContent.split('\n');

    const userPrompts = [];
    const keyActions = [];
    let lastResponse = '';

    for (const line of lines) {
        if (!line.trim()) continue;
        try {
            const item = JSON.parse(line);
            if (item.type === 'USER_INPUT') {
                let text = item.content || '';
                text = text.replace(/<USER_REQUEST>/g, '').replace(/<\/USER_REQUEST>/g, '').trim();
                if (text && !text.startsWith('<SYSTEM_MESSAGE')) {
                    userPrompts.push(text);
                }
            } else if (item.type === 'PLANNER_RESPONSE') {
                lastResponse = (item.content || '').slice(0, 1000);
            }
        } catch (e) {}
    }

    const title = userPrompts.length > 0 ? userPrompts[0].slice(0, 100).replace(/\n/g, ' ') : `Session ${convId}`;

    return {
        id: convId,
        title,
        prompt_history: userPrompts,
        last_response_summary: lastResponse,
        pickup_context: `--- RESUMED GEMINI SESSION [${convId}] ---\nTitle: ${title}\nPrimary User Request: ${userPrompts[0] || 'N/A'}\nLatest Request: ${userPrompts[userPrompts.length - 1] || 'N/A'}\nLast Assistant Summary: ${lastResponse.slice(0, 500)}`,
    };
}

export function createGeminiConversationRouter() {
    const router = express.Router();

    router.get('/conversations', (req, res) => {
        try {
            const q = req.query.q || '';
            const limit = Math.min(parseInt(req.query.limit) || 30, 100);

            const brainSessions = scanGeminiTranscripts(q, limit);

            // Also check conversations.db
            const dbSessions = [];
            if (fs.existsSync(CONVERSATIONS_DB)) {
                try {
                    const db = new Database(CONVERSATIONS_DB, { readonly: true });
                    const where = q ? 'WHERE summary LIKE ? OR model LIKE ?' : '';
                    const params = q ? [`%${q}%`, `%${q}%`, limit] : [limit];
                    const rows = db.prepare(`SELECT id, model, summary, created_at, status FROM conversations ${where} ORDER BY created_at DESC LIMIT ?`).all(...params);
                    for (const r of rows) {
                        dbSessions.push({
                            id: r.id,
                            source: 'proxy_db',
                            title: r.model ? `Proxy: ${r.model}` : 'AI Proxy Call',
                            summary: r.summary || '',
                            updated_at: r.created_at,
                            date: new Date(r.created_at).toISOString(),
                        });
                    }
                    db.close();
                } catch (e) {}
            }

            const combined = [...brainSessions, ...dbSessions];
            combined.sort((a, b) => b.updated_at - a.updated_at);
            const items = combined.slice(0, limit);

            res.json({ items, total: items.length });
        } catch (err) {
            logger.error('[GeminiConv] Router error:', err);
            res.status(500).json({ error: err.message });
        }
    });

    router.get('/conversations/:id', (req, res) => {
        try {
            const ctx = getGeminiSessionContext(req.params.id);
            if (!ctx) return res.status(404).json({ error: 'Conversation not found' });
            res.json(ctx);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.get('/conversations/:id/context', (req, res) => {
        try {
            const ctx = getGeminiSessionContext(req.params.id);
            if (!ctx) return res.status(404).json({ error: 'Conversation not found' });
            res.json({ id: ctx.id, pickup_context: ctx.pickup_context });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    return router;
}
