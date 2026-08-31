import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import puppeteer from 'puppeteer-core';
import { getAuthorizationUrl, startCallbackServer, completeOAuthFlow } from '../auth/oauth.js';
import { OAUTH_CONFIG } from '../constants.js';

const ACCOUNTS_FILE = join(homedir(), '.config', 'antigravity-proxy', 'accounts.json');
const BACKUP_FILE = join(homedir(), '.config', 'antigravity-proxy', 'accounts.json.bak');
const VAULT_FILE = join(homedir(), '.config', 'antigravity-proxy', 'swarm-recovery-vault.json');

// Check if a default password or target email is provided
const DEFAULT_PASSWORD = process.env.DEFAULT_PASSWORD || 'Swarmd6f9b714!!2026';
const TARGET_EMAIL = process.env.TARGET_EMAIL || '';
const RECOVERY_EMAIL = process.env.RECOVERY_EMAIL || 'apps@reseller.mysolidstate.ca';
// Headless by default so the script works from agents/launchd/SSH sessions.
// Set HEADLESS=false to watch the login flow in a visible Chrome window.
const HEADLESS = process.env.HEADLESS === 'false' ? false : 'new';

const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '5', 10);
const TARGET_DOMAIN = process.env.DOMAIN || '';
const DEBUG_SCREENSHOT = process.env.DEBUG_SCREENSHOTS === 'true'
    ? (process.env.DEBUG_SCREENSHOT_PATH || '/tmp/ag-swarm-login-debug.png')
    : null;

async function autoAuth() {
    const configData = JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf8'));
    
    let pendingAccounts = [];

    if (TARGET_EMAIL) {
        pendingAccounts = [{ email: TARGET_EMAIL }];
    } else {
        pendingAccounts = configData.accounts.filter(a => {
            const domainMatch = TARGET_DOMAIN ? a.email.includes(TARGET_DOMAIN) : a.email.includes('@reseller.mysolidstate.ca');
            const isNotAdmin = !a.email.startsWith('apps@') && !a.email.startsWith('adam@');
            const needsAuth = !a.refreshToken || a.refreshToken === 'PENDING_AUTH' || a.source === 'service_account' || a.isInvalid;
            return domainMatch && isNotAdmin && needsAuth;
        }).slice(0, BATCH_SIZE);
    }
    
    if (pendingAccounts.length === 0) {
        console.log("No accounts pending OAuth authentication.");
        return;
    }
    
    console.log(`Found ${pendingAccounts.length} accounts to authenticate.`);
    console.log('Launching browser in incognito mode...');
    
    // Launch user's Chrome in an isolated incognito context
    const browser = await puppeteer.launch({
        executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        headless: HEADLESS,
        defaultViewport: null,
                args: [
            '--window-size=1200,800',
            '--disable-blink-features=AutomationControlled',
            '--incognito',
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-sync',
            '--disable-features=ProfilePickerOnStartup,SigninProfileCreation,EnterpriseProfileCreation,ProfileCustomization,Sync'
        ]
    });

    // Keep base blank page open so browser process stays alive across loop
    const basePages = await browser.pages();
    const basePage = basePages[0] || await browser.newPage();
    try { await basePage.goto('about:blank'); } catch (e) {}

    let successCount = 0;

    for (let i = 0; i < pendingAccounts.length; i++) {
        const account = pendingAccounts[i];
        console.log(`\n[${i+1}/${pendingAccounts.length}] Authenticating ${account.email}...`);
        
        try {
            // Setup callback server
            const redirectUri = `http://localhost:${OAUTH_CONFIG.callbackPort}/oauth-callback`;
            const authUrl = getAuthorizationUrl(redirectUri);
            const { promise, abort } = startCallbackServer(authUrl.state);

            const page = await browser.newPage();
            
            // Clear all cookies and session data to ensure fresh login
            try {
                const client = await page.target().createCDPSession();
                await client.send('Network.clearBrowserCookies');
                await client.send('Network.clearBrowserCache');
            } catch (e) {}

            // Navigate to Google OAuth
            console.log(`Navigating to Google OAuth...`);
            await page.goto(authUrl.url, { waitUntil: 'networkidle2' });
            
            // Auto-fill email
            try {
                const emailSelector = 'input[type="email"], input[name="identifier"]';
                await page.waitForSelector(emailSelector, { timeout: 10000 });
                await page.type(emailSelector, account.email, { delay: 30 });
                await page.keyboard.press('Enter');
                console.log(`Entered email.`);
            } catch (e) {
                console.log(`Email auto-fill note:`, e.message);
            }

            // Start an auto-clicker and auto-filler loop in the background while waiting for OAuth completion
            // Clean state machine: single-action per tick with submission in-flight locking
            let isActionInFlight = false;
            let lastActionTime = 0;

            const clickInterval = setInterval(async () => {
                if (isActionInFlight || Date.now() - lastActionTime < 1500) return;
                
                try {
                    isActionInFlight = true;

                    // 1. Handle Password Field
                    const passInput = await page.$('input[type="password"]:not([aria-hidden="true"]), input[name="Passwd"], input[name="password"]');
                    if (passInput) {
                        const currentVal = await page.evaluate(el => el.value, passInput);
                        if (!currentVal && DEFAULT_PASSWORD) {
                            console.log('Typing password with human delay...');
                            await passInput.type(DEFAULT_PASSWORD, { delay: 45 });
                            await new Promise(r => setTimeout(r, 600));
                            const nextBtn = await page.$('#passwordNext, button[type="submit"]');
                            if (nextBtn) {
                                await nextBtn.click();
                            } else {
                                await page.keyboard.press('Enter');
                            }
                            console.log('Submitted password.');
                            lastActionTime = Date.now();
                            isActionInFlight = false;
                            return;
                        }
                    }

                    // 2. Handle "Try another way" if present
                    const tryAnotherWay = await page.evaluate(() => {
                        const buttons = Array.from(document.querySelectorAll('button, [role="button"], a'));
                        for (const b of buttons) {
                            if ((b.innerText || '').trim().toLowerCase() === 'try another way' && !b.disabled) {
                                if (!b.id) b.id = 'try_another_' + Math.random().toString(36).slice(2);
                                return '#' + b.id;
                            }
                        }
                        return null;
                    });
                    if (tryAnotherWay) {
                        await page.click(tryAnotherWay);
                        console.log('Selected "Try another way"...');
                        await new Promise(r => setTimeout(r, 1000));
                        lastActionTime = Date.now();
                        isActionInFlight = false;
                        return;
                    }

                    // 3. Handle Backup Code Option Click
                    const backupOption = await page.evaluate(() => {
                        const els = Array.from(document.querySelectorAll('div[role="link"], div[role="button"], li, div[data-challengetype]'));
                        for (const el of els) {
                            const text = (el.innerText || '').toLowerCase();
                            if ((text.includes('backup code') || text.includes('8-digit')) && !el.disabled) {
                                if (!el.id) el.id = 'backup_opt_' + Math.random().toString(36).slice(2);
                                return '#' + el.id;
                            }
                        }
                        return null;
                    });
                    if (backupOption) {
                        await page.click(backupOption);
                        console.log('Selected Backup Code option...');
                        await new Promise(r => setTimeout(r, 1000));
                        lastActionTime = Date.now();
                        isActionInFlight = false;
                        return;
                    }

                    // 4. Handle Backup Code Input Field
                    const backupInput = await page.$('input[type="tel"][name="idvPin"], input[name="Pin"], input[id="backupCodePin"], input[type="tel"]');
                    if (backupInput) {
                        const currentVal = await page.evaluate(el => el.value, backupInput);
                        if (!currentVal) {
                            let codeToUse = process.env.BACKUP_CODE;
                            if (!codeToUse && fs.existsSync(VAULT_FILE)) {
                                try {
                                    const v = JSON.parse(fs.readFileSync(VAULT_FILE, 'utf8'));
                                    if (v[account.email] && v[account.email].backupCodes && v[account.email].backupCodes.length > 0) {
                                        codeToUse = v[account.email].backupCodes[0];
                                    }
                                } catch (e) {}
                            }
                            if (codeToUse) {
                                console.log('Typing backup code:', codeToUse);
                                await backupInput.type(codeToUse, { delay: 40 });
                                await new Promise(r => setTimeout(r, 500));
                                await page.keyboard.press('Enter');
                                console.log('Submitted backup code.');
                                lastActionTime = Date.now();
                                isActionInFlight = false;
                                return;
                            }
                        }
                    }

                    // 5. Handle Consent / Terms of Service ("I understand", "Accept", "Allow", "Continue")
                    const consentSelector = await page.evaluate(() => {
                        const targetTexts = ['i understand', 'accept', 'allow', 'continue', 'agree', 'confirm'];
                        const elements = Array.from(document.querySelectorAll('button, [role="button"], a[role="button"]'));
                        for (const el of elements) {
                            const text = (el.innerText || el.textContent || '').trim().toLowerCase();
                            if (targetTexts.some(t => text === t || text.includes(t)) && !el.disabled) {
                                if (!el.id) el.id = 'target_consent_' + Math.random().toString(36).slice(2);
                                return '#' + el.id;
                            }
                        }
                        return null;
                    });
                    if (consentSelector) {
                        await new Promise(r => setTimeout(r, 800)); // Natural pause before agreeing
                        await page.click(consentSelector);
                        console.log('Clicked consent / terms agreement button.');
                        lastActionTime = Date.now();
                        isActionInFlight = false;
                        return;
                    }

                } catch (e) {
                    // Ignore DOM navigation transient errors
                } finally {
                    isActionInFlight = false;
                }

                if (DEBUG_SCREENSHOT) {
                    try {
                        await page.screenshot({ path: DEBUG_SCREENSHOT });
                    } catch (e) {}
                }
            }, 1000);

            // Wait for the callback server to receive the code
            console.log(`Waiting for consent approval (Auto-clicking enabled)...`);
            let code;
            try {
                code = await promise;
            } finally {
                clearInterval(clickInterval);
            }
            console.log(`Got OAuth code! Exchanging for tokens and onboarding...`);
            const authResult = await completeOAuthFlow(code, authUrl.verifier);
            
            if (authResult.refreshToken) {
                // Update account
                account.refreshToken = authResult.refreshToken;
                account.source = 'oauth';
                if (authResult.projectId) {
                    account.subscription = account.subscription || {};
                    account.subscription.projectId = authResult.projectId;
                }
                
                // Save to disk immediately
                const data = JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf8'));
                const existingIdx = data.accounts.findIndex(a => a.email === account.email);
                if (existingIdx >= 0) {
                    data.accounts[existingIdx].refreshToken = authResult.refreshToken;
                    data.accounts[existingIdx].source = 'oauth';
                    data.accounts[existingIdx].enabled = true;
                    data.accounts[existingIdx].isInvalid = false;
                    data.accounts[existingIdx].invalidReason = null;
                    if (authResult.projectId) {
                        data.accounts[existingIdx].subscription = data.accounts[existingIdx].subscription || {};
                        data.accounts[existingIdx].subscription.projectId = authResult.projectId;
                    }
                } else {
                    data.accounts.push(account);
                }
                writeFileSync(ACCOUNTS_FILE, JSON.stringify(data, null, 2));
                console.log(`✅ Successfully saved and onboarded ${account.email}!`);
                
                // Hot reload the proxy
                try {
                    await fetch("http://127.0.0.1:1987/api/accounts/reload", { method: "POST" });
                    console.log(`🔄 Proxy automatically reloaded with new account.`);
                } catch (e) {
                    console.log(`⚠ Failed to hot-reload proxy. You may need to restart it.`);
                }
                successCount++;
            } else {
                console.log(`❌ No refresh token returned for ${account.email}`);
            }
            
            try {
                if (!page.isClosed()) await page.close();
            } catch (e) {}
            
            // Brief pause between account logins
            await new Promise(r => setTimeout(r, 1500));
            
        } catch (error) {
            console.error(`❌ Failed to authenticate ${account.email}:`, error.message);
            console.log('Waiting 5s before trying next account...');
            await new Promise(r => setTimeout(r, 5000));
        }
    }

    console.log(`\nFinished! Successfully authenticated ${successCount}/${pendingAccounts.length} accounts.`);
    try { await browser.close(); } catch (e) {}
    process.exit(0);
}

autoAuth().catch((err) => {
    console.error(err);
    process.exit(1);
});
