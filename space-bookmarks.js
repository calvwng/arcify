import { Utils } from './utils.js';

export async function getSpaceBookmarkFolder(space) {
    if (!space?.bookmarkFolderId) throw new Error('This space has no bookmark folder association.');
    const [folder] = await chrome.bookmarks.get(space.bookmarkFolderId);
    if (!folder || folder.url) throw new Error('The bookmark folder for this space is unavailable.');
    const root = (await chrome.bookmarks.search({ title: 'Arcify' })).find(node => !node.url);
    if (!root || String(folder.parentId) !== String(root.id)) {
        throw new Error('The bookmark folder is no longer inside the Arcify folder.');
    }
    return folder;
}

export async function getSpaceBookmarkTree(space) {
    const folder = await getSpaceBookmarkFolder(space);
    const read = async node => ({
        ...node,
        children: await Promise.all((await chrome.bookmarks.getChildren(node.id)).map(child =>
            child.url ? Promise.resolve({ ...child }) : read(child)))
    });
    return read(folder);
}

export async function getSpaceBookmarkById(space, bookmarkId) {
    if (!bookmarkId) return null;
    const folder = await getSpaceBookmarkFolder(space);
    async function find(parentId) {
        for (const node of await chrome.bookmarks.getChildren(parentId)) {
            if (String(node.id) === String(bookmarkId)) return node.url ? node : null;
            if (!node.url) {
                const match = await find(node.id);
                if (match) return match;
            }
        }
        return null;
    }
    return find(folder.id);
}

// Removal callers keep this observation through their final native/ownership
// reads. Any ancestor may move during traversal, including away and back.
export function observeSpaceBookmarkRemoval() {
    const events = [chrome.bookmarks.onMoved, chrome.bookmarks.onRemoved, chrome.bookmarks.onChanged];
    if (events.some(event => !event?.addListener || !event.removeListener)) throw new Error('Bookmark change observation is unavailable.');
    let changed = false;
    const invalidate = () => { changed = true; };
    for (const event of events) event.addListener(invalidate);
    return {
        assertUnchanged() { if (changed) throw new Error('The saved pin bookmark context changed during removal.'); },
        stop() { for (const event of events) event.removeListener(invalidate); }
    };
}

export async function removeSpacePin(space, tab, { beforeWrite = null } = {}) {
    const storageEvent = tab.id ? chrome.storage.onChanged : null;
    if (tab.id && (!storageEvent?.addListener || !storageEvent.removeListener)) throw new Error('Saved pin binding observation is unavailable.');
    const observation = observeSpaceBookmarkRemoval();
    let changed = false;
    const bindingChanged = (changes, area) => {
        if (area === 'local' && changes.pinnedTabStatesById &&
            JSON.stringify(changes.pinnedTabStatesById.oldValue?.[tab.id]) !== JSON.stringify(changes.pinnedTabStatesById.newValue?.[tab.id])) changed = true;
    };
    const folderId = space?.bookmarkFolderId;
    storageEvent?.addListener(bindingChanged);
    let bookmarkId, removed = false;
    try {
        const binding = tab.id ? await Utils.getPinnedTabState(tab.id) : null;
        bookmarkId = tab.bookmarkId || binding?.bookmarkId;
        if (!bookmarkId) throw new Error('Cannot remove a favorite without its bookmark identity.');
        if (tab.id && binding?.bookmarkId !== bookmarkId) throw new Error('This tab now belongs to another saved pin.');
        const bookmark = await getSpaceBookmarkById(space, bookmarkId);
        if (tab.id && (await Utils.getPinnedTabState(tab.id))?.bookmarkId !== bookmarkId) throw new Error('This tab now belongs to another saved pin.');
        if (beforeWrite) await beforeWrite();
        observation.assertUnchanged();
        if (changed || space?.bookmarkFolderId !== folderId) throw new Error('The saved pin bookmark context changed during removal.');
        if (bookmark) {
            try { await chrome.bookmarks.remove(bookmark.id); }
            catch (error) {
                throw Object.assign(new Error(`The saved bookmark removal could not be confirmed. ${error.message} Check Pinned before trying again. Nothing was retried or recreated.`), { code: 'UNCERTAIN_RESULT' });
            }
            removed = true;
        }
    } finally {
        observation.stop();
        storageEvent?.removeListener(bindingChanged);
    }
    if (removed) {
        try { if (beforeWrite) await beforeWrite(); }
        catch (error) {
            throw Object.assign(new Error(`The saved pin was removed, but its live tab was not moved. ${error.message} Nothing was retried or recreated.`), { bookmarkRemoved: true });
        }
    }
    return { bookmarkId, removed };
}
