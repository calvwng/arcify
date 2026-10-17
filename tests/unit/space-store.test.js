import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { SpaceStore, applySpacePatch, ownerOf } from '../../space-store.js';
import { syncSpaceGroups } from '../../tab-group-sync.js';
import { Utils } from '../../utils.js';
import { registerArchiveMessages } from '../../archive-store.js';

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
    await store.run(async () => { store.track(child, { nativeTabs: tabs, created: true }); await store.persist(); });
    const next = new SpaceStore(); await next.dispatch({ action: 'get' });
    assert.deepEqual(next.spaces[1].temporaryTabs, [3, 2]);
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
    const store = new SpaceStore(); await store.dispatch({ action: 'get' });
    chrome.windows = { get: async id => ({ id, type: 'normal' }) };
    chrome.bookmarks.get = async id => [{ id, parentId: 'root' }];
    const listeners = []; chrome.runtime.id = 'arcify'; chrome.runtime.onMessage = { addListener(fn) { listeners.push(fn); } };
    registerArchiveMessages(store);
    chrome.runtime.sendMessage = message => message.type === 'spaceStore' ? Promise.resolve({ success: true, spaces: local.spaces })
        : new Promise(resolve => listeners[0](message, { id: 'arcify' }, resolve));
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

test('queued Space basics preserve stable identity, order, ownership and active selection through metadata edits', async () => {
    const folders = [ { id: 'a', title: 'Same name', parentId: 'root' }, { id: 'b', title: 'Same name', parentId: 'root' } ];
    chrome.bookmarks.getChildren = async id => id === 'root' ? structuredClone(folders) : [];
    chrome.bookmarks.get = async id => structuredClone(folders.filter(folder => folder.id === id));
    chrome.bookmarks.update = async (id, attrs) => { mutations.push(['bookmark-update', id, attrs]); Object.assign(folders.find(folder => folder.id === id), attrs); };
    session.activeSpaces = { 1: 'a', 2: 'a' };
    const store = new SpaceStore(); await store.dispatch({ action: 'get' });
    const stale = structuredClone(store.spaces);
    await store.dispatch({ action: 'metadata', spaceId: 'b', changes: { name: ' Renamed ', color: 'cyan', icon: 'rocket' } });
    assert.equal(local.spaces[1].id, 'b'); assert.equal(local.spaces[1].name, 'Renamed');
    assert.equal(local.spaces[1].color, 'cyan'); assert.equal(local.spaces[1].icon, 'rocket');
    assert.deepEqual(local.spaces.map(space => space.id), ['a', 'b']);
    assert.deepEqual(session.activeSpaces, { 1: 'a', 2: 'a' });
    assert.deepEqual(local.spaces.map(space => space.temporaryTabs), [[1], [2]]);
    assert.equal(local.spaceRegistry.b.spaceUuid, 'b'); assert.equal(local.spaceRegistry.b.icon, 'rocket');
    assert.deepEqual(mutations, [['bookmark-update', 'b', { title: 'Renamed' }]]);
    const after = structuredClone(stale); after[0].color = 'green';
    await store.dispatch({ action: 'patch', before: stale, after });
    assert.equal(local.spaces[1].icon, 'rocket'); assert.equal(local.spaces[1].name, 'Renamed');
    const restarted = new SpaceStore(); await restarted.dispatch({ action: 'get' });
    assert.equal(restarted.spaces[1].icon, 'rocket');
    local.spaces = []; session.spaceSession = false; tabs = [];
    const recovered = new SpaceStore(); await recovered.dispatch({ action: 'get' });
    assert.equal(recovered.spaces[1].id, 'b'); assert.equal(recovered.spaces[1].icon, 'rocket'); assert.equal(recovered.spaces[1].color, 'cyan');
    await recovered.dispatch({ action: 'metadata', spaceId: 'b', changes: { icon: null } });
    local.spaces = []; session.spaceSession = false;
    const reset = new SpaceStore(); await reset.dispatch({ action: 'get' });
    assert.equal(reset.spaces[1].icon, undefined); assert.equal(local.spaceRegistry.b.icon, null);
});

test('Space metadata rejects unsupported IDs, values and vanished backing folders before writing', async () => {
    const store = new SpaceStore(); await store.dispatch({ action: 'get' });
    chrome.bookmarks.get = async id => [{ id, title: id, parentId: 'root' }];
    chrome.bookmarks.update = async (...args) => mutations.push(args);
    for (const changes of [{ icon: '<img src=x>' }, { color: 'orange' }, { name: ' ' }, { name: 'a'.repeat(257) }, { bookmarkFolderId: 'other' }]) {
        await assert.rejects(store.dispatch({ action: 'metadata', spaceId: 'b', changes }));
    }
    await assert.rejects(store.dispatch({ action: 'metadata', spaceId: 'deleted', changes: { icon: 'star' } }), /no longer exists/);
    chrome.bookmarks.get = async () => [];
    await assert.rejects(store.dispatch({ action: 'metadata', spaceId: 'b', changes: { icon: 'star' } }), /unavailable/);
    assert.deepEqual(mutations, []); assert.equal(local.spaces[1].icon, undefined);
});

test('New Folder uses the exact inactive Space root through existing folder policy with sync both on and off', async () => {
    chrome.bookmarks.get = async id => [{ id, title: 'Same name', parentId: 'root' }];
    chrome.bookmarks.create = async data => { mutations.push(data); return { ...data, id: 'new-folder' }; };
    session.activeSpaces = { 1: 'a' };
    const store = new SpaceStore(); await store.dispatch({ action: 'get' });
    for (const syncTabGroups of [false, true]) {
        sync.syncTabGroups = syncTabGroups;
        await store.dispatch({ action: 'newFolder', spaceId: 'b', title: ' Reading ' });
    }
    assert.deepEqual(mutations.filter(item => item.parentId), [{ parentId: 'b', title: 'Reading' }, { parentId: 'b', title: 'Reading' }]);
    assert.deepEqual(session.activeSpaces, { 1: 'a' });
    await assert.rejects(store.dispatch({ action: 'newFolder', spaceId: 'removed', title: 'Reading' }), /no longer exists/);
    await assert.rejects(store.dispatch({ action: 'newFolder', spaceId: 'b', title: ' ' }), /folder name/);
});

test('Space deletion removes only its backing subtree and closes owned tabs in every window while global Favorites survive', async () => {
    tabs.push({ id: 3, windowId: 2, url: 'https://other-window.test/' }, { id: 4, windowId: 2, url: 'https://favorite.test/' });
    local.spaces[1].temporaryTabs.push(3, 4);
    local.persistentFavorites = [{ id: 'favorite', url: 'https://favorite.test/' }];
    const removed = [], trees = [];
    chrome.tabs.get = async id => structuredClone(tabs.find(tab => tab.id === id));
    chrome.tabs.remove = async id => { removed.push(id); tabs = tabs.filter(tab => tab.id !== id); };
    chrome.bookmarks.removeTree = async id => trees.push(id);
    const store = new SpaceStore();
    store.favoriteStore = { async initialize() {}, async reconcile() {}, noteSpaceExclusion() {}, ownsTab: tab => (typeof tab === 'number' ? tab : tab?.id) === 4 };
    await store.dispatch({ action: 'delete', spaceId: 'b' });
    assert.deepEqual(removed.sort(), [2, 3]); assert.deepEqual(trees, ['b']);
    assert.deepEqual(tabs.map(tab => tab.id), [1, 4]);
    assert.deepEqual(local.persistentFavorites, [{ id: 'favorite', url: 'https://favorite.test/' }]);
});

test('registry icon recovery never copies metadata from a different UUID and metadata writes reject that mismatch', async () => {
    local.spaceRegistry = { b: { spaceUuid: 'different-space', bookmarkFolderId: 'b', icon: 'heart', color: 'pink' } };
    chrome.bookmarks.getChildren = async id => id === 'root' ? [{ id: 'a', title: 'a' }, { id: 'b', title: 'b' }] : [];
    chrome.bookmarks.get = async id => [{ id, title: id, parentId: 'root' }];
    const store = new SpaceStore(); await store.dispatch({ action: 'get' });
    assert.equal(store.spaces[1].icon, undefined); assert.equal(store.spaces[1].color, 'blue');
    await assert.rejects(store.dispatch({ action: 'metadata', spaceId: 'b', changes: { icon: 'rocket' } }), /identity has changed/);
    assert.equal(local.spaceRegistry.b.icon, 'heart'); assert.equal(local.spaces[1].icon, undefined);
});

test('successful New Folder does not run unrelated persistence that could turn a committed create into a retry', async () => {
    const store = new SpaceStore(); await store.dispatch({ action: 'get' });
    chrome.bookmarks.get = async id => [{ id, title: id, parentId: 'root' }];
    const created = [];
    chrome.bookmarks.create = async data => { created.push(data); return { ...data, id: 'new' }; };
    store.persist = async () => { throw new Error('Unrelated Space storage unavailable'); };
    const result = await store.dispatch({ action: 'newFolder', spaceId: 'b', title: 'Created once' });
    assert.deepEqual(created, [{ parentId: 'b', title: 'Created once' }]);
    assert.deepEqual(result.map(space => space.id), ['a', 'b']);
});

test('Space rename and folder creation retain the existing backing-root boundary after a folder is moved outside Arcify', async () => {
    const store = new SpaceStore(); await store.dispatch({ action: 'get' });
    chrome.bookmarks.get = async id => [{ id, title: id, parentId: 'outside' }];
    chrome.bookmarks.update = async (...args) => mutations.push(args);
    chrome.bookmarks.create = async (...args) => mutations.push(args);
    await assert.rejects(store.dispatch({ action: 'metadata', spaceId: 'b', changes: { name: 'Must not rename' } }), /no longer inside the Arcify/);
    await assert.rejects(store.dispatch({ action: 'newFolder', spaceId: 'b', title: 'Must not create' }), /no longer inside the Arcify/);
    assert.deepEqual(mutations, []);
});

test('explicit split preparation can persist canonical state without triggering native group projection', async () => {
    const store = new SpaceStore(); await store.dispatch({ action: 'get' });
    sync.syncTabGroups = true;
    store.spaces[0].name = 'Canonical update';
    await store.persist({ skipGroupSync: true });
    assert.equal(local.spaces[0].name, 'Canonical update'); assert.deepEqual(mutations, []);
    await store.persist(); assert(mutations.some(([kind]) => kind === 'group'));
});

test('native split updates resume deferred projection through the existing debounced event path', async () => {
    tabs[0].splitViewId = tabs[1].splitViewId = 0;
    const store = new SpaceStore(); store.install(); await store.run(() => {});
    sync.syncTabGroups = true;
    await store.persist(); assert.deepEqual(mutations, []);
    tabs[0].splitViewId = tabs[1].splitViewId = -1;
    chrome.tabs.onUpdated.emit(1, { splitViewId: -1 }, tabs[0]);
    await new Promise(resolve => setTimeout(resolve, 230)); await store.run(() => {});
    assert(mutations.some(([kind]) => kind === 'group')); assert.deepEqual(session.spaceGroupSplitDeferrals, []);
});

for (const openerTabId of [1, 2]) test(`browser child from split pane ${openerTabId} inserts after exact current pair`, async () => {
    local.spaces = [space('a', [1, 2, 4])];
    tabs.push({ id: 4, windowId: 1, url: 'https://tail.test/', index: 2, groupId: -1 });
    tabs[0].index = 0; tabs[1].index = 1;
    const store = new SpaceStore(); store.install(); await store.run(() => {});
    // Intentionally stale cache: the event must consult current native metadata.
    store.liveTabs = new Map(tabs.map(tab => [tab.id, structuredClone(tab)]));
    tabs[0].splitViewId = tabs[1].splitViewId = 77;
    const child = { id: 3, windowId: 1, openerTabId, url: 'https://child.test/', index: 3, groupId: -1 };
    tabs.push(child); chrome.tabs.onCreated.emit(child); await store.run(() => {});
    assert.deepEqual(store.spaces[0].temporaryTabs, [3, 1, 2, 4]);
    assert.equal(tabs[0].splitViewId, 77); assert.equal(tabs[1].splitViewId, 77); assert.deepEqual(mutations, []);
});

for (const uncertain of ['missing-peer', 'native-gap', 'group-mismatch', 'query-failure']) test(`uncertain split opener ${uncertain} appends without native repair`, async () => {
    local.spaces = [space('a', [1, 2, 4])];
    tabs.push({ id: 4, windowId: 1, url: 'https://tail.test/', index: 2, groupId: -1 });
    tabs[0].index = 0; tabs[1].index = 1;
    const store = new SpaceStore(); store.install(); await store.run(() => {});
    tabs[0].splitViewId = tabs[1].splitViewId = 77;
    if (uncertain === 'missing-peer') tabs[1].splitViewId = -1;
    if (uncertain === 'native-gap') tabs[1].index = 3;
    if (uncertain === 'group-mismatch') tabs[1].groupId = 5;
    const query = chrome.tabs.query;
    if (uncertain === 'query-failure') chrome.tabs.query = async args => { if (args.windowId) throw new Error('Transient native read'); return query(args); };
    const child = { id: 3, windowId: 1, openerTabId: 1, url: 'https://child.test/', index: 4, groupId: -1 };
    tabs.push(child); chrome.tabs.onCreated.emit(child); await store.run(() => {});
    assert.deepEqual(store.spaces[0].temporaryTabs, [1, 2, 4, 3]); assert.deepEqual(mutations, []);
});

test('ordinary native opener child inserts directly below its visible source', async () => {
    local.spaces = [space('a', [1, 2])];
    const store = new SpaceStore(); store.install(); await store.run(() => {});
    const child = { id: 3, windowId: 1, openerTabId: 1, url: 'https://child.test/', groupId: -1 };
    tabs.push(child); chrome.tabs.onCreated.emit(child); await store.run(() => {});
    assert.deepEqual(store.spaces[0].temporaryTabs, [3, 1, 2]); assert.deepEqual(mutations, []);
});

const visibleToday = (store, id = 'a') => {
    const ids = [...store.spaces.find(space => space.id === id).temporaryTabs];
    return store.todayOrderInverted ? ids.reverse() : ids;
};
for (const inverted of [false, true]) for (const top of [false, true]) test(`new Today insertion is prospective and visible-order aware inverted=${inverted} top=${top}`, async () => {
    sync.invertTabOrder = inverted; sync.todayNewTabsAtTop = top;
    local.spaces = [space('a', [1, 2])];
    const store = new SpaceStore(); store.install(); await store.run(() => {});
    assert.deepEqual(store.spaces[0].temporaryTabs, [1, 2]);
    const oldVisible = visibleToday(store);
    // The legacy Pinned-only option no longer changes Today representation.
    sync.invertTabOrder = !inverted;
    const standalone = { id: 3, windowId: 1, url: 'https://new.test/' };
    tabs.push(standalone); chrome.tabs.onCreated.emit(standalone); await store.run(() => {});
    assert.deepEqual(visibleToday(store), top ? [3, ...oldVisible] : [...oldVisible, 3]);
    const child = { id: 4, windowId: 1, openerTabId: 1, url: 'https://child.test/' };
    tabs.push(child); chrome.tabs.onCreated.emit(child); await store.run(() => {});
    const visible = visibleToday(store); assert.equal(visible[visible.indexOf(1) + 1], 4);
    const before = [...store.spaces[0].temporaryTabs];
    chrome.tabs.onUpdated.emit(4, { url: 'https://navigated.test/' }, { ...child, url: 'https://navigated.test/' });
    await store.run(() => {}); assert.deepEqual(store.spaces[0].temporaryTabs, before);
    const reload = new SpaceStore(); await reload.initialize();
    assert.deepEqual(visibleToday(reload), visible);
});

for (const reason of ['other-window', 'saved-pin', 'native-pin', 'global', 'provisional', 'recovering', 'missing', 'ambiguous', 'incognito', 'blank-child']) test(`untrusted ${reason} opener uses standalone Today in the selected Space`, async () => {
    sync.invertTabOrder = false;
    session.activeSpaces = { 1: 'b' };
    const store = new SpaceStore(); store.install(); await store.run(() => {});
    if (reason === 'other-window') tabs[0].windowId = 2;
    if (reason === 'saved-pin') { store.spaces[0].temporaryTabs = []; store.spaces[0].spaceBookmarks = [1]; }
    if (reason === 'native-pin') tabs[0].pinned = true;
    if (reason === 'global') store.isGlobalTab = value => (typeof value === 'object' ? value.id : value) === 1;
    if (reason === 'provisional') store.provisional.add(1);
    if (reason === 'recovering') store.recoveryCandidates.add(1);
    if (reason === 'missing') tabs.shift();
    if (reason === 'ambiguous') store.spaces[1].temporaryTabs.push(1);
    if (reason === 'incognito') tabs[0].incognito = true;
    const tab = { id: 3, windowId: 1, openerTabId: 1, url: reason === 'blank-child' ? 'about:blank' : 'https://one.test/' };
    tabs.push(tab); chrome.tabs.onCreated.emit(tab); await store.run(() => {});
    assert.equal(ownerOf(store.spaces, 3).id, 'b');
    assert.equal(visibleToday(store, 'b')[0], 3);
});

test('fresh same-window Today opener carries exact Space despite a different selected Space', async () => {
    sync.invertTabOrder = false; session.activeSpaces = { 1: 'b' };
    const store = new SpaceStore(); store.install(); await store.run(() => {});
    const child = { id: 3, windowId: 1, openerTabId: 1, url: 'https://two.test/' };
    tabs.push(child); chrome.tabs.onCreated.emit(child); await store.run(() => {});
    assert.deepEqual(store.spaces[0].temporaryTabs, [1, 3]); assert.deepEqual(store.spaces[1].temporaryTabs, [2]);
});

for (const inverted of [false, true]) test(`cold onCreated retains creation intent exactly once inverted=${inverted}`, async () => {
    sync.invertTabOrder = inverted; local.spaces = [space('a', [1, 2])];
    const child = { id: 3, windowId: 1, openerTabId: 1, url: 'https://child.test/' };
    tabs.unshift(child);
    const store = new SpaceStore(); store.install(); chrome.tabs.onCreated.emit(child); await store.run(() => {});
    const visible = visibleToday(store); assert.equal(visible[visible.indexOf(1) + 1], 3);
    assert.equal(visible.filter(id => id === 3).length, 1);
    assert.equal(store.pendingCreations.size, 0);
});

test('cold onCreated never overrides a real restore record', async () => {
    sync.invertTabOrder = false; session.spaceSession = false;
    local.spaceTabSnapshot = [
        { spaceId: 'a', section: 'temporaryTabs', order: 0, url: 'https://one.test/' },
        { spaceId: 'a', section: 'temporaryTabs', order: 1, url: 'https://two.test/' }
    ];
    const store = new SpaceStore(); store.install(); chrome.tabs.onCreated.emit(tabs[1]); await store.run(() => {});
    assert.deepEqual(store.spaces[0].temporaryTabs, [1, 2]);
});

test('new placement never applies to ordinary adoption or re-tracking existing tabs', async () => {
    sync.invertTabOrder = false; local.spaces = [space('a', [1, 2])];
    const store = new SpaceStore(); await store.initialize();
    const adopted = { id: 3, windowId: 1, openerTabId: 1, url: 'https://adopted.test/' };
    tabs.push(adopted); store.track(adopted); await store.persist();
    assert.deepEqual(store.spaces[0].temporaryTabs, [1, 2, 3]);
    store.track({ ...tabs[1], openerTabId: 1 }, { nativeTabs: tabs, created: true });
    assert.deepEqual(store.spaces[0].temporaryTabs, [1, 2, 3]);
});

for (const inverted of [false, true]) test(`explicit new assignment is standalone while generic assignment retains existing behavior inverted=${inverted}`, async () => {
    sync.invertTabOrder = inverted; local.spaces = [space('a', [1, 2]), space('b')];
    const store = new SpaceStore(); await store.initialize();
    const tab = { id: 3, windowId: 1, openerTabId: 1, url: 'https://same.test/' }; tabs.push(tab);
    await store.dispatch({ action: 'assign', tabId: 3, spaceId: 'a', newTodayTab: true });
    assert.equal(visibleToday(store)[0], 3);
    await store.dispatch({ action: 'assign', tabId: 1, spaceId: 'b' });
    assert.deepEqual(store.spaces[1].temporaryTabs, [1]);
});

for (const inverted of [false, true]) for (const edit of ['new', 'manual']) test(`late restoration cannot undo ${edit} ordering across worker reload inverted=${inverted}`, async () => {
    sync.invertTabOrder = inverted; local.spaces = [space('a', [1, 2])];
    session.restoredTabRanks = [[1, 0], [2, 2]];
    session.spaceRestoreQueue = [{ spaceId: 'a', section: 'temporaryTabs', order: 1, url: 'https://late-order.test/' }];
    const store = new SpaceStore(); store.install(); await store.run(() => {});
    if (edit === 'new') {
        const fresh = { id: 3, windowId: 1, url: 'https://fresh-order.test/' };
        tabs.push(fresh); chrome.tabs.onCreated.emit(fresh); await store.run(() => {});
    } else {
        const before = structuredClone(store.spaces), after = structuredClone(before);
        after[0].temporaryTabs.reverse(); await store.dispatch({ action: 'patch', before, after });
    }
    const intended = [...store.spaces[0].temporaryTabs];
    const reload = new SpaceStore(); await reload.initialize();
    const late = { id: 4, windowId: 1, url: 'https://late-order.test/' }; tabs.push(late);
    reload.track(late); await reload.persist();
    assert.deepEqual(reload.spaces[0].temporaryTabs.filter(id => id !== 4), intended);
    if (edit === 'new') assert.equal(visibleToday(reload)[0], 3);
    const again = new SpaceStore(); await again.initialize(); assert.deepEqual(again.spaces[0].temporaryTabs, reload.spaces[0].temporaryTabs);
});

test('an exact saved binding already written during pinning cannot supply Today opener scope or adjacency', async () => {
    sync.invertTabOrder = false; session.activeSpaces = { 1: 'b' };
    const store = new SpaceStore(); store.install(); await store.run(() => {});
    local.pinnedTabStatesById = { 1: { bookmarkId: 'saved-in-flight', pinnedUrl: tabs[0].url } };
    const child = { id: 3, windowId: 1, openerTabId: 1, url: 'https://child.test/' };
    tabs.push(child); chrome.tabs.onCreated.emit(child); await store.run(() => {});
    assert.deepEqual(store.spaces[1].temporaryTabs, [3, 2]);
});

for (const drift of ['setting', 'window', 'binding']) test(`cold creation rechecks ${drift} after initialization I/O`, async () => {
    sync.invertTabOrder = false; session.activeSpaces = { 1: 'b' };
    const child = { id: 3, windowId: 1, ...(drift !== 'setting' ? { openerTabId: 1 } : {}), url: 'https://cold.test/' };
    tabs.push(child);
    const store = new SpaceStore();
    store.discoverBookmarkSpaces = async () => {
        if (drift === 'setting') sync.todayNewTabsAtTop = false;
        if (drift === 'window') tabs[0].windowId = 2;
        if (drift === 'binding') local.pinnedTabStatesById = { 1: { bookmarkId: 'new-pin' } };
    };
    store.install(); chrome.tabs.onCreated.emit(child); await store.run(() => {});
    assert.deepEqual(store.spaces[1].temporaryTabs, drift === 'setting' ? [2, 3] : [3, 2]);
});

for (const inverted of [false, true]) for (const top of [false, true]) test(`uncertain native split stays intact with standalone setting inverted=${inverted} top=${top}`, async () => {
    sync.invertTabOrder = inverted; sync.todayNewTabsAtTop = top; local.spaces = [space('a', [1, 2])];
    const store = new SpaceStore(); store.install(); await store.run(() => {});
    tabs[0].splitViewId = tabs[1].splitViewId = 77; tabs[0].index = 0; tabs[1].index = 3;
    const child = { id: 3, windowId: 1, openerTabId: 1, url: 'https://child.test/', index: 4 };
    tabs.push(child); chrome.tabs.onCreated.emit(child); await store.run(() => {});
    const visible = visibleToday(store);
    assert.equal(visible[top ? 0 : visible.length - 1], 3);
    assert.deepEqual(store.spaces[0].temporaryTabs.filter(id => id !== 3), [1, 2]);
    assert.deepEqual(mutations, []);
});

for (const inverted of [false, true]) test(`late other-window restore retains exact pending window scope and authored order inverted=${inverted}`, async () => {
    sync.invertTabOrder = inverted; tabs[1].windowId = 2;
    local.spaces = [space('a', [1, 2])];
    session.restoredTabRanks = [[1, 0], [2, 2]];
    session.spaceRestoreWindowKeys = [[2, 'second-window']];
    session.spaceRestoreQueue = [{ spaceId: 'a', section: 'temporaryTabs', order: 1, url: 'https://late-window.test/', windowKey: 'second-window' }];
    const store = new SpaceStore(); store.install(); await store.run(() => {});
    const fresh = { id: 3, windowId: 1, url: 'https://fresh-window.test/' };
    tabs.push(fresh); chrome.tabs.onCreated.emit(fresh); await store.run(() => {});
    const intended = [...store.spaces[0].temporaryTabs];
    const reload = new SpaceStore(); await reload.initialize();
    const late = { id: 4, windowId: 2, url: 'https://late-window.test/' }; tabs.push(late);
    reload.track(late); await reload.persist();
    assert.deepEqual(reload.spaces[0].temporaryTabs.filter(id => id !== 4), intended);
    assert.equal(reload.restoreQueue.length, 0);
});

for (const inverted of [false, true]) for (const top of [false, true]) test(`cold pending creations follow event arrival rather than native enumeration inverted=${inverted} top=${top}`, async () => {
    sync.invertTabOrder = inverted; sync.todayNewTabsAtTop = top; local.spaces = [space('a', [1])];
    const first = { id: 3, windowId: 1, index: 1, url: 'https://created-first.test/' };
    const second = { id: 4, windowId: 1, index: 0, url: 'https://created-second.test/' };
    tabs = [second, first, tabs[0]];
    const store = new SpaceStore(); store.install();
    chrome.tabs.onCreated.emit(first); chrome.tabs.onCreated.emit(second); await store.run(() => {});
    assert.deepEqual(visibleToday(store), top ? [4, 3, 1] : [1, 3, 4]);
    assert.equal(store.pendingCreations.size, 0);
});

for (const lifecycle of ['removed', 'replaced']) test(`pending creation cleanup survives failed initialization when tab is ${lifecycle}`, async () => {
    const store = new SpaceStore(), error = new Error('Initialization unavailable');
    const logged = [], originalError = console.error;
    console.error = value => logged.push(value);
    try {
        store.initialize = async () => { throw error; };
        store.install();
        chrome.tabs.onCreated.emit({ id: 30, windowId: 1, url: 'https://pending.test/' });
        chrome.tabs.onCreated.emit({ id: 31, windowId: 1, url: 'https://unrelated.test/' });
        assert.deepEqual([...store.pendingCreations], [30, 31]);
        if (lifecycle === 'removed') chrome.tabs.onRemoved.emit(30, {});
        else chrome.tabs.onReplaced.emit(40, 30);
        assert.deepEqual([...store.pendingCreations], [31], 'exact cleanup happens before queued initialization');
        await store.chain;
        assert.deepEqual([...store.pendingCreations], [31]);
        assert.equal(store.pendingCreations.has(40), false, 'replacement does not acquire inferred creation intent');
        assert(logged.length > 0); assert(logged.every(value => value === error));
    } finally { console.error = originalError; }
});

for (const scenario of [
    { current: [4, 1, 2, 3], expected: [4, 3, 1, 2] },
    { current: [1, 2, 3, 4], expected: [3, 1, 2, 4] },
    { current: [8, 1, 9, 2, 10, 3, 11], expected: [8, 3, 9, 1, 10, 2, 11] },
    { current: [4, 1, 3], expected: [4, 3, 1] }
]) test(`stale Today pure reorder preserves uncaptured slots and current survivors ${scenario.current}`, () => {
    const before = [space('a', [1, 2, 3])], after = [space('a', [3, 1, 2])];
    const current = [space('a', scenario.current), space('b', scenario.current.includes(2) ? [] : [2])];
    const result = applySpacePatch(current, before, after);
    assert.deepEqual(result[0].temporaryTabs, scenario.expected);
    assert.deepEqual(result[1], current[1]); assert.deepEqual(current[0].temporaryTabs, scenario.current);
});

test('Today-only pure reorder branch leaves saved-pin and membership-changing merge behavior intact', () => {
    const before = [space('a', [1, 2, 3])], current = [space('a', [4, 1, 2, 3])];
    before[0].spaceBookmarks = [5, 6]; current[0].spaceBookmarks = [7, 5, 6];
    const after = structuredClone(before); after[0].temporaryTabs = [3, 1, 8]; after[0].spaceBookmarks = [6, 5];
    const result = applySpacePatch(current, before, after);
    assert.deepEqual(result[0].temporaryTabs, [3, 1, 8, 4]);
    assert.deepEqual(result[0].spaceBookmarks, [6, 5, 7]);
});

for (const inverted of [false, true]) test(`stale drag retains newly created top through rank rebase and late restore inverted=${inverted}`, async () => {
    sync.invertTabOrder = inverted; local.spaces = [space('a', [1, 2])];
    session.restoredTabRanks = [[1, 0], [2, 2]];
    session.spaceRestoreQueue = [{ spaceId: 'a', section: 'temporaryTabs', order: 1, url: 'https://pending-drag.test/' }];
    const store = new SpaceStore(); store.install(); await store.run(() => {});
    const before = structuredClone(store.spaces), after = structuredClone(before); after[0].temporaryTabs.reverse();
    const fresh = { id: 3, windowId: 1, url: 'https://fresh-drag.test/' };
    tabs.push(fresh); chrome.tabs.onCreated.emit(fresh); await store.run(() => {});
    await store.dispatch({ action: 'patch', before, after });
    assert.deepEqual(store.spaces[0].temporaryTabs, inverted ? [2, 1, 3] : [3, 2, 1]);
    const intended = [...store.spaces[0].temporaryTabs], reload = new SpaceStore(); await reload.initialize();
    const late = { id: 4, windowId: 1, url: 'https://pending-drag.test/' }; tabs.push(late);
    reload.track(late); await reload.persist();
    assert.deepEqual(reload.spaces[0].temporaryTabs.filter(id => id !== 4), intended);
    assert.equal(visibleToday(reload)[0], 3);
});

for (const inverted of [false, true]) for (const top of [false, true]) for (const written of [false, true]) test(`cold creation retries retain exact placement inverted=${inverted} top=${top} uncertainWrite=${written}`, async () => {
    sync.invertTabOrder = inverted; sync.todayNewTabsAtTop = top; local.spaces = [space('a', [1])];
    tabs = [tabs[0], { id: 3, windowId: 1, url: 'https://cold-write.test/' }];
    const set = chrome.storage.local.set;
    let failed = false;
    chrome.storage.local.set = async values => {
        if (values.spaces && !failed) {
            failed = true;
            if (written) await set(values);
            throw new Error('One rejected initialization write');
        }
        return set(values);
    };
    const originalError = console.error; console.error = () => {};
    try {
        const store = new SpaceStore(); store.install(); chrome.tabs.onCreated.emit(tabs[1]);
        await store.chain; await store.dispatch({ action: 'get' });
        assert.deepEqual(visibleToday(store), top ? [3, 1] : [1, 3]);
        assert.equal(store.pendingCreations.size, 0);
        assert.equal(local.spaces[0].temporaryTabs.filter(id => id === 3).length, 1);
    } finally { console.error = originalError; }
});

for (const lifecycle of ['removed', 'replaced']) test(`cold write rejection cannot restore ${lifecycle} creation intent`, async () => {
    sync.invertTabOrder = false; local.spaces = [space('a', [1])];
    tabs = [tabs[0], { id: 3, windowId: 1, url: 'https://retired-intent.test/' }];
    const set = chrome.storage.local.set;
    let failed = false, store;
    chrome.storage.local.set = async values => {
        if (values.spaces && !failed) {
            failed = true;
            assert(store.pendingCreations.has(3), 'intent remains pending until the first write succeeds');
            tabs.splice(tabs.findIndex(tab => tab.id === 3), 1);
            if (lifecycle === 'removed') chrome.tabs.onRemoved.emit(3, {});
            else {
                tabs.push({ id: 4, windowId: 1, url: 'https://replacement.test/' });
                chrome.tabs.onReplaced.emit(4, 3);
            }
            assert.equal(store.pendingCreations.has(3), false);
            throw new Error('Rejected after lifecycle event');
        }
        return set(values);
    };
    const originalError = console.error; console.error = () => {};
    try {
        store = new SpaceStore(); store.install(); chrome.tabs.onCreated.emit(tabs[1]);
        await store.chain; await store.dispatch({ action: 'get' });
        assert.deepEqual(local.spaces[0].temporaryTabs, lifecycle === 'removed' ? [1] : [1, 4]);
        assert.equal(store.pendingCreations.size, 0);
    } finally { console.error = originalError; }
});

test('custom emoji metadata survives worker restart, stale patches, registry-only recovery and explicit clear', async () => {
    const folders = ['a', 'b'].map(id => ({ id, title: id, parentId: 'root' }));
    chrome.bookmarks.getChildren = async id => id === 'root' ? structuredClone(folders) : [];
    chrome.bookmarks.get = async id => structuredClone(folders.filter(folder => folder.id === id));
    const store = new SpaceStore(); await store.dispatch({ action: 'get' });
    const before = structuredClone(store.spaces);
    for (const icon of ['👩🏽‍💻', '🇭🇰', '🏳️‍🌈', '👨🏿‍❤️‍💋‍👨🏻', '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}']) {
        await store.dispatch({ action: 'metadata', spaceId: 'b', changes: { icon } });
        assert.equal(local.spaces[1].icon, icon); assert.equal(local.spaceRegistry.b.icon, icon);
        assert.equal(local.spaceRegistry.b.spaceUuid, 'b');
    }
    const expected = store.spaces[1].icon;
    const after = structuredClone(before); after[0].color = 'green';
    await store.dispatch({ action: 'patch', before, after });
    assert.equal(local.spaces[1].icon, expected);
    const restarted = new SpaceStore(); await restarted.dispatch({ action: 'get' });
    assert.equal(restarted.spaces[1].icon, expected);
    local.spaces = []; session.spaceSession = false; tabs = [];
    const recovered = new SpaceStore(); await recovered.dispatch({ action: 'get' });
    assert.equal(recovered.spaces[1].icon, expected);
    await recovered.dispatch({ action: 'metadata', spaceId: 'b', changes: { icon: null } });
    assert.equal(local.spaces[1].icon, null); assert.equal(local.spaceRegistry.b.icon, null);
    local.spaces = []; session.spaceSession = false;
    const cleared = new SpaceStore(); await cleared.dispatch({ action: 'get' });
    assert.equal(cleared.spaces[1].icon, undefined); assert.equal(local.spaceRegistry.b.icon, null);
    assert.deepEqual(mutations, []);
});

test('metadata rejects malformed emoji before any write and cannot import emoji from the wrong UUID', async () => {
    const store = new SpaceStore(); await store.dispatch({ action: 'get' });
    chrome.bookmarks.get = async id => [{ id, title: id, parentId: 'root' }];
    const original = structuredClone(local);
    for (const icon of ['🧠⭐', '🇺', '👩‍', '🧠\n', 'text', '👩🏽‍💻<script>']) {
        await assert.rejects(store.dispatch({ action: 'metadata', spaceId: 'b', changes: { icon } }), /complete emoji/);
        assert.deepEqual(local, original);
    }
    local.spaceRegistry = { b: { spaceUuid: 'different', bookmarkFolderId: 'b', icon: '👩🏽‍💻' } };
    chrome.bookmarks.getChildren = async id => id === 'root' ? [{ id: 'a', title: 'a' }, { id: 'b', title: 'b' }] : [];
    const next = new SpaceStore(); await next.dispatch({ action: 'get' });
    assert.equal(next.spaces[1].icon, undefined);
    await assert.rejects(next.dispatch({ action: 'metadata', spaceId: 'b', changes: { icon: '🇭🇰' } }), /identity has changed/);
    assert.equal(local.spaceRegistry.b.icon, '👩🏽‍💻');
});

test('custom Space tint is UUID metadata across rename, stale patch, worker restart, folder discovery and clear', async () => {
    const folders = ['a', 'b'].map(id => ({ id, title: id, parentId: 'root' }));
    chrome.bookmarks.getChildren = async id => id === 'root' ? structuredClone(folders) : [];
    chrome.bookmarks.get = async id => structuredClone(folders.filter(folder => folder.id === id));
    chrome.bookmarks.update = async (id, changes) => Object.assign(folders.find(folder => folder.id === id), changes);
    const store = new SpaceStore(); await store.dispatch({ action: 'get' });
    const before = structuredClone(store.spaces);
    await store.dispatch({ action: 'metadata', spaceId: 'b', changes: { customTint: '#Ff0088', icon: '👩🏽‍💻' } });
    assert.equal(local.spaces[1].customTint, '#ff0088'); assert.equal(local.spaces[1].color, 'blue');
    assert.equal(local.spaceRegistry.b.customTint, '#ff0088'); assert.equal(local.spaceRegistry.b.spaceUuid, 'b');
    await store.dispatch({ action: 'metadata', spaceId: 'b', changes: { name: 'Research' } });
    const after = structuredClone(before); after[0].color = 'green';
    await store.dispatch({ action: 'patch', before, after });
    assert.equal(local.spaces[1].customTint, '#ff0088'); assert.equal(local.spaces[1].name, 'Research');
    const restarted = new SpaceStore(); await restarted.dispatch({ action: 'get' });
    assert.equal(restarted.spaces[1].customTint, '#ff0088');
    // An older reader drops the unknown tint field; recover only this UUID's registry record.
    delete local.spaces[1].customTint;
    const olderReader = new SpaceStore(); await olderReader.dispatch({ action: 'get' });
    assert.equal(olderReader.spaces[1].customTint, '#ff0088');
    folders[1].title = 'Synced bookmark rename';
    await olderReader.run(async () => { await olderReader.discoverBookmarkSpaces(); await olderReader.persist(); });
    assert.equal(local.spaces[1].name, 'Synced bookmark rename'); assert.equal(local.spaces[1].customTint, '#ff0088');
    local.spaces = []; session.spaceSession = false; tabs = [];
    const recovered = new SpaceStore(); await recovered.dispatch({ action: 'get' });
    assert.equal(recovered.spaces[1].customTint, '#ff0088'); assert.equal(recovered.spaces[1].icon, '👩🏽‍💻');
    await recovered.dispatch({ action: 'metadata', spaceId: 'b', changes: { customTint: null } });
    assert.equal(local.spaces[1].customTint, null); assert.equal(local.spaceRegistry.b.customTint, null);
    local.spaces = []; session.spaceSession = false;
    const cleared = new SpaceStore(); await cleared.dispatch({ action: 'get' });
    assert.equal(cleared.spaces[1].customTint, undefined); assert.equal(cleared.spaces[1].color, 'blue');
    assert.deepEqual(mutations, []);
});

test('invalid custom tints reject before writes and wrong registry UUID never donates tint', async () => {
    const store = new SpaceStore(); await store.dispatch({ action: 'get' });
    chrome.bookmarks.get = async id => [{ id, title: id, parentId: 'root' }];
    const original = structuredClone(local);
    for (const customTint of ['#fff', 'red', 'url(https://bad.test)', 'var(--blue)', '#ff0000; color:white', '#123456\n', 123456, {}, []]) {
        await assert.rejects(store.dispatch({ action: 'metadata', spaceId: 'b', changes: { customTint } }), /six-digit hex/);
        assert.deepEqual(local, original);
    }
    local.spaceRegistry = { b: { spaceUuid: 'wrong', bookmarkFolderId: 'b', color: 'pink', customTint: '#000000' } };
    chrome.bookmarks.getChildren = async id => id === 'root' ? [{ id: 'a', title: 'a' }, { id: 'b', title: 'b' }] : [];
    const next = new SpaceStore(); await next.dispatch({ action: 'get' });
    assert.equal(next.spaces[1].customTint, undefined); assert.equal(next.spaces[1].color, 'blue');
    await assert.rejects(next.dispatch({ action: 'metadata', spaceId: 'b', changes: { customTint: '#ffffff' } }), /identity has changed/);
    assert.equal(local.spaceRegistry.b.customTint, '#000000');
});

test('custom tint cannot widen native group colors or leak CSS from malformed imported metadata', async () => {
    local.spaces[0].customTint = '#ffffff'; local.spaces[1].customTint = 'url(https://bad.test)';
    local.spaces[1].color = '#123456'; sync.syncTabGroups = true;
    const store = new SpaceStore(); await store.dispatch({ action: 'get' });
    assert.equal(store.spaces[0].color, 'blue'); assert.equal(store.spaces[0].customTint, '#ffffff');
    assert.equal(store.spaces[1].color, 'grey'); assert.equal(store.spaces[1].customTint, null);
    const colors = mutations.filter(entry => entry[0] === 'update').map(entry => entry[2].color);
    assert.deepEqual(colors, ['blue', 'grey']);
    const before = structuredClone(store.spaces), after = structuredClone(before);
    after[0].customTint = 'url(https://bad.test)'; after[0].color = '#ff00ff';
    await store.dispatch({ action: 'patch', before, after });
    assert.equal(store.spaces[0].customTint, '#ffffff'); assert.equal(store.spaces[0].color, 'blue');
});

test('new legacy patch Spaces cannot bypass color validation through the initial clone', () => {
    const next = { ...space('new'), color: 'url(https://bad.test)', customTint: 'var(--bad)' };
    const result = applySpacePatch([], [], [next]);
    assert.equal(result[0].color, 'grey'); assert.equal(result[0].customTint, null);
    const valid = applySpacePatch([], [], [{ ...next, color: 'pink', customTint: '#FfAa00' }]);
    assert.equal(valid[0].color, 'pink'); assert.equal(valid[0].customTint, '#ffaa00');
});

for (const key of ['archivedTabs', 'archiveReopenClaims']) test(`malformed ${key} refuses archive operations without blocking unrelated Space initialization`, async () => {
    local[key] = { malformed: true };
    const store = new SpaceStore();
    await store.dispatch({ action: 'get' });
    assert.equal(store.spaces.length, 2); assert.deepEqual(local[key], { malformed: true });
    await assert.rejects(store.run(() => key === 'archivedTabs' ? store.archiveStore.listUnlocked() : store.archiveStore.claimsUnlocked()));
});

test('legacy archive Space-ID write failure cannot commit model v2 and retry preserves mapping', async () => {
    delete local.spaceModelVersion;
    local.spaces = [space(42, [1])]; local.spaces[0].name = 'Work';
    local.archivedTabs = [{ url: 'https://archive.test', spaceId: 42, archivedAt: 12, extra: 'keep' }];
    tabs[0].groupId = 42;
    const set = chrome.storage.local.set; let refuse = true;
    chrome.storage.local.set = async values => {
        if (refuse && values.archivedTabs?.some(entry => entry.spaceId !== 42)) throw new Error('Archive mapping write failed');
        return set(values);
    };
    const store = new SpaceStore();
    await assert.rejects(store.dispatch({ action: 'get' }), /Archive mapping write failed/);
    assert.equal(local.spaceModelVersion, undefined); assert.equal(local.spaces[0].id, 42); assert.equal(local.archivedTabs[0].spaceId, 42);
    const entryId = local.archivedTabs[0].entryId;
    refuse = false; await store.dispatch({ action: 'get' });
    assert.equal(local.spaceModelVersion, 2); assert.equal(local.archivedTabs[0].spaceId, local.spaces[0].id);
    assert.equal(local.archivedTabs[0].entryId, entryId); assert.equal(local.archivedTabs[0].extra, 'keep'); assert.equal(local.archivedTabs[0].archivedAt, 12);
});
