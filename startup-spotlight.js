import { BRIDGE_TYPE, BRIDGE_VERSION, PEER_KEY, isExtensionId } from './spotlight-bridge-protocol.js';
import { isSpotlightNewTabUrl } from './sidebar-command.js';

// Startup coordination is not gesture-sensitive. Only the final user action in
// Spotlight uses the dedicated sidebar endpoint.
export function sendStartupBridgeRequest(browser, peerId, command, payload, timeout = 1500) {
    const request = { type: BRIDGE_TYPE, version: BRIDGE_VERSION, requestId: crypto.randomUUID(), command, ...payload };
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Spotlight startup request timed out.')), timeout);
        const finish = (error, response) => {
            clearTimeout(timer);
            if (error) reject(error); else resolve(response);
        };
        try {
            browser.runtime.sendMessage(peerId, request, response => {
                if (browser.runtime.lastError) return finish(new Error('Spotlight is unavailable.'));
                if (response?.type !== BRIDGE_TYPE || response.version !== BRIDGE_VERSION
                    || response.requestId !== request.requestId || response.role !== 'spotlight' || response.ok !== true) {
                    return finish(new Error('Spotlight did not confirm the startup request.'));
                }
                finish(null, response);
            });
        } catch (error) { finish(error); }
    });
}

export async function prepareStartupSuggestion(browser, tab) {
    if (!browser.storage.local || !browser.runtime.sendMessage) return null;
    const { [PEER_KEY]: peerId } = await browser.storage.local.get(PEER_KEY);
    if (!isExtensionId(peerId) || !isSpotlightNewTabUrl(tab.url, peerId)
        || (tab.pendingUrl && !isSpotlightNewTabUrl(tab.pendingUrl, peerId))) return null;
    try {
        const hello = await sendStartupBridgeRequest(browser, peerId, 'hello', { windowId: tab.windowId });
        if (hello.extensionId !== peerId || !Array.isArray(hello.capabilities) || !hello.capabilities.includes('startupSuggestion')) return null;
        if ((await browser.storage.local.get(PEER_KEY))[PEER_KEY] !== peerId) return null;
        return { peerId, tabId: tab.id, windowId: tab.windowId };
    } catch { return null; } // No offer was sent, so the ordinary helper remains safe.
}

export async function offerStartupSuggestion(browser, context) {
    // Recheck at dispatch as well as after hello: a user may disconnect Arcify
    // while the controller is checking its startup tab or persisting the claim.
    if ((await browser.storage.local.get(PEER_KEY))[PEER_KEY] !== context.peerId) {
        throw new Error('Spotlight pairing changed before the startup offer.');
    }
    const response = await sendStartupBridgeRequest(browser, context.peerId, 'startupSuggestion',
        { windowId: context.windowId, tabId: context.tabId });
    if (typeof response.accepted !== 'boolean' || (!response.accepted
        && !['user-interaction', 'not-ready', 'not-eligible'].includes(response.reason))) {
        throw new Error('Spotlight returned an uncertain startup outcome.');
    }
    return response;
}
