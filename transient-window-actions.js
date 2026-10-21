import { getSpaceBookmarkFolder } from './space-bookmarks.js';
import { Utils } from './utils.js';
import { assertNotNativeSplit } from './native-split-safety.js';
import { isTransientUrl } from './spotlight-bridge-protocol.js';

export const TRANSIENT_CONTROL_TYPE = 'arcifyTransientWindow';
const positive = value => Number.isSafeInteger(value) && value > 0;
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 200;
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const exact = (value, keys) => value && !Array.isArray(value) && typeof value === 'object'
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

async function destinationSpace(store, request) {
    const matches = store.spaces.filter(space => space.id === request.spaceId);
    const space = matches[0];
    if (matches.length !== 1 || space.bookmarkFolderId !== request.bookmarkFolderId
        || store.spaces.filter(item => item.bookmarkFolderId === request.bookmarkFolderId).length !== 1)
        fail('STALE_SPACE', 'That Space changed. Refresh the choices and choose again.');
    const folder = await getSpaceBookmarkFolder(space);
    const roots = (await chrome.bookmarks.search({ title: 'Arcify' })).filter(node => !node.url);
    if (roots.length !== 1 || folder.parentId !== roots[0].id || folder.id !== request.bookmarkFolderId
        || store.spaces.find(item => item.id === request.spaceId) !== space)
        fail('STALE_SPACE', 'That Space bookmark folder changed. Refresh the choices.');
    return space;
}

/** Queue-owned adapter. Only this exact transaction may admit a quarantined ID. */
export function createTransientOwnershipCommit(store) {
    async function validate(tab, request, assigned = false) {
        const space = await destinationSpace(store, request);
        const binding = await Utils.getPinnedTabState(tab.id);
        const destination = await chrome.windows.get(request.windowId);
        if (destination.id !== request.windowId || destination.type !== 'normal' || destination.incognito
            || store.isTransientWindow?.(request.windowId)) fail('STALE_WINDOW', 'Choose an ordinary browser window.');
        const live = await chrome.tabs.get(tab.id);
        assertNotNativeSplit(live);
        if (live.id !== request.tabId || live.incognito || live.pinned || binding?.bookmarkId || store.isGlobalTab?.(live)
            || assigned && live.windowId !== request.windowId)
            fail('STALE_TAB', 'The temporary page changed. Check the page before trying again.');
        const owners = store.spaces.flatMap(candidate => ['spaceBookmarks', 'temporaryTabs'].flatMap(section =>
            (candidate[section] || []).filter(id => id === live.id).map(() => ({ space: candidate, section }))));
        if (assigned ? owners.length !== 1 || owners[0].space !== space || owners[0].section !== 'temporaryTabs'
            : owners.length !== 0) fail('STALE_TAB', 'This page already has an Arcify owner. Refresh its state.');
        return { tab: live, space };
    }
    const commit = async (tab, request) => {
        // No bookmark/Favorite writes and no URL-based lookup. The move has
        // already happened; any failure keeps the same native page quarantined.
        const { space } = await validate(tab, request);
        if (tab.windowId !== request.windowId) fail('STALE_TAB', 'The moved page is no longer in the selected window.');
        await store.readTodayPlacement();
        const latest = await validate(tab, request);
        if (latest.tab.windowId !== request.windowId) fail('STALE_TAB', 'The page moved again before it could be filed.');
        store.forgetTab(tab.id);
        store.insertCreatedToday(space, latest.tab);
        space.lastTab = tab.id;
        store.active[request.windowId] = space.id;
        await store.persist({ beforeWrite: () => validate(tab, request, true) });
        await validate(tab, request, true);
        const saved = await chrome.storage.local.get(['spaces', 'spaceTabSnapshot']);
        const owners = (saved.spaces || []).flatMap(candidate => ['spaceBookmarks', 'temporaryTabs'].flatMap(section =>
            (candidate[section] || []).filter(id => id === tab.id).map(() => ({ space: candidate, section }))));
        const records = (saved.spaceTabSnapshot || []).filter(item => item.tabId === tab.id);
        if (owners.length !== 1 || owners[0].space.id !== request.spaceId
            || owners[0].space.bookmarkFolderId !== request.bookmarkFolderId || owners[0].section !== 'temporaryTabs'
            || records.length !== 1 || records[0].spaceId !== request.spaceId || records[0].section !== 'temporaryTabs')
            fail('PARTIAL_COMMIT', 'The page moved, but its saved Space membership was not confirmed. Check the destination window.');
        return { tabId: tab.id, windowId: request.windowId, spaceId: space.id };
    };
    commit.validate = (tab, request) => validate(tab, request);
    return commit;
}

/** Recovery binds a chosen native ID only; it grants no Space/Favorite owner. */
export function createTransientRecoverySelectionValidator(store) {
    return async (tab, request) => {
        const binding = await Utils.getPinnedTabState(tab.id);
        const live = await chrome.tabs.get(tab.id);
        assertNotNativeSplit(live);
        const owned = store.spaces.some(space => ['spaceBookmarks', 'temporaryTabs']
            .some(section => (space[section] || []).includes(live.id)));
        const favoriteState = store.favoriteStore?.state;
        const favoriteClaim = [...(favoriteState?.bindings || []), ...(favoriteState?.attempts || [])]
            .some(item => item.tabId === live.id);
        if (live.id !== request.tabId || live.windowId !== request.windowId || live.incognito !== false || live.pinned !== false
            || !isTransientUrl(live.url || live.pendingUrl) || live.pendingUrl && !isTransientUrl(live.pendingUrl)
            || binding?.bookmarkId || owned || favoriteClaim || store.isGlobalTab?.(live))
            fail('STALE_RECOVERY_SELECTION', 'Choose an unowned, unpinned web page still in this restored Little Arc window.');
        return live;
    };
}

async function verifyController(store, request, sender) {
    const page = chrome.runtime.getURL('transient-window.html');
    if (sender?.id !== chrome.runtime.id || sender.frameId && sender.frameId !== 0
        || sender.documentLifecycle && sender.documentLifecycle !== 'active'
        || !positive(sender.tab?.id) || !positive(sender.tab?.windowId)
        || sender.origin && sender.origin !== chrome.runtime.getURL('').replace(/\/$/, '')
        || sender.url !== `${page}?token=${encodeURIComponent(request.token)}`)
        fail('UNAUTHORIZED', 'Use the Little Arc control tab for this window.');
    const record = (await store.transientWindows.listUnlocked()).find(item => item.token === request.token);
    const live = await chrome.tabs.get(sender.tab.id);
    if (!record || record.controllerTabId !== sender.tab.id || record.windowId !== sender.tab.windowId
        || live.windowId !== record.windowId || live.url !== sender.url
        || live.pendingUrl && live.pendingUrl !== sender.url || live.incognito)
        fail('STALE_WINDOW', 'This Little Arc control tab is no longer attached to its window.');
    return record;
}

export function createTransientControlHandler(store) {
    const commitOwnership = createTransientOwnershipCommit(store);
    const validateSelection = createTransientRecoverySelectionValidator(store);
    return (request, sender) => store.run(async () => {
        if (!store.transientWindows || !text(request?.token) || request.type !== TRANSIENT_CONTROL_TYPE
            || !['context', 'recover', 'promote'].includes(request.action)) fail('INVALID_REQUEST', 'Invalid temporary-window request.');
        const fields = request.action === 'context' ? ['type', 'action', 'token']
            : request.action === 'recover' ? ['type', 'action', 'token', 'tabId']
                : ['type', 'action', 'token', 'tabId', 'windowId', 'spaceId', 'bookmarkFolderId'];
        if (!exact(request, fields) || request.action !== 'context' && !positive(request.tabId)
            || request.action === 'promote' && (!positive(request.windowId) || !text(request.spaceId) || !text(request.bookmarkFolderId)))
            fail('INVALID_REQUEST', 'Choose the exact page, window, and Space.');
        const record = await verifyController(store, request, sender);
        if (request.action === 'recover') return store.transientWindows.recoverUnlocked({ token: request.token, tabId: request.tabId }, {
            beforeMutation: () => verifyController(store, request, sender), validateSelection
        });
        if (request.action === 'promote') {
            const result = await store.transientWindows.promoteUnlocked({ token: request.token, tabId: request.tabId,
                windowId: request.windowId, spaceId: request.spaceId, bookmarkFolderId: request.bookmarkFolderId }, {
                beforeMutation: () => verifyController(store, request, sender), commitOwnership
            });
            // Focus is ancillary. A failed focus must never make the UI invite a
            // second transfer of the already committed page.
            let focused = false;
            try {
                const tab = await chrome.tabs.get(result.tabId);
                if (tab.windowId === result.windowId) {
                    await chrome.tabs.update(tab.id, { active: true });
                    await chrome.windows.update(result.windowId, { focused: true });
                    focused = true;
                }
            } catch { /* Ownership remains committed. */ }
            return { ...result, focused };
        }
        let pageTab = null;
        try { if (record.tabId) pageTab = await chrome.tabs.get(record.tabId); } catch { /* Closed page stays closed. */ }
        const recoveryTabs = [];
        if (record.phase === 'orphan') {
            const tabs = await (store.queryTabs ? store.queryTabs({ windowId: record.windowId }) : chrome.tabs.query({ windowId: record.windowId }));
            const records = await store.transientWindows.listUnlocked();
            const current = records.find(item => item.token === record.token);
            for (const tab of tabs) {
                if (tab.id === record.controllerTabId || tab.windowId !== record.windowId
                    || current?.phase !== 'orphan' || !current.memberTabIds.includes(tab.id) || records.some(other => other.token !== record.token
                        && (other.tabId === tab.id || other.controllerTabId === tab.id || other.memberTabIds?.includes(tab.id)))) continue;
                try {
                    const live = await validateSelection(tab, { tabId: tab.id, windowId: record.windowId });
                    recoveryTabs.push({ id: live.id, windowId: live.windowId, title: live.title || '', url: live.url || live.pendingUrl || '' });
                } catch { /* Ineligible pages remain quarantined; never close or recreate them. */ }
            }
            await verifyController(store, request, sender);
        }
        const windows = (await chrome.windows.getAll({ windowTypes: ['normal'], populate: true }))
            .filter(window => !window.incognito && window.type === 'normal' && !store.isTransientWindow(window.id))
            .map(window => ({ id: window.id, title: window.tabs?.find(tab => tab.active)?.title || `Window ${window.id}`,
                origin: window.id === record.originWindowId }));
        const spaces = [];
        for (const space of store.spaces) {
            try { await destinationSpace(store, { spaceId: space.id, bookmarkFolderId: space.bookmarkFolderId }); }
            catch { continue; }
            spaces.push({ id: space.id, bookmarkFolderId: space.bookmarkFolderId, name: space.name });
        }
        return { record: { token: record.token, phase: record.phase, windowId: record.windowId,
            originWindowId: record.originWindowId, tabId: record.tabId }, page: pageTab ? {
            id: pageTab.id, windowId: pageTab.windowId, title: pageTab.title || '', url: pageTab.url || pageTab.pendingUrl || ''
        } : null, recoveryTabs, windows, spaces };
    });
}

export function registerTransientControlMessages(store) {
    const handle = createTransientControlHandler(store);
    chrome.runtime.onMessage.addListener((request, sender, respond) => {
        if (request?.type !== TRANSIENT_CONTROL_TYPE) return;
        handle(request, sender).then(result => respond({ success: true, ...result }),
            error => respond({ success: false, code: error.code || 'FAILED', error: error.message }));
        return true;
    });
}
