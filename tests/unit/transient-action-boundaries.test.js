import test from 'node:test';
import assert from 'node:assert/strict';
import { FavoriteStore, FAVORITES_KEY, FAVORITE_SESSION_KEY } from '../../favorite-store.js';
import { createFavoriteContinuity } from '../../favorite-continuity.js';
import { ArchiveStore, ARCHIVE_KEY, ARCHIVE_SESSION_KEY } from '../../archive-store.js';
import { moveTabToNewWindow } from '../../move-tab-new-window.js';
import { saveTodayTabsInNewFolder } from '../../today-folder-store.js';
import { moveTodayTabsToSpaceCore } from '../../today-move-store.js';
import { moveSavedItemsToSpace } from '../../saved-move-store.js';
import { runTabMenuActionCore } from '../../tab-menu-actions.js';
import { runTodaySplitActionCore } from '../../today-split-action.js';
import { removeSavedSpacePin } from '../../space-pin-actions.js';
import { Utils } from '../../utils.js';

const clone = value => structuredClone(value);
const url = 'https://page.test/';
const transient = error => error.code === 'TRANSIENT_CONTEXT';
function fixture() {
    const effects = [], hooks = {}, excludedTabs = new Set(), excludedWindows = new Set();
    const items = [{ id: 'favorite', title: 'Saved', url, sourceBookmarkId: null }];
    const entry = { entryId: 'archived', url, name: 'Saved page', spaceId: 's', archivedAt: 1 };
    const local = { [FAVORITES_KEY]: items, [ARCHIVE_KEY]: [entry], pinnedTabStatesById: {},
        todayOrderRepresentation: { version: 1, inverted: false }, tabNameOverridesById: {} };
    const session = { [ARCHIVE_SESSION_KEY]: 'browser-session' }, sync = { invertTabOrder: false };
    const tabs = [1, 2].map((id, index) => ({ id, windowId: 10, index, url, title: 'Page', pinned: false,
        active: id === 1, incognito: false, groupId: -1, splitViewId: -1, status: 'complete' }));
    const nodes = [{ id: 'arcify', title: 'Arcify', parentId: 'bar' }, { id: 'folder', title: 'Space', parentId: 'arcify' },
        { id: 'dest-folder', title: 'Destination', parentId: 'arcify' }, { id: 'pin', title: 'Saved', url, parentId: 'folder' }];
    const storage = (data, name) => ({ async get(keys) {
        await hooks.storage?.(keys, name);
        const names = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys || data);
        return Object.fromEntries(names.map(key => [key, clone(data[key] ?? keys?.[key])]));
    }, async set(values) { effects.push(['storage', name, clone(values)]); Object.assign(data, clone(values)); } });
    const event = () => ({ addListener() {}, removeListener() {} });
    globalThis.chrome = {
        runtime: { getURL: path => `chrome-extension://test/${path}` },
        storage: { local: storage(local, 'local'), session: storage(session, 'session'), sync: storage(sync, 'sync'), onChanged: event() },
        windows: { onRemoved: event(), async get(id) { await hooks.window?.(id); return { id, type: 'normal', incognito: false }; },
            async create(options) { effects.push(['window-create', options]); return { id: 30, type: 'normal' }; }, async update(...args) { effects.push(['window-update', ...args]); } },
        tabs: { ...Object.fromEntries(['onUpdated', 'onRemoved', 'onAttached', 'onDetached', 'onReplaced', 'onActivated'].map(name => [name, event()])),
            async get(id) { await hooks.tab?.(id); const tab = tabs.find(tab => tab.id === id); if (!tab) throw new Error('Missing'); return clone(tab); },
            async query(query = {}) { await hooks.query?.(query); return clone(tabs.filter(tab => Object.entries(query).every(([key, value]) => tab[key] === value))); },
            async create(options) { effects.push(['tab-create', options]); const tab = { ...tabs[0], ...options, id: 100 }; tabs.push(tab); return clone(tab); },
            async update(id, update) { effects.push(['tab-update', id, update]); Object.assign(tabs.find(tab => tab.id === id), update); return clone(tabs.find(tab => tab.id === id)); },
            async duplicate(id) { effects.push(['duplicate', id]); }, async remove(id) { effects.push(['remove', id]); },
            async move(...args) { effects.push(['move', ...args]); }, async createSplit(...args) { effects.push(['split', ...args]); return 5; }, async unsplit(...args) { effects.push(['unsplit', ...args]); } },
        bookmarks: { ...Object.fromEntries(['onChanged', 'onMoved', 'onRemoved', 'onCreated'].map(name => [name, event()])),
            async get(id) { await hooks.bookmark?.(id); return clone(nodes.filter(node => node.id === id)); },
            async search({ title }) { return clone(nodes.filter(node => node.title === title)); },
            async getChildren(parentId) { return clone(nodes.filter(node => node.parentId === parentId)); },
            async getSubTree(id) { const subtree = id => { const node = nodes.find(node => node.id === id); return { ...node, ...(node.url ? {} : { children: nodes.filter(child => child.parentId === id).map(child => subtree(child.id)) }) }; }; return [subtree(id)]; },
            async create(value) { effects.push(['bookmark-create', value]); return { ...value, id: 'new' }; }, async update(...args) { effects.push(['bookmark-update', ...args]); },
            async move(...args) { effects.push(['bookmark-move', ...args]); }, async remove(...args) { effects.push(['bookmark-remove', ...args]); } }
    };
    const store = { initialized: true, spaces: [{ id: 's', bookmarkFolderId: 'folder', temporaryTabs: [1, 2], spaceBookmarks: [] },
        { id: 'dest', bookmarkFolderId: 'dest-folder', temporaryTabs: [], spaceBookmarks: [] }], active: { 10: 's' },
        restoredRanks: new Map(), restoreQueue: [], provisional: new Set(), recoveryCandidates: new Set(),
        run: operation => Promise.resolve().then(operation), isGlobalTab: () => false,
        isTransientWindow: id => excludedWindows.has(id), isTransientTab: value => excludedTabs.has(typeof value === 'object' ? value?.id : value),
        track(tab) { effects.push(['track', tab.id]); }, rebaseSectionRanks() {},
        async persist(options = {}) { await options.beforeWrite?.(); effects.push(['persist']); } };
    Utils._pinnedStateChain = Promise.resolve(); Utils._tabNameChain = Promise.resolve();
    const favorites = new FavoriteStore(store, { captureIcon: async () => null });
    const archive = new ArchiveStore(store);
    const common = { windowId: 10, spaceId: 's', bookmarkFolderId: 'folder' };
    const entries = tabs.map(tab => ({ tabId: tab.id, url: tab.url }));
    const splitEntries = tabs.map(tab => ({ tabId: tab.id, url: tab.url, index: tab.index, pinned: tab.pinned, groupId: tab.groupId, splitViewId: tab.splitViewId }));
    const reopen = { windowId: 10, requestId: 'request', expected: clone(entry), bookmarkFolderId: 'folder',
        context: { ...common, sourceTabId: 1, sourceUrl: url } };
    return { store, favorites, archive, tabs, local, session, effects, hooks, excludedTabs, excludedWindows, common, entries, splitEntries, reopen, items };
}

for (const mode of ['window', 'dragged-out-tab']) {
    test(`Favorite add and exact adoption reject ${mode} before any writes`, async () => {
        const f = fixture();
        if (mode === 'window') f.excludedWindows.add(10); else f.excludedTabs.add(1);
        await assert.rejects(f.favorites.dispatch({ type: 'favoriteStore', action: 'addTab', windowId: 10, tabId: 1 }), transient);
        await assert.rejects(f.favorites.open('favorite', 10, { tabId: 1 }), transient);
        assert.deepEqual(f.effects, []);
        assert.equal(f.local[FAVORITES_KEY].length, 1);
    });
}
test('Favorite opening into a transient normal window never creates or focuses a page', async () => {
    const f = fixture(); f.excludedWindows.add(10);
    await assert.rejects(f.favorites.open('favorite', 10), transient);
    assert.deepEqual(f.effects, []);
});
test('Favorite reconciliation and native pin projection omit quarantined IDs even after drag-out', async () => {
    const f = fixture(); f.tabs.forEach(tab => { tab.pinned = true; }); f.excludedTabs.add(1);
    f.session[FAVORITE_SESSION_KEY] = { version: 1, bindings: [{ favoriteId: 'favorite', windowId: 10, tabId: 1 }], attempts: [] };
    const result = await f.favorites.read(10);
    assert.equal(result.favorites[0].tabId, null); assert.deepEqual(result.nativeTabs.map(tab => tab.id), [2]);
    assert.equal(f.favorites.ownsTab(1), false); assert.deepEqual(f.favorites.state.bindings, []);
});
test('Favorite late adoption validation rejects transient classification before durable save', async () => {
    const f = fixture(); await f.favorites.initialize();
    f.hooks.tab = () => f.excludedTabs.add(1);
    await assert.rejects(f.favorites.addFavorite({ action: 'addTab', windowId: 10, tabId: 1 }), transient);
    assert.deepEqual(f.effects, []);
});
test('Favorite continuity does not recover ownership or selection from a transient anchor', async () => {
    const f = fixture(); f.excludedTabs.add(1);
    const adapter = createFavoriteContinuity({ api: chrome, isTransientTab: f.store.isTransientTab, isTransientWindow: f.store.isTransientWindow });
    const state = await adapter.load({ session: { version: 1, bindings: [{ favoriteId: 'favorite', windowId: 10, tabId: 1 }], attempts: [] }, items: f.items });
    assert.deepEqual(state.bindings, []);
    f.tabs.splice(1);
    await adapter.checkpointSelection({ state, items: f.items, spaces: f.store.spaces, activeSpaces: f.store.active, spaceSessionUpdate: {} });
    assert.deepEqual(f.session.favoriteContinuityReceipt.selection.windows, []);
});

for (const mode of ['window', 'dragged-out-tab']) for (const automatic of [false, true]) {
    test(`Archive source rejects ${mode}, automatic=${automatic}, before save or close`, async () => {
        const f = fixture(); if (mode === 'window') f.excludedWindows.add(10); else f.excludedTabs.add(2);
        await assert.rejects(f.archive.archiveUnlocked({ ...f.common, tabId: 2, url }, { automatic }), transient);
        assert.deepEqual(f.effects, []);
    });
}
for (const mode of ['window', 'dragged-out-source']) test(`Archive reopen rejects ${mode} before claims or tab creation`, async () => {
    const f = fixture(); if (mode === 'window') f.excludedWindows.add(10); else f.excludedTabs.add(1);
    await assert.rejects(f.archive.reopenUnlocked(f.reopen), transient); assert.deepEqual(f.effects, []);
});
test('Archive rechecks source after storage reads before writing its archived entry', async () => {
    const f = fixture(); f.local[ARCHIVE_KEY] = [];
    f.hooks.storage = key => { if (key === ARCHIVE_KEY) f.excludedTabs.add(2); };
    await assert.rejects(f.archive.archiveUnlocked({ ...f.common, tabId: 2, url }), transient);
    assert.deepEqual(f.effects, []);
});

const operations = {
    'move to new window': f => moveTabToNewWindow(f.store, f.favorites, { type: 'moveTabToNewWindow', ...f.common, tabId: 1 }),
    'Today folder save': f => saveTodayTabsInNewFolder(f.store, { ...f.common, title: 'Saved', inverted: false, entries: f.entries }),
    'Today Space move': f => moveTodayTabsToSpaceCore(f.store, { ...f.common, destinationSpaceId: 'dest', destinationBookmarkFolderId: 'dest-folder', inverted: false, entries: f.entries }),
    'saved Space move': f => moveSavedItemsToSpace(f.store, { ...f.common, destinationSpaceId: 'dest', destinationBookmarkFolderId: 'dest-folder', inverted: false,
        entries: [{ bookmarkId: 'pin', parentId: 'folder', title: 'Saved', url, tabId: 1 }] }),
    'tab menu mute': f => runTabMenuActionCore(f.store, { ...f.common, action: 'mute', tabId: 1, value: true }),
    'native split': f => runTodaySplitActionCore(f.store, { ...f.common, action: 'create', entries: f.splitEntries })
};
for (const [name, operation] of Object.entries(operations)) for (const mode of ['window', 'dragged-out-tab']) test(`${name} rejects stale ${mode} requests with zero writes`, async () => {
    const f = fixture(); if (mode === 'window') f.excludedWindows.add(10); else f.excludedTabs.add(1);
    await assert.rejects(operation(f), transient); assert.deepEqual(f.effects, []);
});
test('Today move rechecks transient identity after a yielded boundary', async () => {
    const f = fixture();
    await assert.rejects(moveTodayTabsToSpaceCore(f.store, { ...f.common, destinationSpaceId: 'dest', destinationBookmarkFolderId: 'dest-folder', inverted: false, entries: f.entries },
        { getOrder: async () => false, beforeMutation: async () => { f.excludedTabs.add(1); } }), transient);
    assert.deepEqual(f.effects, []); assert.deepEqual(f.store.spaces[0].temporaryTabs, [1, 2]);
});
test('tab menu rechecks transient identity after its mutation guard yields', async () => {
    const f = fixture();
    await assert.rejects(runTabMenuActionCore(f.store, { ...f.common, action: 'mute', tabId: 1, value: true },
        { beforeWrite: async () => { f.excludedTabs.add(1); } }), transient);
    assert.deepEqual(f.effects, []);
});
test('native split rechecks exact IDs after a yielded beforeNative boundary', async () => {
    const f = fixture();
    await assert.rejects(runTodaySplitActionCore(f.store, { ...f.common, action: 'create', entries: f.splitEntries },
        { beforeBoundary: async ({ phase }) => { if (phase === 'beforeNative') f.excludedTabs.add(1); } }), transient);
    assert.deepEqual(f.effects, []);
});
test('Remove Pin refuses a transient exact-linked copy before deleting the bookmark', async () => {
    const f = fixture(); f.local.pinnedTabStatesById[1] = { bookmarkId: 'pin', pinnedUrl: url }; f.excludedTabs.add(1);
    await assert.rejects(removeSavedSpacePin(f.store, { getSpace: () => f.store.spaces[0], bookmarkId: 'pin' }), transient);
    assert.deepEqual(f.effects, []);
});

// Native/extension reads may yield while the registry receives a create/attach.
// These checks target the last validation before the first consequential write.
test('Favorite existing-tab focus stops when the final guard classifies its identity transient', async () => {
    const f = fixture(); f.tabs[0].pinned = true;
    f.session[FAVORITE_SESSION_KEY] = { version: 1, bindings: [{ favoriteId: 'favorite', windowId: 10, tabId: 1 }], attempts: [] };
    await assert.rejects(f.favorites.open('favorite', 10, { beforeMutation: async () => { f.excludedTabs.add(1); } }), transient);
    assert.deepEqual(f.effects.filter(([kind]) => kind !== 'track'), []);
});
test('Archive reopen rechecks exact source after native window validation before session write', async () => {
    const f = fixture(); delete f.session[ARCHIVE_SESSION_KEY]; f.hooks.window = () => f.excludedTabs.add(1);
    await assert.rejects(f.archive.reopenUnlocked(f.reopen), transient); assert.deepEqual(f.effects, []);
});
test('Today folder save rejects a tab classified transient during its fresh tab read', async () => {
    const f = fixture(); f.hooks.tab = id => f.excludedTabs.add(id);
    await assert.rejects(operations['Today folder save'](f), transient); assert.deepEqual(f.effects, []);
});
test('new-window move refuses late source classification before windows.create', async () => {
    const f = fixture(); f.hooks.tab = id => f.excludedTabs.add(id);
    await assert.rejects(operations['move to new window'](f), transient); assert.deepEqual(f.effects, []);
});
test('saved move refuses a linked transient copy discovered in the fresh all-window snapshot', async () => {
    const f = fixture(); f.store.spaces[0].temporaryTabs = [2]; f.store.spaces[0].spaceBookmarks = [1];
    f.local.pinnedTabStatesById[1] = { bookmarkId: 'pin', pinnedUrl: url };
    f.hooks.query = () => f.excludedTabs.add(1);
    await assert.rejects(operations['saved Space move'](f), transient); assert.deepEqual(f.effects, []);
});
test('Remove Pin rechecks linked identities after a yielding authorization guard', async () => {
    const f = fixture(); f.local.pinnedTabStatesById[1] = { bookmarkId: 'pin', pinnedUrl: url };
    await assert.rejects(removeSavedSpacePin(f.store, { getSpace: () => f.store.spaces[0], bookmarkId: 'pin' },
        { beforeWrite: async () => { f.excludedTabs.add(1); } }), transient);
    assert.deepEqual(f.effects, []);
});
