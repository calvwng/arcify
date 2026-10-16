import test from 'node:test';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertSpotlightActionEnvironment, serveSpotlightActionFixture, assertSpotlightActionContext, assertSpotlightActionUnchanged,
    assertSpotlightActionNoWrites, assertSpotlightActionInput, assertSpotlightActionRequest, assertSpotlightHelperProof, assertSpotlightActionCommitted,
    assertSpotlightSettingsOpened, assertSpotlightActionPrompt, installSpotlightActionInputObservation, waitForSpotlightActionCompletion, SPACE_ACTION_TITLES, SPACE_ACTION_FEATURES } from '../../scripts/paired-chrome-spotlight-actions.mjs';
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
    return { state, events, options: { spotlightId: PEER, tabId: 77, windowId: 7 } };
}
test('browser alias needs independently attested nonce acknowledgement from its exact renderer', () => { const s = helperProof(); assertSpotlightHelperProof(s.state, s.events, s.options); });
for (const [name, mutate] of Object.entries({ noChallenge: s => s.events = [], noAck: s => s.events.pop(), wrongAckNonce: s => s.events[1].data.message.nonce = 'other', wrongAckTab: s => s.events[1].data.message.tabId = 88, wrongAckWindow: s => s.events[1].data.message.windowId = 8, forgedSender: s => s.events[1].data.sender.id = OWN, otherRenderer: s => s.events[1].data.sender.url = `chrome-extension://${PEER}/options.html`, subframe: s => s.events[1].data.sender.frameId = 1, inactiveDocument: s => s.events[1].data.sender.documentLifecycle = 'cached', duplicateAck: s => s.events.push(clone(s.events[1])), pendingNavigation: s => s.state.tab.pendingUrl = 'http://other/', literalUrlOnly: s => s.state.tab.url = s.state.url, previousSource: s => s.state.tab.id = 88 })) test(`alias proof rejects ${name}`, () => { const s = helperProof(); mutate(s); assert.throws(() => assertSpotlightHelperProof(s.state, s.events, s.options)); });

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
