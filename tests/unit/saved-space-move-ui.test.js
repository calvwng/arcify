import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createBookmarkSelection } from '../../bookmark-selection.js';
import { createTodayTabSelection } from '../../today-tab-selection.js';
import { createContextMenuSession } from '../../context-menu-session.js';
import { captureSavedSelectionMove, captureSavedFolderMove, createSavedSpaceMoveAction, describeSavedMoveOutcome,
    freezeSavedMoveTree, openSavedFolderContextMenu } from '../../saved-space-move-ui.js';

const settle = () => new Promise(resolve => setImmediate(resolve));
const defer = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const leaf = (id, parentId, title = `Saved ${id}`) => ({ id, parentId, title, url: 'https://same.test/' });
const rowHTML = (id, live = false) => `<div class="tab" data-bookmark-id="${id}" data-bookmark-title="Saved ${id}" data-url="${live ? 'https://navigated.test/' : 'https://same.test/'}" data-pinned-url="https://same.test/" ${live ? 'data-tab-id="7"' : ''}><span class="tab-title-display">${live ? 'Different live alias' : `Saved ${id}`}</span></div>`;
function fixture({ inverted = false, collapsed = false, send, refresh, readBookmarks, readTree } = {}) {
    const rootRows = [rowHTML('a'), `<div class="folder ${collapsed ? 'collapsed' : ''}" data-bookmark-id="folder"><div class="folder-header" tabindex="0"><span class="folder-title">Folder</span></div><div class="folder-content ${collapsed ? 'collapsed' : ''}">${rowHTML('b', true)}<div class="folder" data-bookmark-id="nested"><div class="folder-header"><span class="folder-title">Nested</span></div><div class="folder-content">${rowHTML('c')}</div></div></div></div>`, rowHTML('d')];
    const { document, window } = parseHTML(`<html><body><div id="spacesList"><div class="space active" data-space-id="source"><div class="pinned-tabs" data-tab-type="pinned" data-saved-order-inverted="${inverted}">${(inverted ? rootRows.reverse() : rootRows).join('')}</div><div data-tab-type="temporary"><div class="tab" data-tab-id="9" data-url="https://today.test/"></div></div></div></div><div class="new-tab-btn-container"></div><button id="outside">Outside</button></body></html>`);
    const context = { windowId: 10, activeSpaceId: 'source', spaces: [
        { id: 'source', name: 'Source', bookmarkFolderId: 'root', temporaryTabs: [9], spaceBookmarks: [7] },
        { id: 'dest', name: '<img src=x> Destination', bookmarkFolderId: 'dest-root', temporaryTabs: [], spaceBookmarks: [] },
        { id: 'third', name: 'Third', bookmarkFolderId: 'third-root', temporaryTabs: [], spaceBookmarks: [] }
    ] };
    const tree = { id: 'folder', parentId: 'root', title: 'Folder', children: [leaf('b', 'folder'),
        { id: 'nested', parentId: 'folder', title: 'Nested', children: [leaf('c', 'nested')] },
        { id: 'empty', parentId: 'folder', title: 'Empty', children: [] }] };
    const bookmarks = [leaf('a', 'root'), leaf('b', 'folder'), leaf('c', 'nested'), leaf('d', 'root')];
    const state = { inverted, readInverted: async () => state.inverted, reads: [] };
    let focused = document.body;
    Object.defineProperty(document, 'activeElement', { get: () => focused });
    window.HTMLElement.prototype.focus = function () { focused = this; };
    window.HTMLElement.prototype.getBoundingClientRect = () => ({ left: 10, bottom: 20, width: 260, height: 200 });
    window.innerWidth = 400; window.innerHeight = 700;
    const selection = createBookmarkSelection({ document, getContext: () => context, onGesture: () => today.clear() });
    const today = createTodayTabSelection({ document, getContext: () => context, onGesture: () => selection.clear() });
    for (const node of document.querySelectorAll('.tab[data-bookmark-id]')) selection.register(node);
    today.register(document.querySelector('[data-tab-id="9"]'));
    const row = id => document.querySelector(`.tab[data-bookmark-id="${id}"]`);
    const folder = document.querySelector('.folder[data-bookmark-id="folder"]');
    const event = (target, type, extra = {}) => { const e = new window.Event(type, { bubbles: true, cancelable: true }); Object.assign(e, extra); target.dispatchEvent(e); return e; };
    const select = ids => { selection.clear(); ids.forEach(id => event(row(id), 'click', { ctrlKey: true })); };
    const captureOptions = { document, selection, getContext: () => context,
        readBookmarks: async ids => { state.reads.push(ids); return readBookmarks ? readBookmarks(ids) : structuredClone(bookmarks.filter(item => ids.includes(item.id))); },
        readTree: async id => { state.reads.push(id); return readTree ? readTree(id) : structuredClone([tree]); },
        readInverted: () => state.readInverted() };
    const calls = [], statuses = [], lifecycle = [];
    const action = createSavedSpaceMoveAction({ selection, getContext: () => context, readInverted: () => state.readInverted(),
        showStatus: text => statuses.push(text), begin: () => lifecycle.push('begin'), end: () => lifecycle.push('end'),
        refresh: async () => { lifecycle.push('refresh'); await refresh?.(); },
        sendRequest: async request => {
            calls.push(structuredClone(request));
            return send ? send(request) : { success: true, batch: { total: request.entries.length,
                completed: request.entries.map(entry => entry.bookmarkId), remaining: [], uncertain: false, destinationSpaceId: request.destinationSpaceId } };
        } });
    const capture = (id = 'a', active) => captureSavedSelectionMove(selection.freeze(row(id)), { ...captureOptions, active });
    const captureFolder = active => captureSavedFolderMove(folder, { ...captureOptions, active });
    return { document, window, context, state, bookmarks, tree, row, folder, event, select, selection, today, captureOptions,
        capture, captureFolder, action, calls, statuses, lifecycle };
}

for (const inverted of [false, true]) test(`closed/live saved pins use exact bookmark identities and saved metadata, inverted=${inverted}`, async () => {
    for (const ids of [['a'], ['b'], ['d', 'a', 'b']]) {
        const f = fixture({ inverted }); f.select(ids);
        const snapshot = await f.capture(ids[0]), actions = f.action(snapshot);
        await actions.move(actions.destinations[0]);
        const expected = ids.length === 1 ? ids : inverted ? ['d', 'b', 'a'] : ['a', 'b', 'd'];
        assert.deepEqual(f.calls, [{ type: 'moveSavedItemsToSpace', windowId: 10, spaceId: 'source', bookmarkFolderId: 'root',
            destinationSpaceId: 'dest', destinationBookmarkFolderId: 'dest-root', inverted,
            entries: expected.map(bookmarkId => ({ bookmarkId, parentId: bookmarkId === 'b' ? 'folder' : 'root',
                title: `Saved ${bookmarkId}`, url: 'https://same.test/', tabId: bookmarkId === 'b' ? 7 : null })) }]);
        assert.equal(f.context.activeSpaceId, 'source'); assert.deepEqual(f.lifecycle, ['begin', 'end', 'refresh']);
        assert.match(f.statuses.at(-1), /saved pin.*still in the current Space/);
        assert.deepEqual(f.state.reads, [expected]);
    }
});

test('saved titles are fetched by identity even when a row has no cached title or has a live alias', async () => {
    const f = fixture(); delete f.row('b').dataset.bookmarkTitle;
    f.select(['b']); const snapshot = await f.capture('b');
    assert.equal(snapshot.entries[0].title, 'Saved b'); assert.equal(snapshot.entries[0].url, 'https://same.test/');
    assert.equal(snapshot.entries[0].tabId, 7);
});

for (const inverted of [false, true]) test(`clicked collapsed folder freezes exact nested canonical tree and empty folders, inverted=${inverted}`, async () => {
    const f = fixture({ inverted, collapsed: true });
    const snapshot = await f.captureFolder(), original = structuredClone(snapshot.entries[0]);
    assert(Object.isFrozen(snapshot)); assert(Object.isFrozen(snapshot.entries[0].tree.children));
    assert.deepEqual(snapshot.entries[0], { bookmarkId: 'folder', parentId: 'root', title: 'Folder', url: null, tabId: null,
        tree: { id: 'folder', parentId: 'root', title: 'Folder', url: null, children: [
            { ...leaf('b', 'folder'), children: [] },
            { id: 'nested', parentId: 'folder', title: 'Nested', url: null, children: [{ ...leaf('c', 'nested'), children: [] }] },
            { id: 'empty', parentId: 'folder', title: 'Empty', url: null, children: [] }
        ] } });
    // The writer must compare this frozen tree, never silently capture a newer
    // tree after confirmation or use only its visible live-tab descendants.
    f.tree.children.reverse(); f.tree.children[0].title = 'Changed';
    const actions = f.action(snapshot); await actions.move(actions.destinations[0]);
    assert.deepEqual(f.calls[0].entries, [original]); assert.equal(f.calls[0].inverted, inverted);
    assert.match(f.statuses.at(-1), /Moved 1 folder with its saved pins/); assert.equal(f.context.activeSpaceId, 'source');
});

test('Today and saved selection gestures cannot produce a mixed move batch', async () => {
    const f = fixture(), todayRow = f.document.querySelector('[data-tab-id="9"]');
    f.select(['a', 'd']); f.event(todayRow, 'click', { ctrlKey: true });
    assert.equal(f.document.getElementById('bookmarkSelectionStatus').dataset.count, '0');
    f.event(f.row('a'), 'click', { ctrlKey: true });
    assert.equal(f.document.getElementById('todaySelectionStatus').dataset.count, '0');
    const snapshot = await f.capture('a'); assert.deepEqual(snapshot.entries.map(entry => entry.bookmarkId), ['a']);
    assert.equal(f.selection.freeze(todayRow), null);
});

for (const change of ['remove', 'navigate-live', 'saved-url', 'title', 'reorder', 'hide', 'replace', 'source-space', 'pending-space', 'source-root', 'window', 'inverted-dom', 'inverted-setting', 'destination-delete', 'destination-root', 'forged-destination', 'blur', 'selection']) {
    test(`saved move revalidates frozen source and destination before dispatch: ${change}`, async () => {
        const f = fixture(); f.select(['a', 'b']); const snapshot = await f.capture(), actions = f.action(snapshot);
        let destination = actions.destinations[0];
        if (change === 'remove') f.row('a').remove();
        if (change === 'navigate-live') f.row('b').dataset.url = 'https://new-live.test/';
        if (change === 'saved-url') f.row('a').dataset.pinnedUrl = 'https://new-saved.test/';
        if (change === 'title') f.row('a').dataset.bookmarkTitle = 'Renamed';
        if (change === 'reorder') f.row('a').parentElement.append(f.row('a'));
        if (change === 'hide') f.row('a').hidden = true;
        if (change === 'replace') { const row = f.row('a'), clone = row.cloneNode(true); f.selection.register(clone); row.replaceWith(clone); }
        if (change === 'source-space') f.context.activeSpaceId = 'dest';
        if (change === 'pending-space') f.context.pendingActiveSpaceId = 'dest';
        if (change === 'source-root') f.context.spaces[0].bookmarkFolderId = 'changed';
        if (change === 'window') f.context.windowId = 20;
        if (change === 'inverted-dom') f.row('a').parentElement.dataset.savedOrderInverted = 'true';
        if (change === 'inverted-setting') f.state.inverted = true;
        if (change === 'destination-delete') f.context.spaces.splice(1, 1);
        if (change === 'destination-root') f.context.spaces[1].bookmarkFolderId = 'changed';
        if (change === 'forged-destination') destination = { ...destination };
        if (change === 'blur') f.event(f.window, 'blur');
        if (change === 'selection') f.event(f.row('d'), 'click', { ctrlKey: true });
        await actions.move(destination);
        assert.deepEqual(f.calls, []); assert.match(f.statuses.at(-1), /Nothing was moved/);
    });
}

for (const stage of ['capture', 'dispatch']) for (const change of ['selection', 'Space', 'order', 'destination']) {
    test(`${stage} rechecks ${change} after its asynchronous read`, async () => {
        const pending = defer(); const f = fixture(); f.select(['a', 'd']);
        let promise;
        if (stage === 'capture') {
            f.state.readInverted = () => pending.promise;
            promise = f.capture();
        } else {
            const actions = f.action(await f.capture()); f.state.readInverted = () => pending.promise;
            promise = actions.move(actions.destinations[0]);
        }
        if (change === 'selection') f.event(f.row('b'), 'click', { ctrlKey: true });
        if (change === 'Space') f.context.activeSpaceId = 'dest';
        if (change === 'order') f.row('a').parentElement.dataset.savedOrderInverted = 'true';
        if (change === 'destination') f.context.spaces[1].bookmarkFolderId = 'new-destination-root';
        pending.resolve(false);
        const result = await promise;
        if (stage === 'capture' && change !== 'destination') assert.equal(result, null);
        assert.deepEqual(f.calls, []);
        if (stage === 'dispatch') assert.match(f.statuses.at(-1), /Nothing was moved/);
    });
}

for (const change of ['missing', 'duplicate', 'parent', 'saved-url', 'title', 'folder', 'inverted']) {
    test(`menu-open saved read rejects changed or malformed bookmark data: ${change}`, async () => {
        const f = fixture(); f.select(['a', 'd']);
        if (change === 'missing') f.bookmarks.shift();
        if (change === 'duplicate') f.bookmarks.push({ ...f.bookmarks[0] });
        if (change === 'parent') f.bookmarks[0].parentId = 'elsewhere';
        if (change === 'saved-url') f.bookmarks[0].url = 'https://changed.test/';
        if (change === 'title') f.bookmarks[0].title = 'Renamed';
        if (change === 'folder') delete f.bookmarks[0].url;
        if (change === 'inverted') f.state.inverted = true;
        await assert.rejects(f.capture(), /Nothing was moved/); assert.deepEqual(f.calls, []);
    });
}

test('folder snapshot normalization rejects incomplete, duplicate or contradictory trees', () => {
    const original = fixture().tree;
    for (const change of [tree => delete tree.children, tree => tree.children.push({ ...tree.children[0] }),
        tree => tree.children[0].parentId = 'wrong', tree => tree.children[0].children = [leaf('extra', 'b')],
        tree => delete tree.children[1].children, tree => tree.children[0].url = '', tree => delete tree.title]) {
        const tree = structuredClone(original); change(tree); assert.throws(() => freezeSavedMoveTree(tree), /Nothing was moved/);
    }
});

test('one pending gate covers pin/folder moves and a consumed folder action never dispatches twice', async () => {
    const pending = defer(), f = fixture({ send: () => pending.promise }); f.select(['a']);
    const pin = f.action(await f.capture()), folder = f.action(await f.captureFolder());
    const running = folder.move(folder.destinations[0]); await settle();
    await folder.move(folder.destinations[0]); await pin.move(pin.destinations[0]); assert.equal(f.calls.length, 1);
    pending.reject(new Error('channel closed')); await running;
    await folder.move(folder.destinations[0]); assert.equal(f.calls.length, 1);
    assert.deepEqual(f.lifecycle, ['begin', 'end', 'refresh']); assert.match(f.statuses.at(-1), /unknown.*nothing was retried/);
});

test('partial, unknown and malformed receipts cannot claim complete success, and refresh failures retain result', async () => {
    const entries = ['a', 'd'].map(bookmarkId => ({ bookmarkId, url: 'https://same.test/' })), destination = { id: 'dest', name: 'Destination' };
    const batch = { total: 2, completed: ['a'], remaining: ['d'], uncertain: false, destinationSpaceId: 'dest' };
    assert.match(describeSavedMoveOutcome({ success: false, batch, error: 'Second pin changed.' }, entries, destination), /1 of 2 saved pins confirmed moved.*Second pin changed.*nothing was retried/);
    assert.match(describeSavedMoveOutcome({ success: false, batch: { ...batch, uncertain: true } }, entries, destination), /Some moves could not be confirmed/);
    assert.match(describeSavedMoveOutcome({ success: false, batch: { ...batch, completed: [], remaining: ['a', 'd'] } }, entries, destination), /Nothing was moved/);
    for (const response of [undefined, { success: true }, { success: true, batch },
        { success: false, batch: { ...batch, completed: ['wrong'] } }, { success: false, batch: { ...batch, remaining: ['a'] } },
        { success: false, batch: { ...batch, total: 3 } }, { success: false, batch: { ...batch, destinationSpaceId: 'other' } },
        { success: true, batch: { ...batch, completed: ['a', 'a'], remaining: [] } }]) {
        assert.match(describeSavedMoveOutcome(response, entries, destination), /result is unknown/);
    }
    const f = fixture({ refresh: () => { throw new Error('offline'); } }); f.select(['a']);
    const actions = f.action(await f.capture()); await actions.move(actions.destinations[0]);
    assert.match(f.statuses.at(-1), /Moved 1 saved pin.*sidebar could not refresh/); assert.equal(f.calls.length, 1);
});

async function menus(f) {
    const previous = { document: globalThis.document, window: globalThis.window };
    Object.assign(globalThis, { document: f.document, window: f.window });
    const { showTabContextMenu, closeTabContextMenu } = await import('../../domManager.js');
    const counts = { begins: 0, ends: 0, creates: 0, deletes: 0 };
    const beginInteraction = () => { counts.begins++; return () => { counts.ends++; }; };
    const item = action => f.document.querySelector(`[data-action="${action}"]`);
    const pin = async (ids = ['a', 'b']) => {
        f.select(ids); const actions = f.action(await f.capture(ids[0])), target = f.row(ids[0]);
        showTabContextMenu(0, 0, { id: Number(target.dataset.tabId) || null }, true, !target.dataset.tabId, target,
            () => assert.fail('Must not close tabs'), f.context.spaces, () => assert.fail('Must not call legacy movement'),
            () => assert.fail('Must not change current Space'), [], () => assert.fail('Must not create a Space'), null, null, null,
            { selectionCount: ids.length }, { keyboard: true, beginInteraction }, null, actions);
    };
    const folder = async (options = {}) => {
        closeTabContextMenu(); f.selection.clear(); f.today.clear();
        return openSavedFolderContextMenu({ document: f.document, element: f.folder, event: { clientX: 10, clientY: 20 }, keyboard: true,
            prepareMove: f.captureFolder, createMoveAction: f.action, canCreate: async () => true,
            createFolder: () => counts.creates++, deleteFolder: () => counts.deletes++, beginInteraction,
            showStatus: text => f.statuses.push(text), ...options });
    };
    return { pin, folder, item, counts, close: closeTabContextMenu,
        cleanup: () => { createContextMenuSession(f.document).close(); closeTabContextMenu(); Object.assign(globalThis, previous); } };
}

for (const kind of ['pin', 'folder']) test(`${kind} menu has a saved-specific keyboard picker, Back and exactly one dispatch`, async () => {
    const f = fixture(), m = await menus(f);
    try {
        await m[kind]();
        assert.equal(f.document.querySelector('.with-submenu'), null); assert.equal(m.item('moveTodayTabsToSpace'), null);
        const trigger = m.item('moveSavedItemsToSpace'); assert(trigger); assert.equal(trigger.getAttribute('aria-haspopup'), 'menu');
        f.event(trigger, 'keydown', { key: 'Enter' });
        assert.match(f.document.querySelector('.today-move-hint').textContent, kind === 'folder' ? /folder and all its saved pins/ : /2 saved pins/);
        assert.doesNotMatch(f.document.querySelector('.today-move-hint').textContent, /Today/);
        let choices = [...f.document.querySelectorAll('[data-action="moveSavedToDestination"]')];
        assert.deepEqual(choices.map(item => item.dataset.spaceId), ['dest', 'third']); assert.equal(choices[0].querySelector('img'), null);
        assert.equal(f.document.activeElement, choices[0]); f.event(choices[0], 'keydown', { key: 'ArrowDown' }); assert.equal(f.document.activeElement, choices[1]);
        f.event(choices[1], 'keydown', { key: 'Home' }); assert.equal(f.document.activeElement, m.item('backToTabMenu'));
        f.event(m.item('backToTabMenu'), 'keydown', { key: 'Enter' }); assert.equal(f.document.activeElement, trigger);
        f.event(choices[0], 'click'); await settle(); assert.deepEqual(f.calls, [], 'A detached choice after Back must be inert');
        assert.deepEqual([m.counts.begins, m.counts.ends], [1, 0]);
        f.event(trigger, 'click'); choices = [...f.document.querySelectorAll('[data-action="moveSavedToDestination"]')];
        f.event(choices[0], 'keydown', { key: 'Enter' }); f.event(choices[0], 'click'); await settle();
        assert.equal(f.calls.length, 1); assert.equal(f.document.querySelector('.context-menu'), null);
        assert.equal(f.context.activeSpaceId, 'source'); assert.equal(m.counts.ends, 1);
        assert.deepEqual([m.counts.creates, m.counts.deletes], [0, 0]);
    } finally { m.cleanup(); }
});

test('single closed and live pins both expose the saved picker; a missing saved snapshot never falls back', async () => {
    const f = fixture(), m = await menus(f);
    try {
        for (const id of ['a', 'b']) { await m.pin([id]); assert(m.item('moveSavedItemsToSpace')); m.close(); }
        const { showTabContextMenu } = await import('../../domManager.js');
        showTabContextMenu(0, 0, { id: 7 }, true, false, f.row('b'), () => {}, f.context.spaces,
            () => assert.fail('No legacy fallback'), () => {}, [], () => {});
        assert.equal(m.item('moveSavedItemsToSpace'), null); assert.equal(f.document.querySelector('.with-submenu'), null);
    } finally { m.cleanup(); }
});

for (const kind of ['pin', 'folder']) for (const exit of ['Escape', 'outside', 'pointerdown', 'blur', 'hidden', 'pagehide', 'superseded', 'removed', 'explicit']) {
    test(`${kind} picker ${exit} releases the menu once, with no stale action or outside focus theft`, async () => {
        const f = fixture(), m = await menus(f);
        try {
            await m[kind](); f.event(m.item('moveSavedItemsToSpace'), 'click');
            const stale = m.item('moveSavedToDestination'), outside = f.document.getElementById('outside'); outside.focus();
            if (exit === 'Escape') f.event(stale, 'keydown', { key: 'Escape' });
            if (exit === 'outside' || exit === 'pointerdown') f.event(outside, exit === 'outside' ? 'click' : exit);
            if (exit === 'blur' || exit === 'pagehide') f.event(f.window, exit);
            if (exit === 'hidden') { Object.defineProperty(f.document, 'hidden', { value: true }); f.event(f.document, 'visibilitychange'); }
            if (exit === 'superseded') await m[kind]();
            if (exit === 'removed') { f.document.querySelector('.context-menu').remove(); await settle(); }
            if (exit === 'explicit') createContextMenuSession(f.document).close();
            assert.equal(m.counts.ends, 1);
            if (!['Escape', 'superseded'].includes(exit)) assert.equal(f.document.activeElement, outside);
            f.event(stale, 'click'); await settle(); assert.deepEqual(f.calls, []);
            createContextMenuSession(f.document).close(); assert.equal(m.counts.ends, m.counts.begins);
        } finally { m.cleanup(); }
    });
}

for (const stage of ['tree', 'canCreate']) for (const exit of ['Escape', 'outside', 'blur', 'superseded', 'source-space', 'source-title', 'source-remove', 'source-hide']) {
    test(`folder menu pending ${stage} read cannot mount or mutate after ${exit}`, async () => {
        const pending = defer(), f = fixture({ readTree: stage === 'tree' ? () => pending.promise : undefined }), m = await menus(f);
        try {
            const running = m.folder(stage === 'canCreate' ? { canCreate: () => pending.promise } : {}); await settle();
            if (exit === 'Escape') f.event(f.document, 'keydown', { key: 'Escape' });
            if (exit === 'outside') f.event(f.document.getElementById('outside'), 'click');
            if (exit === 'blur') f.event(f.window, 'blur');
            if (exit === 'superseded') createContextMenuSession(f.document).close();
            if (exit === 'source-space') f.context.activeSpaceId = 'dest';
            if (exit === 'source-title') f.folder.querySelector('.folder-title').textContent = 'Changed';
            if (exit === 'source-remove') f.folder.remove();
            if (exit === 'source-hide') f.folder.hidden = true;
            pending.resolve(stage === 'tree' ? [f.tree] : true); await running;
            assert.equal(f.document.getElementById('folder-context-menu'), null); assert.deepEqual(f.calls, []);
            assert.deepEqual(m.counts, { begins: 0, ends: 0, creates: 0, deletes: 0 });
        } finally { m.cleanup(); }
    });
}

for (const exit of ['Escape', 'outside', 'blur', 'superseded']) test(`pin menu preparation is cancelled across bookmark reads by ${exit}`, async () => {
    const pending = defer(), f = fixture({ readBookmarks: () => pending.promise }); f.select(['a']);
    const session = createContextMenuSession(f.document), running = f.capture('a', () => session.active);
    if (exit === 'Escape') f.event(f.document, 'keydown', { key: 'Escape' });
    if (exit === 'outside') f.event(f.document.getElementById('outside'), 'click');
    if (exit === 'blur') f.event(f.window, 'blur');
    if (exit === 'superseded') createContextMenuSession(f.document).close();
    pending.resolve([leaf('a', 'root')]); assert.equal(await running, null); assert.deepEqual(f.calls, []);
});

for (const stage of ['capture', 'dispatch']) for (const exit of ['Escape', 'outside', 'blur', 'selection']) {
    test(`folder ${stage} rechecks later gestures during its async setting read: ${exit}`, async () => {
        const f = fixture(), pending = defer(); let running;
        if (stage === 'capture') { f.state.readInverted = () => pending.promise; running = f.captureFolder(); }
        else {
            const actions = f.action(await f.captureFolder()); f.state.readInverted = () => pending.promise;
            running = actions.move(actions.destinations[0]);
        }
        if (exit === 'Escape') f.event(f.document, 'keydown', { key: 'Escape' });
        if (exit === 'outside') f.event(f.document.getElementById('outside'), 'click');
        if (exit === 'blur') f.event(f.window, 'blur');
        if (exit === 'selection') f.event(f.row('a'), 'click', { ctrlKey: true });
        pending.resolve(false); const result = await running;
        if (stage === 'capture') assert.equal(result, null);
        else assert.match(f.statuses.at(-1), /Nothing was moved/);
        assert.deepEqual(f.calls, []);
    });
}

test('stale folder main-menu controls cannot act after dismissal, Back detachment, or source mutation', async () => {
    const f = fixture(), m = await menus(f);
    try {
        await m.folder(); const oldDelete = m.item('deleteFolder');
        f.event(m.item('moveSavedItemsToSpace'), 'click'); f.event(oldDelete, 'click'); await settle();
        assert.equal(m.counts.deletes, 0);
        f.event(m.item('backToTabMenu'), 'click');
        f.folder.querySelector('.folder-title').textContent = 'New folder name';
        f.event(oldDelete, 'click'); await settle(); assert.equal(m.counts.deletes, 0);
        assert.equal(f.document.getElementById('folder-context-menu'), null); assert.match(f.statuses.at(-1), /Nothing was moved/);
        f.event(oldDelete, 'click'); await settle(); assert.equal(m.counts.deletes, 0);
    } finally { m.cleanup(); }
});
