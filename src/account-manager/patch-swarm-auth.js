#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const accountsPath = join(homedir(), '.config', 'antigravity-proxy', 'accounts.json');

const data = JSON.parse(readFileSync(accountsPath, 'utf8'));

let patched = 0;
for (const account of data.accounts) {
    if (account.source === 'service_account') {
        account.refreshToken = 'PENDING_AUTH';
        patched++;
    }
}

writeFileSync(accountsPath, JSON.stringify(data, null, 2));
console.log(`Patched ${patched} service_account entries with refreshToken = "PENDING_AUTH"`);
console.log(`Total accounts: ${data.accounts.length}`);

// Verify
const verify = JSON.parse(readFileSync(accountsPath, 'utf8'));
const withPending = verify.accounts.filter(a => a.refreshToken === 'PENDING_AUTH').length;
console.log(`Verified: ${withPending} accounts now have PENDING_AUTH`);
