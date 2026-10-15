import { isStartupLauncherTab } from './startup-launcher-tab.js';

export function selectWindowSpaceTabs(space, tabs, windowId, globalTabIds = new Set()) {
    const byId = new Map(tabs.filter(t => t.windowId === windowId && !t.pinned && !globalTabIds.has(t.id) && !isStartupLauncherTab(t)).map(t => [t.id, t]));
    return [...(space?.spaceBookmarks || []), ...(space?.temporaryTabs || [])]
        .map(id => byId.get(id)).filter(Boolean);
}

// Bookmark traversal validates bindings; it does not define saved tab order.
// Keep other windows' slots and verified current-window pins in place, then
// append bindings that were not present in this panel's initial snapshot.
export function reconcileWindowPinOrder(previousPins, boundIds, windowTabIds) {
    const bound = new Set(boundIds);
    return [...new Set([
        ...previousPins.filter(id => !windowTabIds.has(id) || bound.has(id)),
        ...boundIds
    ])];
}

// Reorder visible members without disturbing another window's positions.
export function mergeVisibleOrder(allIds, visibleIds) {
    const visible = new Set(visibleIds);
    let index = 0;
    const result = allIds.map(id => visible.has(id) ? visibleIds[index++] : id);
    return [...result, ...visibleIds.slice(index)];
}

export function canonicalOrderFromDisplay(displayIds, inverted) {
    return inverted ? [...displayIds].reverse() : [...displayIds];
}

export function mergeCapturedTemporaryOrder(allIds, displayIds, inverted) {
    return mergeVisibleOrder(allIds, canonicalOrderFromDisplay(displayIds, inverted));
}

export async function saveBookmarkOperation(operation, { guardTab } = {}) {
    const response = await chrome.runtime.sendMessage({ type: 'bookmarkOrder', operation, ...(guardTab ? { guardTab } : {}) });
    if (!response?.success) {
        const error = new Error(response?.error || 'Bookmark order could not be saved.');
        error.code = response?.code;
        error.observedOrders = response?.observedOrders;
        error.moved = response?.moved;
        error.createdId = response?.createdId;
        throw error;
    }
    return response;
}

export async function saveBookmarkOrder(parentId, expectedCanonicalIds, desiredCanonicalIds) {
    return saveBookmarkOperation({ parents: [{ parentId, expectedCanonicalIds, desiredCanonicalIds }] });
}
