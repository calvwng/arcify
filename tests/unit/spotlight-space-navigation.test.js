import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture as baseFixture, success, error } from './spotlight-action-fixture.js';
import { SPACE_NAVIGATION_FEATURE, SPACE_ACTIONS_FEATURE, validateRequest, SPACE_NAVIGATION_COMMANDS } from '../../spotlight-bridge-protocol.js';
const clone = value => structuredClone(value);
const destination = { spaceId: 'target', bookmarkFolderId: 'target-root' };
function fixture() {
    const f = baseFixture();
    f.local.todayOrderRepresentation = { version: 1, inverted: false };
    Object.assign(f.store, { restoredRanks: new Map(), restoreQueue: [], windowKeys: new Map([[10, 'window-ten'], [20, 'window-twenty']]) });
    f.nodes.push({ id: 'target-root', parentId: 'arc', title: 'Target' });
    f.store.spaces.push({ id: 'target', name: 'Target', color: 'red', bookmarkFolderId: 'target-root', temporaryTabs: [5, 6], spaceBookmarks: [], lastTab: 5 });
    f.tabs.push({ id: 5, windowId: 10, index: 3, active: false, title: 'Target last', url: 'https://same.test/' },
        { id: 6, windowId: 20, index: 2, active: false, title: 'Target other window', url: 'https://other.test/' });
    const request = f.request;
    f.request = (command, payload = {}) => request(command, { supportedFeatures: [SPACE_ACTIONS_FEATURE, SPACE_NAVIGATION_FEATURE], ...payload });
    f.captureNavigation = async (tabId = 1) => success(await f.handle(f.request('navigationContext', { tabId }), f.sender));
    f.runNavigation = async (command, captured, fields = {}) => f.handle(f.request(command, { context: captured.actionContext,
        sourceUrl: captured.navigationContext.sourceUrl, destination, ...(command === 'moveCurrentTodayTab' ? { inverted: captured.navigationContext.inverted } : {}), ...fields }), f.sender);
    chrome.tabs.update = async (id, values) => {
        f.effects.push(['focus-tab', id, values]); f.active(id); chrome.tabs.onActivated.emit({ tabId: id, windowId: 10 });
        await f.hooks.focusTab?.(id); return clone(f.tabs.find(tab => tab.id === id));
    };
    chrome.windows.update = async (id, values) => { f.effects.push(['focus-window', id, values]); await f.hooks.focusWindow?.(id); return { id, type: 'normal' }; };
    return f;
}

test('navigation capability is separately negotiated and old actionContext remains exact', async () => {
    const f = fixture();
    const hello = success(await f.handle(f.request('hello', { supportedFeatures: [SPACE_ACTIONS_FEATURE] }), f.sender));
    assert(hello.capabilities.includes(SPACE_ACTIONS_FEATURE)); assert(!hello.capabilities.includes(SPACE_NAVIGATION_FEATURE));
    const old = success(await f.handle(f.request('actionContext', { tabId: 1, supportedFeatures: [SPACE_ACTIONS_FEATURE] }), f.sender));
    assert(!('navigationContext' in old)); assert.deepEqual(Object.keys(old.actionContext), ['windowId', 'spaceId', 'bookmarkFolderId', 'pairingGeneration', 'sourceTabId', 'tab']);
    const captured = await f.captureNavigation(); assert.deepEqual(captured.navigationContext, { destinations: [{ ...destination, name: 'Target' }], inverted: false, sourceUrl: 'https://same.test/' });
    error(await f.runNavigation('switchSpace', captured, { supportedFeatures: [SPACE_ACTIONS_FEATURE] }), 'UNSUPPORTED_FEATURE');
    assert.deepEqual(f.writes(), []);
});

test('new requests reject surplus fields, altered destinations and missing exact witnesses', async () => {
    const f = fixture(), captured = await f.captureNavigation();
    const request = f.request('moveCurrentTodayTab', { context: captured.actionContext, destination, sourceUrl: captured.navigationContext.sourceUrl, inverted: false });
    validateRequest(request, SPACE_NAVIGATION_COMMANDS);
    for (const patch of [{ destination: { ...destination, name: 'Target' } }, { destination: { spaceId: 'space', bookmarkFolderId: 'root' } },
        { destination: { spaceId: 'target' } }, { sourceUrl: undefined }, { inverted: undefined }, { tabId: 3 }, { context: { ...captured.actionContext, tab: null } }])
        assert.throws(() => validateRequest({ ...request, ...patch }, SPACE_NAVIGATION_COMMANDS), { code: 'INVALID_REQUEST' });
    assert.throws(() => validateRequest(f.request('openSettings', { context: captured.actionContext, destination }), ['openSettings']), { code: 'INVALID_REQUEST' });
});

for (const inverted of [false, true]) test(`move uses canonical core without nested queue, appends visible bottom (${inverted}), preserves focus and selected source`, async () => {
    const f = fixture(); f.local.todayOrderRepresentation.inverted = inverted;
    const captured = await f.captureNavigation(), beforeTabs = clone(f.tabs), active = clone(f.store.active);
    assert.equal(captured.navigationContext.inverted, inverted);
    const result = success(await f.runNavigation('moveCurrentTodayTab', captured));
    assert.equal(result.tabId, 1); assert.equal(result.spaceId, 'target');
    assert.deepEqual(f.store.spaces[0].temporaryTabs, [3]);
    assert.deepEqual(f.store.spaces[1].temporaryTabs, inverted ? [1, 5, 6] : [5, 6, 1]);
    assert.deepEqual(f.tabs, beforeTabs); assert.deepEqual(f.store.active, active);
    assert(!f.effects.some(([kind]) => kind.startsWith('focus') || kind.includes('bookmark') || kind.includes('tab-')));
    assert.equal(f.effects.find(([kind]) => kind === 'persist')[1].skipGroupSync, true);
});

for (const kind of ['helper', 'helper-slash', 'favorite', 'native-pin', 'split', 'saved', 'provisional', 'recovery', 'ambiguous']) test(`move excludes ${kind} without borrowing a same-URL tab`, async () => {
    const f = fixture();
    if (kind === 'helper' || kind === 'helper-slash') f.tabs[0].url = `chrome://newtab${kind.endsWith('slash') ? '/' : ''}`;
    if (kind === 'favorite') f.globalTabs.add(1);
    if (kind === 'native-pin') f.tabs[0].pinned = true;
    if (kind === 'split') f.tabs[0].splitViewId = 0;
    if (kind === 'saved') f.active(2);
    if (kind === 'provisional') f.store.provisional.add(1);
    if (kind === 'recovery') f.store.recoveryCandidates.add(1);
    if (kind === 'ambiguous') f.store.spaces[1].temporaryTabs.push(1);
    const captured = await f.captureNavigation(kind === 'saved' ? 2 : 1);
    assert.notEqual(captured.actionContext.tab?.section, 'today');
    error(await f.runNavigation('moveCurrentTodayTab', captured), 'INVALID_REQUEST'); assert.deepEqual(f.writes(), []);
});

for (const change of ['target-id', 'target-folder', 'duplicate-folder', 'target-root-parent', 'source-folder', 'active-tab', 'active-space', 'source-url', 'source-binding', 'target-removed', 'pairing', 'inversion']) test(`move refuses stale ${change} before mutation`, async () => {
    const f = fixture(), captured = await f.captureNavigation();
    if (change === 'target-id') f.store.spaces[1].id = 'replacement';
    if (change === 'target-folder') f.store.spaces[1].bookmarkFolderId = 'replacement-root';
    if (change === 'duplicate-folder') f.store.spaces.push({ ...clone(f.store.spaces[1]), id: 'duplicate', temporaryTabs: [] });
    if (change === 'target-root-parent') f.nodes.at(-1).parentId = 'bar';
    if (change === 'source-folder') f.store.spaces[0].bookmarkFolderId = 'replacement';
    if (change === 'active-tab') f.active(3);
    if (change === 'active-space') f.store.active[10] = 'target';
    if (change === 'source-url') f.tabs[0].url = 'https://changed.test/';
    if (change === 'source-binding') f.local.pinnedTabStatesById[1] = { bookmarkId: 'twin', pinnedUrl: f.tabs[0].url };
    if (change === 'target-removed') f.store.spaces.pop();
    if (change === 'pairing') f.local.arcifyBridgePairingGeneration = 'repaired';
    if (change === 'inversion') { f.local.todayOrderRepresentation.inverted = true; }
    error(await f.runNavigation('moveCurrentTodayTab', captured)); assert.deepEqual(f.writes(), []);
});

for (const command of ['switchSpace', 'moveCurrentTodayTab']) for (const phase of ['bookmark-read', 'final-native-read', 'persist-boundary']) test(`${command} fences pairing revocation at ${phase}`, async () => {
    const f = fixture(), captured = await f.captureNavigation(); let once = false;
    const revoke = () => { if (!once) { once = true; f.local.arcifyBridgePeerId = ''; } };
    if (phase === 'bookmark-read') f.hooks.bookmarkSearch = revoke;
    if (phase === 'final-native-read') f.hooks.tabAfterQuery = revoke;
    if (phase === 'persist-boundary') f.hooks.persist = revoke;
    error(await f.runNavigation(command, captured)); assert.deepEqual(f.writes(), []);
    assert.equal(f.store.active[10], 'space'); assert(f.store.spaces[0].temporaryTabs.includes(1));
});

for (const kind of ['last-tab', 'fallback', 'empty', 'only-other-window']) test(`switch uses existing activateSpace ${kind} semantics`, async () => {
    const f = fixture();
    if (kind === 'fallback') f.store.spaces[1].lastTab = 999;
    if (kind === 'empty') f.store.spaces[1].temporaryTabs = [];
    if (kind === 'only-other-window') f.store.spaces[1].temporaryTabs = [6];
    const captured = await f.captureNavigation(), before = clone(f.store.spaces);
    const result = success(await f.runNavigation('switchSpace', captured));
    assert.equal(result.spaceId, 'target'); assert.equal(f.store.active[10], 'target'); assert.equal(f.store.active[20], 'space');
    assert.deepEqual(f.store.spaces, before);
    const expected = ['empty', 'only-other-window'].includes(kind) ? null : 5;
    assert.equal(result.tabId, expected); assert.equal(f.tabs.find(tab => tab.windowId === 10 && tab.active).id, expected || 1);
    assert.deepEqual(f.effects.filter(([kind]) => kind.startsWith('focus')).map(([kind, id]) => [kind, id]), expected ? [['focus-tab', 5], ['focus-window', 10]] : []);
});

for (const phase of ['after-persist', 'after-tab-focus', 'after-window-focus']) test(`switch reports partial at ${phase}, stops later focus, and never replays a mutation`, async () => {
    const f = fixture(), captured = await f.captureNavigation();
    const revoke = () => { f.local.arcifyBridgePeerId = ''; };
    if (phase === 'after-persist') f.hooks.storageAfterSet = (area, values) => { if (values.activeSpaces) revoke(); };
    if (phase === 'after-tab-focus') f.hooks.focusTab = revoke;
    if (phase === 'after-window-focus') f.hooks.focusWindow = revoke;
    const request = f.request('switchSpace', { context: captured.actionContext, sourceUrl: captured.navigationContext.sourceUrl, destination });
    error(await f.handle(request, f.sender), 'PARTIAL_COMMIT');
    const writes = f.writes().length; f.local.arcifyBridgePeerId = f.sender.id;
    // This fixture does not model a full browser restart/rehydration.
    f.store.initialized = true;
    error(await f.handle(request, f.sender), 'UNCERTAIN_RESULT'); assert.equal(f.writes().length, writes);
    assert.equal(f.effects.filter(([kind]) => kind === 'focus-window').length, phase === 'after-window-focus' ? 1 : 0);
});

test('move post-commit revocation is partial, never rolls back or retries', async () => {
    const f = fixture(), captured = await f.captureNavigation();
    f.hooks.storageAfterSet = (area, values) => { if (values.spaces) f.local.arcifyBridgePeerId = ''; };
    error(await f.runNavigation('moveCurrentTodayTab', captured), 'PARTIAL_COMMIT');
    assert.deepEqual(f.local.spaces[1].temporaryTabs, [5, 6, 1]);
    assert.equal(f.effects.filter(([kind, area, values]) => kind === 'storage' && values.spaces).length, 1);
    assert(!f.effects.some(([kind]) => kind.startsWith('focus')));
});

for (const changed of ['selected-space', 'source-focus', 'destination-moved', 'destination-split']) test(`switch refuses stale ${changed}`, async () => {
    const f = fixture(), captured = await f.captureNavigation();
    if (changed === 'selected-space') f.store.active[10] = 'target';
    if (changed === 'source-focus') f.active(3);
    if (changed === 'destination-moved') f.tabs.find(tab => tab.id === 5).windowId = 20;
    if (changed === 'destination-split') f.tabs.find(tab => tab.id === 5).splitViewId = 0;
    // A destination that loses its only local tab before selection is now empty,
    // so no stale focus is attempted and the empty-Space contract still applies.
    const result = await f.runNavigation('switchSpace', captured);
    if (changed === 'destination-moved') { success(result); assert.equal(result.tabId, null); }
    else { error(result); assert.deepEqual(f.writes(), []); }
});

test('switch catches target identity drift at the final persistence boundary', async () => {
    const f = fixture(), captured = await f.captureNavigation();
    f.hooks.persist = () => { f.store.spaces[1].bookmarkFolderId = 'replacement'; };
    error(await f.runNavigation('switchSpace', captured), 'STALE_CONTEXT');
    assert.deepEqual(f.writes(), []); assert.equal(f.store.active[10], 'space');
});

test('switch tolerates only the exact delayed event of its committed focus', async () => {
    const f = fixture(), captured = await f.captureNavigation();
    f.hooks.focusTab = id => { f.hooks.bookmarkSearch = () => chrome.tabs.onActivated.emit({ windowId: 10, tabId: id }); };
    success(await f.runNavigation('switchSpace', captured));
    assert.equal(f.effects.filter(([kind]) => kind === 'focus-tab').length, 1);
});

test('a delayed unrelated activation prevents the next focus boundary', async () => {
    const f = fixture(), captured = await f.captureNavigation();
    f.hooks.focusTab = () => { f.hooks.bookmarkSearch = () => chrome.tabs.onActivated.emit({ windowId: 10, tabId: 3 }); };
    error(await f.runNavigation('switchSpace', captured), 'PARTIAL_COMMIT');
    assert(!f.effects.some(([kind]) => kind === 'focus-window'));
});

test('navigation context observes legacy ordering without initializing storage', async () => {
    const f = fixture(); delete f.local.todayOrderRepresentation;
    const captured = await f.captureNavigation();
    assert.equal(captured.navigationContext.inverted, true); assert.deepEqual(f.writes(), []);
});

for (const legacy of [false, true]) test(`late ${legacy ? 'legacy' : 'canonical'} inversion change is fenced before the membership write`, async () => {
    const f = fixture();
    if (legacy) { delete f.local.todayOrderRepresentation; await chrome.storage.sync.set({ invertTabOrder: false }); f.effects.length = 0; }
    const captured = await f.captureNavigation(); let changed = false;
    f.hooks.persist = () => {
        let reads = 0;
        f.hooks.tabAfterQuery = async () => {
            if (++reads !== 3 || changed) return;
            changed = true;
            if (legacy) await chrome.storage.sync.set({ invertTabOrder: true });
            else await chrome.storage.local.set({ todayOrderRepresentation: { version: 1, inverted: true } });
        };
    };
    error(await f.runNavigation('moveCurrentTodayTab', captured)); assert(changed);
    assert(!f.effects.some(([kind, area, values]) => kind === 'storage' && (values.spaces || values.activeSpaces)));
    assert(f.store.spaces[0].temporaryTabs.includes(1));
});

for (const helper of ['chrome://newtab?query=yes', 'chrome://newtab/#fragment', 'chrome://newtab/?query=yes#fragment']) test(`exact helper exclusion is shared for source and destination: ${helper}`, async () => {
    const f = fixture(), captured = await f.captureNavigation();
    f.tabs.find(tab => tab.id === 5).url = helper;
    error(await f.runNavigation('switchSpace', captured)); assert.deepEqual(f.writes(), []);
    f.tabs[0].url = helper; captured.actionContext.tab.url = helper; captured.navigationContext.sourceUrl = helper;
    error(await f.runNavigation('moveCurrentTodayTab', captured)); assert.deepEqual(f.writes(), []);
    const actual = await f.captureNavigation(); assert.equal(actual.actionContext.tab, null);
});

for (const command of ['switchSpace', 'moveCurrentTodayTab']) test(`${command} rechecks pairing after the final awaited capability read, before any Space write`, async () => {
    const f = fixture(), captured = await f.captureNavigation(); let finalChecks = 0, staging = false;
    f.store.favoriteStore = { initialize: async () => {}, reconcile: async () => {}, requiresOrdinaryCapability: async () => {
        if (staging && ++finalChecks === 2) f.local.arcifyBridgePairingGeneration = 'repaired-without-event';
        return false;
    } };
    f.hooks.persist = () => { staging = true; };
    error(await f.runNavigation(command, captured), 'UNAUTHORIZED');
    assert.equal(finalChecks, 2); assert.deepEqual(f.writes(), []);
});
