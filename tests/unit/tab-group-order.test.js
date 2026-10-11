import test from 'node:test';
import assert from 'node:assert/strict';
import { syncSpaceGroups } from '../../tab-group-sync.js';

test('space order uses projected Chrome group IDs and respects disabled sync', async () => {
    const originalChrome = globalThis.chrome;
    const moves = [];
    let enabled = false;
    const tabs = [
        { id: 1, windowId: 10, groupId: 101, index: 0 },
        { id: 2, windowId: 10, groupId: 102, index: 1 }
    ];
    globalThis.chrome = {
        storage: {
            sync: { get: async () => ({ syncTabGroups: enabled }) },
            session: {
                get: async () => ({ spaceGroupProjection: { 'space-b:10': 102, 'space-a:10': 101 } }),
                set: async () => {}
            }
        },
        tabs: { query: async filter => filter.groupId ? tabs.filter(t => t.groupId === filter.groupId) : tabs },
        tabGroups: {
            query: async () => [
                { id: 101, windowId: 10, title: 'A', color: 'grey', collapsed: false },
                { id: 102, windowId: 10, title: 'B', color: 'grey', collapsed: false }
            ],
            move: async (id, options) => moves.push({ id, options })
        }
    };
    const spaces = [
        { id: 'space-b', name: 'B', color: 'grey', spaceBookmarks: [], temporaryTabs: [2] },
        { id: 'space-a', name: 'A', color: 'grey', spaceBookmarks: [], temporaryTabs: [1] }
    ];
    try {
        await syncSpaceGroups(spaces);
        assert.deepEqual(moves, []);
        enabled = true;
        await syncSpaceGroups(spaces);
        assert.deepEqual(moves, [
            { id: 102, options: { index: -1 } },
            { id: 101, options: { index: -1 } }
        ]);
    } finally {
        globalThis.chrome = originalChrome;
    }
});
