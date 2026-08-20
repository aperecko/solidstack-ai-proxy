import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { executeAdminApi } from './swarm-admin.js';

const ACCOUNTS_FILE = join(homedir(), '.config', 'antigravity-proxy', 'accounts.json');

// Re-using the same master password that we already saved to 1Password!
const MASTER_PASSWORD = 'Swarmd6f9b714!!2026';
const DOMAIN = 'adamassist.com';

async function autoResetSwarm() {
    const data = JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf8'));
    
    // Find all swarm accounts
    const swarmAccounts = data.accounts.filter(a => a.email.match(/^\d+@adamassist\.com$/));
    
    if (swarmAccounts.length === 0) {
        console.log("No swarm accounts found.");
        return;
    }

    console.log(`Starting automated password reset for ${swarmAccounts.length} accounts...`);
    
    let successCount = 0;
    
    for (let i = 0; i < swarmAccounts.length; i++) {
        const email = swarmAccounts[i].email;
        const url = `https://admin.googleapis.com/admin/directory/v1/users/${email}`;
        
        const payload = {
            password: MASTER_PASSWORD,
            changePasswordAtNextLogin: false
        };

        process.stdout.write(`[${i+1}/${swarmAccounts.length}] Resetting password for ${email}... `);
        try {
            await executeAdminApi(DOMAIN, url, 'PUT', payload);
            console.log('Success.');
            successCount++;
        } catch (error) {
            console.log(`Failed: ${error.message}`);
        }
    }

    console.log(`\n✅ Finished resetting passwords for ${successCount} accounts!`);
    console.log(`They are now perfectly synchronized with 1Password.`);
}

autoResetSwarm().catch(console.error);
