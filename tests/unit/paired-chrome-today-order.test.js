import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { readSourceText } from '../source-text.js';
import { TODAY_ORDER_CASES, visibleTodayOrder, serveTodayOrderFixture, assertTodayOrderState, assertTodayCreated,
    assertTodayOrderUnchanged, assertTodayManualOrder, installTodayOrderTrace, assertTodayOrderInput } from '../../scripts/paired-chrome-today-order.mjs';

function project(state, spaceId = 'work') {
    state.snapshot = { windowId: 7, activeSpaceId: spaceId,
        tabs: state.tabs.filter(tab => tab.windowId === 7).map(tab => ({ ...tab, spaceId: state.spaces.find(space => [...space.temporaryTabs, ...space.spaceBookmarks].includes(tab.id))?.id })),
        spaces: state.spaces.map(space => ({ id: space.id, temporaryTabIds: space.temporaryTabs.filter(id => state.tabs.some(tab => tab.id === id && tab.windowId === 7)) })) };
    state.rendered = { spaceId, inverted: String(state.representation.inverted), ids: visibleTodayOrder(state.spaces[0].temporaryTabs, state.representation.inverted), visible: state.spaces[0].temporaryTabs.map(() => true), savedRootIds: ['pin-a', 'folder', 'pin-b'] };
}
function sample({ inverted = false, groupSync = false, atTop = true, afterTabId = null, requireOpener = false, activate = false } = {}) {
    const native = (id, windowId, index) => ({ id, windowId, index, url: `http://fixture/${id === 12 ? 11 : id}`, pendingUrl: null,
        pinned: false, incognito: false, active: id === 11 || id === 90, groupId: groupSync && windowId === 7 ? 71 : -1, splitViewId: -1, openerTabId: null, status: 'complete' });
    const before = { tabs: [native(11, 7, 0), native(12, 7, 1), native(13, 7, 2), native(90, 8, 0)],
        spaces: [{ id: 'work', bookmarkFolderId: 'root', spaceBookmarks: [], temporaryTabs: visibleTodayOrder([11, 12, 13], inverted) },
            { id: 'other', bookmarkFolderId: 'other-root', spaceBookmarks: [], temporaryTabs: [90] }],
        bookmarks: [{ id: 'pin-a', index: 0 }, { id: 'folder', index: 1 }, { id: 'pin-b', index: 2 }],
        bindings: {}, aliases: { 90: { name: 'Keep' } }, favorites: [{ id: 'favorite', url: 'http://fixture/11' }], representation: { version: 1, inverted },
        windows: [{ id: 7, focused: true }, { id: 8, focused: false }], activeSpaces: { 7: 'work', 8: 'other' },
        groups: groupSync ? [{ id: 71, windowId: 7 }] : [], projection: groupSync ? { 'work:7': 71 } : {} };
    if (groupSync) before.spaces[0].temporaryTabs.forEach((id, index) => { before.tabs.find(tab => tab.id === id).index = index; });
    project(before);
    const after = structuredClone(before), added = native(100, 7, 3); added.active = activate; added.openerTabId = requireOpener ? afterTabId : null;
    after.tabs.push(added); if (activate) after.tabs.filter(tab => tab.windowId === 7 && tab.id !== 100).forEach(tab => { tab.active = false; });
    const expectedVisible = [...before.rendered.ids];
    if (afterTabId !== null) expectedVisible.splice(expectedVisible.indexOf(afterTabId) + 1, 0, 100);
    else if (atTop) expectedVisible.unshift(100); else expectedVisible.push(100);
    after.spaces[0].temporaryTabs = visibleTodayOrder(expectedVisible, inverted);
    if (groupSync) after.spaces[0].temporaryTabs.forEach((id, index) => { after.tabs.find(tab => tab.id === id).index = index; });
    project(after);
    return { before, after, request: { spaceId: 'work', windowId: 7, inverted, groupSync, atTop, afterTabId, requireOpener, activate }, expectedVisible };
}

for (const inverted of [false, true]) for (const groupSync of [false, true]) for (const atTop of [false, true]) {
    test(`standalone exact order: frozen inversion=${inverted}, group sync=${groupSync}, prospective top=${atTop}`, () => {
        const state = sample({ inverted, groupSync, atTop }); const result = assertTodayCreated(state.before, state.after, state.request);
        assert.equal(result.tabId, 100); assert.deepEqual(result.expectedVisible, state.expectedVisible);
    });
    test(`trusted child exact order ignores standalone preference: inversion=${inverted}, sync=${groupSync}, top=${atTop}`, () => {
        const state = sample({ inverted, groupSync, atTop, afterTabId: 12, requireOpener: true, activate: true });
        const result = assertTodayCreated(state.before, state.after, state.request); assert.equal(result.openerTabId, 12); assert.deepEqual(result.expectedVisible, [11, 12, 100, 13]);
    });
}
for (const [name, change] of Object.entries({
    noCreation: s => s.after.tabs.pop(), doubleCreation: s => s.after.tabs.push({ ...s.after.tabs.at(-1), id: 101 }),
    replacedTab: s => s.after.tabs[0].id = 999, closedTab: s => s.after.tabs.splice(1, 1),
    oldNavigation: s => s.after.tabs[0].url = 'http://other', wrongCreatedWindow: s => s.after.tabs.at(-1).windowId = 8,
    nativePin: s => s.after.tabs.at(-1).pinned = true, incognito: s => s.after.tabs.at(-1).incognito = true,
    unsettledDocument: s => s.after.tabs.at(-1).status = 'loading', pendingNavigation: s => s.after.tabs.at(-1).pendingUrl = 'http://fixture/pending',
    lostOpener: s => s.after.tabs.at(-1).openerTabId = 11, staleSnapshot: s => s.after.snapshot.spaces[0].temporaryTabIds = s.before.spaces[0].temporaryTabs,
    snapshotWrongOwner: s => s.after.snapshot.tabs.find(tab => tab.id === 100).spaceId = 'other',
    duplicateOwnership: s => s.after.spaces[1].temporaryTabs.push(100), wrongCanonical: s => s.after.spaces[0].temporaryTabs.reverse(),
    wrongVisible: s => s.after.rendered.ids.reverse(), invisibleRow: s => s.after.rendered.visible[0] = false,
    wrongRenderedSpace: s => s.after.rendered.spaceId = 'other', wrongRenderedOrientation: s => s.after.rendered.inverted = 'true',
    changedOrientation: s => s.after.representation.inverted = true, migratedVersion: s => s.after.representation.version = 2,
    bookmarkReorder: s => s.after.bookmarks.reverse(), pinnedBinding: s => s.after.bindings[100] = { bookmarkId: 'pin-a' },
    aliasTransfer: s => s.after.aliases[100] = { name: 'Copied' }, favoriteMutation: s => s.after.favorites = [],
    focusedOtherWindow: s => s.after.windows.reverse(), otherWindowSelection: s => s.after.activeSpaces[8] = 'work',
    otherWindowMutation: s => s.after.tabs.find(tab => tab.id === 90).index = 8,
    disabledNativeReorder: s => s.after.tabs.find(tab => tab.id === 13).index = -1,
    disabledRegroup: s => s.after.tabs[0].groupId = 20, disabledGroupMetadata: s => s.after.groups.push({ id: 71 }),
    disabledProjection: s => s.after.projection['work:7'] = 71, sourceNewOwner: s => s.after.spaces[1].temporaryTabs.push(11),
    unexpectedActivation: s => s.after.tabs[0].active = false
})) test(`creation evidence rejects ${name}`, () => {
    const s = sample({ afterTabId: 12, requireOpener: true }); change(s); assert.throws(() => assertTodayCreated(s.before, s.after, s.request));
});
for (const [name, change] of Object.entries({
    missingGroup: s => delete s.after.projection['work:7'], wrongCanonicalNativeOrder: s => s.after.tabs[0].index = 99,
    outsideGroup: s => s.after.tabs.at(-1).groupId = -1, wrongGroupMember: s => s.after.tabs.find(tab => tab.id === 90).groupId = 71
})) test(`enabled projection rejects ${name}`, () => { const s = sample({ groupSync: true }); change(s); assert.throws(() => assertTodayCreated(s.before, s.after, s.request)); });

test('non-creation settings/activation/navigation proof requires existing exact order in all authorities', () => {
    const { before, request } = sample(), after = structuredClone(before); after.tabs[0].active = false; after.tabs[1].active = true; after.tabs[0].url = 'http://navigated';
    assertTodayOrderUnchanged(before, after, request);
    for (const mutate of [s => s.spaces[0].temporaryTabs.reverse(), s => s.rendered.ids.reverse(), s => s.snapshot.spaces[0].temporaryTabIds.reverse(), s => s.representation.inverted = true, s => s.bookmarks.reverse(), s => s.tabs.push({ id: 100 })]) {
        const bad = structuredClone(after); mutate(bad); assert.throws(() => assertTodayOrderUnchanged(before, bad, request));
    }
});

test('served link explicitly preserves browser opener and has distinct documents without script injection', () => {
    const request = { url: '/today-order/0123456789abcdef0123456789abcdef/source' }, bodies = [];
    for (let index = 0; index < 2; index++) {
        let headers, body;
        assert.equal(serveTodayOrderFixture(request, { writeHead(status, value) { assert.equal(status, 200); headers = value; }, end(value) { body = value; } }), true);
        assert.equal(headers['Cache-Control'], 'no-store'); assert.match(body, /target="_blank" rel="opener"/); assert.match(body, /id="today-order-child"/); assert.match(body, /href="\/today-order\/0123456789abcdef0123456789abcdef\/source-child"/);
        assert.doesNotMatch(body, /<script|onclick|window\.open/); bodies.push(body.match(/data-document-id="([a-f0-9]{32})"/)[1]);
    }
    assert.notEqual(bodies[0], bodies[1]);
    for (const url of ['/unrelated', '/today-order/bad/source', '/today-order/0123456789abcdef0123456789abcdef/<script>']) assert.equal(serveTodayOrderFixture({ url }, { writeHead() { assert.fail(); } }), false);
});

test('passive positive input evidence rejects synthetic, missing, duplicate or wrong-target delivery', () => {
    const expected = { type: 'click', elementId: 'today-order-child' }, event = { ...expected, trusted: true };
    assertTodayOrderInput([event], expected);
    for (const events of [[], [event, event], [{ ...event, trusted: false }], [{ ...event, elementId: 'wrong' }], [{ ...event, type: 'contextmenu' }]]) assert.throws(() => assertTodayOrderInput(events, expected));
    const listeners = {}, context = { document: { addEventListener(type, listener, options) { assert.equal(options.passive, true); listeners[type] = listener; } } };
    runInNewContext(`(${installTodayOrderTrace.toString()})()`, context);
    listeners.click({ type: 'click', isTrusted: true, target: { closest(selector) { return selector === '[id]' ? { id: 'today-order-child' } : null; } } });
    assert.equal(context.__todayOrderTrace.length, 1); assert.equal(context.__todayOrderTrace[0].trusted, true); assert.equal(context.__todayOrderTrace[0].elementId, 'today-order-child');
});

test('mandatory real fixture remains browser-free on import and uses trusted input, exact snapshots and witnessed reload', () => {
    const source = readSourceText(new URL('../../scripts/paired-chrome-today-order.mjs', import.meta.url));
    const smoke = readSourceText(new URL('../../scripts/paired-chrome-smoke.mjs', import.meta.url));
    for (const name of TODAY_ORDER_CASES) assert(smoke.includes(`'${name}'`));
    assert.match(source, /process\.env\.GITHUB_ACTIONS, 'true'/); assert.match(source, /process\.getuid\?\.\(\), 0/);
    assert.doesNotMatch(source, /puppeteer\.launch|dispatchEvent|userGesture|window\.open\(|chrome\.storage\.(?:local|sync)\.set|no-sandbox|disable-web-security/);
    assert.match(source, /sourcePage\.click\('#today-order-child'\)/); assert.match(source, /requireOpener: true/);
    assert.match(source, /native\.page\.click\('#tab-context-menu \[data-action="duplicate"\]'\)/);
    assert.match(source, /bridge\('openTab'/); assert.match(source, /bridge\('navigateTab'/); assert.match(source, /bridge\('activateTab'/);
    assert.match(source, /locateFreshDragGeometry/); assert.match(source, /mouse\.down\(\)/); assert.match(source, /mouse\.up\(\)/);
    assert.match(source, /waitForTodayMoveHelperCleanup/); assert.match(source, /await reloadArcify\(\)/); assert.match(source, /fixture-isolation-restored/);
    assert.match(source, /saved roots visibly reverse while exact Today order stays unchanged/);
    assert.match(source, /saved roots visibly return while exact Today order stays unchanged/);
    assert.match(source, /await cleanupNewTabFixtureSpace/);
    assert.match(source, /assertReloadFixtureProvenance\(beforeReload, state/); assert.match(source, /controlReplacement: reloadReceipt/);
    assert.match(source, /chrome\.tabs\.onCreated\.addListener\(created\)/); assert.match(source, /chrome\.tabs\.onRemoved\.addListener\(removed\)/);
    assert.match(source, /assertReloadWindowSelection\(initial, state\)/);
    assert.equal((source.match(/revealSpaceId:/g) || []).length, 1, 'Only the post-reload acquisition may request a switcher reveal.');
    assert(source.indexOf('nativeSidebar({ revealSpaceId: folder.spaceId })') > source.indexOf('await reloadArcify()'));
    assert.match(source, /title: `Today Order \$\{nonce\.slice\(0, 6\)\}`/);
    const capture = smoke.slice(smoke.indexOf('async function captureNativeSidebar'), smoke.indexOf('async function closeNativeSidebar'));
    assert.doesNotMatch(capture, /revealNativeSidebarSpace|mouse\.|scrollIntoView|\.focus\(|setViewport/);
    assert.match(capture, /createNativeSidebarReadiness\(arcifyId\)/); assert.match(capture, /assertNativeSidebarScreenshot/);
});

for (const inverted of [false, true]) for (const groupSync of [false, true]) test(`manual reorder keeps exact identity, saved order and native policy inverted=${inverted}, sync=${groupSync}`, () => {
    const { before, request } = sample({ inverted, groupSync }), after = structuredClone(before), expectedVisible = [13, 11, 12];
    after.spaces[0].temporaryTabs = visibleTodayOrder(expectedVisible, inverted);
    if (groupSync) after.spaces[0].temporaryTabs.forEach((id, index) => { after.tabs.find(tab => tab.id === id).index = index; });
    project(after); assertTodayManualOrder(before, after, { ...request, expectedVisible });
    for (const mutate of [s => s.tabs.pop(), s => s.tabs.push({ id: 100 }), s => s.tabs[0].active = false, s => s.tabs[0].url = 'http://wrong', s => s.spaces[1].temporaryTabs = [], s => s.bookmarks.reverse(), s => s.spaces[0].spaceBookmarks = [11]]) {
        const bad = structuredClone(after); mutate(bad); assert.throws(() => assertTodayManualOrder(before, bad, { ...request, expectedVisible }));
    }
});

test('a single correctly placed ID cannot hide navigation to an unintended destination', () => {
    const s = sample(); s.request.expectedUrl = s.after.tabs.at(-1).url; assertTodayCreated(s.before, s.after, s.request);
    s.after.tabs.at(-1).url = 'http://unexpected'; assert.throws(() => assertTodayCreated(s.before, s.after, s.request));
});
