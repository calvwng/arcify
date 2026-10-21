import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { getTabRowAction } from '../../tab-row-action.js';
import { removeSpacePin } from '../../space-bookmarks.js';
import { captureSidebarViewport } from '../../sidebar-viewport.js';

for (const [isPinned, isBookmarkOnly, expected] of [
    [true, false, { className: 'tab-close', glyph: '−', label: 'Close Tab (keep pin)' }],
    [true, true, { className: 'tab-remove', glyph: '×', label: 'Remove Pin (delete bookmark)' }],
    [false, false, { className: 'tab-close', glyph: '×', label: 'Close Tab' }],
    // Preserve existing bookmark-only gating even when the caller omits isPinned.
    [false, true, { className: 'tab-remove', glyph: '×', label: 'Remove Pin (delete bookmark)' }]
]) test(`tab-row control matches live/closed state (pinned=${isPinned}, bookmarkOnly=${isBookmarkOnly})`, () => {
    assert.deepEqual(getTabRowAction({ isPinned, isBookmarkOnly }), expected);
});

test('default row remains a normal close control and removal is never described as archive', () => {
    assert.deepEqual(getTabRowAction(), { className: 'tab-close', glyph: '×', label: 'Close Tab' });
    assert.match(getTabRowAction({ isBookmarkOnly: true }).label, /delete bookmark/);
    assert.doesNotMatch(getTabRowAction({ isBookmarkOnly: true }).label, /archive/i);
});

// Execute the unchanged production handler rather than reimplementing its
// destructive branches in the test. Only Chrome/DOM collaborators are mocked.
// This is unit coverage, not a claim that a browser row was clicked.
const sidebarSource = await readFile(new URL('../../sidebar.js', import.meta.url), 'utf8');
const start = sidebarSource.indexOf('async function closeTab(');
const end = sidebarSource.indexOf('async function createTabElement(', start);
assert(start >= 0 && end > start, 'Production closeTab handler must be available for effect tests');
const makeCloseTab = new Function('Logger', 'spaces', 'removeSpacePin', 'chrome', 'updatePinnedSectionPlaceholders', 'captureSidebarViewport', `${sidebarSource.slice(start, end)}\nreturn closeTab;`);

function fixture(bookmarkId = 'bound', spaceId = 'space-a') {
    const nodes = [
        { id: 'root', title: 'Arcify' },
        { id: 'folder-a', parentId: 'root', title: 'A' },
        { id: 'folder-b', parentId: 'root', title: 'B' },
        { id: 'nested', parentId: 'folder-a', title: 'Nested' },
        { id: 'first-twin', parentId: 'nested', title: 'First twin', url: 'https://same.test/' },
        { id: 'bound', parentId: 'nested', title: 'Bound twin', url: 'https://same.test/' },
        { id: 'other-space', parentId: 'folder-b', title: 'Other space twin', url: 'https://same.test/' }
    ];
    const effects = { closedTabs: [], removedBookmarks: [], removedRows: 0, placeholderRefreshes: 0 };
    const spaces = [{ id: 'space-a', bookmarkFolderId: 'folder-a', spaceBookmarks: [7] }, { id: 'space-b', bookmarkFolderId: 'folder-b', spaceBookmarks: [] }];
    globalThis.chrome = {
        storage: { local: { async get() { return { pinnedTabStatesById: { 7: { bookmarkId: 'bound', pinnedUrl: 'https://same.test/' } } }; } } },
        tabs: { async remove(id) { effects.closedTabs.push(id); } },
        bookmarks: {
            async get(id) { return structuredClone(nodes.filter(node => node.id === id)); },
            async search({ title }) { return structuredClone(nodes.filter(node => node.title === title)); },
            async getChildren(id) { return structuredClone(nodes.filter(node => node.parentId === id)); },
            async remove(id) { effects.removedBookmarks.push(id); const index = nodes.findIndex(node => node.id === id); if (index >= 0) nodes.splice(index, 1); }
        }
    };
    const row = { dataset: { bookmarkId }, closest(selector) { if (selector === '.space-content') return null; assert.equal(selector, '.space'); return { dataset: { spaceId } }; }, remove() { effects.removedRows++; } };
    const close = makeCloseTab({ log() {} }, spaces, removeSpacePin, chrome, () => { effects.placeholderRefreshes++; }, captureSidebarViewport);
    return { nodes, effects, row, close };
}

test('live pin minus closes only the live tab and preserves all duplicate bookmarks after navigation', async () => {
    const { close, row, nodes, effects } = fixture();
    assert.equal(getTabRowAction({ isPinned: true }).glyph, '−');
    await close(row, { id: 7, url: 'https://navigated-away.test/' }, true, false);
    assert.deepEqual(effects, { closedTabs: [7], removedBookmarks: [], removedRows: 0, placeholderRefreshes: 0 });
    assert.deepEqual(nodes.filter(node => node.url).map(node => node.id), ['first-twin', 'bound', 'other-space']);
});

test('closed pin cross deletes only its exact nested bookmark and leaves equal-URL siblings untouched', async () => {
    const { close, row, nodes, effects } = fixture();
    assert.equal(getTabRowAction({ isPinned: true, isBookmarkOnly: true }).glyph, '×');
    await close(row, { url: 'https://same.test/' }, true, true);
    assert.deepEqual(effects, { closedTabs: [], removedBookmarks: ['bound'], removedRows: 1, placeholderRefreshes: 1 });
    assert.deepEqual(nodes.filter(node => node.url).map(node => node.id), ['first-twin', 'other-space']);
});

test('temporary tab cross retains its ordinary close behavior without touching same-URL pins', async () => {
    const { close, row, nodes, effects } = fixture();
    assert.equal(getTabRowAction({ isPinned: false, isBookmarkOnly: false }).glyph, '×');
    await close(row, { id: 9, url: 'https://same.test/' }, false, false);
    assert.deepEqual(effects.closedTabs, [9]); assert.deepEqual(effects.removedBookmarks, []);
    assert.equal(nodes.filter(node => node.url).length, 3);
});

for (const bookmarkId of ['missing', 'other-space']) test(`closed-pin removal never substitutes URL identity for ${bookmarkId}`, async () => {
    const { close, row, nodes, effects } = fixture(bookmarkId);
    await close(row, { url: 'https://same.test/' }, true, true);
    assert.deepEqual(effects.closedTabs, []); assert.deepEqual(effects.removedBookmarks, []);
    assert.equal(nodes.filter(node => node.url).length, 3);
});

test('closed-pin removal does nothing when its owning space is stale', async () => {
    const { close, row, effects } = fixture('bound', 'deleted-space');
    await close(row, { url: 'https://same.test/' }, true, true);
    assert.deepEqual(effects, { closedTabs: [], removedBookmarks: [], removedRows: 0, placeholderRefreshes: 0 });
});
