import test from 'node:test';
import assert from 'node:assert/strict';
import { moveSavedItemsToSpace, registerSavedMoveMessages } from '../../saved-move-store.js';
import { SpaceStore } from '../../space-store.js';
import { SAVED_MOVE_JOURNAL_KEY as KEY } from '../../saved-move-lock.js';

const url = 'https://same.test/';
const space = (id, pins = [], today = []) => ({ id, name: id, color: 'blue', bookmarkFolderId: `${id}-root`, spaceBookmarks: pins, temporaryTabs: today });
function fixture({ inverted = false, syncGroups = false, folder = false } = {}) {
    const nodes = [
        { id: 'arcify', parentId: 'bar', title: 'Arcify' }, { id: 'source-root', parentId: 'arcify', title: 'source' }, { id: 'target-root', parentId: 'arcify', title: 'target' },
        { id: 'a', parentId: 'source-root', title: 'Pin A', url }, { id: 'folder', parentId: 'source-root', title: 'Folder' },
        { id: 'b', parentId: 'folder', title: 'Pin B', url }, { id: 'sub', parentId: 'folder', title: 'Nested' },
        { id: 'c', parentId: 'sub', title: 'Pin C', url }, { id: 'x', parentId: 'source-root', title: 'Closed pin', url },
        { id: 'z', parentId: 'target-root', title: 'Destination pin', url }
    ];
    const tabs = [1, 2, 3, 4, 8, 11, 12, 19].map((id, index) => ({ id, index, windowId: id > 10 ? 20 : 10,
        url: [1, 11].includes(id) ? 'https://navigated.test/' : url, active: id === 1 || id === 11,
        pinned: false, splitViewId: -1, groupId: -1, incognito: false }));
    const local = { spaces: [space('source', [1, 2, 3, 11, 12], [4]), space('target', [8])], spaceModelVersion: 2,
        pinnedTabStatesById: Object.fromEntries([[1, 'a'], [11, 'a'], [2, 'b'], [12, 'b'], [3, 'c'], [8, 'z'], [19, 'b']].map(([id, bookmarkId]) => [id, { bookmarkId, pinnedUrl: url }])),
        tabNameOverridesById: { 1: { name: 'Custom current tab', url: 'https://navigated.test/' } }, favorites: [{ id: 'fav', sourceBookmarkId: 'b', url, title: 'Favorite' }] };
    const session = { spaceSession: true, activeSpaces: { 10: 'source', 20: 'source' }, spaceRestoreQueue: [] }, sync = { invertTabOrder: inverted, syncTabGroups: syncGroups };
    const effects = [], hooks = {}, groups = [], listeners = [];
    const getChildren = parentId => nodes.filter(node => node.parentId === parentId);
    const subtree = id => { const node = nodes.find(node => node.id === id); return node ? { ...node, ...(node.url ? {} : { children: getChildren(id).map(child => subtree(child.id)) }) } : null; };
    const tree = id => { const node = subtree(id); return { id: node.id, parentId: node.parentId, title: node.title, url: node.url || null, children: (node.children || []).map(child => tree(child.id)) }; };
    const area = (name, data) => ({ async get(keys) {
        await hooks.get?.(name, keys);
        const names = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys || data);
        return Object.fromEntries(names.map(key => [key, structuredClone(data[key] ?? keys?.[key])]));
    }, async set(update) {
        await hooks.beforeSet?.(name, update); Object.assign(data, structuredClone(update)); effects.push([name, structuredClone(update)]); await hooks.afterSet?.(name, update);
    } });
    globalThis.chrome = {
        runtime: { id: 'test', getURL: path => `chrome-extension://test/${path}`, onMessage: { addListener: listener => listeners.push(listener) } },
        storage: { local: area('local', local), session: area('session', session), sync: area('sync', sync) },
        windows: { async get(id) { await hooks.window?.(id); return { id, type: 'normal', incognito: false }; }, update() { assert.fail('Never focus a window'); } },
        tabs: { async query(filter = {}) { await hooks.query?.(filter); return structuredClone(tabs.filter(tab => (filter.windowId === undefined || tab.windowId === filter.windowId) && (filter.groupId === undefined || tab.groupId === filter.groupId))); },
            create() { assert.fail('Never recreate tabs'); }, update() { assert.fail('Never navigate, activate, or pin'); }, remove() { assert.fail('Never close tabs'); },
            async group({ tabIds, groupId, createProperties }) { if (groupId === undefined) { groupId = groups.length + 100; groups.push({ id: groupId, windowId: createProperties.windowId, collapsed: false }); }
                assert(!groups.find(group => group.id === groupId).collapsed || !tabs.some(tab => tabIds.includes(tab.id) && tab.active));
                tabs.filter(tab => tabIds.includes(tab.id)).forEach(tab => tab.groupId = groupId); effects.push(['group', [...tabIds]]); return groupId; },
            async move(ids, options) { effects.push(['nativeMove', ids, options]); }, async ungroup() { assert.fail('No Favorite mutation'); } },
        tabGroups: { async query() { return structuredClone(groups); }, async update(id, attrs) { assert(!attrs.collapsed || !tabs.some(tab => tab.groupId === id && tab.active)); Object.assign(groups.find(group => group.id === id), attrs); }, async move() {} },
        bookmarks: { async get(id) { return structuredClone(nodes.filter(node => node.id === id)); }, async search() { return structuredClone(nodes.filter(node => node.title === 'Arcify')); },
            async getChildren(parentId) { await hooks.children?.(parentId); return structuredClone(getChildren(parentId)); }, async getSubTree(id) { await hooks.subtree?.(id); return subtree(id) ? [structuredClone(subtree(id))] : []; },
            async move(id, { parentId, index }) {
                await hooks.beforeMove?.(id); const node = nodes.find(node => node.id === id); assert(node); nodes.splice(nodes.indexOf(node), 1);
                const children = getChildren(parentId), at = index < children.length ? nodes.indexOf(children[index]) : children.length ? nodes.indexOf(children.at(-1)) + 1 : nodes.length;
                node.parentId = parentId; nodes.splice(at, 0, node); effects.push(['bookmarkMove', id, parentId, index]); await hooks.afterMove?.(id); return structuredClone(node);
            }, create() { assert.fail('Never create bookmarks'); }, remove() { assert.fail('Never delete bookmarks'); }, removeTree() { assert.fail('Never delete folders'); } }
    };
    const prepareStore = store => { store.favoriteStore = { async initialize() {}, async reconcile() {} }; store.isGlobalTab = tab => (typeof tab === 'object' ? tab.id : tab) === 19; store.discoverBookmarkSpaces = async () => false; return store; };
    const store = prepareStore(new SpaceStore()); store.initialized = true;
    Object.assign(store, { spaces: structuredClone(local.spaces), active: structuredClone(session.activeSpaces), liveTabs: new Map(tabs.map(tab => [tab.id, tab])), snapshotByTab: new Map(), provisional: new Set(), recoveryCandidates: new Set(), savedWindows: [], windowKeys: new Map(), restoreWindowKeys: new Map(), restoredMetadata: [], restoredRanks: new Map(), restoreQueue: [] });
    const entry = id => { const node = nodes.find(node => node.id === id); return { bookmarkId: id, parentId: node.parentId, title: node.title, url: node.url || null,
        tabId: id === 'a' ? 1 : null, ...(!node.url ? { tree: tree(id) } : {}) }; };
    const request = { type: 'moveSavedItemsToSpace', windowId: 10, spaceId: 'source', bookmarkFolderId: 'source-root', destinationSpaceId: 'target', destinationBookmarkFolderId: 'target-root', inverted,
        entries: (folder ? ['folder'] : inverted ? ['x', 'a'] : ['a', 'x']).map(entry) };
    const restart = async () => { const next = prepareStore(new SpaceStore()); await next.dispatch({ action: 'get' }); return next; };
    return { nodes, tabs, local, session, sync, effects, hooks, groups, listeners, store, request, entry, tree, restart, children: id => ids(getChildren(id)), move: () => moveSavedItemsToSpace(store, request) };
}
const ids = nodes => nodes.map(node => node.id);
const membership = (spaces, id) => spaces.filter(space => [...space.spaceBookmarks, ...space.temporaryTabs].includes(id)).map(space => space.id);
const moves = f => f.effects.filter(effect => effect[0] === 'bookmarkMove');

for (const inverted of [false, true]) for (const syncGroups of [false, true]) for (const folder of [false, true]) test(`exact saved move folder=${folder}, inverted=${inverted}, groups=${syncGroups}`, async () => {
    const f = fixture({ inverted, syncGroups, folder }), before = structuredClone({ tabs: f.tabs, bindings: f.local.pinnedTabStatesById, aliases: f.local.tabNameOverridesById, favorites: f.local.favorites }), originalTree = f.tree('folder');
    const result = await f.move();
    assert.deepEqual(result, { total: folder ? 1 : 2, completed: f.request.entries.map(entry => entry.bookmarkId), remaining: [], uncertain: false, destinationSpaceId: 'target' });
    assert.deepEqual(f.children('target-root'), folder ? inverted ? ['folder', 'z'] : ['z', 'folder'] : inverted ? ['a', 'x', 'z'] : ['z', 'a', 'x']);
    assert.deepEqual(f.tree('folder'), { ...originalTree, parentId: folder ? 'target-root' : 'source-root' });
    for (const id of folder ? [2, 12, 3] : [1, 11]) assert.deepEqual(membership(f.local.spaces, id), ['target']);
    assert.deepEqual(membership(f.local.spaces, 4), ['source']); assert.deepEqual(membership(f.local.spaces, 19), []);
    assert.deepEqual(f.local.pinnedTabStatesById, before.bindings); assert.deepEqual(f.local.tabNameOverridesById, before.aliases); assert.deepEqual(f.local.favorites, before.favorites);
    assert.deepEqual(f.tabs.map(({ groupId, ...tab }) => tab), before.tabs.map(({ groupId, ...tab }) => tab));
    assert.deepEqual(f.session.activeSpaces, { 10: 'source', 20: 'source' }); assert.equal(f.local[KEY], null);
    const saved = f.effects.filter(([area, update]) => area === 'local' && update[KEY]);
    assert.equal(saved.length, 2); assert.equal(saved[0][1][KEY].phase, 'prepared'); assert.equal(saved[1][1][KEY].phase, 'committed');
    assert(saved.every(([, update]) => update.spaces && update.spaceTabSnapshot));
    const next = await f.restart(); for (const id of folder ? [2, 12, 3] : [1, 11]) assert.deepEqual(membership(next.spaces, id), ['target']);
});

const invalidations = {
    staleTitle: f => f.request.entries[0].title = 'Stale', staleUrl: f => f.request.entries[0].url = 'https://wrong.test/', staleParent: f => f.request.entries[0].parentId = 'folder',
    otherWindowSource: f => f.request.entries[0].tabId = 11, missingPin: f => f.nodes.splice(f.nodes.findIndex(node => node.id === 'x'), 1),
    missingDestination: f => f.nodes.splice(f.nodes.findIndex(node => node.id === 'target-root'), 1), sourceMoved: f => f.nodes.find(node => node.id === 'source-root').parentId = 'bar',
    activeSpace: f => f.store.active[10] = 'target', inverted: f => f.sync.invertTabOrder = true,
    newBinding: f => f.local.pinnedTabStatesById[4] = { bookmarkId: 'a', pinnedUrl: url }, split: f => f.tabs.find(tab => tab.id === 11).splitViewId = 0,
    nativePin: f => f.tabs.find(tab => tab.id === 11).pinned = true, movedLive: f => f.tabs.find(tab => tab.id === 1).windowId = 20,
    bindingUrl: f => f.local.pinnedTabStatesById[11].pinnedUrl = 'https://wrong.test/', duplicateOwner: f => f.store.spaces[1].spaceBookmarks.push(11),
    temporaryOwner: f => { f.store.spaces[0].spaceBookmarks = f.store.spaces[0].spaceBookmarks.filter(id => id !== 11); f.store.spaces[0].temporaryTabs.push(11); },
    duplicateRoot: f => f.request.entries.push(f.request.entries[0]), extraField: f => f.request.today = true, mixedFolder: f => f.request.entries.push(f.entry('folder')),
    malformedTree: f => { f.request.entries = [f.entry('folder')]; f.request.entries[0].tree.children.push(f.request.entries[0].tree.children[0]); }
};
for (const [name, mutate] of Object.entries(invalidations)) test(`whole batch preflight rejects ${name}`, async () => {
    const f = fixture(); mutate(f); await assert.rejects(f.move()); assert.deepEqual(moves(f), []); assert.equal(f.local[KEY], undefined);
});

for (const phase of ['prepared', 'committed']) for (const when of ['before', 'after']) test(`${phase} checkpoint ${when}-write rejection is recoverable and never retries bookmarks`, async () => {
    const f = fixture(); let once = true;
    f.hooks[when === 'before' ? 'beforeSet' : 'afterSet'] = async (area, update) => { if (once && area === 'local' && update[KEY]?.phase === phase) { once = false; throw new Error('Storage unavailable'); } };
    await assert.rejects(f.move());
    const beforeMoves = moves(f).length;
    const next = await f.restart(); assert.equal(moves(f).length, beforeMoves);
    assert.deepEqual(membership(next.spaces, 1), [phase === 'prepared' ? 'source' : 'target']);
    assert(!f.local[KEY]);
});

test('bookmark API commit then rejection recovers only exact prefix and never moves untouched remainder', async () => {
    const f = fixture(); let once = true;
    f.hooks.afterMove = () => { if (once) { once = false; throw new Error('Bookmark acknowledgment lost'); } };
    await assert.rejects(f.move(), error => error.batch.uncertain);
    assert.equal(f.local[KEY].phase, 'prepared'); assert.deepEqual(f.children('target-root'), ['z', 'a']);
    const next = await f.restart(); assert.deepEqual(membership(next.spaces, 1), ['target']); assert.deepEqual(membership(next.spaces, 11), ['target']);
    assert.deepEqual(f.children('source-root'), ['folder', 'x']); assert.equal(moves(f).length, 1); assert.equal(f.local[KEY], null);
});

test('session failure after commit uses atomic local receipt to replace stale pending restore queue', async () => {
    const f = fixture(); const record = { tabId: 99, spaceId: 'source', section: 'spaceBookmarks', order: 6, url: 'https://not-live.test/', windowKey: 'closed-window', pinnedState: { bookmarkId: 'a', pinnedUrl: url } };
    f.store.restoreQueue = [record]; f.session.spaceRestoreQueue = [structuredClone(record)];
    let once = true;
    f.hooks.beforeSet = (area, update) => { if (once && area === 'session' && update.spaceSession && f.local[KEY]?.phase === 'committed') { once = false; throw new Error('Session write failed'); } };
    await assert.rejects(f.move(), error => error.batch.completed.length === 2 && !error.batch.uncertain);
    assert.equal(f.session.spaceRestoreQueue[0].spaceId, 'source');
    await f.restart(); assert.equal(f.session.spaceRestoreQueue[0].spaceId, 'target'); assert.equal(f.local.spaceTabSnapshot.find(record => record.tabId === 99).spaceId, 'target');
});

for (const mutation of ['descendant', 'destinationOrder', 'rebound', 'navigated', 'window', 'split', 'newCopy']) test(`recovery keeps pending intent and blocks reconciliation for ambiguous ${mutation}`, async () => {
    const f = fixture({ folder: true });
    f.hooks.beforeSet = (area, update) => { if (area === 'local' && update[KEY]?.phase === 'committed') throw new Error('Crash'); };
    await assert.rejects(f.move()); delete f.hooks.beforeSet;
    if (mutation === 'descendant') f.nodes.find(node => node.id === 'c').title = 'Changed';
    if (mutation === 'destinationOrder') f.nodes.push({ id: 'external', parentId: 'target-root', title: 'External', url });
    if (mutation === 'rebound') f.local.pinnedTabStatesById[2].bookmarkId = 'a';
    if (mutation === 'navigated') f.tabs.find(tab => tab.id === 2).url = 'https://changed.test/';
    if (mutation === 'window') f.tabs.find(tab => tab.id === 2).windowId = 20;
    if (mutation === 'split') f.tabs.find(tab => tab.id === 2).splitViewId = 0;
    if (mutation === 'newCopy') { f.tabs.push({ ...f.tabs[1], id: 50 }); f.local.pinnedTabStatesById[50] = { bookmarkId: 'b', pinnedUrl: url }; }
    const before = structuredClone(f.local.spaces); await assert.rejects(f.restart()); assert.deepEqual(f.local.spaces, before); assert.equal(f.local[KEY].phase, 'prepared'); assert.equal(moves(f).length, 1);
});

test('cold recovery never replays old IDs when the session witness is absent', async () => {
    const f = fixture({ folder: true });
    f.hooks.beforeSet = (area, update) => { if (area === 'local' && update[KEY]?.phase === 'committed') throw new Error('Crash'); };
    await assert.rejects(f.move()); delete f.hooks.beforeSet;
    for (const key of Object.keys(f.session)) delete f.session[key];
    // Reused IDs belong to unrelated pages. Normal cold restore cannot match.
    for (const tab of f.tabs) tab.url = `https://unrelated-${tab.id}.test/`;
    const next = await f.restart();
    for (const id of [2, 3, 12]) assert(!next.spaces.find(space => space.id === 'target').spaceBookmarks.includes(id));
    assert.deepEqual(f.local.pinnedTabStatesById, {});
    const restored = f.local.spaceTabSnapshot.filter(record => ['b', 'c'].includes(record.pinnedState?.bookmarkId));
    assert(restored.length >= 3); assert(restored.every(record => record.spaceId === 'target')); assert.equal(moves(f).length, 1);
});

test('foreign extension sender cannot start a saved move', () => {
    const f = fixture(); registerSavedMoveMessages(f.store); let result;
    f.listeners[0](f.request, { id: 'other' }, response => { result = response; }); assert.equal(result.success, false); assert.deepEqual(moves(f), []);
});

test('a selected nested pin cannot follow its source parent into another Space', async () => {
    const f = fixture(); f.request.entries = [{ ...f.entry('b'), tabId: 2 }];
    let once = true;
    f.hooks.afterSet = (area, update) => { if (once && area === 'local' && update[KEY]?.phase === 'prepared') { once = false; f.nodes.find(node => node.id === 'folder').parentId = 'target-root'; } };
    await assert.rejects(f.move()); assert.deepEqual(moves(f), []); assert.equal(f.local[KEY].phase, 'prepared');
    await assert.rejects(f.restart()); assert.deepEqual(moves(f), []);
});

for (const mutation of ['split', 'navigation', 'window', 'closed']) test(`last-window await cannot hide linked copy ${mutation} at bookmark boundary`, async () => {
    const f = fixture(); let ready = false;
    f.hooks.afterSet = (area, update) => { if (area === 'local' && update[KEY]?.phase === 'prepared') ready = true; };
    f.hooks.window = id => {
        if (!ready || id !== 20) return; ready = false;
        const tab = f.tabs.find(tab => tab.id === 11);
        if (mutation === 'split') tab.splitViewId = 0;
        if (mutation === 'navigation') tab.url = 'https://new-page.test/';
        if (mutation === 'window') tab.windowId = 10;
        if (mutation === 'closed') f.tabs.splice(f.tabs.indexOf(tab), 1);
    };
    await assert.rejects(f.move()); assert.deepEqual(moves(f), []);
});

for (const mutation of ['tree', 'rootMap', 'parents', 'copies', 'request', 'receipt', 'checkpoint', 'liveCount']) test(`corrupt ${mutation} recovery provenance fails closed before canonical write`, async () => {
    const f = fixture();
    f.hooks.beforeSet = (area, update) => { if (area === 'local' && update[KEY]?.phase === 'committed') throw new Error('Crash'); };
    await assert.rejects(f.move()); delete f.hooks.beforeSet;
    const journal = f.local[KEY];
    if (mutation === 'tree') journal.roots[0].id = 'unrelated';
    if (mutation === 'rootMap') journal.rootByBookmark.a = 'x';
    if (mutation === 'parents') journal.parents[0].ids = ['missing'];
    if (mutation === 'copies') journal.live.push(journal.live[0]);
    if (mutation === 'request') journal.request.entries[0].title = 'Other title';
    if (mutation === 'receipt') { journal.phase = 'committed'; journal.receipt = { completed: ['x'] }; }
    if (mutation === 'checkpoint') f.local.spaceTabSnapshot[0].spaceId = 'target';
    if (mutation === 'liveCount') journal.checkpoint.liveCount = 0;
    const before = structuredClone(f.local.spaces); await assert.rejects(f.restart()); assert.deepEqual(f.local.spaces, before); assert(f.local[KEY]);
});

test('closed exact copy during failed move is not recreated or replaced with a URL twin on recovery', async () => {
    const f = fixture();
    f.hooks.afterMove = () => { f.tabs.splice(f.tabs.findIndex(tab => tab.id === 11), 1); throw new Error('Stopped'); };
    await assert.rejects(f.move()); const next = await f.restart();
    assert.deepEqual(membership(next.spaces, 1), ['target']); assert.deepEqual(membership(next.spaces, 11), []); assert.deepEqual(membership(next.spaces, 4), ['source']); assert.equal(moves(f).length, 1);
});

test('stale startup reconciliation cannot demote or remove a moved pin', async () => {
    const f = fixture(), before = structuredClone(f.store.spaces), after = structuredClone(before);
    after[0].spaceBookmarks = after[0].spaceBookmarks.filter(id => id !== 1); after[0].temporaryTabs.push(1);
    await f.move(); const result = await f.store.dispatch({ action: 'reconcilePins', before, after });
    assert.deepEqual(membership(result, 1), ['target']); assert(result.find(space => space.id === 'target').spaceBookmarks.includes(1));
});

test('zero-write crash classification leaves bookmark and descendant order exactly unchanged', async () => {
    const f = fixture({ folder: true }), before = f.tree('folder');
    f.hooks.beforeMove = () => { throw new Error('Native write rejected'); };
    await assert.rejects(f.move()); await f.restart();
    assert.deepEqual(f.tree('folder'), before); assert.equal(moves(f).length, 0); assert.equal(f.local[KEY], null);
});

for (const when of ['before', 'after']) test(`journal cleanup ${when}-write failure preserves the proven completed outcome`, async () => {
    const f = fixture(); let once = true;
    f.hooks[when === 'before' ? 'beforeSet' : 'afterSet'] = (area, update) => { if (once && area === 'local' && update[KEY] === null) { once = false; throw new Error('Cleanup unavailable'); } };
    const result = await f.move(); assert.deepEqual(result.completed, ['a', 'x']); assert.equal(result.uncertain, false);
    await f.restart(); assert.equal(f.local[KEY], null); assert.equal(moves(f).length, 2);
});

test('prepared recovery rebases persisted ranks before a later cold restart', async () => {
    const f = fixture(); f.store.restoredRanks = new Map([[1, 0], [11, 1], [8, 10]]); f.session.restoredTabRanks = [...f.store.restoredRanks];
    for (const id of [1, 11, 8]) f.tabs.find(tab => tab.id === id).url = `https://unique-${id}.test/`;
    f.hooks.afterMove = () => { throw new Error('Interrupted after first saved root'); };
    await assert.rejects(f.move()); await f.restart();
    const orders = new Map(f.local.spaceTabSnapshot.filter(record => record.spaceId === 'target').map(record => [record.tabId, record.order]));
    assert(orders.get(8) < orders.get(1)); assert(orders.get(1) < orders.get(11));
    for (const key of Object.keys(f.session)) delete f.session[key];
    for (const tab of f.tabs) tab.id += 100;
    const cold = await f.restart();
    assert.deepEqual(cold.spaces.find(space => space.id === 'target').spaceBookmarks, [108, 101, 111]);
    assert.equal(moves(f).length, 1);
});

test('the shared startup barrier completes before a saved move begins its bookmark writes', async () => {
    const { withSavedMoveLock } = await import('../../saved-move-lock.js');
    const f = fixture(); let release, entered;
    const ready = new Promise(resolve => { entered = resolve; });
    const startup = withSavedMoveLock(async () => { entered(); await new Promise(resolve => { release = resolve; }); });
    await ready;
    const moving = f.move(); await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(moves(f), []);
    release(); await startup; await moving; assert.equal(moves(f).length, 2);
});

test('an empty clicked folder moves by its exact ID with no tab changes', async () => {
    const f = fixture(); f.nodes.push({ id: 'empty', parentId: 'source-root', title: 'Empty' }); f.request.entries = [f.entry('empty')];
    const before = structuredClone(f.tabs); await f.move();
    assert.deepEqual(f.children('target-root'), ['z', 'empty']); assert.deepEqual(f.tabs, before);
});

for (const inverted of [false, true]) test(`selected saved pins across different folders retain visible batch order, inverted=${inverted}`, async () => {
    const f = fixture({ inverted }); f.request.entries = (inverted ? ['c', 'b', 'a'] : ['a', 'b', 'c']).map(id => ({ ...f.entry(id), tabId: id === 'a' ? 1 : id === 'b' ? 2 : 3 }));
    await f.move(); assert.deepEqual(f.children('target-root'), inverted ? ['a', 'b', 'c', 'z'] : ['z', 'a', 'b', 'c']);
    assert.deepEqual(f.children('folder'), ['sub']); assert.deepEqual(f.children('sub'), []);
    for (const id of [1, 11, 2, 12, 3]) assert.deepEqual(membership(f.local.spaces, id), ['target']);
});

test('the complete prepared and committed journal envelope is bounded before any bookmark mutation', async () => {
    const f = fixture(); f.nodes.push({ id: 'large', parentId: 'source-root', title: 'Large folder' });
    for (let index = 0; index < 66; index++) f.nodes.push({ id: `large-${index}`, parentId: 'large', title: 'Large URL', url: `https://large.test/${'a'.repeat(14500)}` });
    f.request.entries = [f.entry('large')]; assert(JSON.stringify(f.request).length < 1000000);
    await assert.rejects(f.move(), /too large/); assert.deepEqual(moves(f), []); assert.equal(f.local[KEY], undefined);
});

test('native split preflight returns a clear untouched batch rather than unknown transport outcome', async () => {
    const f = fixture(); f.tabs.find(tab => tab.id === 11).splitViewId = 0;
    await assert.rejects(f.move(), error => {
        assert.match(error.message, /End Split View/); assert.deepEqual(error.batch.completed, []);
        assert.deepEqual(error.batch.remaining, ['a', 'x']); assert.equal(error.batch.uncertain, false); return true;
    });
});
