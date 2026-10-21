import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { readDeveloperModeDomState, developerModeStateReady, enableDeveloperModeViaUi,
    findInstalledExtension, waitForEnabledExtension } from '../../scripts/paired-chrome-extensions.mjs';

const state = (enabled = false) => ({ url: 'chrome://extensions/',
    manager: { canLoadUnpacked: true, inDevMode: enabled, policy: false, child: false },
    toolbar: { canLoadUnpacked: true, inDevMode: enabled, policy: false, child: false },
    toggle: { checked: enabled, disabled: false, ariaChecked: String(enabled), ariaDisabled: 'false' } });
function harness(states) {
    let time = 0, reads = 0, clicks = 0;
    const records = [];
    return { reads: () => reads, clicks: () => clicks, records,
        callbacks: { read: async () => structuredClone(states[Math.min(reads++, states.length - 1)]),
            click: async () => { clicks++; }, record: async entry => records.push(entry) },
        options: { timeout: 200, interval: 100, now: () => time, sleep: async delay => { time += delay; } } };
}
test('only one UI click enables the approved setting after profile/rendered state converges', async () => {
    const pending = state(); pending.manager.canLoadUnpacked = false; pending.toolbar.canLoadUnpacked = undefined;
    const h = harness([pending, state(), state(), state(true)]);
    const result = await enableDeveloperModeViaUi(h.callbacks, h.options);
    assert.equal(result.clicked, true); assert.equal(h.clicks(), 1); assert(result.state.manager.inDevMode);
    assert.equal(h.records[0].phase, 'before-click');
});
test('already enabled, unmanaged state is verified without toggling it off', async () => {
    const h = harness([state(true)]);
    assert.equal((await enableDeveloperModeViaUi(h.callbacks, h.options)).clicked, false);
    assert.equal(h.clicks(), 0);
});
for (const [label, modify] of [
    ['wrong URL', s => { s.url = 'chrome-error://chromewebdata/'; }],
    ['manager policy', s => { s.manager.policy = true; }],
    ['toolbar policy', s => { s.toolbar.policy = true; }],
    ['manager child restriction', s => { s.manager.child = true; }],
    ['toolbar child restriction', s => { s.toolbar.child = true; }],
    ['disabled toggle', s => { s.toggle.disabled = true; }],
    ['ARIA disabled toggle', s => { s.toggle.ariaDisabled = 'true'; }]
]) {
    test(`${label} is a hard stop even if Developer mode is already checked`, async () => {
        const blocked = state(true); modify(blocked); const h = harness([blocked]);
        await assert.rejects(enableDeveloperModeViaUi(h.callbacks, h.options));
        assert.equal(h.clicks(), 0); assert.equal(h.reads(), 1);
    });
}
for (const [label, modify] of [
    ['uninitialized manager permission', s => { s.manager.canLoadUnpacked = false; }],
    ['uninitialized toolbar permission', s => { s.toolbar.canLoadUnpacked = undefined; }],
    ['missing manager', s => { s.manager = null; }],
    ['unknown policy', s => { s.manager.policy = undefined; }],
    ['inconsistent toolbar', s => { s.toolbar.inDevMode = true; }],
    ['missing ARIA state', s => { s.toggle.ariaChecked = null; }]
]) {
    test(`${label} cannot be mistaken for a ready unmanaged control`, async () => {
        const pending = state(); modify(pending); const h = harness([pending]);
        await assert.rejects(enableDeveloperModeViaUi(h.callbacks, h.options), /did not reach/);
        assert.equal(h.clicks(), 0);
    });
}
test('optimistic checked toggle alone is insufficient; there is no second click on timeout', async () => {
    const optimistic = state(); optimistic.toggle.checked = true; optimistic.toggle.ariaChecked = 'true';
    const h = harness([state(), state(), optimistic]);
    await assert.rejects(enableDeveloperModeViaUi(h.callbacks, h.options), /after-click/);
    assert.equal(h.clicks(), 1);
});
test('a policy change just before input prevents any click', async () => {
    const blocked = state(); blocked.manager.policy = true;
    const h = harness([state(), blocked]);
    await assert.rejects(enableDeveloperModeViaUi(h.callbacks, h.options), /policy-controlled/);
    assert.equal(h.clicks(), 0);
});
test('a post-click restriction fails without another click or workaround', async () => {
    const blocked = state(true); blocked.toolbar.policy = true;
    const h = harness([state(), state(), blocked]);
    await assert.rejects(enableDeveloperModeViaUi(h.callbacks, h.options), /policy-controlled/);
    assert.equal(h.clicks(), 1);
});
test('UI click failure is preserved and never retried', async () => {
    const h = harness([state()]); let clicks = 0;
    h.callbacks.click = async () => { clicks++; throw new Error('input denied'); };
    await assert.rejects(enableDeveloperModeViaUi(h.callbacks, h.options), /input denied/);
    assert.equal(clicks, 1); assert.equal(h.reads(), 2);
});
test('actual DOM reader traverses the Chrome toolbar shadow roots without changing fields', () => {
    const { document } = parseHTML('<html><body><extensions-manager></extensions-manager></body></html>');
    const manager = document.querySelector('extensions-manager');
    const root = manager.attachShadow({ mode: 'open' }); root.innerHTML = '<extensions-toolbar></extensions-toolbar>';
    const toolbar = root.querySelector('extensions-toolbar');
    const toolbarRoot = toolbar.attachShadow({ mode: 'open' }); toolbarRoot.innerHTML = '<cr-toggle id="devMode" aria-checked="false" aria-disabled="false"></cr-toggle>';
    const toggle = toolbarRoot.querySelector('#devMode');
    Object.assign(manager, { canLoadUnpacked: true, inDevMode: false, devModeControlledByPolicy: false, isChildAccount_: false });
    Object.assign(toolbar, { canLoadUnpacked: true, inDevMode: false, devModeControlledByPolicy: false, isChildAccount: false });
    Object.assign(toggle, { checked: false, disabled: false });
    const oldDocument = globalThis.document, oldLocation = globalThis.location;
    try {
        globalThis.document = document; globalThis.location = { href: 'chrome://extensions/' };
        const actual = readDeveloperModeDomState(); assert.deepEqual(actual, state());
        assert(developerModeStateReady(actual)); assert.equal(toggle.checked, false);
        manager.remove(); assert.equal(readDeveloperModeDomState().manager, null);
    } finally {
        if (oldDocument === undefined) delete globalThis.document; else globalThis.document = oldDocument;
        if (oldLocation === undefined) delete globalThis.location; else globalThis.location = oldLocation;
    }
});

const expected = { id: 'a'.repeat(32), name: 'Arcify', version: '5.1.0', path: '/fixture/arcify/dist' };
const installed = { ...expected, enabled: true };
test('registry validates exact ID, source path, name, version and explicit enabled status', () => {
    assert.deepEqual(findInstalledExtension([installed], expected), installed);
    assert.equal(findInstalledExtension([], expected, { allowMissing: true }), null);
    assert.throws(() => findInstalledExtension([], expected));
    assert.throws(() => findInstalledExtension([installed, installed], expected));
    for (const field of ['name', 'version', 'path']) {
        assert.throws(() => findInstalledExtension([{ ...installed, [field]: 'changed' }], expected), /unchanged/);
    }
    assert.throws(() => findInstalledExtension([{ ...installed, enabled: 'true' }], expected), /explicitly/);
    assert.throws(() => findInstalledExtension(null, expected), /real installed extension registry/);
});
test('read-only reload readiness records missing/disabled states before accepting enabled identity', async () => {
    let time = 0, reads = 0; const observations = [], values = [[], [{ ...installed, enabled: false }], [installed]];
    const result = await waitForEnabledExtension(async () => values[Math.min(reads++, 2)], expected,
        async value => observations.push(value), { timeout: 300, interval: 100, now: () => time, sleep: async ms => { time += ms; } });
    assert.deepEqual(result, installed); assert.deepEqual(observations, values); assert.equal(reads, 3);
});
test('persistent disabled state fails instead of reinstalling, enabling or navigating', async () => {
    let time = 0; const records = [];
    await assert.rejects(waitForEnabledExtension(async () => [{ ...installed, enabled: false }], expected,
        async value => records.push(value), { timeout: 200, interval: 100, now: () => time, sleep: async ms => { time += ms; } }), /without a policy workaround/);
    assert.equal(records.length, 2);
});
test('registry transport error and identity mismatch fail immediately without retries', async () => {
    let calls = 0;
    await assert.rejects(waitForEnabledExtension(async () => { calls++; throw new Error('method denied'); }, expected, async () => {}), /method denied/);
    assert.equal(calls, 1); calls = 0;
    await assert.rejects(waitForEnabledExtension(async () => { calls++; return [{ ...installed, path: '/other' }]; }, expected, async () => {}), /path must remain unchanged/);
    assert.equal(calls, 1);
});
