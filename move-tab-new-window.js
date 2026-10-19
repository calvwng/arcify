import { Utils } from './utils.js';
import { getSpaceBookmarkById } from './space-bookmarks.js';
import { assertNotNativeSplit } from './native-split-safety.js';
import { isStartupLauncherTab } from './startup-launcher-tab.js';

const positive = n => Number.isSafeInteger(n) && n > 0;
const text = s => typeof s === 'string' && s.length > 0 && s.length <= 256;
const stale = () => new Error('This live tab changed. Reopen its menu before moving it.');

// A single irreversible native move, serialized with Space/Favorite mutations.
// No URL-based lookup, new-page fallback, retry, bookmark write or tab removal.
export function moveTabToNewWindow(store, favorites, request) {
    return store.run(async () => {
        if (!request || request.type !== 'moveTabToNewWindow' || !positive(request.tabId) || !positive(request.windowId)
            || Object.keys(request).some(k => !['type', 'windowId', 'tabId', 'spaceId', 'bookmarkFolderId', 'bookmarkId', 'parentId', 'favoriteId'].includes(k))) throw new Error('Select one live tab to move to a new window.');
        const spaceTarget = request.spaceId !== undefined;
        if (spaceTarget ? !text(request.spaceId) || !text(request.bookmarkFolderId) || request.favoriteId !== undefined
            || request.bookmarkId !== undefined && (!text(request.bookmarkId) || !text(request.parentId))
            || request.bookmarkId === undefined && request.parentId !== undefined
            : ['bookmarkFolderId', 'bookmarkId', 'parentId'].some(k => request[k] !== undefined)
                || request.favoriteId !== undefined && !text(request.favoriteId)) throw stale();
        let ownerId = null;
        async function resolve() {
            const sourceWindow = await chrome.windows.get(request.windowId);
            if (sourceWindow.type !== 'normal' || sourceWindow.incognito) throw stale();
            const tab = await chrome.tabs.get(request.tabId);
            if (tab.id !== request.tabId || tab.windowId !== request.windowId || tab.incognito || isStartupLauncherTab(tab)) throw stale();
            assertNotNativeSplit(tab);
            if (spaceTarget) {
                const space = store.spaces.find(s => s.id === request.spaceId);
                const locations = store.spaces.flatMap(s => ['spaceBookmarks', 'temporaryTabs'].flatMap(section =>
                    (s[section] || []).filter(id => id === tab.id).map(() => ({ space: s, section }))));
                if (!space || space.bookmarkFolderId !== request.bookmarkFolderId || store.active[request.windowId] !== space.id
                    || locations.length !== 1 || locations[0].space !== space || locations[0].section !== (request.bookmarkId ? 'spaceBookmarks' : 'temporaryTabs')
                    || tab.pinned || store.isGlobalTab?.(tab)) throw stale();
                const binding = await Utils.getPinnedTabState(tab.id);
                if (request.bookmarkId) {
                    const bookmark = await getSpaceBookmarkById(space, request.bookmarkId);
                    if (!bookmark || bookmark.parentId !== request.parentId || binding?.bookmarkId !== request.bookmarkId) throw stale();
                } else if (binding?.bookmarkId) throw stale();
                ownerId = space.id;
            } else if (request.favoriteId) {
                const bindings = favorites.state.bindings.filter(b => b.favoriteId === request.favoriteId && b.tabId === tab.id && b.windowId === tab.windowId);
                if (bindings.length !== 1 || !favorites.items.some(f => f.id === request.favoriteId)
                    || bindings[0].mode !== 'ordinary' && !tab.pinned) throw stale();
            } else if (!tab.pinned || favorites.state.bindings.some(b => b.tabId === tab.id)) throw stale();
            return tab;
        }
        await resolve();
        // Binding/bookmark reads above may yield to native browser operations.
        const before = await resolve();
        if (spaceTarget) {
            // Bookmark-tree reads yield: re-read the exact binding afterwards.
            const binding = await Utils.getPinnedTabState(before.id);
            if (request.bookmarkId ? binding?.bookmarkId !== request.bookmarkId : binding?.bookmarkId) throw stale();
        }
        const last = await chrome.tabs.get(request.tabId);
        assertNotNativeSplit(last);
        if (last.windowId !== before.windowId || last.pinned !== before.pinned || last.incognito) throw stale();
        let created;
        try { created = await chrome.windows.create({ tabId: before.id, type: 'normal', focused: true }); }
        catch { throw new Error('The new-window move could not be confirmed. Check your windows before retrying; the page will not be recreated automatically.'); }
        try {
            if (!positive(created?.id) || created.id === request.windowId || created.type !== 'normal' || created.incognito) throw stale();
            const readDestination = async ({ allowPinChange = false } = {}) => {
                const tab = await chrome.tabs.get(before.id);
                if (tab.id !== before.id || tab.windowId !== created.id || tab.incognito
                    || !allowPinChange && tab.pinned !== before.pinned) throw stale();
                assertNotNativeSplit(tab);
                return tab;
            };
            let moved = await readDestination({ allowPinChange: true });
            // Native window moves may strip a pin. Preserve the source pin mode.
            if (moved.pinned !== before.pinned) {
                // No native compare-and-swap exists; fence every awaited read
                // before mutating, and verify the exact survivor afterwards.
                await readDestination({ allowPinChange: true });
                moved = await chrome.tabs.update(before.id, { pinned: before.pinned });
                await readDestination();
            }
            if (ownerId) store.active[created.id] = ownerId;
            await favorites.reconcile({ updateSpaces: false });
            const validateDestination = async () => {
                if (request.favoriteId) {
                    const matches = favorites.state.bindings.filter(b => b.favoriteId === request.favoriteId
                        && b.tabId === before.id && b.windowId === created.id);
                    if (matches.length !== 1 || !favorites.items.some(f => f.id === request.favoriteId)) throw stale();
                }
                if (ownerId) {
                    const space = store.spaces.find(s => s.id === ownerId);
                    const section = request.bookmarkId ? 'spaceBookmarks' : 'temporaryTabs';
                    const owners = store.spaces.flatMap(s => ['spaceBookmarks', 'temporaryTabs'].flatMap(key =>
                        (s[key] || []).filter(id => id === before.id).map(() => ({ space: s, section: key }))));
                    if (!space || space.bookmarkFolderId !== request.bookmarkFolderId || owners.length !== 1
                        || owners[0].space !== space || owners[0].section !== section) throw stale();
                    const binding = await Utils.getPinnedTabState(before.id);
                    if (request.bookmarkId) {
                        const bookmark = await getSpaceBookmarkById(space, request.bookmarkId);
                        if (!bookmark || bookmark.parentId !== request.parentId || binding?.bookmarkId !== request.bookmarkId) throw stale();
                    } else if (binding?.bookmarkId) throw stale();
                }
                return readDestination();
            };
            moved = await validateDestination();
            store.track(moved);
            await store.persist({ beforeWrite: validateDestination });
            await validateDestination();
            return { tabId: before.id, windowId: created.id };
        } catch (error) {
            throw new Error(`The tab was moved, but its Arcify state could not be fully confirmed. Check the new window before taking another action. ${error.message}`);
        }
    });
}

export function registerMoveTabWindowMessages(store, favorites) {
    chrome.runtime.onMessage.addListener((request, sender, respond) => {
        if (request?.type !== 'moveTabToNewWindow') return;
        const page = chrome.runtime.getURL('sidebar.html');
        if (sender?.id !== chrome.runtime.id || sender.url?.split(/[?#]/)[0] !== page
            || sender.origin && sender.origin !== chrome.runtime.getURL('').replace(/\/$/, '')
            || sender.tab && sender.tab.windowId !== request.windowId) {
            respond({ success: false, error: 'Open this action from the Arcify sidebar.' }); return;
        }
        moveTabToNewWindow(store, favorites, request).then(result => respond({ success: true, ...result }),
            error => respond({ success: false, error: error.message }));
        return true;
    });
}
