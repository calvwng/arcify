import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createBookmarkFavoriteDrop, createFavoritesDragSource } from '../../favorites-drop.js';
import { Utils } from '../../utils.js';

function locks() {
    const queues = new Map();
    return { request(key, callback) {
        const run = (queues.get(key) || Promise.resolve()).then(callback);
        queues.set(key, run.catch(() => {}));
        return run;
    } };
}
function fixture() {
    const source = { spaceId: 's', windowId: 10, bookmarkFolderId: 'p', parentId: 'f', bookmarkId: 'saved', tabId: null };
    const spaces = [{ id: 's', bookmarkFolderId: 'p', spaceBookmarks: [], temporaryTabs: [] }];
    const context = { spaces, activeSpaceId: 's', windowId: 10 };
    const bookmark = { id: 'saved', parentId: 'f', title: 'Saved', url: 'https://saved.test/' };
    const tree = { p: [{ id: 'f', parentId: 'p', title: 'Folder' }], f: [bookmark] };
    const tabs = [], effects = [], bindings = {}, hooks = {}, session = { activeSpaces: { 10: 's' } };
    let nextId = 100;
    const api = {
        windows: { async get(id) { await hooks.window?.(id); return { id }; } },
        bookmarks: { async get(id) { return id === 'p' ? [{ id: 'p', parentId: 'root', title: 'Space' }] : []; },
            async search() { return [{ id: 'root', title: 'Arcify' }]; },
            async getChildren(id) { await hooks.children?.(id); return structuredClone(tree[id] || []); } },
        storage: { session: { async get(key) { await hooks.sessionGet?.(key); return structuredClone({ [key]: session[key] }); },
            async set(values) { await hooks.sessionSet?.(values); Object.assign(session, structuredClone(values)); } },
            local: { async get() { await hooks.bindingsGet?.(); return { pinnedTabStatesById: structuredClone(bindings) }; },
                async set({ pinnedTabStatesById: next }) { await hooks.bindingSet?.(next); for (const key of Object.keys(bindings)) delete bindings[key]; Object.assign(bindings, structuredClone(next)); } } },
        tabs: {
            async query({ windowId }) { const result = structuredClone(tabs.filter(tab => windowId === undefined || tab.windowId === windowId)); await hooks.query?.(); return result; },
            async get(id) { await hooks.get?.(id); const tab = tabs.find(tab => tab.id === id); if (!tab) throw new Error('Tab closed'); return structuredClone(tab); },
            async create(properties) { effects.push(['create', properties]); await hooks.create?.(properties); const tab = { id: nextId++, title: 'New favorite', ...properties }; tabs.push(tab); await hooks.created?.(tab); return structuredClone(tab); },
            async update(id, properties) { effects.push(['update', id, properties]); await hooks.update?.(id); const tab = tabs.find(tab => tab.id === id); Object.assign(tab, properties); return structuredClone(tab); },
            async move(id, properties) { effects.push(['move', id, properties]); await hooks.move?.(id); const tab = tabs.find(tab => tab.id === id); Object.assign(tab, properties); return structuredClone(tab); },
            async remove() { assert.fail('Favorites drops must never close a tab'); }
        }
    };
    globalThis.chrome = api;
    const sharedLocks = locks();
    Object.defineProperty(globalThis, 'navigator', { value: { locks: sharedLocks }, configurable: true });
    const getSpaces = async () => { await hooks.spaces?.(); return structuredClone(spaces); };
    const make = () => createBookmarkFavoriteDrop({ getContext: () => context, api, locks: sharedLocks, getSpaces });
    return { source, spaces, context, bookmark, tree, tabs, effects, bindings, hooks, session, api, add: make(), make };
}
function addLive(f, { id = 1, windowId = 10, pinned = false, bookmarkId = 'saved', owned = true, url = 'https://navigated.test/' } = {}) {
    f.tabs.push({ id, windowId, pinned, active: false, url });
    f.bindings[id] = { bookmarkId, pinnedUrl: f.bookmark.url };
    if (owned) f.spaces[0].spaceBookmarks.push(id);
}

test('creates exactly one inactive native pin from fresh bookmark data, without space or bookmark writes', async () => {
    const f = fixture(), before = structuredClone(f.tree), spaces = structuredClone(f.spaces);
    const result = await f.add(f.source, 2);
    assert.equal(result.created, true);
    assert.deepEqual(f.effects, [['create', { pinned: true, active: false, windowId: 10, url: 'https://saved.test/' }], ['move', 100, { index: 2 }]]);
    assert.deepEqual(f.bindings[100], { bookmarkId: 'saved', pinnedUrl: 'https://saved.test/' });
    assert.deepEqual(f.tree, before); assert.deepEqual(f.spaces, spaces);
    assert.deepEqual(f.session.activeSpaces, { 10: 's' });
    assert.equal(Object.values(f.session.favoriteDropAttempts)[0].tabId, 100);
});

test('re-reads the URL before create instead of using a stale row URL', async () => {
    const f = fixture(); f.source.url = 'https://stale-row.test/';
    f.hooks.query = () => { f.bookmark.url = 'https://fresh.test/'; };
    await f.add(f.source);
    assert.equal(f.effects[0][1].url, 'https://fresh.test/');
});

test('same-URL bookmarks retain separate identities; foreign-window and unbound twins are not reused', async () => {
    const f = fixture();
    addLive(f, { id: 1, windowId: 99, url: f.bookmark.url });
    addLive(f, { id: 2, bookmarkId: 'other', url: f.bookmark.url });
    f.tabs.push({ id: 3, windowId: 10, pinned: false, active: true, url: f.bookmark.url });
    await f.add(f.source);
    f.tree.f.push({ ...f.bookmark, id: 'twin' });
    await f.add({ ...f.source, bookmarkId: 'twin' });
    assert.equal(f.effects.filter(([kind]) => kind === 'create').length, 2);
    assert.equal(f.bindings[100].bookmarkId, 'saved'); assert.equal(f.bindings[101].bookmarkId, 'twin');
    assert.equal(f.tabs.find(tab => tab.id === 1).pinned, false);
    assert.equal(f.tabs.find(tab => tab.id === 3).active, true);
});

test('exact current-window owned live tab is reused even after navigation and with an internal saved URL', async () => {
    const f = fixture(); addLive(f); f.bookmark.url = 'chrome://settings/';
    await f.add({ ...f.source, tabId: 1 });
    assert.deepEqual(f.effects, [['update', 1, { pinned: true }], ['move', 1, { index: 0 }]]);
    assert.equal(f.tabs[0].url, 'https://navigated.test/');
    assert.equal(f.tabs[0].active, false);
});

test('exact native pin is reused without workspace membership or a new tab', async () => {
    const f = fixture(); addLive(f, { pinned: true, owned: false });
    await f.add(f.source); await f.add(f.source);
    assert.equal(f.effects.filter(([kind]) => kind === 'create' || kind === 'update').length, 0);
});

test('local concurrent drops coalesce; different sidebar documents serialize and reuse exact identity', async () => {
    const f = fixture(), secondSidebar = f.make();
    await Promise.all([f.add(f.source), f.add(f.source), secondSidebar(f.source), secondSidebar(f.source)]);
    await f.make()(f.source);
    assert.equal(f.effects.filter(([kind]) => kind === 'create').length, 1);
    assert.equal(f.tabs.length, 1);
});

for (const mode of ['deleted', 'moved', 'reassociated', 'space-switched', 'window-changed', 'window-closed']) test(`stale ${mode} source fails before mutation`, async () => {
    const f = fixture();
    if (mode === 'deleted') f.tree.f = [];
    if (mode === 'moved') f.bookmark.parentId = 'elsewhere';
    if (mode === 'reassociated') f.spaces[0].bookmarkFolderId = 'other';
    if (mode === 'space-switched') f.session.activeSpaces[10] = 'other';
    if (mode === 'window-changed') f.context.windowId = 99;
    if (mode === 'window-closed') f.hooks.window = () => { throw new Error('Window closed'); };
    await assert.rejects(f.add(f.source)); assert.deepEqual(f.effects, []);
});

test('bookmark deletion during async lookup is caught by fresh validation before create', async () => {
    const f = fixture(); f.hooks.query = () => { f.tree.f = []; };
    await assert.rejects(f.add(f.source), /bookmark.*changed/);
    assert.deepEqual(f.effects, []);
});

test('live binding changed or tab moved/closed before pin is never reused or replaced', async () => {
    for (const kind of ['binding', 'window', 'closed', 'ownership']) {
        const f = fixture(); addLive(f);
        f.hooks.query = () => {
            if (kind === 'binding') f.bindings[1].bookmarkId = 'other';
            if (kind === 'window') f.tabs[0].windowId = 99;
            if (kind === 'closed') f.tabs.splice(0);
            if (kind === 'ownership') { f.spaces[0].spaceBookmarks = []; f.spaces.push({ id: 'other', temporaryTabs: [1], spaceBookmarks: [] }); }
        };
        await assert.rejects(f.add({ ...f.source, tabId: 1 })); assert.deepEqual(f.effects, [], kind);
    }
});

test('closed row cannot steal its exact-bound nonnative tab from another workspace', async () => {
    const f = fixture(); addLive(f, { owned: false });
    f.spaces.push({ id: 'other', temporaryTabs: [1], spaceBookmarks: [] });
    await assert.rejects(f.add(f.source), /changed/); assert.deepEqual(f.effects, []);
});

for (const url of ['javascript:alert(1)', 'data:text/plain,hello', 'file:///tmp/private', 'chrome://settings/', 'bad url']) test(`new creation rejects unsupported URL ${url}`, async () => {
    const f = fixture(); f.bookmark.url = url;
    await assert.rejects(f.add(f.source), /Only http and https/); assert.deepEqual(f.effects, []);
});

test('missing lock or failing attempt storage stops before opening a tab', async () => {
    const f = fixture();
    const unavailable = createBookmarkFavoriteDrop({ getContext: () => f.context, api: f.api, locks: null });
    await assert.rejects(unavailable(f.source), /safety lock/);
    f.hooks.sessionSet = () => { throw new Error('Storage unavailable'); };
    await assert.rejects(f.add(f.source), /Storage unavailable/); assert.deepEqual(f.effects, []);
});

test('binding failure keeps created tab, preserves source, and retry from another sidebar finishes its exact receipt', async () => {
    const f = fixture(), before = structuredClone(f.tree);
    f.hooks.bindingSet = () => { throw new Error('Binding save failed'); };
    await assert.rejects(f.add(f.source), /pinned tab was opened.*Binding save failed/);
    assert.equal(f.tabs.length, 1); assert.deepEqual(f.tree, before);
    delete f.hooks.bindingSet;
    await f.make()(f.source);
    assert.equal(f.effects.filter(([kind]) => kind === 'create').length, 1);
    assert.equal(f.bindings[100].bookmarkId, 'saved');
});

test('uncertain creation fails explicitly and blocks blind retries across documents', async () => {
    const f = fixture(); f.hooks.create = () => { throw new Error('Create failed'); };
    await assert.rejects(f.add(f.source), /Chrome could not confirm/);
    delete f.hooks.create;
    await assert.rejects(f.make()(f.source), /earlier Favorites attempt could not be verified/);
    assert.equal(f.effects.filter(([kind]) => kind === 'create').length, 1);
});

test('failure saving returned tab identity leaves a safe marker and local retry reuses the known tab', async () => {
    const f = fixture();
    f.hooks.sessionSet = values => { if (Object.values(values.favoriteDropAttempts || {}).some(record => record.tabId)) throw new Error('Receipt storage failed'); };
    await assert.rejects(f.add(f.source), /pinned tab was opened/);
    await assert.rejects(f.make()(f.source), /earlier Favorites attempt/);
    delete f.hooks.sessionSet;
    await f.add(f.source);
    assert.equal(f.effects.filter(([kind]) => kind === 'create').length, 1);
});

test('partial position failure is reported without deleting or duplicating the pinned tab', async () => {
    const f = fixture(); f.hooks.move = () => { throw new Error('Move failed'); };
    const result = await f.add(f.source);
    assert.match(result.warning, /position could not be updated.*Move failed/);
    assert.equal(f.tabs[0].pinned, true);
    delete f.hooks.move; await f.add(f.source);
    assert.equal(f.effects.filter(([kind]) => kind === 'create').length, 1);
});

test('tab closure or foreign-window movement during binding is not reported as a successful pin', async () => {
    for (const change of ['close', 'move', 'unpin']) {
        const f = fixture(); f.hooks.bindingSet = () => {
            if (change === 'close') f.tabs.splice(0);
            if (change === 'move') f.tabs[0].windowId = 99;
            if (change === 'unpin') f.tabs[0].pinned = false;
        };
        await assert.rejects(f.add(f.source), /pinned tab was opened/);
        assert.equal(f.effects.filter(([kind]) => kind === 'move').length, 0);
    }
});

test('bookmark mutation after create preserves the tab and saved tree but reports partial failure', async () => {
    const f = fixture(); f.hooks.created = () => { f.bookmark.parentId = 'moved'; };
    await assert.rejects(f.add(f.source), /pinned tab was opened.*bookmark.*changed/);
    assert.equal(f.tabs.length, 1); assert.equal(f.bookmark.parentId, 'moved');
    assert.equal(f.effects.filter(([kind]) => kind === 'move').length, 0);
});

test('provenance accepts one unchanged own-sidebar row, never transfer payload or forged dragging class', () => {
    const { document } = parseHTML('<body><div id="pinnedFavicons"></div><div id="spacesList"><div class="space" data-space-id="s"><div class="tab bookmark-only dragging" data-bookmark-id="saved"></div><div class="folder" data-bookmark-id="folder"></div></div></div></body>');
    const context = { spaces: [{ id: 's', bookmarkFolderId: 'p' }], activeSpaceId: 's', windowId: 10 };
    const drag = createFavoritesDragSource({ document, getContext: () => context });
    assert.match(drag.inspect().error, /from this sidebar/);
    const row = document.querySelector('.tab'); drag.start(row);
    assert.equal(drag.inspect().source.bookmarkId, 'saved'); assert.match(drag.inspect().hint, /Opens a pinned tab/);
    row.dataset.bookmarkId = 'forged'; assert.match(drag.inspect().error, /changed/);
    row.dataset.bookmarkId = 'saved'; row.remove(); assert.match(drag.take().error, /changed/);
    assert.match(drag.inspect().error, /from this sidebar/);
    const folder = document.querySelector('.folder'); folder.classList.add('dragging'); drag.start(folder);
    assert.match(drag.inspect().error, /one bookmark at a time/);
});

test('completed receipt recovers a lost binding across sidebar documents without URL guessing', async () => {
    const f = fixture(); await f.add(f.source);
    delete f.bindings[100];
    await f.make()(f.source);
    assert.equal(f.effects.filter(([kind]) => kind === 'create').length, 1);
    assert.equal(f.bindings[100].bookmarkId, 'saved');
});

test('known closed receipt permits a fresh tab; missing-tab lookup alone does not prove closure', async () => {
    const f = fixture(); await f.add(f.source); f.tabs.splice(0); delete f.bindings[100];
    await f.make()(f.source);
    assert.equal(f.effects.filter(([kind]) => kind === 'create').length, 2);
    delete f.bindings[101]; f.hooks.get = () => { throw new Error('Lookup failed'); };
    await assert.rejects(f.make()(f.source));
    assert.equal(f.effects.filter(([kind]) => kind === 'create').length, 2);
});

test('retained receipt fails closed after move, unpin, or conflicting binding and never overwrites new identity', async () => {
    for (const change of ['move', 'unpin', 'binding']) {
        const f = fixture(); await f.add(f.source); delete f.bindings[100];
        if (change === 'move') f.tabs[0].windowId = 99;
        if (change === 'unpin') f.tabs[0].pinned = false;
        if (change === 'binding') f.bindings[100] = { bookmarkId: 'other', pinnedUrl: 'https://other.test/' };
        await assert.rejects(f.make()(f.source), /previous Favorite tab was moved, unpinned, or linked/);
        assert.equal(f.effects.filter(([kind]) => kind === 'create').length, 1);
        if (change === 'binding') assert.equal(f.bindings[100].bookmarkId, 'other');
    }
});

test('identity changes while receipt binding is saved cannot overwrite a different bookmark', async () => {
    const f = fixture(); await f.add(f.source); delete f.bindings[100];
    let reads = 0;
    f.hooks.bindingsGet = () => { if (++reads === 3) f.bindings[100] = { bookmarkId: 'other', pinnedUrl: 'https://other.test/' }; };
    await assert.rejects(f.make()(f.source), /different bookmark/);
    assert.equal(f.bindings[100].bookmarkId, 'other');
    assert.equal(f.effects.filter(([kind]) => kind === 'create').length, 1);
});

test('independent pinned-state writers use the origin lock and preserve both bindings', async () => {
    const f = fixture();
    const one = { ...Utils, _pinnedStateChain: Promise.resolve() }, two = { ...Utils, _pinnedStateChain: Promise.resolve() };
    f.hooks.bindingSet = async () => { await new Promise(resolve => setTimeout(resolve, 2)); };
    await Promise.all([one.setPinnedTabState(1, { bookmarkId: 'first' }), two.setPinnedTabState(2, { bookmarkId: 'second' })]);
    assert.equal(f.bindings[1].bookmarkId, 'first'); assert.equal(f.bindings[2].bookmarkId, 'second');
});

test('startup cleanup checks native pin freshly inside the binding lock and closed-tab cleanup still removes it', async () => {
    const f = fixture(); addLive(f, { pinned: true });
    await Utils.removePinnedTabState(1, { preserveNativePinned: true });
    assert.equal(f.bindings[1].bookmarkId, 'saved');
    f.tabs.splice(0);
    await Utils.removePinnedTabState(1, { preserveNativePinned: true });
    assert.equal(f.bindings[1], undefined);
});

test('live source cannot make a second native Favorite for the same exact saved identity', async () => {
    const f = fixture(); addLive(f, { id: 1, pinned: true, owned: false }); addLive(f, { id: 2 });
    await assert.rejects(f.add({ ...f.source, tabId: 2 }), /already has a Favorite/);
    assert.equal(f.tabs[1].pinned, false); assert.deepEqual(f.effects, []);
    assert.deepEqual(f.spaces[0].spaceBookmarks, [2]);
});

test('multiple exact native candidates fail closed rather than selecting the first', async () => {
    const f = fixture(); addLive(f, { id: 1, pinned: true, owned: false }); addLive(f, { id: 2, pinned: true, owned: false });
    await assert.rejects(f.add(f.source), /multiple Favorites/); assert.deepEqual(f.effects, []);
});

test('failed creation receipt for URL A cannot be relinked to newly saved URL B', async () => {
    const f = fixture();
    f.hooks.created = () => { f.bookmark.url = 'https://changed.test/'; };
    await assert.rejects(f.add(f.source), /pinned tab was opened/);
    delete f.hooks.created;
    await assert.rejects(f.make()(f.source), /saved URL changed/);
    assert.equal(f.bindings[100], undefined);
    assert.equal(f.tabs[0].url, 'https://saved.test/');
    assert.equal(f.effects.filter(([kind]) => kind === 'create').length, 1);
    assert.equal(f.effects.filter(([kind]) => kind === 'update' || kind === 'move').length, 0);
});

test('reuse validates bookmark and live ownership again after receipt persistence', async () => {
    for (const change of ['bookmark', 'membership']) {
        const f = fixture(); addLive(f);
        f.hooks.sessionSet = () => {
            if (change === 'bookmark') f.tree.f = [];
            else { f.spaces[0].spaceBookmarks = []; f.spaces.push({ id: 'other', temporaryTabs: [1], spaceBookmarks: [] }); }
        };
        await assert.rejects(f.add(f.source), /changed/);
        assert.deepEqual(f.effects, [], change);
    }
});
