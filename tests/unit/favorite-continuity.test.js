import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFavoriteContinuity, configureFavoriteContinuityPeer, CONTINUITY_LOCAL_KEY as LOCAL, CONTINUITY_SESSION_KEY as RECEIPT, validContinuityState } from '../../favorite-continuity.js';
import { PEER_KEY, PAIRING_GENERATION_KEY as GENERATION } from '../../spotlight-bridge-protocol.js';
const PEER = 'b'.repeat(32), OTHER = 'c'.repeat(32);
const clone = value => structuredClone(value);
const empty = () => ({ version: 1, bindings: [], attempts: [] });
const state = () => ({ version: 1, bindings: [{ favoriteId: 'favorite', tabId: 10, windowId: 1, mode: 'ordinary' }], attempts: [] });
const items = [{ id: 'favorite', title: 'Saved', url: 'https://saved.test/', sourceBookmarkId: null }];
function fixture() {
    const local = { [PEER_KEY]: PEER, [GENERATION]: crypto.randomUUID() }, session = {}, writes = [], calls = [];
    const f = { local, session, writes, calls, peerGeneration: crypto.randomUUID(), witness: null, offline: false,
        tabs: [{ id: 10, windowId: 1, pinned: false, url: 'https://navigated.test/' }] };
    const area = (data, name) => ({
        async get(keys) { const list = typeof keys === 'string' ? [keys] : keys; return Object.fromEntries(list.map(key => [key, clone(data[key])])); },
        async set(values) { writes.push({ area: name, values: clone(values) }); if (f.fail?.(name, values)) throw new Error('persistence failed'); Object.assign(data, clone(values)); }
    });
    f.api = { runtime: { getURL: path => `chrome-extension://${PEER}/${path}` }, storage: { local: area(local, 'local'), session: area(session, 'session') }, tabs: { query: async () => { await f.beforeQuery?.(); return clone(f.tabs); } },
        windows: { get: async id => ({ id, type: 'normal', incognito: false }) } };
    f.sendRequest = async (peer, command, receipt) => {
        calls.push({ peer, command, receipt: clone(receipt) });
        if (f.offline) throw Object.assign(new Error('offline'), { code: 'UNAVAILABLE' });
        await f.beforeRequest?.(command, receipt);
        const old = f.witness;
        const matches = old?.epoch === receipt.epoch && old?.writerGeneration === receipt.writerGeneration && old?.revision === receipt.revision && old?.peerGeneration === f.peerGeneration;
        if (command === 'write') {
            if (receipt.expectedPeerGeneration !== undefined && (receipt.expectedPeerGeneration !== f.peerGeneration || !old
                || old.peerGeneration !== f.peerGeneration || old.epoch !== receipt.epoch || old.writerGeneration !== receipt.writerGeneration || old.revision !== receipt.expectedRevision))
                throw Object.assign(new Error('revoked'), { code: 'STALE_RECEIPT' });
            if (old?.epoch === receipt.epoch && old.revision > receipt.revision) throw Object.assign(new Error('old'), { code: 'STALE_RECEIPT' });
            f.witness = { ...clone(receipt), peerGeneration: f.peerGeneration };
        }
        return { matched: command === 'write' || matches, peerGeneration: f.peerGeneration, ...receipt };
    };
    f.adapter = () => createFavoriteContinuity({ api: f.api, sendRequest: f.sendRequest });
    f.seed = async () => { const a = f.adapter(); await a.load({ session: null, items }); await a.save({ state: state(), items }); return a; };
    f.reload = () => { for (const key of Object.keys(session)) delete session[key]; return f.adapter().load({ session: null, items }); };
    return f;
}

test('Arcify-only reload recovers exact identity with opaque matching session witness and navigated URL', async () => {
    const f = fixture(); await f.seed(); const oldEpoch = f.local[LOCAL].epoch; f.calls.length = 0;
    assert.deepEqual(await f.reload(), state());
    assert.equal(f.calls[0].command, 'read');
    const commit = f.calls.find(call => call.command === 'write');
    assert.equal(commit.receipt.epoch, oldEpoch);
    assert.equal(commit.receipt.expectedPeerGeneration, f.peerGeneration);
    assert.equal(commit.receipt.revision, commit.receipt.expectedRevision + 1);
    assert(f.calls.every(call => !JSON.stringify(call.receipt).includes('https:')));
    assert.equal(f.session[RECEIPT].phase, undefined);
});

test('own matching session is preferred even when companion is unavailable', async () => {
    const f = fixture(); await f.seed(); f.offline = true;
    assert.deepEqual(await f.adapter().load({ session: f.session.favoriteSession, items }), state());
});

for (const condition of ['missing', 'offline', 'stale-revision', 'wrong-epoch', 'peer-reloaded', 'local-schema']) test(`unproven ${condition} candidate fails closed and is never re-enrolled`, async () => {
    const f = fixture(); await f.seed(); const oldEpoch = f.local[LOCAL].epoch;
    if (condition === 'missing' || condition === 'peer-reloaded') f.witness = null;
    if (condition === 'offline') f.offline = true;
    if (condition === 'stale-revision') f.witness.revision++;
    if (condition === 'wrong-epoch') f.witness.epoch = crypto.randomUUID();
    if (condition === 'local-schema') f.local[LOCAL].schema = 'unsupported';
    f.calls.length = 0;
    assert.deepEqual(await f.reload(), empty());
    assert(f.calls.filter(call => call.command === 'write').every(call => call.receipt.epoch !== oldEpoch));
});

test('both sessions lost is a browser restart, never a circular recovery', async () => {
    const f = fixture(); await f.seed(); f.witness = null; f.tabs[0].url = items[0].url;
    assert.deepEqual(await f.reload(), empty());
});

test('Spotlight-only reload followed by valid own-session refresh restores continuity', async () => {
    const f = fixture(); const a = await f.seed(); f.witness = null;
    await a.refresh({ state: state(), items });
    assert.deepEqual(await f.reload(), state());
});

test('offline detach commits local receipt before success and cannot resurrect the old witness', async () => {
    const f = fixture(); const a = await f.seed(); f.offline = true;
    await a.save({ state: empty(), items }); f.offline = false;
    assert.deepEqual(await f.reload(), empty());
});

test('offline pairing revoke and A to B to A invalidates old local epoch atomically', async () => {
    const f = fixture(); await f.seed(); const old = clone(f.local[LOCAL]);
    await configureFavoriteContinuityPeer(f.api, OTHER);
    await configureFavoriteContinuityPeer(f.api, PEER);
    assert.notEqual(old.generation, f.local[GENERATION]);
    f.local[LOCAL] = old; // Even a delayed old writer cannot defeat generation invalidation.
    assert.deepEqual(await f.reload(), empty());
});

test('peer revoke and reconnect between read and recovery commit rejects the stale candidate', async () => {
    const f = fixture(); await f.seed(); const oldEpoch = f.local[LOCAL].epoch;
    f.beforeQuery = () => { f.peerGeneration = crypto.randomUUID(); f.witness = null; };
    f.calls.length = 0;
    assert.deepEqual(await f.reload(), empty());
    const writes = f.calls.filter(call => call.command === 'write');
    assert(writes.some(call => call.receipt.epoch === oldEpoch && call.receipt.expectedPeerGeneration));
    assert(writes.filter(call => !call.receipt.expectedPeerGeneration).every(call => call.receipt.epoch !== oldEpoch));
});

test('pairing change during attestation is rejected before publishing candidate ownership', async () => {
    const f = fixture(); await f.seed(); f.beforeQuery = () => configureFavoriteContinuityPeer(f.api, OTHER);
    await assert.rejects(f.reload(), /pairing changed/);
    assert.equal(f.session.favoriteSession, undefined);
});

for (const boundary of ['invalidate', 'session', 'commit', 'ack']) test(`failure at ${boundary} leaves no recoverable revoked ownership`, async () => {
    const f = fixture(); const a = await f.seed(); let n = 0;
    f.fail = (area, values) => {
        if (area === 'local' && values[LOCAL]?.phase === 'invalid') { if (boundary === 'invalidate') return true; }
        if (area === 'session') return boundary === 'session';
        if (area === 'local' && values[LOCAL]?.phase === 'committed') { n++; return boundary === 'commit' && n === 1 || boundary === 'ack' && n === 2; }
        return false;
    };
    await assert.rejects(a.save({ state: empty(), items }), /persistence failed/);
    // Invalidation failure means the operation never committed or may mutate.
    if (boundary === 'invalidate') assert.deepEqual(f.session.favoriteSession, state());
    else {
        f.fail = null;
        assert.deepEqual(await f.reload(), empty());
    }
});

test('provisional recovery session is never accepted after an interrupted commit', async () => {
    const f = fixture(); await f.seed();
    f.fail = (area, values) => area === 'session' && values[RECEIPT] && !values[RECEIPT].phase;
    await assert.rejects(f.reload(), /persistence failed/);
    assert.equal(f.session[RECEIPT].phase, 'recovering');
    f.fail = null;
    assert.deepEqual(await f.adapter().load({ session: f.session.favoriteSession, items }), empty());
});

for (const mutate of [tab => { tab.windowId = 2; }, tab => { tab.incognito = true; }, tab => { tab.url = 'chrome-extension://' + PEER + '/startup-launcher.html'; }]) test('missed cross-window or private identity cannot be recovered', async () => {
    const f = fixture(); await f.seed(); mutate(f.tabs[0]);
    assert.deepEqual(await f.reload(), empty());
});

test('removed saved identity or changed saved URL never recovers its old binding', async () => {
    const f = fixture(); await f.seed(); for (const key of Object.keys(f.session)) delete f.session[key];
    assert.deepEqual(await f.adapter().load({ session: null, items: [{ ...items[0], url: 'https://changed.test/' }] }), empty());
});

test('malformed and duplicate identities fail strict validation including contradictory cross-kind receipts', () => {
    assert(validContinuityState(state()));
    const matching = state(); matching.attempts.push({ ...matching.bindings[0], url: items[0].url, kind: 'adopt' }); assert(validContinuityState(matching));
    for (const mutate of [s => s.bindings.push({ ...s.bindings[0] }), s => s.bindings.push({ ...s.bindings[0], favoriteId: 'other' }),
        s => s.bindings[0].mode = 'guess', s => s.attempts.push({ ...s.bindings[0], tabId: null, url: items[0].url }),
        s => s.attempts.push({ ...s.bindings[0], tabId: 11, url: items[0].url }), s => s.extra = true]) {
        const value = state(); mutate(value); assert.equal(validContinuityState(value), false);
    }
});

test('unsupported old-code session mutation invalidates own receipt instead of using durable mirror', async () => {
    const f = fixture(); await f.seed(); f.session.favoriteSession.bindings[0].tabId = 20;
    assert.deepEqual(await f.adapter().load({ session: f.session.favoriteSession, items }), empty());
});


test('transient window validation failure preserves the candidate and blocks ownership adoption', async () => {
    const f = fixture(); await f.seed(); const candidate = clone(f.local[LOCAL]);
    const getWindow = f.api.windows.get; f.api.windows.get = async () => { throw new Error('temporary window failure'); };
    await assert.rejects(f.reload(), /temporary window failure/);
    assert.deepEqual(f.local[LOCAL], candidate); assert.equal(f.session.favoriteSession, undefined);
    f.api.windows.get = getWindow; assert.deepEqual(await f.reload(), state());
});

test('current-session handshake after local revoke and reconnect starts a fresh valid epoch', async () => {
    const f = fixture(); const a = await f.seed(); const oldEpoch = f.local[LOCAL].epoch;
    await configureFavoriteContinuityPeer(f.api, ''); await configureFavoriteContinuityPeer(f.api, PEER);
    await a.refresh({ state: state(), items });
    assert.notEqual(f.local[LOCAL].epoch, oldEpoch); assert.deepEqual(await f.reload(), state());
});


test('current-session refresh repairs a lost acknowledgement without trusting the durable mirror', async () => {
    const f = fixture(); const a = await f.seed(); f.local[LOCAL].peerGeneration = null;
    await a.refresh({ state: state(), items });
    assert.equal(f.local[LOCAL].peerGeneration, f.peerGeneration); assert.deepEqual(await f.reload(), state());
});
