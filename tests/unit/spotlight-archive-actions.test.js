import test from 'node:test';
import assert from 'node:assert/strict';
import { SpotlightArchiveActions, ARCHIVE_OPEN_TYPE } from '../../spotlight-archive-actions.js';
import { PEER_KEY, PAIRING_GENERATION_KEY, ARCHIVE_ACTIONS_FEATURE, validateRequest } from '../../spotlight-bridge-protocol.js';
const peer = 'a'.repeat(32), own = 'b'.repeat(32);
const context = { windowId: 10, spaceId: 'source', bookmarkFolderId: 'source-folder', sourceTabId: 1, sourceUrl: 'https://source.test/', pairingGeneration: 'g' };
const entry = { entryId: 'entry-one', name: 'Original', url: 'https://same.test/', spaceId: 'original', archivedAt: 123, unknownLegacy: { untouched: true } };
function fixture(options = {}) {
    const state = { now: 1, pair: peer, generation: 'g', reads: [], opened: [], responses: [], contexts: [], sent: [], effects: [], handlers: [] };
    const browser = { runtime: { id: own, getURL: path => `chrome-extension://${own}/${path}`,
        getContexts: async filter => { state.contexts.push(filter); return state.noNative ? [] : [{ contextType: 'SIDE_PANEL', windowId: 10, documentId: 'native-doc', documentUrl: `chrome-extension://${own}/sidebar.html` }]; },
        sendMessage: async request => { state.sent.push(request); }, onMessage: { addListener: handler => state.handlers.push(handler), removeListener() {} } },
        storage: { local: { get(keys, callback) {
            state.reads.push(keys); const value = { [PEER_KEY]: state.pair, [PAIRING_GENERATION_KEY]: state.generation };
            if (callback) { state.callback = true; callback(value); state.callback = false; return; }
            return Promise.resolve(value);
        } } }, sidePanel: { onOpened: { addListener: listener => { state.onOpened = listener; } }, onClosed: { addListener: listener => { state.onClosed = listener; } }, open(target) { assert.equal(state.callback, true, 'Native open stays on the single callback stack'); state.opened.push(target); if (!state.skipOpened) state.onOpened({ windowId: 10, path: 'sidebar.html' }); if (state.throwOpen) throw new Error('gesture required'); return state.rejectOpen ? Promise.reject(new Error('gesture required')) : Promise.resolve(); } } };
    const store = { active: { 10: 'source' }, spaces: [{ id: 'source', bookmarkFolderId: 'source-folder' }], run: operation => operation(), archiveStore: {
        async viewUnlocked() { return { context: Object.fromEntries(Object.entries(context).filter(([key]) => key !== 'pairingGeneration')), entries: [{ entry: structuredClone(entry), bookmarkFolderId: 'original-folder' }, { entry: { ...entry, entryId: 'entry-two', name: 'Twin' }, bookmarkFolderId: 'original-folder' }] }; },
        async contextUnlocked(windowId, expected) { if (state.stale || store.active[windowId] !== expected.spaceId) throw new Error('stale source'); },
        async reopenUnlocked(request, hooks) { await hooks.beforeMutation(); state.effects.push(request); if (state.uncertain) throw new Error('uncertain native result'); return { consumed: true, entryId: request.expected.entryId, tabId: 50, status: 'reopened' }; }
    } };
    globalThis.chrome = browser;
    const actions = new SpotlightArchiveActions(store, browser, { now: () => state.now, ackMs: 15, ...options });
    const prepare = () => actions.prepareUnlocked({ tabId: 1, windowId: 10 }, { peerId: peer, pairingGeneration: 'g' });
    const sender = () => ({ id: peer, frameId: 0, documentLifecycle: 'active', url: context.sourceUrl, origin: 'https://source.test', tab: { id: 1, windowId: 10, active: true, url: context.sourceUrl } });
    const sidebar = () => ({ id: own, url: `chrome-extension://${own}/sidebar.html`, origin: `chrome-extension://${own}`, documentId: 'native-doc' });
    const open = (scope, override = {}, from = sender()) => actions.open({ type: ARCHIVE_OPEN_TYPE, version: 1, requestId: 'req-open', token: scope.openIntent, ...override }, from, result => state.responses.push(result));
    const internal = request => new Promise(resolve => state.handlers[0](request, sidebar(), resolve));
    const drain = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
    return { state, browser, store, actions, prepare, sender, sidebar, open, internal, drain };
}

test('negotiated archive schema is additive, exact and rejects extra fields/context targets', () => {
    const request = { type: 'arcify-bridge', version: 1, requestId: 'one', windowId: 10, command: 'reopenArchivedTab', context, viewId: 'view', entryId: 'entry', supportedFeatures: [ARCHIVE_ACTIONS_FEATURE] };
    assert.equal(validateRequest(request, ['reopenArchivedTab']), request);
    for (const changed of [{ ...request, url: entry.url }, { ...request, entryId: 0 }, { ...request, context: { ...context, extra: true } }, { ...request, context: { ...context, windowId: 20 } }, { ...request, supportedFeatures: [ARCHIVE_ACTIONS_FEATURE, ARCHIVE_ACTIONS_FEATURE] }]) assert.throws(() => validateRequest(changed, ['reopenArchivedTab']));
});
test('private exact record authority never leaks unknown fields; same-URL entries have distinct stable identity', async () => {
    const f = fixture(), scope = await f.prepare();
    assert.deepEqual(scope.entries.map(value => value.entryId), ['entry-one', 'entry-two']);
    assert(scope.entries.every(value => !('unknownLegacy' in value) && !('name' in value)));
    assert.equal(f.actions.views.get(scope.viewId).entries[0].entry.unknownLegacy.untouched, true);
    const request = { requestId: 'restore', windowId: 10, context, viewId: scope.viewId, entryId: 'entry-two' };
    const result = await f.actions.reopenUnlocked(request, { peerId: peer, pairingGeneration: 'g' });
    assert.equal(f.state.effects[0].expected.name, 'Twin'); assert.equal(result.archiveResult.entryId, 'entry-two');
    assert.equal(result.archiveResult.spaceId, 'original'); assert.equal(f.state.effects[0].bookmarkFolderId, 'original-folder');
    await assert.rejects(f.actions.reopenUnlocked(request, { peerId: peer, pairingGeneration: 'g' }));
    assert.equal(f.state.effects.length, 1);
});
for (const kind of ['lost-worker', 'expired', 'pair', 'generation', 'context', 'entry']) test(`${kind} private view refuses without native action`, async () => {
    const f = fixture(), scope = await f.prepare();
    const request = { requestId: 'restore', windowId: 10, context, viewId: scope.viewId, entryId: 'entry-one' };
    const options = { peerId: peer, pairingGeneration: 'g' };
    if (kind === 'lost-worker') f.actions.views.clear(); if (kind === 'expired') f.state.now += 400000;
    if (kind === 'pair') options.peerId = 'c'.repeat(32); if (kind === 'generation') options.pairingGeneration = 'new';
    if (kind === 'context') request.context = { ...context, sourceTabId: 2 }; if (kind === 'entry') request.entryId = 'missing';
    await assert.rejects(f.actions.reopenUnlocked(request, options)); assert.equal(f.state.effects.length, 0);
});
test('uncertain result burns the private view and cannot replay a create', async () => {
    const f = fixture(), scope = await f.prepare(); f.state.uncertain = true;
    const request = { requestId: 'restore', windowId: 10, context, viewId: scope.viewId, entryId: 'entry-one' }, options = { peerId: peer, pairingGeneration: 'g' };
    await assert.rejects(f.actions.reopenUnlocked(request, options)); await assert.rejects(f.actions.reopenUnlocked(request, options)); assert.equal(f.state.effects.length, 1);
});
test('view and intent cache is bounded, expires and leaves archive data untouched', async () => {
    const f = fixture({ maxViews: 2 }); const first = await f.prepare(); await f.prepare(); await f.prepare();
    assert.equal(f.actions.views.size, 2); assert.equal(f.actions.intents.size, 2); assert(!f.actions.views.has(first.viewId));
    f.state.now += 400000; f.actions.prune(); assert.equal(f.actions.views.size, 0); assert.equal(f.actions.intents.size, 0); assert.equal(f.state.effects.length, 0);
});
test('Open requires a real native sidebar document, consumes once and responds only after popup ACK', async () => {
    const f = fixture(), scope = await f.prepare(); f.actions.install();
    const reads = f.state.reads.length; f.open(scope); await f.drain();
    assert.equal(f.state.reads.length - reads, 1); assert.deepEqual(f.state.opened, [{ tabId: 1 }]); assert.deepEqual(f.state.responses, []);
    assert.equal((await f.internal({ type: 'arcifyArchiveIntent', action: 'register', windowId: 10 })).success, true);
    const taken = await f.internal({ type: 'arcifyArchiveIntent', action: 'take', windowId: 10 });
    assert.equal(taken.result.token, scope.openIntent);
    assert.equal((await f.internal({ type: 'arcifyArchiveIntent', action: 'take', windowId: 10 })).result, null);
    const ack = await f.internal({ type: 'arcifyArchiveIntent', action: 'ack', windowId: 10, token: scope.openIntent, displayed: true });
    assert.equal(ack.result.displayed, true); assert.equal(f.state.responses[0].displayed, true);
    f.open(scope); await f.drain(); assert.equal(f.state.opened.length, 1); assert.equal(f.state.responses[1].ok, false);
});
for (const kind of ['worker-loss', 'pair', 'generation', 'source', 'window', 'space', 'inactive', 'foreign-origin', 'frame', 'extra-field']) test(`Open ${kind} refuses before sidePanel.open`, async () => {
    const f = fixture(), scope = await f.prepare(), sender = f.sender(); let override = {};
    if (kind === 'worker-loss') f.actions.intents.clear(); if (kind === 'pair') f.state.pair = 'c'.repeat(32); if (kind === 'generation') f.state.generation = 'new';
    if (kind === 'source') sender.tab.id = 2; if (kind === 'window') sender.tab.windowId = 20; if (kind === 'space') f.store.active[10] = 'original';
    if (kind === 'inactive') sender.tab.active = false; if (kind === 'foreign-origin') sender.origin = 'https://evil.test'; if (kind === 'frame') sender.frameId = 1; if (kind === 'extra-field') override = { windowId: 20 };
    f.open(scope, override, sender); await f.drain(); assert.equal(f.state.opened.length, 0); assert.equal(f.state.responses[0].ok, false);
});
test('non-native sidebar page cannot claim and Chrome open resolution is never display proof', async () => {
    const f = fixture(), scope = await f.prepare(); f.actions.install(); f.state.noNative = true;
    f.open(scope); await f.drain(); assert.equal(f.state.responses.length, 0);
    const reply = await f.internal({ type: 'arcifyArchiveIntent', action: 'take', windowId: 10 }); assert.equal(reply.success, false);
    await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(f.state.responses[0].ok, false); assert.equal(f.actions.intents.size, 0);
});
test('source change between panel opening and claim refuses display, preserving one-shot token', async () => {
    const f = fixture(), scope = await f.prepare(); f.actions.install(); f.open(scope); await f.drain(); f.state.stale = true;
    await f.internal({ type: 'arcifyArchiveIntent', action: 'register', windowId: 10 });
    assert.equal((await f.internal({ type: 'arcifyArchiveIntent', action: 'take', windowId: 10 })).success, false);
    f.open(scope); await f.drain(); assert.equal(f.state.opened.length, 1); await new Promise(resolve => setTimeout(resolve, 25));
});
test('missing native context API hides only Open Archive preparation', async () => {
    const f = fixture(); delete f.browser.runtime.getContexts; const scope = await f.prepare(); assert.equal(scope.openIntent, null); assert.equal(scope.entries.length, 2);
});
for (const kind of ['throwOpen', 'rejectOpen']) test(`native ${kind} consumes intent and never reopens`, async () => {
    const f = fixture(), scope = await f.prepare(); f.state[kind] = true; f.open(scope); await f.drain(); f.open(scope); await f.drain();
    assert.equal(f.state.opened.length, 1); assert.equal(f.state.responses.length, 2); assert(f.state.responses.every(value => value.ok === false));
});

test('Chromium unknown-window native context needs a real opened receipt and registered same-epoch document', async () => {
    const f = fixture(), scope = await f.prepare(); f.actions.install();
    f.browser.runtime.getContexts = async () => [{ contextType: 'SIDE_PANEL', windowId: -1, documentId: 'native-doc', documentUrl: `chrome-extension://${own}/sidebar.html` }];
    f.state.skipOpened = true; f.open(scope); await f.drain();
    assert.equal((await f.internal({ type: 'arcifyArchiveIntent', action: 'register', windowId: 10 })).success, false);
    f.state.onOpened({ windowId: 10, path: 'sidebar.html' });
    assert.equal((await f.internal({ type: 'arcifyArchiveIntent', action: 'register', windowId: 10 })).success, true);
    assert.equal((await f.internal({ type: 'arcifyArchiveIntent', action: 'take', windowId: 10 })).success, true);
    await f.internal({ type: 'arcifyArchiveIntent', action: 'ack', windowId: 10, token: scope.openIntent, displayed: true });
    const next = await f.prepare(); f.open(next); await f.drain();
    assert.equal((await f.internal({ type: 'arcifyArchiveIntent', action: 'take', windowId: 10 })).success, true);
    await f.internal({ type: 'arcifyArchiveIntent', action: 'ack', windowId: 10, token: next.openIntent, displayed: true });
    assert(f.state.responses.every(response => response.displayed === true), 'Already-open verified panel needs no manufactured second onOpened');
    f.state.onClosed({ windowId: 10 }); assert.equal(f.actions.panels.size, 0);
});

test('oversized private legacy data is retained and never cached or exposed', async () => {
    const f = fixture(); f.store.archiveStore.viewUnlocked = async () => ({ context: Object.fromEntries(Object.entries(context).filter(([key]) => key !== 'pairingGeneration')),
        entries: [{ entry: { ...entry, legacy: 'x'.repeat(1024 * 1024) }, bookmarkFolderId: 'original-folder' }] });
    await assert.rejects(f.prepare(), /Open the Arcify archive/); assert.equal(f.actions.views.size, 0); assert.equal(f.actions.intents.size, 0); assert.equal(f.state.effects.length, 0);
});

test('native sidebar close while intent source check awaits cannot acknowledge display', async () => {
    const f = fixture(), scope = await f.prepare(); f.actions.install(); f.open(scope); await f.drain();
    await f.internal({ type: 'arcifyArchiveIntent', action: 'register', windowId: 10 });
    await f.internal({ type: 'arcifyArchiveIntent', action: 'take', windowId: 10 });
    f.store.archiveStore.contextUnlocked = async () => { f.state.onClosed({ windowId: 10 }); };
    const result = await f.internal({ type: 'arcifyArchiveIntent', action: 'ack', windowId: 10, token: scope.openIntent, displayed: true });
    assert.equal(result.success, false); assert.equal(f.state.responses[0].ok, false); assert.equal(f.actions.intents.size, 0);
});
