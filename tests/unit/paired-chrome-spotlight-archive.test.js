// Import-safe proof-oracle tests. Every fixture below is explicitly mocked;
// actual native/trusted-input acceptance remains mandatory in the hosted job.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { readSourceText } from '../source-text.js';
import { finishBookmarkFixture } from '../../scripts/paired-chrome-bookmark-selection.mjs';
import { registerFavoriteMessages } from '../../favorite-store.js';
import { planNativeSidebarSpaceReveal, revealNativeSidebarSpace } from '../../scripts/paired-chrome-sidebar.mjs';
import { installArchiveSelectionObservation,readArchiveSelectionEvidence,assertArchiveTrustedInput, readNativeArchivePopup, assertNativeArchiveToggle, assertNativeArchivePopup, installArchiveButtonObservation, exerciseArchivePopupButtonRoundTrip, assertArchiveOpenRequest, assertArchiveNativeAck,
    assertArchiveReopenRequest, waitForArchiveReopenCompletion, readArchiveDestinationDocument, captureArchiveReopenedDestination, assertArchiveCachedReplay, assertArchiveNoMutation, assertArchiveReopened, installArchiveInputObservation, installArchiveIntentObservation, readArchiveIntentObservation, observeArchiveDisplayWorker, probeArchiveDisplayRegistration, exerciseArchiveExistingPanel, installArchiveStatusObservation, readArchiveActivation, probeArchiveOpenWithoutGesture, assertArchiveNoGestureRejection,
    readArchiveDocumentStatus, collectArchiveOpenFailure, readArchiveReopenJournal, collectArchiveReopenFailure, withArchiveFailureEvidence,
    readArchiveFixtureSource, assertArchiveFixtureSource, sendArchiveFixtureRequest, installArchiveFixtureMessageObservation, assertArchiveFixtureSender,
    ARCHIVE_FEATURES, ARCHIVE_OPEN_TYPE, ARCHIVE_ENTRY_TYPE } from '../../scripts/paired-chrome-spotlight-archive.mjs';
const copy = value => structuredClone(value), ARCIFY = 'a'.repeat(32), SPOTLIGHT = 'b'.repeat(32), URL = 'http://127.0.0.1:9999/same';
const source = readSourceText(new globalThis.URL('../../scripts/paired-chrome-spotlight-archive.mjs', import.meta.url));
const input = ({ type = ARCHIVE_OPEN_TYPE, title = 'Open Archive', entryId = null, method = 'Enter' } = {}) => ({ type: method === 'Enter' ? 'keydown' : 'click', trusted: true,
    key: method === 'Enter' ? 'Enter' : null, button: method === 'Enter' ? null : 0, repeat: false, composing: false, shift: false, ctrl: false, alt: false, meta: false, resultType: type, title, entryId });
const entry = { entryId: 'chosen', name: 'Original title', url: URL, spaceId: 'original', archivedAt: 1000, proof: { opaque: 'retained legacy detail' } };
const twin = { ...copy(entry), entryId: 'twin', name: 'Other title', archivedAt: 999 };
const context = { windowId: 7, sourceTabId: 10, sourceUrl: URL, spaceId: 'selected', bookmarkFolderId: 'selected-root', pairingGeneration: 'generation' };
const reopen = { type: 'arcify-bridge', version: 1, command: 'reopenArchivedTab', requestId: 'request', windowId: 7, context, viewId: 'private-view', entryId: entry.entryId, supportedFeatures: [...ARCHIVE_FEATURES] };
const external = message => ({ type: 'external', data: { message, sender: { id: SPOTLIGHT, url: `chrome-extension://${SPOTLIGHT}/background.js` } } });
const openRequest = { type: 'arcify-archive-open', version: 1, requestId: 'open-request', token: 'one-use-token' };
const openEvents = () => [external({ type: 'arcify-bridge', command: 'archiveContext', tabId: 10, windowId: 7 }),
    { ...external(openRequest), data: { message: copy(openRequest), sender: { id: SPOTLIGHT, url: URL } } }];
const native = { context: { contextId: 'native-context', documentId: 'native-document', documentUrl: `chrome-extension://${ARCIFY}/sidebar.html`, contextType: 'SIDE_PANEL', windowId: -1 }, hosting: { tab: null, windowId: 7 } };
const nativeState = (open = true) => ({ url: `chrome-extension://${ARCIFY}/sidebar.html`, visibility: 'visible', selectedSpaces: [{ spaceId: 'selected', visible: true, contentHidden: open, contentVisible: !open, expanded: String(open), popupVisible: open, popupClassVisible: open }], popups: open ? [{ spaceId: 'selected', visible: true, controls: true, entries: [entry, twin].map(value => ({ entryId: value.entryId, title: value.name })), message: '' }] : [] });
const portMessage = (action, fields = {}) => ({ type: 'archive.port-message', data: { portId: 'observer:1', message: {
    type: 'arcifyArchiveDisplay', action, requestId: action, windowId: 7, ...(action === 'register' ? {} : { session: 'worker-session' }), ...fields } } });
const ack = () => portMessage('ack', { token: openRequest.token, displayed: true });
const displayEvents = () => [{ type: 'archive.port-connect', data: { portId: 'observer:1', name: 'arcify-archive-display-v1', sender: {
    id: ARCIFY, url: `chrome-extension://${ARCIFY}/sidebar.html`, origin: `chrome-extension://${ARCIFY}`, documentId: null, frameId: 0, documentLifecycle: 'active', tab: null } } },
    portMessage('register'), portMessage('take'), portMessage('validate', { token: openRequest.token }), ack()];

for (const method of ['click', 'Enter']) test(`trusted Archive ${method} oracle rejects fake, modified, repeated and wrong-ID activations`, () => {
    const expected = { type: ARCHIVE_ENTRY_TYPE, title: 'Reopen original', entryId: 'chosen', method };
    const good = input(expected); assertArchiveTrustedInput([good], expected);
    for (const patch of [{ trusted: false }, ...['repeat', 'composing', 'shift', 'ctrl', 'alt', 'meta'].map(key => ({ [key]: true })), { resultType: 'search-query' }, { entryId: 'twin' }, { title: 'Different' }, ...(method === 'click' ? [{ button: 2 }] : [{ key: ' ' }])]) assert.throws(() => assertArchiveTrustedInput([{ ...good, ...patch }], expected));
    for (const events of [[], [good, copy(good)]]) assert.throws(() => assertArchiveTrustedInput(events, expected));
});

test('native popup oracle needs the existing visible global popup with all exact IDs', () => {
    const state = nativeState();
    const expected = { arcifyId: ARCIFY, spaceId: 'selected', entries: [entry, twin] }; assertNativeArchivePopup(state, expected);
    for (const change of [value => { value.url = 'https://sidebar.test/'; }, value => { value.visibility = 'hidden'; }, value => { value.popups = []; }, value => { value.popups.push(copy(value.popups[0])); },
        value => { value.popups[0].visible = false; }, value => { value.popups[0].controls = false; }, value => { value.popups[0].spaceId = 'original'; }, value => { value.popups[0].entries.reverse(); }, value => { value.popups[0].entries[0].entryId = 'twin'; }, value => { value.popups[0].entries.pop(); }, ...['visible', 'contentHidden', 'contentVisible', 'popupVisible', 'popupClassVisible'].map(key => value => { value.selectedSpaces[0][key] = !value.selectedSpaces[0][key]; }), value => { value.selectedSpaces[0].expanded = 'false'; }, value => { value.selectedSpaces = []; }]) {
        const bad = copy(state); change(bad); assert.throws(() => assertNativeArchivePopup(bad, expected));
    }
});

test('Open request oracle requires direct renderer send, one token and real source context', () => {
    const expected = { spotlightId: SPOTLIGHT, sourceTabId: 10, windowId: 7, sourceUrl: URL }; assert.deepEqual(assertArchiveOpenRequest(openEvents(), expected), openRequest);
    for (const change of [events => events.pop(), events => events.push(copy(events[1])), events => { events[1].data.sender.id = ARCIFY; }, events => { events[1].data.sender.url = `chrome-extension://${SPOTLIGHT}/background.js`; },
        events => { events[1].data.message.url = URL; }, events => { events[1].data.message.token = ''; }, events => { events[1].data.message.version = 2; }, events => { events[0].data.message.tabId = 11; }, events => { events[0].data.message.windowId = 8; },
        events => events.push(external({ type: 'arcify-sidebar' }))]) { const bad = openEvents(); change(bad); assert.throws(() => assertArchiveOpenRequest(bad, expected)); }
});

test('internal ACK oracle requires an ordered one-Port session and independent native hosting without claiming document-ID attestation', () => {
    const expected = { arcifyId: ARCIFY, windowId: 7 }, events = displayEvents();
    const proof = assertArchiveNativeAck(events, openRequest, native, expected);
    assert.equal(proof.acknowledgement, events.at(-1)); assert.equal(proof.connection.data.sender.documentId, null);
    assert.match(proof.evidenceModel, /independent native hosting/);
    for (const documentId of [null, 'independently-reported-document']) {
        const value = displayEvents(); value[0].data.sender.documentId = documentId;
        assertArchiveNativeAck(value, openRequest, native, expected);
    }
    const omitted = displayEvents(); delete omitted[0].data.sender.frameId; delete omitted[0].data.sender.documentLifecycle;
    assertArchiveNativeAck(omitted, openRequest, native, expected);
    // Availability hints can cause an earlier empty take without consuming an intent.
    const withEmptyTake = displayEvents(); withEmptyTake.splice(2, 0, portMessage('take', { requestId: 'earlier-empty-take' }));
    assertArchiveNativeAck(withEmptyTake, openRequest, native, expected);
});
for (const [name, change] of [
    ['display refusal', events => { events.at(-1).data.message.displayed = false; }],
    ['wrong token', events => { events.at(-1).data.message.token = 'other-token'; }],
    ['wrong window', events => { events.at(-1).data.message.windowId = 8; }],
    ['missing session', events => { delete events.at(-1).data.message.session; }],
    ['changed session', events => { events.at(-1).data.message.session = 'different'; }],
    ['unexpected ACK field', events => { events.at(-1).data.message.context = context; }],
    ['ordinary sidebar tab', events => { events[0].data.sender.tab = { id: 100, windowId: 7 }; }],
    ['other extension', events => { events[0].data.sender.id = SPOTLIGHT; }],
    ['options URL', events => { events[0].data.sender.url = `chrome-extension://${ARCIFY}/options.html`; }],
    ['child frame', events => { events[0].data.sender.frameId = 1; }],
    ['inactive document', events => { events[0].data.sender.documentLifecycle = 'prerender'; }],
    ['cancelled intent', events => { events.splice(4, 0, portMessage('cancel', { token: openRequest.token })); }],
    ['other origin', events => { events[0].data.sender.origin = `chrome-extension://${SPOTLIGHT}`; }],
    ['different channel', events => { events[0].data.name = 'other'; }],
    ['unobserved Port', events => { events.at(-1).data.portId = 'observer:2'; }],
    ['ambiguous Port identity', events => { events.unshift(copy(events[0])); }],
    ['missing registration', events => { events.splice(1, 1); }],
    ['wrong registration window', events => { events[1].data.message.windowId = 8; }],
    ['missing claim request', events => { events.splice(2, 1); }],
    ['claim from other session', events => { events[2].data.message.session = 'other'; }],
    ['missing validation', events => { events.splice(3, 1); }],
    ['validation from other token', events => { events[3].data.message.token = 'other'; }],
    ['validation from other Port', events => { events[3].data.portId = 'observer:2'; }],
    ['validation before take', events => { [events[2], events[3]] = [events[3], events[2]]; }],
    ['reused request ID', events => { events.at(-1).data.message.requestId = 'validate'; }],
    ['disconnected Port', events => { events.splice(4, 0, { type: 'archive.port-disconnect', data: { portId: 'observer:1' } }); }],
    ['duplicate ACK', events => { events.push(ack()); }],
    ['missing ACK', events => { events.pop(); }],
    ['connection after ACK', events => { events.push(events.shift()); }]
]) test(`internal ACK oracle rejects ${name}`, () => {
    const events = displayEvents(); change(events); assert.throws(() => assertArchiveNativeAck(events, openRequest, native, { arcifyId: ARCIFY, windowId: 7 }));
});
for (const [name, change] of [
    ['no real context identity', value => { value.context.documentId = null; }],
    ['ordinary native context', value => { value.context.contextType = 'TAB'; }],
    ['wrong native URL', value => { value.context.documentUrl = 'https://wrong.test/'; }],
    ['ordinary native tab', value => { value.hosting.tab = { id: 9, windowId: 7 }; }],
    ['other native window', value => { value.hosting.windowId = 8; }]
]) test(`independent native proof rejects ${name} even with a valid internal Port ACK`, () => {
    const value = copy(native); change(value); assert.throws(() => assertArchiveNativeAck(displayEvents(), openRequest, value, { arcifyId: ARCIFY, windowId: 7 }));
});

test('reopen request oracle rejects URL/full-record selection, wrong identity and duplicates', () => {
    const expected = { spotlightId: SPOTLIGHT, sourceTabId: 10, windowId: 7, entryId: entry.entryId };
    assert.deepEqual(assertArchiveReopenRequest([external(copy(reopen))], expected), reopen);
    for (const patch of [{ url: URL }, { expected: entry }, { entryId: 'twin' }, { windowId: 8 }, { viewId: '' }, { context: { ...context, sourceTabId: 11 } }, { supportedFeatures: ['archiveActionsV1'] }]) assert.throws(() => assertArchiveReopenRequest([external({ ...copy(reopen), ...patch })], expected));
    assert.throws(() => assertArchiveReopenRequest([external(reopen), external(reopen)], expected));
});

function reopenedFixture() {
    const tabs = [
        { id: 10, windowId: 7, index: 0, url: URL, pendingUrl: null, active: true, pinned: false },
        { id: 20, windowId: 8, index: 0, url: URL, pendingUrl: null, active: true, pinned: false },
        { id: 21, windowId: 8, index: 1, url: URL, pendingUrl: null, active: false, pinned: false },
        { id: 22, windowId: 7, index: 1, url: URL, pendingUrl: null, active: false, pinned: true }
    ];
    const before = { tabs, windows: [{ id: 7, focused: true }, { id: 8, focused: false }], spaces: [{ id: 'selected', bookmarkFolderId: 'selected-root', temporaryTabs: [10, 20], spaceBookmarks: [21] }, { id: 'original', bookmarkFolderId: 'original-root', temporaryTabs: [], spaceBookmarks: [] }],
        activeSpaces: { 7: 'selected', 8: 'selected' }, archivedTabs: [copy(entry), copy(twin)], claims: null, journal: [],
        bookmarks: [{ id: 'pin', url: URL, title: 'Saved exact pin' }], bindings: { 21: { bookmarkId: 'pin', pinnedUrl: URL } }, aliases: {},
        favorites: [{ id: 'favorite', title: 'Saved Favorite', url: URL }], favoriteSession: { bindings: [{ favoriteId: 'favorite', windowId: 7, tabId: 22 }] }, groups: [], projection: {}, pairingGeneration: 'generation', pageStates: { 10: { documentId: 'source', value: 'retained' }, 20: { documentId: 'other', value: 'retained-other' } } };
    const after = copy(before); after.tabs[0].active = false; after.tabs.push({ id: 30, windowId: 7, index: 2, url: URL, pendingUrl: null, active: true, pinned: false }); after.spaces[1].temporaryTabs.push(30); after.activeSpaces[7] = 'original'; after.archivedTabs.shift();
    const claim = { phase: 'consumed', entryId: entry.entryId, expected: copy(entry), windowId: 7, bookmarkFolderId: 'original-root', tabId: 30,
        result: { entryId: entry.entryId, tabId: 30, consumed: true } };
    after.claims = { version: 1, entries: { [entry.entryId]: copy(claim) } };
    const events = [{ type: 'tabs.onCreated', data: [{ id: 30, windowId: 7, pendingUrl: URL, active: false }] },
        { type: 'storage', data: { area: 'local', changes: { archivedTabs: { oldValue: copy(before.archivedTabs), newValue: copy(after.archivedTabs) }, archiveReopenClaims: { oldValue: null, newValue: copy(after.claims) } } } }];
    const expected = { entry: { ...copy(entry), bookmarkFolderId: 'original-root' }, sourceWindowId: 7, selectedSpaceId: 'selected' };
    return { before, after, events, expected };
}
test('reopen oracle requires exact native receipt, original Space, atomic consume and untouched same-URL saved identities', () => {
    const { before, after, events, expected } = reopenedFixture(); assert.equal(assertArchiveReopened(before, after, events, expected).tabId, 30);
});
for (const [name, change] of [
    ['missing native create', value => value.events.shift()], ['duplicate native create', value => value.events.push(copy(value.events[0]))],
    ['wrong native window', value => { value.events[0].data[0].windowId = 8; }], ['URL twin reused as native identity', value => { value.events[0].data[0].id = 20; }],
    ['other-window focus', value => { value.after.tabs[1].active = false; }], ['source navigated', value => { value.after.tabs[0].url = 'https://changed.test/'; }],
    ['saved pin binding changed', value => { value.after.bindings[21].bookmarkId = 'wrong'; }], ['Favorite changed', value => { value.after.favorites[0].title = 'changed'; }],
    ['chosen record remains', value => { value.after.archivedTabs.unshift(copy(entry)); }], ['same-address twin consumed too', value => { value.after.archivedTabs = []; }],
    ['wrong original Space', value => { value.after.spaces[1].temporaryTabs = []; value.after.spaces[0].temporaryTabs.push(30); }],
    ['duplicate membership', value => { value.after.spaces[0].temporaryTabs.push(30); }], ['changed folder identity', value => { value.after.spaces[1].bookmarkFolderId = 'replacement-root'; }],
    ['other-window selection changed', value => { value.after.activeSpaces[8] = 'original'; }], ['document replacement', value => { value.after.pageStates[10].documentId = 'replacement'; }],
    ['receipt lacks unknown full-record field', value => { delete value.after.claims.entries.chosen.expected.proof; }], ['unconsumed receipt', value => { value.after.claims.entries.chosen.phase = 'assigned'; }],
    ['non-atomic receipt', value => { delete value.events[1].data.changes.archiveReopenClaims; }], ['duplicate consume event', value => { value.events.push(copy(value.events[1])); }],
    ['unexpected bookmark write', value => value.events.push({ type: 'bookmarks.onChanged', data: ['pin', { title: 'changed' }] })]
]) test(`reopen oracle rejects ${name}`, () => { const data = reopenedFixture(); change(data); assert.throws(() => assertArchiveReopened(data.before, data.after, data.events, data.expected)); });

test('rejected/repeated/uncertain requests require no writes or native side effects', () => {
    const before = reopenedFixture().before; assertArchiveNoMutation(before, copy(before), [external(reopen)]);
    const bad = copy(before); bad.archivedTabs.pop(); assert.throws(() => assertArchiveNoMutation(before, bad, []));
    for (const event of [{ type: 'tabs.onCreated', data: [{ id: 40 }] }, { type: 'tabs.onUpdated', data: { id: 10, change: { url: URL } } }, { type: 'bookmarks.onChanged', data: [] }, { type: 'windows.onFocusChanged', data: [8] }, { type: 'sidePanel.onOpened', data: [{ windowId: 7 }] },
        { type: 'storage', data: { area: 'local', changes: { archiveReopenClaims: { oldValue: null, newValue: {} } } } }]) assert.throws(() => assertArchiveNoMutation(before, copy(before), [event]));
});

test('input observer passively retains trusted browser metadata', () => {
    const listeners = new Map(), row = { dataset: { resultType: ARCHIVE_ENTRY_TYPE, archiveEntryId: 'chosen' }, querySelector: () => ({ textContent: 'Reopen original' }) };
    const document = { addEventListener: (type, listener) => listeners.set(type, listener), removeEventListener: type => listeners.delete(type), querySelector: () => row };
    const realm = { document, parent: {}, globalThis: {} }; vm.runInNewContext(`(${installArchiveInputObservation})()`, realm);
    const event = { isTrusted: true, target: { closest: () => row }, key: 'Enter', button: undefined };
    listeners.get('keydown')(event); assert.equal(realm.parent.__archiveInputEvents[0].trusted, true); assert.equal(realm.parent.__archiveInputEvents[0].entryId, 'chosen');
    realm.globalThis.__archiveInput.stop(); assert.equal(listeners.size, 0);
});

test('hosted driver positively invokes visible UI, observes real native context and never substitutes a normal sidebar tab or transport', () => {
    assert.match(source, /assertSpotlightActionEnvironment\(\)/); assert.match(source, /for \(const kind of \['owned-newtab', 'browser-newtab', 'overlay'\]\) for \(const method of \['click', 'Enter'\]\)/);
    assert.match(source, /nativePanel\.capture\(eventCount/); assert.match(source, /assertNativeArchivePopup\(state/); assert.match(source, /assertArchiveNativeAck\(observed\.events/);
    assert.match(source, /await invoke\(selected, method\)/); assert.match(source, /await input\.press\('Enter'\)/); assert.match(source, /await clickFreshResult\(/);
    assert.match(source, /assertArchiveReopened\(before, after, observed\.events/); assert.match(source, /durable-uncertain-create-rejected/); assert.match(source, /captured-reopen-cached-receipt/);
    assert.match(source, /stale-archive-\$\{change\}-rejected/); assert.match(source, /evaluateWithoutGesture\(session/);
    assert.doesNotMatch(source, /\.dispatchEvent\(|\.click\(\)\s*;|Object\.defineProperty|\.sidePanel\.open\(|\.goto\([^\n]*sidebar\.html|fetch\(|setRequestInterception|mockResponse|newPage\(/);
    assert.match(source, /await activate\(current\.tab\.id\); await local\(\{ action: 'activate', windowId, spaceId: source\.id \}\);\n        const favoriteRequest/);
    assert.match(source, /Cleanup refuses changed unrelated archive records/);
    assert.match(source, /finishBookmarkFixture\(/); assert.match(source, /archive-cleanup-verified/); assert.match(source, /unitOnly: \['deterministic lost ACK/);
});


const expectedReopen = { spotlightId: SPOTLIGHT, sourceTabId: 10, windowId: 7, entryId: entry.entryId };
function completionFixture(kind = 'overlay') {
    const calls = [], receipt = { tabId: 30 };
    const page = { waitForFunction: async () => { calls.push('retirement-wait'); }, evaluate: async () => { calls.push('retirement-read'); return true; } };
    const surface = kind === 'overlay' ? { waitForFunction: () => assert.fail('Never wait on a retired overlay renderer'), $eval: () => assert.fail('Never read a retired overlay status') } : page;
    if (kind !== 'overlay') { page.waitForFunction = async (_predicate, options, name) => { assert.equal(options.polling, 50); assert.equal(name, 'Original'); calls.push('status-wait'); };
        page.$eval = async selector => { assert.equal(selector, '.arcify-bridge-status [role="status"]'); calls.push('status-read'); return 'Archived tab reopened in Original.'; };
        page.evaluate = () => assert.fail('New Tab completion is a real status, not overlay retirement'); }
    return { calls, args: { page, surface, kind, spaceName: 'Original', events: [external(copy(reopen))], expected: expectedReopen,
        verifyCommitted: async () => { calls.push('exact-native-durable-proof'); return receipt; } }, receipt };
}
test('overlay reopen requires a real request and durable native commit before source overlay retirement', async () => {
    const { calls, args, receipt } = completionFixture();
    assert.deepEqual(await waitForArchiveReopenCompletion(args), { request: reopen, receipt, status: null, overlayRetired: true });
    assert.deepEqual(calls, ['exact-native-durable-proof', 'retirement-wait', 'retirement-read']);
});
for (const failure of ['missing request', 'missing native commit', 'missing overlay retirement', 'not an isolated frame']) test(`overlay completion rejects ${failure}`, async () => {
    const { calls, args } = completionFixture();
    if (failure === 'missing request') args.events = [];
    if (failure === 'missing native commit') args.verifyCommitted = async () => { throw new Error('Missing exact durable/native commit'); };
    if (failure === 'missing overlay retirement') args.page.evaluate = async () => false;
    if (failure === 'not an isolated frame') args.surface = args.page;
    await assert.rejects(waitForArchiveReopenCompletion(args));
    if (failure === 'missing request' || failure === 'missing native commit') assert.deepEqual(calls, []);
});
for (const kind of ['browser-newtab', 'owned-newtab']) test(`${kind} reopen still requires actual success status after exact native proof`, async () => {
    const { calls, args } = completionFixture(kind); const result = await waitForArchiveReopenCompletion(args);
    assert.equal(result.status, 'Archived tab reopened in Original.'); assert.equal(result.overlayRetired, false);
    assert.deepEqual(calls, ['exact-native-durable-proof', 'status-wait', 'status-read']);
    args.page.$eval = async () => 'Archived tab reopened in Wrong Space.'; await assert.rejects(waitForArchiveReopenCompletion(args));
});
function cachedFixture() {
    const state = reopenedFixture().after;
    const result = { entryId: entry.entryId, tabId: 30, spaceId: 'original', windowId: 7, consumed: true, status: 'reopened', warning: null };
    const response = { type: reopen.type, version: reopen.version, requestId: reopen.requestId, role: 'arcify', ok: true, archiveResult: result, snapshot: { windowId: 7 } };
    const cached = copy(response); delete cached.snapshot;
    state.journal = [{ key: `${SPOTLIGHT}:generation:${reopen.requestId}`, fingerprint: JSON.stringify(reopen), response: cached }];
    return { state, response, request: copy(reopen) };
}
test('same request ID replay must return its exact cached consumed native receipt', () => {
    const { state, response, request } = cachedFixture(); assert.deepEqual(assertArchiveCachedReplay(response, request, state, { spotlightId: SPOTLIGHT }), response.archiveResult);
    assertArchiveNoMutation(state, copy(state), [external(request)]);
});
for (const [name, mutate] of [
    ['rejected instead of cached', v => { v.response.ok = false; }], ['wrong request correlation', v => { v.response.requestId = 'other'; }],
    ['wrong created tab', v => { v.response.archiveResult.tabId = 31; }], ['wrong selected archive ID', v => { v.response.archiveResult.entryId = 'twin'; }],
    ['wrong original Space', v => { v.response.archiveResult.spaceId = 'selected'; }], ['missing journal receipt', v => { v.state.journal = []; }],
    ['wrong journal key', v => { v.state.journal[0].key = 'another-peer:request'; }], ['wrong cached correlation', v => { v.state.journal[0].response.requestId = 'other'; }],
    ['wrong fingerprint', v => { v.state.journal[0].fingerprint += ' '; }], ['duplicate cached receipt', v => { v.state.journal.push(copy(v.state.journal[0])); }],
    ['unconsumed durable claim', v => { v.state.claims.entries.chosen.phase = 'assigned'; }], ['wrong response window', v => { v.response.snapshot.windowId = 8; }]
]) test(`cached replay rejects ${name}`, () => { const value = cachedFixture(); mutate(value); assert.throws(() => assertArchiveCachedReplay(value.response, value.request, value.state, { spotlightId: SPOTLIGHT })); });
function pendingFixture(priorCount = 2) {
    const before = reopenedFixture().before;
    before.journal = Array.from({ length: priorCount }, (_, index) => ({ key: `prior-${index}`, fingerprint: `prior-fingerprint-${index}`, response: { ok: true } }));
    const request = copy(reopen), after = copy(before);
    after.journal = [...after.journal.slice(-99), { key: `${SPOTLIGHT}:generation:${request.requestId}`, fingerprint: JSON.stringify(request) }];
    const events = [external(request), { type: 'storage', data: { area: 'session', changes: { spotlightBridgeRequests: { oldValue: copy(before.journal), newValue: copy(after.journal) } } } }];
    return { before, after, events, options: { pendingRequest: request, spotlightId: SPOTLIGHT } };
}
for (const priorCount of [0, 2, 99, 100]) test(`rejected mutation allows only the exact pending request append with ${priorCount} prior journal entries`, () => {
    const { before, after, events, options } = pendingFixture(priorCount); assertArchiveNoMutation(before, after, events, options);
    assert.equal(after.journal.length, Math.min(priorCount + 1, 100));
    assert.throws(() => assertArchiveNoMutation(before, after, events));
});
for (const [name, mutate] of [
    ['missing journal addition', v => { v.after.journal = copy(v.before.journal); }], ['missing actual storage event', v => { v.events.pop(); }],
    ['wrong request fingerprint', v => { v.after.journal.at(-1).fingerprint += ' '; }], ['wrong peer identity', v => { v.after.journal.at(-1).key = 'another-peer'; }],
    ['success response on rejected action', v => { v.after.journal.at(-1).response = { ok: true }; }], ['modified prior journal entry', v => { v.after.journal[0].fingerprint = 'changed'; }],
    ['extra append', v => { v.after.journal.push(copy(v.after.journal.at(-1))); }], ['changed pairing generation', v => { v.options.pendingRequest.context.pairingGeneration = 'other'; }],
    ['wrong observed old value', v => { v.events[1].data.changes.spotlightBridgeRequests.oldValue = []; }], ['wrong observed new value', v => { v.events[1].data.changes.spotlightBridgeRequests.newValue = []; }],
    ['extra changed session key', v => { v.events[1].data.changes.activeSpaces = { oldValue: {}, newValue: { 7: 'original' } }; }],
    ['local write', v => { v.events[1].data.area = 'local'; }], ['extra journal write', v => { v.events.push(copy(v.events[1])); }],
    ['native creation', v => { v.events.push({ type: 'tabs.onCreated', data: [{ id: 41 }] }); }], ['archive changed', v => { v.after.archivedTabs.pop(); }],
    ['unbounded prior tail', v => { v.before.journal = Array.from({ length: 100 }, (_, i) => ({ key: String(i) })); v.after.journal = [...copy(v.before.journal), v.after.journal.at(-1)]; }]
]) test(`pending-receipt exception rejects ${name}`, () => { const value = pendingFixture(); mutate(value); assert.throws(() => assertArchiveNoMutation(value.before, value.after, value.events, value.options)); });

test('native closed popup oracle rejects hidden content, stale ARIA or transparent blank sidebar', () => {
    const state = nativeState(false), expected = { arcifyId: ARCIFY, spaceId: 'selected', open: false }; assertNativeArchiveToggle(state, expected);
    for (const mutate of [value => { value.selectedSpaces[0].contentHidden = true; }, value => { value.selectedSpaces[0].contentVisible = false; },
        value => { value.selectedSpaces[0].expanded = 'true'; }, value => { value.selectedSpaces[0].popupVisible = true; }, value => { value.selectedSpaces[0].popupClassVisible = true; }, value => { value.popups = nativeState().popups; }]) {
        const bad = copy(state); mutate(bad); assert.throws(() => assertNativeArchiveToggle(bad, expected));
    }
});
test('native visibility measurement checks opacity, display, visibility and actual geometry', () => {
    const { document } = parseHTML('<html><body><div id="spacesList"><section class="space active" data-space-id="selected"><button class="sidebar-button" aria-expanded="false"></button><main class="space-content"></main><aside class="archived-tabs-popup"></aside></section></div></body></html>');
    const content = document.querySelector('.space-content'), popup = document.querySelector('.archived-tabs-popup');
    const geometry = { x: 1, y: 1, right: 201, bottom: 201, width: 200, height: 200 };
    for (const node of document.querySelectorAll('*')) node.getBoundingClientRect = () => geometry;
    const normal = { display: 'flex', visibility: 'visible', opacity: '1' }, contentStyle = { ...normal };
    const realm = { document, location: { href: `chrome-extension://${ARCIFY}/sidebar.html` }, innerWidth: 400, innerHeight: 800,
        getComputedStyle: node => node === content ? contentStyle : node === popup ? { ...normal, opacity: '0' } : normal };
    Object.defineProperty(document, 'visibilityState', { value: 'visible' });
    const read = () => JSON.parse(JSON.stringify(vm.runInNewContext(`(${readNativeArchivePopup})()`, realm)));
    assertNativeArchiveToggle(read(), { arcifyId: ARCIFY, spaceId: 'selected', open: false });
    for (const patch of [{ opacity: '0' }, { display: 'none' }, { visibility: 'hidden' }, { visibility: 'collapse' }]) {
        Object.assign(contentStyle, normal, patch); assert.equal(read().selectedSpaces[0].contentVisible, false);
    }
    Object.assign(contentStyle, normal); content.getBoundingClientRect = () => ({ ...geometry, width: 0 }); assert.equal(read().selectedSpaces[0].contentVisible, false);
    content.getBoundingClientRect = () => ({ ...geometry, x: 500, right: 700 }); assert.equal(read().selectedSpaces[0].contentVisible, false);
});
function buttonFixture(fault) {
    let open = true, input = [], clicks = 0; const checkpoints = [], before = reopenedFixture().before;
    const page = { evaluate: async fn => {
        if (fn === readNativeArchivePopup) { const rendered = nativeState(open); if (fault === 'blank sidebar' && !open) rendered.selectedSpaces[0].contentVisible = false; return rendered; }
        if (fn === installArchiveButtonObservation) { input = []; return; }
        if (fn.toString().includes('__archiveButtonInput.events')) return input;
        assert.match(fn.toString(), /__archiveButtonInput.stop/);
    }, click: async selector => { assert.equal(selector, '#spacesList > .space.active[data-space-id="selected"] .sidebar-button');
        input.push({ trusted: fault !== 'untrusted click', button: 0, shift: false, ctrl: false, alt: false, meta: false, spaceId: 'selected', expandedBefore: String(open) });
        if (fault === 'missing input') input = []; open = !open; clicks++;
    } };
    const args = { page, arcifyId: ARCIFY, spaceId: 'selected', entries: [entry, twin], ui: async (target, _label, action) => { assert.equal(target, page); return action(); },
        poll: async (read, accept) => { const value = await read(); assert.equal(accept(value), true, 'Actual popup/content state must satisfy the measured condition'); return value; },
        settle: async () => copy(before), read: async () => { const after = copy(before); if (fault === 'identity change') after.tabs[0].url = 'https://wrong.test/'; return after; },
        reset: async () => {}, trace: async () => ({ events: fault === 'native mutation' ? [{ type: 'tabs.onCreated', data: [{ id: 40 }] }] : [] }),
        capture: async () => ({ filename: 'native-popup.png' }), checkpoint: async (phase, value) => checkpoints.push({ phase, ...value }) };
    return { args, checkpoints, clicks: () => clicks };
}
test('native popup button round trip genuinely closes and reopens, measuring both states without identity changes', async () => {
    const value = buttonFixture(); await exerciseArchivePopupButtonRoundTrip(value.args); assert.equal(value.clicks(), 2);
    assert.deepEqual(value.checkpoints.map(item => item.open), [false, true]); assert(value.checkpoints.every(item => item.input[0].trusted));
});
for (const fault of ['blank sidebar', 'untrusted click', 'missing input', 'identity change', 'native mutation']) test(`native button round trip rejects ${fault}`, async () => {
    const value = buttonFixture(fault); await assert.rejects(exerciseArchivePopupButtonRoundTrip(value.args)); assert.equal(value.clicks(), 1); assert.deepEqual(value.checkpoints, []);
});
test('native button observer only captures trusted browser input and exact pre-toggle ARIA', () => {
    const listeners = new Map(), button = { closest: () => ({ dataset: { spaceId: 'selected' } }), getAttribute: () => 'true' };
    const realm = { globalThis: {}, document: { addEventListener: (type, fn) => listeners.set(type, fn), removeEventListener: type => listeners.delete(type) } };
    vm.runInNewContext(`(${installArchiveButtonObservation})()`, realm);
    listeners.get('click')({ isTrusted: true, button: 0, target: { closest: () => button } });
    assert.deepEqual(JSON.parse(JSON.stringify(realm.globalThis.__archiveButtonInput.events)), [{ trusted: true, button: 0, shift: false, ctrl: false, alt: false, meta: false, spaceId: 'selected', expandedBefore: 'true' }]);
    realm.globalThis.__archiveButtonInput.stop(); assert.equal(listeners.size, 0);
});


const setupUrl = `chrome-extension://${ARCIFY}/options.html?paired-archive-fixture=${'c'.repeat(32)}`;
const setupSource = () => ({ extensionId: ARCIFY, url: setupUrl, timeOrigin: 1000,
    tab: { id: 71, windowId: 7, url: setupUrl, pendingUrl: null, status: 'complete', incognito: false, pinned: false },
    window: { id: 7, type: 'normal', incognito: false },
    contexts: [{ contextType: 'TAB', documentId: 'setup-document', documentUrl: setupUrl, tabId: 71, windowId: 7, frameId: 0, incognito: false }] });
const setupExpected = { arcifyId: ARCIFY, windowId: 7, tabId: 71, url: setupUrl };
const setupSender = () => ({ id: ARCIFY, url: setupUrl, origin: `chrome-extension://${ARCIFY}`, documentId: 'setup-document',
    frameId: 0, documentLifecycle: 'active', tab: { id: 71, windowId: 7 } });
function setupEndpoint({ dispatch = async () => ({ favorites: [] }) } = {}) {
    const source = setupSource(), sent = [], registrations = [], listeners = [];
    globalThis.chrome = { runtime: { id: ARCIFY, getURL: path => `chrome-extension://${ARCIFY}/${path}`, onMessage: { addListener: fn => listeners.push(fn) } } };
    registerFavoriteMessages({ dispatch });
    const realm = { location: { href: setupUrl }, performance: { timeOrigin: source.timeOrigin }, globalThis: { __spaceActionObservation: { events: [] } },
        chrome: { tabs: { getCurrent: async () => copy(source.tab) }, windows: { getCurrent: async () => copy(source.window) },
            runtime: { id: ARCIFY, getContexts: async filters => { assert.deepEqual(copy(filters), { contextTypes: ['TAB'], tabIds: [71] }); return copy(source.contexts); },
                onMessage: { addListener: fn => registrations.push(fn), removeListener: fn => registrations.splice(registrations.indexOf(fn), 1) },
                sendMessage: message => new Promise(resolve => { sent.push(copy(message)); const sender = setupSender();
                    for (const observer of registrations) observer(message, sender); listeners[0](message, sender, resolve); }) } } };
    vm.runInNewContext(`(${installArchiveFixtureMessageObservation})()`, realm);
    const endpoint = { source: copy(source), page: { evaluate: async (fn, arg) => copy(await vm.runInNewContext(`(${fn})(argument)`, { ...realm, argument: copy(arg) })) } };
    return { endpoint, realm, source, sent, events: realm.globalThis.__spaceActionObservation.events, registrations };
}
test('owned setup document uses real caller-window metadata and unchanged Favorites receiver permits only its exact window', async () => {
    const dispatched = [], value = setupEndpoint({ dispatch: async message => { dispatched.push(copy(message)); return { favorites: [] }; } });
    const good = { type: 'favoriteStore', action: 'get', windowId: 7 };
    assert.deepEqual(await sendArchiveFixtureRequest(value.endpoint, good), { success: true, favorites: [] });
    assert.deepEqual(dispatched, [good]); assertArchiveFixtureSender(copy(value.events), good, value.endpoint.source);
    const bad = { ...good, windowId: 8 };
    assert.deepEqual(await sendArchiveFixtureRequest(value.endpoint, bad), { success: false, code: 'UNAUTHORIZED', error: 'Invalid Favorites sender.' });
    assert.deepEqual(dispatched, [good], 'Wrong-window request never enters the store or mutates state.');
    assertArchiveFixtureSender(copy(value.events), bad, value.endpoint.source);
    assert.deepEqual(value.sent, [good, bad]);
    value.realm.globalThis.__archiveFixtureMessageStop(); assert.deepEqual(value.registrations, []);
});
for (const [name, mutate] of [
    ['control window', s => { s.tab.windowId = 8; s.window.id = 8; s.contexts[0].windowId = 8; }],
    ['different native tab', s => { s.tab.id = 72; s.contexts[0].tabId = 72; }],
    ['ordinary web page', s => { s.url = 'https://example.test/'; }], ['different extension', s => { s.extensionId = SPOTLIGHT; }],
    ['pending navigation', s => { s.tab.pendingUrl = 'https://example.test/'; }], ['incomplete document', s => { s.tab.status = 'loading'; }],
    ['incognito tab', s => { s.tab.incognito = true; }], ['pinned tab', s => { s.tab.pinned = true; }],
    ['incognito window', s => { s.window.incognito = true; }], ['non-normal window', s => { s.window.type = 'popup'; }],
    ['missing native context', s => { s.contexts = []; }], ['ambiguous native context', s => { s.contexts.push(copy(s.contexts[0])); }],
    ['native panel substituted', s => { s.contexts[0].contextType = 'SIDE_PANEL'; }], ['missing document ID', s => { s.contexts[0].documentId = ''; }],
    ['wrong document URL', s => { s.contexts[0].documentUrl = `chrome-extension://${ARCIFY}/options.html`; }],
    ['wrong context tab', s => { s.contexts[0].tabId = 72; }], ['wrong context window', s => { s.contexts[0].windowId = 8; }],
    ['subframe substituted', s => { s.contexts[0].frameId = 1; }], ['invalid document epoch', s => { s.timeOrigin = NaN; }]
]) test(`owned setup source rejects ${name}`, () => {
    const bad = setupSource(); mutate(bad); assert.throws(() => assertArchiveFixtureSource(bad, setupExpected));
});
for (const fault of ['moved tab', 'reloaded document', 'new document epoch', 'missing current tab', 'lookup rejection']) test(`setup cancels before message on ${fault}`, async () => {
    const value = setupEndpoint();
    if (fault === 'moved tab') value.source.tab.windowId = 8;
    if (fault === 'reloaded document') value.source.contexts[0].documentId = 'replacement-document';
    if (fault === 'new document epoch') value.realm.performance.timeOrigin = 1001;
    if (fault === 'missing current tab') value.realm.chrome.tabs.getCurrent = async () => undefined;
    if (fault === 'lookup rejection') value.realm.chrome.windows.getCurrent = async () => { throw new Error('Window lookup failed'); };
    await assert.rejects(sendArchiveFixtureRequest(value.endpoint, { type: 'favoriteStore', action: 'get', windowId: 7 }));
    assert.deepEqual(value.sent, []); assert.deepEqual(value.events, []);
});
test('setup sender proof refuses wrong source, document, tab, frame, origin or duplicate transport', () => {
    const message = { type: 'favoriteStore', action: 'get', windowId: 8 };
    const event = { type: 'archive.fixture-message', data: { message, sender: setupSender() } };
    assertArchiveFixtureSender([event], message, setupSource());
    for (const patch of [{ id: SPOTLIGHT }, { url: `chrome-extension://${ARCIFY}/options.html` }, { origin: 'https://example.test' },
        { documentId: 'replacement-document' }, { tab: { id: 71, windowId: 8 } }, { tab: null }, { frameId: 1 }, { documentLifecycle: 'prerender' }]) {
        assert.throws(() => assertArchiveFixtureSender([{ ...event, data: { message, sender: { ...setupSender(), ...patch } } }], message, setupSource()));
    }
    assert.throws(() => assertArchiveFixtureSender([], message, setupSource()));
    assert.throws(() => assertArchiveFixtureSender([event, copy(event)], message, setupSource()));
});
test('hosted Archive setup owns a fresh exact-window document, measures wrong-window rejection and retains it until authorized cleanup', () => {
    assert.match(source, /fixtureApi = await createNavigationFixturePage\(\{ browser, apiPage, observePage, poll, windowId,/);
    assert.match(source, /options\.html\?paired-archive-fixture=\$\{nonce\}/);
    assert.match(source, /fixtureApi\.source = assertArchiveFixtureSource\(await fixtureApi\.page\.evaluate\(readArchiveFixtureSource\)/);
    assert.match(source, /const wrongWindowRequest = \{ type: 'favoriteStore', action: 'get', windowId: otherWindow \}/);
    assert.match(source, /assertArchiveNoMutation\(setupBefore, setupAfter, setupObserved\.events\)/);
    assert.match(source, /owned-archive-fixture-source-verified/); assert.match(source, /owned-archive-favorite-setup/);
    assert.match(source, /const archive = async message => \{ const reply = await sendArchiveFixtureRequest\(fixtureApi, \{ type: 'archiveStore', windowId, \.\.\.message \}\)/);
    assert.match(source, /const favorite = async message => \{ const reply = await sendArchiveFixtureRequest\(fixtureApi, \{ type: 'favoriteStore', \.\.\.message \}\)/);
    const bulkClose = source.indexOf('owned.filter(id => id !== fixtureApi?.tab.id)');
    const archiveCleanup = source.indexOf("if (!entries) return; const existing = await archive({ action: 'list' })", bulkClose);
    const endpointClose = source.indexOf('if (fixtureApi) await apiPage.evaluate(id => chrome.tabs.remove(id), fixtureApi.tab.id)', archiveCleanup);
    assert(bulkClose > 0 && archiveCleanup > bulkClose && endpointClose > archiveCleanup);
});


function archiveRevealFixture(fault = null, alreadyVisible = false) {
    // Exact geometry from attempt2's native capture timeout; this is a mock
    // regression, not a claim of browser acceptance or a replacement receipt.
    const before = { url: `chrome-extension://${ARCIFY}/sidebar.html`, visibility: 'visible', width: 360, height: 869, devicePixelRatio: 1,
        switcher: { x: 0, y: 809, width: 352, height: 44, visible: true, scrollLeft: 0, scrollWidth: 1182, clientWidth: 352,
            pointer: { x: 176, y: 831, hitsSwitcher: true } }, selectedSpaces: ['selected'], selectedVisible: false,
        selectedChip: { x: 387.078125, y: 817, width: 372.75, height: 32, styled: true }, visibleSpaces: ['selected'] };
    if (alreadyVisible) { before.selectedChip.x = 10; before.selectedVisible = true; }
    const expected = { extensionId: ARCIFY, spaceId: 'selected' };
    const planned = planNativeSidebarSpaceReveal(before, expected);
    const after = copy(before);
    if (planned) { after.switcher.scrollLeft += planned.deltaX; after.selectedChip.x -= planned.deltaX; after.selectedVisible = true; }
    if (fault === 'wrong selection') before.selectedSpaces = ['other'];
    if (fault === 'wrong rendered Space') before.visibleSpaces = ['other'];
    if (fault === 'hidden panel') before.visibility = 'hidden';
    const calls = [], checkpoints = [];
    let renderReads = 0, selectionReads = 0;
    const selection = { tab: null, windowId: 7, tabs: [{ id: 10, windowId: 7, active: true }],
        spaces: [{ id: 'selected', temporaryTabs: [10], spaceBookmarks: [] }], activeSpaces: { 7: 'selected' } };
    const page = { mouse: { move: async (...args) => calls.push(['move', ...args]), wheel: async args => calls.push(['wheel', args]) },
        evaluate: async fn => {
            if (fn.name === 'readNativeSidebarRender') return renderReads++ === 0 || fault === 'no actual scroll' ? before : after;
            if (fn.name === 'readSelection') { const value = copy(selection);
                if (fault === 'wrong native window') value.windowId = 8;
                if (fault === 'ordinary sidebar tab') value.tab = { id: 40, windowId: 7 };
                if (selectionReads++ && fault === 'changed membership') value.spaces[0].temporaryTabs = [];
                return value;
            }
            if (fn.toString().includes('const events = globalThis')) { calls.push(['listen']); return; }
            if (fn.toString().includes('__stopNativeSidebarRevealWheel')) { calls.push(['stop']); return; }
            if (fn.toString().includes('__nativeSidebarRevealWheel')) return [{ trusted: fault !== 'untrusted wheel', inSwitcher: true, deltaX: planned.deltaX, deltaY: 0 }];
            assert.fail(`Unexpected native operation: ${fn}`);
        } };
    const native = { context: { contextType: 'SIDE_PANEL', documentId: 'native-document' } };
    const nativePanel = { resolve: async () => { calls.push(['resolve']); if (fault === 'missing native target') throw new Error('No native target'); return { page }; },
        capture: async (eventCount, label) => { calls.push(['capture', eventCount, label]);
            assert.equal(eventCount, 17); assert.equal(checkpoints.length, 1, 'Explicit reveal proof precedes the unchanged capture.');
            if (fault === 'capture rejected') throw new Error('Native capture failed'); return native;
        } };
    const poll = async (read, accept) => { const state = await read(); assert(accept(state), 'Existing strict native reveal readiness must pass'); return state; };
    const checkpoint = async (phase, data) => { calls.push(['checkpoint']); checkpoints.push({ phase, ...data }); };
    // Execute the actual hosted boundary, including the real shared reveal
    // helper. Do not copy its ordering into a separately tested fake adapter.
    const begin = source.indexOf('                // An explicit fixture interaction reveals');
    const end = source.indexOf('                const popup = await poll', begin);
    assert(begin > 0 && end > begin);
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const run = new AsyncFunction('nativePanel', 'poll', 'arcifyId', 'windowId', 'source', 'kind', 'method', 'eventCount', 'checkpoint', 'revealNativeSidebarSpace',
        `const attempt = {}; ${source.slice(begin, end)}; return { page, native };`);
    return { calls, checkpoints, planned, page, native,
        run: () => run(nativePanel, poll, ARCIFY, 7, { id: 'selected' }, 'owned-newtab', 'click', 17, checkpoint, revealNativeSidebarSpace) };
}
test('Archive native capture explicitly reveals attempt2 offscreen chip with one genuine wheel before read-only proof', async () => {
    const value = archiveRevealFixture(); assert.equal(value.planned.deltaX, 397.453125);
    assert.deepEqual(await value.run(), { page: value.page, native: value.native });
    assert.deepEqual(value.calls.map(call => call[0]), ['resolve', 'listen', 'move', 'wheel', 'stop', 'checkpoint', 'capture']);
    assert.deepEqual(value.calls.filter(([type]) => type === 'wheel'), [['wheel', { deltaX: 397.453125, deltaY: 0 }]]);
    const [checkpoint] = value.checkpoints; assert.equal(checkpoint.phase, 'native-archive-selected-space-revealed');
    assert.equal(checkpoint.kind, 'owned-newtab'); assert.equal(checkpoint.method, 'click');
    assert.deepEqual(checkpoint.reveal.selectionBefore, checkpoint.reveal.selectionAfter);
    assert.equal(checkpoint.reveal.events[0].trusted, true);
});
test('already visible native Archive Space receives no wheel or unnecessary selection interaction', async () => {
    const value = archiveRevealFixture(null, true); await value.run();
    assert.deepEqual(value.calls.map(call => call[0]), ['resolve', 'checkpoint', 'capture']);
    assert.equal(value.checkpoints[0].reveal.input, null);
});
for (const fault of ['missing native target', 'wrong selection', 'wrong rendered Space', 'hidden panel', 'wrong native window', 'ordinary sidebar tab', 'no actual scroll', 'untrusted wheel', 'changed membership']) test(`Archive reveal refuses ${fault} without accepting or retrying capture`, async () => {
    const value = archiveRevealFixture(fault); await assert.rejects(value.run());
    assert(!value.calls.some(([type]) => type === 'capture')); assert.deepEqual(value.checkpoints, []);
    assert(value.calls.filter(([type]) => type === 'wheel').length <= 1);
});
test('Archive reveal cannot turn failed native capture into success or retry it', async () => {
    const value = archiveRevealFixture('capture rejected'); await assert.rejects(value.run(), /Native capture failed/);
    assert.equal(value.calls.filter(([type]) => type === 'capture').length, 1);
    assert.equal(value.calls.filter(([type]) => type === 'wheel').length, 1);
});


test('failure document read retains real status/error text and existing input without synthesizing success', () => {
    const { document } = parseHTML('<html><body><div class="arcify-bridge-status"><span id="archive-error" role="alert">Arcify did not confirm that the archive was displayed.</span></div><div id="favoritesDropStatus" role="status">Source changed</div></body></html>');
    for (const [key, value] of Object.entries({ URL: `chrome-extension://${SPOTLIGHT}/newtab.html`, visibilityState: 'visible', readyState: 'complete' })) Object.defineProperty(document, key, { value });
    document.hasFocus = () => false;
    const realm = { document, performance: { timeOrigin: 123 }, globalThis: { __archiveInputEvents: [input()] } };
    const state = copy(vm.runInNewContext(`(${readArchiveDocumentStatus})()`, realm));
    assert.equal(state.url, `chrome-extension://${SPOTLIGHT}/newtab.html`); assert.equal(state.hasFocus, false); assert.equal(state.timeOrigin, 123);
    assert.deepEqual(state.statuses.map(({ id, role, text }) => ({ id, role, text })), [
        { id: 'archive-error', role: 'alert', text: 'Arcify did not confirm that the archive was displayed.' },
        { id: 'favoritesDropStatus', role: 'status', text: 'Source changed' }]);
    assert.deepEqual(state.archiveInput, [input()]); assert(state.statuses.every(item => item.connected));
});
function failureDiagnosticFixture(fault = null, nativePresent = true) {
    const calls = [], values = { observed: { events: [{ type: 'archive.intent', data: { message: { action: 'register' } } }], peerEvents: [], input: [] },
        source: { url: URL, visibility: 'visible' }, spotlight: { statuses: [{ role: 'alert', text: 'Original backend error' }] },
        nativeState: { contexts: [native.context], events: [{ type: 'opened', windowId: 7 }] },
        status: { statuses: [{ role: 'status', text: 'Native failure' }] }, hosting: { tab: null, windowId: 7 }, readiness: { selectedVisible: true }, popup: nativeState(false) };
    const read = key => { calls.push(key); if (fault === key) throw new Error(`Read failed: ${key}`); return copy(values[key]); };
    const args = { sourcePage: { evaluate: async fn => { assert.equal(fn, readArchiveDocumentStatus); return read('source'); } },
        sourceSurface: { evaluate: async fn => { assert.equal(fn, readArchiveDocumentStatus); return read('spotlight'); } },
        nativePanel: { state: async () => read('nativeState'), resolve: () => assert.fail('Never resolve or poll a new target during failure capture'), close: () => assert.fail('Never close before diagnostics') },
        trace: async () => read('observed'), nativePage: nativePresent ? { evaluate: async fn => {
            if (fn === readArchiveDocumentStatus) return read('status');
            if (fn === readNativeArchivePopup) return read('popup');
            if (fn.name === 'readNativeSidebarRender') return read('readiness');
            assert.match(fn.toString(), /chrome\.tabs\.getCurrent/); assert.match(fn.toString(), /chrome\.windows\.getCurrent/); return read('hosting');
        } } : null };
    return { args, calls, values };
}
test('failure diagnostics preserve passive trace, source status and exact already-resolved native context before cleanup', async () => {
    const f = failureDiagnosticFixture(), result = await collectArchiveOpenFailure(f.args);
    for (const key of ['observed', 'source', 'spotlight', 'nativeState']) assert.deepEqual(result[key], { ok: true, value: f.values[key] });
    for (const key of ['status', 'hosting', 'readiness', 'popup']) assert.deepEqual(result.native[key], { ok: true, value: f.values[key] });
    assert.deepEqual(f.calls, ['observed', 'source', 'spotlight', 'nativeState', 'status', 'hosting', 'readiness', 'popup']);
});
for (const key of ['observed', 'source', 'spotlight', 'nativeState', 'status', 'hosting', 'readiness', 'popup']) test(`failure diagnostics retain ${key} read errors without discarding other observations`, async () => {
    const f = failureDiagnosticFixture(key), result = await collectArchiveOpenFailure(f.args);
    const record = result[key] || result.native[key]; assert.equal(record.ok, false); assert.equal(record.error.message, `Read failed: ${key}`);
    assert.equal(f.calls.length, 8); assert.equal(result.native.popup.ok, key !== 'popup');
});
test('missing native target stays explicitly unavailable without trying to resolve, open or fabricate one', async () => {
    const f = failureDiagnosticFixture(null, false), result = await collectArchiveOpenFailure(f.args);
    assert.deepEqual(result.native, { unavailable: 'No native document was resolved before the original failure.' });
    assert.deepEqual(f.calls, ['observed', 'source', 'spotlight', 'nativeState']);
});
for (const fault of [null, 'diagnose', 'record']) test(`original frozen action failure survives ${fault || 'successful diagnostics'} and is never retried`, async () => {
    const original = Object.freeze(new Error('Original popup timeout')), calls = [], records = [];
    const operation = async () => { calls.push('action'); throw original; };
    const diagnose = async () => { calls.push('diagnose'); if (fault === 'diagnose') throw new Error('Detached renderer'); return { native: { popup: { ok: true, value: nativeState(false) } } }; };
    const record = async value => { calls.push('record'); records.push(value); if (fault === 'record') throw new Error('Evidence write failed'); };
    let caught;
    try { await withArchiveFailureEvidence(operation, diagnose, record); } catch (error) { caught = error; } finally { calls.push('cleanup'); }
    assert.equal(caught, original); assert.deepEqual(calls, ['action', 'diagnose', 'record', 'cleanup']);
    assert.equal(records[0].error.message, original.message); assert.equal(records[0].error.stack, original.stack);
    if (fault === 'diagnose') assert.equal(records[0].observations.diagnosticError.message, 'Detached renderer');
});
test('successful actions receive no diagnostic reads or additional interaction', async () => {
    let calls = 0;
    assert.equal(await withArchiveFailureEvidence(async () => { calls++; return 'actual result'; }, () => assert.fail('No diagnostics on success'), () => assert.fail('No failure record on success')), 'actual result');
    assert.equal(calls, 1);
});
test('hosted Archive failure boundary saves observations before outer cleanup without changing transport or authority', () => {
    assert.match(source, /await withArchiveFailureEvidence\(\(\) => ui\(origin\.page/);
    assert.match(source, /attempt\.baseline = \{ before, documentBefore, eventCount, preparation \};/);
    assert.match(source, /attempt\.nativePage = page;\n                const reveal = await revealNativeSidebarSpace/);
    assert.match(source, /nativePage: attempt\.nativePage, nativePanel, trace: \(\) => trace\(\) \}\)/);
    assert.match(source, /failure => checkpoint\('archive-open-attempt-failed', \{ kind, method, sourceTabId: origin\.tab\.id, baseline: attempt\.baseline \|\| null, \.\.\.failure \}\)\);\n            await nativePanel\.close\(\)/);
    const diagnostics = source.slice(source.indexOf('export function readArchiveDocumentStatus'), source.indexOf('export function readNativeArchivePopup'));
    assert.doesNotMatch(diagnostics, /runtime\.sendMessage|sidePanel\.open|tabs\.(?:update|create|remove)|\.focus\(|bringToFront|\.click\(|\.wheel\(|setTimeout|setInterval|waitFor|poll\(|nativePanel\.(?:resolve|close|capture)/);
});

function reopenFailureDiagnosticFixture(fault = null) {
    const calls = [], values = {
        events: [external(copy(reopen)), { type: 'tabs.onUpdated', data: { id: 30, change: { status: 'loading', url: URL } } }],
        peerEvents: [{ type: 'internal', data: { message: { action: 'arcifyArchiveReopen', entryId: entry.entryId } } }],
        input: [input({ type: ARCHIVE_ENTRY_TYPE, entryId: entry.entryId })], source: { url: URL, visibility: 'visible' },
        spotlight: { statuses: [{ role: 'alert', text: 'Exact created tab could not be assigned.' }] },
        claim: { phase: 'created', tabId: 30, expected: entry, requestId: reopen.requestId },
        receipt: { journal: [{ fingerprint: JSON.stringify(reopen) }], responseEvidence: 'unavailable' }
    };
    const read = key => { calls.push(key); if (fault === key) throw new Error(`Read failed: ${key}`); return copy(values[key]); };
    const args = { spotlightId: SPOTLIGHT, entryId: entry.entryId, windowId: 7, sourceTabId: 10,
        apiPage: { evaluate: async (fn, value) => {
            if (fn === readArchiveReopenJournal) { assert.deepEqual(value, { spotlightId: SPOTLIGHT, entryId: entry.entryId, windowId: 7, sourceTabId: 10, requests: fault === 'events' ? null : [copy(reopen)] }); return read('receipt'); }
            if (value !== undefined) { assert.equal(value, entry.entryId); assert.match(fn.toString(), /chrome\.storage\.local\.get\('archiveReopenClaims'\)/); return read('claim'); }
            return read('events');
        } }, spotlightOptions: { evaluate: async () => read('peerEvents') },
        sourcePage: { evaluate: async fn => read(fn === readArchiveDocumentStatus ? 'source' : 'input') },
        sourceSurface: { evaluate: async fn => { assert.equal(fn, readArchiveDocumentStatus); return read('spotlight'); } } };
    return { args, calls, values };
}
for (const fault of [null, 'events', 'peerEvents', 'input', 'source', 'spotlight', 'claim', 'receipt']) test(`reopen failure retains independent passive probes despite ${fault || 'no read failure'}`, async () => {
    const f = reopenFailureDiagnosticFixture(fault), result = await collectArchiveReopenFailure(f.args);
    assert.deepEqual(f.calls, Object.keys(f.values));
    for (const [key, value] of Object.entries(f.values)) {
        if (fault === key) { assert.equal(result[key].ok, false); assert.equal(result[key].error.message, `Read failed: ${key}`); }
        else assert.deepEqual(result[key], { ok: true, value });
    }
});
for (const hasResponse of [false, true]) test(`failure journal only retains exact entry/source/window/peer request${hasResponse ? ' with an actual stored response' : ' without guessing a missing response'}`, async () => {
    const request = copy(reopen), keyFor = (value, peer = SPOTLIGHT) => `${peer}:${value.context.pairingGeneration}:${value.requestId}`;
    const item = { key: keyFor(request), fingerprint: JSON.stringify(request), ...(hasResponse ? { response: { ok: true, archiveResult: { entryId: entry.entryId } } } : {}) };
    const unrelated = [
        { ...request, requestId: 'different-request-id' }, { ...request, entryId: twin.entryId }, { ...request, windowId: 8 },
        { ...request, context: { ...request.context, sourceTabId: 99 } }, { ...request, command: 'archiveContext' }
    ].map(value => ({ key: keyFor(value), fingerprint: JSON.stringify(value), response: { ok: true } }));
    unrelated.push({ ...item, key: keyFor(request, 'c'.repeat(32)) }, { ...item, key: `${item.key}-wrong-request-id` }, { fingerprint: 'bad JSON' }, { fingerprint: 'null' });
    const reads = [], chrome = { storage: { session: { get: async key => { reads.push(key); return { spotlightBridgeRequests: [...unrelated, item] }; } } } };
    const result = copy(await vm.runInNewContext(`(${readArchiveReopenJournal})(${JSON.stringify({ spotlightId: SPOTLIGHT, entryId: entry.entryId, windowId: 7, sourceTabId: 10, requests: [request] })})`, { chrome }));
    assert.deepEqual(reads, ['spotlightBridgeRequests']); assert.deepEqual(result.journal, [item]);
    assert.equal(result.responseEvidence, hasResponse ? 'retained-journal-response' : 'unavailable');
    assert.match(result.limitation, /without a response does not prove the action is still in flight/);
});
test('missing request trace cannot attribute another journal response to this attempt', async () => {
    const chrome = { storage: { session: { get: async () => assert.fail('No scope-based journal lookup without the observed request') } } };
    const result = copy(await vm.runInNewContext(`(${readArchiveReopenJournal})({requests: null})`, { chrome }));
    assert.deepEqual(result.journal, []); assert.equal(result.responseEvidence, 'unavailable'); assert.match(result.limitation, /request trace is unavailable/);
});
for (const fault of [null, 'diagnose', 'record']) test(`real reopen poll failure captures exact owned evidence before cleanup despite ${fault || 'no diagnostic fault'}`, async () => {
    const start = source.indexOf('            await withArchiveFailureEvidence(() => ui(origin.page, `Reopen exact archived twin');
    const end = source.indexOf('            // Repeating a captured real request', start), code = source.slice(start, end);
    const f = reopenFailureDiagnosticFixture(), calls = [], records = [], before = { original: 'baseline' };
    const original = Object.freeze(new Error('Original exact consumption timeout')), origin = { page: f.args.sourcePage, tab: { id: 10 } }, selected = { surface: f.args.sourceSurface };
    const params = { ...f.args, origin, selected, entry, kind: 'browser-newtab', method: 'Enter', attempt: {}, windowId: 7,
        withArchiveFailureEvidence, ui: async (page, label, run) => { assert.equal(page, origin.page); return run(); },
        settle: async () => before, reset: async () => {}, capture: async () => {}, browser: { targets: () => [] },
        invoke: async () => { calls.push('trusted-input'); }, poll: async () => { calls.push('poll'); throw original; }, read: () => assert.fail('No extra queued store reads'),
        collectArchiveReopenFailure: async args => { calls.push('diagnose'); assert.deepEqual(args, f.args); if (fault === 'diagnose') throw new Error('Diagnostic read failed'); return collectArchiveReopenFailure(args); },
        checkpoint: async (phase, proof) => { calls.push('record'); records.push({ phase, ...proof }); if (fault === 'record') throw new Error('Evidence write failed'); } };
    const run = new (Object.getPrototypeOf(async function () {}).constructor)(...Object.keys(params), code);
    let caught; try { await run(...Object.values(params)); } catch (error) { caught = error; } finally { calls.push('cleanup'); }
    assert.equal(caught, original); assert.deepEqual(calls, ['trusted-input', 'poll', 'diagnose', 'record', 'cleanup']);
    assert.equal(records[0].phase, 'archive-reopen-attempt-failed'); assert.equal(records[0].baseline, before);
    assert.equal(records[0].entryId, entry.entryId); assert.equal(records[0].sourceTabId, 10); assert.equal(records[0].windowId, 7);
    assert.equal(records[0].error.message, original.message); assert.equal(records[0].error.stack, original.stack);
    if (fault !== 'diagnose') assert.equal(records[0].observations.spotlight.value.statuses[0].text, f.values.spotlight.statuses[0].text);
});
test('reopen failure capture cannot dispatch, retry, resolve or mutate anything', () => {
    const diagnostics = source.slice(source.indexOf('export async function readArchiveReopenJournal'), source.indexOf('export async function withArchiveFailureEvidence'));
    assert.doesNotMatch(diagnostics, /runtime\.sendMessage|sidePanel\.open|tabs\.(?:update|create|remove)|storage\.\w+\.(?:set|remove)|\.focus\(|bringToFront|\.click\(|setTimeout|setInterval|waitFor|poll\(|trace\(|local\(/);
    assert.match(source, /'exact archive consumption and known created native ID active'\);/);
});

function destinationCaptureFixture({ before = () => {}, during = () => {} } = {}) {
    const data = reopenedFixture(), receipt = assertArchiveReopened(data.before, data.after, data.events, data.expected);
    const state = { authoritative: copy(data.after), tabs: data.after.tabs.map(tab => ({ ...copy(tab), incognito: false, status: 'complete' })),
        window: { id: 7, type: 'normal', incognito: false, focused: true }, events: [{ type: 'external', data: { message: reopen } }],
        document: { url: URL, visibility: 'visible', focused: true, readyState: 'complete', documentId: 'd'.repeat(32), timeOrigin: 100, width: 1050, height: 804 },
        targetUrl: URL, pageUrl: URL, pageTarget: null, captures: 0, calls: [], page: null };
    const old = { type: () => 'page', url: () => URL, page: () => assert.fail('An older same-address tab must never be selected.') };
    const target = { type: () => 'page', url: () => state.targetUrl, page: async () => state.page };
    state.targets = [old, target]; state.pageTarget = target;
    state.page = { target: () => state.pageTarget, url: () => state.pageUrl,
        evaluate: async callback => { assert.equal(callback, readArchiveDestinationDocument); state.calls.push('document'); return copy(state.document); } };
    const args = { browser: { targets: () => state.targets }, apiPage: { evaluate: async (callback, args) => {
        state.calls.push('native');
        return copy(await vm.runInNewContext(`(${callback})(args)`, { args, chrome: { tabs: { query: async () => copy(state.tabs) }, windows: { get: async id => { assert.equal(id, 7); return copy(state.window); } } } }));
    } }, observePage: async page => { assert.equal(page, state.page); state.calls.push('observe'); return page; },
    poll: async (read, predicate) => { const value = await read(); assert(predicate(value), 'No exact fresh target'); return value; },
    beforeTargets: new Set([old]), before: data.before, receipt, windowId: 7, url: URL,
    settle: async () => copy(state.authoritative), read: async () => copy(state.authoritative), trace: async () => ({ events: copy(state.events) }),
    capture: async (page, label) => { assert.equal(page, state.page); assert.equal(label, 'overlay-exact-reopened-destination'); state.captures++; state.calls.push('capture');
        await during(state); return { filename: 'exact-reopened-destination.png', url: URL }; }, label: 'overlay-exact-reopened-destination' };
    before(state, args, target, old);
    return { state, args, target, old, run: () => captureArchiveReopenedDestination(args) };
}
test('destination capture correlates one fresh target with the exact active native ID and never captures equal-URL predecessors', async () => {
    const fixture = destinationCaptureFixture(), result = await fixture.run();
    assert.equal(result.tabId, 30); assert.equal(result.windowId, 7); assert.equal(result.url, URL);
    assert.equal(result.screenshot.filename, 'exact-reopened-destination.png'); assert.equal(fixture.state.captures, 1);
    assert.deepEqual(result.nativeBefore, result.nativeAfter); assert.deepEqual(result.documentBefore, result.documentAfter);
    assert.deepEqual(result.before, result.after); assert.deepEqual(fixture.state.calls, ['observe', 'native', 'document', 'capture', 'document', 'native']);
});
for (const [name, before] of [
    ['reused native ID', (_s, args) => { args.receipt.tabId = 20; }],
    ['extra new native ID', s => { s.authoritative.tabs.push({ id: 31 }); }],
    ['unconsumed receipt', (_s, args) => { args.receipt.claim.phase = 'assigned'; }],
    ['changed receipt', s => { s.authoritative.claims.entries.chosen.expected.name = 'Changed'; }],
    ['different selected Space', s => { s.authoritative.activeSpaces[7] = 'selected'; }],
    ['multiple fresh same-address targets', (s, _args, target) => { s.targets.push({ ...target }); }],
    ['only an older same-address target', (s, _args, _target, old) => { s.targets = [old]; }],
    ['wrong fresh target URL', s => { s.targetUrl = 'https://wrong.test/'; }],
    ['wrong page URL', s => { s.pageUrl = 'https://wrong.test/'; }],
    ['wrong page target', (s, _args, _target, old) => { s.pageTarget = old; }],
    ['wrong native window', s => { s.tabs.at(-1).windowId = 8; }],
    ['inactive destination', s => { s.tabs.at(-1).active = false; }],
    ['another active source', s => { s.tabs[0].active = true; }],
    ['extra native tab at capture', s => { s.tabs.push({ id: 31, windowId: 7 }); }],
    ['unfocused destination window', s => { s.window.focused = false; }],
    ['private native window', s => { s.window.incognito = true; }],
    ['wrong native URL', s => { s.tabs.at(-1).url = 'https://wrong.test/'; }],
    ['pending navigation', s => { s.tabs.at(-1).pendingUrl = URL; }],
    ['native page loading', s => { s.tabs.at(-1).status = 'loading'; }],
    ['pinned target', s => { s.tabs.at(-1).pinned = true; }],
    ['hidden document', s => { s.document.visibility = 'hidden'; }],
    ['unfocused document', s => { s.document.focused = false; }],
    ['loading document', s => { s.document.readyState = 'loading'; }],
    ['wrong document URL', s => { s.document.url = 'https://wrong.test/'; }],
    ['missing document identity', s => { s.document.documentId = null; }],
    ['missing time origin', s => { s.document.timeOrigin = 0; }],
    ['empty viewport', s => { s.document.width = 0; }]
]) test(`destination capture rejects ${name} before taking a screenshot`, async () => {
    const fixture = destinationCaptureFixture({ before }); await assert.rejects(fixture.run()); assert.equal(fixture.state.captures, 0);
});
for (const [name, during] of [
    ['document replacement', s => { s.document.documentId = 'e'.repeat(32); }],
    ['same-URL document reload', s => { s.document.timeOrigin++; }],
    ['hidden document', s => { s.document.visibility = 'hidden'; }],
    ['native activation lost', s => { s.tabs.at(-1).active = false; }],
    ['window focus lost', s => { s.window.focused = false; }],
    ['native URL changed', s => { s.tabs.at(-1).url = 'https://wrong.test/'; }],
    ['extra same-address target', s => { s.targets.push({ ...s.targets.at(-1) }); }],
    ['original target retired', s => { s.targets.pop(); }],
    ['same-shaped target replacement', s => { s.targets[s.targets.length - 1] = { ...s.targets.at(-1) }; }],
    ['bookmark mutation', s => { s.authoritative.bookmarks[0].title = 'Changed'; }],
    ['journal mutation', s => { s.authoritative.journal.push({ key: 'unexpected' }); }],
    ['transient native activation', s => { s.events.push({ type: 'tabs.onActivated', data: [{ tabId: 10, windowId: 7 }] }); }],
    ['transient durable mutation', s => { s.events.push({ type: 'storage', data: { area: 'local', changes: { spaces: { oldValue: [], newValue: [{}] } } } }); }],
    ['observation erasure', s => { s.events = []; }],
    ['required capture failure', () => { throw new Error('Required capture failed'); }]
]) test(`destination capture rejects ${name} without retrying the screenshot or action`, async () => {
    const fixture = destinationCaptureFixture({ during }); await assert.rejects(fixture.run()); assert.equal(fixture.state.captures, 1);
});
for (const result of [undefined, {}, { filename: 'wrong.png', url: 'https://wrong.test/' }]) test(`missing or mislabeled required destination capture is fatal: ${JSON.stringify(result)}`, async () => {
    const fixture = destinationCaptureFixture(); fixture.args.capture = async () => result; await assert.rejects(fixture.run());
});
test('destination document reader only records real visibility, focus and stable document metadata', () => {
    const state = destinationCaptureFixture().state.document;
    const actual = vm.runInNewContext(`(${readArchiveDestinationDocument})()`, { location: { href: URL }, document: {
        visibilityState: 'visible', hasFocus: () => true, readyState: 'complete', body: { dataset: { documentId: state.documentId } } },
        performance: { timeOrigin: 100 }, innerWidth: 1050, innerHeight: 804 });
    assert.deepEqual(copy(actual), state);
    const helper = source.slice(source.indexOf('export function readArchiveDestinationDocument'), source.indexOf('export function assertArchiveNoMutation'));
    assert.doesNotMatch(helper, /bringToFront|tabs\.(?:update|create|remove)|windows\.update|\.focus\(|\.click\(|\.goto\(|waitForTimeout|setTimeout|timeout:|retry|ui\(/);
});

for (const captureFailure of [false, true]) test(`real reopen wiring persists action proof before required destination capture${captureFailure ? ' failure' : ''}`, async () => {
    const start = source.indexOf('                const before = await settle(); await reset();', source.indexOf('export async function exerciseSpotlightArchiveReopen'));
    const end = source.indexOf('\n            }), () => collectArchiveReopenFailure', start), code = source.slice(start, end);
    const data = reopenedFixture(), origin = { page: {}, tab: { id: 10 } }, oldTarget = {}, freshTarget = {}, calls = [], checkpoints = [], requests = [], evidence = { matrix: [] }, owned = [];
    let invoked = false;
    const params = { browser: { targets: () => invoked ? [oldTarget, freshTarget] : [oldTarget] }, observePage: {}, apiPage: {},
        origin, attempt: {}, selected: { surface: {} }, kind: 'overlay', method: 'click', title: `Reopen ${entry.name}`, entry,
        source: { id: 'selected' }, target: { id: 'original', name: 'Original', bookmarkFolderId: 'original-root' }, windowId: 7, spotlightId: SPOTLIGHT,
        settle: async () => data.before, reset: async () => {}, capture: async (page, label) => { assert.equal(page, origin.page); assert.equal(label, 'overlay-exact-entry-selected'); calls.push('selected'); },
        invoke: async () => { invoked = true; calls.push('trusted-input'); }, read: async () => data.after,
        poll: async (read, predicate) => { const value = await read(); assert(predicate(value)); return value; },
        trace: async () => ({ events: [...data.events, external(copy(reopen))], input: [input({ type: ARCHIVE_ENTRY_TYPE, title: `Reopen ${entry.name}`, entryId: entry.entryId, method: 'click' })] }),
        assertArchiveTrustedInput, ARCHIVE_ENTRY_TYPE, assertArchiveReopened, owned, requests, evidence,
        waitForArchiveReopenCompletion: async args => ({ request: reopen, receipt: await args.verifyCommitted(), status: null, overlayRetired: true }),
        checkpoint: async (phase, proof) => { calls.push(phase); checkpoints.push({ phase, ...proof }); },
        captureArchiveReopenedDestination: async args => {
            assert.deepEqual([...args.beforeTargets], [oldTarget]); assert.equal(args.receipt.tabId, 30);
            assert.equal(args.label, 'overlay-exact-reopened-destination'); assert.equal(args.url, URL);
            assert.equal(checkpoints.length, 1); assert.equal(checkpoints[0].overlayRetired, true);
            assert.deepEqual(checkpoints[0].after, data.after); calls.push('required-destination');
            if (captureFailure) throw new Error('Required destination capture failed');
            return { screenshot: { filename: 'destination.png', url: URL }, tabId: 30 };
        } };
    const run = new (Object.getPrototypeOf(async function () {}).constructor)(...Object.keys(params), code);
    if (captureFailure) await assert.rejects(run(...Object.values(params)), /Required destination capture failed/); else await run(...Object.values(params));
    assert.deepEqual(calls, ['selected', 'trusted-input', 'exact-archive-entry-reopened', 'required-destination', ...(!captureFailure ? ['exact-reopened-destination-captured'] : [])]);
    assert.equal(checkpoints[0].receipt.tabId, 30); assert.equal(evidence.matrix.length, 1); assert.deepEqual(owned, [30]);
});

function archiveCleanupFixture(fault = null) {
    const original = { tabs: [
        { id: 1, windowId: 7, url: 'about:blank', active: false, pinned: false, incognito: false, splitViewId: -1 },
        { id: 2, windowId: 7, url: `chrome-extension://${ARCIFY}/options.html`, active: false, pinned: false, incognito: false, splitViewId: -1 },
        { id: 3, windowId: 7, url: `chrome-extension://${SPOTLIGHT}/options.html`, active: true, pinned: false, incognito: false, splitViewId: -1 },
        { id: 4, windowId: 8, url: URL, active: true, pinned: false, incognito: false, splitViewId: -1 }
    ], windows: [{ id: 7, focused: false }, { id: 8, focused: true }], local: {}, sync: {}, session: { activeSpaces: { 7: 'home', 8: 'work' } } };
    if (fault === 'different-owner') original.session.activeSpaces[8] = 'selected-other';
    const state = copy(original), calls = [], evidence = { complete: true, checkpoints: [{ phase: 'archive-case-complete' }] };
    state.tabs.find(tab => tab.id === 4).active = false;
    state.tabs.push({ id: 90, windowId: 8, active: false }, { id: 91, windowId: 8, active: true });
    state.local = { archivedTabs: [{ entryId: 'fixture-entry' }], archiveReopenClaims: { version: 1, entries: { 'fixture-entry': { phase: 'consumed' } } } };
    state.session.activeSpaces[8] = 'fixture-space'; state.session.archiveBrowserSession = 'fixture-session'; state.sync.syncTabGroups = false;
    const activate = id => { const chosen = state.tabs.find(tab => tab.id === id); assert(chosen); for (const tab of state.tabs.filter(tab => tab.windowId === chosen.windowId)) tab.active = tab.id === id;
        // Mirror SpaceStore's tabs.onActivated owner-selection side effect.
        state.session.activeSpaces[chosen.windowId] = id === 4 ? 'work' : 'home'; };
    const focus = id => { for (const window of state.windows) window.focused = window.id === id; };
    const area = name => ({ get: async keys => copy(Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(key => Object.hasOwn(state[name], key)).map(key => [key, state[name][key]]))),
        set: async value => Object.assign(state[name], copy(value)), remove: async key => { delete state[name][key]; } });
    const chrome = { tabs: { query: async () => copy(state.tabs), update: async (id, options) => {
        assert.deepEqual(copy(options), { active: true }); calls.push(['activate', id]);
        if (fault === 'activation-fails' && id === 3) throw new Error('Exact original tab cannot be restored');
        if (fault !== 'activation-noop') activate(id);
    }, remove: async ids => { state.tabs = state.tabs.filter(tab => !(Array.isArray(ids) ? ids : [ids]).includes(tab.id)); } },
    windows: { update: async (id, options) => { assert.deepEqual(copy(options), { focused: true }); calls.push(['focus', id]); focus(id); } },
    storage: { local: area('local'), sync: area('sync'), session: area('session') } };
    const apiPage = { evaluate: async (fn, arg) => copy(await vm.runInNewContext(`(${fn.toString()})(arg)`, { chrome, arg: copy(arg) })) };
    const checkpoint = async (phase, data = {}) => { evidence.checkpoints.push({ phase, ...copy(data) }); };
    const params = { assert, finishBookmarkFixture, original, apiPage, revoked: false, adapters: {}, closeOverlay: async () => {}, favoriteIds: [],
        local: async message => { if (message.action === 'activate') { calls.push(['select', message.windowId, message.spaceId]); state.session.activeSpaces[message.windowId] = message.spaceId; }
            if (message.action === 'get' && fault === 'unrelated-selection') state.session.activeSpaces[8] = 'unowned';
            return { success: true, spaces: [] }; },
        owned: [90, 91], fixtureApi: { tab: { id: 90 } }, entries: [{ entryId: 'fixture-entry' }], roots: [], spaceRoots: [],
        archive: async message => { if (message.action === 'list') return copy(state.local.archivedTabs); assert.equal(message.action, 'replace'); state.local.archivedTabs = copy(message.entries); },
        option: async value => { assert.equal(value, false); calls.push(['option-ui']); activate(2); focus(7);
            if (fault === 'unrelated-url') state.tabs.find(tab => tab.id === 1).url = 'https://changed.test/';
            if (fault === 'unrelated-pin') state.tabs.find(tab => tab.id === 1).pinned = true;
            if (fault === 'unrelated-window') state.tabs.find(tab => tab.id === 1).windowId = 8;
            if (fault === 'unrelated-split') state.tabs.find(tab => tab.id === 1).splitViewId = 10;
            if (fault === 'unrelated-private') state.tabs.find(tab => tab.id === 1).incognito = true;
            if (fault === 'unrelated-tab') state.tabs.push({ id: 99, windowId: 7, active: false });
            if (fault === 'unrelated-archive') state.local.archivedTabs = [{ entryId: 'unowned' }];
            if (fault === 'unrelated-claim') state.local.archiveReopenClaims = { entries: { unowned: { phase: 'consumed' } } };
        }, exact: (values, id) => { const matches = values.filter(value => value.id === id); assert.equal(matches.length, 1); return matches[0]; }, checkpoint,
        primaryError: fault === 'primary-error' ? new Error('Original acceptance failure') : undefined };
    if (fault === 'primary-error') params.option = async () => { throw new Error('Cleanup option failure'); };
    const start = source.indexOf('        await finishBookmarkFixture([', source.indexOf('async function archiveFixture'));
    const end = source.indexOf('\n    }\n}', start);
    assert(start > 0 && end > start);
    const run = new (Object.getPrototypeOf(async function () {}).constructor)(...Object.keys(params), source.slice(start, end));
    return { run: () => run(...Object.values(params)), original, state, evidence, calls, primaryError: params.primaryError };
}

test('Archive cleanup restores exact original active tabs after its final settings UI, then original focus', async () => {
    const value = archiveCleanupFixture(); await value.run();
    assert.deepEqual(value.state.tabs, value.original.tabs); assert.deepEqual(value.state.windows, value.original.windows);
    assert.deepEqual(value.state.local, value.original.local); assert.deepEqual(value.state.sync, value.original.sync); assert.deepEqual(value.state.session, value.original.session);
    assert.deepEqual(value.calls, [['select', 7, 'home'], ['select', 8, 'work'], ['option-ui'], ['activate', 3], ['activate', 4], ['select', 7, 'home'], ['select', 8, 'work'], ['focus', 8]]);
    assert.equal(value.evidence.complete, true);
    assert.deepEqual(value.evidence.checkpoints.map(item => item.phase), ['archive-case-complete', 'archive-cleanup-observed', 'archive-cleanup-verified']);
});

test('Archive cleanup preserves a selected Space distinct from the restored active tab owner', async () => {
    const value = archiveCleanupFixture('different-owner'); await value.run();
    assert.deepEqual(value.state.tabs, value.original.tabs); assert.deepEqual(value.state.session.activeSpaces, value.original.session.activeSpaces);
    assert.deepEqual(value.calls.slice(-5), [['activate', 3], ['activate', 4], ['select', 7, 'home'], ['select', 8, 'selected-other'], ['focus', 8]]);
});

for (const fault of ['activation-noop', 'activation-fails', 'unrelated-url', 'unrelated-pin', 'unrelated-window', 'unrelated-split', 'unrelated-private', 'unrelated-tab', 'unrelated-archive', 'unrelated-claim', 'unrelated-selection']) {
    test(`Archive cleanup still fails closed and preserves completed action evidence for ${fault}`, async () => {
        const value = archiveCleanupFixture(fault); await assert.rejects(value.run(), AggregateError);
        assert.equal(value.evidence.complete, true); assert.equal(value.evidence.checkpoints[0].phase, 'archive-case-complete');
        const observed = value.evidence.checkpoints.find(item => item.phase === 'archive-cleanup-observed'); assert(observed);
        assert.deepEqual(observed.original, value.original); assert.deepEqual(observed.final.tabs, value.state.tabs);
        assert(!value.evidence.checkpoints.some(item => item.phase === 'archive-cleanup-verified'));
        assert.equal(value.evidence.checkpoints.at(-1).phase, 'archive-cleanup-failed'); assert(value.evidence.checkpoints.at(-1).errors.length);
    });
}

test('Archive cleanup records secondary failures without replacing the original acceptance failure', async () => {
    const value = archiveCleanupFixture('primary-error'); await value.run();
    assert.equal(value.primaryError.message, 'Original acceptance failure'); assert.deepEqual(value.primaryError.cleanupErrors, ['Cleanup option failure']);
    assert.equal(value.evidence.checkpoints.at(-1).phase, 'archive-cleanup-failed');
});

function archiveObserverFixture() {
    const emitter = () => { const listeners = new Set(); return { listeners, addListener: value => listeners.add(value), removeListener: value => listeners.delete(value), emit: (...args) => [...listeners].map(listener => listener(...args)) }; };
    const onConnect = emitter(), realm = { structuredClone, location: { href: `chrome-extension://${ARCIFY}/background.js` },
        chrome: { runtime: { id: ARCIFY, onConnect } } };
    const context = vm.createContext(realm);
    const evaluate = async (fn, arg) => copy(await vm.runInContext(`(${fn.toString()})(${JSON.stringify(arg)})`, context));
    const makePort = (sender = displayEvents()[0].data.sender, name = 'arcify-archive-display-v1') => ({ sender: copy(sender), name, onMessage: emitter(), onDisconnect: emitter(),
        postMessage: () => assert.fail('Observation must never respond.'), disconnect: () => assert.fail('Observation must never retire a production Port.') });
    return { onConnect, context, realm, evaluate, makePort };
}
test('worker observer only adds passive listeners to the actual Port and retains immutable sender/message snapshots', async () => {
    const f = archiveObserverFixture(); const identity = await f.evaluate(installArchiveIntentObservation, 'observer');
    assert.deepEqual(identity, { observerId: 'observer', extensionId: ARCIFY, workerUrl: `chrome-extension://${ARCIFY}/background.js` });
    const port = f.makePort(); assert.deepEqual(f.onConnect.emit(port), [undefined]);
    const message = ack().data.message; assert.deepEqual(port.onMessage.emit(message), [undefined]);
    message.token = 'mutated-later'; port.sender.url = 'https://changed.test/';
    const observed = await f.evaluate(readArchiveIntentObservation, 'observer');
    assert.equal(observed.events.length, 2); assert.equal(observed.events[0].data.sender.documentId, null);
    assert.equal(observed.events[0].data.sender.url, `chrome-extension://${ARCIFY}/sidebar.html`);
    assert.equal(observed.events[1].data.message.token, openRequest.token); assert.equal(observed.events[1].data.portId, observed.events[0].data.portId);
    assert.deepEqual(port.onDisconnect.emit(), [undefined]); assert.equal(port.onMessage.listeners.size, 0); assert.equal(port.onDisconnect.listeners.size, 0);
    assert.equal((await f.evaluate(readArchiveIntentObservation, 'observer')).events.at(-1).type, 'archive.port-disconnect');
    await f.evaluate(() => globalThis.__archiveIntentStop()); assert.equal(f.onConnect.listeners.size, 0);
    await assert.rejects(f.evaluate(readArchiveIntentObservation, 'observer'), /original Archive worker observation was lost/);
    const helper = source.slice(source.indexOf('export function installArchiveIntentObservation'), source.indexOf('export function readArchiveIntentObservation'));
    assert.doesNotMatch(helper, /\.connect\(|\.postMessage\(|\.disconnect\(|sendMessage|sendResponse|respond\(|getContexts|sidePanel|Object\.defineProperty/);
});
test('worker observation ignores other Port names and teardown removes all owned listeners without disconnecting receivers', async () => {
    const f = archiveObserverFixture(); await f.evaluate(installArchiveIntentObservation, 'first');
    const ignored = f.makePort(undefined, 'other'), first = f.makePort(), second = f.makePort();
    f.onConnect.emit(ignored); assert.equal(ignored.onMessage.listeners.size, 0);
    f.onConnect.emit(first); f.onConnect.emit(second); assert.equal(first.onMessage.listeners.size, 1); assert.equal(second.onMessage.listeners.size, 1);
    const snapshot = await f.evaluate(readArchiveIntentObservation, 'first'); assert.notEqual(snapshot.events[0].data.portId, snapshot.events[1].data.portId);
    await f.evaluate(installArchiveIntentObservation, 'second'); assert.equal(first.onMessage.listeners.size, 0); assert.equal(second.onDisconnect.listeners.size, 0);
    assert.equal(f.onConnect.listeners.size, 1); await assert.rejects(f.evaluate(readArchiveIntentObservation, 'first'), /observation was lost/);
    assert.deepEqual((await f.evaluate(readArchiveIntentObservation, 'second')).events, []);
    await f.evaluate(() => globalThis.__archiveIntentStop());
});
function observedWorkerFixture() {
    const f = archiveObserverFixture(), calls = [], worker = { evaluate: async (...args) => { calls.push(args[0].name || 'teardown'); return f.evaluate(...args); } };
    const target = { type: () => 'service_worker', url: () => `chrome-extension://${ARCIFY}/background.js`, worker: async () => { calls.push('existing-worker'); return worker; } };
    const state = { targets: [target] }, browser = { targets: () => state.targets };
    return { ...f, calls, worker, target, state, browser, start: () => observeArchiveDisplayWorker({ browser, arcifyId: ARCIFY, observerId: 'observer' }) };
}
test('worker observer uses one existing target and exact realm for its entire lifetime', async () => {
    const f = observedWorkerFixture(), observer = await f.start(); await observer.read(); assert.deepEqual(await observer.stop(), { stopped: true });
    assert.deepEqual(f.calls, ['existing-worker', 'installArchiveIntentObservation', 'readArchiveIntentObservation', 'teardown']);
    assert.equal(f.onConnect.listeners.size, 0);
});
for (const replacement of [false, true]) test(`retired worker observation fails without attaching, waking or adopting ${replacement ? 'a replacement' : 'a missing worker'}`, async () => {
    const f = observedWorkerFixture(), observer = await f.start();
    f.state.targets = replacement ? [{ ...f.target, worker: () => assert.fail('Must not adopt a replacement worker') }] : [];
    await assert.rejects(observer.read(), /original Archive worker retired/); assert.deepEqual(await observer.stop(), { retired: true });
    assert.deepEqual(f.calls, ['existing-worker', 'installArchiveIntentObservation']);
});
for (const count of [0, 2]) test(`worker observer rejects ${count} matching existing workers`, async () => {
    const f = observedWorkerFixture(); f.state.targets = count ? [f.target, { ...f.target }] : [];
    await assert.rejects(f.start(), /exactly one existing real background worker/); assert.deepEqual(f.calls, []);
});
test('observer identity loss in the same target is not silently reinstalled', async () => {
    const f = observedWorkerFixture(), observer = await f.start(); await f.evaluate(() => delete globalThis.__archiveDisplayObservation);
    await assert.rejects(observer.read(), /original Archive worker observation was lost/); await assert.rejects(observer.stop(), /ownership changed/);
    assert.equal(f.calls.filter(name => name === 'installArchiveIntentObservation').length, 1);
});
for (const invalid of ['extensionId', 'workerUrl']) test(`worker observer refuses incorrect ${invalid} before using its snapshots`, async () => {
    const f = observedWorkerFixture(); f.worker.evaluate = async () => ({ observerId: 'observer', extensionId: ARCIFY, workerUrl: `chrome-extension://${ARCIFY}/background.js`, [invalid]: 'wrong' });
    await assert.rejects(f.start());
});

test('ordinary-tab probe uses the actual registration transport, consumes lastError and cleans only its own test Port listeners', async () => {
    const f = archiveObserverFixture(), port = f.makePort(), messages = [], timers = [];
    f.realm.chrome.runtime.connect = options => { assert.deepEqual(copy(options), { name: 'arcify-archive-display-v1' }); return port; };
    f.realm.chrome.runtime.lastError = { message: 'Receiving end does not exist.' };
    f.realm.setTimeout = fn => { timers.push(fn); return 1; }; f.realm.clearTimeout = id => { assert.equal(id, 1); timers.length = 0; };
    port.postMessage = value => { messages.push(copy(value)); queueMicrotask(() => port.onDisconnect.emit()); };
    const result = await f.evaluate(probeArchiveDisplayRegistration, { windowId: 8, requestId: 'ordinary-wrong-window' });
    assert.deepEqual(result, { disconnected: true, error: 'Receiving end does not exist.', messages: [] });
    assert.deepEqual(messages, [{ type: 'arcifyArchiveDisplay', action: 'register', requestId: 'ordinary-wrong-window', windowId: 8 }]);
    assert.equal(port.onMessage.listeners.size, 0); assert.equal(port.onDisconnect.listeners.size, 0); assert.equal(timers.length, 0);
});
test('an ordinary-tab Port left alive fails its bounded negative probe rather than reporting refusal', async () => {
    const f = archiveObserverFixture(), port = f.makePort(); let expire, disconnected = 0;
    f.realm.chrome.runtime.connect = () => port; f.realm.setTimeout = fn => { expire = fn; return 1; }; f.realm.clearTimeout = () => {};
    port.postMessage = () => {}; port.disconnect = () => { disconnected++; };
    const pending = f.evaluate(probeArchiveDisplayRegistration, { windowId: 7, requestId: 'ordinary' }); expire();
    await assert.rejects(pending, /retained an unauthorized Archive display Port/); assert.equal(disconnected, 1); assert.equal(port.onMessage.listeners.size, 0);
});
test('hosted ordinary-tab negative retires its disposable tab before six native positives and does not turn another-window claims into native proof', () => {
    const block = source.slice(source.indexOf('export async function exerciseSpotlightArchiveOpen'), source.indexOf('export async function exerciseSpotlightArchiveReopen'));
    assert.match(block, /for \(const claimedWindow of \[windowId, otherWindow\]\)/);
    assert.match(block, /ordinary\.page\.evaluate\(probeArchiveDisplayRegistration/); assert.match(block, /assertArchiveNoMutation\(before, after, observed\.events\)/);
    assert.match(block, /response\.disconnected, true/); assert.match(block, /response\.messages, \[\]/);
    assert.match(block, /connections\.length, 1/); assert.match(block, /finally \{ await apiPage\.evaluate\(id => chrome\.tabs\.remove\(id\), ordinary\.tab\.id\); \}/);
    assert(block.indexOf('The rejection-only ordinary sidebar tab must be retired') < block.indexOf("for (const kind of ['owned-newtab'"));
    assert.match(block, /exerciseArchiveExistingPanel\(/); assert.match(block, /evidence\.matrix\.length, 6/);
});

test('status observer is passive and distinguishes identical old text from a newly written success', async () => {
    const label = { textContent: 'Arcify Archive opened.', isConnected: true }, observers = [];
    class MutationObserver { constructor(callback) { this.callback = callback; observers.push(this); } observe(node, options) { assert.equal(node, label); assert.deepEqual(copy(options), { childList: true, characterData: true, subtree: true }); } disconnect() { this.disconnected = true; } }
    const realm = vm.createContext({ document: { querySelector: selector => { assert.equal(selector, '.arcify-bridge-status [role="status"]'); return label; } }, MutationObserver });
    vm.runInContext(`(${installArchiveStatusObservation})()`, realm);
    assert.deepEqual(copy(realm.__archiveStatusObservation.events), [], 'Reading old success text cannot create new response evidence.');
    observers[0].callback(); assert.deepEqual(copy(realm.__archiveStatusObservation.events), [{ text: 'Arcify Archive opened.', connected: true }]);
    vm.runInContext(`(${installArchiveStatusObservation})()`, realm); assert.equal(observers[0].disconnected, true); assert.deepEqual(copy(realm.__archiveStatusObservation.events), []);
    realm.__archiveStatusObservation.stop(); assert.equal(observers[1].disconnected, true);
});
function existingPanelFixture(fault) {
    const before = reopenedFixture().before, previousEvents = displayEvents(), previousAck = assertArchiveNativeAck(previousEvents, openRequest, native, { arcifyId: ARCIFY, windowId: 7 });
    const request = { ...openRequest, requestId: 'reuse-open-request', token: 'new-one-use-token' }, calls = [], checkpoints = [];
    const state = { invoked: false, label: { textContent: 'Arcify Archive opened.', isConnected: true }, statusWrites: [{ text: 'Arcify Archive opened.', connected: true }],
        panel: { contexts: [copy(native.context)], events: [{ type: 'opened', windowId: 7 }] }, native: copy(native), popup: nativeState(), after: copy(before),
        events: [...previousEvents, portMessage('take', { requestId: 'take-reuse' }), portMessage('validate', { requestId: 'validate-reuse', token: request.token }),
            portMessage('ack', { requestId: 'ack-reuse', token: request.token, displayed: true })], document: { url: URL, timeOrigin: 123 } };
    const realm = vm.createContext({ document: { URL, querySelector: () => state.label }, performance: { timeOrigin: 123 }, MutationObserver: class { constructor() {} observe() {} disconnect() { calls.push('stop-status'); } } });
    const sourcePage = { evaluate: async fn => copy(await vm.runInContext(`(${fn.toString()})()`, realm)),
        waitForFunction: async fn => { assert.equal(vm.runInContext(`(${fn.toString()})()`, realm), true, 'New status is required'); },
        $eval: async () => state.label.textContent };
    const nativePage = { evaluate: async fn => { assert.equal(fn, readNativeArchivePopup); return copy(state.popup); } };
    const args = { nativePanel: { state: async () => copy(state.panel), capture: async (eventCount, label) => {
        assert.equal(eventCount, 0, 'Capture retains the original genuine opening receipt'); assert.equal(label, 'Archive existing native Side Panel reuse'); calls.push('native-capture'); return copy(state.native);
    }, resolve: async () => ({ page: nativePage }) }, origin: { page: sourcePage, tab: { id: 10 } }, previousRequest: openRequest, previousAck, previousNative: native,
        openingEventCount: 0, arcifyId: ARCIFY, spotlightId: SPOTLIGHT, source: { id: 'selected' },
        ready: async page => { assert.equal(page, sourcePage); calls.push('ready-original-source'); return { surface: sourcePage }; },
        invoke: async (_selected, method) => {
            assert.equal(method, 'Enter'); state.invoked = true; calls.push('trusted-input');
            if (fault === 'new-opening') state.panel.events.push({ type: 'opened', windowId: 7 });
            if (fault === 'replacement-context') state.panel.contexts[0].documentId = 'new-document';
            if (fault === 'different-capture-document') state.native.context.documentId = 'new-document';
            if (fault === 'different-capture-window') state.native.hosting.windowId = 8;
            if (fault === 'source-reload') realm.performance.timeOrigin++;
            if (fault === 'native-state-mutation') state.after.tabs[0].url = 'https://changed.test/';
            if (fault === 'hidden-popup') state.popup.popups[0].visible = false;
            if (fault === 'stale-status-only') state.statusWrites = [];
            if (fault === 'duplicate-status') state.statusWrites.push(copy(state.statusWrites[0]));
            if (fault === 'disconnected-status') state.statusWrites[0].connected = false;
            if (fault === 'replayed-token') { request.token = openRequest.token; for (const event of state.events.slice(-2)) event.data.message.token = request.token; }
            if (fault === 'new-session') for (const event of state.events.slice(-3)) event.data.message.session = 'other-session';
            if (fault === 'different-Port') for (const event of state.events.slice(-3)) event.data.portId = 'other-port';
            if (fault === 'cancelled-intent') state.events.splice(-1, 0, portMessage('cancel', { requestId: 'cancel', token: request.token }));
            realm.__archiveStatusObservation.events.push(...copy(state.statusWrites));
        }, settle: async () => copy(before), read: async () => copy(state.after), reset: async () => {},
        trace: async () => state.invoked ? { events: [{ type: 'external', data: { message: copy(request), sender: { id: SPOTLIGHT, url: URL } } }, ...copy(state.events)], input: [input()] }
            : { events: [external({ type: 'arcify-bridge', command: 'archiveContext', tabId: 10, windowId: 7 }), ...copy(previousEvents)] },
        capture: async (page, label) => {
            calls.push(label);
            if (label === 'existing-panel-native-archive-popup') {
                assert.equal(page, nativePage); if (fault === 'screenshot-fails') throw new Error('Required popup capture failed');
                if (fault === 'changed-after-capture') state.panel.events.push({ type: 'closed', windowId: 7 });
            } else assert.equal(page, sourcePage);
            return { filename: `${label}.png` };
        }, checkpoint: async (phase, proof) => checkpoints.push({ phase, ...copy(proof) }), ui: async (page, _label, callback) => { assert.equal(page, sourcePage); return callback(); },
        poll: async (read, accept) => { const value = await read(); assert(accept(value)); return value; }, windowId: 7 };
    return { run: () => exerciseArchiveExistingPanel(args), calls, checkpoints, state, request };
}
test('already-open execution uses a fresh genuine action on the original source and captures the unchanged real native document', async () => {
    const f = existingPanelFixture(); await f.run();
    assert.deepEqual(f.calls, ['ready-original-source', 'existing-panel-open-selected', 'trusted-input', 'stop-status', 'native-capture', 'existing-panel-native-archive-popup']);
    assert.equal(f.checkpoints.length, 1); const proof = f.checkpoints[0]; assert.equal(proof.phase, 'trusted-existing-native-archive-open');
    assert.deepEqual(proof.panelAfter, proof.panelBefore); assert.deepEqual(proof.native.context, native.context);
    assert.equal(proof.request.token, f.request.token); assert.notEqual(proof.request.token, openRequest.token);
    assert.deepEqual(proof.statusWrites, [{ text: 'Arcify Archive opened.', connected: true }]); assert.deepEqual(proof.before, proof.after);
});
for (const fault of ['new-opening', 'replacement-context', 'different-capture-document', 'different-capture-window', 'source-reload', 'native-state-mutation',
    'hidden-popup', 'stale-status-only', 'duplicate-status', 'disconnected-status', 'replayed-token', 'new-session', 'different-Port', 'cancelled-intent', 'screenshot-fails', 'changed-after-capture'])
    test(`already-open execution fails closed without repeating trusted input for ${fault}`, async () => {
        const f = existingPanelFixture(fault); await assert.rejects(f.run()); assert.equal(f.calls.filter(value => value === 'trusted-input').length, 1);
        assert.equal(f.calls.filter(value => value === 'stop-status').length, 1); assert.deepEqual(f.checkpoints, []);
    });

function noGestureProbeFixture({ activations = [true, true, false], atPrepare, atBaseline, response, transportError = null, throwAt } = {}) {
    const calls = [], nativeSends = [], samples = [...activations], state = { activation: true, url: `chrome-extension://${SPOTLIGHT}/newtab.html`, timeOrigin: 1000 };
    const requestId = 'strict-no-gesture', token = 'fresh-after-expiry';
    const rejection = response || { type: 'arcify-archive-open', version: 1, requestId, role: 'arcify', ok: false,
        error: { code: 'OPEN_FAILED', message: '`sidePanel.open()` may only be called in response to a user gesture.' } };
    const session = { send: async (method, options) => {
        assert.equal(method, 'Runtime.evaluate'); assert.equal(options.userGesture, false); assert.equal(options.awaitPromise, true); assert.equal(options.returnByValue, true);
        const sending = options.expression.includes('chrome.runtime.sendMessage'); calls.push(sending ? 'send-evaluation' : 'activation-read');
        if (throwAt === (sending ? 'send' : 'read')) return { exceptionDetails: { text: 'Original CDP exception' } };
        if (!sending && samples.length) state.activation = samples.shift();
        const navigator = { userActivation: { get isActive() { return state.activation; }, hasBeenActive: true } };
        const result = await vm.runInNewContext(options.expression, { navigator, document: { URL: state.url }, performance: { timeOrigin: state.timeOrigin },
            chrome: { runtime: { lastError: transportError ? { message: transportError } : undefined, sendMessage: (id, request, done) => {
                assert.equal(id, ARCIFY); nativeSends.push(copy(request)); calls.push('actual-send'); done(copy(rejection));
            } } } });
        return { result: { value: copy(result) } };
    }, detach: async () => calls.push('detach') };
    const args = { page: { createCDPSession: async () => { calls.push('session'); return session; }, evaluate: () => assert.fail('No gesture-bearing Puppeteer evaluation.') },
        poll: async (read, accept) => { for (let count = 0; count < 4; count++) { const value = await read(); if (accept(value)) return value; } throw new Error('Activation never expired'); },
        prepare: async () => { calls.push('prepare-fresh-token'); assert.equal(state.activation, false); atPrepare?.(state); return { ok: true, archiveActions: { openIntent: token } }; },
        baseline: async () => { calls.push('baseline'); atBaseline?.(state); return { before: { tabs: [] }, panel: { contexts: [], events: [] } }; }, arcifyId: ARCIFY, requestId };
    return { run: () => probeArchiveOpenWithoutGesture(args), args, state, calls, nativeSends, rejection };
}
test('no-gesture probe waits for observed expiry before a fresh token and atomically sends once without adding activation', async () => {
    const f = noGestureProbeFixture(), probe = await f.run(); assertArchiveNoGestureRejection(probe);
    assert.deepEqual(f.calls, ['session', 'activation-read', 'activation-read', 'activation-read', 'prepare-fresh-token', 'baseline', 'send-evaluation', 'actual-send', 'detach']);
    assert.deepEqual(probe.activationSamples.map(value => value.isActive), [true, true, false]); assert.equal(probe.activation.isActive, false);
    assert.deepEqual(f.nativeSends, [{ type: 'arcify-archive-open', version: 1, requestId: 'strict-no-gesture', token: 'fresh-after-expiry' }]);
    assert.deepEqual(probe.response, f.rejection); assert.deepEqual(probe.baseline.panel, { contexts: [], events: [] });
});
for (const [name, mutation] of [
    ['new real activation', state => { state.activation = true; }],
    ['same-address document reload', state => { state.timeOrigin++; }],
    ['navigation', state => { state.url = 'https://different.test/'; }]
]) test(`no-gesture probe refuses to send or retry after ${name} during preparation`, async () => {
    const f = noGestureProbeFixture({ atPrepare: mutation }), probe = await f.run();
    assert.equal(probe.sent, false); assert.deepEqual(f.nativeSends, []); assert.throws(() => assertArchiveNoGestureRejection(probe));
    assert.equal(f.calls.filter(value => value === 'send-evaluation').length, 1); assert.equal(f.calls.at(-1), 'detach');
});
test('no-gesture probe atomically guards against activation reacquired during native/store baseline reads', async () => {
    const f = noGestureProbeFixture({ atBaseline: state => { state.activation = true; } }), probe = await f.run();
    assert.equal(probe.sent, false); assert.equal(probe.activation.isActive, true); assert.deepEqual(f.nativeSends, []);
});
test('activation that never expires fails before any token preparation or actual send', async () => {
    const f = noGestureProbeFixture({ activations: [true] }); await assert.rejects(f.run(), /Activation never expired/);
    assert.deepEqual(f.calls, ['session', 'activation-read', 'activation-read', 'activation-read', 'activation-read', 'detach']); assert.deepEqual(f.nativeSends, []);
});
for (const throwAt of ['read', 'send']) test(`CDP ${throwAt} failure is not converted into no-gesture refusal or retried`, async () => {
    const f = noGestureProbeFixture({ throwAt }); await assert.rejects(f.run(), /Non-gesture probe failed/);
    assert.deepEqual(f.nativeSends, []); assert.equal(f.calls.at(-1), 'detach');
});
test('fresh-token preparation failure cannot be mistaken for native gesture enforcement', async () => {
    const f = noGestureProbeFixture(); f.args.prepare = async () => ({ ok: false, error: { code: 'STALE_ARCHIVE' } });
    await assert.rejects(f.run()); assert.deepEqual(f.nativeSends, []); assert.equal(f.calls.at(-1), 'detach');
});
for (const [name, change] of [
    ['native acceptance', value => { value.response.ok = true; value.response.displayed = true; }],
    ['stale token', value => { value.response.error.code = 'STALE_ARCHIVE'; }],
    ['authorization rejection', value => { value.response.error.code = 'UNAUTHORIZED'; }],
    ['unrelated native failure', value => { value.response.error.message = 'Window is unavailable'; }],
    ['wrong response request', value => { value.response.requestId = 'another-request'; }],
    ['wrong response protocol', value => { value.response.type = 'arcify-sidebar'; }],
    ['wrong response version', value => { value.response.version = 2; }],
    ['wrong response role', value => { value.response.role = 'spotlight'; }],
    ['transport failure', value => { value.transportError = 'Receiving end does not exist'; }],
    ['active source', value => { value.activation.isActive = true; }],
    ['missing expiry observation', value => { value.activationSamples = []; }],
    ['changed document', value => { value.activation.timeOrigin++; }]
]) test(`no-gesture result oracle rejects ${name}`, async () => {
    const probe = await noGestureProbeFixture().run(); change(probe); assert.throws(() => assertArchiveNoGestureRejection(probe));
});
test('activation reader uses real browser state and treats missing activation API as unavailable', () => {
    const run = navigator => copy(vm.runInNewContext(`(${readArchiveActivation})()`, { navigator, document: { URL }, performance: { timeOrigin: 50 } }));
    assert.deepEqual(run({ userActivation: { isActive: false, hasBeenActive: true } }), { isActive: false, hasBeenActive: true, url: URL, timeOrigin: 50 });
    assert.deepEqual(run({}), { isActive: null, hasBeenActive: null, url: URL, timeOrigin: 50 });
});
test('no-gesture wiring records raw evidence before strict native rejection and no-panel assertions', () => {
    const block = source.slice(source.indexOf("        const origin = await sourcePage('owned-newtab', current); await ready(origin.page);", source.indexOf('export async function exerciseSpotlightArchiveOpen')), source.indexOf('export async function exerciseSpotlightArchiveReopen'));
    assert.match(block, /probeArchiveOpenWithoutGesture/); assert.match(block, /prepare: \(\) => external\(spotlightOptions, arcifyId, 'archiveContext'/);
    assert(block.indexOf("checkpoint('non-gesture-archive-open-observed'") < block.indexOf('assertArchiveNoGestureRejection(probe)'));
    assert.match(block, /assertArchiveNoMutation\(before, after, observed\.events\)/); assert.match(block, /assert\.deepEqual\(panelAfter\.events, panel\.events\)/);
    assert.match(block, /assert\.deepEqual\(panel\.contexts, \[\]\)/); assert.match(block, /assert\.deepEqual\(panelAfter\.contexts, \[\]\)/);
    const helper = source.slice(source.indexOf('export async function probeArchiveOpenWithoutGesture'), source.indexOf('export function assertArchiveNoGestureRejection'));
    assert.doesNotMatch(helper, /page\.evaluate|sleep\(|setTimeout\(|\.press\(|\.click\(|userGesture:\s*true/);
});

test('passive Archive selection timeline records refresh delivery, query and lost default selection without repairing it or exposing tokens',async()=>{
 const {document,window}=parseHTML('<html><body><input data-testid="spotlight-input" value="open archive"><div data-testid="spotlight-results"><div data-testid="spotlight-result" data-result-type="arcify-archive-action" class="selected"><span class="arcify-spotlight-result-title">Open Archive</span></div></div></body></html>');
 document.hasFocus=()=>true;const listeners=new Set();
 const context=vm.createContext({document,MutationObserver:window.MutationObserver,performance:{now:()=>10},structuredClone,
  chrome:{runtime:{onMessage:{addListener:fn=>listeners.add(fn),removeListener:fn=>listeners.delete(fn)},sendMessage:()=>assert.fail('No context fetch or action may be sent by observation.')}}});
 vm.runInContext(`(${installArchiveSelectionObservation.toString()})()`,context);
 const read=()=>JSON.parse(JSON.stringify(vm.runInContext(`(${readArchiveSelectionEvidence.toString()})()`,context)));
 assert.equal(read().events[0].type,'installed-before-typing');assert.equal(read().current.query,'open archive');
 for(const listener of listeners)listener({action:'spotlightArcifyResultsChanged',windowId:7,openIntent:'SECRET-TOKEN'}, {id:SPOTLIGHT});
 document.querySelector('[data-testid="spotlight-result"]').classList.remove('selected');await new Promise(resolve=>setImmediate(resolve));
 const evidence=read();assert(evidence.events.some(event=>event.type==='context-refresh-delivery'&&event.windowId===7));
 assert(evidence.events.some(event=>event.type==='result-mutation'&&event.rows[0].selected===false));assert.equal(evidence.current.rows[0].selected,false);
 assert(!JSON.stringify(evidence).includes('SECRET-TOKEN'));
 vm.runInContext('globalThis.__archiveSelectionObservation.stop()',context);assert.equal(listeners.size,0);
});
test('Archive readiness retains hard default Enter assertion and captures evidence before typing, assertion and cleanup',()=>{
 assert.match(source,/archive-selection-before-typing[\s\S]*?await search\(page,query\)/);
 assert.match(source,/archive-selection-before-default-Enter-assertion[\s\S]*?if \(!entryId\) assertMatchedActionFirst/);
 assert.match(source,/finally \{[\s\S]*?archive-selection-before-cleanup[\s\S]*?finishBookmarkFixture/);
 assert.doesNotMatch(installArchiveSelectionObservation.toString(),/sendMessage|dispatchEvent|\.focus\(|\.click\(|selectedIndex\s*=/);
});
