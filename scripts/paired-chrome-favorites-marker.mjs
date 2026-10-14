/** Real-mouse Favorites destination proof. Import/unit-test only locally. */
import assert from 'node:assert/strict';
import { requestScopedFavorite } from './paired-chrome-favorites-restart.mjs';
import { assertLegacyFavoriteRegistry, retainedFavoriteCache, waitForRetainedFavoriteIcon } from './paired-chrome-favorite-icons.mjs';
import { readMarkerScreenshotPixels, assertMarkerScreenshotPixels } from './paired-chrome-space-marker.mjs';

export function readFavoritesDropMarker() {
    const markers = [...document.querySelectorAll('.favorites-drop-anchor')];
    const marker = markers[0];
    if (!marker) return null;
    const bounds = element => {
        const { x, y, width, height } = element.getBoundingClientRect();
        return { x, y, width, height };
    };
    const container = document.getElementById('pinnedFavicons');
    const anchor = [...container.querySelectorAll('.pinned-favicon')].find(node =>
        (node.dataset.favoriteId || node.dataset.tabId) === marker.dataset.anchorId);
    const style = getComputedStyle(marker);
    return { count: markers.length, bodyChild: marker.parentElement === document.body, hidden: marker.hidden,
        list: marker.dataset.list, placement: marker.dataset.placement, beforeId: marker.dataset.beforeId,
        anchorId: marker.dataset.anchorId, sourceId: container.querySelector('.saved-favorite.dragging')?.dataset.favoriteId,
        draggingCount: document.querySelectorAll('.dragging').length,
        rect: bounds(marker), anchor: anchor ? bounds(anchor) : null, container: bounds(container),
        viewport: { width: innerWidth, height: innerHeight, scale: devicePixelRatio },
        style: { display: style.display, visibility: style.visibility, opacity: style.opacity,
            position: style.position, pointerEvents: style.pointerEvents, color: style.backgroundColor } };
}

export function assertFavoritesDropMarker(state, { sourceId, anchorId, beforeId, placement }) {
    assert(['before', 'after'].includes(placement), 'Saved reordering requires a precise before/after boundary.');
    assert(state && state.anchor && state.container, 'The marker needs its actual icon and strip geometry.');
    assert.equal(state.count, 1); assert.equal(state.bodyChild, true, 'The insertion overlay must escape the wrapping Favorites layout.');
    assert.equal(state.hidden, false); assert.equal(state.list, 'saved');
    assert.equal(state.sourceId, sourceId); assert.equal(state.draggingCount, 1);
    assert.equal(state.anchorId, anchorId); assert.equal(state.beforeId, beforeId ?? ''); assert.equal(state.placement, placement);
    assert.equal(state.style.position, 'fixed'); assert.equal(state.style.pointerEvents, 'none');
    assert.notEqual(state.style.display, 'none'); assert.equal(state.style.visibility, 'visible');
    assert.equal(Number(state.style.opacity), 1, 'The marker must already be painted at capture time.');
    const { rect, anchor, container, viewport } = state;
    for (const value of [...Object.values(rect), ...Object.values(anchor), ...Object.values(container), ...Object.values(viewport)]) assert(Number.isFinite(value));
    assert(rect.width >= 3 && rect.width <= 5); assert(rect.height >= 24);
    assert(anchor.width > 0 && anchor.height >= 28 && container.width > 0 && container.height >= anchor.height);
    assert(viewport.width > 0 && viewport.height > 0 && viewport.scale > 0);
    const left = Math.max(container.x, 0), right = Math.min(container.x + container.width, viewport.width);
    const boundary = placement === 'before' ? anchor.x - 4 : anchor.x + anchor.width + 4;
    const center = Math.max(left + 3, Math.min(boundary, right - 3));
    const top = Math.max(anchor.y + 2, container.y + 2, 2);
    const bottom = Math.min(anchor.y + anchor.height - 2, container.y + container.height - 2, viewport.height - 2);
    assert(boundary >= left - 4 && boundary <= right + 4, 'Offscreen anchors cannot be presented as visible destinations.');
    assert(Math.abs(rect.x + rect.width / 2 - center) <= 1, 'Marker must align with the exact resolved before/after slot.');
    assert(Math.abs(rect.y - top) <= 1 && Math.abs(rect.height - (bottom - top)) <= 1);
    assert(rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= viewport.width && rect.y + rect.height <= viewport.height);
    assert(!/rgba\([^)]*,\s*0\s*\)/.test(state.style.color));
    return state;
}

export function assertFavoritesMarkerHidden(state) {
    assert(state, 'A created marker is required to prove cleanup, rather than an absent implementation.');
    assert.equal(state.count, 1); assert.equal(state.bodyChild, true); assert.equal(state.hidden, true);
    assert.equal(state.style.display, 'none', 'Hidden cleanup must actually remove the marker from painting.');
    for (const field of ['list', 'placement', 'beforeId', 'anchorId']) assert.equal(state[field], undefined, `Cleanup must discard stale ${field}.`);
}

// Passive DOM observers only. Never synthesize, intercept or cancel an event.
export function installFavoriteDragTrace() {
    globalThis.__favoriteVisualDragEvents = [];
    if (globalThis.__favoriteVisualDragTraceInstalled) return;
    globalThis.__favoriteVisualDragTraceInstalled = true;
    for (const type of ['dragstart', 'dragend', 'drop', 'keydown', 'keyup']) {
        document.addEventListener(type, event => {
            globalThis.__favoriteVisualDragEvents.push({ type: event.type, isTrusted: event.isTrusted,
                favoriteId: event.target.closest?.('.saved-favorite')?.dataset.favoriteId ?? null,
                key: event.key ?? null, dropEffect: event.dataTransfer?.dropEffect ?? null });
        }, { capture: true, passive: true });
    }
}

export function favoriteDragInputClient(page) {
    // The runner separately requires Puppeteer 25.12.0. In that locked CDP
    // implementation page.mouse and page._client() share #primaryTargetClient.
    // Chrome's drag controller belongs to that session; a new CDPSession can
    // acknowledge cancelDragging without owning (or cancelling) this drag.
    assert.equal(typeof page._client, 'function', 'The verified primary input client is required; do not substitute another session.');
    const client = page._client();
    assert(client && typeof client.send === 'function', 'The real mouse input CDP client must be available.');
    return client;
}

export function assertFavoriteDragCancelled(evidence, { sourceId, operation }) {
    assert.equal(evidence.method, 'Input.cancelDragging'); assert.equal(evidence.acknowledged, true);
    assert.equal(evidence.mouseReleased, false, 'Observe native cancellation before releasing the held mouse button.');
    assert(Array.isArray(evidence.events));
    const starts = evidence.events.filter(event => event.type === 'dragstart');
    const ends = evidence.events.filter(event => event.type === 'dragend');
    assert.equal(starts.length, 1, 'One genuine drag must have started.');
    assert.equal(ends.length, 1, 'Chrome must deliver one actual dragend for cancellation.');
    for (const event of [starts[0], ends[0]]) {
        assert.equal(event.isTrusted, true); assert.equal(event.favoriteId, sourceId);
    }
    assert(evidence.events.indexOf(starts[0]) < evidence.events.indexOf(ends[0]));
    assert.equal(ends[0].dropEffect, 'none', 'Cancelled native dragging must finish without a drop operation.');
    assert(!evidence.events.some(event => event.type === 'drop'), 'A cancelled drag must never deliver drop.');
    assertFavoritesMarkerHidden(evidence.marker);
    assert.equal(evidence.marker.draggingCount, 0); assert.equal(evidence.marker.sourceId, undefined);
    assert.equal(evidence.operation, operation, 'Cancelling must not dispatch a Favorite mutation.');
    assert.deepEqual(evidence.writes, [], 'Cancelling must not write the durable registry.');
    return evidence;
}

export function assertSavedFavoriteReorder(before, after, order) {
    assertLegacyFavoriteRegistry(before.durable); assertLegacyFavoriteRegistry(after.durable);
    retainedFavoriteCache(before.iconCache, before.durable); retainedFavoriteCache(after.iconCache, after.durable);
    assert(Array.isArray(order) && order.length === before.durable.length);
    assert.equal(new Set(order).size, order.length, 'The expected order must contain every saved ID exactly once.');
    assert.deepEqual([...order].sort(), before.durable.map(item => item.id).sort());
    const records = new Map(before.durable.map(item => [item.id, item]));
    assert.deepEqual(after.durable, order.map(id => records.get(id)), 'Only durable order may change; every four-key saved record must remain readable by the prior Favorites implementation.');
    for (const field of ['bookmarks', 'tabs', 'windows', 'session', 'iconCache']) assert.deepEqual(after[field], before[field], `Saved reordering must preserve exact ${field}.`);
    assert.deepEqual(after.states.map(state => state.windowId), before.states.map(state => state.windowId));
    for (const original of before.states) {
        const current = after.states.find(state => state.windowId === original.windowId);
        assert.equal(current.activeSpaceId, original.activeSpaceId, 'Reordering must not switch the active Space in any window.');
        assert.deepEqual(current.spaces, original.spaces, 'Every Space membership and ordering must remain unchanged.');
        const favorites = new Map(original.favorites.map(item => [item.id, item]));
        assert.deepEqual(current.favorites, order.map(id => favorites.get(id)), 'Each window must expose the same order and retain each exact tab binding.');
    }
}

export async function exerciseSavedFavoriteMarker({ apiPage, newTabPage, ui, screenshot, screenshotBytes, snapshot, poll, fixture, arcifyId, record = async () => {} }) {
    const initial = await snapshot();
    const space = initial.spaces.find(item => item.id === initial.activeSpaceId);
    assert(space?.bookmarkFolderId);
    const seeds = await apiPage.evaluate(async ({ parentId, base }) => {
        const bookmarks = [];
        for (const title of ['Marker First', 'Marker Middle', 'Marker Last']) bookmarks.push(await chrome.bookmarks.create({ parentId, title, url: `${base}/favorite-persistent` }));
        const folder = await chrome.bookmarks.create({ parentId, title: 'Marker Invalid Folder' });
        return { bookmarks, folder };
    }, { parentId: space.bookmarkFolderId, base: fixture.base });
    const sidebar = await newTabPage(`chrome-extension://${arcifyId}/sidebar.html`);
    const page = sidebar.page, saved = [], observations = [];
    let native;
    const icon = id => `#pinnedFavicons .saved-favorite[data-favorite-id="${id}"]`;
    const renderedOrder = () => page.$$eval('#pinnedFavicons .saved-favorite', nodes => nodes.map(node => node.dataset.favoriteId));
    const read = async () => {
        const data = await apiPage.evaluate(async () => {
            const bookmark = ({ id, parentId, index, title, url, children }) => ({ id, parentId, index, title,
                ...(url === undefined ? {} : { url }), ...(children ? { children: children.map(bookmark) } : {}) });
            const tabs = (await chrome.tabs.query({})).map(({ id, windowId, index, url, pinned, active, incognito, groupId }) => ({ id, windowId, index, url, pinned, active, incognito, groupId })).sort((a, b) => a.id - b.id);
            const windows = (await chrome.windows.getAll({ windowTypes: ['normal'] })).map(({ id, type, incognito }) => ({ id, type, incognito })).sort((a, b) => a.id - b.id);
            const local = await chrome.storage.local.get(['persistentFavorites', 'favoriteIconCache']);
            return { durable: local.persistentFavorites, iconCache: local.favoriteIconCache ?? null,
                session: (await chrome.storage.session.get('favoriteSession')).favoriteSession,
                tabs, windows, bookmarks: (await chrome.bookmarks.getTree()).map(bookmark) };
        });
        data.states = [];
        for (const windowId of [fixture.windowA, fixture.windowB]) {
            const state = await snapshot(windowId);
            data.states.push({ windowId, activeSpaceId: state.activeSpaceId, favorites: state.favorites,
                spaces: state.spaces.map(({ id, tabIds, pinnedTabIds, temporaryTabIds }) => ({ id, tabIds, pinnedTabIds, temporaryTabIds })) });
        }
        return data;
    };
    const hidden = async () => {
        await page.waitForFunction(() => document.querySelector('.favorites-drop-anchor')?.hidden === true, { polling: 50 });
        const state = await page.evaluate(readFavoritesDropMarker); assertFavoritesMarkerHidden(state); return state;
    };
    const capture = async (expected, label) => {
        await page.waitForFunction(expected => {
            const marker = document.querySelector('.favorites-drop-anchor');
            return marker && !marker.hidden && marker.dataset.list === 'saved' && marker.dataset.anchorId === expected.anchorId && marker.dataset.placement === expected.placement && marker.dataset.beforeId === (expected.beforeId ?? '');
        }, { polling: 50 }, expected);
        const marker = assertFavoritesDropMarker(await page.evaluate(readFavoritesDropMarker), expected);
        const captured = await screenshot(page, label, true, { fullPage: false });
        const pixels = await page.evaluate(readMarkerScreenshotPixels, { base64: (await screenshotBytes(captured)).toString('base64'), marker });
        const paint = assertMarkerScreenshotPixels(pixels, marker);
        const afterCapture = assertFavoritesDropMarker(await page.evaluate(readFavoritesDropMarker), expected);
        assert.deepEqual(afterCapture.rect, marker.rect, 'Screenshot capture must not move the destination.');
        return { marker, paint, screenshot: captured.filename, afterCapture };
    };
    const drag = async ({ source, target, side = 'before', expected, label, cancel = false, leave = false, invalid = false }) => ui(page, label, async () => {
        await page.waitForSelector(source); await page.waitForSelector(target);
        const sourceNode = await page.$(source), targetNode = await page.$(target);
        let down = false, cancellation;
        const client = favoriteDragInputClient(page);
        const beforeDrag = cancel || leave ? await read() : null;
        const operation = await page.$eval('#pinnedFavicons', node => Number(node.dataset.dropOperation || 0));
        await page.evaluate(() => { globalThis.__favoriteVisualStorageEvents = []; });
        await page.evaluate(installFavoriteDragTrace);
        const inspect = async () => ({ marker: await page.evaluate(readFavoritesDropMarker),
            ...await page.evaluate(() => ({ events: globalThis.__favoriteVisualDragEvents,
                operation: Number(document.getElementById('pinnedFavicons').dataset.dropOperation || 0),
                writes: globalThis.__favoriteVisualStorageEvents })) });
        const checkpoint = async (phase, extra = {}) => record({ phase, label, ...await inspect(), ...extra });
        try {
            await sourceNode.scrollIntoView();
            const from = await sourceNode.boundingBox(), to = await targetNode.boundingBox();
            assert(from && to && from.width > 0 && from.height > 0 && to.width > 0 && to.height > 0);
            const x = from.x + from.width / 2, y = from.y + from.height / 2;
            await page.mouse.move(x, y); await page.mouse.down(); down = true;
            await page.mouse.move(x, y + 12, { steps: 5 });
            await page.mouse.move(side === 'before' ? to.x + 3 : to.x + to.width - 3, to.y + to.height / 2, { steps: 20 });
            await page.waitForFunction(() => document.querySelectorAll('.dragging').length === 1, { polling: 50 });
            if (invalid) await page.waitForFunction(() => /folder|one bookmark/i.test(document.getElementById('favoritesDropStatus')?.textContent || ''), { polling: 50 });
            const hover = expected ? await capture(expected, label) : await hidden();
            await checkpoint('hover-before-release', { hover });
            if (leave) {
                const outside = await page.$eval('#pinnedFavicons', node => ({ x: 1, y: node.getBoundingClientRect().bottom + 40 }));
                await page.mouse.move(outside.x, outside.y, { steps: 12 });
                await hidden();
            }
            if (cancel || leave) {
                // Puppeteer's CDP keyboard Escape is not native drag cancellation.
                // Use Chrome's documented cancellation command and prove its real
                // DOM result before releasing the mouse. Physical Escape is manual.
                await checkpoint('before-native-cancel', { before: beforeDrag });
                await client.send('Input.cancelDragging');
                await poll(() => page.evaluate(() => globalThis.__favoriteVisualDragEvents),
                    events => events.some(event => event.type === 'dragend'), 'trusted browser-native cancellation dragend');
                await page.waitForFunction(() => !document.querySelector('.dragging'), { polling: 50 });
                cancellation = { method: 'Input.cancelDragging', acknowledged: true, mouseReleased: false, ...await inspect() };
                await record({ phase: 'native-cancel-before-release', label, cancellation });
                assertFavoriteDragCancelled(cancellation, { sourceId: expected.sourceId, operation });
                const cancelledState = await read();
                assertSavedFavoriteReorder(beforeDrag, cancelledState, beforeDrag.durable.map(item => item.id));
                await record({ phase: 'cancelled-state-before-release', label, state: cancelledState });
            }
            await page.mouse.up(); down = false;
            await page.waitForFunction(() => !document.querySelector('.dragging'), { polling: 50 });
            if (expected && !cancel && !leave) await page.waitForFunction(previous => {
                const strip = document.getElementById('pinnedFavicons');
                return Number(strip.dataset.dropOperation) === previous + 1 && strip.dataset.dropState === 'success' && strip.getAttribute('aria-busy') === 'false';
            }, { polling: 50 }, operation);
            else assert.equal(await page.$eval('#pinnedFavicons', node => Number(node.dataset.dropOperation || 0)), operation, 'Invalid, no-op and cancelled drags must not dispatch a mutation.');
            const cleanup = await hidden();
            const writes = expected && !cancel && !leave
                ? await poll(() => page.evaluate(() => globalThis.__favoriteVisualStorageEvents), events => events.length > 0, 'actual durable Favorite reorder event')
                : await page.evaluate(() => globalThis.__favoriteVisualStorageEvents);
            if (!expected || cancel || leave) assert.deepEqual(writes, [], 'A no-op, invalid or cancelled drag must not write the durable Favorites store.');
            else assert.equal(writes.length, 1, 'One real reorder must result in exactly one durable write.');
            const events = await page.evaluate(() => globalThis.__favoriteVisualDragEvents);
            if (cancel || leave) {
                assert(!events.some(event => event.type === 'drop'), 'Releasing the mouse after cancellation must not deliver a late drop.');
                assertSavedFavoriteReorder(beforeDrag, await read(), beforeDrag.durable.map(item => item.id));
            }
            const observation = { label, sourceRect: from, targetRect: to, hover, cleanup, writes, events, cancellation,
                cancelled: cancel, leftStrip: leave, physicalEscapeAsserted: false };
            observations.push(observation); await record({ phase: 'completed-drag', ...observation }); return observation;
        } catch (error) {
            // Persist the original state/events before cleanup can erase the cause.
            const failure = { phase: 'failed-before-cleanup', label, error: error.message, cancellation };
            try { Object.assign(failure, await inspect()); } catch (diagnosticError) { failure.observationError = diagnosticError.message; }
            try { failure.state = await read(); } catch (diagnosticError) { failure.stateError = diagnosticError.message; }
            try { await record(failure); } catch (diagnosticError) { error.favoriteMarkerDiagnosticError = diagnosticError.message; }
            throw error;
        } finally {
            if (down) {
                await client.send('Input.cancelDragging').catch(() => {});
                const ended = await page.evaluate(() => !document.querySelector('.dragging')).catch(() => false);
                if (ended) await page.mouse.up().catch(() => {});
            }
            await sourceNode.dispose(); await targetNode.dispose();
        }
    });
    try {
        for (const bookmark of seeds.bookmarks) {
            const added = await requestScopedFavorite(page, fixture.windowA, 'addBookmark', { spaceId: space.id, bookmarkFolderId: space.bookmarkFolderId, bookmarkId: bookmark.id, parentId: bookmark.parentId });
            const favorite = added.favorites.find(item => item.sourceBookmarkId === bookmark.id); assert(favorite?.tabId); saved.push(favorite);
        }
        native = await apiPage.evaluate(options => chrome.tabs.create(options), { windowId: fixture.windowA, url: `${fixture.base}/favorite-marker-native`, pinned: true, active: false });
        await poll(() => apiPage.evaluate(ids => Promise.all(ids.map(id => chrome.tabs.get(id))), [...saved.map(item => item.tabId), native.id]), tabs => tabs.every(tab => tab.status === 'complete'), 'loaded real saved and native marker fixtures');
        const seededIcons = [];
        for (const favorite of saved) {
            await page.waitForSelector(icon(favorite.id));
            // Wait for actual cache capture before freezing a reorder baseline;
            // a concurrent best-effort icon write is not a drag mutation.
            seededIcons.push(await waitForRetainedFavoriteIcon({ apiPage, sidebar: page, favoriteId: favorite.id, closed: false, poll }));
        }
        await page.waitForSelector(`#pinnedFavicons .native-favorite[data-tab-id="${native.id}"]`);
        await page.evaluate(() => {
            globalThis.__favoriteVisualStorageEvents = [];
            chrome.storage.onChanged.addListener((changes, area) => {
                if (area === 'local' && changes.persistentFavorites) globalThis.__favoriteVisualStorageEvents.push(changes.persistentFavorites);
            });
        });
        await ui(page, 'Observe original saved Favorites before real dragging', async () => {});
        const before = await read(), original = before.durable.map(item => item.id);
        await record({ phase: 'initial-state', before });
        const [a, b, c] = saved.map(item => item.id), prefix = original.slice(0, -3);
        assert.deepEqual(original.slice(-3), [a, b, c]);
        const assertOrder = async order => {
            await poll(renderedOrder, actual => JSON.stringify(actual) === JSON.stringify(order), 'exact rendered saved Favorite order');
            const after = await read(); assertSavedFavoriteReorder(before, after, order);
            await record({ phase: 'verified-order', order, after }); return after;
        };
        await drag({ source: icon(c), target: icon(a), expected: { sourceId: c, anchorId: a, beforeId: a, placement: 'before' }, label: 'saved-favorites-before-slot-real-mouse-pixels' });
        const reordered = await assertOrder([...prefix, c, a, b]);
        await drag({ source: icon(c), target: icon(b), side: 'after', expected: { sourceId: c, anchorId: b, beforeId: null, placement: 'after' }, label: 'saved-favorites-after-slot-real-mouse-pixels' });
        const restored = await assertOrder(original);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await assertOrder(original);
        await page.evaluate(() => {
            globalThis.__favoriteVisualStorageEvents = [];
            chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.persistentFavorites) globalThis.__favoriteVisualStorageEvents.push(changes.persistentFavorites); });
        });
        await drag({ source: icon(c), target: icon(c), label: 'saved-favorites-self-drop-has-no-marker' }); await assertOrder(original);
        await drag({ source: icon(c), target: icon(b), side: 'after', label: 'saved-favorites-adjacent-noop-has-no-marker' }); await assertOrder(original);
        await drag({ source: `.space[data-space-id="${space.id}"] .folder[data-bookmark-id="${seeds.folder.id}"] > .folder-header`, target: icon(a), invalid: true, label: 'saved-favorites-invalid-folder-has-no-marker' }); await assertOrder(original);
        await drag({ source: icon(c), target: icon(a), expected: { sourceId: c, anchorId: a, beforeId: a, placement: 'before' }, cancel: true, label: 'saved-favorites-browser-native-cancellation-clears-destination' }); await assertOrder(original);
        await drag({ source: icon(c), target: icon(a), expected: { sourceId: c, anchorId: a, beforeId: a, placement: 'before' }, leave: true, label: 'saved-favorites-leaving-strip-clears-destination' }); await assertOrder(original);
        await drag({ source: icon(b), target: `#pinnedFavicons .native-favorite[data-tab-id="${native.id}"]`, expected: { sourceId: b, anchorId: c, beforeId: null, placement: 'after' }, label: 'saved-favorites-native-boundary-uses-last-saved-anchor' });
        const boundary = await assertOrder([...prefix, a, c, b]);
        await drag({ source: icon(b), target: icon(c), expected: { sourceId: b, anchorId: c, beforeId: c, placement: 'before' }, label: 'saved-favorites-restore-durable-order' });
        const final = await assertOrder(original);
        return { before, reordered, restored, boundary, final, observations, seededIcons, realMouseDrag: true, nativePanel: false,
            sourceBookmarksPreserved: true, browserTabsPreserved: true, windowsPreserved: true };
    } finally {
        for (const favorite of saved) await requestScopedFavorite(page, fixture.windowA, 'remove', { favoriteId: favorite.id });
        await apiPage.evaluate(async ({ tabs, bookmarks, folder }) => {
            const live = await chrome.tabs.query({});
            for (const id of tabs.filter(Number.isSafeInteger)) if (live.some(tab => tab.id === id)) await chrome.tabs.remove(id);
            for (const id of bookmarks) await chrome.bookmarks.remove(id);
            await chrome.bookmarks.removeTree(folder);
        }, { tabs: [sidebar.tab.id, native?.id, ...saved.map(item => item.tabId)], bookmarks: seeds.bookmarks.map(item => item.id), folder: seeds.folder.id });
    }
}
