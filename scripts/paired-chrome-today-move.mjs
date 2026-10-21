/** Real paired Move-to-Space evidence. Importing this module never launches Chrome. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { clickBookmarkFixtureRow, finishBookmarkFixture } from './paired-chrome-bookmark-selection.mjs';
import { readTodaySelection, assertTodaySelection, watchTodayInvalidation } from './paired-chrome-today-selection.mjs';
import { assertReloadWindowSelection } from './paired-chrome-ordinary-favorites.mjs';
import { readSpotlightRows, readNativeSidebarRender, nativeSidebarRenderReady, nativeSidebarRenderIdentity } from './paired-chrome-sidebar.mjs';

export const TODAY_MOVE_ACTION = '#tab-context-menu [data-action="moveTodayTabsToSpace"]';
export const todayMoveDestination = id => `#tab-context-menu [data-action="moveTodayToDestination"][data-space-id="${id}"]`;
const todayRow = id => `.space.active [data-tab-type="temporary"] .tab[data-tab-id="${id}"]`;
const exactSpace = (state, id) => { const matches = state.spaces.filter(space => space.id === id); assert.equal(matches.length, 1); return matches[0]; };
const stableTab = ({ id, windowId, url, pendingUrl, title, pinned, incognito, active, splitViewId }) => ({ id, windowId, url, pendingUrl, title, pinned, incognito, active, splitViewId });
const comparable = state => Object.fromEntries(['tabs', 'spaces', 'bookmarks', 'bindings', 'aliases', 'favorites', 'activeSpaces', 'activeSpaceId', 'pageStates', 'groups', 'projection', 'windows'].map(key => [key, state[key]]));

export function serveTodayMoveFixture(request, response) {
    const match = /^\/today-move\/([a-f0-9]{32})\/(active|twin|duplicate|stale|remaining|destination-one|destination-two|pin)$/.exec(new URL(request.url, 'http://127.0.0.1').pathname);
    if (!match) return false;
    const title = `Today Move ${match[2]} ${match[1]}`;
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:" });
    response.end(`<!doctype html><html><head><title>${title}</title><link rel="icon" href="data:,"></head><body data-document-id="${randomBytes(16).toString('hex')}"><h1>${title}</h1><input id="move-input" value="kept"></body></html>`);
    return true;
}

export function assertTodayMoveUnchanged(before, after) {
    assert.deepEqual(comparable(after), comparable(before), 'Cancelled/rejected Move must preserve native pages and every captured durable/session identity.');
}

export function assertTodayMoved(before, after, { tabIds, sourceId, destinationId, windowId, inverted, groupSync }) {
    assert.notEqual(sourceId, destinationId);
    assert(tabIds.length && new Set(tabIds).size === tabIds.length, 'Move requires distinct exact native IDs.');
    assert.equal(before.activeSpaceId, sourceId);
    assert.equal(after.activeSpaceId, sourceId, 'Move must retain the source logical currentSpace.');
    assert.deepEqual(after.activeSpaces, before.activeSpaces, 'Move cannot change any window selected Space.');
    assert.deepEqual(after.windows, before.windows, 'Move cannot create/remove/focus/change a browser window.');
    assert.deepEqual(after.tabs.map(tab => tab.id), before.tabs.map(tab => tab.id), 'Move cannot create, close, replace or deduplicate tabs.');
    for (const tab of before.tabs) assert.deepEqual(stableTab(after.tabs.find(item => item.id === tab.id)), stableTab(tab), `Move must keep native page, window and activation for ${tab.id}.`);
    for (const field of ['bookmarks', 'bindings', 'aliases', 'favorites', 'pageStates']) assert.deepEqual(after[field], before[field], `${field} cannot change when moving Today tabs.`);
    const source = exactSpace(before, sourceId), destination = exactSpace(before, destinationId);
    const visible = inverted ? [...source.temporaryTabs].reverse() : source.temporaryTabs;
    assert.deepEqual(visible.filter(id => tabIds.includes(id)), tabIds, 'Selected input must be in exact source visible order.');
    for (const id of tabIds) {
        const tab = before.tabs.find(tab => tab.id === id);
        assert(tab && tab.windowId === windowId && !tab.pinned && !tab.incognito && tab.splitViewId === -1);
        assert.equal(before.spaces.filter(space => [...space.temporaryTabs, ...space.spaceBookmarks].includes(id)).length, 1);
        assert(!before.bindings[id]); assert(!source.spaceBookmarks.includes(id));
        assert.equal(after.spaces.filter(space => [...space.temporaryTabs, ...space.spaceBookmarks].includes(id)).length, 1, 'Every moved ID has exactly one authoritative owner.');
    }
    for (const old of before.spaces) {
        const expected = structuredClone(old);
        if (old.id === sourceId) expected.temporaryTabs = old.temporaryTabs.filter(id => !tabIds.includes(id));
        if (old.id === destinationId) expected.temporaryTabs = inverted ? [...tabIds].reverse().concat(old.temporaryTabs) : old.temporaryTabs.concat(tabIds);
        assert.deepEqual(exactSpace(after, old.id), expected, 'Only exact source/destination Today membership and order may change.');
    }
    assert.equal(after.spaces.length, before.spaces.length);
    assert.deepEqual(after.snapshot.spaces.map(space => space.id), before.snapshot.spaces.map(space => space.id));
    for (const id of tabIds) {
        assert.equal(after.snapshot.tabs.find(tab => tab.id === id)?.spaceId, destinationId, 'Authenticated Spotlight snapshot must refresh exact ownership.');
        assert(!after.snapshot.spaces.find(space => space.id === sourceId).temporaryTabIds.includes(id));
        assert(after.snapshot.spaces.find(space => space.id === destinationId).temporaryTabIds.includes(id));
    }
    if (!groupSync) {
        assert.deepEqual(after.tabs, before.tabs, 'Disabled group sync cannot reorder, regroup or otherwise mutate native tabs.');
        assert.deepEqual(after.groups, before.groups); assert.deepEqual(after.projection, before.projection);
    } else {
        const groupId = after.projection[`${destinationId}:${windowId}`];
        assert(Number.isInteger(groupId) && groupId >= 0);
        const canonical = exactSpace(after, destinationId);
        const expected = [...canonical.spaceBookmarks, ...canonical.temporaryTabs].filter(id => after.tabs.find(tab => tab.id === id)?.windowId === windowId);
        assert.deepEqual(after.tabs.filter(tab => tab.groupId === groupId).sort((a, b) => a.index - b.index).map(tab => tab.id), expected, 'Native destination group must project canonical exact order.');
        const active = after.tabs.find(tab => tab.windowId === windowId && tab.active);
        if (active?.groupId === groupId) assert.equal(after.groups.find(group => group.id === groupId)?.collapsed, false, 'A moved active tab must not be hidden by collapsing its destination group.');
    }
    return { tabIds, sourceId, destinationId, windowId, inverted, groupSync, activeTabId: after.tabs.find(tab => tab.windowId === windowId && tab.active)?.id };
}

export function assertTodayMoveRejected(reply, request) {
    assert.equal(reply?.success, false, 'Invalid Move must reject.');
    assert.equal(typeof reply.error, 'string'); assert(reply.error.length > 0);
    assert.deepEqual(reply.batch, { total: request.entries.length, completed: [], remaining: request.entries.map(entry => entry.tabId),
        uncertain: false, destinationSpaceId: request.destinationSpaceId }, 'Negative target evidence requires writer validation, not sender/schema rejection.');
}

export function assertTodayMoveTrace(events, { tabIds, contextTabId, destinationId, multi }) {
    const context = events.filter(event => event.type === 'contextmenu');
    assert.equal(context.length, 1); assert.equal(context[0].tabId, contextTabId); assert.equal(context[0].trusted, true);
    for (const action of ['moveTodayTabsToSpace', 'moveTodayToDestination']) {
        const matches = events.filter(event => event.type === 'click' && event.action === action);
        assert.equal(matches.length, 1, `Exactly one real ${action} click is required.`); assert.equal(matches[0].trusted, true);
        if (action === 'moveTodayToDestination') assert.equal(matches[0].spaceId, destinationId);
    }
    if (multi) assert.deepEqual(events.filter(event => event.type === 'click' && event.ctrl && event.tabId).map(event => {
        assert.equal(event.trusted, true); return event.tabId;
    }), tabIds);
    assert(events.every(event => event.trusted), 'Synthetic input cannot satisfy the positive Move evidence.');
}

export function installTodayMoveTrace() {
    globalThis.__todayMoveTrace = [];
    for (const type of ['click', 'contextmenu', 'keydown']) document.addEventListener(type, event => {
        const row = event.target.closest?.('.tab[data-tab-id]'), action = event.target.closest?.('[data-action]');
        globalThis.__todayMoveTrace.push({ type, trusted: event.isTrusted, tabId: row ? Number(row.dataset.tabId) : null,
            action: action?.dataset.action || null, spaceId: action?.dataset.spaceId || null, ctrl: event.ctrlKey, key: event.key || null });
    }, { capture: true, passive: true });
}

/** Passive native lifecycle evidence, reset only immediately before the actual destination click. */
export function installTodayMoveNativeTrace() {
    const trace = globalThis.__todayMoveNativeTrace = { events: [] };
    const watch = (event, type) => event.addListener((...details) => trace.events.push({ type, details }));
    for (const [name, type] of [['onActivated', 'activated'], ['onCreated', 'created'], ['onRemoved', 'removed'],
        ['onReplaced', 'replaced'], ['onAttached', 'attached'], ['onDetached', 'detached']]) watch(chrome.tabs[name], type);
    for (const [name, type] of [['onFocusChanged', 'window-focus'], ['onCreated', 'window-created'], ['onRemoved', 'window-removed']]) watch(chrome.windows[name], type);
}

export function assertTodayMoveNativeQuiet(events) {
    assert(Array.isArray(events));
    assert.deepEqual(events, [], 'Move may never transiently activate, create, close, replace or rewindow tabs, or focus/change windows.');
}

export function readTodayMovePage() {
    return { url: location.href, documentId: document.body.dataset.documentId, timeOrigin: performance.timeOrigin,
        value: document.querySelector('#move-input')?.value, topLevel: window === window.top, frameCount: document.querySelectorAll('iframe,frame').length };
}

/** Read-only node identity catches chip replacement even when rendered labels are unchanged. */
export function readTodayMoveSpaceTarget(spaceId) {
    const matches = [...document.querySelectorAll('#spaceSwitcher > button[data-space-id]')].filter(node => node.dataset.spaceId === spaceId);
    if (matches.length !== 1) return { count: matches.length };
    const node = matches[0], rect = node.getBoundingClientRect(), style = getComputedStyle(node);
    const probe = globalThis.__todayMoveChipIdentity ||= { nodes: new WeakMap(), sequence: 0 };
    if (!probe.nodes.has(node)) probe.nodes.set(node, ++probe.sequence);
    const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
    return { count: 1, spaceId: node.dataset.spaceId, nodeId: probe.nodes.get(node), connected: node.isConnected, enabled: !node.disabled,
        visible: style.display !== 'none' && style.visibility === 'visible' && rect.width > 0 && rect.height > 0 &&
            x > 0 && x < innerWidth && y > 0 && y < innerHeight && node.contains(document.elementFromPoint(x, y)),
        x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

/** A foreground action finishes before its activation/session-driven panel redraw can finish. */
export async function waitForTodayMoveSpaceSelection({ read, poll, spaceId, windowId, extensionId, targetSpaceId, activeTabId }) {
    let previous = null;
    return poll(read, state => {
        const { snapshot, rendered, target } = state;
        const ready = snapshot.windowId === windowId && snapshot.activeSpaceId === spaceId &&
            (activeTabId === undefined || snapshot.tabs.filter(tab => tab.active && tab.windowId === windowId).length === 1 &&
                snapshot.tabs.some(tab => tab.id === activeTabId && tab.windowId === windowId && tab.active && tab.spaceId === spaceId)) &&
            nativeSidebarRenderReady(rendered, extensionId) && rendered.selectedSpaces[0] === spaceId &&
            target.count === 1 && target.spaceId === targetSpaceId && Number.isSafeInteger(target.nodeId) && target.nodeId > 0 &&
            target.connected === true && target.enabled === true && target.visible === true;
        if (!ready) { previous = null; return false; }
        const identity = JSON.stringify({ rendered: nativeSidebarRenderIdentity(rendered), target });
        const stable = identity === previous; previous = identity; return stable;
    }, 'authoritative and native rendered Space selection with a stable exact Space chip before input');
}

export function assertTodayMoveHelperClosed(state, closedHelper) {
    assert(Number.isSafeInteger(closedHelper?.tabId) && closedHelper.tabId > 0, 'Cleanup needs the exact created helper tab receipt.');
    assert.equal(closedHelper.windowId, state.snapshot.windowId, 'Cleanup receipt must identify the fixture window.');
    const id = closedHelper.tabId;
    assert(!state.tabs.some(tab => tab.id === id), 'Native helper removal must complete before the reload baseline.');
    for (const space of state.spaces) for (const section of ['spaceBookmarks', 'temporaryTabs'])
        assert(!space[section].includes(id), 'Canonical helper removal must settle before the reload baseline.');
    assert(!state.snapshot.tabs.some(tab => tab.id === id), 'Authenticated snapshot must no longer contain the closed helper.');
    for (const space of state.snapshot.spaces) for (const section of ['tabIds', 'pinnedTabIds', 'temporaryTabIds'])
        assert(!space[section].includes(id), 'Authenticated snapshot membership must no longer contain the closed helper.');
    return state;
}

/** Wait only for read-back convergence. Never filter, edit or replay cleanup. */
export async function waitForTodayMoveHelperCleanup({ read, poll, closedHelper }) {
    return poll(read, state => {
        try { assertTodayMoveHelperClosed(state, closedHelper); return true; } catch { return false; }
    }, 'exact closed native helper absent from native tabs, canonical Spaces and authenticated snapshot before reload');
}

export function todayMoveReloadVerdict(before, after, ids) {
    try { assertTodayMoveReload(before, after, ids); return { passed: true }; }
    catch (error) { return { passed: false, assertion: { message: error.message, operator: error.operator,
        expected: error.expected, actual: error.actual } }; }
}

export function assertTodayMoveReload(before, after, ids) {
    for (const key of ['spaces', 'bookmarks', 'bindings', 'aliases', 'favorites', 'activeSpaceId', 'pageStates']) assert.deepEqual(after[key], before[key], `Reload must retain ${key}.`);
    assertReloadWindowSelection({ ...before, groupState: { windows: before.windows, activeSpaces: before.activeSpaces } },
        { ...after, groupState: { windows: after.windows, activeSpaces: after.activeSpaces } });
    for (const id of ids) {
        const fields = tab => { const { active, ...rest } = stableTab(tab); return rest; };
        assert.deepEqual(fields(after.tabs.find(tab => tab.id === id)), fields(before.tabs.find(tab => tab.id === id)), 'Reload must retain each same native content identity.');
        assert.equal(after.snapshot.tabs.find(tab => tab.id === id)?.spaceId, before.snapshot.tabs.find(tab => tab.id === id)?.spaceId);
    }
}

/** Native input never foregrounds a sidebar tab or fabricates a user gesture. */
export async function exerciseTodayMove({ apiPage, nativeSidebar, newTabPage, pageForUrl, ui, screenshot, snapshot, poll, fixture,
    arcifyId, spotlightId, search, reloadArcify, groupSync, record = async () => {} }) {
    assert.equal(process.env.GITHUB_ACTIONS, 'true'); assert.equal(process.env.CI, 'true'); assert.notEqual(process.getuid?.(), 0);
    const nonce = randomBytes(16).toString('hex'), windowId = fixture.windowA;
    const representation = await apiPage.evaluate(async () => (await chrome.storage.local.get('todayOrderRepresentation')).todayOrderRepresentation);
    assert.equal(representation?.version, 1); assert.equal(typeof representation.inverted, 'boolean');
    const inverted = representation.inverted;
    const settings = await apiPage.evaluate(() => chrome.storage.sync.get(['syncTabGroups', 'invertTabOrder', 'todayNewTabsAtTop']));
    const initial = await snapshot(windowId), source = initial.spaces.find(space => space.id === initial.activeSpaceId);
    const destination = initial.spaces.find(space => space.id !== source.id && space.id !== fixture.spaces.empty);
    assert(source?.bookmarkFolderId && destination?.bookmarkFolderId);
    const base = `${fixture.base}/today-move/${nonce}`, owned = [], pages = new Map(), seed = [];
    let native, spotlight, pinId, primaryError;
    const evidence = { nonce, groupSync, inverted, nativePanel: true, checkpoints: [] };
    const checkpoint = async (phase, data) => { evidence.checkpoints.push({ phase, ...data }); await record(structuredClone(evidence)); };
    const option = async (key, value) => {
        await ui(apiPage, `Set ${key} for Today Move`, async () => { if (await apiPage.$eval(`#${key}`, node => node.checked) !== value) await apiPage.click(`label.toggle-label[for="${key}"]`); });
        await poll(() => apiPage.evaluate(key => chrome.storage.sync.get(key), key), data => (key === 'syncTabGroups' ? Boolean(data[key]) : data[key] !== false) === value, `${key} persisted`);
    };
    const read = async () => {
        const state = await apiPage.evaluate(async () => {
            const local = await chrome.storage.local.get(['spaces', 'pinnedTabStatesById', 'tabNameOverridesById', 'persistentFavorites']);
            const session = await chrome.storage.session.get(['activeSpaces', 'spaceGroupProjection']);
            return { tabs: (await chrome.tabs.query({})).map(({ id, windowId, index, url, pendingUrl, title, pinned, incognito, active, groupId, splitViewId }) =>
                ({ id, windowId, index, url, pendingUrl: pendingUrl || null, title, pinned, incognito, active, groupId, splitViewId: splitViewId ?? -1 })).sort((a, b) => a.id - b.id),
                spaces: (local.spaces || []).map(({ id, bookmarkFolderId, spaceBookmarks, temporaryTabs }) => ({ id, bookmarkFolderId, spaceBookmarks, temporaryTabs })),
                bookmarks: await chrome.bookmarks.getTree(), bindings: local.pinnedTabStatesById || {}, aliases: local.tabNameOverridesById || {}, favorites: local.persistentFavorites || [],
                activeSpaces: session.activeSpaces || {}, projection: session.spaceGroupProjection || {}, groups: await chrome.tabGroups.query({}),
                windows: (await chrome.windows.getAll()).map(({ id, type, incognito, focused, state }) => ({ id, type, incognito, focused, state })).sort((a, b) => a.id - b.id) };
        });
        state.snapshot = await snapshot(windowId); state.activeSpaceId = state.snapshot.activeSpaceId;
        state.pageStates = Object.fromEntries(await Promise.all([...pages].map(async ([id, page]) => [id, await page.evaluate(readTodayMovePage)])));
        return state;
    };
    const input = async (label, action) => {
        const hosting = await native.page.evaluate(async () => ({ tab: await chrome.tabs.getCurrent() || null, windowId: (await chrome.windows.getCurrent()).id,
            visibility: document.visibilityState, width: innerWidth, height: innerHeight }));
        assert.equal(hosting.tab, null); assert.equal(hosting.windowId, windowId); assert.equal(hosting.visibility, 'visible');
        assert(hosting.width >= 100 && hosting.height >= 100);
        await checkpoint('native-today-move-input', { label, hosting }); return action();
    };
    const clear = async () => input('Clear Move menu/Today selection with real Escape', () => native.page.keyboard.press('Escape'));
    const picker = async id => input('Open exact Today context menu and Move chooser', async () => {
        await native.page.click(todayRow(id), { button: 'right' }); await native.page.waitForSelector(TODAY_MOVE_ACTION, { visible: true });
        await native.page.click(TODAY_MOVE_ACTION); await native.page.waitForSelector(todayMoveDestination(destination.id), { visible: true });
        assert.equal(await native.page.$(todayMoveDestination(source.id)), null, 'Current source cannot be a destination.');
        const choices = await native.page.$$eval('#tab-context-menu [data-action="moveTodayToDestination"]', nodes => nodes.map(node => ({ id: node.dataset.spaceId, name: node.textContent })));
        assert.deepEqual(choices, initial.spaces.filter(space => space.id !== source.id).map(({ id, name }) => ({ id, name })), 'Chooser must list each exact existing destination once, in Space order.');
    });
    const render = async (spaceId, expectedIds) => poll(() => native.page.evaluate(({ ids }) => {
        const active = document.querySelector('.space.active');
        const rows = [...active.querySelectorAll('[data-tab-type="temporary"] .tab[data-tab-id]')].filter(row => ids.includes(Number(row.dataset.tabId)));
        return { spaceId: active.dataset.spaceId, ids: rows.map(row => Number(row.dataset.tabId)), visible: rows.map(row => Boolean(row.getClientRects().length && getComputedStyle(row).visibility !== 'hidden')) };
    }, { ids: seed }), state => state.spaceId === spaceId && JSON.stringify(state.ids) === JSON.stringify(expectedIds) && state.visible.every(Boolean), 'exact visible source/destination Today rows');
    const move = async (ids, multi) => {
        await clear();
        const traceStart = await native.page.evaluate(() => globalThis.__todayMoveTrace.length);
        if (multi) {
            for (const id of ids) await input('Select exact Today row with real Control click', () => clickBookmarkFixtureRow(native.page, todayRow(id), ['Control'], observation => checkpoint('row-click-observation', { observation })));
            await poll(() => native.page.evaluate(readTodaySelection), state => { try { assertTodaySelection(state, ids); return true; } catch { return false; } }, 'exact multi-selection before Move');
        }
        await picker(ids[0]);
        const before = await read();
        await apiPage.evaluate(() => { globalThis.__todayMoveNativeTrace.events.length = 0; });
        await input('Choose the existing destination Space', () => native.page.click(todayMoveDestination(destination.id)));
        const request = { tabIds: ids, sourceId: source.id, destinationId: destination.id, windowId, inverted, groupSync };
        await native.page.waitForFunction(count => { const status = document.getElementById('favoritesDropStatus'); return !document.getElementById('favoritesDropNotice')?.hidden && new RegExp(`^Moved ${count} tabs? to Today`).test(status?.textContent || ''); }, { polling: 50 }, ids.length);
        const after = await poll(read, state => { try { assertTodayMoved(before, state, request); return true; } catch { return false; } }, 'exact identity/order move and settled native projection');
        const proof = assertTodayMoved(before, after, request), trace = await native.page.evaluate(start => globalThis.__todayMoveTrace.slice(start), traceStart);
        assertTodayMoveTrace(trace, { tabIds: ids, contextTabId: ids[0], destinationId: destination.id, multi });
        const nativeEvents = await apiPage.evaluate(() => globalThis.__todayMoveNativeTrace.events); assertTodayMoveNativeQuiet(nativeEvents);
        await checkpoint(multi ? 'multi-moved' : 'active-single-moved', { before, after, proof, trace, nativeEvents }); return after;
    };
    try {
        await option('syncTabGroups', groupSync); await option('invertTabOrder', groupSync);
        // Seed in canonical append order through the public prospective setting.
        // Today representation is frozen; never rewrite migration metadata.
        await option('todayNewTabsAtTop', inverted);
        for (const suffix of ['active', 'twin', 'duplicate', 'stale', 'remaining', 'destination-one', 'destination-two']) {
            const spaceId = suffix.startsWith('destination') ? destination.id : source.id;
            const created = await apiPage.evaluate(async ({ windowId, url, spaceId }) => {
                const tab = await chrome.tabs.create({ windowId, url, active: false });
                const assigned = await chrome.runtime.sendMessage({ type: 'spaceStore', action: 'assign', tabId: tab.id, spaceId });
                if (!assigned.success) throw new Error(assigned.error); return tab;
            }, { windowId, url: `${base}/${suffix}`, spaceId });
            owned.push(created.id); seed.push(created.id);
            const page = await pageForUrl(`${base}/${suffix}`); await page.waitForSelector('#move-input'); pages.set(created.id, page);
            await ui(page, 'Type preserved state into exact Move fixture page', () => page.type('#move-input', `-${created.id}`));
        }
        const twin = pages.get(seed[2]), navigation = twin.waitForNavigation({ waitUntil: 'domcontentloaded' });
        await apiPage.evaluate(({ id, url }) => chrome.tabs.update(id, { url }), { id: seed[2], url: `${base}/twin` }); await navigation;
        await ui(twin, 'Type distinct duplicate-URL tab state', () => twin.type('#move-input', `-${seed[2]}`));
        pinId = (await apiPage.evaluate(options => chrome.bookmarks.create(options), { parentId: source.bookmarkFolderId, title: `Move excluded saved pin ${nonce}`, url: `${base}/pin` })).id;
        spotlight = await newTabPage(`chrome-extension://${spotlightId}/newtab.html`, windowId); owned.push(spotlight.tab.id);
        await search(spotlight.page, nonce);
        const searchBefore = await poll(() => spotlight.page.evaluate(readSpotlightRows), rows => rows.filter(row => row.type === 'open-tab' && row.title?.includes(nonce)).length === 7, 'seven exact live Move fixture results');
        const searchSurface = await spotlight.page.evaluate(watchTodayInvalidation, { windowId, peerId: arcifyId });
        native = await nativeSidebar(); await native.page.evaluate(installTodayMoveTrace); await apiPage.evaluate(installTodayMoveNativeTrace);
        await input('Choose source Space for native Move', () => native.page.click(`#spaceSwitcher button[data-space-id="${source.id}"]`));
        await poll(() => native.page.evaluate(readNativeSidebarRender), state => state.selectedSpaces[0] === source.id, 'native source Space rendered');
        // This is a real native panel click, so the content tab remains active while its menu is used.
        await input('Activate the exact Today source page', () => native.page.click(todayRow(seed[0])));
        await poll(read, state => state.tabs.find(tab => tab.id === seed[0])?.active && state.activeSpaceId === source.id, 'exact source content tab active');
        const beforeCancel = await read(); await picker(seed[0]);
        await input('Back from destination chooser', () => native.page.click('#tab-context-menu [data-action="backToTabMenu"]'));
        await native.page.waitForSelector(TODAY_MOVE_ACTION, { visible: true }); await clear();
        assertTodayMoveUnchanged(beforeCancel, await read());
        await picker(seed[0]); await clear(); assertTodayMoveUnchanged(beforeCancel, await read());
        await checkpoint('destination-choice-cancelled', { before: beforeCancel, after: await read(), nativeHost: native.evidence });
        const single = await move([seed[0]], false); assert.equal(single.tabs.find(tab => tab.id === seed[0]).active, true);
        const multi = inverted ? [seed[2], seed[1]] : [seed[1], seed[2]];
        const moved = await move(multi, true);
        assert.equal(moved.tabs.find(tab => tab.id === seed[1]).url, moved.tabs.find(tab => tab.id === seed[2]).url);
        const sourceRendered = await render(source.id, inverted ? [seed[4], seed[3]] : [seed[3], seed[4]]);
        await input('Capture unchanged current Space after exact moves', () => screenshot(native.page, `today-move-sync-${groupSync}-source-native-panel`));
        const invalidation = await poll(() => spotlight.page.evaluate(() => ({ timeOrigin: performance.timeOrigin, changes: globalThis.__pairedTodaySearch?.changes || [] })), state => state.changes.length > 0, 'authenticated invalidation delivered to existing Spotlight');
        assert.equal(invalidation.timeOrigin, searchSurface.documentTimeOrigin);
        const searchAfter = await ui(spotlight.page, 'Return to mounted Spotlight Move query without retyping', async () => {
            const rows = await poll(() => spotlight.page.evaluate(readSpotlightRows), rows => rows.filter(row => row.type === 'open-tab' && ['active', 'twin'].some(suffix => row.title === `Today Move ${suffix} ${nonce}`) && row.space === destination.name).length === 3, 'three moved results refreshed to destination Space');
            assert.equal(await spotlight.page.$eval('[data-testid="spotlight-input"]', node => node.value), nonce);
            assert.equal(await spotlight.page.evaluate(() => performance.timeOrigin), searchSurface.documentTimeOrigin); return rows;
        });
        // Return to the exact content page; a native panel does not require a helper tab for its actions.
        await ui(pages.get(seed[0]), 'Return to the moved active content page', async () => {});
        // Visiting the moved page intentionally selects its owner asynchronously. Wait for that redraw before acquiring a chip.
        const readSelection = async () => ({ snapshot: await snapshot(windowId), rendered: await native.page.evaluate(readNativeSidebarRender),
            target: await native.page.evaluate(readTodayMoveSpaceTarget, source.id) });
        const selectionOptions = { read: readSelection, poll, windowId, extensionId: arcifyId, targetSpaceId: source.id };
        const foregroundSelection = await waitForTodayMoveSpaceSelection({ ...selectionOptions, spaceId: destination.id, activeTabId: seed[0] });
        await checkpoint('foreground-destination-selection-settled', { foregroundSelection, sourceRendered, searchBefore, searchAfter, searchSurface, invalidation });
        await input('Return to source Space for rejection checks', () => native.page.click(`#spaceSwitcher button[data-space-id="${source.id}"]`));
        const rejectionSelection = await waitForTodayMoveSpaceSelection({ ...selectionOptions, spaceId: source.id });
        await checkpoint('source-selection-settled-for-rejections', { rejectionSelection });
        const savedPin = `.space.active [data-bookmark-id="${pinId}"]`;
        await input('Inspect saved-pin exclusion', async () => { await native.page.click(savedPin, { button: 'right' }); await native.page.waitForSelector('#tab-context-menu'); assert.equal(await native.page.$(TODAY_MOVE_ACTION), null); }); await clear();
        const favorite = await native.page.$('#pinnedFavicons .saved-favorite'); assert(favorite, 'Prior full-suite Favorite fixture must remain available for exclusion.'); await favorite.dispose();
        await input('Inspect global Favorite exclusion', async () => { await native.page.click('#pinnedFavicons .saved-favorite', { button: 'right' }); await native.page.waitForSelector('#tab-context-menu'); assert.equal(await native.page.$(TODAY_MOVE_ACTION), null); }); await clear();
        const request = { type: 'moveTodayTabsToSpace', windowId, spaceId: source.id, bookmarkFolderId: source.bookmarkFolderId,
            destinationSpaceId: destination.id, destinationBookmarkFolderId: destination.bookmarkFolderId, inverted,
            entries: [{ tabId: seed[3], url: `${base}/stale` }] };
        for (const patch of [{ destinationSpaceId: 'missing-ci-space' }, { destinationBookmarkFolderId: 'missing-ci-root' }, { entries: [{ tabId: seed[3], url: `${base}/changed` }] }]) {
            const before = await read(), rejectedRequest = { ...request, ...patch };
            const reply = await native.page.evaluate(message => chrome.runtime.sendMessage(message), rejectedRequest);
            assertTodayMoveRejected(reply, rejectedRequest); assertTodayMoveUnchanged(before, await read());
            await checkpoint('negative-target-rejected', { patch, reply });
        }
        await picker(seed[3]);
        await apiPage.evaluate(id => chrome.tabs.remove(id), seed[3]); pages.delete(seed[3]);
        await poll(read, state => !state.tabs.some(tab => tab.id === seed[3]) && !exactSpace(state, source.id).temporaryTabs.includes(seed[3]), 'closed source removed before stale picker command');
        const staleBefore = await read();
        const staleChoice = await native.page.$(todayMoveDestination(destination.id));
        const stalePickerState = staleChoice ? 'guarded-picker' : 'dismissed-picker';
        if (staleChoice) {
            await staleChoice.dispose();
            const previousStatus = await native.page.$eval('#favoritesDropStatus', node => node.textContent);
            await input('Reject frozen picker after exact source closes', () => native.page.click(todayMoveDestination(destination.id)));
            await native.page.waitForFunction(previous => { const status = document.getElementById('favoritesDropStatus')?.textContent || ''; return !document.getElementById('favoritesDropNotice')?.hidden && status !== previous && /nothing was moved|nothing moved|selection changed|no longer|closed/i.test(status); }, { polling: 50 }, previousStatus);
        }
        else assert.equal(await native.page.$('#tab-context-menu'), null, 'Stale picker must either remain guarded or be fully dismissed.');
        await clear(); assertTodayMoveUnchanged(staleBefore, await read());
        const staleReply = await native.page.evaluate(message => chrome.runtime.sendMessage(message), request);
        assertTodayMoveRejected(staleReply, request); assertTodayMoveUnchanged(staleBefore, await read());
        await checkpoint('stale-source-rejected', { staleReply, stalePickerState, before: staleBefore, after: await read() });
        await input('Inspect destination Space rows', () => native.page.click(`#spaceSwitcher button[data-space-id="${destination.id}"]`));
        await poll(() => snapshot(windowId), state => state.activeSpaceId === destination.id, 'destination selected for visible inspection');
        const destinationIds = exactSpace(await read(), destination.id).temporaryTabs.filter(id => seed.includes(id));
        const destinationRendered = await render(destination.id, inverted ? [...destinationIds].reverse() : destinationIds);
        await input('Capture exact moved destination rows', () => screenshot(native.page, `today-move-sync-${groupSync}-destination-native-panel`));
        await input('Restore source Space before reload', () => native.page.click(`#spaceSwitcher button[data-space-id="${source.id}"]`));
        await poll(() => snapshot(windowId), state => state.activeSpaceId === source.id, 'source restored before reload');
        await checkpoint('render-and-paired-search', { sourceRendered, destinationRendered, searchBefore, searchAfter, searchSurface, invalidation });
        await input('Keep an existing source content tab active before closing the helper', () => native.page.click(todayRow(seed[4])));
        await poll(read, state => state.tabs.find(tab => tab.id === seed[4])?.active && state.activeSpaceId === source.id, 'source content remains active before helper cleanup');
        const closedHelper = await native.close(); native = null;
        const beforeReload = await waitForTodayMoveHelperCleanup({ read, poll, closedHelper });
        evidence.reload = { closedHelper, before: beforeReload, attempts: 0, lastObservation: null, lastAssertionFailure: null };
        await checkpoint('before-witnessed-extension-reload', { closedHelper, before: beforeReload });
        const reloaded = await reloadArcify(); apiPage = reloaded.arcifyOptions;
        evidence.reload.lifecycle = reloaded.evidence;
        const retained = seed.filter(id => id !== seed[3]);
        const observed = await poll(async () => {
            const state = await read(), verdict = todayMoveReloadVerdict(beforeReload, state, retained);
            evidence.reload.attempts++;
            evidence.reload.lastObservation = { state, verdict };
            if (!verdict.passed) evidence.reload.lastAssertionFailure = verdict.assertion;
            await record(structuredClone(evidence));
            return { state, verdict };
        }, value => value.verdict.passed, 'same native moved identities and canonical memberships survive witnessed extension reload');
        const afterReload = observed.state;
        assertTodayMoveReload(beforeReload, afterReload, retained);
        native = await nativeSidebar();
        const reloadedSource = await render(source.id, [seed[4]]);
        await checkpoint('witnessed-extension-reload', { lifecycle: reloaded.evidence, before: beforeReload, after: afterReload, reloadedSource });
        return evidence;
    } catch (error) {
        primaryError = error; await checkpoint('today-move-failed', { error: { message: error.message, stack: error.stack }, seed }).catch(() => {});
        if (native?.page) await screenshot(native.page, `today-move-sync-${groupSync}-failure-native-panel`, false).catch(() => {});
        throw error;
    } finally {
        await finishBookmarkFixture([
            async () => { if (native) await native.close(); },
            () => apiPage.evaluate(async ids => { const live = new Set((await chrome.tabs.query({})).map(tab => tab.id)); const present = ids.filter(id => live.has(id)); if (present.length) await chrome.tabs.remove(present); }, owned),
            async () => { if (pinId) await apiPage.evaluate(id => chrome.bookmarks.remove(id), pinId); },
            () => option('syncTabGroups', Boolean(settings.syncTabGroups)), () => option('invertTabOrder', settings.invertTabOrder !== false), () => option('todayNewTabsAtTop', settings.todayNewTabsAtTop !== false)
        ], primaryError, record);
    }
}
