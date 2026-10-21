// Transient tabs are excluded independently of native pin/Favorite ownership.
// Consult exact IDs as well as window membership: a dragged-out Little Arc tab
// remains quarantined for its browser lifetime. Optional predicates preserve
// compatibility with standalone stores and older callers.
export const isTransientWindow = (store, windowId) => Boolean(store?.isTransientWindow?.(windowId));
export function isTransientTab(store, tabOrId) {
    return Boolean(store?.isTransientTab?.(tabOrId)
        || tabOrId && typeof tabOrId === 'object'
            && (store?.isTransientTab?.(tabOrId.id) || isTransientWindow(store, tabOrId.windowId)));
}
export function assertNotTransient(store, { windowId, tabId, tab } = {}) {
    if (tab) store?.observeTab?.(tab);
    if (isTransientWindow(store, windowId) || isTransientTab(store, tabId) || isTransientTab(store, tab)) {
        throw Object.assign(new Error('Little Arc tabs cannot be saved, moved, or managed by Spaces or Favorites.'), { code: 'TRANSIENT_CONTEXT' });
    }
}
