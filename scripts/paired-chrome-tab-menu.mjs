/** CI-only real paired Chrome exercise. Importing this module never launches Chrome. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { saveWithFreshStaleNotice } from './paired-chrome-stale-notice.mjs';
import { replaceInputText, captureVisibleFailurePage, clickFreshResult } from './paired-chrome-ui.mjs';
import { readSpotlightRows } from './paired-chrome-sidebar.mjs';
import { finishBookmarkFixture } from './paired-chrome-bookmark-selection.mjs';
import { exerciseExternalMenuDismissal, readMenuPreservedState } from './paired-chrome-menu-focus.mjs';

export function assertTabMenuFixtureEnvironment(env = process.env, uid = process.getuid?.()) {
    assert.equal(env.GITHUB_ACTIONS, 'true', 'The real tab-menu fixture is restricted to GitHub Actions.');
    assert.equal(env.CI, 'true', 'The real tab-menu fixture requires its dedicated CI runner.');
    assert.notEqual(uid, 0, 'The tab-menu fixture never disables the native Chrome sandbox for root.');
}

/** Register before the generic localhost response in the parent fixture server. */
export function serveTabMenuFixture(request, response) {
    const match = /^\/tab-menu\/([a-f0-9]{32})\/(ordinary|pin|away|edited|stale|outside)$/.exec(new URL(request.url, 'http://127.0.0.1').pathname);
    if (!match) return false;
    const title = `Tab Menu ${match[2]} ${match[1]}`, documentId = randomBytes(16).toString('hex');
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:" });
    response.end(`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><link rel="icon" href="data:,"></head><body data-document-id="${documentId}" style="font:20px system-ui;padding:40px"><h1>${title}</h1><label for="page-state">Preserved page state</label><input id="page-state" value="untouched"><p>Every real navigation receives a new document identity.</p></body></html>`);
    return true;
}

const sorted = values => [...values].sort((a, b) => a - b);
const without = (map, ids) => Object.fromEntries(Object.entries(map || {}).filter(([id]) => !ids.includes(Number(id))));
const tabIdentity = ({ id, windowId, url, pendingUrl, title, pinned, incognito, groupId, muted }) => ({ id, windowId, url, pendingUrl, title, pinned, incognito, groupId, muted });
const same = (before, after, fields) => { for (const key of fields) assert.deepEqual(after[key], before[key], `${key} changed outside the requested action.`); };
const findTab = (state, id) => { const tabs = state.tabs.filter(tab => tab.id === id); assert.equal(tabs.length, 1, `Expected exact live tab ${id}.`); return tabs[0]; };
const findBookmark = (state, id) => { const nodes = state.bookmarks.filter(node => node.id === id); assert.equal(nodes.length, 1, `Expected exact bookmark ${id}.`); return nodes[0]; };
const findSpace = (state, id) => { const spaces = state.spaces.filter(space => space.id === id); assert.equal(spaces.length, 1); return spaces[0]; };

export function assertTabMenuClosedTargetGone(state, tabId) {
    assert.equal(state.tabs.some(tab => tab.id === tabId), false, 'The native tab must actually be closed.');
    assert.equal(state.snapshot.tabs.some(tab => tab.id === tabId), false, 'The real bridge must no longer project the closed tab.');
    for (const space of state.spaces) for (const section of ['temporaryTabs', 'spaceBookmarks']) assert(!space[section].includes(tabId), 'Close cleanup must settle in every Space before comparing a stale action.');
    assert.equal(state.aliases[tabId], undefined); assert.equal(state.bindings[tabId], undefined);
}

export function assertTabMenuCancelled(before, after) {
    same(before, after, ['tabs', 'bookmarks', 'spaces', 'bindings', 'aliases', 'favorites', 'activeSpaceId', 'pageStates']);
}

export function assertTabMenuAlias(before, after, { tabId, alias, twinId }) {
    same(before, after, ['tabs', 'bookmarks', 'spaces', 'bindings', 'favorites', 'activeSpaceId', 'pageStates']);
    const source = findTab(before, tabId), twin = findTab(before, twinId);
    assert.notEqual(tabId, twinId); assert.equal(source.url, twin.url, 'The alias test needs equal-URL distinct identities.');
    assert.equal(after.aliases[tabId]?.name, alias); assert.deepEqual(without(after.aliases, [tabId]), without(before.aliases, [tabId]));
    const projected = after.snapshot.tabs.filter(tab => tab.id === tabId); assert.equal(projected.length, 1); assert.equal(projected[0].title, alias);
    assert.equal(after.snapshot.tabs.find(tab => tab.id === twinId)?.title, before.snapshot.tabs.find(tab => tab.id === twinId)?.title, 'A same-URL twin cannot inherit an alias.');
}

export function assertTabMenuSavedEdit(before, after, { bookmarkId, field, value, spaceId }) {
    assert(['title', 'url'].includes(field));
    same(before, after, ['tabs', 'spaces', 'favorites', 'activeSpaceId', 'pageStates']);
    const original = findBookmark(before, bookmarkId), changed = findBookmark(after, bookmarkId);
    assert.deepEqual(changed, { ...original, [field]: value }, 'Saved edit changes one field on the same ID, parent and index.');
    assert.deepEqual(after.bookmarks.filter(node => node.id !== bookmarkId), before.bookmarks.filter(node => node.id !== bookmarkId));
    const space = findSpace(before, spaceId);
    const boundIds = Object.entries(before.bindings).filter(([id, binding]) => binding.bookmarkId === bookmarkId && space.spaceBookmarks.includes(Number(id))).map(([id]) => Number(id));
    const expectedBindings = structuredClone(before.bindings);
    if (field === 'url') for (const id of boundIds) expectedBindings[id].pinnedUrl = value;
    assert.deepEqual(after.bindings, expectedBindings);
    assert.deepEqual(without(after.aliases, boundIds), without(before.aliases, boundIds));
    for (const id of boundIds) assert.equal(after.aliases[id], undefined, 'Obsolete saved-pin aliases must be cleared.');
    const projected = after.snapshot.bookmarks.filter(node => node.id === bookmarkId); assert.equal(projected.length, 1);
    const saved = projected[0], previousSaved = before.snapshot.bookmarks.find(node => node.id === bookmarkId); assert(previousSaved);
    assert.deepEqual(saved, { ...previousSaved, [field]: value }, 'Real bridge preserves the full saved identity, title, URL, Space and live binding.');
    assert.equal(saved.spaceId, spaceId);
    if (field === 'title' && saved.tabId && findTab(after, saved.tabId).url === saved.url) {
        assert.equal(after.snapshot.tabs.find(tab => tab.id === saved.tabId)?.title, value);
    }
}

export function assertTabMenuMuted(before, after, { tabId, muted }) {
    same(before, after, ['bookmarks', 'spaces', 'bindings', 'aliases', 'favorites', 'activeSpaceId', 'pageStates']);
    const expected = structuredClone(before.tabs); const target = expected.find(tab => tab.id === tabId); assert(target); target.muted = muted;
    assert.deepEqual(after.tabs, expected, 'Mute changes only the clicked live tab’s muted state.');
}

export function assertTabMenuDuplicated(before, after, { sourceId, windowId, spaceId, inverted = false }) {
    same(before, after, ['bookmarks', 'bindings', 'aliases', 'favorites', 'activeSpaceId', 'pageStates']);
    const additions = after.tabs.filter(tab => !before.tabs.some(prior => prior.id === tab.id));
    assert.equal(additions.length, 1, 'Duplicate must create exactly one new native identity.');
    const duplicate = additions[0], source = findTab(before, sourceId);
    assert.equal(after.tabs.length, before.tabs.length + 1); assert.notEqual(duplicate.id, sourceId);
    assert.equal(duplicate.windowId, windowId); assert.equal(duplicate.url, source.url); assert.equal(duplicate.pinned, false); assert.equal(duplicate.incognito, false);
    assert.equal(duplicate.index, source.index + 1, 'Chrome must duplicate the requested native source, not its same-URL twin.');
    assert.equal(duplicate.active, true, 'Chrome duplication activates the new native tab.');
    assert(after.tabs.filter(tab => tab.windowId === windowId && tab.id !== duplicate.id).every(tab => !tab.active), 'Only the new duplicate is active in its window.');
    for (const tab of before.tabs) assert.deepEqual(tabIdentity(findTab(after, tab.id)), tabIdentity(tab), `Original native tab ${tab.id} must retain its page and identity.`);
    for (const id of new Set(before.tabs.map(tab => tab.windowId))) {
        const order = state => state.tabs.filter(tab => tab.windowId === id && tab.id !== duplicate.id).sort((a, b) => a.index - b.index).map(tab => tab.id);
        assert.deepEqual(order(after), order(before), 'Duplicate cannot reorder existing native tabs.');
        if (id !== windowId) assert.deepEqual(after.tabs.filter(tab => tab.windowId === id), before.tabs.filter(tab => tab.windowId === id));
    }
    const original = findSpace(before, spaceId), updated = findSpace(after, spaceId), expectedOrder = [...original.temporaryTabs];
    assert(expectedOrder.includes(sourceId)); expectedOrder.splice(expectedOrder.indexOf(sourceId) + (inverted ? 0 : 1), 0, duplicate.id);
    assert.deepEqual(updated, { ...original, temporaryTabs: expectedOrder });
    assert.deepEqual(after.spaces.filter(space => space.id !== spaceId), before.spaces.filter(space => space.id !== spaceId));
    assert.equal(after.bindings[duplicate.id], undefined); assert.equal(after.aliases[duplicate.id], undefined);
    assert.equal(after.snapshot.tabs.find(tab => tab.id === duplicate.id)?.spaceId, spaceId);
    assert(after.snapshot.spaces.find(space => space.id === spaceId)?.temporaryTabIds.includes(duplicate.id));
    return duplicate.id;
}

// Passive, action-scoped evidence only. Never intercept a request or response.
export function installTabMenuDuplicateObservation() {
    globalThis.__tabMenuDuplicateObservation?.stop();
    const events = [], status = document.getElementById('favoritesDropStatus'), notice = document.getElementById('favoritesDropNotice');
    const add = value => events.push({ sequence: events.length, at: performance.now(), ...structuredClone(value) });
    const sample = () => ({ text: status?.textContent || '', hidden: notice?.hidden ?? null });
    const mutations = records => {
        for (const record of records) if (record.type === 'childList' && record.target === status)
            add({ type: 'status-write', text: [...record.addedNodes].map(node => node.textContent).join('') });
        if (records.length) add({ type: 'status-observed', ...sample() });
    };
    const observer = new MutationObserver(mutations);
    const click = event => { if (event.target.closest?.('#tab-context-menu [data-action="duplicate"]')) add({ type: 'duplicate-click', trusted: event.isTrusted }); };
    const created = tab => add({ type: 'tabs.onCreated', tab });
    const changed = (changes, area) => {
        if (area !== 'local') return;
        const relevant = Object.fromEntries(Object.entries(changes).filter(([key]) => ['spaces', 'spaceTabSnapshot'].includes(key)));
        if (Object.keys(relevant).length) add({ type: 'storage', area, changes: relevant });
    };
    let stopped = false;
    const stop = () => {
        if (stopped) return; stopped = true;
        mutations(observer.takeRecords()); observer.disconnect();
        document.removeEventListener('click', click, true); chrome.tabs.onCreated.removeListener(created); chrome.storage.onChanged.removeListener(changed);
    };
    add({ type: 'status-initial', ...sample() });
    globalThis.__tabMenuDuplicateObservation = { events, stop, read: () => { mutations(observer.takeRecords()); return { events: structuredClone(events), finalStatus: sample() }; } };
    if (status) observer.observe(status, { childList: true, subtree: true, characterData: true });
    if (notice) observer.observe(notice, { attributes: true, attributeFilter: ['hidden'] });
    document.addEventListener('click', click, true); chrome.tabs.onCreated.addListener(created); chrome.storage.onChanged.addListener(changed);
}
export function readTabMenuDuplicateObservation({ stop = false } = {}) {
    if (!globalThis.__tabMenuDuplicateObservation) throw new Error('Duplicate passive observation is missing.');
    if (stop) globalThis.__tabMenuDuplicateObservation.stop();
    return globalThis.__tabMenuDuplicateObservation.read();
}
export function stopTabMenuDuplicateObservation() {
    globalThis.__tabMenuDuplicateObservation?.stop(); delete globalThis.__tabMenuDuplicateObservation;
}
export function observeTabMenuDuplicateAssertion(before, after, request) {
    try { return { passed: true, duplicateId: assertTabMenuDuplicated(before, after, request) }; }
    catch (error) { return { passed: false, assertion: { name: error.name, message: error.message, stack: error.stack,
        operator: error.operator, expected: error.expected, actual: error.actual } }; }
}

export function assertTabMenuPinRemoved(before, after, { bookmarkId, tabId, spaceId }) {
    same(before, after, ['tabs', 'favorites', 'activeSpaceId', 'pageStates']);
    const removed = findBookmark(before, bookmarkId); assert.equal(after.bookmarks.some(node => node.id === bookmarkId), false);
    const expectedBookmarks = before.bookmarks.filter(node => node.id !== bookmarkId).map(node => node.parentId === removed.parentId && node.index > removed.index ? { ...node, index: node.index - 1 } : node);
    assert.deepEqual(after.bookmarks, expectedBookmarks, 'Remove Pin deletes only the intended bookmark; surviving sibling indexes shift naturally.');
    assert.equal(before.bindings[tabId]?.bookmarkId, bookmarkId); assert.equal(after.bindings[tabId], undefined);
    assert.deepEqual(without(after.bindings, [tabId]), without(before.bindings, [tabId]));
    assert.equal(after.aliases[tabId], undefined); assert.deepEqual(without(after.aliases, [tabId]), without(before.aliases, [tabId]));
    const source = findSpace(before, spaceId); assert(source.spaceBookmarks.includes(tabId));
    assert.deepEqual(findSpace(after, spaceId), { ...source, spaceBookmarks: source.spaceBookmarks.filter(id => id !== tabId), temporaryTabs: [...source.temporaryTabs, tabId] });
    assert.deepEqual(after.spaces.filter(space => space.id !== spaceId), before.spaces.filter(space => space.id !== spaceId));
    assert.equal(after.snapshot.bookmarks.some(node => node.id === bookmarkId), false); findTab(after, tabId);
}

/** Read-only page probe: a real reload loses both response nonce and user input. */
export function readTabMenuPageState() {
    return { url: location.href, title: document.title, documentId: document.body.dataset.documentId, value: document.getElementById('page-state')?.value };
}

/** Passive observation of the real worker, never a manufactured refresh. */
export function watchTabMenuInvalidation({ windowId, peerId }) {
    const observation = { documentTimeOrigin: performance.timeOrigin, changes: [] };
    globalThis.__pairedTabMenuSearch = observation;
    chrome.runtime.onMessage.addListener((message, sender) => {
        if (!message || Array.isArray(message) || !Object.keys(message).every(key => ['action', 'windowId', 'peerId'].includes(key)) ||
            message.action !== 'spotlightArcifyResultsChanged' || message.windowId !== windowId || message.peerId !== peerId ||
            sender?.id !== chrome.runtime.id || sender.tab ||
            (sender.url && sender.url !== chrome.runtime.getURL('background.js')) ||
            (sender.origin && sender.origin !== `chrome-extension://${chrome.runtime.id}`)) return;
        observation.changes.push({ ...message, visibility: document.visibilityState, at: Date.now() });
    });
    return { documentTimeOrigin: observation.documentTimeOrigin, visibility: document.visibilityState };
}

/** Resume the same mounted query through a genuine tab return, without typing. */
export async function readRenamedTabSearch({ page, ui, poll, query, alias, sourceTitle, documentTimeOrigin }) {
    return ui(page, 'Return to the existing alias search without typing or reloading', async () => {
        const rows = await poll(() => page.evaluate(readSpotlightRows), rows =>
            rows.filter(row => row.type === 'open-tab' && row.title === alias).length === 1 &&
            rows.filter(row => row.type === 'open-tab' && row.title === sourceTitle).length === 1,
        'already-mounted Spotlight query resumes with one exact alias and unchanged same-URL twin');
        assert.equal(await page.$eval('[data-testid="spotlight-input"]', node => node.value), query);
        assert.equal(await page.evaluate(() => performance.timeOrigin), documentTimeOrigin, 'The original alias search document must survive.');
        return rows;
    });
}

/** Reacquire only a proven pre-input stale handle; never replay a menu action. */
export async function openFreshTabMenu({ page, selector, menuSelector, record = async () => {} }) {
    await clickFreshResult(async remaining => {
        const element = await page.waitForSelector(selector, { visible: true, timeout: remaining });
        assert(element, 'The exact context-menu target must exist.');
        return { click: () => element.click({ button: 'right' }), dispose: () => element.dispose() };
    }, record);
    // Keep the postcondition outside the reacquisition boundary: once genuine
    // input succeeds, even a missing menu or timeout must fail without a replay.
    await page.waitForSelector(menuSelector, { visible: true });
}

/**
 * Parent must provide existing sandbox-verified Chrome, real bridge snapshot,
 * genuine-input ui(), required screenshot(), diagnostics and cleanup ownership.
 * This module does not launch Chrome, alter sandbox policy, or issue product
 * tabMenuAction messages. API writes below only seed/clean disposable fixtures or
 * explicitly model an external Bookmark Manager race.
 */
export async function exerciseTabMenuActions({ apiPage, newTabPage, pageForUrl, ui, screenshot, snapshot, poll, fixture, arcifyId, spotlightId, search, record = async () => {} }) {
    assertTabMenuFixtureEnvironment();
    for (const fn of [newTabPage, pageForUrl, ui, screenshot, snapshot, poll, search]) assert.equal(typeof fn, 'function');
    const nonce = randomBytes(16).toString('hex'), windowId = fixture.windowA;
    const initial = await snapshot(windowId), space = initial.spaces.find(item => item.id === initial.activeSpaceId);
    assert(space?.bookmarkFolderId);
    const base = `${fixture.base}/tab-menu/${nonce}`, alias = `MenuAlias ${nonce}`, renamedPin = `Saved Menu Pin ${nonce}`;
    const evidence = { nonce, surface: 'regular sidebar.html tab', nativePanel: false, realMouseKeyboard: true, checkpoints: [], screenshots: [] };
    const ownedTabs = new Set(), pageStates = new Map(); let sidebar, spotlight, folderId, staleBookmarkId, outsideWindow, outsidePage, primaryError;
    const representation = await apiPage.evaluate(async () => (await chrome.storage.local.get('todayOrderRepresentation')).todayOrderRepresentation);
    assert.equal(representation?.version, 1); assert.equal(typeof representation.inverted, 'boolean');
    const settings = await apiPage.evaluate(() => chrome.storage.sync.get(['invertTabOrder', 'syncTabGroups']));
    const checkpoint = async (phase, data) => { evidence.checkpoints.push({ phase, ...data }); await record(structuredClone(evidence)); };
    const capture = async label => {
        const result = await ui(sidebar.page, `Capture required ${label}`, () => screenshot(sidebar.page, label, true));
        assert(result, `Required screenshot evidence is missing: ${label}`); evidence.screenshots.push(result);
    };
    const setOption = async (key, value) => {
        await ui(apiPage, `Set ${key} through visible options`, async () => {
            await apiPage.waitForSelector(`#${key}`);
            if (await apiPage.$eval(`#${key}`, node => node.checked) !== value) await apiPage.click(`label.toggle-label[for="${key}"]`);
        });
        await poll(() => apiPage.evaluate(key => chrome.storage.sync.get(key), key), values => Boolean(values[key]) === value, `${key} persisted`);
    };
    const read = async () => {
        const projected = await snapshot(windowId);
        const state = await apiPage.evaluate(async () => {
            const bookmarks = []; const visit = node => { const { id, parentId, index, title, url } = node; bookmarks.push({ id, parentId, index, title, ...(url === undefined ? {} : { url }) }); for (const child of node.children || []) visit(child); };
            for (const root of await chrome.bookmarks.getTree()) visit(root);
            const local = await chrome.storage.local.get(['spaces', 'pinnedTabStatesById', 'tabNameOverridesById', 'persistentFavorites']);
            return { tabs: (await chrome.tabs.query({})).map(({ id, windowId, index, url, pendingUrl, title, pinned, incognito, active, groupId, mutedInfo }) =>
                ({ id, windowId, index, url, pendingUrl: pendingUrl || null, title, pinned, incognito, active, groupId, muted: Boolean(mutedInfo?.muted) })).sort((a, b) => a.id - b.id),
                bookmarks: bookmarks.sort((a, b) => a.id.localeCompare(b.id)),
                spaces: (local.spaces || []).map(({ id, bookmarkFolderId, spaceBookmarks, temporaryTabs }) => ({ id, bookmarkFolderId, spaceBookmarks, temporaryTabs })),
                bindings: local.pinnedTabStatesById || {}, aliases: local.tabNameOverridesById || {}, favorites: local.persistentFavorites || [] };
        });
        state.snapshot = projected; state.activeSpaceId = projected.activeSpaceId;
        state.pageStates = Object.fromEntries(await Promise.all([...pageStates].map(async ([id, page]) => [id, await page.evaluate(readTabMenuPageState)])));
        return state;
    };
    const row = id => `.space.active .tab[data-tab-id="${id}"]`;
    const pin = id => `.space.active .tab[data-bookmark-id="${id}"]`;
    const menu = async selector => ui(sidebar.page, `Right-click exact row ${selector}`, async () => {
        const priorNotice = await sidebar.page.$eval('#favoritesDropNotice', node => !node.hidden);
        if (priorNotice) {
            await sidebar.page.waitForSelector('#favoritesDropDismiss', { visible: true });
            await sidebar.page.click('#favoritesDropDismiss');
            await sidebar.page.waitForFunction(() => document.getElementById('favoritesDropNotice')?.hidden === true, { polling: 50 });
        }
        await openFreshTabMenu({ page: sidebar.page, selector, menuSelector: '#tab-context-menu',
            record: observation => checkpoint('context-menu-input', { selector, menuSelector: '#tab-context-menu', ...observation }) });
    });
    const item = async action => ui(sidebar.page, `Choose ${action} through tab menu`, () => sidebar.page.click(`#tab-context-menu [data-action="${action}"]`));
    const openEditor = async (selector, action) => { await menu(selector); await item(action); await sidebar.page.waitForSelector('#tabEditDialog', { visible: true }); };
    const edit = async (value, stale = false) => ui(sidebar.page, 'Type and save exact tab-menu editor', async () => {
        const input = await sidebar.page.$('#tabEditValue'); assert(input);
        try { await replaceInputText(sidebar.page, input, value); } finally { await input.dispose(); }
        assert.equal(await sidebar.page.$eval('#tabEditValue', node => node.value), value);
        const save = () => sidebar.page.click('#tabEditSave');
        if (stale) return saveWithFreshStaleNotice({ page: sidebar.page, save, poll });
        await save();
    });
    const settled = async () => sidebar.page.waitForFunction(() => !document.querySelector('#tabEditDialog'), { polling: 50 });
    const titleRendered = async (selector, title) => sidebar.page.waitForFunction(({ selector, title }) => document.querySelector(selector)?.querySelector('.tab-title-display')?.textContent === title, { polling: 50 }, { selector, title });
    const awaitProof = async (before, validator, request, label) => poll(read, after => { try { validator(before, after, request); return true; } catch { return false; } }, label);
    const makeTab = async url => {
        const created = await apiPage.evaluate(options => chrome.tabs.create(options), { url, windowId, active: false });
        ownedTabs.add(created.id);
        const assigned = await apiPage.evaluate(({ tabId, spaceId }) => chrome.runtime.sendMessage({ type: 'spaceStore', action: 'assign', tabId, spaceId }), { tabId: created.id, spaceId: space.id });
        assert.equal(assigned?.success, true, assigned?.error || 'Could not assign disposable seed tab.');
        await poll(() => apiPage.evaluate(id => chrome.tabs.get(id), created.id), tab => tab.status === 'complete', 'real fixture page load');
        return created;
    };
    try {
        await setOption('invertTabOrder', false); await setOption('syncTabGroups', false);
        outsideWindow = await apiPage.evaluate(url => chrome.windows.create({ url, type: 'normal', focused: false }), `${base}/outside`);
        assert(![fixture.windowA, fixture.windowB].includes(outsideWindow.id));
        outsidePage = await pageForUrl(`${base}/outside`);
        await outsidePage.waitForSelector('#page-state');
        await ui(outsidePage, 'Initialize the disposable external window before identity baselines', () => outsidePage.click('#page-state'));
        const ordinary = await makeTab(`${base}/ordinary`), ordinaryPage = await pageForUrl(`${base}/ordinary`);
        await ui(ordinaryPage, 'Type genuine ordinary source page state', () => ordinaryPage.type('#page-state', '-ordinary-kept'));
        pageStates.set(ordinary.id, ordinaryPage);
        const twin = await makeTab(`${base}/ordinary`);
        const seeded = await apiPage.evaluate(async ({ parentId, base, nonce }) => {
            const root = await chrome.bookmarks.create({ parentId, title: `Menu fixture ${nonce}` });
            try {
                const live = await chrome.bookmarks.create({ parentId: root.id, title: `Live pin ${nonce}`, url: `${base}/pin` });
                const closed = await chrome.bookmarks.create({ parentId: root.id, title: `Closed URL twin ${nonce}`, url: `${base}/pin` });
                const stale = await chrome.bookmarks.create({ parentId: root.id, title: `Stale pin ${nonce}`, url: `${base}/stale` });
                return { root, live, closed, stale };
            } catch (error) { await chrome.bookmarks.removeTree(root.id); throw error; }
        }, { parentId: space.bookmarkFolderId, base, nonce });
        folderId = seeded.root.id; staleBookmarkId = seeded.stale.id;
        sidebar = await newTabPage(`chrome-extension://${arcifyId}/sidebar.html`, windowId); ownedTabs.add(sidebar.tab.id);
        spotlight = await newTabPage(`chrome-extension://${spotlightId}/newtab.html`, windowId); ownedTabs.add(spotlight.tab.id);
        await search(spotlight.page, nonce);
        const initialAliasRows = await poll(() => spotlight.page.evaluate(readSpotlightRows), rows => rows.filter(row => row.type === 'open-tab' && row.title === `Tab Menu ordinary ${nonce}`).length === 2 && !rows.some(row => row.title === alias), 'both exact ordinary same-URL sources are already rendered before rename');
        await ui(sidebar.page, 'Expand only the disposable Space-pin folder', async () => {
            const selector = `.space.active .folder[data-bookmark-id="${folderId}"]`;
            await sidebar.page.waitForSelector(selector);
            if (await sidebar.page.$eval(selector, node => node.classList.contains('collapsed'))) await sidebar.page.click(`${selector} > .folder-header`);
            await sidebar.page.waitForSelector(pin(seeded.live.id), { visible: true });
        });
        // A separate disposable window keeps all native tab.active bits and
        // Space membership stable. Window B remains under the parent invariant.
        for (const [label, selector, menuSelector] of [
            ['ordinary-tab', row(ordinary.id), '#tab-context-menu'],
            ['closed-space-pin', pin(seeded.closed.id), '#tab-context-menu'],
            ['saved-folder', `.space.active .folder[data-bookmark-id="${folderId}"] > .folder-header`, '#folder-context-menu']
        ]) {
            const open = async () => {
                if (menuSelector === '#tab-context-menu') return menu(selector);
                await ui(sidebar.page, 'Right-click exact saved folder', async () => {
                    await openFreshTabMenu({ page: sidebar.page, selector, menuSelector,
                        record: observation => checkpoint('context-menu-input', { selector, menuSelector, ...observation }) });
                });
            };
            await open(); const before = await read(), preservedBefore = await apiPage.evaluate(readMenuPreservedState);
            const focus = await exerciseExternalMenuDismissal({ sidebar: sidebar.page, destination: outsidePage,
                menuSelector, label, ui, screenshot, poll, record });
            const after = await read(); assertTabMenuCancelled(before, after);
            const preservedAfter = await apiPage.evaluate(readMenuPreservedState);
            assert.deepEqual(preservedAfter, preservedBefore, 'Outside dismissal preserves full durable and current-session ownership.');
            await open();
            await ui(sidebar.page, `Dismiss reopened ${label} menu with genuine Escape`, () => sidebar.page.keyboard.press('Escape'));
            await sidebar.page.waitForFunction(selector => !document.querySelector(selector), { polling: 50 }, menuSelector);
            assertTabMenuCancelled(before, await read());
            await checkpoint('outside-focus', { label, before, after, preservedBefore, preservedAfter, focus, reopenedEscape: true });
        }
        await menu(row(ordinary.id)); const beforeCancel = await read(); await item('rename');
        await sidebar.page.waitForSelector('#tabEditDialog'); await capture('tab-menu-ordinary-rename-cancel');
        await ui(sidebar.page, 'Cancel rename with genuine Escape', () => sidebar.page.keyboard.press('Escape')); await settled();
        const afterCancel = await read(); assertTabMenuCancelled(beforeCancel, afterCancel); await checkpoint('cancel', { before: beforeCancel, after: afterCancel });

        await openEditor(row(ordinary.id), 'rename'); const beforeAlias = await read();
        const searchSurface = await spotlight.page.evaluate(watchTabMenuInvalidation, { windowId, peerId: arcifyId });
        await edit(alias); await settled();
        const afterAlias = await awaitProof(beforeAlias, assertTabMenuAlias, { tabId: ordinary.id, twinId: twin.id, alias }, 'exact live alias and real paired snapshot');
        await titleRendered(row(ordinary.id), alias); await titleRendered(row(twin.id), beforeAlias.tabs.find(tab => tab.id === twin.id).title);
        await capture('tab-menu-alias-repaints-exact-sidebar-row');
        // Hidden Spotlight intentionally queues refreshes. First prove delivery,
        // then return normally so focus recovery cannot hide missing invalidation.
        const invalidation = await poll(() => spotlight.page.evaluate(() => ({
            documentTimeOrigin: performance.timeOrigin, changes: globalThis.__pairedTabMenuSearch?.changes || []
        })), state => state.changes.length > 0, 'paired alias invalidation delivered to the existing search');
        assert.equal(invalidation.documentTimeOrigin, searchSurface.documentTimeOrigin);
        const aliasRows = await readRenamedTabSearch({ page: spotlight.page, ui, poll, query: nonce, alias,
            sourceTitle: `Tab Menu ordinary ${nonce}`, documentTimeOrigin: searchSurface.documentTimeOrigin });
        const aliasShot = await ui(spotlight.page, 'Capture required live alias Spotlight proof', () => screenshot(spotlight.page, 'tab-menu-alias-refreshes-paired-spotlight', true)); assert(aliasShot); evidence.screenshots.push(aliasShot);
        await checkpoint('alias', { before: beforeAlias, after: afterAlias, query: nonce, searchSurface, invalidation, initialRows: initialAliasRows, rows: aliasRows });

        await ui(sidebar.page, 'Open exact saved pin by genuine row click', () => sidebar.page.click(pin(seeded.live.id)));
        const opened = await poll(() => snapshot(windowId), state => Number.isInteger(state.bookmarks.find(node => node.id === seeded.live.id)?.tabId), 'exact live saved-pin binding');
        const pinTabId = opened.bookmarks.find(node => node.id === seeded.live.id).tabId; ownedTabs.add(pinTabId);
        await poll(() => apiPage.evaluate(id => chrome.tabs.get(id), pinTabId), tab => tab.status === 'complete', 'exact saved-pin source navigation completed');
        const pinPage = await pageForUrl(`${base}/pin`); pageStates.set(pinTabId, pinPage);
        await pinPage.waitForSelector('#page-state', { visible: true });
        await ui(pinPage, 'Type genuine saved-pin source page state', () => pinPage.type('#page-state', '-pin-kept'));
        await openEditor(pin(seeded.live.id), 'rename'); const beforeLiveName = await read(); await edit(renamedPin); await settled();
        const afterLiveName = await awaitProof(beforeLiveName, assertTabMenuSavedEdit, { bookmarkId: seeded.live.id, field: 'title', value: renamedPin, spaceId: space.id }, 'live pin title by exact saved ID');
        await titleRendered(pin(seeded.live.id), renamedPin);
        await capture('tab-menu-live-pin-renamed'); await checkpoint('live-pin-name', { before: beforeLiveName, after: afterLiveName });

        await menu(pin(seeded.closed.id));
        const closedActions = await sidebar.page.$$eval('#tab-context-menu [data-action]', nodes => nodes.map(node => node.dataset.action));
        assert(closedActions.includes('rename') && closedActions.includes('editUrl') && closedActions.includes('copyLink'));
        assert(!closedActions.includes('mute') && !closedActions.includes('duplicate'), 'Closed pins have no live-only actions.');
        await item('rename'); await sidebar.page.waitForSelector('#tabEditDialog', { visible: true }); const beforeClosedName = await read(); const closedName = `Closed renamed ${nonce}`; await edit(closedName); await settled();
        const afterClosedName = await awaitProof(beforeClosedName, assertTabMenuSavedEdit, { bookmarkId: seeded.closed.id, field: 'title', value: closedName, spaceId: space.id }, 'closed same-URL pin title remains independent');
        await titleRendered(pin(seeded.closed.id), closedName); await titleRendered(pin(seeded.live.id), renamedPin);
        await openEditor(pin(seeded.closed.id), 'editUrl'); const beforeUrlCancel = await read();
        await ui(sidebar.page, 'Type saved URL then cancel without changing the pin', async () => {
            const input = await sidebar.page.$('#tabEditValue'); assert(input);
            try { await replaceInputText(sidebar.page, input, `${base}/away`); } finally { await input.dispose(); }
        });
        await capture('tab-menu-saved-url-cancel');
        await ui(sidebar.page, 'Cancel saved URL editor', () => sidebar.page.click('#tabEditCancel')); await settled();
        const afterUrlCancel = await read(); assertTabMenuCancelled(beforeUrlCancel, afterUrlCancel); await checkpoint('saved-url-cancel', { before: beforeUrlCancel, after: afterUrlCancel });
        await openEditor(pin(seeded.closed.id), 'editUrl'); const beforeClosedUrl = await read(); await edit(`${base}/edited`); await settled();
        const afterClosedUrl = await awaitProof(beforeClosedUrl, assertTabMenuSavedEdit, { bookmarkId: seeded.closed.id, field: 'url', value: `${base}/edited`, spaceId: space.id }, 'closed saved URL preserves title/folder/order');
        await titleRendered(pin(seeded.closed.id), closedName);
        await sidebar.page.waitForFunction(({ selector, url }) => document.querySelector(selector)?.dataset.url === url, { polling: 50 }, { selector: pin(seeded.closed.id), url: `${base}/edited` });
        await capture('tab-menu-closed-pin-url-edited'); await checkpoint('closed-pin-edits', { beforeName: beforeClosedName, afterName: afterClosedName, beforeUrl: beforeClosedUrl, afterUrl: afterClosedUrl });

        await ui(pinPage, 'Deliberately navigate source away from its saved pin URL', async () => { await pinPage.goto(`${base}/away`); await pinPage.type('#page-state', '-away-kept'); });
        await openEditor(pin(seeded.live.id), 'editUrl'); const beforeLiveUrl = await read(); await edit(`${base}/edited`); await settled();
        const afterLiveUrl = await awaitProof(beforeLiveUrl, assertTabMenuSavedEdit, { bookmarkId: seeded.live.id, field: 'url', value: `${base}/edited`, spaceId: space.id }, 'live URL save does not navigate/reload existing source page');
        assert.equal(afterLiveUrl.snapshot.tabs.find(tab => tab.id === pinTabId)?.title, `Tab Menu away ${nonce}`);
        await titleRendered(pin(seeded.live.id), `Tab Menu away ${nonce}`);
        await sidebar.page.waitForFunction(({ selector, url }) => document.querySelector(selector)?.dataset.pinnedUrl === url, { polling: 50 }, { selector: pin(seeded.live.id), url: `${base}/edited` });
        await capture('tab-menu-live-pin-url-keeps-away-page'); await checkpoint('live-pin-url', { before: beforeLiveUrl, after: afterLiveUrl });

        const clipboardProof = [];
        for (const [selector, expected] of [[pin(seeded.live.id), `${base}/away`], [pin(seeded.closed.id), `${base}/edited`]]) {
            await menu(selector); const beforeCopy = await read(); await item('copyLink');
            await sidebar.page.waitForFunction(() => document.getElementById('favoritesDropNotice')?.textContent.includes('Link copied.'), { polling: 50 });
            await openEditor(row(ordinary.id), 'rename');
            await ui(sidebar.page, 'Paste real clipboard using Ctrl+V without clipboard permissions', async () => {
                const input = await sidebar.page.$('#tabEditValue'); assert(input);
                try {
                    await input.focus(); await sidebar.page.keyboard.down('Control');
                    try { await input.press('KeyA'); await input.press('KeyV'); } finally { await sidebar.page.keyboard.up('Control'); }
                    assert.equal(await input.evaluate(node => node.value), expected);
                } finally { await input.dispose(); }
            });
            await capture(`tab-menu-copy-${clipboardProof.length ? 'closed-saved' : 'live-current'}-url-pasted`);
            await ui(sidebar.page, 'Cancel clipboard inspection without saving alias', () => sidebar.page.click('#tabEditCancel')); await settled();
            const afterCopy = await read(); assertTabMenuCancelled(beforeCopy, afterCopy); clipboardProof.push({ expected, before: beforeCopy, after: afterCopy });
        }
        await checkpoint('clipboard', { proof: clipboardProof, readPermissionAdded: false });

        for (const muted of [true, false]) {
            await menu(row(ordinary.id)); const beforeMute = await read();
            assert.equal(await sidebar.page.$eval('#tab-context-menu [data-action="mute"]', node => node.textContent), muted ? 'Mute Tab' : 'Unmute Tab');
            await item('mute'); const afterMute = await awaitProof(beforeMute, assertTabMenuMuted, { tabId: ordinary.id, muted }, 'only exact live muted state changes');
            await capture(`tab-menu-${muted ? 'muted' : 'unmuted'}-ordinary-tab`); await checkpoint(muted ? 'muted' : 'unmuted', { before: beforeMute, after: afterMute });
        }

        await menu(row(ordinary.id)); const beforeDuplicate = await read();
        const duplicateRequest = { sourceId: ordinary.id, windowId, spaceId: space.id, inverted: representation.inverted };
        const duplicateDiagnostic = { before: beforeDuplicate, request: duplicateRequest };
        let afterDuplicate, duplicateId, duplicateError;
        try {
            await sidebar.page.evaluate(installTabMenuDuplicateObservation);
            await checkpoint('duplicate-before-input', duplicateDiagnostic);
            await item('duplicate');
            afterDuplicate = await poll(async () => {
                const value = await read();
                for (const tab of value.tabs.filter(tab => !beforeDuplicate.tabs.some(old => old.id === tab.id))) {
                    if (tab.url === `${base}/ordinary` && tab.windowId === windowId) ownedTabs.add(tab.id);
                }
                return value;
            }, value => {
                const result = observeTabMenuDuplicateAssertion(beforeDuplicate, value, duplicateRequest);
                duplicateDiagnostic.last = { state: structuredClone(value), result };
                return result.passed;
            }, 'one unbound duplicate in the current Today order');
            duplicateId = assertTabMenuDuplicated(beforeDuplicate, afterDuplicate, duplicateRequest); ownedTabs.add(duplicateId);
        } catch (error) {
            duplicateError = error; duplicateDiagnostic.error = { name: error.name, message: error.message, stack: error.stack }; throw error;
        } finally {
            await finishBookmarkFixture([
                async () => {
                    let observationError;
                    try { duplicateDiagnostic.observation = await sidebar.page.evaluate(readTabMenuDuplicateObservation, { stop: true }); }
                    catch (error) { observationError = error; duplicateDiagnostic.observationError = { name: error.name, message: error.message, stack: error.stack }; }
                    await checkpoint('duplicate-observed-before-cleanup', duplicateDiagnostic);
                    if (observationError) throw observationError;
                },
                () => sidebar.page.evaluate(stopTabMenuDuplicateObservation)
            ], duplicateError, event => checkpoint('duplicate-observer-cleanup-failed', { errors: event.errors }));
        }
        await ui(sidebar.page, 'Confirm exact duplicate is a Today row', () => sidebar.page.waitForSelector(`.space.active [data-tab-type="temporary"] .tab[data-tab-id="${duplicateId}"]`, { visible: true }));
        await capture('tab-menu-duplicate-ordinary-identity'); await checkpoint('duplicate', { before: beforeDuplicate, after: afterDuplicate, duplicateId });

        await openEditor(row(twin.id), 'rename');
        await apiPage.evaluate(id => chrome.tabs.remove(id), twin.id);
        const beforeClosedTab = await poll(read, state => { try { assertTabMenuClosedTargetGone(state, twin.id); return true; } catch { return false; } }, 'native and authoritative close cleanup settled before stale save');
        const closedTabRejection = await edit(`Must not rename closed ${nonce}`, true); await settled();
        const afterClosedTab = await read(); assertTabMenuCancelled(beforeClosedTab, afterClosedTab);
        await capture('tab-menu-stale-closed-tab-rejected'); await checkpoint('closed-tab-stale', { externalRace: 'Exact disposable live tab closed through Chrome while its editor was open.', before: beforeClosedTab, after: afterClosedTab, rejection: closedTabRejection });

        await openEditor(pin(seeded.stale.id), 'editUrl');
        await apiPage.evaluate(({ id, parentId }) => chrome.bookmarks.move(id, { parentId }), { id: seeded.stale.id, parentId: space.bookmarkFolderId });
        const beforeStale = await read(); const movedPinRejection = await edit(`${base}/edited`, true); await settled();
        const afterStale = await read(); assertTabMenuCancelled(beforeStale, afterStale);
        await capture('tab-menu-stale-moved-pin-rejected'); await checkpoint('stale', { externalRace: 'Exact disposable bookmark moved through real Chrome API while editor was open.', before: beforeStale, after: afterStale, rejection: movedPinRejection });
        await apiPage.evaluate(({ id, parentId }) => chrome.bookmarks.move(id, { parentId }), { id: seeded.stale.id, parentId: folderId });

        await menu(pin(seeded.live.id));
        const removeLabels = await sidebar.page.$$eval('#tab-context-menu .context-menu-item', nodes => nodes.map(node => node.textContent));
        assert(removeLabels.includes('Remove Pin')); assert(removeLabels.includes('Close Tab (Keep Pin)')); assert(!removeLabels.includes('Duplicate Tab'), 'Saved pin duplication is outside this action.');
        const beforeRemove = await read();
        await ui(sidebar.page, 'Remove Pin through its distinct visible action', async () => {
            const items = await sidebar.page.$$('#tab-context-menu .context-menu-item'); let exact;
            try {
                for (const candidate of items) if (await candidate.evaluate(node => node.textContent === 'Remove Pin')) { assert.equal(exact, undefined); exact = candidate; }
                assert(exact); await exact.click();
            } finally { for (const candidate of items) await candidate.dispose(); }
        });
        const afterRemove = await awaitProof(beforeRemove, assertTabMenuPinRemoved, { bookmarkId: seeded.live.id, tabId: pinTabId, spaceId: space.id }, 'Remove Pin retains exact live page as Today');
        await ui(sidebar.page, 'Confirm unpinned live row is still open in Today', () => sidebar.page.waitForSelector(`.space.active [data-tab-type="temporary"] .tab[data-tab-id="${pinTabId}"]:not([data-bookmark-id])`, { visible: true }));
        await capture('tab-menu-remove-pin-keeps-live-page'); await checkpoint('removed-pin', { before: beforeRemove, after: afterRemove, noExtraConfirmationDialog: true });
        return evidence;
    } catch (error) {
        primaryError = error;
        if (sidebar?.page) evidence.failureScreenshot = await captureVisibleFailurePage(sidebar.page, 'tab-menu-failure', () => screenshot(sidebar.page, 'tab-menu-failure', false));
        await checkpoint('failed', { error: { message: error.message, stack: error.stack }, ownedTabs: [...ownedTabs], folderId }).catch(() => {});
        throw error;
    } finally {
        await finishBookmarkFixture([
            async () => { if (outsideWindow) await apiPage.evaluate(id => chrome.windows.remove(id), outsideWindow.id); },
            () => apiPage.evaluate(async ids => { const live = new Set((await chrome.tabs.query({})).map(tab => tab.id)); const present = ids.filter(id => live.has(id)); if (present.length) await chrome.tabs.remove(present); }, [...ownedTabs]),
            async () => { if (folderId) await apiPage.evaluate(id => chrome.bookmarks.removeTree(id), folderId); },
            // A moved stale fixture can be outside its root if failure interrupted
            // the intentional external race. Delete only its recorded exact ID.
            async () => { if (staleBookmarkId) await apiPage.evaluate(async id => { const exists = await chrome.bookmarks.get(id).catch(() => []); if (exists.length) await chrome.bookmarks.remove(id); }, staleBookmarkId); },
            () => setOption('invertTabOrder', settings.invertTabOrder !== false),
            () => setOption('syncTabGroups', Boolean(settings.syncTabGroups))
        ], primaryError, event => checkpoint(event.phase, { errors: event.errors }));
    }
}
