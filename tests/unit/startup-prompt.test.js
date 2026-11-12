import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerStartupPrompt, STARTUP_PROMPT_SESSION } from '../../startup-prompt.js';
import { isStartupLauncherTab } from '../../startup-launcher-tab.js';

const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); },
    emit(...args) { for (const fn of this.listeners) fn(...args); } });
const area = values => ({ get: async keys => typeof keys === 'string' ? { [keys]: values[keys] } : { ...keys, ...values },
    set: async patch => Object.assign(values, structuredClone(patch)) });
function fixture(enabled = true) {
    const state = { time: 1000, sync: { startupPromptEnabled: enabled }, session: {}, creates: [], errors: [], waits: [],
        window: { id: 1, type: 'normal', incognito: false, focused: true,
            tabs: [{ id: 10, windowId: 1, active: true, url: 'https://example.test/' }] } };
    const browser = {
        runtime: { getURL: path => `chrome-extension://arcify/${path}`, onStartup: event() },
        storage: { sync: area(state.sync), session: area(state.session) }, sidePanel: { open() { throw Error('Must never open automatically'); } },
        windows: { onFocusChanged: event(), onRemoved: event(), getAll: async () => [structuredClone(state.window)],
            create: async value => { state.creates.push(value); if (state.createError) throw Error('Rejected'); return { id: 20 }; } },
        tabs: { onActivated: event(), onUpdated: event(), onRemoved: event(), onDetached: event(), onReplaced: event() }
    };
    const options = { now: () => state.time, randomToken: () => 'token', reportError: error => state.errors.push(error),
        wait: async ms => { state.waits.push(ms); state.time += ms; state.onWait?.(ms); },
        prepareWindowEligibility: async () => state.onPrepare?.(),
        isExcludedWindow: () => state.excluded };
    const controller = registerStartupPrompt(browser, options);
    return { state, browser, controller, options };
}

test('off by default and registration/reload alone never creates a popup', async () => {
    const app = fixture(undefined); delete app.state.sync.startupPromptEnabled;
    await Promise.resolve(); assert.equal(app.state.creates.length, 0);
    await app.controller.start(); assert.equal(app.state.creates.length, 0);
});
test('enabled stable startup creates one focused helper bound to original target', async () => {
    const app = fixture();
    await Promise.all([app.controller.start(), app.controller.start()]);
    assert.equal(app.state.creates.length, 1);
    assert.deepEqual(app.state.creates[0], { type: 'popup', width: 440, height: 280, focused: true,
        url: 'chrome-extension://arcify/startup-prompt.html?token=token' });
    assert.deepEqual(app.state.session[STARTUP_PROMPT_SESSION], { status: 'open',
        token: 'token', windowId: 1, tabId: 10, url: 'https://example.test/', createdAt: 1750, promptWindowId: 20 });
});
test('worker restarts and duplicate startup events cannot replay a consumed claim', async () => {
    const app = fixture(); await app.controller.start();
    await registerStartupPrompt(app.browser, app.options).start();
    assert.equal(app.state.creates.length, 1);
});
for (const kind of ['focus', 'activation', 'navigation']) {
    test(`in-flight initial read preserves evidence of ${kind} changes`, async () => {
        const app = fixture();
        app.browser.windows.getAll = async () => {
            const snapshot = structuredClone(app.state.window);
            if (kind === 'focus') { app.browser.windows.onFocusChanged.emit(1); app.browser.windows.onFocusChanged.emit(2); }
            if (kind === 'activation') { app.browser.tabs.onActivated.emit({ windowId: 1, tabId: 10 }); app.browser.tabs.onActivated.emit({ windowId: 1, tabId: 11 }); }
            if (kind === 'navigation') app.browser.tabs.onUpdated.emit(10, { url: 'https://changed.test/' });
            return [snapshot];
        };
        await app.controller.start(); assert.equal(app.state.creates.length, 0);
    });
}
for (const action of ['focus', 'selection', 'url', 'close', 'detach', 'replace', 'window-close', 'disable']) {
    test(`startup suppresses prompt after ${action}`, async () => {
        const app = fixture(); app.state.onWait = () => {
            if (action === 'focus') app.browser.windows.onFocusChanged.emit(-1);
            if (action === 'selection') app.browser.tabs.onActivated.emit({ windowId: 1, tabId: 11 });
            if (action === 'url') app.browser.tabs.onUpdated.emit(10, { url: 'https://changed.test/' });
            if (action === 'close') app.browser.tabs.onRemoved.emit(10);
            if (action === 'detach') app.browser.tabs.onDetached.emit(10);
            if (action === 'replace') app.browser.tabs.onReplaced.emit(11, 10);
            if (action === 'window-close') app.browser.windows.onRemoved.emit(1);
            if (action === 'disable') app.state.sync.startupPromptEnabled = false;
        };
        await app.controller.start(); assert.equal(app.state.creates.length, 0);
    });
}
for (const mode of ['incognito', 'popup', 'unfocused', 'excluded', 'unsupported', 'late']) {
    test(`startup skips ${mode} without creating a fallback tab or window`, async () => {
        const app = fixture();
        if (mode === 'incognito') app.state.window.incognito = true;
        if (mode === 'popup') app.state.window.type = 'popup';
        if (mode === 'unfocused') app.state.window.focused = false;
        if (mode === 'excluded') app.state.excluded = true;
        if (mode === 'unsupported') delete app.browser.sidePanel;
        if (mode === 'late') app.state.onWait = () => { app.state.time += 6000; };
        await app.controller.start(); assert.equal(app.state.creates.length, 0);
    });
}
test('rejected popup creation is not retried or replayed', async () => {
    const app = fixture(); app.state.createError = true;
    await app.controller.start(); await registerStartupPrompt(app.browser, app.options).start();
    assert.equal(app.state.creates.length, 1); assert.equal(app.state.errors.length, 1);
});
test('late normal window gets a quiet period within the deadline', async () => {
    const app = fixture(); app.state.window.focused = false;
    app.state.onWait = () => { app.state.window.focused = true; };
    await app.controller.start(); assert.equal(app.state.creates.length, 1);
    assert.deepEqual(app.state.waits, [100, 750]);
});
test('prompt URL is excluded like launcher without excluding another origin or ordinary site', () => {
    const { browser } = fixture();
    assert.equal(isStartupLauncherTab({ pendingUrl: 'chrome-extension://arcify/startup-prompt.html?token=x' }, browser), true);
    assert.equal(isStartupLauncherTab({ url: 'chrome-extension://other/startup-prompt.html' }, browser), false);
    assert.equal(isStartupLauncherTab({ url: 'https://example.test/startup-prompt.html' }, browser), false);
});

 test('startup diagnostic reports skips without tab URLs or identities', async () => {
 const app = fixture(); app.state.onWait = () => { app.state.time += 6000; }; await app.controller.start();
 const d = app.state.session.arcifyStartupPromptDiagnostic; assert.equal(d.reason, 'settle-check'); assert.equal(d.elapsedMs, 6750);
 assert.equal(JSON.stringify(d).includes('example.test'), false); assert.equal(Object.hasOwn(d,'tabId'), false);
 });


for (const timing of ['prepare', 'settle']) {
 test('same restored URL after capture does not suppress during '+timing, async () => {
  const app=fixture(); const announce=()=>app.browser.tabs.onUpdated.emit(10,{url:'https://example.test/'});
  if(timing==='prepare') app.state.onPrepare=announce; else app.state.onWait=announce;
  await app.controller.start(); assert.equal(app.state.creates.length,1);
 });
}
test('real recovery delay fits within bounded five-second startup window',async()=>{
 const app=fixture(); app.state.onPrepare=()=>{ app.state.time+=2881; app.browser.tabs.onUpdated.emit(10,{url:'https://example.test/'}); };
 await app.controller.start(); assert.equal(app.state.creates.length,1);
});
for (const snapshot of ['stale', 'fresh', 'same']) {
 test('initial '+snapshot+' snapshot reconciles matching URL events once', async () => {
  const app = fixture(); let first = true;
  app.browser.windows.getAll = async () => {
   if (!first) return [structuredClone(app.state.window)];
   first = false;
   const original = structuredClone(app.state.window);
   const next = snapshot === 'same' ? 'https://example.test/' : 'https://changed.test/';
   app.browser.tabs.onUpdated.emit(10, { url: next }); app.state.window.tabs[0].url = next;
   return [snapshot === 'stale' ? original : structuredClone(app.state.window)];
  };
  await app.controller.start();
  const diag = app.state.session.arcifyStartupPromptDiagnostic;
  assert.equal(app.state.creates.length, snapshot === 'stale' ? 0 : 1);
  assert.equal(diag.reason, snapshot === 'stale' ? 'initial-capture-url-conflict' : 'created');
  assert.equal(diag.initialNavigationAccepted, snapshot !== 'stale');
  assert.equal(diag.initialNavigationConflict, snapshot === 'stale');
 });
}
test('navigation during recovery preparation still cancels',async()=>{
 const app=fixture(); app.state.onPrepare=()=>{app.state.window.tabs[0].url='https://changed.test/';app.browser.tabs.onUpdated.emit(10,{url:'https://changed.test/'});};
 await app.controller.start(); assert.equal(app.state.creates.length,0);
});
test('window excluded by recovery initialization cannot receive prompt',async()=>{
 const app=fixture(); app.state.onPrepare=()=>{app.state.excluded=true;};
 await app.controller.start(); assert.equal(app.state.creates.length,0);
});
test('navigation away and back still suppresses startup prompt',async()=>{
 const app=fixture(); app.state.onWait=()=>{ app.browser.tabs.onUpdated.emit(10,{url:'https://changed.test/'}); app.browser.tabs.onUpdated.emit(10,{url:'https://example.test/'}); };
 await app.controller.start(); assert.equal(app.state.creates.length,0);
});


for (const operation of ['session-get', 'session-set', 'settings-get']) {
    test('restored URL during '+operation+' uses an already captured target', async () => {
        const app = fixture();
        const area = operation.startsWith('session') ? app.browser.storage.session : app.browser.storage.sync;
        const method = operation.endsWith('set') ? 'set' : 'get';
        const original = area[method];
        let first = true;
        area[method] = async (...args) => {
            if (first) {
                first = false;
                app.state.time += 1600;
                app.browser.tabs.onUpdated.emit(10, { url: 'https://example.test/' });
            }
            return original(...args);
        };
        await app.controller.start();
        assert.equal(app.state.creates.length, 1);
        assert.equal(app.state.session.arcifyStartupPromptDiagnostic.captureElapsedMs, 0);
        assert.equal(app.state.session.arcifyStartupPromptDiagnostic.navigationBeforeCapture, false);
    });
}

for (const navigation of ['away', 'away-and-back']) {
    test('real '+navigation+' navigation during claim still cancels', async () => {
        const app = fixture();
        const original = app.browser.storage.session.get;
        app.browser.storage.session.get = async (...args) => {
            app.browser.tabs.onUpdated.emit(10, { url: 'https://changed.test/' });
            app.state.window.tabs[0].url = 'https://changed.test/';
            if (navigation === 'away-and-back') {
                app.browser.tabs.onUpdated.emit(10, { url: 'https://example.test/' });
                app.state.window.tabs[0].url = 'https://example.test/';
            }
            return original(...args);
        };
        await app.controller.start();
        assert.equal(app.state.creates.length, 0);
        assert.equal(app.state.session.arcifyStartupPromptDiagnostic.changed, true);
    });
}

test('first snapshot is dispatched before startup storage reads', async () => {
    const app = fixture(); const calls = [];
    const originalWindows = app.browser.windows.getAll;
    app.browser.windows.getAll = async (...args) => { calls.push('windows'); return originalWindows(...args); };
    const originalGet = app.browser.storage.session.get;
    app.browser.storage.session.get = async (...args) => { calls.push('session'); return originalGet(...args); };
    await app.controller.start();
    assert.deepEqual(calls.slice(0, 2), ['windows', 'session']);
});

// Reproduce the reported ordering without sleep/timer races: restore announces
// the active URL during the first 85 ms snapshot, then claim/setup take time.
test('reported first-read restoration event permits one prompt without a new baseline', async () => {
 const app = fixture(); let finish;
 const first = new Promise(resolve => { finish = resolve; }); let reads = 0;
 app.browser.windows.getAll = async () => ++reads === 1 ? first : [structuredClone(app.state.window)];
 const run = app.controller.start();
 app.state.time += 85;
 app.browser.tabs.onUpdated.emit(10, { url: 'https://example.test/' });
 app.browser.tabs.onUpdated.emit(10, { url: 'https://example.test/' });
 finish([structuredClone(app.state.window)]);
 app.state.onPrepare = () => { app.state.time += 1464; };
 await run;
 assert.equal(app.state.creates.length, 1);
 const diag = app.state.session.arcifyStartupPromptDiagnostic;
 assert.equal(diag.initialNavigationAccepted, true);
 assert.equal(diag.captureElapsedMs, 85);
 assert.equal(diag.reason, 'created');
});
for (const events of [
 ['https://changed.test/', 'https://example.test/'],
 ['https://example.test/', 'https://changed.test/', 'https://example.test/']
]) {
 test('conflicting first-read URLs stay sticky even when final URL agrees: '+events.length, async () => {
  const app = fixture(); let first = true;
  app.browser.windows.getAll = async () => {
   if (first) { first = false; for (const url of events) app.browser.tabs.onUpdated.emit(10, { url }); }
   return [structuredClone(app.state.window)];
  };
  await app.controller.start();
  assert.equal(app.state.creates.length, 0);
  assert.equal(app.state.session.arcifyStartupPromptDiagnostic.reason, 'initial-capture-url-conflict');
 });
}
for (const key of ['url', 'pendingUrl']) {
 test('first-read '+key+' is compared with effective pending URL', async () => {
  const app = fixture(); let first = true;
  app.state.window.tabs[0].pendingUrl = 'https://pending.test/';
  app.browser.windows.getAll = async () => {
   if (first) { first = false; app.browser.tabs.onUpdated.emit(10, { [key]: 'https://pending.test/' }); }
   return [structuredClone(app.state.window)];
  };
  await app.controller.start(); assert.equal(app.state.creates.length, 1);
  assert.equal(app.state.session[STARTUP_PROMPT_SESSION].url, 'https://pending.test/');
 });
}
test('conflicting committed and pending URL events do not form an accepted baseline', async () => {
 const app = fixture(); let first = true;
 app.state.window.tabs[0].pendingUrl = 'https://pending.test/';
 app.browser.windows.getAll = async () => {
  if (first) { first = false; app.browser.tabs.onUpdated.emit(10, { url: 'https://example.test/', pendingUrl: 'https://pending.test/' }); }
  return [structuredClone(app.state.window)];
 };
 await app.controller.start(); assert.equal(app.state.creates.length, 0);
});
for (const kind of ['focus-away-back', 'tab-away-back', 'focus-none', 'later-navigation']) {
 test('matching baseline never clears '+kind+' cancellation', async () => {
  const app = fixture(); let first = true;
  app.browser.windows.getAll = async () => {
   if (first) {
    first = false;
    app.browser.tabs.onUpdated.emit(10, { url: 'https://example.test/' });
    if (kind === 'focus-away-back') { app.browser.windows.onFocusChanged.emit(2); app.browser.windows.onFocusChanged.emit(1); }
    if (kind === 'tab-away-back') { app.browser.tabs.onActivated.emit({ windowId: 1, tabId: 11 }); app.browser.tabs.onActivated.emit({ windowId: 1, tabId: 10 }); }
    if (kind === 'focus-none') app.browser.windows.onFocusChanged.emit(-1);
   }
   return [structuredClone(app.state.window)];
  };
  if (kind === 'later-navigation') app.state.onWait = () => {
   app.state.window.tabs[0].url = 'https://changed.test/';
   app.browser.tabs.onUpdated.emit(10, { url: 'https://changed.test/' });
  };
  await app.controller.start(); assert.equal(app.state.creates.length, 0);
 });
}
test('background first-read URL events do not contaminate the target baseline', async () => {
 const app = fixture(); let first = true;
 app.browser.windows.getAll = async () => {
  if (first) { first = false; app.browser.tabs.onUpdated.emit(99, { url: 'https://elsewhere.test/' }); }
  return [structuredClone(app.state.window)];
 };
 await app.controller.start(); assert.equal(app.state.creates.length, 1);
 assert.equal(app.state.session.arcifyStartupPromptDiagnostic.initialNavigationAccepted, false);
});
