import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { FavoriteStore, FAVORITES_KEY, FAVORITE_SESSION_KEY, MAX_FAVORITE_BOOKMARK_BATCH, validateFavoriteRequest, registerFavoriteMessages } from '../../favorite-store.js';
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
        windows: { async get(id) { await hooks.window?.(id); const result = windows.find(window => window.id === id); if (!result) throw new Error('No window'); return copy(result); },
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


// Batch drops exercise the real sole-writer module with the same Chrome API
// boundary as single-item tests. Selection is bounded, exact-ID, and one Space.
const batchBookmark = (bookmarkId, attrs = {}) => ({ bookmarkId, parentId: 'nested', ...attrs });
const batchRequest = (bookmarks = ['bookmark', 'twin'].map(id => batchBookmark(id)), attrs = {}) => request('addBookmarks', {
    spaceId: 'space', bookmarkFolderId: 'folder', beforeId: null, bookmarks, ...attrs
});
const addBatchNodes = (...ids) => nodes.push(...ids.map(id => ({ id, parentId: 'nested', title: id, url: `https://${id}.test/` })));
const batchError = async promise => {
    try { await promise; assert.fail('The batch should have failed'); }
    catch (error) { assert(error.batch, error.message); return error; }
};
const batchStatuses = error => error.batch.entries.map(entry => entry.status);

test('bounded strict batch schema rejects malformed, duplicate, injected, and non-bookmark entries', () => {
    const valid = batchRequest();
    for (const bookmarks of [undefined, null, {}, [], [null], ['bookmark'], [[]], Array(2),
        [batchBookmark('bookmark'), batchBookmark('bookmark')],
        [batchBookmark('bookmark', { tabId: 2 }), batchBookmark('twin', { tabId: 2 })],
        [batchBookmark('bookmark', { url: URL })], [batchBookmark('bookmark', { title: 'Injected' })],
        [batchBookmark('bookmark', { sourceBookmarkId: 'twin' })], [batchBookmark('bookmark', { requireNativePin: true })],
        [batchBookmark('bookmark', { tabId: 0 })], [batchBookmark('bookmark', { tabId: '2' })],
        [batchBookmark('bookmark', { tabId: null })], [batchBookmark('bookmark', { parentId: '' })],
        [batchBookmark('x'.repeat(201))], Array.from({ length: 101 }, (_, i) => batchBookmark(String(i)))]) {
        assert.throws(() => validateFavoriteRequest({ ...valid, bookmarks }), { code: 'INVALID_REQUEST' });
    }
    for (const patch of [{ beforeId: undefined }, { beforeId: '' }, { spaceId: '' }, { bookmarkFolderId: '' },
        { tabId: 2 }, { bookmarkId: 'bookmark' }, { url: URL }, { windowId: 2.5 }]) {
        assert.throws(() => validateFavoriteRequest({ ...valid, ...patch }), { code: 'INVALID_REQUEST' });
    }
    assert.equal(MAX_FAVORITE_BOOKMARK_BATCH, 100);
    assert.doesNotThrow(() => validateFavoriteRequest(batchRequest(Array.from({ length: 100 }, (_, i) => batchBookmark(String(i))))));
    assert.deepEqual(effects, []); assert.equal(local[FAVORITES_KEY], undefined);
});

test('batch preserves exact same-URL identities, requested order, source tree, inactive native pins and four-key records', async () => {
    const before = copy(nodes), store = newStore({ captureIcon: async () => null });
    const result = await store.dispatch(batchRequest(['twin', 'bookmark'].map(id => batchBookmark(id))));
    assert.equal(result.batch.complete, true);
    assert.deepEqual(result.batch.entries.map(entry => entry.status), ['completed', 'completed']);
    assert.deepEqual(result.favorites.map(item => item.sourceBookmarkId), ['twin', 'bookmark']);
    assert.deepEqual(result.batch.entries.map(entry => entry.favoriteId), result.favorites.map(item => item.id));
    assert.deepEqual(result.batch.entries.map(entry => entry.tabId), [100, 101]);
    assert.equal(new Set(result.favorites.map(item => item.id)).size, 2);
    assert.deepEqual(creates().map(effect => effect[1]), [100, 101].map(() => ({ windowId: 1, url: URL, pinned: true, active: false })));
    assert.deepEqual(updates(), []); assert.deepEqual(nodes, before);
    assert.equal(get(1).pinned, false); assert.equal(get(3).pinned, true);
    for (const item of local[FAVORITES_KEY]) assert.deepEqual(Object.keys(item).sort(), ['id', 'sourceBookmarkId', 'title', 'url']);
});

test('mixed live and closed bookmark batch adopts the exact navigated live tab without resetting or activating it', async () => {
    const before = copy(nodes), store = newStore({ captureIcon: async () => null });
    const result = await store.dispatch(batchRequest([batchBookmark('bookmark', { tabId: 2 }), batchBookmark('twin')]));
    assert.deepEqual(result.batch.entries.map(entry => entry.tabId), [2, 100]);
    assert.equal(creates().length, 1); assert.deepEqual(updates(), [['update', 2, { pinned: true }]]);
    assert.equal(get(2).url, 'https://navigated.test/'); assert.deepEqual(spaceStore.spaces[0].spaceBookmarks, []);
    assert.deepEqual(nodes, before); assert.deepEqual(effects.filter(effect => effect[0] === 'focus'), []);
});

for (const [selected, anchor, expected] of [
    [['third', 'bookmark'], 'bookmark', ['third', 'bookmark', 'twin', 'fourth']],
    [['fourth', 'twin'], 'twin', ['bookmark', 'fourth', 'twin', 'third']],
    [['third', 'bookmark'], 'fourth', ['twin', 'third', 'bookmark', 'fourth']],
    [['fourth', 'bookmark'], null, ['twin', 'third', 'fourth', 'bookmark']],
    [['fourth', 'third'], 'fourth', ['bookmark', 'twin', 'fourth', 'third']],
    [['fourth', 'third', 'twin', 'bookmark'], 'third', ['fourth', 'third', 'twin', 'bookmark']]
]) test(`batch fixed anchor ${anchor} preserves exact selection order ${selected}`, async () => {
    addBatchNodes('third', 'fourth'); const store = newStore({ captureIcon: async () => null });
    for (const bookmarkId of ['bookmark', 'twin', 'third', 'fourth']) await store.dispatch(bookmark({ bookmarkId }));
    const ids = new Map(local[FAVORITES_KEY].map(item => [item.sourceBookmarkId, item.id]));
    const before = copy(nodes), result = await store.dispatch(batchRequest(selected.map(id => batchBookmark(id)), { beforeId: anchor && ids.get(anchor) }));
    assert.deepEqual(result.favorites.map(item => item.sourceBookmarkId), expected);
    assert.equal(creates().length, 4); assert.deepEqual(nodes, before);
    assert.deepEqual(result.batch.entries.map(entry => entry.favoriteId), selected.map(id => ids.get(id)));
});

test('batch interleaves new and already-saved entries into one stable ordered block', async () => {
    addBatchNodes('third', 'fourth', 'fifth'); const store = newStore({ captureIcon: async () => null });
    for (const bookmarkId of ['bookmark', 'third', 'fifth']) await store.dispatch(bookmark({ bookmarkId }));
    const anchor = local[FAVORITES_KEY].find(item => item.sourceBookmarkId === 'third').id;
    const result = await store.dispatch(batchRequest(['fourth', 'bookmark', 'twin'].map(id => batchBookmark(id)), { beforeId: anchor }));
    assert.deepEqual(result.favorites.map(item => item.sourceBookmarkId), ['fourth', 'bookmark', 'twin', 'third', 'fifth']);
    assert.deepEqual(result.batch.entries.map(entry => entry.tabId), [103, 100, 104]); assert.equal(creates().length, 5);
});

for (const change of ['deleted', 'moved', 'folder', 'source-space', 'missing-active', 'active', 'tab-window', 'tab-binding', 'folder-entry']) {
    test(`batch preflight rejects late ${change} entry before any saved/session/tab mutation`, async () => {
        const writes = []; hooks.localBeforeSet = value => writes.push(copy(value)); hooks.sessionBeforeSet = value => writes.push(copy(value));
        let entries = [batchBookmark('twin'), batchBookmark('bookmark', { tabId: 2 })];
        if (change === 'deleted') nodes = nodes.filter(node => node.id !== 'bookmark');
        if (change === 'moved') nodes.find(node => node.id === 'bookmark').parentId = 'folder';
        if (change === 'folder') nodes.find(node => node.id === 'folder').parentId = 'outside';
        if (change === 'source-space') spaceStore.spaces[0].bookmarkFolderId = 'other';
        if (change === 'missing-active') delete spaceStore.active[1];
        if (change === 'active') spaceStore.active[1] = 'other';
        if (change === 'tab-window') get(2).windowId = 2;
        if (change === 'tab-binding') local.pinnedTabStatesById[2].bookmarkId = 'twin';
        if (change === 'folder-entry') entries[1] = batchBookmark('nested', { parentId: 'folder' });
        const error = await batchError(newStore({ captureIcon: async () => null }).dispatch(batchRequest(entries)));
        assert.equal(error.batch.complete, false); assert.equal(error.batch.entries.some(entry => entry.status === 'completed'), false);
        assert.deepEqual(writes, []); assert.deepEqual(effects, []); assert.equal(local[FAVORITES_KEY], undefined);
    });
}

for (const windowId of [3, 4, 99]) test(`batch rejects unavailable/private/nonnormal window ${windowId} before writes`, async () => {
    const error = await batchError(newStore({ captureIcon: async () => null }).dispatch(batchRequest(undefined, { windowId })));
    assert.deepEqual(batchStatuses(error), ['unattempted', 'unattempted']);
    assert.deepEqual(effects, []); assert.equal(local[FAVORITES_KEY], undefined); assert.deepEqual(session, {});
});

test('batch stale destination preflight preserves existing saved order and creates nothing', async () => {
    const store = newStore({ captureIcon: async () => null }); await store.dispatch(request('addTab', { tabId: 3 }));
    const before = copy(local[FAVORITES_KEY]), beforeSession = copy(session), count = effects.length;
    const error = await batchError(store.dispatch(batchRequest(undefined, { beforeId: 'removed' })));
    assert.equal(error.code, 'STALE_FAVORITE'); assert.deepEqual(batchStatuses(error), ['unattempted', 'unattempted']);
    assert.deepEqual(local[FAVORITES_KEY], before); assert.deepEqual(session, beforeSession); assert.equal(effects.length, count);
});

test('batch rechecks earlier source after later asynchronous preflight lookup deletes it', async () => {
    let reads = 0;
    hooks.bookmarks = id => { if (id === 'nested' && ++reads === 3) nodes = nodes.filter(node => node.id !== 'bookmark'); };
    const error = await batchError(newStore({ captureIcon: async () => null }).dispatch(batchRequest()));
    assert.deepEqual(batchStatuses(error), ['failed', 'unattempted']);
    assert.deepEqual(effects, []); assert.equal(local[FAVORITES_KEY], undefined); assert.deepEqual(session, {});
});

test('batch preflight blocks an existing uncertain Favorite before an earlier new entry is saved', async () => {
    const store = newStore({ captureIcon: async () => null, install: false });
    hooks.create = () => { throw new Error('Chrome timeout'); };
    await assert.rejects(store.dispatch(bookmark({ bookmarkId: 'twin' }))); hooks.create = undefined;
    const before = copy(local[FAVORITES_KEY]), beforeSession = copy(session), count = effects.length;
    const error = await batchError(newStore({ captureIcon: async () => null, install: false }).dispatch(batchRequest()));
    assert.equal(error.code, 'UNCERTAIN_RESULT'); assert.deepEqual(batchStatuses(error), ['unattempted', 'failed']);
    assert.deepEqual(local[FAVORITES_KEY], before); assert.deepEqual(session, beforeSession); assert.equal(effects.length, count);
});

test('batch preflight blocks a source tab already owned by a different Favorite before saving earlier entries', async () => {
    const store = newStore({ captureIcon: async () => null }); await store.dispatch(request('addTab', { tabId: 2 }));
    const before = copy(local[FAVORITES_KEY]), count = effects.length;
    const error = await batchError(store.dispatch(batchRequest([batchBookmark('twin'), batchBookmark('bookmark', { tabId: 2 })])));
    assert.equal(error.code, 'FAVORITE_CONFLICT'); assert.deepEqual(batchStatuses(error), ['unattempted', 'failed']);
    assert.deepEqual(local[FAVORITES_KEY], before); assert.equal(effects.length, count);
});

for (const change of ['moved', 'unpinned']) test(`batch preflight blocks already-saved ${change} instance before an earlier new entry changes`, async () => {
    const store = newStore({ captureIcon: async () => null, install: false }); await store.dispatch(bookmark({ bookmarkId: 'twin' }));
    if (change === 'moved') get(100).windowId = 2; else get(100).pinned = false;
    const before = copy(local[FAVORITES_KEY]), beforeSession = copy(session), count = effects.length;
    const error = await batchError(store.dispatch(batchRequest()));
    assert.equal(error.code, 'STALE_TAB'); assert.deepEqual(batchStatuses(error), ['unattempted', 'failed']);
    assert.deepEqual(local[FAVORITES_KEY], before); assert.deepEqual(session, beforeSession); assert.equal(effects.length, count);
});

test('batch stops on source deletion after one completed entry and retries only on another explicit drop', async () => {
    addBatchNodes('last'); const original = copy(nodes.find(node => node.id === 'twin'));
    hooks.created = tab => { if (tab.id === 100) nodes = nodes.filter(node => node.id !== 'twin'); };
    const store = newStore({ captureIcon: async () => null }), input = batchRequest(['bookmark', 'twin', 'last'].map(id => batchBookmark(id)));
    const error = await batchError(store.dispatch(input));
    assert.deepEqual(batchStatuses(error), ['completed', 'failed', 'unattempted']);
    assert.equal(error.batch.entries[0].tabId, 100); assert.equal(creates().length, 1); assert.equal(local[FAVORITES_KEY].length, 1);
    assert.equal(get(100).pinned, true); hooks.created = undefined; nodes.push(original);
    const next = await store.dispatch(input);
    assert.equal(next.batch.complete, true); assert.deepEqual(next.batch.entries.map(entry => entry.tabId), [100, 101, 102]);
    assert.equal(creates().length, 3); assert.equal(local[FAVORITES_KEY].length, 3);
});

test('batch reports a newly opened but stale second entry exactly, preserves both pages, and does not attempt the third', async () => {
    addBatchNodes('last');
    hooks.created = tab => { if (tab.id === 101) nodes.find(node => node.id === 'twin').parentId = 'outside'; };
    const store = newStore({ captureIcon: async () => null }), input = batchRequest(['bookmark', 'twin', 'last'].map(id => batchBookmark(id)));
    const error = await batchError(store.dispatch(input));
    assert.deepEqual(batchStatuses(error), ['completed', 'failed', 'unattempted']);
    assert.equal(error.batch.entries[1].saved, true); assert.equal(error.batch.entries[1].tabId, 101);
    assert.equal(local[FAVORITES_KEY].length, 2); assert.equal(creates().length, 2); assert(get(100).pinned && get(101).pinned);
    hooks.created = undefined; nodes.find(node => node.id === 'twin').parentId = 'nested';
    const next = await store.dispatch(input); assert.deepEqual(next.batch.entries.map(entry => entry.tabId), [100, 101, 102]);
    assert.equal(creates().length, 3);
});

test('batch durable-write failure preserves completed entries and reports later entries unattempted', async () => {
    addBatchNodes('last');
    hooks.localBeforeSet = value => { if (value[FAVORITES_KEY]?.length === 2) throw new Error('Quota unavailable'); };
    const input = batchRequest(['bookmark', 'twin', 'last'].map(id => batchBookmark(id)));
    const error = await batchError(newStore({ captureIcon: async () => null, install: false }).dispatch(input));
    assert.deepEqual(batchStatuses(error), ['completed', 'failed', 'unattempted']);
    assert.equal(error.batch.entries[1].saved, undefined); assert.equal(creates().length, 1); assert.equal(local[FAVORITES_KEY].length, 1);
    hooks.localBeforeSet = undefined;
    const next = await newStore({ captureIcon: async () => null, install: false }).dispatch(input);
    assert.deepEqual(next.batch.entries.map(entry => entry.tabId), [100, 101, 102]); assert.equal(creates().length, 3);
});

test('second uncertain create preserves actual page and blocks the entire replay after worker restart', async () => {
    addBatchNodes('last'); const input = batchRequest(['bookmark', 'twin', 'last'].map(id => batchBookmark(id)));
    hooks.created = tab => { if (tab.id === 101) throw new Error('Chrome timed out after creating the tab'); };
    const error = await batchError(newStore({ captureIcon: async () => null, install: false }).dispatch(input));
    assert.deepEqual(batchStatuses(error), ['completed', 'failed', 'unattempted']); assert.equal(error.code, 'UNCERTAIN_RESULT');
    assert.equal(error.batch.entries[1].saved, true); assert.equal(error.batch.entries[1].tabId, undefined);
    assert.equal(get(101).pinned, true); assert.equal(creates().length, 2); assert.equal(local[FAVORITES_KEY].length, 2);
    const before = copy(local[FAVORITES_KEY]), beforeSession = copy(session); hooks.created = undefined;
    const retry = await batchError(newStore({ captureIcon: async () => null, install: false }).dispatch(input));
    assert.deepEqual(batchStatuses(retry), ['unattempted', 'failed', 'unattempted']); assert.equal(retry.code, 'UNCERTAIN_RESULT');
    assert.deepEqual(local[FAVORITES_KEY], before); assert.deepEqual(session, beforeSession); assert.equal(creates().length, 2);
});

test('batch exact returned receipt survives in memory while a restarted worker blocks a lost receipt', async () => {
    addBatchNodes('last'); const input = batchRequest(['bookmark', 'twin', 'last'].map(id => batchBookmark(id)));
    hooks.sessionBeforeSet = value => { if (value[FAVORITE_SESSION_KEY]?.attempts.some(attempt => attempt.tabId === 101)) throw new Error('Receipt response lost'); };
    const store = newStore({ captureIcon: async () => null, install: false }), error = await batchError(store.dispatch(input));
    assert.deepEqual(batchStatuses(error), ['completed', 'failed', 'unattempted']); assert.equal(error.batch.entries[1].tabId, 101);
    hooks.sessionBeforeSet = undefined;
    const restarted = await batchError(newStore({ captureIcon: async () => null, install: false }).dispatch(input));
    assert.equal(restarted.code, 'UNCERTAIN_RESULT'); assert.equal(creates().length, 2);
    const recovered = await store.dispatch(input);
    assert.deepEqual(recovered.batch.entries.map(entry => entry.tabId), [100, 101, 102]); assert.equal(creates().length, 3);
});

for (const change of ['closed', 'moved', 'unpinned']) test(`existing exact Favorite ${change} between batch members cannot turn into a replacement create`, async () => {
    const store = newStore({ captureIcon: async () => null, install: false }); await store.dispatch(bookmark({ bookmarkId: 'twin' }));
    hooks.created = tab => { if (tab.id === 101) {
        if (change === 'closed') tabs = tabs.filter(tab => tab.id !== 100);
        if (change === 'moved') get(100).windowId = 2;
        if (change === 'unpinned') get(100).pinned = false;
    } };
    const error = await batchError(store.dispatch(batchRequest()));
    assert.deepEqual(batchStatuses(error), ['completed', 'failed']); assert.equal(error.code, 'STALE_TAB');
    assert.equal(creates().length, 2); assert.equal(local[FAVORITES_KEY].length, 2);
    if (change === 'unpinned') assert.equal(get(100).pinned, false);
});

for (const change of ['closed', 'moved', 'unpinned']) test(`legacy exact native candidate ${change} after batch preflight never authorizes a new page`, async () => {
    tabs.push({ id: 4, windowId: 1, pinned: true, url: URL }); local.pinnedTabStatesById[4] = { bookmarkId: 'twin', pinnedUrl: URL };
    session.favoriteDropAttempts = { [JSON.stringify([1, 'twin'])]: { tabId: 4, url: URL, complete: true } };
    const receipt = copy(session.favoriteDropAttempts);
    hooks.created = () => {
        if (change === 'closed') tabs = tabs.filter(tab => tab.id !== 4);
        if (change === 'moved') get(4).windowId = 2;
        if (change === 'unpinned') get(4).pinned = false;
    };
    const error = await batchError(newStore({ captureIcon: async () => null, install: false }).dispatch(batchRequest()));
    assert.deepEqual(batchStatuses(error), ['completed', 'failed']); assert.equal(creates().length, 1);
    assert.equal(local[FAVORITES_KEY].length, 1); assert.deepEqual(session.favoriteDropAttempts, receipt);
});

for (const change of ['active-cleared', 'window-closed', 'source-url']) test(`batch rechecks ${change} after durable commit and before native create`, async () => {
    hooks.localAfterSet = value => { if (value[FAVORITES_KEY]) {
        if (change === 'active-cleared') delete spaceStore.active[1];
        if (change === 'window-closed') windows = windows.filter(window => window.id !== 1);
        if (change === 'source-url') nodes.find(node => node.id === 'bookmark').url = 'https://changed.test/';
    } };
    const error = await batchError(newStore({ captureIcon: async () => null }).dispatch(batchRequest()));
    assert.deepEqual(batchStatuses(error), ['failed', 'unattempted']); assert.equal(error.batch.entries[0].saved, true);
    assert.equal(creates().length, 0); assert.equal(local[FAVORITES_KEY].length, 1);
});

test('overlapping batch requests and a caller timeout stay on the sole queue and reuse exact successes', async () => {
    let release, started; const creating = new Promise(resolve => { started = resolve; });
    hooks.create = () => { started(); return new Promise(resolve => { release = resolve; }); };
    const store = newStore({ captureIcon: async () => null }), first = store.dispatch(batchRequest());
    await creating; const second = store.dispatch(batchRequest());
    const callerTimeout = await Promise.race([first.then(() => 'completed'), new Promise(resolve => setImmediate(() => resolve('timeout')))]);
    assert.equal(callerTimeout, 'timeout'); assert.equal(creates().length, 1);
    hooks.create = undefined; release(); const results = await Promise.all([first, second]);
    assert.equal(creates().length, 2); assert.deepEqual(results[0].batch, results[1].batch);
    assert.equal(local[FAVORITES_KEY].length, 2);
});

test('batch runtime authentication and structured partial outcomes survive the real message handler', async () => {
    const store = newStore({ captureIcon: async () => null }); registerFavoriteMessages(store);
    const listener = chrome.runtime.onMessage.listeners[0], input = batchRequest();
    const send = (message, sender) => new Promise(resolve => listener(message, sender, resolve));
    for (const sender of [{ id: 'a'.repeat(32) }, { id: SELF, url: 'https://untrusted.test/' },
        { id: SELF, url: chrome.runtime.getURL('sidebar.html'), tab: { windowId: 2 } }]) {
        assert.equal((await send(input, sender)).code, 'UNAUTHORIZED');
    }
    assert.deepEqual(effects, []); assert.equal(local[FAVORITES_KEY], undefined);
    hooks.created = tab => { if (tab.id === 100) nodes = nodes.filter(node => node.id !== 'twin'); };
    const result = await send(input, { id: SELF, url: chrome.runtime.getURL('sidebar.html'), tab: { windowId: 1 } });
    assert.equal(result.success, false); assert.equal(result.code, 'STALE_BOOKMARK');
    assert.deepEqual(result.batch.entries.map(entry => entry.status), ['completed', 'failed']);
    assert.equal(result.batch.entries[0].tabId, 100);
});

test('full bounded batch of 100 explicit identities executes once and repeated drops reuse every exact receipt', async () => {
    const ids = Array.from({ length: MAX_FAVORITE_BOOKMARK_BATCH }, (_, i) => `selected-${i}`);
    addBatchNodes(...ids); const source = copy(nodes), input = batchRequest(ids.map(id => batchBookmark(id)));
    const store = newStore({ captureIcon: async () => null, install: false }), result = await store.dispatch(input);
    assert.equal(result.batch.entries.length, 100); assert.equal(result.batch.complete, true);
    assert.deepEqual(result.favorites.map(item => item.sourceBookmarkId), ids);
    const repeated = await newStore({ captureIcon: async () => null, install: false }).dispatch(input);
    assert.deepEqual(repeated.batch, result.batch); assert.equal(creates().length, 100); assert.deepEqual(nodes, source);
    assert(creates().every(effect => effect[1].pinned && effect[1].active === false));
});

test('batch preflight respects another Favorite exact adoption attempt before any earlier member changes', async () => {
    const store = newStore({ captureIcon: async () => null, install: false });
    hooks.update = () => { throw new Error('Pin request failed'); };
    await assert.rejects(store.dispatch(request('addTab', { tabId: 2 }))); hooks.update = undefined;
    assert.equal(get(2).pinned, false); assert.equal(local[FAVORITES_KEY].length, 1);
    const before = copy(local[FAVORITES_KEY]), beforeSession = copy(session), count = effects.length;
    const error = await batchError(newStore({ captureIcon: async () => null, install: false }).dispatch(batchRequest([
        batchBookmark('twin'), batchBookmark('bookmark', { tabId: 2 })
    ])));
    assert.equal(error.code, 'FAVORITE_CONFLICT'); assert.deepEqual(batchStatuses(error), ['unattempted', 'failed']);
    assert.deepEqual(local[FAVORITES_KEY], before); assert.deepEqual(session, beforeSession); assert.equal(effects.length, count);
});

test('batch unknown legacy receipt on the last member blocks all earlier additions without modifying the receipt', async () => {
    session.favoriteDropAttempts = { [JSON.stringify([1, 'twin'])]: { tabId: null, url: URL } };
    const before = copy(session), error = await batchError(newStore({ captureIcon: async () => null }).dispatch(batchRequest()));
    assert.equal(error.code, 'UNCERTAIN_RESULT'); assert.deepEqual(batchStatuses(error), ['unattempted', 'failed']);
    assert.deepEqual(effects, []); assert.equal(local[FAVORITES_KEY], undefined); assert.deepEqual(session, before);
});

test('batch known second receipt recovers after binding write failure on worker restart without opening a duplicate', async () => {
    addBatchNodes('last'); const input = batchRequest(['bookmark', 'twin', 'last'].map(id => batchBookmark(id)));
    hooks.sessionBeforeSet = value => { if (value[FAVORITE_SESSION_KEY]?.bindings.some(binding => binding.tabId === 101)) throw new Error('Binding interrupted'); };
    const error = await batchError(newStore({ captureIcon: async () => null, install: false }).dispatch(input));
    assert.deepEqual(batchStatuses(error), ['completed', 'failed', 'unattempted']); assert.equal(error.batch.entries[1].tabId, 101);
    assert.equal(creates().length, 2); hooks.sessionBeforeSet = undefined;
    const result = await newStore({ captureIcon: async () => null, install: false }).dispatch(input);
    assert.deepEqual(result.batch.entries.map(entry => entry.tabId), [100, 101, 102]); assert.equal(creates().length, 3);
});

for (const count of [4, 8, 32, 100]) test(`diagnostic deep nested mixed same-URL ${count}-bookmark batch has no size boundary`, async () => {
    const parents = ['folder', 'nested', 'deep', 'deeper'];
    nodes.push({ id: 'deep', parentId: 'nested', title: 'Deep' }, { id: 'deeper', parentId: 'deep', title: 'Deeper' });
    const entries = Array.from({ length: count }, (_, i) => {
        const bookmarkId = `diagnostic-${i}`, parentId = parents[i % parents.length];
        nodes.push({ id: bookmarkId, parentId, title: bookmarkId, url: URL });
        if (i % 2) return { bookmarkId, parentId };
        const tabId = 1000 + i;
        tabs.push({ id: tabId, windowId: 1, pinned: false, title: bookmarkId, url: `https://navigated.test/${i}` });
        local.pinnedTabStatesById[tabId] = { bookmarkId, pinnedUrl: URL };
        spaceStore.spaces[0].spaceBookmarks.push(tabId);
        return { bookmarkId, parentId, tabId };
    });
    const source = copy(nodes), store = newStore({ captureIcon: async () => null });
    const result = await store.dispatch(batchRequest(entries));
    assert.equal(result.batch.complete, true);
    assert.deepEqual(result.favorites.map(item => item.sourceBookmarkId), entries.map(entry => entry.bookmarkId));
    assert.equal(creates().length, count / 2);
    assert.equal(updates().length, count / 2);
    assert.equal(new Set(result.batch.entries.map(entry => entry.tabId)).size, count);
    for (const [index, entry] of result.batch.entries.entries()) {
        if (index % 2 === 0) { assert.equal(entry.tabId, 1000 + index); assert.equal(get(entry.tabId).url, `https://navigated.test/${index}`); }
    }
    assert.deepEqual(nodes, source);
    const repeated = await store.dispatch(batchRequest(entries));
    assert.deepEqual(repeated.batch, result.batch);
    assert.equal(creates().length, count / 2);
    assert.equal(updates().length, count / 2);
});

for (const reason of ['wrong-parent', 'missing-node']) test(`diagnostic ${reason} exactly reproduces zero-of-eight screenshot outcome before mutation`, async () => {
    const ids = ['28', '22', '23', '24', '25', '26', '27', '29'];
    addBatchNodes(...ids);
    const entries = ids.map(bookmarkId => batchBookmark(bookmarkId));
    if (reason === 'wrong-parent') entries[0].parentId = 'folder';
    if (reason === 'missing-node') nodes = nodes.filter(node => node.id !== '28');
    const source = copy(nodes), writes = [];
    hooks.localBeforeSet = value => writes.push(copy(value));
    hooks.sessionBeforeSet = value => writes.push(copy(value));
    const error = await batchError(newStore({ captureIcon: async () => null }).dispatch(batchRequest(entries)));
    assert.equal(error.message, 'The saved bookmark changed or cannot be opened.');
    assert.deepEqual(batchStatuses(error), ['failed', ...Array(7).fill('unattempted')]);
    assert.deepEqual(effects, []); assert.deepEqual(writes, []); assert.deepEqual(nodes, source);
});

test('diagnostic seventh source preflight failure reports zero completed without implying that failed source was first', async () => {
    const ids = Array.from({ length: 8 }, (_, index) => String(index + 22));
    addBatchNodes(...ids);
    const entries = ids.map(bookmarkId => batchBookmark(bookmarkId));
    entries[6].parentId = 'folder';
    const writes = []; hooks.localBeforeSet = value => writes.push(copy(value)); hooks.sessionBeforeSet = value => writes.push(copy(value));
    const error = await batchError(newStore({ captureIcon: async () => null }).dispatch(batchRequest(entries)));
    assert.equal(error.message, 'The saved bookmark changed or cannot be opened.');
    assert.deepEqual(batchStatuses(error), [...Array(6).fill('unattempted'), 'failed', 'unattempted']);
    assert.deepEqual(error.batch.entries.filter(entry => entry.status === 'unattempted').map(entry => entry.bookmarkId), ['22', '23', '24', '25', '26', '27', '29']);
    assert.equal(error.batch.entries.find(entry => entry.status === 'failed').bookmarkId, '28');
    assert.deepEqual(effects, []); assert.deepEqual(writes, []);
});

const unsupportedUrl = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/restore.html';
const skippedEntry = (bookmarkId, title) => ({ bookmarkId, status: 'skipped', title,
    code: 'UNSUPPORTED_URL', reason: 'Only HTTP and HTTPS links up to 16,384 characters can be saved as Favorites.' });

for (const skippedIndex of [0, 3, 6, 7]) test(`mixed eight-bookmark batch skips unsupported source at index ${skippedIndex} and preserves every supported identity`, async () => {
    const ids = Array.from({ length: 8 }, (_, index) => `mixed-${index}`); addBatchNodes(...ids);
    const skippedId = ids[skippedIndex], liveId = ids[(skippedIndex + 1) % ids.length];
    Object.assign(nodes.find(node => node.id === skippedId), { url: unsupportedUrl, title: 'Tabs Backup & Restore' });
    local.pinnedTabStatesById[2] = { bookmarkId: liveId, pinnedUrl: nodes.find(node => node.id === liveId).url };
    const input = batchRequest(ids.map(bookmarkId => batchBookmark(bookmarkId, bookmarkId === liveId ? { tabId: 2 } : {})));
    const before = copy(nodes), store = newStore({ captureIcon: async () => null }), result = await store.dispatch(input);
    assert.equal(result.batch.complete, true);
    assert.deepEqual(result.batch.entries[skippedIndex], skippedEntry(skippedId, 'Tabs Backup & Restore'));
    const supported = result.batch.entries.filter(entry => entry.status === 'completed');
    assert.deepEqual(result.favorites.map(item => item.sourceBookmarkId), ids.filter(id => id !== skippedId));
    assert.equal(new Set(supported.map(entry => entry.tabId)).size, 7);
    assert.equal(supported.find(entry => entry.bookmarkId === liveId).tabId, 2);
    assert.equal(creates().length, 6); assert.deepEqual(updates(), [['update', 2, { pinned: true }]]);
    assert.equal(get(2).url, 'https://navigated.test/'); assert.deepEqual(nodes, before);
    const repeated = await store.dispatch(input); assert.deepEqual(repeated.batch, result.batch);
    assert.equal(creates().length, 6); assert.equal(updates().length, 1);
});

test('all unsupported schemes and oversized HTTP URL skip without storage, tab, icon, or reconciliation mutations', async () => {
    const urls = [unsupportedUrl, 'chrome://settings/', 'file:///tmp/example.html', 'javascript:alert(1)', 'data:text/plain,example', 'ftp://example.test/', `https://example.test/${'x'.repeat(16384)}`];
    const ids = urls.map((_, index) => `unsupported-${index}`); addBatchNodes(...ids);
    for (const [index, bookmarkId] of ids.entries()) nodes.find(node => node.id === bookmarkId).url = urls[index];
    local[FAVORITES_KEY] = [{ id: 'old-favorite', title: 'Old Favorite', url: URL, sourceBookmarkId: null }];
    session[FAVORITE_SESSION_KEY] = { version: 1, bindings: [{ favoriteId: 'old-favorite', windowId: 1, tabId: 1 }],
        attempts: [{ favoriteId: 'removed-favorite', windowId: 1, tabId: null, url: URL }] };
    const before = { local: copy(local), session: copy(session), nodes: copy(nodes), tabs: copy(tabs) }, writes = []; let captures = 0;
    hooks.localBeforeSet = value => writes.push(copy(value)); hooks.sessionBeforeSet = value => writes.push(copy(value));
    const store = newStore({ captureIcon: async () => { captures++; return null; } }), result = await store.dispatch(batchRequest(ids.map(id => batchBookmark(id))));
    assert.deepEqual(result, { batch: { complete: true, entries: ids.map(id => skippedEntry(id, id)) } });
    await iconIdle(store);
    assert.equal(captures, 0); assert.deepEqual(writes, []); assert.deepEqual(effects, []);
    assert.deepEqual({ local, session, nodes, tabs }, before); assert.deepEqual(store.state, before.session[FAVORITE_SESSION_KEY]);
});

for (const change of ['parent', 'deleted', 'folder', 'active', 'missing-active', 'tab-window', 'tab-binding', 'tab-space', 'private-tab']) {
    test(`unsupported source still rejects stale ${change} provenance during whole-selection preflight`, async () => {
        nodes.find(node => node.id === 'bookmark').url = unsupportedUrl;
        const input = batchRequest([batchBookmark('twin'), batchBookmark('bookmark', { tabId: 2 })]);
        if (change === 'parent') nodes.find(node => node.id === 'bookmark').parentId = 'folder';
        if (change === 'deleted') nodes = nodes.filter(node => node.id !== 'bookmark');
        if (change === 'folder') nodes.find(node => node.id === 'nested').parentId = 'outside';
        if (change === 'active') spaceStore.active[1] = 'other';
        if (change === 'missing-active') delete spaceStore.active[1];
        if (change === 'tab-window') get(2).windowId = 2;
        if (change === 'tab-binding') local.pinnedTabStatesById[2].bookmarkId = 'twin';
        if (change === 'tab-space') spaceStore.spaces[0].spaceBookmarks = [];
        if (change === 'private-tab') get(2).incognito = true;
        const writes = []; hooks.localBeforeSet = value => writes.push(copy(value)); hooks.sessionBeforeSet = value => writes.push(copy(value));
        const before = copy(nodes), error = await batchError(newStore({ captureIcon: async () => null }).dispatch(input));
        assert.equal(error.batch.complete, false); assert(!error.batch.entries.some(entry => ['completed', 'skipped'].includes(entry.status)));
        assert.deepEqual(writes, []); assert.deepEqual(effects, []); assert.deepEqual(nodes, before);
    });
}

for (const [initialUrl, laterUrl] of [[URL, unsupportedUrl], [unsupportedUrl, URL], [unsupportedUrl, 'chrome://settings/']]) {
    test(`preflight rechecks source URL before treating it as supported or skipped: ${initialUrl.slice(0, 20)} to ${laterUrl.slice(0, 20)}`, async () => {
        nodes.find(node => node.id === 'bookmark').url = initialUrl;
        let reads = 0;
        hooks.bookmarks = id => { if (id === 'nested' && ++reads === 3) nodes.find(node => node.id === 'bookmark').url = laterUrl; };
        const writes = []; hooks.localBeforeSet = value => writes.push(copy(value)); hooks.sessionBeforeSet = value => writes.push(copy(value));
        const error = await batchError(newStore({ captureIcon: async () => null }).dispatch(batchRequest()));
        assert.equal(error.code, 'STALE_BOOKMARK'); assert.deepEqual(batchStatuses(error), ['failed', 'unattempted']);
        assert.deepEqual(writes, []); assert.deepEqual(effects, []);
    });
}

test('unsupported source changed between execution members stops without opening or adopting its new URL', async () => {
    addBatchNodes('last'); nodes.find(node => node.id === 'twin').url = unsupportedUrl;
    hooks.created = () => { nodes.find(node => node.id === 'twin').url = URL; };
    const error = await batchError(newStore({ captureIcon: async () => null }).dispatch(batchRequest(['bookmark', 'twin', 'last'].map(id => batchBookmark(id)))));
    assert.equal(error.code, 'STALE_BOOKMARK'); assert.deepEqual(batchStatuses(error), ['completed', 'failed', 'unattempted']);
    assert.equal(creates().length, 1); assert.equal(local[FAVORITES_KEY].length, 1);
});

test('later uncertain create retains preceding skipped detail and does not retry any source automatically', async () => {
    addBatchNodes('last'); Object.assign(nodes.find(node => node.id === 'bookmark'), { url: unsupportedUrl, title: '<b>Tabs & restore</b>' });
    hooks.created = () => { throw new Error('Chrome response lost after create'); };
    const input = batchRequest(['bookmark', 'twin', 'last'].map(id => batchBookmark(id)));
    const error = await batchError(newStore({ captureIcon: async () => null, install: false }).dispatch(input));
    assert.equal(error.code, 'UNCERTAIN_RESULT'); assert.deepEqual(batchStatuses(error), ['skipped', 'failed', 'unattempted']);
    assert.deepEqual(error.batch.entries[0], skippedEntry('bookmark', '<b>Tabs & restore</b>'));
    assert.equal(error.batch.entries[1].saved, true); assert.equal(error.batch.entries[1].tabId, undefined);
    assert.equal(creates().length, 1); assert.equal(get(100).pinned, true); assert.equal(local[FAVORITES_KEY].length, 1);
    hooks.created = undefined;
    const retried = await batchError(newStore({ captureIcon: async () => null, install: false }).dispatch(input));
    assert.equal(retried.code, 'UNCERTAIN_RESULT'); assert.equal(creates().length, 1);
});

test('skipped existing Favorite remains an unselected anchor and keeps its saved HTTP record unchanged', async () => {
    addBatchNodes('third', 'fourth'); const store = newStore({ captureIcon: async () => null });
    for (const bookmarkId of ['bookmark', 'twin', 'third', 'fourth']) await store.dispatch(bookmark({ bookmarkId }));
    const skipped = copy(local[FAVORITES_KEY].find(item => item.sourceBookmarkId === 'twin'));
    nodes.find(node => node.id === 'twin').url = unsupportedUrl;
    const result = await store.dispatch(batchRequest(['fourth', 'twin', 'bookmark'].map(id => batchBookmark(id)), { beforeId: skipped.id }));
    assert.deepEqual(result.favorites.map(item => item.sourceBookmarkId), ['fourth', 'bookmark', 'twin', 'third']);
    assert.deepEqual(batchStatuses({ batch: result.batch }), ['completed', 'skipped', 'completed']);
    assert.deepEqual(local[FAVORITES_KEY].find(item => item.id === skipped.id), skipped); assert.equal(creates().length, 4);
});

test('batch-only unsupported classification cannot be requested by a caller to broaden single-add URL policy', async () => {
    nodes.find(node => node.id === 'bookmark').url = unsupportedUrl;
    await assert.rejects(newStore({ captureIcon: async () => null }).dispatch(bookmark()), { code: 'STALE_BOOKMARK' });
    assert.throws(() => validateFavoriteRequest({ ...batchRequest(), allowUnsupportedUrl: true }), { code: 'INVALID_REQUEST' });
    assert.throws(() => validateFavoriteRequest(bookmark({ allowUnsupportedUrl: true })), { code: 'INVALID_REQUEST' });
    assert.deepEqual(effects, []); assert.equal(local[FAVORITES_KEY], undefined);
});

for (const laterUrl of ['https://changed.test/', 'chrome://settings/']) test(`skipped execution rejects URL change observed by its final inner source read: ${laterUrl}`, async () => {
    nodes.find(node => node.id === 'bookmark').url = unsupportedUrl;
    nodes.find(node => node.id === 'twin').url = unsupportedUrl;
    let reads = 0;
    hooks.bookmarks = id => { if (id === 'nested' && ++reads === 10) nodes.find(node => node.id === 'bookmark').url = laterUrl; };
    const writes = []; hooks.localBeforeSet = value => writes.push(copy(value)); hooks.sessionBeforeSet = value => writes.push(copy(value));
    const error = await batchError(newStore({ captureIcon: async () => null }).dispatch(batchRequest()));
    assert.equal(error.code, 'STALE_BOOKMARK'); assert.deepEqual(batchStatuses(error), ['failed', 'unattempted']);
    assert.deepEqual(writes, []); assert.deepEqual(effects, []);
});
