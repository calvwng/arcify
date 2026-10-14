// Evidence validation only. These tests never start Chrome or a profile.
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertFavoritesDropMarker, assertFavoritesMarkerHidden, assertSavedFavoriteReorder } from '../../scripts/paired-chrome-favorites-marker.mjs';
import { assertMarkerScreenshotPixels } from '../../scripts/paired-chrome-space-marker.mjs';
import { FAVORITE_FAVICON_PNG } from '../../scripts/paired-chrome-favorite-icons.mjs';

const retainedIcon = `data:image/png;base64,${FAVORITE_FAVICON_PNG.toString('base64')}`;

const expected = { sourceId: 'saved-c', anchorId: 'saved-a', beforeId: 'saved-a', placement: 'before' };
const marker = () => ({ ...expected, count: 1, bodyChild: true, hidden: false, list: 'saved', draggingCount: 1,
    rect: { x: 94.5, y: 102, width: 3, height: 44 }, anchor: { x: 100, y: 100, width: 80, height: 48 },
    container: { x: 10, y: 100, width: 340, height: 104 }, viewport: { width: 360, height: 900, scale: 1 },
    style: { display: 'block', visibility: 'visible', opacity: '1', position: 'fixed', pointerEvents: 'none', color: 'rgb(37, 99, 235)' } });
const hidden = () => ({ count: 1, bodyChild: true, hidden: true, style: { display: 'none' } });
const pixels = () => ({ width: 360, height: 900, samples: Array.from({ length: 34 }, () => ({
    line: [37, 99, 235, 255], left: [220, 220, 220, 255], right: [220, 220, 220, 255] })) });

test('saved marker requires the exact stable-ID before and append-after destination', () => {
    assertFavoritesDropMarker(marker(), expected);
    const after = marker(); after.placement = 'after'; after.beforeId = ''; after.rect.x = 182.5;
    assertFavoritesDropMarker(after, { ...expected, placement: 'after', beforeId: null });
});
test('outer boundary clamps inside actual container while retaining anchor identity', () => {
    const state = marker(); state.anchor.x = 10; state.rect.x = 11.5;
    assertFavoritesDropMarker(state, expected);
    state.placement = 'after'; state.beforeId = ''; state.anchor.x = 270; state.rect.x = 345.5;
    assertFavoritesDropMarker(state, { ...expected, placement: 'after', beforeId: null });
});
for (const [name, mutate] of Object.entries({
    hidden: s => { s.hidden = true; }, duplicate: s => { s.count = 2; }, layoutChild: s => { s.bodyChild = false; },
    wrongList: s => { s.list = 'native'; }, wrongSource: s => { s.sourceId = 'saved-other'; },
    multipleSources: s => { s.draggingCount = 2; }, wrongAnchor: s => { s.anchorId = 'saved-other'; },
    wrongBefore: s => { s.beforeId = ''; }, wrongPlacement: s => { s.placement = 'after'; },
    noAnchor: s => { s.anchor = null; }, noContainer: s => { s.container = null; },
    offscreen: s => { s.anchor.x = -50; s.rect.x = 11.5; }, clipped: s => { s.rect.x = -2; },
    shifted: s => { s.rect.x += 7; }, shiftedVertically: s => { s.rect.y += 7; },
    tiny: s => { s.rect.width = 1; }, short: s => { s.rect.height = 4; },
    transparent: s => { s.style.color = 'rgba(37, 99, 235, 0)'; }, unpainted: s => { s.style.display = 'none'; },
    faded: s => { s.style.opacity = '0.2'; }, interceptsMouse: s => { s.style.pointerEvents = 'auto'; },
    invalidScale: s => { s.viewport.scale = 0; }
})) test(`Favorites marker rejects ${name} false evidence`, () => {
    const state = marker(); mutate(state); assert.throws(() => assertFavoritesDropMarker(state, expected));
});
test('hidden proof requires an implemented but unpainted marker with discarded metadata', () => {
    assertFavoritesMarkerHidden(hidden());
    for (const state of [null, { ...hidden(), count: 0 }, { ...hidden(), bodyChild: false },
        { ...hidden(), hidden: false }, { ...hidden(), style: { display: 'block' } },
        ...['list', 'placement', 'beforeId', 'anchorId'].map(field => ({ ...hidden(), [field]: 'stale' }))]) {
        assert.throws(() => assertFavoritesMarkerHidden(state));
    }
});
test('saved marker screenshot must paint a substantial contrasting line, beyond a DOM class', () => {
    assert.deepEqual(assertMarkerScreenshotPixels(pixels(), marker()), { samples: 34, colorMatches: 34, contrasting: 34, expectedColor: [37, 99, 235] });
    for (const mutate of [image => { image.samples.forEach(s => { s.line = s.left; }); },
        image => { image.samples.forEach(s => { s.left = s.line; s.right = s.line; }); },
        image => { image.samples = []; }, image => { image.width = 900; }]) {
        const image = pixels(); mutate(image); assert.throws(() => assertMarkerScreenshotPixels(image, marker()));
    }
});

const favorites = () => [
    { id: 'a', title: 'Same title', url: 'http://fixture.test/same', sourceBookmarkId: 'bookmark-a' },
    { id: 'b', title: 'Same title', url: 'http://fixture.test/same', sourceBookmarkId: 'bookmark-b' },
    { id: 'c', title: 'Third', url: 'http://fixture.test/third', sourceBookmarkId: 'bookmark-c' }
];
const original = () => ({ durable: favorites(),
    iconCache: { version: 1, entries: [{ favoriteId: 'a', url: 'http://fixture.test/same', faviconDataUrl: retainedIcon }] },
    tabs: [{ id: 100, windowId: 1, index: 0, url: 'http://fixture.test/same', pinned: true, active: false, incognito: false, groupId: -1 },
        { id: 101, windowId: 1, index: 1, url: 'http://fixture.test/same', pinned: true, active: false, incognito: false, groupId: -1 }],
    windows: [{ id: 1, type: 'normal', incognito: false }, { id: 2, type: 'normal', incognito: false }],
    session: { version: 1, bindings: [{ favoriteId: 'a', windowId: 1, tabId: 100 }], attempts: [] },
    bookmarks: [{ id: 'root', children: favorites().map((item, index) => ({ id: item.sourceBookmarkId, title: item.title, url: item.url, parentId: 'root', index })) }],
    states: [1, 2].map(windowId => ({ windowId, activeSpaceId: `space-${windowId}`,
        spaces: [{ id: 'space-1', tabIds: [201], pinnedTabIds: [], temporaryTabIds: [201] }],
        favorites: favorites().map(item => ({ ...item, tabId: item.id === 'a' && windowId === 1 ? 100 : null })) })) });
function reordered() {
    const before = original(), after = structuredClone(before), order = ['c', 'a', 'b'];
    after.durable = order.map(id => after.durable.find(item => item.id === id));
    for (const state of after.states) state.favorites = order.map(id => state.favorites.find(item => item.id === id));
    return { before, after, order };
}
test('real reorder evidence preserves exact duplicate-URL identities, metadata, pins, sources and other-window state', () => {
    const h = reordered(); assertSavedFavoriteReorder(h.before, h.after, h.order);
    const noop = original(); assertSavedFavoriteReorder(noop, structuredClone(noop), ['a', 'b', 'c']);
});
for (const [name, mutate] of Object.entries({
    missingRecord: h => { h.after.durable.pop(); }, changedTitle: h => { h.after.durable[0].title = 'changed'; },
    changedSource: h => { h.after.durable[0].sourceBookmarkId = 'bookmark-other'; },
    changedRetainedIcon: h => { h.after.iconCache.entries[0].faviconDataUrl += 'changed'; },
    changedIconIdentity: h => { h.after.iconCache.entries[0].favoriteId = 'b'; },
    changedIconSavedURL: h => { h.after.iconCache.entries[0].url += '/changed'; },
    discardedIconCache: h => { h.after.iconCache = null; },
    pollutedLegacyRegistry: h => { h.after.durable[1].faviconDataUrl = 'data:image/png;base64,retained'; },
    duplicateExpectedId: h => { h.order[0] = 'a'; }, forgedExpectedId: h => { h.order[0] = 'other'; },
    changedPin: h => { h.after.tabs[0].pinned = false; }, nativeOrderChange: h => { h.after.tabs[0].index++; },
    switchedTab: h => { h.after.tabs[0].active = true; }, navigatedTab: h => { h.after.tabs[0].url += '/changed'; },
    closedTab: h => { h.after.tabs.pop(); }, replacementTab: h => { h.after.tabs[0].id++; },
    movedWindow: h => { h.after.tabs[0].windowId = 2; }, closedWindow: h => { h.after.windows.pop(); },
    changedBinding: h => { h.after.session.bindings[0].tabId = 101; },
    movedSource: h => { h.after.bookmarks[0].children[0].index++; },
    activeSpace: h => { h.after.states[0].activeSpaceId = 'changed'; },
    changedMembership: h => { h.after.states[0].spaces[0].tabIds.push(100); },
    staleOtherWindow: h => { h.after.states[1].favorites.reverse(); },
    missingWindowRead: h => { h.after.states.pop(); },
    guessedURLBinding: h => { h.after.states[0].favorites[1].tabId = 101; }
})) test(`saved reorder evidence rejects ${name}`, () => {
    const h = reordered(); mutate(h); assert.throws(() => assertSavedFavoriteReorder(h.before, h.after, h.order));
});
