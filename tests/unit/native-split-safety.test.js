import test from 'node:test';
import assert from 'node:assert/strict';
import { hasNativeSplit, assertNotNativeSplit, assertNativeSplitMembershipPreserved, NATIVE_SPLIT_MOVE_ERROR } from '../../native-split-safety.js';
import { SpaceStore } from '../../space-store.js';
import { syncSpaceGroups, detachGlobalTabs } from '../../tab-group-sync.js';

const copy = value => structuredClone(value);
const space = (id, ids = []) => ({ id, name: id, color: 'blue', spaceBookmarks: [], temporaryTabs: ids });
const pair = (splitViewId = 0) => [1, 2].map(id => ({ id, windowId: 10, splitViewId }));
const rejectsSplit = error => error.message === NATIVE_SPLIT_MOVE_ERROR && error.code === 'NATIVE_SPLIT_ACTIVE';

test('native split detection accepts zero and positive integers, not absent/sentinel/malformed values', () => {
    for (const splitViewId of [0, 1, 21, Number.MAX_SAFE_INTEGER]) {
        assert.equal(hasNativeSplit({ splitViewId }), true);
        assert.throws(() => assertNotNativeSplit({ splitViewId }), rejectsSplit);
    }
    for (const splitViewId of [undefined, null, -1, -2, '0', 0.5, NaN, Infinity, true, {}]) {
        assert.equal(hasNativeSplit({ splitViewId }), false);
        assert.doesNotThrow(() => assertNotNativeSplit({ splitViewId }));
    }
    assert.equal(hasNativeSplit(null), false);
});

for (const change of ['promote', 'other-space', 'reverse', 'delete-space', 'duplicate', 'new-between']) {
    test(`canonical split preservation rejects ${change}`, () => {
        const before = [space('a', [3, 1, 2, 4]), space('b')], after = copy(before);
        if (change === 'promote') { after[0].temporaryTabs = [3, 2, 4]; after[0].spaceBookmarks = [1]; }
        if (change === 'other-space') { after[0].temporaryTabs = [3, 2, 4]; after[1].temporaryTabs = [1]; }
        if (change === 'reverse') after[0].temporaryTabs = [3, 2, 1, 4];
        if (change === 'delete-space') after.shift();
        if (change === 'duplicate') after[1].temporaryTabs.push(1);
        if (change === 'new-between') after[0].temporaryTabs = [3, 1, 5, 2, 4];
        assert.throws(() => assertNativeSplitMembershipPreserved(before, after, pair()), rejectsSplit);
    });
}

test('canonical split preservation allows metadata, Space reorder, unrelated additions/removals and unchanged existing interleaving', () => {
    const before = [space('a', [3, 1, 2, 4]), space('b', [6])];
    const after = [space('b', [7, 6]), { ...space('a', [5, 1, 2, 4, 8]), name: 'Renamed' }];
    assert.doesNotThrow(() => assertNativeSplitMembershipPreserved(before, after, pair()));
    assert.doesNotThrow(() => assertNativeSplitMembershipPreserved([space('a', [1, 9, 2])], [space('a', [1, 9, 2])], pair()));
});

test('same split number in different windows does not create an inferred peer relationship', () => {
    const before = [space('a', [1, 2])], after = [space('a', [1, 9, 2])];
    assert.doesNotThrow(() => assertNativeSplitMembershipPreserved(before, after, [{ ...pair()[0] }, { ...pair()[1], windowId: 20 }]));
});

function actionFixture() {
    const store = new SpaceStore(); store.initialized = true;
    store.spaces = [space('a', [3, 1, 2, 4]), space('b')];
    store.restoredRanks = new Map([[1, 1], [2, 2]]);
    store.provisional = new Set([1]); store.recoveryCandidates = new Set([1]);
    store.isGlobalTab = () => false;
    const effects = [], tabs = [...pair(), { id: 3, windowId: 10 }, { id: 4, windowId: 10 }];
    store.persist = async () => effects.push('persist');
    globalThis.chrome = { tabs: { query: async () => copy(tabs) } };
    return { store, effects, tabs };
}

test('Space patch validates the fresh merged canonical result before changing memory, ranks or persistence', async () => {
    const f = actionFixture(), before = copy(f.store.spaces), after = copy(before);
    after[0].temporaryTabs = [3, 2, 1, 4];
    await assert.rejects(f.store.applyAction({ action: 'patch', before, after }), rejectsSplit);
    assert.deepEqual(f.store.spaces, before); assert.deepEqual([...f.store.restoredRanks], [[1, 1], [2, 2]]);
    assert.deepEqual(f.effects, []);
    after[0].temporaryTabs = [3, 1, 2, 4]; after[0].name = 'Updated';
    await f.store.applyAction({ action: 'patch', before, after });
    assert.equal(f.store.spaces[0].name, 'Updated'); assert.deepEqual(f.effects, ['persist']);
});

test('Space assignment rechecks current native split rather than a cached tab snapshot', async () => {
    const f = actionFixture(); f.store.liveTabs = new Map([[1, { id: 1, splitViewId: -1 }]]);
    const before = copy(f.store.spaces);
    await assert.rejects(f.store.applyAction({ action: 'assign', tabId: 1, spaceId: 'b', pinned: true }), rejectsSplit);
    assert.deepEqual(f.store.spaces, before); assert(f.store.provisional.has(1)); assert(f.store.recoveryCandidates.has(1));
    assert.deepEqual(f.effects, []);
    f.tabs[0].splitViewId = -1; f.tabs[1].splitViewId = -1;
    await f.store.applyAction({ action: 'assign', tabId: 1, spaceId: 'b', pinned: true });
    assert.deepEqual(f.store.spaces[1].spaceBookmarks, [1]);
});

function projectionFixture({ split = true, groupId = 20, expected = [1, 2, 3], otherWindow = false } = {}) {
    const tabs = [2, 1, 3].map((id, index) => ({ id, windowId: 10, groupId, index, pinned: false,
        ...(split && id !== 3 ? { splitViewId: 0 } : {}) }));
    if (otherWindow) tabs.push({ id: 4, windowId: 11, groupId: -1, index: 0, pinned: false });
    const spaces = [space('a', [...expected, ...(otherWindow ? [4] : [])])];
    const groups = groupId < 0 ? [] : [{ id: groupId, windowId: 10, title: 'a', color: 'blue', collapsed: false }];
    const session = { spaceGroupProjection: groupId < 0 ? {} : { 'a:10': groupId } }, calls = [], hooks = {};
    globalThis.chrome = {
        storage: { sync: { get: async () => ({ syncTabGroups: true }) }, session: {
            get: async () => copy(session), set: async update => Object.assign(session, copy(update))
        } },
        tabs: {
            query: async (query = {}) => { await hooks.query?.(query); return copy(tabs.filter(tab =>
                (query.windowId === undefined || tab.windowId === query.windowId) && (query.groupId === undefined || tab.groupId === query.groupId))); },
            group: async args => { calls.push(['group', copy(args)]); const id = args.groupId ?? 50 + groups.length;
                if (!groups.some(group => group.id === id)) groups.push({ id, windowId: args.createProperties.windowId });
                for (const tab of tabs) if (args.tabIds.includes(tab.id)) tab.groupId = id; return id; },
            move: async (ids, options) => { calls.push(['move', copy(ids), options]); },
            ungroup: async ids => { calls.push(['ungroup', copy(ids)]); for (const tab of tabs) if (ids.includes(tab.id)) tab.groupId = -1; }
        },
        tabGroups: { query: async () => copy(groups), update: async (id, attrs) => { calls.push(['update', id, attrs]); Object.assign(groups.find(group => group.id === id), attrs); },
            move: async (id, options) => calls.push(['groupMove', id, options]) }
    };
    return { tabs, spaces, session, calls, hooks, groups };
}

for (const groupId of [-1, 20]) test(`projection preserves split tabs and native grouping (${groupId < 0 ? 'ungrouped' : 'grouped'}) while other windows continue`, async () => {
    const f = projectionFixture({ groupId, otherWindow: true }), before = copy(f.tabs.filter(tab => tab.windowId === 10));
    await syncSpaceGroups(f.spaces, { 10: 'other', 11: 'a' });
    assert.deepEqual(f.tabs.filter(tab => tab.windowId === 10), before);
    assert(f.calls.some(([kind, args]) => kind === 'group' && args.tabIds[0] === 4));
    assert(f.calls.every(([kind, args]) => kind === 'group' ? args.tabIds.every(id => id === 4) : kind === 'update'));
    if (groupId >= 0) assert.equal(f.session.spaceGroupProjection['a:10'], groupId, 'Keep the previous group identity for after End Split View');
});

test('unowned split members also block structural writes to their native group', async () => {
    const f = projectionFixture({ expected: [3] });
    await syncSpaceGroups(f.spaces, { 10: 'other' });
    assert.deepEqual(f.calls, []);
});

test('projection resumes and restores canonical member order after End Split View', async () => {
    const f = projectionFixture(); await syncSpaceGroups(f.spaces); assert.deepEqual(f.calls, []);
    for (const tab of f.tabs) tab.splitViewId = -1;
    await syncSpaceGroups(f.spaces);
    assert.deepEqual(f.calls, [['move', [1, 2, 3], { index: 0 }]]);
});

test('a split created after the initial snapshot is rechecked immediately before grouping', async () => {
    const f = projectionFixture({ split: false, groupId: -1 }); let windowQueries = 0;
    f.hooks.query = query => { if (query.windowId === 10 && ++windowQueries === 1) for (const tab of f.tabs) if (tab.id !== 3) tab.splitViewId = 0; };
    await syncSpaceGroups(f.spaces); assert.deepEqual(f.calls, []);
});

test('a split created during group-member query prevents the subsequent tabs.move', async () => {
    const f = projectionFixture({ split: false });
    f.hooks.query = query => { if (query.groupId === 20) for (const tab of f.tabs) if (tab.id !== 3) tab.splitViewId = 0; };
    await syncSpaceGroups(f.spaces); assert.deepEqual(f.calls, []);
});

test('a member moved into a split in another window cannot be dragged back by stale group projection', async () => {
    const f = projectionFixture({ split: false, groupId: -1 }); let windowQueries = 0;
    f.hooks.query = query => { if (query.windowId === 10 && ++windowQueries === 1) { f.tabs[0].windowId = 20; f.tabs[0].splitViewId = 5; } };
    await syncSpaceGroups(f.spaces); assert.deepEqual(f.calls, []);
});

test('a late split prevents native group-block moves even when all owned members are already ordered', async () => {
    const f = projectionFixture({ split: false, expected: [2, 1, 3] });
    f.tabs.push({ id: 9, windowId: 10, groupId: -1, index: 3 }); let windowQueries = 0;
    f.hooks.query = query => { if (query.windowId === 10 && ++windowQueries === 2) { f.tabs[0].splitViewId = 0; f.tabs[1].splitViewId = 0; } };
    await syncSpaceGroups(f.spaces); assert.deepEqual(f.calls, []);
});

test('exact global detachment skips split-containing native groups and still detaches other groups', async () => {
    const f = projectionFixture({ otherWindow: true }); f.tabs.at(-1).groupId = 40;
    await detachGlobalTabs([1, 3, 4]);
    assert.deepEqual(f.calls, [['ungroup', [4]]]);
    assert.equal(f.tabs.find(tab => tab.id === 1).groupId, 20); assert.equal(f.tabs.find(tab => tab.id === 3).groupId, 20);
});

test('global detachment rechecks for a split created since its initial query, even with group sync disabled', async () => {
    const f = projectionFixture({ split: false });
    chrome.storage.sync.get = async () => ({ syncTabGroups: false });
    f.hooks.query = query => { if (query.windowId === 10) { f.tabs[0].splitViewId = 0; f.tabs[1].splitViewId = 0; } };
    await syncSpaceGroups(f.spaces, {}, [1]); assert.deepEqual(f.calls, []);
});

test('unrelated same-window Space membership and collapse continue while protected split group order stays untouched', async () => {
    const f = projectionFixture({ expected: [1, 2] });
    f.tabs.find(tab => tab.id === 3).groupId = -1;
    f.spaces.push(space('b', [3]));
    const beforePair = copy(f.tabs.filter(tab => tab.id !== 3));
    await syncSpaceGroups(f.spaces, { 10: 'a' });
    assert.deepEqual(f.tabs.filter(tab => tab.id !== 3), beforePair);
    assert(f.calls.some(([kind, args]) => kind === 'group' && JSON.stringify(args.tabIds) === '[3]'));
    assert(f.calls.some(([kind, id, attrs]) => kind === 'update' && id !== 20 && attrs.collapsed));
    assert(!f.calls.some(([kind]) => ['move', 'groupMove', 'ungroup'].includes(kind)));
    assert.deepEqual(f.session.spaceGroupSplitDeferrals, [{ spaceId: 'a', windowId: 10, reason: 'native-split' }]);
});

test('active and inactive switching can collapse/expand a recorded exact split group without changing pair order', async () => {
    const f = projectionFixture({ expected: [2, 1] }); f.tabs.splice(2, 1);
    const before = copy(f.tabs);
    await syncSpaceGroups(f.spaces, { 10: 'b' });
    await syncSpaceGroups(f.spaces, { 10: 'a' });
    assert.deepEqual(f.calls, [
        ['update', 20, { title: 'a', color: 'blue', collapsed: true }],
        ['update', 20, { title: 'a', color: 'blue', collapsed: false }]
    ]);
    assert.deepEqual(f.tabs, before); assert.deepEqual(f.session.spaceGroupSplitDeferrals, []);
});

test('incompatible target native group preserves its mapping and reports only exact partition identifiers', async () => {
    const f = projectionFixture({ expected: [3] }); f.tabs.find(tab => tab.id === 3).groupId = -1;
    const before = copy(f.tabs);
    const result = await syncSpaceGroups(f.spaces, { 10: 'other' });
    assert.deepEqual(f.calls, []); assert.deepEqual(f.tabs, before); assert.equal(f.session.spaceGroupProjection['a:10'], 20);
    const expected = [{ spaceId: 'a', windowId: 10, reason: 'native-split' }];
    assert.deepEqual(result, { deferred: expected }); assert.deepEqual(f.session.spaceGroupSplitDeferrals, expected);
});

test('a partial or cross-group split partition never collapses somebody else’s pane', async () => {
    for (const otherPaneGroupId of [20, 30]) {
        const f = projectionFixture({ expected: [1] }); f.tabs.find(tab => tab.id === 2).groupId = otherPaneGroupId;
        await syncSpaceGroups(f.spaces, { 10: 'other' });
        assert.deepEqual(f.calls, []); assert.equal(f.session.spaceGroupSplitDeferrals.length, 1);
    }
});

test('session deferrals clear after the native split ends or group sync is disabled', async () => {
    const f = projectionFixture(); await syncSpaceGroups(f.spaces);
    assert.equal(f.session.spaceGroupSplitDeferrals.length, 1);
    for (const tab of f.tabs) tab.splitViewId = -1;
    await syncSpaceGroups(f.spaces); assert.deepEqual(f.session.spaceGroupSplitDeferrals, []);
    f.session.spaceGroupSplitDeferrals = [{ spaceId: 'a', windowId: 10, reason: 'native-split' }];
    chrome.storage.sync.get = async () => ({ syncTabGroups: false });
    await syncSpaceGroups(f.spaces); assert.deepEqual(f.session.spaceGroupSplitDeferrals, []);
});

test('global detachment preserves a split’s group while detaching an unrelated group in the same window', async () => {
    const f = projectionFixture(); f.tabs.find(tab => tab.id === 3).groupId = 30;
    await detachGlobalTabs([1, 3]); assert.deepEqual(f.calls, [['ungroup', [3]]]);
    assert.equal(f.tabs.find(tab => tab.id === 1).groupId, 20); assert.equal(f.tabs.find(tab => tab.id === 2).groupId, 20);
});

test('deferred cosmetic native group-block ordering resumes when the last split ends', async () => {
    const f = projectionFixture({ expected: [2, 1, 3] }); f.tabs.push({ id: 9, windowId: 10, groupId: -1, index: 3 });
    await syncSpaceGroups(f.spaces); assert.deepEqual(f.calls, []);
    for (const tab of f.tabs) tab.splitViewId = -1;
    await syncSpaceGroups(f.spaces); assert.deepEqual(f.calls, [['groupMove', 20, { index: -1 }]]);
});

test('an unrelated tab may cross an intact ordered canonical pair without splitting it', () => {
    const before = [space('a', [3, 1, 2, 4])];
    for (const ids of [[1, 2, 3, 4], [3, 4, 1, 2], [4, 1, 2, 3]]) {
        assert.doesNotThrow(() => assertNativeSplitMembershipPreserved(before, [space('a', ids)], pair()));
    }
});

test('unmatched and already interleaved native members retain conservative canonical position guards', () => {
    const before = [space('a', [1, 3, 2, 4])], after = [space('a', [3, 1, 2, 4])];
    assert.throws(() => assertNativeSplitMembershipPreserved(before, after, pair()), rejectsSplit);
    assert.throws(() => assertNativeSplitMembershipPreserved(before, after, [pair()[0]]), rejectsSplit);
});

test('unrelated member reorder uses the final group position so a moved native split cannot inherit a stale insertion point', async () => {
    const f = projectionFixture({ split: false });
    for (const tab of f.tabs) tab.index++;
    f.tabs.push({ id: 8, windowId: 10, groupId: 30, index: 4, splitViewId: 8 },
        { id: 9, windowId: 10, groupId: 30, index: 5, splitViewId: 8 },
        { id: 10, windowId: 10, groupId: -1, index: 0 });
    let groupRead = false;
    f.hooks.query = query => {
        if (query.groupId === 20) groupRead = true;
        if (query.windowId === 10 && groupRead) {
            f.tabs.find(tab => tab.id === 8).index = 0; f.tabs.find(tab => tab.id === 9).index = 1;
            f.tabs.find(tab => tab.id === 2).index = 2; f.tabs.find(tab => tab.id === 1).index = 3;
            f.tabs.find(tab => tab.id === 3).index = 4; f.tabs.find(tab => tab.id === 10).index = 5;
        }
    };
    await syncSpaceGroups(f.spaces);
    assert.deepEqual(f.calls, [['move', [1, 2, 3], { index: 2 }]], 'The stale index 1 is now between the native panes');
});

test('a target native group moved to another window cannot pull an unrelated tab into its new split', async () => {
    const f = projectionFixture({ split: false, expected: [3] }); f.tabs.find(tab => tab.id === 3).groupId = -1;
    f.hooks.query = query => {
        if (query.windowId === 10) for (const tab of f.tabs) if (tab.groupId === 20) { tab.windowId = 20; tab.splitViewId = 0; }
    };
    await syncSpaceGroups(f.spaces); assert.deepEqual(f.calls, []);
});
