import { isStartupLauncherTab } from './startup-launcher-tab.js';
import { ownerOf, tabIds } from './space-store.js';
import { getSpaceBookmarkById, getSpaceBookmarkTree } from './space-bookmarks.js';
import { Utils } from './utils.js';
import { PEER_KEY, bridgeError, trustedSender, validateRequest, responseFor, sendBridgeRequest, isWindowId, isSafeUrl } from './spotlight-bridge-protocol.js';

const COMMANDS = ['hello', 'snapshot', 'activateSpace', 'activateTab', 'openTab', 'navigateTab', 'openBookmark'];
const JOURNAL_KEY = 'spotlightBridgeRequests';

// Only reads Arcify's authoritative model. Group IDs/names never enter the protocol.
export async function getBridgeSnapshot(store, windowId) {
    const window = await chrome.windows.get(windowId);
    if (window.type && window.type !== 'normal') throw bridgeError('INVALID_WINDOW', 'Choose a normal browser window.');
    return store.run(() => readBridgeSnapshot(store, windowId));
}

async function readBridgeSnapshot(store, windowId) {
    if (await store.discoverBookmarkSpaces()) await store.persist();
    const live = (await chrome.tabs.query({ windowId })).filter(tab => !isStartupLauncherTab(tab));
    const byId = new Map(live.map(tab => [tab.id, tab]));
    const bindings = await Utils.getPinnedTabStates();
    const spaces = store.spaces.map(space => ({
        id: space.id, name: space.name, color: space.color, bookmarkFolderId: space.bookmarkFolderId,
        tabIds: tabIds(space).filter(id => byId.has(id)),
        pinnedTabIds: space.spaceBookmarks.filter(id => byId.has(id)),
        temporaryTabIds: space.temporaryTabs.filter(id => byId.has(id))
    }));
    const bookmarks = [];
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
            if (node.url) bookmarks.push({ id: node.id, spaceId: space.id, title: node.title, url: node.url,
                tabId: space.spaceBookmarks.find(id => byId.has(id) && String(bindings[id]?.bookmarkId) === String(node.id)) ?? null });
            for (const child of node.children || []) collect(child);
        };
        collect(tree);
    }
    return { windowId, capturedAt: Date.now(), activeSpaceId: spaces.some(s => s.id === store.active[windowId])
        ? store.active[windowId] : ownerOf(store.spaces, live.find(t => t.active)?.id)?.id || spaces[0]?.id || null,
    spaces, bookmarks, warnings, tabs: live.map(tab => ({ id: tab.id, windowId, title: tab.title || '', url: tab.url || tab.pendingUrl || '',
        active: Boolean(tab.active), pinned: Boolean(tab.pinned), spaceId: ownerOf(store.spaces, tab.id)?.id || null })) };
}

// Use the same activate/assign operations as the sidebar; never replace stored spaces.
export async function runBridgeAction(store, request, snapshot) {
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
        await chrome.tabs.update(tabId, { active: true });
        await chrome.windows.update(windowId, { focused: true });
        return tabId;
    };
    if (command === 'activateSpace') {
        const space = findSpace(spaceId);
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
            if (tab.spaceId) await store.applyAction({ action: 'activate', windowId, spaceId: tab.spaceId });
            return { tabId: await focus(tab.id) };
        }
        const current = await chrome.tabs.get(tab.id);
        if (current.windowId !== windowId) throw bridgeError('STALE_TAB', 'This tab moved to another window.');
        await chrome.tabs.update(tab.id, { url: request.url });
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
            await store.applyAction({ action: 'activate', windowId, spaceId });
            return { tabId: await focus(existing) };
        }
    }
    // Create inactive first so the onActivated event cannot select an incidental opener's space.
    const tab = await chrome.tabs.create({ windowId, url: bookmark?.url || request.url, active: false });
    if (bookmark) {
        // Initialize the same exact-bookmark metadata as sidebar reopening before
        // publishing membership, so the first rendered row retains its saved name.
        if (bookmark.title && tab.title !== bookmark.title) {
            await Utils.setTabNameOverride(tab.id, bookmark.url, bookmark.title);
        }
        await Utils.setPinnedTabState(tab.id, { bookmarkId: bookmark.id, pinnedUrl: bookmark.url });
    }
    await store.applyAction({ action: 'assign', tabId: tab.id, spaceId, pinned: Boolean(bookmark) });
    await store.applyAction({ action: 'activate', windowId, spaceId });
    return { tabId: await focus(tab.id) };
}

export function createSpotlightBridge(store) {
    let chain = Promise.resolve();
    const handle = async (request, sender) => {
        const { [PEER_KEY]: peerId } = await chrome.storage.local.get(PEER_KEY);
        if (!trustedSender(sender, peerId)) throw bridgeError('UNAUTHORIZED', 'This extension is not paired with Arcify.');
        validateRequest(request, COMMANDS);
        const readOnly = ['hello', 'snapshot'].includes(request.command);
        // A small session journal prevents repeated request IDs (including worker reloads)
        // from duplicating tabs. Pending outcomes are never replayed automatically.
        const { [JOURNAL_KEY]: journal = [] } = await chrome.storage.session.get(JOURNAL_KEY);
        const key = `${sender.id}:${request.requestId}`;
        const prior = journal.find(entry => entry.key === key);
        if (!readOnly && prior) {
            if (prior.fingerprint !== JSON.stringify(request)) throw bridgeError('INVALID_REQUEST', 'Request ID was reused with different data.');
            if (prior.response) return { ...prior.response, snapshot: await getBridgeSnapshot(store, request.windowId) };
            throw bridgeError('UNCERTAIN_RESULT', 'The previous action may have completed. Refresh before trying again.');
        }
        const snapshot = await getBridgeSnapshot(store, request.windowId);
        if (readOnly) return responseFor(request, 'arcify', { ok: true, extensionId: chrome.runtime.id, snapshot });
        const entry = { key, fingerprint: JSON.stringify(request) };
        const next = [...journal.slice(-99), entry];
        await chrome.storage.session.set({ [JOURNAL_KEY]: next });
        const data = await store.run(async () => {
            const settings = await chrome.storage.local.get(PEER_KEY);
            if (!trustedSender(sender, settings[PEER_KEY])) throw bridgeError('UNAUTHORIZED', 'The companion was unpaired.');
            // Serialize with native tab events and sidebar writes; validate again at execution.
            return runBridgeAction(store, request, await readBridgeSnapshot(store, request.windowId));
        });
        const response = responseFor(request, 'arcify', { ok: true, ...data, snapshot: await getBridgeSnapshot(store, request.windowId) });
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
    const handle = createSpotlightBridge(store);
    chrome.runtime.onMessageExternal.addListener((request, sender, sendResponse) => {
        handle(request, sender).then(sendResponse);
        return true;
    });
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request?.type !== 'spotlightBridgeLaunch') return;
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
}
