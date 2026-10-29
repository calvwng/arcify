import { bridgeError } from './spotlight-bridge-protocol.js';

export function captureHelperSource(request, api = chrome) {
    if (!request.helperSource) return null;
    const id = request.helperSource.tabId, removers = [];
    let changed = false;
    const dispose = () => removers.splice(0).forEach(remove => remove());
    const listen = (event, callback) => {
        if (!event?.addListener || !event?.removeListener) throw bridgeError('STALE_HELPER_SOURCE', 'Cannot verify the helper source.');
        event.addListener(callback); removers.push(() => event.removeListener(callback));
    };
    try {
        listen(api.tabs.onUpdated, (tabId, change) => { if (tabId === id && (change.status === 'loading' || ['url', 'pendingUrl'].some(key => Object.hasOwn(change, key)))) changed = true; });
        listen(api.tabs.onDetached, tabId => { if (tabId === id) changed = true; });
        listen(api.tabs.onRemoved, tabId => { if (tabId === id) changed = true; });
        listen(api.tabs.onReplaced, (added, removed) => { if ([added, removed].includes(id)) changed = true; });
    } catch (error) { dispose(); throw error; }
    const assert = () => { if (changed) throw bridgeError('STALE_HELPER_SOURCE', 'The Spotlight helper moved or changed. Reopen Spotlight.'); };
    return { assert, dispose, async check(peerId) { assert(); await checkHelperSource(request, peerId, api); assert(); } };
}

// The paired worker owns the original document/event fence. A plain tabs.get
// cannot detect navigation away and back to the same helper URL.
export async function checkHelperSource(request, peerId, api = chrome) {
    const source = request.helperSource;
    if (!source) return;
    const stale = () => bridgeError('STALE_HELPER_SOURCE', 'The Spotlight helper moved or changed. Reopen Spotlight.');
    if (source.url.split(/[?#]/)[0] !== `chrome-extension://${peerId}/newtab.html`) throw stale();
    const live = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(stale()), 5000);
        try {
            api.runtime.sendMessage(peerId, { type: 'arcify-helper-source', ...source, windowId: request.windowId }, response => {
                clearTimeout(timeout);
                resolve(!api.runtime.lastError && response?.live === true && Object.keys(response).length === 1);
            });
        } catch { clearTimeout(timeout); reject(stale()); }
    });
    if (!live) throw stale();
    let tab;
    try { tab = await api.tabs.get(source.tabId); } catch { throw stale(); }
    if (tab?.id !== source.tabId || tab.windowId !== request.windowId || tab.url !== source.url || tab.pendingUrl || tab.status === 'loading') throw stale();
    // Chrome has no atomic conditional create/update. This check is the final
    // source read before the caller's mutation, not an atomic browser guarantee.
}
