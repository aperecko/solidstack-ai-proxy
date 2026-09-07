/**
 * Test Keyring & NVIDIA NIM Provider Engine
 * 
 * Verifies payload translation, tool calling conversion, context length guard,
 * and keyring rotation/cooldown mechanics.
 */

const assert = require('assert');

async function runTests() {
    console.log('[*] Testing NVIDIA NIM & Keyring Integration...');

    // 1. Test Keyring Manager
    const { keyringManager } = await import('../src/providers/keyring-manager.js');
    assert.ok(keyringManager, 'keyringManager should be loaded');

    const status = keyringManager.getStatus();
    assert.ok(status.providers.nvidia, 'nvidia provider should exist');
    assert.ok(status.providers.openrouter, 'openrouter provider should exist');
    assert.ok(status.providers.groq, 'groq provider should exist');
    console.log('  [+] Keyring initialization and providers structure verified.');

    // Add a test key
    const dummyKey = 'nvapi-testkey-1234567890abcdef1234567890';
    const addRes = keyringManager.addKey('nvidia', dummyKey, 'Test Unit Key');
    assert.ok(addRes.status === 'ok' || addRes.status === 'exists', 'Key registration should succeed');

    const keyObj = keyringManager.getNextKey('nvidia');
    assert.ok(keyObj, 'Should retrieve available key');
    assert.strictEqual(keyObj.key, dummyKey, 'Key should match registered dummy key');
    console.log('  [+] Key registration and retrieval verified.');

    // Test 429 cooldown
    keyringManager.recordFailure('nvidia', keyObj.id, 429);
    const afterCooldownKey = keyringManager.getNextKey('nvidia');
    assert.strictEqual(afterCooldownKey, null, 'Key in cooldown should not be selected');
    console.log('  [+] Cooldown circuit-breaking on 429 verified.');

    // Clean up test key
    keyringManager.removeKey('nvidia', keyObj.id);

    // 2. Test NVIDIA NIM Payload Translation
    const { anthropicToNimPayload, isNimEligible, NIM_MAX_SAFE_TOKENS } = await import('../src/providers/nvidia-nim.js');

    assert.ok(isNimEligible('meta/llama-3.3-70b-instruct', 'normal'), 'NIM model should be eligible');
    assert.ok(isNimEligible('claude-3-7-sonnet', 'background'), 'Background task tier should be eligible for NIM');
    assert.ok(isNimEligible('fcc-fast', 'normal'), 'fcc-fast alias should be eligible');
    assert.strictEqual(isNimEligible('claude-3-7-sonnet', 'normal'), false, 'Normal Claude request should NOT be NIM eligible');
    console.log('  [+] isNimEligible eligibility routing verified.');

    const sampleAnthropicRequest = {
        model: 'fcc-fast',
        system: 'You are a helpful coding assistant.',
        messages: [
            { role: 'user', content: 'What is in file.txt?' },
            {
                role: 'assistant',
                content: [
                    { type: 'text', text: 'Let me inspect that.' },
                    {
                        type: 'tool_use',
                        id: 'tool_1',
                        name: 'view_file',
                        input: { path: '/tmp/file.txt' }
                    }
                ]
            },
            {
                role: 'user',
                content: [
                    {
                        type: 'tool_result',
                        tool_use_id: 'tool_1',
                        content: 'Hello World!'
                    }
                ]
            }
        ],
        tools: [
            {
                name: 'view_file',
                description: 'Read file content',
                input_schema: {
                    type: 'object',
                    properties: { path: { type: 'string' } },
                    required: ['path']
                }
            }
        ],
        max_tokens: 2048,
        temperature: 0.5
    };

    const nimPayload = anthropicToNimPayload(sampleAnthropicRequest, 'fcc-fast');
    assert.strictEqual(nimPayload.model, 'meta/llama-3.3-70b-instruct', 'Model alias fcc-fast should map to Llama 3.3 70B');
    assert.strictEqual(nimPayload.messages[0].role, 'system', 'System prompt should become role: system');
    assert.strictEqual(nimPayload.messages[1].role, 'user');
    assert.strictEqual(nimPayload.messages[2].role, 'assistant');
    assert.ok(nimPayload.messages[2].tool_calls, 'Assistant tool_use should become tool_calls');
    assert.strictEqual(nimPayload.messages[2].tool_calls[0].function.name, 'view_file');
    assert.strictEqual(nimPayload.messages[3].role, 'tool', 'tool_result should become role: tool');
    assert.strictEqual(nimPayload.messages[3].tool_call_id, 'tool_1');
    assert.ok(nimPayload.tools, 'Tools should be translated to OpenAI function calling format');
    assert.strictEqual(nimPayload.tools[0].type, 'function');
    assert.strictEqual(nimPayload.tools[0].function.name, 'view_file');
    console.log('  [+] Multi-turn tool calling translation (tool_use & tool_result) verified.');

    // 3. Test Context Length Guard
    const hugePayload = {
        model: 'fcc-fast',
        messages: [{ role: 'user', content: 'A'.repeat(NIM_MAX_SAFE_TOKENS * 5) }]
    };

    let overflowCaught = false;
    try {
        anthropicToNimPayload(hugePayload, 'fcc-fast');
    } catch (e) {
        if (e.code === 'CONTEXT_OVERFLOW') {
            overflowCaught = true;
        }
    }
    assert.ok(overflowCaught, 'Context overflow guard should trigger for payloads exceeding token limit');
    console.log('  [+] Context Overflow Guard (>24,000 tokens) verified.');

    // 4. Test Fallback Cascade Integration
    const { getFallbackChain } = await import('../src/fallback-config.js');
    const fccChain = getFallbackChain('fcc-fast');
    assert.ok(fccChain.includes('meta/llama-3.3-70b-instruct'), 'fcc-fast cascade should include Llama 3.3');
    assert.ok(fccChain.includes('gemini-3.1-flash-lite'), 'fcc-fast cascade should include gemini-3.1-flash-lite');
    console.log('  [+] Dynamic fallback cascade mappings for FCC verified.');

    console.log('\n[✔] ALL KEYRING & NVIDIA NIM TESTS PASSED EMPIRICALLY!\n');
}

runTests().catch(err => {
    console.error('Test Failed:', err);
    process.exit(1);
});
