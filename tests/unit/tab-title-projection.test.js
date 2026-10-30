import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectTabTitle, projectLiveTabTitles } from '../../tab-title-projection.js';

test('display titles retain ordinary aliases, ignore malformed aliases and never mutate native tabs', () => {
    const tab = { id: 1, title: 'Page title', url: 'https://new.test/page' };
    const overrides = { 1: { name: 'My alias', originalDomain: 'old.test' }, 2: { name: 'Other alias' } };
    assert.equal(projectTabTitle(tab, { overrides }), 'My alias');
    assert.equal(projectTabTitle({ ...tab, id: 2 }, { overrides }), 'Other alias');
    assert.equal(projectTabTitle({ ...tab, id: 3 }, { overrides }), 'Page title');
    for (const alias of [undefined, null, 'legacy-invalid', { name: '' }, { name: 4 }]) {
        assert.equal(projectTabTitle(tab, { overrides: { 1: alias } }), 'Page title');
    }
    assert.equal(tab.title, 'Page title');
});

test('saved-pin projection uses authoritative bookmark titles and path-aware navigation semantics', () => {
    const tab = { id: 1, title: 'Page title', url: 'https://same.test/saved?view=wide#section' };
    const context = { overrides: { 1: { name: 'Old alias' } }, binding: { pinnedUrl: 'https://old.test/' },
        bookmark: { title: 'Saved title', url: 'https://same.test/saved' }, isSpacePin: true };
    assert.equal(projectTabTitle(tab, context), 'Saved title');
    assert.equal(projectTabTitle({ ...tab, url: 'https://same.test/away' }, context), 'Page title');
    assert.equal(projectTabTitle({ ...tab, url: undefined, pendingUrl: 'https://same.test/away' }, context), 'Page title');
    assert.equal(projectTabTitle(tab, { ...context, bookmark: { ...context.bookmark, title: '' } }), '');
    assert.equal(projectTabTitle(tab, { ...context, isSpacePin: false }), 'Old alias');
});

test('live projections resolve saved pins by exact bookmark and owning Space despite duplicate URLs', async () => {
    const url = 'https://same.test/page';
    const tabs = [1, 2, 3, 4].map(id => ({ id, windowId: 1, url, title: `Page ${id}` }));
    const spaces = [
        { id: 'a', bookmarkFolderId: 'folder-a', spaceBookmarks: [1, 2, 4], temporaryTabs: [3] },
        { id: 'b', bookmarkFolderId: 'folder-b', spaceBookmarks: [], temporaryTabs: [] }
    ];
    const overrides = { 1: { name: 'Stale first alias' }, 2: { name: 'Stale second alias' }, 3: { name: 'Ordinary twin' } };
    const bindings = { 1: { bookmarkId: 'first', pinnedUrl: url }, 2: { bookmarkId: 'second', pinnedUrl: url },
        3: { bookmarkId: 'first', pinnedUrl: 'https://stale.test/' }, 4: { bookmarkId: 'foreign', pinnedUrl: url } };
    const nodes = [{ id: 'root', title: 'Arcify' }, { id: 'folder-a', title: 'A', parentId: 'root' },
        { id: 'folder-b', title: 'B', parentId: 'root' }, { id: 'nested', parentId: 'folder-a', title: 'Nested' },
        { id: 'first', parentId: 'nested', url, title: 'First saved title' },
        { id: 'second', parentId: 'nested', url, title: 'Second saved title' },
        { id: 'foreign', parentId: 'folder-b', url, title: 'Wrong Space title' }];
    globalThis.chrome = {
        runtime: { getURL: path => `chrome-extension://arcify/${path}` },
        storage: { local: { get: async () => ({ tabNameOverridesById: overrides, pinnedTabStatesById: bindings }) } },
        bookmarks: { get: async id => nodes.filter(node => node.id === id), search: async () => nodes.filter(node => node.id === 'root'),
            getChildren: async id => nodes.filter(node => node.parentId === id) }
    };
    const titles = async () => (await projectLiveTabTitles(tabs, spaces)).map(tab => tab.title);
    assert.deepEqual(await titles(), ['First saved title', 'Second saved title', 'Ordinary twin', 'Page 4']);
    assert.deepEqual(tabs.map(tab => tab.title), ['Page 1', 'Page 2', 'Page 3', 'Page 4']);
    tabs[0].url = 'https://same.test/away';
    assert.deepEqual(await titles(), ['Page 1', 'Second saved title', 'Ordinary twin', 'Page 4']);
    nodes.find(node => node.id === 'second').title = 'Renamed bookmark';
    assert.deepEqual(await titles(), ['Page 1', 'Renamed bookmark', 'Ordinary twin', 'Page 4']);
    delete overrides[3];
    assert.deepEqual(await titles(), ['Page 1', 'Renamed bookmark', 'Page 3', 'Page 4']);
    chrome.bookmarks.get = async () => { throw new Error('Folder unavailable'); };
    assert.deepEqual(await titles(), ['Page 1', 'Stale second alias', 'Page 3', 'Page 4']);
});
