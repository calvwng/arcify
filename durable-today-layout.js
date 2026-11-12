import { encodeFavoriteContinuityState as encode } from './favorite-continuity.js';
import { readSpaceRankCheckpoint } from './space-continuity.js';
import { readExplicitCheckpoint, explicitTodayEpoch, explicitTodayEpochs, explicitTodayOwner, stageExplicitToday, validExplicitWitness } from './explicit-today-ownership.js';
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
const nativeIdentityEligible = (store,tab) => tab && !tab.incognito && !tab.pinned && !store.isGlobalTab?.(tab) && !store.isGlobalTab?.(tab.id)
    && !store.isTransientTab?.(tab) && !isStartupLauncherTab(tab) && text(tab.url);
const eligible = (store,tab) => nativeIdentityEligible(store,tab) && (!tab.pendingUrl || tab.pendingUrl===tab.url);
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
    if(![1,2,3,4].includes(value?.version) || !integer(value.revision) || !Array.isArray(value.cohorts) || value.cohorts.length>1000
        || !value.cohorts.every(validCohort) || new Set(value.cohorts.map(c=>c.id)).size!==value.cohorts.length
        || value.cohorts.some(c=>(c.choiceRevision||0)>value.revision||(c.blockedBy||[]).some(id=>!value.cohorts.some(next=>next.id===id
            && next.choiceRevision>(c.choiceRevision||0)&&next.choiceRevision<=value.revision)))
        || value.fingerprint!==await hash({revision:value.revision,cohorts:value.cohorts,snapshotProof:value.snapshotProof,...(value.version===4?{retirements:value.retirements}:{})}))return null;
    if(value.version===4){
        if(!Array.isArray(value.retirements)||!value.retirements.length||value.retirements.length>1000
            ||new Set(value.retirements.map(r=>r?.cohortId)).size!==value.retirements.length)return null;
        for(const r of value.retirements){const c=value.cohorts.find(c=>c.id===r?.cohortId);
            if(!c?.contextSubset||!c.binding||r.reason!=='observed-individual-close'||!integer(r.revision)||r.revision<1||r.revision>value.revision
                ||Object.keys(r).sort().join(',')!=='closed,cohortFingerprint,cohortId,reason,revision'
                ||r.cohortFingerprint!==await hash(c)||!Array.isArray(r.closed)||r.closed.length!==c.binding.tabIds.length
                ||r.closed.some((x,i)=>!x||Object.keys(x).sort().join(',')!=='index,tabId,witness'||x.tabId!==c.binding.tabIds[i]
                    ||x.index!==c.signature[i].index||!validExplicitWitness(x.witness,c.binding.epoch)||x.witness.windowId!==c.binding.windowId))return null;
        }
    }else if(value.retirements!==undefined)return null;
    return clone(value);
}
export const sealDurableLayout = (revision,cohorts,snapshotProof=null,retirements=[]) => sealed(revision,cohorts,snapshotProof,retirements);
async function sealed(revision,cohorts,snapshotProof=null,retirements=[]) {
    // Older builds must fail closed rather than silently ignore precedence.
    const payload={revision,cohorts:clone(cohorts),snapshotProof,...(retirements.length?{retirements:clone(retirements)}:{})};
    return {version:retirements.length?4:3,...payload,fingerprint:await hash(payload)};
}
// Terminal records preserve historical negative authority, never live ownership.
export const layoutRetired = (layout,c) => !!layout?.retirements?.some(r=>r.cohortId===c.id);
const terminalUrlMatch = (store,tab) => !!tab&&(store.durableLayout?.cohorts||[]).some(c=>layoutRetired(store.durableLayout,c)&&c.signature.some(slot=>slot.url===tab.url));
export const terminalLayoutRefusal = (store,tab) => terminalUrlMatch(store,tab)&&!explicitTodayOwner(store,tab);
export async function assertDurableLayoutReadable(data) {
    if(data?.[DURABLE_LAYOUT_KEY]&&!await readDurableLayout(data[DURABLE_LAYOUT_KEY]))
        throw new Error('Saved layout checkpoint is invalid or requires a compatible build. No recovery was started.');
}
export function invalidateDurableCloseEvidence(store,...ids) {
    for(const id of ids){
        for(const records of store.layoutCloseEvidence?.values()||[])records.delete(id);
        store.layoutRemovedIds?.delete(id);
    }
}
// Called synchronously before onRemoved clears the current witness. Only the
// last verified committed cohort is evidence, never a mutable capture plan.
export function observeDurableIndividualClose(store,id,info) {
    if(info?.isWindowClosing!==false)return;
    const baseline=store.layoutCommittedBaseline,witness=store.explicitToday?.get(id);
    for(const c of baseline?.cohorts||[]){
        const slot=c.binding?.tabIds.indexOf(id) ?? -1;
        const records=(store.layoutCommittedSnapshot||[]).filter(r=>r.tabId===id&&r.section==='temporaryTabs');
        const record=records.length===1?records[0]:null;
        if(!record||encode(record.currentOwnership)!==encode(witness)||record.url!==c.signature[slot]?.url||record.tabIndex!==c.signature[slot]?.index
            ||!c.placements.some(p=>p.index===record.tabIndex&&p.spaceId===record.spaceId&&p.bookmarkFolderId===witness?.bookmarkFolderId)
            ||!c.contextSubset||layoutRetired(baseline,c)||slot<0||c.binding.windowId!==info.windowId
            ||!validExplicitWitness(witness,c.binding.epoch)||witness.windowId!==info.windowId
            ||!store.explicitTodayEpochs?.some(e=>encode(e)===encode(c.binding.epoch)))continue;
        const key=encode(c),observed=store.layoutCloseEvidence ||= new Map();
        if(!observed.has(key))observed.set(key,new Map());
        observed.get(key).set(id,{tabId:id,index:c.signature[slot].index,witness:clone(witness)});
    }
}
function retirementEvents() {
    return [chrome.storage.onChanged,chrome.tabs.onCreated,chrome.tabs.onRemoved,chrome.tabs.onReplaced,
        chrome.tabs.onUpdated,chrome.tabs.onAttached,chrome.tabs.onDetached,chrome.windows.onRemoved];
}
function observeRetirementFence() {
    let changed=false;const installed=[],invalidate=()=>{changed=true;};
    const stop=()=>{for(const event of installed)event.removeListener(invalidate);};
    try{for(const event of retirementEvents()){
        if(!event?.addListener||!event.removeListener)throw Error('Observed close validation is unavailable.');
        installed.push(event);event.addListener(invalidate);
    }}catch(error){stop();throw error;}
    return {stop,assertUnchanged(){if(changed)throw Error('Observed close evidence changed during validation.');}};
}
// Stage before any automatic restoration. A final fence rechecks the exact
// committed baseline and absence across all native windows. Missing proof defers.
export async function stageDurableExhaustion(store,tabs) {
    const baseline=store.layoutCommittedBaseline;
    if(!baseline||!store.durableLayout||!store.layoutCloseEvidence?.size||!retirementEvents().every(e=>e?.addListener&&e.removeListener))return;
    const epochs=await explicitTodayEpochs(store),retirements=clone(store.durableLayout.retirements||[]),added=[];
    for(const c of baseline.cohorts){
        if(!c.contextSubset||!c.binding||layoutRetired(store.durableLayout,c)
            ||!epochs.some(e=>encode(e)===encode(c.binding.epoch))||c.binding.tabIds.some(id=>tabs.some(t=>t.id===id)))continue;
        const observations=store.layoutCloseEvidence?.get(encode(c));
        if(!c.binding.tabIds.every(id=>observations?.has(id)))continue;
        const current=store.durableLayout.cohorts.find(x=>x.id===c.id);
        if(encode(current)!==encode(c)||baseline.revision>=Number.MAX_SAFE_INTEGER)continue;
        const closed=c.binding.tabIds.map(id=>clone(observations.get(id)));
        const record={cohortId:c.id,cohortFingerprint:await hash(c),reason:'observed-individual-close',revision:baseline.revision+1,closed};
        retirements.push(record);added.push({c,record});
    }
    if(!added.length)return;
    const next=await sealed(baseline.revision+1,store.durableLayout.cohorts,store.durableLayout.snapshotProof,retirements);
    if(!await readDurableLayout(next))throw Error('Terminal layout evidence is invalid. Nothing was committed.');
    store.durableLayout=next;store.layoutRetirementStaged=true;
    const previous=store.layoutRetirementFence;
    store.layoutRetirementFence=async()=>{
        if(previous)await previous();
        const observation=observeRetirementFence();try{
        const read=await chrome.storage.local.get([DURABLE_LAYOUT_KEY,'spaceTabSnapshot']);
        const committed=read[DURABLE_LAYOUT_KEY];
        const native=await store.queryTabs({}),currentEpochs=await explicitTodayEpochs(store);
        if(encode(committed)!==encode(baseline)||encode(read.spaceTabSnapshot||[])!==encode(store.layoutCommittedSnapshot||[])||added.some(({c,record})=>
            !currentEpochs.some(e=>encode(e)===encode(c.binding.epoch))||c.binding.tabIds.some(id=>native.some(t=>t.id===id))
            ||encode(c.binding.tabIds.map(id=>store.layoutCloseEvidence?.get(encode(c))?.get(id)))!==encode(record.closed)))
            throw Error('Observed close evidence changed. Nothing was committed.');
        observation.assertUnchanged();
        }finally{observation.stop();}
    };
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
    store.layoutWriteFence=null;store.layoutRetirementFence=null;store.layoutRetirementStaged=false;
    const read=await readDurableLayout(data[DURABLE_LAYOUT_KEY]);
    if(data[DURABLE_LAYOUT_KEY]&&!read)throw new Error('Saved layout checkpoint is invalid. It was not overwritten.');
    store.layoutCommittedBaseline=clone(read);store.layoutCommittedSnapshot=clone(data.spaceTabSnapshot||[]);
    store.durableLayout=read||await sealed(0,data[DURABLE_LAYOUT_KEY]?[]:await importPrevious(store,data));
    // Repair only the unbound import representation authored by the first layout
    // build. A pinned placement or bound cohort is not an import-only anchor.
    const projected=store.durableLayout.cohorts.map(c=>!layoutRetired(store.durableLayout,c)&&c.binding===null && c.signature.some(t=>t.pinned)
        && !c.placements.some(p=>c.signature.some(t=>t.index===p.index&&t.pinned))
        ? {...c,signature:c.signature.filter(t=>!t.pinned)} : c);
    if(projected.every(validCohort) && encode(projected)!==encode(store.durableLayout.cohorts))
        store.durableLayout=await sealed(store.durableLayout.revision+1,projected,store.durableLayout.snapshotProof,store.durableLayout.retirements);
    store.layoutPending=new Set();store.layoutProvisional=new Set();store.layoutRemovedIds ||= new Set();store.layoutRestored=new Set();
    await stageDurableExhaustion(store,tabs);
    const epochs=await explicitTodayEpochs(store), live=windows(store,tabs);
    const accepted=c=>epochs.some(epoch=>encode(c.binding?.epoch)===encode(epoch));
    for(const cohort of store.durableLayout.cohorts){
        if(layoutRetired(store.durableLayout,cohort))continue;
        const w=live.find(w=>w.id===cohort.binding?.windowId);
        if(w&&accepted(cohort)&&cohort.binding.tabIds.some(id=>store.layoutRemovedIds.has(id))
            && cohort.binding.tabIds.filter(id=>!store.layoutRemovedIds.has(id)).every(id=>w.tabs.some(t=>t.id===id))){
            const oldIds=cohort.binding.tabIds,oldSignature=cohort.signature;
            const retained=cohort.contextSubset?w.tabs.filter(t=>oldIds.includes(t.id)):w.tabs;
            if(!retained.length){store.layoutPending.add(cohort.id);continue;}
            cohort.placements=cohort.placements.flatMap(p=>{
                const id=oldIds[oldSignature.findIndex(t=>t.index===p.index)],tab=w.tabs.find(t=>t.id===id);
                return tab?[{...p,index:tab.index}]:[];
            });
            cohort.signature=signature(retained);cohort.binding.tabIds=retained.map(t=>t.id);
        }
        // A live same-epoch binding proves native identity, not the old strip
        // order or URL. Reorder/navigation can wake a fresh worker. Retain its
        // current capture authority by ID; cold restoration still uses strict
        // settled-URL sequence matching. A navigating member is not missing:
        // capture's incomplete-window guard defers writes until it settles.
        const identityTabs=tabs.filter(t=>t.windowId===cohort.binding?.windowId&&nativeIdentityEligible(store,t));
        const bound=cohort.binding?.tabIds.map(id=>identityTabs.find(t=>t.id===id));
        const exact=accepted(cohort)&&bound?.every(Boolean)
            && new Set(identityTabs.map(t=>t.id)).size===identityTabs.length
            && (cohort.contextSubset||bound.length===identityTabs.length)
            && cohort.placements.every(p=>{
                const id=bound[cohort.signature.findIndex(t=>t.index===p.index)]?.id;
                return root(store,p)?.temporaryTabs.includes(id)
                    &&store.spaces.flatMap(s=>[...s.temporaryTabs,...s.spaceBookmarks]).filter(n=>n===id).length===1;
            });
        if(!exact)store.layoutPending.add(cohort.id);
    }
}
export function layoutCandidate(store,tab) {
    if(!eligible(store,tab)||explicitTodayOwner(store,tab))return false;
    // Exact saved-pin ownership is independent of ordinary Today recovery.
    // Keep pins in window signatures, but never defer their saved snapshots.
    if(store.spaces.some(space=>space.spaceBookmarks.includes(tab.id)))return false;
    if((store.durableLayout?.cohorts||[]).some(c=>layoutRetired(store.durableLayout,c)&&c.signature.some(t=>t.url===tab.url)))return true;
    if((store.durableLayout?.cohorts||[]).some(c=>!layoutRetired(store.durableLayout,c)&&c.binding?.windowId===tab.windowId&&!store.layoutPending?.has(c.id)))return false;
    return (store.durableLayout?.cohorts||[]).some(c=>store.layoutPending?.has(c.id)
        && c.signature.some(t=>t.url===tab.url));
}
export function needsExplicitSubsetChoice(store,tab) {
    return (store.durableLayout?.cohorts||[]).some(c=>!layoutRetired(store.durableLayout,c)&&(c.contextSubset||c.explicitOnly)&&c.binding?.windowId===tab.windowId
        &&!store.layoutPending?.has(c.id)&&!c.placements.some(p=>c.binding.tabIds[c.signature.findIndex(slot=>slot.index===p.index)]===tab.id));
}
// Reserve possible restoring windows from cosmetic native projection. This is
// only a deferral, never evidence authorizing membership or historical identity.
export function pendingLayoutWindowIds(store,tabs,epochs=[]) {
    const urls=new Set((store.durableLayout?.cohorts||[]).filter(c=>store.layoutPending?.has(c.id)||layoutRetired(store.durableLayout,c)).flatMap(c=>c.signature.map(t=>t.url)));
    const current=new Set((store.durableLayout?.cohorts||[]).filter(c=>!layoutRetired(store.durableLayout,c)&&c.explicitOnly&&c.binding&&!store.layoutPending?.has(c.id)).map(c=>c.binding.windowId));
    // Ordinary full-window captures are current authority too. Release only an
    // exact live binding, never a window-ID or URL-only historical match. A
    // subset cannot authorize projection of its unproven neighbours.
    const live=windows(store,tabs);
    for(const c of store.durableLayout?.cohorts||[]){
        if(layoutRetired(store.durableLayout,c)||c.explicitOnly||c.contextSubset||!c.binding||store.layoutPending?.has(c.id))continue;
        const w=live.find(w=>w.id===c.binding.windowId);
        if(w&&!w.tabs.some(tab=>store.provisional?.has(tab.id)||store.recoveryCandidates?.has(tab.id)
                ||store.layoutProvisional?.has(tab.id)&&!explicitTodayOwner(store,tab))
            &&epochs.some(epoch=>epoch&&encode(epoch)===encode(c.binding.epoch))
            &&encode(c.binding.tabIds)===encode(w.tabs.map(t=>t.id))&&encode(c.signature)===encode(w.signature)
            &&c.placements.length&&c.placements.every(p=>{
                const tab=w.tabs[c.signature.findIndex(t=>t.index===p.index)],space=root(store,p);
                return tab&&space?.temporaryTabs.includes(tab.id)
                    &&store.spaces.filter(s=>s.temporaryTabs.includes(tab.id)||s.spaceBookmarks.includes(tab.id)).length===1;
            }))current.add(w.id);
    }
    return new Set(tabs.filter(t=>eligible(store,t)&&(terminalLayoutRefusal(store,t)||urls.has(t.url)&&!current.has(t.windowId))).map(t=>t.windowId));
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
export function layoutEvidence(cohorts,live,retirements=[]) {
    const retired=c=>retirements.some(r=>r.cohortId===c.id);
    const descendants=new Map();
    const byId=new Map(cohorts.map(c=>[c.id,c]));
    const mappings=new Map(cohorts.map(c=>[c.id,new Map(live.map(w=>[w,retired(c)?null:orderedLayoutMapping(c.signature,w.signature)]))]));
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
// Pure predicates shared by restoration and the read-only diagnostic. No API reads or writes.
export function createLayoutRestoreGuards(store,evidence,epoch,pinnedTabStatesById={}, {onPrecedenceCheck=()=>{}}={}) {
    const overridesProven=(c,w)=>c.overrides.every(o=>w.tabs.some(t=>t.id===o.tabId&&explicitTodayOwner(store,t)&&store.explicitToday.get(t.id).incarnation===o.incarnation));
    const placeable=(c,w,states=pinnedTabStatesById)=>{const mapped=mappedTabs(c,w);return overridesProven(c,w)&&c.placements.length>0&&c.placements.every(p=>{
        const tab=mapped?.[c.signature.findIndex(t=>t.index===p.index)];
        return !layoutRetired(store.durableLayout,c)&&!terminalLayoutRefusal(store,tab)&&root(store,p)&&eligible(store,tab)&&!states[tab.id]?.bookmarkId
            && !(Number.isInteger(tab.splitViewId)&&tab.splitViewId>=0)&&!store.spaces.some(s=>s.spaceBookmarks.includes(tab.id));
    });};
    const precedenceAllows=(c,w,observations=evidence,currentEpoch=epoch,states=pinnedTabStatesById)=> { onPrecedenceCheck(); return (c.blockedBy||[]).every(id=>{
        const next=store.durableLayout.cohorts.find(n=>n.id===id);if(!next||layoutRetired(store.durableLayout,next))return false;
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
    }); };
    return {overridesProven,placeable,precedenceAllows};
}
export { eligible as layoutEligible, windows as layoutWindows, root as layoutSpaceRoot, mappedTabs as layoutMappedTabs };

export async function restoreDurableLayout(store,tabs) {
    if(!store.durableLayout)return;
    const live=windows(store,tabs);
    store.layoutProvisional=new Set(tabs.filter(tab=>layoutCandidate(store,tab)).map(t=>t.id));
    // Preserve candidate quarantine before suspending automatic application:
    // ordinary tracking must not substitute historical matching for this path.
    if(store.automaticLayoutRestore===false)return;
    const independentOwners=new Map(tabs.filter(t=>explicitTodayOwner(store,t)).map(t=>[t.id,encode(store.explicitToday.get(t.id))]));
    const evidence=layoutEvidence(store.durableLayout.cohorts,live,store.durableLayout.retirements),plans=[];
    const {pinnedTabStatesById={}}=await chrome.storage.local.get('pinnedTabStatesById');
    const epoch=await explicitTodayEpoch(store);
    const {overridesProven,placeable,precedenceAllows}=createLayoutRestoreGuards(store,evidence,epoch,pinnedTabStatesById);
    for(const item of evidence){
        const c=item.cohort;if(layoutRetired(store.durableLayout,c)||!store.layoutPending.has(c.id)||item.status!=='ready')continue;
        const w=item.matches[0];
        if(!precedenceAllows(c,w))continue;
        if(!overridesProven(c,w))continue;
        const mapped=mappedTabs(c,w);
        const placed=c.placements.map(p=>({p,tab:mapped[c.signature.findIndex(t=>t.index===p.index)]}));
        if(placed.some(({p,tab})=>terminalLayoutRefusal(store,tab)||!root(store,p)||!eligible(store,tab)||pinnedTabStatesById[tab.id]?.bookmarkId
            || Number.isInteger(tab.splitViewId)&&tab.splitViewId>=0
            || store.spaces.some(s=>s.spaceBookmarks.includes(tab.id))))continue;
        const window=await chrome.windows.get(w.id);if(window?.type!=='normal'||window.incognito)continue;
        for(const {p} of placed)await getSpaceBookmarkFolder(root(store,p));
        plans.push({c,w,placed,mapped});
    }
    if(!plans.length)return;
    // A changed window context can make a cohort pending even though exact
    // same-epoch members were replayed already. Do not remove/reinsert those
    // members: their canonical order may interleave tabs from other windows.
    const retained=[];
    const uniquelyOwned=({p,tab})=>root(store,p)?.temporaryTabs.includes(tab.id)
        &&store.spaces.filter(s=>s.temporaryTabs.includes(tab.id)||s.spaceBookmarks.includes(tab.id)).length===1
        &&!store.spaces.some(s=>s.spaceBookmarks.includes(tab.id));
    const restoring=plans.flatMap(plan=>plan.placed.filter(item=>{
        if(explicitTodayOwner(store,item.tab))return false;
        if(encode(plan.c.binding?.epoch)===encode(epoch)
            &&plan.c.binding?.tabIds[plan.c.signature.findIndex(t=>t.index===item.p.index)]===item.tab.id
            &&uniquelyOwned(item)){retained.push({plan,...item});return false;}
        return true;
    }));
    const first=restoring[0];
    const stage=first?await stageExplicitToday(store,restoring.map(x=>x.tab),{spaceId:first.p.spaceId,bookmarkFolderId:first.p.bookmarkFolderId}):null;
    const validate=async()=>{
        if(plans.some(plan=>plan.placed.some(({tab})=>terminalLayoutRefusal(store,tab))))throw Error('Terminal close intent prevents restoration.');
        if(stage&&encode(await explicitTodayEpoch(store))!==encode(stage.epoch))throw new Error('Layout epoch changed before restoration.');
        for(const plan of plans){
            const window=await chrome.windows.get(plan.w.id);
            if(window?.type!=='normal'||window.incognito)throw new Error('Native layout changed during restoration. Saved layout was retained.');
            for(const {p} of plan.placed)await getSpaceBookmarkFolder(root(store,p));
        }
        const metadata=await chrome.storage.local.get('pinnedTabStatesById');
        const currentEpoch=await explicitTodayEpoch(store);
        const fresh=windows(store,await store.queryTabs({}));
        const freshEvidence=layoutEvidence(store.durableLayout.cohorts,fresh,store.durableLayout.retirements);
        for(const plan of plans){
            const w=fresh.find(w=>w.id===plan.w.id);
            const proof=freshEvidence.find(e=>e.cohort.id===plan.c.id);
            if(!w||proof?.status!=='ready'||proof.matches[0].id!==w.id||!overridesProven(plan.c,w)
                ||encode(mappedTabs(plan.c,w)?.map(t=>t.id))!==encode(plan.mapped.map(t=>t.id))
                ||!precedenceAllows(plan.c,w,freshEvidence,currentEpoch,metadata.pinnedTabStatesById||{})||encode(w.signature)!==encode(plan.w.signature)||encode(w.tabs.map(t=>t.id))!==encode(plan.w.tabs.map(t=>t.id))
                || plan.placed.some(({p,tab})=>!root(store,p)||metadata.pinnedTabStatesById?.[tab.id]?.bookmarkId
                    || !eligible(store,w.tabs.find(t=>t.id===tab.id))||w.tabs.find(t=>t.id===tab.id)?.splitViewId!==tab.splitViewId))throw new Error('Native layout changed during restoration. Saved layout was retained.');
        }
        if(retained.length&&(encode(await explicitTodayEpoch(store))!==encode(epoch)
            ||retained.some(item=>encode(item.plan.c.binding?.epoch)!==encode(epoch)
                ||item.plan.c.binding?.tabIds[item.plan.c.signature.findIndex(t=>t.index===item.p.index)]!==item.tab.id
                ||!uniquelyOwned(item))))throw new Error('Current ownership changed during layout retention.');
        if(plans.some(plan=>plan.placed.some(({tab})=>terminalUrlMatch(store,tab)&&(!independentOwners.has(tab.id)
            ||independentOwners.get(tab.id)!==encode(store.explicitToday.get(tab.id))||!explicitTodayOwner(store,tab)))))throw Error('Terminal close intent prevents restoration.');
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
export async function captureDurableLayout(store,tabs,snapshot,rankFingerprint,{allowFreshExplicit=false,provenContextOnly=false,explicitIntentIds=[]}={}) {
    if(!store.durableLayout)store.durableLayout=await sealed(0,[]);
    store.layoutPending ||= new Set();store.layoutRemovedIds ||= new Set();
    const cohorts=clone(store.durableLayout.cohorts),live=windows(store,tabs);
    let epoch=null;const freshPlans=[],intentIds=new Set(explicitIntentIds);
    const currentEpochs=allowFreshExplicit&&provenContextOnly?await explicitTodayEpochs(store):[];
    for(const w of live){
        const window=await chrome.windows.get(w.id);if(window?.type!=='normal'||window.incognito)continue;
        const existing=cohorts.filter(c=>!layoutRetired(store.durableLayout,c)&&c.binding?.windowId===w.id&&!store.layoutPending.has(c.id)).sort((a,b)=>(b.choiceRevision||0)-(a.choiceRevision||0))[0];
        const pending=cohorts.filter(c=>!layoutRetired(store.durableLayout,c)&&store.layoutPending.has(c.id)&&c.signature.some(t=>w.signature.some(n=>n.url===t.url)));
        const ownedIds=new Set(existing?.placements.map(p=>existing.binding.tabIds[existing.signature.findIndex(t=>t.index===p.index)])||[]);
        const intent=w.tabs.filter(t=>intentIds.has(t.id)&&explicitTodayOwner(store,t));
        const actualOwner=tab=>explicitTodayOwner(store,tab)&&currentEpochs.some(e=>encode(e)===encode(store.explicitToday.get(tab.id).epoch));
        const explicitExtra=allowFreshExplicit&&existing?.contextSubset&&intent.some(t=>!ownedIds.has(t.id));
        // Only exact new intent can expand or supersede a current cohort. Replay
        // witnesses prove current membership, not an additional durable choice.
        const explicitRecapture=allowFreshExplicit&&intent.length>0&&provenContextOnly&&existing?.explicitOnly&&!existing.contextSubset&&!existing.blockedBy?.length
            &&currentEpochs.some(e=>encode(e)===encode(existing.binding.epoch))&&intent.some(actualOwner);
        // A pending same-epoch baseline can be re-encoded without widening only
        // when every previous placement has exact current native-ID proof. Never
        // select its scope by URLs, or advance an unresolved newer-choice edge.
        const replayScopes=allowFreshExplicit&&provenContextOnly&&!existing?pending.filter(c=>c.binding?.windowId===w.id
            &&!c.blockedBy?.length&&currentEpochs.some(e=>encode(e)===encode(c.binding.epoch))&&c.placements.length
            &&c.placements.every(p=>{
                const tab=w.tabs.find(t=>t.id===c.binding.tabIds[c.signature.findIndex(slot=>slot.index===p.index)]);
                return actualOwner(tab)&&(intentIds.has(tab.id)||root(store,p)?.temporaryTabs.includes(tab.id)
                    &&store.explicitToday.get(tab.id).spaceId===p.spaceId);
            })&&(!c.overrides.length||intent.length>0&&c.overrides.every(o=>{
                const tab=w.tabs.find(t=>t.id===o.tabId),witness=store.explicitToday.get(o.tabId);
                return actualOwner(tab)&&witness.incarnation===o.incarnation&&encode(witness.epoch)===encode(o.epoch)
                    &&(intentIds.has(o.tabId)||c.placements.some(p=>c.binding.tabIds[c.signature.findIndex(slot=>slot.index===p.index)]===o.tabId));
            }))):[];
        const replayScope=replayScopes.length===1?replayScopes[0]:null;
        const fresh=explicitExtra||explicitRecapture||allowFreshExplicit&&pending.length&&!existing&&(intent.length>0||!!replayScope);
        if(explicitExtra||explicitRecapture)pending.push(existing);
        const scopeIds=new Set([...ownedIds,...intent.map(t=>t.id),...(!existing&&replayScope?replayScope.placements.map(p=>replayScope.binding.tabIds[replayScope.signature.findIndex(slot=>slot.index===p.index)]):[])]);
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
        const captureTabs=provenContextOnly&&fresh?w.tabs.filter(t=>scopeIds.has(t.id)&&explicitTodayOwner(store,t))
            :existing?.contextSubset?w.tabs.filter(t=>existing.binding.tabIds.includes(t.id)||fresh&&scopeIds.has(t.id)&&explicitTodayOwner(store,t)):w.tabs;
        const placements=snapshot.filter(r=>r.section==='temporaryTabs'&&!r.pinnedState&&!r.nameOverride&&captureTabs.some(t=>t.id===r.tabId)
            &&(!(existing?.contextSubset||existing?.explicitOnly)||ownedIds.has(r.tabId)||intentIds.has(r.tabId))
            && (!(fresh||existing?.explicitOnly)||explicitTodayOwner(store,w.tabs.find(t=>t.id===r.tabId))))
            .map(r=>({index:w.tabs.find(t=>t.id===r.tabId).index,spaceId:r.spaceId,bookmarkFolderId:store.spaces.find(s=>s.id===r.spaceId)?.bookmarkFolderId,order:store.spaces.find(s=>s.id===r.spaceId).temporaryTabs.indexOf(r.tabId)}));
        if(!placements.length&&!existing)continue;
        if((!existing||fresh)&&cohorts.length>=1000||fresh&&store.durableLayout.revision>=Number.MAX_SAFE_INTEGER)
            throw new Error('Layout checkpoint exceeds its supported limits. Nothing was committed.');
        epoch ||= await explicitTodayEpoch(store,true);
        const c={...(!fresh?existing:{}),id:!fresh&&existing?.id||crypto.randomUUID(),signature:signature(captureTabs),placements,binding:{epoch,windowId:w.id,tabIds:captureTabs.map(t=>t.id)},overrides:[],
            ...(explicitExtra||provenContextOnly&&fresh?{contextSubset:true}:{}),
            ...(fresh?{choiceRevision:store.durableLayout.revision+1,explicitOnly:true}: {})};
        if(!validCohort(c))continue;
        if(fresh){
            const chosen=new Set(placements.map(p=>w.tabs.find(t=>t.index===p.index).url));
            for(const prior of replayScope&&!intent.length?[replayScope]:pending)if(prior.placements.some(p=>chosen.has(prior.signature.find(t=>t.index===p.index)?.url)))
                prior.blockedBy=[...new Set([...(prior.blockedBy||[]),c.id])];
            const witnesses=new Map(captureTabs.filter(t=>explicitTodayOwner(store,t)).map(t=>[t.id,encode(store.explicitToday.get(t.id))]));
            freshPlans.push({c,w,witnesses});
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
            const metadata=await chrome.storage.local.get(['pinnedTabStatesById','tabNameOverridesById']);
            const current=windows(store,await store.queryTabs({}));
            // A secondary proof can expire during either awaited read even if
            // the preferred browser epoch survives. Check all epochs last.
            const acceptedEpochs=await explicitTodayEpochs(store);
            if(encode(acceptedEpochs[0]||null)!==encode(epoch))throw new Error('Fresh layout epoch changed. Nothing was committed.');
            for(const {c,w,witnesses} of freshPlans){const now=current.find(n=>n.id===w.id);
                if(!now||encode(now.signature)!==encode(w.signature)||encode(now.tabs.map(t=>t.id))!==encode(w.tabs.map(t=>t.id))
                    ||[...witnesses].some(([id,proof])=>encode(store.explicitToday.get(id))!==proof)
                    ||provenContextOnly&&c.binding.tabIds.some(id=>!explicitTodayOwner(store,now.tabs.find(t=>t.id===id))
                        ||!acceptedEpochs.some(e=>encode(e)===encode(store.explicitToday.get(id)?.epoch)))
                    ||c.placements.some(p=>{const tab=now.tabs.find(t=>t.index===p.index);return !explicitTodayOwner(store,tab)
                        ||!acceptedEpochs.some(e=>encode(e)===encode(store.explicitToday.get(tab.id)?.epoch))
                        ||store.explicitToday.get(tab.id).spaceId!==p.spaceId||store.explicitToday.get(tab.id).bookmarkFolderId!==p.bookmarkFolderId
                        ||root(store,p)?.temporaryTabs.indexOf(tab.id)!==p.order
                        ||metadata.pinnedTabStatesById?.[tab.id]||metadata.tabNameOverridesById?.[tab.id]
                        ||Number.isInteger(tab.splitViewId)&&tab.splitViewId>=0;}))throw new Error('Fresh native layout changed. Nothing was committed.');
            }
        };
    }
    const next=await sealed(store.durableLayout.revision+(encode(cohorts)!==encode(store.durableLayout.cohorts)?1:0),cohorts,{liveCount:snapshot.length,rankFingerprint},store.durableLayout.retirements);
    if(!await readDurableLayout(next))throw new Error('Layout checkpoint exceeds its supported limits. Nothing was committed.');
    return next;
}
