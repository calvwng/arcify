import { assertNotTransient, isTransientTab } from './transient-safety.js';
import { getSpaceBookmarkFolder } from './space-bookmarks.js';
import { isStartupLauncherTab } from './startup-launcher-tab.js';
import { assertNotNativeSplit, assertNativeSplitMembershipPreserved } from './native-split-safety.js';
import { Utils } from './utils.js';
import { readSpaceRankCheckpoint } from './space-continuity.js';

const MAX_TABS = 100;
const positive = value => Number.isSafeInteger(value) && value > 0;
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const sameIds = (a, b) => a.length === b.length && a.every((id, index) => id === b[index]);
const changed = () => new Error('The selected Today tabs, their order, or a Space changed. Select the tabs again.');
const supportedUrl = value => {
    if (typeof value !== 'string' || !value || value.length > 16384) return false;
    try { return ['http:', 'https:', 'file:', 'ftp:', 'chrome:', 'about:'].includes(new URL(value).protocol); }
    catch { return false; }
};
const locations = (spaces, id) => spaces.flatMap(space => ['temporaryTabs', 'spaceBookmarks'].flatMap(section =>
    (space[section] || []).filter(tabId => tabId === id).map(() => ({ spaceId: space.id, section }))));
const ownsToday = (spaces, spaceId, id) => {
    const owners = locations(spaces, id);
    return owners.length === 1 && owners[0].spaceId === spaceId && owners[0].section === 'temporaryTabs';
};

// This is one canonical membership write, not a series of tab moves. The existing
// SpaceStore queue, persistence, continuity stamp and change notifications remain
// authoritative. No URL matching, native tab activation, or bookmark writes occur.
export function moveTodayTabsToSpace(store, request) {
    return store.run(() => moveTodayTabsToSpaceCore(store, request));
}

// Internal only: callers already holding SpaceStore.run() may compose this core.
// The queued public wrapper remains the sidebar/menu entry point.
export async function moveTodayTabsToSpaceCore(store, request, { beforeMutation = async () => {}, skipGroupSync = false, getOrder = () => Utils.getTodayOrderInverted() } = {}) {
        if (!request || typeof request !== 'object' || Array.isArray(request) ||
            Object.keys(request).some(key => !['type', 'windowId', 'spaceId', 'bookmarkFolderId', 'destinationSpaceId', 'destinationBookmarkFolderId', 'inverted', 'entries'].includes(key)) ||
            request.type !== undefined && request.type !== 'moveTodayTabsToSpace' ||
            !positive(request.windowId) || !identifier(request.spaceId) || !identifier(request.bookmarkFolderId) ||
            !identifier(request.destinationSpaceId) || !identifier(request.destinationBookmarkFolderId) ||
            request.spaceId === request.destinationSpaceId || request.bookmarkFolderId === request.destinationBookmarkFolderId ||
            typeof request.inverted !== 'boolean' || !Array.isArray(request.entries) || !request.entries.length || request.entries.length > MAX_TABS ||
            request.entries.some(entry => !entry || typeof entry !== 'object' || Array.isArray(entry) ||
                Object.keys(entry).some(key => !['tabId', 'url'].includes(key)) || !positive(entry.tabId) || !supportedUrl(entry.url)) ||
            new Set(request.entries.map(entry => entry.tabId)).size !== request.entries.length) {
            throw new Error('Choose 1–100 ordinary Today tabs and another existing Space. Nothing was moved.');
        }
        const { windowId, spaceId, bookmarkFolderId, destinationSpaceId, destinationBookmarkFolderId, inverted, entries } = request;
        assertNotTransient(store, { windowId });
        for (const entry of entries) assertNotTransient(store, { tabId: entry.tabId });
        const ids = entries.map(entry => entry.tabId), selected = new Set(ids);
        const batch = { total: ids.length, completed: [], remaining: [...ids], uncertain: false, destinationSpaceId };
        let staged = false, writeAttempted = false, beforeSpaces, beforeRanks, beforeQueue, expectedRanks, expectedSourceIds, expectedTargetIds;
        const getSpaces = () => {
            assertNotTransient(store, { windowId });
            for (const entry of entries) assertNotTransient(store, { tabId: entry.tabId });
            const source = store.spaces.filter(space => space.id === spaceId);
            const target = store.spaces.filter(space => space.id === destinationSpaceId);
            if (source.length !== 1 || target.length !== 1 || source[0].bookmarkFolderId !== bookmarkFolderId ||
                target[0].bookmarkFolderId !== destinationBookmarkFolderId || store.active[windowId] !== spaceId ||
                store.spaces.some(space => space.id !== spaceId && space.bookmarkFolderId === bookmarkFolderId ||
                    space.id !== destinationSpaceId && space.bookmarkFolderId === destinationBookmarkFolderId)) throw changed();
            if (staged && (!sameIds(source[0].temporaryTabs, expectedSourceIds) ||
                !sameIds(target[0].temporaryTabs, expectedTargetIds))) throw changed();
            return { source: source[0], target: target[0] };
        };
        const validLive = (tab, entry, bindings) => tab?.id === entry.tabId && tab.windowId === windowId && !tab.incognito && !tab.pinned &&
            !isStartupLauncherTab(tab) && !isTransientTab(store, tab) && !store.isGlobalTab?.(tab.id) && !store.isGlobalTab?.(tab) &&
            !bindings[tab.id]?.bookmarkId && !store.provisional?.has(tab.id) && !store.recoveryCandidates?.has(tab.id) &&
            tab.url === entry.url && (!tab.pendingUrl || tab.pendingUrl === entry.url);
        async function validate(owner = spaceId) {
            const { source } = getSpaces();
            const window = await chrome.windows.get(windowId);
            if (window?.id !== windowId || window.type !== 'normal' || window.incognito) throw changed();
            await getSpaceBookmarkFolder(source);
            await getSpaceBookmarkFolder(getSpaces().target);
            if (Boolean(await getOrder()) !== inverted) throw changed();
            const bindings = await Utils.getPinnedTabStates();
            // One fresh native snapshot validates the complete batch. In particular,
            // a duplicate-URL neighbor can never replace a closed or moved tab ID.
            const tabs = await chrome.tabs.query({});
            getSpaces();
            for (const entry of entries) {
                const matches = tabs.filter(tab => tab.id === entry.tabId), tab = matches[0];
                assertNotTransient(store, { windowId, tab });
                assertNotNativeSplit(tab);
                if (matches.length === 1 && tab?.id === entry.tabId && tab.windowId === windowId &&
                    ownsToday(store.spaces, owner, entry.tabId) && store.recoveryCandidates?.has(entry.tabId)) throw Object.assign(new Error(
                    'Some selected tabs are still being matched to their saved Spaces. Choose fully restored Today tabs and try again.'
                ), { code: 'TODAY_RECOVERY_PENDING' });
                if (matches.length !== 1 || !validLive(tab, entry, bindings) || !ownsToday(store.spaces, owner, entry.tabId)) throw changed();
            }
            const current = getSpaces();
            const ordered = current[owner === spaceId ? 'source' : 'target'].temporaryTabs.filter(id => selected.has(id));
            if (!sameIds(inverted ? [...ordered].reverse() : ordered, ids)) throw changed();
            await beforeMutation({ membershipStaged: staged, writeAttempted });
            getSpaces();
            for (const tab of tabs.filter(tab => selected.has(tab.id))) assertNotTransient(store, { windowId, tab });
            return tabs;
        }
        try {
            const tabs = await validate();
            beforeSpaces = structuredClone(store.spaces); beforeRanks = new Map(store.restoredRanks);
            beforeQueue = structuredClone(store.restoreQueue);
            const next = structuredClone(store.spaces);
            const source = next.find(space => space.id === spaceId), target = next.find(space => space.id === destinationSpaceId);
            source.temporaryTabs = source.temporaryTabs.filter(id => !selected.has(id));
            // Append at the visible bottom. Existing destination members, including
            // other windows' IDs, keep their exact relative canonical order.
            target.temporaryTabs = inverted ? [...ids].reverse().concat(target.temporaryTabs) : target.temporaryTabs.concat(ids);
            if (selected.has(source.lastTab)) delete source.lastTab;
            assertNativeSplitMembershipPreserved(store.spaces, next, tabs);
            expectedSourceIds = [...source.temporaryTabs]; expectedTargetIds = [...target.temporaryTabs];
            store.spaces = next; staged = true;
            for (const space of [source, target]) store.rebaseSectionRanks(space, 'temporaryTabs',
                beforeSpaces.find(previous => previous.id === space.id).temporaryTabs);
            expectedRanks = new Map(store.restoredRanks);
            await store.persist({ skipGroupSync, beforeWrite: async () => {
                // persist awaits metadata and continuity before writing. Recheck at
                // that final boundary, not only before staging the in-memory move.
                const fresh = await validate(destinationSpaceId);
                assertNativeSplitMembershipPreserved(beforeSpaces, store.spaces, fresh);
                writeAttempted = true;
            } });
            await validate(destinationSpaceId);
            batch.completed = [...ids]; batch.remaining = [];
            return batch;
        } catch (error) {
            if (staged && !writeAttempted) {
                store.spaces = beforeSpaces; store.restoredRanks = beforeRanks; store.restoreQueue = beforeQueue;
                // persist can update its snapshot caches before its guarded write.
                // Reload from authoritative storage on the next queued operation.
                store.initialized = false;
            } else if (writeAttempted) {
                // A rejected storage promise can follow a completed write. Never
                // retry or overwrite it as rollback. Read the actual persisted
                // membership and classify only exact live survivors as completed.
                store.initialized = false;
                try {
                    const { spaces, spaceTabSnapshot, spaceRankCheckpoint } = await chrome.storage.local.get(['spaces', 'spaceTabSnapshot', 'spaceRankCheckpoint']);
                    if (!Array.isArray(spaces)) throw changed();
                    store.spaces = structuredClone(spaces);
                    const sources = spaces.filter(space => space.id === spaceId), targets = spaces.filter(space => space.id === destinationSpaceId);
                    if (sources.length !== 1 || targets.length !== 1) throw changed();
                    const [persistedSource] = sources, [persistedTarget] = targets;
                    const selection = await chrome.storage.session.get(['activeSpaces', 'spaceSession']);
                    const checkpoint = selection.spaceSession && await readSpaceRankCheckpoint(spaceRankCheckpoint, spaceTabSnapshot);
                    const ranks = checkpoint ? new Map(checkpoint) : null;
                    // Proven membership can coexist with an incomplete selection
                    // checkpoint. Report that uncertainty instead of declaring the
                    // whole operation complete or silently retrying persistence.
                    if (selection.activeSpaces?.[windowId] !== spaceId) batch.uncertain = true;
                    if (persistedSource.bookmarkFolderId !== bookmarkFolderId || persistedTarget.bookmarkFolderId !== destinationBookmarkFolderId ||
                        spaces.some(space => space.id !== spaceId && space.bookmarkFolderId === bookmarkFolderId ||
                            space.id !== destinationSpaceId && space.bookmarkFolderId === destinationBookmarkFolderId)) throw changed();
                    await getSpaceBookmarkFolder(persistedSource); await getSpaceBookmarkFolder(persistedTarget);
                    const atTarget = ids.some(id => ownsToday(spaces, destinationSpaceId, id));
                    if (atTarget && (!sameIds(persistedSource.temporaryTabs, expectedSourceIds) ||
                        !sameIds(persistedTarget.temporaryTabs, expectedTargetIds))) batch.uncertain = true;
                    const window = await chrome.windows.get(windowId);
                    if (window?.id !== windowId || window.type !== 'normal' || window.incognito) throw changed();
                    if (Boolean(await getOrder()) !== inverted) batch.uncertain = true;
                    const bindings = await Utils.getPinnedTabStates(), tabs = await chrome.tabs.query({});
                    for (const entry of entries) {
                        const matches = tabs.filter(tab => tab.id === entry.tabId), tab = matches[0];
                        const atDestination = ownsToday(spaces, destinationSpaceId, entry.tabId);
                        const atSource = ownsToday(spaces, spaceId, entry.tabId);
                        const records = (spaceTabSnapshot || []).filter(record => record.tabId === entry.tabId);
                        const record = records[0], canonicalIndex = persistedTarget.temporaryTabs.indexOf(entry.tabId);
                        const snapshotProven = records.length === 1 && record.spaceId === destinationSpaceId &&
                            record.section === 'temporaryTabs' && record.url === entry.url && record.order === (expectedRanks.get(entry.tabId) ?? canonicalIndex) &&
                            record.windowKey === store.windowKeys.get(windowId);
                        if (atDestination && snapshotProven && matches.length === 1 && validLive(tab, entry, bindings) &&
                            !(Number.isInteger(tab.splitViewId) && tab.splitViewId >= 0)) {
                            batch.completed.push(entry.tabId);
                            if (!ranks || ranks.get(entry.tabId) !== expectedRanks.get(entry.tabId)) batch.uncertain = true;
                        }
                        else if (!atSource) batch.uncertain = true;
                    }
                    batch.remaining = ids.filter(id => !batch.completed.includes(id));
                } catch { batch.uncertain = true; }
            }
            batch.remaining = ids.filter(id => !batch.completed.includes(id));
            error.batch = batch;
            throw error;
        }
}

export function registerTodayMoveMessages(store) {
    chrome.runtime.onMessage.addListener((message, sender, respond) => {
        if (message?.type !== 'moveTodayTabsToSpace') return;
        const ownUrl = chrome.runtime.getURL('');
        if (sender?.id !== chrome.runtime.id || sender.url && !sender.url.startsWith(ownUrl) ||
            sender.origin && sender.origin !== ownUrl.replace(/\/$/, '') || sender.tab && sender.tab.windowId !== message.windowId) {
            respond({ success: false, error: 'Invalid Today move sender.' }); return;
        }
        moveTodayTabsToSpace(store, message).then(
            batch => respond({ success: true, batch }),
            error => respond({ success: false, error: error.message,
                ...(error.code === 'TODAY_RECOVERY_PENDING' ? { code: error.code } : {}),
                ...(error.batch ? { batch: error.batch } : {}) })
        );
        return true;
    });
}
