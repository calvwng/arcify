import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { serveSpotlightSplitFixture, installSpotlightSplitInputObservation, assertSpotlightSplitInput, assertSpotlightSplitRequest,
    assertSpotlightSplitSource, assertSpotlightSplitCommitted } from '../../scripts/paired-chrome-spotlight-split.mjs';
const clone = value => structuredClone(value), PEER = 'a'.repeat(32);
const external = message => ({ type: 'external', data: { message, sender: { id: PEER } } });
const input = patch => ({ type: 'click', key: null, trusted: true, repeat: false, composing: false, keyCode: null, button: 0, ctrl: false, alt: false, meta: false, shift: false, inPrompt: false, resultType: 'arcify-split-action', title: 'Split current tab', targetId: null, confirm: false, cancel: false, ...patch });
for (const method of ['click', 'Enter']) test(`trusted ${method} oracle requires one row, explicit exact target and one confirmation`, () => {
    const events = [input(method === 'Enter' ? { type: 'keydown', key: 'Enter', button: null } : {}), input({ inPrompt: true, targetId: 3 }), input({ inPrompt: true, confirm: true })];
    const expected = { command: 'createSplitView', targetId: 3, method }; assertSpotlightSplitInput(events, expected);
    for (const change of [value => value.pop(), value => value.splice(1, 1), value => value.push(clone(value[0])), value => { value[1].targetId = 2; },
        value => { value[0].title = 'End Split'; }, ...['trusted', 'repeat', 'composing', 'ctrl', 'alt', 'meta', 'shift'].map(key => value => { value[0][key] = !value[0][key]; })]) {
        const bad = clone(events); change(bad); assert.throws(() => assertSpotlightSplitInput(bad, expected));
    }
    assertSpotlightSplitInput([events[0], input({ inPrompt: true, cancel: true })], { ...expected, cancelled: true });
});
function sample({ create = true, source = 1, adjacent = false } = {}) {
    const before = { tabs: [1,2,3,9].map((id,index) => ({ id, windowId: id === 9 ? 8 : 7, index: id === 9 ? 0 : index, url: 'https://same.test/', pendingUrl: null, pinned: false, incognito: false, active: id === source || id === 9, groupId: -1, splitViewId: -1 })),
        spaces: [{ id: 'space', bookmarkFolderId: 'root', temporaryTabs: [1,9,2,3], spaceBookmarks: [] }], windows: [{ id: 7, focused: true }, { id: 8, focused: false }], activeSpaces: { 7: 'space', 8: 'space' },
        bookmarks: [], bindings: {}, aliases: {}, favorites: [], favoriteSession: {}, groups: [], pairingGeneration: 'generation', journal: [], pageStates: Object.fromEntries([1,2,3,9].map(id => [id, { documentId: `doc${id}`, value: `draft${id}`, timeOrigin: id, frames: 0, topLevel: true }])) };
    if (adjacent || !create) { before.tabs[1].index = 2; before.tabs[2].index = 1; before.spaces[0].temporaryTabs = [1,9,3,2]; }
    if (!create) before.tabs.filter(tab => [1,3].includes(tab.id)).forEach(tab => { tab.splitViewId = 77; });
    const descriptor = id => { const { url, index, groupId, pinned, splitViewId } = before.tabs.find(tab => tab.id === id); return { id, url, title: 'Same', index, groupId, pinned, splitViewId }; };
    const context = { windowId: 7, spaceId: 'space', bookmarkFolderId: 'root', pairingGeneration: 'generation', sourceTabId: source, tab: descriptor(source), pair: create ? [] : [descriptor(1), descriptor(3)] };
    const request = { type: 'arcify-bridge', version: 1, requestId: 'split-test', windowId: 7, command: create ? 'createSplitView' : 'endSplitView', context, supportedFeatures: ['globalFavoritesV1','splitActionsV1'], ...(create ? { target: descriptor(source === 1 ? 3 : 1) } : {}) };
    const after = clone(before), reordered = create && !adjacent;
    if (reordered) { after.tabs[1].index = 2; after.tabs[2].index = 1; after.spaces[0].temporaryTabs = [1,9,3,2]; }
    for (const tab of after.tabs) if ([1,3].includes(tab.id)) tab.splitViewId = create ? 77 : -1;
    const splitResult = { action: create ? 'create' : 'end', windowId: 7, spaceId: 'space', sourceTabId: source, tabIds: [1,3], splitViewId: create ? 77 : -1, reordered };
    after.journal.push({ fingerprint: JSON.stringify(request), response: { ok: true, requestId: request.requestId, role: 'arcify', splitResult } });
    const events = [external(request), ...(reordered ? [{ type: 'tabs.onMoved', data: [3, { windowId: 7, fromIndex: 2, toIndex: 1 }] }] : [])];
    const internal = { type: 'internal', data: { message: { action: 'arcifySplitAction', command: request.command, scope: { context } }, sender: { url: context.tab.url, frameId: 0, tab: { id: source, windowId: 7 } } } };
    const expected = { command: request.command, sourceTabId: source, targetId: source === 1 ? 3 : 1, windowId: 7, spotlightId: PEER };
    return { before, after, request, events, internal, expected, splitResult };
}
for (const source of [1,3]) for (const create of [false,true]) for (const adjacent of [false,true]) test(`native receipt oracle requires exact ${source} source; create=${create} adjacent=${adjacent}`, () => {
    const f = sample({ source, create, adjacent }); assert.deepEqual(assertSpotlightSplitCommitted(f.before, f.after, f.request, f.events), f.splitResult);
    assert.equal(assertSpotlightSplitRequest(f.events, f.expected), f.request);
    assert.deepEqual(assertSpotlightSplitSource([f.internal], f.request, f.request.context.tab.url), f.internal.data);
});
for (const [name, mutate] of [
    ['source focus changed', f => { f.after.tabs[0].active = false; f.after.tabs[2].active = true; }],
    ['other window changed', f => { f.after.tabs[3].active = false; }], ['other window canonical slot moved', f => { f.after.spaces[0].temporaryTabs = [1,3,9,2]; }],
    ['original document replaced', f => { f.after.pageStates[1].documentId = 'replacement'; }], ['draft lost', f => { f.after.pageStates[3].value = ''; }],
    ['wrong native pair', f => { f.after.tabs[2].splitViewId = 78; }], ['extra native member', f => { f.after.tabs[1].splitViewId = 77; }],
    ['regrouped', f => { f.after.tabs[0].groupId = 9; }], ['closed source', f => { f.after.tabs.shift(); }],
    ['unrelated bookmark change', f => { f.after.bookmarks.push({ id: 'new' }); }], ['duplicate native move', f => { f.events.push(clone(f.events[1])); }],
    ['activation event', f => { f.events.push({ type: 'tabs.onActivated', data: [{ windowId: 7, tabId: 1 }] }); }],
    ['group event', f => { f.events.push({ type: 'tabGroups.onUpdated', data: [{ id: 1 }] }); }], ['navigation event', f => { f.events.push({ type: 'tabs.onUpdated', data: { id: 1, change: { url: 'https://changed.test/' } } }); }],
    ['missing receipt', f => { f.after.journal = []; }], ['duplicate receipt', f => { f.after.journal.push(clone(f.after.journal[0])); }],
    ['wrong receipt source', f => { f.after.journal[0].response.splitResult.sourceTabId = 3; }], ['wrong receipt pair order', f => { f.after.journal[0].response.splitResult.tabIds.reverse(); }],
    ['wrong reordered claim', f => { f.after.journal[0].response.splitResult.reordered = false; }]
]) test(`native commitment oracle rejects ${name}`, () => { const f = sample(); mutate(f); assert.throws(() => assertSpotlightSplitCommitted(f.before, f.after, f.request, f.events)); });
test('request oracle rejects duplicate dispatch, helper source substitution, wrong peer and URL guessing', () => {
    const f = sample();
    for (const change of [events => events.push(clone(events[0])), events => { events[0].data.sender.id = 'b'.repeat(32); }, events => { events[0].data.message.context.sourceTabId = 9; }, events => { events[0].data.message.url = 'https://same.test/'; }, events => { events[0].data.message.target.id = 2; }]) {
        const events = clone(f.events); change(events); assert.throws(() => assertSpotlightSplitRequest(events, f.expected));
    }
});
test('source oracle requires original browser-attested top-frame tab, window, URL and scope', () => {
    const f = sample();
    for (const change of [event => { event.data.sender.tab.id = 3; }, event => { event.data.sender.tab.windowId = 8; }, event => { event.data.sender.frameId = 2; },
        event => { event.data.sender.url = 'chrome-extension://helper/newtab.html'; }, event => { event.data.message.scope.context.sourceTabId = 3; }]) {
        const internal = clone(f.internal); change(internal); assert.throws(() => assertSpotlightSplitSource([internal], f.request, f.request.context.tab.url));
    }
    assert.throws(() => assertSpotlightSplitSource([f.internal,f.internal], f.request, f.request.context.tab.url));
});
test('passive trusted input trace survives isolated iframe retirement in original parent realm', () => {
    const listeners = new Map(), parent = {}, row = { dataset: { resultType: 'arcify-split-action' }, querySelector: () => ({ textContent: 'Split current tab' }) };
    const context = { parent, globalThis: {}, document: { addEventListener: (type, fn) => listeners.set(type, fn), removeEventListener: type => listeners.delete(type), querySelector: () => row } };
    vm.runInNewContext(`(${installSpotlightSplitInputObservation})()`, context);
    listeners.get('click')({ isTrusted: true, button: 0, target: { closest: selector => selector.includes('spotlight-result') ? row : null, hasAttribute: () => false } });
    assert.equal(parent.__spotlightSplitInputs.length, 1); assert.equal(parent.__spotlightSplitInputs[0].trusted, true);
    context.globalThis.__splitInput.stop(); assert.equal(listeners.size, 0); assert.equal(parent.__spotlightSplitInputs.length, 1);
});
test('real nonce fixture has independent documents and two native pane colors with no injected scripts', () => {
    const records = [];
    for (const role of ['left','right','left']) { const out = []; assert(serveSpotlightSplitFixture({ url: `/spotlight-split/${'a'.repeat(32)}/${role}` }, { writeHead: (...args) => out.push(args), end: data => out.push(data) })); records.push(out); }
    assert(records.every(out => out[0][0] === 200 && out[0][1]['Cache-Control'] === 'no-store'));
    assert.match(records[0][1], /#f8d7da/); assert.match(records[1][1], /#d3f4e0/); assert.notEqual(records[0][1], records[2][1]);
    assert(records.every(out => !/<script|<iframe|<frame\b/.test(out[1])));
    assert.equal(serveSpotlightSplitFixture({ url: '/spotlight-split/bad/left' }, {}), false);
});
test('hosted driver keeps positive actions on real UI and proves both source panes with native screenshots', () => {
    const source = readFileSync(new URL('../../scripts/paired-chrome-spotlight-split.mjs', import.meta.url), 'utf8');
    assert.match(source, /assertNativeSplitCapability\(capability\)/); assert.match(source, /for \(const sync of \[false, true\]\)/); assert.match(source, /for \(const source of \[left, right\]\)/);
    assert.match(source, /await run\(source.tab.id, target.tab.id, 'createSplitView', method\)/); assert.match(source, /await run\(source.tab.id, target.tab.id, 'endSplitView', method\)/);
    assert.match(source, /assertSpotlightSplitSource\(/); assert.match(source, /assertSpotlightSplitCommitted\(before, final/); assert.match(source, /captureNativeWindow\(\{ nonce/);
    assert.match(source, /globalThis.__spotlightSplitInputs/); assert.doesNotMatch(source, /chrome.tabs.createSplit\(|chrome.tabs.unsplit\(|\.dispatchEvent\(|\.select\(|Object.defineProperty|no-sandbox|disable-web-security|\.evaluate\([^\n]*\.click\(/);
});
