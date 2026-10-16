import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { collectSpotlightHelperOrigin } from '../../scripts/paired-chrome-helper-origin.mjs';
import { readNewTabReuseState } from '../../scripts/paired-chrome-newtab.mjs';

const SELF = 'b'.repeat(32), renderer = `chrome-extension://${SELF}/newtab.html`;
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
function fixture(contextAction) {
    return { state: { url: renderer, timeOrigin: 100, tab: { id: 77, windowId: 7, active: true, status: 'complete', url: 'chrome://newtab/', pendingUrl: null }, visibility: 'visible' },
        events: [{ type: 'internal', data: { message: { action: contextAction, tabId: 77 }, sender: { id: SELF, url: renderer, frameId: 0, documentLifecycle: 'active', tab: { id: 77, windowId: 7 } } } }] };
}
function block(kind) {
    const path = kind === 'navigation' ? 'paired-chrome-spotlight-navigation.mjs' : 'paired-chrome-spotlight-tabs.mjs';
    const source = readFileSync(new URL(`../../scripts/${path}`, import.meta.url), 'utf8');
    const start = source.indexOf(kind === 'navigation' ? '            const helperState = await helper.page.evaluate(readNewTabReuseState);' : '            const state = await aliasHelper.page.evaluate(readNewTabReuseState);');
    assert(start > 0, 'Execute the actual hosted call site, never an inline substitute.');
    const end = kind === 'navigation' ? source.indexOf('            const before = await read(); await reset();', start) : source.indexOf('\n        }\n        await overlay(', start);
    assert(end > start);
    const body = source.slice(start, end);
    assert(body.includes('collectSpotlightHelperOrigin(')); assert(!body.includes('assertSpotlightHelperProof('));
    return new AsyncFunction('helper', 'aliasHelper', 'readNewTabReuseState', 'trace', 'observed', 'collectSpotlightHelperOrigin', 'poll', 'spotlightId', 'windowId', 'requestedUrl', 'checkpoint', 'capture', `{\n${body}\n}`);
}
async function run(kind, value) {
    const records = [], helper = { tab: { id: 77 }, page: { async evaluate(fn) { assert.equal(fn, readNewTabReuseState); return structuredClone(value.state); } } };
    const eventSnapshots = value.eventSnapshots || [value.events]; let reads = 0;
    const readTrace = async () => { value.readCount = ++reads; return { peerEvents: structuredClone(eventSnapshots[Math.min(reads - 1, eventSnapshots.length - 1)]) }; };
    const poll = async (read, accept, label) => {
        for (let attempt = 0; attempt < eventSnapshots.length; attempt++) { const snapshot = await read(); if (accept(snapshot)) return snapshot; }
        assert.fail(`Bounded evidence read remained incomplete: ${label}`);
    };
    await block(kind)(helper, helper, readNewTabReuseState, readTrace, readTrace, collectSpotlightHelperOrigin, poll, SELF, 7, 'chrome://newtab/', async (label, evidence) => { records.push({ label, evidence }); }, async () => ({ filename: 'helper.png' }));
    assert.equal(records.length, 1); assert(records[0].evidence.origin); return records[0];
}
for (const [kind, contextAction] of [['navigation', 'arcifySpaceActionsContext'], ['tabs', 'arcifyTabActionsContext']]) {
    test(`${kind} actual helper call site executes the strict origin implementation`, async () => {
        const value = fixture(contextAction), record = await run(kind, value);
        assert(record.evidence.origin); assert.equal(record.evidence.origin.tabId, 77);
    });
    for (const [name, change] of Object.entries({
        missingRequest: f => f.events = [], wrongReadAction: f => f.events[0].data.message.action = 'unrelatedContext',
        wrongRequestSource: f => f.events[0].data.message.tabId = 88, missingRequestSource: f => delete f.events[0].data.message.tabId,
        wrongSenderSource: f => f.events[0].data.sender.tab.id = 88, wrongSenderWindow: f => f.events[0].data.sender.tab.windowId = 8,
        absentSenderWithoutNonce: f => delete f.events[0].data.sender.tab, wrongFrame: f => f.events[0].data.sender.frameId = 2,
        missingFrame: f => delete f.events[0].data.sender.frameId, wrongLifecycle: f => f.events[0].data.sender.documentLifecycle = 'cached',
        otherRenderer: f => f.events[0].data.sender.url = `chrome-extension://${SELF}/options.html`, wrongStateSource: f => f.state.tab.id = 88,
        wrongStateWindow: f => f.state.tab.windowId = 8, pendingNavigation: f => f.state.tab.pendingUrl = 'https://other.test/',
        missingStateSource: f => delete f.state.tab.id, loadingSource: f => f.state.tab.status = 'loading'
    })) test(`${kind} actual origin call rejects ${name}`, async () => { const value = fixture(contextAction); change(value); await assert.rejects(run(kind, value), { code: 'ERR_ASSERTION' }); });
    test(`${kind} actual helper call accepts complete source-bound nonce fallback`, async () => {
        const value = fixture(contextAction), nonce = '00000000-0000-0000-0000-000000000001';
        value.events[0].data.sender.tab = null;
        value.events.push({ type: 'internal', data: { message: { action: 'spotlightNewTabReuseProbe', nonce, tabId: 77, windowId: 7 }, sender: { id: SELF, url: `chrome-extension://${SELF}/background.js`, tab: null, frameId: null, documentLifecycle: null } } },
            { type: 'internal', data: { message: { action: 'spotlightNewTabReuseAck', nonce, tabId: 77, windowId: 7 }, sender: { id: SELF, url: renderer, frameId: 0, documentLifecycle: 'active', tab: null } } });
        await run(kind, value);
        value.events[2].data.message.windowId = 8; await assert.rejects(run(kind, value), { code: 'ERR_ASSERTION' });
    });
}

for (const [kind, contextAction] of [['navigation', 'arcifySpaceActionsContext'], ['tabs', 'arcifyTabActionsContext']]) {
    const otherNonce = '00000000-0000-0000-0000-000000000002';
    const unrelated = () => [
        { type: 'internal', data: { message: { action: contextAction, tabId: 88 }, sender: { id: SELF, url: renderer, frameId: 0, documentLifecycle: 'active', tab: { id: 88, windowId: 8 } } } },
        { type: 'internal', data: { message: { action: 'spotlightNewTabReuseProbe', nonce: otherNonce, tabId: 88, windowId: 8 }, sender: { id: SELF, url: `chrome-extension://${SELF}/background.js`, tab: null, frameId: null, documentLifecycle: null } } },
        { type: 'internal', data: { message: { action: 'spotlightNewTabReuseAck', nonce: otherNonce, tabId: 88, windowId: 8 }, sender: { id: SELF, url: renderer, frameId: 0, documentLifecycle: 'active', tab: { id: 88, windowId: 8 } } } }
    ];
    test(`${kind} actual call site excludes a complete unrelated helper challenge`, async () => {
        const value = fixture(contextAction); value.events.push(...unrelated());
        const record = await run(kind, value); assert.deepEqual(record.evidence.origin.nonces, []);
    });
    test(`${kind} actual call site cannot borrow another helper's nonce fallback`, async () => {
        const value = fixture(contextAction); value.events[0].data.sender.tab = null; value.events.push(...unrelated());
        await assert.rejects(run(kind, value), { code: 'ERR_ASSERTION' });
    });
    test(`${kind} actual call site rejects wrong-source ACK even when it names an expected-source nonce`, async () => {
        const value = fixture(contextAction); value.events[0].data.sender.tab = null;
        const [, probe, ack] = unrelated(); probe.data.message.tabId = 77; probe.data.message.windowId = 7;
        value.events.push(probe, ack); await assert.rejects(run(kind, value), { code: 'ERR_ASSERTION' });
    });
}

for (const [kind, contextAction] of [['navigation', 'arcifySpaceActionsContext'], ['tabs', 'arcifyTabActionsContext']]) {
    test(`${kind} actual call site waits read-only for a pending unrelated ACK`, async () => {
        const value = fixture(contextAction), nonce = '00000000-0000-0000-0000-000000000003';
        const probe = { type: 'internal', data: { message: { action: 'spotlightNewTabReuseProbe', nonce, tabId: 88, windowId: 8 }, sender: { id: SELF, url: `chrome-extension://${SELF}/background.js`, tab: null, frameId: null, documentLifecycle: null } } };
        const ack = { type: 'internal', data: { message: { action: 'spotlightNewTabReuseAck', nonce, tabId: 88, windowId: 8 }, sender: { id: SELF, url: renderer, frameId: 0, documentLifecycle: 'active', tab: { id: 88, windowId: 8 } } } };
        value.eventSnapshots = [[...value.events, probe], [...value.events, probe, ack]];
        const record = await run(kind, value); assert.equal(value.readCount, 2);
        assert.deepEqual(record.evidence.origin.nonces, []); assert.equal(record.evidence.origin.unrelatedNoncePairCount, 1);
    });
    test(`${kind} actual call site rejects malformed evidence immediately instead of waiting for a valid suffix`, async () => {
        const value = fixture(contextAction), malformed = structuredClone(value.events); malformed[0].data.sender.frameId = 1;
        value.eventSnapshots = [malformed, [...malformed, ...value.events]];
        await assert.rejects(run(kind, value), { code: 'ERR_ASSERTION' }); assert.equal(value.readCount, 1);
    });
}
