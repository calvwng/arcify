import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareStartupSuggestion, offerStartupSuggestion, sendStartupBridgeRequest } from '../../startup-spotlight.js';
import { PEER_KEY } from '../../spotlight-bridge-protocol.js';

const PEER = 'a'.repeat(32);
const tab = { id: 17, windowId: 3, url: `chrome-extension://${PEER}/newtab.html`, active: true };
function fixture() {
    const state = { peer: PEER, messages: [], reads: 0, hello: { extensionId: PEER, capabilities: ['startupSuggestion'] },
        offer: { accepted: true } };
    const browser = { storage: { local: { async get() { state.reads++; return { [PEER_KEY]: state.peer }; } } }, runtime: {
        sendMessage(peerId, request, callback) {
            state.messages.push({ peerId, request });
            if (state.onSend) state.onSend(request);
            if (state.noReply) return;
            callback({ type: 'arcify-bridge', version: 1, requestId: request.requestId, role: 'spotlight', ok: true,
                ...(request.command === 'hello' ? state.hello : state.offer), ...state.patch });
        }
    } };
    return { state, browser };
}

test('paired newtab and Chrome display alias negotiate optional startup capability without mutation', async () => {
    for (const url of [tab.url, tab.url + '?query#hash', 'chrome://newtab/']) {
        const app = fixture(); const context = await prepareStartupSuggestion(app.browser, { ...tab, url });
        assert.deepEqual(context, { peerId: PEER, tabId: 17, windowId: 3 });
        assert.equal(app.state.messages.length, 1); assert.equal(app.state.messages[0].request.command, 'hello');
        assert.equal(app.state.reads, 2);
    }
});

test('ordinary pages, other extensions, invalid pairing and outbound pending navigation are not candidates', async () => {
    for (const patch of [{ url: 'https://ordinary.test/' }, { url: `chrome-extension://${'b'.repeat(32)}/newtab.html` },
        { url: tab.url + '/wrong' }, { pendingUrl: 'https://next.test/' }]) {
        const app = fixture(); assert.equal(await prepareStartupSuggestion(app.browser, { ...tab, ...patch }), null);
        assert.equal(app.state.messages.length, 0);
    }
    const app = fixture(); app.state.peer = '';
    assert.equal(await prepareStartupSuggestion(app.browser, tab), null); assert.equal(app.state.messages.length, 0);
});

test('old companion or mismatched identity never receives startupSuggestion', async () => {
    for (const hello of [{ extensionId: PEER }, { extensionId: PEER, capabilities: 'startupSuggestion' },
        { extensionId: PEER, capabilities: [] }, { extensionId: 'b'.repeat(32), capabilities: ['startupSuggestion'] }]) {
        const app = fixture(); app.state.hello = hello;
        assert.equal(await prepareStartupSuggestion(app.browser, tab), null);
        assert.deepEqual(app.state.messages.map(item => item.request.command), ['hello']);
    }
});

test('revoking or changing pairing during hello invalidates the prepared startup offer', async () => {
    for (const peer of ['', 'b'.repeat(32)]) {
        const app = fixture(); app.state.onSend = () => { app.state.peer = peer; };
        assert.equal(await prepareStartupSuggestion(app.browser, tab), null);
        assert.deepEqual(app.state.messages.map(item => item.request.command), ['hello']);
    }
});

test('revocation after preparation prevents dispatch to the previously paired extension', async () => {
    const app = fixture(); const context = await prepareStartupSuggestion(app.browser, tab);
    app.state.peer = '';
    await assert.rejects(offerStartupSuggestion(app.browser, context), /pairing changed/);
    assert.deepEqual(app.state.messages.map(item => item.request.command), ['hello']);
});

test('startup offer uses a correlated authenticated command with exact tab/window payload', async () => {
    const app = fixture(); const context = await prepareStartupSuggestion(app.browser, tab);
    const response = await offerStartupSuggestion(app.browser, context);
    assert.equal(response.accepted, true);
    const sent = app.state.messages[1];
    assert.equal(sent.peerId, PEER); assert.equal(sent.request.command, 'startupSuggestion');
    assert.equal(sent.request.tabId, 17); assert.equal(sent.request.windowId, 3);
    assert.deepEqual(Object.keys(sent.request).sort(), ['command', 'requestId', 'tabId', 'type', 'version', 'windowId']);
});

test('only a well-formed explicit decline is eligible for fallback', async () => {
    for (const reason of ['user-interaction', 'not-ready', 'not-eligible']) {
        const app = fixture(); app.state.offer = { accepted: false, reason };
        const response = await offerStartupSuggestion(app.browser, { peerId: PEER, tabId: 17, windowId: 3 });
        assert.equal(response.reason, reason);
    }
    for (const offer of [{}, { accepted: false }, { accepted: false, reason: 'unknown' }, { accepted: 'yes' }]) {
        const app = fixture(); app.state.offer = offer;
        await assert.rejects(offerStartupSuggestion(app.browser, { peerId: PEER, tabId: 17, windowId: 3 }));
    }
});

test('wrong version, role, correlation, rejection and transport errors are uncertain outcomes', async () => {
    for (const patch of [{ type: 'wrong' }, { version: 2 }, { requestId: 'wrong' }, { role: 'arcify' }, { ok: false }]) {
        const app = fixture(); app.state.patch = patch;
        await assert.rejects(sendStartupBridgeRequest(app.browser, PEER, 'startupSuggestion', { tabId: 17, windowId: 3 }));
    }
    const app = fixture(); app.browser.runtime.lastError = { message: 'Disconnected' };
    await assert.rejects(sendStartupBridgeRequest(app.browser, PEER, 'startupSuggestion', { tabId: 17, windowId: 3 }));
});

test('startup transport times out rather than waiting indefinitely', async () => {
    const app = fixture(); app.state.noReply = true;
    await assert.rejects(sendStartupBridgeRequest(app.browser, PEER, 'startupSuggestion', { tabId: 17, windowId: 3 }, 1), /timed out/);
});
