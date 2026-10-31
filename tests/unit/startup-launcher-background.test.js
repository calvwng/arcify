import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { isStartupLauncherTab } from '../../startup-launcher-tab.js';
import { ownerOf } from '../../space-store.js';
import { projectLiveTabTitles } from '../../tab-title-projection.js';
import { createNativeSplitWriteGuard } from '../../native-split-safety.js';
import { enqueueBookmarkOperation } from '../../bookmark-writer.js';

const source = readFileSync(new URL('../../background.js', import.meta.url), 'utf8').replace(/^import .*;\s*$/gm, '');
function fixture() {
    const messages = [], startups = [], archives = [], removed = [], alarms = [], actions = [], globals = new Set();
    const bookmarkCreates = [], bookmarkNodes = [];
    const local = { tabLastActivity: { 1: 1, 2: 1 }, tabNameOverridesById: {}, pinnedTabStatesById: {} };
    const tabs = [{ id: 1, url: 'chrome-extension://arcify/startup-launcher.html', title: 'Arcify launcher', active: false },
        { id: 2, url: 'https://browsing.test/', title: 'Browsing tab', active: false }];
    const event = { addListener() {} };
    const chrome = {
        runtime: { id: 'arcify', getURL: path => `chrome-extension://arcify/${path}`, onInstalled: event,
            onStartup: { addListener: fn => startups.push(fn) }, onMessage: { addListener: fn => messages.push(fn) } },
        sidePanel: { setPanelBehavior: async () => {} }, commands: { onCommand: event },
        alarms: { onAlarm: event, create: async (...args) => alarms.push(args) },
        storage: { onChanged: event, local: { get: async () => local, set: async () => {} } },
        windows: { onRemoved: event },
        tabs: { onCreated: event, onActivated: event, onUpdated: event, onRemoved: event, query: async () => tabs,
            get: async id => tabs.find(tab => tab.id === id), remove: async id => removed.push(id) },
        bookmarks: { search: async () => [], getChildren: async () => structuredClone(bookmarkNodes),
            create: async data => { const node = { ...data, id: 'created' }; bookmarkCreates.push(node); bookmarkNodes.push(node); return node; } }
    };
    globalThis.chrome = chrome;
    let launcherRegistered = 0;
    const context = { chrome, console, createNativeSplitWriteGuard, enqueueBookmarkOperation, registerRecoveryObservation() {}, selectedRecoveryDiagnosticsEnabled: true, registerSelectedRecoveryDiagnostics() {}, summarizeRecoveryObservation() {}, registerTourMessages() {}, registerBookmarkListeners() {}, registerSpotlightBridge() {},
        registerStartupLauncher() { launcherRegistered++; },
        isStartupLauncherTab: tab => isStartupLauncherTab(tab, chrome), ownerOf, projectLiveTabTitles, isProtectedFavorite: () => false,
        createLittleArcWindowGeometry: () => ({}), createTransientWindowStore: () => ({ initialize: async () => {}, observe() {}, observeRemoved() {}, observeWindowRemoved() {},
            observeReplacement() {}, observeDetached() {}, flushObservedUnlocked: async () => {}, isExcluded: () => false, isTransientWindow: () => false }),
        registerTransientControlMessages() {},
        registerPeek() {},
        createFavoriteContinuity: () => ({}), FavoriteStore: class { install() {} }, registerFavoriteMessages() {}, registerTodayFolderMessages() {}, registerTodayMoveMessages() {}, registerTodayRecoveryMessages() {}, registerSharedToday() {}, registerLittleArcHeader() {}, registerLittleArcLinkMenu() {}, registerSavedMoveMessages() {}, registerSelectedTabClose() {}, registerTabMenuMessages() {}, registerTodaySplitMessages() {}, registerMoveTabWindowMessages() {}, registerArchiveMessages() {},
        SpaceStore: class { isTransientTab() { return false; } isTransientWindow() { return false; } archiveStore = { archiveUnlocked: async request => { archives.push({ url: request.url, spaceId: request.spaceId }); removed.push(request.tabId); } }; spaces = [{ id: 'home', bookmarkFolderId: 'home-folder', spaceBookmarks: [], temporaryTabs: [1, 2] }]; install() {} async run(fn) { return fn(); } isGlobalTab(tab) { return globals.has(tab.id); } async dispatch(message) { actions.push(message); return this.spaces; } },
        Utils: { getSettings: async () => ({ autoArchiveEnabled: true, autoArchiveIdleMinutes: 10 }),
            getPinnedTabStates: async () => ({}), addArchivedTab: async tab => archives.push(tab) },
        Logger: { log() {}, error(error) { throw error; } } };
    runInNewContext(source, context);
    return { context, messages, startups, archives, removed, alarms, launcherRegistered, actions, globals, tabs, local, bookmarkCreates };
}

test('startup launcher registration preserves existing auto-archive startup hook', async () => {
    const app = fixture();
    assert.equal(app.launcherRegistered, 1);
    for (const listener of app.startups) listener();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(app.alarms.map(([name]) => name), ['autoArchiveTabsAlarm']);
});

test('auto-archive excludes launcher even with stale workspace ownership', async () => {
    const app = fixture();
    await app.context.runAutoArchiveCheck();
    assert.deepEqual(app.removed, [2]);
    assert.equal(app.archives.length, 1);
    assert.equal(app.archives[0].url, 'https://browsing.test/');
});

test('background tab search and recent-tabs results omit the launcher', async () => {
    const app = fixture();
    for (const action of ['searchTabs', 'getRecentTabs']) {
        const replies = [];
        for (const listener of app.messages) listener({ action }, {}, reply => replies.push(reply));
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(replies.length, 1);
        assert.equal(replies[0].success, true);
        assert.deepEqual(Array.from(replies[0].tabs, tab => tab.id), [2]);
    }
});

test('background live search matches and displays exact ordinary aliases across navigation and removal', async () => {
    const app = fixture();
    app.tabs.push({ ...app.tabs[1], id: 3, title: 'Duplicate URL page' });
    app.local.tabNameOverridesById = { 2: { name: 'My named tab', originalDomain: 'browsing.test' }, 3: { name: 'Other twin' } };
    const search = async query => {
        const replies = [];
        for (const listener of app.messages) listener({ action: 'searchTabs', query }, {}, reply => replies.push(reply));
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(replies.length, 1); assert.equal(replies[0].success, true);
        return Array.from(replies[0].tabs, tab => ({ id: tab.id, title: tab.title }));
    };
    assert.deepEqual(await search('NAMED'), [{ id: 2, title: 'My named tab' }]);
    assert.deepEqual(await search('twin'), [{ id: 3, title: 'Other twin' }]);
    const recent = [];
    for (const listener of app.messages) listener({ action: 'getRecentTabs' }, {}, reply => recent.push(reply));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(recent[0].success, true);
    assert.deepEqual(Array.from(recent[0].tabs, tab => ({ id: tab.id, title: tab.title })), [
        { id: 2, title: 'My named tab' }, { id: 3, title: 'Other twin' }
    ]);
    app.tabs[1].url = 'https://new-domain.test/'; app.tabs[1].title = 'New page title';
    assert.deepEqual(await search('named'), [{ id: 2, title: 'My named tab' }]);
    delete app.local.tabNameOverridesById[2];
    assert.deepEqual(await search('named'), []);
    assert.deepEqual(await search('new page'), [{ id: 2, title: 'New page title' }]);
    assert.deepEqual(await search('twin'), [{ id: 3, title: 'Other twin' }]);
});


test('auto-archive final queued recheck protects an ordinary global Favorite despite stale Space arrays', async () => {
    const app = fixture(); app.globals.add(2);
    await app.context.runAutoArchiveCheck();
    assert.deepEqual(app.removed, []); assert.deepEqual(app.archives, []);
});

test('destructive Space actions reject foreign senders and malformed targets before dispatch', () => {
    const app = fixture();
    const check = (message, sender, code) => {
        const replies = []; for (const listener of app.messages) listener(message, sender, reply => replies.push(reply));
        assert.equal(replies.length, 1); assert.equal(replies[0].code, code); assert.equal(app.actions.length, 0);
    };
    const clean = { type: 'spaceStore', action: 'clean', spaceId: 'home', windowId: 1 };
    for (const sender of [{}, { id: 'foreign' }, { id: 'arcify', url: 'https://untrusted.test/' },
        { id: 'arcify', origin: 'https://untrusted.test' }, { id: 'arcify', tab: { windowId: 2 } }]) check(clean, sender, 'UNAUTHORIZED');
    const sender = { id: 'arcify', url: 'chrome-extension://arcify/sidebar.html' };
    for (const windowId of [0, -1, 1.2, Number.MAX_SAFE_INTEGER + 1]) check({ ...clean, windowId }, sender, 'INVALID_REQUEST');
    for (const message of [{ ...clean, unexpected: true }, { ...clean, spaceId: '' }, { type: 'spaceStore', action: 'delete', spaceId: 'home', windowId: 1 }]) check(message, sender, 'INVALID_REQUEST');
});

test('trusted exact Space cleanup enters the authoritative queue action', async () => {
    const app = fixture(), replies = [], message = { type: 'spaceStore', action: 'clean', spaceId: 'home', windowId: 1 };
    for (const listener of app.messages) listener(message, { id: 'arcify', url: 'chrome-extension://arcify/sidebar.html', tab: { windowId: 1 } }, reply => replies.push(reply));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(replies[0].success, true); assert.deepEqual(app.actions, [message]);
});


test('background builds the queued live bookmark split guard and propagates native refusal before create', async () => {
    const app = fixture(); Object.assign(app.tabs[1], { windowId: 10, splitViewId: 77 });
    const request = { type: 'bookmarkOrder', guardTab: { tabId: 2, windowId: 10 },
        operation: { parents: [{ parentId: 'p', expectedCanonicalIds: [], desiredCanonicalIds: ['$new'] }], relocation: { kind: 'create', parentId: 'p', title: 'Page', url: app.tabs[1].url } } };
    const replies = []; for (const listener of app.messages) listener(request, { id: 'arcify' }, reply => replies.push(reply));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(replies.length, 1); assert.equal(replies[0].success, false); assert.match(replies[0].error, /End Split View/);
    assert.deepEqual(app.bookmarkCreates, []);
    app.tabs[1].splitViewId = -1; replies.length = 0;
    for (const listener of app.messages) listener(request, { id: 'arcify' }, reply => replies.push(reply));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(replies[0].success, true); assert.equal(replies[0].createdId, 'created'); assert.equal(app.bookmarkCreates.length, 1);
});

test('private tabs are excluded from background search, recents, activity writes and automatic archive', async () => {
    const app = fixture();
    app.tabs[1].incognito = true;
    const original = JSON.stringify(app.local), writes = [];
    app.context.chrome.storage.local.set = async values => { writes.push(values); Object.assign(app.local, values); };
    await app.context.updateTabLastActivity(2);
    assert.equal(JSON.stringify(app.local), original); assert.equal(writes.length, 0);
    await app.context.runAutoArchiveCheck();
    assert.deepEqual(app.archives, []); assert.deepEqual(app.removed, []);
    for (const action of ['searchTabs', 'getRecentTabs']) {
        const replies = [];
        for (const listener of app.messages) listener({ action }, {}, reply => replies.push(reply));
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(replies.length, 1); assert.equal(replies[0].success, true);
        assert.deepEqual(Array.from(replies[0].tabs), []);
    }
    app.tabs[1].incognito = false;
    await app.context.updateTabLastActivity(2); assert.equal(writes.length, 1);
    assert(app.local.tabLastActivity[2] > 1);
});
