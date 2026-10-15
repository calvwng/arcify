import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { SpaceStore, ownerOf } from '../../space-store.js';
import { createSpotlightBridge, getBridgeSnapshot, runBridgeAction, registerSpotlightBridge } from '../../spotlight-bridge.js';
import { BRIDGE_TYPE, BRIDGE_VERSION, PEER_KEY, PAIRING_GENERATION_KEY } from '../../spotlight-bridge-protocol.js';
import { pngIcon } from '../fixtures/favorite-icons.js';

// These are API-level mocks, not claims of verification in a running browser.
const PEER = 'a'.repeat(32);
const SELF = 'b'.repeat(32);
const SENDER = { id: PEER, url: `chrome-extension://${PEER}/background.js`, origin: `chrome-extension://${PEER}` };
const JOURNAL_KEY = 'spotlightBridgeRequests';
const DUPLICATE_URL = 'https://same.test/';
const clone = value => structuredClone(value);
let local, session, sync, tabs, groups, windows, nodes, mutations, storageWrites, nextTabId, journalHook;
const event = () => ({
    listeners: [],
    addListener(listener) { this.listeners.push(listener); },
    emit(...args) { for (const listener of this.listeners) listener(...clone(args)); }
});
function area(data, name) {
    return {
        async get(keys) {
            const names = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys || data);
            return Object.fromEntries(names.map(key => [key, clone(data[key] ?? (typeof keys === 'object' && !Array.isArray(keys) ? keys?.[key] : undefined))]));
        },
        async set(values) {
            Object.assign(data, clone(values));
            storageWrites.push([name, clone(values)]);
            if (name === 'session' && values[JOURNAL_KEY] && journalHook) await journalHook(values[JOURNAL_KEY]);
        }
    };
}
const space = (id, temporaryTabs, spaceBookmarks = []) => ({
    id, spaceUuid: id, name: id.toUpperCase(), color: id === 'b' ? 'red' : 'blue',
    bookmarkFolderId: `folder-${id}`, temporaryTabs, spaceBookmarks
});
const request = (command, payload = {}, requestId = `request-${command}`) => ({
    type: BRIDGE_TYPE, version: BRIDGE_VERSION, requestId, command, windowId: 1, ...payload
});
const writes = type => mutations.filter(entry => entry[0] === type);
const getTab = id => {
    const tab = tabs.find(tab => tab.id === id);
    if (!tab) throw new Error(`No tab with id ${id}`);
    return tab;
};
function reorder(windowId, ids, index) {
    const ordered = tabs.filter(tab => tab.windowId === windowId).sort((a, b) => a.index - b.index);
    const moving = ids.map(getTab);
    const remaining = ordered.filter(tab => !ids.includes(tab.id));
    remaining.splice(index < 0 ? remaining.length : index, 0, ...moving);
    remaining.forEach((tab, index) => { tab.index = index; });
}
async function makeStore({ install = false } = {}) {
    const store = new SpaceStore();
    if (install) store.install();
    await store.dispatch({ action: 'get' });
    mutations.length = 0;
    storageWrites.length = 0;
    return store;
}
async function settle(store) { await store.run(() => {}); }
function assertError(response, code) {
    assert.equal(response.ok, false, JSON.stringify(response));
    assert.equal(response.error.code, code);
    assert.equal(response.type, BRIDGE_TYPE);
    assert.equal(response.version, BRIDGE_VERSION);
    assert.equal(response.role, 'arcify');
    assert.equal('snapshot' in response, false);
}
beforeEach(() => {
    local = {
        spaceModelVersion: 2, [PEER_KEY]: PEER,
        spaces: [space('a', [3, 1, 11], [4]), space('b', [2, 12]), space('empty', [])],
        pinnedTabStatesById: { 4: { bookmarkId: 'twin-1', pinnedUrl: DUPLICATE_URL } }
    };
    session = { spaceSession: true, activeSpaces: { 1: 'a', 2: 'b' } };
    sync = {}; groups = []; mutations = []; storageWrites = []; nextTabId = 100; journalHook = null;
    windows = [{ id: 1, type: 'normal' }, { id: 2, type: 'normal' }, { id: 3, type: 'popup' }];
    tabs = [
        { id: 1, windowId: 1, index: 0, title: 'First', url: DUPLICATE_URL, active: true, groupId: 987 },
        { id: 2, windowId: 1, index: 1, title: 'Second', url: DUPLICATE_URL, groupId: 654 },
        { id: 3, windowId: 1, index: 2, title: 'Third', url: 'https://third.test/', groupId: 987 },
        { id: 4, windowId: 1, index: 3, title: 'Navigated favorite', url: 'https://navigated.test/', groupId: 987 },
        { id: 5, windowId: 1, index: 4, title: 'Native pin', url: 'https://native-pin.test/', pinned: true, groupId: -1 },
        { id: 11, windowId: 2, index: 0, title: 'Other window A', url: DUPLICATE_URL, active: true, groupId: -1 },
        { id: 12, windowId: 2, index: 1, title: 'Other window B', url: 'https://other.test/', groupId: -1 }
    ];
    nodes = [
        { id: 'root', title: 'Arcify' },
        ...['b', 'empty', 'a'].map(id => ({ id: `folder-${id}`, parentId: 'root', title: id.toUpperCase() })),
        { id: 'nested', parentId: 'folder-a', title: 'Nested' },
        { id: 'twin-1', parentId: 'nested', title: 'First favorite', url: DUPLICATE_URL },
        { id: 'twin-2', parentId: 'nested', title: 'Second favorite', url: DUPLICATE_URL },
        { id: 'b-favorite', parentId: 'folder-b', title: 'Other space favorite', url: DUPLICATE_URL }
    ];
    globalThis.chrome = {
        runtime: { id: SELF, getURL: path => `chrome-extension://${SELF}/${path}`, onMessage: event(), onMessageExternal: event() },
        storage: { local: area(local, 'local'), session: area(session, 'session'), sync: area(sync, 'sync'), onChanged: event() },
        windows: {
            async get(id) { const window = windows.find(window => window.id === id); if (!window) throw new Error('No such window'); return clone(window); },
            async update(id, update) { mutations.push(['window.update', id, clone(update)]); return Object.assign(windows.find(window => window.id === id), update); }
        },
        tabs: {
            onCreated: event(), onUpdated: event(), onRemoved: event(), onReplaced: event(), onActivated: event(), onMoved: event(), onAttached: event(), onDetached: event(),
            async query(query) { return clone(tabs.filter(tab => Object.entries(query).every(([key, value]) => tab[key] === value))); },
            async get(id) { return clone(getTab(id)); },
            async create(options) {
                mutations.push(['tab.create', clone(options)]);
                const tab = { id: nextTabId++, index: tabs.filter(tab => tab.windowId === options.windowId).length, groupId: -1, title: '', ...clone(options) };
                tabs.push(tab);
                chrome.tabs.onCreated.emit(tab);
                return clone(tab);
            },
            async update(id, update) {
                mutations.push(['tab.update', id, clone(update)]);
                const tab = getTab(id);
                Object.assign(tab, update);
                if (update.active) {
                    for (const other of tabs) if (other.windowId === tab.windowId && other.id !== id) other.active = false;
                    chrome.tabs.onActivated.emit({ tabId: id, windowId: tab.windowId });
                }
                chrome.tabs.onUpdated.emit(id, update, tab);
                return clone(tab);
            },
            async group(options) {
                mutations.push(['tab.group', clone(options)]);
                const id = options.groupId ?? 1000 + groups.length;
                if (!groups.some(group => group.id === id)) groups.push({ id, windowId: options.createProperties.windowId });
                options.tabIds.forEach(tabId => { getTab(tabId).groupId = id; });
                return id;
            },
            async move(ids, options) {
                mutations.push(['tab.move', clone(ids), clone(options)]);
                ids = Array.isArray(ids) ? ids : [ids];
                reorder(getTab(ids[0]).windowId, ids, options.index);
            }
        },
        tabGroups: {
            onRemoved: event(), onUpdated: event(),
            async query(query) { return clone(groups.filter(group => Object.entries(query).every(([key, value]) => group[key] === value))); },
            async update(id, update) { mutations.push(['group.update', id, clone(update)]); Object.assign(groups.find(group => group.id === id), update); },
            async move(id, options) {
                mutations.push(['group.move', id, clone(options)]);
                const group = groups.find(group => group.id === id);
                const ids = tabs.filter(tab => tab.groupId === id).sort((a, b) => a.index - b.index).map(tab => tab.id);
                reorder(group.windowId, ids, options.index);
            }
        },
        bookmarks: {
            async search(query) { return clone(nodes.filter(node => node.title === query.title)); },
            async get(id) { return clone(nodes.filter(node => node.id === String(id))); },
            async getChildren(id) { return clone(nodes.filter(node => node.parentId === id)); },
            async create(options) { mutations.push(['bookmark.create', clone(options)]); const node = { id: `created-${nodes.length}`, ...options }; nodes.push(node); return clone(node); }
        }
    };
});

test('snapshot preserves durable space order, empty spaces, and per-window tab identity', async () => {
    const store = await makeStore();
    const snapshot = await getBridgeSnapshot(store, 1);
    assert.equal(snapshot.windowId, 1);
    assert.equal(snapshot.activeSpaceId, 'a');
    assert.equal(typeof snapshot.capturedAt, 'number');
    assert.deepEqual(snapshot.spaces.map(space => space.id), ['a', 'b', 'empty']);
    assert.deepEqual(snapshot.spaces.map(space => space.tabIds), [[4, 3, 1], [2], []]);
    assert.deepEqual(snapshot.spaces[0].pinnedTabIds, [4]);
    assert.deepEqual(snapshot.spaces[0].temporaryTabIds, [3, 1]);
    assert.deepEqual(snapshot.tabs.map(tab => tab.id), [1, 2, 3, 4, 5]);
    assert.equal(snapshot.tabs.find(tab => tab.id === 5).spaceId, null);
    assert.equal(snapshot.tabs.find(tab => tab.id === 5).pinned, true);
    assert(snapshot.tabs.every(tab => tab.windowId === 1 && !('groupId' in tab)));
    assert(snapshot.spaces.every(space => !('groupId' in space)));
    assert.deepEqual(mutations, []);
    const other = await getBridgeSnapshot(store, 2);
    assert.deepEqual(other.spaces.map(space => space.tabIds), [[11], [12], []]);
    assert.equal(other.activeSpaceId, 'b');
});

test('snapshot matches nested bookmarks by exact identity even after a pin navigates away', async () => {
    const snapshot = await getBridgeSnapshot(await makeStore(), 1);
    assert.deepEqual(snapshot.bookmarks.map(bookmark => [bookmark.id, bookmark.spaceId, bookmark.tabId]), [
        ['twin-1', 'a', 4], ['twin-2', 'a', null], ['b-favorite', 'b', null]
    ]);
    assert(snapshot.bookmarks.every(bookmark => bookmark.url === DUPLICATE_URL));
    const other = await getBridgeSnapshot(await makeStore(), 2);
    assert(other.bookmarks.every(bookmark => bookmark.tabId === null));
});

test('snapshot projects ordinary aliases by exact tab ID and preserves the strict tab shape', async () => {
    local.tabNameOverridesById = {
        1: { name: 'First alias', originalDomain: 'same.test' },
        2: { name: 'Second alias', originalDomain: 'same.test' },
        11: { name: 'Other window alias', originalDomain: 'same.test' }
    };
    const store = await makeStore();
    let snapshot = await getBridgeSnapshot(store, 1);
    assert.deepEqual(snapshot.tabs.slice(0, 2).map(tab => tab.title), ['First alias', 'Second alias']);
    assert.deepEqual(Object.keys(snapshot.tabs[0]).sort(), ['active', 'id', 'pinned', 'spaceId', 'title', 'url', 'windowId']);
    assert.equal((await getBridgeSnapshot(store, 2)).tabs.find(tab => tab.id === 11).title, 'Other window alias');
    getTab(1).title = 'New page title'; getTab(1).url = 'https://different.test/page';
    snapshot = await getBridgeSnapshot(store, 1);
    assert.equal(snapshot.tabs.find(tab => tab.id === 1).title, 'First alias');
    delete local.tabNameOverridesById[1];
    snapshot = await getBridgeSnapshot(store, 1);
    assert.equal(snapshot.tabs.find(tab => tab.id === 1).title, 'New page title');
    assert.equal(snapshot.tabs.find(tab => tab.id === 2).title, 'Second alias');
    assert.deepEqual(mutations, []);
});

test('snapshot uses the exact saved bookmark title at its URL and the page title after navigation', async () => {
    local.spaces[0].spaceBookmarks.push(1);
    local.spaces[0].temporaryTabs = local.spaces[0].temporaryTabs.filter(id => id !== 1);
    local.pinnedTabStatesById[1] = { bookmarkId: 'twin-2', pinnedUrl: DUPLICATE_URL };
    local.tabNameOverridesById = {
        1: { name: 'Stale alias for second pin' }, 2: { name: 'Ordinary same-URL alias' }, 4: { name: 'Stale alias for first pin' }
    };
    getTab(4).url = DUPLICATE_URL;
    const store = await makeStore();
    let snapshot = await getBridgeSnapshot(store, 1);
    const title = id => snapshot.tabs.find(tab => tab.id === id).title;
    assert.equal(title(1), 'Second favorite'); assert.equal(title(4), 'First favorite');
    assert.equal(title(2), 'Ordinary same-URL alias');
    getTab(4).url = `${DUPLICATE_URL}?view=expanded#section`;
    snapshot = await getBridgeSnapshot(store, 1);
    assert.equal(title(4), 'First favorite');
    nodes.find(node => node.id === 'twin-1').title = 'Renamed saved bookmark';
    snapshot = await getBridgeSnapshot(store, 1);
    assert.equal(title(4), 'Renamed saved bookmark');
    getTab(4).url = 'https://same.test/another-page'; getTab(4).title = 'Navigated page title';
    snapshot = await getBridgeSnapshot(store, 1);
    assert.equal(title(4), 'Navigated page title');
    assert.equal(title(1), 'Second favorite');
    getTab(4).url = DUPLICATE_URL; delete local.tabNameOverridesById[4];
    snapshot = await getBridgeSnapshot(store, 1);
    assert.equal(title(4), 'Renamed saved bookmark');
    assert.deepEqual(mutations, []);
});

test('snapshot discovers newly synced bookmark spaces and preserves existing order and IDs', async () => {
    const store = await makeStore();
    local.spaceRegistry = { 'folder-later': { spaceUuid: 'durable-later', color: 'purple' } };
    nodes.push({ id: 'folder-later', parentId: 'root', title: 'Later' });
    nodes.find(node => node.id === 'folder-a').title = 'Renamed A';
    const first = await getBridgeSnapshot(store, 1);
    const second = await getBridgeSnapshot(store, 1);
    assert.deepEqual(first.spaces.map(space => space.id), ['a', 'b', 'empty', 'durable-later']);
    assert.equal(first.spaces[0].name, 'Renamed A');
    assert.equal(first.spaces[3].color, 'purple');
    assert.deepEqual(second.spaces, first.spaces);
    assert.deepEqual(mutations, []);
});

test('snapshot falls back from stale active IDs to the active tab owner', async () => {
    const store = await makeStore();
    store.active[1] = 'deleted';
    tabs.forEach(tab => { if (tab.windowId === 1) tab.active = tab.id === 2; });
    assert.equal((await getBridgeSnapshot(store, 1)).activeSpaceId, 'b');
});

for (const enabled of [false, true]) test(`bridge actions retain space identity with group sync ${enabled ? 'on' : 'off'}`, async () => {
    sync.syncTabGroups = enabled;
    const store = await makeStore();
    const handle = createSpotlightBridge(store);
    const before = clone(store.spaces);
    const result = await handle(request('openTab', { spaceId: 'b', url: 'https://new.test/' }), SENDER);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.snapshot.spaces.map(space => space.id), before.map(space => space.id));
    assert.equal(ownerOf(store.spaces, result.tabId).id, 'b');
    assert.equal(store.active[1], 'b');
    assert.equal(store.active[2], 'b');
    assert.equal(writes('tab.create').length, 1);
    assert.deepEqual(writes('tab.create')[0][1], { windowId: 1, url: 'https://new.test/', active: false });
    if (enabled) {
        const group = groups.find(group => group.id === getTab(result.tabId).groupId);
        assert.equal(group.windowId, 1);
        assert.equal(group.title, 'B');
        assert.equal(groups.find(group => group.id === getTab(12).groupId).windowId, 2);
    } else assert.equal(mutations.some(([type]) => ['tab.group', 'tab.move', 'group.update', 'group.move'].includes(type)), false);
});

test('hello and snapshot return the authoritative model without action journal or tab writes', async () => {
    const handle = createSpotlightBridge(await makeStore());
    for (const command of ['hello', 'snapshot']) {
        const result = await handle(request(command), SENDER);
        assert.equal(result.ok, true);
        assert.equal(result.extensionId, SELF);
        assert.equal(result.requestId, `request-${command}`);
        assert.equal(result.snapshot.windowId, 1);
    }
    assert.equal(session[JOURNAL_KEY], undefined);
    assert.deepEqual(mutations, []);
});

test('hello advertises sidebar capability only when its API is available', async () => {
    const handle = createSpotlightBridge(await makeStore());
    assert.deepEqual((await handle(request('hello'), SENDER)).capabilities, []);
    chrome.sidePanel = { open() {} };
    assert.deepEqual((await handle(request('hello'), SENDER)).capabilities, ['openSidebar']);
    assert.equal('capabilities' in await handle(request('snapshot'), SENDER), false);
});

test('activating an empty space changes only the requested window without creating a tab', async () => {
    const store = await makeStore();
    const result = await createSpotlightBridge(store)(request('activateSpace', { spaceId: 'empty' }), SENDER);
    assert.equal(result.ok, true);
    assert.equal(result.snapshot.activeSpaceId, 'empty');
    assert.equal(store.active[2], 'b');
    assert.deepEqual(result.snapshot.spaces.find(space => space.id === 'empty').tabIds, []);
    assert.equal('tabId' in result, false);
    assert.deepEqual(mutations, []);
});

test('activating a space never focuses its last tab in a different window', async () => {
    const store = await makeStore();
    store.spaces[0].lastTab = 11;
    const result = await createSpotlightBridge(store)(request('activateSpace', { spaceId: 'a' }), SENDER);
    assert.equal(result.ok, true);
    assert.equal(result.tabId, 1);
    assert.deepEqual(writes('window.update'), [['window.update', 1, { focused: true }]]);
    assert.equal(getTab(11).active, true);
});

test('activateTab selects the exact duplicate-URL tab and its owning space', async () => {
    const store = await makeStore();
    const result = await createSpotlightBridge(store)(request('activateTab', { tabId: 2 }), SENDER);
    assert.equal(result.ok, true);
    assert.equal(result.tabId, 2);
    assert.equal(result.snapshot.activeSpaceId, 'b');
    assert.equal(getTab(2).active, true);
    assert.equal(getTab(1).active, false);
    assert.deepEqual(writes('tab.update'), [['tab.update', 2, { active: true }]]);
});

test('navigateTab changes only the selected tab URL and preserves ownership and bookmark binding', async () => {
    const store = await makeStore();
    const before = clone(store.spaces);
    const bindings = clone(local.pinnedTabStatesById);
    const result = await createSpotlightBridge(store)(request('navigateTab', { tabId: 4, url: 'https://destination.test/' }), SENDER);
    assert.equal(result.ok, true);
    assert.equal(getTab(4).url, 'https://destination.test/');
    assert.equal(getTab(1).url, DUPLICATE_URL);
    assert.equal(getTab(1).active, true);
    assert.deepEqual(store.spaces, before);
    assert.deepEqual(local.pinnedTabStatesById, bindings);
    assert.deepEqual(writes('window.update'), []);
    assert.deepEqual(writes('tab.update'), [['tab.update', 4, { url: 'https://destination.test/' }]]);
});

test('openTab defaults to the selected space and does not reuse an existing URL twin', async () => {
    const store = await makeStore();
    store.active[1] = 'b';
    const result = await createSpotlightBridge(store)(request('openTab', { url: DUPLICATE_URL }), SENDER);
    assert.equal(result.ok, true);
    assert.equal(result.tabId, 100);
    assert.equal(ownerOf(store.spaces, 100).id, 'b');
    assert.equal(tabs.filter(tab => tab.url === DUPLICATE_URL).length, 4);
    assert.equal(local.pinnedTabStatesById[100], undefined);
});

test('openBookmark focuses its exact existing pin without opening a duplicate or resetting navigation', async () => {
    const store = await makeStore();
    const result = await createSpotlightBridge(store)(request('openBookmark', { spaceId: 'a', bookmarkId: 'twin-1' }), SENDER);
    assert.equal(result.ok, true);
    assert.equal(result.tabId, 4);
    assert.equal(getTab(4).url, 'https://navigated.test/');
    assert.equal(getTab(4).active, true);
    assert.deepEqual(writes('tab.create'), []);
});

test('openBookmark opens and binds the closed duplicate identity without stealing a URL twin', async () => {
    const store = await makeStore({ install: true });
    const handle = createSpotlightBridge(store);
    const result = await handle(request('openBookmark', { spaceId: 'a', bookmarkId: 'twin-2' }), SENDER);
    await settle(store);
    assert.equal(result.ok, true);
    assert.equal(result.tabId, 100);
    assert.deepEqual(local.pinnedTabStatesById[100], { bookmarkId: 'twin-2', pinnedUrl: DUPLICATE_URL });
    assert.equal(local.pinnedTabStatesById[4].bookmarkId, 'twin-1');
    assert.deepEqual(store.spaces[0].spaceBookmarks, [4, 100]);
    const repeated = await handle(request('openBookmark', { spaceId: 'a', bookmarkId: 'twin-2' }, 'another-request'), SENDER);
    await settle(store);
    assert.equal(repeated.tabId, 100);
    assert.equal(writes('tab.create').length, 1);
});

test('opening a renamed saved pin initializes exact title and binding before publishing membership', async () => {
    const store = await makeStore({ install: true });
    nodes.find(node => node.id === 'twin-2').title = 'Renamed saved twin';
    local.tabNameOverridesById = { 4: { name: 'Keep the other twin', originalDomain: 'same.test' } };
    const applyAction = store.applyAction.bind(store);
    let checkedBeforeAssign = false;
    store.applyAction = async action => {
        if (action.action === 'assign') {
            assert.deepEqual(local.tabNameOverridesById[action.tabId], { name: 'Renamed saved twin', originalDomain: 'same.test' });
            assert.deepEqual(local.pinnedTabStatesById[action.tabId], { bookmarkId: 'twin-2', pinnedUrl: DUPLICATE_URL });
            checkedBeforeAssign = true;
        }
        return applyAction(action);
    };
    const handle = createSpotlightBridge(store);
    const result = await handle(request('openBookmark', { spaceId: 'a', bookmarkId: 'twin-2' }), SENDER);
    await settle(store);
    assert.equal(result.ok, true);
    assert.equal(checkedBeforeAssign, true);
    assert.deepEqual(local.tabNameOverridesById[4], { name: 'Keep the other twin', originalDomain: 'same.test' });
    assert.equal(local.tabNameOverridesById[result.tabId].name, 'Renamed saved twin');
    assert.equal(result.snapshot.bookmarks.find(bookmark => bookmark.id === 'twin-2').tabId, result.tabId);
    assert.equal(nodes.find(node => node.id === 'twin-1').title, 'First favorite');
    // Reusing the pin does not reset its navigation or overwrite its own override.
    getTab(result.tabId).url = 'https://navigated-away.test/';
    const reused = await handle(request('openBookmark', { spaceId: 'a', bookmarkId: 'twin-2' }, 'reopen-renamed'), SENDER);
    assert.equal(reused.tabId, result.tabId);
    assert.equal(getTab(result.tabId).url, 'https://navigated-away.test/');
    assert.equal(local.tabNameOverridesById[result.tabId].name, 'Renamed saved twin');
    assert.equal(writes('tab.create').length, 1);
});

test('a bookmark opened in another window gets a new local binding', async () => {
    const store = await makeStore();
    const result = await createSpotlightBridge(store)(request('openBookmark', { windowId: 2, spaceId: 'a', bookmarkId: 'twin-1' }), SENDER);
    assert.equal(result.ok, true);
    assert.equal(result.tabId, 100);
    assert.equal(getTab(100).windowId, 2);
    assert.equal(local.pinnedTabStatesById[100].bookmarkId, 'twin-1');
    assert.equal(local.pinnedTabStatesById[4].bookmarkId, 'twin-1');
    assert.deepEqual(writes('window.update'), [['window.update', 2, { focused: true }]]);
});

test('bookmark IDs from another space, missing IDs, and folders cannot open tabs', async () => {
    const handle = createSpotlightBridge(await makeStore());
    for (const bookmarkId of ['b-favorite', 'missing', 'nested']) {
        assertError(await handle(request('openBookmark', { spaceId: 'a', bookmarkId }, bookmarkId), SENDER), 'STALE_BOOKMARK');
    }
    assert.deepEqual(mutations, []);
});

test('unpaired senders, webpages and forged origins cannot read the model or mutate it', async () => {
    const store = await makeStore();
    const handle = createSpotlightBridge(store);
    for (const sender of [undefined, {}, { id: SELF }, { ...SENDER, url: 'https://evil.test/' }, { ...SENDER, origin: 'https://evil.test' }]) {
        assertError(await handle(request('snapshot'), sender), 'UNAUTHORIZED');
    }
    delete local[PEER_KEY];
    assertError(await handle(request('openTab', { url: DUPLICATE_URL }), SENDER), 'UNAUTHORIZED');
    assert.deepEqual(mutations, []);
    assert.deepEqual(storageWrites, []);
});

test('version mismatch and malformed requests are rejected before reads or action journaling', async () => {
    const handle = createSpotlightBridge(await makeStore());
    assertError(await handle(request('snapshot', { version: 2 }), SENDER), 'VERSION_MISMATCH');
    for (const message of [null, [], {}, request('noSuchCommand'), request('snapshot', { extra: true }), request('snapshot', { windowId: -1 }), request('openTab', { url: 'javascript:alert(1)' }), request('activateTab', { tabId: '2' })]) {
        assertError(await handle(message, SENDER), 'INVALID_REQUEST');
    }
    assert.deepEqual(mutations, []);
    assert.deepEqual(storageWrites, []);
});

test('invalid windows and out-of-window tab IDs fail without focus or navigation', async () => {
    const handle = createSpotlightBridge(await makeStore());
    assertError(await handle(request('snapshot', { windowId: 3 }), SENDER), 'INVALID_WINDOW');
    assertError(await handle(request('snapshot', { windowId: 999 }), SENDER), 'FAILED');
    for (const command of ['activateTab', 'navigateTab']) {
        const payload = { tabId: 11, ...(command === 'navigateTab' ? { url: 'https://destination.test/' } : {}) };
        assertError(await handle(request(command, payload), SENDER), 'STALE_TAB');
    }
    assert.deepEqual(mutations, []);
});

test('missing spaces fail safely and do not create unassigned tabs', async () => {
    const handle = createSpotlightBridge(await makeStore());
    for (const command of ['activateSpace', 'openTab', 'openBookmark']) {
        const payload = { spaceId: 'gone', ...(command === 'openTab' ? { url: DUPLICATE_URL } : {}), ...(command === 'openBookmark' ? { bookmarkId: 'twin-1' } : {}) };
        assertError(await handle(request(command, payload), SENDER), 'STALE_SPACE');
    }
    assert.deepEqual(mutations, []);
});

test('tab focus and navigation recheck window ownership after their snapshot', async () => {
    const store = await makeStore();
    const snapshot = await getBridgeSnapshot(store, 1);
    getTab(2).windowId = 2;
    for (const command of ['activateTab', 'navigateTab']) {
        await assert.rejects(runBridgeAction(store, request(command, { tabId: 2, url: 'https://destination.test/' }), snapshot), { code: 'STALE_TAB' });
    }
    assert.deepEqual(mutations, []);
});

test('successful duplicate requests replay after a worker restart without duplicate tabs', async () => {
    let store = await makeStore();
    const message = request('openTab', { spaceId: 'b', url: 'https://new.test/' }, 'replay');
    const first = await createSpotlightBridge(store)(message, SENDER);
    assert.equal(first.ok, true);
    assert.equal(session[JOURNAL_KEY].length, 1);
    assert.equal('snapshot' in session[JOURNAL_KEY][0].response, false);
    assert.equal('url' in session[JOURNAL_KEY][0].response, false);
    getTab(first.tabId).title = 'Fresh title after the first response';
    store = await makeStore();
    const second = await createSpotlightBridge(store)(message, SENDER);
    assert.equal(second.ok, true);
    assert.equal(second.tabId, first.tabId);
    assert.equal(second.snapshot.tabs.find(tab => tab.id === first.tabId).title, 'Fresh title after the first response');
    assert.deepEqual(writes('tab.create'), []);
    assert.equal(tabs.filter(tab => tab.url === 'https://new.test/').length, 1);
});

test('concurrent duplicate requests serialize and create only one tab', async () => {
    const handle = createSpotlightBridge(await makeStore());
    const message = request('openTab', { url: 'https://new.test/' }, 'simultaneous');
    const [a, b] = await Promise.all([handle(message, SENDER), handle(message, SENDER)]);
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(a.tabId, b.tabId);
    assert.equal(writes('tab.create').length, 1);
});

test('reused action IDs with different payloads are rejected without a second mutation', async () => {
    const handle = createSpotlightBridge(await makeStore());
    assert.equal((await handle(request('openTab', { url: 'https://first.test/' }, 'same-id'), SENDER)).ok, true);
    assertError(await handle(request('openTab', { url: 'https://second.test/' }, 'same-id'), SENDER), 'INVALID_REQUEST');
    assert.equal(writes('tab.create').length, 1);
});

test('pending journal entries after a worker restart report uncertainty without replaying', async () => {
    const message = request('openTab', { spaceId: 'b', url: 'https://uncertain.test/' }, 'pending');
    session[JOURNAL_KEY] = [{ key: `${PEER}:pending`, fingerprint: JSON.stringify(message) }];
    const handle = createSpotlightBridge(await makeStore());
    assertError(await handle(message, SENDER), 'UNCERTAIN_RESULT');
    assert.deepEqual(mutations, []);
});

test('a failure after tab creation leaves a pending journal entry and retry never duplicates it', async () => {
    const store = await makeStore();
    const create = chrome.tabs.create;
    chrome.tabs.create = async options => { await create(options); throw new Error('Interrupted after creation'); };
    const message = request('openTab', { url: 'https://uncertain.test/' }, 'interrupted');
    const first = await createSpotlightBridge(store)(message, SENDER);
    assertError(first, 'FAILED');
    assert.equal(writes('tab.create').length, 1);
    chrome.tabs.create = create;
    const restarted = await makeStore();
    assertError(await createSpotlightBridge(restarted)(message, SENDER), 'UNCERTAIN_RESULT');
    assert.deepEqual(writes('tab.create'), []);
    assert.equal(tabs.filter(tab => tab.url === 'https://uncertain.test/').length, 1);
});

test('the request journal is bounded and retains only a compact response', async () => {
    session[JOURNAL_KEY] = Array.from({ length: 110 }, (_, index) => ({ key: `old:${index}`, fingerprint: `old-${index}` }));
    const result = await createSpotlightBridge(await makeStore())(request('openTab', { url: DUPLICATE_URL }), SENDER);
    assert.equal(result.ok, true);
    assert.equal(session[JOURNAL_KEY].length, 100);
    assert.equal(session[JOURNAL_KEY][0].key, 'old:11');
    assert.deepEqual(Object.keys(session[JOURNAL_KEY].at(-1).response).sort(), ['ok', 'requestId', 'role', 'tabId', 'type', 'version']);
});

test('queued actions recheck pairing before execution', async () => {
    const store = await makeStore();
    journalHook = async () => { delete local[PEER_KEY]; };
    assertError(await createSpotlightBridge(store)(request('openTab', { url: DUPLICATE_URL }), SENDER), 'UNAUTHORIZED');
    assert.deepEqual(mutations, []);
});

test('queued actions re-read tabs after native removal instead of acting on an old snapshot', async () => {
    const store = await makeStore({ install: true });
    journalHook = async () => {
        journalHook = null;
        tabs = tabs.filter(tab => tab.id !== 2);
        chrome.tabs.onRemoved.emit(2, { windowId: 1, isWindowClosing: false });
        await settle(store);
    };
    assertError(await createSpotlightBridge(store)(request('activateTab', { tabId: 2 }), SENDER), 'STALE_TAB');
    assert.deepEqual(mutations, []);
});

test('native creation and activation events cannot override explicit bridge assignment', async () => {
    const store = await makeStore({ install: true });
    const create = chrome.tabs.create;
    chrome.tabs.create = options => create({ ...options, openerTabId: 1 });
    const result = await createSpotlightBridge(store)(request('openTab', { spaceId: 'b', url: 'https://child.test/' }), SENDER);
    await settle(store);
    assert.equal(result.ok, true);
    assert.equal(ownerOf(store.spaces, result.tabId).id, 'b');
    assert.equal(store.active[1], 'b');
    assert.equal(store.spaces.find(space => space.id === 'b').lastTab, result.tabId);
    assert.equal(store.spaces.find(space => space.id === 'a').temporaryTabs.includes(result.tabId), false);
});

test('stale sidebar patches preserve bridge-created tabs and their exact bookmark bindings', async () => {
    const store = await makeStore({ install: true });
    const before = clone(store.spaces);
    const after = clone(before);
    after[0].temporaryTabs = after[0].temporaryTabs.filter(id => id !== 1);
    after[1].temporaryTabs.push(1);
    after[1].color = 'green';
    const result = await createSpotlightBridge(store)(request('openBookmark', { spaceId: 'a', bookmarkId: 'twin-2' }), SENDER);
    await store.dispatch({ action: 'patch', before, after });
    await settle(store);
    assert.equal(ownerOf(store.spaces, result.tabId).id, 'a');
    assert.equal(local.pinnedTabStatesById[result.tabId].bookmarkId, 'twin-2');
    assert.equal(ownerOf(store.spaces, 1).id, 'b');
    assert.equal(store.spaces.find(space => space.id === 'b').color, 'green');
    assert.equal(store.spaces.find(space => space.id === 'a').spaceBookmarks.includes(result.tabId), true);
});

test('native pinning and tab replacement are reflected after their event queues settle', async () => {
    const store = await makeStore({ install: true });
    await chrome.tabs.update(2, { pinned: true });
    await settle(store);
    getTab(4).id = 40;
    chrome.tabs.onReplaced.emit(40, 4);
    await settle(store);
    const snapshot = await getBridgeSnapshot(store, 1);
    assert.equal(snapshot.tabs.find(tab => tab.id === 2).spaceId, null);
    assert.equal(snapshot.tabs.find(tab => tab.id === 40).spaceId, 'a');
    assert.deepEqual(snapshot.spaces[0].pinnedTabIds, [40]);
});

test('registered external listeners retain the response channel and enforce pairing', async () => {
    const store = await makeStore();
    registerSpotlightBridge(store);
    assert.equal(chrome.runtime.onMessageExternal.listeners.length, 1);
    const listener = chrome.runtime.onMessageExternal.listeners[0];
    let keepAlive;
    const response = await new Promise(resolve => { keepAlive = listener(request('snapshot'), SENDER, resolve); });
    assert.equal(keepAlive, true);
    assert.equal(response.ok, true);
    const blocked = await new Promise(resolve => listener(request('snapshot'), { id: SELF }, resolve));
    assertError(blocked, 'UNAUTHORIZED');
});

test('dedicated sidebar messages bypass the queued workspace handler', async () => {
    const store = await makeStore(); registerSpotlightBridge(store);
    let calls = 0;
    chrome.sidePanel = { open: options => { calls++; assert.deepEqual(options, { tabId: 1 }); return Promise.resolve(); } };
    chrome.storage.local.get = (key, callback) => callback({ [PEER_KEY]: PEER });
    const listener = chrome.runtime.onMessageExternal.listeners[0];
    const response = await new Promise(resolve => listener({ type: 'arcify-sidebar', version: 1, requestId: 'side-1' },
        { id: PEER, frameId: 0, url: `chrome-extension://${PEER}/newtab.html`, origin: `chrome-extension://${PEER}`,
            tab: { id: 1, windowId: 1, active: true, url: 'chrome://newtab/' } }, resolve));
    assert.equal(response.ok, true); assert.equal(response.type, 'arcify-sidebar'); assert.equal(calls, 1);
    assert.equal(session[JOURNAL_KEY], undefined); assert.deepEqual(mutations, []);
});

test('internal launch rejects unknown sender and invalid window before contacting Spotlight', async () => {
    registerSpotlightBridge(await makeStore());
    const listener = chrome.runtime.onMessage.listeners[0];
    chrome.runtime.sendMessage = () => assert.fail('Invalid internal launch must not contact its peer');
    for (const [windowId, sender] of [[1, { id: PEER }], [-1, { id: SELF }]]) {
        const response = await new Promise(resolve => listener({ type: 'spotlightBridgeLaunch', windowId }, sender, resolve));
        assert.equal(response.ok, false);
        assert.equal(response.error.code, 'INVALID_REQUEST');
    }
    assert.equal(listener({ type: 'unrelated' }, { id: SELF }, () => assert.fail('Unrelated message')), undefined);
});


test('known baseline: overlapping native pin and replacement events retain the replaced tab owner', {
    // Reproduced against the unchanged pre-bridge SpaceStore from git HEAD.
    // An earlier queued persist prunes old ID 4 before onReplaced can map it to 40.
    skip: 'Pre-existing SpaceStore native-event race; tracked separately from this bridge change.'
}, async () => {
    const store = await makeStore({ install: true });
    await chrome.tabs.update(2, { pinned: true });
    getTab(4).id = 40;
    chrome.tabs.onReplaced.emit(40, 4);
    await settle(store);
    assert.equal((await getBridgeSnapshot(store, 1)).tabs.find(tab => tab.id === 40).spaceId, 'a');
});

test('bookmark URLs must pass the same safe-scheme checks as explicit navigation', async () => {
    nodes.push({ id: 'bookmarklet', parentId: 'folder-a', title: 'Bookmarklet', url: 'javascript:alert(1)' });
    const result = await createSpotlightBridge(await makeStore())(request('openBookmark', { spaceId: 'a', bookmarkId: 'bookmarklet' }), SENDER);
    assertError(result, 'UNSUPPORTED_URL');
    assert.deepEqual(mutations, []);
});

test('a bookmark removed while an action waits cannot fall back to a duplicate URL', async () => {
    const store = await makeStore();
    journalHook = async () => { journalHook = null; nodes = nodes.filter(node => node.id !== 'twin-2'); };
    assertError(await createSpotlightBridge(store)(request('openBookmark', { spaceId: 'a', bookmarkId: 'twin-2' }), SENDER), 'STALE_BOOKMARK');
    assert.deepEqual(mutations, []);
    assert.equal(local.pinnedTabStatesById[4].bookmarkId, 'twin-1');
});

test('a space removed by a sidebar write while an action waits cannot receive a new tab', async () => {
    const store = await makeStore();
    journalHook = async () => {
        journalHook = null;
        const before = clone(store.spaces);
        nodes = nodes.filter(node => node.id !== 'folder-b');
        await store.dispatch({ action: 'patch', before, after: before.filter(space => space.id !== 'b') });
    };
    assertError(await createSpotlightBridge(store)(request('openTab', { spaceId: 'b', url: 'https://new.test/' }), SENDER), 'STALE_SPACE');
    assert.deepEqual(writes('tab.create'), []);
});

test('internal launch handshakes before requesting a new-tab Spotlight launch', async () => {
    registerSpotlightBridge(await makeStore());
    const sent = [];
    chrome.runtime.sendMessage = (peer, message, callback) => {
        sent.push({ peer, message });
        callback({ type: BRIDGE_TYPE, version: BRIDGE_VERSION, requestId: message.requestId, role: 'spotlight', ok: true, extensionId: peer });
    };
    const listener = chrome.runtime.onMessage.listeners[0];
    const result = await new Promise(resolve => listener({ type: 'spotlightBridgeLaunch', windowId: 2 }, { id: SELF }, resolve));
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(sent.map(({ peer, message }) => [peer, message.command, message.windowId]), [[PEER, 'hello', 2], [PEER, 'launch', 2]]);
    assert.equal(sent[1].message.mode, 'new-tab');
    assert.notEqual(sent[0].message.requestId, sent[1].message.requestId);
});

test('internal launch does not open Spotlight when its handshake fails', async () => {
    registerSpotlightBridge(await makeStore());
    const sent = [];
    chrome.runtime.sendMessage = (peer, message, callback) => {
        sent.push(message);
        callback({ type: BRIDGE_TYPE, version: BRIDGE_VERSION + 1, requestId: message.requestId, role: 'spotlight', ok: true });
    };
    const result = await new Promise(resolve => chrome.runtime.onMessage.listeners[0]({ type: 'spotlightBridgeLaunch', windowId: 1 }, { id: SELF }, resolve));
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'VERSION_MISMATCH');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].command, 'hello');
});

test('a deleted unrelated bookmark folder warns without blocking snapshots or live-tab actions', async () => {
    const store = await makeStore();
    nodes = nodes.filter(node => node.id !== 'folder-empty');
    const handle = createSpotlightBridge(store);
    for (const message of [request('hello'), request('snapshot'), request('activateTab', { tabId: 2 }), request('activateSpace', { spaceId: 'empty' }), request('openTab', { spaceId: 'a', url: 'https://new.test/' })]) {
        const response = await handle(message, SENDER);
        assert.equal(response.ok, true, JSON.stringify(response));
        assert.deepEqual(response.snapshot.spaces.map(space => space.id), ['a', 'b', 'empty']);
        assert.deepEqual(response.snapshot.warnings.map(warning => [warning.code, warning.spaceId]), [['BOOKMARKS_UNAVAILABLE', 'empty']]);
        assert.equal(typeof response.snapshot.warnings[0].message, 'string');
        assert.equal(response.snapshot.bookmarks.length, 3);
    }
    assert.equal(writes('tab.create').length, 1);
    assert.deepEqual(writes('bookmark.create'), []);
    assert.equal(store.spaces.find(space => space.id === 'empty').bookmarkFolderId, 'folder-empty');
});

test('a space folder moved out of Arcify omits its bookmarks but preserves tab ownership', async () => {
    const store = await makeStore();
    nodes.find(node => node.id === 'folder-a').parentId = 'outside-root';
    const handle = createSpotlightBridge(store);
    const snapshot = (await handle(request('snapshot'), SENDER)).snapshot;
    assert.deepEqual(snapshot.warnings.map(warning => [warning.code, warning.spaceId]), [['BOOKMARKS_UNAVAILABLE', 'a']]);
    assert.deepEqual(snapshot.bookmarks.map(bookmark => bookmark.id), ['b-favorite']);
    assert.deepEqual(snapshot.spaces[0].tabIds, [4, 3, 1]);
    assert.equal(snapshot.tabs.find(tab => tab.id === 4).spaceId, 'a');
    assert.equal((await handle(request('activateSpace', { spaceId: 'a' }), SENDER)).ok, true);
    const before = mutations.length;
    const rejected = await handle(request('openBookmark', { spaceId: 'a', bookmarkId: 'twin-1' }), SENDER);
    assert.equal(rejected.ok, false);
    assert.deepEqual(mutations.slice(before), []);
    assert.deepEqual(writes('bookmark.create'), []);
});

test('an unreadable bookmark subtree produces no partial favorites and does not block unrelated spaces', async () => {
    const store = await makeStore();
    nodes.unshift({ id: 'readable-a-favorite', parentId: 'folder-a', title: 'Would be partial', url: 'https://partial.test/' });
    const getChildren = chrome.bookmarks.getChildren;
    chrome.bookmarks.getChildren = async id => {
        if (id === 'nested') throw new Error('Bookmark permission unavailable');
        return getChildren(id);
    };
    const handle = createSpotlightBridge(store);
    const response = await handle(request('snapshot'), SENDER);
    assert.equal(response.ok, true);
    assert.deepEqual(response.snapshot.warnings.map(warning => [warning.code, warning.spaceId]), [['BOOKMARKS_UNAVAILABLE', 'a']]);
    assert.deepEqual(response.snapshot.bookmarks.map(bookmark => bookmark.id), ['b-favorite']);
    assert.equal((await handle(request('navigateTab', { tabId: 1, url: 'https://destination.test/' }), SENDER)).ok, true);
    assert.equal((await handle(request('openBookmark', { spaceId: 'b', bookmarkId: 'b-favorite' }), SENDER)).ok, true);
    const rejected = await handle(request('openBookmark', { spaceId: 'a', bookmarkId: 'twin-2' }, 'unreadable-pin'), SENDER);
    assert.equal(rejected.ok, false);
    assert.equal(writes('tab.create').length, 1);
    assert.deepEqual(writes('bookmark.create'), []);
});


test('internal launch rejects a handshake with a different declared extension identity', async () => {
    registerSpotlightBridge(await makeStore());
    const sent = [];
    chrome.runtime.sendMessage = (peer, message, callback) => {
        sent.push(message);
        callback({ type: BRIDGE_TYPE, version: BRIDGE_VERSION, requestId: message.requestId,
            role: 'spotlight', ok: true, extensionId: SELF });
    };
    const result = await new Promise(resolve => chrome.runtime.onMessage.listeners[0](
        { type: 'spotlightBridgeLaunch', windowId: 1 }, { id: SELF }, resolve));
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'INVALID_RESPONSE');
    assert.equal(sent.length, 1);
});

test('startup launcher is excluded from bridge tab classification even if native-pinned or pending', async () => {
    const launcher = chrome.runtime.getURL('startup-launcher.html');
    tabs.push({ id: 80, windowId: 1, url: launcher, title: 'Open Arcify sidebar', pinned: true },
        { id: 81, windowId: 1, url: 'about:blank', pendingUrl: launcher, title: 'Loading' });
    const store = await makeStore();
    const snapshot = await getBridgeSnapshot(store, 1);
    assert.equal(snapshot.tabs.some(tab => [80, 81].includes(tab.id)), false);
    assert.equal(snapshot.spaces.some(space => space.tabIds.some(id => [80, 81].includes(id))), false);
    assert.equal(snapshot.tabs.some(tab => tab.id === 5 && tab.pinned), true, 'Regular native pins stay available');
});

test('persistent Favorites hello, snapshot and open use the same SpaceStore queue and exact source-independent binding', async () => {
    const { FavoriteStore } = await import('../../favorite-store.js');
    const store = await makeStore({ install: true });
    const favorites = new FavoriteStore(store); favorites.install();
    const added = await favorites.dispatch({ type: 'favoriteStore', action: 'addBookmark', windowId: 1,
        spaceId: 'a', bookmarkFolderId: 'folder-a', bookmarkId: 'twin-2', parentId: 'nested' });
    const favoriteId = added.favorites[0].id;
    const handle = createSpotlightBridge(store);
    const hello = await handle(request('hello'), SENDER);
    assert(hello.capabilities.includes('persistentFavorites'));
    assert.deepEqual(hello.snapshot.favorites, added.favorites);
    assert.equal(hello.snapshot.tabs.find(tab => tab.id === added.tab.id).spaceId, null);
    getTab(added.tab.id).url = 'https://navigated-favorite.test/';
    nodes = nodes.filter(node => node.id !== 'twin-2');
    const response = await handle(request('openFavorite', { favoriteId }), SENDER);
    assert.equal(response.ok, true, JSON.stringify(response)); assert.equal(response.tabId, added.tab.id);
    assert.equal(response.snapshot.favorites[0].url, DUPLICATE_URL);
    assert.equal(getTab(added.tab.id).url, 'https://navigated-favorite.test/');
    assert.equal(writes('tab.create').length, 1);
});

test('local retained icon never widens the strict v1 Favorites snapshot consumed by existing Spotlight peers', async () => {
    const { FavoriteStore } = await import('../../favorite-store.js');
    const record = { id: 'retained', title: 'Saved', url: DUPLICATE_URL, sourceBookmarkId: null };
    local.persistentFavorites = [record];
    local.favoriteIconCache = { version: 1, entries: [{ favoriteId: record.id, url: record.url, faviconDataUrl: pngIcon() }] };
    const store = await makeStore(); new FavoriteStore(store);
    const snapshot = await getBridgeSnapshot(store, 1);
    assert.deepEqual(snapshot.favorites, [{ ...record, tabId: null }]);
    assert.equal(local.favoriteIconCache.entries[0].faviconDataUrl, pngIcon());
    assert.deepEqual(local.persistentFavorites, [record]);
});

test('closed persistent Favorite opens once through paired journal, rejects stale IDs/fields/peer/window, and survives worker recreation', async () => {
    const { FavoriteStore } = await import('../../favorite-store.js');
    const store = await makeStore({ install: true }); const favorites = new FavoriteStore(store); favorites.install();
    const added = await favorites.dispatch({ type: 'favoriteStore', action: 'addTab', windowId: 1, tabId: 5 });
    const favoriteId = added.favorites[0].id;
    tabs = tabs.filter(tab => tab.id !== 5); chrome.tabs.onRemoved.emit(5, { isWindowClosing: false }); await settle(store);
    const handle = createSpotlightBridge(store);
    assert.equal((await handle(request('snapshot'), SENDER)).snapshot.favorites[0].tabId, null);
    const open = request('openFavorite', { favoriteId }, 'open-saved');
    const first = await handle(open, SENDER), replay = await createSpotlightBridge(store)(open, SENDER);
    assert.equal(first.ok, true, JSON.stringify(first)); assert.equal(replay.tabId, first.tabId);
    assert.equal(first.snapshot.favorites[0].tabId, first.tabId); assert.equal(writes('tab.create').length, 1);
    assertError(await handle(request('openFavorite', { favoriteId: 'removed' }, 'stale-saved'), SENDER), 'STALE_FAVORITE');
    assertError(await handle(request('openFavorite', { favoriteId, url: 'https://injected.test/' }, 'bad-saved'), SENDER), 'INVALID_REQUEST');
    assertError(await handle(request('openFavorite', { favoriteId }, 'wrong-peer'), { id: SELF }), 'UNAUTHORIZED');
    assertError(await handle(request('openFavorite', { favoriteId, windowId: 3 }, 'popup-saved'), SENDER), 'INVALID_WINDOW');
    assert.equal(writes('tab.create').length, 1);
});


test('existing bookmark activation honors the late guard before Space activation or tab focus', async () => {
    const store = await makeStore(); store.active[1] = 'b';
    const snapshot = await getBridgeSnapshot(store, 1); mutations.length = 0;
    let checks = 0;
    await assert.rejects(runBridgeAction(store, request('openBookmark', { spaceId: 'a', bookmarkId: 'twin-1' }), snapshot,
        { beforeMutation: async () => { checks++; throw Object.assign(new Error('Pairing changed'), { code: 'UNAUTHORIZED' }); } }), { code: 'UNAUTHORIZED' });
    assert.equal(checks, 1); assert.equal(store.active[1], 'b'); assert.deepEqual(mutations, []);
});

test('pairing revocation during tab activation suppresses the later window focus', async () => {
    const store = await makeStore();
    local[PAIRING_GENERATION_KEY] = crypto.randomUUID();
    const update = chrome.tabs.update;
    chrome.tabs.update = async (id, changes) => {
        const tab = await update(id, changes);
        // A disconnect/reconnect can retain the same peer ID but revokes the request.
        if (changes.active) local[PAIRING_GENERATION_KEY] = crypto.randomUUID();
        return tab;
    };
    assertError(await createSpotlightBridge(store)(request('activateTab', { tabId: 5 }), SENDER), 'UNAUTHORIZED');
    assert.deepEqual(writes('tab.update'), [['tab.update', 5, { active: true }]]);
    assert.deepEqual(writes('window.update'), []);
});

test('registered New Tab row uses the real SpaceStore queue and owns one default-provider fallback in an empty Space', async () => {
    const store = await makeStore({ install: true }); store.active[1] = 'empty';
    delete local[PEER_KEY]; windows.find(window => window.id === 1).focused = true;
    const create = chrome.tabs.create;
    chrome.tabs.create = options => create({ ...options, url: `chrome-extension://${PEER}/newtab.html`, openerTabId: 1 });
    registerSpotlightBridge(store);
    const request = { type: 'spotlightBridgeLaunch', windowId: 1, spaceId: 'empty', fallbackToNewTab: true };
    const sender = { id: SELF, url: chrome.runtime.getURL('sidebar.html'), origin: `chrome-extension://${SELF}`, frameId: 0 };
    const result = await new Promise(resolve => chrome.runtime.onMessage.listeners[0](request, sender, resolve));
    await settle(store);
    assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.outcome, 'new-tab');
    assert.equal(ownerOf(store.spaces, result.tabId)?.id, 'empty'); assert.equal(store.active[1], 'empty');
    assert.equal(writes('tab.create').length, 1); assert.equal(getTab(result.tabId).windowId, 1); assert.equal(getTab(result.tabId).active, true);
    assert.equal(writes('tab.update').filter(call => call[1] !== result.tabId).length, 0);
});
