import assert from 'assert';
import { anthropicToOpenaiPayload } from '../src/cloudcode/local-engine-fallback.js';
import { config } from '../src/config.js';

console.log('Testing local-engine-fallback...');

// 1. Check default config
assert.strictEqual(config.localEngine.enabled, true);
assert.strictEqual(config.localEngine.turboEndpoint, 'http://127.0.0.1:8088/v1');
assert.strictEqual(config.localEngine.ollamaEndpoint, 'http://127.0.0.1:11434/v1');

// 2. Check payload conversion
const anthropicReq = {
    model: 'claude-sonnet-4-6',
    system: 'You are a helpful assistant.',
    messages: [
        { role: 'user', content: 'Hello Turbo Fieldfare!' },
        { role: 'assistant', content: 'Hello! How can I help?' },
        { role: 'user', content: [{ type: 'text', text: 'Provide system metrics.' }] }
    ],
    max_tokens: 1024,
    temperature: 0.5
};

const openaiPayload = anthropicToOpenaiPayload(anthropicReq, 'gemma-4-26b-a4b');

assert.strictEqual(openaiPayload.model, 'gemma-4-26b-a4b');
assert.strictEqual(openaiPayload.messages.length, 4); // system + 3 messages
assert.strictEqual(openaiPayload.messages[0].role, 'system');
assert.strictEqual(openaiPayload.messages[0].content, 'You are a helpful assistant.');
assert.strictEqual(openaiPayload.messages[3].content, 'Provide system metrics.');
assert.strictEqual(openaiPayload.max_tokens, 1024);
assert.strictEqual(openaiPayload.temperature, 0.5);

console.log('PASSED: local-engine-fallback tests succeeded!');
