import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { FavoriteStore, FAVORITES_KEY, FAVORITE_SESSION_KEY, registerFavoriteMessages } from '../../favorite-store.js';
import { captureFavoriteIcon, favoriteIconCacheSize, MAX_FAVORITE_ICON_CACHE, FAVORITE_ICON_CACHE_KEY } from '../../favorite-icons.js';
import { pngIcon } from '../fixtures/favorite-icons.js';

// Actual worker module, Chrome API boundary mocks. No browser launched here.
const SELF = 'b'.repeat(32), URL = 'https://saved.test/';
const copy = value => structuredClone(value);
const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); }, emit(...args) { this.listeners.forEach(fn => fn(...copy(args))); } });
let local, session, tabs, windows, nodes, effects, nextId, hooks, spaceStore;
function storage(data, area) {
    return {
        async get(keys) { await hooks[`${area}BeforeGet`]?.(keys); return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, copy(data[key])])); },
        async set(value) {
            await hooks[`${area}BeforeSet`]?.(value);
            Object.assign(data, copy(value));
            await hooks[`${area}AfterSet`]?.(value);
        }
    };
}
function queueStore() {
    let chain = Promise.resolve();
    return { spaces: [{ id: 'space', bookmarkFolderId: 'folder', spaceBookmarks: [2], temporaryTabs: [1] }], active: { 1: 'space', 2: 'space' },
        run(fn) { const pending = chain.then(fn); chain = pending.catch(() => {}); return pending; },
        track(tab) { if (tab.pinned) for (const space of this.spaces) { space.spaceBookmarks = space.spaceBookmarks.filter(id => id !== tab.id); space.temporaryTabs = space.temporaryTabs.filter(id => id !== tab.id); } },
        async persist() { await hooks.persist?.(); }
    };
}
const request = (action, attrs = {}) => ({ type: 'favoriteStore', action, windowId: 1, ...attrs });
const bookmark = attrs => request('addBookmark', { spaceId: 'space', bookmarkFolderId: 'folder', bookmarkId: 'bookmark', parentId: 'nested', ...attrs });
const get = id => { const tab = tabs.find(tab => tab.id === id); if (!tab) throw new Error('No tab'); return tab; };
const creates = () => effects.filter(effect => effect[0] === 'create');
const updates = () => effects.filter(effect => effect[0] === 'update');
const storedIcon = (favoriteId = local[FAVORITES_KEY]?.[0]?.id) => local[FAVORITE_ICON_CACHE_KEY]?.entries?.find(entry => entry.favoriteId === favoriteId)?.faviconDataUrl;
const cacheEntry = (item, faviconDataUrl) => ({ favoriteId: item.id, url: item.url, faviconDataUrl });
const newStore = ({ install = true, ...options } = {}) => { const store = new FavoriteStore(spaceStore, options); if (install) store.install(); return store; };
const idle = async () => { for (let i = 0; i < 3; i++) await spaceStore.run(() => {}); };
const iconIdle = async store => {
    for (let i = 0; i < 100 && (store.iconJobs.size || store.activeIconJobs); i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(store.iconJobs.size, 0); assert.equal(store.activeIconJobs, 0); await idle();
};
async function added(store, input = bookmark()) { const result = await store.dispatch(input); return { result, favorite: result.favorites[0], tab: result.tab }; }
beforeEach(() => {
    local = { pinnedTabStatesById: { 2: { bookmarkId: 'bookmark', pinnedUrl: URL } } }; session = {};
    hooks = {}; effects = []; nextId = 100; spaceStore = queueStore();
    windows = [{ id: 1, type: 'normal' }, { id: 2, type: 'normal' }, { id: 3, type: 'popup' }, { id: 4, type: 'normal', incognito: true }];
    tabs = [{ id: 1, windowId: 1, url: URL, title: 'Unrelated twin', pinned: false }, { id: 2, windowId: 1, url: 'https://navigated.test/', title: 'Live saved tab', pinned: false },
        { id: 3, windowId: 1, url: URL, title: 'Native pin', pinned: true }];
    nodes = [{ id: 'root', title: 'Arcify' }, { id: 'folder', parentId: 'root', title: 'Space' }, { id: 'nested', parentId: 'folder', title: 'Nested' },
        { id: 'bookmark', parentId: 'nested', title: 'Saved title', url: URL }, { id: 'twin', parentId: 'nested', title: 'Twin title', url: URL }];
    globalThis.chrome = {
        runtime: { id: SELF, getURL: path => `chrome-extension://${SELF}/${path}`, onMessage: event() },
        storage: { local: storage(local, 'local'), session: storage(session, 'session') },
        windows: { async get(id) { const result = windows.find(window => window.id === id); if (!result) throw new Error('No window'); return copy(result); },
            async update(id, update) { effects.push(['focus', id, update]); return { ...windows.find(window => window.id === id), ...update }; } },
        tabs: { onRemoved: event(), onUpdated: event(), onReplaced: event(), onAttached: event(),
            async query(query) { await hooks.query?.(query); return copy(tabs.filter(tab => Object.entries(query).every(([key, value]) => tab[key] === value))); },
            async get(id) { await hooks.get?.(id); return copy(get(id)); },
            async create(options) { effects.push(['create', copy(options)]); await hooks.create?.(options); const tab = { id: nextId++, title: '', ...options }; tabs.push(tab); await hooks.created?.(tab); return copy(tab); },
            async update(id, update) { await hooks.update?.(id, update); effects.push(['update', id, copy(update)]); Object.assign(get(id), update); chrome.tabs.onUpdated.emit(id, update, get(id)); return copy(get(id)); }
        },
        bookmarks: { async search(query) { return copy(nodes.filter(node => node.title === query.title)); }, async get(id) { return copy(nodes.filter(node => node.id === id)); },
            async getChildren(id) { await hooks.bookmarks?.(id); return copy(nodes.filter(node => node.parentId === id)); } }
    };
});

test('saved bookmark creates independent durable Favorite, original tree untouched, and unbound pins remain visible', async () => {
    const before = copy(nodes), store = newStore();
    const { result, favorite, tab } = await added(store);
    assert.deepEqual(nodes, before);
    assert.equal(favorite.title, 'Saved title'); assert.equal(favorite.url, URL); assert.equal(favorite.sourceBookmarkId, 'bookmark');
    assert.equal(favorite.tabId, tab.id); assert.deepEqual(result.nativeTabs.map(tab => tab.id), [3]);
    assert.deepEqual(local[FAVORITES_KEY], [{ id: favorite.id, title: 'Saved title', url: URL, sourceBookmarkId: 'bookmark' }]);
    assert.deepEqual(creates(), [['create', { windowId: 1, url: URL, pinned: true, active: false }]]);
    assert.equal(local.pinnedTabStatesById[tab.id], undefined, 'No competing Utils identity');
});

test('simultaneous panels, repeat adds and opens create at most one exact instance per window', async () => {
    const store = newStore();
    const results = await Promise.all(Array.from({ length: 12 }, () => store.dispatch(bookmark())));
    const favoriteId = results[0].favorites[0].id;
    await Promise.all(Array.from({ length: 12 }, () => store.dispatch(request('open', { favoriteId }))));
    assert.equal(creates().length, 1); assert.equal(local[FAVORITES_KEY].length, 1);
    assert.equal(new Set(results.map(result => result.tab.id)).size, 1);
    const other = await store.dispatch(request('open', { favoriteId, windowId: 2 }));
    assert.equal(creates().length, 2); assert.notEqual(other.tab.id, results[0].tab.id);
    assert.equal(other.favorites[0].id, favoriteId);
});

test('duplicate bookmark URLs retain distinct Favorite IDs, tabs and provenance', async () => {
    const store = newStore();
    await store.dispatch(bookmark()); await store.dispatch(bookmark({ bookmarkId: 'twin' }));
    const { favorites } = await store.dispatch(request('get'));
    assert.equal(favorites.length, 2); assert.notEqual(favorites[0].id, favorites[1].id);
    assert.notEqual(favorites[0].tabId, favorites[1].tabId); assert.equal(creates().length, 2);
});

test('live saved bookmark adoption uses exact bookmark binding despite navigation and removes Space membership', async () => {
    const { favorite, tab } = await added(newStore(), bookmark({ tabId: 2 }));
    assert.equal(tab.id, 2); assert.equal(favorite.url, URL); assert.equal(favorite.title, 'Saved title');
    assert.equal(get(2).url, 'https://navigated.test/'); assert.equal(creates().length, 0);
    assert.deepEqual(spaceStore.spaces[0].spaceBookmarks, []);
});

test('native pins are never migrated by names or URLs; explicit adoption preserves duplicates and page navigation', async () => {
    nodes.push({ id: 'fake-favorites', title: 'Favorites', parentId: 'root' });
    const store = newStore();
    assert.deepEqual((await store.dispatch(request('get'))).favorites, []);
    const { favorite } = await added(store, request('addTab', { tabId: 3 }));
    assert.equal(favorite.sourceBookmarkId, null); assert.equal(favorite.tabId, 3); assert.equal(creates().length, 0);
    await store.dispatch(request('addTab', { tabId: 1 }));
    assert.equal(local[FAVORITES_KEY].length, 2);
    await store.dispatch(request('addTab', { tabId: 3 }));
    assert.equal(local[FAVORITES_KEY].length, 2);
});

test('Ctrl+W close removes only session binding, then click opens saved URL without modifying the bookmark', async () => {
    const store = newStore(), { favorite, tab } = await added(store);
    get(tab.id).url = 'https://away.test/'; get(tab.id).title = 'Away';
    tabs = tabs.filter(item => item.id !== tab.id); chrome.tabs.onRemoved.emit(tab.id, { isWindowClosing: false }); await idle();
    assert.equal((await store.dispatch(request('get'))).favorites[0].tabId, null);
    assert.equal(local[FAVORITES_KEY][0].url, URL); assert.equal(local[FAVORITES_KEY][0].title, 'Saved title');
    const result = await store.dispatch(request('open', { favoriteId: favorite.id }));
    assert.equal(result.tab.url, URL); assert.equal(result.tab.active, true); assert.equal(creates().length, 2);
    assert.equal(nodes.find(node => node.id === 'bookmark').url, URL);
});

test('window close keeps durable list and never opens tabs automatically', async () => {
    const store = newStore(), { tab } = await added(store);
    tabs = tabs.filter(item => item.windowId !== 1); chrome.tabs.onRemoved.emit(tab.id, { isWindowClosing: true }); await idle();
    assert.equal(local[FAVORITES_KEY].length, 1); assert.equal(creates().length, 1);
    assert.equal((await store.dispatch(request('get', { windowId: 2 }))).favorites[0].tabId, null);
});

test('worker recreation retains exact session binding while fresh browser session never guesses by tab ID or URL', async () => {
    const store = newStore({ install: false }), { favorite, tab } = await added(store);
    assert.equal((await newStore({ install: false }).dispatch(request('get'))).favorites[0].tabId, tab.id);
    for (const key of Object.keys(session)) delete session[key];
    // Even a reused same numeric tab ID and exact URL are insufficient after restart.
    const restarted = newStore({ install: false });
    const result = await restarted.dispatch(request('get'));
    assert.equal(result.favorites[0].id, favorite.id); assert.equal(result.favorites[0].tabId, null);
    assert(result.nativeTabs.some(item => item.id === tab.id)); assert.equal(creates().length, 1);
});

test('navigation, source movement, source edit and deletion never rewrite or remove saved link', async () => {
    const store = newStore(), { favorite, tab } = await added(store);
    Object.assign(get(tab.id), { url: 'https://elsewhere.test/', title: 'Elsewhere' }); chrome.tabs.onUpdated.emit(tab.id, { url: get(tab.id).url }, get(tab.id));
    Object.assign(nodes.find(node => node.id === 'bookmark'), { parentId: 'outside', title: 'Edited', url: 'https://edited.test/' });
    nodes = nodes.filter(node => node.id !== 'bookmark');
    const result = await store.dispatch(request('open', { favoriteId: favorite.id }));
    assert.equal(result.tab.id, tab.id); assert.equal(result.tab.url, 'https://elsewhere.test/');
    assert.equal(result.favorites[0].title, 'Saved title'); assert.equal(result.favorites[0].url, URL);
});

test('native unpin leaves ordinary page and saved Favorite; reopening creates a new exact instance', async () => {
    const store = newStore(), { favorite, tab } = await added(store);
    get(tab.id).pinned = false; chrome.tabs.onUpdated.emit(tab.id, { pinned: false }, get(tab.id)); await idle();
    assert.equal((await store.dispatch(request('get'))).favorites[0].tabId, null);
    const result = await store.dispatch(request('open', { favoriteId: favorite.id }));
    assert.notEqual(result.tab.id, tab.id); assert.equal(get(tab.id).pinned, false); assert.equal(creates().length, 2);
});

test('exact tab replacement and move rebind across windows without URL matching or tab mutation', async () => {
    const store = newStore(), { tab } = await added(store);
    get(tab.id).id = 500; chrome.tabs.onReplaced.emit(500, tab.id); await idle();
    assert.equal((await store.dispatch(request('get'))).favorites[0].tabId, 500);
    get(500).windowId = 2; chrome.tabs.onAttached.emit(500, { newWindowId: 2 }); await idle();
    assert.equal((await store.dispatch(request('get'))).favorites[0].tabId, null);
    assert.equal((await store.dispatch(request('get', { windowId: 2 }))).favorites[0].tabId, 500);
    assert.deepEqual(updates(), []);
});

test('moving into an occupied Favorite window keeps destination binding and exposes incoming native pin without merging', async () => {
    const store = newStore(), { favorite, tab } = await added(store);
    const second = await store.dispatch(request('open', { favoriteId: favorite.id, windowId: 2 }));
    const before = effects.length;
    get(tab.id).windowId = 2; chrome.tabs.onAttached.emit(tab.id, { newWindowId: 2 }); await idle();
    const result = await store.dispatch(request('get', { windowId: 2 }));
    assert.equal(result.favorites[0].tabId, second.tab.id); assert(result.nativeTabs.some(item => item.id === tab.id));
    assert.deepEqual(effects.slice(before), []); assert.equal(tabs.length, 5);
});

test('remove is profile-wide, unpins only exact known instances, leaves pages and original bookmarks open/intact', async () => {
    const store = newStore(), { favorite, tab } = await added(store), before = copy(nodes);
    const other = await store.dispatch(request('open', { favoriteId: favorite.id, windowId: 2 }));
    const count = tabs.length, effectsBefore = effects.length;
    const result = await store.dispatch(request('remove', { favoriteId: favorite.id }));
    assert.deepEqual(result.favorites, []); assert.equal(tabs.length, count); assert.deepEqual(nodes, before);
    assert.equal(get(tab.id).pinned, false); assert.equal(get(other.tab.id).pinned, false); assert.equal(get(3).pinned, true);
    assert.deepEqual(effects.slice(effectsBefore).map(effect => effect[0]), ['update', 'update']);
});

test('add and reorder use stable beforeId shared order; stale destinations never write or create', async () => {
    const store = newStore(), first = await added(store);
    const second = await store.dispatch(bookmark({ bookmarkId: 'twin', beforeId: first.favorite.id }));
    assert.deepEqual(second.favorites.map(favorite => favorite.sourceBookmarkId), ['twin', 'bookmark']);
    const order = await store.dispatch(request('reorder', { favoriteId: first.favorite.id, beforeId: second.favorites[0].id }));
    assert.deepEqual(order.favorites.map(favorite => favorite.sourceBookmarkId), ['bookmark', 'twin']);
    const before = copy(local[FAVORITES_KEY]);
    await assert.rejects(store.dispatch(request('addTab', { tabId: 1, beforeId: 'deleted' })), /destination/);
    assert.deepEqual(local[FAVORITES_KEY], before); assert.equal(creates().length, 2); assert.equal(get(1).pinned, false);
});

for (const alteration of ['parent', 'folder', 'active', 'binding', 'window']) test(`rejects stale ${alteration} source without tab mutations`, async () => {
    if (alteration === 'parent') nodes.find(node => node.id === 'bookmark').parentId = 'folder';
    if (alteration === 'folder') nodes.find(node => node.id === 'folder').parentId = 'outside';
    if (alteration === 'active') spaceStore.active[1] = 'elsewhere';
    if (alteration === 'binding') local.pinnedTabStatesById[2].bookmarkId = 'twin';
    if (alteration === 'window') get(2).windowId = 2;
    await assert.rejects(newStore().dispatch(bookmark({ tabId: 2 })));
    assert.deepEqual(effects, []);
});

test('failed pending-receipt storage blocks create, and shared queue recovers for later requests', async () => {
    const store = newStore(); hooks.sessionBeforeSet = () => { throw new Error('Storage offline'); };
    await assert.rejects(store.dispatch(bookmark()), /Storage offline/); assert.equal(creates().length, 0);
    hooks.sessionBeforeSet = undefined;
    // A failed write with no issued create can conservatively remain uncertain.
    assert.equal((await store.dispatch(request('get'))).favorites.length, 1);
});

test('uncertain create never retries across later request IDs or worker recreation', async () => {
    const store = newStore({ install: false }); hooks.create = () => { throw new Error('Chrome disconnected after request'); };
    await assert.rejects(store.dispatch(bookmark()), /Chrome disconnected/);
    hooks.create = undefined;
    await assert.rejects(store.dispatch(bookmark()), /could not be verified/);
    await assert.rejects(newStore({ install: false }).dispatch(bookmark()), /could not be verified/);
    assert.equal(creates().length, 1);
});

test('exact create receipt recovers after a later write failure without opening a duplicate', async () => {
    const store = newStore({ install: false });
    hooks.sessionBeforeSet = value => { if (value[FAVORITE_SESSION_KEY]?.bindings.length) throw new Error('Binding write failed'); };
    await assert.rejects(store.dispatch(bookmark()), /Binding write failed/);
    assert.equal(creates().length, 1); hooks.sessionBeforeSet = undefined;
    const result = await newStore({ install: false }).dispatch(bookmark());
    assert.equal(result.tab.id, 100); assert.equal(creates().length, 1);
});

test('a returned tab identity whose receipt write fails is retained in memory; restart blocks rather than duplicates', async () => {
    const store = newStore({ install: false });
    hooks.sessionBeforeSet = value => { if (value[FAVORITE_SESSION_KEY]?.attempts.some(attempt => attempt.tabId === 100)) throw new Error('Receipt write failed'); };
    await assert.rejects(store.dispatch(bookmark()), /Receipt write failed/); hooks.sessionBeforeSet = undefined;
    await assert.rejects(newStore({ install: false }).dispatch(bookmark()), /could not be verified/);
    const result = await store.dispatch(bookmark()); assert.equal(result.tab.id, 100); assert.equal(creates().length, 1);
});

test('explicit adoption receipt survives worker failure after pin so repeat add never duplicates saved records', async () => {
    const store = newStore({ install: false });
    hooks.sessionBeforeSet = value => { if (value[FAVORITE_SESSION_KEY]?.bindings.length) throw new Error('Interrupted adoption'); };
    await assert.rejects(store.dispatch(request('addTab', { tabId: 1 })), /Interrupted adoption/);
    hooks.sessionBeforeSet = undefined;
    const result = await newStore({ install: false }).dispatch(request('addTab', { tabId: 1 }));
    assert.equal(result.favorites.length, 1); assert.equal(result.tab.id, 1); assert.equal(creates().length, 0);
});

test('in-flight bookmark URL or membership changes after receipt preparation never open a tab', async () => {
    for (const change of ['url', 'parent']) {
        const store = newStore({ install: false });
        hooks.sessionAfterSet = value => { if (value[FAVORITE_SESSION_KEY]?.attempts.some(attempt => attempt.tabId === null)) {
            const bookmark = nodes.find(node => node.id === 'bookmark');
            if (change === 'url') bookmark.url = 'https://changed.test/'; else bookmark.parentId = 'outside';
        } };
        await assert.rejects(store.dispatch(bookmark()));
        assert.equal(creates().length, 0);
        nodes.find(node => node.id === 'bookmark').url = URL; nodes.find(node => node.id === 'bookmark').parentId = 'nested';
        hooks.sessionAfterSet = undefined;
    }
});

test('remove never closes pages even if native unpin fails', async () => {
    const store = newStore(), { favorite, tab } = await added(store);
    hooks.update = () => { throw new Error('Tab busy'); };
    const result = await store.dispatch(request('remove', { favoriteId: favorite.id }));
    assert.deepEqual(result.favorites, []); assert.match(result.warning, /could not be unpinned/); assert(get(tab.id).pinned);
});

for (const windowId of [3, 4, -1, 0, '1']) test(`rejects unauthorized window ${windowId} without saved or tab mutations`, async () => {
    await assert.rejects(newStore().dispatch(bookmark({ windowId })));
    assert.deepEqual(effects, []); assert.equal(local[FAVORITES_KEY], undefined);
});

for (const url of ['javascript:alert(1)', 'data:text/html,test', 'file:///tmp/private.txt', 'chrome://settings/', 'about:blank', `chrome-extension://${SELF}/startup-launcher.html`]) test(`rejects executable/helper Favorite source ${url}`, async () => {
    get(1).url = url;
    await assert.rejects(newStore().dispatch(request('addTab', { tabId: 1 })));
    assert.deepEqual(effects, []);
});

test('strict own-extension sender authentication rejects websites, peers, other tab windows and extra fields', async () => {
    const store = newStore(); registerFavoriteMessages(store);
    const listener = chrome.runtime.onMessage.listeners[0];
    const send = (message, sender) => new Promise(resolve => listener(message, sender, resolve));
    for (const sender of [{ id: 'a'.repeat(32) }, { id: SELF, url: 'https://evil.test/' }, { id: SELF, origin: 'https://evil.test' },
        { id: SELF, url: chrome.runtime.getURL('sidebar.html'), tab: { windowId: 2 } }]) {
        assert.equal((await send(bookmark(), sender)).code, 'UNAUTHORIZED');
    }
    assert.equal((await send({ ...bookmark(), url: 'https://injected.test/' }, { id: SELF })).code, 'INVALID_REQUEST');
    assert.deepEqual(effects, []);
    const accepted = await send(request('get'), { id: SELF, url: chrome.runtime.getURL('sidebar.html') });
    assert.equal(accepted.success, true);
});

test('malformed stored list fails closed without overwriting data, adopting pins or opening pages', async () => {
    local[FAVORITES_KEY] = [{ id: 'bad', url: 'javascript:alert(1)', title: 'Bad', sourceBookmarkId: null }];
    const before = copy(local);
    await assert.rejects(newStore().dispatch(request('get')), /could not be read/);
    assert.deepEqual(local, before); assert.deepEqual(effects, []);
});

test('explicit bookmark drop adopts exactly bound legacy native pin without URL dedup or a second page', async () => {
    local.pinnedTabStatesById[3] = { bookmarkId: 'bookmark', pinnedUrl: URL };
    get(3).url = 'https://legacy-navigated.test/';
    const { favorite, tab } = await added(newStore());
    assert.equal(tab.id, 3); assert.equal(favorite.sourceBookmarkId, 'bookmark'); assert.equal(favorite.url, URL);
    assert.equal(get(3).url, 'https://legacy-navigated.test/'); assert.equal(creates().length, 0);
});

test('explicit bookmark drop rejects multiple legacy native candidates or a conflicting live source before writes', async () => {
    local.pinnedTabStatesById[3] = { bookmarkId: 'bookmark', pinnedUrl: URL };
    const store = newStore();
    await assert.rejects(store.dispatch(bookmark({ tabId: 2 })), /another native Favorite/);
    tabs.push({ id: 4, windowId: 1, pinned: true, url: 'https://other.test/' });
    local.pinnedTabStatesById[4] = { bookmarkId: 'bookmark', pinnedUrl: URL };
    await assert.rejects(store.dispatch(bookmark()), /another native Favorite/);
    assert.equal(local[FAVORITES_KEY], undefined); assert.deepEqual(effects, []);
});

test('legacy candidate in another window or with missing exact binding is never inferred from URL', async () => {
    local.pinnedTabStatesById[3] = { bookmarkId: 'bookmark', pinnedUrl: URL }; get(3).windowId = 2;
    const { tab } = await added(newStore());
    assert.notEqual(tab.id, 3); assert.equal(creates().length, 1); assert.equal(get(3).windowId, 2);
});

test('legacy adoption revalidates exact source binding after durable record persistence', async () => {
    local.pinnedTabStatesById[3] = { bookmarkId: 'bookmark', pinnedUrl: URL };
    hooks.localAfterSet = value => { if (value[FAVORITES_KEY]) local.pinnedTabStatesById[3].bookmarkId = 'twin'; };
    await assert.rejects(newStore().dispatch(bookmark()), /no longer belongs/);
    assert.deepEqual(effects, []); assert.equal(get(3).pinned, true);
});

for (const change of ['closed', 'moved', 'unpinned']) test(`tab ${change} during binding persistence is never reported as a successful Favorite`, async () => {
    const store = newStore({ install: false });
    hooks.sessionAfterSet = value => {
        if (value[FAVORITE_SESSION_KEY]?.bindings.some(binding => binding.tabId === 100)) {
            if (change === 'closed') tabs = tabs.filter(tab => tab.id !== 100);
            if (change === 'moved') get(100).windowId = 2;
            if (change === 'unpinned') get(100).pinned = false;
        }
    };
    await assert.rejects(store.dispatch(bookmark()));
    assert.equal(creates().length, 1); assert.equal(local[FAVORITES_KEY].length, 1);
    assert.equal(nodes.find(node => node.id === 'bookmark').url, URL);
});

for (const change of ['closed', 'moved', 'binding', 'membership']) test(`live source ${change} after receipt preparation cannot be pinned or replaced`, async () => {
    hooks.sessionAfterSet = value => {
        if (value[FAVORITE_SESSION_KEY]?.attempts.some(attempt => attempt.kind === 'adopt')) {
            if (change === 'closed') tabs = tabs.filter(tab => tab.id !== 2);
            if (change === 'moved') get(2).windowId = 2;
            if (change === 'binding') local.pinnedTabStatesById[2].bookmarkId = 'twin';
            if (change === 'membership') spaceStore.spaces[0].spaceBookmarks = [];
        }
    };
    await assert.rejects(newStore().dispatch(bookmark({ tabId: 2 })));
    assert.deepEqual(effects, []);
});

test('closed source cannot steal or silently replace a nonnative exact binding in another Space', async () => {
    spaceStore.spaces[0].spaceBookmarks = [];
    spaceStore.spaces.push({ id: 'another', spaceBookmarks: [2], temporaryTabs: [] });
    await assert.rejects(newStore().dispatch(bookmark()), /another Space/);
    assert.deepEqual(effects, []); assert.equal(local[FAVORITES_KEY], undefined);
});

test('bookmark changed immediately after create keeps the exact new page and reports stale source without destructive rollback', async () => {
    hooks.created = () => { nodes.find(node => node.id === 'bookmark').parentId = 'outside'; };
    await assert.rejects(newStore().dispatch(bookmark()), /saved bookmark changed/);
    assert.equal(creates().length, 1); assert.equal(get(100).pinned, true); assert.equal(local[FAVORITES_KEY][0].url, URL);
    assert.equal(nodes.find(node => node.id === 'bookmark').parentId, 'outside');
});

test('a failed exact get cannot prove closure or authorize a duplicate create', async () => {
    const store = newStore(), { favorite, tab } = await added(store);
    hooks.get = id => { if (id === tab.id) throw new Error('Temporary lookup failure'); };
    await assert.rejects(store.dispatch(request('open', { favoriteId: favorite.id })), /lookup failure/);
    assert.equal(creates().length, 1);
    hooks.get = undefined; tabs = tabs.filter(item => item.id !== tab.id);
    const opened = await store.dispatch(request('open', { favoriteId: favorite.id }));
    assert.notEqual(opened.tab.id, tab.id); assert.equal(creates().length, 2);
});

test('partial create for saved URL A never relinks its Favorite to edited source URL B', async () => {
    const store = newStore({ install: false });
    hooks.sessionBeforeSet = value => { if (value[FAVORITE_SESSION_KEY]?.bindings.length) throw new Error('Binding interrupted'); };
    await assert.rejects(store.dispatch(bookmark()), /Binding interrupted/); hooks.sessionBeforeSet = undefined;
    nodes.find(node => node.id === 'bookmark').url = 'https://new-source.test/';
    const recovered = await newStore({ install: false }).dispatch(bookmark());
    assert.equal(recovered.favorites[0].url, URL); assert.equal(recovered.tab.url, URL); assert.equal(creates().length, 1);
});

test('fresh bookmark URL fetched before durable commit wins over an old sidebar URL', async () => {
    let changed = false;
    hooks.bookmarks = id => { if (id === 'folder' && !changed) { changed = true; nodes.find(node => node.id === 'bookmark').url = 'https://fresh.test/'; } };
    const { favorite, tab } = await added(newStore());
    assert.equal(favorite.url, 'https://fresh.test/'); assert.equal(tab.url, 'https://fresh.test/');
});

test('bookmark deleted during asynchronous source lookup cannot commit or create a Favorite', async () => {
    hooks.bookmarks = id => { if (id === 'nested') nodes = nodes.filter(node => node.id !== 'bookmark'); };
    await assert.rejects(newStore().dispatch(bookmark()), /saved bookmark changed/);
    assert.deepEqual(effects, []); assert.equal(local[FAVORITES_KEY], undefined);
});

test('completed saved ownership survives loss of legacy Utils provenance without duplicate adoption', async () => {
    local.pinnedTabStatesById[3] = { bookmarkId: 'bookmark', pinnedUrl: URL };
    const store = newStore({ install: false }), { favorite } = await added(store);
    local.pinnedTabStatesById = {};
    const result = await newStore({ install: false }).dispatch(bookmark());
    assert.equal(result.tab.id, 3); assert.equal(result.favorites[0].id, favorite.id);
    assert.equal(result.favorites.length, 1); assert.equal(creates().length, 0);
});

test('a moved exact instance replaces an absent destination binding without treating a closed tab as a conflict', async () => {
    const store = newStore({ install: false }), { favorite, tab } = await added(store);
    const second = await store.dispatch(request('open', { favoriteId: favorite.id, windowId: 2 }));
    tabs = tabs.filter(item => item.id !== second.tab.id); // Simulate worker suspension missing a close event.
    get(tab.id).windowId = 2;
    const result = await store.dispatch(request('get', { windowId: 2 }));
    assert.equal(result.favorites[0].tabId, tab.id);
    assert.equal(result.nativeTabs.some(item => item.id === tab.id), false);
});

for (const receipt of [{ tabId: null, url: URL }, { tabId: 3, url: URL }, { tabId: 3, url: URL, complete: true }]) {
    test(`upgrade preserves unresolved legacy receipt ${JSON.stringify(receipt)} without duplicate create`, async () => {
        const receiptKey = JSON.stringify([1, 'bookmark']);
        session.favoriteDropAttempts = { [receiptKey]: receipt };
        for (let i = 0; i < 2; i++) await assert.rejects(newStore({ install: false }).dispatch(bookmark()), /earlier Favorite/);
        assert.deepEqual(session.favoriteDropAttempts, { [receiptKey]: receipt });
        assert.deepEqual(effects, []); assert.equal(local[FAVORITES_KEY], undefined);
    });
}

test('upgrade adopts a complete legacy receipt only with fresh exact current-window bookmark binding', async () => {
    session.favoriteDropAttempts = { [JSON.stringify([1, 'bookmark'])]: { tabId: 3, url: URL, complete: true } };
    local.pinnedTabStatesById[3] = { bookmarkId: 'bookmark', pinnedUrl: URL };
    const { favorite, tab } = await added(newStore());
    assert.equal(tab.id, 3); assert.equal(favorite.sourceBookmarkId, 'bookmark'); assert.equal(creates().length, 0);
});

test('upgrade allows a new Favorite only after fresh all-window absence proves a known old receipt closed', async () => {
    session.favoriteDropAttempts = { [JSON.stringify([1, 'bookmark'])]: { tabId: 999, url: URL } };
    const { tab } = await added(newStore());
    assert.equal(tab.id, 100); assert.equal(creates().length, 1);
    assert.equal(session.favoriteDropAttempts[JSON.stringify([1, 'bookmark'])].tabId, 999);
});

for (const change of ['moved', 'unpinned', 'url-changed', 'conflicting-binding']) test(`upgrade refuses legacy receipt ${change} without tab mutation`, async () => {
    session.favoriteDropAttempts = { [JSON.stringify([1, 'bookmark'])]: { tabId: 3, url: URL, complete: true } };
    local.pinnedTabStatesById[3] = { bookmarkId: 'bookmark', pinnedUrl: URL };
    if (change === 'moved') get(3).windowId = 2;
    if (change === 'unpinned') get(3).pinned = false;
    if (change === 'url-changed') nodes.find(node => node.id === 'bookmark').url = 'https://edited.test/';
    if (change === 'conflicting-binding') local.pinnedTabStatesById[3].bookmarkId = 'twin';
    await assert.rejects(newStore().dispatch(bookmark()), /earlier Favorite/);
    assert.deepEqual(effects, []); assert.equal(local[FAVORITES_KEY], undefined);
});

for (const change of ['moved', 'closed', 'unpinned']) test(`verified legacy receipt ${change} between all-window and scoped queries never authorizes a replacement`, async () => {
    session.favoriteDropAttempts = { [JSON.stringify([1, 'bookmark'])]: { tabId: 3, url: URL, complete: true } };
    local.pinnedTabStatesById[3] = { bookmarkId: 'bookmark', pinnedUrl: URL };
    hooks.query = query => {
        if (query.windowId === 1) {
            if (change === 'moved') get(3).windowId = 2;
            if (change === 'closed') tabs = tabs.filter(tab => tab.id !== 3);
            if (change === 'unpinned') { get(3).pinned = false; spaceStore.spaces[0].temporaryTabs.push(3); }
        }
    };
    await assert.rejects(newStore().dispatch(bookmark()));
    assert.equal(creates().length, 0); assert.equal(local[FAVORITES_KEY], undefined);
});

test('captured Favorite PNG survives close, worker recreation and fresh browser session without another lookup', async () => {
    const icon = pngIcon(), calls = [];
    get(3).favIconUrl = icon;
    const store = newStore({ captureIcon: async (url, options) => { calls.push({ url, ...options }); return options.dataUrl; } });
    const { favorite } = await added(store, request('addTab', { tabId: 3 })); await iconIdle(store);
    assert.deepEqual(calls, [{ url: URL, dataUrl: icon }]); assert.equal(storedIcon(), icon);
    tabs = tabs.filter(tab => tab.id !== 3); chrome.tabs.onRemoved.emit(3); await idle();
    assert.equal((await store.dispatch(request('get'))).favorites[0].faviconDataUrl, icon);
    for (const key of Object.keys(session)) delete session[key];
    const restarted = newStore({ captureIcon() { throw Error('retained icons need no fetch'); } });
    const record = (await restarted.dispatch(request('get'))).favorites[0];
    assert.equal(record.id, favorite.id); assert.equal(record.tabId, null); assert.equal(record.faviconDataUrl, icon);
    assert.equal(creates().length, 0);
});

test('navigated saved bookmark cannot donate its current-page icon; capture uses the immutable saved URL', async () => {
    const icon = pngIcon(), wrong = pngIcon({ red: 200 }), calls = [];
    get(2).favIconUrl = wrong;
    const store = newStore({ captureIcon: async (url, options) => { calls.push({ url, ...options }); return icon; } });
    await added(store, bookmark({ tabId: 2 })); await iconIdle(store);
    assert.deepEqual(calls, [{ url: URL, dataUrl: undefined }]);
    assert.equal(storedIcon(), icon); assert.equal(local[FAVORITES_KEY][0].title, 'Saved title');
    assert.equal(get(2).url, 'https://navigated.test/');
});

test('bound saved-page icon changes refresh safely; unrelated navigation and pending navigation preserve saved bytes', async () => {
    const first = pngIcon(), second = pngIcon({ red: 200 }), calls = [];
    const store = newStore({ captureIcon: async (url, options) => { calls.push({ url, ...options }); return options.dataUrl || first; } });
    const { tab } = await added(store); await iconIdle(store);
    for (const patch of [{ url: 'https://elsewhere.test/' }, { url: `${URL}?other=true` }, { url: URL, pendingUrl: 'https://away.test/' }]) {
        Object.assign(get(tab.id), patch, { favIconUrl: second });
        chrome.tabs.onUpdated.emit(tab.id, { favIconUrl: second, status: 'complete' }); await idle(); await iconIdle(store);
        assert.equal(storedIcon(), first);
    }
    assert.equal(calls.length, 1);
    Object.assign(get(tab.id), { url: URL, pendingUrl: undefined, favIconUrl: second });
    chrome.tabs.onUpdated.emit(tab.id, { favIconUrl: second }); await idle(); await iconIdle(store);
    assert.equal(storedIcon(), second); assert.equal(calls.length, 2);
    assert.equal(local[FAVORITES_KEY][0].url, URL); assert.equal(local[FAVORITES_KEY][0].title, 'Saved title');
});

test('older async icon result cannot overwrite a newer capture even when it finishes last', async () => {
    const tasks = [], old = pngIcon(), latest = pngIcon({ red: 220 });
    const store = newStore({ captureIcon: () => new Promise(resolve => tasks.push(resolve)) });
    const { tab } = await added(store); assert.equal(tasks.length, 1);
    chrome.tabs.onUpdated.emit(tab.id, { favIconUrl: 'https://saved.test/new.png' }); await idle();
    assert.equal(tasks.length, 2); tasks[1](latest); await idle();
    tasks[0](old); await iconIdle(store);
    assert.equal(storedIcon(), latest);
});

test('empty favicon signals and unavailable cache preserve a previously retained icon on page completion', async () => {
    const icon = pngIcon(), generic = pngIcon({ red: 90 }); let captures = 0;
    const store = newStore({ captureIcon: async () => ++captures === 1 ? icon : generic });
    const { tab } = await added(store); await iconIdle(store);
    get(tab.id).favIconUrl = '';
    chrome.tabs.onUpdated.emit(tab.id, { status: 'complete' }); await idle(); await iconIdle(store);
    get(tab.id).favIconUrl = 'https://saved.test/icon.png';
    chrome.tabs.onUpdated.emit(tab.id, { favIconUrl: '' }); await idle(); await iconIdle(store);
    assert.equal(captures, 1); assert.equal(storedIcon(), icon);
    store.captureIcon = async () => { captures++; return null; };
    chrome.tabs.onUpdated.emit(tab.id, { status: 'complete' }); await idle(); await iconIdle(store);
    assert.equal(captures, 2); assert.equal(storedIcon(), icon);
});

test('real cache capture rejects Chrome generic PNG even with nonempty live favicon URL, preserving retained bytes', async () => {
    const icon = pngIcon(), generic = pngIcon({ red: 90 }), urls = [];
    const store = newStore({ captureIcon: async () => icon });
    const { tab } = await added(store); await iconIdle(store);
    store.captureIcon = (url, options) => captureFavoriteIcon(url, { ...options, fetchIcon: async cacheUrl => {
        urls.push(cacheUrl); return new Response(Buffer.from(generic.split(',')[1], 'base64'), { headers: { 'content-type': 'image/bmp' } });
    } });
    get(tab.id).favIconUrl = 'https://saved.test/actual-icon.png';
    chrome.tabs.onUpdated.emit(tab.id, { status: 'complete' }); await idle(); await iconIdle(store);
    assert.equal(urls.length, 2); assert(urls.every(url => new globalThis.URL(url).protocol === 'chrome-extension:'));
    assert.equal(storedIcon(), icon);
});

test('late icon cannot resurrect a removed Favorite or overwrite the current shared order and additions', async () => {
    const tasks = [], icon = pngIcon();
    const store = newStore({ captureIcon: () => new Promise(resolve => tasks.push(resolve)) });
    const one = await added(store); const two = await store.dispatch(bookmark({ bookmarkId: 'twin' }));
    await store.dispatch(request('reorder', { favoriteId: two.favorites[1].id, beforeId: one.favorite.id }));
    tasks[0](icon); await idle();
    assert.deepEqual(local[FAVORITES_KEY].map(item => item.sourceBookmarkId), ['twin', 'bookmark']);
    await store.dispatch(request('remove', { favoriteId: two.favorites[1].id }));
    tasks[1](icon); await iconIdle(store);
    assert.deepEqual(local[FAVORITES_KEY].map(item => item.id), [one.favorite.id]);
    assert.equal(storedIcon(), icon);
});

test('legacy closed Favorites backfill locally without opening tabs, with cooldown on unavailable cache', async () => {
    local[FAVORITES_KEY] = [{ id: 'old', title: 'Old', url: URL, sourceBookmarkId: null }];
    let now = 100, calls = 0;
    const store = newStore({ now: () => now, captureIcon: async () => ++calls === 1 ? null : pngIcon() });
    assert.equal((await store.dispatch(request('get'))).favorites[0].tabId, null); await iconIdle(store);
    await store.dispatch(request('get')); await iconIdle(store); assert.equal(calls, 1);
    now += 60000; await store.dispatch(request('get')); await iconIdle(store);
    assert.equal(calls, 2); assert.equal(storedIcon(), pngIcon());
    assert.equal(creates().length, 0); assert.equal(updates().length, 0);
});

test('bad auxiliary icon metadata is discarded without making a valid Favorite inaccessible or mutating its link', async () => {
    for (const icon of [null, {}, 42, 'https://tracker.test/favicon', 'data:image/svg+xml,<svg/>', 'data:image/png;base64,garbage', pngIcon({ width: 129 })]) {
        local[FAVORITES_KEY] = [{ id: 'old', title: 'Old', url: URL, sourceBookmarkId: null }];
        local[FAVORITE_ICON_CACHE_KEY] = { version: 1, entries: [cacheEntry(local[FAVORITES_KEY][0], icon)] };
        const before = copy(local[FAVORITES_KEY]), store = newStore({ install: false, captureIcon: async () => null });
        const response = await store.dispatch(request('get')); await iconIdle(store);
        assert.equal(response.favorites[0].faviconDataUrl, undefined); assert.equal(response.favorites[0].url, URL);
        assert.deepEqual(local[FAVORITES_KEY], before, 'read must not eagerly rewrite valid saved links');
    }
});

test('cache and icon-write failures never fail a Favorite operation or discard previously retained bytes', async () => {
    const icon = pngIcon();
    const store = newStore({ captureIcon: async () => { throw Error('cache denied'); } });
    const { favorite } = await added(store); await iconIdle(store);
    assert.equal((await store.dispatch(request('open', { favoriteId: favorite.id }))).tab.id, favorite.tabId);
    store.captureIcon = async () => icon;
    hooks.localBeforeSet = value => { if (value[FAVORITE_ICON_CACHE_KEY]) throw Error('quota'); };
    chrome.tabs.onUpdated.emit(favorite.tabId, { status: 'complete' }); await idle(); await iconIdle(store);
    assert.equal(local[FAVORITES_KEY][0].id, favorite.id); assert.equal(storedIcon(), undefined); assert.equal(store.initialized, true);
    hooks.localBeforeSet = null;
    assert.equal((await store.dispatch(request('open', { favoriteId: favorite.id }))).tab.id, favorite.tabId);
});

test('four-capture concurrency bound, cache budget and corrupt excess cache never block the saved list', async () => {
    const icon = pngIcon({ extra: [['tEXt', Buffer.alloc(14000, 65)]] }), count = Math.floor(MAX_FAVORITE_ICON_CACHE / icon.length) + 3;
    local[FAVORITES_KEY] = Array.from({ length: count }, (_, n) => ({ id: `saved-${n}`, title: 'Saved', url: URL, sourceBookmarkId: null }));
    local[FAVORITE_ICON_CACHE_KEY] = { version: 1, entries: local[FAVORITES_KEY].map(item => cacheEntry(item, icon)) };
    const releases = [], store = newStore({ captureIcon: () => new Promise(resolve => releases.push(resolve)) });
    const result = await store.dispatch(request('get'));
    assert.equal(result.favorites.length, count);
    assert(favoriteIconCacheSize([...store.icons.values()]) <= MAX_FAVORITE_ICON_CACHE);
    assert(releases.length <= 4); releases.splice(0).forEach(resolve => resolve(icon)); await iconIdle(store);
    assert.equal(store.items.filter(item => !store.icon(item)).length, 3);
    // A large legacy list must not launch unbounded fetches at once.
    local[FAVORITES_KEY] = Array.from({ length: 10 }, (_, n) => ({ id: `missing-${n}`, title: 'Saved', url: URL, sourceBookmarkId: null }));
    const many = newStore({ install: false, captureIcon: () => new Promise(resolve => releases.push(resolve)) });
    await many.dispatch(request('get')); assert.equal(many.activeIconJobs, 4); assert.equal(releases.length, 4);
    while (many.iconJobs.size) { releases.splice(0).forEach(resolve => resolve(null)); await new Promise(resolve => setImmediate(resolve)); }
    await iconIdle(many); assert.equal(creates().length, 0);
});

test('untrusted Favorite request cannot inject cached icon bytes', async () => {
    await assert.rejects(newStore().dispatch({ ...request('addTab', { tabId: 3 }), faviconDataUrl: pngIcon() }), { code: 'INVALID_REQUEST' });
    assert.equal(local[FAVORITES_KEY], undefined); assert.equal(updates().length, 0);
});

test('icon capture writes only auxiliary cache and keeps exact original four-key durable record schema', async () => {
    let release;
    const store = newStore({ captureIcon: () => new Promise(resolve => { release = resolve; }) });
    const { favorite } = await added(store);
    const original = copy(local[FAVORITES_KEY]), writes = [];
    hooks.localBeforeSet = patch => writes.push(copy(patch));
    release(pngIcon()); await iconIdle(store);
    assert.deepEqual(local[FAVORITES_KEY], original);
    assert.deepEqual(Object.keys(original[0]).sort(), ['id', 'sourceBookmarkId', 'title', 'url']);
    assert.deepEqual(writes.map(patch => Object.keys(patch)), [[FAVORITE_ICON_CACHE_KEY]]);
    assert.deepEqual(local[FAVORITE_ICON_CACHE_KEY], { version: 1, entries: [{ favoriteId: favorite.id, url: URL, faviconDataUrl: pngIcon() }] });
    assert.equal((await store.dispatch(request('get'))).favorites[0].faviconDataUrl, pngIcon());
    await store.dispatch(request('reorder', { favoriteId: favorite.id, beforeId: null }));
    assert.deepEqual(local[FAVORITES_KEY], original);
});

test('rollback-style registry reorder retains ID icons while deletion, replacement ID and exact URL changes cannot borrow cache', async () => {
    const one = { id: 'one', title: 'One', url: URL, sourceBookmarkId: null };
    const two = { id: 'two', title: 'Two', url: 'https://two.test/', sourceBookmarkId: null };
    const first = pngIcon(), second = pngIcon({ red: 210 });
    local[FAVORITE_ICON_CACHE_KEY] = { version: 1, entries: [cacheEntry(one, first), cacheEntry(two, second)] };
    local[FAVORITES_KEY] = [two, one];
    const reordered = newStore({ install: false, captureIcon: async () => null });
    assert.deepEqual((await reordered.dispatch(request('get'))).favorites.map(item => [item.id, item.faviconDataUrl]), [['two', second], ['one', first]]);
    local[FAVORITES_KEY] = [{ ...one, id: 'replacement' }, { ...two, url: `${two.url}?changed=1` }];
    const changed = newStore({ install: false, captureIcon: async () => null });
    assert((await changed.dispatch(request('get'))).favorites.every(item => item.faviconDataUrl === undefined)); await iconIdle(changed);
    assert.equal(changed.icons.size, 0); assert.equal(local[FAVORITE_ICON_CACHE_KEY].entries.length, 2, 'read only ignores on-disk orphan entries');
});

test('malformed auxiliary cache envelopes and read failures never block link read or open', async () => {
    local[FAVORITES_KEY] = [{ id: 'old', title: 'Old', url: URL, sourceBookmarkId: null }];
    for (const value of [null, [], 'bad', { version: 2, entries: [] }, { version: 1, entries: {} }, { version: 1, entries: [], unexpected: true },
        { version: 1, entries: [null, 3, [], { favoriteId: 'old', url: URL, faviconDataUrl: pngIcon(), extra: true }] }]) {
        local[FAVORITE_ICON_CACHE_KEY] = value;
        const store = newStore({ install: false, captureIcon: async () => null });
        assert.equal((await store.dispatch(request('get'))).favorites[0].id, 'old'); await iconIdle(store);
        assert.equal(store.icons.size, 0); assert.equal(store.initialized, true);
    }
    hooks.localBeforeGet = keys => { if (keys === FAVORITE_ICON_CACHE_KEY) throw Error('auxiliary cache unavailable'); };
    const store = newStore({ install: false, captureIcon: async () => null });
    assert.equal((await store.dispatch(request('open', { favoriteId: 'old' }))).tab.url, URL); await iconIdle(store);
    assert.equal(store.initialized, true);
});

test('remove succeeds despite auxiliary cleanup failure and orphan bytes never reappear after restart or late capture', async () => {
    const icon = pngIcon();
    const store = newStore({ captureIcon: async () => icon });
    const { favorite, tab } = await added(store); await iconIdle(store);
    let release;
    store.captureIcon = () => new Promise(resolve => { release = resolve; });
    get(tab.id).favIconUrl = 'https://saved.test/updated.png'; chrome.tabs.onUpdated.emit(tab.id, { favIconUrl: get(tab.id).favIconUrl }); await idle();
    hooks.localBeforeSet = patch => { if (patch[FAVORITE_ICON_CACHE_KEY]) throw Error('cache cleanup unavailable'); };
    const removed = await store.dispatch(request('remove', { favoriteId: favorite.id }));
    assert.deepEqual(removed.favorites, []); assert.deepEqual(local[FAVORITES_KEY], []); assert.equal(get(tab.id).pinned, false);
    assert.equal(store.icons.size, 0); assert.equal(store.initialized, true); assert.equal(storedIcon(favorite.id), icon);
    release(pngIcon({ red: 190 })); await iconIdle(store);
    const restarted = newStore({ install: false, captureIcon: async () => null });
    assert.deepEqual((await restarted.dispatch(request('get'))).favorites, []); assert.equal(restarted.icons.size, 0);
    assert.equal(storedIcon(favorite.id), icon, 'failed disk cleanup is ignored, never attached to an absent Favorite');
});

test('orphan and mismatched cache bytes consume no live cache budget; metadata is included in the storage bound', async () => {
    const live = { id: 'live', title: 'Live', url: URL, sourceBookmarkId: null }, icon = pngIcon();
    local[FAVORITES_KEY] = [live];
    local[FAVORITE_ICON_CACHE_KEY] = { version: 1, entries: [
        { favoriteId: 'deleted', url: URL, faviconDataUrl: 'x'.repeat(MAX_FAVORITE_ICON_CACHE) },
        { favoriteId: live.id, url: 'https://other.test/', faviconDataUrl: icon }, cacheEntry(live, icon)] };
    const store = newStore({ install: false, captureIcon: async () => null });
    assert.equal((await store.dispatch(request('get'))).favorites[0].faviconDataUrl, icon); assert.equal(store.icons.size, 1);
    assert(favoriteIconCacheSize([...store.icons.values()]) > icon.length, 'identity, URL and envelope count toward budget');
    assert.deepEqual(local[FAVORITES_KEY], [live]);
});
