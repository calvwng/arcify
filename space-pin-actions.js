import { assertNotTransient, isTransientTab } from './transient-safety.js';
import { enqueueBookmarkOperation } from './bookmark-writer.js';
import { Utils } from './utils.js';
import { assertNotNativeSplit } from './native-split-safety.js';
import { getSpaceBookmarkById, observeSpaceBookmarkRemoval } from './space-bookmarks.js';

const partial = (message, error, code = 'PARTIAL_COMMIT') => Object.assign(new Error(`${message} ${error.message} Nothing was retried or recreated.`), { code });

// Internal operations: callers must hold SpaceStore.run(). The exact bookmark
// writer and binding lock are shared with the sidebar; neither operation may
// infer identity from a URL or dispatch back into the SpaceStore queue.
export async function saveLiveSpacePin(store, { space, tabId, title, url }, { beforeWrite } = {}) {
    const state = { bookmarkId: null, bindingCommitted: false, membershipCommitted: false };
    const guard = async () => {
        await beforeWrite?.(state);
        assertNotTransient(store, { tabId });
        const live = await chrome.tabs.get(tabId);
        assertNotTransient(store, { tab: live });
    };
    const children = await chrome.bookmarks.getChildren(space.bookmarkFolderId);
    const ids = children.map(node => String(node.id));
    try {
        const saved = await enqueueBookmarkOperation({ parents: [{ parentId: space.bookmarkFolderId,
            expectedCanonicalIds: ids, desiredCanonicalIds: [...ids, '$new'] }],
        relocation: { kind: 'create', parentId: space.bookmarkFolderId, title, url } }, { beforeWrite: guard });
        state.bookmarkId = saved.createdId;
    } catch (error) {
        if (error.moved || error.createdId) throw partial(error.createdId ? `The bookmark was saved (${error.createdId}), but its live-tab update was not completed.`
            : 'A bookmark change may have been applied. Check Pinned before trying again.', error, error.createdId ? 'PARTIAL_COMMIT' : 'UNCERTAIN_RESULT');
        throw error;
    }
    try {
        await Utils._serializePinnedStateOp(async () => {
            const states = await Utils.getPinnedTabStates();
            await guard();
            if (states[tabId]?.bookmarkId) throw new Error('This tab is already linked to a saved bookmark.');
            states[tabId] = { bookmarkId: state.bookmarkId, pinnedUrl: url };
            // No compensating write after a revoked pairing or uncertain commit.
            await Utils.savePinnedTabStates(states);
            state.bindingCommitted = true;
        });
        await guard();
        const beforeToday = space.temporaryTabs, beforePins = space.spaceBookmarks;
        space.temporaryTabs = beforeToday.filter(id => id !== tabId);
        space.spaceBookmarks = [...beforePins, tabId];
        store.rebaseSectionRanks?.(space, 'temporaryTabs', beforeToday);
        store.rebaseSectionRanks?.(space, 'spaceBookmarks', beforePins);
        state.membershipCommitted = true;
        // The bridge makes no native order/focus writes. A later normal group
        // reconciliation may apply the user's existing group-sync preference.
        await store.persist({ skipGroupSync: true, beforeWrite: guard });
        return { tabId, bookmarkId: state.bookmarkId };
    } catch (error) {
        throw partial(`The bookmark was saved (${state.bookmarkId}), but its live-tab update could not be fully confirmed. Check Pinned before trying again.`, error);
    }
}

// Shared Remove Pin semantics: delete one exact saved bookmark and keep all
// exact-linked live copies open as Today. The sidebar retains its established
// guarded rollback behavior; paired commands stop after a partial commit.
export async function removeSavedSpacePin(store, { getSpace, bookmarkId, parentId }, { beforeWrite = null, stopOnPartial = false } = {}) {
    const state = { bookmarkRemoved: false, bindingsRemoved: false, membershipCommitted: false, aliasesRemoved: false, affected: [] };
    const linked = new Set();
    const guard = async () => {
        getSpace();
        const states = await Utils.getPinnedTabStates();
        for (const [key, binding] of Object.entries(states)) if (binding.bookmarkId === bookmarkId) linked.add(Number(key));
        const tabs = await chrome.tabs.query({});
        for (const live of tabs) if (linked.has(live.id)) { assertNotTransient(store, { tab: live }); assertNotNativeSplit(live); }
        getSpace();
        await beforeWrite?.(state);
        for (const live of tabs) if (linked.has(live.id)) assertNotTransient(store, { tab: live });
    };
    // Folder ancestry and native ownership require separate asynchronous reads.
    // Observe bookmark changes across both so the final ownership check cannot
    // make an earlier ancestry read authoritative again. Watch all moves/removals
    // because an intermediate ancestor can change while the tree is traversed.
    const observation = observeSpaceBookmarkRemoval();
    try {
        await guard();
        const bookmark = await getSpaceBookmarkById(getSpace(), bookmarkId);
        if (!bookmark || bookmark.parentId !== parentId) throw new Error('This saved pin or its folder changed. Reopen its menu and try again.');
        // Recheck linked tabs after the bookmark reads (for example a new Split),
        // retaining the bookmark event fence through this final awaited guard.
        await guard();
        observation.assertUnchanged();
        try { await chrome.bookmarks.remove(bookmarkId); }
        catch (error) {
            if (stopOnPartial) throw partial('The saved bookmark removal could not be confirmed. Check Pinned before trying again.', error, 'UNCERTAIN_RESULT');
            throw error;
        }
    } finally {
        observation.stop();
    }
    state.bookmarkRemoved = true;
    try {
        await guard();
        const states = await Utils.getPinnedTabStates(), affected = [];
        const space = getSpace();
        for (const [key, binding] of Object.entries(states)) {
            const liveId = Number(key);
            if (binding.bookmarkId !== bookmarkId || store.isGlobalTab?.(liveId) || !space.spaceBookmarks.includes(liveId)) continue;
            let live;
            try { live = await chrome.tabs.get(liveId); } catch { continue; }
            if (!live.pinned && !live.incognito && !isTransientTab(store, live)) affected.push(liveId);
        }
        state.affected = affected;
        if (stopOnPartial) {
            await Utils._serializePinnedStateOp(async () => {
                const current = await Utils.getPinnedTabStates();
                await guard();
                for (const id of affected) {
                    if (current[id]?.bookmarkId !== bookmarkId) throw new Error('A live copy now belongs to another saved pin.');
                    delete current[id];
                }
                await Utils.savePinnedTabStates(current);
                state.bindingsRemoved = true;
                await guard();
            });
        } else {
            await Utils.removePinnedTabStates(affected, { beforeWrite: guard, expectedBookmarkId: bookmarkId });
            state.bindingsRemoved = true;
        }
        const beforePins = [...space.spaceBookmarks], beforeToday = [...space.temporaryTabs];
        for (const liveId of affected) {
            space.spaceBookmarks = space.spaceBookmarks.filter(member => member !== liveId);
            if (!space.temporaryTabs.includes(liveId)) space.temporaryTabs.push(liveId);
        }
        state.membershipCommitted = true;
        if (stopOnPartial) {
            store.rebaseSectionRanks?.(space, 'spaceBookmarks', beforePins);
            store.rebaseSectionRanks?.(space, 'temporaryTabs', beforeToday);
        }
        await Utils._serializeTabNameOp(async () => {
            const names = await Utils.getTabNameOverrides();
            await guard();
            for (const liveId of affected) delete names[liveId];
            await Utils.saveTabNameOverrides(names);
            state.aliasesRemoved = true;
        });
        await store.persist({ ...(stopOnPartial ? { skipGroupSync: true } : {}), beforeWrite: guard });
    } catch (error) {
        throw partial('The saved pin was removed, but its live display could not be fully refreshed.', error);
    }
    return { bookmarkId };
}
