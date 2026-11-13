import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './today-recovery-fixture.js';
import { explicitTodayEpochs } from '../../explicit-today-ownership.js';
import { pendingLayoutWindowIds } from '../../durable-today-layout.js';

test('a current fully bound ordinary window projects an exact move despite unrelated pending historical URL collisions', async () => {
    const f = fixture({ syncGroups: true });
    await f.store.persist();
    const current = f.store.durableLayout.cohorts.find(c => c.binding?.windowId === 10);
    assert(current); assert(!current.explicitOnly); assert(!current.contextSubset);
    const historical = structuredClone(current);
    historical.id = 'pending-history'; historical.binding = null;
    f.store.durableLayout.cohorts.push(historical);
    f.store.layoutPending.add(historical.id);
    const history = structuredClone(historical);
    const result = await f.move();
    assert.deepEqual(result.completed, [1, 3]);
    assert(f.store.spaces.find(s => s.id === 'target').temporaryTabs.includes(1));
    assert.deepEqual(f.store.durableLayout.cohorts.find(c => c.id === historical.id), history);
    assert(f.store.layoutPending.has(historical.id));
    assert.equal(pendingLayoutWindowIds(f.store, f.tabs, await explicitTodayEpochs(f.store)).has(10), false);
    assert.equal(f.tabs.find(t => t.id === 1).groupId, f.session.spaceGroupProjection['target:10']);
});

for (const change of ['subset', 'missing-tab', 'unknown-tab', 'reorder', 'navigation', 'new-epoch', 'conflicting-owner']) test(`ordinary current projection remains deferred with ${change}`, async () => {
    const f = fixture(); await f.store.persist();
    const current = f.store.durableLayout.cohorts.find(c => c.binding?.windowId === 10);
    const historical = structuredClone(current); historical.id = 'pending-history'; historical.binding = null;
    f.store.durableLayout.cohorts.push(historical); f.store.layoutPending.add(historical.id);
    let epochs = await explicitTodayEpochs(f.store);
    assert.equal(pendingLayoutWindowIds(f.store, f.tabs, epochs).has(10), false);
    if (change === 'subset') current.contextSubset = true;
    if (change === 'missing-tab') f.tabs.splice(f.tabs.findIndex(t => t.id === 1), 1);
    if (change === 'unknown-tab') f.tabs.push({ ...f.tabs[0], id: 999, index: 99 });
    if (change === 'reorder') [f.tabs[0].index, f.tabs[1].index] = [f.tabs[1].index, f.tabs[0].index];
    if (change === 'navigation') f.tabs[0].url = 'https://changed.test/';
    if (change === 'new-epoch') epochs = [{ kind: 'session', epoch: 'another-session' }];
    if (change === 'conflicting-owner') f.store.spaces.find(s => s.id === 'target').temporaryTabs.push(1);
    assert.equal(pendingLayoutWindowIds(f.store, f.tabs, epochs).has(10), true);
    assert(f.store.layoutPending.has(historical.id));
});

test('persisting an exact move cannot authorize native projection of an unresolved same-URL neighbour', async () => {
    const f = fixture({ syncGroups: true }); await f.store.persist();
    const current = f.store.durableLayout.cohorts.find(c => c.binding?.windowId === 10);
    const historical = structuredClone(current); historical.id = 'pending-history'; historical.binding = null;
    f.store.durableLayout.cohorts.push(historical); f.store.layoutPending.add(historical.id);
    f.tabs.push({ ...f.tabs[0], id: 999, index: 99, active: false, groupId: -1 });
    f.store.spaces.find(s => s.id === 'source').temporaryTabs.push(999);
    f.store.layoutProvisional = new Set([999]);
    // An exact explicit move preserves unresolved neighbours during persistence.
    f.store.recoveryCandidates.add(1);
    f.effects.length = 0;
    assert.deepEqual((await f.move()).completed, [1, 3]);
    assert(f.store.layoutProvisional.has(999));
    assert(!f.local.spaceTabSnapshot.some(t => t.tabId === 999));
    assert(f.store.layoutPending.has(historical.id));
    assert.equal(pendingLayoutWindowIds(f.store, f.tabs, await explicitTodayEpochs(f.store)).has(10), true);
    assert.equal(f.tabs.find(t => t.id === 999).groupId, -1, 'An unproven neighbour must not be projected from fallback membership.');
});

for (const flag of ['provisional', 'recoveryCandidates']) test(`a fully bound ordinary window remains deferred for a live ${flag} tab`, async () => {
    const f = fixture(); await f.store.persist();
    const current = f.store.durableLayout.cohorts.find(c => c.binding?.windowId === 10);
    const historical = structuredClone(current); historical.id = 'pending-history'; historical.binding = null;
    f.store.durableLayout.cohorts.push(historical); f.store.layoutPending.add(historical.id);
    const epochs = await explicitTodayEpochs(f.store);
    assert.equal(pendingLayoutWindowIds(f.store, f.tabs, epochs).has(10), false);
    f.store[flag].add(1);
    assert.equal(pendingLayoutWindowIds(f.store, f.tabs, epochs).has(10), true);
    assert(f.store.layoutPending.has(historical.id));
});
