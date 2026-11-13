// A marker is a safe local landing page, not a webpage or native-tab identity.
// Merely importing/copying/syncing its URL never authorizes opening a pair.
export function splitPinUrl(id, api = globalThis.chrome) {
    return `${api.runtime.getURL('saved-split.html')}#${encodeURIComponent(id)}`;
}
export function isSplitPinUrl(url) {
    try { const parsed = new URL(url); return parsed.origin === new URL(globalThis.chrome.runtime.getURL('')).origin && parsed.protocol === 'chrome-extension:' && parsed.host === new URL(globalThis.chrome.runtime.getURL('')).host && parsed.pathname === '/saved-split.html'; }
    catch { return false; }
}
