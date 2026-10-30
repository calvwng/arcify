import { archiveRequest } from './archive-client.js';
import { isStartupLauncherTab, isStartupLauncherUrl } from './startup-launcher-tab.js';
import { getTodayOrderInverted } from './today-order.js';
import { isPracticeUrl } from './tour-practice.js';
import { getSpaceTabs, spaceRequest } from './space-client.js';
/**
 * Utils - Shared utility functions and storage management
 * 
 * Purpose: Provides common utilities and centralized settings/storage management across the extension
 * Key Functions: Settings CRUD, archived tabs management, space data operations, default configurations
 * Architecture: Static utility class with async storage operations
 * 
 * Critical Notes:
 * - Central source of truth for extension settings and defaults
 * - Handles both chrome.storage.sync (settings) and chrome.storage.local (spaces/tabs data)
 * - Used by both background script and UI components for consistent data access
 * - Settings changes automatically sync across extension contexts
 */

import { BookmarkUtils } from './bookmark-utils.js';
import { Logger } from './logger.js';


const Utils = {

    async focusTab(tabId) {
        const tab = await chrome.tabs.update(tabId, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
        return tab;
    },

    processBookmarkFolder: async function (folder, spaceId) {
        const bookmarks = [];
        const items = await chrome.bookmarks.getChildren(folder.id);
        const tabs = (await getSpaceTabs(spaceId)).filter(tab => !tab.incognito);
        for (const item of items) {
            if (item.url) {
                // This is a bookmark
                const tab = tabs.find(t => t.url === item.url);
                if (tab) {
                    bookmarks.push(tab.id);
                    // Set tab name override with the bookmark's title
                    if (item.title && item.title !== tab.title) { // Only override if bookmark title is present and different
                        await this.setTabNameOverride(tab.id, tab.url, item.title);
                        Logger.log(`Override set for tab ${tab.id} from bookmark: ${item.title}`);
                    }
                }
            } else {
                // This is a folder, recursively process it
                const subFolderBookmarks = await this.processBookmarkFolder(item, spaceId);
                bookmarks.push(...subFolderBookmarks);
            }
        }

        return bookmarks;
    },

    // Helper function to generate UUID (If you want to move this too)
    generateUUID: function () {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
            var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    },

    // Helper function to fetch favicon
    getFaviconUrl: function (u, size = "16") {
        const url = new URL(chrome.runtime.getURL("/_favicon/"));
        url.searchParams.set("pageUrl", u);
        url.searchParams.set("size", size);
        return url.toString();
    },

    // URL comparison key for pinned tabs:
    // intentionally ignore query params + hash to avoid treating benign changes (e.g. Google Docs) as "navigated away".
    getPinnedUrlKey: function (url) {
        if (!url) return '';
        // Each local lesson/run is a distinct practice tab, even though it shares a page.
        if (isPracticeUrl(url)) return url;
        try {
            const u = new URL(url);
            // Handle cases where origin might be "null" (e.g., chrome-extension://, about:blank)
            if (u.origin === 'null') {
                return String(url).split('#')[0].split('?')[0];
            }
            return `${u.origin}${u.pathname}`;
        } catch {
            // Fallback for non-standard URLs
            return String(url).split('#')[0].split('?')[0];
        }
    },

    getSettings: async function () {
        const defaultSettings = {
            defaultSpaceName: 'Home',
            startupLauncherEnabled: false, // Explicit opt-in; never opens the panel automatically
            autoArchiveEnabled: false, // Default: disabled
            autoArchiveIdleMinutes: 360, // Default: 6 hours
            syncTabGroups: false,
            ordinaryFavoriteTabs: false, // Prospective; existing Favorite tabs keep their mode
            invertTabOrder: true, // Saved pin/folder display only; preserve the legacy default
            todayNewTabsAtTop: true, // Future standalone Today tabs; existing order stays unchanged
            colorOverrides: null, // Default: no color overrides
            debugLoggingEnabled: false, // Default: disabled (controls debug logging)
            showAllOpenTabsInCollapsedFolders: false, // Default: Arc behavior (only show active tab in collapsed folder)
        };
        const result = await chrome.storage.sync.get(defaultSettings);
        Logger.log("Retrieved settings:", result);
        return result;
    },

    // Get all overrides (keyed by tabId)
    getTabNameOverrides: async function () {
        const result = await chrome.storage.local.get('tabNameOverridesById'); // Changed key
        return result.tabNameOverridesById || {}; // Changed key
    },

    // Save all overrides (keyed by tabId)
    saveTabNameOverrides: async function (overrides) {
        await chrome.storage.local.set({ tabNameOverridesById: overrides }); // Changed key
    },

    _tabNameChain: Promise.resolve(),
    _serializeTabNameOp: function (operation) {
        const locked = () => globalThis.navigator?.locks?.request
            ? globalThis.navigator.locks.request('arcify-tab-names', operation) : operation();
        const run = this._tabNameChain.then(locked, locked);
        this._tabNameChain = run.then(() => {}, () => {});
        return run;
    },
    setTabNameOverride: async function (tabId, url, name) {
        if (!tabId || !url || !name) return;
        const originalDomain = new URL(url).hostname;
        return this._serializeTabNameOp(async () => {
            const overrides = await this.getTabNameOverrides();
            const tab = await chrome.tabs.get(tabId);
            if (tab.incognito) throw new Error('Private tabs cannot store Space metadata.');
            const previous = overrides[tabId];
            if (previous && Object.keys(previous).length === 2 && previous.name === name && previous.originalDomain === originalDomain) return;
            overrides[tabId] = { name, originalDomain };
            await this.saveTabNameOverrides(overrides);
        });
    },
    removeTabNameOverride: async function (tabId) {
        if (!tabId) return;
        return this._serializeTabNameOp(async () => {
            const overrides = await this.getTabNameOverrides();
            if (!overrides[tabId]) return;
            delete overrides[tabId];
            await this.saveTabNameOverrides(overrides);
        });
    },

    // --- Pinned (Space Bookmark) Tab State ---
    // Tracks the original "pinned/bookmark URL" for a pinned tab, even if the user navigates away.
    // Keyed by ephemeral tabId (per session) which is sufficient for Arc-like "Back to Pinned URL".
    getPinnedTabStates: async function () {
        const result = await chrome.storage.local.get('pinnedTabStatesById');
        return result.pinnedTabStatesById || {};
    },

    savePinnedTabStates: async function (states) {
        await chrome.storage.local.set({ pinnedTabStatesById: states || {} });
    },

    getPinnedTabState: async function (tabId) {
        if (!tabId) return null;
        const states = await this.getPinnedTabStates();
        return states[tabId] || null;
    },

    // Serialization chain for pinnedTabStatesById read-modify-write ops. Without this,
    // concurrent set/remove callers (e.g. sidebar init's Promise.all over groups) each read
    // the SAME base object and write it back, so the last write clobbers earlier bindings —
    // dropping favorites' tab<->bookmark links (B10). Chaining makes each op atomic.
    _pinnedStateChain: Promise.resolve(),
    _serializePinnedStateOp: function (op) {
        // Also serialize across sidebar documents; local Promise chains alone
        // can overwrite another window's newly saved bookmark binding.
        const locked = () => globalThis.navigator?.locks?.request
            ? globalThis.navigator.locks.request('arcify-pinned-tab-state', op) : op();
        const run = this._pinnedStateChain.then(locked, locked);
        // Keep the chain alive even if an op rejects, so one failure can't wedge the queue.
        this._pinnedStateChain = run.then(() => { }, () => { });
        return run;
    },

    setPinnedTabState: async function (tabId, state, { onlyIfUnboundOrMatching = false, beforeWrite = null } = {}) {
        if (!tabId || !state) return;
        return this._serializePinnedStateOp(async () => {
            const states = await this.getPinnedTabStates();
            if (onlyIfUnboundOrMatching && states[tabId]?.bookmarkId && String(states[tabId].bookmarkId) !== String(state.bookmarkId)) {
                throw new Error('The tab is now linked to a different bookmark. Refresh and try again.');
            }
            // Optional callers can revalidate native state after queue/lock and
            // storage-read waits, immediately before this binding write.
            const tab = await chrome.tabs.get(tabId);
            if (tab.incognito) throw new Error('Private tabs cannot store Space metadata.');
            if (beforeWrite) await beforeWrite();
            const previous = states[tabId] ? { ...states[tabId] } : undefined;
            const written = { pinnedUrl: state.pinnedUrl || null, bookmarkId: state.bookmarkId || null };
            // Equality is checked inside the lock, after caller revalidation.
            // A no-op must still reject a changed owner or failed native guard.
            if (previous && Object.keys(previous).length === 2 && previous.pinnedUrl === written.pinnedUrl && previous.bookmarkId === written.bookmarkId) return;
            states[tabId] = written;
            try {
                await this.savePinnedTabStates(states);
                if (beforeWrite) await beforeWrite();
            } catch (error) {
                if (!beforeWrite) throw error;
                // A native split may appear while storage.set is resolving.
                // Restore only this call's exact binding, under the same lock;
                // never overwrite a newer binding or delete the saved bookmark.
                const sameBinding = (a, b) => a && b && Object.keys(a).length === Object.keys(b).length &&
                    Object.keys(b).every(key => a[key] === b[key]);
                try {
                    const latest = await this.getPinnedTabStates();
                    if (sameBinding(latest[tabId], written)) {
                        if (previous) latest[tabId] = previous;
                        else delete latest[tabId];
                        await this.savePinnedTabStates(latest);
                        const verified = (await this.getPinnedTabStates())[tabId];
                        if (previous ? !sameBinding(verified, previous) : verified !== undefined) throw new Error('The restored binding could not be verified.');
                    }
                } catch {
                    throw Object.assign(new Error(`${error.message} The live-tab binding cleanup could not be confirmed. Check Pinned before trying again.`), { cleanupUncertain: true });
                }
                throw error;
            }
        });
    },

    removePinnedTabState: async function (tabId, options = {}) {
        if (!tabId) return;
        return this.removePinnedTabStates([tabId], options);
    },

    // Exact linked panes are removed together so one failing native guard cannot
    // leave earlier panes demoted while later panes still belong to the pin.
    removePinnedTabStates: async function (tabIds, { preserveNativePinned = false, beforeWrite = null, expectedBookmarkId = null } = {}) {
        return this._serializePinnedStateOp(async () => {
            const ids = [];
            for (const tabId of [...new Set(tabIds)].filter(Boolean)) {
                if (preserveNativePinned) {
                    try { if ((await chrome.tabs.get(tabId))?.pinned) continue; }
                    catch { /* A closed tab's stale binding can be removed. */ }
                }
                ids.push(tabId);
            }
            const states = await this.getPinnedTabStates();
            if (beforeWrite) await beforeWrite();
            const previous = {};
            for (const tabId of ids) {
                if (expectedBookmarkId && states[tabId]?.bookmarkId !== expectedBookmarkId) throw new Error('The tab is now linked to a different bookmark. Refresh and try again.');
                if (!states[tabId]) continue;
                previous[tabId] = { ...states[tabId] }; delete states[tabId];
            }
            if (!Object.keys(previous).length) return;
            try {
                await this.savePinnedTabStates(states);
                if (beforeWrite) await beforeWrite();
            } catch (error) {
                if (!beforeWrite) throw error;
                try {
                    const latest = await this.getPinnedTabStates(), restored = [];
                    for (const [key, binding] of Object.entries(previous)) {
                        // Our write removed this key. A new binding wins.
                        if (latest[key] !== undefined) continue;
                        latest[key] = binding; restored.push(key);
                    }
                    if (restored.length) {
                        await this.savePinnedTabStates(latest);
                        const verified = await this.getPinnedTabStates();
                        if (restored.some(key => !verified[key] || Object.keys(verified[key]).length !== Object.keys(previous[key]).length ||
                            Object.keys(previous[key]).some(field => verified[key][field] !== previous[key][field]))) throw new Error('The restored binding could not be verified.');
                    }
                } catch {
                    throw Object.assign(new Error(`${error.message} The live-tab binding cleanup could not be confirmed. Check Pinned before trying again.`), { cleanupUncertain: true });
                }
                throw error;
            }
        });
    },

    // Drop pinnedTabStatesById entries whose tab id is no longer a live tab. Keyed by
    // ephemeral tab id, this map otherwise accumulates dead keys across restarts, and a
    // reused id could inherit a stale binding (B11). Called once on startup. Pass ALL live
    // tab ids (across windows) so multi-window bindings aren't wrongly pruned.
    prunePinnedTabStates: async function (validTabIds) {
        const valid = new Set((validTabIds || []).map(id => String(id)));
        return this._serializePinnedStateOp(async () => {
            const states = await this.getPinnedTabStates();
            let changed = false;
            for (const key of Object.keys(states)) {
                if (!valid.has(String(key))) {
                    delete states[key];
                    changed = true;
                }
            }
            if (changed) await this.savePinnedTabStates(states);
        });
    },

    getSpaceColor: async function (groupName) {
        const { spaces = [] } = await chrome.storage.local.get('spaces');
        return spaces.find(s => s.name === groupName)?.color || 'grey';
    },

    // Function to get if archiving is enabled
    isArchivingEnabled: async function () {
        const settings = await this.getSettings();
        return settings.autoArchiveEnabled;
    },

    // Existing readers retain the same array shape; migration is authoritative.
    getArchivedTabs: async function () { return archiveRequest('list'); },
    getArchiveView: async function (windowId) { return archiveRequest('view', { windowId }); },
    // A full replacement requires its exact prior snapshot; a stale sidebar
    // cannot erase concurrent manual/automatic archive additions.
    saveArchivedTabs: async function (tabs, expected) {
        return archiveRequest('replace', { entries: tabs, expected });
    },
    addArchivedTab: async function (tabData) {
        if (!tabData?.url || !tabData.name || !tabData.spaceId || isStartupLauncherUrl(tabData.url)) return;
        return archiveRequest('add', { entry: tabData });
    },
    archiveTab: async function (tabId, expectedTab = null, expectedSpace = null) {
        const tab = expectedTab || await chrome.tabs.get(tabId);
        if (!tab || isStartupLauncherTab(tab)) return;
        let space = expectedSpace;
        if (!space) {
            const spaces = await spaceRequest('get');
            const owners = spaces.filter(space => [...space.spaceBookmarks, ...space.temporaryTabs].includes(tabId));
            if (owners.length !== 1) throw new Error('This tab changed. Reopen its menu and try again.');
            space = owners[0];
        }
        return archiveRequest('archive', { tabId, windowId: tab.windowId, spaceId: space.id,
            bookmarkFolderId: space.bookmarkFolderId, url: tab.url });
    },
    // URL-only removal is intentionally no longer supported. Legacy objects
    // resolve only when their complete unchanged tuple is unique.
    removeArchivedTab: async function (expected) { return archiveRequest('remove', { expected }); },
    restoreArchivedTab: async function (archivedTabData, { windowId, context, bookmarkFolderId, requestId = crypto.randomUUID() } = {}) {
        return archiveRequest('reopen', { requestId, windowId, context, bookmarkFolderId, expected: archivedTabData });
    },

    setArchivingEnabled: async function (enabled) {
        const settings = await this.getSettings();
        settings.autoArchiveEnabled = enabled;
        await chrome.storage.sync.set({ autoArchiveEnabled: enabled });
    },

    setArchiveTime: async function (minutes) {
        const settings = await this.getSettings();
        settings.autoArchiveIdleMinutes = minutes;
        await chrome.storage.sync.set({ autoArchiveIdleMinutes: minutes });
    },

    // Get Arc-like positioning setting (when enabled, tabs append to end instead of syncing with Chrome)
    getUseArcLikePositioning: async function () {
        const settings = await this.getSettings();
        return settings.useArcLikePositioning;
    },

    // Set Arc-like positioning setting
    setUseArcLikePositioning: async function (enabled) {
        await chrome.storage.sync.set({ useArcLikePositioning: enabled });
    },

    // Saved bookmark/folder display only. Today has a frozen local representation.
    getInvertTabOrder: async function () {
        const settings = await this.getSettings();
        return settings.invertTabOrder;
    },

    setInvertTabOrder: async function (enabled) {
        await this.getTodayOrderInverted();
        await chrome.storage.sync.set({ invertTabOrder: enabled });
    },

    getTodayOrderInverted,

    getTodayNewTabsAtTop: async function () {
        const settings = await this.getSettings();
        return settings.todayNewTabsAtTop !== false;
    },

    setTodayNewTabsAtTop: async function (enabled) {
        await chrome.storage.sync.set({ todayNewTabsAtTop: enabled });
    },


    // Navigate to adjacent tab within a space (next or previous)
    _navigateTabInSpace: async function (tabId, sourceSpace, direction) {
        const temporaryTabs = sourceSpace?.temporaryTabs ?? [];
        const spaceBookmarks = sourceSpace?.spaceBookmarks ?? [];
        const currentTab = await chrome.tabs.get(tabId);
        const windowTabs = new Set((await chrome.tabs.query({ windowId: currentTab.windowId })).map(t => t.id));
        const allTabs = [...spaceBookmarks, ...temporaryTabs].filter(id => windowTabs.has(id));

        if (allTabs.length === 0) return;

        const currentIndex = allTabs.indexOf(tabId);
        if (currentIndex === -1) return;

        const nextIndex = direction === 'next'
            ? (currentIndex + 1) % allTabs.length
            : (currentIndex - 1 + allTabs.length) % allTabs.length;

        chrome.tabs.update(allTabs[nextIndex], { active: true });
    },

    movToNextTabInSpace: async function (tabId, sourceSpace) {
        return this._navigateTabInSpace(tabId, sourceSpace, 'next');
    },

    movToPrevTabInSpace: async function (tabId, sourceSpace) {
        return this._navigateTabInSpace(tabId, sourceSpace, 'prev');
    },
    findActiveSpaceAndTab: async function () {
        Logger.log("[TabNavigation] finding space");
        const spacesResult = await chrome.storage.local.get('spaces');
        const spaces = spacesResult.spaces || [];
        Logger.log("[TabNavigation] Loaded spaces from storage:", spaces);
        const foundTabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (foundTabs.length === 0) {
            Logger.log("[TabNavigation] No active tab found!:");
            return undefined;
        }
        const foundTab = foundTabs[0];
        const spaceWithTempTab = spaces.find(space =>
            space.temporaryTabs.includes(foundTab.id)
        );
        if (spaceWithTempTab) {
            Logger.log(`[TabNavigation] Tab ${foundTab.id} is a temporary tab in space "${spaceWithTempTab.name}".`);
            return { space: spaceWithTempTab, tab: foundTab };
        }

        const spaceWithBookmark = spaces.find(space =>
            space.spaceBookmarks.includes(foundTab.id)
        );
        if (spaceWithBookmark) {
            Logger.log(`[TabNavigation] Tab ${foundTab.id} is a bookmarked tab in space "${spaceWithBookmark.name}".`);
            return { space: spaceWithBookmark, tab: foundTab };
        }

        return undefined
    },

    // Helper function to adjust menu position to keep it within viewport
    adjustMenuPosition: function (menu, x, y) {
        // Ensure menu is in DOM to get dimensions
        if (!menu.isConnected) {
            Logger.warn('Menu must be in DOM to adjust position');
            return;
        }

        const rect = menu.getBoundingClientRect();
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;

        let left = x;
        let top = y;

        // Check right edge
        if (left + rect.width > viewportWidth) {
            left = viewportWidth - rect.width - 5; // 5px padding
        }

        // Check bottom edge
        if (top + rect.height > viewportHeight) {
            top = viewportHeight - rect.height - 5; // 5px padding
        }

        // Check left edge (unlikely but possible)
        if (left < 0) {
            left = 5;
        }

        // Check top edge
        if (top < 0) {
            top = 5;
        }

        menu.style.left = `${left}px`;
        menu.style.top = `${top}px`;
    }
}

export { Utils };
