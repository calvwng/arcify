#!/usr/bin/env node
/**
 * GitHub-hosted, real-Chrome paired-extension fixture. No mocked Chrome APIs.
 * Do not invoke locally. Syntax checks (node --check) do not launch a browser.
 * Chrome uses its normal sandbox. A launch denial is a failed check, never a
 * reason to change runner policy or disable Chrome security.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from './paired-chrome-runtime/index.mjs';
import { assertNativeSidebarEvidence, assertSidebarHelperUnchanged, readNativeSidebarRender, nativeSidebarRenderReady, nativeSidebarRenderIdentity, createNativeSidebarReadiness, assertNativeSidebarScreenshot, readSpotlightRows, assertMatchedActionFirst, evaluateWithoutGesture } from './paired-chrome-sidebar.mjs';
import { performVisibleAction, replaceInputText, captureVisibleFailurePage, clickFreshResult, selectResultWithKeyboard, assertNoPageErrors } from './paired-chrome-ui.mjs';
import { readNewTabReuseState, assertActiveNewTabReused, isSpotlightNewTabTarget } from './paired-chrome-newtab.mjs';
import { KEYBOARD_CSP, KEYBOARD_HTML, KEYBOARD_SCRIPT, spotlightSurface, assertHostKeyboardIsolated } from './paired-chrome-keyboard.mjs';
import { readDeveloperModeDomState, developerModeStateReady, enableDeveloperModeViaUi, findInstalledExtension, waitForEnabledExtension } from './paired-chrome-extensions.mjs';
import { waitForExtensionWorkerIdentity, assertNoWorkerExceptions, findExactWorkerTarget, terminateObservedWorker, reloadObservedExtension, observeTargetDiagnostics, assertNoTargetCrashes } from './paired-chrome-worker.mjs';
import { CHROME_EXECUTABLE, inspectInstalledChromeRuntime, inspectChromeProcessRuntime,
    validateChromeLaunchArguments, validateNamespaceLaunchEnvironment, validateChromeNamespaceSandboxStatus } from './paired-chrome-sandbox.mjs';

if (process.env.GITHUB_ACTIONS !== 'true' || process.env.CI !== 'true') {
    throw new Error('This browser fixture is restricted to its dedicated GitHub Actions job. Do not run it locally.');
}
if (process.getuid?.() === 0) throw new Error('Run as the ordinary runner user; this fixture will not disable the Chrome sandbox for root.');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const COMPANION = resolve(process.argv[2] || resolve(ROOT, '../arcify-spotlight'));
const PINNED_SPOTLIGHT = '0f1ba5eaa50de724cc5ab1e5ef8790e21faeaf08';
const OUTPUT = resolve(ROOT, 'test-results/paired-chrome');
const stepNames = [
    'Sandboxed Chrome startup and exact extension identities',
    'Unpaired rejection and options-UI pairing',
    'Real bookmark/tab fixtures and window-scoped snapshots',
    'Spotlight overlay search selects the exact live tab',
    'Duplicate bookmark identities remain separate through UI selection',
    'Overlay current-tab URL navigation preserves identity',
    'Empty-space helper selection and new-tab URL opening',
    'Chrome new-tab override renders Spotlight',
    'Sidebar-tab launch button and helper reuse',
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
    'Sidebar drag anchors match saved tab and folder destinations'
];
const report = {
    schemaVersion: 1, startedAt: new Date().toISOString(), status: 'running',
    verification: 'Real Chrome with both production extension builds; no mocked Chrome APIs or transport.',
    environment: { githubActions: true, chromeMode: 'headed Chrome under Xvfb virtual display', runnerOS: process.env.RUNNER_OS, node: process.version,
        workflowSha: process.env.GITHUB_SHA, requestedArcifyHead: process.env.ARCIFY_TEST_HEAD,
        pullRequestHead: process.env.ARCIFY_PR_HEAD || null, githubRunId: process.env.GITHUB_RUN_ID,
        imageOS: process.env.ImageOS, imageVersion: process.env.ImageVersion, runnerUid: process.getuid?.() },
    checks: stepNames.map(name => ({ name, status: 'not_run' })), screenshots: [], diagnostics: [], targetLifecycle: [],
    limits: [
        'Workspace rendering regressions use sidebar.html in a regular tab. Dedicated command checks separately require native SIDE_PANEL contexts, onOpened events and rendered panel content; browser-chrome docking/focus and Helium behavior remain manual.',
        'Startup suggestion delivery is exercised with an authenticated offer to an existing new-tab page. Full browser onStartup scheduling/session restore and initial omnibox focus are not exercised; Enter tests explicitly focus Spotlight.',
        'Command registration is read through chrome.commands.getAll; physical/OS shortcut dispatch is not exercised.',
        'Independent overlay cases wait for the previous close animation to remove its host. Rapid close/reopen stress is not exercised.',
        'The runner uses its installed stable Chrome and existing AppArmor policy, with actual Namespace/PID/network/seccomp sandbox evidence required. No privileged helper is selected, installed or modified. The runner image supplies the browser version; package/runtime evidence is recorded for each run.',
        'A disposable CI profile is used. No installed Chrome Web Store builds, existing user profiles, full browser-session restart, or manual extension-install UI are exercised.',
        'Optional external HTTPS autocomplete is blocked with DevTools Network request blocking; no fake suggestion responses are supplied.',
        "Worker termination uses Chrome's documented Puppeteer WebWorker.close API; real raw target destruction and a distinct restarted worker are required. This is not a full browser restart."
    ]
};
let browser, server, profile, arcifyId, spotlightId, arcifyOptions, spotlightOptions, fixture, sourcePage, sidebarFixture;
const observedPages = new Set();
const networkTargets = new WeakMap();
const networkSessions = [];
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const head = path => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path, encoding: 'utf8' }).trim();
const slug = value => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
async function saveReport() { await writeFile(resolve(OUTPUT, 'report.json'), JSON.stringify(report, null, 2)); }
async function ui(page, label, action) {
    return performVisibleAction(page, label, action, async checkpoint => {
        report.uiActions ||= [];
        report.uiActions.push(checkpoint);
        await saveReport();
    });
}
async function clickUI(page, selector) { return ui(page, `Click ${selector}`, () => page.click(selector)); }
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
async function step(name, operation) {
    const check = report.checks.find(item => item.name === name);
    assert(check, `Unknown check: ${name}`);
    check.status = 'running'; check.startedAt = new Date().toISOString();
    await saveReport();
    try {
        const detail = await operation();
        if (fixture?.windowBBaseline) {
            assert.deepEqual(await windowBState(), fixture.windowBBaseline, 'An operation in window A changed window B tabs or memberships.');
            check.windowBUnchanged = true;
        }
        assertNoTargetCrashes(report.targetLifecycle);
        assertNoPageErrors(report.diagnostics);
        check.status = detail?.skipped ? 'skipped' : 'passed';
        if (detail !== undefined) check.details = detail;
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
    const response = await external(spotlightOptions, arcifyId, command, { windowId: fixture.windowA, ...payload }, requestId);
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
async function newTabPage(url, windowId = fixture.windowA) {
    const before = new Set(browser.targets());
    const created = await arcifyOptions.evaluate(options => chrome.tabs.create(options), { windowId, url, active: true });
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

const sidebarSelector = '[data-result-type="arcify-sidebar-command"]';
async function sidebarInput(page) {
    const handle = await (await spotlightSurface(page)).evaluateHandle(() => document.querySelector('[data-testid="spotlight-input"]'));
    assert(handle.asElement(), 'Spotlight input must exist.');
    return handle;
}
async function waitSidebarCommand(page) {
    await page.waitForFunction(() => (document.getElementById('arcify-spotlight-host')?.shadowRoot?.querySelector('[data-testid="spotlight-frame"]')?.contentDocument || document.getElementById('arcify-spotlight-host')?.shadowRoot || document).querySelector('[data-result-type="arcify-sidebar-command"]'), { polling: 50 });
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
async function captureNativeSidebar(afterEvent, label) {
    const state = await poll(nativePanelState, state => state.events.slice(afterEvent).some(event => event.type === 'opened' && event.windowId === fixture.windowA), 'a native sidePanel.onOpened event');
    const populated = await poll(nativePanelState, state => state.contexts.some(context => context.contextType === 'SIDE_PANEL' && context.documentUrl === `chrome-extension://${arcifyId}/sidebar.html`), 'a native SIDE_PANEL context');
    const context = assertNativeSidebarEvidence(populated.contexts, populated.events, { extensionId: arcifyId, windowId: fixture.windowA, afterEvent });
    const ordinary = await arcifyOptions.evaluate(() => chrome.tabs.query({}));
    assert(!ordinary.some(tab => tab.url === `chrome-extension://${arcifyId}/sidebar.html`), 'No ordinary sidebar tab may substitute for native rendering evidence.');
    const target = await browser.waitForTarget(target => target.url() === `chrome-extension://${arcifyId}/sidebar.html`);
    const page = await observePage(await target.asPage());
    const hosting = await page.evaluate(async () => ({ tab: await chrome.tabs.getCurrent() || null, windowId: (await chrome.windows.getCurrent()).id }));
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
        const launch = { channel: 'chrome', headless: false, pipe: true, enableExtensions: true, dumpio: true, userDataDir: profile, timeout: 60_000, protocolTimeout: 30_000, defaultViewport: { width: 1280, height: 900 } };
        report.environment.requestedLaunch = { ...launch, userDataDir: '<fresh disposable runner profile>' };
        validateChromeLaunchArguments(await puppeteer.defaultArgs(launch));
        browser = await puppeteer.launch(launch);
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
        const titles = { '/source-a': 'Pair Source A', '/alpha': 'Pair Alpha Target', '/source-b': 'Pair Source B', '/beta': 'Pair Beta Target', '/duplicate': 'Pair Shared URL', '/current-navigation': 'Pair Current Navigation', '/helper-open': 'Pair Helper Open', '/sync-off-open': 'Pair Sync Off Open', '/journal-open': 'Pair Journal Open', '/sidebar-match': 'Open Arcify sidebar', '/logical-one': 'Logical Tab One', '/logical-two': 'Logical Tab Two' };
        server = createServer((request, response) => {
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
        await sidebar.page.waitForSelector('#spotlightBtn');
        await sidebar.page.waitForSelector('#spacesList > .space');
        const before = new Set((await tabsIn(fixture.windowA)).map(tab => tab.id));
        await screenshot(sidebar.page, 'sidebar-html-regular-tab-not-native-sidepanel'); await clickUI(sidebar.page, '#spotlightBtn');
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
        for (const name of ['arcify', 'spotlight']) {
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
            const evidence = { name, view, observations: [], registry: [] };
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
                    reload: () => ui(page, `Reload ${name} extension`, () => page.evaluate(() => { setTimeout(() => chrome.runtime.reload(), 50); })),
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
                    await spotlightOptions.waitForSelector('#refresh-connection:not([disabled])');
                    await clickUI(spotlightOptions, '#refresh-connection');
                    await spotlightOptions.waitForSelector('#connection-status[data-state="connected"]');
                } else {
                    await arcifyOptions.waitForSelector('#bridgeCheck:not([disabled])');
                    await clickUI(arcifyOptions, '#bridgeCheck');
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
        }
        await spotlightOptions.waitForSelector('#refresh-connection:not([disabled])');
        await clickUI(spotlightOptions, '#refresh-connection'); await spotlightOptions.waitForSelector('#connection-status[data-state="connected"]');
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
        await helper.page.waitForSelector('[data-testid="spotlight-result"]:not([data-result-type="arcify-sidebar-command"])');
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
        await closeNativeSidebar(); await arcifyOptions.evaluate(id => chrome.tabs.remove(id), helper.tab.id);
        return { startupOffer: offered, repeatedOffer: repeated, focusBefore, focusExplicitlySetForEnter: true, actualBrowserStartupTested: false, sourceBefore, native };
    });
    await step(stepNames[15], async () => {
        const helper = await newTabPage(`chrome-extension://${spotlightId}/newtab.html`);
        await waitSidebarCommand(helper.page);
        await helper.page.waitForSelector('[data-testid="spotlight-result"]:not([data-result-type="arcify-sidebar-command"])');
        const offered = await external(arcifyOptions, spotlightId, 'startupSuggestion', { windowId: fixture.windowA, tabId: helper.tab.id });
        assert.equal(offered.accepted, true, JSON.stringify(offered));
        await helper.page.waitForSelector(`${sidebarSelector}.selected`);
        const preparedInput = await sidebarInput(helper.page);
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
        const session = await browser.target().createCDPSession();
        const readTargets = async () => (await session.send('Target.getTargets')).targetInfos;
        report.sidebarColdWorker = [];
        const lifecycleStart = report.targetLifecycle.length;
        try {
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
        } finally { await preparedInput.dispose(); await session.detach(); }
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
            await ui(sourcePage, 'Choose retained web search below matched action', () => input.asElement().press('ArrowDown'));
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
        await clickResult(helper.page, 'New Tab');
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
            await ui(helper.page, 'Explicitly keep web search selected during logical updates', async () => {
                await input.asElement().press('ArrowDown'); await input.asElement().press('ArrowUp');
            });
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
                    const item = {type,at:performance.now(),tag:event.target?.tagName,classes:event.target?.className,
                        id:event.target?.closest?.('[data-bookmark-id]')?.dataset.bookmarkId,x:event.clientX,y:event.clientY,
                        prevented:event.defaultPrevented,types:[...(event.dataTransfer?.types || [])]};
                    window.__pairedDragEvents.push(item);
                    if (window.__pairedDragEvents.length > 150) window.__pairedDragEvents.shift();
                },{capture:true,passive:true});
            }
        });
        const drag = async (sourceSelector,targetSelector,placement,label) => ui(page,label,async () => {
            const source = await page.$(sourceSelector), target = await page.$(targetSelector);
            assert(source && target,'Exact drag source and destination must exist.');
            let mouseDown = false;
            const diagnostic = {label,sourceSelector,targetSelector,placement};
            report.dragActions ||= []; report.dragActions.push(diagnostic);
            try {
                await target.scrollIntoView();
                const from = await source.boundingBox(),to = await target.boundingBox();
                assert(from && to && from.height > 0 && to.height > 0);
                if (placement === 'before') assert(from.y > to.y,'The before-drop must move a later visual row, not assert an existing no-op.');
                diagnostic.sourceRect = from; diagnostic.targetRect = to;
                diagnostic.before = await page.evaluate(() => ({events:window.__pairedDragEvents,dragging:document.querySelector('.dragging')?.outerHTML}));
                const x = Math.min(from.x+40,from.x+from.width/2),y = from.y+from.height/2;
                const tx = Math.min(to.x+40,to.x+to.width/2),ty = placement === 'inside' ? to.y+to.height/2 : to.y+2;
                diagnostic.hitPoints = await page.evaluate(({x,y,tx,ty}) => ({
                    source:document.elementFromPoint(x,y)?.outerHTML,target:document.elementFromPoint(tx,ty)?.outerHTML
                }),{x,y,tx,ty});
                diagnostic.sourceConnected = await source.evaluate((element,selector) => element.isConnected && element === document.querySelector(selector),sourceSelector);
                diagnostic.targetConnected = await target.evaluate((element,selector) => element.isConnected && element === document.querySelector(selector),targetSelector);
                await page.mouse.move(x,y); await page.mouse.down(); mouseDown = true;
                await page.mouse.move(x+12,y,{steps:5});
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
                    diagnostic.sourceStillConnected = await source.evaluate((element,selector) => element.isConnected && element === document.querySelector(selector),sourceSelector);
                    diagnostic.targetStillConnected = await target.evaluate((element,selector) => element.isConnected && element === document.querySelector(selector),targetSelector);
                    await screenshot(page,`${label}-failure-before-cleanup`,false);
                } catch (captureError) { diagnostic.captureError = captureError.message; }
                try { await saveReport(); } catch (saveError) { diagnostic.saveError = saveError.message; }
                throw error;
            } finally {
                if (mouseDown) { await page.keyboard.press('Escape').catch(() => {}); await page.mouse.up().catch(() => {}); }
                await source.dispose(); await target.dispose();
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

    assert(report.screenshots.length > 0, 'Successful browser verification requires screenshot evidence.');
    assertNoTargetCrashes(report.targetLifecycle);
    assertNoPageErrors(report.diagnostics);
    report.status = report.checks.some(check => check.status === 'skipped') ? 'passed_with_skips' : 'passed';
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
    console.log(`Evidence: ${OUTPUT}/report.json (${report.status}); ${report.screenshots.length} screenshots.`);
}
