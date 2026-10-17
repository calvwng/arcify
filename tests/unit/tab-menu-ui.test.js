import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createTabMenuActions, requestTabEdit } from '../../tab-menu-ui.js';

function fixture() {
    const { document, window } = parseHTML('<html><body><button id="previous">Previous</button></body></html>');
    let focused = document.getElementById('previous'); Object.defineProperty(document, 'activeElement', { get: () => focused });
    window.HTMLElement.prototype.focus = function () { focused = this; };
    const event = (node, type, properties = {}) => { const e = new window.Event(type, { bubbles: true, cancelable: true }); Object.assign(e, properties); node.dispatchEvent(e); return e; };
    const calls = [], statuses = [], copies = []; let context = { windowId: 10, spaceId: 's' }, result = { success: true, title: '<b>Alias</b>', url: 'https://saved.test/', currentUrl: 'https://live.test/', expected: { url: 'https://saved.test/', alias: '' }, muted: false };
    let begins = 0, ends = 0, refreshes = 0;
    const actions = createTabMenuActions({ document, getContext: () => context, sendRequest: async request => { calls.push(request); return result; }, showStatus: value => statuses.push(value),
        begin: () => begins++, end: () => ends++, refresh: async () => { refreshes++; }, copy: async url => copies.push(url) });
    return { document, event, calls, statuses, copies, actions, setContext(value) { context = value; }, setResult(value) { result = value; }, counts: () => ({ begins, ends, refreshes }) };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const target = { windowId: 10, spaceId: 's', bookmarkFolderId: 'root', tabId: 1 };

test('editor escapes markup, requires saved value, cancels on Escape/backdrop and restores focus', async () => {
    const f = fixture(); const promise = requestTabEdit(f.document, { action: 'rename', value: '<img onerror=bad>', saved: true });
    const input = f.document.getElementById('tabEditValue'); assert.equal(input.value, '<img onerror=bad>'); assert.equal(f.document.querySelector('#tabEditDialog img'), null);
    input.value = ''; f.event(input, 'input'); assert.equal(f.document.getElementById('tabEditSave').disabled, true);
    assert.equal(await requestTabEdit(f.document, { action: 'rename' }), null);
    f.event(input, 'keydown', { key: 'Escape' }); assert.equal(await promise, null); assert.equal(f.document.activeElement.id, 'previous');
    const second = requestTabEdit(f.document, { action: 'editUrl' }); f.event(f.document.getElementById('tabEditDialog'), 'click'); assert.equal(await second, null);
});

test('action Cancel writes nothing, prevents repeated launch and releases busy gate exactly once', async () => {
    const f = fixture(), actions = f.actions(target); const promise = actions.rename(); await tick();
    await actions.rename(); assert.equal(f.calls.length, 1);
    f.event(f.document.getElementById('tabEditCancel'), 'click'); await promise;
    assert.deepEqual(f.calls.map(call => call.action), ['describe']); assert.deepEqual(f.counts(), { begins: 1, ends: 1, refreshes: 0 });
});

test('rename commits original exact snapshot once and carries user text as data', async () => {
    const f = fixture(), promise = f.actions(target).rename(); await tick();
    const input = f.document.getElementById('tabEditValue'); input.value = '<script>name</script>'; f.event(input.closest('form'), 'submit'); await promise;
    assert.deepEqual(f.calls.map(call => call.action), ['describe', 'rename']); assert.equal(f.calls[1].tabId, 1); assert.equal(f.calls[1].value, '<script>name</script>');
    assert.deepEqual(f.counts(), { begins: 1, ends: 1, refreshes: 1 });
});

test('changing active Space during dialog prevents mutation and surfaces error', async () => {
    const f = fixture(), promise = f.actions(target).rename(); await tick(); f.setContext({ windowId: 10, spaceId: 'other' });
    f.event(f.document.getElementById('tabEditValue').closest('form'), 'submit'); await promise;
    assert.deepEqual(f.calls.map(call => call.action), ['describe']); assert.match(f.statuses.at(-1), /active Space changed/);
});

test('Copy Link requests exact target and never invents an active-tab fallback on an error', async () => {
    const f = fixture(); await f.actions(target).copyLink(); assert.deepEqual(f.copies, ['https://saved.test/']);
    f.setResult({ success: false, error: 'Clicked tab closed' }); await f.actions(target).copyLink(); assert.deepEqual(f.copies, ['https://saved.test/']); assert.equal(f.statuses.at(-1), 'Clicked tab closed');
});

test('muting reads fresh state and multi-selection blocks singleton actions without writes', async () => {
    const f = fixture(); f.setResult({ success: true, muted: true }); await f.actions(target, { muted: false }).mute();
    assert.deepEqual(f.calls.map(call => call.action), ['describe', 'mute']); assert.equal(f.calls[1].value, false);
    const previous = f.calls.length; const multiple = f.actions(target, { selectionCount: 2 }); await multiple.rename(); await multiple.duplicate(); await multiple.copyLink(); assert.equal(f.calls.length, previous);
});

test('use current URL preserves expected saved metadata and requires no navigation command', async () => {
    const f = fixture(); await f.actions({ ...target, bookmarkId: 'pin', parentId: 'folder' }).useCurrentUrl();
    assert.deepEqual(f.calls.map(call => call.action), ['describe', 'editUrl']); assert.equal(f.calls[1].value, 'https://live.test/');
    assert.equal(f.actions({ ...target, bookmarkId: 'pin' }).duplicate, undefined);
    const closed = { ...target, bookmarkId: 'pin' }; delete closed.tabId; assert.equal(f.actions(closed).mute, undefined);
});


for (const action of ['rename', 'editUrl']) test(`a superseding gesture aborts pending ${action} describe without an obsolete editor`, async () => {
    const f = fixture(); let release;
    f.setResult(new Promise(resolve => { release = resolve; }));
    const promise = f.actions({ ...target, ...(action === 'editUrl' ? { bookmarkId: 'pin', parentId: 'root' } : {}) })[action](); f.actions.cancelEdit();
    release({ success: true, title: 'Obsolete', expected: { url: 'https://saved.test/', alias: '' } });
    await promise;
    assert.equal(f.document.getElementById('tabEditDialog'), null);
    assert.deepEqual(f.calls.map(call => call.action), ['describe']);
    assert.deepEqual(f.counts(), { begins: 1, ends: 1, refreshes: 0 }); assert.deepEqual(f.statuses, []);
});

test('a superseding gesture dismisses an already-visible Tab editor without a write', async () => {
    const f = fixture(), promise = f.actions(target).rename(); await tick();
    assert(f.document.getElementById('tabEditDialog')); f.actions.cancelEdit(); await promise;
    assert.equal(f.document.getElementById('tabEditDialog'), null);
    assert.deepEqual(f.calls.map(call => call.action), ['describe']); assert.equal(f.document.activeElement.id, 'previous');
    assert.deepEqual(f.counts(), { begins: 1, ends: 1, refreshes: 0 });
});

test('later menus do not cancel or suppress an already-submitted Tab write', async () => {
    const f = fixture(), promise = f.actions(target).rename(); await tick(); let release;
    f.setResult(new Promise(resolve => { release = resolve; }));
    f.event(f.document.getElementById('tabEditValue').closest('form'), 'submit'); await tick();
    assert.deepEqual(f.calls.map(call => call.action), ['describe', 'rename']);
    f.actions.cancelEdit(); release({ success: false, error: 'Committed write needs attention' }); await promise;
    assert.equal(f.statuses.at(-1), 'Committed write needs attention');
    assert.deepEqual(f.counts(), { begins: 1, ends: 1, refreshes: 1 });
});


test('Escape cancels a pending description before the Tab dialog is mounted', async () => {
    const f = fixture(); let release;
    f.setResult(new Promise(resolve => { release = resolve; }));
    const promise = f.actions(target).rename(); f.event(f.document.body, 'keydown', { key: 'Escape' });
    release({ success: true, title: 'Obsolete', expected: {} }); await promise;
    assert.equal(f.document.getElementById('tabEditDialog'), null);
    assert.deepEqual(f.calls.map(call => call.action), ['describe']);
    assert.deepEqual(f.counts(), { begins: 1, ends: 1, refreshes: 0 });
});
