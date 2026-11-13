import { rememberGeneralUndo, takeGeneralUndo } from '../../general-undo-state.js';
import { SpaceStore } from '../../space-store.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { runSavedSplitAction, validSavedSplit, registerSavedSplitMessages, SAVED_SPLITS_KEY } from '../../saved-splits.js';
import { Utils } from '../../utils.js';
function fixture() {
    const effects = [], hooks = {}, data = {}, listeners = [];
    const tabs = [1, 2].map((id, index) => ({ id, windowId: 10, url: `https://page.test/${id}`, title: `Page ${id}`, index, groupId: -1, pinned: false, splitViewId: 70, incognito: false }));
    const copy = x => structuredClone(x);
    const store = { spaces: [{ id: 's', bookmarkFolderId: 'root', temporaryTabs: [1, 2], spaceBookmarks: [] }], active: { 10: 's' },
        run: fn => fn(), isGlobalTab: id => hooks.global === id,
        insertCreatedToday(space, tab) { space.temporaryTabs.push(tab.id); }, rebaseSectionRanks() {},
        async persist() { effects.push('persist'); await hooks.persist?.(); } };
    globalThis.chrome = {
        runtime: { id: 'test', getURL: p => `chrome-extension://test/${p}`, onMessage: { addListener: fn => listeners.push(fn) } },
        windows: { async get(id) { return { id, type: 'normal', incognito: false, ...hooks.window }; } },
        storage: { local: {
            async get(key) { effects.push(['read', key]); return { [key]: key === 'pinnedTabStatesById' ? hooks.bindings || {} : copy(data[key]) }; },
            async set(values) { effects.push('save'); Object.assign(data, copy(values)); }
        } },
        tabs: {
            async query({ windowId }) { await hooks.query?.(); return copy(tabs.filter(t => t.windowId === windowId)); },
            async get(id) { return copy(tabs.find(t => t.id === id)); },
            async create(options) { effects.push(['create', options]); await hooks.create?.(); const tab = { ...copy(tabs[0]), id: tabs.length + 1, index: tabs.length, url: options.url, splitViewId: -1 }; tabs.push(tab); return copy(tab); },
            async update(id, update) { effects.push(['update', id, update]); await hooks.update?.(); Object.assign(tabs.find(t => t.id === id), update); },
            async createSplit(ids) { effects.push(['split', ids]); for (const id of ids) tabs.find(t => t.id === id).splitViewId = 80; return 80; },
            async unsplit() {}, async move() { throw new Error('Unexpected move'); }
        }
    };
    Utils._pinnedStateChain = Promise.resolve();
    const request = { type: 'savedSplitAction', action: 'save', windowId: 10, spaceId: 's', bookmarkFolderId: 'root', entries: tabs.map(t => ({ tabId: t.id, url: t.url, index: t.index, groupId: t.groupId, pinned: t.pinned, splitViewId: t.splitViewId })) };
    return { tabs, effects, hooks, data, store, request, listeners, run: extra => runSavedSplitAction(store, { ...request, ...extra }) };
}
test('save uses native left/right order, stores only recipe data and never mutates live tabs', async () => {
    const f = fixture(); f.request.entries.reverse(); const before = structuredClone(f.tabs);
    const { recipe } = await f.run(); assert.ok(validSavedSplit(recipe)); assert.deepEqual(recipe.pages.map(p => p.url), ['https://page.test/1', 'https://page.test/2']);
    assert.deepEqual(Object.keys(recipe).sort(), ['id', 'name', 'pages']); assert.deepEqual(f.tabs, before);
    assert.equal(JSON.stringify(f.data).includes('splitViewId'), false); assert.equal(JSON.stringify(f.data).includes('tabId'), false);
});
for (const state of ['private', 'popup', 'inactive', 'wrong-root', 'duplicate-owner', 'pin', 'favorite', 'binding', 'unsplit', 'different-split', 'three-members', 'navigation', 'pending', 'unsupported-url', 'reordered', 'missing']) {
    test(`save rejects ${state} without writes`, async () => {
        const f = fixture();
        if (state === 'private') f.hooks.window = { incognito: true };
        if (state === 'popup') f.hooks.window = { type: 'popup' };
        if (state === 'inactive') f.store.active[10] = 'other';
        if (state === 'wrong-root') f.request.bookmarkFolderId = 'other';
        if (state === 'duplicate-owner') f.store.spaces.push({ id: 'other', temporaryTabs: [1] });
        if (state === 'pin') f.tabs[0].pinned = true;
        if (state === 'favorite') f.hooks.global = 1;
        if (state === 'binding') f.hooks.bindings = { 1: { bookmarkId: 'x' } };
        if (state === 'unsplit') f.tabs[0].splitViewId = -1;
        if (state === 'different-split') f.tabs[0].splitViewId = 71;
        if (state === 'three-members') f.tabs.push({ ...f.tabs[1], id: 3, index: 2 });
        if (state === 'navigation') f.tabs[0].url = 'https://other.test';
        if (state === 'pending') f.tabs[0].pendingUrl = 'https://other.test';
        if (state === 'unsupported-url') { f.tabs[0].url = 'file:///private'; f.request.entries[0].url = f.tabs[0].url; }
        if (state === 'reordered') f.tabs[0].index = 3;
        if (state === 'missing') f.tabs.pop();
        await assert.rejects(f.run()); assert.ok(!f.effects.includes('save')); if (state === 'private') assert.deepEqual(f.effects, []);
    });
}
test('open creates new IDs in current ownership, new native split and only then navigates; old pair untouched', async () => {
    const f = fixture(); const { recipe } = await f.run(); const before = structuredClone(f.tabs);
    const result = await f.run({ action: 'open', recipeId: recipe.id });
    assert.deepEqual(result.tabIds, [3, 4]); assert.deepEqual(f.tabs.slice(0, 2), before);
    assert.deepEqual(f.store.spaces[0].temporaryTabs, [1, 2, 3, 4]); assert.deepEqual(f.tabs.slice(2).map(t => t.url), recipe.pages.map(p => p.url));
    assert.ok(f.effects.findIndex(e => e[0] === 'split') < f.effects.findIndex(e => e[0] === 'update'));
    assert.equal(f.tabs[2].splitViewId, 80); assert.equal(f.tabs[2].active, true);
});
test('no reuse of equal URLs; removing recipe never changes live tabs', async () => {
    const f = fixture(); const { recipe } = await f.run(); await f.run({ action: 'open', recipeId: recipe.id });
    const before = structuredClone(f.tabs); await f.run({ action: 'remove', recipeId: recipe.id });
    assert.deepEqual(f.tabs, before); assert.deepEqual(f.data[SAVED_SPLITS_KEY], []);
});
test('ownership change during create leaves new tabs open without navigation, split or retry', async () => {
    const f = fixture(); const { recipe } = await f.run(); f.hooks.create = () => { f.store.active[10] = 'other'; };
    await assert.rejects(f.run({ action: 'open', recipeId: recipe.id }), /left open/); assert.equal(f.tabs.length, 3);
    assert.ok(!f.effects.some(e => e[0] === 'update' || e[0] === 'split'));
});
test('private list/open/remove never read recipe storage', async () => {
    for (const action of ['list', 'open', 'remove']) {
        const f = fixture(); f.hooks.window = { incognito: true }; await assert.rejects(f.run({ action })); assert.deepEqual(f.effects, []);
    }
});
test('corrupt saved data is not overwritten or opened', async () => {
    const f = fixture(); f.data[SAVED_SPLITS_KEY] = [{ id: 'bad' }]; await assert.rejects(f.run(), /read safely/); assert.ok(!f.effects.includes('save'));
});
test('message sender is checked before private storage access', async () => {
    const f = fixture(); registerSavedSplitMessages(f.store); let response;
    for (const sender of [{ id: 'foreign' }, { id: 'test', url: 'https://evil.test' }, { id: 'test', url: 'chrome-extension://test/sidebar.html', incognito: true }]) {
        f.listeners[0](f.request, sender, r => response = r); assert.equal(response.success, false);
    }
    assert.deepEqual(f.effects, []);
});
for (const change of ['unsplit', 'duplicate-owner', 'saved-pin']) test(`new pair ${change} during navigation blocks remaining navigation`, async () => {
    const f = fixture(); const { recipe } = await f.run();
    f.hooks.update = () => {
        if (change === 'unsplit') f.tabs[3].splitViewId = -1;
        if (change === 'duplicate-owner') f.store.spaces.push({ id: 'other', temporaryTabs: [4] });
        if (change === 'saved-pin') f.hooks.bindings = { 4: { bookmarkId: 'p' } };
    };
    await assert.rejects(f.run({ action: 'open', recipeId: recipe.id }), /left open/);
    assert.equal(f.effects.filter(e => e[0] === 'update').length, 1); assert.equal(f.tabs[3].url, 'about:blank');
});
test('missing native capability blocks reopen before creating any tab', async () => {
    const f = fixture(); const { recipe } = await f.run(); delete chrome.tabs.createSplit;
    await assert.rejects(f.run({ action: 'open', recipeId: recipe.id }), /unavailable/); assert.equal(f.tabs.length, 2);
});
test('schema rejects extra native identity and executable recipes without saving', async () => {
    const recipe = { id: 'r', name: 'safe', pages: [{ title: 'a', url: 'https://a.test' }, { title: 'b', url: 'https://b.test' }] };
    assert.equal(validSavedSplit(recipe), true); assert.equal(validSavedSplit({ ...recipe, splitViewId: 90 }), false);
    assert.equal(validSavedSplit({ ...recipe, pages: [{ title: 'a', url: 'javascript:alert(1)' }, recipe.pages[1]] }), false);
});
test('new navigation during late peer read is not overwritten by recipe navigation', async () => {
    const f = fixture(); const { recipe } = await f.run();
    let afterNativeReads = 0;
    f.hooks.query = () => {
        if (f.tabs.length === 4 && f.tabs[2].splitViewId === 80 && ++afterNativeReads === 2) f.tabs[2].url = 'https://new-choice.test';
    };
    await assert.rejects(f.run({ action: 'open', recipeId: recipe.id }), /left open/);
    assert.equal(f.tabs[2].url, 'https://new-choice.test'); assert.equal(f.effects.filter(e => e[0] === 'update').length, 0);
});

// Cross-track contract: recipes are metadata, reopening changes live layout.
test('saving/removing split recipe metadata preserves a current Undo receipt', async () => {
    const f = fixture();
    const token = rememberGeneralUndo(f.store, { kind: 'spaces', windowId: 10, originalOrder: ['s'] });
    const { recipe } = await f.run();
    await f.run({ action: 'remove', recipeId: recipe.id });
    assert.equal(takeGeneralUndo(f.store, token, 10).token, token);
});
for (const failPersistence of [false, true]) {
    test(`saved split reopen invalidates Undo even if persistence fails=${failPersistence}`, async () => {
        const f = fixture(); const { recipe } = await f.run();
        // Use real SpaceStore persistence boundary; isolate unrelated storage machinery.
        f.store.persistCore = async () => { if (failPersistence) throw new Error('storage unavailable'); };
        f.store.persist = SpaceStore.prototype.persist;
        const token = rememberGeneralUndo(f.store, { kind: 'spaces', windowId: 10, originalOrder: ['s'] });
        if (failPersistence) await assert.rejects(f.run({ action: 'open', recipeId: recipe.id }), /left open/);
        else await f.run({ action: 'open', recipeId: recipe.id });
        // Even restoring the shape cannot resurrect the receipt after live creation.
        f.store.spaces[0].temporaryTabs = [1, 2];
        assert.throws(() => takeGeneralUndo(f.store, token, 10), /no longer available/);
    });
}
