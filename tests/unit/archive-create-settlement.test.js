import test from 'node:test';
import assert from 'node:assert/strict';
import {
    observeArchiveCreate,
    ARCHIVE_CREATE_SETTLE_TIMEOUT_MS,
    ARCHIVE_CREATE_EVENT_LIMIT
} from '../../archive-create-settlement.js';

const clone = value => structuredClone(value);
const URL = 'https://archive.test/page?entry=1#saved';
const request = () => ({
    windowId: 10,
    context: { sourceTabId: 1, sourceSpaceId: 'source' },
    expected: { entryId: 'entry-1', url: URL, spaceId: 'destination' }
});
const settled = (extra = {}) => ({
    id: 100, windowId: 10, active: false, pinned: false, incognito: false,
    splitViewId: -1, url: URL, status: 'complete', ...extra
});
const pending = (extra = {}) => settled({ url: '', pendingUrl: URL, status: 'loading', ...extra });
const loading = (extra = {}) => settled({ status: 'loading', ...extra });
const stale = { code: 'STALE_ARCHIVE' };
const timeout = { code: 'ARCHIVE_LOAD_TIMEOUT' };

function eventBus() {
    const listeners = new Set();
    let removals = 0;
    return {
        addListener(fn) { listeners.add(fn); },
        removeListener(fn) { removals++; listeners.delete(fn); },
        emit(...args) { for (const fn of [...listeners]) fn(...args); },
        get size() { return listeners.size; },
        get removals() { return removals; }
    };
}
function manualClock() {
    let next = 1;
    const tasks = new Map(), scheduled = [], cancelled = [];
    return {
        scheduled, cancelled,
        schedule(callback, delay) {
            const id = next++;
            tasks.set(id, callback); scheduled.push({ id, delay }); return id;
        },
        cancel(id) { cancelled.push(id); tasks.delete(id); },
        fire(id = scheduled.at(-1)?.id) {
            const callback = tasks.get(id);
            if (!callback) return false;
            tasks.delete(id); callback(); return true;
        },
        get size() { return tasks.size; }
    };
}
function environment() {
    const api = {
        tabs: Object.fromEntries(['onCreated', 'onUpdated', 'onRemoved', 'onAttached', 'onDetached', 'onMoved', 'onReplaced', 'onActivated'].map(name => [name, eventBus()])),
        windows: { onRemoved: eventBus() },
        bookmarks: Object.fromEntries(['onChanged', 'onMoved', 'onRemoved', 'onCreated'].map(name => [name, eventBus()])),
        storage: { onChanged: eventBus() }
    };
    return { api, clock: manualClock(), buses: Object.values(api).flatMap(group => Object.values(group)) };
}
function emitInitial(api, id = 100) {
    api.tabs.onCreated.emit(pending({ id }));
    api.tabs.onUpdated.emit(id, { status: 'loading', url: URL });
    api.tabs.onUpdated.emit(id, { status: 'complete' });
}
function fixture(t, options = {}) {
    const env = environment(), req = request();
    const observer = observeArchiveCreate(req, { api: env.api, schedule: env.clock.schedule, cancel: env.clock.cancel, ...options });
    t.after(() => {
        observer.stop();
        assert.equal(env.clock.size, 0, 'no scheduled timeout survives cleanup');
        for (const bus of env.buses) assert.equal(bus.size, 0, 'all observation listeners are removed');
    });
    return {
        ...env, req, observer,
        create(tab = settled()) {
            if (tab.status === 'complete') emitInitial(env.api, tab.id);
            else env.api.tabs.onCreated.emit(tab);
            observer.bind(clone(tab));
        },
        update(change, id = 100) { env.api.tabs.onUpdated.emit(id, change); },
        storage(key, oldValue, newValue, area = 'local') { env.api.storage.onChanged.emit({ [key]: { oldValue, newValue } }, area); }
    };
}
const tick = () => Promise.resolve();
function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

// These observations attest one fresh native ID and its initial URL/inactive
// lifecycle. A status/title event does not attest a page-document identity.
test('pre-bind pending creation, initial loading, title and completion replay in exact order', async t => {
    const f = fixture(t);
    const created = pending();
    f.api.tabs.onCreated.emit(created);
    created.pendingUrl = 'https://mutated-event-object.test/';
    const change = { status: 'loading', url: URL };
    f.update(change);
    change.url = 'https://mutated-change-object.test/';
    f.update({ title: 'Archived title', favIconUrl: 'https://archive.test/favicon.ico' });
    f.update({ status: 'complete', title: 'Loaded title' });
    f.observer.bind(settled());
    await f.observer.wait();
    f.observer.verify(settled());
    assert.equal(f.clock.size, 0);
    assert.equal(f.clock.scheduled[0].delay, ARCHIVE_CREATE_SETTLE_TIMEOUT_MS);
    assert(f.buses.every(bus => bus.size === 1), 'listeners remain live through final verification and own writes');
});

test('initial navigation can cross separate awaits before and after binding', async t => {
    const f = fixture(t);
    f.api.tabs.onCreated.emit(pending());
    await tick();
    f.update({ title: 'Loading title' });
    f.observer.bind(pending());
    let finished = false;
    const waiting = f.observer.wait().then(() => { finished = true; });
    await tick();
    assert.equal(finished, false);
    f.update({ status: 'loading', url: URL });
    await tick();
    f.update({ favIconUrl: 'https://archive.test/icon.png' });
    await tick();
    assert.equal(finished, false);
    f.update({ status: 'complete' });
    await waiting;
    f.observer.verify(settled());
    assert.equal(finished, true);
});

for (const returned of [pending(), loading({ pendingUrl: URL }), loading(), settled()]) {
    test(`a returned ${returned.status}/${returned.url ? 'requested' : 'empty'} snapshot binds only to the exact observed initial sequence${returned.pendingUrl ? ' with pending URL' : ''}`, async t => {
        const f = fixture(t);
        f.api.tabs.onCreated.emit(pending());
        f.observer.bind(returned);
        f.update({ status: 'loading', url: URL });
        f.update({ status: 'complete' });
        await f.observer.wait();
        f.observer.verify(settled());
    });
}

test('already-complete creation cannot substitute for the initial pending/loading sequence', async t => {
    const f = fixture(t);
    f.api.tabs.onCreated.emit(settled());
    f.observer.bind(settled());
    await assert.rejects(f.observer.wait(), stale);
    assert.throws(() => f.observer.verify(settled()), stale);
});

test('presentation-only updates after initial completion preserve the proven native identity', async t => {
    const f = fixture(t);
    f.create();
    await f.observer.wait();
    f.update({ title: 'Presentation only' });
    f.update({ favIconUrl: 'https://archive.test/icon.ico', status: 'complete' });
    f.observer.verify(settled({ title: 'Presentation only', splitViewId: undefined, groupId: undefined }));
});

test('unrelated native tabs and other windows do not invalidate exact creation', async t => {
    const f = fixture(t);
    f.api.tabs.onCreated.emit(settled({ id: 200 }));
    f.api.tabs.onUpdated.emit(200, { url: 'https://elsewhere.test/' });
    f.api.tabs.onRemoved.emit(200, { windowId: 10 });
    f.create();
    f.api.tabs.onAttached.emit(200, { newWindowId: 10 });
    f.api.tabs.onDetached.emit(200, { oldWindowId: 10 });
    f.api.tabs.onMoved.emit(200, { windowId: 10 });
    f.api.tabs.onReplaced.emit(201, 200);
    f.api.tabs.onActivated.emit({ tabId: 200, windowId: 20 });
    f.api.windows.onRemoved.emit(20);
    await f.observer.wait();
    f.observer.verify(settled());
});

const rejectedUpdates = [
    ['redirect during pending', { status: 'loading', url: 'https://redirect.test/' }, 'pending'],
    ['complete before initial URL transition', { status: 'complete' }, 'pending'],
    ['initial URL without loading', { url: URL }, 'pending'],
    ['loading without initial URL', { status: 'loading' }, 'pending'],
    ['initial URL transition with extra fields', { status: 'loading', url: URL, title: 'Unexpected combined change' }, 'pending'],
    ['repeated same-URL loading', { status: 'loading', url: URL }, 'loading'],
    ['same-URL navigation after completion', { status: 'loading', url: URL }, 'complete'],
    ['redirect after completion', { url: 'https://redirect.test/' }, 'complete'],
    ['URL-only same-URL event', { url: URL }, 'complete'],
    ['reload without a URL', { status: 'loading' }, 'complete'],
    ['empty change', {}, 'complete'],
    ['invalid title', { title: null }, 'complete'],
    ['invalid favicon', { favIconUrl: false }, 'complete'],
    ['unknown status', { status: 'unloaded' }, 'complete'],
    ['pinning', { pinned: true }, 'complete'],
    ['unpinning', { pinned: false }, 'complete'],
    ['native split join', { splitViewId: 7 }, 'complete'],
    ['native split leave', { splitViewId: -1 }, 'complete'],
    ['native group join', { groupId: 9 }, 'complete'],
    ['native group leave', { groupId: -1 }, 'complete'],
    ['activation-shaped update', { active: true }, 'complete'],
    ['pending URL', { pendingUrl: URL }, 'complete'],
    ['unrecognized property', { discarded: true }, 'complete']
];
for (const [name, change, phase] of rejectedUpdates) test(`${name} permanently invalidates initial settlement`, async t => {
    const f = fixture(t);
    f.create(phase === 'complete' ? settled() : pending());
    if (phase === 'loading') f.update({ status: 'loading', url: URL });
    f.update(change);
    f.update({ status: 'complete', title: 'Restored appearance' });
    assert.throws(() => f.observer.verify(settled()), stale);
    await assert.rejects(f.observer.wait(), stale);
});

test('a rejected loading transition wakes a currently pending wait without a timer', async t => {
    const f = fixture(t);
    f.create(pending());
    const waiting = assert.rejects(f.observer.wait(), stale);
    await tick();
    f.update({ status: 'loading', url: 'https://redirect.test/' });
    await waiting;
});

const nativeInvalidations = [
    ['remove created tab', api => api.tabs.onRemoved.emit(100, { windowId: 10 })],
    ['attach created tab', api => api.tabs.onAttached.emit(100, { newWindowId: 20 })],
    ['detach created tab', api => api.tabs.onDetached.emit(100, { oldWindowId: 10 })],
    ['move created tab', api => api.tabs.onMoved.emit(100, { windowId: 10, fromIndex: 1, toIndex: 2 })],
    ['replace created tab', api => api.tabs.onReplaced.emit(101, 100)],
    ['created tab is replacement', api => api.tabs.onReplaced.emit(100, 99)],
    ['activate created tab', api => api.tabs.onActivated.emit({ tabId: 100, windowId: 10 })],
    ['activate another tab in source window', api => api.tabs.onActivated.emit({ tabId: 200, windowId: 10 })],
    ['reactivate source tab', api => api.tabs.onActivated.emit({ tabId: 1, windowId: 10 })],
    ['close source window', api => api.windows.onRemoved.emit(10)],
    ['source title update', api => api.tabs.onUpdated.emit(1, { title: 'Changed source' })],
    ['source favicon update', api => api.tabs.onUpdated.emit(1, { favIconUrl: 'https://source.test/icon.ico' })],
    ['source navigation', api => api.tabs.onUpdated.emit(1, { url: 'https://changed-source.test/' })],
    ['source loading', api => api.tabs.onUpdated.emit(1, { status: 'loading' })],
    ['source removal', api => api.tabs.onRemoved.emit(1, { windowId: 10 })],
    ['source attach', api => api.tabs.onAttached.emit(1, { newWindowId: 20 })],
    ['source detach', api => api.tabs.onDetached.emit(1, { oldWindowId: 10 })],
    ['source move', api => api.tabs.onMoved.emit(1, { windowId: 10 })],
    ['source replacement', api => api.tabs.onReplaced.emit(2, 1)],
    ['source becomes replacement', api => api.tabs.onReplaced.emit(1, 2)],
    ['source ID creation', api => api.tabs.onCreated.emit(settled({ id: 1 }))]
];
for (const [name, invalidate] of nativeInvalidations) {
    for (const when of ['before bind', 'during loading', 'after wait']) test(`${name} ${when} is sticky even if the final tab looks restored`, async t => {
        const f = fixture(t);
        if (when === 'before bind') {
            invalidate(f.api);
            f.create();
        } else if (when === 'during loading') {
            f.create(pending());
            const waiting = assert.rejects(f.observer.wait(), stale);
            invalidate(f.api);
            await waiting;
        } else {
            f.create();
            await f.observer.wait();
            invalidate(f.api);
        }
        assert.throws(() => f.observer.verify(settled()), stale);
        await assert.rejects(f.observer.wait(), stale);
    });
}

for (const name of ['onChanged', 'onMoved', 'onRemoved', 'onCreated']) test(`bookmark ${name} invalidates observation even if a matching bookmark is restored`, async t => {
    const f = fixture(t);
    f.create();
    await f.observer.wait();
    f.api.bookmarks[name].emit('destination-folder', { title: 'Changed', parentId: 'other-root' });
    f.api.bookmarks.onChanged.emit('destination-folder', { title: 'Original', parentId: 'root' });
    assert.throws(() => f.observer.verify(settled()), stale);
});

const observedStorage = {
    local: ['archivedTabs', 'spaces', 'pinnedTabStatesById', 'persistentFavorites', 'arcifyBridgePeerId', 'arcifyBridgePairingGeneration'],
    session: ['activeSpaces', 'favoriteSession', 'archiveBrowserSession']
};
for (const [area, keys] of Object.entries(observedStorage)) for (const key of keys) {
    test(`${area}.${key} change remains invalid after restoring its original value`, async t => {
        const f = fixture(t);
        f.create();
        await f.observer.wait();
        f.storage(key, { original: true }, { changed: true }, area);
        f.storage(key, { changed: true }, { original: true }, area);
        assert.throws(() => f.observer.verify(settled()), stale);
    });
    test(`${area}.${key} semantic no-op with reordered object keys is harmless`, async t => {
        const f = fixture(t);
        f.create();
        f.storage(key, { a: 1, nested: { b: 2, c: [3, 4] } }, { nested: { c: [3, 4], b: 2 }, a: 1 }, area);
        await f.observer.wait();
        f.observer.verify(settled());
    });
}

test('unwatched storage keys and storage areas are ignored', async t => {
    const f = fixture(t);
    f.create();
    f.storage('unrelatedPreference', false, true);
    f.storage('archiveReopenClaims', {}, { receipt: 'own progress' });
    f.storage('spaces', ['before'], ['after'], 'sync');
    f.storage('spaces', ['before'], ['after'], 'session');
    f.storage('activeSpaces', { 10: 'source' }, { 10: 'other' }, 'local');
    await f.observer.wait();
    f.observer.verify(settled());
});

test('even exact own spaces/archive writes invalidate before the authority handoff', async t => {
    const f = fixture(t);
    f.create();
    await f.observer.wait();
    f.api.storage.onChanged.emit({
        spaces: { oldValue: [{ id: 'destination', temporaryTabs: [] }], newValue: [{ id: 'destination', temporaryTabs: [100] }] },
        archivedTabs: { oldValue: [{ entryId: 'entry-1' }], newValue: [] }
    }, 'local');
    assert.throws(() => f.observer.verify(settled()), stale);
    assert.throws(() => f.observer.handoffAuthority(), stale);
});

test('authority handoff removes only bookmark/storage listeners and leaves native observation live', async t => {
    const f = fixture(t);
    f.create();
    await f.observer.wait();
    f.observer.verify(settled());
    f.observer.handoffAuthority();
    assert.equal(f.api.storage.onChanged.size, 0);
    assert(Object.values(f.api.bookmarks).every(bus => bus.size === 0));
    assert(Object.values(f.api.tabs).every(bus => bus.size === 1));
    assert.equal(f.api.windows.onRemoved.size, 1);
    for (const [area, keys] of Object.entries(observedStorage)) for (const key of keys) f.storage(key, 'before', 'after', area);
    for (const bus of Object.values(f.api.bookmarks)) bus.emit('destination-folder', { title: 'Changed' });
    f.observer.verify(settled());
    f.observer.handoffAuthority();
    f.observer.verify(settled());
});

for (const [name, invalidate] of nativeInvalidations) test(`${name} remains guarded after authority handoff`, async t => {
    const f = fixture(t);
    f.create();
    await f.observer.wait();
    f.observer.verify(settled());
    f.observer.handoffAuthority();
    invalidate(f.api);
    assert.throws(() => f.observer.verify(settled()), stale);
    assert.throws(() => f.observer.handoffAuthority(), stale);
});

for (const invalidate of [
    f => f.storage('spaces', [], [{ id: 'other-space' }]),
    f => f.api.bookmarks.onChanged.emit('destination-folder', { title: 'Changed' }),
    f => f.api.tabs.onUpdated.emit(1, { title: 'Source changed' })
]) test('authority handoff cannot erase an already-observed context failure', async t => {
    const f = fixture(t);
    f.create();
    await f.observer.wait();
    invalidate(f);
    assert.throws(() => f.observer.handoffAuthority(), stale);
    assert.throws(() => f.observer.verify(settled()), stale);
    assert.equal(f.api.storage.onChanged.size, 1);
    assert(Object.values(f.api.bookmarks).every(bus => bus.size === 1));
});

test('pre-bind buffer accepts its exact event limit, including the required creation event', async t => {
    const f = fixture(t);
    for (let index = 0; index < ARCHIVE_CREATE_EVENT_LIMIT - 3; index++) f.api.tabs.onUpdated.emit(200, { title: `Other ${index}` });
    f.create();
    await f.observer.wait();
    f.observer.verify(settled());
});

test('one event beyond the pre-bind limit permanently invalidates even when the exact creation was observed', async t => {
    const f = fixture(t);
    emitInitial(f.api);
    for (let index = 0; index < ARCHIVE_CREATE_EVENT_LIMIT - 2; index++) f.api.tabs.onUpdated.emit(200, { title: `Other ${index}` });
    f.observer.bind(settled());
    await assert.rejects(f.observer.wait(), stale);
    assert.throws(() => f.observer.verify(settled()), stale);
});

test('unrelated event volume after binding does not consume the pre-bind buffer budget', async t => {
    const f = fixture(t);
    f.create(pending());
    for (let index = 0; index < ARCHIVE_CREATE_EVENT_LIMIT * 2; index++) f.api.tabs.onUpdated.emit(200, { title: `Other ${index}` });
    f.update({ status: 'loading', url: URL });
    f.update({ status: 'complete' });
    await f.observer.wait();
    f.observer.verify(settled());
});

for (const kind of ['missing creation', 'late creation', 'wrong creation ID', 'update before creation', 'duplicate pre-bind creation', 'duplicate post-bind creation', 'bind twice']) {
    test(`${kind} cannot establish a fresh-create observation`, async t => {
        const f = fixture(t);
        if (kind === 'wrong creation ID') emitInitial(f.api, 101);
        if (kind === 'update before creation') f.update({ title: 'Too early' });
        if (['update before creation', 'duplicate pre-bind creation', 'duplicate post-bind creation', 'bind twice'].includes(kind)) emitInitial(f.api);
        if (kind === 'duplicate pre-bind creation') f.api.tabs.onCreated.emit(pending());
        f.observer.bind(settled());
        if (['late creation', 'duplicate post-bind creation'].includes(kind)) f.api.tabs.onCreated.emit(pending());
        if (kind === 'bind twice') f.observer.bind(settled());
        await assert.rejects(f.observer.wait(), stale);
        assert.throws(() => f.observer.verify(settled()), stale);
    });
}

const invalidIdentity = [
    ['wrong native ID', { id: 101 }],
    ['missing native ID', { id: undefined }],
    ['wrong window', { windowId: 20 }],
    ['wrong URL', { url: 'https://archive.test/page?entry=2#saved' }],
    ['missing URL', { url: undefined }],
    ['unexpected pending URL', { pendingUrl: 'https://redirect.test/' }],
    ['pinned tab', { pinned: true }],
    ['missing pinned state', { pinned: undefined }],
    ['private tab', { incognito: true }],
    ['missing private state', { incognito: undefined }],
    ['native split', { splitViewId: 9 }],
    ['native group', { groupId: 9 }],
    ['active tab', { active: true }],
    ['missing active state', { active: undefined }]
];
for (const [name, changed] of invalidIdentity) {
    test(`returned ${name} cannot bind to observed exact creation`, async t => {
        const f = fixture(t);
        emitInitial(f.api);
        f.observer.bind(settled(changed));
        await assert.rejects(f.observer.wait(), stale);
    });
    test(`final ${name} fails verification permanently`, async t => {
        const f = fixture(t);
        f.create();
        await f.observer.wait();
        assert.throws(() => f.observer.verify(settled(changed)), stale);
        assert.throws(() => f.observer.verify(settled()), stale);
    });
}

for (const [name, changed] of [
    ['still pending requested URL', { pendingUrl: URL }],
    ['still loading', { status: 'loading' }],
    ['missing completion status', { status: undefined }]
]) test(`final ${name} cannot pass even after a complete event`, async t => {
    const f = fixture(t);
    f.create();
    await f.observer.wait();
    assert.throws(() => f.observer.verify(settled(changed)), stale);
    assert.throws(() => f.observer.verify(settled()), stale);
});

for (const [name, created] of [
    ['wrong window', pending({ windowId: 20 })],
    ['wrong URL', pending({ url: 'https://redirect.test/' })],
    ['empty URL without pending URL', pending({ pendingUrl: undefined })],
    ['loading target without initial pending evidence', loading()],
    ['complete with pending target', settled({ pendingUrl: URL })],
    ['pending redirect', pending({ pendingUrl: 'https://redirect.test/' })],
    ['active creation', pending({ active: true })],
    ['pinned creation', pending({ pinned: true })],
    ['private creation', pending({ incognito: true })],
    ['split creation', pending({ splitViewId: 9 })],
    ['grouped creation', pending({ groupId: 9 })]
]) test(`observed ${name} cannot be repaired by a valid returned/final snapshot`, async t => {
    const f = fixture(t);
    f.api.tabs.onCreated.emit(created);
    f.update({ status: 'loading', url: URL });
    f.update({ status: 'complete' });
    f.observer.bind(settled());
    await assert.rejects(f.observer.wait(), stale);
    assert.throws(() => f.observer.verify(settled()), stale);
});

test('final verification before confirmed completion invalidates rather than trusting a complete read', t => {
    const f = fixture(t);
    f.create(pending());
    assert.throws(() => f.observer.verify(settled()), stale);
    f.update({ status: 'loading', url: URL });
    f.update({ status: 'complete' });
    assert.throws(() => f.observer.verify(settled()), stale);
});

for (const phase of ['pre-bind', 'pending', 'loading']) test(`manual timeout in ${phase} is sticky and preserves its distinct error code`, async t => {
    const f = fixture(t, { timeoutMs: 25 });
    assert.deepEqual(f.clock.scheduled, [{ id: 1, delay: 25 }]);
    if (phase !== 'pre-bind') f.create(pending());
    if (phase === 'loading') f.update({ status: 'loading', url: URL });
    const waiting = phase === 'pre-bind' ? null : assert.rejects(f.observer.wait(), timeout);
    assert.equal(f.clock.fire(), true);
    if (waiting) await waiting;
    if (phase === 'pre-bind') f.create();
    f.update({ status: 'complete' });
    await assert.rejects(f.observer.wait(), timeout);
    assert.throws(() => f.observer.verify(settled()), timeout);
});

for (const failure of ['timeout', 'source changed']) test(`${failure} while tabs.create is unresolved does not produce an unhandled rejection`, async t => {
    const f = fixture(t), create = deferred();
    let createReturned = false;
    const operation = (async () => {
        const tab = await create.promise;
        createReturned = true;
        f.observer.bind(tab);
        await f.observer.wait();
        f.observer.verify(tab);
    })();
    const result = assert.rejects(operation, failure === 'timeout' ? timeout : stale);
    if (failure === 'timeout') f.clock.fire();
    else f.api.tabs.onUpdated.emit(1, { title: 'Source changed before create returned' });
    // Drain one event-loop turn while create is unresolved, so node:test catches
    // any internally rejected promise before wait() can attach a handler. The
    // observer's clock is still entirely injected; there is no timed sleep.
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(createReturned, false);
    emitInitial(f.api);
    create.resolve(settled());
    await result;
});

test('confirmed completion cancels the timer immediately, before wait is called', async t => {
    const f = fixture(t);
    f.create(pending());
    f.update({ status: 'loading', url: URL });
    await tick();
    assert.equal(f.clock.size, 1);
    f.update({ status: 'complete' });
    assert.equal(f.clock.size, 0);
    assert.equal(f.clock.fire(), false);
    await tick();
    await f.observer.wait();
    f.observer.verify(settled());
});

test('a timeout before binding cannot be repaired by a buffered complete initial sequence', async t => {
    const f = fixture(t);
    emitInitial(f.api);
    assert.equal(f.clock.fire(), true);
    f.observer.bind(settled());
    await assert.rejects(f.observer.wait(), timeout);
});

test('missing creation event ID cannot be inferred from subsequent updates or the returned tab', async t => {
    const f = fixture(t);
    f.api.tabs.onCreated.emit(pending({ id: undefined }));
    f.update({ status: 'loading', url: URL });
    f.update({ status: 'complete' });
    f.observer.bind(settled());
    await assert.rejects(f.observer.wait(), stale);
});

test('a successful wait cancels its timer but retains context listeners until stop', async t => {
    const f = fixture(t);
    f.create();
    await f.observer.wait();
    assert.equal(f.clock.fire(), false);
    f.observer.verify(settled());
    assert(f.buses.every(bus => bus.size === 1));
    f.storage('spaces', [{ id: 'source' }], [{ id: 'other' }]);
    assert.throws(() => f.observer.verify(settled()), stale);
});

test('stop is idempotent, cancels the timeout, removes every listener, and wakes a pending wait', async t => {
    const f = fixture(t);
    f.create(pending());
    const waiting = assert.rejects(f.observer.wait(), stale);
    f.observer.stop();
    const cancelled = [...f.clock.cancelled];
    f.observer.stop();
    await waiting;
    assert.deepEqual(f.clock.cancelled, cancelled);
    assert(f.buses.every(bus => bus.size === 0 && bus.removals === 1));
    assert.equal(f.clock.fire(), false);
    assert.throws(() => f.observer.assert(), stale);
    assert.throws(() => f.observer.handoffAuthority(), stale);
    assert.throws(() => f.observer.verify(settled()), stale);
});

test('stopping pre-bind clears buffered evidence and makes later use fail closed', async t => {
    const f = fixture(t);
    emitInitial(f.api);
    f.observer.stop();
    f.observer.bind(settled());
    await assert.rejects(f.observer.wait(), stale);
    assert.equal(f.clock.fire(), false);
});

for (const [area, event] of [
    ['tabs', 'onCreated'], ['tabs', 'onUpdated'], ['tabs', 'onRemoved'], ['tabs', 'onAttached'],
    ['tabs', 'onDetached'], ['tabs', 'onMoved'], ['tabs', 'onReplaced'], ['tabs', 'onActivated'],
    ['windows', 'onRemoved'], ['bookmarks', 'onChanged'], ['bookmarks', 'onMoved'],
    ['bookmarks', 'onRemoved'], ['bookmarks', 'onCreated'], ['storage', 'onChanged']
]) test(`missing ${area}.${event} observation fails closed and cleans up already-installed listeners`, () => {
    const env = environment();
    delete env.api[area][event];
    assert.throws(() => observeArchiveCreate(request(), { api: env.api, schedule: env.clock.schedule, cancel: env.clock.cancel }), { code: 'UNAVAILABLE' });
    assert.equal(env.clock.size, 0);
    assert(env.buses.every(bus => bus.size === 0));
});
