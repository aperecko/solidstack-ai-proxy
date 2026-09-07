import express from 'express';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const router = express.Router();

const RECORDINGS_DIR = path.join(
    os.homedir(),
    'Library/Group Containers/group.com.apple.VoiceMemos.shared/Recordings'
);
const DB_PATH = path.join(RECORDINGS_DIR, 'CloudRecordings.db');
const CACHE_DIR = path.join(os.tmpdir(), 'solidstack_voicememos_cache');

// Ensure cache directory exists
if (!fs.existsSync(CACHE_DIR)) {
    try {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
    } catch (e) {
        console.error('[VoiceMemos] Failed to create cache directory:', e.message);
    }
}

// CoreData epoch: 2001-01-01 00:00:00 UTC
const COCOA_EPOCH_MS = Date.UTC(2001, 0, 1, 0, 0, 0);

function formatDuration(seconds) {
    if (!seconds || isNaN(seconds)) return '0s';
    const totalSecs = Math.round(seconds);
    const hrs = Math.floor(totalSecs / 3600);
    const mins = Math.floor((totalSecs % 3600) / 60);
    const secs = totalSecs % 60;
    if (hrs > 0) {
        return `${hrs}h ${mins}m ${secs}s`;
    }
    if (mins > 0) {
        return `${mins}m ${secs}s`;
    }
    return `${secs}s`;
}

function formatBytes(bytes) {
    if (!bytes || isNaN(bytes)) return '0 B';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

async function queryVoiceMemosDb(sqlQuery) {
    try {
        const { stdout } = await execFileAsync('sqlite3', ['-readonly', '-cmd', '.timeout 3000', '-json', DB_PATH, sqlQuery]);
        const trimmed = stdout.trim();
        if (!trimmed) return [];
        try {
            return JSON.parse(trimmed);
        } catch (e) {
            console.error('[VoiceMemos] JSON parse error from sqlite3 output:', e.message);
            return [];
        }
    } catch (e) {
        console.warn('[VoiceMemos] Safe fallback on query error:', e.message);
        return [];
    }
}

/**
 * GET /api/voicememos
 * List all recordings with metadata, search, and pagination
 */
router.get('/', async (req, res) => {
    try {
        if (!fs.existsSync(DB_PATH)) {
            return res.status(404).json({
                error: 'Voice Memos database not found',
                path: DB_PATH,
                memos: [],
                total: 0
            });
        }

        const q = (req.query.q || '').trim().replace(/['"\\]/g, '');
        const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
        const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

        let whereClause = `WHERE ZPATH IS NOT NULL`;
        if (q) {
            whereClause += ` AND (ZCUSTOMLABELFORSORTING LIKE '%${q}%' OR ZENCRYPTEDTITLE LIKE '%${q}%' OR ZPATH LIKE '%${q}%')`;
        }

        const countQuery = `SELECT COUNT(*) as count FROM ZCLOUDRECORDING ${whereClause};`;
        const selectQuery = `
            SELECT Z_PK as id,
                   ZCUSTOMLABELFORSORTING as title,
                   ZENCRYPTEDTITLE as rawTitle,
                   ZPATH as filename,
                   ZDURATION as duration,
                   ZDATE as cocoaDate
            FROM ZCLOUDRECORDING
            ${whereClause}
            ORDER BY ZDATE DESC
            LIMIT ${limit} OFFSET ${offset};
        `;

        const [countResult, rows] = await Promise.all([
            queryVoiceMemosDb(countQuery),
            queryVoiceMemosDb(selectQuery)
        ]);

        const total = (countResult && countResult[0] && countResult[0].count) || 0;

        const memos = rows.map(row => {
            const rawDate = row.cocoaDate ? new Date(COCOA_EPOCH_MS + (row.cocoaDate * 1000)).toISOString() : null;
            const fullPath = path.join(RECORDINGS_DIR, row.filename);
            const exists = fs.existsSync(fullPath);
            let size = 0;
            if (exists) {
                try {
                    size = fs.statSync(fullPath).size;
                } catch {
                    size = 0;
                }
            }

            const title = row.title || row.rawTitle || path.parse(row.filename).name;
            const ext = path.extname(row.filename).toLowerCase();

            return {
                id: row.id,
                title,
                filename: row.filename,
                ext,
                durationSeconds: row.duration || 0,
                durationFormatted: formatDuration(row.duration),
                date: rawDate,
                fileSize: size,
                fileSizeFormatted: formatBytes(size),
                exists,
                audioUrl: `/api/voicememos/audio/${encodeURIComponent(row.filename)}`,
                downloadUrl: `/api/voicememos/download/${encodeURIComponent(row.filename)}`
            };
        });

        res.json({
            total,
            limit,
            offset,
            memos
        });
    } catch (err) {
        console.error('[VoiceMemos] Error querying database:', err);
        res.status(500).json({ error: 'Failed to read voice memos', details: err.message });
    }
});

/**
 * GET /api/voicememos/audio/:filename
 * Stream audio with byte range support. Converts .qta to standard .m4a on the fly if needed.
 */
router.get('/audio/:filename', async (req, res) => {
    try {
        const rawFilename = req.params.filename;
        const sanitizedFilename = path.basename(rawFilename);
        const sourcePath = path.join(RECORDINGS_DIR, sanitizedFilename);

        if (!fs.existsSync(sourcePath)) {
            return res.status(404).send('Audio file not found');
        }

        let targetPath = sourcePath;
        const ext = path.extname(sanitizedFilename).toLowerCase();

        // If .qta, convert to .m4a in cache
        if (ext === '.qta') {
            const cacheFilename = sanitizedFilename.replace(/\.qta$/i, '.m4a');
            const cachedPath = path.join(CACHE_DIR, cacheFilename);

            if (!fs.existsSync(cachedPath)) {
                try {
                    await execFileAsync('afconvert', ['-f', 'm4af', '-d', 'aac', sourcePath, cachedPath]);
                } catch (convErr) {
                    console.error('[VoiceMemos] afconvert error, falling back to raw:', convErr.message);
                }
            }

            if (fs.existsSync(cachedPath)) {
                targetPath = cachedPath;
            }
        }

        const stat = fs.statSync(targetPath);
        const fileSize = stat.size;
        const range = req.headers.range;

        if (range) {
            const parts = range.replace(/bytes=/, '').split('-');
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
            const chunksize = (end - start) + 1;
            const file = fs.createReadStream(targetPath, { start, end });
            const head = {
                'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': chunksize,
                'Content-Type': 'audio/mp4',
                'Access-Control-Allow-Origin': '*'
            };
            res.writeHead(206, head);
            file.pipe(res);
        } else {
            const head = {
                'Content-Length': fileSize,
                'Content-Type': 'audio/mp4',
                'Accept-Ranges': 'bytes',
                'Access-Control-Allow-Origin': '*'
            };
            res.writeHead(200, head);
            fs.createReadStream(targetPath).pipe(res);
        }
    } catch (err) {
        console.error('[VoiceMemos] Audio stream error:', err);
        res.status(500).send('Failed to stream audio: ' + err.message);
    }
});

/**
 * GET /api/voicememos/download/:filename
 * Download audio file with proper attachment header
 */
router.get('/download/:filename', async (req, res) => {
    try {
        const rawFilename = req.params.filename;
        const sanitizedFilename = path.basename(rawFilename);
        const sourcePath = path.join(RECORDINGS_DIR, sanitizedFilename);

        if (!fs.existsSync(sourcePath)) {
            return res.status(404).send('Audio file not found');
        }

        let targetPath = sourcePath;
        let outName = sanitizedFilename;
        const ext = path.extname(sanitizedFilename).toLowerCase();

        if (ext === '.qta') {
            const cacheFilename = sanitizedFilename.replace(/\.qta$/i, '.m4a');
            const cachedPath = path.join(CACHE_DIR, cacheFilename);
            if (!fs.existsSync(cachedPath)) {
                try {
                    await execFileAsync('afconvert', ['-f', 'm4af', '-d', 'aac', sourcePath, cachedPath]);
                } catch (convErr) {
                    console.error('[VoiceMemos] afconvert error:', convErr.message);
                }
            }
            if (fs.existsSync(cachedPath)) {
                targetPath = cachedPath;
                outName = cacheFilename;
            }
        }

        res.download(targetPath, outName);
    } catch (err) {
        console.error('[VoiceMemos] Download error:', err);
        res.status(500).send('Failed to download: ' + err.message);
    }
});

/**
 * POST /api/voicememos/pasteboard/:filename
 * Copy recording file directly to macOS Pasteboard for Cmd+V paste
 */
router.post('/pasteboard/:filename', async (req, res) => {
    try {
        const rawFilename = req.params.filename;
        const sanitizedFilename = path.basename(rawFilename);
        const sourcePath = path.join(RECORDINGS_DIR, sanitizedFilename);

        if (!fs.existsSync(sourcePath)) {
            return res.status(404).json({ error: 'Audio file not found' });
        }

        let targetPath = sourcePath;
        const mp3Filename = sanitizedFilename.replace(/\.(qta|m4a)$/i, '.mp3');
        const mp3Path = path.join(CACHE_DIR, mp3Filename);

        if (!fs.existsSync(mp3Path)) {
            try {
                await execFileAsync('/opt/homebrew/bin/ffmpeg', ['-y', '-i', sourcePath, '-q:a', '2', mp3Path]);
            } catch (convErr) {
                console.error('[VoiceMemos] ffmpeg error:', convErr.message);
            }
        }

        if (fs.existsSync(mp3Path)) {
            targetPath = mp3Path;
        }

        // Use python AppKit to place file on NSPasteboard
        const pyScript = `
import AppKit, sys
from Foundation import NSURL
url = NSURL.fileURLWithPath_(sys.argv[1])
pb = AppKit.NSPasteboard.generalPasteboard()
pb.clearContents()
pb.writeObjects_([url])
`;
        await execFileAsync('python3', ['-c', pyScript, targetPath]);
        res.json({ success: true, path: targetPath });
    } catch (err) {
        console.error('[VoiceMemos] Pasteboard error:', err);
        res.status(500).json({ error: 'Failed to copy to pasteboard: ' + err.message });
    }
});

/**
 * POST /api/voicememos/auto-upload/:filename
 * Automates native file dialog selection in Google Chrome
 */
router.post('/auto-upload/:filename', async (req, res) => {
    try {
        const rawFilename = req.params.filename;
        const sanitizedFilename = path.basename(rawFilename);
        const sourcePath = path.join(RECORDINGS_DIR, sanitizedFilename);

        if (!fs.existsSync(sourcePath)) {
            return res.status(404).json({ error: 'Audio file not found' });
        }

        let targetPath = sourcePath;
        // Check if a custom title was provided in the query
        const customTitle = req.query.title ? req.query.title.replace(/[^a-zA-Z0-9 _-]/g, '').trim() : '';
        const baseName = customTitle ? customTitle : sanitizedFilename.replace(/\.(qta|m4a)$/i, '');
        const mp3Filename = `${baseName}.mp3`;
        const mp3Path = path.join(CACHE_DIR, mp3Filename);

        if (!fs.existsSync(mp3Path)) {
            try {
                await execFileAsync('/opt/homebrew/bin/ffmpeg', ['-y', '-i', sourcePath, '-q:a', '2', mp3Path]);
            } catch (convErr) {
                console.error('[VoiceMemos] ffmpeg error:', convErr.message);
            }
        }

        if (fs.existsSync(mp3Path)) {
            targetPath = mp3Path;
        }

        // AppleScript to fulfill the open file dialog in Google Chrome
        const appleScript = `
tell application "System Events"
    if exists (process "Google Chrome") then
        tell process "Google Chrome"
            set frontmost to true
            delay 0.4
            
            -- Trigger "Go to folder" sheet
            keystroke "g" using {command down, shift down}
            delay 0.6
            
            keystroke "${targetPath}"
            delay 0.5
            
            -- Enter to confirm path
            key code 36
            delay 0.8
            
            -- Enter to confirm file selection
            key code 36
        end tell
    end if
end tell
`;
        // Run AppleScript asynchronously in background
        execFileAsync('osascript', ['-e', appleScript]).catch(e => {
            console.warn('[VoiceMemos] AppleScript warning:', e.message);
        });

        res.json({ success: true, targetPath });
    } catch (err) {
        console.error('[VoiceMemos] Auto-upload error:', err);
        res.status(500).json({ error: 'Failed auto-upload: ' + err.message });
    }
});

export default router;

