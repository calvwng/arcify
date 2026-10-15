/** Real Chrome orchestration only. Import is safe; no browser is launched here. */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { FAVORITE_FAVICON_PATH, waitForRetainedFavoriteIcon } from './paired-chrome-favorite-icons.mjs';
import { requestScopedFavorite } from './paired-chrome-favorites-restart.mjs';
import { readSpotlightRows } from './paired-chrome-sidebar.mjs';
import { readExpectedXvfbPid, probeNativeCloseTarget, sendOneNativeClose } from './paired-chrome-native-close.mjs';

const sorted = values => [...values].sort((a, b) => a - b);
const nativeIdentity = ({ id, windowId, url, pinned, incognito, groupId }) => ({ id, windowId, url, pinned, incognito, groupId });
const identities = tabs => tabs.map(nativeIdentity).sort((a, b) => a.id - b.id);
const favoriteSelector = id => `#pinnedFavicons .saved-favorite[data-favorite-id="${id}"]`;
const accepts = assertion => value => { try { assertion(value); return true; } catch { return false; } };

// Independent observation encoder: match the documented canonical contract,
// rather than trusting the provider's own fingerprint implementation.
const canonicalOwnership = value => Array.isArray(value) ? value.map(canonicalOwnership)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalOwnership(value[key])])) : value;
export const observedOwnershipFingerprint = session => createHash('sha256').update(JSON.stringify(canonicalOwnership(session))).digest('hex');

/** Persist only ownership IDs, key order and opaque receipts; omit links/icons. */
export function summarizeFavoriteOwnership({ session, receipt, continuity }) {
    const summarizeReceipt = value => value ? Object.fromEntries(['version', 'schema', 'phase', 'epoch', 'revision', 'peerId', 'generation', 'peerGeneration', 'fingerprint']
        .filter(key => value[key] !== undefined).map(key => [key, value[key]])) : null;
    const entries = values => (values || []).map(value => ({ keys: Object.keys(value), ...Object.fromEntries(['favoriteId', 'windowId', 'tabId', 'mode', 'kind']
        .filter(key => value[key] !== undefined).map(key => [key, value[key]])) }));
    return { session: session ? { version: session.version, keys: Object.keys(session), bindings: entries(session.bindings), attempts: entries(session.attempts),
        rawFingerprint: createHash('sha256').update(JSON.stringify(session)).digest('hex'), canonicalFingerprint: observedOwnershipFingerprint(session) } : null,
        receipt: summarizeReceipt(receipt), mirror: summarizeReceipt(continuity) };
}

/** Call before the generic localhost response; a genuine document supplies the nonce/title/icon. */
export function serveOrdinaryFavoriteFixture(request, response) {
    const path = new URL(request.url, 'http://127.0.0.1').pathname;
    const match = /^\/favorite-(ordinary|legacy)\/([a-f0-9]{32})$/.exec(path);
    if (!match) return false;
    const title = `${match[1] === 'ordinary' ? 'Ordinary' : 'Legacy'} Favorite ${match[2]}`;
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><link rel="icon" type="image/png" sizes="32x32" href="${FAVORITE_FAVICON_PATH}"></head><body><h1>${title}</h1><p>One native Ctrl+W closes this real fixture page while its saved Favorite remains.</p></body></html>`);
    return true;
}

export function readOrdinaryFavoriteRender(favoriteId) {
    const matches = [...document.querySelectorAll('#pinnedFavicons .saved-favorite')].filter(node => node.dataset.favoriteId === favoriteId);
    const tabId = matches[0]?.dataset.tabId ? Number(matches[0].dataset.tabId) : null;
    return { favoriteId, matches: matches.length, tabId, closed: matches[0]?.classList.contains('favorite-closed'),
        nativeDuplicates: tabId === null ? [] : [...document.querySelectorAll('#pinnedFavicons .native-favorite')].filter(node => Number(node.dataset.tabId) === tabId).map(node => Number(node.dataset.tabId)),
        spaceDuplicates: tabId === null ? [] : [...document.querySelectorAll('#spacesList [data-tab-id]')].filter(node => Number(node.dataset.tabId) === tabId).map(node => Number(node.dataset.tabId)) };
}

/** Pure exact-ID validator; no URL matching is used to infer ownership. */
export function assertOrdinaryFavoriteState(state, { favoriteId, tabId, windowId, url, activeSpaceId, active = undefined }) {
    const favorites = state.favorites.filter(item => item.id === favoriteId);
    assert.equal(favorites.length, 1, 'One exact saved Favorite must remain');
    assert.equal(favorites[0].tabId, tabId, 'Saved ownership must name the exact native tab');
    const tabs = state.tabs.filter(tab => tab.id === tabId);
    assert.equal(tabs.length, 1, 'The exact native Favorite tab must remain open');
    const tab = tabs[0];
    assert.equal(tab.windowId, windowId); assert.equal(tab.pinned, false); assert.equal(tab.incognito, false);
    assert.equal(tab.url, url); assert.equal(tab.groupId, -1, 'Global ordinary Favorite must stay outside Space groups');
    if (active !== undefined) assert.equal(tab.active, active);
    assert.deepEqual(state.tabs.filter(item => item.url === url).map(item => item.id), [tabId], 'Unique fixture URL must have no duplicate tab');
    const bindings = state.session.bindings.filter(item => item.favoriteId === favoriteId && item.windowId === windowId);
    assert.deepEqual(bindings, [{ favoriteId, windowId, tabId, mode: 'ordinary' }]);
    assert.deepEqual(state.session.attempts.filter(item => item.favoriteId === favoriteId && item.windowId === windowId), []);
    const snapshotFavorite = state.snapshot.favorites.filter(item => item.id === favoriteId);
    assert.equal(snapshotFavorite.length, 1); assert.equal(snapshotFavorite[0].tabId, tabId);
    const projected = state.snapshot.tabs.filter(item => item.id === tabId);
    assert.equal(projected.length, 1); assert.equal(projected[0].spaceId, null, 'Global Favorite has no Space owner');
    for (const space of state.snapshot.spaces) for (const key of ['tabIds', 'pinnedTabIds', 'temporaryTabIds']) {
        assert(!space[key].includes(tabId), `Global Favorite leaked into ${space.id}.${key}`);
    }
    if (activeSpaceId !== undefined) assert.equal(state.snapshot.activeSpaceId, activeSpaceId);
    if (state.render) {
        assert.equal(state.render.favoriteId, favoriteId); assert.equal(state.render.matches, 1);
        assert.equal(state.render.tabId, tabId); assert.equal(state.render.closed, false);
        assert.deepEqual(state.render.nativeDuplicates, []); assert.deepEqual(state.render.spaceDuplicates, []);
    }
    return tab;
}

/** Browser outcome, independent of whether the input transport returned success. */
export function assertOnlyNativeFavoriteClosed(before, after, { favoriteId, tabId, windowId, targetId }) {
    assert.deepEqual(sorted(after.tabs.map(tab => tab.id)), sorted(before.tabs.filter(tab => tab.id !== tabId).map(tab => tab.id)),
        'One native chord must close exactly the intended tab across all windows');
    assert.deepEqual(identities(after.tabs), identities(before.tabs.filter(tab => tab.id !== tabId)), 'No unrelated tab may move, navigate, pin or regroup');
    assert.deepEqual(after.removed.map(({ tabId: id, windowId: window, isWindowClosing }) => ({ tabId: id, windowId: window, isWindowClosing })),
        [{ tabId, windowId, isWindowClosing: false }], 'Exactly one real onRemoved event is required');
    assert.deepEqual(after.destroyedPageTargets, [targetId], 'Exactly the real page target must be destroyed');
    assert(!after.rawTargets.some(target => target.targetId === targetId), 'The original raw target must actually be gone');
    assert.equal(after.favorites.filter(item => item.id === favoriteId).length, 1);
    assert.equal(after.favorites.find(item => item.id === favoriteId).tabId, null);
    assert(!after.session.bindings.some(item => item.favoriteId === favoriteId && item.windowId === windowId));
    assert.deepEqual(after.durable, before.durable, 'Native close preserves all four-key saved records');
    assert.deepEqual(after.iconCache, before.iconCache, 'Native close preserves exact retained icon ownership and bytes');
    assert.deepEqual(after.sources, before.sources, 'Native close preserves original source bookmarks');
}

export function assertOrdinaryFavoriteReopened(before, after, { favoriteId, previousTabId, windowId, url }) {
    const additions = after.tabs.filter(tab => !before.tabs.some(prior => prior.id === tab.id));
    assert.equal(additions.length, 1, 'One real Favorite click creates one replacement tab');
    assert.notEqual(additions[0].id, previousTabId, 'Reopen requires a new native tab identity');
    assert.equal(after.tabs.length, before.tabs.length + 1);
    assert.deepEqual(identities(after.tabs.filter(tab => tab.id !== additions[0].id)), identities(before.tabs));
    assert.deepEqual(after.durable, before.durable); assert.deepEqual(after.iconCache, before.iconCache); assert.deepEqual(after.sources, before.sources);
    return assertOrdinaryFavoriteState(after, { favoriteId, tabId: additions[0].id, windowId, url, active: true });
}

/** The mirror is recoverable only with an exact, independently retained peer receipt. */
export function assertCommittedFavoriteWitness(state, { arcifyId, spotlightId }) {
    const { continuity: journal, receipt, witness, session, durable } = state;
    assert.equal(journal?.version, 1); assert.equal(journal?.schema, 'exact-global-favorites-v2');
    assert.equal(journal.phase, 'committed'); assert.equal(journal.peerId, spotlightId);
    assert.equal(typeof journal.epoch, 'string'); assert(journal.epoch.length > 0);
    assert.equal(typeof journal.generation, 'string'); assert(journal.generation.length > 0);
    assert(Number.isSafeInteger(journal.revision) && journal.revision > 0);
    assert.equal(journal.fingerprint, observedOwnershipFingerprint(session));
    assert.deepEqual(journal.state, session);
    assert.deepEqual(journal.items, durable.map(({ id, url, sourceBookmarkId }) => [id, url, sourceBookmarkId]));
    for (const key of ['version', 'schema', 'epoch', 'revision', 'peerId', 'generation', 'fingerprint']) assert.equal(receipt?.[key], journal[key], `Own receipt ${key}`);
    assert(receipt.phase === undefined || receipt.phase === 'committed', 'An unfinished recovery receipt cannot prove ownership');
    assert.equal(witness?.version, 1); assert.equal(witness.peerId, arcifyId);
    assert.equal(witness.epoch, journal.epoch); assert.equal(witness.revision, journal.revision);
    assert.equal(witness.writerGeneration, journal.generation);
    assert.equal(typeof witness.peerGeneration, 'string'); assert(witness.peerGeneration.length > 0);
    assert.equal(journal.peerGeneration, witness.peerGeneration);
    return journal;
}

export function assertSameBrowserFavoriteContinuity(before, after, ids, { requireNewRevision = true } = {}) {
    const previous = assertCommittedFavoriteWitness(before, ids), current = assertCommittedFavoriteWitness(after, ids);
    assert.equal(current.epoch, previous.epoch, 'Same-browser extension reload must retain the proven session epoch');
    assert.equal(current.generation, previous.generation, 'Reload must not alter pairing identity');
    assert(requireNewRevision ? current.revision > previous.revision : current.revision >= previous.revision, 'Reload recovery must acknowledge the current exact ownership revision');
    assert.deepEqual(after.session, before.session, 'Every exact binding and pending receipt must survive the witnessed reload');
    assert.deepEqual(after.durable, before.durable); assert.deepEqual(after.iconCache, before.iconCache); assert.deepEqual(after.sources, before.sources);
    const web = tabs => tabs.filter(tab => /^https?:/.test(tab.url || ''));
    assert.deepEqual(identities(web(after.tabs)), identities(web(before.tabs)), 'Reload cannot adopt, duplicate, close or alter existing web tabs');
}

/**
 * Main owns actual launch and strict reload lifecycle. Callbacks return
 * { evidence, arcifyOptions, spotlightOptions }; no runtime.reload shortcuts here.
 * Keep returned evidence plain JSON. The saved ordinary Favorite is intentionally
 * left for the existing full-process restart case's no-adoption checks.
 */
export async function exerciseOrdinaryFavorites({ browser, apiPage, spotlightApiPage, newTabPage, pageForUrl,
    ui, screenshot, snapshot, poll, fixture, arcifyId, spotlightId, search, reloadArcify, reloadSpotlight,
    record = async () => {}, nativeInput = { readExpectedXvfbPid, probeNativeCloseTarget, sendOneNativeClose } }) {
    assert.equal(typeof reloadArcify, 'function', 'Strict main-owned Arcify reload proof is required');
    assert.equal(typeof reloadSpotlight, 'function', 'Strict main-owned Spotlight reload proof is required');
    const nonce = randomBytes(16).toString('hex'), windowId = fixture.windowA;
    const evidence = { nonce, realMouse: true, nativeInput: 'XTEST Ctrl+W on CI Xvfb; physical hardware not asserted',
        surface: 'regular sidebar.html tab', checkpoints: [], crossSpace: [], reloads: [] };
    const checkpoint = async (phase, observation = {}) => { evidence.checkpoints.push({ phase, ...observation }); await record(structuredClone(evidence)); };
    const sideUrl = `chrome-extension://${arcifyId}/sidebar.html`;
    let sidebar = await newTabPage(sideUrl, windowId), cdp, removalKey, removeListener;
    const sidebars = [sidebar.tab.id], sources = [];
    const get = () => requestScopedFavorite(sidebar.page, windowId, 'get');
    const tabs = () => apiPage.evaluate(() => chrome.tabs.query({}));
    const tab = id => apiPage.evaluate(id => chrome.tabs.get(id), id);
    const settings = () => apiPage.evaluate(() => chrome.storage.sync.get(['ordinaryFavoriteTabs', 'syncTabGroups']));
    const originalSettings = await settings(), originalSnapshot = await snapshot(windowId);
    assert.equal(originalSettings.ordinaryFavoriteTabs ?? false, false, 'The fixture starts in the product default pinned mode');
    const space = originalSnapshot.spaces.find(item => item.id === originalSnapshot.activeSpaceId);
    assert(space?.bookmarkFolderId); assert.notEqual(fixture.spaces.work, fixture.spaces.personal);
    const read = async (favoriteId, includeWitness = false) => {
        const projected = await get(), snap = await snapshot(windowId);
        const values = await apiPage.evaluate(async sourceIds => {
            const local = await chrome.storage.local.get(['persistentFavorites', 'favoriteIconCache', 'favoriteContinuity']);
            const session = await chrome.storage.session.get(['favoriteSession', 'favoriteContinuityReceipt']);
            const sources = await Promise.all(sourceIds.map(async id => {
                const [node] = await chrome.bookmarks.get(id);
                return { id: node.id, parentId: node.parentId, index: node.index, title: node.title, url: node.url };
            }));
            return { durable: local.persistentFavorites, iconCache: local.favoriteIconCache ?? null, continuity: local.favoriteContinuity,
                session: session.favoriteSession, receipt: session.favoriteContinuityReceipt, tabs: await chrome.tabs.query({}), sources };
        }, sources.map(source => source.id));
        return { ...values, favorites: projected.favorites, snapshot: snap,
            ...(favoriteId ? { render: await sidebar.page.evaluate(readOrdinaryFavoriteRender, favoriteId) } : {}),
            ...(includeWitness ? { witness: await spotlightApiPage.evaluate(async () => (await chrome.storage.session.get('arcifyFavoriteWitness')).arcifyFavoriteWitness) } : {}) };
    };
    const toggle = async (id, checked) => {
        await ui(apiPage, `Set ${id} to ${checked} with real options input`, async () => {
            await apiPage.waitForSelector(`#${id}`);
            if (await apiPage.$eval(`#${id}`, element => element.checked) !== checked) {
                await apiPage.click(`label.toggle-label[for="${id}"]`);
            }
            assert.equal(await apiPage.$eval(`#${id}`, element => element.checked), checked);
        });
        await poll(settings, values => (values[id] ?? false) === checked, `${id} persisted after real input`);
    };
    const seed = async mode => {
        const source = await apiPage.evaluate(async ({ parentId, mode, nonce, base }) => {
            const node = await chrome.bookmarks.create({ parentId, title: `${mode === 'ordinary' ? 'Ordinary' : 'Legacy'} Favorite ${nonce}`, url: `${base}/favorite-${mode}/${nonce}` });
            return { id: node.id, parentId: node.parentId, index: node.index, title: node.title, url: node.url };
        }, { parentId: space.bookmarkFolderId, mode, nonce: mode === 'ordinary' ? nonce : randomBytes(16).toString('hex'), base: fixture.base });
        sources.push(source);
        const result = await requestScopedFavorite(sidebar.page, windowId, 'addBookmark', { spaceId: space.id,
            bookmarkFolderId: space.bookmarkFolderId, bookmarkId: source.id, parentId: source.parentId });
        const matches = result.favorites.filter(item => item.sourceBookmarkId === source.id);
        assert.equal(matches.length, 1); assert(Number.isSafeInteger(matches[0].tabId));
        await poll(() => tab(matches[0].tabId), item => item.status === 'complete' && item.url === source.url, `${mode} Favorite real page loaded`);
        return { source, favorite: matches[0] };
    };
    const clickFavorite = favoriteId => ui(sidebar.page, 'Click exact ordinary saved Favorite', async () => {
        await sidebar.page.waitForSelector(favoriteSelector(favoriteId)); await sidebar.page.click(favoriteSelector(favoriteId));
    });
    const icon = (favoriteId, closed, expectedDataUrl) => waitForRetainedFavoriteIcon({ apiPage, sidebar: sidebar.page,
        favoriteId, expectedUrl: sources.find(source => source.url.includes('/favorite-ordinary/')).url, closed, expectedDataUrl, poll });
    try {
        const legacy = await seed('legacy'); evidence.legacy = legacy;
        const legacyInitial = await tab(legacy.favorite.tabId); assert.equal(legacyInitial.pinned, true);
        const beforeToggle = await read();
        const legacyBinding = beforeToggle.session.bindings.find(item => item.favoriteId === legacy.favorite.id && item.windowId === windowId);
        assert.deepEqual(legacyBinding, { favoriteId: legacy.favorite.id, windowId, tabId: legacy.favorite.tabId });
        await toggle('ordinaryFavoriteTabs', true);
        assert.deepEqual(nativeIdentity(await tab(legacy.favorite.tabId)), nativeIdentity(legacyInitial), 'Opt-in must not unpin or replace an existing legacy Favorite');
        const ordinary = await seed('ordinary'), { favorite, source } = ordinary; evidence.ordinary = ordinary;
        const initial = await poll(() => read(favorite.id), accepts(value => assertOrdinaryFavoriteState(value,
            { favoriteId: favorite.id, tabId: favorite.tabId, windowId, url: source.url, active: false })), 'exact newly opted-in ordinary Favorite');
        assert.deepEqual(initial.session.bindings.find(item => item.favoriteId === legacy.favorite.id && item.windowId === windowId), legacyBinding, 'Opt-in preserves the existing legacy binding mode');
        const retainedBefore = await icon(favorite.id, false);
        evidence.initial = initial; evidence.retainedBefore = retainedBefore;
        await checkpoint('prospective-opt-in', { legacyBefore: legacyInitial, legacyAfter: await tab(legacy.favorite.tabId) });

        // Observe BOTH extension-level native removal and independent browser raw
        // target destruction before any accelerator input. Neither observer closes.
        removalKey = `__arcifyOrdinaryClose_${nonce}`;
        await apiPage.evaluate(key => {
            if (globalThis[key]) throw new Error('Removal observer already exists');
            const events = [];
            const listener = (tabId, info) => events.push({ tabId, windowId: info.windowId, isWindowClosing: info.isWindowClosing });
            globalThis[key] = { events, listener }; chrome.tabs.onRemoved.addListener(listener);
        }, removalKey);
        cdp = await browser.target().createCDPSession();
        const destroyed = [], knownPageTargets = new Set();
        removeListener = event => { if (knownPageTargets.has(event.targetId)) destroyed.push(event.targetId); };
        cdp.on('Target.targetDestroyed', removeListener);
        await cdp.send('Target.setDiscoverTargets', { discover: true });
        const rawBefore = (await cdp.send('Target.getTargets')).targetInfos;
        rawBefore.filter(target => target.type === 'page').forEach(target => knownPageTargets.add(target.targetId));
        const targetMatches = rawBefore.filter(target => target.type === 'page' && target.url === source.url);
        assert.equal(targetMatches.length, 1, 'The nonce URL identifies one real raw page target');
        const targetId = targetMatches[0].targetId;
        const sourcePage = await pageForUrl(source.url);
        const pageSession = await sourcePage.createCDPSession();
        try { assert.equal((await pageSession.send('Target.getTargetInfo')).targetInfo.targetId, targetId); }
        finally { await pageSession.detach(); }
        let closeBefore;
        await ui(sourcePage, 'Close exact active ordinary Favorite using one native Ctrl+W', async () => {
            await sourcePage.click('h1'); // Genuine document focus, with no synthetic keyboard/page title.
            const documentState = await sourcePage.evaluate(() => ({ title: document.title, visibility: document.visibilityState, focused: document.hasFocus() }));
            assert.equal(documentState.title, source.title); assert.equal(documentState.visibility, 'visible'); assert.equal(documentState.focused, true);
            closeBefore = await read(favorite.id);
            assertOrdinaryFavoriteState(closeBefore, { favoriteId: favorite.id, tabId: favorite.tabId, windowId, url: source.url, active: true });
            const xvfbPid = await nativeInput.readExpectedXvfbPid(process.env.DISPLAY);
            const probe = await nativeInput.probeNativeCloseTarget({ display: process.env.DISPLAY, xvfbPid, chromePid: browser.process().pid, nonce });
            evidence.nativeProbe = probe.evidence; evidence.documentBeforeClose = documentState;
            await checkpoint('native-probe-armed', { targetId, nativeTabId: favorite.tabId });
            const current = await tab(favorite.tabId);
            assert.equal(current.windowId, windowId); assert.equal(current.pinned, false); assert.equal(current.active, true); assert.equal(current.url, source.url);
            assert.deepEqual(await sourcePage.evaluate(() => ({ title: document.title, visibility: document.visibilityState, focused: document.hasFocus() })), documentState);
            try { evidence.nativeSend = await nativeInput.sendOneNativeClose(probe); }
            catch (error) { evidence.nativeFailure = { message: error.message, uncertain: error.nativeCloseUncertain,
                evidence: error.nativeCloseEvidence || null, stderr: error.stderr || '' }; await checkpoint('native-input-failed'); throw error; }
        });
        const closed = await poll(async () => ({ ...await read(favorite.id),
            removed: await apiPage.evaluate(key => globalThis[key].events, removalKey),
            destroyedPageTargets: [...destroyed], rawTargets: (await cdp.send('Target.getTargets')).targetInfos }),
        value => !value.tabs.some(item => item.id === favorite.tabId)
            && value.favorites.find(item => item.id === favorite.id)?.tabId === null
            && value.removed.some(event => event.tabId === favorite.tabId) && value.destroyedPageTargets.includes(targetId), 'independent native tab removal and exact raw target destruction');
        assertOnlyNativeFavoriteClosed(closeBefore, closed, { favoriteId: favorite.id, tabId: favorite.tabId, windowId, targetId });
        evidence.closed = closed;
        const retainedClosed = await icon(favorite.id, true, retainedBefore.cacheEntry.faviconDataUrl);
        assert.deepEqual(retainedClosed.record, retainedBefore.record); assert.deepEqual(retainedClosed.cacheEntry, retainedBefore.cacheEntry);
        evidence.retainedClosed = retainedClosed;
        await checkpoint('one-native-tab-closed-saved-record-and-icon-retained');
        await ui(sidebar.page, 'Inspect closed ordinary Favorite', () => screenshot(sidebar.page, 'ordinary-favorite-after-native-ctrl-w'));
        await apiPage.evaluate(key => { chrome.tabs.onRemoved.removeListener(globalThis[key].listener); delete globalThis[key]; }, removalKey);
        removalKey = null;
        cdp.off('Target.targetDestroyed', removeListener); await cdp.detach(); cdp = null;

        await clickFavorite(favorite.id);
        const reopened = await poll(() => read(favorite.id), accepts(value => {
            const current = assertOrdinaryFavoriteReopened(closed, value, { favoriteId: favorite.id, previousTabId: favorite.tabId, windowId, url: source.url });
            assert.equal(current.status, 'complete');
        }), 'real Favorite click reopens an ordinary native tab');
        const reopenedTab = assertOrdinaryFavoriteReopened(closed, reopened, { favoriteId: favorite.id, previousTabId: favorite.tabId, windowId, url: source.url });
        evidence.reopened = reopened; evidence.reopenedTabId = reopenedTab.id;
        const retainedReopened = await icon(favorite.id, false, retainedBefore.cacheEntry.faviconDataUrl);
        assert.deepEqual(retainedReopened.record, retainedBefore.record); assert.deepEqual(retainedReopened.cacheEntry, retainedBefore.cacheEntry);
        await checkpoint('real-click-reopened-new-unpinned-tab');

        // Real Space clicks and real options clicks, with the same live global
        // Favorite ID/tab across both modes. No reassignment or URL-based adoption.
        for (const sync of [false, true]) {
            await toggle('syncTabGroups', sync);
            if (sync) {
                const projected = await poll(async () => {
                    const native = await Promise.all([tab(fixture.sourceA), tab(fixture.alpha)]);
                    return { native, groups: await apiPage.evaluate(windowId => chrome.tabGroups.query({ windowId }), windowId) };
                }, value => value.native.every(item => item.groupId >= 0 && value.groups.some(group => group.id === item.groupId))
                    && value.native[0].groupId !== value.native[1].groupId, 'real native group projection for both ordinary Spaces');
                evidence.spaceGroupsEnabled = projected;
            }
            for (const spaceId of [fixture.spaces.work, fixture.spaces.personal]) {
                await ui(sidebar.page, 'Switch Space with real sidebar input', async () => {
                    const selector = `#spaceSwitcher button[data-space-id="${spaceId}"]`;
                    await sidebar.page.waitForSelector(selector); await sidebar.page.click(selector);
                });
                await poll(() => snapshot(windowId), value => value.activeSpaceId === spaceId, 'selected logical Space');
                const before = await read(favorite.id);
                await clickFavorite(favorite.id);
                const after = await poll(() => read(favorite.id), accepts(value => assertOrdinaryFavoriteState(value,
                    { favoriteId: favorite.id, tabId: reopenedTab.id, windowId, url: source.url, activeSpaceId: spaceId, active: true })), 'global Favorite reuses exact tab without taking Space ownership');
                assert.deepEqual(identities(after.tabs), identities(before.tabs));
                assert.deepEqual(after.durable, reopened.durable); assert.deepEqual(after.sources, sources);
                const proof = { sync, spaceId, favoriteId: favorite.id, tabId: reopenedTab.id,
                    snapshot: after.snapshot, session: after.session, render: after.render, nativeTab: after.tabs.find(item => item.id === reopenedTab.id) };
                evidence.crossSpace.push(proof); await checkpoint('same-global-tab-across-space', { sync, spaceId });
            }
        }

        const helper = await newTabPage(`chrome-extension://${spotlightId}/newtab.html`, windowId);
        await search(helper.page, source.title);
        const resultSelector = `[data-result-type="arcify-favorite"][data-favorite-id="${favorite.id}"]`;
        await helper.page.waitForSelector(resultSelector);
        const rows = await helper.page.evaluate(readSpotlightRows);
        assert.equal(rows.filter(row => row.type === 'arcify-favorite' && row.favoriteId === favorite.id).length, 1);
        assert(rows.some(row => row.type === 'bookmark' && row.title === source.title), 'Original source remains independently searchable');
        const searchBefore = await read(favorite.id);
        await ui(helper.page, 'Select exact ordinary Favorite from paired Spotlight', () => helper.page.click(resultSelector));
        const searchAfter = await poll(() => read(favorite.id), value => !value.tabs.some(item => item.id === helper.tab.id)
            && value.tabs.some(item => item.id === reopenedTab.id && item.active), 'Spotlight activates existing exact ordinary Favorite and closes its helper');
        assertOrdinaryFavoriteState(searchAfter, { favoriteId: favorite.id, tabId: reopenedTab.id, windowId, url: source.url,
            activeSpaceId: searchBefore.snapshot.activeSpaceId, active: true });
        assert.deepEqual(identities(searchAfter.tabs), identities(searchBefore.tabs.filter(item => item.id !== helper.tab.id)));
        evidence.search = { rows, favoriteId: favorite.id, tabId: reopenedTab.id, before: searchBefore.snapshot, after: searchAfter.snapshot };
        await checkpoint('paired-spotlight-reuses-same-global-reference');

        const ids = { arcifyId, spotlightId };
        for (const [name, reload] of [['arcify', reloadArcify], ['spotlight', reloadSpotlight]]) {
            const before = await poll(() => read(favorite.id, true), accepts(value => assertCommittedFavoriteWitness(value, ids)), `committed reciprocal witness before ${name} reload`);
            const lifecycle = await reload();
            assert(lifecycle?.evidence && lifecycle.arcifyOptions && lifecycle.spotlightOptions, 'Reload callback must supply strict raw lifecycle evidence and fresh API contexts');
            apiPage = lifecycle.arcifyOptions; spotlightApiPage = lifecycle.spotlightOptions;
            if (name === 'arcify') { sidebar = await newTabPage(sideUrl, windowId); sidebars.push(sidebar.tab.id); }
            const after = await poll(() => read(favorite.id, true), accepts(value => {
                assertCommittedFavoriteWitness(value, ids);
                assertOrdinaryFavoriteState(value, { favoriteId: favorite.id, tabId: reopenedTab.id, windowId, url: source.url });
            }), `same exact ordinary Favorite binding after ${name} reload`);
            assertSameBrowserFavoriteContinuity(before, after, ids, { requireNewRevision: name === 'arcify' });
            const retained = await icon(favorite.id, false, retainedBefore.cacheEntry.faviconDataUrl);
            assert.deepEqual(retained.record, retainedBefore.record); assert.deepEqual(retained.cacheEntry, retainedBefore.cacheEntry);
            evidence.reloads.push({ name, lifecycle: lifecycle.evidence, before, after, retained });
            await checkpoint('same-browser-reload-continuity', { name, favoriteId: favorite.id, tabId: reopenedTab.id });
        }
        await toggle('ordinaryFavoriteTabs', false);
        const afterDisable = await read(favorite.id);
        assertOrdinaryFavoriteState(afterDisable, { favoriteId: favorite.id, tabId: reopenedTab.id, windowId, url: source.url });
        assert.deepEqual(nativeIdentity(await tab(legacy.favorite.tabId)), nativeIdentity(legacyInitial));
        await toggle('syncTabGroups', originalSettings.syncTabGroups ?? false);
        await ui(sidebar.page, 'Restore original selected Space', () => sidebar.page.click(`#spaceSwitcher button[data-space-id="${originalSnapshot.activeSpaceId}"]`));
        await poll(() => snapshot(windowId), value => value.activeSpaceId === originalSnapshot.activeSpaceId, 'original selected Space restored');
        evidence.restartFixture = { favoriteId: favorite.id, tabId: reopenedTab.id };
        evidence.final = await read(favorite.id, true);
        assert.deepEqual(evidence.final.session.bindings.find(item => item.favoriteId === legacy.favorite.id && item.windowId === windowId), legacyBinding);
        assertOrdinaryFavoriteState(evidence.final, { favoriteId: favorite.id, tabId: reopenedTab.id, windowId, url: source.url });
        assert.deepEqual(evidence.final.sources, sources);
        await ui(sidebar.page, 'Capture retained global Favorite after both extension reloads', () => screenshot(sidebar.page, 'ordinary-favorite-global-after-extension-reloads'));
        await checkpoint('ordinary-mode-off-is-prospective-existing-live-binding-retained');
        // Only dedicated fixture sidebar surfaces are cleaned up. The ordinary
        // Favorite is never closed through tabs.remove, including failure paths.
        await apiPage.evaluate(async ({ ids, url }) => {
            const tabs = await chrome.tabs.query({});
            const exact = tabs.filter(tab => ids.includes(tab.id) && tab.url === url).map(tab => tab.id);
            if (exact.length) await chrome.tabs.remove(exact);
        }, { ids: sidebars, url: sideUrl });
        return evidence;
    } catch (error) {
        evidence.failure = { message: error.message, stack: error.stack };
        await checkpoint('failed-without-native-input-retry').catch(() => {});
        throw error;
    } finally {
        if (removalKey) await apiPage.evaluate(key => {
            const trace = globalThis[key]; if (trace) chrome.tabs.onRemoved.removeListener(trace.listener); delete globalThis[key];
        }, removalKey).catch(() => {});
        if (cdp) { if (removeListener) cdp.off('Target.targetDestroyed', removeListener); await cdp.detach().catch(() => {}); }
    }
}
