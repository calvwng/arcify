import { PEER_KEY, isExtensionId, isWindowId } from './spotlight-bridge-protocol.js';

export const SIDEBAR_COMMAND_TYPE = 'arcify-sidebar';
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const pagePath = value => typeof value === 'string' ? value.split(/[?#]/)[0] : '';

// A new-tab override can retain Chrome's displayed URL in tabs.Tab. The sender's
// own extension URL is checked separately before accepting that browser alias.
export function isSpotlightNewTabUrl(value, peerId, allowAlias = true) {
    const path = pagePath(value);
    return isExtensionId(peerId) && (path === `chrome-extension://${peerId}/newtab.html`
        || (allowAlias && ['chrome://newtab/', 'chrome://newtab'].includes(path)));
}

export function validateSidebarSender(sender, peerId) {
    const tab = sender?.tab;
    if (!isExtensionId(peerId) || sender?.id !== peerId) {
        fail('UNAUTHORIZED', 'Spotlight is not paired with Arcify. Check both connection settings.');
    }
    if (sender.frameId !== 0
        || !isWindowId(tab?.id) || !isWindowId(tab?.windowId) || tab.incognito || tab.active !== true
        || (sender.documentLifecycle && sender.documentLifecycle !== 'active')) {
        fail('UNAUTHORIZED', 'Open Spotlight in the active tab of a normal browsing window.');
    }
    if (isSpotlightNewTabUrl(sender.url, peerId, false)) {
        if (sender.origin !== `chrome-extension://${peerId}` || !isSpotlightNewTabUrl(tab.url, peerId)
            || (tab.pendingUrl && !isSpotlightNewTabUrl(tab.pendingUrl, peerId))) {
            fail('UNAUTHORIZED', 'This Spotlight page is no longer the active source tab.');
        }
        return tab.id;
    }
    // Dedicated sidebar-only permission for the paired top-frame content script.
    // This does not broaden trustedSender or expose any workspace bridge command.
    let source;
    try { source = new URL(sender.url); } catch { fail('UNAUTHORIZED', 'Unsupported Spotlight source.'); }
    if (!['http:', 'https:'].includes(source.protocol) || sender.origin !== source.origin
        || sender.url !== tab.url || (tab.pendingUrl && tab.pendingUrl !== tab.url)) {
        fail('UNAUTHORIZED', 'Use Spotlight in an ordinary webpage or its new-tab page.');
    }
    return tab.id;
}

export function createSidebarCommandHandler(browser = globalThis.chrome) {
    return (request, sender, sendResponse) => {
        if (request?.type !== SIDEBAR_COMMAND_TYPE) return;
        const response = payload => sendResponse({ type: SIDEBAR_COMMAND_TYPE, version: 1,
            requestId: request.requestId, role: 'arcify', ...payload });
        const reject = error => response({ ok: false, error: { code: error.code || 'OPEN_FAILED',
            message: error.message || 'The sidebar could not open. Try again or use the Arcify toolbar icon.' } });
        try {
            if (request.version !== 1) fail('VERSION_MISMATCH', 'Reload matching Arcify and Spotlight builds.');
            if (Array.isArray(request) || typeof request.requestId !== 'string' || !/^[\w.:-]{1,80}$/.test(request.requestId)
                || Object.keys(request).some(key => !['type', 'version', 'requestId'].includes(key))) {
                fail('INVALID_REQUEST', 'Invalid sidebar request.');
            }
            // Keep this callback-style and directly inside the message listener.
            // Chromium carries the original worker interaction through one API
            // callback. An await, queue, snapshot or second API before open would
            // lose that guarantee. The browser still enforces the real gesture.
            browser.storage.local.get(PEER_KEY, settings => {
                try {
                    if (browser.runtime.lastError) fail('STORAGE_FAILED', 'Could not verify the Arcify connection. Try again.');
                    const tabId = validateSidebarSender(sender, settings?.[PEER_KEY]);
                    if (typeof browser.sidePanel?.open !== 'function') fail('UNSUPPORTED', 'Use the Arcify toolbar icon in this browser.');
                    const opening = browser.sidePanel.open({ tabId });
                    Promise.resolve(opening).then(() => response({ ok: true }), reject);
                } catch (error) { reject(error); }
            });
        } catch (error) { reject(error); }
        return true;
    };
}
