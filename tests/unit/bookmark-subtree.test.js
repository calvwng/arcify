import test from 'node:test';
import assert from 'node:assert/strict';
import { BookmarkUtils } from '../../bookmark-utils.js';

test('recursive bookmark retrieval fetches one subtree and retains nested bookmarks', async () => {
    const originalChrome = globalThis.chrome;
    const calls = [];
    const tree = { id: 'root', children: [
        { id: 'one', title: 'One', url: 'https://one.test/' },
        { id: 'folder', children: [{ id: 'two', title: '<literal title>', url: 'https://two.test/' }] }
    ] };
    globalThis.chrome = { bookmarks: { getSubTree: async id => { calls.push(id); return [tree]; } } };
    try {
        const expected = [
            { id: 'one', title: 'One', url: 'https://one.test/' },
            { id: 'two', title: '<literal title>', url: 'https://two.test/' }
        ];
        assert.deepEqual(await BookmarkUtils.getBookmarksFromFolderRecursive('root'), expected);
        assert.deepEqual(calls, ['root']);
        calls.length = 0;
        assert.deepEqual(await BookmarkUtils.getBookmarksFromFolderRecursive(tree), expected);
        assert.deepEqual(calls, []);
    } finally {
        globalThis.chrome = originalChrome;
    }
});
