import test from 'node:test';
import assert from 'node:assert/strict';
import { ArchiveStore, ARCHIVE_KEY, ARCHIVE_CLAIMS_KEY, ARCHIVE_SESSION_KEY, migrateArchiveEntries, registerArchiveMessages } from '../../archive-store.js';
import { SpaceStore } from '../../space-store.js';
import { Utils } from '../../utils.js';

const clone = value => structuredClone(value);
const original = (extra = {}) => ({ url: 'https://archive.test/page', name: 'Archived page', spaceId: 'original', archivedAt: 12, ...extra });
function fixture(entries = [original()]) {
    let nextTabId = 100;
    const local = { [ARCHIVE_KEY]: clone(entries), pinnedTabStatesById: {}, todayOrderRepresentation: { version: 1, inverted: false } }, session = {}, hooks = {}, effects = [], listeners = [];
    const nodes = [{ id: 'root', title: 'Arcify' }, { id: 'source-folder', title: 'Source', parentId: 'root' }, { id: 'original-folder', title: 'Original', parentId: 'root' }];
    const tabs = [{ id: 1, windowId: 10, active: true, url: 'https://source.test/', title: 'Source' }, { id: 2, windowId: 20, active: true, url: 'https://source.test/' }];
    const area = (data, name) => ({ async get(keys) { await hooks.get?.(keys, name); const names = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys || data); return Object.fromEntries(names.map(key => [key, clone(data[key] ?? keys?.[key])])); },
        async set(values) { await hooks.beforeSet?.(values, name); Object.assign(data, clone(values)); effects.push(['storage', name, clone(values)]); await hooks.afterSet?.(values, name); } });
    globalThis.chrome = {
        runtime: { id: 'arcify', getURL: path => `chrome-extension://arcify/${path}`, onMessage: { addListener(fn) { listeners.push(fn); } } },
        storage: { local: area(local, 'local'), session: area(session, 'session'), sync: { async get(defaults) { return typeof defaults === 'object' ? defaults : {}; } } },
        windows: { async get(id) { await hooks.window?.(id); return { id, type: 'normal', ...hooks.windowResult }; },
            async update(id, data) { await hooks.focusWindow?.(); effects.push(['focus-window', id, data]); } },
        bookmarks: { async get(id) { await hooks.bookmark?.(id); return clone(nodes.filter(node => node.id === id)); }, async search() { return clone(nodes.filter(node => node.title === 'Arcify')); } },
        tabs: { async query(query = {}) { await hooks.query?.(query); return clone(tabs.filter(tab => (query.windowId === undefined || query.windowId === tab.windowId) && (query.active === undefined || query.active === tab.active))); },
            async get(id) { await hooks.tab?.(id); const tab = tabs.find(tab => tab.id === id); if (!tab) throw new Error('Closed'); return clone(tab); },
            async create(data) { effects.push(['create', clone(data)]); const tab = { id: nextTabId++, title: 'Restored', ...data }; tabs.push(tab); await hooks.create?.(tab); return clone(tab); },
            async update(id, values) { await hooks.focusTab?.(id); effects.push(['focus-tab', id, values]); tabs.filter(tab => tab.windowId === tabs.find(tab => tab.id === id)?.windowId).forEach(tab => { tab.active = tab.id === id; }); return clone(tabs.find(tab => tab.id === id)); },
            async remove(id) { await hooks.remove?.(id); effects.push(['remove', id]); tabs.splice(tabs.findIndex(tab => tab.id === id), 1); } }
    };
    const store = new SpaceStore(); store.initialized = true;
    store.spaces = [{ id: 'source', bookmarkFolderId: 'source-folder', temporaryTabs: [1, 2], spaceBookmarks: [] }, { id: 'original', bookmarkFolderId: 'original-folder', temporaryTabs: [], spaceBookmarks: [] }];
    store.active = { 10: 'source', 20: 'source' }; store.liveTabs = new Map(tabs.map(tab => [tab.id, tab]));
    store.isGlobalTab = tab => hooks.globalIds?.has(typeof tab === 'object' ? tab.id : tab) || false;
    local.spaces = clone(store.spaces); session.activeSpaces = clone(store.active);
    // Focused store fixture models the beforeWrite boundary and durable reload;
    // full SpaceStore reinitialization is also exercised by bridge integration tests.
    store.persist = async (options = {}) => { await hooks.persist?.(); await options.beforeWrite?.();
        local.spaces = clone(store.spaces); session.activeSpaces = clone(store.active); effects.push(['persist']); await hooks.afterPersist?.(); };
    store.initialize = async () => { if (store.initialized) return;
        store.spaces = clone(local.spaces); store.active = clone(session.activeSpaces);
        await store.archiveStore.initializeClaimsUnlocked(); store.initialized = true; };
    const archive = store.archiveStore;
    const prepare = async (index = 0, windowId = 10) => { const view = await archive.view(windowId); return { requestId: crypto.randomUUID(), windowId, context: view.context, expected: view.entries[index].entry, bookmarkFolderId: view.entries[index].bookmarkFolderId }; };
    const creates = () => effects.filter(([kind]) => kind === 'create');
    return { local, session, hooks, effects, nodes, tabs, store, archive, prepare, creates, listeners };
}

test('additive migration preserves every legacy field, row, same-URL identity, order and timestamp; old readers work', async () => {
    const entries = [original({ archivedAt: 50, extra: { nested: [1, 2] } }), original(), original({ spaceId: 'source', archivedAt: 7 })];
    const f = fixture(entries), migrated = await f.archive.list();
    assert.deepEqual(migrated.map(({ entryId, ...entry }) => entry), entries);
    assert.equal(new Set(migrated.map(entry => entry.entryId)).size, entries.length);
    assert.deepEqual(await f.archive.list(), migrated);
    assert.deepEqual(f.local.archivedTabs.map(entry => [entry.url, entry.name, entry.spaceId, entry.archivedAt]), entries.map(entry => [entry.url, entry.name, entry.spaceId, entry.archivedAt]));
});
test('duplicate IDs all rotate, stale capabilities cannot choose one, and migration never caps old data', async () => {
    const entries = Array.from({ length: 105 }, (_, i) => original({ entryId: i < 2 ? 'duplicate' : `unique-${i}`, archivedAt: i }));
    const f = fixture(entries), next = await f.archive.list();
    assert.equal(next.length, 105); assert.equal(new Set(next.map(entry => entry.entryId)).size, 105);
    assert(next.slice(0, 2).every(entry => entry.entryId !== 'duplicate')); assert.equal(next[2].entryId, 'unique-2');
    assert.throws(() => f.archive.resolve(next, entries[0]), /Refresh/);
});
test('legacy exact unchanged tuple resolves uniquely, ambiguity and changed unknown fields require refresh', async () => {
    const f = fixture(), migrated = await f.archive.list();
    assert.equal(f.archive.resolve(migrated, original()).entryId, migrated[0].entryId);
    assert.throws(() => f.archive.resolve(migrateArchiveEntries([original(), original()]), original()), /Refresh/);
    assert.throws(() => f.archive.resolve(migrated, original({ extra: 'new' })), /Refresh/);
});
test('new additions keep global exact-URL dedup and newest-first 100 cap; concurrent writers retain unrelated entries', async () => {
    const f = fixture([]);
    await Promise.all(Array.from({ length: 105 }, (_, i) => f.archive.add(original({ url: `https://page.test/${i}` }))));
    assert.equal(f.local.archivedTabs.length, 100);
    const before = clone(f.local.archivedTabs);
    const duplicate = await f.archive.add({ ...before[0], spaceId: 'source' });
    assert.equal(duplicate.added, false); assert.deepEqual(f.local.archivedTabs, before);
});
test('Space-ID migration retains IDs and unknown fields, and stale full replacement cannot erase concurrent additions', async () => {
    const f = fixture([original({ spaceId: 42, extra: 'keep' })]);
    const before = await f.archive.list(); await f.store.run(() => f.archive.migrateSpaceIdsUnlocked(new Map([[42, 'original']])));
    assert.deepEqual(f.local.archivedTabs, [{ ...before[0], spaceId: 'original' }]);
    await assert.rejects(f.store.run(() => f.archive.replaceUnlocked([], before)), /Refresh/);
});
test('reopen creates inactive in explicit window, ordinary Today in original Space, exact consume, then focus', async () => {
    const f = fixture([original(), original({ spaceId: 'source', archivedAt: 4 })]), request = await f.prepare();
    const twin = clone(f.local.archivedTabs[1]); const result = await f.archive.reopen(request);
    assert.equal(result.status, 'reopened'); assert.equal(result.consumed, true);
    assert.deepEqual(f.creates()[0][1], { windowId: 10, url: original().url, active: false });
    assert.deepEqual(f.store.spaces[0].temporaryTabs, [1, 2]); assert.deepEqual(f.store.spaces[1].temporaryTabs, [100]);
    assert.deepEqual(f.store.spaces.flatMap(space => space.spaceBookmarks), []);
    assert.deepEqual(f.local.archivedTabs, [twin]); assert.equal(f.store.active[10], 'original'); assert.equal(f.store.active[20], 'source');
    const commit = f.effects.findIndex(([kind, area, values]) => kind === 'storage' && area === 'local' && values.archivedTabs?.length === 1);
    assert(f.effects.findIndex(([kind]) => kind === 'focus-tab') > commit);
    const replay = await f.archive.reopen({ ...request, requestId: crypto.randomUUID() });
    assert.equal(replay.replayed, true); assert.equal(f.creates().length, 1);
});
for (const kind of ['entry-edited', 'entry-deleted', 'space-deleted', 'folder-replaced', 'folder-moved', 'source-moved', 'source-closed', 'source-navigated', 'space-switched', 'window-private', 'window-popup']) test(`stale ${kind} refuses before native create and preserves other state`, async () => {
    const f = fixture(), request = await f.prepare();
    if (kind === 'entry-edited') f.local.archivedTabs[0].name = 'Changed';
    if (kind === 'entry-deleted') f.local.archivedTabs = [];
    if (kind === 'space-deleted') f.store.spaces.pop();
    if (kind === 'folder-replaced') f.store.spaces[1].bookmarkFolderId = 'replacement';
    if (kind === 'folder-moved') f.nodes[2].parentId = 'outside';
    if (kind === 'source-moved') f.tabs[0].windowId = 20;
    if (kind === 'source-closed') f.tabs.shift();
    if (kind === 'source-navigated') f.tabs[0].url = 'https://changed.test/';
    if (kind === 'space-switched') f.store.active[10] = 'original';
    if (kind === 'window-private') f.hooks.windowResult = { incognito: true };
    if (kind === 'window-popup') f.hooks.windowResult = { type: 'popup' };
    const before = clone(f.local.archivedTabs), spaces = clone(f.store.spaces), tabs = clone(f.tabs);
    await assert.rejects(f.archive.reopen(request)); assert.equal(f.creates().length, 0);
    assert.deepEqual(f.local.archivedTabs, before); assert.deepEqual(f.store.spaces, spaces); assert.deepEqual(f.tabs, tabs);
});
for (const url of ['javascript:alert(1)', 'data:text/html,x', 'chrome-extension://other/page', 'chrome://newtab/', 'https://bad.test/a b']) test(`unsupported ${url} remains archived`, async () => {
    const f = fixture([original({ url })]), request = await f.prepare();
    await assert.rejects(f.archive.reopen(request), { code: 'UNSUPPORTED_URL' }); assert.equal(f.creates().length, 0); assert.equal(f.local.archivedTabs.length, 1);
});
test('Space rename and unrelated archive additions do not invalidate exact reopen', async () => {
    const f = fixture(), request = await f.prepare(); f.store.spaces[1].name = 'Renamed'; f.nodes[2].title = 'Renamed';
    await f.archive.add(original({ url: 'https://unrelated.test/' })); await f.archive.reopen(request);
    assert.equal(f.local.archivedTabs.length, 1); assert.equal(f.local.archivedTabs[0].url, 'https://unrelated.test/');
});
test('double-click and simultaneous new request IDs create only once', async () => {
    const f = fixture(), request = await f.prepare();
    const results = await Promise.all([f.archive.reopen(request), f.archive.reopen({ ...request, requestId: 'second' })]);
    assert(results.every(result => result.consumed)); assert.equal(f.creates().length, 1);
});
for (const boundary of ['throw-after-create', 'missing-created-id', 'receipt-write-failed']) test(`${boundary} keeps unresolved claim and blocks every new request, worker restart and full restart`, async () => {
    const f = fixture(), request = await f.prepare();
    if (boundary === 'throw-after-create') f.hooks.create = () => { throw new Error('Response lost'); };
    if (boundary === 'missing-created-id') f.hooks.create = tab => { delete tab.id; };
    if (boundary === 'receipt-write-failed') f.hooks.beforeSet = values => { if (values[ARCHIVE_CLAIMS_KEY]?.entries[request.expected.entryId]?.phase === 'created') throw new Error('Disk full'); };
    await assert.rejects(f.archive.reopen(request), { code: 'UNCERTAIN_RESULT' });
    f.hooks.create = null; f.hooks.beforeSet = null;
    for (const restart of ['same-worker', 'new-worker', 'browser-restart']) {
        if (restart === 'browser-restart') delete f.session[ARCHIVE_SESSION_KEY];
        const archive = restart === 'same-worker' ? f.archive : new ArchiveStore(f.store);
        await assert.rejects(archive.reopen({ ...request, requestId: restart }), { code: 'UNCERTAIN_RESULT' });
    }
    assert.equal(f.creates().length, 1); assert.equal(f.local.archivedTabs.length, 1); assert.equal(f.tabs[0].active, true);
});
test('claim persistence failure before create leaves source and archive intact', async () => {
    const f = fixture(), request = await f.prepare(); f.hooks.beforeSet = values => { if (values[ARCHIVE_CLAIMS_KEY]) throw new Error('Disk full'); };
    await assert.rejects(f.archive.reopen(request), /Disk full/); assert.equal(f.creates().length, 0); assert.equal(f.local.archivedTabs.length, 1);
});
test('post-claim preflight failure clears only proven unstarted claim and never creates', async () => {
    const f = fixture(), request = await f.prepare(); f.hooks.afterSet = values => { if (values[ARCHIVE_CLAIMS_KEY]?.entries[request.expected.entryId]?.phase === 'creating') f.nodes[2].parentId = 'outside'; };
    await assert.rejects(f.archive.reopen(request)); assert.equal(f.creates().length, 0); assert.deepEqual(f.local[ARCHIVE_CLAIMS_KEY].entries, {});
});
test('known created receipt survives worker restart, does not adopt into source, and reconciles exact ID once', async () => {
    const f = fixture(), request = await f.prepare(); f.hooks.persist = () => { throw new Error('Persist failed'); };
    await assert.rejects(f.archive.reopen(request), { code: 'REOPEN_PARTIAL' }); assert.equal(f.creates().length, 1);
    f.hooks.persist = null; f.store.spaces[1].temporaryTabs = [];
    f.store.archiveStore = new ArchiveStore(f.store); await f.store.archiveStore.initializeClaimsUnlocked();
    f.store.track(f.tabs.find(tab => tab.id === 100)); assert.deepEqual(f.store.spaces[0].temporaryTabs, [1, 2]);
    const result = await f.store.archiveStore.reopen({ ...request, requestId: 'resume' });
    assert.equal(result.consumed, true); assert.equal(f.creates().length, 1); assert.deepEqual(f.store.spaces[1].temporaryTabs, [100]);
});
test('full restart never trusts known native ID, even when another tab reuses its ID and URL', async () => {
    const f = fixture(), request = await f.prepare(); f.hooks.persist = () => { throw new Error('Persist failed'); };
    await assert.rejects(f.archive.reopen(request)); f.hooks.persist = null; delete f.session[ARCHIVE_SESSION_KEY];
    f.tabs.find(tab => tab.id === 100).title = 'Unrelated reused ID';
    await assert.rejects(new ArchiveStore(f.store).reopen({ ...request, requestId: 'after-restart' }), { code: 'UNCERTAIN_RESULT' });
    assert.equal(f.creates().length, 1); assert.equal(f.local.archivedTabs.length, 1); assert.equal(f.tabs[0].active, true);
});
for (const change of ['window', 'pinned', 'global', 'split', 'closed', 'other-space']) test(`known created ${change} identity is retained without consume or replacement`, async () => {
    const f = fixture(), request = await f.prepare(); f.hooks.create = tab => {
        if (change === 'window') tab.windowId = 20;
        if (change === 'pinned') tab.pinned = true;
        if (change === 'global') f.hooks.globalIds = new Set([tab.id]);
        if (change === 'split') tab.splitViewId = 77;
        if (change === 'closed') f.tabs.pop();
        if (change === 'other-space') f.store.spaces[0].temporaryTabs.push(tab.id);
    };
    await assert.rejects(f.archive.reopen(request), { code: 'REOPEN_PARTIAL' }); assert.equal(f.local.archivedTabs.length, 1); assert.equal(f.creates().length, 1); assert.equal(f.tabs[0].active, true);
});
for (const boundary of ['focus-tab', 'focus-window', 'display-persist']) test(`known commit followed by ${boundary} failure is consumed partial success, not retryable create`, async () => {
    const f = fixture(), request = await f.prepare();
    if (boundary === 'focus-tab') f.hooks.focusTab = () => { throw new Error('Focus failed'); };
    if (boundary === 'focus-window') f.hooks.focusWindow = () => { throw new Error('Focus failed'); };
    if (boundary === 'display-persist') { let calls = 0; f.hooks.persist = () => { if (++calls === 2) throw new Error('Refresh failed'); }; }
    const result = await f.archive.reopen(request);
    assert.equal(result.status, 'partial'); assert.equal(result.consumed, true); assert.equal(result.tabId, 100); assert.equal(f.local.archivedTabs.length, 0);
    assert.equal((await f.archive.reopen({ ...request, requestId: 'new' })).consumed, true); assert.equal(f.creates().length, 1);
});
test('manual and queued automatic writers use same authoritative core without nesting or losing additions', async () => {
    const f = fixture([]); f.tabs[0].active = false;
    const request = { tabId: 1, windowId: 10, spaceId: 'source', bookmarkFolderId: 'source-folder', url: f.tabs[0].url };
    await Promise.all([f.store.run(() => f.archive.archiveUnlocked(request, { automatic: true })), f.archive.add(original())]);
    assert.equal(f.local.archivedTabs.length, 2); assert.deepEqual(f.effects.filter(([kind]) => kind === 'remove').map(([, id]) => id), [1]);
});
test('manual archive storage failure never closes source; stale native move after add leaves source alive', async () => {
    const f = fixture([]), request = { tabId: 1, windowId: 10, spaceId: 'source', bookmarkFolderId: 'source-folder', url: f.tabs[0].url };
    f.hooks.beforeSet = values => { if (values.archivedTabs) throw new Error('Save failed'); };
    await assert.rejects(f.archive.archive(request), /Save failed/); assert(f.tabs.some(tab => tab.id === 1));
    f.hooks.beforeSet = null; f.hooks.afterSet = values => { if (values.archivedTabs) f.tabs[0].windowId = 20; };
    await assert.rejects(f.archive.archive(request)); assert(f.tabs.some(tab => tab.id === 1)); assert.equal(f.local.archivedTabs.length, 1);
});
test('authenticated message route rejects foreign extensions, website origins, mismatched windows and extra fields', async () => {
    const f = fixture(); registerArchiveMessages(f.store); const listener = f.listeners[0];
    for (const sender of [{ id: 'other' }, { id: 'arcify', url: 'https://bad.test/' }, { id: 'arcify', origin: 'https://bad.test' }, { id: 'arcify', tab: { windowId: 20 } }]) {
        let result; listener({ type: 'archiveStore', action: 'view', windowId: 10 }, sender, value => { result = value; }); assert.equal(result.code, 'UNAUTHORIZED');
    }
    let result; listener({ type: 'archiveStore', action: 'list', surprise: true }, { id: 'arcify' }, value => { result = value; }); assert.equal(result.code, 'INVALID_REQUEST');
    assert.equal(f.effects.length, 0);
});
test('Utils legacy reader uses the authoritative route and URL-only removal refuses', async () => {
    const f = fixture(); registerArchiveMessages(f.store);
    chrome.runtime.sendMessage = message => new Promise(resolve => f.listeners[0](message, { id: 'arcify' }, resolve));
    const entries = await Utils.getArchivedTabs(); assert(entries[0].entryId);
    await assert.rejects(Utils.removeArchivedTab(entries[0].url, entries[0].spaceId), /Refresh/);
    assert.equal(f.local.archivedTabs.length, 1);
});

for (const mutation of ['closed', 'moved', 'pinned', 'split', 'bound', 'source', 'folder', 'space']) test(`final read boundary refuses ${mutation} change after assignment without consuming`, async () => {
    const f = fixture(), request = await f.prepare(); let assigned = false, reads = 0;
    f.hooks.afterSet = values => { if (values[ARCHIVE_CLAIMS_KEY]?.entries[request.expected.entryId]?.phase === 'assigned') assigned = true; };
    f.hooks.get = key => {
        if (!assigned || key !== ARCHIVE_KEY || ++reads !== 1) return;
        const tab = f.tabs.find(tab => tab.id === 100);
        if (mutation === 'closed') f.tabs.splice(f.tabs.indexOf(tab), 1);
        if (mutation === 'moved') tab.windowId = 20;
        if (mutation === 'pinned') tab.pinned = true;
        if (mutation === 'split') tab.splitViewId = 2;
        if (mutation === 'bound') f.local.pinnedTabStatesById[100] = { bookmarkId: 'pin' };
        if (mutation === 'source') f.tabs[0].url = 'https://new-source.test/';
        if (mutation === 'folder') f.nodes[2].parentId = 'outside';
        if (mutation === 'space') f.store.active[10] = 'original';
    };
    await assert.rejects(f.archive.reopen(request), { code: 'REOPEN_PARTIAL' });
    assert.equal(f.local.archivedTabs.length, 1); assert.equal(f.creates().length, 1);
    assert(!f.effects.some(([kind]) => kind === 'focus-tab'));
});
test('event fence detects transient source changes during native snapshot even if it changes back', async () => {
    const f = fixture(), request = await f.prepare();
    const event = { listeners: new Set(), addListener(fn) { this.listeners.add(fn); }, removeListener(fn) { this.listeners.delete(fn); } };
    chrome.tabs.onUpdated = event;
    f.hooks.query = query => { if (!Object.keys(query).length) for (const fn of event.listeners) fn(1, { url: 'https://temporary.test/' }); };
    await assert.rejects(f.archive.reopen(request)); assert.equal(f.creates().length, 0); assert.equal(event.listeners.size, 0);
});
test('duplicate Arcify roots and wrong exact folder identity refuse safely', async () => {
    for (const kind of ['duplicate-root', 'wrong-id']) {
        const f = fixture(), request = await f.prepare();
        if (kind === 'duplicate-root') f.nodes.push({ id: 'another-root', title: 'Arcify' });
        else chrome.bookmarks.get = async id => [{ id: `${id}-different`, parentId: 'root' }];
        await assert.rejects(f.archive.reopen(request)); assert.equal(f.creates().length, 0); assert.equal(f.local.archivedTabs.length, 1);
    }
});
for (const afterCommit of [false, true]) test(`consume storage ${afterCommit ? 'lost response' : 'refusal'} never creates twice`, async () => {
    const f = fixture(), request = await f.prepare();
    f.hooks[afterCommit ? 'afterSet' : 'beforeSet'] = values => {
        if (values.archivedTabs && values[ARCHIVE_CLAIMS_KEY]?.entries[request.expected.entryId]?.phase === 'consumed') throw new Error('Commit interrupted');
    };
    if (afterCommit) {
        const result = await f.archive.reopen(request); assert.equal(result.consumed, true); assert.equal(result.status, 'partial');
        assert.equal(f.local.archivedTabs.length, 0);
    } else { await assert.rejects(f.archive.reopen(request), { code: 'REOPEN_PARTIAL' }); assert.equal(f.local.archivedTabs.length, 1); }
    f.hooks.afterSet = null; f.hooks.beforeSet = null;
    assert.equal((await f.archive.reopen({ ...request, requestId: 'retry' })).consumed, true); assert.equal(f.creates().length, 1);
});
test('completed receipt replay preserves known partial warning and never touches focus twice', async () => {
    const f = fixture(), request = await f.prepare(); f.hooks.focusWindow = () => { throw new Error('Focus failed'); };
    const result = await f.archive.reopen(request), replay = await f.archive.reopen({ ...request, requestId: 'again' });
    assert.equal(result.status, 'partial'); assert.equal(replay.status, 'partial'); assert.equal(replay.warning, result.warning);
    assert.equal(f.effects.filter(([kind]) => kind === 'focus-tab').length, 1);
});
test('completed receipts are bounded but unresolved claims are never pruned or aged out', () => {
    const f = fixture(), entries = {};
    for (let i = 0; i < 125; i++) entries[`done-${i}`] = { entryId: `done-${i}`, phase: 'consumed' };
    entries.pending = { entryId: 'pending', phase: 'creating' };
    f.archive.compactClaims(entries); assert.equal(Object.keys(entries).length, 101); assert(entries.pending); assert(!entries['done-0']);
});
test('manual archive uses rendered Space snapshot rather than a newer current owner', async () => {
    const f = fixture([]); registerArchiveMessages(f.store);
    chrome.runtime.sendMessage = message => new Promise(resolve => f.listeners[0](message, { id: 'arcify' }, resolve));
    const sourceTab = clone(f.tabs[0]), source = { id: 'source', bookmarkFolderId: 'source-folder' };
    f.store.spaces[0].temporaryTabs = [2]; f.store.spaces[1].temporaryTabs = [1];
    await assert.rejects(Utils.archiveTab(1, sourceTab, source)); assert.equal(f.local.archivedTabs.length, 0); assert(f.tabs.some(tab => tab.id === 1));
});

for (const malformed of [null, false, 0, {}, { phase: 'created', tabId: 100 }]) test(`malformed per-entry claim ${JSON.stringify(malformed)} cannot be treated as absent`, async () => {
    const f = fixture(), request = await f.prepare();
    f.local[ARCHIVE_CLAIMS_KEY] = { version: 1, entries: { [request.expected.entryId]: malformed } };
    await assert.rejects(f.archive.reopen(request), { code: 'UNCERTAIN_RESULT' }); assert.equal(f.creates().length, 0); assert.equal(f.local.archivedTabs.length, 1);
});

test('different same-URL identities reopen independently after context refresh without mutating prior live tab', async () => {
    const f = fixture([original(), original({ spaceId: 'source', archivedAt: 7 })]);
    const first = await f.prepare(0), second = await f.prepare(1);
    const outcomes = await Promise.allSettled([f.archive.reopen(first), f.archive.reopen(second)]);
    assert.equal(outcomes[0].status, 'fulfilled'); assert.equal(outcomes[1].status, 'rejected'); assert.equal(f.creates().length, 1);
    const refreshed = await f.prepare(0); await f.archive.reopen(refreshed);
    assert.equal(f.creates().length, 2); assert.equal(f.local.archivedTabs.length, 0);
    assert.deepEqual(f.store.spaces[1].temporaryTabs, [100]); assert(f.store.spaces[0].temporaryTabs.includes(101));
    assert(f.tabs.some(tab => tab.id === 1)); assert(f.tabs.some(tab => tab.id === 100));
});
test('lost created-receipt response may reconcile only durably known exact ID on explicit retry', async () => {
    const f = fixture(), request = await f.prepare(); let fail = true;
    f.hooks.afterSet = values => { if (fail && values[ARCHIVE_CLAIMS_KEY]?.entries[request.expected.entryId]?.phase === 'created') { fail = false; throw new Error('Receipt response lost'); } };
    await assert.rejects(f.archive.reopen(request), { code: 'UNCERTAIN_RESULT' });
    assert.equal(f.local[ARCHIVE_CLAIMS_KEY].entries[request.expected.entryId].tabId, 100);
    const result = await new ArchiveStore(f.store).reopen({ ...request, requestId: 'explicit-retry' });
    assert.equal(result.consumed, true); assert.equal(f.creates().length, 1);
});
for (const repair of ['duplicate-id', 'missing-id']) test(`${repair} repair cannot detach an unresolved create from its unchanged record`, async () => {
    const f = fixture(), request = await f.prepare(); f.hooks.create = () => { throw new Error('Response lost'); };
    await assert.rejects(f.archive.reopen(request), { code: 'UNCERTAIN_RESULT' }); f.hooks.create = null;
    if (repair === 'duplicate-id') f.local.archivedTabs.push(clone(f.local.archivedTabs[0]));
    else delete f.local.archivedTabs[0].entryId;
    const refreshed = await f.prepare(); assert.notEqual(refreshed.expected.entryId, request.expected.entryId);
    await assert.rejects(f.archive.reopen(refreshed), { code: 'UNCERTAIN_RESULT' }); assert.equal(f.creates().length, 1); assert(f.local.archivedTabs.length > 0);
});

test('a unique unchanged legacy object can reopen once, but replay cannot choose an equal-URL survivor', async () => {
    const f = fixture([original(), original({ spaceId: 'source', archivedAt: 7 })]);
    const request = await f.prepare(); delete request.expected.entryId;
    const result = await f.archive.reopen(request); assert.equal(result.consumed, true); assert.equal(f.local.archivedTabs.length, 1);
    await assert.rejects(f.archive.reopen({ ...request, requestId: 'legacy-replay' })); assert.equal(f.creates().length, 1);
});

test('source with a newer pending navigation cannot attest its older visible URL', async () => {
    const f = fixture(), request = await f.prepare(); f.tabs[0].pendingUrl = 'https://pending-source.test/';
    await assert.rejects(f.archive.reopen(request)); assert.equal(f.creates().length, 0); assert.equal(f.local.archivedTabs.length, 1);
});

for (const change of ['new-source', 'moved-created', 'deleted-folder']) test(`post-consume ${change} is known partial and does not override newer native focus`, async () => {
    const f = fixture(), request = await f.prepare(); let persists = 0;
    f.hooks.afterPersist = () => {
        if (++persists !== 2) return;
        if (change === 'new-source') { f.tabs[0].active = false; f.tabs.push({ id: 200, windowId: 10, active: true, url: 'https://new-choice.test/' }); }
        if (change === 'moved-created') f.tabs.find(tab => tab.id === 100).windowId = 20;
        if (change === 'deleted-folder') f.nodes.splice(2, 1);
    };
    const result = await f.archive.reopen(request);
    assert.equal(result.consumed, true); assert.equal(result.status, 'partial'); assert.equal(result.tabId, 100);
    assert.equal(f.local.archivedTabs.length, 0); assert.equal(f.creates().length, 1); assert(!f.effects.some(([kind]) => kind === 'focus-tab'));
});

for (const entryId of ['__proto__', 'constructor', 'toString']) test(`legacy entry ID ${entryId} is an own durable claim key and cannot bypass deduplication`, async () => {
    const f = fixture([original({ entryId })]), request = await f.prepare(); f.hooks.create = () => { throw new Error('Response lost'); };
    await assert.rejects(f.archive.reopen(request), { code: 'UNCERTAIN_RESULT' });
    assert(Object.hasOwn(f.local[ARCHIVE_CLAIMS_KEY].entries, entryId)); f.hooks.create = null;
    await assert.rejects(f.archive.reopen({ ...request, requestId: 'new-request' }), { code: 'UNCERTAIN_RESULT' }); assert.equal(f.creates().length, 1);
});
test('inherited internal action names reject as malformed without throwing from the message listener', () => {
    const f = fixture(); registerArchiveMessages(f.store);
    for (const action of ['__proto__', 'constructor', 'toString']) {
        let result; f.listeners[0]({ type: 'archiveStore', action }, { id: 'arcify' }, value => { result = value; });
        assert.equal(result.code, 'INVALID_REQUEST');
    }
});

test('companion revocation before native create removes only the proven unstarted claim', async () => {
    const f = fixture(), request = await f.prepare(); let reads = 0;
    await assert.rejects(f.store.run(() => f.archive.reopenUnlocked(request, { beforeMutation: async () => {
        if (++reads === 3) throw new Error('pairing revoked');
    } })), /pairing revoked/);
    assert.equal(f.creates().length, 0); assert.equal(f.local.archivedTabs.length, 1);
    assert.deepEqual(f.local.archiveReopenClaims.entries, {});
});
test('companion revocation after known native create keeps exact receipt and archive entry without assigning or focusing', async () => {
    const f = fixture(), request = await f.prepare(); let revoked = false;
    f.hooks.create = async () => { revoked = true; };
    await assert.rejects(f.store.run(() => f.archive.reopenUnlocked(request, { beforeMutation: async () => {
        if (revoked) throw new Error('pairing revoked');
    } })), /pairing revoked/);
    assert.equal(f.creates().length, 1); assert.equal(f.local.archivedTabs.length, 1);
    assert.equal(f.local.archiveReopenClaims.entries[request.expected.entryId].tabId, 100);
    assert.equal(f.local.archiveReopenClaims.entries[request.expected.entryId].phase, 'created');
    assert(!f.effects.some(([kind]) => kind === 'focus-tab'));
    assert(!f.store.spaces.some(space => space.temporaryTabs.includes(100)));
});

test('pairing revocation during archived-tab activation suppresses subsequent window focus with consumed partial receipt', async () => {
    const f = fixture(), request = await f.prepare(); let revoked = false;
    f.hooks.focusTab = async () => { revoked = true; };
    const result = await f.store.run(() => f.archive.reopenUnlocked(request, { beforeMutation: async () => { if (revoked) throw new Error('pairing revoked'); } }));
    assert.equal(result.status, 'partial'); assert.equal(result.consumed, true); assert.equal(result.tabId, 100);
    assert.equal(f.local.archivedTabs.length, 0); assert.equal(f.creates().length, 1);
    assert(!f.effects.some(([kind]) => kind === 'focus-window'));
    assert.equal(f.local.archiveReopenClaims.entries[request.expected.entryId].phase, 'consumed');
});

test('a source change during atomic consume keeps the committed receipt but never overwrites the newer selected Space', async () => {
    const f = fixture(), request = await f.prepare(); let consumed = false, persistsAfterConsume = 0;
    f.hooks.afterSet = values => { if (values[ARCHIVE_CLAIMS_KEY]?.entries[request.expected.entryId]?.phase === 'consumed' && !consumed) {
        consumed = true; f.tabs[0].active = false; f.tabs.push({ id: 3, windowId: 10, active: true, url: 'https://new-source.test/' });
    } };
    f.hooks.persist = () => { if (consumed) persistsAfterConsume++; };
    const result = await f.archive.reopen(request);
    assert.equal(result.status, 'partial'); assert.equal(result.consumed, true); assert.equal(f.local.archivedTabs.length, 0);
    assert.equal(f.store.active[10], 'source'); assert.equal(persistsAfterConsume, 0); assert.equal(f.creates().length, 1);
    assert(!f.effects.some(([kind]) => kind === 'focus-tab' || kind === 'focus-window'));
});
