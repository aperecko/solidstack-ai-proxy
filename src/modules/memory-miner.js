import fs from 'fs';
import path from 'path';
import os from 'os';
import { logger } from '../utils/logger.js';

const BRAIN_DIR = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
const CONFIG_DIR = path.join(os.homedir(), '.config', 'antigravity-proxy');
const PENDING_RULES_PATH = path.join(CONFIG_DIR, 'pending-rules.json');

const MINER_MODEL = 'gemini-3.7-flash-medium';

/**
 * Parses past transcripts to find corrections and implicit rules.
 */
export async function runMemoryMiner(limit = 10) {
    logger.info(`[MemoryMiner] Starting historical transcript scan (limit: ${limit})...`);
    
    if (!fs.existsSync(CONFIG_DIR)) {
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }

    let pendingRules = [];
    if (fs.existsSync(PENDING_RULES_PATH)) {
        try { pendingRules = JSON.parse(fs.readFileSync(PENDING_RULES_PATH, 'utf8')); } catch {}
    }

    if (!fs.existsSync(BRAIN_DIR)) {
        logger.warn(`[MemoryMiner] Brain directory not found at ${BRAIN_DIR}`);
        return;
    }

    const convDirs = fs.readdirSync(BRAIN_DIR).filter(d => fs.statSync(path.join(BRAIN_DIR, d)).isDirectory());
    // Sort by modified time (newest first)
    convDirs.sort((a, b) => fs.statSync(path.join(BRAIN_DIR, b)).mtimeMs - fs.statSync(path.join(BRAIN_DIR, a)).mtimeMs);

    const targetDirs = convDirs.slice(0, limit);
    let extractedCount = 0;

    for (const convId of targetDirs) {
        const transcriptPath = path.join(BRAIN_DIR, convId, '.system_generated', 'logs', 'transcript.jsonl');
        if (!fs.existsSync(transcriptPath)) continue;

        logger.info(`[MemoryMiner] Mining conversation: ${convId}`);
        const lines = fs.readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean);
        
        // Extract user inputs and planner responses for context
        let conversationText = '';
        for (const line of lines.slice(-20)) { // look at last 20 turns
            try {
                const parsed = JSON.parse(line);
                if (parsed.type === 'USER_INPUT' || parsed.type === 'PLANNER_RESPONSE') {
                    const role = parsed.type === 'USER_INPUT' ? 'User' : 'Agent';
                    const content = typeof parsed.content === 'string' ? parsed.content : JSON.stringify(parsed.content);
                    conversationText += `${role}: ${content.substring(0, 500)}\n`;
                }
            } catch (e) {}
        }

        if (conversationText.length < 50) continue;

        // Ask Flash to extract rules
        const prompt = `Analyze the following conversation snippet between a user and an AI coding agent.
Look specifically for moments where the user corrected the agent, expressed a strong preference, or established a recurring rule (e.g., "always do X", "you forgot to bump the version").

Conversation:
\`\`\`
${conversationText}
\`\`\`

If you find a rule or preference, extract it into a JSON array of objects with the following schema:
[
  {
    "rule": "The explicit instruction the agent should follow.",
    "keywords": ["keyword1", "keyword2"],
    "historical_prompt": "A brief example of a prompt where this rule would be relevant, derived from the context."
  }
]

If no rules are found, output an empty array [].
Respond ONLY with the JSON array.`;

        try {
            const res = await fetch('http://127.0.0.1:1987/v1/messages', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer internal-miner' },
                body: JSON.stringify({
                    model: MINER_MODEL,
                    messages: [{ role: 'user', content: prompt }],
                    max_tokens: 500
                })
            });

            if (res.ok) {
                const data = await res.json();
                const text = data.content?.[0]?.text || '';
                const jsonMatch = text.match(/\[[\s\S]*\]/);
                
                if (jsonMatch) {
                    const rules = JSON.parse(jsonMatch[0]);
                    for (const r of rules) {
                        if (r.rule && r.keywords) {
                            r.id = `rule_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
                            r.source_conv = convId;
                            r.created_at = new Date().toISOString();
                            pendingRules.push(r);
                            extractedCount++;
                            logger.info(`[MemoryMiner] Extracted rule: ${r.rule.substring(0, 50)}...`);
                        }
                    }
                }
            }
        } catch (e) {
            logger.warn(`[MemoryMiner] Failed to mine ${convId}: ${e.message}`);
        }
    }

    fs.writeFileSync(PENDING_RULES_PATH, JSON.stringify(pendingRules, null, 2), 'utf8');
    logger.success(`[MemoryMiner] Scan complete. Extracted ${extractedCount} new pending rules.`);
}

// Allow running standalone via CLI: node ai-proxy/src/modules/memory-miner.js
if (import.meta.url === `file://${process.argv[1]}`) {
    runMemoryMiner().then(() => process.exit(0));
}
