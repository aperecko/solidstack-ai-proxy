import test from 'node:test';
import assert from 'node:assert/strict';
import {
    getDedupKey,
    getRateLimitBackoff,
    clearRateLimitState,
    isPermanentAuthFailure,
    isValidationRequired,
    extractVerificationUrl,
    isAccountBanned,
    isEligibilityDenied,
    isModelCapacityExhausted,
    calculateSmartBackoff
} from '../src/cloudcode/rate-limit-state.js';
import {
    BACKOFF_BY_ERROR_TYPE,
    QUOTA_EXHAUSTED_BACKOFF_TIERS_MS
} from '../src/constants.js';

test('isPermanentAuthFailure detects correct errors', () => {
    assert.equal(isPermanentAuthFailure('invalid_grant'), true);
    assert.equal(isPermanentAuthFailure('Token has been expired or revoked.'), true);
    assert.equal(isPermanentAuthFailure('token_revoked'), true);
    assert.equal(isPermanentAuthFailure('credentials are invalid'), true);
    assert.equal(isPermanentAuthFailure('Some other error'), false);
    assert.equal(isPermanentAuthFailure(null), false);
});

test('isValidationRequired detects account validation needs', () => {
    assert.equal(isValidationRequired('VALIDATION_REQUIRED'), true);
    assert.equal(isValidationRequired('Account_Disabled'), true);
    assert.equal(isValidationRequired('user_disabled'), true);
    assert.equal(isValidationRequired('Internal Server Error'), false);
});

test('extractVerificationUrl finds URL in JSON and regex', () => {
    const jsonError = JSON.stringify({
        error: {
            details: [{
                metadata: {
                    validation_url: 'https://accounts.google.com/signin/continue?ext=123'
                }
            }]
        }
    });
    assert.equal(extractVerificationUrl(jsonError), 'https://accounts.google.com/signin/continue?ext=123');

    const textError = 'Please visit https://accounts.google.com/signin/continue?id=abc to verify.';
    assert.equal(extractVerificationUrl(textError), 'https://accounts.google.com/signin/continue?id=abc');

    const textErrorBrackets = 'Visit [https://accounts.google.com/signin/continue?id=abc]';
    assert.equal(extractVerificationUrl(textErrorBrackets), 'https://accounts.google.com/signin/continue?id=abc');

    assert.equal(extractVerificationUrl('No URL here'), null);
});

test('isAccountBanned detects ToS violations', () => {
    assert.equal(isAccountBanned('Account has been disabled for violation of Terms of Service'), true);
    assert.equal(isAccountBanned('has been disabled'), false);
});

test('isEligibilityDenied detects Code Assist restrictions', () => {
    assert.equal(isEligibilityDenied('Your account is not eligible for Gemini Code Assist at this time.'), true);
    assert.equal(isEligibilityDenied('Ineligible for this service'), true);
    assert.equal(isEligibilityDenied('Rate limit exceeded'), false);
});

test('isModelCapacityExhausted detects capacity issues', () => {
    assert.equal(isModelCapacityExhausted('MODEL_CAPACITY_EXHAUSTED'), true);
    assert.equal(isModelCapacityExhausted('capacity_exhausted'), true);
    assert.equal(isModelCapacityExhausted('model is currently overloaded'), true);
    assert.equal(isModelCapacityExhausted('service temporarily unavailable'), true);
    assert.equal(isModelCapacityExhausted('Quota exceeded'), false);
});

test('calculateSmartBackoff uses server reset MS if valid', () => {
    assert.equal(calculateSmartBackoff('rate limit', 5000), 5000);
});

test('calculateSmartBackoff handles QUOTA_EXHAUSTED', () => {
    assert.equal(calculateSmartBackoff('quota_exhausted', null, 0), QUOTA_EXHAUSTED_BACKOFF_TIERS_MS[0]);
    assert.equal(calculateSmartBackoff('quota_exhausted', null, 2), QUOTA_EXHAUSTED_BACKOFF_TIERS_MS[2]);
    assert.equal(calculateSmartBackoff('quota_exhausted', null, 10), QUOTA_EXHAUSTED_BACKOFF_TIERS_MS[QUOTA_EXHAUSTED_BACKOFF_TIERS_MS.length - 1]);
});

test('calculateSmartBackoff handles RATE_LIMIT_EXCEEDED', () => {
    assert.equal(calculateSmartBackoff('rate limit exceeded', null), BACKOFF_BY_ERROR_TYPE.RATE_LIMIT_EXCEEDED);
});

test('calculateSmartBackoff handles SERVER_ERROR', () => {
    assert.equal(calculateSmartBackoff('internal server error', null), BACKOFF_BY_ERROR_TYPE.SERVER_ERROR);
});

test('calculateSmartBackoff handles UNKNOWN', () => {
    assert.equal(calculateSmartBackoff('some weird error', null), BACKOFF_BY_ERROR_TYPE.UNKNOWN);
});

test('getRateLimitBackoff handles initial state and dedup', () => {
    clearRateLimitState('test@test.com', 'model-a');
    
    // First attempt
    const b1 = getRateLimitBackoff('test@test.com', 'model-a', null);
    assert.equal(b1.attempt, 1);
    assert.equal(b1.isDuplicate, false);
    
    // Immediate second attempt should be a duplicate
    const b2 = getRateLimitBackoff('test@test.com', 'model-a', null);
    assert.equal(b2.attempt, 1);
    assert.equal(b2.isDuplicate, true);
});
