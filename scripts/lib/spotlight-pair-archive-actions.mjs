/** Actual Archive client/provider and authoritative store; only Chrome APIs mocked. */
import assert from 'node:assert/strict';
import { SpaceStore } from '../../space-store.js';
import { createSpotlightBridge } from '../../spotlight-bridge.js';
import { PEER_KEY, PAIRING_GENERATION_KEY } from '../../spotlight-bridge-protocol.js';
export async function assertArchiveActionRoundTrips({ ArcifyBridgeClient, ArcifyArchiveActionsClient }) {
    const ARCIFY = 'a'.repeat(32), SPOTLIGHT = 'b'.repeat(32), copy = value => structuredClone(value), URL = 'https://same.test/';
    const local = { [PEER_KEY]: SPOTLIGHT, [PAIRING_GENERATION_KEY]: 'provider-generation', spaceModelVersion: 2,
        todayOrderRepresentation: { version: 1, inverted: false },
        spaces: [{ id: 'source', spaceUuid: 'source', name: 'Source', color: 'blue', bookmarkFolderId: 'source-folder', temporaryTabs: [1, 11], spaceBookmarks: [2] },
            { id: 'original', spaceUuid: 'original', name: 'Original', color: 'red', bookmarkFolderId: 'original-folder', temporaryTabs: [], spaceBookmarks: [] }],
        archivedTabs: [{ entryId: 'one', name: 'Archived one', url: URL, spaceId: 'original', archivedAt: 1, legacy: 'keep' }, { entryId: 'two', name: 'Archived two', url: URL, spaceId: 'source', archivedAt: 2 }],
        pinnedTabStatesById: { 2: { bookmarkId: 'pin', pinnedUrl: URL } } };
    const session = { spaceSession: true, activeSpaces: { 7: 'source', 8: 'source' } }, peerLocal = { [PEER_KEY]: ARCIFY, [PAIRING_GENERATION_KEY]: 'client-generation' };
    const area = data => ({ async get(keys) { const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys || data); return Object.fromEntries(list.map(key => [key, copy(data[key] ?? keys?.[key])])); }, async set(values) { Object.assign(data, copy(values)); } });
    const tabs = [{ id: 1, windowId: 7, index: 0, active: true, url: URL, title: 'Source' }, { id: 2, windowId: 7, index: 1, active: false, url: URL, title: 'Saved' }, { id: 11, windowId: 8, index: 0, active: true, url: URL, title: 'Other window' }];
    const bookmarks = [{ id: 'root', title: 'Arcify' }, { id: 'source-folder', title: 'Source', parentId: 'root' }, { id: 'original-folder', title: 'Original', parentId: 'root' }, { id: 'pin', title: 'Saved', url: URL, parentId: 'source-folder' }];
    const effects = [], sent = []; let handle, nextId = 100, dropReopenResponse = false;
    const sender = { id: SPOTLIGHT, url: `chrome-extension://${SPOTLIGHT}/background.js`, origin: `chrome-extension://${SPOTLIGHT}` };
    const previous = globalThis.chrome;
    const native = globalThis.chrome = { runtime: { id: ARCIFY, getURL: path => `chrome-extension://${ARCIFY}/${path}`,
        sendMessage(peerId, message, callback) { assert.equal(peerId, ARCIFY); sent.push(copy(message)); handle(copy(message), sender).then(response => { if (!(dropReopenResponse && message.command === 'reopenArchivedTab')) callback(copy(response)); }); } },
        storage: { local: area(local), session: area(session), sync: area({}) },
        windows: { get: async id => ({ id, type: 'normal' }), update: async (id, values) => { effects.push(['focus', id]); return { id, ...values }; } },
        tabs: { query: async (query = {}) => copy(tabs.filter(tab => Object.entries(query).every(([key, value]) => tab[key] === value))),
            get: async id => copy(tabs.find(tab => tab.id === id)),
            create: async data => { effects.push(['create', copy(data)]); const tab = { id: nextId++, index: tabs.length, title: 'Restored', ...data }; tabs.push(tab); return copy(tab); },
            update: async (id, values) => { const tab = tabs.find(tab => tab.id === id); if (values.active) tabs.filter(item => item.windowId === tab.windowId).forEach(item => { item.active = item.id === id; }); Object.assign(tab, values); return copy(tab); } },
        bookmarks: { search: async query => copy(bookmarks.filter(node => node.title === query.title)), get: async id => copy(bookmarks.filter(node => node.id === id)), getChildren: async id => copy(bookmarks.filter(node => node.parentId === id)) } };
    try {
        const store = new SpaceStore(); handle = createSpotlightBridge(store);
        const api = { runtime: { id: SPOTLIGHT }, tabs: native.tabs, storage: { local: area(peerLocal) } };
        const bridge = new ArcifyBridgeClient(api, 30), client = new ArcifyArchiveActionsClient(api, bridge), source = { windowId: 7, tabId: 1 };
        const scope = await client.read(source); assert.equal(scope.entries.length, 2); assert.equal(scope.context.spaceId, 'source'); assert.equal(scope.openIntent, null);
        const original = copy({ bookmarks, bindings: local.pinnedTabStatesById, other: tabs.filter(tab => tab.windowId === 8), otherSpace: session.activeSpaces[8] });
        const result = await client.execute(source, scope, 'one'); assert.equal(result.consumed, true); assert.equal(result.spaceId, 'original');
        assert.deepEqual(local.archivedTabs.map(entry => entry.entryId), ['two']); assert.equal(local.archiveReopenClaims.entries.one.phase, 'consumed');
        assert.equal(effects.filter(([kind]) => kind === 'create').length, 1); assert.equal(session.activeSpaces[7], 'original');
        assert.deepEqual({ bookmarks, bindings: local.pinnedTabStatesById, other: tabs.filter(tab => tab.windowId === 8), otherSpace: session.activeSpaces[8] }, original);
        const dispatched = sent.find(request => request.command === 'reopenArchivedTab'); const replay = await handle(dispatched, sender); assert.equal(replay.ok, true);
        assert.equal(effects.filter(([kind]) => kind === 'create').length, 1);
        // A newer explicit source/context can reopen the other exact twin. Lose
        // its transport response after durable consume, then prove no replay.
        const nextSource = { windowId: 7, tabId: result.tabId }, nextScope = await client.read(nextSource); dropReopenResponse = true;
        await assert.rejects(client.execute(nextSource, nextScope, 'two'), { code: 'TIMEOUT' });
        assert.equal(local.archivedTabs.length, 0); assert.equal(effects.filter(([kind]) => kind === 'create').length, 2);
        await assert.rejects(client.execute(nextSource, nextScope, 'two'));
        assert.equal(effects.filter(([kind]) => kind === 'create').length, 2);
        assert(sent.filter(request => request.command === 'reopenArchivedTab').every(request => !Object.hasOwn(request, 'url') && !Object.hasOwn(request, 'index')));
    } finally { if (previous === undefined) delete globalThis.chrome; else globalThis.chrome = previous; }
}
