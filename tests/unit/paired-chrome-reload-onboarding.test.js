import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readReloadOnboardingState, waitForExpectedReloadOnboarding } from '../../scripts/paired-chrome-reload-onboarding.mjs';
import { performVisibleClick } from '../../scripts/paired-chrome-ui.mjs';

const id = 'a'.repeat(32), otherId = 'b'.repeat(32), windowId = 42;
const optionsUrl = `chrome-extension://${id}/options.html`, url = `chrome-extension://${id}/installation-onboarding.html`;
const tab = (id, url, overrides = {}) => ({ id, windowId, url, status: 'complete', pinned: false, incognito: false, ...overrides });
const identity = ({ id, windowId, url, pinned, incognito }) => ({ id, windowId, url, pinned, incognito });
function state(sourceId, tabs = [], onboardingVersion) {
    const source = tab(sourceId, optionsUrl);
    return { extensionId: id, version: '5.1.0', onboardingVersion,
        source: { extensionId: id, documentUrl: optionsUrl, tab: identity(source) }, tabs: [source, ...tabs] };
}
function harness({ before = state(1), states = [state(2, [tab(3, url)])], mutateDocument } = {}) {
    let reads = 0, documents = 0, polls = 0;
    const readState = async () => structuredClone(states[Math.min(reads++, states.length - 1)]);
    const readDocument = async candidate => {
        documents++;
        const document = { extensionId: id, documentUrl: url, readyState: 'complete', tab: identity(candidate) };
        mutateDocument?.(document); return document;
    };
    const poll = async (read, accept, label) => {
        polls++;
        for (let n = 0; n < 5; n++) { const value = await read(); if (accept(value)) return value; }
        throw new Error(`Timed out waiting for ${label}`);
    };
    return { run: () => waitForExpectedReloadOnboarding({ before, extensionId: id, readState, readDocument, poll }),
        counts: () => ({ reads, documents, polls }) };
}

test('delayed onboarding is observed through complete exact new native identity before reconnect', async () => {
    const h = harness({ states: [state(2), state(2, [tab(3, url, { status: 'loading' })]), state(2, [tab(3, url)])] });
    const proof = await h.run();
    assert.equal(proof.expected, true); assert.equal(proof.controlWindowId, windowId);
    assert.equal(proof.document.tab.id, 3); assert.equal(proof.document.documentUrl, url);
    assert.deepEqual(h.counts(), { reads: 4, documents: 1, polls: 1 });
});

test('acknowledged actual version does not wait for or manufacture onboarding', async () => {
    const h = harness({ before: state(1, [], '5.1.0'), states: [state(2, [], '5.1.0')] });
    assert.equal((await h.run()).expected, false);
    assert.deepEqual(h.counts(), { reads: 1, documents: 0, polls: 0 });
});

for (const [name, candidate] of [
    ['missing expected onboarding', []],
    ['different extension onboarding', [tab(3, `chrome-extension://${otherId}/installation-onboarding.html`)]],
    ['query-string impostor', [tab(3, `${url}?fixture=true`)]],
    ['not fully loaded', [tab(3, url, { status: 'loading' })]]
]) test(`${name} cannot release the barrier`, async () => {
    const h = harness({ states: [state(2, candidate)] });
    await assert.rejects(h.run(), /Timed out waiting/); assert.equal(h.counts().documents, 0);
});

for (const [name, candidates, pattern] of [
    ['duplicate exact endpoint', [tab(3, url), tab(4, url)], /unique/],
    ['wrong window', [tab(3, url, { windowId: 99 })], /known control window/],
    ['pinned onboarding', [tab(3, url, { pinned: true })], /strictly equal/],
    ['incognito onboarding', [tab(3, url, { incognito: true })], /strictly equal/],
    ['onboarding navigating elsewhere', [tab(3, url, { pendingUrl: 'https://example.invalid/' })], /navigating elsewhere/]
]) test(`${name} fails instead of being polled away`, async () => {
    const h = harness({ states: [state(2, candidates)] });
    await assert.rejects(h.run(), pattern); assert.equal(h.counts().reads, 1);
});

test('preexisting onboarding is not evidence of a new reload document', async () => {
    const h = harness({ before: state(1, [tab(3, url)]), states: [state(2, [tab(3, url)])] });
    await assert.rejects(h.run(), /Timed out waiting/);
});
test('unexpected onboarding with acknowledged gate fails', async () => {
    const h = harness({ before: state(1, [], '5.1.0'), states: [state(2, [tab(3, url)], '5.1.0')] });
    await assert.rejects(h.run(), /cannot create new onboarding/);
});
test('version gate mutation and stale options cannot qualify', async () => {
    await assert.rejects(harness({ states: [state(2, [tab(3, url)], '5.1.0')] }).run(), /cannot change the onboarding version gate/);
    await assert.rejects(harness({ states: [state(1, [tab(3, url)])] }).run(), /fresh native identity/);
    const changed = state(2, [tab(3, url)]); changed.version = '5.2.0';
    await assert.rejects(harness({ states: [changed] }).run(), /preserve the manifest version/);
});
for (const [name, mutate] of [
    ['wrong extension realm', doc => { doc.extensionId = otherId; }],
    ['wrong document path', doc => { doc.documentUrl += '?unexpected'; }],
    ['wrong native identity', doc => { doc.tab.id = 999; }],
    ['wrong realm window', doc => { doc.tab.windowId = 99; }],
    ['incomplete document', doc => { doc.readyState = 'interactive'; }]
]) test(`${name} cannot substitute for the observed onboarding`, async () => {
    await assert.rejects(harness({ mutateDocument: mutate }).run());
});
test('onboarding disappearing or becoming duplicate during realm observation fails', async () => {
    await assert.rejects(harness({ states: [state(2, [tab(3, url)]), state(2)] }).run(), /remain present/);
    await assert.rejects(harness({ states: [state(2, [tab(3, url)]), state(2, [tab(3, url), tab(4, url)])] }).run(), /unique/);
});

test('actual gate probe only reads sync and captures direct exact options provenance', async () => {
    const oldChrome = globalThis.chrome, oldLocation = globalThis.location, calls = [];
    globalThis.location = { href: optionsUrl };
    globalThis.chrome = { runtime: { id, getManifest: () => ({ version: '5.1.0' }) },
        tabs: { getCurrent: async () => tab(1, optionsUrl), query: async () => [tab(1, optionsUrl)] },
        storage: { sync: { get: async key => { calls.push(key); return { onboardingVersion: '5.0.0' }; } } } };
    try {
        const result = await readReloadOnboardingState();
        assert.deepEqual(calls, ['onboardingVersion']); assert.equal(result.onboardingVersion, '5.0.0');
        assert.equal(result.source.tab.windowId, windowId); assert.equal(result.version, '5.1.0');
    } finally { globalThis.chrome = oldChrome; globalThis.location = oldLocation; }
});

for (const failure of ['visibility', 'uncertain-click']) test(`successful onboarding barrier does not hide or retry ${failure} failure`, async () => {
    await harness().run();
    let clicks = 0, focuses = 0, selectors = 0;
    const error = new Error(failure);
    const page = { url: () => optionsUrl, bringToFront: async () => { focuses++; },
        waitForFunction: async () => { if (failure === 'visibility') throw error; },
        evaluate: async () => ({ visibility: 'visible', hasFocus: true }),
        waitForSelector: async () => { selectors++; }, click: async () => { clicks++; throw error; } };
    await assert.rejects(performVisibleClick(page, '#refresh-connection', async () => {}, '#refresh-connection:not([disabled])'), candidate => candidate === error);
    assert.equal(focuses, 1); assert.equal(clicks, failure === 'visibility' ? 0 : 1);
    assert.equal(selectors, failure === 'visibility' ? 0 : 1);
});

test('real reload wiring places the read-only barrier before unchanged visible peer reconnect', () => {
    const source = readFileSync(new URL('../../scripts/paired-chrome-smoke.mjs', import.meta.url), 'utf8');
    const start = source.indexOf('async function reloadPairedExtension('), end = source.indexOf('\nawait mkdir(OUTPUT', start);
    const reload = source.slice(start, end);
    assert(reload.indexOf('await page.evaluate(readReloadOnboardingState)') < reload.indexOf('await reloadObservedExtension('));
    assert(reload.indexOf('await waitForExpectedReloadOnboarding(') < reload.indexOf("await clickUI(spotlightOptions, '#refresh-connection'"));
    assert.equal((reload.match(/await clickUI\(spotlightOptions, '#refresh-connection'/g) || []).length, 1);
    assert(reload.includes("'#refresh-connection:not([disabled])'"));
});
