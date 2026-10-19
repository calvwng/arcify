import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createTodayTabSelection } from '../../today-tab-selection.js';
import { createTodaySplitUI, SPLIT_UNAVAILABLE } from '../../today-split-ui.js';

function fixture({ capability = 'both', overrides = {}, response = { success: true, reordered: false }, send, storage } = {}) {
    const { document, window } = parseHTML('<html><body><div id="spacesList"><div class="space active" data-space-id="s"><div data-tab-type="pinned"></div><div data-tab-type="temporary" data-today-order-inverted="false"></div></div></div><div class="new-tab-btn-container"></div><div id="favorites"></div></body></html>');
    const context = { windowId: 10, activeSpaceId: 's', spaces: [{ id: 's', bookmarkFolderId: 'root', temporaryTabs: [1, 2, 3, 4], spaceBookmarks: [] }] };
    const tabs = [1, 2, 3, 4].map(id => ({ id, windowId: 10, index: id - 1, groupId: -1, pinned: false, incognito: false, title: `Tab ${id}`, url: 'https://same.test/', ...overrides[id] }));
    const calls = [], statuses = [], lifecycle = [];
    const api = { tabs: {}, storage, runtime: { getURL: path => `chrome-extension://extension/${path}` } };
    for (const name of capability === 'both' ? ['createSplit', 'unsplit'] : capability === 'none' ? [] : [capability]) api.tabs[name] = () => assert.fail('UI may not call native mutation APIs');
    const selection = createTodayTabSelection({ document, getContext: () => context });
    const ui = createTodaySplitUI({ document, selection, getContext: () => context, api,
        sendRequest: async request => { calls.push(structuredClone(request)); return send ? send(request) : response; },
        showStatus: text => statuses.push(text), begin: () => lifecycle.push('begin'), end: () => lifecycle.push('end'), refresh: async () => lifecycle.push('refresh'),
        onConsumeDrag: () => lifecycle.push('consume'), clearDropFeedback: () => lifecycle.push('clear-feedback') });
    const section = document.querySelector('[data-tab-type="temporary"]');
    for (const tab of tabs) {
        const row = document.createElement('div'); row.className = 'tab'; row.dataset.tabId = tab.id; row.dataset.url = tab.url;
        row.innerHTML = '<div class="tab-details"></div><button class="tab-close">Close</button>';
        section.append(row); selection.register(row); ui.register(row, tab);
    }
    const row = id => document.querySelector(`.tab[data-tab-id="${id}"]`);
    const event = (node, type, properties = {}) => {
        const e = new window.Event(type, { bubbles: true, cancelable: true }); Object.assign(e, { button: 0, ...properties }); node.dispatchEvent(e); return e;
    };
    const select = ids => { selection.clear(); for (const id of ids) event(row(id), 'click', { ctrlKey: true }); };
    const actions = id => ui.actionsFor(row(id), selection.freeze(row(id)));
    const target = id => row(id).querySelector('.today-split-target');
    return { document, window, context, tabs, calls, statuses, lifecycle, api, selection, ui, section, row, event, select, actions, target };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test('selected equal-URL pair sends exact immutable native render metadata through writer once', async () => {
    let resolve; const f = fixture({ send: () => new Promise(done => { resolve = done; }) });
    f.select([3, 1]); const action = f.actions(3).create;
    f.tabs[0].index = 9; f.tabs[0].groupId = 30; f.tabs[0].url = 'https://later.test/';
    const first = action(); await action();
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.calls[0], { type: 'todaySplitAction', action: 'create', windowId: 10, spaceId: 's', bookmarkFolderId: 'root', entries: [1, 3].map(tabId => ({ tabId, url: 'https://same.test/', index: tabId - 1, groupId: -1, pinned: false, splitViewId: -1 })) });
    assert.deepEqual(f.lifecycle, ['begin']); resolve({ success: true, reordered: true }); await first;
    assert.deepEqual(f.lifecycle, ['begin', 'end', 'refresh']); assert.match(f.statuses.at(-1), /adjacent in Today/);
});

for (const capability of ['none', 'createSplit', 'unsplit']) test(`missing ${capability} API pairing explains absence and installs no targets`, () => {
    const f = fixture({ capability }); f.select([1, 2]);
    assert.equal(f.document.querySelector('.today-split-target'), null);
    assert.deepEqual(f.actions(1), { hint: SPLIT_UNAVAILABLE }); assert.deepEqual(f.calls, []);
});

test('only exactly two eligible same-group unsplit Today rows create a pair', () => {
    for (const ids of [[1], [1, 2, 3], [1, 2, 3, 4]]) {
        const f = fixture(); f.select(ids); assert.equal(f.actions(ids[0]).create, undefined);
    }
    for (const value of [{ pinned: true }, { incognito: true }, { groupId: 8 }, { splitViewId: 0 }, { url: 'chrome-extension://extension/startup-launcher.html' }, { url: 'data:text/plain,a' }, { index: undefined }]) {
        const f = fixture({ overrides: { 2: value } }); f.select([1, 2]); assert.equal(f.actions(1).create, undefined);
    }
});

for (const change of ['url', 'id', 'membership', 'space', 'root', 'window', 'inversion', 'hidden', 'order', 'replacement', 'selection']) test(`menu selection rejects stale ${change} before sending`, async () => {
    const f = fixture(); f.select([1, 2]); const action = f.actions(1).create;
    if (change === 'url') f.row(2).dataset.url = 'https://changed.test/';
    if (change === 'id') f.row(2).dataset.tabId = '99';
    if (change === 'membership') f.context.spaces[0].spaceBookmarks.push(2);
    if (change === 'space') f.context.activeSpaceId = 'other';
    if (change === 'root') f.context.spaces[0].bookmarkFolderId = 'new-root';
    if (change === 'window') f.context.windowId = 99;
    if (change === 'inversion') f.section.dataset.todayOrderInverted = 'true';
    if (change === 'hidden') f.row(2).hidden = true;
    if (change === 'order') f.section.prepend(f.row(2));
    if (change === 'replacement') f.row(2).replaceWith(f.row(2).cloneNode(true));
    if (change === 'selection') f.select([3, 4]);
    await action(); assert.deepEqual(f.calls, []); assert.match(f.statuses.at(-1), /changed/);
});

test('existing split badges refuse dragging and End gathers only the exact registered Today pair', async () => {
    const f = fixture({ overrides: { 1: { splitViewId: 0 }, 2: { splitViewId: 0 } } });
    assert.equal(f.row(1).querySelector('.today-split-badge').textContent, 'Split View'); assert.equal(f.target(1), null);
    assert.equal(f.event(f.row(1), 'dragstart').defaultPrevented, true); assert.match(f.statuses.at(-1), /End Split View/);
    const action = f.actions(1); assert.equal(action.create, undefined); await action.end();
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].action, 'end'); assert.deepEqual(f.calls[0].entries.map(entry => entry.tabId), [1, 2]);
    assert(f.calls[0].entries.every(entry => entry.splitViewId === 0)); assert.match(f.statuses.at(-1), /Both tabs stay open/);
});

for (const change of ['three-members', 'partner-hidden', 'partner-pinned', 'mixed-selection']) test(`End refuses ${change} instead of acting on a single tab`, () => {
    const f = fixture({ overrides: { 1: { splitViewId: 5 }, 2: { splitViewId: 5 }, ...(change === 'three-members' ? { 3: { splitViewId: 5 } } : {}) } });
    if (change === 'partner-hidden') f.row(2).hidden = true;
    if (change === 'partner-pinned') { f.row(2).dataset.bookmarkId = 'bookmark'; f.context.spaces[0].spaceBookmarks.push(2); }
    if (change === 'mixed-selection') f.select([1, 3]);
    assert.equal(f.actions(1).end, undefined); assert.deepEqual(f.calls, []);
});

test('dedicated drop target consumes one exact pair, never bubbles into reorder or Favorites', async () => {
    const f = fixture(); let ordinary = 0;
    f.section.addEventListener('drop', () => ordinary++); f.document.addEventListener('drop', () => ordinary++);
    f.ui.startDrag(f.row(1)); assert(f.document.getElementById('spacesList').classList.contains('today-split-dragging'));
    const transfer = {};
    f.event(f.target(3), 'dragover', { dataTransfer: transfer }); assert.equal(transfer.dropEffect, 'move');
    const drop = f.event(f.target(3), 'drop', { dataTransfer: transfer }); f.event(f.target(3), 'drop'); await settle();
    assert.equal(drop.defaultPrevented, true); assert.equal(ordinary, 0); assert.equal(f.calls.length, 1);
    assert.deepEqual(f.calls[0].entries.map(entry => entry.tabId), [1, 3]); assert.equal(f.document.querySelector('.today-split-dragging'), null);
});

test('ordinary row drop is untouched; selected-pair click is a keyboard-activatable alternative', async () => {
    const f = fixture(); let ordinary = 0;
    f.section.addEventListener('drop', () => ordinary++);
    f.ui.startDrag(f.row(1)); f.event(f.row(3), 'drop'); assert.equal(ordinary, 1); assert.deepEqual(f.calls, []);
    f.ui.clearDrag(); f.select([1, 3]); f.event(f.target(3), 'click'); await settle();
    assert.equal(f.calls.length, 1); assert.match(f.target(3).getAttribute('aria-label'), /Create Split View with Tab 3/);
});

for (const change of ['self', 'url', 'hidden', 'move', 'window', 'replacement', 'spoof-target', 'spoof-source', 'group', 'escape', 'blur']) test(`split drop refuses ${change} without fallback reordering`, async () => {
    const f = fixture({ overrides: change === 'group' ? { 3: { groupId: 8 } } : {} }); let ordinary = 0; f.section.addEventListener('drop', () => ordinary++);
    f.ui.startDrag(f.row(1)); let target = f.target(3);
    if (change === 'self') target = f.target(1);
    if (change === 'url') f.row(3).dataset.url = 'https://changed.test/';
    if (change === 'hidden') f.row(3).hidden = true;
    if (change === 'move') f.section.prepend(f.row(3));
    if (change === 'window') f.context.windowId = 11;
    if (change === 'replacement') { const old = f.row(3); const clone = old.cloneNode(true); old.replaceWith(clone); target = clone.querySelector('.today-split-target'); }
    if (change === 'spoof-target') { target = target.cloneNode(true); f.row(3).append(target); }
    if (change === 'spoof-source') { const clone = f.row(1).cloneNode(true); f.section.append(clone); f.ui.startDrag(clone); }
    if (change === 'escape') f.event(f.document.body, 'keydown', { key: 'Escape' });
    if (change === 'blur') f.event(f.window, 'blur');
    f.event(target, 'drop'); await settle(); assert.deepEqual(f.calls, []);
    // LinkeDOM does not implement ancestor capture: real target listeners provide
    // isolation; unregistered clones are stopped at document capture in Chrome.
    if (!['replacement', 'spoof-target'].includes(change)) assert.equal(ordinary, 0);
});

for (const response of [undefined, { success: false, error: 'Native tab moved.' }]) test(`writer ${response ? 'error' : 'unknown response'} refreshes and never retries`, async () => {
    const f = fixture({ send: async () => response }); f.select([1, 2]); await f.actions(1).create();
    assert.equal(f.calls.length, 1); assert.deepEqual(f.lifecycle, ['begin', 'end', 'refresh']);
    assert.match(f.statuses.at(-1), response ? /Native tab moved/ : /unknown.*nothing was retried/);
});

test('transport rejection reports uncertainty, refreshes, and preserves no native result assumptions', async () => {
    const f = fixture({ send: async () => { throw new Error('channel closed'); } }); f.select([1, 2]); await f.actions(1).create();
    assert.equal(f.calls.length, 1); assert.match(f.statuses.at(-1), /unknown/); assert.deepEqual(f.lifecycle, ['begin', 'end', 'refresh']);
});


test('initial group deferral notice is partition-scoped, deduplicated and responds to session updates', async () => {
    let listener;
    const storage = { session: { get: async () => ({ spaceGroupSplitDeferrals: [{ spaceId: 's', windowId: 10, reason: 'native-split' }] }) }, onChanged: { addListener: callback => { listener = callback; } } };
    const f = fixture({ storage }); await settle();
    const notice = f.document.getElementById('todaySplitDeferralStatus'); assert(!notice.hidden); assert.match(notice.textContent, /pending tab-group changes/);
    listener({ spaceGroupSplitDeferrals: { newValue: [{ spaceId: 's', windowId: 11, reason: 'native-split' }] } }, 'local'); assert(!notice.hidden);
    f.context.windowId = 11; f.ui.register(f.row(1), f.tabs[0]); assert(notice.hidden);
    f.context.windowId = 10; f.ui.register(f.row(1), f.tabs[0]); assert(!notice.hidden); assert.equal(notice.getAttribute('aria-live'), 'off');
    listener({ spaceGroupSplitDeferrals: { newValue: [null, {}] } }, 'session'); assert(notice.hidden); assert.equal(notice.textContent, '');
});

test('new session deferral event wins over a delayed initial storage read', async () => {
    let listener, resolve;
    const storage = { session: { get: () => new Promise(done => { resolve = done; }) }, onChanged: { addListener: callback => { listener = callback; } } };
    const f = fixture({ storage });
    listener({ spaceGroupSplitDeferrals: { newValue: [] } }, 'session');
    resolve({ spaceGroupSplitDeferrals: [{ spaceId: 's', windowId: 10, reason: 'native-split' }] }); await settle();
    assert(f.document.getElementById('todaySplitDeferralStatus').hidden);
});

test('singleton hover Split click gives Split instructions without selecting or activating the row', () => {
    const f = fixture(); let activated = 0; f.row(1).addEventListener('click', () => activated++);
    f.event(f.target(1), 'click');
    assert.deepEqual(f.calls, []); assert.equal(activated, 0); assert.equal(f.selection.isSelected(f.row(1)), false);
    assert.equal(f.document.getElementById('todaySelectionStatus').hidden, true);
    assert.match(f.statuses.at(-1), /Select exactly two Today tabs/); assert.doesNotMatch(f.statuses.at(-1), /move to another Space/);
    assert.match(f.target(1).title, /Select two Today tabs/);
});

test('hover Split click outside the selected pair preserves that pair instead of replacing it by the clicked singleton', () => {
    const f = fixture(); f.select([1, 2]); const snapshot = f.selection.freeze(f.row(1));
    f.event(f.target(3), 'click');
    assert.equal(f.selection.validate(snapshot), true); assert.deepEqual(f.calls, []);
    assert.equal(f.selection.isSelected(f.row(1)), true); assert.equal(f.selection.isSelected(f.row(2)), true); assert.equal(f.selection.isSelected(f.row(3)), false);
    assert.match(f.statuses.at(-1), /including this tab/);
    assert.doesNotMatch(f.document.getElementById('todaySelectionStatus').textContent, /move to another Space/);
});

for (const options of [{ids:[1,2,3]}, {ids:[1,2],overrides:{2:{groupId:8}}}, {ids:[1,2],overrides:{2:{splitViewId:4}}}])
test(`hover Split refuses unsupported batch without changing it: ${JSON.stringify(options)}`, () => {
    const f = fixture({overrides:options.overrides}); f.select(options.ids); const snapshot=f.selection.freeze(f.row(1));
    f.event(f.target(1), 'click'); assert.deepEqual(f.calls, []); assert.equal(f.selection.validate(snapshot), true); assert.match(f.statuses.at(-1), /Split View/);
});
