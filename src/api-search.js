import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import express from 'express';
import { logger } from './utils/logger.js';
import { resolveContactName, parseSmartQuery, decodeAttributedBody } from './addressbook-resolver.js';
import { scanGeminiTranscripts } from './gemini-conversations.js';

const CONVERSATIONS_DB = path.join(os.homedir(), '.solidstack', 'conversations', 'conversations.db');
const IMESSAGE_DB = path.join(os.homedir(), 'Library', 'Messages', 'chat.db');

function openDb(dbPath, readOnly = true) {
    try {
        const opts = readOnly ? { readonly: true, fileMustExist: true } : {};
        const db = new Database(dbPath, opts);
        db.pragma('journal_mode = WAL');
        return db;
    } catch {
        return null;
    }
}

function appleTimeToUnix(appleTime) {
    if (!appleTime) return 0;
    return Math.floor(appleTime / 1000000000 + 978307200);
}

export function createSearchRouter() {
    const router = express.Router();

    router.get('/search', (req, res) => {
        try {
            const q = (req.query.q || '').trim();
            if (!q || q.length < 2) return res.json({ items: [], total: 0 });

            const limit = Math.min(parseInt(req.query.limit) || 20, 100);
            const sources = req.query.source ? req.query.source.split(',') : ['conversation', 'imessage', 'gemini'];
            const results = [];

            if (sources.includes('conversation') || sources.includes('gemini')) {
                const geminiSessions = scanGeminiTranscripts(q, limit);
                for (const g of geminiSessions) {
                    results.push({
                        id: `gemini_${g.id}`,
                        source: 'gemini_brain',
                        title: g.title,
                        summary: g.summary,
                        date: g.updated_at,
                        metadata: { conv_id: g.id, source: 'gemini_brain' },
                    });
                }
            }


            if (sources.includes('conversation')) {
                const convDb = openDb(CONVERSATIONS_DB);
                if (convDb) {
                    try {
                        const rows = convDb.prepare(`
                            SELECT id, model, summary, input_tokens, output_tokens,
                                   created_at, status, client_id
                            FROM conversations
                            WHERE summary LIKE ?
                            ORDER BY created_at DESC LIMIT ?
                        `).all(`%${q}%`, limit);
                        for (const r of rows) {
                            results.push({
                                id: r.id,
                                source: 'conversation',
                                title: r.model || 'AI Conversation',
                                summary: r.summary || '',
                                tokens: (r.input_tokens || 0) + (r.output_tokens || 0),
                                date: r.created_at,
                                metadata: { model: r.model, status: r.status, client_id: r.client_id },
                            });
                        }
                    } finally {
                        convDb.close();
                    }
                }
            }

            if (sources.includes('imessage')) {
                const msgDb = openDb(IMESSAGE_DB);
                if (msgDb) {
                    try {
                        const smart = parseSmartQuery(q);
                        let rows = [];

                        if (smart.handles.length > 0) {
                            const handlePlaceholders = smart.handles.map(() => '?').join(',');
                            if (smart.terms.length > 0) {
                                const contentQuery = `%${smart.terms.join('%')}%`;
                                rows = msgDb.prepare(`
                                    SELECT m.ROWID as id, m.text, m.attributedBody, m.is_from_me, m.date,
                                           h.id as sender_handle, c.chat_identifier, c.display_name
                                    FROM message m
                                    JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
                                    JOIN chat c ON c.ROWID = cmj.chat_id
                                    LEFT JOIN handle h ON h.ROWID = m.handle_id
                                    WHERE (h.id IN (${handlePlaceholders}) OR c.chat_identifier IN (${handlePlaceholders}))
                                      AND (m.text LIKE ? OR m.attributedBody IS NOT NULL)
                                    ORDER BY m.date DESC LIMIT ?
                                `).all(...smart.handles, ...smart.handles, contentQuery, limit);
                            } else {
                                rows = msgDb.prepare(`
                                    SELECT m.ROWID as id, m.text, m.attributedBody, m.is_from_me, m.date,
                                           h.id as sender_handle, c.chat_identifier, c.display_name
                                    FROM message m
                                    JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
                                    JOIN chat c ON c.ROWID = cmj.chat_id
                                    LEFT JOIN handle h ON h.ROWID = m.handle_id
                                    WHERE (h.id IN (${handlePlaceholders}) OR c.chat_identifier IN (${handlePlaceholders}))
                                    ORDER BY m.date DESC LIMIT ?
                                `).all(...smart.handles, ...smart.handles, limit);
                            }
                        } else {
                            rows = msgDb.prepare(`
                                SELECT m.ROWID as id, m.text, m.attributedBody, m.is_from_me, m.date,
                                       h.id as sender_handle, c.chat_identifier, c.display_name
                                FROM message m
                                JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
                                JOIN chat c ON c.ROWID = cmj.chat_id
                                LEFT JOIN handle h ON h.ROWID = m.handle_id
                                WHERE (m.text LIKE ? OR c.display_name LIKE ? OR c.chat_identifier LIKE ?)
                                ORDER BY m.date DESC LIMIT ?
                            `).all(`%${q}%`, `%${q}%`, `%${q}%`, limit);
                        }

                        for (const r of rows) {
                            let text = r.text;
                            if (!text && r.attributedBody) {
                                text = decodeAttributedBody(r.attributedBody);
                            }
                            const contactName = r.is_from_me ?
                                (resolveContactName(r.chat_identifier) || r.display_name || r.chat_identifier || 'Me') :
                                (resolveContactName(r.sender_handle) || resolveContactName(r.chat_identifier) || r.display_name || r.sender_handle || 'iMessage');

                            results.push({
                                id: `im_${r.id}`,
                                source: 'imessage',
                                title: contactName,
                                summary: text ? text.slice(0, 500) : '',
                                date: appleTimeToUnix(r.date) * 1000,
                                metadata: {
                                    sender: r.sender_handle,
                                    sender_name: contactName,
                                    is_from_me: !!r.is_from_me,
                                    chat_identifier: r.chat_identifier,
                                },
                            });
                        }
                    } finally {
                        msgDb.close();
                    }
                }
            }

            results.sort((a, b) => (b.date || 0) - (a.date || 0));
            const total = results.length;
            const items = results.slice(0, limit);

            res.json({ items, total });
        } catch (err) {
            logger.error('[Search] Error:', err);
            res.status(500).json({ error: err.message });
        }
    });

    return router;
}
