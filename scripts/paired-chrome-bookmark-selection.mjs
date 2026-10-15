/** Real modifiers/native drag proof for sidebar bookmark batches. Never launches Chrome on import. */
import assert from 'node:assert/strict';
import { readFavoritesDropMarker, assertFavoritesDropMarker, favoriteDragInputClient } from './paired-chrome-favorites-marker.mjs';
import { readMarkerScreenshotPixels, assertMarkerScreenshotPixels } from './paired-chrome-space-marker.mjs';
import { clickFreshResult } from './paired-chrome-ui.mjs';

export function assertNativeDragSourceStable(observation) {
    assert.equal(observation.startCount, 1, 'Exactly one native dragstart must precede this observation.');
    assert.equal(observation.trusted, true, 'Geometry must belong to the actual native dragstart.');
    assert.equal(observation.selectorMatches, true, 'Native dragstart must originate on the exact intended source.');
    assert.equal(observation.connected, true, 'The actual native drag source must remain connected.');
    for (const field of ['y', 'height']) {
        assert(Number.isFinite(observation.startRect?.[field]) && Number.isFinite(observation.rect?.[field]));
        assert(Math.abs(observation.rect[field] - observation.startRect[field]) < 1, 'Selection feedback must not move or resize the native drag source.');
    }
}

export async function clickBookmarkFixtureRow(page, selector, modifiers, record = async () => {}) {
    for (const key of modifiers) await page.keyboard.down(key);
    try {
        // The existing bounded helper reacquires only a proven pre-input
        // assertConnectedElement failure, never an uncertain delivered click.
        await clickFreshResult(timeout => page.waitForSelector(selector, { visible: true, timeout }),
            observation => record({ phase: 'bookmark-click', selector, ...observation }));
    } finally { for (const key of [...modifiers].reverse()) await page.keyboard.up(key); }
}

export function installBookmarkDragTrace() {
    globalThis.__pairedBatchDragEvents = [];
    if (globalThis.__pairedBatchDragObserved) return;
    globalThis.__pairedBatchDragObserved = true;
    for (const type of ['dragstart','dragend','drop']) document.addEventListener(type, event => {
        globalThis.__pairedBatchDragEvents.push({ type, trusted: event.isTrusted, bookmarkId: event.target.closest?.('.tab')?.dataset.bookmarkId ?? null, dropEffect: event.dataTransfer?.dropEffect ?? null });
    }, { capture: true, passive: true });
}
export async function cancelHeldBookmarkDrag(page) {
    await favoriteDragInputClient(page).send('Input.cancelDragging').catch(() => {});
    const ended = await page.evaluate(() => !document.querySelector('.dragging') && globalThis.__pairedBatchDragEvents?.some(event => event.type === 'dragend' && event.trusted)).catch(() => false);
    if (ended) await page.mouse.up().catch(() => {});
}

// Cleanup failures remain hard failures, but cannot erase the original input or
// assertion failure. Run independent cleanup operations even if one fails.
export async function finishBookmarkFixture(cleanups, primaryError, record = async () => {}) {
    const errors = [];
    for (const cleanup of cleanups) {
        try { await cleanup(); } catch (error) { errors.push(error); }
    }
    if (!errors.length) return;
    const messages = errors.map(error => error.message);
    try { await record({ phase: 'cleanup-failed', errors: messages }); } catch (error) { messages.push(`Evidence: ${error.message}`); }
    if (primaryError) primaryError.cleanupErrors = messages;
    else throw new AggregateError(errors, `Bookmark fixture cleanup failed: ${messages.join('; ')}`);
}

export async function cleanupBookmarkFavoritesInSourceWindow({ windowId, ids }) {
    const current = await chrome.tabs.getCurrent();
    if (current?.windowId !== windowId) throw new Error('Bookmark cleanup requires its exact source window.');
    const state = await chrome.runtime.sendMessage({ type: 'favoriteStore', action: 'get', windowId });
    if (!state.success) throw new Error(state.error || 'Fixture cleanup could not read Favorites.');
    const targets = state.favorites.filter(item => ids.includes(item.sourceBookmarkId));
    const tabIds = targets.map(item => item.tabId).filter(Number.isInteger);
    for (const item of targets) {
        const result = await chrome.runtime.sendMessage({ type: 'favoriteStore', action: 'remove', windowId, favoriteId: item.id });
        if (!result.success) throw new Error(result.error);
    }
    return tabIds;
}

export function readBookmarkSelection() {
    const selected = [...document.querySelectorAll('.space.active .tab.bookmark-selected')];
    const status = document.getElementById('bookmarkSelectionStatus');
    return { ids: selected.map(node => node.dataset.bookmarkId),
        rows: selected.map(node => ({ id: node.dataset.bookmarkId, ariaSelected: node.getAttribute('aria-selected'),
            visible: Boolean(node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden') })),
        count: Number(status?.dataset.count), text: status?.textContent || '' };
}
export function assertBookmarkSelection(state, expected) {
    assert.deepEqual(state.ids, expected, 'Selection must follow the exact visible bookmark order.');
    assert.equal(new Set(state.ids).size, state.ids.length, 'One bookmark identity cannot be counted twice.');
    assert.equal(state.count, expected.length, 'Visible selection feedback must announce the whole selection.');
    assert.deepEqual(state.rows.map(row => row.id), expected);
    for (const row of state.rows) { assert.equal(row.ariaSelected, 'true'); assert.equal(row.visible, true); }
    return state;
}
const flatten = nodes => nodes.flatMap(node => [node, ...flatten(node.children || [])]);
export function assertBatchFavoriteResult(before, after, { bookmarkIds, beforeId, newCount }) {
    assert(bookmarkIds.length > 1 && new Set(bookmarkIds).size === bookmarkIds.length);
    const existing = new Map(before.favorites.map(item => [item.id, item]));
    const sources = new Map(flatten(before.bookmarks).map(item => [item.id, item]));
    const batch = bookmarkIds.map(bookmarkId => {
        const matches = after.favorites.filter(item => item.sourceBookmarkId === bookmarkId);
        assert.equal(matches.length, 1, 'Each exact bookmark must own one saved Favorite.');
        const item = matches[0], source = sources.get(bookmarkId); assert(source?.url);
        assert.equal(item.url, source.url); assert.equal(item.title, source.title);
        const prior = before.favorites.find(item => item.sourceBookmarkId === bookmarkId);
        if (prior) { assert.equal(item.id, prior.id); assert.equal(item.tabId, prior.tabId, 'Repeat must reuse the same exact live instance.'); }
        const tab = after.tabs.find(tab => tab.id === item.tabId);
        assert(tab && tab.windowId === before.windowId && tab.pinned && !tab.active && !tab.incognito);
        return item;
    });
    assert.equal(new Set(batch.map(item => item.id)).size, bookmarkIds.length);
    assert.equal(new Set(batch.map(item => item.tabId)).size, bookmarkIds.length, 'Same-URL bookmarks require separate live identities.');
    const moving = new Set(batch.map(item => item.id));
    const others = before.favorites.filter(item => !moving.has(item.id));
    const index = beforeId === null ? others.length : others.findIndex(item => item.id === beforeId);
    assert(index >= 0, 'Fixture uses an exact unselected destination anchor.');
    const order = [...others.slice(0, index), ...batch, ...others.slice(index)].map(item => item.id);
    assert.deepEqual(after.favorites.map(item => item.id), order);
    for (const [id, original] of existing) {
        const current = after.favorites.find(item => item.id === id); assert(current);
        for (const key of ['id', 'title', 'url', 'sourceBookmarkId', 'tabId']) assert.equal(current[key], original[key], 'Existing records and bindings stay unchanged, except their array order.');
    }
    assert.equal(after.favorites.length, before.favorites.length + newCount);
    assert.equal(after.tabs.length, before.tabs.length + newCount);
    for (const original of before.tabs) {
        const current = after.tabs.find(tab => tab.id === original.id); assert(current, 'Batch cannot close an existing tab.');
        for (const key of ['windowId', 'url', 'pinned', 'active', 'incognito', 'groupId']) assert.equal(current[key], original[key], `Existing tab ${original.id}: ${key}`);
    }
    const oldTabIds = new Set(before.tabs.map(tab => tab.id));
    for (const added of after.tabs.filter(tab => !oldTabIds.has(tab.id))) assert(batch.some(item => item.tabId === added.id));
    assert.deepEqual(after.bookmarks, before.bookmarks, 'All source bookmarks, parent IDs and ordering must survive.');
    assert.deepEqual(after.spaces, before.spaces, 'Batch must not switch or reassign any Space.');
    assert.deepEqual(after.windows, before.windows);
    const otherBindings = new Map(before.otherFavorites.map(item => [item.id, item.tabId]));
    const favoriteFields = ({ id, title, url, sourceBookmarkId, tabId }) => ({ id, title, url, sourceBookmarkId, tabId });
    assert.deepEqual(after.otherFavorites.map(favoriteFields), after.favorites.map(favoriteFields).map(({ tabId, ...item }) => ({ ...item, tabId: otherBindings.get(item.id) ?? null })), 'Other window shares saved order without adopting or opening live instances.');
    return { favoriteIds: batch.map(item => item.id), tabIds: batch.map(item => item.tabId), order };
}

export async function exerciseBookmarkMultiSelection({ apiPage, newTabPage, ui, screenshot, screenshotBytes, snapshot, poll, fixture, arcifyId, record = async () => {} }) {
    const initial = await snapshot(), space = initial.spaces.find(item => item.id === initial.activeSpaceId);
    assert(space?.bookmarkFolderId);
    const seed = await apiPage.evaluate(async ({ parentId, base }) => {
        const root = await chrome.bookmarks.create({ parentId, title: 'Batch Selection Fixture' });
        try {
        const a = await chrome.bookmarks.create({ parentId: root.id, title: 'Batch A', url: `${base}/favorite-persistent` });
        const open = await chrome.bookmarks.create({ parentId: root.id, title: 'Batch Open Folder' });
        const b = await chrome.bookmarks.create({ parentId: open.id, title: 'Batch B', url: `${base}/batch-b` });
        const closed = await chrome.bookmarks.create({ parentId: root.id, title: 'Batch Closed Folder' });
        const hidden = await chrome.bookmarks.create({ parentId: closed.id, title: 'Batch Hidden', url: `${base}/batch-hidden` });
        const d = await chrome.bookmarks.create({ parentId: root.id, title: 'Batch D Same URL', url: `${base}/favorite-persistent` });
        const e = await chrome.bookmarks.create({ parentId: root.id, title: 'Batch E', url: `${base}/batch-e` });
        const control = await chrome.bookmarks.create({ parentId: root.id, title: 'Batch Disposable Control', url: `${base}/batch-control` });
        return { root, a, open, b, closed, hidden, d, e, control };
        } catch (error) { try { await chrome.bookmarks.removeTree(root.id); } catch (cleanup) { error.cleanupError = cleanup.message; } throw error; }
    }, { parentId: space.bookmarkFolderId, base: fixture.base });
    let sidebar;
    try { sidebar = await newTabPage(`chrome-extension://${arcifyId}/sidebar.html`); }
    catch (error) { try { await apiPage.evaluate(id => chrome.bookmarks.removeTree(id), seed.root.id); } catch (cleanup) { error.cleanupError = cleanup.message; } throw error; }
    const page = sidebar.page;
    const row = id => `.space.active .tab[data-bookmark-id="${id}"]`;
    const folder = id => `.space.active .folder[data-bookmark-id="${id}"]`;
    const leafIds = [seed.a.id, seed.b.id, seed.hidden.id, seed.d.id, seed.e.id, seed.control.id];
    const read = async () => {
        const data = await apiPage.evaluate(async windowId => {
            const bookmark = ({ id, parentId, index, title, url, children }) => ({ id, parentId, index, title,
                ...(url === undefined ? {} : { url }), ...(children ? { children: children.map(bookmark) } : {}) });
            return { windowId, bookmarks: (await chrome.bookmarks.getTree()).map(bookmark),
                tabs: (await chrome.tabs.query({})).map(({ id, windowId, index, url, pinned, active, incognito, groupId }) => ({ id, windowId, index, url, pinned, active, incognito, groupId })).sort((a,b) => a.id-b.id),
                windows: (await chrome.windows.getAll({ windowTypes: ['normal'] })).map(({ id, type, incognito }) => ({ id, type, incognito })).sort((a,b) => a.id-b.id) };
        }, fixture.windowA);
        const state = await snapshot();
        const fields = ({ id, title, url, sourceBookmarkId, tabId }) => ({ id, title, url, sourceBookmarkId, tabId });
        data.favorites = state.favorites.map(fields);
        data.spaces = [];
        for (const windowId of [fixture.windowA, fixture.windowB]) {
            const state = windowId === fixture.windowA ? await snapshot() : await snapshot(windowId);
            if (windowId === fixture.windowB) data.otherFavorites = state.favorites.map(fields);
            data.spaces.push({ windowId, activeSpaceId: state.activeSpaceId,
                spaces: state.spaces.map(({ id, tabIds, pinnedTabIds, temporaryTabIds }) => ({ id, tabIds, pinnedTabIds, temporaryTabIds })) });
        }
        return data;
    };
    const selection = async expected => {
        await poll(() => page.evaluate(readBookmarkSelection), state => JSON.stringify(state.ids) === JSON.stringify(expected), 'exact visible bookmark selection');
        return assertBookmarkSelection(await page.evaluate(readBookmarkSelection), expected);
    };
    const click = (selector, modifiers = []) => ui(page, `Bookmark input ${modifiers.join('+') || 'plain'} ${selector}`,
        () => clickBookmarkFixtureRow(page, selector, modifiers, record));
    const setExpanded = async (id, expanded) => {
        await page.waitForSelector(folder(id));
        if (await page.$eval(folder(id), node => node.classList.contains('collapsed')) === expanded) await click(`${folder(id)} > .folder-header`);
        await page.waitForFunction(({ selector, expanded }) => document.querySelector(selector)?.classList.contains('collapsed') === !expanded, { polling: 50 }, { selector: folder(id), expanded });
    };
    const observations = [];
    let ordinaryTabId = null, primaryError = null;
    const originalInvert = await apiPage.$eval('#invertTabOrder', element => element.checked);
    const drag = async ({ sourceId, beforeId, expectedIds, label, afterStart }) => ui(page, label, async () => {
        const targetSelector = `#pinnedFavicons .saved-favorite[data-favorite-id="${beforeId}"]`;
        await page.waitForSelector(targetSelector);
        const source = await page.$(row(sourceId)), target = await page.$(targetSelector);
        let held = false;
        const operation = await page.$eval('#pinnedFavicons', node => Number(node.dataset.dropOperation || 0));
        await page.evaluate(installBookmarkDragTrace);
        try {
            await source.scrollIntoView();
            const from = await source.boundingBox(), to = await target.boundingBox(); assert(from && to);
            await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
            await page.mouse.down(); held = true;
            await page.mouse.move(from.x + from.width / 2 + 15, from.y + from.height / 2, { steps: 5 });
            await page.waitForFunction(() => document.querySelectorAll('.dragging').length === 1, { polling: 50 });
            if (afterStart) await afterStart();
            await page.mouse.move(to.x + 3, to.y + to.height / 2, { steps: 18 });
            if (!afterStart) {
                await page.waitForFunction(beforeId => { const marker = document.querySelector('.favorites-drop-anchor'); return marker && !marker.hidden && marker.dataset.beforeId === beforeId; }, { polling: 50 }, beforeId);
                const selected = await selection(expectedIds), marker = await page.evaluate(readFavoritesDropMarker);
                // External bookmark batches have no saved-Favorite source icon.
                assertFavoritesDropMarker(marker, { sourceId: undefined, anchorId: beforeId, beforeId, placement: 'before' });
                const preview = await page.$eval('.bookmark-drag-preview', node => { const rect = node.getBoundingClientRect(); return { count: Number(node.dataset.count), text: node.textContent, width: rect.width, height: rect.height, visible: getComputedStyle(node).display !== 'none' }; });
                assert.equal(preview.count, expectedIds.length); assert(preview.text.includes(String(expectedIds.length)) && preview.visible && preview.width > 0 && preview.height > 0);
                const status = await page.$eval('#favoritesDropStatus', node => node.textContent);
                assert(status.includes(String(expectedIds.length)), 'Batch hover must announce its count.');
                const shot = await screenshot(page, label, true, { fullPage: false });
                const pixels = await page.evaluate(readMarkerScreenshotPixels, { base64: (await screenshotBytes(shot)).toString('base64'), marker });
                const evidence = { label, selected, marker, preview, status, paint: assertMarkerScreenshotPixels(pixels, marker), from, to };
                observations.push(evidence); await record(evidence);
            }
            await page.mouse.up(); held = false;
            if (!afterStart) {
                await page.waitForFunction(previous => Number(document.getElementById('pinnedFavicons').dataset.dropOperation || 0) > previous && document.getElementById('pinnedFavicons').getAttribute('aria-busy') === 'false', { polling: 50 }, operation);
                const status = await page.$eval('#pinnedFavicons', node => ({ state: node.dataset.dropState, message: document.getElementById('favoritesDropStatus').textContent }));
                assert.equal(status.state, 'success', JSON.stringify(status)); await record({ label, completed: status });
            } else {
                await page.waitForFunction(() => !document.querySelector('.dragging') && document.getElementById('pinnedFavicons').getAttribute('aria-busy') !== 'true', { polling: 50 });
                const result = await page.$eval('#pinnedFavicons', node => ({ operation: Number(node.dataset.dropOperation || 0), state: node.dataset.dropState, message: document.getElementById('favoritesDropStatus').textContent }));
                assert([operation, operation + 1].includes(result.operation), 'A stale drop must never retry or dispatch more than once.');
                if (result.operation === operation + 1) assert.equal(result.state, 'error', JSON.stringify(result));
                else assert.match(result.message, /changed|stale|refresh|again|removed|deleted/i);
                await record({ label, staleRejection: result });
            }
        } catch (error) {
            const failure = { label, phase: 'failed-before-cleanup', error: error.message };
            try { failure.events = await page.evaluate(() => globalThis.__pairedBatchDragEvents); failure.selection = await page.evaluate(readBookmarkSelection); } catch (observation) { failure.observationError = observation.message; }
            try { await record(failure); } catch (observation) { error.diagnosticError = observation.message; }
            throw error;
        } finally {
            if (held) await cancelHeldBookmarkDrag(page);
            await source?.dispose(); await target?.dispose();
        }
    });
    try {
        // Previous cases restore the user's default (inverted) order. This
        // scenario deliberately asserts A→B→D, so select that display mode via
        // the actual options UI rather than silently sorting observed rows.
        if (originalInvert) await ui(apiPage, 'Use normal visible order for bookmark selection fixture', () => apiPage.click('label.toggle-label[for="invertTabOrder"]'));
        await poll(() => apiPage.evaluate(() => chrome.storage.sync.get('invertTabOrder')), settings => settings.invertTabOrder === false, 'explicit non-inverted bookmark selection ordering');
        await page.waitForSelector(`.space.active[data-space-id="${space.id}"]`);
        await setExpanded(seed.root.id, true); await setExpanded(seed.open.id, true); await setExpanded(seed.closed.id, false);
        for (const id of [seed.a.id, seed.b.id, seed.d.id, seed.e.id]) await page.waitForSelector(row(id), { visible: true });
        assert.equal(await page.$eval(row(seed.hidden.id), node => node.getClientRects().length), 0);
        const visibleOrder = [seed.a.id, seed.b.id, seed.d.id, seed.e.id, seed.control.id];
        await poll(() => page.evaluate(ids => [...document.querySelectorAll('.space.active .tab[data-bookmark-id]')]
            .filter(node => ids.includes(node.dataset.bookmarkId) && node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden')
            .map(node => node.dataset.bookmarkId), visibleOrder), ids => JSON.stringify(ids) === JSON.stringify(visibleOrder), 'rendered normal bookmark order before any selection');
        const beforeOrdinary = await read();
        await click(row(seed.d.id));
        const opened = await poll(() => apiPage.evaluate(async ({ windowId, old }) => (await chrome.tabs.query({ windowId })).filter(tab => !old.includes(tab.id)), { windowId: fixture.windowA, old: beforeOrdinary.tabs.map(tab => tab.id) }),
            tabs => tabs.length === 1 && tabs[0].active && tabs[0].url === seed.d.url, 'ordinary bookmark click retains normal activation');
        ordinaryTabId = opened[0].id;
        await click(row(seed.a.id), ['Shift']);
        await selection([seed.a.id, seed.b.id, seed.d.id]);
        await screenshot(page, 'ordinary-bookmark-activation-preserves-logical-shift-anchor');
        await ui(page, 'Clear selected range before closing fixture instance', () => page.keyboard.press('Escape'));
        await apiPage.evaluate(id => chrome.tabs.remove(id), opened[0].id);
        await page.waitForSelector(`${row(seed.d.id)}.bookmark-only`);
        const beforeFavicon = await read();
        await click(`${row(seed.a.id)} .tab-favicon`, ['Control']); await selection([seed.a.id]);
        assert.deepEqual(await read(), beforeFavicon, 'Modifier click on the favicon selects without child-handler navigation.');
        await click(`${row(seed.control.id)} .tab-remove`, ['Control']);
        await page.waitForFunction(id => !document.querySelector(`.tab[data-bookmark-id="${id}"]`), { polling: 50 }, seed.control.id);
        await selection([]);
        const afterControl = await read();
        assert(!flatten(afterControl.bookmarks).some(item => item.id === seed.control.id));
        assert.deepEqual(afterControl.tabs, beforeFavicon.tabs, 'Modifier click on Remove Pin remains a single bookmark control action, not activation.');
        assert.deepEqual(afterControl.favorites, beforeFavicon.favorites);
        await screenshot(page, 'bookmark-modifier-control-keeps-explicit-remove-action');
        const beforeSelection = await read();
        await click(row(seed.a.id), ['Control']); await selection([seed.a.id]);
        await click(row(seed.d.id), ['Shift']); await selection([seed.a.id, seed.b.id, seed.d.id]);
        await screenshot(page, 'bookmark-shift-range-skips-collapsed-descendants');
        await click(row(seed.b.id), ['Control']); await selection([seed.a.id, seed.d.id]);
        await click(row(seed.e.id), ['Control']); await selection([seed.a.id, seed.d.id, seed.e.id]);
        await click(row(seed.a.id), ['Control', 'Shift']); await selection([seed.a.id, seed.b.id, seed.d.id, seed.e.id]);
        await ui(page, 'Escape clears bookmark selection without activating a bookmark', () => page.keyboard.press('Escape'));
        await selection([]);
        assert.deepEqual(await read(), beforeSelection, 'Modifier selection and Escape alone must not mutate tabs, Favorites, Spaces or bookmarks.');
        await click(row(seed.a.id), ['Control']); await click(row(seed.d.id), ['Shift']);
        const chosen = [seed.a.id, seed.b.id, seed.d.id]; await selection(chosen);
        const beforeRejectedDestination = await read();
        await ui(page, 'Selected batch cannot fall through into a legacy folder move', async () => {
            const source = await page.$(row(seed.d.id)), target = await page.$(`${folder(seed.closed.id)} > .folder-header`);
            let held = false;
            await page.evaluate(installBookmarkDragTrace);
            try {
                await source.scrollIntoView();
                const from = await source.boundingBox(), to = await target.boundingBox(); assert(from && to);
                await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2); await page.mouse.down(); held = true;
                await page.mouse.move(from.x + from.width / 2 + 15, from.y + from.height / 2, { steps: 5 });
                await page.waitForFunction(() => document.querySelector('.dragging'), { polling: 50 });
                await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
                // Negative hover proof exceeds the production folder's 250 ms auto-open delay.
                const hover = await page.evaluate(async selector => { await new Promise(resolve => setTimeout(resolve, 400));
                    return { collapsed: document.querySelector(selector)?.classList.contains('collapsed'),
                        lineVisible: [...document.querySelectorAll('.sidebar-drop-anchor')].some(node => !node.hidden),
                        inside: Boolean(document.querySelector('.sidebar-drop-inside')) };
                }, folder(seed.closed.id));
                assert.deepEqual(hover, { collapsed: true, lineVisible: false, inside: false });
                await selection(chosen); await screenshot(page, 'bookmark-batch-rejects-legacy-folder-destination');
                await page.mouse.up(); held = false;
                await page.waitForFunction(() => !document.querySelector('.dragging'), { polling: 50 });
                const events = await page.evaluate(() => globalThis.__pairedBatchDragEvents);
                assert(events.some(event => event.type === 'dragstart' && event.trusted && event.bookmarkId === seed.d.id));
                assert(events.some(event => event.type === 'dragend' && event.trusted));
                await record({ label: 'legacy-folder-rejection', hover, events });
            } catch (error) { await record({ label: 'legacy-folder-rejection', error: error.message, events: await page.evaluate(() => globalThis.__pairedBatchDragEvents).catch(() => []) }); throw error; }
            finally { if (held) await cancelHeldBookmarkDrag(page); await source?.dispose(); await target?.dispose(); }
        });
        assert.deepEqual(await read(), beforeRejectedDestination, 'Legacy folder drop must not move only the physical row or any selected source.');
        await selection(chosen);
        const before = await read(), anchor = before.favorites[0]?.id; assert(anchor, 'An unrelated saved Favorite supplies the insertion boundary.');
        await drag({ sourceId: seed.d.id, beforeId: anchor, expectedIds: chosen, label: 'selected-bookmark-batch-native-drag-count-and-destination' });
        await poll(async () => { const state = await snapshot(); const favorites = state.favorites.filter(item => chosen.includes(item.sourceBookmarkId));
            return apiPage.evaluate(async favorites => (await Promise.all(favorites.map(async item => ({ favorite: item, tab: await chrome.tabs.get(item.tabId) })))), favorites);
        }, entries => entries.length === chosen.length && entries.every(({ favorite, tab }) => tab.status === 'complete' && tab.url === favorite.url), 'all batch-created local pages finish before reuse assertions');
        const first = await read(), firstProof = assertBatchFavoriteResult(before, first, { bookmarkIds: chosen, beforeId: anchor, newCount: 3 });
        await screenshot(page, 'bookmark-batch-creates-distinct-native-pins-and-preserves-sources');
        await ui(page, 'Reset selection before repeated exact batch', () => page.keyboard.press('Escape'));
        await click(row(seed.a.id), ['Control']); await click(row(seed.d.id), ['Shift']); await selection(chosen);
        await drag({ sourceId: seed.a.id, beforeId: anchor, expectedIds: chosen, label: 'repeated-bookmark-batch-reuses-exact-instances' });
        const repeated = await read(), repeatProof = assertBatchFavoriteResult(first, repeated, { bookmarkIds: chosen, beforeId: anchor, newCount: 0 });
        await ui(page, 'Reset selection before stale-source test', () => page.keyboard.press('Escape'));
        await click(row(seed.a.id), ['Control']); await click(row(seed.e.id), ['Control']); await selection([seed.a.id, seed.e.id]);
        let afterDeletion;
        await drag({ sourceId: seed.a.id, beforeId: anchor, expectedIds: [seed.a.id, seed.e.id], label: 'deleted-frozen-batch-member-rejects-drop', afterStart: async () => {
            await apiPage.evaluate(id => chrome.bookmarks.remove(id), seed.e.id);
            afterDeletion = await read();
        } });
        assert.deepEqual(await read(), afterDeletion, 'Stale batch drop cannot create, reorder or close anything.');
        await screenshot(page, 'deleted-batch-member-shows-no-drop-destination');
        await ui(page, 'Clear stale drag selection before reload', () => page.keyboard.press('Escape'));
        await click(row(seed.a.id), ['Control']); await click(row(seed.d.id), ['Control']); await selection([seed.a.id, seed.d.id]);
        await page.reload(); await page.waitForSelector('#bookmarkSelectionStatus'); await selection([]);
        assert.deepEqual(await read(), afterDeletion, 'Reload clears only the page selection.');
        return { source: seed, chosen, firstProof, repeatProof, observations, modifierInput: 'real Control/Shift on Linux',
            realMouseDrag: true, nativePinnedTabsVerified: true, sourcePreserved: true,
            limits: ['Cmd modifier covered by DOM tests, not Linux physical input.', 'Native side-panel layout and OS drag-image appearance remain manual.', 'Partial API-failure injection is unit coverage; real browser case covers deletion during a frozen drag.'] };
    } catch (error) {
        primaryError = error;
        const failure = { phase: 'failed-before-cleanup', error: error.message };
        try { failure.selection = await page.evaluate(readBookmarkSelection); } catch (observation) { failure.observationError = observation.message; }
        try { await record(failure); } catch (observation) { error.diagnosticError = observation.message; }
        throw error;
    } finally {
        // Only fixture-owned Favorite records/tabs and the fixture folder are removed.
        await finishBookmarkFixture([
            async () => {
                // The control options tab is in a different window. Use the
                // fixture's own source renderer; production sender checks stay strict.
                const tabIds = await page.evaluate(cleanupBookmarkFavoritesInSourceWindow, { ids: leafIds, windowId: fixture.windowA });
                await apiPage.evaluate(async ({ tabIds, rootId, sidebarId, ordinaryTabId }) => {
                    const live = new Set((await chrome.tabs.query({})).map(tab => tab.id));
                    for (const id of [...tabIds, sidebarId, ordinaryTabId]) if (live.has(id)) await chrome.tabs.remove(id);
                    await chrome.bookmarks.removeTree(rootId);
                }, { tabIds, rootId: seed.root.id, sidebarId: sidebar.tab.id, ordinaryTabId });
            },
            async () => {
                if (originalInvert !== await apiPage.$eval('#invertTabOrder', element => element.checked))
                    await ui(apiPage, 'Restore original bookmark display ordering', () => apiPage.click('label.toggle-label[for="invertTabOrder"]'));
                await poll(() => apiPage.evaluate(() => chrome.storage.sync.get('invertTabOrder')), settings => settings.invertTabOrder === originalInvert, 'restored bookmark display ordering');
            }
        ], primaryError, record);
    }
}
