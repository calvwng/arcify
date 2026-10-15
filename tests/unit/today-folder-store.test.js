import test from 'node:test';
import assert from 'node:assert/strict';
import { saveTodayTabsInNewFolder, registerTodayFolderMessages } from '../../today-folder-store.js';
import { SpaceStore } from '../../space-store.js';
import { Utils } from '../../utils.js';

function fixture({ inverted = false } = {}) {
    const tabs = [1, 2, 3].map(id => ({ id, windowId: 10, url: 'https://same.test/', title: `Tab ${id}`, pinned: false, active: id === 1 }));
    tabs.push({ id: 9, windowId: 20, url: 'https://same.test/', title: 'Other window', pinned: false, active: true });
    const nodes = [{ id: 'arcify', title: 'Arcify', parentId: 'bar' }, { id: 'root', title: 'Space', parentId: 'arcify' }, { id: 'existing', parentId: 'root', title: 'Existing', url: 'https://old.test/' }];
    const local = { pinnedTabStatesById: {}, tabNameOverridesById: {}, unrelated: 'keep' }, sync = { invertTabOrder: inverted };
    const effects = [], hooks = {}, globalTabs = new Set(), listeners = [];
    let nextId = 100;
    const area = data => ({ async get(keys) {
        await hooks.storageGet?.(keys);
        if (typeof keys === 'string') return { [keys]: structuredClone(data[keys]) };
        return structuredClone({ ...(Array.isArray(keys) ? {} : keys), ...data });
    }, async set(update) { effects.push(['storage', structuredClone(update)]); Object.assign(data, structuredClone(update)); await hooks.storageSet?.(update); } });
    globalThis.chrome = {
        runtime: { id: 'test', getURL: path => `chrome-extension://test/${path}`, onMessage: { addListener(callback) { listeners.push(callback); } } },
        storage: { local: area(local), sync: area(sync) },
        windows: { async get(id) { return { id, type: 'normal', incognito: false, ...(hooks.window?.() || {}) }; } },
        tabs: { async get(id) { await hooks.tabGet?.(id); const tab = tabs.find(tab => tab.id === id); if (!tab) throw new Error('No tab'); return structuredClone(tab); } },
        bookmarks: {
            async get(id) { await hooks.bookmarkGet?.(id); return structuredClone(nodes.filter(node => node.id === id)); },
            async search({ title }) { return structuredClone(nodes.filter(node => node.title === title)); },
            async getChildren(id) { await hooks.children?.(id); return structuredClone(nodes.filter(node => node.parentId === id)); },
            async create(data) {
                await hooks.beforeCreate?.(data);
                const node = { ...data, id: String(nextId++) }; if (!node.url) delete node.url;
                // Tests append only; the production guarded writer verifies order.
                assert.equal(data.index, nodes.filter(node => node.parentId === data.parentId).length);
                nodes.push(node); effects.push(['create', structuredClone(node)]);
                await hooks.afterCreate?.(node); return structuredClone(node);
            }
        }
    };
    Utils._pinnedStateChain = Promise.resolve();
    const store = new SpaceStore(); store.initialized = true;
    store.spaces = [{ id: 's', bookmarkFolderId: 'root', temporaryTabs: [1, 2, 3, 9], spaceBookmarks: [] }, { id: 'other', bookmarkFolderId: 'other-root', temporaryTabs: [], spaceBookmarks: [] }];
    store.active = { 10: 's', 20: 's' }; store.restoredRanks = new Map();
    store.isGlobalTab = id => globalTabs.has(id);
    store.persist = async () => { effects.push(['persist', structuredClone(store.spaces)]); await hooks.persist?.(); };
    const request = { windowId: 10, spaceId: 's', bookmarkFolderId: 'root', title: 'Research', inverted, entries: [1, 2, 3].map(tabId => ({ tabId, url: 'https://same.test/' })) };
    const save = () => saveTodayTabsInNewFolder(store, request);
    const creates = () => effects.filter(([kind]) => kind === 'create').map(([, node]) => node);
    return { tabs, nodes, local, sync, effects, hooks, globalTabs, listeners, store, request, save, creates };
}

test('batch saves exact original live tabs in visible order, with fresh titles and distinct same-URL bookmarks', async () => {
    const f = fixture();
    f.request.entries = [3, 1, 2].map(tabId => ({ tabId, url: 'https://same.test/' }));
    f.local.tabNameOverridesById[1] = { name: 'Custom name' }; f.tabs[2].title = 'Fresh title';
    const beforeTabs = structuredClone(f.tabs);
    const result = await f.save();
    assert.deepEqual(result.completed.map(entry => entry.tabId), [3, 1, 2]);
    assert.deepEqual(f.creates().map(node => node.title), ['Research', 'Fresh title', 'Custom name', 'Tab 2']);
    assert.equal(new Set(result.completed.map(entry => entry.bookmarkId)).size, 3);
    assert.deepEqual(f.store.spaces[0].temporaryTabs, [9]); assert.deepEqual(f.store.spaces[0].spaceBookmarks, [3, 1, 2]);
    for (const { tabId, bookmarkId } of result.completed) assert.deepEqual(f.local.pinnedTabStatesById[tabId], { bookmarkId, pinnedUrl: 'https://same.test/' });
    assert.deepEqual(f.tabs, beforeTabs); assert.equal(f.local.unrelated, 'keep');
    assert.equal(f.nodes.find(node => node.id === 'existing').parentId, 'root');
});

test('inverted rendering still shows the saved folder children in captured visible order', async () => {
    const f = fixture({ inverted: true }); f.request.entries.reverse();
    const result = await f.save();
    const displayed = f.nodes.filter(node => node.parentId === result.folderId).reverse();
    assert.deepEqual(displayed.map(node => Number(node.title.slice(4))), [3, 2, 1]);
});

for (const mutation of ['closed', 'url', 'pending-url', 'window', 'native-pin', 'global-favorite', 'other-space', 'already-pinned', 'binding', 'active-space', 'root-moved', 'root-deleted', 'root-replaced', 'invert', 'private-tab', 'private-window', 'non-normal-window']) {
    test(`whole-batch preflight rejects ${mutation} without creating even an empty folder`, async () => {
        const f = fixture(), target = f.tabs[1];
        if (mutation === 'closed') f.tabs.splice(1, 1);
        if (mutation === 'url') target.url = 'https://new.test/';
        if (mutation === 'pending-url') target.pendingUrl = 'https://new.test/';
        if (mutation === 'window') target.windowId = 20;
        if (mutation === 'native-pin') target.pinned = true;
        if (mutation === 'global-favorite') f.globalTabs.add(2);
        if (mutation === 'other-space') { f.store.spaces[0].temporaryTabs = [1, 3, 9]; f.store.spaces[1].temporaryTabs = [2]; }
        if (mutation === 'already-pinned') { f.store.spaces[0].temporaryTabs = [1, 3, 9]; f.store.spaces[0].spaceBookmarks = [2]; }
        if (mutation === 'binding') f.local.pinnedTabStatesById[2] = { bookmarkId: 'elsewhere', pinnedUrl: target.url };
        if (mutation === 'active-space') f.store.active[10] = 'other';
        if (mutation === 'root-moved') f.nodes.find(node => node.id === 'root').parentId = 'bar';
        if (mutation === 'root-deleted') f.nodes.splice(f.nodes.findIndex(node => node.id === 'root'), 1);
        if (mutation === 'root-replaced') f.store.spaces[0].bookmarkFolderId = 'replacement';
        if (mutation === 'invert') f.sync.invertTabOrder = true;
        if (mutation === 'private-tab') target.incognito = true;
        if (mutation === 'private-window') f.hooks.window = () => ({ incognito: true });
        if (mutation === 'non-normal-window') f.hooks.window = () => ({ type: 'popup' });
        await assert.rejects(f.save()); assert.deepEqual(f.effects, []);
    });
}

for (const mutation of ['empty-title', 'long-title', 'duplicate-id', 'missing-url', 'javascript', 'extension', 'oversized']) {
    test(`malformed/unsupported ${mutation} aborts the entire save before writes`, async () => {
        const f = fixture();
        if (mutation === 'empty-title') f.request.title = '   ';
        if (mutation === 'long-title') f.request.title = 'x'.repeat(257);
        if (mutation === 'duplicate-id') f.request.entries[1].tabId = 1;
        if (mutation === 'missing-url') delete f.request.entries[1].url;
        if (mutation === 'javascript') f.request.entries[1].url = 'javascript:alert(1)';
        if (mutation === 'extension') f.request.entries[1].url = 'chrome-extension://test/options.html';
        if (mutation === 'oversized') f.request.entries = Array.from({ length: 101 }, (_, tabId) => ({ tabId, url: 'https://example.test/' }));
        await assert.rejects(f.save()); assert.deepEqual(f.effects, []);
    });
}

test('ordinary internal/file bookmarks remain allowed; startup launcher is never a Today source', async () => {
    const f = fixture(); f.request.entries = f.request.entries.slice(0, 2);
    f.request.entries[0].url = f.tabs[0].url = 'file:///tmp/research.pdf';
    f.request.entries[1].url = f.tabs[1].url = 'chrome://settings/';
    const result = await f.save(); assert.equal(result.completed.length, 2);
    const launcher = fixture(); launcher.request.entries[1].url = launcher.tabs[1].url = 'chrome-extension://test/startup-launcher.html';
    await assert.rejects(launcher.save()); assert.deepEqual(launcher.effects, []);
});

test('fresh guard runs inside the bookmark writer after queue/order reads', async () => {
    const f = fixture(); let reads = 0;
    f.hooks.children = id => { if (id === 'root' && ++reads === 3) f.tabs[1].windowId = 20; };
    await assert.rejects(f.save()); assert.deepEqual(f.effects, []);
});

test('a tab changed while folder creation completes leaves only the empty named folder and stops', async () => {
    const f = fixture(); f.hooks.afterCreate = node => { if (!node.url) f.tabs[1].url = 'https://changed.test/'; };
    await assert.rejects(f.save(), error => error.batch.folderId && error.batch.completed.length === 0 && error.batch.created.length === 0);
    assert.equal(f.creates().length, 1); assert.deepEqual(f.local.pinnedTabStatesById, {});
});

for (const race of ['close', 'window', 'url', 'native-pin']) test(`tab ${race} during bookmark creation preserves bookmark, never binds or attempts remaining tabs`, async () => {
    const f = fixture();
    f.hooks.afterCreate = node => {
        if (!node.url) return;
        if (race === 'close') f.tabs.splice(0, 1);
        if (race === 'window') f.tabs[0].windowId = 20;
        if (race === 'url') f.tabs[0].url = 'https://changed.test/';
        if (race === 'native-pin') f.tabs[0].pinned = true;
    };
    await assert.rejects(f.save(), error => error.batch.created.length === 1 && error.batch.completed.length === 0 && error.batch.failedTabId === 1);
    assert.equal(f.creates().length, 2); assert.deepEqual(f.local.pinnedTabStatesById, {});
});

test('failure after an earlier completed tab reports exact counts and does not retry or delete anything', async () => {
    const f = fixture(); f.hooks.persist = () => { f.tabs[1].url = 'https://changed.test/'; };
    await assert.rejects(f.save(), error => error.batch.completed.length === 1 && error.batch.created.length === 1 && error.batch.failedTabId === 2);
    assert.equal(f.creates().length, 2); assert.equal(f.store.spaces[0].spaceBookmarks.length, 1);
    assert.equal(f.local.pinnedTabStatesById[1].bookmarkId, f.creates()[1].id);
    assert.deepEqual(f.store.spaces[0].temporaryTabs, [2, 3, 9]);
});

test('binding storage failure reports created bookmark as incomplete; later entries untouched', async () => {
    const f = fixture(); f.hooks.storageSet = () => { throw new Error('Storage unavailable'); };
    await assert.rejects(f.save(), error => error.batch.completed.length === 0 && error.batch.created.length === 1 && /Storage/.test(error.message));
    assert.equal(f.creates().length, 2); assert.deepEqual(f.store.spaces[0].temporaryTabs, [1, 2, 3, 9]);
});

test('concurrent folder child insertion is detected by the shared writer with created identity retained', async () => {
    const f = fixture(); f.hooks.afterCreate = node => { if (node.url) f.nodes.push({ id: 'external', parentId: node.parentId, url: 'https://external.test/' }); };
    await assert.rejects(f.save(), error => error.batch.created.length === 1 && error.batch.created[0].bookmarkId === f.creates()[1].id && error.batch.completed.length === 0);
    assert.equal(f.creates().length, 2); assert(f.nodes.some(node => node.id === 'external')); assert.deepEqual(f.local.pinnedTabStatesById, {});
});

test('uncertain creation response is reported once, with no automatic retry/rollback', async () => {
    const f = fixture(); f.hooks.afterCreate = () => { throw new Error('Connection ended after create'); };
    await assert.rejects(f.save(), error => error.batch.uncertain && !error.batch.folderId);
    assert.equal(f.creates().length, 1);
});

test('sender validation rejects external/wrong-window messages and ignores unrelated messages', async () => {
    const f = fixture(); registerTodayFolderMessages(f.store); const listener = f.listeners[0];
    const responses = [];
    assert.equal(listener({ type: 'elsewhere' }, null, value => responses.push(value)), undefined); assert.deepEqual(responses, []);
    listener({ type: 'saveTodayTabsInNewFolder', ...f.request }, { id: 'other' }, value => responses.push(value));
    listener({ type: 'saveTodayTabsInNewFolder', ...f.request }, { id: 'test', tab: { windowId: 20 } }, value => responses.push(value));
    assert.equal(responses.length, 2); assert(responses.every(value => value.success === false)); assert.deepEqual(f.effects, []);
});

for (const race of ['close', 'window', 'navigate', 'other-binding']) test(`binding storage-set ${race} race releases only our new association, keeps bookmark and stops`, async () => {
    const f = fixture(); let once = true;
    f.hooks.storageSet = update => {
        if (!once || !update.pinnedTabStatesById?.[1]) return; once = false;
        if (race === 'close') f.tabs.splice(0, 1);
        if (race === 'window') f.tabs[0].windowId = 20;
        if (race === 'navigate') f.tabs[0].url = 'https://changed.test/';
        if (race === 'other-binding') f.local.pinnedTabStatesById[1] = { bookmarkId: 'somebody-elses', pinnedUrl: 'https://elsewhere.test/' };
    };
    await assert.rejects(f.save(), error => error.batch.created.length === 1 && error.batch.completed.length === 0 && !error.batch.cleanupUncertain);
    assert.equal(f.creates().length, 2); assert.deepEqual(f.store.spaces[0].temporaryTabs, [1, 2, 3, 9]);
    assert.deepEqual(f.store.spaces[0].spaceBookmarks, []);
    if (race === 'other-binding') assert.equal(f.local.pinnedTabStatesById[1].bookmarkId, 'somebody-elses');
    else assert.deepEqual(f.local.pinnedTabStatesById, {});
});

test('race during membership persistence restores only our association and reports durable partial bookmark', async () => {
    const f = fixture(); let once = true;
    f.hooks.persist = () => { if (once) { once = false; f.tabs[0].url = 'https://changed.test/'; } };
    await assert.rejects(f.save(), error => error.batch.created.length === 1 && error.batch.completed.length === 0 && !error.batch.cleanupUncertain);
    assert.deepEqual(f.local.pinnedTabStatesById, {}); assert.deepEqual(f.store.spaces[0].spaceBookmarks, []);
    assert.deepEqual(f.store.spaces[0].temporaryTabs, [1, 2, 3, 9]); assert.equal(f.creates().length, 2);
});

for (const malformed of ['extra-field', 'entry-field', 'unsafe-id', 'zero-id', 'wrong-type', 'entry-array']) test(`strict schema rejects ${malformed} before writes`, async () => {
    const f = fixture();
    if (malformed === 'extra-field') f.request.activate = true;
    if (malformed === 'entry-field') f.request.entries[0].title = 'Forged title';
    if (malformed === 'unsafe-id') f.request.entries[0].tabId = Number.MAX_SAFE_INTEGER + 1;
    if (malformed === 'zero-id') f.request.windowId = 0;
    if (malformed === 'wrong-type') f.request.type = 'favoriteStore';
    if (malformed === 'entry-array') f.request.entries[0] = [];
    await assert.rejects(f.save()); assert.deepEqual(f.effects, []);
});

for (const change of ['delete', 'url', 'title']) test(`final verification detects saved bookmark ${change} during the last membership persist`, async () => {
    const f = fixture(); let saved = 0;
    f.hooks.persist = () => {
        if (++saved !== 3) return;
        const first = f.creates()[1], node = f.nodes.find(node => node.id === first.id);
        if (change === 'delete') f.nodes.splice(f.nodes.indexOf(node), 1);
        if (change === 'url') node.url = 'https://externally-edited.test/';
        if (change === 'title') node.title = 'Externally edited';
    };
    await assert.rejects(f.save(), error => error.batch.completed.length === 3 && /changed/.test(error.message));
    assert.equal(f.creates().length, 4);
});
