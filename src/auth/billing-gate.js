import { logger } from '../utils/logger.js';
import { config } from '../config.js';

/**
 * SolidStack Billing & API Key Gate
 * Implements the multi-stream-income SaaS pivot.
 * Gates premium models behind an API key check, leaving lighter models free for internal automation.
 */

// Models that require a paid/premium API key
const PREMIUM_MODELS = [
    'claude-3-opus',
    'claude-3-5-sonnet',
    'claude-4.6-opus', 
    'gemini-pro',
    'gemini-3.1-pro',
    'gpt-4o',
    'o1-preview',
    'o1-mini',
    'gpt-5'
];

export function requireBillingGate(req, res, next) {
    try {
        // Support OpenAI format (req.body.model) and Anthropic format (req.body.model)
        const requestedModel = req.body?.model || '';
        const matchModel = requestedModel.toLowerCase();
        
        let isPremium = false;
        for (const premium of PREMIUM_MODELS) {
            if (matchModel.includes(premium)) {
                isPremium = true;
                break;
            }
        }
        
        // Let free/default models pass through immediately
        if (!isPremium) {
            return next();
        }
        
        // For premium models, check API key
        // We look for the standard authorization headers used by OpenAI and Anthropic clients
        const authHeader = req.headers['authorization'] || '';
        const xApiKey = req.headers['x-api-key'] || '';
        
        let providedKey = '';
        if (authHeader.startsWith('Bearer ')) {
            providedKey = authHeader.substring(7);
        } else if (xApiKey) {
            providedKey = xApiKey;
        }
        
        // For MVP, if it matches the configured proxy api key OR a dummy 'sk-premium-...' format
        const validProxyKey = config.apiKey || 'solidstack-proxy';
        
        const isValid = providedKey === validProxyKey || providedKey.startsWith('sk-premium-');
        
        if (!isValid) {
            logger.warn(`[Billing] Blocked unauthorized access to premium model: ${requestedModel}`);
            return res.status(402).json({
                error: {
                    type: 'payment_required',
                    message: `Model '${requestedModel}' is a premium tier model. Please provide a valid billing API key in the Authorization or x-api-key header. Upgrade at: https://billing.solidstack.local`
                }
            });
        }
        
        // Valid premium key, proceed
        // TODO: In the future, hook into Stripe metered usage here or in a response interceptor
        logger.info(`[Billing] Authorized premium model access: ${requestedModel}`);
        next();
        
    } catch (err) {
        logger.error(`[Billing] Error in billing gate: ${err.message}`);
        next(); // Default to open on error to avoid breaking production
    }
}
