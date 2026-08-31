import test from 'node:test';
import assert from 'node:assert/strict';
import { markRateLimited, isAllRateLimited } from '../src/account-manager/rate-limits.js';

test('markRateLimited with >5 min cooldown sets remainingFraction to 0', () => {
    // Setup mock accounts
    const accounts = [
        {
            email: 'test@domain.com',
            quota: {
                models: {
                    'claude-sonnet-4-6': { remainingFraction: 1.0, resetTime: null }
                }
            },
            modelRateLimits: {}
        }
    ];

    // Inject a 24-hour Quota Exhaustion (24 * 60 * 60 * 1000 = 86400000ms)
    const injectedResetMs = 86400000;
    
    const success = markRateLimited(accounts, 'test@domain.com', injectedResetMs, 'claude-sonnet-4-6');
    
    assert.equal(success, true, 'markRateLimited should return true');
    
    const account = accounts[0];
    
    // The transient modelRateLimits should be capped at 5 minutes
    assert.equal(account.modelRateLimits['claude-sonnet-4-6'].isRateLimited, true);
    assert.ok(account.modelRateLimits['claude-sonnet-4-6'].actualResetMs <= 5 * 60 * 1000, 'actualResetMs must be capped at 5 mins');

    // The persistent quota.models state MUST be updated to 0 fraction
    const quotaModel = account.quota.models['claude-sonnet-4-6'];
    assert.equal(quotaModel.remainingFraction, 0, 'remainingFraction must be zeroed out for hard quota exhaustion');
    assert.ok(quotaModel.resetTime !== null, 'resetTime must be populated');
    
    // Verify that the account is correctly identified as fully exhausted for the next 24 hours
    const isExhausted = isAllRateLimited(accounts, 'claude-sonnet-4-6');
    assert.equal(isExhausted, true, 'isAllRateLimited must return true when remainingFraction is 0');
});

test('markRateLimited with transient RPM limit (<5 min) preserves remainingFraction', () => {
    // Setup mock accounts
    const accounts = [
        {
            email: 'test@domain.com',
            quota: {
                models: {
                    'claude-sonnet-4-6': { remainingFraction: 1.0, resetTime: null }
                }
            },
            modelRateLimits: {}
        }
    ];

    // Inject a 1-minute transient limit (60000ms)
    const injectedResetMs = 60000;
    
    markRateLimited(accounts, 'test@domain.com', injectedResetMs, 'claude-sonnet-4-6');
    
    const account = accounts[0];
    const quotaModel = account.quota.models['claude-sonnet-4-6'];
    
    // Transient faults should not mask long-term quota state
    assert.equal(quotaModel.remainingFraction, 1.0, 'remainingFraction must stay 1.0 for transient faults');
    assert.equal(quotaModel.resetTime, null, 'resetTime should not be permanently updated for transient faults');
});
