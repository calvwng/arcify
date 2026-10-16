import { PEER_KEY, isExtensionId, isWindowId, sendBridgeRequest } from './spotlight-bridge-protocol.js';

const COALESCE_MS = 100;
const REQUEST_TIMEOUT_MS = 1000;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// Compare only snapshot-visible fields; lastTab and restore bookkeeping are quiet.
// These projections are local to an event. Only dirty window/tab IDs are queued.
const project = spaces => (spaces || []).map(space => ({
    id: space.id, name: space.name, color: space.color, bookmarkFolderId: space.bookmarkFolderId,
    spaceBookmarks: [...(space.spaceBookmarks || [])], temporaryTabs: [...(space.temporaryTabs || [])]
}));
const inWindow = (spaces, ids) => spaces.map(space => ({ ...space,
    spaceBookmarks: space.spaceBookmarks.filter(id => ids.has(id)),
    temporaryTabs: space.temporaryTabs.filter(id => ids.has(id))
}));
const metadata = spaces => spaces.map(({ spaceBookmarks, temporaryTabs, ...space }) => space);

// Best-effort optional v1 command. Old/unavailable peers may reject it; never retry
// a failed delivery or let it block SpaceStore writes. Opening Spotlight always
// reads an authoritative snapshot, independently of this notification.
export function registerSpotlightInvalidation(store) {
    let pending = empty(), queued = new Set(), timer = null, running = false, stopped = false, generation = 0;
    function empty() { return { all: false, windows: new Set(), tabs: new Set() }; }
    const hasPending = () => pending.all || pending.windows.size || pending.tabs.size;
    const schedule = () => {
        if (!stopped && !running && timer === null && (hasPending() || queued.size)) {
            // Fixed coalescing window: a continuous burst cannot postpone delivery.
            // Only one request is in flight, with at most ten sends per second.
            timer = setTimeout(flush, COALESCE_MS);
        }
    };
    const invalidateAll = () => { pending.all = true; schedule(); };
    const clear = () => {
        pending = empty(); queued.clear();
        if (timer !== null) clearTimeout(timer);
        timer = null;
    };
    async function flush() {
        timer = null;
        if (stopped) return;
        running = true;
        const currentGeneration = generation;
        const batch = pending;
        pending = empty();
        try {
            const settings = await chrome.storage.local.get(PEER_KEY);
            const peerId = settings[PEER_KEY];
            if (!isExtensionId(peerId)) { queued.clear(); return; }
            const windows = (await chrome.windows.getAll({ windowTypes: ['normal'], populate: true }))
                .filter(window => isWindowId(window.id) && window.type === 'normal' && !window.incognito);
            if (stopped || currentGeneration !== generation) return;
            const live = new Set(windows.map(window => window.id));
            for (const windowId of queued) if (!live.has(windowId)) queued.delete(windowId);
            for (const window of windows) {
                const ids = new Set((window.tabs || []).map(tab => tab.id));
                if (batch.all || batch.windows.has(window.id) || [...batch.tabs].some(id => ids.has(id))) {
                    queued.add(window.id);
                }
            }
            if (!queued.size) return;
            // Re-read after the asynchronous window lookup, immediately before send.
            // A revoked/replaced pairing invalidates all queued work for the old peer.
            const current = await chrome.storage.local.get(PEER_KEY);
            if (stopped || currentGeneration !== generation) return;
            if (current[PEER_KEY] !== peerId) { queued.clear(); return; }
            const windowId = queued.values().next().value;
            queued.delete(windowId);
            await sendBridgeRequest(peerId, 'invalidate', { windowId }, { timeout: REQUEST_TIMEOUT_MS });
        } catch (error) {
            // An absent, old, or unresponsive companion is normal. Drop this burst;
            // genuinely new changes received in flight may make a later attempt.
            // A just-closed window does not prevent notifying the remaining windows.
            if (currentGeneration === generation && error.code !== 'INVALID_WINDOW') queued.clear();
        } finally {
            running = false;
            schedule();
        }
    }
    const onChanged = (changes, area) => {
        if (area === 'local' && changes[PEER_KEY]) {
            generation++;
            clear();
            if (isExtensionId(changes[PEER_KEY].newValue)) invalidateAll();
        }
        if (area === 'local' && changes.persistentFavorites || area === 'session' && changes.favoriteSession) invalidateAll();
        if (area === 'local' && changes.spaces) {
            const before = project(changes.spaces.oldValue), after = project(changes.spaces.newValue);
            if (!same(metadata(before), metadata(after))) pending.all = true;
            else if (!same(before, after)) {
                // SpaceStore.persist refreshes its live-tab map before writing spaces.
                // Use that authoritative map rather than keeping another model/cache.
                const changedIds = new Set();
                for (let i = 0; i < before.length; i++) {
                    for (const section of ['spaceBookmarks', 'temporaryTabs']) {
                        if (!same(before[i][section], after[i][section])) {
                            for (const id of [...before[i][section], ...after[i][section]]) changedIds.add(id);
                        }
                    }
                }
                if (!store.liveTabs || [...changedIds].some(id => !isWindowId(store.liveTabs.get(id)?.windowId))) {
                    // Initialization/closing races must not silently drop a change.
                    pending.all = true;
                    schedule();
                    return;
                }
                const windows = new Map();
                for (const tab of store.liveTabs.values()) {
                    if (!windows.has(tab.windowId)) windows.set(tab.windowId, new Set());
                    windows.get(tab.windowId).add(tab.id);
                }
                for (const [id, tabs] of windows) {
                    if (!same(inWindow(before, tabs), inWindow(after, tabs))) pending.windows.add(id);
                }
            }
        }
        if (area === 'session' && changes.activeSpaces) {
            const before = changes.activeSpaces.oldValue || {}, after = changes.activeSpaces.newValue || {};
            for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
                const id = Number(key);
                if (!isWindowId(id) || before[key] === after[key]) continue;
                // Even A -> B -> A must notify: a query may have read B meanwhile.
                pending.windows.add(id);
            }
        }
        if (area === 'local' && changes.pinnedTabStatesById) {
            const before = changes.pinnedTabStatesById.oldValue || {}, after = changes.pinnedTabStatesById.newValue || {};
            for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
                // Both bookmark identity and the pinned URL affect displayed titles.
                if ((String(before[key]?.bookmarkId) !== String(after[key]?.bookmarkId)
                    || before[key]?.pinnedUrl !== after[key]?.pinnedUrl) && isWindowId(Number(key))) pending.tabs.add(Number(key));
            }
        }
        if (area === 'local' && changes.tabNameOverridesById) {
            const before = changes.tabNameOverridesById.oldValue || {}, after = changes.tabNameOverridesById.newValue || {};
            for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
                // originalDomain is bookkeeping; ordinary aliases follow the tab ID
                // across navigation. Resolve its current window when the batch flushes.
                const name = value => typeof value?.name === 'string' ? value.name : '';
                if (name(before[key]) !== name(after[key]) && isWindowId(Number(key))) pending.tabs.add(Number(key));
            }
        }
        schedule();
    };
    const onSplitUpdated = (tabId, change, tab) => {
        if (change.splitViewId === undefined) return;
        if (isWindowId(tab?.windowId)) pending.windows.add(tab.windowId);
        else if (isWindowId(tabId)) pending.tabs.add(tabId);
        schedule();
    };
    chrome.tabs?.onUpdated?.addListener(onSplitUpdated);
    chrome.storage.onChanged.addListener(onChanged);
    // One-shot recovery after worker suspension/restart; no polling or durable queue.
    invalidateAll();
    return { invalidateAll, dispose() {
        stopped = true; generation++; clear();
        chrome.storage.onChanged.removeListener(onChanged);
        chrome.tabs?.onUpdated?.removeListener(onSplitUpdated);
    } };
}
