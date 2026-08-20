import { GoogleAuth } from 'google-auth-library';
import fs from 'fs';
import path from 'path';
import os from 'os';

const SERVICE_ACCOUNT_KEY_PATH = path.join(os.homedir(), '.config/antigravity-proxy/service-account.json');
const ADMIN_SCOPES = ['https://www.googleapis.com/auth/admin.directory.user'];

const DOMAIN_ADMINS = {
    'mysolidstate.ca': 'adam@mysolidstate.ca',
    'reseller.mysolidstate.ca': 'apps@reseller.mysolidstate.ca',
    'adamassist.com': 'adam@adamassist.com'
};

async function executeAdminApi(domain, url, method = 'GET', body = null) {
    const adminEmail = DOMAIN_ADMINS[domain];
    const auth = new GoogleAuth({
        keyFile: SERVICE_ACCOUNT_KEY_PATH,
        scopes: ADMIN_SCOPES,
        clientOptions: { subject: adminEmail }
    });

    const client = await auth.getClient();
    const tokenInfo = await client.getAccessToken();

    const headers = {
        'Authorization': `Bearer ${tokenInfo.token}`,
        'Content-Type': 'application/json'
    };

    const options = { method, headers };
    if (body) options.body = JSON.stringify(body);

    const response = await fetch(url, options);
    const data = await response.json().catch(() => null);

    if (!response.ok) {
        throw new Error(`Admin API Error (${response.status}): ${JSON.stringify(data)}`);
    }

    return data;
}

async function runCleanup() {
    for (const domain of Object.keys(DOMAIN_ADMINS)) {
        console.log(`\nProcessing domain: ${domain}...`);
        try {
            let nextPageToken = '';
            let allUsers = [];
            
            do {
                let url = `https://admin.googleapis.com/admin/directory/v1/users?domain=${domain}&maxResults=200`;
                if (nextPageToken) url += `&pageToken=${nextPageToken}`;
                
                const data = await executeAdminApi(domain, url);
                if (data && data.users) {
                    allUsers = allUsers.concat(data.users);
                }
                nextPageToken = data.nextPageToken;
            } while (nextPageToken);

            console.log(`  Found ${allUsers.length} total users.`);

            for (const user of allUsers) {
                const email = user.primaryEmail;
                const emailPrefix = email.split('@')[0];

                // Check for 'z' accounts
                if (/^z\d+$/i.test(emailPrefix)) {
                    console.log(`  🗑️ Deleting ${email}...`);
                    await executeAdminApi(domain, `https://admin.googleapis.com/admin/directory/v1/users/${email}`, 'DELETE');
                }
                // Check for numbered accounts
                else if (/^\d+$/.test(emailPrefix)) {
                    const expectedName = emailPrefix;
                    const givenName = user.name.givenName;
                    const familyName = user.name.familyName;

                    if (givenName !== expectedName || familyName !== expectedName) {
                        console.log(`  ✏️ Renaming ${email} from "${givenName} ${familyName}" to "${expectedName} ${expectedName}"...`);
                        await executeAdminApi(domain, `https://admin.googleapis.com/admin/directory/v1/users/${email}`, 'PUT', {
                            name: {
                                givenName: expectedName,
                                familyName: expectedName
                            }
                        });
                    }
                }
            }
        } catch (error) {
            console.error(`Error processing ${domain}:`, error.message);
        }
    }
    console.log('\n✅ Cleanup complete.');
}

runCleanup();
