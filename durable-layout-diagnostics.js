import { DURABLE_LAYOUT_KEY,readDurableLayout,layoutEvidence } from './durable-today-layout.js';
import { isStartupLauncherTab } from './startup-launcher-tab.js';
export const LAYOUT_COUNT_KEYS=['confirmedWindowLayouts','confirmedTodayPlacements','pendingWindowLayouts','pendingTodayPlacements',
    'completeUniqueCandidates','incompleteCandidates','ambiguousCandidates','changedOrMissingCandidates','cohortsWithNewerChoices',
    'pendingExplicitHistoryRecords','pendingExplicitHistoryWithOrder','observedEligibleWindows','observedEligibleSlots',
    'pendingWithPinnedAnchors','indexOnlyMismatch','additionalNativeSlots','reorderedNativeSlots','noSequenceCorrespondence'];
export function validateLayoutDiagnostic(value){
    if(!value||value.schema!=='arcify-layout-diagnostic-v2'||Object.keys(value).length!==4
        || !['stable','changing','cold','incomplete'].includes(value.status))throw Error('Invalid layout diagnostic');
    if(value.status==='stable'){
        if(!value.counts||Object.keys(value.counts).length!==LAYOUT_COUNT_KEYS.length||LAYOUT_COUNT_KEYS.some(k=>!Number.isSafeInteger(value.counts[k])||value.counts[k]<0||value.counts[k]>1000000))throw Error('Invalid layout counts');
        if(!['enabled','disabled','unknown'].includes(value.nativeGroupSync))throw Error('Invalid group sync status');
    }else if(value.counts!==null||value.nativeGroupSync!==null)throw Error('Invalid layout diagnostic');
    return {schema:value.schema,status:value.status,counts:value.counts?Object.fromEntries(LAYOUT_COUNT_KEYS.map(k=>[k,value.counts[k]])):null,nativeGroupSync:value.nativeGroupSync};
}
const sequence=slots=>slots.map(t=>JSON.stringify([t.url,!!t.pinned]));
const equal=(a,b)=>a.length===b.length&&a.every((x,i)=>x===b[i]);
const contained=(a,b)=>{let i=0;for(const slot of b)if(a[i]===slot)i++;return i===a.length;};
// Explanatory relations only: these never authorize or feed restoration.
export function layoutMismatchCounts(evidence,live){
    const views=live.map(w=>{const values=sequence(w.signature);return {slots:w.signature,sequence:values,bag:[...values].sort()};});
    const relations=evidence.map(({cohort:c})=>{
        const saved=sequence(c.signature),bag=[...saved].sort();
        const comparisons=views.map(w=>({w,same:equal(saved,w.sequence),bag:equal(bag,w.bag),
            extra:w.sequence.length>saved.length&&contained(saved,w.sequence),missing:saved.length>w.sequence.length&&contained(w.sequence,saved)}));
        return {pinned:c.signature.some(t=>t.pinned),index:comparisons.some(x=>x.same&&c.signature.some((t,i)=>t.index!==x.w.slots[i].index)),
            extra:comparisons.some(x=>x.extra),reordered:comparisons.some(x=>x.bag&&!x.same),
            none:!comparisons.some(x=>x.same||x.bag||x.extra||x.missing)};
    });
    return {pendingWithPinnedAnchors:relations.filter(r=>r.pinned).length,indexOnlyMismatch:relations.filter(r=>r.index).length,
        additionalNativeSlots:relations.filter(r=>r.extra).length,reorderedNativeSlots:relations.filter(r=>r.reordered).length,
        noSequenceCorrespondence:relations.filter(r=>r.none).length};
}
export async function diagnoseDurableLayout(snapshot){
    const result=(status,counts=null)=>validateLayoutDiagnostic({schema:'arcify-layout-diagnostic-v2',status,counts,
        nativeGroupSync:status==='stable'?(snapshot.groupSyncEnabled===true?'enabled':snapshot.groupSyncEnabled===false?'disabled':'unknown'):null});
    if(!snapshot.stable)return result('changing');if(snapshot.scope!=='live-store')return result('cold');
    const raw=snapshot.local[DURABLE_LAYOUT_KEY];
    if(!Array.isArray(raw?.cohorts)||raw.cohorts.length>200||snapshot.tabs.length>10000
        ||raw.cohorts.reduce((n,c)=>n+(Array.isArray(c?.signature)?c.signature.length:20001),0)>20000
        ||raw.cohorts.reduce((n,c)=>n+(c?.blockedBy?.length||0),0)*raw.cohorts.length>1000000)return result('incomplete');
    const chars=slots=>slots.reduce((n,t)=>n+(typeof t?.url==='string'?t.url.length:0),0);
    const savedChars=raw.cohorts.reduce((n,c)=>n+chars(c.signature),0),liveChars=chars(snapshot.tabs);
    if(savedChars+liveChars>1000000)return result('incomplete');
    let layout;try{layout=await readDurableLayout(snapshot.local[DURABLE_LAYOUT_KEY]);}catch{return result('incomplete');}
    if(!layout||layout.fingerprint!==snapshot.memory.durableLayout?.fingerprint)return result('incomplete');
    const pending=new Set(snapshot.memory.layoutPending||[]),globalIds=new Set([
        ...(snapshot.memory.favoriteState?.bindings||[]),...(snapshot.memory.favoriteState?.attempts||[])
    ].map(b=>b.tabId));
    const groups=new Map();
    for(const tab of snapshot.tabs)if(!tab.incognito&&!tab.pinned&&!tab.knownTransient&&!globalIds.has(tab.id)
        && !isStartupLauncherTab(tab) && tab.url && (!tab.pendingUrl||tab.pendingUrl===tab.url)){
        if(!groups.has(tab.windowId))groups.set(tab.windowId,[]);groups.get(tab.windowId).push({index:tab.index,url:tab.url,pinned:!!tab.pinned});
    }
    const live=[...groups].map(([id,signature])=>({id,signature:signature.sort((a,b)=>a.index-b.index)}));
    if(live.length*layout.cohorts.length>10000
        ||savedChars*(layout.cohorts.length+live.length)+liveChars*layout.cohorts.length>8000000)return result('incomplete');
    const evidence=layoutEvidence(layout.cohorts,live).filter(e=>pending.has(e.cohort.id));
    const records=(snapshot.memory.restoreQueue||[]).filter(r=>r.currentOwnership?.version===1);
    return result('stable',{
        confirmedWindowLayouts:layout.cohorts.length,confirmedTodayPlacements:layout.cohorts.reduce((n,c)=>n+c.placements.length,0),
        pendingWindowLayouts:evidence.length,pendingTodayPlacements:evidence.reduce((n,e)=>n+e.cohort.placements.length,0),
        completeUniqueCandidates:evidence.filter(e=>e.status==='ready').length,incompleteCandidates:evidence.filter(e=>e.status==='incomplete').length,
        ambiguousCandidates:evidence.filter(e=>e.status==='ambiguous').length,changedOrMissingCandidates:evidence.filter(e=>e.status==='changed').length,
        cohortsWithNewerChoices:evidence.filter(e=>e.cohort.overrides.length||e.cohort.blockedBy?.length).length,
        pendingExplicitHistoryRecords:records.length,pendingExplicitHistoryWithOrder:records.filter(r=>Number.isSafeInteger(r.order)&&r.order>=0).length,
        observedEligibleWindows:live.length,observedEligibleSlots:live.reduce((n,w)=>n+w.signature.length,0),...layoutMismatchCounts(evidence,live)
    });
}
