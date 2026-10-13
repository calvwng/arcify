import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { BRIDGE_TYPE, BRIDGE_VERSION, isExtensionId, isWindowId, isSafeUrl, trustedSender, validateRequest, responseFor, sendBridgeRequest } from '../../spotlight-bridge-protocol.js';

const PEER = 'a'.repeat(32);
const COMMANDS = ['hello', 'snapshot', 'invalidate', 'activateSpace', 'activateTab', 'openTab', 'navigateTab', 'openBookmark', 'launch', 'startupSuggestion'];
const request = (command, payload = {}) => ({ type: BRIDGE_TYPE, version: BRIDGE_VERSION, requestId: 'valid-request:1.0', windowId: 1, command, ...payload });
const success = message => ({ type: BRIDGE_TYPE, version: BRIDGE_VERSION, requestId: message.requestId, role: 'spotlight', ok: true });
let sent;
beforeEach(() => {
    sent = [];
    globalThis.chrome = { runtime: {
        sendMessage(peerId, message, callback) { sent.push({ peerId, message }); callback(success(message)); }
    } };
});

test('extension and window IDs reject malformed and sentinel values', () => {
    assert.equal(isExtensionId(PEER), true);
    for (const value of ['', 'a'.repeat(31), 'a'.repeat(33), 'q'.repeat(32), 'A'.repeat(32), undefined, null, 123]) assert.equal(isExtensionId(value), false);
    for (const value of [1, 20, Number.MAX_SAFE_INTEGER]) assert.equal(isWindowId(value), true);
    for (const value of [-1, -2, 0, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, '1', null]) assert.equal(isWindowId(value), false);
});

test('trusted sender must be the paired extension and never a website claiming the paired ID', () => {
    for (const sender of [{ id: PEER }, { id: PEER, url: `chrome-extension://${PEER}/popup.html` }, { id: PEER, origin: `chrome-extension://${PEER}` }]) assert.equal(trustedSender(sender, PEER), true);
    for (const sender of [undefined, {}, { id: 'b'.repeat(32) }, { id: PEER, url: 'https://example.test/' }, { id: PEER, url: `chrome-extension://${PEER}.evil.test/` }, { id: PEER, origin: 'null' }, { id: PEER, origin: `chrome-extension://${'b'.repeat(32)}` }]) assert.equal(trustedSender(sender, PEER), false);
    assert.equal(trustedSender({ id: PEER }, undefined), false);
});

test('navigation URLs have an explicit scheme allowlist and size bound', () => {
    for (const url of ['https://example.test/path?q=1', 'http://localhost:3000/', 'file:///tmp/example.txt', 'chrome://newtab/', 'about:blank']) assert.equal(isSafeUrl(url), true, url);
    for (const url of ['javascript:alert(1)', 'data:text/html,evil', 'chrome-extension://other/private.html', 'about:config', 'ftp://example.test/', 'mailto:person@example.test', '/relative', '', null, 123, `https://example.test/${'x'.repeat(16384)}`]) assert.equal(isSafeUrl(url), false, String(url));
});

test('all protocol commands accept only their documented payloads', () => {
    const examples = [
        request('hello'), request('snapshot'), request('invalidate'), request('activateSpace', { spaceId: 'space-a' }),
        request('activateTab', { tabId: 42 }), request('openTab', { url: 'https://example.test/' }),
        request('openTab', { url: 'https://example.test/', spaceId: 'space-a' }),
        request('navigateTab', { tabId: 42, url: 'https://example.test/' }),
        request('openBookmark', { spaceId: 'space-a', bookmarkId: 'bookmark-1' }),
        request('launch', { mode: 'new-tab' }), request('launch', { mode: 'current-tab' }),
        request('startupSuggestion', { tabId: 42 })
    ];
    for (const example of examples) assert.equal(validateRequest(example, COMMANDS), example);
});

test('protocol rejects wrong envelope, unsupported version and illegal command', () => {
    for (const value of [null, [], 'snapshot', {}, request('snapshot', { type: 'other' })]) assert.throws(() => validateRequest(value, COMMANDS), { code: 'INVALID_REQUEST' });
    for (const version of [undefined, null, 0, 2, '1']) assert.throws(() => validateRequest(request('snapshot', { version }), COMMANDS), { code: 'VERSION_MISMATCH' });
    assert.throws(() => validateRequest(request('unknown'), COMMANDS), { code: 'INVALID_REQUEST' });
    assert.throws(() => validateRequest(request('launch', { mode: 'new-tab' }), ['snapshot']), { code: 'INVALID_REQUEST' });
});

test('protocol rejects malformed request IDs, windows, payloads and surplus fields', () => {
    const malformed = [
        ...['', 'has space', 'slash/id', 'x'.repeat(81), 123, null].map(requestId => request('snapshot', { requestId })),
        ...[0, -1, 1.2, '1', null].map(windowId => request('snapshot', { windowId })),
        request('snapshot', { url: 'https://example.test/' }), request('hello', { nested: {} }),
        request('invalidate', { windowId: 0 }), request('invalidate', { snapshot: {} }),
        request('invalidate', { spaceId: 'space-a' }), request('invalidate', { tabId: 42 }),
        request('activateSpace'), request('activateSpace', { spaceId: '' }), request('activateSpace', { spaceId: 'x'.repeat(201) }),
        request('activateTab', { tabId: '1' }), request('activateTab', { tabId: 0 }),
        request('openTab'), request('openTab', { url: 'https://example.test/', spaceId: null }),
        request('openTab', { url: 'javascript:alert(1)' }), request('openTab', { url: 'https://example.test/', bookmarkId: 'not-allowed' }),
        request('navigateTab', { tabId: 1 }), request('navigateTab', { tabId: 1, url: 'data:text/plain,evil' }),
        request('openBookmark', { spaceId: 'a' }), request('openBookmark', { spaceId: 'a', bookmarkId: '' }),
        request('openBookmark', { spaceId: 'a', bookmarkId: 'b', url: 'https://example.test/' }),
        request('launch'), request('launch', { mode: 'popup' }),
        request('startupSuggestion'), request('startupSuggestion', { tabId: 0 }),
        request('startupSuggestion', { tabId: '42' }), request('startupSuggestion', { tabId: 42, mode: 'new-tab' })
    ];
    for (const message of malformed) assert.throws(() => validateRequest(message, COMMANDS), { code: 'INVALID_REQUEST' }, JSON.stringify(message));
});

test('responses identify their protocol, role and corresponding request', () => {
    assert.deepEqual(responseFor(request('snapshot'), 'arcify', { ok: true, value: 1 }), {
        type: BRIDGE_TYPE, version: BRIDGE_VERSION, requestId: 'valid-request:1.0', role: 'arcify', ok: true, value: 1
    });
    assert.equal(responseFor(undefined, 'arcify', { ok: false }).requestId, undefined);
});

test('outbound bridge requests target only the configured peer and use unique request IDs', async () => {
    const first = await sendBridgeRequest(PEER, 'hello', { windowId: 1 });
    const second = await sendBridgeRequest(PEER, 'hello', { windowId: 2 });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.notEqual(first.requestId, second.requestId);
    assert.deepEqual(sent.map(item => [item.peerId, item.message.command, item.message.windowId]), [[PEER, 'hello', 1], [PEER, 'hello', 2]]);
    assert(sent.every(item => item.message.type === BRIDGE_TYPE && item.message.version === BRIDGE_VERSION));
});

test('outbound requests fail locally without a valid paired extension ID', async () => {
    await assert.rejects(sendBridgeRequest('not-an-extension', 'hello', { windowId: 1 }), { code: 'NOT_CONFIGURED' });
    assert.deepEqual(sent, []);
});

test('runtime connection errors become actionable unavailable responses', async () => {
    chrome.runtime.sendMessage = (peer, message, callback) => {
        chrome.runtime.lastError = { message: 'Receiving end does not exist' };
        callback(undefined);
        delete chrome.runtime.lastError;
    };
    await assert.rejects(sendBridgeRequest(PEER, 'hello', { windowId: 1 }), { code: 'UNAVAILABLE' });
});

test('outbound responses reject version mismatches and uncorrelated or wrong-role envelopes', async () => {
    chrome.runtime.sendMessage = (peer, message, callback) => callback({ ...success(message), version: 2 });
    await assert.rejects(sendBridgeRequest(PEER, 'hello', { windowId: 1 }), { code: 'VERSION_MISMATCH' });
    for (const fields of [{ type: 'other' }, { requestId: 'different-request' }, { role: 'arcify' }, { ok: 'true' }]) {
        chrome.runtime.sendMessage = (peer, message, callback) => callback({ ...success(message), ...fields });
        await assert.rejects(sendBridgeRequest(PEER, 'hello', { windowId: 1 }), { code: 'INVALID_RESPONSE' });
    }
});

test('outbound transport supports explicit expected role and propagates peer errors', async () => {
    chrome.runtime.sendMessage = (peer, message, callback) => callback({ ...success(message), role: 'arcify' });
    assert.equal((await sendBridgeRequest(PEER, 'snapshot', { windowId: 1 }, { role: 'arcify' })).ok, true);
    chrome.runtime.sendMessage = (peer, message, callback) => callback({ ...success(message), ok: false, error: { code: 'STALE_TAB', message: 'Tab moved' } });
    await assert.rejects(sendBridgeRequest(PEER, 'hello', { windowId: 1 }), { code: 'STALE_TAB', message: 'Tab moved' });
    chrome.runtime.sendMessage = (peer, message, callback) => callback({ ...success(message), ok: false });
    await assert.rejects(sendBridgeRequest(PEER, 'hello', { windowId: 1 }), { code: 'FAILED' });
});

test('timed-out mutations are not retried automatically and late responses cannot change the outcome', async () => {
    let lateCallback, outgoing;
    chrome.runtime.sendMessage = (peer, message, callback) => { sent.push({ peerId: peer, message }); outgoing = message; lateCallback = callback; };
    const result = sendBridgeRequest(PEER, 'openTab', { windowId: 1, url: 'https://example.test/' }, { timeout: 5 });
    await assert.rejects(result, { code: 'TIMEOUT' });
    lateCallback(success(outgoing));
    await assert.rejects(result, { code: 'TIMEOUT' });
    assert.equal(sent.length, 1);
});
