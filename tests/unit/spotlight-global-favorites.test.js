import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createSpotlightBridge } from '../../spotlight-bridge.js';
import { PEER_KEY, PAIRING_GENERATION_KEY, GLOBAL_FAVORITES_FEATURE, validateRequest } from '../../spotlight-bridge-protocol.js';
const SELF = 'a'.repeat(32), PEER = 'b'.repeat(32);
const sender = { id: PEER, origin: `chrome-extension://${PEER}` };
const request = (command, payload = {}) => ({ type: 'arcify-bridge', version: 1, requestId: crypto.randomUUID(), windowId: 1, command, ...payload });
let state, store, handle;
beforeEach(() => {
    state = { ordinary: true, writes: [], mutations: [], inQueue: false, local: { [PEER_KEY]: PEER }, session: {}, tab: { id: 10, windowId: 1, pinned: false, title: 'Current', url: 'https://current.test/' } };
    const area = data => ({ get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, data[key]])), set: async values => { state.writes.push(values); Object.assign(data, values); } });
    globalThis.chrome = { runtime: { id: SELF, getURL: path => `chrome-extension://${SELF}/${path}` }, storage: { local: area(state.local), session: area(state.session) },
        windows: { get: async id => ({ id, type: 'normal' }), update: async () => {} },
        tabs: { query: async () => [state.tab], get: async () => state.tab, update: async (id, values) => { state.mutations.push(values); return Object.assign(state.tab, values); } },
        bookmarks: { getChildren: async () => [] } };
    store = { spaces: [], active: {}, discoverBookmarkSpaces: async () => false,
        async run(operation) { assert.equal(state.inQueue, false); state.inQueue = true; try { return await operation(); } finally { state.inQueue = false; } },
        favoriteStore: {
            requiresOrdinaryCapability: async () => { assert(state.inQueue, 'capability reads stay on the single-writer queue'); return state.ordinary; },
            read: async () => ({ favorites: [{ id: 'saved', title: 'Saved', url: 'https://saved.test/', sourceBookmarkId: null, tabId: 10 }] }),
            open: async () => { state.mutations.push('open'); return state.tab; }
        } };
    handle = createSpotlightBridge(store);
});

for (const command of ['hello', 'snapshot', 'openFavorite', 'activateTab', 'navigateTab', 'activateSpace', 'openTab', 'openBookmark']) test(`legacy ${command} is rejected before journal or requested mutations`, async () => {
    const payloads = { openFavorite: { favoriteId: 'saved' }, activateTab: { tabId: 10 }, navigateTab: { tabId: 10, url: 'https://new.test/' }, activateSpace: { spaceId: 'work' }, openTab: { url: 'https://new.test/' }, openBookmark: { spaceId: 'work', bookmarkId: 'saved' } };
    const response = await handle(request(command, payloads[command]), sender);
    assert.equal(response.error.code, 'UNSUPPORTED_FEATURE'); assert.deepEqual(state.writes, []); assert.deepEqual(state.mutations, []);
});

test('explicit ordinary capability preserves five-key identity and truthful native pin bit', async () => {
    const hello = await handle(request('hello', { supportedFeatures: [GLOBAL_FAVORITES_FEATURE] }), sender);
    assert.equal(hello.ok, true); assert(hello.capabilities.includes(GLOBAL_FAVORITES_FEATURE));
    assert.deepEqual(Object.keys(hello.snapshot.favorites[0]).sort(), ['id', 'title', 'url', 'sourceBookmarkId', 'tabId'].sort());
    assert.equal(hello.snapshot.tabs[0].pinned, false); assert.equal(hello.snapshot.tabs[0].spaceId, null);
    const opened = await handle(request('openFavorite', { favoriteId: 'saved', supportedFeatures: [GLOBAL_FAVORITES_FEATURE] }), sender);
    assert.equal(opened.ok, true); assert.equal(opened.tabId, 10); assert.deepEqual(state.mutations, ['open']);
});

test('old pinned-only peers remain usable while preference and ownership are pinned', async () => {
    state.ordinary = false; state.tab.pinned = true;
    const hello = await handle(request('hello'), sender); assert.equal(hello.ok, true);
    const opened = await handle(request('openFavorite', { favoriteId: 'saved' }), sender); assert.equal(opened.ok, true);
});

test('preference switch between initial preflight and queued action rejects before native mutation', async () => {
    state.ordinary = false; state.tab.pinned = true;
    const previousSet = chrome.storage.session.set;
    chrome.storage.session.set = async values => { await previousSet(values); state.ordinary = true; };
    const response = await handle(request('openFavorite', { favoriteId: 'saved' }), sender);
    assert.equal(response.error.code, 'UNSUPPORTED_FEATURE'); assert.deepEqual(state.mutations, []);
});

test('legacy replay of previously successful pinned command is gated after ordinary mode begins', async () => {
    state.ordinary = false; state.tab.pinned = true;
    const action = request('openFavorite', { favoriteId: 'saved' }); assert.equal((await handle(action, sender)).ok, true);
    state.ordinary = true; state.tab.pinned = false; state.mutations.length = 0;
    assert.equal((await handle(action, sender)).error.code, 'UNSUPPORTED_FEATURE'); assert.deepEqual(state.mutations, []);
});

test('feature markers are strict bounded arrays with no unknown or duplicate capabilities', () => {
    for (const supportedFeatures of [null, true, GLOBAL_FAVORITES_FEATURE, [], ['other'], [GLOBAL_FAVORITES_FEATURE, GLOBAL_FAVORITES_FEATURE]]) {
        assert.throws(() => validateRequest(request('hello', { supportedFeatures }), ['hello']), { code: 'INVALID_REQUEST' });
    }
});


test('provider pairing A to B to A while preflight waits rejects the old request before mutation', async () => {
    const run = store.run; let changed = false;
    store.run = async operation => {
        if (!changed) { changed = true; state.local[PAIRING_GENERATION_KEY] = crypto.randomUUID(); }
        return run(operation);
    };
    const result = await handle(request('openFavorite', { favoriteId: 'saved', supportedFeatures: [GLOBAL_FAVORITES_FEATURE] }), sender);
    assert.equal(result.error.code, 'UNAUTHORIZED'); assert.deepEqual(state.mutations, []); assert.deepEqual(state.writes, []);
});

test('provider revocation during snapshot construction prevents an old-generation read response', async () => {
    const read = store.favoriteStore.read;
    store.favoriteStore.read = async () => { state.local[PAIRING_GENERATION_KEY] = crypto.randomUUID(); return read(); };
    const result = await handle(request('hello', { supportedFeatures: [GLOBAL_FAVORITES_FEATURE] }), sender);
    assert.equal(result.error.code, 'UNAUTHORIZED'); assert.equal(result.snapshot, undefined);
});


for (const changed of ['pairing', 'mode']) test(`change to ${changed} during execution snapshot cannot authorize a later mutation`, async () => {
    state.ordinary = false; state.tab.pinned = true; let reads = 0; const read = store.favoriteStore.read;
    store.favoriteStore.read = async () => {
        if (++reads === 2) {
            if (changed === 'pairing') state.local[PAIRING_GENERATION_KEY] = crypto.randomUUID();
            else state.ordinary = true;
        }
        return read();
    };
    const response = await handle(request('openFavorite', { favoriteId: 'saved' }), sender);
    assert.equal(response.error.code, changed === 'pairing' ? 'UNAUTHORIZED' : 'UNSUPPORTED_FEATURE');
    assert.deepEqual(state.mutations, []);
});
