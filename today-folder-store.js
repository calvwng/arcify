import { enqueueBookmarkOperation } from './bookmark-writer.js';
import { getSpaceBookmarkFolder } from './space-bookmarks.js';
import { Utils } from './utils.js';
import { isStartupLauncherTab } from './startup-launcher-tab.js';
import { assertNotNativeSplit } from './native-split-safety.js';

const MAX_TABS = 100;
const positiveId = value => Number.isSafeInteger(value) && value > 0;
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const changed = () => new Error('The selected tabs, Space, or folder changed. Select the tabs again.');
const sameIds = (a, b) => a.length === b.length && a.every((id, index) => id === b[index]);
const validUrl = value => {
    if (typeof value !== 'string' || !value || value.length > 16384) return false;
    try { return ['http:', 'https:', 'file:', 'ftp:', 'chrome:', 'about:'].includes(new URL(value).protocol); }
    catch { return false; }
};

// The SpaceStore queue keeps extension-owned membership changes serialized;
// the bookmark writer keeps each create/order check serialized with other saves.
// Native Chrome/Sync events can still race, so every boundary is revalidated and
// any partial result is retained and reported. Tabs are never opened or closed.
export function saveTodayTabsInNewFolder(store, request) {
    return store.run(async () => {
        if (!request || Array.isArray(request) || typeof request !== 'object' ||
            Object.keys(request).some(key => !['type', 'windowId', 'spaceId', 'bookmarkFolderId', 'entries', 'inverted', 'title'].includes(key)) ||
            request.type !== undefined && request.type !== 'saveTodayTabsInNewFolder') throw new Error('Invalid Today save request. Nothing was saved.');
        const { windowId, spaceId, bookmarkFolderId, entries, inverted } = request;
        const title = typeof request.title === 'string' ? request.title.trim() : '';
        if (!title || title.length > 256 || !positiveId(windowId) || !identifier(spaceId) || !identifier(bookmarkFolderId) ||
            typeof inverted !== 'boolean' || !Array.isArray(entries) || !entries.length || entries.length > MAX_TABS ||
            entries.some(entry => !entry || Array.isArray(entry) || typeof entry !== 'object' ||
                Object.keys(entry).some(key => !['tabId', 'url'].includes(key)) || !positiveId(entry.tabId) || !validUrl(entry.url)) ||
            new Set(entries.map(entry => entry.tabId)).size !== entries.length) {
            throw new Error('Choose 1–100 Today tabs with supported URLs and a folder name of 1–256 characters. Nothing was saved.');
        }
        const result = { folderId: null, title, total: entries.length, completed: [], created: [], failedTabId: null, uncertain: false, cleanupUncertain: false };
        let folderAttempted = false;
        const bound = new Map();
        const getSpace = () => {
            const space = store.spaces.find(item => item.id === spaceId);
            if (!space || space.bookmarkFolderId !== bookmarkFolderId || store.active[windowId] !== spaceId) throw changed();
            return space;
        };
        async function validateTab(entry, { bindingId = bound.get(entry.tabId), section = bound.has(entry.tabId) ? 'spaceBookmarks' : 'temporaryTabs' } = {}) {
            const space = getSpace(), expectedBookmarkId = bindingId;
            const memberships = store.spaces.flatMap(item => ['temporaryTabs', 'spaceBookmarks'].flatMap(section =>
                (item[section] || []).filter(id => id === entry.tabId).map(() => ({ spaceId: item.id, section }))));
            if (memberships.length !== 1 || memberships[0].spaceId !== space.id ||
                memberships[0].section !== section || store.isGlobalTab?.(entry.tabId)) throw changed();
            const binding = await Utils.getPinnedTabState(entry.tabId);
            if (expectedBookmarkId ? binding?.bookmarkId !== expectedBookmarkId || binding?.pinnedUrl !== entry.url : binding?.bookmarkId) throw changed();
            let tab;
            try { tab = await chrome.tabs.get(entry.tabId); } catch { throw changed(); }
            assertNotNativeSplit(tab);
            if (!tab || tab.id !== entry.tabId || tab.windowId !== windowId || tab.incognito || tab.pinned || isStartupLauncherTab(tab) ||
                tab.url !== entry.url || (tab.pendingUrl && tab.pendingUrl !== entry.url)) throw changed();
            return tab;
        }
        async function validateContext() {
            const space = getSpace();
            const window = await chrome.windows.get(windowId);
            if (!window || window.id !== windowId || window.type !== 'normal' || window.incognito) throw changed();
            await getSpaceBookmarkFolder(space);
            if (Boolean(await Utils.getInvertTabOrder()) !== inverted) throw changed();
            if (result.folderId) {
                const [folder] = await chrome.bookmarks.get(result.folderId);
                if (!folder || folder.url || folder.parentId !== bookmarkFolderId || folder.title !== title) throw changed();
            }
            return space;
        }
        async function validateAll() {
            await validateContext();
            for (const entry of entries) await validateTab(entry);
        }
        async function releaseBinding(entry, bookmarkId) {
            // Remove only the binding this operation just wrote. A concurrently
            // rebound tab is somebody else's state and is never overwritten.
            await Utils._serializePinnedStateOp(async () => {
                const states = await Utils.getPinnedTabStates();
                if (states[entry.tabId]?.bookmarkId !== bookmarkId || states[entry.tabId]?.pinnedUrl !== entry.url) return;
                delete states[entry.tabId]; await Utils.savePinnedTabStates(states);
            });
        }
        const appendOperation = (parentId, ids, item) => ({
            parents: [{ parentId, expectedCanonicalIds: ids, desiredCanonicalIds: [...ids, '$new'] }],
            relocation: { kind: 'create', parentId, ...item }
        });
        try {
            await validateAll();
            const rootIds = (await chrome.bookmarks.getChildren(bookmarkFolderId)).map(item => String(item.id));
            const operation = appendOperation(bookmarkFolderId, rootIds, { title });
            try {
                const saved = await enqueueBookmarkOperation(operation, { beforeWrite: async () => {
                    await validateAll(); folderAttempted = true;
                } });
                result.folderId = saved.createdId;
            } catch (error) {
                result.folderId = error.createdId || null;
                result.uncertain = folderAttempted && !error.createdId;
                throw error;
            }
            // Canonical bookmark order is rendered in reverse when the setting
            // is enabled. Preserve the user's visible selection order either way.
            const ordered = inverted ? [...entries].reverse() : entries;
            const childIds = [];
            const createdMetadata = new Map();
            for (const entry of ordered) {
                result.failedTabId = entry.tabId;
                await validateAll();
                const tab = await validateTab(entry);
                const overrides = await Utils.getTabNameOverrides();
                const operation = appendOperation(result.folderId, [...childIds], { title: overrides[entry.tabId]?.name || tab.title || entry.url, url: entry.url });
                let attempted = false, bookmarkId;
                try {
                    const saved = await enqueueBookmarkOperation(operation, { beforeWrite: async () => {
                        await validateAll();
                        const fresh = await validateTab(entry);
                        const names = await Utils.getTabNameOverrides();
                        operation.relocation.title = names[entry.tabId]?.name || fresh.title || entry.url;
                        // Names may involve storage I/O; check the live URL once more.
                        await validateTab(entry); attempted = true;
                    } });
                    bookmarkId = saved.createdId;
                } catch (error) {
                    if (error.createdId) result.created.push({ tabId: entry.tabId, bookmarkId: error.createdId });
                    result.uncertain = attempted && !error.createdId;
                    throw error;
                }
                result.created.push({ tabId: entry.tabId, bookmarkId }); childIds.push(bookmarkId);
                createdMetadata.set(bookmarkId, { url: entry.url, title: operation.relocation.title });
                // If the tab closed/moved/navigated during creation, leave its
                // saved bookmark and stop. Never bind a replacement or equal URL.
                await validateContext(); await validateTab(entry);
                const [saved] = await chrome.bookmarks.get(bookmarkId);
                if (!saved || saved.parentId !== result.folderId || saved.url !== entry.url ||
                    !sameIds((await chrome.bookmarks.getChildren(result.folderId)).map(item => String(item.id)), childIds)) throw changed();
                const space = getSpace();
                const originalTemporary = [...space.temporaryTabs];
                let membershipChanged = false;
                try {
                    await Utils.setPinnedTabState(entry.tabId, { bookmarkId, pinnedUrl: entry.url }, { onlyIfUnboundOrMatching: true });
                    await validateContext(); await validateTab(entry, { bindingId: bookmarkId });
                    space.temporaryTabs = space.temporaryTabs.filter(id => id !== entry.tabId);
                    space.spaceBookmarks.push(entry.tabId); membershipChanged = true;
                    bound.set(entry.tabId, bookmarkId);
                    store.restoredRanks?.delete(entry.tabId);
                    await validateTab(entry);
                    await store.persist();
                    await validateTab(entry);
                } catch (error) {
                    // No bookmark deletion or tab close as rollback. Restore only
                    // our just-written association; keep the durable partial save.
                    if (membershipChanged && store.spaces.includes(space) && space.spaceBookmarks.includes(entry.tabId) &&
                        !store.spaces.some(other => other !== space && [...other.spaceBookmarks, ...other.temporaryTabs].includes(entry.tabId))) {
                        space.spaceBookmarks = space.spaceBookmarks.filter(id => id !== entry.tabId);
                        space.temporaryTabs = [...originalTemporary.filter(id => id === entry.tabId || space.temporaryTabs.includes(id)),
                            ...space.temporaryTabs.filter(id => !originalTemporary.includes(id))];
                        bound.delete(entry.tabId);
                    }
                    try { await releaseBinding(entry, bookmarkId); if (membershipChanged) await store.persist(); }
                    catch { result.cleanupUncertain = true; }
                    throw error;
                }
                result.completed.push({ tabId: entry.tabId, bookmarkId });
            }
            result.failedTabId = null;
            await validateAll();
            const children = await chrome.bookmarks.getChildren(result.folderId);
            if (!sameIds(children.map(item => String(item.id)), childIds) || children.some(item => {
                const expected = createdMetadata.get(String(item.id));
                return !expected || item.url !== expected.url || item.title !== expected.title;
            })) throw changed();
            return result;
        } catch (error) {
            error.batch = result;
            throw error;
        }
    });
}

export function registerTodayFolderMessages(store) {
    chrome.runtime.onMessage.addListener((message, sender, respond) => {
        if (message?.type !== 'saveTodayTabsInNewFolder') return;
        const ownUrl = chrome.runtime.getURL('');
        if (sender?.id !== chrome.runtime.id || sender.url && !sender.url.startsWith(ownUrl) ||
            sender.origin && sender.origin !== ownUrl.replace(/\/$/, '') || sender.tab && sender.tab.windowId !== message.windowId) {
            respond({ success: false, error: 'Invalid Today save sender.' }); return;
        }
        saveTodayTabsInNewFolder(store, message).then(
            batch => respond({ success: true, batch }),
            error => respond({ success: false, error: error.message, ...(error.batch ? { batch: error.batch } : {}) })
        );
        return true;
    });
}
