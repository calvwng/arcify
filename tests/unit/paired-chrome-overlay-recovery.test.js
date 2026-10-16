import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { overlayRecoveryFixtureResponse, assertOverlayRecoveryEnvironment, assertRecoveryManifest,
    assertRecoverySourceUnchanged, assertRecoveryReload, installOverlayRecoveryTrace, readOverlayRecoveryTrace, stopOverlayRecoveryTrace,
    assertRecoveryTrace, assertRecoveredOverlay, assertLegacyOverlayPreserved, assertRecoveryNativeTabs,
    assertOneRecoveryReceiver, assertRecoveryTrustedTyping, assertUncertainRecoveryTrace, assertRecoveryWorkerStopped, assertRecoveryWindowsUnchanged, assertColdRecoveryWake, recordOverlayRecoveryFailure } from '../../scripts/paired-chrome-overlay-recovery.mjs';
const id = 'a'.repeat(32), nonce = 'b'.repeat(32), url = `http://localhost:1234/overlay-recovery-host?nonce=${nonce}`;
const source = { id: 12, windowId: 3, url, active: true, incognito: false, pinned: false, index: 0, groupId: 5 };
const manifest = { permissions: ['activeTab', 'scripting'], commands: { toggleSpotlightNewTab: { suggested_key: { default: 'Alt+T' } } } };
const snapshot = () => ({ tab: { ...source }, host: { url, nonce, hostDraft: 'unsaved text', title: `Recovery ${nonce}`, timeOrigin: 123456,
    ready: true, hostDocumentSame: true, hostInputSame: true } });
const opened = () => ({ hostCount: 1, frameCount: 1, open: true, owner: id,
    draft: { value: 'w unsaved overlay', start: 2, end: 5, direction: 'forward' }, oldHostConnected: false, sameHost: false });
const trace = () => ({ instrumentation: 'passive original-delegating API taps', commands: [{ command: 'toggleSpotlightNewTab', tab: { id: 12, windowId: 3, url } }],
    injections: [{ args: [{ target: { tabId: 12, frameIds: [0] }, world: 'ISOLATED', files: ['overlay.js'], injectImmediately: true }], status: 'fulfilled', value: [{ frameId: 0, documentId: 'real-document' }] }],
    messages: [
        { args: [12, { action: 'activateSpotlight', ensureOpen: false, mode: 'new-tab', tabUrl: url, expectedUrl: url, tabId: 12 }, { frameId: 0 }], status: 'rejected', error: 'Could not establish connection. Receiving end does not exist.' },
        { args: [12, { action: 'activateSpotlight', mode: 'new-tab', tabUrl: url, tabId: 12, ensureOpen: true, recovery: true, recoveryRequestId: 'uuid', expectedUrl: url }, { documentId: 'real-document' }], status: 'fulfilled', value: { success: true, open: true } }
    ], creations: [] });
const lifecycle = () => ({ name: 'spotlight', view: { closed: false, invalidations: [{ executionContextId: 55 }] },
    observations: [{ phase: 'before-reload', target: { type: 'service_worker', url: `chrome-extension://${id}/background.js`, targetId: 'old' } },
        { phase: 'reload-observed', oldTargetId: 'old', targets: [], viewInvalidated: true }],
    replacement: { type: 'service_worker', url: `chrome-extension://${id}/background.js`, targetId: 'new' },
    identity: { id, globalType: 'ServiceWorkerGlobalScope', manifest } });

test('fixture route requires nonce and does not serve arbitrary paths', () => {
    const response = overlayRecoveryFixtureResponse(url); assert.match(response.body, new RegExp(nonce)); assert.match(response.body, /id="host-draft"/);
    assert.match(response.csp, /frame-src 'none'/); assert.match(overlayRecoveryFixtureResponse('/overlay-recovery-host.js').body, /isTrusted/);
    assert.equal(overlayRecoveryFixtureResponse('/unrelated'), null);
    for (const bad of ['', 'short', '<script>']) assert.throws(() => overlayRecoveryFixtureResponse(`/overlay-recovery-host?nonce=${bad}`));
});
test('hosted environment and manifest fail closed without broad permission changes', () => {
    assertOverlayRecoveryEnvironment({ CI: 'true', GITHUB_ACTIONS: 'true' }, 1001);
    for (const [env, uid] of [[{}, 1001], [{ CI: 'true', GITHUB_ACTIONS: 'true' }, 0], [{ CI: 'true', GITHUB_ACTIONS: 'false' }, 1001]]) assert.throws(() => assertOverlayRecoveryEnvironment(env, uid));
    assertRecoveryManifest({ manifest });
    for (const patch of [{ host_permissions: ['<all_urls>'] }, { optional_host_permissions: ['http://*/*'] }, { permissions: ['tabs'] }]) assert.throws(() => assertRecoveryManifest({ manifest: { ...manifest, ...patch } }));
});
test('every source identity, page realm, draft, and same-URL reload change is rejected', () => {
    assertRecoverySourceUnchanged(snapshot(), snapshot());
    for (const field of ['id', 'windowId', 'url', 'incognito', 'pendingUrl']) {
        const after = snapshot(); after.tab[field] = field === 'incognito' ? true : 'changed';
        assert.throws(() => assertRecoverySourceUnchanged(snapshot(), after));
    }
    for (const field of ['url', 'nonce', 'hostDraft', 'title', 'timeOrigin', 'ready', 'hostDocumentSame', 'hostInputSame']) {
        const after = snapshot(); after.host[field] = false; assert.throws(() => assertRecoverySourceUnchanged(snapshot(), after));
    }
});
test('reload requires old raw target destruction, invalidated original view and new real worker identity', () => {
    assertRecoveryReload(lifecycle(), id);
    for (const change of [value => { value.replacement.targetId = 'old'; }, value => { value.observations[1].targets.push(value.observations[0].target); },
        value => { value.observations[1].viewInvalidated = false; }, value => { value.view.invalidations = []; }, value => { value.identity.id = 'wrong'; }]) {
        const value = lifecycle(); change(value); assert.throws(() => assertRecoveryReload(value, id));
    }
});
test('recovery oracle requires exact command, definite absence, one isolated bundle and document ensure-open', () => {
    assertRecoveryTrace(trace(), source);
    for (const change of [v => v.commands.push(v.commands[0]), v => { v.commands[0].command = 'internalMessage'; },
        v => v.injections.push(v.injections[0]), v => { v.injections[0].args[0].world = 'MAIN'; }, v => { v.injections[0].args[0].files = ['arbitrary.js']; },
        v => { v.messages[0].error = 'The message port closed before a response was received.'; }, v => { v.messages[1].args[2] = { frameId: 0 }; },
        v => { v.messages[1].args[1].ensureOpen = false; }, v => { v.messages[1].args[1].expectedUrl = 'https://elsewhere/'; },
        v => v.creations.push({}), v => v.messages.push(v.messages[1])]) {
        const value = trace(); change(value); assert.throws(() => assertRecoveryTrace(value, source));
    }
});
test('legacy fallback and restricted boundary oracle permit one helper and zero restricted injections', () => {
    const legacy = trace(); legacy.messages[1].value = { success: false }; legacy.creations = [{}];
    assertRecoveryTrace(legacy, source, { fallback: true });
    const restricted = { ...trace(), injections: [], messages: [], creations: [{}] };
    assertRecoveryTrace(restricted, source, { fallback: true, restricted: true });
    restricted.injections.push({}); assert.throws(() => assertRecoveryTrace(restricted, source, { fallback: true, restricted: true }));
});
test('orphan replacement requires one iframe, exact preserved draft and retired old host', () => {
    assertRecoveredOverlay(opened(), id, opened().draft);
    for (const patch of [{ hostCount: 2 }, { frameCount: 2 }, { oldHostConnected: true }, { owner: 'other' }, { draft: { value: '' } }]) {
        assert.throws(() => assertRecoveredOverlay({ ...opened(), ...patch }, id, opened().draft));
    }
    const old = { ...opened(), owner: null, oldHostConnected: true, sameHost: true };
    assertLegacyOverlayPreserved(old, old);
    assert.throws(() => assertLegacyOverlayPreserved(old, { ...old, sameHost: false }));
    assert.throws(() => assertLegacyOverlayPreserved(old, { ...old, draft: { value: 'lost' } }));
});
test('no tab created/removed/moved/navigated and legacy gets one exact helper in the source window', () => {
    assertRecoveryNativeTabs([source], [source], { source, spotlightId: id, fallback: false });
    const helper = { id: 15, windowId: 3, url: `chrome-extension://${id}/newtab.html`, active: true, index: 1 };
    assertRecoveryNativeTabs([source], [{ ...source, active: false }, helper], { source, spotlightId: id, fallback: true });
    for (const after of [[], [{ ...source, url: 'changed' }], [source, helper], [{ ...source, windowId: 9 }]]) assert.throws(() => assertRecoveryNativeTabs([source], after, { source, spotlightId: id, fallback: false }));
    assert.throws(() => assertRecoveryNativeTabs([source], [source, { ...helper, windowId: 4 }], { source, spotlightId: id, fallback: true }));
});
test('one live receiver and actual trusted w input are mandatory', () => {
    assertOneRecoveryReceiver({ live: [{ url }] }, url);
    for (const live of [[], [{ url }, { url }], [{ url: 'wrong' }]]) assert.throws(() => assertOneRecoveryReceiver({ live }, url));
    const events = [{ type: 'keydown', key: 'w', trusted: true }, { type: 'input', value: 'w', trusted: true }];
    assertRecoveryTrustedTyping(events); assert.throws(() => assertRecoveryTrustedTyping(events.map(event => ({ ...event, trusted: false }))));
});
test('uncertain delivery, injection or ensure-open can never retry or create a helper', () => {
    for (const phase of ['initial-delivery', 'injection', 'ensure-open']) {
        const value = trace();
        if (phase === 'initial-delivery') { value.injections = []; value.messages.length = 1; value.messages[0].error = 'Channel closed'; }
        if (phase === 'injection') { value.messages.length = 1; value.injections[0].status = 'pending'; }
        if (phase === 'ensure-open') value.messages[1].status = 'pending';
        assertUncertainRecoveryTrace(value, phase);
        value.creations.push({}); assert.throws(() => assertUncertainRecoveryTrace(value, phase)); value.creations = [];
        value.messages.push(value.messages[0]); assert.throws(() => assertUncertainRecoveryTrace(value, phase));
    }
});
test('passive taps call originals once with same receiver, arguments and exact promise, then restore', async () => {
    const calls = [], promise = Promise.resolve([{ frameId: 0, documentId: 'real' }]), listeners = new Set();
    const original = function (...args) { calls.push({ receiver: this, args }); return promise; };
    globalThis.chrome = { scripting: { executeScript: original }, tabs: { sendMessage: original, create: original }, commands: { onCommand: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) } } };
    try {
        installOverlayRecoveryTrace();
        const arg = { target: { tabId: 12 } };
        assert.equal(chrome.scripting.executeScript(arg), promise); assert.equal(calls.length, 1); assert.equal(calls[0].receiver, chrome.scripting); assert.equal(calls[0].args[0], arg);
        await promise; const observed = readOverlayRecoveryTrace(); assert.equal(observed.injections[0].status, 'fulfilled'); assert.equal(observed.commands.length, 0);
        stopOverlayRecoveryTrace(); assert.equal(chrome.scripting.executeScript, original); assert.equal(chrome.tabs.sendMessage, original); assert.equal(listeners.size, 0);
    } finally { globalThis.__overlayRecoveryTrace?.stop(); delete globalThis.chrome; }
});
test('cold worker proof rejects early replacement, observer-only detach and reused target identity', () => {
    const value = { observations: [{ phase: 'before-close', target: lifecycle().observations[0].target }, { phase: 'network-observer-released', networkSessionId: 'session' }, { phase: 'old-target-gone', oldTargetId: 'old', matchingTargets: [] }] };
    assertRecoveryWorkerStopped(value, id);
    const bad = structuredClone(value); bad.observations[2].matchingTargets.push(lifecycle().replacement); assert.throws(() => assertRecoveryWorkerStopped(bad, id));
    assert.throws(() => assertRecoveryWorkerStopped({ observations: value.observations.slice(0, 2) }, id));
});
test('module is import safe and has no internal command dispatch, reload or policy bypass transport', async () => {
    const code = await readFile(new URL('../../scripts/paired-chrome-overlay-recovery.mjs', import.meta.url), 'utf8');
    assert(!/puppeteer\.launch|no-sandbox|disable-web-security|chrome\.runtime\.sendMessage|Input\.dispatchKeyEvent|chrome\.scripting\.executeScript\(/.test(code));
    assert.match(code, /sendOneNativeSpotlightCommand\(probe\)/); assert.match(code, /kind: 'cold-worker'/);
});

test('a partial observer installation restores every already-tapped original', () => {
    const original = () => Promise.resolve();
    const tabs = {}; Object.defineProperty(tabs, 'sendMessage', { value: original, writable: false });
    globalThis.chrome = { scripting: { executeScript: original }, tabs, commands: { onCommand: { addListener() {}, removeListener() {} } } };
    try {
        assert.throws(installOverlayRecoveryTrace);
        assert.equal(chrome.scripting.executeScript, original); assert.equal(globalThis.__overlayRecoveryTrace, undefined);
    } finally { delete globalThis.chrome; }
});

test('counterpart native index/group/active/pending navigation cannot change during recovery', () => {
    const counterpart = { ...source, id: 13, index: 1, active: false };
    for (const patch of [{ index: 2 }, { groupId: 9 }, { active: true }, { pendingUrl: 'https://unexpected/' }]) {
        assert.throws(() => assertRecoveryNativeTabs([source, counterpart], [source, { ...counterpart, ...patch }], { source, spotlightId: id, fallback: false }));
    }
    const helper = { id: 14, index: 1, windowId: 3, active: true, url: `chrome-extension://${id}/newtab.html` };
    assertRecoveryNativeTabs([source, counterpart], [{ ...source, active: false }, helper, { ...counterpart, index: 2 }], { source, spotlightId: id, fallback: true });
    assert.throws(() => assertRecoveryNativeTabs([source, counterpart], [{ ...source, active: false }, helper, { ...counterpart, index: 3 }], { source, spotlightId: id, fallback: true }));
});
test('native window focus and every counterpart window identity are conserved', () => {
    const windows = [{ id: 3, focused: true, state: 'normal' }, { id: 4, focused: false, state: 'normal' }];
    assertRecoveryWindowsUnchanged(windows, windows, 3);
    for (const after of [[{ ...windows[0], focused: false }, { ...windows[1], focused: true }], windows.slice(0, 1), [{ ...windows[0], state: 'minimized' }, windows[1]]])
        assert.throws(() => assertRecoveryWindowsUnchanged(windows, after, 3));
    assert.throws(() => assertRecoveryWindowsUnchanged(windows, windows, 4));
});
test('cold replacement must be created after the actual helper native command-key timestamp', () => {
    const old = lifecycle().observations[0].target, replacement = lifecycle().replacement;
    const keyDown = Date.parse('2026-10-16T05:00:00.050Z');
    const proof = { old, replacement, inputBoundary: keyDown - 40, native: { commandKeyDownAt: '2026-10-16T05:00:00.050Z' },
        lifecycle: [{ event: 'Target.targetCreated', targetInfo: replacement, observedAt: keyDown + 1 }] };
    assertColdRecoveryWake(proof);
    for (const observedAt of [keyDown - 100, keyDown - 20, keyDown - 1])
        assert.throws(() => assertColdRecoveryWake({ ...proof, lifecycle: [{ ...proof.lifecycle[0], observedAt }] }));
    assert.throws(() => assertColdRecoveryWake({ ...proof, replacement: old }));
    assert.throws(() => assertColdRecoveryWake({ ...proof, lifecycle: [] }));
    assert.throws(() => assertColdRecoveryWake({ ...proof, native: {} }));
});

test('cold and warm failed native sends persist full uncertain transport evidence before rethrow', async () => {
    for (const phase of ['cold-overlay-command-failed', 'overlay-recovery-case-failed']) {
        const nativeCloseEvidence = { status: 'failed', chordAttempted: true, events: [{ key: 'Alt_L', pressed: true }], cleanupReleased: false };
        const error = Object.assign(new Error('uncertain FFI timeout'), { nativeCloseUncertain: true, nativeCloseEvidence });
        const recorded = [], evidence = { inputBoundary: 123, lifecycle: [{ event: 'Target.targetDestroyed' }] };
        await recordOverlayRecoveryFailure(async item => recorded.push(structuredClone(item)), phase, evidence, error);
        assert.equal(recorded.length, 1); assert.equal(recorded[0].phase, phase); assert.equal(recorded[0].failure.nativeUncertain, true);
        assert.deepEqual(recorded[0].failure.nativeEvidence, nativeCloseEvidence); assert.equal(recorded[0].inputBoundary, 123);
        assert.deepEqual(recorded[0].lifecycle, evidence.lifecycle);
    }
});
