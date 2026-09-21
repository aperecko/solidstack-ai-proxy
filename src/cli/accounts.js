#!/usr/bin/env node

/**
 * Account Management CLI
 *
 * Interactive CLI for adding and managing Google accounts
 * for the Antigravity Claude Proxy.
 *
 * Usage:
 *   node src/cli/accounts.js          # Interactive mode
 *   node src/cli/accounts.js add      # Add new account(s)
 *   node src/cli/accounts.js list     # List all accounts
 *   node src/cli/accounts.js clear    # Remove all accounts
 */
import '../utils/proxy.js';
import { createInterface } from 'readline/promises';
import { stdin, stdout } from 'process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { dirname } from 'path';
import { discoverProject } from '../account-manager/credentials.js';
import { spawn } from 'child_process';
import net from 'net';
import { ACCOUNT_CONFIG_PATH, DEFAULT_PORT, DEFAULT_PROJECT_ID, MAX_ACCOUNTS } from '../constants.js';
import { discoverSwarmAccounts, provisionSwarmAccounts } from '../account-manager/swarm-admin.js';
import {
    getAuthorizationUrl,
    startCallbackServer,
    completeOAuthFlow,
    refreshAccessToken,
    getUserEmail,
    extractCodeFromInput
} from '../auth/oauth.js';

const SERVER_PORT = process.env.PORT || DEFAULT_PORT;

/**
 * Check if the Antigravity Proxy server is running
 * Returns true if port is occupied
 */
function isServerRunning() {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(1000);

        socket.on('connect', () => {
            socket.destroy();
            resolve(true); // Server is running
        });

        socket.on('timeout', () => {
            socket.destroy();
            resolve(false);
        });

        socket.on('error', (err) => {
            socket.destroy();
            resolve(false); // Port free
        });

        socket.connect(SERVER_PORT, 'localhost');
    });
}

/**
 * Enforce that server is stopped before proceeding
 */
async function ensureServerStopped() {
    const isRunning = await isServerRunning();
    if (isRunning) {
        console.warn(`
\x1b[33mWarning: Antigravity Proxy server is currently running on port ${SERVER_PORT}.\x1b[0m

The CLI will notify the server to reload your changes automatically.
`);
    }
}

/**
 * Create readline interface
 */
function createRL() {
    return createInterface({ input: stdin, output: stdout });
}

/**
 * Open URL in default browser
 */
function openBrowser(url) {
    const platform = process.platform;
    let command;
    let args;

    if (platform === 'darwin') {
        command = 'open';
        args = [url];
    } else if (platform === 'win32') {
        command = 'cmd';
        args = ['/c', 'start', '', url.replace(/&/g, '^&')];
    } else {
        command = 'xdg-open';
        args = [url];
    }

    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {
        console.log('\n⚠ Could not open browser automatically.');
        console.log('Please open this URL manually:', url);
    });
    child.unref();
}

/**
 * Load existing accounts from config
 */
function loadAccounts() {
    try {
        if (existsSync(ACCOUNT_CONFIG_PATH)) {
            const data = readFileSync(ACCOUNT_CONFIG_PATH, 'utf-8');
            const config = JSON.parse(data);
            return config.accounts || [];
        }
    } catch (error) {
        console.error('Error loading accounts:', error.message);
    }
    return [];
}

/**
 * Save accounts to config
 */
function saveAccounts(accounts, settings = {}) {
    try {
        const dir = dirname(ACCOUNT_CONFIG_PATH);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }

        const config = {
            accounts: accounts.map(acc => ({
                email: acc.email,
                source: acc.source || 'oauth',
                refreshToken: acc.refreshToken,
                projectId: acc.projectId,
                addedAt: acc.addedAt || new Date().toISOString(),
                lastUsed: acc.lastUsed || null,
                modelRateLimits: acc.modelRateLimits || {},
                subscription: acc.subscription || undefined,
                enabled: acc.enabled !== undefined ? acc.enabled : true,
                isInvalid: acc.isInvalid || false,
                invalidReason: acc.invalidReason || null
            })),
            settings: {
                maxRetries: 5,
                ...settings
            },
            activeIndex: 0
        };

        writeFileSync(ACCOUNT_CONFIG_PATH, JSON.stringify(config, null, 2));
        console.log(`\n✓ Saved ${accounts.length} account(s) to ${ACCOUNT_CONFIG_PATH}`);
        
        // Notify server to reload if it's running
        import('http').then(http => {
            const req = http.request({
                hostname: '127.0.0.1',
                port: SERVER_PORT,
                path: '/api/accounts/reload',
                method: 'POST'
            }, (res) => {
                if (res.statusCode === 200) {
                    console.log('\x1b[32m✓ Hot-reloaded running proxy server with new accounts.\x1b[0m\n');
                }
            });
            req.on('error', () => {
                // Ignore, server is just not running
            });
            req.end();
        }).catch(() => {});
    } catch (error) {
        console.error('Error saving accounts:', error.message);
        throw error;
    }
}

/**
 * Display current accounts
 */
function displayAccounts(accounts) {
    if (accounts.length === 0) {
        console.log('\nNo accounts configured.');
        return;
    }

    console.log(`\n${accounts.length} account(s) saved:`);
    accounts.forEach((acc, i) => {
        // Check for any active model-specific rate limits
        const hasActiveLimit = Object.values(acc.modelRateLimits || {}).some(
            limit => limit.isRateLimited && limit.resetTime > Date.now()
        );
        const status = hasActiveLimit ? ' (rate-limited)' : '';
        console.log(`  ${i + 1}. ${acc.email}${status}`);
    });
}

/**
 * Add a new account via OAuth with automatic callback
 */
async function addAccount(existingAccounts) {
    console.log('\n=== Add Google Account ===\n');

    // Generate authorization URL
    const { url, verifier, state } = getAuthorizationUrl();

    console.log('Opening browser for Google sign-in...');
    console.log('(If browser does not open, copy this URL manually)\n');
    console.log(`   ${url}\n`);

    // Open browser
    openBrowser(url);

    // Start callback server and wait for code
    console.log('Waiting for authentication (timeout: 2 minutes)...\n');

    try {
        // startCallbackServer now returns { promise, abort }
        const { promise } = startCallbackServer(state);
        const code = await promise;

        console.log('Received authorization code. Exchanging for tokens...');
        const result = await completeOAuthFlow(code, verifier);

        // Check if account already exists
        const existing = existingAccounts.find(a => a.email === result.email);
        if (existing) {
            console.log(`\n⚠ Account ${result.email} already exists. Updating tokens.`);
            existing.refreshToken = result.refreshToken;
            // Note: projectId will be discovered and stored in refresh token on first use
            existing.addedAt = new Date().toISOString();
            return null; // Don't add duplicate
        }

        console.log(`\n✓ Successfully authenticated: ${result.email}`);
        console.log('  Project will be discovered on first API request.');

        return {
            email: result.email,
            refreshToken: result.refreshToken,
            // Note: projectId stored in refresh token, not as separate field
            addedAt: new Date().toISOString(),
            modelRateLimits: {}
        };
    } catch (error) {
        console.error(`\n✗ Authentication failed: ${error.message}`);
        return null;
    }
}

/**
 * Add a new account via OAuth with manual code input (no-browser mode)
 * For headless servers without a desktop environment
 */
async function addAccountNoBrowser(existingAccounts, rl) {
    console.log('\n=== Add Google Account (No-Browser Mode) ===\n');

    // Generate authorization URL
    const { url, verifier, state } = getAuthorizationUrl();

    console.log('Copy the following URL and open it in a browser on another device:\n');
    console.log(`   ${url}\n`);
    console.log('After signing in, you will be redirected to a localhost URL.');
    console.log('Copy the ENTIRE redirect URL or just the authorization code.\n');

    const input = await rl.question('Paste the callback URL or authorization code: ');

    try {
        const { code, state: extractedState } = extractCodeFromInput(input);

        // Validate state if present
        if (extractedState && extractedState !== state) {
            console.log('\n⚠ State mismatch detected. This could indicate a security issue.');
            console.log('Proceeding anyway as this is manual mode...');
        }

        console.log('\nExchanging authorization code for tokens...');
        const result = await completeOAuthFlow(code, verifier);

        // Check if account already exists
        const existing = existingAccounts.find(a => a.email === result.email);
        if (existing) {
            console.log(`\n⚠ Account ${result.email} already exists. Updating tokens.`);
            existing.refreshToken = result.refreshToken;
            // Note: projectId will be discovered and stored in refresh token on first use
            existing.addedAt = new Date().toISOString();
            return null; // Don't add duplicate
        }

        console.log(`\n✓ Successfully authenticated: ${result.email}`);
        console.log('  Project will be discovered on first API request.');

        return {
            email: result.email,
            refreshToken: result.refreshToken,
            // Note: projectId stored in refresh token, not as separate field
            addedAt: new Date().toISOString(),
            modelRateLimits: {}
        };
    } catch (error) {
        console.error(`\n✗ Authentication failed: ${error.message}`);
        return null;
    }
}

/**
 * Interactive remove accounts flow
 */
async function interactiveRemove(rl) {
    while (true) {
        const accounts = loadAccounts();
        if (accounts.length === 0) {
            console.log('\nNo accounts to remove.');
            return;
        }

        displayAccounts(accounts);
        console.log('\nEnter account number to remove (or 0 to cancel)');

        const answer = await rl.question('> ');
        const index = parseInt(answer, 10);

        if (isNaN(index) || index < 0 || index > accounts.length) {
            console.log('\n❌ Invalid selection.');
            continue;
        }

        if (index === 0) {
            return; // Exit
        }

        const removed = accounts[index - 1]; // 1-based to 0-based
        const confirm = await rl.question(`\nAre you sure you want to remove ${removed.email}? [y/N]: `);

        if (confirm.toLowerCase() === 'y') {
            accounts.splice(index - 1, 1);
            saveAccounts(accounts);
            console.log(`\n✓ Removed ${removed.email}`);
        } else {
            console.log('\nCancelled.');
        }

        const removeMore = await rl.question('\nRemove another account? [y/N]: ');
        if (removeMore.toLowerCase() !== 'y') {
            break;
        }
    }
}

/**
 * Interactive add accounts flow (Main Menu)
 * @param {Object} rl - readline interface
 * @param {boolean} noBrowser - if true, use manual code input mode
 */
async function interactiveAdd(rl, noBrowser = false) {
    if (noBrowser) {
        console.log('\n📋 No-browser mode: You will manually paste the authorization code.\n');
    }

    const accounts = loadAccounts();

    if (accounts.length > 0) {
        displayAccounts(accounts);

        const choice = await rl.question('\n(a)dd new, (r)emove existing, (f)resh start, or (e)xit? [a/r/f/e]: ');
        const c = choice.toLowerCase();

        if (c === 'r') {
            await interactiveRemove(rl);
            return; // Return to main or exit? Given this is "add", we probably exit after sub-task.
        } else if (c === 'f') {
            console.log('\nStarting fresh - existing accounts will be replaced.');
            accounts.length = 0;
        } else if (c === 'a') {
            console.log('\nAdding to existing accounts.');
        } else if (c === 'e') {
            console.log('\nExiting...');
            return; // Exit cleanly
        } else {
            console.log('\nInvalid choice, defaulting to add.');
        }
    }

    // Add single account
    if (accounts.length >= MAX_ACCOUNTS) {
        console.log(`\nMaximum of ${MAX_ACCOUNTS} accounts reached.`);
        return;
    }

    // Use appropriate add function based on mode
    const newAccount = noBrowser
        ? await addAccountNoBrowser(accounts, rl)
        : await addAccount(accounts);

    if (newAccount) {
        accounts.push(newAccount);
        saveAccounts(accounts);
    } else if (accounts.length > 0) {
        // Even if newAccount is null (duplicate update), save the updated accounts
        saveAccounts(accounts);
    }

    if (accounts.length > 0) {
        displayAccounts(accounts);
        console.log('\nTo add more accounts, run this command again.');
    } else {
        console.log('\nNo accounts to save.');
    }
}

/**
 * List accounts
 */
async function listAccounts() {
    const accounts = loadAccounts();
    displayAccounts(accounts);

    if (accounts.length > 0) {
        console.log(`\nConfig file: ${ACCOUNT_CONFIG_PATH}`);
    }
}

/**
 * Clear all accounts
 */
async function clearAccounts(rl) {
    const accounts = loadAccounts();

    if (accounts.length === 0) {
        console.log('No accounts to clear.');
        return;
    }

    displayAccounts(accounts);

    const confirm = await rl.question('\nAre you sure you want to remove all accounts? [y/N]: ');
    if (confirm.toLowerCase() === 'y') {
        saveAccounts([]);
        console.log('All accounts removed.');
    } else {
        console.log('Cancelled.');
    }
}

/**
 * Verify accounts (test refresh tokens)
 */
async function verifyAccounts() {
    const accounts = loadAccounts();

    if (accounts.length === 0) {
        console.log('No accounts to verify.');
        return;
    }

    console.log('\nVerifying accounts...\n');

    for (const account of accounts) {
        try {
            const tokens = await refreshAccessToken(account.refreshToken);
            const email = await getUserEmail(tokens.accessToken);
            console.log(`  ✓ ${email} - OK`);
        } catch (error) {
            console.log(`  ✗ ${account.email} - ${error.message}`);
        }
    }
}

/**
 * Auto-discover swarm accounts via Google Admin SDK
 */
async function autoDiscoverSwarm() {
    console.log('\n=== Swarm Auto-Discovery ===\n');
    console.log('Querying Google Workspace for swarm accounts...');
    
    try {
        const discovered = await discoverSwarmAccounts();
        if (discovered.length === 0) {
            console.log('\nNo swarm accounts found matching the expected prefix.');
            return;
        }

        const accounts = loadAccounts();
        const existingEmails = new Set(accounts.map(a => a.email.toLowerCase()));
        
        let newCount = 0;
        for (const email of discovered) {
            if (!existingEmails.has(email.toLowerCase())) {
                accounts.push({
                    email: email,
                    refreshToken: 'PENDING_AUTH',
                    source: 'service_account',
                    subscription: { tier: 'free' },
                    enabled: true,
                    addedAt: new Date().toISOString(),
                    modelRateLimits: {}
                });
                newCount++;
            }
        }
        
        if (newCount > 0) {
            saveAccounts(accounts);
            console.log(`\n✓ Imported ${newCount} new swarm account(s) into proxy config.`);
        } else {
            console.log('\n✓ All discovered swarm accounts are already in the proxy config.');
        }
        
        console.log(`\nTotal accounts in config: ${accounts.length}`);
    } catch (error) {
        console.error('\n✗ Auto-discovery failed:', error.message);
    }
}

/**
 * Provision new swarm accounts
 */
async function provisionSwarm(args) {
    if (args.length < 3) {
        console.log('\nUsage: node src/cli/accounts.js provision-swarm <domain> <prefix> <count> [startIdx]');
        console.log('Example: node src/cli/accounts.js provision-swarm mysolidstate.ca z 42');
        return;
    }
    
    const domain = args[0];
    const prefix = args[1];
    const count = parseInt(args[2], 10);
    const startIdx = args[3] ? parseInt(args[3], 10) : 1;
    
    if (isNaN(count) || count <= 0) {
        console.log('\n✗ Count must be a positive number');
        return;
    }
    
    try {
        await provisionSwarmAccounts(domain, prefix, startIdx, count);
    } catch (error) {
        console.error('\n✗ Provisioning failed:', error.message);
    }
}

/**
 * Persist only the fields Google filled in, leaving every other field intact.
 *
 * saveAccounts() above writes a fixed field whitelist, which would drop quota,
 * corporateFootprint, disabledBy429 and friends for every account and reset
 * settings/activeIndex. This pass must not do that, so it read-modify-writes the
 * config itself and renames into place, the way storage.js does.
 */
function patchAccounts(updates, settings) {
    const config = JSON.parse(readFileSync(ACCOUNT_CONFIG_PATH, 'utf-8'));
    let changed = 0;
    for (const account of config.accounts || []) {
        const patch = updates.get(account.email.toLowerCase());
        if (!patch) continue;
        if (patch.projectId) account.projectId = patch.projectId;
        if (patch.subscription) account.subscription = patch.subscription;
        changed++;
    }
    if (settings) config.settings = { ...(config.settings || {}), ...settings };
    const tmpPath = `${ACCOUNT_CONFIG_PATH}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(config, null, 2));
    renameSync(tmpPath, ACCOUNT_CONFIG_PATH);
    return changed;
}

/** Wait, used to pace onboarding so Google does not answer 429. */
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Enable AI Code Assist (Antigravity) for accounts Google has never licensed.
 *
 * The pool can only serve an account once Google has provisioned its Code Assist
 * entitlement. Until then every pooled request comes back
 *
 *   403 "You do not have a valid license of this product."
 *
 * because loadCodeAssist reports no project and onboardUser never completed --
 * which is exactly what the accounts with no projectId look like. This drives
 * loadCodeAssist -> onboardUser one account at a time and persists only the two
 * fields Google fills in.
 *
 * Google throttles the onboarding endpoint hard (429 RESOURCE_EXHAUSTED), so
 * serial execution with backoff is the point of this pass rather than a
 * limitation to work around: firing the swarm at it in parallel is what left the
 * fleet unlicensed in the first place.
 *
 * Usage:
 *   node src/cli/accounts.js enable-code-assist [--apply] [--only <substr>]
 *                                               [--limit N] [--delay MS] [--all]
 */
async function enableCodeAssist(args) {
    const apply = args.includes('--apply');
    const all = args.includes('--all');
    const onlyIdx = args.indexOf('--only');
    const only = onlyIdx !== -1 ? args[onlyIdx + 1] : null;
    const limitIdx = args.indexOf('--limit');
    const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : Infinity;
    const delayIdx = args.indexOf('--delay');
    const delayMs = delayIdx !== -1 ? parseInt(args[delayIdx + 1], 10) : 2000;

    const config = JSON.parse(readFileSync(ACCOUNT_CONFIG_PATH, 'utf-8'));
    const accounts = config.accounts || [];
    const eligible = accounts.filter((a) => {
        if (a.enabled === false || a.isInvalid) return false;
        if (!a.refreshToken || a.refreshToken.startsWith('PENDING_AUTH')) return false;
        if (only && !a.email.toLowerCase().includes(only.toLowerCase())) return false;
        return all ? true : !a.projectId;
    });
    const candidates = eligible.slice(0, limit);

    console.log(`\n=== Enable AI Code Assist (Antigravity) ===\n`);
    console.log(`  accounts in config : ${accounts.length}`);
    console.log(`  already has project: ${accounts.length - eligible.length}`);
    console.log(`  to onboard         : ${eligible.length}${candidates.length < eligible.length ? ` (this pass: ${candidates.length})` : ''}`);
    console.log(`  mode               : ${apply ? 'APPLY' : 'dry run (pass --apply to write)'}`);
    console.log(`  pacing             : ${delayMs}ms between accounts\n`);

    if (candidates.length === 0) {
        console.log('Nothing to do — every eligible account already has a Code Assist project.');
        return;
    }
    if (!apply) {
        for (const a of candidates.slice(0, 20)) console.log(`    would onboard ${a.email}`);
        if (candidates.length > 20) console.log(`    ... and ${candidates.length - 20} more`);
        console.log('\nRe-run with --apply to actually provision them.');
        return;
    }

    const updates = new Map();
    let ok = 0;
    let failed = 0;

    for (let i = 0; i < candidates.length; i++) {
        const account = candidates[i];
        const tag = `[${i + 1}/${candidates.length}] ${account.email}`;
        try {
            const tokens = await refreshAccessToken(account.refreshToken);
            const { project, subscription } = await discoverProject(tokens.accessToken, account.projectId);

            // discoverProject falls back to DEFAULT_PROJECT_ID when onboarding did
            // not complete. That sentinel is not an entitlement — treating it as
            // success is what would leave these accounts looking licensed but still
            // answering 403, so require a real project id.
            if (!project || project === DEFAULT_PROJECT_ID) {
                failed++;
                console.log(`${tag}  ✗ still unlicensed (onboardUser did not grant a project)`);
            } else {
                updates.set(account.email.toLowerCase(), { projectId: project, subscription });
                ok++;
                console.log(`${tag}  ✓ ${project}${subscription?.tier ? ` (${subscription.tier})` : ''}`);
            }
        } catch (error) {
            failed++;
            const throttled = /429|RESOURCE_EXHAUSTED/i.test(error.message || '');
            console.log(`${tag}  ✗ ${throttled ? 'throttled (429)' : error.message}`);
        }
        await sleep(delayMs);
    }

    if (updates.size > 0) {
        const changed = patchAccounts(updates, config.settings);
        console.log(`\n✓ Wrote Code Assist project ids for ${changed} account(s).`);
        // Ask the running proxy to pick the change up without a restart.
        try {
            const http = await import('http');
            await new Promise((resolve) => {
                const req = http.request({
                    hostname: '127.0.0.1', port: SERVER_PORT,
                    path: '/api/accounts/reload', method: 'POST'
                }, () => resolve());
                req.on('error', () => resolve());
                req.end();
            });
            console.log('✓ Reload signalled to the running proxy.');
        } catch { /* server not running is fine */ }
    }

    console.log(`\n=== Summary: ${ok} licensed, ${failed} still blocked ===`);
    if (failed > 0) {
        console.log('Re-run to retry the blocked ones — Google throttles the onboard endpoint,\n'
                  + 'so a fleet-wide sweep usually needs several paced passes.');
    }
}

/**
 * Main CLI
 */
async function main() {
    const args = process.argv.slice(2);
    const command = args[0] || 'add';
    const noBrowser = args.includes('--no-browser');

    console.log('╔════════════════════════════════════════╗');
    console.log('║   Antigravity Proxy Account Manager    ║');
    console.log('║   Use --no-browser for headless mode   ║');
    console.log('╚════════════════════════════════════════╝');

    const rl = createRL();

    try {
        switch (command) {
            case 'add':
                await ensureServerStopped();
                await interactiveAdd(rl, noBrowser);
                break;
            case 'list':
                await listAccounts();
                break;
            case 'clear':
                await ensureServerStopped();
                await clearAccounts(rl);
                break;
            case 'verify':
                await verifyAccounts();
                break;
            case 'auto-discover':
                await ensureServerStopped();
                await autoDiscoverSwarm();
                break;
            case 'enable-code-assist':
                await enableCodeAssist(args.slice(1));
                break;
            case 'provision-swarm':
                await provisionSwarm(args.slice(1));
                break;
            case 'help':
                console.log('\nUsage:');
                console.log('  node src/cli/accounts.js add     Add new account(s)');
                console.log('  node src/cli/accounts.js list    List all accounts');
                console.log('  node src/cli/accounts.js verify          Verify account tokens');
                console.log('  node src/cli/accounts.js clear           Remove all accounts');
                console.log('  node src/cli/accounts.js auto-discover   Discover and import all swarm accounts');
                console.log('  node src/cli/accounts.js provision-swarm <domain> <prefix> <count>');
                console.log('  node src/cli/accounts.js help            Show this help');
                console.log('  node src/cli/accounts.js enable-code-assist [--apply]');
                console.log('                                           License unlicensed accounts for AI Code Assist');
                console.log('\nOptions:');
                console.log('  --no-browser    Manual authorization code input (for headless servers)');
                break;
            case 'remove':
                await ensureServerStopped();
                await interactiveRemove(rl);
                break;
            default:
                console.log(`Unknown command: ${command}`);
                console.log('Run with "help" for usage information.');
        }
    } finally {
        rl.close();
        // Force exit to prevent hanging
        process.exit(0);
    }
}

main().catch(console.error);
