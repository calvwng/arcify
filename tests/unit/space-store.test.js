import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { SpaceStore, applySpacePatch, ownerOf } from '../../space-store.js';
import { syncSpaceGroups } from '../../tab-group-sync.js';
import { Utils } from '../../utils.js';

let local, session, sync, tabs, mutations, groups;
const area = data => ({
    async get(keys) {
        const names = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys || data);
        return Object.fromEntries(names.map(k => [k, structuredClone(data[k] ?? keys?.[k])]));
    },
    async set(values) { Object.assign(data, structuredClone(values)); }
});
const space = (id, ids = []) => ({ id, spaceUuid: id, name: id, color: 'blue', bookmarkFolderId: id, spaceBookmarks: [], temporaryTabs: ids });
beforeEach(() => {
    local = { spaceModelVersion: 2, spaces: [space('a', [1]), space('b', [2])] };
    session = { spaceSession: true }; sync = {}; mutations = []; groups = [];
    tabs = [{ id: 1, windowId: 1, url: 'https://one.test/', groupId: -1 }, { id: 2, windowId: 1, url: 'https://two.test/', groupId: -1 }];
    const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); }, emit(...args) { this.listeners.forEach(fn => fn(...args)); } });
    globalThis.chrome = {
        runtime: { getURL: path => `chrome-extension://arcify/${path}` },
        storage: { local: area(local), session: area(session), sync: area(sync), onChanged: event() },
        tabs: { onCreated: event(), onUpdated: event(), onRemoved: event(), onReplaced: event(), onActivated: event(), onMoved: event(), query: async query => tabs.filter(t => query.groupId === undefined || query.groupId === t.groupId),
            group: async args => { mutations.push(['group', args]); const id = args.groupId ?? 100 + groups.length; if (!groups.some(g => g.id === id)) groups.push({ id, windowId: 1 }); tabs.filter(t => args.tabIds.includes(t.id)).forEach(t => t.groupId = id); return id; },
            move: async (...args) => mutations.push(['move', ...args]) },
        tabGroups: { move: async (...args) => mutations.push(['groupMove', ...args]), onRemoved: event(), onUpdated: event(), query: async () => groups, update: async (id, attrs) => { mutations.push(['update', id, attrs]); Object.assign(groups.find(g => g.id === id), attrs); } },
        bookmarks: { search: async () => [{ id: 'root' }], getChildren: async () => [], create: async ({ title }) => ({ id: title, title }) }
    };
});
test('independent default ignores group identity and order and retains empty spaces', async () => {
    tabs[0].groupId = 99; tabs.reverse();
    const store = new SpaceStore();
    await store.dispatch({ action: 'get' });
    assert.equal(ownerOf(store.spaces, 1).id, 'a');
    tabs = tabs.filter(t => t.id !== 1);
    await store.dispatch({ action: 'activate', spaceId: 'a', windowId: 1 });
    assert.deepEqual(local.spaces[0].temporaryTabs, []);
    assert.equal(local.spaces[0].id, 'a');
    assert.deepEqual(mutations, []);
});
test('stale panel patch preserves concurrent tabs, moves and metadata', () => {
    const before = [space('a', [1]), space('b', [2])];
    const current = structuredClone(before); current[0].temporaryTabs.push(3); current[1].color = 'red';
    const after = structuredClone(before); after[0].temporaryTabs = []; after[1].temporaryTabs.push(1);
    const result = applySpacePatch(current, before, after);
    assert.deepEqual(result[0].temporaryTabs, [3]);
    assert.deepEqual(result[1].temporaryTabs, [2, 1]);
    assert.equal(result[1].color, 'red');
});
test('restart remaps URLs to new IDs and retains stored order', async () => {
    session.spaceSession = false;
    local.spaceTabSnapshot = [
        { spaceId: 'a', section: 'temporaryTabs', order: 0, url: 'https://two.test/' },
        { spaceId: 'a', section: 'temporaryTabs', order: 1, url: 'https://one.test/' }
    ];
    tabs = [{ id: 9, windowId: 1, url: 'https://one.test/' }, { id: 8, windowId: 1, url: 'https://two.test/' }, { id: 2, windowId: 1, url: 'https://unrelated.test/' }];
    const store = new SpaceStore(); await store.dispatch({ action: 'get' });
    assert.deepEqual(store.spaces[0].temporaryTabs, [8, 9, 2]);
    assert.deepEqual(store.spaces[1].temporaryTabs, []);
});
test('worker restart preserves session membership and opener determines new tab space', async () => {
    const store = new SpaceStore(); await store.dispatch({ action: 'get' });
    const child = { id: 3, windowId: 1, openerTabId: 2, url: 'https://child.test/' }; tabs.push(child);
    await store.run(async () => { store.track(child); await store.persist(); });
    const next = new SpaceStore(); await next.dispatch({ action: 'get' });
    assert.deepEqual(next.spaces[1].temporaryTabs, [2, 3]);
});
test('explicit assignment beats creation fallback', async () => {
    const store = new SpaceStore(); await store.dispatch({ action: 'get' });
    await store.dispatch({ action: 'assign', tabId: 1, spaceId: 'b', pinned: true });
    assert.deepEqual(local.spaces[0].temporaryTabs, []);
    assert.deepEqual(local.spaces[1].spaceBookmarks, [1]);
});
test('sync is opt-in and disabling it performs no mutations', async () => {
    await syncSpaceGroups(local.spaces); assert.deepEqual(mutations, []);
    sync.syncTabGroups = true; await syncSpaceGroups(local.spaces);
    assert.equal(mutations.filter(m => m[0] === 'group').length, 2);
    assert.deepEqual(local.spaces.map(s => s.id), ['a', 'b']);
    mutations.length = 0; sync.syncTabGroups = false;
    await syncSpaceGroups(local.spaces); assert.deepEqual(mutations, []);
});
test('sync creates each group in its tabs original window', async () => {
    tabs[1].windowId = 2;
    sync.syncTabGroups = true;
    await syncSpaceGroups(local.spaces);
    assert.deepEqual(mutations.filter(m => m[0] === 'group').map(m => m[1]), [
        { tabIds: [1], createProperties: { windowId: 1 } },
        { tabIds: [2], createProperties: { windowId: 2 } }
    ]);
});
test('legacy membership and archived IDs migrate once without group writes', async () => {
    delete local.spaceModelVersion;
    local.spaces = [space(42, [1])]; local.spaces[0].name = 'Work';
    local.archivedTabs = [{ url: 'https://archive.test', spaceId: 42 }];
    tabs[0].groupId = 42;
    const store = new SpaceStore(); await store.dispatch({ action: 'get' });
    assert.equal(typeof local.spaces[0].id, 'string');
    assert.equal(local.archivedTabs[0].spaceId, local.spaces[0].id);
    assert.equal(ownerOf(local.spaces, 1).id, local.spaces[0].id);
    assert.deepEqual(mutations, []);
});
test('optional import copies groups without changing them', async () => {
    groups = [{ id: 42, title: 'Imported', color: 'green', windowId: 1 }]; tabs[1].groupId = 42;
    const store = new SpaceStore(); await store.dispatch({ action: 'import', windowId: 1 });
    assert.equal(ownerOf(local.spaces, 2).name, 'Imported');
    assert.equal(local.tabGroupImportDismissed, true);
    assert.deepEqual(mutations, []);
});
test('late restored URL is assigned after an initially blank tab resolves', async () => {
    session.spaceSession = false;
    local.spaceTabSnapshot = [{ spaceId: 'b', section: 'temporaryTabs', order: 0, url: 'https://late.test/' }];
    tabs = [{ id: 10, windowId: 1 }];
    const store = new SpaceStore(); await store.dispatch({ action: 'get' });
    tabs[0].url = 'https://late.test/';
    await store.run(async () => { store.track(tabs[0]); await store.persist(); });
    assert.equal(ownerOf(local.spaces, 10).id, 'b');
});
test('native pinning removes a space binding even when the sidebar is closed', async () => {
    const store = new SpaceStore(); await store.dispatch({ action: 'get' });
    tabs[0].pinned = true;
    await store.run(async () => { store.track(tabs[0]); await store.persist(); });
    assert.equal(ownerOf(local.spaces, 1), undefined);
    tabs[0].pinned = false;
    await store.run(async () => { store.track(tabs[0]); await store.persist(); });
    assert.equal(ownerOf(local.spaces, 1).id, 'a');
});
test('background event handlers track tab replacement and preserve window-close restore records', async () => {
    const store = new SpaceStore(); store.install(); await store.run(() => {});
    tabs[0].id = 11;
    chrome.tabs.onReplaced.emit(11, 1); await store.run(() => {});
    assert.equal(ownerOf(local.spaces, 11).id, 'a');
    tabs = tabs.filter(t => t.id !== 11);
    chrome.tabs.onRemoved.emit(11, { isWindowClosing: true }); await store.run(() => {});
    assert.equal(local.spaces[0].temporaryTabs.length, 0);
    assert.equal(local.spaceTabSnapshot.find(t => t.url === 'https://one.test/').spaceId, 'a');
});
test('extension pages are removed when a blank helper tab finishes navigating', async () => {
    const store = new SpaceStore(); await store.dispatch({ action: 'get' });
    tabs[0].url = 'chrome-extension://arcify/options.html';
    await store.run(async () => { store.track(tabs[0]); await store.persist(); });
    assert.equal(ownerOf(local.spaces, 1), undefined);
});
test('startup launcher and pending launcher never enter spaces, snapshots or native groups', async () => {
    sync.syncTabGroups = true;
    tabs[0].url = 'chrome-extension://arcify/startup-launcher.html';
    tabs[1].pendingUrl = 'chrome-extension://arcify/startup-launcher.html?restored=1';
    tabs[1].url = 'about:blank';
    const store = new SpaceStore(); await store.dispatch({ action: 'get' });
    assert.equal(ownerOf(local.spaces, 1), undefined);
    assert.equal(ownerOf(local.spaces, 2), undefined);
    assert.deepEqual(local.spaceTabSnapshot, []);
    await syncSpaceGroups(local.spaces);
    assert.deepEqual(mutations, []);
    tabs[1].pendingUrl = undefined;
    tabs[1].url = 'https://browsing.test/';
    await store.run(async () => { store.track(tabs[1]); await store.persist(); });
    assert.equal(ownerOf(local.spaces, 2)?.id, 'a', 'Normal navigation out of the launcher becomes a regular browsing tab');
});
test('migration recovers legacy groups whose IDs changed before the upgrade', async () => {
    delete local.spaceModelVersion;
    local.spaces = [space(42, [1])]; local.spaces[0].name = 'Work';
    local.spaces.push({ ...space(88, []), name: 'Home' });
    groups = [{ id: 77, title: 'Work', color: 'blue', windowId: 1 }, { id: 42, title: 'Unrelated', color: 'red', windowId: 1 }];
    tabs[0].groupId = 77;
    tabs[1].groupId = 42;
    const store = new SpaceStore(); await store.dispatch({ action: 'get' });
    assert.equal(ownerOf(local.spaces, 1).name, 'Work');
    assert.equal(ownerOf(local.spaces, 2).name, 'Home');
    assert.deepEqual(mutations, []);
});
test('restart restores bookmark bindings even after navigation away from the pinned URL', async () => {
    session.spaceSession = false;
    local.pinnedTabStatesById = { 1: { bookmarkId: 'old-wrong' } };
    local.spaceTabSnapshot = [{ spaceId: 'b', section: 'spaceBookmarks', order: 0,
        url: 'https://navigated.test/', pinnedState: { bookmarkId: 'favorite', pinnedUrl: 'https://original.test/' } }];
    tabs = [{ id: 12, windowId: 1, url: 'https://navigated.test/' }];
    const store = new SpaceStore(); await store.dispatch({ action: 'get' });
    assert.deepEqual(local.spaces[1].spaceBookmarks, [12]);
    assert.equal(local.pinnedTabStatesById[12].bookmarkId, 'favorite');
    assert.equal(local.pinnedTabStatesById[1], undefined);
});
test('ordinary new-tab pages use the selected space even with an incidental opener', async () => {
    const store = new SpaceStore();
    await store.dispatch({ action: 'activate', spaceId: 'b', windowId: 1 });
    const tab = { id: 3, windowId: 1, openerTabId: 1, url: 'chrome://newtab/' };
    tabs.push(tab);
    await store.run(async () => { store.track(tab); await store.persist(); });
    assert.equal(ownerOf(local.spaces, 3).id, 'b');
});
test('manual archive records the stored owner without a sidebar global', async () => {
    const removed = [];
    chrome.tabs.get = async id => ({ ...tabs.find(t => t.id === id), title: 'Archived example' });
    chrome.tabs.remove = async id => removed.push(id);
    chrome.runtime.sendMessage = async () => ({ success: true, spaces: local.spaces });
    await Utils.archiveTab(2);
    assert.equal(local.archivedTabs[0].spaceId, 'b');
    assert.equal(local.archivedTabs[0].url, 'https://two.test/');
    assert.deepEqual(removed, [2]);
});
test('explicit tab focus raises the window returned by Chrome', async () => {
    const actions = [];
    chrome.tabs.update = async (id, update) => { actions.push(['tab', id, update]); return { id, windowId: 22 }; };
    chrome.windows = { update: async (id, update) => actions.push(['window', id, update]) };
    await Utils.focusTab(2);
    assert.deepEqual(actions, [['tab', 2, { active: true }], ['window', 22, { focused: true }]]);
});
test('version-2 startup discovers Arcify bookmark spaces with group sync off', async () => {
    local.spaces = [];
    local.spaceRegistry = { project: { spaceUuid: 'saved-project', color: 'purple', bookmarkFolderId: 'project' } };
    const tree = { root: [{ id: 'project', title: 'Project' }, { id: 'loose', title: 'Not a space', url: 'https://loose.test/' }], project: [{ id: 'saved-link', title: 'Saved', url: 'https://saved.test/' }, { id: 'nested', title: 'Reading' }], nested: [] };
    chrome.bookmarks.getChildren = async id => structuredClone(tree[id] || []);
    const store = new SpaceStore();
    await store.dispatch({ action: 'get' });
    assert.equal(store.spaces.length, 1);
    assert.equal(store.spaces[0].id, 'saved-project');
    assert.equal(store.spaces[0].bookmarkFolderId, 'project');
    assert.equal(store.spaces[0].color, 'purple');
    await store.dispatch({ action: 'get' });
    assert.equal(store.spaces.length, 1);
    assert.deepEqual(mutations, []);
    assert.equal(tree.project[0].id, 'saved-link');
});
test('sidebar reads discover later bookmark folders and follow folder renames by ID', async () => {
    let folders = [{ id: 'a', title: 'Renamed' }, { id: 'b', title: 'b' }];
    chrome.bookmarks.getChildren = async id => id === 'root' ? structuredClone(folders) : [];
    const store = new SpaceStore();
    await store.dispatch({ action: 'get' });
    assert.equal(store.spaces.find(s => s.id === 'a').name, 'Renamed');
    folders.push({ id: 'later', title: 'Synced later' });
    await store.dispatch({ action: 'get' });
    assert.equal(store.spaces.length, 3);
    assert.equal(store.spaces[2].bookmarkFolderId, 'later');
    assert.deepEqual(mutations, []);
});

test('restart restores duplicate URLs in different windows with new IDs and reversed enumeration', async () => {
    tabs = [
        { id: 1, windowId: 1, index: 0, url: 'https://same.test/' },
        { id: 3, windowId: 1, index: 1, url: 'https://anchor-a.test/' },
        { id: 2, windowId: 2, index: 0, url: 'https://same.test/' },
        { id: 4, windowId: 2, index: 1, url: 'https://anchor-b.test/' }
    ];
    local.spaces = [space('a', [1, 3]), space('b', [4])];
    local.spaces[1].spaceBookmarks = [2];
    local.tabNameOverridesById = { 1: 'A duplicate', 2: 'B duplicate' };
    local.pinnedTabStatesById = { 2: { bookmarkId: 'b-favorite', pinnedUrl: 'https://same.test/' } };
    await new SpaceStore().dispatch({ action: 'get' });
    assert.notEqual(local.spaceTabSnapshot[0].windowKey, local.spaceTabSnapshot[2].windowKey);
    session = {}; chrome.storage.session = area(session);
    // Query order, window IDs, and tab IDs all change; tab-strip positions do not.
    tabs = [
        { id: 20, windowId: 22, index: 0, url: 'https://same.test/' },
        { id: 40, windowId: 22, index: 1, url: 'https://anchor-b.test/' },
        { id: 30, windowId: 11, index: 1, url: 'https://anchor-a.test/' },
        { id: 10, windowId: 11, index: 0, url: 'https://same.test/' }
    ];
    await new SpaceStore().dispatch({ action: 'get' });
    assert.equal(ownerOf(local.spaces, 10).id, 'a');
    assert.equal(ownerOf(local.spaces, 20).id, 'b');
    assert.deepEqual(local.spaces[1].spaceBookmarks, [20]);
    assert.equal(local.tabNameOverridesById[10], 'A duplicate');
    assert.equal(local.tabNameOverridesById[20], 'B duplicate');
    assert.equal(local.pinnedTabStatesById[20].bookmarkId, 'b-favorite');
});

test('same-window duplicate URLs recover by position rather than query order', async () => {
    tabs = [{ id: 1, windowId: 1, index: 0, url: 'https://same.test/' },
        { id: 2, windowId: 1, index: 1, url: 'https://same.test/' }];
    local.tabNameOverridesById = { 1: 'First', 2: 'Second' };
    await new SpaceStore().dispatch({ action: 'get' });
    session = {}; chrome.storage.session = area(session);
    tabs = [{ id: 20, windowId: 11, index: 1, url: 'https://same.test/' },
        { id: 10, windowId: 11, index: 0, url: 'https://same.test/' }];
    await new SpaceStore().dispatch({ action: 'get' });
    assert.equal(ownerOf(local.spaces, 10).id, 'a');
    assert.equal(ownerOf(local.spaces, 20).id, 'b');
    assert.deepEqual(local.tabNameOverridesById, { 10: 'First', 20: 'Second' });
});

test('identical windows retain ambiguous recovery metadata without assigning it arbitrarily', async () => {
    tabs = [{ id: 1, windowId: 1, index: 0, url: 'https://same.test/' },
        { id: 2, windowId: 2, index: 0, url: 'https://same.test/' }];
    local.tabNameOverridesById = { 1: 'First', 2: 'Second' };
    await new SpaceStore().dispatch({ action: 'get' });
    const saved = structuredClone(local.spaceTabSnapshot);
    session = {}; chrome.storage.session = area(session);
    tabs = [{ id: 20, windowId: 22, index: 0, url: 'https://same.test/' },
        { id: 10, windowId: 11, index: 0, url: 'https://same.test/' }];
    await new SpaceStore().dispatch({ action: 'get' });
    assert.deepEqual(local.tabNameOverridesById, {});
    assert.deepEqual(local.spaceTabSnapshot, saved);
    // A worker suspension/restart must not turn provisional assignments into certainty.
    await new SpaceStore().dispatch({ action: 'get' });
    assert.deepEqual(local.tabNameOverridesById, {});
    assert.deepEqual(local.spaceTabSnapshot, saved);
});

test('legacy ambiguous duplicate URLs do not consume the first restore record', async () => {
    session.spaceSession = false;
    local.spaceTabSnapshot = ['a', 'b'].map(spaceId => ({ spaceId, section: 'temporaryTabs',
        order: 0, url: 'https://same.test/', nameOverride: spaceId }));
    tabs = [{ id: 10, windowId: 1, index: 0, url: 'https://same.test/' },
        { id: 20, windowId: 2, index: 0, url: 'https://same.test/' }];
    const store = new SpaceStore(); await store.dispatch({ action: 'get' });
    assert.equal(store.restoreQueue.length, 2);
    assert.deepEqual(local.tabNameOverridesById, {});
});

test('late window anchors recover duplicate metadata after a worker restart', async () => {
    tabs = [{ id: 1, windowId: 1, index: 0, url: 'https://same.test/' },
        { id: 3, windowId: 1, index: 1, url: 'https://anchor-a.test/' },
        { id: 2, windowId: 2, index: 0, url: 'https://same.test/' },
        { id: 4, windowId: 2, index: 1, url: 'https://anchor-b.test/' }];
    local.spaces = [space('a', [1, 3]), space('b', [2, 4])];
    local.tabNameOverridesById = { 1: 'A', 2: 'B' };
    await new SpaceStore().dispatch({ action: 'get' });
    session = {}; chrome.storage.session = area(session);
    tabs = [{ id: 20, windowId: 22, index: 0, url: 'https://same.test/' },
        { id: 10, windowId: 11, index: 0, url: 'https://same.test/' },
        { id: 30, windowId: 11, index: 1 }, { id: 40, windowId: 22, index: 1 }];
    await new SpaceStore().dispatch({ action: 'get' });
    assert.deepEqual(local.tabNameOverridesById, {});
    const store = new SpaceStore(); await store.dispatch({ action: 'get' });
    tabs[2].url = 'https://anchor-a.test/'; tabs[3].url = 'https://anchor-b.test/';
    await store.run(async () => { store.track(tabs[2]); store.track(tabs[3]); await store.persist(); });
    assert.equal(ownerOf(local.spaces, 10).id, 'a');
    assert.equal(ownerOf(local.spaces, 20).id, 'b');
    assert.deepEqual(local.tabNameOverridesById, { 10: 'A', 20: 'B' });
    assert.equal(store.restoreQueue.length, 0);
});

test('closing and reopening a window retains duplicate URL positions and metadata', async () => {
    tabs = [{ id: 1, windowId: 1, index: 0, url: 'https://same.test/' },
        { id: 2, windowId: 1, index: 1, url: 'https://same.test/' }];
    local.tabNameOverridesById = { 1: 'First', 2: 'Second' };
    const store = new SpaceStore(); store.install(); await store.run(() => {});
    tabs = tabs.filter(t => t.id !== 1);
    chrome.tabs.onRemoved.emit(1, { isWindowClosing: true }); await store.run(() => {});
    tabs = [];
    chrome.tabs.onRemoved.emit(2, { isWindowClosing: true }); await store.run(() => {});
    assert.equal(local.spaceWindowSnapshot[0].tabs.length, 2);
    tabs = [{ id: 20, windowId: 11, index: 1, url: 'https://same.test/' },
        { id: 10, windowId: 11, index: 0, url: 'https://same.test/' }];
    await new SpaceStore().dispatch({ action: 'get' });
    assert.equal(ownerOf(local.spaces, 10).id, 'a');
    assert.equal(ownerOf(local.spaces, 20).id, 'b');
    assert.equal(local.tabNameOverridesById[10], 'First');
    assert.equal(local.tabNameOverridesById[20], 'Second');
});

test('recovery mappings do not reserve a closed window forever on repeated reopen', async () => {
    tabs = [{ id: 1, windowId: 1, index: 0, url: 'https://same.test/' },
        { id: 2, windowId: 1, index: 1, url: 'https://same.test/' }];
    local.tabNameOverridesById = { 1: 'First', 2: 'Second' };
    const store = new SpaceStore(); store.install(); await store.run(() => {});
    for (const [first, second, windowId] of [[10, 20, 11], [100, 200, 22]]) {
        const closedIds = tabs.map(t => t.id);
        tabs = [];
        for (const id of closedIds) chrome.tabs.onRemoved.emit(id, { isWindowClosing: true });
        await store.run(() => {});
        tabs = [{ id: second, windowId, index: 1, url: 'https://same.test/' },
            { id: first, windowId, index: 0, url: 'https://same.test/' }];
        for (const tab of tabs) chrome.tabs.onCreated.emit(tab);
        await store.run(() => {});
        assert.equal(ownerOf(local.spaces, first).id, 'a');
        assert.equal(ownerOf(local.spaces, second).id, 'b');
        assert.equal(local.tabNameOverridesById[first], 'First');
        assert.equal(local.tabNameOverridesById[second], 'Second');
        assert.equal(store.restoreQueue.length, 0);
    }
});

test('native tab moves refresh duplicate restoration positions without changing space order', async () => {
    tabs = [{ id: 1, windowId: 1, index: 0, url: 'https://same.test/' },
        { id: 2, windowId: 1, index: 1, url: 'https://same.test/' }];
    local.tabNameOverridesById = { 1: 'First', 2: 'Second' };
    const store = new SpaceStore(); store.install(); await store.run(() => {});
    tabs[0].index = 1; tabs[1].index = 0;
    chrome.tabs.onMoved.emit(1, { windowId: 1, fromIndex: 0, toIndex: 1 });
    await new Promise(resolve => setTimeout(resolve, 250));
    await store.run(() => {});
    assert.equal(local.spaceTabSnapshot.find(t => t.tabId === 1).tabIndex, 1);
    assert.equal(ownerOf(local.spaces, 1).id, 'a');
    session = {}; chrome.storage.session = area(session);
    tabs = [{ id: 20, windowId: 11, index: 0, url: 'https://same.test/' },
        { id: 10, windowId: 11, index: 1, url: 'https://same.test/' }];
    await new SpaceStore().dispatch({ action: 'get' });
    assert.equal(ownerOf(local.spaces, 10).id, 'a');
    assert.equal(ownerOf(local.spaces, 20).id, 'b');
    assert.deepEqual(local.tabNameOverridesById, { 10: 'First', 20: 'Second' });
});

test('native-group imports, explicit assignment and stale patches cannot persist launcher membership', async () => {
    tabs[0].url = chrome.runtime.getURL('startup-launcher.html');
    tabs[0].groupId = 99;
    groups.push({ id: 99, windowId: 1, title: 'Imported', color: 'blue' });
    const store = new SpaceStore(); await store.dispatch({ action: 'get' });
    await store.dispatch({ action: 'import', windowId: 1 });
    assert.equal(ownerOf(local.spaces, 1), undefined);
    await store.dispatch({ action: 'assign', tabId: 1, spaceId: 'a', pinned: true });
    assert.equal(ownerOf(local.spaces, 1), undefined);
    const before = structuredClone(store.spaces);
    const after = structuredClone(before);
    after[0].temporaryTabs.push(1);
    await store.dispatch({ action: 'patch', before, after });
    assert.equal(ownerOf(local.spaces, 1), undefined);
    assert.equal(local.spaceTabSnapshot.some(tab => tab.tabId === 1), false);
    assert.equal(JSON.stringify(local.spaceWindowSnapshot).includes('startup-launcher.html'), false);
});

const order = list => list.map(space => space.id);
test('first imported folder discovery preserves Chrome order and existing order is never silently reseeded', async () => {
    let folders = ['Personal', 'GenAI', 'Finance'].map(title => ({ id: title, title }));
    chrome.bookmarks.getChildren = async id => id === 'root' ? structuredClone(folders) : [];
    local.spaces = []; tabs = [];
    const seeded = await new SpaceStore().dispatch({ action: 'get' });
    assert.deepEqual(seeded.map(space => space.name), ['Personal', 'GenAI', 'Finance']);
    const byName = new Map(seeded.map(space => [space.name, space]));
    local.spaces = ['GenAI', 'Finance'].map(name => byName.get(name));
    const discovered = await new SpaceStore().dispatch({ action: 'get' });
    assert.deepEqual(discovered.map(space => space.name), ['GenAI', 'Finance', 'Personal']);
    assert.equal(discovered[2].id, byName.get('Personal').id);
});

test('explicit ID-relative reorder persists across worker and browser reload, folder sync and renames', async () => {
    let folders = [{ id: 'a', title: 'Personal' }, { id: 'b', title: 'GenAI' }, { id: 'c', title: 'Finance' }];
    chrome.bookmarks.getChildren = async id => id === 'root' ? structuredClone(folders) : [];
    local.spaces.push(space('c'));
    session.activeSpaces = { 1: 'a', 2: 'b' };
    const store = new SpaceStore();
    const original = await store.dispatch({ action: 'get' });
    await store.dispatch({ action: 'reorder', spaceId: 'c', anchorSpaceId: 'a', position: 'before' });
    assert.deepEqual(order(local.spaces), ['c', 'a', 'b']);
    assert.deepEqual(session.activeSpaces, { 1: 'a', 2: 'b' });
    for (const saved of local.spaces) assert.deepEqual(saved, original.find(space => space.id === saved.id));
    assert.deepEqual(order(await new SpaceStore().dispatch({ action: 'get' })), ['c', 'a', 'b']);
    // Changed bookmark order/rename is not a second ordering database.
    folders.reverse(); folders.find(folder => folder.id === 'a').title = 'Renamed';
    folders.unshift({ id: 'new', title: 'New' });
    const synced = await store.dispatch({ action: 'get' });
    assert.deepEqual(order(synced).slice(0, 3), ['c', 'a', 'b']);
    assert.equal(synced.at(-1).bookmarkFolderId, 'new');
    assert.equal(synced.find(space => space.id === 'a').name, 'Renamed');
    const expected = order(synced);
    session = {}; chrome.storage.session = area(session);
    assert.deepEqual(order(await new SpaceStore().dispatch({ action: 'get' })), expected);
    assert.deepEqual(mutations, []);
});

test('multiwindow relative moves apply to latest order and retain concurrent membership and new spaces', async () => {
    local.spaces.push(space('c'));
    const store = new SpaceStore(); const before = await store.dispatch({ action: 'get' });
    await store.dispatch({ action: 'reorder', spaceId: 'c', anchorSpaceId: 'a', position: 'before' });
    const added = structuredClone(before); added.push(space('d')); added[0].temporaryTabs.push(3);
    tabs.push({ id: 3, windowId: 2, url: 'https://three.test/' });
    await store.dispatch({ action: 'patch', before, after: added });
    assert.deepEqual(order(local.spaces), ['c', 'a', 'b', 'd']);
    await store.dispatch({ action: 'reorder', spaceId: 'a', anchorSpaceId: 'b', position: 'after' });
    assert.deepEqual(order(local.spaces), ['c', 'b', 'a', 'd']);
    assert.deepEqual(local.spaces.find(space => space.id === 'a').temporaryTabs, [1, 3]);
    const removed = before.filter(space => space.id !== 'b');
    await store.dispatch({ action: 'patch', before, after: removed });
    assert.deepEqual(order(local.spaces), ['c', 'a', 'd']);
});

test('stale unrelated edits and deletion cannot restore a previous space order or resurrect deleted spaces', () => {
    const before = ['a', 'b', 'c'].map(id => space(id));
    const current = [before[2], before[0], before[1], space('new')];
    const renamed = structuredClone(before); renamed[0].name = 'Rename';
    assert.deepEqual(order(applySpacePatch(current, before, renamed)), ['c', 'a', 'b', 'new']);
    assert.deepEqual(order(applySpacePatch(current, before, renamed.filter(space => space.id !== 'b'))), ['c', 'a', 'new']);
    const newAfter = [...before, space('added')];
    assert.deepEqual(order(applySpacePatch(current.filter(space => space.id !== 'b'), before, newAfter)), ['c', 'a', 'new', 'added']);
    // Generic full-array patches cannot undo order either; only reorder owns it.
    assert.deepEqual(order(applySpacePatch([before[0], space('new'), before[1], before[2]], before, [before[2], before[0], before[1]])), ['a', 'new', 'b', 'c']);
});

test('invalid or stale relative moves reject without writes; source self-drop leaves state intact', async () => {
    const store = new SpaceStore(); await store.dispatch({ action: 'get' });
    const baseline = structuredClone(local);
    for (const payload of [
        { spaceId: 'a', anchorSpaceId: 'missing', position: 'before' },
        { spaceId: 'missing', anchorSpaceId: 'a', position: 'after' },
        { spaceId: 'a', anchorSpaceId: 'b', position: 'invalid' }
    ]) {
        await assert.rejects(store.dispatch({ action: 'reorder', ...payload }));
        assert.deepEqual(local, baseline);
    }
    await store.dispatch({ action: 'reorder', spaceId: 'a', anchorSpaceId: 'a', position: 'before' });
    assert.deepEqual(local.spaces, baseline.spaces);
});
