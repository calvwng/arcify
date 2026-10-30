/** Initial four-action real-module smoke with only Chrome storage/transport/APIs mocked. */
import assert from 'node:assert/strict';
import { SpaceStore } from '../../space-store.js';
import { createSpotlightBridge } from '../../spotlight-bridge.js';
import { BRIDGE_TYPE, BRIDGE_VERSION, PEER_KEY, PAIRING_GENERATION_KEY, SPACE_ACTIONS_FEATURE, SPACE_ACTION_COMMANDS } from '../../spotlight-bridge-protocol.js';

export async function assertInitialSpaceActionRoundTrips({ ArcifyBridgeClient, ArcifySpaceActionsClient, validateActionResult }) {
    const ARCIFY = 'a'.repeat(32), SPOTLIGHT = 'b'.repeat(32), WINDOW = 7;
    const copy = value => structuredClone(value);
    const event = () => { const listeners = new Set(); return { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn), emit: (...args) => [...listeners].forEach(fn => fn(...args)) }; };
    const local = { [PEER_KEY]: SPOTLIGHT, [PAIRING_GENERATION_KEY]: 'arcify-generation', spaceModelVersion: 2,
        spaces: [{ id: 'work', spaceUuid: 'work', name: 'Work', color: 'blue', bookmarkFolderId: 'work-folder', temporaryTabs: [1, 3, 11], spaceBookmarks: [2] }],
        pinnedTabStatesById: { 2: { bookmarkId: 'existing-pin', pinnedUrl: 'https://same.test/' } } };
    const session = { spaceSession: true, activeSpaces: { 7: 'work', 8: 'work' } };
    const peerLocal = { [PEER_KEY]: ARCIFY, [PAIRING_GENERATION_KEY]: 'spotlight-generation' };
    const area = data => ({
        async get(keys) {
            const names = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys || data);
            return Object.fromEntries(names.map(key => [key, copy(data[key] ?? keys?.[key])]));
        },
        async set(values) { Object.assign(data, copy(values)); }
    });
    const tabs = [
        { id: 1, windowId: WINDOW, index: 0, active: true, title: 'Today', url: 'https://same.test/' },
        { id: 2, windowId: WINDOW, index: 1, active: false, title: 'Existing same-URL pin', url: 'https://same.test/' },
        { id: 3, windowId: WINDOW, index: 2, active: false, title: 'New Tab', url: 'chrome://newtab/' },
        { id: 11, windowId: 8, index: 0, active: true, title: 'Other window', url: 'https://same.test/' }
    ];
    const bookmarks = [{ id: 'root', title: 'Arcify' }, { id: 'work-folder', parentId: 'root', title: 'Work' },
        { id: 'existing-pin', parentId: 'work-folder', title: 'Existing same-URL pin', url: 'https://same.test/' }];
    const sent = [], effects = [], replies = [];
    const sender = { id: SPOTLIGHT, url: `chrome-extension://${SPOTLIGHT}/background.js`, origin: `chrome-extension://${SPOTLIGHT}` };
    let handle, alterResponse = response => response;
    const previous = globalThis.chrome;
    globalThis.chrome = {
        runtime: { id: ARCIFY, getURL: path => `chrome-extension://${ARCIFY}/${path}`,
            sendMessage(peer, message, callback) {
                assert.equal(peer, ARCIFY); sent.push(copy(message));
                handle(copy(message), sender).then(response => { replies.push(copy(response)); callback(alterResponse(copy(response), message)); });
            } },
        storage: { local: area(local), session: area(session), sync: area({}) },
        windows: { async get(id) { assert([WINDOW, 8].includes(id)); return { id, type: 'normal' }; },
            async update() { assert.fail('Actions must not focus another window'); } },
        tabs: {
            async query(query = {}) { return copy(tabs.filter(tab => Object.entries(query).every(([key, value]) => tab[key] === value))); },
            async get(id) { const tab = tabs.find(tab => tab.id === id); assert(tab); return copy(tab); },
            async create(options) {
                const tab = { id: 100 + effects.length, index: tabs.length, title: 'Settings', ...options };
                if (options.active) for (const other of tabs) if (other.windowId === options.windowId) other.active = false;
                tabs.push(tab); effects.push(['createTab', copy(tab)]); return copy(tab);
            },
            async update() { assert.fail('Actions must not navigate or natively pin a tab'); },
            async move() { assert.fail('Actions must not reorder native tabs'); },
            async remove() { assert.fail('Actions must not close tabs'); }
        },
        bookmarks: {
            ...Object.fromEntries(['onMoved', 'onRemoved', 'onChanged', 'onCreated'].map(name => [name, event()])),
            async search(query) { return copy(bookmarks.filter(node => node.title === query.title)); },
            async get(id) { return copy(bookmarks.filter(node => node.id === id)); },
            async getChildren(id) { return copy(bookmarks.filter(node => node.parentId === id)); },
            async create(options) { const node = { id: `created-${effects.length}`, ...copy(options) }; bookmarks.push(node); effects.push(['createBookmark', copy(node)]); chrome.bookmarks.onCreated.emit(node.id, copy(node)); return copy(node); },
            async remove(id) { const index = bookmarks.findIndex(node => node.id === id); assert(index >= 0); const [node] = bookmarks.splice(index, 1); effects.push(['removeBookmark', id]); chrome.bookmarks.onRemoved.emit(id, { parentId: node.parentId, index, node: copy(node) }); }
        }
    };
    try {
        const store = new SpaceStore(); handle = createSpotlightBridge(store);
        const api = { runtime: { id: SPOTLIGHT }, storage: { local: area(peerLocal) } };
        const bridge = new ArcifyBridgeClient(api, 1000);
        const client = new ArcifySpaceActionsClient(api, bridge);
        const source = tabId => ({ windowId: WINDOW, tabId });
        const activate = tabId => { for (const tab of tabs) if (tab.windowId === WINDOW) tab.active = tab.id === tabId; };
        const execute = async (tabId, command, fields = {}) => {
            const scope = await client.read(source(tabId));
            const result = await client.execute(source(tabId), scope, command, fields);
            assert.equal(validateActionResult(command, result, scope.context), result);
            return result;
        };
        const beforeRead = effects.length;
        const today = await client.read(source(1));
        assert.equal(today.context.tab.section, 'today'); assert.equal(today.context.sourceTabId, 1);
        assert.equal(today.context.pairingGeneration, 'arcify-generation');
        assert.equal(effects.length, beforeRead, 'Negotiation and context reads have no native mutation');
        assert(sent.some(message => message.command === 'hello' && message.supportedFeatures.includes(SPACE_ACTIONS_FEATURE)));
        assert(replies.some(response => response.capabilities?.includes(SPACE_ACTIONS_FEATURE)));

        const unchangedTabs = copy(tabs), otherWindow = copy(tabs.find(tab => tab.id === 11));
        const pin = await execute(1, 'pinCurrentTab');
        assert.equal(pin.tabId, 1); assert.notEqual(pin.bookmarkId, 'existing-pin');
        assert.equal(local.pinnedTabStatesById[1].bookmarkId, pin.bookmarkId);
        assert.equal(bookmarks.find(node => node.id === pin.bookmarkId).url, 'https://same.test/');
        assert.deepEqual(tabs, unchangedTabs);
        const saved = await client.read(source(1));
        assert.equal(saved.context.tab.section, 'saved'); assert.equal(saved.context.tab.bookmark.id, pin.bookmarkId);
        const removal = await execute(1, 'removeCurrentPin', { confirmed: true });
        assert.deepEqual(removal, { command: 'removeCurrentPin', tabId: 1, bookmarkId: pin.bookmarkId });
        assert(!bookmarks.some(node => node.id === pin.bookmarkId));
        assert(bookmarks.some(node => node.id === 'existing-pin'));
        assert.equal(local.pinnedTabStatesById[2].bookmarkId, 'existing-pin');
        assert.equal(local.pinnedTabStatesById[1], undefined);
        assert.equal((await client.read(source(1))).context.tab.section, 'today');
        assert.deepEqual(tabs, unchangedTabs);

        activate(3);
        const helper = await client.read(source(3));
        assert.equal(helper.context.tab, null); assert.equal(helper.context.sourceTabId, 3);
        const folder = await execute(3, 'createSpaceFolder', { title: 'Pair contract folder' });
        assert.deepEqual(bookmarks.find(node => node.id === folder.folderId), { id: folder.folderId, parentId: 'work-folder', title: 'Pair contract folder' });
        const settings = await execute(3, 'openSettings');
        assert.equal(tabs.find(tab => tab.id === settings.tabId).url, `chrome-extension://${ARCIFY}/options.html`);
        assert.equal(tabs.find(tab => tab.id === settings.tabId).windowId, WINDOW);
        assert.equal(tabs.find(tab => tab.id === 3).url, 'chrome://newtab/');
        assert.deepEqual(tabs.find(tab => tab.id === 11), otherWindow);
        assert.deepEqual(store.active, { 7: 'work', 8: 'work' });
        assert.deepEqual(sent.filter(message => SPACE_ACTION_COMMANDS.includes(message.command)).map(message => message.command), ['pinCurrentTab', 'removeCurrentPin', 'createSpaceFolder', 'openSettings']);
        assert.equal(effects.length, 4, 'Exactly one native commit for each of four actions');

        activate(1);
        const scope = await client.read(source(1));
        const beforeRejected = effects.length;
        for (const [command, fields] of [['pinCurrentTab', { extra: true }], ['removeCurrentPin', {}], ['createSpaceFolder', { title: '' }]])
            await assert.rejects(client.execute(source(1), scope, command, fields), { code: 'INVALID_REQUEST' });
        await assert.rejects(client.execute(source(1), { ...scope, context: { ...scope.context, spaceId: 'changed' } }, 'pinCurrentTab', {}), { code: 'STALE_CONTEXT' });
        const raw = { type: BRIDGE_TYPE, version: BRIDGE_VERSION, requestId: 'negative-action', windowId: WINDOW,
            command: 'pinCurrentTab', context: scope.context, supportedFeatures: [SPACE_ACTIONS_FEATURE] };
        for (const [patch, code] of [[{ supportedFeatures: undefined }, 'UNSUPPORTED_FEATURE'], [{ supportedFeatures: ['unknown'] }, 'INVALID_REQUEST'],
            [{ extra: true }, 'INVALID_REQUEST'], [{ windowId: 8 }, 'INVALID_REQUEST'], [{ version: 2 }, 'VERSION_MISMATCH']]) {
            const response = await handle({ ...raw, ...patch }, sender);
            assert.equal(response.ok, false); assert.equal(response.error.code, code);
        }
        peerLocal[PAIRING_GENERATION_KEY] = 'changed-peer-generation';
        await assert.rejects(client.execute(source(1), scope, 'pinCurrentTab', {}), { code: 'DISCONNECTED' });
        peerLocal[PAIRING_GENERATION_KEY] = 'spotlight-generation';
        local[PAIRING_GENERATION_KEY] = 'changed-provider-generation';
        assert.equal((await handle(raw, sender)).error.code, 'UNAUTHORIZED');
        local[PAIRING_GENERATION_KEY] = 'arcify-generation';
        local[PEER_KEY] = '';
        await assert.rejects(client.execute(source(1), scope, 'pinCurrentTab', {}), { code: 'UNAUTHORIZED' });
        local[PEER_KEY] = SPOTLIGHT;
        assert.equal(effects.length, beforeRejected, 'Rejected requests never mutate native state');

        // A real commit followed by an unconfirmed reply is an error, never an
        // automatic retry. Exercise transport and exact-result validation paths.
        for (const [patch, code] of [[{ version: 2 }, 'VERSION_MISMATCH'], [{ folderId: '' }, 'INVALID_RESPONSE']]) {
            const fresh = await client.read(source(1)), commits = effects.length, requests = sent.length;
            alterResponse = (response, message) => message.command === 'createSpaceFolder' ? { ...response, ...patch } : response;
            await assert.rejects(client.execute(source(1), fresh, 'createSpaceFolder', { title: 'Unconfirmed folder' }), { code });
            alterResponse = response => response;
            assert.equal(effects.length, commits + 1, 'One actual commit despite unconfirmed reply');
            assert.equal(sent.slice(requests).filter(message => message.command === 'createSpaceFolder').length, 1, 'No mutation replay after failed confirmation');
        }
    } finally {
        if (previous === undefined) delete globalThis.chrome; else globalThis.chrome = previous;
    }
}
