import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import express from 'express';
import { logger } from './utils/logger.js';
import { resolveContactName, parseSmartQuery, decodeAttributedBody } from './addressbook-resolver.js';

const IMESSAGE_DB = path.join(os.homedir(), 'Library', 'Messages', 'chat.db');

function openDb() {
    try {
        const db = new Database(IMESSAGE_DB, { readonly: true, fileMustExist: true });
        db.pragma('journal_mode = WAL');
        return db;
    } catch (err) {
        logger.error('[iMessage] Failed to open chat.db:', err.message);
        return null;
    }
}

function appleTimeToUnix(appleTime) {
    if (!appleTime) return null;
    return Math.floor(appleTime / 1000000000 + 978307200);
}

function unixToAppleTime(unix) {
    return (unix - 978307200) * 1000000000;
}

export function createIMessageRouter() {
    const router = express.Router();

    router.get('/imessage/chats', (req, res) => {
        try {
            const db = openDb();
            if (!db) return res.status(500).json({ error: 'Cannot access iMessage database' });
            const search = req.query.q || '';
            const limit = Math.min(parseInt(req.query.limit) || 50, 200);

            let sql = `
                SELECT c.ROWID as id, c.chat_identifier, c.display_name,
                       c.service_name, c.room_name,
                       h.id as participant_handle,
                       (SELECT COUNT(*) FROM message m
                        JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
                        WHERE cmj.chat_id = c.ROWID) as message_count,
                       (SELECT MAX(m.date) FROM message m
                        JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
                        WHERE cmj.chat_id = c.ROWID) as last_message_date
                FROM chat c
                LEFT JOIN chat_handle_join chj ON chj.chat_id = c.ROWID
                LEFT JOIN handle h ON h.ROWID = chj.handle_id
                WHERE 1=1
            `;
            const params = [];
            if (search) {
                const smart = parseSmartQuery(search);
                if (smart.handles.length > 0) {
                    const handlePlaceholders = smart.handles.map(() => '?').join(',');
                    sql += ` AND (c.chat_identifier LIKE ? OR c.display_name LIKE ? OR h.id IN (${handlePlaceholders}))`;
                    params.push(`%${search}%`, `%${search}%`, ...smart.handles);
                } else {
                    sql += ` AND (c.chat_identifier LIKE ? OR c.display_name LIKE ? OR h.id LIKE ?)`;
                    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
                }
            }
            sql += ` GROUP BY c.ROWID ORDER BY last_message_date DESC LIMIT ?`;
            params.push(limit);

            const rows = db.prepare(sql).all(...params);
            const result = rows.map(r => {
                const resolvedName = resolveContactName(r.participant_handle || r.chat_identifier);
                return {
                    ...r,
                    contact_name: resolvedName || r.display_name || r.participant_handle || r.chat_identifier,
                    last_message_date: appleTimeToUnix(r.last_message_date),
                };
            });
            db.close();
            res.json({ items: result, total: result.length });
        } catch (err) {
            logger.error('[iMessage] Error listing chats:', err);
            res.status(500).json({ error: err.message });
        }
    });

    router.get('/imessage/chats/:id/messages', (req, res) => {
        try {
            const db = openDb();
            if (!db) return res.status(500).json({ error: 'Cannot access iMessage database' });

            const chatId = parseInt(req.params.id);
            const limit = Math.min(parseInt(req.query.limit) || 100, 500);

            let sql = `
                SELECT m.ROWID as id, m.text, m.attributedBody, m.is_from_me, m.service,
                       m.date, m.date_read, m.date_delivered,
                       m.is_delivered, m.is_read, m.cache_has_attachments as has_attachments,
                       m.associated_message_type, m.associated_message_guid,
                       h.id as sender_handle, h.country as sender_country
                FROM message m
                JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
                LEFT JOIN handle h ON h.ROWID = m.handle_id
                WHERE cmj.chat_id = ?
            `;
            const params = [chatId, limit];
            sql += ` ORDER BY m.date DESC LIMIT ?`;

            const rows = db.prepare(sql).all(...params);
            const result = rows.map(r => {
                let text = r.text;
                if (!text && r.attributedBody) {
                    text = decodeAttributedBody(r.attributedBody);
                }
                const senderName = r.is_from_me ? 'Me' : (resolveContactName(r.sender_handle) || r.sender_handle || 'Unknown');
                return {
                    id: r.id,
                    text: text || '',
                    is_from_me: !!r.is_from_me,
                    service: r.service,
                    sender_handle: r.sender_handle,
                    sender_name: senderName,
                    date: appleTimeToUnix(r.date),
                    date_read: appleTimeToUnix(r.date_read),
                    date_delivered: appleTimeToUnix(r.date_delivered),
                    is_delivered: !!r.is_delivered,
                    is_read: !!r.is_read,
                    has_attachments: !!r.has_attachments,
                };
            });

            db.close();
            res.json({ items: result, total: result.length });
        } catch (err) {
            logger.error('[iMessage] Error reading messages:', err);
            res.status(500).json({ error: err.message });
        }
    });

    router.get('/imemory/search', (req, res) => {
        try {
            const db = openDb();
            if (!db) return res.status(500).json({ error: 'Cannot access iMessage database' });

            const q = (req.query.q || '').trim();
            if (!q || q.length < 2) return res.json({ items: [], total: 0 });

            const limit = Math.min(parseInt(req.query.limit) || 50, 200);
            const smart = parseSmartQuery(q);

            let rows = [];

            if (smart.handles.length > 0) {
                const handlePlaceholders = smart.handles.map(() => '?').join(',');
                if (smart.terms.length > 0) {
                    const contentQuery = `%${smart.terms.join('%')}%`;
                    rows = db.prepare(`
                        SELECT m.ROWID as id, m.text, m.attributedBody, m.is_from_me, m.date,
                               h.id as sender_handle,
                               c.chat_identifier, c.display_name
                        FROM message m
                        JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
                        JOIN chat c ON c.ROWID = cmj.chat_id
                        LEFT JOIN handle h ON h.ROWID = m.handle_id
                        WHERE (h.id IN (${handlePlaceholders}) OR c.chat_identifier IN (${handlePlaceholders}))
                          AND (m.text LIKE ? OR m.attributedBody IS NOT NULL)
                        ORDER BY m.date DESC LIMIT ?
                    `).all(...smart.handles, ...smart.handles, contentQuery, limit);
                } else {
                    rows = db.prepare(`
                        SELECT m.ROWID as id, m.text, m.attributedBody, m.is_from_me, m.date,
                               h.id as sender_handle,
                               c.chat_identifier, c.display_name
                        FROM message m
                        JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
                        JOIN chat c ON c.ROWID = cmj.chat_id
                        LEFT JOIN handle h ON h.ROWID = m.handle_id
                        WHERE (h.id IN (${handlePlaceholders}) OR c.chat_identifier IN (${handlePlaceholders}))
                        ORDER BY m.date DESC LIMIT ?
                    `).all(...smart.handles, ...smart.handles, limit);
                }
            } else {
                rows = db.prepare(`
                    SELECT m.ROWID as id, m.text, m.attributedBody, m.is_from_me, m.date,
                           h.id as sender_handle,
                           c.chat_identifier, c.display_name
                    FROM message m
                    JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
                    JOIN chat c ON c.ROWID = cmj.chat_id
                    LEFT JOIN handle h ON h.ROWID = m.handle_id
                    WHERE (m.text LIKE ? OR c.display_name LIKE ? OR c.chat_identifier LIKE ?)
                    ORDER BY m.date DESC LIMIT ?
                `).all(`%${q}%`, `%${q}%`, `%${q}%`, limit);
            }

            const result = rows.map(r => {
                let text = r.text;
                if (!text && r.attributedBody) {
                    text = decodeAttributedBody(r.attributedBody);
                }
                const senderName = r.is_from_me ? 'Me' : (resolveContactName(r.sender_handle) || r.sender_handle || 'Unknown');
                const chatContact = resolveContactName(r.chat_identifier) || r.display_name || r.chat_identifier;

                return {
                    id: r.id,
                    text: text ? text.slice(0, 1000) : '',
                    is_from_me: !!r.is_from_me,
                    sender_handle: r.sender_handle,
                    sender_name: senderName,
                    chat_identifier: r.chat_identifier,
                    display_name: chatContact,
                    date: appleTimeToUnix(r.date),
                };
            });

            db.close();
            res.json({ items: result, total: result.length, parsed_query: smart });
        } catch (err) {
            logger.error('[iMessage] Error searching:', err);
            res.status(500).json({ error: err.message });
        }
    });

    router.get('/imemory/recent', (req, res) => {
        try {
            const db = openDb();
            if (!db) return res.status(500).json({ error: 'Cannot access iMessage database' });

            const hours = Math.min(parseInt(req.query.hours) || 24, 168);
            const limit = Math.min(parseInt(req.query.limit) || 50, 200);
            const cutoff = unixToAppleTime(Math.floor(Date.now() / 1000) - hours * 3600);

            const rows = db.prepare(`
                SELECT m.ROWID as id, m.text, m.attributedBody, m.is_from_me, m.date,
                       h.id as sender_handle,
                       c.chat_identifier, c.display_name, c.ROWID as chat_id
                FROM message m
                JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
                JOIN chat c ON c.ROWID = cmj.chat_id
                LEFT JOIN handle h ON h.ROWID = m.handle_id
                WHERE m.date > ?
                ORDER BY m.date DESC LIMIT ?
            `).all(cutoff, limit);

            const result = rows.map(r => {
                let text = r.text;
                if (!text && r.attributedBody) {
                    text = decodeAttributedBody(r.attributedBody);
                }
                const senderName = r.is_from_me ? 'Me' : (resolveContactName(r.sender_handle) || r.sender_handle || 'Unknown');
                const chatContact = resolveContactName(r.chat_identifier) || r.display_name || r.chat_identifier;

                return {
                    id: r.id,
                    chat_id: r.chat_id,
                    text: text ? text.slice(0, 1000) : '',
                    is_from_me: !!r.is_from_me,
                    sender_handle: r.sender_handle,
                    sender_name: senderName,
                    chat_identifier: r.chat_identifier,
                    display_name: chatContact,
                    date: appleTimeToUnix(r.date),
                };
            });

            db.close();
            res.json({ items: result, total: result.length });
        } catch (err) {
            logger.error('[iMessage] Error reading recent:', err);
            res.status(500).json({ error: err.message });
        }
    });

    return router;
}
