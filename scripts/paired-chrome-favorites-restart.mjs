/** Final paired-CI scenario. Import/unit-test only locally; never launch Chrome locally. */
import assert from 'node:assert/strict';
import { restartObservedBrowser } from './paired-chrome-browser-restart.mjs';
import { CHROME_EXECUTABLE, inspectInstalledChromeRuntime, inspectChromeProcessRuntime,
    validateChromeLaunchArguments, validateNamespaceLaunchEnvironment, validateChromeNamespaceSandboxStatus } from './paired-chrome-sandbox.mjs';
import { developerModeStateReady, readDeveloperModeDomState, findInstalledExtension } from './paired-chrome-extensions.mjs';
import { observeTargetDiagnostics, assertNoTargetCrashes, waitForExtensionWorkerIdentity, assertNoWorkerExceptions } from './paired-chrome-worker.mjs';
import { FAVORITE_FAVICON_PATH, assertLegacyFavoriteRegistry, retainedFavoriteCache,
    assertFavoriteIconProjection, waitForRetainedFavoriteIcon } from './paired-chrome-favorite-icons.mjs';

const byId = (a, b) => String(a.id).localeCompare(String(b.id));
const tabIdentity = ({ id, windowId, url, pinned, incognito }) => ({ id, windowId, url, pinned, incognito });
const tabsIdentity = tabs => tabs.map(tabIdentity).sort(byId);
const sourceIdentity = ({ id, parentId, index, title, url }) => ({ id, parentId, index, title, ...(url === undefined ? {} : { url }) });
const registryIdentity = extensions => extensions.map(({ id, name, version, path, enabled }) => ({ id, name, version, path, enabled })).sort(byId);

export async function requestScopedFavorite(page, windowId, action, payload = {}) {
    const result = await page.evaluate(async message => {
        const sender = await chrome.tabs.getCurrent();
        if (sender?.windowId !== message.windowId) throw new Error('Favorite fixture request must originate in its exact target window.');
        return chrome.runtime.sendMessage(message);
    }, { type: 'favoriteStore', action, windowId, ...payload });
    assert.equal(result?.success, true, JSON.stringify(result)); return result;
}

export function durableFavoriteRecords(favorites) {
    assert(Array.isArray(favorites), 'An ordered durable Favorites list is required.');
    const seen = new Set();
    return favorites.map(({ id, title, url, sourceBookmarkId }) => {
        assert(typeof id === 'string' && id && !seen.has(id), 'Every durable Favorite must retain a distinct nonempty ID.');
        seen.add(id);
        assert.equal(typeof title, 'string'); assert.equal(typeof url, 'string');
        assert(sourceBookmarkId === null || typeof sourceBookmarkId === 'string' && sourceBookmarkId);
        return { id, title, url, sourceBookmarkId };
    });
}

// Native tab IDs are browser-session identities. Across restart compare content
// with multiplicity, never guess an old/new tab mapping from a matching URL.
export function nativePinContents(tabs) {
    return tabs.filter(tab => tab.pinned && !tab.incognito)
        .map(({ url, pinned, incognito }) => ({ url, pinned, incognito }))
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

export function assertUnchangedExtensionRegistry(before, after, expected) {
    assert(Array.isArray(expected) && expected.length === 2, 'Both exact extension identities are required.');
    assert.notEqual(expected[0].id, expected[1].id);
    for (const extension of expected) {
        assert.equal(findInstalledExtension(before, extension).enabled, true);
        assert.equal(findInstalledExtension(after, extension).enabled, true);
    }
    assert.deepEqual(registryIdentity(after), registryIdentity(before), 'Browser restart must retain the unchanged enabled extension registry.');
}

export function assertFreshFavoriteRead(beforeTabs, afterTabs) {
    assert.deepEqual(tabsIdentity(afterTabs), tabsIdentity(beforeTabs), 'Reading Favorites must not create, close, navigate, move or pin tabs.');
}

export function readFavoriteRender() {
    return {
        favorites: [...document.querySelectorAll('#pinnedFavicons .saved-favorite')].map(node => ({
            id: node.dataset.favoriteId, tabId: node.dataset.tabId ? Number(node.dataset.tabId) : null,
            closed: node.classList.contains('favorite-closed') })),
        nativeTabIds: [...document.querySelectorAll('#pinnedFavicons .native-favorite')].map(node => Number(node.dataset.tabId))
    };
}

export function assertFavoriteRender(state, render) {
    assert.deepEqual(render.favorites, state.favorites.map(({ id, tabId }) => ({ id, tabId, closed: tabId === null })),
        'Sidebar must render every saved Favorite in durable order with its exact open/closed binding.');
    assert.deepEqual([...render.nativeTabIds].sort((a, b) => a - b), state.nativeTabs.map(tab => tab.id).sort((a, b) => a - b),
        'Sidebar must render all native pins separately by their actual current-session IDs.');
}

export function assertFavoritesAfterRestart(before, after) {
    assertLegacyFavoriteRegistry(before.durable); assertLegacyFavoriteRegistry(after.durable);
    retainedFavoriteCache(before.iconCache, before.durable); retainedFavoriteCache(after.iconCache, after.durable);
    assert.deepEqual(after.durable, before.durable, 'All saved IDs, order, titles, URLs and source IDs must survive browser restart in the unchanged legacy registry.');
    assert.deepEqual(after.iconCache, before.iconCache, 'The separate icon cache must retain exact ID-and-saved-URL ownership and bytes across restart.');
    assert.deepEqual(after.sources, before.sources, 'Exact source bookmarks and their parents must survive unchanged.');
    assert.deepEqual(after.session?.bindings ?? [], [], 'Old browser-session Favorite bindings must not survive restart.');
    assert.deepEqual(after.session?.attempts ?? [], [], 'Old browser-session open receipts must not survive restart.');
    assert.deepEqual(after.sessionAfterGet?.bindings ?? [], [], 'Reading or rendering Favorites must not invent session bindings.');
    assert.deepEqual(after.sessionAfterGet?.attempts ?? [], [], 'Reading or rendering Favorites must not attempt to open tabs.');
    assert(after.states.length > 0, 'Fresh normal browser windows must be observed after restart.');
    assert.deepEqual(after.states.map(state => state.windowId).sort(), after.windows.map(window => window.id).sort(), 'Every fresh normal window must be checked.');
    for (const state of after.states) {
        assert.deepEqual(durableFavoriteRecords(state.favorites), before.durable, 'Every fresh window must expose the same ordered durable list.');
        assertFavoriteIconProjection(state.favorites, after.iconCache, after.durable);
        assert(state.favorites.every(item => item.tabId === null), 'No saved Favorite may silently adopt a restored or equal-URL native pin.');
        const pins = after.tabs.filter(tab => tab.windowId === state.windowId && tab.pinned && !tab.incognito);
        assert.deepEqual(tabsIdentity(state.nativeTabs), tabsIdentity(pins), 'All observed restored pins must remain separate native pins with their own exact new IDs.');
    }
}

export function assertOrdinaryFavoriteRestartBoundary(before, after, expected) {
    assert(expected && typeof expected.favoriteId === 'string' && Number.isSafeInteger(expected.tabId), 'An exact ordinary Favorite handoff is required.');
    const item = before.durable.find(item => item.id === expected.favoriteId);
    const binding = before.sessionAfterGet?.bindings.find(binding => binding.favoriteId === expected.favoriteId && binding.tabId === expected.tabId);
    const live = before.tabs.find(tab => tab.id === expected.tabId);
    assert(item && binding?.mode === 'ordinary', 'The ordinary Favorite must have a real old-session association before restart.');
    assert(live && !live.pinned && !live.incognito && live.windowId === binding.windowId, 'The old exact ordinary tab must still be open and unpinned.');
    const cache = retainedFavoriteCache(before.iconCache, before.durable);
    const ordinaryIcon = cache?.entries.filter(entry => entry.favoriteId === item.id && entry.url === item.url) || [];
    assert.equal(ordinaryIcon.length, 1, 'The exact ordinary Favorite must have its own valid retained icon before restart.');
    assert.deepEqual(after.durable.find(candidate => candidate.id === item.id), item, 'The saved ordinary Favorite survives unchanged.');
    assert.deepEqual(after.iconCache, before.iconCache, 'The ordinary Favorite shares the same durable icon-preservation guarantee.');
    assert.deepEqual(after.iconCache.entries.filter(entry => entry.favoriteId === item.id), ordinaryIcon);
    for (const state of after.states) assert.equal(state.favorites.find(candidate => candidate.id === item.id)?.tabId, null, 'A fresh browser session cannot guess the old ordinary association.');
    for (const state of [after.session, after.sessionAfterGet]) {
        assert(!(state?.bindings || []).some(candidate => candidate.favoriteId === item.id));
        assert(!(state?.attempts || []).some(candidate => candidate.favoriteId === item.id));
    }
    return { favoriteId:item.id, oldTabId:live.id, oldWindowId:live.windowId,
        savedRecordRetained:true, associationRecovered:false,
        restoredOrdinaryTabsAreNotRequired:true, urlBasedIdentityMatching:false };
}

export function assertFavoriteReopened(before, after, { favoriteId, windowId }) {
    assertLegacyFavoriteRegistry(before.durable); assertLegacyFavoriteRegistry(after.durable);
    retainedFavoriteCache(before.iconCache, before.durable); retainedFavoriteCache(after.iconCache, after.durable);
    assert.deepEqual(after.durable, before.durable, 'Reopening must not change durable Favorite metadata or order.');
    assert.deepEqual(after.iconCache, before.iconCache, 'Reopening must preserve the separate cache identities, saved URLs and retained bytes.');
    assert.deepEqual(after.sources, before.sources, 'Reopening must not change original source bookmarks or parents.');
    const previous = before.states.find(state => state.windowId === windowId);
    const current = after.states.find(state => state.windowId === windowId);
    assert(previous && current, 'The exact fresh target window must remain present.');
    const closed = previous.favorites.find(item => item.id === favoriteId);
    const opened = current.favorites.find(item => item.id === favoriteId);
    assert.equal(closed?.tabId, null, 'The clicked Favorite must genuinely be closed in this browser session.');
    assert(Number.isSafeInteger(opened?.tabId), 'The clicked Favorite must acquire one exact current-window binding.');
    const additions = after.tabs.filter(tab => !before.tabs.some(existing => existing.id === tab.id));
    assert.equal(additions.length, 1, 'One explicit click must create exactly one new tab.');
    const created = additions[0];
    assert.equal(created.id, opened.tabId, 'The new tab must be the exact reopened Favorite, never an existing URL match.');
    assert.equal(created.windowId, windowId); assert.equal(created.url, closed.url);
    assert.equal(created.pinned, true); assert.equal(created.active, true); assert.equal(created.incognito, false);
    assert.equal(after.tabs.length, before.tabs.length + 1);
    assert.deepEqual(after.sessionAfterGet?.bindings, [{ favoriteId, windowId, tabId: created.id }], 'Only the one explicitly reopened identity may enter the new session registry.');
    assert.deepEqual(after.sessionAfterGet?.attempts, [], 'Successful reopening must leave no pending receipt.');
    assert.deepEqual(tabsIdentity(after.tabs.filter(tab => tab.id !== created.id)), tabsIdentity(before.tabs), 'Every preexisting tab and restored native pin must remain open, unnavigated and unchanged.');
    for (const priorState of before.states) {
        const state = after.states.find(item => item.windowId === priorState.windowId);
        assert(state, 'All fresh windows must remain present.');
        assert.deepEqual(durableFavoriteRecords(state.favorites), before.durable);
        assertFavoriteIconProjection(state.favorites, after.iconCache, after.durable);
        assert.deepEqual(tabsIdentity(state.nativeTabs), tabsIdentity(priorState.nativeTabs), 'An explicit reopen must leave every native pin separate and unchanged.');
        for (const favorite of state.favorites) {
            const expectedTabId = state.windowId === windowId && favorite.id === favoriteId ? created.id : null;
            assert.equal(favorite.tabId, expectedTabId, 'Reopening must bind only the clicked Favorite in the selected window.');
        }
    }
    return created;
}

/**
 * launch must assign the caller's current browser for failure cleanup. record
 * persists the supplied plain evidence snapshot. observePage/screenshot/ui/poll
 * are the existing fixture helpers. No direct storage/profile writes or reinstalls occur.
 * The returned live handles must not be included directly in JSON reports.
 */
export async function exerciseFavoritesBrowserRestart({ browser, launchOptions, launch, apiPage, fixture,
    arcifyId, spotlightId, expectedExtensions, snapshot, observePage, blockExternalHttps,
    ui, screenshot, poll, record, ordinaryFixture = null, recordTarget = () => {}, recordDiagnostic = () => {} }) {
    const evidence = { phase: 'preparing', restartObservations: [], targetLifecycle: [], diagnostics: [], workerObservations: [], workerExceptions: [], readerTabs: [],
        limits: ['Native tab IDs are not treated as stable across restart. Pre/post native pin content is recorded as duplicate-preserving multisets; Chrome is not required to restore every pin. Subsequent preservation uses each newly observed exact tab ID.',
            'This exercises one graceful close/relaunch of the same disposable CI profile with unchanged security defaults. It does not assert physical Ctrl+W, native sidebar docking, or restoration of every unpinned browser-session tab.'] };
    const checkpoint = async phase => { evidence.phase = phase; await record(structuredClone(evidence)); };
    const diagnostic = event => { evidence.diagnostics.push(event); recordDiagnostic(event); };
    const targetEvent = event => { evidence.targetLifecycle.push(event); recordTarget(event); };
    const request = requestScopedFavorite;
    const readers = new Map();
    const pageInWindow = async (api, windowId, url) => {
        const tab = await api.evaluate(options => chrome.tabs.create(options), { windowId, url, active: false });
        const target = await currentBrowser.waitForTarget(async target => {
            if (target.type() !== 'page' || target.url() !== url) return false;
            return (await (await target.page()).evaluate(async () => (await chrome.tabs.getCurrent())?.id)) === tab.id;
        }, { timeout: 20_000 });
        const page = await observePage(await target.page());
        const current = await page.evaluate(() => chrome.tabs.getCurrent());
        assert.equal(current.id, tab.id); assert.equal(current.windowId, windowId);
        return { page, tab };
    };
    const registry = async current => {
        const session = await current.target().createCDPSession();
        try { return (await session.send('Extensions.getExtensions')).extensions; }
        finally { await session.detach(); }
    };
    const read = async page => {
        const currentTab = await page.evaluate(() => chrome.tabs.getCurrent());
        assert(Number.isSafeInteger(currentTab?.windowId), 'An actual Arcify reader tab is required.');
        readers.set(currentTab.windowId, page);
        const windows = await page.evaluate(async () => (await chrome.windows.getAll({ windowTypes: ['normal'] })).filter(window => !window.incognito));
        // These explicit observation pages are fixture setup before the baseline,
        // not tabs created by FavoriteStore.get. No cross-window sender shortcut.
        for (const window of windows) {
            if (readers.get(window.id) && !readers.get(window.id).isClosed()) continue;
            const reader = await pageInWindow(page, window.id, `chrome-extension://${arcifyId}/options.html`);
            readers.set(window.id, reader.page);
            evidence.readerTabs.push({ phase: evidence.phase, id: reader.tab.id, windowId: window.id, url: reader.tab.url });
        }
        const data = await page.evaluate(async () => {
            const windows = (await chrome.windows.getAll({ windowTypes: ['normal'] })).filter(window => !window.incognito);
            const tabs = await chrome.tabs.query({});
            const local = await chrome.storage.local.get(['persistentFavorites', 'favoriteIconCache']);
            const session = await chrome.storage.session.get('favoriteSession');
            const favorites = local.persistentFavorites;
            const sourceIds = [...new Set((favorites || []).map(item => item.sourceBookmarkId).filter(Boolean))];
            const sources = [], parents = new Map();
            for (const id of sourceIds) {
                const [node] = await chrome.bookmarks.get(id); sources.push(node);
                if (!parents.has(node.parentId)) parents.set(node.parentId, (await chrome.bookmarks.get(node.parentId))[0]);
            }
            return { windows, tabs, durable: favorites, iconCache: local.favoriteIconCache ?? null,
                session: session.favoriteSession ?? null, sources, parents: [...parents.values()] };
        });
        data.sources = { bookmarks: data.sources.map(sourceIdentity).sort(byId), parents: data.parents.map(sourceIdentity).sort(byId) };
        delete data.parents;
        assertLegacyFavoriteRegistry(data.durable); retainedFavoriteCache(data.iconCache, data.durable);
        data.durable = durableFavoriteRecords(data.durable);
        data.states = [];
        for (const window of data.windows) data.states.push({ windowId: window.id, ...await request(readers.get(window.id), window.id, 'get') });
        const after = await page.evaluate(async () => ({ tabs: await chrome.tabs.query({}), session: (await chrome.storage.session.get('favoriteSession')).favoriteSession ?? null }));
        assertFreshFavoriteRead(data.tabs, after.tabs);
        data.sessionAfterGet = after.session;
        return data;
    };
    let currentBrowser = browser, arcifyOptions, spotlightOptions;
    const openOptions = async id => {
        const page = await observePage(await currentBrowser.newPage());
        await page.goto(`chrome-extension://${id}/options.html`, { waitUntil: 'domcontentloaded' });
        const actual = await page.evaluate(() => ({ id: chrome.runtime.id, manifest: chrome.runtime.getManifest(), url: location.href }));
        const expected = expectedExtensions.find(item => item.id === id);
        assert.equal(actual.id, id); assert.equal(actual.url, `chrome-extension://${id}/options.html`);
        assert.equal(actual.manifest.name, expected.name); assert.equal(actual.manifest.version, expected.version);
        return page;
    };
    try {
        for (const [name, callback] of Object.entries({ launch, snapshot, observePage, blockExternalHttps, ui, screenshot, poll, record })) {
            assert.equal(typeof callback, 'function', `${name} fixture helper is required.`);
        }
        assert.deepEqual(expectedExtensions.map(item => item.id).sort(), [arcifyId, spotlightId].sort());
        evidence.existingBeforeSeeds = await read(apiPage);
        const seedPage = readers.get(fixture.windowA);
        assert(seedPage, 'A real window-A Arcify reader is required for seed requests.');
        const initial = await snapshot(fixture.windowA);
        const space = initial.spaces.find(item => item.id === initial.activeSpaceId);
        assert(space?.bookmarkFolderId, 'A real current Space bookmark folder is required for the restart seeds.');
        const sources = await apiPage.evaluate(async ({ parentId, url }) => {
            const one = await chrome.bookmarks.create({ parentId, title: 'Restart Favorite First', url });
            const two = await chrome.bookmarks.create({ parentId, title: 'Restart Favorite Same URL', url });
            return [one, two];
        }, { parentId: space.bookmarkFolderId, url: `${fixture.base}/favorite-browser-restart` });
        const seeded = [];
        for (const source of sources) {
            const added = await request(seedPage, fixture.windowA, 'addBookmark', { spaceId: space.id,
                bookmarkFolderId: space.bookmarkFolderId, bookmarkId: source.id, parentId: source.parentId });
            const favorite = added.favorites.find(item => item.sourceBookmarkId === source.id);
            assert(favorite?.tabId); seeded.push(favorite);
        }
        assert.notEqual(seeded[0].id, seeded[1].id); assert.notEqual(seeded[0].tabId, seeded[1].tabId);
        await request(seedPage, fixture.windowA, 'reorder', { favoriteId: seeded[1].id, beforeId: seeded[0].id });
        const native = await apiPage.evaluate(options => chrome.tabs.create(options), {
            windowId: fixture.windowA, url: sources[0].url, pinned: true, active: false
        });
        await poll(() => apiPage.evaluate(ids => Promise.all(ids.map(id => chrome.tabs.get(id))), [...seeded.map(item => item.tabId), native.id]),
            tabs => tabs.every(tab => tab.status === 'complete' && tab.pinned), 'loaded native restart pin fixtures');
        evidence.faviconTabsBefore = await poll(() => apiPage.evaluate(ids => Promise.all(ids.map(id => chrome.tabs.get(id))), seeded.map(item => item.tabId)),
            tabs => tabs.every(tab => tab.favIconUrl === `${fixture.base}${FAVORITE_FAVICON_PATH}`), 'real localhost restart favicon discovery');
        const beforeSidebar = await pageInWindow(apiPage, fixture.windowA, `chrome-extension://${arcifyId}/sidebar.html`);
        evidence.retainedIconsBefore = [];
        for (const favorite of seeded) evidence.retainedIconsBefore.push(await waitForRetainedFavoriteIcon({
            apiPage, sidebar: beforeSidebar.page, favoriteId: favorite.id, expectedUrl: favorite.url, closed: false, poll }));
        await ui(beforeSidebar.page, 'Inspect captured Favorite icon bytes before full browser restart',
            () => screenshot(beforeSidebar.page, 'saved-favorite-retained-icons-before-browser-restart'));
        await beforeSidebar.page.close();
        evidence.seeded = { favorites: seeded, native, sources: sources.map(sourceIdentity) };
        evidence.before = await read(apiPage);
        const existingIds = new Set(evidence.existingBeforeSeeds.durable.map(item => item.id));
        assert.deepEqual(evidence.before.durable.filter(item => existingIds.has(item.id)), evidence.existingBeforeSeeds.durable, 'Restart seeds must preserve all earlier durable Favorites and their relative order.');
        for (const kind of ['bookmarks', 'parents']) for (const original of evidence.existingBeforeSeeds.sources[kind]) {
            assert.deepEqual(evidence.before.sources[kind].find(item => item.id === original.id), original, 'Restart seeds must preserve earlier source bookmarks and parents.');
        }
        evidence.nativePinsBefore = nativePinContents(evidence.before.tabs);
        const preState = evidence.before.states.find(item => item.windowId === fixture.windowA);
        assert(preState.nativeTabs.some(tab => tab.id === native.id), 'The equal-URL native pin must remain unadopted before restart.');
        assert(!preState.favorites.some(item => item.tabId === native.id));
        assert(evidence.before.session?.bindings?.length > 0, 'Real old-session bindings must exist for invalidation coverage.');
        evidence.registryBefore = await registry(browser);
        assertUnchangedExtensionRegistry(evidence.registryBefore, evidence.registryBefore, expectedExtensions);
        await checkpoint('before-browser-close');

        const restarted = await restartObservedBrowser({ browser, launchOptions,
            launch: async options => {
                validateNamespaceLaunchEnvironment(process.env, process.getuid?.());
                try { evidence.runtime = await inspectInstalledChromeRuntime(CHROME_EXECUTABLE); }
                catch (error) { evidence.runtime = error.chromeRuntimeEvidence; throw error; }
                await checkpoint('restart-runtime-before-launch');
                currentBrowser = await launch(options); return currentBrowser;
            },
            record: async observation => { evidence.restartObservations.push(observation); await checkpoint('browser-restart'); },
            revalidate: async (freshBrowser, context) => {
                const process = freshBrowser.process();
                assert.equal(process.spawnfile, CHROME_EXECUTABLE);
                validateChromeLaunchArguments(process.spawnargs);
                assert.deepEqual(process.spawnargs, context.original.arguments);
                try { evidence.process = await inspectChromeProcessRuntime(process.pid); }
                catch (error) { evidence.process = error.chromeProcessEvidence; throw error; }
                evidence.chromeVersion = await freshBrowser.version(); evidence.userAgent = await freshBrowser.userAgent();
                assert.equal(evidence.chromeVersion, `Chrome/${evidence.runtime.package.browserVersion}`);
                const session = await freshBrowser.target().createCDPSession();
                observeTargetDiagnostics(session, 'restarted-browser', targetEvent);
                await session.send('Target.setDiscoverTargets', { discover: true });
                evidence.protocol = await session.send('Browser.getVersion');
                assert.equal(evidence.protocol.product, evidence.chromeVersion);
                freshBrowser.on('targetcreated', target => {
                    blockExternalHttps(target).catch(error => diagnostic({ type: 'restart-network-blocking', message: error.message }));
                });
                for (const target of freshBrowser.targets()) await blockExternalHttps(target);
                const sandboxPage = await observePage(await freshBrowser.newPage());
                await sandboxPage.goto('chrome://sandbox/', { waitUntil: 'domcontentloaded' });
                await sandboxPage.waitForFunction(() => document.querySelector('#sandbox-status tr') && document.getElementById('evaluation')?.textContent.trim(), { polling: 50 });
                evidence.sandbox = await sandboxPage.evaluate(() => ({ url: location.href, title: document.title, bodyText: document.body.innerText,
                    evaluation: document.getElementById('evaluation')?.textContent || '',
                    rows: [...document.querySelectorAll('#sandbox-status tr')].map(row => {
                        const cells = row.querySelectorAll('td'); return { name: cells[0]?.textContent || '', value: cells[1]?.textContent || '' };
                    }) }));
                await screenshot(sandboxPage, 'restarted-browser-actual-namespace-sandbox');
                await checkpoint('restart-sandbox-observed');
                evidence.sandbox.validation = validateChromeNamespaceSandboxStatus(evidence.sandbox);
                await sandboxPage.close();
                const extensionsPage = await observePage(await freshBrowser.newPage());
                await extensionsPage.goto('chrome://extensions/', { waitUntil: 'domcontentloaded' });
                evidence.developerMode = await poll(async () => {
                    evidence.developerMode = await extensionsPage.evaluate(readDeveloperModeDomState);
                    await checkpoint('restart-developer-mode-observed'); return evidence.developerMode;
                }, developerModeStateReady,
                    'read-only restored Developer-mode state');
                assert.equal(evidence.developerMode.manager.inDevMode, true, 'Developer mode must remain enabled after restart; do not re-enable it.');
                await screenshot(extensionsPage, 'restarted-browser-unchanged-unmanaged-developer-mode');
                evidence.registryAfter = await registry(freshBrowser);
                await checkpoint('restart-registry-observed');
                assertUnchangedExtensionRegistry(evidence.registryBefore, evidence.registryAfter, expectedExtensions);
                await extensionsPage.close();
                // Enabled MV3 workers may be dormant. Wake through the ordinary
                // settings UI only after every strict runtime/policy/registry gate.
                // Reuse these fresh options handles for the rest of the scenario.
                arcifyOptions = await openOptions(arcifyId); spotlightOptions = await openOptions(spotlightId);
                evidence.sessionBeforeUiWake = await arcifyOptions.evaluate(async () => (await chrome.storage.session.get('favoriteSession')).favoriteSession ?? null);
                assert.deepEqual(evidence.sessionBeforeUiWake?.bindings ?? [], [], 'Old-session bindings must already be absent before normal UI wake.');
                assert.deepEqual(evidence.sessionBeforeUiWake?.attempts ?? [], [], 'Old-session receipts must already be absent before normal UI wake.');
                await ui(arcifyOptions, 'Check restored Arcify connection using normal settings UI', async () => {
                    await arcifyOptions.waitForSelector('#bridgeCheck:not([disabled])');
                    await arcifyOptions.click('#bridgeCheck');
                    await arcifyOptions.waitForSelector('#bridgeStatus[data-state="connected"]');
                });
                await ui(spotlightOptions, 'Refresh restored Spotlight connection using normal settings UI', async () => {
                    await spotlightOptions.waitForSelector('#refresh-connection:not([disabled])');
                    await spotlightOptions.click('#refresh-connection');
                    await spotlightOptions.waitForSelector('#connection-status[data-state="connected"]');
                    await screenshot(spotlightOptions, 'restarted-browser-normal-settings-peer-reconnection');
                });
                for (const expected of expectedExtensions) {
                    const url = `chrome-extension://${expected.id}/background.js`;
                    const target = await freshBrowser.waitForTarget(target => target.type() === 'service_worker' && target.url() === url, { timeout: 30_000 });
                    await blockExternalHttps(target);
                    const worker = await target.worker();
                    observeTargetDiagnostics(worker.client, `restarted-worker:${expected.id}`, targetEvent);
                    worker.client.on('Runtime.exceptionThrown', event => evidence.workerExceptions.push({ extensionId: expected.id, ...event.exceptionDetails }));
                    const identity = await waitForExtensionWorkerIdentity(worker, expected.id, async observation => {
                        evidence.workerObservations.push({ extensionId: expected.id, ...observation }); await checkpoint('restart-worker-observed');
                    });
                    assert.equal(identity.manifest.name, expected.name); assert.equal(identity.manifest.version, expected.version);
                    assertNoWorkerExceptions(evidence.workerExceptions);
                }
                assertNoTargetCrashes(evidence.targetLifecycle);
                return { runtime: true, sandbox: true, registry: true };
            }
        });
        evidence.restart = restarted.evidence;
        readers.clear();
        // Discover actual restored windows and pins; never reuse fixture.windowA/B.
        evidence.afterRestart = await read(arcifyOptions);
        evidence.nativePinsAfterRestart = nativePinContents(evidence.afterRestart.tabs);
        await checkpoint('fresh-session-observed');
        assertFavoritesAfterRestart(evidence.before, evidence.afterRestart);
        if (ordinaryFixture) evidence.ordinaryBoundary = assertOrdinaryFavoriteRestartBoundary(evidence.before, evidence.afterRestart, ordinaryFixture);
        const window = [...evidence.afterRestart.states].sort((a, b) => b.nativeTabs.length - a.nativeTabs.length)[0];
        const favoriteId = seeded[0].id;
        // An explicit NEW collision fixture makes no-adoption meaningful even if
        // Chrome restores no pins. This is never presented as a restored tab.
        evidence.postRestartCollisionPin = await arcifyOptions.evaluate(options => chrome.tabs.create(options), {
            windowId: window.windowId, url: seeded[0].url, pinned: true, active: false
        });
        await poll(() => arcifyOptions.evaluate(id => chrome.tabs.get(id), evidence.postRestartCollisionPin.id),
            tab => tab.status === 'complete', 'explicit fresh native URL-collision pin');
        const sidebarUrl = `chrome-extension://${arcifyId}/sidebar.html`;
        const { page: sidebar, tab: sidebarTab } = await pageInWindow(arcifyOptions, window.windowId, sidebarUrl);
        await sidebar.waitForFunction(ids => ids.every(id => [...document.querySelectorAll('#pinnedFavicons .saved-favorite.favorite-closed')]
            .some(node => node.dataset.favoriteId === id && !node.dataset.tabId)), { polling: 50 }, evidence.before.durable.map(item => item.id));
        evidence.beforeClick = await read(arcifyOptions);
        assertFavoritesAfterRestart(evidence.before, evidence.beforeClick);
        assertFreshFavoriteRead(evidence.afterRestart.tabs, evidence.beforeClick.tabs.filter(tab => ![sidebarTab.id, evidence.postRestartCollisionPin.id].includes(tab.id)));
        const currentState = evidence.beforeClick.states.find(state => state.windowId === window.windowId);
        assert(currentState.nativeTabs.some(tab => tab.id === evidence.postRestartCollisionPin.id), 'The deliberate equal-URL native pin must remain separate, without adoption.');
        const renderedState = async state => poll(() => sidebar.evaluate(readFavoriteRender), render => {
            try { assertFavoriteRender(state, render); return true; } catch { return false; }
        }, 'exact saved Favorite order and separate native pin renderer');
        evidence.renderBefore = await renderedState(currentState);
        evidence.retainedIconsAfterRestart = [];
        for (const prior of evidence.retainedIconsBefore) evidence.retainedIconsAfterRestart.push(await waitForRetainedFavoriteIcon({
            apiPage: arcifyOptions, sidebar, favoriteId: prior.record.id, expectedUrl: prior.record.url,
            expectedDataUrl: prior.cacheEntry.faviconDataUrl, closed: true, poll }));
        await ui(sidebar, 'Inspect closed saved Favorites beside restored native pins', () => screenshot(sidebar, 'restarted-saved-favorites-closed-native-pins-separate'));
        await ui(sidebar, 'Reopen one exact durable Favorite after browser restart', async () => {
            const handle = await sidebar.evaluateHandle(id => [...document.querySelectorAll('#pinnedFavicons .saved-favorite')]
                .find(node => node.dataset.favoriteId === id), favoriteId);
            try { assert(handle.asElement()); await handle.asElement().click(); }
            finally { await handle.dispose(); }
        });
        const openedState = await poll(() => request(sidebar, window.windowId, 'get'), state => Number.isSafeInteger(state.favorites.find(item => item.id === favoriteId)?.tabId), 'one exact postrestart Favorite binding');
        const openedId = openedState.favorites.find(item => item.id === favoriteId).tabId;
        await poll(() => arcifyOptions.evaluate(id => chrome.tabs.get(id), openedId), tab => tab.status === 'complete', 'loaded exact postrestart Favorite');
        evidence.afterClick = await read(arcifyOptions);
        evidence.opened = assertFavoriteReopened(evidence.beforeClick, evidence.afterClick, { favoriteId, windowId: window.windowId });
        evidence.renderAfter = await renderedState(evidence.afterClick.states.find(state => state.windowId === window.windowId));
        evidence.retainedIconsAfterClick = [];
        for (const prior of evidence.retainedIconsBefore) evidence.retainedIconsAfterClick.push(await waitForRetainedFavoriteIcon({
            apiPage: arcifyOptions, sidebar, favoriteId: prior.record.id, expectedUrl: prior.record.url, expectedDataUrl: prior.cacheEntry.faviconDataUrl,
            closed: prior.record.id !== favoriteId, poll }));
        await ui(sidebar, 'Capture reopened Favorite and untouched restored pins', async () => {
            await sidebar.waitForFunction(({ favoriteId, tabId }) => [...document.querySelectorAll('#pinnedFavicons .saved-favorite')]
                .some(node => node.dataset.favoriteId === favoriteId && Number(node.dataset.tabId) === tabId && !node.classList.contains('favorite-closed')),
            { polling: 50 }, { favoriteId, tabId: evidence.opened.id });
            await screenshot(sidebar, 'restarted-favorite-explicit-open-preserves-all-existing-tabs');
        });
        assertNoTargetCrashes(evidence.targetLifecycle);
        assertNoWorkerExceptions(evidence.workerExceptions);
        evidence.realSidebarClick = true; evidence.freshGetCreatesTabs = false; evidence.status = 'passed';
        await checkpoint('completed');
        return { evidence, browser: currentBrowser, arcifyOptions, spotlightOptions, windowId: window.windowId };
    } catch (error) {
        evidence.status = 'failed'; evidence.failure = { phase: evidence.phase, message: error.message, stack: error.stack };
        if (error.browserRestartEvidence) evidence.restart = error.browserRestartEvidence;
        try { await checkpoint('failed'); } catch (recordError) { evidence.recordError = recordError.message; }
        error.favoritesRestartEvidence = evidence;
        throw error;
    }
}
