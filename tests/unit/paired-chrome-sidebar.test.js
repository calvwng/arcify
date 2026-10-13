import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertNativeSidebarEvidence, evaluateWithoutGesture } from '../../scripts/paired-chrome-sidebar.mjs';
const id = 'a'.repeat(32);
const expected = { extensionId: id, windowId: 2, afterEvent: 1 };
const context = { contextId: 'native', contextType: 'SIDE_PANEL', documentUrl: `chrome-extension://${id}/sidebar.html`, windowId: 2, incognito: false };
const events = [{ type: 'closed', windowId: 2 }, { type: 'opened', windowId: 2, path: 'sidebar.html' }];
test('native sidebar proof requires exact native context and a fresh opened event', () => {
    assert.equal(assertNativeSidebarEvidence([context], events, expected), context);
});
for (const [label, change] of Object.entries({ ordinaryTab: { contextType: 'TAB' }, wrongWindow: { windowId: 3 }, wrongExtension: { documentUrl: 'chrome-extension://other/sidebar.html' }, private: { incognito: true }, absentIdentity: { contextId: undefined } })) {
    test(`native sidebar proof rejects ${label}`, () => assert.throws(() => assertNativeSidebarEvidence([{ ...context, ...change }], events, expected)));
}
test('native sidebar proof rejects missing/duplicate contexts and stale or wrong events', () => {
    for (const contexts of [[], [context, context], [context, { ...context, windowId: 3 }]]) assert.throws(() => assertNativeSidebarEvidence(contexts, events, expected));
    for (const observed of [[events[1]], [{}, { ...events[1], windowId: 3 }], [{}, { ...events[1], path: 'other.html' }]]) {
        assert.throws(() => assertNativeSidebarEvidence([context], observed, expected));
    }
});
test('non-gesture evaluation explicitly passes false and performs no replay', async () => {
    const calls = [];
    const session = { send: async (...args) => { calls.push(args); return { result: { value: { ok: false } } }; } };
    assert.deepEqual(await evaluateWithoutGesture(session, 'probe()'), { ok: false });
    assert.deepEqual(calls, [['Runtime.evaluate', { expression: 'probe()', awaitPromise: true, returnByValue: true, userGesture: false }]]);
});
test('non-gesture errors are hard failures, never converted to a rejection result', async () => {
    let calls = 0;
    await assert.rejects(evaluateWithoutGesture({ send: async () => { calls++; return { exceptionDetails: { text: 'bad realm' } }; } }, 'probe()'));
    assert.equal(calls, 1);
});
