import test from 'node:test';
import assert from 'node:assert/strict';
import { SpaceStore } from '../../space-store.js';

function fixture({ temporaryOnly = true, beforeQuery = () => {}, afterFirstRemove = () => {} } = {}) {
    const tabs = [1, 2, 3].map(id => ({ id, windowId: 10, url: `https://ordinary.test/${id}` }));
    const removed = [], local = { pinnedTabStatesById: {} };
    globalThis.chrome = {
        runtime: { getURL: path => `chrome-extension://arcify/${path}` },
        storage: { local: { async get() { return structuredClone(local); } } },
        windows: { async get(id) { return { id, type: 'normal' }; } },
        bookmarks: { async getSubTree() { return [{ id: 'folder', children: [{ id: 'saved', url: 'https://saved.test/page' }] }]; } },
        tabs: {
            async query() { beforeQuery(tabs); return structuredClone(tabs); },
            async get(id) { return structuredClone(tabs.find(tab => tab.id === id)); },
            async remove(id) { removed.push(id); if (id === 1) afterFirstRemove(tabs); }
        }
    };
    const store = new SpaceStore();
    store.spaces = [{ id: 'space', bookmarkFolderId: 'folder', temporaryTabs: [1, 2, 3], spaceBookmarks: [] }];
    return { store, tabs, local, removed, clean: () => store.closeOwnedTabs('space', { windowId: 10, temporaryOnly }) };
}

for (const field of ['url', 'pendingUrl']) for (const timing of ['initial-query', 'earlier-removal']) {
    test(`Clean preserves a saved ${field} observed at ${timing} and continues unrelated cleanup`, async () => {
        const navigate = tabs => { tabs[1][field] = 'https://saved.test/page'; };
        const f = fixture(timing === 'initial-query' ? { beforeQuery: navigate } : { afterFirstRemove: navigate });
        assert.deepEqual(await f.clean(), [1, 3]);
        assert.deepEqual(f.removed, [1, 3]);
        assert.deepEqual(f.store.spaces[0].temporaryTabs, [2]);
    });
}

test('Clean still closes an ordinary tab after navigation to another unsaved URL', async () => {
    const f = fixture({ afterFirstRemove: tabs => { tabs[1].url = 'https://unsaved.test/'; tabs[1].pendingUrl = 'https://another-unsaved.test/'; } });
    assert.deepEqual(await f.clean(), [1, 2, 3]);
});

test('Clean retains saved membership and exact bookmark bindings even away from saved URLs', async () => {
    const f = fixture();
    f.store.spaces[0].spaceBookmarks = [2]; f.store.spaces[0].temporaryTabs = [1, 3];
    f.local.pinnedTabStatesById[3] = { bookmarkId: 'saved', pinnedUrl: 'https://saved.test/page' };
    assert.deepEqual(await f.clean(), [1]);
    assert.deepEqual(f.store.spaces[0].spaceBookmarks, [2]);
    assert.deepEqual(f.store.spaces[0].temporaryTabs, [3]);
});

test('Space deletion retains its explicit all-owned-tabs semantics', async () => {
    const f = fixture({ temporaryOnly: false, afterFirstRemove: tabs => { tabs[1].url = 'https://saved.test/page'; } });
    assert.deepEqual(await f.clean(), [1, 2, 3]);
});
