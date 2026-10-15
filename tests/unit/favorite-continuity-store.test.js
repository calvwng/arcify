import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { FavoriteStore, FAVORITES_KEY, FAVORITE_SESSION_KEY } from '../../favorite-store.js';
import { SpaceStore, ownerOf } from '../../space-store.js';
import { createFavoriteContinuity, configureFavoriteContinuityPeer, CONTINUITY_LOCAL_KEY, CONTINUITY_SESSION_KEY } from '../../favorite-continuity.js';
import { PEER_KEY, PAIRING_GENERATION_KEY, GLOBAL_FAVORITES_FEATURE } from '../../spotlight-bridge-protocol.js';
import { createSpotlightBridge } from '../../spotlight-bridge.js';

// Real shared worker queue, both stores and group projector. Only browser APIs
// are mocked. These tests do not claim native keyboard or browser acceptance.
const clone = value => structuredClone(value);
// Chrome storage serialization does not promise insertion-order preservation.
const sortedObjects = value => Array.isArray(value) ? value.map(sortedObjects)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sortedObjects(value[key])])) : value;
const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); }, emit(...args) { for (const fn of this.listeners) fn(...clone(args)); } });
const saved = id => ({ id, title: id, url: 'https://same.test/', sourceBookmarkId: null });
const space = (id, tabs = []) => ({ id, name: id, color: 'blue', bookmarkFolderId: id, spaceBookmarks: [], temporaryTabs: tabs });
let local, session, sync, tabs, effects, hooks, nodes, groups, nextId;
const tab = id => { const result = tabs.find(tab => tab.id === id); if (!result) throw new Error('No tab'); return result; };
function area(data, name) {
    return { async get(keys) { await hooks[`${name}Get`]?.(keys); const names = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys || data); return Object.fromEntries(names.map(key => [key, clone(data[key] ?? (typeof keys === 'object' && !Array.isArray(keys) ? keys[key] : undefined))])); },
        async set(value) { await hooks[`${name}Set`]?.(value); Object.assign(data, hooks.sortedStorage ? sortedObjects(clone(value)) : clone(value)); } };
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

let peerGeneration, receipt, offline, witnessCalls;
const PEER = 'b'.repeat(32);
beforeEach(() => {
    local[PEER_KEY] = PEER; local[PAIRING_GENERATION_KEY] = crypto.randomUUID();
    peerGeneration = crypto.randomUUID(); receipt = null; offline = false; witnessCalls = [];
});
const continuity = () => createFavoriteContinuity({ api: chrome, sendRequest: async (peer, command, value) => {
    witnessCalls.push({ peer, command, value: clone(value) });
    if (offline) throw Object.assign(new Error('Unavailable'), { code: 'UNAVAILABLE' });
    const matched = receipt?.epoch === value.epoch && receipt?.writerGeneration === value.writerGeneration
        && receipt?.revision === value.revision && receipt?.peerGeneration === peerGeneration;
    if (command === 'write') {
        if (value.expectedPeerGeneration && (peerGeneration !== value.expectedPeerGeneration || receipt?.revision !== value.expectedRevision
            || receipt?.epoch !== value.epoch || receipt?.writerGeneration !== value.writerGeneration)) throw Object.assign(new Error('Revoked'), { code: 'STALE_RECEIPT' });
        receipt = { ...value, peerGeneration };
    }
    return { ...value, peerGeneration, matched: command === 'write' || matched };
} });
const pairedStores = () => stores({ ownershipPersistence: continuity() });
const clearSession = () => { for (const key of Object.keys(session)) delete session[key]; };
const bridgeRequest = (command, payload = {}) => ({ type: 'arcify-bridge', version: 1, requestId: crypto.randomUUID(), windowId: 1, command, ...payload });
const sender = { id: PEER, origin: `chrome-extension://${PEER}` };

for (const ordinary of [false, true]) for (const reload of [false, true]) {
    test(`actual ${ordinary ? 'ordinary' : 'pinned'} Favorite survives ${reload ? 'witnessed reload' : 'worker restart'} after storage reorders object keys`, async () => {
        hooks.sortedStorage = true; sync.ordinaryFavoriteTabs = ordinary;
        const first = pairedStores(); await first.favorites.dispatch(req('open', { favoriteId: 'f' }));
        const before = await first.favorites.dispatch(req('get'));
        const epoch = local[CONTINUITY_LOCAL_KEY].epoch;
        assert.notEqual(JSON.stringify(first.favorites.state), JSON.stringify(session[FAVORITE_SESSION_KEY]));
        assert.deepEqual(first.favorites.state, session[FAVORITE_SESSION_KEY]);
        if (reload) clearSession(); else offline = true; // Own session must not need its companion.
        const second = pairedStores(); const after = await second.favorites.dispatch(req('get'));
        assert.deepEqual(after.favorites, before.favorites);
        assert.equal(after.favorites[0].tabId, 100); assertGlobal(second, 100);
        assert.equal(local[CONTINUITY_LOCAL_KEY].epoch, epoch);
        assert.equal(tab(100).pinned, !ordinary);
        assert.equal(effects.filter(effect => effect[0] === 'create').length, 1);
    });
}

test('actual stores recover a witnessed ordinary Favorite before Space restore adopts stale exact membership', async () => {
    const first = pairedStores(); await first.favorites.dispatch(req('open', { favoriteId: 'f' }));
    const epoch = local[CONTINUITY_LOCAL_KEY].epoch;
    assert.equal(tab(100).pinned, false); assertGlobal(first, 100);
    tab(100).url = 'https://navigated.test/'; clearSession();
    local.spaces[1].temporaryTabs.push(100);
    local.spaceTabSnapshot.push({ tabId: 100, spaceId: 'b', section: 'temporaryTabs', url: tab(100).url });
    const second = pairedStores(); await second.spaces.dispatch({ action: 'get' });
    assertGlobal(second, 100); assert.equal(local[CONTINUITY_LOCAL_KEY].epoch, epoch);
    const read = await second.favorites.dispatch(req('get')); assert.equal(read.favorites[0].tabId, 100);
    assert.equal(effects.filter(effect => effect[0] === 'create').length, 1);
    assert.equal(local[FAVORITES_KEY][0].url, 'https://same.test/');
});

test('actual ordinary pending receipt survives reload and completes the same known tab', async () => {
    const first = pairedStores(); let fail = true;
    hooks.update = (id, change) => { if (fail && change.pinned === false) throw new Error('Unpin failed'); };
    await assert.rejects(first.favorites.dispatch(req('open', { favoriteId: 'f' })), /Unpin failed/);
    assert.equal(tab(100).pinned, true); assert.equal(session[FAVORITE_SESSION_KEY].attempts[0].tabId, 100);
    fail = false; clearSession(); const second = pairedStores();
    const opened = await second.favorites.dispatch(req('open', { favoriteId: 'f' }));
    assert.equal(opened.tab.id, 100); assert.equal(opened.tab.pinned, false); assertGlobal(second, 100);
    assert.equal(effects.filter(effect => effect[0] === 'create').length, 1);
});

test('actual stores retain unknown create receipt across witnessed reload without a duplicate', async () => {
    const first = pairedStores(); hooks.created = () => { throw new Error('lost creation response'); };
    await assert.rejects(first.favorites.dispatch(req('open', { favoriteId: 'f' })), { code: 'UNCERTAIN_RESULT' });
    assert.equal(tab(100).pinned, true); hooks.created = null; clearSession();
    const second = pairedStores(); await assert.rejects(second.favorites.dispatch(req('open', { favoriteId: 'f' })), { code: 'UNCERTAIN_RESULT' });
    assert.equal(effects.filter(effect => effect[0] === 'create').length, 1);
});

test('actual release while peer offline cannot resurrect ownership after Arcify reload', async () => {
    const first = pairedStores(); await first.favorites.dispatch(req('open', { favoriteId: 'f' })); offline = true;
    await first.favorites.dispatch(req('releaseTab', { favoriteId: 'f', tabId: 100 }));
    offline = false; clearSession(); const second = pairedStores();
    const read = await second.favorites.dispatch(req('get')); assert.equal(read.favorites[0].tabId, null);
    assert.equal(second.spaces.isGlobalTab(100), false); assert(ownerOf(second.spaces.spaces, 100));
    assert.equal(effects.filter(effect => effect[0] === 'create').length, 1);
});

test('failed release tombstone blocks native/Space transitions until current receipt persistence succeeds', async () => {
    const first = pairedStores(); await first.favorites.dispatch(req('open', { favoriteId: 'f' }));
    hooks.localSet = values => { if (values[CONTINUITY_LOCAL_KEY]?.phase === 'invalid') throw new Error('durable storage unavailable'); };
    await assert.rejects(first.favorites.dispatch(req('releaseTab', { favoriteId: 'f', tabId: 100 })), /durable storage unavailable/);
    assert.equal(ownerOf(first.spaces.spaces, 100), undefined);
    await assert.rejects(first.spaces.dispatch({ action: 'assign', spaceId: 'b', tabId: 100 }), /durable storage unavailable/);
    hooks.localSet = null; await first.favorites.dispatch(req('get'));
    assert.equal(local[CONTINUITY_LOCAL_KEY].state.bindings.length, 0);
    clearSession(); const second = pairedStores(); assert.equal((await second.favorites.dispatch(req('get'))).favorites[0].tabId, null);
});

test('transient recovery window read blocks actual Space initialization and preserves retry proof', async () => {
    const first = pairedStores(); await first.favorites.dispatch(req('open', { favoriteId: 'f' })); const journal = clone(local[CONTINUITY_LOCAL_KEY]); clearSession();
    hooks.window = () => { throw new Error('Temporary window failure'); };
    const second = pairedStores(); await assert.rejects(second.spaces.dispatch({ action: 'get' }), /Temporary window failure/);
    assert.equal(second.spaces.initialized, false); assert.deepEqual(local[CONTINUITY_LOCAL_KEY], journal);
    hooks.window = null; await second.spaces.dispatch({ action: 'get' }); assertGlobal(second, 100);
});

test('peer-only reload is repaired by actual authenticated bridge read with own-session proof', async () => {
    const first = pairedStores(); await first.favorites.dispatch(req('open', { favoriteId: 'f' })); receipt = null;
    const bridge = createSpotlightBridge(first.spaces);
    const hello = await bridge(bridgeRequest('hello', { supportedFeatures: [GLOBAL_FAVORITES_FEATURE] }), sender);
    assert.equal(hello.ok, true); assert.equal(hello.snapshot.favorites[0].tabId, 100); assert(receipt);
    clearSession(); const second = pairedStores(); await second.spaces.dispatch({ action: 'get' }); assertGlobal(second, 100);
});

test('full restart with reused IDs keeps saved Favorite closed and explicit open creates a distinct new page', async () => {
    const first = pairedStores(); await first.favorites.dispatch(req('open', { favoriteId: 'f' })); clearSession(); receipt = null;
    const second = pairedStores(); const read = await second.favorites.dispatch(req('get'));
    assert.equal(read.favorites[0].tabId, null); assert.equal(second.spaces.isGlobalTab(100), false);
    assert.equal(tab(100).pinned, false); const opened = await second.favorites.dispatch(req('open', { favoriteId: 'f' }));
    assert.equal(opened.tab.id, 101); assert(tab(100)); assertGlobal(second, 101);
});

test('legacy peer mode race after bridge snapshot is rejected by actual FavoriteStore beforeMutation guard', async () => {
    sync.ordinaryFavoriteTabs = false; const first = pairedStores(); await first.spaces.dispatch({ action: 'get' });
    const ordinary = first.favorites.ordinaryMode.bind(first.favorites); let checks = 0;
    first.favorites.ordinaryMode = async () => { if (++checks === 4) sync.ordinaryFavoriteTabs = true; return ordinary(); };
    const bridge = createSpotlightBridge(first.spaces);
    const result = await bridge(bridgeRequest('openFavorite', { favoriteId: 'f' }), sender);
    assert.equal(result.ok, false); assert.equal(result.error.code, 'UNSUPPORTED_FEATURE');
    assert.equal(effects.filter(effect => effect[0] === 'create').length, 0);
    assert.equal(first.favorites.state.attempts.length, 0);
});
