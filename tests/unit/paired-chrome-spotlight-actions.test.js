import test from 'node:test';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertSpotlightActionEnvironment, serveSpotlightActionFixture, assertSpotlightActionContext, assertSpotlightActionUnchanged,
    assertSpotlightActionNoWrites, assertSpotlightActionInput, assertSpotlightActionRequest, assertSpotlightHelperProof, assertSpotlightActionCommitted,
    assertSpotlightSettingsOpened, assertSpotlightActionPrompt, installSpotlightActionInputObservation, waitForSpotlightActionCompletion, assertSpotlightHelperActionRows, SPACE_ACTION_TITLES, SPACE_ACTION_FEATURES } from '../../scripts/paired-chrome-spotlight-actions.mjs';
const PEER = 'b'.repeat(32), OWN = 'a'.repeat(32), URL = 'http://127.0.0.1/same-address';
const clone = structuredClone;
const leaf = (id, parentId, index, title = id) => ({ id, parentId, index, title, url: URL, dateAdded: 10 });
const folder = (id, parentId, index, children) => ({ id, parentId, index, title: id, dateAdded: 10, children });
const flat = nodes => nodes.flatMap(node => [node, ...flat(node.children || [])]);
function project(state) {
    const records = state.savedSnapshot || [];
    state.savedSnapshot = state.spaces.flatMap(space => ['spaceBookmarks', 'temporaryTabs'].flatMap(section => space[section].map((tabId, order) => ({
        ...records.find(item => item.tabId === tabId), tabId, spaceId: space.id, section, order, url: URL, windowKey: `window-${state.tabs.find(tab => tab.id === tabId).windowId}`, tabIndex: state.tabs.find(tab => tab.id === tabId).index,
        ...(state.bindings[tabId] ? { pinnedState: clone(state.bindings[tabId]) } : {}), ...(state.aliases[tabId] ? { nameOverride: clone(state.aliases[tabId]) } : {})
    }))));
    for (const record of state.savedSnapshot) { if (!state.bindings[record.tabId]) delete record.pinnedState; if (!state.aliases[record.tabId]) delete record.nameOverride; }
    state.snapshots = Object.fromEntries([7, 8].map(wid => {
        const local = ids => ids.filter(id => state.tabs.find(tab => tab.id === id).windowId === wid);
        return [wid, { windowId: wid, capturedAt: 123, activeSpaceId: state.activeSpaces[wid],
            spaces: state.spaces.map(space => ({ id: space.id, bookmarkFolderId: space.bookmarkFolderId, pinnedTabIds: local(space.spaceBookmarks), temporaryTabIds: local(space.temporaryTabs), tabIds: local([...space.spaceBookmarks, ...space.temporaryTabs]) })),
            bookmarks: state.spaces.flatMap(space => flat([flat(state.bookmarks).find(node => node.id === space.bookmarkFolderId)]).filter(node => node.url).map(node => ({ id: node.id, spaceId: space.id, title: node.title, url: node.url, tabId: local(space.spaceBookmarks).find(id => state.bindings[id]?.bookmarkId === node.id) ?? null }))),
            tabs: state.tabs.filter(tab => tab.windowId === wid).map(tab => ({ id: tab.id, windowId: wid, active: tab.active, pinned: tab.pinned, url: tab.url, title: tab.title, spaceId: state.spaces.find(space => [...space.spaceBookmarks, ...space.temporaryTabs].includes(tab.id))?.id || null })) }];
    })); return state;
}
function sample(command = 'pinCurrentTab') {
    const tabs = [101, 102, 201, 202, 301].map((id, index) => ({ id, windowId: id >= 200 && id < 300 ? 8 : 7, index, url: URL, pendingUrl: null, title: `Native ${id}`, active: id === 101 || id === 202, pinned: id === 301, groupId: -1, splitViewId: -1, incognito: false }));
    const before = project({ tabs, windows: [{ id: 7, focused: true }, { id: 8, focused: false }], groups: [], projection: {},
        spaces: [{ id: 'work', bookmarkFolderId: 'root-work', name: 'Work', spaceBookmarks: [102, 201], temporaryTabs: [101] }, { id: 'home', bookmarkFolderId: 'root-home', name: 'Home', spaceBookmarks: [202], temporaryTabs: [] }],
        bookmarks: [folder('root', '0', 0, [folder('root-work', 'root', 0, [leaf('decoy', 'root-work', 0), folder('nested', 'root-work', 1, [leaf('nested-pin', 'nested', 0)])]), folder('root-home', 'root', 1, [leaf('counterpart', 'root-home', 0)])])],
        bindings: { 102: { bookmarkId: 'decoy', pinnedUrl: URL }, 201: { bookmarkId: 'decoy', pinnedUrl: URL }, 202: { bookmarkId: 'counterpart', pinnedUrl: URL } }, aliases: {},
        favorites: [{ id: 'favorite', url: URL }], favoriteSession: { bindings: [{ favoriteId: 'favorite', tabId: 301, windowId: 7 }] },
        pageStates: Object.fromEntries(tabs.map(tab => [tab.id, { documentId: `doc-${tab.id}`, url: URL, timeOrigin: tab.id, value: `typed-${tab.id}` }])), activeSpaces: { 7: 'work', 8: 'home' }, pairingGeneration: 'arcify-generation', journal: [] });
    if (command === 'removeCurrentPin') {
        before.bookmarks[0].children[0].children.push(leaf('pin', 'root-work', 2, 'Native 101'));
        before.spaces[0].temporaryTabs = []; before.spaces[0].spaceBookmarks.push(101); before.bindings[101] = { bookmarkId: 'pin', pinnedUrl: URL };
        before.bindings[201] = { bookmarkId: 'pin', pinnedUrl: URL }; before.aliases[201] = { title: 'Native 101', url: URL }; project(before);
    }
    const context = { windowId: 7, sourceTabId: 101, spaceId: 'work', bookmarkFolderId: 'root-work', pairingGeneration: 'arcify-generation', tab: { id: 101, title: 'Native 101', url: URL, section: command === 'removeCurrentPin' ? 'saved' : 'today', bookmark: command === 'removeCurrentPin' ? { id: 'pin', parentId: 'root-work', title: 'Native 101', url: URL } : null } };
    const after = clone(before), resultId = command === 'createSpaceFolder' ? 'new-folder' : 'pin', title = 'Named folder';
    const root = after.bookmarks[0].children[0];
    if (command === 'removeCurrentPin') {
        root.children.pop(); after.spaces[0].spaceBookmarks = [102]; after.spaces[0].temporaryTabs = [101, 201]; delete after.bindings[101]; delete after.bindings[201]; delete after.aliases[201];
    } else if (command === 'pinCurrentTab') {
        root.children.push(leaf('pin', 'root-work', 2, 'Native 101')); after.spaces[0].spaceBookmarks.push(101); after.spaces[0].temporaryTabs = []; after.bindings[101] = { bookmarkId: 'pin', pinnedUrl: URL };
    } else root.children.push({ ...folder(resultId, 'root-work', 2, []), title });
    project(after);
    const request = { type: 'arcify-bridge', version: 1, requestId: 'actual-ui-request', command, windowId: 7, supportedFeatures: SPACE_ACTION_FEATURES, context, ...(command === 'createSpaceFolder' ? { title } : command === 'removeCurrentPin' ? { confirmed: true } : {}) };
    after.journal.push({ key: 'one', fingerprint: JSON.stringify(request), response: { ok: true, [command === 'createSpaceFolder' ? 'folderId' : 'bookmarkId']: resultId } });
    const events = [{ type: `bookmarks.${command === 'removeCurrentPin' ? 'onRemoved' : 'onCreated'}`, data: [resultId, {}] }, { type: 'external', data: { message: request, sender: { id: PEER } } }];
    return { before, after, options: { command, context, resultId, title, request, events } };
}

test('import-safe fixture has no launch, native helper, policy or permission side effects', () => {
    const source = readFileSync(new globalThis.URL('../../scripts/paired-chrome-spotlight-actions.mjs', import.meta.url), 'utf8');
    assert(!/from ['"].*(?:paired-chrome-smoke|paired-chrome-runtime|child_process)/.test(source));
    assert(!/\.launch\(|--no-sandbox|disable-setuid-sandbox|execFile|spawn\(/.test(source));
    assert.match(source, /export async function exerciseSpotlightActions/); assert.match(source, /assertSpotlightActionEnvironment\(\);/);
});
test('hosted environment fails closed for local/root calls', () => {
    assertSpotlightActionEnvironment({ GITHUB_ACTIONS: 'true', CI: 'true' }, 1001);
    for (const [env, uid] of [[{}, 1001], [{ GITHUB_ACTIONS: 'true' }, 1001], [{ GITHUB_ACTIONS: 'true', CI: 'true' }, 0]]) assert.throws(() => assertSpotlightActionEnvironment(env, uid));
});
test('fixture HTTP route is exact, nonce-bound, no-cache and keeps independent page state', () => {
    let header, body; const response = { writeHead: (code, headers) => { assert.equal(code, 200); header = headers; }, end: text => { body = text; } };
    assert.equal(serveSpotlightActionFixture({ url: '/other' }, response), false);
    assert.equal(serveSpotlightActionFixture({ url: `/spotlight-actions/${'a'.repeat(32)}/source` }, response), true);
    assert.equal(header['Cache-Control'], 'no-store'); assert.match(header['Content-Security-Policy'], /default-src 'none'/); assert.match(body, /data-document-id="[a-f0-9]{32}"/); assert.match(body, /id="action-page-state"/);
});
for (const command of ['pinCurrentTab', 'removeCurrentPin', 'createSpaceFolder']) test(`${command} validates exact bookmark, native, all-window and durable identity`, () => {
    const s = sample(command); assertSpotlightActionCommitted(s.before, s.after, s.options);
});
for (const [name, mutate] of Object.entries({
    duplicateBinding: s => s.after.spaces[1].temporaryTabs.push(101), nativeReplacement: s => s.after.tabs[0].id = 999,
    nativeNavigation: s => s.after.tabs[0].url = 'http://wrong/', nativeReorder: s => s.after.tabs[0].index = 4,
    nativeWindow: s => s.after.tabs[0].windowId = 8, nativePin: s => s.after.tabs[0].pinned = true,
    nativeFocus: s => s.after.tabs[0].active = false, nativeGroup: s => s.after.tabs[0].groupId = 88,
    counterpartSelection: s => s.after.activeSpaces[8] = 'work', windowFocus: s => s.after.windows[1].focused = true,
    lostPageInput: s => s.after.pageStates[101].value = '', reloadedPage: s => s.after.pageStates[101].timeOrigin++,
    wrongSameUrlPin: s => s.after.bindings[101].bookmarkId = 'decoy', changedDecoyMetadata: s => s.after.bookmarks[0].children[0].children[0].title = 'changed',
    changedNestedOrder: s => s.after.bookmarks[0].children[0].children[1].children[0].index = 9,
    changedCounterpart: s => s.after.bookmarks[0].children[1].children[0].url = 'http://wrong/',
    lostSavedRecord: s => s.after.savedSnapshot.pop(), duplicateSavedRecord: s => s.after.savedSnapshot.push(clone(s.after.savedSnapshot[0])),
    wrongDurableOrder: s => s.after.savedSnapshot.find(item => item.tabId === 101).order = 9,
    duplicateMutation: s => s.options.events.push(clone(s.options.events[0])), transientReorder: s => s.options.events.push({ type: 'tabs.onMoved', data: [101, {}] }),
    transientNavigate: s => s.options.events.push({ type: 'tabs.onUpdated', data: { id: 101, change: { url: 'http://wrong/' } } }),
    sidebarOpened: s => s.options.events.push({ type: 'sidePanel.onOpened', data: [] }),
    missingReceipt: s => s.after.journal = [], duplicateReceipt: s => s.after.journal.push(clone(s.after.journal[0])),
    staleSnapshot: s => s.after.snapshots[7].spaces[0].pinnedTabIds = [102]
})) test(`positive proof rejects ${name}`, () => { const s = sample(); mutate(s); assert.throws(() => assertSpotlightActionCommitted(s.before, s.after, s.options)); });
for (const [name, mutate] of Object.entries({ keepsRemovedBinding: s => s.after.bindings[201] = clone(s.before.bindings[201]), closesLinkedCopy: s => s.after.tabs = s.after.tabs.filter(tab => tab.id !== 201), deletesDecoy: s => s.after.bookmarks[0].children[0].children.shift(), clearsUnrelatedBinding: s => delete s.after.bindings[102], leavesAlias: s => s.after.aliases[201] = clone(s.before.aliases[201]) })) test(`Remove proof rejects ${name}`, () => { const s = sample('removeCurrentPin'); mutate(s); assert.throws(() => assertSpotlightActionCommitted(s.before, s.after, s.options)); });

test('source context requires the exact active source and saved metadata', () => {
    for (const command of ['pinCurrentTab', 'removeCurrentPin']) { const s = sample(command); assertSpotlightActionContext(s.options.context, s.before, { windowId: 7, sourceTabId: 101, section: command === 'pinCurrentTab' ? 'today' : 'saved', bookmarkId: command === 'removeCurrentPin' ? 'pin' : null }); }
});
for (const [name, mutate] of Object.entries({ wrongTab: s => s.options.context.sourceTabId = 201, previousTabGuess: s => s.options.context.tab.id = 201, wrongWindow: s => s.options.context.windowId = 8, wrongRoot: s => s.options.context.bookmarkFolderId = 'root-home', wrongGeneration: s => s.options.context.pairingGeneration = 'old', staleUrl: s => s.options.context.tab.url = 'http://old/', inactive: s => s.before.tabs[0].active = false, surplus: s => s.options.context.guess = true })) test(`source context rejects ${name}`, () => { const s = sample(); mutate(s); assert.throws(() => assertSpotlightActionContext(s.options.context, s.before, { windowId: 7, sourceTabId: 101, section: 'today' })); });
test('helper null context rejects any previous-tab guess', () => { const s = sample(); const options = { windowId: 7, sourceTabId: 101, section: null }; assert.throws(() => assertSpotlightActionContext(s.options.context, s.before, options)); s.options.context.tab = null; assertSpotlightActionContext(s.options.context, s.before, options); });
test('cancel equality ignores only capture time and rejects even durable journal writes', () => { const s = sample(); const after = clone(s.before); after.snapshots[7].capturedAt++; assertSpotlightActionUnchanged(s.before, after); after.journal.push({ pending: true }); assert.throws(() => assertSpotlightActionUnchanged(s.before, after)); });
for (const event of [{ type: 'bookmarks.onCreated', data: ['id'] }, { type: 'tabs.onCreated', data: [] }, { type: 'windows.onFocusChanged', data: [8] }, { type: 'storage', data: { area: 'local', changes: { spaces: { oldValue: [], newValue: [{}] } } } }, { type: 'external', data: { message: { command: 'createSpaceFolder' } } }]) test(`cancel zero-write proof rejects ${event.type}`, () => assert.throws(() => assertSpotlightActionNoWrites([event])));
test('rejected malformed real request is distinguished from a cancelled UI action', () => { const events = [{ type: 'external', data: { message: { command: 'pinCurrentTab' } } }]; assertSpotlightActionNoWrites(events, { allowRejectedRequests: true }); });

function input(command, extras = []) { return [{ type: 'click', trusted: true, repeat: false, composing: false, ctrl: false, alt: false, meta: false, title: SPACE_ACTION_TITLES[command], resultType: 'arcify-space-action', inPrompt: false }, ...extras.map(extra => ({ type: 'click', trusted: true, repeat: false, composing: false, ctrl: false, alt: false, meta: false, inPrompt: true, ...extra }))]; }
test('destructive input requires a separate trusted confirm and supports zero-write cancellation', () => {
    assertSpotlightActionInput(input('removeCurrentPin', [{ confirm: 'removeCurrentPin' }]), 'removeCurrentPin', { confirmed: true });
    assertSpotlightActionInput(input('removeCurrentPin', [{ type: 'keydown', key: 'Escape' }]), 'removeCurrentPin', { cancelled: true });
    for (const mutation of [events => events[1].trusted = false, events => events[1].repeat = true, events => events[1].composing = true, events => events[1].ctrl = true, events => events.pop(), events => events.push(clone(events[0]))]) { const events = input('removeCurrentPin', [{ confirm: 'removeCurrentPin' }]); mutation(events); assert.throws(() => assertSpotlightActionInput(events, 'removeCurrentPin', { confirmed: true })); }
});
test('request evidence is exactly once, peer-authenticated and full-context bound', () => {
    const s = sample('removeCurrentPin'), events = s.options.events;
    assertSpotlightActionRequest(events, 'removeCurrentPin', s.options.context, PEER, { confirmed: true });
    for (const mutation of [events => events.push(clone(events[1])), events => events[1].data.sender.id = OWN, events => events[1].data.message.context = { ...events[1].data.message.context, sourceTabId: 202 }, events => events[1].data.message.confirmed = false, events => events[1].data.message.unexpected = true]) { const next = clone(events); mutation(next); assert.throws(() => assertSpotlightActionRequest(next, 'removeCurrentPin', s.options.context, PEER, { confirmed: true })); }
});
function helperProof() {
    const state = { url: `chrome-extension://${PEER}/newtab.html`, visibility: 'visible', tab: { id: 77, windowId: 7, active: true, status: 'complete', url: 'chrome://newtab/' } };
    const message = { nonce: '00000000-0000-0000-0000-000000000001', tabId: 77, windowId: 7 };
    const events = [{ type: 'internal', data: { message: { ...message, action: 'spotlightNewTabReuseProbe' }, sender: { id: PEER, url: `chrome-extension://${PEER}/background.js`, tab: null } } }, { type: 'internal', data: { message: { ...message, action: 'spotlightNewTabReuseAck' }, sender: { id: PEER, url: state.url, frameId: 0, documentLifecycle: 'active', tab: null } } }];
    const context = { windowId: 7, spaceId: 'work', bookmarkFolderId: 'root-work', pairingGeneration: 'arcify-generation', sourceTabId: 77, tab: null };
    const request = { type: 'arcify-bridge', version: 1, requestId: 'committed-alias-folder', command: 'createSpaceFolder',
        windowId: 7, context, title: 'Alias folder', supportedFeatures: SPACE_ACTION_FEATURES };
    events.push({ type: 'internal', data: { message: { action: 'arcifySpaceAction', command: request.command,
        scope: { peerId: OWN, generation: 'spotlight-generation', context: clone(context) }, fields: { title: request.title }, tabId: 77 },
        sender: { id: PEER, url: state.url, frameId: 0, documentLifecycle: 'active', tab: null } } });
    return { state, events, options: { spotlightId: PEER, arcifyId: OWN, tabId: 77, windowId: 7, request } };
}
test('browser alias without sender.tab needs independently attested nonce acknowledgement from its exact renderer', () => {
    const s = helperProof(), proof = assertSpotlightHelperProof(s.state, s.events, s.options);
    assert.equal(proof.proofKind, 'nonce-challenge-ack'); assert.equal(proof.requestId, s.options.request.requestId); assert.equal(proof.nonces.length, 1);
});
test('omitted sender.tab also requires the complete nonce fallback', () => {
    const s = helperProof(); delete s.events[2].data.sender.tab;
    assert.equal(assertSpotlightHelperProof(s.state, s.events, s.options).proofKind, 'nonce-challenge-ack');
    s.events.splice(0, 2); assert.throws(() => assertSpotlightHelperProof(s.state, s.events, s.options));
});
for (const [name, mutate] of Object.entries({ noChallenge: s => s.events = [], noProbe: s => s.events.shift(), noAck: s => s.events.splice(1, 1), wrongAckNonce: s => s.events[1].data.message.nonce = 'other', wrongAckTab: s => s.events[1].data.message.tabId = 88, wrongAckWindow: s => s.events[1].data.message.windowId = 8, forgedSender: s => s.events[1].data.sender.id = OWN, otherRenderer: s => s.events[1].data.sender.url = `chrome-extension://${PEER}/options.html`, subframe: s => s.events[1].data.sender.frameId = 1, inactiveDocument: s => s.events[1].data.sender.documentLifecycle = 'cached', duplicateAck: s => s.events.push(clone(s.events[1])), pendingNavigation: s => s.state.tab.pendingUrl = 'http://other/', literalUrlOnly: s => s.state.tab.url = s.state.url, previousSource: s => s.state.tab.id = 88 })) test(`alias proof rejects ${name}`, () => { const s = helperProof(); mutate(s); assert.throws(() => assertSpotlightHelperProof(s.state, s.events, s.options)); });

function directHelperProof({ withChallenge = false } = {}) {
    const s = helperProof(); s.events[2].data.sender.tab = { id: 77, windowId: 7 };
    if (!withChallenge) s.events.splice(0, 2);
    return s;
}
function navigationHelperProof({ direct = true } = {}) {
    const s = direct ? directHelperProof() : helperProof();
    s.options.navigation = { destinations: [{ spaceId: 'personal', bookmarkFolderId: 'root-personal', name: 'Personal' }], inverted: true, sourceUrl: s.state.tab.url };
    s.events.at(-1).data.message.scope.navigation = clone(s.options.navigation);
    return s;
}
for (const direct of [true, false]) test(`extended helper retains exact committed action/source proof with authenticated navigation, direct ${direct}`, () => {
    const s = navigationHelperProof({ direct }), original = clone(s);
    assert.equal(assertSpotlightHelperProof(s.state, s.events, s.options).proofKind, direct ? 'browser-attested-sender-tab' : 'nonce-challenge-ack');
    assert.deepEqual(s, original);
});
for (const [name, mutate] of Object.entries({
    unnegotiated: s => delete s.options.navigation,
    absentScope: s => delete s.events.at(-1).data.message.scope.navigation,
    staleSource: s => s.events.at(-1).data.message.scope.navigation.sourceUrl = 'chrome://newtab',
    staleOrder: s => s.events.at(-1).data.message.scope.navigation.inverted = false,
    staleName: s => s.events.at(-1).data.message.scope.navigation.destinations[0].name = 'Other name',
    staleFolder: s => s.events.at(-1).data.message.scope.navigation.destinations[0].bookmarkFolderId = 'other',
    staleSpace: s => s.events.at(-1).data.message.scope.navigation.destinations[0].spaceId = 'other',
    wrongSender: s => s.events.at(-1).data.sender.id = OWN,
    wrongSource: s => s.events.at(-1).data.sender.tab.id = 78,
    extraScope: s => s.events.at(-1).data.message.scope.extra = true,
    duplicateAction: s => s.events.push(clone(s.events.at(-1)))
})) test(`extended helper proof rejects ${name}`, () => {
    const s = navigationHelperProof(); mutate(s); assert.throws(() => assertSpotlightHelperProof(s.state, s.events, s.options));
});
for (const [name, mutate] of Object.entries({
    extraNavigation: n => n.extra = true,
    wrongUrl: n => n.sourceUrl = 'https://unrelated.test/',
    malformedOrder: n => n.inverted = 'true',
    malformedList: n => n.destinations = null,
    extraDestination: n => n.destinations[0].extra = true,
    ownSpace: n => n.destinations[0].spaceId = 'work',
    ownFolder: n => n.destinations[0].bookmarkFolderId = 'root-work',
    missingId: n => n.destinations[0].spaceId = '',
    invalidName: n => n.destinations[0].name = 'Name\nControl',
    duplicateSpace: n => n.destinations.push({ ...n.destinations[0], bookmarkFolderId: 'root-other' }),
    duplicateFolder: n => n.destinations.push({ ...n.destinations[0], spaceId: 'other' })
})) test(`even matching scope/read cannot authorize malformed helper navigation: ${name}`, () => {
    const s = navigationHelperProof(); mutate(s.options.navigation); s.events.at(-1).data.message.scope.navigation = clone(s.options.navigation);
    assert.throws(() => assertSpotlightHelperProof(s.state, s.events, s.options));
});
for (const withChallenge of [false, true]) test(`browser alias accepts exact Chrome sender.tab bound to the committed folder action, challenge ${withChallenge}`, () => {
    const s = directHelperProof({ withChallenge }), original = clone(s);
    const proof = assertSpotlightHelperProof(s.state, s.events, s.options);
    assert.equal(proof.proofKind, 'browser-attested-sender-tab'); assert.equal(proof.requestId, s.options.request.requestId);
    assert.equal(proof.nonces.length, withChallenge ? 1 : 0); assert.deepEqual(s, original);
});
for (const [name, mutate] of Object.entries({
    wrongSender: s => s.events.at(-1).data.sender.id = OWN,
    wrongRenderer: s => s.events.at(-1).data.sender.url = `chrome-extension://${PEER}/options.html`,
    urlSuffix: s => s.events.at(-1).data.sender.url += '?other',
    subframe: s => s.events.at(-1).data.sender.frameId = 1,
    missingFrame: s => delete s.events.at(-1).data.sender.frameId,
    inactiveDocument: s => s.events.at(-1).data.sender.documentLifecycle = 'cached',
    missingLifecycle: s => delete s.events.at(-1).data.sender.documentLifecycle,
    wrongTab: s => s.events.at(-1).data.sender.tab.id = 88,
    wrongWindow: s => s.events.at(-1).data.sender.tab.windowId = 8,
    malformedTab: s => s.events.at(-1).data.sender.tab = false,
    absentTabAndNonce: s => s.events.at(-1).data.sender.tab = null,
    wrongMessageTab: s => s.events.at(-1).data.message.tabId = 88,
    wrongCommand: s => s.events.at(-1).data.message.command = 'openSettings',
    wrongContext: s => s.events.at(-1).data.message.scope.context.spaceId = 'other',
    wrongContextTab: s => s.events.at(-1).data.message.scope.context.sourceTabId = 88,
    wrongContextWindow: s => s.events.at(-1).data.message.scope.context.windowId = 8,
    wrongContextGeneration: s => s.events.at(-1).data.message.scope.context.pairingGeneration = 'stale',
    wrongPeer: s => s.events.at(-1).data.message.scope.peerId = PEER,
    malformedGeneration: s => s.events.at(-1).data.message.scope.generation = {},
    wrongFields: s => s.events.at(-1).data.message.fields.title = 'Unrelated folder',
    extraFields: s => s.events.at(-1).data.message.fields.extra = true,
    extraEnvelope: s => s.events.at(-1).data.message.extra = true,
    extraScope: s => s.events.at(-1).data.message.scope.extra = true,
    duplicateAction: s => s.events.push(clone(s.events.at(-1))),
    unrelatedAction: s => { const extra = clone(s.events.at(-1)); extra.data.message.command = 'openSettings'; s.events.push(extra); },
    onlyContextQuery: s => s.events.at(-1).data.message.action = 'arcifySpaceActionsContext',
    missingAction: s => s.events = [],
    missingCommittedRequest: s => delete s.options.request,
    differentCommittedTab: s => s.options.request.context.sourceTabId = 88,
    differentCommittedWindow: s => s.options.request.windowId = 8,
    borrowedPreviousTab: s => s.options.request.context.tab = { id: 77 }
})) test(`direct helper proof rejects ${name}`, () => {
    const s = directHelperProof(); mutate(s); assert.throws(() => assertSpotlightHelperProof(s.state, s.events, s.options));
});
for (const [name, mutate] of Object.entries({
    wrongDirectTab: s => s.events[2].data.sender.tab.id = 88,
    malformedDirectTab: s => s.events[2].data.sender.tab = false,
    wrongProbeTab: s => s.events[0].data.message.tabId = 88,
    wrongProbeWindow: s => s.events[0].data.message.windowId = 8,
    malformedNonce: s => s.events[0].data.message.nonce = 'bad',
    malformedNonceShape: s => { s.events[0].data.message.nonce = '-'.repeat(36); s.events[1].data.message.nonce = '-'.repeat(36); },
    missingAck: s => s.events.splice(1, 1),
    duplicateAck: s => s.events.push(clone(s.events[1])),
    duplicateProbe: s => s.events.push(clone(s.events[0])),
    extraUnmatchedAck: s => { const extra = clone(s.events[1]); extra.data.message.nonce = '00000000-0000-0000-0000-000000000002'; s.events.push(extra); }
})) test(`direct metadata cannot excuse invalid observed nonce proof: ${name}`, () => {
    const s = directHelperProof({ withChallenge: true }); mutate(s); assert.throws(() => assertSpotlightHelperProof(s.state, s.events, s.options));
});
test('hosted alias proof receives the actual committed request and records the observed proof route', async () => {
    const source = readFileSync(new globalThis.URL('../../scripts/paired-chrome-spotlight-actions.mjs', import.meta.url), 'utf8');
    const start = source.indexOf("            if (requestedUrl === 'chrome://newtab/') {");
    const end = source.indexOf('            await capture(helper.page,', start);
    assert(start > 0 && end > start);
    const s = directHelperProof(), records = [], created = { request: s.options.request };
    await new vm.Script(`(async () => { ${source.slice(start, end)} })()`).runInNewContext({
        requestedUrl: 'chrome://newtab/', spotlightId: PEER, arcifyId: OWN, windowId: 7, helper: { tab: { id: 77 } },
        helperBefore: s.state, helperAfter: s.state, created, navigationRead: undefined, rows: [], observed: async () => ({ peerEvents: s.events }),
        poll: async (read, predicate) => { const value = await read(); assert(predicate(value)); return value; },
        assertSpotlightHelperProof: (state, events, options) => { assert.equal(options.request, created.request); return assertSpotlightHelperProof(state, events, options); },
        checkpoint: async (phase, data) => records.push({ phase, ...data })
    });
    assert.equal(records.length, 1); assert.equal(records[0].phase, 'browser-alias-attested-renderer');
    assert.equal(records[0].proof.proofKind, 'browser-attested-sender-tab'); assert.deepEqual(records[0].trace.peerEvents, s.events);
    assert.deepEqual(records[0].helperBefore, s.state); assert.deepEqual(records[0].helperAfter, s.state);
    assert.match(source, /outcome = \{ resultId, before, after, trace, request \}/);
});

test('hosted extended alias read is exact, read-only, and occurs before the mutation', async () => {
    const source = readFileSync(new globalThis.URL('../../scripts/paired-chrome-spotlight-actions.mjs', import.meta.url), 'utf8');
    const start = source.indexOf('            let navigationRead;');
    const end = source.indexOf('            const created = await commit(', start);
    assert(start > 0 && end > start);
    const s = navigationHelperProof(), calls = [];
    const reply = { ok: true, extensionId: OWN, actionContext: s.options.request.context, navigationContext: s.options.navigation };
    const run = async ({ helperNavigation = true, requestedUrl = 'chrome://newtab/', response = reply } = {}) => {
        const script = new vm.Script(`(async () => { ${source.slice(start, end)} return navigationRead; })()`);
        return script.runInNewContext({ assert, helperNavigation, requestedUrl, spotlightOptions: 'peer-options', arcifyId: OWN,
            windowId: 7, helper: { tab: { id: 77 } }, helperContext: s.options.request.context, SPACE_ACTION_FEATURES,
            external: async (...args) => { calls.push(args); return response; }
        });
    };
    assert.equal(await run(), reply);
    assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['peer-options', OWN, 'navigationContext', { windowId: 7, tabId: 77, supportedFeatures: [...SPACE_ACTION_FEATURES, 'spaceNavigationV1'] }]]);
    for (const response of [{ ...reply, ok: false }, { ...reply, extensionId: PEER }, { ...reply, actionContext: { ...reply.actionContext, sourceTabId: 78 } }, { ...reply, navigationContext: null }]) await assert.rejects(run({ response }));
    calls.length = 0;
    assert.equal(await run({ helperNavigation: false }), undefined);
    assert.equal(await run({ requestedUrl: `chrome-extension://${PEER}/newtab.html` }), undefined);
    assert.deepEqual(calls, []);
});

test('Remove prompt spells out exact saved deletion, retained linked pages and safe initial focus', () => {
    const prompt = { role: 'dialog', modal: 'true', visible: true, command: 'removeCurrentPin', title: 'Remove saved Space pin?', description: 'Delete the saved bookmark “Exact pin”? Every live tab linked to this exact pin will stay open as Today. Other same-address pins are unchanged.', confirm: 'Remove saved pin', cancel: 'Cancel', cancelFocused: true, input: null };
    assertSpotlightActionPrompt(prompt, 'removeCurrentPin', 'Exact pin');
    for (const patch of [{ cancelFocused: false }, { description: 'Close tab?' }, { description: prompt.description.replace('Exact pin', 'Wrong pin') }, { modal: 'false' }]) assert.throws(() => assertSpotlightActionPrompt({ ...prompt, ...patch }, 'removeCurrentPin', 'Exact pin'));
});
test('settings opens once in source window and preserves counterpart, source and saved state', () => {
    const s = sample(), before = s.before, after = clone(before); after.tabs[0].active = false; after.tabs.push({ ...before.tabs[0], id: 999, index: 5, url: `chrome-extension://${OWN}/options.html`, active: true });
    const options = { context: s.options.context, arcifyId: OWN, events: [{ type: 'tabs.onCreated', data: [after.tabs.at(-1)] }] };
    assertSpotlightSettingsOpened(before, after, options);
    for (const mutation of [state => state.tabs.at(-1).windowId = 8, state => state.tabs.shift(), state => state.tabs[3].active = false, state => state.bookmarks[0].title = 'changed', state => state.windows[1].focused = true]) { const bad = clone(after); mutation(bad); assert.throws(() => assertSpotlightSettingsOpened(before, bad, options)); }
});


test('overlay Settings completion observes source retirement instead of waiting in the detached input frame', async () => {
    const { document } = parseHTML('<html><body><div id="arcify-spotlight-host"><iframe></iframe></div><input id="source-draft" value="kept"></body></html>');
    const calls = [], host = document.getElementById('arcify-spotlight-host'), draft = document.getElementById('source-draft');
    const page = { waitForFunction: async (predicate, options) => {
        calls.push('source-retired'); assert.deepEqual(options, { polling: 50 });
        assert.equal(vm.runInNewContext(`(${predicate})()`, { document }), true);
    } };
    host.remove();
    await waitForSpotlightActionCompletion({ page, surface: {}, command: 'openSettings',
        waitStatus: () => { throw new Error('waitForFunction failed: frame got detached.'); },
        waitSettings: async () => calls.push('exact-new-settings') });
    assert.deepEqual(calls, ['exact-new-settings', 'source-retired']);
    assert.equal(document.getElementById('source-draft'), draft); assert.equal(draft.value, 'kept');
});

test('trusted input observation survives frame removal as plain evidence in the original source document', () => {
    const parent = {}, listeners = {};
    const { document } = parseHTML('<html><body><button data-testid="spotlight-result" class="selected" data-result-type="arcify-space-action"><span class="arcify-spotlight-result-title">Open Arcify settings</span></button></body></html>');
    document.addEventListener = (type, listener) => { listeners[type] = listener; };
    document.removeEventListener = () => {};
    const realm = vm.createContext({ document, parent });
    vm.runInContext(`(${installSpotlightActionInputObservation})({ retainInParent: true })`, realm);
    const row = document.querySelector('button');
    listeners.click({ target: row, type: 'click', isTrusted: true });
    // Discard the frame/observer realm, then inspect only the host's retained array.
    row.remove();
    const events = JSON.parse(JSON.stringify(parent.__spaceActionInputEvents));
    assertSpotlightActionInput(events, 'openSettings');
    assert.deepEqual(Object.keys(parent), ['__spaceActionInputEvents']);
    assert.equal(events.length, 1); assert.equal(events[0].trusted, true);
    listeners.click({ target: row, type: 'click', isTrusted: false });
    assert.equal(parent.__spaceActionInputEvents[1].trusted, false);
    assert.throws(() => assertSpotlightActionInput(parent.__spaceActionInputEvents, 'openSettings'));
});


for (const command of Object.keys(SPACE_ACTION_TITLES)) test(`${command} keeps its normal live-surface status requirement`, async () => {
    const page = {}, calls = [];
    await waitForSpotlightActionCompletion({ page, surface: command === 'openSettings' ? page : {}, command,
        waitStatus: async (_surface, expected) => { calls.push('status'); assert(expected.includes(command === 'openSettings' ? 'settings opened' : command === 'createSpaceFolder' ? 'Folder created' : command === 'removeCurrentPin' ? 'Saved pin removed' : 'Current tab saved')); },
        waitSettings: async () => calls.push('settings') });
    assert.deepEqual(calls, command === 'openSettings' ? ['status', 'settings'] : ['status']);
});

test('settings completion never masks an uncertain native outcome or an unretired overlay', async () => {
    for (const failedStage of ['settings', 'source']) {
        const calls = [], failure = new Error(`failed ${failedStage}`);
        await assert.rejects(waitForSpotlightActionCompletion({
            page: { waitForFunction: async () => { calls.push('source'); if (failedStage === 'source') throw failure; } }, surface: {}, command: 'openSettings',
            waitSettings: async () => { calls.push('settings'); if (failedStage === 'settings') throw failure; },
            waitStatus: () => { throw new Error('Detached frame must not be touched'); }
        }), error => error === failure);
        assert.deepEqual(calls, failedStage === 'settings' ? ['settings'] : ['settings', 'source']);
    }
});

function settingsObservation() {
    const { before, options } = sample(), after = clone(before);
    after.tabs[0].active = false;
    after.tabs.push({ ...before.tabs[0], id: 999, index: 5, url: `chrome-extension://${OWN}/options.html`, active: true });
    const request = { type: 'arcify-bridge', version: 1, requestId: 'settings-evidence-test', command: 'openSettings',
        windowId: 7, supportedFeatures: SPACE_ACTION_FEATURES, context: options.context };
    after.journal.push({ fingerprint: JSON.stringify(request), response: { ok: true, tabId: 999 } });
    const trace = { events: [
        { type: 'tabs.onCreated', data: [clone(after.tabs.at(-1))] },
        { type: 'external', data: { message: request, sender: { id: PEER } } }
    ], peerEvents: [], input: input('openSettings') };
    return { before, after, trace, context: options.context };
}

function validateSettings(evidence, platform) {
    return assertSpotlightSettingsOpened(evidence.before, evidence.after, {
        context: evidence.context, arcifyId: OWN, events: evidence.trace.events, platform
    });
}
const noWindowFocus = () => ({ type: 'windows.onFocusChanged', data: [-1] });

for (const platform of ['linux', 'darwin', 'win32', 'freebsd', null, 'Linux', '']) {
    test(`Settings without focus events keeps exact source focus on ${platform}`, () => {
        assert.equal(validateSettings(settingsObservation(), platform).id, 999);
    });
    test(`Settings permits one exact WINDOW_ID_NONE only on Linux, platform ${platform}`, () => {
        const evidence = settingsObservation(); evidence.trace.events.unshift(noWindowFocus());
        const original = clone(evidence);
        if (platform === 'linux') assert.equal(validateSettings(evidence, platform).id, 999);
        else assert.throws(() => validateSettings(evidence, platform), /forbidden native events/);
        assert.deepEqual(evidence, original, 'Never discard the raw focus notification from evidence.');
    });
}
test('Settings platform defaults to the actual hosted Node platform', () => {
    const evidence = settingsObservation(); evidence.trace.events.unshift(noWindowFocus());
    if (process.platform === 'linux') assert.equal(validateSettings(evidence).id, 999);
    else assert.throws(() => validateSettings(evidence), /forbidden native events/);
});

for (const [name, events] of Object.entries({
    duplicateSentinel: [noWindowFocus(), noWindowFocus()],
    sourceWindow: [{ type: 'windows.onFocusChanged', data: [7] }],
    otherWindow: [{ type: 'windows.onFocusChanged', data: [8] }],
    sentinelThenSource: [noWindowFocus(), { type: 'windows.onFocusChanged', data: [7] }],
    sentinelThenOther: [noWindowFocus(), { type: 'windows.onFocusChanged', data: [8] }],
    missingData: [{ type: 'windows.onFocusChanged' }],
    ...Object.fromEntries([null, -1, '-1', { 0: -1, length: 1 }, [], ['-1'], [-2], [0], [null], [-1, 7], [-1, -1],
        Object.assign([-1], { extra: true })].map((data, index) => [`malformed${index}`, [{ type: 'windows.onFocusChanged', data }]]))
})) test(`Linux Settings rejects focus boundary ${name}`, () => {
    const evidence = settingsObservation(); evidence.trace.events.unshift(...clone(events));
    assert.throws(() => validateSettings(evidence, 'linux'), /forbidden native events/);
});

for (const sentinel of [false, true]) for (const endpoint of ['before', 'after', 'both']) for (const [name, mutate] of Object.entries({
    noFocusedWindow: windows => { windows[0].focused = false; },
    otherFocusedWindow: windows => { windows[0].focused = false; windows[1].focused = true; },
    bothFocusedWindows: windows => { windows[1].focused = true; },
    sourceMissing: windows => { windows.shift(); },
    duplicateSource: windows => { windows.push(clone(windows[0])); },
    malformedSourceFocus: windows => { windows[0].focused = 'true'; },
    malformedOtherFocus: windows => { windows[1].focused = 0; }
})) test(`Settings requires sole source focus at ${endpoint}: ${name}, sentinel ${sentinel}`, () => {
    const evidence = settingsObservation(); if (sentinel) evidence.trace.events.unshift(noWindowFocus());
    for (const key of endpoint === 'both' ? ['before', 'after'] : [endpoint]) mutate(evidence[key].windows);
    assert.throws(() => validateSettings(evidence, 'linux'));
});

for (const type of ['tabs.onRemoved', 'tabs.onReplaced', 'tabs.onAttached', 'tabs.onDetached', 'tabs.onMoved',
    'windows.onCreated', 'windows.onRemoved', 'windows.onBoundsChanged', 'bookmarks.onCreated', 'bookmarks.onRemoved',
    'bookmarks.onChanged', 'bookmarks.onMoved', 'sidePanel.onOpened']) test(`Linux Settings sentinel never excuses ${type}`, () => {
    const evidence = settingsObservation(), forbidden = { type, data: [77] };
    evidence.trace.events.unshift(noWindowFocus(), forbidden);
    assert.throws(() => validateSettings(evidence, 'linux'), error => error.message.includes(JSON.stringify([forbidden])));
});

for (const command of ['pinCurrentTab', 'removeCurrentPin', 'createSpaceFolder']) test(`${command} still rejects the exact Linux focus sentinel`, () => {
    const { before, after, options } = sample(command); options.events.unshift(noWindowFocus());
    assert.throws(() => assertSpotlightActionCommitted(before, after, options), /never mutate native pages/);
});
test('cancelled and rejected actions still reject the exact Linux focus sentinel', () => {
    for (const allowRejectedRequests of [false, true]) assert.throws(() => assertSpotlightActionNoWrites([noWindowFocus()], { allowRejectedRequests }), /window focus/);
});

for (const stage of ['request', 'input', 'native']) test(`failed ${stage} validation preserves complete raw action evidence before any success claim`, async () => {
    const source = readFileSync(new globalThis.URL('../../scripts/paired-chrome-spotlight-actions.mjs', import.meta.url), 'utf8');
    const start = source.indexOf('            const trace = await observed(surface, inputOwner)');
    const end = source.indexOf("            await checkpoint('action-committed-once'", start);
    assert(start > 0 && end > start);
    const evidence = settingsObservation(), records = [], owned = [], roots = [];
    if (stage === 'request') evidence.trace.events[1].data.sender.id = 'wrong';
    if (stage === 'input') evidence.trace.input[0].trusted = false;
    if (stage === 'native') evidence.trace.events.push({ type: 'windows.onFocusChanged', data: [77] });
    const run = new vm.Script(`(async () => { ${source.slice(start, end)} })()`).runInNewContext({
        ...evidence, sourceContext: evidence.context, command: 'openSettings', surface: {}, inputOwner: {}, rows: [], prompt: undefined, title: undefined,
        spotlightId: PEER, arcifyId: OWN, owned, roots, assert,
        observed: async () => clone(evidence.trace), checkpoint: async (phase, data) => records.push({ phase, ...clone(data) }),
        assertSpotlightActionRequest, assertSpotlightActionInput, assertSpotlightSettingsOpened, assertSpotlightActionCommitted
    });
    await assert.rejects(run);
    assert.equal(records.length, 1);
    assert.equal(records[0].phase, 'action-observed-before-validation');
    for (const key of ['before', 'after', 'trace']) assert.deepEqual(records[0][key], evidence[key]);
    assert.deepEqual(records[0].sourceContext, evidence.context);
    assert.equal(records[0].command, 'openSettings');
    assert.deepEqual(owned, []); assert.deepEqual(roots, []);
});

test('Settings failure reports every forbidden native event payload without accepting any of them', () => {
    for (const type of ['tabs.onRemoved', 'tabs.onReplaced', 'tabs.onAttached', 'tabs.onDetached', 'tabs.onMoved',
        'windows.onCreated', 'windows.onRemoved', 'windows.onFocusChanged', 'bookmarks.onCreated', 'sidePanel.onOpened']) {
        const evidence = settingsObservation(), forbidden = { type, data: [77, { detail: 'exact offending payload' }] };
        evidence.trace.events.push(forbidden);
        assert.throws(() => assertSpotlightSettingsOpened(evidence.before, evidence.after, { context: evidence.context, arcifyId: OWN, events: evidence.trace.events }),
            error => error.message.includes(JSON.stringify([forbidden])));
    }
});


test('helper action oracle retains the exact legacy set and allows only the explicit extended Switch row', () => {
    const row = title => ({ type: 'arcify-space-action', title });
    const legacy = [row(SPACE_ACTION_TITLES.createSpaceFolder), row(SPACE_ACTION_TITLES.openSettings)];
    const extended = [...legacy, row('Switch Space')];
    assert.doesNotThrow(() => assertSpotlightHelperActionRows(legacy));
    assert.doesNotThrow(() => assertSpotlightHelperActionRows(extended, { helperNavigation: true }));
    assert.throws(() => assertSpotlightHelperActionRows(extended));
    assert.throws(() => assertSpotlightHelperActionRows(legacy, { helperNavigation: true }));
    for (const helperNavigation of [false, true]) {
        const expected = helperNavigation ? extended : legacy;
        for (const extra of ['Move current tab to another Space', SPACE_ACTION_TITLES.pinCurrentTab, SPACE_ACTION_TITLES.removeCurrentPin, 'Unexpected']) {
            assert.throws(() => assertSpotlightHelperActionRows([...expected, row(extra)], { helperNavigation }));
        }
        assert.throws(() => assertSpotlightHelperActionRows([...expected, expected[0]], { helperNavigation }));
        assert.throws(() => assertSpotlightHelperActionRows(expected.slice(1), { helperNavigation }));
        assert.throws(() => assertSpotlightHelperActionRows([...expected, { type: 'arcify-tab-action', title: 'Copy current link' }], { helperNavigation }));
    }
    for (const helperNavigation of [null, 'true', 1, []]) assert.throws(() => assertSpotlightHelperActionRows(extended, { helperNavigation }));
});

function sampleWithTodayWitnesses(command = 'pinCurrentTab') {
    const s = sample(command);
    const witness = id => ({ version: 1, epoch: { kind: 'session', epoch: 'current-epoch' },
        incarnation: `incarnation-${id}`, transaction: `transaction-${id}`, windowId: 7,
        spaceId: 'work', bookmarkFolderId: 'root-work' });
    for (const state of [s.before, s.after]) {
        state.tabs.push({ ...clone(state.tabs[0]), id: 103, index: 10, active: false });
        state.spaces[0].temporaryTabs.push(103);
        state.pageStates[103] = { ...clone(state.pageStates[101]), documentId: 'doc-103' };
        project(state);
        for (const id of [101, 103]) state.savedSnapshot.find(record => record.tabId === id).currentOwnership = witness(id);
        // Same-URL historical evidence is unrelated to the exact live pin target.
        state.savedSnapshot.push({ ...clone(state.savedSnapshot.find(record => record.tabId === 103)),
            tabId: 999, order: 7, windowKey: 'historical-window', currentOwnership: witness(999) });
    }
    if (command === 'pinCurrentTab') delete s.after.savedSnapshot.find(record => record.tabId === 101).currentOwnership;
    return s;
}

test('pin proof retires only the exact target Today witness and retains unrelated current and historical witnesses', () => {
    const s = sampleWithTodayWitnesses();
    assertSpotlightActionCommitted(s.before, s.after, s.options);
});
for (const [name, mutate] of Object.entries({
    retainedTarget: s => s.after.savedSnapshot.find(r => r.tabId === 101).currentOwnership = clone(s.before.savedSnapshot.find(r => r.tabId === 101).currentOwnership),
    lostUnrelatedCurrent: s => delete s.after.savedSnapshot.find(r => r.tabId === 103).currentOwnership,
    changedUnrelatedCurrent: s => s.after.savedSnapshot.find(r => r.tabId === 103).currentOwnership.transaction = 'changed',
    lostHistorical: s => delete s.after.savedSnapshot.find(r => r.tabId === 999).currentOwnership,
    changedHistorical: s => s.after.savedSnapshot.find(r => r.tabId === 999).currentOwnership.incarnation = 'changed',
})) test(`pin witness proof rejects ${name}`, () => {
    const s = sampleWithTodayWitnesses(); mutate(s);
    assert.throws(() => assertSpotlightActionCommitted(s.before, s.after, s.options));
});
test('folder creation keeps even the current source Today witness unchanged', () => {
    const s = sampleWithTodayWitnesses('createSpaceFolder');
    assertSpotlightActionCommitted(s.before, s.after, s.options);
    delete s.after.savedSnapshot.find(r => r.tabId === 101).currentOwnership;
    assert.throws(() => assertSpotlightActionCommitted(s.before, s.after, s.options));
});
