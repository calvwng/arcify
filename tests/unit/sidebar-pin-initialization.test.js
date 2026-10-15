import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';

async function initialize(data) {
    const worker = new Worker(new URL('../fixtures/sidebar-pin-initialization.mjs', import.meta.url), { workerData: data });
    try {
        const result = await new Promise((resolve, reject) => {
            worker.once('message', resolve);
            worker.once('error', reject);
            worker.once('exit', code => reject(new Error(`Sidebar fixture exited before returning its result (${code})`)));
        });
        assert.deepEqual(result.warnings, [], 'The actual sidebar initialization/render must complete without swallowed errors');
        assert.deepEqual(result.bookmarkWrites, [], 'Validation must not reorder or rewrite the bookmark tree');
        return result;
    } finally { await worker.terminate(); }
}

function fixture() {
    const twin = 'https://same.test/';
    const bookmarks = [
        { id: 'root', title: 'Arcify' },
        { id: 'work-folder', parentId: 'root', title: 'Work' },
        { id: 'b11', parentId: 'work-folder', title: 'First twin alias', url: twin },
        { id: 'nested', parentId: 'work-folder', title: 'Nested' },
        { id: 'b12', parentId: 'nested', title: 'Second twin alias', url: twin },
        { id: 'b13', parentId: 'work-folder', title: 'Query alias', url: 'https://query.test/page?original#saved' },
        { id: 'b14', parentId: 'work-folder', title: 'Navigated alias', url: 'https://saved.test/' },
        { id: 'b15', parentId: 'work-folder', title: 'Legacy alias', url: 'https://legacy.test/page?original' },
        { id: 'b18', parentId: 'work-folder', title: 'New binding', url: 'https://new.test/' },
        { id: 'other-folder', parentId: 'root', title: 'Other' }
    ];
    const tab = (id, url, windowId = 10) => ({ id, url, windowId, title: `Live ${id}`, pinned: false, active: id === 2 });
    const tabs = [tab(1, twin), tab(2, twin), tab(3, 'https://query.test/page?new#current'), tab(4, 'https://navigated.test/'),
        tab(5, 'https://legacy.test/page?current'), tab(8, 'https://new.test/'), tab(9, twin), tab(20, twin, 20), tab(21, twin, 20), tab(30, twin)];
    const binding = id => ({ bookmarkId: `b${id}`, pinnedUrl: bookmarks.find(bookmark => bookmark.id === `b${id}`).url });
    const pinnedTabStatesById = { 1: binding(11), 2: binding(12), 3: binding(13), 4: binding(14),
        20: { bookmarkId: 'foreign-20', pinnedUrl: twin }, 21: { bookmarkId: 'foreign-21', pinnedUrl: twin } };
    const tabNameOverridesById = Object.fromEntries([1, 2, 3, 4].map(id => [id, {
        name: bookmarks.find(bookmark => bookmark.id === pinnedTabStatesById[id].bookmarkId).title,
        originalDomain: new URL(tabs.find(tab => tab.id === id).url).hostname
    }]));
    return {
        tabs, bookmarks,
        local: { tabGroupImportDismissed: true, pinnedTabStatesById, tabNameOverridesById,
            spaces: [
                { id: 'work', name: 'Work', color: 'blue', bookmarkFolderId: 'work-folder', spaceBookmarks: [2, 20, 4, 1, 21, 3, 5], temporaryTabs: [9], lastTab: 2 },
                { id: 'other', name: 'Other', color: 'red', bookmarkFolderId: 'other-folder', spaceBookmarks: [], temporaryTabs: [30] }
            ] },
        session: { activeSpaces: { 10: 'work', 20: 'other' }, spaceSession: true }
    };
}

test('real sidebar reload retains reversed exact URL twins, nested bindings, aliases and interleaved windows without a Space save', async () => {
    const data = fixture();
    const beforeSpaces = structuredClone(data.local.spaces);
    const beforeBindings = structuredClone(data.local.pinnedTabStatesById);
    const beforeAliases = structuredClone(data.local.tabNameOverridesById);
    const result = await initialize(data);
    assert.deepEqual(result.local.spaces, beforeSpaces);
    assert.deepEqual(result.patches, [], 'Bookmark traversal order must not trigger a Space patch');
    for (const id of [1, 2, 3, 4, 20, 21]) assert.deepEqual(result.local.pinnedTabStatesById[id], beforeBindings[id]);
    for (const id of [1, 2, 3, 4]) assert.deepEqual(result.local.tabNameOverridesById[id], beforeAliases[id]);
    assert.deepEqual(result.local.pinnedTabStatesById[5], { bookmarkId: 'b15', pinnedUrl: 'https://legacy.test/page?original' }, 'Unbound legacy pins still use the existing URL-key recovery');
    assert.equal(result.rows.find(row => row.tabId === 2)?.bookmarkId, 'b12');
    assert.equal(result.rows.find(row => row.tabId === 1)?.bookmarkId, 'b11');
    assert.equal(result.rows.find(row => row.tabId === 4)?.navigated, true);
    assert.equal(result.rows.find(row => row.tabId === 3)?.navigated, false);
    assert.equal(result.rows.find(row => row.tabId === 9)?.bookmarkId, null, 'A temporary URL twin must not become a pin');
    assert.equal(result.rows.some(row => [20, 21, 30].includes(row.tabId)), false, 'Foreign-window and foreign-Space tabs stay outside this view');
    assert.deepEqual(result.session, data.session);

    const reopened = await initialize({ ...data, local: result.local, session: result.session });
    assert.deepEqual(reopened.local.spaces, beforeSpaces);
    assert.deepEqual(reopened.local.pinnedTabStatesById, result.local.pinnedTabStatesById);
    assert.deepEqual(reopened.local.tabNameOverridesById, result.local.tabNameOverridesById);
    assert.deepEqual(reopened.patches, [], 'A second fresh sidebar module must also leave ordered ownership untouched');
});

test('real sidebar demotes only unmatched current-window pins and retains native metadata and unclassified IDs', async () => {
    const data = fixture();
    data.tabs.push({ id: 6, windowId: 10, pinned: false, title: 'Stale binding', url: 'https://same.test/' },
        { id: 7, windowId: 10, pinned: true, title: 'Native pin', url: 'https://same.test/' });
    data.local.spaces[0].spaceBookmarks = [2, 20, 6, 4, 1, 21, 3, 5, 7, 99];
    for (const id of [6, 7, 99]) data.local.pinnedTabStatesById[id] = { bookmarkId: 'missing', pinnedUrl: 'https://same.test/' };
    const result = await initialize(data);
    assert.deepEqual(result.local.spaces[0].spaceBookmarks, [2, 20, 4, 1, 21, 3, 5, 99]);
    assert.deepEqual(result.local.spaces[0].temporaryTabs, [9, 6, 7]);
    assert.deepEqual(result.local.spaces[1], data.local.spaces[1]);
    assert.equal(result.local.pinnedTabStatesById[6], undefined, 'A stale bookmark binding cannot steal a matching URL twin');
    assert.equal(result.local.pinnedTabStatesById[99], undefined, 'Existing dead-tab metadata pruning still runs');
    assert.deepEqual(result.local.pinnedTabStatesById[7], data.local.pinnedTabStatesById[7], 'Existing native-pin protection remains in force');
    for (const id of [20, 21]) assert.deepEqual(result.local.pinnedTabStatesById[id], data.local.pinnedTabStatesById[id]);
    assert.equal(result.patches.length, 1);
    assert.deepEqual(result.patches[0].before, data.local.spaces);
    assert.deepEqual(result.patches[0].after, result.local.spaces);
});

test('real sidebar appends a newly validated binding without reordering existing window slots', async () => {
    const data = fixture();
    data.concurrentPin = { spaceId: 'work', tabId: 8, binding: { bookmarkId: 'b18', pinnedUrl: 'https://new.test/' } };
    const result = await initialize(data);
    assert.deepEqual(result.local.spaces[0].spaceBookmarks, [...data.local.spaces[0].spaceBookmarks, 8]);
    assert.deepEqual(result.local.spaces[0].temporaryTabs, [9]);
    assert.equal(result.patches.length, 1);
    assert.deepEqual(result.patches[0].after[0].spaceBookmarks, [...data.local.spaces[0].spaceBookmarks, 8]);
    assert.equal(result.rows.find(row => row.tabId === 8)?.bookmarkId, 'b18');
});
