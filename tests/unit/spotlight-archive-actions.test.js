import test from 'node:test';
import assert from 'node:assert/strict';
import { ARCHIVE_ACTIONS_FEATURE, validateRequest, PEER_KEY, PAIRING_GENERATION_KEY } from '../../spotlight-bridge-protocol.js';
import { fixture, peer, own, context, entry } from './helpers/archive-display-fixture.js';
test('negotiated archive schema is additive, exact and rejects extra fields/context targets', () => {
    const request = { type: 'arcify-bridge', version: 1, requestId: 'one', windowId: 10, command: 'reopenArchivedTab', context, viewId: 'view', entryId: 'entry', supportedFeatures: [ARCHIVE_ACTIONS_FEATURE] };
    assert.equal(validateRequest(request, ['reopenArchivedTab']), request);
    for (const changed of [{ ...request, url: entry.url }, { ...request, entryId: 0 }, { ...request, context: { ...context, extra: true } }, { ...request, context: { ...context, windowId: 20 } }, { ...request, supportedFeatures: [ARCHIVE_ACTIONS_FEATURE, ARCHIVE_ACTIONS_FEATURE] }]) assert.throws(() => validateRequest(changed, ['reopenArchivedTab']));
});
test('private exact record authority never leaks unknown fields; same-URL entries have distinct stable identity', async t => {
    const f = fixture(t), scope = await f.prepare();
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
for (const kind of ['lost-worker', 'expired', 'pair', 'generation', 'context', 'entry']) test(`${kind} private view refuses without native action`, async t => {
    const f = fixture(t), scope = await f.prepare();
    const request = { requestId: 'restore', windowId: 10, context, viewId: scope.viewId, entryId: 'entry-one' };
    const options = { peerId: peer, pairingGeneration: 'g' };
    if (kind === 'lost-worker') f.actions.views.clear(); if (kind === 'expired') f.state.now += 400000;
    if (kind === 'pair') options.peerId = 'c'.repeat(32); if (kind === 'generation') options.pairingGeneration = 'new';
    if (kind === 'context') request.context = { ...context, sourceTabId: 2 }; if (kind === 'entry') request.entryId = 'missing';
    await assert.rejects(f.actions.reopenUnlocked(request, options)); assert.equal(f.state.effects.length, 0);
});
test('uncertain result burns the private view and cannot replay a create', async t => {
    const f = fixture(t), scope = await f.prepare(); f.state.uncertain = true;
    const request = { requestId: 'restore', windowId: 10, context, viewId: scope.viewId, entryId: 'entry-one' }, options = { peerId: peer, pairingGeneration: 'g' };
    await assert.rejects(f.actions.reopenUnlocked(request, options)); await assert.rejects(f.actions.reopenUnlocked(request, options)); assert.equal(f.state.effects.length, 1);
});
test('view and intent cache is bounded, expires and leaves archive data untouched', async t => {
    const f = fixture(t, { maxViews: 2 }); const first = await f.prepare(); await f.prepare(); await f.prepare();
    assert.equal(f.actions.views.size, 2); assert.equal(f.actions.intents.size, 2); assert(!f.actions.views.has(first.viewId));
    f.state.now += 400000; f.actions.prune(); assert.equal(f.actions.views.size, 0); assert.equal(f.actions.intents.size, 0); assert.equal(f.state.effects.length, 0);
});
for (const kind of ['worker-loss', 'pair', 'generation', 'source', 'window', 'space', 'inactive', 'foreign-origin', 'frame', 'extra-field']) test(`Open ${kind} refuses before sidePanel.open`, async t => {
    const f = fixture(t), scope = await f.prepare(), sender = f.sender(); let override = {};
    if (kind === 'worker-loss') f.actions.intents.clear(); if (kind === 'pair') f.state.pair = 'c'.repeat(32); if (kind === 'generation') f.state.generation = 'new';
    if (kind === 'source') sender.tab.id = 2; if (kind === 'window') sender.tab.windowId = 20; if (kind === 'space') f.store.active[10] = 'original';
    if (kind === 'inactive') sender.tab.active = false; if (kind === 'foreign-origin') sender.origin = 'https://evil.test'; if (kind === 'frame') sender.frameId = 1; if (kind === 'extra-field') override = { windowId: 20 };
    f.open(scope, override, sender); await f.drain(); assert.equal(f.state.opened.length, 0); assert.equal(f.state.responses[0].ok, false);
});
for (const kind of ['throwOpen', 'rejectOpen']) test(`native ${kind} consumes intent and never reopens`, async t => {
    const f = fixture(t), scope = await f.prepare(); f.state[kind] = true; f.open(scope); await f.drain(); f.open(scope); await f.drain();
    assert.equal(f.state.opened.length, 1); assert.equal(f.state.responses.length, 2); assert(f.state.responses.every(value => value.ok === false));
});

test('oversized private legacy data is retained and never cached or exposed', async t => {
    const f = fixture(t); f.store.archiveStore.viewUnlocked = async () => ({ context: Object.fromEntries(Object.entries(context).filter(([key]) => key !== 'pairingGeneration')),
        entries: [{ entry: { ...entry, legacy: 'x'.repeat(1024 * 1024) }, bookmarkFolderId: 'original-folder' }] });
    await assert.rejects(f.prepare(), /Open the Arcify archive/); assert.equal(f.actions.views.size, 0); assert.equal(f.actions.intents.size, 0); assert.equal(f.state.effects.length, 0);
});


async function claimed(f) {
    const scope = await f.prepare(), channel = f.channel();
    assert.equal((await channel.register()).success, true);
    f.open(scope); await f.drain();
    const taken = await channel.request('take'); assert.equal(taken.result.token, scope.openIntent);
    return { scope, channel, token: scope.openIntent };
}
async function confirm(channel, token) {
    const valid = await channel.request('validate', { token });
    if (!valid.success) return valid;
    return channel.request('ack', { token, displayed: true });
}
test('captured null-documentId own UI Port displays once; native resolution and receipts are not authentication or success', async t => {
    const f = fixture(t), scope = await f.prepare(), channel = f.channel();
    const reads = f.state.reads.length; f.open(scope); await f.drain();
    assert.equal(f.state.reads.length - reads, 1); assert.deepEqual(f.state.opened, [{ tabId: 1 }]); assert.deepEqual(f.state.responses, []);
    assert.equal((await channel.register()).success, true);
    const taken = await channel.request('take'); assert.equal(taken.result.token, scope.openIntent);
    assert.equal((await channel.request('take')).result, null);
    assert.equal((await confirm(channel, scope.openIntent)).result.displayed, true);
    assert.equal(f.state.responses[0].displayed, true); assert.equal(f.state.effects.length, 0);
    f.open(scope); await f.drain(); assert.equal(f.state.opened.length, 1); assert.equal(f.state.responses[1].ok, false);
});
for (const kind of ['foreign-id', 'wrong-origin', 'wrong-page', 'query', 'tab-hosted', 'iframe', 'incognito', 'inactive'])
    test(`internal ${kind} Port cannot register with null documentId`, async t => {
        const f = fixture(t), from = f.sidebar();
        if (kind === 'foreign-id') from.id = peer; if (kind === 'wrong-origin') from.origin = 'https://evil.test';
        if (kind === 'wrong-page') from.url = f.browser.runtime.getURL('options.html'); if (kind === 'query') from.url += '?native=1';
        if (kind === 'tab-hosted') from.tab = { id: 4, windowId: 10 }; if (kind === 'iframe') from.frameId = 1;
        if (kind === 'incognito') from.incognito = true; if (kind === 'inactive') from.documentLifecycle = 'cached';
        const channel = f.channel(from); assert.equal((await channel.register()).success, false); assert.equal(f.actions.panels.size, 0);
    });
test('legacy internal messages and external Port messages cannot grant display authority', async t => {
    const f = fixture(t); assert.equal(f.browser.runtime.onMessage.listeners.size, 0);
    const port = f.connect(f.sender()); await f.drain(); assert.equal(f.state.ports.at(-1).live, false);
    assert.equal(f.state.effects.length, 0);
});
test('worker restart/already-open panel may register without a fabricated onOpened receipt', async t => {
    const f = fixture(t); f.state.skipOpened = true;
    const { channel, token } = await claimed(f); assert.equal(f.actions.openedWindows.size, 0);
    assert.equal((await confirm(channel, token)).success, true);
    const second = await f.prepare(); f.open(second); await f.drain();
    assert.equal((await channel.request('take')).result.token, second.openIntent);
    assert.equal((await confirm(channel, second.openIntent)).success, true);
    assert(f.state.responses.every(result => result.displayed));
});
test('unknown old token after worker restart cannot be reused on a new Port/session', async t => {
    const f = fixture(t), channel = f.channel(); await channel.register();
    const old = await f.prepare(); f.actions.intents.clear(); f.open(old); await f.drain();
    assert.equal(f.state.opened.length, 0); assert.equal((await channel.request('validate', { token: old.openIntent })).success, false);
});
test('single eligible receiver per exact window; ambiguity burns the active invocation', async t => {
    const f = fixture(t), { channel, token } = await claimed(f), duplicate = f.channel();
    assert.equal((await duplicate.register()).code, 'PANEL_AMBIGUOUS');
    assert.equal((await confirm(channel, token)).success, false); assert.equal(f.state.responses[0].ok, false);
    duplicate.port.disconnect(); await f.drain();
    const fresh = await f.prepare(); f.open(fresh); await f.drain();
    assert.equal((await channel.request('take')).result.token, fresh.openIntent);
    assert.equal((await confirm(channel, fresh.openIntent)).success, true);
});
test('another normal-window panel cannot claim or ACK the source-window intent', async t => {
    const f = fixture(t), other = f.channel(); await other.register(20);
    const { channel, token } = await claimed(f);
    assert.equal((await other.request('take', {}, 20)).result, null);
    assert.equal((await other.request('ack', { token, displayed: true }, 20)).success, false);
    assert.equal((await other.request('take', {}, 10)).success, false);
    assert.equal((await confirm(channel, token)).success, true);
});
for (const kind of ['missing-session', 'foreign-session', 'wrong-window', 'extra-command', 'ack-before-validate', 'repeated-validation'])
    test(`claimed intent rejects ${kind} without archive effects`, async t => {
        const f = fixture(t), { channel, token } = await claimed(f);
        let action = 'validate', fields = { token }, windowId = 10;
        if (kind === 'missing-session') fields.session = undefined; if (kind === 'foreign-session') fields.session = 'other';
        if (kind === 'wrong-window') windowId = 20; if (kind === 'extra-command') fields.command = 'reopen';
        if (kind === 'ack-before-validate') { action = 'ack'; fields.displayed = true; }
        if (kind === 'repeated-validation') await channel.request('validate', { token });
        assert.equal((await channel.request(action, fields, windowId)).success, false);
        assert.equal(f.state.responses[0].ok, false); assert.equal(f.state.effects.length, 0);
    });
const invalidations = {
    'source navigate away/back': f => { f.browser.tabs.onUpdated.emit(1, { url: 'https://other.test/' }); f.browser.tabs.onUpdated.emit(1, { url: context.sourceUrl }); },
    'source activation away/back': f => { f.browser.tabs.onActivated.emit({ windowId: 10, tabId: 2 }); f.browser.tabs.onActivated.emit({ windowId: 10, tabId: 1 }); },
    'source removal': f => f.browser.tabs.onRemoved.emit(1),
    'source replacement': f => f.browser.tabs.onReplaced.emit(2, 1),
    'focus away/back': f => { f.browser.windows.onFocusChanged.emit(20); f.browser.windows.onFocusChanged.emit(10); },
    'pairing away/back': f => { f.browser.storage.onChanged.emit({ [PEER_KEY]: { oldValue: peer, newValue: own } }, 'local'); f.browser.storage.onChanged.emit({ [PEER_KEY]: { oldValue: own, newValue: peer } }, 'local'); },
    'generation': f => f.browser.storage.onChanged.emit({ [PAIRING_GENERATION_KEY]: { oldValue: 'g', newValue: 'next' } }, 'local'),
    'Space away/back': f => { f.browser.storage.onChanged.emit({ activeSpaces: { oldValue: { 10: 'source' }, newValue: { 10: 'other' } } }, 'session'); f.browser.storage.onChanged.emit({ activeSpaces: { oldValue: { 10: 'other' }, newValue: { 10: 'source' } } }, 'session'); },
    'folder': f => f.browser.bookmarks.onMoved.emit('source-folder', {}),
    'close/reopen': f => { f.browser.sidePanel.onClosed.emit({ windowId: 10 }); f.browser.sidePanel.onOpened.emit({ windowId: 10, path: 'sidebar.html' }); },
    'Port loss': (f, channel) => channel.port.disconnect()
};
for (const [kind, invalidate] of Object.entries(invalidations)) for (const stage of ['claim', 'validate', 'ACK-read'])
    test(`${kind} during ${stage} is sticky and cannot ACK after return to original state`, async t => {
        const f = fixture(t), { channel, token } = await claimed(f);
        if (stage !== 'claim') assert.equal((await channel.request('validate', { token })).success, true);
        if (stage === 'ACK-read') f.state.contextRead = () => { invalidate(f, channel); f.state.contextRead = null; };
        else invalidate(f, channel);
        await f.drain();
        const result = stage === 'claim' ? await confirm(channel, token) : await channel.request('ack', { token, displayed: true });
        assert.equal(result.success, false); assert.equal(f.state.responses[0].ok, false); assert.equal(f.actions.intents.size, 0); assert.equal(f.state.effects.length, 0);
    });
test('no-op metadata and another window selected Space do not cancel the display session', async t => {
    const f = fixture(t), { channel, token } = await claimed(f);
    f.browser.storage.onChanged.emit({ spaces: { oldValue: [{ id: 'source', bookmarkFolderId: 'source-folder', lastTab: 1 }], newValue: [{ lastTab: 9, bookmarkFolderId: 'source-folder', id: 'source' }] } }, 'local');
    f.browser.storage.onChanged.emit({ activeSpaces: { oldValue: { 10: 'source', 20: 'a' }, newValue: { 10: 'source', 20: 'b' } } }, 'session');
    assert.equal((await confirm(channel, token)).success, true);
});
test('expiry and absent display ACK report uncertainty without replay or mutation', async t => {
    const f = fixture(t, { ackMs: 15 }), { channel, token } = await claimed(f);
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(f.state.responses[0].ok, false); assert.equal((await confirm(channel, token)).success, false);
    assert.equal(f.state.opened.length, 1); assert.equal(f.state.effects.length, 0);
});
test('missing Port API hides only Open Archive preparation', async t => {
    const f = fixture(t); delete f.browser.runtime.onConnect.addListener;
    const scope = await f.prepare(); assert.equal(scope.openIntent, null); assert.equal(scope.entries.length, 2);
});

for (const malformed of [[null], [false], [{ id: 'source' }], [{ id: 3, bookmarkFolderId: 'source-folder' }], null, {}])
    test(`malformed stored Space projection ${JSON.stringify(malformed)} invalidates without listener exception`, async t => {
        const f = fixture(t), { channel, token } = await claimed(f);
        assert.doesNotThrow(() => f.browser.storage.onChanged.emit({ spaces: { oldValue: f.store.spaces, newValue: malformed } }, 'local'));
        assert.equal((await confirm(channel, token)).success, false);
        assert.equal(f.state.responses[0].ok, false); assert.equal(f.state.effects.length, 0);
    });
test('native close occurring while open() is synchronous still invalidates before pending delivery', async t => {
    const f = fixture(t), scope = await f.prepare();
    f.state.duringOpen = () => f.browser.sidePanel.onClosed.emit({ windowId: 10 });
    f.open(scope); await f.drain(); assert.equal(f.state.responses[0].ok, false); assert.equal(f.actions.intents.size, 0);
});
