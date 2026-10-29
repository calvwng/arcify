import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpaceStore } from '../../space-store.js';
import { getBridgeSnapshot, registerSpotlightBridge } from '../../spotlight-bridge.js';
import { registerSpotlightInvalidation } from '../../spotlight-invalidation.js';
import { runTabMenuAction } from '../../tab-menu-actions.js';
import { registerBookmarkListeners } from '../../bookmark-events.js';
import { BRIDGE_TYPE, BRIDGE_VERSION, PEER_KEY, responseFor } from '../../spotlight-bridge-protocol.js';

const PEER = 'a'.repeat(32), OTHER = 'b'.repeat(32);
const clone = value => structuredClone(value);
const event = () => ({
    listeners: new Set(), addListener(fn) { this.listeners.add(fn); }, removeListener(fn) { this.listeners.delete(fn); },
    emit(...args) { return Promise.all([...this.listeners].map(fn => fn(...args))); }
});
const space = (id, temporaryTabs = [], spaceBookmarks = []) => ({ id, name: id, color: 'blue', bookmarkFolderId: id, temporaryTabs, spaceBookmarks });

// These tests exercise real SpaceStore writes and actual protocol transport. Chrome
// storage/window/runtime edges and clocks are mocked; no browser QA is claimed.
async function fixture(t, { paired = true, register = true } = {}) {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const local = { spaces: [space('a', [1, 2, 11]), space('b', [12]), space('empty')], spaceModelVersion: 2,
        ...(paired ? { [PEER_KEY]: PEER } : {}) };
    const session = { spaceSession: true, activeSpaces: { 1: 'a', 2: 'b' } };
    const sync = { syncTabGroups: false };
    const tabs = [
        { id: 1, windowId: 1, title: 'One', url: 'https://one.test/', active: true },
        { id: 2, windowId: 1, title: 'Two', url: 'https://two.test/' },
        { id: 11, windowId: 2, title: 'Eleven', url: 'https://eleven.test/', active: true },
        { id: 12, windowId: 2, title: 'Twelve', url: 'https://twelve.test/' }
    ];
    const windows = [{ id: 1, type: 'normal' }, { id: 2, type: 'normal' }, { id: 3, type: 'popup' }, { id: 4, type: 'normal', incognito: true }];
    const nodes = { root: { id: 'root', title: 'Arcify' },
        ...Object.fromEntries(local.spaces.map(s => [s.id, { id: s.id, title: s.name, parentId: 'root' }])),
        saved: { id: 'saved', title: 'Saved pin', url: 'https://pin.test/', parentId: 'a' },
        outside: { id: 'outside', title: 'Unrelated' }, other: { id: 'other', title: 'Other', parentId: 'outside' } };
    const sent = [], writes = [], mutations = [], onChanged = event();
    const area = (data, name) => ({
        async get(keys) {
            const names = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys || data);
            return Object.fromEntries(names.map(key => [key, clone(data[key])]));
        },
        async set(values) {
            const changes = {};
            for (const [key, value] of Object.entries(values)) {
                if (JSON.stringify(data[key]) !== JSON.stringify(value)) changes[key] = { oldValue: clone(data[key]), newValue: clone(value) };
                data[key] = clone(value);
            }
            writes.push({ name, values: clone(values) });
            if (Object.keys(changes).length) await onChanged.emit(changes, name);
        }
    });
    const nativeEvents = Object.fromEntries(['onCreated', 'onUpdated', 'onRemoved', 'onReplaced', 'onActivated', 'onMoved', 'onAttached', 'onDetached'].map(key => [key, event()]));
    globalThis.chrome = {
        runtime: { id: 'c'.repeat(32), getURL: path => `chrome-extension://${'c'.repeat(32)}/${path}`,
            onMessage: event(), onMessageExternal: event(),
            sendMessage(peerId, message, callback) {
                sent.push({ peerId, message }); callback(responseFor(message, 'spotlight', { ok: true }));
            } },
        storage: { local: area(local, 'local'), session: area(session, 'session'), sync: area(sync, 'sync'), onChanged },
        windows: {
            async getAll() { return clone(windows.map(window => ({ ...window, tabs: tabs.filter(tab => tab.windowId === window.id) }))); },
            async get(id) { return clone(windows.find(window => window.id === id)); }
        },
        tabs: { ...nativeEvents, async query(query) { return clone(tabs.filter(tab => Object.entries(query).every(([key, value]) => tab[key] === value))); },
            async group(...args) { mutations.push(['group', ...args]); }, async move(...args) { mutations.push(['move', ...args]); } },
        tabGroups: { onRemoved: event(), onUpdated: event(), async query() { return []; } },
        bookmarks: { ...Object.fromEntries(['onCreated', 'onRemoved', 'onMoved', 'onChanged', 'onChildrenReordered', 'onImportBegan', 'onImportEnded'].map(key => [key, event()])),
            async search() { return [clone(nodes.root)]; }, async get(id) { return nodes[id] ? [clone(nodes[id])] : []; },
            async getChildren(id) { return clone(Object.values(nodes).filter(node => node.parentId === id)); },
            async getSubTree(id) { return [{ ...clone(nodes[id]), children: clone(Object.values(nodes).filter(node => node.parentId === id)) }]; } }
    };
    const store = new SpaceStore();
    await store.dispatch({ action: 'get' });
    writes.length = 0;
    const tick = async (ms = 100) => { t.mock.timers.tick(ms); await new Promise(resolve => setImmediate(resolve)); };
    let notifier;
    if (register) notifier = registerSpotlightInvalidation(store);
    t.after(() => notifier?.dispose());
    const settleStartup = async () => { await tick(); await tick(); sent.length = 0; };
    const patch = async change => {
        const before = clone(store.spaces), after = clone(before);
        change(after);
        await store.dispatch({ action: 'patch', before, after });
    };
    return { local, session, tabs, windows, nodes, sent, writes, mutations, store, tick, patch, settleStartup,
        get notifier() { return notifier; }, set notifier(value) { notifier = value; } };
}
const targets = f => f.sent.map(item => item.message.windowId);

test('worker startup sends a tiny correlated signal only to saved peer and normal non-private windows', async t => {
    const f = await fixture(t);
    await f.tick(99); assert.equal(f.sent.length, 0);
    await f.tick(1); assert.deepEqual(targets(f), [1]);
    await f.tick(99); assert.deepEqual(targets(f), [1]);
    await f.tick(1); assert.deepEqual(targets(f), [1, 2]);
    assert(f.sent.every(({ peerId, message }) => peerId === PEER && message.command === 'invalidate'
        && message.type === BRIDGE_TYPE && message.version === BRIDGE_VERSION));
    for (const { message } of f.sent) assert.deepEqual(Object.keys(message).sort(), ['command', 'requestId', 'type', 'version', 'windowId']);
    assert.notEqual(f.sent[0].message.requestId, f.sent[1].message.requestId);
    await f.tick(10000); assert.equal(f.sent.length, 2);
    assert.deepEqual(f.writes, []);
});

test('group-sync-off assignment and section reclassification notify only the affected window without tab events', async t => {
    const f = await fixture(t); await f.settleStartup();
    await f.store.dispatch({ action: 'assign', tabId: 1, spaceId: 'b', pinned: true });
    await f.tick(); await f.tick();
    assert.deepEqual(targets(f), [1]);
    assert.deepEqual(f.local.spaces.find(s => s.id === 'b').spaceBookmarks, [1]);
    assert.deepEqual(f.mutations, []);
});

test('logical tab order uses each window projection and ignores cross-window interleaving', async t => {
    const f = await fixture(t); await f.settleStartup();
    await f.patch(after => { after[0].temporaryTabs = [11, 1, 2]; });
    await f.tick(); assert.deepEqual(targets(f), []);
    await f.patch(after => { after[0].temporaryTabs = [2, 11, 1]; });
    await f.tick(); await f.tick();
    assert.deepEqual(targets(f), [1]);
    assert.deepEqual(f.mutations, []);
});

test('missing initialization or changed-tab window context invalidates conservatively', async t => {
    const f = await fixture(t); await f.settleStartup();
    const before = clone(f.store.spaces), after = clone(before);
    after[0].temporaryTabs.reverse();
    const live = f.store.liveTabs;
    for (const incomplete of [undefined, new Map([...live].filter(([id]) => id !== 1))]) {
        f.store.liveTabs = incomplete;
        await chrome.storage.onChanged.emit({ spaces: { oldValue: before, newValue: after } }, 'local');
        await f.tick(); await f.tick(); assert.deepEqual(targets(f), [1, 2]); f.sent.length = 0;
        await chrome.storage.onChanged.emit({ spaces: { oldValue: before, newValue: before } }, 'local');
        await f.tick(); assert.deepEqual(f.sent, []);
    }
    f.store.liveTabs = live;
});

test('assignment after a native move uses the current window map refreshed by persist', async t => {
    const f = await fixture(t); await f.settleStartup();
    f.tabs.find(tab => tab.id === 1).windowId = 2;
    await f.store.dispatch({ action: 'assign', tabId: 1, spaceId: 'b' });
    await f.tick(); await f.tick(); assert.deepEqual(targets(f), [2]);
});

test('empty-space metadata, creation, deletion and logical space ordering affect all normal windows', async t => {
    const f = await fixture(t); await f.settleStartup();
    for (const change of [
        after => { after[2].name = 'Renamed empty'; },
        after => { after[2].color = 'red'; },
        after => { after[2].bookmarkFolderId = 'changed-folder'; },
        after => { after.push(space('added')); },
        after => { after.splice(after.findIndex(s => s.id === 'added'), 1); }
    ]) {
        await f.patch(change); await f.tick(); await f.tick();
        assert.deepEqual(targets(f), [1, 2]); f.sent.length = 0;
    }
    // A generic stale panel patch cannot reorder the authoritative array.
    await f.patch(after => { after.reverse(); });
    await f.tick(); await f.tick(); assert.deepEqual(targets(f), []);
    const ids = f.store.spaces.map(space => space.id);
    await f.store.dispatch({ action: 'reorder', spaceId: ids.at(-1), anchorSpaceId: ids[0], position: 'before' });
    await f.tick(); await f.tick(); assert.deepEqual(targets(f), [1, 2]);
    assert.deepEqual(f.mutations, []);
});

test('activating an empty space invalidates just that window and no-op activation stays quiet', async t => {
    const f = await fixture(t); await f.settleStartup();
    await f.store.dispatch({ action: 'activate', windowId: 2, spaceId: 'empty' });
    await f.tick(); await f.tick(); assert.deepEqual(targets(f), [2]);
    f.sent.length = 0;
    await f.store.dispatch({ action: 'activate', windowId: 2, spaceId: 'empty' });
    await f.tick(); assert.deepEqual(targets(f), []);
});

test('restore bookkeeping, lastTab and snapshot no-op writes cannot create notification loops', async t => {
    const f = await fixture(t); await f.settleStartup();
    await f.patch(after => { after[0].lastTab = 2; after[0].uuid = 'legacy'; });
    await chrome.storage.local.set({ spaceTabSnapshot: [{ url: 'https://private.test/' }], unrelated: true });
    await chrome.storage.session.set({ restoredTabRanks: [[1, 0]] });
    await f.store.dispatch({ action: 'get' });
    await f.tick(); assert.deepEqual(targets(f), []);
    chrome.runtime.sendMessage = (peerId, message, callback) => {
        f.sent.push({ peerId, message });
        getBridgeSnapshot(f.store, message.windowId).then(() => callback(responseFor(message, 'spotlight', { ok: true })));
    };
    await f.patch(after => { after[0].temporaryTabs.reverse(); });
    await f.tick(); await f.tick(); await f.tick(10000);
    assert.deepEqual(targets(f), [1]);
});

test('large bursts coalesce and continuous changes do not starve delivery or exceed one send per tick', async t => {
    const f = await fixture(t); await f.settleStartup();
    for (let i = 0; i < 101; i++) await f.store.dispatch({ action: 'activate', windowId: 1, spaceId: i % 2 ? 'a' : 'empty' });
    await f.tick(99); assert.equal(f.sent.length, 0);
    await f.store.dispatch({ action: 'activate', windowId: 2, spaceId: 'empty' });
    await f.tick(1); assert.equal(f.sent.length, 1);
    for (let i = 0; i < 10; i++) f.notifier.invalidateAll();
    await f.tick(99); assert.equal(f.sent.length, 1);
    await f.tick(1); assert.equal(f.sent.length, 2);
    await f.tick(); assert.equal(f.sent.length, 3);
    await f.tick(10000); assert.equal(f.sent.length, 3);
});

test('real changes reverted within a burst still invalidate a snapshot that read the intermediate state', async t => {
    const f = await fixture(t); await f.settleStartup();
    await f.patch(after => { after[0].temporaryTabs.reverse(); });
    const intermediateOrder = await getBridgeSnapshot(f.store, 1);
    assert.deepEqual(intermediateOrder.spaces[0].temporaryTabIds, [2, 1]);
    await f.patch(after => { after[0].temporaryTabs.reverse(); });
    await f.store.dispatch({ action: 'activate', windowId: 1, spaceId: 'empty' });
    assert.equal((await getBridgeSnapshot(f.store, 1)).activeSpaceId, 'empty');
    await f.store.dispatch({ action: 'activate', windowId: 1, spaceId: 'a' });
    await f.tick(); assert.deepEqual(targets(f), [1]);
    const refreshed = await getBridgeSnapshot(f.store, 1);
    assert.deepEqual(refreshed.spaces[0].temporaryTabIds, [1, 2]);
    assert.equal(refreshed.activeSpaceId, 'a');
});

test('missing pairing is quiet and newly saved pairing refreshes once', async t => {
    const f = await fixture(t, { paired: false });
    await f.tick(); assert.deepEqual(f.sent, []);
    await chrome.storage.local.set({ [PEER_KEY]: 'invalid-peer' });
    await f.tick(); assert.deepEqual(f.sent, []);
    await chrome.storage.local.set({ [PEER_KEY]: PEER });
    await f.tick(); await f.tick(); assert.deepEqual(targets(f), [1, 2]);
});

test('revocation clears a queued signal and pairing replacement never sends queued work to old peer', async t => {
    const f = await fixture(t); await f.settleStartup();
    await f.patch(after => { after[0].color = 'red'; });
    await chrome.storage.local.set({ [PEER_KEY]: null });
    await f.tick(10000); assert.deepEqual(f.sent, []);
    await chrome.storage.local.set({ [PEER_KEY]: OTHER });
    await f.tick(); await f.tick();
    assert.deepEqual(f.sent.map(item => item.peerId), [OTHER, OTHER]);
});

test('peer is re-read after asynchronous lookup even before its storage event arrives', async t => {
    const f = await fixture(t); await f.settleStartup();
    const getAll = chrome.windows.getAll;
    chrome.windows.getAll = async (...args) => { const windows = await getAll(...args); f.local[PEER_KEY] = null; return windows; };
    await f.patch(after => { after[0].color = 'red'; });
    await f.tick(); assert.deepEqual(f.sent, []);
});

test('a slow old-peer reply cannot revive revoked queued windows', async t => {
    const f = await fixture(t); await f.settleStartup();
    let finish;
    chrome.runtime.sendMessage = (peerId, message, callback) => {
        f.sent.push({ peerId, message }); finish = () => callback(responseFor(message, 'spotlight', { ok: true }));
    };
    f.notifier.invalidateAll(); await f.tick();
    await chrome.storage.local.set({ [PEER_KEY]: null }); finish();
    await new Promise(resolve => setImmediate(resolve)); await f.tick(10000);
    assert.deepEqual(targets(f), [1]);
});

test('absent and old companions drop the burst without retries, state writes or unhandled rejection', async t => {
    const f = await fixture(t); await f.settleStartup();
    for (const failure of ['unavailable', 'unsupported', 'bad-ack']) {
        f.sent.length = 0; f.writes.length = 0;
        chrome.runtime.sendMessage = (peerId, message, callback) => {
            f.sent.push({ peerId, message });
            if (failure === 'unavailable') {
                chrome.runtime.lastError = { message: 'Receiving end does not exist' }; callback(); delete chrome.runtime.lastError;
            } else if (failure === 'unsupported') callback(responseFor(message, 'spotlight', { ok: false, error: { code: 'INVALID_REQUEST' } }));
            else callback({ ...responseFor(message, 'spotlight', { ok: true }), requestId: 'different' });
        };
        f.notifier.invalidateAll(); await f.tick(); await f.tick(10000);
        assert.equal(f.sent.length, 1); assert.deepEqual(f.writes, []);
    }
});

test('timeouts have one in-flight request and never schedule polling', async t => {
    const f = await fixture(t); await f.settleStartup();
    chrome.runtime.sendMessage = (peerId, message) => f.sent.push({ peerId, message });
    f.notifier.invalidateAll(); await f.tick();
    await f.tick(999); assert.equal(f.sent.length, 1);
    await f.tick(1); await f.tick(10000); assert.equal(f.sent.length, 1);
});

test('a change during a successful in-flight notification gets a later refresh', async t => {
    const f = await fixture(t); await f.settleStartup();
    let finish;
    chrome.runtime.sendMessage = (peerId, message, callback) => {
        f.sent.push({ peerId, message }); finish = () => callback(responseFor(message, 'spotlight', { ok: true }));
    };
    await f.store.dispatch({ action: 'activate', windowId: 1, spaceId: 'empty' }); await f.tick();
    await f.store.dispatch({ action: 'activate', windowId: 1, spaceId: 'b' }); finish();
    await new Promise(resolve => setImmediate(resolve)); await f.tick();
    assert.deepEqual(targets(f), [1, 1]); finish();
});

test('a genuinely new change during an in-flight timeout survives, without retrying the failed window batch', async t => {
    const f = await fixture(t); await f.settleStartup();
    chrome.runtime.sendMessage = (peerId, message) => f.sent.push({ peerId, message });
    f.notifier.invalidateAll(); await f.tick();
    await f.store.dispatch({ action: 'activate', windowId: 2, spaceId: 'empty' });
    await f.tick(1000);
    await f.tick(); assert.deepEqual(targets(f), [1, 2]);
    await f.tick(1000); await f.tick(10000); assert.deepEqual(targets(f), [1, 2]);
});

test('a window closed during delivery does not block notifying other windows', async t => {
    const f = await fixture(t); await f.settleStartup();
    chrome.runtime.sendMessage = (peerId, message, callback) => {
        f.sent.push({ peerId, message });
        callback(responseFor(message, 'spotlight', message.windowId === 1
            ? { ok: false, error: { code: 'INVALID_WINDOW' } } : { ok: true }));
    };
    f.notifier.invalidateAll(); await f.tick(); await f.tick(); await f.tick(10000);
    assert.deepEqual(targets(f), [1, 2]);
});

test('worker replacement re-reads saved peer and refreshes current normal windows without durable signal state', async t => {
    const f = await fixture(t); await f.settleStartup();
    f.notifier.dispose(); f.notifier = registerSpotlightInvalidation(f.store);
    await f.tick(); await f.tick(); await f.tick(10000);
    assert.deepEqual(targets(f), [1, 2]); assert.deepEqual(f.writes, []);
});

test('bridge registration installs sender and exact bookmark binding changes target their live window', async t => {
    const f = await fixture(t, { register: false });
    f.notifier = registerSpotlightBridge(f.store); await f.settleStartup();
    await chrome.storage.local.set({ pinnedTabStatesById: { 1: { bookmarkId: 'saved', pinnedUrl: 'https://pin.test/' } } });
    await f.tick(); assert.deepEqual(targets(f), [1]); f.sent.length = 0;
    await chrome.storage.local.set({ pinnedTabStatesById: { 1: { bookmarkId: 'saved', pinnedUrl: 'https://other.test/' } } });
    await f.tick(); assert.deepEqual(targets(f), [1]);
});

test('alias additions, renames and removals invalidate only exact live tab windows', async t => {
    const f = await fixture(t); await f.settleStartup();
    f.tabs.find(tab => tab.id === 11).url = f.tabs.find(tab => tab.id === 1).url;
    for (const overrides of [
        { 1: { name: 'First alias', originalDomain: 'one.test' } },
        { 1: { name: 'Renamed alias', originalDomain: 'one.test' } },
        {}
    ]) {
        await chrome.storage.local.set({ tabNameOverridesById: overrides });
        await f.tick(); await f.tick();
        assert.deepEqual(targets(f), [1]); f.sent.length = 0;
    }
    await chrome.storage.local.set({ tabNameOverridesById: { 11: { name: 'Same URL in the other window' } } });
    await f.tick(); await f.tick(); assert.deepEqual(targets(f), [2]);
});

test('alias bookkeeping, no-op writes, non-local storage and dead tab IDs stay quiet', async t => {
    const f = await fixture(t); await f.settleStartup();
    const before = { 1: { name: 'Visible alias', originalDomain: 'one.test' } };
    const after = { 1: { name: 'Visible alias', originalDomain: 'different.test' }, 999: { name: 'Closed tab' } };
    for (const [oldValue, newValue, area] of [[before, before, 'local'], [before, after, 'local'], [{}, after, 'sync'], [{}, after, 'session']]) {
        await chrome.storage.onChanged.emit({ tabNameOverridesById: { oldValue, newValue } }, area);
        await f.tick(); await f.tick(); assert.deepEqual(targets(f), []);
    }
});

test('alias bursts resolve current windows after a tab moves and never disclose alias text', async t => {
    const f = await fixture(t); await f.settleStartup();
    await chrome.storage.local.set({ tabNameOverridesById: { 1: { name: 'Private title' } } });
    await chrome.storage.local.set({ tabNameOverridesById: { 1: { name: 'Changed private title' } } });
    f.tabs.find(tab => tab.id === 1).windowId = 2;
    await f.tick(); await f.tick(); assert.deepEqual(targets(f), [2]);
    assert.deepEqual(Object.keys(f.sent[0].message).sort(), ['command', 'requestId', 'type', 'version', 'windowId']);
    await f.tick(10000); assert.equal(f.sent.length, 1);
});

test('existing relevant bookmark listener signals saved pin/title/order changes but ignores unrelated bookmarks', async t => {
    const f = await fixture(t); await f.settleStartup();
    const externalSend = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = (...args) => typeof args[0] === 'string' ? externalSend(...args) : Promise.resolve();
    registerBookmarkListeners(() => f.notifier.invalidateAll());
    await chrome.bookmarks.onChanged.emit('other'); await f.tick(); await f.tick();
    assert.deepEqual(f.sent, []);
    for (const operation of [
        () => chrome.bookmarks.onChanged.emit('saved'),
        () => chrome.bookmarks.onChildrenReordered.emit('a'),
        () => chrome.bookmarks.onCreated.emit('new', { parentId: 'a' }),
        () => chrome.bookmarks.onRemoved.emit('saved', { parentId: 'a' }),
        () => chrome.bookmarks.onMoved.emit('saved', { parentId: 'outside', oldParentId: 'a' })
    ]) {
        await operation(); await f.tick(0); await f.tick(); await f.tick(); await f.tick();
        assert.deepEqual(targets(f), [1, 2]); f.sent.length = 0;
    }
});

test('shared Favorite records and exact session bindings invalidate every normal window', async t => {
    const f = await fixture(t); await f.settleStartup();
    for (const [area, values] of [
        ['local', { persistentFavorites: [{ id: 'saved', title: 'Saved', url: 'https://saved.test/', sourceBookmarkId: null }] }],
        ['session', { favoriteSession: { version: 1, bindings: [{ favoriteId: 'saved', windowId: 1, tabId: 1 }], attempts: [] } }]
    ]) {
        await chrome.storage[area].set(values); await f.tick(); await f.tick(); await f.tick();
        assert.deepEqual(targets(f), [1, 2]); f.sent.length = 0;
    }
});

test('auxiliary Favorite icon cache changes stay sidebar-local and do not invalidate Spotlight snapshots', async t => {
    const f = await fixture(t); await f.settleStartup();
    await chrome.storage.local.set({ favoriteIconCache: { version: 1, entries: [] } });
    await f.tick(); await f.tick(); await f.tick();
    assert.deepEqual(targets(f), []);
});


test('combined Space metadata and exact Tab aliases retain scoped invalidation and strict snapshots', async t => {
    const f = await fixture(t); await f.settleStartup();
    chrome.tabs.get = async id => clone(f.tabs.find(tab => tab.id === id));
    chrome.bookmarks.update = async (id, changes) => Object.assign(f.nodes[id], clone(changes));
    await f.store.dispatch({ action: 'metadata', spaceId: 'a', changes: { icon: 'rocket' } });
    await f.tick(); await f.tick(); assert.deepEqual(targets(f), [], 'Sidebar-local icons do not widen v1');
    const target = { type: 'tabMenuAction', windowId: 1, spaceId: 'a', bookmarkFolderId: 'a', tabId: 1 };
    const initial = await runTabMenuAction(f.store, { ...target, action: 'describe' });
    await runTabMenuAction(f.store, { ...target, action: 'rename', value: 'Exact window alias', expected: initial.expected });
    await f.tick(); await f.tick(); assert.deepEqual(targets(f), [1]); f.sent.length = 0;
    await f.store.dispatch({ action: 'metadata', spaceId: 'a', changes: { name: 'Updated name', color: 'cyan' } });
    await f.tick(); await f.tick(); assert.deepEqual(targets(f), [1, 2]);
    const snapshot = await getBridgeSnapshot(f.store, 1);
    assert.equal(snapshot.tabs.find(tab => tab.id === 1).title, 'Exact window alias');
    assert.equal(snapshot.spaces[0].name, 'Updated name'); assert.equal(snapshot.spaces[0].color, 'cyan');
    assert.equal(Object.hasOwn(snapshot.spaces[0], 'icon'), false);
    assert.equal(f.local.spaceRegistry.a.icon, 'rocket'); assert.equal(f.store.active[1], 'a');
    assert(f.sent.every(({ message }) => !JSON.stringify(message).includes('Exact window alias')));
});

test('native split creation including ID zero and End Split refresh only the exact normal window', async t => {
    const f = await fixture(t); await f.settleStartup();
    for (const splitViewId of [0, -1]) {
        await chrome.tabs.onUpdated.emit(1, { splitViewId }, { ...f.tabs[0], splitViewId });
        await f.tick(); await f.tick(); assert.deepEqual(targets(f), [1]); f.sent.length = 0;
    }
    await chrome.tabs.onUpdated.emit(11, { splitViewId: 8 });
    await f.tick(); await f.tick(); assert.deepEqual(targets(f), [2]); f.sent.length = 0;
    await chrome.tabs.onUpdated.emit(1, { title: 'Unrelated native title' }, f.tabs[0]);
    await f.tick(); assert.deepEqual(targets(f), []);
    f.notifier.dispose();
    await chrome.tabs.onUpdated.emit(1, { splitViewId: -1 }, f.tabs[0]);
    await f.tick(); assert.deepEqual(targets(f), []);
});


test('opted-in shared reader refreshes after remote title and ownership changes without broadening legacy peers', async t => {
 const f=await fixture(t); await f.settleStartup(); f.store.sharedTodayWindows=new Set([1]);
 await chrome.tabs.onUpdated.emit(11,{title:'Changed remote page'},f.tabs.find(t=>t.id===11));
 await f.tick();await f.tick();assert.deepEqual(targets(f),[1]);f.sent.length=0;
 await f.store.dispatch({action:'assign',tabId:11,spaceId:'b'});await f.tick();await f.tick();
 assert.deepEqual(new Set(targets(f)),new Set([1,2]));
 assert(f.sent.every(item=>!JSON.stringify(item.message).includes('Changed remote page')));
});


test('multiple subscribed shared windows drain a finite notification batch without ping-pong',async t=>{
 const f=await fixture(t);await f.settleStartup();f.store.sharedTodayWindows=new Set([1,2]);
 await chrome.tabs.onUpdated.emit(11,{title:'changed'},f.tabs.find(t=>t.id===11));
 for(let i=0;i<20;i++)await f.tick();assert.deepEqual(new Set(targets(f)),new Set([1,2]));assert.equal(f.sent.length,2);
 for(let i=0;i<20;i++)await f.tick();assert.equal(f.sent.length,2);
});


test('shared subscribers refresh remote aliases and pin bindings with bounded fanout',async t=>{
 const f=await fixture(t);await f.settleStartup();f.store.sharedTodayWindows=new Set([1,2]);
 await chrome.storage.local.set({tabNameOverridesById:{11:{name:'Remote alias'}}});
 for(let i=0;i<5;i++)await f.tick();assert.deepEqual(new Set(targets(f)),new Set([1,2]));assert.equal(f.sent.length,2);f.sent.length=0;
 await chrome.storage.local.set({pinnedTabStatesById:{11:{bookmarkId:'saved',pinnedUrl:'https://eleven.test/'}}});
 for(let i=0;i<10;i++)await f.tick();assert.deepEqual(new Set(targets(f)),new Set([1,2]));assert.equal(f.sent.length,2);
});
