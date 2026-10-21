import test from 'node:test';
import assert from 'node:assert/strict';
import { syncSpaceGroups } from '../../tab-group-sync.js';

const permutations = values => values.length < 2 ? [values] : values.flatMap((value, index) =>
    permutations(values.filter((_, i) => i !== index)).map(rest => [value, ...rest]));

function fixture(orders = { 10: [101, 102] }) {
    let enabled = true;
    const moves = [], updates = [];
    const tabs = Object.entries(orders).flatMap(([windowId, ids]) => ids.map((groupId, index) =>
        ({ id: Number(windowId) * 1000 + groupId, windowId: Number(windowId), groupId, index })));
    const groups = tabs.filter(t => t.groupId > 0).map(t => ({ id: t.groupId, windowId: t.windowId,
        title: `Space ${t.groupId}`, color: 'grey', collapsed: false }));
    const projection = Object.fromEntries(groups.map(g => [`space-${g.id}:${g.windowId}`, g.id]));
    const spaces = [...groups].sort((a, b) => a.id - b.id).map(g => ({ id: `space-${g.id}`,
        name: g.title, color: g.color, spaceBookmarks: [], temporaryTabs: tabs.filter(t => t.groupId === g.id).map(t => t.id) }));
    globalThis.chrome = {
        storage: { sync: { get: async () => ({ syncTabGroups: enabled }) },
            session: { get: async () => ({ spaceGroupProjection: projection }), set: async () => {} } },
        tabs: { query: async filter => tabs.filter(t => (filter.groupId === undefined || t.groupId === filter.groupId)
            && (filter.windowId === undefined || t.windowId === filter.windowId)).map(t => ({ ...t })) },
        tabGroups: { query: async () => groups.map(g => ({ ...g })),
            move: async (id, options) => {
                moves.push({ id, options });
                const windowId = groups.find(g => g.id === id).windowId;
                const current = tabs.filter(t => t.windowId === windowId).sort((a, b) => a.index - b.index);
                const target = [...current.filter(t => t.groupId !== id), ...current.filter(t => t.groupId === id)];
                target.forEach((t, index) => { t.index = index; });
            },
            update: async (id, attrs) => { updates.push(id); Object.assign(groups.find(g => g.id === id), attrs); } }
    };
    return { moves, updates, spaces, setEnabled: value => { enabled = value; },
        order: windowId => tabs.filter(t => t.windowId === windowId).sort((a, b) => a.index - b.index).map(t => t.groupId) };
}

test('ordered projection emits no moves, including the follow-up event pass', async () => {
    const f = fixture();
    for (let i = 0; i < 3; i++) await syncSpaceGroups(f.spaces);
    assert.deepEqual(f.moves, []);
});

test('all three-group permutations converge and the next pass performs no mutations', async () => {
    for (const order of permutations([101, 102, 103])) {
        const f = fixture({ 10: order });
        await syncSpaceGroups(f.spaces);
        assert.deepEqual(f.order(10), [101, 102, 103]);
        const moves = f.moves.length;
        await syncSpaceGroups(f.spaces);
        assert.equal(f.moves.length, moves);
        assert.deepEqual(f.updates, []);
    }
});

test('space order uses numeric projected group IDs and respects disabled sync', async () => {
    const f = fixture();
    f.spaces.reverse();
    f.setEnabled(false);
    await syncSpaceGroups(f.spaces);
    assert.deepEqual(f.moves, []);
    f.setEnabled(true);
    await syncSpaceGroups(f.spaces);
    assert.deepEqual(f.order(10), [102, 101]);
    assert.deepEqual(f.moves, [{ id: 101, options: { index: -1 } }]);
    await syncSpaceGroups(f.spaces);
    assert.equal(f.moves.length, 1);
});

test('projection settles independently in multiple windows and preserves ungrouped tabs', async () => {
    const f = fixture({ 10: [102, -1, 101], 20: [104, 103] });
    await syncSpaceGroups(f.spaces);
    assert.deepEqual(f.order(10), [-1, 101, 102]);
    assert.deepEqual(f.order(20), [103, 104]);
    const moves = f.moves.length;
    await syncSpaceGroups(f.spaces);
    assert.equal(f.moves.length, moves);
});

function memberFixture({ windows = { 10: [3, 2, 1, 9] }, expected = [1, 2, 3], missingOnGroupQuery = [], enabled = true } = {}) {
    const calls = [];
    const tabs = Object.entries(windows).flatMap(([windowId, ids]) => ids.map((id, index) => ({
        id, windowId: Number(windowId), groupId: Number(windowId) + 100, index, pinned: false,
        url: id === 9 ? 'chrome-extension://arcify/options.html' : `https://tab-${id}.test/`
    })));
    const groups = Object.keys(windows).map(windowId => ({ id: Number(windowId) + 100,
        windowId: Number(windowId), title: 'Home', color: 'grey', collapsed: false }));
    const projection = Object.fromEntries(groups.map(group => [`home:${group.windowId}`, group.id]));
    const spaces = [{ id: 'home', name: 'Home', color: 'grey', spaceBookmarks: [], temporaryTabs: [...expected] }];
    const order = windowId => tabs.filter(tab => tab.windowId === windowId).sort((a, b) => a.index - b.index);
    const renumber = windowId => order(windowId).forEach((tab, index) => { tab.index = index; });
    globalThis.chrome = {
        storage: { sync: { get: async () => ({ syncTabGroups: enabled }) },
            session: { get: async () => ({ spaceGroupProjection: projection }), set: async () => {} } },
        tabs: {
            query: async (filter = {}) => {
                if (filter.groupId !== undefined && missingOnGroupQuery.length) {
                    for (const id of missingOnGroupQuery.splice(0)) {
                        const index = tabs.findIndex(tab => tab.id === id);
                        if (index >= 0) { const [{ windowId }] = tabs.splice(index, 1); renumber(windowId); }
                    }
                }
                return tabs.filter(tab => (filter.groupId === undefined || tab.groupId === filter.groupId)
                    && (filter.windowId === undefined || tab.windowId === filter.windowId)).map(tab => ({ ...tab }));
            },
            move: async (ids, options) => {
                calls.push({ action: 'tabs.move', ids: [...ids], options });
                const moving = ids.map(id => { const tab = tabs.find(tab => tab.id === id); assert(tab, 'Cannot move a missing tab'); return tab; });
                assert(moving.every(tab => tab.windowId === moving[0].windowId), 'Member moves must stay in one window');
                const remaining = order(moving[0].windowId).filter(tab => !ids.includes(tab.id));
                remaining.splice(options.index, 0, ...moving);
                remaining.forEach((tab, index) => { tab.index = index; });
                return moving.map(tab => ({ ...tab }));
            },
            group: async () => assert.fail('Already-grouped tabs must not be regrouped'),
            ungroup: async () => assert.fail('Inherited members must not be ungrouped'),
            update: async () => assert.fail('Inherited members must not be updated'),
            remove: async () => assert.fail('Inherited members must not be closed')
        },
        tabGroups: { query: async () => groups.map(group => ({ ...group })),
            update: async () => assert.fail('Settled group metadata must remain unchanged'),
            move: async () => assert.fail('Settled group blocks must remain unchanged') }
    };
    return { spaces, calls, order: windowId => order(windowId).map(tab => tab.id),
        tabs: () => tabs.map(tab => ({ ...tab })) };
}

test('an inherited own-extension helper cannot block exact owned member order', async () => {
    const f = memberFixture();
    const helper = f.tabs().find(tab => tab.id === 9);
    await syncSpaceGroups(f.spaces);
    assert.deepEqual(f.order(10), [1, 2, 3, 9]);
    assert.deepEqual(f.calls, [{ action: 'tabs.move', ids: [1, 2, 3], options: { index: 0 } }]);
    assert.deepEqual(f.tabs().find(tab => tab.id === 9), helper);
    await syncSpaceGroups(f.spaces);
    assert.equal(f.calls.length, 1, 'The follow-up event pass must emit no moves');
});

test('owned reordering preserves multiple inherited members and their relative order', async () => {
    const f = memberFixture({ windows: { 10: [8, 3, 9, 2, 7, 1, 6] } });
    const preserved = () => f.tabs().filter(tab => ![1, 2, 3].includes(tab.id))
        .sort((a, b) => a.index - b.index).map(({ index, ...tab }) => tab);
    const before = preserved();
    await syncSpaceGroups(f.spaces);
    assert.deepEqual(f.order(10), [1, 2, 3, 8, 9, 7, 6]);
    assert.deepEqual(preserved(), before, 'Unowned identity, group, window, URL and relative order must survive');
    assert.deepEqual(f.calls.map(call => call.ids), [[1, 2, 3]], 'Only owned IDs may be passed to a mutation');
    await syncSpaceGroups(f.spaces);
    assert.equal(f.calls.length, 1);
});

test('already ordered owned members with inherited interleaving emit no mutations', async () => {
    const f = memberFixture({ windows: { 10: [8, 1, 9, 2, 7, 3, 6] } });
    const before = f.tabs();
    for (let pass = 0; pass < 3; pass++) await syncSpaceGroups(f.spaces);
    assert.deepEqual(f.tabs(), before);
    assert.deepEqual(f.calls, []);
});

test('all owned permutations converge without adopting or reordering inherited members', async () => {
    for (const [first, second, third] of permutations([1, 2, 3])) {
        const f = memberFixture({ windows: { 10: [8, first, 9, second, 7, third] } });
        await syncSpaceGroups(f.spaces);
        assert.deepEqual(f.order(10).filter(id => [1, 2, 3].includes(id)), [1, 2, 3]);
        assert.deepEqual(f.order(10).filter(id => ![1, 2, 3].includes(id)), [8, 9, 7]);
        const mutations = f.calls.length;
        await syncSpaceGroups(f.spaces);
        assert.equal(f.calls.length, mutations);
    }
});

test('a fresh group query missing an expected member does not move stale IDs', async () => {
    const f = memberFixture({ windows: { 10: [3, 2, 1, 9] }, missingOnGroupQuery: [1] });
    await syncSpaceGroups(f.spaces);
    assert.deepEqual(f.order(10), [3, 2, 9]);
    assert.deepEqual(f.calls, [], 'An inherited member cannot stand in for the missing owned tab');
});

test('an empty fresh group query cannot trigger a member move', async () => {
    const f = memberFixture({ windows: { 10: [3, 2, 1] }, missingOnGroupQuery: [1, 2, 3] });
    await syncSpaceGroups(f.spaces);
    assert.deepEqual(f.order(10), []);
    assert.deepEqual(f.calls, []);
});

test('missing members in the initial snapshot are excluded from the move', async () => {
    const f = memberFixture({ windows: { 10: [3, 2, 9] } });
    await syncSpaceGroups(f.spaces);
    assert.deepEqual(f.order(10), [2, 3, 9]);
    assert.deepEqual(f.calls.map(call => call.ids), [[2, 3]]);
});

test('owned member repair stays within the matching Space and window partition', async () => {
    const f = memberFixture({ windows: { 10: [3, 2, 1, 9], 20: [5, 4, 8] }, expected: [1, 4, 2, 5, 3] });
    const before = f.tabs().map(({ index, ...tab }) => tab);
    await syncSpaceGroups(f.spaces);
    assert.deepEqual(f.order(10), [1, 2, 3, 9]);
    assert.deepEqual(f.order(20), [4, 5, 8]);
    assert.deepEqual(f.calls.map(call => call.ids), [[1, 2, 3], [4, 5]]);
    assert.deepEqual(f.tabs().map(({ index, ...tab }) => tab), before);
    await syncSpaceGroups(f.spaces);
    assert.equal(f.calls.length, 2);
});

test('empty ownership and disabled projection leave inherited groups untouched', async () => {
    for (const options of [{ expected: [] }, { enabled: false }]) {
        const f = memberFixture(options), before = f.tabs();
        await syncSpaceGroups(f.spaces);
        assert.deepEqual(f.tabs(), before);
        assert.deepEqual(f.calls, []);
    }
});
