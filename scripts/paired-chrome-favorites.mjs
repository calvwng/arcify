import assert from 'node:assert/strict';

// Browser evidence only: callers obtain these records from real Chrome APIs.
export function assertSavedBookmarkFavorite(before, after, { bookmarkId, newTab, expectedTabId }) {
    const bindingIds = Object.entries(after.bindings).filter(([, state]) =>
        String(state.bookmarkId) === String(bookmarkId)).map(([id]) => Number(id));
    const candidates = after.tabs.filter(tab => bindingIds.includes(tab.id));
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
