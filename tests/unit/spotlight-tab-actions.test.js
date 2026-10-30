import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpotlightBridge } from '../../spotlight-bridge.js';
import { readTabActionContext } from '../../spotlight-tab-actions.js';
import { copyExactTextOffscreen } from '../../url-copy.js';
import { SpaceStore } from '../../space-store.js';
import { Utils } from '../../utils.js';
import { BRIDGE_TYPE, BRIDGE_VERSION, PEER_KEY, PAIRING_GENERATION_KEY, TAB_ACTIONS_FEATURE, TAB_ACTION_COMMANDS, validateRequest, isTabActionContext } from '../../spotlight-bridge-protocol.js';

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
    const local = { todayOrderRepresentation: { version: 1, inverted: false }, [PEER_KEY]: PEER, [PAIRING_GENERATION_KEY]: 'generation-1', pinnedTabStatesById: {
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
        runtime: { id: SELF, getURL: path => `chrome-extension://${SELF}/${path}`,
            async getContexts() { await hooks.contexts?.(); return []; },
            async sendMessage(message) { effects.push(['clipboard', clone(message)]); await hooks.clipboard?.(message); return hooks.clipboardResponse ? hooks.clipboardResponse(message) : { success: true, text: message.text }; } },
        offscreen: { async createDocument(options) { effects.push(['offscreen', clone(options)]); await hooks.offscreen?.(); } },
        storage: { local: area(local, 'local'), session: area(session, 'session'), sync: area(sync, 'sync'), onChanged: event() },
        windows: { async get(id) { await hooks.windowGet?.(id); const result = windows.find(window => window.id === id); if (!result) throw new Error('Closed window'); return clone(result); },
            async update() { effects.push(['forbidden-focus']); throw new Error('No cross-window focus'); } },
        tabs: {
            onActivated: event(), onUpdated: event(), onRemoved: event(), onAttached: event(), onDetached: event(), onReplaced: event(),
            async query(query = {}) { await hooks.tabQuery?.(query); const result = clone(tabs.filter(tab => query.windowId === undefined || tab.windowId === query.windowId)); await hooks.tabAfterQuery?.(); return result; },
            async get(id) { await hooks.tabGet?.(id); const tab = tabs.find(tab => tab.id === id); if (!tab) throw new Error('Closed tab'); return clone(tab); },
            async create(options) { const tab = { ...options, id: 100, title: 'Arcify settings', index: tabs.length }; tabs.push(tab); for (const other of tabs) if (other.windowId === tab.windowId && other.id !== tab.id) other.active = false; effects.push(['create-tab', clone(options)]); await hooks.createdTab?.(tab); return clone(tab); },
            async update(id, options) { const tab = tabs.find(item => item.id === id); tab.mutedInfo = { muted: options.muted }; effects.push(['mute', id, clone(options)]); await hooks.muted?.(tab); return clone(tab); },
            async duplicate(id) { const tab = { ...clone(tabs.find(item => item.id === id)), id: 100, index: 1 }; tabs.push(tab); for (const item of tabs) if (item.windowId === tab.windowId) item.active = item.id === tab.id; effects.push(['duplicate', id]); await hooks.duplicated?.(tab); return clone(tab); },
            async move() { effects.push(['forbidden-tab-move']); throw new Error('No native tab reorder'); },
            async remove() { effects.push(['forbidden-tab-close']); throw new Error('No tab closures'); }
        },
        bookmarks: {
            onChanged: event(), onRemoved: event(), onMoved: event(), onCreated: event(),
            async get(id) { await hooks.bookmarkGet?.(id); return clone(nodes.filter(node => node.id === id)); },
            async search({ title }) { await hooks.bookmarkSearch?.(); return clone(nodes.filter(node => node.title === title)); },
            async getChildren(id) { await hooks.children?.(id); return clone(nodes.filter(node => node.parentId === id)); },
            async create(options) { await hooks.beforeCreate?.(options); const node = { ...clone(options), id: `created-${nodes.length}` }; nodes.push(node); effects.push(['create-bookmark', clone(node)]); chrome.bookmarks.onCreated.emit(node.id, clone(node)); await hooks.created?.(node); return clone(node); },
            async update(id, options) { const node = nodes.find(item => item.id === id); Object.assign(node, options); effects.push(['bookmark-update', id, clone(options)]); chrome.bookmarks.onChanged.emit(id, clone(options)); await hooks.updatedBookmark?.(node); return clone(node); },
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
        requestId: `space-actions-${++id}`, supportedFeatures: [TAB_ACTIONS_FEATURE], command, ...payload });
    const sender = { id: PEER, url: `chrome-extension://${PEER}/background.js` }, handle = createSpotlightBridge(store);
    const active = id => { for (const tab of tabs) if (tab.windowId === 10) tab.active = tab.id === id; };
    const capture = async (tabId = 1) => { const result = await handle(request('tabActionContext', { tabId }), sender); assert.equal(result.ok, true, JSON.stringify(result)); return result.tabActionContext; };
    const run = (command, context, payload = {}) => handle(request(command, { context, ...payload }), sender);
    const writes = () => effects.filter(([type, area, data]) => type !== 'storage' || !Object.hasOwn(data, 'spotlightBridgeRequests'));
    return { hooks, effects, tabs, windows, nodes, local, session, globalTabs, store, request, sender, handle, active, capture, run, writes };
}

function success(result) { assert.equal(result.ok, true, JSON.stringify(result)); return result; }
function error(result, code) { assert.equal(result.ok, false, JSON.stringify(result)); if (code) assert.equal(result.error.code, code, JSON.stringify(result)); }

test('optional capability has its own strict context and preserves source alias and mute state', async () => {
    const f = fixture(), legacy = f.request('hello'); delete legacy.supportedFeatures;
    assert(!success(await f.handle(legacy, f.sender)).capabilities.includes(TAB_ACTIONS_FEATURE));
    assert(success(await f.handle(f.request('hello'), f.sender)).capabilities.includes(TAB_ACTIONS_FEATURE));
    const context = await f.capture();
    assert.deepEqual(context.tab, { id: 1, url: URL, title: 'My exact Today', section: 'today', bookmark: null, alias: 'My exact Today', muted: false });
    assert(isTabActionContext(context)); assert.deepEqual(f.writes(), []);
    const request = f.request('renameCurrentTab', { context, title: 'No feature' }); delete request.supportedFeatures;
    error(await f.handle(request, f.sender), 'UNSUPPORTED_FEATURE'); assert.deepEqual(f.writes(), []);
});

test('strict schema rejects extras, absent values, unsafe URLs and section mismatches', async () => {
    const f = fixture(), today = await f.capture(); f.active(2); const saved = await f.capture(2);
    const invalid = [
        ['renameCurrentTab', { context: today, title: 'x', extra: true }],
        ['renameCurrentTab', { context: today }], ['renameCurrentTab', { context: today, title: ' padded ' }], ['setCurrentTabMuted', { context: today, muted: false }], ['renameCurrentTab', { context: saved, title: ' ' }],
        ['renameCurrentTab', { context: today, title: 'a\nb' }], ['renameCurrentTab', { context: today, title: 'x'.repeat(257) }],
        ['editCurrentPinUrl', { context: today, url: URL }], ['duplicateCurrentTab', { context: saved }],
        ['setCurrentTabMuted', { context: today, muted: 1 }], ['copyCurrentLink', { context: { ...today, tab: null } }],
        ['copyCurrentLink', { context: { ...today, tab: { ...today.tab, alias: 1 } } }],
        ['copyCurrentLink', { context: { ...today, tab: { ...today.tab, muted: undefined } } }],
        ...['javascript:1', 'data:text/html,x', 'https:example.com', 'https:/example.com', String.raw`https:\example.com`, 'ftp://test/', 'about:settings', ' https://x.test/', 'https://x.test/a b', 'https://x.test/\n'].map(url => ['editCurrentPinUrl', { context: saved, url }])
    ];
    for (const [command, payload] of invalid) error(await f.handle(f.request(command, payload), f.sender), 'INVALID_REQUEST');
    assert.deepEqual(f.writes(), []);
});

for (const kind of ['helper', 'browser-newtab', 'global', 'pinned', 'split', 'ambiguous', 'pending']) test(`context excludes ${kind} without guessing a previous tab`, async () => {
    const f = fixture();
    if (kind === 'helper') f.tabs[0].url = `chrome-extension://${PEER}/newtab.html`;
    if (kind === 'browser-newtab') f.tabs[0].url = 'chrome://newtab/';
    if (kind === 'global') f.globalTabs.add(1);
    if (kind === 'pinned') f.tabs[0].pinned = true;
    if (kind === 'split') f.tabs[0].splitViewId = 1;
    if (kind === 'ambiguous') f.store.spaces[0].spaceBookmarks.push(1);
    if (kind === 'pending') f.tabs[0].pendingUrl = 'https://changed.test/';
    const context = await f.capture(); assert.equal(context.tab, null);
    for (const command of TAB_ACTION_COMMANDS) error(await f.run(command, context, command === 'renameCurrentTab' ? { title: 'No' } : command === 'setCurrentTabMuted' ? { muted: true } : command === 'editCurrentPinUrl' ? { url: URL } : {}), 'INVALID_REQUEST');
    assert.deepEqual(f.writes(), []);
});

test('Today rename and clear affect only exact alias, preserving same URL siblings and bookmark sources', async () => {
    const f = fixture(), nodes = clone(f.nodes), tabs = clone(f.tabs);
    let result = success(await f.run('renameCurrentTab', await f.capture(), { title: 'Named Today' }));
    assert.deepEqual({ tabId: result.tabId, bookmarkId: result.bookmarkId, title: result.title }, { tabId: 1, bookmarkId: null, title: 'Named Today' });
    assert.equal(f.local.tabNameOverridesById[1].name, 'Named Today');
    result = success(await f.run('renameCurrentTab', await f.capture(), { title: '' }));
    assert.equal(f.local.tabNameOverridesById[1], undefined);
    assert.equal(f.local.tabNameOverridesById[3].name, 'Other alias');
    assert.deepEqual(f.nodes, nodes); assert.deepEqual(f.tabs, tabs);
});

test('saved rename and URL edit preserve exact bookmark identity/title/folder and never navigate any live copy', async () => {
    const f = fixture(); f.active(2); const tabs = clone(f.tabs), other = clone(f.nodes[4]);
    const renamed = success(await f.run('renameCurrentTab', await f.capture(2), { title: 'Saved exact title' }));
    assert.equal(renamed.bookmarkId, 'pin'); assert.equal(renamed.title, 'Saved exact title');
    const edited = success(await f.run('editCurrentPinUrl', await f.capture(2), { url: 'https://new.test/path#fragment' }));
    assert.equal(edited.url, 'https://new.test/path#fragment');
    assert.deepEqual(f.nodes[3], { id: 'pin', parentId: 'nested', title: 'Saved exact title', url: edited.url });
    assert.deepEqual(f.nodes[4], other); assert.deepEqual(f.tabs, tabs);
    for (const id of [2, 9]) { assert.equal(f.local.pinnedTabStatesById[id].pinnedUrl, edited.url); assert.equal(f.local.tabNameOverridesById[id], undefined); }
    assert.equal(f.local.tabNameOverridesById[3].name, 'Other alias');
});

test('copy affirms exact live navigated URL, with no active lookup or page injection fallback', async () => {
    const f = fixture(); f.active(2); f.tabs[1].url = 'https://navigated.test/?q=exact#link';
    const context = await f.capture(2), result = success(await f.run('copyCurrentLink', context));
    assert.equal(result.copied, true); assert.equal(result.url, context.tab.url); assert.equal(result.tabId, 2);
    assert.deepEqual(f.effects.filter(([kind]) => kind === 'clipboard'), [['clipboard', { target: 'offscreen', type: 'copyToClipboard', text: context.tab.url }]]);
    assert.equal(f.effects.some(([kind]) => kind.includes('bookmark') || kind === 'mute' || kind === 'duplicate'), false);
});

for (const response of [undefined, { success: false }, { success: true }, { success: true, text: 'https://wrong.test/' }]) test(`clipboard never reports success without exact affirmative ack ${JSON.stringify(response)}`, async () => {
    const f = fixture(); f.hooks.clipboardResponse = () => response;
    const request = f.request('copyCurrentLink', { context: await f.capture() });
    error(await f.handle(request, f.sender), 'UNCERTAIN_RESULT');
    delete f.hooks.clipboardResponse; error(await f.handle(request, f.sender), 'UNCERTAIN_RESULT');
    assert.equal(f.effects.filter(([kind]) => kind === 'clipboard').length, 1);
});

test('mute and unmute set only captured exact tab with affirmative result', async () => {
    const f = fixture(); let result = success(await f.run('setCurrentTabMuted', await f.capture(), { muted: true }));
    assert.equal(result.muted, true); assert.equal(f.tabs[0].mutedInfo.muted, true); assert.equal(f.tabs[2].mutedInfo, undefined);
    result = success(await f.run('setCurrentTabMuted', await f.capture(), { muted: false })); assert.equal(result.muted, false);
    assert.deepEqual(f.effects.filter(([kind]) => kind === 'mute'), [['mute', 1, { muted: true }], ['mute', 1, { muted: false }]]);
});

test('duplicate uses canonical Today placement and never transfers alias or pin identity', async () => {
    const f = fixture(), result = success(await f.run('duplicateCurrentTab', await f.capture()));
    assert.equal(result.tabId, 100); assert.deepEqual(f.store.spaces[0].temporaryTabs, [1, 100, 3]);
    assert.deepEqual(f.store.spaces[0].spaceBookmarks, [2, 9]); assert.equal(f.local.tabNameOverridesById[100], undefined); assert.equal(f.local.pinnedTabStatesById[100], undefined);
});

for (const changed of ['closed', 'window', 'active', 'navigation', 'pending', 'space', 'root', 'alias', 'mute', 'binding', 'global', 'split', 'pairing', 'revoked']) test(`stale ${changed} blocks every Today action before mutation`, async () => {
    const f = fixture(), context = await f.capture();
    if (changed === 'closed') f.tabs.shift();
    if (changed === 'window') f.tabs[0].windowId = 20;
    if (changed === 'active') f.active(3);
    if (changed === 'navigation') f.tabs[0].url += 'other';
    if (changed === 'pending') f.tabs[0].pendingUrl = 'https://other.test/';
    if (changed === 'space') f.store.active[10] = 'missing';
    if (changed === 'root') f.nodes[1].parentId = 'bar';
    if (changed === 'alias') f.local.tabNameOverridesById[1].name = 'Changed';
    if (changed === 'mute') f.tabs[0].mutedInfo = { muted: true };
    if (changed === 'binding') f.local.pinnedTabStatesById[1] = { bookmarkId: 'twin', pinnedUrl: URL };
    if (changed === 'global') f.globalTabs.add(1);
    if (changed === 'split') f.tabs[0].splitViewId = 0;
    if (changed === 'pairing') f.local[PAIRING_GENERATION_KEY] = 'changed';
    if (changed === 'revoked') f.local[PEER_KEY] = '';
    for (const command of ['renameCurrentTab', 'duplicateCurrentTab', 'copyCurrentLink', 'setCurrentTabMuted']) error(await f.run(command, context, command === 'renameCurrentTab' ? { title: 'Never' } : command === 'setCurrentTabMuted' ? { muted: true } : {}));
    assert.deepEqual(f.writes(), []);
});

for (const changed of ['saved-title', 'saved-url', 'saved-parent', 'deleted', 'copy-window', 'copy-global', 'copy-binding', 'copy-split']) test(`saved edit rejects ${changed} without touching shared source or equal-URL pins`, async () => {
    const f = fixture(); f.active(2); const context = await f.capture(2);
    if (changed === 'saved-title') f.nodes[3].title += 'changed';
    if (changed === 'saved-url') f.nodes[3].url += 'changed';
    if (changed === 'saved-parent') f.nodes[3].parentId = 'root';
    if (changed === 'deleted') f.nodes.splice(3, 1);
    if (changed === 'copy-window') f.windows[1].type = 'popup';
    if (changed === 'copy-global') f.globalTabs.add(9);
    if (changed === 'copy-binding') f.local.pinnedTabStatesById[9].pinnedUrl += 'changed';
    if (changed === 'copy-split') f.tabs[3].splitViewId = 1;
    error(await f.run('editCurrentPinUrl', context, { url: 'https://never.test/' })); assert.deepEqual(f.writes(), []);
});

for (const boundary of ['bookmark-read', 'binding-read', 'native-read', 'offscreen-setup']) test(`pairing revoked during ${boundary} prevents clipboard send`, async () => {
    const f = fixture(), context = await f.capture(); let once = false;
    const revoke = () => { if (!once) { once = true; f.local[PEER_KEY] = ''; } };
    if (boundary === 'bookmark-read') f.hooks.bookmarkSearch = revoke;
    if (boundary === 'binding-read') f.hooks.storageGet = (area, key) => { if (key === 'pinnedTabStatesById') revoke(); };
    if (boundary === 'native-read') f.hooks.tabAfterQuery = revoke;
    if (boundary === 'offscreen-setup') f.hooks.offscreen = revoke;
    error(await f.run('copyCurrentLink', context)); assert.equal(f.effects.filter(([kind]) => kind === 'clipboard').length, 0);
});

for (const command of ['renameCurrentTab', 'editCurrentPinUrl', 'duplicateCurrentTab', 'copyCurrentLink', 'setCurrentTabMuted']) test(`${command} unknown outcome is one-shot and no replay retries it`, async () => {
    const f = fixture(); if (command === 'editCurrentPinUrl') f.active(2);
    const context = await f.capture(command === 'editCurrentPinUrl' ? 2 : 1);
    if (command === 'renameCurrentTab') f.hooks.storageAfterSet = (area, values) => { if (values.tabNameOverridesById) throw new Error('Lost write ack'); };
    if (command === 'editCurrentPinUrl') f.hooks.updatedBookmark = () => { throw new Error('Lost write ack'); };
    if (command === 'duplicateCurrentTab') f.hooks.duplicated = () => { throw new Error('Lost write ack'); };
    if (command === 'copyCurrentLink') f.hooks.clipboard = () => { throw new Error('Lost write ack'); };
    if (command === 'setCurrentTabMuted') f.hooks.muted = () => { throw new Error('Lost write ack'); };
    const request = f.request(command, { context, ...(command === 'renameCurrentTab' ? { title: 'Once' } : command === 'editCurrentPinUrl' ? { url: 'https://once.test/' } : command === 'setCurrentTabMuted' ? { muted: true } : {}) });
    error(await f.handle(request, f.sender), 'UNCERTAIN_RESULT'); const writes = clone(f.writes());
    error(await f.handle(request, f.sender), 'UNCERTAIN_RESULT'); assert.deepEqual(f.writes(), writes);
});

for (const boundary of ['bookmark', 'binding', 'aliases', 'persist']) test(`saved update revocation after ${boundary} stops later writes and reports partial commit`, async () => {
    const f = fixture(); f.active(2); const context = await f.capture(2); let count;
    const revoke = () => { f.local[PEER_KEY] = ''; count = f.writes().length; };
    if (boundary === 'bookmark') f.hooks.updatedBookmark = revoke;
    else f.hooks.storageAfterSet = (area, values) => { if (Object.hasOwn(values, boundary === 'binding' ? 'pinnedTabStatesById' : boundary === 'aliases' ? 'tabNameOverridesById' : 'spaces')) revoke(); };
    error(await f.run('editCurrentPinUrl', context, { url: 'https://once.test/' }), 'PARTIAL_COMMIT'); assert.equal(f.writes().length, count);
});

for (const change of ['source-close', 'duplicate-window', 'source-split', 'duplicate-split', 'pairing']) test(`duplicate after ${change} keeps created tab and stops without fallback or rollback`, async () => {
    const f = fixture(), context = await f.capture();
    f.hooks.duplicated = duplicate => {
        if (change === 'source-close') f.tabs.shift();
        if (change === 'duplicate-window') duplicate.windowId = 20;
        if (change === 'source-split') f.tabs[0].splitViewId = 1;
        if (change === 'duplicate-split') duplicate.splitViewId = 1;
        if (change === 'pairing') f.local[PEER_KEY] = '';
    };
    error(await f.run('duplicateCurrentTab', context), 'PARTIAL_COMMIT');
    assert(f.tabs.some(tab => tab.id === 100)); assert.deepEqual(f.store.spaces[0].temporaryTabs, [1, 3]);
    assert.equal(f.effects.filter(([kind]) => kind === 'duplicate').length, 1);
});

test('completed exact request replay returns recorded result without writing again; changed payload is rejected', async () => {
    const f = fixture(), request = f.request('setCurrentTabMuted', { context: await f.capture(), muted: true });
    success(await f.handle(request, f.sender)); success(await f.handle(request, f.sender));
    error(await f.handle({ ...request, muted: false }, f.sender), 'INVALID_REQUEST'); assert.equal(f.effects.filter(([kind]) => kind === 'mute').length, 1);
});

for (const source of ['persisted', 'loaded']) test(`global Favorite ${source} source bookmark IDs stay protected while same-URL siblings remain separate`, async () => {
    const f = fixture(); f.active(2); const context = await f.capture(2), before = clone(f.nodes);
    if (source === 'persisted') f.local.persistentFavorites = [{ id: 'favorite', sourceBookmarkId: 'pin', title: 'Favorite', url: URL }];
    else f.store.favoriteStore = { items: [{ id: 'favorite', sourceBookmarkId: 'pin' }], async initialize() {}, async reconcile() {} };
    error(await f.run('renameCurrentTab', context, { title: 'Never' }), 'STALE_CONTEXT');
    error(await f.run('editCurrentPinUrl', context, { url: 'https://never.test/' }), 'STALE_CONTEXT');
    assert.deepEqual(f.nodes, before); assert.deepEqual(f.writes(), []);
    if (source === 'loaded') delete f.store.favoriteStore;
    else assert.equal((await f.capture(2)).tab, null);
    f.local.persistentFavorites = [{ id: 'favorite', sourceBookmarkId: 'twin', title: 'Favorite', url: URL }];
    success(await f.run('renameCurrentTab', await f.capture(2), { title: 'Exact saved pin' }));
    assert.deepEqual(f.nodes[4], before[4]);
});

for (const phase of ['bookmark-read', 'binding-read', 'final-native-read']) test(`source switch away and back during ${phase} cannot authorize a stale action`, async () => {
    const f = fixture(), context = await f.capture(); let once = false;
    const change = () => { if (!once) { once = true; chrome.tabs.onActivated.emit({ windowId: 10, tabId: 3 }); chrome.tabs.onActivated.emit({ windowId: 10, tabId: 1 }); } };
    if (phase === 'bookmark-read') f.hooks.bookmarkSearch = change;
    if (phase === 'binding-read') f.hooks.storageGet = (area, key) => { if (key === 'pinnedTabStatesById') change(); };
    if (phase === 'final-native-read') f.hooks.tabAfterQuery = change;
    error(await f.run('renameCurrentTab', context, { title: 'Never' }), 'STALE_CONTEXT'); assert.deepEqual(f.writes(), []);
    assert.equal(chrome.tabs.onActivated.size, 0);
});

for (const command of ['renameCurrentTab', 'editCurrentPinUrl', 'duplicateCurrentTab', 'setCurrentTabMuted']) test(`${command} tolerates only delayed events matching its own confirmed writes`, async () => {
    const f = fixture(); if (command === 'editCurrentPinUrl') f.active(2);
    const context = await f.capture(command === 'editCurrentPinUrl' ? 2 : 1);
    const delayed = callback => { f.hooks.bookmarkSearch = () => { delete f.hooks.bookmarkSearch; callback(); }; };
    f.hooks.updatedBookmark = node => delayed(() => chrome.bookmarks.onChanged.emit(node.id, { title: node.title, url: node.url }));
    f.hooks.muted = tab => delayed(() => chrome.tabs.onUpdated.emit(tab.id, { mutedInfo: clone(tab.mutedInfo) }));
    f.hooks.duplicated = tab => delayed(() => chrome.tabs.onActivated.emit({ windowId: tab.windowId, tabId: tab.id }));
    const previous = new Map();
    f.hooks.storageSet = (area, values) => { for (const key of Object.keys(values)) previous.set(key, clone(f.local[key])); };
    f.hooks.storageAfterSet = (area, values) => {
        const key = ['pinnedTabStatesById', 'tabNameOverridesById', 'spaces'].find(key => Object.hasOwn(values, key));
        if (key) delayed(() => chrome.storage.onChanged.emit({ [key]: { oldValue: previous.get(key), newValue: clone(values[key]) } }, area));
    };
    success(await f.run(command, context, command === 'renameCurrentTab' ? { title: 'Named' } : command === 'editCurrentPinUrl' ? { url: 'https://new.test/' } : command === 'setCurrentTabMuted' ? { muted: true } : {}));
});

for (const inverted of [false, true]) for (const top of [false, true]) test(`duplicate canonical insertion honors inverted=${inverted}, top=${top}`, async () => {
    const f = fixture(); f.local.todayOrderRepresentation.inverted = inverted;
    chrome.storage.sync.get = async defaults => ({ ...defaults, todayNewTabsAtTop: top });
    success(await f.run('duplicateCurrentTab', await f.capture()));
    assert.deepEqual(f.store.spaces[0].temporaryTabs, inverted ? [100, 1, 3] : [1, 100, 3]);
});

test('copy helper reuses existing offscreen document and never queries or navigates tabs', async () => {
    const f = fixture(); chrome.runtime.getContexts = async () => [{ contextType: 'OFFSCREEN_DOCUMENT' }];
    const result = await copyExactTextOffscreen('https://exact.test/#fragment');
    assert.equal(result.text, 'https://exact.test/#fragment'); assert.deepEqual(f.effects.map(([kind]) => kind), ['clipboard']);
});

test('unavailable clipboard never falls back, and missing capture identities never select another tab', async () => {
    const f = fixture(), context = await f.capture(); delete chrome.offscreen;
    error(await f.run('copyCurrentLink', context)); assert.deepEqual(f.writes(), []);
    error(await f.handle(f.request('tabActionContext', { tabId: 3 }), f.sender), 'STALE_CONTEXT');
    error(await f.handle(f.request('tabActionContext', { tabId: 9 }), f.sender), 'STALE_CONTEXT');
});

test('saved edits preserve stale closed-ID aliases instead of expanding the live-copy mutation target', async () => {
    const f = fixture(); f.active(2);
    f.store.spaces[0].spaceBookmarks.push(55);
    f.local.pinnedTabStatesById[55] = { bookmarkId: 'pin', pinnedUrl: URL };
    f.local.tabNameOverridesById[55] = { name: 'Closed identity alias' };
    success(await f.run('renameCurrentTab', await f.capture(2), { title: 'Exact live copy edit' }));
    assert.equal(f.local.tabNameOverridesById[55].name, 'Closed identity alias');
    assert.equal(f.local.tabNameOverridesById[2], undefined); assert.equal(f.local.tabNameOverridesById[9], undefined);
});

for (const delayedEvent of [false, true]) test(`Today rename rejects a changed alias-domain record after commit (delayed event=${delayedEvent})`, async () => {
    const f = fixture(), context = await f.capture();
    f.hooks.storageAfterSet = (area, values) => {
        if (!values.tabNameOverridesById) return;
        const previous = clone(values.tabNameOverridesById);
        f.local.tabNameOverridesById[1].originalDomain = 'foreign.test';
        if (delayedEvent) f.hooks.bookmarkSearch = () => {
            delete f.hooks.bookmarkSearch;
            chrome.storage.onChanged.emit({ tabNameOverridesById: { oldValue: previous, newValue: clone(f.local.tabNameOverridesById) } }, 'local');
        };
    };
    error(await f.run('renameCurrentTab', context, { title: 'Exact alias' }), 'PARTIAL_COMMIT');
    assert.equal(f.effects.filter(([kind, area, values]) => kind === 'storage' && values.tabNameOverridesById).length, 1);
    assert.equal(f.effects.filter(([kind, area, values]) => kind === 'storage' && values.spaces).length, 0);
});

for (const boundary of ['duplicate', 'order-read', 'legacy-order-read']) test(`duplicate with missing canonical order stops all writes after revocation at ${boundary}`, async () => {
    const f = fixture(); delete f.local.todayOrderRepresentation;
    const context = await f.capture(); let writesAtRevoke;
    const revoke = () => { if (writesAtRevoke !== undefined) return; f.local[PEER_KEY] = ''; writesAtRevoke = f.writes().length; };
    if (boundary === 'duplicate') f.hooks.duplicated = revoke;
    else f.hooks.storageGet = (area, keys) => {
        if (boundary === 'order-read' ? area === 'local' && keys === 'todayOrderRepresentation'
            : area === 'sync' && Object.hasOwn(keys, 'invertTabOrder')) revoke();
    };
    const request = f.request('duplicateCurrentTab', { context });
    error(await f.handle(request, f.sender), 'PARTIAL_COMMIT');
    assert.equal(writesAtRevoke, 1); assert.equal(f.writes().length, writesAtRevoke);
    assert.equal(f.local.todayOrderRepresentation, undefined);
    assert.deepEqual(f.store.spaces[0].temporaryTabs, [1, 3]);
    assert(f.tabs.some(tab => tab.id === 100));
    f.local[PEER_KEY] = f.sender.id;
    error(await f.handle(request, f.sender), 'UNCERTAIN_RESULT');
    assert.equal(f.writes().length, writesAtRevoke);
    assert.equal(f.effects.filter(([kind]) => kind === 'duplicate').length, 1);
});

for (const inverted of [false, true]) test(`duplicate reads legacy inversion=${inverted} without initializing canonical order`, async () => {
    const f = fixture(); delete f.local.todayOrderRepresentation;
    const syncGet = chrome.storage.sync.get;
    chrome.storage.sync.get = async keys => ({ ...await syncGet(keys), ...(Object.hasOwn(keys, 'invertTabOrder') ? { invertTabOrder: inverted } : {}) });
    success(await f.run('duplicateCurrentTab', await f.capture()));
    assert.equal(f.local.todayOrderRepresentation, undefined);
    assert.deepEqual(f.store.spaces[0].temporaryTabs, inverted ? [100, 1, 3] : [1, 100, 3]);
});
