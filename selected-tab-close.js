import { Utils } from './utils.js';
import { getSpaceBookmarkById } from './space-bookmarks.js';
import { assertNotTransient } from './transient-safety.js';
import { isStartupLauncherTab } from './startup-launcher-tab.js';
import { hasNativeSplit } from './native-split-safety.js';

const integer = value => Number.isSafeInteger(value) && value > 0;
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 16384;
const stale = () => new Error('The selected tabs changed. Select them again before closing.');

// Serialize with ownership changes. Native browser operations remain non-atomic;
// never retry a failed remove or substitute a replacement tab identity.
export async function closeSelectedTabs(store, request) {
    const completed = [];
    let attempted = false;
    try { return await store.run(async () => {
        if (!request || !integer(request.windowId) || !text(request.spaceId) || !text(request.bookmarkFolderId) ||
            !Array.isArray(request.entries) || !request.entries.length || request.entries.length > 100 ||
            request.entries.some(e => !e || !integer(e.tabId) || typeof e.url !== 'string' || e.url.length > 16384 ||
                (e.bookmarkId !== undefined && (!text(e.bookmarkId) || !text(e.parentId)))) ||
            new Set(request.entries.map(e => e.tabId)).size !== request.entries.length) throw new Error('Invalid close selection.');
        const owner = entry => {
            const space = store.spaces.find(s => s.id === request.spaceId);
            const memberships = store.spaces.flatMap(s => ['temporaryTabs', 'spaceBookmarks'].flatMap(section =>
                (s[section] || []).filter(id => id === entry.tabId).map(() => ({ space: s, section }))));
            if (!space || space.bookmarkFolderId !== request.bookmarkFolderId || store.active[request.windowId] !== space.id ||
                memberships.length !== 1 || memberships[0].space !== space ||
                memberships[0].section !== (entry.bookmarkId ? 'spaceBookmarks' : 'temporaryTabs') || store.isGlobalTab?.(entry.tabId)) throw stale();
            assertNotTransient(store, { windowId: request.windowId, tabId: entry.tabId });
            return space;
        };
        async function check(entry) {
            const space = owner(entry);
            const window = await chrome.windows.get(request.windowId);
            if (window.id !== request.windowId || window.type !== 'normal' || window.incognito) throw stale();
            if (entry.bookmarkId) {
                const bookmark = await getSpaceBookmarkById(space, entry.bookmarkId);
                if (!bookmark || bookmark.parentId !== entry.parentId) throw stale();
            }
            const binding = await Utils.getPinnedTabState(entry.tabId);
            if (entry.bookmarkId ? binding?.bookmarkId !== entry.bookmarkId : binding?.bookmarkId) throw stale();
            const tab = await chrome.tabs.get(entry.tabId);
            owner(entry);
            assertNotTransient(store, { windowId: request.windowId, tab });
            if (tab.id !== entry.tabId || tab.windowId !== request.windowId || tab.incognito || tab.pinned ||
                isStartupLauncherTab(tab) || (tab.url || tab.pendingUrl || '') !== entry.url ||
                tab.pendingUrl && tab.pendingUrl !== entry.url) throw stale();
            // Avoid browser-owned split side effects on an unselected peer.
            if (request.entries.length > 1 && hasNativeSplit(tab)) throw new Error('End Split View before closing selected tabs.');
        }
        try {
            // Validate the entire immutable batch before the first removal.
            for (const entry of request.entries) await check(entry);
            for (const entry of request.entries) {
                attempted = false;
                await check(entry);
                attempted = true;
                await chrome.tabs.remove(entry.tabId);
                completed.push(entry.tabId);
                attempted = false;
            }
            return { success: true, completed, uncertain: false };
        } catch (error) {
            return { success: false, completed, uncertain: attempted, error: error.message };
        }
    }); } catch (error) {
        return { success: false, completed, uncertain: attempted, error: error.message };
    }
}

export function registerSelectedTabClose(store) {
    chrome.runtime.onMessage.addListener((message, sender, respond) => {
        if (message?.type !== 'closeSelectedTabs') return;
        if (sender?.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('sidebar.html') ||
            sender.tab && sender.tab.windowId !== message.windowId) {
            respond({ success: false, error: 'Invalid close selection sender.' }); return;
        }
        closeSelectedTabs(store, message).then(respond, error => respond({ success: false, completed: [], uncertain: false, error: error.message }));
        return true;
    });
}

