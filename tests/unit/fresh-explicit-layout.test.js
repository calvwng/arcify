import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './today-recovery-fixture.js';
import { SpaceStore } from '../../space-store.js';
import { moveTodayTabsToSpace } from '../../today-move-store.js';
import { DURABLE_LAYOUT_KEY, readDurableLayout, layoutWindows, captureDurableLayout } from '../../durable-today-layout.js';

import { encodeFavoriteContinuityState as encode } from '../../favorite-continuity.js';
import { readExplicitCheckpoint } from '../../explicit-today-ownership.js';

const ids = [101,102,103,104,105,106,107];
const owner = (s,id) => s.spaces.find(space=>space.temporaryTabs.includes(id))?.id;
const selectedIds = offset => ids.map(id=>id+offset);
const newEpoch = f => { for(const tab of f.tabs)tab.id+=1000;for(const key of Object.keys(f.session))delete f.session[key]; };
async function load(f,options) {
    const s=new SpaceStore(options);s.discoverBookmarkSpaces=async()=>false;
    s.favoriteStore=f.favorite;
    s.isGlobalTab=value=>f.globals.has(typeof value==='object'?value.id:value);
    await s.initialize();return s;
}
function historyPreserved(f,s) {
    for(const record of f.history)assert(s.restoreQueue.some(r=>JSON.stringify(r)===JSON.stringify(record)));
}
function addDuplicate(f,{url='chrome://extensions/',id=9900,index=0}={}) {
    for(const tab of f.tabs)if(tab.windowId===10&&tab.index>=index)tab.index++;
    f.tabs.push({id,windowId:10,index,url,pinned:false,incognito:false,splitViewId:-1});
}
async function pending(inverted=false) {
    const f=fixture({inverted});
    for(const tab of f.tabs.filter(tab=>tab.windowId===20))tab.url=`https://other-window.test/${tab.id}`;
    for(const id of [...ids,108])f.tabs.push({id,index:f.tabs.length,windowId:10,url:`https://choice.test/${id}`,pinned:false,incognito:false,splitViewId:-1});
    f.store.spaces[0].temporaryTabs.push(...ids,108);
    f.store.windowKeys=new Map([[10,'current'],[20,'other']]);f.store.restoreWindowKeys=new Map();
    f.store.restoreQueue=[...ids,108].flatMap((id,i)=>[0,1].map(n=>({tabId:id,url:`https://choice.test/${id}`,spaceId:i<6?'target':'source',section:'temporaryTabs',windowKey:`old-${i}-${n}`,tabIndex:0,order:i})));
    f.store.recoveryCandidates=new Set([...ids,108]);await f.store.persist();
    f.history=structuredClone(f.store.restoreQueue);
    f.request.entries=(inverted?[...ids].reverse():ids).map(tabId=>({tabId,url:`https://choice.test/${tabId}`}));
    await moveTodayTabsToSpace(f.store,f.request);newEpoch(f);
    f.tabs.find(tab=>tab.id===1001).url='chrome://extensions/';
    f.s=await load(f);f.s.active[10]='source';
    assert(ids.every(id=>owner(f.s,id+1000)==='source'));
    f.request={...f.request,entries:(inverted?[...ids].reverse():ids).map(id=>({tabId:id+1000,url:`https://choice.test/${id}`}))};
    return f;
}
async function moveFresh(f) {
    await moveTodayTabsToSpace(f.s,f.request);
    return f.s.durableLayout.cohorts.find(c=>c.explicitOnly);
}

for(const inverted of [false,true])test(`fresh explicit seven survive duplicate unrelated Extensions after worker and session restart (inverted=${inverted})`,async()=>{
    const f=await pending(inverted),old=structuredClone(f.s.durableLayout.cohorts.filter(c=>f.s.layoutPending.has(c.id))),c=await moveFresh(f);

    assert.equal(c.placements.length,7);

    const ranks=c.placements.map(p=>p.order);
    for(const prior of old){
        const actual=f.s.durableLayout.cohorts.find(next=>next.id===prior.id);
        assert.deepEqual(actual.signature,prior.signature);assert.deepEqual(actual.placements,prior.placements);
        if(prior.placements.some(p=>ids.some(id=>prior.signature.find(slot=>slot.index===p.index)?.url===`https://choice.test/${id}`)))assert(actual.blockedBy.includes(c.id));
    }
    const warm=await load(f);
    assert.deepEqual(warm.spaces.find(s=>s.id==='target').temporaryTabs.filter(id=>selectedIds(1000).includes(id)),selectedIds(1000));
    historyPreserved(f,warm);
    for(let epoch=2;epoch<=4;epoch++){
        newEpoch(f);if(epoch===2)addDuplicate(f);const cold=await load(f),saved=cold.durableLayout.cohorts.find(next=>next.id===c.id);
        assert.deepEqual(cold.spaces.find(s=>s.id==='target').temporaryTabs.filter(id=>selectedIds(epoch*1000).includes(id)),selectedIds(epoch*1000));
        assert(ids.every(id=>cold.explicitToday.has(id+epoch*1000)));
        assert.equal(saved.signature.length,7);assert(saved.contextSubset);assert.deepEqual(saved.placements.map(p=>p.order),ranks);
        assert(!f.tabs.filter(t=>t.url==='chrome://extensions/').some(t=>cold.explicitToday.has(t.id)));
        historyPreserved(f,cold);assert(await readDurableLayout(f.local[DURABLE_LAYOUT_KEY]));
    }
});


for(const change of ['duplicate-choice','missing-choice','reordered-choices','multiple-windows','native-pin','favorite','split','pin-metadata','private','pending-navigation','missing-root'])test(`fresh subset refuses ${change} after restart without consuming history`,async()=>{
    const f=await pending(),c=await moveFresh(f);newEpoch(f);addDuplicate(f);
    const chosen=f.tabs.find(t=>t.id===2101);
    if(change==='duplicate-choice')addDuplicate(f,{url:chosen.url,index:chosen.index,id:9910});
    if(change==='missing-choice')f.tabs.splice(f.tabs.indexOf(chosen),1);
    if(change==='reordered-choices'){const next=f.tabs.find(t=>t.id===2102);[chosen.index,next.index]=[next.index,chosen.index];}
    if(change==='multiple-windows')f.tabs.push(...f.tabs.filter(t=>selectedIds(2000).includes(t.id)).map(t=>({...t,id:t.id+5000,windowId:30})));
    if(change==='native-pin')chosen.pinned=true;
    if(change==='favorite')f.globals.add(chosen.id);
    if(change==='split')chosen.splitViewId=42;
    if(change==='pin-metadata')f.hooks.afterSet=(area,value)=>{if(area==='local'&&value.pinnedTabStatesById)f.local.pinnedTabStatesById[chosen.id]={bookmarkId:'pin'};};
    if(change==='private')chosen.incognito=true;
    if(change==='pending-navigation')chosen.pendingUrl='https://pending-navigation.test/';
    if(change==='missing-root')f.local.spaces.find(s=>s.id==='target').bookmarkFolderId='missing-root';
    const before=structuredClone(f.local[DURABLE_LAYOUT_KEY].cohorts.find(next=>next.id===c.id)),cold=await load(f);
    assert(selectedIds(2000).every(id=>!cold.explicitToday.has(id)));
    assert(cold.layoutPending.has(c.id));historyPreserved(f,cold);
    assert.deepEqual(f.local[DURABLE_LAYOUT_KEY].cohorts.find(next=>next.id===c.id),before);
});

for(const change of ['name','pin','split','epoch','ownership'])test(`fresh subset fences late ${change} changes`,async()=>{
    const f=await pending(),persist=f.s.persist.bind(f.s),before=structuredClone(f.local[DURABLE_LAYOUT_KEY]);
    f.s.persist=options=>persist({...options,beforeWrite:async()=>{
        await options.beforeWrite();
        if(change==='name')f.local.tabNameOverridesById[1101]={name:'Alias'};
        if(change==='pin')f.local.pinnedTabStatesById[1101]={name:'Pin metadata'};
        if(change==='split')f.tabs.find(t=>t.id===1101).splitViewId=7;
        if(change==='epoch')f.session.spaceExplicitTodayEpoch='changed-session';
        if(change==='ownership')f.s.explicitToday.get(1101).spaceId='source';
    }});
    await assert.rejects(moveFresh(f));assert.deepEqual(f.local[DURABLE_LAYOUT_KEY],before);historyPreserved(f,f.s);
});


async function reseal(ledger) {
    ledger.fingerprint=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(encode({revision:ledger.revision,cohorts:ledger.cohorts,snapshotProof:ledger.snapshotProof}))))).map(b=>b.toString(16).padStart(2,'0')).join('');
}
function browserProof(f) {
    f.identity={epoch:'browser-epoch-token',generation:'browser-generation-token'};
    f.favorite={initialize:async()=>{},reconcile:async()=>{},ownsTab:()=>false,ownershipPersistence:{browserIdentity:async()=>f.identity}};
    f.s.favoriteStore=f.favorite;
}
async function legacyFull({browser=false,inverted=false,unprovenContext=false}={}) {
    const f=await pending(inverted);if(browser)browserProof(f);
    if(unprovenContext){
        f.s.restoreQueue.push(...['source','target'].map(spaceId=>({tabId:11,url:'chrome://extensions/',spaceId,section:'temporaryTabs',windowKey:`unproven-${spaceId}`,tabIndex:0,order:0})));
        f.s.recoveryCandidates.add(1001);f.history=structuredClone(f.s.restoreQueue);
    }
    const c=await moveFresh(f),w=layoutWindows(f.s,f.tabs).find(w=>w.id===10);
    // Synthetic old-format checkpoint, equivalent to the previous capture path.
    c.signature=structuredClone(w.signature);c.binding.tabIds=w.tabs.map(t=>t.id);delete c.contextSubset;
    await reseal(f.s.durableLayout);f.local[DURABLE_LAYOUT_KEY]=structuredClone(f.s.durableLayout);
    f.legacy=structuredClone(c);return f;
}
function predecessorPreserved(f,s,next) {
    const prior=s.durableLayout.cohorts.find(c=>c.id===f.legacy.id);
    const {blockedBy,...unchanged}=prior,{blockedBy:oldEdges,...original}=f.legacy;
    assert.deepEqual(unchanged,original);assert((oldEdges||[]).every(id=>blockedBy.includes(id)));
    assert(prior.blockedBy.includes(next.id));assert(next.choiceRevision>prior.choiceRevision);
    historyPreserved(f,s);
}

test('ordinary worker reload does not rewrite an already-bound legacy full cohort',async()=>{
    const f=await legacyFull(),before=structuredClone(f.local[DURABLE_LAYOUT_KEY].cohorts);
    const warm=await load(f);assert.deepEqual(warm.durableLayout.cohorts,before);
    assert.equal(warm.durableLayout.cohorts.filter(c=>c.explicitOnly).length,1);
    assert(!warm.durableLayout.cohorts.find(c=>c.id===f.legacy.id).contextSubset);historyPreserved(f,warm);
});

for(const inverted of [false,true])test(`a new different-Space explicit choice supersedes legacy full capture without rewriting it (inverted=${inverted})`,async()=>{
    const f=await legacyFull({inverted});f.s.active[10]='target';
    await moveTodayTabsToSpace(f.s,{...f.request,spaceId:'target',bookmarkFolderId:'target-root',destinationSpaceId:'source',destinationBookmarkFolderId:'source-root'});
    const next=f.s.durableLayout.cohorts.find(c=>c.contextSubset&&c.id!==f.legacy.id);
    assert(next);assert.equal(next.signature.length,7);assert.deepEqual(next.binding.tabIds,selectedIds(1000));
    assert(next.placements.every(p=>p.spaceId==='source'));predecessorPreserved(f,f.s,next);
    newEpoch(f);addDuplicate(f);const cold=await load(f);
    assert.deepEqual(cold.spaces.find(s=>s.id==='source').temporaryTabs.filter(id=>selectedIds(2000).includes(id)),selectedIds(2000));
    assert(selectedIds(2000).every(id=>cold.explicitToday.has(id)));predecessorPreserved(f,cold,next);
});

for(const unprovenContext of [true,false])test(`pure authenticated replay preserves legacy placement scope without recapture (unprovenContext=${unprovenContext})`,async()=>{
    const f=await legacyFull({browser:true,unprovenContext}),before=structuredClone(f.s.spaces),native=structuredClone(f.tabs);
    const cohorts=f.s.durableLayout.cohorts.map(c=>c.id),placements=structuredClone(f.legacy.placements);
    delete f.session.spaceSession;const replay=await load(f);
    const current=replay.durableLayout.cohorts.find(c=>c.id===f.legacy.id);
    assert.deepEqual(replay.durableLayout.cohorts.map(c=>c.id),cohorts);
    assert.equal(current.placements.length,7);assert.deepEqual(current.placements,placements);
    assert.equal(current.signature.length,f.legacy.signature.length);assert(!current.contextSubset);
    assert.deepEqual(replay.spaces,before);assert.deepEqual(f.tabs,native);
    assert.equal(replay.explicitToday.has(1001),!unprovenContext);
    await replay.persist();assert.equal(replay.durableLayout.cohorts.find(c=>c.id===f.legacy.id).placements.length,7);
    historyPreserved(f,replay);
});

for(const mode of ['no-choice','not-explicit','no-witness','expired-epoch','unbound'])test(`legacy successor refuses ${mode} authority`,async()=>{
    const f=await legacyFull(),c=f.s.durableLayout.cohorts.find(c=>c.id===f.legacy.id);
    if(mode==='not-explicit'){delete c.explicitOnly;delete c.choiceRevision;for(const prior of f.s.durableLayout.cohorts)if(prior.blockedBy)prior.blockedBy=prior.blockedBy.filter(id=>id!==c.id);}
    if(mode==='no-witness')f.s.explicitToday.clear();
    if(mode==='expired-epoch')f.session.spaceExplicitTodayEpoch='unrelated-epoch';
    if(mode==='unbound'){c.binding=null;f.s.layoutPending.add(c.id);f.s.explicitToday.clear();}
    const checkpoint=await readExplicitCheckpoint(f.local);
    const result=await captureDurableLayout(f.s,f.tabs,checkpoint.live,f.local.spaceRankCheckpoint.fingerprint,{allowFreshExplicit:mode!=='no-choice',provenContextOnly:true,explicitIntentIds:mode!=='no-choice'?selectedIds(1000):[]});
    assert(!result.cohorts.some(next=>next.contextSubset));
    assert.equal(result.cohorts.length,f.s.durableLayout.cohorts.length);
});

test('mixed actual and expired secondary witnesses cannot commit a legacy successor',async()=>{
    const f=await legacyFull({browser:true}),checkpoint=await readExplicitCheckpoint(f.local);
    const sessionEpoch=f.s.explicitTodayEpochs.find(e=>e.kind==='session');assert(sessionEpoch);
    f.s.explicitToday.get(1107).epoch=structuredClone(sessionEpoch);
    const before=structuredClone(f.local[DURABLE_LAYOUT_KEY]);
    const candidate=await captureDurableLayout(f.s,f.tabs,checkpoint.live,f.local.spaceRankCheckpoint.fingerprint,{allowFreshExplicit:true,provenContextOnly:true,explicitIntentIds:selectedIds(1000)});
    assert(candidate.cohorts.some(c=>c.contextSubset));
    delete f.session.spaceExplicitTodayEpoch;
    await assert.rejects(f.s.layoutWriteFence(),/Fresh native layout changed/);
    assert.deepEqual(f.local[DURABLE_LAYOUT_KEY],before);
});


for(const inverted of [false,true])test(`an existing seven-slot subset survives authenticated extra replay and duplicate-context restart (inverted=${inverted})`,async()=>{
    const f=await pending(inverted);browserProof(f);const saved=structuredClone(await moveFresh(f));
    const cohortIds=f.s.durableLayout.cohorts.map(c=>c.id);
    for(let i=0;i<2;i++){
        delete f.session.spaceSession;const replay=await load(f);assert(replay.explicitToday.has(1001));
        assert.deepEqual(replay.durableLayout.cohorts.map(c=>c.id),cohortIds);
        const current=replay.durableLayout.cohorts.find(c=>c.id===saved.id);
        assert.deepEqual(current.signature,saved.signature);assert.deepEqual(current.placements,saved.placements);
        assert.equal(current.signature.length,7);assert(!current.binding.tabIds.includes(1001));
        await replay.persist();historyPreserved(f,replay);
    }
    newEpoch(f);f.identity=null;addDuplicate(f);const cold=await load(f);
    assert(selectedIds(2000).every(id=>owner(cold,id)==='target'&&cold.explicitToday.has(id)));historyPreserved(f,cold);
});

test('a one-tab new choice retains all other proven placements in the legacy successor',async()=>{
    const f=await legacyFull();f.s.active[10]='target';
    await moveTodayTabsToSpace(f.s,{...f.request,spaceId:'target',bookmarkFolderId:'target-root',destinationSpaceId:'source',destinationBookmarkFolderId:'source-root',entries:[f.request.entries[0]]});
    const next=f.s.durableLayout.cohorts.find(c=>c.contextSubset&&c.id!==f.legacy.id);
    assert.equal(next.placements.length,7);assert.deepEqual(next.binding.tabIds,selectedIds(1000));predecessorPreserved(f,f.s,next);
    newEpoch(f);addDuplicate(f);const cold=await load(f);
    assert.equal(owner(cold,2101),'source');assert(ids.slice(1).every(id=>owner(cold,id+2000)==='target'));
    assert(selectedIds(2000).every(id=>cold.explicitToday.has(id)));historyPreserved(f,cold);
});

for(const change of ['incarnation','transaction','coherent-owner','missing-selected','missing-context','moved-window','canonical-order'])test(`legacy successor final fence rejects ${change}`,async()=>{
    const f=await legacyFull(),checkpoint=await readExplicitCheckpoint(f.local),before=structuredClone(f.local[DURABLE_LAYOUT_KEY]);
    const result=await captureDurableLayout(f.s,f.tabs,checkpoint.live,f.local.spaceRankCheckpoint.fingerprint,{allowFreshExplicit:true,provenContextOnly:true,explicitIntentIds:selectedIds(1000)});
    assert(result.cohorts.some(c=>c.contextSubset));
    if(change==='incarnation'||change==='transaction')f.s.explicitToday.get(1101)[change]='changed-proof-token';
    if(change==='coherent-owner'){
        f.s.spaces.find(s=>s.id==='target').temporaryTabs=f.s.spaces.find(s=>s.id==='target').temporaryTabs.filter(id=>id!==1101);
        f.s.spaces.find(s=>s.id==='source').temporaryTabs.push(1101);
        Object.assign(f.s.explicitToday.get(1101),{spaceId:'source',bookmarkFolderId:'source-root'});
    }
    if(change==='missing-selected'||change==='missing-context')f.tabs.splice(f.tabs.findIndex(t=>t.id===(change==='missing-selected'?1101:1001)),1);
    if(change==='moved-window')f.tabs.find(t=>t.id===1101).windowId=30;
    if(change==='canonical-order')f.s.spaces.find(s=>s.id==='target').temporaryTabs.reverse();
    await assert.rejects(f.s.layoutWriteFence(),/Fresh native layout changed/);
    assert.deepEqual(f.local[DURABLE_LAYOUT_KEY],before);
});


test('legacy recapture cannot supersede an outgoing newer-choice blocker through replay',async()=>{
    const f=await legacyFull(),c=f.s.durableLayout.cohorts.find(c=>c.id===f.legacy.id),next=structuredClone(c);
    next.id='newer-unresolved-choice';next.choiceRevision=++f.s.durableLayout.revision;next.binding=null;
    next.signature[0].url='https://missing-newer-choice.test/';
    c.blockedBy=[next.id];f.s.durableLayout.cohorts.push(next);f.s.layoutPending.add(next.id);
    await reseal(f.s.durableLayout);assert(await readDurableLayout(f.s.durableLayout));
    const checkpoint=await readExplicitCheckpoint(f.local);
    const result=await captureDurableLayout(f.s,f.tabs,checkpoint.live,f.local.spaceRankCheckpoint.fingerprint,{allowFreshExplicit:true,provenContextOnly:true,explicitIntentIds:selectedIds(1000)});
    assert(!result.cohorts.some(next=>next.contextSubset));assert.equal(result.cohorts.length,f.s.durableLayout.cohorts.length);
    assert.deepEqual(result.cohorts.find(n=>n.id===next.id),next);
    assert.deepEqual(result.cohorts.find(n=>n.id===c.id).blockedBy,[next.id]);
});


test('secondary witness revoked during final native query refuses the fresh commit',async()=>{
    const f=await legacyFull({browser:true}),checkpoint=await readExplicitCheckpoint(f.local),before=structuredClone(f.local[DURABLE_LAYOUT_KEY]);
    f.s.explicitToday.get(1107).epoch=structuredClone(f.s.explicitTodayEpochs.find(e=>e.kind==='session'));
    await captureDurableLayout(f.s,f.tabs,checkpoint.live,f.local.spaceRankCheckpoint.fingerprint,{allowFreshExplicit:true,provenContextOnly:true,explicitIntentIds:selectedIds(1000)});
    let queried=false;f.hooks.query=()=>{queried=true;delete f.session.spaceExplicitTodayEpoch;};
    await assert.rejects(f.s.layoutWriteFence(),/Fresh native layout changed/);assert(queried);
    assert.deepEqual(f.local[DURABLE_LAYOUT_KEY],before);
});


const event=()=>({listeners:[],addListener(fn){this.listeners.push(fn);},async emit(...args){await Promise.all(this.listeners.map(fn=>fn(...args)));}});
function events(){
    for(const key of ['onCreated','onUpdated','onRemoved','onReplaced','onActivated','onMoved','onAttached','onDetached'])chrome.tabs[key]=event();
    for(const key of ['onRemoved','onUpdated'])chrome.tabGroups[key]=event();chrome.storage.onChanged=event();
}
for(const inverted of [false,true])test(`a genuinely observed creation still expands a nonprimary Space subset and survives a new epoch (inverted=${inverted})`,async()=>{
    const f=await pending(inverted),saved=await moveFresh(f);events();f.s.install();f.s.active[10]='target';
    const tab={id:9900,index:30,windowId:10,url:'https://new-intent.test/created',pinned:false,incognito:false,splitViewId:-1};
    f.tabs.push(tab);await chrome.tabs.onCreated.emit(tab);await f.s.chain;
    assert.equal(owner(f.s,9900),'target');assert(f.s.explicitToday.has(9900));
    const next=f.s.durableLayout.cohorts.find(c=>c.contextSubset&&c.id!==saved.id);
    assert(next);assert.equal(next.placements.length,8);assert(next.binding.tabIds.includes(9900));
    const expected=f.s.spaces.find(s=>s.id==='target').temporaryTabs.filter(id=>selectedIds(1000).includes(id)||id===9900);
    newEpoch(f);addDuplicate(f);const cold=await load(f),wanted=expected.map(id=>id+1000);
    assert.deepEqual(cold.spaces.find(s=>s.id==='target').temporaryTabs.filter(id=>wanted.includes(id)),wanted);
    assert(wanted.every(id=>cold.explicitToday.has(id)));
    const withoutRank=({order,...r})=>r;for(const record of f.history)assert(cold.restoreQueue.some(r=>JSON.stringify(withoutRank(r))===JSON.stringify(withoutRank(record))));
});

for(const limit of ['cohorts','revision'])test(`fresh recapture refuses ${limit} overflow without writing an unreadable checkpoint`,async()=>{
    const f=await legacyFull(),ledger=f.s.durableLayout,c=ledger.cohorts.find(c=>c.id===f.legacy.id);
    if(limit==='cohorts')while(ledger.cohorts.length<1000){
        const extra=structuredClone(c);extra.id=`capacity-${ledger.cohorts.length}`;extra.binding=null;
        extra.signature=extra.signature.map(slot=>({...slot,url:`https://capacity.test/${extra.id}/${slot.index}`}));
        ledger.cohorts.push(extra);f.s.layoutPending.add(extra.id);
    }
    else ledger.revision=Number.MAX_SAFE_INTEGER;
    await reseal(ledger);assert(await readDurableLayout(ledger));
    f.local[DURABLE_LAYOUT_KEY]=structuredClone(ledger);const before=structuredClone(f.local);
    const checkpoint=await readExplicitCheckpoint(f.local);
    await assert.rejects(captureDurableLayout(f.s,f.tabs,checkpoint.live,f.local.spaceRankCheckpoint.fingerprint,{allowFreshExplicit:true,provenContextOnly:true,explicitIntentIds:selectedIds(1000)}),/supported limits/);
    assert.deepEqual(f.local,before);assert(await readDurableLayout(f.local[DURABLE_LAYOUT_KEY]));
});


for(const action of ['move','creation'])test(`real ${action} after replay adds only its intended ID, not replay-proven Extensions`,async()=>{
    const f=await pending();browserProof(f);await moveFresh(f);
    delete f.session.spaceSession;f.s=await load(f);assert(f.s.explicitToday.has(1001));
    let intended;
    if(action==='move'){
        intended=1108;f.s.active[10]='source';
        await moveTodayTabsToSpace(f.s,{...f.request,entries:[{tabId:intended,url:f.tabs.find(t=>t.id===intended).url}]});
    }else{
        intended=9900;events();f.s.install();f.s.active[10]='target';
        const tab={id:intended,index:30,windowId:10,url:'https://new-intent.test/after-replay',pinned:false,incognito:false,splitViewId:-1};
        f.tabs.push(tab);await chrome.tabs.onCreated.emit(tab);await f.s.chain;
    }
    const latest=f.s.durableLayout.cohorts.filter(c=>c.binding?.windowId===10).sort((a,b)=>(b.choiceRevision||0)-(a.choiceRevision||0))[0];
    assert.equal(latest.placements.length,8);assert(latest.binding.tabIds.includes(intended));assert(!latest.binding.tabIds.includes(1001));
    newEpoch(f);f.identity=null;addDuplicate(f);const cold=await load(f);
    assert([...selectedIds(2000),intended+1000].every(id=>owner(cold,id)==='target'&&cold.explicitToday.has(id)));
});

for(const action of ['move','creation'])test(`real ${action} in one window does not widen replay-only context in another`,async()=>{
    const f=await pending();browserProof(f);await moveFresh(f);
    f.tabs.push({id:8000,index:30,windowId:20,url:'chrome://extensions/',pinned:false,incognito:false,splitViewId:-1});
    // Reload, rather than persisting the added tab, keeps the existing two-tab
    // window baseline and restores it as a mapped subset around the extra.
    f.s=await load(f);const other=f.s.durableLayout.cohorts.find(c=>c.contextSubset&&c.binding?.windowId===20);
    assert(other);assert.equal(other.binding.tabIds.length,2);
    delete f.session.spaceSession;f.s=await load(f);assert(f.s.explicitToday.has(8000));
    if(action==='move'){
        f.s.active[10]='target';await moveTodayTabsToSpace(f.s,{...f.request,spaceId:'target',bookmarkFolderId:'target-root',destinationSpaceId:'source',destinationBookmarkFolderId:'source-root',entries:[f.request.entries[0]]});
    }else{
        events();f.s.install();f.s.active[10]='target';
        const tab={id:9900,index:30,windowId:10,url:'https://new-intent.test/window-one',pinned:false,incognito:false,splitViewId:-1};
        f.tabs.push(tab);await chrome.tabs.onCreated.emit(tab);await f.s.chain;
    }
    const after=f.s.durableLayout.cohorts.filter(c=>c.binding?.windowId===20);
    assert.equal(after.length,1);assert.equal(after[0].id,other.id);
    assert.deepEqual(after[0].binding.tabIds,other.binding.tabIds);assert.equal(after[0].placements.length,2);
    assert(!after[0].signature.some(t=>t.url==='chrome://extensions/'));
});

for(const sourceEpoch of ['current','expired'])test(`pending pure replay preserves prior seven-slot scope with ${sourceEpoch} predecessor proof`,async()=>{
    const f=await legacyFull({browser:true}),old=structuredClone(f.legacy);
    if(sourceEpoch==='expired'){
        const c=f.s.durableLayout.cohorts.find(c=>c.id===f.legacy.id);
        c.binding.epoch={kind:'session',epoch:'expired-session-token'};
        await reseal(f.s.durableLayout);f.local[DURABLE_LAYOUT_KEY]=structuredClone(f.s.durableLayout);
    }
    const cohortIds=f.s.durableLayout.cohorts.map(c=>c.id);addDuplicate(f);delete f.session.spaceSession;
    const replay=await load(f);assert(replay.explicitToday.has(1001));
    const added=replay.durableLayout.cohorts.filter(c=>!cohortIds.includes(c.id));
    if(sourceEpoch==='current'){
        assert.equal(added.length,1);assert.equal(added[0].signature.length,7);assert.deepEqual(added[0].binding.tabIds,selectedIds(1000));
        assert(!added[0].signature.some(t=>t.url==='chrome://extensions/'));predecessorPreserved(f,replay,added[0]);
        newEpoch(f);f.identity=null;const cold=await load(f);assert(selectedIds(2000).every(id=>owner(cold,id)==='target'&&cold.explicitToday.has(id)));
    }else{
        assert.equal(added.length,0);assert(replay.layoutPending.has(old.id));
        assert.deepEqual(replay.durableLayout.cohorts.find(c=>c.id===old.id).signature,old.signature);
    }
});


for(const subset of [false,true])test(`moving an unplaced in-binding context anchor issues new explicit authority (subset=${subset})`,async()=>{
    const f=await legacyFull(),legacy=f.s.durableLayout.cohorts.find(c=>c.id===f.legacy.id);
    if(subset){legacy.contextSubset=true;await reseal(f.s.durableLayout);f.local[DURABLE_LAYOUT_KEY]=structuredClone(f.s.durableLayout);}
    assert(!f.s.explicitToday.has(1001));assert(legacy.binding.tabIds.includes(1001));
    f.s.active[10]='source';await moveTodayTabsToSpace(f.s,{...f.request,entries:[{tabId:1001,url:'chrome://extensions/'}]});
    assert(f.s.explicitToday.has(1001));
    const latest=f.s.durableLayout.cohorts.filter(c=>c.binding?.windowId===10).sort((a,b)=>(b.choiceRevision||0)-(a.choiceRevision||0))[0];
    assert.equal(latest.placements.length,8);assert(latest.placements.some(p=>latest.binding.tabIds[latest.signature.findIndex(t=>t.index===p.index)]===1001));
    newEpoch(f);const cold=await load(f);assert([...selectedIds(2000),2001].every(id=>owner(cold,id)==='target'&&cold.explicitToday.has(id)));
});

test('pure pending replay preserves an unresolved override instead of dropping it through a successor',async()=>{
    const f=await legacyFull({browser:true}),legacy=f.s.durableLayout.cohorts.find(c=>c.id===f.legacy.id);
    const override={tabId:9999,incarnation:'unproven-override',epoch:structuredClone(legacy.binding.epoch)};
    legacy.overrides.push(override);await reseal(f.s.durableLayout);f.local[DURABLE_LAYOUT_KEY]=structuredClone(f.s.durableLayout);
    const ids=f.s.durableLayout.cohorts.map(c=>c.id);addDuplicate(f);delete f.session.spaceSession;
    const replay=await load(f);assert.deepEqual(replay.durableLayout.cohorts.map(c=>c.id),ids);
    const retained=replay.durableLayout.cohorts.find(c=>c.id===legacy.id);
    assert(retained.overrides.some(o=>JSON.stringify(o)===JSON.stringify(override)));
    assert.deepEqual(retained.signature,legacy.signature);assert(replay.layoutPending.has(legacy.id));
});

test('a one-tab move retains all seven proven current placements when legacy context is pending',async()=>{
    const f=await legacyFull({browser:true});addDuplicate(f);f.s=await load(f);
    assert(f.s.layoutPending.has(f.legacy.id));
    assert(f.s.durableLayout.cohorts.find(c=>c.id===f.legacy.id).overrides.length>0);
    f.s.active[10]='target';await moveTodayTabsToSpace(f.s,{...f.request,spaceId:'target',bookmarkFolderId:'target-root',destinationSpaceId:'source',destinationBookmarkFolderId:'source-root',entries:[f.request.entries[0]]});
    const latest=f.s.durableLayout.cohorts.filter(c=>c.binding?.windowId===10).sort((a,b)=>(b.choiceRevision||0)-(a.choiceRevision||0))[0];
    assert.equal(latest.placements.length,7);assert.deepEqual(latest.binding.tabIds,selectedIds(1000));
    assert(!latest.signature.some(t=>t.url==='chrome://extensions/'));
    newEpoch(f);f.identity=null;const cold=await load(f);
    assert.equal(owner(cold,2101),'source');assert(ids.slice(1).every(id=>owner(cold,id+2000)==='target'));
    assert(selectedIds(2000).every(id=>cold.explicitToday.has(id)));
});


for (const mutation of ['stable', 'unsplit', 'different-pair', 'excluded-partner']) test(`fresh checkpoint preserves existing native split: ${mutation}`, async () => {
    const f = await pending();
    await moveFresh(f);
    f.tabs.find(t => t.id === 1101).splitViewId = 77;
    f.tabs.find(t => t.id === 1102).splitViewId = 77;
    if (mutation === 'excluded-partner') {
        f.globals.add(1102);
        for (const space of f.s.spaces) space.temporaryTabs = space.temporaryTabs.filter(id=>id!==1102);
        f.s.explicitToday.delete(1102);
    }
    const persist = f.s.persist.bind(f.s);
    f.s.persist = options => persist({...options, beforeWrite: async () => {
        await options.beforeWrite?.();
        if (mutation === 'excluded-partner') f.tabs.find(t => t.id === 1102).splitViewId = -1;
        if (mutation === 'unsplit') f.tabs.find(t => t.id === 1101).splitViewId = -1;
        if (mutation === 'different-pair') {
            f.tabs.find(t => t.id === 1102).splitViewId = -1;
            f.tabs.find(t => t.id === 1103).splitViewId = 77;
        }
    }});
    const run = () => moveTodayTabsToSpace(f.s, {...f.request, entries: [{tabId:1108,url:'https://choice.test/108'}]});
    if (mutation === 'stable') {
        await run();
        assert.equal(owner(f.s, 1108), 'target');
        assert.equal(JSON.stringify(f.local[DURABLE_LAYOUT_KEY]).includes('splitViewId'), false);
    } else await assert.rejects(run(), /Fresh native layout changed/);
});

test('saved split reopen persists new blanks beside an existing native pair', async () => {
    const { runSavedSplitAction, SAVED_SPLITS_KEY } = await import('../../saved-splits.js');
    const f = await pending(); await moveFresh(f);
    for (const id of [1101,1102]) f.tabs.find(t => t.id === id).splitViewId = 77;
    f.s.active[10] = 'target';
    f.local[SAVED_SPLITS_KEY] = [{id:'recipe',name:'Pair',pages:[{url:'https://choice.test/101',title:'A'},{url:'https://choice.test/102',title:'B'}]}];
    let nextId = 12000;
    chrome.tabs.create = async options => {
        const tab = {id:nextId++,windowId:10,index:Math.max(...f.tabs.filter(t=>t.windowId===10).map(t=>t.index))+1,
            url:options.url,pinned:false,incognito:false,splitViewId:-1,groupId:-1};
        f.tabs.push(tab);
        f.s.layoutObservedCreations.set(tab.id,{windowId:10,worker:f.s.currentLayoutWorker,token:crypto.randomUUID()});
        return structuredClone(tab);
    };
    chrome.tabs.get = async id => structuredClone(f.tabs.find(t=>t.id===id));
    chrome.tabs.createSplit = async ids => { for(const id of ids) f.tabs.find(t=>t.id===id).splitViewId=88; return 88; };
    chrome.tabs.unsplit = async () => assert.fail('Must not unsplit');
    chrome.tabs.update = async (id, update) => Object.assign(f.tabs.find(t=>t.id===id),update);
    const result = await runSavedSplitAction(f.s,{type:'savedSplitAction',action:'open',windowId:10,spaceId:'target',bookmarkFolderId:'target-root',recipeId:'recipe'});
    assert.deepEqual(result.tabIds,[12000,12001]);
    assert.deepEqual(result.tabIds.map(id=>f.tabs.find(t=>t.id===id).url),['https://choice.test/101','https://choice.test/102']);
    assert([1101,1102].every(id=>f.tabs.find(t=>t.id===id).splitViewId===77));
});
