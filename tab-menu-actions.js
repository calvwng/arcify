import { getSpaceBookmarkById } from './space-bookmarks.js';
import { readTodayOrderInverted } from './today-order.js';
import { isStartupLauncherTab } from './startup-launcher-tab.js';
import { Utils } from './utils.js';
import { assertNotNativeSplit } from './native-split-safety.js';
import { removeSavedSpacePin } from './space-pin-actions.js';

const ACTIONS = new Set(['describe', 'rename', 'editUrl', 'copyLink', 'mute', 'duplicate', 'removePin']);
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const integer = value => Number.isSafeInteger(value) && value > 0;
const stale = () => new Error('This tab or pin changed. Reopen its menu and try again.');
export function normalizeTabMenuUrl(value) {
    if (typeof value !== 'string' || value.length > 16384 || /[\u0000-\u0020\u007f]/.test(value.trim())) throw new Error('Enter a complete supported URL without spaces.');
    const url = value.trim();
    let parsed;
    try { parsed = new URL(url); } catch { throw new Error('Enter a complete URL, including https://.'); }
    if (!['http:', 'https:', 'file:', 'ftp:', 'chrome:', 'about:'].includes(parsed.protocol)) throw new Error('That URL scheme is not supported for a saved pin.');
    return url;
}

// All menu writes share the authoritative SpaceStore queue. No URL matching,
// selected-tab lookup, or active-tab fallback can stand in for the clicked ID.
export function runTabMenuAction(store, request) {
    return store.run(() => runTabMenuActionCore(store, request));
}

// Queue-free core: the sidebar and paired bridge each hold SpaceStore.run once.
// Guards run after awaited reads, immediately before every consequential write.
export async function runTabMenuActionCore(store, request, { beforeWrite = null, transition = {} } = {}) {
    const guard = () => beforeWrite?.(transition);
    const write = async (operation, committed = () => {}) => {
        await guard(); transition.attempted = true;
        const result = await operation(); transition.committed = true; committed(result); return result;
    };
    const persist = () => { transition.persistenceStarted = true; return store.persist(beforeWrite ? { skipGroupSync: true, beforeWrite: guard } : undefined); };
    if (!request || Object.keys(request).some(key => !['type', 'action', 'windowId', 'spaceId', 'bookmarkFolderId', 'tabId', 'bookmarkId', 'parentId', 'expected', 'value'].includes(key)) ||
        !ACTIONS.has(request.action) || !integer(request.windowId) || !id(request.spaceId) || !id(request.bookmarkFolderId) ||
        request.type !== undefined && request.type !== 'tabMenuAction' || request.tabId !== undefined && !integer(request.tabId) || request.bookmarkId !== undefined && !id(request.bookmarkId) ||
        request.parentId !== undefined && !id(request.parentId) || !request.tabId && !request.bookmarkId) throw new Error('Invalid tab action.');
    const { action, windowId, spaceId, bookmarkId, tabId } = request;
    if (['rename', 'editUrl'].includes(action) && (!request.expected || typeof request.expected !== 'object' || Array.isArray(request.expected))) throw stale();
    if (action === 'rename' && (typeof request.value !== 'string' || request.value.trim().length > 256 || /[\u0000-\u001f\u007f]/.test(request.value))) throw new Error('Use a name of up to 256 characters without control characters.');
    const value = action === 'editUrl' ? normalizeTabMenuUrl(request.value) : action === 'rename' ? request.value.trim() : request.value;
    if (action === 'rename' && bookmarkId && !value) throw new Error('A saved pin needs a name.');
    if (action === 'mute' && typeof value !== 'boolean') throw new Error('Invalid mute setting.');
    if (['editUrl', 'removePin'].includes(action) && !bookmarkId || ['mute', 'duplicate'].includes(action) && !tabId || action === 'duplicate' && bookmarkId) throw new Error('This action is unavailable for that row.');
    const getSpace = () => {
        const space = store.spaces.find(item => item.id === spaceId);
        if (!space || space.bookmarkFolderId !== request.bookmarkFolderId || store.active[windowId] !== spaceId) throw stale();
        return space;
    };
    async function resolve() {
        const space = getSpace();
        const window = await chrome.windows.get(windowId);
        if (window.id !== windowId || window.type !== 'normal' || window.incognito) throw stale();
        const aliases = await Utils.getTabNameOverrides();
        let bookmark = null;
        if (bookmarkId) {
            bookmark = await getSpaceBookmarkById(space, bookmarkId);
            if (!bookmark || bookmark.parentId !== request.parentId) throw stale();
        }
        let tab = null, binding = null;
        if (tabId) {
            const memberships = store.spaces.flatMap(item => ['spaceBookmarks', 'temporaryTabs'].flatMap(section =>
                (item[section] || []).filter(member => member === tabId).map(() => ({ space: item.id, section }))));
            if (memberships.length !== 1 || memberships[0].space !== spaceId || memberships[0].section !== (bookmarkId ? 'spaceBookmarks' : 'temporaryTabs') || store.isGlobalTab?.(tabId)) throw stale();
            binding = await Utils.getPinnedTabState(tabId);
            if (bookmarkId ? binding?.bookmarkId !== bookmarkId : binding?.bookmarkId) throw stale();
            try { tab = await chrome.tabs.get(tabId); } catch { throw stale(); }
            if (tab.id !== tabId || tab.windowId !== windowId || tab.incognito || tab.pinned || isStartupLauncherTab(tab)) throw stale();
        }
        const expected = bookmark ? { title: bookmark.title, url: bookmark.url, parentId: bookmark.parentId }
            : { url: tab.url || tab.pendingUrl || '', alias: aliases[tabId]?.name || '' };
        if (['rename', 'editUrl'].includes(action) && JSON.stringify(request.expected) !== JSON.stringify(expected)) throw stale();
        getSpace();
        return { space, bookmark, tab, expected, title: bookmark?.title || aliases[tabId]?.name || tab?.title || '', url: bookmark?.url || tab?.url || tab?.pendingUrl || '', muted: Boolean(tab?.mutedInfo?.muted) };
    }
    let target = await resolve();
    if (action === 'describe') return { title: target.title, url: target.url, expected: target.expected, muted: target.muted, currentUrl: target.tab?.url || target.tab?.pendingUrl || null };
    if (action === 'copyLink') {
        const url = target.tab ? target.tab.url || target.tab.pendingUrl : target.bookmark.url;
        if (!url) throw new Error('This row has no URL to copy.');
        return { url };
    }
    if (action === 'mute') { target = await resolve(); await write(() => chrome.tabs.update(tabId, { muted: value }), () => { transition.mutedCommitted = true; }); return {}; }
    if (action === 'rename' && !bookmarkId) {
        // Locked across sidebar documents too, so other exact-ID names survive.
        await Utils._serializeTabNameOp(async () => {
            const names = await Utils.getTabNameOverrides();
            target = await resolve();
            if (value && value !== target.tab.title) names[tabId] = { name: value, originalDomain: new URL(target.tab.url || target.tab.pendingUrl).hostname };
            else delete names[tabId];
            transition.alias = names[tabId]?.name || '';
            transition.aliasState = names[tabId] ? { ...names[tabId] } : null;
            await write(() => Utils.saveTabNameOverrides(names), () => { transition.aliasesCommitted = true; });
        });
        await persist();
        await guard();
        return {};
    }
    if (action === 'duplicate') {
        target = await resolve();
        assertNotNativeSplit(target.tab);
        const duplicate = await write(() => chrome.tabs.duplicate(tabId), result => { transition.duplicateId = result?.id; });
        if (!duplicate?.id) throw new Error('Chrome did not confirm the duplicate. Check Today before trying again.');
        try {
            // The source can close after duplication. Assign the new identity to
            // the originally validated Space, never transfer saved pin identity.
            if ((await Utils.getPinnedTabState(duplicate.id))?.bookmarkId) throw stale();
            // One final snapshot covers both identities after binding I/O.
            // Query failures are not evidence that the source was closed.
            // Paired actions must not initialize order storage during a read:
            // pairing can be revoked after the irreversible native duplicate.
            await store.readTodayPlacement(beforeWrite ? { getOrder: readTodayOrderInverted } : undefined);
            const tabs = await chrome.tabs.query({});
            const space = getSpace(), live = tabs.find(tab => tab.id === duplicate.id);
            if (!live || live.windowId !== windowId || live.pinned || live.incognito || isStartupLauncherTab(live) || store.isGlobalTab?.(live.id)) throw stale();
            const source = tabs.find(tab => tab.id === tabId);
            assertNotNativeSplit(source); assertNotNativeSplit(live);
            await guard();
            store.forgetTab(live.id);
            store.insertCreatedToday(space, live, { nativeTabs: tabs, openerTabId: source?.id });
            transition.membershipCommitted = true;
            await persist();
            await guard();
            return { tabId: live.id };
        } catch (error) {
            throw new Error(`The duplicate was created, but its Space assignment could not be confirmed. Check tab ${duplicate.id} before trying again. ${error.message}`);
        }
    }
    if (action === 'removePin') {
        await resolve();
        await removeSavedSpacePin(store, { getSpace, bookmarkId });
        return {};
    }
    // Recheck immediately before Chrome's non-transactional bookmark write.
    // A concurrent native Bookmark Manager/Sync edit can still race this call.
    target = await resolve();
    const update = action === 'rename' ? { title: value } : { url: value };
    await write(() => chrome.bookmarks.update(bookmarkId, update), () => { transition.bookmarkCommitted = true; });
    try {
        const [saved] = await chrome.bookmarks.get(bookmarkId);
        if (!saved || saved.parentId !== target.bookmark.parentId || saved.title !== (action === 'rename' ? value : target.bookmark.title) || saved.url !== (action === 'editUrl' ? value : target.bookmark.url)) throw stale();
        const newUrl = action === 'editUrl' ? value : target.bookmark.url;
        await Utils._serializePinnedStateOp(async () => {
            const states = await Utils.getPinnedTabStates();
            for (const [key, binding] of Object.entries(states)) {
                const liveId = Number(key);
                if (binding.bookmarkId !== bookmarkId || store.isGlobalTab?.(liveId) || !target.space.spaceBookmarks.includes(liveId)) continue;
                let live;
                try { live = await chrome.tabs.get(liveId); } catch { continue; }
                if (live.pinned || live.incognito) continue;
                states[key] = { ...binding, pinnedUrl: newUrl };
            }
            await write(() => Utils.savePinnedTabStates(states), () => { transition.bindingsCommitted = true; });
        });
        // Pinned titles are projected from the bookmark, so obsolete local
        // overrides must not outlive a saved edit or become a Today alias.
        await Utils._serializeTabNameOp(async () => {
            const names = await Utils.getTabNameOverrides();
            const states = await Utils.getPinnedTabStates();
            for (const [key, binding] of Object.entries(states)) {
                if (binding.bookmarkId === bookmarkId && target.space.spaceBookmarks.includes(Number(key)) && !store.isGlobalTab?.(Number(key))
                && (!beforeWrite || transition.affected?.includes(Number(key)))) delete names[key];
            }
            await write(() => Utils.saveTabNameOverrides(names), () => { transition.aliasesCommitted = true; });
        });
        await persist();
        await guard();
    } catch (error) {
        throw new Error(`The saved pin was updated, but its live display could not be fully refreshed. Reload the sidebar before retrying. ${error.message}`);
    }
    return {};
}

export function registerTabMenuMessages(store) {
    chrome.runtime.onMessage.addListener((message, sender, respond) => {
        if (message?.type !== 'tabMenuAction') return;
        const ownUrl = chrome.runtime.getURL('');
        if (sender?.id !== chrome.runtime.id || sender.url && !sender.url.startsWith(ownUrl) ||
            sender.origin && sender.origin !== ownUrl.replace(/\/$/, '') || sender.tab && sender.tab.windowId !== message.windowId) {
            respond({ success: false, error: 'Invalid tab menu sender.' }); return;
        }
        runTabMenuAction(store, message).then(result => respond({ success: true, ...result }), error => respond({ success: false, error: error.message }));
        return true;
    });
}
