import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { finishBookmarkFixture } from '../../scripts/paired-chrome-bookmark-selection.mjs';
import { serveSpotlightSplitFixture, installSpotlightSplitInputObservation, assertSpotlightSplitInput, assertSpotlightSplitRequest,
    assertSpotlightSplitSource, assertSpotlightSplitCommitted } from '../../scripts/paired-chrome-spotlight-split.mjs';
const clone = value => structuredClone(value), PEER = 'a'.repeat(32);
const external = message => ({ type: 'external', data: { message, sender: { id: PEER } } });
const input = patch => ({ type: 'click', key: null, trusted: true, repeat: false, composing: false, keyCode: null, button: 0, ctrl: false, alt: false, meta: false, shift: false, inPrompt: false, resultType: 'arcify-split-action', title: 'Split current tab', targetId: null, confirm: false, cancel: false, ...patch });
for (const method of ['click', 'Enter']) test(`trusted ${method} oracle requires one row, explicit exact target and one confirmation`, () => {
    const events = [input(method === 'Enter' ? { type: 'keydown', key: 'Enter', button: null } : {}), input({ inPrompt: true, targetId: 3 }), input({ inPrompt: true, confirm: true })];
    const expected = { command: 'createSplitView', targetId: 3, method }; assertSpotlightSplitInput(events, expected);
    for (const change of [value => value.pop(), value => value.splice(1, 1), value => value.push(clone(value[0])), value => { value[1].targetId = 2; },
        value => { value[0].title = 'End Split'; }, ...['trusted', 'repeat', 'composing', 'ctrl', 'alt', 'meta', 'shift'].map(key => value => { value[0][key] = !value[0][key]; })]) {
        const bad = clone(events); change(bad); assert.throws(() => assertSpotlightSplitInput(bad, expected));
    }
    assertSpotlightSplitInput([events[0], input({ inPrompt: true, cancel: true })], { ...expected, cancelled: true });
});
function sample({ create = true, source = 1, adjacent = false } = {}) {
    const before = { tabs: [1,2,3,9].map((id,index) => ({ id, windowId: id === 9 ? 8 : 7, index: id === 9 ? 0 : index, url: 'https://same.test/', pendingUrl: null, pinned: false, incognito: false, active: id === source || id === 9, groupId: -1, splitViewId: -1 })),
        spaces: [{ id: 'space', bookmarkFolderId: 'root', temporaryTabs: [1,9,2,3], spaceBookmarks: [] }], windows: [{ id: 7, focused: true }, { id: 8, focused: false }], activeSpaces: { 7: 'space', 8: 'space' },
        bookmarks: [], bindings: {}, aliases: {}, favorites: [], favoriteSession: {}, groups: [], pairingGeneration: 'generation', journal: [], pageStates: Object.fromEntries([1,2,3,9].map(id => [id, { documentId: `doc${id}`, value: `draft${id}`, timeOrigin: id, frames: 0, topLevel: true }])) };
    if (adjacent || !create) { before.tabs[1].index = 2; before.tabs[2].index = 1; before.spaces[0].temporaryTabs = [1,9,3,2]; }
    if (!create) before.tabs.filter(tab => [1,3].includes(tab.id)).forEach(tab => { tab.splitViewId = 77; });
    const descriptor = id => { const { url, index, groupId, pinned, splitViewId } = before.tabs.find(tab => tab.id === id); return { id, url, title: 'Same', index, groupId, pinned, splitViewId }; };
    const context = { windowId: 7, spaceId: 'space', bookmarkFolderId: 'root', pairingGeneration: 'generation', sourceTabId: source, tab: descriptor(source), pair: create ? [] : [descriptor(1), descriptor(3)] };
    const request = { type: 'arcify-bridge', version: 1, requestId: 'split-test', windowId: 7, command: create ? 'createSplitView' : 'endSplitView', context, supportedFeatures: ['globalFavoritesV1','splitActionsV1'], ...(create ? { target: descriptor(source === 1 ? 3 : 1) } : {}) };
    const after = clone(before), reordered = create && !adjacent;
    if (reordered) { after.tabs[1].index = 2; after.tabs[2].index = 1; after.spaces[0].temporaryTabs = [1,9,3,2]; }
    for (const tab of after.tabs) if ([1,3].includes(tab.id)) tab.splitViewId = create ? 77 : -1;
    const splitResult = { action: create ? 'create' : 'end', windowId: 7, spaceId: 'space', sourceTabId: source, tabIds: [1,3], splitViewId: create ? 77 : -1, reordered };
    after.journal.push({ fingerprint: JSON.stringify(request), response: { ok: true, requestId: request.requestId, role: 'arcify', splitResult } });
    const events = [external(request), ...(reordered ? [{ type: 'tabs.onMoved', data: [3, { windowId: 7, fromIndex: 2, toIndex: 1 }] }] : [])];
    const internal = { type: 'internal', data: { message: { action: 'arcifySplitAction', command: request.command, scope: { context } }, sender: { url: context.tab.url, frameId: 0, tab: { id: source, windowId: 7 } } } };
    const expected = { command: request.command, sourceTabId: source, targetId: source === 1 ? 3 : 1, windowId: 7, spotlightId: PEER };
    return { before, after, request, events, internal, expected, splitResult };
}
for (const source of [1,3]) for (const create of [false,true]) for (const adjacent of [false,true]) test(`native receipt oracle requires exact ${source} source; create=${create} adjacent=${adjacent}`, () => {
    const f = sample({ source, create, adjacent }); assert.deepEqual(assertSpotlightSplitCommitted(f.before, f.after, f.request, f.events), f.splitResult);
    assert.equal(assertSpotlightSplitRequest(f.events, f.expected), f.request);
    assert.deepEqual(assertSpotlightSplitSource([f.internal], f.request, f.request.context.tab.url), f.internal.data);
});
for (const [name, mutate] of [
    ['source focus changed', f => { f.after.tabs[0].active = false; f.after.tabs[2].active = true; }],
    ['other window changed', f => { f.after.tabs[3].active = false; }], ['other window canonical slot moved', f => { f.after.spaces[0].temporaryTabs = [1,3,9,2]; }],
    ['original document replaced', f => { f.after.pageStates[1].documentId = 'replacement'; }], ['draft lost', f => { f.after.pageStates[3].value = ''; }],
    ['wrong native pair', f => { f.after.tabs[2].splitViewId = 78; }], ['extra native member', f => { f.after.tabs[1].splitViewId = 77; }],
    ['regrouped', f => { f.after.tabs[0].groupId = 9; }], ['closed source', f => { f.after.tabs.shift(); }],
    ['unrelated bookmark change', f => { f.after.bookmarks.push({ id: 'new' }); }], ['duplicate native move', f => { f.events.push(clone(f.events[1])); }],
    ['activation event', f => { f.events.push({ type: 'tabs.onActivated', data: [{ windowId: 7, tabId: 1 }] }); }],
    ['group event', f => { f.events.push({ type: 'tabGroups.onUpdated', data: [{ id: 1 }] }); }], ['navigation event', f => { f.events.push({ type: 'tabs.onUpdated', data: { id: 1, change: { url: 'https://changed.test/' } } }); }],
    ['missing receipt', f => { f.after.journal = []; }], ['duplicate receipt', f => { f.after.journal.push(clone(f.after.journal[0])); }],
    ['wrong receipt source', f => { f.after.journal[0].response.splitResult.sourceTabId = 3; }], ['wrong receipt pair order', f => { f.after.journal[0].response.splitResult.tabIds.reverse(); }],
    ['wrong reordered claim', f => { f.after.journal[0].response.splitResult.reordered = false; }]
]) test(`native commitment oracle rejects ${name}`, () => { const f = sample(); mutate(f); assert.throws(() => assertSpotlightSplitCommitted(f.before, f.after, f.request, f.events)); });
test('request oracle rejects duplicate dispatch, helper source substitution, wrong peer and URL guessing', () => {
    const f = sample();
    for (const change of [events => events.push(clone(events[0])), events => { events[0].data.sender.id = 'b'.repeat(32); }, events => { events[0].data.message.context.sourceTabId = 9; }, events => { events[0].data.message.url = 'https://same.test/'; }, events => { events[0].data.message.target.id = 2; }]) {
        const events = clone(f.events); change(events); assert.throws(() => assertSpotlightSplitRequest(events, f.expected));
    }
});
test('source oracle requires original browser-attested top-frame tab, window, URL and scope', () => {
    const f = sample();
    for (const change of [event => { event.data.sender.tab.id = 3; }, event => { event.data.sender.tab.windowId = 8; }, event => { event.data.sender.frameId = 2; },
        event => { event.data.sender.url = 'chrome-extension://helper/newtab.html'; }, event => { event.data.message.scope.context.sourceTabId = 3; }]) {
        const internal = clone(f.internal); change(internal); assert.throws(() => assertSpotlightSplitSource([internal], f.request, f.request.context.tab.url));
    }
    assert.throws(() => assertSpotlightSplitSource([f.internal,f.internal], f.request, f.request.context.tab.url));
});
test('passive trusted input trace survives isolated iframe retirement in original parent realm', () => {
    const listeners = new Map(), parent = {}, row = { dataset: { resultType: 'arcify-split-action' }, querySelector: () => ({ textContent: 'Split current tab' }) };
    const context = { parent, globalThis: {}, document: { addEventListener: (type, fn) => listeners.set(type, fn), removeEventListener: type => listeners.delete(type), querySelector: () => row } };
    vm.runInNewContext(`(${installSpotlightSplitInputObservation})()`, context);
    listeners.get('click')({ isTrusted: true, button: 0, target: { closest: selector => selector.includes('spotlight-result') ? row : null, hasAttribute: () => false } });
    assert.equal(parent.__spotlightSplitInputs.length, 1); assert.equal(parent.__spotlightSplitInputs[0].trusted, true);
    context.globalThis.__splitInput.stop(); assert.equal(listeners.size, 0); assert.equal(parent.__spotlightSplitInputs.length, 1);
});
test('real nonce fixture has independent documents and two native pane colors with no injected scripts', () => {
    const records = [];
    for (const role of ['left','right','left']) { const out = []; assert(serveSpotlightSplitFixture({ url: `/spotlight-split/${'a'.repeat(32)}/${role}` }, { writeHead: (...args) => out.push(args), end: data => out.push(data) })); records.push(out); }
    assert(records.every(out => out[0][0] === 200 && out[0][1]['Cache-Control'] === 'no-store'));
    assert.match(records[0][1], /#f8d7da/); assert.match(records[1][1], /#d3f4e0/); assert.notEqual(records[0][1], records[2][1]);
    assert(records.every(out => !/<script|<iframe|<frame\b/.test(out[1])));
    assert.equal(serveSpotlightSplitFixture({ url: '/spotlight-split/bad/left' }, {}), false);
});
test('hosted driver keeps positive actions on real UI and proves both source panes with native screenshots', () => {
    const source = readFileSync(new URL('../../scripts/paired-chrome-spotlight-split.mjs', import.meta.url), 'utf8');
    assert.match(source, /assertNativeSplitCapability\(capability\)/); assert.match(source, /for \(const sync of \[false, true\]\)/); assert.match(source, /for \(const source of \[left, right\]\)/);
    assert.match(source, /await run\(source.tab.id, target.tab.id, 'createSplitView', method\)/); assert.match(source, /await run\(source.tab.id, target.tab.id, 'endSplitView', method\)/);
    assert.match(source, /assertSpotlightSplitSource\(/); assert.match(source, /assertSpotlightSplitCommitted\(before, final/); assert.match(source, /captureNativeWindow\(\{ nonce/);
    assert.match(source, /globalThis.__spotlightSplitInputs/); assert.doesNotMatch(source, /chrome.tabs.createSplit\(|chrome.tabs.unsplit\(|\.dispatchEvent\(|\.select\(|Object.defineProperty|no-sandbox|disable-web-security|\.evaluate\([^\n]*\.click\(/);
});

for (const create of [true, false]) test(`actual ${create ? 'create' : 'end'} success orchestration retains every already-read event trace for replay`, async () => {
    const source = readFileSync(new URL('../../scripts/paired-chrome-spotlight-split.mjs', import.meta.url), 'utf8');
    const start = source.indexOf('        const events = await poll(');
    const end = source.indexOf('\n    };', start);
    assert(start > 0 && end > start);
    const f = sample({ create }), command = f.request.command, sourceId = f.request.context.sourceTabId, targetId = f.expected.targetId;
    const method = 'click', inputs = [input({ title: create ? 'Split current tab' : 'End Split' }),
        ...(create ? [input({ inPrompt: true, targetId }), input({ inPrompt: true, confirm: true })] : [])];
    const requestEvents = clone(f.events), events = [...clone(f.events), { type: 'trace-boundary', data: 'committed' }];
    const finalEvents = [...clone(events), { type: 'trace-boundary', data: 'final' }], peerEvents = [clone(f.internal)];
    const apiSamples = [requestEvents, events, finalEvents], checkpoints = [], calls = [];
    await new vm.Script(`(async () => {"use strict";${source.slice(start, end)}\n})()`).runInNewContext({
        assert, before: f.before, command, sourceId, targetId, expected: f.expected, method, nonce: 'fixture-nonce', rows: ['exact-result'], pickerShot: { filename: 'picker.png' },
        poll: async (read, ready) => { const value = await read(); assert(ready(value)); return value; }, read: async () => f.after,
        apiPage: { evaluate: async () => { calls.push('provider-events'); assert(apiSamples.length); return apiSamples.shift(); } },
        overlayPage: { evaluate: async () => { calls.push('retained-inputs'); return inputs; } },
        spotlightOptions: { evaluate: async () => { calls.push('peer-events'); return peerEvents; } },
        assertSpotlightSplitInput, assertSpotlightSplitRequest, assertSpotlightSplitSource, assertSpotlightSplitCommitted,
        exact: (values, id) => { const found = values.filter(value => value.id === id); assert.equal(found.length, 1); return found[0]; },
        closeOverlay: async () => calls.push('close-overlay'),
        captureNativeWindow: async () => ({ filename: 'native-window.png' }), screenshot: async () => ({ filename: 'ended-page.png' }),
        checkpoint: async (phase, data) => checkpoints.push(clone({ phase, ...data }))
    });
    assert.equal(apiSamples.length, 0); assert.equal(calls.filter(call => call === 'provider-events').length, 3);
    assert.equal(calls.filter(call => call === 'peer-events').length, 1, 'Retention adds no observation or browser read.');
    assert.equal(checkpoints.length, 1); const saved = checkpoints[0];
    assert.equal(saved.phase, 'trusted-split-committed');
    assert.deepEqual(saved.requestEvents, requestEvents); assert.deepEqual(saved.events, events);
    assert.deepEqual(saved.peerEvents, peerEvents); assert.deepEqual(saved.finalEvents, finalEvents);
    assert.deepEqual(assertSpotlightSplitRequest(saved.requestEvents, f.expected), saved.request);
    assert.deepEqual(assertSpotlightSplitRequest(saved.events, f.expected), saved.request);
    assert.deepEqual(assertSpotlightSplitSource(saved.peerEvents, saved.request, saved.request.context.tab.url), saved.sourceProof);
    assert.deepEqual(assertSpotlightSplitCommitted(saved.before, saved.after, saved.request, saved.finalEvents), saved.receipt);
    assertSpotlightSplitInput(saved.inputs, { command, targetId, method });
});

// Execute the actual finalization source with the actual shared helper, never Chrome.
const cleanupSource = readFileSync(new URL('../../scripts/paired-chrome-spotlight-split.mjs', import.meta.url), 'utf8');
const cleanupStart = cleanupSource.indexOf('    await finishBookmarkFixture(');
assert(cleanupStart > 0);
const finalization = cleanupSource.slice(cleanupStart, cleanupSource.lastIndexOf('\n}'));
const actionFailureCatch = cleanupSource.slice(cleanupSource.lastIndexOf('    } catch (error)', cleanupStart) + 6, cleanupStart);

function setup({ primaryError, failAt, mismatch, sync = { syncTabGroups: true }, evidenceFailure = false, actionError, actionEvidenceFailure = false } = {}) {
    const calls = [], checkpoints = [];
    const initial = {
        tabs: [
            { id: 1, windowId: 7, index: 0, url: 'https://original.test/', pendingUrl: undefined, active: true, pinned: false, incognito: false, splitViewId: -1 },
            { id: 2, windowId: 8, index: 0, url: 'https://other.test/', pendingUrl: undefined, active: true, pinned: false, incognito: false, splitViewId: -1 }
        ],
        windows: [{ id: 7, focused: true }, { id: 8, focused: false }],
        active: { 7: 'source-space', 8: 'other-space' }, sync: clone(sync)
    };
    const owned = [101, 102];
    const state = { tabs: [...clone(initial.tabs), ...owned.map(id => ({ id }))], sync: { syncTabGroups: false }, active: {}, focus: null };
    const evidence = { checkpoints: [{ phase: 'both-source-panes-proved', sync: false }, { phase: 'both-source-panes-proved', sync: true }] };
    const cleanupError = new Error(`cleanup ${failAt || 'none'}`);
    const step = name => { calls.push(name); if (name === failAt) throw cleanupError; };
    const chrome = {
        tabs: {
            async remove(ids) { step('remove-owned'); assert.deepEqual([...ids], owned); state.tabs = state.tabs.filter(tab => !ids.includes(tab.id)); },
            async update(id, patch) { step(`activate-tab-${id}`); assert.deepEqual(patch.active, true); state.tabs.find(tab => tab.id === id).active = patch.active; },
            async query(query) {
                step('verify-tabs'); assert.equal(Object.keys(query).length, 0);
                const remaining = clone(state.tabs); mismatch?.(remaining); return remaining;
            }
        },
        windows: { async update(id, patch) { step('restore-focus'); assert.equal(id, 7); assert.equal(patch.focused, true); state.focus = id; } },
        storage: { sync: { async remove(key) { step('remove-absent-setting'); assert.equal(key, 'syncTabGroups'); delete state.sync[key]; } } }
    };
    const apiGlobals = {
        __navigationGroupObservation: { stop: () => step('stop-group-observation') },
        __spaceActionObservation: { stop: () => step('stop-provider-observation') }
    };
    const peerGlobals = { __spaceActionObservation: { stop: () => step('stop-client-observation') } };
    const evaluate = globals => async (fn, input) => new vm.Script(`(${fn.toString()})(input)`).runInNewContext({ chrome, globalThis: globals, input });
    const actionFailure = actionError ? `let primaryError; try { throw actionError; } ${actionFailureCatch}` : '';
    const promise = new vm.Script(`(async () => {"use strict";${actionFailure}${finalization}\n})()`).runInNewContext({
        finishBookmarkFixture, primaryError, actionError, initial, owned, evidence, assert,
        exact: (values, id) => { const found = values.filter(value => value.id === id); assert.equal(found.length, 1); return found[0]; },
        closeOverlay: async () => step('close-overlay'),
        apiPage: { evaluate: evaluate(apiGlobals) }, spotlightOptions: { evaluate: evaluate(peerGlobals) },
        setting: async value => { step('restore-setting'); assert.equal(value, Boolean(initial.sync.syncTabGroups)); state.sync.syncTabGroups = value; },
        local: async request => { step(`restore-space-${request.windowId}`); assert.equal(request.action, 'activate'); state.active[request.windowId] = request.spaceId; },
        settle: async () => step('settle'),
        checkpoint: async (phase, data) => {
            const checkpoint = { phase, ...data }; evidence.checkpoints.push(checkpoint); checkpoints.push(clone(checkpoint));
            if (evidenceFailure && phase === 'spotlight-split-cleanup-failed') throw new Error('record unavailable');
            if (actionEvidenceFailure && phase === 'spotlight-split-failed') throw new Error('failure record unavailable');
        }
    });
    return { promise, initial, state, calls, checkpoints, evidence, cleanupError };
}

for (const sync of [{ syncTabGroups: true }, { syncTabGroups: false }, {}]) test(`real Split finalization restores original state with sync=${JSON.stringify(sync)}`, async () => {
    const f = setup({ sync });
    assert.equal(await f.promise, f.evidence);
    assert.deepEqual(f.state.tabs, f.initial.tabs);
    assert.deepEqual(f.state.sync, sync);
    assert.deepEqual(f.state.active, f.initial.active);
    assert.equal(f.state.focus, 7);
    assert.deepEqual(f.calls, ['close-overlay', 'remove-owned', 'restore-setting', ...(!Object.hasOwn(sync, 'syncTabGroups') ? ['remove-absent-setting'] : []),
        'activate-tab-1', 'activate-tab-2', 'restore-space-7', 'restore-space-8', 'restore-focus', 'settle', 'verify-tabs',
        'stop-group-observation', 'stop-provider-observation', 'stop-client-observation']);
    assert.deepEqual(f.checkpoints, [{ phase: 'spotlight-split-cleanup-verified' }]);
    assert.equal(f.evidence.checkpoints[0].phase, 'both-source-panes-proved');
});

test('real Split finalization rethrows the exact primary failure after all successful cleanup', async () => {
    const primaryError = new Error('original native assertion failed'), f = setup({ primaryError });
    await assert.rejects(f.promise, error => error === primaryError);
    assert.equal(primaryError.cleanupErrors, undefined);
    assert.deepEqual(f.state.tabs, f.initial.tabs);
    assert.equal(f.calls.at(-1), 'stop-client-observation');
    assert.equal(f.checkpoints.at(-1).phase, 'spotlight-split-cleanup-verified');
});

for (const failAt of ['close-overlay', 'remove-owned', 'restore-setting', 'restore-focus', 'stop-group-observation', 'stop-client-observation']) {
    test(`real cleanup failure at ${failAt} stays fatal, records evidence and continues independent cleanup`, async () => {
        const f = setup({ failAt });
        await assert.rejects(f.promise, error => error instanceof AggregateError && error.errors.includes(f.cleanupError));
        assert.equal(f.calls.at(-1), 'stop-client-observation');
        assert(f.calls.includes('remove-owned'));
        const failure = f.checkpoints.at(-1);
        assert.equal(failure.phase, 'spotlight-split-cleanup-failed');
        assert(failure.errors.includes(f.cleanupError.message));
        assert.equal(f.evidence.checkpoints[0].phase, 'both-source-panes-proved');
    });
}

for (const evidenceFailure of [false, true]) test(`cleanup errors attach to original failure without replacing it; recorder failure=${evidenceFailure}`, async () => {
    const primaryError = new Error('original screenshot assertion failed'), f = setup({ primaryError, failAt: 'close-overlay', evidenceFailure });
    await assert.rejects(f.promise, error => error === primaryError);
    assert.deepEqual(primaryError.cleanupErrors, ['cleanup close-overlay', ...(evidenceFailure ? ['Evidence: record unavailable'] : [])]);
    assert.equal(f.calls.at(-1), 'stop-client-observation');
    assert.equal(f.checkpoints.at(-1).phase, 'spotlight-split-cleanup-failed');
});

for (const [name, mismatch] of [
    ['extra fixture tab', tabs => tabs.push({ id: 999 })],
    ...['windowId', 'url', 'pendingUrl', 'index', 'active', 'pinned', 'incognito', 'splitViewId'].map(key => [key, tabs => { tabs[0][key] = `changed-${key}`; }])
]) test(`real strict cleanup rejects retained tab mismatch: ${name}`, async () => {
    const f = setup({ mismatch });
    await assert.rejects(f.promise, error => error instanceof AggregateError && error.errors.some(item => item.code === 'ERR_ASSERTION'));
    assert.equal(f.calls.at(-1), 'stop-client-observation');
    assert.equal(f.checkpoints.at(-1).phase, 'spotlight-split-cleanup-failed');
    assert(!f.checkpoints.some(checkpoint => checkpoint.phase === 'spotlight-split-cleanup-verified'));
});

for (const actionEvidenceFailure of [false, true]) test(`actual action catch preserves original failure and always cleans up; recorder failure=${actionEvidenceFailure}`, async () => {
    const actionError = new Error('native action failed'), f = setup({ actionError, actionEvidenceFailure });
    await assert.rejects(f.promise, error => error === actionError);
    assert.deepEqual(actionError.evidenceErrors ? [...actionError.evidenceErrors] : undefined, actionEvidenceFailure ? ['failure record unavailable'] : undefined);
    assert.deepEqual(f.state.tabs, f.initial.tabs);
    assert.equal(f.calls.at(-1), 'stop-client-observation');
    assert.deepEqual(f.checkpoints.map(item => item.phase), ['spotlight-split-failed', 'spotlight-split-cleanup-verified']);
});

test('failure-record rejection cannot replace a frozen primary error or prevent cleanup', async () => {
    const actionError = Object.freeze(new Error('frozen original failure'));
    const f = setup({ actionError, actionEvidenceFailure: true });
    await assert.rejects(f.promise, error => error === actionError);
    assert.equal(actionError.evidenceErrors, undefined);
    assert.deepEqual(f.state.tabs, f.initial.tabs);
    assert.equal(f.calls.at(-1), 'stop-client-observation');
    assert.deepEqual(f.checkpoints.map(item => item.phase), ['spotlight-split-failed', 'spotlight-split-cleanup-verified']);
});
