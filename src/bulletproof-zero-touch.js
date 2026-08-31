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
    const script = `osascript -e '
tell application "Google Chrome" to activate
delay 0.1
tell application "System Events"
    key code 53 -- ESCAPE to dismiss Chrome profile popup
end tell'`;
    try { execSync(script); } catch (e) {}
}

async function hardwareType(text) {
    const safeText = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/'/g, "\\'");
    execSync(`python3 -c "import pyautogui; pyautogui.typewrite('${safeText}', interval=0.03)"`);
}

async function hardwarePress(key) {
    execSync(`python3 -c "import pyautogui; pyautogui.press('${key}')"`);
}

async function hardwareClick(page, element) {
    try {
        await element.scrollIntoViewIfNeeded();
        const box = await element.boundingBox();
        if (!box) return false;
        
        // Ensure Chrome is active so clicks hit it
        execSync(`osascript -e 'tell application "Google Chrome" to activate'`);
        await new Promise(r => setTimeout(r, 200));

        const windowMetrics = await page.evaluate(() => {
            return {
                screenX: window.screenX,
                screenY: window.screenY,
                outerHeight: window.outerHeight,
                innerHeight: window.innerHeight
            };
        });
        
        // outerHeight - innerHeight gives toolbar height. screenY is top of window.
        // On Mac, mouse coords are in points, same as DOM coords!
        const absX = windowMetrics.screenX + box.x + (box.width / 2);
        const absY = windowMetrics.screenY + (windowMetrics.outerHeight - windowMetrics.innerHeight) + box.y + (box.height / 2);
        
        execSync(`python3 -c "import pyautogui; pyautogui.moveTo(${absX}, ${absY}, 0.25, pyautogui.easeOutQuad); pyautogui.click()"`);
        return true;
    } catch (e) {
        return false;
    }
}

async function clearField() {
    execSync(`python3 -c "import pyautogui; pyautogui.hotkey('command', 'a'); pyautogui.press('backspace')"`);
    await new Promise(r => setTimeout(r, 100));
}

async function onboardSingleAccount(email) {
    console.log(`\n======================================================`);
    console.log(`🤖 [Zero-Touch Ultimate] Auto-Onboarding: ${email}`);
    console.log(`======================================================`);

    const redirectUri = `http://localhost:${OAUTH_CONFIG.callbackPort}/oauth-callback`;
    const authUrl = getAuthorizationUrl(redirectUri, email);
    const { promise, abort } = startCallbackServer(authUrl.state, 180000);

    const tempDir = `/tmp/ag-zero-touch-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    // Launch with stealth
    const browser = await puppeteerExtra.launch({
        executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        headless: false,
        ignoreDefaultArgs: ['--enable-automation'],
        args: [
            '--force-dark-mode',
            '--window-size=1100,750',
            `--user-data-dir=${tempDir}`,
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-sync', '--test-type',
            '--disable-signin-scoped-device-id',
            '--disable-features=SigninInterceptEnable,DiceWebSigninInterception,EnterpriseProfileCreation,ProfilePickerOnStartup,SigninProfileCreation,ProfileCustomization,Sync'
        ]
    });

    const page = await browser.newPage();
    console.log("Navigating to OAuth...");
    
    // Bring window to front immediately
    execSync(`osascript -e 'tell application "Google Chrome" to activate'`);
    
    await page.goto(authUrl.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    
    // Some profile picker dialogs steal focus, hit Escape just in case
    dismissNativeDialogs();
    console.log("Page loaded!");

    let emailEntered = false;
    let passwordEntered = false;
    let pinEntered = false;

    let finished = false;
    async function visionLoop(page, email) {
        let loopCount = 0;
        while (!finished && loopCount < 30) {
            loopCount++;
            await new Promise(r => setTimeout(r, 2000));
            if (finished) break;
            console.log(`📸 Vision Loop iteration ${loopCount} started...`);
            
            try {
                // Ensure Chrome is active
                execSync(`osascript -e 'tell application "Google Chrome" to activate'`);
                
                // Annotate the DOM
                const elements = await page.evaluate(() => {
                    document.querySelectorAll('.ag-vision-annotation').forEach(el => el.remove());
                    let counter = 1;
                    const elems = [];
                    const interactiveSelectors = 'input:not([type="hidden"]), button, a[role="button"], a[href], [role="button"], [role="link"], [role="checkbox"], div[data-challengetype]';
                    
                    document.querySelectorAll(interactiveSelectors).forEach(el => {
                        const rect = el.getBoundingClientRect();
                        const style = window.getComputedStyle(el);
                        if (rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0' && rect.y >= 0 && rect.x >= 0 && rect.y <= window.innerHeight) {
                            const id = counter++;
                            elems.push({ id, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, width: rect.width, height: rect.height });
                            
                            const box = document.createElement('div');
                            box.className = 'ag-vision-annotation';
                            box.style.position = 'absolute';
                            box.style.left = rect.x + 'px';
                            box.style.top = rect.y + 'px';
                            box.style.width = rect.width + 'px';
                            box.style.height = rect.height + 'px';
                            box.style.border = '2px solid red';
                            box.style.zIndex = '999999';
                            box.style.pointerEvents = 'none';
                            
                            const label = document.createElement('div');
                            label.innerText = id;
                            label.style.position = 'absolute';
                            label.style.left = '0';
                            label.style.top = '0';
                            label.style.background = 'yellow';
                            label.style.color = 'black';
                            label.style.fontSize = '14px';
                            label.style.fontWeight = 'bold';
                            label.style.padding = '2px';
                            label.style.border = '1px solid black';
                            
                            box.appendChild(label);
                            document.body.appendChild(box);
                        }
                    });
                    return elems;
                });
                
                if (elements.length === 0) continue;
                
                // Take screenshot
                const b64 = await page.screenshot({ encoding: 'base64', type: 'jpeg', quality: 60 });
                
                // Clean up annotations immediately
                await page.evaluate(() => document.querySelectorAll('.ag-vision-annotation').forEach(el => el.remove()));
                
                // Call AI Proxy
                const prompt = `You are a zero-touch browser automation agent.
Our goal is to log into a Google Account for email: ${email}
The default password to use if asked is: ${DEFAULT_PASSWORD}

Analyze the screenshot. Interactive elements are outlined in red and numbered in yellow.
Examine what step of the Google OAuth/Login flow we are currently on.

If we need to click a button (like Next, Continue, Agree, I understand, or a challenge option), output:
{ "action": "click", "id": <number> }

If we need to type into a field (like email or password), output:
{ "action": "type", "id": <number>, "text": "<text to type>" }

If we are on a screen asking for a 6-digit verification code sent to apps@, output:
{ "action": "intercept_code", "id": <number> }

If the screen is loading or no action is needed right now, output:
{ "action": "wait" }

Respond ONLY with valid JSON. No markdown formatting.`;

                let apiKey = '';
                try {
                    const s = JSON.parse(readFileSync(join(homedir(), '.config', 'antigravity-proxy', 'settings.json'), 'utf8'));
                    apiKey = s.apiKey || '';
                } catch(e) {}
                
                const headers = { 'Content-Type': 'application/json' };
                if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
                
                const body = {
                    model: 'gemini-3.7-flash-high',
                    max_tokens: 300,
                    messages: [
                        {
                            role: 'user',
                            content: [
                                { type: 'text', text: prompt },
                                { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } }
                            ]
                        }
                    ]
                };
                
                const res = await fetch('http://localhost:1987/v1/messages', {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(body)
                });
                
                const data = await res.json();
                if (!data || !data.content || !data.content[0]) {
                    console.log('No valid response from AI:', data);
                    continue;
                }
                
                const textContent = data.content[0].text || '';
                let command;
                try {
                    const clean = textContent.replace(/```json/g, '').replace(/```/g, '').trim();
                    command = JSON.parse(clean);
                } catch (e) {
                    console.log(`Failed to parse AI response: ${textContent}`);
                    continue;
                }
                
                console.log(`🤖 AI Vision Decision:`, command);
                
                if (command.action === 'wait') continue;
                
                if (command.id) {
                    const target = elements.find(e => e.id === command.id);
                    if (target) {
                        const windowMetrics = await page.evaluate(() => {
                            return { screenX: window.screenX, screenY: window.screenY, outerHeight: window.outerHeight, innerHeight: window.innerHeight };
                        });
                        
                        const absX = windowMetrics.screenX + target.x;
                        const absY = windowMetrics.screenY + (windowMetrics.outerHeight - windowMetrics.innerHeight) + target.y;
                        
                        if (command.action === 'click') {
                            execSync(`python3 -c "import pyautogui; pyautogui.moveTo(${absX}, ${absY}, 0.25, pyautogui.easeOutQuad); pyautogui.click()"`);
                        } else if (command.action === 'type') {
                            execSync(`python3 -c "import pyautogui; pyautogui.moveTo(${absX}, ${absY}, 0.25, pyautogui.easeOutQuad); pyautogui.click()"`);
                            await new Promise(r => setTimeout(r, 400));
                            execSync(`python3 -c "import pyautogui; pyautogui.hotkey('command', 'a'); pyautogui.press('backspace')"`);
                            await new Promise(r => setTimeout(r, 100));
                            
                            const safeText = command.text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/'/g, "\\'");
                            execSync(`python3 -c "import pyautogui; pyautogui.typewrite('${safeText}', interval=0.03); pyautogui.press('enter')"`);
                        } else if (command.action === 'intercept_code') {
                            console.log(`📡 AI detected Pin input! Intercepting 6-digit code...`);
                            try {
                                const out = execSync(`python3 ss/recovery_listener.py "${email}" 25`, { cwd: '/Users/test/Projects/solidstack' }).toString();
                                const jsonMatch = out.match(/\{[\s\S]*\}/);
                                if (jsonMatch) {
                                    const parsed = JSON.parse(jsonMatch[0]);
                                    if (parsed.status === 'ok' && parsed.code) {
                                        console.log(`🔑 Intercepted recovery code: ${parsed.code}!`);
                                        execSync(`python3 -c "import pyautogui; pyautogui.moveTo(${absX}, ${absY}, 0.2, pyautogui.easeOutQuad); pyautogui.click()"`);
                                        await new Promise(r => setTimeout(r, 400));
                                        execSync(`python3 -c "import pyautogui; pyautogui.typewrite('${parsed.code}', interval=0.03); pyautogui.press('enter')"`);
                                    }
                                }
                            } catch (recErr) {
                                console.error('Recovery code listener error:', recErr.message);
                            }
                        }
                    }
                }
            } catch (err) {
                console.error('Vision loop error:', err.message);
            }
        }
    }
    
    visionLoop(page, email);

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
