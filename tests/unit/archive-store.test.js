import test from 'node:test';
import assert from 'node:assert/strict';
import { ArchiveStore, ARCHIVE_KEY, ARCHIVE_CLAIMS_KEY, ARCHIVE_SESSION_KEY, migrateArchiveEntries, registerArchiveMessages } from '../../archive-store.js';
import { SpaceStore } from '../../space-store.js';
import { Utils } from '../../utils.js';
import { archiveRequest } from '../../archive-client.js';

const clone = value => structuredClone(value);
const original = (extra = {}) => ({ url: 'https://archive.test/page', name: 'Archived page', spaceId: 'original', archivedAt: 12, ...extra });

for (const phase of ['created', 'assigned']) for (const worker of ['same', 'restarted']) for (const change of ['completed-navigation', 'pending-navigation', 'loading']) {
    test(`${phase} claim in ${worker} worker rejects ${change} before explicit retry can consume`, async () => {
        const f = fixture(), request = await f.prepare();
        if (phase === 'created') f.hooks.persist = () => { throw new Error('Assignment interrupted'); };
        else f.hooks.afterSet = values => { if (values[ARCHIVE_CLAIMS_KEY]?.entries[request.expected.entryId]?.phase === 'assigned') throw new Error('Consume interrupted'); };
        await assert.rejects(f.archive.reopen(request), { code: 'REOPEN_PARTIAL' });
        assert.equal(f.local[ARCHIVE_CLAIMS_KEY].entries[request.expected.entryId].phase, phase);
        f.hooks.persist = null; f.hooks.afterSet = null;
        const tab = f.tabs.find(tab => tab.id === 100);
        if (change === 'completed-navigation') tab.url = 'https://unrelated.test/';
        if (change === 'pending-navigation') tab.pendingUrl = 'https://unrelated.test/';
        if (change === 'loading') tab.status = 'loading';
        const before = clone(f.tabs), effects = f.effects.length;
        const archive = worker === 'same' ? f.archive : new ArchiveStore(f.store);
        await assert.rejects(archive.reopen({ ...request, requestId: 'retry' }), { code: 'REOPEN_PARTIAL' });
        assert.equal(f.local.archivedTabs.length, 1); assert.equal(f.creates().length, 1);
        assert.deepEqual(f.tabs, before);
        assert.equal(f.effects.slice(effects).some(([kind]) => ['focus-tab', 'focus-window', 'remove', 'create'].includes(kind)), false);
    });
}
function fixture(entries = [original()]) {
    let nextTabId = 100;
    const local = { [ARCHIVE_KEY]: clone(entries), pinnedTabStatesById: {}, todayOrderRepresentation: { version: 1, inverted: false } }, session = {}, hooks = {}, effects = [], listeners = [];
    const nodes = [{ id: 'root', title: 'Arcify' }, { id: 'source-folder', title: 'Source', parentId: 'root' }, { id: 'original-folder', title: 'Original', parentId: 'root' }];
    const tabs = [{ id: 1, windowId: 10, active: true, url: 'https://source.test/', title: 'Source' }, { id: 2, windowId: 20, active: true, url: 'https://source.test/' }];
    const area = (data, name) => ({ async get(keys) { await hooks.get?.(keys, name); const names = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys || data); return Object.fromEntries(names.map(key => [key, clone(data[key] ?? keys?.[key])])); },
        async set(values) { await hooks.beforeSet?.(values, name); Object.assign(data, clone(values)); effects.push(['storage', name, clone(values)]); await hooks.afterSet?.(values, name); } });
    const event = () => { const callbacks = new Set(); return { addListener: fn => callbacks.add(fn), removeListener: fn => callbacks.delete(fn), emit: (...args) => [...callbacks].forEach(fn => fn(...args)), callbacks }; };
    globalThis.chrome = {
        runtime: { id: 'arcify', getURL: path => `chrome-extension://arcify/${path}`, onMessage: { addListener(fn) { listeners.push(fn); } } },
        storage: { onChanged: event(), local: area(local, 'local'), session: area(session, 'session'), sync: { async get(defaults) { return typeof defaults === 'object' ? defaults : {}; } } },
        windows: { onRemoved: event(), async get(id) { await hooks.window?.(id); return { id, type: 'normal', ...hooks.windowResult }; },
            async update(id, data) { await hooks.focusWindow?.(); effects.push(['focus-window', id, data]); } },
        bookmarks: { onChanged: event(), onMoved: event(), onRemoved: event(), onCreated: event(), async get(id) { await hooks.bookmark?.(id); return clone(nodes.filter(node => node.id === id)); }, async search() { return clone(nodes.filter(node => node.title === 'Arcify')); } },
        tabs: { ...Object.fromEntries(['onCreated', 'onUpdated', 'onRemoved', 'onAttached', 'onDetached', 'onMoved', 'onReplaced', 'onActivated'].map(name => [name, event()])), async query(query = {}) { await hooks.query?.(query); return clone(tabs.filter(tab => (query.windowId === undefined || query.windowId === tab.windowId) && (query.active === undefined || query.active === tab.active))); },
            async get(id) { await hooks.tab?.(id); const tab = tabs.find(tab => tab.id === id); if (!tab) throw new Error('Closed'); return clone(tab); },
            async create(data) { effects.push(['create', clone(data)]); const tab = { id: nextTabId++, title: 'Restored', status: 'complete', pinned: false, incognito: false, splitViewId: -1, ...data }; tabs.push(tab);
                if (!hooks.manualCreateEvents) {
                    chrome.tabs.onCreated.emit({ ...clone(tab), url: '', pendingUrl: data.url, status: 'loading' });
                    chrome.tabs.onUpdated.emit(tab.id, { status: 'loading', url: data.url });
                    chrome.tabs.onUpdated.emit(tab.id, { status: 'complete' });
                }
                await hooks.create?.(tab); return clone(tab); },
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

for (const boundary of ['consume', 'display-persist']) test(`resumed claim navigation during ${boundary} never focuses unrelated destination`, async () => {
    const f = fixture(), request = await f.prepare();
    f.hooks.persist = () => { throw new Error('Assignment interrupted'); };
    await assert.rejects(f.archive.reopen(request), { code: 'REOPEN_PARTIAL' });
    f.hooks.persist = null;
    const navigate = () => { f.tabs.find(tab => tab.id === 100).url = 'https://unrelated.test/'; };
    if (boundary === 'consume') f.hooks.afterSet = values => { if (values[ARCHIVE_CLAIMS_KEY]?.entries[request.expected.entryId]?.phase === 'consumed') navigate(); };
    else f.hooks.afterPersist = () => { if (f.local.archivedTabs.length === 0) navigate(); };
    const result = await new ArchiveStore(f.store).reopen({ ...request, requestId: 'retry' });
    assert.equal(result.status, 'partial'); assert.equal(result.consumed, true);
    assert.equal(f.effects.some(([kind]) => kind === 'focus-tab' || kind === 'focus-window'), false);
    assert.equal(f.creates().length, 1);
});

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
for (const automatic of [false, true]) for (const timing of ['initial', 'before-write', 'after-write']) {
    for (const change of ['pending', 'committed']) test(`${automatic ? 'automatic' : 'manual'} archive rejects ${change} navigation ${timing}`, async () => {
        const f = fixture([]); f.tabs[0].active = false;
        const request = { tabId: 1, windowId: 10, spaceId: 'source', bookmarkFolderId: 'source-folder', url: f.tabs[0].url };
        const destination = 'https://saved.test/important';
        const navigate = () => { f.tabs[0][change === 'pending' ? 'pendingUrl' : 'url'] = destination; };
        if (timing === 'initial') navigate();
        if (timing === 'before-write') f.hooks.get = keys => { if (keys === ARCHIVE_KEY) navigate(); };
        if (timing === 'after-write') f.hooks.afterSet = values => { if (values[ARCHIVE_KEY]) navigate(); };
        const options = { automatic, protectedUrlKeys: new Set([Utils.getPinnedUrlKey(destination)]) };
        await assert.rejects(f.archive.archive(request, options), { code: 'STALE_ARCHIVE' });
        assert(f.tabs.some(tab => tab.id === 1), 'Changed native tab is preserved.');
        assert.equal(f.effects.some(([kind]) => kind === 'remove'), false);
        assert.equal(f.local[ARCHIVE_KEY].length, timing === 'after-write' ? 1 : 0);
        if (timing === 'after-write') {
            assert.equal(f.local[ARCHIVE_KEY][0].url, request.url, 'Already committed archive record remains recoverable.');
            await assert.rejects(f.archive.archive(request, options), { code: 'STALE_ARCHIVE' });
            assert.equal(f.local[ARCHIVE_KEY].length, 1, 'Rejected retries cannot duplicate the record.');
        }
    });
}
for (const automatic of [false, true]) test(`${automatic ? 'automatic' : 'manual'} archive permits same-destination pending navigation once`, async () => {
    const f = fixture([]); f.tabs[0].active = false; f.tabs[0].pendingUrl = f.tabs[0].url;
    const request = { tabId: 1, windowId: 10, spaceId: 'source', bookmarkFolderId: 'source-folder', url: f.tabs[0].url };
    const result = await f.archive.archive(request, { automatic });
    assert.equal(result.archived, true); assert.equal(f.local[ARCHIVE_KEY].length, 1);
    assert.deepEqual(f.effects.filter(([kind]) => kind === 'remove'), [['remove', 1]]);
});
test('automatic archive protects a same-destination pending saved URL', async () => {
    const f = fixture([]); f.tabs[0].active = false; f.tabs[0].pendingUrl = f.tabs[0].url;
    await assert.rejects(f.archive.archive({ tabId: 1, windowId: 10, spaceId: 'source', bookmarkFolderId: 'source-folder', url: f.tabs[0].url },
        { automatic: true, protectedUrlKeys: new Set([Utils.getPinnedUrlKey(f.tabs[0].pendingUrl)]) }), { code: 'STALE_ARCHIVE' });
    assert.equal(f.local[ARCHIVE_KEY].length, 0); assert.equal(f.effects.some(([kind]) => kind === 'remove'), false);
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

// Use the real client, registered sender guard/schema, queue and archive writer.
// Only the native browser APIs and its sender metadata are fixture inputs.
function connectArchiveClient(t, f, options = {}) {
    const { document = true, sender } = options;
    const tab = Object.hasOwn(options, 'tab') ? options.tab : { id: 90, windowId: 10 };
    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    if (document) Object.defineProperty(globalThis, 'document', { configurable: true, value: {} });
    else delete globalThis.document;
    t.after(() => {
        if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
        else delete globalThis.document;
    });
    const state = { tab, sender: sender || { id: 'arcify', url: 'chrome-extension://arcify/options.html',
        origin: 'chrome-extension://arcify', tab: { id: 90, windowId: 10 } }, messages: [], lookups: 0, focusedLookups: 0 };
    chrome.tabs.getCurrent = async () => { state.lookups++; return clone(state.tab); };
    chrome.windows.getCurrent = async () => { state.focusedLookups++; return { id: 20, type: 'normal' }; };
    registerArchiveMessages(f.store);
    chrome.runtime.sendMessage = message => {
        state.messages.push(clone(message));
        return new Promise(resolve => f.listeners[0](message, clone(state.sender), resolve));
    };
    return state;
}

for (const caller of ['extension-tab', 'native-sidebar', 'background']) test(`global Utils client operations reach the registered writer from ${caller}`, async t => {
    const entry = original({ entryId: 'one' }), f = fixture([entry]);
    const c = connectArchiveClient(t, f, caller === 'extension-tab' ? {} : { document: caller !== 'background', tab: undefined,
        sender: { id: 'arcify', url: `chrome-extension://arcify/${caller === 'native-sidebar' ? 'sidebar.html' : 'background.js'}`, origin: 'chrome-extension://arcify' } });
    if (caller === 'background') delete chrome.tabs.getCurrent;
    assert.deepEqual(await Utils.getArchivedTabs(), [entry]);
    const added = await Utils.addArchivedTab(original({ url: 'https://second.test/' }));
    assert.equal(added.added, true);
    const before = await Utils.getArchivedTabs(), replacement = [...before].reverse();
    assert.deepEqual(await Utils.saveArchivedTabs(replacement, before), replacement);
    assert.deepEqual(await Utils.removeArchivedTab(added.entry), { entryId: added.entry.entryId });
    assert.deepEqual(f.local.archivedTabs, [entry]);
    assert.deepEqual(c.messages.map(message => message.action), ['list', 'add', 'list', 'replace', 'remove']);
    assert(c.messages.every(message => caller === 'extension-tab' ? message.windowId === 10 : !Object.hasOwn(message, 'windowId')));
    assert.equal(c.lookups, caller === 'background' ? 0 : 5); assert.equal(c.focusedLookups, 0);
});

const globalPayload = (action, entry) => action === 'add' ? { entry: original({ url: 'https://added.test/' }) }
    : action === 'replace' ? { entries: [], expected: [entry] } : action === 'remove' ? { expected: entry } : {};
for (const action of ['list', 'add', 'replace', 'remove']) {
    test(`${action} rejects a tab sender's missing/mismatched window and unknown fields before mutation`, async t => {
        const entry = original({ entryId: 'one' }), f = fixture([entry]), c = connectArchiveClient(t, f);
        for (const payload of [{}, { windowId: 20 }, { windowId: 10, surprise: true }]) {
            const response = await chrome.runtime.sendMessage({ type: 'archiveStore', action, ...globalPayload(action, entry), ...payload });
            assert.equal(response.code, payload.surprise ? 'INVALID_REQUEST' : 'UNAUTHORIZED');
        }
        await assert.rejects(archiveRequest(action, { ...globalPayload(action, entry), windowId: 20 }), { code: 'UNAUTHORIZED' });
        assert.equal(c.messages.at(-1).windowId, 20, 'Explicit stale metadata is rejected, never repaired from the current tab.');
        c.tab.windowId = 20; // The tab moved between native lookup and browser-authenticated dispatch.
        await assert.rejects(archiveRequest(action, globalPayload(action, entry)), { code: 'UNAUTHORIZED' });
        assert.equal(c.messages.at(-1).windowId, 20); assert.equal(c.focusedLookups, 0);
        assert.deepEqual(f.local.archivedTabs, [entry]); assert.deepEqual(f.effects, []);
    });

    test(`${action} validates optional global window metadata even without a tab sender`, async t => {
        const entry = original({ entryId: 'one' }), f = fixture([entry]);
        const c = connectArchiveClient(t, f, { document: false, sender: { id: 'arcify' } });
        for (const windowId of [undefined, null, false, '10', 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, {}, []]) {
            await assert.rejects(archiveRequest(action, { ...globalPayload(action, entry), windowId }), { code: 'INVALID_REQUEST' });
        }
        c.sender.tab = { id: 90, windowId: 10 };
        for (const windowId of [undefined, null, false, '10', 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, {}, []]) {
            await assert.rejects(archiveRequest(action, { ...globalPayload(action, entry), windowId }), { code: 'UNAUTHORIZED' });
        }
        assert.equal(c.lookups, 0); assert.deepEqual(f.local.archivedTabs, [entry]); assert.deepEqual(f.effects, []);
    });
}

test('a pending caller-window lookup cannot mutate and its later failure cancels the request', async t => {
    const entry = original(), f = fixture([entry]), c = connectArchiveClient(t, f);
    let rejectLookup;
    chrome.tabs.getCurrent = () => new Promise((_resolve, reject) => { rejectLookup = reject; });
    const pending = archiveRequest('remove', { expected: entry });
    await Promise.resolve();
    assert.deepEqual(c.messages, []); assert.deepEqual(f.effects, []);
    rejectLookup(new Error('Caller document closed'));
    await assert.rejects(pending, /Caller document closed/);
    assert.deepEqual(c.messages, []); assert.deepEqual(f.effects, []); assert.deepEqual(f.local.archivedTabs, [entry]);
    assert.equal(c.focusedLookups, 0);
});

for (const failure of ['missing-tabs', 'missing-api', 'throws', 'rejects', 'null', 'empty', 'missing-window', 'missing-id', 'invalid-id', 'string-window', 'negative-window', 'fraction-window', 'unsafe-window']) {
    test(`document caller ${failure} lookup cancels every global request without a send or mutation`, async t => {
        const entry = original(), f = fixture([entry]), c = connectArchiveClient(t, f);
        if (failure === 'missing-tabs') delete chrome.tabs;
        if (failure === 'missing-api') delete chrome.tabs.getCurrent;
        if (failure === 'throws') chrome.tabs.getCurrent = () => { throw new Error('Lookup unavailable'); };
        if (failure === 'rejects') chrome.tabs.getCurrent = async () => { throw new Error('Lookup unavailable'); };
        const malformed = { null: null, empty: {}, 'missing-window': { id: 90 }, 'missing-id': { windowId: 10 },
            'invalid-id': { id: -1, windowId: 10 }, 'string-window': { id: 90, windowId: '10' },
            'negative-window': { id: 90, windowId: -1 }, 'fraction-window': { id: 90, windowId: 1.5 },
            'unsafe-window': { id: 90, windowId: Number.MAX_SAFE_INTEGER + 1 } };
        if (Object.hasOwn(malformed, failure)) c.tab = malformed[failure];
        for (const action of ['list', 'add', 'replace', 'remove']) await assert.rejects(archiveRequest(action, globalPayload(action, entry)));
        assert.deepEqual(c.messages, []); assert.deepEqual(f.effects, []); assert.deepEqual(f.local.archivedTabs, [entry]);
        assert.equal(c.focusedLookups, 0);
    });
}

test('native sidebar absent tab is allowed, but a tab-bearing sender cannot use that result to bypass its window guard', async t => {
    const entry = original(), f = fixture([entry]), c = connectArchiveClient(t, f); c.tab = undefined;
    for (const action of ['list', 'add', 'replace', 'remove']) await assert.rejects(archiveRequest(action, globalPayload(action, entry)), { code: 'UNAUTHORIZED' });
    assert(c.messages.every(message => !Object.hasOwn(message, 'windowId')));
    assert.deepEqual(f.effects, []); assert.deepEqual(f.local.archivedTabs, [entry]); assert.equal(c.focusedLookups, 0);
});

for (const action of ['view', 'archive', 'reopen']) test(`${action} retains its exact requested window without caller lookup or fallback`, async t => {
    const f = fixture([original({ entryId: 'one' })]), c = connectArchiveClient(t, f);
    chrome.tabs.getCurrent = async () => { throw new Error('Explicit scoped requests must not look up a replacement window.'); };
    const prepared = await f.prepare(), before = clone(f.local.archivedTabs); f.effects.length = 0;
    const payload = action === 'reopen' ? prepared : action === 'archive'
        ? { tabId: 1, windowId: 10, spaceId: 'source', bookmarkFolderId: 'source-folder', url: f.tabs[0].url } : { windowId: 10 };
    for (const windowId of [20, undefined]) {
        await assert.rejects(archiveRequest(action, { ...payload, windowId }), { code: 'UNAUTHORIZED' });
        assert.equal(c.messages.at(-1).windowId, windowId);
    }
    assert.deepEqual(f.local.archivedTabs, before); assert.deepEqual(f.effects, []); assert.equal(c.focusedLookups, 0);
    const result = await archiveRequest(action, payload);
    assert.equal(c.messages.at(-1).windowId, 10);
    if (action === 'view') assert.equal(result.context.windowId, 10);
    if (action === 'archive') assert.equal(result.archived, true);
    if (action === 'reopen') { assert.equal(result.consumed, true); assert.equal(f.creates()[0][1].windowId, 10); }
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

function postCreateUpdateFixture(update, { source = false, mutate } = {}) {
    const f = fixture(), listeners = new Set();
    chrome.tabs.onUpdated = { addListener: listener => listeners.add(listener), removeListener: listener => listeners.delete(listener), emit: (...args) => [...listeners].forEach(listener => listener(...args)) };
    let fired = false;
    f.hooks.get = () => {
        const claim = Object.values(f.local[ARCHIVE_CLAIMS_KEY]?.entries || {}).find(item => item.phase === 'created');
        if (!claim || !listeners.size || fired) return;
        fired = true;
        const tabId = source ? 1 : claim.tabId, tab = f.tabs.find(item => item.id === tabId);
        mutate?.(f, tab);
        for (const listener of listeners) listener(tabId, clone(update), clone(tab));
    };
    return { ...f, listeners, fired: () => fired };
}

for (const update of [{ status: 'complete' }, { title: 'Loaded archived page' }, { favIconUrl: 'https://archive.test/icon.png' },
    { status: 'complete', title: 'Loaded archived page', favIconUrl: 'https://archive.test/icon.png' }]) {
    test(`known created target ${JSON.stringify(update)} does not invalidate exact reopen or require another create`, async () => {
        const f = postCreateUpdateFixture(update), request = await f.prepare(), result = await f.archive.reopen(request);
        assert.equal(f.fired(), true); assert.equal(result.status, 'reopened'); assert.equal(result.consumed, true);
        assert.equal(result.tabId, 100); assert.equal(f.creates().length, 1); assert.deepEqual(f.local.archivedTabs, []);
        assert.deepEqual(f.local.spaces.find(space => space.id === 'original').temporaryTabs, [100]);
        assert.equal(f.local[ARCHIVE_CLAIMS_KEY].entries[request.expected.entryId].phase, 'consumed');
        assert.equal(f.tabs.find(tab => tab.id === 100).active, true); assert.equal(f.store.active[10], 'original');
        assert.equal(f.store.active[20], 'source'); assert.equal(f.listeners.size, 0);
    });
    test(`source ${JSON.stringify(update)} remains conservatively fenced during reopen`, async () => {
        const f = postCreateUpdateFixture(update, { source: true }), request = await f.prepare();
        await assert.rejects(f.archive.reopen(request), { code: 'REOPEN_PARTIAL' });
        assert.equal(f.fired(), true); assert.equal(f.creates().length, 1); assert.equal(f.local.archivedTabs.length, 1);
        assert.equal(f.local[ARCHIVE_CLAIMS_KEY].entries[request.expected.entryId].phase, 'created');
        assert.deepEqual(f.local.spaces.find(space => space.id === 'original').temporaryTabs, []);
        assert(!f.effects.some(([kind]) => kind === 'focus-tab')); assert.equal(f.listeners.size, 0);
    });
}
for (const update of [{ status: 'loading' }, { status: 'unknown' }, { url: 'https://temporary.test/' }, { pendingUrl: 'https://temporary.test/' },
    { status: 'complete', url: 'https://temporary.test/' }, { title: 'Changed', pinned: true }, { groupId: 4 }, { splitViewId: 8 },
    { discarded: true }, { unknownFutureField: true }, { title: null }, { favIconUrl: 4 }, {}, null, []]) {
    test(`known created target ${JSON.stringify(update)} still invalidates the read boundary without consume or retry`, async () => {
        const f = postCreateUpdateFixture(update), request = await f.prepare();
        // Event-only transient changes must reject even when final native state matches.
        await assert.rejects(f.archive.reopen(request), { code: 'REOPEN_PARTIAL' });
        assert.equal(f.fired(), true); assert.equal(f.creates().length, 1); assert.equal(f.local.archivedTabs.length, 1);
        assert.equal(f.local[ARCHIVE_CLAIMS_KEY].entries[request.expected.entryId].phase, 'created');
        assert.deepEqual(f.local.spaces.find(space => space.id === 'original').temporaryTabs, []);
        assert(!f.effects.some(([kind]) => kind === 'focus-tab')); assert.equal(f.listeners.size, 0);
    });
}
test('presentation-only created-target event cannot hide a changed native snapshot', async () => {
    const f = postCreateUpdateFixture({ title: 'Loaded archived page' }, { mutate: (_f, tab) => { tab.pinned = true; } });
    const request = await f.prepare(); await assert.rejects(f.archive.reopen(request), { code: 'REOPEN_PARTIAL' });
    assert.equal(f.creates().length, 1); assert.equal(f.local.archivedTabs.length, 1);
    assert.equal(f.local[ARCHIVE_CLAIMS_KEY].entries[request.expected.entryId].phase, 'created');
    assert(!f.effects.some(([kind]) => kind === 'focus-tab')); assert.equal(f.listeners.size, 0);
});

// Shape captured in hosted attempt3: onCreated(empty/exact pending URL), then
// loading+exact URL, title, complete. The native ID remains Chrome's create ID.
function freshLoadingFixture(at = 'create') {
    const f = fixture(); f.hooks.manualCreateEvents = true;
    let native, completed = false;
    const complete = () => {
        if (completed) return; completed = true;
        Object.assign(native, { url: original().url, status: 'loading' }); delete native.pendingUrl;
        chrome.tabs.onUpdated.emit(native.id, { status: 'loading', url: native.url }, clone(native));
        native.title = 'Loaded archived page'; chrome.tabs.onUpdated.emit(native.id, { title: native.title }, clone(native));
        native.status = 'complete'; chrome.tabs.onUpdated.emit(native.id, { status: 'complete' }, clone(native));
    };
    f.hooks.create = tab => {
        native = tab; Object.assign(tab, { url: '', pendingUrl: original().url, status: 'loading' });
        chrome.tabs.onCreated.emit(clone(tab));
        if (at === 'create') complete();
    };
    f.hooks.beforeSet = values => { if (at === 'before-created-receipt' && values.archiveReopenClaims?.entries?.[Object.keys(values.archiveReopenClaims.entries)[0]]?.phase === 'created') complete(); };
    f.hooks.afterSet = values => {
        if (Object.values(values.archiveReopenClaims?.entries || {}).some(claim => claim.phase === 'created')) {
            if (at === 'after-created-receipt') complete();
            if (at === 'load-wait') setImmediate(complete);
        }
    };
    return { ...f, complete, native: () => native };
}
for (const at of ['create', 'before-created-receipt', 'after-created-receipt', 'load-wait']) test(`captured fresh-create loading sequence settles once during ${at} before strict assignment`, async () => {
    const f = freshLoadingFixture(at), request = await f.prepare(), result = await f.archive.reopen(request);
    assert.equal(result.consumed, true); assert.equal(result.status, 'reopened'); assert.equal(result.tabId, 100);
    assert.equal(f.creates().length, 1); assert.equal(f.local.archivedTabs.length, 0);
    assert.deepEqual(f.local.spaces.find(space => space.id === 'original').temporaryTabs, [100]);
    assert.equal(f.local.archiveReopenClaims.entries[request.expected.entryId].phase, 'consumed');
    for (const value of Object.values(chrome.tabs)) if (value?.callbacks) assert.equal(value.callbacks.size, 0);
});

function injectFreshBoundary(f, boundary, mutate) {
    let fired = false;
    const inject = () => { if (!fired) { fired = true; mutate(); } };
    const phase = () => Object.values(f.local.archiveReopenClaims?.entries || {})[0]?.phase;
    if (boundary === 'create') { const previous = f.hooks.create; f.hooks.create = async tab => { await previous?.(tab); inject(); }; }
    else if (['before-created-receipt', 'after-created-receipt', 'before-assigned-receipt', 'after-assigned-receipt', 'before-consume', 'after-consume'].includes(boundary)) {
        const hook = boundary.startsWith('before-') ? 'beforeSet' : 'afterSet', previous = f.hooks[hook];
        const expected = boundary.includes('created') ? 'created' : boundary.includes('assigned') ? 'assigned' : 'consumed';
        f.hooks[hook] = async values => { await previous?.(values); if (Object.values(values.archiveReopenClaims?.entries || {}).some(claim => claim.phase === expected)) inject(); };
    } else if (boundary === 'placement-read') {
        const previous = f.store.readTodayPlacement.bind(f.store); f.store.readTodayPlacement = async () => { await previous(); inject(); };
    } else if (boundary === 'first-target-read') f.hooks.get = () => { if (phase() === 'created' && chrome.tabs.onUpdated.callbacks.size > 1) inject(); };
    else if (boundary === 'first-final-native-read') f.hooks.query = query => { if (phase() === 'created' && !Object.keys(query).length) inject(); };
    else if (boundary === 'between-target-and-persist') f.hooks.persist = inject;
    else if (boundary === 'before-consume-read') f.hooks.get = () => { if (phase() === 'assigned') inject(); };
    else if (boundary === 'after-final-target-read') {
        const previous = f.archive.targetUnlocked.bind(f.archive); f.archive.targetUnlocked = async (...args) => {
            const result = await previous(...args); if (phase() === 'assigned' && args[2]?.assigned) inject(); return result;
        };
    }
    else if (boundary === 'post-consume-native-read') f.hooks.tab = () => { if (phase() === 'consumed') inject(); };
    else throw new Error(`Unknown injection ${boundary}`);
    return () => fired;
}
const freshBoundaries = ['create', 'before-created-receipt', 'after-created-receipt', 'placement-read', 'first-target-read', 'first-final-native-read',
    'between-target-and-persist', 'before-assigned-receipt', 'after-assigned-receipt', 'before-consume-read', 'after-final-target-read', 'before-consume', 'after-consume', 'post-consume-native-read'];
for (const boundary of freshBoundaries) for (const mutation of ['source', 'target-repeat', ...(['create', 'before-created-receipt', 'after-created-receipt', 'placement-read', 'first-target-read', 'first-final-native-read'].includes(boundary) ? ['pairing'] : [])]) test(`fresh-create ${mutation} change stays rejected across ${boundary}, even after state returns`, async () => {
    const f = freshLoadingFixture(), request = await f.prepare();
    const fired = injectFreshBoundary(f, boundary, () => {
        if (mutation === 'source') chrome.tabs.onUpdated.emit(1, { title: 'Transient source change' });
        else if (mutation === 'target-repeat') chrome.tabs.onUpdated.emit(100, { status: 'loading', url: request.expected.url });
        else {
            chrome.storage.onChanged.emit({ arcifyBridgePairingGeneration: { oldValue: 'original', newValue: 'changed' } }, 'local');
            chrome.storage.onChanged.emit({ arcifyBridgePairingGeneration: { oldValue: 'changed', newValue: 'original' } }, 'local');
        }
    });
    const consumed = ['before-consume', 'after-consume', 'post-consume-native-read'].includes(boundary);
    if (consumed) { const result = await f.archive.reopen(request); assert.equal(result.consumed, true); assert.equal(result.status, 'partial'); }
    else await assert.rejects(f.archive.reopen(request), { code: 'REOPEN_PARTIAL' });
    assert.equal(fired(), true); assert.equal(f.creates().length, 1);
    assert.equal(f.local.archivedTabs.length, consumed ? 0 : 1);
    assert(!f.effects.some(([kind]) => kind === 'focus-tab' || kind === 'focus-window'));
    assert.equal(f.tabs[0].active, true); assert.equal(f.local.activeSpaces, undefined); assert.equal(f.store.active[10], 'source');
    for (const value of Object.values(chrome.tabs)) if (value?.callbacks) assert.equal(value.callbacks.size, 0);
});
for (const boundary of ['create', 'created']) test(`initial load timeout during ${boundary} preserves the known created receipt without retry`, async t => {
    let timeout;
    t.mock.method(globalThis, 'setTimeout', callback => { timeout = callback; return 12345; });
    t.mock.method(globalThis, 'clearTimeout', () => {});
    const f = freshLoadingFixture('never'), request = await f.prepare();
    if (boundary === 'create') { const previous = f.hooks.create; f.hooks.create = tab => { previous(tab); timeout(); }; }
    else f.hooks.afterSet = values => { if (Object.values(values.archiveReopenClaims?.entries || {}).some(claim => claim.phase === 'created')) timeout(); };
    await assert.rejects(f.archive.reopen(request), error => error.code === 'REOPEN_PARTIAL' && /initial load/.test(error.message));
    assert.equal(f.creates().length, 1); assert.equal(f.local.archivedTabs.length, 1);
    const claim = f.local.archiveReopenClaims.entries[request.expected.entryId]; assert.equal(claim.phase, 'created'); assert.equal(claim.tabId, 100);
    assert.deepEqual(f.local.spaces[1].temporaryTabs, []); assert.equal(f.store.active[10], 'source');
    for (const value of Object.values(chrome.tabs)) if (value?.callbacks) assert.equal(value.callbacks.size, 0);
});
for (const failure of ['create-rejection', 'missing-returned-id', 'created-receipt-write']) test(`fresh observation cleans up after ${failure} without replaying native creation`, async () => {
    const f = freshLoadingFixture(), request = await f.prepare();
    const previous = f.hooks.create;
    if (failure !== 'created-receipt-write') f.hooks.create = async tab => { await previous(tab); if (failure === 'create-rejection') throw new Error('Lost create response'); delete tab.id; };
    else f.hooks.beforeSet = values => { if (Object.values(values.archiveReopenClaims?.entries || {}).some(claim => claim.phase === 'created')) throw new Error('Lost created receipt'); };
    await assert.rejects(f.archive.reopen(request), { code: 'UNCERTAIN_RESULT' });
    assert.equal(f.creates().length, 1); assert.equal(f.local.archivedTabs.length, 1);
    for (const area of ['tabs', 'windows', 'bookmarks', 'storage']) for (const value of Object.values(chrome[area])) if (value?.callbacks) assert.equal(value.callbacks.size, 0);
});
for (const worker of ['same-worker', 'new-worker']) test(`an explicit ${worker} resumed known-ID claim cannot regain the fresh initial-load allowance or create again`, async t => {
    const f = freshLoadingFixture(), request = await f.prepare();
    f.hooks.persist = () => { throw new Error('Known create, assignment failed'); };
    await assert.rejects(f.archive.reopen(request), { code: 'REOPEN_PARTIAL' });
    f.hooks.persist = null;
    if (worker === 'new-worker') f.store.archiveStore = new ArchiveStore(f.store);
    let timers = 0;
    t.mock.method(globalThis, 'setTimeout', () => { timers++; throw new Error('A resumed claim must not install fresh-load settlement'); });
    f.hooks.query = () => chrome.tabs.onUpdated.emit(100, { status: 'loading', url: request.expected.url });
    await assert.rejects(f.store.archiveStore.reopen({ ...request, requestId: 'explicit-resume-with-navigation' }), { code: 'REOPEN_PARTIAL' });
    assert.equal(timers, 0); assert.equal(f.creates().length, 1); assert.equal(f.local.archivedTabs.length, 1);
    assert.equal(f.local.archiveReopenClaims.entries[request.expected.entryId].phase, 'created');
});
