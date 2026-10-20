import test from 'node:test';
import assert from 'node:assert/strict';
import { SpaceStore, ownerOf } from '../../space-store.js';
import { createTransientWindowStore, TRANSIENT_WINDOW_SESSION_KEY } from '../../transient-window-store.js';
import { createTransientControlHandler, createTransientOwnershipCommit } from '../../transient-window-actions.js';
import { getBridgeSnapshot } from '../../spotlight-bridge.js';

const copy = value => structuredClone(value);
const event = () => ({ listeners: new Set(), addListener(fn) { this.listeners.add(fn); }, removeListener(fn) { this.listeners.delete(fn); },
    emit(...args) { for (const listener of [...this.listeners]) listener(...args); } });
function fixture() {
    const local = { spaceModelVersion: 2, spaces: [
        { id: 'a', spaceUuid: 'a', name: 'Home', color: 'blue', bookmarkFolderId: 'a', spaceBookmarks: [], temporaryTabs: [1] },
        { id: 'b', spaceUuid: 'b', name: 'Work', color: 'green', bookmarkFolderId: 'b', spaceBookmarks: [], temporaryTabs: [] }
    ] }, session = { spaceSession: true }, sync = {}, mutations = [];
    const windows = new Map([[10, { id: 10, type: 'normal', incognito: false }], [30, { id: 30, type: 'normal', incognito: false }]]);
    const tabs = new Map([[1, { id: 1, windowId: 10, url: 'https://same.test/', index: 0, groupId: -1, pinned: false, incognito: false }]]);
    let nextId = 5, nextWindow = 20, failCheckpoint = false;
    const area = (data, kind) => ({
        async get(keys) { const names = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys || data);
            return Object.fromEntries(names.map(key => [key, copy(data[key] ?? keys?.[key])])); },
        async set(values) { if (failCheckpoint && kind === 'local' && values.spaces) throw new Error('checkpoint unavailable'); Object.assign(data, copy(values)); }
    });
    const api = globalThis.chrome = {
        runtime: { id: 'arcify', getURL: path => `chrome-extension://arcify/${path}` },
        storage: { local: area(local, 'local'), session: area(session, 'session'), sync: area(sync, 'sync'), onChanged: event() },
        tabs: {
            onCreated: event(), onUpdated: event(), onRemoved: event(), onReplaced: event(), onActivated: event(), onMoved: event(), onAttached: event(), onDetached: event(),
            async query(filter = {}) { return copy([...tabs.values()].filter(tab => (filter.windowId === undefined || tab.windowId === filter.windowId)
                && (filter.url === undefined || tab.url.startsWith(filter.url.replace(/\*$/, ''))))); },
            async get(id) { if (!tabs.has(id)) throw new Error('closed tab'); return copy(tabs.get(id)); },
            async create(options) { mutations.push(['tabCreate', copy(options)]); const tab = { id: nextId++, index: 1, groupId: -1,
                incognito: false, pinned: false, ...options }; tabs.set(tab.id, tab); api.tabs.onCreated.emit(copy(tab)); return copy(tab); },
            async move(id, options) { mutations.push(['tabMove', id, copy(options)]); const tab = tabs.get(id), oldWindowId = tab.windowId;
                api.tabs.onDetached.emit(id, { oldWindowId, oldPosition: tab.index }); Object.assign(tab, { windowId: options.windowId, index: 1 });
                api.tabs.onAttached.emit(id, { newWindowId: tab.windowId, newPosition: 1 }); return copy(tab); },
            async ungroup() { mutations.push(['ungroup']); }, async group() { mutations.push(['group']); },
            async remove() { mutations.push(['remove']); }
        },
        windows: { onRemoved: event(), async get(id) { if (!windows.has(id)) throw new Error('closed window'); return copy(windows.get(id)); },
            async getAll() { return [...windows.values()].map(window => ({ ...copy(window), tabs: copy([...tabs.values()].filter(tab => tab.windowId === window.id)) })); },
            async create(options) { mutations.push(['windowCreate', copy(options)]); const window = { id: nextWindow++, type: 'normal', incognito: false };
                windows.set(window.id, window); const controller = { id: nextId++, windowId: window.id, url: options.url, status: 'complete', index: 0, groupId: -1, pinned: false, incognito: false };
                tabs.set(controller.id, controller);
                // Realistic ordering: onCreated happens before windows.create resolves.
                api.tabs.onCreated.emit({ ...controller, url: '', pendingUrl: options.url });
                return { ...window, tabs: [copy(controller)] };
            }
        },
        tabGroups: { onRemoved: event(), onUpdated: event(), query: async () => [] },
        bookmarks: { search: async () => [{ id: 'root', title: 'Arcify' }], getChildren: async () => [],
            get: async id => [{ id, parentId: 'root', title: id }], getSubTree: async id => [{ id, children: [] }] }
    };
    const makeStore = () => { const store = new SpaceStore(); store.transientWindows = createTransientWindowStore({ api }); return store; };
    const store = makeStore(); store.install();
    return { store, makeStore, tabs, windows, local, session, mutations, failCheckpoint: value => { failCheckpoint = value; } };
}

async function coldRestart(f, { clearAllSession = false, restore = () => {} } = {}) {
    // Settle the old worker's projection timers, then remove its native listeners.
    await new Promise(resolve => setTimeout(resolve, 250)); await f.store.run(() => {});
    for (const area of [chrome.tabs, chrome.windows, chrome.tabGroups, chrome.storage])
        for (const value of Object.values(area)) value?.listeners?.clear();
    if (clearAllSession) for (const key of Object.keys(f.session)) delete f.session[key];
    else { delete f.session[TRANSIENT_WINDOW_SESSION_KEY]; delete f.session.spaceSession; }
    restore();
    f.store = f.makeStore(); f.store.install(); await f.store.run(() => {});
    return f.store;
}

function controlSender(f, record) {
    return { id: chrome.runtime.id, frameId: 0, origin: 'chrome-extension://arcify',
        url: f.tabs.get(record.controllerTabId).url, tab: { id: record.controllerTabId, windowId: record.windowId } };
}

test('complete lifecycle preserves exact tab through queued creation, promotion, and worker restart', async t => {
    const f = fixture();
    t.after(async () => { await new Promise(resolve => setTimeout(resolve, 250)); await f.store.run(() => {}); });
    await f.store.run(() => {});
    const created = await f.store.run(() => f.store.transientWindows.openUnlocked({ url: 'https://same.test/', originWindowId: 10 }));
    await f.store.run(() => {});
    assert.equal(ownerOf(f.store.spaces, created.tabId), undefined);
    assert.equal(ownerOf(f.store.spaces, 1)?.id, 'a', 'Same-URL original ownership is unchanged');
    assert.equal(f.local.spaceTabSnapshot.some(record => record.tabId === created.tabId), false);
    assert.equal(f.local.spaceWindowSnapshot.some(record => record.tabs.some(tab => tab.url.startsWith('chrome-extension:'))), false);
    const result = await f.store.run(() => f.store.transientWindows.promoteUnlocked({ token: created.token,
        tabId: created.tabId, windowId: 10, spaceId: 'b', bookmarkFolderId: 'b' }, { commitOwnership: createTransientOwnershipCommit(f.store) }));
    await f.store.run(() => {});
    assert.equal(result.tabId, created.tabId); assert.equal(f.tabs.get(created.tabId).windowId, 10);
    assert.equal(ownerOf(f.store.spaces, created.tabId)?.id, 'b');
    assert.equal(f.store.isTransientTab(created.tabId), false);
    assert.deepEqual(f.mutations.map(call => call[0]), ['windowCreate', 'tabCreate', 'tabMove']);
    const reloaded = f.makeStore(); await reloaded.dispatch({ action: 'get' });
    assert.equal(ownerOf(reloaded.spaces, created.tabId)?.id, 'b');
    assert.equal(reloaded.isTransientTab(created.tabId), false);
    assert.equal(reloaded.isTransientWindow(created.windowId), true);
});

test('post-move checkpoint failure keeps live tab, quarantine and no replay across queued events', async t => {
    const f = fixture();
    t.after(async () => { await new Promise(resolve => setTimeout(resolve, 250)); await f.store.run(() => {}); });
    await f.store.run(() => {});
    const created = await f.store.run(() => f.store.transientWindows.openUnlocked({ url: 'https://same.test/', originWindowId: 10 }));
    await f.store.run(() => {}); f.failCheckpoint(true);
    const request = { token: created.token, tabId: created.tabId, windowId: 10, spaceId: 'b', bookmarkFolderId: 'b' };
    await assert.rejects(f.store.run(() => f.store.transientWindows.promoteUnlocked(request,
        { commitOwnership: createTransientOwnershipCommit(f.store) })), error => error.code === 'PARTIAL_COMMIT');
    f.failCheckpoint(false); await f.store.run(() => {});
    assert.equal(f.tabs.get(created.tabId).windowId, 10);
    assert.equal(f.store.isTransientTab(created.tabId), true);
    assert.equal(ownerOf(await f.store.dispatch({ action: 'get' }), created.tabId), undefined);
    await assert.rejects(f.store.run(() => f.store.transientWindows.promoteUnlocked(request,
        { commitOwnership: createTransientOwnershipCommit(f.store) })), error => error.code === 'UNCERTAIN_RESULT');
    assert.equal(f.mutations.filter(call => call[0] === 'tabMove').length, 1);
    assert.equal(f.mutations.some(call => call[0] === 'remove'), false);
});

test('cold marker recovery quarantines restored window without selecting any same-URL page', async t => {
    const f = fixture();
    t.after(async () => { await new Promise(resolve => setTimeout(resolve, 250)); await f.store.run(() => {}); });
    await f.store.run(() => {});
    const created = await f.store.run(() => f.store.transientWindows.openUnlocked({ url: 'https://same.test/', originWindowId: 10 }));
    await f.store.run(() => {});
    delete f.session[TRANSIENT_WINDOW_SESSION_KEY]; delete f.session.spaceSession;
    const reloaded = f.makeStore(); await reloaded.dispatch({ action: 'get' });
    assert.equal(reloaded.isTransientTab(created.tabId), true);
    assert.equal(ownerOf(reloaded.spaces, created.tabId), undefined);
    const [record] = await reloaded.transientWindows.listUnlocked();
    assert.equal(record.phase, 'orphan'); assert.equal(record.tabId, null);
    assert.equal(f.mutations.filter(call => call[0] === 'tabCreate').length, 1);
});

for (const boundary of ['closed-controller', 'navigated-controller', 'page-in-other-window'])
    test(`approved restart boundary: ${boundary} becomes ordinary only after session state is cleared`, async t => {
        const f = fixture();
        t.after(async () => { await new Promise(resolve => setTimeout(resolve, 250)); await f.store.run(() => {}); });
        await f.store.run(() => {});
        const created = await f.store.run(() => f.store.transientWindows.openUnlocked({ url: 'https://same.test/', originWindowId: 10 }));
        await f.store.run(() => {});
        if (boundary === 'closed-controller') {
            f.tabs.delete(created.controllerTabId);
            chrome.tabs.onRemoved.emit(created.controllerTabId, { windowId: created.windowId, isWindowClosing: false });
        } else if (boundary === 'navigated-controller') {
            const controller = f.tabs.get(created.controllerTabId);
            controller.url = 'https://ordinary-controller-navigation.test/';
            chrome.tabs.onUpdated.emit(controller.id, { url: controller.url }, copy(controller));
        } else {
            const page = f.tabs.get(created.tabId);
            chrome.tabs.onDetached.emit(page.id, { oldWindowId: page.windowId, oldPosition: page.index });
            page.windowId = 30;
            chrome.tabs.onAttached.emit(page.id, { newWindowId: 30, newPosition: page.index });
        }
        await f.store.run(() => {});
        assert.equal(f.store.isTransientTab(created.tabId), true, 'Same-session exact quarantine must not be weakened.');
        assert.equal(ownerOf(f.store.spaces, created.tabId), undefined);
        const mutationCount = f.mutations.length, restoredId = created.tabId + 100;
        const store = await coldRestart(f, { clearAllSession: true, restore: () => {
            const page = f.tabs.get(created.tabId);
            f.tabs.delete(created.tabId);
            f.tabs.set(restoredId, { ...page, id: restoredId });
        } });
        const restored = f.tabs.get(restoredId), owner = ownerOf(store.spaces, restoredId);
        assert.equal(store.isTransientTab(restored), false);
        assert.equal(store.isTransientWindow(restored.windowId), false);
        assert(owner, 'The unmarked restored page follows ordinary Space adoption without a startup hold.');
        assert(owner.temporaryTabs.includes(restoredId));
        assert(f.local.spaceTabSnapshot.some(record => record.tabId === restoredId && record.spaceId === owner.id));
        assert((await getBridgeSnapshot(store, restored.windowId)).tabs.some(tab => tab.id === restoredId));
        assert.equal(f.tabs.get(1).url, restored.url, 'The ordinary same-URL source remains a separate exact tab.');
        assert.equal(ownerOf(store.spaces, 1)?.id, 'a');
        assert.equal(f.mutations.length, mutationCount, 'Restart policy performs no native movement, creation or closure.');
        const records = await store.transientWindows.listUnlocked();
        if (boundary === 'page-in-other-window') {
            assert.equal(records.length, 1);
            assert.equal(records[0].phase, 'orphan'); assert.equal(records[0].tabId, null);
            assert.equal(records[0].windowId, created.windowId);
            assert.equal(records[0].memberTabIds.includes(restoredId), false, 'A controller cannot reclaim a same-URL page in another window.');
            assert.equal(store.isTransientTab(created.controllerTabId), true);
        } else assert.deepEqual(records, []);
    });

test('cold bridge snapshot rejects a transient source after queue hydration', async t => {
    const f = fixture();
    t.after(async () => { await new Promise(resolve => setTimeout(resolve, 250)); await f.store.run(() => {}); });
    await f.store.run(() => {});
    const created = await f.store.run(() => f.store.transientWindows.openUnlocked({ url: 'https://same.test/', originWindowId: 10 }));
    await f.store.run(() => {});
    const reloaded = f.makeStore();
    assert.equal(reloaded.isTransientWindow(created.windowId), false, 'Cold registry has not claimed any ordinary ID');
    await assert.rejects(getBridgeSnapshot(reloaded, created.windowId), error => error.code === 'INVALID_WINDOW');
    assert.equal(reloaded.isTransientWindow(created.windowId), true);
});

test('a primary page dragged through another transient window cannot report a false committed owner', async t => {
    const f = fixture();
    t.after(async () => { await new Promise(resolve => setTimeout(resolve, 250)); await f.store.run(() => {}); });
    await f.store.run(() => {});
    const a = await f.store.run(() => f.store.transientWindows.openUnlocked({ url: 'https://same.test/', originWindowId: 10 }));
    const b = await f.store.run(() => f.store.transientWindows.openUnlocked({ url: 'https://other.test/', originWindowId: 10 }));
    await f.store.run(() => {});
    await chrome.tabs.move(a.tabId, { windowId: b.windowId }); await f.store.run(() => {});
    await chrome.tabs.move(a.tabId, { windowId: a.windowId }); await f.store.run(() => {});
    const priorMoves = f.mutations.filter(call => call[0] === 'tabMove').length;
    await assert.rejects(f.store.run(() => f.store.transientWindows.promoteUnlocked({ token: a.token,
        tabId: a.tabId, windowId: 10, spaceId: 'b', bookmarkFolderId: 'b' }, { commitOwnership: createTransientOwnershipCommit(f.store) })),
    error => error.code === 'AMBIGUOUS_TRANSIENT_MEMBERSHIP');
    await f.store.run(() => {});
    assert.equal(f.tabs.get(a.tabId).windowId, a.windowId);
    assert.equal(f.store.isTransientTab(a.tabId), true);
    assert.equal(ownerOf(f.store.spaces, a.tabId), undefined);
    assert.equal(f.mutations.filter(call => call[0] === 'tabMove').length, priorMoves);
});

for (const staleResponse of [false, true]) test(`final controller navigation ${staleResponse ? 'event with stale native response' : 'pending URL'} prevents the native move`, async t => {
    const f = fixture();
    t.after(async () => { await new Promise(resolve => setTimeout(resolve, 250)); await f.store.run(() => {}); });
    await f.store.run(() => {});
    const created = await f.store.run(() => f.store.transientWindows.openUnlocked({ url: 'https://same.test/', originWindowId: 10 }));
    await f.store.run(() => {});
    const controller = f.tabs.get(created.controllerTabId), get = chrome.tabs.get;
    let controllerReads = 0;
    chrome.tabs.get = async id => {
        const result = await get(id);
        if (id === controller.id && ++controllerReads === 6) {
            controller.pendingUrl = 'https://other.test/';
            chrome.tabs.onUpdated.emit(id, { status: 'loading' }, copy(controller));
            return staleResponse ? result : copy(controller);
        }
        return result;
    };
    const sender = { id: 'arcify', url: controller.url, origin: 'chrome-extension://arcify', frameId: 0,
        tab: { id: controller.id, windowId: controller.windowId } };
    await assert.rejects(createTransientControlHandler(f.store)({ type: 'arcifyTransientWindow', action: 'promote', token: created.token,
        tabId: created.tabId, windowId: 10, spaceId: 'b', bookmarkFolderId: 'b' }, sender),
    error => ['STALE_WINDOW', 'STALE_TRANSIENT'].includes(error.code));
    assert.equal(controllerReads, 6);
    assert.equal(f.tabs.get(created.tabId).windowId, created.windowId);
    assert.equal(f.mutations.filter(call => call[0] === 'tabMove').length, 0);
    assert.equal(ownerOf(f.store.spaces, created.tabId), undefined);
});

test('explicit orphan selection keeps all pages quarantined until a separate exact-page Space transfer', async t => {
    const f = fixture();
    t.after(async () => { await new Promise(resolve => setTimeout(resolve, 250)); await f.store.run(() => {}); });
    await f.store.run(() => {});
    const original = await f.store.run(() => f.store.transientWindows.openUnlocked({ url: 'https://same.test/', originWindowId: 10 }));
    const sibling = await chrome.tabs.create({ windowId: original.windowId, url: 'https://same.test/', active: true });
    await f.store.run(() => {}); const store = await coldRestart(f);
    const handle = createTransientControlHandler(store), sender = controlSender(f, original);
    const context = await handle({ type: 'arcifyTransientWindow', action: 'context', token: original.token }, sender);
    assert.equal(context.record.phase, 'orphan'); assert.equal(context.record.tabId, null);
    assert.deepEqual(context.recoveryTabs.map(tab => tab.id), [original.tabId, sibling.id]);
    const mutationCount = f.mutations.length;
    const recovered = await handle({ type: 'arcifyTransientWindow', action: 'recover', token: original.token, tabId: sibling.id }, sender);
    assert.equal(recovered.phase, 'ready'); assert.equal(recovered.tabId, sibling.id); assert.equal(recovered.originWindowId, null);
    assert.equal(f.mutations.length, mutationCount, 'Recovery makes no native mutation');
    assert.equal(ownerOf(store.spaces, sibling.id), undefined); assert.equal(ownerOf(store.spaces, original.tabId), undefined);
    assert.equal(store.isTransientTab(sibling.id), true); assert.equal(store.isTransientTab(original.tabId), true);
    assert.equal(f.local.spaceTabSnapshot.some(record => [original.tabId, sibling.id].includes(record.tabId)), false);
    await assert.rejects(store.run(() => store.transientWindows.promoteUnlocked({ token: original.token, tabId: sibling.id,
        spaceId: 'b', bookmarkFolderId: 'b' }, { commitOwnership: createTransientOwnershipCommit(store) })), error => error.code === 'TARGET_REQUIRED');
    const result = await handle({ type: 'arcifyTransientWindow', action: 'promote', token: original.token,
        tabId: sibling.id, windowId: 30, spaceId: 'b', bookmarkFolderId: 'b' }, sender);
    await store.run(() => {});
    assert.equal(result.tabId, sibling.id); assert.equal(f.tabs.get(sibling.id).windowId, 30);
    assert.equal(ownerOf(store.spaces, sibling.id)?.id, 'b');
    assert.equal(f.tabs.get(original.tabId).windowId, original.windowId);
    assert.equal(store.isTransientTab(original.tabId), true); assert.equal(ownerOf(store.spaces, original.tabId), undefined);
    assert.equal(f.mutations.filter(call => call[0] === 'tabMove').length, 1);
});

test('orphan recovery rejects an ordinary-window page even when its URL matches', async t => {
    const f = fixture();
    t.after(async () => { await new Promise(resolve => setTimeout(resolve, 250)); await f.store.run(() => {}); });
    await f.store.run(() => {});
    const original = await f.store.run(() => f.store.transientWindows.openUnlocked({ url: 'https://same.test/', originWindowId: 10 }));
    const store = await coldRestart(f), mutationCount = f.mutations.length;
    await assert.rejects(createTransientControlHandler(store)({ type: 'arcifyTransientWindow', action: 'recover', token: original.token, tabId: 1 },
        controlSender(f, original)));
    assert.equal(f.mutations.length, mutationCount); assert.equal(ownerOf(store.spaces, 1)?.id, 'a');
    const [record] = await store.transientWindows.listUnlocked();
    assert.equal(record.phase, 'orphan'); assert.equal(record.tabId, null); assert.equal(store.isTransientTab(original.tabId), true);
});
