/**
 * SolidStack Commander Dashboard API
 * 
 * Replaces the Python FastAPI backend (main.py on port 8002) with native Node.js Express routes.
 * Implements:
 *   - /api/processes (liveness, start, stop, logs)
 *   - /api/orchestrate/* (start/stop orchestration stacks)
 *   - /api/infrastructure/vms (node list)
 *   - /api/consolidation (JSON state store)
 *   - /api/skills/containment (CRUD on JSON containment ideas)
 *   - /api/skills/context (Read/write markdown context files)
 *   - /api/prompt-genius (Prompt optimization using Google API keys/OAuth accounts)
 */

import express from 'express';
import fs from 'fs';
import path from 'path';
import { exec, execFile, execSync, spawn } from 'child_process';

import net from 'net';
import * as yaml from 'js-yaml';
import { fileURLToPath } from 'url';
import { sendMessage } from './cloudcode/message-handler.js';
import { logger } from './utils/logger.js';
import { getRoutingStats } from './cloudcode/routing-logger.js';
import { emitEvent, getBridgeStatus, setBridgeEnabled } from './openclaw-bridge.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE_DIR = path.resolve(__dirname, '../..');
const CONFIG_DIR = path.join(BASE_DIR, 'config');
const REGISTRY_DIR = path.join(BASE_DIR, 'registry');

const SERVICES_PATH = path.join(REGISTRY_DIR, 'services.yaml');
const NODES_PATH = path.join(REGISTRY_DIR, 'nodes.yaml');
const COMMANDER_CFG = path.join(CONFIG_DIR, 'commander.yaml');
const CONSOLIDATION_DB = path.join(BASE_DIR, 'commander/backend/consolidation.json');

const CONTAINMENT_DIR = path.join(BASE_DIR, '.solidstack-you/containment');
const USER_CONTEXT_PATH = path.join(BASE_DIR, 'context/USER-CONTEXT.md');
const OPERATING_MANUAL_PATH = path.join(BASE_DIR, '.solidstack-you/OPERATING-MANUAL.md');

// Keep track of spawned child processes in memory (just like FastAPI did)
const runningSpawnedProcesses = new Map();

/**
 * Check if a TCP port is currently listening.
 * @param {number} port - Port to check
 * @returns {Promise<boolean>}
 */
function isPortListening(port) {
    return new Promise((resolve) => {
        const client = new net.Socket();
        client.setTimeout(100);
        client.on('connect', () => {
            client.destroy();
            resolve(true);
        });
        client.on('error', () => {
            resolve(false);
        });
        client.on('timeout', () => {
            client.destroy();
            resolve(false);
        });
        client.connect(port, '127.0.0.1');
    });
}

/**
 * Check if Colima is currently running.
 * @returns {Promise<boolean>}
 */
function isColimaRunning() {
    return new Promise((resolve) => {
        exec('colima status', {
            env: { ...process.env, PATH: '/opt/homebrew/bin:/usr/local/bin:' + (process.env.PATH || '') },
            timeout: 3000
        }, (err, stdout) => {
            if (!err && stdout.toLowerCase().includes('running')) {
                resolve(true);
            } else {
                resolve(false);
            }
        });
    });
}

/**
 * Get all running system PIDs and their command lines.
 * @returns {Promise<Array<{pid: number, command: string}>>}
 */
function getSystemProcesses() {
    return new Promise((resolve) => {
        exec('ps -ax -o pid,command', (err, stdout) => {
            if (err || !stdout) {
                resolve([]);
                return;
            }
            const lines = stdout.split('\n').slice(1);
            const procs = [];
            for (const line of lines) {
                const trim = line.trim();
                if (!trim) continue;
                const match = trim.match(/^(\d+)\s+(.+)$/);
                if (match) {
                    procs.push({
                        pid: parseInt(match[1], 10),
                        command: match[2]
                    });
                }
            }
            resolve(procs);
        });
    });
}

/**
 * Safely parse a YAML file (handles multi-doc).
 */
function parseYamlFile(filePath) {
    if (!fs.existsSync(filePath)) return {};
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const docs = yaml.loadAll(content);
        const merged = {};
        for (const doc of docs) {
            if (doc && typeof doc === 'object') {
                Object.assign(merged, doc);
            }
        }
        return merged;
    } catch (e) {
        logger.error(`[CommanderAPI] Failed to parse YAML file ${filePath}:`, e);
        return {};
    }
}

// TTL cache for network liveness checks (TCP connect)
const tcpCache = new Map();
const TCP_CACHE_TTL = 30000; // 30 seconds

async function isHostReachable(ip) {
    if (!ip) return false;
    const cached = tcpCache.get(ip);
    if (cached && Date.now() - cached.ts < TCP_CACHE_TTL) {
        return cached.alive;
    }
    // Try common management ports with short timeout
    const ports = [80, 443, 22, 8443];
    for (const port of ports) {
        try {
            await new Promise((resolve, reject) => {
                const s = new net.Socket();
                s.setTimeout(500);
                s.on('connect', () => { s.destroy(); resolve(); });
                s.on('error', () => { s.destroy(); reject(); });
                s.on('timeout', () => { s.destroy(); reject(); });
                s.connect(port, ip);
            });
            tcpCache.set(ip, { alive: true, ts: Date.now() });
            return true;
        } catch {}
    }
    tcpCache.set(ip, { alive: false, ts: Date.now() });
    return false;
}

// Map of service IDs to known local ports
const SERVICE_PORTS = {
    'antigravity-claude-proxy': 1987,
    'ai-proxy-hub': 1987,
    'solidstack-dashboard': 5001,
    'solidstack-omni': 5001,
    'ssmcp': 8765,
};

/**
 * Scan all processes registered in commander.yaml and detect their liveness.
 */
async function scanProcesses() {
    const scripts = [];
    let explicitScripts = [];

    if (fs.existsSync(COMMANDER_CFG)) {
        try {
            const doc = yaml.load(fs.readFileSync(COMMANDER_CFG, 'utf8'));
            if (doc && Array.isArray(doc.scripts)) {
                explicitScripts = doc.scripts;
            }
        } catch (e) {
            logger.error('[CommanderAPI] Error reading commander.yaml:', e);
        }
    }

    const colimaActive = await isColimaRunning();
    const systemProcs = await getSystemProcesses();

    // Map ports to check
    const portsToCheck = [80, 8000, 8001, 1987, 8765, 5001, 8080, 443];
    const portStatuses = {};
    for (const port of portsToCheck) {
        portStatuses[port] = await isPortListening(port);
    }

    for (const s of explicitScripts) {
        const fullPath = path.resolve(BASE_DIR, s.path);
        let status = 'stopped';
        let pid = null;
        let port = null;

        // Custom checks matching main.py logic
        if (s.id === 'litellm-proxy') {
            port = 8000;
            if (portStatuses[8000]) {
                status = 'running';
            }
        } else if (s.id === 'arc-gateway') {
            port = 8001;
            if (portStatuses[8001]) {
                status = 'running';
            }
        } else if (s.id === 'colima-start') {
            if (colimaActive) {
                status = 'running';
            }
        } else if (s.id === 'local-stack-up') {
            if (colimaActive && (portStatuses[80] || portStatuses[8080])) {
                status = 'running';
            }
        } else if (s.id === 'local-stack-down') {
            status = 'stopped';
        } else if (s.id === 'ai-routing-console') {
            port = 1987;
            if (portStatuses[1987]) {
                status = 'running';
            }
        } else if (s.id === 'ssmcp-native') {
            port = 8765;
            if (portStatuses[8765]) {
                status = 'running';
            }
        } else if (s.id === 'solidstack-dashboard') {
            port = 5001;
            if (portStatuses[5001]) {
                status = 'running';
            }
        } else if (s.id === 'antigravity-proxy' || s.id === 'ssl-proxy') {
            port = 443;
            if (portStatuses[443]) {
                status = 'running';
            }
        } else {
            // Find script by file path match in ps output
            const match = systemProcs.find(p => p.command.includes(s.path));
            if (match) {
                status = 'running';
                pid = match.pid;
            }
        }

        // If we spawned it and it's still registered in memory
        if (runningSpawnedProcesses.has(s.id)) {
            const child = runningSpawnedProcesses.get(s.id);
            if (child.exitCode === null) {
                status = 'running';
                pid = child.pid;
            } else {
                runningSpawnedProcesses.delete(s.id);
            }
        }

        scripts.push({
            id: s.id,
            name: s.name,
            description: s.desc || 'No description provided.',
            path: fullPath,
            status,
            pid,
            port,
            stack: s.stack || 'unknown',
            logs_path: `/tmp/${s.id}.log`,
            type: 'script'
        });
    }

    return scripts;
}

export function createCommanderRouter(accountManager, ensureInitialized) {
    const router = express.Router();

    // 1. GET /api/processes — List all scripts, services, and nodes
    router.get('/processes', async (req, res) => {
        try {
            const scripts = await scanProcesses();

            // Load Services — only services on the local dev node (AMACBOOKPRO)
            const servicesData = parseYamlFile(SERVICES_PATH);
            const rawServices = servicesData.services || {};
            const LOCAL_DEV_NODE = 'AMACBOOKPRO';
            const services = await Promise.all(
                Object.entries(rawServices)
                    .filter(([_, s_data]) => s_data.node === LOCAL_DEV_NODE)
                    .map(async ([s_id, s_data]) => {
                        let status = s_data.status || 'unknown';
                        const port = SERVICE_PORTS[s_id];
                        if (port) {
                            status = await isPortListening(port) ? 'running' : 'stopped';
                        }
                        return {
                            id: s_id,
                            name: s_id.toUpperCase().replace(/-/g, ' '),
                            description: s_data.notes || 'No description provided.',
                            status,
                            stack: s_data.stack || 'unknown',
                            node: s_data.node || 'unknown',
                            type: 'service',
                            op_item: s_data.auth?.op_item || null,
                            url: s_data.access?.domain || s_data.access?.local_ip || '',
                            repo: s_data.repo_url || ''
                        };
                    })
            );

            // Load Nodes — only the local dev machine
            const nodesData = parseYamlFile(NODES_PATH);
            const rawNodes = nodesData.nodes || {};
            const rawNetwork = nodesData.network || {};
            const nodes = [];

            Object.entries(rawNodes).forEach(([n_id, n_data]) => {
                if (n_id !== LOCAL_DEV_NODE) return;
                const ip = n_data.access?.local_ip || '';
                nodes.push({
                    id: n_id,
                    name: n_id,
                    description: n_data.notes || '',
                    status: n_data.status || 'unknown',
                    stack: n_data.type || 'node',
                    type: n_data.hw_class === 'virtual' ? 'vm' : 'hardware',
                    ip,
                    os: n_data.os || 'unknown',
                    metrics: null
                });
            });

            // Locally accessible network gear (switches, APs, routers) — ping for liveness
            const networkResults = await Promise.all(
                Object.entries(rawNetwork).map(async ([n_id, n_data]) => {
                    const ip = n_data.access?.local_ip || '';
                    const alive = await isHostReachable(ip);
                    return {
                        id: n_id,
                        name: n_data.unifi_name || n_id,
                        description: n_data.notes || '',
                        status: alive ? 'online' : 'offline',
                        stack: 'network',
                        type: 'hardware',
                        ip,
                        os: n_data.model || 'unknown'
                    };
                })
            );
            nodes.push(...networkResults);

            res.json({ items: [...scripts, ...services, ...nodes] });
        } catch (error) {
            logger.error('[CommanderAPI] Error /processes:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // Helper to run a registered script process
    async function runProcess(processId) {
        const scripts = await scanProcesses();
        const script = scripts.find(s => s.id === processId);
        if (!script) return { status: 'not_found' };
        if (script.status === 'running') return { status: 'already_running' };

        const logFile = script.logs_path;
        const outStream = fs.openSync(logFile, 'a');

        // Determine if it is a python script or shell script
        const isShell = script.path.endsWith('.sh');
        const cmd = isShell ? 'bash' : 'python3';
        const args = [script.path];

        const child = spawn(cmd, args, {
            cwd: BASE_DIR,
            detached: true,
            stdio: ['ignore', outStream, outStream]
        });

        child.unref();
        runningSpawnedProcesses.set(processId, child);

        return { status: 'started', pid: child.pid };
    }

    // Helper to stop a process
    async function stopProcess(processId) {
        const scripts = await scanProcesses();
        const script = scripts.find(s => s.id === processId);
        if (!script) return { status: 'not_found' };

        if (script.pid) {
            try {
                // Kill process group
                process.kill(-script.pid, 'SIGKILL');
            } catch (e) {
                try {
                    process.kill(script.pid, 'SIGKILL');
                } catch (err) {
                    // Ignore
                }
            }
        }

        // Clean up spawned process cache
        runningSpawnedProcesses.delete(processId);
        return { status: 'stopped' };
    }

    // 2. POST /api/processes/:id/:action (start or stop)
    router.post('/processes/:id/:action', async (req, res) => {
        const { id, action } = req.params;
        try {
            if (action === 'start') {
                const result = await runProcess(id);
                if (result.status === 'not_found') {
                    return res.status(404).json({ error: 'Process not found' });
                }
                return res.json(result);
            } else if (action === 'stop') {
                const result = await stopProcess(id);
                if (result.status === 'not_found') {
                    return res.status(404).json({ error: 'Process not found' });
                }
                return res.json(result);
            } else {
                return res.status(400).json({ error: 'Invalid action' });
            }
        } catch (error) {
            logger.error(`[CommanderAPI] Error control process ${id}:`, error);
            res.status(500).json({ error: error.message });
        }
    });

    // Keep compatibility with specific start/stop endpoints
    router.post('/processes/:id/start', async (req, res) => {
        const result = await runProcess(req.params.id);
        if (result.status === 'not_found') return res.status(404).json({ error: 'Process not found' });
        res.json(result);
    });

    router.post('/processes/:id/stop', async (req, res) => {
        const result = await stopProcess(req.params.id);
        if (result.status === 'not_found') return res.status(404).json({ error: 'Process not found' });
        res.json(result);
    });

    // 3. GET /api/processes/:id/logs — Get logs
    router.get('/processes/:id/logs', async (req, res) => {
        try {
            const scripts = await scanProcesses();
            const script = scripts.find(s => s.id === req.params.id);
            if (!script || !fs.existsSync(script.logs_path)) {
                return res.json({ logs: 'No logs available. Note: Docker/Remote service logs are not streamed here yet.' });
            }

            const content = fs.readFileSync(script.logs_path, 'utf8');
            const lines = content.split('\n');
            const last100 = lines.slice(-100).join('\n');
            res.json({ logs: last100 });
        } catch (error) {
            logger.error(`[CommanderAPI] Error logs for ${req.params.id}:`, error);
            res.status(500).json({ error: error.message });
        }
    });

    // 4. POST /api/orchestrate/ai-stack — Start LiteLLM (deprecated) + ARC Gateway (deprecated)
    router.post('/orchestrate/ai-stack', async (req, res) => {
        // Obsolete since they are merged, but keep as dummy successful endpoint for compatibility
        res.json({ status: 'AI Stack Orchestration Unified internally (already running)' });
    });

    // 5. POST /api/orchestrate/local-stack/start — Start colima & local stack
    router.post('/orchestrate/local-stack/start', async (req, res) => {
        try {
            const colimaActive = await isColimaRunning();
            if (!colimaActive) {
                logger.info('[CommanderAPI] Starting Colima...');
                execSync('colima start', {
                    env: { ...process.env, PATH: '/opt/homebrew/bin:/usr/local/bin:' + (process.env.PATH || '') },
                    timeout: 90000
                });
            }

            await runProcess('local-stack-up');
            res.json({ status: 'started', colima_started_by_api: !colimaActive });
        } catch (error) {
            logger.error('[CommanderAPI] Error local-stack/start:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // 6. POST /api/orchestrate/local-stack/stop — Stop local stack
    router.post('/orchestrate/local-stack/stop', async (req, res) => {
        try {
            await runProcess('local-stack-down');
            res.json({ status: 'stopped' });
        } catch (error) {
            logger.error('[CommanderAPI] Error local-stack/stop:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // 7. GET /api/infrastructure/vms — Local dev infrastructure only
    router.get('/infrastructure/vms', async (req, res) => {
        try {
            const nodesData = parseYamlFile(NODES_PATH);
            const rawNodes = nodesData.nodes || {};
            const LOCAL_DEV_NODE = 'AMACBOOKPRO';
            const vms = Object.entries(rawNodes)
                .filter(([n_id]) => n_id === LOCAL_DEV_NODE)
                .map(([n_id, n_data]) => {
                const state = n_data.status === 'online' ? 'running' : 'stopped';
                return {
                    id: n_id,
                    name: n_id,
                    provider: n_data.type || 'local',
                    ip: n_data.access?.local_ip || '',
                    state,
                    role: n_data.notes || 'Node'
                };
            });
            res.json(vms);
        } catch (error) {
            logger.error('[CommanderAPI] Error /infrastructure/vms:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // 8. GET & POST /api/consolidation — Consolidation JSON database CRUD
    router.get('/consolidation', (req, res) => {
        if (fs.existsSync(CONSOLIDATION_DB)) {
            try {
                const content = fs.readFileSync(CONSOLIDATION_DB, 'utf8');
                return res.json(JSON.parse(content));
            } catch (e) {
                // Ignore
            }
        }
        res.json({ vms: {} });
    });

    router.post('/consolidation', (req, res) => {
        try {
            fs.mkdirSync(path.dirname(CONSOLIDATION_DB), { recursive: true });
            fs.writeFileSync(CONSOLIDATION_DB, JSON.stringify(req.body, null, 2));
            res.json({ status: 'saved' });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // 9. CRUD on Containment Ideas (/api/skills/containment)
    router.get('/skills/containment', (req, res) => {
        try {
            fs.mkdirSync(CONTAINMENT_DIR, { recursive: true });
            const files = fs.readdirSync(CONTAINMENT_DIR);
            const ideas = [];
            for (const fName of files) {
                if (fName.endsWith('.json')) {
                    try {
                        const ideaData = JSON.parse(fs.readFileSync(path.join(CONTAINMENT_DIR, fName), 'utf8'));
                        ideaData.filename = fName;
                        ideas.push(ideaData);
                    } catch (e) {
                        // Ignore
                    }
                }
            }
            // Sort: active first, then by timestamp descending
            ideas.sort((a, b) => {
                const aActive = (a.status || 'active') === 'active';
                const bActive = (b.status || 'active') === 'active';
                if (aActive !== bActive) return aActive ? -1 : 1;
                return (b.timestamp || 0) - (a.timestamp || 0);
            });
            res.json(ideas);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    router.post('/skills/containment', (req, res) => {
        try {
            fs.mkdirSync(CONTAINMENT_DIR, { recursive: true });
            const idea = req.body;
            const id = idea.id || Math.random().toString(36).substring(2, 15);
            const timestamp = idea.timestamp || Date.now() / 1000;
            
            const ideaData = {
                ...idea,
                id,
                timestamp,
                status: idea.status || 'active'
            };

            const fileName = `${Math.floor(timestamp)}_${id}.json`;
            fs.writeFileSync(path.join(CONTAINMENT_DIR, fileName), JSON.stringify(ideaData, null, 2));

            res.json({ status: 'created', idea: ideaData });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    router.patch('/skills/containment/:filename', (req, res) => {
        const filePath = path.join(CONTAINMENT_DIR, req.params.filename);
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: 'Idea not found' });
        }
        try {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            Object.assign(data, req.body);
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
            res.json({ status: 'updated', idea: data });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    router.delete('/skills/containment/:filename', (req, res) => {
        const filePath = path.join(CONTAINMENT_DIR, req.params.filename);
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: 'Idea not found' });
        }
        try {
            fs.unlinkSync(filePath);
            res.json({ status: 'deleted' });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // 10. context files: GET & POST /api/skills/context
    router.get('/skills/context', (req, res) => {
        let userContext = '';
        let operatingManual = '';
        try {
            if (fs.existsSync(USER_CONTEXT_PATH)) {
                userContext = fs.readFileSync(USER_CONTEXT_PATH, 'utf8');
            }
            if (fs.existsSync(OPERATING_MANUAL_PATH)) {
                operatingManual = fs.readFileSync(OPERATING_MANUAL_PATH, 'utf8');
            }
            res.json({ userContext, operatingManual });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    router.post('/skills/context', (req, res) => {
        try {
            fs.mkdirSync(path.dirname(USER_CONTEXT_PATH), { recursive: true });
            fs.writeFileSync(USER_CONTEXT_PATH, req.body.userContext || '');

            fs.mkdirSync(path.dirname(OPERATING_MANUAL_PATH), { recursive: true });
            fs.writeFileSync(OPERATING_MANUAL_PATH, req.body.operatingManual || '');

            res.json({ status: 'saved' });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // 11. POST /api/prompt-genius — Rewrite user prompts using OAuth/Gemini accounts directly
    router.post('/prompt-genius', async (req, res) => {
        const systemPrompt = `You are a Master Prompt Engineer and AI Orchestrator. The user will give you a stream-of-consciousness, poorly worded, or multi-faceted idea.
Your job is to rewrite it into an expert-level, highly effective prompt.

If the user's idea spans multiple domains, you MUST instruct the AI to emulate multiple distinct domain experts (e.g., a Systems Architect and a UX Researcher) who will synthesize their perspectives.

CRITICAL REQUIREMENT: The user has ADHD. The resulting prompt you generate MUST explicitly command the AI to format its final output with a "Succinct Action Plan"—a heavily bolded, extremely concise, bulleted checklist of immediate next steps. No walls of text at the end.

Output ONLY the rewritten prompt, wrapped in triple backticks.`;

        try {
            logger.info('[CommanderAPI] Processing prompt rewriting request...');
            const anthropicRequest = {
                model: 'gemini-2.5-flash',
                messages: [
                    { role: 'user', content: req.body.prompt }
                ],
                system: systemPrompt,
                max_tokens: 2048,
                temperature: 0.2
            };

            if (ensureInitialized) {
                await ensureInitialized();
            }
            // Call standard sendMessage in the account pool
            const result = await sendMessage(anthropicRequest, accountManager, true);
            const content = result.content?.[0]?.text || '';
            res.json({ result: content });
        } catch (error) {
            logger.error('[CommanderAPI] Prompt genius failed:', error);
            res.status(500).json({ result: `Could not rewrite prompt: ${error.message}` });
        }
    });
    // 11.5 GET /api/accounts — Get all configured proxy accounts
    router.get('/accounts', (req, res) => {
        try {
            const accounts = accountManager.getAllAccounts ? accountManager.getAllAccounts() : [];
            // filter out sensitive data like refresh_tokens
            const safeAccounts = accounts.map(a => ({
                email: a.email,
                type: a.type,
                enabled: a.enabled,
                isInvalid: a.isInvalid,
                rateLimitRemaining: a.rateLimitRemaining,
                rateLimitReset: a.rateLimitReset
            }));
            
            let total = 0, available = 0, rateLimited = 0, invalid = 0;
            if (accountManager.getStatus) {
                const status = accountManager.getStatus();
                total = status.total;
                available = status.available;
                rateLimited = status.rateLimited;
                invalid = status.invalid;
            } else {
                total = safeAccounts.length;
                invalid = safeAccounts.filter(a => a.isInvalid).length;
                rateLimited = safeAccounts.filter(a => !a.isInvalid && a.rateLimitRemaining !== undefined && a.rateLimitRemaining <= 0).length;
                available = safeAccounts.filter(a => !a.isInvalid && a.enabled !== false && (a.rateLimitRemaining === undefined || a.rateLimitRemaining > 0)).length;
            }

            res.json({
                status: 'ok',
                accounts: safeAccounts,
                summary: {
                    total,
                    available,
                    rateLimited,
                    invalid
                }
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // 12. GET /api/routing-stats — Get load balancer history and effectiveness stats
    router.get('/routing-stats', (req, res) => {
        const stats = getRoutingStats();
        try {
            stats.strategy = accountManager.getStrategyName();
            stats.strategyLabel = accountManager.getStrategyLabel();
            stats.mode = accountManager.getRoutingMode ? accountManager.getRoutingMode() : 'load_balancer';
            stats.nativeAccount = accountManager.getNativeIdeAccount ? accountManager.getNativeIdeAccount()?.email : null;
        } catch (e) {
            stats.strategy = 'hybrid';
            stats.strategyLabel = 'Hybrid (Smart Distribution)';
            stats.mode = 'load_balancer';
        }
        
        try {
            const allAccs = accountManager.getAllAccounts() || [];
            let totalLimit = 0;
            let fullyExhaustedCount = 0;
            
            allAccs.forEach(acc => {
                if (acc.enabled !== false && !acc.isInvalid) {
                    const isPro = acc.subscription?.tier === 'pro';
                    totalLimit += isPro ? 1500 : 50;
                    let isExhausted = false;
                    if (acc.quota && acc.quota.models) {
                        for (const q of Object.values(acc.quota.models)) {
                            if (q.remainingFraction !== undefined && q.remainingFraction < 0.05) {
                                isExhausted = true; break;
                            }
                        }
                    }
                    if (isExhausted) fullyExhaustedCount++;
                }
            });
            
            let burnRateRpm = 0;
            if (stats.history && stats.history.length > 1) {
                const newest = new Date(stats.history[0].timestamp).getTime();
                const oldest = new Date(stats.history[stats.history.length - 1].timestamp).getTime();
                const deltaMin = (newest - oldest) / 60000;
                if (deltaMin > 0) {
                    burnRateRpm = Math.round(stats.history.length / deltaMin);
                }
            }
            
            stats.global_capacity = {
                total_rpm_limit: totalLimit,
                burn_rate_rpm: burnRateRpm,
                exhausted_accounts: fullyExhaustedCount
            };
        } catch(e) {
            stats.global_capacity = { total_rpm_limit: 1500, burn_rate_rpm: 0, exhausted_accounts: 0 };
        }

        res.json(stats);
    });

    // 13. GET /api/routing-mode — Get active master routing mode
    router.get('/routing-mode', (req, res) => {
        const mode = accountManager.getRoutingMode ? accountManager.getRoutingMode() : 'load_balancer';
        const nativeAcc = accountManager.getNativeIdeAccount ? accountManager.getNativeIdeAccount() : null;
        res.json({
            mode,
            modeLabel: mode === 'native_bypass' ? 'Native IDE Account (Emergency Bypass)' : 'Multi-Account Load Balancer',
            nativeAccount: nativeAcc?.email || null
        });
    });

    // 14. POST /api/routing-mode — Toggle master routing mode
    router.post('/routing-mode', (req, res) => {
        try {
            const { mode } = req.body;
            if (!['load_balancer', 'native_bypass'].includes(mode)) {
                return res.status(400).json({ status: 'error', error: 'Invalid mode. Use "load_balancer" or "native_bypass"' });
            }
            if (accountManager.setRoutingMode) {
                accountManager.setRoutingMode(mode);
            }
            const activeMode = accountManager.getRoutingMode ? accountManager.getRoutingMode() : mode;
            const nativeAcc = accountManager.getNativeIdeAccount ? accountManager.getNativeIdeAccount() : null;
            
            // Persist to disk so menubar python app sees it and it survives restarts
            try {
                const ROUTING_MODE_FILE = path.join(BASE_DIR, '.logs', 'routing-mode.json');
                fs.mkdirSync(path.dirname(ROUTING_MODE_FILE), { recursive: true });
                fs.writeFileSync(ROUTING_MODE_FILE, JSON.stringify({
                    mode: activeMode,
                    nativeAccount: nativeAcc?.email,
                    updated_at: new Date().toISOString()
                }, null, 2));
            } catch (fsErr) {
                logger.error('[CommanderAPI] Failed to persist routing mode:', fsErr);
            }
            res.json({
                status: 'ok',
                mode: activeMode,
                modeLabel: activeMode === 'native_bypass' ? 'Native IDE Account (Emergency Bypass)' : 'Multi-Account Load Balancer',
                nativeAccount: nativeAcc?.email || null
            });
        } catch (e) {
            res.status(500).json({ status: 'error', error: e.message });
        }
    });

    const TOGGLES_FILE = path.join(BASE_DIR, '.logs', 'service-toggles.json');

    function loadServiceToggles() {
        if (fs.existsSync(TOGGLES_FILE)) {
            try {
                return JSON.parse(fs.readFileSync(TOGGLES_FILE, 'utf8'));
            } catch (e) {}
        }
        return {
            arc: { enabled: true, description: 'AI Routing Console (Gemini + Claude router on /v1)' },
            mcp: { enabled: true, description: 'SSmcp Native MCP tool server on /mcp' },
            dashboard: { enabled: true, description: 'Web Operator Dashboard UI & stream on /' },
            heartbeat: { enabled: false, description: 'Multi-node health telemetry collector' }
        };
    }

    // 15. GET /api/services/status — Get sub-services enabled state
    router.get('/services/status', (req, res) => {
        res.json(loadServiceToggles());
    });

    // 16. POST /api/services/:id/toggle — Toggle sub-service state
    router.post('/services/:id/toggle', (req, res) => {
        const { id } = req.params;
        const toggles = loadServiceToggles();
        if (!toggles[id]) {
            return res.status(404).json({ status: 'error', error: `Sub-service '${id}' not found` });
        }
        toggles[id].enabled = !toggles[id].enabled;
        try {
            fs.mkdirSync(path.dirname(TOGGLES_FILE), { recursive: true });
            fs.writeFileSync(TOGGLES_FILE, JSON.stringify(toggles, null, 2));
        } catch (e) {}
        res.json({ service: id, enabled: toggles[id].enabled });
    });

    // 17. POST /api/context/sync — Sync Gemini Context
    router.post('/context/sync', express.json({ limit: '50mb' }), (req, res) => {
        try {
            const { conversationId, title, content, images } = req.body;
            if (!conversationId) {
                return res.status(400).json({ status: 'error', error: 'Missing conversationId' });
            }

            const syncDir = path.join(BASE_DIR, 'context/gemini_sync', conversationId);
            fs.mkdirSync(syncDir, { recursive: true });

            // Save Transcript
            const transcriptPath = path.join(syncDir, 'transcript.md');
            let mdContent = `# ${title || 'Gemini Conversation'}\n\n`;
            mdContent += `*Synced on: ${new Date().toISOString()}*\n\n`;
            mdContent += content || '';
            fs.writeFileSync(transcriptPath, mdContent);

            // Save Images
            const savedImages = [];
            if (Array.isArray(images)) {
                images.forEach((img, index) => {
                    if (img.data && img.data.startsWith('data:image')) {
                        const matches = img.data.match(/^data:image\/([A-Za-z-+\/]+);base64,(.+)$/);
                        if (matches && matches.length === 3) {
                            const ext = matches[1] === 'jpeg' ? 'jpg' : matches[1];
                            const buffer = Buffer.from(matches[2], 'base64');
                            const filename = `image_${index + 1}.${ext}`;
                            fs.writeFileSync(path.join(syncDir, filename), buffer);
                            savedImages.push(filename);
                        }
                    }
                });
            }

            res.json({
                status: 'success',
                conversationId,
                savedFiles: ['transcript.md', ...savedImages]
            });
        } catch (error) {
            logger.error(`[Context Sync] Error: ${error.message}`);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    // 18. POST /api/openclaw/emit-event — Emit event to OpenClaw
    router.post('/openclaw/emit-event', async (req, res) => {
        const { type, ...payload } = req.body;
        if (!type) {
            return res.status(400).json({ error: 'Missing event type' });
        }
        const success = await emitEvent(type, payload);
        res.json({ status: success ? 'emitted' : 'failed' });
    });

    // 19. POST /api/openclaw/bridge-{action} — Control OpenClaw bridge
    router.post('/openclaw/bridge-:action', (req, res) => {
        const { action } = req.params;
        if (action === 'status') {
            return res.json({ enabled: getBridgeStatus() });
        } else if (action === 'enable') {
            setBridgeEnabled(true);
            return res.json({ enabled: true });
        } else if (action === 'disable') {
            setBridgeEnabled(false);
            return res.json({ enabled: false });
        }
        res.status(400).json({ error: 'Invalid action' });
    });

    // 20. GET /api/daemons — List native daemons
    router.get('/daemons', (req, res) => {
        try {
            const portsData = JSON.parse(fs.readFileSync(path.join(REGISTRY_DIR, 'ports.json'), 'utf8'));
            const daemons = [];
            for (const [svc, info] of Object.entries(portsData.services || {})) {
                if (info.plist) {
                    let status = 'stopped';
                    let pid = null;
                    try {
                        const out = execSync(`launchctl list | grep ${info.plist}`, { encoding: 'utf8' }).trim();
                        if (out) {
                            const parts = out.split(/\s+/);
                            if (parts[0] !== '-') pid = parts[0];
                            status = 'running';
                        }
                    } catch (e) {
                        // grep returns 1 if not found
                    }
                    daemons.push({
                        id: svc,
                        plist: info.plist,
                        port: info.port,
                        status,
                        pid
                    });
                }
            }
            res.json(daemons);
        } catch (e) {
            logger.error('[CommanderAPI] Error fetching daemons:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // 21. POST /api/daemons/:id/:action — Control native daemon
    router.post('/daemons/:id/:action', (req, res) => {
        const { id, action } = req.params;
        try {
            const portsData = JSON.parse(fs.readFileSync(path.join(REGISTRY_DIR, 'ports.json'), 'utf8'));
            const info = portsData.services[id];
            if (!info || !info.plist) {
                return res.status(404).json({ error: 'Daemon not found' });
            }

            if (action === 'start') {
                execSync(`launchctl start ${info.plist}`);
            } else if (action === 'stop') {
                execSync(`launchctl stop ${info.plist}`);
            } else if (action === 'restart') {
                execSync(`launchctl stop ${info.plist} && sleep 1 && launchctl start ${info.plist}`);
            } else {
                return res.status(400).json({ error: 'Invalid action' });
            }
            res.json({ id, action, status: 'success' });
        } catch (e) {
            logger.error(`[CommanderAPI] Error ${action} daemon ${id}:`, e);
            res.status(500).json({ error: e.message });
        }
    });

    // 22. GET /api/capability/matrix — Live Capability Matrix
    router.get('/capability/matrix', (req, res) => {
        exec('python3 -m ss.cli capability matrix --json', { cwd: BASE_DIR }, (err, stdout) => {
            if (err) {
                try {
                    const capFiles = fs.readdirSync(path.join(REGISTRY_DIR, 'capabilities'))
                        .filter(f => f.endsWith('.yaml') || f.endsWith('.json'));
                    const nodes = capFiles.map(f => yaml.load(fs.readFileSync(path.join(REGISTRY_DIR, 'capabilities', f), 'utf8')));
                    return res.json({
                        generated_at: new Date().toISOString(),
                        total_nodes: nodes.length,
                        nodes,
                        coexistence_registry: []
                    });
                } catch (e) {
                    return res.status(500).json({ error: e.message });
                }
            }
            try {
                res.json(JSON.parse(stdout));
            } catch (e) {
                res.status(500).json({ error: 'Failed to parse capability matrix' });
            }
        });
    });

    // 23. GET /api/capability/baseline — Feature & Capability Baseline
    router.get('/capability/baseline', (req, res) => {
        exec('python3 -m ss.cli capability baseline --json', { cwd: BASE_DIR }, (err, stdout) => {
            if (err) return res.status(500).json({ error: err.message });
            try {
                res.json(JSON.parse(stdout));
            } catch (e) {
                res.status(500).json({ error: 'Failed to parse baseline' });
            }
        });
    });

    // 24. GET /api/capability/history — 5-Domain Evaluation History
    router.get('/capability/history', (req, res) => {
        exec('python3 -m ss.cli capability history --json', { cwd: BASE_DIR }, (err, stdout) => {
            if (err) return res.status(500).json({ error: err.message });
            try {
                res.json(JSON.parse(stdout));
            } catch (e) {
                res.status(500).json({ error: 'Failed to parse history' });
            }
        });
    });

    // 25. POST /api/capability/evaluate — Evaluate external candidate
    router.post('/capability/evaluate', (req, res) => {
        const { target, title, description, url } = req.body || {};
        const evalTarget = (target || url || title || 'candidate').replace(/'/g, "\\'");
        const evalTitle = (title || evalTarget).replace(/'/g, "\\'");
        const evalDesc = (description || '').replace(/'/g, "\\'");
        const evalUrl = (url || '').replace(/'/g, "\\'");
        exec(`python3 -c "from ss.capability import evaluate_candidate_domains; import json; print(json.dumps(evaluate_candidate_domains('${evalTarget}', '${evalTitle}', '${evalDesc}', '${evalUrl}')))"`, { cwd: BASE_DIR }, (err, stdout) => {
            if (err) return res.status(500).json({ error: err.message });
            try {
                res.json(JSON.parse(stdout));
            } catch (e) {
                res.status(500).json({ error: 'Failed to parse evaluation output' });
            }
        });
    });

    // 26. POST /api/capability/evaluate-code — 5-Domain Internal Code Audit
    router.post('/capability/evaluate-code', (req, res) => {
        const { target = 'git:diff' } = req.body || {};
        const safeTarget = target.replace(/'/g, "\\'");
        exec(`python3 -m ss.cli capability evaluate-code '${safeTarget}' --json`, { cwd: BASE_DIR }, (err, stdout) => {
            if (err) return res.status(500).json({ error: err.message });
            try {
                res.json(JSON.parse(stdout));
            } catch (e) {
                res.status(500).json({ error: 'Failed to parse code audit output' });
            }
        });
    });

    // 27. GET /api/swarm/agents — Registered Autonomous Swarm Agents
    router.get('/swarm/agents', (req, res) => {
        exec('python3 -m ss.cli swarm agents --json', { cwd: BASE_DIR }, (err, stdout) => {
            if (err) return res.status(500).json({ error: err.message });
            try {
                res.json(JSON.parse(stdout));
            } catch (e) {
                res.status(500).json({ error: 'Failed to parse swarm agents' });
            }
        });
    });

    // 28. POST /api/swarm/execute — Trigger Recursive Multi-Agent Swarm Audit
    router.post('/swarm/execute', (req, res) => {
        const { target = 'project:all', strategy = 'specialist' } = req.body || {};
        const safeTarget = target.replace(/'/g, "\\'");
        const safeStrategy = strategy.replace(/'/g, "\\'");
        exec(`python3 -m ss.cli swarm run '${safeTarget}' --strategy '${safeStrategy}' --json`, { cwd: BASE_DIR }, (err, stdout) => {
            if (err) return res.status(500).json({ error: err.message });
            try {
                res.json(JSON.parse(stdout));
            } catch (e) {
                res.status(500).json({ error: 'Failed to parse swarm execution output' });
            }
        });
    });

    // 29. GET /api/swarm/stream — Live SSE Stream of Multi-Agent Swarm Execution
    router.get('/swarm/stream', (req, res) => {
        const { target = 'project:all', strategy = 'specialist' } = req.query || {};
        const safeTarget = (target || 'project:all').replace(/'/g, "\\'");
        const safeStrategy = (strategy || 'specialist').replace(/'/g, "\\'");

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders?.();

        const proc = spawn('python3', ['-m', 'ss.cli', 'swarm', 'stream', safeTarget, '--strategy', safeStrategy], {
            cwd: BASE_DIR
        });

        proc.stdout.on('data', (data) => {
            const lines = data.toString().split('\n');
            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    res.write(`${line}\n\n`);
                }
            }
        });

        proc.stderr.on('data', (data) => {
            console.error(`[SwarmStream:stderr] ${data.toString()}`);
        });

        proc.on('close', (code) => {
            res.write(`data: ${JSON.stringify({ event: 'stream_close', code })}\n\n`);
            res.end();
        });

        req.on('close', () => {
            try {
                proc.kill();
            } catch (e) {
                // ignore
            }
        });
    });

    // 30. GET /api/swarm/telemetry — Swarm Execution Performance & Telemetry
    router.get('/swarm/telemetry', (req, res) => {
        exec('python3 -m ss.cli swarm telemetry --json', { cwd: BASE_DIR }, (err, stdout) => {
            if (err) return res.status(500).json({ error: err.message });
            try {
                res.json(JSON.parse(stdout));
            } catch (e) {
                res.status(500).json({ error: 'Failed to parse swarm telemetry' });
            }
        });
    });

    // 31. POST /api/audit/grounded — Run Grounded Multi-Vector Code Audit
    router.post('/audit/grounded', (req, res) => {
        const { target = 'project:all', model = 'gemini-2.5-flash' } = req.body || {};
        const safeTarget = (target || 'project:all').replace(/'/g, "\\'");
        const safeModel = (model || 'gemini-2.5-flash').replace(/'/g, "\\'");

        exec(`python3 -m ss.cli audit grounded '${safeTarget}' --model '${safeModel}' --json`, { cwd: BASE_DIR }, (err, stdout) => {
            if (err) return res.status(500).json({ error: err.message });
            try {
                res.json(JSON.parse(stdout));
            } catch (e) {
                res.status(500).json({ error: 'Failed to parse grounded audit output' });
            }
        });
    });

    // 32. GET /api/audit/grounded/cache — Read cached improvement backlog
    router.get('/audit/grounded/cache', (req, res) => {
        const cachePath = path.join(BASE_DIR, 'registry/audits/grounded-improvements.json');
        if (fs.existsSync(cachePath)) {
            try {
                const data = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
                return res.json(data);
            } catch (e) {
                return res.status(500).json({ error: 'Failed to read audit cache' });
            }
        }
        res.json({ improvements: [] });
    });

    // 33. POST /api/audit/apply-patch — Safely apply proposed improvement patch
    router.post('/audit/apply-patch', (req, res) => {
        const { patch_id } = req.body || {};
        if (!patch_id) return res.status(400).json({ error: 'patch_id is required' });
        const safePatchId = patch_id.replace(/[^a-zA-Z0-9_-]/g, '');

        exec(`python3 -m ss.cli audit apply-patch '${safePatchId}'`, { cwd: BASE_DIR }, (err, stdout) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, message: stdout.trim() });
        });
    });

    // 34. POST /api/audit/apply-batch — Atomically apply multiple patches
    router.post('/audit/apply-batch', (req, res) => {
        const { patch_ids = [] } = req.body || {};
        const safeIds = patch_ids.map(id => id.replace(/[^a-zA-Z0-9_-]/g, '')).join(' ');

        exec(`python3 -m ss.cli audit apply-batch ${safeIds}`, { cwd: BASE_DIR }, (err, stdout) => {
            if (err) return res.status(500).json({ error: err.message, output: stdout });
            res.json({ success: true, message: stdout.trim() });
        });
    });

    // 35. GET /api/audit/summary — Dynamic multi-patch executive & risk summary
    router.get('/audit/summary', (req, res) => {
        exec('python3 -m ss.cli audit summary --json', { cwd: BASE_DIR }, (err, stdout) => {
            if (err) return res.status(500).json({ error: err.message });
            try {
                res.json(JSON.parse(stdout));
            } catch (e) {
                res.status(500).json({ error: 'Failed to parse audit summary' });
            }
        });
    });

    // 35b. GET /api/consideration/frontiers — Frontier horizons and ledger state
    router.get('/consideration/frontiers', (req, res) => {
        const pyScript = `from ss.consider import get_research_frontiers, load_discovery_ledger; import json; f=get_research_frontiers(); l=load_discovery_ledger(); print(json.dumps({'frontiers': f, 'active_frontier_index': l.get('frontier_index', 0) % len(f) if f else 0, 'total_discovered': l.get('total_discovered', 0)}))`;
        exec(`python3 -c ${JSON.stringify(pyScript)}`, { cwd: BASE_DIR }, (err, stdout) => {
            if (err) return res.status(500).json({ error: err.message });
            try {
                res.json(JSON.parse(stdout.trim()));
            } catch (e) {
                res.status(500).json({ error: 'Failed to parse frontiers' });
            }
        });
    });

    // 35b2. POST /api/consideration/frontiers/refresh — Re-synthesize dynamic evolutionary frontiers from codebase state
    router.post('/consideration/frontiers/refresh', (req, res) => {
        const pyScript = `from ss.consider import get_research_frontiers, load_discovery_ledger; import json; f=get_research_frontiers(refresh=True); l=load_discovery_ledger(); print(json.dumps({'frontiers': f, 'active_frontier_index': 0, 'total_discovered': l.get('total_discovered', 0)}))`;
        exec(`python3 -c ${JSON.stringify(pyScript)}`, { cwd: BASE_DIR, timeout: 20000 }, (err, stdout) => {
            if (err) return res.status(500).json({ error: err.message });
            try {
                res.json(JSON.parse(stdout.trim()));
            } catch (e) {
                res.status(500).json({ error: 'Failed to refresh frontiers' });
            }
        });
    });


    // 35c. POST /api/consideration/discover — Trigger AI Idea Hunter across rotating/targeted frontiers
    router.post('/consideration/discover', (req, res) => {
        const { frontier_idx = null, limit = 3, force = false, custom_query = null } = req.body || {};
        const pyScript = `from ss.consider import discover_novel_candidates; import json; print(json.dumps(discover_novel_candidates(frontier_idx=${frontier_idx === null ? 'None' : frontier_idx}, limit=${limit}, force=${force ? 'True' : 'False'}, custom_query=${custom_query ? JSON.stringify(custom_query) : 'None'})))`;
        exec(`python3 -c ${JSON.stringify(pyScript)}`, { cwd: BASE_DIR, timeout: 30000 }, (err, stdout) => {
            if (err) return res.status(500).json({ error: err.message });
            try {
                res.json(JSON.parse(stdout.trim()));
            } catch (e) {
                res.status(500).json({ error: 'Failed to parse discovery response' });
            }
        });
    });

    // 35d. GET /api/consideration/items — Directory of assessed features and summary counts
    router.get('/consideration/items', (req, res) => {
        const pyScript = `from ss.consider import list_items, get_status_summary; import json; items=list_items(); summary=get_status_summary(); print(json.dumps({'total': summary.get('total', len(items)), 'analyzed': summary.get('analyzed', 0), 'high_relevance': sum(1 for i in items if ((i.get('analysis') or {}).get('relevance') or 0) >= 4), 'deployed': summary.get('deployed', 0), 'items': items}))`;
        exec(`python3 -c ${JSON.stringify(pyScript)}`, { cwd: BASE_DIR }, (err, stdout) => {

            if (err) return res.status(500).json({ error: err.message });
            try {
                res.json(JSON.parse(stdout.trim()));
            } catch (e) {
                res.status(500).json({ error: 'Failed to parse consideration items' });
            }
        });
    });

    // 35e. POST /api/consideration/evaluate — On-demand URL evaluation
    router.post('/consideration/evaluate', (req, res) => {
        const { url, force = false } = req.body || {};
        if (!url) return res.status(400).json({ error: 'url is required' });
        const pyScript = `from ss.consider import evaluate_feature_url; import json; print(json.dumps(evaluate_feature_url(${JSON.stringify(url)}, force=${force ? 'True' : 'False'})))`;
        exec(`python3 -c ${JSON.stringify(pyScript)}`, { cwd: BASE_DIR, timeout: 60000 }, (err, stdout) => {
            if (err) return res.status(500).json({ error: err.message });
            try {
                res.json(JSON.parse(stdout.trim()));
            } catch (e) {
                res.status(500).json({ error: 'Failed to parse evaluation response' });
            }
        });
    });

    // 35f. GET /api/audit/utility — 4-Quadrant System State and Utility Audit
    router.get('/audit/utility', (req, res) => {
        const pyScript = `from ss.system_state_auditor import run_system_utility_audit; import json; print(json.dumps(run_system_utility_audit()))`;
        exec(`python3 -c ${JSON.stringify(pyScript)}`, { cwd: BASE_DIR, timeout: 10000 }, (err, stdout) => {
            if (err) return res.status(500).json({ error: err.message });
            try {
                res.json(JSON.parse(stdout.trim()));
            } catch (e) {
                res.status(500).json({ error: 'Failed to parse audit response' });
            }
        });
    });

    // 35g. POST /api/audit/harness/generate — Auto-generate test fixtures for unevaluated/dark modules
    router.post('/audit/harness/generate', (req, res) => {
        const { limit = 10 } = req.body || {};
        const pyScript = `from ss.harness_generator import auto_generate_harnesses_for_all_dark_modules; import json; print(json.dumps(auto_generate_harnesses_for_all_dark_modules(limit=${limit})))`;
        exec(`python3 -c ${JSON.stringify(pyScript)}`, { cwd: BASE_DIR, timeout: 30000 }, (err, stdout) => {
            if (err) return res.status(500).json({ error: err.message });
            try {
                res.json(JSON.parse(stdout.trim()));
            } catch (e) {
                res.status(500).json({ error: 'Failed to parse harness generation response' });
            }
        });
    });

    // 35h. POST /api/evolution/run — Trigger recursive evolution supervisor
    router.post('/evolution/run', (req, res) => {
        const { cycles = 2, session_id = 'evolution-live' } = req.body || {};
        const pyScript = `from scripts.recursive_evolution_supervisor import run_recursive_evolution; import json; print(json.dumps(run_recursive_evolution(cycles=${cycles}, session_id=${JSON.stringify(session_id)})))`;
        exec(`python3 -c ${JSON.stringify(pyScript)}`, { cwd: BASE_DIR, timeout: 120000 }, (err, stdout) => {
            if (err) return res.status(500).json({ error: err.message });
            try {
                res.json(JSON.parse(stdout.trim()));
            } catch (e) {
                res.status(500).json({ error: 'Failed to parse evolution run response' });
            }
        });
    });


    // 35h. POST /api/consideration/sync — Sync all enabled sources (GitHub + YouTube + Research)
    router.post('/consideration/sync', (req, res) => {
        const { force = false } = req.body || {};
        const pyScript = `from ss.consider import sync_sources; import json; res = sync_sources(force=${force ? 'True' : 'False'}); print(json.dumps(res))`;
        exec(`python3 -c ${JSON.stringify(pyScript)}`, { cwd: BASE_DIR, timeout: 90000 }, (err, stdout) => {
            if (err) return res.status(500).json({ error: err.message });
            try {
                res.json(JSON.parse(stdout.trim()));
            } catch (e) {
                res.json({ status: 'ok', raw: stdout.trim() });
            }
        });
    });

    // 35h2. POST /api/consideration/sync-youtube — Dedicated YouTube playlist check & sync
    router.post('/consideration/sync-youtube', (req, res) => {
        const { force = false } = req.body || {};
        const pyScript = `from ss.consider import sync_sources; import json; res = sync_sources(force=${force ? 'True' : 'False'}, sources_filter=['youtube']); print(json.dumps(res))`;
        exec(`python3 -c ${JSON.stringify(pyScript)}`, { cwd: BASE_DIR, timeout: 60000 }, (err, stdout) => {
            if (err) return res.status(500).json({ error: err.message });
            try {
                res.json(JSON.parse(stdout.trim()));
            } catch (e) {
                res.json({ status: 'ok', raw: stdout.trim() });
            }
        });
    });

    // 35h3. POST /api/consideration/youtube-chat — Interactive Gemini chat with YouTube video transcript & architecture advisor
    router.post('/consideration/youtube-chat', (req, res) => {
        const { video_url = '', message = '', conversation_history = [] } = req.body || {};
        if (!video_url || !message) {
            return res.status(400).json({ error: 'video_url and message are required' });
        }
        const pyScript = `from ss.consider import youtube_ai_chat; import json; res = youtube_ai_chat(${JSON.stringify(video_url)}, ${JSON.stringify(message)}, ${JSON.stringify(conversation_history)}); print(json.dumps(res))`;
        execFile('python3', ['-c', pyScript], { cwd: BASE_DIR, timeout: 60000 }, (err, stdout) => {
            if (err) return res.status(500).json({ error: err.message, reply: `Execution error: ${err.message}` });
            try {
                res.json(JSON.parse(stdout.trim()));
            } catch (e) {
                res.json({ success: true, reply: stdout.trim() });
            }
        });
    });


    // 35i. GET /api/consideration/sources — Return configured YouTube playlists, GitHub lists, and research providers

    router.get('/consideration/sources', (req, res) => {
        const pyScript = `from pathlib import Path; import yaml, json; p = Path('registry/consideration/sources.yaml'); data = yaml.safe_load(p.read_text(encoding='utf-8')) if p.exists() else {}; print(json.dumps(data))`;

        exec(`python3 -c ${JSON.stringify(pyScript)}`, { cwd: BASE_DIR }, (err, stdout) => {
            if (err) return res.status(500).json({ error: err.message });
            try {
                res.json(JSON.parse(stdout.trim()));
            } catch (e) {
                res.status(500).json({ error: 'Failed to parse sources' });
            }
        });
    });

    // 35j. POST /api/consideration/re-evaluate-stateful — Re-assess consideration candidates against live 4-quadrant system state
    router.post('/consideration/re-evaluate-stateful', (req, res) => {
        const { item_id = null } = req.body || {};
        const pyScript = `from ss.stateful_reassessment import run_stateful_reassessment; import json; print(json.dumps(run_stateful_reassessment(${item_id ? JSON.stringify([item_id]) : 'None'})))`;
        exec(`python3 -c ${JSON.stringify(pyScript)}`, { cwd: BASE_DIR, timeout: 60000 }, (err, stdout) => {
            if (err) return res.status(500).json({ error: err.message });
            try {
                res.json(JSON.parse(stdout.trim()));
            } catch (e) {
                res.status(500).json({ error: 'Failed to parse stateful reassessment response' });
            }
        });
    });

    // 35k. GET /api/consideration/stateful-ledger — Get master stateful re-assessment ledger
    router.get('/consideration/stateful-ledger', (req, res) => {
        const pyScript = `from pathlib import Path; import json; p = Path('registry/consideration/stateful_audit_ledger.json'); print(p.read_text(encoding='utf-8') if p.exists() else '{"summary":{}}')`;
        exec(`python3 -c ${JSON.stringify(pyScript)}`, { cwd: BASE_DIR }, (err, stdout) => {
            if (err) return res.status(500).json({ error: err.message });
            try {
                res.json(JSON.parse(stdout.trim()));
            } catch (e) {
                res.status(500).json({ error: 'Failed to read stateful ledger' });
            }
        });
    });

    // 35l. GET /api/features/trends — Return feature lifecycle trends and core value audit
    router.get('/features/trends', (req, res) => {
        const pyScript = `from pathlib import Path; import json; p = Path('registry/audits/feature_value_trends.json'); from ss.feature_trend_engine import evaluate_feature_value_trends; print(p.read_text(encoding='utf-8') if p.exists() else json.dumps(evaluate_feature_value_trends()))`;
        exec(`python3 -c ${JSON.stringify(pyScript)}`, { cwd: BASE_DIR }, (err, stdout) => {
            if (err) return res.status(500).json({ error: err.message });
            try {
                res.json(JSON.parse(stdout.trim()));
            } catch (e) {
                res.status(500).json({ error: 'Failed to read feature trends' });
            }
        });
    });

    // 35m. POST /api/features/trends/recalculate — Recompute feature lifecycle value trends
    router.post('/features/trends/recalculate', (req, res) => {
        const pyScript = `from ss.feature_trend_engine import evaluate_feature_value_trends; import json; print(json.dumps(evaluate_feature_value_trends()))`;
        exec(`python3 -c ${JSON.stringify(pyScript)}`, { cwd: BASE_DIR, timeout: 60000 }, (err, stdout) => {
            if (err) return res.status(500).json({ error: err.message });
            try {
                res.json(JSON.parse(stdout.trim()));
            } catch (e) {
                res.status(500).json({ error: 'Failed to recalculate feature trends' });
            }
        });
    });

    // 35n. POST /api/lifecycle/auto-pilot — Execute automated lifecycle policies (auto-archive, auto-promote, auto-enqueue)
    router.post('/lifecycle/auto-pilot', (req, res) => {
        const { dry_run = false } = req.body || {};
        const pyScript = `from ss.lifecycle_actuator import execute_lifecycle_autopilot; import json; print(json.dumps(execute_lifecycle_autopilot(dry_run=${dry_run ? 'True' : 'False'})))`;
        exec(`python3 -c ${JSON.stringify(pyScript)}`, { cwd: BASE_DIR, timeout: 60000 }, (err, stdout) => {
            if (err) return res.status(500).json({ error: err.message });
            try {
                res.json(JSON.parse(stdout.trim()));
            } catch (e) {
                res.status(500).json({ error: 'Failed to execute lifecycle auto-pilot' });
            }
        });
    });

    // 35o. GET /api/features/dynamic-valuation — Return 5-vector utility index and optimality headroom
    router.get('/features/dynamic-valuation', (req, res) => {
        const pyScript = `from pathlib import Path; import json; p = Path('registry/audits/dynamic_valuation_audit.json'); from ss.dynamic_valuation_engine import evaluate_dynamic_valuations; print(p.read_text(encoding='utf-8') if p.exists() else json.dumps(evaluate_dynamic_valuations()))`;
        exec(`python3 -c ${JSON.stringify(pyScript)}`, { cwd: BASE_DIR }, (err, stdout) => {
            if (err) return res.status(500).json({ error: err.message });
            try {
                res.json(JSON.parse(stdout.trim()));
            } catch (e) {
                res.status(500).json({ error: 'Failed to read dynamic valuations' });
            }
        });
    });

    // 35p. POST /api/features/dynamic-valuation/recalculate — Recompute 5-vector utility index
    router.post('/features/dynamic-valuation/recalculate', (req, res) => {
        const pyScript = `from ss.dynamic_valuation_engine import evaluate_dynamic_valuations; import json; print(json.dumps(evaluate_dynamic_valuations()))`;
        exec(`python3 -c ${JSON.stringify(pyScript)}`, { cwd: BASE_DIR, timeout: 60000 }, (err, stdout) => {
            if (err) return res.status(500).json({ error: err.message });
            try {
                res.json(JSON.parse(stdout.trim()));
            } catch (e) {
                res.status(500).json({ error: 'Failed to recalculate dynamic valuations' });
            }
        });
    });

    // 35q. GET /api/intent — Return active Strategic Intent & Life Model manifest
    router.get('/intent', (req, res) => {
        const pyScript = `from ss.dynamic_valuation_engine import load_strategic_intent; import json; print(json.dumps(load_strategic_intent()))`;
        exec(`python3 -c ${JSON.stringify(pyScript)}`, { cwd: BASE_DIR }, (err, stdout) => {
            if (err) return res.status(500).json({ error: err.message });
            try {
                res.json(JSON.parse(stdout.trim()));
            } catch (e) {
                res.status(500).json({ error: 'Failed to read strategic intent manifest' });
            }
        });
    });

    // 35r. POST /api/intent/update — Update Strategic Intent & re-align entire valuation stack
    router.post('/intent/update', (req, res) => {
        const newManifest = req.body || {};
        const pyScript = `from pathlib import Path; import yaml; import json; Path('registry/strategic_intent.yaml').write_text(yaml.dump(${JSON.stringify(newManifest)}, sort_keys=False), encoding='utf-8'); from ss.dynamic_valuation_engine import evaluate_dynamic_valuations; from ss.lifecycle_actuator import execute_lifecycle_autopilot; v = evaluate_dynamic_valuations(); a = execute_lifecycle_autopilot(); print(json.dumps({'status': 'success', 'valuation': v, 'autopilot': a}))`;
        exec(`python3 -c ${JSON.stringify(pyScript)}`, { cwd: BASE_DIR, timeout: 60000 }, (err, stdout) => {
            if (err) return res.status(500).json({ error: err.message });
            try {
                res.json(JSON.parse(stdout.trim()));
            } catch (e) {
                res.status(500).json({ error: 'Failed to update strategic intent' });
            }
        });
    });

    // 35s. GET /api/alignment/questions — Return context-aware evolving questions
    router.get('/alignment/questions', (req, res) => {
        const { route = 'all' } = req.query || {};
        const pyScript = `from ss.features.operator_alignment_oracle import get_contextual_questions; import json; print(json.dumps(get_contextual_questions(${JSON.stringify(route)})))`;
        exec(`python3 -c ${JSON.stringify(pyScript)}`, { cwd: BASE_DIR }, (err, stdout) => {
            if (err) return res.status(500).json({ error: err.message });
            try {
                res.json(JSON.parse(stdout.trim()));
            } catch (e) {
                res.status(500).json({ error: 'Failed to fetch alignment questions' });
            }
        });
    });

    // 35t. POST /api/alignment/answer — Submit question answer & earn Alignment XP
    router.post('/alignment/answer', (req, res) => {
        const { question_id, answer_value, notes = '' } = req.body || {};
        const pyScript = `from ss.features.operator_alignment_oracle import submit_alignment_answer; import json; print(json.dumps(submit_alignment_answer(${JSON.stringify(question_id)}, ${JSON.stringify(answer_value)}, ${JSON.stringify(notes)})))`;
        exec(`python3 -c ${JSON.stringify(pyScript)}`, { cwd: BASE_DIR }, (err, stdout) => {
            if (err) return res.status(500).json({ error: err.message });
            try {
                res.json(JSON.parse(stdout.trim()));
            } catch (e) {
                res.status(500).json({ error: 'Failed to record alignment answer' });
            }
        });
    });

    // 35u. GET /api/alignment/profile — Get full alignment stats, level, and improvement proposals
    router.get('/alignment/profile', (req, res) => {
        const pyScript = `from ss.features.operator_alignment_oracle import get_operator_alignment_profile; import json; print(json.dumps(get_operator_alignment_profile()))`;
        exec(`python3 -c ${JSON.stringify(pyScript)}`, { cwd: BASE_DIR }, (err, stdout) => {
            if (err) return res.status(500).json({ error: err.message });
            try {
                res.json(JSON.parse(stdout.trim()));
            } catch (e) {
                res.status(500).json({ error: 'Failed to fetch alignment profile' });
            }
        });
    });

    // 35v. POST /api/alignment/adopt-suggestion — 1-Click enqueue improvement task in TASK_QUEUE.md
    router.post('/alignment/adopt-suggestion', (req, res) => {
        const { suggestion_id } = req.body || {};
        const pyScript = `from ss.features.operator_alignment_oracle import adopt_improvement_suggestion; import json; print(json.dumps(adopt_improvement_suggestion(${JSON.stringify(suggestion_id)})))`;
        exec(`python3 -c ${JSON.stringify(pyScript)}`, { cwd: BASE_DIR }, (err, stdout) => {
            if (err) return res.status(500).json({ error: err.message });
            try {
                res.json(JSON.parse(stdout.trim()));
            } catch (e) {
                res.status(500).json({ error: 'Failed to adopt improvement suggestion' });
            }
        });
    });

    // 35w. GET /api/alignment/resolutions — Return tracked determination states and confirmed policies
    router.get('/alignment/resolutions', (req, res) => {
        const pyScript = `from ss.features.operator_alignment_oracle import get_resolutions_ledger; import json; print(json.dumps(get_resolutions_ledger()))`;
        exec(`python3 -c ${JSON.stringify(pyScript)}`, { cwd: BASE_DIR }, (err, stdout) => {
            if (err) return res.status(500).json({ error: err.message });
            try {
                res.json(JSON.parse(stdout.trim()));
            } catch (e) {
                res.status(500).json({ error: 'Failed to fetch resolutions ledger' });
            }
        });
    });

    // 35x. GET /api/ui-evolution/proposals — Return UI evolution proposals & A/B staging state
    router.get('/ui-evolution/proposals', (req, res) => {
        const pyScript = `from ss.features.ui_evolution_engine import load_ui_proposals; import json; print(json.dumps(load_ui_proposals()))`;
        exec(`python3 -c ${JSON.stringify(pyScript)}`, { cwd: BASE_DIR }, (err, stdout) => {
            if (err) return res.status(500).json({ error: err.message });
            try {
                res.json(JSON.parse(stdout.trim()));
            } catch (e) {
                res.status(500).json({ error: 'Failed to fetch UI proposals' });
            }
        });
    });

    // 35y. POST /api/ui-evolution/feedback — Record operator feedback and refinements on a staged proposal
    router.post('/ui-evolution/feedback', (req, res) => {
        const { proposal_id, feedback_text, rating = 5 } = req.body || {};
        const pyScript = `from ss.features.ui_evolution_engine import submit_ui_feedback; import json; print(json.dumps(submit_ui_feedback(${JSON.stringify(proposal_id)}, ${JSON.stringify(feedback_text)}, rating=${rating})))`;
        exec(`python3 -c ${JSON.stringify(pyScript)}`, { cwd: BASE_DIR }, (err, stdout) => {
            if (err) return res.status(500).json({ error: err.message });
            try {
                res.json(JSON.parse(stdout.trim()));
            } catch (e) {
                res.status(500).json({ error: 'Failed to record UI feedback' });
            }
        });
    });

    // 35z. POST /api/ui-evolution/stage — Toggle proposal staging in Environment B
    router.post('/ui-evolution/stage', (req, res) => {
        const { proposal_id, stage_in_b = true } = req.body || {};
        const pyScript = `from ss.features.ui_evolution_engine import set_proposal_staging_state; import json; print(json.dumps(set_proposal_staging_state(${JSON.stringify(proposal_id)}, stage_in_b=${stage_in_b ? 'True' : 'False'})))`;
        exec(`python3 -c ${JSON.stringify(pyScript)}`, { cwd: BASE_DIR }, (err, stdout) => {
            if (err) return res.status(500).json({ error: err.message });
            try {
                res.json(JSON.parse(stdout.trim()));
            } catch (e) {
                res.status(500).json({ error: 'Failed to toggle staging state' });
            }
        });
    });

    // 35aa. POST /api/ui-evolution/promote — Promote proposal from Environment B to Production Environment A
    router.post('/ui-evolution/promote', (req, res) => {
        const { proposal_id } = req.body || {};
        const pyScript = `from ss.features.ui_evolution_engine import promote_proposal_to_production; import json; print(json.dumps(promote_proposal_to_production(${JSON.stringify(proposal_id)})))`;
        exec(`python3 -c ${JSON.stringify(pyScript)}`, { cwd: BASE_DIR }, (err, stdout) => {
            if (err) return res.status(500).json({ error: err.message });
            try {
                res.json(JSON.parse(stdout.trim()));
            } catch (e) {
                res.status(500).json({ error: 'Failed to promote proposal' });
            }
        });
    });

    // 35ab. POST /api/ui-evolution/detect-friction — Scan UI components for friction
    router.post('/ui-evolution/detect-friction', (req, res) => {
        const pyScript = `from ss.features.ui_evolution_engine import detect_ui_friction; import json; print(json.dumps(detect_ui_friction()))`;
        exec(`python3 -c ${JSON.stringify(pyScript)}`, { cwd: BASE_DIR }, (err, stdout) => {
            if (err) return res.status(500).json({ error: err.message });
            try {
                res.json(JSON.parse(stdout.trim()));
            } catch (e) {
                res.status(500).json({ error: 'Failed to scan UI friction' });
            }
        });
    });

    // 35ac. POST /api/intent/resolve — Open Natural Language Intent Resolver
    router.post('/intent/resolve', (req, res) => {
        const { prompt = '' } = req.body || {};
        const pyScript = `from ss.features.natural_intent_resolver import resolve_natural_intent; import json; print(json.dumps(resolve_natural_intent(${JSON.stringify(prompt)})))`;
        exec(`python3 -c ${JSON.stringify(pyScript)}`, { cwd: BASE_DIR }, (err, stdout) => {
            if (err) return res.status(500).json({ error: err.message });
            try {
                res.json(JSON.parse(stdout.trim()));
            } catch (e) {
                res.status(500).json({ error: 'Failed to resolve intent' });
            }
        });
    });

    // 35ad. POST /api/meta/simulate — Execute hypothetical scenario simulation
    router.post('/meta/simulate', (req, res) => {
        const { hypothesis = '', scenario_params = null, session_id = null } = req.body || {};
        const pyScript = `from ss.features.meta_alignment_simulator import simulate_meta_scenario; import json; print(json.dumps(simulate_meta_scenario(${JSON.stringify(hypothesis)}, ${scenario_params ? JSON.stringify(scenario_params) : 'None'}, ${session_id ? JSON.stringify(session_id) : 'None'})))`;
        exec(`python3 -c ${JSON.stringify(pyScript)}`, { cwd: BASE_DIR }, (err, stdout) => {
            if (err) return res.status(500).json({ error: err.message });
            try {
                res.json(JSON.parse(stdout.trim()));
            } catch (e) {
                res.status(500).json({ error: 'Failed to simulate meta scenario' });
            }
        });
    });

    // 35ae. GET /api/meta/sessions — Load meta simulation sessions and hypothesis trees
    router.get('/meta/sessions', (req, res) => {
        const pyScript = `from ss.features.meta_alignment_simulator import load_meta_sessions; import json; print(json.dumps(load_meta_sessions()))`;
        exec(`python3 -c ${JSON.stringify(pyScript)}`, { cwd: BASE_DIR }, (err, stdout) => {
            if (err) return res.status(500).json({ error: err.message });
            try {
                res.json(JSON.parse(stdout.trim()));
            } catch (e) {
                res.status(500).json({ error: 'Failed to load meta sessions' });
            }
        });
    });

    // 35af. POST /api/meta/revert — Step back hypothesis branch
    router.post('/meta/revert', (req, res) => {
        const { session_id = null } = req.body || {};
        const pyScript = `from ss.features.meta_alignment_simulator import step_back_hypothesis; import json; print(json.dumps(step_back_hypothesis(${session_id ? JSON.stringify(session_id) : 'None'})))`;
        exec(`python3 -c ${JSON.stringify(pyScript)}`, { cwd: BASE_DIR }, (err, stdout) => {
            if (err) return res.status(500).json({ error: err.message });
            try {
                res.json(JSON.parse(stdout.trim()));
            } catch (e) {
                res.status(500).json({ error: 'Failed to revert hypothesis' });
            }
        });
    });

    // 35ag. POST /api/meta/adopt — Commit Meta Intent to Production with cryptographic snapshot
    router.post('/meta/adopt', (req, res) => {
        const { session_id = null } = req.body || {};
        const pyScript = `from ss.features.meta_alignment_simulator import adopt_meta_intent_to_production; import json; print(json.dumps(adopt_meta_intent_to_production(${session_id ? JSON.stringify(session_id) : 'None'})))`;
        exec(`python3 -c ${JSON.stringify(pyScript)}`, { cwd: BASE_DIR }, (err, stdout) => {
            if (err) return res.status(500).json({ error: err.message });
            try {
                res.json(JSON.parse(stdout.trim()));
            } catch (e) {
                res.status(500).json({ error: 'Failed to adopt meta intent' });
            }
        });
    });

    // 35ah. POST /api/help/query — Universal System Help & Walkthrough Generator
    router.post('/help/query', (req, res) => {
        const { question = '' } = req.body || {};
        const pyScript = `from ss.features.system_help_engine import query_system_help; import json; print(json.dumps(query_system_help(${JSON.stringify(question)})))`;
        exec(`python3 -c ${JSON.stringify(pyScript)}`, { cwd: BASE_DIR }, (err, stdout) => {
            if (err) return res.status(500).json({ error: err.message });
            try {
                res.json(JSON.parse(stdout.trim()));
            } catch (e) {
                res.status(500).json({ error: 'Failed to generate system help' });
            }
        });
    });

    // 36. POST /api/consideration/inspect-manifest — Live dependency & manifest risk analysis










    router.post('/consideration/inspect-manifest', (req, res) => {

        const { metadata = {} } = req.body || {};
        const pyScript = `from ss.capability import PackageManifestInspector; import json; print(json.dumps(PackageManifestInspector.inspect_metadata(${JSON.stringify(metadata)})))`;
        exec(`python3 -c ${JSON.stringify(pyScript)}`, { cwd: BASE_DIR }, (err, stdout) => {
            if (err) return res.status(500).json({ error: err.message });
            try {
                res.json(JSON.parse(stdout.trim()));
            } catch (e) {
                res.status(500).json({ error: 'Failed to parse manifest analysis' });
            }
        });
    });

    // 37. POST /api/consideration/generate-routing-rule — Auto-generates coexistence routing contract
    router.post('/consideration/generate-routing-rule', (req, res) => {
        const { candidate_id, candidate_title = '', domain_eval = {} } = req.body || {};
        if (!candidate_id) return res.status(400).json({ error: 'candidate_id is required' });

        const pyScript = `from ss.capability import CoexistenceGatewayRuleGenerator; import json; print(json.dumps(CoexistenceGatewayRuleGenerator.generate_and_save_routing_rule(${JSON.stringify(candidate_id)}, ${JSON.stringify(candidate_title)}, ${JSON.stringify(domain_eval)})))`;
        exec(`python3 -c ${JSON.stringify(pyScript)}`, { cwd: BASE_DIR }, (err, stdout) => {
            if (err) return res.status(500).json({ error: err.message });
            try {
                res.json({ success: true, rule: JSON.parse(stdout.trim()) });
            } catch (e) {
                res.status(500).json({ error: 'Failed to generate routing rule' });
            }
        });
    });

    // 38. POST /api/consideration/export-to-backlog — Exports candidate critique to Grounded Improvement Backlog
    router.post('/consideration/export-to-backlog', (req, res) => {
        const { candidate_id, eval_data = {} } = req.body || {};
        if (!candidate_id) return res.status(400).json({ error: 'candidate_id is required' });

        const pyScript = `from ss.capability import export_candidate_to_improvement_backlog; import json; print(json.dumps(export_candidate_to_improvement_backlog(${JSON.stringify(candidate_id)}, ${JSON.stringify(eval_data)})))`;
        exec(`python3 -c ${JSON.stringify(pyScript)}`, { cwd: BASE_DIR }, (err, stdout) => {
            if (err) return res.status(500).json({ error: err.message });
            try {
                res.json(JSON.parse(stdout.trim()));
            } catch (e) {
                res.status(500).json({ error: 'Failed to export candidate to backlog' });
            }
        });
    });

    // 39. POST /api/audit/verify-consensus — Dual-model consensus verification on P1 patches
    router.post('/audit/verify-consensus', (req, res) => {
        const { improvement = {} } = req.body || {};
        const pyScript = `from ss.grounded_eval import dual_model_verifier; import json; print(json.dumps(dual_model_verifier.verify_patch_consensus(${JSON.stringify(improvement)})))`;
        exec(`python3 -c ${JSON.stringify(pyScript)}`, { cwd: BASE_DIR }, (err, stdout) => {
            if (err) return res.status(500).json({ error: err.message });
            try {
                res.json(JSON.parse(stdout.trim()));
            } catch (e) {
                res.status(500).json({ error: 'Failed to execute dual-model verification' });
            }
        });
    });

    // 40. POST /api/consideration/extract — Targeted feature extraction spec generator
    router.post('/consideration/extract', (req, res) => {
        const { item_id } = req.body || {};
        if (!item_id) return res.status(400).json({ error: 'item_id is required' });

        const pyScript = `from ss.consider import extract_feature_spec; import json; print(json.dumps(extract_feature_spec(${JSON.stringify(item_id)})))`;
        exec(`python3 -c ${JSON.stringify(pyScript)}`, { cwd: BASE_DIR }, (err, stdout) => {
            if (err) return res.status(500).json({ error: err.message });
            try {
                const spec = JSON.parse(stdout.trim());
                res.json({ status: 'extracted', item_id, spec });
            } catch (e) {
                res.status(500).json({ error: 'Failed to parse extracted spec' });
            }
        });
    });

    // 41. POST /api/consideration/compile — Synthesizes skill module and MCP binding
    router.post('/consideration/compile', (req, res) => {
        const { item_id } = req.body || {};
        if (!item_id) return res.status(400).json({ error: 'item_id is required' });

        const pyScript = `from ss.consider import compile_skill; import json; print(json.dumps(compile_skill(${JSON.stringify(item_id)})))`;
        exec(`python3 -c ${JSON.stringify(pyScript)}`, { cwd: BASE_DIR }, (err, stdout) => {
            if (err) return res.status(500).json({ error: err.message });
            try {
                res.json(JSON.parse(stdout.trim()));
            } catch (e) {
                res.status(500).json({ error: 'Failed to compile skill' });
            }
        });
    });

    // 42. POST /api/consideration/clone-source — Clones upstream repo for raw AST inspection
    router.post('/consideration/clone-source', (req, res) => {
        const { item_id } = req.body || {};
        if (!item_id) return res.status(400).json({ error: 'item_id is required' });

        const pyScript = `from ss.consider import clone_candidate_repo; import json; print(json.dumps(clone_candidate_repo(${JSON.stringify(item_id)})))`;
        exec(`python3 -c ${JSON.stringify(pyScript)}`, { cwd: BASE_DIR }, (err, stdout) => {
            if (err) return res.status(500).json({ error: err.message });
            try {
                res.json(JSON.parse(stdout.trim()));
            } catch (e) {
                res.status(500).json({ error: 'Failed to clone upstream source' });
            }
        });
    });

    // 43. POST /api/consideration/deploy-skill — Atomic deploy with AST check and smoke test
    router.post('/consideration/deploy-skill', (req, res) => {
        const { item_id, core_module, mcp_binding } = req.body || {};
        if (!item_id || !core_module || !mcp_binding) {
            return res.status(400).json({ error: 'item_id, core_module, and mcp_binding are required' });
        }

        const pyScript = `from ss.consider import deploy_skill; import json; print(json.dumps(deploy_skill(${JSON.stringify(item_id)}, ${JSON.stringify(core_module)}, ${JSON.stringify(mcp_binding)})))`;
        exec(`python3 -c ${JSON.stringify(pyScript)}`, { cwd: BASE_DIR }, (err, stdout) => {
            if (err) return res.status(500).json({ error: err.message });
            try {
                res.json(JSON.parse(stdout.trim()));
            } catch (e) {
                res.status(500).json({ error: 'Failed to deploy skill' });
            }
        });
    });

    // 44. POST /api/consideration/rollback-skill — 1-click rollback with audit journal
    router.post('/consideration/rollback-skill', (req, res) => {
        const { item_id } = req.body || {};
        if (!item_id) return res.status(400).json({ error: 'item_id is required' });

        const pyScript = `from ss.consider import rollback_skill; import json; print(json.dumps(rollback_skill(${JSON.stringify(item_id)})))`;
        exec(`python3 -c ${JSON.stringify(pyScript)}`, { cwd: BASE_DIR }, (err, stdout) => {
            if (err) return res.status(500).json({ error: err.message });
            try {
                res.json(JSON.parse(stdout.trim()));
            } catch (e) {
                res.status(500).json({ error: 'Failed to roll back skill' });
            }
        });
    });

    // 45. POST /api/consideration/deploy — Enqueues candidate as structured task into TASK_QUEUE.md
    router.post('/consideration/deploy', (req, res) => {
        const { item_id } = req.body || {};
        if (!item_id) return res.status(400).json({ error: 'item_id is required' });

        const pyScript = `from ss.consider import deploy_item_as_task; import json; res = deploy_item_as_task(${JSON.stringify(item_id)}); print(json.dumps({'status': 'deployed', 'task_id': res, 'item_id': ${JSON.stringify(item_id)}}))`;
        exec(`python3 -c ${JSON.stringify(pyScript)}`, { cwd: BASE_DIR }, (err, stdout) => {
            if (err) return res.status(500).json({ error: err.message });
            try {
                res.json(JSON.parse(stdout.trim()));
            } catch (e) {
                res.status(500).json({ error: 'Failed to deploy task to queue' });
            }
        });
    });

    // 46. GET /api/prompts/experts — Retrieves curated 12 expert self-improvement prompts
    router.get('/prompts/experts', (req, res) => {
        const pyScript = `import yaml, json, pathlib; p = pathlib.Path(${JSON.stringify(BASE_DIR)}) / 'registry' / 'prompts' / 'expert_improvement_prompts.yaml'; print(json.dumps(yaml.safe_load(p.read_text()) if p.exists() else {'experts': []}))`;
        exec(`python3 -c ${JSON.stringify(pyScript)}`, { cwd: BASE_DIR }, (err, stdout) => {
            if (err) return res.status(500).json({ error: err.message });
            try {
                res.json(JSON.parse(stdout.trim()));
            } catch (e) {
                res.status(500).json({ error: 'Failed to parse expert prompts' });
            }
        });
    });

    // 47. GET /api/cadence/status — Returns live deterministic verification pipeline & next-step cadence
    // 47. GET /api/cadence/status — Returns live 5-stage verification & UI canary telemetry
    router.get('/cadence/status', (req, res) => {
        const pyScript = `import json, pathlib; p = pathlib.Path(${JSON.stringify(BASE_DIR)}) / 'registry' / 'audits' / 'pipeline_cadence.json'; u = pathlib.Path(${JSON.stringify(BASE_DIR)}) / 'registry' / 'audits' / 'ui_verification.json'; c = json.loads(p.read_text()) if p.exists() else {'status': 'idle', 'current_stage': 'Idle / Monitoring', 'next_stage': 'Next Scheduled Cycle (120s)'}; c['ui_canary'] = json.loads(u.read_text()).get('last_run') if u.exists() else None; print(json.dumps(c))`;
        exec(`python3 -c ${JSON.stringify(pyScript)}`, { cwd: BASE_DIR }, (err, stdout) => {
            if (err) return res.status(500).json({ error: err.message });
            try {
                res.json(JSON.parse(stdout.trim()));
            } catch (e) {
                res.status(500).json({ error: 'Failed to parse cadence status' });
            }
        });
    });

    // 48. GET /api/capabilities/compounded-playbooks — Returns reflexive compounded playbooks synthesized by flywheel
    router.get('/capabilities/compounded-playbooks', (req, res) => {
        const pyScript = `import json, pathlib; p = pathlib.Path(${JSON.stringify(BASE_DIR)}) / 'registry' / 'capabilities' / 'compounded_playbooks.json'; print(p.read_text() if p.exists() else json.dumps({'compounded_playbooks': []}))`;
        exec(`python3 -c ${JSON.stringify(pyScript)}`, { cwd: BASE_DIR }, (err, stdout) => {
            if (err) return res.status(500).json({ error: err.message });
            try {
                res.json(JSON.parse(stdout.trim()));
            } catch (e) {
                res.status(500).json({ error: 'Failed to parse compounded playbooks' });
            }
        });
    });

    // 48b. GET /api/cadence/recording — Streams the latest walkthrough .webm video recording
    router.get('/cadence/recording', (req, res) => {
        const videoPath = path.join(BASE_DIR, 'public', 'walkthrough_recording.webm');
        if (fs.existsSync(videoPath)) {
            res.sendFile(videoPath);
        } else {
            res.status(404).json({ error: 'No video recording found' });
        }
    });

    // 48c. GET /api/demos/manifest — Returns native SolidStack feature demos catalog from SQLite Unified DB
    router.get('/demos/manifest', (req, res) => {
        exec(`python3 -m ss.features.native_api_bridge get_demos_manifest`, { cwd: BASE_DIR }, (err, stdout) => {
            if (err) return res.status(500).json({ error: err.message });
            try {
                res.json(JSON.parse(stdout.trim()));
            } catch (e) {
                res.status(500).json({ error: 'Failed to retrieve demos manifest' });
            }
        });
    });

    // 48d. GET /api/demos/video/:name — Streams native feature demo video from registry/demos/recordings/
    router.get('/demos/video/:name', (req, res) => {
        const videoPath = path.join(BASE_DIR, 'registry', 'demos', 'recordings', req.params.name);
        if (fs.existsSync(videoPath)) {
            res.sendFile(videoPath);
        } else {
            res.status(404).json({ error: `Video ${req.params.name} not found` });
        }
    });

    // 48e. POST /api/demos/record/:id — Records feature demo on demand
    router.post('/demos/record/:id', (req, res) => {
        const pyScript = `from ss.features.demo_recorder import record_feature_demo; import json; print(json.dumps(record_feature_demo(${JSON.stringify(req.params.id)})))`;
        exec(`python3 -c ${JSON.stringify(pyScript)}`, { cwd: BASE_DIR }, (err, stdout) => {
            if (err) return res.status(500).json({ error: err.message });
            try {
                res.json(JSON.parse(stdout.trim()));
            } catch (e) {
                res.status(500).json({ error: 'Failed to record demo' });
            }
        });
    });

    // 49. GET /api/memory/anchor — Returns current mental context anchor via NativeApiBridge
    router.get('/memory/anchor', (req, res) => {
        exec(`python3 -m ss.features.native_api_bridge get_mental_context_anchor`, { cwd: BASE_DIR }, (err, stdout) => {
            if (err) return res.status(500).json({ error: err.message });
            try {
                res.json(JSON.parse(stdout.trim()));
            } catch (e) {
                res.status(500).json({ error: 'Failed to retrieve context anchor' });
            }
        });
    });

    // 50. POST /api/playbooks/run — Executes a compounded playbook
    router.post('/playbooks/run', (req, res) => {
        const { playbook_name, business, capacity, current_bookings, broad_task, energy_level } = req.body || {};
        const pyScript = `from ss.features.compound_playbook_runner import execute_playbook; import json; res = execute_playbook(${JSON.stringify(playbook_name || '')}, business=${JSON.stringify(business || 'Prettypaws Pet Grooming')}, capacity=${parseInt(capacity || 14)}, current_bookings=${parseInt(current_bookings || 8)}, broad_task=${JSON.stringify(broad_task || 'Review operations')}, energy_level=${parseInt(energy_level || 35)}); print(json.dumps(res))`;
        exec(`python3 -c ${JSON.stringify(pyScript)}`, { cwd: BASE_DIR }, (err, stdout) => {
            if (err) return res.status(500).json({ error: err.message });
            try {
                res.json(JSON.parse(stdout.trim()));
            } catch (e) {
                res.status(500).json({ error: 'Failed to execute playbook' });
            }
        });
    });

    // 51. GET /api/experiments/history — Returns empirical A/B experiment records via NativeApiBridge
    router.get('/experiments/history', (req, res) => {
        exec(`python3 -m ss.features.native_api_bridge get_empirical_history`, { cwd: BASE_DIR }, (err, stdout) => {
            if (err) return res.status(500).json({ error: err.message });
            try {
                res.json(JSON.parse(stdout.trim()));
            } catch (e) {
                res.status(500).json({ error: 'Failed to retrieve empirical experiments' });
            }
        });
    });

    // 52. GET /api/canary/status — Returns headless UI canary verification history
    router.get('/canary/status', (req, res) => {
        const pyScript = `import json, pathlib; p = pathlib.Path(${JSON.stringify(BASE_DIR)}) / 'registry' / 'audits' / 'ui_verification.json'; print(p.read_text() if p.exists() else json.dumps({'total_runs': 0, 'history': []}))`;
        exec(`python3 -c ${JSON.stringify(pyScript)}`, { cwd: BASE_DIR }, (err, stdout) => {
            if (err) return res.status(500).json({ error: err.message });
            try {
                res.json(JSON.parse(stdout.trim()));
            } catch (e) {
                res.status(500).json({ error: 'Failed to retrieve canary status' });
            }
        });
    });

    // 53. POST /api/canary/run — Executes synthetic user flows in headless browser
    router.post('/canary/run', (req, res) => {
        const pyScript = `from ss.features.headless_ui_canary import run_ui_canary; import json; print(json.dumps(run_ui_canary()))`;
        exec(`python3 -c ${JSON.stringify(pyScript)}`, { cwd: BASE_DIR }, (err, stdout) => {
            if (err) return res.status(500).json({ error: err.message });
            try {
                res.json(JSON.parse(stdout.trim()));
            } catch (e) {
                res.status(500).json({ error: 'Failed to execute UI canary' });
            }
        });
    });

    // 54. POST /api/features/shape — Interactively sculpts a component feature via NativeApiBridge
    router.post('/features/shape', (req, res) => {
        const payload = JSON.stringify(req.body || {});
        exec(`python3 -m ss.features.native_api_bridge shape_feature ${JSON.stringify(payload)}`, { cwd: BASE_DIR }, (err, stdout) => {
            if (err) return res.status(500).json({ error: err.message });
            try {
                res.json(JSON.parse(stdout.trim()));
            } catch (e) {
                res.status(500).json({ error: 'Failed to shape feature' });
            }
        });
    });

    // 55. POST /api/features/merge-selected — Merges selected/shaped components into SQLite Unified DB
    router.post('/features/merge-selected', (req, res) => {
        const payload = JSON.stringify({ selected_ids: (req.body && req.body.selected_ids) || [] });
        exec(`python3 -m ss.features.native_api_bridge merge_selected_features ${JSON.stringify(payload)}`, { cwd: BASE_DIR }, (err, stdout) => {
            if (err) return res.status(500).json({ error: err.message });
            try {
                res.json(JSON.parse(stdout.trim()));
            } catch (e) {
                res.status(500).json({ error: 'Failed to execute selective merge' });
            }
        });
    });

    // 56. POST /api/agent/synthesize — Synthesizes component changes and stages in Environment B
    router.post('/agent/synthesize', (req, res) => {
        const directive = (req.body && req.body.directive) || 'Enlarge SolidBot on click';
        exec(`python3 -m ss.features.autonomous_agent_coder synthesize ${JSON.stringify(directive)}`, { cwd: BASE_DIR }, (err, stdout) => {
            if (err) return res.status(500).json({ error: err.message });
            try {
                res.json(JSON.parse(stdout.trim()));
            } catch (e) {
                res.status(500).json({ error: 'Failed to parse agent synthesis output' });
            }
        });
    });

    return router;
}


