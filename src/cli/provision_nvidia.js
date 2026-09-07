#!/usr/bin/env node
/**
 * NVIDIA NIM Zero-Touch Key Provisioner (agent-browser + OpenClaw Orchestrator)
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync, spawn } from 'child_process';
import crypto from 'crypto';

const CONFIG_PATH = path.join(os.homedir(), '.config', 'antigravity-proxy', 'keyring.json');
const MAIN_CHROME_USER_DATA = path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
const CHROME_USER_DATA = path.join(os.homedir(), 'Library', 'Application Support', 'SolidStack', 'Chrome');
const DEFAULT_PROFILE = 'Profile 24';

function log(msg) {
    console.error(`[*] [NIM-Provisioner-V2] ${msg}`);
}

function resolveProfileDir(profileHint) {
    const localStatePath = path.join(MAIN_CHROME_USER_DATA, 'Local State');
    let humanName = profileHint;
    let dirName = profileHint;

    try {
        if (fs.existsSync(localStatePath)) {
            let dataRaw;
            try {
                dataRaw = fs.readFileSync(localStatePath, 'utf-8');
            } catch (e) {
                dataRaw = execSync(`sudo cat "${localStatePath}"`, { encoding: 'utf-8' });
            }
            const data = JSON.parse(dataRaw);
            const infoCache = data.profile?.info_cache || {};

            if (infoCache[profileHint]) {
                humanName = infoCache[profileHint].user_name || infoCache[profileHint].name || profileHint;
                return { dirName: profileHint, humanName };
            }
            for (const [dName, info] of Object.entries(infoCache)) {
                if (info.user_name === profileHint || info.name === profileHint) {
                    humanName = info.user_name || info.name;
                    return { dirName: dName, humanName };
                }
            }
        }
    } catch (e) {}
    return { dirName, humanName };
}

function saveKeyToKeyring(apiKey, label) {
    if (!fs.existsSync(path.dirname(CONFIG_PATH))) {
        fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    }
    let data = {};
    if (fs.existsSync(CONFIG_PATH)) {
        data = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    }
    data.providers = data.providers || {};
    data.providers.nvidia = data.providers.nvidia || { keys: [] };
    const keys = data.providers.nvidia.keys;
    if (keys.some(k => k.key === apiKey)) return;
    const newEntry = { id: crypto.randomBytes(4).toString('hex'), key: apiKey, label, addedAt: Date.now() };
    keys.push(newEntry);
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2), 'utf-8');
    log(`Successfully saved key to ${CONFIG_PATH}`);
}

async function main() {
    let profile = DEFAULT_PROFILE;
    for (let i = 2; i < process.argv.length; i++) {
        if (process.argv[i] === '--profile' && i + 1 < process.argv.length) profile = process.argv[++i];
    }

    const { dirName, humanName } = resolveProfileDir(profile);
    const profileDir = path.join(CHROME_USER_DATA, dirName);
    const mainProfile = path.join(MAIN_CHROME_USER_DATA, dirName);

    if (!fs.existsSync(profileDir)) {
        log(`Cloning personal Chrome profile (${dirName}) into isolated environment...`);
        try {
            execSync(`sudo mkdir -p "${CHROME_USER_DATA}"`, { stdio: 'ignore' });
            execSync(`sudo cp "${path.join(MAIN_CHROME_USER_DATA, 'Local State')}" "${path.join(CHROME_USER_DATA, 'Local State')}"`, { stdio: 'ignore' });
            execSync(`sudo cp -R "${mainProfile}" "${profileDir}"`, { stdio: 'ignore' });
            const user = process.env.USER || 'test';
            execSync(`sudo chown -R "${user}" "${CHROME_USER_DATA}"`, { stdio: 'ignore' });
        } catch (e) {
            log(`Clone failed: ${e.message}`);
        }
    }

    const chromePaths = [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    ];
    let executablePath = chromePaths.find(p => fs.existsSync(p));

    log(`Spawning Chrome natively on port 19222 with Profile: ${humanName}...`);
    const browserProcess = spawn(executablePath, [
        `--user-data-dir=${profileDir}`,
        "--no-first-run",
        "--remote-allow-origins=*",
        "--remote-debugging-port=19222",
        "https://build.nvidia.com/explore/discover"
    ], { detached: true, stdio: 'ignore' });
    browserProcess.unref();

    log("Dispatching OpenClaw agent playbook to handle extraction...");
    let apiKey = null;
    try {
        const playbookPath = path.join(process.cwd(), 'openclaw_skills', 'provision_nvidia.md');
        // We run the openclaw CLI to execute the playbook and capture stdout. 
        // We assume the playbook will output the final key in a parseable way.
        const output = execSync(`openclaw agent --message-file "${playbookPath}"`, { encoding: 'utf-8' });
        const matches = output.match(/nvapi-[A-Za-z0-9_-]{30,}/g);
        if (matches) apiKey = matches[0];
    } catch (e) {
        log(`OpenClaw playbook failed: ${e.message}`);
    }

    if (apiKey) {
        log(`Key extracted: ${apiKey.slice(0, 8)}...`);
        saveKeyToKeyring(apiKey, `NVIDIA NIM (${profile})`);
        console.log(JSON.stringify({ status: "success", provider: "nvidia", profile, maskedKey: `${apiKey.slice(0, 8)}...` }));
        process.exit(0);
    } else {
        log("Handoff required or extraction failed.");
        console.log(JSON.stringify({ status: "pending_auth", authUrl: "http://127.0.0.1:19222" }));
        process.exit(1);
    }
}
main().catch(e => { log(`Fatal: ${e.message}`); process.exit(1); });
