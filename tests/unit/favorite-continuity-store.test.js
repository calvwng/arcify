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
    await hooks.witness?.(command, value);
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

for (const syncGroups of [false, true]) for (const restart of ['worker', 'extension']) {
    test(`selected Space and native collapse survive ${restart} restart with active global Favorite, group sync ${syncGroups}`, async () => {
        sync.syncTabGroups = syncGroups;
        const first = pairedStores(); await first.favorites.dispatch(req('open', { favoriteId: 'f' }));
        await first.spaces.dispatch({ action: 'activate', windowId: 1, spaceId: 'b' });
        const beforeGroups = clone(groups).map(({ title, collapsed }) => ({ title, collapsed }));
        const beforeRevision = local[CONTINUITY_LOCAL_KEY].revision;
        assert.equal(tab(100).active, true); assert.equal(first.spaces.active[1], 'b');
        if (restart === 'extension') clearSession(); else offline = true;
        const second = pairedStores(); await second.spaces.dispatch({ action: 'get' });
        assert.equal(second.spaces.active[1], 'b');
        assert.equal(session.activeSpaces[1], 'b'); assertGlobal(second, 100);
        if (syncGroups) {
            const projected = Object.values(session.spaceGroupProjection);
            assert.deepEqual(groups.filter(group => projected.includes(group.id)).map(({ title, collapsed }) => ({ title, collapsed })), beforeGroups);
        }
        assert(local[CONTINUITY_LOCAL_KEY].revision > beforeRevision);
    });
}

for (const syncGroups of [false, true]) test(`selection-only checkpoints preserve empty Space and independent windows, group sync ${syncGroups}`, async () => {
    sync.syncTabGroups = syncGroups;
    local.spaces.push(space('empty')); nodes.push({ id: 'empty', parentId: 'root', title: 'empty' });
    tabs.push({ id: 3, windowId: 2, title: 'Other', url: 'https://other.test/', pinned: false, groupId: -1, index: 0 });
    local.spaces[1].temporaryTabs.push(3);
    const first = pairedStores(); await first.favorites.dispatch(req('open', { favoriteId: 'f' }));
    const ownership = clone(session[FAVORITE_SESSION_KEY]);
    const before = local[CONTINUITY_LOCAL_KEY].revision;
    await first.spaces.dispatch({ action: 'activate', windowId: 1, spaceId: 'empty' });
    await first.spaces.dispatch({ action: 'activate', windowId: 2, spaceId: 'a' });
    assert.deepEqual(session[FAVORITE_SESSION_KEY], ownership);
    assert(local[CONTINUITY_LOCAL_KEY].revision >= before + 2);
    assert.deepEqual(local[CONTINUITY_LOCAL_KEY].selection.windows.map(({ windowId, spaceId }) => ({ windowId, spaceId })),
        [{ windowId: 1, spaceId: 'empty' }, { windowId: 2, spaceId: 'a' }]);
    clearSession(); const second = pairedStores(); await second.spaces.dispatch({ action: 'get' });
    assert.deepEqual(second.spaces.active, { 1: 'empty', 2: 'a' });
    assert.deepEqual(second.spaces.spaces.find(space => space.id === 'empty').temporaryTabs, []);
    if (syncGroups) {
        assert.equal(groups.find(group => group.id === session.spaceGroupProjection['a:1']).collapsed, true);
        assert.equal(groups.find(group => group.id === session.spaceGroupProjection['b:1']).collapsed, true);
        assert.equal(groups.find(group => group.id === session.spaceGroupProjection['b:2']).collapsed, true);
    }
    assert(witnessCalls.every(call => !JSON.stringify(call.value).includes('spaceId') && !JSON.stringify(call.value).includes('https:')));
});

for (const active of [{ 1: 'a' }, {}]) test(`own Space session selection ${JSON.stringify(active)} wins over older witnessed selection`, async () => {
    const first = pairedStores(); await first.spaces.dispatch({ action: 'activate', windowId: 1, spaceId: 'b' });
    session.activeSpaces = clone(active); offline = true;
    const second = pairedStores(); await second.spaces.dispatch({ action: 'get' });
    assert.deepEqual(second.spaces.active, active); assert.deepEqual(session.activeSpaces, active);
});

for (const condition of ['invalid-journal', 'offline', 'missing-peer', 'wrong-epoch', 'wrong-revision', 'peer-reloaded', 'revoked', 'full-restart']) {
    test(`selected Space fails closed with ${condition} despite surviving/reused numeric IDs`, async () => {
        const first = pairedStores(); await first.spaces.dispatch({ action: 'activate', windowId: 1, spaceId: 'b' });
        const epoch = local[CONTINUITY_LOCAL_KEY].epoch;
        if (condition === 'invalid-journal') local[CONTINUITY_LOCAL_KEY].phase = 'invalid';
        if (condition === 'offline') offline = true;
        if (condition === 'wrong-epoch') receipt.epoch = crypto.randomUUID();
        if (condition === 'wrong-revision') receipt.revision++;
        if (condition === 'peer-reloaded') peerGeneration = crypto.randomUUID();
        if (condition === 'missing-peer' || condition === 'full-restart') receipt = null;
        if (condition === 'revoked') await configureFavoriteContinuityPeer(chrome, PEER);
        clearSession(); const second = pairedStores(); await second.spaces.dispatch({ action: 'get' });
        assert.deepEqual(second.spaces.active, {}); assert.notEqual(local[CONTINUITY_LOCAL_KEY].epoch, epoch);
    });
}

for (const condition of ['digest', 'shape', 'old-revision', 'old-epoch', 'old-fingerprint', 'missing-context', 'missing-digest']) {
    test(`invalid selection ${condition} does not weaken valid Favorite v2 ownership`, async () => {
        const first = pairedStores(); await first.favorites.dispatch(req('open', { favoriteId: 'f' }));
        await first.spaces.dispatch({ action: 'activate', windowId: 1, spaceId: 'b' });
        const journal = local[CONTINUITY_LOCAL_KEY];
        if (condition === 'digest') journal.selectionFingerprint = '0'.repeat(64);
        if (condition === 'shape') journal.selection.windows[0].unexpected = true;
        if (condition === 'old-revision') { journal.revision++; receipt.revision++; }
        if (condition === 'old-epoch') { journal.epoch = receipt.epoch = crypto.randomUUID(); }
        if (condition === 'old-fingerprint') {
            journal.state.attempts.push({ ...journal.state.bindings[0], url: local[FAVORITES_KEY][0].url, kind: 'adopt' });
            const { encodeFavoriteContinuityState } = await import('../../favorite-continuity.js');
            journal.fingerprint = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(encodeFavoriteContinuityState(journal.state)))).toString('hex');
        }
        if (condition === 'missing-context') delete journal.selection;
        if (condition === 'missing-digest') delete journal.selectionFingerprint;
        clearSession(); const second = pairedStores(); await second.spaces.dispatch({ action: 'get' });
        assertGlobal(second, 100); assert.deepEqual(second.spaces.active, {});
    });
}

for (const condition of ['deleted-space', 'unknown-space', 'moved-anchor', 'missing-anchor', 'private-tab', 'private-window', 'popup-window']) {
    test(`selected Space rejects ${condition} without URL or group inference`, async () => {
        const first = pairedStores(); await first.spaces.dispatch({ action: 'activate', windowId: 1, spaceId: 'b' });
        const anchor = local[CONTINUITY_LOCAL_KEY].selection.windows[0].tabId;
        if (condition === 'deleted-space') { local.spaces = local.spaces.filter(space => space.id !== 'b'); nodes = nodes.filter(node => node.id !== 'b'); }
        if (condition === 'unknown-space') local.spaces[1].id = 'replacement';
        if (condition === 'moved-anchor') tab(anchor).windowId = 2;
        if (condition === 'missing-anchor') tabs = tabs.filter(tab => tab.id !== anchor);
        if (condition === 'private-tab') tab(anchor).incognito = true;
        if (condition === 'private-window' || condition === 'popup-window') {
            const oldGet = chrome.windows.get;
            chrome.windows.get = async id => ({ ...await oldGet(id), ...(condition === 'private-window' ? { incognito: true } : { type: 'popup' }) });
        }
        clearSession(); const second = pairedStores(); await second.spaces.dispatch({ action: 'get' });
        assert.deepEqual(second.spaces.active, {});
    });
}

for (const boundary of ['invalidate', 'session', 'commit', 'ack']) test(`selection-only ${boundary} failure preserves atomic session and never replays old context`, async () => {
    sync.syncTabGroups = true;
    const first = pairedStores(); await first.spaces.dispatch({ action: 'get' });
    const previousGroups = clone(groups), previous = clone(local[CONTINUITY_LOCAL_KEY]); let commits = 0;
    hooks.localSet = values => {
        const journal = values[CONTINUITY_LOCAL_KEY];
        if (journal?.phase === 'invalid' && boundary === 'invalidate') throw new Error('checkpoint failed');
        if (journal?.phase === 'committed') {
            commits++;
            if (boundary === 'commit' && commits === 1 || boundary === 'ack' && commits === 2) throw new Error('checkpoint failed');
        }
    };
    hooks.sessionSet = values => {
        if (values[CONTINUITY_SESSION_KEY] && boundary === 'session') throw new Error('checkpoint failed');
        if (values.activeSpaces) assert.equal(local[CONTINUITY_LOCAL_KEY].phase, 'invalid');
    };
    await assert.rejects(first.spaces.dispatch({ action: 'activate', windowId: 1, spaceId: 'b' }), /checkpoint failed/);
    assert.deepEqual(groups, previousGroups); assert.equal(first.spaces.initialized, false);
    assert.equal(session.activeSpaces[1], ['invalidate', 'session'].includes(boundary) ? 'a' : 'b');
    hooks.localSet = null; hooks.sessionSet = null;
    if (boundary === 'invalidate') assert.deepEqual(local[CONTINUITY_LOCAL_KEY], previous);
    clearSession(); const second = pairedStores(); await second.spaces.dispatch({ action: 'get' });
    assert.equal(second.spaces.active[1], boundary === 'invalidate' ? 'a' : undefined);
});

for (const condition of ['revoke-before-ack', 'move-during-ack', 'delete-during-ack', 'private-during-ack']) {
    test(`selection recovery rejects ${condition} before publishing an authoritative Space session`, async () => {
        const first = pairedStores(); await first.spaces.dispatch({ action: 'activate', windowId: 1, spaceId: 'b' });
        const anchor = local[CONTINUITY_LOCAL_KEY].selection.windows[0].tabId;
        hooks.witness = (command, value) => {
            if (command !== 'write' || !value.expectedPeerGeneration) return;
            assert.equal(session.spaceSession, undefined); assert.equal(session.activeSpaces, undefined);
            if (condition === 'revoke-before-ack') { peerGeneration = crypto.randomUUID(); receipt = null; }
            if (condition === 'move-during-ack') tab(anchor).windowId = 2;
            if (condition === 'delete-during-ack') tabs = tabs.filter(tab => tab.id !== anchor);
            if (condition === 'private-during-ack') tab(anchor).incognito = true;
        };
        clearSession(); const second = pairedStores(); await second.spaces.dispatch({ action: 'get' });
        assert.deepEqual(second.spaces.active, {}); assert.deepEqual(session.activeSpaces, {});
    });
}

test('interrupted final recovery receipt never promotes provisional selection to a Space session', async () => {
    const first = pairedStores(); await first.favorites.dispatch(req('open', { favoriteId: 'f' }));
    await first.spaces.dispatch({ action: 'activate', windowId: 1, spaceId: 'b' });
    clearSession();
    hooks.sessionSet = values => { if (values[CONTINUITY_SESSION_KEY] && !values[CONTINUITY_SESSION_KEY].phase) throw new Error('final receipt failed'); };
    const second = pairedStores(); await assert.rejects(second.spaces.dispatch({ action: 'get' }), /final receipt failed/);
    assert.equal(session[CONTINUITY_SESSION_KEY].phase, 'recovering');
    assert.equal(session.spaceSession, undefined); assert.equal(session.activeSpaces, undefined); assert.equal(second.spaces.initialized, false);
    hooks.sessionSet = null;
    const third = pairedStores(); await third.spaces.dispatch({ action: 'get' });
    assert.deepEqual(third.spaces.active, {}); assert.equal(third.spaces.isGlobalTab(100), false);
});

for (const newer of ['queued-activate', 'native-onActivated']) test(`newer ${newer} during witness read wins and checkpoints the latest intent`, async () => {
    const first = pairedStores(); await first.spaces.dispatch({ action: 'activate', windowId: 1, spaceId: 'b' });
    clearSession(); let second, queued, fired = false;
    hooks.witness = command => {
        if (command !== 'read' || fired) return; fired = true;
        if (newer === 'queued-activate') queued = second.spaces.dispatch({ action: 'activate', windowId: 1, spaceId: 'a' });
        else { for (const native of tabs) native.active = native.id === 1; chrome.tabs.onActivated.emit({ windowId: 1, tabId: 1 }); }
    };
    second = stores({ install: true, ownershipPersistence: continuity() });
    await second.idle(); await queued;
    assert.equal(fired, true); assert.equal(second.spaces.active[1], 'a'); assert.equal(session.activeSpaces[1], 'a');
    assert.equal(local[CONTINUITY_LOCAL_KEY].selection.windows[0].spaceId, 'a');
});

test('selection window lookup uncertainty preserves candidate and blocks initialization until retry', async () => {
    const first = pairedStores(); await first.spaces.dispatch({ action: 'activate', windowId: 1, spaceId: 'b' });
    const previous = clone(local[CONTINUITY_LOCAL_KEY]); clearSession();
    hooks.window = () => { throw new Error('window unavailable'); };
    const second = pairedStores(); await assert.rejects(second.spaces.dispatch({ action: 'get' }), /window unavailable/);
    assert.deepEqual(local[CONTINUITY_LOCAL_KEY], previous); assert.equal(session.spaceSession, undefined);
    hooks.window = null; await second.spaces.dispatch({ action: 'get' }); assert.equal(second.spaces.active[1], 'b');
});

test('browser tab navigating to extension UI is not used as a reload selection anchor', async () => {
    tab(1).active = true; tab(1).pendingUrl = chrome.runtime.getURL('options.html');
    const first = pairedStores(); await first.spaces.dispatch({ action: 'activate', windowId: 1, spaceId: 'b' });
    assert.equal(local[CONTINUITY_LOCAL_KEY].selection.windows[0].tabId, 2);
    tab(2).pendingUrl = chrome.runtime.getURL('sidebar.html');
    clearSession(); const second = pairedStores(); await second.spaces.dispatch({ action: 'get' });
    assert.deepEqual(second.spaces.active, {});
});

test('offline selection change cannot revive the older witnessed selection on extension reload', async () => {
    const first = pairedStores(); await first.spaces.dispatch({ action: 'activate', windowId: 1, spaceId: 'a' });
    offline = true; await first.spaces.dispatch({ action: 'activate', windowId: 1, spaceId: 'b' });
    assert.equal(session.activeSpaces[1], 'b'); assert.equal(local[CONTINUITY_LOCAL_KEY].peerGeneration, null);
    offline = false; clearSession(); const second = pairedStores(); await second.spaces.dispatch({ action: 'get' });
    assert.deepEqual(second.spaces.active, {});
});

test('rejected checkpoint reloads authoritative old selection before a subsequent same-worker read', async () => {
    const first = pairedStores(); await first.spaces.dispatch({ action: 'activate', windowId: 1, spaceId: 'a' });
    hooks.localSet = value => { if (value[CONTINUITY_LOCAL_KEY]?.phase === 'invalid') throw new Error('checkpoint failed'); };
    await assert.rejects(first.spaces.dispatch({ action: 'activate', windowId: 1, spaceId: 'b' }), /checkpoint failed/);
    hooks.localSet = null; await first.spaces.dispatch({ action: 'get' });
    assert.equal(first.spaces.active[1], 'a'); assert.equal(local[CONTINUITY_LOCAL_KEY].selection.windows[0].spaceId, 'a');
});

for (const active of [{ 1: 'a' }, {}]) test(`own selection ${JSON.stringify(active)} is authoritative before interrupted Space initialization too`, async () => {
    const first = pairedStores(); await first.spaces.dispatch({ action: 'activate', windowId: 1, spaceId: 'b' });
    session.activeSpaces = clone(active);
    const second = pairedStores();
    await second.favorites.initialize(); // Crash before SpaceStore can checkpoint its own session.
    clearSession(); const third = pairedStores(); await third.spaces.dispatch({ action: 'get' });
    assert.deepEqual(third.spaces.active, {});
});

for (const syncGroups of [false, true]) test(`witnessed reload preserves duplicate-URL bookmark membership despite destroyed extension view, group sync ${syncGroups}`, async () => {
    sync.syncTabGroups = syncGroups;
    tabs = [
        { id: 3, windowId: 1, title: 'Sidebar', url: chrome.runtime.getURL('sidebar.html'), pinned: false, groupId: -1, index: 0 },
        { id: 1, windowId: 1, title: 'Twin one', url: 'https://same.test/', pinned: false, groupId: -1, index: 1 },
        { id: 2, windowId: 1, title: 'Twin two', url: 'https://same.test/', pinned: false, groupId: -1, index: 2 },
        { id: 4, windowId: 1, title: 'Personal', url: 'https://personal.test/', pinned: false, groupId: -1, index: 3 }
    ];
    local.spaces = [{ ...space('a'), spaceBookmarks: [1, 2] }, space('b', [4])];
    local.pinnedTabStatesById = { 1: { bookmarkId: 'bookmark', pinnedUrl: 'https://same.test/' }, 2: { bookmarkId: 'twin', pinnedUrl: 'https://same.test/' } };
    local.tabNameOverridesById = { 1: 'Distinct twin one', 2: 'Distinct twin two' };
    const first = pairedStores(); await first.favorites.dispatch(req('open', { favoriteId: 'f' }));
    await first.spaces.dispatch({ action: 'activate', windowId: 1, spaceId: 'b' });
    const before = { spaces: clone(local.spaces), metadata: clone(local.pinnedTabStatesById), names: clone(local.tabNameOverridesById), snapshot: clone(local.spaceTabSnapshot), windows: clone(local.spaceWindowSnapshot), selected: clone(session.activeSpaces), epoch: local[CONTINUITY_LOCAL_KEY].epoch };
    tabs = tabs.filter(native => native.id !== 3); tabs.forEach((native, index) => { native.index = index; });
    tab(1).url = 'https://navigated.test/one'; tab(2).url = 'https://navigated.test/two';
    clearSession(); const second = pairedStores(); await second.spaces.dispatch({ action: 'get' });
    const after = { spaces: clone(local.spaces), metadata: clone(local.pinnedTabStatesById), names: clone(local.tabNameOverridesById), pending: clone(second.spaces.restoreQueue), selected: clone(session.activeSpaces), epoch: local[CONTINUITY_LOCAL_KEY].epoch };
    assertGlobal(second, 100); assert.equal(after.epoch, before.epoch);
    assert.deepEqual(second.spaces.spaces.find(value => value.id === 'a').spaceBookmarks, [1, 2], 'Exact live duplicate bookmarks must retain their original section');
    assert.deepEqual(after.metadata, before.metadata);
    assert.deepEqual(after.names, before.names);
});

const seedExactSpaceReplay = async () => {
    tab(1).url = tab(2).url = 'https://same.test/';
    local.spaces = [{ ...space('a'), spaceBookmarks: [2, 1] }, space('b')];
    local.pinnedTabStatesById = { 1: { bookmarkId: 'bookmark', pinnedUrl: 'https://same.test/' }, 2: { bookmarkId: 'twin', pinnedUrl: 'https://same.test/' } };
    local.tabNameOverridesById = { 1: 'First alias', 2: 'Second alias' };
    const first = pairedStores(); await first.spaces.dispatch({ action: 'activate', windowId: 1, spaceId: 'b' });
    tab(1).url = 'https://changed.test/one'; tab(2).url = 'https://changed.test/two';
    return first;
};

for (const condition of ['missing-stamp', 'wrong-epoch', 'wrong-generation', 'count-too-large', 'count-shrunk', 'hash', 'reordered-prefix', 'edited-metadata', 'edited-section', 'offline', 'missing-peer', 'revoked', 'full-restart']) {
    test(`exact Space replay refuses ${condition} while normal browser restore remains separate`, async () => {
        await seedExactSpaceReplay();
        const stamp = local.spaceContinuityStamp;
        if (condition === 'missing-stamp') delete local.spaceContinuityStamp;
        if (condition === 'wrong-epoch') stamp.epoch = crypto.randomUUID();
        if (condition === 'wrong-generation') stamp.generation = crypto.randomUUID();
        if (condition === 'count-too-large') stamp.liveCount = local.spaceTabSnapshot.length + 1;
        if (condition === 'count-shrunk') stamp.liveCount--;
        if (condition === 'hash') stamp.fingerprint = '0'.repeat(64);
        if (condition === 'reordered-prefix') local.spaceTabSnapshot.reverse();
        if (condition === 'edited-metadata') local.spaceTabSnapshot[0].nameOverride = 'stale writer';
        if (condition === 'edited-section') local.spaceTabSnapshot[0].section = 'temporaryTabs';
        if (condition === 'offline') offline = true;
        if (condition === 'missing-peer' || condition === 'full-restart') receipt = null;
        if (condition === 'revoked') await configureFavoriteContinuityPeer(chrome, PEER);
        clearSession(); const second = pairedStores(); await second.spaces.dispatch({ action: 'get' });
        assert.deepEqual(second.spaces.spaces.find(space => space.id === 'a').spaceBookmarks, []);
        assert.deepEqual(local.pinnedTabStatesById, {}); assert.deepEqual(local.tabNameOverridesById, {});
    });
}

test('same-session replay preserves current section sequence rather than stale restoredRanks', async () => {
    const first = await seedExactSpaceReplay();
    first.spaces.restoredRanks = new Map([[1, 0], [2, 1]]);
    await first.spaces.run(() => first.spaces.persist());
    assert.deepEqual(local.spaceTabSnapshot.map(record => record.tabId), [2, 1]);
    assert.deepEqual(local.spaceTabSnapshot.map(record => record.order), [1, 0]);
    clearSession(); const second = pairedStores(); await second.spaces.dispatch({ action: 'get' });
    assert.deepEqual(second.spaces.spaces.find(space => space.id === 'a').spaceBookmarks, [2, 1]);
});

test('pending suffix IDs never override a proven live prefix or acquire exact metadata', async () => {
    const first = await seedExactSpaceReplay();
    const pending = { tabId: 1, spaceId: 'b', section: 'spaceBookmarks', order: 0, url: 'https://old-pending.test/', windowKey: crypto.randomUUID(),
        pinnedState: { bookmarkId: 'old-bookmark', pinnedUrl: 'https://old-pending.test/' }, nameOverride: 'Old pending alias' };
    first.spaces.restoreQueue.push(pending);
    await first.spaces.run(() => first.spaces.persist());
    assert.equal(local.spaceContinuityStamp.liveCount, 2); assert.equal(local.spaceTabSnapshot.length, 3);
    clearSession(); const second = pairedStores(); await second.spaces.dispatch({ action: 'get' });
    assert.deepEqual(second.spaces.spaces.find(space => space.id === 'a').spaceBookmarks, [2, 1]);
    assert.equal(local.pinnedTabStatesById[1].bookmarkId, 'bookmark');
    assert.equal(second.spaces.snapshotByTab.get(1).nameOverride, 'First alias');
    assert.deepEqual(second.spaces.restoreQueue, [pending]);
});

for (const condition of ['closed', 'private-tab', 'private-window', 'popup-window', 'native-pinned', 'moved-normal-window']) {
    test(`exact Space replay handles ${condition} without resurrecting discarded live prefix`, async () => {
        await seedExactSpaceReplay();
        if (condition === 'closed') tabs = tabs.filter(tab => tab.id !== 1);
        if (condition === 'private-tab') tab(1).incognito = true;
        if (condition === 'private-window') tab(1).windowId = 4;
        if (condition === 'popup-window') tab(1).windowId = 3;
        if (condition === 'native-pinned') tab(1).pinned = true;
        if (condition === 'moved-normal-window') tab(1).windowId = 2;
        clearSession(); const second = pairedStores(); await second.spaces.dispatch({ action: 'get' });
        assert.deepEqual(second.spaces.spaces.find(space => space.id === 'a').spaceBookmarks, condition === 'moved-normal-window' ? [2, 1] : [2]);
        assert.equal(Boolean(local.pinnedTabStatesById[1]), condition === 'moved-normal-window');
        assert(!second.spaces.restoreQueue.some(record => record.tabId === 1), 'Discarded current records cannot become pending URL restores');
        if (condition === 'closed') assert(!second.spaces.snapshotByTab.has(1));
    });
}

test('fresh witness enrollment interrupted before Space reset cannot authenticate old-browser IDs', async () => {
    await seedExactSpaceReplay(); const oldStamp = clone(local.spaceContinuityStamp);
    clearSession(); receipt = null;
    const middle = pairedStores(); await middle.favorites.initialize();
    assert.notEqual(local[CONTINUITY_LOCAL_KEY].epoch, oldStamp.epoch);
    assert.equal(await middle.favorites.ownershipPersistence.browserIdentity({ recovered: true }), null);
    assert.deepEqual(local.spaceContinuityStamp, oldStamp);
    clearSession(); const second = pairedStores(); await second.spaces.dispatch({ action: 'get' });
    assert.deepEqual(second.spaces.spaces.find(space => space.id === 'a').spaceBookmarks, []);
    assert.deepEqual(local.pinnedTabStatesById, {}); assert.deepEqual(local.tabNameOverridesById, {});
});

test('failed atomic Space snapshot/stamp write cannot stamp old data with a fresh browser epoch', async () => {
    await seedExactSpaceReplay(); const oldStamp = clone(local.spaceContinuityStamp), oldSnapshot = clone(local.spaceTabSnapshot);
    clearSession(); receipt = null;
    hooks.localSet = values => { if (values.spaces && values.spaceContinuityStamp) throw new Error('snapshot write failed'); };
    const middle = pairedStores(); await assert.rejects(middle.spaces.dispatch({ action: 'get' }), /snapshot write failed/);
    assert.deepEqual(local.spaceContinuityStamp, oldStamp); assert.deepEqual(local.spaceTabSnapshot, oldSnapshot);
    hooks.localSet = null; clearSession();
    const second = pairedStores(); await second.spaces.dispatch({ action: 'get' });
    assert.deepEqual(second.spaces.spaces.find(space => space.id === 'a').spaceBookmarks, []);
});

test('pairing revoked between completed Favorite recovery and Space replay invalidates cached epoch proof', async () => {
    await seedExactSpaceReplay(); clearSession(); const second = pairedStores(); await second.favorites.initialize();
    assert(await second.favorites.ownershipPersistence.browserIdentity({ recovered: true }));
    await configureFavoriteContinuityPeer(chrome, PEER);
    await second.spaces.dispatch({ action: 'get' });
    assert.deepEqual(second.spaces.spaces.find(space => space.id === 'a').spaceBookmarks, []);
    assert.deepEqual(local.pinnedTabStatesById, {});
});

test('global Favorite ownership excludes an otherwise valid stale exact Space prefix', async () => {
    const first = await seedExactSpaceReplay();
    const snapshot = clone(local.spaceTabSnapshot), stamp = clone(local.spaceContinuityStamp);
    await first.favorites.dispatch(req('addTab', { tabId: 1 }));
    local.spaceTabSnapshot = snapshot; local.spaceContinuityStamp = stamp;
    clearSession(); const second = pairedStores(); await second.spaces.dispatch({ action: 'get' });
    assertGlobal(second, 1); assert.deepEqual(second.spaces.spaces.find(space => space.id === 'a').spaceBookmarks, [2]);
    assert.equal(local.pinnedTabStatesById[1], undefined);
});

for (const boundary of ['provisional-session', 'conditional-revoke', 'ack-persistence', 'final-session']) {
    test(`interrupted ${boundary} recovery cannot publish exact Space metadata`, async () => {
        await seedExactSpaceReplay(); clearSession();
        hooks.sessionSet = values => {
            const own = values[CONTINUITY_SESSION_KEY];
            if (own && (boundary === 'provisional-session' && own.phase === 'recovering' || boundary === 'final-session' && !own.phase)) throw new Error('recovery interrupted');
        };
        hooks.localSet = values => {
            if (boundary === 'ack-persistence' && values[CONTINUITY_LOCAL_KEY]?.peerGeneration) throw new Error('recovery interrupted');
        };
        hooks.witness = (command, value) => {
            if (boundary === 'conditional-revoke' && command === 'write' && value.expectedPeerGeneration) { peerGeneration = crypto.randomUUID(); receipt = null; }
        };
        const middle = pairedStores();
        if (boundary === 'conditional-revoke') await middle.spaces.dispatch({ action: 'get' });
        else {
            await assert.rejects(middle.spaces.dispatch({ action: 'get' }), /recovery interrupted/);
            assert.equal(session.spaceSession, undefined); assert.equal(middle.spaces.initialized, false);
        }
        hooks.sessionSet = null; hooks.localSet = null; hooks.witness = null;
        const second = pairedStores(); await second.spaces.dispatch({ action: 'get' });
        assert.deepEqual(second.spaces.spaces.find(space => space.id === 'a').spaceBookmarks, []);
        assert.deepEqual(local.pinnedTabStatesById, {});
    });
}

test('Space replay window uncertainty preserves snapshot and metadata until retry', async () => {
    await seedExactSpaceReplay(); clearSession(); const second = pairedStores(); await second.favorites.initialize();
    const previous = clone(local);
    hooks.window = () => { throw new Error('window read uncertain'); };
    await assert.rejects(second.spaces.dispatch({ action: 'get' }), /window read uncertain/);
    assert.equal(second.spaces.initialized, false);
    assert.deepEqual(local.spaceTabSnapshot, previous.spaceTabSnapshot);
    assert.deepEqual(local.spaceContinuityStamp, previous.spaceContinuityStamp);
    assert.deepEqual(local.pinnedTabStatesById, previous.pinnedTabStatesById);
    hooks.window = null; await second.spaces.dispatch({ action: 'get' });
    assert.deepEqual(second.spaces.spaces.find(space => space.id === 'a').spaceBookmarks, [2, 1]);
});

for (const change of ['move', 'revoke']) test(`Space replay revalidates ${change} during awaited window inspection`, async () => {
    await seedExactSpaceReplay(); clearSession(); const second = pairedStores(); await second.favorites.initialize();
    let once = false;
    hooks.window = async () => {
        if (once) return; once = true;
        if (change === 'move') tab(1).windowId = 2;
        else await configureFavoriteContinuityPeer(chrome, PEER);
    };
    if (change === 'move') {
        const before = clone(local);
        await assert.rejects(second.spaces.dispatch({ action: 'get' }), { code: 'SPACE_REPLAY_CHANGED' });
        assert.equal(second.spaces.initialized, false);
        assert.deepEqual(local.spaceTabSnapshot, before.spaceTabSnapshot);
        assert.deepEqual(local.pinnedTabStatesById, before.pinnedTabStatesById);
        hooks.window = null;
        await second.spaces.dispatch({ action: 'get' });
        assert.deepEqual(second.spaces.spaces.find(space => space.id === 'a').spaceBookmarks, [2, 1]);
        assert.equal(local.pinnedTabStatesById[1].bookmarkId, 'bookmark');
        assert.equal(local.tabNameOverridesById[1], 'First alias');
    } else {
        await second.spaces.dispatch({ action: 'get' });
        assert.deepEqual(second.spaces.spaces.find(space => space.id === 'a').spaceBookmarks, []);
        assert.equal(local.pinnedTabStatesById[1], undefined);
    }
});
