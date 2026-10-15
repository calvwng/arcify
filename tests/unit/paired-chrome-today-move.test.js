import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { readSourceText } from '../source-text.js';
import { assertTodayMoved, assertTodayMoveUnchanged, assertTodayMoveRejected, assertTodayMoveTrace, assertTodayMoveReload,
    installTodayMoveTrace, installTodayMoveNativeTrace, assertTodayMoveNativeQuiet, readTodayMovePage, serveTodayMoveFixture, todayMoveDestination } from '../../scripts/paired-chrome-today-move.mjs';

function sample({ groupSync = false, inverted = false } = {}) {
    const tabs = [11, 12, 13, 21, 22, 90].map((id, index) => ({ id, windowId: id === 90 ? 8 : 7, index, url: `http://127.0.0.1/${id === 12 ? 11 : id}`,
        pendingUrl: null, title: String(id), pinned: false, incognito: false, active: id === 11 || id === 90, splitViewId: -1, groupId: -1 }));
    const before = { tabs, spaces: [{ id: 'source', bookmarkFolderId: 'root', spaceBookmarks: [], temporaryTabs: [11, 12, 13] },
        { id: 'destination', bookmarkFolderId: 'dest-root', spaceBookmarks: [], temporaryTabs: [21, 22] },
        { id: 'other', bookmarkFolderId: 'other-root', spaceBookmarks: [], temporaryTabs: [90] }],
        bookmarks: [{ id: 'kept-bookmark' }], bindings: {}, aliases: { 11: 'kept-alias' }, favorites: [{ id: 'global-kept' }],
        activeSpaces: { 7: 'source', 8: 'other' }, activeSpaceId: 'source',
        windows: [{ id: 7, type: 'normal', incognito: false, focused: true, state: 'normal' }, { id: 8, type: 'normal', incognito: false, focused: false, state: 'normal' }],
        pageStates: { 11: { documentId: 'first', value: 'kept-11', timeOrigin: 123 }, 12: { documentId: 'equal-url-but-distinct-document', value: 'kept-12', timeOrigin: 456 } }, groups: [], projection: {} };
    const project = state => ({ activeSpaceId: state.activeSpaceId, spaces: state.spaces.map(space => ({ id: space.id, temporaryTabIds: [...space.temporaryTabs] })),
        tabs: state.tabs.map(tab => ({ ...tab, spaceId: state.spaces.find(space => [...space.temporaryTabs, ...space.spaceBookmarks].includes(tab.id))?.id })) });
    before.snapshot = project(before);
    const after = structuredClone(before), tabIds = inverted ? [12, 11] : [11, 12];
    after.spaces[0].temporaryTabs = [13]; after.spaces[1].temporaryTabs = inverted ? [11, 12, 21, 22] : [21, 22, 11, 12];
    if (groupSync) {
        const groupId = 71; after.projection['destination:7'] = groupId;
        after.groups = [{ id: groupId, windowId: 7, collapsed: false }];
        for (const [index, id] of after.spaces[1].temporaryTabs.entries()) Object.assign(after.tabs.find(tab => tab.id === id), { index, groupId });
    }
    after.snapshot = project(after);
    return { before, after, request: { tabIds, sourceId: 'source', destinationId: 'destination', windowId: 7, inverted, groupSync } };
}

for (const groupSync of [false, true]) for (const inverted of [false, true]) test(`Move validator requires exact IDs/order with groupSync=${groupSync}, inverted=${inverted}`, () => {
    const { before, after, request } = sample({ groupSync, inverted });
    const proof = assertTodayMoved(before, after, request);
    assert.equal(proof.activeTabId, 11); assert.deepEqual(proof.tabIds, request.tabIds);
});
for (const [name, change] of Object.entries({
    closedTab: s => s.after.tabs.pop(), createdTab: s => s.after.tabs.push({ ...s.after.tabs[0], id: 99 }),
    duplicatedTab: s => s.after.tabs.push(s.after.tabs[0]), replacedTab: s => s.after.tabs[0].id = 100,
    navigated: s => s.after.tabs[0].url = 'https://elsewhere.test', pendingNavigation: s => s.after.tabs[0].pendingUrl = 'https://elsewhere.test',
    reloadedDocument: s => s.after.pageStates[11].documentId = 'new-document', erasedInput: s => s.after.pageStates[12].value = '',
    changedWindow: s => s.after.tabs[0].windowId = 8, nativeActivated: s => s.after.tabs[0].active = false,
    windowFocused: s => s.after.windows[1].focused = true, windowRemoved: s => s.after.windows.pop(),
    selectedDestination: s => s.after.activeSpaceId = 'destination', otherWindowSelection: s => s.after.activeSpaces[8] = 'destination',
    sourceRetained: s => s.after.spaces[0].temporaryTabs.push(11), reorderedSurvivor: s => s.after.spaces[0].temporaryTabs = [12],
    destinationPrepended: s => s.after.spaces[1].temporaryTabs = [11, 12, 21, 22],
    destinationReversed: s => s.after.spaces[1].temporaryTabs = [21, 22, 12, 11],
    destinationDuplicated: s => s.after.spaces[1].temporaryTabs.push(11), unrelatedMembership: s => s.after.spaces[2].temporaryTabs = [],
    pinnedByMove: s => s.after.tabs[0].pinned = true, savedAsPin: s => s.after.spaces[1].spaceBookmarks = [11],
    favoriteMutation: s => s.after.favorites = [], bookmarkMutation: s => s.after.bookmarks = [],
    newBinding: s => s.after.bindings[11] = { bookmarkId: 'new' }, aliasMutation: s => s.after.aliases[11] = 'new',
    staleSnapshotOwner: s => s.after.snapshot.tabs[0].spaceId = 'source', staleSnapshotSource: s => s.after.snapshot.spaces[0].temporaryTabIds = [11, 12, 13],
    staleSnapshotDestination: s => s.after.snapshot.spaces[1].temporaryTabIds = [21, 22],
    offNativeReorder: s => s.after.tabs[0].index = 99, offNativeGroup: s => s.after.tabs[0].groupId = 77,
    offNativeGroupMetadata: s => s.after.groups = [{ id: 7, collapsed: false }], offProjection: s => s.after.projection['source:7'] = 71,
    duplicateInput: s => s.request.tabIds = [11, 11], wrongVisibleOrder: s => s.request.tabIds = [12, 11],
    sameSpace: s => s.request.destinationId = 'source', wrongWindow: s => s.request.windowId = 8,
    savedPinInput: s => { s.before.bindings[11] = { bookmarkId: 'pin' }; s.after.bindings[11] = { bookmarkId: 'pin' }; },
    nativeSplitInput: s => { s.before.tabs[0].splitViewId = 4; s.after.tabs[0].splitViewId = 4; }
})) test(`Move validator rejects ${name}`, () => { const s = sample(); change(s); assert.throws(() => assertTodayMoved(s.before, s.after, s.request)); });
for (const [name, change] of Object.entries({ collapsedActive: s => s.after.groups[0].collapsed = true, missingProjection: s => s.after.projection = {},
    wrongNativeOrder: s => s.after.tabs[0].index = -3, missingGroupMember: s => s.after.tabs[0].groupId = -1 })) test(`Enabled projection rejects ${name}`, () => {
    const s = sample({ groupSync: true }); change(s); assert.throws(() => assertTodayMoved(s.before, s.after, s.request));
});

test('negative probes require exact writer rejection receipts and cannot pass on sender denial', () => {
    const request = { destinationSpaceId: 'destination', entries: [{ tabId: 11, url: 'https://example.test' }] };
    const reply = { success: false, error: 'The selected tab or Space changed.', batch: { total: 1, completed: [], remaining: [11], uncertain: false, destinationSpaceId: 'destination' } };
    assertTodayMoveRejected(reply, request);
    for (const change of [r => delete r.batch, r => r.batch.completed.push(11), r => r.batch.remaining = [], r => r.batch.uncertain = true,
        r => r.batch.destinationSpaceId = 'wrong', r => r.success = true]) {
        const wrong = structuredClone(reply); change(wrong); assert.throws(() => assertTodayMoveRejected(wrong, request));
    }
});

test('cancellation/rejection requires all captured identities unchanged', () => {
    const { before } = sample(); assertTodayMoveUnchanged(before, structuredClone(before));
    for (const key of ['tabs', 'spaces', 'bookmarks', 'bindings', 'aliases', 'favorites', 'activeSpaces', 'activeSpaceId', 'pageStates', 'groups', 'projection', 'windows']) {
        const after = structuredClone(before); after[key] = null; assert.throws(() => assertTodayMoveUnchanged(before, after));
    }
});
function trace() { return [
    { type: 'click', tabId: 11, ctrl: true, trusted: true }, { type: 'click', tabId: 12, ctrl: true, trusted: true },
    { type: 'contextmenu', tabId: 11, trusted: true }, { type: 'click', action: 'moveTodayTabsToSpace', trusted: true },
    { type: 'click', action: 'moveTodayToDestination', spaceId: 'destination', trusted: true }
]; }
const traceRequest = { tabIds: [11, 12], contextTabId: 11, destinationId: 'destination', multi: true };
test('positive UI evidence requires exact trusted context/menu/destination and modifier input', () => assertTodayMoveTrace(trace(), traceRequest));
for (const [name, change] of Object.entries({ syntheticContext: e => e[2].trusted = false, syntheticDestination: e => e[4].trusted = false,
    wrongContext: e => e[2].tabId = 99, wrongDestination: e => e[4].spaceId = 'source', omittedDestination: e => e.pop(),
    duplicateDestination: e => e.push(e[4]), omittedMenu: e => e.splice(3, 1), wrongSelectionOrder: e => [e[0], e[1]] = [e[1], e[0]],
    missingControl: e => e[0].ctrl = false })) test(`trusted trace rejects ${name}`, () => { const e = trace(); change(e); assert.throws(() => assertTodayMoveTrace(e, traceRequest)); });

test('passive lifecycle guard rejects transient activation, replacement and window changes even if final state matches', () => {
    assertTodayMoveNativeQuiet([]);
    for (const type of ['activated', 'created', 'removed', 'replaced', 'attached', 'detached', 'window-focus', 'window-created', 'window-removed']) {
        assert.throws(() => assertTodayMoveNativeQuiet([{ type, details: [] }]));
    }
    const prior = globalThis.chrome, listeners = {};
    const event = key => ({ addListener: listener => { listeners[key] = listener; } });
    globalThis.chrome = { tabs: Object.fromEntries(['onActivated', 'onCreated', 'onRemoved', 'onReplaced', 'onAttached', 'onDetached'].map(key => [key, event(`tabs.${key}`)])),
        windows: Object.fromEntries(['onFocusChanged', 'onCreated', 'onRemoved'].map(key => [key, event(`windows.${key}`)])) };
    try { installTodayMoveNativeTrace(); assert.equal(Object.keys(listeners).length, 9); listeners['tabs.onActivated']({ tabId: 11, windowId: 7 });
        assert.deepEqual(globalThis.__todayMoveNativeTrace.events, [{ type: 'activated', details: [{ tabId: 11, windowId: 7 }] }]); }
    finally { if (prior === undefined) delete globalThis.chrome; else globalThis.chrome = prior; delete globalThis.__todayMoveNativeTrace; }
});

test('reload requires identical moved IDs, pages, selection and canonical membership', () => {
    const { after: before } = sample(); const after = structuredClone(before);
    // Native group IDs and indices may be rebuilt, without guessing URL-based ownership.
    after.tabs[0].groupId = 123; after.tabs[0].index = 99; after.tabs[0].active = false; after.windows[0].focused = false;
    assertTodayMoveReload(before, after, [11, 12]);
    for (const change of [s => s.spaces[1].temporaryTabs.reverse(), s => s.tabs[0].id = 555, s => s.pageStates[12].documentId = 'different',
        s => s.activeSpaces[7] = 'destination', s => s.snapshot.tabs[0].spaceId = 'source', s => s.windows.pop()]) {
        const wrong = structuredClone(after); change(wrong); assert.throws(() => assertTodayMoveReload(before, wrong, [11, 12]));
    }
});

test('server matches only nonce-scoped fixture URLs and gives each navigation a distinct real document', () => {
    const call = url => { let status, headers, body; const served = serveTodayMoveFixture({ url }, { writeHead: (s, h) => { status = s; headers = h; }, end: b => { body = b; } }); return { served, status, headers, body }; };
    assert.equal(call('/today-move/bad/active').served, false); assert.equal(call('/other').served, false);
    const path = `/today-move/${'a'.repeat(32)}/twin`, one = call(path), two = call(path);
    assert(one.served && two.served); assert.equal(one.status, 200); assert.equal(one.headers['Cache-Control'], 'no-store');
    assert.match(one.headers['Content-Security-Policy'], /default-src 'none'/); assert.notEqual(one.body, two.body);
    assert.match(one.body, /id="move-input"/); assert.equal(todayMoveDestination('space-1'), '#tab-context-menu [data-action="moveTodayToDestination"][data-space-id="space-1"]');
});

test('passive DOM probes retain real event trust and content-document identity without dispatch', () => {
    const { document, window } = parseHTML('<html><body data-document-id="response-id"><div class="tab" data-tab-id="11"><span id="target">Tab</span></div><input id="move-input" value="typed"></body></html>');
    const prior = { document: globalThis.document, window: globalThis.window, location: globalThis.location };
    Object.assign(globalThis, { document, window, location: { href: 'http://127.0.0.1/fixture' } });
    try {
        installTodayMoveTrace(); const event = new window.Event('contextmenu', { bubbles: true });
        Object.defineProperty(event, 'isTrusted', { value: false }); document.getElementById('target').dispatchEvent(event);
        assert.equal(globalThis.__todayMoveTrace[0].trusted, false); assert.equal(globalThis.__todayMoveTrace[0].tabId, 11);
        const state = readTodayMovePage(); assert.equal(state.documentId, 'response-id'); assert.equal(state.value, 'typed');
    } finally { for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } delete globalThis.__todayMoveTrace; }
});

const helper = readSourceText(new URL('../../scripts/paired-chrome-today-move.mjs', import.meta.url));
const runner = readSourceText(new URL('../../scripts/paired-chrome-smoke.mjs', import.meta.url));
const native = readSourceText(new URL('../../scripts/paired-chrome-native-split.mjs', import.meta.url));
const workflow = readSourceText(new URL('../../.github/workflows/paired-extension-smoke.yml', import.meta.url));
test('new full cases retain existing stable IDs and real native host, paired refresh, reload and safety gates', () => {
    assert.match(runner, /await step\(stepNames\[40\][\s\S]*?groupSync:false/); assert.match(runner, /await step\(stepNames\[41\][\s\S]*?groupSync:true/);
    assert.match(runner, /nativeSidebar:nativeTodayMoveSidebar/); assert.match(runner, /reloadArcify:\(\)=>reloadPairedExtension\('arcify'\)/);
    const setup = runner.slice(runner.indexOf('async function nativeTodayMoveSidebar'), runner.indexOf('async function reloadPairedExtension'));
    assert.match(setup, /sidebarEnter\(helper.page/); assert.match(setup, /captureNativeSidebar\(eventCount/); assert.match(setup, /resolveNativeSidebarTarget\(\)/);
    const resolver = runner.slice(runner.indexOf('async function resolveNativeSidebarTarget'), runner.indexOf('async function captureNativeSidebar'));
    assert.match(resolver, /hosting.tab === null && hosting.windowId === fixture.windowA/);
    assert.match(resolver, /matching.length <= 1/); assert.match(resolver, /target.asPage\(\)/);
    assert.match(helper, /assert.equal\(hosting.tab, null\)/); assert.match(helper, /assert.equal\(hosting.windowId, windowId\)/);
    assert.match(helper, /page.click\(todayRow\(id\), \{ button: 'right' \}\)/); assert.match(helper, /clickBookmarkFixtureRow\(native.page/);
    assert.match(helper, /assertTodayMoveNativeQuiet\(nativeEvents\)/);
    assert.match(helper, /assertTodayMoveTrace\(trace/); assert.match(helper, /watchTodayInvalidation/); assert.match(helper, /readSpotlightRows/);
    assert.match(helper, /await reloadArcify\(\)/); assert.match(helper, /assertTodayMoveReload\(beforeReload/);
    assert.doesNotMatch(helper, /dispatchEvent|\.click\(\)\s*;|puppeteer\.launch|no-sandbox|disable-web-security|emulateFocus|setViewport/);
    for (const path of ['scripts/paired-chrome-today-move.mjs', 'tests/unit/paired-chrome-today-move.test.js']) assert(workflow.includes(`- '${path}'`));
    assert.match(helper, /native.page.evaluate\(message => chrome.runtime.sendMessage\(message\), rejectedRequest\)/);
    assert.match(native, /sidebar.page.evaluate\(message=>chrome.runtime.sendMessage\(message\),rejectedMoveRequest\)/);
    assert.match(native, /native-split-today-move-rejected/); assert.match(native, /assertNativeSplitRejected\(beforeMoveRejection,afterMoveRejection\)/);
    assert.match(runner, /assertNoTargetCrashes\(report.targetLifecycle\)/); assert.match(runner, /assertNoPageErrors\(report.diagnostics\)/);
});
