import { describeTodayMoveOutcome } from '../../today-space-move-ui.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { moveTodayTabsToSpace, registerTodayMoveMessages } from '../../today-move-store.js';
import { SpaceStore } from '../../space-store.js';
import { syncSpaceGroups } from '../../tab-group-sync.js';
import { createSpaceRankCheckpoint, readSpaceRankCheckpoint } from '../../space-continuity.js';

const space = (id, temporaryTabs, spaceBookmarks = []) => ({ id, name: id, color: 'blue', bookmarkFolderId: `${id}-root`, temporaryTabs, spaceBookmarks });
function fixture({ inverted = false, bookmarkInverted = inverted, syncGroups = false } = {}) {
    const tabs = [1, 2, 3, 4, 5, 6, 9, 10].map((id, index) => ({ id, index, windowId: id >= 9 ? 20 : 10,
        url: 'https://same.test/', title: `Tab ${id}`, pinned: false, active: id === 1 || id === 9, groupId: -1, splitViewId: -1 }));
    const local = { todayOrderRepresentation: { version: 1, inverted }, spaces: [space('source', [1, 2, 3, 9], [6]), space('target', [4, 10, 5])],
        pinnedTabStatesById: { 6: { bookmarkId: 'pin', pinnedUrl: 'https://same.test/' } }, tabNameOverridesById: { 2: { name: 'Named' } },
        spaceModelVersion: 2, favoriteData: ['untouched'] };
    const session = { spaceSession: true, activeSpaces: { 10: 'source', 20: 'source' }, spaceGroupProjection: {} };
    const sync = { invertTabOrder: bookmarkInverted, syncTabGroups: syncGroups }, effects = [], hooks = {}, listeners = [], globals = new Set();
    const nodes = [{ id: 'arcify', title: 'Arcify', parentId: 'bar' }, { id: 'source-root', parentId: 'arcify', title: 'source' },
        { id: 'target-root', parentId: 'arcify', title: 'target' }, { id: 'pin', parentId: 'source-root', title: 'Pin', url: 'https://same.test/' }];
    const groups = [];
    const area = (name, data) => ({ async get(keys) {
        await hooks.get?.(name, keys);
        const names = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys || data);
        return Object.fromEntries(names.map(key => [key, structuredClone(data[key] ?? keys?.[key])]));
    }, async set(update) {
        await hooks.beforeSet?.(name, update);
        Object.assign(data, structuredClone(update)); effects.push([name, structuredClone(update)]);
        await hooks.afterSet?.(name, update);
    } });
    globalThis.chrome = {
        runtime: { id: 'test', getURL: path => `chrome-extension://test/${path}`, onMessage: { addListener: fn => listeners.push(fn) } },
        storage: { local: area('local', local), session: area('session', session), sync: area('sync', sync) },
        windows: { async get(id) { await hooks.window?.(); return { id, type: 'normal', incognito: false, ...hooks.windowAttrs }; },
            update: () => assert.fail('Must not focus a window'), create: () => assert.fail('Must not create a window') },
        tabs: { async query(filter = {}) {
            await hooks.query?.(filter);
            return structuredClone(tabs.filter(tab => (filter.windowId === undefined || tab.windowId === filter.windowId) &&
                (filter.groupId === undefined || tab.groupId === filter.groupId)));
        }, create: () => assert.fail('Must not create tabs'), remove: () => assert.fail('Must not close tabs'),
            update: () => assert.fail('Must not navigate or activate tabs'),
            async group({ tabIds, groupId, createProperties }) {
                effects.push(['group', { tabIds: [...tabIds], groupId, createProperties }]);
                if (groupId === undefined) { groupId = Math.max(99, ...groups.map(group => group.id)) + 1; groups.push({ id: groupId, windowId: createProperties.windowId, collapsed: false }); }
                if (groups.find(group => group.id === groupId)?.collapsed && tabs.some(tab => tabIds.includes(tab.id) && tab.active)) assert.fail('Never add active tab to collapsed group');
                for (const tab of tabs) if (tabIds.includes(tab.id)) tab.groupId = groupId;
                return groupId;
            }, async move(ids, options) { effects.push(['move', ids, options]); }, async ungroup() { assert.fail('No Favorites should be touched'); } },
        tabGroups: { async query() { return structuredClone(groups); },
            async update(id, attrs) {
                effects.push(['groupUpdate', id, attrs]);
                if (attrs.collapsed && tabs.some(tab => tab.groupId === id && tab.active)) assert.fail('Must not collapse an active native tab');
                Object.assign(groups.find(group => group.id === id), attrs);
            }, async move(id, options) { effects.push(['groupMove', id, options]); } },
        bookmarks: { async get(id) { await hooks.bookmark?.(id); return structuredClone(nodes.filter(node => node.id === id)); },
            async search() { return structuredClone(nodes.filter(node => node.title === 'Arcify')); },
            create: () => assert.fail('Must not save or move bookmarks'), move: () => assert.fail('Must not relocate saved pins'),
            remove: () => assert.fail('Must not remove bookmarks') }
    };
    const store = new SpaceStore(); store.initialized = true;
    Object.assign(store, { spaces: structuredClone(local.spaces), active: structuredClone(session.activeSpaces), liveTabs: new Map(tabs.map(tab => [tab.id, tab])),
        snapshotByTab: new Map(), provisional: new Set(), recoveryCandidates: new Set(), savedWindows: [], windowKeys: new Map(), restoreWindowKeys: new Map(),
        restoredMetadata: [], restoredRanks: new Map([[1, 8], [2, 9], [4, 0], [5, 1]]), restoreQueue: [] });
    store.isGlobalTab = value => globals.has(typeof value === 'object' ? value.id : value);
    const request = { type: 'moveTodayTabsToSpace', windowId: 10, spaceId: 'source', bookmarkFolderId: 'source-root',
        destinationSpaceId: 'target', destinationBookmarkFolderId: 'target-root', inverted,
        entries: (inverted ? [3, 1] : [1, 3]).map(tabId => ({ tabId, url: 'https://same.test/' })) };
    return { tabs, local, session, sync, effects, hooks, listeners, globals, nodes, groups, store, request,
        move: () => moveTodayTabsToSpace(store, request) };
}
const writes = f => f.effects.filter(([area, value]) => area === 'local' && value.spaces);
const owner = (spaces, id) => spaces.find(space => space.temporaryTabs.includes(id));

for (const inverted of [false, true]) test(`bulk move preserves exact IDs, native activity and destination visible order (inverted=${inverted})`, async () => {
    const f = fixture({ inverted }), beforeTabs = structuredClone(f.tabs), beforeNodes = structuredClone(f.nodes);
    const result = await f.move();
    assert.deepEqual(result, { total: 2, completed: inverted ? [3, 1] : [1, 3], remaining: [], uncertain: false, destinationSpaceId: 'target' });
    assert.deepEqual(f.store.spaces[0].temporaryTabs, [2, 9]);
    assert.deepEqual(f.store.spaces[1].temporaryTabs, inverted ? [1, 3, 4, 10, 5] : [4, 10, 5, 1, 3]);
    const display = f.store.spaces[1].temporaryTabs.filter(id => id < 9); if (inverted) display.reverse();
    assert.deepEqual(display, inverted ? [5, 4, 3, 1] : [4, 5, 1, 3]);
    assert.deepEqual(f.tabs, beforeTabs); assert.deepEqual(f.nodes, beforeNodes);
    assert.deepEqual(f.local.pinnedTabStatesById, { 6: { bookmarkId: 'pin', pinnedUrl: 'https://same.test/' } });
    assert.deepEqual(f.local.tabNameOverridesById, { 2: { name: 'Named' } });
    assert.deepEqual(f.store.active, { 10: 'source', 20: 'source' }); assert.deepEqual(f.session.activeSpaces, f.store.active);
    assert.deepEqual(f.store.spaces[0].spaceBookmarks, [6]); assert.equal(writes(f).length, 1);
    assert.deepEqual(f.local.spaceTabSnapshot.filter(record => [1, 3].includes(record.tabId)).map(record => [record.tabId, record.spaceId, record.section]),
        [[1, 'target', 'temporaryTabs'], [3, 'target', 'temporaryTabs']]);
    assert.equal(f.local.favoriteData[0], 'untouched');
});

test('single-tab move and an empty destination work without creating or focusing anything', async () => {
    const f = fixture(); f.request.entries = [f.request.entries[0]]; f.store.spaces[1].temporaryTabs = [];
    assert.deepEqual((await f.move()).completed, [1]); assert.deepEqual(f.store.spaces[1].temporaryTabs, [1]);
});

const invalidations = {
    closed: f => f.tabs.splice(f.tabs.findIndex(tab => tab.id === 3), 1),
    url: f => f.tabs.find(tab => tab.id === 3).url = 'https://changed.test/',
    pendingUrl: f => f.tabs.find(tab => tab.id === 3).pendingUrl = 'https://changed.test/',
    window: f => f.tabs.find(tab => tab.id === 3).windowId = 20,
    nativePin: f => f.tabs.find(tab => tab.id === 3).pinned = true,
    split: f => f.tabs.find(tab => tab.id === 3).splitViewId = 0,
    privateTab: f => f.tabs.find(tab => tab.id === 3).incognito = true,
    privateWindow: f => f.hooks.windowAttrs = { incognito: true },
    popup: f => f.hooks.windowAttrs = { type: 'popup' },
    favorite: f => f.globals.add(3),
    binding: f => f.local.pinnedTabStatesById[3] = { bookmarkId: 'other' },
    savedPin: f => { f.store.spaces[0].temporaryTabs = [1, 2, 9]; f.store.spaces[0].spaceBookmarks.push(3); },
    duplicateOwner: f => f.store.spaces[1].temporaryTabs.push(3),
    duplicateSource: f => f.store.spaces[0].temporaryTabs.push(3),
    provisional: f => f.store.provisional.add(3),
    unresolvedRestore: f => f.store.recoveryCandidates.add(3),
    wrongOrder: f => f.request.entries.reverse(),
    invertChanged: f => f.local.todayOrderRepresentation.inverted = true,
    activeSpaceChanged: f => f.store.active[10] = 'target',
    missingSource: f => f.store.spaces.shift(),
    missingTarget: f => f.store.spaces.pop(),
    replacedSource: f => f.store.spaces[0].bookmarkFolderId = 'replacement',
    replacedTarget: f => f.store.spaces[1].bookmarkFolderId = 'replacement',
    movedSourceFolder: f => f.nodes.find(node => node.id === 'source-root').parentId = 'bar',
    movedTargetFolder: f => f.nodes.find(node => node.id === 'target-root').parentId = 'bar',
    deletedTargetFolder: f => f.nodes.splice(f.nodes.findIndex(node => node.id === 'target-root'), 1),
    sourceFolderBecameBookmark: f => f.nodes.find(node => node.id === 'source-root').url = 'https://same.test/',
    duplicateSpace: f => f.store.spaces.push(structuredClone(f.store.spaces[1])),
    duplicateFolder: f => f.store.spaces.push(space('third', []) ) && (f.store.spaces.at(-1).bookmarkFolderId = 'target-root')
};
for (const [name, mutate] of Object.entries(invalidations)) test(`preflight rejects ${name} without a membership write`, async () => {
    const f = fixture(); mutate(f); const before = structuredClone(f.store.spaces);
    await assert.rejects(f.move()); assert.equal(writes(f).length, 0); assert.deepEqual(f.store.spaces, before);
});

for (const mutate of [r => r.entries.push(r.entries[0]), r => r.extra = true, r => r.entries[0].extra = true,
    r => r.destinationSpaceId = r.spaceId, r => r.destinationBookmarkFolderId = r.bookmarkFolderId,
    r => r.windowId = -1, r => r.inverted = 'false', r => r.entries = [], r => r.entries[0].url = 'javascript:alert(1)',
    r => r.entries[0].tabId = 0, r => r.entries = Array.from({ length: 101 }, (_, i) => ({ tabId: i + 1, url: 'https://same.test/' }))]) {
    test('malformed or ambiguous request fails without writes', async () => {
        const f = fixture(); mutate(f.request); await assert.rejects(f.move()); assert.equal(f.effects.length, 0);
    });
}

for (const name of ['closed', 'url', 'window', 'nativePin', 'split', 'favorite', 'binding', 'activeSpaceChanged', 'movedTargetFolder', 'invertChanged']) {
    test(`persist boundary revalidates ${name} after its asynchronous reads`, async () => {
        const f = fixture(), before = structuredClone(f.store.spaces);
        let once = true;
        f.hooks.get = async (area, keys) => {
            if (once && area === 'local' && Array.isArray(keys) && keys.includes('tabNameOverridesById')) { once = false; invalidations[name](f); }
        };
        await assert.rejects(f.move(), error => error.batch.completed.length === 0 && !error.batch.uncertain);
        assert.equal(writes(f).length, 0); assert.deepEqual(f.store.spaces, before); assert.equal(f.store.initialized, false);
    });
}

test('rejected write with source readback is not reported as moved and is not retried', async () => {
    const f = fixture(); let attempts = 0;
    f.hooks.beforeSet = async (area, update) => { if (area === 'local' && update.spaces) { attempts++; throw new Error('Quota'); } };
    await assert.rejects(f.move(), error => {
        assert.deepEqual(error.batch.completed, []); assert.deepEqual(error.batch.remaining, [1, 3]); assert.equal(error.batch.uncertain, false); return true;
    });
    assert.equal(attempts, 1); assert.equal(owner(f.store.spaces, 1).id, 'source'); assert.equal(f.store.initialized, false);
});

test('a write that commits then rejects is reported from durable readback without rollback or retry', async () => {
    const f = fixture(); f.hooks.afterSet = async (area, update) => { if (area === 'local' && update.spaces) throw new Error('Acknowledgment lost'); };
    await assert.rejects(f.move(), error => {
        assert.deepEqual(error.batch.completed, [1, 3]); assert.deepEqual(error.batch.remaining, []); assert.equal(error.batch.uncertain, false); return true;
    });
    assert.equal(writes(f).length, 1); assert.equal(owner(f.local.spaces, 1).id, 'target'); assert.equal(owner(f.store.spaces, 1).id, 'target');
});

test('session failure preserves proven durable membership and current logical Space', async () => {
    const f = fixture(); f.hooks.beforeSet = async (area, update) => { if (area === 'session' && update.spaceSession) throw new Error('Session failed'); };
    await assert.rejects(f.move(), error => error.batch.completed.length === 2 && !error.batch.uncertain);
    assert.equal(writes(f).length, 1); assert.deepEqual(f.session.activeSpaces, { 10: 'source', 20: 'source' });
});

test('unreadable write result is uncertain, never silently rolled back or retried', async () => {
    const f = fixture(); let attempted = false;
    f.hooks.beforeSet = async (area, update) => { if (area === 'local' && update.spaces) { attempted = true; throw new Error('Storage unavailable'); } };
    f.hooks.get = async (area, keys) => { if (attempted && area === 'local' && Array.isArray(keys) && keys.includes('spaceTabSnapshot')) throw new Error('Read unavailable'); };
    await assert.rejects(f.move(), error => error.batch.uncertain && error.batch.completed.length === 0);
    assert.equal(f.store.initialized, false); assert.equal(writes(f).length, 0);
});

test('native close after durable write reports only verified surviving IDs, even with equal URLs', async () => {
    const f = fixture(); f.hooks.afterSet = async (area, update) => { if (area === 'local' && update.spaces) f.tabs.splice(f.tabs.findIndex(tab => tab.id === 3), 1); };
    await assert.rejects(f.move(), error => {
        assert.deepEqual(error.batch.completed, [1]); assert.deepEqual(error.batch.remaining, [3]); assert.equal(error.batch.uncertain, true); return true;
    });
    assert.equal(writes(f).length, 1); assert.equal(owner(f.local.spaces, 2).id, 'source');
});

test('source last-tab hint is cleared only if moved; destination last-tab and both active Spaces are retained', async () => {
    const f = fixture(); f.store.spaces[0].lastTab = 1; f.store.spaces[1].lastTab = 5;
    await f.move(); assert.equal(f.store.spaces[0].lastTab, undefined); assert.equal(f.store.spaces[1].lastTab, 5);
    assert.equal(f.session.activeSpaces[10], 'source');
});

test('Move uses the authoritative queue; a queued prior reassignment invalidates the stale request', async () => {
    const f = fixture();
    const prior = f.store.run(async () => { f.store.spaces[0].temporaryTabs = [1, 2, 9]; f.store.spaces[1].temporaryTabs.push(3); });
    await assert.rejects(f.move()); await prior; assert.equal(writes(f).length, 0);
});

test('native split membership is preserved for unrelated source/destination pairs', async () => {
    const f = fixture(); f.tabs.find(tab => tab.id === 4).splitViewId = 7; f.tabs.find(tab => tab.id === 5).splitViewId = 7;
    f.store.spaces[1].temporaryTabs = [4, 5, 10];
    await f.move(); assert.deepEqual(f.store.spaces[1].temporaryTabs, [4, 5, 10, 1, 3]);
});

test('sync on expands destination before grouping the active moved tab and settles without activation', async () => {
    const f = fixture({ syncGroups: true });
    f.groups.push({ id: 100, windowId: 10, title: 'source', color: 'blue', collapsed: false },
        { id: 101, windowId: 10, title: 'target', color: 'blue', collapsed: true });
    f.session.spaceGroupProjection = { 'source:10': 100, 'target:10': 101 };
    for (const tab of f.tabs) if (tab.windowId === 10) tab.groupId = [4, 5].includes(tab.id) ? 101 : 100;
    await f.move();
    const expanded = f.effects.findIndex(effect => effect[0] === 'groupUpdate' && effect[1] === 101 && effect[2].collapsed === false);
    const grouped = f.effects.findIndex(effect => effect[0] === 'group' && effect[1].groupId === 101);
    assert(expanded >= 0 && grouped > expanded); assert.equal(f.groups.find(group => group.id === 101).collapsed, false);
    assert.deepEqual(f.tabs.filter(tab => tab.active).map(tab => tab.id), [1, 9]);
    assert.deepEqual(f.session.activeSpaces, { 10: 'source', 20: 'source' });
    await syncSpaceGroups(f.store.spaces, f.store.active);
    assert.equal(f.groups.find(group => group.id === 101).collapsed, false);
    assert.equal(f.effects.some(effect => effect[0] === 'groupUpdate' && effect[1] === 101 && effect[2].collapsed === true), false);
});

test('same-extension sender with another tab window or external provenance is rejected before queue', async () => {
    const f = fixture(); registerTodayMoveMessages(f.store);
    for (const sender of [{ id: 'foreign' }, { id: 'test', url: 'https://evil.test/' }, { id: 'test', origin: 'https://evil.test' },
        { id: 'test', tab: { windowId: 20 } }]) {
        let result; f.listeners[0](f.request, sender, response => result = response); assert.equal(result.success, false);
    }
    assert.equal(f.effects.length, 0);
});

test('registered same-extension request returns the exact batch receipt', async () => {
    const f = fixture(); registerTodayMoveMessages(f.store);
    const result = await new Promise(resolve => assert.equal(f.listeners[0](f.request, { id: 'test', url: 'chrome-extension://test/sidebar.html' }, resolve), true));
    assert.equal(result.success, true); assert.deepEqual(result.batch.completed, [1, 3]);
});

for (const rank of [8, 3]) test(`local-success/session-failure reload preserves the cleared moved rank (${rank})`, async () => {
    const f = fixture(); f.store.restoredRanks.set(1, rank); f.store.restoredRanks.set(6, 0);
    f.session.restoredTabRanks = [...f.store.restoredRanks];
    f.hooks.beforeSet = async (area, update) => { if (area === 'session' && update.spaceSession) throw new Error('Session failed'); };
    await assert.rejects(f.move(), error => error.batch.completed.length === 2 && !error.batch.uncertain);
    assert.equal(new Map(f.session.restoredTabRanks).get(1), rank, 'Session really retained the pre-move rank');
    assert.deepEqual(await readSpaceRankCheckpoint(f.local.spaceRankCheckpoint, f.local.spaceTabSnapshot), [[6, 0]]);
    f.hooks.beforeSet = null;
    const reload = new SpaceStore(); reload.discoverBookmarkSpaces = async () => false;
    await reload.initialize();
    assert.equal(reload.restoredRanks.has(1), false); assert.equal(reload.restoredRanks.get(6), 0);
    assert.deepEqual(reload.spaces[1].temporaryTabs, [4, 10, 5, 1, 3]);
    assert.equal(f.local.spaceTabSnapshot.find(record => record.tabId === 1).order, 3);
    assert.equal(reload.active[10], 'source');
});

test('rank checkpoint rejects malformed entries, tampering and an older writer changed snapshot', async () => {
    const snapshot = [{ tabId: 1, spaceId: 's', section: 'temporaryTabs', order: 0 }];
    const checkpoint = await createSpaceRankCheckpoint([[1, 0]], snapshot);
    assert.deepEqual(await readSpaceRankCheckpoint(checkpoint, snapshot), [[1, 0]]);
    for (const ranks of [[[1, -1]], [[1, 0], [1, 0]], [['1', 0]], [[1, 1]], [[1, 0, 4]]]) {
        assert.equal(await readSpaceRankCheckpoint({ ...checkpoint, ranks }, snapshot), null);
    }
    assert.equal(await readSpaceRankCheckpoint(checkpoint, [{ ...snapshot[0], spaceId: 'new' }]), null);
    assert.equal(await readSpaceRankCheckpoint({ ...checkpoint, extra: true }, snapshot), null);
});

test('legacy data and stale checkpoint from older writer keep session rank fallback', async () => {
    for (const stale of [false, true]) {
        const f = fixture(); f.session.restoredTabRanks = [[1, 7]];
        if (stale) {
            f.local.spaceTabSnapshot = [{ tabId: 1, spaceId: 'source', section: 'temporaryTabs', order: 7 }];
            f.local.spaceRankCheckpoint = await createSpaceRankCheckpoint([], f.local.spaceTabSnapshot);
            f.local.spaceTabSnapshot[0].order = 8;
        }
        const reload = new SpaceStore(); reload.discoverBookmarkSpaces = async () => false;
        await reload.initialize(); assert.equal(reload.restoredRanks.get(1), 7);
    }
});

test('an unproven browser restart never loads local rank hints', async () => {
    const f = fixture(); f.session.spaceSession = false; f.session.restoredTabRanks = [[1, 7]];
    f.local.spaceTabSnapshot = [];
    f.local.spaceRankCheckpoint = await createSpaceRankCheckpoint([[1, 7]], []);
    const reload = new SpaceStore(); reload.discoverBookmarkSpaces = async () => false;
    await reload.initialize(); assert.equal(reload.restoredRanks.has(1), false);
});

test('late destination-order mutation is rejected at the persistence boundary', async () => {
    const f = fixture(); let once = true;
    f.hooks.get = async (area, keys) => {
        if (once && area === 'local' && Array.isArray(keys) && keys.includes('tabNameOverridesById')) {
            once = false; f.store.spaces[1].temporaryTabs.reverse();
        }
    };
    await assert.rejects(f.move(), error => error.batch.completed.length === 0 && !error.batch.uncertain);
    assert.equal(writes(f).length, 0); assert.deepEqual(f.store.spaces[1].temporaryTabs, [4, 10, 5]);
});

for (const change of ['closed', 'window', 'url']) test(`readback cannot confirm a tab ${change} during its awaited folder reads`, async () => {
    const f = fixture(); let readingBack = false;
    f.hooks.afterSet = async (area, update) => { if (area === 'local' && update.spaces) { readingBack = true; throw new Error('Lost acknowledgment'); } };
    f.hooks.bookmark = async id => { if (readingBack && id === 'target-root') { readingBack = false; invalidations[change](f); } };
    await assert.rejects(f.move(), error => {
        assert.deepEqual(error.batch.completed, [1]); assert.deepEqual(error.batch.remaining, [3]); assert.equal(error.batch.uncertain, true); return true;
    });
});

for (const change of ['duplicateSpace', 'duplicateFolder']) test(`readback rejects ${change} provenance rather than claiming completion`, async () => {
    const f = fixture();
    f.hooks.afterSet = async (area, update) => {
        if (area === 'local' && update.spaces) {
            const extra = structuredClone(f.local.spaces[1]); if (change === 'duplicateFolder') extra.id = 'extra';
            f.local.spaces.push(extra); throw new Error('Lost acknowledgment');
        }
    };
    await assert.rejects(f.move(), error => error.batch.uncertain && error.batch.completed.length === 0);
});

test('unrelated partially restored Space keeps rank zero through initialize and late rank-one recovery', async () => {
    const f = fixture();
    const first = { id: 7, windowId: 10, index: 8, url: 'https://restore-first.test/', pinned: false, groupId: -1 };
    const ordinary = { ...first, id: 11, index: 9, url: 'https://ordinary.test/' };
    f.tabs.push(first, ordinary); f.store.liveTabs.set(7, first); f.store.liveTabs.set(11, ordinary);
    f.store.spaces.push(space('recovering', [7, 11])); f.store.restoredRanks.set(7, 0);
    f.store.restoreQueue = [{ tabId: 80, spaceId: 'recovering', section: 'temporaryTabs', order: 1, url: 'https://restore-late.test/' }];
    await f.move();
    const reload = new SpaceStore(); reload.discoverBookmarkSpaces = async () => false;
    await reload.initialize();
    assert.equal(reload.restoredRanks.get(7), 0); assert.equal(reload.restoreQueue.length, 1);
    const late = { ...first, id: 8, index: 10, url: 'https://restore-late.test/' }; f.tabs.push(late);
    reload.track(late); await reload.persist();
    assert.deepEqual(reload.spaces.find(space => space.id === 'recovering').temporaryTabs, [7, 8, 11]);
    assert.equal(reload.restoredRanks.get(8), 1); assert.equal(reload.restoreQueue.length, 0);
    assert.deepEqual(reload.spaces[1].temporaryTabs, [4, 10, 5, 1, 3]);
});

test('projection uses fresh native activity before collapsing, including an inherited unowned member', async () => {
    for (const activeId of [4, 99]) {
        const f = fixture({ syncGroups: true });
        f.groups.push({ id: 101, windowId: 10, title: 'target', color: 'blue', collapsed: false });
        f.session.spaceGroupProjection = { 'target:10': 101 };
        f.tabs.find(tab => tab.id === 4).groupId = 101; f.tabs.find(tab => tab.id === 5).groupId = 101;
        f.tabs.push({ id: 99, index: 20, windowId: 10, groupId: 101, url: 'chrome-extension://test/options.html', active: false });
        f.hooks.query = async filter => {
            if (filter.windowId === 10) for (const tab of f.tabs.filter(tab => tab.windowId === 10)) tab.active = tab.id === activeId;
        };
        await syncSpaceGroups([f.store.spaces[1]], f.store.active);
        assert.equal(f.groups.find(group => group.id === 101).collapsed, false);
        assert.equal(f.effects.some(effect => effect[0] === 'groupUpdate' && effect[1] === 101 && effect[2].collapsed === true), false);
    }
});

for (const inverted of [false, true]) test(`Move To ignores saved-bookmark and new-tab setting changes (today inverted=${inverted})`, async () => {
    const f = fixture({ inverted, bookmarkInverted: !inverted });
    let changed = false;
    f.hooks.get = async (area, keys) => {
        if (!changed && area === 'local' && Array.isArray(keys) && keys.includes('tabNameOverridesById')) {
            changed = true; f.sync.invertTabOrder = inverted; f.sync.todayNewTabsAtTop = false;
        }
    };
    await f.move();
    const canonical = f.store.spaces[1].temporaryTabs.filter(id => id < 9);
    assert.deepEqual(inverted ? canonical.reverse() : canonical, inverted ? [5, 4, 3, 1] : [4, 5, 1, 3]);
    assert.deepEqual(f.local.todayOrderRepresentation, { version: 1, inverted });
});

for (const inverted of [false, true]) test(`Move To order survives late restoration in source and target inverted=${inverted}`, async () => {
    const f = fixture({ inverted }); f.store.todayOrderInverted = inverted;
    f.store.restoreQueue = [
        { spaceId: 'source', section: 'temporaryTabs', order: 8, url: 'https://late-source.test/' },
        { spaceId: 'target', section: 'temporaryTabs', order: 1, url: 'https://late-target.test/' }
    ];
    await f.move(); const authored = f.store.spaces.map(space => [...space.temporaryTabs]);
    const reload = new SpaceStore(); reload.discoverBookmarkSpaces = async () => false; await reload.initialize();
    for (const [id, name] of [[40, 'target'], [41, 'source']]) {
        const late = { id, windowId: 10, index: id, url: `https://late-${name}.test/`, groupId: -1 };
        f.tabs.push(late); reload.track(late);
    }
    await reload.persist();
    assert.deepEqual(reload.spaces.map(space => space.temporaryTabs.filter(id => id < 40)), authored);
    assert.equal(reload.restoreQueue.length, 0);
});

test('guarded Move To rolls back rebased pending ranks before any write', async () => {
    const f = fixture();
    f.store.restoreQueue = [{ spaceId: 'target', section: 'temporaryTabs', order: 1, url: 'https://late.test/' }];
    const queue = structuredClone(f.store.restoreQueue), ranks = [...f.store.restoredRanks], spaces = structuredClone(f.store.spaces);
    const persist = f.store.persist.bind(f.store);
    f.store.persist = async options => { f.tabs[0].windowId = 20; return persist(options); };
    await assert.rejects(f.move());
    assert.deepEqual(f.store.restoreQueue, queue); assert.deepEqual([...f.store.restoredRanks], ranks); assert.deepEqual(f.store.spaces, spaces);
    assert.equal(writes(f).length, 0);
});

test('lost acknowledgement recognizes the exact rebased rank checkpoint with pending target restoration', async () => {
    const f = fixture();
    f.store.restoreQueue = [{ spaceId: 'target', section: 'temporaryTabs', order: 1, url: 'https://late.test/' }];
    f.hooks.afterSet = async (area, update) => { if (area === 'local' && update.spaces) throw new Error('Lost acknowledgement'); };
    await assert.rejects(f.move(), error => {
        assert.deepEqual(error.batch.completed, [1, 3]); assert.deepEqual(error.batch.remaining, []);
        assert.equal(error.batch.uncertain, false); return true;
    });
});

test('real sender rejection remains visible through the UI formatter without native mutation', () => {
    const f=fixture();registerTodayMoveMessages(f.store);let response;
    f.listeners[0](f.request,{id:'test',tab:{windowId:20}},value=>{response=value;});
    assert.equal(response.success,false);assert.equal(response.batch,undefined);
    const text=describeTodayMoveOutcome(response,f.request.entries,{id:'target',name:'Target'});
    assert.match(text,/Invalid Today move sender/);assert.match(text,/result is unknown/);assert.match(text,/nothing was retried/);assert.doesNotMatch(text,/Nothing was moved/);assert.deepEqual(f.effects,[]);
});
