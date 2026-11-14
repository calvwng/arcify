import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSplitPinMoveSafe } from '../../split-pin-move-safety.js';
function fixture() {
    const nodes = [{ id: 'root', parentId: '0' }, { id: 'a', parentId: 'root' }, { id: 'b', parentId: 'root' },
        { id: 'folder', parentId: 'a' }, { id: 'nested', parentId: 'a' },
        { id: 'pin', parentId: 'folder', url: 'chrome-extension://test/saved-split.html#recipe' }];
    const tabs = [{ id: 10 }, { id: 11 }];
    const data = { splitPinsV1: { pins: [{ bookmarkId: 'pin' }] }, spaces: [{ bookmarkFolderId: 'a' }, { bookmarkFolderId: 'b' }] };
    globalThis.chrome = { runtime: { getURL: p => `chrome-extension://test/${p}` },
        storage: { local: { async get(key) { return { [key]: data[key] }; } }, session: { async get() { return { splitPinInstancesV1: { witness: { bookmarkId: 'pin', tabIds: [10,11] } } }; } } },
        bookmarks: { async get(id) { return nodes.filter(n => n.id === id); }, async getChildren(id) { return nodes.filter(n => n.parentId === id); } },
        tabs: { async query() { return tabs; } } };
    return { tabs, nodes };
}
test('moving a live pin or containing folder across Spaces refuses before writes', async () => {
    fixture(); for (const id of ['pin', 'folder']) await assert.rejects(assertSplitPinMoveSafe(id, 'b'), /Close this pinned Split View/);
});
test('same Space nested placement and ordering preserve live pair', async () => {
    fixture(); await assertSplitPinMoveSafe('pin', 'nested'); await assertSplitPinMoveSafe('folder', 'a');
});
test('close-first cross-Space move works; one surviving member still blocks', async () => {
    const f = fixture(); f.tabs.pop(); await assert.rejects(assertSplitPinMoveSafe('pin', 'b'), /remaining member/);
    f.tabs.pop(); await assertSplitPinMoveSafe('pin', 'b');
});
