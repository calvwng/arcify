import test from 'node:test';
import assert from 'node:assert/strict';
import { createTransientControlHandler, createTransientOwnershipCommit, createTransientRecoverySelectionValidator } from '../../transient-window-actions.js';
import { validateRequest, BRIDGE_TYPE, BRIDGE_VERSION } from '../../spotlight-bridge-protocol.js';

function fixture() {
    const calls = [], tab = { id: 7, windowId: 20, pinned: false, incognito: false, splitViewId: -1, url: 'https://same.test' };
    const record = { token: 'test-token', windowId: 20, controllerTabId: 6, originWindowId: 10, tabId: 7, phase: 'ready' };
    const controllerUrl = 'chrome-extension://own/transient-window.html?token=test-token';
    const sender = { id: 'own', url: controllerUrl, origin: 'chrome-extension://own', frameId: 0, tab: { id: 6, windowId: 20 } };
    let data = {}, binding = null;
    const space = { id: 'space', name: 'Work', bookmarkFolderId: 'folder', temporaryTabs: [], spaceBookmarks: [] };
    const store = { spaces: [space], active: {}, run: operation => operation(), isGlobalTab: () => false,
        isTransientWindow: id => id === 20, readTodayPlacement: async () => {}, forgetTab: id => calls.push(['forget', id]),
        insertCreatedToday: (target, live) => target.temporaryTabs.push(live.id),
        persist: async ({ beforeWrite }) => {
            await beforeWrite(); calls.push(['persist']);
            data = { spaces: structuredClone(store.spaces), spaceTabSnapshot: [{ tabId: 7, spaceId: 'space', section: 'temporaryTabs' }] };
        }, transientWindows: {
            listUnlocked: async () => [structuredClone(record)],
            promoteUnlocked: async (request, options) => { calls.push(['promote', request]); await options.beforeMutation();
                await options.commitOwnership.validate(tab, request); tab.windowId = request.windowId;
                await options.commitOwnership(tab, request); record.phase = 'committed';
                return { ...request, phase: 'committed' };
            }
        }
    };
    globalThis.chrome = {
        runtime: { id: 'own', getURL: path => `chrome-extension://own/${path}` },
        tabs: { get: async id => id === 6 ? { id: 6, windowId: 20, url: controllerUrl } : { ...tab },
            update: async (id, values) => { calls.push(['update', id, values]); return { ...tab }; } },
        windows: { get: async id => ({ id, type: 'normal', incognito: false }), update: async (id, value) => calls.push(['focus', id, value]),
            getAll: async () => [10, 20, 30].map(id => ({ id, type: 'normal', incognito: false, tabs: [{ active: true, title: `Page ${id}` }] })) },
        storage: { local: { get: async key => typeof key === 'string' && key === 'pinnedTabStatesById' ? { pinnedTabStatesById: binding ? { 7: binding } : {} } : data } },
        bookmarks: { get: async () => [{ id: 'folder', parentId: 'root' }], search: async () => [{ id: 'root', title: 'Arcify' }] }
    };
    const request = { type: 'arcifyTransientWindow', action: 'promote', token: 'test-token', tabId: 7,
        windowId: 10, spaceId: 'space', bookmarkFolderId: 'folder' };
    return { tab, record, sender, store, calls, request, setBinding: value => binding = value, setData: value => data = value };
}

test('control context lists ordinary windows, preserves exact origin, and discloses exact page', async () => {
    const f = fixture();
    const result = await createTransientControlHandler(f.store)({ type: 'arcifyTransientWindow', action: 'context', token: f.record.token }, f.sender);
    assert.deepEqual(result.windows.map(window => [window.id, window.origin]), [[10, true], [30, false]]);
    assert.equal(result.page.id, 7); assert.deepEqual(result.spaces, [{ id: 'space', bookmarkFolderId: 'folder', name: 'Work' }]);
    assert.deepEqual(f.calls, []);
});

test('promotion commits exact Today ownership and focuses only the same moved native tab', async () => {
    const f = fixture(); const result = await createTransientControlHandler(f.store)(f.request, f.sender);
    assert.equal(result.tabId, 7); assert.equal(result.focused, true); assert.equal(f.tab.windowId, 10);
    assert.deepEqual(f.store.spaces[0].temporaryTabs, [7]); assert.equal(f.store.active[10], 'space');
    assert.deepEqual(f.calls.filter(call => call[0] === 'update'), [['update', 7, { active: true }]]);
    assert.equal(f.calls.filter(call => call[0] === 'persist').length, 1);
});

for (const change of [
    f => f.sender.id = 'other', f => f.sender.url = 'chrome-extension://own/sidebar.html',
    f => f.sender.url += '&token=other', f => f.sender.tab.id = 99, f => f.sender.tab.windowId = 99,
    f => f.sender.frameId = 1, f => f.sender.documentLifecycle = 'prerender',
    f => f.request.extra = true, f => f.request.token = 'different', f => f.request.windowId = 20
]) test('untrusted, stale, malformed, or transient destination cannot invoke ownership writes', async () => {
    const f = fixture(); change(f);
    await assert.rejects(createTransientControlHandler(f.store)(f.request, f.sender));
    assert.equal(f.calls.filter(call => ['persist', 'update', 'focus'].includes(call[0])).length, 0);
});

for (const change of [
    f => f.tab.pinned = true, f => f.tab.incognito = true, f => f.tab.splitViewId = 2,
    f => f.store.spaces[0].bookmarkFolderId = 'changed', f => f.store.spaces.push({ ...f.store.spaces[0] }),
    f => f.store.spaces[0].spaceBookmarks.push(7), f => f.setBinding({ bookmarkId: 'saved-pin' }),
    f => f.store.isGlobalTab = () => true
]) test('ownership preflight refuses pinned, split, private, Favorite, or ambiguous saved identity', async () => {
    const f = fixture(); change(f);
    await assert.rejects(createTransientOwnershipCommit(f.store).validate(f.tab, f.request));
    assert.deepEqual(f.calls, []);
});

test('durable snapshot mismatch refuses a success receipt without trying again', async () => {
    const f = fixture(); f.tab.windowId = 10;
    f.store.persist = async ({ beforeWrite }) => { await beforeWrite(); f.calls.push(['persist']); f.setData({ spaces: f.store.spaces, spaceTabSnapshot: [] }); };
    await assert.rejects(createTransientOwnershipCommit(f.store)(f.tab, f.request), error => error.code === 'PARTIAL_COMMIT');
    assert.equal(f.calls.filter(call => call[0] === 'persist').length, 1);
    assert.equal(f.tab.windowId, 10);
});

test('focus failure remains a successful committed transfer', async () => {
    const f = fixture(); chrome.windows.update = async () => { throw new Error('Window focus rejected'); };
    const result = await createTransientControlHandler(f.store)(f.request, f.sender);
    assert.equal(result.phase, 'committed'); assert.equal(result.focused, false);
    assert.deepEqual(f.store.spaces[0].temporaryTabs, [7]);
});

test('controller pending navigation in the final guard refuses ownership writes', async () => {
    const f = fixture(), get = chrome.tabs.get; let controllerReads = 0;
    chrome.tabs.get = async id => {
        const tab = await get(id);
        if (id === f.sender.tab.id && ++controllerReads > 1) tab.pendingUrl = 'https://other.test/';
        return tab;
    };
    await assert.rejects(createTransientControlHandler(f.store)(f.request, f.sender), error => error.code === 'STALE_WINDOW');
    assert.equal(controllerReads, 2);
    assert.equal(f.calls.some(call => ['persist', 'update', 'focus'].includes(call[0])), false);
    assert.equal(f.tab.windowId, 20);
});

test('source native movement while reading Today ordering blocks ownership commit', async () => {
    const f = fixture(); f.tab.windowId = 10; f.store.readTodayPlacement = async () => { f.tab.windowId = 30; };
    await assert.rejects(createTransientOwnershipCommit(f.store)(f.tab, f.request), /moved again/);
    assert.equal(f.calls.length, 0);
});

test('bridge openTransient accepts HTTP(S) only and rejects extra operation fields', () => {
    const request = { type: BRIDGE_TYPE, version: BRIDGE_VERSION, requestId: 'new-transient', windowId: 10, command: 'openTransient', url: 'https://example.test' };
    validateRequest(request, ['openTransient']);
    for (const url of ['javascript:alert(1)', 'file:///tmp/foo', 'chrome://settings', 'about:blank', 'data:text/html,x'])
        assert.throws(() => validateRequest({ ...request, url }, ['openTransient']));
    assert.throws(() => validateRequest({ ...request, spaceId: 'implicit' }, ['openTransient']));
});

test('orphan context lists distinct eligible native IDs only in its exact proven window', async () => {
    const f = fixture(); Object.assign(f.record, { phase: 'orphan', tabId: null, originWindowId: null, memberTabIds: [6, 7, 8, 9] });
    const duplicate = { ...f.tab, id: 8 }, moved = { ...f.tab, id: 9, windowId: 30 };
    const get = chrome.tabs.get;
    chrome.tabs.get = async id => id === 8 ? duplicate : id === 9 ? moved : get(id);
    chrome.tabs.query = async () => [f.tab, duplicate, moved, await get(6)];
    const result = await createTransientControlHandler(f.store)({ type: 'arcifyTransientWindow', action: 'context', token: f.record.token }, f.sender);
    assert.deepEqual(result.recoveryTabs.map(tab => tab.id), [7, 8]);
    assert.equal(result.recoveryTabs[0].url, result.recoveryTabs[1].url);
    assert.equal(result.page, null); assert.equal(result.windows.some(window => window.origin), false);
    assert.deepEqual(f.calls, []);
});

test('recovery adapter validates one explicit ID without ownership writes, movement, or focus', async () => {
    const f = fixture(); Object.assign(f.record, { phase: 'orphan', tabId: null, originWindowId: null, memberTabIds: [6, 7] });
    f.store.transientWindows.recoverUnlocked = async (request, options) => {
        await options.beforeMutation(); await options.validateSelection(f.tab, { ...request, windowId: 20 });
        f.calls.push(['recover', request]); return { ...f.record, phase: 'ready', tabId: request.tabId, recovered: true };
    };
    const result = await createTransientControlHandler(f.store)({ type: 'arcifyTransientWindow', action: 'recover', token: f.record.token, tabId: 7 }, f.sender);
    assert.equal(result.phase, 'ready'); assert.equal(result.tabId, 7); assert.equal(result.originWindowId, null);
    assert.deepEqual(f.calls, [['recover', { token: f.record.token, tabId: 7 }]]);
    assert.equal(f.tab.windowId, 20); assert.deepEqual(f.store.spaces[0].temporaryTabs, []);
});

for (const change of [
    f => f.tab.windowId = 30, f => f.tab.pinned = true, f => f.tab.incognito = true,
    f => f.tab.splitViewId = 2, f => f.tab.url = 'chrome://settings',
    f => f.tab.pendingUrl = 'chrome://settings', f => f.setBinding({ bookmarkId: 'pin' }),
    f => f.store.spaces[0].temporaryTabs.push(7),
    f => f.store.favoriteStore = { state: { bindings: [{ tabId: 7 }], attempts: [] } },
    f => f.store.favoriteStore = { state: { bindings: [], attempts: [{ tabId: 7 }] } }
]) test('recovery selection rejects changed native or existing ownership provenance', async () => {
    const f = fixture(); change(f);
    await assert.rejects(createTransientRecoverySelectionValidator(f.store)(f.tab, { tabId: 7, windowId: 20 }));
    assert.deepEqual(f.calls, []);
});

test('recovery request rejects forged destinations, untrusted senders, and missing native IDs', async () => {
    for (const change of [request => request.windowId = 30, request => delete request.tabId, request => request.tabId = '7']) {
        const f = fixture(), request = { type: 'arcifyTransientWindow', action: 'recover', token: f.record.token, tabId: 7 };
        change(request); await assert.rejects(createTransientControlHandler(f.store)(request, f.sender));
        assert.deepEqual(f.calls, []);
    }
    const f = fixture(); f.sender.id = 'other';
    await assert.rejects(createTransientControlHandler(f.store)({ type: 'arcifyTransientWindow', action: 'recover', token: f.record.token, tabId: 7 }, f.sender));
});

test('direct mode can only be enabled by exact nonembedded trusted controller, never paired/content sender',async()=>{const f=fixture();let writes=[];chrome.storage.local.set=async value=>writes.push(value);const request={type:'arcifyTransientWindow',action:'directMode',token:f.record.token,enabled:true};for(const change of [s=>s.id='other',s=>s.frameId=2,s=>s.url='chrome-extension://own/little-arc-header.html',s=>s.tab.id=99]){const sender=structuredClone(f.sender);change(sender);await assert.rejects(createTransientControlHandler(f.store)(request,sender));}assert.equal(writes.length,0);const result=await createTransientControlHandler(f.store)(request,f.sender);assert.equal(result.directEnabled,true);assert.deepEqual(writes,[{littleArcDirectPlacementEnabled:true}]);});
test('trusted controller is not a web accessible resource and direct mode is absent/default-off in manifest',async()=>{const {readFile}=await import('node:fs/promises');const manifest=JSON.parse(await readFile(new URL('../../manifest.json',import.meta.url)));assert.equal(manifest.web_accessible_resources.some(group=>group.resources.includes('transient-window.html')),false);assert.equal(JSON.stringify(manifest).includes('littleArcDirectPlacementEnabled'),false);});
