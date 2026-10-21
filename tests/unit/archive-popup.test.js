import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { readFileSync } from 'node:fs';
import { Utils } from '../../utils.js';

globalThis.document = parseHTML('<html><body></body></html>').document;
const { showArchivedTabsPopup } = await import('../../domManager.js');
const tick = () => new Promise(resolve => setImmediate(resolve));
const entry = (id, spaceId = 's') => ({ entryId: id, name: '<b>Archived</b>', url: 'https://same.test/', archivedAt: 12, spaceId });
function fixture() {
    const { document, window } = parseHTML('<html><body><div data-space-id="s"><div class="archived-tabs-popup"><div class="no-archived-tabs-message"></div><div class="archived-tabs-list"></div></div></div></body></html>');
    globalThis.document = document;
    globalThis.chrome = { windows: { getCurrent: async () => ({ id: 10 }) }, runtime: { getURL: path => `chrome-extension://arcify/${path}` } };
    const requests = [], hooks = {}; let views = 0;
    Utils.getSettings = async () => ({ autoArchiveEnabled: false, autoArchiveIdleMinutes: 60 });
    Utils.getArchiveView = async windowId => { assert.equal(windowId, 10); views++;
        return { context: { windowId, sourceTabId: views, sourceUrl: `https://source${views}.test/`, spaceId: 's', bookmarkFolderId: 'folder' },
            entries: [{ entry: entry('one'), bookmarkFolderId: 'folder' }, { entry: entry('two', 'another-space'), bookmarkFolderId: 'another-folder' }] }; };
    Utils.restoreArchivedTab = async (...args) => { requests.push(args); return hooks.restore ? hooks.restore(...args) : { consumed: true }; };
    const click = node => node.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
    return { document, requests, hooks, click, views: () => views, list: () => document.querySelector('.archived-tabs-list'),
        message: () => document.querySelector('.no-archived-tabs-message') };
}

test('global archive popup preserves same-URL rows across Spaces and renders names as text', async () => {
    const f = fixture(); await showArchivedTabsPopup('s');
    assert.equal(f.list().children.length, 2); assert.equal(f.list().querySelector('b'), null);
    assert.deepEqual([...f.list().children].map(node => node.dataset.archiveEntryId), ['one', 'two']);
    assert.equal(f.list().children[0].querySelector('.tab-title-display').textContent, '<b>Archived</b>');
});
test('pending reopen keeps exact row visible and suppresses double clicks until confirmation', async () => {
    const f = fixture(); let resolve; f.hooks.restore = () => new Promise(done => { resolve = done; });
    await showArchivedTabsPopup('s'); const row = f.list().children[0];
    f.click(row); f.click(row); await tick();
    assert.equal(f.requests.length, 1); assert.equal(f.list().children.length, 2); assert.equal(row.querySelector('button').disabled, true);
    const [expected, context] = f.requests[0]; assert.equal(expected.entryId, 'one'); assert.equal(context.windowId, 10); assert.equal(context.bookmarkFolderId, 'folder'); assert.equal(context.context.sourceTabId, 1);
    resolve({ consumed: true }); await tick(); assert.equal(f.list().children.length, 1); assert.equal(f.list().children[0].dataset.archiveEntryId, 'two');
});
test('reopen refusal or unknown result leaves row and displays explanatory error', async () => {
    for (const unknown of [false, true]) {
        const f = fixture(); f.hooks.restore = async () => { if (unknown) return { consumed: false }; throw new Error('An earlier reopen is uncertain. No second tab was created.'); };
        await showArchivedTabsPopup('s'); const row = f.list().children[0]; f.click(row); await tick();
        assert.equal(f.list().children.length, 2); assert.equal(row.querySelector('button').disabled, false);
        assert.match(f.message().textContent, unknown ? /retained/ : /uncertain/);
    }
});
test('confirmed partial success removes only exact row and retains warning; subsequent row gets fresh source context', async () => {
    const f = fixture(); f.hooks.restore = async () => ({ consumed: true, status: 'partial', warning: 'Reopened; focus failed.' });
    await showArchivedTabsPopup('s'); f.click(f.list().children[0]); await tick();
    assert.equal(f.list().children.length, 1); assert.equal(f.message().textContent, 'Reopened; focus failed.'); assert.equal(f.views(), 2);
    f.click(f.list().children[0]); await tick();
    assert.equal(f.requests[1][0].entryId, 'two'); assert.equal(f.requests[1][1].context.sourceTabId, 2); assert.equal(f.requests[1][1].bookmarkFolderId, 'another-folder');
    assert.equal(f.list().children.length, 0); assert.equal(f.list().style.display, 'none');
});
test('detached rendered row cannot start another operation, and stale response cannot remove newly rendered twin', async () => {
    const f = fixture(); let resolve; f.hooks.restore = () => new Promise(done => { resolve = done; });
    await showArchivedTabsPopup('s'); const old = f.list().children[0]; f.click(old); await tick();
    await showArchivedTabsPopup('s'); f.click(old); assert.equal(f.requests.length, 1);
    resolve({ consumed: true }); await tick(); assert.equal(f.list().children.length, 2); assert.equal(f.list().children[0].dataset.archiveEntryId, 'one');
});
test('stale sidebar row fallback no longer chooses or reconstructs a first URL match', () => {
    const source = readFileSync(new URL('../../sidebar.js', import.meta.url), 'utf8');
    const start = source.indexOf('// A stale ordinary row'), end = source.indexOf('// Tab not found and not in archive', start), fallback = source.slice(start, end);
    assert.match(fallback, /Utils\.getArchiveView\(currentWindow\.id\)/); assert.match(fallback, /Open the archive and choose its entry/);
    assert.doesNotMatch(fallback, /restoreArchivedTab|chrome\.tabs\.create|chrome\.tabs\.update|pinnedTabState/);
});
