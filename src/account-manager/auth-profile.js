import { getAuthorizationUrl, startCallbackServer, completeOAuthFlow } from '../auth/oauth.js';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const ACCOUNTS_FILE = join(homedir(), '.config/antigravity-proxy/accounts.json');
const TARGET_PROFILE = process.env.PROFILE || 'Profile 1';
const TARGET_EMAIL = process.env.EMAIL || 'chrisjeomara@gmail.com';

async function main() {
    console.log(`Starting OAuth authentication for ${TARGET_EMAIL} using Chrome ${TARGET_PROFILE}...`);
    
    const redirectUri = `http://localhost:51121/oauth-callback`;
    const authUrl = getAuthorizationUrl(redirectUri);
    const { promise, abort } = startCallbackServer(authUrl.state, 600000);

    // Open in targeted Chrome Profile
    console.log(`Opening OAuth consent in Chrome profile "${TARGET_PROFILE}"...`);
    const openCmd = `open -n -a "Google Chrome" --args --profile-directory="${TARGET_PROFILE}" "${authUrl.url}"`;
    await execAsync(openCmd);

    console.log(`\n======================================================`);
    console.log(`Browser opened! If prompted, select ${TARGET_EMAIL} and click "Allow/Continue".`);
    console.log(`Waiting for OAuth callback on port 51121...`);
    console.log(`======================================================\n`);

    try {
        const code = await promise;
        console.log(`Got OAuth authorization code! Exchanging for tokens and onboarding...`);
        const authResult = await completeOAuthFlow(code, authUrl.verifier);

        if (authResult.refreshToken) {
            const data = JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf8'));
            const existingIdx = data.accounts.findIndex(a => a.email === TARGET_EMAIL);
            const accountObj = {
                email: TARGET_EMAIL,
                source: 'oauth',
                enabled: true,
                isInvalid: false,
                invalidReason: null,
                refreshToken: authResult.refreshToken,
                subscription: {
                    tier: 'pro',
                    projectId: authResult.projectId || undefined
                }
            };

            if (existingIdx >= 0) {
                data.accounts[existingIdx] = {
                    ...data.accounts[existingIdx],
                    ...accountObj
                };
            } else {
                data.accounts.unshift(accountObj);
            }

            writeFileSync(ACCOUNTS_FILE, JSON.stringify(data, null, 2));
            console.log(`\n🎉 Successfully added and onboarded ${TARGET_EMAIL} as PRO into AI Proxy!`);

            try {
                await fetch('http://127.0.0.1:1987/api/accounts/reload', { method: 'POST' });
                console.log(`🔄 Proxy reloaded successfully.`);
            } catch (e) {
                console.log(`⚠ Failed to reload proxy:`, e.message);
            }
        }
    } catch (err) {
        console.error(`❌ Authentication failed:`, err.message);
    }
}

main().catch(console.error);
