import { logger } from '../utils/logger.js';

/**
 * Selects the optimal model based on prompt complexity, task context, and fleet quota.
 * @param {Array} messages - The conversation messages.
 * @param {Object} reqBody - The request body.
 * @param {Object} accountManager - The account manager for quota checking.
 * @returns {Promise<string>} The selected model ID.
 */
export async function selectOptimalModel(messages, reqBody, accountManager) {
  // 1. Calculate prompt complexity (rough token estimate based on string length)
  const messagesString = JSON.stringify(messages || []);
  const tokenEstimate = Math.ceil(messagesString.length / 4);
  
  // 2. Determine context
  const isCli = reqBody?.taskTier === 'cli';
  const isBackground = (messages || []).some(m => 
    m.role === 'system' && 
    typeof m.content === 'string' &&
    (m.content.toLowerCase().includes('background') || m.content.toLowerCase().includes('subagent'))
  );
  
  const isSimpleTask = isCli || isBackground || tokenEstimate < 1000;

  // 3. Route to fast/lite model for simple/background tasks
  if (isSimpleTask) {
    logger.info('Task is simple or background. Routing to gemini-3.1-flash-lite.');
    return 'fcc-fast';
  }

  // 4. Check fleet quota for Claude
  let claudeIsHealthy = false; // Assume unhealthy if not found
  
  try {
    if (accountManager && typeof accountManager.getQuotaStatus === 'function') {
      const quotaStatus = await accountManager.getQuotaStatus('antigravity');
      
      if (Array.isArray(quotaStatus)) {
        const claudeQuotas = quotaStatus.filter(q => q.model && q.model.toLowerCase().includes('claude'));
        
        if (claudeQuotas.length > 0) {
          const healthyClaudeModels = claudeQuotas.filter(q => {
            if (typeof q.remainingPercentage === 'number') { return q.remainingPercentage > 15; }
            if (q.exhausted !== undefined) { return !q.exhausted; }
            return true;
          });
          if (healthyClaudeModels.length > 0) {
             claudeIsHealthy = true;
          }
        }
      }
    }
  } catch (error) {
    logger.warn(`Failed to check quota status: ${error.message}. Assuming healthy.`);
  }

  // 5. Route to complex model
  if (claudeIsHealthy) {
    logger.info('Claude fleet is healthy. Routing to claude-sonnet-4-6.');
    return 'claude-sonnet-4-6';
  } else {
    logger.info('Claude fleet is exhausted. Routing to gemini-3.1-pro-high.');
    return 'deepseek-ai/deepseek-r1';
  }
}
