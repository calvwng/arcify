import { readSpaceRankCheckpoint } from './space-continuity.js';
import { encodeFavoriteContinuityState as encode } from './favorite-continuity.js';
import { getSpaceBookmarkFolder } from './space-bookmarks.js';

// This witness names a native incarnation, never a URL or a historical identity.
// A session fallback is deliberately lost when browser-session proof is lost.
const SESSION_EPOCH = 'spaceExplicitTodayEpoch';
export const EXPLICIT_TODAY_CHECKPOINT = 'spaceExplicitTodayCheckpoint';
const token = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
async function epochs(store, create = false) {
    const identity = await store.favoriteStore?.ownershipPersistence?.browserIdentity?.({ recovered: true });
    let epoch = (await chrome.storage.session.get(SESSION_EPOCH))[SESSION_EPOCH];
    const browser = token(identity?.epoch) && token(identity?.generation) ? { kind: 'browser', epoch: identity.epoch, generation: identity.generation } : null;
    if (!token(epoch) && !browser && create) {
        epoch = crypto.randomUUID();
        await chrome.storage.session.set({ [SESSION_EPOCH]: epoch });
        if ((await chrome.storage.session.get(SESSION_EPOCH))[SESSION_EPOCH] !== epoch) throw new Error('Current tab identity could not be verified. Nothing was moved.');
    }
    return [...(browser ? [browser] : []), ...(token(epoch) ? [{ kind: 'session', epoch }] : [])];
}
export const explicitTodayEpochs = store => epochs(store);
export async function explicitTodayEpoch(store, create = false) {
    return (await epochs(store,create))[0] || null;
}
export function validExplicitWitness(value, epoch) {
    return !!epoch && value?.version === 1 && token(value.incarnation) && token(value.transaction)
        && Number.isSafeInteger(value.windowId) && value.windowId > 0 && token(value.spaceId) && token(value.bookmarkFolderId)
        && (Array.isArray(epoch) ? epoch : [epoch]).some(current => encode(value.epoch) === encode(current))
        && Object.keys(value).every(key => ['version','epoch','incarnation','transaction','windowId','spaceId','bookmarkFolderId'].includes(key));
}
export function explicitTodayOwner(store, tab) {
    const binding = store.explicitToday?.get(tab?.id);
    const owners = store.spaces.flatMap(space => ['temporaryTabs','spaceBookmarks'].flatMap(section =>
        (space[section] || []).filter(id => id === tab?.id).map(() => ({space,section}))));
    return !!binding && validExplicitWitness(binding, store.explicitTodayEpochs || store.explicitTodayEpoch)
        && owners.length === 1 && owners[0].section === 'temporaryTabs'
        && owners[0].space.id === binding.spaceId && owners[0].space.bookmarkFolderId === binding.bookmarkFolderId
        && !tab.incognito && !tab.pinned && !store.isGlobalTab?.(tab) && !store.isGlobalTab?.(tab.id)
        && !store.isTransientTab?.(tab) && !store.provisional?.has(tab.id);
}
export async function stageExplicitToday(store, tabs, destination) {
    const currentEpochs = await epochs(store, true), epoch = currentEpochs[0];
    if (!epoch) throw new Error('Current tab identity could not be verified. Nothing was moved.');
    const transaction = crypto.randomUUID();
    const bindings = new Map(store.explicitToday || []);
    for (const tab of tabs) bindings.set(tab.id, {
        version: 1, epoch, incarnation: validExplicitWitness(bindings.get(tab.id), currentEpochs) ? bindings.get(tab.id).incarnation : crypto.randomUUID(),
        transaction, windowId: tab.windowId, spaceId: destination.spaceId, bookmarkFolderId: destination.bookmarkFolderId
    });
    return { epoch, epochs: currentEpochs, bindings, transaction };
}
const digest = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(encode(value)))))
    .map(byte => byte.toString(16).padStart(2,'0')).join('');
export async function createExplicitCheckpoint(liveCount, rankFingerprint) {
    return { version: 1, liveCount, rankFingerprint, fingerprint: await digest({liveCount,rankFingerprint}) };
}
export async function readExplicitCheckpoint(data) {
    const checkpoint=data[EXPLICIT_TODAY_CHECKPOINT], snapshot=data.spaceTabSnapshot;
    if(checkpoint?.version!==1 || Object.keys(checkpoint).length!==4 || !Array.isArray(snapshot)
        || !Number.isSafeInteger(checkpoint.liveCount) || checkpoint.liveCount<0 || checkpoint.liveCount>snapshot.length
        || checkpoint.rankFingerprint!==data.spaceRankCheckpoint?.fingerprint
        || checkpoint.fingerprint!==await digest({liveCount:checkpoint.liveCount,rankFingerprint:checkpoint.rankFingerprint})) return null;
    const ranks=await readSpaceRankCheckpoint(data.spaceRankCheckpoint,snapshot);
    return ranks ? {ranks,live:snapshot.slice(0,checkpoint.liveCount),history:snapshot.slice(checkpoint.liveCount)} : null;
}
// Read the canonical local commit before session recovery flags can invoke the
// matcher. A witness alone cannot override membership or a contradictory snapshot.
export async function restoreExplicitToday(store, data, tabs) {
    store.explicitToday = new Map();
    store.explicitTodayEpochs = await epochs(store);
    store.explicitTodayEpoch = store.explicitTodayEpochs[0] || null;
    const checkpoint = await readExplicitCheckpoint(data);
    if (!checkpoint) return;
    const {ranks,live:liveRecords} = checkpoint;
    const { pinnedTabStatesById = {} } = await chrome.storage.local.get('pinnedTabStatesById');
    const ready = [];
    for (const tab of tabs) {
        const candidates = liveRecords.filter(record => record.tabId === tab.id
            && validExplicitWitness(record.currentOwnership, store.explicitTodayEpochs));
        if (candidates.length !== 1) continue;
        const record = candidates[0];
        const owners = store.spaces.flatMap(space => ['temporaryTabs','spaceBookmarks'].flatMap(section =>
            (space[section] || []).filter(id => id === tab.id).map(() => ({space,section}))));
        const unowned=owners.length===0;
        if(unowned){
            const targets=store.spaces.filter(space=>space.id===record.spaceId&&space.bookmarkFolderId===record.currentOwnership.bookmarkFolderId);
            if(targets.length===1&&!store.spaces.some(space=>space.id!==record.spaceId&&space.bookmarkFolderId===record.currentOwnership.bookmarkFolderId))owners.push({space:targets[0],section:'temporaryTabs'});
        }
        if (owners.length !== 1 || owners[0].section !== 'temporaryTabs' || record.section !== 'temporaryTabs'
            || owners[0].space.id !== record.spaceId || record.currentOwnership.windowId !== tab.windowId
            || record.currentOwnership.spaceId !== record.spaceId || record.currentOwnership.bookmarkFolderId !== owners[0].space.bookmarkFolderId
            || tab.incognito || tab.pinned || pinnedTabStatesById[tab.id]?.bookmarkId
            || store.isGlobalTab?.(tab) || store.isGlobalTab?.(tab.id) || store.isTransientTab?.(tab)) continue;
        const window = await chrome.windows.get(tab.windowId);
        if (window?.id !== tab.windowId || window.type !== 'normal' || window.incognito) continue;
        if(unowned)await getSpaceBookmarkFolder(owners[0].space);
        ready.push({tab,record,unowned});
    }
    if (!ready.length) return;
    const destinations=new Map();
    for(const {record,unowned} of ready)if(unowned){
        const targets=store.spaces.filter(space=>space.id===record.spaceId&&space.bookmarkFolderId===record.currentOwnership.bookmarkFolderId);
        if(targets.length!==1)throw new Error('Explicit destination changed during ownership recovery.');
        await getSpaceBookmarkFolder(targets[0]);destinations.set(record.spaceId,targets[0]);
    }
    const finalEpochs = await epochs(store);
    const metadata = await chrome.storage.local.get('pinnedTabStatesById');
    const latest = await store.queryTabs({});
    for (const {tab,record,unowned} of ready) {
        const now = latest.filter(candidate => candidate.id === tab.id);
        if (now.length !== 1 || now[0].windowId !== tab.windowId || now[0].url !== tab.url
            || now[0].pendingUrl !== tab.pendingUrl || now[0].pinned || now[0].incognito
            || now[0].splitViewId !== tab.splitViewId || metadata.pinnedTabStatesById?.[tab.id]?.bookmarkId
            || store.isGlobalTab?.(now[0]) || store.isGlobalTab?.(tab.id) || store.isTransientTab?.(now[0])
            || !validExplicitWitness(record.currentOwnership, finalEpochs)
            || unowned&&(!store.spaces.includes(destinations.get(record.spaceId))
                ||destinations.get(record.spaceId).bookmarkFolderId!==record.currentOwnership.bookmarkFolderId
                ||store.spaces.filter(space=>space.id===record.spaceId||space.bookmarkFolderId===record.currentOwnership.bookmarkFolderId).length!==1)
            || unowned&&store.spaces.some(space=>[...space.temporaryTabs,...space.spaceBookmarks].includes(tab.id))) {
            throw new Error('Current tabs changed during ownership recovery. No historical identity was applied.');
        }
    }
    for (const {tab,record,unowned} of ready) {
        // Same epoch + native ID is incarnation proof even after navigation. The
        // move itself checks its captured URL at every asynchronous write fence.
        store.explicitToday.set(tab.id, structuredClone(record.currentOwnership));
        if(unowned){const target=destinations.get(record.spaceId);
            const index=target.temporaryTabs.findIndex(id=>(store.restoredRanks.get(id)??Infinity)>record.order);
            target.temporaryTabs.splice(index<0?target.temporaryTabs.length:index,0,tab.id);
        }
        store.recoveryCandidates.delete(tab.id);
        const rank = ranks.find(([id]) => id === tab.id);
        if (rank) store.restoredRanks.set(tab.id, rank[1]);
        store.snapshotByTab.set(tab.id, structuredClone(record));
    }
}
export function explicitSnapshotWitness(store, tab) {
    if (!explicitTodayOwner(store, tab)) return {};
    return { currentOwnership: { ...structuredClone(store.explicitToday.get(tab.id)), windowId: tab.windowId } };
}
