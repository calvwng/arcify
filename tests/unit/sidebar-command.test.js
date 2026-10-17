import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSidebarCommandHandler } from '../../sidebar-command.js';
import { PEER_KEY } from '../../spotlight-bridge-protocol.js';

const PEER = 'a'.repeat(32);
const request = () => ({ type: 'arcify-sidebar', version: 1, requestId: 'open-1' });
const source = () => ({ id: PEER, frameId: 0, documentLifecycle: 'active',
    url: `chrome-extension://${PEER}/newtab.html`, origin: `chrome-extension://${PEER}`,
    tab: { id: 17, windowId: 3, active: true, incognito: false, url: 'chrome://newtab/' } });

// This callback-scope fixture proves call ordering, not real browser activation.
function fixture() {
    const state = { paired: PEER, reads: 0, opened: [], replies: [], callbackScope: false };
    const browser = { runtime: {}, storage: { local: { get(key, callback) {
        assert.equal(key, PEER_KEY); assert.equal(typeof callback, 'function');
        state.reads++;
        state.deliver = () => { state.callbackScope = true; callback({ [PEER_KEY]: state.paired }); state.callbackScope = false; };
    } } }, sidePanel: { open(options) {
        assert.equal(state.callbackScope, true, 'Open must happen synchronously inside the one storage callback');
        state.opened.push(options);
        if (state.throwOpen) throw new Error('A user gesture is required');
        return state.rejectOpen ? Promise.reject(new Error('A user gesture is required')) : Promise.resolve();
    } } };
    const handler = createSidebarCommandHandler(browser);
    const run = async (message = request(), sender = source()) => {
        const result = handler(message, sender, response => state.replies.push(response));
        if (state.deliver) state.deliver();
        await Promise.resolve();
        return result;
    };
    return { browser, state, handler, run };
}

test('cold handler reads current pairing through one callback and opens the browser-attested source tab', async () => {
    const app = fixture();
    assert.equal(await app.run(), true);
    assert.equal(app.state.reads, 1);
    assert.deepEqual(app.state.opened, [{ tabId: 17 }]);
    assert.deepEqual(app.state.replies, [{ ...request(), role: 'arcify', ok: true }]);
});

test('pairing is read fresh for every action and a revoked pairing never opens', async () => {
    const app = fixture();
    await app.run(); app.state.paired = '';
    await app.run({ ...request(), requestId: 'open-2' });
    assert.equal(app.state.opened.length, 1);
    assert.equal(app.state.reads, 2);
    assert.equal(app.state.replies[1].error.code, 'UNAUTHORIZED');
});

test('current paired top-frame HTTP(S) content script can open only its own source tab', async () => {
    for (const url of ['https://example.test/path?q=1#part', 'http://localhost:8080/path']) {
        const app = fixture(); const sender = source();
        sender.url = sender.tab.url = url; sender.origin = new URL(url).origin;
        await app.run(request(), sender);
        assert.deepEqual(app.state.opened, [{ tabId: 17 }]);
    }
});

test('exact extension page, query/hash and display URL forms are accepted', async () => {
    for (const tabUrl of ['chrome://newtab/', `chrome-extension://${PEER}/newtab.html?startup#entry`]) {
        const app = fixture(); const sender = source();
        sender.url += '?startup#entry'; sender.tab.url = tabUrl;
        await app.run(request(), sender);
        assert.equal(app.state.replies[0].ok, true);
    }
});

test('wrong peers, targets, frames, inactive documents and unsupported origins fail closed', async () => {
    const changes = [
        sender => { sender.id = 'b'.repeat(32); },
        sender => { delete sender.tab; },
        sender => { sender.frameId = 2; },
        sender => { delete sender.frameId; },
        sender => { sender.documentLifecycle = 'prerender'; },
        sender => { sender.documentLifecycle = 'cached'; },
        sender => { sender.tab.id = -1; },
        sender => { sender.tab.windowId = 0; },
        sender => { sender.tab.active = false; },
        sender => { sender.tab.incognito = true; },
        sender => { sender.url = `chrome-extension://${PEER}/options.html`; },
        sender => { sender.origin = `chrome-extension://${'b'.repeat(32)}`; },
        sender => { sender.tab.url = 'https://other.test/'; },
        sender => { sender.tab.pendingUrl = 'https://other.test/'; },
        sender => { sender.url = sender.tab.url = 'https://example.test/path'; sender.origin = 'https://other.test'; },
        sender => { sender.url = 'https://example.test/old'; sender.tab.url = 'https://example.test/new'; sender.origin = 'https://example.test'; },
        sender => { sender.url = sender.tab.url = 'https://example.test/'; sender.origin = 'https://example.test'; sender.tab.pendingUrl = 'https://example.test/next'; },
        sender => { sender.url = sender.tab.url = 'file:///tmp/test.html'; sender.origin = 'file://'; },
        sender => { sender.url = sender.tab.url = 'about:blank'; sender.origin = 'null'; }
    ];
    for (const change of changes) {
        const app = fixture(); const sender = source(); change(sender);
        await app.run(request(), sender);
        assert.deepEqual(app.state.opened, [], change.toString());
        assert.equal(app.state.replies[0].error.code, 'UNAUTHORIZED', change.toString());
    }
});

test('malformed payloads cannot smuggle a target and fail before a storage read', async () => {
    for (const patch of [{ version: 2 }, { requestId: '' }, { requestId: 'x'.repeat(81) }, { windowId: 99 }, { tabId: 99 }, { command: 'openSidebar' }]) {
        const app = fixture(); await app.run({ ...request(), ...patch });
        assert.equal(app.state.reads, 0); assert.deepEqual(app.state.opened, []);
        assert.equal(app.state.replies[0].ok, false);
    }
});

test('unrelated messages are left for their own listeners', async () => {
    const app = fixture(); assert.equal(await app.run({ type: 'arcify-bridge' }), undefined);
    assert.equal(app.state.reads, 0); assert.deepEqual(app.state.replies, []);
});

test('unsupported API, runtime storage error, thrown API and rejected gesture show correlated errors', async () => {
    for (const failure of ['unsupported', 'storage', 'throw', 'reject']) {
        const app = fixture();
        if (failure === 'unsupported') delete app.browser.sidePanel;
        if (failure === 'storage') app.browser.runtime.lastError = { message: 'storage unavailable' };
        if (failure === 'throw') app.state.throwOpen = true;
        if (failure === 'reject') app.state.rejectOpen = true;
        await app.run();
        assert.equal(app.state.replies.length, 1);
        assert.equal(app.state.replies[0].ok, false);
        assert.equal(app.state.replies[0].requestId, 'open-1');
        if (['unsupported', 'storage'].includes(failure)) assert.deepEqual(app.state.opened, []);
    }
});

test('synchronous storage failure is reported without attempting open', async () => {
    const app = fixture(); app.browser.storage.local.get = () => { throw new Error('Storage stopped'); };
    await app.run(); assert.equal(app.state.replies[0].ok, false); assert.deepEqual(app.state.opened, []);
});
