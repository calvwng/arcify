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
import puppeteer from 'puppeteer';

if (process.env.GITHUB_ACTIONS !== 'true' || process.env.CI !== 'true') {
    throw new Error('This browser fixture is restricted to its dedicated GitHub Actions job. Do not run it locally.');
}
if (process.getuid?.() === 0) throw new Error('Run as the ordinary runner user; this fixture will not disable the Chrome sandbox for root.');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const COMPANION = resolve(process.argv[2] || resolve(ROOT, '../arcify-spotlight'));
const PINNED_SPOTLIGHT = '05dca262001e09f420efeb2bcd3a86a32a4480f5';
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
    'Command registration is present (no OS shortcut assertion)'
];
const report = {
    schemaVersion: 1, startedAt: new Date().toISOString(), status: 'running',
    verification: 'Real Chrome with both production extension builds; no mocked Chrome APIs or transport.',
    environment: { githubActions: true, chromeMode: 'headed Chrome under Xvfb virtual display', runnerOS: process.env.RUNNER_OS, node: process.version,
        workflowSha: process.env.GITHUB_SHA, requestedArcifyHead: process.env.ARCIFY_TEST_HEAD,
        pullRequestHead: process.env.ARCIFY_PR_HEAD || null, githubRunId: process.env.GITHUB_RUN_ID },
    checks: stepNames.map(name => ({ name, status: 'not_run' })), screenshots: [], diagnostics: [],
    limits: [
        'The sidebar UI is opened as sidebar.html in a regular tab; native Chrome side-panel mounting is not exercised.',
        'Command registration is read through chrome.commands.getAll; physical/OS shortcut dispatch is not exercised.',
        'Independent overlay cases wait for the previous close animation to remove its host. Rapid close/reopen stress is not exercised.',
        'A disposable CI profile is used. No installed Chrome Web Store builds, existing user profiles, full browser-session restart, or manual extension-install UI are exercised.',
        'Optional external HTTPS autocomplete is blocked with DevTools Network request blocking; no fake suggestion responses are supplied.',
        'Service-worker stop/wake is conditional on Chrome exposing that extension worker through the ServiceWorker DevTools domain; an unavailable capability is explicitly skipped.'
    ]
};
let browser, server, profile, arcifyId, spotlightId, arcifyOptions, spotlightOptions, fixture, sourcePage;
const observedPages = new Set();
const networkTargets = new WeakMap();
const networkSessions = [];
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const head = path => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path, encoding: 'utf8' }).trim();
const slug = value => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
async function saveReport() { await writeFile(resolve(OUTPUT, 'report.json'), JSON.stringify(report, null, 2)); }
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
async function screenshot(page, label, required = true) {
    if (!page || page.isClosed()) {
        if (required) throw new Error(`Required screenshot has no open page: ${label}`);
        return;
    }
    const filename = `${String(report.screenshots.length + 1).padStart(2, '0')}-${slug(label)}.png`;
    try {
        await page.screenshot({ path: resolve(OUTPUT, filename), fullPage: true });
        report.screenshots.push({ filename, label, url: page.url(), capturedAt: new Date().toISOString() });
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
        try {
            await session.send('Network.enable');
            await session.send('Network.setBlockedURLs', { urls: ['https://*'] });
            networkSessions.push(session);
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
        page.on('pageerror', error => report.diagnostics.push({ type: 'pageerror', url: page.url(), message: error.message }));
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
    await page.waitForFunction(() => {
        const root = document.getElementById('arcify-spotlight-host')?.shadowRoot || document;
        const input = root.querySelector('[data-testid="spotlight-input"]');
        return input && input.getBoundingClientRect().width > 0;
    });
    const handle = await page.evaluateHandle(() => (document.getElementById('arcify-spotlight-host')?.shadowRoot || document).querySelector('[data-testid="spotlight-input"]'));
    const input = handle.asElement(); assert(input);
    await input.click({ clickCount: 3 });
    await input.press('Control+A'); await input.press('Backspace'); await input.type(query);
    await handle.dispose();
}
async function clickResult(page, title) {
    await page.waitForFunction(title => {
        const root = document.getElementById('arcify-spotlight-host')?.shadowRoot || document;
        return [...root.querySelectorAll('[data-testid="spotlight-result"]')].some(item => item.querySelector('.arcify-spotlight-result-title')?.textContent === title);
    }, {}, title);
    const result = await page.evaluateHandle(title => {
        const root = document.getElementById('arcify-spotlight-host')?.shadowRoot || document;
        return [...root.querySelectorAll('[data-testid="spotlight-result"]')].find(item => item.querySelector('.arcify-spotlight-result-title')?.textContent === title);
    }, title);
    const element = result.asElement(); assert(element); await element.click(); await result.dispose();
}
async function enterUrl(page, url) {
    await search(page, url);
    await page.waitForFunction(url => {
        const root = document.getElementById('arcify-spotlight-host')?.shadowRoot || document;
        return root.querySelector('[data-testid="spotlight-result"]')?.textContent.includes(new URL(url).pathname);
    }, {}, url);
    const input = await page.evaluateHandle(() => (document.getElementById('arcify-spotlight-host')?.shadowRoot || document).querySelector('[data-testid="spotlight-input"]'));
    await input.asElement().press('Enter'); await input.dispose();
}
async function launchOverlay(mode = 'new-tab') {
    // Distinct test cases begin after the previous overlay's close animation.
    // This is not a claim that rapid close/reopen races have been tested.
    await sourcePage.waitForFunction(() => !document.getElementById('arcify-spotlight-host'));
    await activate(fixture.sourceA);
    const response = await external(arcifyOptions, spotlightId, 'launch', { windowId: fixture.windowA, mode });
    assert.equal(response?.ok, true, JSON.stringify(response));
    await sourcePage.waitForFunction(() => document.getElementById('arcify-spotlight-host')?.shadowRoot?.querySelector('dialog')?.open);
    return sourcePage;
}

await mkdir(OUTPUT, { recursive: true });
try {
    report.environment.arcifyHead = head(ROOT);
    report.environment.spotlightHead = head(COMPANION);
    assert.equal(report.environment.spotlightHead, PINNED_SPOTLIGHT, 'Companion must match the reviewed pinned commit.');
    if (process.env.ARCIFY_TEST_HEAD) assert.equal(report.environment.arcifyHead, process.env.ARCIFY_TEST_HEAD);
    report.environment.puppeteer = JSON.parse(await readFile(resolve(ROOT, 'node_modules/puppeteer/package.json'), 'utf8')).version;
    await step(stepNames[0], async () => {
        profile = await mkdtemp(resolve(process.env.RUNNER_TEMP || tmpdir(), 'paired-chrome-'));
        // enableExtensions enables Puppeteer's documented extension-debugging API.
        // No --no-sandbox, --disable-web-security, policy edits, or fallback flags.
        const launch = { headless: false, pipe: true, enableExtensions: true, dumpio: true, userDataDir: profile, timeout: 60_000, defaultViewport: { width: 1280, height: 900 } };
        report.environment.requestedLaunch = { ...launch, userDataDir: '<fresh disposable runner profile>' };
        browser = await puppeteer.launch(launch);
        report.environment.chromeVersion = await browser.version();
        report.environment.chromeUserAgent = await browser.userAgent();
        report.environment.chromeArguments = browser.process().spawnargs.map(arg => arg.startsWith('--user-data-dir=') ? '--user-data-dir=<disposable-profile>' : arg);
        assert(!report.environment.chromeArguments.some(arg => /^--(no-sandbox|disable-setuid-sandbox|disable-web-security|single-process|no-zygote)(=|$)/.test(arg)), 'Security-disabling browser argument detected.');
        browser.on('targetcreated', target => { blockExternalHttps(target).catch(error => report.diagnostics.push({ type: 'network-blocking', message: error.message })); });
        arcifyId = await browser.installExtension(resolve(ROOT, 'dist'));
        spotlightId = await browser.installExtension(resolve(COMPANION, 'dist'));
        assert.match(arcifyId, /^[a-p]{32}$/); assert.match(spotlightId, /^[a-p]{32}$/); assert.notEqual(arcifyId, spotlightId);
        report.extensions = {};
        for (const [name, id] of [['arcify', arcifyId], ['spotlight', spotlightId]]) {
            const target = await browser.waitForTarget(target => target.type() === 'service_worker' && target.url() === `chrome-extension://${id}/background.js`, { timeout: 30_000 });
            await blockExternalHttps(target);
            const worker = await target.worker();
            const actual = await worker.evaluate(() => ({ id: chrome.runtime.id, manifest: chrome.runtime.getManifest() }));
            assert.equal(actual.id, id);
            report.extensions[name] = { id, name: actual.manifest.name, version: actual.manifest.version, workerUrl: target.url() };
        }
        for (const page of await browser.pages()) if (/installation-onboarding\.html/.test(page.url())) await page.close();
        arcifyOptions = await observePage(await browser.newPage());
        await arcifyOptions.goto(`chrome-extension://${arcifyId}/options.html`);
        spotlightOptions = await observePage(await browser.newPage());
        await spotlightOptions.goto(`chrome-extension://${spotlightId}/options.html`);
        await screenshot(arcifyOptions, 'installed-arcify-options');
        return report.extensions;
    });
    await step(stepNames[1], async () => {
        const controlWindow = await spotlightOptions.evaluate(async () => (await chrome.windows.getCurrent()).id);
        const unpaired = await external(spotlightOptions, arcifyId, 'hello', { windowId: controlWindow });
        assert.equal(unpaired.ok, false); assert.equal(unpaired.error.code, 'UNAUTHORIZED'); assert.equal('snapshot' in unpaired, false);
        await arcifyOptions.waitForFunction(() => document.getElementById('bridgeStatus')?.textContent.includes('Standalone')); await arcifyOptions.type('#bridgePeerId', spotlightId); await arcifyOptions.click('#bridgeSave');
        await poll(() => arcifyOptions.evaluate(() => chrome.storage.local.get('arcifyBridgePeerId')), result => result.arcifyBridgePeerId === spotlightId, 'Arcify pairing save');
        await spotlightOptions.waitForSelector('#arcify-peer-id:not([disabled])');
        await spotlightOptions.type('#arcify-peer-id', arcifyId); await spotlightOptions.click('#save-connection');
        await spotlightOptions.waitForSelector('#connection-status[data-state="connected"]');
        await arcifyOptions.click('#bridgeCheck');
        await arcifyOptions.waitForFunction(() => document.getElementById('bridgeStatus').textContent.includes('Connected to Spotlight'));
        await screenshot(arcifyOptions, 'paired-arcify-options'); await screenshot(spotlightOptions, 'paired-spotlight-options');
        return { unpairedError: unpaired.error.code, arcifyStatus: await arcifyOptions.$eval('#bridgeStatus', node => node.textContent), spotlightStatus: await spotlightOptions.$eval('#connection-status-message', node => node.textContent) };
    });
    await step(stepNames[2], async () => {
        const titles = { '/source-a': 'Pair Source A', '/alpha': 'Pair Alpha Target', '/source-b': 'Pair Source B', '/beta': 'Pair Beta Target', '/duplicate': 'Pair Shared URL', '/current-navigation': 'Pair Current Navigation', '/helper-open': 'Pair Helper Open', '/sync-off-open': 'Pair Sync Off Open', '/journal-open': 'Pair Journal Open' };
        server = createServer((request, response) => {
            const title = titles[new URL(request.url, 'http://localhost').pathname] || 'Pair Local Fixture';
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
        fixture.windowBBaseline = await windowBState();
        await screenshot(sourcePage, 'local-window-a'); await screenshot(await pageForUrl(`${base}/source-b`), 'local-window-b');
        return { windowA: a.windowId, windowB: b.windowId, spaceOrder: a.spaces.map(space => space.id), duplicateBookmarkIds: fixture.bookmarks };
    });
    await step(stepNames[3], async () => {
        const beforeCount = (await tabsIn(fixture.windowA)).length;
        await launchOverlay(); await search(sourcePage, 'Pair Alpha Target');
        await sourcePage.waitForFunction(() => document.getElementById('arcify-spotlight-host')?.shadowRoot?.textContent.includes('Pair Alpha Target'));
        await screenshot(sourcePage, 'overlay-live-tab-search'); await clickResult(sourcePage, 'Pair Alpha Target');
        await poll(() => tab(fixture.alpha), tab => tab.active, 'exact live-tab selection');
        const state = await snapshot(); assert.equal(state.activeSpaceId, fixture.spaces.personal);
        assert.equal((await tabsIn(fixture.windowA)).length, beforeCount);
        assert.equal((await snapshot(fixture.windowB)).activeSpaceId, fixture.spaces.work);
        return { selectedTabId: fixture.alpha, selectedSpaceId: state.activeSpaceId, tabCountUnchanged: true };
    });
    await step(stepNames[4], async () => {
        const opened = [];
        for (const [title, bookmarkId] of [['Pair Twin One', fixture.bookmarks.one], ['Pair Twin Two', fixture.bookmarks.two], ['Pair Twin One', fixture.bookmarks.one]]) {
            await launchOverlay(); await search(sourcePage, 'Pair Twin');
            await screenshot(sourcePage, `bookmark-search-${title}`); await clickResult(sourcePage, title);
            const state = await poll(snapshot, state => state.bookmarks.find(bookmark => bookmark.id === bookmarkId)?.tabId, `bookmark ${bookmarkId} binding`);
            const id = state.bookmarks.find(bookmark => bookmark.id === bookmarkId).tabId;
            await poll(() => tab(id), tab => tab.active, `bookmark ${bookmarkId} activation`); opened.push(id);
        }
        assert.notEqual(opened[0], opened[1]); assert.equal(opened[0], opened[2]);
        const duplicateTabs = (await tabsIn(fixture.windowA)).filter(tab => tab.url === `${fixture.base}/duplicate`);
        assert.equal(duplicateTabs.length, 2);
        fixture.duplicateTabs = opened.slice(0, 2);
        return { bookmarkIds: fixture.bookmarks, tabIds: fixture.duplicateTabs, repeatReusedExactIdentity: true };
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
        assert.equal((await tabsIn(fixture.windowA)).length, count);
        assert.equal(helper.page.isClosed(), false); assert.equal((await tab(helper.tab.id)).id, helper.tab.id);
        await screenshot(helper.page, 'empty-space-helper-remains-open');
        await enterUrl(helper.page, `${fixture.base}/helper-open`);
        const state = await poll(snapshot, state => state.tabs.some(tab => tab.url === `${fixture.base}/helper-open`), 'helper-created destination');
        const destination = state.tabs.find(tab => tab.url === `${fixture.base}/helper-open`);
        assert.equal(destination.spaceId, fixture.spaces.empty); assert.notEqual(destination.id, helper.tab.id);
        await poll(() => tabsIn(fixture.windowA), tabs => !tabs.some(tab => tab.id === helper.tab.id), 'helper closure after successful new tab');
        await screenshot(await pageForUrl(`${fixture.base}/helper-open`), 'helper-created-owned-tab');
        return { emptySpaceId: fixture.spaces.empty, helperTabId: helper.tab.id, destinationTabId: destination.id };
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
        const sidebar = await newTabPage(`chrome-extension://${arcifyId}/sidebar.html`);
        await sidebar.page.waitForSelector('#spotlightBtn');
        await sidebar.page.waitForSelector('#spacesList > .space');
        const before = new Set((await tabsIn(fixture.windowA)).map(tab => tab.id));
        await screenshot(sidebar.page, 'sidebar-html-regular-tab-not-native-sidepanel'); await sidebar.page.click('#spotlightBtn');
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
        await arcifyOptions.click('label.toggle-label[for="syncTabGroups"]');
        await poll(() => Promise.all([tab(fixture.sourceA), tab(fixture.sourceB), tab(fixture.alpha)]), tabs => tabs.every(tab => tab.groupId >= 0), 'one-way group projection');
        const a = await tab(fixture.sourceA), b = await tab(fixture.sourceB), personal = await tab(fixture.alpha);
        assert.notEqual(a.groupId, b.groupId); assert.notEqual(a.groupId, personal.groupId);
        const groups = await arcifyOptions.evaluate(ids => Promise.all(ids.map(id => chrome.tabGroups.get(id))), [a.groupId, b.groupId, personal.groupId]);
        assert.deepEqual(groups.map(group => group.title), ['Pair Work', 'Pair Work', 'Pair Personal']);
        assert.deepEqual(groups.map(group => group.windowId), [fixture.windowA, fixture.windowB, fixture.windowA]);
        assert.deepEqual((await snapshot()).spaces.map(space => space.id), order);
        await screenshot(arcifyOptions, 'group-sync-enabled-options');
        await arcifyOptions.click('label.toggle-label[for="syncTabGroups"]');
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
        const cdp = await arcifyOptions.target().createCDPSession();
        const versions = new Map();
        cdp.on('ServiceWorker.workerVersionUpdated', ({ versions: updates }) => { for (const version of updates) versions.set(version.versionId, version); });
        try { await cdp.send('ServiceWorker.enable'); }
        catch (error) { await cdp.detach(); return { skipped: true, reason: `Chrome does not expose ServiceWorker domain here: ${error.message}` }; }
        const deadline = Date.now() + 5000;
        let version;
        while (Date.now() < deadline && !version) {
            version = [...versions.values()].find(version => version.scriptURL === `chrome-extension://${arcifyId}/background.js` && version.runningStatus === 'running');
            if (!version) await sleep(100);
        }
        if (!version) { await cdp.detach(); return { skipped: true, reason: 'This Chrome build does not expose the extension worker version through ServiceWorker domain; no stop/restart claim.' }; }
        const requestId = `ci-journal-${crypto.randomUUID()}`;
        const payload = { spaceId: fixture.spaces.work, url: `${fixture.base}/journal-open` };
        const first = await bridge('openTab', payload, requestId);
        const worker = browser.targets().find(target => target.type() === 'service_worker' && target.url() === version.scriptURL);
        assert(worker, 'Arcify worker target must exist before termination.');
        await cdp.send('ServiceWorker.stopWorker', { versionId: version.versionId });
        await poll(async () => browser.targets().includes(worker), present => !present, 'actual Arcify worker termination');
        const repeated = await bridge('openTab', payload, requestId);
        assert.equal(repeated.tabId, first.tabId);
        assert.equal((await tabsIn(fixture.windowA)).filter(tab => tab.url === payload.url).length, 1);
        await browser.waitForTarget(target => target !== worker && target.type() === 'service_worker' && target.url() === version.scriptURL, { timeout: 20_000 });
        await cdp.detach();
        return { stoppedVersionId: version.versionId, repeatedRequestId: requestId, originalAndReplayedTabId: first.tabId, realWorkerRestarted: true };
    });
    await step(stepNames[12], async () => {
        const before = await snapshot();
        for (const name of ['arcify', 'spotlight']) {
            const id = name === 'arcify' ? arcifyId : spotlightId;
            const page = name === 'arcify' ? arcifyOptions : spotlightOptions;
            const worker = browser.targets().find(target => target.type() === 'service_worker' && target.url() === `chrome-extension://${id}/background.js`);
            assert(worker);
            await page.evaluate(() => { setTimeout(() => chrome.runtime.reload(), 50); });
            await poll(async () => browser.targets().includes(worker), present => !present, `extension ${id} worker replaced`);
            await browser.waitForTarget(target => target !== worker && target.type() === 'service_worker' && target.url() === `chrome-extension://${id}/background.js`, { timeout: 30_000 });
            // Reload may close/invalidate the original extension view. Start a
            // fresh options document instead of relying on its old Page object.
            const reopened = await observePage(await browser.newPage());
            await reopened.goto(`chrome-extension://${id}/options.html`);
            if (name === 'arcify') arcifyOptions = reopened; else spotlightOptions = reopened;
            if (!page.isClosed()) await page.close().catch(() => {});
        }
        await spotlightOptions.waitForSelector('#refresh-connection:not([disabled])');
        await spotlightOptions.click('#refresh-connection'); await spotlightOptions.waitForSelector('#connection-status[data-state="connected"]');
        const after = await snapshot();
        assert.deepEqual(after.spaces.map(space => space.id), before.spaces.map(space => space.id));
        for (const tabId of [fixture.sourceA, fixture.alpha]) assert.equal(after.tabs.find(tab => tab.id === tabId)?.spaceId, before.tabs.find(tab => tab.id === tabId)?.spaceId);
        const replayed = await bridge('activateTab', { tabId: fixture.alpha }); assert.equal(replayed.tabId, fixture.alpha);
        await screenshot(spotlightOptions, 'connected-after-both-extension-reloads');
        return { reloadedExtensionIds: [arcifyId, spotlightId], stableSpaceIds: after.spaces.map(space => space.id), note: 'Extension reload is distinct from service-worker suspension and from a full Chrome restart. Existing page content scripts require a page refresh after extension reload.' };
    });
    await step(stepNames[13], async () => {
        const arcify = await arcifyOptions.evaluate(() => chrome.commands.getAll());
        const spotlight = await spotlightOptions.evaluate(() => chrome.commands.getAll());
        for (const name of ['toggleSpotlight', 'toggleSpotlightNewTab']) assert(spotlight.some(command => command.name === name));
        assert(arcify.some(command => command.name === '_execute_action'));
        await screenshot(arcifyOptions, 'final-arcify-settings'); await screenshot(spotlightOptions, 'final-spotlight-settings');
        return { arcify, spotlight, actualOsShortcutPressTested: false, nativeSidePanelTested: false };
    });
    assert(report.screenshots.length > 0, 'Successful browser verification requires screenshot evidence.');
    report.status = report.checks.some(check => check.status === 'skipped') ? 'passed_with_skips' : 'passed';
} catch (error) {
    report.status = 'failed'; report.failure = { message: error.message, stack: error.stack };
    console.error(error.stack || error);
    if (browser) {
        for (const [index, page] of (await browser.pages().catch(() => [])).entries()) await screenshot(page, `failure-page-${index + 1}`, false);
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
