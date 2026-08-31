import test from 'node:test';
import assert from 'node:assert/strict';
import { HybridStrategy } from '../src/account-manager/strategies/hybrid-strategy.js';
import { isAllRateLimited } from '../src/account-manager/rate-limits.js';

test('hybrid-strategy correctly degrades and rejects requests when pool collapses', () => {
    // Simulate total pool collapse for a Claude model
    const accounts = [
        {
            email: 'user1@domain.com',
            enabled: true,
            isInvalid: false,
            subscription: { tier: 'pro' },
            type: 'oauth',
            quota: { models: { 'claude-sonnet-4-6': { remainingFraction: 0, resetTime: new Date(Date.now() + 86400000).toISOString() } } }
        },
        {
            email: 'user2@domain.com',
            enabled: true,
            isInvalid: false,
            subscription: { tier: 'pro' },
            type: 'oauth',
            quota: { models: { 'claude-sonnet-4-6': { remainingFraction: 0, resetTime: new Date(Date.now() + 3600000).toISOString() } } }
        }
    ];

    // Assert that the pool is reported as completely exhausted
    assert.equal(isAllRateLimited(accounts, 'claude-sonnet-4-6'), true, 'Pool should be considered fully rate-limited');

    // Assert that the routing strategy gracefully fails rather than entering a loop
    const strategy = new HybridStrategy();
    const result = strategy.selectAccount(accounts, 'claude-sonnet-4-6', { currentIndex: 0 });
    
    assert.equal(result.account, null, 'Should not have selected an account when pool is exhausted');
    // Ensure that it doesn't infinite loop, and accurately reports waitMs (0 means permanently unusable/exhausted)
    assert.equal(result.waitMs, 0, 'waitMs may be 0 when permanently exhausted');
});
