import fs, { readFileSync, writeFileSync } from 'fs';
import http from 'http';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import puppeteer from 'puppeteer-core';
import { SocksClient } from 'socks';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { getAuthorizationUrl, startCallbackServer, completeOAuthFlow } from '../auth/oauth.js';
import { withFileLock } from './storage.js';
import { OAUTH_CONFIG } from '../constants.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const OMNI_SYNC_SCRIPT = join(__dirname, 'omniroute_sync.py');
const DIAGNOSTIC_SCRIPT = join(__dirname, 'account_api_diagnostic.py');

const ACCOUNTS_FILE = join(homedir(), '.config', 'antigravity-proxy', 'accounts.json');
const BACKUP_FILE = join(homedir(), '.config', 'antigravity-proxy', 'accounts.json.bak');
const VAULT_FILE = join(homedir(), '.config', 'antigravity-proxy', 'swarm-recovery-vault.json');

// SOCKS5 Mesh Configuration
const SOCKS_USER = process.env.PRIVADO_SOCKS_USER || 'nhrekww83362';
const SOCKS_PASS = process.env.PRIVADO_SOCKS_PASS || 'jgu4y8kedp6w';
const MESH_FALLBACK_NODES = [
    'dfw.socks.privado.io', // Dallas
    'dtw.socks.privado.io', // Detroit
    'atl.socks.privado.io', // Atlanta
    'stl.socks.privado.io', // St. Louis
    'sjc.socks.privado.io', // San Jose
    'sfo.socks.privado.io', // San Francisco
    'pdx.socks.privado.io', // Portland
    'sea.socks.privado.io', // Seattle
    'lax.socks.privado.io', // Los Angeles
    'ord.socks.privado.io', // Chicago
    'mia.socks.privado.io', // Miami
    'ewr.socks.privado.io', // New Jersey
    'bos.socks.privado.io', // Boston
    'iad.socks.privado.io', // Washington DC
    'phx.socks.privado.io', // Phoenix
    'den.socks.privado.io', // Denver
    'tor.socks.privado.io', // Toronto
    'mon.socks.privado.io', // Montreal
    'van.socks.privado.io'  // Vancouver
];

const verifiedNodeCache = new Map();
const nodeCooldowns = new Map(); // host -> timestamp when cooldown ends
const activeLeasedNodes = new Set(); // SOCKS nodes currently leased by parallel workers
let isGlobalHumanInterventionActive = false; // Prevents workers from stealing focus during human support

async function resolveHealthyNode(preferredNode, excludeHosts = []) {
    if (!preferredNode || preferredNode === 'local') return 'local';
    
    // Combine explicit excluded hosts with active leased nodes from other concurrent workers
    const effectiveExclude = [...new Set([...excludeHosts, ...Array.from(activeLeasedNodes)])];

    // Check if cached node is still valid and not in cooldown
    const now = Date.now();
    if (verifiedNodeCache.has(preferredNode)) {
        const cached = verifiedNodeCache.get(preferredNode);
        if (!effectiveExclude.includes(cached) && (!nodeCooldowns.has(cached) || now > nodeCooldowns.get(cached))) {
            return cached;
        }
        verifiedNodeCache.delete(preferredNode);
    }

    // Filter available candidates not in cooldown or exclusion list
    const candidates = [preferredNode, ...MESH_FALLBACK_NODES.filter(n => n !== preferredNode)]
        .filter(host => !effectiveExclude.includes(host) && (!nodeCooldowns.has(host) || now > nodeCooldowns.get(host)));

    if (candidates.length === 0) {
        console.warn(`[SOCKS Mesh] All SOCKS nodes in cooldown/excluded. Resetting cooldowns.`);
        nodeCooldowns.clear();
        candidates.push(...MESH_FALLBACK_NODES);
    }

    const checkNode = (host) => new Promise(async (resolve, reject) => {
        try {
            const info = await Promise.race([
                SocksClient.createConnection({
                    proxy: { host, port: 1080, type: 5, userId: SOCKS_USER, password: SOCKS_PASS },
                    command: 'connect',
                    destination: { host: '1.1.1.1', port: 80 }
                }),
                new Promise((_, rejectTimeout) => setTimeout(() => rejectTimeout(new Error('timeout')), 600))
            ]);
            info.socket.destroy();
            resolve(host);
        } catch (e) {
            reject(e);
        }
    });

    try {
        const fastestHost = await Promise.any(candidates.map(checkNode));
        verifiedNodeCache.set(preferredNode, fastestHost);
        if (fastestHost !== preferredNode) {
            console.log(`[SOCKS Mesh] Preferred node ${preferredNode} -> rotated to healthy ${fastestHost}`);
        }
        return fastestHost;
    } catch (e) {
        console.warn(`[SOCKS Mesh] Warning: No healthy SOCKS nodes reachable for ${preferredNode}, falling back to local.`);
        return 'local';
    }
}

function createEphemeralSocksBridge(egressHost) {
    return new Promise((resolve, reject) => {
        const bridge = http.createServer((req, res) => {
            res.writeHead(502);
            res.end();
        });

        bridge.on('connect', async (req, clientSocket, head) => {
            const [targetHost, targetPort] = req.url.split(':');
            try {
                const info = await SocksClient.createConnection({
                    proxy: {
                        host: egressHost,
                        port: 1080,
                        type: 5,
                        userId: SOCKS_USER,
                        password: SOCKS_PASS
                    },
                    command: 'connect',
                    destination: {
                        host: targetHost,
                        port: parseInt(targetPort) || 443
                    }
                });

                clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
                if (head && head.length) info.socket.write(head);
                info.socket.pipe(clientSocket);
                clientSocket.pipe(info.socket);

                info.socket.on('error', () => clientSocket.destroy());
                clientSocket.on('error', () => info.socket.destroy());
            } catch (err) {
                clientSocket.destroy();
            }
        });

        bridge.listen(0, '127.0.0.1', () => {
            const port = bridge.address().port;
            resolve({
                port,
                close: () => new Promise(res => {
                    try { bridge.closeAllConnections(); } catch (e) {}
                    bridge.close(() => res());
                    setTimeout(res, 1000);
                })
            });
        });

        bridge.on('error', reject);
    });
}

// Check if a default password or target email is provided
const DEFAULT_PASSWORD = process.env.DEFAULT_PASSWORD || 'Swarmd6f9b714!!2026';
const TARGET_EMAIL = process.env.TARGET_EMAIL || '';
const RECOVERY_EMAIL = process.env.RECOVERY_EMAIL || 'apps@reseller.mysolidstate.ca';

const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '50', 10);
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '1', 10);
const TARGET_DOMAIN = process.env.DOMAIN || '';
const DEBUG_SCREENSHOT = process.env.DEBUG_SCREENSHOTS === 'true'
    ? (process.env.DEBUG_SCREENSHOT_PATH || '/tmp/ag-swarm-login-debug.png')
    : null;

async function autoAuth() {
    const configData = JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf8'));
    
    let pendingAccounts = [];

    if (TARGET_EMAIL) {
        const matched = configData.accounts.find(a => a.email === TARGET_EMAIL);
        pendingAccounts = [matched || { email: TARGET_EMAIL }];
    } else {
        pendingAccounts = configData.accounts.filter(a => {
            const domainMatch = TARGET_DOMAIN ? a.email.includes(TARGET_DOMAIN) : (a.email.includes('@reseller.mysolidstate.ca') || a.email.includes('@adamassist.com'));
            const isNotAdmin = !a.email.startsWith('apps@') && !a.email.startsWith('adam@');
            const allowRetryInvalid = process.env.RETRY_INVALID === 'true';
            const needsAuth = !a.isSuspended && (!a.refreshToken || a.refreshToken === 'PENDING_AUTH' || a.source === 'service_account') && (!a.isInvalid || allowRetryInvalid);
            return domainMatch && isNotAdmin && needsAuth;
        }).slice(0, BATCH_SIZE);
    }
    
    if (pendingAccounts.length === 0) {
        console.log("No accounts pending OAuth authentication.");
        return;
    }
    
    console.log(`Found ${pendingAccounts.length} accounts to authenticate.`);

    // Attach to the SolidStack Chrome fleet (Chrome_Automation on :9222).
    // If not currently running, launch Chrome automatically.
    try {
        await fetch('http://localhost:9222/json/version', { signal: AbortSignal.timeout(2000) });
    } catch {
        console.log('[Harvester] Chrome daemon on :9222 not reachable. Launching Chrome...');
        try {
            execSync('/Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9222 --user-data-dir="/Users/test/Library/Application Support/Google/Chrome_Automation" >/dev/null 2>&1 &');
            await new Promise(r => setTimeout(r, 2500));
        } catch (e) {
            console.error('[Harvester] Failed to launch Chrome:', e.message);
            return;
        }
    }

    const browser = await puppeteer.connect({
        browserURL: 'http://localhost:9222',
        defaultViewport: null
    });

    let successCount = 0;
    let queueIndex = 0;
    const actualConcurrency = Math.min(CONCURRENCY, pendingAccounts.length);
    console.log(`🚀 Launching ${actualConcurrency} concurrent harvester slots (side-by-side control)...`);

    async function runSlot(slotId) {
        while (queueIndex < pendingAccounts.length) {
            const i = queueIndex++;
            if (i >= pendingAccounts.length) break;
            const account = pendingAccounts[i];
            console.log(`\n[Slot ${slotId + 1}/${actualConcurrency}] [${i+1}/${pendingAccounts.length}] Authenticating ${account.email}...`);
        
        let preferredNode = account.corporateFootprint?.egressNode;
        if (!preferredNode && !account.email.startsWith('adam@') && !account.email.startsWith('adamperecko@')) {
            preferredNode = account.email.includes('@adamassist.com') ? 'dtw.socks.privado.io' : 'dfw.socks.privado.io';
            account.corporateFootprint = account.corporateFootprint || { role: 'General Swarm', region: 'Mesh', egressNode: preferredNode };
        }

        const excludedNodesForAccount = [];
        const MAX_CAPTCHA_RETRIES = 2;
        let captchaAttempts = 0;
        let authCompleted = false;

        while (!authCompleted && captchaAttempts <= MAX_CAPTCHA_RETRIES) {
            let bridge = null;
            let context = null;
            let page = null;
            let clickInterval = null;
            let cancelFlow = null;
            const cancelPromise = new Promise((_, reject) => { cancelFlow = reject; });
            let abortServer = null;
            let healthyNode = null;
            let isWaitingForHuman = false;

            // Pre-flight: verify Chrome CDP is reachable before attempting this account.
            // Avoids crashing the entire batch when the daemon temporarily drops.
            try {
                await fetch('http://localhost:9222/json/version', { signal: AbortSignal.timeout(2000) });
            } catch {
                console.warn(`[Harvester] Chrome CDP not reachable — pausing 5s for daemon recovery before retrying ${account.email}...`);
                await new Promise(r => setTimeout(r, 5000));
                continue;
            }

            try {
                // Setup callback server (120s timeout per account)
                const redirectUri = `http://localhost:${OAUTH_CONFIG.callbackPort}/oauth-callback`;
                // Pass account.email as loginHint to bypass Google email screen and directly initiate SAML SSO
                const authUrl = getAuthorizationUrl(redirectUri, account.email);
                const { promise, abort } = startCallbackServer(authUrl.state, 420000);
                abortServer = abort;

                // Dynamic SOCKS routing
                healthyNode = await resolveHealthyNode(preferredNode, excludedNodesForAccount);
                let socksAgent = null;

                const contextOptions = {};
                if (healthyNode && healthyNode !== 'local') {
                    activeLeasedNodes.add(healthyNode);
                    bridge = await createEphemeralSocksBridge(healthyNode);
                    contextOptions.proxyServer = `http://127.0.0.1:${bridge.port}`;
                    socksAgent = new SocksProxyAgent(`socks5h://${SOCKS_USER}:${SOCKS_PASS}@${healthyNode}:1080`);
                    console.log(`[SOCKS Mesh Slot ${slotId + 1}] Routing ${account.email} through ${healthyNode} (bridge :${bridge.port})...`);
                } else {
                    console.log(`[SOCKS Mesh Slot ${slotId + 1}] Routing ${account.email} through direct local egress...`);
                }

                // Fresh incognito context per account with isolated proxy
                context = await browser.createBrowserContext(contextOptions);
                page = await context.newPage();
                try { await context.clearCookies(); } catch (e) {}

                // Tile browser windows side-by-side for concurrent monitoring
                try {
                    const session = await page.createCDPSession();
                    const { windowId } = await session.send('Browser.getWindowForTarget');
                    if (windowId && actualConcurrency > 1) {
                        const screenWidth = 1440;
                        const slotWidth = Math.floor(screenWidth / actualConcurrency);
                        await session.send('Browser.setWindowBounds', {
                            windowId,
                            bounds: {
                                left: slotId * slotWidth,
                                top: 0,
                                width: slotWidth,
                                height: 900,
                                windowState: 'normal'
                            }
                        });
                    }
                } catch (e) {}

                // Fast navigation to Google OAuth
                console.log(`[Slot ${slotId + 1}] Navigating to Google OAuth for ${account.email}...`);
                await page.goto(authUrl.url, { waitUntil: 'domcontentloaded', timeout: 30000 });

                // Instant Next trigger: If Google identifier has login_hint pre-filled, click Next immediately
                try {
                    await page.evaluate(() => {
                        const allBtns = Array.from(document.querySelectorAll('button, div[role="button"]'));
                        const nextBtn = allBtns.find(b => (b.innerText || '').trim() === 'Next' && b.offsetWidth > 0);
                        if (nextBtn) nextBtn.click();
                    });
                } catch (e) {}

                // Start an auto-clicker and auto-filler loop in the background while waiting for OAuth completion
                // Responsive state machine: runs every 80ms with 100ms min cooldown between actions
                let isActionInFlight = false;
                let lastActionTime = 0;
                let consentClicked = false; // Suppress repeat consent clicks after first successful click
                let humanWaitStartTime = 0;
                let lastHumanWaitLog = 0;
                let currentChallengeType = null;

                clickInterval = setInterval(async () => {
                    if (isActionInFlight) return;

                    // Handle interactive human support pause
                    if (isWaitingForHuman) {
                        isActionInFlight = true;
                        try {
                            const check = await page.evaluate(() => {
                                const bodyText = document.body.innerText || '';
                                const url = window.location.href;
                                const isVisible = (el, minWidth = 0) => el && el.offsetParent !== null && el.offsetWidth > minWidth;

                                const captchaImg = document.querySelector('#captchaimg');
                                const captchaInput = document.querySelector('input[name="ca"]');
                                const recaptchaFrame = document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"]');

                                const hasVisibleCaptchaInput = isVisible(captchaImg) || isVisible(captchaInput) || (recaptchaFrame && isVisible(recaptchaFrame));
                                const hasCaptchaText = bodyText.includes('Type the text you hear or see') ||
                                                      bodyText.includes('To continue, please solve the challenge') ||
                                                      bodyText.includes('unusual traffic from your computer network') ||
                                                      bodyText.includes('Our systems have detected unusual traffic');

                                const isPhoneVerification = (bodyText.includes('Verify it’s you') || bodyText.includes("Verify it's you")) &&
                                                            (bodyText.includes('Enter a phone number') || bodyText.includes('Get a verification code') || isVisible(document.querySelector('input[type="tel"]')));

                                const challengeStillPresent = hasVisibleCaptchaInput || hasCaptchaText || isPhoneVerification;
                                const navigatedAway = url.includes('workspacetermsofservice') ||
                                                      url.includes('signin/oauth/consent') ||
                                                      url.includes('oauth-callback') ||
                                                      url.includes('login.microsoftonline.com') ||
                                                      bodyText.includes('Welcome to your new account') ||
                                                      bodyText.includes('wants to access your Google Account');

                                return {
                                    isCleared: !challengeStillPresent || navigatedAway,
                                    url
                                };
                            });

                            if (check && check.isCleared) {
                                if (isWaitingForHuman) {
                                    console.log(`\n=============================================================`);
                                    console.log(`✅ [HUMAN SUPPORT] Challenge resolved for ${account.email}! Resuming automated onboarding...`);
                                    console.log(`=============================================================\n`);
                                    try {
                                        execSync('afplay /System/Library/Sounds/Hero.aiff &', { stdio: 'ignore' });
                                    } catch (e) {}
                                    isWaitingForHuman = false;
                                    isGlobalHumanInterventionActive = false;
                                    currentChallengeType = null;
                                    lastActionTime = Date.now() + 1500; // 1.5s grace period for navigation transition
                                }
                                return;
                            }

                            const elapsedMs = Date.now() - humanWaitStartTime;
                            const MAX_HUMAN_WAIT_MS = 300000; // 5 minutes timeout
                            if (Date.now() - lastHumanWaitLog >= 15000) {
                                lastHumanWaitLog = Date.now();
                                const remainingSec = Math.max(0, Math.round((MAX_HUMAN_WAIT_MS - elapsedMs) / 1000));
                                console.log(`⏳ [HUMAN SUPPORT] Waiting for operator resolution on ${account.email} (${Math.round(elapsedMs / 1000)}s elapsed, ${remainingSec}s remaining)...`);
                            }

                            if (elapsedMs > MAX_HUMAN_WAIT_MS) {
                                console.error(`🚨 [HUMAN SUPPORT] Timed out waiting for human operator after 300s on ${account.email}.`);
                                isWaitingForHuman = false;
                                cancelFlow(new Error(`CAPTCHA_CHALLENGE:${healthyNode}:${currentChallengeType || 'captcha'}`));
                                return;
                            }
                        } catch (e) {
                            // Page might be actively navigating
                        } finally {
                            isActionInFlight = false;
                        }
                        return;
                    }

                    if (Date.now() - lastActionTime < 100) return;

                    try {
                        isActionInFlight = true;

                        // Execute unified DOM fast-path check & direct action
                        const result = await page.evaluate((email, password, consentAlreadyClicked) => {
                            const bodyText = document.body.innerText || '';
                            const url = window.location.href;

                            // Helper: True DOM visibility check
                            const isVisible = (el, minWidth = 0) => el && el.offsetParent !== null && el.offsetWidth > minWidth;

                            // 0. CAPTCHA / Bot Challenge / Phone Challenge Detection (Only if TRULY visible!)
                            const captchaImg = document.querySelector('#captchaimg');
                            const captchaInput = document.querySelector('input[name="ca"]');
                            const recaptchaFrame = document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"]');
                            
                            const hasVisibleCaptchaInput = isVisible(captchaImg) || isVisible(captchaInput) || (recaptchaFrame && isVisible(recaptchaFrame));
                            const hasCaptchaText = bodyText.includes('Type the text you hear or see') ||
                                                  bodyText.includes('To continue, please solve the challenge') ||
                                                  bodyText.includes('unusual traffic from your computer network') ||
                                                  bodyText.includes('Our systems have detected unusual traffic');

                            const isCaptcha = hasVisibleCaptchaInput || hasCaptchaText;
                            const isPhoneVerification = (bodyText.includes('Verify it’s you') || bodyText.includes("Verify it's you")) &&
                                                        (bodyText.includes('Enter a phone number') || bodyText.includes('Get a verification code') || isVisible(document.querySelector('input[type="tel"]')));

                            if (isCaptcha || isPhoneVerification) {
                                return { action: 'captcha_challenge', type: isPhoneVerification ? 'phone_verification' : 'captcha' };
                            }

                            // 1. Google Workspace Terms Speedbump ("Welcome to your new account")
                            const isSpeedbump = url.includes('workspacetermsofservice') ||
                                                bodyText.includes('Welcome to your new account');
                            if (isSpeedbump) {
                                // Scroll all scrollable elements
                                const scrollables = Array.from(document.querySelectorAll('*')).filter(el => {
                                    const style = window.getComputedStyle(el);
                                    return (style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight;
                                });
                                for (const s of scrollables) {
                                    s.scrollTop = s.scrollHeight;
                                    s.dispatchEvent(new Event('scroll'));
                                }
                                window.scrollTo(0, document.body.scrollHeight);

                                const scrollBtn = document.querySelector('[aria-label="Scroll down"]');
                                if (scrollBtn) scrollBtn.click();

                                const btns = Array.from(document.querySelectorAll('button'));
                                const understandBtn = btns.find(b => (b.innerText || '').includes('I understand'));
                                if (understandBtn) {
                                    understandBtn.removeAttribute('disabled');
                                    understandBtn.focus();
                                    understandBtn.click();
                                    understandBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                                    return { action: 'speedbump_agreed' };
                                }
                            }

                            // 2. Google OAuth Consent Screen ("Make sure that you downloaded this app from Google" / "Sign in")
                            // Skip if we already successfully clicked consent — avoids repeat CDP roundtrips.
                            if (!consentAlreadyClicked) {
                                const isConsent = bodyText.includes('Make sure that you downloaded this app') ||
                                                  bodyText.includes('Don’t sign in to Google Antigravity unless') ||
                                                  (url.includes('/signin/oauth') && url.includes('/consent'));
                                if (isConsent) {
                                    const btns = Array.from(document.querySelectorAll('button, div[role="button"]'));
                                    const signinBtn = btns.find(b => (b.innerText || '').trim() === 'Sign in' && b.offsetWidth > 0);
                                    if (signinBtn) {
                                        signinBtn.focus();
                                        signinBtn.click();
                                        signinBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                                        return { action: 'consent_signed_in' };
                                    }
                                    const allowBtn = btns.find(b => {
                                        const t = (b.innerText || '').trim();
                                        return (t === 'Allow' || t === 'Continue') && b.offsetWidth > 0;
                                    });
                                    if (allowBtn) {
                                        allowBtn.focus();
                                        allowBtn.click();
                                        allowBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                                        return { action: 'consent_allowed' };
                                    }
                                }
                            }



                            // 3. Google "Something went wrong" / "unknownerror" / "rejected" recovery screen
                            const isSomethingWentWrong = url.includes('unknownerror') ||
                                                         url.includes('rejected') ||
                                                         bodyText.includes('Something went wrong') ||
                                                         bodyText.includes('Sorry, something went wrong') ||
                                                         bodyText.includes('Try again');
                            if (isSomethingWentWrong && !url.includes('login.microsoftonline.com')) {
                                const allBtns = Array.from(document.querySelectorAll('button, div[role="button"], a[role="button"]'));
                                const retryBtn = allBtns.find(b => {
                                    const t = (b.innerText || b.value || '').trim().toLowerCase();
                                    return (t === 'next' || t === 'try again' || t === 'retry') && b.offsetWidth > 0;
                                });
                                if (retryBtn) {
                                    retryBtn.focus();
                                    retryBtn.click();
                                    retryBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                                    return { action: 'retry_something_went_wrong' };
                                }
                            }

                            // 4. Google Generic "Next" Screen (Identifier, Confirmation, Continue)
                            if (!url.includes('login.microsoftonline.com')) {
                                const allBtns = Array.from(document.querySelectorAll('button, div[role="button"]'));
                                const nextBtn = allBtns.find(b => (b.innerText || '').trim() === 'Next' && isVisible(b));
                                if (nextBtn) {
                                    const googleEmail = document.querySelector('#identifierId, input[name="identifier"]');
                                    if (googleEmail && isVisible(googleEmail) && !googleEmail.value) {
                                        googleEmail.focus();
                                        googleEmail.value = email;
                                        googleEmail.dispatchEvent(new Event('input', { bubbles: true }));
                                        googleEmail.dispatchEvent(new Event('change', { bubbles: true }));
                                    }
                                    nextBtn.focus();
                                    nextBtn.click();
                                    nextBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                                    return { action: 'google_next' };
                                }
                            }

                            // 4. Microsoft Email Input (loginfmt) — Check FIRST before password!
                            const msEmailInput = document.querySelector('input[name="loginfmt"]');
                            if (msEmailInput && isVisible(msEmailInput)) {
                                if (!msEmailInput.value || msEmailInput.value !== email) {
                                    msEmailInput.focus();
                                    msEmailInput.value = email;
                                    msEmailInput.dispatchEvent(new Event('input', { bubbles: true }));
                                    msEmailInput.dispatchEvent(new Event('change', { bubbles: true }));
                                }
                                if (msEmailInput.value) {
                                    const submitBtn = document.querySelector('input#idSIButton9, input[type="submit"]');
                                    if (submitBtn) {
                                        submitBtn.click();
                                        return { action: 'ms_email_submitted' };
                                    }
                                }
                            }

                            // 5. Microsoft / Google Password Input — Only if truly visible!
                            const passInput = document.querySelector('input[name="passwd"], input[name="Passwd"], input[type="password"]');
                            if (passInput && isVisible(passInput) && password) {
                                if (!passInput.value) {
                                    passInput.focus();
                                    passInput.value = password;
                                    passInput.dispatchEvent(new Event('input', { bubbles: true }));
                                    passInput.dispatchEvent(new Event('change', { bubbles: true }));
                                }
                                if (passInput.value) {
                                    const nextBtn = document.querySelector('input#idSIButton9, #passwordNext button, button[type="submit"], input[type="submit"]');
                                    if (nextBtn) {
                                        nextBtn.click();
                                        return { action: 'password_submitted' };
                                    } else {
                                        const form = passInput.closest('form');
                                        if (form && form.requestSubmit) form.requestSubmit();
                                        return { action: 'password_submitted' };
                                    }
                                }
                            }

                            // 6. Microsoft "Stay signed in?" (KMSI) / "Yes" prompt
                            if (!isVisible(passInput) && !isVisible(msEmailInput)) {
                                const isKmsi = bodyText.includes('Stay signed in?') || document.querySelector('#kmsiTitle') !== null;
                                const msButtonYes = document.querySelector('input[id="idSIButton9"][value="Yes"], input[value="Yes"]');
                                if (msButtonYes && (msButtonYes.offsetWidth > 0 || msButtonYes.offsetParent !== null)) {
                                    msButtonYes.click();
                                    return { action: 'ms_stay_signed_in' };
                                }
                                if (isKmsi) {
                                    const btnSI = document.querySelector('input#idSIButton9, button#idSIButton9');
                                    if (btnSI && isVisible(btnSI)) {
                                        btnSI.click();
                                        return { action: 'ms_stay_signed_in' };
                                    }
                                }
                            }

                            // 6. Microsoft "Pick an account" tile
                            const accountTile = document.querySelector('div.table-row, div.tile-container, div.row.tile');
                            if (accountTile && (accountTile.innerText || '').includes(email)) {
                                accountTile.click();
                                return { action: 'ms_account_picked' };
                            }

                            // 7. Check for Microsoft MFA requirement
                            const mfaNext = document.querySelector('#idSubmit_ProofUp_Redirect');
                            if (mfaNext && mfaNext.offsetWidth > 0) {
                                return { action: 'mfa_required' };
                            }

                            // 8. Check for Microsoft username error
                            const msError = document.querySelector('#usernameError, #passwordError');
                            if (msError && msError.offsetWidth > 0 && msError.innerText) {
                                return { action: 'ms_error', error: msError.innerText };
                            }

                            // 9. Generic Fallback Consent ("Accept", "Allow", "Continue", "Agree", "Confirm")
                            const genericLabels = ['Accept', 'Allow', 'Continue', 'Agree', 'Confirm'];
                            const allButtons = Array.from(document.querySelectorAll('button, [role="button"], input[type="button"]'));
                            for (const label of genericLabels) {
                                const btn = allButtons.find(b => (b.innerText || b.getAttribute('aria-label') || '').trim().toLowerCase() === label.toLowerCase() && b.offsetWidth > 0);
                                if (btn) {
                                    btn.focus();
                                    btn.click();
                                    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                                    return { action: 'generic_consent', label };
                                }
                            }

                            return null;
                        }, account.email, DEFAULT_PASSWORD, consentClicked);

                        if (result) {
                            lastActionTime = Date.now();
                            if (result.action === 'captcha_challenge') {
                                if (!isWaitingForHuman) {
                                    const desc = result.type === 'phone_verification' ? 'Phone/SMS verification required' : 'Anti-bot CAPTCHA challenge';
                                    console.warn(`\n=============================================================`);
                                    console.warn(`🚨 [HUMAN SUPPORT REQUIRED] ${desc} detected on ${account.email}!`);
                                    console.warn(`👉 Chrome has been brought to the foreground. Please solve the challenge.`);
                                    console.warn(`⏳ Automation is PAUSED for up to 5 minutes waiting for operator resolution...`);
                                    console.warn(`=============================================================\n`);

                                    isWaitingForHuman = true;
                                    isGlobalHumanInterventionActive = true;
                                    currentChallengeType = result.type || 'captcha';
                                    humanWaitStartTime = Date.now();
                                    lastHumanWaitLog = Date.now();

                                    // Bring page and Chrome app to the front
                                    try {
                                        await page.bringToFront();
                                        await page.evaluate(() => window.focus());
                                    } catch (e) {}
                                    try {
                                        execSync('osascript -e \'tell application "Google Chrome" to activate\'', { stdio: 'ignore' });
                                    } catch (e) {}

                                    // Audio & visual notifications
                                    try {
                                        execSync('afplay /System/Library/Sounds/Ping.aiff &', { stdio: 'ignore' });
                                        execSync(`osascript -e 'display notification "${desc} on ${account.email}! Please solve in Chrome." with title "SolidStack Human Support" sound name "Submarine"' &`, { stdio: 'ignore' });
                                    } catch (e) {}
                                }

                                return;
                            } else if (result.action === 'speedbump_agreed') {
                                console.log('⚡ Direct DOM Action: Instantly agreed to Workspace Terms ("I understand")');
                            } else if (result.action === 'consent_signed_in') {
                                consentClicked = true; // suppress future consent evaluations for this account
                                console.log('⚡ Direct DOM Action: Clicked "Sign in" on Google OAuth consent screen.');
                            } else if (result.action === 'consent_allowed') {
                                consentClicked = true; // suppress future consent evaluations for this account
                                console.log('⚡ Direct DOM Action: Clicked "Allow/Continue" on consent screen.');
                            } else if (result.action === 'ms_stay_signed_in') {
                                console.log('⚡ Direct DOM Action: Clicked Microsoft "Stay signed in" button.');
                            } else if (result.action === 'password_submitted') {
                                console.log('⚡ Direct DOM Action: Submitted password.');
                            } else if (result.action === 'ms_email_submitted') {
                                console.log('⚡ Direct DOM Action: Submitted Microsoft Entra email.');
                            } else if (result.action === 'ms_account_picked') {
                                console.log('⚡ Direct DOM Action: Picked account tile.');
                            } else if (result.action === 'retry_something_went_wrong') {
                                console.log('⚡ Direct DOM Action: Auto-recovered from "Something went wrong" (Clicked Next/Try again).');
                            } else if (result.action === 'google_next') {
                                console.log('⚡ Direct DOM Action: Clicked Next on Google sign-in screen.');
                            } else if (result.action === 'generic_consent') {
                                console.log(`⚡ Direct DOM Action: Clicked "${result.label}" button.`);
                            } else if (result.action === 'mfa_required') {
                                console.error('MFA setup is required by Entra ID. Marking account as invalid to prevent infinite loops.');
                                cancelFlow(new Error("MFA_SETUP_REQUIRED"));
                                return;
                            } else if (result.action === 'ms_error') {
                                console.error('Microsoft Error detected:', result.error);
                                if (result.error.includes('valid email address')) {
                                    await page.evaluate((email) => {
                                        const el = document.querySelector('input[name="loginfmt"]');
                                        if (el) {
                                            el.value = email;
                                            el.dispatchEvent(new Event('input', { bubbles: true }));
                                            const sub = document.querySelector('input[type="submit"]');
                                            if (sub) sub.click();
                                        }
                                    }, account.email);
                                } else {
                                    cancelFlow(new Error("Microsoft login failed: " + result.error));
                                    return;
                                }
                            }
                        }

                    } catch (e) {
                        if (e.message?.includes('MFA_SETUP_REQUIRED') || e.message?.includes('Microsoft login failed') || e.message?.includes('CAPTCHA_CHALLENGE')) {
                            cancelFlow(e);
                        }
                    } finally {
                        isActionInFlight = false;
                    }
                }, 80);

                // Wait for the callback server to receive the code or early cancellation
                console.log(`Waiting for consent approval (Auto-clicking enabled)...`);
                let code;
                try {
                    code = await Promise.race([promise, cancelPromise]);
                } finally {
                    clearInterval(clickInterval);
                    // Only abort the callback listener if we didn't already receive the code.
                    // Calling abort() after a successful code receipt just emits a misleading
                    // "Callback session aborted" log — the state is already cleaned up by then.
                    if (abortServer && !code) {
                        try { abortServer(); } catch (e) {}
                    }
                }
                console.log(`Got OAuth code! Exchanging for tokens and onboarding...`);

                // Tidy up: close the captured browser page and context gracefully
                try {
                    if (page && !page.isClosed()) await page.close();
                    await new Promise(r => setTimeout(r, 60));
                    if (context && !context.isClosed()) await context.close();
                } catch (e) {}
                const authResult = await completeOAuthFlow(code, authUrl.verifier, undefined, socksAgent);
                
                if (authResult.refreshToken) {
                    // Update account
                    account.refreshToken = authResult.refreshToken;
                    account.source = 'oauth';
                    if (authResult.projectId) {
                        account.subscription = account.subscription || {};
                        account.subscription.projectId = authResult.projectId;
                    }
                    
                    // Save to disk with cross-process file lock
                    const lockPath = ACCOUNTS_FILE + '.lock';
                    await withFileLock(lockPath, async () => {
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
                            if (account.corporateFootprint) {
                                data.accounts[existingIdx].corporateFootprint = account.corporateFootprint;
                            }
                        } else {
                            data.accounts.push(account);
                        }
                        writeFileSync(ACCOUNTS_FILE, JSON.stringify(data, null, 2));
                    });
                    console.log(`✅ Successfully saved and onboarded ${account.email}!`);
                    
                    // Hot reload the proxy
                    try {
                        await fetch("http://127.0.0.1:1987/api/accounts/reload", { method: "POST" });
                        console.log(`🔄 Proxy automatically reloaded with new account.`);
                    } catch (e) {
                        console.log(`⚠ Failed to hot-reload proxy. You may need to restart it.`);
                    }

                    // Direct In-Line Sync to OmniRoute provider_connections
                    try {
                        execSync(`python3 "${OMNI_SYNC_SCRIPT}" "${account.email}"`, { stdio: 'inherit' });
                        console.log(`⚡ Direct In-Line Sync: Added/Updated ${account.email} in OmniRoute providers.`);
                    } catch (e) {
                        console.log(`⚠ OmniRoute direct sync note:`, e.message);
                    }

                    authCompleted = true;
                    successCount++;
                    break;
                } else {
                    console.log(`❌ No refresh token returned for ${account.email}`);
                    authCompleted = true;
                    break;
                }
                
            } catch (error) {
                if (error.message && error.message.startsWith('CAPTCHA_CHALLENGE:')) {
                    captchaAttempts++;
                    const parts = error.message.split(':');
                    const flaggedNode = parts[1];
                    const challengeType = parts[2] || 'captcha';

                    console.warn(`🚨 [CAPTCHA Defense] Challenge (${challengeType}) detected on ${account.email} via SOCKS node ${flaggedNode}! (Attempt ${captchaAttempts}/${MAX_CAPTCHA_RETRIES})`);
                    if (flaggedNode && flaggedNode !== 'local') {
                        console.log(`[SOCKS Mesh] Placing ${flaggedNode} into 15-minute cooldown and purging from cache...`);
                        nodeCooldowns.set(flaggedNode, Date.now() + 15 * 60 * 1000);
                        verifiedNodeCache.delete(preferredNode);
                        excludedNodesForAccount.push(flaggedNode);
                    }

                    if (challengeType === 'phone_verification' || captchaAttempts > MAX_CAPTCHA_RETRIES) {
                        console.error(`🚨 [CAPTCHA Defense] Account ${account.email} requires manual resolution (${challengeType}). Quarantining account to preserve swarm velocity.`);
                        authCompleted = true;
                        try {
                            const data = JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf8'));
                            const acc = data.accounts.find(a => a.email === account.email);
                            if (acc) {
                                acc.isInvalid = true;
                                acc.invalidReason = challengeType === 'phone_verification' ? 'PHONE_VERIFICATION_REQUIRED' : 'CAPTCHA_REQUIRED';
                                writeFileSync(ACCOUNTS_FILE, JSON.stringify(data, null, 2));
                                await fetch("http://127.0.0.1:1987/api/accounts/reload", { method: "POST" });
                            }
                        } catch (e) {}
                        break;
                    }

                    console.log(`[CAPTCHA Defense] Immediately rotating to an alternative SOCKS node and retrying ${account.email}...`);
                    await new Promise(r => setTimeout(r, 400));
                    continue;
                }

                authCompleted = true;
                console.error(`❌ Failed to authenticate ${account.email}:`, error.message);

                // API Diagnostics: Cross-check Google Workspace & Entra ID setups with APIs
                try {
                    console.log(`🔍 [API Diagnostics] Cross-checking Google Workspace & Entra ID setups for ${account.email}...`);
                    execSync(`python3 "${DIAGNOSTIC_SCRIPT}" "${account.email}"`, { stdio: 'inherit' });
                } catch (e) {
                    console.log(`⚠ API diagnostic error:`, e.message);
                }
                
                if (error.message.includes('MFA_SETUP_REQUIRED') || error.message.includes('valid email address')) {
                    console.log(`Marking ${account.email} as invalid in accounts.json`);
                    try {
                        const data = JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf8'));
                        const acc = data.accounts.find(a => a.email === account.email);
                        if (acc) {
                            acc.isInvalid = true;
                            acc.invalidReason = error.message;
                            writeFileSync(ACCOUNTS_FILE, JSON.stringify(data, null, 2));
                            await fetch("http://127.0.0.1:1987/api/accounts/reload", { method: "POST" });
                        }
                    } catch (e) {}
                }
                
                console.log('Waiting 1s before trying next account...');
                await new Promise(r => setTimeout(r, 1000));
                break;
            } finally {
                if (clickInterval) clearInterval(clickInterval);
                try { if (page && !page.isClosed()) await page.close(); } catch (e) {}
                await new Promise(r => setTimeout(r, 60));
                try { if (context && !context.isClosed()) await context.close(); } catch (e) {}
                if (bridge) {
                    try { await bridge.close(); } catch (e) {}
                }
                if (healthyNode && healthyNode !== 'local') {
                    activeLeasedNodes.delete(healthyNode);
                }
                if (isWaitingForHuman) {
                    isWaitingForHuman = false;
                    isGlobalHumanInterventionActive = false;
                }
            }
        }
        
        // Brief pause between account logins on this slot
        await new Promise(r => setTimeout(r, 300));
    }
}

    const workerSlots = [];
    for (let s = 0; s < actualConcurrency; s++) {
        workerSlots.push(runSlot(s));
    }
    await Promise.all(workerSlots);

    console.log(`\nFinished! Successfully authenticated ${successCount}/${pendingAccounts.length} accounts.`);
    try { await browser.disconnect(); } catch (e) {}
}

async function harvestLoop() {
    console.log('Starting Hardened Quota Harvester Daemon...');
    while (true) {
        try {
            await autoAuth();
        } catch (e) {
            console.error('Harvester error:', e);
        }
        console.log('Batch completed. Resting 3 seconds before next harvest run...');
        await new Promise(r => setTimeout(r, 3000));
    }
}
harvestLoop();
