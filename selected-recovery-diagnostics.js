import { createRecoveryObserver, trustedRecoveryReader } from './recovery-observation.js';
import { encodeFavoriteContinuityState as encode } from './favorite-continuity.js';
import { diagnoseDurableLayout } from './durable-layout-diagnostics.js';

export const SELECTED_RECOVERY_DIAGNOSTIC = 'arcifySelectedRecoveryDiagnostic';
export const REASON_KEYS = ['multipleHistoricalRecords', 'otherSpace', 'nonTodaySection', 'pinMetadata', 'nameMetadata',
    'noHistoricalUrlMatch', 'liveUrlDuplicates', 'recoveryFlagged', 'provisional', 'blockedSelected'];
const schema = 'arcify-selected-recovery-diagnostic-v1';
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const positive = value => Number.isSafeInteger(value) && value > 0;
export function validDiagnosticRequest(request) {
    return exact(request, ['type','windowId','spaceId','bookmarkFolderId','entries']) && request.type === SELECTED_RECOVERY_DIAGNOSTIC
        && positive(request.windowId) && ['spaceId','bookmarkFolderId'].every(key => typeof request[key] === 'string' && request[key].length > 0 && request[key].length <= 256)
        && Array.isArray(request.entries) && request.entries.length > 0 && request.entries.length <= 100
        && new Set(request.entries.map(entry => entry?.tabId)).size === request.entries.length
        && request.entries.every(entry => exact(entry,['tabId','url']) && positive(entry.tabId)
            && typeof entry.url === 'string' && entry.url.length > 0 && entry.url.length <= 16384);
}
export function validateDiagnosticReport(value) {
    if (!exact(value,['schema','status','selectedCount','counts']) || value.schema !== schema
        || !['stable','changing','cold','incomplete','selection-changed'].includes(value.status)
        || !positive(value.selectedCount) || value.selectedCount > 100) throw new Error('Invalid diagnostic report');
    if (value.status !== 'stable') {
        if (value.counts !== null) throw new Error('Invalid diagnostic report');
    } else if (!exact(value.counts,REASON_KEYS) || REASON_KEYS.some(key => !Number.isSafeInteger(value.counts[key]) || value.counts[key] < 0 || value.counts[key] > value.selectedCount)) throw new Error('Invalid diagnostic report');
    return {schema,status:value.status,selectedCount:value.selectedCount,
        counts:value.counts ? Object.fromEntries(REASON_KEYS.map(key=>[key,value.counts[key]])) : null};
}
// Pure classification of a queued, two-read worker observation. No matcher, writes,
// URLs/IDs/names in output, or inference that a zero count authorizes recovery.
export function diagnoseSelectedRecovery(snapshot, request) {
    if (!validDiagnosticRequest(request)) throw new Error('Invalid diagnostic request');
    const result = status => ({schema,status,selectedCount:request.entries.length,counts:null});
    if (!snapshot.stable) return result('changing');
    if (snapshot.scope !== 'live-store') return result('cold');
    const {memory:m,local,session,tabs,windows} = snapshot;
    if (!Array.isArray(m.restoreQueue) || !Array.isArray(session.spaceRestoreQueue)
        || encode(m.restoreQueue) !== encode(session.spaceRestoreQueue) || !session.spaceSession
        || !Array.isArray(m.recoveryCandidates) || !Array.isArray(m.provisional) || !Array.isArray(session.spaceRecoveryCandidates)
        || encode([...new Set([...m.recoveryCandidates,...m.provisional])].sort((a,b)=>a-b)) !== encode([...new Set(session.spaceRecoveryCandidates)].sort((a,b)=>a-b))
        || encode(m.spaces) !== encode(local.spaces)) return result('incomplete');
    const spaces = m.spaces.filter(space=>space.id===request.spaceId);
    if (spaces.length!==1 || spaces[0].bookmarkFolderId!==request.bookmarkFolderId
        || m.active?.[request.windowId]!==request.spaceId || session.activeSpaces?.[request.windowId]!==request.spaceId
        || !windows.some(w=>w.id===request.windowId && w.type==='normal' && w.incognito===false)) return result('selection-changed');
    const counts=Object.fromEntries(REASON_KEYS.map(key=>[key,0]));
    for(const entry of request.entries){
        const native=tabs.filter(tab=>tab.id===entry.tabId);
        const owners=m.spaces.flatMap(space=>['temporaryTabs','spaceBookmarks'].flatMap(section=>(space[section]||[]).filter(id=>id===entry.tabId).map(()=>({space,section}))));
        if(native.length!==1 || native[0].windowId!==request.windowId || native[0].incognito!==false || native[0].pinned
            || native[0].knownTransient || native[0].url!==entry.url || native[0].pendingUrl && native[0].pendingUrl!==entry.url
            || owners.length!==1 || owners[0].space.id!==request.spaceId || owners[0].section!=='temporaryTabs') return result('selection-changed');
        const records=m.restoreQueue.filter(record=>record.url===entry.url);
        const reasons={multipleHistoricalRecords:records.length>1,otherSpace:records.some(r=>r.spaceId!==request.spaceId),
            nonTodaySection:records.some(r=>r.section!=='temporaryTabs'),pinMetadata:records.some(r=>!!r.pinnedState),nameMetadata:records.some(r=>!!r.nameOverride)};
        for(const [key,value] of Object.entries(reasons))if(value)counts[key]++;
        if(Object.values(reasons).some(Boolean))counts.blockedSelected++;
        if(!records.length)counts.noHistoricalUrlMatch++;
        if(tabs.filter(t=>t.url===entry.url || t.pendingUrl===entry.url).length>1)counts.liveUrlDuplicates++;
        if(m.recoveryCandidates.includes(entry.tabId))counts.recoveryFlagged++;
        if(m.provisional.includes(entry.tabId))counts.provisional++;
    }
    return validateDiagnosticReport({...result('stable'),counts});
}
export function registerSelectedRecoveryDiagnostics(store, api=chrome, {enabled=true}={}) {
    if(!enabled)return ()=>{};
    const observer=createRecoveryObserver(store,api);
    const listener=(request,sender,respond)=>{
        if(request?.type!==SELECTED_RECOVERY_DIAGNOSTIC)return false;
        if(!trustedRecoveryReader(api,sender) || sender.incognito===true || sender.url!==api.runtime.getURL('sidebar.html') || !validDiagnosticRequest(request)) {
            respond({success:false});return false;
        }
        observer.capture().then(async snapshot=>({report:diagnoseSelectedRecovery(snapshot,request),layoutReport:await diagnoseDurableLayout(snapshot)}))
            .then(result=>respond({success:true,...result}),()=>respond({success:false}));
        return true;
    };
    api.runtime.onMessage.addListener(listener);
    return ()=>{observer.dispose();api.runtime.onMessage.removeListener(listener);};
}
