import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { installColdSetupObserver, readColdSetupObserver, stopColdSetupObserver, waitForColdSetupQuiescence, COLD_SETUP_QUIET_MS } from '../../scripts/paired-chrome-cold-setup.mjs';
const peerId = 'a'.repeat(32);
function realm(original, kind = 'worker', deferInstall = false) {
    let time = 0;
    const listeners = new Map(), runtimeListeners = new Set();
    const eventTarget = name => ({
        addEventListener(event, listener) { listeners.set(`${name}:${event}`, listener); },
        removeEventListener(event, listener) { if (listeners.get(`${name}:${event}`) === listener) listeners.delete(`${name}:${event}`); }
    });
    const runtime = { sendMessage: original, onMessage: {
        addListener(listener) { runtimeListeners.add(listener); }, removeListener(listener) { runtimeListeners.delete(listener); }
    } };
    let mutation, disconnected = false;
    const context = vm.createContext({ chrome: { runtime }, Date: { now: () => time }, window: eventTarget('window'),
        document: { ...eventTarget('document'), visibilityState: 'visible', hasFocus: () => true,
            activeElement: { matches: () => true }, querySelector: () => ({ dataset: { resultType: 'arcify-sidebar-command' } }),
            querySelectorAll: () => [1] },
        MutationObserver: class { constructor(callback) { mutation = callback; } observe() {} disconnect() { disconnected = true; } }
    });
    const invoke = (fn, value) => vm.runInContext(`(${fn.toString()})(${JSON.stringify(value) ?? ''})`, context);
    const install = () => invoke(installColdSetupObserver, { kind, peerId, windowId: 1 });
    if (!deferInstall) install();
    return { runtime, listeners, runtimeListeners, context, invoke, original, install,
        tick(value) { time = value; }, read: () => invoke(readColdSetupObserver), stop: () => invoke(stopColdSetupObserver),
        mutation: () => mutation(), disconnected: () => disconnected };
}
const message = { type: 'arcify-bridge', command: 'hello', requestId: 'real-request' };
const hello = { type: 'arcify-bridge', version: 1, role: 'arcify', requestId: message.requestId, ok: true, extensionId: peerId };
test('worker observer preserves original callback, receiver, arguments, result and synchronous delivery', () => {
    let called = 0, callbackReceiver, originalReceiver;
    const response = hello, sentinel = {};
    function original(peer, request, callback) {
        called++; originalReceiver = this; assert.equal(peer, peerId); assert.equal(request, message);
        const receiver = {}; callback.call(receiver, response); callbackReceiver = receiver; return sentinel;
    }
    const h = realm(original); let callbackThis, callbackValue;
    assert.equal(h.runtime.sendMessage(peerId, message, function (value) { callbackThis = this; callbackValue = value; }), sentinel);
    assert.equal(called, 1); assert.equal(originalReceiver, h.runtime); assert.equal(callbackThis, callbackReceiver); assert.equal(callbackValue, response);
    assert.equal(h.read().pending.length, 0); assert.deepEqual(Array.from(h.read().events, event => event.phase), ['installed', 'request-start', 'request-complete']);
    assert.equal(h.stop().stopped, true); assert.equal(h.runtime.sendMessage, original);
});
test('observer retains the exact original promise and waits for its real completion', async () => {
    let resolve; const promise = new Promise(done => { resolve = done; });
    const h = realm(() => promise, 'page');
    assert.equal(h.runtime.sendMessage({ action: 'getSpotlightSuggestions', query: '' }), promise);
    assert.equal(h.read().pending.length, 1); resolve({ success: true }); await promise; await Promise.resolve();
    assert.equal(h.read().pending.length, 0); assert.equal(h.read().events.at(-1).action, 'getSpotlightSuggestions'); h.stop();
});
test('rejection and synchronous exceptions are retained without request replay', async () => {
    const error = new Error('original error'); let calls = 0;
    const promise = Promise.reject(error), h = realm(() => { calls++; return promise; }, 'page');
    assert.equal(h.runtime.sendMessage({ action: 'getSpotlightSuggestions' }), promise);
    await assert.rejects(promise, value => value === error); await Promise.resolve();
    assert.equal(h.read().failures.length, 1); assert.equal(calls, 1); h.stop();
    const throwing = realm(() => { throw error; });
    assert.throws(() => throwing.runtime.sendMessage(peerId, message, () => {}), value => value === error);
    assert.equal(throwing.read().failures.length, 1); throwing.stop();
});
test('unrelated delivery is not tracked, manufactured, or rewritten', () => {
    const args = [], sentinel = {};
    const h = realm(function (...values) { args.push(values); return sentinel; });
    const request = { type: 'arcify-sidebar' }, callback = () => {};
    assert.equal(h.runtime.sendMessage(peerId, request, callback), sentinel);
    assert.equal(args.length, 1); assert.equal(args[0][1], request); assert.equal(args[0][2], callback);
    assert.equal(h.read().events.length, 1); h.stop();
});
test('focus, invalidation and real render activity are observed and all listeners/wrappers restored', () => {
    const h = realm(() => Promise.resolve({ success: true }), 'page');
    h.tick(10); h.listeners.get('window:focus')(); h.tick(20); h.mutation();
    h.tick(30); for (const listener of h.runtimeListeners) listener({ action: 'spotlightArcifyResultsChanged', peerId, windowId: 1 });
    assert.equal(h.read().lastActivity, 30);
    assert.deepEqual(Array.from(h.read().events, event => event.phase), ['installed', 'focus', 'render', 'invalidation']);
    h.stop(); assert.equal(h.runtime.sendMessage, h.original); assert.equal(h.listeners.size, 0); assert.equal(h.runtimeListeners.size, 0); assert(h.disconnected());
});
function observation(time, { page = {}, worker = {}, surface = {} } = {}) {
    const base = { now: time, lastActivity: 0, pending: [], failures: [], stopped: false, events: [] };
    return { page: { ...base, kind: 'page', surface: { visible: true, focused: true, inputFocused: true, selected: true, ordinaryResults: 1, ...surface }, ...page },
        worker: { ...base, kind: 'worker', events: [{ phase: 'request-complete', action: 'hello', observedAt: 0, failed: false, validHello: true }], ...worker } };
}
function waitHarness(build, options = {}) {
    let time = 0, reads = 0; const records = [];
    return { records, reads: () => reads, run: () => waitForColdSetupQuiescence(async () => { reads++; return build(time); }, async value => records.push(value),
        { timeout: 1000, interval: 20, quietMs: 100, now: () => time, sleep: async duration => { time += duration; }, ...options }) };
}
test('already-focused helper needs no synthetic focus or extra query; earlier worker hello must finish', async () => {
    const h = waitHarness(time => observation(time, { worker: time < 140 ? { pending: [{ id: 1 }], lastActivity: 100 } : { lastActivity: 140 } }));
    const result = await h.run(); assert.equal(result.worker.now, 240); assert.equal(result.page.events.length, 0);
});
test('observed focus refresh must actually complete, then all event streams become quiet', async () => {
    const h = waitHarness(time => observation(time, { page: {
        events: [{ phase: 'focus', observedAt: 10 }, ...(time >= 160 ? [{ phase: 'request-complete', action: 'getSpotlightSuggestions', observedAt: 160 }] : [])],
        pending: time >= 40 && time < 160 ? [{ id: 2 }] : [], lastActivity: time >= 160 ? 160 : 10
    } }));
    const result = await h.run(); assert.equal(result.page.now, 260); assert.equal(h.records.length, 1);
});
test('an earlier render or request completion cannot satisfy a later focus-triggered refresh', async () => {
    const h = waitHarness(time => observation(time, { page: { events: [
        { phase: 'request-complete', action: 'getSpotlightSuggestions', observedAt: 2 }, { phase: 'focus', observedAt: 10 }, { phase: 'render', observedAt: 20 }
    ] } }));
    await assert.rejects(h.run(), /did not quiesce before the single stop/); assert.equal(h.records.at(-1).phase, 'setup-not-quiescent');
});
test('invalidation or a result mutation resets the quiet interval even with no pending request', async () => {
    const h = waitHarness(time => observation(time, { page: { lastActivity: time < 80 ? 0 : 80 } }));
    const result = await h.run(); assert.equal(result.page.now, 180);
});
for (const [label, change] of [
    ['unresolved request', { worker: { pending: [{ id: 1 }] } }],
    ['missing initial hello completion', { worker: { events: [] } }],
    ['lost selection', { surface: { selected: false } }],
    ['blurred input', { surface: { inputFocused: false } }]
]) test(`${label} fails bounded setup without stopping or replaying anything`, async () => {
    const h = waitHarness(time => observation(time, change)); await assert.rejects(h.run(), /did not quiesce/);
});
test('failed real request and observer loss fail immediately without being treated as quiet', async () => {
    const h = waitHarness(time => observation(time, { page: { failures: [{ error: 'failed callback' }] } }));
    await assert.rejects(h.run(), /Setup request failed/); assert.equal(h.reads(), 1);
    const lost = waitHarness(time => observation(time, { worker: { stopped: true } }));
    await assert.rejects(lost.run(), /stopped observer/); assert.equal(lost.reads(), 1);
});
test('quiet bound derives from existing setup timers and the cold fixture preserves one stop and hard proof order', async () => {
    assert.equal(COLD_SETUP_QUIET_MS, 200 + 100 + 100 + 40);
    const source = await readFile(new URL('../../scripts/paired-chrome-smoke.mjs', import.meta.url), 'utf8');
    const cold = source.split('await step(stepNames[15]')[1].split('await step(stepNames[16]')[0];
    assert(cold.indexOf('setupWorker.evaluate(installColdSetupObserver') < cold.indexOf('helper = await newTabPage'));
    assert(cold.indexOf(`await helper.page.waitForSelector('[data-testid="spotlight-result"]:not(`) < cold.indexOf('helper.page.evaluate(installColdSetupObserver'));
    assert.equal((cold.match(/await terminateObservedWorker\(/g) || []).length, 1);
    assert(cold.indexOf('waitForColdSetupQuiescence') < cold.indexOf('await terminateObservedWorker'));
    assert(cold.indexOf('setupWorker.evaluate(stopColdSetupObserver)') < cold.indexOf('await terminateObservedWorker'));
    assert(cold.indexOf('No Arcify worker may already exist immediately before the cold Enter.') < cold.indexOf("keyboard.press('Enter')"));
    assert(cold.includes('A replacement worker was observed before the real Enter event.'));
    assert(cold.includes('assert.equal(key?.trusted, true); assert.equal(key.focusedInput, true);'));
    assert(cold.includes("captureNativeSidebar(eventCount, 'native-sidebar-opened-after-cold-worker-enter')"));
});
for (const [label, response, lastError] of [
    ['runtime.lastError', undefined, { message: 'Receiving end does not exist.' }],
    ['undefined response', undefined], ['wrong request identity', { ...hello, requestId: 'other' }],
    ['wrong peer identity', { ...hello, extensionId: 'b'.repeat(32) }], ['malformed protocol response', { ok: true }]
]) test(`${label} never counts as a valid completed paired hello`, () => {
    let seenError, seenResponse;
    const h = realm(function (peer, request, callback) {
        this.lastError = lastError; callback(response); delete this.lastError;
    });
    h.runtime.sendMessage(peerId, message, value => { seenResponse = value; seenError = h.runtime.lastError; });
    assert.equal(seenResponse, response); assert.equal(seenError, lastError);
    assert.equal(h.read().pending.length, 0); assert.equal(h.read().failures.length, 1);
    assert.equal(h.read().events.at(-1).validHello, false); h.stop();
});
test('original callback exceptions propagate unchanged and are recorded as failed completion', () => {
    const error = new Error('callback threw'); const h = realm((peer, request, callback) => callback(hello));
    assert.throws(() => h.runtime.sendMessage(peerId, message, () => { throw error; }), value => value === error);
    assert.equal(h.read().failures[0].error, error.message); assert.equal(h.read().pending.length, 0); h.stop();
});
test('missing result surface leaves the original API and all listeners untouched', () => {
    const h = realm(() => {}, 'page', true); h.context.document.querySelector = () => null;
    assert.throws(() => h.install(), /existing result surface/);
    assert.equal(h.runtime.sendMessage, h.original); assert.equal(h.listeners.size, 0); assert.equal(h.runtimeListeners.size, 0);
});
test('observer installation failure transactionally restores the API and earlier listeners', () => {
    const h = realm(() => {}, 'page', true); h.context.MutationObserver = class { constructor() { throw new Error('observer denied'); } };
    assert.throws(() => h.install(), /observer denied/);
    assert.equal(h.runtime.sendMessage, h.original); assert.equal(h.listeners.size, 0); assert.equal(h.runtimeListeners.size, 0);
});
test('restoration must actually recover the original API rather than just assign it', () => {
    const h = realm(() => {}), wrapped = h.runtime.sendMessage;
    Object.defineProperty(h.runtime, 'sendMessage', { get: () => wrapped, set() {} });
    assert.throws(() => h.stop(), /could not be restored/);
});
