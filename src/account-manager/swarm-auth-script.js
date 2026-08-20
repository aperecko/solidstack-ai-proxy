import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import puppeteer from 'puppeteer-core';
import { getAuthorizationUrl, startCallbackServer, exchangeCode } from '../auth/oauth.js';

const ACCOUNTS_FILE = join(homedir(), '.config', 'antigravity-proxy', 'accounts.json');
const BACKUP_FILE = join(homedir(), '.config', 'antigravity-proxy', 'accounts.json.bak');

// Check if a default password is provided
const DEFAULT_PASSWORD = process.env.DEFAULT_PASSWORD || '';

async function autoAuth() {
    const backupData = JSON.parse(readFileSync(BACKUP_FILE, 'utf8'));
    
    // Find all accounts that need auth (missing refreshToken or explicitly PENDING_AUTH)
    const pendingAccounts = backupData.accounts.filter(a => 
        !a.refreshToken || a.refreshToken === 'PENDING_AUTH'
    ).slice(0, 1); // Limit to 1 account for testing
    
    if (pendingAccounts.length === 0) {
        console.log("No swarm accounts pending authentication.");
        return;
    }
    
    console.log(`Found ${pendingAccounts.length} accounts needing OAuth approval.`);
    console.log('Launching browser...');
    
    // Launch user's Chrome so it doesn't get blocked as easily
    const browser = await puppeteer.launch({
        executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        headless: 'new',
        defaultViewport: null, // full screen
        args: ['--window-size=1200,800', '--disable-blink-features=AutomationControlled']
    });

    let successCount = 0;

    for (let i = 0; i < pendingAccounts.length; i++) {
        const account = pendingAccounts[i];
        console.log(`\n[${i+1}/${pendingAccounts.length}] Authenticating ${account.email}...`);
        
        try {
            // Setup callback server
            const { url, verifier, state } = getAuthorizationUrl();
            const { promise, abort, getPort } = startCallbackServer(state);
            const redirectUri = `http://localhost:${getPort()}/oauth-callback`;
            
            // Re-generate URL with actual port
            const authUrl = getAuthorizationUrl(redirectUri);

            const page = await browser.newPage();
            
            // Navigate to Google OAuth
            console.log(`Navigating to Google OAuth...`);
            await page.goto(authUrl.url, { waitUntil: 'networkidle2' });
            
            // Auto-fill email
            let emailFilled = false;
            try {
                const emailSelector = 'input[type="email"], input[name="identifier"]';
                await page.waitForSelector(emailSelector, { timeout: 10000 });
                await page.type(emailSelector, account.email);
                await page.keyboard.press('Enter');
                console.log(`Entered email.`);
                emailFilled = true;
            } catch (e) {
                console.log(`Could not auto-fill email, please proceed manually.`);
            }

            // Auto-fill password if provided
            if (DEFAULT_PASSWORD && emailFilled) {
                try {
                    const passSelector = 'input[type="password"], input[name="Passwd"]';
                    await page.waitForSelector(passSelector, { timeout: 10000 });
                    // Small delay to mimic human
                    await new Promise(r => setTimeout(r, 1000));
                    await page.type(passSelector, DEFAULT_PASSWORD);
                    await page.keyboard.press('Enter');
                    console.log(`Entered password.`);
                } catch (e) {
                    console.log(`Could not auto-fill password, please proceed manually.`);
                }
            } else {
                console.log(`Please enter password and click Allow in the browser window.`);
            }

            // Start an auto-clicker loop in the background while waiting for the promise
            const clickInterval = setInterval(async () => {
                try {
                    await page.evaluate(() => {
                        const buttons = Array.from(document.querySelectorAll('button, span, div[role="button"]'));
                        const target = buttons.find(b => {
                            const text = b.textContent.trim();
                            return text === 'Continue' || text === 'Allow' || text === 'I agree' || text === 'I understand' || text === 'Accept' || text === 'Confirm';
                        });
                        if (target) {
                            target.click();
                        }
                    });
                } catch (e) {
                    // Page closed or navigated away
                }
                try {
                    await page.screenshot({ path: '/Users/test/.gemini/antigravity/brain/b30dd243-fbd9-4053-9ae5-77a0d02ea3ca/scratch/screenshot.png' });
                } catch (e) {}
            }, 1000);

            // Wait for the callback server to receive the code
            console.log(`Waiting for consent approval (Auto-clicking enabled)...`);
            const code = await promise;
            clearInterval(clickInterval);
            console.log(`Got OAuth code! Exchanging for tokens...`);
            const tokens = await exchangeCode(code, verifier || authUrl.verifier);
            
            if (tokens.refreshToken) {
                // Update account
                account.refreshToken = tokens.refreshToken;
                account.source = 'oauth';
                
                // Save to disk immediately by pulling latest and appending
                const data = JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf8'));
                if (!data.accounts.find(a => a.email === account.email)) {
                    data.accounts.push(account);
                    writeFileSync(ACCOUNTS_FILE, JSON.stringify(data, null, 2));
                    console.log(`✅ Saved refresh token for ${account.email}!`);
                    
                    // Hot reload the proxy
                    try {
                        await fetch("http://127.0.0.1:1987/api/accounts/reload", { method: "POST" });
                        console.log(`🔄 Proxy automatically reloaded with new account.`);
                    } catch (e) {
                        console.log(`⚠ Failed to hot-reload proxy. You may need to restart it.`);
                    }
                }
                successCount++;
            } else {
                console.log(`❌ No refresh token returned for ${account.email}`);
            }
            
            await page.close();
            
            // Small pause between accounts to avoid aggressive rate limiting by Google's login servers
            await new Promise(r => setTimeout(r, 2000));
            
        } catch (error) {
            console.error(`❌ Failed to authenticate ${account.email}:`, error);
            // Close page on error and continue to next
            const pages = await browser.pages();
            if (pages.length > 1) await pages[pages.length - 1].close();
            
            console.log('Waiting 5s before trying next account...');
            await new Promise(r => setTimeout(r, 5000));
        }
    }

    console.log(`\nFinished! Successfully authenticated ${successCount}/${pendingAccounts.length} accounts.`);
    await browser.close();
}

autoAuth().catch(console.error);
