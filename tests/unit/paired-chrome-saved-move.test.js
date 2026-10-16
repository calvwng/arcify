import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { readSourceText } from '../source-text.js';
import { assertSavedMoved, assertSavedMoveUnchanged, assertSavedMoveRejected, assertSavedMoveTrace, assertSavedMoveBookmarkTrace,
    assertSavedMoveReload, savedMoveTree, savedMoveEntry, canonicalSavedMoveBookmarks, installSavedMoveTrace, installSavedMoveBookmarkTrace,
    serveSavedMoveFixture, savedMoveAction, savedMoveDestination, savedMoveSearchMatches, assertSavedMoveUnsupportedCleanup, assertSavedMoveDurableReload,
    rightClickSavedMoveRow } from '../../scripts/paired-chrome-saved-move.mjs';

function savedTriggerFixture(errors = []) {
    const calls = [], records = []; let clicks = 0, disposed = 0;
    return { page: { waitForSelector: async (selector, options) => { calls.push({ selector, options });
        return { click: async options => { assert.deepEqual(options, { button: 'right' }); const error = errors[clicks++]; if (error) throw error; }, dispose: async () => { disposed++; } }; } },
        calls, records, record: async state => records.push(state), get clicks() { return clicks; }, get disposed() { return disposed; } };
}
const savedTriggerDetached = () => {
    const error = Error('Node is detached from document');
    error.stack = 'Error: Node is detached from document\n    at CdpElementHandle.assertConnectedElement (/runtime/puppeteer-core/lib/puppeteer/api/ElementHandle.js:1314:23)\n    at async CdpElementHandle.scrollIntoView (/runtime/puppeteer-core/lib/puppeteer/cdp/ElementHandle.js:106:13)';
    return error;
};
for (const folder of [false, true]) test(`saved Move right click retains exact identity and source type folder=${folder}`, async () => {
    const f = savedTriggerFixture(); await rightClickSavedMoveRow(f.page, 'fixture-28', folder, f.record);
    assert.equal(f.clicks, 1); assert.equal(f.disposed, 1); assert.equal(f.calls[0].options.visible, true);
    assert.equal(f.calls[0].selector, folder ? '.space.active .folder[data-bookmark-id="fixture-28"] > .folder-header' : '.space.active .tab[data-bookmark-id="fixture-28"]');
    assert.equal(f.records[0].status, 'clicked'); assert.equal(f.records[0].bookmarkId, 'fixture-28'); assert.equal(f.records[0].folder, folder);
});
test('saved Move reacquires a row only after a proven pre-input detach', async () => {
    const f = savedTriggerFixture([savedTriggerDetached()]); await rightClickSavedMoveRow(f.page, 'exact', false, f.record);
    assert.equal(f.clicks, 2); assert.equal(f.disposed, 2); assert.equal(new Set(f.calls.map(call => call.selector)).size, 1);
    assert.deepEqual(f.records.map(record => record.status), ['detached-before-input', 'clicked']);
});
for (const error of [Error('Input.dispatchMouseEvent timed out'), Error('Node is detached from document')]) test(`saved Move never replays uncertain input: ${error.message}`, async () => {
    const f = savedTriggerFixture([error]); await assert.rejects(rightClickSavedMoveRow(f.page, 'exact', false, f.record), value => value === error);
    assert.equal(f.clicks, 1); assert.equal(f.disposed, 1);
});
test('saved Move pre-input replacement remains bounded to three attempts', async () => {
    const errors = [savedTriggerDetached(), savedTriggerDetached(), savedTriggerDetached()], f = savedTriggerFixture(errors);
    await assert.rejects(rightClickSavedMoveRow(f.page, 'exact', false, f.record), value => value === errors[2]);
    assert.equal(f.clicks, 3); assert.equal(f.disposed, 3);
});

function searchSample() {
    const closed = { id: 'closed', title: 'Distinct closed nonce', url: 'https://test/closed' };
    const live = { id: 'live', title: 'Distinct live nonce', url: 'https://test/live' };
    return { options: { windowId: 8, spaceId: 'destination', spaceName: 'Home', closed, live, tabId: 201 },
        rows: [closed, live].map(pin => ({ type: 'bookmark', title: pin.title, space: 'Home' })),
        snapshot: { windowId: 8, bookmarks: [{ ...closed, spaceId: 'destination', tabId: null },
            { ...live, spaceId: 'destination', tabId: 201 }], tabs: [{ id: 201, windowId: 8, spaceId: 'destination' }] } };
}
test('moved saved live pins retain bookmark presentation and exact window binding without a duplicate tab row', () => {
    const s = searchSample();
    s.rows.push({ type: 'arcify-favorite', title: s.options.live.title, space: null });
    assert.equal(savedMoveSearchMatches(s.rows, s.snapshot, s.options), true);
});
for (const [name, change] of Object.entries({
    wrongType: s => s.rows[1].type = 'open-tab', duplicate: s => s.rows.push({ ...s.rows[1] }),
    duplicateTab: s => s.rows.push({ ...s.rows[1], type: 'open-tab' }), staleSpace: s => s.rows[1].space = 'Work',
    missingClosed: s => s.rows.shift(), wrongWindow: s => s.snapshot.windowId = 7,
    wrongLiveCopy: s => s.snapshot.bookmarks[1].tabId = 101, lostBinding: s => s.snapshot.bookmarks[1].tabId = null,
    unexpectedClosedBinding: s => s.snapshot.bookmarks[0].tabId = 99, wrongBookmark: s => s.snapshot.bookmarks[1].id = 'same-url-decoy',
    changedUrl: s => s.snapshot.bookmarks[1].url = 'https://other/', changedTitle: s => s.snapshot.bookmarks[1].title = 'Other',
    staleOwnership: s => s.snapshot.bookmarks[1].spaceId = 'source', missingLive: s => s.snapshot.tabs = [],
    wrongLiveWindow: s => s.snapshot.tabs[0].windowId = 7, wrongLiveSpace: s => s.snapshot.tabs[0].spaceId = 'source'
})) test(`saved search evidence rejects ${name}`, () => {
    const s = searchSample(); change(s); assert.equal(savedMoveSearchMatches(s.rows, s.snapshot, s.options), false);
});

const flat = nodes => nodes.flatMap(node => [node, ...flat(node.children || [])]);
const find = (nodes, id) => flat(nodes).find(node => node.id === id);
function sample({ inverted = false, groupSync = false, closed = false, folderMove = false } = {}) {
    const leaf = (id, parentId, index, url = 'http://127.0.0.1/equal') => ({ id, parentId, index, title: `Name ${id}`, url, dateAdded: 123 });
    const folder = (id, parentId, index, children) => ({ id, parentId, index, title: `Folder ${id}`, dateAdded: 122, children });
    const bookmarks = [folder('root', '0', 0, [folder('src', 'root', 0, [leaf('b', 'src', 0), folder('f', 'src', 1, [leaf('child', 'f', 0),
        folder('nested', 'f', 1, [leaf('closed', 'nested', 0, 'http://127.0.0.1/closed'), folder('empty', 'nested', 1, []), leaf('nested-second', 'nested', 2)])]), leaf('c', 'src', 2), leaf('decoy', 'src', 3), leaf('root-closed', 'src', 4)]),
        folder('dst', 'root', 1, [leaf('destination', 'dst', 0, 'http://127.0.0.1/destination')]), folder('other-root', 'root', 2, [])])];
    const tabs = [101, 102, 103, 201, 202, 301, 401, 501, 701, 90].map((id, index) => ({ id, index,
        windowId: [201, 202, 701].includes(id) ? 8 : 7, url: 'http://127.0.0.1/equal', pendingUrl: null, title: `Native ${id}`,
        active: id === 101 || id === 201, pinned: id === 90, incognito: false, splitViewId: -1, groupId: -1 })).sort((a, b) => a.id - b.id);
    const bindings = Object.fromEntries([[101, folderMove ? 'nested-second' : 'b'], [201, folderMove ? 'nested-second' : 'b'], [102, folderMove ? 'child' : 'c'], [202, folderMove ? 'child' : 'c'], [103, 'decoy'], [301, 'b'], [401, 'destination']].map(([id, bookmarkId]) => [id, { bookmarkId, pinnedUrl: 'http://127.0.0.1/equal' }]));
    const before = { tabs, bookmarks, bindings, aliases: { 101: { title: 'Kept override' } }, favorites: [{ id: 'global', sourceBookmarkId: 'b', title: 'Global title', url: 'http://127.0.0.1/equal' }],
        favoriteSession: { version: 1, bindings: [{ favoriteId: 'global', tabId: 301, windowId: 7 }], attempts: [] },
        spaces: [{ id: 'source', bookmarkFolderId: 'src', spaceBookmarks: [102, 201, 103, 101, 202], temporaryTabs: [501] },
            { id: 'destination', bookmarkFolderId: 'dst', spaceBookmarks: [401], temporaryTabs: [] }, { id: 'other', bookmarkFolderId: 'other-root', spaceBookmarks: [], temporaryTabs: [701] }],
        activeSpaceId: 'source', activeSpaces: { 7: 'source', 8: 'source' },
        windows: [{ id: 7, type: 'normal', incognito: false, focused: true, state: 'normal' }, { id: 8, type: 'normal', incognito: false, focused: false, state: 'normal' }],
        pageStates: Object.fromEntries(tabs.map(tab => [tab.id, { url: tab.url, documentId: `document-${tab.id}`, timeOrigin: tab.id, value: `typed-${tab.id}`, topLevel: true, frameCount: 0 }])),
        groups: [], projection: {}, savedSnapshot: [], journal: null };
    function project(state) {
        const nodes = flat(state.bookmarks);
        state.savedSnapshot = state.spaces.flatMap(space => ['spaceBookmarks', 'temporaryTabs'].flatMap(section => space[section].map((tabId, order) => ({ tabId, spaceId: space.id, section, order, windowKey: `window-${state.tabs.find(tab => tab.id === tabId).windowId}`, tabIndex: state.tabs.find(tab => tab.id === tabId).index, ...(state.bindings[tabId] ? { pinnedState: state.bindings[tabId] } : {}) }))));
        state.snapshots = Object.fromEntries([7, 8].map(wid => {
            const own = state.tabs.filter(tab => tab.windowId === wid), local = ids => ids.filter(id => own.some(tab => tab.id === id));
            const leaves = state.spaces.flatMap(space => flat([find(nodes, space.bookmarkFolderId)]).filter(node => node.url).map(node => ({ id: node.id, spaceId: space.id, title: node.title, url: node.url,
                tabId: local(space.spaceBookmarks).find(id => state.bindings[id]?.bookmarkId === node.id) ?? null })));
            return [wid, { windowId: wid, activeSpaceId: state.activeSpaces[wid], bookmarks: leaves, favorites: [{ id: 'global', tabId: wid === 7 ? 301 : null }],
                spaces: state.spaces.map(space => ({ id: space.id, name: space.id, bookmarkFolderId: space.bookmarkFolderId, pinnedTabIds: local(space.spaceBookmarks), temporaryTabIds: local(space.temporaryTabs), tabIds: local([...space.spaceBookmarks, ...space.temporaryTabs]) })),
                tabs: own.map(({ id, windowId, url, title, active, pinned }) => ({ id, windowId, url, title, active, pinned, spaceId: state.spaces.find(space => [...space.spaceBookmarks, ...space.temporaryTabs].includes(id))?.id || null })) }];
        })); state.snapshot = state.snapshots[7];
    }
    const nativeGroups = state => {
        state.groups = []; state.projection = {};
        for (const [spaceIndex, space] of state.spaces.entries()) for (const wid of [7, 8]) {
            const ids = [...space.spaceBookmarks, ...space.temporaryTabs].filter(id => state.tabs.find(tab => tab.id === id).windowId === wid);
            if (!ids.length) continue;
            const groupId = 1000 + wid + 10 * spaceIndex; state.projection[`${space.id}:${wid}`] = groupId;
            state.groups.push({ id: groupId, windowId: wid, collapsed: false });
            ids.forEach((id, index) => Object.assign(state.tabs.find(tab => tab.id === id), { index: 100 * spaceIndex + index, groupId }));
        }
    };
    if (groupSync) nativeGroups(before);
    project(before); const after = structuredClone(before);
    const bookmarkIds = closed ? ['root-closed'] : folderMove ? ['f'] : inverted ? ['c', 'b'] : ['b', 'c'];
    const src = find(after.bookmarks, 'src'), dst = find(after.bookmarks, 'dst');
    const rootNodes = bookmarkIds.map(id => find(after.bookmarks, id)); src.children = src.children.filter(node => !bookmarkIds.includes(node.id));
    for (const node of rootNodes) node.parentId = 'dst';
    dst.children = inverted ? [...rootNodes].reverse().concat(dst.children) : dst.children.concat(rootNodes);
    for (const node of [src, dst]) node.children.forEach((child, index) => { child.index = index; });
    const moved = closed ? [] : folderMove || inverted ? [102, 202, 101, 201] : [101, 201, 102, 202];
    after.spaces[0].spaceBookmarks = before.spaces[0].spaceBookmarks.filter(id => !moved.includes(id)); after.spaces[1].spaceBookmarks.push(...moved);
    if (groupSync) nativeGroups(after);
    project(after); return { before, after, request: { bookmarkIds, sourceId: 'source', destinationId: 'destination', windowId: 7, inverted, groupSync } };
}

for (const groupSync of [false, true]) for (const inverted of [false, true]) for (const [closed, folderMove] of [[false, false], [true, false], [false, true]])
    test(`saved Move validator accepts exact all-window identity proof sync=${groupSync} inverted=${inverted} closed=${closed} folder=${folderMove}`, () => {
        const s = sample({ groupSync, inverted, closed, folderMove }), proof = assertSavedMoved(s.before, s.after, s.request);
        assert.deepEqual(proof.linkedWindows, closed ? [] : [7, 8]); assert(!proof.linkedTabIds.includes(103)); assert(!proof.linkedTabIds.includes(301));
    });

for (const [name, change] of Object.entries({
    unresolvedJournal: s => s.after.journal = { phase: 'prepared' }, createdTab: s => s.after.tabs.push({ ...s.after.tabs[0], id: 999 }), missingTab: s => s.after.tabs.pop(), replacedTab: s => s.after.tabs[1].id = 999,
    movedWindow: s => s.after.tabs.find(tab => tab.id === 201).windowId = 7, activatedOtherWindow: s => s.after.tabs.find(tab => tab.id === 201).active = false,
    activatedA: s => s.after.tabs.find(tab => tab.id === 101).active = false, nativePinChanged: s => s.after.tabs.find(tab => tab.id === 90).pinned = false,
    navigated: s => s.after.tabs[1].url = 'http://changed/', pendingNavigation: s => s.after.tabs[1].pendingUrl = 'http://changed/',
    reloadedA: s => s.after.pageStates[101].documentId = 'replacement', reloadedB: s => s.after.pageStates[201].timeOrigin++, erasedTypedState: s => s.after.pageStates[202].value = '',
    focusedWindow: s => s.after.windows[1].focused = true, createdWindow: s => s.after.windows.push({ id: 9 }), selectedDestination: s => s.after.activeSpaceId = 'destination', changedBSelection: s => s.after.activeSpaces[8] = 'destination',
    removedBookmark: s => find(s.after.bookmarks, 'dst').children.pop(), replacedBookmark: s => find(s.after.bookmarks, 'child').id = 'replacement',
    changedChildTitle: s => find(s.after.bookmarks, 'closed').title = 'new', changedChildURL: s => find(s.after.bookmarks, 'closed').url = 'http://changed/',
    flattenedFolder: s => find(s.after.bookmarks, 'f').children = [], lostEmptyFolder: s => find(s.after.bookmarks, 'nested').children.splice(1, 1),
    reversedChildren: s => find(s.after.bookmarks, 'f').children.reverse(), reorderedDestination: s => find(s.after.bookmarks, 'dst').children.reverse(),
    changedUnrelatedRoot: s => find(s.after.bookmarks, 'other-root').title = 'new', changedSavedDate: s => find(s.after.bookmarks, 'child').dateAdded++,
    sameURLDecoyMoved: s => { s.after.spaces[0].spaceBookmarks = s.after.spaces[0].spaceBookmarks.filter(id => id !== 103); s.after.spaces[1].spaceBookmarks.push(103); },
    lostBLinkedCopy: s => s.after.spaces[1].spaceBookmarks = s.after.spaces[1].spaceBookmarks.filter(id => id !== 201),
    sourceRetained: s => s.after.spaces[0].spaceBookmarks.push(101), duplicateOwnership: s => s.after.spaces[2].spaceBookmarks.push(201),
    alteredToday: s => s.after.spaces[0].temporaryTabs = [], wrongLiveOrder: s => s.after.spaces[1].spaceBookmarks.reverse(),
    bindingChanged: s => s.after.bindings[101].bookmarkId = 'decoy', aliasChanged: s => s.after.aliases = {},
    favoriteRecordChanged: s => s.after.favorites[0].sourceBookmarkId = 'child', globalOwnershipAdopted: s => s.after.favoriteSession.bindings = [],
    savedOrderNegative: s => s.after.savedSnapshot[0].order = -999, savedOrderReversed: s => s.after.savedSnapshot.find(record => record.tabId === 101).order = 99, savedNativeIndexCorrupt: s => s.after.savedSnapshot[0].tabIndex = -999, savedSnapshotStale: s => s.after.savedSnapshot.find(record => record.tabId === 201).spaceId = 'source', unrelatedSavedSnapshotLost: s => s.after.savedSnapshot = s.after.savedSnapshot.filter(record => record.tabId !== 103), savedSnapshotURLChanged: s => s.after.savedSnapshot[0].url = 'http://changed/', savedSnapshotBindingLost: s => delete s.after.savedSnapshot.find(record => record.tabId === 101).pinnedState,
    savedSnapshotDuplicate: s => s.after.savedSnapshot.push(s.after.savedSnapshot.find(record => record.tabId === 201)),
    staleBSnapshot: s => s.after.snapshots[8].tabs.find(tab => tab.id === 201).spaceId = 'source',
    unmovedClosedSnapshotChanged: s => s.after.snapshots[8].bookmarks.find(bookmark => bookmark.id === 'closed').spaceId = 'destination',
    missingBBookmark: s => s.after.snapshots[8].bookmarks.pop(), alteredGlobalSnapshot: s => s.after.snapshots[8].favorites = [],
    missingSnapshotSpace: s => s.after.snapshots[8].spaces.pop(), renamedSnapshotSpace: s => s.after.snapshots[7].spaces[0].name = 'new',
    stalePinnedSnapshot: s => s.after.snapshots[8].spaces[0].pinnedTabIds.push(201), missingWindowSnapshot: s => delete s.after.snapshots[8],
    nativeOffReordered: s => s.after.tabs[1].index++, nativeOffGrouped: s => s.after.tabs[1].groupId = 12, nativeOffGroupChanged: s => s.after.groups.push({ id: 77 }),
    duplicateInput: s => s.request.bookmarkIds = ['b', 'b'], wrongVisibleInput: s => s.request.bookmarkIds.reverse(), sameDestination: s => s.request.destinationId = 'source',
    splitLinkedInput: s => { s.before.tabs.find(tab => tab.id === 202).splitViewId = 44; s.after.tabs.find(tab => tab.id === 202).splitViewId = 44; },
    nativePinnedLinkedInput: s => { s.before.tabs.find(tab => tab.id === 201).pinned = true; s.after.tabs.find(tab => tab.id === 201).pinned = true; },
    ambiguousLinkedInput: s => { s.before.spaces[0].spaceBookmarks = s.before.spaces[0].spaceBookmarks.filter(id => id !== 202); }
})) test(`saved Move validator rejects ${name}`, () => { const s = sample(); change(s); assert.throws(() => assertSavedMoved(s.before, s.after, s.request)); });

for (const [name, change] of Object.entries({ staleClosedDescendant: s => s.after.snapshots[8].bookmarks.find(bookmark => bookmark.id === 'closed').spaceId = 'source',
    lostMovedEmptyFolder: s => find(s.after.bookmarks, 'nested').children.splice(1, 1), movedNestedOrder: s => find(s.after.bookmarks, 'f').children.reverse(),
    movedNestedName: s => find(s.after.bookmarks, 'nested').title = 'changed' }))
    test(`folder Move rejects ${name}`, () => { const s = sample({ folderMove: true }); change(s); assert.throws(() => assertSavedMoved(s.before, s.after, s.request)); });

for (const [name, change] of Object.entries({ staleBProjection: s => delete s.after.projection['destination:8'], collapsedActiveB: s => s.after.groups.find(group => group.windowId === 8).collapsed = true,
    wrongBGroup: s => s.after.tabs.find(tab => tab.id === 201).groupId = -1, wrongBGroupOrder: s => s.after.tabs.find(tab => tab.id === 202).index = -10, regroupedSourceDecoy: s => s.after.tabs.find(tab => tab.id === 103).groupId = 888, regroupedSourceToday: s => s.after.tabs.find(tab => tab.id === 501).groupId = 888, reorderedSourceToday: s => s.after.tabs.find(tab => tab.id === 501).index = -10, regroupedGlobal: s => s.after.tabs.find(tab => tab.id === 301).groupId = 22, unrelatedProjection: s => s.after.projection['other:8'] = 22, unrelatedGroup: s => s.after.groups.push({ id: 88, windowId: 8 }) }))
    test(`enabled sync rejects ${name}`, () => { const s = sample({ groupSync: true }); change(s); assert.throws(() => assertSavedMoved(s.before, s.after, s.request)); });

test('unrelated pending records from earlier closed fixture windows remain exact rather than requiring nonexistent native tabs', () => {
    const s = sample(), pending = { tabId: 999, section: 'temporaryTabs', spaceId: 'source', order: 8, tabIndex: 4, windowKey: 'previous-window', url: 'http://127.0.0.1/previous' };
    s.before.savedSnapshot.push(structuredClone(pending)); s.after.savedSnapshot.push(structuredClone(pending));
    assertSavedMoved(s.before, s.after, s.request);
    for (const key of ['spaceId', 'section', 'order', 'tabIndex', 'windowKey', 'url']) {
        const changed = structuredClone(s.after); changed.savedSnapshot.at(-1)[key] = 'corrupt'; assert.throws(() => assertSavedMoved(s.before, changed, s.request));
    }
});
test('sync permits only the exact previously unowned native helper in its retained source group', () => {
    const s = sample({ groupSync: true }), groupId = s.before.projection['source:7'];
    const helper = { ...s.before.tabs.find(tab => tab.id === 90), id: 901, pinned: false, title: 'Unowned extension helper', index: 50, groupId };
    for (const state of [s.before, s.after]) { state.tabs.push(structuredClone(helper)); state.pageStates[901] = { documentId: 'helper' };
        const { id, windowId, url, title, active, pinned } = helper; state.snapshots[7].tabs.push({ id, windowId, url, title, active, pinned, spaceId: null }); }
    assertSavedMoved(s.before, s.after, s.request);
    for (const change of [state => state.tabs.find(tab => tab.id === 301).groupId = groupId,
        state => state.tabs.find(tab => tab.id === 103).groupId = 888, state => state.tabs.find(tab => tab.id === 901).groupId = -1]) {
        const bad = structuredClone(s.after); change(bad); assert.throws(() => assertSavedMoved(s.before, bad, s.request));
    }
});

test('cancel/rejection compares complete saved, native, global and window identity', () => {
    const { before } = sample(); assertSavedMoveUnchanged(before, structuredClone(before));
    for (const field of ['tabs', 'spaces', 'bookmarks', 'bindings', 'aliases', 'favorites', 'favoriteSession', 'activeSpaces', 'activeSpaceId', 'pageStates', 'groups', 'projection', 'windows', 'savedSnapshot', 'journal']) {
        const after = structuredClone(before); after[field] = field === 'journal' ? { phase: 'prepared' } : null; assert.throws(() => assertSavedMoveUnchanged(before, after));
    }
});
test('negative source/destination/split/native-pin evidence requires exact writer receipt', () => {
    const request = { entries: [{ bookmarkId: 'folder' }, { bookmarkId: 'pin' }], destinationSpaceId: 'destination' };
    const response = { success: false, error: 'Selection changed', batch: { total: 2, completed: [], remaining: ['folder', 'pin'], uncertain: false, destinationSpaceId: 'destination' } };
    assertSavedMoveRejected(response, request);
    for (const change of [r => delete r.batch, r => r.batch.completed.push('folder'), r => r.batch.remaining.pop(), r => r.batch.uncertain = true, r => r.batch.destinationSpaceId = 'other', r => r.success = true, r => r.error = '']) {
        const bad = structuredClone(response); change(bad); assert.throws(() => assertSavedMoveRejected(bad, request));
    }
});
const trace = () => [{ type: 'click', bookmarkId: 'b', ctrl: true, trusted: true }, { type: 'click', bookmarkId: 'f', ctrl: true, trusted: true },
    { type: 'contextmenu', bookmarkId: 'b', folder: false, trusted: true }, { type: 'click', action: 'moveSavedItemsToSpace', trusted: true },
    { type: 'click', action: 'moveSavedToDestination', spaceId: 'destination', trusted: true }];
const traceRequest = { bookmarkIds: ['b', 'f'], destinationId: 'destination' };
test('positive batch and folder evidence requires real exact context-menu and destination input', () => {
    assertSavedMoveTrace(trace(), traceRequest);
    const folderTrace = trace().slice(2); folderTrace[0].bookmarkId = 'f'; folderTrace[0].folder = true;
    assertSavedMoveTrace(folderTrace, { bookmarkIds: ['f'], destinationId: 'destination', folder: true });
});
for (const [name, change] of Object.entries({ syntheticContext: e => e[2].trusted = false, syntheticDestination: e => e[4].trusted = false,
    wrongContext: e => e[2].bookmarkId = 'decoy', wrongFolder: e => e[2].folder = true, wrongDestination: e => e[4].spaceId = 'source',
    missingMenu: e => e.splice(3, 1), missingDestination: e => e.pop(), replayedDestination: e => e.push(e[4]), missingModifier: e => e[0].ctrl = false,
    wrongSelectionOrder: e => [e[0], e[1]] = [e[1], e[0]] })) test(`trusted saved input rejects ${name}`, () => { const events = trace(); change(events); assert.throws(() => assertSavedMoveTrace(events, traceRequest)); });

test('bookmark event evidence rejects recreate/remove/change, extra moves and wrong destination', () => {
    const expected = { bookmarkIds: ['b', 'f'], sourceFolderId: 'src', destinationFolderId: 'dst' };
    const events = ['b', 'f'].map(id => ({ id, type: 'moved', info: { parentId: 'dst', oldParentId: 'src' } }));
    assertSavedMoveBookmarkTrace(events, expected);
    for (const change of [e => e.pop(), e => e.push(e[0]), e => e[0].type = 'created', e => e[0].type = 'removed', e => e[0].type = 'changed',
        e => e[0].id = 'child', e => e[1].info.parentId = 'other', e => e[1].info.oldParentId = 'other']) {
        const wrong = structuredClone(events); change(wrong); assert.throws(() => assertSavedMoveBookmarkTrace(wrong, expected));
    }
});
test('passive bookmark observers retain actual lifecycle without a writer or replay seam', () => {
    const prior = globalThis.chrome, listeners = {};
    globalThis.chrome = { bookmarks: Object.fromEntries(['onCreated', 'onRemoved', 'onChanged', 'onMoved'].map(key => [key, { addListener: callback => { listeners[key] = callback; } }])) };
    try { installSavedMoveBookmarkTrace(); listeners.onMoved('b', { parentId: 'dst', oldParentId: 'src' });
        assert.deepEqual(globalThis.__savedMoveBookmarks, [{ type: 'moved', id: 'b', info: { parentId: 'dst', oldParentId: 'src' } }]); }
    finally { if (prior === undefined) delete globalThis.chrome; else globalThis.chrome = prior; delete globalThis.__savedMoveBookmarks; }
});
test('DOM trace records actual trust and exact saved folder identity', () => {
    const { document, window } = parseHTML('<html><body><div class="folder" data-bookmark-id="f"><div class="folder-header"><span id="target">Nested</span></div></div></body></html>');
    const prior = globalThis.document; globalThis.document = document;
    try { installSavedMoveTrace(); const event = new window.Event('contextmenu', { bubbles: true }); Object.defineProperty(event, 'isTrusted', { value: false }); document.getElementById('target').dispatchEvent(event);
        assert.equal(globalThis.__savedMoveTrace[0].bookmarkId, 'f'); assert.equal(globalThis.__savedMoveTrace[0].folder, true); assert.equal(globalThis.__savedMoveTrace[0].trusted, false); }
    finally { if (prior === undefined) delete globalThis.document; else globalThis.document = prior; delete globalThis.__savedMoveTrace; }
});
test('canonical recursive request includes exact nested IDs/parents/titles/URLs and empty children', () => {
    const node = find(sample().before.bookmarks, 'f'), tree = savedMoveTree(node), entry = savedMoveEntry(node);
    assert.equal(entry.bookmarkId, 'f'); assert.equal(entry.url, null); assert.equal(entry.tabId, null); assert.deepEqual(entry.tree, tree);
    assert.deepEqual(tree.children[1].children[1], { id: 'empty', parentId: 'nested', title: 'Folder empty', url: null, children: [] });
    assert.deepEqual(savedMoveEntry(node.children[0], 102), { bookmarkId: 'child', parentId: 'f', title: 'Name child', url: 'http://127.0.0.1/equal', tabId: 102 });
    const raw = structuredClone(node); raw.dateGroupModified = 987; raw.children[0].dateLastUsed = 999;
    assert.deepEqual(canonicalSavedMoveBookmarks([raw]), [node]);
});
test('server scopes synthetic pages by nonce and generates distinct real document identity per navigation', () => {
    const invoke = url => { let status, headers, body; return { served: serveSavedMoveFixture({ url }, { writeHead: (s, h) => { status = s; headers = h; }, end: b => { body = b; } }), status, headers, body }; };
    assert.equal(invoke('/saved-move/bad/active').served, false); assert.equal(invoke('/elsewhere').served, false);
    const url = `/saved-move/${'1'.repeat(32)}/active`, one = invoke(url), two = invoke(url);
    assert.equal(one.status, 200); assert.equal(one.headers['Cache-Control'], 'no-store'); assert.match(one.headers['Content-Security-Policy'], /default-src 'none'/);
    assert.notEqual(one.body, two.body); assert.match(one.body, /data-document-id=/); assert.match(one.body, /id="move-input"/);
    assert.equal(savedMoveAction(false), '#tab-context-menu [data-action="moveSavedItemsToSpace"]');
    assert.equal(savedMoveDestination('dst', true), '#folder-context-menu [data-action="moveSavedToDestination"][data-space-id="dst"]');
});
test('owned unsupported native-pin cleanup leaves every moved copy and source bookmark intact', () => {
    const { after } = sample(), before = structuredClone(after);
    const pin = flat(before.bookmarks).find(node => node.id === 'b');
    const original = before.tabs.find(tab => tab.windowId === 7);
    before.tabs.forEach(tab => { if (tab.windowId === 7) tab.index++; });
    before.savedSnapshot.forEach(record => { if (before.tabs.find(tab => tab.id === record.tabId)?.windowId === 7) record.tabIndex++; });
    const negative = { ...original, id: 901, index: 0, pinned: true, active: false, groupId: -1 };
    before.tabs.push(negative); before.tabs.sort((a, b) => a.id - b.id);
    before.bindings[901] = { bookmarkId: pin.id, pinnedUrl: pin.url }; before.aliases[901] = 'negative title';
    before.pageStates[901] = { documentId: 'owned-negative' };
    before.snapshots[7].tabs.push({ ...negative, spaceId: null });
    assertSavedMoveUnsupportedCleanup(before, after, { tabId: 901, bookmarkId: pin.id });
    for (const mutate of [s => delete s.bindings[101], s => s.bookmarks = [], s => s.tabs[0].url = 'https://changed/',
        s => s.spaces[0].spaceBookmarks = [], s => s.activeSpaces[8] = 'other', s => s.windows[0].focused = false,
        s => s.pageStates[202].value = 'lost', s => s.tabs.push(negative)]) {
        const bad = structuredClone(after); mutate(bad);
        assert.throws(() => assertSavedMoveUnsupportedCleanup(before, bad, { tabId: 901, bookmarkId: pin.id }));
    }
    for (const mutate of [s => s.tabs.find(tab => tab.id === 901).active = true,
        s => s.tabs.find(tab => tab.id === 901).pinned = false,
        s => s.savedSnapshot.push({ tabId: 901 }), s => s.spaces[0].spaceBookmarks.push(901)]) {
        const bad = structuredClone(before); mutate(bad);
        assert.throws(() => assertSavedMoveUnsupportedCleanup(bad, after, { tabId: 901, bookmarkId: pin.id }));
    }
});
test('durable reload permits live window-key rotation and vacant rank compaction, retaining pending anchors', () => {
    const { after: before } = sample();
    before.savedSnapshot.push({ tabId: 901, spaceId: 'source', section: 'temporaryTabs', order: 7,
        windowKey: 'pending-original', tabIndex: 3, url: 'https://pending/', nameOverride: { title: 'Pending' } });
    before.savedSnapshot.push({ tabId: 902, spaceId: 'source', section: 'temporaryTabs', order: 9,
        windowKey: 'pending-original', tabIndex: 4, url: 'https://pending/' });
    const after = structuredClone(before);
    for (const record of after.savedSnapshot) if (after.tabs.some(tab => tab.id === record.tabId)) record.windowKey += '-new';
    after.savedSnapshot.find(record => record.tabId === 901).order = 1;
    after.savedSnapshot.find(record => record.tabId === 902).order = 2;
    assertSavedMoveDurableReload(before, after);
    for (const mutate of [s => s.savedSnapshot.find(r => r.tabId === 901).windowKey = 'guessed',
        s => s.savedSnapshot.find(r => r.tabId === 901).order = 3,
        s => s.savedSnapshot.find(r => r.tabId === 902).order = 8,
        s => s.savedSnapshot.find(r => r.tabId === 101).order += 100,
        s => s.savedSnapshot.reverse(),
        s => s.savedSnapshot.find(r => r.tabId === 901).order = 0,
        s => s.savedSnapshot.find(r => r.tabId === 901).spaceId = 'destination',
        s => s.savedSnapshot.find(r => r.tabId === 901).nameOverride.title = 'Lost',
        s => s.savedSnapshot.find(r => r.tabId === 101).windowKey = 'split-window',
        s => s.savedSnapshot.find(r => r.tabId === 101).tabIndex++,
        s => s.savedSnapshot.push({ ...s.savedSnapshot[0] }),
        s => s.savedSnapshot = s.savedSnapshot.filter(r => r.tabId !== 102),
        s => s.tabs.find(t => t.id === 201).windowId = 7,
        s => s.tabs.push({ id: 901, index: 3, windowId: 7 })]) {
        const bad = structuredClone(after); mutate(bad); assert.throws(() => assertSavedMoveDurableReload(before, bad));
    }
});
test('reload keeps exact all-window saved and global identities without old-ID remapping', () => {
    const { after: before } = sample(); const after = structuredClone(before);
    after.windows[0].focused = false; after.tabs.find(tab => tab.id === 101).active = false; after.tabs.find(tab => tab.id === 101).groupId = 77;
    assertSavedMoveReload(before, after, [101, 102, 201, 202, 90]);
    for (const change of [s => s.snapshots[8].bookmarks.find(bookmark => bookmark.id === 'b').spaceId = 'source', s => s.snapshots[8].tabs.find(tab => tab.id === 201).spaceId = 'source',
        s => s.savedSnapshot[0].order = -999, s => delete s.bindings[201], s => s.favoriteSession.bindings = [], s => s.bookmarks = [], s => s.pageStates[202].documentId = 'new', s => s.tabs.find(tab => tab.id === 90).pinned = false]) {
        const wrong = structuredClone(after); change(wrong); assert.throws(() => assertSavedMoveReload(before, wrong, [101, 102, 201, 202, 90]));
    }
});

const helper = readSourceText(new URL('../../scripts/paired-chrome-saved-move.mjs', import.meta.url));
const runner = readSourceText(new URL('../../scripts/paired-chrome-smoke.mjs', import.meta.url));
const workflow = readSourceText(new URL('../../.github/workflows/paired-extension-smoke.yml', import.meta.url));
test('saved Move proof is mandatory in both new full cases without weakening original window-B/sandbox/reload gates', () => {
    for (const [index, sync] of [[44, false], [45, true]]) assert.match(runner, new RegExp(`await step\\(stepNames\\[${index}\\], \\(\\) => exerciseSavedMove[\\s\\S]*?groupSync:${sync}`));
    assert.equal((runner.match(/exerciseSavedMove\(/g) || []).length, 2);
    assert.match(runner, /if \(serveSavedMoveFixture\(request, response\)\) return/);
    assert.match(runner, /assert.deepEqual\(await windowBState\(\), fixture.windowBBaseline/);
    const savedStart = runner.indexOf('await step(stepNames[44]');
    const savedEnd = runner.indexOf('    } // Shared appearance/actions cases 46–49;', savedStart);
    assert(savedStart > 0 && savedEnd > savedStart);
    assert(runner.indexOf('await step(stepNames[45]', savedStart) < savedEnd);
    assert.doesNotMatch(runner.slice(savedStart, savedEnd), /windowIsolation/);
    assert.match(helper, /assert.equal\(hosting.tab, null\)/); assert.match(helper, /assert.equal\(hosting.windowId, windowId\)/);
    assert.match(helper, /clickBookmarkFixtureRow\(native.page/); assert.match(helper, /button: 'right'/);
    assert.match(helper, /await rightClickSavedMoveRow\(native.page, id, folder,/);
    for (const proof of ['assertSavedMoved', 'assertSavedMoveTrace', 'assertSavedMoveBookmarkTrace', 'assertTodayMoveNativeQuiet', 'assertSavedMoveReload', 'watchTodayInvalidation']) assert(helper.includes(proof));
    for (const phase of ['changed-folder-descendant-rejected', 'native-pinned-linked-copy-rejected', 'before-saved-move-reload', 'saved-move-witnessed-reload']) assert(helper.includes(phase));
    const attachment = runner.slice(runner.indexOf('async function openSavedMovePage'), runner.indexOf('async function newTabPage'));
    assert.match(attachment, /!beforeTargets.has\(target\)/); assert.match(attachment, /fresh.length <= 1/); assert.match(attachment, /assert.deepEqual\(newIds, \[opened.tabId\]/);
    assert.doesNotMatch(helper, /dispatchEvent|puppeteer\.launch|no-sandbox|disable-web-security|emulateFocus|setViewport|chrome\.storage\.(local|session)\.set|setTimeout|sleep\(/);
    for (const path of ['scripts/paired-chrome-saved-move.mjs', 'tests/unit/paired-chrome-saved-move.test.js', 'saved-move-*.js', 'tests/unit/saved-move-*.test.js']) assert(workflow.includes(`- '${path}'`));
});
