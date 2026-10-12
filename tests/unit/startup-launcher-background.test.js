import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { isStartupLauncherTab } from '../../startup-launcher-tab.js';
import { ownerOf } from '../../space-store.js';

const source = readFileSync(new URL('../../background.js', import.meta.url), 'utf8').replace(/^import .*;\s*$/gm, '');
function fixture() {
    const messages = [], startups = [], archives = [], removed = [], alarms = [];
    const tabs = [{ id: 1, url: 'chrome-extension://arcify/startup-launcher.html', title: 'Arcify launcher', active: false },
        { id: 2, url: 'https://browsing.test/', title: 'Browsing tab', active: false }];
    const event = { addListener() {} };
    const chrome = {
        runtime: { getURL: path => `chrome-extension://arcify/${path}`, onInstalled: event,
            onStartup: { addListener: fn => startups.push(fn) }, onMessage: { addListener: fn => messages.push(fn) } },
        sidePanel: { setPanelBehavior: async () => {} }, commands: { onCommand: event },
        alarms: { onAlarm: event, create: async (...args) => alarms.push(args) },
        storage: { onChanged: event, local: { get: async () => ({ tabLastActivity: { 1: 1, 2: 1 } }), set: async () => {} } },
        tabs: { onActivated: event, onUpdated: event, onRemoved: event, query: async () => tabs,
            get: async id => tabs.find(tab => tab.id === id), remove: async id => removed.push(id) },
        bookmarks: { search: async () => [] }
    };
    let launcherRegistered = 0;
    const context = { chrome, console, registerTourMessages() {}, registerBookmarkListeners() {}, registerSpotlightBridge() {},
        registerStartupLauncher() { launcherRegistered++; },
        isStartupLauncherTab: tab => isStartupLauncherTab(tab, chrome), ownerOf, isProtectedFavorite: () => false,
        SpaceStore: class { install() {} async dispatch() { return [{ id: 'home', spaceBookmarks: [], temporaryTabs: [1, 2] }]; } },
        Utils: { getSettings: async () => ({ autoArchiveEnabled: true, autoArchiveIdleMinutes: 10 }),
            getPinnedTabStates: async () => ({}), addArchivedTab: async tab => archives.push(tab) },
        Logger: { log() {}, error(error) { throw error; } } };
    runInNewContext(source, context);
    return { context, messages, startups, archives, removed, alarms, launcherRegistered };
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
