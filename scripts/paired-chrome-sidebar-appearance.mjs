/** Real-input appearance/result proof. Imported locally only by validator tests; no browser launch. */
import assert from 'node:assert/strict';
import { requestScopedFavorite } from './paired-chrome-favorites-restart.mjs';
import { waitForRetainedFavoriteIcon } from './paired-chrome-favorite-icons.mjs';
import { readFavoritesDropMarker, assertFavoritesDropMarker, assertSavedFavoriteReorder, installFavoriteDragTrace, favoriteDragInputClient } from './paired-chrome-favorites-marker.mjs';
import { readSpaceDropMarker, assertSpaceDropMarker, readMarkerScreenshotPixels, assertMarkerScreenshotPixels } from './paired-chrome-space-marker.mjs';
import { locateFreshDragGeometry } from './paired-chrome-ui.mjs';

export async function prepareAppearanceBaseline({ apiPage, page, ui, read, record, windowId }) {
    // Later settings input selects apiPage in its control window. Establish that
    // deliberate selection before the strict all-window conservation baseline.
    const control = await ui(apiPage, 'Prepare appearance control window before baseline',
        () => apiPage.evaluate(async () => {
            const tab = await chrome.tabs.getCurrent();
            return { id: tab?.id, windowId: tab?.windowId, active: tab?.active, incognito: tab?.incognito };
        }));
    assert(Number.isSafeInteger(control?.id) && control.id > 0);
    assert(Number.isSafeInteger(control.windowId) && control.windowId > 0);
    assert.notEqual(control.windowId, windowId, 'Settings and the fixture sidebar must use distinct windows.');
    assert.equal(control.active, true); assert.equal(control.incognito, false);
    await ui(page, 'Observe density fixture baseline', async () => {});
    const state = await read();
    const retained = state.tabs.filter(tab => tab.id === control.id);
    assert.equal(retained.length, 1); assert.equal(retained[0].windowId, control.windowId);
    assert.equal(retained[0].active, true, 'Foregrounding the sidebar must retain the selected Settings tab in its control window.');
    await record({ phase: 'appearance-control-baseline', control });
    return state;
}

export async function tabToSelector(page, selector, maxTabs = 120, { backward = false } = {}) {
    if (backward) await page.keyboard.down('Shift');
    try {
        for (let index = 0; index <= maxTabs; index++) {
            if (await page.evaluate(selector => document.activeElement === document.querySelector(selector), selector)) return index;
            assert(index < maxTabs, `Real Tab input could not reach ${selector}.`);
            await page.keyboard.press('Tab');
        }
    } finally { if (backward) await page.keyboard.up('Shift'); }
}

export function readFavoritesNotice() {
    const wrapper = document.getElementById('favoritesDropNotice'), status = document.getElementById('favoritesDropStatus');
    const dismiss = document.getElementById('favoritesDropDismiss'), strip = document.getElementById('pinnedFavicons');
    const visible = node => Boolean(node && !node.hidden && node.getClientRects().length && getComputedStyle(node).display !== 'none' && getComputedStyle(node).visibility === 'visible');
    return { exists: Boolean(wrapper && status && dismiss), wrapperVisible: visible(wrapper), wrapperHidden: wrapper?.hidden,
        text: status?.textContent, role: status?.getAttribute('role'), live: status?.getAttribute('aria-live'), atomic: status?.getAttribute('aria-atomic'),
        dismissVisible: visible(dismiss), dismissTag: dismiss?.tagName, dismissName: dismiss?.getAttribute('aria-label'), dismissDisabled: dismiss?.disabled,
        operation: Number(strip?.dataset.dropOperation || 0), busy: strip?.getAttribute('aria-busy'),
        selected: [...document.querySelectorAll('.space.active .tab.bookmark-selected')].map(node => node.dataset.bookmarkId),
        wrapperHeight: wrapper?.getBoundingClientRect().height, contentY: document.getElementById('spacesList')?.getBoundingClientRect().y,
        focusOnFirstFavorite: document.activeElement === strip?.querySelector('.pinned-favicon') };
}

export function assertFavoritesResultVisible(state) {
    assert.equal(state.exists, true); assert.equal(state.wrapperVisible, true); assert.equal(state.wrapperHidden, false);
    assert.equal(state.dismissVisible, true); assert.equal(state.dismissTag, 'BUTTON'); assert.equal(state.dismissDisabled, false);
    assert.equal(state.dismissName, 'Dismiss Favorites message'); assert(state.text?.trim());
    assert.equal(state.role, 'status'); assert.equal(state.live, 'polite'); assert.equal(state.atomic, 'true');
    assert.notEqual(state.busy, 'true'); assert(state.wrapperHeight > 0); return state;
}

export function assertFavoritesResultDismissed(before, after, { keyboard = false } = {}) {
    assertFavoritesResultVisible(before); assert(before.selected.length > 0, 'Dismissal evidence must preserve an actual nonempty bookmark selection.'); assert.equal(after.exists, true);
    assert.equal(after.wrapperVisible, false); assert.equal(after.wrapperHidden, true);
    assert.equal(after.dismissVisible, false); assert.equal(after.text, ''); assert.equal(after.wrapperHeight, 0);
    assert(after.contentY < before.contentY, 'Dismissing the message must reclaim actual sidebar space.');
    assert.equal(after.operation, before.operation, 'Dismissal cannot replay or create a Favorites operation.');
    assert.notEqual(after.busy, 'true'); assert.deepEqual(after.selected, before.selected, 'Dismissal preserves bookmark selection.');
    if (keyboard) assert.equal(after.focusOnFirstFavorite, true, 'Keyboard dismissal returns focus to an actionable Favorite.');
    return after;
}

export async function exerciseFavoritesResultDismissal({ page, ui, read, screenshot, record, key = null }) {
    return ui(page, `Dismiss final Favorites result with ${key || 'mouse click'}`, async () => {
        const notice = assertFavoritesResultVisible(await page.evaluate(readFavoritesNotice)), before = await read();
        const beforeShot = await screenshot(page, `favorites-result-before-dismiss-${key || 'mouse'}`, true, { fullPage: false });
        if (key) {
            // The notice precedes bookmark rows. Stay inside the document rather
            // than tabbing through browser chrome, whose blur clears selection.
            await tabToSelector(page, '#favoritesDropDismiss', 120, { backward: true });
            assert.deepEqual((await page.evaluate(readFavoritesNotice)).selected, notice.selected, 'Keyboard traversal must retain selection before dismissal.');
            await page.keyboard.press(key);
        }
        else await page.click('#favoritesDropDismiss');
        await page.waitForFunction(() => document.getElementById('favoritesDropNotice')?.hidden === true, { polling: 50 });
        const after = assertFavoritesResultDismissed(notice, await page.evaluate(readFavoritesNotice), { keyboard: Boolean(key) });
        assert.deepEqual(await read(), before, 'Dismissing a result must not change Favorites, bookmarks, tabs, windows or Spaces.');
        const shot = await screenshot(page, `favorites-result-dismissed-${key || 'mouse'}`, true, { fullPage: false });
        const evidence = { key, before: notice, after, beforeScreenshot: beforeShot.filename, screenshot: shot.filename, unchanged: true };
        await record({ phase: 'result-dismissal', ...evidence }); return evidence;
    });
}

export function readSidebarAppearance() {
    const rect = node => { const { x, y, width, height } = node.getBoundingClientRect(); return { x, y, width, height }; };
    const strip = document.getElementById('pinnedFavicons'), name = document.querySelector('.space.active .space-name');
    return { viewport: { width: innerWidth, height: innerHeight }, layout: document.documentElement.dataset.favoritesLayout,
        headerSize: Number(document.documentElement.dataset.spaceHeaderSize), container: rect(strip),
        tiles: [...strip.querySelectorAll('.pinned-favicon')].map(node => {
            const state = node.querySelector('.favorite-state'), icon = node.querySelector('img');
            return { id: node.dataset.favoriteId || `native:${node.dataset.tabId}`, rect: rect(node), icon: rect(icon),
                title: node.title, aria: node.getAttribute('aria-label'), role: node.getAttribute('role'), tabIndex: node.tabIndex, draggable: node.draggable,
                stateText: state.textContent, stateVisible: Boolean(state.getClientRects().length && getComputedStyle(state).display !== 'none'), closed: node.classList.contains('favorite-closed') };
        }),
        header: { name: name.value, rect: rect(name), fontSize: parseFloat(getComputedStyle(name).fontSize),
            controls: [...document.querySelectorAll('.space.active .space-header .sidebar-button, .space.active .space-header .space-options')]
                .map(node => ({ name: node.getAttribute('aria-label'), rect: rect(node), tag: node.tagName, tabIndex: node.tabIndex, disabled: node.disabled })) } };
}

export function assertCompactSidebar(state, { width, size = 44, headerSize = 12, requirePartial = true }) {
    assert.equal(state.viewport.width, width); assert.equal(state.layout, 'compact'); assert.equal(state.headerSize, headerSize);
    assert.equal(state.header.fontSize, headerSize); assert(state.header.name && state.header.rect.width > 0);
    const columns = Math.floor((width - 16 + 8) / (size + 8));
    assert.equal(state.container.x, 8); assert.equal(state.container.width, width - 16);
    assert(state.tiles.length > columns, 'At least two actual rows are required.');
    if (requirePartial) assert.notEqual(state.tiles.length % columns, 0, 'Evidence must include an incomplete row.');
    const first = state.tiles[0].rect;
    for (const [index, tile] of state.tiles.entries()) {
        for (const value of Object.values(tile.rect)) assert(Number.isFinite(value));
        assert(Math.abs(tile.rect.width - size) < 0.5 && Math.abs(tile.rect.height - size) < 0.5, 'Every tile, including the final row, must retain fixed square dimensions.');
        assert(Math.abs(tile.rect.x - (first.x + index % columns * (size + 8))) < 0.5, 'Compact columns remain left-aligned at fixed spacing.');
        assert(Math.abs(tile.rect.y - (first.y + Math.floor(index / columns) * (size + 8))) < 0.5, 'Wrapped rows retain fixed spacing.');
        assert(tile.rect.x >= 0 && tile.rect.x + size <= width);
        assert.equal(tile.stateVisible, false, 'Compact Favorites are icon-only.');
        assert.equal(tile.role, 'button'); assert.equal(tile.tabIndex, 0); assert.equal(tile.draggable, true);
        assert(tile.title && tile.aria && tile.stateText);
        const expected = tile.closed ? 'Closed' : tile.id.startsWith('native:') ? 'Browser pin' : 'Open';
        assert(tile.title.includes(expected) && tile.aria.includes(expected), 'Hidden captions must retain accessible and tooltip state.');
        assert(tile.icon.width >= 14 && tile.icon.width <= 24 && tile.icon.height >= 14 && tile.icon.height <= 24);
        assert(Math.abs(tile.icon.x + tile.icon.width / 2 - (tile.rect.x + size / 2)) < 1);
        assert(Math.abs(tile.icon.y + tile.icon.height / 2 - (tile.rect.y + size / 2)) < 1);
    }
    assert.equal(state.header.controls.length, 2);
    for (const control of state.header.controls) {
        assert(control.name); assert.equal(control.tag, 'BUTTON'); assert.equal(control.disabled, false); assert.equal(control.tabIndex, 0);
        assert(control.rect.width >= 24 && control.rect.height >= 24, 'Smaller text retains usable header action targets.');
        assert(control.rect.x >= 0 && control.rect.x + control.rect.width <= width + 0.5, 'Header actions remain inside the narrow sidebar.');
    }
    return { columns, rows: Math.ceil(state.tiles.length / columns), finalRow: state.tiles.length % columns || columns, state };
}

/** Read the real queue's final UI acknowledgement as well as its durable value. */
export function appearanceSaveComplete(receipt, id, value, { changed = true } = {}) {
    return receipt.control === String(value) && receipt.stored?.[id] === value &&
        (receipt.status === 'Sidebar appearance saved for this Chrome profile.' ||
            (!changed && receipt.status === 'Standard layout is the default.'));
}
export async function waitForAppearanceControlSaved(page, id, value, { changed = true } = {}) {
    await page.waitForFunction(async ({ id, value, changed }) => {
        const status = document.querySelector('#sidebarAppearanceStatus')?.textContent;
        const stored = (await chrome.storage.local.get('sidebarAppearance')).sidebarAppearance;
        return document.getElementById(id)?.value === String(value) && stored?.[id] === value &&
            (status === 'Sidebar appearance saved for this Chrome profile.' || (!changed && status === 'Standard layout is the default.'));
    }, { polling: 50 }, { id, value, changed });
    const receipt = await page.evaluate(async id => ({ control: document.getElementById(id)?.value,
        status: document.querySelector('#sidebarAppearanceStatus')?.textContent,
        stored: (await chrome.storage.local.get('sidebarAppearance')).sidebarAppearance }), id);
    assert(appearanceSaveComplete(receipt, id, value, { changed }), 'Require final queue acknowledgement and the exact saved control value.');
    return receipt;
}

/** Passive observation only; select changes still come from native keyboard input. */
export function installAppearanceSelectTrace(selector) {
    globalThis.__appearanceSelectInput?.dispose();
    const events = [], listen = event => {
        if (event.target.matches?.(selector)) events.push({ type: event.type, trusted: event.isTrusted, key: event.key || null, value: event.target.value });
    };
    for (const type of ['keydown', 'input', 'change']) document.addEventListener(type, listen, true);
    globalThis.__appearanceSelectInput = { events, dispose() { for (const type of ['keydown', 'input', 'change']) document.removeEventListener(type, listen, true); } };
}
export function assertAppearanceSelectTrace(events, before, value, choices) {
    assert(choices.includes(before) && choices.includes(value));
    assert(events.length && events.every(event => event.trusted), 'Every select input must be native trusted input.');
    assert.deepEqual(events.filter(event => event.type === 'keydown').map(event => event.key),
        ['Home', ...Array(choices.indexOf(value)).fill('ArrowDown')], 'Require the complete page-delivered select key sequence, including no-op requests.');
    if (before !== choices[0] || value !== choices[0] || events.some(event => ['input', 'change'].includes(event.type))) {
        for (const type of ['input', 'change']) assert(events.some(event => event.type === type), `Missing trusted select ${type}.`);
        assert.equal(events.filter(event => ['input', 'change'].includes(event.type)).at(-1)?.value, value);
    }
    return events;
}

// Genuine select/range keyboard input. No .value assignment, dispatchEvent, test CSS or settings write.
export async function setAppearanceControl(page, id, value) {
    await page.waitForSelector(`#${id}:not([disabled])`);
    await tabToSelector(page, `#${id}`, 200);
    if (id === 'favoritesLayout') {
        // Close any retained popup before observing the closed-select key sequence.
        await page.keyboard.press('Escape');
        assert.equal(await page.$eval(`#${id}`, node => document.activeElement === node), true);
    }
    const before = await page.$eval(`#${id}`, node => node.value);
    let changed = before !== String(value), trace;
    if (id === 'favoritesLayout') {
        assert(['standard', 'compact'].includes(value));
        await page.evaluate(installAppearanceSelectTrace, `#${id}`);
        await page.keyboard.press('Home'); if (value === 'compact') await page.keyboard.press('ArrowDown');
        trace = assertAppearanceSelectTrace(await page.evaluate(() => globalThis.__appearanceSelectInput.events), before, value, ['standard', 'compact']);
        changed = trace.some(event => event.type === 'change');
    } else {
        const { min, max } = await page.$eval(`#${id}`, node => ({ min: Number(node.min), max: Number(node.max) }));
        assert(Number.isInteger(value) && value >= min && value <= max);
        changed ||= Number(before) !== min || value !== min;
        await page.keyboard.press('Home');
        for (let index = min; index < value; index++) await page.keyboard.press('ArrowRight');
    }
    assert.equal(await page.$eval(`#${id}`, node => node.value), String(value));
    const saved = await waitForAppearanceControlSaved(page, id, value, { changed });
    return { ...saved, ...(trace ? { trace } : {}) };
}

export async function exerciseSidebarAppearance({ apiPage, newTabPage, ui, screenshot, screenshotBytes, snapshot, poll, fixture, arcifyId, record = async () => {} }) {
    const initial = await snapshot(), space = initial.spaces.find(item => item.id === initial.activeSpaceId);
    const sidebar = await newTabPage(`chrome-extension://${arcifyId}/sidebar.html`), page = sidebar.page;
    const saved = [], bookmarks = [], observations = []; let primaryError;
    const icon = id => `#pinnedFavicons .saved-favorite[data-favorite-id="${id}"]`;
    const read = async () => {
        const data = await apiPage.evaluate(async () => {
            const bookmark = ({ id, parentId, index, title, url, children }) => ({ id, parentId, index, title, ...(url === undefined ? {} : { url }), ...(children ? { children: children.map(bookmark) } : {}) });
            const local = await chrome.storage.local.get(['persistentFavorites', 'favoriteIconCache']);
            return { durable: local.persistentFavorites, iconCache: local.favoriteIconCache ?? null,
                session: (await chrome.storage.session.get('favoriteSession')).favoriteSession,
                bookmarks: (await chrome.bookmarks.getTree()).map(bookmark),
                tabs: (await chrome.tabs.query({})).map(({ id, windowId, index, url, pinned, active, incognito, groupId }) => ({ id, windowId, index, url, pinned, active, incognito, groupId })).sort((a,b) => a.id-b.id),
                windows: (await chrome.windows.getAll({ windowTypes: ['normal'] })).map(({ id, type, incognito }) => ({ id, type, incognito })).sort((a,b) => a.id-b.id) };
        });
        data.states = [];
        for (const windowId of [fixture.windowA, fixture.windowB]) {
            const state = await snapshot(windowId);
            data.states.push({ windowId, activeSpaceId: state.activeSpaceId, favorites: state.favorites,
                spaces: state.spaces.map(({ id, name, tabIds, pinnedTabIds, temporaryTabIds }) => ({ id, name, tabIds, pinnedTabIds, temporaryTabIds })) });
        }
        return data;
    };
    const savedAppearance = () => apiPage.evaluate(async () => (await chrome.storage.local.get('sidebarAppearance')).sidebarAppearance);
    const set = async (id, value) => {
        await ui(apiPage, `Set ${id} to ${value} using keyboard input`, () => setAppearanceControl(apiPage, id, value));
        await poll(savedAppearance, state => state?.[id] === value, `persisted ${id}`);
    };
    const reset = async () => {
        await ui(apiPage, 'Reset only sidebar appearance to defaults', () => apiPage.click('#resetSidebarAppearance'));
        await poll(savedAppearance, state => state?.favoritesLayout === 'standard' && state.favoriteTileSize === 44 && state.spaceHeaderSize === 16, 'default sidebar appearance saved');
    };
    const geometry = async (width, size = 44, headerSize = 12, requirePartial = true) => {
        await page.setViewport({ width, height: 900, deviceScaleFactor: 1 });
        return ui(page, `Inspect compact sidebar at ${width}px with ${size}px tiles`, async () => {
            await page.waitForFunction(({ size, headerSize }) => document.documentElement.dataset.favoritesLayout === 'compact' && document.documentElement.dataset.spaceHeaderSize === String(headerSize) && Math.abs(document.querySelector('#pinnedFavicons .pinned-favicon')?.getBoundingClientRect().width - size) < .5, { polling: 50 }, { size, headerSize });
            const proof = assertCompactSidebar(await page.evaluate(readSidebarAppearance), { width, size, headerSize, requirePartial });
            const shot = await screenshot(page, `compact-sidebar-${width}px-tiles-${size}-header-${headerSize}`, true, { fullPage: false });
            const evidence = { ...proof, screenshot: shot.filename }; observations.push(evidence); await record({ phase: 'compact-geometry', ...evidence }); return evidence;
        });
    };
    const drag = async (sourceSelector, targetSelector, expected, kind, label) => ui(page, label, async () => {
        const { source, target, from, to } = await locateFreshDragGeometry(page, sourceSelector, targetSelector, record);
        let held = false;
        await page.evaluate(installFavoriteDragTrace);
        try {
            const hitPoints = await page.evaluate(({ sourceSelector, targetSelector, from, to, placement, kind }) => {
                const container = document.querySelector(kind === 'space' ? '#spaceSwitcher' : '#pinnedFavicons'), bounds = container.getBoundingClientRect();
                const source = { x: from.x + from.width / 2, y: from.y + from.height / 2 }, target = { x: placement === 'after' ? to.x + to.width - 7 : to.x + 7, y: to.y + to.height / 2 };
                const inside = point => point.x >= Math.max(0, bounds.left) && point.x < Math.min(innerWidth, bounds.right) && point.y >= Math.max(0, bounds.top) && point.y < Math.min(innerHeight, bounds.bottom);
                return { source, target, sourceInside: inside(source), targetInside: inside(target),
                    sourceHit: Boolean(document.elementFromPoint(source.x, source.y)?.closest(sourceSelector)), targetHit: Boolean(document.elementFromPoint(target.x, target.y)?.closest(targetSelector)) };
            }, { sourceSelector, targetSelector, from, to, placement: expected.placement, kind });
            assert(hitPoints.sourceInside && hitPoints.targetInside && hitPoints.sourceHit && hitPoints.targetHit, 'Both actual input points must be inside the visible drop strip and hit their exact elements.');
            await record({ phase: 'compact-drag-hit-points', label, hitPoints });
            const x = from.x + from.width / 2, y = from.y + from.height / 2;
            await page.mouse.move(x, y); await page.mouse.down(); held = true;
            await page.mouse.move(x, y + (kind === 'space' ? -12 : 12), { steps: 5 });
            await page.mouse.move(expected.placement === 'after' ? to.x + to.width - 3 : to.x + 3, to.y + to.height / 2, { steps: 20 });
            await page.mouse.move(expected.placement === 'after' ? to.x + to.width - 7 : to.x + 7, to.y + to.height / 2, { steps: 2 });
            await page.waitForFunction(({ kind, expected }) => {
                const marker = document.querySelector(kind === 'space' ? '.space-drop-anchor' : '.favorites-drop-anchor');
                return marker && !marker.hidden && (kind === 'space' ? marker.dataset.anchorSpaceId === expected.anchorSpaceId : marker.dataset.beforeId === (expected.beforeId ?? ''));
            }, { polling: 50 }, { kind, expected });
            const readMarker = kind === 'space' ? readSpaceDropMarker : readFavoritesDropMarker;
            const assertMarker = kind === 'space' ? assertSpaceDropMarker : assertFavoritesDropMarker;
            const marker = assertMarker(await page.evaluate(readMarker), expected);
            const shot = await screenshot(page, label, true, { fullPage: false });
            const pixels = await page.evaluate(readMarkerScreenshotPixels, { base64: (await screenshotBytes(shot)).toString('base64'), marker });
            const paint = assertMarkerScreenshotPixels(pixels, marker);
            await page.mouse.up(); held = false;
            await page.waitForFunction(kind => document.querySelector(kind === 'space' ? '.space-drop-anchor' : '.favorites-drop-anchor')?.hidden === true && !document.querySelector('.dragging'), { polling: 50 }, kind);
            const events = await page.evaluate(() => globalThis.__favoriteVisualDragEvents);
            assert.equal(events.filter(event => event.type === 'dragstart' && event.isTrusted).length, 1);
            assert.equal(events.filter(event => event.type === 'drop' && event.isTrusted).length, 1);
            const evidence = { label, from, to, marker, paint, events, screenshot: shot.filename }; await record({ phase: 'compact-native-drag', ...evidence }); return evidence;
        } finally {
            if (held) {
                await favoriteDragInputClient(page).send('Input.cancelDragging').catch(() => {});
                const ended = await page.evaluate(() => globalThis.__favoriteVisualDragEvents.some(event => event.type === 'dragend' && event.isTrusted)).catch(() => false);
                if (ended) await page.mouse.up().catch(() => {});
            }
            await source.dispose(); await target.dispose();
        }
    });
    try {
        await page.waitForSelector('.space.active .space-name');
        await apiPage.waitForSelector('#favoritesLayout');
        const initialOptions = await apiPage.evaluate(() => ({ favoritesLayout: document.getElementById('favoritesLayout').value,
            favoriteTileSize: Number(document.getElementById('favoriteTileSize').value), spaceHeaderSize: Number(document.getElementById('spaceHeaderSize').value), disabled: document.getElementById('favoriteTileSize').disabled }));
        assert.deepEqual(initialOptions, { favoritesLayout: 'standard', favoriteTileSize: 44, spaceHeaderSize: 16, disabled: true });
        await page.waitForSelector('#pinnedFavicons[data-drag-listeners-bound="true"]');
        await poll(() => page.$$eval('#pinnedFavicons .saved-favorite', nodes => nodes.map(node => node.dataset.favoriteId)),
            ids => JSON.stringify(ids) === JSON.stringify(initial.favorites.map(item => item.id)), 'initial saved Favorite rendering before density seeds');
        const existing = await page.$$eval('#pinnedFavicons .pinned-favicon', nodes => nodes.length);
        const existingSaved = (await snapshot()).favorites.length, nativeCount = existing - existingSaved;
        let total = Math.max(7 + nativeCount, existing + 3); while (total % 4 === 0 || total % 6 === 0) total++;
        for (let index = existing; index < total; index++) {
            const bookmark = await apiPage.evaluate(options => chrome.bookmarks.create(options), { parentId: space.bookmarkFolderId, title: `Density Favorite ${index + 1}`, url: `${fixture.base}/favorite-persistent` });
            bookmarks.push(bookmark);
            const response = await requestScopedFavorite(page, fixture.windowA, 'addBookmark', { spaceId: space.id, bookmarkFolderId: space.bookmarkFolderId, bookmarkId: bookmark.id, parentId: bookmark.parentId });
            const favorite = response.favorites.find(item => item.sourceBookmarkId === bookmark.id); assert(favorite?.tabId); saved.push(favorite);
            await poll(() => apiPage.evaluate(id => chrome.tabs.get(id), favorite.tabId), tab => tab.status === 'complete', 'density fixture Favorite loads');
            await waitForRetainedFavoriteIcon({ apiPage, sidebar: page, favoriteId: favorite.id, closed: false, poll });
        }
        await apiPage.evaluate(ids => chrome.tabs.remove(ids), saved.filter((_, index) => index % 2 === 0).map(item => item.tabId));
        await poll(() => snapshot(), state => saved.filter((_, index) => index % 2 === 0).every(item => state.favorites.find(favorite => favorite.id === item.id)?.tabId === null), 'real closed density Favorites');
        const before = await prepareAppearanceBaseline({ apiPage, page, ui, read, record, windowId: fixture.windowA });
        const originalOrder = before.durable.map(item => item.id);
        await set('favoritesLayout', 'compact');
        assert.equal(await apiPage.$eval('#favoriteTileSize', node => node.disabled), false);
        await set('spaceHeaderSize', 12);
        const narrow = await geometry(224), wide = await geometry(350);
        await set('favoriteTileSize', 52);
        const adjusted = await geometry(350, 52, 12, false);
        await ui(apiPage, 'Reload options to verify saved appearance', () => apiPage.reload({ waitUntil: 'domcontentloaded' }));
        await apiPage.waitForFunction(() => document.getElementById('favoritesLayout')?.value === 'compact' && document.getElementById('favoriteTileSize')?.value === '52' && document.getElementById('spaceHeaderSize')?.value === '12', { polling: 50 });
        await ui(page, 'Reload sidebar to verify saved appearance', () => page.reload({ waitUntil: 'domcontentloaded' }));
        const reloaded = await geometry(350, 52, 12, false);
        await set('favoriteTileSize', 36); const smallest = await geometry(224, 36, 12, false);
        await set('favoriteTileSize', 64); await set('spaceHeaderSize', 20);
        const largest = await geometry(350, 64, 20, false);
        await set('favoriteTileSize', 44); await set('spaceHeaderSize', 12); await geometry(224);
        assertSavedFavoriteReorder(before, await read(), originalOrder);

        // Keep the actual title input reference across an in-place settings update.
        await ui(page, 'Focus smaller Space title with a real click', () => page.click('.space.active .space-name'));
        const name = await page.$('.space.active .space-name');
        try {
            assert.equal(await name.evaluate(node => document.activeElement === node), true);
            await set('spaceHeaderSize', 14);
            await page.waitForFunction(() => document.documentElement.dataset.spaceHeaderSize === '14', { polling: 50 });
            assert.equal(await name.evaluate(node => node.isConnected && document.activeElement === node), true, 'Changing appearance must not replace the focused title input.');
        } finally { await name.dispose(); }
        await set('spaceHeaderSize', 12); await geometry(224);
        await ui(page, 'Use compact Space header actions with keyboard', async () => {
            await page.click('.space.active .space-name');
            await tabToSelector(page, '.space.active .space-header .sidebar-button');
            await page.keyboard.press('Space');
            await page.waitForSelector('.space.active .archived-tabs-popup.visible');
            assert.equal(await page.$eval('.space.active .space-header .sidebar-button', node => node.getAttribute('aria-expanded')), 'true');
            await page.keyboard.press('Space');
            await page.waitForFunction(() => !document.querySelector('.space.active .archived-tabs-popup')?.classList.contains('visible'), { polling: 50 });
            await tabToSelector(page, '.space.active .space-header .space-options');
            const menu = await page.$eval('.space.active .space-options-dropdown', node => ({ visible: getComputedStyle(node).visibility, display: getComputedStyle(node).display, width: node.getBoundingClientRect().width }));
            assert.notEqual(menu.display, 'none'); assert.equal(menu.visible, 'visible'); assert(menu.width > 0);
            assert.equal(await page.$eval('.space.active .space-header .space-options', node => node.getAttribute('aria-expanded')), 'true');
            await page.click('.space.active .space-name'); await page.keyboard.press('Tab');
        });
        assertSavedFavoriteReorder(before, await read(), originalOrder);

        const compact = await page.evaluate(readSidebarAppearance), sourceId = saved.at(-1).id;
        const targetId = compact.tiles.find((tile, index) => index >= 4 && tile.id !== sourceId && !tile.id.startsWith('native:')).id;
        const fromIndex = originalOrder.indexOf(sourceId), without = originalOrder.filter(id => id !== sourceId), targetIndex = without.indexOf(targetId);
        const reorderedOrder = [...without.slice(0, targetIndex), sourceId, ...without.slice(targetIndex)];
        assert.notDeepEqual(reorderedOrder, originalOrder); assert(fromIndex >= 0);
        const wrappedDrag = await drag(icon(sourceId), icon(targetId), { sourceId, anchorId: targetId, beforeId: targetId, placement: 'before' }, 'favorite', 'compact-wrapped-row-favorite-marker-painted');
        assert(wrappedDrag.to.y > compact.tiles[0].rect.y, 'The destination must be on an actual wrapped row.');
        await poll(() => snapshot(), state => JSON.stringify(state.favorites.map(item => item.id)) === JSON.stringify(reorderedOrder), 'compact durable Favorite order');
        assertSavedFavoriteReorder(before, await read(), reorderedOrder);
        await ui(page, 'Reload compact reordered Favorites', () => page.reload({ waitUntil: 'domcontentloaded' }));
        await geometry(224); assertSavedFavoriteReorder(before, await read(), reorderedOrder);
        // Restore with actual input as well, preserving all pre-existing saved IDs.
        const nextId = originalOrder[fromIndex + 1], restoreAnchor = nextId || without.at(-1);
        await drag(icon(sourceId), icon(restoreAnchor), { sourceId, anchorId: restoreAnchor, beforeId: nextId || null, placement: nextId ? 'before' : 'after' }, 'favorite', 'compact-restore-original-favorite-order');
        await poll(() => snapshot(), state => JSON.stringify(state.favorites.map(item => item.id)) === JSON.stringify(originalOrder), 'restored original Favorite order');
        assertSavedFavoriteReorder(before, await read(), originalOrder);
        await geometry(350);
        const spaceOrder = (await snapshot()).spaces.map(item => item.id), movedId = spaceOrder[1], anchorId = spaceOrder[0];
        assert(spaceOrder.length >= 2); // Use adjacent visible chips, never an offscreen last chip.
        const chip = id => `#spaceSwitcher button[data-space-id="${id}"]`;
        const reorderedSpaces = [movedId, anchorId, ...spaceOrder.slice(2)];
        const spaceDrag = await drag(chip(movedId), chip(anchorId), { sourceSpaceId: movedId, anchorSpaceId: anchorId, placement: 'before' }, 'space', 'compact-header-preserves-real-space-chip-drag');
        await poll(() => snapshot(), state => JSON.stringify(state.spaces.map(item => item.id)) === JSON.stringify(reorderedSpaces), 'compact Space chip durable order');
        const reorderedState = await read();
        for (const original of before.states) {
            const state = reorderedState.states.find(state => state.windowId === original.windowId);
            assert.equal(state.activeSpaceId, original.activeSpaceId);
            assert.deepEqual(state.spaces, reorderedSpaces.map(id => original.spaces.find(space => space.id === id)));
        }
        assert.deepEqual(reorderedState.bookmarks, before.bookmarks); assert.deepEqual(reorderedState.tabs, before.tabs);
        // Real keyboard ordering restores the exact adjacent position without selecting the Space.
        await ui(page, 'Restore compact Space order with keyboard', async () => {
            await tabToSelector(page, chip(movedId));
            await page.keyboard.down('Alt'); await page.keyboard.down('Shift');
            try {
                await page.keyboard.press('ArrowRight');
                await poll(() => snapshot(), state => JSON.stringify(state.spaces.map(item => item.id)) === JSON.stringify(spaceOrder), 'one compact Space keyboard move');
            } finally { await page.keyboard.up('Shift'); await page.keyboard.up('Alt'); }
        });
        assertSavedFavoriteReorder(before, await read(), originalOrder);
        await reset();
        await ui(page, 'Verify default appearance restores captions and header size', async () => {
            await page.waitForFunction(() => document.documentElement.dataset.favoritesLayout === 'standard' && document.documentElement.dataset.spaceHeaderSize === '16', { polling: 50 });
            const state = await page.evaluate(readSidebarAppearance);
            assert.equal(state.header.fontSize, 16); assert(state.tiles.every(tile => tile.stateVisible));
            await screenshot(page, 'sidebar-appearance-reset-defaults', true, { fullPage: false });
        });
        await ui(apiPage, 'Verify default appearance survives options reload', () => apiPage.reload({ waitUntil: 'domcontentloaded' }));
        await apiPage.waitForFunction(() => document.getElementById('favoritesLayout')?.value === 'standard' && document.getElementById('favoriteTileSize')?.value === '44' && document.getElementById('favoriteTileSize')?.disabled && document.getElementById('spaceHeaderSize')?.value === '16', { polling: 50 });
        return { narrow, wide, adjusted, reloaded, smallest, largest, wrappedDrag, spaceDrag, observations, realInput: true, settingsWrite: 'options UI only', nativePanel: false };
    } catch (error) { primaryError = error; throw error; }
    finally {
        const errors = [];
        for (const cleanup of [reset, async () => {
            for (const favorite of saved) await requestScopedFavorite(page, fixture.windowA, 'remove', { favoriteId: favorite.id });
            await apiPage.evaluate(async ({ ids, bookmarks, sidebarId }) => {
                const live = new Set((await chrome.tabs.query({})).map(tab => tab.id));
                for (const id of [...ids, sidebarId]) if (live.has(id)) await chrome.tabs.remove(id);
                for (const id of bookmarks) await chrome.bookmarks.remove(id);
            }, { ids: saved.map(item => item.tabId), bookmarks: bookmarks.map(item => item.id), sidebarId: sidebar.tab.id });
        }]) try { await cleanup(); } catch (error) { errors.push(error.message); }
        if (errors.length) { if (primaryError) primaryError.cleanupErrors = errors; else throw Error(`Appearance cleanup failed: ${errors.join('; ')}`); }
    }
}
