/**
 * Responses-API Bridge - Unit Tests
 *
 * Tests the pure translation helpers in src/openai-compat.js:
 * - responsesItemToAnthropic: Responses item -> Anthropic block
 * - responsesInputToAnthropic: Responses input (string|array) + instructions -> Anthropic messages
 * - anthropicToResponsesResponse: Anthropic response -> OpenAI Responses-API object
 */

async function runTests() {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║            OPENAI RESPONSES-API BRIDGE TEST SUITE            ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    const {
        responsesItemToAnthropic,
        responsesInputToAnthropic,
        anthropicToResponsesResponse,
    } = await import('../src/openai-compat.js');

    let passed = 0;
    let failed = 0;

    function test(name, fn) {
        try {
            fn();
            console.log(`✓ ${name}`);
            passed++;
        } catch (e) {
            console.error(`✗ ${name}`);
            console.error(`    ${e.message}`);
            failed++;
        }
    }

    function assert(cond, msg) {
        if (!cond) throw new Error(msg || 'assertion failed');
    }
    function assertEq(actual, expected, msg) {
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
            throw new Error(`${msg || 'not equal'}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
        }
    }

    console.log('─── responsesItemToAnthropic ───');
    test('string item -> text block', () => {
        assertEq(responsesItemToAnthropic('hello'), { type: 'text', text: 'hello' });
    });
    test('object with string content -> text block', () => {
        assertEq(responsesItemToAnthropic({ role: 'user', content: 'hi' }), { type: 'text', text: 'hi' });
    });
    test('input_text part -> text block', () => {
        assertEq(responsesItemToAnthropic({ role: 'user', content: [{ type: 'input_text', text: 'foo' }] }),
            [{ type: 'text', text: 'foo' }]);
    });
    test('output_text part -> text block', () => {
        assertEq(responsesItemToAnthropic({ role: 'assistant', content: [{ type: 'output_text', text: 'bar' }] }),
            [{ type: 'text', text: 'bar' }]);
    });
    test('unknown part types dropped (no crash)', () => {
        assertEq(responsesItemToAnthropic({ role: 'user', content: [{ type: 'input_text', text: 'a' }, { type: 'weird_type', x: 1 }] }),
            [{ type: 'text', text: 'a' }]);
    });
    test('null / malformed item -> null', () => {
        assertEq(responsesItemToAnthropic(null), null);
        assertEq(responsesItemToAnthropic({}), null);
    });
    test('function_call part -> tool_use block', () => {
        const result = responsesItemToAnthropic({ type: 'function_call', name: 'exec', arguments: { cmd: 'ls' } });
        const block = Array.isArray(result) ? result[0] : result;
        assert(block && block.type === 'tool_use', 'expected tool_use block');
        assertEq(block.name, 'exec');
    });

    console.log('\n─── responsesInputToAnthropic ───');
    test('string input -> single user message', () => {
        const { system, messages } = responsesInputToAnthropic('hello', null);
        assertEq(system, null);
        assertEq(messages, [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]);
    });
    test('empty string input -> no messages', () => {
        const { messages } = responsesInputToAnthropic('  ', null);
        assertEq(messages, []);
    });
    test('array input with instructions -> system prompt extracted', () => {
        const { system, messages } = responsesInputToAnthropic([
            { role: 'user', content: [{ type: 'input_text', text: 'summarize' }] },
        ], 'You are a coding agent.');
        assertEq(system, 'You are a coding agent.');
        assertEq(messages.length, 1);
    });
    test('assistant role preserved, developer folded to user', () => {
        const { messages } = responsesInputToAnthropic([
            { role: 'user', content: 'q' },
            { role: 'assistant', content: [{ type: 'output_text', text: 'a' }] },
            { role: 'developer', content: 'instructions' },
        ], null);
        const roles = messages.map(m => m.role);
        assertEq(roles, ['user', 'assistant', 'user']);
    });
    test('system-role items folded into system prompt', () => {
        const { system } = responsesInputToAnthropic([
            { role: 'system', content: [{ type: 'input_text', text: 'sys part' }] },
        ], 'existing');
        assertEq(system, 'existing\nsys part');
    });
    test('function_call_input handled without crashing', () => {
        const { messages } = responsesInputToAnthropic([
            { role: 'user', content: [{ type: 'input_text', text: 'do it' }] },
            { role: 'assistant', content: [{ type: 'function_call', name: 'apply_patch', arguments: {} }] },
            { role: 'user', content: [{ type: 'function_call_output', name: 'apply_patch', output: 'ok' }] },
        ], null);
        assert(messages.length >= 1, 'expected at least one message');
        assert(messages.some(m => m.role === 'assistant'), 'expected assistant message with tool_use');
    });
    test('non-array non-string input -> no messages', () => {
        const { messages } = responsesInputToAnthropic(12345, null);
        assertEq(messages, []);
    });

    console.log('\n─── anthropicToResponsesResponse ───');
    test('builds OpenAI Responses-API object shape', () => {
        const resp = anthropicToResponsesResponse({
            model: 'claude-sonnet-4-6',
            content: [{ type: 'text', text: 'result text' }],
            usage: { input_tokens: 10, output_tokens: 5 },
        }, 'gpt-5.3-codex');
        assertEq(resp.object, 'response');
        assertEq(resp.status, 'completed');
        assertEq(resp.output.length, 1);
        assertEq(resp.output[0].type, 'message');
        assertEq(resp.output[0].content, [{ type: 'output_text', text: 'result text', annotations: [] }]);
        assertEq(resp.usage, { input_tokens: 10, output_tokens: 5, total_tokens: 15 });
    });
    test('empty content -> empty output content array', () => {
        const resp = anthropicToResponsesResponse({ content: [], usage: {} }, 'm');
        assertEq(resp.output[0].content, []);
    });
    test('falls back to requested model when response has none', () => {
        const resp = anthropicToResponsesResponse({ content: [{ type: 'text', text: 'x' }] }, 'fallback-model');
        assertEq(resp.model, 'fallback-model');
    });

    console.log('\n══════════════════════════════════════════════════════════════');
    console.log(`Tests completed: ${passed} passed, ${failed} failed`);
    console.log('══════════════════════════════════════════════════════════════\n');

    if (failed > 0) process.exit(1);
    process.exit(0);
}

runTests().catch(err => {
    console.error('Test runner crashed:', err);
    process.exit(1);
});
