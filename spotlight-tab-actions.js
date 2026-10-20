import { Utils } from './utils.js';
import { getSpaceBookmarkById } from './space-bookmarks.js';
import { projectTabTitle } from './tab-title-projection.js';
import { runTabMenuActionCore } from './tab-menu-actions.js';
import { copyExactTextOffscreen } from './url-copy.js';
import { readSpaceActionContext, fencedRead, readRoot, safeLive, locations, selectedSpace, currentUrl } from './spotlight-space-actions.js';
import { bridgeError } from './spotlight-bridge-protocol.js';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const stale = () => bridgeError('STALE_CONTEXT', 'The current tab, selected Space, or saved pin changed. Refresh Spotlight before trying again.');
const bookmarkData = node => node && ({ id: node.id, parentId: node.parentId, title: node.title, url: node.url });

// A separate wire context leaves spaceActionsV1's exact object schema untouched.
export function readTabActionContext(store, request, options = {}) {
    return readSpaceActionContext(store, request, { ...options, tabDetails: true });
}

function createGuard(store, request, beforeMutation) {
    const context = request.context, expected = context.tab;
    const trackedTabs = new Set([expected.id]);
    let copies = null;
    const ownEvent = transition => (kind, key, value) => {
        if (kind === 'tab') {
            if (key === 'onActivated') return transition.duplicateId && value?.tabId === transition.duplicateId && value?.windowId === context.windowId;
            return key === 'onUpdated' && transition.mutedCommitted && value[0] === expected.id
                && Object.keys(value[1] || {}).length === 1 && value[1]?.mutedInfo?.muted === request.muted;
        }
        if (kind === 'bookmark') {
            const saved = { ...expected.bookmark, ...(request.command === 'renameCurrentTab' ? { title: request.title.trim() } : { url: request.url }) };
            const changed = request.command === 'renameCurrentTab' ? 'title' : 'url';
            return transition.bookmarkCommitted && key === 'onChanged' && value[0] === expected.bookmark?.id
                && value[1]?.[changed] === saved[changed] && Object.keys(value[1]).every(field => ['title', 'url'].includes(field) && value[1][field] === saved[field]);
        }
        if (key === 'spaces') return transition.persistenceStarted && same(value.newValue, store.spaces);
        if (key === 'activeSpaces') return same(value.newValue, store.active);
        if (key === 'favoriteSession') return transition.persistenceStarted && same(value.newValue, store.favoriteStore?.state);
        const before = value.oldValue || {}, after = value.newValue || {};
        const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(id => !same(before[id], after[id]));
        const affected = expected.section === 'today' ? [expected.id] : (copies || []).map(([id]) => id);
        if (!changed.every(id => affected.includes(Number(id)))) return false;
        if (key === 'tabNameOverridesById' && transition.aliasesCommitted) return changed.every(id => expected.section === 'saved' ? after[id] === undefined
            : same(after[id] ?? null, transition.aliasState));
        return key === 'pinnedTabStatesById' && transition.bindingsCommitted && changed.every(id =>
            same(after[id], { ...before[id], pinnedUrl: request.command === 'editCurrentPinUrl' ? request.url : expected.bookmark.url }));
    };
    return async (transition = {}) => fencedRead(async () => {
        const space = await readRoot(store, context.windowId, context);
        const states = await Utils.getPinnedTabStates(), overrides = await Utils.getTabNameOverrides();
        let bookmark = null;
        if (expected.bookmark) {
            const { persistentFavorites = [] } = await chrome.storage.local.get('persistentFavorites');
            if ([...persistentFavorites, ...(store.favoriteStore?.items || [])].some(item => item.sourceBookmarkId === expected.bookmark.id)) throw stale();
            bookmark = await getSpaceBookmarkById(space, expected.bookmark.id);
            const saved = { ...expected.bookmark, ...(transition.bookmarkCommitted
                ? request.command === 'renameCurrentTab' ? { title: request.title.trim() } : { url: request.url } : {}) };
            if (!same(bookmarkData(bookmark), saved)) throw stale();
        }
        const knownTabs = await chrome.tabs.query({});
        const linked = expected.bookmark ? knownTabs.filter(tab => states[tab.id]?.bookmarkId === expected.bookmark.id) : [];
        const identities = linked.map(tab => [tab.id, tab.windowId]).sort((a, b) => a[0] - b[0]);
        if (expected.bookmark) {
            if (copies === null) copies = identities;
            else if (!same(copies, identities)) throw stale();
            transition.affected = copies.map(([id]) => id);
            for (const tab of linked) trackedTabs.add(tab.id);
            for (const id of new Set(linked.map(tab => tab.windowId))) {
                const window = await chrome.windows.get(id);
                if (window?.id !== id || window.type !== 'normal' || window.incognito || store.isTransientWindow?.(window.id)) throw stale();
            }
        }
        if (transition.duplicateId) trackedTabs.add(transition.duplicateId);
        await beforeMutation();
        const tabs = await chrome.tabs.query({});
        await beforeMutation();
        selectedSpace(store, context.windowId, context);
        const live = tabs.find(tab => tab.id === expected.id);
        const active = tabs.filter(tab => tab.windowId === context.windowId && tab.active);
        // Chrome activates its duplicate. Only that confirmed new identity may
        // replace the source as active, and the source must still be present.
        if (active.length !== 1 || ![expected.id, transition.duplicateId].includes(active[0].id)
            || !safeLive(store, live) || live.windowId !== context.windowId || currentUrl(live) !== expected.url) throw stale();
        const owned = locations(store, expected.id), section = expected.section === 'today' ? 'temporaryTabs' : 'spaceBookmarks';
        if (owned.length !== 1 || owned[0].space !== space || owned[0].section !== section
            || store.provisional?.has(expected.id) || store.recoveryCandidates?.has(expected.id)) throw stale();
        if (Boolean(live.mutedInfo?.muted) !== (transition.mutedCommitted ? request.muted : expected.muted)) throw stale();
        if (!expected.bookmark) {
            if (states[expected.id]?.bookmarkId || (transition.aliasesCommitted
                ? !same(overrides[expected.id] ?? null, transition.aliasState) : (overrides[expected.id]?.name || '') !== expected.alias)) throw stale();
            if (!transition.aliasesCommitted && projectTabTitle(live, { overrides }) !== expected.title) throw stale();
        } else {
            const current = tabs.filter(tab => states[tab.id]?.bookmarkId === expected.bookmark.id);
            if (!same(copies, current.map(tab => [tab.id, tab.windowId]).sort((a, b) => a[0] - b[0])) || !current.some(tab => tab.id === expected.id)) throw stale();
            for (const copy of current) {
                const membership = locations(store, copy.id);
                if (!safeLive(store, copy) || membership.length !== 1 || membership[0].space !== space || membership[0].section !== 'spaceBookmarks'
                    || store.provisional?.has(copy.id) || store.recoveryCandidates?.has(copy.id)
                    || states[copy.id]?.pinnedUrl !== (transition.bindingsCommitted && request.command === 'editCurrentPinUrl' ? request.url : expected.bookmark.url)
                    || transition.aliasesCommitted && overrides[copy.id] !== undefined) throw stale();
            }
            if (!transition.bookmarkCommitted && projectTabTitle(live, { overrides, bookmark, binding: states[live.id], isSpacePin: true }) !== expected.title) throw stale();
        }
        if (transition.duplicateId) {
            const duplicate = tabs.find(tab => tab.id === transition.duplicateId), membership = locations(store, transition.duplicateId);
            if (duplicate?.id === expected.id || !safeLive(store, duplicate) || duplicate.windowId !== context.windowId
                || states[duplicate.id]?.bookmarkId || overrides[duplicate.id] !== undefined
                || store.provisional?.has(duplicate.id) || store.recoveryCandidates?.has(duplicate.id)
                || (transition.membershipCommitted ? membership.length !== 1 || membership[0].space !== space || membership[0].section !== 'temporaryTabs' : membership.length !== 0)) throw stale();
        }
        return { space, live };
    }, { windowId: context.windowId, tabIds: trackedTabs, ownEvent: ownEvent(transition) });
}

// The bridge already owns the SpaceStore queue. Never dispatch the shared core
// through runTabMenuAction, which would deadlock that same queue.
export async function runTabAction(store, request, { beforeMutation = async () => {} } = {}) {
    const context = request.context, tab = context.tab, transition = {};
    const guard = createGuard(store, request, beforeMutation);
    await guard(transition);
    try {
        if (request.command === 'copyCurrentLink') {
            await copyExactTextOffscreen(tab.url, { beforeWrite: async () => { await guard(transition); transition.attempted = true; } });
            transition.committed = true;
            await guard(transition);
            return { tabId: tab.id, copied: true, url: tab.url };
        }
        const action = { renameCurrentTab: 'rename', editCurrentPinUrl: 'editUrl', duplicateCurrentTab: 'duplicate', setCurrentTabMuted: 'mute' }[request.command];
        if (!action) throw bridgeError('INVALID_REQUEST', 'Unsupported tab action.');
        const coreRequest = { action, windowId: context.windowId, spaceId: context.spaceId, bookmarkFolderId: context.bookmarkFolderId,
            tabId: tab.id, ...(tab.bookmark ? { bookmarkId: tab.bookmark.id, parentId: tab.bookmark.parentId } : {}),
            expected: tab.bookmark ? { title: tab.bookmark.title, url: tab.bookmark.url, parentId: tab.bookmark.parentId } : { url: tab.url, alias: tab.alias },
            ...(['rename', 'editUrl', 'mute'].includes(action) ? { value: action === 'rename' ? request.title : action === 'editUrl' ? request.url : request.muted } : {}) };
        const result = await runTabMenuActionCore(store, coreRequest, { beforeWrite: guard, transition });
        await guard(transition);
        if (action === 'duplicate') return result;
        if (action === 'mute') return { tabId: tab.id, muted: request.muted };
        return { tabId: tab.id, bookmarkId: tab.bookmark?.id || null,
            ...(action === 'rename' ? { title: request.title.trim() } : { url: request.url }) };
    } catch (error) {
        if (transition.committed) throw bridgeError('PARTIAL_COMMIT', `The tab action committed, but its final state could not be confirmed. Check Arcify before trying again. ${error.message}`);
        if (transition.attempted) throw bridgeError('UNCERTAIN_RESULT', `The tab action may have completed. Check Arcify before trying again. ${error.message}`);
        throw error;
    }
}
