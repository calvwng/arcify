import { classifyOpenDestination } from './recovery-routing-policy.js';
import { bridgeError, isTransientUrl, isWindowId } from './spotlight-bridge-protocol.js';
import { getSpaceBookmarkById, getSpaceBookmarkFolder } from './space-bookmarks.js';
import { hasNativeSplit } from './native-split-safety.js';
import { isStartupLauncherTab } from './startup-launcher-tab.js';
import { SAVED_MOVE_JOURNAL_KEY } from './saved-move-lock.js';
import { journalValid } from './saved-move-store.js';
const canonical = value => JSON.stringify(value, (key,item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(k=>[k,item[k]])) : item);

export const ROUTED_OPEN_FEATURE = 'sourceRoutedOpenV1';
const stale = () => bridgeError('STALE_ROUTING_SOURCE', 'The source page or its ownership changed. Nothing was retried. Reopen Spotlight from the intended page.');
const uncertain = () => bridgeError('UNCERTAIN_RESULT', 'The routed opening was not confirmed. Check your tabs and Little Arc windows before trying again. Nothing was retried or closed.');
const sourceOwners = (store, id) => (store.spaces || []).flatMap(space => ['temporaryTabs', 'spaceBookmarks'].flatMap(section =>
    (space[section] || []).filter(tabId => tabId === id).map(() => ({ space, section }))));

// Construct synchronously at bridge intake, before either queue or any read.
// This is operation-scoped evidence, never a global native-tab routing hook.
export function captureRoutedOpenSource(store, request, api = chrome) {
    const source = request.source;
    const listeners = [];
    let changed = false, dispatched = false;
    const listen = (event, fn) => {
        if (!event?.addListener || !event?.removeListener) throw stale();
        event.addListener(fn); listeners.push(() => event.removeListener(fn));
    };
    const assertMemory = () => {
        const transient = store.transientWindows?.observationState?.();
        if (!store.initialized || !store.favoriteStore?.initialized || store.favoriteStore.persistenceDirty
            || !transient?.initialized || !transient.provenanceReady || !transient.healthy
            || transient.revision !== transient.savedRevision
            || store.isTransientTab?.(source.tabId) || store.isTransientWindow?.(request.windowId)
            || store.provisional?.has(source.tabId) || store.recoveryCandidates?.has(source.tabId)
            || store.pendingCreations?.has(source.tabId) || store.archiveStore?.pendingCreatedIds?.has(source.tabId)
            || store.favoriteStore.state?.attempts?.length) throw stale();
        const owners = sourceOwners(store, source.tabId);
        if (owners.length > 1 || owners.some(({space}) => !space.id || !space.bookmarkFolderId
            || store.spaces.filter(other => other.id === space.id || other.bookmarkFolderId === space.bookmarkFolderId).length !== 1)) throw stale();
        const bindings = (store.favoriteStore.state?.bindings || []).filter(binding=>binding.tabId===source.tabId);
        const binding = bindings[0];
        const items = binding ? store.favoriteStore.items.filter(item=>item.id===binding.favoriteId) : [];
        if (bindings.length > 1 || binding && (owners.length || binding.windowId!==request.windowId || items.length!==1)) throw stale();
        return {owners:owners.map(({space, section}) => [space.id, space.bookmarkFolderId, section]),
            favorite:binding ? {binding,item:{id:items[0].id,url:items[0].url,sourceBookmarkId:items[0].sourceBookmarkId}} : null};
    };
    let initial, intakeError;
    try { initial = canonical(assertMemory()); } catch(error) { intakeError = error; }
    try {
        listen(api.tabs.onUpdated, (id, change) => { if (id === source.tabId && (['url', 'pendingUrl', 'pinned', 'splitViewId'].some(k => Object.hasOwn(change,k)) || change.status === 'loading')) changed = true; });
        listen(api.tabs.onRemoved, id => { if (id === source.tabId) changed = true; });
        listen(api.tabs.onDetached, id => { if (id === source.tabId) changed = true; });
        listen(api.tabs.onReplaced, (added, removed) => { if (removed === source.tabId || added === source.tabId) changed = true; });
        listen(api.tabs.onActivated, info => { if (info.windowId === request.windowId && info.tabId !== source.tabId) changed = true; });
        listen(api.windows.onRemoved, id => { if (id === request.windowId) changed = true; });
    } catch (error) { listeners.forEach(remove => remove()); throw error; }
    const assert = () => { if (intakeError || changed || canonical(assertMemory()) !== initial) throw stale(); };
    const check = async () => {
        assert();
        const [tab, window, stored] = await Promise.all([
            api.tabs.get(source.tabId), api.windows.get(request.windowId),
            api.storage.local.get(['pinnedTabStatesById', SAVED_MOVE_JOURNAL_KEY])
        ]);
        assert();
        if (tab.id !== source.tabId || tab.windowId !== request.windowId || tab.incognito !== false || typeof tab.pinned !== 'boolean'
            || !tab.active || tab.url !== source.url || tab.pendingUrl || tab.status === 'loading'
            || !isTransientUrl(tab.url) || hasNativeSplit(tab) || isStartupLauncherTab(tab)
            || window.id !== request.windowId || window.type !== 'normal' || window.incognito !== false
            || !dispatched && window.focused !== true
            || stored[SAVED_MOVE_JOURNAL_KEY] && (stored[SAVED_MOVE_JOURNAL_KEY].phase !== 'committed' || !journalValid(stored[SAVED_MOVE_JOURNAL_KEY]))) throw stale();
        const owners = sourceOwners(store, source.tabId), owner = owners[0];
        const global = store.favoriteStore.state.bindings.find(binding=>binding.tabId===source.tabId);
        if (global ? !store.favoriteStore.ownsTab?.(tab) || !store.isGlobalTab?.(tab) || !tab.pinned && global.mode !== 'ordinary'
            : tab.pinned || store.isGlobalTab?.(tab)) throw stale();
        const binding = stored.pinnedTabStatesById?.[source.tabId];
        if (owner?.section === 'spaceBookmarks') {
            if (!binding?.bookmarkId || !await getSpaceBookmarkById(owner.space, binding.bookmarkId)) throw stale();
        } else if (binding?.bookmarkId) throw stale();
        if (owner) await getSpaceBookmarkFolder(owner.space);
        assert();
        return owner ? { status:'proven', destinations:[{proof:'exact',spaceId:owner.space.id,windowId:request.windowId}] } : {status:'none-confirmed'};
    };
    return { check, assert, dispatched() { dispatched = true; }, dispose() { listeners.splice(0).forEach(remove => remove()); } };
}

// Called only under SpaceStore's writer queue and the existing request journal.
export async function runRoutedOpen(store, request, guard, { beforeMutation, peerId, api = chrome } = {}) {
    const source = await guard.check();
    const now = Math.floor(performance.now());
    const plan = classifyOpenDestination({capture:{epoch:'routed-open',revision:0,observedAtMs:now},currentEpoch:'routed-open',currentRevision:0,nowMs:now,maxAgeMs:0,
        page:{state:'not-created'},targetKind:'web',provenance:'extension-controlled',flow:'ordinary-link',destinationEvidence:'complete',source});
    if (!['inherit-space','little-arc'].includes(plan.action)) throw stale();
    const check = async () => {
        await guard.check();
        // The original Spotlight document's live fence closes the dispatch-to-
        // intake gap, even when a reload retains the same URL and tab ID.
        await new Promise((resolve,reject)=>{
            const timer=setTimeout(()=>reject(stale()),2000);
            try { api.runtime.sendMessage(peerId,{type:'arcify-routed-source',...request.source,windowId:request.windowId},response=>{
                clearTimeout(timer); if(api.runtime.lastError || response?.live!==true)return reject(stale()); resolve();
            }); } catch {clearTimeout(timer);reject(stale());}
        });
        await beforeMutation(); guard.assert();
    };
    await check();
    if (plan.action === 'little-arc') {
        // Only the future target page is created. No existing document is reopened.
        // openUnlocked calls this guard again after controller readiness.
        guard.dispatched();
        const record = await store.transientWindows.openUnlocked({url:request.url,originWindowId:request.windowId},{beforeMutation:check});
        store.littleArcHeader?.remember(record, request.windowId);
        return {tabId:record.tabId,transientWindowId:record.windowId};
    }
    const spaceId = plan.destination.spaceId;
    let tab;
    guard.assert(); guard.dispatched();
    try { tab = await api.tabs.create({windowId:request.windowId,url:request.url,active:false}); }
    catch { throw uncertain(); }
    if (!isWindowId(tab?.id) || tab.windowId !== request.windowId) throw uncertain();
    // Creation is never replayed or undone if later membership/focus fails.
    try {
        await check();
        await store.applyAction({action:'assign',tabId:tab.id,spaceId,pinned:false,newTodayTab:true});
        await check();
        const current = await api.tabs.get(tab.id);
        if (current.windowId !== request.windowId || current.incognito || current.pinned || store.isTransientTab?.(current)) throw uncertain();
        await beforeMutation(); guard.assert();
        await store.applyAction({action:'activate',windowId:request.windowId,spaceId});
        await check();
        await api.tabs.update(tab.id,{active:true});
        await api.windows.update(request.windowId,{focused:true});
        // Expected focus has now changed. Verify the result, not source-active state.
        const [opened, window, persisted, session] = await Promise.all([
            api.tabs.get(tab.id), api.windows.get(request.windowId),
            api.storage.local.get(['spaces','spaceTabSnapshot']), api.storage.session.get('activeSpaces')
        ]);
        const owners = sourceOwners(store, tab.id), savedOwners = sourceOwners({spaces:persisted.spaces}, tab.id);
        const records = (persisted.spaceTabSnapshot || []).filter(record=>record.tabId===tab.id);
        if (opened.id !== tab.id || opened.windowId !== request.windowId || opened.active !== true || opened.pinned !== false || opened.incognito !== false
            || window.id !== request.windowId || window.focused !== true || window.type !== 'normal' || window.incognito !== false
            || owners.length !== 1 || owners[0].space.id !== spaceId || owners[0].section !== 'temporaryTabs'
            || savedOwners.length !== 1 || savedOwners[0].space.id !== spaceId || savedOwners[0].section !== 'temporaryTabs'
            || records.length !== 1 || records[0].spaceId !== spaceId || records[0].section !== 'temporaryTabs'
            || store.active[request.windowId] !== spaceId || session.activeSpaces?.[request.windowId] !== spaceId) throw uncertain();
        await beforeMutation();
        return {tabId:tab.id};
    } catch { throw uncertain(); }
}
