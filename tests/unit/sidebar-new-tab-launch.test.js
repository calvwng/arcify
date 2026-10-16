import test from 'node:test';
import assert from 'node:assert/strict';
import { createSidebarNewTabLauncher } from '../../sidebar-new-tab-launch.js';
import { PEER_KEY, PAIRING_GENERATION_KEY, bridgeError } from '../../spotlight-bridge-protocol.js';

const SELF = 'b'.repeat(32), PEER = 'a'.repeat(32);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture() {
    const event = () => { const callbacks = new Set(); return { callbacks, addListener: fn => callbacks.add(fn), removeListener: fn => callbacks.delete(fn), emit: (...args) => { for (const fn of callbacks) fn(...args); } }; };
    const calls = [], local = { [PEER_KEY]: PEER, [PAIRING_GENERATION_KEY]: 'initial' };
    const windows = [{ id: 10, type: 'normal', focused: true }, { id: 20, type: 'normal', focused: false }];
    const tabs = [{ id: 1, windowId: 10, active: true }, { id: 2, windowId: 20, active: true }];
    let beforeSend, beforeCreate, beforeAssign, beforeUpdate, chain = Promise.resolve();
    const store = { active: { 10: 'empty', 20: 'other' }, spaces: [{ id: 'empty', temporaryTabs: [] }, { id: 'other', temporaryTabs: [1, 2] }],
        run(operation) { const result = chain.then(operation); chain = result.catch(() => {}); return result; },
        async applyAction(action) {
            calls.push(['assign', structuredClone(action)]); await beforeAssign?.();
            for (const space of store.spaces) space.temporaryTabs = space.temporaryTabs.filter(id => id !== action.tabId);
            store.spaces.find(space => space.id === action.spaceId).temporaryTabs.push(action.tabId);
        } };
    const api = {
        runtime: { id: SELF, getURL: path => `chrome-extension://${SELF}/${path}` },
        windows: { onRemoved: event(), onFocusChanged: event(), async get(id) { const result = windows.find(window => window.id === id); if (!result) throw changedError(); return structuredClone(result); } },
        storage: { onChanged: event(), local: { async get() { return structuredClone(local); } } },
        tabs: { ...Object.fromEntries(['onActivated', 'onUpdated', 'onRemoved', 'onReplaced', 'onDetached'].map(name => [name, event()])),
            async query(query) { return structuredClone(tabs.filter(tab => tab.windowId === query.windowId && (!query.active || tab.active))); },
            async create(options) {
                calls.push(['create', structuredClone(options)]); await beforeCreate?.();
                const tab = { id: 100, url: `chrome-extension://${PEER}/newtab.html`, openerTabId: 1, ...options };
                tabs.push(tab); return structuredClone(tab);
            },
            async update(id, changes) { calls.push(['update', id, structuredClone(changes)]); await beforeUpdate?.(); for (const tab of tabs) if (tab.windowId === tabs.find(t => t.id === id).windowId) tab.active = tab.id === id; }
        }
    };
    const send = async (peer, command, payload) => {
        calls.push(['send', peer, command, structuredClone(payload)]);
        await beforeSend?.(command);
        return { extensionId: peer };
    };
    const launch = createSidebarNewTabLauncher(store, { api, send });
    const request = { type: 'spotlightBridgeLaunch', windowId: 10, spaceId: 'empty', fallbackToNewTab: true };
    const sender = { id: SELF, url: api.runtime.getURL('sidebar.html'), origin: api.runtime.getURL('').slice(0, -1), frameId: 0 };
    return { launch, request, sender, calls, store, local, tabs, windows, api, run: () => launch(request, sender),
        beforeSend: hook => { beforeSend = hook; }, beforeCreate: hook => { beforeCreate = hook; },
        beforeAssign: hook => { beforeAssign = hook; }, beforeUpdate: hook => { beforeUpdate = hook; } };
}
const changedError = () => bridgeError('STALE_CONTEXT', 'Changed');
const effects = f => f.calls.filter(call => call[0] !== 'send' || call[2] === 'launch');

test('paired New Tab uses read-only hello then existing new-tab launch without native creation', async () => {
    const f = fixture(); assert.deepEqual(await f.run(), { ok: true, outcome: 'spotlight' });
    assert.deepEqual(f.calls, [['send', PEER, 'hello', { windowId: 10 }], ['send', PEER, 'launch', { windowId: 10, mode: 'new-tab' }]]);
});

for (const code of [null, 'NOT_CONFIGURED', 'UNAVAILABLE', 'UNAUTHORIZED', 'VERSION_MISMATCH', 'UNSUPPORTED_COMMAND', 'UNSUPPORTED_FEATURE']) {
    test(`known pre-launch ${code || 'unconfigured companion'} opens one ordinary provider tab in the captured empty Space`, async () => {
        const f = fixture(); if (!code) delete f.local[PEER_KEY];
        else f.beforeSend(() => { throw bridgeError(code, 'Not available'); });
        assert.deepEqual(await f.run(), { ok: true, outcome: 'new-tab', tabId: 100 });
        assert.deepEqual(f.calls.filter(call => call[0] === 'create'), [['create', { windowId: 10, active: false }]]);
        assert.deepEqual(f.store.spaces.map(space => space.temporaryTabs), [[100], [1, 2]]);
        assert.deepEqual(f.store.active, { 10: 'empty', 20: 'other' });
        assert.equal(f.tabs.find(tab => tab.id === 2).active, true);
        assert.deepEqual(f.calls.filter(call => call[0] === 'update'), [['update', 100, { active: true }]]);
        assert.equal(f.calls.some(call => call[2] === 'launch'), false);
    });
}

for (const command of ['hello', 'launch']) for (const code of ['TIMEOUT', 'INVALID_RESPONSE', 'UNAVAILABLE', 'LAUNCH_FAILED', 'FAILED']) {
    if (command === 'hello' && code === 'UNAVAILABLE') continue;
    test(`${command} ${code} never retries or creates a fallback after an uncertain outcome`, async () => {
        const f = fixture(); f.beforeSend(current => { if (current === command) throw bridgeError(code, 'Uncertain'); });
        await assert.rejects(f.run(), { code });
        assert.equal(f.calls.some(call => ['create', 'assign', 'update'].includes(call[0])), false);
        assert.equal(f.calls.filter(call => call[2] === 'launch').length, command === 'launch' ? 1 : 0);
    });
}

test('a malformed hello identity cannot authorize launch or fallback', async () => {
    const f = fixture(), launch = createSidebarNewTabLauncher(f.store, { api: f.api, send: async () => ({ extensionId: SELF }) });
    await assert.rejects(launch(f.request, f.sender), { code: 'INVALID_RESPONSE' }); assert.deepEqual(f.calls, []);
});

for (const change of [
    f => { f.request.spaceId = ''; }, f => { f.request.spaceId = 'missing'; }, f => { f.store.active = {}; },
    f => { f.request.extra = true; }, f => { f.request.fallbackToNewTab = false; }, f => { f.request.windowId = -1; },
    f => { f.sender.id = PEER; }, f => { delete f.sender.url; }, f => { f.sender.url = f.api.runtime.getURL('options.html'); },
    f => { f.sender.url += '?from=sidebar'; }, f => { f.sender.origin = 'https://example.com'; }, f => { f.sender.frameId = 1; },
    f => { f.sender.tab = { windowId: 20 }; }, f => { f.sender.tab = { windowId: 10, incognito: true }; },
    f => { f.windows[0].focused = false; }, f => { f.windows[0].type = 'popup'; }, f => { f.windows[0].incognito = true; }, f => { f.windows.splice(0, 1); },
    f => { f.tabs[0].status = 'loading'; }, f => { f.tabs[0].pendingUrl = 'https://new.test/'; }, f => { f.tabs.splice(0, 1); }, f => { f.local[PEER_KEY] = false; }, f => { f.local[PEER_KEY] = 0; }, f => { f.local[PEER_KEY] = SELF; }, f => { f.local[PEER_KEY] = 'bad'; }
]) test(`invalid New Tab context fails before any mutation (${String(change).slice(0, 95)})`, async () => {
    const f = fixture(); change(f); await assert.rejects(f.run()); assert.deepEqual(effects(f), []);
});

for (const change of [
    f => { f.store.active[10] = 'other'; }, f => { f.store.spaces = f.store.spaces.filter(space => space.id !== 'empty'); },
    f => { f.local[PEER_KEY] = ''; }, f => { f.local[PAIRING_GENERATION_KEY] = 'repaired'; },
    f => { f.tabs[0].active = false; f.tabs.push({ id: 3, active: true, windowId: 10 }); },
    f => { f.tabs[0].url = 'https://new.test/'; }, f => { f.windows[0].focused = false; }, f => { f.windows.splice(0, 1); }
]) for (const unavailable of [false, true]) test(`context drift during hello blocks ${unavailable ? 'fallback' : 'launch'} (${String(change).slice(0, 95)})`, async () => {
    const f = fixture(); f.beforeSend(command => { assert.equal(command, 'hello'); change(f); if (unavailable) throw bridgeError('UNAVAILABLE', 'Unavailable'); });
    await assert.rejects(f.run(), { code: 'STALE_CONTEXT' }); assert.deepEqual(effects(f), []);
});

test('concurrent repeat requests share one paired launch and mismatched Space is rejected', async () => {
    const f = fixture(), entered = deferred(), release = deferred();
    f.beforeSend(async command => { if (command === 'hello') { entered.resolve(); await release.promise; } });
    const first = f.run(); await entered.promise; const second = f.run(); assert.equal(first, second);
    await assert.rejects(f.launch({ ...f.request, spaceId: 'other' }, f.sender), { code: 'STALE_CONTEXT' });
    release.resolve(); await Promise.all([first, second]); assert.equal(f.calls.filter(call => call[2] === 'launch').length, 1);
});

test('concurrent repeat requests share one ordinary creation even while native create is pending', async () => {
    const f = fixture(), entered = deferred(), release = deferred(); delete f.local[PEER_KEY];
    f.beforeCreate(async () => { entered.resolve(); await release.promise; });
    const first = f.run(); await entered.promise; const second = f.run(); assert.equal(first, second); release.resolve();
    await Promise.all([first, second]); assert.equal(f.calls.filter(call => call[0] === 'create').length, 1);
});

for (const stage of ['beforeCreate', 'beforeAssign', 'beforeUpdate']) test(`${stage} failure never repeats a native creation`, async () => {
    const f = fixture(); delete f.local[PEER_KEY]; f[stage](() => { throw new Error('Native response lost'); });
    await assert.rejects(f.run(), error => /Check your tabs/.test(error.message));
    assert.equal(f.calls.filter(call => call[0] === 'create').length, 1);
});

test('Space drift while native create is pending leaves a partial result without assigning or activating it', async () => {
    const f = fixture(); delete f.local[PEER_KEY]; f.beforeCreate(() => { f.store.active[10] = 'other'; });
    await assert.rejects(f.run(), /A new tab was opened/);
    assert.deepEqual(f.calls, [['create', { windowId: 10, active: false }]]);
});

for (const event of [
    f => f.api.tabs.onActivated.emit({ windowId: 10, tabId: 7 }),
    f => f.api.tabs.onUpdated.emit(1, { status: 'loading' }, f.tabs[0]),
    f => f.api.tabs.onUpdated.emit(1, { url: 'https://navigated.test/' }, f.tabs[0]),
    f => f.api.tabs.onRemoved.emit(1), f => f.api.tabs.onReplaced.emit(7, 1), f => f.api.tabs.onDetached.emit(1),
    f => f.api.windows.onFocusChanged.emit(20), f => f.api.windows.onRemoved.emit(10),
    f => f.api.storage.onChanged.emit({ [PAIRING_GENERATION_KEY]: { newValue: 'other' } }, 'local'),
    f => f.api.storage.onChanged.emit({ activeSpaces: { newValue: { 10: 'other' } } }, 'session')
]) for (const unavailable of [false, true]) test(`event after final native snapshot fences ${unavailable ? 'fallback' : 'launch'} (${String(event)})`, async () => {
    const f = fixture(); let reads = 0;
    const get = f.api.storage.local.get;
    f.api.storage.local.get = async () => { if (++reads === 2) event(f); return get(); };
    if (unavailable) f.beforeSend(() => { throw bridgeError('UNAVAILABLE', 'Unavailable'); });
    await assert.rejects(f.run(), { code: 'STALE_CONTEXT' }); assert.deepEqual(effects(f), []);
    for (const source of [f.api.tabs, f.api.windows, f.api.storage]) for (const value of Object.values(source)) {
        if (value.callbacks) assert.equal(value.callbacks.size, 0, 'temporary fences are always removed');
    }
});

test('cold worker waits for the shared initialization gate before reading active Space', async () => {
    const f = fixture(), { spaces, active } = f.store, run = f.store.run;
    delete f.store.spaces; delete f.store.active;
    f.store.run = operation => run(async () => { f.store.spaces = spaces; f.store.active = active; return operation(); });
    assert.equal((await f.run()).outcome, 'spotlight');
});

test('source navigation during cold initialization invalidates the pending gesture', async () => {
    const f = fixture(), run = f.store.run;
    f.store.run = operation => run(async () => { f.api.tabs.onUpdated.emit(1, { status: 'loading' }, f.tabs[0]); return operation(); });
    await assert.rejects(f.run(), { code: 'STALE_CONTEXT' }); assert.deepEqual(f.calls, []);
});


test('unrelated background navigation during cold initialization does not cancel New Tab', async () => {
    const f = fixture(), run = f.store.run;
    f.store.run = operation => run(async () => { f.api.tabs.onUpdated.emit(8, { status: 'loading' }, { id: 8, windowId: 10, active: false }); return operation(); });
    assert.equal((await f.run()).outcome, 'spotlight');
});

test('ordinary fallback explicitly requests prospective standalone Today placement', async () => {
    const f = fixture(); delete f.local[PEER_KEY]; await f.run();
    assert.deepEqual(f.calls.find(call => call[0] === 'assign'), ['assign', {
        action: 'assign', tabId: 100, spaceId: 'empty', pinned: false, newTodayTab: true
    }]);
});
