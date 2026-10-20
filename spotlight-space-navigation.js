import { getSpaceBookmarkFolder, getSpaceBookmarkById } from './space-bookmarks.js';
import { readSpaceActionContext, fencedRead, isBrowserNewTab } from './spotlight-space-actions.js';
import { moveTodayTabsToSpaceCore } from './today-move-store.js';
import { readTodayOrderInverted } from './today-order.js';
import { Utils } from './utils.js';
import { projectTabTitle } from './tab-title-projection.js';
import { hasNativeSplit } from './native-split-safety.js';
import { isStartupLauncherTab } from './startup-launcher-tab.js';
import { isPracticeUrl } from './tour-practice.js';
import { bridgeError, isSafeUrl } from './spotlight-bridge-protocol.js';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const stale = () => bridgeError('STALE_CONTEXT', 'The source tab or chosen Space changed. Refresh Spotlight and choose again.');
const url = tab => tab?.url || tab?.pendingUrl || '';
const locations = (store, id) => store.spaces.flatMap(space => ['temporaryTabs', 'spaceBookmarks'].flatMap(section =>
    (space[section] || []).flatMap(member => member === id ? [{ space, section }] : [])));
const safeTab = (store, tab) => tab && !tab.incognito && !tab.pinned && !hasNativeSplit(tab)
    && !store.isTransientTab?.(tab) && !store.isGlobalTab?.(tab) && !store.isGlobalTab?.(tab.id) && !isStartupLauncherTab(tab)
    && !isPracticeUrl(url(tab)) && !isBrowserNewTab(url(tab)) && isSafeUrl(url(tab))
    && (!tab.pendingUrl || tab.pendingUrl === url(tab)) && !store.provisional?.has(tab.id) && !store.recoveryCandidates?.has(tab.id);
function exactSpace(store, identity) {
    const matches = store.spaces.filter(space => space.id === identity.spaceId);
    if (matches.length !== 1 || matches[0].bookmarkFolderId !== identity.bookmarkFolderId
        || store.spaces.filter(space => space.bookmarkFolderId === identity.bookmarkFolderId).length !== 1) throw stale();
    return matches[0];
}
async function root(store, identity) {
    const space = exactSpace(store, identity), folder = await getSpaceBookmarkFolder(space);
    const roots = (await chrome.bookmarks.search({ title: 'Arcify' })).filter(node => !node.url);
    if (roots.length !== 1 || folder.id !== identity.bookmarkFolderId || folder.parentId !== roots[0].id) throw stale();
    return exactSpace(store, identity);
}
const identity = space => ({ spaceId: space.id, bookmarkFolderId: space.bookmarkFolderId });

// A new capability/read shape; spaceActionsV1 context and all legacy snapshots are unchanged.
export async function readSpaceNavigationContext(store, request, options = {}) {
    return fencedRead(async () => {
        const actionContext = await readSpaceActionContext(store, request, options);
        const destinations = [];
        for (const candidate of store.spaces) {
            if (candidate.id === actionContext.spaceId) continue;
            try {
                const space = await root(store, identity(candidate));
                if (typeof space.name === 'string' && space.name.length <= 1024 && !/[\x00-\x1f\x7f]/.test(space.name))
                    destinations.push({ ...identity(space), name: space.name });
            } catch { /* An ambiguous or missing bookmark root is never a choice. */ }
        }
        const inverted = Boolean(await readTodayOrderInverted());
        const tabs = await chrome.tabs.query({ windowId: request.windowId });
        await options.beforeReturn?.();
        const active = tabs.filter(tab => tab.active);
        if (active.length !== 1 || active[0].id !== request.tabId || !url(active[0]) || url(active[0]).length > 16384
            || active[0].pendingUrl && active[0].pendingUrl !== url(active[0])) throw stale();
        return { actionContext, navigationContext: { destinations, inverted, sourceUrl: url(active[0]) } };
    }, { windowId: request.windowId, tabIds: new Set([request.tabId]), watchTodayOrder: true });
}

// This guard knows only exact state changes staged/confirmed by this operation.
// It never treats an arbitrary currently selected Space as an authorized transition.
function createGuard(store, request, beforeMutation) {
    const context = request.context, originalActive = structuredClone(store.active);
    if (originalActive[request.windowId] !== context.spaceId) throw stale();
    const destinationActive = { ...originalActive, [request.windowId]: request.destination.spaceId };
    const tracked = new Set([context.sourceTabId]);
    const transition = { membershipStaged: false, selectionStaged: false, focusCommitted: false, focus: null };
    let expectedSpaces = null;
    const ownEvent = (kind, key, value) => {
        if (kind === 'tab') return key === 'onActivated' && transition.focusCommitted
            && value.windowId === request.windowId && value.tabId === transition.focus?.id;
        if (kind !== 'storage') return false;
        if (key === 'activeSpaces') return transition.selectionStaged && same(value.newValue, destinationActive);
        if (key === 'spaces') return expectedSpaces !== null && same(value.newValue, expectedSpaces);
        if (key === 'favoriteSession') return transition.selectionStaged && same(value.newValue, store.favoriteStore?.state);
        return false;
    };
    async function metadata(tab, expected, space, states, overrides) {
        if (!safeTab(store, tab) || url(tab) !== expected.url) throw stale();
        const owners = locations(store, tab.id), section = expected.section === 'today' ? 'temporaryTabs' : 'spaceBookmarks';
        if (owners.length !== 1 || owners[0].space !== space || owners[0].section !== section) throw stale();
        const binding = states[tab.id];
        const bookmark = expected.bookmark ? await getSpaceBookmarkById(space, expected.bookmark.id) : null;
        if (expected.bookmark ? !bookmark || !same({ id: bookmark.id, parentId: bookmark.parentId, title: bookmark.title, url: bookmark.url }, expected.bookmark)
            || binding?.bookmarkId !== bookmark.id || binding.pinnedUrl !== bookmark.url : Boolean(binding?.bookmarkId)) throw stale();
        if (projectTabTitle(tab, { overrides, binding, bookmark, isSpacePin: expected.section === 'saved' }) !== expected.title) throw stale();
    }
    const guard = async () => fencedRead(async () => {
        const source = await root(store, context), target = await root(store, request.destination);
        const window = await chrome.windows.get(request.windowId);
        if (window?.id !== request.windowId || window.type !== 'normal' || window.incognito || store.isTransientWindow?.(window.id)) throw stale();
        const states = await Utils.getPinnedTabStates(), overrides = await Utils.getTabNameOverrides();
        if (request.command === 'moveCurrentTodayTab' && Boolean(await readTodayOrderInverted()) !== request.inverted) throw stale();
        await beforeMutation();
        const tabs = await chrome.tabs.query({});
        const sourceTab = tabs.find(tab => tab.id === context.sourceTabId);
        const active = tabs.filter(tab => tab.windowId === request.windowId && tab.active);
        const activeId = transition.focusCommitted ? transition.focus.id : context.sourceTabId;
        if (!sourceTab || sourceTab.windowId !== request.windowId || sourceTab.incognito || url(sourceTab) !== request.sourceUrl
            || sourceTab.pendingUrl && sourceTab.pendingUrl !== request.sourceUrl || sourceTab.status === 'loading' || active.length !== 1 || active[0].id !== activeId) throw stale();
        if (context.tab) await metadata(sourceTab, context.tab, transition.membershipStaged ? target : source, states, overrides);
        if (transition.focus) {
            const focusTab = tabs.find(tab => tab.id === transition.focus.id);
            if (focusTab?.windowId !== request.windowId) throw stale();
            await metadata(focusTab, transition.focus, target, states, overrides);
        }
        // Every awaited metadata/native read is covered by an event fence and a
        // final persisted pairing check, including revoke-and-repair races.
        const freshTabs = await chrome.tabs.query({});
        for (const id of tracked) {
            const before = tabs.filter(tab => tab.id === id), after = freshTabs.filter(tab => tab.id === id);
            if (before.length !== 1 || after.length !== 1 || !same(before[0], after[0])) throw stale();
        }
        const freshActive = freshTabs.filter(tab => tab.windowId === request.windowId && tab.active);
        if (freshActive.length !== 1 || freshActive[0].id !== activeId) throw stale();
        if (request.command === 'moveCurrentTodayTab' && Boolean(await readTodayOrderInverted()) !== request.inverted) throw stale();
        await beforeMutation();
        exactSpace(store, context); exactSpace(store, request.destination);
        if (!same(store.active, transition.selectionStaged ? destinationActive : originalActive)) throw stale();
        if (expectedSpaces && !same(store.spaces, expectedSpaces)) throw stale();
        return { source, target, tabs, states, overrides };
    }, { windowId: request.windowId, tabIds: tracked, ownEvent, watchTodayOrder: request.command === 'moveCurrentTodayTab' });
    return { guard, transition, stageSpaces() { expectedSpaces = structuredClone(store.spaces); }, async chooseFocus() {
        const { target, tabs, states, overrides } = await guard();
        const ids = [...target.spaceBookmarks, ...target.temporaryTabs].filter(id => tabs.some(tab => tab.id === id && tab.windowId === request.windowId && !isStartupLauncherTab(tab)));
        const tabId = ids.includes(target.lastTab) ? target.lastTab : ids.at(-1);
        if (!tabId) return;
        const tab = tabs.find(tab => tab.id === tabId), binding = states[tabId];
        const saved = target.spaceBookmarks.includes(tabId);
        const bookmark = saved && binding?.bookmarkId ? await getSpaceBookmarkById(target, binding.bookmarkId) : null;
        transition.focus = { id: tabId, url: url(tab), title: projectTabTitle(tab, { overrides, binding, bookmark, isSpacePin: saved }),
            section: saved ? 'saved' : 'today', bookmark: bookmark ? { id: bookmark.id, parentId: bookmark.parentId, title: bookmark.title, url: bookmark.url } : null };
        if (saved && !bookmark) throw stale();
        tracked.add(tabId); await guard();
    } };
}

// Called only from the bridge's existing SpaceStore.run() queue.
export async function runSpaceNavigation(store, request, { beforeMutation = async () => {} } = {}) {
    const { guard, transition, stageSpaces, chooseFocus } = createGuard(store, request, beforeMutation);
    await guard();
    if (request.command === 'moveCurrentTodayTab') {
        try {
            await moveTodayTabsToSpaceCore(store, { windowId: request.windowId, spaceId: request.context.spaceId,
                bookmarkFolderId: request.context.bookmarkFolderId, destinationSpaceId: request.destination.spaceId,
                destinationBookmarkFolderId: request.destination.bookmarkFolderId, inverted: request.inverted,
                entries: [{ tabId: request.context.sourceTabId, url: request.context.tab.url }] }, {
                skipGroupSync: true, getOrder: readTodayOrderInverted,
                beforeMutation: async ({ membershipStaged }) => {
                    if (membershipStaged && !transition.membershipStaged) { transition.membershipStaged = true; stageSpaces(); }
                    await guard();
                }
            });
            return { tabId: request.context.sourceTabId, spaceId: request.destination.spaceId };
        } catch (error) {
            if (error.batch?.uncertain || error.batch?.completed.length)
                throw bridgeError('PARTIAL_COMMIT', `The tab may have moved. Check both Spaces before trying again. ${error.message}`);
            throw error;
        }
    }
    if (request.command !== 'switchSpace') throw bridgeError('INVALID_REQUEST', 'Unsupported Space navigation.');
    await chooseFocus();
    const previousActive = structuredClone(store.active);
    let attempted = false;
    try {
        store.active = { ...store.active, [request.windowId]: request.destination.spaceId };
        transition.selectionStaged = true; stageSpaces();
        await store.persist({ skipGroupSync: true, beforeWrite: async () => { await guard(); attempted = true; } });
        await guard();
        if (transition.focus) {
            await guard();
            await chrome.tabs.update(transition.focus.id, { active: true });
            transition.focusCommitted = true;
            await guard();
            await chrome.windows.update(request.windowId, { focused: true });
            await guard();
        }
        return { spaceId: request.destination.spaceId, tabId: transition.focus?.id ?? null };
    } catch (error) {
        store.initialized = false;
        if (!attempted) store.active = previousActive;
        else throw bridgeError('PARTIAL_COMMIT', `The Space may have switched. Check Arcify before trying again. ${error.message}`);
        throw error;
    }
}
