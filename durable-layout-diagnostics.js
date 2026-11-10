import { DURABLE_LAYOUT_KEY,readDurableLayout,layoutEvidence,layoutWindows,layoutSpaceRoot,layoutMappedTabs,createLayoutRestoreGuards } from './durable-today-layout.js';
export const LAYOUT_GUARD_COUNT_KEYS=['readyBlockedByAutomaticRestore','readyBlockedByNewerChoices','readyBlockedByUnprovenOverrides',
    'readyBlockedBySpaceRoot','readyBlockedByBookmarkRoot','readyBlockedBySavedPin','readyBlockedByNativeSplit',
    'readyBlockedByWindow','readyPassingObservedGuards'];
export const LAYOUT_COUNT_KEYS=['confirmedWindowLayouts','confirmedTodayPlacements','pendingWindowLayouts','pendingTodayPlacements',
    'completeUniqueCandidates','incompleteCandidates','ambiguousCandidates','changedOrMissingCandidates','cohortsWithNewerChoices',
    'pendingExplicitHistoryRecords','pendingExplicitHistoryWithOrder','observedEligibleWindows','observedEligibleSlots',
    'pendingWithPinnedAnchors','indexOnlyMismatch','additionalNativeSlots','reorderedNativeSlots','noSequenceCorrespondence',
    'excludedGlobalSlots',...LAYOUT_GUARD_COUNT_KEYS];
export function validateLayoutDiagnostic(value){
    if(!value||value.schema!=='arcify-layout-diagnostic-v3'||Object.keys(value).length!==5
        || !['stable','changing','cold','incomplete'].includes(value.status))throw Error('Invalid layout diagnostic');
    if(value.status==='stable'){
        if(!value.counts||Object.keys(value.counts).length!==LAYOUT_COUNT_KEYS.length||LAYOUT_COUNT_KEYS.some(k=>!Number.isSafeInteger(value.counts[k])||value.counts[k]<0||value.counts[k]>1000000))throw Error('Invalid layout counts');
        if(!['enabled','disabled','unknown'].includes(value.nativeGroupSync)||!['enabled','disabled'].includes(value.automaticRestore))throw Error('Invalid group sync status');
    }else if(value.counts!==null||value.nativeGroupSync!==null||value.automaticRestore!==null)throw Error('Invalid layout diagnostic');
    return {schema:value.schema,status:value.status,counts:value.counts?Object.fromEntries(LAYOUT_COUNT_KEYS.map(k=>[k,value.counts[k]])):null,nativeGroupSync:value.nativeGroupSync,automaticRestore:value.automaticRestore};
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
// Inspect the same pure predicates as restoration, but never invoke its planner,
// native actions, bookmark helpers, epoch creation or persistence. A passing read
// is not a future restore promise: production still revalidates asynchronously.
function observedStore(snapshot,layout) {
    const m=snapshot.memory,byId=new Map(snapshot.tabs.map(tab=>[tab.id,tab]));
    return {spaces:m.spaces,durableLayout:layout,layoutPending:new Set(m.layoutPending),
        explicitToday:new Map(m.explicitToday),explicitTodayEpoch:m.explicitTodayEpoch,
        explicitTodayEpochs:m.explicitTodayEpochs,provisional:new Set(m.provisional||[]),
        isGlobalTab:value=>typeof value==='object'?value?.knownGlobal:byId.get(value)?.knownGlobalId,
        isTransientTab:value=>typeof value==='object'?value?.effectiveTransient:byId.get(value)?.effectiveTransient};
}
function refusalCounts(snapshot,store,evidence) {
    const counts=Object.fromEntries(LAYOUT_GUARD_COUNT_KEYS.map(key=>[key,0]));
    const states=snapshot.local.pinnedTabStatesById||{},roots=new Map(snapshot.layoutChecks.bookmarkRoots);
    const memberships=store.spaces.reduce((n,s)=>n+s.temporaryTabs.length+s.spaceBookmarks.length,0);
    const max=(key)=>Math.max(0,...store.durableLayout.cohorts.map(c=>(c[key]||[]).length));
    const workPerCheck=(1+max('blockedBy'))*(1+max('overrides')*(snapshot.tabs.length+memberships)
        +max('placements')*(snapshot.tabs.length+store.spaces.length+memberships));
    let work=evidence.length*workPerCheck;
    if(work>8000000)throw Error('Diagnostic work limit');
    const guards=createLayoutRestoreGuards(store,evidence,snapshot.layoutChecks.currentEpochs[0]||null,states,
        {onPrecedenceCheck:()=>{if((work+=workPerCheck)>8000000)throw Error('Diagnostic work limit');}});
    for(const item of evidence){
        if(!store.layoutPending.has(item.cohort.id)||item.status!=='ready')continue;
        const c=item.cohort,w=item.matches[0],mapped=layoutMappedTabs(c,w);
        const placed=c.placements.map(p=>({p,tab:mapped[c.signature.findIndex(t=>t.index===p.index)]}));
        const reasons={
            readyBlockedByAutomaticRestore:snapshot.memory.automaticLayoutRestore===false,
            readyBlockedByNewerChoices:!guards.precedenceAllows(c,w),
            readyBlockedByUnprovenOverrides:!guards.overridesProven(c,w),
            readyBlockedBySpaceRoot:placed.some(({p})=>!layoutSpaceRoot(store,p)),
            readyBlockedByBookmarkRoot:placed.some(({p})=>roots.get(p.bookmarkFolderId)!==true),
            readyBlockedBySavedPin:placed.some(({tab})=>states[tab.id]?.bookmarkId||store.spaces.some(s=>s.spaceBookmarks.includes(tab.id))),
            readyBlockedByNativeSplit:placed.some(({tab})=>Number.isInteger(tab.splitViewId)&&tab.splitViewId>=0),
            readyBlockedByWindow:!snapshot.windows.some(window=>window.id===w.id&&window.type==='normal'&&!window.incognito)
        };
        for(const [key,blocked] of Object.entries(reasons))if(blocked)counts[key]++;
        if(!Object.values(reasons).some(Boolean))counts.readyPassingObservedGuards++;
    }
    return counts;
}
export async function diagnoseDurableLayout(snapshot){
    // Matching uses every non-private native window, as production does. The
    // selected-tab/aggregate observer keeps its narrower normal-window view.
    if(snapshot.layoutChecks?.tabs)snapshot={...snapshot,tabs:snapshot.layoutChecks.tabs,windows:snapshot.layoutChecks.windows};
    const result=(status,counts=null)=>validateLayoutDiagnostic({schema:'arcify-layout-diagnostic-v3',status,counts,
        automaticRestore:status==='stable'?(snapshot.memory.automaticLayoutRestore===false?'disabled':'enabled'):null,
        nativeGroupSync:status==='stable'?(snapshot.groupSyncEnabled===true?'enabled':snapshot.groupSyncEnabled===false?'disabled':'unknown'):null});
    if(!snapshot.stable)return result('changing');if(snapshot.scope!=='live-store')return result('cold');
    const raw=snapshot.local[DURABLE_LAYOUT_KEY];
    if(!Array.isArray(raw?.cohorts)||raw.cohorts.length>200||snapshot.tabs.length>10000
        ||raw.cohorts.reduce((n,c)=>n+(Array.isArray(c?.signature)?c.signature.length:20001),0)>20000
        ||raw.cohorts.reduce((n,c)=>n+(Array.isArray(c?.overrides)?c.overrides.length:2001),0)>2000
        ||raw.cohorts.reduce((n,c)=>n+(c?.blockedBy?.length||0),0)*raw.cohorts.length>1000000)return result('incomplete');
    const chars=slots=>slots.reduce((n,t)=>n+(typeof t?.url==='string'?t.url.length:0),0);
    const savedChars=raw.cohorts.reduce((n,c)=>n+chars(c.signature),0),liveChars=chars(snapshot.tabs);
    if(savedChars+liveChars>1000000)return result('incomplete');
    let layout;try{layout=await readDurableLayout(snapshot.local[DURABLE_LAYOUT_KEY]);}catch{return result('incomplete');}
    if(!layout||layout.fingerprint!==snapshot.memory.durableLayout?.fingerprint)return result('incomplete');
    const m=snapshot.memory;
    if(!Array.isArray(m.spaces)||m.spaces.length>200||!m.spaces.every(s=>Array.isArray(s.temporaryTabs)&&Array.isArray(s.spaceBookmarks))
        ||m.spaces.reduce((n,s)=>n+s.temporaryTabs.length+s.spaceBookmarks.length,0)>20000
        ||!Array.isArray(m.explicitToday)||m.explicitToday.length>10000||!Array.isArray(m.layoutPending)
        ||!Array.isArray(snapshot.layoutChecks?.currentEpochs)||!Array.isArray(snapshot.layoutChecks?.bookmarkRoots)
        ||!Array.isArray(snapshot.windows)||snapshot.tabs.some(t=>typeof t.knownGlobal!=='boolean'||typeof t.knownGlobalId!=='boolean'||typeof t.effectiveTransient!=='boolean'))return result('incomplete');
    const store=observedStore(snapshot,layout),pending=store.layoutPending,live=layoutWindows(store,snapshot.tabs);
    if(live.length*layout.cohorts.length>10000
        ||savedChars*(layout.cohorts.length+live.length)+liveChars*layout.cohorts.length>8000000)return result('incomplete');
    const allEvidence=layoutEvidence(layout.cohorts,live),evidence=allEvidence.filter(e=>pending.has(e.cohort.id));
    let refusals;try{refusals=refusalCounts(snapshot,store,allEvidence);}catch{return result('incomplete');}
    const records=(snapshot.memory.restoreQueue||[]).filter(r=>r.currentOwnership?.version===1);
    return result('stable',{
        confirmedWindowLayouts:layout.cohorts.length,confirmedTodayPlacements:layout.cohorts.reduce((n,c)=>n+c.placements.length,0),
        pendingWindowLayouts:evidence.length,pendingTodayPlacements:evidence.reduce((n,e)=>n+e.cohort.placements.length,0),
        completeUniqueCandidates:evidence.filter(e=>e.status==='ready').length,incompleteCandidates:evidence.filter(e=>e.status==='incomplete').length,
        ambiguousCandidates:evidence.filter(e=>e.status==='ambiguous').length,changedOrMissingCandidates:evidence.filter(e=>e.status==='changed').length,
        cohortsWithNewerChoices:evidence.filter(e=>e.cohort.overrides.length||e.cohort.blockedBy?.length).length,
        pendingExplicitHistoryRecords:records.length,pendingExplicitHistoryWithOrder:records.filter(r=>Number.isSafeInteger(r.order)&&r.order>=0).length,
        excludedGlobalSlots:snapshot.tabs.filter(t=>t.knownGlobal||t.knownGlobalId).length,...refusals,
        observedEligibleWindows:live.length,observedEligibleSlots:live.reduce((n,w)=>n+w.signature.length,0),...layoutMismatchCounts(evidence,live)
    });
}
