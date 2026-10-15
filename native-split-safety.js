// Native Split View is browser-owned. Never infer a pair from URLs or retain its
// identity in extension storage; consult the current Chrome Tab instead.
export const NATIVE_SPLIT_MOVE_ERROR = 'End Split View before moving or pinning this tab.';
export const hasNativeSplit = tab => Number.isInteger(tab?.splitViewId) && tab.splitViewId >= 0;
export function assertNotNativeSplit(tab) {
    if (hasNativeSplit(tab)) throw Object.assign(new Error(NATIVE_SPLIT_MOVE_ERROR), { code: 'NATIVE_SPLIT_ACTIVE' });
}
export const isNativeSplitTab = hasNativeSplit;
export const assertTabNotSplit = assertNotNativeSplit;

const sections = ['spaceBookmarks', 'temporaryTabs'];
const locations = (spaces, id) => spaces.flatMap(space => sections.flatMap(section =>
    (space[section] || []).flatMap((tabId, index) => tabId === id ? [{ space, section, index }] : [])));

// A stale panel may submit a full membership patch. Validate the merged result,
// not the panel's old snapshot, before changing canonical ownership or ranks.
export function assertNativeSplitMembershipPreserved(before, after, tabs) {
    const splitTabs = tabs.filter(hasNativeSplit);
    for (const tab of splitTabs) {
        const previous = locations(before, tab.id), next = locations(after, tab.id);
        if (!previous.length && !next.length) continue;
        if (previous.length !== 1 || next.length !== 1 || previous[0].space.id !== next[0].space.id ||
            previous[0].section !== next[0].section) assertNotNativeSplit(tab);
        const oldIds = previous[0].space[previous[0].section], newIds = next[0].space[next[0].section];
        const peers = splitTabs.filter(peer => peer.windowId === tab.windowId && peer.splitViewId === tab.splitViewId);
        const peer = peers.length === 2 && peers.find(peer => peer.id !== tab.id);
        const oldPeerIndex = peer ? oldIds.indexOf(peer.id) : -1;
        if (oldPeerIndex >= 0 && Math.abs(oldPeerIndex - previous[0].index) === 1) {
            // Preserve an intact ordered pair as a unit. An unrelated tab may
            // cross the whole pair; a full-array patch cannot distinguish that
            // from moving the pair. Neither operation separates its members.
            if (newIds.indexOf(peer.id) - next[0].index !== oldPeerIndex - previous[0].index) assertNotNativeSplit(tab);
            continue;
        }
        // Removing an unrelated tab is fine. Moving a surviving tab across a
        // lone or already interleaved member has no safe pair-unit interpretation.
        for (const id of oldIds) {
            if (id === tab.id || !newIds.includes(id)) continue;
            if ((oldIds.indexOf(id) < previous[0].index) !== (newIds.indexOf(id) < next[0].index)) assertNotNativeSplit(tab);
        }
        // Newly inserted IDs cannot slip between native peers. Existing
        // interleaving is left alone rather than trying to repair browser state.
        for (const peer of splitTabs) {
            if (peer.id === tab.id || peer.windowId !== tab.windowId || peer.splitViewId !== tab.splitViewId) continue;
            const oldPeer = oldIds.indexOf(peer.id), newPeer = newIds.indexOf(peer.id);
            if (oldPeer < 0 || newPeer < 0) continue;
            const oldBetween = new Set(oldIds.slice(Math.min(previous[0].index, oldPeer) + 1, Math.max(previous[0].index, oldPeer)));
            const newBetween = newIds.slice(Math.min(next[0].index, newPeer) + 1, Math.max(next[0].index, newPeer));
            if (newBetween.some(id => !oldBetween.has(id))) assertNotNativeSplit(tab);
        }
    }
}

// Message data describes an exact source; it never supplies executable hooks.
// The background creates this guard and the bookmark writer invokes it only
// after its queued reads, immediately before each external write.
export function createNativeSplitWriteGuard(value) {
    if (value === undefined) return undefined;
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).some(key => !['tabId', 'windowId'].includes(key)) ||
        !Number.isSafeInteger(value.tabId) || value.tabId <= 0 ||
        !Number.isSafeInteger(value.windowId) || value.windowId <= 0) throw new Error('Invalid live bookmark source.');
    const { tabId, windowId } = value;
    return async () => {
        const tab = await chrome.tabs.get(tabId);
        if (!tab || tab.id !== tabId || tab.windowId !== windowId || tab.incognito) throw new Error('The live bookmark source changed. Refresh and try again.');
        assertNotNativeSplit(tab);
    };
}
