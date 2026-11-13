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

import { clickNativeSplitMenuRow } from '../../scripts/paired-chrome-native-split.mjs';
function detachedBeforeInput() {
    const error = new Error('Node is detached from document');
    error.stack = 'Error: Node is detached from document\n    at CdpElementHandle.assertConnectedElement (/puppeteer/api/ElementHandle.js:1314:23)\n    at async CdpElementHandle.scrollIntoView (/puppeteer/cdp/ElementHandle.js:106:13)';
    return error;
}
test('native context menu reacquires exact row only for proven pre-input detach and preserves right button', async () => {
    let lookups = 0, disposed = 0; const records = [], options = [];
    const page = { waitForSelector: async (selector, config) => {
        assert.equal(selector, '.exact-tab-42'); assert.equal(config.visible, true); assert(config.timeout > 0);
        const attempt = ++lookups;
        return { click: async value => { options.push(value); if (attempt === 1) throw detachedBeforeInput(); }, dispose: async () => { disposed++; } };
    } };
    await clickNativeSplitMenuRow(page, '.exact-tab-42', observation => records.push(observation));
    assert.equal(lookups, 2); assert.equal(disposed, 2);
    assert.deepEqual(options, [{ button: 'right' }, { button: 'right' }]);
    assert.deepEqual(records.map(item => item.status), ['detached-before-input', 'clicked']);
});
for (const kind of ['dispatch', 'unknown']) test(`native context menu never replays ${kind} failure`, async () => {
    let lookups = 0, clicks = 0; const error = detachedBeforeInput();
    error.stack += kind === 'dispatch' ? '\n    at CdpMouse.click (/puppeteer/Input.js:1:1)' : '';
    if (kind === 'unknown') error.stack = 'Error: Node is detached from document';
    const page = { waitForSelector: async () => { lookups++; return { click: async () => { clicks++; throw error; }, dispose: async () => {} }; } };
    await assert.rejects(clickNativeSplitMenuRow(page, '.exact-tab-42'), actual => actual === error);
    assert.equal(lookups, 1); assert.equal(clicks, 1);
});
