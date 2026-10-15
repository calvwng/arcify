import { favoriteRequest } from './saved-favorites-ui.js';

const stale = () => new Error('The saved bookmark or its space changed. Refresh and drag it again.');
const windowChanged = () => new Error('The tab or sidebar window changed. Drag it again in its current window.');

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
export function createFavoritesDragSource({ document, getContext, selection = null }) {
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
            favoriteId: element.dataset.favoriteId || null, bookmarkId: element.dataset.bookmarkId || null, tabId: element.dataset.tabId ? Number(element.dataset.tabId) : null,
            kind: element.matches('.folder') ? 'folder' : native ? (element.dataset.favoriteId ? 'saved' : 'native') : element.dataset.bookmarkId ? 'bookmark' : 'live' };
        if (source.kind === 'bookmark' && selection) {
            const snapshot = selection.freeze(element);
            if (snapshot?.error) { source = null; return snapshot; }
            if (snapshot) {
                source.selectionSnapshot = snapshot;
                if (snapshot.entries.length > 1) {
                    source.kind = 'bookmarks';
                    source.bookmarks = snapshot.entries;
                }
            }
        } else selection?.clear();
        return { source };
    }
    function inspect() {
        if (!source) return { error: 'Drag saved bookmarks or a tab from this sidebar into Favorites.' };
        const { element } = source, context = getContext();
        const space = context.spaces.find(item => item.id === source.spaceId);
        if (!element.isConnected || !element.classList.contains('dragging') || document.querySelectorAll('.dragging').length !== 1 ||
            (source.selectionSnapshot && !selection.validate(source.selectionSnapshot)) ||
            context.windowId !== source.windowId || element.dataset.favoriteId !== (source.favoriteId || undefined) || element.dataset.bookmarkId !== (source.bookmarkId || undefined) ||
            (element.dataset.tabId ? Number(element.dataset.tabId) : null) !== source.tabId ||
            (!['native', 'saved'].includes(source.kind) && (space?.id !== context.activeSpaceId || space?.bookmarkFolderId !== source.bookmarkFolderId ||
                element.closest('.space')?.dataset.spaceId !== source.spaceId || parentId(element, space) !== source.parentId))) {
            return { error: 'The dragged item changed. Refresh and drag it again.' };
        }
        if (source.kind === 'folder') return { error: 'Favorites does not accept folders. Open the folder and select its bookmarks.' };
        if (source.kind === 'live' && !Number.isInteger(source.tabId)) return { error: 'This item cannot be added to Favorites.' };
        return { source, hint: source.kind === 'bookmarks'
            ? `Add ${source.bookmarks.length} bookmarks to Favorites in visible order. Opens or reuses pinned tabs; source bookmarks stay in their folders.`
            : source.kind === 'bookmark' && !source.tabId
            ? 'Opens a pinned tab in this window and saves a Favorite. Your saved bookmark stays in its folder.'
            : source.kind === 'saved' ? 'Reorder your saved Favorites across Spaces and windows.'
            : source.kind === 'native' ? 'Reorder browser pins. Right-click to keep one as a saved Favorite.' : 'Save this tab as a Favorite.' };
    }
    return { start, inspect, isBatch: () => source?.kind === 'bookmarks',
        take() { const result = inspect(); source = null; return result; }, clear() { source = null; } };
}

// Local provenance is checked immediately; authoritative bookmark, window and
// session validation runs again in the sole background writer.
export function createSavedBookmarkFavoriteDrop({ getContext, api = globalThis.chrome }) {
    return (source, beforeId = null) => {
        const context = getContext();
        const space = context.spaces.find(item => item.id === source.spaceId);
        if (!source.bookmarkId || !source.parentId || context.windowId !== source.windowId ||
            context.activeSpaceId !== source.spaceId || !space || space.bookmarkFolderId !== source.bookmarkFolderId) return Promise.reject(stale());
        const { windowId, spaceId, bookmarkFolderId, bookmarkId, parentId, tabId } = source;
        if (source.kind === 'bookmarks') {
            return favoriteRequest('addBookmarks', { windowId, spaceId, bookmarkFolderId, beforeId,
                bookmarks: source.bookmarks.map(({ bookmarkId, parentId, tabId }) => ({ bookmarkId, parentId, ...(tabId !== null ? { tabId } : {}) })) }, api);
        }
        return favoriteRequest('addBookmark', { windowId, spaceId, bookmarkFolderId, bookmarkId, parentId, ...(tabId ? { tabId } : {}), beforeId }, api);
    };
}

// Failure details come from the sole writer. Show every affected source ID so
// a partial result cannot be mistaken for an atomic success or retried blindly.
export function describeBookmarkBatchOutcome(batch) {
    if (!Array.isArray(batch?.entries)) return null;
    const groups = ['completed', 'failed', 'unattempted'].map(status => batch.entries.filter(entry => entry.status === status));
    const [completed, failed, unattempted] = groups;
    const summary = `${completed.length} completed, ${failed.length} failed, ${unattempted.length} not attempted.`;
    if (batch.complete) return `${summary} Source bookmarks stay in their folders.`;
    const details = [
        completed.length && `Completed bookmark IDs: ${completed.map(entry => entry.bookmarkId).join(', ')}.`,
        ...failed.map(entry => `Failed bookmark ${entry.bookmarkId}: ${entry.error || entry.code || 'The result could not be verified.'}`),
        unattempted.length && `Not attempted bookmark IDs: ${unattempted.map(entry => entry.bookmarkId).join(', ')}.`
    ].filter(Boolean).join(' ');
    return `${summary} ${details} Nothing was retried automatically. Check Favorites before trying again.`;
}
