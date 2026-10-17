/** Real extended clients/provider with only browser transport and native APIs mocked. */
import assert from 'node:assert/strict';
import { SpaceStore } from '../../space-store.js';
import { createSpotlightBridge } from '../../spotlight-bridge.js';
import { PEER_KEY, PAIRING_GENERATION_KEY, TAB_ACTION_COMMANDS, SPACE_NAVIGATION_COMMANDS } from '../../spotlight-bridge-protocol.js';

export async function assertExtendedActionRoundTrips({ ArcifyBridgeClient, ArcifySpaceActionsClient, ArcifyTabActionsClient }) {
    const ARCIFY = 'a'.repeat(32), SPOTLIGHT = 'b'.repeat(32), WINDOW = 7, URL = 'https://same.test/';
    const copy = value => structuredClone(value);
    const local = { [PEER_KEY]: SPOTLIGHT, [PAIRING_GENERATION_KEY]: 'arcify-generation', spaceModelVersion: 2,
        todayOrderRepresentation: { version: 1, inverted: false },
        spaces: [
            { id: 'work', spaceUuid: 'work', name: 'Work', color: 'blue', bookmarkFolderId: 'work-folder', temporaryTabs: [1], spaceBookmarks: [2, 12] },
            { id: 'other', spaceUuid: 'other', name: 'Other', color: 'red', bookmarkFolderId: 'other-folder', temporaryTabs: [4, 14], spaceBookmarks: [] }
        ], pinnedTabStatesById: { 2: { bookmarkId: 'pin', pinnedUrl: URL }, 12: { bookmarkId: 'pin', pinnedUrl: URL } },
        tabNameOverridesById: { 1: { name: 'My Today', originalDomain: 'same.test' } } };
    const session = { spaceSession: true, activeSpaces: { 7: 'work', 8: 'work' } };
    const peerLocal = { [PEER_KEY]: ARCIFY, [PAIRING_GENERATION_KEY]: 'spotlight-generation' };
    const area = data => ({
        async get(keys) {
            const names = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys || data);
            return Object.fromEntries(names.map(key => [key, copy(data[key] ?? keys?.[key])]));
        }, async set(values) { Object.assign(data, copy(values)); }
    });
    const tabs = [
        { id: 1, windowId: WINDOW, index: 0, active: true, title: 'Today', url: URL },
        { id: 2, windowId: WINDOW, index: 1, active: false, title: 'Saved', url: URL },
        { id: 4, windowId: WINDOW, index: 2, active: false, title: 'Other Today', url: URL },
        { id: 12, windowId: 8, index: 0, active: true, title: 'Other window pin copy', url: 'https://navigated.test/' },
        { id: 14, windowId: 8, index: 1, active: false, title: 'Other window Today', url: URL }
    ];
    const bookmarks = [{ id: 'root', title: 'Arcify' }, { id: 'work-folder', parentId: 'root', title: 'Work' },
        { id: 'other-folder', parentId: 'root', title: 'Other' }, { id: 'nested', parentId: 'work-folder', title: 'Nested' },
        { id: 'pin', parentId: 'nested', title: 'Saved', url: URL }, { id: 'twin', parentId: 'nested', title: 'Same URL, independent', url: URL }];
    const sent = [], effects = [];
    const activate = tabId => { for (const tab of tabs) if (tab.windowId === WINDOW) tab.active = tab.id === tabId; };
    const sender = { id: SPOTLIGHT, url: `chrome-extension://${SPOTLIGHT}/background.js`, origin: `chrome-extension://${SPOTLIGHT}` };
    let handle, alterResponse = response => response, nextId = 100;
    const previous = globalThis.chrome;
    globalThis.chrome = {
        runtime: { id: ARCIFY, getURL: path => `chrome-extension://${ARCIFY}/${path}`,
            async getContexts() { return [{ contextType: 'OFFSCREEN_DOCUMENT', documentUrl: `chrome-extension://${ARCIFY}/offscreen.html` }]; },
            sendMessage(peer, message, callback) {
                if (typeof peer === 'object') {
                    assert.equal(peer.target, 'offscreen'); assert.equal(peer.type, 'copyToClipboard');
                    effects.push(['clipboard', peer.text]); return Promise.resolve({ success: true, text: peer.text });
                }
                assert.equal(peer, ARCIFY); sent.push(copy(message));
                handle(copy(message), sender).then(response => callback(alterResponse(copy(response), message)));
            } },
        offscreen: { async createDocument() { assert.fail('Existing clipboard offscreen context should be reused'); } },
        storage: { local: area(local), session: area(session), sync: area({}) },
        windows: { async get(id) { assert([WINDOW, 8].includes(id)); return { id, type: 'normal' }; },
            async update(id, values) { assert.equal(id, WINDOW); assert.deepEqual(values, { focused: true }); effects.push(['focusWindow', id]); return { id, type: 'normal' }; } },
        tabs: {
            async query(query = {}) { return copy(tabs.filter(tab => Object.entries(query).every(([key, value]) => tab[key] === value))); },
            async get(id) { const tab = tabs.find(tab => tab.id === id); assert(tab); return copy(tab); },
            async create() { assert.fail('Extended actions must not create tabs through a fallback'); },
            async update(id, values) {
                const tab = tabs.find(tab => tab.id === id); assert(tab); assert.equal(tab.windowId, WINDOW);
                assert(Object.keys(values).every(key => ['active', 'muted'].includes(key)), 'No URL navigation or native pin mutation');
                if (values.active) activate(id);
                if (Object.hasOwn(values, 'muted')) tab.mutedInfo = { muted: values.muted };
                effects.push(['updateTab', id, copy(values)]); return copy(tab);
            },
            async duplicate(id) {
                const source = tabs.find(tab => tab.id === id); assert(source);
                const duplicate = { ...copy(source), id: nextId++, index: tabs.length, active: true };
                tabs.push(duplicate); activate(duplicate.id); effects.push(['duplicate', id, duplicate.id]); return copy(duplicate);
            },
            async move() { assert.fail('Extended actions must not reorder native tabs'); },
            async remove() { assert.fail('Extended actions must not close tabs'); }
        },
        bookmarks: {
            async search(query) { return copy(bookmarks.filter(node => node.title === query.title)); },
            async get(id) { return copy(bookmarks.filter(node => node.id === id)); },
            async getChildren(id) { return copy(bookmarks.filter(node => node.parentId === id)); },
            async update(id, values) { const node = bookmarks.find(node => node.id === id); assert(node); Object.assign(node, copy(values)); effects.push(['updateBookmark', id, copy(values)]); return copy(node); },
            async create() { assert.fail('Extended actions must not create replacement bookmarks'); },
            async remove() { assert.fail('Extended actions must not remove bookmarks'); }
        }
    };
    try {
        const store = new SpaceStore(); handle = createSpotlightBridge(store);
        const api = { runtime: { id: SPOTLIGHT }, storage: { local: area(peerLocal) } };
        const bridge = new ArcifyBridgeClient(api, 1000);
        const space = new ArcifySpaceActionsClient(api, bridge), tab = new ArcifyTabActionsClient(api, bridge);
        const source = tabId => ({ windowId: WINDOW, tabId });
        const execute = async (client, tabId, command, fields = {}) => client.execute(source(tabId), await client.read(source(tabId)), command, fields);
        const initial = await tab.read(source(1));
        assert.equal(initial.context.tab.alias, 'My Today'); assert.equal(initial.context.tab.muted, false);
        const navigation = await space.read(source(1));
        const destination = { spaceId: 'other', bookmarkFolderId: 'other-folder' };
        assert.deepEqual(navigation.navigation.destinations, [{ ...destination, name: 'Other' }]);
        assert.equal(effects.length, 0, 'Negotiation and reads have no native side effects');
        const otherWindow = copy(tabs.filter(item => item.windowId === 8)), beforeTabs = copy(tabs);
        const rename = await execute(tab, 1, 'renameCurrentTab', { title: 'Renamed Today' });
        assert.deepEqual(rename, { command: 'renameCurrentTab', tabId: 1, bookmarkId: null, title: 'Renamed Today' });
        assert.equal(local.tabNameOverridesById[1].name, 'Renamed Today'); assert.deepEqual(tabs, beforeTabs);
        assert.equal((await execute(tab, 1, 'copyCurrentLink')).url, URL);
        assert.deepEqual(effects.filter(item => item[0] === 'clipboard'), [['clipboard', URL]]);
        for (const muted of [true, false]) {
            assert.equal((await execute(tab, 1, 'setCurrentTabMuted', { muted })).muted, muted);
            assert.equal(tabs.find(item => item.id === 1).mutedInfo.muted, muted);
        }
        const duplicate = await execute(tab, 1, 'duplicateCurrentTab');
        assert.equal(duplicate.tabId, 100); assert(store.spaces.find(item => item.id === 'work').temporaryTabs.includes(100));
        assert.equal(local.tabNameOverridesById[100], undefined); assert.equal(local.pinnedTabStatesById[100], undefined);
        assert.equal(tabs.find(item => item.id === 100).active, true);
        activate(2);
        const twin = copy(bookmarks.find(item => item.id === 'twin'));
        await execute(tab, 2, 'renameCurrentTab', { title: 'Exact saved pin' });
        assert.equal(bookmarks.find(item => item.id === 'pin').title, 'Exact saved pin');
        await execute(tab, 2, 'editCurrentPinUrl', { url: 'https://edited.test/' });
        assert.equal(bookmarks.find(item => item.id === 'pin').url, 'https://edited.test/');
        assert.equal(local.pinnedTabStatesById[2].pinnedUrl, 'https://edited.test/');
        assert.equal(local.pinnedTabStatesById[12].pinnedUrl, 'https://edited.test/');
        assert.equal(tabs.find(item => item.id === 2).url, URL);
        const copiedPin = await execute(tab, 2, 'copyCurrentLink');
        assert.equal(copiedPin.url, URL, 'Copy the live saved-pin page, never its independently edited saved URL');
        assert.deepEqual(effects.filter(item => item[0] === 'clipboard').at(-1), ['clipboard', URL]);
        for (const muted of [true, false]) {
            assert.equal((await execute(tab, 2, 'setCurrentTabMuted', { muted })).muted, muted);
            assert.equal(tabs.find(item => item.id === 2).mutedInfo.muted, muted);
        }
        assert.deepEqual(bookmarks.find(item => item.id === 'twin'), twin);
        assert.deepEqual(tabs.filter(item => item.windowId === 8), otherWindow, 'Saved metadata updates never navigate linked native instances');
        activate(1);
        const beforeMove = copy(tabs), selected = copy(store.active);
        assert.equal((await execute(space, 1, 'moveCurrentTodayTab', { destination })).tabId, 1);
        assert.deepEqual(tabs, beforeMove); assert.deepEqual(store.active, selected);
        assert.equal(store.spaces.find(item => item.id === 'other').temporaryTabs.at(-1), 1);
        assert(!store.spaces.find(item => item.id === 'work').temporaryTabs.includes(1));
        // Moving keeps the source Space selected. Use an exact remaining source
        // member for the next switch instead of borrowing the moved active tab.
        activate(2);
        const switched = await execute(space, 2, 'switchSpace', { destination });
        assert.equal(switched.spaceId, 'other'); assert.equal(store.active[7], 'other');
        assert.equal(store.active[8], 'work');
        assert.equal(tabs.find(item => item.id === switched.tabId).active, true);
        assert.deepEqual(tabs.filter(item => item.windowId === 8), otherWindow);
        assert.deepEqual(new Set(sent.filter(item => [...TAB_ACTION_COMMANDS, ...SPACE_NAVIGATION_COMMANDS].includes(item.command)).map(item => item.command)),
            new Set([...TAB_ACTION_COMMANDS, ...SPACE_NAVIGATION_COMMANDS]));

        // Every extended command is negotiated; rejection never falls through
        // to navigation/native operations, and failed acknowledgements don't replay.
        const activeId = switched.tabId, scope = await tab.read(source(activeId));
        const beforeRejected = effects.length;
        const raw = { type: 'arcify-bridge', version: 1, requestId: 'extended-negative', windowId: WINDOW,
            command: 'setCurrentTabMuted', context: scope.context, muted: !scope.context.tab.muted, supportedFeatures: ['tabActionsV1'] };
        for (const [patch, code] of [[{ supportedFeatures: undefined }, 'UNSUPPORTED_FEATURE'], [{ windowId: 8 }, 'INVALID_REQUEST'],
            [{ extra: true }, 'INVALID_REQUEST'], [{ version: 2 }, 'VERSION_MISMATCH']]) {
            const response = await handle({ ...raw, ...patch }, sender);
            assert.equal(response.ok, false); assert.equal(response.error.code, code);
        }
        peerLocal[PAIRING_GENERATION_KEY] = 'changed';
        await assert.rejects(tab.execute(source(activeId), scope, 'setCurrentTabMuted', { muted: !scope.context.tab.muted }), { code: 'DISCONNECTED' });
        peerLocal[PAIRING_GENERATION_KEY] = 'spotlight-generation';
        local[PEER_KEY] = '';
        await assert.rejects(tab.execute(source(activeId), scope, 'setCurrentTabMuted', { muted: !scope.context.tab.muted }), { code: 'UNAUTHORIZED' });
        local[PEER_KEY] = SPOTLIGHT;
        assert.equal(effects.length, beforeRejected);
        const requests = sent.length;
        alterResponse = (response, message) => message.command === 'copyCurrentLink' ? { ...response, copied: false } : response;
        await assert.rejects(tab.execute(source(activeId), scope, 'copyCurrentLink', {}), { code: 'INVALID_RESPONSE' });
        assert.equal(effects.length, beforeRejected + 1, 'One clipboard side effect despite unconfirmed response');
        assert.equal(sent.slice(requests).filter(item => item.command === 'copyCurrentLink').length, 1, 'No automatic mutation replay');
    } finally {
        if (previous === undefined) delete globalThis.chrome; else globalThis.chrome = previous;
    }
}
