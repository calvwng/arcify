import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeSplitWriteGuard } from '../../native-split-safety.js';
import { saveBookmarkOperation } from '../../sidebar-tabs.js';

for (const value of [null, [], {}, { tabId: '1', windowId: 10 }, { tabId: 1, windowId: 0 }, { tabId: 1, windowId: 10, callback: 'unsafe' }]) {
    test(`guard descriptor rejects malformed ${JSON.stringify(value)}`, () => assert.throws(() => createNativeSplitWriteGuard(value)));
}
test('optional guard never changes legacy bookmark requests', async () => {
    assert.equal(createNativeSplitWriteGuard(), undefined);
    const messages = []; globalThis.chrome = { runtime: { sendMessage: async message => { messages.push(message); return { success: true }; } } };
    const operation = { parents: [] }; await saveBookmarkOperation(operation); assert.deepEqual(messages, [{ type: 'bookmarkOrder', operation }]);
});
test('guard reads fresh native identity every invocation and rejects split/window/incognito changes', async () => {
    let tab = { id: 1, windowId: 10, splitViewId: -1 };
    globalThis.chrome = { tabs: { get: async id => { assert.equal(id, 1); return structuredClone(tab); } } };
    const guard = createNativeSplitWriteGuard({ tabId: 1, windowId: 10 }); await guard();
    for (const change of [{ splitViewId: 0 }, { windowId: 20 }, { incognito: true }, { id: 2 }]) {
        tab = { id: 1, windowId: 10, splitViewId: -1, ...change }; await assert.rejects(guard());
    }
});
test('guarded request and retained-created-id errors pass through exactly, without retries', async () => {
    const messages = [], operation = { parents: [] }, guardTab = { tabId: 1, windowId: 10 };
    globalThis.chrome = { runtime: { sendMessage: async message => { messages.push(message); return { success: false, error: 'End Split View', moved: true, createdId: 'saved' }; } } };
    await assert.rejects(saveBookmarkOperation(operation, { guardTab }), error => error.createdId === 'saved' && error.moved === true);
    assert.deepEqual(messages, [{ type: 'bookmarkOrder', operation, guardTab }]);
});
