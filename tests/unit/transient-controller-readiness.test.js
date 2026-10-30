import test from 'node:test';
import assert from 'node:assert/strict';
import { observeInitialTransientController, TRANSIENT_CONTROLLER_READY_TIMEOUT_MS as TIMEOUT } from '../../transient-controller-readiness.js';
const MARKER = 'chrome-extension://own/transient-window.html?token=11111111-1111-4111-8111-111111111111';
const clone = value => structuredClone(value);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const event = () => {
    const listeners = new Set();
    return { addListener: listener => listeners.add(listener), removeListener: listener => listeners.delete(listener),
        emit: (...args) => [...listeners].forEach(listener => listener(...args)), count: () => listeners.size };
};
function fixture(initial = {}) {
    let tab = { id: 100, windowId: 20, status: 'loading', url: '', pendingUrl: MARKER, pinned: false, incognito: false, splitViewId: -1, ...initial };
    const calls = [], api = { tabs: { onUpdated: event(), onRemoved: event(), onAttached: event(), onDetached: event(), onReplaced: event(),
        get: async id => { calls.push(id); return clone(tab); } }, windows: { onRemoved: event() } };
    const options = { api, controller: clone(tab), windowId: 20, originWindowId: 10, marker: MARKER };
    return { api, calls, options, get tab() { return tab; },
        update: update => { Object.assign(tab, update); api.tabs.onUpdated.emit(100, clone(update), clone(tab)); },
        commit: () => { Object.assign(tab, { url: MARKER, pendingUrl: '', status: 'loading' }); api.tabs.onUpdated.emit(100, { url: MARKER, status: 'loading' }, clone(tab)); },
        finish: () => { Object.assign(tab, { url: MARKER, pendingUrl: '', status: 'complete' }); api.tabs.onUpdated.emit(100, { status: 'complete' }, clone(tab)); },
        assertClean: () => { for (const area of [api.tabs, api.windows]) for (const value of Object.values(area)) if (value?.count) assert.equal(value.count(), 0); }
    };
}
test('accepts one initial exact-marker commit and completion, never a mere loading marker', async () => {
    const f = fixture(), watcher = observeInitialTransientController(f.options);
    let ready = false;
    const waiting = watcher.wait().then(() => { ready = true; });
    await Promise.resolve(); f.commit(); await Promise.resolve(); assert.equal(ready, false);
    f.finish(); await waiting; assert.equal(ready, true); assert.deepEqual(f.calls, [100, 100]);
    watcher.assert(); watcher.stop(); f.assertClean();
});
test('accepts readiness that completed during journal before wait, using a fresh exact read', async () => {
    const f = fixture(), watcher = observeInitialTransientController(f.options);
    f.commit(); f.finish(); await watcher.wait(); assert.deepEqual(f.calls, [100]);
    watcher.stop(); f.assertClean();
});
test('completion during a held read cannot be lost or replaced by its stale loading snapshot', async () => {
    const f = fixture(), watcher = observeInitialTransientController(f.options), held = deferred();
    const original = f.api.tabs.get, stale = clone(f.tab); let reads = 0;
    f.api.tabs.get = async id => ++reads === 1 ? held.promise : original(id);
    const waiting = watcher.wait(); f.commit(); f.finish(); held.resolve(stale);
    await waiting; assert.equal(reads, 2); watcher.stop(); f.assertClean();
});
for (const [name, mutate] of [
    ['away and back', f => { f.update({ url: 'https://elsewhere.test/' }); f.commit(); f.finish(); }],
    ['foreign pending navigation', f => f.update({ pendingUrl: 'https://elsewhere.test/' })],
    ['wrong marker token', f => f.update({ url: `${MARKER}x` })],
    ['removed controller', f => f.api.tabs.onRemoved.emit(100)],
    ['detached controller', f => f.api.tabs.onDetached.emit(100)],
    ['attached controller', f => f.api.tabs.onAttached.emit(100)],
    ['replacement removes controller', f => f.api.tabs.onReplaced.emit(101, 100)],
    ['replacement adds controller', f => f.api.tabs.onReplaced.emit(100, 99)],
    ['origin removed', f => f.api.windows.onRemoved.emit(10)],
    ['controller window removed', f => f.api.windows.onRemoved.emit(20)],
    ['pin update', f => f.update({ pinned: false })],
    ['split update', f => f.update({ splitViewId: -1 })],
    ['incognito update', f => f.update({ incognito: false })],
    ['window update', f => f.update({ windowId: 20 })],
    ['malformed update', f => f.api.tabs.onUpdated.emit(100, null)],
    ['unloaded', f => f.update({ status: 'unloaded' })],
    ['duplicate loading', f => { f.update({ status: 'loading' }); f.update({ status: 'loading' }); }],
    ['reload after commit', f => { f.commit(); f.update({ status: 'loading' }); }],
    ['duplicate marker commit', f => { f.commit(); f.commit(); }],
    ['pending after commit', f => { f.commit(); f.update({ pendingUrl: MARKER }); }],
    ['reload after completion', f => { f.commit(); f.finish(); f.update({ status: 'loading' }); }],
    ['same marker after completion', f => { f.commit(); f.finish(); f.update({ url: MARKER }); }],
    ['wrong native event identity', f => f.api.tabs.onUpdated.emit(100, { status: 'complete' }, { ...f.tab, id: 101, status: 'complete', url: MARKER, pendingUrl: '' })]
]) test(`initial readiness latches ${name} even if later native snapshot looks safe`, async () => {
    const f = fixture(), watcher = observeInitialTransientController(f.options);
    mutate(f); Object.assign(f.tab, { url: MARKER, pendingUrl: '', status: 'complete' });
    await assert.rejects(watcher.wait(), { code: 'STALE_TRANSIENT' });
    assert.throws(watcher.assert, { code: 'STALE_TRANSIENT' }); watcher.stop(); f.assertClean();
});
for (const initial of [{ status: undefined }, { pinned: true }, { incognito: true }, { splitViewId: 0 },
    { url: 'https://elsewhere.test/' }, { url: MARKER, status: 'complete' }]) test('invalid initial native evidence fails before waiting or subscribing', () => {
    const f = fixture(initial);
    assert.throws(() => observeInitialTransientController(f.options)); f.assertClean();
});
for (const key of ['onUpdated', 'onRemoved', 'onAttached', 'onDetached', 'onReplaced']) test(`missing ${key} cannot create a partial readiness fence`, () => {
    const f = fixture(); delete f.api.tabs[key]; assert.throws(() => observeInitialTransientController(f.options)); f.assertClean();
});
test('timeout is terminal even when held read resolves complete afterwards', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture(), held = deferred(); f.api.tabs.get = () => held.promise;
    const watcher = observeInitialTransientController(f.options), waiting = watcher.wait();
    t.mock.timers.tick(TIMEOUT);
    await assert.rejects(waiting, { code: 'TRANSIENT_CONTROLLER_TIMEOUT' });
    watcher.stop(); f.assertClean(); held.resolve({ ...f.tab, status: 'complete', url: MARKER, pendingUrl: '' });
    await Promise.resolve(); assert.throws(watcher.assert, { code: 'TRANSIENT_CONTROLLER_TIMEOUT' });
});
test('successful readiness clears timeout but remains fenced until explicit synchronous handoff', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture({ status: 'complete', url: MARKER, pendingUrl: '' }), watcher = observeInitialTransientController(f.options);
    await watcher.wait(); t.mock.timers.tick(TIMEOUT * 2); watcher.assert();
    f.update({ url: MARKER }); assert.throws(watcher.assert, { code: 'STALE_TRANSIENT' });
    watcher.stop(); f.assertClean();
});
test('unrelated updates neither settle nor invalidate exact controller readiness', async () => {
    const f = fixture(), watcher = observeInitialTransientController(f.options);
    f.api.tabs.onUpdated.emit(101, { url: 'https://elsewhere.test/' }); f.api.tabs.onRemoved.emit(101); f.api.windows.onRemoved.emit(30);
    f.commit(); f.finish(); await watcher.wait(); watcher.stop(); f.assertClean();
});
test('complete creation receipt cannot reopen readiness for a later loading snapshot', async () => {
    const f = fixture({ url: MARKER, pendingUrl: '', status: 'complete' }), watcher = observeInitialTransientController(f.options);
    f.tab.status = 'loading';
    await assert.rejects(watcher.wait(), { code: 'STALE_TRANSIENT' });
    f.finish(); watcher.stop(); f.assertClean();
});
test('a benign event during a post-completion loading read cannot disguise a new load as a stale startup read', async () => {
    const f = fixture({ url: MARKER, pendingUrl: '', status: 'complete' }), watcher = observeInitialTransientController(f.options), held = deferred();
    f.api.tabs.get = () => held.promise;
    const waiting = watcher.wait(); f.api.tabs.onUpdated.emit(100, { title: 'Controller' });
    held.resolve({ ...f.tab, status: 'loading' });
    await assert.rejects(waiting, { code: 'STALE_TRANSIENT' }); watcher.stop(); f.assertClean();
});
test('a benign event cannot disguise blank/pending regression after an already committed receipt', async () => {
    const f = fixture({ url: MARKER, pendingUrl: '', status: 'loading' }), watcher = observeInitialTransientController(f.options), held = deferred();
    f.api.tabs.get = () => held.promise;
    const waiting = watcher.wait(); f.api.tabs.onUpdated.emit(100, { title: 'Controller' });
    held.resolve({ ...f.tab, url: 'about:blank', pendingUrl: MARKER });
    await assert.rejects(waiting, { code: 'STALE_TRANSIENT' }); f.finish(); watcher.stop(); f.assertClean();
});
test('stopping after an earlier rejection clears the deadline without later diagnostic invalidation', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture(), events = [];
    f.options.diagnostic = { fence: (...args) => events.push(args), controller() {} };
    const watcher = observeInitialTransientController(f.options);
    f.api.tabs.onRemoved.emit(100); await assert.rejects(watcher.wait()); watcher.stop();
    assert.equal(events.length, 1); t.mock.timers.tick(TIMEOUT * 2); assert.equal(events.length, 1); f.assertClean();
});
for (const update of [{ pendingUrl: MARKER }, { status: 'loading' }]) test('an already committed/loading receipt rejects a new provisional or status-only load', async () => {
    const f = fixture({ url: MARKER, pendingUrl: '', status: 'loading' }), watcher = observeInitialTransientController(f.options);
    f.update(update); f.finish();
    await assert.rejects(watcher.wait(), { code: 'STALE_TRANSIENT' }); watcher.stop(); f.assertClean();
});
test('an already committed/loading receipt rejects a later marker event rather than guessing delayed commit versus reload', async () => {
    const f = fixture({ url: MARKER, pendingUrl: '', status: 'loading' }), watcher = observeInitialTransientController(f.options);
    f.commit(); f.finish(); await assert.rejects(watcher.wait(), { code: 'STALE_TRANSIENT' }); watcher.stop(); f.assertClean();
});
for (const update of [{ url: MARKER }, { url: MARKER, status: 'loading' }, { pendingUrl: MARKER }, { status: 'loading' }]) test('a fresh committed read also closes the initial navigation allowance permanently', async () => {
    const f = fixture(), watcher = observeInitialTransientController(f.options), readStarted = deferred();
    const get = f.api.tabs.get;
    Object.assign(f.tab, { url: MARKER, pendingUrl: '', status: 'loading' });
    f.api.tabs.get = async id => { const result = await get(id); queueMicrotask(readStarted.resolve); return result; };
    const waiting = watcher.wait();
    await readStarted.promise; await Promise.resolve(); f.update(update); f.finish();
    await assert.rejects(waiting, { code: 'STALE_TRANSIENT' }); watcher.stop(); f.assertClean();
});
test('an already committed/loading controller may only finish without further navigation', async () => {
    const f = fixture({ url: MARKER, pendingUrl: '', status: 'loading' }), watcher = observeInitialTransientController(f.options);
    f.api.tabs.onUpdated.emit(100, { title: 'Controller' }, clone(f.tab)); f.finish();
    await watcher.wait(); watcher.stop(); f.assertClean();
});
test('committed marker plus a pending marker is a new navigation, even in a loading creation receipt', () => {
    const f = fixture({ url: MARKER, pendingUrl: MARKER, status: 'loading' });
    assert.throws(() => observeInitialTransientController(f.options), { code: 'STALE_TRANSIENT' }); f.assertClean();
});
test('a fresh read cannot turn committed marker plus pending marker into accepted initial readiness', async () => {
    const f = fixture(), watcher = observeInitialTransientController(f.options);
    Object.assign(f.tab, { url: MARKER, pendingUrl: MARKER, status: 'loading' });
    await assert.rejects(watcher.wait(), { code: 'STALE_TRANSIENT' }); f.finish(); watcher.stop(); f.assertClean();
});
