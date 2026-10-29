import { projectTabTitle } from './tab-title-projection.js';
import { Utils } from './utils.js';
import { isStartupLauncherTab } from './startup-launcher-tab.js';
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const positive = n => Number.isSafeInteger(n) && n > 0;
const identity = (a, b) => ['id', 'windowId', 'spaceId', 'bookmarkFolderId'].every(key => a?.[key] === b?.[key]);

// Called inside the store queue. This is a projection, never a membership repair.
export async function readSharedToday(store, api = chrome) {
    const [windows, tabs, bindings, overrides] = await Promise.all([
        api.windows.getAll({ windowTypes: ['normal'] }),
        store.queryTabs ? store.queryTabs({}) : api.tabs.query({}),
        Utils.getPinnedTabStates(), Utils.getTabNameOverrides()
    ]);
    const ordinary = new Set(windows.filter(w => w.type === 'normal' && !w.incognito && !store.isTransientWindow?.(w.id)).map(w => w.id));
    const eligible = new Map(tabs.filter(t => positive(t.id) && ordinary.has(t.windowId) && !t.incognito && !t.pinned
        && !store.isGlobalTab?.(t) && !store.isTransientTab?.(t) && !isStartupLauncherTab(t)
        && (t.splitViewId === undefined || t.splitViewId === -1) && !store.recoveryCandidates?.has(t.id) && !store.provisional?.has(t.id) && !bindings[t.id]?.bookmarkId).map(t => [t.id, t]));
    const claims = new Map();
    for (const space of store.spaces) for (const id of [...space.spaceBookmarks, ...space.temporaryTabs]) claims.set(id, (claims.get(id) || 0) + 1);
    const result = [];
    for (const space of store.spaces) for (const id of space.temporaryTabs) {
        const tab = eligible.get(id);
        if (!tab || claims.get(id) !== 1) continue;
        
        result.push({ id, windowId: tab.windowId, spaceId: space.id, bookmarkFolderId: space.bookmarkFolderId,
            title: projectTabTitle(tab, { overrides, binding: bindings[id], isSpacePin: false }), url: tab.url || tab.pendingUrl || '' });
    }
    return result;
}

// Exact live identity only. No move, create, navigation, pin or URL lookup.
export async function openSharedToday(store, request, { api = chrome, beforeMutation = async () => {} } = {}) {
    if (!positive(request.windowId) || !positive(request.id) || !positive(request.ownerWindowId)
        || request.windowId === request.ownerWindowId || typeof request.spaceId !== 'string' || typeof request.bookmarkFolderId !== 'string')
        fail('INVALID_REQUEST', 'Choose a Today tab in another window.');
    const expected = { id: request.id, windowId: request.ownerWindowId, spaceId: request.spaceId, bookmarkFolderId: request.bookmarkFolderId };
    const validate = async () => {
        const source = await api.windows.get(request.windowId);
        if (source.type !== 'normal' || source.incognito || store.isTransientWindow?.(source.id)) fail('INVALID_WINDOW', 'Choose a normal source window.');
        const row = (await readSharedToday(store, api)).find(row => row.id === expected.id);
        if (!identity(row, expected)) fail('STALE_SHARED_TODAY', 'This Today tab changed, closed, or moved. Refresh the list; nothing was recreated.');
        return row;
    };
    const subscriptions = []; let changed = false;
    const listen = (event, fn) => { if (event) { event.addListener(fn); subscriptions.push(() => event.removeListener(fn)); } };
    const tabChanged = id => { if (id === expected.id) changed = true; };
    listen(api.tabs.onRemoved, tabChanged); listen(api.tabs.onAttached, tabChanged); listen(api.tabs.onDetached, tabChanged);
    listen(api.tabs.onReplaced, (added, removed) => { tabChanged(added); tabChanged(removed); });
    listen(api.tabs.onUpdated, (id, update) => { if (['pinned','splitViewId','incognito'].some(k => Object.hasOwn(update,k))) tabChanged(id); });
    listen(api.windows.onRemoved, id => { if (id === expected.windowId || id === request.windowId) changed = true; });
    const boundary = async () => {
        await validate();
        // Pairing/generation is the last asynchronous authority read. Native
        // identity events fence the interval occupied by that read.
        await beforeMutation();
        const owners = store.spaces.filter(s => [...s.spaceBookmarks, ...s.temporaryTabs].includes(expected.id));
        if (changed || owners.length !== 1 || owners[0].id !== expected.spaceId || owners[0].bookmarkFolderId !== expected.bookmarkFolderId
            || !owners[0].temporaryTabs.includes(expected.id) || store.recoveryCandidates?.has(expected.id) || store.provisional?.has(expected.id))
            fail('STALE_SHARED_TODAY', 'This Today tab changed. Refresh the list; nothing was recreated.');
    };
    try {
    await boundary();
    await store.applyAction({ action: 'activate', windowId: expected.windowId, spaceId: expected.spaceId });
    await boundary();
    await api.tabs.update(expected.id, { active: true });
    await boundary();
    await api.windows.update(expected.windowId, { focused: true });
    await validate();
    const [tab, window] = await Promise.all([api.tabs.get(expected.id), api.windows.get(expected.windowId)]);
    if (tab.windowId !== expected.windowId || !tab.active || !window.focused || store.active[expected.windowId] !== expected.spaceId)
        fail('SHARED_TODAY_UNCONFIRMED', 'Opening this Today tab was not confirmed. Check its owning window; nothing was retried.');
    return { tabId: expected.id, ownerWindowId: expected.windowId, spaceId: expected.spaceId };
    } finally { for (const unsubscribe of subscriptions) unsubscribe(); }
}

export function registerSharedToday(store, api = chrome) {
    api.runtime.onMessage.addListener((request, sender, respond) => {
        if (request?.type !== 'arcifySharedToday') return;
        const allowed = request.action === 'read' ? ['type', 'action', 'windowId'] : ['type', 'action', 'windowId', 'id', 'ownerWindowId', 'spaceId', 'bookmarkFolderId'];
        const work = async () => {
            const origin = api.runtime.getURL('').replace(/\/$/, '');
            if (sender.id !== api.runtime.id || sender.url !== api.runtime.getURL('sidebar.html') || sender.tab
                || sender.origin && sender.origin !== origin || sender.frameId && sender.frameId !== 0
                || sender.documentLifecycle && sender.documentLifecycle !== 'active') fail('UNAUTHORIZED', 'Use the Arcify sidebar.');
            if (!['read', 'open'].includes(request.action) || Object.keys(request).length !== allowed.length || !allowed.every(k => Object.hasOwn(request, k)) || !positive(request.windowId)) fail('INVALID_REQUEST', 'Invalid Today request.');
            const source = await api.windows.get(request.windowId);
            if (source.type !== 'normal' || source.incognito || store.isTransientWindow?.(source.id)) fail('INVALID_WINDOW', 'Choose a normal source window.');
            return request.action === 'read' ? { entries: await readSharedToday(store, api) } : openSharedToday(store, request, { api });
        };
        store.run(work).then(result => respond({ success: true, ...result }), error => respond({ success: false, code: error.code || 'SHARED_TODAY_UNCONFIRMED', error: error.message }));
        return true;
    });
}
