import { SpotlightArchiveActions, ARCHIVE_OPEN_TYPE } from './spotlight-archive-actions.js';
import { normalizeSpaceColor } from './space-colors.js';
import { createSidebarNewTabLauncher } from './sidebar-new-tab-launch.js';
import { isStartupLauncherTab } from './startup-launcher-tab.js';
import { ownerOf, tabIds } from './space-store.js';
import { getSpaceBookmarkById, getSpaceBookmarkTree } from './space-bookmarks.js';
import { Utils } from './utils.js';
import { projectTabTitle } from './tab-title-projection.js';
import { SIDEBAR_COMMAND_TYPE, createSidebarCommandHandler } from './sidebar-command.js';
import { registerSpotlightInvalidation } from './spotlight-invalidation.js';
import { readSpaceNavigationContext, runSpaceNavigation } from './spotlight-space-navigation.js';
import { readTabActionContext, runTabAction } from './spotlight-tab-actions.js';
import { readSpaceActionContext, runSpaceAction } from './spotlight-space-actions.js';
import { ARCHIVE_ACTIONS_FEATURE, SPACE_NAVIGATION_FEATURE, SPACE_NAVIGATION_COMMANDS, TAB_ACTIONS_FEATURE, TAB_ACTION_COMMANDS, SPACE_ACTIONS_FEATURE, SPACE_ACTION_COMMANDS, GLOBAL_FAVORITES_FEATURE, PAIRING_GENERATION_KEY, PEER_KEY, bridgeError, trustedSender, validateRequest, responseFor, sendBridgeRequest, isWindowId, isSafeUrl } from './spotlight-bridge-protocol.js';

const COMMANDS = ['archiveContext', 'reopenArchivedTab', 'hello', 'snapshot', 'activateSpace', 'activateTab', 'openTab', 'navigateTab', 'openBookmark', 'openFavorite', 'actionContext', 'tabActionContext', 'navigationContext', ...SPACE_NAVIGATION_COMMANDS, ...SPACE_ACTION_COMMANDS, ...TAB_ACTION_COMMANDS];
const JOURNAL_KEY = 'spotlightBridgeRequests';

// Only reads Arcify's authoritative model. Group IDs/names never enter the protocol.
export async function getBridgeSnapshot(store, windowId) {
    const window = await chrome.windows.get(windowId);
    if (window.incognito || window.type && window.type !== 'normal') throw bridgeError('INVALID_WINDOW', 'Choose a normal browser window.');
    return store.run(() => readBridgeSnapshot(store, windowId));
}

async function readBridgeSnapshot(store, windowId) {
    if (await store.discoverBookmarkSpaces()) await store.persist();
    // Reconcile ownership before projecting either Spaces or Favorites.
    const favorites = store.favoriteStore ? (await store.favoriteStore.read(windowId)).favorites : null;
    if (store.favoriteStore?.ownershipPersistence?.refresh) await store.favoriteStore.ownershipPersistence.refresh({
        state: store.favoriteStore.state, items: store.favoriteStore.items });
    const live = (await chrome.tabs.query({ windowId })).filter(tab => !isStartupLauncherTab(tab));
    const byId = new Map(live.map(tab => [tab.id, tab]));
    const [bindings, overrides] = await Promise.all([Utils.getPinnedTabStates(), Utils.getTabNameOverrides()]);
    const spaces = store.spaces.map(space => ({
        id: space.id, name: space.name, color: normalizeSpaceColor(space.color), bookmarkFolderId: space.bookmarkFolderId,
        tabIds: tabIds(space).filter(id => byId.has(id)),
        pinnedTabIds: space.spaceBookmarks.filter(id => byId.has(id)),
        temporaryTabIds: space.temporaryTabs.filter(id => byId.has(id))
    }));
    const bookmarks = [];
    const bookmarksByTab = new Map();
    const warnings = [];
    for (const space of store.spaces) {
        let tree;
        try { tree = await getSpaceBookmarkTree(space); }
        catch {
            warnings.push({ code: 'BOOKMARKS_UNAVAILABLE', spaceId: space.id,
                message: `Saved pins in “${space.name}” are unavailable. Check its Arcify bookmark folder.` });
            continue;
        }
        const collect = node => {
            if (node.url) {
                const boundIds = space.spaceBookmarks.filter(id => byId.has(id) && String(bindings[id]?.bookmarkId) === String(node.id));
                for (const id of boundIds) bookmarksByTab.set(id, node);
                bookmarks.push({ id: node.id, spaceId: space.id, title: node.title, url: node.url, tabId: boundIds[0] ?? null });
            }
            for (const child of node.children || []) collect(child);
        };
        collect(tree);
    }
    return { windowId, capturedAt: Date.now(), activeSpaceId: spaces.some(s => s.id === store.active[windowId])
        ? store.active[windowId] : ownerOf(store.spaces, live.find(t => t.active)?.id)?.id || spaces[0]?.id || null,
    // Keep auxiliary local icon bytes out of v1: older peers reject extra keys.
    spaces, bookmarks, warnings, ...(favorites ? { favorites: favorites
        .map(({ id, title, url, sourceBookmarkId, tabId }) => ({ id, title, url, sourceBookmarkId, tabId })) } : {}), tabs: live.map(tab => ({ id: tab.id, windowId, title: projectTabTitle(tab, {
        overrides, binding: bindings[tab.id], bookmark: bookmarksByTab.get(tab.id), isSpacePin: Boolean(ownerOf(store.spaces, tab.id)?.spaceBookmarks.includes(tab.id))
    }), url: tab.url || tab.pendingUrl || '',
        active: Boolean(tab.active), pinned: Boolean(tab.pinned), spaceId: ownerOf(store.spaces, tab.id)?.id || null })) };
}

// Use the same activate/assign operations as the sidebar; never replace stored spaces.
export async function runBridgeAction(store, request, snapshot, { beforeMutation = async () => {} } = {}) {
    const { command, windowId } = request;
    const spaceId = request.spaceId || snapshot.activeSpaceId;
    const findSpace = id => {
        const space = snapshot.spaces.find(s => s.id === id);
        if (!space) throw bridgeError('STALE_SPACE', 'This space no longer exists. Refresh Spotlight.');
        return space;
    };
    const findTab = id => {
        const tab = snapshot.tabs.find(t => t.id === id);
        if (!tab) throw bridgeError('STALE_TAB', 'This tab is no longer in the requested window. Refresh Spotlight.');
        return tab;
    };
    const focus = async tabId => {
        const tab = await chrome.tabs.get(tabId);
        if (tab.windowId !== windowId) throw bridgeError('STALE_TAB', 'This tab moved to another window.');
        await beforeMutation();
        await chrome.tabs.update(tabId, { active: true });
        await beforeMutation();
        await chrome.windows.update(windowId, { focused: true });
        return tabId;
    };
    if (command === 'activateSpace') {
        const space = findSpace(spaceId);
        await beforeMutation();
        await store.applyAction({ action: 'activate', windowId, spaceId });
        const stored = store.spaces.find(s => s.id === spaceId);
        const tabId = space.tabIds.includes(stored?.lastTab) ? stored.lastTab : space.tabIds.at(-1);
        // An empty space remains empty, and changes no other window's active state.
        if (tabId) await focus(tabId);
        return { ...(tabId ? { tabId } : {}) };
    }
    if (command === 'activateTab' || command === 'navigateTab') {
        const tab = findTab(request.tabId);
        if (command === 'activateTab') {
            if (tab.spaceId) { await beforeMutation(); await store.applyAction({ action: 'activate', windowId, spaceId: tab.spaceId }); }
            return { tabId: await focus(tab.id) };
        }
        const current = await chrome.tabs.get(tab.id);
        if (current.windowId !== windowId) throw bridgeError('STALE_TAB', 'This tab moved to another window.');
        await beforeMutation();
        await chrome.tabs.update(tab.id, { url: request.url });
        return { tabId: tab.id };
    }
    if (command === 'openFavorite') {
        if (!store.favoriteStore) throw bridgeError('UNSUPPORTED_COMMAND', 'This Arcify build does not support saved Favorites.');
        const tab = await store.favoriteStore.open(request.favoriteId, windowId, { beforeMutation });
        return { tabId: tab.id };
    }
    const space = findSpace(spaceId);
    let bookmark;
    if (command === 'openBookmark') {
        const stored = store.spaces.find(s => s.id === spaceId);
        bookmark = await getSpaceBookmarkById(stored, request.bookmarkId);
        if (!bookmark) throw bridgeError('STALE_BOOKMARK', 'This bookmark no longer belongs to this space.');
        if (!isSafeUrl(bookmark.url)) throw bridgeError('UNSUPPORTED_URL', 'This bookmark URL cannot be opened through Spotlight.');
        const bindings = await Utils.getPinnedTabStates();
        const existing = space.pinnedTabIds.find(id => String(bindings[id]?.bookmarkId) === String(bookmark.id));
        if (existing) {
            await beforeMutation();
            await store.applyAction({ action: 'activate', windowId, spaceId });
            return { tabId: await focus(existing) };
        }
    }
    // Create inactive first so the onActivated event cannot select an incidental opener's space.
    await beforeMutation();
    const tab = await chrome.tabs.create({ windowId, url: bookmark?.url || request.url, active: false });
    if (bookmark) {
        // Initialize the same exact-bookmark metadata as sidebar reopening before
        // publishing membership, so the first rendered row retains its saved name.
        if (bookmark.title && tab.title !== bookmark.title) {
            await Utils.setTabNameOverride(tab.id, bookmark.url, bookmark.title);
        }
        await Utils.setPinnedTabState(tab.id, { bookmarkId: bookmark.id, pinnedUrl: bookmark.url });
    }
    await store.applyAction({ action: 'assign', tabId: tab.id, spaceId, pinned: Boolean(bookmark), ...(!bookmark ? { newTodayTab: true } : {}) });
    await store.applyAction({ action: 'activate', windowId, spaceId });
    return { tabId: await focus(tab.id) };
}

export function createSpotlightBridge(store, archiveActions = new SpotlightArchiveActions(store)) {
    let chain = Promise.resolve();
    const handle = async (request, sender) => {
        const initialPairing = await chrome.storage.local.get([PEER_KEY, PAIRING_GENERATION_KEY]);
        const peerId = initialPairing[PEER_KEY], generation = initialPairing[PAIRING_GENERATION_KEY];
        const checkPairing = async () => {
            const latest = await chrome.storage.local.get([PEER_KEY, PAIRING_GENERATION_KEY]);
            if (!trustedSender(sender, latest[PEER_KEY]) || latest[PAIRING_GENERATION_KEY] !== generation)
                throw bridgeError('UNAUTHORIZED', 'The companion pairing changed.');
        };
        if (!trustedSender(sender, peerId)) throw bridgeError('UNAUTHORIZED', 'This extension is not paired with Arcify.');
        validateRequest(request, COMMANDS);
        const readOnly = ['hello', 'snapshot', 'actionContext', 'tabActionContext', 'navigationContext', 'archiveContext'].includes(request.command);
        const spaceAction = SPACE_ACTION_COMMANDS.includes(request.command);
        const tabAction = TAB_ACTION_COMMANDS.includes(request.command);
        const navigation = SPACE_NAVIGATION_COMMANDS.includes(request.command);
        const archiveAction = request.command === 'reopenArchivedTab';
        const contextualAction = spaceAction || tabAction || navigation || archiveAction;
        if ((archiveAction || request.command === 'archiveContext') && (!request.supportedFeatures?.includes(ARCHIVE_ACTIONS_FEATURE) || !archiveActions.supported()))
            throw bridgeError('UNSUPPORTED_FEATURE', 'Negotiate exact archive actions before sending this request.');
        if ((navigation || request.command === 'navigationContext') && !request.supportedFeatures?.includes(SPACE_NAVIGATION_FEATURE))
            throw bridgeError('UNSUPPORTED_FEATURE', 'Negotiate Space navigation before sending this request.');
        if ((tabAction || request.command === 'tabActionContext') && !request.supportedFeatures?.includes(TAB_ACTIONS_FEATURE))
            throw bridgeError('UNSUPPORTED_FEATURE', 'Negotiate tab actions before sending this request.');
        if ((spaceAction || request.command === 'actionContext') && !request.supportedFeatures?.includes(SPACE_ACTIONS_FEATURE))
            throw bridgeError('UNSUPPORTED_FEATURE', 'Negotiate Space actions before sending this request.');
        if (contextualAction && request.context.pairingGeneration !== (generation ?? null))
            throw bridgeError('UNAUTHORIZED', 'The companion pairing changed. Refresh Spotlight.');
        const requireFeatures = async () => {
            if (!request.supportedFeatures?.includes(GLOBAL_FAVORITES_FEATURE)
                && await store.favoriteStore?.requiresOrdinaryCapability?.()) {
                throw bridgeError('UNSUPPORTED_FEATURE', 'This Spotlight build cannot use ordinary Favorites. Update Spotlight before making workspace changes.');
            }
        };
        // Gate before the request journal, snapshot reconciliation, and action.
        // The old-client replay path must satisfy the same gate.
        await store.run(async () => { await checkPairing(); await requireFeatures(); });
        // A small session journal prevents repeated request IDs (including worker reloads)
        // from duplicating tabs. Pending outcomes are never replayed automatically.
        const { [JOURNAL_KEY]: journal = [] } = await chrome.storage.session.get(JOURNAL_KEY);
        const key = `${sender.id}:${generation ? `${generation}:` : ''}${request.requestId}`;
        const prior = journal.find(entry => entry.key === key);
        if (!readOnly && prior) {
            if (prior.fingerprint !== JSON.stringify(request)) throw bridgeError('INVALID_REQUEST', 'Request ID was reused with different data.');
            if (prior.response) {
                const snapshot = await getBridgeSnapshot(store, request.windowId);
                await checkPairing();
                return { ...prior.response, snapshot };
            }
            throw bridgeError('UNCERTAIN_RESULT', 'The previous action may have completed. Refresh before trying again.');
        }
        const snapshot = contextualAction ? null : await getBridgeSnapshot(store, request.windowId);
        await checkPairing();
        if (readOnly) {
            const archiveContext = request.command === 'archiveContext' ? await store.run(() => archiveActions.prepareUnlocked(request,
                { peerId, pairingGeneration: generation ?? null, beforeReturn: checkPairing })) : null;
            const navigationContext = request.command === 'navigationContext' ? await store.run(() => readSpaceNavigationContext(store, request,
                { pairingGeneration: generation ?? null, beforeReturn: checkPairing })) : null;
            const actionContext = request.command === 'actionContext' ? await store.run(() => readSpaceActionContext(store, request,
                { pairingGeneration: generation ?? null, beforeReturn: checkPairing })) : undefined;
            const tabActionContext = request.command === 'tabActionContext' ? await store.run(() => readTabActionContext(store, request,
                { pairingGeneration: generation ?? null, beforeReturn: checkPairing })) : undefined;
            await checkPairing();
            return responseFor(request, 'arcify', { ok: true, extensionId: chrome.runtime.id, snapshot,
                ...(archiveContext ? { archiveActions: archiveContext } : {}), ...(actionContext ? { actionContext } : {}), ...(tabActionContext ? { tabActionContext } : {}), ...(navigationContext || {}), ...(commandCapabilities(request, chrome, store)) });
        }
        const entry = { key, fingerprint: JSON.stringify(request) };
        const next = [...journal.slice(-99), entry];
        await chrome.storage.session.set({ [JOURNAL_KEY]: next });
        const data = await store.run(async () => {
            await checkPairing();
            await requireFeatures();
            // Serialize with native tab events and sidebar writes; validate again at execution.
            const snapshot = contextualAction ? null : await readBridgeSnapshot(store, request.windowId);
            // Capability checks may await storage too. Pairing must be the last
            // persisted authority read before the caller's mutation boundary.
            const beforeMutation = async () => { await requireFeatures(); await checkPairing(); };
            await beforeMutation();
            return archiveAction ? archiveActions.reopenUnlocked(request, { peerId, pairingGeneration: generation ?? null, beforeMutation }) : navigation ? runSpaceNavigation(store, request, { beforeMutation }) : tabAction ? runTabAction(store, request, { beforeMutation }) : spaceAction ? runSpaceAction(store, request, { beforeMutation })
                : runBridgeAction(store, request, snapshot, { beforeMutation });
        });
        if (contextualAction) {
            // Record a confirmed commit before the ancillary UI snapshot. Never
            // turn a refresh failure into permission to recreate a folder/pin.
            try {
                await checkPairing();
                entry.response = responseFor(request, 'arcify', { ok: true, ...data });
                await chrome.storage.session.set({ [JOURNAL_KEY]: next });
                const snapshot = await getBridgeSnapshot(store, request.windowId);
                await checkPairing();
                return { ...entry.response, snapshot };
            } catch (error) {
                throw bridgeError('PARTIAL_COMMIT', `The action committed, but its final confirmation or display refresh failed. Check Arcify before trying again. ${error.message}`);
            }
        }
        const response = responseFor(request, 'arcify', { ok: true, ...data, snapshot: await getBridgeSnapshot(store, request.windowId) });
        await checkPairing();
        // Do not retain a full browsing snapshot in the journal.
        entry.response = { ...response };
        delete entry.response.snapshot;
        await chrome.storage.session.set({ [JOURNAL_KEY]: next });
        return response;
    };
    return (request, sender) => {
        const pending = chain.then(() => handle(request, sender));
        chain = pending.catch(() => {});
        return pending.catch(error => responseFor(request, 'arcify', { ok: false,
            error: { code: error.code || 'FAILED', message: error.message || 'Arcify request failed.' } }));
    };
}

export function registerSpotlightBridge(store) {
    const invalidation = registerSpotlightInvalidation(store);
    const archiveActions = new SpotlightArchiveActions(store);
    const handle = createSpotlightBridge(store, archiveActions);
    const handleSidebar = createSidebarCommandHandler();
    const launchNewTab = createSidebarNewTabLauncher(store);
    chrome.runtime.onMessageExternal.addListener((request, sender, sendResponse) => {
        if (request?.type === ARCHIVE_OPEN_TYPE) return archiveActions.open(request, sender, sendResponse);
        if (request?.type === SIDEBAR_COMMAND_TYPE) return handleSidebar(request, sender, sendResponse);
        handle(request, sender).then(sendResponse);
        return true;
    });
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request?.type !== 'spotlightBridgeLaunch') return;
        if (request.fallbackToNewTab !== undefined) {
            launchNewTab(request, sender).then(sendResponse, error => sendResponse({ ok: false,
                error: { code: error.code || 'FAILED', message: error.message } }));
            return true;
        }
        (async () => {
            if (sender.id !== chrome.runtime.id || !isWindowId(request.windowId)) throw bridgeError('INVALID_REQUEST', 'Invalid launch context.');
            await chrome.windows.get(request.windowId);
            const { [PEER_KEY]: peerId } = await chrome.storage.local.get(PEER_KEY);
            const hello = await sendBridgeRequest(peerId, 'hello', { windowId: request.windowId });
            if (hello.extensionId !== peerId) throw bridgeError('INVALID_RESPONSE', 'Companion identity mismatch.');
            await sendBridgeRequest(peerId, 'launch', { windowId: request.windowId, mode: 'new-tab' });
            sendResponse({ ok: true });
        })().catch(error => sendResponse({ ok: false, error: { code: error.code || 'FAILED', message: error.message } }));
        return true;
    });
    archiveActions.install();
    return invalidation;
}

function commandCapabilities(request, browser, store) {
    return request.command === 'hello' ? { capabilities: [
        ...(typeof browser.sidePanel?.open === 'function' ? ['openSidebar'] : []),
        ...(store.archiveStore && request.supportedFeatures?.includes(ARCHIVE_ACTIONS_FEATURE) ? [ARCHIVE_ACTIONS_FEATURE] : []),
        ...(request.supportedFeatures?.includes(SPACE_ACTIONS_FEATURE) ? [SPACE_ACTIONS_FEATURE] : []),
        ...(request.supportedFeatures?.includes(SPACE_NAVIGATION_FEATURE) ? [SPACE_NAVIGATION_FEATURE] : []),
        ...(request.supportedFeatures?.includes(TAB_ACTIONS_FEATURE) ? [TAB_ACTIONS_FEATURE] : []),
        ...(store.favoriteStore ? ['persistentFavorites'] : []),
        ...(typeof store.favoriteStore?.requiresOrdinaryCapability === 'function' ? [GLOBAL_FAVORITES_FEATURE] : [])
    ] } : {};
}
