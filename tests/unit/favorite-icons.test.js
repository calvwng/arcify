import test from 'node:test';
import assert from 'node:assert/strict';
import { captureFavoriteIcon, favoriteIconCacheUrl, isFavoriteIcon, MAX_FAVORITE_ICON_BYTES } from '../../favorite-icons.js';
import { pngIcon } from '../fixtures/favorite-icons.js';

const SELF = 'b'.repeat(32), PAGE = 'https://saved.test/?private=query#fragment';
const api = { runtime: { id: SELF, getURL: path => `chrome-extension://${SELF}/${path}` } };
const bytes = icon => Buffer.from(icon.split(',')[1], 'base64');
const generic = pngIcon({ red: 0 });
const isProbe = url => new URL(new URL(url).searchParams.get('pageUrl')).hostname.endsWith('.arcify-favicon-cache-miss.invalid');
const cacheResponse = (url, icon = pngIcon(), headers = {}) => new Response(bytes(isProbe(url) ? generic : icon), { headers });

test('accepts bounded static PNG only, rejects malformed bytes, CRC, dimensions, trailing data and executable formats', () => {
    assert(isFavoriteIcon(pngIcon()));
    const corrupt = bytes(pngIcon()); corrupt[45] ^= 1;
    for (const value of [undefined, null, {}, 42, '', 'https://remote.test/favicon.png', 'javascript:alert(1)',
        'data:image/svg+xml,<svg/>', 'data:image/png;base64,PHN2Zy8+', 'data:image/png;base64,===',
        pngIcon().replace('image/png', 'image/gif'), pngIcon().replace('base64,', 'base64, '),
        `data:image/png;base64,${corrupt.toString('base64')}`, `${pngIcon()}AAAA`,
        pngIcon({ width: 129 }), pngIcon({ height: 129 }), pngIcon({ width: 0 }),
        pngIcon({ extra: [['acTL', Buffer.alloc(8)]] }), pngIcon({ extra: [['tEXt', Buffer.alloc(MAX_FAVORITE_ICON_BYTES)]] })]) {
        assert.equal(isFavoriteIcon(value), false, String(value).slice(0, 100));
    }
});

test('cache route is own-extension only with encoded pageUrl, size32 and disabled host/server fallback', () => {
    const url = new URL(favoriteIconCacheUrl(PAGE, api));
    assert.equal(url.protocol, 'chrome-extension:'); assert.equal(url.hostname, SELF); assert.equal(url.pathname, '/_favicon/');
    assert.deepEqual([...url.searchParams], [['pageUrl', PAGE], ['size', '32'], ['fallbackToHost', '0'], ['allowGoogleServerFallback', '0']]);
    assert.equal(favoriteIconCacheUrl('javascript:alert(1)', api), null);
    assert.equal(favoriteIconCacheUrl(PAGE, { runtime: { ...api.runtime, getURL: () => 'https://remote.test/' } }), null);
});

test('copies local cache PNG bytes without fetching the remote tab icon, credentials, or redirects', async () => {
    const calls = [], icon = pngIcon();
    const result = await captureFavoriteIcon(PAGE, { api, dataUrl: 'https://tracker.test/icon', fetchIcon: async (url, options) => {
        calls.push([url, options]); return cacheResponse(url, icon, { 'content-type': 'image/png' });
    } });
    assert.equal(result, icon); assert.equal(calls.length, 3);
    assert(calls.every(([url]) => new URL(url).hostname === SELF));
    assert(isProbe(calls[0][0])); assert(!isProbe(calls[1][0])); assert.equal(calls[0][0], calls[2][0]);
    assert.equal(new URL(calls[0][0]).hostname, SELF); assert.equal(calls[0][1].redirect, 'error'); assert.equal(calls[0][1].credentials, 'omit');
    assert(calls[0][1].signal instanceof AbortSignal);
    assert.equal(await captureFavoriteIcon(PAGE, { api, dataUrl: icon, fetchIcon() { throw Error('must not fetch data'); } }), icon);
});

test('accepts actual PNG bytes despite Chromium extension loader image/bmp label or absent MIME header', async () => {
    for (const headers of [{ 'content-type': 'image/bmp' }, {}]) {
        assert.equal(await captureFavoriteIcon(PAGE, { api, fetchIcon: async url => cacheResponse(url, pngIcon(), headers) }), pngIcon());
    }
});

test('missing, unavailable, non-PNG, redirected, too-large and invalid streamed cache responses safely fall back', async () => {
    const icon = pngIcon();
    const cases = [() => { throw Error('cache unavailable'); },
        () => new Response(null, { status: 404 }),
        () => new Response('<svg xmlns="http://www.w3.org/2000/svg"/>', { headers: { 'content-type': 'image/png' } }),
        () => new Response(bytes(icon), { headers: { 'content-type': 'image/png', 'content-length': MAX_FAVORITE_ICON_BYTES + 1 } }),
        () => new Response(new Uint8Array(MAX_FAVORITE_ICON_BYTES + 1), { headers: { 'content-type': 'image/png' } }),
        () => new Response('not a png', { headers: { 'content-type': 'image/png' } }),
        () => ({ ok: true, redirected: true }), () => ({ ok: true, url: 'https://elsewhere.test/' })];
    for (const fetchIcon of cases) assert.equal(await captureFavoriteIcon(PAGE, { api, fetchIcon }), null);
    let aborted = false;
    assert.equal(await captureFavoriteIcon(PAGE, { api, timeout: 2, fetchIcon: (_, { signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => { aborted = true; reject(Error('aborted')); });
    }) }), null);
    assert(aborted);
});

test('oversized streams are canceled instead of being buffered without a bound', async () => {
    let canceled = false;
    const response = new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(MAX_FAVORITE_ICON_BYTES + 1)); },
        cancel() { canceled = true; } }), { headers: { 'content-type': 'image/png' } });
    assert.equal(await captureFavoriteIcon(PAGE, { api, fetchIcon: async () => response }), null);
    assert(canceled);
});


test('generic default PNG is never persisted; unavailable or changing default comparison stays best effort', async () => {
    assert.equal(await captureFavoriteIcon(PAGE, { api, fetchIcon: async () => new Response(bytes(generic)) }), null);
    assert.equal(await captureFavoriteIcon(PAGE, { api, fetchIcon: async url => isProbe(url)
        ? new Response(null, { status: 404 }) : new Response(bytes(pngIcon())) }), null);
    let probes = 0;
    assert.equal(await captureFavoriteIcon(PAGE, { api, fetchIcon: async url => new Response(bytes(isProbe(url)
        ? ++probes === 1 ? generic : pngIcon({ red: 120 }) : pngIcon())) }), null);
});
