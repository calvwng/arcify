const globalActions = new Set(['list', 'add', 'replace', 'remove']);
const nativeId = value => Number.isSafeInteger(value) && value > 0;

export async function archiveRequest(action, payload = {}) {
    // Extension tabs must carry their own browser-attested window through the
    // sender guard, never the focused window. A native sidebar has no current
    // tab; background/legacy global callers have no document or window scope.
    // Lookup failures cancel the request instead of falling back to a window.
    if (globalActions.has(action) && typeof document !== 'undefined') {
        const tab = await chrome.tabs.getCurrent();
        if (tab !== undefined) {
            if (!tab || !nativeId(tab.id) || !nativeId(tab.windowId)) {
                throw Object.assign(new Error('The archive caller window is unavailable. Try again.'), { code: 'INVALID_REQUEST' });
            }
            // Preserve explicit metadata so the route can reject stale/mismatched
            // callers. Window-scoped view/archive/reopen are never rewritten.
            if (!Object.hasOwn(payload, 'windowId')) payload = { ...payload, windowId: tab.windowId };
        }
    }
    const response = await chrome.runtime.sendMessage({ type: 'archiveStore', action, ...payload });
    if (!response?.success) throw Object.assign(new Error(response?.error || 'Archive storage unavailable'), {
        code: response?.code, tabId: response?.tabId, entryId: response?.entryId, consumed: response?.consumed });
    return response.result;
}
