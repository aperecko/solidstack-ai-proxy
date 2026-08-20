import { GoogleAuth } from 'google-auth-library';
import { SERVICE_ACCOUNT_KEY_PATH, hasServiceAccountKey } from '../auth/service-account.js';
import { request } from 'undici';
import crypto from 'crypto';

const ADMIN_SCOPES = ['https://www.googleapis.com/auth/admin.directory.user'];

// Mapping of domains to their known super admin emails for impersonation
const DOMAIN_ADMINS = {
    'mysolidstate.ca': 'adam@mysolidstate.ca',
    'reseller.mysolidstate.ca': 'apps@reseller.mysolidstate.ca',
    'adamassist.com': 'adam@adamassist.com'
};

/**
 * Helper to execute Admin SDK API requests
 */
export async function executeAdminApi(domain, url, method = 'GET', body = null) {
    if (!hasServiceAccountKey()) {
        throw new Error(`Service account key not found at ${SERVICE_ACCOUNT_KEY_PATH}.`);
    }
    
    const adminEmail = DOMAIN_ADMINS[domain];
    if (!adminEmail) {
        throw new Error(`No super admin configured for domain: ${domain}`);
    }

    const auth = new GoogleAuth({
        keyFile: SERVICE_ACCOUNT_KEY_PATH,
        scopes: ADMIN_SCOPES,
        clientOptions: { subject: adminEmail }
    });

    const client = await auth.getClient();
    const tokenInfo = await client.getAccessToken();
    
    if (!tokenInfo.token) {
        throw new Error(`Failed to retrieve admin access token for ${adminEmail}`);
    }

    const headers = {
        'Authorization': `Bearer ${tokenInfo.token}`,
        'Content-Type': 'application/json'
    };

    const options = {
        method,
        headers,
    };
    
    if (body) {
        options.body = JSON.stringify(body);
    }

    const response = await request(url, options);
    const data = await response.body.json();

    if (response.statusCode >= 400) {
        throw new Error(`Admin API Error (${response.statusCode}): ${JSON.stringify(data)}`);
    }

    return data;
}

/**
 * Discover all swarm accounts across all configured domains.
 * Applies a strict regex filter to exclude human "named" accounts.
 * Regex matches e.g. 01@, 10@, 000001@, z01@, z99@
 */
export async function discoverSwarmAccounts() {
    const discoveredAccounts = [];
    // Capture any digits or a 'z' followed by digits
    const swarmRegex = /^(\d+|z\d+)@/i;

    for (const domain of Object.keys(DOMAIN_ADMINS)) {
        console.log(`\n🔍 Querying domain: ${domain}...`);
        try {
            let pageToken = '';
            let domainTotal = 0;
            let domainSwarm = 0;
            
            do {
                const url = `https://admin.googleapis.com/admin/directory/v1/users?domain=${domain}&maxResults=500${pageToken ? `&pageToken=${pageToken}` : ''}`;
                const data = await executeAdminApi(domain, url);
                
                const users = data.users || [];
                domainTotal += users.length;
                
                for (const u of users) {
                    const email = u.primaryEmail;
                    if (swarmRegex.test(email)) {
                        discoveredAccounts.push(email);
                        domainSwarm++;
                    }
                }
                
                pageToken = data.nextPageToken;
            } while (pageToken);
            
            console.log(`   - Found ${domainTotal} total users`);
            console.log(`   - Identified ${domainSwarm} swarm accounts`);
            
        } catch (error) {
            console.error(`   ✗ Failed to query ${domain}:`, error.message);
        }
    }
    
    return discoveredAccounts;
}

/**
 * Provision new swarm accounts on a specific domain.
 * Generates secure random passwords for each account.
 */
export async function provisionSwarmAccounts(domain, prefix, startIdx, count) {
    console.log(`\n🚀 Provisioning ${count} swarm accounts on ${domain}...`);
    
    let successCount = 0;
    const url = 'https://admin.googleapis.com/admin/directory/v1/users';

    for (let i = 0; i < count; i++) {
        const id = startIdx + i;
        // Pad to 2 digits for mysolidstate/adamassist (e.g. z01, 01)
        const paddedId = id.toString().padStart(2, '0');
        const email = `${prefix}${paddedId}@${domain}`;
        
        // Generate a random 16-character secure password
        const password = crypto.randomBytes(12).toString('base64').replace(/[^a-zA-Z0-9]/g, '') + 'A1!';
        
        const payload = {
            primaryEmail: email,
            name: {
                givenName: 'Swarm',
                familyName: `${prefix}${paddedId}`
            },
            password: password,
            changePasswordAtNextLogin: false
        };

        try {
            await executeAdminApi(domain, url, 'POST', payload);
            console.log(`   ✓ Created ${email}`);
            successCount++;
        } catch (error) {
            // 409 means account already exists
            if (error.message.includes('409') || error.message.includes('Entity already exists')) {
                console.log(`   - Skipped ${email} (Already exists)`);
            } else {
                console.error(`   ✗ Failed to create ${email}:`, error.message);
            }
        }
    }
    
    console.log(`\n✅ Provisioning complete. Successfully created ${successCount} accounts.`);
    return successCount;
}
