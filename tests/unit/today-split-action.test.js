import test from 'node:test';
import assert from 'node:assert/strict';
import { runTodaySplitAction, registerTodaySplitMessages, nativeSplitAvailable } from '../../today-split-action.js';
import { SpaceStore } from '../../space-store.js';
import { Utils } from '../../utils.js';

function fixture(pair = [1, 3]) {
    const tabs = [1, 2, 3, 4, 9].map((id, index) => ({ id, windowId: id === 9 ? 20 : 10, index: id === 9 ? 0 : index, url: `https://page.test/${id}`, pinned: false, groupId: -1, splitViewId: -1 }));
    const local = { pinnedTabStatesById: {} }, effects = [], hooks = {}, listeners = [], globals = new Set();
    const copy = value => structuredClone(value);
    globalThis.chrome = {
        runtime: { id: 'test', getURL: path => `chrome-extension://test/${path}`, onMessage: { addListener: fn => listeners.push(fn) } },
        windows: { async get(id) { await hooks.window?.(); return { id, type: 'normal', incognito: false, ...hooks.windowResult }; } },
        storage: { local: { async get(key) { await hooks.storage?.(); return { [key]: copy(local[key]) }; } } },
        tabs: {
            async query({ windowId }) { await hooks.query?.(); return copy(tabs.filter(tab => tab.windowId === windowId)); },
            async move(id, { index }) {
                effects.push(['move', id, index]); await hooks.moveBefore?.();
                const tab = tabs.find(tab => tab.id === id), list = tabs.filter(item => item.windowId === tab.windowId).sort((a, b) => a.index - b.index).filter(item => item.id !== id);
                list.splice(index, 0, tab); list.forEach((item, index) => { item.index = index; });
                await hooks.move?.(); return copy(tab);
            },
            async createSplit(ids) { effects.push(['create', ids]); await hooks.createBefore?.(); for (const id of ids) tabs.find(tab => tab.id === id).splitViewId = 77; await hooks.create?.(); return hooks.splitResult ?? 77; },
            async unsplit(id) { effects.push(['end', id]); for (const tab of tabs) if (tab.splitViewId === id) tab.splitViewId = -1; await hooks.end?.(); }
        }
    };
    Utils._pinnedStateChain = Promise.resolve();
    const store = new SpaceStore(); store.initialized = true;
    store.spaces = [{ id: 's', bookmarkFolderId: 'root', temporaryTabs: [1, 2, 3, 4, 9], spaceBookmarks: [] }, { id: 'other', bookmarkFolderId: 'other-root', temporaryTabs: [], spaceBookmarks: [] }];
    store.active = { 10: 's', 20: 's' }; store.isGlobalTab = id => globals.has(typeof id === 'object' ? id.id : id);
    store.persist = async options => { effects.push(['persist', copy(store.spaces[0].temporaryTabs), options]); await hooks.persist?.(); };
    const entry = id => { const tab = tabs.find(tab => tab.id === id); return { tabId: id, url: tab.url, index: tab.index, groupId: tab.groupId, pinned: tab.pinned, splitViewId: tab.splitViewId }; };
    const request = { type: 'todaySplitAction', action: 'create', windowId: 10, spaceId: 's', bookmarkFolderId: 'root', entries: pair.map(entry) };
    return { tabs, local, effects, hooks, listeners, globals, store, request, entry, run: (extra = {}) => runTodaySplitAction(store, { ...request, ...extra }), order: () => tabs.filter(tab => tab.windowId === 10).sort((a, b) => a.index - b.index).map(tab => tab.id) };
}

test('adjacent create preserves all IDs, pages, canonical and native order without any move/persist', async () => {
    const f = fixture([2, 1]), before = structuredClone(f.tabs);
    assert.deepEqual(await f.run(), { reordered: false });
    assert.deepEqual(f.effects, [['create', [1, 2]]]); assert.deepEqual(f.order(), [1, 2, 3, 4]);
    assert.deepEqual(f.store.spaces[0].temporaryTabs, [1, 2, 3, 4, 9]);
    assert.deepEqual(f.tabs.map(({ splitViewId, ...tab }) => tab), before.map(({ splitViewId, ...tab }) => tab));
});

test('nonadjacent create makes exactly one later-tab move and one canonical relocation, no coercion', async () => {
    const f = fixture([3, 1]); assert.deepEqual(await f.run(), { reordered: true });
    assert.deepEqual(f.effects, [['move', 3, 1], ['persist', [1, 3, 2, 4, 9], { skipGroupSync: true }], ['create', [1, 3]]]);
    assert.deepEqual(f.order(), [1, 3, 2, 4]); assert.equal(f.tabs.length, 5);
});

test('already canonical-adjacent nonadjacent native pair moves one native tab without rewriting storage', async () => {
    const f = fixture(); f.store.spaces[0].temporaryTabs = [1, 3, 9, 2, 4]; await f.run();
    assert.deepEqual(f.effects, [['move', 3, 1], ['create', [1, 3]]]);
});

test('end validates exact native pair and keeps both pages/order/ownership open', async () => {
    const f = fixture([1, 2]); f.tabs[0].splitViewId = 0; f.tabs[1].splitViewId = 0;
    await f.run({ action: 'end', entries: [f.entry(2), f.entry(1)] });
    assert.deepEqual(f.effects, [['end', 0]]); assert.deepEqual(f.order(), [1, 2, 3, 4]); assert.equal(f.tabs.length, 5);
});

for (const bad of [null, {}, { entries: [] }, { entries: [1, 2] }, { windowId: 0 }, { windowId: '10' }, { extra: true }, { action: 'unsplit' }, { spaceId: '' }]) test(`invalid request ${JSON.stringify(bad)} performs no writes`, async () => {
    const f = fixture(); await assert.rejects(bad === null || !Object.keys(bad).length ? runTodaySplitAction(f.store, bad) : f.run(bad)); assert.deepEqual(f.effects, []);
});
for (const [field, value] of [['tabId', 0], ['tabId', NaN], ['url', 'javascript:alert(1)'], ['index', -1], ['groupId', undefined], ['pinned', 1], ['splitViewId', -2], ['other', true]]) test(`invalid entry ${field} performs no writes`, async () => {
    const f = fixture(); f.request.entries[0][field] = value; await assert.rejects(f.run()); assert.deepEqual(f.effects, []);
});
for (const reason of ['duplicate-id', 'window', 'incognito', 'popup', 'native-pin', 'saved-pin', 'favorite', 'inactive-space', 'wrong-space', 'duplicate-membership', 'closed', 'navigate', 'pending-navigation', 'moved', 'group', 'split', 'helper', 'canonical-change']) test(`rejects ${reason} before any mutation`, async () => {
    const f = fixture(), first = f.tabs[0];
    if (reason === 'duplicate-id') f.request.entries[1] = { ...f.request.entries[0] };
    if (reason === 'window') first.windowId = 20;
    if (reason === 'incognito') first.incognito = true;
    if (reason === 'popup') f.hooks.windowResult = { type: 'popup' };
    if (reason === 'native-pin') first.pinned = true;
    if (reason === 'saved-pin') f.local.pinnedTabStatesById[1] = { bookmarkId: 'pin' };
    if (reason === 'favorite') f.globals.add(1);
    if (reason === 'inactive-space') f.store.active[10] = 'other';
    if (reason === 'wrong-space') { f.store.spaces[0].temporaryTabs.shift(); f.store.spaces[1].temporaryTabs.push(1); }
    if (reason === 'duplicate-membership') f.store.spaces[0].spaceBookmarks.push(1);
    if (reason === 'closed') f.tabs.shift();
    if (reason === 'navigate') first.url = 'https://changed.test/';
    if (reason === 'pending-navigation') first.pendingUrl = 'https://changed.test/';
    if (reason === 'moved') first.index = 20;
    if (reason === 'group') first.groupId = 5;
    if (reason === 'split') { first.splitViewId = 4; f.request.entries[0].splitViewId = 4; }
    if (reason === 'helper') { first.url = 'chrome-extension://test/startup-launcher.html'; f.request.entries[0].url = first.url; }
    if (reason === 'canonical-change') f.hooks.query = () => { f.store.spaces[0].temporaryTabs.reverse(); };
    await assert.rejects(f.run()); assert.deepEqual(f.effects, []);
});

for (const capability of ['createSplit', 'unsplit', 'both']) test(`missing ${capability} gives explanation and no effects`, async () => {
    const f = fixture(); if (capability === 'both') { delete chrome.tabs.createSplit; delete chrome.tabs.unsplit; } else delete chrome.tabs[capability];
    assert.equal(nativeSplitAvailable(), false); await assert.rejects(f.run(), /unavailable.*155/); assert.deepEqual(f.effects, []);
});

for (const reason of ['navigate', 'window', 'group', 'move', 'split', 'binding']) test(`second read catches ${reason} before adjacency move`, async () => {
    const f = fixture(); let n = 0; f.hooks.query = () => { if (++n !== 2) return;
        if (reason === 'navigate') f.tabs[0].url = 'https://changed.test/';
        if (reason === 'window') f.tabs[0].windowId = 20;
        if (reason === 'group') f.tabs[0].groupId = 8;
        if (reason === 'move') f.tabs[0].index = 6;
        if (reason === 'split') f.tabs[0].splitViewId = 7;
    };
    if (reason === 'binding') { let gets = 0; f.hooks.storage = () => { if (++gets === 2) f.local.pinnedTabStatesById[1] = { bookmarkId: 'saved' }; }; }
    await assert.rejects(f.run()); assert.deepEqual(f.effects, []);
});

for (const reason of ['navigate', 'window', 'group', 'split', 'native-order', 'active-space', 'canonical']) test(`after adjacency ${reason} reports partial move and never creates/closes/retries`, async () => {
    const f = fixture(); f.hooks.move = () => {
        if (reason === 'navigate') f.tabs[0].url = 'https://changed.test/';
        if (reason === 'window') f.tabs[0].windowId = 20;
        if (reason === 'group') f.tabs[0].groupId = 2;
        if (reason === 'split') f.tabs[0].splitViewId = 3;
        if (reason === 'native-order') { f.tabs[1].index = 3; f.tabs[3].index = 2; }
        if (reason === 'active-space') f.store.active[10] = 'other';
        if (reason === 'canonical') f.store.spaces[0].temporaryTabs.reverse();
    };
    await assert.rejects(f.run(), /placed next to each other.*did not close any tabs.*Nothing was retried/); assert.deepEqual(f.effects, [['move', 3, 1]]); assert.equal(f.tabs.length, 5);
});

test('persist failure reports retained partial reorder and does not create or retry', async () => {
    const f = fixture(); f.hooks.persist = () => { throw new Error('disk'); };
    await assert.rejects(f.run(), /placed next to each other.*disk/); assert.deepEqual(f.order(), [1, 3, 2, 4]); assert.equal(f.effects.length, 2);
});
test('create rejection after adjacency retains one native and canonical move without retry', async () => {
    const f = fixture(); f.hooks.createBefore = () => { throw new Error('Browser refused'); };
    await assert.rejects(f.run(), /placed next to each other.*Browser refused/); assert.equal(f.effects.filter(([kind]) => kind === 'create').length, 1);
    assert.deepEqual(f.store.spaces[0].temporaryTabs, [1, 3, 2, 4, 9]); assert.deepEqual(f.order(), [1, 3, 2, 4]);
});
test('uncertain move failure never retries or coerces native state', async () => {
    const f = fixture(); f.hooks.move = () => { throw new Error('lost reply'); }; await assert.rejects(f.run(), /adjacency move could not be confirmed/); assert.deepEqual(f.effects, [['move', 3, 1]]);
});
test('post-save navigation prevents the native split call', async () => {
    const f = fixture(); f.hooks.persist = () => { f.tabs[0].url = 'https://changed.test/'; }; await assert.rejects(f.run(), /placed next/); assert.equal(f.effects.length, 2);
});
test('success must confirm exact native split membership with no persisted split IDs', async () => {
    const f = fixture([1, 2]); f.hooks.create = () => { f.tabs[1].splitViewId = 99; }; await assert.rejects(f.run(), /Split View result could not be confirmed/); assert.equal(f.effects.length, 1);
    assert.equal(JSON.stringify(f.store.spaces).includes('splitViewId'), false);
});
for (const reason of ['wrong-partner', 'three-members', 'nonadjacent', 'changed-split']) test(`end refuses ${reason}`, async () => {
    const f = fixture([1, 2]); f.tabs[0].splitViewId = 5; f.tabs[1].splitViewId = 5;
    if (reason === 'wrong-partner') f.tabs[1].splitViewId = 6;
    if (reason === 'three-members') f.tabs[2].splitViewId = 5;
    if (reason === 'nonadjacent') f.tabs[1].index = 8;
    const entries = [f.entry(1), f.entry(2)]; if (reason === 'changed-split') f.tabs[1].splitViewId = 6;
    await assert.rejects(f.run({ action: 'end', entries })); assert.deepEqual(f.effects, []);
});
test('message handler rejects foreign origins, extensions and windows', () => {
    const f = fixture(); registerTodaySplitMessages(f.store);
    for (const sender of [{}, { id: 'other' }, { id: 'test', url: 'https://bad.test/' }, { id: 'test', origin: 'https://bad.test' }, { id: 'test', tab: { windowId: 20 } }]) {
        let response; f.listeners[0](f.request, sender, value => { response = value; }); assert.equal(response.success, false);
    }
    assert.deepEqual(f.effects, []);
});


test('equal URLs keep independent identities and do not adopt a twin', async () => {
    const f = fixture([1, 3]); f.tabs[1].url = f.tabs[0].url; const before = structuredClone(f.tabs[1]);
    await f.run(); assert.equal(f.tabs[1].splitViewId, -1); assert.equal(f.tabs[1].url, before.url);
    assert.deepEqual(f.effects.at(-1), ['create', [1, 3]]);
});

test('concurrent duplicate submissions serialize and cannot create a second split or move', async () => {
    const f = fixture(); const result = await Promise.allSettled([f.run(), f.run()]);
    assert.deepEqual(result.map(item => item.status), ['fulfilled', 'rejected']);
    assert.equal(f.effects.filter(([kind]) => kind === 'create').length, 1);
    assert.equal(f.effects.filter(([kind]) => kind === 'move').length, 1);
});

test('group-compatible existing native group is preserved without group or pin APIs', async () => {
    const f = fixture([1, 3]); for (const tab of f.tabs.filter(tab => tab.windowId === 10)) tab.groupId = 99;
    f.request.entries = [f.entry(1), f.entry(3)]; await f.run();
    assert(f.tabs.filter(tab => tab.windowId === 10).every(tab => tab.groupId === 99 && tab.pinned === false));
});

test('adjacent API failure and end API failure surface unknown outcomes without retries', async () => {
    const f = fixture([1, 2]); f.hooks.createBefore = () => { throw new Error('denied'); };
    await assert.rejects(f.run(), /Split View result could not be confirmed.*denied/); assert.equal(f.effects.length, 1);
    delete f.hooks.createBefore; f.effects.length = 0; f.tabs[0].splitViewId = 5; f.tabs[1].splitViewId = 5;
    f.hooks.end = () => { throw new Error('lost response'); };
    await assert.rejects(f.run({ action: 'end', entries: [f.entry(1), f.entry(2)] }), /could not be confirmed.*lost response/);
    assert.deepEqual(f.effects, [['end', 5]]);
});


test('adjacency canonical change preserves other-window slots and unrelated native pair', async () => {
    const f = fixture([1, 4]); f.store.spaces[0].temporaryTabs = [1, 9, 2, 3, 4];
    f.tabs[1].splitViewId = 55; f.tabs[2].splitViewId = 55;
    await f.run(); assert.deepEqual(f.store.spaces[0].temporaryTabs, [1, 9, 4, 2, 3]);
    assert.deepEqual(f.order(), [1, 4, 2, 3]); assert.equal(f.tabs[1].splitViewId, 55); assert.equal(f.tabs[2].splitViewId, 55);
});
