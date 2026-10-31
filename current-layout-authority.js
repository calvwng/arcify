import { explicitTodayEpochs, stageExplicitToday } from './explicit-today-ownership.js';
import { encodeFavoriteContinuityState as encode } from './favorite-continuity.js';
import { getSpaceBookmarkFolder } from './space-bookmarks.js';
import { isStartupLauncherTab } from './startup-launcher-tab.js';

// Proof is acquired from authenticated snapshot replay or an observed creation
// in an already initialized browser epoch. Ordinary fallback membership is not
// proof. This module never matches historical records or changes membership.
export async function stageCurrentLayoutAuthority(store, records, tabs, proofEpoch) {
    if (!records?.length || !proofEpoch) return;
    const available = await explicitTodayEpochs(store);
    if (!available.some(epoch => encode(epoch) === encode(proofEpoch))) throw new Error('Current layout proof expired.');
    const owners = id => store.spaces.flatMap(space => ['temporaryTabs','spaceBookmarks'].flatMap(section =>
        space[section].filter(value => value === id).map(() => ({space,section}))));
    const ready = [];
    const metadata = await chrome.storage.local.get(['pinnedTabStatesById','tabNameOverridesById']);
    for (const record of records) {
        const tab = tabs.find(tab => tab.id === record.tabId), owner = owners(record.tabId);
        if (!tab || tab.incognito || tab.pinned || store.isGlobalTab?.(tab) || store.isTransientTab?.(tab)
            || isStartupLauncherTab(tab) || Number.isInteger(tab.splitViewId) && tab.splitViewId >= 0
            || !tab.url || tab.pendingUrl && tab.pendingUrl !== tab.url
            || owner.length !== 1 || owner[0].section !== 'temporaryTabs' || record.section !== 'temporaryTabs'
            || owner[0].space.id !== record.spaceId || record.pinnedState
            || store.restoredMetadata?.some(r=>r.tabId===tab.id && r.pinnedState)
            || metadata.pinnedTabStatesById?.[tab.id]) continue;
        await getSpaceBookmarkFolder(owner[0].space);
        ready.push({tab:structuredClone(tab),space:owner[0].space,name:store.restoredMetadata?.find(r=>r.tabId===tab.id)?.nameOverride??metadata.tabNameOverridesById?.[tab.id]});
    }
    if (!ready.length) return;
    const stage = await stageExplicitToday(store,ready.map(item=>item.tab),{
        spaceId:ready[0].space.id,bookmarkFolderId:ready[0].space.bookmarkFolderId});
    const known=new Set(store.spaces.flatMap(space=>space.temporaryTabs));
    const order=()=>store.spaces.map(s=>({id:s.id,root:s.bookmarkFolderId,today:s.temporaryTabs.filter(id=>known.has(id))}));
    const canonical = encode(order());
    const previous = store.currentLayoutFence;
    const validate = async () => {
        if (previous) await previous();
        for (const item of ready) await getSpaceBookmarkFolder(item.space);
        const currentMetadata = await chrome.storage.local.get(['pinnedTabStatesById','tabNameOverridesById']);
        const epochs = await explicitTodayEpochs(store);
        const latest = await store.queryTabs({});
        if (!epochs.some(epoch=>encode(epoch)===encode(proofEpoch)) || encode(epochs[0])!==encode(stage.epoch)
            || encode(order())!==canonical
            || ready.some(({tab,space,name})=>{
                const matches=latest.filter(now=>now.id===tab.id),now=matches[0],owner=owners(tab.id);
                return matches.length!==1 || now.windowId!==tab.windowId || now.url!==tab.url || now.pendingUrl!==tab.pendingUrl
                    || now.pinned || now.incognito || now.splitViewId!==tab.splitViewId || store.isGlobalTab?.(now) || store.isTransientTab?.(now)
                    || owner.length!==1 || owner[0].space!==space || owner[0].section!=='temporaryTabs'
                    || currentMetadata.pinnedTabStatesById?.[tab.id]
                    || store.restoredMetadata?.some(r=>r.tabId===tab.id && r.pinnedState)
                    || encode(currentMetadata.tabNameOverridesById?.[tab.id])!==encode(store.restoredMetadata?.some(r=>r.tabId===tab.id)
                        ?metadata.tabNameOverridesById?.[tab.id]:name);
            })) throw new Error('Current layout authority changed before checkpoint.');
    };
    await validate();
    for (const {tab,space} of ready) {
        const binding=stage.bindings.get(tab.id);binding.spaceId=space.id;binding.bookmarkFolderId=space.bookmarkFolderId;
        store.recoveryCandidates.delete(tab.id);store.provisional.delete(tab.id);store.layoutProvisional?.delete(tab.id);
        store.restoredRanks.set(tab.id,space.temporaryTabs.indexOf(tab.id));
    }
    store.explicitToday=stage.bindings;store.explicitTodayEpoch=stage.epoch;store.explicitTodayEpochs=stage.epochs;
    store.currentLayoutFence=validate;store.currentLayoutTransition=true;
    return ready.map(item=>item.tab.id);
}
