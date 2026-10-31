import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './today-recovery-fixture.js';
import { SpaceStore } from '../../space-store.js';
import { moveTodayTabsToSpace } from '../../today-move-store.js';
import { DURABLE_LAYOUT_KEY,readDurableLayout,layoutEvidence,orderedLayoutMapping } from '../../durable-today-layout.js';
import { diagnoseDurableLayout,validateLayoutDiagnostic } from '../../durable-layout-diagnostics.js';
import { encodeFavoriteContinuityState as encode } from '../../favorite-continuity.js';
import { syncSpaceGroups } from '../../tab-group-sync.js';
const owner=(store,id)=>store.spaces.find(s=>s.temporaryTabs.includes(id))?.id;
const event=()=>({listeners:[],addListener(fn){this.listeners.push(fn);},async emit(...args){await Promise.all(this.listeners.map(fn=>fn(...args)));}});
function events(){
    for(const key of ['onCreated','onUpdated','onRemoved','onReplaced','onActivated','onMoved','onAttached','onDetached'])chrome.tabs[key]=event();
    for(const key of ['onRemoved','onUpdated'])chrome.tabGroups[key]=event();chrome.storage.onChanged=event();
}
async function setup(residual=1,inverted=false){
    const f=fixture({inverted});for(const t of f.tabs.filter(t=>t.windowId===20))t.url='https://other-window.test/'+t.id;const ids=[101,102,103,104,105,106,107],all=[...ids,...residual?[108]:[]];
    for(const id of all)f.tabs.push({id,index:f.tabs.length,windowId:10,url:`https://layout.test/${id}`,pinned:false,incognito:false,splitViewId:-1});
    f.store.spaces[0].temporaryTabs.push(...all);f.store.windowKeys=new Map([[10,'current'],[20,'other']]);f.store.restoreWindowKeys=new Map();
    f.store.restoreQueue=all.flatMap((id,i)=>Array.from({length:i<5?2:1},(_,j)=>({tabId:id,url:`https://layout.test/${id}`,spaceId:i<6?'target':'source',section:'temporaryTabs',windowKey:`old-${i}-${j}`,tabIndex:0,order:i})));
    f.store.recoveryCandidates=new Set(all);await f.store.persist();f.history=structuredClone(f.store.restoreQueue);f.ids=ids;
    f.request.entries=(inverted?[...ids].reverse():ids).map(tabId=>({tabId,url:`https://layout.test/${tabId}`}));await moveTodayTabsToSpace(f.store,f.request);
    f.effects.length=0;return f;
}
function newEpoch(f,offset=1000){for(const t of f.tabs)t.id+=offset;for(const key of Object.keys(f.session))delete f.session[key];}
async function load(f,options){const s=new SpaceStore(options);s.discoverBookmarkSpaces=async()=>false;await s.initialize();return s;}
function historyPreserved(f,s){for(const r of f.history)assert(s.restoreQueue.some(p=>JSON.stringify(p)===JSON.stringify(r)));}
async function changedPending(){
    const f=await setup();for(const tab of f.tabs.filter(t=>t.windowId===20))tab.url=`https://other-window.test/${tab.id}`;
    await f.store.persist();newEpoch(f);f.tabs.find(t=>t.id===1001).url='https://changed-anchor.test/';
    const s=await load(f);s.active[10]='source';
    const request={...f.request,entries:f.ids.map(id=>({tabId:id+1000,url:`https://layout.test/${id}`}))};
    return {f,s,request};
}
async function chooseSourceAgain(state){
    const {s,request}=state;await moveTodayTabsToSpace(s,request);s.active[10]='target';
    await moveTodayTabsToSpace(s,{...request,spaceId:'target',bookmarkFolderId:'target-root',destinationSpaceId:'source',destinationBookmarkFolderId:'source-root'});
}
function addOldWindow(f,s){
    const old=s.durableLayout.cohorts.find(c=>c.blockedBy?.length);
    const tabs=old.signature.map((t,index)=>({...t,id:5000+index,windowId:30,incognito:false,splitViewId:-1}));f.tabs.push(...tabs);
    return tabs.filter(t=>f.ids.some(id=>t.url===`https://layout.test/${id}`)).map(t=>t.id);
}

test('ordered mapping accepts only one complete embedding and rejects missing or reordered slots',()=>{
    const slots=text=>[...text].map((url,index)=>({url,index,pinned:false}));
    assert.deepEqual(orderedLayoutMapping(slots('abc'),slots('xaybzc')),{indices:[1,3,5],unique:true});
    assert.equal(orderedLayoutMapping(slots('abc'),slots('aabc')).unique,false);
    assert.equal(orderedLayoutMapping(slots('abc'),slots('ac')),null);
    assert.equal(orderedLayoutMapping(slots('abc'),slots('bac')),null);
});

test('a short competing cohort or another ambiguous window blocks an otherwise unique embedding',()=>{
    const sig=s=>[...s].map((url,index)=>({url,index,pinned:false}));
    const long={id:'long',signature:sig('aabc')},short={id:'short',signature:sig('aa')};
    assert(layoutEvidence([long,short],[{id:1,signature:sig('aabc')},{id:2,signature:sig('aa')}]).every(e=>e.status==='ambiguous'));
    assert.equal(layoutEvidence([{id:'one',signature:sig('abc')}],[{id:1,signature:sig('xabc')},{id:2,signature:sig('aabc')}])[0].status,'ambiguous');
});

function insertExtra(f,{duplicate=false,index=3,id=9900}={}){
    for(const t of f.tabs)if(t.windowId===10&&t.index>=index)t.index++;
    const tab={id,index,windowId:10,url:duplicate?'https://layout.test/101':'https://extra.test/'+id,pinned:false,incognito:false,splitViewId:-1};f.tabs.push(tab);return tab;
}

test('interleaved extras remain outside saved authority through reload and disappearance',async()=>{
    const {f,s,request}=await changedPending();await moveTodayTabsToSpace(s,request);newEpoch(f);insertExtra(f);insertExtra(f,{id:9901,index:7});
    const cold=await load(f);assert(f.ids.every(id=>owner(cold,id+2000)==='target'));
    const c=cold.durableLayout.cohorts.find(c=>c.explicitOnly);assert(c.contextSubset);assert(!c.binding.tabIds.includes(9900));assert(!c.binding.tabIds.includes(9901));
    assert(!cold.explicitToday.has(9900));assert(!cold.restoredRanks.has(9900));await cold.persist();await load(f);
    f.tabs.splice(0,f.tabs.length,...f.tabs.filter(t=>![9900,9901].includes(t.id)));
    for(const windowId of [10,20])f.tabs.filter(t=>t.windowId===windowId).sort((a,b)=>a.index-b.index).forEach((t,i)=>t.index=i);
    for(let i=3;i<=4;i++){newEpoch(f);const next=await load(f);assert.deepEqual(next.spaces.find(s=>s.id==='target').temporaryTabs.filter(id=>f.ids.includes(id-i*1000)),f.ids.map(id=>id+i*1000));historyPreserved(f,next);assert(next.durableLayout.cohorts.find(n=>n.id===c.id).contextSubset);}
});

test('duplicating a mapped URL before its anchor rejects the whole embedded cohort',async()=>{
    const {f,s,request}=await changedPending();await moveTodayTabsToSpace(s,request);newEpoch(f);const original=f.tabs.find(t=>t.id===2101);insertExtra(f,{duplicate:true,index:original.index});
    const cold=await load(f);assert(f.ids.every(id=>owner(cold,id+2000)!=='target'));historyPreserved(f,cold);
});

test('explicitly moving an extra creates newer authority instead of implicitly expanding the subset',async()=>{
    const {f,s,request}=await changedPending();await moveTodayTabsToSpace(s,request);newEpoch(f);const extra=insertExtra(f);insertExtra(f,{id:9901,index:7});
    const cold=await load(f),old=cold.durableLayout.cohorts.find(c=>c.contextSubset);cold.active[10]='source';
    await moveTodayTabsToSpace(cold,{...request,entries:[{tabId:extra.id,url:extra.url}]});
    assert(cold.durableLayout.cohorts.find(c=>c.id===old.id).blockedBy.length);assert(!cold.durableLayout.cohorts.some(c=>c.signature.some(t=>t.url==='https://extra.test/9901')));newEpoch(f);const next=await load(f);assert.equal(owner(next,extra.id),'target');historyPreserved(f,next);
});

test('a duplicate embedding introduced during async validation refuses the embedded plan',async()=>{
    const {f,s,request}=await changedPending();await moveTodayTabsToSpace(s,request);newEpoch(f);insertExtra(f);
    let fired=false;f.hooks.bookmark=()=>{if(!fired){fired=true;insertExtra(f,{duplicate:true,id:9902,index:f.tabs.find(t=>t.id===2101).index});}};
    const before=structuredClone(f.local[DURABLE_LAYOUT_KEY]);await assert.rejects(load(f),/changed during restoration/);assert.deepEqual(f.local[DURABLE_LAYOUT_KEY],before);
});

test('compatible fallback preserves embedded subsets and resumes only with forward mode',async()=>{
    const {f,s,request}=await changedPending();await moveTodayTabsToSpace(s,request);newEpoch(f);insertExtra(f);const cold=await load(f);
    const saved=structuredClone(cold.durableLayout.cohorts.find(c=>c.contextSubset));newEpoch(f);const fallback=await load(f,{automaticLayoutRestore:false});
    assert(f.ids.every(id=>owner(fallback,id+3000)!=='target'));assert.deepEqual(fallback.durableLayout.cohorts.find(c=>c.id===saved.id),saved);
    const forward=await load(f);assert(f.ids.every(id=>owner(forward,id+3000)==='target'));historyPreserved(f,forward);
});

for(const coldWorker of [false,true])test(`observed close in a mapped subset keeps extras outside anchors (cold=${coldWorker})`,async()=>{
    const {f,s,request}=await changedPending();await moveTodayTabsToSpace(s,request);newEpoch(f);insertExtra(f);const restored=await load(f);events();
    const active=coldWorker?new SpaceStore():restored;active.discoverBookmarkSpaces=async()=>false;active.install();
    f.tabs.splice(f.tabs.findIndex(t=>t.id===2101),1);await chrome.tabs.onRemoved.emit(2101,{windowId:10,isWindowClosing:false});await active.chain;
    const c=active.durableLayout.cohorts.find(c=>c.contextSubset);assert(!c.binding.tabIds.includes(2101));assert(!c.binding.tabIds.includes(9900));assert(!c.signature.some(t=>t.url==='https://extra.test/9900'));
});

test('embedded restoration preserves preexisting extra order and rank',async()=>{
    const {f,s,request}=await changedPending();await moveTodayTabsToSpace(s,request);newEpoch(f);insertExtra(f);insertExtra(f,{id:9901,index:5});
    const fallback=await load(f,{automaticLayoutRestore:false});fallback.restoredRanks.set(9900,41);fallback.restoredRanks.set(9901,42);
    const source=fallback.spaces.find(s=>s.id==='source'),before=source.temporaryTabs.filter(id=>[9900,9901].includes(id));
    fallback.automaticLayoutRestore=true;await fallback.persist();assert.deepEqual(source.temporaryTabs.filter(id=>[9900,9901].includes(id)),before);
    assert.equal(fallback.restoredRanks.get(9900),41);assert.equal(fallback.restoredRanks.get(9901),42);
});

for(const phase of ['before-local','after-local','before-session','after-session'])test(`embedded restoration reconciles ${phase} interruption`,async()=>{
    const {f,s,request}=await changedPending();await moveTodayTabsToSpace(s,request);newEpoch(f);insertExtra(f);let fired=false;
    f.hooks[phase.startsWith('before')?'beforeSet':'afterSet']=(area,value)=>{if(!fired&&(phase.includes('local')?area==='local'&&value[DURABLE_LAYOUT_KEY]:area==='session'&&value.spaceSession)){fired=true;throw Error('interrupted');}};
    await assert.rejects(load(f));f.hooks.beforeSet=null;f.hooks.afterSet=null;const restored=await load(f);assert(f.ids.every(id=>owner(restored,id+2000)==='target'));assert(!restored.explicitToday.has(9900));historyPreserved(f,restored);
});

test('embedded checkpoint readback mismatch refuses success and later reconciles the committed subset',async()=>{
    const {f,s,request}=await changedPending();await moveTodayTabsToSpace(s,request);newEpoch(f);insertExtra(f);
    const get=chrome.storage.local.get;let written=false,changed=false;
    f.hooks.afterSet=(area,value)=>{if(area==='local'&&value[DURABLE_LAYOUT_KEY])written=true;};
    chrome.storage.local.get=async keys=>{const result=await get(keys);if(written&&!changed&&keys===DURABLE_LAYOUT_KEY){changed=true;result[DURABLE_LAYOUT_KEY].fingerprint+='-mismatch';}return result;};
    await assert.rejects(load(f),/could not be verified/);chrome.storage.local.get=get;f.hooks.afterSet=null;
    const restored=await load(f);assert(f.ids.every(id=>owner(restored,id+2000)==='target'));assert(restored.durableLayout.cohorts.some(c=>c.contextSubset));historyPreserved(f,restored);
});

test('compatible fallback retains current moves and defers full-epoch restoration until forward activation',async()=>{
    const {f,s,request}=await changedPending();await moveTodayTabsToSpace(s,request);
    const fallback=await load(f,{automaticLayoutRestore:false});
    assert(f.ids.every(id=>owner(fallback,id+1000)==='target'));
    fallback.active[10]='target';
    await moveTodayTabsToSpace(fallback,{...request,spaceId:'target',bookmarkFolderId:'target-root',destinationSpaceId:'source',destinationBookmarkFolderId:'source-root'});
    const warm=await load(f,{automaticLayoutRestore:false});assert(f.ids.every(id=>owner(warm,id+1000)==='source'));historyPreserved(f,warm);
    const saved=structuredClone(f.local[DURABLE_LAYOUT_KEY].cohorts);
    newEpoch(f);const cold=await load(f,{automaticLayoutRestore:false});
    assert(f.ids.every(id=>!cold.explicitToday.has(id+2000)));assert(cold.layoutPending.size);
    await cold.persist();await cold.persist();historyPreserved(f,cold);
    for(const c of saved)assert.deepEqual(f.local[DURABLE_LAYOUT_KEY].cohorts.find(x=>x.id===c.id),c);
    const forward=await load(f);assert(f.ids.every(id=>owner(forward,id+2000)==='source'&&forward.explicitToday.has(id+2000)));historyPreserved(f,forward);
});

test('fallback old signature cannot replay superseded placements and normal moves remain usable',async()=>{
    const state=await changedPending();await chooseSourceAgain(state);const {f}=state;
    f.tabs.find(t=>t.id===1001).url='https://same.test/';newEpoch(f);
    const cold=await load(f,{automaticLayoutRestore:false});assert(f.ids.every(id=>owner(cold,id+2000)!=='target'));
    cold.active[10]='source';
    await moveTodayTabsToSpace(cold,{...state.request,entries:f.ids.map(id=>({tabId:id+2000,url:`https://layout.test/${id}`}))});
    const warm=await load(f,{automaticLayoutRestore:false});assert(f.ids.every(id=>owner(warm,id+2000)==='target'));historyPreserved(f,warm);
    newEpoch(f);const forward=await load(f);assert(f.ids.every(id=>owner(forward,id+3000)==='target'));historyPreserved(f,forward);
});

test('fallback repeated tracking after a fresh move preserves unresolved neighbour history',async()=>{
    const {f,request}=await changedPending(),s=await load(f,{automaticLayoutRestore:false});s.active[10]='source';
    await moveTodayTabsToSpace(s,request);
    for(let i=0;i<3;i++){for(const tab of f.tabs)s.track(tab,{nativeTabs:f.tabs});await s.persist();historyPreserved(f,s);}
    assert(!s.explicitToday.has(1108));assert(s.restoreQueue.some(r=>r.url==='https://layout.test/108'));
});

for(const phase of ['before-local','after-local'])test(`fallback v1 migration ${phase} interruption keeps a valid coherent checkpoint`,async()=>{
    const f=await setup();f.local[DURABLE_LAYOUT_KEY].version=1;const before=structuredClone(f.local);let fired=false;
    f.hooks[phase==='before-local'?'beforeSet':'afterSet']=(area,value)=>{if(!fired&&area==='local'&&value[DURABLE_LAYOUT_KEY]){fired=true;throw Error('migration interrupted');}};
    await assert.rejects(load(f,{automaticLayoutRestore:false}),/migration interrupted/);
    assert.equal(f.local[DURABLE_LAYOUT_KEY].version,phase==='before-local'?1:3);assert(await readDurableLayout(f.local[DURABLE_LAYOUT_KEY]));
    if(phase==='before-local')assert.deepEqual(f.local[DURABLE_LAYOUT_KEY],before[DURABLE_LAYOUT_KEY]);
    f.hooks.beforeSet=null;f.hooks.afterSet=null;const s=await load(f,{automaticLayoutRestore:false});historyPreserved(f,s);assert.equal(f.local[DURABLE_LAYOUT_KEY].version,3);
});

for(const phase of ['before-local','after-local','before-session','after-session'])test(`fallback move reconciles ${phase} interruption without format downgrade`,async()=>{
    const {f,request}=await changedPending();const s=await load(f,{automaticLayoutRestore:false});s.active[10]='source';let fired=false;
    const hook=(area,value)=>{if(!fired&&(phase.includes('local')?area==='local'&&value[DURABLE_LAYOUT_KEY]:area==='session'&&value.spaceSession)){fired=true;throw Error('interrupted');}};
    f.hooks[phase.startsWith('before')?'beforeSet':'afterSet']=hook;await assert.rejects(moveTodayTabsToSpace(s,request));
    f.hooks.beforeSet=null;f.hooks.afterSet=null;
    const warm=await load(f,{automaticLayoutRestore:false});historyPreserved(f,warm);assert.equal(f.local[DURABLE_LAYOUT_KEY].version,3);
    newEpoch(f);const forward=await load(f);assert.equal(f.ids.every(id=>owner(forward,id+2000)==='target'),phase!=='before-local');historyPreserved(f,forward);
});
test('old signature returning cannot override a newer durable choice',async()=>{
    const state=await changedPending();await chooseSourceAgain(state);const {f,s}=state;
    f.tabs.find(t=>t.id===1001).url='https://same.test/';await s.persist();newEpoch(f);const cold=await load(f);
    assert(f.ids.every(id=>owner(cold,id+2000)==='source'));assert(f.ids.every(id=>cold.explicitToday.has(id+2000)));historyPreserved(f,cold);
});

test('additional native slot restores the fresh mapped subset without promoting extras',async()=>{
    const {f,s,request}=await changedPending();await moveTodayTabsToSpace(s,request);
    const saved=structuredClone(f.local[DURABLE_LAYOUT_KEY]);newEpoch(f);
    f.tabs.push({id:9900,windowId:10,index:Math.max(...f.tabs.filter(t=>t.windowId===10).map(t=>t.index))+1,url:'https://startup-extra.test/',pinned:false,incognito:false,splitViewId:-1});
    const cold=await load(f);assert(f.ids.every(id=>owner(cold,id+2000)==='target'));historyPreserved(f,cold);
    const report=await diagnoseDurableLayout({stable:true,scope:'live-store',local:f.local,tabs:f.tabs,memory:{durableLayout:cold.durableLayout,layoutPending:[...cold.layoutPending],restoreQueue:cold.restoreQueue}});
    assert.equal(report.counts.pendingWindowLayouts,1);assert(!cold.explicitToday.has(9900));assert(!cold.restoredRanks.has(9900));
    const fresh=cold.durableLayout.cohorts.find(c=>c.explicitOnly);assert(fresh.contextSubset);assert(!fresh.signature.some(t=>t.url==='https://startup-extra.test/'));assert.equal(fresh.placements.length,7);
    await cold.persist();const warm=await load(f);assert(!warm.durableLayout.cohorts.find(c=>c.id===fresh.id).signature.some(t=>t.url==='https://startup-extra.test/'));
    f.tabs=f.tabs.filter(t=>t.id!==9900);
    for(const c of saved.cohorts.filter(c=>cold.layoutPending.has(c.id)))assert.deepEqual(f.local[DURABLE_LAYOUT_KEY].cohorts.find(n=>n.id===c.id),c);
});
test('mixed eight-tab move records the extra no-history tab only through explicit intent',async()=>{
    const {f,s,request}=await changedPending(),selected=new Set([1001,...f.ids.map(id=>id+1000)]);
    const ordered=s.spaces.find(space=>space.id==='source').temporaryTabs.filter(id=>selected.has(id));
    await moveTodayTabsToSpace(s,{...request,entries:ordered.map(tabId=>({tabId,url:f.tabs.find(t=>t.id===tabId).url}))});
    assert.equal(s.durableLayout.cohorts.find(c=>c.explicitOnly).placements.length,8);
    newEpoch(f);const cold=await load(f);assert.deepEqual(cold.spaces.find(space=>space.id==='target').temporaryTabs.filter(id=>selected.has(id-1000)),ordered.map(id=>id+1000));historyPreserved(f,cold);
});
test('old signature returning while the newer layout is absent remains deferred',async()=>{
    const state=await changedPending();await chooseSourceAgain(state);const {f}=state;
    f.tabs.find(t=>t.id===1001).url='https://same.test/';newEpoch(f);const cold=await load(f);
    assert(f.ids.every(id=>owner(cold,id+2000)!=='target'));assert(cold.layoutPending.size);historyPreserved(f,cold);
});
test('distinct complete windows release older same-URL placement opportunities',async()=>{
    const state=await changedPending();await chooseSourceAgain(state);const {f,s}=state;const olderIds=addOldWindow(f,s);
    newEpoch(f);const cold=await load(f);assert(f.ids.every(id=>owner(cold,id+2000)==='source'));
    assert(olderIds.every(id=>owner(cold,id+1000)==='target'));historyPreserved(f,cold);
});
test('every newer conflict must be proven before an older window can restore',async()=>{
    const state=await changedPending();await chooseSourceAgain(state);const {f,s}=state;const olderIds=addOldWindow(f,s);
    const ledger=f.local[DURABLE_LAYOUT_KEY],old=ledger.cohorts.find(c=>c.blockedBy?.length),fresh=ledger.cohorts.find(c=>c.explicitOnly);
    const branch=structuredClone(fresh);branch.id='second-newer-choice';branch.binding=null;branch.choiceRevision=++ledger.revision;
    branch.signature[0].url='https://missing-newer-window.test/';ledger.cohorts.push(branch);old.blockedBy.push(branch.id);await reseal(ledger);
    newEpoch(f);const cold=await load(f);assert(olderIds.every(id=>owner(cold,id+1000)!=='target'));historyPreserved(f,cold);
});
test('indistinguishable fresh windows remain unresolved',async()=>{
    const {f,s,request}=await changedPending();await moveTodayTabsToSpace(s,request);
    f.tabs.push(...f.tabs.filter(t=>t.windowId===10).map(t=>({...t,id:t.id+5000,windowId:30})));newEpoch(f);const cold=await load(f);
    assert(f.ids.every(id=>owner(cold,id+2000)!=='target'));assert(cold.layoutPending.size);historyPreserved(f,cold);
});
test('a duplicate window appearing during restoration validation rejects the plan',async()=>{
    const {f,s,request}=await changedPending();await moveTodayTabsToSpace(s,request);newEpoch(f);const before=structuredClone(f.local[DURABLE_LAYOUT_KEY]);
    let changed=false;f.hooks.bookmark=()=>{if(!changed){changed=true;f.tabs.push(...f.tabs.filter(t=>t.windowId===10).map(t=>({...t,id:t.id+5000,windowId:30})));}};
    await assert.rejects(load(f),/changed during restoration/);assert.deepEqual(f.local[DURABLE_LAYOUT_KEY],before);
});
test('a newer successor with unproven overrides cannot release older authority',async()=>{
    const state=await changedPending();await chooseSourceAgain(state);const {f,s}=state,olderIds=addOldWindow(f,s);
    const ledger=f.local[DURABLE_LAYOUT_KEY];ledger.cohorts.find(c=>c.explicitOnly).overrides.push({tabId:9999,incarnation:'unproven',epoch:{kind:'session',epoch:'gone'}});await reseal(ledger);
    newEpoch(f);const cold=await load(f);assert(olderIds.every(id=>owner(cold,id+1000)!=='target'));historyPreserved(f,cold);
});
test('deleting a newer destination cannot revive an older valid destination',async()=>{
    const {f,s,request}=await changedPending();s.spaces.push({id:'new-target',name:'New',color:'blue',bookmarkFolderId:'new-root',temporaryTabs:[],spaceBookmarks:[]});
    f.nodes.push({id:'new-root',parentId:'arcify',title:'New'});await s.persist();
    await moveTodayTabsToSpace(s,{...request,destinationSpaceId:'new-target',destinationBookmarkFolderId:'new-root'});
    const olderIds=addOldWindow(f,s);f.local.spaces=f.local.spaces.filter(space=>space.id!=='new-target');newEpoch(f);const cold=await load(f);
    assert(olderIds.every(id=>owner(cold,id+1000)!=='target'));assert(cold.layoutPending.size);historyPreserved(f,cold);
});
test('changed newer proof during awaited restoration cannot release an older window',async()=>{
    const state=await changedPending();await chooseSourceAgain(state);const {f,s}=state;addOldWindow(f,s);newEpoch(f);
    const before=structuredClone(f.local[DURABLE_LAYOUT_KEY]);let changed=false;
    f.hooks.bookmark=()=>{if(!changed){changed=true;f.tabs.find(t=>t.windowId===10&&t.url==='https://changed-anchor.test/').url='https://newer-proof-changed.test/';}};
    await assert.rejects(load(f),/changed during restoration/);assert.deepEqual(f.local[DURABLE_LAYOUT_KEY],before);
});
for(const phase of ['before-local','after-local','before-session','after-session'])test(`fresh layout atomic reconciliation survives ${phase} interruption`,async()=>{
    const {f,s,request}=await changedPending();let fired=false;
    const hook=(area,value)=>{if(!fired&&(phase.includes('local')?area==='local'&&value[DURABLE_LAYOUT_KEY]:area==='session'&&value.spaceSession)){fired=true;throw Error('interrupted');}};
    f.hooks[phase.startsWith('before')?'beforeSet':'afterSet']=hook;await assert.rejects(moveTodayTabsToSpace(s,request));
    f.hooks.beforeSet=null;f.hooks.afterSet=null;newEpoch(f);const cold=await load(f);
    assert.equal(f.ids.every(id=>owner(cold,id+2000)==='target'),phase!=='before-local');historyPreserved(f,cold);
});
test('fresh capture fences navigation of an unselected context tab',async()=>{
    const {f,s,request}=await changedPending(),persist=s.persist.bind(s),before=structuredClone(f.local[DURABLE_LAYOUT_KEY]);
    s.persist=options=>persist({...options,beforeWrite:async()=>{await options.beforeWrite();f.tabs.find(t=>t.id===1001).url='https://changed-again.test/';}});
    await assert.rejects(moveTodayTabsToSpace(s,request),/Fresh native layout changed/);assert.deepEqual(f.local[DURABLE_LAYOUT_KEY],before);historyPreserved(f,s);
});
for(const change of ['name','pin','split'])test(`fresh capture rechecks late ${change} metadata`,async()=>{
    const {f,s,request}=await changedPending(),persist=s.persist.bind(s),before=structuredClone(f.local[DURABLE_LAYOUT_KEY]);
    s.persist=options=>persist({...options,beforeWrite:async()=>{await options.beforeWrite();
        if(change==='name')f.local.tabNameOverridesById[1101]={name:'New alias'};
        if(change==='pin')f.local.pinnedTabStatesById[1101]={name:'New pin metadata'};
        if(change==='split')f.tabs.find(t=>t.id===1101).splitViewId=55;
    }});
    await assert.rejects(moveTodayTabsToSpace(s,request),/Fresh native layout changed/);assert.deepEqual(f.local[DURABLE_LAYOUT_KEY],before);
});
test('cyclic or missing precedence references fail checksum-valid schema validation',async()=>{
    const {f,s,request}=await changedPending();await moveTodayTabsToSpace(s,request);const ledger=f.local[DURABLE_LAYOUT_KEY];
    const old=ledger.cohorts.find(c=>c.blockedBy?.length),fresh=ledger.cohorts.find(c=>c.explicitOnly);
    fresh.blockedBy=[old.id];await reseal(ledger);assert.equal(await readDurableLayout(ledger),null);
    fresh.blockedBy=['missing'];await reseal(ledger);assert.equal(await readDurableLayout(ledger),null);
});
test('legacy v1 layout reads migrate to v3 so older builds cannot ignore precedence',async()=>{
    const f=await setup();f.local[DURABLE_LAYOUT_KEY].version=1;assert(await readDurableLayout(f.local[DURABLE_LAYOUT_KEY]));
    newEpoch(f);await load(f);assert.equal(f.local[DURABLE_LAYOUT_KEY].version,3);
});
test('explicit move against changed pending layout captures fresh authority across repeated restarts',async()=>{
    const f=await setup();for(const tab of f.tabs.filter(t=>t.windowId===20))tab.url=`https://other-window.test/${tab.id}`;
    await f.store.persist();newEpoch(f);f.tabs.find(t=>t.id===1001).url='https://changed-anchor.test/';
    const s=await load(f);s.active[10]='source';
    const report=await diagnoseDurableLayout({stable:true,scope:'live-store',local:f.local,tabs:f.tabs,memory:{durableLayout:s.durableLayout,layoutPending:[...s.layoutPending],restoreQueue:s.restoreQueue}});
    assert.equal(report.counts.noSequenceCorrespondence,1);assert.equal(report.counts.changedOrMissingCandidates,1);
    const request={...f.request,entries:f.ids.map(id=>({tabId:id+1000,url:`https://layout.test/${id}`}))};
    await moveTodayTabsToSpace(s,request);assert(f.ids.every(id=>owner(s,id+1000)==='target'));
    const pending=s.durableLayout.cohorts.find(c=>s.layoutPending.has(c.id));assert.equal(pending.blockedBy.length,1);
    assert(!pending.signature.some(t=>t.url==='https://changed-anchor.test/'));
    const fresh=s.durableLayout.cohorts.find(c=>c.explicitOnly);assert.equal(fresh.placements.length,7);
    for(let epoch=2;epoch<=4;epoch++){newEpoch(f);const cold=await load(f);assert(f.ids.every(id=>owner(cold,id+epoch*1000)==='target'));
        assert.deepEqual(cold.spaces.find(x=>x.id==='target').temporaryTabs.filter(id=>f.ids.includes(id-epoch*1000)),f.ids.map(id=>id+epoch*1000));historyPreserved(f,cold);}
});
async function reseal(ledger){ledger.fingerprint=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(encode({revision:ledger.revision,cohorts:ledger.cohorts,snapshotProof:ledger.snapshotProof}))))).map(b=>b.toString(16).padStart(2,'0')).join('');}
test('legacy upgrade with an unchanged native pinned neighbour restores plain placements',async()=>{
    const f=await setup();for(const tab of f.tabs.filter(t=>t.windowId===10))tab.index++;
    f.tabs.push({id:900,index:0,windowId:10,url:'https://native-pin.test/',pinned:true,incognito:false});
    await f.store.persist();delete f.local[DURABLE_LAYOUT_KEY];newEpoch(f);
    const s=await load(f);assert(f.ids.every(id=>owner(s,id+1000)==='target'));historyPreserved(f,s);
    assert(!s.spaces.some(space=>space.temporaryTabs.includes(1900)));
});
test('previously imported unbound native-pin anchors are projected without changing placements or history',async()=>{
    const f=await setup();for(const tab of f.tabs.filter(t=>t.windowId===10))tab.index++;
    f.tabs.push({id:900,index:0,windowId:10,url:'https://native-pin.test/',pinned:true,incognito:false});
    await f.store.persist();const ledger=f.local[DURABLE_LAYOUT_KEY];
    const cohort=ledger.cohorts.find(c=>c.binding.windowId===10),placements=structuredClone(cohort.placements);
    cohort.binding=null;cohort.signature.unshift({index:0,url:'https://native-pin.test/',pinned:true});
    await reseal(ledger);
    assert(await readDurableLayout(ledger));newEpoch(f);const s=await load(f);
    assert(f.ids.every(id=>owner(s,id+1000)==='target'));historyPreserved(f,s);
    const repaired=f.local[DURABLE_LAYOUT_KEY].cohorts.find(c=>c.id===cohort.id);
    assert(!repaired.signature.some(t=>t.pinned));assert.deepEqual(repaired.placements.map(p=>[p.index,p.spaceId,p.bookmarkFolderId]),placements.map(p=>[p.index,p.spaceId,p.bookmarkFolderId]));
    const warm=await load(f);assert(f.ids.every(id=>owner(warm,id+1000)==='target'));historyPreserved(f,warm);
});
for(const protection of ['bound','pinned-placement','override','ambiguous'])test(`import projection preserves ${protection} protection`,async()=>{
    const f=await setup(),ledger=f.local[DURABLE_LAYOUT_KEY],cohort=ledger.cohorts.find(c=>c.binding.windowId===10);
    const anchor={index:100,url:'https://native-pin.test/',pinned:true};cohort.signature.push(anchor);
    if(protection==='bound')cohort.binding.tabIds.push(900);else cohort.binding=null;
    if(protection==='pinned-placement')cohort.placements.push({index:100,spaceId:'target',bookmarkFolderId:'target-root',order:100});
    if(protection==='override')cohort.overrides.push({tabId:901,incarnation:'newer-choice',epoch:{kind:'session',epoch:'previous'}});
    if(protection==='ambiguous'){const other=structuredClone(cohort);other.id+='-duplicate';other.signature.at(-1).url='https://other-pin.test/';ledger.cohorts.push(other);}
    await reseal(ledger);assert(await readDurableLayout(ledger));newEpoch(f);const s=await load(f);
    assert(s.layoutPending.has(cohort.id));assert(f.ids.every(id=>owner(s,id+1000)!=='target'));historyPreserved(f,s);
    const retained=f.local[DURABLE_LAYOUT_KEY].cohorts.find(c=>c.id===cohort.id);
    if(protection==='bound'||protection==='pinned-placement')assert(retained.signature.some(t=>t.pinned));
    if(protection==='override')assert.deepEqual(retained.overrides,cohort.overrides);
    if(protection==='ambiguous')assert.equal(layoutEvidence(s.durableLayout.cohorts,[{signature:retained.signature}]).find(e=>e.cohort.id===cohort.id).status,'ambiguous');
});
for(const [name,slots,wanted] of [
    ['unchanged',[[0,'a'],[1,'b'],[2,'c']],'ready'],
    ['added ordinary tab',[[0,'a'],[1,'b'],[2,'c'],[3,'new']],'ready'],
    ['closed ordinary tab',[[0,'a'],[1,'c']],'incomplete'],
    ['reordered native tabs',[[0,'b'],[1,'a'],[2,'c']],'changed'],
    ['excluded pinned tab shifts indices',[[1,'a'],[2,'b'],[3,'c']],'ready'],
    ['navigation',[[0,'a'],[1,'new'],[2,'c']],'changed'],
    ['no native window',null,'changed']
])test(`layout evidence distinguishes ${name}`,()=>{
    const signature=rows=>rows.map(([index,url])=>({index,url,pinned:false}));
    const cohort={signature:signature([[0,'a'],[1,'b'],[2,'c']])};
    assert.equal(layoutEvidence([cohort],slots?[{signature:signature(slots)}]:[])[0].status,wanted);
});
test('native pinned anchor alone reports incomplete, not the observed changed bucket',()=>{
    const ordinary=[{index:1,url:'a',pinned:false},{index:2,url:'b',pinned:false}];
    assert.equal(layoutEvidence([{signature:[{index:0,url:'pin',pinned:true},...ordinary]}],[{signature:ordinary}])[0].status,'incomplete');
});
test('partial layout restoration does not project fallback native groups into its pending window',async()=>{
    const f=await setup();for(const tab of f.tabs.filter(t=>t.windowId===20))tab.url=`https://other-window.test/${tab.id}`;
    await f.store.persist();f.sync.syncTabGroups=true;newEpoch(f);
    const delayed=f.tabs.filter(t=>t.id>=1104);f.tabs.splice(0,f.tabs.length,...f.tabs.filter(t=>t.id<1104));f.effects.length=0;
    const s=await load(f);assert(s.layoutPending.size);
    assert(!f.effects.some(([type,value])=>type==='group'&&value.createProperties?.windowId===10));
    assert(f.effects.some(([type,value])=>type==='group'&&value.createProperties?.windowId===20));
    f.tabs.push(...delayed);f.effects.length=0;await s.persist();
    assert(f.ids.every(id=>owner(s,id+1000)==='target'));
    assert(f.effects.some(([type,value])=>type==='group'&&value.createProperties?.windowId===10));
});
test('layout projection deferral retains live group mappings and resumes with the same groups',async()=>{
    const f=fixture({syncGroups:true});await syncSpaceGroups(f.store.spaces,f.store.active);
    const before=structuredClone(f.session.spaceGroupProjection);f.effects.length=0;f.store.spaces[0].name='Changed';
    await syncSpaceGroups(f.store.spaces,f.store.active,[],{isProjectionDeferredWindow:id=>id===10});
    for(const [key,id] of Object.entries(before))if(key.endsWith(':10'))assert.equal(f.session.spaceGroupProjection[key],id);
    assert(!f.effects.some(([type,id])=>type==='groupUpdate'&&f.groups.find(g=>g.id===id)?.windowId===10));
    assert(f.effects.some(([type,id])=>type==='groupUpdate'&&f.groups.find(g=>g.id===id)?.windowId===20));
    f.effects.length=0;await syncSpaceGroups(f.store.spaces,f.store.active);
    assert.equal(f.session.spaceGroupProjection['source:10'],before['source:10']);
    assert(!f.effects.some(([type,value])=>type==='group'&&value.createProperties?.windowId===10));
    assert(f.effects.some(([type,id])=>type==='groupUpdate'&&id===before['source:10']));
});
for(const syncGroups of [false,true])test(`pending layout never prevents exact Favorite detachment (sync=${syncGroups})`,async()=>{
    const f=fixture({syncGroups});f.tabs[0].groupId=100;f.groups.push({id:100,windowId:10,collapsed:true});
    const ungrouped=[];chrome.tabs.ungroup=async ids=>{ungrouped.push(...ids);for(const tab of f.tabs)if(ids.includes(tab.id))tab.groupId=-1;};
    await syncSpaceGroups(f.store.spaces,f.store.active,[1],{isProjectionDeferredWindow:id=>id===10});
    assert.deepEqual(ungrouped,[1]);assert.equal(f.tabs[0].groupId,-1);
});
for(const residual of [0,1])test(`normal new-epoch restart restores membership and order with ${residual} unresolved neighbour`,async()=>{
    const f=await setup(residual);newEpoch(f);const s=await load(f);
    assert.deepEqual(f.ids.map(id=>owner(s,id+1000)),f.ids.map(()=>'target'));
    assert.deepEqual(s.spaces.find(x=>x.id==='target').temporaryTabs.filter(id=>f.ids.includes(id-1000)),f.ids.map(id=>id+1000));
    historyPreserved(f,s);await s.persist();const warm=await load(f);historyPreserved(f,warm);
    assert(f.ids.every(id=>owner(warm,id+1000)==='target'));
});
test('repeated complete restarts do not accumulate current placements in historical recovery',async()=>{
    const f=await setup();let count;
    for(let i=1;i<=3;i++){newEpoch(f);const s=await load(f);historyPreserved(f,s);
        assert(f.ids.every(id=>owner(s,id+1000*i)==='target'));
        if(count!==undefined)assert.equal(s.restoreQueue.length,count);count=s.restoreQueue.length;
    }
});
test('partial startup preserves the full baseline across worker reload and automatically completes on native arrival',async()=>{
    const f=await setup();newEpoch(f);const delayed=f.tabs.filter(t=>t.id>=1104);f.tabs.splice(0,f.tabs.length,...f.tabs.filter(t=>t.id<1104));
    let s=await load(f);const baseline=structuredClone(f.local[DURABLE_LAYOUT_KEY].cohorts);
    assert(s.layoutPending.size);await s.persist();s=await load(f);
    assert.deepEqual(f.local[DURABLE_LAYOUT_KEY].cohorts,baseline);
    events();s.install();await s.chain;
    for(const tab of delayed){f.tabs.push(tab);await chrome.tabs.onCreated.emit(tab);await s.chain;}
    assert(f.ids.every(id=>owner(s,id+1000)==='target'));historyPreserved(f,s);
});
test('identical native window layouts remain unresolved instead of selecting a window arbitrarily',async()=>{
    const f=await setup();newEpoch(f);const original=f.tabs.filter(t=>t.windowId===10);
    f.tabs.push(...original.map(t=>({...t,id:t.id+3000,windowId:30})));
    const s=await load(f);assert(s.layoutPending.size);assert(f.ids.every(id=>owner(s,id+1000)!=='target'));historyPreserved(f,s);
});
test('same URLs at multiple slots restore by the complete layout rather than URL alone',async()=>{
    const f=await setup();for(const id of [101,102])f.tabs.find(t=>t.id===id).url='https://duplicate.test/';await f.store.persist();
    newEpoch(f);const s=await load(f);assert.equal(owner(s,1101),'target');assert.equal(owner(s,1102),'target');
    assert.deepEqual(s.spaces.find(x=>x.id==='target').temporaryTabs.filter(id=>[1101,1102].includes(id)),[1101,1102]);
});
test('window shutdown and absent native snapshots preserve confirmed layouts',async()=>{
    const f=await setup();const before=structuredClone(f.local[DURABLE_LAYOUT_KEY].cohorts);events();f.store.install();await f.store.chain;
    const removed=f.tabs.filter(t=>t.windowId===10);f.tabs.splice(0,f.tabs.length,...f.tabs.filter(t=>t.windowId!==10));
    for(const t of removed){await chrome.tabs.onRemoved.emit(t.id,{windowId:10,isWindowClosing:true});await f.store.chain;}
    assert.deepEqual(f.local[DURABLE_LAYOUT_KEY].cohorts.filter(c=>c.binding.windowId===10),before.filter(c=>c.binding.windowId===10));
    f.tabs.push(...removed.map(t=>({...t,id:t.id+1000})));for(const key of Object.keys(f.session))delete f.session[key];
    const s=await load(f);assert(f.ids.every(id=>owner(s,id+1000)==='target'));historyPreserved(f,s);
});
test('an observed individual close updates the layout without retaining a phantom slot',async()=>{
    const f=await setup();events();f.store.install();await f.store.chain;
    f.tabs.splice(f.tabs.findIndex(t=>t.id===101),1);await chrome.tabs.onRemoved.emit(101,{windowId:10,isWindowClosing:false});await f.store.chain;
    const c=f.local[DURABLE_LAYOUT_KEY].cohorts.find(c=>c.binding.windowId===10);assert(!c.binding.tabIds.includes(101));
});
test('new explicit placement during deferred startup wins when the baseline later restores',async()=>{
    const f=await setup();newEpoch(f);const delayed=f.tabs.filter(t=>t.id>=1104);f.tabs.splice(0,f.tabs.length,...f.tabs.filter(t=>t.id<1104));
    const s=await load(f);s.active[10]='source';
    const request={...f.request,entries:[{tabId:1101,url:'https://layout.test/101'}]};
    await moveTodayTabsToSpace(s,request);
    // Move this tab back to source: this newer choice differs from saved target.
    s.active[10]='target';await moveTodayTabsToSpace(s,{...request,spaceId:'target',bookmarkFolderId:'target-root',destinationSpaceId:'source',destinationBookmarkFolderId:'source-root'});
    f.tabs.push(...delayed);await s.persist();assert.equal(owner(s,1101),'source');
    assert(f.ids.slice(1).every(id=>owner(s,id+1000)==='target'));historyPreserved(f,s);
    const warm=await load(f);assert.equal(owner(warm,1101),'source');
});
test('proven newer subset permits baseline merge without overriding the newer choice',async()=>{
    const f=await setup();newEpoch(f);const delayed=f.tabs.filter(t=>t.id>=1104);f.tabs.splice(0,f.tabs.length,...f.tabs.filter(t=>t.id<1104));
    const s=await load(f);s.active[10]='source';await moveTodayTabsToSpace(s,{...f.request,entries:[{tabId:1101,url:'https://layout.test/101'}]});
    f.tabs.push(...delayed);newEpoch(f);const cold=await load(f);assert.equal(owner(cold,2101),'target');assert(cold.explicitToday.has(2101));assert(f.ids.slice(1).every(id=>owner(cold,id+2000)==='target'));historyPreserved(f,cold);
});
test('navigation during awaited restoration refuses the whole plan and leaves the durable baseline intact',async()=>{
    const f=await setup();newEpoch(f);const before=structuredClone(f.local[DURABLE_LAYOUT_KEY]);let changed=false;
    f.hooks.bookmark=()=>{if(!changed){changed=true;f.tabs.find(t=>t.id===1101).url='https://changed.test/';}};
    await assert.rejects(load(f),/changed during restoration/);assert.deepEqual(f.local[DURABLE_LAYOUT_KEY],before);
});
test('same worker recovers after a final restoration fence rejects stale native state',async()=>{
    const f=await setup();newEpoch(f);const delayed=f.tabs.pop();const s=await load(f);
    f.tabs.push(delayed);const baseline=structuredClone(f.local[DURABLE_LAYOUT_KEY]);
    await assert.rejects(s.persist({beforeWrite:async()=>{f.tabs.find(t=>t.id===1101).url='https://changed.test/';}}),/changed during restoration/);
    assert.deepEqual(f.local[DURABLE_LAYOUT_KEY],baseline);
    await s.initialize();await s.persist();assert(s.layoutPending.size);historyPreserved(f,s);
});
for(const phase of ['before-local','after-local','before-session','after-session'])test(`layout reconciliation survives ${phase} interruption`,async()=>{
    const f=await setup();newEpoch(f);let fired=false;
    const hook=(area,value)=>{if(!fired&&(phase.includes('local')?area==='local'&&value[DURABLE_LAYOUT_KEY]:area==='session'&&value.spaceSession)){fired=true;throw Error('interrupted');}};
    f.hooks[phase.startsWith('before')?'beforeSet':'afterSet']=hook;await assert.rejects(load(f));
    f.hooks.beforeSet=null;f.hooks.afterSet=null;const s=await load(f);
    assert(f.ids.every(id=>owner(s,id+1000)==='target'));historyPreserved(f,s);
});
test('layout schema corruption cannot authorize replay',async()=>{
    const f=await setup(),bad=structuredClone(f.local[DURABLE_LAYOUT_KEY]);bad.cohorts[0].placements[0].spaceId='tampered';
    assert.equal(await readDurableLayout(bad),null);
});
for(const inverted of [false,true])test(`new explicit bottom placement survives deferred restoration and another epoch (inverted=${inverted})`,async()=>{
    const f=await setup(1,inverted);newEpoch(f);const delayed=f.tabs.filter(t=>t.id>=1104);f.tabs.splice(0,f.tabs.length,...f.tabs.filter(t=>t.id<1104));
    const s=await load(f);s.active[10]='source';await moveTodayTabsToSpace(s,{...f.request,entries:[{tabId:1101,url:'https://layout.test/101'}]});
    f.tabs.push(...delayed);await s.persist();
    const wanted=inverted?[1101,1102,1103,1104,1105,1106,1107]:[1102,1103,1104,1105,1106,1107,1101];
    assert.deepEqual(s.spaces.find(x=>x.id==='target').temporaryTabs.filter(id=>f.ids.includes(id-1000)),wanted);
    await s.persist();const warm=await load(f);assert.deepEqual(warm.spaces.find(x=>x.id==='target').temporaryTabs.filter(id=>f.ids.includes(id-1000)),wanted);
    newEpoch(f);const cold=await load(f);assert.deepEqual(cold.spaces.find(x=>x.id==='target').temporaryTabs.filter(id=>f.ids.includes(id-2000)),wanted.map(id=>id+1000));
});
test('individual close waking a cold worker preserves event-time intent and updates the saved cohort',async()=>{
    const f=await setup();events();const cold=new SpaceStore();cold.discoverBookmarkSpaces=async()=>false;cold.install();
    f.tabs.splice(f.tabs.findIndex(t=>t.id===101),1);await chrome.tabs.onRemoved.emit(101,{windowId:10,isWindowClosing:false});await cold.chain;
    const c=f.local[DURABLE_LAYOUT_KEY].cohorts.find(c=>c.binding?.windowId===10);assert(!c.binding.tabIds.includes(101));assert(!cold.layoutPending.has(c.id));
});
test('named and pin-metadata records remain historical rather than entering plain layout restoration',async()=>{
    const f=await setup();f.local.tabNameOverridesById[101]={name:'Keep historical alias'};f.local.pinnedTabStatesById[102]={name:'Saved metadata'};await f.store.persist();
    const old=f.local.spaceTabSnapshot.filter(r=>[101,102].includes(r.tabId)&&r.currentOwnership);
    newEpoch(f);const s=await load(f);assert(!s.explicitToday.has(1101));assert(!s.explicitToday.has(1102));
    for(const record of old)assert(s.restoreQueue.some(r=>JSON.stringify(r)===JSON.stringify(record)));
});
test('built-in layout evidence reports only bounded counts and distinguishes partial startup',async()=>{
    const f=await setup();newEpoch(f);f.tabs.splice(0,f.tabs.length,...f.tabs.filter(t=>t.id<1104));const s=await load(f);
    const snapshot={stable:true,scope:'live-store',local:f.local,tabs:f.tabs,memory:{durableLayout:s.durableLayout,layoutPending:[...s.layoutPending],restoreQueue:s.restoreQueue}};
    const report=await diagnoseDurableLayout(snapshot);assert.equal(report.status,'stable');assert(report.counts.incompleteCandidates>0);assert(report.counts.pendingTodayPlacements>=7);
    assert.doesNotMatch(JSON.stringify(report),/https|url|tabId|windowId|fingerprint|incarnation|epoch/);
    assert.throws(()=>validateLayoutDiagnostic({...report,url:'secret'}));
    assert.equal((await diagnoseDurableLayout({...snapshot,stable:false})).counts,null);
});
test('invalid durable data is retained rather than overwritten by a fallback projection',async()=>{
    const f=await setup();f.local[DURABLE_LAYOUT_KEY].cohorts[0].placements[0].order++;
    const before=structuredClone(f.local[DURABLE_LAYOUT_KEY]);newEpoch(f);await assert.rejects(load(f),/invalid/);
    assert.deepEqual(f.local[DURABLE_LAYOUT_KEY],before);
});
