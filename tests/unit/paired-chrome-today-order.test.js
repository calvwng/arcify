import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { EventEmitter } from 'node:events';
import { readSourceText } from '../source-text.js';
import { clickTodayOrderSpace, TODAY_ORDER_CASES, visibleTodayOrder, serveTodayOrderFixture, assertTodayOrderState, assertTodayCreated,
    assertTodayOrderUnchanged, assertTodayManualOrder, installTodayOrderTrace, assertTodayOrderInput,
    readTodayOrderProjectionInputs, observeTodayOrderCreation, observeTodayOrderGroupConsole } from '../../scripts/paired-chrome-today-order.mjs';

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

function reloadDiagnosticsSample() {
    const before = sample().before, ids = { arcifyId: 'arcify', spotlightId: 'spotlight' };
    before.windows = [7, 8, 9].map(id => ({ id, type: 'normal', incognito: false }));
    before.activeSpaces[9] = 'control';
    before.spaces.push({ id: 'control', spaceBookmarks: [], temporaryTabs: [902] });
    const pages = Object.values(ids).map((extensionId, index) => {
        const tab = { id: 901 + index, windowId: 9, url: `chrome-extension://${extensionId}/options.html`, pinned: false, incognito: false };
        before.tabs.push({ ...tab, pendingUrl: null, splitViewId: -1 });
        return { extensionId, documentUrl: tab.url, tab };
    });
    before.groupState = { spaces: before.spaces, windows: before.windows, activeSpaces: before.activeSpaces };
    before.fixturePages = { controlWindowId: 9, pages };
    before.selectionRecovery = { continuity: { selection: { anchors: ['independent-before'] } }, receipt: { selectionFingerprint: 'before-digest' } };
    return { before, after: structuredClone(before), ids };
}

test('reload diagnostics leave all original assertions strict and identify the exact failing stage', async () => {
    const { observeTodayReloadAssertions } = await import('../../scripts/paired-chrome-today-order.mjs');
    const valid = reloadDiagnosticsSample();
    assert.equal(observeTodayReloadAssertions(valid.before, valid.after, valid.ids).passed, true);
    const cases = [
        ['fixture-provenance', state => { state.fixturePages.pages[0].documentUrl += '?wrong'; }],
        ['logical-state', state => { state.spaces[0].temporaryTabs.reverse(); }],
        ['window-selection', state => { delete state.groupState.activeSpaces[7]; }],
        ['native-identities', state => { state.tabs[0].url = 'http://unexpected'; }]
    ];
    for (const [stage, mutate] of cases) {
        const { before, after, ids } = reloadDiagnosticsSample(); mutate(after);
        const result = observeTodayReloadAssertions(before, after, ids);
        assert.equal(result.passed, false); assert.equal(result.stage, stage);
        assert.equal(result.assertion.name, 'AssertionError');
        assert(result.assertion.message); assert(result.assertion.stack); assert(result.assertion.operator);
        assert(Object.hasOwn(result.assertion, 'expected')); assert(Object.hasOwn(result.assertion, 'actual'));
        assert.deepEqual(before.selectionRecovery, valid.before.selectionRecovery, 'Observation must not mutate original recovery evidence');
    }
});

test('cleanup diagnostics append without erasing baseline, final assertion, or original failure', async () => {
    const { appendTodayOrderEvidence } = await import('../../scripts/paired-chrome-today-order.mjs');
    const { finishBookmarkFixture } = await import('../../scripts/paired-chrome-bookmark-selection.mjs');
    const evidence = { checkpoints: [] }, writes = [], record = async value => { writes.push(value); };
    const baseline = reloadDiagnosticsSample().before, original = new Error('original reload timeout');
    await appendTodayOrderEvidence(evidence, 'witnessed-reload-baseline', { before: baseline }, record);
    await appendTodayOrderEvidence(evidence, 'today-order-failed', { error: { message: original.message }, reloadDiagnostic: { before: baseline, last: { stage: 'window-selection', assertion: { message: 'exact original mismatch' }, state: { activeSpaces: {} } } } }, record);
    await finishBookmarkFixture([async () => { throw new Error('cleanup failed'); }], original,
        event => appendTodayOrderEvidence(evidence, event.phase, { errors: event.errors }, record));
    assert.deepEqual(writes.at(-1).checkpoints.map(item => item.phase), ['witnessed-reload-baseline', 'today-order-failed', 'cleanup-failed']);
    assert.deepEqual(writes.at(-1).checkpoints[0].before, baseline);
    assert.equal(writes.at(-1).checkpoints[1].error.message, original.message);
    assert.equal(writes.at(-1).checkpoints[1].reloadDiagnostic.last.assertion.message, 'exact original mismatch');
    assert.deepEqual(original.cleanupErrors, ['cleanup failed']);
    assert.equal(writes[0].checkpoints.length, 1, 'Previously emitted evidence is frozen');
    await assert.rejects(finishBookmarkFixture([async () => { throw new Error('cleanup-only failure'); }], null,
        event => appendTodayOrderEvidence(evidence, event.phase, { errors: event.errors }, record)), AggregateError);
    assert.equal(writes.at(-1).checkpoints.length, 4);
});

test('reload diagnostics capture before reload, retain final failed poll and append cleanup evidence', () => {
    const source = readSourceText(new URL('../../scripts/paired-chrome-today-order.mjs', import.meta.url));
    assert(source.indexOf("await checkpoint('witnessed-reload-baseline'") < source.indexOf('await reloadArcify()'));
    assert.match(source, /favoriteContinuity.*\]/);
    assert.match(source, /favoriteContinuityReceipt/);
    assert.match(source, /selectionRecovery: \{ continuity: local.favoriteContinuity/);
    assert.match(source, /reloadDiagnostic.last = \{ state: structuredClone\(state\), proof: structuredClone\(proof\)/);
    assert.match(source, /stage: result.stage, assertion: result.assertion/);
    assert.match(source, /'today-order-failed'.*reloadDiagnostic/);
    assert.match(source, /event => checkpoint\(event.phase, \{ errors: event.errors \}\)/);
});

async function projectionInputs(local = {}, session = {}, sync = {}) {
    const previous = globalThis.chrome, calls = [];
    globalThis.chrome = { storage: Object.fromEntries(Object.entries({ local, session, sync }).map(([area, values]) =>
        [area, { get: async keys => { assert(Array.isArray(keys)); calls.push({ area, keys }); return structuredClone(values); } }])) };
    try { return { evidence: await readTodayOrderProjectionInputs(), calls }; } finally { globalThis.chrome = previous; }
}
test('projection diagnostics read only exact synthetic keys and exclude unrelated or nested secret fields', async () => {
    const { evidence, calls } = await projectionInputs({ pairingToken: 'DO-NOT-COPY', spaceDurableTodayLayout: { version: 4, revision: 2, secret: 'NESTED-SECRET', cohorts: [] } },
        { recoverySecret: 'SESSION-SECRET', spaceExplicitTodayEpoch: 'synthetic-session-epoch' }, { syncTabGroups: true, token: 'SYNC-SECRET' });
    assert.deepEqual(calls, [
        { area: 'local', keys: ['spaceDurableTodayLayout', 'spaceTabSnapshot', 'spaceRankCheckpoint', 'spaceExplicitTodayCheckpoint'] },
        { area: 'session', keys: ['spaceExplicitTodayEpoch', 'spaceRecoveryCandidates', 'spaceGroupSplitDeferrals'] },
        { area: 'sync', keys: ['syncTabGroups', 'invertTabOrder', 'todayNewTabsAtTop'] }
    ]);
    assert.equal(evidence.complete, false); assert.equal(evidence.unknownFields, 1);
    for (const secret of ['DO-NOT-COPY', 'NESTED-SECRET', 'SESSION-SECRET', 'SYNC-SECRET', 'pairingToken', 'recoverySecret']) assert(!JSON.stringify(evidence).includes(secret));
    assert.equal(evidence.data.sync.syncTabGroups.value, true); assert.equal(evidence.source, 'persisted-inputs-only'); assert.equal(evidence.atomic, false);
    assert(evidence.unavailable.includes('runtime layoutPending'));
});
test('bounded complete terminal checkpoint evidence retains exact bytes needed for offline ledger validation', async () => {
    const { sealDurableLayout, readDurableLayout } = await import('../../durable-today-layout.js');
    const { encodeFavoriteContinuityState } = await import('../../favorite-continuity.js');
    const epoch = { kind: 'session', epoch: 'synthetic-epoch' }, witness = { version: 1, epoch, incarnation: 'i', transaction: 't', windowId: 7, spaceId: 'work', bookmarkFolderId: 'folder' };
    const cohort = { id: 'closed', contextSubset: true, explicitOnly: true, choiceRevision: 1, signature: [{ index: 0, url: 'chrome://newtab/', pinned: false }],
        placements: [{ index: 0, spaceId: 'work', bookmarkFolderId: 'folder', order: 0 }], binding: { epoch, windowId: 7, tabIds: [11] }, overrides: [] };
    const fingerprint = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(encodeFavoriteContinuityState(cohort))))).map(byte => byte.toString(16).padStart(2, '0')).join('');
    const ledger = await sealDurableLayout(2, [cohort], { liveCount: 1, rankFingerprint: 'rank' }, [{ cohortId: 'closed', cohortFingerprint: fingerprint, reason: 'observed-individual-close', revision: 2, closed: [{ index: 0, tabId: 11, witness }] }]);
    const { evidence } = await projectionInputs({ spaceDurableTodayLayout: ledger, spaceTabSnapshot: [{ tabId: 11, tabIndex: 0, url: 'chrome://newtab/', currentOwnership: witness }] });
    assert.equal(evidence.complete, true); assert.deepEqual(evidence.data.local.spaceDurableTodayLayout.value, ledger);
    assert(await readDurableLayout(evidence.data.local.spaceDurableTodayLayout.value));
    assert.deepEqual(evidence.data.local.spaceTabSnapshot.value[0].currentOwnership, witness);
    assert(evidence.unavailable.includes('actual native projection decision'), 'Valid persisted ledger is not proof of the runtime decision');
});
test('projection diagnostics distinguish absent keys, explicit null, and malformed types', async () => {
    const { evidence } = await projectionInputs({ spaceDurableTodayLayout: null, spaceTabSnapshot: 'not-an-array' });
    assert.deepEqual(evidence.data.local.spaceDurableTodayLayout, { present: true, value: null });
    assert.deepEqual(evidence.data.local.spaceExplicitTodayCheckpoint, { present: false });
    assert.equal(evidence.complete, false); assert.equal(evidence.unknownFields, 1);
});
for (const kind of ['array', 'string', 'nodes', 'bytes']) test(`projection diagnostic ${kind} bounds are explicit and cannot be mistaken for complete proof`, async () => {
    const rows = kind === 'string' ? [{ url: 'x'.repeat(3000) }] : kind === 'array' ? Array.from({ length: 300 }, () => ({ tabId: 1 }))
        : Array.from({ length: 256 }, () => ({ tabId: 1, url: 'x'.repeat(2048) }));
    const local = { spaceTabSnapshot: rows };
    if (kind === 'nodes') local.spaceDurableTodayLayout = { cohorts: Array.from({ length: 256 }, () => ({ signature: Array.from({ length: 256 }, () => ({ index: 1, url: 'x', pinned: false })) })) };
    const { evidence } = await projectionInputs(local);
    assert.equal(evidence.complete, false); assert(evidence.truncated > 0 || evidence.measuredBytes > evidence.limits.bytes);
    assert(JSON.stringify(evidence).length < evidence.limits.bytes + 2000);
    if (kind === 'bytes') assert.deepEqual(evidence.data, { omitted: 'byte-budget' });
});

function creationDiagnosticFixture({ failure = false, actionError = null, captureError = null, recordError = false, consoleError = false } = {}) {
    const s = sample({ groupSync: true }), states = [structuredClone(s.after), structuredClone(s.after)];
    if (failure) { states[0].projection = {}; states[1].tabs.at(-1).groupId = -1; }
    const original = Object.freeze(new Error('original poll failure')), records = [], owned = new Set(), counts = { actions: 0, reads: 0, samples: 0, closes: 0, assertions: 0 };
    const args = { phase: 'synthetic-create', before: s.before,
        read: async () => structuredClone(states[counts.reads++]), action: async () => { counts.actions++; if (actionError) throw actionError; return { id: 100 }; },
        onResult: result => owned.add(result.id), onObservation: state => { for (const tab of state.tabs.filter(t => !s.before.tabs.some(old => old.id === t.id))) owned.add(tab.id); },
        captureInputs: async () => { counts.samples++; if (captureError) throw captureError; return { sample: counts.samples }; },
        observeConsole: async () => ({ snapshot: () => ({ warnings: [] }), close: () => { counts.closes++; if (consoleError) throw Error('console close failed'); } }),
        assertCreated: state => { counts.assertions++; return assertTodayCreated(s.before, state, s.request); },
        poll: async (read, accept, label) => { assert.equal(label, 'synthetic-create: one exact created identity at its required visible position'); for (let i = 0; i < states.length; i++) { const state = await read(); if (accept(state)) return state; } throw original; },
        record: async (stage, attempt) => { records.push({ stage, attempt }); if (recordError) throw Error('record failed'); }
    };
    return { args, original, records, owned, counts, states };
}
test('creation failure preserves baseline, first after-action state, first/last assertion and exact original frozen error', async () => {
    const f = creationDiagnosticFixture({ failure: true });
    await assert.rejects(observeTodayOrderCreation(f.args), error => error === f.original);
    assert.deepEqual(f.counts, { actions: 1, reads: 2, samples: 3, closes: 1, assertions: 2 }); assert.deepEqual([...f.owned], [100]);
    assert.deepEqual(f.records.map(r => r.stage), ['creation-attempt-started', 'creation-attempt-finished']);
    const started = f.records[0].attempt, ended = f.records[1].attempt;
    assert.deepEqual(started.before, f.args.before); assert.equal(started.afterAction, undefined);
    assert.deepEqual(ended.afterAction, f.states[0]); assert.deepEqual(ended.last.state, f.states[1]);
    assert.equal(ended.firstFailure.observation, 1); assert.match(ended.firstFailure.assertion.message, /Number\.isInteger\(groupId\)/);
    assert.equal(ended.last.passed, false); assert.equal(ended.outcome, 'failed'); assert.equal(ended.error.message, f.original.message);
});
test('successful observation retains the original strict oracle and does not add controller reads or action retries', async () => {
    const f = creationDiagnosticFixture(); assert.deepEqual(await observeTodayOrderCreation(f.args), f.states[0]);
    assert.deepEqual(f.counts, { actions: 1, reads: 1, samples: 3, closes: 1, assertions: 1 });
    assert.equal(f.records.at(-1).attempt.outcome, 'passed'); assert.equal(f.records.at(-1).attempt.firstFailure, undefined);
});
for (const mode of ['capture', 'record', 'console']) test(`diagnostic ${mode} failure never replaces the original failed oracle`, async () => {
    const f = creationDiagnosticFixture({ failure: true, captureError: mode === 'capture' ? Error('storage read failed') : null, recordError: mode === 'record', consoleError: mode === 'console' });
    await assert.rejects(observeTodayOrderCreation(f.args), error => error === f.original);
    assert.equal(f.counts.actions, 1); assert.equal(f.counts.reads, 2); assert.equal(f.counts.closes, 1);
    assert.equal(f.records.at(-1).attempt.error.message, f.original.message);
});
test('action failure still preserves the pre-action evidence and never issues an extra observation/controller command', async () => {
    const original = Object.freeze(Error('native create failed')), f = creationDiagnosticFixture({ actionError: original });
    await assert.rejects(observeTodayOrderCreation(f.args), error => error === original);
    assert.equal(f.counts.actions, 1); assert.equal(f.counts.reads, 0); assert.equal(f.counts.samples, 2); assert.equal(f.counts.closes, 1);
    assert.deepEqual(f.records.at(-1).attempt.before, f.args.before); assert.equal(f.records.at(-1).attempt.afterAction, undefined);
});

test('worker-console capture accepts only fresh exact group warnings, bounds records, and removes its listener', async () => {
    const session = new EventEmitter(), commands = []; session.send = async command => { commands.push(command); return {}; };
    const observer = await observeTodayOrderGroupConsole(session);
    const event = { type: 'warning', timestamp: Date.now(), args: [{ value: 'Tab group sync deferred:' }, { className: 'Error', description: 'x'.repeat(2000), preview: { token: 'SECRET-PREVIEW' } }] };
    session.emit('Runtime.consoleAPICalled', { ...event, timestamp: 0 });
    session.emit('Runtime.consoleAPICalled', { ...event, args: [{ value: 'unrelated-secret' }, { description: 'SECRET-OTHER' }] });
    for (let i = 0; i < 25; i++) session.emit('Runtime.consoleAPICalled', event);
    const result = observer.snapshot(); assert.equal(result.warnings.length, 20); assert.equal(result.dropped, 5); assert.equal(result.warnings[0].description.length, 1024);
    assert(!JSON.stringify(result).includes('SECRET')); assert.equal(result.absenceIsNotProof, true); assert.deepEqual(commands, ['Runtime.enable']);
    observer.close(); observer.close(); assert.equal(session.listenerCount('Runtime.consoleAPICalled'), 0);
    session.emit('Runtime.consoleAPICalled', event); assert.equal(observer.snapshot().dropped, 5);
});
test('unavailable worker/session and Runtime enable failure remain diagnostic gaps with no attachment/retry', async () => {
    const absent = await observeTodayOrderGroupConsole(null); assert.equal(absent.snapshot().status, 'unavailable'); absent.close();
    const session = new EventEmitter(); let sends = 0; session.send = async () => { sends++; throw Error('worker went away'); };
    const failed = await observeTodayOrderGroupConsole(session); assert.equal(failed.snapshot().status, 'unavailable'); assert.match(failed.snapshot().error.message, /worker went away/);
    assert.equal(sends, 1); assert.equal(session.listenerCount('Runtime.consoleAPICalled'), 0);
});
test('passive worker lookup has a real bounded deadline and does not later attach when its existing-session promise settles', async () => {
    let release; const held = new Promise(resolve => { release = resolve; });
    const result = await observeTodayOrderGroupConsole(held); assert.match(result.snapshot().error.message, /deadline/);
    const session = new EventEmitter(); session.send = () => assert.fail('A late session cannot start capture'); release(session); await Promise.resolve();
    assert.equal(session.listenerCount('Runtime.consoleAPICalled'), 0); result.close();
});
test('a pending Runtime.enable deadline removes the installed listener and late completion cannot resume capture', async () => {
    const session = new EventEmitter(); let release, sends = 0;
    session.send = () => { sends++; return new Promise(resolve => { release = resolve; }); };
    const observer = await observeTodayOrderGroupConsole(session);
    assert.equal(sends, 1); assert.match(observer.snapshot().error.message, /deadline/);
    assert.equal(session.listenerCount('Runtime.consoleAPICalled'), 0);
    release({}); await Promise.resolve(); assert.equal(session.listenerCount('Runtime.consoleAPICalled'), 0);
    observer.close(); assert.equal(observer.snapshot().status, 'unavailable');
});
test('smoke console adapter observes existing session only and reports missing, ambiguous or changed worker identity', async () => {
    const smoke = readSourceText(new URL('../../scripts/paired-chrome-smoke.mjs', import.meta.url));
    const source = smoke.slice(smoke.indexOf('async function observeTodayOrderConsole()'), smoke.indexOf('// END passive Today-order console adapter'));
    const target = () => ({ type: () => 'service_worker', url: () => 'chrome-extension://arcify/background.js' });
    const original = target(), replacement = target(), sessions = new Map(); let targets = [original];
    const session = new EventEmitter(); session.send = async () => ({}); sessions.set(original, Promise.resolve(session));
    const adapter = runInNewContext(`(${source})`, { browser: { targets: () => targets }, arcifyId: 'arcify', networkTargets: sessions, observeTodayOrderGroupConsole });
    const observer = await adapter(); assert.equal(observer.snapshot().workerChangeGap, false);
    targets = [replacement]; assert.equal(observer.snapshot().workerChangeGap, true); observer.close(); assert.equal(session.listenerCount('Runtime.consoleAPICalled'), 0);
    for (const current of [[], [original, replacement], [replacement]]) {
        targets = current; const missing = await adapter(); assert.equal(missing.snapshot().status, 'unavailable');
        assert.equal(missing.snapshot().workerChangeGap, current.length !== 1); missing.close();
    }
});
test('diagnostic wiring is passive, scoped, and reports worker replacement gaps without new browser/worker/controller operations', () => {
    const capture = readTodayOrderProjectionInputs.toString(); assert.doesNotMatch(capture, /\.set\(|\.remove\(|sendMessage|\.query\(|get\(null\)/);
    const smoke = readSourceText(new URL('../../scripts/paired-chrome-smoke.mjs', import.meta.url));
    const adapter = smoke.slice(smoke.indexOf('async function observeTodayOrderConsole()'), smoke.indexOf('// END passive Today-order console adapter'));
    assert.match(adapter, /networkTargets\.get\(target\)/); assert.match(adapter, /workerChangeGap/);
    assert.doesNotMatch(adapter, /createCDPSession|\.worker\(|waitForTarget|\.newPage\(|\.send\(/);
    const source = readSourceText(new URL('../../scripts/paired-chrome-today-order.mjs', import.meta.url));
    assert.match(source, /onResult: result => \{ if \(Number\.isInteger\(result\?\.id \|\| result\?\.tabId\)\) owned\.add/);
    assert.match(source, /const proof = assertTodayCreated\(before, after/); assert.match(source, /assertTodayNewTabRow\(after\.newTabRow/);
});

test('initial native launcher is removed and observed absent before the creation baseline, without weakening post-reload helper proof', () => {
    const source = readSourceText(new URL('../../scripts/paired-chrome-today-order.mjs', import.meta.url));
    const setup = source.slice(source.indexOf('native = await nativeSidebar();'), source.indexOf("sourceId = await created('browser-api-standalone-top'"));
    assert(setup.indexOf('await native.removeLauncher()') < setup.indexOf('await select()'));
    assert(setup.indexOf('await select()') < setup.indexOf('await waitForTodayMoveHelperCleanup'));
    assert(setup.indexOf('await waitForTodayMoveHelperCleanup') < setup.indexOf('await settle([])'));
    const reopen = source.slice(source.indexOf('native = await nativeSidebar({ revealSpaceId: folder.spaceId })'));
    assert(reopen.includes('assert.equal(newHelper.length, 1)'));
    assert(reopen.includes('const reloadedOrder = [newHelper[0].id, fallback.id, ...manualOrder, bottom]'));
});


function spaceClickHarness(error) {
    const selectors = [], disposed = [], records = []; let clicks = 0;
    const page = { async waitForSelector(selector, options) {
        selectors.push(selector); assert.equal(options.visible, true); assert(options.timeout > 0 && options.timeout <= 20_000);
        const attempt = selectors.length;
        return { async click() { clicks++; if (attempt === 1 && error) throw error; }, async dispose() { disposed.push(attempt); } };
    } };
    return { page, selectors, disposed, records, clicks: () => clicks };
}
function detachedSpaceError(suffix = '') {
    const error = new Error('Node is detached from document');
    error.stack = `Error: Node is detached from document
    at CdpElementHandle.assertConnectedElement (/node_modules/puppeteer-core/lib/puppeteer/api/ElementHandle.js:1300:23)
    at async CdpElementHandle.isIntersectingViewport (/node_modules/puppeteer-core/lib/puppeteer/api/ElementHandle.js:1324:17)
    at async CdpElementHandle.scrollIntoViewIfNeeded (/node_modules/puppeteer-core/lib/puppeteer/api/ElementHandle.js:1310:17)
    at async CdpElementHandle.click (/node_modules/puppeteer-core/lib/puppeteer/api/ElementHandle.js:725:13)${suffix}`;
    return error;
}
test('Today-order Space selection reacquires the exact button after pre-input launcher-cleanup detachment', async () => {
    const h = spaceClickHarness(detachedSpaceError());
    await clickTodayOrderSpace(h.page, 'fixture-space', item => h.records.push(item));
    assert.deepEqual(h.selectors, Array(2).fill('#spaceSwitcher button[data-space-id="fixture-space"]'));
    assert.deepEqual(h.disposed, [1, 2]);
    assert.deepEqual(h.records.map(item => item.status), ['detached-before-input', 'clicked']);
    assert.equal(h.clicks(), 2);
});
for (const error of [new Error('Protocol error (Input.dispatchMouseEvent): failed'), detachedSpaceError('\n    at CdpMouse.click (/mouse.js:1:1)')]) {
    test(`Today-order Space selection never retries uncertain input: ${error.message}`, async () => {
        const h = spaceClickHarness(error);
        await assert.rejects(clickTodayOrderSpace(h.page, 'fixture-space'), value => value === error);
        assert.equal(h.clicks(), 1); assert.equal(h.selectors.length, 1); assert.deepEqual(h.disposed, [1]);
    });
}
test('Today-order setup uses guarded Space selection without weakening post-selection state checks', () => {
    const source = readSourceText('scripts/paired-chrome-today-order.mjs');
    assert.match(source, /await input\('Select exact disposable Today-order Space', \(\) => clickTodayOrderSpace\(native\.page, folder\.spaceId/);
    assert.match(source, /value\.snapshot\.activeSpaceId === folder\.spaceId && value\.rendered\.spaceId === folder\.spaceId/);
});
