import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpotlightBridge } from '../../spotlight-bridge.js';
import { readSpaceActionContext } from '../../spotlight-space-actions.js';
import { SpaceStore } from '../../space-store.js';
import { Utils } from '../../utils.js';
import { BRIDGE_TYPE, BRIDGE_VERSION, PEER_KEY, PAIRING_GENERATION_KEY, SPACE_ACTIONS_FEATURE, validateRequest, isSpaceActionContext } from '../../spotlight-bridge-protocol.js';

const PEER = 'a'.repeat(32), SELF = 'b'.repeat(32), URL = 'https://same.test/';
const clone = value => structuredClone(value);
const event = () => {
    const listeners = new Set();
    return { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn), emit: (...args) => { for (const fn of listeners) fn(...args); }, get size() { return listeners.size; } };
};
function fixture() {
    const hooks = {}, effects = [], globalTabs = new Set();
    const tabs = [{ id: 1, windowId: 10, index: 0, active: true, title: 'Today', url: URL },
        { id: 2, windowId: 10, index: 1, active: false, title: 'Saved', url: URL },
        { id: 3, windowId: 10, index: 2, active: false, title: 'Twin', url: URL },
        { id: 9, windowId: 20, index: 0, active: true, title: 'Other window copy', url: URL }];
    const windows = [{ id: 10, type: 'normal' }, { id: 20, type: 'normal' }];
    const nodes = [{ id: 'arc', parentId: 'bar', title: 'Arcify' }, { id: 'root', parentId: 'arc', title: 'Space' },
        { id: 'nested', parentId: 'root', title: 'Nested' }, { id: 'pin', parentId: 'nested', title: 'Saved', url: URL },
        { id: 'twin', parentId: 'nested', title: 'Separate same URL pin', url: URL }];
    const local = { [PEER_KEY]: PEER, [PAIRING_GENERATION_KEY]: 'generation-1', pinnedTabStatesById: {
        2: { bookmarkId: 'pin', pinnedUrl: URL }, 9: { bookmarkId: 'pin', pinnedUrl: URL }
    }, tabNameOverridesById: { 1: { name: 'My exact Today', originalDomain: 'same.test' }, 2: { name: 'Old alias' }, 3: { name: 'Other alias' }, 9: { name: 'Old alias' } } };
    const session = {}, sync = {};
    const area = (data, areaName) => ({
        async get(keys) {
            await hooks.storageGet?.(areaName, keys);
            const ids = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys || data);
            const result = Object.fromEntries(ids.map(id => [id, clone(data[id] ?? (typeof keys === 'object' && !Array.isArray(keys) ? keys?.[id] : undefined))]));
            await hooks.storageAfterGet?.(areaName, keys); return result;
        },
        async set(values) {
            await hooks.storageSet?.(areaName, values);
            const changes = Object.fromEntries(Object.entries(values).map(([key, newValue]) => [key, { oldValue: clone(data[key]), newValue: clone(newValue) }]));
            Object.assign(data, clone(values)); effects.push(['storage', areaName, clone(values)]);
            chrome.storage.onChanged.emit(changes, areaName);
            await hooks.storageAfterSet?.(areaName, values);
        }
    });
    globalThis.chrome = {
        runtime: { id: SELF, getURL: path => `chrome-extension://${SELF}/${path}` },
        storage: { local: area(local, 'local'), session: area(session, 'session'), sync: area(sync, 'sync'), onChanged: event() },
        windows: { async get(id) { await hooks.windowGet?.(id); const result = windows.find(window => window.id === id); if (!result) throw new Error('Closed window'); return clone(result); },
            async update() { effects.push(['forbidden-focus']); throw new Error('No cross-window focus'); } },
        tabs: {
            onActivated: event(), onUpdated: event(), onRemoved: event(), onAttached: event(), onDetached: event(), onReplaced: event(),
            async query(query = {}) { await hooks.tabQuery?.(query); const result = clone(tabs.filter(tab => query.windowId === undefined || tab.windowId === query.windowId)); await hooks.tabAfterQuery?.(); return result; },
            async get(id) { await hooks.tabGet?.(id); const tab = tabs.find(tab => tab.id === id); if (!tab) throw new Error('Closed tab'); return clone(tab); },
            async create(options) { const tab = { ...options, id: 100, title: 'Arcify settings', index: tabs.length }; tabs.push(tab); for (const other of tabs) if (other.windowId === tab.windowId && other.id !== tab.id) other.active = false; effects.push(['create-tab', clone(options)]); await hooks.createdTab?.(tab); return clone(tab); },
            async update() { effects.push(['forbidden-tab-update']); throw new Error('No native tab mutation'); },
            async move() { effects.push(['forbidden-tab-move']); throw new Error('No native tab reorder'); },
            async remove() { effects.push(['forbidden-tab-close']); throw new Error('No tab closures'); }
        },
        bookmarks: {
            onChanged: event(), onRemoved: event(), onMoved: event(), onCreated: event(),
            async get(id) { await hooks.bookmarkGet?.(id); return clone(nodes.filter(node => node.id === id)); },
            async search({ title }) { await hooks.bookmarkSearch?.(); return clone(nodes.filter(node => node.title === title)); },
            async getChildren(id) { await hooks.children?.(id); return clone(nodes.filter(node => node.parentId === id)); },
            async create(options) { await hooks.beforeCreate?.(options); const node = { ...clone(options), id: `created-${nodes.length}` }; nodes.push(node); effects.push(['create-bookmark', clone(node)]); chrome.bookmarks.onCreated.emit(node.id, clone(node)); await hooks.created?.(node); return clone(node); },
            async remove(id) { await hooks.beforeRemove?.(id); const index = nodes.findIndex(node => node.id === id); if (index < 0) throw new Error('Missing bookmark'); nodes.splice(index, 1); effects.push(['remove-bookmark', id]); chrome.bookmarks.onRemoved.emit(id); await hooks.removed?.(id); }
        }
    };
    Utils._pinnedStateChain = Promise.resolve(); Utils._tabNameChain = Promise.resolve();
    const store = new SpaceStore(); store.initialized = true;
    store.spaces = [{ id: 'space', name: 'Space', color: 'blue', bookmarkFolderId: 'root', temporaryTabs: [1, 3], spaceBookmarks: [2, 9] }];
    store.active = { 10: 'space', 20: 'space' }; store.provisional = new Set(); store.recoveryCandidates = new Set();
    store.isGlobalTab = id => globalTabs.has(typeof id === 'object' ? id.id : id);
    store.discoverBookmarkSpaces = async () => false;
    store.persist = async ({ beforeWrite, skipGroupSync } = {}) => {
        await hooks.persist?.(); await beforeWrite?.();
        await chrome.storage.local.set({ spaces: clone(store.spaces) });
        await beforeWrite?.(); await chrome.storage.session.set({ activeSpaces: clone(store.active) });
        effects.push(['persist', { skipGroupSync }]);
    };
    let id = 0;
    const request = (command, payload = {}) => ({ type: BRIDGE_TYPE, version: BRIDGE_VERSION, windowId: 10,
        requestId: `space-actions-${++id}`, supportedFeatures: [SPACE_ACTIONS_FEATURE], command, ...payload });
    const sender = { id: PEER, url: `chrome-extension://${PEER}/background.js` }, handle = createSpotlightBridge(store);
    const active = id => { for (const tab of tabs) if (tab.windowId === 10) tab.active = tab.id === id; };
    const capture = async (tabId = 1) => { const result = await handle(request('actionContext', { tabId }), sender); assert.equal(result.ok, true, JSON.stringify(result)); return result.actionContext; };
    const run = (command, context, payload = {}) => handle(request(command, { context, ...payload }), sender);
    const writes = () => effects.filter(([type, area, data]) => type !== 'storage' || !Object.hasOwn(data, 'spotlightBridgeRequests'));
    return { hooks, effects, tabs, windows, nodes, local, session, globalTabs, store, request, sender, handle, active, capture, run, writes };
}

function success(result) { assert.equal(result.ok, true, JSON.stringify(result)); return result; }
function error(result, code) { assert.equal(result.ok, false, JSON.stringify(result)); if (code) assert.equal(result.error.code, code, JSON.stringify(result)); }

test('new capability is opt-in, read context is explicit and legacy snapshots retain their shapes', async () => {
    const f = fixture(), legacy = f.request('hello'); delete legacy.supportedFeatures;
    assert(!success(await f.handle(legacy, f.sender)).capabilities.includes(SPACE_ACTIONS_FEATURE));
    assert(success(await f.handle(f.request('hello'), f.sender)).capabilities.includes(SPACE_ACTIONS_FEATURE));
    const context = await f.capture();
    assert.deepEqual(context, { windowId: 10, sourceTabId: 1, spaceId: 'space', bookmarkFolderId: 'root', pairingGeneration: 'generation-1',
        tab: { id: 1, url: URL, title: 'My exact Today', section: 'today', bookmark: null } });
    assert.equal(isSpaceActionContext(context), true); assert.deepEqual(f.writes(), []);
    const bad = f.request('createSpaceFolder', { context, title: 'No capability' }); delete bad.supportedFeatures;
    error(await f.handle(bad, f.sender), 'UNSUPPORTED_FEATURE'); assert.deepEqual(f.writes(), []);
});

test('strict action payload schema rejects surplus/missing fields, wrong IDs, oversized strings, missing confirmation and wrong section', async () => {
    const f = fixture(), context = await f.capture();
    const commands = ['actionContext', 'openSettings', 'createSpaceFolder', 'pinCurrentTab', 'removeCurrentPin'];
    const bad = [
        f.request('actionContext'), f.request('actionContext', { tabId: '1' }),
        f.request('pinCurrentTab', { context: { ...context, extra: true } }),
        f.request('pinCurrentTab', { context: { ...context, windowId: 20 } }),
        f.request('pinCurrentTab', { context: { ...context, tab: { ...context.tab, id: 9 } } }),
        f.request('pinCurrentTab', { context: { ...context, tab: { ...context.tab, url: 'javascript:alert(1)' } } }),
        f.request('pinCurrentTab', { context: { ...context, tab: { ...context.tab, title: 'x'.repeat(1025) } } }),
        f.request('createSpaceFolder', { context, title: '' }), f.request('createSpaceFolder', { context, title: 'x'.repeat(257) }),
        f.request('createSpaceFolder', { context, title: 'bad\nname' }), f.request('removeCurrentPin', { context, confirmed: true }),
        f.request('openSettings', { context, tabId: 1 }), f.request('openSettings', { context, supportedFeatures: [SPACE_ACTIONS_FEATURE, SPACE_ACTIONS_FEATURE] })
    ];
    for (const request of bad) assert.throws(() => validateRequest(request, commands), { code: 'INVALID_REQUEST' }, JSON.stringify(request));
    f.active(2); const saved = await f.capture(2);
    assert.throws(() => validateRequest(f.request('removeCurrentPin', { context: saved }), commands), { code: 'INVALID_REQUEST' });
    assert.throws(() => validateRequest(f.request('removeCurrentPin', { context: saved, confirmed: false }), commands), { code: 'INVALID_REQUEST' });
    assert.throws(() => validateRequest(f.request('pinCurrentTab', { context: saved }), commands), { code: 'INVALID_REQUEST' });
});

for (const source of ['spotlight-helper', 'browser-newtab', 'browser-newtab-slash', 'browser-newtab-suffix', 'arcify-helper', 'native-pin', 'global', 'split', 'ambiguous', 'pending-navigation']) test(`${source} retains only selected Space context; never borrows another tab`, async () => {
    const f = fixture();
    if (source === 'browser-newtab') f.tabs[0].url = 'chrome://newtab';
    if (source === 'browser-newtab-slash') f.tabs[0].url = 'chrome://newtab/';
    if (source === 'browser-newtab-suffix') f.tabs[0].url = 'chrome://newtab/#retained';
    if (source === 'spotlight-helper') f.tabs[0].url = `chrome-extension://${PEER}/newtab.html`;
    if (source === 'arcify-helper') f.tabs[0].url = chrome.runtime.getURL('startup-launcher.html');
    if (source === 'native-pin') f.tabs[0].pinned = true;
    if (source === 'global') f.globalTabs.add(1);
    if (source === 'split') f.tabs[0].splitViewId = 5;
    if (source === 'ambiguous') f.store.spaces[0].spaceBookmarks.push(1);
    if (source === 'pending-navigation') f.tabs[0].pendingUrl = 'https://elsewhere.test/';
    const context = await f.capture(); assert.equal(context.tab, null); assert.equal(context.sourceTabId, 1);
    error(await f.run('pinCurrentTab', context), 'INVALID_REQUEST');
    success(await f.run('createSpaceFolder', context, { title: 'Valid folder' }));
    assert.equal(f.effects.filter(([type]) => type === 'create-bookmark').length, 1);
    assert.equal(f.local.pinnedTabStatesById[1], undefined);
});

for (const url of ['chrome://newtab', 'chrome://newtab/']) test(`a prior content context cannot pin a later ${url} helper`, async () => {
    const f = fixture(), context = await f.capture();
    f.tabs[0].url = url;
    error(await f.run('pinCurrentTab', context), 'STALE_CONTEXT');
    assert.deepEqual(f.writes(), []);
    const helper = await f.capture();
    assert.equal(helper.tab, null);
    success(await f.run('openSettings', helper));
    assert.equal(f.effects.filter(([type]) => type === 'create-tab').length, 1);
    assert.equal(f.effects.filter(([type]) => type === 'create-bookmark').length, 0);
});

test('pin creates one distinct saved identity, preserves page/focus/selected Space/native order and never modifies equal-URL pins', async () => {
    const f = fixture(), context = await f.capture(), tabs = clone(f.tabs), active = clone(f.store.active), original = clone(f.nodes);
    const result = success(await f.run('pinCurrentTab', context));
    assert.equal(result.tabId, 1); assert(result.bookmarkId.startsWith('created-'));
    assert.deepEqual(f.nodes.slice(0, original.length), original);
    assert.deepEqual(f.nodes.at(-1), { id: result.bookmarkId, parentId: 'root', index: 1, title: 'My exact Today', url: URL });
    assert.deepEqual(f.local.pinnedTabStatesById[1], { bookmarkId: result.bookmarkId, pinnedUrl: URL });
    assert.deepEqual(f.store.spaces[0].temporaryTabs, [3]); assert.deepEqual(f.store.spaces[0].spaceBookmarks, [2, 9, 1]);
    assert.deepEqual(f.tabs, tabs); assert.deepEqual(f.store.active, active);
    assert.equal(f.effects.find(([type]) => type === 'persist')[1].skipGroupSync, true);
});

test('remove deletes exact saved bookmark, keeps all exact live copies as Today and preserves distinct same-URL pin', async () => {
    const f = fixture(); f.active(2); f.tabs[1].url = 'https://navigated.test/';
    const context = await f.capture(2), tabs = clone(f.tabs), active = clone(f.store.active);
    assert.equal(context.tab.bookmark.id, 'pin'); assert.equal(context.tab.url, 'https://navigated.test/');
    const result = success(await f.run('removeCurrentPin', context, { confirmed: true }));
    assert.equal(result.bookmarkId, 'pin'); assert.equal(result.tabId, 2);
    assert(!f.nodes.some(node => node.id === 'pin')); assert(f.nodes.some(node => node.id === 'twin'));
    assert.deepEqual(f.store.spaces[0].spaceBookmarks, []); assert.deepEqual(f.store.spaces[0].temporaryTabs, [1, 3, 2, 9]);
    assert.equal(f.local.pinnedTabStatesById[2], undefined); assert.equal(f.local.pinnedTabStatesById[9], undefined);
    assert.equal(f.local.tabNameOverridesById[2], undefined); assert.equal(f.local.tabNameOverridesById[9], undefined);
    assert.equal(f.local.tabNameOverridesById[3].name, 'Other alias');
    assert.deepEqual(f.tabs, tabs); assert.deepEqual(f.store.active, active);
});

for (const changed of ['closed', 'moved-window', 'active-tab', 'navigation', 'pending-navigation', 'space', 'root', 'root-moved', 'duplicate-root', 'binding', 'native-pin', 'split', 'global', 'ambiguous', 'pairing', 'revoked']) test(`stale ${changed} prevents a pin before bookmark commit`, async () => {
    const f = fixture(), context = await f.capture();
    if (changed === 'closed') f.tabs.shift();
    if (changed === 'moved-window') f.tabs[0].windowId = 20;
    if (changed === 'active-tab') f.active(3);
    if (changed === 'navigation') f.tabs[0].url += 'new';
    if (changed === 'pending-navigation') f.tabs[0].pendingUrl = 'https://pending.test/';
    if (changed === 'space') f.store.active[10] = 'missing';
    if (changed === 'root') f.store.spaces[0].bookmarkFolderId = 'changed';
    if (changed === 'root-moved') f.nodes[1].parentId = 'bar';
    if (changed === 'duplicate-root') f.nodes.push({ id: 'other-arc', title: 'Arcify' });
    if (changed === 'binding') f.local.pinnedTabStatesById[1] = { bookmarkId: 'twin', pinnedUrl: URL };
    if (changed === 'native-pin') f.tabs[0].pinned = true;
    if (changed === 'split') f.tabs[0].splitViewId = 0;
    if (changed === 'global') f.globalTabs.add(1);
    if (changed === 'ambiguous') f.store.spaces[0].spaceBookmarks.push(1);
    if (changed === 'pairing') f.local[PAIRING_GENERATION_KEY] = 'generation-2';
    if (changed === 'revoked') f.local[PEER_KEY] = '';
    error(await f.run('pinCurrentTab', context)); assert.deepEqual(f.writes(), []);
});

for (const changed of ['split-copy', 'native-copy', 'global-copy', 'ambiguous-copy', 'incognito-copy', 'popup-copy', 'binding-url', 'saved-title', 'saved-url', 'saved-parent', 'saved-deleted']) test(`remove rejects ${changed} before deleting anything`, async () => {
    const f = fixture(); f.active(2); const context = await f.capture(2);
    if (changed === 'split-copy') f.tabs[3].splitViewId = 1;
    if (changed === 'native-copy') f.tabs[3].pinned = true;
    if (changed === 'global-copy') f.globalTabs.add(9);
    if (changed === 'ambiguous-copy') f.store.spaces[0].temporaryTabs.push(9);
    if (changed === 'incognito-copy') f.tabs[3].incognito = true;
    if (changed === 'popup-copy') f.windows[1].type = 'popup';
    if (changed === 'binding-url') f.local.pinnedTabStatesById[9].pinnedUrl += 'changed';
    if (changed === 'saved-title') f.nodes[3].title = 'Changed';
    if (changed === 'saved-url') f.nodes[3].url += 'changed';
    if (changed === 'saved-parent') f.nodes[3].parentId = 'root';
    if (changed === 'saved-deleted') f.nodes.splice(3, 1);
    error(await f.run('removeCurrentPin', context, { confirmed: true })); assert.deepEqual(f.writes(), []);
});

test('folder trims title, commits once without a Space persistence dependency', async () => {
    const f = fixture(), context = await f.capture(); f.hooks.persist = () => { throw new Error('Should never persist a folder-only action'); };
    const result = success(await f.run('createSpaceFolder', context, { title: '  Named folder  ' }));
    assert.equal(f.nodes.find(node => node.id === result.folderId).title, 'Named folder');
    assert.deepEqual(f.writes().map(([kind]) => kind), ['create-bookmark']);
});

test('settings opens only Arcify options in the exact source window without focusing another window or changing Space', async () => {
    const f = fixture(), context = await f.capture(), active = clone(f.store.active);
    const result = success(await f.run('openSettings', context)); assert.equal(result.tabId, 100);
    assert.deepEqual(f.writes(), [['create-tab', { windowId: 10, active: true, url: chrome.runtime.getURL('options.html') }]]);
    assert.equal(f.tabs[0].url, URL); assert.deepEqual(f.store.active, active);
});

for (const phase of ['bookmark-read', 'binding-read', 'pairing-read', 'final-tab-read']) test(`current tab change during awaited ${phase} is rejected before mutation`, async () => {
    const f = fixture(), context = await f.capture(); let once = false;
    const change = () => { if (!once) { once = true; f.active(3); chrome.tabs.onActivated.emit({ tabId: 3, windowId: 10 }); } };
    if (phase === 'bookmark-read') f.hooks.bookmarkSearch = change;
    if (phase === 'binding-read') f.hooks.storageGet = (area, keys) => { if (keys === 'pinnedTabStatesById') change(); };
    if (phase === 'pairing-read') f.hooks.storageAfterGet = (area, keys) => { if (Array.isArray(keys) && keys.includes(PEER_KEY)) change(); };
    if (phase === 'final-tab-read') f.hooks.tabAfterQuery = change;
    error(await f.run('pinCurrentTab', context)); assert.deepEqual(f.writes(), []);
    assert.equal(chrome.tabs.onActivated.size, 0);
});

for (const phase of ['bookmark-read', 'binding-read', 'final-tab-read']) test(`pairing revocation during awaited ${phase} prevents the bookmark write`, async () => {
    const f = fixture(), context = await f.capture(); let once = false;
    const revoke = () => { if (!once) { once = true; f.local[PEER_KEY] = ''; chrome.storage.onChanged.emit({ [PEER_KEY]: { oldValue: PEER, newValue: '' } }, 'local'); } };
    if (phase === 'bookmark-read') f.hooks.bookmarkSearch = revoke;
    if (phase === 'binding-read') f.hooks.storageGet = (area, keys) => { if (keys === 'pinnedTabStatesById') revoke(); };
    if (phase === 'final-tab-read') f.hooks.tabAfterQuery = revoke;
    error(await f.run('pinCurrentTab', context)); assert.deepEqual(f.writes(), []);
});

for (const action of ['pinCurrentTab', 'removeCurrentPin']) for (const phase of ['bookmark-commit', 'binding-write', 'membership-write']) test(`${action} revocation after ${phase} reports partial commit and does not rollback, retry or write later`, async () => {
    const f = fixture(); if (action === 'removeCurrentPin') f.active(2);
    const context = await f.capture(action === 'removeCurrentPin' ? 2 : 1); let once = false, effectCount;
    const revoke = () => { if (!once) { once = true; f.local[PEER_KEY] = ''; effectCount = f.writes().length; } };
    if (phase === 'bookmark-commit') { f.hooks.created = revoke; f.hooks.removed = revoke; }
    if (phase === 'binding-write') f.hooks.storageAfterSet = (area, values) => { if (Object.hasOwn(values, 'pinnedTabStatesById')) revoke(); };
    if (phase === 'membership-write') f.hooks.storageAfterSet = (area, values) => { if (Object.hasOwn(values, 'spaces')) revoke(); };
    error(await f.run(action, context, action === 'removeCurrentPin' ? { confirmed: true } : {}), 'PARTIAL_COMMIT');
    assert.equal(once, true); assert.equal(f.writes().length, effectCount);
    assert.equal(f.effects.filter(([kind]) => kind === (action === 'pinCurrentTab' ? 'create-bookmark' : 'remove-bookmark')).length, 1);
    assert.equal(f.tabs.length, 4);
});

for (const failure of ['bookmark-unknown', 'bookmark-postcheck', 'binding', 'persist', 'final-journal']) test(`pin ${failure} failure never silently creates a duplicate`, async () => {
    const f = fixture(), context = await f.capture(); let created = false;
    if (failure === 'bookmark-unknown') f.hooks.created = () => { throw new Error('Bookmark reply lost'); };
    if (failure === 'bookmark-postcheck') { f.hooks.created = () => { created = true; }; f.hooks.children = () => { if (created) throw new Error('Bookmark refresh failed'); }; }
    if (failure === 'binding') f.hooks.storageSet = (area, values) => { if (Object.hasOwn(values, 'pinnedTabStatesById')) throw new Error('Binding unavailable'); };
    if (failure === 'persist') f.hooks.persist = () => { throw new Error('Persistence unavailable'); };
    if (failure === 'final-journal') f.hooks.storageSet = (area, values) => { if (values.spotlightBridgeRequests?.some(entry => entry.response)) throw new Error('Journal unavailable'); };
    const request = f.request('pinCurrentTab', { context }), result = await f.handle(request, f.sender);
    error(result, failure === 'bookmark-unknown' ? 'UNCERTAIN_RESULT' : 'PARTIAL_COMMIT');
    delete f.hooks.children; delete f.hooks.storageSet; delete f.hooks.persist; delete f.hooks.created;
    error(await f.handle(request, f.sender), 'UNCERTAIN_RESULT');
    assert.equal(f.effects.filter(([kind]) => kind === 'create-bookmark').length, 1);
});

test('completed request replays only its recorded result; changed data or pending IDs cannot execute again', async () => {
    const f = fixture(), context = await f.capture();
    const request = f.request('createSpaceFolder', { context, title: 'Exactly once' });
    const first = success(await f.handle(request, f.sender));
    const replay = success(await f.handle(request, f.sender)); assert.equal(first.folderId, replay.folderId);
    error(await f.handle({ ...request, title: 'Different' }, f.sender), 'INVALID_REQUEST');
    assert.equal(f.effects.filter(([kind]) => kind === 'create-bookmark').length, 1);
});

test('a final snapshot failure after folder commit reports partial and the recorded result cannot recreate it', async () => {
    const f = fixture(), context = await f.capture();
    f.hooks.created = () => { f.store.discoverBookmarkSpaces = async () => { throw new Error('Snapshot offline'); }; };
    const request = f.request('createSpaceFolder', { context, title: 'Committed' });
    error(await f.handle(request, f.sender), 'PARTIAL_COMMIT');
    f.store.discoverBookmarkSpaces = async () => false;
    success(await f.handle(request, f.sender)); assert.equal(f.effects.filter(([kind]) => kind === 'create-bookmark').length, 1);
});

test('read context rejects inactive IDs, stale selected Space and wrong windows instead of falling back', async () => {
    const f = fixture();
    error(await f.handle(f.request('actionContext', { tabId: 3 }), f.sender), 'STALE_CONTEXT');
    error(await f.handle(f.request('actionContext', { tabId: 9 }), f.sender), 'STALE_CONTEXT');
    f.store.active[10] = 'gone';
    await assert.rejects(readSpaceActionContext(f.store, { windowId: 10, tabId: 1 }), { code: 'STALE_CONTEXT' });
});

for (const withFavoriteCheckpoint of [false, true]) test(`real SpaceStore persistence guards its second stage (${withFavoriteCheckpoint ? 'Favorite checkpoint' : 'session'}) after the local commit`, async () => {
    const f = fixture(), store = f.store;
    Object.assign(store, { windowKeys: new Map(), restoreWindowKeys: new Map(), restoreQueue: [], restoredMetadata: [],
        snapshotByTab: new Map(), savedWindows: [], restoredRanks: new Map() });
    let revoked = false, checkpointCalled = false;
    const guard = async () => { if (revoked) throw new Error('Pairing revoked after local commit'); };
    f.hooks.storageAfterSet = (area, values) => { if (Object.hasOwn(values, 'spaces')) revoked = true; };
    if (withFavoriteCheckpoint) store.favoriteStore = { ownershipPersistence: { checkpointSelection: async ({ beforeWrite }) => {
        checkpointCalled = true; assert.equal(beforeWrite, guard); await beforeWrite();
        await chrome.storage.session.set({ shouldNeverWrite: true });
    } } };
    await assert.rejects(SpaceStore.prototype.persist.call(store, { beforeWrite: guard, skipGroupSync: true }), /Pairing revoked after local commit/);
    assert.equal(checkpointCalled, withFavoriteCheckpoint);
    assert.equal(f.effects.filter(([type, area]) => type === 'storage' && area === 'session').length, 0);
    assert.equal(f.effects.filter(([type, area]) => type === 'storage' && area === 'local').length, 1);
});

test('real SpaceStore guards pending restored binding metadata before writing it', async () => {
    const f = fixture(), store = f.store;
    Object.assign(store, { windowKeys: new Map(), restoreWindowKeys: new Map(), restoreQueue: [], restoredMetadata: [{ tabId: 1,
        pinnedState: { bookmarkId: 'unexpected', pinnedUrl: URL } }], snapshotByTab: new Map(), savedWindows: [], restoredRanks: new Map() });
    await assert.rejects(SpaceStore.prototype.persist.call(store, { skipGroupSync: true,
        beforeWrite: async () => { throw new Error('Pairing revoked during restored metadata reads'); } }), /Pairing revoked during restored metadata reads/);
    assert.deepEqual(f.writes(), []);
});

test('revocation during the last native read is rejected even before storage.onChanged delivery', async () => {
    const f = fixture(), context = await f.capture(); let reads = 0;
    f.hooks.tabAfterQuery = () => { if (++reads === 2) f.local[PEER_KEY] = ''; };
    error(await f.run('pinCurrentTab', context), 'UNAUTHORIZED'); assert.deepEqual(f.writes(), []);
});

test('revoke and repair during an awaited read still invalidates the captured pairing generation', async () => {
    const f = fixture(), context = await f.capture(); let once = false;
    f.hooks.bookmarkSearch = () => { if (!once) { once = true; f.local[PAIRING_GENERATION_KEY] = 'repaired-generation'; } };
    error(await f.run('createSpaceFolder', context, { title: 'Never' }), 'UNAUTHORIZED'); assert.deepEqual(f.writes(), []);
});

for (const action of ['pinCurrentTab', 'removeCurrentPin']) test(`${action} tolerates only exact delayed events from its own confirmed writes`, async () => {
    const f = fixture(); if (action === 'removeCurrentPin') f.active(2);
    const context = await f.capture(action === 'removeCurrentPin' ? 2 : 1);
    const delayed = callback => { f.hooks.bookmarkSearch = () => { delete f.hooks.bookmarkSearch; callback(); }; };
    f.hooks.created = node => delayed(() => chrome.bookmarks.onCreated.emit(node.id, clone(node)));
    f.hooks.removed = id => delayed(() => chrome.bookmarks.onRemoved.emit(id));
    const previous = new Map();
    f.hooks.storageSet = (area, values) => { for (const key of Object.keys(values)) previous.set(key, clone(f.local[key])); };
    f.hooks.storageAfterSet = (area, values) => {
        const key = ['pinnedTabStatesById', 'tabNameOverridesById', 'spaces'].find(key => Object.hasOwn(values, key));
        if (key) delayed(() => chrome.storage.onChanged.emit({ [key]: { oldValue: previous.get(key), newValue: clone(values[key]) } }, area));
    };
    success(await f.run(action, context, action === 'removeCurrentPin' ? { confirmed: true } : {}));
});

test('an unrelated background tab update does not invalidate the current exact source', async () => {
    const f = fixture(), context = await f.capture();
    f.hooks.bookmarkSearch = () => chrome.tabs.onUpdated.emit(999, { title: 'Unrelated loading tab' });
    success(await f.run('pinCurrentTab', context));
});

test('uncertain settings creation is journaled pending and is not replayed', async () => {
    const f = fixture(), context = await f.capture();
    f.hooks.createdTab = () => { throw new Error('Settings reply lost'); };
    const request = f.request('openSettings', { context });
    error(await f.handle(request, f.sender), 'UNCERTAIN_RESULT');
    delete f.hooks.createdTab;
    error(await f.handle(request, f.sender), 'UNCERTAIN_RESULT');
    assert.equal(f.effects.filter(([kind]) => kind === 'create-tab').length, 1);
});

test('mutation request journal stays bounded and retains the latest completed identity', async () => {
    const f = fixture(), context = await f.capture();
    for (let n = 0; n < 103; n++) success(await f.run('createSpaceFolder', context, { title: `Folder ${n}` }));
    assert.equal(f.session.spotlightBridgeRequests.length, 100);
    assert.equal(f.session.spotlightBridgeRequests.at(-1).response.folderId, f.nodes.at(-1).id);
    assert(f.session.spotlightBridgeRequests.every(entry => !('snapshot' in entry.response)));
});
