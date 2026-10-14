import { getSpaceBookmarkById } from './space-bookmarks.js';
import { Utils } from './utils.js';
import { spaceRequest } from './space-client.js';

const stale = () => new Error('The saved bookmark or its space changed. Refresh and drag it again.');
const windowChanged = () => new Error('The tab or sidebar window changed. Drag it again in its current window.');
const receiptChanged = () => new Error('The previous Favorite tab was moved, unpinned, or linked to another bookmark. Use its current tab; this bookmark can open a new Favorite after that tab is closed.');

// A successful native Favorite intentionally dragged back into a space is no
// longer the result of that saved-row drop. Invalidate only completed receipts;
// an uncertain create without a known tab is never discarded here.
export async function releaseCompletedFavoriteReceipt(tabId, windowId) {
    if (!globalThis.navigator?.locks?.request) throw new Error('Favorites could not acquire its safety lock.');
    return navigator.locks.request('arcify-native-favorite-drop', async () => {
        const tab = await chrome.tabs.get(tabId);
        if (tab.windowId !== windowId || tab.pinned) throw windowChanged();
        const { favoriteDropAttempts = {} } = await chrome.storage.session.get('favoriteDropAttempts');
        let changed = false;
        for (const [key, receipt] of Object.entries(favoriteDropAttempts)) {
            if (receipt.tabId === tabId && receipt.complete) { delete favoriteDropAttempts[key]; changed = true; }
        }
        if (changed) await chrome.storage.session.set({ favoriteDropAttempts });
    });
}

// Only handlers installed on our own rows can start a drag. DataTransfer text,
// URLs, and a stray .dragging class are deliberately not a source of authority.
export function createFavoritesDragSource({ document, getContext }) {
    let source = null;
    const parentId = (element, space) => element.parentElement?.closest('.folder')?.dataset.bookmarkId || space?.bookmarkFolderId;
    function start(element) {
        source = null;
        const context = getContext(), spaceElement = element.closest('.space');
        const space = context.spaces.find(item => item.id === spaceElement?.dataset.spaceId);
        const native = element.matches('.pinned-favicon') && element.parentElement?.id === 'pinnedFavicons';
        if (!element.isConnected || (!native && (!space || space.id !== context.activeSpaceId || !document.getElementById('spacesList')?.contains(element)))) return;
        source = { element, windowId: context.windowId, spaceId: space?.id,
            bookmarkFolderId: space?.bookmarkFolderId, parentId: parentId(element, space),
            bookmarkId: element.dataset.bookmarkId || null, tabId: element.dataset.tabId ? Number(element.dataset.tabId) : null,
            kind: element.matches('.folder') ? 'folder' : native ? 'native' : element.dataset.bookmarkId ? 'bookmark' : 'live' };
    }
    function inspect() {
        if (!source) return { error: 'Drag one saved bookmark or tab from this sidebar into Favorites.' };
        const { element } = source, context = getContext();
        const space = context.spaces.find(item => item.id === source.spaceId);
        if (!element.isConnected || !element.classList.contains('dragging') || document.querySelectorAll('.dragging').length !== 1 ||
            context.windowId !== source.windowId || element.dataset.bookmarkId !== (source.bookmarkId || undefined) ||
            (element.dataset.tabId ? Number(element.dataset.tabId) : null) !== source.tabId ||
            (source.kind !== 'native' && (space?.id !== context.activeSpaceId || space?.bookmarkFolderId !== source.bookmarkFolderId ||
                element.closest('.space')?.dataset.spaceId !== source.spaceId || parentId(element, space) !== source.parentId))) {
            return { error: 'The dragged item changed. Refresh and drag it again.' };
        }
        if (source.kind === 'folder') return { error: 'Favorites accepts one bookmark at a time. Open the folder and drag a bookmark.' };
        if (source.kind === 'live' && !Number.isInteger(source.tabId)) return { error: 'This item cannot be added to Favorites.' };
        return { source, hint: source.kind === 'bookmark' && !source.tabId
            ? 'Opens a pinned tab in this window. Your saved bookmark stays in its folder.' : 'Add or reorder a pinned tab in this window.' };
    }
    return { start, inspect, take() { const result = inspect(); source = null; return result; }, clear() { source = null; } };
}

// Web Locks serialize all documents. Session attempt records survive partial
// failures, so an uncertain create cannot be blindly repeated by another page.
export function createBookmarkFavoriteDrop({ getContext, api = globalThis.chrome,
    locks = globalThis.navigator?.locks,
    getBookmark = getSpaceBookmarkById, getBindings = () => Utils.getPinnedTabStates(),
    getSpaces = () => spaceRequest('get'),
    setBinding = (id, state) => Utils.setPinnedTabState(id, state, { onlyIfUnboundOrMatching: true }) }) {
    const inFlight = new Map(), knownCreations = new Map();
    function currentSpace(source) {
        const context = getContext(), space = context.spaces.find(item => item.id === source.spaceId);
        if (context.windowId !== source.windowId || context.activeSpaceId !== source.spaceId ||
            !space || space.bookmarkFolderId !== source.bookmarkFolderId) throw stale();
        return space;
    }
    async function validate(source) {
        currentSpace(source);
        const space = (await getSpaces()).find(item => item.id === source.spaceId);
        if (!space || space.bookmarkFolderId !== source.bookmarkFolderId) throw stale();
        const bookmark = await getBookmark(space, source.bookmarkId);
        if (!bookmark?.url || String(bookmark.id) !== source.bookmarkId || String(bookmark.parentId) !== source.parentId) throw stale();
        const ownWindow = await api.windows.get(source.windowId, { populate: false });
        if (ownWindow?.id !== source.windowId) throw windowChanged();
        const { activeSpaces = {} } = await api.storage.session.get('activeSpaces');
        if (activeSpaces[source.windowId] && activeSpaces[source.windowId] !== source.spaceId) throw stale();
        currentSpace(source);
        return { bookmark, space };
    }
    async function liveTab(id, source) {
        const tab = await api.tabs.get(id);
        if (!tab || tab.windowId !== source.windowId) throw windowChanged();
        return tab;
    }
    async function run(source, index, key) {
        let created = null, bookmark, attemptTab = null, createIssued = false, attempts, prepared = false;
        try {
            ({ bookmark } = await validate(source));
            const bindings = await getBindings(), tabs = await api.tabs.query({ windowId: source.windowId });
            const candidates = tabs.filter(tab => tab.windowId === source.windowId && String(bindings[tab.id]?.bookmarkId) === source.bookmarkId);
            if (candidates.filter(tab => tab.pinned).length > 1) throw new Error('This bookmark has multiple Favorites in this window. Use the existing icons; no tab was changed.');
            if (source.tabId && candidates.some(tab => tab.pinned && tab.id !== source.tabId)) {
                throw new Error('This bookmark already has a Favorite in this window. Use its pinned tab; the dragged tab was left unchanged.');
            }
            let candidate = candidates.find(tab => tab.id === source.tabId) || candidates.find(tab => tab.pinned) || candidates[0];
            ({ favoriteDropAttempts: attempts = {} } = await api.storage.session.get('favoriteDropAttempts'));
            const attempt = knownCreations.get(key) || attempts[key];
            const saveAttempts = () => api.storage.session.set({ favoriteDropAttempts: attempts });
            if (!candidate && attempt) {
                if (!Number.isInteger(attempt.tabId)) throw new Error('An earlier Favorites attempt could not be verified. Check Favorites; no additional tab was opened.');
                // This is an exact creation receipt, never a URL match. If the
                // user closed/moved/unpinned it, do not silently create another.
                try { attemptTab = await api.tabs.get(attempt.tabId); }
                catch {
                    // Only a fresh all-window absence proves the old tab closed.
                    // A failed lookup alone does not authorize another create.
                    if ((await api.tabs.query({})).some(tab => tab.id === attempt.tabId)) throw windowChanged();
                    delete attempts[key]; knownCreations.delete(key); await saveAttempts();
                }
                if (attemptTab) {
                    if (attemptTab.windowId !== source.windowId || !attemptTab.pinned || (bindings[attemptTab.id]?.bookmarkId && String(bindings[attemptTab.id].bookmarkId) !== source.bookmarkId)) throw receiptChanged();
                    candidate = attemptTab;
                }
            }
            // A live source that lost its exact binding must not silently turn
            // into a new tab. A closed source may reuse another exact binding.
            if (source.tabId && candidate?.id !== source.tabId) throw stale();
            let space;
            ({ bookmark, space } = await validate(source)); // Never use the row's cached URL.
            if (attemptTab && attempt.url !== bookmark.url) throw new Error('The saved URL changed after the previous Favorite opened. Its tab was kept unchanged; no additional tab was opened.');
            let tab;
            if (candidate) {
                if (!attemptTab && String((await getBindings())[candidate.id]?.bookmarkId) !== source.bookmarkId) throw stale();
                tab = await liveTab(candidate.id, source);
                currentSpace(source);
                if (!tab.pinned && ![...space.spaceBookmarks, ...space.temporaryTabs].includes(tab.id)) throw stale();
                attempts[key] = { tabId: tab.id, url: bookmark.url };
                await saveAttempts();
                const validated = await validate(source);
                space = validated.space;
                if (attemptTab && attempt.url !== validated.bookmark.url) throw stale();
                const binding = (await getBindings())[tab.id];
                if (binding?.bookmarkId && String(binding.bookmarkId) !== source.bookmarkId) throw stale();
                tab = await liveTab(tab.id, source);
                currentSpace(source);
                if (!tab.pinned && ![...space.spaceBookmarks, ...space.temporaryTabs].includes(tab.id)) throw stale();
                if (!tab.pinned) tab = await api.tabs.update(tab.id, { pinned: true });
            } else {
                let url;
                try { url = new URL(bookmark.url); } catch { /* Reject malformed or executable links before any tab API. */ }
                if (!url || !['http:', 'https:'].includes(url.protocol)) throw new Error('This saved link cannot open in Favorites. Only http and https bookmarks are supported.');
                attempts[key] = { tabId: null, url: bookmark.url };
                await saveAttempts(); // Fail closed before creating if tracking is unavailable.
                prepared = true;
                ({ bookmark } = await validate(source));
                if (bookmark.url !== attempts[key].url) throw stale();
                currentSpace(source);
                createIssued = true;
                created = await api.tabs.create({ pinned: true, active: false, windowId: source.windowId, url: bookmark.url });
                if (!Number.isInteger(created?.id)) throw new Error('Chrome did not return the new tab identity. Check Favorites before trying again.');
                attempts[key] = { tabId: created.id, url: bookmark.url };
                knownCreations.set(key, attempts[key]);
                await saveAttempts();
                tab = created;
            }
            if (!tab?.pinned || tab.windowId !== source.windowId) throw windowChanged();
            const { bookmark: fresh } = await validate(source);
            if ((created && fresh.url !== bookmark.url) || (attemptTab && fresh.url !== attempt.url)) throw stale();
            tab = await liveTab(tab.id, source);
            if (!tab.pinned) throw windowChanged();
            if (created || attemptTab) await setBinding(tab.id, { bookmarkId: source.bookmarkId, pinnedUrl: bookmark.url });
            tab = await liveTab(tab.id, source);
            if (!tab.pinned) throw windowChanged();
            // Do not follow a tab to another window or focus it if it moved
            // while the request was pending. Chrome has no atomic tab CAS API.
            let warning = null;
            if (Number.isInteger(index) && index >= 0) {
                try {
                    if (String((await getBindings())[tab.id]?.bookmarkId) !== source.bookmarkId) throw stale();
                    tab = await liveTab(tab.id, source);
                    currentSpace(source);
                    if (!tab.pinned) throw windowChanged();
                    const moved = await api.tabs.move(tab.id, { index });
                    if (moved?.windowId !== source.windowId) throw windowChanged();
                } catch (error) { warning = `The tab is pinned, but its position could not be updated. ${error.message}`; }
            }
            tab = await liveTab(tab.id, source);
            if (!tab.pinned) throw windowChanged();
            await validate(source);
            // Keep the receipt for this browser session even after success. It
            // protects repeat drops if an unrelated writer loses the binding.
            attempts[key] = { tabId: tab.id, url: bookmark.url, complete: true };
            await saveAttempts();
            knownCreations.delete(key);
            return { tab, created: Boolean(created), warning };
        } catch (error) {
            // No rollback closes, moves, or activates a user's tab. A persisted
            // receipt lets a later drop finish the exact same operation safely.
            if (created?.id || attemptTab) throw new Error(`A pinned tab was opened, but adding it could not finish. Check Favorites before trying again. ${error.message}`);
            if (prepared && !createIssued) {
                delete attempts[key];
                await api.storage.session.set({ favoriteDropAttempts: attempts });
            }
            if (createIssued) throw new Error(`Chrome could not confirm the new Favorite. Check Favorites; another tab will not be opened automatically. ${error.message}`);
            throw error;
        }
    }
    return function addBookmarkFavorite(source, index = 0) {
        if (!source?.bookmarkId || !source.parentId || !Number.isInteger(source.windowId)) return Promise.reject(stale());
        const key = JSON.stringify([source.windowId, source.bookmarkId]);
        if (inFlight.has(key)) return inFlight.get(key);
        // Web Locks are origin-wide, including different sidebar documents.
        // Without them, fail before any mutation rather than risking duplicates.
        if (!locks?.request) return Promise.reject(new Error('Favorites could not acquire its safety lock. Reload the sidebar and try again.'));
        const pending = locks.request('arcify-native-favorite-drop', () => run(source, index, key)).finally(() => inFlight.delete(key));
        inFlight.set(key, pending);
        return pending;
    };
}
