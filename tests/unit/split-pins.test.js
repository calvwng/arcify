import test from 'node:test';
import assert from 'node:assert/strict';
import { runSplitPinAction, validSplitPinState, SPLIT_PINS_KEY, SPLIT_PIN_SESSION_KEY } from '../../split-pins.js';
import { SAVED_SPLITS_KEY } from '../../saved-splits.js';
import { splitPinUrl } from '../../split-pin-identity.js';
import { Utils } from '../../utils.js';
function fixture() {
    const effects = [], hooks = {}, data = {}, listeners = [];
    const tabs = [1, 2].map((id, index) => ({ id, windowId: 10, url: `https://page.test/${id}`, title: `Page ${id}`, index, groupId: -1, pinned: false, splitViewId: 70, incognito: false }));
    const copy = x => structuredClone(x);
    const store = { spaces: [{ id: 's', bookmarkFolderId: 'root', temporaryTabs: [1, 2], spaceBookmarks: [] }], active: { 10: 's' },
        run: fn => fn(), isGlobalTab: id => hooks.global === id,
        insertCreatedToday(space, tab) { space.temporaryTabs.push(tab.id); }, rebaseSectionRanks() {},
        async persist(options = {}) { effects.push('persist'); await hooks.persist?.(); await options.beforeWrite?.(); effects.push('persistCommitted'); } };
    globalThis.chrome = {
        runtime: { id: 'test', getURL: p => `chrome-extension://test/${p}`, onMessage: { addListener: fn => listeners.push(fn) } },
        windows: { async get(id) { return { id, type: 'normal', incognito: false, ...hooks.window }; } },
        storage: { local: {
            async get(key) { effects.push(['read', key]); return { [key]: key === 'pinnedTabStatesById' ? hooks.bindings || {} : copy(data[key]) }; },
            async set(values) { effects.push('save'); Object.assign(data, copy(values)); await hooks.localSet?.(values); }
        } },
        tabs: {
            async query({ windowId } = {}) { await hooks.query?.(); return copy(tabs.filter(t => windowId === undefined || t.windowId === windowId)); },
            async get(id) { await hooks.get?.(id); return copy(tabs.find(t => t.id === id)); },
            async create(options) { effects.push(['create', options]); await hooks.create?.(); const tab = { ...copy(tabs[0]), id: Math.max(...tabs.map(t => t.id)) + 1, index: tabs.length, url: options.url, splitViewId: -1 }; tabs.push(tab); return copy(tab); },
            async update(id, update) { effects.push(['update', id, update]); await hooks.update?.(); Object.assign(tabs.find(t => t.id === id), update); },
            async createSplit(ids) { effects.push(['split', ids]); for (const id of ids) tabs.find(t => t.id === id).splitViewId = 80; return 80; },
            async unsplit() {}, async move() { throw new Error('Unexpected move'); }
        }
    };
    const nodes = [{ id: 'arc', title: 'Arcify', parentId: '0' }, { id: 'root', title: 'Personal', parentId: 'arc' }];
    let next = 100;
    chrome.bookmarks = {
        async get(id) { return nodes.filter(n => [].concat(id).includes(n.id)).map(copy); },
        async getChildren(id) { return nodes.filter(n => n.parentId === id).map(copy); },
        async search(q) { return nodes.filter(n => Object.entries(q).every(([k,v]) => n[k] === v)).map(copy); },
        async create(input) { effects.push(['bookmark', input]); const item = { id: String(next++), ...input }; const siblings = nodes.filter(n => n.parentId === input.parentId); const before = siblings[input.index]; nodes.splice(before ? nodes.indexOf(before) : nodes.length, 0, item); await hooks.bookmarkCreate?.(); return copy(item); }
    };
    const events = () => ({ callbacks: [], addListener(fn) { this.callbacks.push(fn); }, removeListener(fn) { this.callbacks = this.callbacks.filter(f => f !== fn); } });
    for (const key of ['onMoved', 'onRemoved', 'onChanged']) chrome.bookmarks[key] = events();
    chrome.bookmarks.remove = async id => { await hooks.beforeRemove?.(); const at = nodes.findIndex(n => n.id === id); if (at < 0) throw new Error('Missing bookmark'); nodes.splice(at, 1); effects.push(['bookmarkRemove', id]); await hooks.afterRemove?.(); };
    const session = {};
    chrome.storage.session = { async get(key) { return { [key]: copy(session[key]) }; }, async set(value) { Object.assign(session, copy(value)); } };
    chrome.tabs.remove = async ids => { effects.push(['remove', ids]); for (const id of [].concat(ids)) { const i = tabs.findIndex(t => t.id === id); if (i >= 0) tabs.splice(i, 1); } };
    Utils._pinnedStateChain = Promise.resolve();
    const request = { type: 'savedSplitAction', action: 'save', windowId: 10, spaceId: 's', bookmarkFolderId: 'root', entries: tabs.map(t => ({ tabId: t.id, url: t.url, index: t.index, groupId: t.groupId, pinned: t.pinned, splitViewId: t.splitViewId })) };
    return { nodes, session, tabs, effects, hooks, data, store, request, listeners, run: extra => runSplitPinAction(store, { ...request, type: 'splitPinAction', action: 'pin', ...extra }) };
}

test('pin creates one normal bookmark; repeat activation focuses exact existing split without new pages', async () => {
    const f = fixture(); const result = await f.run();
    const bookmark = f.nodes.find(n => n.id === result.bookmarkId);
    assert.equal(bookmark.parentId, 'root'); assert.equal(bookmark.title, 'Page 1 + Page 2');
    assert.ok(validSplitPinState(f.data[SPLIT_PINS_KEY]));
    assert.equal(f.data[SAVED_SPLITS_KEY].length, 1);
    const opened = await f.run({ action: 'activate', bookmarkId: bookmark.id });
    assert.equal(opened.reused, true); assert.deepEqual(opened.tabIds, [1, 2]);
    assert.ok(!f.effects.some(e => e[0] === 'create'));
    const view = await f.run({ action: 'list' }); assert.deepEqual(view.pins[0].tabIds, [1, 2]);
});
test('close removes only witnessed pair; pin and recipe remain; reopen uses fresh IDs', async () => {
    const f = fixture(); const { bookmarkId } = await f.run();
    // Keep an unrelated tab so this fixture can synthesize new native tabs.
    f.tabs.push({ ...f.tabs[0], id: 20, splitViewId: -1 });
    await f.run({ action: 'close', bookmarkId });
    assert.deepEqual(f.tabs.map(t => t.id), [20]); assert.ok(f.nodes.some(n => n.id === bookmarkId));
    const result = await f.run({ action: 'activate', bookmarkId });
    assert.deepEqual(result.tabIds, [21, 22]); assert.equal(f.data[SAVED_SPLITS_KEY].length, 1);
});
for (const change of ['partner-closed', 'split-changed', 'third-member', 'space-changed', 'pin-bound']) {
    test(`invalid ${change} witness is not presented or closed`, async () => {
        const f = fixture(); const { bookmarkId } = await f.run();
        if (change === 'partner-closed') f.tabs.pop();
        if (change === 'split-changed') f.tabs[1].splitViewId = 99;
        if (change === 'third-member') f.tabs.push({ ...f.tabs[0], id: 3 });
        if (change === 'space-changed') f.store.spaces[0].temporaryTabs = [1];
        if (change === 'pin-bound') f.hooks.bindings = { 1: { bookmarkId: 'different' } };
        assert.deepEqual((await f.run({ action: 'list' })).pins[0].tabIds, []);
        await assert.rejects(f.run({ action: 'close', bookmarkId }));
        assert.ok(!f.effects.some(e => e[0] === 'remove'));
    });
}
test('rename and nested-folder move use bookmark identity rather than stale recipe title', async () => {
    const f = fixture(); const { bookmarkId } = await f.run();
    f.nodes.push({ id: 'nested', title: 'Areas', parentId: 'root' });
    Object.assign(f.nodes.find(n => n.id === bookmarkId), { title: 'Planning', parentId: 'nested' });
    const { pins } = await f.run({ action: 'list' }); assert.equal(pins[0].name, 'Planning');
    assert.equal((await f.run({ action: 'activate', bookmarkId })).reused, true);
});
test('migration retains originals, does not navigate, and never resurrects an unpinned bookmark', async () => {
    const f = fixture();
    const recipe = { id: 'legacy', name: 'Legacy', pages: f.tabs.map(t => ({ title: t.title, url: t.url })) };
    f.data[SAVED_SPLITS_KEY] = [recipe];
    await f.run({ action: 'migrate' }); const bookmarkId = f.data[SPLIT_PINS_KEY].pins[0].bookmarkId;
    await f.run({ action: 'migrate' }); assert.equal(f.effects.filter(e => e[0] === 'bookmark').length, 1);
    f.nodes.splice(f.nodes.findIndex(n => n.id === bookmarkId), 1);
    await f.run({ action: 'migrate' }); assert.equal(f.effects.filter(e => e[0] === 'bookmark').length, 1);
    assert.deepEqual(f.data[SAVED_SPLITS_KEY], []); assert.deepEqual(f.data.savedSplitRecipesBeforePinsV1, [recipe]); assert.ok(!f.effects.some(e => ['create', 'update', 'remove'].includes(e[0])));
});
test('uncertain bookmark creation never adopts an unreceipted marker or retries', async () => {
    const f = fixture(); f.hooks.bookmarkCreate = () => { throw new Error('disconnected'); };
    await assert.rejects(f.run(), /not fully confirmed/);
    assert.equal(f.data[SPLIT_PINS_KEY].pins[0].phase, 'pending');
    delete f.hooks.bookmarkCreate;
    assert.match((await f.run({ action: 'migrate' })).errors[0].message, /unconfirmed/); assert.equal(f.effects.filter(e => e[0] === 'bookmark').length, 1);
    assert.equal(f.data[SPLIT_PINS_KEY].pins[0].phase, 'pending');
});
test('copied marker has no authoritative local pin identity', async () => {
    const f = fixture(); const { bookmarkId } = await f.run();
    f.nodes.push({ ...f.nodes.find(n => n.id === bookmarkId), id: 'copy' });
    await assert.rejects(f.run({ action: 'activate', bookmarkId: 'copy' }));
    assert.ok(!f.effects.some(e => e[0] === 'create'));
});
test('private window refuses storage reads and bookmark changes', async () => {
    const f = fixture(); f.hooks.window = { incognito: true };
    await assert.rejects(f.run()); assert.deepEqual(f.effects, []);
});
test('corrupt migration metadata fails closed without overwriting data', async () => {
    const f = fixture(); f.data[SPLIT_PINS_KEY] = { version: 9000 };
    await assert.rejects(f.run({ action: 'migrate' }), /invalid/); assert.deepEqual(f.data[SPLIT_PINS_KEY], { version: 9000 });
});

test('repeated pin of exact live pair reuses one record, not duplicate bookmarks', async () => {
    const f = fixture(); const first = await f.run(); const second = await f.run();
    assert.equal(second.bookmarkId, first.bookmarkId); assert.equal(second.reused, true);
    assert.equal(f.data[SAVED_SPLITS_KEY].length, 1); assert.equal(f.effects.filter(e => e[0] === 'bookmark').length, 1);
});
test('more than 100 intentional pin/unpin cycles reclaim quota without closing pages', async () => {
    const f = fixture();
    for (let i = 0; i < 105; i++) {
        const { bookmarkId } = await f.run();
        f.nodes.splice(f.nodes.findIndex(n => n.id === bookmarkId), 1);
    }
    const result = await f.run(); assert.ok(result.bookmarkId);
    assert.equal(f.data[SAVED_SPLITS_KEY].length, 1); assert.equal(f.data[SPLIT_PINS_KEY].pins.length, 1);
    assert.deepEqual(f.tabs.map(t => t.id), [1,2]);
});
test('pre-existing copied marker cannot be claimed during migration', async () => {
    const f = fixture(); f.data[SAVED_SPLITS_KEY] = [{ id: 'legacy', name: 'Legacy', pages: f.tabs.map(t => ({ title: t.title, url: t.url })) }];
    f.nodes.push({ id: 'copied', parentId: 'root', url: splitPinUrl('legacy') });
    const result = await f.run({ action: 'migrate' }); assert.match(result.errors[0].message, /no trusted creation receipt/);
    assert.ok(!f.data[SPLIT_PINS_KEY]); assert.equal(result.migrated, 0);
});
test('external cross-Space marker move reveals source pages and cannot claim them at destination', async () => {
    const f = fixture(); const { bookmarkId } = await f.run();
    f.nodes.push({ id: 'root-b', parentId: 'arc', title: 'Other' });
    f.store.spaces.push({ id: 'b', bookmarkFolderId: 'root-b', temporaryTabs: [], spaceBookmarks: [] });
    f.nodes.find(n => n.id === bookmarkId).parentId = 'root-b';
    assert.deepEqual((await f.run({ action: 'list' })).pins, []);
    f.store.active[10] = 'b';
    const request = { action: 'list', spaceId: 'b', bookmarkFolderId: 'root-b' };
    assert.deepEqual((await f.run(request)).pins[0].tabIds, []);
    const original = structuredClone(f.tabs);
    const result = await f.run({ ...request, action: 'activate', bookmarkId });
    assert.deepEqual(result.tabIds, [3,4]); assert.deepEqual(f.tabs.slice(0,2), original);
    assert.deepEqual(f.store.spaces[0].temporaryTabs, [1,2]);
});

test('known pre-write bookmark conflict removes only the failed new recipe and permits clean retry', async () => {
    const f = fixture(); const get = chrome.bookmarks.getChildren; let reads = 0;
    chrome.bookmarks.getChildren = async id => {
        if (id === 'root' && ++reads === 2) f.nodes.push({ id: 'external', parentId: 'root', title: 'External', url: 'https://other.test' });
        return get(id);
    };
    await assert.rejects(f.run(), /Bookmark order changed/);
    assert.deepEqual(f.data[SAVED_SPLITS_KEY], []); assert.deepEqual(f.data[SPLIT_PINS_KEY].pins, []);
    const result = await f.run(); assert.ok(result.bookmarkId); assert.equal(f.data[SAVED_SPLITS_KEY].length, 1);
});

async function interruptedFixture() {
    const f = fixture(); f.hooks.bookmarkCreate = () => { throw new Error('Reply lost after native create'); };
    await assert.rejects(f.run()); f.hooks.bookmarkCreate = null;
    assert.equal(f.data[SPLIT_PINS_KEY].pins[0].phase, 'pending');
    return f;
}
test('interrupted creation lists candidates but adopts none without explicit exact selection', async () => {
    const f = await interruptedFixture();
    const item = (await f.run({ action: 'recoveryList' })).items[0];
    assert.equal(item.candidates.length, 1); assert.equal(f.data[SPLIT_PINS_KEY].pins[0].phase, 'pending');
    const before = structuredClone(f.nodes); const tabs = structuredClone(f.tabs);
    await f.run({ action: 'recover', recipe: item.recipe, candidate: item.candidates[0] });
    assert.equal(f.data[SPLIT_PINS_KEY].pins[0].phase, 'committed');
    assert.deepEqual(f.nodes, before); assert.deepEqual(f.tabs, tabs); assert.deepEqual(f.session, {});
    assert.equal((await f.run({ action: 'recoveryList' })).items.length, 0);
});
for (const mutation of ['rename', 'move', 'url', 'recipe', 'space', 'witness', 'parent-name', 'space-name']) test(`recovery refuses changed ${mutation} without adopting or mutating pages`, async () => {
    const f = await interruptedFixture(); const item = (await f.run({ action: 'recoveryList' })).items[0];
    const node = f.nodes.find(n => n.id === item.candidates[0].bookmarkId);
    if (mutation === 'rename') node.title += '!';
    if (mutation === 'parent-name') f.nodes.find(n => n.id === node.parentId).title += '!';
    if (mutation === 'space-name') f.store.spaces[0].name = 'Renamed';
    if (mutation === 'move') node.parentId = 'elsewhere';
    if (mutation === 'url') node.url = 'https://unrelated.test';
    if (mutation === 'recipe') f.data[SAVED_SPLITS_KEY][0].name += '!';
    if (mutation === 'space') f.store.active[10] = 'different';
    if (mutation === 'witness') f.session[SPLIT_PIN_SESSION_KEY] = { old: { bookmarkId: node.id } };
    const tabs = structuredClone(f.tabs);
    await assert.rejects(f.run({ action: 'recover', recipe: item.recipe, candidate: item.candidates[0] }));
    assert.equal(f.data[SPLIT_PINS_KEY].pins[0].phase, 'pending'); assert.deepEqual(f.tabs, tabs);
});
test('multiple copied markers require exact chosen identity and leave extras untouched', async () => {
    const f = await interruptedFixture(); const node = f.nodes.find(n => n.url?.includes('saved-split.html'));
    f.nodes.push({ ...node, id: 'copy' });
    const item = (await f.run({ action: 'recoveryList' })).items[0]; assert.equal(item.candidates.length, 2);
    await f.run({ action: 'recover', recipe: item.recipe, candidate: item.candidates.find(c => c.bookmarkId === 'copy') });
    assert.equal(f.data[SPLIT_PINS_KEY].pins[0].bookmarkId, 'copy'); assert.ok(f.nodes.some(n => n.id === node.id));
});
test('zero-candidate defer retains recipe, permits other pins, survives migration and allows later explicit recovery', async () => {
    const f = await interruptedFixture(); const index = f.nodes.findIndex(n => n.url?.includes('saved-split.html'));
    const late = f.nodes.splice(index, 1)[0];
    const item = (await f.run({ action: 'recoveryList' })).items[0]; assert.deepEqual(item.candidates, []);
    const original = structuredClone(item.recipe);
    await f.run({ action: 'defer', recipe: item.recipe });
    assert.ok(validSplitPinState(f.data[SPLIT_PINS_KEY])); assert.equal(f.data[SPLIT_PINS_KEY].pins[0].phase, 'deferred');
    await f.run({ action: 'migrate' }); assert.equal(f.nodes.filter(n => n.url?.includes('saved-split.html')).length, 0);
    await f.run(); assert.equal(f.data[SAVED_SPLITS_KEY].length, 2); assert.deepEqual(f.data[SAVED_SPLITS_KEY][0], original);
    f.nodes.push(late);
    const again = (await f.run({ action: 'recoveryList' })).items[0];
    await f.run({ action: 'recover', recipe: again.recipe, candidate: again.candidates[0] });
    assert.equal(f.data[SPLIT_PINS_KEY].pins[0].bookmarkId, late.id);
});

test('lost recovery write response preserves committed receipt and backup; stale second dialog cannot retry it', async () => {
    const f = await interruptedFixture(); const item = (await f.run({ action: 'recoveryList' })).items[0];
    f.hooks.localSet = value => { if (value[SPLIT_PINS_KEY]?.pins[0].phase === 'committed') throw new Error('Response lost'); };
    await assert.rejects(f.run({ action: 'recover', recipe: item.recipe, candidate: item.candidates[0] }));
    assert.equal(f.data[SPLIT_PINS_KEY].pins[0].phase, 'committed');
    assert.equal(f.data.splitPinRecoveryBeforeV1.pins.pins[0].phase, 'pending');
    assert.deepEqual(f.data.splitPinRecoveryBeforeV1.recipes, [item.recipe]);
    f.hooks.localSet = null; const state = structuredClone(f.data);
    await assert.rejects(f.run({ action: 'recover', recipe: item.recipe, candidate: item.candidates[0] }));
    await assert.rejects(f.run({ action: 'defer', recipe: item.recipe }));
    assert.deepEqual(f.data, state);
});

const releaseRequest = (f, bookmarkId, beforeId = null) => ({ action: 'release', bookmarkId,
    bookmark: Object.fromEntries(['parentId','url','title'].map(k => [k, f.nodes.find(n => n.id === bookmarkId)[k]])),
    today: { expectedCanonicalIds: [...f.store.spaces[0].temporaryTabs], beforeId } });
test('drag pin creates one marker at exact nested insertion without changing either live page', async () => {
    const f = fixture(); f.nodes.push({ id: 'folder', parentId: 'root', title: 'Areas' }, { id: 'a', parentId: 'folder', title: 'A', url: 'https://a.test/' });
    const before = structuredClone(f.tabs);
    const result = await f.run({ destination: { parentId: 'folder', expectedCanonicalIds: ['a'], beforeId: 'a' } });
    assert.deepEqual((await chrome.bookmarks.getChildren('folder')).map(n => n.id), [result.bookmarkId, 'a']);
    assert.deepEqual(f.tabs, before); assert.deepEqual(f.store.spaces[0].temporaryTabs, [1,2]);
    assert.equal((await f.run({ action:'list' })).pins[0].entries.length, 2);
});
for (const staleCase of ['order', 'pair']) test(`drag pin rejects stale ${staleCase} before creation`, async () => {
    const f = fixture();
    const destination = { parentId:'root', expectedCanonicalIds: staleCase === 'order' ? ['missing'] : [], beforeId:null };
    if (staleCase === 'pair') f.tabs[1].splitViewId = 77;
    await assert.rejects(f.run({ destination }));
    assert.equal(f.effects.filter(e => e[0] === 'bookmark').length, 0); assert.equal(f.data[SAVED_SPLITS_KEY]?.length || 0, 0);
});
test('release unpins complete live pair and moves its Today block without native mutations', async () => {
    const f = fixture(); const { bookmarkId } = await f.run();
    f.tabs.push({ ...f.tabs[0], id:3, index:2, splitViewId:-1 }); f.store.spaces[0].temporaryTabs.push(3);
    const before = structuredClone(f.tabs);
    await f.run(releaseRequest(f, bookmarkId));
    assert.deepEqual(f.store.spaces[0].temporaryTabs, [3,1,2]); assert.deepEqual(f.tabs, before);
    assert(!f.nodes.some(n => n.id === bookmarkId)); assert.deepEqual(f.data[SAVED_SPLITS_KEY], []); assert.deepEqual(f.data[SPLIT_PINS_KEY].pins, []);
    assert.deepEqual(f.session[SPLIT_PIN_SESSION_KEY], {});
    assert.equal(f.effects.filter(e => Array.isArray(e) && ['remove','update','create','split'].includes(e[0])).length, 0);
});
for (const reason of ['other-window', 'closed', 'stale-order', 'bookmark-changed', 'interleaved']) test(`release rejects ${reason} without removing saved pin`, async () => {
    const f = fixture(); const { bookmarkId } = await f.run(); const req = releaseRequest(f, bookmarkId);
    if (reason === 'other-window') { f.tabs.push({ ...f.tabs[0], id:9, windowId:20 }); f.session[SPLIT_PIN_SESSION_KEY][`20:${bookmarkId}`] = { bookmarkId, windowId:20, tabIds:[9,10] }; }
    if (reason === 'closed') f.tabs.pop();
    if (reason === 'stale-order') req.today.expectedCanonicalIds = [2,1];
    if (reason === 'bookmark-changed') req.bookmark.title = 'stale';
    if (reason === 'interleaved') { f.tabs.push({ ...f.tabs[0], id:3, index:2, splitViewId:-1 }); f.store.spaces[0].temporaryTabs = [1,3,2]; req.today.expectedCanonicalIds = [1,3,2]; }
    await assert.rejects(f.run(req)); assert(f.nodes.some(n => n.id === bookmarkId));
});
test('release lost removal response preserves panes and never recreates marker', async () => {
    const f = fixture(); const { bookmarkId } = await f.run(); const req = releaseRequest(f, bookmarkId); const before = structuredClone(f.tabs);
    f.hooks.afterRemove = () => { throw new Error('lost response'); };
    await assert.rejects(f.run(req), /removal could not be confirmed/); assert.deepEqual(f.tabs, before);
    await assert.rejects(f.run(req)); assert.equal(f.effects.filter(e => e[0] === 'bookmark').length, 1);
});

test('pair change after drag creation intent prevents bookmark write and cleans only new recipe', async () => {
    const f = fixture(); f.hooks.localSet = values => { if (values[SPLIT_PINS_KEY]?.pins.some(p => p.phase === 'pending')) f.tabs[1].splitViewId = 77; };
    await assert.rejects(f.run({ destination: { parentId:'root', expectedCanonicalIds:[], beforeId:null } }));
    assert.equal(f.effects.filter(e => e[0] === 'bookmark').length, 0); assert.deepEqual(f.data[SAVED_SPLITS_KEY], []);
});
test('release pair changes during order persistence retains exact pin and never deletes pages', async () => {
    const f = fixture(); const { bookmarkId } = await f.run();
    f.tabs.push({ ...f.tabs[0], id:3, index:2, splitViewId:-1 }); f.store.spaces[0].temporaryTabs.push(3);
    f.hooks.persist = () => { f.tabs[1].splitViewId = 77; };
    await assert.rejects(f.run(releaseRequest(f, bookmarkId)), /placement could not be confirmed/);
    assert(f.nodes.some(n => n.id === bookmarkId)); assert.equal(f.tabs.length,3);
    assert.equal(f.effects.filter(e => e[0] === 'bookmarkRemove').length,0);
});
test('stale duplicate drag pin never creates a second recipe or claims a new destination', async () => {
    const f = fixture(); await f.run();
    await assert.rejects(f.run({ destination:{ parentId:'root', expectedCanonicalIds:[], beforeId:null } }), /already pinned/);
    assert.equal(f.data[SAVED_SPLITS_KEY].length,1); assert.equal(f.effects.filter(e => e[0] === 'bookmark').length,1);
});

test('list suppresses release for another-window surviving instance while retaining exact live entries', async () => {
    const f = fixture(); const { bookmarkId } = await f.run();
    let queries = 0; f.hooks.query = () => queries++;
    let result = await f.run({ action:'list' }); assert.equal(result.pins[0].releaseAllowed,true); assert.equal(queries,1);
    f.session[SPLIT_PIN_SESSION_KEY][`20:${bookmarkId}`] = { bookmarkId, windowId:20, tabIds:[9,10] };
    f.tabs.push({ ...f.tabs[0], id:9, windowId:20 }); queries=0;
    result = await f.run({ action:'list' }); assert.equal(result.pins[0].releaseAllowed,false); assert.equal(result.pins[0].entries.length,2); assert.equal(queries,2);
    f.tabs.pop(); queries=0; result = await f.run({ action:'list' }); assert.equal(result.pins[0].releaseAllowed,true); assert.equal(queries,2);
});

test('release rechecks a destination pair formed during persistence before committing or deleting', async () => {
    const f = fixture(); const { bookmarkId } = await f.run();
    f.tabs.push({ ...f.tabs[0], id:3, index:2, splitViewId:-1 }, { ...f.tabs[0], id:4, index:3, splitViewId:-1 });
    f.store.spaces[0].temporaryTabs = [1,2,3,4];
    f.hooks.persist = () => { for (const tab of f.tabs.filter(t => t.id >= 3)) tab.splitViewId = 90; };
    await assert.rejects(f.run(releaseRequest(f, bookmarkId,4)), /placement could not be confirmed/);
    assert(f.nodes.some(n => n.id === bookmarkId)); assert.equal(f.store.initialized,false);
    assert(!f.effects.includes('persistCommitted'));
    assert.equal(f.effects.filter(e => e[0] === 'bookmarkRemove').length,0);
    assert.deepEqual(f.tabs.map(t => t.id), [1,2,3,4]);
});
