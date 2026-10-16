import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { SPOTLIGHT_TAB_CASE_NAME, TAB_COMMAND_FEATURES, TAB_COMMAND_QUERIES, assertTabCommandEnvironment, serveSpotlightTabFixture,
    tabCommandTitle, assertTabCommandContext, assertTabCommandPrompt, assertTabCommandInput, assertTabCommandRequest, assertTabCommandNoEffects,
    assertTabCommandSnapshots, findTabCommandReceipt, assertTabCommandCommitted, assertTabCommandClipboard, assertTabCommandReplay } from '../../scripts/paired-chrome-spotlight-tabs.mjs';

const clone = value => structuredClone(value), SELF = 'a'.repeat(32), PEER = 'b'.repeat(32), URL = 'https://same.test/page?q=exact#fragment';
const flat = nodes => nodes.flatMap(node => [node, ...flat(node.children || [])]);
function snapshots(state) {
    state.snapshots = Object.fromEntries(state.snapshotWindowIds.map(windowId => {
        const local = ids => ids.filter(id => state.tabs.find(tab => tab.id === id).windowId === windowId);
        const title = tab => {
            const binding = state.bindings[tab.id], bookmark = binding && flat(state.bookmarks).find(node => node.id === binding.bookmarkId);
            return bookmark ? bookmark.url === tab.url ? bookmark.title : tab.title : state.aliases[tab.id]?.name || tab.title;
        };
        return [windowId, { windowId, capturedAt: 1, activeSpaceId: state.activeSpaces[windowId], warnings: [], favorites: [],
            spaces: state.spaces.map(space => ({ id: space.id, bookmarkFolderId: space.bookmarkFolderId, name: space.name, color: space.color, tabIds: local([...space.spaceBookmarks, ...space.temporaryTabs]), pinnedTabIds: local(space.spaceBookmarks), temporaryTabIds: local(space.temporaryTabs) })),
            bookmarks: state.spaces.flatMap(space => flat([flat(state.bookmarks).find(node => node.id === space.bookmarkFolderId)]).filter(node => node.url).map(node => ({ id: node.id, spaceId: space.id, title: node.title, url: node.url, tabId: local(space.spaceBookmarks).find(id => state.bindings[id]?.bookmarkId === node.id) ?? null }))),
            tabs: state.tabs.filter(tab => tab.windowId === windowId).map(tab => ({ id: tab.id, windowId, title: title(tab), url: tab.url, active: tab.active, pinned: tab.pinned, spaceId: state.spaces.find(space => [...space.temporaryTabs, ...space.spaceBookmarks].includes(tab.id))?.id ?? null })) }];
    }));
    return state;
}
function state() {
    const native = (id, windowId, index, active = false) => ({ id, windowId, index, active, title: `Native ${id}`, url: URL, pendingUrl: null, pinned: false, incognito: false, splitViewId: -1, groupId: -1, muted: false });
    const result = { arcifyId: SELF, snapshotWindowIds: [10, 20], tabs: [native(1, 10, 0, true), native(2, 10, 1), native(3, 10, 2), native(4, 20, 0), native(5, 20, 1, true)],
        windows: [{ id: 10, focused: true }, { id: 20, focused: false }],
        spaces: [{ id: 'work', name: 'Work', color: 'blue', bookmarkFolderId: 'root', temporaryTabs: [1, 3], spaceBookmarks: [2, 4], lastTab: 1 }, { id: 'other', name: 'Other', color: 'red', bookmarkFolderId: 'root-other', temporaryTabs: [5], spaceBookmarks: [], lastTab: 5 }],
        bookmarks: [{ id: 'arc', title: 'Arcify', children: [{ id: 'root', parentId: 'arc', title: 'Work', children: [{ id: 'nested', parentId: 'root', title: 'Nested', children: [
            { id: 'pin', parentId: 'nested', index: 0, title: 'Exact saved', url: URL }, { id: 'decoy', parentId: 'nested', index: 1, title: 'Equal URL decoy', url: URL }] }] },
        { id: 'root-other', parentId: 'arc', title: 'Other', children: [{ id: 'other-pin', parentId: 'root-other', index: 0, title: 'Other saved', url: URL }] }] }],
        bindings: { 2: { bookmarkId: 'pin', pinnedUrl: URL }, 4: { bookmarkId: 'pin', pinnedUrl: URL } }, aliases: { 1: { name: 'Old alias', originalDomain: 'same.test' }, 3: { name: 'Twin alias', originalDomain: 'same.test' }, 2: { name: 'Obsolete alias' }, 4: { name: 'Obsolete copy alias' } },
        favorites: [{ id: 'favorite', url: URL, title: 'Never edit' }], favoriteSession: { bindings: [] }, groups: [], projection: {}, activeSpaces: { 10: 'work', 20: 'other' },
        pageStates: { 1: { documentId: 'one', timeOrigin: 1, value: 'one' }, 2: { documentId: 'two', timeOrigin: 2, value: 'two' }, 3: { documentId: 'twin', timeOrigin: 3 }, 4: { documentId: 'copy', timeOrigin: 4 } }, pairingGeneration: 'generation', representation: { version: 1, inverted: false }, journal: [] };
    persist(result); return snapshots(result);
}
function persist(state) {
    state.savedSnapshot = state.spaces.flatMap(space => ['spaceBookmarks', 'temporaryTabs'].flatMap(section => space[section].map((tabId, order) => {
        const tab = state.tabs.find(tab => tab.id === tabId);
        return { tabId, order, section, spaceId: space.id, url: tab.url, tabIndex: tab.index, windowKey: `window-${tab.windowId}`, ...(state.aliases[tabId] ? { nameOverride: clone(state.aliases[tabId]) } : {}), ...(state.bindings[tabId] ? { pinnedState: clone(state.bindings[tabId]) } : {}) };
    })));
}
function context(before, id = 1) {
    for (const tab of before.tabs) if (tab.windowId === 10) tab.active = tab.id === id;
    snapshots(before); const native = before.tabs.find(tab => tab.id === id), binding = before.bindings[id], node = binding && flat(before.bookmarks).find(node => node.id === binding.bookmarkId);
    return { windowId: 10, sourceTabId: id, spaceId: 'work', bookmarkFolderId: 'root', pairingGeneration: 'generation', tab: { id, url: native.url, title: before.snapshots[10].tabs.find(tab => tab.id === id).title,
        section: node ? 'saved' : 'today', bookmark: node ? { id: node.id, parentId: node.parentId, title: node.title, url: node.url } : null, alias: node ? '' : before.aliases[id]?.name || '', muted: native.muted } };
}
function request(command, context, fields = {}) { return { type: 'arcify-bridge', version: 1, requestId: 'tab-action-one', command, windowId: context.windowId, supportedFeatures: [...TAB_COMMAND_FEATURES], context: clone(context), ...fields }; }
const external = message => ({ type: 'external', data: { message, sender: { id: PEER, url: `chrome-extension://${PEER}/background.js` } } });
function sample(command, fields = {}, { saved = false, inverted = false } = {}) {
    const before = state(); before.representation.inverted = inverted; const ctx = context(before, saved ? 2 : 1), req = request(command, ctx, fields), after = clone(before), events = [external(req)];
    const response = { ok: true, requestId: req.requestId, tabId: ctx.tab.id };
    if (command === 'renameCurrentTab' || command === 'editCurrentPinUrl') {
        if (saved) {
            const node = flat(after.bookmarks).find(node => node.id === 'pin'); node[command === 'renameCurrentTab' ? 'title' : 'url'] = fields.title ?? fields.url;
            for (const id of [2, 4]) { delete after.aliases[id]; after.bindings[id].pinnedUrl = node.url; }
            events.push({ type: 'bookmarks.onChanged', data: ['pin', { [command === 'renameCurrentTab' ? 'title' : 'url']: fields.title ?? fields.url }] });
        } else if (fields.title && fields.title !== before.tabs[0].title) after.aliases[1] = { name: fields.title, originalDomain: 'same.test' }; else delete after.aliases[1];
        Object.assign(response, { bookmarkId: saved ? 'pin' : null }, fields); persist(after);
    }
    if (command === 'setCurrentTabMuted') { after.tabs[0].muted = fields.muted; response.muted = fields.muted; events.push({ type: 'tabs.onUpdated', data: { id: 1, change: { mutedInfo: { muted: fields.muted } } } }); }
    if (command === 'copyCurrentLink') Object.assign(response, { copied: true, url: ctx.tab.url });
    if (command === 'duplicateCurrentTab') {
        const duplicate = { ...clone(after.tabs[0]), id: 99, index: 1, active: true };
        for (const tab of after.tabs) if (tab.windowId === 10) { tab.active = false; if (tab.index > 0) tab.index++; }
        after.tabs.push(duplicate); after.spaces[0].temporaryTabs = inverted ? [99, 1, 3] : [1, 99, 3]; after.spaces[0].lastTab = 99;
        response.tabId = 99; events.push({ type: 'tabs.onCreated', data: [clone(duplicate)] }, { type: 'tabs.onActivated', data: [{ tabId: 99, windowId: 10 }] }); persist(after);
    }
    after.journal.push({ key: 'exact-key', fingerprint: JSON.stringify(req), response }); snapshots(after);
    return { before, after, command, context: ctx, fields, events, request: req };
}
const check = value => assertTabCommandCommitted(value.before, value.after, value);

for (const [command, fields, options] of [['renameCurrentTab', { title: 'Exact alias' }], ['renameCurrentTab', { title: '' }], ['renameCurrentTab', { title: 'Saved title' }, { saved: true }], ['editCurrentPinUrl', { url: 'https://edited.test/path#exact' }, { saved: true }], ['copyCurrentLink', {}], ['setCurrentTabMuted', { muted: true }], ['duplicateCurrentTab', {}], ['duplicateCurrentTab', {}, { inverted: true }]]) test(`accept exact ${command} ${JSON.stringify(fields)} ${JSON.stringify(options)}`, () => { check(sample(command, fields, options)); });

for (const [name, mutate] of Object.entries({
    nativeTitle: f => { f.after.tabs[0].title = 'Rewritten browser title'; }, nativeUrl: f => { f.after.tabs[0].url += '/navigation'; }, nativeWindow: f => { f.after.tabs[0].windowId = 20; }, nativeFocus: f => { f.after.windows[1].focused = true; },
    decoyAlias: f => { f.after.aliases[3] = clone(f.after.aliases[1]); }, favoriteEdit: f => { f.after.favorites[0].title = 'Edited'; }, favoriteProjection: f => { f.after.snapshots[20].favorites = [{ id: 'unexpected' }]; }, warningChanged: f => { f.after.snapshots[10].warnings = [{ code: 'unexpected' }]; }, otherSpace: f => { f.after.activeSpaces[20] = 'work'; }, documentReload: f => { f.after.pageStates[1].documentId = 'new'; },
    missingPersistence: f => { f.after.savedSnapshot = f.before.savedSnapshot; }, staleSnapshot: f => { f.after.snapshots = f.before.snapshots; }, missingSavedLeaf: f => { f.after.snapshots[10].bookmarks.pop(); }, doubleReceipt: f => { f.after.journal.push(clone(f.after.journal[0])); }, wrongReceipt: f => { f.after.journal[0].response.tabId = 3; },
    physicalPanel: f => { f.events.push({ type: 'sidePanel.onOpened' }); }, transientFocus: f => { f.events.push({ type: 'tabs.onActivated', data: [{ tabId: 3, windowId: 10 }] }); }, transientNavigation: f => { f.events.push({ type: 'tabs.onUpdated', data: { id: 1, change: { url: 'https://wrong.test/' } } }); }, extraNativeTab: f => { f.events.push({ type: 'tabs.onCreated', data: [] }); }
})) test(`Today alias evidence rejects ${name}`, () => { const f = sample('renameCurrentTab', { title: 'Exact alias' }); mutate(f); assert.throws(() => check(f)); });
for (const [name, mutate] of Object.entries({
    equalUrlDecoy: f => { flat(f.after.bookmarks).find(node => node.id === 'decoy').url = f.fields.url; }, lostTitle: f => { flat(f.after.bookmarks).find(node => node.id === 'pin').title = 'Reset'; }, changedParent: f => { flat(f.after.bookmarks).find(node => node.id === 'pin').parentId = 'root-other'; },
    linkedNavigation: f => { f.after.tabs.find(tab => tab.id === 4).url = f.fields.url; }, oneCopyNotUpdated: f => { f.after.bindings[4].pinnedUrl = URL; }, obsoleteAlias: f => { f.after.aliases[4] = f.before.aliases[4]; }, staleOtherSnapshot: f => { f.after.snapshots[20] = f.before.snapshots[20]; }, extraBookmarkWrite: f => { f.events.push(clone(f.events[1])); }, changedSavedId: f => { flat(f.after.bookmarks).find(node => node.id === 'pin').id = 'replacement'; }, decoyOrder: f => { flat(f.after.bookmarks).find(node => node.id === 'decoy').index = 0; }
})) test(`saved URL evidence rejects ${name}`, () => { const f = sample('editCurrentPinUrl', { url: 'https://edited.test/' }, { saved: true }); mutate(f); assert.throws(() => check(f)); });
for (const [name, mutate] of Object.entries({
    wrongNativeInsertion: f => { f.after.tabs.find(tab => tab.id === 99).index = 3; }, borrowedAlias: f => { f.after.aliases[99] = clone(f.before.aliases[1]); }, borrowedPin: f => { f.after.bindings[99] = clone(f.before.bindings[2]); }, wrongSpace: f => { f.after.spaces[1].temporaryTabs.push(99); }, duplicateMembership: f => { f.after.spaces[0].temporaryTabs.push(99); }, missingPersistence: f => { f.after.savedSnapshot = f.after.savedSnapshot.filter(item => item.tabId !== 99); }, extraDuplicate: f => { f.after.tabs.push({ ...f.after.tabs.at(-1), id: 100 }); }, sourceActivated: f => { f.after.tabs[0].active = true; }, otherWindowIndex: f => { f.after.tabs.find(tab => tab.id === 4).index = 2; }
})) test(`duplicate evidence rejects ${name}`, () => { const f = sample('duplicateCurrentTab'); mutate(f); assert.throws(() => check(f)); });
for (const [name, mutate] of Object.entries({ twinMuted: f => { f.after.tabs[2].muted = true; }, noMuteEvent: f => { f.events.pop(); }, wrongMuteEvent: f => { f.events[1].data.id = 3; }, duplicateMuteEvent: f => { f.events.push(clone(f.events[1])); } })) test(`mute evidence rejects ${name}`, () => { const f = sample('setCurrentTabMuted', { muted: true }); mutate(f); assert.throws(() => check(f)); });

test('full strict tab context has immutable source, saved identity, empty saved alias and current mute', () => {
    const before = state(); let ctx = context(before); assertTabCommandContext(ctx, before, { windowId: 10, sourceTabId: 1, section: 'today' });
    ctx = context(before, 2); assertTabCommandContext(ctx, before, { windowId: 10, sourceTabId: 2, section: 'saved', bookmarkId: 'pin' });
    const helper = { ...ctx, tab: null }; assertTabCommandContext(helper, before, { windowId: 10, sourceTabId: 2, section: null });
    for (const change of [c => { c.sourceTabId = 3; }, c => { c.tab.bookmark.id = 'decoy'; }, c => { c.tab.alias = 'Obsolete alias'; }, c => { c.pairingGeneration = 'old'; }, c => { c.spaceId = 'other'; }, c => { c.extra = true; }]) { const bad = clone(ctx); change(bad); assert.throws(() => assertTabCommandContext(bad, before, { windowId: 10, sourceTabId: 2, section: 'saved', bookmarkId: 'pin' })); }
});

function inputEvent(values = {}) { return { type: 'click', trusted: true, key: null, keyCode: null, button: 0, repeat: false, composing: false, ctrl: false, alt: false, meta: false, title: 'Rename current tab', resultType: 'arcify-tab-action', inPrompt: false, input: false, confirm: null, cancel: false, value: null, ...values }; }
function inputTrace(value = 'new') { return [inputEvent(), inputEvent({ type: 'keydown', key: 'Control', inPrompt: true, input: true }), inputEvent({ type: 'keydown', key: 'a', ctrl: true, inPrompt: true, input: true }), inputEvent({ type: 'input', inPrompt: true, input: true, value }), inputEvent({ inPrompt: true, confirm: 'renameCurrentTab' })]; }
test('input accepts native select-all editing but no modified command or synthetic confirmation', () => {
    const ctx = context(state()), trace = inputTrace(); assertTabCommandInput(trace, 'renameCurrentTab', ctx, { value: 'new' });
    for (const change of [t => { t[0].trusted = false; }, t => { t.at(-1).repeat = true; }, t => { t[0].ctrl = true; }, t => { t.at(-1).keyCode = 229; }, t => { t.at(-1).button = 1; }, t => { t.push(clone(t[0])); }, t => { t[3].value = 'wrong'; }]) { const bad = clone(trace); change(bad); assert.throws(() => assertTabCommandInput(bad, 'renameCurrentTab', ctx, { value: 'new' })); }
});
test('prompt is visible, exact-prefilled and describes title-preserving no-navigation URL edit', () => {
    const before = state(), ctx = context(before, 2), prompt = { role: 'dialog', modal: 'true', visible: true, command: 'editCurrentPinUrl', title: 'Edit saved pin URL', confirm: 'Save URL', cancel: 'Cancel', description: 'Its saved title and the current page stay unchanged.', input: { value: URL, maxLength: 16384, focused: true } };
    assertTabCommandPrompt(prompt, 'editCurrentPinUrl', ctx);
    for (const change of [p => { p.visible = false; }, p => { p.input.value = 'https://wrong.test/'; }, p => { p.input.focused = false; }, p => { p.command = 'renameCurrentTab'; }]) { const bad = clone(prompt); change(bad); assert.throws(() => assertTabCommandPrompt(bad, 'editCurrentPinUrl', ctx)); }
});
test('one exact request cannot use legacy fallback, extra keys or copied same-URL source', () => {
    const f = sample('renameCurrentTab', { title: 'new' }); assert.deepEqual(assertTabCommandRequest(f.events, f.command, f.context, PEER, f.fields), f.request);
    for (const change of [e => { e.push(clone(e[0])); }, e => { e[0].data.message.context.sourceTabId = 3; }, e => { e[0].data.message.supportedFeatures.push('spaceActionsV1'); }, e => { e[0].data.message.extra = true; }, e => { e[0].data.sender.id = SELF; }, e => { e.push(external({ type: 'arcify-sidebar' })); }, e => { e.push(external({ command: 'openTab' })); }]) { const bad = clone(f.events); change(bad); assert.throws(() => assertTabCommandRequest(bad, f.command, f.context, PEER, f.fields)); }
});
test('cancellation and client rejection allow no mutation request, no native clipboard send and no storage writes', () => {
    const before = state(), after = clone(before); after.snapshots[10].capturedAt++;
    assertTabCommandNoEffects(before, after, []);
    for (const event of [external({ command: 'copyCurrentLink' }), { type: 'tabs.onUpdated', data: { change: { mutedInfo: { muted: true } } } }, { type: 'storage', data: { area: 'sync', changes: { key: { oldValue: 1, newValue: 2 } } } }, { type: 'internal', data: { message: { type: 'copyToClipboard' } } }]) assert.throws(() => assertTabCommandNoEffects(before, after, [event]));
});
function clipboard() { return { arcifyId: SELF, expected: URL, pasted: URL, events: [{ type: 'internal', data: { message: { target: 'offscreen', type: 'copyToClipboard', text: URL }, sender: { id: SELF } } }], contexts: [{ contextType: 'OFFSCREEN_DOCUMENT', documentUrl: `chrome-extension://${SELF}/offscreen.html` }], pasteEvents: [{ type: 'paste', trusted: true, pastedText: URL }, { type: 'input', trusted: true, value: URL }] }; }
test('copy evidence requires actual offscreen send, context and exact trusted native paste', () => {
    assertTabCommandClipboard(clipboard());
    for (const change of [p => { p.events = []; }, p => { p.events.push(clone(p.events[0])); }, p => { p.pasted += '#wrong'; }, p => { p.contexts = []; }, p => { p.pasteEvents[0].trusted = false; }, p => { p.pasteEvents[0].pastedText = 'saved url'; }, p => { p.events[0].data.sender.id = PEER; }, p => { p.pasteEvents.pop(); }]) { const bad = clipboard(); change(bad); assert.throws(() => assertTabCommandClipboard(bad)); }
});
test('replay succeeds without writes and unknown result replay stays one-shot', () => {
    const f = sample('copyCurrentLink'), before = f.after, after = clone(before), response = before.journal[0].response;
    assertTabCommandReplay(before, after, [external(f.request)], { ...response, snapshot: after.snapshots[10] }, response);
    const unknown = { ok: false, requestId: f.request.requestId, error: { code: 'UNCERTAIN_RESULT' } };
    assertTabCommandReplay(before, after, [external(f.request)], unknown, { ok: false, requestId: f.request.requestId });
    assert.throws(() => assertTabCommandReplay(before, after, [external(f.request)], { ...unknown, error: { code: 'PARTIAL_COMMIT' } }, { ok: false, requestId: f.request.requestId }));
    assert.throws(() => assertTabCommandReplay(before, after, [external(f.request), clipboard().events[0]], response, response));
    assert.throws(() => assertTabCommandReplay(before, after, [external(f.request), external(f.request)], response, response));
});
test('fixture routing is isolated, fresh and rejects unrelated or malicious paths', () => {
    const output = [], response = { writeHead: (...args) => output.push(args), end: value => output.push(value) }, path = `/spotlight-tabs/${'a'.repeat(32)}/today`;
    assert.equal(serveSpotlightTabFixture({ url: path }, response), true); assert.equal(serveSpotlightTabFixture({ url: '/other' }, response), false); assert.equal(serveSpotlightTabFixture({ url: `${path}<script>` }, response), false);
    assert.equal(output[0][0], 200); assert.equal(output[0][1]['Cache-Control'], 'no-store'); assert.match(output[1], /data-document-id="[a-f0-9]{32}"/);
    serveSpotlightTabFixture({ url: path }, response); assert.notEqual(output[1], output[3]);
});
test('entry is import-safe, hosted-only, uses approved helpers and has no browser or Clipboard substitutions', async () => {
    assertTabCommandEnvironment({ CI: 'true', GITHUB_ACTIONS: 'true' }, 1001);
    assert.throws(() => assertTabCommandEnvironment({ CI: 'true', GITHUB_ACTIONS: 'true' }, 0)); assert.throws(() => assertTabCommandEnvironment({}, 1001));
    const module = new globalThis.URL('../../scripts/paired-chrome-spotlight-tabs.mjs', import.meta.url);
    const source = await readFile(module, 'utf8');
    const result = execFileSync(process.execPath, ['--input-type=module', '-e', `delete globalThis.chrome; await import(${JSON.stringify(module.href)}); console.log('import-safe')`], { encoding: 'utf8' }); assert.equal(result.trim(), 'import-safe');
    assert.match(SPOTLIGHT_TAB_CASE_NAME, /Spotlight tab commands/); assert.equal(Object.keys(TAB_COMMAND_QUERIES).length, 5);
    for (const text of ['assertTabCommandEnvironment();', 'createNavigationFixturePage(', 'clickFreshResult(', 'replaceInputText(', 'finishBookmarkFixture(', "input.press('KeyV')", 'collectSpotlightHelperOrigin(']) assert(source.includes(text));
    assert.match(source, /unitOnly:.*PARTIAL_COMMIT/);
    assert.doesNotMatch(source, /\.launch\(|--no-sandbox|overridePermissions|navigator\.clipboard\.(read|write)|dispatchEvent\(|new (?:MouseEvent|KeyboardEvent)|sendResponse\(|\.value\s*=(?!=)|process\.argv/);
    assert.match(source, /screenshot\(page, `spotlight-tabs-\$\{label\}`, true/);
});

test('receipt lookup uses immutable fingerprint, not repeated command/context or fields alone', () => {
    const f = sample('renameCurrentTab', { title: 'First alias' });
    const next = { ...f.request, requestId: 'next-request', title: 'Different alias' };
    assert.equal(findTabCommandReceipt(f.after.journal, next), undefined);
    const newReceipt = { fingerprint: JSON.stringify(next), response: { ok: true, title: 'Different alias' } };
    const journal = [...f.after.journal, newReceipt];
    assert.deepEqual(findTabCommandReceipt(journal, next), newReceipt);
    assert.deepEqual(findTabCommandReceipt(journal, f.request), f.after.journal[0]);
    assert.throws(() => findTabCommandReceipt([...journal, clone(newReceipt)], next));
});

test('Duplicate completion preserves exact input, immutable receipt and native proof around retirement', async () => {
    const source = await readFile(new globalThis.URL('../../scripts/paired-chrome-spotlight-tabs.mjs', import.meta.url), 'utf8');
    const start = source.indexOf('    const commit = async '), end = source.indexOf('    const replay = ', start), commit = source.slice(start, end);
    assert(start > 0 && end > start);
    const input = commit.indexOf('assertTabCommandInput(trace.input'), proof = commit.indexOf('assertTabCommandCommitted(before, after'), completion = commit.indexOf('await waitForActionSurfaceCompletion('), finalProof = commit.lastIndexOf('assertTabCommandCommitted(before, after');
    assert(input > 0 && proof > input && completion > proof && finalProof > completion);
    assert(commit.lastIndexOf('after = await read()') < commit.indexOf('const completionTrace = await observed(surface, inputOwner)'));
    assert(commit.indexOf('const completionTrace = await observed(surface, inputOwner)') < finalProof);
    assert.match(commit, /findTabCommandReceipt\(state.journal, request\)/);
    assert.match(commit, /retiresOverlay: command === 'duplicateCurrentTab'/);
    assert.match(commit, /waitStatus: \(\) => status\(surface, successText/);
    assert.match(commit, /tab-command-dispatched-before-validation/); assert.match(commit, /tab-command-receipt-before-validation/);
    assert.match(commit, /observed\(surface, inputOwner\)/); assert.match(commit, /Completion must not replay the action/);
    assert(!/catch\s*\(|bringToFront\(|activate\(/.test(commit));
    assert.equal((commit.match(/await requireActionPromptGeometry/g) || []).length, 2, 'Initial and edited prompt must fit.');
});
