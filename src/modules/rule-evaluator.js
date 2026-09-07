import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { logger } from '../utils/logger.js';

const CONFIG_DIR = path.join(os.homedir(), '.config', 'antigravity-proxy');
const PENDING_RULES_PATH = path.join(CONFIG_DIR, 'pending-rules.json');
const ACTIVE_RULES_PATH = path.join(CONFIG_DIR, 'active-rules.json');

const EVAL_MODEL = 'gemini-2.5-flash';
const JUDGE_MODELS = ['gemini-2.5-flash', 'claude-3-5-haiku-20241022'];
const LOCAL_BACKSTOP = 'glm-5.2:cloud';

/**
 * Executes a single prompt against the proxy with automatic Local Backstop failover.
 */
async function generateResponse(prompt, systemInstruction = null, targetModel = EVAL_MODEL, isFallback = false) {
    const messages = [{ role: 'user', content: prompt }];
    const payload = {
        model: targetModel,
        messages,
        max_tokens: 800
    };
    
    if (systemInstruction) {
        payload.system = systemInstruction;
    }

    try {
        const res = await fetch('http://127.0.0.1:1987/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer internal-evaluator' },
            body: JSON.stringify(payload)
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        
        const data = await res.json();
        return data.content?.[0]?.text || '';
    } catch (e) {
        if (!isFallback) {
            logger.warn(`[RuleEvaluator] Cloud execution failed (${e.message}). Failing over to Local Backstop: ${LOCAL_BACKSTOP}`);
            return generateResponse(prompt, systemInstruction, LOCAL_BACKSTOP, true);
        }
        throw new Error(`Fallback generation failed: ${e.message}`);
    }
}

/**
 * Deterministic Syntax Veto. 
 * Extracts code blocks and mechanically verifies they compile/parse.
 */
function checkSyntax(text) {
    try {
        const jsMatch = text.match(/```(?:javascript|js)\n([\s\S]*?)```/);
        if (jsMatch) {
            const tmpPath = path.join(os.tmpdir(), `eval_test_${Date.now()}.js`);
            fs.writeFileSync(tmpPath, jsMatch[1]);
            execSync(`node -c ${tmpPath}`, { stdio: 'ignore' });
            fs.unlinkSync(tmpPath);
        }
        const pyMatch = text.match(/```python\n([\s\S]*?)```/);
        if (pyMatch) {
            const tmpPath = path.join(os.tmpdir(), `eval_test_${Date.now()}.py`);
            fs.writeFileSync(tmpPath, pyMatch[1]);
            execSync(`python3 -m py_compile ${tmpPath}`, { stdio: 'ignore' });
            fs.unlinkSync(tmpPath);
        }
        return true;
    } catch (e) {
        return false;
    }
}

/**
 * Runs side-by-side A/B test on pending rules to validate their quality impact.
 */
export async function evaluatePendingRules() {
    logger.info(`[RuleEvaluator] Starting Harmonized QC evaluation of pending rules...`);

    if (!fs.existsSync(PENDING_RULES_PATH)) return;

    let pendingRules = [];
    try { pendingRules = JSON.parse(fs.readFileSync(PENDING_RULES_PATH, 'utf8')); } catch {}

    let activeRules = [];
    if (fs.existsSync(ACTIVE_RULES_PATH)) {
        try { activeRules = JSON.parse(fs.readFileSync(ACTIVE_RULES_PATH, 'utf8')); } catch {}
    }

    const remainingPending = [];
    let promotedCount = 0;

    for (const ruleObj of pendingRules) {
        logger.info(`[RuleEvaluator] Evaluating rule: ${ruleObj.rule.substring(0, 50)}...`);
        const historicalPrompt = ruleObj.historical_prompt || `I need you to write some code regarding ${ruleObj.keywords.join(', ')}.`;

        try {
            // Stage 1a: Generate Responses
            const controlText = await generateResponse(historicalPrompt);
            const systemRule = `[DYNAMIC RULE: You MUST strictly adhere to this preference: ${ruleObj.rule}]`;
            const testText = await generateResponse(historicalPrompt, systemRule);

            // Stage 1b: Deterministic Syntax Veto
            const controlSyntaxOk = checkSyntax(controlText);
            const testSyntaxOk = checkSyntax(testText);

            if (controlSyntaxOk && !testSyntaxOk) {
                logger.warn(`[RuleEvaluator] Deterministic Veto Triggered! Rule degraded code syntax. Discarding.`);
                continue; // Vetoed, drop the rule
            }

            // Stage 2: Dual-Model Adversarial Cross-Examination
            const judgePrompt = (response) => `[SYSTEM_JUDGE]
You are an expert AI quality assurance judge. 
Grade the quality of this response on a scale of 0.0 to 1.0. 
Pay close attention to whether it adheres to implicit best practices related to: ${ruleObj.keywords.join(', ')}.
User Prompt: ${historicalPrompt}
AI Response: ${response.substring(0, 2000)}

Respond ONLY with JSON: {"score": 0.8, "reason": "..."}`;

            let controlScores = [];
            let testScores = [];

            for (const judgeModel of JUDGE_MODELS) {
                logger.info(`[RuleEvaluator] Requesting verdict from adversarial judge: ${judgeModel}`);
                const cEval = await generateResponse(judgePrompt(controlText), null, judgeModel);
                const tEval = await generateResponse(judgePrompt(testText), null, judgeModel);
                
                try { controlScores.push(JSON.parse(cEval.match(/\{[\s\S]*\}/)[0]).score); } catch { controlScores.push(0.5); }
                try { testScores.push(JSON.parse(tEval.match(/\{[\s\S]*\}/)[0]).score); } catch { testScores.push(0.5); }
            }

            const cScore1 = controlScores[0], cScore2 = controlScores[1];
            const tScore1 = testScores[0], tScore2 = testScores[1];
            
            // Check Consensus Delta
            if (Math.abs(tScore1 - tScore2) > 0.3) {
                logger.warn(`[RuleEvaluator] Consensus failure (Delta > 0.3). Judges disagreed wildly. Discarding for safety.`);
                continue; // Vetoed due to lack of consensus
            }

            const finalControlScore = (cScore1 + cScore2) / 2;
            const finalTestScore = (tScore1 + tScore2) / 2;

            logger.info(`[RuleEvaluator] Final Consensus -> Control: ${finalControlScore.toFixed(2)}, Test: ${finalTestScore.toFixed(2)}`);

            // 4. Decide promotion
            if (finalTestScore > finalControlScore || (finalTestScore === finalControlScore && finalTestScore >= 0.8)) {
                logger.success(`[RuleEvaluator] Rule validated! Promoting to active ledger.`);
                ruleObj.validated_at = new Date().toISOString();
                ruleObj.qc_scores = { control: finalControlScore, test: finalTestScore };
                activeRules.push(ruleObj);
                promotedCount++;
            } else {
                logger.warn(`[RuleEvaluator] Rule failed QC (did not improve output). Discarding.`);
            }

        } catch (e) {
            logger.error(`[RuleEvaluator] Evaluation error for rule ${ruleObj.id}: ${e.message}`);
            remainingPending.push(ruleObj); // Keep in pending if error occurred
        }
    }

    fs.writeFileSync(PENDING_RULES_PATH, JSON.stringify(remainingPending, null, 2), 'utf8');
    fs.writeFileSync(ACTIVE_RULES_PATH, JSON.stringify(activeRules, null, 2), 'utf8');
    
    logger.success(`[RuleEvaluator] Evaluation complete. Promoted ${promotedCount} rules.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    evaluatePendingRules().then(() => process.exit(0));
}
