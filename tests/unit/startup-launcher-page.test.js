import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';
import { initializeLauncherPage } from '../../startup-launcher-page.js';

const html = readFileSync(new URL('../../startup-launcher.html', import.meta.url), 'utf8');
function fixture() {
    const { document, window } = parseHTML(html);
    const calls = [];
    const browser = { tabs: { getCurrent: async () => ({ id: 42, windowId: 7 }) },
        sidePanel: { open: options => { calls.push(options); return Promise.resolve(); } } };
    const button = document.getElementById('openSidebar');
    const status = document.getElementById('launcherStatus');
    // These are unit-level event fixtures, not real browser user activation.
    const click = (trusted = true) => { const event = new window.Event('click'); event.isTrusted = trusted; button.dispatchEvent(event); };
    return { document, browser, calls, button, status, click };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('page is keyboard-accessible, starts disabled, and does not open on load', async () => {
    const app = fixture();
    assert.equal(app.button.tagName, 'BUTTON');
    assert.equal(app.button.getAttribute('type'), 'button');
    assert.equal(app.button.disabled, true);
    assert.equal(app.button.textContent, 'Open Arcify sidebar');
    assert.equal(app.status.getAttribute('role'), 'status');
    assert.equal(app.button.getAttribute('aria-describedby'), app.status.id);
    await initializeLauncherPage(app.document, app.browser);
    assert.equal(app.button.disabled, false);
    assert.deepEqual(app.calls, []);
});

test('trusted button event calls open synchronously, scoped to the launcher tab before any await', async () => {
    const app = fixture();
    await initializeLauncherPage(app.document, app.browser);
    app.browser.tabs.getCurrent = () => { throw Error('No lookup may precede open in the click handler'); };
    app.click();
    assert.deepEqual(app.calls, [{ tabId: 42 }]);
    assert.equal(app.button.disabled, true);
    app.click(); // Repeated activation while the API is pending is ignored.
    assert.equal(app.calls.length, 1);
    await settle();
    assert.equal(app.button.disabled, false);
    assert.match(app.status.textContent, /Arcify is open/);
});

test('synthetic script clicks never attempt to open the sidebar', async () => {
    const app = fixture(); await initializeLauncherPage(app.document, app.browser);
    app.click(false); app.button.click();
    assert.deepEqual(app.calls, []);
});

test('browser resolves moved tab location from tabId, without a stale cached windowId', async () => {
    const app = fixture(); await initializeLauncherPage(app.document, app.browser);
    app.browser.tabs.getCurrent = async () => ({ id: 42, windowId: 99 });
    app.click();
    assert.deepEqual(app.calls, [{ tabId: 42 }]);
});

test('unsupported API and missing tab show a helpful fallback without enabling the button', async () => {
    for (const unavailable of ['api', 'tab', 'error']) {
        const app = fixture();
        if (unavailable === 'api') delete app.browser.sidePanel;
        if (unavailable === 'tab') app.browser.tabs.getCurrent = async () => undefined;
        if (unavailable === 'error') app.browser.tabs.getCurrent = async () => { throw Error('Unavailable'); };
        await initializeLauncherPage(app.document, app.browser);
        assert.equal(app.button.disabled, true);
        assert.match(app.status.textContent, /toolbar icon/);
        assert.deepEqual(app.calls, []);
    }
});

test('both synchronous and async open failures allow a genuine retry and keep the page open', async () => {
    for (const sync of [true, false]) {
        const app = fixture();
        app.browser.sidePanel.open = () => { if (sync) throw Error('Gesture rejected'); return Promise.reject(Error('Gesture rejected')); };
        await initializeLauncherPage(app.document, app.browser);
        app.click(); await settle();
        assert.equal(app.button.disabled, false);
        assert.match(app.status.textContent, /Click the button again/);
        app.browser.sidePanel.open = options => { app.calls.push(options); return Promise.resolve(); };
        app.click(); await settle();
        assert.deepEqual(app.calls, [{ tabId: 42 }]);
    }
});
