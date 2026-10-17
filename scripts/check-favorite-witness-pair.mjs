#!/usr/bin/env node
// Cross-repository mocked transport. No browser, profile or native input access.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { createFavoriteContinuity, configureFavoriteContinuityPeer, CONTINUITY_LOCAL_KEY, CONTINUITY_SESSION_KEY } from '../favorite-continuity.js';
import { PEER_KEY, PAIRING_GENERATION_KEY } from '../spotlight-bridge-protocol.js';
import { sendWitnessRequest, WITNESS_SESSION_KEY } from '../favorite-witness-protocol.js';
if (process.argv.length !== 3) throw new Error('Usage: node scripts/check-favorite-witness-pair.mjs <spotlight-checkout>');
const root = resolve(process.argv[2]);
const { createFavoriteWitness } = await import(pathToFileURL(resolve(root, 'shared/favorite-witness.js')));
assert.equal((await readFile(new URL('../favorite-witness-protocol.js', import.meta.url), 'utf8')).replace('./spotlight-bridge-protocol.js', './arcify-bridge-protocol.js'),
    await readFile(resolve(root, 'shared/favorite-witness-protocol.js'), 'utf8'));
const ARC = 'a'.repeat(32), SPOT = 'b'.repeat(32), OTHER = 'c'.repeat(32);
const copy = value => structuredClone(value);
const area = data => ({ async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, copy(data[key])])); }, async set(values) { Object.assign(data, copy(values)); } });
const aLocal = { [PEER_KEY]: SPOT, [PAIRING_GENERATION_KEY]: crypto.randomUUID() }, aSession = {};
const sLocal = { [PEER_KEY]: ARC, [PAIRING_GENERATION_KEY]: crypto.randomUUID() }, sSession = {};
const spotlightApi = { storage: { local: area(sLocal), session: area(sSession) } };
const witness = createFavoriteWitness(spotlightApi), sent = [];
let beforeQuery;
const api = { storage: { local: area(aLocal), session: area(aSession) },
    tabs: { query: async () => { await beforeQuery?.(); return [{ id: 10, windowId: 1, pinned: false, url: 'https://navigated.test/' }]; } },
    windows: { get: async id => ({ id, type: 'normal', incognito: false }) },
    runtime: { id: ARC, getURL: path => `chrome-extension://${ARC}/${path}`,
        sendMessage(peer, request, callback) { assert.equal(peer, SPOT); sent.push(copy(request)); witness.handle(copy(request), { id: ARC, origin: `chrome-extension://${ARC}` }).then(callback); } } };
const items = [{ id: 'saved', title: 'Page', url: 'https://saved.test/', sourceBookmarkId: null }];
const state = { version: 1, bindings: [{ favoriteId: 'saved', windowId: 1, tabId: 10, mode: 'ordinary' }], attempts: [] };
const empty = { version: 1, bindings: [], attempts: [] };
const adapter = () => createFavoriteContinuity({ api });
const clear = object => { for (const key of Object.keys(object)) delete object[key]; };
let writer = adapter();
await writer.load({ session: null, items }); await writer.save({ state, items });
const epoch = aLocal[CONTINUITY_LOCAL_KEY].epoch;
assert.equal(aLocal[CONTINUITY_LOCAL_KEY].revision, sSession[WITNESS_SESSION_KEY].revision);
clear(aSession); sent.length = 0;
writer = adapter(); assert.deepEqual(await writer.load({ session: null, items }), state);
assert.equal(sent[0].command, 'read'); assert.equal(aLocal[CONTINUITY_LOCAL_KEY].epoch, epoch);
assert(sent.some(request => request.command === 'write' && request.expectedRevision && request.expectedPeerGeneration));
assert.equal(aSession[CONTINUITY_SESSION_KEY].phase, undefined);
// Surviving Arcify may safely re-enroll a reloaded Spotlight.
clear(sSession); await writer.refresh({ state, items });
clear(aSession); writer = adapter(); assert.deepEqual(await writer.load({ session: null, items }), state);
// Remote revoke/reconnect between read and CAS may not rescue the old candidate.
clear(aSession); beforeQuery = async () => { await witness.configure(OTHER); await witness.configure(ARC); };
assert.deepEqual(await adapter().load({ session: null, items }), empty); beforeQuery = null;
// A local revoke while the peer is uncontacted is durable and generation scoped.
writer = adapter(); await writer.load({ session: aSession.favoriteSession, items }); await writer.save({ state, items });
await configureFavoriteContinuityPeer(api, ''); await configureFavoriteContinuityPeer(api, SPOT);
clear(aSession); assert.deepEqual(await adapter().load({ session: null, items }), empty);
// Full restart loses the independently stored witness, even if numeric IDs recur.
writer = adapter(); await writer.load({ session: aSession.favoriteSession, items }); await writer.save({ state, items });
clear(aSession); clear(sSession); assert.deepEqual(await adapter().load({ session: null, items }), empty);
assert(sent.every(request => !JSON.stringify(request).includes('https:')));
assert.deepEqual(Object.keys(sLocal).sort(), [PEER_KEY, PAIRING_GENERATION_KEY].sort());
assert.equal((await witness.handle(sent.at(-1), { id: OTHER })).error.code, 'UNAUTHORIZED');
await assert.rejects(sendWitnessRequest(SPOT, 'read', { epoch: crypto.randomUUID(), writerGeneration: crypto.randomUUID(), revision: 1 },
    { api: { runtime: { sendMessage(peer, request, callback) { callback({ type: request.type, version: 99, requestId: request.requestId, role: 'spotlight', ok: true }); } } } }), { code: 'INVALID_RESPONSE' });
console.log('PASS: actual Arcify continuity adapter ↔ Spotlight witness endpoint through mocked authenticated transport.');
console.log('Verified same-session reload, exact CAS recovery, peer-only reload refresh, remote/local revoke-reconnect races, full-restart fail-closed, strict roles/version and session-only opaque receipt. No browser was launched.');
