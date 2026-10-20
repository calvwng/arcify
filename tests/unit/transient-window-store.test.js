import test from 'node:test';
import assert from 'node:assert/strict';
import { createTransientWindowStore, TRANSIENT_WINDOW_SESSION_KEY as KEY } from '../../transient-window-store.js';

const clone = value => structuredClone(value);
const TOKEN = '11111111-1111-4111-8111-111111111111';
const BASE = 'chrome-extension://own/transient-window.html';
const marker = token => `${BASE}?token=${token}`;
const url = 'https://same.test/path';
const event = () => {
    const listeners = new Set();
    return { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn),
        emit: (...args) => { for (const fn of [...listeners]) fn(...args); }, count: () => listeners.size };
};
function fixture(initial) {
    const calls = [], windows = new Map([[10, { id: 10, type: 'normal', incognito: false }], [30, { id: 30, type: 'normal', incognito: false }]]);
    const tabs = new Map([[7, { id: 7, windowId: 10, url, pinned: false, incognito: false, splitViewId: -1 }],
        [8, { id: 8, windowId: 30, url, pinned: false, incognito: false, splitViewId: -1 }]]);
    let data = initial === undefined ? {} : { [KEY]: clone(initial) }, nextTab = 100, nextWindow = 20, store;
    const api = {
        runtime: { getURL: path => `chrome-extension://own/${path}` },
        storage: { session: {
            get: async key => { calls.push(['get', key]); return clone(data); },
            set: async patch => { calls.push(['set', clone(patch)]); data = { ...data, ...clone(patch) }; }
        } },
        windows: {
            onRemoved: event(),
            get: async id => { calls.push(['windowGet', id]); if (!windows.has(id)) throw Error('No window'); return clone(windows.get(id)); },
            create: async options => {
                calls.push(['windowCreate', clone(options)]);
                const window = { id: nextWindow++, type: 'normal', incognito: false };
                const tab = { id: nextTab++, windowId: window.id, url: options.url, pinned: false, incognito: false, splitViewId: -1 };
                windows.set(window.id, window); tabs.set(tab.id, tab); api.tabs.onCreated.emit(clone(tab));
                return { ...clone(window), tabs: [clone(tab)] };
            },
            remove: async id => { calls.push(['windowRemove', id]); throw Error('Must never close'); }
        },
        tabs: {
            onCreated: event(), onRemoved: event(), onAttached: event(), onDetached: event(), onReplaced: event(), onUpdated: event(),
            get: async id => { calls.push(['tabGet', id]); if (!tabs.has(id)) throw Error('No tab'); return clone(tabs.get(id)); },
            query: async query => {
                calls.push(['query', clone(query)]);
                return [...tabs.values()].filter(tab => query.windowId !== undefined ? tab.windowId === query.windowId
                    : query.url ? (tab.url || tab.pendingUrl || '').startsWith(query.url.slice(0, -1)) : true).map(clone);
            },
            create: async options => {
                calls.push(['tabCreate', clone(options)]);
                const tab = { id: nextTab++, ...options, incognito: false, splitViewId: -1 };
                tabs.set(tab.id, tab); api.tabs.onCreated.emit(clone(tab)); return clone(tab);
            },
            move: async (id, options) => {
                calls.push(['move', id, clone(options)]);
                const tab = tabs.get(id); api.tabs.onDetached.emit(id, { oldWindowId: tab.windowId });
                tab.windowId = options.windowId; api.tabs.onAttached.emit(id, { newWindowId: tab.windowId }); return clone(tab);
            },
            remove: async id => { calls.push(['tabRemove', id]); throw Error('Must never close'); },
            update: async (id, options) => { calls.push(['update', id, options]); throw Error('Must never recreate or modify page'); }
        }
    };
    api.tabs.onCreated.addListener(tab => store?.observe(tab));
    api.tabs.onDetached.addListener((id, info) => store?.observeDetached(id, info.oldWindowId));
    api.tabs.onReplaced.addListener((added, removed) => store?.observeReplacement(added, removed));
    api.tabs.onRemoved.addListener(id => store?.observeRemoved(id));
    api.windows.onRemoved.addListener(id => store?.observeWindowRemoved(id));
    const makeStore = () => (store = createTransientWindowStore({ api }));
    makeStore();
    let tail = Promise.resolve();
    const run = fn => { const result = tail.then(fn); tail = result.catch(() => {}); return result; };
    const open = () => run(() => store.openUnlocked({ url, originWindowId: 10 }));
    const request = record => ({ token: record.token, tabId: record.tabId, spaceId: 'space', bookmarkFolderId: 'folder' });
    const ownership = async (tab, target) => { calls.push(['ownership', tab.id, clone(target)]); assert.equal(store.isExcluded(tab), false); };
    ownership.validate = async (tab, target) => { calls.push(['validate', tab.id, clone(target)]); };
    const promote = (record, patch = {}, hooks = {}) => run(() => store.promoteUnlocked({ ...request(record), ...patch }, { commitOwnership: ownership, ...hooks }));
    return { api, windows, tabs, calls, open, promote, request, ownership, run, makeStore, get store() { return store; },
        get data() { return data; }, set data(value) { data = value; } };
}
const mutations = f => f.calls.filter(call => ['windowCreate', 'tabCreate', 'move', 'update', 'tabRemove', 'windowRemove'].includes(call[0]));
const moves = f => f.calls.filter(call => call[0] === 'move');
const registry = f => f.data[KEY];
const entry = overrides => ({ token: TOKEN, originWindowId: 10, windowId: 20, controllerTabId: 100, tabId: 101,
    memberTabIds: [100, 101], phase: 'ready', ...overrides });
function seed(f, record = entry()) {
    f.data = { [KEY]: { version: 1, records: [clone(record)] } };
    f.windows.set(20, { id: 20, type: 'normal', incognito: false });
    f.tabs.set(100, { id: 100, windowId: 20, url: marker(record.token), pinned: false, incognito: false, splitViewId: -1 });
    f.tabs.set(101, { id: 101, windowId: 20, url, pinned: false, incognito: false, splitViewId: -1 });
    return record;
}

test('opens one controller first, journals returned IDs, then opens one top-level web tab', async () => {
    const f = fixture(), record = await f.open();
    assert.equal(record.phase, 'ready');
    assert.deepEqual(mutations(f).map(call => call[0]), ['windowCreate', 'tabCreate']);
    const create = f.calls.findIndex(call => call[0] === 'windowCreate');
    assert.equal(f.calls.slice(0, create).filter(call => call[0] === 'set').at(-1)[1][KEY].records[0].windowId, null);
    const web = f.calls.findIndex(call => call[0] === 'tabCreate');
    const journal = f.calls.slice(create + 1, web).filter(call => call[0] === 'set').at(-1)[1][KEY].records[0];
    assert.equal(journal.windowId, record.windowId); assert.equal(journal.controllerTabId, record.controllerTabId);
    assert.equal(journal.tabId, null); assert.equal(journal.phase, 'opening');
    assert.deepEqual(mutations(f)[0][1], { url: marker(record.token), type: 'normal', width: 900, height: 720, focused: true, incognito: false });
    assert.deepEqual(mutations(f)[1][1], { windowId: record.windowId, url, active: true, pinned: false });
    assert.equal(JSON.stringify(registry(f)).includes(url), false);
    assert.equal(f.store.isExcluded(record.tabId), true); assert.equal(f.store.isTransientWindow(record.windowId), true);
});

test('promotes the exact same-URL tab once; controller and other members remain quarantined', async () => {
    const f = fixture(), record = await f.open();
    const other = { id: 200, windowId: record.windowId, url, pinned: false, incognito: false };
    f.tabs.set(other.id, other); f.store.observe(other);
    const result = await f.promote(record);
    assert.deepEqual(result, { ...f.request(record), windowId: 10, phase: 'committed' });
    assert.deepEqual(moves(f), [['move', record.tabId, { windowId: 10, index: -1 }]]);
    assert.equal(f.tabs.get(7).windowId, 10); assert.equal(f.tabs.get(8).windowId, 30); assert.equal(other.windowId, record.windowId);
    assert.equal(f.store.isExcluded(record.tabId), false); assert.equal(f.store.isExcluded(f.tabs.get(record.tabId)), false);
    assert.equal(f.store.isExcluded(record.controllerTabId), true); assert.equal(f.store.isExcluded(200), true);
    assert.equal(f.store.isTransientWindow(record.windowId), true);
    assert.deepEqual(mutations(f).map(call => call[0]), ['windowCreate', 'tabCreate', 'move']);
    const moveIndex = f.calls.findIndex(call => call[0] === 'move');
    assert.equal(f.calls.slice(0, moveIndex).filter(call => call[0] === 'set').at(-1)[1][KEY].records[0].phase, 'moving');
    assert.ok(f.calls.slice(0, moveIndex).some(call => call[0] === 'validate'));
});

test('explicit target chooses exact window; closed origin never selects an arbitrary surviving window', async () => {
    const f = fixture(), record = await f.open(); f.windows.delete(10);
    await assert.rejects(f.promote(record), { code: 'TARGET_REQUIRED' }); assert.equal(moves(f).length, 0);
    const result = await f.promote(record, { windowId: 30 }); assert.equal(result.windowId, 30);
});

for (const scenario of ['closedSource', 'wrongSourceWindow', 'pinned', 'incognito', 'split', 'closedTarget', 'incognitoTarget', 'popupTarget', 'transientTarget']) {
    test(`${scenario} is rejected before native move`, async () => {
        const f = fixture(), record = await f.open();
        if (scenario === 'closedSource') f.tabs.delete(record.tabId);
        if (scenario === 'wrongSourceWindow') f.tabs.get(record.tabId).windowId = 30;
        if (scenario === 'pinned') f.tabs.get(record.tabId).pinned = true;
        if (scenario === 'incognito') f.tabs.get(record.tabId).incognito = true;
        if (scenario === 'split') f.tabs.get(record.tabId).splitViewId = 0;
        if (scenario === 'closedTarget') f.windows.delete(30);
        if (scenario === 'incognitoTarget') f.windows.get(30).incognito = true;
        if (scenario === 'popupTarget') f.windows.get(30).type = 'popup';
        await assert.rejects(f.promote(record, { windowId: scenario === 'transientTarget' ? record.windowId : 30 }));
        assert.equal(moves(f).length, 0); assert.equal(f.store.isExcluded(record.tabId), true);
    });
}

test('strict Space validation runs before move and prevents a stale destination mutation', async () => {
    const f = fixture(), record = await f.open();
    f.ownership.validate = async () => { throw Error('Folder identity changed'); };
    await assert.rejects(f.promote(record), /Folder identity/); assert.equal(moves(f).length, 0);
});

test('source and destination are re-read after awaited mutation guard and pending journal write', async () => {
    for (const where of ['guard', 'journal']) {
        const f = fixture(), record = await f.open();
        const change = () => { f.tabs.get(record.tabId).splitViewId = 0; };
        if (where === 'journal') {
            const set = f.api.storage.session.set;
            f.api.storage.session.set = async patch => { await set(patch); if (patch[KEY].records[0].phase === 'moving') change(); };
        }
        await assert.rejects(f.promote(record, {}, where === 'guard' ? { beforeMutation: async () => change() } : {}));
        assert.equal(moves(f).length, 0);
    }
});

test('native detach during awaited validation fences even a returned stale snapshot', async () => {
    const f = fixture(), record = await f.open();
    f.ownership.validate = async () => f.api.tabs.onDetached.emit(record.tabId, { oldWindowId: record.windowId });
    await assert.rejects(f.promote(record), { code: 'STALE_TRANSIENT' }); assert.equal(moves(f).length, 0);
});

test('concurrent duplicate submits under caller queue cannot dispatch a second move', async () => {
    const f = fixture(), record = await f.open();
    const results = await Promise.allSettled([f.promote(record), f.promote(record)]);
    assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].reason.code, 'ALREADY_COMMITTED'); assert.equal(moves(f).length, 1);
});

for (const phase of ['window', 'web', 'move']) test(`failed session write before ${phase} prevents that native dispatch`, async () => {
    const f = fixture();
    let record;
    if (phase === 'move') record = await f.open();
    const set = f.api.storage.session.set;
    f.api.storage.session.set = async patch => {
        const value = patch[KEY].records[0];
        if (phase === 'window' || phase === 'web' && value.windowId !== null || phase === 'move' && value.phase === 'moving') throw Error('disk failed');
        return set(patch);
    };
    await assert.rejects(phase === 'move' ? f.promote(record) : f.open());
    assert.equal(f.calls.filter(call => call[0] === (phase === 'window' ? 'windowCreate' : phase === 'web' ? 'tabCreate' : 'move')).length, 0);
});

for (const operation of ['window', 'web', 'move']) test(`uncertain ${operation} native response is quarantined and never replayed on reload`, async () => {
    const f = fixture(); let record;
    if (operation === 'move') record = await f.open();
    const owner = operation === 'window' ? f.api.windows : f.api.tabs, method = operation === 'move' ? 'move' : 'create';
    const native = owner[method]; owner[method] = async (...args) => { await native(...args); throw Error('response lost'); };
    await assert.rejects(operation === 'move' ? f.promote(record) : f.open(), { code: 'UNCERTAIN_RESULT' });
    const count = mutations(f).length;
    const reloaded = f.makeStore(); await reloaded.initialize(); const listed = await reloaded.listUnlocked();
    assert.equal(listed[0].phase, 'uncertain'); assert.equal(mutations(f).length, count);
    for (const tab of f.tabs.values()) if (tab.windowId === 20 || operation === 'move' && tab.id === record.tabId) assert.equal(reloaded.isExcluded(tab), true);
    if (record) await assert.rejects(f.promote(record), { code: 'UNCERTAIN_RESULT' });
    assert.equal(mutations(f).length, count);
});

test('malformed successful move response is uncertain without ownership write or rollback', async () => {
    const f = fixture(), record = await f.open(), move = f.api.tabs.move;
    f.api.tabs.move = async (...args) => { await move(...args); return { id: 7, windowId: 10 }; };
    await assert.rejects(f.promote(record), { code: 'UNCERTAIN_RESULT' });
    assert.equal(f.calls.filter(call => call[0] === 'ownership').length, 0);
    assert.equal(f.tabs.get(record.tabId).windowId, 10); assert.equal(f.store.isExcluded(record.tabId), true);
    assert.equal(moves(f).length, 1);
});

test('ownership failure after move restores exclusion and preserves exact destination page', async () => {
    const f = fixture(), record = await f.open();
    const commitOwnership = async tab => { assert.equal(f.store.isExcluded(tab), false); throw Error('ownership storage failed'); };
    await assert.rejects(f.promote(record, {}, { commitOwnership }), { code: 'PARTIAL_COMMIT' });
    assert.equal(f.tabs.get(record.tabId).windowId, 10); assert.equal(f.store.isExcluded(record.tabId), true);
    await assert.rejects(f.promote(record), { code: 'UNCERTAIN_RESULT' }); assert.equal(moves(f).length, 1);
    assert.equal(registry(f).records[0].phase, 'uncertain');
});

test('committed registry failure restores quarantine after ownership persisted', async () => {
    const f = fixture(), record = await f.open(), set = f.api.storage.session.set;
    f.api.storage.session.set = async patch => { if (patch[KEY].records[0].phase === 'committed') throw Error('session write failed'); return set(patch); };
    await assert.rejects(f.promote(record), { code: 'PARTIAL_COMMIT' });
    assert.equal(f.store.isExcluded(record.tabId), true); assert.equal(moves(f).length, 1);
    await f.makeStore().initialize(); assert.equal(f.store.isExcluded(record.tabId), true);
});

test('interrupted moving journal reload never replays or admits the exact moved tab', async () => {
    const f = fixture(), record = seed(f, entry({ phase: 'moving', target: { windowId: 30, spaceId: 'space', bookmarkFolderId: 'folder' } }));
    f.tabs.get(record.tabId).windowId = 30;
    await f.store.initialize(); assert.equal(f.store.isExcluded(record.tabId), true);
    await assert.rejects(f.promote(record), { code: 'UNCERTAIN_RESULT' }); assert.deepEqual(mutations(f), []);
});

test('ready session rehydrates exact IDs and can promote without re-creating any tab', async () => {
    const f = fixture(), record = seed(f); await f.store.initialize();
    await f.promote(record); assert.deepEqual(mutations(f), [['move', 101, { windowId: 10, index: -1 }]]);
});

test('committed rehydrate releases only promoted tab and preserves other window members', async () => {
    const f = fixture(), record = await f.open(); await f.promote(record); await f.makeStore().initialize();
    assert.equal(f.store.isExcluded(record.tabId), false); assert.equal(f.store.isExcluded(record.controllerTabId), true);
    const count = moves(f).length; await assert.rejects(f.promote(record), { code: 'ALREADY_COMMITTED' }); assert.equal(moves(f).length, count);
});

test('cold controller recovery quarantines the entire window, without choosing among same-URL tabs', async () => {
    const f = fixture(); seed(f); f.data = {};
    f.tabs.set(102, { ...clone(f.tabs.get(101)), id: 102 });
    await f.store.initialize(); const listed = await f.store.listUnlocked();
    assert.equal(listed.length, 1); assert.equal(listed[0].phase, 'orphan'); assert.equal(listed[0].tabId, null);
    assert.deepEqual(listed[0].memberTabIds, [100, 101, 102]);
    for (const id of [100, 101, 102]) assert.equal(f.store.isExcluded(id), true);
    await assert.rejects(f.promote({ token: TOKEN, tabId: 101 })); assert.deepEqual(mutations(f), []);
});

test('pending controller journal recovers by exact marker without selecting a created page', async () => {
    const f = fixture(); seed(f, entry({ phase: 'opening', windowId: null, controllerTabId: null, tabId: null, memberTabIds: [] }));
    await f.store.initialize(); const [record] = await f.store.listUnlocked();
    assert.equal(record.phase, 'uncertain'); assert.equal(record.tabId, null); assert.equal(record.controllerTabId, 100);
    assert.equal(f.store.isExcluded(101), true); assert.deepEqual(mutations(f), []);
});

for (const suffix of ['', '?token=nope', `?token=${TOKEN}&extra=1`, `?token=${TOKEN}#fragment`, '?token=AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA']) {
    test(`does not recover an inexact controller marker ${suffix || '(no query)'}`, async () => {
        const f = fixture(); f.tabs.set(90, { id: 90, windowId: 10, url: BASE + suffix, pinned: false, incognito: false });
        await f.store.initialize(); assert.deepEqual(await f.store.listUnlocked(), []); assert.equal(f.store.isExcluded(90), false);
    });
}

for (const malformed of [null, [], {}, { version: 2, records: [] }, { version: 1, records: [entry({ phase: 'made-up' })] },
    { version: 1, records: [entry({ memberTabIds: [100, 101, 101] })] }, { version: 1, records: [entry(), entry()] },
    { version: 1, records: [entry({ extra: true })] }, { version: 1, records: [entry({ tabId: 100 })] }]) {
    test('malformed registry fails closed without querying/adopting tabs or overwriting data', async () => {
        const f = fixture(malformed), before = clone(f.data);
        await assert.rejects(f.store.initialize(), { code: 'INVALID_TRANSIENT_REGISTRY' });
        assert.equal(f.store.isExcluded(7), true); assert.equal(f.store.isTransientWindow(10), true); assert.deepEqual(f.data, before);
        assert.equal(f.calls.some(call => call[0] === 'set' || call[0] === 'query'), false);
    });
}

test('initialize is idempotent and concurrent callers share one registry read', async () => {
    const f = fixture(); await Promise.all([f.store.initialize(), f.store.initialize(), f.store.initialize()]); await f.store.initialize();
    assert.equal(f.calls.filter(call => call[0] === 'get').length, 1);
});

test('new transient members remain quarantined after drag-out and same-session worker reload', async () => {
    const f = fixture(), record = await f.open();
    f.store.observeDetached(200, record.windowId);
    const tab = { id: 200, windowId: 30, url, pinned: false, incognito: false }; f.tabs.set(200, tab);
    assert.equal(f.store.isExcluded(tab), true); await f.store.flushObservedUnlocked();
    await f.makeStore().initialize(); assert.equal(f.store.isExcluded(200), true);
    assert.equal(f.store.isExcluded(f.tabs.get(8)), false);
});

test('replacement quarantines both native IDs and does not silently rebind or promote replacement', async () => {
    const f = fixture(), record = await f.open();
    f.tabs.set(201, { ...f.tabs.get(record.tabId), id: 201 }); f.tabs.delete(record.tabId);
    f.store.observeReplacement(201, record.tabId); await f.store.flushObservedUnlocked();
    assert.equal(f.store.isExcluded(201), true); assert.equal(f.store.isExcluded(record.tabId), true);
    const [current] = await f.store.listUnlocked(); assert.equal(current.tabId, record.tabId); assert.equal(current.phase, 'uncertain');
    await assert.rejects(f.promote(record)); assert.equal(moves(f).length, 0);
    await f.makeStore().initialize(); assert.equal(f.store.isExcluded(201), true);
});

test('controller closure never releases a surviving member; exact full closure can prune bounded registry', async () => {
    const f = fixture(), record = await f.open();
    f.store.observeRemoved(record.controllerTabId); await f.store.flushObservedUnlocked();
    assert.equal(f.store.isExcluded(record.tabId), true); assert.equal((await f.store.listUnlocked()).length, 1);
    f.store.observeWindowRemoved(record.windowId); await f.store.flushObservedUnlocked();
    assert.equal((await f.store.listUnlocked()).length, 1);
    f.store.observeRemoved(record.tabId); await f.store.flushObservedUnlocked(); assert.deepEqual(await f.store.listUnlocked(), []);
    await assert.rejects(f.promote(record)); assert.equal(moves(f).length, 0);
});

test('temporary admissions are exact-ID, nested-safe and always cleaned up after rejection', async () => {
    const f = fixture(), record = await f.open();
    await assert.rejects(f.store.withAdmission(record.tabId, async () => {
        assert.equal(f.store.isExcluded(record.tabId), false); assert.equal(f.store.isExcluded(record.controllerTabId), true);
        await f.store.withAdmission(record.tabId, async () => assert.equal(f.store.isExcluded(record.tabId), false));
        assert.equal(f.store.isExcluded(record.tabId), false); throw Error('commit failed');
    }), /commit failed/);
    assert.equal(f.store.isExcluded(record.tabId), true);
});

for (const badUrl of ['file:///tmp/page', 'javascript:alert(1)', 'chrome://newtab', 'data:text/html,Hi', 'https://name:secret@example.test/', 'https://same.test/ bad']) {
    test(`rejects unsupported initial URL ${badUrl.split(':')[0]}`, async () => {
        const f = fixture(); await assert.rejects(f.store.openUnlocked({ url: badUrl, originWindowId: 10 })); assert.deepEqual(mutations(f), []);
    });
}

test('strict bounded payload rejects unrecognized request keys without browser mutation', async () => {
    const f = fixture(); await assert.rejects(f.store.openUnlocked({ url, originWindowId: 10, iframe: true }));
    const record = await f.open(); await assert.rejects(f.promote(record, { tabIds: [record.tabId] })); assert.equal(moves(f).length, 0);
});


test('delayed old source snapshots cannot re-quarantine an explicitly committed tab', async () => {
    const f = fixture(), record = await f.open(), old = clone(f.tabs.get(record.tabId));
    await f.promote(record);
    f.store.observe(old); f.store.observeDetached(record.tabId, record.windowId); await f.store.flushObservedUnlocked();
    assert.equal(f.store.isExcluded(old), false); assert.equal(f.store.isExcluded(record.tabId), false);
    assert.equal(registry(f).records[0].memberTabIds.includes(record.tabId), false);
    await f.makeStore().initialize(); assert.equal(f.store.isExcluded(record.tabId), false);
});

test('observed pending controller events before initialize cannot be lost during session read', async () => {
    const f = fixture(); seed(f); f.data = {};
    f.store.observe(f.tabs.get(100)); f.store.observe(f.tabs.get(101));
    await f.store.initialize(); assert.equal(f.store.isExcluded(101), true);
    assert.equal((await f.store.listUnlocked())[0].phase, 'orphan');
});

test('cold recovery rejects conflicting exact controller identities without rebinding saved IDs', async () => {
    const f = fixture(); seed(f);
    f.tabs.set(200, { id: 200, windowId: 30, url: marker(TOKEN), pinned: false, incognito: false });
    const before = clone(f.data);
    await assert.rejects(f.store.initialize(), { code: 'UNCERTAIN_RESULT' });
    assert.equal(f.store.isExcluded(7), true); assert.deepEqual(f.data, before);
});

test('lists return copies, so a caller cannot mutate lifecycle or ownership by reference', async () => {
    const f = fixture(), record = await f.open(), listed = await f.store.listUnlocked();
    listed[0].phase = 'committed'; listed[0].memberTabIds.length = 0;
    assert.equal(f.store.isExcluded(record.tabId), true); assert.equal((await f.store.listUnlocked())[0].phase, 'ready');
});

test('live source navigation is preserved and never used to choose a same-URL replacement', async () => {
    const f = fixture(), record = await f.open(); f.tabs.get(record.tabId).url = 'https://navigated.test/unsaved';
    await f.promote(record); assert.equal(f.tabs.get(record.tabId).url, 'https://navigated.test/unsaved');
    assert.equal(moves(f)[0][1], record.tabId);
});

test('ownership-time reattachment is partial and never rolls the page back', async () => {
    const f = fixture(), record = await f.open();
    const commitOwnership = async () => { f.tabs.get(record.tabId).windowId = 30; };
    await assert.rejects(f.promote(record, {}, { commitOwnership }), { code: 'PARTIAL_COMMIT' });
    assert.equal(f.tabs.get(record.tabId).windowId, 30); assert.equal(f.store.isExcluded(record.tabId), true); assert.equal(moves(f).length, 1);
});

test('no mutation timeout releases the caller queue while a native move remains pending', async () => {
    const f = fixture(), record = await f.open(), native = f.api.tabs.move;
    let finish;
    f.api.tabs.move = async (...args) => { const moved = await native(...args); await new Promise(resolve => { finish = resolve; }); return moved; };
    const first = f.promote(record); let secondFinished = false;
    const second = f.promote(record).catch(cause => { secondFinished = true; return cause; });
    while (!finish) await new Promise(resolve => setImmediate(resolve));
    assert.equal(secondFinished, false); assert.equal(moves(f).length, 1);
    finish(); await first; assert.equal((await second).code, 'ALREADY_COMMITTED'); assert.equal(moves(f).length, 1);
});


test('unrelated replacement during initialize does not acquire transient quarantine', async () => {
    const f = fixture(), get = f.api.storage.session.get;
    f.api.storage.session.get = async key => { f.store.observeReplacement(17, 7); return get(key); };
    await f.store.initialize(); assert.equal(f.store.isExcluded(17), false); assert.deepEqual(await f.store.listUnlocked(), []);
});

test('source record becoming uncertain during validation cannot dispatch a native move', async () => {
    const f = fixture(), record = await f.open();
    f.store.observe({ id: 200, windowId: record.windowId });
    f.ownership.validate = async () => f.store.observeReplacement(201, 200);
    await assert.rejects(f.promote(record), { code: 'UNCERTAIN_RESULT' }); assert.equal(moves(f).length, 0);
});

test('a controller navigating away cannot authorize a new native move', async () => {
    const f = fixture(), record = await f.open(); f.tabs.get(record.controllerTabId).pendingUrl = 'https://leaving.test/';
    await assert.rejects(f.promote(record)); assert.equal(moves(f).length, 0);
});

test('unreadable or malformed session API results fail closed without write or browser mutation', async () => {
    for (const returned of [null, false, []]) {
        const f = fixture(); f.api.storage.session.get = async () => returned;
        await assert.rejects(f.store.initialize()); assert.equal(f.store.isExcluded(7), true);
        assert.equal(f.calls.some(call => call[0] === 'set'), false); assert.deepEqual(mutations(f), []);
    }
});


test('ordinary replacement buffered before initialize never becomes a transient claim', async () => {
    const f = fixture(); f.store.observeReplacement(12, 11);
    assert.equal(f.store.isKnownExcluded(12), false); assert.equal(f.store.isExcluded(12), true);
    await f.store.initialize(); assert.deepEqual(await f.store.listUnlocked(), []); assert.equal(f.store.isExcluded(12), false);
});

test('known-positive event predicates distinguish ordinary cold tabs from exact markers', async () => {
    const f = fixture();
    assert.equal(f.store.isExcluded(7), true); assert.equal(f.store.isKnownExcluded(7), false);
    assert.equal(f.store.isKnownExcluded({ id: 7, windowId: 10 }), false); assert.equal(f.store.isKnownTransientWindow(10), false);
    f.store.observe({ id: 100, windowId: 20, url: marker(TOKEN) });
    assert.equal(f.store.isKnownExcluded(100), true); assert.equal(f.store.isKnownExcluded({ id: 101, windowId: 20 }), true);
    assert.equal(f.store.isKnownTransientWindow(20), true);
});

test('malformed-registry fail-closed gating does not fabricate known ordinary event provenance', async () => {
    const f = fixture(null); await assert.rejects(f.store.initialize());
    assert.equal(f.store.isExcluded(7), true); assert.equal(f.store.isTransientWindow(10), true);
    assert.equal(f.store.isKnownExcluded(7), false); assert.equal(f.store.isKnownTransientWindow(10), false);
});


for (const stage of ['window', 'web', 'move']) test(`authority revoked during ${stage} pending journal blocks its native dispatch`, async () => {
    const f = fixture(); let record, authorized = true;
    if (stage === 'move') record = await f.open();
    const set = f.api.storage.session.set;
    f.api.storage.session.set = async patch => {
        await set(patch); const record = patch[KEY].records[0];
        if (stage === 'window' && record.windowId === null || stage === 'web' && record.windowId !== null && record.phase === 'opening'
            || stage === 'move' && record.phase === 'moving') authorized = false;
    };
    const beforeMutation = async () => { if (!authorized) throw Object.assign(Error('Authority revoked'), { code: 'REVOKED' }); };
    await assert.rejects(stage === 'move' ? f.promote(record, {}, { beforeMutation })
        : f.run(() => f.store.openUnlocked({ url, originWindowId: 10 }, { beforeMutation })));
    assert.equal(f.calls.filter(call => call[0] === (stage === 'window' ? 'windowCreate' : stage === 'web' ? 'tabCreate' : 'move')).length, 0);
});

test('the final authority guard is immediately before each native dispatch with no intervening awaited read', async () => {
    const f = fixture(); let last = null;
    for (const [owner, keys] of [[f.api.storage.session, ['get', 'set']], [f.api.windows, ['get', 'create']], [f.api.tabs, ['get', 'query', 'create', 'move']]]) {
        for (const key of keys) {
            const method = owner[key]; owner[key] = async (...args) => {
                if (key === 'create' || key === 'move') assert.equal(last, 'guard');
                last = key; return method(...args);
            };
        }
    }
    const beforeMutation = async () => { last = 'guard'; };
    const record = await f.run(() => f.store.openUnlocked({ url, originWindowId: 10 }, { beforeMutation }));
    await f.promote(record, {}, { beforeMutation });
    assert.equal(mutations(f).length, 3);
});

test('native source mutation inside final authority guard is still fenced before move', async () => {
    const f = fixture(), record = await f.open(); let guards = 0;
    await assert.rejects(f.promote(record, {}, { beforeMutation: async () => {
        if (++guards === 2) f.api.tabs.onDetached.emit(record.tabId, { oldWindowId: record.windowId });
    } }));
    assert.equal(moves(f).length, 0);
});


for (const replaced of ['controller', 'member']) test(`post-commit ${replaced} replacement preserves completed page ownership across reload`, async () => {
    const f = fixture(), record = await f.open();
    f.tabs.set(200, { id: 200, windowId: record.windowId, url, pinned: false, incognito: false }); f.store.observe(f.tabs.get(200));
    await f.promote(record);
    const removed = replaced === 'controller' ? record.controllerTabId : 200;
    const added = { ...f.tabs.get(removed), id: 300 }; f.tabs.delete(removed); f.tabs.set(300, added);
    f.store.observeReplacement(300, removed); f.store.observe(added); await f.store.flushObservedUnlocked();
    assert.equal(f.store.isExcluded(record.tabId), false); assert.equal(f.store.isExcluded(300), true);
    assert.equal(registry(f).records[0].phase, 'committed'); assert.equal(registry(f).records[0].memberTabIds.includes(record.tabId), false);
    await f.makeStore().initialize();
    assert.equal(f.store.isExcluded(record.tabId), false); assert.equal(f.store.isExcluded(300), true);
    assert.equal((await f.store.listUnlocked())[0].phase, 'committed');
    assert.equal(moves(f).length, 1);
});

for (const replaced of ['controller', 'member']) test(`${replaced} replacement during final committed journal cannot re-quarantine the promoted page`, async () => {
    const f = fixture(), record = await f.open();
    f.tabs.set(200, { id: 200, windowId: record.windowId, url, pinned: false, incognito: false }); f.store.observe(f.tabs.get(200));
    const set = f.api.storage.session.set; let replacedOnce = false;
    f.api.storage.session.set = async patch => {
        await set(patch);
        if (!replacedOnce && patch[KEY].records[0].phase === 'committed') {
            replacedOnce = true;
            const removed = replaced === 'controller' ? record.controllerTabId : 200;
            const added = { ...f.tabs.get(removed), id: 300 }; f.tabs.delete(removed); f.tabs.set(300, added);
            f.store.observeReplacement(300, removed); f.store.observe(added);
        }
    };
    const result = await f.promote(record); assert.equal(result.phase, 'committed');
    assert.equal(f.store.isExcluded(record.tabId), false); assert.equal(f.store.isExcluded(300), true);
    await f.store.flushObservedUnlocked(); await f.makeStore().initialize();
    assert.equal(f.store.isExcluded(record.tabId), false); assert.equal(f.store.isExcluded(300), true);
});

test('primary replacement while final committed journal is unsettled reports partial and preserves quarantine', async () => {
    const f = fixture(), record = await f.open(), set = f.api.storage.session.set; let replacedOnce = false;
    f.api.storage.session.set = async patch => {
        await set(patch);
        if (!replacedOnce && patch[KEY].records[0].phase === 'committed') {
            replacedOnce = true;
            const added = { ...f.tabs.get(record.tabId), id: 300 }; f.tabs.delete(record.tabId); f.tabs.set(300, added);
            f.store.observeReplacement(300, record.tabId);
        }
    };
    await assert.rejects(f.promote(record), { code: 'PARTIAL_COMMIT' });
    assert.equal(f.store.isExcluded(record.tabId), true); assert.equal(f.store.isExcluded(300), true);
    assert.equal(registry(f).records[0].phase, 'uncertain'); assert.equal(moves(f).length, 1);
});

test('moving a completed control marker cannot quarantine its promoted destination window', async () => {
    const f = fixture(), record = await f.open(); await f.promote(record);
    const controller = f.tabs.get(record.controllerTabId); controller.windowId = 10; f.store.observe(controller);
    await f.store.flushObservedUnlocked();
    assert.equal(f.store.isExcluded(record.tabId), false); assert.equal(f.store.isTransientWindow(10), false);
    assert.equal(f.store.isExcluded(record.controllerTabId), true);
    await f.makeStore().initialize();
    assert.equal(f.store.isExcluded(record.tabId), false); assert.equal(f.store.isTransientWindow(10), false);
});


test('historical membership in a second transient window rejects promotion before native move', async () => {
    const f = fixture(), a = await f.open(), b = await f.open();
    const page = f.tabs.get(a.tabId); page.windowId = b.windowId; f.store.observe(page);
    page.windowId = a.windowId; f.store.observe(page);
    await assert.rejects(f.promote(a), { code: 'AMBIGUOUS_TRANSIENT_MEMBERSHIP' });
    assert.equal(moves(f).length, 0); assert.equal(f.store.isExcluded(a.tabId), true);
    assert.equal((await f.store.listUnlocked()).find(record => record.token === b.token).memberTabIds.includes(a.tabId), true);
});

test('another record acquiring the page during final commit cannot produce false success', async () => {
    const f = fixture(), a = await f.open(), b = await f.open(), set = f.api.storage.session.set; let observed = false;
    f.api.storage.session.set = async patch => {
        await set(patch);
        if (!observed && patch[KEY].records.find(record => record.token === a.token).phase === 'committed') {
            observed = true; f.store.observe({ id: a.tabId, windowId: b.windowId });
        }
    };
    await assert.rejects(f.promote(a), { code: 'PARTIAL_COMMIT' });
    assert.equal(moves(f).length, 1); assert.equal(f.store.isExcluded(a.tabId), true);
    await assert.rejects(f.promote(a), { code: 'UNCERTAIN_RESULT' }); assert.equal(moves(f).length, 1);
});

test('exact cold close events are applied to hydrated IDs and prune a fully closed record', async () => {
    const f = fixture(), record = seed(f);
    f.tabs.delete(record.tabId); f.tabs.delete(record.controllerTabId); f.windows.delete(record.windowId);
    f.store.observeRemoved(record.tabId); f.store.observeRemoved(record.controllerTabId); f.store.observeWindowRemoved(record.windowId);
    await f.store.initialize(); assert.deepEqual(await f.store.listUnlocked(), []);
    assert.deepEqual(registry(f).records, []); assert.equal(f.store.isExcluded(7), false); assert.deepEqual(mutations(f), []);
});

test('cold ordinary closes do not create registry entries or quarantine unrelated live tabs', async () => {
    const f = fixture(); f.store.observeRemoved(11); f.store.observeWindowRemoved(12);
    await f.store.initialize(); assert.deepEqual(await f.store.listUnlocked(), []); assert.equal(f.store.isExcluded(7), false);
    assert.equal(f.calls.some(call => call[0] === 'set'), false);
});

test('cold controller closure retains a quarantined page that survives outside the old window', async () => {
    const f = fixture(), record = seed(f); f.tabs.delete(record.controllerTabId); f.windows.delete(record.windowId); f.tabs.get(record.tabId).windowId = 30;
    f.store.observeRemoved(record.controllerTabId); f.store.observeWindowRemoved(record.windowId);
    await f.store.initialize(); assert.equal((await f.store.listUnlocked()).length, 1); assert.equal(f.store.isExcluded(record.tabId), true);
});

for (const badUrl of ['https:foo', 'https:/host.test', 'https:\\host.test', 'https://host.test/\\path', 'https://host.test/\u00a0path']) {
    test('rejects parser-normalized or whitespace/backslash initial URL', async () => {
        const f = fixture(); await assert.rejects(f.store.openUnlocked({ url: badUrl, originWindowId: 10 })); assert.deepEqual(mutations(f), []);
    });
}


test('pre-initialize observations retain every visited transient window for a dragged-out member', async () => {
    const f = fixture(); seed(f);
    f.store.observe({ id: 200, windowId: 20 }); f.store.observe({ id: 200, windowId: 30 });
    f.tabs.set(200, { id: 200, windowId: 30, url, pinned: false, incognito: false });
    await f.store.initialize(); assert.equal(f.store.isExcluded(200), true);
    assert.equal((await f.store.listUnlocked())[0].memberTabIds.includes(200), true);
    await f.makeStore().initialize(); assert.equal(f.store.isExcluded(200), true);
});

test('attach/detach provenance during unresolved storage read survives latest ordinary-window snapshot', async () => {
    const f = fixture(); seed(f); const get = f.api.storage.session.get; let finishRead;
    f.api.storage.session.get = async key => { const data = await get(key); await new Promise(resolve => { finishRead = resolve; }); return data; };
    const initialized = f.store.initialize(); while (!finishRead) await new Promise(resolve => setImmediate(resolve));
    f.store.observeDetached(200, 20); f.store.observe({ id: 200, windowId: 30 });
    f.tabs.set(200, { id: 200, windowId: 30, url, pinned: false, incognito: false });
    finishRead(); await initialized; assert.equal(f.store.isExcluded(200), true);
    assert.equal(registry(f).records[0].memberTabIds.includes(200), true);
});

test('exact pre-load marker provenance survives later navigation without URL-based page selection', async () => {
    const f = fixture(); f.windows.set(20, { id: 20, type: 'normal', incognito: false });
    f.store.observe({ id: 100, windowId: 20, url: marker(TOKEN) });
    f.store.observe({ id: 100, windowId: 20, url: 'https://navigated.test/' });
    f.tabs.set(100, { id: 100, windowId: 20, url: 'https://navigated.test/', pinned: false, incognito: false });
    await f.store.initialize(); const [record] = await f.store.listUnlocked();
    assert.equal(record.phase, 'orphan'); assert.equal(record.tabId, null); assert.equal(f.store.isExcluded(100), true);
});


test('cold replacement survivor is quarantined before original closed-window record can be pruned', async () => {
    const f = fixture(), record = seed(f);
    f.store.observeReplacement(200, record.tabId);
    f.store.observeRemoved(record.tabId); f.store.observeRemoved(record.controllerTabId); f.store.observeWindowRemoved(record.windowId);
    f.tabs.delete(record.tabId); f.tabs.delete(record.controllerTabId); f.windows.delete(record.windowId);
    f.tabs.set(200, { id: 200, windowId: 30, url, pinned: false, incognito: false });
    await f.store.initialize(); assert.equal((await f.store.listUnlocked()).length, 1); assert.equal(f.store.isExcluded(200), true);
});

test('cold provenance and replacement replay precede closure pruning even for a newly observed sibling', async () => {
    const f = fixture(), record = seed(f);
    f.store.observe({ id: 200, windowId: record.windowId }); f.store.observeReplacement(201, 200); f.store.observeRemoved(200);
    f.store.observeRemoved(record.tabId); f.store.observeRemoved(record.controllerTabId); f.store.observeWindowRemoved(record.windowId);
    f.tabs.delete(record.tabId); f.tabs.delete(record.controllerTabId); f.windows.delete(record.windowId);
    f.tabs.set(201, { id: 201, windowId: 30, url, pinned: false, incognito: false });
    await f.store.initialize(); assert.equal((await f.store.listUnlocked()).length, 1); assert.equal(f.store.isExcluded(201), true);
});


test('departure during held cold controller discovery remains quarantined after orphan recovery', async () => {
    const f = fixture(); seed(f); f.data = {};
    f.tabs.set(200, { id: 200, windowId: 20, url, pinned: false, incognito: false });
    const query = f.api.tabs.query; let release;
    f.api.tabs.query = async request => {
        const result = await query(request);
        if (request.url) await new Promise(resolve => { release = resolve; });
        return result;
    };
    const initialized = f.store.initialize(); while (!release) await new Promise(resolve => setImmediate(resolve));
    f.store.observeDetached(200, 20); f.tabs.get(200).windowId = 30; f.store.observe(f.tabs.get(200));
    release(); await initialized;
    const [record] = await f.store.listUnlocked(); assert.equal(record.phase, 'orphan');
    assert.equal(record.memberTabIds.includes(200), true); assert.equal(f.store.isExcluded(200), true);
});

for (const change of [{ url: 'https://elsewhere.test/' }, { pendingUrl: 'https://elsewhere.test/' }, { status: 'loading' }]) {
    test('controller navigation during final guard is fenced even if the guard sees its old tab snapshot', async () => {
        const f = fixture(), record = await f.open(); let guards = 0;
        await assert.rejects(f.promote(record, {}, { beforeMutation: async () => {
            if (++guards !== 2) return;
            const staleSnapshot = clone(f.tabs.get(record.controllerTabId));
            Object.assign(f.tabs.get(record.controllerTabId), change);
            f.api.tabs.onUpdated.emit(record.controllerTabId, change, clone(f.tabs.get(record.controllerTabId)));
            await Promise.resolve(); assert.equal(staleSnapshot.url, marker(record.token));
        } }));
        assert.equal(moves(f).length, 0);
    });
}

test('controller navigation during final web-create guard prevents web creation', async () => {
    const f = fixture(); let guards = 0;
    await assert.rejects(f.run(() => f.store.openUnlocked({ url, originWindowId: 10 }, { beforeMutation: async () => {
        if (++guards !== 4) return;
        const controller = [...f.tabs.values()].find(tab => tab.url.startsWith(BASE));
        controller.pendingUrl = 'https://elsewhere.test/'; f.api.tabs.onUpdated.emit(controller.id, { pendingUrl: controller.pendingUrl });
    } })));
    assert.equal(f.calls.filter(call => call[0] === 'windowCreate').length, 1); assert.equal(f.calls.filter(call => call[0] === 'tabCreate').length, 0);
});

test('ordinary primary page navigation during final guard remains permitted without recreation', async () => {
    const f = fixture(), record = await f.open(); let guards = 0;
    const result = await f.promote(record, {}, { beforeMutation: async () => {
        if (++guards !== 2) return;
        const page = f.tabs.get(record.tabId); page.url = 'https://navigated.test/';
        f.api.tabs.onUpdated.emit(record.tabId, { url: page.url, status: 'loading' }, clone(page));
    } });
    assert.equal(result.phase, 'committed'); assert.equal(f.tabs.get(record.tabId).url, 'https://navigated.test/'); assert.equal(moves(f).length, 1);
});


test('unchanged initial controller completion during final page-create guard permits one web tab', async () => {
    const f = fixture(); let guards = 0;
    const record = await f.run(() => f.store.openUnlocked({ url, originWindowId: 10 }, { beforeMutation: async () => {
        if (++guards !== 4) return;
        const controller = [...f.tabs.values()].find(tab => tab.url.startsWith(BASE));
        f.api.tabs.onUpdated.emit(controller.id, { status: 'complete' }, clone(controller));
    } }));
    assert.equal(record.phase, 'ready');
    assert.equal(f.calls.filter(call => call[0] === 'windowCreate').length, 1);
    assert.equal(f.calls.filter(call => call[0] === 'tabCreate').length, 1);
    assert.equal(f.store.isExcluded(record.tabId), true);
});

async function orphanFixture() {
    const f = fixture(); seed(f); f.data = {};
    f.tabs.set(102, { ...clone(f.tabs.get(101)), id: 102 });
    await f.store.initialize();
    const [orphan] = await f.store.listUnlocked();
    const recover = (tabId = 101, options = {}) => f.run(() => f.store.recoverUnlocked({ token: orphan.token, tabId }, options));
    return { f, orphan, recover };
}

test('explicit orphan selection records only the chosen exact ID and preserves every other member', async () => {
    const { f, orphan, recover } = await orphanFixture();
    const before = clone(orphan.memberTabIds), validations = [];
    const selected = await recover(102, { validateSelection: async (tab, request) => {
        validations.push([tab.id, request]); assert.equal(f.store.isExcluded(tab), true);
    } });
    assert.equal(selected.phase, 'ready'); assert.equal(selected.tabId, 102); assert.equal(selected.recovered, true);
    assert.equal(selected.originWindowId, null); assert.deepEqual(selected.memberTabIds, before);
    assert.ok(validations.length >= 2); assert.ok(validations.every(([id, request]) => id === 102 && request.windowId === orphan.windowId));
    for (const id of before) assert.equal(f.store.isExcluded(id), true);
    assert.deepEqual(mutations(f), []);
    const writes = f.calls.filter(call => call[0] === 'set' && call[1][KEY].records[0].recovered);
    assert.deepEqual(writes.map(call => call[1][KEY].records[0].phase), ['uncertain', 'ready']);
    assert.equal(JSON.stringify(registry(f)).includes(url), false);
});

test('recovered selection survives worker reload, requires an explicit destination, and promotes the same ID', async () => {
    const { f, recover } = await orphanFixture(), selected = await recover(102);
    await f.makeStore().initialize();
    assert.equal(f.store.isExcluded(102), true);
    await assert.rejects(f.promote(selected), { code: 'TARGET_REQUIRED' }); assert.equal(moves(f).length, 0);
    const result = await f.promote(selected, { windowId: 30 });
    assert.equal(result.tabId, 102); assert.equal(result.windowId, 30); assert.equal(f.store.isExcluded(102), false);
    assert.equal(f.store.isExcluded(101), true); assert.equal(registry(f).records[0].recovered, true);
    assert.deepEqual(mutations(f), [['move', 102, { windowId: 30, index: -1 }]]);
});

for (const kind of ['controller', 'wrongWindow', 'closed', 'pinned', 'incognito', 'split', 'ownExtension', 'otherExtension', 'internalPage', 'unobserved']) {
    test(`orphan selection rejects ${kind} without saving a selected identity`, async () => {
        const { f, recover } = await orphanFixture(); let tabId = 101;
        if (kind === 'controller') tabId = 100;
        if (kind === 'wrongWindow') f.tabs.get(101).windowId = 30;
        if (kind === 'closed') f.tabs.delete(101);
        if (kind === 'pinned') f.tabs.get(101).pinned = true;
        if (kind === 'incognito') f.tabs.get(101).incognito = true;
        if (kind === 'split') f.tabs.get(101).splitViewId = 0;
        if (kind === 'ownExtension') f.tabs.get(101).url = BASE + '?invalid-marker';
        if (kind === 'otherExtension') f.tabs.get(101).url = 'chrome-extension://other/settings.html';
        if (kind === 'internalPage') f.tabs.get(101).url = 'chrome://newtab/';
        if (kind === 'unobserved') { tabId = 201; f.tabs.set(201, { ...f.tabs.get(101), id: 201 }); }
        await assert.rejects(recover(tabId));
        assert.equal(registry(f).records[0].phase, 'orphan'); assert.equal(registry(f).records[0].tabId, null);
        assert.deepEqual(mutations(f), []);
    });
}

test('orphan selection rejects another record’s historical exact member claim', async () => {
    const { f, recover } = await orphanFixture();
    const otherToken = '22222222-2222-4222-8222-222222222222';
    f.windows.set(40, { id: 40, type: 'normal', incognito: false });
    const controller = { id: 300, windowId: 40, url: marker(otherToken), pinned: false, incognito: false };
    f.tabs.set(300, controller); f.store.observe(controller); f.store.observe({ id: 101, windowId: 40 });
    await assert.rejects(recover(), { code: 'AMBIGUOUS_TRANSIENT_MEMBERSHIP' });
    assert.deepEqual(mutations(f), []);
});

test('ownership validator can reject an already owned or pinned-identity orphan page before selection', async () => {
    const { f, recover } = await orphanFixture();
    await assert.rejects(recover(101, { validateSelection: async () => { throw Error('Existing Favorite owner'); } }), /Existing Favorite owner/);
    assert.equal(registry(f).records[0].phase, 'orphan'); assert.equal(registry(f).records[0].tabId, null);
    assert.deepEqual(mutations(f), []);
});

test('duplicate orphan selections serialize to one chosen identity and never substitute the other same-URL page', async () => {
    const { f, recover } = await orphanFixture();
    const result = await Promise.allSettled([recover(101), recover(102)]);
    assert.equal(result[0].value.tabId, 101); assert.equal(result[1].reason.code, 'ALREADY_RECOVERED');
    assert.equal(registry(f).records[0].tabId, 101); assert.deepEqual(mutations(f), []);
});

for (const stage of ['pending', 'ready']) test(`orphan selection ${stage} journal failure stays quarantined with no success or native replay`, async () => {
    const { f, recover } = await orphanFixture(), set = f.api.storage.session.set;
    f.api.storage.session.set = async patch => {
        const record = patch[KEY].records[0];
        if (record.recovered && record.phase === (stage === 'pending' ? 'uncertain' : 'ready')) throw Error('Session unavailable');
        return set(patch);
    };
    await assert.rejects(recover()); assert.equal(f.store.isExcluded(101), true);
    await assert.rejects(recover()); assert.deepEqual(mutations(f), []);
    f.api.storage.session.set = set; await f.makeStore().initialize();
    const [record] = await f.store.listUnlocked();
    assert.equal(record.phase, stage === 'pending' ? 'orphan' : 'uncertain'); assert.equal(f.store.isExcluded(101), true);
    assert.deepEqual(mutations(f), []);
});

for (const stage of ['uncertain', 'ready']) test(`native selection replacement during ${stage} recovery journal never produces a ready receipt`, async () => {
    const { f, recover } = await orphanFixture(), set = f.api.storage.session.set; let replaced = false;
    f.api.storage.session.set = async patch => {
        await set(patch);
        if (!replaced && patch[KEY].records[0].recovered && patch[KEY].records[0].phase === stage) {
            replaced = true;
            const added = { ...f.tabs.get(101), id: 201 }; f.tabs.delete(101); f.tabs.set(201, added);
            f.api.tabs.onReplaced.emit(201, 101);
        }
    };
    await assert.rejects(recover());
    assert.equal(registry(f).records[0].phase, 'uncertain'); assert.equal(registry(f).records[0].tabId, 101);
    assert.equal(f.store.isExcluded(101), true); assert.equal(f.store.isExcluded(201), true);
    await f.makeStore().initialize(); assert.equal(f.store.isExcluded(201), true); assert.deepEqual(mutations(f), []);
});

for (const stage of ['uncertain', 'ready']) test(`authority revoked during ${stage} recovery write cannot settle selection`, async () => {
    const { f, recover } = await orphanFixture(), set = f.api.storage.session.set; let authorized = true;
    f.api.storage.session.set = async patch => {
        await set(patch);
        if (patch[KEY].records[0].recovered && patch[KEY].records[0].phase === stage) authorized = false;
    };
    await assert.rejects(recover(101, { beforeMutation: async () => { if (!authorized) throw Error('Revoked controller'); } }), /Revoked controller/);
    assert.equal(registry(f).records[0].phase, 'uncertain'); assert.equal(f.store.isExcluded(101), true);
    assert.deepEqual(mutations(f), []);
});

for (const id of [100, 101]) test('exact controller and selected-tab native events stay fenced through final recovery guard', async () => {
    const { f, recover } = await orphanFixture(); let guards = 0;
    await assert.rejects(recover(101, { beforeMutation: async () => {
        if (++guards === 4) f.api.tabs.onUpdated.emit(id, { pendingUrl: 'https://changed.test/' });
    } }));
    assert.equal(registry(f).records[0].phase, 'uncertain'); assert.equal(f.store.isExcluded(101), true); assert.deepEqual(mutations(f), []);
});

test('orphan selection does not accept a replaced or navigated controller identity', async () => {
    const { f, recover } = await orphanFixture(); f.tabs.get(100).pendingUrl = 'https://gone.test/';
    await assert.rejects(recover()); assert.equal(registry(f).records[0].phase, 'orphan'); assert.deepEqual(mutations(f), []);
});

for (const malformed of [entry({ originWindowId: null }), entry({ recovered: false }), entry({ recovered: true }),
    entry({ phase: 'orphan', tabId: null, originWindowId: null, recovered: true })]) {
    test('recovery provenance flag has a strict schema and never legitimizes an arbitrary null origin', async () => {
        const f = fixture({ version: 1, records: [malformed] });
        await assert.rejects(f.store.initialize(), { code: 'INVALID_TRANSIENT_REGISTRY' });
        assert.equal(f.calls.some(call => call[0] === 'set'), false);
    });
}

// Passive diagnostics are opt-in worker memory, not journal or API behavior.
const diagnosticSymbol = Symbol.for('arcify.transient-open.diagnostics.v1');
const normalizeDiagnosticRun = value => JSON.parse(JSON.stringify(value).replace(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/g, TOKEN));
async function diagnosedOpen(scenario, sink) {
    const f = fixture();
    if (sink !== undefined) Object.defineProperty(globalThis, diagnosticSymbol, { value: sink, configurable: true });
    const get = f.api.tabs.get, windowGet = f.api.windows.get;
    let guards = 0;
    const original = Object.assign(new Error('Never retain https://private.test/secret or token=secret'), { code: 'PAIRING_CHANGED' });
    f.api.tabs.get = async id => {
        if (id === 100 && scenario === 'native-controller-read') throw original;
        const tab = await get(id);
        if (id === 100 && scenario === 'initial-loading') { tab.url = 'about:blank'; tab.pendingUrl = marker(f.data[KEY].records[0].token); tab.status = 'loading'; }
        if (id === 100 && scenario === 'split') tab.splitViewId = 0;
        return tab;
    };
    f.api.windows.get = async id => {
        const result = await windowGet(id);
        if (id === 20 && scenario === 'loading-event') f.api.tabs.onUpdated.emit(100, { status: 'loading', url: 'https://private.test/secret' });
        return result;
    };
    if (scenario === 'native-web-create') f.api.tabs.create = async () => { throw original; };
    if (scenario === 'native-window-create') f.api.windows.create = async () => { throw original; };
    let result, rejection;
    try {
        result = await f.run(() => f.store.openUnlocked({ url, originWindowId: 10 }, { beforeMutation: async () => {
            guards++;
            if (scenario === 'opening-authority' && guards === 2 || scenario === 'web-authority' && guards === 4) throw original;
        } }));
    } catch (cause) { rejection = cause; }
    finally { delete globalThis[diagnosticSymbol]; }
    const outcome = normalizeDiagnosticRun({ result: result || null,
        error: rejection ? { name: rejection.name, code: rejection.code, message: rejection.message } : null,
        data: f.data, calls: f.calls, tabs: [...f.tabs.values()], windows: [...f.windows.values()], guards,
        excluded: [...f.tabs.values()].map(tab => [tab.id, f.store.isExcluded(tab)]),
        listeners: ['onUpdated', 'onRemoved', 'onAttached', 'onDetached', 'onReplaced'].map(name => [name, f.api.tabs[name].count()]) });
    return { outcome, rejection, original };
}
for (const scenario of ['success', 'initial-loading', 'loading-event', 'split', 'native-controller-read', 'native-web-create', 'native-window-create', 'opening-authority', 'web-authority']) {
    test(`passive open diagnostics preserve exact calls, outcomes, quarantine and listener cleanup: ${scenario}`, async () => {
        const baseline = await diagnosedOpen(scenario);
        const events = [], observed = await diagnosedOpen(scenario, events);
        assert.deepEqual(observed.outcome, baseline.outcome);
        assert(events.length > 0);
        assert.equal(JSON.stringify(events).includes(url), false);
        assert.equal(JSON.stringify(events).includes('private.test'), false);
        assert.equal(JSON.stringify(events).includes('secret'), false);
        assert.equal(JSON.stringify(events).includes('token'), false);
        if (scenario === 'success') {
            assert.equal(events.at(-1).event, 'complete'); assert.equal(events.at(-1).stage, 'ready-journal');
            assert.equal(events.at(-1).phase, 'ready'); assert.equal(events.at(-1).tabId, 101);
            assert.equal(events.some(item => item.event === 'rejected'), false);
        } else {
            const rejected = events.findLast(item => item.event === 'rejected'); assert(rejected);
            assert.equal(rejected.error.messageOmitted, true);
            const expectedStage = { 'initial-loading': 'controller-before-web', 'loading-event': 'web-fence', split: 'controller-before-web',
                'native-controller-read': 'controller-before-web', 'native-web-create': 'create-web-page',
                'native-window-create': 'create-controller', 'opening-authority': 'authority-before-controller', 'web-authority': 'authority-before-web-dispatch' }[scenario];
            assert.equal(rejected.stage, expectedStage);
            if (scenario === 'opening-authority') assert.equal(observed.rejection, observed.original, 'The existing pre-dispatch error identity must be untouched.');
            else assert.equal(observed.rejection.code, 'UNCERTAIN_RESULT');
            if (scenario === 'split') assert.equal(rejected.error.code, 'NATIVE_SPLIT_ACTIVE');
            if (scenario === 'web-authority') assert.equal(rejected.error.code, 'PAIRING_CHANGED');
            if (scenario === 'native-controller-read') assert.equal(events.find(item => item.event === 'controller-read-rejected').error.code, 'PAIRING_CHANGED');
            if (scenario === 'native-web-create') assert.equal(events.find(item => item.event === 'web-create-rejected').error.code, 'PAIRING_CHANGED');
        }
        if (scenario === 'initial-loading') {
            const read = events.findLast(item => item.event === 'controller-read');
            assert.deepEqual(read.controller, { id: 100, windowId: 20, status: 'loading', pinned: false, incognito: false,
                splitViewId: -1, url: 'about-blank', pendingUrl: 'exact-marker' });
        }
        if (scenario === 'loading-event') {
            const invalidated = events.find(item => item.event === 'fence-invalidated');
            assert.equal(invalidated.stage, 'window-before-web'); assert.equal(invalidated.fence, 'web');
            assert.equal(invalidated.nativeEvent, 'tabs.onUpdated'); assert.equal(invalidated.nativeId, 100);
            assert.deepEqual(invalidated.changed, ['url', 'status']); assert.equal(invalidated.status, 'loading');
        }
    });
}
for (const scenario of ['success', 'initial-loading', 'loading-event']) test(`broken diagnostic sink cannot alter ${scenario}`, async () => {
    const baseline = await diagnosedOpen(scenario);
    for (const sink of [Object.freeze([]), new Proxy([], { defineProperty() { throw Error('Observer denied'); } })]) {
        assert.deepEqual((await diagnosedOpen(scenario, sink)).outcome, baseline.outcome);
    }
});
