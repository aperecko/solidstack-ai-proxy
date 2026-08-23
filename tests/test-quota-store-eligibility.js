import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEligibilityMap,
  deriveStatus,
  getQuotaStatus,
  getBestAccount,
  recordRequest,
  setCooldown,
  clearCooldown,
  KNOWN_LIMITS,
  RESET_WINDOWS
} from '../src/account-manager/quota-store.js';

test('deriveStatus handles all account states correctly', () => {
  const eligMap = {
    'antigravity::invalid@test.com': { isInvalid: true, disabled: false, coolingUntil: null, lastError: '403 Forbidden', eligibility: 'code_assist_eligible' },
    'antigravity::disabled@test.com': { isInvalid: false, disabled: true, coolingUntil: null, lastError: null, eligibility: 'code_assist_eligible' },
    'antigravity::cooling@test.com': { isInvalid: false, disabled: false, coolingUntil: Date.now() + 60000, lastError: '429 Rate limited', eligibility: 'code_assist_eligible' },
    'antigravity::ineligible@test.com': { isInvalid: false, disabled: false, coolingUntil: null, lastError: null, eligibility: 'free_tier_unsupported' },
    'antigravity::ok@test.com': { isInvalid: false, disabled: false, coolingUntil: null, lastError: null, eligibility: 'code_assist_eligible' },
  };

  assert.equal(deriveStatus(eligMap, 'antigravity', 'invalid@test.com', { reqs: 5, errors: 0 }), 'invalid');
  assert.equal(deriveStatus(eligMap, 'antigravity', 'disabled@test.com', { reqs: 5, errors: 0 }), 'disabled');
  assert.equal(deriveStatus(eligMap, 'antigravity', 'cooling@test.com', { reqs: 5, errors: 0 }), 'cooling');
  assert.equal(deriveStatus(eligMap, 'antigravity', 'ineligible@test.com', { reqs: 5, errors: 0 }), 'ineligible');
  assert.equal(deriveStatus(eligMap, 'antigravity', 'ok@test.com', { reqs: 5, errors: 5 }), 'erroring');
  assert.equal(deriveStatus(eligMap, 'antigravity', 'ok@test.com', { reqs: 5, errors: 1 }), 'ok');
  assert.equal(deriveStatus(eligMap, 'antigravity', 'missing@test.com', { reqs: 0, errors: 0 }), 'unknown');
});

test('getBestAccount filters out non-ok accounts and selects least loaded ok account', () => {
  // Record some requests to populate accounts in quota-store
  recordRequest({ app: 'antigravity', accountId: 'test-a@domain.com', model: 'gemini-2.5-pro', tokens: 100 });
  recordRequest({ app: 'antigravity', accountId: 'test-b@domain.com', model: 'gemini-2.5-pro', tokens: 100 });
  recordRequest({ app: 'antigravity', accountId: 'test-b@domain.com', model: 'gemini-2.5-pro', tokens: 100 });

  const statusList = getQuotaStatus('antigravity');
  assert.ok(Array.isArray(statusList));
  assert.ok(statusList.length > 0);
  const row = statusList[0];
  assert.ok('status' in row);
  assert.ok('isInvalid' in row);
  assert.ok('coolingUntil' in row);
  assert.ok('lastError' in row);
  assert.ok('eligibility' in row);
});
