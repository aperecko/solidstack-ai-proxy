import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';
import { getAuthorizationUrl, startCallbackServer, completeOAuthFlow } from './auth/oauth.js';
import { OAUTH_CONFIG } from './constants.js';

// Stealth Plugin Setup
import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import puppeteerCore from 'puppeteer-core';
puppeteerExtra.use(StealthPlugin());

const ACCOUNTS_FILE = join(homedir(), '.config', 'antigravity-proxy', 'accounts.json');
const VAULT_FILE = join(homedir(), '.config', 'antigravity-proxy', 'swarm-recovery-vault.json');
const DEFAULT_PASSWORD = process.env.DEFAULT_PASSWORD || 'Swarmd6f9b714!!2026';
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '5', 10);

function getNextPendingAccounts(limit = 5) {
    const existing = JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf8'));
    const activeEmails = new Set(existing.accounts.map(a => a.email));
    const vault = JSON.parse(readFileSync(VAULT_FILE, 'utf8'));
    
    const pending = Object.keys(vault).filter(email => !activeEmails.has(email) && email.includes('@reseller.mysolidstate.ca'));
    return pending.slice(0, limit);
}

function dismissNativeDialogs() {
    // Deprecated: OS-level keyboard events removed to prevent focus stealing.
}

async function hardwareType(page, text) {
    await page.keyboard.type(text, { delay: 30 });
}

async function hardwarePress(page, key) {
    await page.keyboard.press(key);
}

async function hardwareClick(page, element) {
    try {
        await element.click();
        return true;
    } catch (e) {
        return false;
    }
}

async function clearField(page) {
    await page.keyboard.down('Meta');
    await page.keyboard.press('a');
    await page.keyboard.up('Meta');
    await page.keyboard.press('Backspace');
    await new Promise(r => setTimeout(r, 100));
}

async function onboardSingleAccount(email) {
    console.log(`\n======================================================`);
    console.log(`🤖 [Zero-Touch Ultimate] Auto-Onboarding: ${email}`);
    console.log(`======================================================`);

    const redirectUri = `http://localhost:${OAUTH_CONFIG.callbackPort}/oauth-callback`;
    const authUrl = getAuthorizationUrl(redirectUri, email);
    const { promise, abort } = startCallbackServer(authUrl.state, 180000);

    // Using a persistent automation profile instead of a throwaway /tmp directory
    const profileDir = '/Users/test/Library/Application Support/Google/Chrome_Automation';
    
    // Launch natively, no headless, no focus stealing
    const browser = await puppeteerExtra.launch({
        executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        headless: false,
        defaultViewport: null,
        ignoreDefaultArgs: ['--enable-automation'],
        args: [
            '--force-dark-mode',
            `--user-data-dir=${profileDir}`,
            '--profile-directory=Default',
            '--no-first-run',
            '--no-default-browser-check',
            '--remote-debugging-port=9222',
        ]
    });

    const page = await browser.newPage();
    console.log("Navigating to OAuth...");
    
    await page.goto(authUrl.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    
    // Some profile picker dialogs steal focus, hit Escape just in case
    dismissNativeDialogs();
    console.log("Page loaded!");

    let emailEntered = false;
    let passwordEntered = false;
    let pinEntered = false;

    let finished = false;
    
    async function openclawHandoff(email) {
        console.log(`🤖 Dispatching OpenClaw agent for ${email}...`);
        try {
            const playbookPath = join(process.cwd(), '..', 'openclaw_skills', 'swarm_auth_playbook.md');
            if (existsSync(playbookPath)) {
                // We use port 9222 which is the default for OpenClaw / agent-browser
                execSync(`openclaw agent --message-file "${playbookPath}"`, { stdio: 'inherit' });
            } else {
                console.log(`OpenClaw playbook not found at ${playbookPath}, falling back to manual wait.`);
            }
        } catch (e) {
            console.log(`OpenClaw execution error: ${e.message}`);
        }
    }
    
    openclawHandoff(email);

    try {
        const code = await promise;
        finished = true;
        console.log(`🎉 Capturing token and provisioning Code Assist for ${email}...`);

        const authResult = await completeOAuthFlow(code, authUrl.verifier);

        if (authResult.refreshToken) {
            const data = JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf8'));
            const existingIdx = data.accounts.findIndex(a => a.email === email);
            const companionProjectId = authResult.projectId || 'aicode-consumers';
            const compoundRefreshToken = authResult.refreshToken.includes('||') 
                ? authResult.refreshToken 
                : `${authResult.refreshToken}||${companionProjectId}`;

            const accountObj = {
                email,
                refreshToken: compoundRefreshToken,
                projectId: companionProjectId,
                source: 'oauth',
                enabled: true,
                isInvalid: false,
                invalidReason: null,
                subscription: { tier: 'free', projectId: companionProjectId, detectedAt: Date.now() }
            };

            if (existingIdx >= 0) {
                data.accounts[existingIdx] = { ...data.accounts[existingIdx], ...accountObj };
            } else {
                data.accounts.push(accountObj);
            }

            writeFileSync(ACCOUNTS_FILE, JSON.stringify(data, null, 2));
            console.log(`✅ [COMPLETE] ${email} permanently active in ai-proxy!`);
            await browser.close();
            return true;
        } else {
            console.error(`❌ Token exchange failed for ${email}`);
            await browser.close();
            return false;
        }
    } catch (e) {
        console.error(`❌ Error on ${email}:`, e.message);
        finished = true;
        abort();
        try { await browser.close(); } catch (err) {}
        return false;
    }
}

async function run() {
    let queue = [];
    if (process.argv[2]) {
        queue = [process.argv[2]];
        console.log(`📋 Single-Target Zero-Touch Run for: ${queue[0]}`);
    } else {
        queue = getNextPendingAccounts(BATCH_SIZE);
        console.log(`📋 Batch Queue for this Zero-Touch Run (${queue.length} accounts):`);
        console.log(queue.join(', '));
    }

    let count = 0;
    for (let i = 0; i < queue.length; i++) {
        const email = queue[i];
        const ok = await onboardSingleAccount(email);
        if (ok) {
            count++;
            if (i < queue.length - 1) {
                console.log(`⏳ Pacing 8 seconds before next account...`);
                await new Promise(r => setTimeout(r, 8000));
            }
        } else {
            break;
        }
    }
    console.log(`\n🎉 Zero-Touch Batch Finished! Onboarded: ${count}/${queue.length}`);
}

run();
