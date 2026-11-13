import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { openTabMenuNativeHost, hideTabMenuAliasSearch } from '../../scripts/paired-chrome-tab-menu-host.mjs';
import { assertNativeSidebarEvidence } from '../../scripts/paired-chrome-sidebar.mjs';

const extensionId = 'a'.repeat(32), windowId = 7, spaceId = 'work';
const url = `chrome-extension://${extensionId}/sidebar.html`;
function fixture() {
    const rendered = { url, visibility: 'visible', width: 300, height: 700, devicePixelRatio: 1,
        switcher: { visible: true, x: 0, y: 0, width: 300, height: 30 }, selectedVisible: true,
        selectedSpaces: [spaceId], visibleSpaces: [spaceId] };
    const hosting = { tab: null, windowId, url };
    const evidence = { context: { contextType: 'SIDE_PANEL', contextId: 'native-context', documentUrl: url, windowId: -1, incognito: false },
        windowProofSource: 'sidePanel.onOpened', openedEvents: [{ type: 'opened', path: 'sidebar.html', windowId }],
        hosting: { ...hosting }, rendered, beforeCapture: structuredClone(rendered), afterCapture: structuredClone(rendered) };
    const calls = [], records = [];
    const host = { evidence, page: { async evaluate(callback) {
        calls.push('read-host');
        const read = vm.runInNewContext(`(${callback})`, { location: { href: hosting.url }, chrome: {
            tabs: { getCurrent: async () => hosting.tab }, windows: { getCurrent: async () => ({ id: hosting.windowId }) }
        } });
        return read();
    } }, async close() { calls.push('close'); } };
    return { host, hosting, calls, records, options: { extensionId, windowId, spaceId,
        nativeSidebar: async request => { calls.push(['nativeSidebar', request]); return host; },
        record: async value => records.push(value) } };
}
test('native host adapter uses the existing authenticated opener once and leaves cleanup with the caller', async () => {
    const f = fixture(); assert.equal(await openTabMenuNativeHost(f.options), f.host);
    assert.deepEqual(f.calls, [['nativeSidebar', { revealSpaceId: spaceId }], 'read-host']);
    await f.host.close(); assert.equal(f.calls.filter(x => x === 'close').length, 1);
});
for (const [name, change] of Object.entries({
    regularContext: f => { f.host.evidence.context.contextType = 'TAB'; },
    noOpenEvent: f => { f.host.evidence.openedEvents = []; },
    wrongEventWindow: f => { f.host.evidence.openedEvents[0].windowId = 8; },
    wrongContextWindow: f => { f.host.evidence.context.windowId = 8; },
    privateContext: f => { f.host.evidence.context.incognito = true; },
    missingContextIdentity: f => { f.host.evidence.context.contextId = ''; },
    fakeWindowProof: f => { f.host.evidence.windowProofSource = 'url'; },
    ordinaryTarget: f => { f.hosting.tab = { id: 12, windowId }; },
    wrongTargetWindow: f => { f.hosting.windowId = 8; },
    wrongTargetUrl: f => { f.hosting.url += '?fixture'; },
    staleRecordedHost: f => { f.host.evidence.hosting.tab = { id: 12 }; },
    wrongSpace: f => { f.host.evidence.afterCapture.selectedSpaces = ['other']; f.host.evidence.afterCapture.visibleSpaces = ['other']; },
    hiddenPanel: f => { f.host.evidence.afterCapture.visibility = 'hidden'; },
    zeroViewport: f => { f.host.evidence.beforeCapture.width = 0; }
})) test(`native menu host rejects ${name}, closes once and never retries`, async () => {
    const f = fixture(); change(f); await assert.rejects(openTabMenuNativeHost(f.options));
    assert.equal(f.calls.filter(Array.isArray).length, 1);
    assert.equal(f.calls.filter(x => x === 'close').length, 1);
});
test('missing native adapter cannot fall back to a regular extension tab', async () => {
    await assert.rejects(openTabMenuNativeHost({ extensionId, windowId, spaceId }));
});
test('uncertain opener failure propagates unchanged without a second invocation', async () => {
    const failure = Object.freeze(new Error('uncertain native open')); let calls = 0;
    await assert.rejects(openTabMenuNativeHost({ extensionId, windowId, spaceId,
        nativeSidebar: async () => { calls++; throw failure; } }), error => error === failure);
    assert.equal(calls, 1);
});
test('cleanup failure is recorded without replacing the exact primary read failure', async () => {
    const f = fixture(), failure = Object.freeze(new Error('read failed'));
    f.host.page.evaluate = async () => { throw failure; };
    f.host.close = async () => { f.calls.push('close'); throw new Error('cleanup failed'); };
    await assert.rejects(openTabMenuNativeHost(f.options), error => error === failure);
    assert.equal(f.calls.filter(x => x === 'close').length, 1);
    assert.deepEqual(f.records, [{ phase: 'native-host-cleanup-failed', error: 'cleanup failed' }]);
});

function searchFixture({ hidden = true, query = 'nonce' } = {}) {
    const calls = [], backgroundPage = {};
    const searchPage = { async waitForFunction(callback, options) {
        calls.push('observe-hidden'); assert.deepEqual(options, { polling: 50 });
        assert(vm.runInNewContext(`(${callback})()`, { document: { visibilityState: hidden ? 'hidden' : 'visible' } }));
    }, async $eval(selector, callback) { calls.push('read-query'); assert.equal(selector, '[data-testid="spotlight-input"]'); return callback({ value: query }); } };
    return { calls, options: { backgroundPage, searchPage, query: 'nonce',
        ui: async (page, _label, action) => { assert.equal(page, backgroundPage); calls.push('foreground-existing-page'); return action(); } } };
}
test('native host preserves the mounted hidden-query prerequisite with no new input or search', async () => {
    const f = searchFixture(); await hideTabMenuAliasSearch(f.options);
    assert.deepEqual(f.calls, ['foreground-existing-page', 'observe-hidden', 'read-query']);
});
for (const options of [{ hidden: false }, { query: 'changed' }]) test(`hidden search fails closed for ${JSON.stringify(options)}`, async () => {
    const f = searchFixture(options); await assert.rejects(hideTabMenuAliasSearch(f.options));
    assert.equal(f.calls.filter(x => x === 'foreground-existing-page').length, 1);
});

const runner = (await readFile(new URL('../../scripts/paired-chrome-smoke.mjs', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const menus = (await readFile(new URL('../../scripts/paired-chrome-tab-menu.mjs', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
test('existing native opener installs its own event observers before its one helper, also in isolated mode', async () => {
    const start = runner.indexOf('async function nativeTodayMoveSidebar('), end = runner.indexOf('\n// This adapter operates', start);
    assert(start > 0 && end > start); const source = runner.slice(start, end);
    const opened = [], closed = [], calls = [], failure = new Error('stop before native input');
    const realm = vm.createContext({ chrome: { sidePanel: {
        onOpened: { addListener: listener => opened.push(listener) }, onClosed: { addListener: listener => closed.push(listener) }
    } } });
    const adapter = vm.runInNewContext(`(${source})`, {
        arcifyOptions: { evaluate: callback => vm.runInContext(`(${callback})()`, realm) },
        newTabPage: async url => { calls.push(url); assert.equal(opened.length, 1); assert.equal(closed.length, 1); throw failure; }
    });
    await assert.rejects(adapter({ revealSpaceId: spaceId }), error => error === failure);
    assert.deepEqual(calls, ['chrome://newtab/']);
    assert(source.includes('await sidebarEnter(helper.page,'));
    assert(source.includes('await captureNativeSidebar(eventCount,'));
    assert(source.includes('await resolveNativeSidebarTarget()'));
    assert(source.includes('await closeNativeSidebar()'));
    assert(source.includes('if (exists) await chrome.tabs.remove(id)'));
});
test('fixture retains strict identity/menu assertions, hidden alias semantics and native cleanup before tab cleanup', () => {
    assert.doesNotMatch(menus, /newTabPage\(`chrome-extension:\/\/\$\{arcifyId\}\/sidebar\.html`/);
    assert.match(menus, /openTabMenuNativeHost\(\{ nativeSidebar, extensionId: arcifyId, windowId, spaceId: space.id, record \}\)/);
    assert.match(menus, /assert.equal\(searchSurface.visibility, 'hidden'/);
    assert.match(menus, /menuSelector, label, ui, screenshot, poll, record, nativePanel: true/);
    assert.match(menus, /assert.notEqual\(await sidebar.page.\$eval\('#favoritesDropStatus'/);
    const cleanup = menus.slice(menus.lastIndexOf('await finishBookmarkFixture(['));
    assert(cleanup.indexOf('await sidebar.close()') < cleanup.indexOf('chrome.tabs.remove(present)'));
    for (const token of ['assertTabMenuCancelled(before, after)', 'assert.deepEqual(preservedAfter, preservedBefore',
        'assertTabMenuDuplicated(beforeDuplicate, afterDuplicate', "await page.waitForSelector(menuSelector, { visible: true })"])
        assert(menus.includes(token), token);
});

function nativeAdapterFixture(options = {}) {
    const start = runner.indexOf('async function nativeTodayMoveSidebar('), end = runner.indexOf('\n// This adapter operates', start);
    const source = runner.slice(start, end), calls = [], opened = [], closed = [];
    const report = { diagnostics: [] }, helperId = 41;
    let stateReads = 0, panelOpen = !!options.preexisting, launcherPresent = !options.helperAbsent;
    const realm = vm.createContext({ chrome: { sidePanel: {
        onOpened: { addListener: fn => opened.push(fn) }, onClosed: { addListener: fn => closed.push(fn) }
    }, tabs: {
        query: async () => { calls.push('query-launcher'); if (options.queryError) throw options.queryError; return launcherPresent ? [{ id: helperId, windowId }, { id: 99, windowId: 8 }] : [{ id: 99, windowId: 8 }]; },
        remove: async id => { calls.push(['remove', id]); assert.equal(id, helperId); if (options.removeError) throw options.removeError; launcherPresent = false; }
    } } });
    const nativeContext = { contextType: 'SIDE_PANEL', documentUrl: url, contextId: 'native', incognito: false, windowId: -1 };
    const helperPage = { waitForSelector: async () => calls.push('selector') }, panelPage = {};
    const adapter = vm.runInNewContext(`(${source})`, {
        assert, assertNativeSidebarEvidence, AggregateError, fixture: { windowA: windowId }, arcifyId: extensionId,
        sidebarSelector: '#sidebar-command', report,
        arcifyOptions: { evaluate: (callback, argument) => vm.runInContext(`(${callback})`, realm)(argument) },
        newTabPage: async () => { calls.push('create-helper'); return { page: helperPage, tab: { id: helperId, windowId } }; },
        waitSidebarCommand: async () => { calls.push('command'); if (options.commandError) throw options.commandError; },
        search: async () => calls.push('search'),
        nativePanelState: async () => {
            calls.push('state'); stateReads++;
            if (options.stateErrorAt === stateReads) throw options.stateError;
            return { contexts: panelOpen ? [{ ...nativeContext, ...options.contextChange }] : [],
                events: JSON.parse(JSON.stringify(realm.__pairedSidebarEvents || [])) };
        },
        sidebarEnter: async () => {
            calls.push('enter');
            if (options.emitOpen !== false) {
                panelOpen = true;
                for (const listener of opened) listener({ windowId: options.receiptWindow ?? windowId, path: 'sidebar.html' });
            }
            if (options.gestureError) throw options.gestureError;
        },
        waitSidebarSuccess: async () => { if (options.successError) throw options.successError; },
        captureNativeSidebar: async () => { calls.push('capture'); if (options.captureError) throw options.captureError; return { captured: true }; },
        resolveNativeSidebarTarget: async () => { calls.push('resolve'); if (options.resolveError) throw options.resolveError;
            return { page: panelPage, hosting: { tab: null, windowId, ...options.hostingChange } }; },
        observePage: async page => page,
        closeNativeSidebar: async () => { calls.push('close-panel'); if (options.closeError) throw options.closeError; panelOpen = false; },
        saveReport: async () => { calls.push('record'); if (options.recordError) throw options.recordError; }
    });
    return { adapter, calls, report, helperId, launcherPresent: () => launcherPresent, panelOpen: () => panelOpen };
}
const removedIds = calls => calls.filter(Array.isArray).map(call => call[1]);
test('native adapter closes the proved panel before its exact launcher; repeated close never replays cleanup', async () => {
    const f = nativeAdapterFixture(), host = await f.adapter();
    const result = await host.close(); await host.close();
    assert.deepEqual(JSON.parse(JSON.stringify(result)), { tabId: f.helperId, windowId });
    assert.deepEqual(f.calls.slice(-3), ['close-panel', 'query-launcher', ['remove', f.helperId]]);
    assert.equal(f.calls.filter(call => call === 'close-panel').length, 1);
    assert.deepEqual(removedIds(f.calls), [f.helperId]); assert.equal(f.report.diagnostics.length, 0);
});
test('native close rejection still removes owned launcher and fails without replay', async () => {
    const failure = new Error('panel close failed'), f = nativeAdapterFixture({ closeError: failure }), host = await f.adapter();
    await assert.rejects(host.close(), error => error instanceof AggregateError && error.errors[0] === failure);
    await assert.rejects(host.close());
    assert.deepEqual(removedIds(f.calls), [f.helperId]); assert.equal(f.launcherPresent(), false);
    assert.equal(f.calls.filter(call => call === 'close-panel').length, 1);
    assert.deepEqual([...f.report.diagnostics[0].errors], [failure.message]);
});
test('setup failure before any opener never probes or closes an unproved panel and still removes launcher', async () => {
    const original = Object.freeze(new Error('command failed')), f = nativeAdapterFixture({ commandError: original,
        stateErrorAt: 1, stateError: new Error('state failed'), preexisting: true });
    await assert.rejects(f.adapter(), error => error === original);
    assert(!f.calls.includes('state')); assert(!f.calls.includes('close-panel'));
    assert.deepEqual(removedIds(f.calls), [f.helperId]); assert.equal(f.panelOpen(), true);
});
test('state-probe failure after uncertain open cannot mask frozen primary failure or block launcher cleanup', async () => {
    const original = Object.freeze(new Error('uncertain Enter')), probe = new Error('state failed');
    const f = nativeAdapterFixture({ gestureError: original, stateErrorAt: 2, stateError: probe });
    await assert.rejects(f.adapter(), error => error === original);
    assert(!f.calls.includes('close-panel')); assert.deepEqual(removedIds(f.calls), [f.helperId]);
    assert.deepEqual([...f.report.diagnostics[0].errors], [probe.message]);
    assert.equal(f.report.diagnostics[0].primaryError, original.message);
});
test('a fresh native context/open receipt and exact renderer allow one owned-panel cleanup after setup failure', async () => {
    const original = new Error('capture failed'), f = nativeAdapterFixture({ captureError: original });
    await assert.rejects(f.adapter(), error => error === original);
    assert.equal(f.calls.filter(call => call === 'close-panel').length, 1);
    assert.deepEqual(removedIds(f.calls), [f.helperId]);
    assert(f.calls.indexOf('close-panel') < f.calls.indexOf('query-launcher'));
});
for (const options of [{ emitOpen: false }, { receiptWindow: 8 }, { contextChange: { contextType: 'TAB' } },
    { hostingChange: { tab: { id: 99 } } }, { hostingChange: { windowId: 8 } }]) {
    test(`uncertain setup does not close an unproved panel: ${JSON.stringify(options)}`, async () => {
        const original = new Error('capture failed'), f = nativeAdapterFixture({ ...options, captureError: original });
        await assert.rejects(f.adapter(), error => error === original);
        assert(!f.calls.includes('close-panel')); assert.deepEqual(removedIds(f.calls), [f.helperId]);
    });
}
test('pre-existing panel is never adopted or closed; launcher is removed before propagating failure', async () => {
    const f = nativeAdapterFixture({ preexisting: true }); await assert.rejects(f.adapter(), /pre-existing/);
    assert(!f.calls.includes('enter')); assert(!f.calls.includes('close-panel'));
    assert.deepEqual(removedIds(f.calls), [f.helperId]); assert.equal(f.panelOpen(), true);
});
test('already-absent launcher needs no remove; proved panel cleanup still completes', async () => {
    const f = nativeAdapterFixture({ helperAbsent: true }), host = await f.adapter(); await host.close();
    assert(f.calls.includes('close-panel')); assert.deepEqual(removedIds(f.calls), []);
});
test('launcher removal failure fails normal teardown and retains its exact error after panel close', async () => {
    const failure = new Error('remove failed'), f = nativeAdapterFixture({ removeError: failure }), host = await f.adapter();
    await assert.rejects(host.close(), error => error instanceof AggregateError && error.errors[0] === failure);
    assert.deepEqual(removedIds(f.calls), [f.helperId]); assert.equal(f.panelOpen(), false);
    assert.deepEqual([...f.report.diagnostics[0].errors], [failure.message]);
});
test('cleanup lookup failure is retained without guessing a removal or masking the primary error', async () => {
    const original = Object.freeze(new Error('command failed')), queryError = new Error('launcher read failed');
    const f = nativeAdapterFixture({ commandError: original, queryError });
    await assert.rejects(f.adapter(), error => error === original);
    assert.deepEqual(removedIds(f.calls), []); assert.deepEqual([...f.report.diagnostics[0].errors], [queryError.message]);
});
test('multiple cleanup and record failures preserve frozen primary Error and retain all messages', async () => {
    const original = Object.freeze(new Error('setup failed'));
    const f = nativeAdapterFixture({ captureError: original, closeError: new Error('close failed'),
        removeError: new Error('remove failed'), recordError: new Error('record failed') });
    await assert.rejects(f.adapter(), error => error === original);
    assert.deepEqual(removedIds(f.calls), [f.helperId]); assert.equal(f.calls.filter(call => call === 'close-panel').length, 1);
    assert.deepEqual([...f.report.diagnostics[0].errors], ['close failed', 'remove failed', 'Report: record failed']);
});
test('normal teardown aggregates close, removal and recording failure without retry', async () => {
    const closeError = new Error('close failed'), removeError = new Error('remove failed'), recordError = new Error('record failed');
    const f = nativeAdapterFixture({ closeError, removeError, recordError }), host = await f.adapter();
    await assert.rejects(host.close(), error => error instanceof AggregateError &&
        error.errors[0] === closeError && error.errors[1] === removeError && error.errors[2] === recordError);
    assert.deepEqual(removedIds(f.calls), [f.helperId]); assert.equal(f.calls.filter(call => call === 'close-panel').length, 1);
});

test('proved native adapter can remove only its launcher early and still close the panel safely', async () => {
    const f = nativeAdapterFixture(), host = await f.adapter();
    const removed = await host.removeLauncher(); await host.removeLauncher();
    assert.deepEqual(JSON.parse(JSON.stringify(removed)), { tabId: f.helperId, windowId });
    assert.deepEqual(removedIds(f.calls), [f.helperId]);
    assert.equal(f.panelOpen(), true);
    assert.equal(f.calls.filter(call => call === 'close-panel').length, 0);
    await host.close(); await host.close();
    assert.equal(f.panelOpen(), false);
    assert.deepEqual(removedIds(f.calls), [f.helperId]);
    assert.equal(f.calls.filter(call => call === 'close-panel').length, 1);
});
