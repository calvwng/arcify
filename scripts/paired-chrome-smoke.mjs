#!/usr/bin/env node
import { exerciseSpotlightSplit, serveSpotlightSplitFixture, SPOTLIGHT_SPLIT_CASE_NAME } from './paired-chrome-spotlight-split.mjs';
import { exerciseNativeTodaySplit, serveNativeSplitFixture, NATIVE_SPLIT_CASE_NAME } from './paired-chrome-native-split.mjs';
import { captureNativeSplitWindow } from './paired-chrome-native-split-capture.mjs';
import { exerciseManagementScroll } from './paired-chrome-management-scroll.mjs';
import { exerciseTodayCreationOrder, serveTodayOrderFixture } from './paired-chrome-today-order.mjs';
import { exerciseTodayMove, serveTodayMoveFixture } from './paired-chrome-today-move.mjs';
import { exerciseSavedMove, serveSavedMoveFixture } from './paired-chrome-saved-move.mjs';
import { exerciseNativeNewTabRow, recordNewTabRowEvidence } from './paired-chrome-newtab-row.mjs';
import { exerciseTodaySelection } from './paired-chrome-today-selection.mjs';
import { exerciseSpaceContextBasics } from './paired-chrome-space-context.mjs';
import { exerciseMoveToNewWindow } from './paired-chrome-move-window.mjs';
import { exerciseTabMenuActions, serveTabMenuFixture } from './paired-chrome-tab-menu.mjs';
import { exerciseOrdinaryFavorites, serveOrdinaryFavoriteFixture, summarizeFavoriteOwnership, seedFocusedReloadSpacePins } from './paired-chrome-ordinary-favorites.mjs';
import { normalizeReloadControlWindow } from './paired-chrome-control-window.mjs';
import { GLOBAL_FAVORITES_FEATURE } from '../spotlight-bridge-protocol.js';
import { exerciseOverlayRecovery, overlayRecoveryFixtureResponse } from './paired-chrome-overlay-recovery.mjs';
import { exerciseSpotlightActions, serveSpotlightActionFixture, SPOTLIGHT_ACTION_CASE_NAME } from './paired-chrome-spotlight-actions.mjs';
import { exerciseSpotlightNavigation, serveSpotlightNavigationFixture, SPOTLIGHT_NAVIGATION_CASE_NAME } from './paired-chrome-spotlight-navigation.mjs';
import { exerciseSpotlightTabCommands, serveSpotlightTabFixture, SPOTLIGHT_TAB_CASE_NAME } from './paired-chrome-spotlight-tabs.mjs';
import { exerciseSpotlightArchiveOpen, exerciseSpotlightArchiveReopen, serveSpotlightArchiveFixture, SPOTLIGHT_ARCHIVE_OPEN_CASE_NAME, SPOTLIGHT_ARCHIVE_REOPEN_CASE_NAME } from './paired-chrome-spotlight-archive.mjs';
import { randomBytes } from 'node:crypto';
import { exerciseSpaceTheme } from './paired-chrome-space-theme.mjs';
import { exerciseSpotlightOptionsAppearance } from './paired-chrome-spotlight-appearance.mjs';
import { exerciseSidebarAppearance } from './paired-chrome-sidebar-appearance.mjs';
import { exerciseBookmarkMultiSelection, assertNativeDragSourceStable } from './paired-chrome-bookmark-selection.mjs';
/**
 * GitHub-hosted, real-Chrome paired-extension fixture. No mocked Chrome APIs.
 * Do not invoke locally. Syntax checks (node --check) do not launch a browser.
 * Chrome uses its normal sandbox. A launch denial is a failed check, never a
 * reason to change runner policy or disable Chrome security.
 */
import assert from 'node:assert/strict';
import { createPairedChromeRunReport, beginPairedChromeCase, assertPairedChromeRunPassed } from './paired-chrome-run-plan.mjs';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from './paired-chrome-runtime/index.mjs';
import { assertNativeSidebarEvidence, assertSidebarHelperUnchanged, readNativeSidebarRender, nativeSidebarRenderReady, nativeSidebarRenderIdentity, createNativeSidebarReadiness, assertNativeSidebarScreenshot, revealNativeSidebarSpace, readSpotlightRows, assertMatchedActionFirst, evaluateWithoutGesture } from './paired-chrome-sidebar.mjs';
import { performVisibleAction, performVisibleClick, replaceInputText, captureVisibleFailurePage, clickFreshResult, selectResultWithKeyboard, assertNoPageErrors, locateFreshDragGeometry, attachCreatedFixtureTab } from './paired-chrome-ui.mjs';
import { readNewTabReuseState, assertActiveNewTabReused, isSpotlightNewTabTarget } from './paired-chrome-newtab.mjs';
import { locateRemainingNewTabResult } from './paired-chrome-newtab-result-readiness.mjs';
import { KEYBOARD_CSP, KEYBOARD_HTML, KEYBOARD_SCRIPT, spotlightSurface, assertHostKeyboardIsolated } from './paired-chrome-keyboard.mjs';
import { exercisePersistentFavorites } from './paired-chrome-persistent-favorites.mjs';
import { exerciseSavedFavoriteMarker } from './paired-chrome-favorites-marker.mjs';
import { serveFavoriteIconFixture } from './paired-chrome-favorite-icons.mjs';
import { snapshotChromeLaunchOptions } from './paired-chrome-browser-restart.mjs';
import { exerciseFavoritesBrowserRestart } from './paired-chrome-favorites-restart.mjs';
import { exerciseFavoriteSearch } from './paired-chrome-favorite-search.mjs';
import { assertSavedBookmarkFavorite } from './paired-chrome-favorites.mjs';
import { readSpaceDropMarker, assertSpaceDropMarker, readMarkerScreenshotPixels, assertMarkerScreenshotPixels, installSpaceDragObservation, readSpaceDragObservation, recordSpaceDragObservation, assertAcceptedSpaceDragover } from './paired-chrome-space-marker.mjs';
import { readDeveloperModeDomState, developerModeStateReady, enableDeveloperModeViaUi, findInstalledExtension, waitForEnabledExtension } from './paired-chrome-extensions.mjs';
import { waitForExtensionWorkerIdentity, assertNoWorkerExceptions, findExactWorkerTarget, terminateObservedWorker, requestObservedExtensionReload, reloadObservedExtension, observeTargetDiagnostics, assertNoTargetCrashes } from './paired-chrome-worker.mjs';
import { installColdSetupObserver, readColdSetupObserver, stopColdSetupObserver, waitForColdSetupQuiescence } from './paired-chrome-cold-setup.mjs';
import { CHROME_EXECUTABLE, inspectInstalledChromeRuntime, inspectChromeProcessRuntime,
    validateChromeLaunchArguments, validateNamespaceLaunchEnvironment, validateChromeNamespaceSandboxStatus } from './paired-chrome-sandbox.mjs';

if (process.env.GITHUB_ACTIONS !== 'true' || process.env.CI !== 'true') {
    throw new Error('This browser fixture is restricted to its dedicated GitHub Actions job. Do not run it locally.');
}
if (process.getuid?.() === 0) throw new Error('Run as the ordinary runner user; this fixture will not disable the Chrome sandbox for root.');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const COMPANION = resolve(process.argv[2] || resolve(ROOT, '../arcify-spotlight'));
const PINNED_SPOTLIGHT = '364479205a8589733943bb2e7d107120f6660c09';
const stepNames = [
    'Sandboxed Chrome startup and exact extension identities',
    'Unpaired rejection and options-UI pairing',
    'Real bookmark/tab fixtures and window-scoped snapshots',
    'Spotlight overlay search selects the exact live tab',
    'Duplicate bookmark identities remain separate through UI selection',
    'Overlay current-tab URL navigation preserves identity',
    'Empty-space helper selection and new-tab URL opening',
    'Chrome new-tab override renders Spotlight',
    'Today New Tab row launches Spotlight and reuses its helper',
    'Group sync on/off preserves authoritative spaces',
    'Real malformed and wrong-window requests are rejected',
    'MV3 worker stop/wake preserves duplicate-request journal',
    'Extension reload reconnects without changing space identities',
    'Command registration is present (no OS shortcut assertion)',
    'Startup sidebar suggestion and trusted Enter open the native panel',
    'Trusted Enter opens the sidebar with a genuinely cold Arcify worker',
    'Ordinary overlay sidebar command opens the native panel',
    'Sidebar command rejects non-gesture, malformed and revoked-peer requests',
    'Startup suggestion preserves typing and manual selection',
    'Fuzzy action ranking retains web search in new-tab and overlay UI',
    'Live New Tab identities refresh without stale or self-helper suggestions',
    'Logical Arcify updates refresh Spotlight without native tab events',
    'Unsupported generic extension URLs are hidden while live extension tabs still switch',
    'Controlled Spotlight launches reuse the active browser New Tab alias without losing input',
    'Overlay typing stays isolated from pre-existing host shortcuts under strict CSP',
    'Sidebar drag anchors match saved tab and folder destinations',
    'Saved bookmark drops create and reuse native Favorites without changing the source',
    'Space drag and keyboard reordering persist without switching workspaces',
    'Persistent Favorites close, reopen, share and explicitly remove without losing source bookmarks',
    'Spotlight finds closed Favorites and preserves saved identity through live closure',
    'Saved Favorites real-mouse destination markers match durable reordering without tab or bookmark changes',
    'Visible bookmark multi-selection batches exact Favorites without altering source bookmarks',
    'Full same-profile browser restart preserves saved Favorites without guessing restored bindings',
    'Sidebar appearance persists compact fixed Favorites and usable Space headers through real options input',
    'Native sidebar management preserves offscreen-active scroll and focus while deliberate activation still reveals',
    'Today multi-selection saves an explicitly named folder without closing tabs and refreshes paired search',
    'Ordinary Favorites close with one native Ctrl+W, remain global and retain witnessed reload identity',
    'Space menus edit exact inactive names, colors, icons and folders with safe Delete cancellation',
    'Tab menus preserve exact aliases and saved-pin identities through real editing, copy, mute, duplicate and removal',
    'Today real drag and keyboard create native Split View pairs without replacing pages',
    'Today Move preserves exact single and multiple native tabs with group sync off',
    'Today Move preserves active native tabs and inverted order with group sync on',
    'Today creation has independent prospective top and opener order with group sync off',
    'Today creation preserves manual order and native projection with group sync on',
    'Saved pin and nested folder Move preserves all linked windows and exact identities with group sync off',
    'Saved pin and nested folder Move preserves inverted order and all-window native projection with group sync on',
    'Native Space custom tint and appearance retain real named groups, readable controls and exact identities',
    'Spotlight options appearance follows System and explicit modes through real controls and first paint',
    'Native Spotlight command recovers dormant and orphaned overlays and wakes a cold worker without losing the source',
    'Initial Spotlight actions preserve exact live and saved identities through overlay and browser New Tab input',
    'Spotlight Space navigation uses genuine destination pickers and preserves exact Today/native identities',
    'Spotlight tab commands preserve exact live and saved identities through trusted input',
    'Spotlight Open Archive requires trusted input and the existing popup in the native Side Panel',
    'Spotlight Archive reopens exact same-address entries in their original Space and source window without replay',
    'Spotlight Split and End Split keep exact left and right source panes and original documents'
];
assert.equal(stepNames[49], SPOTLIGHT_ACTION_CASE_NAME, 'Initial Spotlight action case must retain its reviewed identity.');
assert.equal(stepNames[50], SPOTLIGHT_NAVIGATION_CASE_NAME, 'Spotlight navigation case must retain its reviewed identity.');
assert.equal(stepNames[51], SPOTLIGHT_TAB_CASE_NAME, 'Spotlight tab-command case must retain its reviewed identity.');
assert.equal(stepNames[52], SPOTLIGHT_ARCHIVE_OPEN_CASE_NAME, 'Spotlight Archive opening case must retain its identity.');
assert.equal(stepNames[54], SPOTLIGHT_SPLIT_CASE_NAME, 'Spotlight Split case retains its mandatory source-pane identity.');
assert.equal(stepNames[53], SPOTLIGHT_ARCHIVE_REOPEN_CASE_NAME, 'Spotlight Archive reopen case must retain its identity.');
const report = {
    ...createPairedChromeRunReport(stepNames, process.env.ARCIFY_PAIRED_RUN_MODE),
    schemaVersion: 1, startedAt: new Date().toISOString(), status: 'running',
    verification: 'Real Chrome with both production extension builds; no mocked Chrome APIs or transport.',
    environment: { githubActions: true, chromeMode: 'headed Chrome under Xvfb virtual display', runnerOS: process.env.RUNNER_OS, node: process.version,
        workflowSha: process.env.GITHUB_SHA, requestedArcifyHead: process.env.ARCIFY_TEST_HEAD,
        pullRequestHead: process.env.ARCIFY_PR_HEAD || null, githubRunId: process.env.GITHUB_RUN_ID,
        imageOS: process.env.ImageOS, imageVersion: process.env.ImageVersion, runnerUid: process.getuid?.() },
    screenshots: [], diagnostics: [], targetLifecycle: [],
    limits: [
        'Space theme and Spotlight options require real hosted input, screenshots and passive first-paint evidence. System preference changes use Chrome rendering-media emulation; native OS color picker, physical OS appearance changes and Helium remain manual.',
        'Space emoji proof uses trusted Chrome text input and genuine Ctrl+V from the disposable fixture clipboard; OS emoji picker, IME candidate windows/composition, physical typing and Helium remain manual. Icon-only names retain native title and accessibility labels with real hover/focus; browser-chrome tooltip painting is not captured by page screenshots.',
        'Outside-focus menu checks use ordinary sidebar.html tabs and a separate disposable localhost browser window with trusted mouse/key input. Passive lifecycle evidence distinguishes visible-window blur from hidden-document dismissal; actual native-panel external focus and Helium remain manual.',
        'General workspace rendering regressions use sidebar.html in a regular tab. Command, Today Move, Space theme and unified New Tab row checks separately require native SIDE_PANEL contexts, onOpened events and rendered panel content; browser-chrome docking and Helium behavior remain manual.',
        'Startup suggestion delivery is exercised with an authenticated offer to an existing new-tab page. Full browser onStartup scheduling/session restore and initial omnibox focus are not exercised; Enter tests explicitly focus Spotlight.',
        'Case 13 reads command registration only. Case 48 separately requires one guarded native XTEST Alt+T per recovery scenario, real browser command dispatch, reload invalidation and cold-worker target ordering. Physical keyboard hardware and Helium shortcut dispatch remain untested.',
        'The ordinary-Favorite close case separately sends one native XTEST Ctrl+W to the verified Chrome window under CI Xvfb and requires exact tab/target destruction. It does not claim physical keyboard hardware or Helium shortcut acceptance.',
        'Independent overlay cases wait for the previous close animation to remove its host. Rapid close/reopen stress is not exercised.',
        'The runner uses its installed stable Chrome and existing AppArmor policy, with actual Namespace/PID/network/seccomp sandbox evidence required. No privileged helper is manually selected, repaired or modified. The native-split job may first update the installed stable package from the exact official Google HTTPS package URL when the image is older than 155, with verified TLS and an explicit non-signature provenance receipt; other jobs keep the image version. Package/runtime evidence is recorded for each run.',
        'A disposable CI profile is used. The final Favorites case performs one graceful full-process restart with the same profile; arbitrary crash/session restoration, store-installed builds, existing user profiles and manual extension-install UI remain untested.',
        'Favorites rendering uses a regular sidebar.html tab with real mouse input, marker screenshot pixels and decoded retained favicon pixels. Native panel layout, physical close shortcuts and physical Escape during native dragging remain manual. Favorites cancellation uses documented Input.cancelDragging with trusted dragend/no-drop evidence; DOM Escape handling is covered separately by unit tests. Favicon pages and their PNG response are served by the real localhost fixture; Chrome may resize or re-encode the local cache.',
        'Optional external HTTPS autocomplete is blocked with DevTools Network request blocking; no fake suggestion responses are supplied.',
        "Worker termination uses Chrome's documented Puppeteer WebWorker.close API; real raw target destruction and a distinct restarted worker are required. This is not a full browser restart."
    ]
};
const OUTPUT = resolve(ROOT, report.runMode === 'archive-reopen' ? 'test-results/paired-chrome-archive-reopen' : report.runMode === 'archive-actions' ? 'test-results/paired-chrome-archive-actions' : report.runMode === 'extended-actions' ? 'test-results/paired-chrome-extended-actions' : report.runMode === 'recovery-actions' ? 'test-results/paired-chrome-recovery-actions' : report.runMode === 'appearance-actions' ? 'test-results/paired-chrome-appearance-actions' : report.runMode === 'native-split' ? 'test-results/paired-chrome-native-split' : report.runMode === 'full' ? 'test-results/paired-chrome' : 'test-results/paired-chrome-favorite-lifecycle');
let launchOptions, persistentFixture, ordinaryFixture;
let browser, server, profile, arcifyId, spotlightId, arcifyOptions, spotlightOptions, fixture, sourcePage, sidebarFixture;
const observedPages = new Set();
const networkTargets = new WeakMap();
const networkSessions = [];
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const head = path => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path, encoding: 'utf8' }).trim();
const slug = value => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
async function saveReport() { await writeFile(resolve(OUTPUT, 'report.json'), JSON.stringify(report, null, 2)); }
async function recordUi(checkpoint) {
    report.uiActions ||= [];
    report.uiActions.push(checkpoint);
    await saveReport();
}
async function ui(page, label, action) {
    return performVisibleAction(page, label, action, recordUi);
}
async function clickUI(page, selector, readySelector) { return performVisibleClick(page, selector, recordUi, readySelector); }
async function typeUI(page, selector, text) { return ui(page, `Type ${selector}`, () => page.type(selector, text)); }
async function poll(read, accept, label, timeout = 20_000) {
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
        last = await read();
        if (accept(last)) return last;
        await sleep(100);
    }
    throw new Error(`Timed out waiting for ${label}; last observation: ${JSON.stringify(last)}`);
}
async function screenshot(page, label, required = true, { fullPage = true } = {}) {
    if (!page || page.isClosed()) {
        if (required) throw new Error(`Required screenshot has no open page: ${label}`);
        return;
    }
    const filename = `${String(report.screenshots.length + 1).padStart(2, '0')}-${slug(label)}.png`;
    try {
        await page.screenshot({ path: resolve(OUTPUT, filename), fullPage, ...(fullPage ? {} : { captureBeyondViewport: false }) });
        const captured = { filename, label, url: page.url(), capturedAt: new Date().toISOString() };
        report.screenshots.push(captured);
        return captured;
    } catch (error) {
        report.diagnostics.push({ type: 'screenshot-error', label, message: error.message });
        if (required) throw new Error(`Required screenshot failed (${label}): ${error.message}`);
    }
}
async function blockExternalHttps(target) {
    if (!['page', 'service_worker'].includes(target.type())) return;
    if (networkTargets.has(target)) return networkTargets.get(target);
    // Share the actual in-flight setup, including rejection. A targetcreated
    // observer must not make a later required setup falsely appear successful.
    const pending = (async () => {
        const session = await target.createCDPSession();
        observeTargetDiagnostics(session, `network:${target.type()}:${target.url()}`, event => report.targetLifecycle.push(event));
        try {
            await session.send('Network.enable');
            await session.send('Network.setBlockedURLs', { urls: ['https://*'] });
            networkSessions.push(session);
            return session;
        } catch (error) {
            await session.detach().catch(() => {});
            throw error;
        }
    })();
    networkTargets.set(target, pending);
    return pending;
}
async function observePage(page) {
    if (!observedPages.has(page)) {
        observedPages.add(page);
        page.setDefaultTimeout(20_000);
        page.on('pageerror', error => report.diagnostics.push({ type: 'pageerror', url: page.url(), message: error.message, stack: error.stack, observedAt: new Date().toISOString() }));
        page.on('console', message => {
            if (['error', 'warn'].includes(message.type())) report.diagnostics.push({ type: `console-${message.type()}`, url: page.url(), message: message.text().slice(0, 3000) });
        });
    }
    await blockExternalHttps(page.target());
    return page;
}
async function step(name, operation, { windowIsolation = true } = {}) {
    const check = beginPairedChromeCase(report, name);
    check.status = 'running'; check.startedAt = new Date().toISOString();
    await saveReport();
    try {
        const detail = await operation();
        // Preserve completed state evidence even if a later isolation/error gate fails.
        if (detail !== undefined) check.details = detail;
        if (windowIsolation && fixture?.windowBBaseline) {
            assert.deepEqual(await windowBState(), fixture.windowBBaseline, 'An operation in window A changed window B tabs or memberships.');
            check.windowBUnchanged = true;
        }
        if (!windowIsolation) check.windowIsolationLimit = 'Final full-process restart deliberately invalidates prior browser-session window/tab IDs; preservation is checked against fresh postrestart identities.';
        assertNoTargetCrashes(report.targetLifecycle);
        assertNoPageErrors(report.diagnostics);
        assert(!detail?.skipped, 'A selected paired-Chrome case must pass without skipping its assertions.');
        check.status = 'passed';
        console.log(`${check.status.toUpperCase()}: ${name}`);
    } catch (error) {
        check.status = 'failed'; check.error = { message: error.message, stack: error.stack };
        throw error;
    } finally { check.finishedAt = new Date().toISOString(); await saveReport(); }
}
async function internal(page, message) {
    return page.evaluate(message => chrome.runtime.sendMessage(message), message);
}
async function external(page, peerId, command, payload, requestId = `ci-${crypto.randomUUID()}`) {
    return page.evaluate(({ peerId, message }) => chrome.runtime.sendMessage(peerId, message), {
        peerId, message: { type: 'arcify-bridge', version: 1, requestId, command, ...payload }
    });
}
async function bridge(command, payload = {}, requestId) {
    const response = await external(spotlightOptions, arcifyId, command, { windowId: fixture.windowA, supportedFeatures:[GLOBAL_FAVORITES_FEATURE], ...payload }, requestId);
    assert.equal(response?.ok, true, JSON.stringify(response));
    assert.equal(response.type, 'arcify-bridge'); assert.equal(response.version, 1); assert.equal(response.role, 'arcify');
    return response;
}
async function snapshot(windowId = fixture.windowA) { return (await bridge('snapshot', { windowId })).snapshot; }
async function windowBState() {
    const state = await snapshot(fixture.windowB);
    return { activeSpaceId: state.activeSpaceId,
        tabs: state.tabs.map(({ id, url, active, pinned, spaceId }) => ({ id, url, active, pinned, spaceId })).sort((a, b) => a.id - b.id),
        spaces: state.spaces.map(({ id, tabIds, pinnedTabIds, temporaryTabIds }) => ({ id, tabIds, pinnedTabIds, temporaryTabIds })) };
}
async function tab(id) { return arcifyOptions.evaluate(id => chrome.tabs.get(id), id); }
async function tabsIn(windowId) { return arcifyOptions.evaluate(windowId => chrome.tabs.query({ windowId }), windowId); }
async function activate(id) { await arcifyOptions.evaluate(async id => { const tab = await chrome.tabs.update(id, { active: true }); await chrome.windows.update(tab.windowId, { focused: true }); }, id); }
async function pageForUrl(url) {
    const target = await browser.waitForTarget(target => target.type() === 'page' && target.url() === url, { timeout: 20_000 });
    return observePage(await target.page());
}
// Fixture-only attachment to one fresh saved page. Equal URLs never select an older target.
async function openSavedMovePage({ windowId, spaceId, bookmarkId, url }) {
    const beforeTargets = new Set(browser.targets());
    const beforeTabs = new Set((await arcifyOptions.evaluate(() => chrome.tabs.query({}))).map(tab => tab.id));
    const opened = await bridge('openBookmark', { windowId, spaceId, bookmarkId });
    assert(Number.isSafeInteger(opened.tabId) && !beforeTabs.has(opened.tabId), 'Fixture requires one newly opened exact saved identity.');
    return attachCreatedFixtureTab({ id: opened.tabId }, async () => {
        const created = await poll(() => arcifyOptions.evaluate(id => chrome.tabs.get(id), opened.tabId),
            tab => tab.status === 'complete' && tab.url === url && !tab.pendingUrl, 'exact saved page navigation completed');
        assert.equal(created.windowId, windowId);
        const newIds = (await arcifyOptions.evaluate(() => chrome.tabs.query({}))).filter(tab => !beforeTabs.has(tab.id)).map(tab => tab.id);
        assert.deepEqual(newIds, [opened.tabId], 'Exactly one native page was created by this saved open.');
        const target = await poll(async () => {
            const fresh = browser.targets().filter(target => target.type() === 'page' && !beforeTargets.has(target));
            assert(fresh.length <= 1, 'Ambiguous fresh targets must fail instead of guessing by duplicate URL.');
            return fresh.length === 1 && fresh[0].url() === url ? fresh[0] : null;
        }, Boolean, `one fresh target for exact saved tab ${opened.tabId}`);
        return { tab: created, page: await observePage(await target.page()) };
    }, id => arcifyOptions.evaluate(id => chrome.tabs.remove(id), id));
}

async function newTabPage(url, windowId = fixture.windowA) {
    const before = new Set(browser.targets());
    const created = await arcifyOptions.evaluate(options => chrome.tabs.create(options), { windowId, url, active: true });
    return attachCreatedFixtureTab(created, async () => {
        const target = await poll(async () => {
            for (const candidate of browser.targets()) {
                if (candidate.type() !== 'page' || before.has(candidate)) continue;
                const matchesUrl = candidate.url() === url || (url === 'chrome://newtab/' && candidate.url() === `chrome-extension://${spotlightId}/newtab.html`);
                if (!matchesUrl) continue;
                try {
                    const page = await candidate.page();
                    // Every caller creates an extension page or its new-tab override.
                    // Read Chrome's real tab ID rather than guessing by page order.
                    if (await page.evaluate(async () => (await chrome.tabs.getCurrent())?.id) === created.id) return candidate;
                } catch { /* Navigation can briefly replace the execution context. */ }
            }
            return null;
        }, Boolean, `the exact newly created tab ${created.id} (${url})`);
        report.tabTargets ||= [];
        report.tabTargets.push({ chromeTabId: created.id, requestedUrl: url, observedTargetUrl: target.url() });
        return { tab: created, page: await observePage(await target.page()) };
    }, id => arcifyOptions.evaluate(async id => {
        const live = await chrome.tabs.query({});
        if (live.some(tab => tab.id === id)) await chrome.tabs.remove(id);
    }, id)).catch(error => {
        report.tabAttachmentFailures ||= [];
        report.tabAttachmentFailures.push({ tabId: created.id, requestedUrl: url, message: error.message,
            ...(error.fixtureTabCleanup ? { cleanup: error.fixtureTabCleanup } : {}) });
        throw error;
    });
}
async function search(page, query) {
    return ui(page, 'Type Spotlight query', async () => {
        const surface = await spotlightSurface(page);
        await surface.waitForFunction(() => {
            const input = document.querySelector('[data-testid="spotlight-input"]');
            return input && input.getBoundingClientRect().width > 0;
        });
        const handle = await (await spotlightSurface(page)).evaluateHandle(() => document.querySelector('[data-testid="spotlight-input"]'));
        const input = handle.asElement(); assert(input);
        await replaceInputText(page, input, query);
        assert.equal(page.isClosed(), false, 'Typing a search query must leave its page open.');
        const field = await input.evaluate(element => ({ value: element.value, focused: element.getRootNode().activeElement === element }));
        assert.deepEqual(field, { value: query, focused: true }, 'Search typing must reach the exact focused input.');
        await handle.dispose();
    });
}
async function clickResult(page, title) {
    return ui(page, `Select ${title}`, () => clickFreshResult(async timeout => {
        const surface = await spotlightSurface(page);
        await surface.waitForFunction(title => {
            const root = document;
            return [...root.querySelectorAll('[data-testid="spotlight-result"]')].some(item => item.querySelector('.arcify-spotlight-result-title')?.textContent === title);
        }, { timeout }, title);
        const result = await surface.evaluateHandle(title => {
            const root = document;
            const matches = [...root.querySelectorAll('[data-testid="spotlight-result"]')].filter(item => item.querySelector('.arcify-spotlight-result-title')?.textContent === title);
            if (matches.length !== 1) throw new Error(`Expected one exact result for ${title}, found ${matches.length}.`);
            return matches[0];
        }, title);
        const element = result.asElement();
        if (!element) { await result.dispose(); throw new Error('Requested result disappeared before click.'); }
        return element;
    }, async observation => {
        report.resultClicks ||= [];
        report.resultClicks.push({ title, ...observation, observedAt:new Date().toISOString() });
        await saveReport();
    }));
}
async function assertSidebarSpace(spaceId) {
    assert(sidebarFixture?.page && !sidebarFixture.page.isClosed(), 'Rendered sidebar fixture must remain open.');
    await sidebarFixture.page.waitForFunction(spaceId => {
        const visible = [...document.querySelectorAll('#spacesList > .space')].filter(space => getComputedStyle(space).display !== 'none');
        const selected = [...document.querySelectorAll('#spaceSwitcher > button.active')];
        return visible.length === 1 && visible[0].dataset.spaceId === spaceId && visible[0].classList.contains('active') &&
            selected.length === 1 && selected[0].dataset.spaceId === spaceId;
    }, { polling: 50 }, spaceId);
    return sidebarFixture.page.evaluate(() => ({
        visibleSpaceIds: [...document.querySelectorAll('#spacesList > .space')].filter(space => getComputedStyle(space).display !== 'none').map(space => space.dataset.spaceId),
        selectedSpaceIds: [...document.querySelectorAll('#spaceSwitcher > button.active')].map(button => button.dataset.spaceId)
    }));
}
async function enterUrl(page, url) {
    await search(page, url);
    await page.waitForFunction(url => {
        const root = document.getElementById('arcify-spotlight-host')?.shadowRoot?.querySelector('[data-testid="spotlight-frame"]')?.contentDocument || document.getElementById('arcify-spotlight-host')?.shadowRoot || document;
        return root.querySelector('[data-testid="spotlight-result"]')?.textContent.includes(new URL(url).pathname);
    }, {}, url);
    const input = await sidebarInput(page);
    await ui(page, 'Open typed URL', () => input.asElement().press('Enter')); await input.dispose();
}
async function launchOverlay(mode = 'new-tab') {
    // Distinct test cases begin after the previous overlay's close animation.
    // This is not a claim that rapid close/reopen races have been tested.
    await sourcePage.waitForFunction(() => !document.getElementById('arcify-spotlight-host'), { polling: 50 });
    await activate(fixture.sourceA);
    const response = await external(arcifyOptions, spotlightId, 'launch', { windowId: fixture.windowA, mode });
    assert.equal(response?.ok, true, JSON.stringify(response));
    await sourcePage.waitForFunction(() => document.getElementById('arcify-spotlight-host')?.shadowRoot?.querySelector('dialog')?.open);
    return sourcePage;
}

async function restartFavoriteWorker(favoriteId, tabId) {
    const beforeSnapshot = await snapshot();
    const readOwnership = async () => summarizeFavoriteOwnership(await arcifyOptions.evaluate(async () => {
        const session = await chrome.storage.session.get(['favoriteSession', 'favoriteContinuityReceipt']);
        const local = await chrome.storage.local.get('favoriteContinuity');
        return { session: session.favoriteSession, receipt: session.favoriteContinuityReceipt, continuity: local.favoriteContinuity };
    }));
    report.favoriteWorkerOwnership = { beforeTermination: await readOwnership() }; await saveReport();
    const url = `chrome-extension://${arcifyId}/background.js`;
    const oldTarget = await browser.waitForTarget(target => target.type() === 'service_worker' && target.url() === url);
    const worker = await oldTarget.worker();
    const cdp = await browser.target().createCDPSession();
    const readTargets = async () => (await cdp.send('Target.getTargets')).targetInfos;
    const observations = [];
    report.favoriteWorkerRestart = observations;
    try {
        const old = await terminateObservedWorker({worker,url,readTargets,
            releaseNetwork: async () => {
                const network = await networkTargets.get(oldTarget); assert(network);
                const id = network.id(); await network.detach(); networkTargets.delete(oldTarget); return id;
            },record:async observation => { observations.push(observation); await saveReport(); }});
        report.favoriteWorkerOwnership.afterTermination = await readOwnership(); await saveReport();
        const afterSnapshot = await snapshot();
        report.favoriteWorkerOwnership.afterWake = await readOwnership(); await saveReport();
        assert.deepEqual(afterSnapshot.favorites,beforeSnapshot.favorites,'Worker restart must preserve every saved record and exact binding.');
        assert.equal(afterSnapshot.favorites.find(item => item.id === favoriteId)?.tabId,tabId);
        assert.deepEqual(afterSnapshot.tabs.map(item=>item.id).sort((a,b)=>a-b),beforeSnapshot.tabs.map(item=>item.id).sort((a,b)=>a-b),'Read-only worker wake cannot duplicate a Favorite.');
        const raw = await poll(readTargets,targets => targets.some(target => target.type === 'service_worker' && target.url === url && target.targetId !== old.targetId),'distinct Favorite worker replacement');
        const replacement = findExactWorkerTarget(raw,url);
        const target = await browser.waitForTarget(target => target !== oldTarget && target.type() === 'service_worker' && target.url() === url);
        await blockExternalHttps(target);
        const identity = await waitForExtensionWorkerIdentity(await target.worker(),arcifyId);
        observations.push({phase:'restarted',target:replacement,identity});
        return {oldTargetId:old.targetId,restartedTargetId:replacement.targetId,identity,beforeSnapshot,afterSnapshot};
    } finally { await cdp.detach(); }
}

const sidebarSelector = '[data-result-type="arcify-sidebar-command"]';
async function sidebarInput(page) {
    const handle = await (await spotlightSurface(page)).evaluateHandle(() => document.querySelector('[data-testid="spotlight-input"]'));
    assert(handle.asElement(), 'Spotlight input must exist.');
    return handle;
}
async function waitSidebarCommand(page) {
    await page.waitForFunction(() => (document.getElementById('arcify-spotlight-host')?.shadowRoot?.querySelector('[data-testid="spotlight-frame"]')?.contentDocument || document.getElementById('arcify-spotlight-host')?.shadowRoot || document).querySelector('[data-result-type="arcify-sidebar-command"]'), { polling: 50 });
}
async function waitStartupResults(page) {
    // Action rows may render before loadInitialResults completes. This fixture
    // owns live tabs, so require an ordinary tab result before its one-shot offer.
    // Readiness is passive; an unaccepted offer is never retried.
    await page.waitForSelector('[data-testid="spotlight-result"][data-result-type="open-tab"]', { visible: true });
}
async function waitSidebarSuccess(page) {
    await page.waitForFunction(() => (document.getElementById('arcify-spotlight-host')?.shadowRoot?.querySelector('[data-testid="spotlight-frame"]')?.contentDocument || document.getElementById('arcify-spotlight-host')?.shadowRoot || document).querySelector('.arcify-bridge-status')?.textContent.includes('Arcify sidebar opened.'), { polling: 50 });
}
async function nativePanelState() {
    return arcifyOptions.evaluate(async () => ({
        contexts: await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] }),
        events: globalThis.__pairedSidebarEvents || []
    }));
}
// Theme cleanup reloads the API Options realm and retires its old observers.
// Install in the current fresh realm immediately before recovery in every mode.
// Never reset existing observations or manufacture an onOpened/onClosed receipt.
async function prepareRecoverySidebarObservation() {
    await arcifyOptions.evaluate(() => {
        if (globalThis.__pairedSidebarEvents !== undefined) throw new Error('Recovery Sidebar observation must start exactly once in a fresh options realm.');
        globalThis.__pairedSidebarEvents = [];
        chrome.sidePanel.onOpened.addListener(info => globalThis.__pairedSidebarEvents.push({ type: 'opened', ...info }));
        chrome.sidePanel.onClosed.addListener(info => globalThis.__pairedSidebarEvents.push({ type: 'closed', ...info }));
    });
}
async function resolveNativeSidebarTarget() {
    return poll(async () => {
        const candidates = browser.targets().filter(target => target.url() === `chrome-extension://${arcifyId}/sidebar.html`);
        const matching = [];
        for (const target of candidates) {
            const page = await target.asPage();
            const hosting = await page.evaluate(async () => ({ tab: await chrome.tabs.getCurrent() || null, windowId: (await chrome.windows.getCurrent()).id }));
            if (hosting.tab === null && hosting.windowId === fixture.windowA) matching.push({ target, page, hosting });
        }
        assert(matching.length <= 1, 'Native sidebar renderer must be unique for the verified source window.');
        return matching[0] || null;
    }, Boolean, 'unique native sidebar renderer with no ordinary tab and exact source window');
}

async function captureNativeSidebar(afterEvent, label) {
    const state = await poll(nativePanelState, state => state.events.slice(afterEvent).some(event => event.type === 'opened' && event.windowId === fixture.windowA), 'a native sidePanel.onOpened event');
    const populated = await poll(nativePanelState, state => state.contexts.some(context => context.contextType === 'SIDE_PANEL' && context.documentUrl === `chrome-extension://${arcifyId}/sidebar.html`), 'a native SIDE_PANEL context');
    const context = assertNativeSidebarEvidence(populated.contexts, populated.events, { extensionId: arcifyId, windowId: fixture.windowA, afterEvent });
    const ordinary = await arcifyOptions.evaluate(() => chrome.tabs.query({}));
    assert(!ordinary.some(tab => tab.url === `chrome-extension://${arcifyId}/sidebar.html`), 'No ordinary sidebar tab may substitute for native rendering evidence.');
    const { target, page: nativePage, hosting } = await resolveNativeSidebarTarget();
    const page = await observePage(nativePage);
    assert.equal(hosting.tab, null, 'The selected rendering target must not be a normal tab.');
    assert.equal(hosting.windowId, fixture.windowA, 'The native rendering target must belong to the source window.');
    // Native mounting and active-space rendering are asynchronous. Wait only by
    // observing the actual target; never focus or resize it to manufacture proof.
    const rendered = await poll(() => page.evaluate(readNativeSidebarRender),
        createNativeSidebarReadiness(arcifyId), 'stable native sidebar viewport and active-space rendering');
    const beforeCapture = await page.evaluate(readNativeSidebarRender);
    assert(nativeSidebarRenderReady(beforeCapture, arcifyId), 'Native panel must be rendered immediately before capture.');
    assert.deepEqual(nativeSidebarRenderIdentity(beforeCapture), nativeSidebarRenderIdentity(rendered), 'Native content must remain stable before capture.');
    const captured = await screenshot(page, label, true, { fullPage: false });
    const screenshotDimensions = assertNativeSidebarScreenshot(await readFile(resolve(OUTPUT, captured.filename)), rendered, arcifyId);
    const afterCapture = await page.evaluate(readNativeSidebarRender);
    assert(nativeSidebarRenderReady(afterCapture, arcifyId), 'Native panel must remain rendered after the required capture.');
    assert.deepEqual(nativeSidebarRenderIdentity(afterCapture), nativeSidebarRenderIdentity(rendered), 'Capture must not change the native viewport or selection.');
    const evidence = { context, windowProofSource: 'sidePanel.onOpened', openedEvents: populated.events.slice(afterEvent),
        targetType: target.type(), hosting, rendered, beforeCapture, screenshotDimensions, afterCapture };
    (report.nativePanels ||= []).push({ label, ...evidence });
    await saveReport();
    return evidence;
}
async function closeNativeSidebar() {
    const before = (await nativePanelState()).events.length;
    await arcifyOptions.evaluate(windowId => chrome.sidePanel.close({ windowId }), fixture.windowA);
    await poll(nativePanelState, state => state.events.slice(before).some(event => event.type === 'closed' && event.windowId === fixture.windowA), 'native panel closure');
}
async function sidebarEnter(page, label) {
    const input = await sidebarInput(page);
    try { await ui(page, label, async () => { await input.asElement().focus(); await input.asElement().press('Enter'); }); }
    finally { await input.dispose(); }
}

// Open through the real authenticated Spotlight command, then identify its native renderer.
// Only fixture-owned disposable windows may use this native host adapter.
async function nativeMoveWindowSidebar({ windowId }) {
    assert(Number.isSafeInteger(windowId) && ![fixture.windowA, fixture.windowB].includes(windowId));
    const seed = await arcifyOptions.evaluate(id => chrome.tabs.query({ windowId:id }), windowId);
    assert(seed.length && seed.every(tab => tab.url?.startsWith(`${fixture.base}/tab-menu/`)));
    await arcifyOptions.evaluate(() => {
        globalThis.__pairedMoveWindowEvents = [];
        chrome.sidePanel.onOpened.addListener(info => globalThis.__pairedMoveWindowEvents.push({type: 'opened', ...info}));
    });
    const helper = await newTabPage('chrome://newtab/', windowId);
    const removeLauncher = async () => {
        const exists = await arcifyOptions.evaluate(id => chrome.tabs.get(id).then(()=>true,()=>false), helper.tab.id);
        if (exists) await arcifyOptions.evaluate(id => chrome.tabs.remove(id), helper.tab.id);
    };
    try {
        await waitSidebarCommand(helper.page); await search(helper.page, 'Open Arcify sidebar');
        await helper.page.waitForSelector(`${sidebarSelector}.selected`);
        await sidebarEnter(helper.page, 'Open native panel in disposable Move to New Window source');
        await waitSidebarSuccess(helper.page);
        const proof = await poll(() => arcifyOptions.evaluate(async () => ({
            contexts:await chrome.runtime.getContexts({contextTypes:['SIDE_PANEL']}), events:globalThis.__pairedMoveWindowEvents
        })), data => data.events.some(e=>e.windowId===windowId) && data.contexts.some(c=>(c.windowId===windowId || c.windowId===-1) && c.documentUrl===`chrome-extension://${arcifyId}/sidebar.html`), 'native disposable window panel context and opened event');
        assertNativeSidebarEvidence(proof.contexts, proof.events, {extensionId:arcifyId,windowId});
        const page = await poll(async () => {
            const matches=[];
            for(const target of browser.targets().filter(t=>t.url()===`chrome-extension://${arcifyId}/sidebar.html`)) {
                const candidate=await target.asPage();
                const host=await candidate.evaluate(async()=>({tab:await chrome.tabs.getCurrent()||null,windowId:(await chrome.windows.getCurrent()).id}));
                if(host.tab===null&&host.windowId===windowId)matches.push(candidate);
            }
            assert(matches.length<=1);return matches[0]||null;
        }, Boolean, 'exact native disposable source renderer');
        const observed=await observePage(page);
        await poll(()=>observed.evaluate(readNativeSidebarRender),createNativeSidebarReadiness(arcifyId),'real disposable panel render');
        (report.moveWindowNativeHosts ||= []).push({windowId,proof});await saveReport();
        return {page:observed,ownedTabIds:[helper.tab.id],removeLauncher};
    } catch(error) { await removeLauncher().catch(cleanup=>{error.cleanupError=cleanup.message;});throw error; }
}

async function nativeTodayMoveSidebar({ revealSpaceId = null } = {}) {
    await arcifyOptions.evaluate(() => {
        globalThis.__pairedSidebarEvents = [];
        chrome.sidePanel.onOpened.addListener(info => globalThis.__pairedSidebarEvents.push({ type: 'opened', ...info }));
        chrome.sidePanel.onClosed.addListener(info => globalThis.__pairedSidebarEvents.push({ type: 'closed', ...info }));
    });
    const helper = await newTabPage('chrome://newtab/');
    try {
        await waitSidebarCommand(helper.page);
        await search(helper.page, 'Open Arcify sidebar');
        await helper.page.waitForSelector(`${sidebarSelector}.selected`);
        const eventCount = (await nativePanelState()).events.length;
        await sidebarEnter(helper.page, 'Open genuine native panel for Today Move');
        await waitSidebarSuccess(helper.page);
        if (revealSpaceId !== null) {
            const { page } = await resolveNativeSidebarTarget();
            const reveal = await revealNativeSidebarSpace({ page, poll, extensionId: arcifyId, windowId: fixture.windowA, spaceId: revealSpaceId });
            (report.nativeSidebarReveals ||= []).push(reveal); await saveReport();
        }
        const evidence = await captureNativeSidebar(eventCount, 'today-move-native-panel-host-proof');
        const { page } = await resolveNativeSidebarTarget();
        return { page: await observePage(page), evidence,
            close: async () => {
                await closeNativeSidebar();
                await arcifyOptions.evaluate(id => chrome.tabs.remove(id), helper.tab.id);
                return { tabId: helper.tab.id, windowId: helper.tab.windowId };
            } };
    } catch (error) {
        if ((await nativePanelState()).contexts.length) await closeNativeSidebar().catch(cleanup => { error.cleanupError = cleanup.message; });
        await arcifyOptions.evaluate(id => chrome.tabs.remove(id), helper.tab.id).catch(cleanup => { error.cleanupError = cleanup.message; });
        throw error;
    }
}

// This adapter operates on the recovered overlay itself. A helper/new-tab
// launch here would invalidate the recovery case's native-tab conservation.
async function verifyRecoveredOverlaySidebar({ page, surface, sourceTab }) {
    assert.equal(sourceTab.windowId, fixture.windowA);
    assert.notEqual(surface, page, 'Recovery Sidebar input must originate in the existing isolated frame.');
    const host = await page.$('#arcify-spotlight-host'); assert(host);
    const beforeTabs = await tabsIn(sourceTab.windowId);
    let panelOpened = false, primaryError;
    try {
        await search(page, 'Open Arcify sidebar');
        await surface.waitForSelector(`${sidebarSelector}.selected`, { visible: true });
        await surface.evaluate(() => {
            globalThis.__recoverySidebarInput = [];
            const listener = event => {
                if (event.key === 'Enter') globalThis.__recoverySidebarInput.push({ trusted: event.isTrusted,
                    focusedInput: event.target.matches('[data-testid="spotlight-input"]'),
                    selected: document.querySelector('[data-testid="spotlight-result"].selected')?.dataset.resultType });
            };
            document.addEventListener('keydown', listener, { capture: true, once: true });
        });
        const afterEvent = (await nativePanelState()).events.length;
        await sidebarEnter(page, 'Invoke Sidebar with genuine Enter in the recovered overlay');
        await waitSidebarSuccess(page); panelOpened = true;
        const input = await surface.evaluate(() => globalThis.__recoverySidebarInput);
        assert.deepEqual(input, [{ trusted: true, focusedInput: true, selected: 'arcify-sidebar-command' }]);
        const native = await captureNativeSidebar(afterEvent, 'overlay-recovery-native-sidebar-direct-gesture');
        assert.deepEqual((await tabsIn(sourceTab.windowId)).map(tab => tab.id), beforeTabs.map(tab => tab.id));
        await closeNativeSidebar(); panelOpened = false;
        await ui(page, 'Return focus to the same recovered Spotlight input', async () => {
            const input = await sidebarInput(page);
            try { await input.asElement().focus(); } finally { await input.dispose(); }
        });
        assert.equal(await host.evaluate(node => node.isConnected && node === document.getElementById('arcify-spotlight-host') && node.shadowRoot.querySelector('dialog')?.open === true), true,
            'Native sidebar open/close must leave the exact recovered overlay available.');
        return { ...native, sourceTabId: sourceTab.id, trustedInput: input, sameRecoveredOverlay: true };
    } catch (error) { primaryError = error; throw error; }
    finally {
        try {
            if (panelOpened || primaryError && (await nativePanelState()).contexts.length) await closeNativeSidebar();
        } catch (error) {
            if (!primaryError) throw error;
            primaryError.sidebarCleanupError = error.message;
        } finally { await host.dispose(); }
    }
}

async function runHostedOverlayRecovery() {
    const nonce = randomBytes(16).toString('hex');
    const url = `${fixture.base}/overlay-recovery-host?nonce=${nonce}`;
    const helperUrl = `chrome-extension://${spotlightId}/newtab.html`;
    const beforeTabs = await arcifyOptions.evaluate(() => chrome.tabs.query({}));
    const originalActive = beforeTabs.find(tab => tab.windowId === fixture.windowA && tab.active); assert(originalActive);
    const beforeTargets = new Set(browser.targets());
    const created = await arcifyOptions.evaluate(options => chrome.tabs.create(options), { windowId: fixture.windowA, url, active: true });
    report.overlayRecovery = { nonce, sourceTabId: created.id, checkpoints: [] };
    const record = async observation => { report.overlayRecovery.checkpoints.push(observation); await saveReport(); };
    let targetsCdp, primaryError, evidence;
    try {
        const source = await attachCreatedFixtureTab(created, async () => {
            const sourceTab = await poll(() => tab(created.id), tab => tab.status === 'complete' && tab.url === url && !tab.pendingUrl,
                'exact nonce-bearing recovery source settled');
            assert.equal(sourceTab.windowId, fixture.windowA);
            const freshTabs = (await arcifyOptions.evaluate(() => chrome.tabs.query({}))).filter(tab => !beforeTabs.some(old => old.id === tab.id));
            assert.deepEqual(freshTabs.map(tab => tab.id), [created.id], 'Recovery setup creates only its exact source tab.');
            const target = await poll(async () => {
                const fresh = browser.targets().filter(target => target.type() === 'page' && !beforeTargets.has(target));
                assert(fresh.length <= 1, 'Do not guess among multiple fresh recovery page targets.');
                return fresh.length === 1 && fresh[0].url() === url ? fresh[0] : null;
            }, Boolean, 'one exact fresh recovery source target');
            return { sourceTab, page: await observePage(await target.page()) };
        }, id => arcifyOptions.evaluate(id => chrome.tabs.remove(id), id));
        targetsCdp = await browser.target().createCDPSession();
        const readTargets = async () => (await targetsCdp.send('Target.getTargets')).targetInfos;
        evidence = await exerciseOverlayRecovery({ browser, ...source, arcifyOptions, spotlightId, ui, poll, record, screenshot,
            reloadSpotlight: async () => (await reloadPairedExtension('spotlight', { preserveForeground: true })).evidence,
            stopSpotlightWorker: async () => {
                const url = `chrome-extension://${spotlightId}/background.js`;
                const target = browser.targets().find(target => target.type() === 'service_worker' && target.url() === url); assert(target);
                const worker = await target.worker(), observations = [];
                await terminateObservedWorker({ worker, url, readTargets,
                    releaseNetwork: async () => {
                        const network = await networkTargets.get(target); assert(network);
                        const id = network.id(); await network.detach(); networkTargets.delete(target); return id;
                    },
                    record: async observation => { observations.push(observation); await record({ phase: 'recovery-worker-stop', observation }); }
                });
                // No page/peer/status/worker evaluation after close. The exercise
                // now performs its final raw absence read and one guarded send.
                return { observations };
            },
            observeReplacementWorker: target => blockExternalHttps(target),
            verifySidebar: verifyRecoveredOverlaySidebar });
        assert.deepEqual(evidence.cases.map(item => item.kind), ['dormant', 'cold-worker', 'marked-orphan', 'unmarked-legacy-shape']);
        report.overlayRecovery.evidence = evidence;
        return evidence;
    } catch (error) { primaryError = error; throw error; }
    finally {
        const cleanup = { removedTabIds: [], failures: [] };
        try {
            const current = await arcifyOptions.evaluate(() => chrome.tabs.query({}));
            const helpers = current.filter(tab => tab.windowId === fixture.windowA && (tab.url === helperUrl || tab.pendingUrl === helperUrl) && !beforeTabs.some(old => old.id === tab.id));
            // These exact new helper identities are captured even when the
            // exercise throws after a native fallback and cannot return evidence.
            cleanup.helpers = helpers; assert(helpers.length <= 1, 'Unexpected extra recovery helpers fail cleanup rather than broadening deletion.');
            for (const helper of helpers) {
                assert(!helper.pendingUrl || helper.pendingUrl === helperUrl, 'Never remove a helper navigating outside its exact owned URL.');
                await arcifyOptions.evaluate(id => chrome.tabs.remove(id), helper.id); cleanup.removedTabIds.push(helper.id);
            }
        } catch (error) { cleanup.failures.push({ phase: 'helper', message: error.message }); }
        try {
            const present = await arcifyOptions.evaluate(id => chrome.tabs.query({}).then(tabs => tabs.some(tab => tab.id === id)), created.id);
            if (present) { await arcifyOptions.evaluate(id => chrome.tabs.remove(id), created.id); cleanup.removedTabIds.push(created.id); }
            await activate(originalActive.id);
        } catch (error) { cleanup.failures.push({ phase: 'source', message: error.message }); }
        try { await targetsCdp?.detach(); } catch (error) { cleanup.failures.push({ phase: 'raw-target-observer', message: error.message }); }
        report.overlayRecovery.cleanup = cleanup; await saveReport();
        if (cleanup.failures.length) {
            if (primaryError) primaryError.recoveryCleanupErrors = cleanup.failures;
            else throw new Error(`Recovery cleanup failed: ${JSON.stringify(cleanup.failures)}`);
        }
    }
}

// Retain the same raw-target, original-view, registry and fresh-identity proof
// for every real reload, including Favorite continuity acceptance.
async function reloadPairedExtension(name, { preserveForeground = false } = {}) {
    assert(['arcify', 'spotlight'].includes(name));
    assert(!preserveForeground || name === 'spotlight', 'Only overlay recovery reloads preserve foreground.');
    const id = name === 'arcify' ? arcifyId : spotlightId;
    const page = name === 'arcify' ? arcifyOptions : spotlightOptions;
    const url = `chrome-extension://${id}/background.js`;
    const workerTarget = browser.targets().find(target => target.type() === 'service_worker' && target.url() === url);
    assert(workerTarget);
    const worker = await workerTarget.worker();
    const targetsCdp = await browser.target().createCDPSession();
    const viewCdp = await page.target().createCDPSession();
    const defaultContexts = new Set();
    let collectingInitialContexts = true;
    const view = { url: page.url(), contexts: [], invalidations: [] };
    viewCdp.on('Runtime.executionContextCreated', ({ context }) => {
        view.contexts.push(context);
        if (collectingInitialContexts && context.auxData?.isDefault) defaultContexts.add(context.id);
    });
    viewCdp.on('Runtime.executionContextDestroyed', event => {
        if (defaultContexts.has(event.executionContextId)) view.invalidations.push(event);
    });
    viewCdp.on('Runtime.executionContextsCleared', () => view.invalidations.push({ allContextsCleared: true }));
    report.extensionReloads ||= [];
    const evidence = { name, view, preserveForeground, observations: [], registry: [] };
    const expected = { ...report.extensions[name], path: resolve(name === 'arcify' ? ROOT : COMPANION, 'dist') };
    const readRegistry = async () => (await targetsCdp.send('Extensions.getExtensions')).extensions;
    const recordRegistry = async (phase, extensions) => { evidence.registry.push({ phase, extensions, observedAt: new Date().toISOString() }); await saveReport(); };
    report.extensionReloads.push(evidence);
    try {
        const installedBefore = await readRegistry();
        await recordRegistry('before-reload', installedBefore);
        assert.equal(findInstalledExtension(installedBefore, expected).enabled, true);
        await viewCdp.send('Runtime.enable');
        collectingInitialContexts = false;
        assert(defaultContexts.size > 0, 'The original extension options realm must be observed before reload.');
        const readTargets = async () => (await targetsCdp.send('Target.getTargets')).targetInfos;
        const original = await reloadObservedExtension({ url, readTargets,
            releaseObservers: async () => {
                const network = await networkTargets.get(workerTarget);
                assert(network, 'The fixture-owned worker network session must be tracked.');
                evidence.detachedNetworkSessionId = network.id();
                await network.detach();
                networkTargets.delete(workerTarget);
                evidence.detachedWorkerSessionId = worker.client.id();
                await worker.client.detach();
            },
            reload: () => requestObservedExtensionReload(page, ui, { name, preserveForeground }),
            viewInvalidated: async () => { view.closed = page.isClosed(); return view.closed || view.invalidations.length > 0; },
            record: async observation => { evidence.observations.push({ ...observation, observedAt: new Date().toISOString() }); await saveReport(); }
        });
        await waitForEnabledExtension(readRegistry, expected, extensions => recordRegistry('after-unload', extensions));
        // A reloaded MV3 worker need not stay running without an event.
        // Reconnect through the same fresh settings/peer check a user uses.
        const reopened = await observePage(await browser.newPage());
        await reopened.goto(`chrome-extension://${id}/options.html`);
        if (name === 'arcify') arcifyOptions = reopened; else spotlightOptions = reopened;
        if (!page.isClosed()) await page.close();
        if (name === 'arcify') {
            await clickUI(spotlightOptions, '#refresh-connection', '#refresh-connection:not([disabled])');
            await spotlightOptions.waitForSelector('#connection-status[data-state="connected"]');
        } else {
            await clickUI(arcifyOptions, '#bridgeCheck', '#bridgeCheck:not([disabled])');
            await arcifyOptions.waitForSelector('#bridgeStatus[data-state="connected"]');
        }
        const after = await poll(readTargets, targets => targets.some(target => target.type === 'service_worker' && target.url === url && target.targetId !== original.targetId), 'the reloaded extension worker');
        evidence.replacement = findExactWorkerTarget(after, url);
        assert.notEqual(evidence.replacement.targetId, original.targetId);
        const replacement = await browser.waitForTarget(target => target !== workerTarget && target.type() === 'service_worker' && target.url() === url);
        await blockExternalHttps(replacement);
        evidence.identity = await waitForExtensionWorkerIdentity(await replacement.worker(), id);
    } finally {
        try { await recordRegistry('final', await readRegistry()); }
        catch (error) { report.diagnostics.push({ type: 'reload-registry-read', message: error.message }); }
        await viewCdp.detach().catch(error => report.diagnostics.push({ type: 'reload-view-detach', message: error.message }));
        await targetsCdp.detach();
        await saveReport();
    }
    return { evidence, arcifyOptions, spotlightOptions };
}

await mkdir(OUTPUT, { recursive: true });
try {
    report.environment.arcifyHead = head(ROOT);
    report.environment.spotlightHead = head(COMPANION);
    assert.equal(report.environment.spotlightHead, PINNED_SPOTLIGHT, 'Companion must match the reviewed pinned commit.');
    if (process.env.ARCIFY_TEST_HEAD) assert.equal(report.environment.arcifyHead, process.env.ARCIFY_TEST_HEAD);
    report.environment.puppeteer = JSON.parse(await readFile(resolve(ROOT, 'scripts/paired-chrome-runtime/node_modules/puppeteer-core/package.json'), 'utf8')).version;
    assert.equal(report.environment.puppeteer, '25.12.0', 'Paired CI must use its isolated, reviewed browser driver.');
    await step(stepNames[0], async () => {
        validateNamespaceLaunchEnvironment(process.env, process.getuid?.());
        const chromeExecutable = await puppeteer.executablePath('chrome');
        assert.equal(chromeExecutable, CHROME_EXECUTABLE, 'The installed stable channel must resolve to the expected system browser.');
        try {
            report.environment.chromeRuntime = await inspectInstalledChromeRuntime(chromeExecutable);
        } catch (error) {
            report.environment.chromeRuntime = error.chromeRuntimeEvidence || { path: CHROME_EXECUTABLE, validated: false };
            throw error;
        }
        await saveReport();
        profile = await mkdtemp(resolve(process.env.RUNNER_TEMP || tmpdir(), 'paired-chrome-'));
        // enableExtensions enables Puppeteer's documented extension-debugging API.
        // Installed stable Chrome has the runner's existing AppArmor allowance.
        // Require its namespace sandbox; do not select/repair a setuid helper or
        // change permission, AppArmor, sysctl or other policy settings.
        // No sandbox-disabling or web-security-disabling fallback flags.
        const launch = launchOptions = snapshotChromeLaunchOptions({ channel: 'chrome', headless: false, pipe: true, enableExtensions: true, dumpio: true, userDataDir: profile, timeout: 60_000, protocolTimeout: 30_000, defaultViewport: { width: 1280, height: 900 } });
        report.environment.requestedLaunch = { ...launch, userDataDir: '<fresh disposable runner profile>' };
        validateChromeLaunchArguments(await puppeteer.defaultArgs(structuredClone(launch)));
        browser = await puppeteer.launch(structuredClone(launch));
        report.environment.chromeExecutable = browser.process().spawnfile;
        report.environment.chromeArguments = browser.process().spawnargs.map(arg => arg.startsWith('--user-data-dir=') ? '--user-data-dir=<disposable-profile>' : arg);
        assert.equal(report.environment.chromeExecutable, CHROME_EXECUTABLE, 'Unexpected actual spawned Chrome executable.');
        validateChromeLaunchArguments(report.environment.chromeArguments);
        try {
            report.environment.chromeProcess = await inspectChromeProcessRuntime(browser.process().pid);
        } catch (error) {
            report.environment.chromeProcess = error.chromeProcessEvidence || { validated: false };
            throw error;
        }
        report.environment.chromeVersion = await browser.version();
        assert.equal(report.environment.chromeVersion, `Chrome/${report.environment.chromeRuntime.package.browserVersion}`, 'Actual Chrome version must match the recorded installed package.');
        report.environment.chromeUserAgent = await browser.userAgent();
        const browserSession = await browser.target().createCDPSession();
        try {
            report.environment.browserProtocol = await browserSession.send('Browser.getVersion');
            assert.equal(report.environment.browserProtocol.product, report.environment.chromeVersion);
        } finally { await browserSession.detach(); }
        const lifecycleSession = await browser.target().createCDPSession();
        observeTargetDiagnostics(lifecycleSession, 'browser', event => report.targetLifecycle.push(event));
        await lifecycleSession.send('Target.setDiscoverTargets', { discover: true });
        browser.on('targetcreated', target => { blockExternalHttps(target).catch(error => report.diagnostics.push({ type: 'network-blocking', message: error.message })); });
        const sandboxPage = await observePage(await browser.newPage());
        await sandboxPage.goto('chrome://sandbox/', { waitUntil: 'domcontentloaded' });
        await sandboxPage.waitForFunction(() => document.querySelector('#sandbox-status tr') && document.getElementById('evaluation')?.textContent.trim());
        const sandboxStatus = await sandboxPage.evaluate(() => ({
            url: location.href, title: document.title, bodyText: document.body.innerText,
            evaluation: document.getElementById('evaluation')?.textContent || '',
            rows: [...document.querySelectorAll('#sandbox-status tr')].map(row => {
                const cells = row.querySelectorAll('td');
                return { name: cells[0]?.textContent || '', value: cells[1]?.textContent || '' };
            })
        }));
        report.environment.chromeSandbox = { ...sandboxStatus, capturedAt: new Date().toISOString(), validated: false };
        await writeFile(resolve(OUTPUT, 'chrome-sandbox-status.txt'), sandboxStatus.bodyText);
        await screenshot(sandboxPage, 'actual-chrome-sandbox-status');
        // Preserve the diagnostic screenshot and raw report even if this fails.
        report.environment.chromeSandbox.validation = validateChromeNamespaceSandboxStatus(sandboxStatus);
        report.environment.chromeSandbox.validated = true;
        await saveReport();
        await sandboxPage.close();
        // Explicitly approved normal Developer-mode UI, scoped to this disposable
        // CI profile. A policy-controlled/disabled setting is a hard stop.
        const extensionsPage = await observePage(await browser.newPage());
        await extensionsPage.goto('chrome://extensions/');
        report.environment.developerModeUi = { observations: [] };
        await ui(extensionsPage, 'Enable normal Chrome Developer mode', async () => {
            report.environment.developerModeUi.result = await enableDeveloperModeViaUi({
                read: () => extensionsPage.evaluate(readDeveloperModeDomState),
                record: async observation => {
                    report.environment.developerModeUi.observations.push({ ...observation, observedAt: new Date().toISOString() });
                    await saveReport();
                },
                click: async () => {
                    const handle = await extensionsPage.evaluateHandle(() => document.querySelector('extensions-manager')
                        .shadowRoot.querySelector('extensions-toolbar').shadowRoot.querySelector('#devMode'));
                    try {
                        const fresh = await extensionsPage.evaluate(readDeveloperModeDomState);
                        assert(developerModeStateReady(fresh) && !fresh.manager.inDevMode, 'Developer-mode state changed before real input; stop.');
                        await handle.asElement().click();
                    } finally { await handle.dispose(); }
                }
            });
            await screenshot(extensionsPage, 'developer-mode-enabled-unmanaged-disposable-profile');
        });
        await extensionsPage.close();
        arcifyId = await browser.installExtension(resolve(ROOT, 'dist'));
        spotlightId = await browser.installExtension(resolve(COMPANION, 'dist'));
        assert.match(arcifyId, /^[a-p]{32}$/); assert.match(spotlightId, /^[a-p]{32}$/); assert.notEqual(arcifyId, spotlightId);
        report.extensions = {};
        for (const [name, id] of [['arcify', arcifyId], ['spotlight', spotlightId]]) {
            const target = await browser.waitForTarget(target => target.type() === 'service_worker' && target.url() === `chrome-extension://${id}/background.js`, { timeout: 30_000 });
            await blockExternalHttps(target);
            const worker = await target.worker();
            observeTargetDiagnostics(worker.client, `worker:${name}:${target.url()}`, event => report.targetLifecycle.push(event));
            const diagnostics = await target.createCDPSession();
            report.workerContexts ||= [];
            const workerExceptions = [];
            diagnostics.on('Runtime.executionContextCreated', event => report.workerContexts.push({ extension: name, type: 'context', ...event.context }));
            diagnostics.on('Runtime.exceptionThrown', event => {
                workerExceptions.push(event.exceptionDetails);
                report.workerContexts.push({ extension: name, type: 'exception', ...event.exceptionDetails });
            });
            let actual;
            try {
                await diagnostics.send('Runtime.enable');
                const started = Date.now();
                actual = await waitForExtensionWorkerIdentity(worker, id, async observation => {
                    report.workerReadiness ||= [];
                    report.workerReadiness.push({ extension: name, targetUrl: target.url(), elapsedMs: Date.now() - started, observedAt: new Date().toISOString(), ...observation });
                    await saveReport();
                });
            } finally {
                await diagnostics.detach().catch(error => report.diagnostics.push({ type: 'worker-diagnostics-detach', message: error.message }));
                await saveReport();
            }
            assertNoWorkerExceptions(workerExceptions);
            assert.equal(actual.id, id);
            report.extensions[name] = { id, name: actual.manifest.name, version: actual.manifest.version, workerUrl: target.url() };
        }
        const installedSession = await browser.target().createCDPSession();
        try {
            report.installedExtensions = (await installedSession.send('Extensions.getExtensions')).extensions;
            for (const name of ['arcify', 'spotlight']) {
                const expected = { ...report.extensions[name], path: resolve(name === 'arcify' ? ROOT : COMPANION, 'dist') };
                assert.equal(findInstalledExtension(report.installedExtensions, expected).enabled, true);
            }
        } finally { await installedSession.detach(); await saveReport(); }
        for (const page of await browser.pages()) if (/installation-onboarding\.html/.test(page.url())) await page.close();
        arcifyOptions = await observePage(await browser.newPage());
        await arcifyOptions.goto(`chrome-extension://${arcifyId}/options.html`);
        await screenshot(arcifyOptions, 'installed-arcify-options');
        spotlightOptions = await observePage(await browser.newPage());
        await spotlightOptions.goto(`chrome-extension://${spotlightId}/options.html`);
        return report.extensions;
    });
    await step(stepNames[1], async () => {
        const controlWindow = await spotlightOptions.evaluate(async () => (await chrome.windows.getCurrent()).id);
        const unpaired = await external(spotlightOptions, arcifyId, 'hello', { windowId: controlWindow });
        assert.equal(unpaired.ok, false); assert.equal(unpaired.error.code, 'UNAUTHORIZED'); assert.equal('snapshot' in unpaired, false);
        await arcifyOptions.waitForFunction(() => document.getElementById('bridgeStatus')?.textContent.includes('Standalone'), { polling: 50 }); await typeUI(arcifyOptions, '#bridgePeerId', spotlightId); await clickUI(arcifyOptions, '#bridgeSave');
        await poll(() => arcifyOptions.evaluate(() => chrome.storage.local.get('arcifyBridgePeerId')), result => result.arcifyBridgePeerId === spotlightId, 'Arcify pairing save');
        await arcifyOptions.waitForSelector('#bridgeStatus[data-state="pending"]');
        assert.equal(await arcifyOptions.$eval('#bridgeSavedPeerId', node => node.textContent), spotlightId);
        await screenshot(arcifyOptions, 'arcify-first-awaiting-approval');
        await spotlightOptions.waitForSelector('#arcify-peer-id:not([disabled])');
        await typeUI(spotlightOptions, '#arcify-peer-id', arcifyId); await clickUI(spotlightOptions, '#save-connection');
        await spotlightOptions.waitForSelector('#connection-status[data-state="connected"]');
        await clickUI(arcifyOptions, '#bridgeCheck');
        await arcifyOptions.waitForFunction(() => document.getElementById('bridgeStatus').textContent.includes('Connected to Spotlight'));
        // Repeat in the opposite order: saving locally succeeds even while the
        // companion rejects hello. Neither save silently approves an unknown ID.
        await clickUI(arcifyOptions, '#bridgeDisconnect');
        await arcifyOptions.waitForSelector('#bridgeStatus[data-state="disabled"]');
        await clickUI(spotlightOptions, '#disconnect-connection');
        await spotlightOptions.waitForSelector('#connection-status[data-state="disabled"]');
        await typeUI(spotlightOptions, '#arcify-peer-id', arcifyId);
        await clickUI(spotlightOptions, '#save-connection');
        await spotlightOptions.waitForSelector('#connection-status[data-state="pending"]');
        assert((await spotlightOptions.$eval('#saved-peer-id', node => node.textContent)).includes(arcifyId));
        await screenshot(spotlightOptions, 'spotlight-first-awaiting-approval');
        await typeUI(arcifyOptions, '#bridgePeerId', spotlightId);
        await clickUI(arcifyOptions, '#bridgeSave');
        await arcifyOptions.waitForSelector('#bridgeStatus[data-state="connected"]');
        await screenshot(arcifyOptions, 'paired-arcify-options');
        await clickUI(spotlightOptions, '#refresh-connection');
        await spotlightOptions.waitForSelector('#connection-status[data-state="connected"]');
        await screenshot(spotlightOptions, 'paired-spotlight-options');
        return { pairingOrders: ['arcify-first', 'spotlight-first'], unpairedError: unpaired.error.code, arcifyStatus: await arcifyOptions.$eval('#bridgeStatus', node => node.textContent), spotlightStatus: await spotlightOptions.$eval('#connection-status-message', node => node.textContent) };
    });
    await step(stepNames[2], async () => {
        const titles = { '/source-a': 'Pair Source A', '/alpha': 'Pair Alpha Target', '/source-b': 'Pair Source B', '/beta': 'Pair Beta Target', '/duplicate': 'Pair Shared URL', '/current-navigation': 'Pair Current Navigation', '/helper-open': 'Pair Helper Open', '/sync-off-open': 'Pair Sync Off Open', '/journal-open': 'Pair Journal Open', '/sidebar-match': 'Open Arcify sidebar', '/logical-one': 'Logical Tab One', '/logical-two': 'Logical Tab Two', '/today-selection-one': 'Today Selection One', '/today-selection-two': 'Today Selection Two', '/today-selection-four': 'Today Selection Four', '/today-selection-five': 'Today Selection Five', '/today-selection-six': 'Today Selection Six' };
        server = createServer((request, response) => {
            if (serveSpotlightActionFixture(request, response)) return;
            if (serveSpotlightNavigationFixture(request, response)) return;
            if (serveSpotlightTabFixture(request, response)) return;
            if (serveSpotlightSplitFixture(request, response)) return;
            if (serveSpotlightArchiveFixture(request, response)) return;
            const recovery = overlayRecoveryFixtureResponse(request.url);
            if (recovery) {
                response.writeHead(200, { 'content-type': recovery.type, 'content-security-policy': recovery.csp, 'cache-control': 'no-store' });
                response.end(recovery.body); return;
            }
            if (serveNativeSplitFixture(request, response)) return;
            if (serveTabMenuFixture(request, response)) return;
            if (serveTodayMoveFixture(request, response)) return;
            if (serveSavedMoveFixture(request, response)) return;
            if (serveTodayOrderFixture(request, response)) return;
            if (serveOrdinaryFavoriteFixture(request, response)) return;
            if (serveFavoriteIconFixture(request, response)) return;
            const path = new URL(request.url, 'http://localhost').pathname;
            if (path === '/keyboard-host' || path === '/keyboard-host.js') {
                response.writeHead(200, { 'content-type':path.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8', 'content-security-policy':KEYBOARD_CSP, 'cache-control':'no-store' });
                response.end(path.endsWith('.js') ? KEYBOARD_SCRIPT : KEYBOARD_HTML);
                return;
            }
            const title = titles[path] || 'Pair Local Fixture';
            response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            response.end(`<!doctype html><html><head><title>${title}</title><link rel="icon" href="data:,"></head><body style="font:24px system-ui;padding:3rem;background:#eef2ff"><h1>${title}</h1><p>Local GitHub Actions test page. No external resources.</p></body></html>`);
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const base = `http://127.0.0.1:${server.address().port}`;
        fixture = await arcifyOptions.evaluate(async base => {
            await chrome.storage.sync.set({ syncTabGroups: false });
            const root = (await chrome.bookmarks.search({ title: 'Arcify' })).find(node => !node.url);
            if (!root) throw new Error('Arcify failed to create its root bookmark folder.');
            const folders = {};
            for (const [key, title] of [['work', 'Pair Work'], ['personal', 'Pair Personal'], ['empty', 'Pair Empty']]) folders[key] = await chrome.bookmarks.create({ parentId: root.id, title });
            const nested = await chrome.bookmarks.create({ parentId: folders.work.id, title: 'Pair Nested' });
            const one = await chrome.bookmarks.create({ parentId: nested.id, title: 'Pair Twin One', url: `${base}/duplicate` });
            const two = await chrome.bookmarks.create({ parentId: nested.id, title: 'Pair Twin Two', url: `${base}/duplicate` });
            const discovered = await chrome.runtime.sendMessage({ type: 'spaceStore', action: 'get' });
            if (!discovered.success) throw new Error(discovered.error);
            const spaces = Object.fromEntries(Object.entries(folders).map(([key, folder]) => [key, discovered.spaces.find(space => space.bookmarkFolderId === folder.id).id]));
            const a = await chrome.windows.create({ type: 'normal', url: [`${base}/source-a`, `${base}/alpha`], focused: true });
            const b = await chrome.windows.create({ type: 'normal', url: [`${base}/source-b`, `${base}/beta`], focused: false });
            const tabA = await chrome.tabs.query({ windowId: a.id }); const tabB = await chrome.tabs.query({ windowId: b.id });
            const idFor = (tabs, suffix) => tabs.find(tab => (tab.url || tab.pendingUrl) === `${base}${suffix}`).id;
            const sourceA = idFor(tabA, '/source-a'), alpha = idFor(tabA, '/alpha'), sourceB = idFor(tabB, '/source-b'), beta = idFor(tabB, '/beta');
            for (const [tabId, spaceId] of [[sourceA, spaces.work], [alpha, spaces.personal], [sourceB, spaces.work], [beta, spaces.work]]) {
                const assigned = await chrome.runtime.sendMessage({ type: 'spaceStore', action: 'assign', tabId, spaceId });
                if (!assigned.success) throw new Error(assigned.error);
            }
            await chrome.runtime.sendMessage({ type: 'spaceStore', action: 'activate', windowId: a.id, spaceId: spaces.work });
            await chrome.runtime.sendMessage({ type: 'spaceStore', action: 'activate', windowId: b.id, spaceId: spaces.work });
            return { base, windowA: a.id, windowB: b.id, sourceA, alpha, sourceB, beta, spaces, bookmarks: { one: one.id, two: two.id }, initialSpaceOrder: discovered.spaces.map(space => space.id) };
        }, base);
        report.fixture = fixture;
        sourcePage = await pageForUrl(`${base}/source-a`);
        await poll(() => tab(fixture.alpha), tab => tab.title === 'Pair Alpha Target' && tab.status === 'complete', 'local target page load');
        await poll(() => Promise.all([tab(fixture.sourceA), tab(fixture.alpha), tab(fixture.sourceB), tab(fixture.beta)]), tabs => tabs.every(tab => tab.status === 'complete' && tab.url?.startsWith(base)), 'all local fixture pages loaded');
        const a = await snapshot(); const b = await snapshot(fixture.windowB);
        assert.deepEqual(a.spaces.map(space => space.id), fixture.initialSpaceOrder);
        assert(a.tabs.every(tab => tab.windowId === fixture.windowA)); assert(!a.tabs.some(tab => tab.id === fixture.beta));
        assert(b.tabs.every(tab => tab.windowId === fixture.windowB)); assert(!b.tabs.some(tab => tab.id === fixture.alpha));
        assert.deepEqual(a.spaces.find(space => space.id === fixture.spaces.empty).tabIds, []);
        assert.equal(a.bookmarks.filter(item => Object.values(fixture.bookmarks).includes(item.id)).length, 2);
        for (const id of [fixture.sourceA, fixture.alpha, fixture.sourceB, fixture.beta]) assert.equal((await tab(id)).groupId, -1);
        await ui(sourcePage, 'Capture local window A', () => screenshot(sourcePage, 'local-window-a'));
        const sourceBPage = await pageForUrl(`${base}/source-b`);
        await ui(sourceBPage, 'Capture local window B', () => screenshot(sourceBPage, 'local-window-b'));
        await activate(fixture.sourceA);
        fixture.windowBBaseline = await windowBState();
        return { windowA: a.windowId, windowB: b.windowId, spaceOrder: a.spaces.map(space => space.id), duplicateBookmarkIds: fixture.bookmarks };
    });
    // Supplemental runs share setup, but never depend on unrelated
    // full-suite cases or retry a failed case in an already-mutated profile.
    if (report.runMode === 'full') {
    await step(stepNames[3], async () => {
        // Keep the real sidebar document mounted while Spotlight changes spaces.
        // Checking snapshots alone misses a stale visible space and selected chip.
        sidebarFixture = await newTabPage(`chrome-extension://${arcifyId}/sidebar.html`);
        await sidebarFixture.page.waitForSelector('#spacesList > .space');
        await activate(fixture.sourceA);
        await assertSidebarSpace(fixture.spaces.work);
        const beforeCount = (await tabsIn(fixture.windowA)).length;
        await launchOverlay(); await search(sourcePage, 'Pair Alpha Target');
        await sourcePage.waitForFunction(() => document.getElementById('arcify-spotlight-host')?.shadowRoot?.querySelector('[data-testid="spotlight-frame"]')?.contentDocument?.body.textContent.includes('Pair Alpha Target'));
        await screenshot(sourcePage, 'overlay-live-tab-search'); await clickResult(sourcePage, 'Pair Alpha Target');
        await poll(() => tab(fixture.alpha), tab => tab.active, 'exact live-tab selection');
        const state = await snapshot(); assert.equal(state.activeSpaceId, fixture.spaces.personal);
        assert.equal((await tabsIn(fixture.windowA)).length, beforeCount);
        assert.equal((await snapshot(fixture.windowB)).activeSpaceId, fixture.spaces.work);
        const renderedSidebar = await assertSidebarSpace(fixture.spaces.personal);
        await screenshot(sidebarFixture.page, 'sidebar-rendered-nonempty-space-after-spotlight-selection');
        return { selectedTabId: fixture.alpha, selectedSpaceId: state.activeSpaceId, renderedSidebar, tabCountUnchanged: true };
    });
    await step(stepNames[4], async () => {
        const opened = [];
        const renderedBookmarkTitles = [];
        for (const [title, bookmarkId] of [['Pair Twin One', fixture.bookmarks.one], ['Pair Twin Two', fixture.bookmarks.two], ['Pair Twin One', fixture.bookmarks.one]]) {
            await launchOverlay(); await search(sourcePage, 'Pair Twin');
            await screenshot(sourcePage, `bookmark-search-${title}`); await clickResult(sourcePage, title);
            const state = await poll(snapshot, state => state.bookmarks.find(bookmark => bookmark.id === bookmarkId)?.tabId, `bookmark ${bookmarkId} binding`);
            const id = state.bookmarks.find(bookmark => bookmark.id === bookmarkId).tabId;
            await poll(() => tab(id), tab => tab.active, `bookmark ${bookmarkId} activation`); opened.push(id);
            await assertSidebarSpace(fixture.spaces.work);
            await poll(() => tab(id), tab => tab.status === 'complete' && tab.title === 'Pair Shared URL', 'live page title differs from its saved bookmark title');
            await sidebarFixture.page.waitForFunction(({ id, title, spaceId }) => {
                const space = [...document.querySelectorAll('#spacesList > .space')].find(space => space.dataset.spaceId === spaceId);
                return space?.querySelector(`.pinned-tabs .tab[data-tab-id="${id}"] .tab-title-display`)?.textContent === title;
            }, { polling: 50 }, { id, title, spaceId: fixture.spaces.work });
            renderedBookmarkTitles.push({ bookmarkId, tabId: id, title });
        }
        assert.notEqual(opened[0], opened[1]); assert.equal(opened[0], opened[2]);
        const duplicateTabs = (await tabsIn(fixture.windowA)).filter(tab => tab.url === `${fixture.base}/duplicate`);
        assert.equal(duplicateTabs.length, 2);
        fixture.duplicateTabs = opened.slice(0, 2);
        await screenshot(sidebarFixture.page, 'sidebar-reopened-duplicate-bookmarks-keep-saved-titles');
        return { bookmarkIds: fixture.bookmarks, tabIds: fixture.duplicateTabs, renderedBookmarkTitles, repeatReusedExactIdentity: true };
    });
    await step(stepNames[5], async () => {
        const count = (await tabsIn(fixture.windowA)).length;
        await launchOverlay('current-tab'); await enterUrl(sourcePage, `${fixture.base}/current-navigation`);
        await poll(() => tab(fixture.sourceA), tab => tab.url === `${fixture.base}/current-navigation` && tab.status === 'complete', 'same-tab navigation');
        const state = await snapshot(); assert.equal(state.tabs.find(tab => tab.id === fixture.sourceA).spaceId, fixture.spaces.work);
        assert.equal((await tabsIn(fixture.windowA)).length, count);
        await screenshot(sourcePage, 'same-tab-url-navigation');
        return { tabId: fixture.sourceA, owner: fixture.spaces.work, tabCountUnchanged: true };
    });
    await step(stepNames[6], async () => {
        await activate(fixture.sourceA);
        const helper = await newTabPage(`chrome-extension://${spotlightId}/newtab.html`);
        await search(helper.page, 'Pair Empty'); const count = (await tabsIn(fixture.windowA)).length;
        await screenshot(helper.page, 'helper-search-empty-space'); await clickResult(helper.page, 'Pair Empty');
        await poll(snapshot, state => state.activeSpaceId === fixture.spaces.empty, 'empty-space selection');
        const renderedSidebar = await assertSidebarSpace(fixture.spaces.empty);
        await screenshot(sidebarFixture.page, 'sidebar-rendered-empty-space-after-spotlight-selection');
        assert.equal((await tabsIn(fixture.windowA)).length, count);
        assert.equal(helper.page.isClosed(), false); assert.equal((await tab(helper.tab.id)).id, helper.tab.id);
        await screenshot(helper.page, 'empty-space-helper-remains-open');
        await enterUrl(helper.page, `${fixture.base}/helper-open`);
        const state = await poll(snapshot, state => state.tabs.some(tab => tab.url === `${fixture.base}/helper-open`), 'helper-created destination');
        const destination = state.tabs.find(tab => tab.url === `${fixture.base}/helper-open`);
        assert.equal(destination.spaceId, fixture.spaces.empty); assert.notEqual(destination.id, helper.tab.id);
        await poll(() => tabsIn(fixture.windowA), tabs => !tabs.some(tab => tab.id === helper.tab.id), 'helper closure after successful new tab');
        await screenshot(await pageForUrl(`${fixture.base}/helper-open`), 'helper-created-owned-tab');
        return { emptySpaceId: fixture.spaces.empty, renderedSidebar, helperTabId: helper.tab.id, destinationTabId: destination.id };
    });
    await step(stepNames[7], async () => {
        const newtab = await newTabPage('chrome://newtab/');
        await newtab.page.waitForSelector('[data-testid="spotlight-input"]');
        const identity = await newtab.page.evaluate(() => ({ extensionId: chrome.runtime.id, url: location.href, title: document.title }));
        assert.equal(identity.extensionId, spotlightId);
        await screenshot(newtab.page, 'chrome-newtab-override');
        await arcifyOptions.evaluate(id => chrome.tabs.remove(id), newtab.tab.id);
        return identity;
    });
    await step(stepNames[8], async () => {
        const sidebar = sidebarFixture;
        await activate(sidebar.tab.id);
        await sidebar.page.waitForSelector('.space.active .temporary-tabs > #newTabBtn:not([disabled])');
        await sidebar.page.waitForSelector('#spacesList > .space');
        const before = new Set((await tabsIn(fixture.windowA)).map(tab => tab.id));
        await screenshot(sidebar.page, 'sidebar-html-regular-tab-not-native-sidepanel'); await clickUI(sidebar.page, '#newTabBtn');
        const after = await poll(() => tabsIn(fixture.windowA), tabs => tabs.some(tab => !before.has(tab.id) && tab.url === `chrome-extension://${spotlightId}/newtab.html`), 'sidebar button helper launch');
        const helper = after.find(tab => !before.has(tab.id) && tab.url === `chrome-extension://${spotlightId}/newtab.html`);
        const helperPage = await pageForUrl(helper.url); await helperPage.waitForSelector('[data-testid="spotlight-input"]');
        await screenshot(helperPage, 'sidebar-button-spotlight-helper');
        const response = await external(arcifyOptions, spotlightId, 'launch', { windowId: fixture.windowA, mode: 'new-tab' });
        assert.equal(response.ok, true);
        assert.equal((await tabsIn(fixture.windowA)).length, after.length, 'An active Spotlight helper must be reused.');
        await arcifyOptions.evaluate(ids => chrome.tabs.remove(ids), [helper.id, sidebar.tab.id]);
        return { surface: 'sidebar.html in regular tab', windowId: fixture.windowA, helperTabId: helper.id, repeatedLaunchReusedHelper: true };
    });
    await step(stepNames[9], async () => {
        const order = (await snapshot()).spaces.map(space => space.id);
        await arcifyOptions.reload({ waitUntil: 'domcontentloaded' });
        await arcifyOptions.waitForSelector('#syncTabGroups');
        assert.equal(await arcifyOptions.$eval('#syncTabGroups', element => element.checked), false);
        await clickUI(arcifyOptions, 'label.toggle-label[for="syncTabGroups"]');
        await poll(() => Promise.all([tab(fixture.sourceA), tab(fixture.sourceB), tab(fixture.alpha)]), tabs => tabs.every(tab => tab.groupId >= 0), 'one-way group projection');
        const a = await tab(fixture.sourceA), b = await tab(fixture.sourceB), personal = await tab(fixture.alpha);
        assert.notEqual(a.groupId, b.groupId); assert.notEqual(a.groupId, personal.groupId);
        const groups = await arcifyOptions.evaluate(ids => Promise.all(ids.map(id => chrome.tabGroups.get(id))), [a.groupId, b.groupId, personal.groupId]);
        assert.deepEqual(groups.map(group => group.title), ['Pair Work', 'Pair Work', 'Pair Personal']);
        assert.deepEqual(groups.map(group => group.windowId), [fixture.windowA, fixture.windowB, fixture.windowA]);
        assert.deepEqual((await snapshot()).spaces.map(space => space.id), order);
        await screenshot(arcifyOptions, 'group-sync-enabled-options');
        await clickUI(arcifyOptions, 'label.toggle-label[for="syncTabGroups"]');
        await poll(() => arcifyOptions.evaluate(() => chrome.storage.sync.get('syncTabGroups')), settings => settings.syncTabGroups === false, 'group sync disabled');
        const opened = await bridge('openTab', { spaceId: fixture.spaces.work, url: `${fixture.base}/sync-off-open` });
        assert.equal((await tab(opened.tabId)).groupId, -1);
        assert.equal((await tab(fixture.sourceA)).groupId, a.groupId, 'Turning sync off leaves existing groups unchanged.');
        assert.deepEqual(opened.snapshot.spaces.map(space => space.id), order);
        return { workGroups: [a.groupId, b.groupId], personalGroup: personal.groupId, ungroupedNewTabWhenOff: opened.tabId };
    });
    await step(stepNames[10], async () => {
        const before = await tabsIn(fixture.windowB);
        const wrongWindow = await external(spotlightOptions, arcifyId, 'activateTab', { windowId: fixture.windowA, tabId: fixture.beta });
        assert.equal(wrongWindow.ok, false); assert.equal(wrongWindow.error.code, 'STALE_TAB');
        const invalid = await external(spotlightOptions, arcifyId, 'openTab', { windowId: fixture.windowA, url: 'javascript:alert(1)' });
        assert.equal(invalid.ok, false); assert.equal(invalid.error.code, 'INVALID_REQUEST');
        const version = await spotlightOptions.evaluate(async ({ peerId, windowId }) => chrome.runtime.sendMessage(peerId, { type: 'arcify-bridge', version: 999, requestId: 'ci-wrong-version', command: 'snapshot', windowId }), { peerId: arcifyId, windowId: fixture.windowA });
        assert.equal(version.ok, false); assert.equal(version.error.code, 'VERSION_MISMATCH');
        assert.deepEqual((await tabsIn(fixture.windowB)).map(tab => [tab.id, tab.active]), before.map(tab => [tab.id, tab.active]));
        return { wrongWindow: wrongWindow.error.code, unsafeUrl: invalid.error.code, wrongVersion: version.error.code };
    });
    await step(stepNames[11], async () => {
        const url = `chrome-extension://${arcifyId}/background.js`;
        const workerTarget = await browser.waitForTarget(target => target.type() === 'service_worker' && target.url() === url);
        const worker = await workerTarget.worker();
        const cdp = await browser.target().createCDPSession();
        const readTargets = async () => (await cdp.send('Target.getTargets')).targetInfos;
        report.workerTermination = [];
        try {
            const requestId = `ci-journal-${crypto.randomUUID()}`;
            const payload = { spaceId: fixture.spaces.work, url: `${fixture.base}/journal-open` };
            const first = await bridge('openTab', payload, requestId);
            const before = await terminateObservedWorker({ worker, url, readTargets,
                releaseNetwork: async () => {
                    const network = await networkTargets.get(workerTarget);
                    assert(network, 'The fixture-owned worker network session must be tracked.');
                    const sessionId = network.id();
                    await network.detach();
                    networkTargets.delete(workerTarget);
                    return sessionId;
                },
                record: async observation => { report.workerTermination.push({ ...observation, observedAt: new Date().toISOString() }); await saveReport(); }
            });
            const repeated = await bridge('openTab', payload, requestId);
            assert.equal(repeated.tabId, first.tabId);
            assert.equal((await tabsIn(fixture.windowA)).filter(tab => tab.url === payload.url).length, 1);
            const after = await poll(readTargets, targets => targets.some(target => target.type === 'service_worker' && target.url === url && target.targetId !== before.targetId), 'a distinct raw Chrome worker after wake');
            const restarted = findExactWorkerTarget(after, url);
            assert.notEqual(restarted.targetId, before.targetId);
            const target = await browser.waitForTarget(target => target !== workerTarget && target.type() === 'service_worker' && target.url() === url);
            await blockExternalHttps(target);
            const identity = await waitForExtensionWorkerIdentity(await target.worker(), arcifyId);
            report.workerTermination.push({ phase: 'restarted', target: restarted, identity, observedAt: new Date().toISOString() });
            return { method: 'Puppeteer WebWorker.close', oldTargetId: before.targetId, restartedTargetId: restarted.targetId,
                repeatedRequestId: requestId, originalAndReplayedTabId: first.tabId, realWorkerRestarted: true };
        } finally { await cdp.detach(); await saveReport(); }
    });
    await step(stepNames[12], async () => {
        const before = await snapshot();
        for (const name of ['arcify', 'spotlight']) await reloadPairedExtension(name);
        await clickUI(spotlightOptions, '#refresh-connection', '#refresh-connection:not([disabled])'); await spotlightOptions.waitForSelector('#connection-status[data-state="connected"]');
        const after = await snapshot();
        assert.deepEqual(after.spaces.map(space => space.id), before.spaces.map(space => space.id));
        for (const tabId of [fixture.sourceA, fixture.alpha]) assert.equal(after.tabs.find(tab => tab.id === tabId)?.spaceId, before.tabs.find(tab => tab.id === tabId)?.spaceId);
        const replayed = await bridge('activateTab', { tabId: fixture.alpha }); assert.equal(replayed.tabId, fixture.alpha);
        await ui(spotlightOptions, 'Capture connected settings after reloads', () => screenshot(spotlightOptions, 'connected-after-both-extension-reloads'));
        return { reloadedExtensionIds: [arcifyId, spotlightId], stableSpaceIds: after.spaces.map(space => space.id), note: 'Extension reload is distinct from service-worker suspension and from a full Chrome restart. Existing page content scripts require a page refresh after extension reload.' };
    });
    await step(stepNames[13], async () => {
        const arcify = await arcifyOptions.evaluate(() => chrome.commands.getAll());
        const spotlight = await spotlightOptions.evaluate(() => chrome.commands.getAll());
        for (const name of ['toggleSpotlight', 'toggleSpotlightNewTab']) assert(spotlight.some(command => command.name === name));
        assert(arcify.some(command => command.name === '_execute_action'));
        await ui(arcifyOptions, 'Capture final Arcify settings', () => screenshot(arcifyOptions, 'final-arcify-settings'));
        await ui(spotlightOptions, 'Capture final Spotlight settings', () => screenshot(spotlightOptions, 'final-spotlight-settings'));
        return { arcify, spotlight, actualOsShortcutPressTested: false, nativeSidePanelTestedByThisCheck: false };
    });

    await step(stepNames[14], async () => {
        await arcifyOptions.evaluate(() => {
            globalThis.__pairedSidebarEvents = [];
            chrome.sidePanel.onOpened.addListener(info => globalThis.__pairedSidebarEvents.push({ type: 'opened', ...info, observedAt: Date.now() }));
            chrome.sidePanel.onClosed.addListener(info => globalThis.__pairedSidebarEvents.push({ type: 'closed', ...info, observedAt: Date.now() }));
        });
        const helper = await newTabPage('chrome://newtab/');
        await waitSidebarCommand(helper.page);
        await waitStartupResults(helper.page);
        const focusBefore = await helper.page.evaluate(() => ({ focused: document.hasFocus(), activeElement: document.activeElement?.tagName, inputFocused: document.activeElement?.matches('[data-testid="spotlight-input"]') }));
        const offered = await external(arcifyOptions, spotlightId, 'startupSuggestion', { windowId: fixture.windowA, tabId: helper.tab.id });
        assert.equal(offered.ok, true, JSON.stringify(offered)); assert.equal(offered.accepted, true, JSON.stringify(offered));
        await helper.page.waitForSelector(`${sidebarSelector}.selected`);
        const repeated = await external(arcifyOptions, spotlightId, 'startupSuggestion', { windowId: fixture.windowA, tabId: helper.tab.id });
        assert.equal(repeated.accepted, false, 'The same page must not accept a second startup preselection.');
        const before = await tabsIn(fixture.windowA);
        const eventCount = (await nativePanelState()).events.length;
        const sourceTabBefore = before.find(tab => tab.id === helper.tab.id);
        const sourceBefore = { tabId: sourceTabBefore.id, windowId: sourceTabBefore.windowId, tabUrl: sourceTabBefore.url, pendingUrl: sourceTabBefore.pendingUrl, pageUrl: helper.page.url() };
        await screenshot(helper.page, 'startup-sidebar-command-selected-before-explicit-input-focus');
        await sidebarEnter(helper.page, 'Trusted Enter on startup sidebar suggestion (Spotlight focus explicit)');
        await waitSidebarSuccess(helper.page);
        const native = await captureNativeSidebar(eventCount, 'native-sidebar-opened-from-startup-suggestion');
        const sourceTabAfter = await tab(helper.tab.id);
        assertSidebarHelperUnchanged(sourceBefore, { tabId: sourceTabAfter.id, windowId: sourceTabAfter.windowId, tabUrl: sourceTabAfter.url, pendingUrl: sourceTabAfter.pendingUrl, pageUrl: helper.page.url(), closed: helper.page.isClosed() }, { extensionId: spotlightId });
        assert.deepEqual((await tabsIn(fixture.windowA)).map(tab => tab.id), before.map(tab => tab.id), 'Opening a panel must not create or close a tab.');
        const { page: rowPage } = await resolveNativeSidebarTarget();
        const newTabRow = await exerciseNativeNewTabRow({ page: await observePage(rowPage), helper, apiPage: arcifyOptions,
            peerPage: spotlightOptions, spotlightId, windowId: fixture.windowA, snapshot, poll, ui, search, activate, screenshot,
            record: async observation => { recordNewTabRowEvidence(report, observation); await saveReport(); } });
        await closeNativeSidebar(); await arcifyOptions.evaluate(id => chrome.tabs.remove(id), helper.tab.id);
        return { startupOffer: offered, repeatedOffer: repeated, focusBefore, focusExplicitlySetForEnter: true, actualBrowserStartupTested: false, sourceBefore, native, newTabRow };
    });
    await step(stepNames[15], async () => {
        // Observe actual paired requests before helper creation, including any
        // initialization still running when the selected row first appears.
        const spotlightTarget = await browser.waitForTarget(target => target.type() === 'service_worker' && target.url() === `chrome-extension://${spotlightId}/background.js`);
        const setupWorker = await spotlightTarget.worker();
        await setupWorker.evaluate(installColdSetupObserver, { kind: 'worker', peerId: arcifyId, windowId: fixture.windowA });
        let helper, preparedInput, session, pageObserved = false, workerObserved = true;
        report.sidebarColdSetup = [];
        try {
            helper = await newTabPage(`chrome-extension://${spotlightId}/newtab.html`);
            await waitSidebarCommand(helper.page);
            await waitStartupResults(helper.page);
            await helper.page.evaluate(installColdSetupObserver, { kind: 'page', peerId: arcifyId, windowId: fixture.windowA });
            pageObserved = true;
            const offered = await external(arcifyOptions, spotlightId, 'startupSuggestion', { windowId: fixture.windowA, tabId: helper.tab.id });
            assert.equal(offered.accepted, true, JSON.stringify(offered));
            await helper.page.waitForSelector(`${sidebarSelector}.selected`);
            preparedInput = await sidebarInput(helper.page);
            await ui(helper.page, 'Prepare Spotlight focus before stopping Arcify worker', () => preparedInput.asElement().focus());
            await helper.page.evaluate(() => {
                globalThis.__pairedSidebarKey = null;
                document.addEventListener('keydown', event => {
                    if (event.key === 'Enter') globalThis.__pairedSidebarKey = { trusted: event.isTrusted, observedAt: Date.now(), focusedInput: event.target.matches('[data-testid="spotlight-input"]') };
                }, { capture: true, once: true });
            });
            const beforeTabs = await tabsIn(fixture.windowA);
            const eventCount = (await nativePanelState()).events.length;
            const url = `chrome-extension://${arcifyId}/background.js`;
            const workerTarget = await browser.waitForTarget(target => target.type() === 'service_worker' && target.url() === url);
            const worker = await workerTarget.worker();
            session = await browser.target().createCDPSession();
            const readTargets = async () => (await session.send('Target.getTargets')).targetInfos;
            report.sidebarColdWorker = [];
            await waitForColdSetupQuiescence(async () => {
                const [page, worker] = await Promise.all([
                    helper.page.evaluate(readColdSetupObserver), setupWorker.evaluate(readColdSetupObserver)
                ]);
                return { page, worker };
            }, async observation => { report.sidebarColdSetup.push(observation); await saveReport(); });
            // Restore instrumentation before the one stop. These are local realm
            // operations only, with no focus, query, peer request, or timer changes.
            report.sidebarColdSetup.push(await helper.page.evaluate(stopColdSetupObserver)); pageObserved = false;
            report.sidebarColdSetup.push(await setupWorker.evaluate(stopColdSetupObserver)); workerObserved = false;
            await saveReport();
            const lifecycleStart = report.targetLifecycle.length;
            const old = await terminateObservedWorker({ worker, url, readTargets,
                releaseNetwork: async () => { const network = await networkTargets.get(workerTarget); assert(network); const id = network.id(); await network.detach(); networkTargets.delete(workerTarget); return id; },
                record: async observation => { report.sidebarColdWorker.push(observation); await saveReport(); }
            });
            // No bridge status/snapshot/search request between termination and this
            // genuine key event: the selected row and capability are already ready.
            const beforeInput = await readTargets();
            assert.equal(beforeInput.filter(target => target.type === 'service_worker' && target.url === url).length, 0, 'No Arcify worker may already exist immediately before the cold Enter.');
            const inputBoundary = Date.now();
            report.sidebarColdWorker.push({ phase: 'before-trusted-enter', targets: beforeInput, inputBoundary });
            // Focus is already prepared. Do not run ui(), a search/status read or
            // any peer message between the raw absence proof and this real key.
            await helper.page.keyboard.press('Enter');
            const key = await helper.page.evaluate(() => globalThis.__pairedSidebarKey);
            assert.equal(key?.trusted, true); assert.equal(key.focusedInput, true);
            assert(!report.targetLifecycle.slice(lifecycleStart).some(event => event.event === 'Target.targetCreated' &&
                event.details?.targetInfo?.url === url && Date.parse(event.observedAt) < key.observedAt), 'A replacement worker was observed before the real Enter event.');
            report.sidebarColdWorker.push({ phase: 'trusted-enter-observed', key });
            await waitSidebarSuccess(helper.page);
            const native = await captureNativeSidebar(eventCount, 'native-sidebar-opened-after-cold-worker-enter');
            const targets = await poll(readTargets, targets => targets.some(target => target.url === url && target.type === 'service_worker' && target.targetId !== old.targetId), 'sidebar command waking a distinct Arcify worker');
            const replacement = findExactWorkerTarget(targets, url); assert.notEqual(replacement.targetId, old.targetId);
            const target = await browser.waitForTarget(target => target !== workerTarget && target.type() === 'service_worker' && target.url() === url);
            const identity = await waitForExtensionWorkerIdentity(await target.worker(), arcifyId);
            assert.deepEqual((await tabsIn(fixture.windowA)).map(tab => tab.id), beforeTabs.map(tab => tab.id));
            assert.equal(helper.page.isClosed(), false);
            await closeNativeSidebar(); await arcifyOptions.evaluate(id => chrome.tabs.remove(id), helper.tab.id);
            return { oldTargetId: old.targetId, replacement, identity, native };
        } finally {
            // Retain real request/event traces even when setup fails. Restoration
            // is required on every exit; no observer survives the cold boundary.
            try {
                if (pageObserved) report.sidebarColdSetup.push(await helper.page.evaluate(stopColdSetupObserver));
            } finally {
                try {
                    if (workerObserved) report.sidebarColdSetup.push(await setupWorker.evaluate(stopColdSetupObserver));
                } finally {
                    await preparedInput?.dispose(); await session?.detach(); await saveReport();
                }
            }
        }
    });
    await step(stepNames[16], async () => {
        // Both extensions were reloaded earlier. Refresh this existing webpage so
        // it has a current Spotlight content script before exercising its command.
        await sourcePage.reload({ waitUntil: 'domcontentloaded' });
        await launchOverlay('current-tab'); await search(sourcePage, 'open arcify sidebar'); await waitSidebarCommand(sourcePage);
        const before = await tabsIn(fixture.windowA); const eventCount = (await nativePanelState()).events.length;
        await clickResult(sourcePage, 'Open Arcify sidebar'); await waitSidebarSuccess(sourcePage);
        const native = await captureNativeSidebar(eventCount, 'native-sidebar-opened-by-overlay-command-click');
        assert.deepEqual((await tabsIn(fixture.windowA)).map(tab => tab.id), before.map(tab => tab.id));
        await closeNativeSidebar();
        const input = await sidebarInput(sourcePage);
        try { await ui(sourcePage, 'Dismiss overlay after sidebar command', () => input.asElement().press('Escape')); } finally { await input.dispose(); }
        return { sourceTabId: fixture.sourceA, native, actualTrustedClick: true };
    });
    await step(stepNames[17], async () => {
        const helper = await newTabPage(`chrome-extension://${spotlightId}/newtab.html`); await waitSidebarCommand(helper.page);
        const session = await helper.page.target().createCDPSession();
        let nonGesture, malformed;
        const eventCount = (await nativePanelState()).events.length;
        try {
            await poll(() => evaluateWithoutGesture(session, 'navigator.userActivation.isActive'), active => active === false, 'expired source activation for negative probe');
            const request = { type: 'arcify-sidebar', version: 1, requestId: `no-gesture-${crypto.randomUUID()}` };
            const expression = message => `new Promise(resolve => chrome.runtime.sendMessage(${JSON.stringify(arcifyId)}, ${JSON.stringify(message)}, response => resolve({response, transportError: chrome.runtime.lastError?.message || null})))`;
            nonGesture = await evaluateWithoutGesture(session, expression(request));
            assert.equal(nonGesture.transportError, null); assert.equal(nonGesture.response?.ok, false);
            assert.equal(nonGesture.response.error?.code, 'OPEN_FAILED', 'A valid paired non-gesture request must reach Chrome gesture enforcement.');
            assert.match(nonGesture.response.error.message, /user (?:gesture|action)/i);
            malformed = await evaluateWithoutGesture(session, expression({ ...request, requestId: `bad-target-${crypto.randomUUID()}`, tabId: fixture.sourceB }));
            assert.equal(malformed.response?.ok, false); assert.equal(malformed.response.error?.code, 'INVALID_REQUEST');
        } finally { await session.detach(); }
        assert.equal((await nativePanelState()).events.length, eventCount, 'Rejected requests must not open the panel.');
        // Revoke Arcify's grant through its actual settings. The source still has
        // its prior prepared row, so the fresh receiver-side storage read is tested.
        await clickUI(arcifyOptions, '#bridgeDisconnect'); await arcifyOptions.waitForSelector('#bridgeStatus[data-state="disabled"]');
        await clickResult(helper.page, 'Open Arcify sidebar');
        await helper.page.waitForFunction(() => document.querySelector('.arcify-bridge-status[data-state="error"]')?.textContent.includes('toolbar'), { polling: 50 });
        const revokedStatus = await helper.page.$eval('.arcify-bridge-status', element => element.textContent);
        assert.equal(helper.page.isClosed(), false); assert.equal((await nativePanelState()).events.length, eventCount);
        await screenshot(helper.page, 'sidebar-command-revoked-peer-error-keeps-page');
        await typeUI(arcifyOptions, '#bridgePeerId', spotlightId); await clickUI(arcifyOptions, '#bridgeSave'); await arcifyOptions.waitForSelector('#bridgeStatus[data-state="connected"]');
        await arcifyOptions.evaluate(id => chrome.tabs.remove(id), helper.tab.id);
        return { nonGesture, malformed, revokedStatus, noPanelOpened: true };
    });
    await step(stepNames[18], async () => {
        const typed = await newTabPage(`chrome-extension://${spotlightId}/newtab.html`); await waitSidebarCommand(typed.page);
        await search(typed.page, 'keep my typed query');
        const typedBefore = await tabsIn(fixture.windowA);
        const refused = await external(arcifyOptions, spotlightId, 'startupSuggestion', { windowId: fixture.windowA, tabId: typed.tab.id });
        assert.equal(refused.ok, true); assert.equal(refused.accepted, false); assert.equal(refused.reason, 'user-interaction');
        assert.equal(await typed.page.$eval('[data-testid="spotlight-input"]', input => input.value), 'keep my typed query');
        assert.deepEqual((await tabsIn(fixture.windowA)).map(tab => [tab.id, tab.active]), typedBefore.map(tab => [tab.id, tab.active]));
        await arcifyOptions.evaluate(id => chrome.tabs.remove(id), typed.tab.id);
        const chosen = await newTabPage(`chrome-extension://${spotlightId}/newtab.html`); await waitSidebarCommand(chosen.page);
        const input = await sidebarInput(chosen.page);
        try { await ui(chosen.page, 'Choose a startup result manually', () => input.asElement().press('ArrowDown')); } finally { await input.dispose(); }
        const selectedBefore = await chosen.page.$eval('[data-testid="spotlight-result"].selected', row => row.textContent);
        const refusedSelection = await external(arcifyOptions, spotlightId, 'startupSuggestion', { windowId: fixture.windowA, tabId: chosen.tab.id });
        assert.equal(refusedSelection.accepted, false); assert.equal(refusedSelection.reason, 'user-interaction');
        assert.equal(await chosen.page.$eval('[data-testid="spotlight-result"].selected', row => row.textContent), selectedBefore);
        await screenshot(chosen.page, 'startup-offer-preserves-manual-selection');
        await arcifyOptions.evaluate(id => chrome.tabs.remove(id), chosen.tab.id);
        return { typedOffer: refused, manualSelectionOffer: refusedSelection, sourceInputAndSelectionPreserved: true,
            note: 'Real authenticated offer/UI behavior; once-per-session onStartup controller ordering is separately unit-tested.' };
    });

    await step(stepNames[19], async () => {
        const helper = await newTabPage('chrome://newtab/'); await waitSidebarCommand(helper.page);
        await search(helper.page, 'pair wrok');
        await helper.page.waitForFunction(() => document.querySelector('[data-testid="spotlight-result"].selected')?.dataset.resultType === 'arcify-space', { polling: 50 });
        const workspaceRows = await helper.page.evaluate(readSpotlightRows);
        assertMatchedActionFirst(workspaceRows, { type: 'arcify-space', title: 'Pair Work', query: 'pair wrok' });
        await search(helper.page, 'opn arcfi');
        await helper.page.waitForSelector(`${sidebarSelector}.selected`);
        const newtabRows = await helper.page.evaluate(readSpotlightRows);
        assertMatchedActionFirst(newtabRows, { type: 'arcify-sidebar-command', title: 'Open Arcify sidebar', query: 'opn arcfi' });
        await screenshot(helper.page, 'fuzzy-sidebar-action-first-newtab');
        const events = (await nativePanelState()).events.length;
        await sidebarEnter(helper.page, 'Enter fuzzy-matched sidebar command'); await waitSidebarSuccess(helper.page);
        const native = await captureNativeSidebar(events, 'native-sidebar-from-fuzzy-newtab-command');
        await closeNativeSidebar(); await arcifyOptions.evaluate(id => chrome.tabs.remove(id), helper.tab.id);
        const temporary = await arcifyOptions.evaluate(options => chrome.tabs.create(options), { windowId: fixture.windowA, url: `${fixture.base}/sidebar-match`, active: false });
        await poll(() => tab(temporary.id), tab => tab.title === 'Open Arcify sidebar', 'temporary matching live tab title');
        await launchOverlay('current-tab'); await search(sourcePage, 'opn arcfi');
        await sourcePage.waitForFunction(() => document.getElementById('arcify-spotlight-host')?.shadowRoot?.querySelector('[data-testid="spotlight-frame"]')?.contentDocument?.querySelector('[data-result-type="arcify-sidebar-command"].selected'), { polling: 50 });
        await poll(() => sourcePage.evaluate(readSpotlightRows), rows => rows.some(row => row.type === 'open-tab' && row.title === 'Open Arcify sidebar'), 'matching ordinary tab alongside the fuzzy action');
        const overlayRows = await sourcePage.evaluate(readSpotlightRows);
        assertMatchedActionFirst(overlayRows, { type: 'arcify-sidebar-command', title: 'Open Arcify sidebar', query: 'opn arcfi' });
        await screenshot(sourcePage, 'fuzzy-sidebar-action-first-overlay');
        const input = await sidebarInput(sourcePage);
        try {
            report.fuzzyManualSelection = await ui(sourcePage, 'Choose retained web search below matched actions', () =>
                selectResultWithKeyboard(input.asElement(), () => sourcePage.evaluate(readSpotlightRows), row => row.type === 'search-query' && row.title === 'Search for "opn arcfi"'));
            await saveReport();
            assert.equal((await sourcePage.evaluate(readSpotlightRows)).find(row => row.selected)?.type, 'search-query');
            // Observe the real session registry before stopping its owner. Do not
            // write tracking state or guess a delay to make restart delivery pass.
            await poll(() => spotlightOptions.evaluate(() => chrome.storage.session.get('spotlightVisibleOverlayTabIds')),
                saved => saved.spotlightVisibleOverlayTabIds?.includes(fixture.sourceA), 'durably registered live overlay');
            const workerUrl = `chrome-extension://${spotlightId}/background.js`;
            const target = await browser.waitForTarget(target => target.type() === 'service_worker' && target.url() === workerUrl);
            const worker = await target.worker();
            const session = await browser.target().createCDPSession();
            const readTargets = async () => (await session.send('Target.getTargets')).targetInfos;
            report.overlayFreshnessRestart = [];
            try {
                const old = await terminateObservedWorker({ worker, url: workerUrl, readTargets,
                    releaseNetwork: async () => { const network = await networkTargets.get(target); assert(network); const id = network.id(); await network.detach(); networkTargets.delete(target); return id; },
                    record: async observation => { report.overlayFreshnessRestart.push(observation); await saveReport(); }
                });
                await arcifyOptions.evaluate(id => chrome.tabs.remove(id), temporary.id);
                await poll(() => sourcePage.evaluate(readSpotlightRows), rows => !rows.some(row => row.type === 'open-tab' && row.title === 'Open Arcify sidebar'), 'overlay closed-tab invalidation after Spotlight worker restart');
                const rowsAfterRestart = await sourcePage.evaluate(readSpotlightRows);
                assert.equal(rowsAfterRestart.find(row => row.selected)?.type, 'search-query', 'A live refresh must preserve manually selected web search.');
                assert.equal(await input.asElement().evaluate(element => element.value), 'opn arcfi', 'A lifecycle refresh must preserve the typed query.');
                const targets = await poll(readTargets, targets => targets.some(item => item.url === workerUrl && item.type === 'service_worker' && item.targetId !== old.targetId), 'distinct Spotlight worker after native tab event');
                const replacement = findExactWorkerTarget(targets, workerUrl); assert.notEqual(replacement.targetId, old.targetId);
                const replacementTarget = await browser.waitForTarget(item => item !== target && item.type() === 'service_worker' && item.url() === workerUrl);
                const identity = await waitForExtensionWorkerIdentity(await replacementTarget.worker(), spotlightId);
                report.overlayFreshnessRestart.push({ phase: 'restarted-and-refreshed', replacement, identity, rowsAfterRestart });
                await screenshot(sourcePage, 'manual-web-search-survives-live-tab-removal-worker-restart');
            } finally { await session.detach(); }
            await ui(sourcePage, 'Dismiss fuzzy action overlay without searching', () => input.asElement().press('Escape'));
        } finally { await input.dispose(); }
        return { workspaceRows, newtabRows, overlayRows, native, retainedWebSearchManuallySelectable: true };
    });
    await step(stepNames[20], async () => {
        const first = await newTabPage('chrome://newtab/');
        const second = await newTabPage('chrome://newtab/');
        const helper = await newTabPage('chrome://newtab/'); await waitSidebarCommand(helper.page);
        const rowsNamedNewTab = rows => rows.filter(row => ['open-tab', 'pinned-tab'].includes(row.type) && row.title === 'New Tab');
        await poll(() => helper.page.evaluate(readSpotlightRows), rows => rowsNamedNewTab(rows).length === 2, 'two legitimate New Tabs with the current helper excluded');
        const authoritative = await helper.page.evaluate(() => chrome.runtime.sendMessage({ action: 'getSpotlightSuggestions', query: '', mode: 'current-tab' }));
        assert.equal(authoritative.success, true);
        const visibleTabIds = authoritative.results.filter(row => ['open-tab','pinned-tab'].includes(row.type)).map(row => row.metadata.tabId);
        assert(visibleTabIds.includes(first.tab.id) && visibleTabIds.includes(second.tab.id), 'Both distinct same-title tabs must remain discoverable.');
        assert(!visibleTabIds.includes(helper.tab.id), 'The current helper must not offer switching to itself.');
        await screenshot(helper.page, 'two-valid-newtab-identities-no-self-helper');
        await arcifyOptions.evaluate(id => chrome.tabs.remove(id), first.tab.id);
        await poll(() => helper.page.evaluate(readSpotlightRows), rows => rowsNamedNewTab(rows).length === 1, 'closed-tab removal reflected without another input event');
        assert.equal(await helper.page.$eval('[data-testid="spotlight-input"]', input => input.value), '');
        await screenshot(helper.page, 'closed-newtab-removed-without-typing');
        const before = await tabsIn(fixture.windowA);
        await ui(helper.page, 'Select remaining New Tab', () => clickFreshResult(timeout =>
            locateRemainingNewTabResult(helper.page, timeout, async observation => {
                report.newTabResultReadiness ||= []; report.newTabResultReadiness.push({ ...observation, observedAt: new Date().toISOString() }); await saveReport();
            }), async observation => {
                report.resultClicks ||= []; report.resultClicks.push({ title: 'New Tab', ...observation, observedAt: new Date().toISOString() }); await saveReport();
            }));
        await poll(() => tab(second.tab.id), tab => tab.active, 'remaining legitimate New Tab activation');
        await poll(async () => helper.page.isClosed(), closed => closed, 'source helper closes after switching to the other tab');
        assert.equal((await tabsIn(fixture.windowA)).length, before.length - 1, 'Only the source helper may close during a valid switch.');
        await arcifyOptions.evaluate(id => chrome.tabs.remove(id), second.tab.id);
        return { initialLiveTabIds: [first.tab.id,second.tab.id], excludedSourceTabId: helper.tab.id,
            removedTabId: first.tab.id, remainingActivatedTabId: second.tab.id, refreshedWithoutInput: true };
    });


    await step(stepNames[21], async () => {
        const malformedSignal = await external(arcifyOptions, spotlightId, 'invalidate', { windowId:fixture.windowA, spaces:[] });
        assert.equal(malformedSignal.ok,false); assert.equal(malformedSignal.error.code,'INVALID_REQUEST');
        const wrongWindowSignal = await external(arcifyOptions, spotlightId, 'invalidate', { windowId:fixture.windowB });
        assert.equal(wrongWindowSignal.ok,false); assert.equal(wrongWindowSignal.error.code,'INVALID_WINDOW');
        assert.equal(await arcifyOptions.evaluate(async () => (await chrome.storage.sync.get('syncTabGroups')).syncTabGroups), false);
        const created = await arcifyOptions.evaluate(async ({ windowId, base, spaceId }) => {
            const tabs = [];
            for (const path of ['/logical-one', '/logical-two']) {
                const tab = await chrome.tabs.create({ windowId, url: `${base}${path}`, active: false });
                const result = await chrome.runtime.sendMessage({ type: 'spaceStore', action: 'assign', tabId: tab.id, spaceId });
                if (!result.success) throw new Error(result.error);
                tabs.push(tab.id);
            }
            return tabs;
        }, { windowId: fixture.windowA, base: fixture.base, spaceId: fixture.spaces.work });
        for (const id of created) await poll(() => tab(id), tab => tab.status === 'complete' && tab.title.startsWith('Logical Tab'), 'settled logical fixture tab');
        const helper = await newTabPage('chrome://newtab/'); await waitSidebarCommand(helper.page);
        await poll(() => tab(helper.tab.id), tab => tab.status === 'complete', 'settled logical test helper');
        await search(helper.page, 'logical');
        const logicalRows = rows => rows.filter(row => row.type === 'open-tab' && row.title.startsWith('Logical Tab'));
        await poll(() => helper.page.evaluate(readSpotlightRows), rows => logicalRows(rows).length === 2, 'both logical fixture rows');
        const initialSnapshot = await snapshot();
        const initialIds = initialSnapshot.spaces.find(space => space.id === fixture.spaces.work).temporaryTabIds.filter(id => created.includes(id));
        assert.equal(initialIds.length,2);
        const titleById = new Map(initialSnapshot.tabs.map(tab => [tab.id,tab.title]));
        const initialTitles = initialIds.map(id => titleById.get(id));
        assert.deepEqual(initialTitles.slice().sort(), ['Logical Tab One','Logical Tab Two']);
        const reorderedTitles = initialTitles.slice().reverse();
        const scored = await helper.page.evaluate(() => chrome.runtime.sendMessage({ action:'getLocalSuggestions',query:'logical',mode:'new-tab' }));
        assert.equal(scored.success,true);
        const scores = scored.results.filter(row => created.includes(row.metadata?.tabId)).map(row => row.score);
        assert.equal(scores.length,2); assert(scores.every(Number.isFinite)); assert.equal(scores[0],scores[1], 'The order regression requires equal relevance, not overriding search ranking.');
        assert.deepEqual(logicalRows(await helper.page.evaluate(readSpotlightRows)).map(row => row.title),initialTitles);
        const input = await sidebarInput(helper.page);
        try {
            report.logicalManualSelection = await ui(helper.page, 'Explicitly keep web search selected during logical updates', () =>
                selectResultWithKeyboard(input.asElement(), () => helper.page.evaluate(readSpotlightRows), row => row.type === 'search-query' && row.title === 'Search for "logical"'));
            await saveReport();
            assert.equal((await helper.page.evaluate(readSpotlightRows)).find(row => row.selected)?.type, 'search-query');
            // Observe the real native event stream; no event is synthesized or suppressed.
            await arcifyOptions.evaluate(windowId => {
                globalThis.__logicalTabEvents = [];
                globalThis.__logicalTabListeners = [];
                for (const name of ['onCreated','onRemoved','onMoved','onAttached','onDetached','onUpdated','onActivated','onReplaced']) {
                    const callback = (...args) => {
                        const observedWindow = name === 'onCreated' ? args[0]?.windowId : name === 'onUpdated' ? args[2]?.windowId
                            : name === 'onActivated' ? args[0]?.windowId : args[1]?.windowId ?? args[1]?.newWindowId ?? args[1]?.oldWindowId;
                        if (observedWindow === windowId || name === 'onReplaced') globalThis.__logicalTabEvents.push({ name, args, at: Date.now() });
                    };
                    chrome.tabs[name].addListener(callback); globalThis.__logicalTabListeners.push([name,callback]);
                }
            }, fixture.windowA);
            const reordered = await arcifyOptions.evaluate(async ({ ids, spaceId }) => {
                const current = await chrome.runtime.sendMessage({ type:'spaceStore',action:'get' });
                if (!current.success) throw new Error(current.error);
                const after = structuredClone(current.spaces), space = after.find(space => space.id === spaceId);
                space.temporaryTabs = [...space.temporaryTabs.filter(id => !ids.includes(id)), ...ids.slice().reverse()];
                return chrome.runtime.sendMessage({ type:'spaceStore',action:'patch',before:current.spaces,after });
            }, { ids: initialIds, spaceId: fixture.spaces.work });
            assert.equal(reordered.success, true);
            await poll(() => helper.page.evaluate(readSpotlightRows), rows => JSON.stringify(logicalRows(rows).map(row => row.title)) === JSON.stringify(reorderedTitles), 'logical tab order without input or native events');
            report.logicalNativeEventCheckpoints = [{ phase:'reordered', events:await arcifyOptions.evaluate(() => globalThis.__logicalTabEvents) }];
            assert.deepEqual(report.logicalNativeEventCheckpoints.at(-1).events, []);
            await screenshot(helper.page, 'logical-tab-order-refreshed-without-native-events');

            const workerUrl = `chrome-extension://${spotlightId}/background.js`;
            const target = await browser.waitForTarget(target => target.type() === 'service_worker' && target.url() === workerUrl);
            const worker = await target.worker(); const session = await browser.target().createCDPSession();
            const readTargets = async () => (await session.send('Target.getTargets')).targetInfos;
            report.logicalInvalidationRestart = [];
            try {
                const old = await terminateObservedWorker({ worker, url: workerUrl, readTargets,
                    releaseNetwork: async () => { const network = await networkTargets.get(target); assert(network); const id = network.id(); await network.detach(); networkTargets.delete(target); return id; },
                    record: async observation => { report.logicalInvalidationRestart.push(observation); await saveReport(); }
                });
                const assigned = await internal(arcifyOptions, { type:'spaceStore',action:'assign',tabId:created[0],spaceId:fixture.spaces.personal });
                assert.equal(assigned.success, true);
                const rows = await poll(() => helper.page.evaluate(readSpotlightRows), rows => logicalRows(rows).find(row => row.title === 'Logical Tab One')?.space === 'Pair Personal', 'logical membership after Spotlight worker restart');
                assert.equal(rows.find(row => row.selected)?.type, 'search-query');
                assert.equal(await input.asElement().evaluate(element => element.value), 'logical');
                const targets = await poll(readTargets, targets => targets.some(item => item.url === workerUrl && item.type === 'service_worker' && item.targetId !== old.targetId), 'distinct Spotlight worker after logical invalidation');
                const replacement = findExactWorkerTarget(targets,workerUrl); assert.notEqual(replacement.targetId,old.targetId);
                const replacementTarget = await browser.waitForTarget(item => item !== target && item.type() === 'service_worker' && item.url() === workerUrl);
                const identity = await waitForExtensionWorkerIdentity(await replacementTarget.worker(),spotlightId);
                report.logicalInvalidationRestart.push({ phase:'restarted-and-refreshed',replacement,identity,rows });
                report.logicalNativeEventCheckpoints.push({ phase:'membership-after-restart',events:await arcifyOptions.evaluate(() => globalThis.__logicalTabEvents) });
                assert.deepEqual(report.logicalNativeEventCheckpoints.at(-1).events, []);
                await screenshot(helper.page, 'logical-membership-refresh-preserves-query-and-selection');
            } finally { await session.detach(); }
            await search(helper.page, 'pair empty');
            await poll(() => helper.page.evaluate(readSpotlightRows), rows => rows.some(row => row.type === 'arcify-space' && row.title === 'Pair Empty'), 'existing empty workspace command');
            const emptyFolderId = (await snapshot()).spaces.find(space => space.id === fixture.spaces.empty).bookmarkFolderId;
            report.logicalMetadataSelection = await ui(helper.page, 'Keep web search selected during bookmark-only metadata update', () =>
                selectResultWithKeyboard(input.asElement(), () => helper.page.evaluate(readSpotlightRows), row => row.type === 'search-query' && row.title === 'Search for "pair empty"'));
            assert.equal((await helper.page.evaluate(readSpotlightRows)).find(row => row.selected)?.type, 'search-query');
            assert.equal(await input.asElement().evaluate(element => element.value), 'pair empty');
            try {
                await arcifyOptions.evaluate(id => chrome.bookmarks.update(id, { title:'Pair Empty Updated' }), emptyFolderId);
                const renamed = await poll(() => helper.page.evaluate(readSpotlightRows), rows => rows.some(row => row.type === 'arcify-space' && row.title === 'Pair Empty Updated'), 'bookmark-only workspace rename without typing');
                assert.equal(renamed.find(row => row.selected)?.type, 'search-query');
                assert.equal(await input.asElement().evaluate(element => element.value), 'pair empty');
                await screenshot(helper.page, 'bookmark-only-space-rename-refreshes-visible-command');
            } finally { await arcifyOptions.evaluate(id => chrome.bookmarks.update(id, { title:'Pair Empty' }), emptyFolderId); }
            const nativeEvents = await arcifyOptions.evaluate(() => globalThis.__logicalTabEvents);
            assert.deepEqual(nativeEvents, [], 'Logical reorder, membership and bookmark metadata checks must not be explained by native tab events.');
            const final = await snapshot();
            assert.equal(final.tabs.find(tab => tab.id === created[0]).spaceId,fixture.spaces.personal);
            assert.equal(final.tabs.find(tab => tab.id === created[1]).spaceId,fixture.spaces.work);
            return { syncTabGroups:false, tabIds:created, sourceHelperId:helper.tab.id, nativeEvents, query:'logical', manualWebSearchPreserved:true,
                initialIds,initialTitles,scores,reorderedTitles, movedTabSpace:fixture.spaces.personal, bookmarkOnlyRenameRefreshed:true,
                rejectedSignals:{ malformed:malformedSignal.error.code,wrongWindow:wrongWindowSignal.error.code } };
        } finally {
            await input.dispose();
            await arcifyOptions.evaluate(() => { for (const [name,callback] of globalThis.__logicalTabListeners || []) chrome.tabs[name].removeListener(callback); });
            await arcifyOptions.evaluate(ids => chrome.tabs.remove(ids), [...created,helper.tab.id]);
        }
    });


    await step(stepNames[22], async () => {
        const unsupportedUrl = `chrome-extension://${arcifyId}/dist/startup-launcher.html`;
        const saved = await arcifyOptions.evaluate(async ({ unsupportedUrl, base }) => {
            const unsupported = await chrome.bookmarks.create({ title:'Open Arcify sidebar',url:unsupportedUrl });
            const supported = await chrome.bookmarks.create({ title:'Open Arcify sidebar reference',url:`${base}/sidebar-reference` });
            return { unsupported:unsupported.id,supported:supported.id };
        }, { unsupportedUrl,base:fixture.base });
        const live = await arcifyOptions.evaluate(options => chrome.tabs.create(options), {
            windowId:fixture.windowA,url:`chrome-extension://${arcifyId}/options.html?paired-live-tab-identity`,active:false
        });
        await poll(() => tab(live.id), tab => tab.title === 'Arcify Settings' && tab.status === 'complete', 'live extension settings tab');
        const helper = await newTabPage('chrome://newtab/'); await waitSidebarCommand(helper.page);
        try {
            await search(helper.page,'open arcify');
            await poll(() => helper.page.evaluate(readSpotlightRows), rows => rows.some(row => row.type === 'bookmark' && row.title === 'Open Arcify sidebar reference'), 'supported ordinary bookmark beside sidebar command');
            const rows = await helper.page.evaluate(readSpotlightRows);
            assert(rows.some(row => row.type === 'arcify-sidebar-command' && row.selected));
            const suggestions = await helper.page.evaluate(() => chrome.runtime.sendMessage({ action:'getSpotlightSuggestions',query:'open arcify',mode:'new-tab' }));
            assert.equal(suggestions.success,true);
            assert(!suggestions.results.some(row => row.url === unsupportedUrl));
            assert.equal((await arcifyOptions.evaluate(id => chrome.bookmarks.get(id), saved.unsupported))[0].url,unsupportedUrl,'Filtering must preserve the saved bookmark.');
            await screenshot(helper.page,'unsupported-generic-helper-hidden-real-command-retained');
            const before = await tabsIn(fixture.windowA);
            const stale = await helper.page.evaluate(url => chrome.runtime.sendMessage({ action:'spotlightHandleResult',mode:'new-tab',result:{ type:'history',title:'Open Arcify sidebar',url } }),unsupportedUrl);
            assert.equal(stale.success,false); assert.equal(stale.errorCode,'UNSUPPORTED_URL');
            assert.deepEqual((await tabsIn(fixture.windowA)).map(({id,url}) => ({id,url})),before.map(({id,url}) => ({id,url})), 'Stale unsupported navigation must leave all tabs and URLs intact.');
            await search(helper.page,'paired-live-tab-identity');
            await poll(() => helper.page.evaluate(readSpotlightRows), rows => rows.filter(row => row.type === 'open-tab' && row.title === 'Arcify Settings').length === 1, 'unique live extension tab preserved by ID');
            const matching = await helper.page.evaluate(() => chrome.runtime.sendMessage({ action:'getLocalSuggestions',query:'paired-live-tab-identity',mode:'new-tab' }));
            assert.equal(matching.success,true);
            assert.deepEqual(matching.results.filter(row => row.type === 'open-tab' && row.title === 'Arcify Settings').map(row => row.metadata.tabId),[live.id]);
            await screenshot(helper.page,'legitimate-live-extension-tab-remains-selectable');
            await clickResult(helper.page,'Arcify Settings');
            await poll(() => tab(live.id), tab => tab.active, 'ID-based extension tab switch');
            await poll(async () => helper.page.isClosed(), value => value, 'helper closes only after legitimate tab selection');
            return { filteredUrl:unsupportedUrl,preservedBookmarkId:saved.unsupported,liveExtensionTabId:live.id,staleActionCode:stale.errorCode };
        } finally {
            await arcifyOptions.evaluate(async ({ saved,live,helper }) => {
                await chrome.bookmarks.remove(saved.unsupported); await chrome.bookmarks.remove(saved.supported);
                const tabs = await chrome.tabs.query({}); const ids = [live,helper].filter(id => tabs.some(tab => tab.id === id));
                if (ids.length) await chrome.tabs.remove(ids);
            }, { saved,live:live.id,helper:helper.tab.id });
        }
    });

    await step(stepNames[23], async () => {
        const priorTargets = new Set(browser.targets());
        const created = await arcifyOptions.evaluate(() => chrome.windows.create({ url:'chrome://newtab/',type:'normal',focused:true }));
        assert.equal(created.tabs.length,1);
        const sourceId = created.tabs[0].id;
        let helperPage;
        try {
            helperPage = await poll(async () => {
                for (const target of browser.targets()) {
                    if (priorTargets.has(target) || target.type() !== 'page' || !isSpotlightNewTabTarget(target.url(),spotlightId)) continue;
                    try {
                        const page = await target.page();
                        if ((await page.evaluate(() => chrome.tabs.getCurrent())).id === sourceId) {
                            report.tabTargets.push({chromeTabId:sourceId,requestedUrl:'chrome://newtab/',observedTargetUrl:target.url()});
                            return observePage(page);
                        }
                    } catch (error) {
                        if (!/Execution context was destroyed|Cannot find context with specified id/.test(error.message)) throw error;
                    }
                }
                return null;
            },Boolean,'exact browser-created alias renderer');
            await poll(() => tab(sourceId),tab => tab.status === 'complete' && !tab.pendingUrl,'settled browser New Tab alias');
            await waitSidebarCommand(helperPage);
            await search(helperPage,'retain alias draft');
            const input = await sidebarInput(helperPage);
            try {
                await ui(helperPage,'Manually keep alias web search selected',() => selectResultWithKeyboard(input.asElement(),() => helperPage.evaluate(readSpotlightRows),row => row.type === 'search-query' && row.title === 'Search for "retain alias draft"'));
            } finally { await input.dispose(); }
            const before = await helperPage.evaluate(readNewTabReuseState);
            const tabsBefore = await tabsIn(created.id);
            assert.deepEqual(tabsBefore.map(tab => tab.id),[sourceId]);
            // This is the production command-message entry point, not an OS keypress.
            // No bringToFront/focus call is permitted between these observations.
            const replies = await helperPage.evaluate(() => Promise.all(Array.from({length:6},() => chrome.runtime.sendMessage({command:'toggleSpotlightNewTab'}))));
            assert(replies.every(reply => reply?.success === true),JSON.stringify(replies));
            const afterCommands = await helperPage.evaluate(readNewTabReuseState);
            assertActiveNewTabReused(before,afterCommands,tabsBefore.map(tab => tab.id),(await tabsIn(created.id)).map(tab => tab.id),spotlightId);
            const paired = await external(arcifyOptions,spotlightId,'launch',{windowId:created.id,mode:'new-tab'});
            assert.equal(paired.ok,true,JSON.stringify(paired));
            const afterPaired = await helperPage.evaluate(readNewTabReuseState);
            assertActiveNewTabReused(before,afterPaired,[sourceId],(await tabsIn(created.id)).map(tab => tab.id),spotlightId);
            await screenshot(helperPage,'active-newtab-alias-reused-with-query-and-selection');

            // A separately created inactive helper is legitimate and must not be
            // closed or stolen merely to enforce a global singleton count.
            const inactive = await arcifyOptions.evaluate(options => chrome.tabs.create(options),{windowId:created.id,url:`chrome-extension://${spotlightId}/newtab.html`,active:false});
            await poll(() => tab(inactive.id),tab => tab.status === 'complete' && !tab.pendingUrl,'separate inactive helper settled');
            const beforeDuplicate = await helperPage.evaluate(readNewTabReuseState);
            const repeated = await helperPage.evaluate(() => Promise.all(Array.from({length:3},() => chrome.runtime.sendMessage({command:'toggleSpotlightNewTab'}))));
            assert(repeated.every(reply => reply?.success === true),JSON.stringify(repeated));
            const afterDuplicate = await helperPage.evaluate(readNewTabReuseState);
            assertActiveNewTabReused(beforeDuplicate,afterDuplicate,[sourceId,inactive.id],(await tabsIn(created.id)).map(tab => tab.id),spotlightId);
            const preserved = await tab(inactive.id);
            assert.equal(preserved.active,false); assert.equal(preserved.url,`chrome-extension://${spotlightId}/newtab.html`);
            return { windowId:created.id,sourceId,before,afterCommands,afterPaired,replies,
                inactiveHelperPreserved:inactive.id,afterDuplicate,commandDispatch:'production runtime command message; physical Ctrl+T and omnibox draft remain manual' };
        } finally { await arcifyOptions.evaluate(id => chrome.windows.remove(id),created.id); }
    });

    await step(stepNames[24], async () => {
        const hostTab = await arcifyOptions.evaluate(options => chrome.tabs.create(options),{ windowId:fixture.windowA,url:`${fixture.base}/keyboard-host`,active:true });
        const page = await pageForUrl(`${fixture.base}/keyboard-host`);
        const readHost = () => page.evaluate(() => ({ ready:globalThis.hostReady,keys:globalThis.hostKeys,shortcuts:globalThis.hostShortcuts }));
        const cycles = [];
        try {
            await page.waitForFunction(() => globalThis.hostReady === true);
            for (let cycle = 0; cycle < 2; cycle++) {
                await clickUI(page,'#previous');
                assert.equal(await page.evaluate(() => document.activeElement.id),'previous');
                const before = await readHost();
                const opened = await external(arcifyOptions,spotlightId,'launch',{windowId:fixture.windowA,mode:'new-tab'});
                assert.equal(opened.ok,true,JSON.stringify(opened));
                await page.waitForFunction(() => document.getElementById('arcify-spotlight-host')?.shadowRoot?.querySelector('dialog')?.open);
                const surface = await spotlightSurface(page);
                await surface.waitForFunction(() => document.querySelector('[data-testid="spotlight-input"]') === document.activeElement);
                await page.keyboard.type('window with w');
                assert.equal(await surface.$eval('[data-testid="spotlight-input"]',input => input.value),'window with w');
                await page.keyboard.down('Control');
                try { await page.keyboard.press('KeyA'); } finally { await page.keyboard.up('Control'); }
                await page.keyboard.press('Backspace');
                await page.keyboard.type('w window');
                assert.equal(await surface.$eval('[data-testid="spotlight-input"]',input => input.value),'w window');
                const typed = await readHost(); assertHostKeyboardIsolated(before,typed);
                const render = await surface.evaluate(() => {
                    const input = document.querySelector('[data-testid="spotlight-input"]');
                    const rect = input.getBoundingClientRect();
                    return { background:getComputedStyle(document.querySelector('.arcify-spotlight-container')).backgroundColor,
                        width:innerWidth,height:innerHeight,input:{x:rect.x,y:rect.y,width:rect.width,height:rect.height} };
                });
                assert.equal(render.background,'rgb(45, 45, 45)','Host CSP must not strip the isolated Spotlight styling.');
                assert(render.width > 100 && render.height > 100 && render.input.width > 0 && render.input.height > 0);
                assert(render.input.x >= 0 && render.input.y >= 0 && render.input.x + render.input.width <= render.width + 1);
                if (cycle === 0) await screenshot(page,'isolated-overlay-typing-under-strict-host-csp');
                await page.keyboard.down('Shift');
                try { await page.keyboard.press('Tab'); } finally { await page.keyboard.up('Shift'); }
                assert.equal(await surface.evaluate(() => document.activeElement.textContent),'Connection settings');
                await page.keyboard.press('Tab');
                assert.equal(await surface.$eval('[data-testid="spotlight-input"]',input => input === document.activeElement),true);
                await page.keyboard.press('Tab');
                assert.equal(await surface.evaluate(() => document.activeElement.tagName),'BUTTON');
                assertHostKeyboardIsolated(before,await readHost());
                await page.keyboard.press('Escape');
                await page.waitForFunction(() => !document.getElementById('arcify-spotlight-host')?.shadowRoot?.querySelector('dialog')?.open);
                assert.equal(await page.evaluate(() => document.activeElement.id),'previous');
                await page.keyboard.press('KeyW');
                const afterClose = await readHost(); assert(afterClose.shortcuts > before.shortcuts,'Host keyboard shortcuts must resume after Spotlight closes.');
                await page.waitForFunction(() => !document.getElementById('arcify-spotlight-host'));
                cycles.push({before,typed,afterClose,render});
            }
            return {hostTabId:hostTab.id,csp:KEYBOARD_CSP,cycles,realKeyboard:true,eventsInjected:false};
        } finally { await arcifyOptions.evaluate(id => chrome.tabs.remove(id),hostTab.id); }
    });

    await step(stepNames[25], async () => {
        const originalInvert = await arcifyOptions.$eval('#invertTabOrder',element => element.checked);
        if (originalInvert) await clickUI(arcifyOptions,'label.toggle-label[for="invertTabOrder"]');
        await poll(() => arcifyOptions.evaluate(() => chrome.storage.sync.get('invertTabOrder')),settings => settings.invertTabOrder === false,'explicit non-inverted drag fixture ordering');
        await bridge('activateSpace',{spaceId:fixture.spaces.work});
        const space = (await snapshot()).spaces.find(space => space.id === fixture.spaces.work);
        const saved = await arcifyOptions.evaluate(async ({rootId,base}) => {
            const folderA = await chrome.bookmarks.create({parentId:rootId,index:0,title:'Drop Folder A'});
            const folderB = await chrome.bookmarks.create({parentId:rootId,index:1,title:'Drop Folder B'});
            const one = await chrome.bookmarks.create({parentId:rootId,index:2,title:'Drop Link One',url:`${base}/drop-one`});
            const two = await chrome.bookmarks.create({parentId:rootId,index:3,title:'Drop Link Two',url:`${base}/drop-two`});
            return {folderA:folderA.id,folderB:folderB.id,one:one.id,two:two.id};
        },{rootId:space.bookmarkFolderId,base:fixture.base});
        const sidebar = await newTabPage(`chrome-extension://${arcifyId}/sidebar.html`);
        const page = sidebar.page;
        const row = id => `.space[data-space-id="${fixture.spaces.work}"] [data-bookmark-id="${id}"]`;
        const children = id => arcifyOptions.evaluate(async id => (await chrome.bookmarks.getChildren(id)).map(item => item.id),id);
        const observations = [];
        await page.evaluate(() => {
            window.__pairedDragEvents = [];
            for (const type of ['pointerdown','mousedown','dragstart','dragenter','dragover','dragleave','drop','dragend','mouseup']) {
                document.addEventListener(type,event => {
                    if (type === 'dragstart') {
                        window.__pairedActualDragStartCount = (window.__pairedActualDragStartCount || 0) + 1;
                        window.__pairedActualDragSource = { element: event.target,
                            trusted: event.isTrusted, rect: event.target.getBoundingClientRect().toJSON() };
                    }
                    const item = {type,at:performance.now(),tag:event.target?.tagName,classes:event.target?.className,
                        id:event.target?.closest?.('[data-bookmark-id]')?.dataset.bookmarkId,x:event.clientX,y:event.clientY,
                        prevented:event.defaultPrevented,types:[...(event.dataTransfer?.types || [])]};
                    window.__pairedDragEvents.push(item);
                    if (window.__pairedDragEvents.length > 150) window.__pairedDragEvents.shift();
                },{capture:true,passive:true});
            }
        });
        const drag = async (sourceSelector,targetSelector,placement,label) => ui(page,label,async () => {
            let source, target;
            let mouseDown = false;
            const diagnostic = {label,sourceSelector,targetSelector,placement,geometryReads:[]};
            report.dragActions ||= []; report.dragActions.push(diagnostic);
            try {
                const geometry = await locateFreshDragGeometry(page,sourceSelector,targetSelector,
                    async observation => { diagnostic.geometryReads.push(observation); });
                ({source,target} = geometry);
                const {from,to} = geometry;
                if (placement === 'before') assert(from.y > to.y,'The before-drop must move a later visual row, not assert an existing no-op.');
                diagnostic.sourceRect = from; diagnostic.targetRect = to;
                diagnostic.before = await page.evaluate(() => {
                    window.__pairedActualDragSource = null; window.__pairedActualDragStartCount = 0;
                    return {events:window.__pairedDragEvents,dragging:document.querySelector('.dragging')?.outerHTML};
                });
                const x = Math.min(from.x+40,from.x+from.width/2),y = from.y+from.height/2;
                const tx = Math.min(to.x+40,to.x+to.width/2),ty = placement === 'inside' ? to.y+to.height/2 : to.y+2;
                diagnostic.hitPoints = await page.evaluate(({x,y,tx,ty}) => ({
                    source:document.elementFromPoint(x,y)?.outerHTML,target:document.elementFromPoint(tx,ty)?.outerHTML
                }),{x,y,tx,ty});
                diagnostic.sourceConnected = await source.evaluate((element,selector) => element.isConnected && element === document.querySelector(selector),sourceSelector);
                diagnostic.targetConnected = await target.evaluate((element,selector) => element.isConnected && element === document.querySelector(selector),targetSelector);
                await page.mouse.move(x,y); await page.mouse.down(); mouseDown = true;
                await page.mouse.move(x+12,y,{steps:5});
                diagnostic.afterDragStart = await page.evaluate(selector => {
                    const actual = window.__pairedActualDragSource, element = actual?.element;
                    const badge = document.getElementById('bookmarkSelectionStatus');
                    return {startCount:window.__pairedActualDragStartCount,trusted:actual?.trusted,selectorMatches:element === document.querySelector(selector),
                        connected:element?.isConnected,rect:element?.getBoundingClientRect().toJSON(),startRect:actual?.rect,
                        badge:{visible:!badge.hidden,position:getComputedStyle(badge).position,pointerEvents:getComputedStyle(badge).pointerEvents}};
                },sourceSelector);
                diagnostic.lookupHandleStillConnected = await source.evaluate(element => element.isConnected);
                assertNativeDragSourceStable(diagnostic.afterDragStart);
                await page.mouse.move(tx,ty,{steps:20});
                await page.waitForFunction(({placement,targetSelector}) => {
                    if (placement === 'inside') return document.querySelector(targetSelector)?.classList.contains('sidebar-drop-inside');
                    const line = document.querySelector('.sidebar-drop-anchor:not([hidden])');
                    return line?.dataset.placement === placement;
                },{polling:50},{placement,targetSelector});
                const feedback = await page.evaluate(({placement,targetSelector}) => {
                    const element = placement === 'inside' ? document.querySelector(targetSelector) : document.querySelector('.sidebar-drop-anchor:not([hidden])');
                    const rect = element.getBoundingClientRect();
                    const target = document.querySelector(targetSelector).getBoundingClientRect();
                    return {placement,rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},target:{y:target.y},
                        status:document.querySelector('.sidebar-drop-status')?.textContent,
                        pointerEvents:getComputedStyle(element).pointerEvents};
                },{placement,targetSelector});
                assert(feedback.rect.width > 0 && feedback.rect.height > 0);
                if (placement === 'before') { assert(Math.abs(feedback.rect.y+1-feedback.target.y) <= 1); assert.equal(feedback.pointerEvents,'none'); }
                await screenshot(page,label);
                await page.mouse.up(); mouseDown = false;
                await page.waitForFunction(() => !document.querySelector('.sidebar-drop-anchor:not([hidden]),.sidebar-drop-inside,.dragging'),{polling:50});
                observations.push(feedback);
            } catch (error) {
                diagnostic.error = error.message;
                try {
                    diagnostic.failedState = await page.evaluate(({sourceSelector,targetSelector}) => ({
                        events:window.__pairedDragEvents,source:document.querySelector(sourceSelector)?.outerHTML,
                        target:document.querySelector(targetSelector)?.outerHTML,dragging:document.querySelector('.dragging')?.outerHTML,
                        indicator:document.querySelector('.sidebar-drop-anchor')?.outerHTML,status:document.querySelector('.sidebar-drop-status')?.textContent,
                        focused:document.hasFocus(),visibility:document.visibilityState,scroll:[...document.querySelectorAll('.space-content')].map(element => ({
                            active:element.closest('.space')?.classList.contains('active'),rect:element.getBoundingClientRect().toJSON(),
                            top:element.scrollTop,height:element.scrollHeight,client:element.clientHeight
                        }))
                    }),{sourceSelector,targetSelector});
                    diagnostic.sourceStillConnected = await source?.evaluate((element,selector) => element.isConnected && element === document.querySelector(selector),sourceSelector);
                    diagnostic.targetStillConnected = await target?.evaluate((element,selector) => element.isConnected && element === document.querySelector(selector),targetSelector);
                    await screenshot(page,`${label}-failure-before-cleanup`,false);
                } catch (captureError) { diagnostic.captureError = captureError.message; }
                try { await saveReport(); } catch (saveError) { diagnostic.saveError = saveError.message; }
                throw error;
            } finally {
                if (mouseDown) { await page.keyboard.press('Escape').catch(() => {}); await page.mouse.up().catch(() => {}); }
                await source?.dispose(); await target?.dispose();
            }
        });
        try {
            await page.waitForFunction(spaceId => document.querySelector(`.space[data-space-id="${spaceId}"]`)?.classList.contains('active'),{polling:50},fixture.spaces.work);
            for (const id of Object.values(saved)) await page.waitForSelector(row(id));
            const assertRenderedPlacement = async (sourceId,targetId,placement) => {
                await page.waitForFunction(({spaceId,sourceId,targetId,placement}) => {
                    const root = document.querySelector(`.space[data-space-id="${spaceId}"]`);
                    const source = root?.querySelector(`[data-bookmark-id="${sourceId}"]`);
                    const target = root?.querySelector(`[data-bookmark-id="${targetId}"]`);
                    if (!source || !target) return false;
                    if (placement === 'inside') return source.parentElement?.closest('.folder[data-bookmark-id]') === target;
                    if (source.parentElement !== target.parentElement || source.parentElement.closest('.folder[data-bookmark-id]')) return false;
                    const siblings = [...source.parentElement.children].filter(item => item.dataset.bookmarkId);
                    return siblings.indexOf(source) >= 0 && siblings.indexOf(source)+1 === siblings.indexOf(target);
                },{polling:50},{spaceId:fixture.spaces.work,sourceId,targetId,placement});
            };
            const assertRootParents = async ids => {
                const items = await arcifyOptions.evaluate(ids => chrome.bookmarks.get(ids),ids);
                assert.equal(items.length,ids.length);
                for (const id of ids) assert.equal(items.find(item => item.id === id)?.parentId,space.bookmarkFolderId,'Before-drop rows must retain their root parent.');
            };
            await drag(row(saved.two),row(saved.one),'before','sidebar-tab-drop-anchor-before-target');
            await poll(() => children(space.bookmarkFolderId),ids => ids.indexOf(saved.two) >= 0 && ids.indexOf(saved.one) >= 0 && ids.indexOf(saved.two)+1 === ids.indexOf(saved.one),'saved bookmark tab insertion at anchor');
            await assertRootParents([saved.two,saved.one]);
            await assertRenderedPlacement(saved.two,saved.one,'before');
            await drag(`${row(saved.folderB)} > .folder-header`,`${row(saved.folderA)} > .folder-header`,'before','sidebar-folder-drop-anchor-before-target');
            await poll(() => children(space.bookmarkFolderId),ids => ids.indexOf(saved.folderB) >= 0 && ids.indexOf(saved.folderA) >= 0 && ids.indexOf(saved.folderB)+1 === ids.indexOf(saved.folderA),'saved whole-folder insertion at anchor');
            await assertRootParents([saved.folderB,saved.folderA]);
            await assertRenderedPlacement(saved.folderB,saved.folderA,'before');
            await drag(row(saved.one),`${row(saved.folderA)} > .folder-header`,'inside','sidebar-tab-drop-inside-folder-highlight');
            await poll(() => children(saved.folderA),ids => ids.includes(saved.one),'saved tab inside highlighted folder');
            await assertRenderedPlacement(saved.one,saved.folderA,'inside');
            await drag(`${row(saved.folderB)} > .folder-header`,`${row(saved.folderA)} > .folder-header`,'inside','sidebar-folder-drop-inside-folder-highlight');
            await poll(() => children(saved.folderA),ids => ids.includes(saved.folderB),'saved folder inside highlighted parent');
            await assertRenderedPlacement(saved.folderB,saved.folderA,'inside');
            const final = await arcifyOptions.evaluate(ids => chrome.bookmarks.get(ids),Object.values(saved));
            assert.equal(final.length,4,'Every original bookmark identity must remain.');
            assert.equal(final.find(item => item.id === saved.one).parentId,saved.folderA);
            assert.equal(final.find(item => item.id === saved.folderB).parentId,saved.folderA);
            for (const id of [saved.folderA,saved.two]) assert.equal(final.find(item => item.id === id).parentId,space.bookmarkFolderId);
            return {sidebarTabId:sidebar.tab.id,saved,observations,final,invertTabOrder:false,realMouseDrag:true,nativePanel:false};
        } finally {
            await arcifyOptions.evaluate(async ({ids,tabId}) => {
                await chrome.tabs.remove(tabId);
                for (const id of ids) {
                    let item; try { [item] = await chrome.bookmarks.get(id); } catch { continue; }
                    if (item.url) await chrome.bookmarks.remove(id); else await chrome.bookmarks.removeTree(id);
                }
            },{ids:Object.values(saved),tabId:sidebar.tab.id});
            if (originalInvert) {
                await clickUI(arcifyOptions,'label.toggle-label[for="invertTabOrder"]');
                await poll(() => arcifyOptions.evaluate(() => chrome.storage.sync.get('invertTabOrder')),settings => settings.invertTabOrder === true,'restore original sidebar ordering');
            }
        }
    });

    await step(stepNames[26], async () => {
        await bridge('activateSpace',{spaceId:fixture.spaces.work});
        const space = (await snapshot()).spaces.find(space => space.id === fixture.spaces.work);
        assert.equal((await tabsIn(fixture.windowA)).filter(tab => tab.pinned).length,0,'This fixture must exercise the empty Favorites destination first.');
        const saved = await arcifyOptions.evaluate(async ({rootId,base}) => {
            const one = await chrome.bookmarks.create({parentId:rootId,index:0,title:'Favorite Drop One',url:`${base}/native-favorite`});
            const two = await chrome.bookmarks.create({parentId:rootId,index:1,title:'Favorite Drop Equal URL',url:`${base}/native-favorite`});
            const folder = await chrome.bookmarks.create({parentId:rootId,index:2,title:'Favorites remain an ordinary folder'});
            return {one:one.id,two:two.id,folder:folder.id};
        },{rootId:space.bookmarkFolderId,base:fixture.base});
        const sidebar = await newTabPage(`chrome-extension://${arcifyId}/sidebar.html`);
        const page = sidebar.page;
        const row = id => `.space[data-space-id="${fixture.spaces.work}"] [data-bookmark-id="${id}"]`;
        const read = async () => {
            const state = await snapshot();
            const data = await arcifyOptions.evaluate(async ({windowId,ids}) => ({
                tabs:await chrome.tabs.query({windowId}),
                bookmarks:(await chrome.bookmarks.get(ids)).map(({id,parentId,index,title,url}) => ({id,parentId,index,title,url})),
                bindings:(await chrome.storage.local.get('pinnedTabStatesById')).pinnedTabStatesById || {}
            }),{windowId:fixture.windowA,ids:Object.values(saved)});
            return {...data,favorites:state.favorites,windowId:fixture.windowA,activeSpaceId:state.activeSpaceId,
                spaces:state.spaces.map(({id,tabIds,pinnedTabIds,temporaryTabIds}) => ({id,tabIds,pinnedTabIds,temporaryTabIds}))};
        };
        const createdIds = [];
        const observations = [];
        const dragToFavorites = async (sourceSelector,label,allowed) => ui(page,label,async () => {
            await page.waitForSelector(sourceSelector);
            const source = await page.$(sourceSelector),target = await page.$('#pinnedFavicons');
            assert(source && target);
            let mouseDown = false;
            const operationBefore = await page.$eval('#pinnedFavicons',element => Number(element.dataset.dropOperation || 0));
            try {
                await source.scrollIntoView();
                const from = await source.boundingBox(),to = await target.boundingBox();
                assert(from && to && from.width > 0 && from.height > 0 && to.width > 0 && to.height > 0);
                const x = from.x+Math.min(40,from.width/2),y = from.y+from.height/2;
                const tx = to.x+Math.min(35,to.width/2),ty = to.y+to.height/2;
                await page.mouse.move(x,y); await page.mouse.down(); mouseDown = true;
                await page.mouse.move(x+12,y,{steps:5}); await page.mouse.move(tx,ty,{steps:20});
                await page.waitForFunction(({allowed}) => {
                    const status = document.getElementById('favoritesDropStatus');
                    const text = status?.textContent || '';
                    return allowed ? /pinned tab|already.*favorite|reorder|favorite/i.test(text) && document.getElementById('pinnedFavicons').classList.contains('drag-over')
                        : /folder|individual|one bookmark/i.test(text) && !document.getElementById('pinnedFavicons').classList.contains('drag-over');
                },{polling:50},{allowed});
                const hover = await page.evaluate(() => ({status:document.getElementById('favoritesDropStatus')?.textContent,
                    highlighted:document.getElementById('pinnedFavicons').classList.contains('drag-over'),
                    source:document.querySelector('.dragging')?.dataset.bookmarkId}));
                assert.equal(hover.highlighted,allowed);
                await screenshot(page,label);
                await page.mouse.up(); mouseDown = false;
                await page.waitForFunction(() => !document.querySelector('.dragging'),{polling:50});
                if (allowed) await page.waitForFunction(previous => {
                    const strip = document.getElementById('pinnedFavicons');
                    return Number(strip.dataset.dropOperation) === previous+1 && strip.dataset.dropState === 'success' && strip.getAttribute('aria-busy') === 'false';
                },{polling:50},operationBefore);
                else assert.equal(await page.$eval('#pinnedFavicons',element => Number(element.dataset.dropOperation || 0)),operationBefore);
                const completed = await page.evaluate(() => ({status:document.getElementById('favoritesDropStatus')?.textContent,
                    operation:document.getElementById('pinnedFavicons').dataset.dropOperation,state:document.getElementById('pinnedFavicons').dataset.dropState}));
                observations.push({label,hover,completed,sourceRect:from,targetRect:to});
            } finally {
                if (mouseDown) { await page.keyboard.press('Escape').catch(() => {}); await page.mouse.up().catch(() => {}); }
                await source.dispose(); await target.dispose();
            }
        });
        try {
            await page.waitForFunction(spaceId => document.querySelector(`.space[data-space-id="${spaceId}"]`)?.classList.contains('active'),{polling:50},fixture.spaces.work);
            for (const id of Object.values(saved)) await page.waitForSelector(row(id));
            const before = await read();
            assert.equal(before.tabs.find(tab => tab.active)?.id,sidebar.tab.id);
            await dragToFavorites(row(saved.one),'closed-bookmark-drop-empty-native-favorites',true);
            await poll(read,state => state.favorites.some(favorite => favorite.sourceBookmarkId === saved.one && state.tabs.some(tab => tab.id === favorite.tabId && tab.pinned && tab.status === 'complete')),'first exact saved bookmark becomes a native pinned tab');
            const first = await read();
            const favorite = assertSavedBookmarkFavorite(before,first,{bookmarkId:saved.one,newTab:true}); createdIds.push(favorite.id);
            await page.waitForSelector(`#pinnedFavicons [data-tab-id="${favorite.id}"]`);
            await page.waitForSelector(`${row(saved.one)}.bookmark-only`);
            await dragToFavorites(row(saved.one),'repeat-bookmark-drop-reuses-exact-native-favorite',true);
            const repeated = await read();
            assertSavedBookmarkFavorite(first,repeated,{bookmarkId:saved.one,newTab:false,expectedTabId:favorite.id});
            await dragToFavorites(row(saved.two),'equal-url-bookmark-drop-keeps-distinct-native-identity',true);
            await poll(read,state => state.favorites.some(favorite => favorite.sourceBookmarkId === saved.two && state.tabs.some(tab => tab.id === favorite.tabId && tab.pinned && tab.status === 'complete')),'equal-URL saved identity receives its own native pin');
            const second = await read();
            const other = assertSavedBookmarkFavorite(repeated,second,{bookmarkId:saved.two,newTab:true}); createdIds.push(other.id);
            assert.notEqual(other.id,favorite.id);
            await page.waitForSelector(`#pinnedFavicons [data-tab-id="${other.id}"]`);
            await dragToFavorites(`${row(saved.folder)} > .folder-header`,'favorites-folder-drop-rejected-with-explanation',false);
            const rejected = await read(); assert.deepEqual(rejected,second,'A folder drag must not expand, open, move, or remove anything.');
            await screenshot(page,'native-favorites-and-preserved-saved-bookmarks');
            return {sidebarTabId:sidebar.tab.id,saved,observations,before,first,repeated,second,rejected,
                nativePinnedTabIds:createdIds,syncTabGroups:await arcifyOptions.evaluate(async () => (await chrome.storage.sync.get('syncTabGroups')).syncTabGroups),realMouseDrag:true,nativePanel:false,sourceBookmarksPreserved:true};
        } finally {
            await page.evaluate(async ({ids,windowId}) => {
                const state = await chrome.runtime.sendMessage({type:'favoriteStore',action:'get',windowId});
                if (!state.success) throw new Error(state.error?.message || state.error);
                for (const favorite of state.favorites.filter(item => ids.includes(item.sourceBookmarkId))) {
                    const removed = await chrome.runtime.sendMessage({type:'favoriteStore',action:'remove',windowId,favoriteId:favorite.id});
                    if (!removed.success) throw new Error(removed.error?.message || removed.error);
                }
            },{ids:Object.values(saved),windowId:fixture.windowA});
            await arcifyOptions.evaluate(async ({ids,tabIds,sidebarId}) => {
                const live = await chrome.tabs.query({});
                for (const id of [...tabIds,sidebarId]) if (live.some(tab => tab.id === id)) await chrome.tabs.remove(id);
                for (const id of ids) {
                    const [node] = await chrome.bookmarks.get(id);
                    if (node.url) await chrome.bookmarks.remove(id); else await chrome.bookmarks.removeTree(id);
                }
            },{ids:Object.values(saved),tabIds:createdIds,sidebarId:sidebar.tab.id});
        }
    });

    await step(stepNames[27], async () => {
        const beforeA = await snapshot(),beforeB = await snapshot(fixture.windowB);
        const originalOrder = beforeA.spaces.map(space => space.id);
        const readBookmarkFolders = () => arcifyOptions.evaluate(async folderId => {
            const [folder] = await chrome.bookmarks.get(folderId);
            return (await chrome.bookmarks.getChildren(folder.parentId)).filter(node => !node.url)
                .map(({id,parentId,index}) => ({id,parentId,index}));
        },beforeA.spaces[0].bookmarkFolderId);
        const originalBookmarkFolders = await readBookmarkFolders();
        assert(originalOrder.length >= 3,'Space-order fixture needs at least three stable identities.');
        const movedId = originalOrder.at(-1),anchorId = originalOrder[0];
        const expected = [movedId,...originalOrder.slice(0,-1)];
        const sidebar = await newTabPage(`chrome-extension://${arcifyId}/sidebar.html`);
        const page = sidebar.page;
        const chip = id => `#spaceSwitcher button[data-space-id="${id}"]`;
        const renderedOrder = () => page.$$eval('#spaceSwitcher button[data-space-id]',buttons => buttons.map(button => button.dataset.spaceId));
        const membership = state => state.spaces.map(({id,tabIds,pinnedTabIds,temporaryTabIds}) => ({id,tabIds,pinnedTabIds,temporaryTabIds})).sort((a,b) => a.id.localeCompare(b.id));
        const assertState = async order => {
            const a = await snapshot(),b = await snapshot(fixture.windowB);
            assert.deepEqual(a.spaces.map(space => space.id),order);
            assert.deepEqual(b.spaces.map(space => space.id),order,'Space ordering is globally shared, not per-window copied state.');
            assert.equal(a.activeSpaceId,beforeA.activeSpaceId); assert.equal(b.activeSpaceId,beforeB.activeSpaceId);
            assert.deepEqual(membership(a),membership(beforeA)); assert.deepEqual(membership(b),membership(beforeB));
            assert.deepEqual(await readBookmarkFolders(),originalBookmarkFolders,'Space UI ordering must not move the imported bookmark folders.');
            await poll(renderedOrder,ids => JSON.stringify(ids) === JSON.stringify(order),'matching rendered Space chips');
            return {a,b};
        };
        try {
            await page.waitForSelector(chip(movedId)); await page.waitForSelector(chip(anchorId));
            await page.evaluate(installSpaceDragObservation);
            report.spaceDragObservation = { sourceSpaceId:movedId, anchorSpaceId:anchorId, actions:[] };
            const markerEvidence = [];
            const dragSpace = async (sourceId,targetId,placement,label) => ui(page,label,async () => {
                const source = await page.$(chip(sourceId)),target = await page.$(chip(targetId));
                let mouseDown = false;
                try {
                    await source.scrollIntoView();
                    const from = await source.boundingBox(),to = await target.boundingBox();
                    assert(from && to && from.width > 0 && to.width > 0);
                    const x = from.x+from.width/2,y = from.y+from.height/2;
                    const tx = placement === 'before' ? to.x+2 : to.x+to.width-2,ty = to.y+to.height/2;
                    await page.mouse.move(x,y); await page.mouse.down(); mouseDown = true;
                    await page.mouse.move(x,y-12,{steps:5}); await page.mouse.move(tx,ty,{steps:20});
                    const beforeSettle = await page.evaluate(readSpaceDragObservation);
                    const finalTarget = {sourceSpaceId:sourceId,anchorSpaceId:targetId,placement,
                        x:tx+(placement === 'before' ? 1 : -1),y:ty,after:beforeSettle.events.at(-1)?.at ?? -1};
                    // One real final motion within the button, before the first
                    // release. No input replay, arbitrary delay, or synthetic drop.
                    await page.mouse.move(finalTarget.x,finalTarget.y,{steps:2});
                    const accepted = await poll(() => page.evaluate(readSpaceDragObservation),state => {
                        try { assertAcceptedSpaceDragover(state,finalTarget); return true; } catch { return false; }
                    },'fresh accepted native dragover on the exact final Space button');
                    await page.waitForFunction(({targetId,placement}) => {
                        const marker = document.querySelector('.space-drop-anchor');
                        return marker && !marker.hidden && marker.dataset.anchorSpaceId === targetId && marker.dataset.placement === placement;
                    },{polling:50},{targetId,placement});
                    const marker = assertSpaceDropMarker(await page.evaluate(readSpaceDropMarker),
                        {sourceSpaceId:sourceId,anchorSpaceId:targetId,placement});
                    const captured = await screenshot(page,label,true,{fullPage:false});
                    const pixels = await page.evaluate(readMarkerScreenshotPixels,
                        {base64:(await readFile(resolve(OUTPUT,captured.filename))).toString('base64'),marker});
                    const paint = assertMarkerScreenshotPixels(pixels,marker);
                    const afterCapture = assertSpaceDropMarker(await page.evaluate(readSpaceDropMarker),
                        {sourceSpaceId:sourceId,anchorSpaceId:targetId,placement});
                    assert.deepEqual(afterCapture.rect,marker.rect,'Capture must not shift the drop destination.');
                    assertAcceptedSpaceDragover(await page.evaluate(readSpaceDragObservation),finalTarget);
                    const hover = {marker,paint,screenshot:captured.filename,afterCapture,
                        acceptedFinalTarget:assertAcceptedSpaceDragover(accepted,finalTarget)};
                    markerEvidence.push(hover);
                    await page.mouse.up(); mouseDown = false;
                    await recordSpaceDragObservation({report,label,read:()=>page.evaluate(readSpaceDragObservation),save:saveReport});
                    await page.waitForFunction(() => document.querySelector('.space-drop-anchor')?.hidden === true,{polling:50});
                    return hover;
                } finally {
                    if (mouseDown) { await page.keyboard.press('Escape').catch(() => {}); await page.mouse.up().catch(() => {}); }
                    await source.dispose(); await target.dispose();
                }
            });
            const hover = await dragSpace(movedId,anchorId,'before','space-reorder-before-drop-feedback');
            await poll(() => snapshot(),state => JSON.stringify(state.spaces.map(space => space.id)) === JSON.stringify(expected),'persisted ID-relative Space drag');
            const reordered = await assertState(expected);
            await page.reload({waitUntil:'domcontentloaded'});
            await page.waitForSelector(chip(movedId));
            const reloaded = await assertState(expected);
            await page.evaluate(installSpaceDragObservation);
            await screenshot(page,'space-order-persists-after-sidebar-reload');
            for (let i = 1; i < originalOrder.length; i++) {
                const next = [...originalOrder.slice(0,i),movedId,...originalOrder.slice(i,-1)];
                await ui(page,'Move focused Space right with Alt+Shift+ArrowRight',async () => {
                    const element = await page.$(chip(movedId)); assert(element); await element.focus(); await element.dispose();
                    await page.keyboard.down('Alt'); await page.keyboard.down('Shift');
                    try { await page.keyboard.press('ArrowRight'); }
                    finally { await page.keyboard.up('Shift'); await page.keyboard.up('Alt'); }
                });
                await poll(() => snapshot(),state => JSON.stringify(state.spaces.map(space => space.id)) === JSON.stringify(next),'one-neighbor keyboard Space move');
                await assertState(next);
            }
            const restored = await assertState(originalOrder);
            const afterMovedId = originalOrder[0],afterAnchorId = originalOrder.at(-1);
            const afterOrder = [...originalOrder.slice(1),afterMovedId];
            const afterHover = await dragSpace(afterMovedId,afterAnchorId,'after','space-reorder-after-drop-feedback');
            await poll(() => snapshot(),state => JSON.stringify(state.spaces.map(space => space.id)) === JSON.stringify(afterOrder),'persisted after-boundary Space drag');
            const afterReordered = await assertState(afterOrder);
            for (let i = originalOrder.length-1; i > 0; i--) {
                const next = [...originalOrder.slice(1,i),afterMovedId,...originalOrder.slice(i)];
                await ui(page,'Restore focused Space left with Alt+Shift+ArrowLeft',async () => {
                    const element = await page.$(chip(afterMovedId)); assert(element); await element.focus(); await element.dispose();
                    await page.keyboard.down('Alt'); await page.keyboard.down('Shift');
                    try { await page.keyboard.press('ArrowLeft'); }
                    finally { await page.keyboard.up('Shift'); await page.keyboard.up('Alt'); }
                });
                await poll(() => snapshot(),state => JSON.stringify(state.spaces.map(space => space.id)) === JSON.stringify(next),'one-neighbor left keyboard Space move');
                await assertState(next);
            }
            await assertState(originalOrder);
            return {sidebarTabId:sidebar.tab.id,originalOrder,reorderedOrder:expected,hover,reordered,reloaded,restored,
                markerEvidence,afterHover,afterReordered,
                originalBookmarkFolders,finalBookmarkFolders:await readBookmarkFolders(),realMouseDrag:true,realKeyboard:true,bookmarkFoldersMoved:false,nativePanel:false};
        } catch (error) {
            await recordSpaceDragObservation({report,failure:true,read:()=>page.evaluate(readSpaceDragObservation),save:saveReport});
            throw error;
        } finally { await arcifyOptions.evaluate(id => chrome.tabs.remove(id),sidebar.tab.id); }
    });

    await step(stepNames[28], async () => {
        persistentFixture = await exercisePersistentFavorites({apiPage:arcifyOptions,newTabPage,pageForUrl,ui,screenshot,snapshot,poll,fixture,arcifyId,
            record:async observation => { report.persistentFavoriteMenus ||= []; report.persistentFavoriteMenus.push(observation); await saveReport(); } });
        return persistentFixture;
    });
    await step(stepNames[29], () => exerciseFavoriteSearch({apiPage:arcifyOptions,newTabPage,ui,screenshot,snapshot,poll,fixture,spotlightId,persistentFixture,search,sidebarInput,restartWorker:restartFavoriteWorker,
        record:async observation => { report.favoriteSearchObservations ||= []; report.favoriteSearchObservations.push(observation); await saveReport(); }}));

    await step(stepNames[30], () => exerciseSavedFavoriteMarker({apiPage:arcifyOptions,newTabPage,ui,screenshot,
        screenshotBytes:captured => readFile(resolve(OUTPUT,captured.filename)),snapshot,poll,fixture,arcifyId,
        record:async observation => { report.favoriteMarkerObservations ||= []; report.favoriteMarkerObservations.push(observation); await saveReport(); }}));

    await step(stepNames[31], () => exerciseBookmarkMultiSelection({ apiPage:arcifyOptions,newTabPage,ui,screenshot,
        screenshotBytes:captured => readFile(resolve(OUTPUT,captured.filename)),snapshot,poll,fixture,arcifyId,
        record:async observation => { report.bookmarkMultiSelection ||= []; report.bookmarkMultiSelection.push(observation); await saveReport(); } }));

    } // Full-only cases 3–31.

    // One shared definition: case 33 owns its fixtures and persists the default
    // appearance needed by case 46, including on a fresh supplemental profile.
    if (report.runMode === 'full' || report.runMode === 'appearance-actions') {
    await step(stepNames[33], () => exerciseSidebarAppearance({ apiPage:arcifyOptions,newTabPage,ui,screenshot,
        screenshotBytes:captured => readFile(resolve(OUTPUT,captured.filename)),snapshot,poll,fixture,arcifyId,
        record:async observation => { report.sidebarAppearance ||= []; report.sidebarAppearance.push(observation); await saveReport(); } }));

    } // Shared appearance prerequisite: case 33.

    if (report.runMode === 'full') {
    await step(stepNames[34], () => exerciseManagementScroll({ apiPage:arcifyOptions,ui,screenshot,snapshot,poll,fixture,
        record:async observation => { report.managementScroll ||= []; report.managementScroll.push(observation); await saveReport(); },
        nativeSidebar:async () => {
            // Options reload in the appearance case intentionally replaces the old
            // observation document. Register fresh passive native-host evidence.
            await arcifyOptions.evaluate(() => {
                globalThis.__pairedSidebarEvents = [];
                chrome.sidePanel.onOpened.addListener(info => globalThis.__pairedSidebarEvents.push({ type:'opened', ...info }));
                chrome.sidePanel.onClosed.addListener(info => globalThis.__pairedSidebarEvents.push({ type:'closed', ...info }));
            });
            const helper = await newTabPage('chrome://newtab/');
            try {
                await waitSidebarCommand(helper.page);
                await search(helper.page, 'Open Arcify sidebar');
                await helper.page.waitForSelector(`${sidebarSelector}.selected`);
                const eventCount = (await nativePanelState()).events.length;
                await sidebarEnter(helper.page, 'Open native panel for genuine management scroll regression');
                await waitSidebarSuccess(helper.page);
                const evidence = await captureNativeSidebar(eventCount, 'native-panel-management-scroll-host-proof');
                const target = await browser.waitForTarget(target => target.url() === `chrome-extension://${arcifyId}/sidebar.html`);
                return { page:await observePage(await target.asPage()), evidence,
                    close:async () => { await closeNativeSidebar(); await arcifyOptions.evaluate(id => chrome.tabs.remove(id), helper.tab.id); } };
            } catch (error) {
                if ((await nativePanelState()).contexts.length) await closeNativeSidebar().catch(cleanup => { error.cleanupError = cleanup.message; });
                await arcifyOptions.evaluate(id => chrome.tabs.remove(id), helper.tab.id).catch(cleanup => { error.cleanupError = cleanup.message; });
                throw error;
            }
        } }));

    await step(stepNames[35], () => exerciseTodaySelection({ apiPage:arcifyOptions,newTabPage,ui,screenshot,
        snapshot,poll,fixture,arcifyId,spotlightId,search,
        record:async observation => { report.todaySelection ||= []; report.todaySelection.push(observation); await saveReport(); } }));

    // Menu fixtures own disposable data and finish before ordinary-Favorite
    // restart receipts are captured or a full restart changes window identities.
    await step(stepNames[37], () => exerciseSpaceContextBasics({ apiPage:arcifyOptions,newTabPage,pageForUrl,ui,screenshot,
        snapshot,poll,fixture,arcifyId,screenshotBytes:shot=>readFile(resolve(OUTPUT,shot.filename)),
        record:async observation => { report.spaceContextMenus ||= []; report.spaceContextMenus.push(observation); await saveReport(); } }));

    await step(stepNames[38], async () => {
        await exerciseTabMenuActions({ apiPage:arcifyOptions,newTabPage,pageForUrl,ui,screenshot,
            snapshot,poll,fixture,arcifyId,spotlightId,search,
            record:async observation => { report.tabMenus = observation; await saveReport(); } });
        return exerciseMoveToNewWindow({apiPage:arcifyOptions,newTabPage,pageForUrl,nativeSidebar:nativeMoveWindowSidebar,
            ui,screenshot,snapshot,poll,fixture,
            record:async observation=>{report.moveWindow=observation;await saveReport();}});
    });
    await step(stepNames[40], () => exerciseTodayMove({ apiPage:arcifyOptions,nativeSidebar:nativeTodayMoveSidebar,newTabPage,pageForUrl,ui,screenshot,
        snapshot,poll,fixture,arcifyId,spotlightId,search,groupSync:false,reloadArcify:()=>reloadPairedExtension('arcify'),
        record:async observation => { report.todayMoveSyncOff = observation; await saveReport(); } }));
    await step(stepNames[41], () => exerciseTodayMove({ apiPage:arcifyOptions,nativeSidebar:nativeTodayMoveSidebar,newTabPage,pageForUrl,ui,screenshot,
        snapshot,poll,fixture,arcifyId,spotlightId,search,groupSync:true,reloadArcify:()=>reloadPairedExtension('arcify'),
        record:async observation => { report.todayMoveSyncOn = observation; await saveReport(); } }));
    await step(stepNames[42], () => exerciseTodayCreationOrder({ apiPage:arcifyOptions,nativeSidebar:nativeTodayMoveSidebar,pageForUrl,ui,screenshot,
        snapshot,bridge,poll,fixture,arcifyId,spotlightId,peerPage:spotlightOptions,groupSync:false,reloadArcify:()=>reloadPairedExtension('arcify'),
        record:async observation => { report.todayOrderSyncOff = observation; await saveReport(); } }));
    await step(stepNames[43], () => exerciseTodayCreationOrder({ apiPage:arcifyOptions,nativeSidebar:nativeTodayMoveSidebar,pageForUrl,ui,screenshot,
        snapshot,bridge,poll,fixture,arcifyId,spotlightId,peerPage:spotlightOptions,groupSync:true,reloadArcify:()=>reloadPairedExtension('arcify'),
        record:async observation => { report.todayOrderSyncOn = observation; await saveReport(); } }));
    await step(stepNames[44], () => exerciseSavedMove({ apiPage:arcifyOptions,nativeSidebar:nativeTodayMoveSidebar,newTabPage,openSavedPage:openSavedMovePage,pageForUrl,ui,screenshot,
        snapshot,bridge,poll,fixture,arcifyId,spotlightId,search,groupSync:false,reloadArcify:()=>reloadPairedExtension('arcify'),
        record:async observation => { report.savedMoveSyncOff = observation; await saveReport(); } }));
    await step(stepNames[45], () => exerciseSavedMove({ apiPage:arcifyOptions,nativeSidebar:nativeTodayMoveSidebar,newTabPage,openSavedPage:openSavedMovePage,pageForUrl,ui,screenshot,
        snapshot,bridge,poll,fixture,arcifyId,spotlightId,search,groupSync:true,reloadArcify:()=>reloadPairedExtension('arcify'),
        record:async observation => { report.savedMoveSyncOn = observation; await saveReport(); } }));
    } // Full-only cases 34–35, 37–38 and 40–45.

    if (report.runMode === 'full' || report.runMode === 'appearance-actions') {
    await step(stepNames[46], () => exerciseSpaceTheme({ apiPage:arcifyOptions,nativeSidebar:nativeTodayMoveSidebar,newTabPage,ui,screenshot,
        screenshotBytes:captured => readFile(resolve(OUTPUT,captured.filename)),snapshot,poll,fixture,arcifyId,
        record:async evidence => { report.spaceTheme = evidence; await saveReport(); } }));
    await step(stepNames[47], async () => {
        // Imported only after the runner has verified the exact reviewed peer HEAD.
        // Missing collector or missing evidence fails this mandatory case.
        const { collectOptionsAppearanceEvidence } = await import(pathToFileURL(resolve(COMPANION, 'test/e2e/options-appearance-evidence.js')).href);
        const evidence = await exerciseSpotlightOptionsAppearance({ browser,collectOptionsAppearanceEvidence,observePage,apiPage:arcifyOptions,peerPage:spotlightOptions,
            extensionId:spotlightId,outputDir:resolve(OUTPUT,'spotlight-options-appearance'),poll,
            record:async evidence => { report.spotlightOptionsAppearance = evidence; await saveReport(); } });
        for (const shot of evidence.screenshots) report.screenshots.push({ ...shot, filename:`spotlight-options-appearance/${shot.filename}`,
            label:'Required Spotlight options appearance', capturedAt:new Date().toISOString() });
        await saveReport(); return evidence;
    });
    } // Shared appearance cases 46–47; preserve the original full order.

    if (report.runMode === 'full' || report.runMode === 'appearance-actions' || report.runMode === 'recovery-actions') {
    await prepareRecoverySidebarObservation();
    await step(stepNames[48], () => runHostedOverlayRecovery());
    await step(stepNames[49], () => exerciseSpotlightActions({ apiPage:arcifyOptions,spotlightOptions,newTabPage,openSavedPage:openSavedMovePage,pageForUrl,
        ui,screenshot,snapshot,bridge,external,poll,fixture,arcifyId,spotlightId,search,
        helperNavigation:true,
        record:async evidence => { report.spotlightActions = evidence; await saveReport(); } }));
    } // Shared recovery/actions cases 48–49; preserve the original full order.

    // These isolated modules own their fixtures, selected Spaces and settings.
    // They cannot replace or extend the evidence scope of any existing run mode.
    if (report.runMode === 'extended-actions') {
    await step(stepNames[50], () => exerciseSpotlightNavigation({ browser,observePage,apiPage:arcifyOptions,spotlightOptions,newTabPage,openSavedPage:openSavedMovePage,pageForUrl,
        ui,screenshot,snapshot,bridge,external,poll,fixture,arcifyId,spotlightId,search,
        record:async evidence => { report.spotlightNavigation = evidence; await saveReport(); } }));
    await step(stepNames[51], () => exerciseSpotlightTabCommands({ browser,observePage,apiPage:arcifyOptions,spotlightOptions,newTabPage,openSavedPage:openSavedMovePage,
        ui,screenshot,snapshot,bridge,external,poll,fixture,arcifyId,spotlightId,search,
        record:async evidence => { report.spotlightTabCommands = evidence; await saveReport(); } }));
    } // Supplemental extended-action cases 50–51; legacy plans remain unchanged.

    if (report.runMode === 'archive-actions') {
    await step(stepNames[52], () => exerciseSpotlightArchiveOpen({ browser,observePage,apiPage:arcifyOptions,spotlightOptions,newTabPage,openSavedPage:openSavedMovePage,
        ui,screenshot,snapshot,external,poll,fixture,arcifyId,spotlightId,search,
        nativePanel:{ prepare:prepareRecoverySidebarObservation, state:nativePanelState, capture:captureNativeSidebar, resolve:resolveNativeSidebarTarget, close:closeNativeSidebar },
        record:async evidence => { report.spotlightArchiveOpen = evidence; await saveReport(); } }));
    } // Native Archive opening remains mandatory in archive-actions.
    if (report.runMode === 'archive-actions' || report.runMode === 'archive-reopen') {
    await step(stepNames[53], () => exerciseSpotlightArchiveReopen({ browser,observePage,apiPage:arcifyOptions,spotlightOptions,newTabPage,openSavedPage:openSavedMovePage,
        ui,screenshot,snapshot,external,poll,fixture,arcifyId,spotlightId,search,
        record:async evidence => { report.spotlightArchiveReopen = evidence; await saveReport(); } }));
    } // Supplemental Archive cases 52–53; legacy plans remain unchanged.

    if (report.runMode === 'native-split') {
        await step(NATIVE_SPLIT_CASE_NAME, () => exerciseNativeTodaySplit({browser,apiPage:arcifyOptions,newTabPage,pageForUrl,ui,screenshot,
            snapshot,poll,fixture,arcifyId,
            captureNativeWindow:async ({nonce,colors}) => {
                const filename=`${String(report.screenshots.length+1).padStart(2,'0')}-native-split-browser-window.png`;
                const native=await captureNativeSplitWindow({chromePid:browser.process().pid,nonce,colors,output:resolve(OUTPUT,filename)});
                const captured={filename,label:'Native Chrome Split View with both original top-level pages',capturedAt:new Date().toISOString(),nativeWindow:true,...native};
                report.screenshots.push(captured);await saveReport();return captured;
            },
            record:async evidence => { report.nativeSplit=evidence;await saveReport(); } }));
    }
    if (report.runMode === 'native-split') {
    await step(stepNames[54], () => exerciseSpotlightSplit({ browser, observePage, apiPage:arcifyOptions, spotlightOptions, ui, screenshot,
        snapshot, external, poll, fixture, arcifyId, spotlightId, search,
        captureNativeWindow:async ({nonce,colors}) => {
            const filename=`${String(report.screenshots.length+1).padStart(2,'0')}-spotlight-native-split-window.png`;
            const native=await captureNativeSplitWindow({chromePid:browser.process().pid,nonce,colors,output:resolve(OUTPUT,filename)});
            const captured={filename,label:'Spotlight native Split View with its exact active source pane',capturedAt:new Date().toISOString(),nativeWindow:true,...native};
            report.screenshots.push(captured);await saveReport();return captured;
        },
        record:async evidence => { report.spotlightSplit=evidence;await saveReport(); } }));
    } // Mandatory Spotlight case 54 extends the existing Chrome 155 fresh-profile route.
    if (report.runMode === 'full' || report.runMode === 'favorite-lifecycle') {
    await step(stepNames[36], async () => {
        await normalizeReloadControlWindow({ apiPage:arcifyOptions,spotlightApiPage:spotlightOptions,pageForUrl,arcifyId,spotlightId,sourceWindowId:fixture.windowA,counterpartWindowId:fixture.windowB,
            record:async observation => { report.controlWindowSetup ||= []; report.controlWindowSetup.push(observation); await saveReport(); } });
        ordinaryFixture = await exerciseOrdinaryFavorites({ browser,apiPage:arcifyOptions,spotlightApiPage:spotlightOptions,
            newTabPage,pageForUrl,ui,screenshot,snapshot,poll,fixture,arcifyId,spotlightId,search,
            prepareReloadSpacePins:report.runMode === 'favorite-lifecycle' ? () => seedFocusedReloadSpacePins({ fixture,snapshot,bridge }) : undefined,
            reloadArcify:()=>reloadPairedExtension('arcify'),reloadSpotlight:()=>reloadPairedExtension('spotlight'),
            record:async evidence => { report.ordinaryFavorites = evidence; await saveReport(); } });
        return ordinaryFixture;
    });

    await step(stepNames[32], async () => {
        const restarted = await exerciseFavoritesBrowserRestart({browser,launchOptions,
            launch:async options => { browser = await puppeteer.launch(structuredClone(options)); return browser; },
            apiPage:arcifyOptions,fixture,arcifyId,spotlightId,
            expectedExtensions:['arcify','spotlight'].map(name => ({...report.extensions[name],path:resolve(name === 'arcify' ? ROOT : COMPANION,'dist')})),
            snapshot,observePage,blockExternalHttps,ui,screenshot,poll,ordinaryFixture:ordinaryFixture.restartFixture,
            record:async evidence => { report.favoritesBrowserRestart = evidence; await saveReport(); },
            recordTarget:event => report.targetLifecycle.push(event),
            recordDiagnostic:event => report.diagnostics.push(event)});
        browser = restarted.browser; arcifyOptions = restarted.arcifyOptions; spotlightOptions = restarted.spotlightOptions;
        return restarted.evidence;
    },{windowIsolation:false});
    } // Preserve both original full/favorite-lifecycle endings unchanged.

    assert(report.screenshots.length > 0, 'Successful browser verification requires screenshot evidence.');
    assertNoTargetCrashes(report.targetLifecycle);
    assertNoPageErrors(report.diagnostics);
    assertPairedChromeRunPassed(report);
    report.status = 'passed';
} catch (error) {
    report.status = 'failed'; report.failure = { message: error.message, stack: error.stack };
    console.error(error.stack || error);
    await saveReport();
    if (browser) {
        report.optionalFailureCaptures = [];
        for (const [index, page] of (await browser.pages().catch(() => [])).entries()) {
            const label = `failure-page-${index + 1}`;
            report.optionalFailureCaptures.push(await captureVisibleFailurePage(page, label, () => screenshot(page, label)));
        }
    }
    process.exitCode = 1;
} finally {
    report.finishedAt = new Date().toISOString();
    report.summary = Object.fromEntries(['passed', 'failed', 'skipped', 'not_run'].map(status => [status, report.checks.filter(check => check.status === status).length]));
    if (browser) {
        report.finalTargets = browser.targets().map(target => ({ type: target.type(), url: target.url() }));
        await browser.close().catch(error => report.diagnostics.push({ type: 'browser-close', message: error.message }));
    }
    if (server) await new Promise(resolve => server.close(resolve));
    if (profile) await rm(profile, { recursive: true, force: true }).catch(error => report.diagnostics.push({ type: 'profile-cleanup', message: error.message }));
    await saveReport();
    console.log(`Evidence: ${OUTPUT}/report.json (${report.runMode}: ${report.status}); ${report.summary.passed}/${report.expectedCaseCount} expected cases passed; ${report.screenshots.length} screenshots.`);
}
