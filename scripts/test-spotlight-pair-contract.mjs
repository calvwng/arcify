#!/usr/bin/env node
/** Checker regressions use actual modules, replacing one export only to prove drift fails. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as arcify from '../spotlight-bridge-protocol.js';
import { assertExtendedActionsContract } from './lib/spotlight-pair-extended-contract.mjs';
import { assertCommonV1Contract, assertInitialSpaceActionsContract } from './lib/spotlight-pair-contract.mjs';

if (process.argv.length !== 3) throw new Error('Usage: node scripts/test-spotlight-pair-contract.mjs <spotlight-checkout>');
const peerModule = path => import(pathToFileURL(resolve(process.argv[2], path)).href);
const spotlight = await peerModule('shared/arcify-bridge-protocol.js');
const actions = await peerModule('shared/arcify-space-actions-protocol.js');
const tabActions = await peerModule('shared/arcify-tab-actions-protocol.js');

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


test('additive extended contract passes the actual integrated pair', () => {
    assertExtendedActionsContract(arcify, actions, tabActions);
});
for (const [label, replacement] of [
    ['navigation marker', { SPACE_NAVIGATION_FEATURE: 'other' }],
    ['navigation commands', { SPACE_NAVIGATION_COMMANDS: ['switchSpace'] }],
    ['destination context ignored', { validateNavigationContext: value => value }],
    ['navigation payload broadened', { validateActionPayload: (command, payload) => payload }],
    ['navigation result identity ignored', { validateActionResult: (command, result) => result }]
]) test(`extended contract detects ${label}`, () => {
    assert.throws(() => assertExtendedActionsContract(arcify, { ...actions, ...replacement }, tabActions));
});
for (const [label, replacement] of [
    ['tab marker', { TAB_ACTIONS_FEATURE: 'other' }], ['tab commands', { TAB_ACTION_COMMANDS: ['copyCurrentLink'] }],
    ['tab context broadened', { validateTabActionContext: context => context }],
    ['tab payload broadened', { validateTabActionPayload: (command, payload) => payload }],
    ['tab result identity ignored', { validateTabActionResult: (command, result) => result }],
    ['URL normalization changed', { normalizeTabActionUrl: value => value }]
]) test(`extended contract detects ${label}`, () => {
    assert.throws(() => assertExtendedActionsContract(arcify, actions, { ...tabActions, ...replacement }));
});
for (const [label, replacement] of [
    ['provider tab context broadened', { isTabActionContext: () => true }],
    ['provider payload broadened', { validateRequest: message => message }],
    ['provider URL normalization changed', { normalizeTabActionUrl: value => value }],
    ['provider navigation commands changed', { SPACE_NAVIGATION_COMMANDS: ['switchSpace'] }],
    ['provider tab commands changed', { TAB_ACTION_COMMANDS: ['copyCurrentLink'] }]
]) test(`extended contract detects ${label}`, () => {
    assert.throws(() => assertExtendedActionsContract({ ...arcify, ...replacement }, actions, tabActions));
});

for (const command of ['copyCurrentLink', 'setCurrentTabMuted']) test(`extended contract requires saved-pin ${command} on both sides`, () => {
    const rejectSaved = context => {
        if (context?.tab?.section === 'saved') throw Object.assign(new Error('saved command drift'), { code: 'INVALID_REQUEST' });
    };
    assert.throws(() => assertExtendedActionsContract(arcify, actions, { ...tabActions, validateTabActionPayload(actual, payload) {
        if (actual === command) rejectSaved(payload.context);
        return tabActions.validateTabActionPayload(actual, payload);
    } }));
    assert.throws(() => assertExtendedActionsContract({ ...arcify, validateRequest(message, commands) {
        if (message.command === command) rejectSaved(message.context);
        return arcify.validateRequest(message, commands);
    } }, actions, tabActions));
});
