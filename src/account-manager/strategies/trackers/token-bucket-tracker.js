/**
 * Token Bucket Tracker
 *
 * Client-side rate limiting using the token bucket algorithm.
 * Each account has a bucket of tokens that regenerate over time.
 * Requests consume tokens; accounts without tokens are deprioritized.
 */

// Default configuration (matches opencode-antigravity-auth)
const DEFAULT_CONFIG = {
    maxTokens: 50,        // Maximum token capacity
    tokensPerMinute: 6,   // Regeneration rate
    initialTokens: 50,    // Starting tokens
    aimd: {               // AIMD backpressure config
        enabled: true,
        additiveIncrease: 0.5,
        multiplicativeDecrease: 0.5,
        minTokensPerMinute: 1,
        maxTokensPerMinute: 60
    }
};

export class TokenBucketTracker {
    #buckets = new Map(); // email -> { tokens, lastUpdated }
    #rates = new Map();   // email -> current tokensPerMinute
    #config;

    /**
     * Create a new TokenBucketTracker
     * @param {Object} config - Token bucket configuration
     */
    constructor(config = {}) {
        this.#config = { 
            ...DEFAULT_CONFIG, 
            ...config,
            aimd: { ...DEFAULT_CONFIG.aimd, ...(config.aimd || {}) }
        };
    }

    /**
     * Get the current generation rate for an account
     */
    #getRate(email) {
        if (!this.#config.aimd.enabled) {
            return this.#config.tokensPerMinute;
        }
        if (!this.#rates.has(email)) {
            this.#rates.set(email, this.#config.tokensPerMinute);
        }
        return this.#rates.get(email);
    }

    /**
     * Get the current token count for an account
     * @param {string} email - Account email
     * @returns {number} Current token count (with regeneration applied)
     */
    getTokens(email) {
        const bucket = this.#buckets.get(email);
        if (!bucket) {
            return this.#config.initialTokens;
        }

        // Apply token regeneration based on time elapsed and dynamic rate
        const now = Date.now();
        const minutesElapsed = (now - bucket.lastUpdated) / (1000 * 60);
        const currentRate = this.#getRate(email);
        const regenerated = minutesElapsed * currentRate;
        const currentTokens = Math.min(
            this.#config.maxTokens,
            bucket.tokens + regenerated
        );

        return currentTokens;
    }

    /**
     * Check if an account has tokens available
     * @param {string} email - Account email
     * @returns {boolean} True if account has at least 1 token
     */
    hasTokens(email) {
        return this.getTokens(email) >= 1;
    }

    /**
     * Consume a token from an account's bucket
     * @param {string} email - Account email
     * @returns {boolean} True if token was consumed, false if no tokens available
     */
    consume(email) {
        const currentTokens = this.getTokens(email);
        if (currentTokens < 1) {
            return false;
        }

        this.#buckets.set(email, {
            tokens: currentTokens - 1,
            lastUpdated: Date.now()
        });
        return true;
    }

    /**
     * Refund a token to an account's bucket (e.g., on request failure before processing)
     * @param {string} email - Account email
     */
    refund(email) {
        const currentTokens = this.getTokens(email);
        const newTokens = Math.min(
            this.#config.maxTokens,
            currentTokens + 1
        );
        this.#buckets.set(email, {
            tokens: newTokens,
            lastUpdated: Date.now()
        });
    }

    /**
     * AIMD Additive Increase: called on request success
     * Increases the token regeneration rate
     */
    recordSuccess(email) {
        if (!this.#config.aimd.enabled) return;
        const currentRate = this.#getRate(email);
        const newRate = Math.min(
            this.#config.aimd.maxTokensPerMinute,
            currentRate + this.#config.aimd.additiveIncrease
        );
        this.#rates.set(email, newRate);
    }

    /**
     * AIMD Multiplicative Decrease: called on rate limit
     * Decreases the token regeneration rate
     */
    recordRateLimit(email) {
        if (!this.#config.aimd.enabled) return;
        const currentRate = this.#getRate(email);
        const newRate = Math.max(
            this.#config.aimd.minTokensPerMinute,
            currentRate * this.#config.aimd.multiplicativeDecrease
        );
        this.#rates.set(email, newRate);
    }

    /**
     * Get the maximum token capacity
     * @returns {number} Maximum tokens per bucket
     */
    getMaxTokens() {
        return this.#config.maxTokens;
    }

    /**
     * Reset the bucket for an account
     * @param {string} email - Account email
     */
    reset(email) {
        this.#buckets.set(email, {
            tokens: this.#config.initialTokens,
            lastUpdated: Date.now()
        });
        if (this.#config.aimd.enabled) {
            this.#rates.set(email, this.#config.tokensPerMinute);
        }
    }

    /**
     * Clear all tracked buckets
     */
    clear() {
        this.#buckets.clear();
        this.#rates.clear();
    }

    /**
     * Get time in milliseconds until next token is available for an account
     * @param {string} email - Account email
     * @returns {number} Milliseconds until next token, 0 if tokens available now
     */
    getTimeUntilNextToken(email) {
        const currentTokens = this.getTokens(email);
        if (currentTokens >= 1) {
            return 0;
        }

        // Calculate time to regenerate 1 token
        const tokensNeeded = 1 - currentTokens;
        const currentRate = this.#getRate(email);
        const minutesNeeded = tokensNeeded / currentRate;
        return Math.ceil(minutesNeeded * 60 * 1000);
    }

    /**
     * Get the minimum time until any account in the list has a token
     * @param {Array<string>} emails - List of account emails
     * @returns {number} Minimum milliseconds until any account has a token
     */
    getMinTimeUntilToken(emails) {
        if (emails.length === 0) return 0;

        let minWait = Infinity;
        for (const email of emails) {
            const wait = this.getTimeUntilNextToken(email);
            if (wait === 0) return 0;
            minWait = Math.min(minWait, wait);
        }
        return minWait === Infinity ? 0 : minWait;
    }
}

export default TokenBucketTracker;
