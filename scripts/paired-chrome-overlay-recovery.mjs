/** Hosted Chrome acceptance helpers. Importing this module never launches a browser or sends input. */
import assert from 'node:assert/strict';
import { spotlightSurface, assertHostKeyboardIsolated } from './paired-chrome-keyboard.mjs';
import { probeNativeSpotlightCommandTarget, sendOneNativeSpotlightCommand, readExpectedXvfbPid } from './paired-chrome-native-close.mjs';
import { waitForExtensionWorkerIdentity } from './paired-chrome-worker.mjs';

export const OVERLAY_RECOVERY_CSP = "default-src 'none'; script-src 'self'; style-src 'none'; frame-src 'none'; connect-src 'none'";
export const OVERLAY_RECOVERY_SCRIPT = `
window.overlayRecoveryHost = {ready:true, nonce:new URL(location.href).searchParams.get('nonce'), keys:[], shortcuts:0};
for (const target of [window,document]) for (const capture of [true,false]) for (const type of ['keydown','keypress','keyup']) {
 target.addEventListener(type,event=>{
  overlayRecoveryHost.keys.push({type,key:event.key,capture,target:event.target.tagName,trusted:event.isTrusted});
  if (event.key==='w' && event.target.tagName!=='INPUT') { overlayRecoveryHost.shortcuts++; event.preventDefault(); }
 },capture);
}`;
export function overlayRecoveryFixtureResponse(rawUrl) {
    const url = new URL(rawUrl, 'http://localhost');
    if (url.pathname === '/overlay-recovery-host.js') return { type: 'text/javascript', csp: OVERLAY_RECOVERY_CSP, body: OVERLAY_RECOVERY_SCRIPT };
    if (url.pathname !== '/overlay-recovery-host') return null;
    const nonce = url.searchParams.get('nonce'); assert.match(nonce || '', /^[a-f0-9]{32}$/);
    return { type: 'text/html', csp: OVERLAY_RECOVERY_CSP, body: `<!doctype html><html><head><title>Overlay recovery ${nonce}</title><script src="/overlay-recovery-host.js"></script></head><body><label>Unsaved host draft <input id="host-draft"></label><button id="host-previous">Host focus</button></body></html>` };
}
export function assertOverlayRecoveryEnvironment(env = process.env, uid = process.getuid?.()) {
    assert.equal(env.CI, 'true'); assert.equal(env.GITHUB_ACTIONS, 'true');
    assert(Number.isInteger(uid) && uid > 0, 'Recovery evidence requires the ordinary sandboxed hosted runner');
}
export function assertRecoveryManifest(identity) {
    const manifest = identity.manifest;
    assert(manifest.permissions.includes('activeTab')); assert(manifest.permissions.includes('scripting'));
    assert.deepEqual(manifest.host_permissions || [], [], 'Recovery must not gain persistent broad host permission');
    assert.deepEqual(manifest.optional_host_permissions || [], []);
    assert.equal(manifest.commands.toggleSpotlightNewTab.suggested_key.default, 'Alt+T');
    return identity;
}

// Runs inside the page's main world: read-only observations, never content API calls.
export function readOverlayRecoveryHost() {
    const fixture = globalThis.overlayRecoveryHost, host = document.querySelector('#arcify-spotlight-host');
    const dialog = host?.shadowRoot?.querySelector('dialog'), frame = dialog?.querySelector('[data-testid="spotlight-frame"]');
    const input = frame?.contentDocument?.querySelector('[data-testid="spotlight-input"]');
    const draft = document.querySelector('#host-draft');
    return { url: location.href, timeOrigin: performance.timeOrigin, nonce: fixture?.nonce, ready: fixture?.ready === true,
        hostDraft: draft?.value, title: document.title, keys: [...(fixture?.keys || [])], shortcuts: fixture?.shortcuts,
        hostCount: document.querySelectorAll('#arcify-spotlight-host').length,
        frameCount: host?.shadowRoot?.querySelectorAll('[data-testid="spotlight-frame"]').length || 0,
        owner: host?.getAttribute('data-arcify-spotlight-owner') ?? null, open: dialog?.open === true,
        draft: input ? { value: input.value, start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection } : null,
        oldHostConnected: globalThis.__overlayRecoveryOldHost?.isConnected ?? null,
        sameHost: globalThis.__overlayRecoveryOldHost ? globalThis.__overlayRecoveryOldHost === host : null,
        hostDocumentSame: globalThis.__overlayRecoveryOriginalDocument === document,
        hostInputSame: globalThis.__overlayRecoveryOriginalInput === draft };
}
export function assertRecoverySourceUnchanged(before, after) {
    for (const field of ['id', 'windowId', 'url', 'incognito']) assert.equal(after.tab[field], before.tab[field], `Source ${field} changed`);
    assert(!after.tab.pendingUrl, 'Source has a pending navigation');
    for (const field of ['url', 'timeOrigin', 'nonce', 'hostDraft', 'title']) assert.equal(after.host[field], before.host[field], `Source document ${field} changed`);
    assert.equal(after.host.ready, true); assert.equal(after.host.hostDocumentSame, true); assert.equal(after.host.hostInputSame, true);
    return after;
}
export function assertRecoveryReload(lifecycle, spotlightId) {
    assert.equal(lifecycle.name, 'spotlight');
    const url = `chrome-extension://${spotlightId}/background.js`;
    const before = lifecycle.observations.find(item => item.phase === 'before-reload')?.target;
    const observed = lifecycle.observations.find(item => item.phase === 'reload-observed');
    assert.equal(before?.type, 'service_worker'); assert.equal(before?.url, url);
    assert.equal(observed?.oldTargetId, before.targetId);
    assert(!observed.targets.some(target => target.targetId === before.targetId));
    assert.equal(observed.viewInvalidated, true);
    assert(lifecycle.view.closed || lifecycle.view.invalidations.length > 0);
    assert.equal(lifecycle.replacement.type, 'service_worker'); assert.equal(lifecycle.replacement.url, url);
    assert.notEqual(lifecycle.replacement.targetId, before.targetId);
    assert.equal(lifecycle.identity.id, spotlightId); assert.equal(lifecycle.identity.globalType, 'ServiceWorkerGlobalScope');
    assertRecoveryManifest(lifecycle.identity); return lifecycle;
}

/** Passive taps: original method called exactly once, with unchanged this/args and original promise returned.
 * No stubbed outcomes, synthesized commands, retries, permission grants or receiver removal.
 * These taps are disclosed in the report. They are removed after each command.
 */
export function installOverlayRecoveryTrace() {
    if (globalThis.__overlayRecoveryTrace) throw new Error('Recovery tracing is already installed');
    const trace = { commands: [], injections: [], messages: [], creations: [], instrumentation: 'passive original-delegating API taps' };
    const restore = [];
    const tap = (object, name, field) => {
        const original = object[name];
        const wrapped = function (...args) {
            const entry = { args: structuredClone(args), status: 'pending' }; trace[field].push(entry);
            let result;
            try { result = Reflect.apply(original, this, args); }
            catch (error) { entry.status = 'rejected'; entry.error = error.message; throw error; }
            // Return the exact original object and never change its resolution.
            if (result && typeof result.then === 'function') result.then(value => {
                entry.status = 'fulfilled'; entry.value = structuredClone(value);
            }, error => { entry.status = 'rejected'; entry.error = error.message; });
            else { entry.status = 'non-promise'; }
            return result;
        };
        object[name] = wrapped;
        if (object[name] !== wrapped) throw new Error(`Cannot observe original ${name}`);
        restore.push(() => { if (object[name] !== wrapped) throw new Error(`Observer ownership changed for ${name}`); object[name] = original; });
    };
    const listener = (command, tab) => trace.commands.push({ command, tab: tab ? { id: tab.id, windowId: tab.windowId, url: tab.url } : null });
    try {
        tap(chrome.scripting, 'executeScript', 'injections');
        tap(chrome.tabs, 'sendMessage', 'messages');
        tap(chrome.tabs, 'create', 'creations');
        chrome.commands.onCommand.addListener(listener);
    } catch (error) {
        restore.reverse().forEach(fn => fn());
        throw error;
    }
    globalThis.__overlayRecoveryTrace = { trace, stop() { chrome.commands.onCommand.removeListener(listener); restore.reverse().forEach(fn => fn()); delete globalThis.__overlayRecoveryTrace; } };
}
export const readOverlayRecoveryTrace = () => structuredClone(globalThis.__overlayRecoveryTrace.trace);
export const stopOverlayRecoveryTrace = () => globalThis.__overlayRecoveryTrace.stop();

export function assertRecoveryTrace(trace, source, { fallback = false, restricted = false } = {}) {
    assert.equal(trace.instrumentation, 'passive original-delegating API taps');
    assert.equal(trace.commands.length, 1, 'Exactly one actual browser command must be observed');
    assert.equal(trace.commands[0].command, 'toggleSpotlightNewTab');
    if (trace.commands[0].tab) assert.deepEqual(trace.commands[0].tab, { id: source.id, windowId: source.windowId, url: source.url });
    const activations = trace.messages.filter(entry => entry.args[1]?.action === 'activateSpotlight');
    if (restricted) {
        assert.equal(trace.injections.length, 0); assert.equal(activations.length, 0);
    } else {
        assert.equal(trace.injections.length, 1, 'One bundled injection only');
        const injection = trace.injections[0];
        assert.deepEqual(injection.args, [{ target: { tabId: source.id, frameIds: [0] }, world: 'ISOLATED', files: ['overlay.js'], injectImmediately: true }]);
        assert.equal(injection.status, 'fulfilled'); assert.equal(injection.value.length, 1);
        assert.equal(injection.value[0].frameId, 0); assert.equal(typeof injection.value[0].documentId, 'string'); assert(injection.value[0].documentId);
        assert.equal(activations.length, 2, 'One missing-receiver probe and one document-targeted ensure-open only');
        assert.equal(activations[0].args[0], source.id); assert.deepEqual(activations[0].args[2], { frameId: 0 });
        assert.equal(activations[0].args[1].recovery, undefined); assert.equal(activations[0].args[1].ensureOpen, false);
        for (const entry of activations) {
            assert.equal(entry.args[1].mode, 'new-tab'); assert.equal(entry.args[1].tabUrl, source.url);
            assert.equal(entry.args[1].expectedUrl, source.url); assert.equal(entry.args[1].tabId, source.id);
        }
        assert.equal(activations[0].status, 'rejected');
        assert.equal(activations[0].error, 'Could not establish connection. Receiving end does not exist.');
        const opened = activations[1];
        assert.equal(opened.args[0], source.id); assert.deepEqual(opened.args[2], { documentId: injection.value[0].documentId });
        assert.equal(opened.args[1].expectedUrl, source.url); assert.equal(opened.args[1].tabId, source.id);
        assert.equal(opened.args[1].ensureOpen, true); assert.equal(opened.args[1].recovery, true);
        assert.equal(typeof opened.args[1].recoveryRequestId, 'string'); assert(opened.args[1].recoveryRequestId);
        assert.equal(opened.status, 'fulfilled'); assert.equal(opened.value.success, !fallback);
        if (!fallback) assert.equal(opened.value.open, true);
    }
    assert.equal(trace.creations.length, fallback ? 1 : 0, 'Unexpected helper creation or duplicate fallback');
    return trace;
}
export function assertRecoveredOverlay(state, spotlightId, expectedDraft) {
    assert.equal(state.hostCount, 1); assert.equal(state.frameCount, 1); assert.equal(state.open, true);
    assert.equal(state.owner, spotlightId);
    if (expectedDraft) assert.deepEqual(state.draft, expectedDraft, 'Orphan text and selection must survive');
    if (state.sameHost !== null) { assert.equal(state.sameHost, false); assert.equal(state.oldHostConnected, false); }
    return state;
}
export function assertLegacyOverlayPreserved(before, after) {
    assert.equal(before.owner, null); assert.equal(after.owner, null);
    assert.equal(after.hostCount, 1); assert.equal(after.frameCount, 1); assert.equal(after.open, true);
    assert.deepEqual(after.draft, before.draft); assert.equal(after.oldHostConnected, true); assert.equal(after.sameHost, true);
    return after;
}
export function assertRecoveryNativeTabs(before, after, { source, spotlightId, fallback }) {
    const helperUrl = `chrome-extension://${spotlightId}/newtab.html`;
    const priorIds = new Set(before.map(tab => tab.id)), newTabs = after.filter(tab => !priorIds.has(tab.id));
    assert.equal(newTabs.length, fallback ? 1 : 0, 'Recovery cannot create any unrelated tab');
    for (const old of before) {
        const current = after.find(tab => tab.id === old.id); assert(current, 'Recovery cannot remove any existing tab');
        for (const field of ['id', 'windowId', 'url', 'incognito', 'pinned', 'groupId', 'pendingUrl']) assert.equal(current[field], old[field], `Native tab ${old.id} changed ${field}`);
        assert(Number.isSafeInteger(old.index) && Number.isSafeInteger(current.index));
        const insertedBefore = fallback && newTabs[0].windowId === old.windowId && newTabs[0].index <= old.index ? 1 : 0;
        assert.equal(current.index, old.index + insertedBefore, `Native tab ${old.id} changed order beyond the single helper insertion`);
        assert.equal(current.active, fallback && old.id === source.id ? false : old.active, `Native tab ${old.id} changed active state`);
    }
    if (fallback) {
        assert.equal(newTabs[0].url, helperUrl); assert.equal(newTabs[0].windowId, source.windowId); assert.equal(newTabs[0].active, true);
        assert(Number.isSafeInteger(newTabs[0].index) && newTabs[0].index >= 0);
    } else assert.equal(after.find(tab => tab.id === source.id).active, true);
    return newTabs[0] || null;
}

export function assertRecoveryWindowsUnchanged(before, after, sourceWindowId) {
    const fields = ['id', 'focused', 'incognito', 'type', 'state', 'alwaysOnTop', 'left', 'top', 'width', 'height'];
    const projection = windows => windows.map(window => Object.fromEntries(fields.map(field => [field, window[field]]))).sort((a, b) => a.id - b.id);
    assert.deepEqual(before.filter(window => window.focused).map(window => window.id), [sourceWindowId], 'Source window must have native browser focus before input');
    assert.deepEqual(projection(after), projection(before), 'Command must conserve all native window identities and focus');
    return after;
}

// Observe already-existing isolated contexts. Never create an isolated world or inject a receiver for evidence.
export async function observeRecoveryReceiver(page, spotlightId) {
    const client = await page.target().createCDPSession(), contexts = new Map();
    client.on('Runtime.executionContextCreated', ({ context }) => contexts.set(context.id, context));
    client.on('Runtime.executionContextDestroyed', ({ executionContextId }) => contexts.delete(executionContextId));
    client.on('Runtime.executionContextsCleared', () => contexts.clear());
    await client.send('Runtime.enable');
    const { frameTree } = await client.send('Page.getFrameTree');
    return { async read() {
        const observations = [];
        for (const context of contexts.values()) {
            if (context.auxData?.isDefault || context.auxData?.frameId !== frameTree.frame.id) continue;
            const result = await client.send('Runtime.evaluate', { contextId: context.id, returnByValue: true,
                expression: `(() => { try { const r=window.__arcifySpotlightReceiverV1; return {id:globalThis.chrome?.runtime?.id||null,live:r?.isLive()===true,url:location.href}; } catch(e) { return {invalidated:true}; } })()` });
            assert(!result.exceptionDetails, 'Receiver observation itself must not throw');
            observations.push({ contextId: context.id, ...result.result.value });
        }
        return { observations, live: observations.filter(value => value.id === spotlightId && value.live) };
    }, close: () => client.detach() };
}
export function assertOneRecoveryReceiver(evidence, sourceUrl) {
    assert.equal(evidence.live.length, 1, 'Exactly one live same-extension main-frame singleton is required');
    assert.equal(evidence.live[0].url, sourceUrl); return evidence;
}

export function installRecoveryInputObservation() {
    globalThis.__recoveryInputEvents = [];
    for (const type of ['keydown', 'beforeinput', 'input', 'keyup']) document.addEventListener(type, event => {
        globalThis.__recoveryInputEvents.push({ type, trusted: event.isTrusted, key: event.key ?? null,
            value: document.querySelector('[data-testid="spotlight-input"]')?.value });
    }, { capture: true, passive: true });
}
export function assertRecoveryTrustedTyping(events) {
    assert(events.length > 0 && events.every(event => event.trusted === true));
    assert(events.some(event => event.type === 'keydown' && event.key === 'w'));
    assert(events.some(event => event.type === 'input' && event.value.includes('w'))); return events;
}

export async function recordOverlayRecoveryFailure(record, phase, evidence, error) {
    evidence.failure = { message: error.message, nativeUncertain: error.nativeCloseUncertain ?? false,
        nativeEvidence: error.nativeCloseEvidence ?? null };
    await record({ phase, ...evidence });
}

/** Three mandatory real reload scenarios on one unchanged ordinary source document.
 * reloadSpotlight returns reloadPairedExtension('spotlight').evidence; it owns network/lifecycle guards.
 * verifySidebar must invoke the actual trusted result gesture and return native panel evidence.
 */
export async function exerciseOverlayRecovery({ browser, page, sourceTab, arcifyOptions, spotlightId,
    reloadSpotlight, stopSpotlightWorker, observeReplacementWorker, poll, ui, record, screenshot, verifySidebar }) {
    assertOverlayRecoveryEnvironment();
    assert.equal(typeof verifySidebar, 'function', 'Direct trusted sidebar gesture acceptance is mandatory');
    assert.equal(typeof stopSpotlightWorker, 'function', 'Cold-worker lifecycle acceptance is mandatory');
    assert.equal(typeof observeReplacementWorker, 'function', 'The existing worker security observer must cover the replacement');
    const nonce = new URL(sourceTab.url).searchParams.get('nonce'); assert.match(nonce || '', /^[a-f0-9]{32}$/);
    assert(['http:', 'https:'].includes(new URL(sourceTab.url).protocol));
    const nativeTarget = { display: process.env.DISPLAY, xvfbPid: await readExpectedXvfbPid(process.env.DISPLAY), chromePid: browser.process().pid, nonce };
    const readTabs = () => arcifyOptions.evaluate(() => chrome.tabs.query({}));
    const readWindows = () => arcifyOptions.evaluate(() => chrome.windows.getAll());
    const read = async () => ({ tab: await arcifyOptions.evaluate(id => chrome.tabs.get(id), sourceTab.id), host: await page.evaluate(readOverlayRecoveryHost) });
    const evidence = { route: 'hosted GitHub Actions Chrome / Xvfb XTEST native Alt_L+t', physicalKeyboard: false, helium: false,
        instrumentation: 'passive original-delegating worker API taps, browser onCommand observer, DOM and isolated-world read-only observations', cases: [] };
    await page.waitForFunction(() => globalThis.overlayRecoveryHost?.ready === true, { polling: 50 });
    await ui(page, 'Enter an unsaved source-page draft', async () => {
        await page.click('#host-draft'); await page.keyboard.type(`unsaved ${nonce}`);
        await page.evaluate(() => { globalThis.__overlayRecoveryOriginalDocument = document; globalThis.__overlayRecoveryOriginalInput = document.querySelector('#host-draft'); });
    });
    const original = await read();
    const receiver = await observeRecoveryReceiver(page, spotlightId);
    try {
        for (const kind of ['dormant', 'marked-orphan', 'unmarked-legacy-shape']) {
            let orphan = null;
            if (kind !== 'dormant') {
                const surface = await spotlightSurface(page);
                await ui(page, `Enter ${kind} overlay draft with trusted input`, async () => {
                    await surface.$eval('[data-testid="spotlight-input"]', input => input.focus());
                    await page.keyboard.down('Control'); try { await page.keyboard.press('KeyA'); } finally { await page.keyboard.up('Control'); }
                    await page.keyboard.type(`w ${kind} draft`);
                    await page.keyboard.press('Home'); await page.keyboard.down('Shift');
                    try { await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight'); } finally { await page.keyboard.up('Shift'); }
                });
                await page.evaluate(legacy => {
                    globalThis.__overlayRecoveryOldHost = document.getElementById('arcify-spotlight-host');
                    if (legacy) globalThis.__overlayRecoveryOldHost.removeAttribute('data-arcify-spotlight-owner');
                }, kind === 'unmarked-legacy-shape');
                orphan = (await read()).host;
                assert.equal(orphan.open, true); assert(orphan.draft.value.includes(kind));
            }
            const lifecycle = assertRecoveryReload(await reloadSpotlight(), spotlightId);
            const target = await browser.waitForTarget(target => target.type() === 'service_worker' && target.url() === `chrome-extension://${spotlightId}/background.js`);
            const worker = await target.worker();
            const identity = assertRecoveryManifest(await waitForExtensionWorkerIdentity(worker, spotlightId));
            const registered = await worker.evaluate(() => chrome.commands.getAll());
            assert.equal(registered.find(command => command.name === 'toggleSpotlightNewTab')?.shortcut, 'Alt+T', 'The actual registered accelerator must be Alt+T');
            const invalidated = await receiver.read(); assert.equal(invalidated.live.length, 0, 'Reloaded page must genuinely have no live current receiver');
            const before = assertRecoverySourceUnchanged(original, await read());
            let tabsBefore;
            await worker.evaluate(installOverlayRecoveryTrace);
            const item = { kind, lifecycle, identity, registered, invalidated, before, orphan };
            evidence.cases.push(item); await record({ phase: 'overlay-recovery-before-command', ...item });
            try {
                item.native = await ui(page, `Invoke the registered Spotlight command once for ${kind}`, async () => {
                    const recheck = assertRecoverySourceUnchanged(original, await read());
                    assert.equal(recheck.tab.active, true); assert.equal(recheck.host.url, sourceTab.url);
                    tabsBefore = await readTabs(); item.tabsBefore = tabsBefore;
                    item.windowsBefore = await readWindows(); assertRecoveryWindowsUnchanged(item.windowsBefore, item.windowsBefore, sourceTab.windowId);
                    const probe = await probeNativeSpotlightCommandTarget(nativeTarget);
                    item.nativeProbe = probe.evidence; await record({ phase: 'overlay-recovery-native-probe', kind, evidence: probe.evidence });
                    return sendOneNativeSpotlightCommand(probe);
                });
                const fallback = kind === 'unmarked-legacy-shape';
                item.trace = await poll(() => worker.evaluate(readOverlayRecoveryTrace), trace =>
                    trace.messages.some(entry => entry.args[1]?.recovery && entry.status !== 'pending') &&
                    (!fallback || trace.creations.some(entry => entry.status === 'fulfilled')), 'one recovery command result');
                assertRecoveryTrace(item.trace, sourceTab, { fallback });
                item.after = assertRecoverySourceUnchanged(original, await read());
                item.tabsAfter = await poll(readTabs, tabs => !fallback || tabs.some(tab => tab.url === `chrome-extension://${spotlightId}/newtab.html` && !tabsBefore.some(old => old.id === tab.id)), 'recovery native tab convergence');
                item.helper = assertRecoveryNativeTabs(tabsBefore, item.tabsAfter, { source: sourceTab, spotlightId, fallback });
                item.windowsAfter = assertRecoveryWindowsUnchanged(item.windowsBefore, await readWindows(), sourceTab.windowId);
                item.receiver = assertOneRecoveryReceiver(await receiver.read(), sourceTab.url);
                if (fallback) {
                    assertLegacyOverlayPreserved(orphan, item.after.host);
                    item.legacyScope = 'Current-build orphan with only the owner marker removed to reproduce the unmarked first-upgrade shape; not an installation of a historical binary.';
                } else {
                    assertRecoveredOverlay(item.after.host, spotlightId, orphan?.draft);
                    const surface = await spotlightSurface(page);
                    await surface.evaluate(installRecoveryInputObservation);
                    const hostBefore = await page.evaluate(readOverlayRecoveryHost);
                    await ui(page, 'Type w through trusted input in the recovered isolated frame', () => page.keyboard.type('w'));
                    const hostAfter = await page.evaluate(readOverlayRecoveryHost);
                    assertHostKeyboardIsolated(hostBefore, hostAfter);
                    item.typing = assertRecoveryTrustedTyping(await surface.evaluate(() => globalThis.__recoveryInputEvents));
                    if (kind === 'dormant') {
                        item.sidebar = await verifySidebar({ page, surface, sourceTab });
                        assert(item.sidebar, 'Trusted sidebar action must return native panel evidence');
                    }
                }
                item.finalTrace = assertRecoveryTrace(await worker.evaluate(readOverlayRecoveryTrace), sourceTab, { fallback });
                assertRecoverySourceUnchanged(original, await read());
                assertRecoveryNativeTabs(tabsBefore, await readTabs(), { source: sourceTab, spotlightId, fallback });
                item.windowsFinal = assertRecoveryWindowsUnchanged(item.windowsBefore, await readWindows(), sourceTab.windowId);
                await screenshot(page, `overlay-recovery-${kind}`);
                await record({ phase: 'overlay-recovery-case-complete', ...item });
            } catch (error) {
                try { item.failureTrace = await worker.evaluate(readOverlayRecoveryTrace); }
                catch (observationError) { item.failureTraceError = observationError.message; }
                await recordOverlayRecoveryFailure(record, 'overlay-recovery-case-failed', item, error);
                throw error;
            } finally { await worker.evaluate(stopOverlayRecoveryTrace); }
            if (kind === 'dormant') {
                await ui(page, 'Close the recovered overlay before the cold-worker command', () => page.keyboard.press('Escape'));
                await page.waitForFunction(() => !document.getElementById('arcify-spotlight-host'), { polling: 50 });
                const cold = await exerciseColdOverlayCommand({ browser, page, sourceTab, arcifyOptions, spotlightId, stopSpotlightWorker, observeReplacementWorker, ui, poll, record, screenshot });
                evidence.cases.push({ kind: 'cold-worker', ...cold });
            }
        }
    } finally { await receiver.close(); }
    await record({ phase: 'overlay-recovery-complete', ...evidence }); return evidence;
}

/** Oracle for production unit/harness boundary traces, never browser-policy fault injection. */
export function assertUncertainRecoveryTrace(trace, phase) {
    assert(['initial-delivery', 'injection', 'ensure-open'].includes(phase));
    const activations = trace.messages.filter(entry => entry.args[1]?.action === 'activateSpotlight');
    assert.equal(trace.creations.length, 0, 'Uncertainty must not create a competing helper');
    assert.equal(trace.injections.length, phase === 'initial-delivery' ? 0 : 1);
    assert.equal(activations.length, phase === 'ensure-open' ? 2 : 1);
    const uncertain = phase === 'injection' ? trace.injections[0] : activations.at(-1);
    assert(['pending', 'rejected'].includes(uncertain.status));
    if (phase === 'initial-delivery' && uncertain.status === 'rejected')
        assert.notEqual(uncertain.error, 'Could not establish connection. Receiving end does not exist.');
    return trace;
}
export function assertRecoveryWorkerStopped(evidence, spotlightId) {
    const url = `chrome-extension://${spotlightId}/background.js`;
    const before = evidence.observations.find(item => item.phase === 'before-close')?.target;
    const released = evidence.observations.find(item => item.phase === 'network-observer-released');
    const gone = evidence.observations.find(item => item.phase === 'old-target-gone');
    assert.equal(before?.url, url); assert.equal(before?.type, 'service_worker'); assert(before.targetId);
    assert(released?.networkSessionId, 'Cold-worker evidence must release the fixture network debugger');
    assert.equal(gone?.oldTargetId, before.targetId);
    assert.deepEqual(gone.matchingTargets, [], 'No replacement worker may be manufactured before the command');
    return before;
}

export function assertColdRecoveryWake({ old, replacement, lifecycle, inputBoundary, native }) {
    assert.notEqual(replacement.targetId, old.targetId); assert.equal(replacement.url, old.url); assert.equal(replacement.type, 'service_worker');
    assert(Number.isFinite(inputBoundary));
    const keyDown = Date.parse(native.commandKeyDownAt); assert(Number.isFinite(keyDown)); assert(keyDown >= inputBoundary);
    const created = lifecycle.filter(event => event.event === 'Target.targetCreated' && event.targetInfo?.targetId === replacement.targetId);
    assert.equal(created.length, 1, 'Distinct replacement target must have one observed creation');
    assert(created[0].observedAt >= keyDown, 'Replacement was observed before the helper queued its native command key');
    assert(!lifecycle.some(event => event.event === 'Target.targetCreated' && event.targetInfo?.url === old.url &&
        event.targetInfo.targetId !== old.targetId && event.observedAt < keyDown), 'A worker woke before the native command key');
    return replacement;
}

/** Focus, source snapshots and the read-only native probe are prepared BEFORE stop.
 * Between the stop and the one native send there is only a raw target-absence read.
 */
export async function exerciseColdOverlayCommand({ browser, page, sourceTab, arcifyOptions, spotlightId,
    stopSpotlightWorker, observeReplacementWorker, ui, poll, record, screenshot }) {
    assertOverlayRecoveryEnvironment();
    assert.equal(typeof observeReplacementWorker, 'function', 'Replacement worker must rejoin the existing network/security observer');
    const read = async () => ({ tab: await arcifyOptions.evaluate(id => chrome.tabs.get(id), sourceTab.id), host: await page.evaluate(readOverlayRecoveryHost) });
    const original = await read(); assert.equal(original.host.open, false); assert.equal(original.host.hostCount, 0);
    const receiver = await observeRecoveryReceiver(page, spotlightId), cdp = await browser.target().createCDPSession();
    const evidence = { route: 'hosted GitHub Actions Xvfb XTEST native Alt_L+t', physicalKeyboard: false, helium: false, before: original, lifecycle: [],
        scope: 'Native command wakes a stopped worker and reuses a live receiver; stale-receiver reinjection is proved by the separate real reload scenarios.' };
    for (const event of ['Target.targetCreated', 'Target.targetInfoChanged', 'Target.targetDestroyed'])
        cdp.on(event, details => evidence.lifecycle.push({ event, ...details, observedAt: Date.now() }));
    try {
        await cdp.send('Target.setDiscoverTargets', { discover: true });
        const live = assertOneRecoveryReceiver(await receiver.read(), sourceTab.url);
        let probe;
        await ui(page, 'Prepare source focus and the native probe before stopping Spotlight', async () => {
            assertRecoverySourceUnchanged(original, await read());
            probe = await probeNativeSpotlightCommandTarget({ display: process.env.DISPLAY,
                xvfbPid: await readExpectedXvfbPid(process.env.DISPLAY), chromePid: browser.process().pid, nonce: original.host.nonce });
            evidence.nativeProbe = probe.evidence;
            evidence.tabsBefore = await arcifyOptions.evaluate(() => chrome.tabs.query({}));
            evidence.windowsBefore = await arcifyOptions.evaluate(() => chrome.windows.getAll());
            assertRecoveryWindowsUnchanged(evidence.windowsBefore, evidence.windowsBefore, sourceTab.windowId);
            await record({ phase: 'cold-overlay-before-stop', ...evidence });
        });
        evidence.stopped = await stopSpotlightWorker();
        const old = assertRecoveryWorkerStopped(evidence.stopped, spotlightId);
        evidence.targetsBeforeInput = (await cdp.send('Target.getTargets')).targetInfos;
        assert(!evidence.targetsBeforeInput.some(target => target.type === 'service_worker' && target.url === old.url), 'No worker may exist at the final native-send boundary');
        evidence.inputBoundary = Date.now();
        // No ui/focus, page/peer evaluation, status request, probe or await here.
        evidence.native = await sendOneNativeSpotlightCommand(probe);
        const target = await browser.waitForTarget(target => target.type() === 'service_worker' && target.url() === old.url);
        await observeReplacementWorker(target);
        const worker = await target.worker(); evidence.identity = assertRecoveryManifest(await waitForExtensionWorkerIdentity(worker, spotlightId));
        const raw = (await cdp.send('Target.getTargets')).targetInfos.filter(target => target.type === 'service_worker' && target.url === old.url);
        assert.equal(raw.length, 1);
        evidence.replacement = assertColdRecoveryWake({ old, replacement: raw[0], lifecycle: evidence.lifecycle, inputBoundary: evidence.inputBoundary, native: evidence.native });
        evidence.after = await poll(read, state => state.host.open === true, 'cold-worker command opens the existing receiver');
        assertRecoverySourceUnchanged(original, evidence.after); assertRecoveredOverlay(evidence.after.host, spotlightId);
        evidence.receiver = assertOneRecoveryReceiver(await receiver.read(), sourceTab.url);
        assert.equal(evidence.receiver.live[0].contextId, live.live[0].contextId, 'Worker wake reuses the existing receiver context');
        evidence.tabsAfter = await arcifyOptions.evaluate(() => chrome.tabs.query({}));
        assertRecoveryNativeTabs(evidence.tabsBefore, evidence.tabsAfter, { source: sourceTab, spotlightId, fallback: false });
        evidence.windowsAfter = assertRecoveryWindowsUnchanged(evidence.windowsBefore, await arcifyOptions.evaluate(() => chrome.windows.getAll()), sourceTab.windowId);
        await screenshot(page, 'overlay-recovery-cold-worker'); await record({ phase: 'cold-overlay-command-complete', ...evidence }); return evidence;
    } catch (error) {
        await recordOverlayRecoveryFailure(record, 'cold-overlay-command-failed', evidence, error);
        throw error;
    } finally { await receiver.close(); await cdp.detach(); }
}
