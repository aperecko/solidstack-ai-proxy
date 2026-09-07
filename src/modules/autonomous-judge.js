import { logger } from '../utils/logger.js';
import { routingEvents } from '../cloudcode/routing-logger.js';
import proficiencyTracker from './proficiency-tracker.js';

// The lightweight model used to grade other models
const JUDGE_MODEL = 'gemini-3.1-flash-lite';
const JUDGE_SAMPLING_RATE = 0.20; // 20% of traffic
const JUDGE_TAG = '[SYSTEM_JUDGE]';

/**
 * Autonomous Judge
 * Listens to decoupled routing events, samples traffic, and uses
 * a lightweight AI to grade the quality of the response.
 */
class AutonomousJudge {
    constructor() {
        this.listening = false;
    }

    start() {
        if (this.listening) return;
        this.listening = true;

        routingEvents.on('ROUTING_COMPLETED', (logEntry) => {
            this.handleRoutingEvent(logEntry).catch(err => {
                logger.warn(`[AutonomousJudge] Evaluation failed: ${err.message}`);
            });
        });

        logger.info(`[AutonomousJudge] Subscribed to routing events with ${JUDGE_SAMPLING_RATE * 100}% sampling rate.`);
    }

    async handleRoutingEvent(logEntry) {
        // Only evaluate successful requests with both prompt and response
        if (!logEntry.prompt_content || !logEntry.response_content) return;
        if (logEntry.status !== 'success' && logEntry.status !== 'local_fallback') return;

        // Anti-Loop Guard: Never grade the judge's own grading requests
        if (logEntry.prompt_content.includes(JUDGE_TAG)) return;

        // Random sampling
        if (Math.random() > JUDGE_SAMPLING_RATE) return;

        await this.evaluateQuality(logEntry);
    }

    async evaluateQuality(logEntry) {
        const { model, prompt_content, response_content } = logEntry;
        const taskType = proficiencyTracker.classifyTaskType(prompt_content);

        logger.info(`[AutonomousJudge] Sampling ${model} on task type ${taskType}...`);

        const prompt = `${JUDGE_TAG}
You are an expert AI quality assurance judge. 
Your task is to grade the quality of an AI response to a user prompt on a scale of 0.0 to 1.0.

Task Type: ${taskType}

User Prompt:
\`\`\`
${prompt_content.substring(0, 2000)}... (truncated)
\`\`\`

AI Response:
\`\`\`
${response_content.substring(0, 4000)}... (truncated)
\`\`\`

Rubric:
1.0: Perfect. Follows all instructions, no hallucinations, excellent logic and formatting.
0.8: Good. Mostly correct, minor stylistic or formatting issues.
0.5: Poor. Misses key instructions, partial hallucination, or poor logic.
0.0: Complete Failure. Hallucinates wildly, crashes, or refuses to answer valid prompts.

Respond ONLY with a JSON object containing the score and a brief reason. Example: {"score": 0.8, "reason": "Good logic but missed one formatting constraint."}`;

        // Call the internal proxy endpoint natively (using dogfooding)
        // We bypass standard auth checks internally by hitting the actual fetch directly,
        // or we just call the proxy port with a dummy token.
        const res = await fetch('http://127.0.0.1:1987/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer local-judge-bypass',
                'X-Bypass-Telemetry': 'true' // Optional extra guard
            },
            body: JSON.stringify({
                model: JUDGE_MODEL,
                messages: [{ role: 'user', content: prompt }],
                max_tokens: 150
            })
        });

        if (!res.ok) {
            throw new Error(`Proxy responded with ${res.status}`);
        }

        const data = await res.json();
        const responseText = data.content?.[0]?.text || '';
        
        let score = 0.8; // Default if parsing fails
        try {
            const jsonMatch = responseText.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                if (typeof parsed.score === 'number') {
                    score = Math.max(0, Math.min(1.0, parsed.score));
                    logger.info(`[AutonomousJudge] Graded ${model} -> ${score} (${parsed.reason})`);
                }
            } else {
                logger.warn(`[AutonomousJudge] Failed to parse JSON from judge: ${responseText}`);
            }
        } catch (e) {
            logger.warn(`[AutonomousJudge] Parsing error: ${e.message}`);
        }

        proficiencyTracker.recordQuality(model, taskType, score);
    }
}

const autonomousJudge = new AutonomousJudge();
export default autonomousJudge;
