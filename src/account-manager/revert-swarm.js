import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const accountsPath = join(homedir(), '.config', 'antigravity-proxy', 'accounts.json');
const data = JSON.parse(readFileSync(accountsPath, 'utf8'));

let patched = 0;
for (const account of data.accounts) {
    if (account.source === 'service_account') {
        account.source = 'oauth';
        account.refreshToken = null;
        patched++;
    }
}

writeFileSync(accountsPath, JSON.stringify(data, null, 2));
console.log(`Reverted ${patched} accounts to 'oauth' source with null refreshToken.`);
