import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { logger } from './utils/logger.js';

let cachedContacts = null;
let lastCacheTime = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes cache

function findAddressBookDbs() {
    const baseDir = path.join(os.homedir(), 'Library', 'Application Support', 'AddressBook');
    const results = [];
    function scan(dir) {
        if (!fs.existsSync(dir)) return;
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const e of entries) {
                const full = path.join(dir, e.name);
                if (e.isDirectory()) scan(full);
                else if (e.name.endsWith('.abcddb')) results.push(full);
            }
        } catch (err) {
            // Ignore permission or inaccessible folder errors gracefully
        }
    }
    scan(baseDir);
    return results;
}

export function normalizePhone(phone) {
    if (!phone) return '';
    let cleaned = phone.replace(/[^0-9+]/g, '');
    if (cleaned.length === 10) cleaned = '+1' + cleaned;
    else if (cleaned.length === 11 && cleaned.startsWith('1')) cleaned = '+' + cleaned;
    return cleaned;
}

export function loadAddressBookContacts(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && cachedContacts && (now - lastCacheTime < CACHE_TTL_MS)) {
        return cachedContacts;
    }

    const handleToName = new Map();
    const nameEntries = [];
    const dbs = findAddressBookDbs();

    for (const dbPath of dbs) {
        try {
            const db = new Database(dbPath, { readonly: true, fileMustExist: true });
            const rows = db.prepare(`
                SELECT r.ZFIRSTNAME, r.ZLASTNAME, p.ZFULLNUMBER, e.ZADDRESS
                FROM ZABCDRECORD r
                LEFT JOIN ZABCDPHONENUMBER p ON p.ZOWNER = r.Z_PK
                LEFT JOIN ZABCDEMAILADDRESS e ON e.ZOWNER = r.Z_PK
                WHERE r.ZFIRSTNAME IS NOT NULL OR r.ZLASTNAME IS NOT NULL
            `).all();

            for (const r of rows) {
                const firstName = (r.ZFIRSTNAME || '').trim();
                const lastName = (r.ZLASTNAME || '').trim();
                const fullName = `${firstName} ${lastName}`.trim();
                if (!fullName) continue;

                const handles = [];
                if (r.ZFULLNUMBER) {
                    const norm = normalizePhone(r.ZFULLNUMBER);
                    if (norm) handles.push(norm);
                    handles.push(r.ZFULLNUMBER.replace(/[^0-9]/g, ''));
                }
                if (r.ZADDRESS) {
                    handles.push(r.ZADDRESS.toLowerCase().trim());
                }

                for (const h of handles) {
                    if (h) handleToName.set(h, fullName);
                }
                nameEntries.push({ fullName, firstName, lastName, handles });
            }
            db.close();
        } catch (err) {
            logger.debug(`[AddressBook] Could not read ${dbPath}: ${err.message}`);
        }
    }

    cachedContacts = { handleToName, nameEntries };
    lastCacheTime = now;
    return cachedContacts;
}

export function resolveContactName(handle) {
    if (!handle) return null;
    const { handleToName } = loadAddressBookContacts();
    const raw = handle.trim();
    if (handleToName.has(raw)) return handleToName.get(raw);
    const norm = normalizePhone(raw);
    if (norm && handleToName.has(norm)) return handleToName.get(norm);
    const digitsOnly = raw.replace(/[^0-9]/g, '');
    if (digitsOnly && handleToName.has(digitsOnly)) return handleToName.get(digitsOnly);
    return null;
}

export function parseSmartQuery(query) {
    const rawTokens = (query || '').trim().split(/\s+/).filter(t => t.length > 0);
    if (rawTokens.length === 0) {
        return { handles: [], contactNames: [], terms: [] };
    }

    const { nameEntries } = loadAddressBookContacts();
    const validEntries = nameEntries.filter(e => e.handles && e.handles.length > 0);

    let matchedHandles = new Set();
    let matchedNames = new Set();
    let remainingTokens = [...rawTokens];

    for (let len = rawTokens.length; len >= 1; len--) {
        for (let start = 0; start <= rawTokens.length - len; start++) {
            const subTokens = rawTokens.slice(start, start + len);
            const subStr = subTokens.join(' ').toLowerCase();

            if (subStr.length < 2) continue;

            const matches = validEntries.filter(entry => {
                const full = entry.fullName.toLowerCase();
                const first = entry.firstName.toLowerCase();
                const last = entry.lastName.toLowerCase();
                return full.includes(subStr) || first === subStr || last === subStr;
            });

            if (matches.length > 0) {
                for (const entry of matches) {
                    matchedNames.add(entry.fullName);
                    for (const h of entry.handles) {
                        if (h) matchedHandles.add(h);
                    }
                }
                remainingTokens = remainingTokens.filter(t => !subTokens.includes(t));
                break;
            }
        }
        if (matchedNames.size > 0) break;
    }

    return {
        handles: Array.from(matchedHandles),
        contactNames: Array.from(matchedNames),
        terms: remainingTokens,
    };
}


export function decodeAttributedBody(buf) {
    if (!buf) return '';
    try {
        const str = buf.toString('utf8');
        const matches = str.match(/[\x20-\x7E]{2,}/g) || [];
        const filtered = matches.filter(m => 
            !['streamtyped', 'NSObject', 'NSAttributedString', 'NSDictionary', 'NSString', 'NSMutable', 'NSValue', 'NSNumber', '__kIM', 'NSColor'].some(kw => m.includes(kw))
        );
        return filtered.join(' ').replace(/\s+/g, ' ').trim();
    } catch (e) {
        return '';
    }
}
