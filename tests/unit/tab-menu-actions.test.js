import test from 'node:test';
import assert from 'node:assert/strict';
import { runTabMenuAction, registerTabMenuMessages, normalizeTabMenuUrl } from '../../tab-menu-actions.js';
import { SpaceStore } from '../../space-store.js';
import { Utils } from '../../utils.js';

function fixture() {
    const tabs = [1, 2, 3, 9].map(id => ({ id, windowId: id === 9 ? 20 : 10, index: id, title: `Page ${id}`, url: 'https://same.test/', pinned: false, mutedInfo: { muted: false } }));
    const nodes = [{ id: 'arc', title: 'Arcify', parentId: 'bar' }, { id: 'root', title: 'Space', parentId: 'arc' }, { id: 'nested', title: 'Nested', parentId: 'root' },
        { id: 'pin', title: 'Saved title', url: 'https://same.test/', parentId: 'nested', index: 1 }, { id: 'twin', title: 'Other pin', url: 'https://same.test/', parentId: 'nested', index: 2 }];
    const local = { pinnedTabStatesById: { 2: { bookmarkId: 'pin', pinnedUrl: 'https://same.test/' }, 9: { bookmarkId: 'pin', pinnedUrl: 'https://same.test/' } }, tabNameOverridesById: { 1: { name: 'Alias' }, 2: { name: 'Old saved name' }, 3: { name: 'Twin alias' }, 9: { name: 'Old saved name' } } };
    const effects = [], hooks = {}, globalTabs = new Set(), listeners = [];
    globalThis.chrome = {
        runtime: { id: 'test', getURL: path => `chrome-extension://test/${path}`, onMessage: { addListener(fn) { listeners.push(fn); } } },
        storage: { local: { async get(key) { await hooks.storageGet?.(key); return { [key]: structuredClone(local[key]) }; }, async set(values) { await hooks.storageSet?.(values); Object.assign(local, structuredClone(values)); effects.push(['storage', structuredClone(values)]); await hooks.storageAfterSet?.(values); } } },
        windows: { async get(id) { return { id, type: 'normal', ...(hooks.window?.() || {}) }; } },
        tabs: { async get(id) { await hooks.tabGet?.(id); const tab = tabs.find(tab => tab.id === id); if (!tab) throw new Error('Closed'); return structuredClone(tab); },
            async query(query = {}) { await hooks.tabQuery?.(query); return structuredClone(tabs.filter(tab => query.windowId === undefined || tab.windowId === query.windowId)); },
            async update(id, values) { effects.push(['update-tab', id, values]); const tab = tabs.find(tab => tab.id === id); if ('muted' in values) tab.mutedInfo.muted = values.muted; return structuredClone(tab); },
            async duplicate(id) { const next = { ...structuredClone(tabs.find(tab => tab.id === id)), id: 100 }; tabs.push(next); effects.push(['duplicate', id]); await hooks.duplicate?.(next); return next; } },
        bookmarks: { async get(id) { return structuredClone(nodes.filter(node => node.id === id)); }, async search({ title }) { return structuredClone(nodes.filter(node => node.title === title)); },
            async getChildren(id) { await hooks.children?.(id); return structuredClone(nodes.filter(node => node.parentId === id)); },
            async update(id, values) { await hooks.updateBookmark?.(id, values); Object.assign(nodes.find(node => node.id === id), values); effects.push(['update-bookmark', id, values]); return structuredClone(nodes.find(node => node.id === id)); },
            async remove(id) { nodes.splice(nodes.findIndex(node => node.id === id), 1); effects.push(['remove-bookmark', id]); await hooks.removed?.(id); } }
    };
    Utils._pinnedStateChain = Promise.resolve(); Utils._tabNameChain = Promise.resolve();
    const store = new SpaceStore(); store.initialized = true; store.spaces = [{ id: 's', bookmarkFolderId: 'root', temporaryTabs: [1, 3], spaceBookmarks: [2, 9] }, { id: 'other', bookmarkFolderId: 'other-root', temporaryTabs: [], spaceBookmarks: [] }];
    store.active = { 10: 's', 20: 's' }; store.isGlobalTab = tab => globalTabs.has(typeof tab === 'object' ? tab.id : tab); store.persist = async () => { effects.push(['persist']); await hooks.persist?.(); };
    const ordinary = { windowId: 10, spaceId: 's', bookmarkFolderId: 'root', tabId: 1 };
    const pin = { ...ordinary, tabId: 2, bookmarkId: 'pin', parentId: 'nested' };
    const closed = { ...pin }; delete closed.tabId;
    const run = (target, action, extra = {}) => runTabMenuAction(store, { ...target, action, ...extra });
    const edit = async (target, action, value) => { const { expected } = await run(target, 'describe'); return run(target, action, { value, expected }); };
    return { tabs, nodes, local, effects, hooks, globalTabs, listeners, store, ordinary, pin, closed, run, edit };
}

test('ordinary alias is exact-ID, can clear, preserves equal URL twin, propagates storage failures', async () => {
    const f = fixture(); await f.edit(f.ordinary, 'rename', '  <b>My tab</b>  ');
    assert.equal(f.local.tabNameOverridesById[1].name, '<b>My tab</b>'); assert.equal(f.local.tabNameOverridesById[3].name, 'Twin alias');
    assert.equal(f.tabs[0].title, 'Page 1'); assert.equal(f.effects.some(([kind]) => kind.includes('tab') || kind.includes('bookmark')), false);
    await f.edit(f.ordinary, 'rename', ''); assert.equal(f.local.tabNameOverridesById[1], undefined);
    f.hooks.storageSet = () => { throw new Error('Storage unavailable'); }; await assert.rejects(f.edit(f.ordinary, 'rename', 'Again'), /Storage unavailable/);
});

for (const live of [false, true]) test(`${live ? 'live' : 'closed'} pin edits preserve exact saved identity, title, folder/order, cross-window bindings and open pages`, async () => {
    const f = fixture(), target = live ? f.pin : f.closed, beforeTabs = structuredClone(f.tabs);
    await f.edit(target, 'rename', 'Renamed saved pin');
    await f.edit(target, 'editUrl', 'https://new.test/path?q=1#section');
    assert.deepEqual(f.nodes.find(node => node.id === 'pin'), { id: 'pin', title: 'Renamed saved pin', url: 'https://new.test/path?q=1#section', parentId: 'nested', index: 1 });
    assert.equal(f.nodes.find(node => node.id === 'twin').title, 'Other pin'); assert.equal(f.nodes.find(node => node.id === 'twin').url, 'https://same.test/');
    assert.deepEqual(f.tabs, beforeTabs);
    for (const id of [2, 9]) { assert.equal(f.local.pinnedTabStatesById[id].pinnedUrl, 'https://new.test/path?q=1#section'); assert.equal(f.local.tabNameOverridesById[id], undefined); }
});

for (const reason of ['closed', 'window', 'space', 'active', 'native', 'global', 'binding', 'duplicate-membership', 'bookmark-moved', 'bookmark-removed', 'bookmark-changed', 'root-moved']) test(`stale ${reason} target cannot be edited`, async () => {
    const f = fixture(); const { expected } = await f.run(f.pin, 'describe');
    if (reason === 'closed') f.tabs.splice(1, 1);
    if (reason === 'window') f.tabs[1].windowId = 20;
    if (reason === 'space') { f.store.spaces[0].spaceBookmarks = [9]; f.store.spaces[1].spaceBookmarks = [2]; }
    if (reason === 'active') f.store.active[10] = 'other';
    if (reason === 'native') f.tabs[1].pinned = true;
    if (reason === 'global') f.globalTabs.add(2);
    if (reason === 'binding') f.local.pinnedTabStatesById[2].bookmarkId = 'twin';
    if (reason === 'duplicate-membership') f.store.spaces[0].temporaryTabs.push(2);
    if (reason === 'bookmark-moved') f.nodes.find(node => node.id === 'pin').parentId = 'root';
    if (reason === 'bookmark-removed') f.nodes.splice(f.nodes.findIndex(node => node.id === 'pin'), 1);
    if (reason === 'bookmark-changed') f.nodes.find(node => node.id === 'pin').url = 'https://changed.test/';
    if (reason === 'root-moved') f.nodes.find(node => node.id === 'root').parentId = 'bar';
    await assert.rejects(f.run(f.pin, 'rename', { value: 'Never', expected })); assert.deepEqual(f.effects, []);
});

test('second prewrite check catches a live row moved during alias storage reads', async () => {
    const f = fixture(); const { expected } = await f.run(f.ordinary, 'describe'); let reads = 0;
    f.hooks.storageGet = key => { if (key === 'tabNameOverridesById' && ++reads === 1) f.tabs[0].windowId = 20; };
    await assert.rejects(f.run(f.ordinary, 'rename', { value: 'Never', expected })); assert.deepEqual(f.effects, []);
});

test('copy uses clicked live current URL or exact closed saved URL; mute targets only the clicked live identity', async () => {
    const f = fixture(); f.tabs[1].url = 'https://navigated.test/';
    assert.equal((await f.run(f.pin, 'copyLink')).url, 'https://navigated.test/'); assert.equal((await f.run(f.closed, 'copyLink')).url, 'https://same.test/');
    await f.run(f.pin, 'mute', { value: true }); assert.equal(f.tabs[1].mutedInfo.muted, true); assert.equal(f.tabs[0].mutedInfo.muted, false);
    await assert.rejects(f.run(f.closed, 'mute', { value: true })); f.tabs.splice(1, 1); await assert.rejects(f.run(f.pin, 'copyLink'));
});

test('duplicate creates ordinary tab beside source in same Space without copying alias or binding', async () => {
    const f = fixture(); const result = await f.run(f.ordinary, 'duplicate'); assert.equal(result.tabId, 100);
    assert.deepEqual(f.store.spaces[0].temporaryTabs, [1, 100, 3]); assert.deepEqual(f.store.spaces[0].spaceBookmarks, [2, 9]);
    assert.equal(f.local.tabNameOverridesById[100], undefined); assert.equal(f.local.pinnedTabStatesById[100], undefined);
    assert.equal(f.tabs.find(tab => tab.id === 100).windowId, 10); await assert.rejects(f.run(f.pin, 'duplicate')); await assert.rejects(f.run(f.closed, 'duplicate'));
});

test('duplicate validates window after creation and reports partial result without closing any tab', async () => {
    const f = fixture(); f.hooks.duplicate = tab => { tab.windowId = 20; };
    await assert.rejects(f.run(f.ordinary, 'duplicate'), /duplicate was created/);
    assert.deepEqual(f.store.spaces[0].temporaryTabs, [1, 3]); assert.equal(f.tabs.length, 5);
});

test('remove pin deletes only saved membership, detaches exact cross-window bindings, keeps every page open', async () => {
    const f = fixture(), before = structuredClone(f.tabs); await f.run(f.closed, 'removePin');
    assert.deepEqual(f.tabs, before); assert.equal(f.nodes.some(node => node.id === 'pin'), false); assert(f.nodes.some(node => node.id === 'twin'));
    assert.deepEqual(f.store.spaces[0].spaceBookmarks, []); assert.deepEqual(f.store.spaces[0].temporaryTabs, [1, 3, 2, 9]);
    assert.deepEqual(f.local.pinnedTabStatesById, {}); assert.deepEqual(Object.keys(f.local.tabNameOverridesById), ['1', '3']);
});

for (const url of ['javascript:alert(1)', 'data:text/html,x', 'https://bad.test/a b', 'https://x.test/\nattack', '', 'not a url', 'chrome-extension://other/options.html']) test(`URL input rejects unsafe or malformed ${JSON.stringify(url)}`, () => assert.throws(() => normalizeTabMenuUrl(url)));
test('supported URL input is trimmed without rewriting saved spelling', () => { assert.equal(normalizeTabMenuUrl(' https://example.test/a?q=b#c '), 'https://example.test/a?q=b#c'); assert.equal(normalizeTabMenuUrl('file:///tmp/a.pdf'), 'file:///tmp/a.pdf'); });
test('invalid name and missing compare snapshot never write', async () => { const f = fixture(); for (const value of ['x'.repeat(257), 'a\nb', 1]) await assert.rejects(f.edit(f.ordinary, 'rename', value)); await assert.rejects(f.run(f.ordinary, 'rename', { value: 'Missing' })); assert.deepEqual(f.effects, []); });
test('saved mutation errors and postwrite refresh errors are surfaced without retries', async () => { const f = fixture(); f.hooks.updateBookmark = () => { throw new Error('Bookmarks failed'); }; await assert.rejects(f.edit(f.pin, 'editUrl', 'https://new.test/'), /Bookmarks failed/); assert.deepEqual(f.effects, []); delete f.hooks.updateBookmark; f.hooks.storageSet = () => { throw new Error('Refresh failed'); }; await assert.rejects(f.edit(f.pin, 'editUrl', 'https://new.test/'), /saved pin was updated/); assert.equal(f.effects.filter(([kind]) => kind === 'update-bookmark').length, 1); });
test('message handler rejects other extensions and foreign-window senders', () => { const f = fixture(); registerTabMenuMessages(f.store); for (const sender of [{ id: 'other' }, { id: 'test', url: 'https://bad.test/' }, { id: 'test', tab: { windowId: 20 } }]) { let response; f.listeners[0]({ type: 'tabMenuAction', ...f.ordinary, action: 'duplicate' }, sender, value => { response = value; }); assert.equal(response.success, false); } assert.deepEqual(f.effects, []); });


for (const closed of [false, true]) for (const liveId of [2, 9]) test(`remove ${closed ? 'closed' : 'live'} pin refuses exact split pane ${liveId} before deleting bookmark`, async () => {
    const f = fixture(); f.tabs.find(tab => tab.id === liveId).splitViewId = 77;
    const before = structuredClone(f.store.spaces), bindings = structuredClone(f.local.pinnedTabStatesById);
    await assert.rejects(f.run(closed ? f.closed : f.pin, 'removePin'), /End Split View/);
    assert.deepEqual(f.effects, []); assert.deepEqual(f.store.spaces, before); assert.deepEqual(f.local.pinnedTabStatesById, bindings);
});

for (const boundary of ['lookup', 'deleted', 'storage-set']) test(`remove pin rechecks cross-window pane after ${boundary}`, async () => {
    const f = fixture(), before = structuredClone(f.store.spaces), bindings = structuredClone(f.local.pinnedTabStatesById), aliases = structuredClone(f.local.tabNameOverridesById);
    if (boundary === 'lookup') f.hooks.children = () => { f.hooks.children = null; f.tabs.find(tab => tab.id === 9).splitViewId = 77; };
    if (boundary === 'deleted') f.hooks.removed = () => { f.tabs.find(tab => tab.id === 9).splitViewId = 77; };
    if (boundary === 'storage-set') f.hooks.storageAfterSet = values => {
        if (values.pinnedTabStatesById) { f.hooks.storageAfterSet = null; f.tabs.find(tab => tab.id === 9).splitViewId = 77; }
    };
    await assert.rejects(f.run(f.closed, 'removePin'), boundary === 'lookup' ? /End Split View/ : /saved pin was removed.*End Split View.*Nothing was retried or recreated/);
    assert.deepEqual(f.store.spaces, before); assert.deepEqual(f.local.pinnedTabStatesById, bindings); assert.deepEqual(f.local.tabNameOverridesById, aliases);
    assert.equal(f.effects.filter(([kind]) => kind === 'remove-bookmark').length, boundary === 'lookup' ? 0 : 1);
    assert(!f.effects.some(([kind]) => kind === 'persist')); assert.equal(f.tabs.length, 4);
});

test('remove pin restores other exact bindings but preserves a newer replacement binding', async () => {
    const f = fixture(), before = structuredClone(f.store.spaces), newer = { bookmarkId: 'twin', pinnedUrl: 'https://newer.test/' };
    f.hooks.storageAfterSet = values => { if (values.pinnedTabStatesById) {
        f.hooks.storageAfterSet = null; f.local.pinnedTabStatesById[2] = newer; f.tabs.find(tab => tab.id === 9).splitViewId = 77;
    } };
    await assert.rejects(f.run(f.closed, 'removePin'), /saved pin was removed/);
    assert.deepEqual(f.local.pinnedTabStatesById[2], newer); assert.equal(f.local.pinnedTabStatesById[9].bookmarkId, 'pin'); assert.deepEqual(f.store.spaces, before);
});

for (const late of [false, true]) test(`duplicate rejects ${late ? 'late' : 'existing'} native split before creating a tab`, async () => {
    const f = fixture();
    if (late) { let reads = 0; f.hooks.tabGet = id => { if (id === 1 && ++reads === 2) f.tabs[0].splitViewId = 77; }; }
    else f.tabs[0].splitViewId = 77;
    await assert.rejects(f.run(f.ordinary, 'duplicate'), /End Split View/); assert.deepEqual(f.effects, []); assert.deepEqual(f.store.spaces[0].temporaryTabs, [1, 3]);
});

test('split formed during duplicate keeps the duplicate but refuses canonical pair insertion', async () => {
    const f = fixture(); f.hooks.duplicate = () => { f.tabs[0].splitViewId = 77; f.tabs.find(tab => tab.id === 3).splitViewId = 77; };
    await assert.rejects(f.run(f.ordinary, 'duplicate'), /duplicate was created.*End Split View/);
    assert.deepEqual(f.effects, [['duplicate', 1]]); assert.deepEqual(f.store.spaces[0].temporaryTabs, [1, 3]); assert(f.tabs.some(tab => tab.id === 100));
});

test('remove pin checks every linked pane in a single final snapshot before deletion', async () => {
    const f = fixture(), before = structuredClone(f.store.spaces), bindings = structuredClone(f.local.pinnedTabStatesById);
    let snapshots = 0;
    f.hooks.tabGet = () => { throw new Error('Closed pin guard must not read linked panes serially'); };
    f.hooks.tabQuery = query => {
        snapshots++; assert.deepEqual(query, {});
        f.tabs.find(tab => tab.id === 2).splitViewId = 77;
    };
    await assert.rejects(f.run(f.closed, 'removePin'), /End Split View/);
    assert.equal(snapshots, 1); assert.deepEqual(f.effects, []);
    assert.deepEqual(f.store.spaces, before); assert.deepEqual(f.local.pinnedTabStatesById, bindings);
});

test('remove pin fails closed when its final native snapshot cannot be read', async () => {
    const f = fixture(); f.hooks.tabQuery = () => { throw new Error('Native snapshot unavailable'); };
    await assert.rejects(f.run(f.closed, 'removePin'), /Native snapshot unavailable/);
    assert.deepEqual(f.effects, []); assert(f.nodes.some(node => node.id === 'pin'));
});

test('duplicate rechecks its new pane after the binding read before canonical insertion', async () => {
    const f = fixture(); f.tabs.push({ ...f.tabs[0], id: 4 }); f.store.spaces[0].temporaryTabs.push(4);
    f.hooks.storageGet = key => {
        const duplicate = f.tabs.find(tab => tab.id === 100);
        if (key === 'pinnedTabStatesById' && duplicate) {
            duplicate.splitViewId = 77; f.tabs.find(tab => tab.id === 4).splitViewId = 77;
        }
    };
    await assert.rejects(f.run(f.ordinary, 'duplicate'), /duplicate was created.*End Split View/);
    assert.deepEqual(f.effects, [['duplicate', 1]]); assert.deepEqual(f.store.spaces[0].temporaryTabs, [1, 3, 4]);
    assert(f.tabs.some(tab => tab.id === 100));
});

test('duplicate retains its new tab and fails closed if the final native query fails', async () => {
    const f = fixture(); f.hooks.tabQuery = () => { throw new Error('Native snapshot unavailable'); };
    await assert.rejects(f.run(f.ordinary, 'duplicate'), /duplicate was created.*Native snapshot unavailable/);
    assert.deepEqual(f.effects, [['duplicate', 1]]); assert.deepEqual(f.store.spaces[0].temporaryTabs, [1, 3]);
    assert(f.tabs.some(tab => tab.id === 100));
});

test('duplicate can still assign its new identity when the source closed after creation', async () => {
    const f = fixture(); f.hooks.duplicate = () => { f.tabs.splice(f.tabs.findIndex(tab => tab.id === 1), 1); };
    assert.equal((await f.run(f.ordinary, 'duplicate')).tabId, 100);
    assert.deepEqual(f.store.spaces[0].temporaryTabs, [1, 100, 3]);
});
