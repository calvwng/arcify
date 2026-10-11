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
