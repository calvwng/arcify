#!/usr/bin/env node
/** Checker regressions use actual modules, replacing one export only to prove drift fails. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as arcify from '../spotlight-bridge-protocol.js';
import { assertCommonV1Contract, assertInitialSpaceActionsContract } from './lib/spotlight-pair-contract.mjs';

if (process.argv.length !== 3) throw new Error('Usage: node scripts/test-spotlight-pair-contract.mjs <spotlight-checkout>');
const peerModule = path => import(pathToFileURL(resolve(process.argv[2], path)).href);
const spotlight = await peerModule('shared/arcify-bridge-protocol.js');
const actions = await peerModule('shared/arcify-space-actions-protocol.js');

test('actual pair passes despite intentionally different optional-action module layouts', async () => {
    const sentinel = { contractTest: true }, previous = globalThis.chrome;
    globalThis.chrome = sentinel;
    try {
        await assertCommonV1Contract(arcify, spotlight);
        assert.equal(globalThis.chrome, sentinel, 'Transport checks restore caller Chrome mock');
        assertInitialSpaceActionsContract(arcify, actions);
    } finally { if (previous === undefined) delete globalThis.chrome; else globalThis.chrome = previous; }
});

const commonMutations = [
    ['version', { BRIDGE_VERSION: 2 }], ['type', { BRIDGE_TYPE: 'other' }], ['peer key', { PEER_KEY: 'other' }],
    ['pairing key', { PAIRING_GENERATION_KEY: 'other' }], ['feature marker constant', { GLOBAL_FAVORITES_FEATURE: 'other' }],
    ['missing export', { validateRequest: undefined }], ['window sentinel accepted', { isWindowId: value => value === 0 || spotlight.isWindowId(value) }],
    ['unsafe URL accepted', { isSafeUrl: () => true }], ['Favorite URL broadened', { isFavoriteUrl: spotlight.isSafeUrl }],
    ['valid request rejected', { validateRequest: () => { throw Object.assign(new Error('drift'), { code: 'INVALID_REQUEST' }); } }],
    ['malformed requests accepted', { validateRequest: message => message }],
    ['surplus fields accepted', { validateRequest: (message, commands) => message?.unexpected ? message : spotlight.validateRequest(message, commands) }],
    ['window request accepted', { validateRequest: (message, commands) => message?.windowId === 0 ? message : spotlight.validateRequest(message, commands) }],
    ['invalid request marker accepted', { validateRequest: (message, commands) => message?.supportedFeatures?.[0] === 'unknown' ? message : spotlight.validateRequest(message, commands) }],
    ['response role changed', { responseFor: (...args) => ({ ...spotlight.responseFor(...args), role: 'wrong' }) }],
    ['uncorrelated responses accepted', { sendBridgeRequest: async () => ({ ok: true }) }]
];
for (const [label, replacement] of commonMutations) test(`common contract detects ${label}`, async () => {
    await assert.rejects(assertCommonV1Contract(arcify, { ...spotlight, ...replacement }));
});

test('common checks reject provider-side drift as well as peer-side drift', async () => {
    await assert.rejects(assertCommonV1Contract({ ...arcify, BRIDGE_VERSION: 2 }, spotlight));
});

const actionMutations = [
    ['feature marker', { SPACE_ACTIONS_FEATURE: 'other' }], ['command list', { SPACE_ACTION_COMMANDS: ['openSettings'] }],
    ['valid context rejected', { validateActionContext: () => { throw new Error('drift'); } }],
    ['malformed context accepted', { validateActionContext: context => context }],
    ['context identity ignored', { sameActionContext: () => true }],
    ['valid payload rejected', { validateActionPayload: () => { throw new Error('drift'); } }],
    ['extra/unconfirmed payload accepted', { validateActionPayload: (command, payload) => payload }],
    ['result identity ignored', { validateActionResult: (command, result) => result }]
];
for (const [label, replacement] of actionMutations) test(`initial action contract detects ${label}`, () => {
    assert.throws(() => assertInitialSpaceActionsContract(arcify, { ...actions, ...replacement }));
});
test('initial action checks detect provider-side context and command drift', () => {
    assert.throws(() => assertInitialSpaceActionsContract({ ...arcify, isSpaceActionContext: () => true }, actions));
    assert.throws(() => assertInitialSpaceActionsContract({ ...arcify, SPACE_ACTION_COMMANDS: ['openSettings'] }, actions));
});
