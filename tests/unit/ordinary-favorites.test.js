import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { FavoriteStore, FAVORITES_KEY, FAVORITE_SESSION_KEY } from '../../favorite-store.js';
import { SpaceStore, ownerOf } from '../../space-store.js';
import { runTabMenuAction } from '../../tab-menu-actions.js';
import { getBridgeSnapshot } from '../../spotlight-bridge.js';
import { isProtectedFavorite } from '../../favorite-safety.js';

// Real shared worker queue, both stores and group projector. Only browser APIs
// are mocked. These tests do not claim native keyboard or browser acceptance.
const clone = value => structuredClone(value);
const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); }, emit(...args) { for (const fn of this.listeners) fn(...clone(args)); } });
const saved = id => ({ id, title: id, url: 'https://same.test/', sourceBookmarkId: null });
const space = (id, tabs = []) => ({ id, name: id, color: 'blue', bookmarkFolderId: id, spaceBookmarks: [], temporaryTabs: tabs });
let local, session, sync, tabs, effects, hooks, nodes, groups, nextId;
const tab = id => { const result = tabs.find(tab => tab.id === id); if (!result) throw new Error('No tab'); return result; };
function area(data, name) {
    return { async get(keys) { await hooks[`${name}Get`]?.(keys); const names = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys || data); return Object.fromEntries(names.map(key => [key, clone(data[key] ?? (typeof keys === 'object' && !Array.isArray(keys) ? keys[key] : undefined))])); },
        async set(value) { await hooks[`${name}Set`]?.(value); Object.assign(data, clone(value)); } };
}
function stores({ install = false, ownershipPersistence } = {}) {
    const spaces = new SpaceStore(), favorites = new FavoriteStore(spaces, { captureIcon: async () => null, ownershipPersistence });
    if (install) { spaces.install(); favorites.install(); }
    return { spaces, favorites, async idle() { for (let i = 0; i < 8; i++) await spaces.run(() => {}); } };
}
const req = (action, extra = {}) => ({ type: 'favoriteStore', action, windowId: 1, ...extra });
const assertGlobal = (s, id) => {
    assert.equal(s.spaces.isGlobalTab(id), true);
    assert.equal(ownerOf(s.spaces.spaces, id), undefined);
    assert(!local.spaces.some(space => [...space.spaceBookmarks, ...space.temporaryTabs].includes(id)));
    assert(!local.spaceTabSnapshot.some(record => record.tabId === id));
    assert(!s.spaces.snapshotByTab.has(id));
    assert(!s.spaces.restoreQueue.some(record => record.tabId === id));
};
beforeEach(() => {
    local = { spaceModelVersion: 2, spaces: [space('a', [1]), space('b', [2])], [FAVORITES_KEY]: [saved('f')] };
    session = { spaceSession: true, activeSpaces: { 1: 'a', 2: 'b' } }; sync = { ordinaryFavoriteTabs: true }; effects = []; hooks = {}; groups = []; nextId = 100;
    tabs = [{ id: 1, windowId: 1, title: 'One', url: 'https://one.test/', pinned: false, groupId: -1, index: 0 },
        { id: 2, windowId: 1, title: 'Twin', url: 'https://same.test/', pinned: false, groupId: -1, index: 1 }];
    nodes = [{ id: 'root', title: 'Arcify' }, { id: 'a', parentId: 'root', title: 'a' }, { id: 'b', parentId: 'root', title: 'b' },
        { id: 'bookmark', parentId: 'a', title: 'Saved', url: 'https://same.test/' }, { id: 'twin', parentId: 'a', title: 'Twin', url: 'https://same.test/' }];
    globalThis.chrome = {
        runtime: { id: 'a'.repeat(32), getURL: path => `chrome-extension://${'a'.repeat(32)}/${path}` },
        storage: { local: area(local, 'local'), session: area(session, 'session'), sync: area(sync, 'sync'), onChanged: event() },
        windows: { async get(id) { await hooks.window?.(id); return { id, type: id === 3 ? 'popup' : 'normal', incognito: id === 4 }; }, async update(id, update) { effects.push(['focus', id, update]); } },
        tabs: { onCreated: event(), onUpdated: event(), onRemoved: event(), onReplaced: event(), onActivated: event(), onMoved: event(), onAttached: event(), onDetached: event(),
            async query(query = {}) { await hooks.query?.(query); return clone(tabs.filter(tab => Object.entries(query).every(([key, value]) => tab[key] === value))); },
            async get(id) { await hooks.get?.(id); return clone(tab(id)); },
            async create(options) { effects.push(['create', clone(options)]); await hooks.create?.(); const created = { id: nextId++, title: 'New', groupId: -1, index: tabs.length, ...options }; tabs.push(created); chrome.tabs.onCreated.emit(created); await hooks.created?.(created); return clone(created); },
            async update(id, update) { await hooks.update?.(id, update); effects.push(['update', id, clone(update)]); Object.assign(tab(id), update); if (update.pinned) tab(id).groupId = -1; chrome.tabs.onUpdated.emit(id, update, tab(id)); if (update.active) chrome.tabs.onActivated.emit({ tabId: id, windowId: tab(id).windowId }); return clone(tab(id)); },
            async remove(ids) { for (const id of [].concat(ids)) { const removed = tab(id); effects.push(['remove', id]); tabs = tabs.filter(tab => tab.id !== id); chrome.tabs.onRemoved.emit(id, { windowId: removed.windowId, isWindowClosing: false }); } },
            async ungroup(ids) { await hooks.ungroup?.(ids); effects.push(['ungroup', clone(ids)]); for (const id of ids) tab(id).groupId = -1; },
            async group(args) { effects.push(['group', clone(args)]); const id = args.groupId ?? 1000 + groups.length; if (!groups.some(g => g.id === id)) groups.push({ id, windowId: args.createProperties?.windowId || 1 }); for (const tabId of args.tabIds) tab(tabId).groupId = id; return id; },
            async move(ids, options) { effects.push(['move', clone(ids), options]); }
        },
        tabGroups: { onRemoved: event(), onUpdated: event(), async query() { return clone(groups); }, async update(id, update) { Object.assign(groups.find(g => g.id === id), update); effects.push(['groupUpdate', id, update]); }, async move() {} },
        bookmarks: { async search(query) { return clone(nodes.filter(node => node.title === query.title)); }, async get(id) { return clone(nodes.filter(node => node.id === id)); },
            async getChildren(id) { return clone(nodes.filter(node => node.parentId === id)); },
            async getSubTree(id) { const build = id => { const node = nodes.find(node => node.id === id); return node && { ...node, children: nodes.filter(child => child.parentId === id).map(child => build(child.id)) }; }; return [build(id)]; },
            async removeTree(id) { const remove = id => { for (const child of nodes.filter(node => node.parentId === id)) remove(child.id); nodes = nodes.filter(node => node.id !== id); }; remove(id); },
            async create(input) { const node = { id: `node-${nodes.length}`, ...input }; nodes.push(node); return clone(node); }
        }
    };
});

test('ordinary open bootstraps pinned then commits ownership before unpin, with no Space adoption or same-URL recovery', async () => {
    const s = stores({ install: true });
    hooks.update = (id, update) => { if (update.pinned === false) { assert.equal(session[FAVORITE_SESSION_KEY].bindings[0].tabId, id); assertGlobal(s, id); } };
    const result = await s.favorites.dispatch(req('open', { favoriteId: 'f' })); await s.idle();
    assert.equal(result.tab.id, 100); assert.equal(result.tab.pinned, false); assertGlobal(s, 100);
    assert.deepEqual(effects.find(effect => effect[0] === 'create')[1], { windowId: 1, url: 'https://same.test/', pinned: true, active: false });
    assert.equal(ownerOf(s.spaces.spaces, 2).id, 'b');
    assert.deepEqual(Object.keys(local[FAVORITES_KEY][0]).sort(), ['id', 'sourceBookmarkId', 'title', 'url']);
});

test('initial ownership and known-ID receipts exclude tabs before real Space startup, restore and snapshots', async () => {
    local[FAVORITES_KEY].push(saved('pending'));
    session[FAVORITE_SESSION_KEY] = { version: 1, bindings: [{ favoriteId: 'f', windowId: 1, tabId: 1, mode: 'ordinary' }], attempts: [{ favoriteId: 'pending', windowId: 1, tabId: 2, mode: 'ordinary', kind: 'adopt', url: 'https://same.test/' }] };
    local.spaceTabSnapshot = [1, 2].map(tabId => ({ tabId, spaceId: 'a', section: 'temporaryTabs', url: tab(tabId).url }));
    session.spaceRestoreQueue = clone(local.spaceTabSnapshot); session.spaceRecoveryCandidates = [1, 2]; session.restoredTabRanks = [[1, 0], [2, 1]];
    local.spaces[0].lastTab = 1;
    const s = stores(); await s.spaces.dispatch({ action: 'get' });
    assertGlobal(s, 1); assertGlobal(s, 2); assert.equal(s.spaces.spaces[0].lastTab, undefined);
    assert(!s.spaces.restoredRanks.size); assert(!s.spaces.recoveryCandidates.size);
    assert(local.spaceWindowSnapshot.every(window => window.tabs.length === 0));
});

test('ordinary ownership survives assign, stale patch, import, native pin toggles, activation and group projection', async () => {
    const s = stores({ install: true }); await s.favorites.dispatch(req('addTab', { tabId: 1 })); await s.idle();
    const favoriteId = local[FAVORITES_KEY].find(item => item.id !== 'f').id;
    await s.spaces.dispatch({ action: 'assign', spaceId: 'b', tabId: 1 });
    const before = clone(s.spaces.spaces), after = clone(before); after[1].temporaryTabs.push(1); after[1].lastTab = 1;
    await s.spaces.dispatch({ action: 'patch', before, after }); assertGlobal(s, 1); assert.notEqual(s.spaces.spaces[1].lastTab, 1);
    tab(1).groupId = 42; groups.push({ id: 42, windowId: 1, title: 'Native', color: 'blue' });
    await s.spaces.dispatch({ action: 'import', windowId: 1 }); assertGlobal(s, 1); assert.equal(tab(1).groupId, -1);
    for (const pinned of [true, false]) { await chrome.tabs.update(1, { pinned }); await s.idle(); assertGlobal(s, 1); }
    sync.syncTabGroups = true; await s.spaces.dispatch({ action: 'activate', spaceId: 'b', windowId: 1 });
    await s.favorites.dispatch(req('open', { favoriteId })); await s.idle(); assert.equal(s.spaces.active[1], 'b'); assertGlobal(s, 1); assert.equal(tab(1).groupId, -1);
});

test('prospective preference toggles do not change existing pin states, while closed reopen uses latest setting', async () => {
    sync.ordinaryFavoriteTabs = false; const s = stores({ install: true });
    await s.favorites.dispatch(req('open', { favoriteId: 'f' })); assert.equal(tab(100).pinned, true);
    sync.ordinaryFavoriteTabs = true; await s.favorites.dispatch(req('open', { favoriteId: 'f' })); assert.equal(tab(100).pinned, true);
    local[FAVORITES_KEY].push(saved('second')); await s.favorites.saveItems(clone(local[FAVORITES_KEY]));
    await s.favorites.dispatch(req('open', { favoriteId: 'second' })); assert.equal(tab(101).pinned, false);
    sync.ordinaryFavoriteTabs = false; await s.favorites.dispatch(req('open', { favoriteId: 'second' })); assert.equal(tab(101).pinned, false);
    await chrome.tabs.remove(101); await s.idle(); await s.favorites.dispatch(req('open', { favoriteId: 'second' })); assert.equal(tab(102).pinned, true);
});

test('ordinary native pin changes stay owned; legacy manual unpin releases exact page into a Space', async () => {
    sync.ordinaryFavoriteTabs = false; const s = stores({ install: true }); await s.favorites.dispatch(req('open', { favoriteId: 'f' }));
    await chrome.tabs.update(100, { pinned: false }); await s.idle();
    assert.equal(s.spaces.isGlobalTab(100), false); assert(ownerOf(s.spaces.spaces, 100));
    assert.equal((await s.favorites.dispatch(req('get'))).favorites[0].tabId, null);
});

test('group adoption detaches only the explicit global Favorite even with sync disabled', async () => {
    tab(1).groupId = tab(2).groupId = 42; groups = [{ id: 42, windowId: 1, title: 'Existing' }];
    const s = stores(); await s.favorites.dispatch(req('addTab', { tabId: 1 }));
    assert.equal(tab(1).pinned, false); assert.equal(tab(1).groupId, -1); assert.equal(tab(2).groupId, 42);
    assert(effects.some(effect => effect[0] === 'ungroup' && effect[1].length === 1 && effect[1][0] === 1)); assertGlobal(s, 1);
});

for (const stage of ['known-id', 'bind', 'ungroup', 'unpin']) test(`ordinary ${stage} failure preserves page and retries exact receipt without duplicate`, async () => {
    const s = stores(); let fail = true;
    if (stage === 'known-id' || stage === 'bind') hooks.sessionSet = value => {
        const state = value[FAVORITE_SESSION_KEY];
        if (fail && state && (stage === 'known-id' ? state.attempts.some(a => a.tabId === 100) && !state.bindings.length : state.bindings.some(b => b.tabId === 100))) throw new Error('storage unavailable');
    };
    if (stage === 'ungroup') { hooks.created = created => { created.groupId = 42; }; hooks.ungroup = () => { if (fail) throw new Error('group unavailable'); }; }
    if (stage === 'unpin') hooks.update = (id, update) => { if (fail && update.pinned === false) throw new Error('unpin unavailable'); };
    await assert.rejects(s.favorites.dispatch(req('open', { favoriteId: 'f' })));
    assert.equal(tab(100).pinned, true); assert.equal(effects.filter(e => e[0] === 'create').length, 1);
    fail = false; const result = await s.favorites.dispatch(req('open', { favoriteId: 'f' }));
    assert.equal(result.tab.id, 100); assert.equal(result.tab.pinned, false); assertGlobal(s, 100);
    assert.equal(effects.filter(e => e[0] === 'create').length, 1);
});

test('unknown create outcome stays pinned and never retries by URL, with frozen ordinary mode', async () => {
    const s = stores(); hooks.created = () => { throw new Error('response lost'); };
    await assert.rejects(s.favorites.dispatch(req('open', { favoriteId: 'f' })), { code: 'UNCERTAIN_RESULT' });
    sync.ordinaryFavoriteTabs = false; hooks.created = undefined;
    await assert.rejects(s.favorites.dispatch(req('open', { favoriteId: 'f' })), { code: 'UNCERTAIN_RESULT' });
    assert.equal(tab(100).pinned, true); assert.equal(effects.filter(e => e[0] === 'create').length, 1);
    assert.equal(session[FAVORITE_SESSION_KEY].attempts[0].mode, 'ordinary');
});

test('remove and explicit reverse release put already-unpinned pages back in Spaces without touching source links', async () => {
    const s = stores(); await s.favorites.dispatch(req('addTab', { tabId: 1 }));
    const adopted = local[FAVORITES_KEY].find(item => item.id !== 'f'), source = clone(nodes);
    await s.favorites.dispatch(req('releaseTab', { tabId: 1, favoriteId: s.favorites.state.bindings.find(entry => entry.tabId === 1).favoriteId }));
    assert(ownerOf(s.spaces.spaces, 1)); assert.equal(s.spaces.isGlobalTab(1), false); assert(local[FAVORITES_KEY].some(item => item.id === adopted.id));
    await s.favorites.dispatch(req('open', { favoriteId: 'f' })); await s.favorites.dispatch(req('remove', { favoriteId: 'f' }));
    assert(ownerOf(s.spaces.spaces, 100)); assert.equal(tab(100).pinned, false); assert.deepEqual(nodes, source);
});

test('remove also releases a known pending adoption whose bind never committed', async () => {
    const s = stores(); let fail = true;
    hooks.sessionSet = value => { if (fail && value[FAVORITE_SESSION_KEY]?.bindings.some(b => b.tabId === 1)) throw new Error('bind interrupted'); };
    await assert.rejects(s.favorites.dispatch(req('addTab', { tabId: 1 }))); fail = false;
    const favoriteId = local[FAVORITES_KEY].find(item => item.id !== 'f').id;
    await s.favorites.dispatch(req('remove', { favoriteId })); assert(ownerOf(s.spaces.spaces, 1)); assert.equal(tab(1).pinned, false);
});

test('clean and delete serialize with promotion and cannot close global Favorite in stale Space arrays', async () => {
    const s = stores(); await s.favorites.dispatch(req('addTab', { tabId: 1 }));
    s.spaces.spaces[0].temporaryTabs.push(1); // stale panel cannot grant ownership
    await s.spaces.dispatch({ action: 'clean', spaceId: 'a', windowId: 1 }); assert.equal(tab(1).pinned, false); assertGlobal(s, 1);
    s.spaces.spaces[0].temporaryTabs.push(1); await s.spaces.dispatch({ action: 'delete', spaceId: 'a' });
    assert.equal(tab(1).pinned, false); assertGlobal(s, 1); assert(!effects.some(e => e[0] === 'remove' && e[1] === 1));
    assert.equal(isProtectedFavorite(tab(1), new Set(), {}, new Set(), s.favorites), true);
});

test('close command validates exact binding under the queue and keeps saved link for ordinary page', async () => {
    const s = stores({ install: true }); await s.favorites.dispatch(req('open', { favoriteId: 'f' }));
    await assert.rejects(s.favorites.dispatch(req('closeTab', { favoriteId: 'f', tabId: 2 })), { code: 'STALE_TAB' });
    await s.favorites.dispatch(req('closeTab', { favoriteId: 'f', tabId: 100 })); await s.idle();
    assert.equal((await s.favorites.dispatch(req('get'))).favorites[0].tabId, null); assert.equal(local[FAVORITES_KEY][0].id, 'f');
});

test('window move collision preserves both ordinary pages and assigns incoming extra to Space; replacement transfers exact identity', async () => {
    const s = stores({ install: true }); await s.favorites.dispatch(req('open', { favoriteId: 'f' }));
    await s.favorites.dispatch(req('open', { favoriteId: 'f', windowId: 2 }));
    tab(100).windowId = 2; chrome.tabs.onAttached.emit(100, { newWindowId: 2 }); await s.idle();
    assert.equal((await s.favorites.dispatch(req('get', { windowId: 2 }))).favorites[0].tabId, 101);
    assert(ownerOf(s.spaces.spaces, 100)); assert.equal(tab(100).pinned, false); assert.equal(s.spaces.isGlobalTab(100), false);
    tab(101).id = 501; chrome.tabs.onReplaced.emit(501, 101); await s.idle();
    assert.equal((await s.favorites.dispatch(req('get', { windowId: 2 }))).favorites[0].tabId, 501); assertGlobal(s, 501);
});

test('transient window reads block reconciliation without releasing ordinary ownership', async () => {
    const s = stores(); await s.favorites.dispatch(req('open', { favoriteId: 'f' })); const before = clone(session[FAVORITE_SESSION_KEY]);
    hooks.window = () => { throw new Error('window unavailable'); };
    await assert.rejects(s.spaces.dispatch({ action: 'clean', spaceId: 'a', windowId: 1 }));
    assert.deepEqual(session[FAVORITE_SESSION_KEY], before); assert(!effects.some(e => e[0] === 'remove'));
});

test('adapter recovery runs before Space adoption; no witness means saved-closed and no URL restoration', async () => {
    const recovered = { version: 1, bindings: [{ favoriteId: 'f', windowId: 1, tabId: 1, mode: 'ordinary' }], attempts: [] };
    let loaded = false;
    const s = stores({ ownershipPersistence: { async load() { assert.equal(local.spaces[0].temporaryTabs[0], 1); loaded = true; return recovered; }, async save({ state }) { session[FAVORITE_SESSION_KEY] = clone(state); } } });
    await s.spaces.dispatch({ action: 'get' }); assert(loaded); assertGlobal(s, 1);
    delete session[FAVORITE_SESSION_KEY]; delete session.spaceSession;
    const restarted = stores({ ownershipPersistence: { async load() { return { version: 1, bindings: [], attempts: [] }; }, async save({ state }) { session[FAVORITE_SESSION_KEY] = clone(state); } } });
    const result = await restarted.favorites.dispatch(req('get'));
    assert.equal(result.favorites[0].tabId, null); assert(ownerOf(restarted.spaces.spaces, 1)); assert.equal(tab(1).pinned, false);
});

test('ordinary bookmark batch retains distinct equal-URL identities and supports exact live source adoption', async () => {
    local.pinnedTabStatesById = { 1: { bookmarkId: 'bookmark', pinnedUrl: 'https://same.test/' } };
    local.spaces[0].spaceBookmarks = [1]; local.spaces[0].temporaryTabs = [];
    const s = stores(), result = await s.favorites.dispatch(req('addBookmarks', { spaceId: 'a', bookmarkFolderId: 'a', beforeId: null,
        bookmarks: [{ bookmarkId: 'bookmark', parentId: 'a', tabId: 1 }, { bookmarkId: 'twin', parentId: 'a' }] }));
    assert.equal(result.batch.complete, true); assert.deepEqual(result.batch.entries.map(entry => entry.tabId), [1, 100]);
    assertGlobal(s, 1); assertGlobal(s, 100); assert.equal(tab(1).pinned, false); assert.equal(tab(100).pinned, false);
    assert.equal(nodes.filter(node => ['bookmark', 'twin'].includes(node.id)).length, 2);
});

test('default pinned bookmark adoption uses real ownership reservation without rejecting its intentional Space removal', async () => {
    sync.ordinaryFavoriteTabs = false;
    local.pinnedTabStatesById = { 1: { bookmarkId: 'bookmark', pinnedUrl: 'https://same.test/' } };
    local.spaces[0].spaceBookmarks = [1]; local.spaces[0].temporaryTabs = [];
    const s = stores(), result = await s.favorites.dispatch(req('addBookmark', { spaceId: 'a', bookmarkFolderId: 'a', bookmarkId: 'bookmark', parentId: 'a', tabId: 1 }));
    assert.equal(result.tab.id, 1); assert.equal(result.tab.pinned, true); assertGlobal(s, 1);
});

test('recovered pending legacy adoption can finish after startup excluded its exact reserved Space membership', async () => {
    sync.ordinaryFavoriteTabs = false;
    local[FAVORITES_KEY] = [{ ...saved('f'), sourceBookmarkId: 'bookmark' }];
    local.pinnedTabStatesById = { 1: { bookmarkId: 'bookmark', pinnedUrl: 'https://same.test/' } };
    session[FAVORITE_SESSION_KEY] = { version: 1, bindings: [], attempts: [{ favoriteId: 'f', tabId: 1, windowId: 1, kind: 'adopt', url: 'https://same.test/' }] };
    const s = stores(); await s.spaces.dispatch({ action: 'get' }); assertGlobal(s, 1);
    const result = await s.favorites.dispatch(req('addBookmark', { spaceId: 'a', bookmarkFolderId: 'a', bookmarkId: 'bookmark', parentId: 'a', tabId: 1 }));
    assert.equal(result.tab.id, 1); assert.equal(result.tab.pinned, true); assertGlobal(s, 1);
});

test('Space duplicate layout recovery uses the same global-excluded population as its saved window snapshot', async () => {
    tabs = [{ id: 1, windowId: 1, pinned: false, groupId: -1, index: 0, url: 'https://global.test/' },
        { id: 2, windowId: 1, pinned: false, groupId: -1, index: 1, url: 'https://same.test/' },
        { id: 3, windowId: 1, pinned: false, groupId: -1, index: 2, url: 'https://same.test/' }];
    local.spaces = [space('a', [1, 2]), space('b', [3])];
    session[FAVORITE_SESSION_KEY] = { version: 1, bindings: [{ favoriteId: 'f', tabId: 1, windowId: 1, mode: 'ordinary' }], attempts: [] };
    const first = stores(); await first.spaces.dispatch({ action: 'get' });
    delete session.spaceSession; tabs.reverse();
    const next = stores(); await next.spaces.dispatch({ action: 'get' });
    assertGlobal(next, 1); assert.equal(ownerOf(next.spaces.spaces, 2).id, 'a'); assert.equal(ownerOf(next.spaces.spaces, 3).id, 'b');
    assert.equal(next.spaces.restoreQueue.length, 0);
});

for (const ordinaryFavoriteTabs of [false, true]) test(`source disappearance before authoritative reservation exclusion is rejected (${ordinaryFavoriteTabs ? 'ordinary' : 'native'})`, async () => {
    sync.ordinaryFavoriteTabs = ordinaryFavoriteTabs;
    local.pinnedTabStatesById = { 1: { bookmarkId: 'bookmark', pinnedUrl: 'https://same.test/' } };
    const s = stores(); await s.spaces.dispatch({ action: 'get' });
    hooks.localSet = value => { if (value[FAVORITES_KEY]?.some(item => item.sourceBookmarkId === 'bookmark')) s.spaces.spaces[0].temporaryTabs = []; };
    await assert.rejects(s.favorites.dispatch(req('addBookmark', { spaceId: 'a', bookmarkFolderId: 'a', bookmarkId: 'bookmark', parentId: 'a', tabId: 1 })), { code: 'STALE_BOOKMARK' });
    assert.equal(tab(1).pinned, false); assert(!effects.some(effect => effect[0] === 'update'));
});

for (const ordinaryFavoriteTabs of [false, true]) test(`release and later adoption cannot reuse old exclusion acknowledgment (${ordinaryFavoriteTabs ? 'ordinary' : 'native'})`, async () => {
    sync.ordinaryFavoriteTabs = ordinaryFavoriteTabs;
    local.pinnedTabStatesById = { 1: { bookmarkId: 'bookmark', pinnedUrl: 'https://same.test/' } };
    const s = stores(), input = req('addBookmark', { spaceId: 'a', bookmarkFolderId: 'a', bookmarkId: 'bookmark', parentId: 'a', tabId: 1 });
    await s.favorites.dispatch(input); await s.favorites.dispatch(req('releaseTab', { tabId: 1, favoriteId: s.favorites.state.bindings.find(entry => entry.tabId === 1).favoriteId }));
    const before = effects.length;
    hooks.sessionSet = value => { if (value[FAVORITE_SESSION_KEY]?.attempts.some(entry => entry.tabId === 1)) s.spaces.spaces[0].temporaryTabs = []; };
    await assert.rejects(s.favorites.dispatch(input), { code: 'STALE_BOOKMARK' });
    assert.equal(tab(1).pinned, false); assert.equal(effects.length, before);
});

test('reverse release rejects a stale Favorite identity even when the exact tab still exists', async () => {
    const s = stores(); await s.favorites.dispatch(req('addTab', { tabId: 1 }));
    await assert.rejects(s.favorites.dispatch(req('releaseTab', { favoriteId: 'f', tabId: 1 })), { code: 'STALE_TAB' });
    assertGlobal(s, 1); assert.equal(tab(1).pinned, false);
});

test('remove tracks the exact ordinary survivor when it moves windows during the durable release', async () => {
    const s = stores({ install: true }); await s.favorites.dispatch(req('open', { favoriteId: 'f' }));
    hooks.sessionSet = value => {
        if (value[FAVORITE_SESSION_KEY]?.bindings.length === 0 && tabs.some(tab => tab.id === 100)) {
            tab(100).windowId = 2; chrome.tabs.onAttached.emit(100, { newWindowId: 2 });
        }
    };
    await s.favorites.dispatch(req('remove', { favoriteId: 'f' })); await s.idle();
    assert.equal(tab(100).windowId, 2); assert.equal(tab(100).pinned, false); assert(ownerOf(s.spaces.spaces, 100));
    assert.equal(s.spaces.isGlobalTab(100), false); assert(!effects.some(effect => effect[0] === 'remove'));
});

test('remove never unpins a native instance that moved to a different window during release', async () => {
    sync.ordinaryFavoriteTabs = false; const s = stores({ install: true }); await s.favorites.dispatch(req('open', { favoriteId: 'f' }));
    hooks.sessionSet = value => { if (value[FAVORITE_SESSION_KEY]?.bindings.length === 0) tab(100).windowId = 2; };
    const result = await s.favorites.dispatch(req('remove', { favoriteId: 'f' })); await s.idle();
    assert.equal(tab(100).pinned, true); assert.match(result.warning, /moved browser pin/);
    assert(!effects.some(effect => effect[0] === 'update' && effect[2].pinned === false));
});

test('explicit adoption of a known created receipt reuses the existing Favorite instead of saving a competing link', async () => {
    const s = stores(); let fail = true;
    hooks.sessionSet = value => { if (fail && value[FAVORITE_SESSION_KEY]?.attempts.some(entry => entry.tabId === 100)) throw new Error('ID write interrupted'); };
    await assert.rejects(s.favorites.dispatch(req('open', { favoriteId: 'f' }))); fail = false;
    const result = await s.favorites.dispatch(req('addTab', { tabId: 100 }));
    assert.equal(result.tab.id, 100); assert.equal(result.tab.pinned, false);
    assert.deepEqual(local[FAVORITES_KEY].map(item => item.id), ['f']); assertGlobal(s, 100);
    assert.equal(effects.filter(effect => effect[0] === 'create').length, 1);
});

test('existing ordinary Favorite honors the final authorization guard before tab activation or window focus', async () => {
    const s = stores(); await s.favorites.dispatch(req('open', { favoriteId: 'f' }));
    const before = effects.length; let calls = 0;
    await assert.rejects(s.spaces.run(() => s.favorites.open('f', 1, { beforeMutation: async () => {
        calls++; throw Object.assign(new Error('Companion was unpaired'), { code: 'UNAUTHORIZED' });
    } })), { code: 'UNAUTHORIZED' });
    assert.equal(calls, 1); assert.equal(effects.length, before); assertGlobal(s, 100);
});

test('existing Favorite rechecks exact window after an asynchronous final authorization guard', async () => {
    const s = stores(); await s.favorites.dispatch(req('open', { favoriteId: 'f' })); const before = effects.length;
    await assert.rejects(s.spaces.run(() => s.favorites.open('f', 1, { beforeMutation: async () => { tab(100).windowId = 2; } })), { code: 'STALE_TAB' });
    assert.equal(effects.length, before); assert.equal(tab(100).windowId, 2);
});

test('existing Favorite blocks activation when authorization is revoked during the final exact tab lookup', async () => {
    const s = stores(); await s.favorites.dispatch(req('open', { favoriteId: 'f' }));
    const before = effects.length; let lookups = 0, revoked = false;
    hooks.get = () => { if (++lookups === 2) revoked = true; };
    await assert.rejects(s.spaces.run(() => s.favorites.open('f', 1, { beforeMutation: async () => {
        if (revoked) throw Object.assign(new Error('Companion was unpaired'), { code: 'UNAUTHORIZED' });
    } })), { code: 'UNAUTHORIZED' });
    assert.equal(lookups, 2); assert.equal(effects.length, before);
});

test('existing Favorite blocks separate window focus when authorization is revoked during tab activation', async () => {
    const s = stores(); await s.favorites.dispatch(req('open', { favoriteId: 'f' }));
    const before = effects.length; let revoked = false;
    hooks.update = (_id, update) => { if (update.active) revoked = true; };
    await assert.rejects(s.spaces.run(() => s.favorites.open('f', 1, { beforeMutation: async () => {
        if (revoked) throw Object.assign(new Error('Companion was unpaired'), { code: 'UNAUTHORIZED' });
    } })), { code: 'UNAUTHORIZED' });
    assert.deepEqual(effects.slice(before), [['update', 100, { active: true }]]);
});

for (const pending of [false, true]) for (const revokeAt of ['final lookup', 'tab activation']) {
    test(`${pending ? 'pending' : 'new'} Favorite retains committed ownership when authorization is revoked during ${revokeAt}`, async () => {
        const tabId = pending ? 1 : 100;
        if (pending) session[FAVORITE_SESSION_KEY] = { version: 1, bindings: [], attempts: [
            { favoriteId: 'f', windowId: 1, tabId, mode: 'ordinary', kind: 'adopt', url: saved('f').url }
        ] };
        const s = stores(); let revoked = false;
        hooks.get = id => {
            const state = session[FAVORITE_SESSION_KEY];
            if (revokeAt === 'final lookup' && id === tabId && state?.bindings.some(entry => entry.tabId === tabId)
                && state.attempts.length === 0) revoked = true;
        };
        hooks.update = (_id, update) => { if (revokeAt === 'tab activation' && update.active) revoked = true; };
        await assert.rejects(s.spaces.run(() => s.favorites.open('f', 1, { beforeMutation: async () => {
            if (revoked) throw Object.assign(new Error('Companion was unpaired'), { code: 'UNAUTHORIZED' });
        } })), { code: 'UNAUTHORIZED' });
        assert.equal(revoked, true); assertGlobal(s, tabId);
        assert.equal(tab(tabId).pinned, false);
        assert.deepEqual(session[FAVORITE_SESSION_KEY].bindings, [{ favoriteId: 'f', windowId: 1, tabId, mode: 'ordinary' }]);
        assert.deepEqual(session[FAVORITE_SESSION_KEY].attempts, []);
        assert.equal(effects.filter(effect => effect[0] === 'create').length, pending ? 0 : 1);
        assert.deepEqual(effects.filter(effect => effect[0] === 'focus' || effect[0] === 'update' && effect[2].active),
            revokeAt === 'tab activation' ? [['update', tabId, { active: true }]] : []);
    });
}


test('Space metadata and exact Tab edits preserve real ordinary-Favorite ownership and saved identity', async () => {
    chrome.bookmarks.update = async (id, changes) => {
        const node = nodes.find(node => node.id === id); Object.assign(node, changes);
        effects.push(['bookmark-update', id, clone(changes)]); return clone(node);
    };
    const s = stores({ install: true }); await s.spaces.dispatch({ action: 'get' });
    await s.spaces.dispatch({ action: 'assign', spaceId: 'a', tabId: 2 });
    const target = tabId => ({ type: 'tabMenuAction', windowId: 1, spaceId: 'a', bookmarkFolderId: 'a', tabId });
    const stale = await runTabMenuAction(s.spaces, { ...target(1), action: 'describe' });
    await s.favorites.dispatch(req('addTab', { tabId: 1 }));
    const fromPin = await s.favorites.dispatch(req('addBookmark', { spaceId: 'a', bookmarkFolderId: 'a', bookmarkId: 'bookmark', parentId: 'a' }));
    await s.idle();
    const savedFavorites = clone(local[FAVORITES_KEY]), savedOwnership = clone(session[FAVORITE_SESSION_KEY]);
    const today = await runTabMenuAction(s.spaces, { ...target(2), action: 'describe' });
    await Promise.all([
        s.spaces.dispatch({ action: 'metadata', spaceId: 'a', changes: { name: 'Edited Space', color: 'cyan', icon: 'rocket' } }),
        runTabMenuAction(s.spaces, { ...target(2), action: 'rename', expected: today.expected, value: 'Today alias' })
    ]);
    await s.spaces.dispatch({ action: 'newFolder', spaceId: 'a', title: 'New saved folder' });
    const pin = { type: 'tabMenuAction', windowId: 1, spaceId: 'a', bookmarkFolderId: 'a', bookmarkId: 'bookmark', parentId: 'a' };
    for (const [action, value] of [['rename', 'Exact saved name'], ['editUrl', 'https://edited.test/']]) {
        const current = await runTabMenuAction(s.spaces, { ...pin, action: 'describe' });
        await runTabMenuAction(s.spaces, { ...pin, action, value, expected: current.expected });
    }
    for (const action of ['rename', 'copyLink', 'duplicate', 'mute']) {
        await assert.rejects(runTabMenuAction(s.spaces, { ...target(1), action, expected: stale.expected,
            value: action === 'mute' ? true : 'Must not edit Favorite' }), /changed/);
    }
    assertGlobal(s, 1); assertGlobal(s, fromPin.tab.id);
    assert.equal(tab(1).pinned, false); assert.equal(tab(fromPin.tab.id).pinned, false); assert.equal(tab(2).title, 'Twin');
    assert.deepEqual(local[FAVORITES_KEY], savedFavorites); assert.deepEqual(session[FAVORITE_SESSION_KEY], savedOwnership);
    assert.equal(local.spaceRegistry.a.spaceUuid, 'a'); assert.equal(local.spaceRegistry.a.icon, 'rocket');
    assert.equal(nodes.find(node => node.id === 'a').title, 'Edited Space');
    assert.equal(nodes.find(node => node.title === 'New saved folder').parentId, 'a');
    assert.deepEqual(nodes.find(node => node.id === 'bookmark'), { id: 'bookmark', parentId: 'a', title: 'Exact saved name', url: 'https://edited.test/' });
    assert.equal(nodes.find(node => node.id === 'twin').url, 'https://same.test/');
    assert.equal(local.tabNameOverridesById[2].name, 'Today alias');
    const snapshot = await getBridgeSnapshot(s.spaces, 1);
    assert.equal(snapshot.tabs.find(tab => tab.id === 1).spaceId, null);
    assert.equal(snapshot.tabs.find(tab => tab.id === 2).title, 'Today alias');
    assert.equal(snapshot.spaces.find(space => space.id === 'a').name, 'Edited Space');
    assert.equal(Object.hasOwn(snapshot.spaces.find(space => space.id === 'a'), 'icon'), false);
});

for (const ordinaryFavoriteTabs of [false, true]) test(`existing native split blocks Favorite adoption before saved-link/ownership writes (${ordinaryFavoriteTabs ? 'ordinary' : 'native'})`, async () => {
    sync.ordinaryFavoriteTabs = ordinaryFavoriteTabs;
    const s = stores(); await s.spaces.dispatch({ action: 'get' });
    tab(1).splitViewId = tab(2).splitViewId = 0;
    const beforeItems = clone(local[FAVORITES_KEY]), beforeSpaces = clone(s.spaces.spaces), beforeOwnership = clone(session[FAVORITE_SESSION_KEY]);
    await assert.rejects(s.favorites.dispatch(req('addTab', { tabId: 1 })), /End Split View before moving or pinning this tab\./);
    assert.deepEqual(local[FAVORITES_KEY], beforeItems); assert.deepEqual(s.spaces.spaces, beforeSpaces);
    assert.deepEqual(session[FAVORITE_SESSION_KEY], beforeOwnership); assert.deepEqual(effects, []);
    assert.equal(tab(1).splitViewId, 0); assert.equal(tab(2).splitViewId, 0);
});

test('Favorite adoption rechecks a newly created native split after reading the prospective mode', async () => {
    const s = stores(); await s.spaces.dispatch({ action: 'get' });
    hooks.syncGet = keys => { if (keys === 'ordinaryFavoriteTabs') tab(1).splitViewId = tab(2).splitViewId = 7; };
    await assert.rejects(s.favorites.dispatch(req('addTab', { tabId: 1 })), /End Split View/);
    assert.equal(local[FAVORITES_KEY].length, 1); assert.deepEqual(s.favorites.state.attempts, []);
    assert.deepEqual(effects, []); assert.equal(ownerOf(s.spaces.spaces, 1).id, 'a');
});

for (const stage of ['before-native-pin', 'before-bind', 'before-unpin']) test(`Favorite ${stage} boundary never mutates a late native split`, async () => {
    sync.ordinaryFavoriteTabs = stage !== 'before-native-pin';
    const s = stores(); await s.spaces.dispatch({ action: 'get' }); let injected = false;
    if (stage === 'before-native-pin') hooks.localSet = value => {
        if (value[FAVORITES_KEY]?.length === 2) { tab(1).splitViewId = tab(2).splitViewId = 0; injected = true; }
    };
    if (stage === 'before-bind') {
        let afterSaved = false, reads = 0;
        hooks.localSet = value => { if (value[FAVORITES_KEY]?.length === 2) afterSaved = true; };
        hooks.get = id => { if (afterSaved && id === 1 && ++reads === 3) { tab(1).splitViewId = tab(2).splitViewId = 0; injected = true; } };
    }
    if (stage === 'before-unpin') {
        hooks.created = created => { created.groupId = 42; groups.push({ id: 42, windowId: 1 }); };
        hooks.ungroup = ids => { tab(ids[0]).splitViewId = 0; tab(1).splitViewId = 0; injected = true; };
    }
    await assert.rejects(s.favorites.dispatch(stage === 'before-unpin' ? req('open', { favoriteId: 'f' }) : req('addTab', { tabId: 1 })), /End Split View/);
    assert(injected, `Test must reach the ${stage} race`);
    assert(!effects.some(effect => effect[0] === 'update'), 'No pin, unpin or focus mutation may follow the native split');
    assert(!effects.some(effect => effect[0] === 'remove' || effect[0] === 'move' || effect[0] === 'group'));
});

test('Favorite reverse drag rejects an existing native split without releasing ownership', async () => {
    const s = stores(); const result = await s.favorites.dispatch(req('addTab', { tabId: 1 }));
    const favoriteId = result.favorites.find(item => item.tabId === 1).id;
    tab(1).splitViewId = tab(2).splitViewId = 0; effects.length = 0;
    const before = clone(session[FAVORITE_SESSION_KEY]);
    await assert.rejects(s.favorites.dispatch(req('releaseTab', { favoriteId, tabId: 1 })), /End Split View/);
    assert.deepEqual(session[FAVORITE_SESSION_KEY], before); assert.deepEqual(effects, []); assertGlobal(s, 1);
});

test('split sentinel remains a normal Favorite source', async () => {
    tab(1).splitViewId = -1;
    const s = stores(); const result = await s.favorites.dispatch(req('addTab', { tabId: 1 }));
    assert.equal(result.tab.id, 1); assertGlobal(s, 1);
});

for (const boundary of ['adoption-receipt', 'saved-link', 'binding-receipt', 'space-persist', 'final-binding-receipt']) {
    test(`late native split during ${boundary} releases only new Favorite ownership and preserves canonical Space metadata`, async () => {
        local.spaces[0].temporaryTabs = [1, 2]; local.spaces[1].temporaryTabs = [];
        local.spaces[0].lastTab = 1;
        local.tabNameOverridesById = { 1: { name: 'Original title' } };
        local.pinnedTabStatesById = { 9: { bookmarkId: 'unrelated', pinnedUrl: 'https://unrelated.test/' } };
        session.restoredTabRanks = [[1, 0], [2, 1]];
        const s = stores(); await s.spaces.dispatch({ action: 'get' });
        const beforeSpaces = clone(s.spaces.spaces), beforeDurableSpaces = clone(local.spaces);
        const beforeSnapshots = clone(local.spaceTabSnapshot), beforeNames = clone(local.tabNameOverridesById);
        const beforeBindings = clone(local.pinnedTabStatesById), beforeRanks = clone([...s.spaces.restoredRanks]);
        let injected = false;
        const split = () => { if (!injected) { injected = true; tab(1).splitViewId = tab(2).splitViewId = 0; } };
        hooks.sessionSet = value => {
            const state = value[FAVORITE_SESSION_KEY];
            if (!state) return;
            if (boundary === 'adoption-receipt' && state.attempts.some(entry => entry.tabId === 1) && !state.bindings.length) split();
            if (boundary === 'binding-receipt' && state.bindings.some(entry => entry.tabId === 1) && state.attempts.length) split();
            if (boundary === 'final-binding-receipt' && state.bindings.some(entry => entry.tabId === 1) && !state.attempts.length) split();
        };
        hooks.localSet = value => {
            if (boundary === 'saved-link' && value[FAVORITES_KEY]?.length === 2) split();
            if (boundary === 'space-persist' && value.spaces?.some(space => space.id === 'a' && !space.temporaryTabs.includes(1))) split();
        };
        await assert.rejects(s.favorites.dispatch(req('addTab', { tabId: 1 })), error =>
            error.code === 'NATIVE_SPLIT_ACTIVE' && /saved Favorite link was kept/.test(error.message));
        assert(injected, `The ${boundary} race must run`);
        assert.equal(local[FAVORITES_KEY].length, 2, 'Keep the durable link without an adopted live page');
        assert.equal(s.spaces.isGlobalTab(1), false); assert.equal(ownerOf(s.spaces.spaces, 1)?.id, 'a');
        assert.deepEqual(s.favorites.state.bindings, []); assert.deepEqual(s.favorites.state.attempts, []);
        assert.deepEqual(session[FAVORITE_SESSION_KEY].bindings, []); assert.deepEqual(session[FAVORITE_SESSION_KEY].attempts, []);
        assert.deepEqual(s.spaces.spaces, beforeSpaces); assert.deepEqual(local.spaces, beforeDurableSpaces);
        assert.deepEqual(local.spaceTabSnapshot, beforeSnapshots); assert.deepEqual(new Map(s.spaces.restoredRanks), new Map(beforeRanks));
        assert.deepEqual(local.tabNameOverridesById, beforeNames); assert.deepEqual(local.pinnedTabStatesById, beforeBindings);
        assert.deepEqual(effects, [], 'No native tab mutations should be needed to unwind extension ownership');
        await s.favorites.dispatch(req('get'));
        assert.equal(s.spaces.isGlobalTab(1), false); assert.deepEqual(s.spaces.spaces, beforeSpaces);
        assert.deepEqual(local.spaces, beforeDurableSpaces, 'A later reconcile must not eject the refused adoption');
    });
}

test('late split cleanup retains unrelated Favorite ownership and the source pinned-bookmark identity', async () => {
    local.spaces[0].spaceBookmarks = [1]; local.spaces[0].temporaryTabs = [];
    local.pinnedTabStatesById = { 1: { bookmarkId: 'bookmark', pinnedUrl: tab(1).url } };
    session[FAVORITE_SESSION_KEY] = { version: 1, bindings: [{ favoriteId: 'f', windowId: 1, tabId: 2, mode: 'ordinary' }], attempts: [] };
    const s = stores(); await s.spaces.dispatch({ action: 'get' });
    const beforeSpaces = clone(s.spaces.spaces), beforePinned = clone(local.pinnedTabStatesById);
    hooks.sessionSet = value => {
        if (value[FAVORITE_SESSION_KEY]?.bindings.some(entry => entry.tabId === 1)) tab(1).splitViewId = tab(2).splitViewId = 0;
    };
    await assert.rejects(s.favorites.dispatch(req('addTab', { tabId: 1 })), /End Split View/);
    assert.deepEqual(session[FAVORITE_SESSION_KEY].bindings, [{ favoriteId: 'f', windowId: 1, tabId: 2, mode: 'ordinary' }]);
    assert.deepEqual(session[FAVORITE_SESSION_KEY].attempts, []); assert.deepEqual(s.spaces.spaces, beforeSpaces);
    assert.deepEqual(local.pinnedTabStatesById, beforePinned); assert.equal(s.spaces.isGlobalTab(1), false); assert.equal(s.spaces.isGlobalTab(2), true);
});

test('failed late-split ownership cleanup is reported as unconfirmed and retried before later reconciliation', async () => {
    const s = stores(); await s.spaces.dispatch({ action: 'get' });
    const beforeSpaces = clone(s.spaces.spaces); let injected = false;
    hooks.sessionSet = value => {
        const state = value[FAVORITE_SESSION_KEY]; if (!state) return;
        if (!injected && state.bindings.some(entry => entry.tabId === 1)) {
            injected = true; tab(1).splitViewId = tab(2).splitViewId = 0;
        } else if (injected && !state.bindings.length && !state.attempts.length) throw new Error('Cleanup storage unavailable');
    };
    await assert.rejects(s.favorites.dispatch(req('addTab', { tabId: 1 })), error =>
        error.code === 'NATIVE_SPLIT_ACTIVE' && /ownership could not be confirmed/.test(error.message) && /saved Favorite link was kept/.test(error.message));
    assert.equal(s.favorites.persistenceDirty, true); assert.deepEqual(s.spaces.spaces, beforeSpaces); assert.deepEqual(effects, []);
    hooks.sessionSet = undefined;
    await s.favorites.dispatch(req('get'));
    assert.equal(s.favorites.persistenceDirty, false); assert.deepEqual(session[FAVORITE_SESSION_KEY].bindings, []);
    assert.deepEqual(session[FAVORITE_SESSION_KEY].attempts, []); assert.deepEqual(s.spaces.spaces, beforeSpaces);
    assert.equal(s.spaces.isGlobalTab(1), false);
});

for (const ownership of ['binding', 'attempt', 'both']) test(`release refused by a late native split restores exact ${ownership} ownership in its prior order`, async () => {
    local[FAVORITES_KEY].push(saved('before'), saved('after'));
    tabs.push({ id: 3, windowId: 1, url: 'https://before.test/', index: 2, pinned: false, groupId: -1 },
        { id: 4, windowId: 1, url: 'https://after.test/', index: 3, pinned: false, groupId: -1 });
    const binding = { favoriteId: 'f', windowId: 1, tabId: 1, mode: 'ordinary' };
    const receipt = { ...binding, kind: 'adopt', url: tab(1).url };
    session[FAVORITE_SESSION_KEY] = { version: 1,
        bindings: [{ ...binding, favoriteId: 'before', tabId: 3 }, ...(ownership === 'attempt' ? [] : [binding]), { ...binding, favoriteId: 'after', tabId: 4 }],
        attempts: ownership === 'binding' ? [] : [receipt] };
    const s = stores(); await s.spaces.dispatch({ action: 'get' });
    const before = clone(session[FAVORITE_SESSION_KEY]), beforeSpaces = clone(s.spaces.spaces);
    const beforeDurableSpaces = clone(local.spaces), beforeItems = clone(local[FAVORITES_KEY]);
    const beforeExclusions = [...s.favorites.spaceExclusions]; let injected = false;
    hooks.sessionSet = value => {
        const state = value[FAVORITE_SESSION_KEY];
        if (state && ![...state.bindings, ...state.attempts].some(entry => entry.tabId === 1)) {
            injected = true; tab(1).splitViewId = tab(2).splitViewId = 0;
        }
    };
    await assert.rejects(s.favorites.dispatch(req('releaseTab', { favoriteId: 'f', tabId: 1 })), error => error.code === 'NATIVE_SPLIT_ACTIVE');
    assert(injected); assert.deepEqual(s.favorites.state, before); assert.deepEqual(session[FAVORITE_SESSION_KEY], before);
    assert.deepEqual([...s.favorites.spaceExclusions], beforeExclusions); assert.deepEqual(local[FAVORITES_KEY], beforeItems);
    assert.deepEqual(s.spaces.spaces, beforeSpaces); assert.deepEqual(local.spaces, beforeDurableSpaces);
    assert.equal(s.spaces.isGlobalTab(1), true); assert.equal(ownerOf(s.spaces.spaces, 1), undefined); assert.deepEqual(effects, []);
    await s.favorites.dispatch(req('get'));
    assert.deepEqual(session[FAVORITE_SESSION_KEY], before); assert.equal(s.spaces.isGlobalTab(1), true);
    assert.deepEqual(s.spaces.spaces, beforeSpaces); assert.deepEqual(local.spaces, beforeDurableSpaces);
});

test('late-split release restoration reports persistence uncertainty and retries before reconciliation', async () => {
    const s = stores(); const added = await s.favorites.dispatch(req('addTab', { tabId: 1 }));
    const favoriteId = added.favorites.find(item => item.tabId === 1).id;
    const before = clone(session[FAVORITE_SESSION_KEY]); effects.length = 0; let injected = false;
    hooks.sessionSet = value => {
        const state = value[FAVORITE_SESSION_KEY]; if (!state) return;
        if (!state.bindings.some(entry => entry.tabId === 1)) { injected = true; tab(1).splitViewId = tab(2).splitViewId = 0; }
        else if (injected) throw new Error('Restore unavailable');
    };
    await assert.rejects(s.favorites.dispatch(req('releaseTab', { favoriteId, tabId: 1 })), error =>
        error.code === 'NATIVE_SPLIT_ACTIVE' && /Restoring Favorite ownership could not be confirmed/.test(error.message));
    assert.deepEqual(s.favorites.state, before); assert.equal(s.favorites.persistenceDirty, true);
    assert.equal(s.spaces.isGlobalTab(1), true); assert.deepEqual(effects, []);
    hooks.sessionSet = undefined;
    await s.favorites.dispatch(req('get'));
    assert.equal(s.favorites.persistenceDirty, false); assert.deepEqual(session[FAVORITE_SESSION_KEY], before);
    assert.equal(s.spaces.isGlobalTab(1), true); assert.equal(ownerOf(s.spaces.spaces, 1), undefined);
});

test('late-split release rollback never overwrites a newer exact-tab Favorite owner', async () => {
    local[FAVORITES_KEY].push(saved('newer'));
    const s = stores(); const added = await s.favorites.dispatch(req('addTab', { tabId: 1 }));
    const favoriteId = added.favorites.find(item => item.tabId === 1).id; effects.length = 0;
    const newer = { favoriteId: 'newer', windowId: 1, tabId: 1, mode: 'ordinary' };
    hooks.sessionSet = value => {
        const state = value[FAVORITE_SESSION_KEY];
        if (state && !state.bindings.some(entry => entry.tabId === 1)) {
            tab(1).splitViewId = tab(2).splitViewId = 0;
            s.favorites.state.bindings.push(clone(newer));
        }
    };
    await assert.rejects(s.favorites.dispatch(req('releaseTab', { favoriteId, tabId: 1 })), /End Split View/);
    assert.deepEqual(s.favorites.state.bindings, [newer]); assert.deepEqual(s.favorites.state.attempts, []); assert.deepEqual(effects, []);
});
