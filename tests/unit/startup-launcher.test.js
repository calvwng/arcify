import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerStartupLauncher, STARTUP_LAUNCHER_SESSION, STARTUP_LAUNCHER_ALARM } from '../../startup-launcher.js';
import { isStartupLauncherTab, isStartupLauncherUrl } from '../../startup-launcher-tab.js';
import { Utils } from '../../utils.js';

const launcherUrl = 'chrome-extension://arcify/startup-launcher.html';
const spotlightUrl = `chrome-extension://${'a'.repeat(32)}/newtab.html`;
const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); },
    async emit(...args) { await Promise.all(this.listeners.map(fn => fn(...args))); } });
const area = data => ({
    async get(keys) {
        const names = typeof keys === 'string' ? [keys] : Object.keys(keys);
        return Object.fromEntries(names.map(key => [key, data[key] ?? keys[key]]));
    },
    async set(patch) { Object.assign(data, structuredClone(patch)); }
});
function fixture({ enabled, session = {}, windows, tabs, controllerOptions = {} } = {}) {
    const sync = { existingPreference: 'unchanged', ...(enabled === undefined ? {} : { startupLauncherEnabled: enabled }) };
    const state = { sync, session, time: 1000, created: [], removed: [], errors: [], alarms: new Map(), timers: new Map(), timerDelays: [],
        windows: windows ?? [{ id: 1, type: 'normal', focused: true }],
        tabs: tabs ?? [{ id: 10, windowId: 1, url: 'https://example.test/', active: true }] };
    let nextTimer = 0;
    const browser = {
        runtime: { getURL: path => `chrome-extension://arcify/${path}`, onStartup: event() },
        storage: { sync: area(sync), session: area(session), onChanged: event() },
        windows: { onCreated: event(), onFocusChanged: event(), getAll: async () => structuredClone(state.windows) },
        alarms: { onAlarm: event(), create: async (name, alarm) => state.alarms.set(name, alarm), clear: async name => state.alarms.delete(name) },
        tabs: { onCreated: event(), onUpdated: event(), onActivated: event(),
            query: async query => structuredClone(state.tabs.filter(tab => query.windowId === undefined || query.windowId === tab.windowId)),
            get: async id => { const tab = state.tabs.find(tab => tab.id === id); if (!tab) throw Error('No tab'); return structuredClone(tab); },
            create: async options => {
                state.created.push(options);
                if (state.createError) throw Error('Window closed');
                const tab = { ...options, id: 100 + state.created.length };
                state.tabs.push(tab);
                return tab;
            },
            remove: async id => { state.removed.push(id); state.tabs = state.tabs.filter(tab => tab.id !== id); }
        }
    };
    const makeController = () => registerStartupLauncher(browser, { now: () => state.time,
        setTimer: (callback, delay) => {
            state.timerDelays.push(delay);
            const id = ++nextTimer;
            state.timers.set(id, () => { state.timers.delete(id); return callback(); });
            return id;
        },
        clearTimer: id => state.timers.delete(id), reportError: error => state.errors.push(error), ...controllerOptions });
    return { state, browser, controller: makeController(), makeController };
}

function pairedFixture({ response = { accepted: true }, prepare, offer } = {}) {
    const calls = [];
    const app = fixture({ enabled: true, tabs: [{ id: 10, windowId: 1, url: spotlightUrl, active: true }],
        controllerOptions: {
            prepareSuggestion: prepare || (async tab => ({ peerId: 'a'.repeat(32), windowId: tab.windowId, tabId: tab.id })),
            offerSuggestion: async context => { calls.push(context); return offer ? offer(context) : response; }
        } });
    return { ...app, calls };
}

test('a ready Spotlight startup suggestion consumes the request without creating a competing helper', async () => {
    const app = pairedFixture(); await app.controller.start(); await app.controller.flush();
    assert.equal(app.calls.length, 1); assert.deepEqual(app.state.created, []);
    assert.equal(app.state.session[STARTUP_LAUNCHER_SESSION].pending, false);
    assert.equal(app.state.alarms.size, 0);
    await app.browser.tabs.onCreated.emit({ id: 20, windowId: 1 });
    const resumed = app.makeController(); await resumed.ready; await resumed.start(); await resumed.flush();
    assert.equal(app.calls.length, 1); assert.deepEqual(app.state.created, []);
});

test('typing or manually selecting in Spotlight consumes startup without a fallback tab', async () => {
    for (const reason of ['user-interaction', 'not-eligible']) {
        const app = pairedFixture({ response: { accepted: false, reason } });
        await app.controller.start(); await app.controller.flush();
        assert.deepEqual(app.state.created, []); assert.equal(app.calls.length, 1);
        assert.equal(app.state.session[STARTUP_LAUNCHER_SESSION].pending, false);
    }
});

test('an explicit not-ready decline creates at most a background fallback, never a second offer', async () => {
    const app = pairedFixture({ response: { accepted: false, reason: 'not-ready' } });
    app.state.createError = true;
    await app.controller.start(); await app.controller.flush();
    assert.equal(app.state.created[0].active, false);
    app.state.createError = false;
    await app.controller.flush();
    assert.equal(app.state.created.at(-1).active, false);
    assert.equal(app.calls.length, 1);
    assert.equal(app.state.tabs.filter(tab => tab.url === launcherUrl).length, 1);
});

test('timeout or malformed offer outcome consumes startup rather than risking duplicate prompts', async () => {
    for (const offer of [async () => { throw Error('Timed out'); }, async () => ({}), async () => null,
        async () => ({ accepted: false }), async () => ({ accepted: false, reason: 'unknown' })]) {
        const app = pairedFixture({ offer }); await app.controller.start(); await app.controller.flush();
        assert.deepEqual(app.state.created, []); assert.equal(app.calls.length, 1);
        const resumed = app.makeController(); await resumed.ready; await resumed.flush();
        assert.deepEqual(app.state.created, []); assert.equal(app.calls.length, 1);
    }
});

test('a worker restart never replays an unresolved startup offer', async () => {
    let resolve;
    const app = pairedFixture({ offer: () => new Promise(done => { resolve = done; }) });
    await app.controller.start(); const original = app.controller.flush();
    while (!resolve) await new Promise(done => setImmediate(done));
    assert.equal(app.state.session[STARTUP_LAUNCHER_SESSION].pending, false);
    const resumed = app.makeController(); await resumed.ready; await resumed.flush();
    assert.equal(app.calls.length, 1); assert.deepEqual(app.state.created, []);
    resolve({ accepted: true }); await original;
});

test('startup candidate change or expired readiness skips the offer and keeps fallback quiet', async () => {
    for (const change of ['late', 'url', 'active', 'focus', 'event']) {
        let app;
        app = pairedFixture({ prepare: async tab => {
            if (change === 'late') app.state.time += 4000;
            if (change === 'url') app.state.tabs[0].url = 'https://typed.test/';
            if (change === 'active') app.state.tabs[0].active = false;
            if (change === 'focus') app.state.windows[0].focused = false;
            if (change === 'event') await app.browser.tabs.onActivated.emit({ windowId: 1, tabId: 99 });
            return { peerId: 'a'.repeat(32), windowId: tab.windowId, tabId: tab.id };
        } });
        await app.controller.start(); await app.controller.flush();
        assert.equal(app.calls.length, 0, change);
        assert.equal(app.state.created[0].active, false, change);
    }
});

test('unavailable capability preserves the legacy launcher and disabled startup never prepares Spotlight', async () => {
    const app = pairedFixture({ prepare: async () => null });
    await app.controller.start(); await app.controller.flush();
    assert.equal(app.state.created[0].active, true); assert.equal(app.calls.length, 0);
    let prepared = false;
    const disabled = fixture({ controllerOptions: { prepareSuggestion: async () => { prepared = true; } } });
    await disabled.controller.start(); await disabled.controller.flush(); assert.equal(prepared, false);
});

test('opting out during capability lookup prevents both prompt and fallback', async () => {
    let app;
    app = pairedFixture({ prepare: async tab => {
        app.state.sync.startupLauncherEnabled = false;
        return { peerId: 'a'.repeat(32), tabId: tab.id, windowId: tab.windowId };
    } });
    await app.controller.start(); await app.controller.flush();
    assert.deepEqual(app.state.created, []); assert.equal(app.calls.length, 0);
});

test('an eligible active Spotlight prompt takes precedence over an inactive restored helper without changing tabs', async () => {
    const app = pairedFixture(); app.state.tabs.push({ id: 55, windowId: 1, url: launcherUrl, active: false });
    await app.controller.start(); await app.controller.flush();
    assert.equal(app.calls.length, 1); assert.deepEqual(app.state.created, []); assert.deepEqual(app.state.removed, []);
    assert.equal(app.state.tabs.find(tab => tab.id === 55).active, false);
    assert.equal(app.state.tabs.find(tab => tab.id === 10).active, true);
});

test('unsupported or not-ready Spotlight reuses an inactive restored helper without activation', async () => {
    for (const prepare of [undefined, async () => null]) {
        const app = pairedFixture({ prepare, response: { accepted: false, reason: 'not-ready' } });
        app.state.tabs.push({ id: 55, windowId: 1, url: launcherUrl, active: false });
        await app.controller.start(); await app.controller.flush();
        assert.deepEqual(app.state.created, []); assert.deepEqual(app.state.removed, []);
        assert.equal(app.state.tabs.find(tab => tab.id === 55).active, false);
        assert.equal(app.state.tabs.find(tab => tab.id === 10).active, true);
    }
});

test('launcher is disabled by default and registration/install does not open a tab', async () => {
    const app = fixture();
    await app.controller.ready;
    await app.controller.flush();
    assert.deepEqual(app.state.created, []);
    await app.browser.runtime.onStartup.emit();
    await app.controller.flush();
    assert.deepEqual(app.state.created, []);
    assert.deepEqual(app.state.sync, { existingPreference: 'unchanged' });
    assert.deepEqual(app.state.session[STARTUP_LAUNCHER_SESSION], { pending: false });
});

test('enabled startup opens one foreground launcher in the focused normal window, preserving browsing tabs', async () => {
    const app = fixture({ enabled: true,
        windows: [{ id: 3, type: 'popup', focused: true }, { id: 2, type: 'normal', focused: true }, { id: 1, type: 'normal' }],
        tabs: [{ id: 20, windowId: 2, url: 'chrome://newtab/', active: true }, { id: 30, windowId: 3, url: 'https://popup.test/', active: true }] });
    await app.controller.start();
    assert.equal(app.state.alarms.has(STARTUP_LAUNCHER_ALARM), true);
    await app.controller.flush();
    assert.deepEqual(app.state.created, [{ windowId: 2, url: launcherUrl, active: true }]);
    assert.equal(app.state.tabs.find(tab => tab.id === 20).url, 'chrome://newtab/');
    assert.deepEqual(app.state.removed, []);
    assert.equal(app.state.alarms.size, 0);
    assert.equal(app.state.sync.existingPreference, 'unchanged');
});

test('restored launcher and pending restored navigation are reused without activation', async () => {
    for (const restored of [{ url: launcherUrl }, { url: 'about:blank', pendingUrl: launcherUrl + '?restored=1' }]) {
        const app = fixture({ enabled: true, tabs: [{ id: 10, windowId: 1, active: false, ...restored }] });
        await app.controller.start();
        await app.controller.flush();
        assert.deepEqual(app.state.created, []);
        assert.deepEqual(app.state.removed, []);
        assert.equal(app.state.tabs[0].active, false);
    }
});

test('late session restore removes only the newly created redundant launcher', async () => {
    const app = fixture({ enabled: true });
    await app.controller.start(); await app.controller.flush();
    const created = app.state.tabs.find(tab => tab.url === launcherUrl);
    const restored = { id: 55, windowId: 1, url: launcherUrl, active: false };
    app.state.tabs.push(restored);
    await app.browser.tabs.onCreated.emit(restored);
    await app.controller.flush();
    assert.deepEqual(app.state.removed, [created.id]);
    assert.equal(app.state.tabs.some(tab => tab.id === restored.id), true);
    assert.equal(app.state.created.length, 1);
});

test('late restore never closes a launcher tab the user has navigated away from', async () => {
    const app = fixture({ enabled: true });
    await app.controller.start(); await app.controller.flush();
    app.state.tabs.find(tab => tab.url === launcherUrl).url = 'https://user-navigation.test/';
    app.state.tabs.push({ id: 55, windowId: 1, url: launcherUrl });
    await app.controller.flush();
    assert.deepEqual(app.state.removed, []);
});

test('late restore does not close a launcher with an outbound user navigation still pending', async () => {
    const app = fixture({ enabled: true });
    await app.controller.start(); await app.controller.flush();
    app.state.tabs.find(tab => tab.url === launcherUrl).pendingUrl = 'https://user-navigation.test/';
    app.state.tabs.push({ id: 55, windowId: 1, url: launcherUrl });
    await app.controller.flush();
    assert.deepEqual(app.state.removed, []);
});

test('concurrent startup events, worker restart, closed launcher and new windows never reopen it', async () => {
    const app = fixture({ enabled: true });
    await Promise.all([app.controller.start(), app.controller.start(), app.browser.runtime.onStartup.emit()]);
    await app.controller.flush();
    app.state.tabs = app.state.tabs.filter(tab => tab.url !== launcherUrl);
    app.state.windows.push({ id: 2, type: 'normal', focused: true });
    app.state.tabs.push({ id: 20, windowId: 2, url: 'chrome://newtab/' });
    await app.browser.windows.onCreated.emit(app.state.windows[1]);
    await app.controller.flush();
    const restarted = app.makeController();
    await restarted.ready; await restarted.start(); await restarted.flush();
    assert.equal(app.state.created.length, 1);
});

test('startup before a normal window exists waits and later opens in the background', async () => {
    const app = fixture({ enabled: true, windows: [], tabs: [] });
    await app.controller.start(); await app.controller.flush();
    assert.equal(app.state.session[STARTUP_LAUNCHER_SESSION].pending, true);
    app.state.windows.push({ id: 2, type: 'popup', focused: true }, { id: 3, type: 'normal', incognito: true });
    app.state.tabs.push({ id: 20, windowId: 2, url: 'https://popup.test/' }, { id: 30, windowId: 3, url: 'chrome://newtab/' });
    await app.controller.flush();
    assert.equal(app.state.created.length, 0);
    app.state.time += 4000;
    app.state.windows.push({ id: 4, type: 'normal', focused: true });
    app.state.tabs.push({ id: 40, windowId: 4, url: 'https://browsing.test/', active: true });
    await app.browser.windows.onCreated.emit(app.state.windows[2]);
    await app.controller.flush();
    assert.deepEqual(app.state.created, [{ windowId: 4, url: launcherUrl, active: false }]);
});

test('no focus stealing after observed interaction or late readiness', async () => {
    for (const interaction of ['activation', 'navigation', 'focus', 'late', 'differentActiveTab']) {
        const app = fixture({ enabled: true });
        await app.controller.start();
        if (interaction === 'activation') await app.browser.tabs.onActivated.emit({ tabId: 20, windowId: 1 });
        if (interaction === 'navigation') await app.browser.tabs.onUpdated.emit(10, { url: 'https://next.test/' }, app.state.tabs[0]);
        if (interaction === 'focus') await app.browser.windows.onFocusChanged.emit(2);
        if (interaction === 'late') app.state.time += 4000;
        if (interaction === 'differentActiveTab') app.state.tabs[0].id = 99;
        await app.controller.flush();
        assert.equal(app.state.created[0].active, false, interaction);
    }
});

test('pending worker restart or fallback alarm resumes without foreground activation', async () => {
    const session = { [STARTUP_LAUNCHER_SESSION]: { pending: true, fallbackAt: 2000 } };
    const app = fixture({ enabled: true, session });
    await app.controller.ready;
    await app.browser.alarms.onAlarm.emit({ name: STARTUP_LAUNCHER_ALARM });
    assert.deepEqual(app.state.created, [{ windowId: 1, url: launcherUrl, active: false }]);
});

test('turning the setting off cancels a pending startup and enabling mid-session does not launch', async () => {
    const enabled = fixture({ enabled: true });
    await enabled.controller.start();
    enabled.state.sync.startupLauncherEnabled = false;
    await enabled.controller.flush();
    assert.deepEqual(enabled.state.created, []);
    assert.equal(enabled.state.alarms.size, 0);
    const disabled = fixture();
    await disabled.controller.start();
    disabled.state.sync.startupLauncherEnabled = true;
    await disabled.browser.windows.onCreated.emit({ id: 1 });
    await disabled.controller.flush();
    assert.deepEqual(disabled.state.created, []);
});

test('a definite rejected create restores pending state and recovers after a fresh scan', async () => {
    const app = fixture({ enabled: true }); app.state.createError = true;
    await app.controller.start(); await app.controller.flush();
    assert.equal(app.state.created.length, 1);
    assert.equal(app.state.errors.length, 1);
    assert.equal(app.state.session[STARTUP_LAUNCHER_SESSION].pending, true);
    app.state.createError = false;
    await app.controller.flush(); await app.controller.flush();
    assert.equal(app.state.created.length, 2);
    assert.equal(app.state.tabs.filter(tab => tab.url === launcherUrl).length, 1);
});

test('launcher identity is exact and supports query, hash and pending URLs', () => {
    const { browser } = fixture();
    for (const url of [launcherUrl, launcherUrl + '?restored=1#button']) assert.equal(isStartupLauncherUrl(url, browser), true);
    for (const url of ['https://example.test/startup-launcher.html', 'chrome-extension://other/startup-launcher.html', launcherUrl + '.other', undefined]) {
        assert.equal(isStartupLauncherUrl(url, browser), false);
    }
    assert.equal(isStartupLauncherTab({ url: 'about:blank', pendingUrl: launcherUrl }, browser), true);
});

test('settings default is false and archives refuse launcher URLs even with stale ownership', async () => {
    const { browser, state } = fixture(); globalThis.chrome = browser;
    assert.equal((await Utils.getSettings()).startupLauncherEnabled, false);
    browser.storage.local = { get: async () => { throw Error('Must not read/write archive'); } };
    await Utils.addArchivedTab({ url: launcherUrl, name: 'Launcher', spaceId: 'home' });
    browser.runtime.sendMessage = async () => ({ success: true, spaces: [{ id: 'home', spaceBookmarks: [], temporaryTabs: [10] }] });
    state.tabs[0].url = launcherUrl;
    await Utils.archiveTab(10);
    assert.deepEqual(state.removed, []);
});

test('Arcify keeps its permissions and has no new-tab override; launcher is a Vite HTML input', () => {
    const read = name => readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8');
    const manifest = JSON.parse(read('manifest.json'));
    assert.equal(manifest.chrome_url_overrides, undefined);
    assert.deepEqual(manifest.permissions, ['tabs', 'tabGroups', 'sidePanel', 'storage', 'bookmarks', 'alarms', 'commands', 'favicon', 'scripting', 'clipboardWrite', 'offscreen']);
    assert.match(read('vite-plugins/vite-plugin-arcify-extension.js'), /'startup-launcher': resolve\(process.cwd\(\), 'startup-launcher.html'\)/);
});

test('navigation observed during initial window lookup prevents foreground interruption', async () => {
    const app = fixture({ enabled: true });
    const original = app.browser.windows.getAll;
    let first = true;
    app.browser.windows.getAll = async () => {
        if (first) {
            first = false;
            app.state.tabs[0].url = 'https://user-navigation.test/';
            await app.browser.tabs.onUpdated.emit(10, { url: app.state.tabs[0].url }, app.state.tabs[0]);
        }
        return original();
    };
    await app.controller.start(); await app.controller.flush();
    assert.equal(app.state.created[0].active, false);
});

test('activity during the final persistence step still prevents foreground interruption', async () => {
    const app = fixture({ enabled: true });
    await app.controller.start();
    const original = app.browser.alarms.clear;
    app.browser.alarms.clear = async name => {
        await app.browser.tabs.onActivated.emit({ tabId: 20, windowId: 1 });
        return original(name);
    };
    await app.controller.flush();
    assert.equal(app.state.created[0].active, false);
});

test('late restore preserves a window whose only remaining tab is the created launcher', async () => {
    const app = fixture({ enabled: true });
    await app.controller.start(); await app.controller.flush();
    app.state.tabs = app.state.tabs.filter(tab => tab.url === launcherUrl);
    app.state.windows.push({ id: 2, type: 'normal' });
    app.state.tabs.push({ id: 55, windowId: 2, url: launcherUrl });
    await app.controller.flush();
    assert.deepEqual(app.state.removed, []);
    assert.deepEqual(app.state.session[STARTUP_LAUNCHER_SESSION], { pending: false });
});

test('startup quiet-period timer performs the launch and a later alarm cannot repeat it', async () => {
    const app = fixture({ enabled: true });
    await app.controller.start();
    assert.equal(app.state.created.length, 0);
    assert.equal(app.state.timers.size, 1);
    await [...app.state.timers.values()][0]();
    assert.equal(app.state.created.length, 1);
    await app.browser.alarms.onAlarm.emit({ name: STARTUP_LAUNCHER_ALARM });
    assert.equal(app.state.created.length, 1);
});

test('first normal window ready after onStartup gets a foreground launcher after its quiet period', async () => {
    const app = fixture({ enabled: true, windows: [], tabs: [] });
    await app.browser.runtime.onStartup.emit();
    app.state.windows.push({ id: 1, type: 'normal', focused: true });
    app.state.tabs.push({ id: 10, windowId: 1, active: true, url: 'chrome://newtab/' });
    await app.browser.windows.onCreated.emit(app.state.windows[0]);
    await app.browser.tabs.onCreated.emit(app.state.tabs[0]);
    await app.browser.tabs.onActivated.emit({ tabId: 10, windowId: 1 });
    await app.browser.windows.onFocusChanged.emit(1);
    app.state.time += 750;
    await [...app.state.timers.values()][0]();
    assert.equal(app.state.created.length, 0, 'Capture a stable first-window candidate before taking foreground');
    app.state.time += 750;
    await [...app.state.timers.values()][0]();
    assert.deepEqual(app.state.created, [{ windowId: 1, url: launcherUrl, active: true }]);
});

test('ordinary startup loading and redundant initial activation/focus do not hide the launcher', async () => {
    const app = fixture({ enabled: true });
    await app.controller.start();
    await app.browser.tabs.onUpdated.emit(99, { status: 'loading', url: 'https://background-restore.test/' }, { id: 99, windowId: 1 });
    await app.browser.tabs.onUpdated.emit(10, { status: 'loading', url: app.state.tabs[0].url }, app.state.tabs[0]);
    await app.browser.tabs.onUpdated.emit(10, { status: 'complete' }, app.state.tabs[0]);
    await app.browser.tabs.onActivated.emit({ tabId: 10, windowId: 1 });
    await app.browser.windows.onFocusChanged.emit(-1);
    await app.browser.windows.onFocusChanged.emit(1);
    await app.controller.flush();
    assert.equal(app.state.created[0].active, true);
});

test('an initially unfocused startup window waits briefly for focus, but never beyond the deadline', async () => {
    for (const receivesFocus of [true, false]) {
        const app = fixture({ enabled: true, windows: [{ id: 1, type: 'normal', focused: false }] });
        await app.controller.start(); await app.controller.flush();
        assert.equal(app.state.created.length, 0);
        if (receivesFocus) {
            app.state.windows[0].focused = true;
            await app.browser.windows.onFocusChanged.emit(1);
            await app.controller.flush(); // Capture the initial candidate.
        } else app.state.time += 4000;
        await app.controller.flush();
        assert.equal(app.state.created[0].active, receivesFocus);
    }
});

test('changing the late first-window candidate during its quiet period prevents foreground', async () => {
    const app = fixture({ enabled: true, windows: [], tabs: [] });
    await app.controller.start();
    app.state.windows.push({ id: 1, type: 'normal', focused: true });
    app.state.tabs.push({ id: 10, windowId: 1, active: true, url: 'chrome://newtab/' });
    await app.controller.flush(); // Capture, do not open yet.
    await app.browser.tabs.onActivated.emit({ tabId: 11, windowId: 1 });
    await app.controller.flush();
    assert.equal(app.state.created[0].active, false);
});

test('an alarm cleanup failure cannot consume the startup before tab creation', async () => {
    const app = fixture({ enabled: true });
    app.browser.alarms.clear = async () => { throw Error('Temporary alarm API failure'); };
    await app.controller.start(); await app.controller.flush();
    assert.equal(app.state.created.length, 1);
    assert.equal(app.state.session[STARTUP_LAUNCHER_SESSION].createdTabId, 101);
    assert.equal(app.state.errors.length, 1);
});

test('failed initial window lookup preserves the pending request and can acquire the first window later', async () => {
    const app = fixture({ enabled: true });
    const getAll = app.browser.windows.getAll;
    app.browser.windows.getAll = async () => { throw Error('Windows not yet available'); };
    await app.controller.start();
    assert.equal(app.state.session[STARTUP_LAUNCHER_SESSION].pending, true);
    app.browser.windows.getAll = getAll;
    await app.controller.flush(); await app.controller.flush();
    assert.equal(app.state.created[0].active, true);
});

test('automatic retries back off and stop after the startup recovery deadline', async () => {
    const app = fixture({ enabled: true }); app.state.createError = true;
    await app.controller.start();
    while (app.state.timers.size) {
        assert(app.state.created.length < 15, 'Retry loop must be bounded');
        app.state.time += app.state.timerDelays.at(-1);
        await [...app.state.timers.values()][0]();
    }
    assert.equal(app.state.time, 31000, 'The last retry is scheduled no later than the 30-second bound');
    assert.equal(app.state.session[STARTUP_LAUNCHER_SESSION].pending, true);
    assert.equal(app.state.alarms.size, 0);
    app.state.createError = false;
    await app.browser.windows.onCreated.emit(app.state.windows[0]);
    await app.controller.flush();
    assert.equal(app.state.created.at(-1).active, false, 'Late recovery cannot take foreground');
    assert.equal(app.state.tabs.filter(tab => tab.url === launcherUrl).length, 1);
});

test('recovery after rejection reuses a restored launcher instead of creating a duplicate', async () => {
    const app = fixture({ enabled: true }); app.state.createError = true;
    await app.controller.start(); await app.controller.flush();
    app.state.tabs.push({ id: 60, windowId: 1, url: launcherUrl, active: false });
    app.state.createError = false;
    await app.controller.flush();
    assert.equal(app.state.created.length, 1, 'Only the original rejected create was attempted');
    assert.equal(app.state.tabs.find(tab => tab.id === 60).active, false);
    assert.equal(app.state.timers.size, 0);
});

test('a stream of background restore events cannot postpone an already scheduled startup launch', async () => {
    const app = fixture({ enabled: true });
    await app.controller.start();
    const timerId = [...app.state.timers.keys()][0];
    for (let id = 20; id < 30; id++) {
        await app.browser.tabs.onCreated.emit({ id, windowId: 1, active: false });
        await app.browser.tabs.onUpdated.emit(id, { status: 'complete' }, { id, windowId: 1, active: false });
    }
    // Drain the observation queue without directly invoking reconciliation.
    await app.browser.windows.onCreated.emit({ id: 1, type: 'normal' });
    assert.deepEqual([...app.state.timers.keys()], [timerId]);
    assert.equal(app.state.timerDelays.length, 1);
    app.state.time += 750;
    await app.state.timers.get(timerId)();
    assert.equal(app.state.created[0].active, true);
});

test('an initial active tab with no URL waits for readiness before becoming the startup candidate', async () => {
    const app = fixture({ enabled: true, tabs: [{ id: 10, windowId: 1, active: true }] });
    await app.controller.start(); await app.controller.flush();
    assert.equal(app.state.created.length, 0);
    app.state.tabs[0].url = 'chrome://newtab/';
    await app.browser.tabs.onUpdated.emit(10, { url: 'chrome://newtab/' }, app.state.tabs[0]);
    await app.controller.flush(); await app.controller.flush();
    assert.equal(app.state.created[0].active, true);
});

test('failure to arm the fallback alarm does not stop the startup timer', async () => {
    const app = fixture({ enabled: true });
    app.browser.alarms.create = async () => { throw Error('Alarm not ready'); };
    await app.controller.start();
    await [...app.state.timers.values()][0]();
    assert.equal(app.state.created[0].active, true);
    assert.equal(app.state.session[STARTUP_LAUNCHER_SESSION].createdTabId, 101);
});

test('navigation away from a newly created startup tab before capture also suppresses foreground', async () => {
    const app = fixture({ enabled: true, windows: [], tabs: [] });
    await app.controller.start();
    app.state.windows.push({ id: 1, type: 'normal', focused: true });
    app.state.tabs.push({ id: 10, windowId: 1, active: true, url: 'chrome://newtab/' });
    await app.browser.tabs.onCreated.emit(app.state.tabs[0]);
    app.state.tabs[0].url = 'https://user-navigation.test/';
    await app.browser.tabs.onUpdated.emit(10, { url: app.state.tabs[0].url }, app.state.tabs[0]);
    await app.controller.flush(); await app.controller.flush();
    assert.equal(app.state.created[0].active, false);
});

test('worker restart does not replay an unresolved create with an unknown result', async () => {
    const app = fixture({ enabled: true });
    let completeCreate;
    app.browser.tabs.create = options => {
        app.state.created.push(options);
        return new Promise(resolve => { completeCreate = () => {
            const tab = { ...options, id: 101 }; app.state.tabs.push(tab); resolve(tab);
        }; });
    };
    await app.controller.start();
    const pending = app.controller.flush();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(app.state.created.length, 1);
    assert.equal(app.state.session[STARTUP_LAUNCHER_SESSION].pending, false);
    const restarted = app.makeController();
    await restarted.ready; await restarted.flush();
    assert.equal(app.state.created.length, 1);
    completeCreate(); await pending;
    assert.equal(app.state.tabs.filter(tab => tab.url === launcherUrl).length, 1);
});
