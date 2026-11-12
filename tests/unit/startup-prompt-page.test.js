import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';
import { initializeStartupPrompt } from '../../startup-prompt-page.js';
import { STARTUP_PROMPT_SESSION } from '../../startup-prompt.js';

const html = readFileSync(new URL('../../startup-prompt.html', import.meta.url), 'utf8');
const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); },
    emit(...args) { this.listeners.forEach(fn => fn(...args)); } });
const settle = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
    const { document, window } = parseHTML(html);
    const state = { time: 2000, focused: true, opened: [], closed: 0, listeners: {}, enabled: true,
        record: { status: 'open', token: 'token', tabId: 10, windowId: 1, promptWindowId: 20, createdAt: 1000, url: 'https://example.test/' },
        tab: { id: 10, windowId: 1, active: true, url: 'https://example.test/' },
        own: { id: 20, type: 'popup', focused: true }, targetWindow: { id: 1, type: 'normal' } };
    document.hasFocus = () => state.focused;
    const host = { location: { href: 'chrome-extension://arcify/startup-prompt.html?token=token' },
        navigator: { userActivation: { isActive: true } }, close: () => state.closed++,
        addEventListener: (name, fn) => { state.listeners[name] = fn; } };
    const browser = {
        sidePanel: { open: value => { state.opened.push(value); return Promise.resolve(); } },
        storage: { session: { get: async () => ({ [STARTUP_PROMPT_SESSION]: state.record }) },
            sync: { get: async () => ({ startupPromptEnabled: state.enabled }) }, onChanged: event() },
        windows: { getCurrent: async () => state.own, get: async () => state.targetWindow, onRemoved: event() },
        tabs: { get: async () => state.tab, onRemoved: event(), onDetached: event(), onReplaced: event(), onActivated: event(), onUpdated: event() }
    };
    const button = document.getElementById('openSidebar');
    button.focus = () => { state.buttonFocused = true; };
    const click = (trusted = true) => { const ev = new window.Event('click'); ev.isTrusted = trusted; button.dispatchEvent(ev); };
    const init = () => initializeStartupPrompt(document, browser, host,
        { now: () => state.time, wait: async () => {}, setTimer: fn => { state.expire = fn; } });
    return { state, document, window, host, browser, button, click, init };
}
test('ready prompt focuses an accessible button but never opens automatically', async () => {
    const app = fixture(); assert.equal(app.button.disabled, true); await app.init();
    assert.equal(app.button.disabled, false); assert.equal(app.state.buttonFocused, true);
    assert.deepEqual(app.state.opened, []); assert.equal(app.state.closed, 0);
});
test('genuine gesture opens synchronously with original target and closes only after success', async () => {
    const app = fixture(); await app.init();
    app.browser.tabs.get = () => { throw Error('No async lookup before open'); };
    app.click(); assert.deepEqual(app.state.opened, [{ tabId: 10, windowId: 1 }]);
    app.click(); assert.equal(app.state.opened.length, 1); assert.equal(app.state.closed, 0);
    await settle(); assert.equal(app.state.closed, 1);
});
test('synthetic, inactive and unfocused events never call open', async () => {
    const app = fixture(); await app.init();
    app.click(false); app.button.click(); app.host.navigator.userActivation.isActive = false; app.click();
    app.host.navigator.userActivation.isActive = true; app.state.focused = false; app.click();
    assert.deepEqual(app.state.opened, []);
});
for (const kind of ['token', 'window', 'moved', 'selection', 'navigation', 'incognito', 'disabled', 'expired', 'unfocused']) {
    test(`initial ${kind} mismatch prevents opening`, async () => {
        const app = fixture();
        if (kind === 'token') app.state.record.token = 'wrong';
        if (kind === 'window') app.state.own.id = 99;
        if (kind === 'moved') app.state.tab.windowId = 99;
        if (kind === 'selection') app.state.tab.active = false;
        if (kind === 'navigation') app.state.tab.pendingUrl = 'https://changed.test/';
        if (kind === 'incognito') app.state.targetWindow.incognito = true;
        if (kind === 'disabled') app.state.enabled = false;
        if (kind === 'expired') app.state.time = 61000;
        if (kind === 'unfocused') app.state.focused = false;
        await app.init(); app.click(); assert.equal(app.button.disabled, true); assert.deepEqual(app.state.opened, []);
    });
}
for (const kind of ['blur', 'selection', 'navigation', 'removed', 'detached', 'replaced', 'window', 'disabled', 'expired']) {
    test(`ready prompt expires on ${kind}`, async () => {
        const app = fixture(); await app.init();
        if (kind === 'blur') app.state.listeners.blur();
        if (kind === 'selection') app.browser.tabs.onActivated.emit({ windowId: 1, tabId: 11 });
        if (kind === 'navigation') app.browser.tabs.onUpdated.emit(10, { pendingUrl: 'https://changed.test/' });
        if (kind === 'removed') app.browser.tabs.onRemoved.emit(10);
        if (kind === 'detached') app.browser.tabs.onDetached.emit(10);
        if (kind === 'replaced') app.browser.tabs.onReplaced.emit(11, 10);
        if (kind === 'window') app.browser.windows.onRemoved.emit(1);
        if (kind === 'disabled') app.browser.storage.onChanged.emit({ startupPromptEnabled: { newValue: false } }, 'sync');
        if (kind === 'expired') app.state.expire();
        app.click(); assert.equal(app.button.disabled, true); assert.deepEqual(app.state.opened, []);
    });
}
test('Cancel and Escape dismiss without opening or changing browsing tabs', async () => {
    for (const escape of [false, true]) {
        const app = fixture(); await app.init();
        if (escape) { const ev = new app.window.Event('keydown'); ev.key = 'Escape'; app.document.dispatchEvent(ev); }
        else app.document.getElementById('cancel').click();
        assert.equal(app.state.closed, 1); assert.deepEqual(app.state.opened, []);
    }
});
test('open rejection leaves a retry button; a target change still prevents retry', async () => {
    const app = fixture(); await app.init();
    app.browser.sidePanel.open = () => Promise.reject(Error('Gesture rejected'));
    app.click(); await settle(); assert.equal(app.button.disabled, false); assert.equal(app.state.closed, 0);
    app.browser.tabs.onDetached.emit(10); app.click(); assert.equal(app.button.disabled, true);
});

test('same restored URL notification leaves ready prompt usable', async () => {
    const app = fixture(); await app.init();
    app.browser.tabs.onUpdated.emit(10, { url: 'https://example.test/' });
    assert.equal(app.button.disabled, false); app.click();
    assert.deepEqual(app.state.opened, [{ tabId: 10, windowId: 1 }]);
});
