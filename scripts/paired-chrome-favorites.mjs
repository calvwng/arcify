import assert from 'node:assert/strict';

// Browser evidence only: callers obtain these records from real Chrome APIs.
export function assertSavedBookmarkFavorite(before, after, { bookmarkId, newTab, expectedTabId }) {
    assert(Array.isArray(before.favorites) && Array.isArray(after.favorites), 'Persistent Favorite snapshots are required.');
    const records = after.favorites.filter(record => record.sourceBookmarkId === bookmarkId);
    assert.equal(records.length, 1, 'The exact source bookmark must map to one saved Favorite identity.');
    const record = records[0];
    assert(typeof record.id === 'string' && record.id.length > 0);
    const prior = before.favorites.find(item => item.sourceBookmarkId === bookmarkId);
    if (prior) assert.equal(record.id, prior.id, 'Repeated drops must preserve the stable saved Favorite ID.');
    else {
        const source = before.bookmarks.find(bookmark => bookmark.id === bookmarkId);
        assert.equal(record.url, source?.url); assert.equal(record.title, source?.title);
    }
    assert.equal(after.favorites.length, before.favorites.length + (prior ? 0 : 1));
    for (const existing of before.favorites) {
        const current = after.favorites.find(item => item.id === existing.id);
        assert(current, 'Existing saved Favorites cannot be removed by a drop.');
        for (const key of ['id', 'title', 'url', 'sourceBookmarkId']) assert.equal(current[key], existing[key]);
        if (existing.id !== prior?.id) assert.equal(current.tabId, existing.tabId);
    }
    const candidates = after.tabs.filter(tab => tab.id === record.tabId);
    assert.equal(candidates.length, 1, 'The exact saved identity must have one current-window live instance.');
    const favorite = candidates[0];
    assert.equal(favorite.pinned, true, 'The destination must be a real native pinned tab.');
    assert.equal(favorite.active, false, 'A saved-link drop must not steal the active tab.');
    assert.equal(favorite.windowId, before.windowId);
    assert.equal(favorite.incognito, false);
    if (expectedTabId !== undefined) assert.equal(favorite.id, expectedTabId, 'A repeat must reuse the exact bound instance.');
    assert.deepEqual(after.bookmarks, before.bookmarks, 'Every original saved bookmark and parent must remain unchanged.');
    assert.equal(after.activeSpaceId, before.activeSpaceId);
    assert.deepEqual(after.spaces, before.spaces, 'Native Favorites must not assign or reorder logical workspace members.');
    assert.equal(after.tabs.length, before.tabs.length + (newTab ? 1 : 0));
    assert.deepEqual(after.tabs.filter(tab => tab.active).map(tab => tab.id), before.tabs.filter(tab => tab.active).map(tab => tab.id));
    for (const original of before.tabs) {
        const current = after.tabs.find(tab => tab.id === original.id);
        assert(current, 'Existing tabs cannot be closed by a Favorites drop.');
        for (const key of ['windowId', 'url', 'active', 'pinned']) assert.equal(current[key], original[key], `Existing tab ${original.id}: ${key}`);
    }
    if (newTab) {
        assert(!before.tabs.some(tab => tab.id === favorite.id));
        assert.equal(favorite.url, before.bookmarks.find(bookmark => bookmark.id === bookmarkId)?.url);
    }
    return favorite;
}
