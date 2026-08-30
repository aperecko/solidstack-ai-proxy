/**
 * Storage Concurrency Tests (C7)
 *
 * Verifies the cross-process file-lock guarantees of `src/account-manager/storage.js`:
 *  1. Real mutual exclusion ACROSS processes (not just in-process writeLock).
 *  2. A crashing writer cannot deadlock the system (stale lock is broken).
 *  3. An exception inside the critical section releases the lock (no leak).
 *  4. Concurrent saveAccounts from multiple processes never produce torn/corrupt
 *     JSON on disk (atomic tmp+rename under mutual exclusion).
 *
 * Run: node tests/test-storage-concurrency.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, mkdir, utimes } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import { withFileLock, loadAccounts, saveAccounts } from '../src/account-manager/storage.js';

function tmpdirPath() {
    return mkdtemp(join(tmpdir(), 'ss-storage-'));
}

/** Spawn a module-EVAL child. Resolves {code, signal}. */
function runChild(code, cwd) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
            cwd,
            stdio: 'inherit',
        });
        child.on('close', (code) => resolve({ code }));
        child.on('error', (err) => resolve({ code: -1, err }));
    });
}

test('withFileLock excludes a SECOND PROCESS while held', async () => {
    const dir = await tmpdirPath();
    const lockPath = join(dir, 'accts.json.lock');
    const readyPath = join(dir, 'holder-ready');
    const releasePath = join(dir, 'holder-may-release');

    // Child acquires the lock and holds it until told to release.
    const holderCode = `
        import { withFileLock } from './src/account-manager/storage.js';
        import { writeFile } from 'node:fs/promises';
        const [lockPath, readyPath, releasePath] = process.argv.slice(1);
        await withFileLock(lockPath, async () => {
            await writeFile(readyPath, '1', 'utf8');
            while (true) {
                try { await import('node:fs/promises').then(m => m.access(releasePath)); break; }
                catch { await new Promise(r => setTimeout(r, 20)); }
            }
        });
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', holderCode, lockPath, readyPath, releasePath], {
        cwd: join(import.meta.dirname, '..'),
        stdio: 'inherit',
    });

    // Wait for the child to actually hold the lock.
    let waited = 0;
    while (!existsSync(readyPath) && waited < 5000) {
        await new Promise((r) => setTimeout(r, 50));
        waited += 50;
    }
    assert.ok(existsSync(readyPath), 'child never signaled it held the lock');

    // A competing acquisition in THIS process must time out while held.
    let timedOut = false;
    try {
        await withFileLock(lockPath, async () => {}, { maxAgeMs: 15000, retries: 2, delayMs: 30 });
    } catch {
        timedOut = true;
    }
    assert.ok(timedOut, 'second process should NOT enter the critical section while lock is held');

    // Release the child; the lock must become available immediately.
    await writeFile(releasePath, '1', 'utf8');
    await new Promise((resolve) => child.on('close', resolve));
    await withFileLock(lockPath, async () => {}, { maxAgeMs: 5000, retries: 20, delayMs: 25 });
});

test('stale lock files (old mtime) are broken, not respected forever', async () => {
    const dir = await tmpdirPath();
    const lockPath = join(dir, 'stale.lock');
    await writeFile(lockPath, String(Date.now() - 90000), 'utf8');
    // Back-date the mtime so it looks like a long-ago crashed writer.
    const past = new Date(Date.now() - 90000);
    await utimes(lockPath, past, past);

    let ran = false;
    await withFileLock(lockPath, async () => { ran = true; }, { maxAgeMs: 1000, retries: 3, delayMs: 10 });
    assert.ok(ran, 'stale lock must be broken so a crashed writer cannot deadlock saves');
});

test('an exception inside the critical section still releases the lock', async () => {
    const dir = await tmpdirPath();
    const lockPath = join(dir, 'accts.json.lock');

    await assert.rejects(
        withFileLock(lockPath, async () => { throw new Error('boom'); }),
        /boom/,
    );
    // Re-acquisition must succeed immediately (no leaked lock).
    await withFileLock(lockPath, async () => {}, { maxAgeMs: 5000, retries: 10, delayMs: 15 });
});

test('concurrent saveAccounts across processes never leaves corrupt JSON', async () => {
    const dir = await tmpdirPath();
    const configPath = join(dir, 'accounts.json');
    await mkdir(dirname(configPath), { recursive: true });
    const seed = JSON.stringify({ accounts: [], settings: {}, activeIndex: 0 });
    await writeFile(configPath, seed, 'utf8');

    const workerCode = `
        import { loadAccounts, saveAccounts } from './src/account-manager/storage.js';
        const [configPath, workerId] = process.argv.slice(1);
        const entry = {
            email: \`worker-\${workerId}@concurrency.test\`,
            source: 'oauth',
            enabled: true,
            refreshToken: 'PENDING_AUTH',
        };
        for (let i = 0; i < 4; i++) {
            const loaded = await loadAccounts(configPath);
            const current = loaded ? loaded.accounts : [];
            const next = [...current.filter(a => a.email !== entry.email), entry];
            await saveAccounts(configPath, next, {}, 0);
        }
        process.exit(0);
    `;

    const workers = [0, 1, 2, 3, 4].map((id) =>
        spawn(process.execPath, ['--input-type=module', '-e', workerCode, configPath, String(id)], {
            cwd: join(import.meta.dirname, '..'),
            stdio: 'inherit',
        }),
    );

    // Sample the config continuously: it must ALWAYS be valid JSON (no torn writes).
    const checks = [];
    const sampler = setInterval(async () => {
        try {
            const raw = await readFile(configPath, 'utf8');
            JSON.parse(raw); // throws if torn
            checks.push(true);
        } catch {
            checks.push(false);
        }
    }, 5);

    const exits = await Promise.all(workers.map((w) => new Promise((res) => w.on('close', res))));
    clearInterval(sampler);

    for (const [i, code] of exits.entries()) {
        assert.equal(code, 0, `worker ${i} exited non-zero`);
    }
    assert.ok(checks.every(Boolean), 'config file was observed torn/corrupt during concurrent saves');

    const finalRaw = await readFile(configPath, 'utf8');
    const finalConfig = JSON.parse(finalRaw);
    const emails = finalConfig.accounts.map((a) => a.email);
    assert.ok(emails.length >= 1, 'final config should contain at least one account');

    const lastSeen = await loadAccounts(configPath);
    assert.ok(lastSeen && Array.isArray(lastSeen.accounts), 'final file loads cleanly');
});