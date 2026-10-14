/** Read-only retained-favicon evidence and real localhost fixture responses. */
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';

export const FAVORITE_FAVICON_PATH = '/favorite-retained-icon.png';
export const FAVORITE_FAVICON_SIZE = 32;
export const FAVORITE_FAVICON_COLORS = Object.freeze([
    Object.freeze([226, 43, 73, 255]), Object.freeze([30, 177, 105, 255]),
    Object.freeze([43, 91, 220, 255]), Object.freeze([249, 194, 45, 255])
]);
export const MAX_RETAINED_FAVICON_BYTES = 16 * 1024;
export const FAVORITE_ICON_CACHE_KEY = 'favoriteIconCache';
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function pngCrc(data) {
    let crc = 0xffffffff;
    for (const byte of data) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
    const chunk = Buffer.alloc(data.length + 12);
    chunk.writeUInt32BE(data.length); chunk.write(type, 4, 4, 'ascii'); data.copy(chunk, 8);
    chunk.writeUInt32BE(pngCrc(chunk.subarray(4, -4)), chunk.length - 4);
    return chunk;
}

function createFixturePng() {
    const size = FAVORITE_FAVICON_SIZE, header = Buffer.alloc(13);
    header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
    const scanlines = Buffer.alloc(size * (1 + size * 4));
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const color = FAVORITE_FAVICON_COLORS[(y >= size / 2 ? 2 : 0) + (x >= size / 2 ? 1 : 0)];
        scanlines.set(color, y * (1 + size * 4) + 1 + x * 4);
    }
    return Buffer.concat([PNG_SIGNATURE, pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(scanlines)), pngChunk('IEND', Buffer.alloc(0))]);
}

export const FAVORITE_FAVICON_PNG = createFixturePng();

// Call first in the existing localhost server. No production/page/API injection:
// Chrome discovers the genuine icon through the page's ordinary rel=icon link.
export function serveFavoriteIconFixture(request, response) {
    const path = new URL(request.url, 'http://127.0.0.1').pathname;
    if (path === FAVORITE_FAVICON_PATH) {
        response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': FAVORITE_FAVICON_PNG.length,
            'Cache-Control': 'public, max-age=86400' });
        response.end(FAVORITE_FAVICON_PNG); return true;
    }
    const title = { '/favorite-persistent': 'Saved Favorite Fixture', '/favorite-browser-restart': 'Restart Favorite Fixture' }[path];
    if (!title) return false;
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><link rel="icon" type="image/png" sizes="32x32" href="${FAVORITE_FAVICON_PATH}"></head><body><h1>${title}</h1><p>Real localhost page with a deterministic four-color favicon.</p></body></html>`);
    return true;
}

export function assertRetainedFaviconDataUrl(value) {
    assert.equal(typeof value, 'string', 'A retained PNG data URL is required.');
    assert(value.length <= 'data:image/png;base64,'.length + Math.ceil(MAX_RETAINED_FAVICON_BYTES / 3) * 4,
        'Retained favicon evidence must remain bounded.');
    assert(/^data:image\/png;base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value),
        'Only a canonical PNG data URL can prove retained icon bytes.');
    const encoded = value.slice('data:image/png;base64,'.length), bytes = Buffer.from(encoded, 'base64');
    assert(bytes.length > 32 && bytes.length <= MAX_RETAINED_FAVICON_BYTES);
    assert.equal(bytes.toString('base64'), encoded);
    assert(bytes.subarray(0, 8).equals(PNG_SIGNATURE), 'Retained bytes must have a PNG signature.');
    assert.equal(bytes.toString('ascii', 12, 16), 'IHDR');
    assert(bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(16) <= 128 && bytes.readUInt32BE(20) > 0 && bytes.readUInt32BE(20) <= 128,
        'Retained PNG must have bounded nonzero dimensions.');
    let offset = 8, idat = false, ended = false, headers = 0;
    while (offset < bytes.length) {
        assert(offset + 12 <= bytes.length, 'Retained PNG must contain complete chunks.');
        const length = bytes.readUInt32BE(offset), end = offset + length + 12;
        assert(end <= bytes.length, 'Retained PNG chunks cannot exceed its bytes.');
        const type = bytes.toString('ascii', offset + 4, offset + 8);
        assert.equal(bytes.readUInt32BE(end - 4), pngCrc(bytes.subarray(offset + 4, end - 4)), 'Retained PNG chunk CRC must match.');
        assert(!['acTL', 'fcTL', 'fdAT'].includes(type), 'Retained favicon must be a static PNG.');
        if (type === 'IHDR') { headers++; assert.equal(offset, 8); assert.equal(length, 13); }
        if (type === 'IDAT') { assert(length > 0); idat = true; }
        if (type === 'IEND') { assert.equal(length, 0); assert.equal(end, bytes.length); ended = true; }
        offset = end;
    }
    assert.equal(headers, 1); assert(idat && ended, 'Retained PNG must include image data and its terminal chunk.');
    return value;
}

export function assertLegacyFavoriteRegistry(records) {
    assert(Array.isArray(records), 'The original ordered Favorite registry must remain an array.');
    const seen = new Set(), sources = new Set();
    for (const record of records) {
        assert(record && typeof record === 'object' && !Array.isArray(record));
        assert.deepEqual(Object.keys(record).sort(), ['id', 'sourceBookmarkId', 'title', 'url'],
            'Raw persistentFavorites records must keep exactly the four legacy reader keys.');
        assert(typeof record.id === 'string' && record.id.length > 0 && record.id.length <= 200 && !seen.has(record.id),
            'Legacy Favorite IDs must remain bounded and distinct.');
        seen.add(record.id);
        assert.equal(typeof record.title, 'string'); assert.equal(typeof record.url, 'string');
        assert(record.title.length <= 4096, 'Legacy Favorite titles must remain bounded.');
        assert(record.url.length <= 16384 && ['http:', 'https:'].includes(new URL(record.url).protocol),
            'Legacy Favorite URLs must remain bounded valid HTTP(S) URLs.');
        assert(record.sourceBookmarkId === null || typeof record.sourceBookmarkId === 'string'
            && record.sourceBookmarkId.length > 0 && record.sourceBookmarkId.length <= 200);
        if (record.sourceBookmarkId !== null) {
            assert(!sources.has(record.sourceBookmarkId), 'Legacy nonnull source bookmark identities must remain unique.');
            sources.add(record.sourceBookmarkId);
        }
    }
    return records;
}

export function retainedFavoriteCache(cache, records) {
    assertLegacyFavoriteRegistry(records);
    // Old profiles with no optional cache remain valid, without invented bytes.
    if (cache === null || cache === undefined) return null;
    assert(cache && typeof cache === 'object' && !Array.isArray(cache));
    assert.deepEqual(Object.keys(cache).sort(), ['entries', 'version']); assert.equal(cache.version, 1);
    assert(Array.isArray(cache.entries));
    assert(Buffer.byteLength(JSON.stringify(cache), 'utf8') <= 2 * 1024 * 1024, 'The complete auxiliary icon cache must remain bounded.');
    const seen = new Set();
    for (const entry of cache.entries) {
        assert(entry && typeof entry === 'object' && !Array.isArray(entry));
        assert.deepEqual(Object.keys(entry).sort(), ['faviconDataUrl', 'favoriteId', 'url']);
        assert(typeof entry.favoriteId === 'string' && entry.favoriteId && !seen.has(entry.favoriteId), 'Cache entries must identify distinct saved Favorites.');
        seen.add(entry.favoriteId);
        const record = records.find(record => record.id === entry.favoriteId);
        assert(record, 'A retained cache entry must belong to an existing saved identity.');
        assert.equal(entry.url, record.url, 'Cache ownership requires both the exact Favorite ID and its saved URL.');
        assertRetainedFaviconDataUrl(entry.faviconDataUrl);
    }
    return cache;
}

export function assertFavoriteIconProjection(favorites, cache, records) {
    retainedFavoriteCache(cache, records);
    assert(Array.isArray(favorites));
    for (const favorite of favorites) {
        const entry = cache?.entries.find(entry => entry.favoriteId === favorite.id && entry.url === favorite.url);
        assert.equal(favorite.faviconDataUrl, entry?.faviconDataUrl, 'Internal UI records must join only the exact ID-and-saved-URL auxiliary icon.');
    }
}

// Browser callback: inspect the actual rendered HTMLImageElement. Decode its
// already-loaded pixels, not a separately constructed image or server bytes.
export function readRetainedFavoriteRender(favoriteId) {
    const matches = [...document.querySelectorAll('#pinnedFavicons .saved-favorite')]
        .filter(node => node.dataset.favoriteId === favoriteId);
    const node = matches[0];
    if (!node) return { favoriteId, matches: 0 };
    const images = [...node.querySelectorAll('img')], img = images[0];
    const result = { favoriteId: node.dataset.favoriteId, matches: matches.length, images: images.length,
        closed: node.classList.contains('favorite-closed'), tabId: node.dataset.tabId ? Number(node.dataset.tabId) : null };
    if (!img) return result;
    const rect = img.getBoundingClientRect(), style = getComputedStyle(img);
    Object.assign(result, { src: img.getAttribute('src'), currentSrc: img.currentSrc, complete: img.complete,
        naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight,
        width: rect.width, height: rect.height, display: style.display, visibility: style.visibility, opacity: style.opacity });
    if (!img.complete || !img.naturalWidth || !img.naturalHeight) return result;
    try {
        const canvas = new OffscreenCanvas(img.naturalWidth, img.naturalHeight);
        const context = canvas.getContext('2d', { willReadFrequently: true });
        context.drawImage(img, 0, 0);
        result.samples = [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]
            .map(([x, y]) => [...context.getImageData(Math.floor(x * img.naturalWidth), Math.floor(y * img.naturalHeight), 1, 1).data]);
    } catch (error) { result.pixelError = error.message; }
    return result;
}

export function assertRetainedFavoriteIcon(record, cacheEntry, render, { favoriteId, expectedUrl, expectedDataUrl, closed }) {
    assertLegacyFavoriteRegistry([record]);
    assert.equal(record?.id, favoriteId, 'Read the exact durable Favorite from local storage.');
    if (expectedUrl !== undefined) assert.equal(record.url, expectedUrl, 'The saved Favorite URL must remain unchanged.');
    assert(cacheEntry, 'Retained bytes must exist in the separate auxiliary cache.');
    retainedFavoriteCache({ version: 1, entries: [cacheEntry] }, [record]);
    const dataUrl = assertRetainedFaviconDataUrl(cacheEntry.faviconDataUrl);
    if (expectedDataUrl !== undefined) assert.equal(dataUrl, expectedDataUrl, 'The exact captured bytes must survive closure/restart.');
    assert.equal(render?.favoriteId, favoriteId); assert.equal(render.matches, 1); assert.equal(render.images, 1);
    assert.equal(render.closed, closed);
    if (closed) assert.equal(render.tabId, null); else assert(Number.isSafeInteger(render.tabId));
    assert.equal(render.src, dataUrl, 'The actual img must use the retained local bytes, not a favicon-cache/default URL.');
    assert.equal(render.currentSrc, dataUrl); assert.equal(render.complete, true);
    const bytes = Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64');
    assert.equal(render.naturalWidth, bytes.readUInt32BE(16)); assert.equal(render.naturalHeight, bytes.readUInt32BE(20));
    assert(Number.isInteger(render.naturalWidth) && render.naturalWidth >= 16 && render.naturalWidth <= 128);
    assert(Number.isInteger(render.naturalHeight) && render.naturalHeight === render.naturalWidth);
    assert(Number.isFinite(render.width) && render.width > 0); assert(Number.isFinite(render.height) && render.height > 0);
    assert.notEqual(render.display, 'none'); assert.equal(render.visibility, 'visible'); assert.equal(Number(render.opacity), 1);
    assert.equal(render.pixelError, undefined); assert.equal(render.samples?.length, 4);
    for (const [index, expected] of FAVORITE_FAVICON_COLORS.entries()) {
        const actual = render.samples[index];
        assert(Array.isArray(actual) && actual.length === 4 && actual.every(value => Number.isInteger(value) && value >= 0 && value <= 255));
        assert.equal(actual[3], 255, 'All four fixture quadrants must be opaque.');
        assert(expected.slice(0, 3).every((value, channel) => Math.abs(actual[channel] - value) <= 8),
            'Decoded real image pixels must match the nondefault four-color localhost favicon.');
    }
    return { favoriteId, url: record.url, faviconDataUrl: dataUrl, render };
}

export async function waitForRetainedFavoriteIcon({ apiPage, sidebar, favoriteId, expectedUrl, expectedDataUrl, closed, poll }) {
    return poll(async () => {
        const { records, iconCache } = await apiPage.evaluate(async () => {
            const local = await chrome.storage.local.get(['persistentFavorites', 'favoriteIconCache']);
            return { records: local.persistentFavorites, iconCache: local.favoriteIconCache ?? null };
        });
        assertLegacyFavoriteRegistry(records); retainedFavoriteCache(iconCache, records);
        const matches = records?.filter(record => record.id === favoriteId) || [];
        return { record: matches.length === 1 ? matches[0] : null,
            cacheEntry: iconCache?.entries.find(entry => entry.favoriteId === favoriteId), render: await sidebar.evaluate(readRetainedFavoriteRender, favoriteId) };
    }, observation => {
        try { assertRetainedFavoriteIcon(observation.record, observation.cacheEntry, observation.render, { favoriteId, expectedUrl, expectedDataUrl, closed }); return true; }
        catch { return false; }
    }, `exact retained and decoded Favorite favicon ${favoriteId} (${closed ? 'closed' : 'open'})`);
}
