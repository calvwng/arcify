import { getSpaceBookmarkFolder, getSpaceBookmarkById } from './space-bookmarks.js';
import { createFolder } from './folder-policy.js';
import { Utils } from './utils.js';
import { projectTabTitle } from './tab-title-projection.js';
import { hasNativeSplit } from './native-split-safety.js';
import { isStartupLauncherTab } from './startup-launcher-tab.js';
import { isPracticeUrl } from './tour-practice.js';
import { saveLiveSpacePin, removeSavedSpacePin } from './space-pin-actions.js';
import { bridgeError, isSafeUrl, isSpaceActionContext, isTabActionContext } from './spotlight-bridge-protocol.js';

const stale = () => bridgeError('STALE_CONTEXT', 'The current tab, selected Space, or saved pin changed. Refresh Spotlight before trying again.');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const text = value => typeof value === 'string' && value.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(value);
const currentUrl = tab => tab?.url || tab?.pendingUrl || '';
// Browser New Tab aliases can be Space-owned, but their renderer is a helper,
// not a content tab to pin or infer a previous-page action from.
export const isBrowserNewTab = url => ['chrome://newtab', 'chrome://newtab/'].includes(url.split(/[?#]/)[0]);
const safeLive = (store, tab) => tab && !tab.incognito && !tab.pinned && !hasNativeSplit(tab)
    && !store.isGlobalTab?.(tab.id) && !isStartupLauncherTab(tab) && !isPracticeUrl(currentUrl(tab))
    && !isBrowserNewTab(currentUrl(tab)) && isSafeUrl(currentUrl(tab)) && (!tab.pendingUrl || tab.pendingUrl === currentUrl(tab));
const locations = (store, id) => store.spaces.flatMap(space => ['temporaryTabs', 'spaceBookmarks'].flatMap(section =>
    (space[section] || []).flatMap(member => member === id ? [{ space, section }] : [])));
function selectedSpace(store, windowId, expected = null) {
    const found = store.spaces.filter(space => space.id === store.active[windowId]);
    if (found.length !== 1) throw stale();
    const space = found[0];
    if (!space.bookmarkFolderId || store.spaces.filter(candidate => candidate.bookmarkFolderId === space.bookmarkFolderId).length !== 1
        || expected && (space.id !== expected.spaceId || space.bookmarkFolderId !== expected.bookmarkFolderId)) throw stale();
    return space;
}
async function readRoot(store, windowId, expected) {
    const space = selectedSpace(store, windowId, expected);
    const window = await chrome.windows.get(windowId);
    if (window?.id !== windowId || window.type !== 'normal' || window.incognito) throw stale();
    const folder = await getSpaceBookmarkFolder(space);
    // A name-based lookup may not choose among duplicate Arcify roots.
    const roots = (await chrome.bookmarks.search({ title: 'Arcify' })).filter(node => !node.url);
    if (roots.length !== 1 || folder.parentId !== roots[0].id || folder.id !== space.bookmarkFolderId) throw stale();
    selectedSpace(store, windowId, expected);
    return space;
}
function sourceTab(store, tabs, windowId, tabId, expected) {
    const active = tabs.filter(tab => tab.windowId === windowId && tab.active);
    if (active.length !== 1 || active[0].id !== tabId || active[0].incognito) throw stale();
    selectedSpace(store, windowId, expected);
    return active[0];
}

// Scope the fence to one read boundary. Events arriving during awaited reads
// invalidate it, including revoke-and-repair with the same peer. It complements
// the persisted pairing check; it is never the source of pairing authority.
export async function fencedRead(operation, { windowId, tabIds = new Set(), ownEvent = () => false, watchTodayOrder = false, watchNativeOrder = false } = {}) {
    let changed = false;
    const cleanups = [];
    const watch = (event, callback) => {
        if (!event?.addListener || !event.removeListener) return;
        event.addListener(callback); cleanups.push(() => event.removeListener(callback));
    };
    const change = () => { changed = true; };
    watch(chrome.tabs?.onActivated, info => { if ((info.windowId === windowId || tabIds.has(info.tabId)) && !ownEvent('tab', 'onActivated', info)) change(); });
    for (const name of ['onUpdated', 'onRemoved', 'onAttached', 'onDetached'])
        watch(chrome.tabs?.[name], (...args) => { if (tabIds.has(args[0]) && !ownEvent('tab', name, args)) change(); });
    if (watchNativeOrder) {
        watch(chrome.windows?.onFocusChanged, change);
        for (const name of ['onCreated', 'onUpdated', 'onMoved', 'onRemoved']) watch(chrome.tabGroups?.[name], change);
        watch(chrome.tabs?.onMoved, (id, info) => { if ((info?.windowId === windowId || tabIds.has(id)) && !ownEvent('tab', 'onMoved', [id, info])) change(); });
        watch(chrome.tabs?.onCreated, tab => { if (tab.windowId === windowId) change(); });
    }
    watch(chrome.tabs?.onReplaced, (added, removed) => { if (tabIds.has(added) || tabIds.has(removed)) change(); });
    watch(chrome.windows?.onRemoved, change);
    for (const name of ['onChanged', 'onRemoved', 'onMoved', 'onCreated'])
        watch(chrome.bookmarks?.[name], (...args) => { if (!ownEvent('bookmark', name, args)) change(); });
    watch(chrome.storage?.onChanged, (changes, area) => {
        const fields = area === 'local' ? ['arcifyBridgePeerId', 'arcifyBridgePairingGeneration', 'pinnedTabStatesById', 'tabNameOverridesById', 'spaces', 'persistentFavorites', ...(watchTodayOrder ? ['todayOrderRepresentation'] : [])]
            : area === 'session' ? ['activeSpaces', 'favoriteSession'] : area === 'sync' && watchTodayOrder ? ['invertTabOrder'] : [];
        for (const key of fields) if (key in changes && !same(changes[key].oldValue, changes[key].newValue)
            && !ownEvent('storage', key, changes[key])) change();
    });
    const assertUnchanged = () => { if (changed) throw stale(); };
    try { const result = await operation(assertUnchanged); assertUnchanged(); return result; }
    finally { cleanups.forEach(cleanup => cleanup()); }
}

// Read-only entry, already inside SpaceStore.run(). A helper is an exact active
// source, but never an excuse to guess the previous content tab.
export async function readSpaceActionContext(store, { windowId, tabId }, { pairingGeneration = null, beforeReturn = async () => {}, tabDetails = false } = {}) {
    return fencedRead(async () => {
        const space = await readRoot(store, windowId);
        const states = await Utils.getPinnedTabStates(), overrides = await Utils.getTabNameOverrides();
        const binding = states[tabId];
        let bookmark = binding?.bookmarkId ? await getSpaceBookmarkById(space, binding.bookmarkId) : null;
        const favoriteSources = tabDetails ? await chrome.storage.local.get('persistentFavorites') : {};
        const protectedSource = tabDetails && bookmark && [...(favoriteSources.persistentFavorites || []), ...(store.favoriteStore?.items || [])]
            .some(item => item.sourceBookmarkId === bookmark.id);
        await beforeReturn();
        const tabs = await chrome.tabs.query({});
        await beforeReturn();
        const live = sourceTab(store, tabs, windowId, tabId);
        const context = { windowId, spaceId: space.id, bookmarkFolderId: space.bookmarkFolderId,
            pairingGeneration, sourceTabId: tabId, tab: null };
        if (!isSpaceActionContext(context)) throw stale();
        const owned = locations(store, tabId);
        if (protectedSource || !safeLive(store, live) || owned.length !== 1 || owned[0].space.id !== space.id
            || store.provisional?.has(tabId) || store.recoveryCandidates?.has(tabId)) return context;
        const saved = owned[0].section === 'spaceBookmarks';
        if (saved ? !bookmark || bookmark.id !== binding?.bookmarkId || binding.pinnedUrl !== bookmark.url : Boolean(binding?.bookmarkId)) return context;
        if (!saved) bookmark = null;
        const title = projectTabTitle(live, { overrides, binding, bookmark, isSpacePin: saved });
        if (!text(title) || bookmark && (!text(bookmark.title) || !isSafeUrl(bookmark.url))) return context;
        context.tab = { id: tabId, url: currentUrl(live), title, section: saved ? 'saved' : 'today',
            bookmark: bookmark ? { id: bookmark.id, parentId: bookmark.parentId, title: bookmark.title, url: bookmark.url } : null,
            ...(tabDetails ? { alias: saved ? '' : overrides[tabId]?.name || '', muted: Boolean(live.mutedInfo?.muted) } : {}) };
        return (tabDetails ? isTabActionContext : isSpaceActionContext)(context) ? context : { ...context, tab: null };
    }, { windowId, tabIds: new Set([tabId]) });
}

// Revalidate all original identity/metadata after queued bookmark/binding reads.
// The transition object describes only writes confirmed by this operation.
function createActionGuard(store, request, beforeMutation) {
    const context = request.context;
    let linkedCopies = null;
    const trackedTabs = new Set([context.sourceTabId]);
    // Chrome may deliver our own confirmed write event after its API promise.
    // Ignore only that exact new value; unrelated concurrent changes still fence.
    const ownEvent = transition => (kind, key, value) => {
        if (kind === 'bookmark') return key === 'onCreated' && transition.bookmarkId === value[0]
            || key === 'onRemoved' && transition.bookmarkRemoved && context.tab?.bookmark?.id === value[0];
        if (key === 'activeSpaces') return same(value.newValue, store.active);
        if (!transition.membershipCommitted && !transition.bindingCommitted && !transition.bindingsRemoved) return false;
        if (key === 'spaces') return transition.membershipCommitted && same(value.newValue, store.spaces);
        if (key === 'favoriteSession') return transition.membershipCommitted && same(value.newValue, store.favoriteStore?.state);
        const affected = request.command === 'pinCurrentTab' ? [context.sourceTabId] : transition.affected || [];
        if (!['pinnedTabStatesById', 'tabNameOverridesById'].includes(key)) return false;
        const before = value.oldValue || {}, after = value.newValue || {};
        const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(id => !same(before[id], after[id]));
        if (!changed.every(id => affected.includes(Number(id)))) return false;
        if (key === 'tabNameOverridesById') return transition.aliasesRemoved && changed.every(id => after[id] === undefined);
        if (request.command === 'pinCurrentTab') return transition.bindingCommitted && changed.every(id =>
            same(after[id], { bookmarkId: transition.bookmarkId, pinnedUrl: context.tab.url }));
        return transition.bindingsRemoved && changed.every(id => after[id] === undefined);
    };
    return async (transition = {}) => fencedRead(async () => {
        const space = await readRoot(store, request.windowId, context);
        const states = await Utils.getPinnedTabStates();
        if (context.tab?.bookmark) for (const [id, binding] of Object.entries(states))
            if (binding.bookmarkId === context.tab.bookmark.id) trackedTabs.add(Number(id));
        const overrides = await Utils.getTabNameOverrides();
        const expected = context.tab;
        let bookmark = null;
        if (expected?.bookmark) bookmark = await getSpaceBookmarkById(space, expected.bookmark.id);
        if (transition.bookmarkId) {
            const saved = await getSpaceBookmarkById(space, transition.bookmarkId);
            if (!saved || saved.parentId !== space.bookmarkFolderId || saved.url !== expected.url || saved.title !== expected.title) throw stale();
        }
        if (expected?.bookmark) {
            if (transition.bookmarkRemoved ? Boolean(bookmark) : !bookmark || !same({ id: bookmark.id, parentId: bookmark.parentId, title: bookmark.title, url: bookmark.url }, expected.bookmark)) throw stale();
        }
        // Resolve every exact linked window before the final native tab snapshot.
        // A closed stale binding is not a live copy, and is never URL-matched.
        const knownTabs = await chrome.tabs.query({});
        const linked = expected?.bookmark ? knownTabs.filter(tab => states[tab.id]?.bookmarkId === expected.bookmark.id
            || transition.bindingsRemoved && transition.affected?.includes(tab.id)) : [];
        const copyIdentity = linked.map(tab => [tab.id, tab.windowId]).sort((a, b) => a[0] - b[0]);
        if (expected?.bookmark) {
            if (linkedCopies === null) linkedCopies = copyIdentity;
            else if (!same(linkedCopies, copyIdentity)) throw stale();
            for (const windowId of new Set(linked.map(tab => tab.windowId))) {
                const window = await chrome.windows.get(windowId);
                if (window?.id !== windowId || window.type !== 'normal' || window.incognito) throw stale();
            }
        }
        await beforeMutation();
        const tabs = await chrome.tabs.query({});
        // Pairing is persisted authority, so revoke/re-pair must be rejected
        // even if its storage event has not arrived during the native read.
        await beforeMutation();
        const live = sourceTab(store, tabs, request.windowId, context.sourceTabId, context);
        if (!expected) return { space, live };
        if (!safeLive(store, live) || currentUrl(live) !== expected.url) throw stale();
        const section = transition.membershipCommitted ? request.command === 'pinCurrentTab' ? 'spaceBookmarks' : 'temporaryTabs'
            : expected.section === 'saved' ? 'spaceBookmarks' : 'temporaryTabs';
        const owned = locations(store, expected.id);
        if (owned.length !== 1 || owned[0].space !== space || owned[0].section !== section
            || store.provisional?.has(expected.id) || store.recoveryCandidates?.has(expected.id)) throw stale();
        if (expected.section === 'today') {
            const expectedBinding = transition.bindingCommitted ? transition.bookmarkId : null;
            if ((states[expected.id]?.bookmarkId || null) !== expectedBinding
                || expectedBinding && states[expected.id].pinnedUrl !== expected.url) throw stale();
            if (!transition.bindingCommitted && projectTabTitle(live, { overrides, isSpacePin: false }) !== expected.title) throw stale();
        } else {
            const currentCopies = tabs.filter(tab => states[tab.id]?.bookmarkId === expected.bookmark.id
                || transition.bindingsRemoved && transition.affected?.includes(tab.id));
            if (!same(linkedCopies, currentCopies.map(tab => [tab.id, tab.windowId]).sort((a, b) => a[0] - b[0]))) throw stale();
            for (const copy of currentCopies) {
                const membership = locations(store, copy.id);
                if (!safeLive(store, copy) || membership.length !== 1 || membership[0].space !== space || membership[0].section !== section
                    || store.provisional?.has(copy.id) || store.recoveryCandidates?.has(copy.id)) throw stale();
                if (transition.bindingsRemoved ? Boolean(states[copy.id]?.bookmarkId)
                    : states[copy.id]?.bookmarkId !== expected.bookmark.id || states[copy.id]?.pinnedUrl !== expected.bookmark.url) throw stale();
            }
            if (!currentCopies.some(copy => copy.id === expected.id)) throw stale();
        }
        return { space, live };
    }, { windowId: request.windowId, tabIds: trackedTabs, ownEvent: ownEvent(transition) });
}

export async function runSpaceAction(store, request, { beforeMutation = async () => {} } = {}) {
    const guard = createActionGuard(store, request, beforeMutation);
    const { space } = await guard();
    if (request.command === 'openSettings') {
        await guard();
        try {
            const tab = await chrome.tabs.create({ windowId: request.windowId, url: chrome.runtime.getURL('options.html'), active: true });
            if (!tab?.id) throw new Error('Chrome did not return the settings tab identity.');
            return { tabId: tab.id };
        } catch (error) {
            throw bridgeError('UNCERTAIN_RESULT', `The Arcify settings tab may have opened. Check this window before trying again. ${error.message}`);
        }
    }
    if (request.command === 'createSpaceFolder') {
        let attempted = false;
        try {
            const folder = await createFolder(space.bookmarkFolderId, space.bookmarkFolderId, request.title.trim(), {
                beforeWrite: async () => { await guard(); attempted = true; }
            });
            if (!folder?.id) throw new Error('Chrome did not return the new folder identity.');
            // The bookmark API is the commit. No ancillary Space persist is needed.
            return { folderId: folder.id };
        } catch (error) {
            if (attempted) throw bridgeError('UNCERTAIN_RESULT', `The folder may have been created. Check the Space before trying again. ${error.message}`);
            throw error;
        }
    }
    if (request.command === 'pinCurrentTab') return saveLiveSpacePin(store, { space, tabId: request.context.tab.id,
        title: request.context.tab.title, url: request.context.tab.url }, { beforeWrite: guard });
    if (request.command === 'removeCurrentPin') {
        const result = await removeSavedSpacePin(store, { getSpace: () => selectedSpace(store, request.windowId, request.context),
            bookmarkId: request.context.tab.bookmark.id }, { beforeWrite: guard, stopOnPartial: true });
        return { ...result, tabId: request.context.tab.id };
    }
    throw bridgeError('INVALID_REQUEST', 'Unsupported Space action.');
}

// Internal read/guard primitives shared by the separately negotiated tab actions.
export { readRoot, safeLive, locations, sourceTab, selectedSpace, currentUrl };
