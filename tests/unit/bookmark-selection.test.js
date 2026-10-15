import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createBookmarkSelection } from '../../bookmark-selection.js';
import { createFavoritesDragSource, createSavedBookmarkFavoriteDrop, describeBookmarkBatchOutcome } from '../../favorites-drop.js';
import { favoriteRequest } from '../../saved-favorites-ui.js';

const htmlRow = (id, extra = '') => `<div class="tab" data-bookmark-id="${id}" data-url="https://same.test/" ${extra}><img class="tab-favicon"><span>${id}</span><button>Close</button></div>`;
function fixture(extra = '') {
    const { document, window } = parseHTML(`<html><body><div id="pinnedFavicons"></div><div id="spacesList"><div class="space active" data-space-id="s"><div class="pinned-tabs" data-tab-type="pinned">
        ${htmlRow('a')}<div class="folder" data-bookmark-id="folder"><div class="folder-header">Folder</div><div class="folder-content">${htmlRow('b', 'data-tab-id="7"')}${htmlRow('c')}</div><div class="folder-collapsed-tabs"></div></div>
        <div class="folder collapsed" data-bookmark-id="hidden-folder"><div class="folder-content collapsed">${htmlRow('hidden')}</div><div class="folder-collapsed-tabs">${htmlRow('projected', 'data-tab-id="8"')}</div></div>
        ${htmlRow('d')}${htmlRow('e')}${extra}</div><div data-tab-type="temporary">${htmlRow('temporary')}</div></div><div class="space" data-space-id="other"><div data-tab-type="pinned">${htmlRow('other')}</div></div></div></body></html>`);
    const context = { windowId: 10, activeSpaceId: 's', spaces: [{ id: 's', bookmarkFolderId: 'root' }, { id: 'other', bookmarkFolderId: 'other-root' }] };
    const selection = createBookmarkSelection({ document, getContext: () => context });
    for (const row of document.querySelectorAll('.tab')) selection.register(row);
    const row = id => [...document.querySelectorAll('.tab')].find(row => row.dataset.bookmarkId === id);
    const event = (node, type, props = {}) => { const e = new window.Event(type, { bubbles: true, cancelable: true }); Object.assign(e, { button: 0, ...props }); node.dispatchEvent(e); return e; };
    const click = (id, props = {}) => event(row(id), 'click', props);
    const ids = () => [...document.querySelectorAll('.bookmark-selected')].map(row => row.dataset.bookmarkId);
    const drag = createFavoritesDragSource({ document, getContext: () => context, selection });
    const start = id => { row(id).classList.add('dragging'); return drag.start(row(id)); };
    return { document, window, context, selection, row, event, click, ids, drag, start };
}

test('Ctrl/Cmd toggles exact bookmark IDs without activating rows or conflating equal URLs', () => {
    const f = fixture(); let activations = 0;
    for (const row of f.document.querySelectorAll('.tab')) row.addEventListener('click', () => activations++);
    f.click('a', { ctrlKey: true }); f.click('d', { metaKey: true });
    assert.deepEqual(f.ids(), ['a', 'd']); assert.equal(activations, 0);
    assert.equal(f.row('a').getAttribute('aria-selected'), 'true'); assert.equal(f.row('d').getAttribute('role'), 'treeitem');
    assert.equal(f.document.getElementById('bookmarkSelectionStatus').dataset.count, '2');
    f.click('a', { metaKey: true }); assert.deepEqual(f.ids(), ['d']);
});

test('Shift ranges span visible open folder boundaries; hidden descendants/folders are excluded and projections included', () => {
    const f = fixture(); f.click('a', { ctrlKey: true }); f.click('d', { shiftKey: true });
    assert.deepEqual(f.ids(), ['a', 'b', 'c', 'projected', 'd']);
    assert.equal(f.document.querySelector('[data-bookmark-id="hidden-folder"]').classList.contains('collapsed'), true);
    assert.equal(f.row('hidden').getAttribute('aria-selected'), 'false');
    assert.equal(f.document.querySelectorAll('.folder.bookmark-selected').length, 0);
    f.click('b', { shiftKey: true }); assert.deepEqual(f.ids(), ['a', 'b'], 'range anchor stays at a');
});

test('Ctrl/Cmd+Shift adds visible ranges and reverse ranges follow displayed order', () => {
    const f = fixture(); f.click('e', { ctrlKey: true }); f.click('c', { shiftKey: true });
    assert.deepEqual(f.ids(), ['c', 'projected', 'd', 'e']);
    f.click('a', { ctrlKey: true }); f.click('b', { metaKey: true, shiftKey: true });
    assert.deepEqual(f.ids(), ['a', 'b', 'c', 'projected', 'd', 'e']);
    f.selection.clear(); f.click('c', { shiftKey: true }); assert.deepEqual(f.ids(), ['c'], 'no anchor starts a singleton');
});

test('ordinary click activates and seeds an independent exact-row Shift anchor until the view changes', () => {
    const f = fixture(); let activated = 0;
    f.row('a').addEventListener('click', () => activated++);
    f.click('d', { ctrlKey: true }); f.click('a');
    assert.deepEqual(f.ids(), []); assert.equal(activated, 1);
    f.click('c', { shiftKey: true }); assert.deepEqual(f.ids(), ['a', 'b', 'c']);
    f.click('a'); f.row('a').dataset.url = 'https://changed.test/'; f.selection.reconcile();
    f.click('d', { shiftKey: true }); assert.deepEqual(f.ids(), ['d'], 'changed anchor does not survive by bookmark ID alone');
    f.click('b'); f.selection.onActivation(7); f.click('d', { shiftKey: true });
    assert.deepEqual(f.ids(), ['b', 'c', 'projected', 'd'], 'own activation retains its plain-click anchor');
    f.selection.onActivation(8); assert.deepEqual(f.ids(), [], 'other navigation clears the selected batch');
});

test('selection order follows rendered/inverted order rather than click order', () => {
    const f = fixture(), root = f.row('a').parentElement;
    root.prepend(f.row('e')); root.prepend(f.row('d'));
    f.click('e', { ctrlKey: true }); f.click('d', { ctrlKey: true }); f.click('a', { ctrlKey: true });
    const snapshot = f.selection.freeze(f.row('e'));
    assert.deepEqual(snapshot.entries.map(entry => entry.bookmarkId), ['d', 'e', 'a']);
    assert.equal(snapshot.entries[0].parentId, 'root');
});

test('logical ordinary-click anchor survives closed-to-live render and blur, without preserving any selected rows', () => {
    const f = fixture(); f.click('a'); f.selection.clearForRender();
    const original = f.row('a'), replacement = original.cloneNode(true);
    replacement.dataset.tabId = '42'; replacement.dataset.pinnedUrl = original.dataset.url;
    f.selection.register(replacement); original.replaceWith(replacement); f.selection.reconcile();
    f.selection.onActivation(42); f.event(f.window, 'blur');
    assert.deepEqual(f.ids(), []);
    f.click('c', { shiftKey: true }); assert.deepEqual(f.ids(), ['a', 'b', 'c']);
    f.selection.clearForRender(); replacement.dataset.pinnedUrl = 'https://other-saved.test/'; f.selection.reconcile();
    f.click('d', { shiftKey: true }); assert.deepEqual(f.ids(), ['d']);
});

test('ordinary activation, controls, outside click and Escape clear selection without changing their actions', () => {
    const f = fixture(); let activated = 0, closed = 0;
    f.row('a').addEventListener('click', () => activated++);
    f.row('d').querySelector('button').addEventListener('click', e => { closed++; e.stopPropagation(); });
    f.click('a', { ctrlKey: true }); f.click('a'); assert.deepEqual(f.ids(), []); assert.equal(activated, 1);
    f.click('d', { ctrlKey: true }); f.event(f.row('d').querySelector('button'), 'click', { ctrlKey: true });
    // LinkeDOM does not implement ancestor capture; exercise the handler target
    // separately below. Native capture/buttons are covered by paired Chrome.
    assert.equal(closed, 1);
    f.event(f.document.body, 'keydown', { key: 'Escape' }); assert.deepEqual(f.ids(), []);
    f.click('a', { ctrlKey: true }); f.event(f.document.body, 'click'); assert.deepEqual(f.ids(), []);
});

test('Space and pinned-root changes clear selection and never reuse an old anchor', () => {
    const f = fixture(); f.click('a', { ctrlKey: true });
    f.context.activeSpaceId = 'other'; f.selection.reconcile(); assert.deepEqual(f.ids(), []);
    f.context.activeSpaceId = 's'; f.click('d', { shiftKey: true }); assert.deepEqual(f.ids(), ['d']);
    f.context.spaces[0].bookmarkFolderId = 'replacement'; f.selection.reconcile(); assert.deepEqual(f.ids(), []);
});

test('hidden, moved, removed, rebound and duplicate rows are pruned instead of matched by URL', () => {
    for (const change of ['hidden', 'moved', 'removed', 'rebound', 'duplicate']) {
        const f = fixture(); f.click('b', { ctrlKey: true }); f.click('d', { ctrlKey: true });
        if (change === 'hidden') f.row('b').parentElement.classList.add('collapsed');
        if (change === 'moved') f.row('a').parentElement.append(f.row('b'));
        if (change === 'removed') f.row('b').remove();
        if (change === 'rebound') f.row('b').dataset.tabId = '9';
        if (change === 'duplicate') { const duplicate = f.row('b').cloneNode(true); f.selection.register(duplicate); f.row('b').after(duplicate); }
        f.selection.reconcile(); assert.deepEqual(f.ids(), ['d'], change);
    }
});

test('selection never accepts temporary, inactive-space, unregistered or hidden rows', () => {
    const f = fixture();
    for (const id of ['temporary', 'other', 'hidden']) f.click(id, { ctrlKey: true });
    assert.deepEqual(f.ids(), []);
    const fake = f.row('a').cloneNode(true); fake.dataset.bookmarkId = 'forged'; f.row('a').after(fake);
    assert.equal(f.selection.freeze(fake), null);
});

test('dragging a selected member freezes the whole ordered batch; unselected member becomes singleton', () => {
    const f = fixture(); f.click('d', { ctrlKey: true }); f.click('b', { ctrlKey: true });
    const result = f.start('b');
    assert.equal(result.source.kind, 'bookmarks'); assert.equal(f.drag.isBatch(), true);
    assert.deepEqual(f.drag.inspect().source.bookmarks.map(entry => [entry.bookmarkId, entry.parentId, entry.tabId]), [['b', 'folder', 7], ['d', 'root', null]]);
    assert(Object.isFrozen(result.source.selectionSnapshot.entries));
    f.row('b').classList.remove('dragging'); f.drag.clear();
    f.start('a'); assert.equal(f.drag.inspect().source.kind, 'bookmark'); assert.deepEqual(f.ids(), ['a']);
});

test('frozen drag rejects every selected-source/context/order change without silently shrinking the batch', () => {
    for (const change of ['removed', 'replaced', 'parent', 'bookmark', 'tab', 'url', 'pinned-url', 'hidden', 'order', 'selection', 'window', 'space', 'root']) {
        const f = fixture(); f.click('a', { ctrlKey: true }); f.click('b', { ctrlKey: true }); f.start('a');
        if (change === 'removed') f.row('b').remove();
        if (change === 'replaced') { const replacement = f.row('b').cloneNode(true); f.selection.register(replacement); f.row('b').replaceWith(replacement); }
        if (change === 'parent') f.row('a').parentElement.append(f.row('b'));
        if (change === 'bookmark') f.row('b').dataset.bookmarkId = 'forged';
        if (change === 'tab') f.row('b').dataset.tabId = '100';
        if (change === 'url') f.row('b').dataset.url = 'https://changed.test/';
        if (change === 'pinned-url') f.row('b').dataset.pinnedUrl = 'https://changed.test/';
        if (change === 'hidden') f.row('b').parentElement.classList.add('collapsed');
        if (change === 'order') f.row('a').parentElement.append(f.row('a'));
        if (change === 'selection') f.click('b', { ctrlKey: true });
        if (change === 'window') f.context.windowId = 11;
        if (change === 'space') f.context.activeSpaceId = 'other';
        if (change === 'root') f.context.spaces[0].bookmarkFolderId = 'other-root';
        assert.match(f.drag.inspect().error, /changed/, change); assert.equal(f.drag.isBatch(), true, 'stale batch still blocks legacy drops');
        assert.equal(f.drag.take().source, undefined); assert.equal(f.drag.isBatch(), false);
    }
});

test('selection limit is explicit and never truncates 101 selected bookmarks', () => {
    const f = fixture(Array.from({ length: 101 }, (_, i) => htmlRow(`limit-${i}`)).join(''));
    f.click('limit-0', { ctrlKey: true }); f.click('limit-100', { shiftKey: true });
    assert.equal(f.ids().length, 101);
    assert.match(f.document.getElementById('bookmarkSelectionStatus').textContent, /at most 100/);
    assert.match(f.start('limit-50').error, /at most 100/);
    assert.equal(f.drag.inspect().source, undefined);
});

test('drag image carries the selected count and is removed on end/blur', () => {
    const f = fixture(); let image;
    f.selection.dragImage({ dataTransfer: { setDragImage(node) { image = node; } } }, 3);
    assert.equal(image.dataset.count, '3'); assert.match(image.textContent, /3 bookmarks/); assert(image.isConnected);
    f.event(f.document.body, 'dragend'); assert(!image.isConnected);
});

test('keyboard Space toggles and Shift+Space extends selection without invoking activation', () => {
    const f = fixture(); f.event(f.row('a'), 'keydown', { key: ' ' });
    f.event(f.row('c'), 'keydown', { key: ' ', shiftKey: true });
    assert.deepEqual(f.ids(), ['a', 'b', 'c']);
});

test('modified Enter, IME, repeated keys and inner controls do not activate or toggle a bookmark', () => {
    const f = fixture(); let activated = 0;
    f.row('a').addEventListener('click', () => activated++);
    for (const modifiers of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { isComposing: true }, { repeat: true }]) {
        f.event(f.row('a'), 'keydown', { key: 'Enter', ...modifiers });
    }
    f.event(f.row('a'), 'keydown', { key: ' ', isComposing: true });
    f.event(f.row('a'), 'keydown', { key: ' ', repeat: true });
    f.event(f.row('a').querySelector('button'), 'keydown', { key: ' ' });
    assert.equal(activated, 0); assert.deepEqual(f.ids(), []);
    f.event(f.row('a'), 'keydown', { key: 'Enter' }); assert.equal(activated, 1, 'plain Enter retains activation');
});

test('batch request sends exact IDs/context in frozen order without source URLs or DOM data', async () => {
    const f = fixture(); f.click('b', { ctrlKey: true }); f.click('d', { ctrlKey: true }); f.start('b');
    const calls = [], api = { runtime: { async sendMessage(message) { calls.push(message); return { success: true }; } } };
    const add = createSavedBookmarkFavoriteDrop({ getContext: () => f.context, api });
    await add(f.drag.take().source, 'anchor');
    assert.deepEqual(calls, [{ type: 'favoriteStore', action: 'addBookmarks', windowId: 10, spaceId: 's', bookmarkFolderId: 'root', beforeId: 'anchor',
        bookmarks: [{ bookmarkId: 'b', parentId: 'folder', tabId: 7 }, { bookmarkId: 'd', parentId: 'root' }] }]);
});

test('partial failure data survives request rejection and reports completed, failed, and unattempted exact IDs', async () => {
    const batch = { complete: false, entries: [{ bookmarkId: 'a', status: 'completed', favoriteId: 'fa', tabId: 7 },
        { bookmarkId: 'b', status: 'failed', error: 'Pin was not verified.', code: 'UNCERTAIN' }, { bookmarkId: 'c', status: 'unattempted' }] };
    const api = { runtime: { async sendMessage() { return { success: false, error: 'Partial batch', code: 'UNCERTAIN', batch }; } } };
    await assert.rejects(favoriteRequest('addBookmarks', {}, api), error => error.batch === batch && error.code === 'UNCERTAIN');
    const text = describeBookmarkBatchOutcome(batch);
    assert.match(text, /1 completed, 1 failed, 1 not attempted/); assert.match(text, /Completed bookmark IDs: a/);
    assert.match(text, /Failed bookmark b: Pin was not verified/); assert.match(text, /Not attempted bookmark IDs: c/); assert.match(text, /Nothing was retried automatically/);
    assert.match(describeBookmarkBatchOutcome({ complete: true, entries: batch.entries.slice(0, 1) }), /1 completed, 0 failed, 0 not attempted/);
});
