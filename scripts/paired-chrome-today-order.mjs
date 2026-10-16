/** Prospective Today creation evidence. Pure imports never launch a browser. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { finishBookmarkFixture } from './paired-chrome-bookmark-selection.mjs';
import { cleanupNewTabFixtureSpace, readTodayNewTabRow, assertTodayNewTabRow } from './paired-chrome-newtab-row.mjs';
import { openFreshTabMenu } from './paired-chrome-tab-menu.mjs';
import { locateFreshDragGeometry } from './paired-chrome-ui.mjs';
import { readFixturePageIdentity, assertFixturePageObservation, assertReloadFixtureProvenance } from './paired-chrome-reload-fixtures.mjs';
import { assertReloadWindowSelection } from './paired-chrome-ordinary-favorites.mjs';
import { waitForTodayMoveHelperCleanup } from './paired-chrome-today-move.mjs';

export const TODAY_ORDER_CASES = Object.freeze([
    'Today creation has independent prospective top and opener order with group sync off',
    'Today creation preserves manual order and native projection with group sync on'
]);
const row = id => `.space.active [data-tab-type="temporary"] .tab[data-tab-id="${id}"]`;
const same = (before, after, fields) => { for (const key of fields) assert.deepEqual(after[key], before[key], `Today insertion must preserve ${key}.`); };
const space = (state, id) => { const matches = state.spaces.filter(item => item.id === id); assert.equal(matches.length, 1); return matches[0]; };
const identity = ({ id, windowId, url, pendingUrl, pinned, incognito, splitViewId }) => ({ id, windowId, url, pendingUrl, pinned, incognito, splitViewId });
export const visibleTodayOrder = (ids, inverted) => inverted ? [...ids].reverse() : [...ids];

export function serveTodayOrderFixture(request, response) {
    const match = /^\/today-order\/([a-f0-9]{32})\/([a-z][a-z0-9-]*)$/.exec(new URL(request.url, 'http://127.0.0.1').pathname);
    if (!match) return false;
    const [, nonce, name] = match;
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:" });
    // Explicit rel=opener is part of the served test page. The click below is
    // trusted browser input; no evaluate(window.open) or manufactured gesture.
    response.end(`<!doctype html><html><head><title>Today Order ${name} ${nonce}</title><link rel="icon" href="data:,"></head><body data-document-id="${randomBytes(16).toString('hex')}"><h1>Today Order ${name}</h1><input id="today-order-input" value="kept"><a id="today-order-child" href="/today-order/${nonce}/${name}-child" target="_blank" rel="opener">Open child in new tab</a></body></html>`);
    return true;
}

export function readTodayOrderSidebar() {
    const active = document.querySelector('.space.active'), list = active?.querySelector('[data-tab-type="temporary"]');
    const rows = [...(list?.querySelectorAll('.tab[data-tab-id]') || [])];
    return { spaceId: active?.dataset.spaceId, inverted: list?.dataset.todayOrderInverted,
        ids: rows.map(node => Number(node.dataset.tabId)),
        visible: rows.map(node => Boolean(node.getClientRects().length && getComputedStyle(node).visibility === 'visible')),
        savedRootIds: [...(active?.querySelector('[data-tab-type="pinned"]')?.children || [])].filter(node => node.matches('.tab[data-bookmark-id],.folder[data-bookmark-id]')).map(node => node.dataset.bookmarkId) };
}

export function assertTodayOrderState(state, { spaceId, windowId, expectedVisible, inverted, groupSync }) {
    assert.equal(typeof inverted, 'boolean'); assert.equal(new Set(expectedVisible).size, expectedVisible.length);
    assert.deepEqual(state.representation, { version: 1, inverted }, 'Frozen Today representation must survive every action.');
    const canonical = visibleTodayOrder(expectedVisible, inverted), owned = space(state, spaceId);
    assert.deepEqual(owned.temporaryTabs, canonical, 'Exact canonical Today IDs must match the independently expected visible order.');
    const projected = state.snapshot.spaces.find(item => item.id === spaceId); assert(projected);
    assert.equal(state.snapshot.windowId, windowId); assert.equal(state.snapshot.activeSpaceId, spaceId);
    assert.deepEqual(projected.temporaryTabIds, canonical, 'Authenticated Spotlight snapshot must carry exact canonical IDs and order.');
    assert.deepEqual(state.rendered.ids, expectedVisible, 'Actual native sidebar DOM must expose the expected Today order.');
    assert.equal(state.rendered.spaceId, spaceId); assert.equal(state.rendered.inverted, String(inverted));
    assert.equal(state.rendered.visible.length, expectedVisible.length); assert(state.rendered.visible.every(Boolean));
    for (const id of expectedVisible) {
        const tab = state.tabs.find(tab => tab.id === id); assert(tab && tab.windowId === windowId && !tab.pinned && !tab.incognito);
        assert.equal(state.spaces.filter(item => [...item.temporaryTabs, ...item.spaceBookmarks].includes(id)).length, 1);
        assert.equal(state.snapshot.tabs.find(tab => tab.id === id)?.spaceId, spaceId);
        assert.equal(state.bindings[id], undefined, 'A newly created Today tab cannot acquire saved-pin identity.');
    }
    if (groupSync && expectedVisible.length) {
        const groupId = state.projection[`${spaceId}:${windowId}`]; assert(Number.isInteger(groupId) && groupId >= 0);
        const expected = [...owned.spaceBookmarks, ...owned.temporaryTabs].filter(id => state.tabs.some(tab => tab.id === id && tab.windowId === windowId));
        assert.deepEqual(state.tabs.filter(tab => tab.groupId === groupId).sort((a, b) => a.index - b.index).map(tab => tab.id), expected,
            'Enabled native group projection must follow canonical order, independently of visible Today orientation.');
    }
    return { spaceId, windowId, canonical, visible: [...expectedVisible], inverted, groupSync };
}

export function assertTodayCreated(before, after, request) {
    const { spaceId, windowId, inverted, atTop = true, afterTabId = null, requireOpener = false, groupSync, activate = false, expectedUrl } = request;
    const additions = after.tabs.filter(tab => !before.tabs.some(old => old.id === tab.id));
    assert.equal(additions.length, 1, 'Each creation action must create exactly one native ID.');
    assert.equal(after.tabs.length, before.tabs.length + 1);
    const created = additions[0]; assert.equal(created.windowId, windowId);
    assert.equal(created.status, 'complete', 'Each newly created fixture document must settle before the next strict identity baseline.');
    assert.equal(created.pendingUrl, null, 'A pending native navigation cannot establish stable insertion evidence.');
    if (expectedUrl !== undefined) assert.equal(created.url, expectedUrl, 'The exact new ID must finish at the requested URL.');
    const expectedVisible = visibleTodayOrder(space(before, spaceId).temporaryTabs, inverted);
    if (afterTabId !== null) { const index = expectedVisible.indexOf(afterTabId); assert(index >= 0); expectedVisible.splice(index + 1, 0, created.id); }
    else if (atTop) expectedVisible.unshift(created.id); else expectedVisible.push(created.id);
    if (requireOpener) assert.equal(created.openerTabId, afterTabId, 'Chrome must report the exact trusted-link opener ID.');
    if (activate) assert.equal(created.active, true);
    same(before, after, ['bookmarks', 'bindings', 'aliases', 'favorites', 'representation', 'windows', 'activeSpaces']);
    for (const old of before.tabs) {
        const live = after.tabs.find(tab => tab.id === old.id); assert(live, 'Creation cannot remove or replace an existing tab.');
        assert.deepEqual(identity(live), identity(old));
        if (!activate || old.windowId !== windowId) assert.equal(live.active, old.active);
        if (old.windowId !== windowId) assert.deepEqual(live, old, 'Other-window native state must remain exact.');
    }
    for (const previous of before.spaces) {
        const current = space(after, previous.id);
        assert.deepEqual(current, previous.id === spaceId ? { ...previous, temporaryTabs: visibleTodayOrder(expectedVisible, inverted) } : previous);
    }
    if (!groupSync) {
        same(before, after, ['groups', 'projection']);
        const nativeOrder = state => state.tabs.filter(tab => tab.windowId === windowId && tab.id !== created.id).sort((a, b) => a.index - b.index).map(tab => tab.id);
        assert.deepEqual(nativeOrder(after), nativeOrder(before), 'Disabled sync cannot reorder the surviving native tab strip.');
        for (const old of before.tabs) assert.equal(after.tabs.find(tab => tab.id === old.id).groupId, old.groupId);
    }
    assertTodayOrderState(after, { ...request, expectedVisible });
    return { tabId: created.id, openerTabId: created.openerTabId, expectedVisible };
}

export function assertTodayOrderUnchanged(before, after, request) {
    same(before, after, ['spaces', 'bookmarks', 'bindings', 'aliases', 'favorites', 'representation']);
    assert.deepEqual(after.tabs.map(tab => tab.id), before.tabs.map(tab => tab.id), 'A non-creation action must keep all exact native IDs.');
    for (const tab of before.tabs.filter(tab => tab.windowId !== request.windowId)) assert.deepEqual(after.tabs.find(item => item.id === tab.id), tab);
    return assertTodayOrderState(after, { ...request, expectedVisible: visibleTodayOrder(space(before, request.spaceId).temporaryTabs, request.inverted) });
}

export function assertTodayManualOrder(before, after, request) {
    same(before, after, ['bookmarks', 'bindings', 'aliases', 'favorites', 'representation', 'windows', 'activeSpaces']);
    assert.deepEqual(after.tabs.map(tab => tab.id), before.tabs.map(tab => tab.id), 'A manual Today reorder cannot create, close or replace tabs.');
    for (const old of before.tabs) { const current = after.tabs.find(tab => tab.id === old.id); assert.deepEqual(identity(current), identity(old)); assert.equal(current.active, old.active); }
    for (const old of before.spaces.filter(space => space.id !== request.spaceId)) assert.deepEqual(space(after, old.id), old);
    assert.deepEqual(space(after, request.spaceId).spaceBookmarks, space(before, request.spaceId).spaceBookmarks);
    assert.deepEqual([...request.expectedVisible].sort((a, b) => a - b), [...space(before, request.spaceId).temporaryTabs].sort((a, b) => a - b));
    if (!request.groupSync) same(before, after, ['tabs', 'groups', 'projection']);
    return assertTodayOrderState(after, request);
}

export function installTodayOrderTrace() {
    globalThis.__todayOrderTrace = [];
    for (const type of ['click', 'contextmenu', 'dragstart', 'drop', 'dragend']) document.addEventListener(type, event => {
        globalThis.__todayOrderTrace.push({ type, trusted: event.isTrusted, tabId: Number(event.target.closest?.('.tab[data-tab-id]')?.dataset.tabId) || null,
            action: event.target.closest?.('[data-action]')?.dataset.action || null, elementId: event.target.closest?.('[id]')?.id || null });
    }, { capture: true, passive: true });
}
export function assertTodayOrderInput(events, { type, tabId = null, action = null, elementId = null }) {
    const matches = events.filter(event => event.type === type && (tabId === null || event.tabId === tabId) && (action === null || event.action === action) && (elementId === null || event.elementId === elementId));
    assert.equal(matches.length, 1, 'Each positive action requires exactly one observed trusted input.'); assert.equal(matches[0].trusted, true);
    return matches[0];
}

/** Browser is supplied by the approved sandboxed CI runner, never launched here. */
export async function exerciseTodayCreationOrder({ apiPage, nativeSidebar, pageForUrl, ui, screenshot, snapshot, bridge, poll,
    fixture, arcifyId, spotlightId, peerPage, reloadArcify, groupSync, record = async () => {} }) {
    assert.equal(process.env.GITHUB_ACTIONS, 'true'); assert.equal(process.env.CI, 'true'); assert.notEqual(process.getuid?.(), 0);
    const nonce = randomBytes(16).toString('hex'), windowId = fixture.windowA, base = `${fixture.base}/today-order/${nonce}`;
    const settings = await apiPage.evaluate(() => chrome.storage.sync.get(['syncTabGroups', 'invertTabOrder', 'todayNewTabsAtTop']));
    const representation = await apiPage.evaluate(async () => (await chrome.storage.local.get('todayOrderRepresentation')).todayOrderRepresentation);
    assert.equal(representation?.version, 1); assert.equal(typeof representation.inverted, 'boolean'); const inverted = representation.inverted;
    const evidence = { nonce, groupSync, inverted, nativePanel: true, checkpoints: [] }, owned = new Set();
    let native, folder, sourcePage, sourceId, primaryError, reloadReceipt = null, disconnected = false;
    const initialControl = await apiPage.evaluate(readFixturePageIdentity), controlWindowId = initialControl.tab.windowId;
    assert.notEqual(controlWindowId, windowId);
    const controlState = async state => {
        const pages = await Promise.all([apiPage.evaluate(readFixturePageIdentity), peerPage.evaluate(readFixturePageIdentity)]);
        for (const id of [arcifyId, spotlightId]) {
            const url = `chrome-extension://${id}/installation-onboarding.html`, matches = state.tabs.filter(tab => tab.url === url);
            assert(matches.length <= 1); if (matches.length) pages.push(await (await pageForUrl(url)).evaluate(readFixturePageIdentity));
        }
        state.groupState = { spaces: state.spaces, activeSpaces: state.activeSpaces, windows: state.windows }; state.fixturePages = { controlWindowId, pages };
        return state;
    };
    const checkpoint = async (phase, data) => { evidence.checkpoints.push({ phase, ...data }); await record(structuredClone(evidence)); };
    const read = async () => {
        const state = await apiPage.evaluate(async () => {
            const local = await chrome.storage.local.get(['spaces', 'todayOrderRepresentation', 'pinnedTabStatesById', 'tabNameOverridesById', 'persistentFavorites']);
            const session = await chrome.storage.session.get(['activeSpaces', 'spaceGroupProjection']);
            const node = ({ id, parentId, index, title, url, children }) => ({ id, parentId, index, title, ...(url === undefined ? {} : { url }), ...(children ? { children: children.map(node) } : {}) });
            return { tabs: (await chrome.tabs.query({})).map(({ id, windowId, index, url, pendingUrl, pinned, incognito, active, groupId, splitViewId, openerTabId, status }) =>
                ({ id, windowId, index, url, pendingUrl: pendingUrl || null, pinned, incognito, active, groupId, splitViewId: splitViewId ?? -1, openerTabId: openerTabId ?? null, status })).sort((a, b) => a.id - b.id),
                spaces: (local.spaces || []).map(({ id, bookmarkFolderId, spaceBookmarks, temporaryTabs }) => ({ id, bookmarkFolderId, spaceBookmarks, temporaryTabs })),
                bookmarks: (await chrome.bookmarks.getTree()).map(node), representation: local.todayOrderRepresentation,
                bindings: local.pinnedTabStatesById || {}, aliases: local.tabNameOverridesById || {}, favorites: local.persistentFavorites || [],
                activeSpaces: session.activeSpaces || {}, projection: session.spaceGroupProjection || {}, groups: await chrome.tabGroups.query({}),
                windows: (await chrome.windows.getAll()).map(({ id, type, incognito, focused, state }) => ({ id, type, incognito, focused, state })).sort((a, b) => a.id - b.id) };
        });
        state.snapshot = await snapshot(windowId);
        if (native) { state.rendered = await native.page.evaluate(readTodayOrderSidebar); state.newTabRow = await native.page.evaluate(readTodayNewTabRow); }
        return state;
    };
    const initial = await controlState(await read()), initialSpaceId = initial.snapshot.activeSpaceId;
    assertFixturePageObservation(initial, { arcifyId, spotlightId });
    const request = () => ({ spaceId: folder.spaceId, windowId, inverted, groupSync });
    const input = async (label, action) => {
        const hosting = await native.page.evaluate(async () => ({ tab: await chrome.tabs.getCurrent() || null, windowId: (await chrome.windows.getCurrent()).id, visibility: document.visibilityState }));
        assert.equal(hosting.tab, null); assert.equal(hosting.windowId, windowId); assert.equal(hosting.visibility, 'visible');
        await checkpoint('native-input', { label, hosting }); return action();
    };
    const select = async () => {
        await input('Select exact disposable Today-order Space', () => native.page.click(`#spaceSwitcher button[data-space-id="${folder.spaceId}"]`));
        if (disconnected) await poll(async () => ({ active: (await apiPage.evaluate(() => chrome.storage.session.get('activeSpaces'))).activeSpaces?.[windowId], rendered: await native.page.evaluate(readTodayOrderSidebar) }), value => value.active === folder.spaceId && value.rendered.spaceId === folder.spaceId, 'native and canonical fixture Space selected while deliberately unpaired');
        else await poll(read, value => value.snapshot.activeSpaceId === folder.spaceId && value.rendered.spaceId === folder.spaceId, 'native and authenticated fixture Space selected');
    };
    const option = async (key, value) => {
        await ui(apiPage, `Set ${key} through real options`, async () => { await apiPage.waitForSelector(`#${key}`); if (await apiPage.$eval(`#${key}`, node => node.checked) !== value) await apiPage.click(`label.toggle-label[for="${key}"]`); });
        await poll(() => apiPage.evaluate(key => chrome.storage.sync.get(key), key), state => (key === 'syncTabGroups' ? Boolean(state[key]) : state[key] !== false) === value, `${key} persisted`);
        if (native) { await apiPage.evaluate(async ({ id, windowId }) => { await chrome.tabs.update(id, { active: true }); await chrome.windows.update(windowId, { focused: true }); }, { id: sourceId || initial.tabs.find(tab => tab.windowId === windowId && tab.active).id, windowId }); await select(); }
    };
    const settle = async expectedVisible => poll(read, state => { try { assertTodayOrderState(state, { ...request(), expectedVisible }); return true; } catch { return false; } }, 'exact native rendered, canonical and authenticated Today order');
    const created = async (phase, action, { atTop = true, afterTabId = null, requireOpener = false, activate = false, expectedUrl } = {}) => {
        const before = await read(), result = await action();
        if (Number.isInteger(result?.id || result?.tabId)) owned.add(result.id || result.tabId);
        const after = await poll(read, state => {
            for (const tab of state.tabs.filter(tab => !before.tabs.some(old => old.id === tab.id))) owned.add(tab.id);
            try { assertTodayCreated(before, state, { ...request(), atTop, afterTabId, requireOpener, activate, expectedUrl }); return true; } catch { return false; }
        }, `${phase}: one exact created identity at its required visible position`);
        const proof = assertTodayCreated(before, after, { ...request(), atTop, afterTabId, requireOpener, activate, expectedUrl });
        assertTodayNewTabRow(after.newTabRow, { spaceId: folder.spaceId, inverted, requiredTabId: proof.expectedVisible[0] });
        await checkpoint(phase, { before, after, proof }); return proof.tabId;
    };
    const reconnect = async () => {
        await ui(apiPage, 'Restore existing exact Spotlight pairing', async () => { await apiPage.type('#bridgePeerId', spotlightId); await apiPage.click('#bridgeSave'); await apiPage.waitForSelector('#bridgeStatus[data-state="connected"]'); });
        disconnected = false;
    };
    try {
        await option('syncTabGroups', groupSync); await option('todayNewTabsAtTop', true); await option('invertTabOrder', false);
        folder = await apiPage.evaluate(async ({ nonce, base }) => {
            const root = (await chrome.bookmarks.search({ title: 'Arcify' })).find(node => !node.url); if (!root) throw new Error('Missing exact Arcify root.');
            const folder = await chrome.bookmarks.create({ parentId: root.id, title: `Today Order ${nonce}` });
            const one = await chrome.bookmarks.create({ parentId: folder.id, title: 'Order saved one', url: `${base}/saved-one` });
            const nested = await chrome.bookmarks.create({ parentId: folder.id, title: 'Order saved folder' });
            await chrome.bookmarks.create({ parentId: nested.id, title: 'Order nested pin', url: `${base}/saved-nested` });
            const two = await chrome.bookmarks.create({ parentId: folder.id, title: 'Order saved two', url: `${base}/saved-two` });
            const result = await chrome.runtime.sendMessage({ type: 'spaceStore', action: 'get' }); if (!result.success) throw new Error(result.error);
            const matches = result.spaces.filter(space => space.bookmarkFolderId === folder.id); if (matches.length !== 1) throw new Error('Fixture Space not reconciled.');
            return { folderId: folder.id, spaceId: matches[0].id, savedIds: [one.id, nested.id, two.id] };
        }, { nonce, base });
        native = await nativeSidebar(); await select(); await native.page.evaluate(installTodayOrderTrace); await settle([]);
        sourceId = await created('browser-api-standalone-top', () => apiPage.evaluate(options => chrome.tabs.create(options), { windowId, url: `${base}/source`, active: false }), { expectedUrl: `${base}/source` });
        sourcePage = await pageForUrl(`${base}/source`); await sourcePage.waitForSelector('#today-order-child');
        const second = await created('second-browser-standalone-top', () => apiPage.evaluate(options => chrome.tabs.create(options), { windowId, url: `${base}/second`, active: false }), { expectedUrl: `${base}/second` });
        const third = await created('third-browser-standalone-top', () => apiPage.evaluate(options => chrome.tabs.create(options), { windowId, url: `${base}/third`, active: false }), { expectedUrl: `${base}/third` });
        // Real navigation and activation retain the existing canonical and visible order.
        await input('Activate exact source without changing Today order', () => native.page.click(row(sourceId)));
        const activated = await settle([third, second, sourceId]);
        await sourcePage.evaluate(installTodayOrderTrace);
        const child = await created('trusted-served-link-child-below-exact-opener', async () => {
            await ui(sourcePage, 'Click served target=_blank rel=opener link once', () => sourcePage.click('#today-order-child'));
        }, { afterTabId: sourceId, requireOpener: true, activate: true, expectedUrl: `${base}/source-child` });
        const linkTrace = await sourcePage.evaluate(() => globalThis.__todayOrderTrace);
        assertTodayOrderInput(linkTrace, { type: 'click', elementId: 'today-order-child' });
        await checkpoint('trusted-link-native-opener-proof', { sourceId, child, linkTrace, activationBaseline: activated });
        const duplicate = await created('trusted-duplicate-below-exact-source', async () => {
            await native.page.evaluate(() => { globalThis.__todayOrderTrace.length = 0; });
            await input('Duplicate exact Today source through real context menu', async () => {
                await openFreshTabMenu({ page: native.page, selector: row(sourceId), menuSelector: '#tab-context-menu [data-action="duplicate"]' });
                await native.page.click('#tab-context-menu [data-action="duplicate"]');
            });
        }, { afterTabId: sourceId, activate: true, expectedUrl: `${base}/source` });
        const duplicateTrace = await native.page.evaluate(() => globalThis.__todayOrderTrace);
        assertTodayOrderInput(duplicateTrace, { type: 'contextmenu', tabId: sourceId }); assertTodayOrderInput(duplicateTrace, { type: 'click', action: 'duplicate' });
        await checkpoint('trusted-duplicate-proof', { sourceId, duplicate, duplicateTrace });
        const spotlight = await created('authenticated-spotlight-openTab-standalone', () => bridge('openTab', { windowId, spaceId: folder.spaceId, url: `${base}/spotlight` }), { activate: true, expectedUrl: `${base}/spotlight` });
        // A real native reorder changes this known source from bottom to top.
        const beforeDrag = await read(), beforeOrder = visibleTodayOrder(space(beforeDrag, folder.spaceId).temporaryTabs, inverted);
        await native.page.evaluate(() => { globalThis.__todayOrderTrace.length = 0; });
        await input('Drag exact bottom child before the top Today row', async () => {
            const geometry = await locateFreshDragGeometry(native.page, row(child), row(spotlight)); let down = false;
            try {
                const { from, to } = geometry; assert(from.y > to.y);
                const x = from.x + Math.min(40, from.width / 3), y = from.y + from.height / 2, tx = to.x + Math.min(40, to.width / 3), ty = to.y + 2;
                await native.page.mouse.move(x, y); await native.page.mouse.down(); down = true;
                await native.page.mouse.move(x + 12, y, { steps: 5 }); await native.page.mouse.move(tx, ty, { steps: 20 });
                await native.page.waitForFunction(() => document.querySelector('.sidebar-drop-anchor:not([hidden])')?.dataset.placement === 'before', { polling: 50 });
                await native.page.mouse.up(); down = false;
            } finally { if (down) await native.page.mouse.up(); await geometry.source.dispose(); await geometry.target.dispose(); }
        });
        const manualOrder = [child, ...beforeOrder.filter(id => id !== child)], afterDrag = await settle(manualOrder);
        assertTodayManualOrder(beforeDrag, afterDrag, { ...request(), expectedVisible: manualOrder });
        const dragTrace = await native.page.evaluate(() => globalThis.__todayOrderTrace);
        assertTodayOrderInput(dragTrace, { type: 'dragstart', tabId: child }); assertTodayOrderInput(dragTrace, { type: 'drop' }); assertTodayOrderInput(dragTrace, { type: 'dragend', tabId: child });
        await checkpoint('manual-trusted-reorder', { before: beforeDrag, after: afterDrag, manualOrder, dragTrace });
        const beforeToggle = await read(); await option('todayNewTabsAtTop', false);
        const afterToggle = await settle(manualOrder); assertTodayOrderUnchanged(beforeToggle, afterToggle, request());
        await checkpoint('prospective-setting-toggle-keeps-existing-order', { before: beforeToggle, after: afterToggle });
        const bottom = await created('future-browser-tab-at-bottom', () => apiPage.evaluate(options => chrome.tabs.create(options), { windowId, url: `${base}/bottom`, active: false }), { atTop: false, expectedUrl: `${base}/bottom` });
        const beforeSaved = await read(); assert.deepEqual(beforeSaved.rendered.savedRootIds, folder.savedIds);
        await option('invertTabOrder', true);
        const savedInverted = await poll(read, state => { try { assertTodayOrderState(state, { ...request(), expectedVisible: [...manualOrder, bottom] }); assert.deepEqual(state.rendered.savedRootIds, [...folder.savedIds].reverse()); return true; } catch { return false; } }, 'saved roots visibly reverse while exact Today order stays unchanged'); assertTodayOrderUnchanged(beforeSaved, savedInverted, request());
        assert.deepEqual(savedInverted.rendered.savedRootIds, [...folder.savedIds].reverse(), 'Legacy setting still controls only saved pins/folders.');
        await option('invertTabOrder', false);
        const savedNormal = await poll(read, state => { try { assertTodayOrderState(state, { ...request(), expectedVisible: [...manualOrder, bottom] }); assert.deepEqual(state.rendered.savedRootIds, folder.savedIds); return true; } catch { return false; } }, 'saved roots visibly return while exact Today order stays unchanged'); assertTodayOrderUnchanged(beforeSaved, savedNormal, request()); assert.deepEqual(savedNormal.rendered.savedRootIds, folder.savedIds);
        await checkpoint('saved-setting-independence', { before: beforeSaved, inverted: savedInverted, normal: savedNormal });
        await option('todayNewTabsAtTop', true); await settle([...manualOrder, bottom]);
        // Paired fallback is intentionally exercised with the actual companion
        // disconnected. Only existing option controls change pairing; no reinstall.
        const beforeFallback = await read();
        await ui(apiPage, 'Disconnect companion for one real New Tab row fallback', async () => { await apiPage.click('#bridgeDisconnect'); await apiPage.waitForSelector('#bridgeStatus[data-state="disabled"]'); }); disconnected = true;
        await apiPage.evaluate(async ({ id, windowId }) => { await chrome.tabs.update(id, { active: true }); await chrome.windows.update(windowId, { focused: true }); }, { id: sourceId, windowId }); await select();
        // snapshot() is authenticated and correctly rejects while disconnected,
        // so reconnect after the single click before comparing exact identities.
        await native.page.evaluate(() => { globalThis.__todayOrderTrace.length = 0; });
        await input('Click native New Tab row once while companion is disconnected', () => native.page.click('#newTabBtn'));
        await native.page.waitForFunction(() => document.getElementById('newTabBtn')?.getAttribute('aria-busy') === 'false' && document.getElementById('spotlightStatus')?.textContent === '', { polling: 50 });
        const fallbackTrace = await native.page.evaluate(() => globalThis.__todayOrderTrace); assertTodayOrderInput(fallbackTrace, { type: 'click', elementId: 'newTabBtn' });
        const fallback = await apiPage.evaluate(async ids => { const added = (await chrome.tabs.query({})).filter(tab => !ids.includes(tab.id)); if (added.length !== 1) throw new Error('Expected one exact fallback receipt.'); return { id: added[0].id, windowId: added[0].windowId, url: added[0].url }; }, beforeFallback.tabs.map(tab => tab.id));
        owned.add(fallback.id); assert.equal(fallback.windowId, windowId); assert.equal(fallback.url, 'chrome://newtab/');
        await reconnect(); await apiPage.evaluate(async ({ id, windowId }) => { await chrome.tabs.update(id, { active: true }); await chrome.windows.update(windowId, { focused: true }); }, { id: fallback.id, windowId }); await select();
        const afterFallback = await poll(read, state => { try { assertTodayCreated(beforeFallback, state, { ...request(), atTop: true, activate: true, expectedUrl: 'chrome://newtab/' }); return true; } catch { return false; } }, 'exact completed fallback identity at visible Today top after pairing reconnects');
        assertTodayCreated(beforeFallback, afterFallback, { ...request(), atTop: true, activate: true, expectedUrl: 'chrome://newtab/' });
        await checkpoint('native-row-unpaired-fallback-standalone', { before: beforeFallback, after: afterFallback, fallback, fallbackTrace });
        await native.page.evaluate(() => { globalThis.__todayOrderTrace.length = 0; });
        await input('Reuse the active exact browser New Tab through paired native row', () => native.page.click('#newTabBtn'));
        await native.page.waitForFunction(() => document.getElementById('newTabBtn')?.getAttribute('aria-busy') === 'false' && document.getElementById('spotlightStatus')?.textContent === '', { polling: 50 });
        const reused = await settle([fallback.id, ...manualOrder, bottom]); assertTodayOrderUnchanged(afterFallback, reused, request());
        assert.deepEqual(reused.tabs, afterFallback.tabs, 'Paired New Tab reuse cannot navigate, activate another tab, regroup or reorder the existing native identities.');
        const reuseTrace = await native.page.evaluate(() => globalThis.__todayOrderTrace); assertTodayOrderInput(reuseTrace, { type: 'click', elementId: 'newTabBtn' });
        await checkpoint('paired-native-row-reuse-keeps-order', { before: afterFallback, after: reused, reuseTrace });
        // Activation, same-ID URL navigation and paired activation do not create
        // or reorder Today. The known source is deliberately not the first row.
        const unchanged = await read(); await bridge('activateTab', { windowId, tabId: sourceId });
        const navigation = sourcePage.waitForNavigation({ waitUntil: 'domcontentloaded' });
        await bridge('navigateTab', { windowId, tabId: sourceId, url: `${base}/source-navigated` }); await navigation;
        const afterNavigation = await settle([fallback.id, ...manualOrder, bottom]); assertTodayOrderUnchanged(unchanged, afterNavigation, request());
        await checkpoint('activation-and-navigation-retain-order', { before: unchanged, after: afterNavigation });
        await screenshot(native.page, `today-order-sync-${groupSync}-native-panel`, true);
        // Close the exact panel helper and observe all three authorities before
        // the witnessed reload baseline; a lingering helper cannot be ignored.
        const closedHelper = await native.close(); native = null;
        const beforeReload = await controlState(await waitForTodayMoveHelperCleanup({ read, poll, closedHelper }));
        const observerBefore = await peerPage.evaluate(readFixturePageIdentity);
        await peerPage.evaluate(() => {
            const trace = globalThis.__todayOrderReloadEvents = { created: [], removed: [] };
            const created = tab => trace.created.push({ id: tab.id, windowId: tab.windowId, url: tab.url, pendingUrl: tab.pendingUrl });
            const removed = (tabId, info) => trace.removed.push({ tabId, windowId: info.windowId, isWindowClosing: info.isWindowClosing });
            chrome.tabs.onCreated.addListener(created); chrome.tabs.onRemoved.addListener(removed);
            globalThis.__stopTodayOrderReloadEvents = () => { chrome.tabs.onCreated.removeListener(created); chrome.tabs.onRemoved.removeListener(removed); };
        });
        const reloaded = await reloadArcify(); apiPage = reloaded.arcifyOptions;
        const observerAfter = await peerPage.evaluate(readFixturePageIdentity);
        const afterReload = await poll(async () => {
            const state = await controlState(await read());
            state.nativeEvents = await peerPage.evaluate(() => globalThis.__todayOrderReloadEvents); return state;
        }, state => {
            try {
                const proof = { name: 'arcify', controlWindowId, lifecycle: reloaded.evidence, observerBefore, observerAfter, nativeEvents: state.nativeEvents };
                const controls = assertReloadFixtureProvenance(beforeReload, state, { arcifyId, spotlightId }, proof);
                same(beforeReload, state, ['spaces', 'bookmarks', 'bindings', 'aliases', 'favorites', 'representation']);
                assertReloadWindowSelection(beforeReload, state);
                assert.deepEqual(state.tabs.filter(tab => !controls.after.has(tab.id)).map(identity), beforeReload.tabs.filter(tab => !controls.before.has(tab.id)).map(identity));
                reloadReceipt = { proof, beforeIds: [...controls.before], afterIds: [...controls.after], beforePages: beforeReload.fixturePages.pages, afterPages: state.fixturePages.pages };
                return true;
            } catch { return false; }
        }, 'same exact content identities survive witnessed reload with only proven control-page replacements');
        await peerPage.evaluate(() => globalThis.__stopTodayOrderReloadEvents());
        native = await nativeSidebar(); await select();
        // The panel-opening helper itself is a genuine standalone creation in
        // this Space. Include its exact receipt in the order, then close it.
        const postOpen = await read(), newHelper = postOpen.tabs.filter(tab => !afterReload.tabs.some(old => old.id === tab.id)); assert.equal(newHelper.length, 1);
        const reloadedOrder = [newHelper[0].id, fallback.id, ...manualOrder, bottom]; await settle(reloadedOrder);
        await checkpoint('witnessed-reload-preserves-manual-and-created-order', { lifecycle: reloaded.evidence, controlReplacement: reloadReceipt, before: beforeReload, after: afterReload, rendered: (await read()).rendered, helperId: newHelper[0].id });
        return evidence;
    } catch (error) {
        primaryError = error; await checkpoint('today-order-failed', { error: { message: error.message, stack: error.stack }, owned: [...owned] }).catch(() => {});
        if (native?.page) await screenshot(native.page, `today-order-sync-${groupSync}-failure`, false).catch(() => {}); throw error;
    } finally {
        await finishBookmarkFixture([
            async () => { await peerPage.evaluate(() => globalThis.__stopTodayOrderReloadEvents?.()); if (disconnected) await reconnect(); },
            async () => { if (native) { await native.close(); native = null; } },
            () => apiPage.evaluate(async ids => { const live = new Set((await chrome.tabs.query({})).map(tab => tab.id)); const exact = ids.filter(id => live.has(id)); if (exact.length) await chrome.tabs.remove(exact); }, [...owned]),
            async () => { if (folder) await cleanupNewTabFixtureSpace({ apiPage, folder, snapshot: () => snapshot(windowId), poll }); },
            () => option('syncTabGroups', Boolean(settings.syncTabGroups)), () => option('invertTabOrder', settings.invertTabOrder !== false), () => option('todayNewTabsAtTop', settings.todayNewTabsAtTop !== false),
            async () => {
                for (const [window, spaceId] of Object.entries(initial.activeSpaces).filter(([id]) => initial.windows.some(window => window.id === Number(id)))) await bridge('activateSpace', { windowId: Number(window), spaceId });
                const activeTabs = initial.tabs.filter(tab => tab.active).map(tab => {
                    if (!reloadReceipt?.beforeIds.includes(tab.id)) return tab.id;
                    const old = reloadReceipt.beforePages.find(page => page.tab.id === tab.id);
                    const replacement = reloadReceipt.afterPages.find(page => page.extensionId === old.extensionId && page.documentUrl === old.documentUrl);
                    assert(replacement, 'An initially active fixture endpoint needs its exact witnessed replacement to restore focus.'); return replacement.tab.id;
                });
                await apiPage.evaluate(async ({ activeTabs, windows }) => { for (const id of activeTabs) await chrome.tabs.update(id, { active: true }); const focused = windows.find(window => window.focused); if (focused) await chrome.windows.update(focused.id, { focused: true }); }, { activeTabs, windows: initial.windows });
                const restored = await poll(async () => controlState(await read()), state => { try {
                    same(initial, state, ['spaces', 'bookmarks', 'bindings', 'aliases', 'favorites', 'representation', 'windows']);
                    assertFixturePageObservation(state, { arcifyId, spotlightId }); assertReloadWindowSelection(initial, state);
                    const beforeIds = reloadReceipt?.beforeIds || [], afterIds = reloadReceipt?.afterIds || [];
                    const retained = (tabs, excluded) => tabs.filter(tab => !excluded.includes(tab.id)).map(tab => ({ ...identity(tab), active: tab.active }));
                    assert.deepEqual(retained(state.tabs, afterIds), retained(initial.tabs, beforeIds));
                    assert.deepEqual(state.tabs.filter(tab => tab.active).map(tab => tab.id).sort((a,b)=>a-b), [...activeTabs].sort((a,b)=>a-b)); return true;
                } catch { return false; } }, 'fixture cleanup restores every original content identity, bookmark order, Space and window focus');
                await checkpoint('fixture-isolation-restored', { initialSpaceId, state: restored });
            }
        ], primaryError, record);
    }
}
