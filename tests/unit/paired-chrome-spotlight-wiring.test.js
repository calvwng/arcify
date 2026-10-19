// Import-safe wiring checks. Extract only small adapter functions; never import
// the executable browser runner, open Chrome/X, or invoke a native helper.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { readSourceText } from '../source-text.js';
import { terminateObservedWorker } from '../../scripts/paired-chrome-worker.mjs';
import { SPOTLIGHT_ACTION_CASE_NAME } from '../../scripts/paired-chrome-spotlight-actions.mjs';
const runner = readSourceText(new URL('../../scripts/paired-chrome-smoke.mjs', import.meta.url));
const workflow = readSourceText(new URL('../../.github/workflows/paired-extension-smoke.yml', import.meta.url));
function adapter(name, end, dependencies) {
    const start = runner.indexOf(`async function ${name}(`); assert(start > 0);
    const finish = runner.indexOf(end, start); assert(finish > start);
    return Function(...Object.keys(dependencies), `return (${runner.slice(start, finish).trim()});`)(...Object.values(dependencies));
}

test('startup readiness ignores early action rows and waits passively for loaded ordinary tab results', async () => {
    const { document } = parseHTML('<div data-testid="spotlight-result" data-result-type="arcify-sidebar-command"></div><div data-testid="spotlight-result" data-result-type="arcify-space-action"></div>');
    const calls = [], wait = adapter('waitStartupResults', 'async function waitSidebarSuccess(', {});
    await wait({ waitForSelector: async (selector, options) => {
        calls.push({ selector, options }); assert.equal(document.querySelector(selector), null);
        const row = document.createElement('div'); row.dataset.testid = 'spotlight-result'; row.dataset.resultType = 'open-tab'; document.body.append(row);
        assert.equal(document.querySelector(selector), row);
    } });
    assert.deepEqual(calls, [{ selector: '[data-testid="spotlight-result"][data-result-type="open-tab"]', options: { visible: true } }]);
    const source = runner.slice(runner.indexOf('await step(stepNames[14]'), runner.indexOf('await step(stepNames[15]'));
    assert(source.indexOf('await waitStartupResults(helper.page)') < source.indexOf("const offered = await external("));
    assert.match(source, /assert.equal\(offered.accepted, true/);
    assert.match(source, /assert.equal\(repeated.accepted, false/);
    const cold = runner.slice(runner.indexOf('await step(stepNames[15]'), runner.indexOf('await step(stepNames[16]'));
    assert(cold.indexOf('await waitStartupResults(helper.page)') > 0);
    assert(cold.indexOf('await waitStartupResults(helper.page)') < cold.indexOf("const offered = await external("));
    assert.doesNotMatch(runner, /spotlight-result"\]:not\(\[data-result-type="arcify-sidebar-command"/);
});
test('startup readiness failure is preserved without a second observation or offer', async () => {
    const failure = new Error('Ordinary results did not load'); let reads = 0;
    const wait = adapter('waitStartupResults', 'async function waitSidebarSuccess(', {});
    await assert.rejects(wait({ waitForSelector: async () => { reads++; throw failure; } }), error => error === failure);
    assert.equal(reads, 1);
});

test('recovery and initial actions are mandatory additions after all previous full cases and before unchanged endings', () => {
    const start = runner.indexOf("    if (report.runMode === 'full' || report.runMode === 'appearance-actions') {\n", runner.indexOf("    } // Full-only cases 34–35, 37–38 and 40–45."));
    const end = runner.indexOf('    } // Shared recovery/actions cases 48–49;');
    const theme = runner.indexOf('await step(stepNames[47]');
    const recovery = runner.indexOf('await step(stepNames[48]');
    const actions = runner.indexOf('await step(stepNames[49]');
    assert(start < theme && theme < recovery && recovery < actions && actions < end);
    assert(end < runner.indexOf('await step(stepNames[36]'));
    assert(end < runner.indexOf('await step(stepNames[32]'));
    assert.equal((runner.match(/exerciseOverlayRecovery\(/g) || []).length, 1);
    assert.equal((runner.match(/exerciseSpotlightActions\(/g) || []).length, 1);
    assert(runner.includes(`'${SPOTLIGHT_ACTION_CASE_NAME}'`));
    assert.match(runner, /assert.equal\(stepNames\[49\], SPOTLIGHT_ACTION_CASE_NAME/);
    assert.match(runner, /exerciseSpotlightActions\(\{ apiPage:arcifyOptions,spotlightOptions,newTabPage,openSavedPage:openSavedMovePage,pageForUrl,\s+ui,screenshot,snapshot,bridge,external,poll,fixture,arcifyId,spotlightId,search/);
    assert.match(runner, /report.spotlightActions = evidence; await saveReport\(\)/);
    assert.doesNotMatch(runner.slice(recovery, end), /windowIsolation|skip|\.catch\(/);
});

test('both dedicated fixture routes precede the unchanged generic page fallback and preserve recovery CSP/body/type', () => {
    const server = runner.slice(runner.indexOf('server = createServer('), runner.indexOf('await new Promise(resolve => server.listen'));
    assert.match(server, /if \(serveSpotlightActionFixture\(request, response\)\) return;/);
    assert.match(server, /const recovery = overlayRecoveryFixtureResponse\(request.url\)/);
    assert.match(server, /'content-type': recovery.type, 'content-security-policy': recovery.csp/);
    assert.match(server, /response.end\(recovery.body\); return;/);
    for (const existing of ['serveNativeSplitFixture', 'serveTabMenuFixture', 'serveTodayMoveFixture', 'serveSavedMoveFixture', 'serveTodayOrderFixture', 'serveOrdinaryFavoriteFixture', 'serveFavoriteIconFixture']) {
        assert(server.indexOf('serveSpotlightActionFixture') < server.indexOf(existing));
        assert(server.indexOf(existing) < server.indexOf('const title = titles[path]'));
    }
});

test('external action adapter returns the actual rejection envelope without an optimistic assertion or mutation', async () => {
    const rejection = { ok: false, error: { code: 'STALE_CONTEXT' } }, calls = [];
    const page = { evaluate: async (fn, data) => vm.runInNewContext(`(${fn})`, { chrome: { runtime: { sendMessage: async (...args) => { calls.push(args); return rejection; } } } })(data) };
    const external = adapter('external', 'async function bridge(', {});
    const response = await external(page, 'peer-id', 'pinCurrentTab', { windowId: 7, context: { sourceTabId: 5 } }, 'exact-request');
    assert.equal(response, rejection);
    assert.equal(calls.length, 1);
    assert.equal(JSON.stringify(calls[0]), JSON.stringify(['peer-id', { type: 'arcify-bridge', version: 1, requestId: 'exact-request', command: 'pinCurrentTab', windowId: 7, context: { sourceTabId: 5 } }]));
});

function recoveryHarness({ failure, extraHelpers = 0, pendingHelper = false } = {}) {
    const log = [], report = {}, fixture = { base: 'http://localhost:81', windowA: 7 }, spotlightId = 'b'.repeat(32);
    const helperUrl = `chrome-extension://${spotlightId}/newtab.html`, workerUrl = `chrome-extension://${spotlightId}/background.js`;
    const tabs = new Map([[1, { id: 1, windowId: 7, url: 'http://localhost/original', active: true }], [2, { id: 2, windowId: 7, url: helperUrl }], [3, { id: 3, windowId: 8, url: 'chrome-extension://peer/options.html' }]]);
    const sourcePage = { page: true }, networkTargets = new WeakMap(); let pageTarget, alive = true;
    const worker = { async close() { log.push('worker-close'); alive = false; } };
    const workerTarget = { type: () => 'service_worker', url: () => workerUrl, worker: async () => { log.push('worker-handle'); return worker; } };
    networkTargets.set(workerTarget, { id: () => 'exact-network', detach: async () => { log.push('release-network'); } });
    const cdp = { send: async command => { assert.equal(command, 'Target.getTargets'); log.push('raw-targets'); return { targetInfos: alive ? [{ type: 'service_worker', url: workerUrl, targetId: 'old-worker' }] : [] }; }, detach: async () => { log.push('detach-targets'); } };
    const browser = { targets: () => pageTarget ? [workerTarget, pageTarget] : [workerTarget], target: () => ({ createCDPSession: async () => cdp }) };
    const chrome = { tabs: { query: async () => [...tabs.values()], create: async options => {
        const source = { ...options, id: 10, status: 'complete' }; tabs.set(10, source);
        pageTarget = { type: () => 'page', url: () => options.url, page: async () => sourcePage }; return source;
    }, remove: async id => { log.push(`remove-${id}`); tabs.delete(id); } } };
    const arcifyOptions = { evaluate: async (fn, arg) => vm.runInNewContext(`(${fn})`, { chrome })(arg) };
    const sidebar = () => {}; const reloadEvidence = { realReload: true };
    const dependencies = { assert, randomBytes: () => ({ toString: () => 'a'.repeat(32) }), fixture, spotlightId, arcifyOptions, browser, report,
        saveReport: async () => {}, tab: async id => tabs.get(id),
        poll: async (read, accept) => { const value = await read(); assert(accept(value)); return value; },
        attachCreatedFixtureTab: async (_created, attach) => attach(), observePage: async page => page,
        reloadPairedExtension: async name => { assert.equal(name, 'spotlight'); log.push('real-reload'); tabs.delete(3); tabs.set(30, { id: 30, windowId: 8, url: 'chrome-extension://peer/options.html' }); return { evidence: reloadEvidence }; },
        terminateObservedWorker, networkTargets, blockExternalHttps: async target => { assert.equal(target, workerTarget); log.push('replacement-guard'); },
        verifyRecoveredOverlaySidebar: sidebar, ui: () => {}, screenshot: () => {}, activate: async id => { assert.equal(id, 1); log.push('restore-active'); },
        exerciseOverlayRecovery: async options => {
            assert.equal(options.browser, browser); assert.equal(options.page, sourcePage); assert.equal(options.sourceTab.id, 10);
            assert.equal(options.arcifyOptions, arcifyOptions); assert.equal(options.spotlightId, spotlightId); assert.equal(options.verifySidebar, sidebar);
            assert.equal(await options.reloadSpotlight(), reloadEvidence);
            const stopped = await options.stopSpotlightWorker();
            assert.deepEqual(stopped.observations.map(item => item.phase), ['before-close', 'network-observer-released', 'old-target-gone']);
            assert.equal(stopped.observations[1].networkSessionId, 'exact-network'); assert.deepEqual(stopped.observations[2].matchingTargets, []);
            assert.deepEqual(log.slice(log.indexOf('release-network')), ['release-network', 'worker-close', 'raw-targets']);
            assert.equal(networkTargets.has(workerTarget), false);
            await options.observeReplacementWorker(workerTarget);
            tabs.set(20, { id: 20, windowId: 7, url: pendingHelper ? '' : helperUrl, ...(pendingHelper ? { pendingUrl: helperUrl } : {}) });
            for (let i = 0; i < extraHelpers; i++) tabs.set(21 + i, { id: 21 + i, windowId: 7, url: helperUrl });
            await options.record({ phase: 'actual-checkpoint' });
            if (failure) throw failure;
            return { cases: ['dormant', 'cold-worker', 'marked-orphan', 'unmarked-legacy-shape'].map(kind => ({ kind })) };
        } };
    return { run: adapter('runHostedOverlayRecovery', '// Retain the same raw-target, original-view, registry and fresh-identity proof', dependencies), tabs, log, report };
}

test('recovery wiring carries real lifecycle evidence, exact network release, all four cases and scoped cleanup', async () => {
    const h = recoveryHarness(); const result = await h.run();
    assert.equal(result, h.report.overlayRecovery.evidence);
    assert.equal(h.report.overlayRecovery.checkpoints.filter(item => item.phase === 'actual-checkpoint').length, 1);
    assert.deepEqual(h.report.overlayRecovery.cleanup.removedTabIds, [20, 10]);
    assert.deepEqual([...h.tabs.keys()], [1, 2, 30], 'Existing helper and reloaded options realm must survive cleanup.');
    assert.deepEqual(h.report.overlayRecovery.cleanup.failures, []);
});

test('failed recovery still removes its exact observed helper/source and retains the original error and options', async () => {
    const failure = new Error('uncertain native result'); const h = recoveryHarness({ failure });
    await assert.rejects(h.run(), error => error === failure);
    assert.deepEqual(h.report.overlayRecovery.cleanup.removedTabIds, [20, 10]);
    assert.deepEqual([...h.tabs.keys()], [1, 2, 30]);
});

test('an exact in-flight fallback helper is removed on failure before its document has settled', async () => {
    const failure = new Error('native fallback not yet settled'); const h = recoveryHarness({ failure, pendingHelper: true });
    await assert.rejects(h.run(), error => error === failure);
    assert.deepEqual(h.report.overlayRecovery.cleanup.removedTabIds, [20, 10]);
    assert.deepEqual([...h.tabs.keys()], [1, 2, 30]);
});

test('ambiguous extra helpers fail closed and cannot broaden cleanup deletion', async () => {
    const h = recoveryHarness({ extraHelpers: 1 });
    await assert.rejects(h.run(), /Recovery cleanup failed.*Unexpected extra recovery helpers/);
    assert.deepEqual(h.report.overlayRecovery.cleanup.removedTabIds, [10]);
    assert(h.tabs.has(20) && h.tabs.has(21) && h.tabs.has(2) && h.tabs.has(30));
});

test('existing-overlay Sidebar uses frame Enter, native capture and exactly one successful close', async () => {
    const calls = [], native = { context: { contextType: 'SIDE_PANEL' }, openedEvents: [{ windowId: 7 }] };
    let evaluates = 0;
    const host = { evaluate: async () => true, dispose: async () => { calls.push('dispose-host'); } };
    const page = { $: async selector => { assert.equal(selector, '#arcify-spotlight-host'); return host; } };
    const surface = { waitForSelector: async selector => { assert.equal(selector, '[data-result-type="arcify-sidebar-command"].selected'); }, evaluate: async () => ++evaluates === 1 ? undefined : [{ trusted: true, focusedInput: true, selected: 'arcify-sidebar-command' }] };
    const dependencies = { assert, fixture: { windowA: 7 }, sidebarSelector: '[data-result-type="arcify-sidebar-command"]',
        tabsIn: async () => [{ id: 4 }], search: async actualPage => { assert.equal(actualPage, page); calls.push('search-existing'); },
        nativePanelState: async () => ({ contexts: [{ contextType: 'SIDE_PANEL' }], events: [] }),
        sidebarEnter: async actualPage => { assert.equal(actualPage, page); calls.push('real-enter'); }, waitSidebarSuccess: async () => {},
        captureNativeSidebar: async () => { calls.push('native-capture'); return native; }, closeNativeSidebar: async () => { calls.push('close-panel'); },
        ui: async (actualPage, _label, action) => { assert.equal(actualPage, page); return action(); },
        sidebarInput: async () => ({ asElement: () => ({ focus: async () => { calls.push('refocus-existing'); } }), dispose: async () => {} }) };
    const verify = adapter('verifyRecoveredOverlaySidebar', 'async function runHostedOverlayRecovery', dependencies);
    const result = await verify({ page, surface, sourceTab: { id: 4, windowId: 7 } });
    assert.equal(result.context, native.context); assert.equal(result.sameRecoveredOverlay, true);
    assert.deepEqual(calls, ['search-existing', 'real-enter', 'native-capture', 'close-panel', 'refocus-existing', 'dispose-host']);
    const source = runner.slice(runner.indexOf('async function verifyRecoveredOverlaySidebar'), runner.indexOf('async function runHostedOverlayRecovery'));
    assert.doesNotMatch(source, /newTabPage|nativeTodayMoveSidebar|launchOverlay|sendMessage|\.reload\(/);
});

test('new workflow watches sources/tests and pins every mandatory job without weakening isolation or native boundaries', () => {
    for (const path of ['scripts/paired-chrome-overlay-recovery.mjs', 'scripts/paired-chrome-spotlight-actions.mjs', 'tests/unit/paired-chrome-overlay-recovery.test.js',
        'tests/unit/paired-chrome-spotlight-actions.test.js', 'tests/unit/paired-chrome-spotlight-wiring.test.js', 'docs/OVERLAY-RECOVERY-HOSTED.md', 'docs/spotlight-actions-paired-ci.md',
        'scripts/paired-chrome-native-close.*', 'tests/unit/paired-chrome-native-close.test.js', 'tests/unit/paired_chrome_native_close_test.py',
        'spotlight-space-actions.js', 'tests/unit/spotlight-space-actions.test.js', 'tests/unit/spotlight-bridge.test.js']) assert(workflow.includes(`- '${path}'`), path);
    const pin = runner.match(/const PINNED_SPOTLIGHT = '([0-9a-f]{40})'/)[1];
    assert.equal(pin, 'deb672a415ed58a61ae30c874926b7274615371c');
    assert.equal((workflow.match(new RegExp(`ref: ${pin}`, 'g')) || []).length, 8);
    assert.match(runner, /assert.deepEqual\(await windowBState\(\), fixture.windowBBaseline/);
    assert.match(runner, /assertNoTargetCrashes\(report.targetLifecycle\)/); assert.match(runner, /assertNoPageErrors\(report.diagnostics\)/);
    assert.doesNotMatch(workflow, /continue-on-error:|no-sandbox|disable-web-security|CHROME_DEVEL_SANDBOX/);
});


test('manual search retention observes exact result identity instead of a fixed action count', () => {
    for (const [start, end, query] of [["await step(stepNames[19]", "await step(stepNames[20]", 'opn arcfi'], ["await step(stepNames[21]", "await step(stepNames[22]", 'logical']]) {
        const section = runner.slice(runner.indexOf(start), runner.indexOf(end));
        assert(section.includes('selectResultWithKeyboard(input.asElement()'));
        assert(section.includes(`row.type === 'search-query' && row.title === 'Search for "${query}"'`));
        assert(!section.includes("press('ArrowDown')"));
        assert(section.includes("find(row => row.selected)?.type, 'search-query'"));
    }
});
