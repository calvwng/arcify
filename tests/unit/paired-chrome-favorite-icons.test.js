// Pure PNG/HTTP/evidence unit tests. No browser or localhost server is started.
import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync, deflateSync } from 'node:zlib';
import { FAVORITE_FAVICON_PATH, FAVORITE_FAVICON_PNG, FAVORITE_FAVICON_SIZE, FAVORITE_FAVICON_COLORS,
    MAX_RETAINED_FAVICON_BYTES, serveFavoriteIconFixture, assertRetainedFaviconDataUrl, assertRetainedFavoriteIcon,
    waitForRetainedFavoriteIcon, assertLegacyFavoriteRegistry, retainedFavoriteCache, assertFavoriteIconProjection } from '../../scripts/paired-chrome-favorite-icons.mjs';

const dataUrl = bytes => `data:image/png;base64,${bytes.toString('base64')}`;
const sourceDataUrl = dataUrl(FAVORITE_FAVICON_PNG);
function chunks(bytes) {
    const result = [];
    for (let offset = 8; offset < bytes.length;) {
        const end = offset + bytes.readUInt32BE(offset) + 12;
        result.push({ type: bytes.toString('ascii', offset + 4, offset + 8), data: bytes.subarray(offset + 8, end - 4), bytes: bytes.subarray(offset, end) });
        offset = end;
    }
    return result;
}
function crc(data) {
    let value = 0xffffffff;
    for (const byte of data) {
        value ^= byte;
        for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
    }
    return (value ^ 0xffffffff) >>> 0;
}
function reencodedPng() {
    const parts = chunks(FAVORITE_FAVICON_PNG), payload = deflateSync(inflateSync(parts.find(chunk => chunk.type === 'IDAT').data), { level: 0 });
    const idat = Buffer.alloc(payload.length + 12);
    idat.writeUInt32BE(payload.length); idat.write('IDAT', 4); payload.copy(idat, 8);
    idat.writeUInt32BE(crc(idat.subarray(4, -4)), idat.length - 4);
    return Buffer.concat([FAVORITE_FAVICON_PNG.subarray(0, 8), ...parts.map(chunk => chunk.type === 'IDAT' ? idat : chunk.bytes)]);
}
function evidence(value = sourceDataUrl, closed = true) {
    return { record: { id: 'saved-fixture', title: 'Fixture', url: 'http://fixture.test/saved', sourceBookmarkId: null },
        cacheEntry: { favoriteId: 'saved-fixture', url: 'http://fixture.test/saved', faviconDataUrl: value }, render: {
        favoriteId: 'saved-fixture', matches: 1, images: 1, closed, tabId: closed ? null : 123,
        src: value, currentSrc: value, complete: true, naturalWidth: 32, naturalHeight: 32,
        width: 24, height: 24, display: 'block', visibility: 'visible', opacity: '1',
        samples: FAVORITE_FAVICON_COLORS.map(color => [...color])
    } };
}
const expected = { favoriteId: 'saved-fixture', closed: true };
const verify = value => assertRetainedFavoriteIcon(value.record, value.cacheEntry, value.render, expected);

test('raw registry retains exactly the four legacy keys while icons live in a separate cache', () => {
    const value = evidence(), records = [value.record], cache = { version: 1, entries: [value.cacheEntry] };
    assert.deepEqual(assertLegacyFavoriteRegistry(records), records);
    assert.deepEqual(retainedFavoriteCache(cache, records), cache);
    assert.equal(retainedFavoriteCache(undefined, records), null);
    assert.equal(retainedFavoriteCache(null, records), null);
    assert.doesNotThrow(() => assertFavoriteIconProjection([{ ...value.record, tabId: null }], null, records));
    assert.doesNotThrow(() => assertFavoriteIconProjection([{ ...value.record, tabId: 12, faviconDataUrl: sourceDataUrl }], cache, records));
    assert.throws(() => assertLegacyFavoriteRegistry([{ ...value.record, faviconDataUrl: sourceDataUrl }]));
    assert.throws(() => assertLegacyFavoriteRegistry([{ ...value.record, tabId: null }]));
    assert.throws(() => assertLegacyFavoriteRegistry([value.record, value.record]));
});

test('legacy registry validation accepts the original exact field-length boundaries', () => {
    const record = { id: 'i'.repeat(200), title: 't'.repeat(4096), url: 'https://fixture.test/'.padEnd(16384, 'u'), sourceBookmarkId: 's'.repeat(200) };
    assert.deepEqual(assertLegacyFavoriteRegistry([record]), [record]);
    assert.doesNotThrow(() => assertLegacyFavoriteRegistry([
        { ...record, id: 'one', sourceBookmarkId: null }, { ...record, id: 'two', sourceBookmarkId: null }
    ]));
});

for (const [name, mutate] of [
    ['empty ID', records => { records[0].id = ''; }],
    ['overlong ID', records => { records[0].id = 'i'.repeat(201); }],
    ['overlong title', records => { records[0].title = 't'.repeat(4097); }],
    ['empty source identity', records => { records[0].sourceBookmarkId = ''; }],
    ['overlong source identity', records => { records[0].sourceBookmarkId = 's'.repeat(201); }],
    ['duplicate nonnull source identity', records => {
        records[0].sourceBookmarkId = 'bookmark-one'; records.push({ ...records[0], id: 'different-id' });
    }],
    ['overlong URL', records => { records[0].url = 'https://fixture.test/'.padEnd(16385, 'u'); }],
    ['malformed URL', records => { records[0].url = 'http://['; }],
    ['relative URL', records => { records[0].url = '/favorite'; }],
    ['empty URL', records => { records[0].url = ''; }],
    ['file URL', records => { records[0].url = 'file:///tmp/favorite'; }],
    ['extension URL', records => { records[0].url = 'chrome-extension://fixture/page'; }],
    ['data URL', records => { records[0].url = sourceDataUrl; }]
]) test(`legacy registry compatibility rejects ${name}`, () => {
    const records = [evidence().record]; mutate(records); assert.throws(() => assertLegacyFavoriteRegistry(records));
});

test('auxiliary icon join never guesses a different saved identity from the same URL', () => {
    const value = evidence(), twin = { ...value.record, id: 'different-saved-id' }, records = [value.record, twin];
    const cache = { version: 1, entries: [value.cacheEntry] };
    assert.doesNotThrow(() => assertFavoriteIconProjection([{ ...value.record, faviconDataUrl: sourceDataUrl }, twin], cache, records));
    assert.throws(() => assertFavoriteIconProjection([{ ...value.record, faviconDataUrl: sourceDataUrl }, { ...twin, faviconDataUrl: sourceDataUrl }], cache, records));
    assert.throws(() => assertFavoriteIconProjection([{ ...value.record, url: 'http://fixture.test/other', faviconDataUrl: sourceDataUrl }], cache, records));
    assert.throws(() => assertRetainedFavoriteIcon(value.record, value.cacheEntry, value.render, { ...expected, expectedUrl: 'http://fixture.test/other' }));
});

for (const [name, mutate] of [
    ['wrong cache version', cache => { cache.version = 2; }],
    ['extra envelope keys', cache => { cache.records = []; }],
    ['missing entry identity', cache => { delete cache.entries[0].favoriteId; }],
    ['unrelated saved identity', cache => { cache.entries[0].favoriteId = 'missing-record'; }],
    ['stale saved URL', cache => { cache.entries[0].url = 'http://fixture.test/other'; }],
    ['duplicate identity entries', cache => { cache.entries.push({ ...cache.entries[0] }); }],
    ['extra entry keys', cache => { cache.entries[0].title = 'misplaced metadata'; }],
    ['invalid cache image', cache => { cache.entries[0].faviconDataUrl = 'https://fixture.test/image'; }]
]) test(`auxiliary cache evidence rejects ${name}`, () => {
    const value = evidence(), cache = { version: 1, entries: [value.cacheEntry] }; mutate(cache);
    assert.throws(() => retainedFavoriteCache(cache, [value.record]));
});

test('auxiliary cache byte bound includes saved URL and identity metadata', () => {
    const records = Array.from({ length: 140 }, (_, index) => ({ ...evidence().record, id: `saved-${index}`,
        url: `https://fixture.test/${index}/`.padEnd(16000, 'u') }));
    const cache = { version: 1, entries: records.map(record => ({ favoriteId: record.id, url: record.url, faviconDataUrl: sourceDataUrl })) };
    assert.doesNotThrow(() => assertLegacyFavoriteRegistry(records));
    assert(sourceDataUrl.length * records.length < 2 * 1024 * 1024, 'Image bytes alone remain below the cache budget.');
    assert.throws(() => retainedFavoriteCache(cache, records), /complete auxiliary icon cache/);
});

test('localhost fixture is a valid deterministic four-quadrant RGBA PNG', () => {
    assert.equal(assertRetainedFaviconDataUrl(sourceDataUrl), sourceDataUrl);
    const parts = chunks(FAVORITE_FAVICON_PNG), header = parts[0].data;
    assert.equal(header.readUInt32BE(0), FAVORITE_FAVICON_SIZE); assert.equal(header.readUInt32BE(4), FAVORITE_FAVICON_SIZE);
    assert.deepEqual([...header.subarray(8)], [8, 6, 0, 0, 0]);
    const pixels = inflateSync(parts.find(chunk => chunk.type === 'IDAT').data);
    assert.equal(pixels.length, 32 * (32 * 4 + 1));
    for (let y = 0; y < 32; y++) {
        assert.equal(pixels[y * 129], 0);
        for (let x = 0; x < 32; x++) assert.deepEqual([...pixels.subarray(y * 129 + 1 + x * 4, y * 129 + 5 + x * 4)],
            FAVORITE_FAVICON_COLORS[(y >= 16 ? 2 : 0) + (x >= 16 ? 1 : 0)]);
    }
});

test('fixture server handler supplies real page/icon responses and leaves other routes alone', () => {
    for (const path of ['/favorite-persistent', '/favorite-browser-restart']) {
        const response = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = body; } };
        assert.equal(serveFavoriteIconFixture({ url: path }, response), true);
        assert.equal(response.status, 200); assert.match(response.headers['Content-Type'], /^text\/html/);
        assert(response.body.includes(`href="${FAVORITE_FAVICON_PATH}"`)); assert.match(response.body, /rel="icon"/);
        assert.doesNotMatch(response.body, /<script|data:image|chrome\./);
    }
    const response = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = body; } };
    assert.equal(serveFavoriteIconFixture({ url: `${FAVORITE_FAVICON_PATH}?cached=1` }, response), true);
    assert.equal(response.headers['Content-Type'], 'image/png'); assert.deepEqual(response.body, FAVORITE_FAVICON_PNG);
    assert.equal(response.headers['Content-Length'], FAVORITE_FAVICON_PNG.length);
    assert.equal(serveFavoriteIconFixture({ url: '/ordinary-fixture' }, { writeHead() { assert.fail('Unhandled route wrote response'); } }), false);
});

test('decoded color evidence accepts Chrome re-encoding instead of demanding original PNG bytes', () => {
    const differentEncoding = dataUrl(reencodedPng());
    assert.notEqual(differentEncoding, sourceDataUrl);
    assert.doesNotThrow(() => verify(evidence(differentEncoding)));
    assert.doesNotThrow(() => assertRetainedFavoriteIcon(evidence(differentEncoding).record, evidence(differentEncoding).cacheEntry, evidence(differentEncoding).render,
        { ...expected, expectedDataUrl: differentEncoding }));
    assert.throws(() => assertRetainedFavoriteIcon(evidence(differentEncoding).record, evidence(differentEncoding).cacheEntry, evidence(differentEncoding).render,
        { ...expected, expectedDataUrl: sourceDataUrl }), /exact captured bytes/);
});

for (const [name, value] of [
    ['missing', undefined], ['null', null], ['remote favicon', 'https://example.test/favicon.png'],
    ['Chrome cache URL', 'chrome-extension://example/_favicon/?pageUrl=http://fixture/'],
    ['SVG masquerading as PNG', dataUrl(Buffer.from('<svg><rect fill="red"/></svg>'))],
    ['wrong MIME', sourceDataUrl.replace('image/png', 'image/jpeg')], ['whitespace encoding', `${sourceDataUrl}\n`],
    ['truncated PNG', dataUrl(FAVORITE_FAVICON_PNG.subarray(0, 33))],
    ['extra trailing bytes', dataUrl(Buffer.concat([FAVORITE_FAVICON_PNG, Buffer.from([0])]))],
    ['unbounded PNG', dataUrl(Buffer.alloc(MAX_RETAINED_FAVICON_BYTES + 1))],
    ['corrupt CRC', dataUrl(Buffer.from(FAVORITE_FAVICON_PNG).fill(0, FAVORITE_FAVICON_PNG.length - 4))]
]) test(`retained icon bytes reject ${name}`, () => assert.throws(() => assertRetainedFaviconDataUrl(value)));

for (const [name, mutate] of [
    ['different saved identity', value => { value.record.id = 'other'; }],
    ['legacy registry polluted by icon bytes', value => { value.record.faviconDataUrl = sourceDataUrl; }],
    ['cache entry missing', value => { delete value.cacheEntry; }],
    ['cache owner changed', value => { value.cacheEntry.favoriteId = 'other'; }],
    ['cache saved URL changed', value => { value.cacheEntry.url = 'http://fixture.test/other'; }],
    ['different rendered identity', value => { value.render.favoriteId = 'other'; }],
    ['duplicated favorite', value => { value.render.matches = 2; }], ['missing image', value => { value.render.images = 0; }],
    ['still-open saved record', value => { value.render.closed = false; }], ['stale live binding', value => { value.render.tabId = 123; }],
    ['URL-cache fallback', value => { value.render.src = 'chrome-extension://example/_favicon/'; }],
    ['default-icon fallback', value => { value.render.currentSrc = 'assets/default_icon.png'; }],
    ['unloaded image', value => { value.render.complete = false; }], ['broken image', value => { value.render.naturalWidth = 0; }],
    ['different PNG size', value => { value.render.naturalWidth = value.render.naturalHeight = 16; }],
    ['collapsed image', value => { value.render.width = 0; }], ['hidden image', value => { value.render.visibility = 'hidden'; }],
    ['display-none image', value => { value.render.display = 'none'; }], ['transparent element', value => { value.render.opacity = '0'; }],
    ['canvas security failure', value => { value.render.pixelError = 'SecurityError'; }],
    ['absent decoded pixels', value => { delete value.render.samples; }],
    ['default gray pixels', value => { value.render.samples = Array.from({ length: 4 }, () => [128, 128, 128, 255]); }],
    ['uniform colored square', value => { value.render.samples = Array.from({ length: 4 }, () => [...FAVORITE_FAVICON_COLORS[0]]); }],
    ['transparent pixels', value => { value.render.samples[2][3] = 0; }],
    ['wrong quadrant', value => { value.render.samples.reverse(); }], ['invalid pixel values', value => { value.render.samples[0][0] = NaN; }]
]) test(`retained real-image evidence rejects ${name}`, () => { const value = evidence(); mutate(value); assert.throws(() => verify(value)); });

test('open image evidence requires an exact live binding', () => {
    const value = evidence(sourceDataUrl, false);
    assert.doesNotThrow(() => assertRetainedFavoriteIcon(value.record, value.cacheEntry, value.render, { ...expected, closed: false }));
    value.render.tabId = null;
    assert.throws(() => assertRetainedFavoriteIcon(value.record, value.cacheEntry, value.render, { ...expected, closed: false }));
});

test('capture polling requires both raw durable bytes and decoded actual image evidence', async () => {
    const value = evidence(), observations = [];
    const apiPage = { evaluate: async () => ({ records: [value.record], iconCache: { version: 1, entries: [value.cacheEntry] } }) };
    const sidebar = { evaluate: async (_callback, id) => { assert.equal(id, expected.favoriteId); return structuredClone(value.render); } };
    const result = await waitForRetainedFavoriteIcon({ apiPage, sidebar, ...expected,
        poll: async (read, accept) => {
            const complete = value.render.complete; value.render.complete = false;
            observations.push(accept(await read())); value.render.complete = complete;
            const observed = await read(); observations.push(accept(observed)); return observed;
        } });
    assert.deepEqual(observations, [false, true]); assert.deepEqual(result, value);
});
