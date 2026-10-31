import { encodeFavoriteContinuityState as encode } from './favorite-continuity.js';
import { readSpaceRankCheckpoint } from './space-continuity.js';
import { readExplicitCheckpoint, explicitTodayEpoch, explicitTodayOwner, stageExplicitToday } from './explicit-today-ownership.js';
import { getSpaceBookmarkFolder } from './space-bookmarks.js';
import { isStartupLauncherTab } from './startup-launcher-tab.js';

export const DURABLE_LAYOUT_KEY = 'spaceDurableTodayLayout';
const clone = value => structuredClone(value);
const hash = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(encode(value)))))
    .map(byte=>byte.toString(16).padStart(2,'0')).join('');
const text = value => typeof value==='string' && value.length>0 && value.length<=16384;
const integer = value => Number.isSafeInteger(value) && value>=0;
const nativeId = value => Number.isSafeInteger(value) && value>0;
const epochShape = value => value && text(value.epoch) && (value.kind==='session'
    ? Object.keys(value).length===2 : value.kind==='browser' && text(value.generation) && Object.keys(value).length===3);
const eligible = (store,tab) => tab && !tab.incognito && !tab.pinned && !store.isGlobalTab?.(tab) && !store.isGlobalTab?.(tab.id)
    && !store.isTransientTab?.(tab) && !isStartupLauncherTab(tab) && text(tab.url) && (!tab.pendingUrl || tab.pendingUrl===tab.url);
const signature = tabs => tabs.map(tab=>({index:tab.index,url:tab.url,pinned:!!tab.pinned})).sort((a,b)=>a.index-b.index);
function windows(store,tabs) {
    const groups=new Map();
    for(const tab of tabs)if(eligible(store,tab)){
        if(!groups.has(tab.windowId))groups.set(tab.windowId,[]);groups.get(tab.windowId).push(tab);
    }
    return [...groups].map(([id,tabs])=>({id,tabs:tabs.sort((a,b)=>a.index-b.index),signature:signature(tabs)}))
        .filter(w=>w.signature.every(t=>integer(t.index)) && new Set(w.signature.map(t=>t.index)).size===w.signature.length);
}
function validCohort(c) {
    return c && text(c.id) && Array.isArray(c.signature) && c.signature.length>0 && c.signature.length<=10000
        && c.signature.every(t=>integer(t.index)&&text(t.url)&&typeof t.pinned==='boolean')
        && new Set(c.signature.map(t=>t.index)).size===c.signature.length
        && Array.isArray(c.placements) && c.placements.length<=c.signature.length
        && c.placements.every(p=>integer(p.index)&&text(p.spaceId)&&text(p.bookmarkFolderId)&&integer(p.order)&&c.signature.some(t=>t.index===p.index))
        && new Set(c.placements.map(p=>p.index)).size===c.placements.length
        && (c.binding===null || c.binding && epochShape(c.binding.epoch) && nativeId(c.binding.windowId)
            && Array.isArray(c.binding.tabIds) && c.binding.tabIds.length===c.signature.length
            && c.binding.tabIds.every(nativeId) && new Set(c.binding.tabIds).size===c.binding.tabIds.length)
        && Array.isArray(c.overrides) && c.overrides.length<=10000
        && c.overrides.every(o=>nativeId(o.tabId)&&text(o.incarnation)&&epochShape(o.epoch))
        && (c.contextSubset===undefined||c.contextSubset===true)
        && (c.choiceRevision===undefined&&c.explicitOnly===undefined
            ||c.explicitOnly===true&&integer(c.choiceRevision)&&c.choiceRevision>0)
        && (c.blockedBy===undefined||Array.isArray(c.blockedBy)&&c.blockedBy.length<=1000&&c.blockedBy.every(text)&&new Set(c.blockedBy).size===c.blockedBy.length);
}
export async function readDurableLayout(value) {
    if(![1,2,3].includes(value?.version) || !integer(value.revision) || !Array.isArray(value.cohorts) || value.cohorts.length>1000
        || !value.cohorts.every(validCohort) || new Set(value.cohorts.map(c=>c.id)).size!==value.cohorts.length
        || value.cohorts.some(c=>(c.choiceRevision||0)>value.revision||(c.blockedBy||[]).some(id=>!value.cohorts.some(next=>next.id===id
            && next.choiceRevision>(c.choiceRevision||0)&&next.choiceRevision<=value.revision)))
        || value.fingerprint!==await hash({revision:value.revision,cohorts:value.cohorts,snapshotProof:value.snapshotProof}))return null;
    return clone(value);
}
async function sealed(revision,cohorts,snapshotProof=null) {
    // Older builds must fail closed rather than silently ignore precedence.
    return {version:3,revision,cohorts:clone(cohorts),snapshotProof,fingerprint:await hash({revision,cohorts,snapshotProof})};
}
function represents(cohort,record) {
    return record.section==='temporaryTabs' && !record.pinnedState && !record.nameOverride
        && cohort.binding?.tabIds.includes(record.tabId)
        && cohort.signature.some(t=>t.index===record.tabIndex&&t.url===record.url)
        && cohort.placements.some(p=>p.index===record.tabIndex&&p.spaceId===record.spaceId);
}
export function layoutContainsCurrent(store,record) {
    return (store.durableLayout?.cohorts||[]).some(c=>represents(c,record));
}
export async function durableRestartQueue(data) {
    const records=data.spaceTabSnapshot||[],layout=await readDurableLayout(data[DURABLE_LAYOUT_KEY]),proof=layout?.snapshotProof;
    if(!proof || !integer(proof.liveCount) || proof.liveCount>records.length || proof.rankFingerprint!==data.spaceRankCheckpoint?.fingerprint
        || !await readSpaceRankCheckpoint(data.spaceRankCheckpoint,records))return records;
    return records.filter((record,index)=>index>=proof.liveCount || !layout.cohorts.some(c=>represents(c,record)));
}
function root(store,p) {
    const found=store.spaces.filter(s=>s.id===p.spaceId&&s.bookmarkFolderId===p.bookmarkFolderId);
    return found.length===1&&!store.spaces.some(s=>s.id!==p.spaceId&&s.bookmarkFolderId===p.bookmarkFolderId)?found[0]:null;
}
// Import only a validated committed prefix, or unambiguous explicit-placement
// records left pending by the previous build. No historical metadata is imported.
async function importPrevious(store,data) {
    if(!await readSpaceRankCheckpoint(data.spaceRankCheckpoint,data.spaceTabSnapshot))return [];
    const prefix=await readExplicitCheckpoint(data);
    const records=prefix?prefix.live:(data.spaceTabSnapshot||[]).filter(r=>r.currentOwnership?.version===1
        && r.currentOwnership.spaceId===r.spaceId && r.currentOwnership.bookmarkFolderId===store.spaces.find(s=>s.id===r.spaceId)?.bookmarkFolderId);
    const result=[];
    for(const saved of data.spaceWindowSnapshot||[]){
        const matching=records.filter(r=>r.windowKey===saved.key&&r.section==='temporaryTabs'&&!r.pinnedState&&!r.nameOverride);
        if(!matching.length || !Array.isArray(saved.tabs) || new Set(matching.map(r=>r.tabIndex)).size!==matching.length)continue;
        const placements=matching.map(r=>({index:r.tabIndex,spaceId:r.spaceId,bookmarkFolderId:store.spaces.find(s=>s.id===r.spaceId)?.bookmarkFolderId,order:r.order}));
        // Legacy window evidence includes native pins; plain layout capture and
        // matching exclude them. Preserve absolute indices of ordinary slots.
        const cohort={id:crypto.randomUUID(),signature:signature(saved.tabs.filter(tab=>!tab.pinned)),placements,binding:null,overrides:[]};
        if(validCohort(cohort)&&matching.every(r=>saved.tabs.some(t=>t.index===r.tabIndex&&t.url===r.url))&&placements.every(p=>root(store,p)))result.push(cohort);
    }
    return result;
}
export async function initializeDurableLayout(store,data,tabs) {
    // A new initialization reads the committed baseline, never an abandoned plan.
    store.layoutWriteFence=null;
    const read=await readDurableLayout(data[DURABLE_LAYOUT_KEY]);
    if(data[DURABLE_LAYOUT_KEY]&&!read)throw new Error('Saved layout checkpoint is invalid. It was not overwritten.');
    store.durableLayout=read||await sealed(0,data[DURABLE_LAYOUT_KEY]?[]:await importPrevious(store,data));
    // Repair only the unbound import representation authored by the first layout
    // build. A pinned placement or bound cohort is not an import-only anchor.
    const projected=store.durableLayout.cohorts.map(c=>c.binding===null && c.signature.some(t=>t.pinned)
        && !c.placements.some(p=>c.signature.some(t=>t.index===p.index&&t.pinned))
        ? {...c,signature:c.signature.filter(t=>!t.pinned)} : c);
    if(projected.every(validCohort) && encode(projected)!==encode(store.durableLayout.cohorts))
        store.durableLayout=await sealed(store.durableLayout.revision+1,projected,store.durableLayout.snapshotProof);
    store.layoutPending=new Set();store.layoutProvisional=new Set();store.layoutRemovedIds ||= new Set();store.layoutRestored=new Set();
    const epoch=await explicitTodayEpoch(store), live=windows(store,tabs);
    for(const cohort of store.durableLayout.cohorts){
        const w=live.find(w=>w.id===cohort.binding?.windowId);
        if(w&&encode(cohort.binding.epoch)===encode(epoch)&&cohort.binding.tabIds.some(id=>store.layoutRemovedIds.has(id))
            && cohort.binding.tabIds.filter(id=>!store.layoutRemovedIds.has(id)).every(id=>w.tabs.some(t=>t.id===id))){
            const oldIds=cohort.binding.tabIds,oldSignature=cohort.signature;
            cohort.placements=cohort.placements.flatMap(p=>{
                const id=oldIds[oldSignature.findIndex(t=>t.index===p.index)],tab=w.tabs.find(t=>t.id===id);
                return tab?[{...p,index:tab.index}]:[];
            });
            const retained=cohort.contextSubset?w.tabs.filter(t=>oldIds.includes(t.id)):w.tabs;
            cohort.signature=signature(retained);cohort.binding.tabIds=retained.map(t=>t.id);
        }
        const bound=w?.tabs.filter(t=>cohort.binding?.tabIds.includes(t.id));
        const exact=w&&encode(cohort.binding.epoch)===encode(epoch)&&encode(cohort.binding.tabIds)===encode(bound.map(t=>t.id))
            && (cohort.contextSubset||bound.length===w.tabs.length)
            && cohort.placements.every(p=>root(store,p)?.temporaryTabs.includes(bound[cohort.signature.findIndex(t=>t.index===p.index)]?.id));
        if(!exact)store.layoutPending.add(cohort.id);
    }
}
export function layoutCandidate(store,tab) {
    if(!eligible(store,tab)||explicitTodayOwner(store,tab))return false;
    // Exact saved-pin ownership is independent of ordinary Today recovery.
    // Keep pins in window signatures, but never defer their saved snapshots.
    if(store.spaces.some(space=>space.spaceBookmarks.includes(tab.id)))return false;
    if((store.durableLayout?.cohorts||[]).some(c=>c.binding?.windowId===tab.windowId&&!store.layoutPending?.has(c.id)))return false;
    return (store.durableLayout?.cohorts||[]).some(c=>store.layoutPending?.has(c.id)
        && c.signature.some(t=>t.url===tab.url));
}
export function needsExplicitSubsetChoice(store,tab) {
    return (store.durableLayout?.cohorts||[]).some(c=>c.contextSubset&&c.binding?.windowId===tab.windowId
        && !store.layoutPending?.has(c.id)&&!c.binding.tabIds.includes(tab.id));
}
// Reserve possible restoring windows from cosmetic native projection. This is
// only a deferral, never evidence authorizing membership or historical identity.
export function pendingLayoutWindowIds(store,tabs) {
    const urls=new Set((store.durableLayout?.cohorts||[]).filter(c=>store.layoutPending?.has(c.id)).flatMap(c=>c.signature.map(t=>t.url)));
    const current=new Set((store.durableLayout?.cohorts||[]).filter(c=>c.explicitOnly&&c.binding&&!store.layoutPending?.has(c.id)).map(c=>c.binding.windowId));
    return new Set(tabs.filter(t=>eligible(store,t)&&urls.has(t.url)&&!current.has(t.windowId)).map(t=>t.windowId));
}
function partial(w,c) {
    let cursor=0;
    for(const live of w.signature){while(cursor<c.signature.length&&c.signature[cursor].url!==live.url)cursor++;if(cursor===c.signature.length)return false;cursor++;}
    return w.signature.length<c.signature.length;
}
export function orderedLayoutMapping(saved,native) {
    const same=(a,b)=>a.url===b.url&&a.pinned===b.pinned;
    const first=[],last=[];let cursor=0;
    for(const slot of saved){while(cursor<native.length&&!same(slot,native[cursor]))cursor++;if(cursor===native.length)return null;first.push(cursor++);}
    cursor=native.length-1;
    for(let i=saved.length-1;i>=0;i--){while(cursor>=0&&!same(saved[i],native[cursor]))cursor--;last[i]=cursor--;}
    return {indices:first,unique:first.every((n,i)=>n===last[i])};
}
const mappedTabs=(c,w)=>orderedLayoutMapping(c.signature,w.signature)?.indices.map(i=>w.tabs[i]);
export function layoutEvidence(cohorts,live) {
    const descendants=new Map();
    const byId=new Map(cohorts.map(c=>[c.id,c]));
    const mappings=new Map(cohorts.map(c=>[c.id,new Map(live.map(w=>[w,orderedLayoutMapping(c.signature,w.signature)]))]));
    const precedes=(old,current)=>{
        if(descendants.has(old.id))return descendants.get(old.id).has(current.id);
        const seen=new Set(),queue=[...(old.blockedBy||[])];
        while(queue.length){const id=queue.pop();if(seen.has(id))continue;seen.add(id);queue.push(...(byId.get(id)?.blockedBy||[]));}
        descendants.set(old.id,seen);return seen.has(current.id);
    };
    return cohorts.map(c=>{
        const matches=live.filter(w=>mappings.get(c.id).get(w));
        return {cohort:c,matches,status:matches.length===1&&mappings.get(c.id).get(matches[0]).unique
            &&cohorts.filter(other=>mappings.get(other.id).get(matches[0])&&!precedes(other,c)&&!precedes(c,other)).length===1?'ready'
            :matches.length?'ambiguous':live.some(w=>partial(w,c))?'incomplete':'changed'};
    });
}
export async function restoreDurableLayout(store,tabs) {
    if(!store.durableLayout)return;
    const live=windows(store,tabs);
    store.layoutProvisional=new Set(tabs.filter(tab=>layoutCandidate(store,tab)).map(t=>t.id));
    // Preserve candidate quarantine before suspending automatic application:
    // ordinary tracking must not substitute historical matching for this path.
    if(store.automaticLayoutRestore===false)return;
    const evidence=layoutEvidence(store.durableLayout.cohorts,live),plans=[];
    const {pinnedTabStatesById={}}=await chrome.storage.local.get('pinnedTabStatesById');
    const epoch=await explicitTodayEpoch(store);
    const overridesProven=(c,w)=>c.overrides.every(o=>w.tabs.some(t=>t.id===o.tabId&&explicitTodayOwner(store,t)&&store.explicitToday.get(t.id).incarnation===o.incarnation));
    const placeable=(c,w,states=pinnedTabStatesById)=>{const mapped=mappedTabs(c,w);return overridesProven(c,w)&&c.placements.length>0&&c.placements.every(p=>{
        const tab=mapped?.[c.signature.findIndex(t=>t.index===p.index)];
        return root(store,p)&&eligible(store,tab)&&!states[tab.id]?.bookmarkId
            && !(Number.isInteger(tab.splitViewId)&&tab.splitViewId>=0)&&!store.spaces.some(s=>s.spaceBookmarks.includes(tab.id));
    });};
    const precedenceAllows=(c,w,observations=evidence,currentEpoch=epoch,states=pinnedTabStatesById)=> (c.blockedBy||[]).every(id=>{
        const next=store.durableLayout.cohorts.find(n=>n.id===id);if(!next)return false;
        // Exact current-epoch ownership permits merging an older full baseline
        // around newer choices during partial startup, never overwriting them.
        const current=overridesProven(next,w)&&next.binding?.windowId===w.id&&encode(next.binding.epoch)===encode(currentEpoch)
            && !store.layoutPending.has(next.id)&&next.placements.length>0&&next.placements.every(p=>{
                const tab=w.tabs.find(t=>t.id===next.binding.tabIds[next.signature.findIndex(t=>t.index===p.index)]);
                return root(store,p)&&explicitTodayOwner(store,tab)&&store.explicitToday.get(tab.id).spaceId===p.spaceId;
            });
        if(current)return true;
        const proof=observations.find(e=>e.cohort.id===id);
        return proof?.status==='ready'&&proof.matches[0].id!==w.id&&placeable(next,proof.matches[0],states)&&precedenceAllows(next,proof.matches[0],observations,currentEpoch,states);
    });
    for(const item of evidence){
        const c=item.cohort;if(!store.layoutPending.has(c.id)||item.status!=='ready')continue;
        const w=item.matches[0];
        if(!precedenceAllows(c,w))continue;
        if(!overridesProven(c,w))continue;
        const mapped=mappedTabs(c,w);
        const placed=c.placements.map(p=>({p,tab:mapped[c.signature.findIndex(t=>t.index===p.index)]}));
        if(placed.some(({p,tab})=>!root(store,p)||!eligible(store,tab)||pinnedTabStatesById[tab.id]?.bookmarkId
            || Number.isInteger(tab.splitViewId)&&tab.splitViewId>=0
            || store.spaces.some(s=>s.spaceBookmarks.includes(tab.id))))continue;
        const window=await chrome.windows.get(w.id);if(window?.type!=='normal'||window.incognito)continue;
        for(const {p} of placed)await getSpaceBookmarkFolder(root(store,p));
        plans.push({c,w,placed,mapped});
    }
    if(!plans.length)return;
    const restoring=plans.flatMap(plan=>plan.placed).filter(({tab})=>!explicitTodayOwner(store,tab));
    const first=restoring[0];
    const stage=first?await stageExplicitToday(store,restoring.map(x=>x.tab),{spaceId:first.p.spaceId,bookmarkFolderId:first.p.bookmarkFolderId}):null;
    const validate=async()=>{
        if(stage&&encode(await explicitTodayEpoch(store))!==encode(stage.epoch))throw new Error('Layout epoch changed before restoration.');
        for(const plan of plans){
            const window=await chrome.windows.get(plan.w.id);
            if(window?.type!=='normal'||window.incognito)throw new Error('Native layout changed during restoration. Saved layout was retained.');
            for(const {p} of plan.placed)await getSpaceBookmarkFolder(root(store,p));
        }
        const metadata=await chrome.storage.local.get('pinnedTabStatesById');
        const currentEpoch=await explicitTodayEpoch(store);
        const fresh=windows(store,await store.queryTabs({}));
        const freshEvidence=layoutEvidence(store.durableLayout.cohorts,fresh);
        for(const plan of plans){
            const w=fresh.find(w=>w.id===plan.w.id);
            const proof=freshEvidence.find(e=>e.cohort.id===plan.c.id);
            if(!w||proof?.status!=='ready'||proof.matches[0].id!==w.id||!overridesProven(plan.c,w)
                ||encode(mappedTabs(plan.c,w)?.map(t=>t.id))!==encode(plan.mapped.map(t=>t.id))
                ||!precedenceAllows(plan.c,w,freshEvidence,currentEpoch,metadata.pinnedTabStatesById||{})||encode(w.signature)!==encode(plan.w.signature)||encode(w.tabs.map(t=>t.id))!==encode(plan.w.tabs.map(t=>t.id))
                || plan.placed.some(({p,tab})=>!root(store,p)||metadata.pinnedTabStatesById?.[tab.id]?.bookmarkId
                    || !eligible(store,w.tabs.find(t=>t.id===tab.id))||w.tabs.find(t=>t.id===tab.id)?.splitViewId!==tab.splitViewId))throw new Error('Native layout changed during restoration. Saved layout was retained.');
        }
    };
    await validate();
    for(const {p,tab} of restoring){
        for(const s of store.spaces)s.temporaryTabs=s.temporaryTabs.filter(id=>id!==tab.id);
        const witness=stage.bindings.get(tab.id);witness.spaceId=p.spaceId;witness.bookmarkFolderId=p.bookmarkFolderId;
        store.recoveryCandidates.delete(tab.id);store.provisional.delete(tab.id);store.layoutProvisional.delete(tab.id);
        store.restoredRanks.set(tab.id,p.order);
    }
    for(const s of store.spaces){
        const ordered=restoring.filter(x=>x.p.spaceId===s.id).sort((a,b)=>a.p.order-b.p.order).map(x=>x.tab.id);
        s.temporaryTabs=store.todayOrderInverted?s.temporaryTabs.concat(ordered):ordered.concat(s.temporaryTabs);
    }
    const affected=new Set(plans.flatMap(plan=>plan.placed.flatMap(({p,tab})=>[p.spaceId,...store.spaces.filter(s=>s.temporaryTabs.includes(tab.id)).map(s=>s.id)])));
    const restoredIds=new Set(restoring.map(x=>x.tab.id));
    for(const s of store.spaces)if(affected.has(s.id))s.temporaryTabs.forEach((id,index)=>{if(restoredIds.has(id)||explicitTodayOwner(store,tabs.find(t=>t.id===id)))store.restoredRanks.set(id,index);});
    if(stage){store.explicitToday=stage.bindings;store.explicitTodayEpoch=stage.epoch;store.explicitTodayEpochs=stage.epochs;}
    for(const {c,w,mapped} of plans){if(mapped.length<w.tabs.length)c.contextSubset=true;c.binding={epoch:await explicitTodayEpoch(store),windowId:w.id,tabIds:mapped.map(t=>t.id)};c.overrides=[];store.layoutPending.delete(c.id);store.layoutRestored.add(c.id);}
    store.layoutProvisional=new Set(tabs.filter(tab=>layoutCandidate(store,tab)).map(t=>t.id));
    store.layoutWriteFence=validate;
}
export async function captureDurableLayout(store,tabs,snapshot,rankFingerprint,{allowFreshExplicit=false}={}) {
    if(!store.durableLayout)store.durableLayout=await sealed(0,[]);
    store.layoutPending ||= new Set();store.layoutRemovedIds ||= new Set();
    const cohorts=clone(store.durableLayout.cohorts),live=windows(store,tabs);
    let epoch=null;const freshPlans=[];
    for(const w of live){
        const window=await chrome.windows.get(w.id);if(window?.type!=='normal'||window.incognito)continue;
        const existing=cohorts.filter(c=>c.binding?.windowId===w.id&&!store.layoutPending.has(c.id)).sort((a,b)=>(b.choiceRevision||0)-(a.choiceRevision||0))[0];
        const pending=cohorts.filter(c=>store.layoutPending.has(c.id)&&c.signature.some(t=>w.signature.some(n=>n.url===t.url)));
        const explicitExtra=allowFreshExplicit&&existing?.contextSubset&&w.tabs.some(t=>!existing.binding.tabIds.includes(t.id)&&explicitTodayOwner(store,t));
        const fresh=explicitExtra||allowFreshExplicit&&pending.length&&!existing&&w.tabs.some(t=>explicitTodayOwner(store,t));
        if(explicitExtra)pending.push(existing);
        if(pending.length&&!existing){
            if(!fresh)for(const c of pending)for(const tab of w.tabs)if(explicitTodayOwner(store,tab)){
                const b=store.explicitToday.get(tab.id);
                if(!c.overrides.some(o=>o.tabId===tab.id&&o.incarnation===b.incarnation))c.overrides.push({tabId:tab.id,incarnation:b.incarnation,epoch:clone(b.epoch)});
            }
            if(!fresh)continue;
        }
        // Missing IDs without an individual-close/move observation may be window
        // shutdown or incomplete native restoration. Preserve the full baseline.
        if(existing?.binding.tabIds.some(id=>!w.tabs.some(t=>t.id===id)&&!store.layoutRemovedIds.has(id)
            &&!tabs.some(t=>t.id===id&&(t.windowId!==w.id||t.pinned||store.isGlobalTab?.(t)||store.isGlobalTab?.(t.id)))))continue;
        const captureTabs=existing?.contextSubset?w.tabs.filter(t=>existing.binding.tabIds.includes(t.id)||fresh&&explicitTodayOwner(store,t)):w.tabs;
        const ownedIds=new Set(existing?.placements.map(p=>existing.binding.tabIds[existing.signature.findIndex(t=>t.index===p.index)])||[]);
        const placements=snapshot.filter(r=>r.section==='temporaryTabs'&&!r.pinnedState&&!r.nameOverride&&captureTabs.some(t=>t.id===r.tabId)
            &&(!existing?.contextSubset||fresh||ownedIds.has(r.tabId)||explicitTodayOwner(store,w.tabs.find(t=>t.id===r.tabId)))
            && (!(fresh||existing?.explicitOnly)||explicitTodayOwner(store,w.tabs.find(t=>t.id===r.tabId))))
            .map(r=>({index:w.tabs.find(t=>t.id===r.tabId).index,spaceId:r.spaceId,bookmarkFolderId:store.spaces.find(s=>s.id===r.spaceId)?.bookmarkFolderId,order:store.spaces.find(s=>s.id===r.spaceId).temporaryTabs.indexOf(r.tabId)}));
        if(!placements.length&&!existing)continue;
        epoch ||= await explicitTodayEpoch(store,true);
        const c={...(!fresh?existing:{}),id:!fresh&&existing?.id||crypto.randomUUID(),signature:signature(captureTabs),placements,binding:{epoch,windowId:w.id,tabIds:captureTabs.map(t=>t.id)},overrides:[],
            ...(explicitExtra?{contextSubset:true}:{}),
            ...(fresh?{choiceRevision:store.durableLayout.revision+1,explicitOnly:true}: {})};
        if(!validCohort(c))continue;
        if(fresh){
            const chosen=new Set(placements.map(p=>w.tabs.find(t=>t.index===p.index).url));
            for(const prior of pending)if(prior.placements.some(p=>chosen.has(prior.signature.find(t=>t.index===p.index)?.url)))
                prior.blockedBy=[...new Set([...(prior.blockedBy||[]),c.id])];
            freshPlans.push({c,w});
        }
        if(existing&&!fresh)cohorts[cohorts.indexOf(existing)]=c;else cohorts.push(c);
    }
    if(freshPlans.length){
        const previous=store.layoutWriteFence;
        store.layoutWriteFence=async()=>{
            if(previous)await previous();
            for(const {c,w} of freshPlans){
                const window=await chrome.windows.get(w.id);if(window?.type!=='normal'||window.incognito)throw new Error('Fresh window changed. Nothing was committed.');
                for(const p of c.placements)await getSpaceBookmarkFolder(root(store,p));
            }
            if(encode(await explicitTodayEpoch(store))!==encode(epoch))throw new Error('Fresh layout epoch changed. Nothing was committed.');
            const metadata=await chrome.storage.local.get(['pinnedTabStatesById','tabNameOverridesById']);
            const current=windows(store,await store.queryTabs({}));
            for(const {c,w} of freshPlans){const now=current.find(n=>n.id===w.id);
                if(!now||encode(now.signature)!==encode(w.signature)||encode(now.tabs.map(t=>t.id))!==encode(w.tabs.map(t=>t.id))
                    ||c.placements.some(p=>{const tab=now.tabs.find(t=>t.index===p.index);return !explicitTodayOwner(store,tab)
                        ||metadata.pinnedTabStatesById?.[tab.id]||metadata.tabNameOverridesById?.[tab.id]
                        ||Number.isInteger(tab.splitViewId)&&tab.splitViewId>=0;}))throw new Error('Fresh native layout changed. Nothing was committed.');
            }
        };
    }
    return sealed(store.durableLayout.revision+(encode(cohorts)!==encode(store.durableLayout.cohorts)?1:0),cohorts,{liveCount:snapshot.length,rankFingerprint});
}
