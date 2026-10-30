import { isFavoriteUrl } from './spotlight-bridge-protocol.js';

export const MAX_FAVORITE_ICON_BYTES = 16 * 1024;
export const MAX_FAVORITE_ICON_DIMENSION = 128;
export const MAX_FAVORITE_ICON_CACHE = 2 * 1024 * 1024;
export const FAVORITE_ICON_CACHE_KEY = 'favoriteIconCache';
const PREFIX = 'data:image/png;base64,';
const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

// Only small, static PNG containers may cross the durable-storage boundary.
// Never persist remote URLs, SVG markup, arbitrary data types or unbounded images.
export function isFavoriteIcon(value) {
    if (typeof value !== 'string' || !value.startsWith(PREFIX)
        || value.length > PREFIX.length + 4 * Math.ceil(MAX_FAVORITE_ICON_BYTES / 3)) return false;
    const encoded = value.slice(PREFIX.length);
    if (!encoded || encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return false;
    try {
        const decoded = atob(encoded);
        if (decoded.length > MAX_FAVORITE_ICON_BYTES || btoa(decoded) !== encoded) return false;
        return isSmallPng(Uint8Array.from(decoded, char => char.charCodeAt(0)));
    } catch { return false; }
}

function isSmallPng(bytes) {
    if (bytes.length < 57 || !SIGNATURE.every((byte, i) => bytes[i] === byte)) return false;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 8, hasData = false;
    while (offset + 12 <= bytes.length) {
        const size = view.getUint32(offset), end = offset + size + 12;
        if (end > bytes.length) return false;
        const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
        if (!/^[A-Za-z]{4}$/.test(type) || type === 'acTL') return false;
        let crc = 0xffffffff;
        for (const byte of bytes.subarray(offset + 4, end - 4)) {
            crc ^= byte;
            for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
        }
        if (((crc ^ 0xffffffff) >>> 0) !== view.getUint32(end - 4)) return false;
        if (offset === 8) {
            if (type !== 'IHDR' || size !== 13) return false;
            const width = view.getUint32(offset + 8), height = view.getUint32(offset + 12);
            if (!width || !height || width > MAX_FAVORITE_ICON_DIMENSION || height > MAX_FAVORITE_ICON_DIMENSION) return false;
            const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
            if (!depths[bytes[offset + 17]]?.includes(bytes[offset + 16]) || bytes[offset + 18] !== 0
                || bytes[offset + 19] !== 0 || bytes[offset + 20] > 1) return false;
        } else if (type === 'IHDR') return false;
        if (type === 'IDAT') hasData = true;
        if (type === 'IEND') return size === 0 && hasData && end === bytes.length;
        offset = end;
    }
    return false;
}

export function favoriteIconCacheSize(entries) {
    return new TextEncoder().encode(JSON.stringify({ version: 1, entries })).byteLength;
}

export function favoriteIconCacheUrl(pageUrl, api = globalThis.chrome) {
    if (!isFavoriteUrl(pageUrl)) return null;
    const url = new URL(api.runtime.getURL('_favicon/'));
    if (url.protocol !== 'chrome-extension:' || url.hostname !== api.runtime.id || url.pathname !== '/_favicon/') return null;
    url.searchParams.set('pageUrl', pageUrl);
    url.searchParams.set('size', '32');
    url.searchParams.set('fallbackToHost', '0');
    url.searchParams.set('allowGoogleServerFallback', '0');
    return url.href;
}

async function readCachePng(url, fetchIcon, signal) {
    let reader;
    try {
        const response = await fetchIcon(url, { signal, redirect: 'error', credentials: 'omit', cache: 'no-store' });
        if (!response.ok || response.redirected || response.url && response.url !== url) return null;
        // Chromium labels raw cached PNG bytes image/bmp and may omit the header.
        // The exact extension-local route and PNG bytes, not the label, are checked.
        const length = Number(response.headers.get('content-length'));
        if (!Number.isFinite(length) || length < 0 || length > MAX_FAVORITE_ICON_BYTES) return null;
        reader = response.body?.getReader();
        if (!reader) return null;
        const parts = []; let total = 0;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!(value instanceof Uint8Array) || (total += value.length) > MAX_FAVORITE_ICON_BYTES) return null;
            parts.push(value);
        }
        const bytes = new Uint8Array(total); let offset = 0;
        for (const part of parts) { bytes.set(part, offset); offset += part.length; }
        if (!isSmallPng(bytes)) return null;
        return PREFIX + btoa(String.fromCharCode(...bytes));
    } finally { await reader?.cancel().catch(() => {}); }
}

export async function captureFavoriteIcon(pageUrl, { dataUrl, api = globalThis.chrome, fetchIcon = globalThis.fetch, timeout = 3000 } = {}) {
    if (!isFavoriteUrl(pageUrl)) return null;
    if (isFavoriteIcon(dataUrl)) return dataUrl;
    const url = favoriteIconCacheUrl(pageUrl, api);
    if (!url || typeof fetchIcon !== 'function') return null;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeout);
    try {
        // The extension-local endpoint can return a generic PNG for cache misses.
        // Obtain that default using a unique, nonexistent reserved .invalid page
        // key at the same size. This is ONLY a local cache lookup: no navigation,
        // DNS, favicon-server lookup or remote tab.favIconUrl fetch is performed.
        const missing = favoriteIconCacheUrl(`https://${crypto.randomUUID()}.arcify-favicon-cache-miss.invalid/`, api);
        const before = await readCachePng(missing, fetchIcon, controller.signal);
        if (!before) return null; // Ambiguous browser behavior: keep existing bytes.
        const icon = await readCachePng(url, fetchIcon, controller.signal);
        if (!icon || icon === before) return null;
        const after = await readCachePng(missing, fetchIcon, controller.signal);
        // A theme/default change during capture is ambiguous; never freeze it as
        // the website's icon. A later favicon event/read can retry best effort.
        return after === before && icon !== after ? icon : null;
    } catch { return null; }
    finally { clearTimeout(timer); }
}
