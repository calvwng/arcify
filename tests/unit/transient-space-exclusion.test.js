import test from 'node:test';
import assert from 'node:assert/strict';
import { SpaceStore, ownerOf } from '../../space-store.js';
import { syncSpaceGroups, detachGlobalTabs } from '../../tab-group-sync.js';
import { createSpaceContinuityStamp } from '../../space-continuity.js';
import { createTransientWindowStore, TRANSIENT_WINDOW_SESSION_KEY } from '../../transient-window-store.js';

const copy = value => structuredClone(value);
const space = (id, ids = []) => ({ id, spaceUuid: id, name: id, color: 'blue', bookmarkFolderId: id, spaceBookmarks: [], temporaryTabs: ids });
const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); }, emit(...args) { return this.listeners.map(fn => fn(...args)); } });
const area = data => ({
    async get(keys) {
        const names = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys || data);
        return Object.fromEntries(names.map(key => [key, copy(data[key] ?? keys?.[key])]));
    },
    async set(values) { Object.assign(data, copy(values)); }
});
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture({ transientWindows = [9], initialTabs, cold = false } = {}) {
    const local = { spaceModelVersion: 2, spaces: [space('a', [1]), space('b', [2])] };
    const session = { spaceSession: !cold }, sync = {}, mutations = [], log = [];
    const tabs = initialTabs || [
        { id: 1, windowId: 1, index: 0, url: 'https://ordinary.test/', groupId: -1 },
        { id: 2, windowId: 9, index: 0, url: 'https://transient.test/', groupId: -1 }
    ];
    const groups = [], windows = new Set(transientWindows), excluded = new Set(), durable = new Set(), admitted = new Set();
    const registry = {
        async initialize() { log.push('initialize'); },
        isTransientWindow: id => windows.has(id),
        isExcluded(value) {
            const id = typeof value === 'object' ? value?.id : value;
            return !admitted.has(id) && (excluded.has(id) || typeof value === 'object' && windows.has(value?.windowId));
        },
        isKnownExcluded(value) { return this.isExcluded(value); },
        observe(tab) {
            if (tab && windows.has(tab.windowId)) { excluded.add(tab.id); log.push(`observe:${tab.id}`); }
        },
        observeReplacement(added, removed) { if (excluded.has(removed)) excluded.add(added); },
        async flushObservedUnlocked() { for (const id of excluded) durable.add(id); },
        async withAdmission(id, operation) { admitted.add(id); try { return await operation(); } finally { admitted.delete(id); } }
    };
    globalThis.chrome = {
        runtime: { getURL: path => `chrome-extension://arcify/${path}` },
        storage: { local: area(local), session: area(session), sync: area(sync), onChanged: event() },
        tabs: {
            onCreated: event(), onUpdated: event(), onRemoved: event(), onReplaced: event(), onActivated: event(), onMoved: event(), onAttached: event(), onDetached: event(),
            async query(filter = {}) { return copy(tabs.filter(tab => (filter.windowId === undefined || tab.windowId === filter.windowId) && (filter.groupId === undefined || tab.groupId === filter.groupId))); },
            async get(id) { const tab = tabs.find(tab => tab.id === id); if (!tab) throw new Error('No such tab'); return copy(tab); },
            async group(args) { mutations.push(['group', copy(args)]); const id = args.groupId ?? 100 + groups.length; if (!groups.some(group => group.id === id)) groups.push({ id, windowId: args.createProperties?.windowId }); tabs.filter(tab => args.tabIds.includes(tab.id)).forEach(tab => { tab.groupId = id; }); return id; },
            async ungroup(ids) { mutations.push(['ungroup', copy(ids)]); },
            async move(...args) { mutations.push(['move', ...copy(args)]); },
            async remove(id) { mutations.push(['remove', id]); tabs.splice(tabs.findIndex(tab => tab.id === id), 1); }
        },
        windows: { async get(id) { return { id, type: 'normal', incognito: false }; } },
        tabGroups: { onRemoved: event(), onUpdated: event(), async query() { return copy(groups); },
            async update(id, changes) { mutations.push(['update', id, copy(changes)]); Object.assign(groups.find(group => group.id === id), changes); },
            async move(...args) { mutations.push(['groupMove', ...copy(args)]); } },
        bookmarks: { search: async () => [{ id: 'root' }], getChildren: async () => [], create: async ({ title }) => ({ id: title, title }), getSubTree: async id => [{ id, children: [] }] }
    };
    const store = new SpaceStore(); store.transientWindows = registry;
    const options = { isExcludedTab: tab => registry.isExcluded(tab), isExcludedWindow: id => registry.isTransientWindow(id), observeTab: tab => registry.observe(tab), flushObserved: () => registry.flushObservedUnlocked() };
    return { store, registry, excluded, durable, windows, local, session, sync, mutations, log, tabs, groups, options };
}

test('transient identity initializes before Favorites and queried observations persist before adoption', async () => {
    const f = fixture();
    f.store.favoriteStore = { initialize: async () => { assert.equal(f.log[0], 'initialize'); }, reconcile: async () => {}, ownsTab: () => false };
    const track = f.store.track.bind(f.store);
    f.store.track = (tab, options) => { if (tab.windowId === 9) assert(f.durable.has(tab.id)); return track(tab, options); };
    await f.store.dispatch({ action: 'get' });
    assert.equal(ownerOf(f.store.spaces, 2), undefined);
    assert.equal(f.store.isGlobalTab(2), false);
    assert.equal(f.store.isTransientTab(2), true);
});

test('same-URL transient never consumes a restore record or claims restore window matching', async () => {
    const f = fixture({ cold: true, initialTabs: [{ id: 2, windowId: 9, index: 0, url: 'https://same.test/', groupId: -1 }] });
    f.local.spaceTabSnapshot = [{ tabId: 20, spaceId: 'b', section: 'temporaryTabs', order: 0, url: 'https://same.test/', windowKey: 'prior', tabIndex: 0 }];
    f.local.spaceWindowSnapshot = [{ key: 'prior', tabs: [{ url: 'https://same.test/', index: 0 }] }];
    await f.store.dispatch({ action: 'get' });
    assert.equal(f.store.restoreQueue.length, 1);
    assert.equal(ownerOf(f.store.spaces, 2), undefined);
    assert.equal(f.store.restoreWindowKeys.has(9), false);
    const ordinary = { id: 3, windowId: 1, index: 0, url: 'https://same.test/', groupId: -1 }; f.tabs.push(ordinary);
    await f.store.run(async () => { f.store.track(ordinary); await f.store.persist(); });
    assert.equal(ownerOf(f.store.spaces, 3)?.id, 'b');
    assert.equal(f.store.restoreQueue.length, 0);
});

test('transient tabs and windows leave no snapshot, signature, key, active selection or lastTab', async () => {
    const f = fixture();
    f.session.activeSpaces = { 1: 'a', 9: 'b' };
    f.session.spaceWindowKeys = [[1, 'normal'], [9, 'transient']];
    f.session.spaceRestoreWindowKeys = [[9, 'transient']];
    f.local.spaces[1].lastTab = 2;
    await f.store.dispatch({ action: 'get' });
    assert.deepEqual(f.local.spaceTabSnapshot.map(record => record.tabId), [1]);
    assert.equal(JSON.stringify(f.local.spaceWindowSnapshot).includes('transient.test'), false);
    assert.equal(f.session.spaceWindowKeys.some(([id]) => id === 9), false);
    assert.equal(f.session.spaceRestoreWindowKeys.some(([id]) => id === 9), false);
    assert.equal(f.session.activeSpaces[9], undefined);
    assert.equal(f.local.spaces[1].lastTab, undefined);
});

test('generic assignment, stale patch, reconcilePins, import and activation cannot admit transient tabs', async () => {
    const f = fixture(); await f.store.dispatch({ action: 'get' });
    await f.store.dispatch({ action: 'assign', tabId: 2, spaceId: 'a' });
    for (const action of ['patch', 'reconcilePins']) {
        const before = copy(f.store.spaces), after = copy(before); after[0].temporaryTabs.push(2); after[0].lastTab = 2;
        await f.store.dispatch({ action, before, after });
        assert.equal(ownerOf(f.store.spaces, 2), undefined);
        assert.equal(f.store.spaces[0].lastTab, undefined);
    }
    f.groups.push({ id: 22, windowId: 9, title: 'Transient', color: 'blue' }); f.tabs[1].groupId = 22;
    await f.store.dispatch({ action: 'import', windowId: 9 });
    await f.store.dispatch({ action: 'activate', windowId: 9, spaceId: 'a' });
    assert.equal(ownerOf(f.store.spaces, 2), undefined);
    assert.equal(f.store.active[9], undefined);
    assert.equal(f.store.spaces.length, 2);
});

test('admission permits only the exact chosen tab under the same Space queue', async () => {
    const f = fixture(); f.tabs.push({ id: 3, windowId: 9, index: 1, url: 'https://other.test/', groupId: -1 });
    await f.store.dispatch({ action: 'get' });
    f.tabs[1].windowId = 1;
    await f.store.run(() => f.registry.withAdmission(2, async () => {
        assert.equal(f.store.isTransientTab(2), false);
        assert.equal(f.store.isTransientTab(3), true);
        await f.store.applyAction({ action: 'assign', tabId: 2, spaceId: 'b' });
        await f.store.applyAction({ action: 'assign', tabId: 3, spaceId: 'b' });
        assert.equal(ownerOf(f.store.spaces, 2)?.id, 'b');
        assert.equal(ownerOf(f.store.spaces, 3), undefined);
        assert.equal(f.local.spaceTabSnapshot.find(record => record.tabId === 2)?.spaceId, 'b');
    }));
    assert.equal(f.store.isTransientTab(2), true, 'The temporary admission cannot leak to another operation');
});

test('onCreated quarantines synchronously while an earlier queued write is blocked', async () => {
    const f = fixture({ initialTabs: [{ id: 1, windowId: 1, index: 0, url: 'https://ordinary.test/', groupId: -1 }] });
    f.store.install(); await f.store.run(() => {});
    const entered = gate(), release = gate();
    const earlier = f.store.run(async () => { entered.resolve(); await release.promise; await f.store.persist(); });
    await entered.promise;
    const child = { id: 3, windowId: 9, index: 0, url: 'https://child.test/', groupId: -1 }; f.tabs.push(child);
    chrome.tabs.onCreated.emit(child);
    assert.equal(f.store.isTransientTab(3), true);
    release.resolve(); await earlier; await f.store.run(() => {});
    assert.equal(ownerOf(f.store.spaces, 3), undefined);
    assert.equal(f.local.spaceTabSnapshot.some(record => record.tabId === 3), false);
    assert.equal(f.durable.has(3), true);
});

test('dragged-out and replaced transient tabs remain excluded from adoption and restore-on-close', async () => {
    const f = fixture(); f.store.install(); await f.store.run(() => {});
    f.tabs[1].windowId = 1; chrome.tabs.onAttached.emit(2); await f.store.run(() => {});
    assert.equal(ownerOf(f.store.spaces, 2), undefined);
    const entered = gate(), release = gate();
    const pending = f.store.run(async () => { entered.resolve(); await release.promise; }); await entered.promise;
    f.tabs[1].id = 3; chrome.tabs.onReplaced.emit(3, 2);
    assert.equal(f.store.isTransientTab(3), true, 'Replacement must quarantine before queued ownership transfer');
    release.resolve(); await pending; await f.store.run(() => {});
    f.store.snapshotByTab.set(3, { tabId: 3, spaceId: 'b', url: 'https://transient.test/', section: 'temporaryTabs', order: 0 });
    f.tabs.splice(1, 1); chrome.tabs.onRemoved.emit(3, { windowId: 1, isWindowClosing: true }); await f.store.run(() => {});
    assert.equal(ownerOf(f.store.spaces, 3), undefined);
    assert.equal(f.store.restoreQueue.some(record => record.tabId === 3), false);
});

test('excluded tabs cannot be Today openers, inserted manually, or closed by clean', async () => {
    const f = fixture(); await f.store.dispatch({ action: 'get' });
    f.store.spaces[1].temporaryTabs.push(2);
    f.tabs[1].windowId = 1;
    const child = { id: 3, windowId: 1, openerTabId: 2, url: 'https://child.test/' };
    assert.equal(f.store.exactTodayOpener(child, f.tabs), null);
    f.store.insertCreatedToday(f.store.spaces[0], f.tabs[1]);
    assert.equal(f.store.spaces[0].temporaryTabs.includes(2), false);
    await f.store.closeOwnedTabs('b', { windowId: 1, temporaryOnly: true });
    assert.deepEqual(f.mutations, []);
});

test('projection ignores contaminated membership and never treats transient as Favorite detachment', async () => {
    const f = fixture(); f.sync.syncTabGroups = true;
    f.tabs[1].groupId = 22; f.groups.push({ id: 22, windowId: 9, title: 'Old', color: 'grey', collapsed: true });
    await syncSpaceGroups([space('b', [2])], { 9: 'a' }, [2], f.options);
    assert.deepEqual(f.mutations, []);
});

test('native projection protects dragged-out transient groups and skips their window reorder', async () => {
    const f = fixture(); f.registry.observe(f.tabs[1]); f.tabs[1].windowId = 1;
    f.tabs[0].groupId = 11; f.tabs[1].groupId = 22;
    f.tabs[0].index = 1; f.tabs[1].index = 0;
    f.groups.push({ id: 11, windowId: 1, title: 'a', color: 'blue', collapsed: false }, { id: 22, windowId: 1, title: 'b', color: 'blue', collapsed: false });
    f.session.spaceGroupProjection = { 'a:1': 11, 'b:1': 22 }; f.sync.syncTabGroups = true;
    await syncSpaceGroups([space('a', [1]), space('b', [2])], {}, [], f.options);
    assert.deepEqual(f.mutations, []);
    f.tabs[0].groupId = 22;
    await detachGlobalTabs([1], f.options);
    assert.deepEqual(f.mutations, [], 'Detaching a Favorite cannot shift an excluded tab sharing its group');
});

test('fresh native checks observe exclusion appearing after projection membership was sampled', async () => {
    const f = fixture({ transientWindows: [] }); f.sync.syncTabGroups = true;
    const query = chrome.tabs.query; let queries = 0;
    chrome.tabs.query = async filter => {
        if (++queries === 2) f.windows.add(1);
        return query(filter);
    };
    await syncSpaceGroups([space('a', [1])], {}, [], f.options);
    assert.deepEqual(f.mutations, []);
    assert.equal(f.durable.has(1), true);
});

test('an exclusion arriving during checkpoint validation rebuilds snapshots and window signatures', async () => {
    const f = fixture(); await f.store.dispatch({ action: 'get' });
    let observed = false;
    await f.store.run(() => f.store.persist({ beforeWrite: async () => {
        if (observed) return;
        observed = true; f.windows.add(1); f.registry.observe(f.tabs[0]);
    } }));
    assert.deepEqual(f.local.spaceTabSnapshot, []);
    assert.deepEqual(f.local.spaceWindowSnapshot, []);
    assert.deepEqual(f.session.spaceWindowKeys, []);
    assert.equal(ownerOf(f.store.spaces, 1), undefined);
});

test('native close revalidates exclusion after the exact tab read', async () => {
    const f = fixture(); await f.store.dispatch({ action: 'get' });
    const get = chrome.tabs.get;
    chrome.tabs.get = async id => { const tab = await get(id); f.excluded.add(id); return tab; };
    await f.store.closeOwnedTabs('a', { windowId: 1 });
    assert.deepEqual(f.mutations, []);
});

test('Favorite detachment rechecks window exclusion after its fresh query', async () => {
    const f = fixture({ transientWindows: [] }); f.tabs[0].groupId = 10;
    const query = chrome.tabs.query; let reads = 0;
    chrome.tabs.query = async filter => { if (++reads === 2) f.windows.add(1); return query(filter); };
    await detachGlobalTabs([1], f.options);
    assert.deepEqual(f.mutations, []);
    assert(f.durable.has(1));
});

test('proven same-session exact replay still excludes transient IDs and their saved pin metadata', async () => {
    const f = fixture({ cold: true });
    const identity = { epoch: crypto.randomUUID(), generation: crypto.randomUUID() };
    f.local.spaceTabSnapshot = f.tabs.map(tab => ({ tabId: tab.id, spaceId: 'b', section: 'spaceBookmarks', order: tab.id,
        url: tab.url, windowKey: `window-${tab.windowId}`, pinnedState: { bookmarkId: `bookmark-${tab.id}`, pinnedUrl: tab.url } }));
    f.local.spaceContinuityStamp = await createSpaceContinuityStamp(identity, f.local.spaceTabSnapshot);
    f.store.favoriteStore = { initialize: async () => {}, reconcile: async () => {}, ownsTab: () => false,
        ownershipPersistence: { browserIdentity: async () => identity } };
    await f.store.dispatch({ action: 'get' });
    assert.equal(ownerOf(f.store.spaces, 1)?.id, 'b');
    assert.equal(ownerOf(f.store.spaces, 2), undefined);
    assert.equal(f.local.pinnedTabStatesById[2], undefined);
    assert.deepEqual(f.local.spaceTabSnapshot.map(record => record.tabId), [1]);
});

test('the real session registry survives store restart without adopting a dragged-out member', async () => {
    const f = fixture();
    const token = crypto.randomUUID();
    f.tabs.forEach(tab => { tab.incognito = false; tab.pinned = false; });
    f.tabs.push({ id: 20, windowId: 9, index: 1, groupId: -1, pinned: false, incognito: false,
        url: `${chrome.runtime.getURL('transient-window.html')}?token=${token}` });
    f.session[TRANSIENT_WINDOW_SESSION_KEY] = { version: 1, records: [{ token, originWindowId: 1, windowId: 9,
        controllerTabId: 20, tabId: 2, memberTabIds: [20, 2], phase: 'ready' }] };
    f.store.transientWindows = createTransientWindowStore();
    await f.store.dispatch({ action: 'get' });
    assert.equal(ownerOf(f.store.spaces, 2), undefined);
    f.tabs[1].windowId = 1;
    const next = new SpaceStore(); next.transientWindows = createTransientWindowStore();
    await next.dispatch({ action: 'get' });
    assert.equal(next.isTransientTab(2), true);
    assert.equal(ownerOf(next.spaces, 2), undefined);
    assert.equal(next.isGlobalTab(2), false);
    assert.equal(f.session[TRANSIENT_WINDOW_SESSION_KEY].records[0].phase, 'uncertain');
});

test('collapsed-group expansion rechecks exclusion after reading native group metadata', async () => {
    const f = fixture({ transientWindows: [] }); f.sync.syncTabGroups = true;
    f.tabs[0].active = true; f.tabs[1].windowId = 1; f.tabs[1].groupId = 22;
    f.groups.push({ id: 22, windowId: 1, title: 'a', color: 'blue', collapsed: true });
    f.session.spaceGroupProjection = { 'a:1': 22 };
    const query = chrome.tabGroups.query;
    chrome.tabGroups.query = async filter => { if (filter.windowId === 1) f.excluded.add(1); return query(filter); };
    await syncSpaceGroups([space('a', [1])], {}, [], f.options);
    assert.deepEqual(f.mutations, []);
});

test('member reordering rechecks exclusion after the fresh native group member query', async () => {
    const f = fixture(); f.sync.syncTabGroups = true;
    f.tabs[0].groupId = 11; f.tabs[0].index = 1;
    f.tabs.push({ id: 3, windowId: 1, index: 0, groupId: 11, url: 'https://third.test/' });
    f.groups.push({ id: 11, windowId: 1, title: 'a', color: 'blue', collapsed: false });
    f.session.spaceGroupProjection = { 'a:1': 11 };
    const query = chrome.tabs.query;
    chrome.tabs.query = async filter => { if (filter.groupId === 11) f.windows.add(1); return query(filter); };
    await syncSpaceGroups([space('a', [1, 3])], {}, [], f.options);
    assert.deepEqual(f.mutations, []);
});

test('failed admission cannot leak staged Today ownership through the next successful read', async () => {
    const f = fixture(); await f.store.dispatch({ action: 'get' });
    f.tabs[1].windowId = 1;
    const persist = f.store.persist;
    f.store.persist = async () => { throw new Error('Checkpoint failed'); };
    await assert.rejects(f.store.run(() => f.registry.withAdmission(2, async () => {
        await f.store.applyAction({ action: 'assign', tabId: 2, spaceId: 'b' });
    })), /Checkpoint failed/);
    f.store.persist = persist;
    assert.equal(ownerOf(f.store.spaces, 2), undefined, 'The failed operation must clear in-memory staged ownership');
    f.store.spaces[1].temporaryTabs.push(2); f.store.spaces[1].lastTab = 2;
    const result = await f.store.dispatch({ action: 'get' });
    assert.equal(ownerOf(result, 2), undefined, 'A successful read must never expose quarantined membership');
    assert.equal(result[1].lastTab, undefined);
    assert.equal(f.mutations.some(([kind]) => kind === 'move'), false);
});

test('close events retain transient exclusion even if registry pruning happens before queued cleanup', async () => {
    const f = fixture(); f.store.install(); await f.store.run(() => {});
    f.store.snapshotByTab.set(2, { tabId: 2, spaceId: 'b', url: f.tabs[1].url, section: 'temporaryTabs', order: 0 });
    f.registry.observeRemoved = id => { f.excluded.delete(id); f.windows.delete(9); };
    f.tabs.splice(1, 1);
    chrome.tabs.onRemoved.emit(2, { windowId: 9, isWindowClosing: true });
    await f.store.run(() => {});
    assert.equal(f.store.restoreQueue.some(record => record.tabId === 2), false);
});

test('whole-group reordering checks exclusion again after its final native window read', async () => {
    const f = fixture({ transientWindows: [] }); f.sync.syncTabGroups = true;
    f.tabs[0].groupId = 11; f.tabs[0].index = 1;
    f.tabs[1].windowId = 1; f.tabs[1].groupId = 22; f.tabs[1].index = 0;
    f.groups.push({ id: 11, windowId: 1, title: 'a', color: 'blue', collapsed: false }, { id: 22, windowId: 1, title: 'b', color: 'blue', collapsed: false });
    f.session.spaceGroupProjection = { 'a:1': 11, 'b:1': 22 };
    const query = chrome.tabs.query; let windowReads = 0;
    chrome.tabs.query = async filter => { if (filter.windowId === 1 && ++windowReads === 4) f.windows.add(1); return query(filter); };
    await syncSpaceGroups([space('a', [1]), space('b', [2])], {}, [], f.options);
    assert.equal(windowReads, 4);
    assert.deepEqual(f.mutations, []);
});

for (const cold of [false, true]) {
    test(`${cold ? 'cold' : 'warm'} ordinary window-close preserves restoration with an empty transient registry`, async () => {
        const f = fixture({ transientWindows: [], initialTabs: [{ id: 1, windowId: 10, index: 0, groupId: -1,
            pinned: false, incognito: false, url: 'https://ordinary-close.test/' }] });
        f.local.spaceTabSnapshot = [{ tabId: 1, spaceId: 'a', section: 'temporaryTabs', order: 0,
            url: f.tabs[0].url, windowKey: 'ordinary-window', tabIndex: 0 }];
        f.store.transientWindows = createTransientWindowStore();
        f.store.install();
        if (!cold) await f.store.run(() => {});
        else {
            assert.equal(f.store.isTransientTab(1), true, 'The public predicate intentionally fails closed until loaded');
            assert.equal(f.store.transientWindows.isKnownExcluded({ id: 1, windowId: 10 }), false);
        }
        f.tabs.splice(0, 1);
        chrome.tabs.onRemoved.emit(1, { windowId: 10, isWindowClosing: true });
        await f.store.run(() => {});
        if(cold){assert.equal(f.store.restoreQueue.length,1);assert.equal(f.store.restoreQueue[0].tabId,1);}
        else {assert.equal(f.store.restoreQueue.length,0);assert(f.local.spaceDurableTodayLayout.cohorts.some(c=>c.signature.some(t=>t.url==='https://ordinary-close.test/')&&c.placements.length));}
    });
}

test('cold known-transient removal remains excluded while ordinary cold events are re-evaluated', async () => {
    const f = fixture({ initialTabs: [{ id: 1, windowId: 9, index: 0, groupId: -1,
        pinned: false, incognito: false, url: 'https://transient-close.test/' }] });
    const token = crypto.randomUUID();
    const controller = { id: 20, windowId: 9, index: 1, groupId: -1, pinned: false, incognito: false,
        url: `${chrome.runtime.getURL('transient-window.html')}?token=${token}` };
    f.tabs.push(controller);
    f.local.spaceTabSnapshot = [{ tabId: 1, spaceId: 'a', section: 'temporaryTabs', order: 0,
        url: f.tabs[0].url, windowKey: 'transient-window', tabIndex: 0 }];
    const registry = createTransientWindowStore(); f.store.transientWindows = registry;
    registry.observe(controller); registry.observe(f.tabs[0]);
    assert.equal(registry.isKnownExcluded(f.tabs[0]), true);
    f.store.install();
    f.tabs.splice(0, 1); chrome.tabs.onRemoved.emit(1, { windowId: 9, isWindowClosing: true });
    await f.store.run(() => {});
    assert.equal(f.store.restoreQueue.length, 0);
    assert.equal(f.local.spaceTabSnapshot.some(record => record.tabId === 1), false);
});
