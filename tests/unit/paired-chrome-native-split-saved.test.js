import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSavedSplitReopened } from '../../scripts/paired-chrome-native-split-saved.mjs';
function fixture() {
    const tab = (id, index, url, splitViewId) => ({ id, index, url, pendingUrl: null, windowId: 1, incognito: false, pinned: false, splitViewId });
    const before = { tabs: [tab(1, 0, 'https://a.test', 7), tab(2, 1, 'https://b.test', 7)], spaces: [{ id: 's', temporaryTabs: [1, 2], spaceBookmarks: [] }], bookmarks: [], bindings: {}, favorites: [], pageStates: { 1: { documentId: 'unchanged' } } };
    const after = structuredClone(before); after.tabs.push(tab(3, 2, 'https://a.test', 8), tab(4, 3, 'https://b.test', 8)); after.spaces[0].temporaryTabs.push(3, 4);
    return { before, after, request: { spaceId: 's', windowId: 1, recipe: { pages: [{ url: 'https://a.test' }, { url: 'https://b.test' }] } } };
}
test('accepts exactly two new owned native split pages while old pair survives', () => {
    const f = fixture(); assert.deepEqual(assertSavedSplitReopened(f.before, f.after, f.request), [3, 4]);
});
for (const [name, mutate] of Object.entries({
    reused: f => { f.after = structuredClone(f.before); },
    third: f => f.after.tabs.push({ ...f.after.tabs[3], id: 5 }),
    unsplit: f => { f.after.tabs[2].splitViewId = -1; },
    partner: f => { f.after.tabs[3].splitViewId = 9; },
    oldSplit: f => { f.after.tabs[0].splitViewId = 8; },
    changedPage: f => { f.after.tabs[0].url = 'https://changed.test'; },
    lostPage: f => { f.after.tabs.shift(); },
    private: f => { f.after.tabs[2].incognito = true; },
    pinned: f => { f.after.tabs[2].pinned = true; },
    wrongWindow: f => { f.after.tabs[2].windowId = 2; },
    wrongSpace: f => { f.after.spaces[0].temporaryTabs.pop(); },
    duplicateOwner: f => { f.after.spaces.push({ id: 'other', temporaryTabs: [3], spaceBookmarks: [] }); },
    bookmark: f => { f.after.spaces[0].spaceBookmarks.push(3); },
    reversePages: f => { f.after.tabs[2].url = 'https://b.test'; f.after.tabs[3].url = 'https://a.test'; },
    notAdjacent: f => { f.after.tabs[3].index = 6; },
    documentLost: f => { f.after.pageStates[1].documentId = 'reloaded'; },
    movedOriginal: f => { f.after.spaces[0].temporaryTabs.shift(); f.after.spaces.push({ id: 'Personal', temporaryTabs: [1], spaceBookmarks: [] }); },
    reorderedOriginal: f => { f.after.spaces[0].temporaryTabs = [2, 1, 3, 4]; },
    activeSpaceChanged: f => { f.after.activeSpaceId = 'other'; },
    favoritesChanged: f => { f.after.favorites.push('unexpected'); }
})) test(`saved native split acceptance rejects ${name}`, () => {
    const f = fixture(); mutate(f); assert.throws(() => assertSavedSplitReopened(f.before, f.after, f.request));
});
