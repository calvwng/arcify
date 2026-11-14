// Local diagnostic regression probe; not published or part of a proposed guard fix.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './today-recovery-fixture.js';
import { SpaceStore } from '../../space-store.js';
import { moveTodayTabsToSpace } from '../../today-move-store.js';
import { pendingLayoutWindowIds } from '../../durable-today-layout.js';
import { explicitTodayEpochs } from '../../explicit-today-ownership.js';

test('known same-session reload then sync-on preserves projection of exact Today move', async () => {
    const f = fixture();
    await f.store.persist();
    const store = new SpaceStore();
    store.discoverBookmarkSpaces = async () => false;
    await store.initialize();
    f.sync.syncTabGroups = true;
    assert.deepEqual((await moveTodayTabsToSpace(store, f.request)).completed, [1, 3]);
    assert.equal(pendingLayoutWindowIds(store, f.tabs, await explicitTodayEpochs(store)).has(10), false);
    assert(Number.isInteger(f.session.spaceGroupProjection['target:10']));
    assert.equal(f.tabs.find(tab => tab.id === 1).groupId, f.session.spaceGroupProjection['target:10']);
});
