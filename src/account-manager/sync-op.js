import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';
import crypto from 'crypto';

const ACCOUNTS_FILE = join(homedir(), '.config', 'antigravity-proxy', 'accounts.json');
const SPREADSHEET_FILE = join(homedir(), 'Desktop', 'swarm_passwords_update.csv');

async function syncToOp() {
    const data = JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf8'));
    
    // Find all swarm accounts
    const swarmAccounts = data.accounts.filter(a => a.email.match(/^\d+@adamassist\.com$/));
    
    if (swarmAccounts.length === 0) {
        console.log("No swarm accounts found.");
        return;
    }

    console.log(`Fetching existing items from 1Password...`);
    let existingItems = [];
    try {
        const result = execSync(`op item list --vault SolidStack --format json`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
        const items = JSON.parse(result);
        existingItems = items.map(i => i.title);
    } catch (e) {
        console.log(`Error fetching from op: ${e.message}`);
    }

    const defaultPassword = 'Swarm' + crypto.randomBytes(4).toString('hex') + '!!' + new Date().getFullYear();
    console.log(`Generated Master Password for NEW accounts: ${defaultPassword}`);

    let createdCount = 0;
    let skippedCount = 0;
    
    // Setup CSV content
    let csvContent = "Primary Email,Password\n";
    
    for (let i = 0; i < swarmAccounts.length; i++) {
        const email = swarmAccounts[i].email;
        const title = `Swarm Account ${email}`;
        
        // If it's already in 1Password (by title or email inside title), skip it
        if (existingItems.some(t => t.includes(email))) {
            skippedCount++;
            continue;
        }

        process.stdout.write(`Creating 1Password item for ${email}... `);
        try {
            execSync(`op item create --category Login --title "${title}" username="${email}" password="${defaultPassword}" url="https://accounts.google.com" --vault SolidStack`, { stdio: 'ignore' });
            console.log('Created.');
            createdCount++;
            
            // Add to CSV
            csvContent += `${email},${defaultPassword}\n`;
        } catch (error) {
            console.log(`Failed: ${error.message}`);
        }
    }

    if (createdCount > 0) {
        writeFileSync(SPREADSHEET_FILE, csvContent);
        console.log(`\n✅ Saved spreadsheet to: ${SPREADSHEET_FILE}`);
    }

    console.log(`\nFinished!`);
    console.log(`Created: ${createdCount}`);
    console.log(`Skipped (already in OP): ${skippedCount}`);
}

syncToOp().catch(console.error);
