import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import fs from 'fs';
import crypto from 'crypto';
import express from 'express';
import { logger } from './utils/logger.js';

const DB_DIR = path.join(os.homedir(), '.solidstack', 'conversations');
const DB_PATH = path.join(DB_DIR, 'conversations.db');

let db = null;

function getDb() {
    if (db) return db;
    try {
        fs.mkdirSync(DB_DIR, { recursive: true });
    } catch {}
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.exec(`
        CREATE TABLE IF NOT EXISTS conversations (
            id TEXT PRIMARY KEY,
            client_id TEXT,
            model TEXT,
            account_email TEXT,
            account_tier TEXT,
            created_at INTEGER,
            updated_at INTEGER,
            input_tokens INTEGER DEFAULT 0,
            output_tokens INTEGER DEFAULT 0,
            cache_read_tokens INTEGER DEFAULT 0,
            user_message_count INTEGER DEFAULT 0,
            assistant_message_count INTEGER DEFAULT 0,
            summary TEXT,
            status TEXT DEFAULT 'completed'
        );
        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            conversation_id TEXT,
            role TEXT,
            content TEXT,
            tokens INTEGER DEFAULT 0,
            created_at INTEGER,
            FOREIGN KEY (conversation_id) REFERENCES conversations(id)
        );
        CREATE INDEX IF NOT EXISTS idx_conversations_created ON conversations(created_at);
        CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id);
    `);
    return db;
}

function generateId() {
    return crypto.randomUUID();
}

function extractTextContent(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map(b => b.text || b.source?.data || '').join('\n');
    }
    return '';
}

function truncate(str, max = 500) {
    if (!str) return '';
    return str.length > max ? str.slice(0, max) + '...' : str;
}

function summarizeMessages(messages) {
    const userMsgs = messages.filter(m => m.role === 'user');
    const texts = userMsgs.slice(-3).map(m => extractTextContent(m.content).slice(0, 200));
    return texts.join(' | ').slice(0, 1000);
}

function hashClientId(req) {
    const key = req?.headers?.['x-api-key'] || req?.headers?.['authorization'] || '';
    return 'client-' + crypto.createHash('md5').update(key).digest('hex').slice(0, 12);
}

export function logConversation(request, response, accountEmail, accountTier, req) {
    try {
        const _db = getDb();
        const now = Date.now();
        const convId = generateId();
        const clientId = hashClientId(req);
        const model = response.model || request.model;
        const usage = response.usage || {};
        const inputTokens = usage.input_tokens || 0;
        const outputTokens = usage.output_tokens || 0;
        const cacheReadTokens = usage.cache_read_input_tokens || 0;

        const userMessages = (request.messages || []).filter(m => m.role === 'user');
        const assistantContent = typeof response.content?.[0]?.text === 'string'
            ? response.content[0].text : '';

        const summary = summarizeMessages(request.messages);

        _db.prepare(`
            INSERT INTO conversations (id, client_id, model, account_email, account_tier,
                created_at, updated_at, input_tokens, output_tokens, cache_read_tokens,
                user_message_count, assistant_message_count, summary, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(convId, clientId, model, accountEmail || '', accountTier || '',
            now, now, inputTokens, outputTokens, cacheReadTokens,
            userMessages.length, 1, summary, 'completed');

        const insertMsg = _db.prepare(`
            INSERT INTO messages (id, conversation_id, role, content, tokens, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
        `);

        for (const msg of request.messages || []) {
            insertMsg.run(generateId(), convId, msg.role,
                truncate(extractTextContent(msg.content), 5000),
                0, now);
        }

        if (assistantContent) {
            insertMsg.run(generateId(), convId, 'assistant',
                truncate(assistantContent, 5000),
                outputTokens, now);
        }

        logger.debug(`[ConvLog] Logged ${model} (${inputTokens}+${outputTokens}t)`);
    } catch (err) {
        logger.error('[ConvLog] Failed to log conversation:', err.message);
    }
}

const streamingAccumulators = new Map();

export function initStreamingLog(req, model, accountEmail, accountTier) {
    const convId = generateId();
    streamingAccumulators.set(convId, {
        id: convId,
        request: req.body,
        accountEmail,
        accountTier,
        events: [],
        startedAt: Date.now(),
    });
    return convId;
}

export function accumulateStreamEvent(convId, event) {
    const acc = streamingAccumulators.get(convId);
    if (acc) {
        acc.events.push(event);
    }
}

export function finalizeStreamingLog(convId, error) {
    const acc = streamingAccumulators.get(convId);
    if (!acc) return;
    streamingAccumulators.delete(convId);

    try {
        const _db = getDb();
        const now = Date.now();
        const model = acc.request.model;

        let totalInput = 0, totalOutput = 0, totalCache = 0;
        let assistantContent = '';

        for (const event of acc.events) {
            if (event.type === 'message_start') {
                totalInput = event.message?.usage?.input_tokens || 0;
                totalCache = event.message?.usage?.cache_read_input_tokens || 0;
            } else if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
                assistantContent += event.delta.text;
            } else if (event.type === 'message_delta') {
                totalOutput = event.usage?.output_tokens || 0;
            }
        }

        const request = acc.request;
        const userMessages = (request.messages || []).filter(m => m.role === 'user');
        const summary = summarizeMessages(request.messages);
        const status = error ? 'error' : 'completed';

        _db.prepare(`
            INSERT INTO conversations (id, client_id, model, account_email, account_tier,
                created_at, updated_at, input_tokens, output_tokens, cache_read_tokens,
                user_message_count, assistant_message_count, summary, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(acc.id, hashClientId(acc.request._req), model,
            acc.accountEmail || '', acc.accountTier || '',
            acc.startedAt, now, totalInput, totalOutput, totalCache,
            userMessages.length, 1, summary, status);

        const insertMsg = _db.prepare(`
            INSERT INTO messages (id, conversation_id, role, content, tokens, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
        `);

        for (const msg of request.messages || []) {
            insertMsg.run(generateId(), acc.id, msg.role,
                truncate(extractTextContent(msg.content), 5000),
                0, acc.startedAt);
        }

        if (assistantContent) {
            insertMsg.run(generateId(), acc.id, 'assistant',
                truncate(assistantContent, 5000),
                totalOutput, now);
        }

        logger.debug(`[ConvLog] Logged streaming ${model} (${totalInput}+${totalOutput}t)`);
    } catch (err) {
        logger.error('[ConvLog] Failed to log streaming conversation:', err.message);
    }
}

export function createConversationRouter() {
    const router = express.Router();

    router.get('/conversations', (req, res) => {
        try {
            const _db = getDb();
            const limit = Math.min(parseInt(req.query.limit) || 50, 200);
            const offset = parseInt(req.query.offset) || 0;
            const model = req.query.model || '';
            const client = req.query.client || '';
            const search = req.query.q || '';

            let sql = 'SELECT * FROM conversations WHERE 1=1';
            const params = [];

            if (model) {
                sql += ' AND model = ?';
                params.push(model);
            }
            if (client) {
                sql += ' AND client_id = ?';
                params.push(client);
            }
            if (search) {
                sql += ' AND (summary LIKE ? OR id LIKE ?)';
                params.push(`%${search}%`, `%${search}%`);
            }

            sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
            params.push(limit, offset);

            const rows = _db.prepare(sql).all(...params);
            const total = _db.prepare('SELECT COUNT(*) as count FROM conversations').get();

            res.json({ items: rows, total: total.count, limit, offset });
        } catch (err) {
            logger.error('[ConvLog] Error querying conversations:', err);
            res.status(500).json({ error: err.message });
        }
    });

    router.get('/conversations/:id', (req, res) => {
        try {
            const _db = getDb();
            const conv = _db.prepare('SELECT * FROM conversations WHERE id = ?').get(req.params.id);
            if (!conv) return res.status(404).json({ error: 'not_found' });
            const messages = _db.prepare(
                'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid'
            ).all(req.params.id);
            res.json({ conversation: conv, messages });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.get('/conversations/stats/summary', (req, res) => {
        try {
            const _db = getDb();
            const stats = _db.prepare(`
                SELECT
                    COUNT(*) as total_conversations,
                    SUM(input_tokens) as total_input_tokens,
                    SUM(output_tokens) as total_output_tokens,
                    SUM(cache_read_tokens) as total_cache_tokens,
                    COUNT(DISTINCT client_id) as unique_clients
                FROM conversations
            `).get();

            const byModel = _db.prepare(`
                SELECT model, COUNT(*) as count, SUM(input_tokens + output_tokens) as total_tokens
                FROM conversations GROUP BY model ORDER BY total_tokens DESC
            `).all();

            const cutoff = Date.now() - 90 * 86400000;
            const byDay = _db.prepare(`
                SELECT date(created_at / 1000, 'unixepoch') as day,
                       COUNT(*) as count,
                       SUM(input_tokens + output_tokens) as tokens
                FROM conversations
                WHERE created_at > ?
                GROUP BY day ORDER BY day DESC LIMIT 30
            `).all(cutoff);

            const byClient = _db.prepare(`
                SELECT client_id,
                       COUNT(*) as count,
                       SUM(input_tokens + output_tokens) as total_tokens
                FROM conversations GROUP BY client_id ORDER BY total_tokens DESC
            `).all();

            res.json({ stats, byModel, byDay, byClient });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    return router;
}
