import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './today-recovery-fixture.js';
import { SpaceStore } from '../../space-store.js';
import { moveTodayTabsToSpace } from '../../today-move-store.js';
import { layoutEvidence, layoutWindows, initializeDurableLayout, sealDurableLayout, DURABLE_LAYOUT_KEY } from '../../durable-today-layout.js';

async function load(f) {
    const store = new SpaceStore();
    store.discoverBookmarkSpaces = async () => false;
    await store.initialize();
    return store;
}

function nextBrowserEpoch(f) {
    for (const tab of f.tabs) tab.id += 1000;
    for (const key of Object.keys(f.session)) delete f.session[key];
}

async function setupChosenSubset() {
    const f = fixture();
    for (const tab of f.tabs) tab.url = `https://unique.test/${tab.id}`;
    const ids = [101, 102, 103];
    for (const [index, id] of ids.entries()) f.tabs.push({
        id, index: 20 + index, windowId: 10, url: `https://layout.test/${id}`,
        pinned: false, incognito: false, splitViewId: -1
    });
    f.store.spaces[0].temporaryTabs.push(...ids);
    f.store.windowKeys = new Map([[10, 'current'], [20, 'other']]);
    f.store.restoreWindowKeys = new Map();
    await f.store.persist();
    nextBrowserEpoch(f);
    f.tabs.find(tab => tab.id === 1001).url = 'https://changed-anchor.test/';
    const store = await load(f);
    store.active[10] = 'source';
    await moveTodayTabsToSpace(store, {
        ...f.request,
        entries: ids.map(id => ({ tabId: id + 1000, url: `https://layout.test/${id}` }))
    });
    const chosen = store.durableLayout.cohorts.find(cohort => cohort.explicitOnly);
    assert(chosen?.contextSubset);
    assert.deepEqual(chosen.binding.tabIds, [1101, 1102, 1103]);
    return { f, store, ids, chosenId: chosen.id };
}

for (const restartWorker of [false, true]) {
    test(`current-epoch chosen native reorder stays durable (restart worker=${restartWorker})`, async () => {
        const { f, store, ids, chosenId } = await setupChosenSubset();
        const a = f.tabs.find(tab => tab.id === 1101);
        const b = f.tabs.find(tab => tab.id === 1102);
        [a.index, b.index] = [b.index, a.index];
        const active = restartWorker ? await load(f) : store;
        assert(ids.every(id => active.explicitToday.has(id + 1000)), 'same-epoch witnesses survive');
        await active.persist();
        await active.persist();
        nextBrowserEpoch(f);
        const cold = await load(f);
        const observed = ids.map(id => cold.spaces.find(space => space.temporaryTabs.includes(id + 2000))?.id);
        const evidence = layoutEvidence(cold.durableLayout.cohorts, layoutWindows(cold, f.tabs))
            .find(item => item.cohort.id === chosenId)?.status;
        assert.deepEqual(observed, ['target', 'target', 'target'], `saved chosen evidence: ${evidence}`);
        assert(ids.every(id => cold.explicitToday.has(id + 2000)));
    });

    test(`navigation pending across current-epoch wake stays durable (restart worker=${restartWorker})`, async () => {
        const { f, store, ids, chosenId } = await setupChosenSubset();
        const tab = f.tabs.find(candidate => candidate.id === 1101);
        tab.pendingUrl = 'https://navigated.test/';
        const active = restartWorker ? await load(f) : store;
        await active.persist();
        assert(ids.every(id => active.explicitToday.has(id + 1000)), 'same-epoch witnesses survive');
        tab.url = 'https://navigated.test/';
        delete tab.pendingUrl;
        active.track({ ...tab });
        await active.persist();
        await active.persist();
        nextBrowserEpoch(f);
        const cold = await load(f);
        const observed = ids.map(id => cold.spaces.find(space => space.temporaryTabs.includes(id + 2000))?.id);
        const evidence = layoutEvidence(cold.durableLayout.cohorts, layoutWindows(cold, f.tabs))
            .find(item => item.cohort.id === chosenId)?.status;
        assert.deepEqual(observed, ['target', 'target', 'target'], `saved chosen evidence: ${evidence}`);
        assert(ids.every(id => cold.explicitToday.has(id + 2000)));
    });
}

test('completed navigation before current-epoch wake remains a working control', async () => {
    const { f, ids } = await setupChosenSubset();
    f.tabs.find(tab => tab.id === 1101).url = 'https://navigated.test/';
    const active = await load(f);
    await active.persist();
    nextBrowserEpoch(f);
    const cold = await load(f);
    assert.deepEqual(ids.map(id => cold.spaces.find(space => space.temporaryTabs.includes(id + 2000))?.id),
        ['target', 'target', 'target']);
    assert(ids.every(id => cold.explicitToday.has(id + 2000)));
});

test('pending navigation cannot write a partial cohort or lose saved anchors during wake', async () => {
    const { f, chosenId } = await setupChosenSubset();
    const original = structuredClone(f.local[DURABLE_LAYOUT_KEY].cohorts.find(c => c.id === chosenId));
    f.tabs.find(t => t.id === 1101).pendingUrl = 'https://navigating.test/';
    const active = await load(f);
    await active.persist();
    assert(!active.layoutPending.has(chosenId));
    assert.deepEqual(f.local[DURABLE_LAYOUT_KEY].cohorts.find(c => c.id === chosenId), original);
});

for (const change of ['missing', 'different-window', 'pinned', 'private', 'global', 'transient', 'blank-url',
    'duplicate-native-id', 'duplicate-owner', 'saved-owner', 'wrong-root', 'new-epoch']) {
    test(`same-session wake refuses identity authority after ${change}`, async () => {
        const { f, store, chosenId } = await setupChosenSubset();
        const tab = f.tabs.find(t => t.id === 1101);
        if (change === 'missing') f.tabs.splice(f.tabs.indexOf(tab), 1);
        if (change === 'different-window') tab.windowId = 20;
        if (change === 'pinned') tab.pinned = true;
        if (change === 'private') tab.incognito = true;
        if (change === 'global') store.isGlobalTab = value => (typeof value === 'object' ? value.id : value) === tab.id;
        if (change === 'transient') store.isTransientTab = value => (typeof value === 'object' ? value.id : value) === tab.id;
        if (change === 'blank-url') tab.url = '';
        if (change === 'duplicate-native-id') f.tabs.push({ ...tab, index: 99 });
        if (change === 'duplicate-owner') store.spaces[0].temporaryTabs.push(tab.id);
        if (change === 'saved-owner') store.spaces[0].spaceBookmarks.push(tab.id);
        if (change === 'wrong-root') store.spaces.find(s => s.id === 'target').bookmarkFolderId = 'changed-root';
        if (change === 'new-epoch') f.session.spaceExplicitTodayEpoch = 'new-epoch';
        const before = structuredClone(f.local[DURABLE_LAYOUT_KEY]);
        await initializeDurableLayout(store, f.local, f.tabs);
        assert(store.layoutPending.has(chosenId));
        assert.deepEqual(f.local[DURABLE_LAYOUT_KEY], before, 'classification is not a persistence operation');
    });
}

test('ordinary full-window same-session reorder refreshes ID-aligned placements', async () => {
    const f = fixture();
    for (const t of f.tabs) t.url = `https://unique.test/${t.id}`;
    await f.store.persist();
    const before = structuredClone(f.local[DURABLE_LAYOUT_KEY].cohorts.find(c => c.binding.windowId === 10));
    const a = f.tabs.find(t => t.id === 1), b = f.tabs.find(t => t.id === 4);
    [a.index, b.index] = [b.index, a.index];
    const active = await load(f);
    assert(!active.layoutPending.has(before.id));
    const after = active.durableLayout.cohorts.find(c => c.id === before.id);
    assert.deepEqual(after.binding.tabIds.slice(0, 4), [4, 2, 3, 1]);
    for (const old of before.placements) {
        const id = before.binding.tabIds[before.signature.findIndex(t => t.index === old.index)];
        const now = after.placements.find(p => p.index === f.tabs.find(t => t.id === id).index);
        assert.equal(now.spaceId, old.spaceId);
        assert.equal(now.order, old.order);
    }
});

test('same-session subset reorder does not absorb unrelated native tabs', async () => {
    const { f, chosenId } = await setupChosenSubset();
    [f.tabs.find(t => t.id === 1101).index, f.tabs.find(t => t.id === 1102).index] = [21, 20];
    f.tabs.push({ id: 9999, windowId: 10, index: 99, url: 'https://unrelated.test/', pinned: false });
    const active = await load(f);
    const chosen = active.durableLayout.cohorts.find(c => c.id === chosenId);
    assert.deepEqual(chosen.binding.tabIds, [1102, 1101, 1103]);
    assert.equal(chosen.signature.length, 3);
    assert(!chosen.binding.tabIds.includes(9999));
});

test('ordinary full-window unknown native IDs retain pending evidence', async () => {
    const f = fixture();
    await f.store.persist();
    const c = f.store.durableLayout.cohorts.find(c => c.binding.windowId === 10);
    f.tabs.push({ id: 9999, windowId: 10, index: 99, url: 'https://unrelated.test/', pinned: false });
    await initializeDurableLayout(f.store, f.local, f.tabs);
    assert(f.store.layoutPending.has(c.id));
});

test('all bound tabs can navigate during wake without losing the complete capture', async () => {
    const { f, ids, chosenId } = await setupChosenSubset();
    const original = structuredClone(f.local[DURABLE_LAYOUT_KEY].cohorts.find(c => c.id === chosenId));
    for (const id of ids) f.tabs.find(t => t.id === id + 1000).pendingUrl = `https://navigated.test/${id}`;
    const active = await load(f);
    assert.deepEqual(active.durableLayout.cohorts.find(c => c.id === chosenId), original);
    for (const id of ids) {
        const tab = f.tabs.find(t => t.id === id + 1000);
        tab.url = tab.pendingUrl; delete tab.pendingUrl;
        active.track({ ...tab });
    }
    await active.persist();
    nextBrowserEpoch(f);
    const cold = await load(f);
    assert.deepEqual(ids.map(id => cold.spaces.find(s => s.temporaryTabs.includes(id + 2000))?.id), ['target', 'target', 'target']);
});

for (const duplicate of ['same-space-today', 'same-space-bookmark', 'other-space-bookmark']) {
    test(`indexed wake membership still rejects ${duplicate}`, async () => {
        const { f, store, chosenId } = await setupChosenSubset();
        const target = store.spaces.find(s => s.id === 'target');
        if (duplicate === 'same-space-today') target.temporaryTabs.push(1101);
        else if (duplicate === 'same-space-bookmark') target.spaceBookmarks.push(1101);
        else store.spaces.find(s => s.id !== 'target').spaceBookmarks.push(1101);
        await initializeDurableLayout(store, f.local, f.tabs);
        assert(store.layoutPending.has(chosenId));
    });
}

test('wake indexes are rebuilt after membership changes between initializations', async () => {
    const { f, store, chosenId } = await setupChosenSubset();
    const other = store.spaces.find(s => s.id !== 'target');
    other.temporaryTabs.push(1101);
    await initializeDurableLayout(store, f.local, f.tabs);
    assert(store.layoutPending.has(chosenId));
    other.temporaryTabs = other.temporaryTabs.filter(id => id !== 1101);
    await initializeDurableLayout(store, f.local, f.tabs);
    assert(!store.layoutPending.has(chosenId));
});

test('native identity index does not confuse equal IDs from other windows', async () => {
    const { f, store, chosenId } = await setupChosenSubset();
    const tab = f.tabs.find(t => t.id === 1101);
    f.tabs.push({ ...tab, windowId: 999 });
    await initializeDurableLayout(store, f.local, f.tabs);
    assert(!store.layoutPending.has(chosenId), 'window-local duplicate policy is unchanged');
});


test('wake scans Space membership arrays once per snapshot, not per historical placement', async () => {
    const { f, store, chosenId } = await setupChosenSubset();
    const chosen = structuredClone(store.durableLayout.cohorts.find(c => c.id === chosenId));
    const cohorts = Array.from({ length: 100 }, (_, i) => ({ ...chosen, id: `history-${i}`, blockedBy: [] }));
    const data = { ...f.local, [DURABLE_LAYOUT_KEY]: await sealDurableLayout(store.durableLayout.revision, cohorts) };
    let iterations = 0;
    for (const space of store.spaces) for (const items of [space.temporaryTabs, space.spaceBookmarks]) {
        Object.defineProperty(items, Symbol.iterator, { configurable: true, value: function* () {
            iterations++;
            yield* Array.prototype.values.call(this);
        } });
    }
    await initializeDurableLayout(store, data, f.tabs);
    assert.equal(store.layoutPending.size, 0);
    assert.equal(iterations, store.spaces.length * 3,
        'one temporary-membership set and one occurrence-count pass over each Space');
});
