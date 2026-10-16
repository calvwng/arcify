import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    NAVIGATION_FEATURES, NAVIGATION_TITLES, serveSpotlightNavigationFixture,
    assertNavigationContext, assertNavigationPicker, assertNavigationInput,
    assertNavigationNoMutation, assertNavigationRequest, assertNavigationSnapshot,
    assertNavigationCommitted, createNavigationFixturePage
} from '../../scripts/paired-chrome-spotlight-navigation.mjs';

const PEER = 'b'.repeat(32), URL = 'http://127.0.0.1/exact-same-url';
const clone = structuredClone;
const folder = (id, parentId, index, title, children = []) => ({ id, parentId, index, title, dateAdded: 10, children });
const owner = (state, id) => state.spaces.find(space => [...space.spaceBookmarks, ...space.temporaryTabs].includes(id));
const byId = (state, id) => state.tabs.find(tab => tab.id === id);
function project(state) {
    state.snapshots = Object.fromEntries([7, 8].map(windowId => {
        const local = ids => ids.filter(id => byId(state, id)?.windowId === windowId);
        return [windowId, { windowId, capturedAt: 123, activeSpaceId: state.activeSpaces[windowId],
            spaces: state.spaces.map(space => ({ id: space.id, name: space.name, color: space.color, bookmarkFolderId: space.bookmarkFolderId,
                tabIds: local([...space.spaceBookmarks, ...space.temporaryTabs]), pinnedTabIds: local(space.spaceBookmarks), temporaryTabIds: local(space.temporaryTabs) })),
            tabs: state.tabs.filter(tab => tab.windowId === windowId).map(tab => ({ id: tab.id, windowId, title: tab.title, url: tab.url,
                active: tab.active, pinned: tab.pinned, spaceId: owner(state, tab.id)?.id || null })), bookmarks: [], warnings: [], favorites: [] }];
    }));
    return state;
}
function state(inverted = false) {
    const specs = [[101, 7, true], [102, 7, false], [103, 7, false], [104, 7, false], [201, 8, true], [202, 8, false], [203, 8, false]];
    const tabs = specs.map(([id, windowId, active], index) => ({ id, windowId, active, index, url: URL, pendingUrl: null,
        title: `Native ${id}`, pinned: false, incognito: false, groupId: windowId === 7 ? 11 : 12, splitViewId: -1 }));
    const spaces = [
        { id: 'work', name: 'Work', color: 'blue', bookmarkFolderId: 'root-work', spaceBookmarks: [], temporaryTabs: [101, 102, 201], lastTab: 101 },
        { id: 'target', name: 'Same name', color: 'red', bookmarkFolderId: 'root-target', spaceBookmarks: [], temporaryTabs: [103, 104, 202], lastTab: 103 },
        { id: 'empty', name: 'Empty', color: 'grey', bookmarkFolderId: 'root-empty', spaceBookmarks: [], temporaryTabs: [] },
        { id: 'remote', name: 'Same name', color: 'green', bookmarkFolderId: 'root-remote', spaceBookmarks: [], temporaryTabs: [203], lastTab: 203 }
    ];
    return project({ tabs, spaces, activeSpaces: { 7: 'work', 8: 'work' }, representation: { version: 1, inverted },
        windows: [{ id: 7, type: 'normal', focused: true }, { id: 8, type: 'normal', focused: false }],
        groups: [{ id: 11, windowId: 7, collapsed: false }, { id: 12, windowId: 8, collapsed: false }], projection: { 'work:7': 11, 'work:8': 12 },
        bookmarks: [folder('arcify', '0', 0, 'Arcify', spaces.map((space, i) => folder(space.bookmarkFolderId, 'arcify', i, space.name)))],
        bindings: {}, aliases: {}, favorites: [], favoriteSession: { bindings: [] }, pairingGeneration: 'pair-1', journal: [],
        savedSnapshot: spaces.flatMap(space => space.temporaryTabs.map((tabId, order) => ({ tabId, spaceId: space.id, section: 'temporaryTabs',
            order, url: URL, windowKey: `window-${tabs.find(tab => tab.id === tabId).windowId}`, tabIndex: tabs.find(tab => tab.id === tabId).index }))),
        pageStates: Object.fromEntries(tabs.map(tab => [tab.id, { url: URL, documentId: `doc-${tab.id}`, timeOrigin: tab.id, value: `typed-${tab.id}` }])) });
}
function capture(before, section = 'today') {
    return { context: { windowId: 7, sourceTabId: 101, spaceId: 'work', bookmarkFolderId: 'root-work', pairingGeneration: 'pair-1',
        tab: section === null ? null : { id: 101, title: byId(before, 101).title, url: byId(before, 101).url, section, bookmark: null } },
        navigation: { inverted: before.representation.inverted, sourceUrl: byId(before, 101).url,
            destinations: before.spaces.filter(space => space.id !== 'work').map(space => ({ spaceId: space.id, bookmarkFolderId: space.bookmarkFolderId, name: space.name })) } };
}
const contextReply = captured => ({ ok: true, actionContext: captured.context, navigationContext: captured.navigation });
const target = (before, id) => { const space = before.spaces.find(space => space.id === id); return { spaceId: id, bookmarkFolderId: space.bookmarkFolderId }; };
function request(command, captured, destination) {
    return { type: 'arcify-bridge', version: 1, requestId: 'genuine-picker-1', command, windowId: 7, supportedFeatures: [...NAVIGATION_FEATURES],
        context: clone(captured.context), sourceUrl: captured.navigation.sourceUrl, destination: clone(destination),
        ...(command === 'moveCurrentTodayTab' ? { inverted: captured.navigation.inverted } : {}) };
}
function sample(command = 'moveCurrentTodayTab', { inverted = false, destinationId = 'target', fallback = false, helper = false } = {}) {
    const before = state(inverted);
    if (fallback) before.spaces.find(space => space.id === destinationId).lastTab = 999;
    if (helper) { byId(before, 101).url = `chrome-extension://${PEER}/newtab.html`; before.pageStates[101].url = byId(before, 101).url; before.savedSnapshot.find(item => item.tabId === 101).url = byId(before, 101).url; project(before); }
    const captured = capture(before, helper ? null : 'today'), destination = target(before, destinationId), message = request(command, captured, destination);
    const after = clone(before), source = after.spaces.find(space => space.id === 'work'), dest = after.spaces.find(space => space.id === destinationId);
    let resultId = 101;
    const events = [{ type: 'external', data: { sender: { id: PEER }, message } }];
    if (command === 'moveCurrentTodayTab') {
        source.temporaryTabs = source.temporaryTabs.filter(id => id !== 101); delete source.lastTab;
        dest.temporaryTabs = inverted ? [101, ...dest.temporaryTabs] : [...dest.temporaryTabs, 101];
        for (const record of after.savedSnapshot) if (['work', destinationId].includes(record.spaceId) && record.section === 'temporaryTabs') {
            if (record.tabId === 101) record.spaceId = destinationId;
            record.order = after.spaces.find(space => space.id === record.spaceId).temporaryTabs.indexOf(record.tabId);
        }
    } else {
        after.activeSpaces[7] = destinationId;
        const ids = [...dest.spaceBookmarks, ...dest.temporaryTabs].filter(id => byId(before, id).windowId === 7);
        resultId = ids.includes(dest.lastTab) ? dest.lastTab : ids.at(-1) ?? null;
        if (resultId !== null) {
            for (const tab of after.tabs) if (tab.windowId === 7) tab.active = tab.id === resultId;
            dest.lastTab = resultId;
            events.push({ type: 'tabs.onActivated', data: [{ tabId: resultId, windowId: 7 }] });
        }
    }
    after.journal.push({ fingerprint: JSON.stringify(message), response: { ok: true, spaceId: destinationId, tabId: resultId } });
    project(after);
    return { before, after, options: { command, captured, destination, request: message, events } };
}
const verify = sample => assertNavigationCommitted(sample.before, sample.after, sample.options);
function picker(captured, command, selectedIndex = null) {
    return { role: 'dialog', modal: 'true', visible: true, command, cancel: 'Cancel',
        title: command === 'switchSpace' ? 'Switch Space' : 'Move current Today tab',
        confirm: command === 'switchSpace' ? 'Switch Space' : 'Move tab',
        description: command === 'switchSpace' ? 'Focus the last open tab; an empty Space keeps this tab.' : 'This exact tab goes to the visible bottom; selected Space and focus stay.',
        value: selectedIndex === null ? '' : String(selectedIndex), focused: selectedIndex === null, error: '',
        options: [{ value: '', text: 'Choose a Space…', disabled: true, selected: selectedIndex === null },
            ...captured.navigation.destinations.map((space, i) => ({ value: String(i), disabled: false, selected: i === selectedIndex,
                text: captured.navigation.destinations.filter(other => other.name === space.name).length > 1 ? `${space.name} (${space.spaceId})` : space.name || space.spaceId }))] };
}
const event = patch => ({ type: 'click', trusted: true, button: 0, repeat: false, composing: false, ctrl: false, alt: false, meta: false, shift: false, keyCode: 0, inPrompt: true, destination: false, cancel: false, confirm: null, ...patch });
function input(command, { outcome = 'commit', activation = 'click', submission = 'click', destinationIndex = 0 } = {}) {
    const events = [event({ inPrompt: false, type: activation === 'Enter' ? 'keydown' : 'click', key: activation === 'Enter' ? 'Enter' : null,
        title: NAVIGATION_TITLES[command], resultType: 'arcify-space-action' })];
    if (outcome === 'commit') events.push(event({ type: 'keydown', key: 'ArrowDown', destination: true, value: '' }), event({ type: 'change', destination: true, value: String(destinationIndex) }));
    if (outcome === 'cancel') events.push(event({ type: 'keydown', key: 'Escape', destination: true, value: '' }));
    else events.push(event({ type: submission === 'Enter' ? 'keydown' : 'click', key: submission === 'Enter' ? 'Enter' : null,
        confirm: submission === 'Enter' ? null : command, destination: submission === 'Enter', value: outcome === 'commit' ? String(destinationIndex) : '' }));
    return events;
}

test('navigation module is import-safe and never starts a browser or calls a renderer controller', () => {
    const source = readFileSync(new globalThis.URL('../../scripts/paired-chrome-spotlight-navigation.mjs', import.meta.url), 'utf8');
    assert(!/from ['"].*(?:paired-chrome-smoke|paired-chrome-runtime|child_process)/.test(source));
    assert(!/\.launch\(|--no-sandbox|disable-setuid-sandbox|execFile|spawn\(/.test(source));
    assert(!/spaceActions\.(?:invoke|perform)|dispatchEvent\(|\.select\(/.test(source));
});
test('fixture route requires exact nonce/path and retains independently identifiable page state', () => {
    let headers, body;
    const response = { writeHead(code, value) { assert.equal(code, 200); headers = value; }, end(value) { body = value; } };
    assert.equal(serveSpotlightNavigationFixture({ url: '/spotlight-navigation/bad/source' }, response), false);
    assert.equal(serveSpotlightNavigationFixture({ url: `/spotlight-navigation/${'a'.repeat(32)}/source` }, response), true);
    assert.equal(headers['Cache-Control'], 'no-store'); assert.match(headers['Content-Security-Policy'], /frame-src 'none'/);
    assert.match(body, /data-document-id="[a-f0-9]{32}"/); assert.match(body, /id="action-page-state"/);
});
for (const section of ['today', null]) test(`exact ${section || 'helper'} context binds active tab, source URL and canonical destination identities`, () => {
    const before = state(), captured = capture(before, section);
    assertNavigationContext(contextReply(captured), before, { windowId: 7, sourceTabId: 101, section });
});
for (const [name, mutate] of Object.entries({
    wrongSource: c => c.context.sourceTabId = 102, wrongWindow: c => c.context.windowId = 8, wrongFolder: c => c.context.bookmarkFolderId = 'root-target',
    oldGeneration: c => c.context.pairingGeneration = 'old', changedURL: c => c.navigation.sourceUrl = 'http://wrong/', wrongInversion: c => c.navigation.inverted = true,
    sourceDestination: c => c.navigation.destinations.unshift({ spaceId: 'work', bookmarkFolderId: 'root-work', name: 'Work' }),
    wrongDestinationFolder: c => c.navigation.destinations[0].bookmarkFolderId = 'wrong', duplicateDestination: c => c.navigation.destinations.push(clone(c.navigation.destinations[0])),
    reorderedDestinations: c => c.navigation.destinations.reverse(), guessedName: c => c.navigation.destinations[0].name = 'Guess', extraNavigationField: c => c.navigation.guess = true
})) test(`context proof rejects ${name}`, () => { const before = state(), captured = capture(before); mutate(captured); assert.throws(() => assertNavigationContext(contextReply(captured), before, { windowId: 7, sourceTabId: 101, section: 'today' })); });
test('context rejects inactive source and any helper previous-tab guess', () => {
    const before = state(), captured = capture(before); byId(before, 101).active = false;
    assert.throws(() => assertNavigationContext(contextReply(captured), before, { windowId: 7, sourceTabId: 101, section: 'today' }));
    byId(before, 101).active = true;
    assert.throws(() => assertNavigationContext(contextReply(captured), before, { windowId: 7, sourceTabId: 101, section: null }));
});
for (const command of Object.keys(NAVIGATION_TITLES)) for (const index of [null, 0, 1, 2]) test(`${command} picker proves placeholder and exact duplicate-name choice ${index}`, () => {
    const captured = capture(state()); assertNavigationPicker(picker(captured, command, index), command, captured.navigation, index);
});
for (const [name, mutate] of Object.entries({ preselected: p => p.value = '0', unfocused: p => p.focused = false, missingOption: p => p.options.pop(),
    guessedLabel: p => p.options[1].text = 'Same name', wrongIndex: p => p.options[1].value = 'wrong', extraOption: p => p.options.push({ value: '3', text: 'New Space' }),
    duplicateSelected: p => p.options[1].selected = true, hidden: p => p.visible = false, unmodal: p => p.modal = 'false', enabledPlaceholder: p => p.options[0].disabled = false
})) test(`picker rejects ${name}`, () => { const captured = capture(state()), value = picker(captured, 'switchSpace'); mutate(value); assert.throws(() => assertNavigationPicker(value, 'switchSpace', captured.navigation)); });
for (const command of Object.keys(NAVIGATION_TITLES)) for (const activation of ['Enter', 'click']) for (const submission of ['Enter', 'click']) test(`${command} accepts genuine ${activation}/${submission} and exact change`, () => {
    const options = { outcome: 'commit', destinationIndex: 1, activation, submission }; assertNavigationInput(input(command, options), command, options);
});
for (const outcome of ['cancel', 'no-choice']) test(`input supports separate ${outcome} evidence without mutation`, () => {
    const options = { outcome, activation: 'Enter', submission: 'Enter' }; assertNavigationInput(input('switchSpace', options), 'switchSpace', options);
});
for (const [name, mutate] of Object.entries({ synthetic: e => e[0].trusted = false, repeat: e => e.at(-1).repeat = true, composing: e => e.at(-1).composing = true,
    control: e => e.at(-1).ctrl = true, alt: e => e.at(-1).alt = true, meta: e => e.at(-1).meta = true, secondaryClick: e => e.at(-1).button = 2,
    noChange: e => e.splice(2, 1), wrongChange: e => e[2].value = '1', duplicateInvoke: e => e.push(clone(e[0])), duplicateSubmit: e => e.push(clone(e.at(-1))), missingSubmit: e => e.pop()
})) test(`input rejects ${name}`, () => { const options = { outcome: 'commit', destinationIndex: 0 }, events = input('switchSpace', options); mutate(events); assert.throws(() => assertNavigationInput(events, 'switchSpace', options)); });
for (const command of ['switchSpace', 'moveCurrentTodayTab', 'assign', 'activateSpace', 'activateTab', 'navigateTab', 'openBookmark', 'pinCurrentTab']) test(`cancellation rejects ${command} transport`, () => assert.throws(() => assertNavigationNoMutation([{ type: 'external', data: { message: { command } } }])));
for (const value of [{ type: 'tabs.onMoved', data: [101, {}] }, { type: 'bookmarks.onCreated', data: ['id'] }, { type: 'windows.onFocusChanged', data: [8] },
    { type: 'storage', data: { area: 'sync', changes: { invertTabOrder: { oldValue: false, newValue: true } } } }]) test(`no-mutation evidence rejects ${value.type}`, () => assert.throws(() => assertNavigationNoMutation([value])));
for (const command of Object.keys(NAVIGATION_TITLES)) test(`${command} request requires one peer-authenticated new-capability exact payload`, () => {
    const s = sample(command); assertNavigationRequest(s.options.events, command, s.options.captured, s.options.destination, PEER);
});
for (const [name, mutate] of Object.entries({ duplicate: e => e.push(clone(e[0])), fallback: e => e.push({ type: 'external', data: { message: { command: 'assign' } } }),
    oldFeature: e => e[0].data.message.supportedFeatures.pop(), forgedPeer: e => e[0].data.sender.id = 'a'.repeat(32), wrongTab: e => e[0].data.message.context.sourceTabId = 102,
    staleURL: e => e[0].data.message.sourceUrl = 'http://wrong/', wrongTarget: e => e[0].data.message.destination.spaceId = 'remote',
    wrongFolder: e => e[0].data.message.destination.bookmarkFolderId = 'root-remote', extraField: e => e[0].data.message.tabId = 101,
    wrongRepresentation: e => e[0].data.message.inverted = true, noRequestId: e => e[0].data.message.requestId = ''
})) test(`request proof rejects ${name}`, () => { const s = sample(), events = clone(s.options.events); mutate(events); assert.throws(() => assertNavigationRequest(events, s.options.command, s.options.captured, s.options.destination, PEER)); });
for (const inverted of [false, true]) test(`Move accepts one exact active same-URL tab at visible bottom (${inverted})`, () => verify(sample('moveCurrentTodayTab', { inverted })));
for (const [name, mutate] of Object.entries({
    duplicateMembership: s => s.after.spaces[0].temporaryTabs.push(101), wrongTail: s => s.after.spaces[1].temporaryTabs.reverse(), reorderedRemaining: s => s.after.spaces[0].temporaryTabs.reverse(),
    movedTwin: s => { s.after.spaces[0].temporaryTabs = [101, 201]; s.after.spaces[1].temporaryTabs = [103, 104, 202, 102]; },
    sameURLDeduplication: s => s.after.tabs.splice(1, 1), nativeReplacement: s => s.after.tabs[0].id = 999, nativeReorder: s => s.after.tabs[0].index++,
    nativeRegroup: s => s.after.tabs[0].groupId++, nativeRewindow: s => s.after.tabs[0].windowId = 8, nativeNavigation: s => s.after.tabs[0].url = 'http://wrong/',
    nativePin: s => s.after.tabs[0].pinned = true, lostActive: s => s.after.tabs[0].active = false, sourceDeselected: s => s.after.activeSpaces[7] = 'target',
    counterpartSelected: s => s.after.activeSpaces[8] = 'target', windowFocus: s => s.after.windows[1].focused = true, groupCollapse: s => s.after.groups[0].collapsed = true,
    pageReload: s => s.after.pageStates[101].timeOrigin++, lostTypedState: s => s.after.pageStates[102].value = '', wrongBookmark: s => s.after.bookmarks[0].title = 'Changed',
    newBinding: s => s.after.bindings[101] = { bookmarkId: 'new', pinnedUrl: URL }, changedRepresentation: s => s.after.representation.inverted = true,
    savedOrder: s => s.after.savedSnapshot.find(item => item.tabId === 101).order = 99, savedWindow: s => s.after.savedSnapshot.find(item => item.tabId === 101).windowKey = 'other',
    savedURL: s => s.after.savedSnapshot.find(item => item.tabId === 101).url = 'http://wrong/', droppedSaved: s => s.after.savedSnapshot.pop(),
    duplicateSaved: s => s.after.savedSnapshot.push(clone(s.after.savedSnapshot[0])), noReceipt: s => s.after.journal = [], duplicateReceipt: s => s.after.journal.push(clone(s.after.journal[0])),
    wrongReceipt: s => s.after.journal[0].response.tabId = 102, transientActivation: s => s.options.events.push({ type: 'tabs.onActivated', data: [{ tabId: 102, windowId: 7 }] }),
    transientGroup: s => s.options.events.push({ type: 'tabs.onUpdated', data: { id: 101, change: { groupId: 99 } } }), sidebarOpened: s => s.options.events.push({ type: 'sidePanel.onOpened', data: [] })
})) test(`Move proof rejects ${name}`, () => { const s = sample(); mutate(s); assert.throws(() => verify(s)); });
for (const options of [{}, { fallback: true }, { destinationId: 'empty' }, { destinationId: 'remote' }, { destinationId: 'empty', helper: true }]) test(`Switch accepts exact local/empty semantics ${JSON.stringify(options)}`, () => verify(sample('switchSpace', options)));
for (const [name, mutate] of Object.entries({ wrongFocus: s => { s.after.tabs[2].active = false; s.after.tabs[3].active = true; },
    otherWindowFocus: s => s.after.windows[1].focused = true, changedMembership: s => s.after.spaces[1].temporaryTabs.push(101), nativeReorder: s => s.after.tabs[0].index++,
    missingActivation: s => s.options.events.pop(), repeatedActivation: s => s.options.events.push(clone(s.options.events.at(-1))),
    wrongActivationId: s => s.options.events.at(-1).data[0].tabId = 104, wrongActivationWindow: s => s.options.events.at(-1).data[0].windowId = 8,
    crossWindowEvent: s => s.options.events.push({ type: 'windows.onFocusChanged', data: [8] }), wrongReceipt: s => s.after.journal[0].response.tabId = 104
})) test(`Switch proof rejects ${name}`, () => { const s = sample('switchSpace'); mutate(s); assert.throws(() => verify(s)); });
for (const id of ['empty', 'remote']) test(`empty-local ${id} Switch rejects invented focus and native creation`, () => {
    for (const mutate of [s => s.after.journal[0].response.tabId = 203, s => s.options.events.push({ type: 'tabs.onActivated', data: [{ tabId: 101, windowId: 7 }] }), s => s.options.events.push({ type: 'tabs.onCreated', data: [{ id: 999 }] })]) {
        const s = sample('switchSpace', { destinationId: id }); mutate(s); assert.throws(() => verify(s));
    }
});
for (const [name, mutate] of Object.entries({ wrongOwner: s => s.snapshots[7].tabs[0].spaceId = 'target', wrongActive: s => s.snapshots[7].tabs[0].active = false,
    omittedMembership: s => s.snapshots[7].spaces[0].temporaryTabIds.pop(), wrongFolder: s => s.snapshots[7].spaces[0].bookmarkFolderId = 'root-target',
    wrongSelection: s => s.snapshots[7].activeSpaceId = 'target', wrongSpaceOrder: s => s.snapshots[7].spaces.reverse()
})) test(`snapshot proof rejects ${name}`, () => { const s = state(); mutate(s); assert.throws(() => assertNavigationSnapshot(s)); });

// Counterexamples for evidence holes: absence or fabricated metadata must never
// satisfy a positive acceptance proof merely because present IDs look plausible.
for (const [name, mutate] of Object.entries({
    allWindowsOmitted: s => s.snapshots = {}, requestingWindowOmitted: s => delete s.snapshots[7],
    tabOmitted: s => s.snapshots[7].tabs.shift(), tabDuplicated: s => s.snapshots[7].tabs.push(clone(s.snapshots[7].tabs[0])),
    wrongTabWindow: s => s.snapshots[7].tabs[0].windowId = 8, wrongTabURL: s => s.snapshots[7].tabs[0].url = 'http://wrong/',
    wrongTabTitle: s => s.snapshots[7].tabs[0].title = 'Wrong visible title', wrongTabPin: s => s.snapshots[7].tabs[0].pinned = true
})) test(`snapshot evidence rejects ${name}`, () => { const s = state(); mutate(s); assert.throws(() => assertNavigationSnapshot(s)); });
test('no-choice evidence rejects a real destination selection before submission', () => {
    const options = { outcome: 'no-choice', activation: 'Enter', submission: 'Enter' };
    const events = input('switchSpace', options);
    events.splice(1, 0, event({ type: 'change', destination: true, value: '0' }));
    events.at(-1).value = '0';
    assert.throws(() => assertNavigationInput(events, 'switchSpace', options));
});
test('IME keyCode 229 cannot stand in for a genuine ordinary Enter', () => {
    const options = { outcome: 'commit', destinationIndex: 0, activation: 'Enter', submission: 'Enter' };
    const events = input('switchSpace', options); events.at(-1).keyCode = 229;
    assert.throws(() => assertNavigationInput(events, 'switchSpace', options));
});
for (const [name, mutate] of Object.entries({
    nativePin: tab => tab.pinned = true, nativeSplit: tab => tab.splitViewId = 0,
    browserNewTabAlias: tab => tab.url = 'chrome://newtab/?alias#fragment', ownedHelper: tab => tab.url = `chrome-extension://${PEER}/newtab.html?query#fragment`
})) test(`ordinary Today context proof rejects ${name}`, () => {
    const before = state(); mutate(byId(before, 101)); project(before); const captured = capture(before);
    assert.throws(() => assertNavigationContext(contextReply(captured), before, { windowId: 7, sourceTabId: 101, section: 'today' }));
});

function syncSwitch(destinationId = 'target') {
    const s = sample('switchSpace', { destinationId }); s.options.groupSync = true;
    const groups = [{ id: 11, windowId: 7, title: 'Work', color: 'blue', collapsed: false },
        { id: 13, windowId: 7, title: 'Same name', color: 'red', collapsed: true },
        { id: 12, windowId: 8, title: 'Work', color: 'blue', collapsed: false }];
    for (const current of [s.before, s.after]) {
        current.groups = clone(groups); current.projection = { 'work:7': 11, 'target:7': 13, 'work:8': 12 };
        for (const tab of current.tabs) if (tab.windowId === 7) tab.groupId = [103, 104].includes(tab.id) ? 13 : 11;
    }
    if (destinationId === 'target') { s.after.groups[0].collapsed = true; s.after.groups[1].collapsed = false; }
    return s;
}
test('settled sync-on populated Switch permits exactly expected collapse states with native partitions untouched', () => verify(syncSwitch()));
for (const [name, mutate] of Object.entries({ sourceLeftExpanded: s => s.after.groups[0].collapsed = false,
    destinationStillCollapsed: s => s.after.groups[1].collapsed = true, groupRename: s => s.after.groups[0].title = 'Wrong',
    otherWindowCollapse: s => s.after.groups[2].collapsed = true, changedProjection: s => s.after.projection['target:7'] = 99,
    groupReorder: s => s.after.tabs[0].index++, regroup: s => s.after.tabs[0].groupId = 13
})) test(`sync-on Switch rejects ${name}`, () => { const s = syncSwitch(); mutate(s); assert.throws(() => verify(s)); });
for (const destinationId of ['empty', 'remote']) test(`sync-on empty-local ${destinationId} Switch performs no activation or group projection`, () => verify(syncSwitch(destinationId)));
for (const type of ['onCreated', 'onRemoved', 'onMoved', 'onUpdated']) test(`Move rejects transient native group ${type}`, () => {
    const s = sample(); s.options.events.push({ type: `tabGroups.${type}`, data: [{ id: 11, windowId: 7, collapsed: true }] });
    assert.throws(() => verify(s));
});

for (const command of ['openTab', 'openFavorite']) {
    test(`cancellation forbids legacy ${command} fallback dispatch`, () => assert.throws(() => assertNavigationNoMutation([{ type: 'external', data: { message: { command } } }])));
    test(`exactly-once navigation forbids accompanying legacy ${command} fallback dispatch`, () => {
        const s = sample(); s.options.events.push({ type: 'external', data: { message: { command } } });
        assert.throws(() => assertNavigationRequest(s.options.events, s.options.command, s.options.captured, s.options.destination, PEER));
    });
}
test('sync-on Switch accepts only exact final same-window group update observations', () => {
    const s = syncSwitch();
    for (const group of s.after.groups.filter(group => group.windowId === 7)) s.options.events.push({ type: 'tabGroups.onUpdated', data: [clone(group)] });
    verify(s);
});
for (const [name, eventFor] of Object.entries({
    groupCreated: s => ({ type: 'tabGroups.onCreated', data: [clone(s.after.groups[0])] }),
    groupRemoved: s => ({ type: 'tabGroups.onRemoved', data: [clone(s.after.groups[0])] }),
    groupMoved: s => ({ type: 'tabGroups.onMoved', data: [clone(s.after.groups[0])] }),
    otherWindowUpdated: s => ({ type: 'tabGroups.onUpdated', data: [clone(s.after.groups[2])] }),
    transientWrongCollapse: s => ({ type: 'tabGroups.onUpdated', data: [{ ...s.after.groups[0], collapsed: false }] }),
    transientWrongTitle: s => ({ type: 'tabGroups.onUpdated', data: [{ ...s.after.groups[0], title: 'Wrong' }] }),
    transientWrongColor: s => ({ type: 'tabGroups.onUpdated', data: [{ ...s.after.groups[0], color: 'orange' }] })
})) test(`sync-on Switch rejects observed ${name} even with correct final groups`, () => {
    const s = syncSwitch(); s.options.events.push(eventFor(s)); assert.throws(() => verify(s));
});

async function attachmentFixture(kind = 'valid') {
    const previousChrome = globalThis.chrome;
    const oldPage = { name: 'old-same-url-page' }, newPage = { name: 'new-exact-page' }, removals = [], creations = [];
    let tabs = [{ id: 5, windowId: 7, url: URL, status: 'complete' }];
    const targetFor = page => ({ type: () => 'page', url: () => URL, page: async () => page });
    const oldTarget = targetFor(oldPage), targets = [oldTarget];
    globalThis.chrome = { tabs: {
        query: async () => clone(tabs), get: async id => clone(tabs.find(tab => tab.id === id)),
        create: async options => {
            creations.push(clone(options));
            const created = { ...options, id: 77, status: 'complete' };
            if (kind === 'wrong-window') created.windowId = 8;
            if (kind === 'pending-navigation') created.pendingUrl = 'http://wrong/';
            tabs.push(created); targets.push(targetFor(newPage));
            if (kind === 'two-native-tabs') tabs.push({ ...created, id: 88 });
            if (kind === 'two-fresh-targets') targets.push(targetFor({ name: 'ambiguous-same-url-page' }));
            if (kind === 'stale-target-only') targets.pop();
            return clone(created);
        },
        remove: async id => { removals.push(id); tabs = tabs.filter(tab => tab.id !== id); }
    } };
    const run = () => createNavigationFixturePage({ browser: { targets: () => targets },
        apiPage: { evaluate: async (fn, ...args) => fn(...args) },
        observePage: async page => { if (kind === 'observation-fails') throw new Error('observation failed'); assert.notEqual(page, oldPage); return page; },
        poll: async (read, accept, label) => { const value = await read(); if (!accept(value)) throw new Error(`Not ready: ${label}`); return value; },
        windowId: 7, url: URL });
    try {
        if (kind === 'valid') {
            const result = await run(); assert.equal(result.tab.id, 77); assert.equal(result.page, newPage); assert.equal(result.url, URL);
            assert.deepEqual(removals, []);
        } else {
            await assert.rejects(run); assert.deepEqual(removals, [77], 'Attachment failure removes only the exact fresh receipt, never a same-URL predecessor.');
        }
        assert.deepEqual(creations, [{ windowId: 7, url: URL, active: false }]);
        assert(tabs.some(tab => tab.id === 5), 'The old same-URL target must survive success and failure.');
    } finally { globalThis.chrome = previousChrome; }
}
test('fixture attachment distinguishes one fresh native/page identity from an older equal-URL target', () => attachmentFixture());
for (const kind of ['wrong-window', 'pending-navigation', 'two-native-tabs', 'two-fresh-targets', 'stale-target-only', 'observation-fails'])
    test(`fixture attachment fails closed and cleans exact receipt on ${kind}`, () => attachmentFixture(kind));
