import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './today-recovery-fixture.js';
import { SpaceStore } from '../../space-store.js';
import { prepareProvenContextRepair } from '../../proven-context-repair.js';
import { DURABLE_LAYOUT_KEY, sealDurableLayout, readDurableLayout } from '../../durable-today-layout.js';
import { EXPLICIT_TODAY_CHECKPOINT, stageExplicitToday, createExplicitCheckpoint } from '../../explicit-today-ownership.js';
import { createSpaceRankCheckpoint } from '../../space-continuity.js';
const copy = value => structuredClone(value);
const event=()=>({listeners:new Set(),addListener(fn){this.listeners.add(fn);},removeListener(fn){this.listeners.delete(fn);},emit(...args){for(const fn of this.listeners)fn(...args);}});
function installEvents(f){
    f.events=[];
    for(const [target,names] of [[chrome.storage,['onChanged']],[chrome.tabs,['onUpdated','onCreated','onRemoved','onReplaced','onMoved','onAttached','onDetached']],
        [chrome.bookmarks,['onCreated','onRemoved','onMoved','onChanged']],[chrome.windows,['onRemoved']]])
        for(const name of names){target[name]=event();f.events.push(target[name]);}
}

async function setup({inverted=false, browser=false, contextSubset=false}={}) {
    const f=fixture({inverted});installEvents(f); f.ids=[101,102,103,104,105,106,107];
    f.tabs.splice(0,f.tabs.length,...[1,2,...f.ids].map((id,index)=>({id,index,windowId:10,
        url:id===1?'chrome://extensions/':`https://repair.test/${id}`,pinned:false,incognito:false,splitViewId:-1})));
    f.store.spaces[0].temporaryTabs=[1,2]; f.store.spaces[0].spaceBookmarks=[];
    f.store.spaces[1].temporaryTabs=inverted?[...f.ids].reverse():[...f.ids];
    f.store.todayOrderInverted=inverted; f.local.pinnedTabStatesById={}; f.local.tabNameOverridesById={};
    f.session.spaceExplicitTodayEpoch='current-session';
    if(browser){f.identity={epoch:'current-browser-token',generation:'current-generation'};f.favorite={initialize:async()=>{},reconcile:async()=>{},ownsTab:()=>false,ownershipPersistence:{browserIdentity:async()=>f.identity}};f.store.favoriteStore=f.favorite;}
    const stage=await stageExplicitToday(f.store,f.tabs.filter(t=>f.ids.includes(t.id)),{spaceId:'target',bookmarkFolderId:'target-root'});
    f.store.explicitToday=stage.bindings;f.store.explicitTodayEpoch=stage.epoch;f.store.explicitTodayEpochs=stage.epochs;
    f.history=[{tabId:8001,url:'https://unresolved.test/',spaceId:'source',section:'temporaryTabs',windowKey:'historical',tabIndex:0,order:3,nameOverride:{name:'Unresolved'}}];
    f.session.spaceRestoreQueue=copy(f.history);f.session.spaceWindowKeys=[[10,'current']];f.store.windowKeys=new Map([[10,'current']]);
    f.store.restoreQueue=copy(f.history); f.store.recoveryCandidates=new Set(); f.store.layoutProvisional=new Set();
    f.store.layoutPending=new Set();f.store.layoutRemovedIds=new Set();f.store.restoredRanks=new Map();
    f.snapshot=f.store.spaces.flatMap(s=>s.temporaryTabs.map((id,order)=>{f.store.restoredRanks.set(id,order);const t=f.tabs.find(t=>t.id===id);return {tabId:id,spaceId:s.id,section:'temporaryTabs',order,url:t.url,tabIndex:t.index,windowKey:'current',...(stage.bindings.has(id)?{currentOwnership:copy(stage.bindings.get(id))}:{})};}));
    f.cohort={id:'explicit-full',explicitOnly:true,choiceRevision:2,...(contextSubset?{contextSubset:true}:{}),
        signature:f.tabs.map(t=>({index:t.index,url:t.url,pinned:false})),
        placements:f.snapshot.filter(r=>f.ids.includes(r.tabId)).map(r=>({index:r.tabIndex,spaceId:r.spaceId,bookmarkFolderId:'target-root',order:r.order})),
        binding:{epoch:stage.epoch,windowId:10,tabIds:f.tabs.map(t=>t.id)},overrides:[]};
    f.local.spaces=copy(f.store.spaces);f.local.spaceTabSnapshot=[...copy(f.snapshot),...copy(f.history)];
    f.local.spaceRankCheckpoint=await createSpaceRankCheckpoint([...f.store.restoredRanks],f.local.spaceTabSnapshot);
    f.local[EXPLICIT_TODAY_CHECKPOINT]=await createExplicitCheckpoint(f.snapshot.length,f.local.spaceRankCheckpoint.fingerprint);
    f.local[DURABLE_LAYOUT_KEY]=await sealDurableLayout(2,[f.cohort],{liveCount:f.snapshot.length,rankFingerprint:f.local.spaceRankCheckpoint.fingerprint});
    f.store.durableLayout=copy(f.local[DURABLE_LAYOUT_KEY]); f.effects.length=0; return f;
}
const prepare=f=>prepareProvenContextRepair(f.store,copy(f.tabs),copy(f.snapshot),f.local.spaceRankCheckpoint.fingerprint);
async function reseal(f,cohorts,revision=3){ f.local[DURABLE_LAYOUT_KEY]=await sealDurableLayout(revision,cohorts,f.local[DURABLE_LAYOUT_KEY].snapshotProof);f.store.durableLayout=copy(f.local[DURABLE_LAYOUT_KEY]); }
async function reload(f,options){const store=new SpaceStore(options);store.favoriteStore=f.favorite;store.discoverBookmarkSpaces=async()=>false;await store.initialize();return store;}
const owner=(s,id)=>s.spaces.find(s=>s.temporaryTabs.includes(id))?.id;
const noActions=f=>assert(!f.effects.some(([kind])=>['move','group','groupMove','groupUpdate'].includes(kind)));
function duplicateExtension(f){f.tabs.push({...copy(f.tabs[0]),id:999,index:20});}

for(const inverted of [false,true])test(`no-move repair captures exactly seven placements, preserving predecessor/history, inverted=${inverted}`,async()=>{
    const f=await setup({inverted});duplicateExtension(f);
    // The neighbour is a proven current incarnation too, but is not a placement.
    const extra=await stageExplicitToday(f.store,[f.tabs[0]],{spaceId:'source',bookmarkFolderId:'source-root'});
    f.store.explicitToday=extra.bindings;
    const before=copy(f.store.spaces),history=copy(f.local.spaceTabSnapshot.slice(f.snapshot.length));
    const repair=await prepare(f);assert(repair);assert.equal(repair.layout.cohorts.length,2);
    const [old,next]=repair.layout.cohorts;assert.deepEqual(old,{...f.cohort,blockedBy:[next.id]});
    assert.deepEqual(next.binding.tabIds,f.ids);assert.equal(next.signature.length,7);assert.equal(next.placements.length,7);
    assert.deepEqual(f.store.spaces,before);assert.deepEqual(f.local.spaceTabSnapshot.slice(f.snapshot.length),history);noActions(f);
    await repair.validate();assert(await readDurableLayout(repair.layout));
});

for(const inverted of [false,true])test(`ordinary same-session persistence repairs once and next epoch restores seven despite duplicate Extensions, inverted=${inverted}`,async()=>{
    const f=await setup({inverted});duplicateExtension(f);const spaces=copy(f.store.spaces),old=copy(f.cohort),history=copy(f.history);
    await f.store.persist({skipGroupSync:true});const next=f.local[DURABLE_LAYOUT_KEY].cohorts.find(c=>c.id!==old.id);assert(next);
    assert.deepEqual(f.store.spaces,spaces);assert.deepEqual(f.local.spaceTabSnapshot.slice(-history.length),history);
    for(let i=0;i<3;i++)await f.store.persist({skipGroupSync:true});
    assert.equal(f.local[DURABLE_LAYOUT_KEY].cohorts.length,2);assert.deepEqual(f.local[DURABLE_LAYOUT_KEY].cohorts[0],{...old,blockedBy:[next.id]});
    noActions(f);
    for(const key of Object.keys(f.session))delete f.session[key]; for(const tab of f.tabs)tab.id+=1000;
    const cold=await reload(f);assert(f.ids.every(id=>owner(cold,id+1000)==='target'));
    assert.deepEqual(cold.spaces.find(s=>s.id==='target').temporaryTabs.filter(id=>f.ids.includes(id-1000)),(inverted?[...f.ids].reverse():f.ids).map(id=>id+1000));
    for(const record of history)assert(cold.restoreQueue.some(r=>JSON.stringify(r)===JSON.stringify(record)));noActions(f);
});

for(const change of ['missing-witness','incarnation','transaction','epoch','committed-witness','checkpoint','rank','live-boundary','snapshot-proof','history','membership','order','root','root-alias','url','window','missing-tab','duplicate-id','native-order','metadata-name','metadata-pin','split','global','transient','pending-navigation','favorite','provisional','staged-choice','readback-layout','missing-placement','outgoing'])test(`incomplete or stale ${change} refuses representation repair`,async()=>{
    const f=await setup(),tab=f.tabs.find(t=>t.id===101),w=f.store.explicitToday.get(101);
    if(change==='missing-witness')f.store.explicitToday.delete(101);
    if(change==='incarnation')w.incarnation='reused-id';
    if(change==='transaction')w.transaction='new-choice';
    if(change==='epoch')delete f.session.spaceExplicitTodayEpoch;
    if(change==='committed-witness')f.local.spaceTabSnapshot.find(r=>r.tabId===101).currentOwnership.incarnation='other';
    if(change==='checkpoint')f.local[EXPLICIT_TODAY_CHECKPOINT].fingerprint='bad';
    if(change==='rank')f.local.spaceRankCheckpoint.ranks[0][1]=999;
    if(change==='live-boundary')f.local[EXPLICIT_TODAY_CHECKPOINT].liveCount--;
    if(change==='snapshot-proof')await reseal(f,[f.cohort]);
    if(change==='snapshot-proof'){f.local[DURABLE_LAYOUT_KEY]=await sealDurableLayout(3,[f.cohort],{liveCount:f.snapshot.length-1,rankFingerprint:f.local.spaceRankCheckpoint.fingerprint});f.store.durableLayout=copy(f.local[DURABLE_LAYOUT_KEY]);}
    if(change==='history')f.store.restoreQueue[0].order++;
    if(change==='membership')f.store.spaces[0].temporaryTabs.push(101);
    if(change==='order')f.store.spaces[1].temporaryTabs.reverse();
    if(change==='root')f.store.spaces[1].bookmarkFolderId='changed';
    if(change==='root-alias')f.store.spaces[0].bookmarkFolderId='target-root';
    if(change==='url')tab.url='https://reused.test/';
    if(change==='window')tab.windowId=20;
    if(change==='missing-tab')f.tabs.splice(f.tabs.indexOf(tab),1);
    if(change==='duplicate-id')f.tabs.push(copy(tab));
    if(change==='native-order'){tab.index=99;}
    if(change==='metadata-name')f.local.tabNameOverridesById[101]={name:'Name'};
    if(change==='metadata-pin')f.local.pinnedTabStatesById[101]={bookmarkId:'pin'};
    if(change==='split')tab.splitViewId=7;
    if(change==='global')f.globals.add(101);
    if(change==='transient')f.store.isTransientTab=t=>(typeof t==='object'?t.id:t)===101;
    if(change==='pending-navigation')tab.pendingUrl='https://new.test/';
    if(change==='favorite')f.store.spaces[0].spaceBookmarks.push(101);
    if(change==='provisional')f.store.provisional.add(101);
    if(change==='staged-choice')f.store.currentLayoutTransition=true;
    if(change==='readback-layout')f.store.durableLayout.cohorts[0].choiceRevision=1;
    if(change==='missing-placement')f.snapshot=f.snapshot.filter(r=>r.tabId!==101);
    if(change==='outgoing'){const other={...copy(f.cohort),id:'newer',choiceRevision:3,contextSubset:true,binding:null};await reseal(f,[{...copy(f.cohort),blockedBy:[other.id]},other]);}
    const before=copy(f.local);assert.equal(await prepare(f),null);assert.deepEqual(f.local,before);noActions(f);
});

test('incoming edges are preserved; unrelated competing cohort and competing window refuse',async()=>{
    const f=await setup();const prior={...copy(f.cohort),id:'older',choiceRevision:1,blockedBy:[f.cohort.id]};await reseal(f,[prior,f.cohort]);
    const repair=await prepare(f);assert(repair);assert.deepEqual(repair.layout.cohorts[0],prior);assert.equal(repair.layout.cohorts[1].blockedBy.length,1);
    const competitor={...copy(f.cohort),id:'unrelated',choiceRevision:3,contextSubset:true};await reseal(f,[prior,f.cohort,competitor]);assert.equal(await prepare(f),null);
    await reseal(f,[prior,f.cohort]);f.tabs.push(...f.tabs.filter(t=>f.ids.includes(t.id)).map(t=>({...copy(t),windowId:20,id:t.id+1000})));assert.equal(await prepare(f),null);noActions(f);
});

test('native index refresh first captures normally and repairs only after a stable checkpoint',async()=>{
    const f=await setup();for(const t of f.tabs)t.index+=5;for(const r of f.snapshot)r.tabIndex+=5;
    assert.equal(await prepare(f),null);await f.store.persist({skipGroupSync:true});assert.equal(f.store.durableLayout.cohorts.length,1);
    await f.store.persist({skipGroupSync:true});assert.equal(f.store.durableLayout.cohorts.length,2);
    assert.deepEqual(f.store.durableLayout.cohorts[1].signature.map(s=>s.index),f.ids.map((_,i)=>i+7));noActions(f);
});

for(const change of ['incarnation','transaction','session','browser','secondary-session','navigation','closed','window','index','split','global','metadata','membership','order','root','bookmark-root','history','checkpoint','rank','layout','staged'])test(`final async fence rejects changed ${change}`,async()=>{
    const f=await setup({browser:true}),repair=await prepare(f);assert(repair);const t=f.tabs.find(t=>t.id===101);
    if(change==='incarnation')f.store.explicitToday.get(101).incarnation='new';
    if(change==='transaction')f.store.explicitToday.get(101).transaction='new';
    if(change==='session'||change==='secondary-session')delete f.session.spaceExplicitTodayEpoch;
    if(change==='browser')f.identity.generation='changed';
    if(change==='navigation')t.url='https://changed.test/';
    if(change==='closed')f.tabs.splice(f.tabs.indexOf(t),1);
    if(change==='window')t.windowId=20;
    if(change==='index')t.index=99;
    if(change==='split')t.splitViewId=7;
    if(change==='global')f.globals.add(101);
    if(change==='metadata')f.local.tabNameOverridesById[101]={name:'Changed'};
    if(change==='membership')f.store.spaces[0].temporaryTabs.push(101);
    if(change==='order')f.store.spaces[1].temporaryTabs.reverse();
    if(change==='root')f.store.spaces[1].bookmarkFolderId='source-root';
    if(change==='bookmark-root')f.nodes.find(n=>n.id==='target-root').parentId='bar';
    if(change==='history')f.store.restoreQueue.push(copy(f.history[0]));
    if(change==='checkpoint')f.local[EXPLICIT_TODAY_CHECKPOINT].fingerprint='bad';
    if(change==='rank')f.local.spaceRankCheckpoint.fingerprint='bad';
    if(change==='layout')f.local[DURABLE_LAYOUT_KEY].cohorts[0].choiceRevision=1;
    if(change==='staged')f.store.currentLayoutTransition=true;
    await assert.rejects(repair.validate());noActions(f);
});

test('final canonical fence rereads proof after prior async fences',async()=>{
    const f=await setup();await assert.rejects(f.store.persist({skipGroupSync:true,beforeWrite:async()=>{f.local[EXPLICIT_TODAY_CHECKPOINT].fingerprint='changed';}}),/Proven context changed/);
    assert.equal(f.local[DURABLE_LAYOUT_KEY].cohorts.length,1);noActions(f);
});

for(const phase of ['before-local','after-local','before-session','after-session'])test(`interrupted ${phase} repair leaves one coherent authoritative checkpoint`,async()=>{
    const f=await setup();let fired=false;const old=copy(f.local[DURABLE_LAYOUT_KEY]);
    f.hooks[phase.startsWith('before')?'beforeSet':'afterSet']=(area,update)=>{if(!fired&&(phase.includes('local')?area==='local'&&update[DURABLE_LAYOUT_KEY]:area==='session'&&update.spaceSession)){fired=true;throw Error('interrupted');}};
    await assert.rejects(f.store.persist({skipGroupSync:true}),/interrupted/);assert.equal(f.store.initialized,false);
    assert(await readDurableLayout(f.local[DURABLE_LAYOUT_KEY]));assert.equal(f.local[DURABLE_LAYOUT_KEY].cohorts.length,phase==='before-local'?1:2);
    if(phase==='before-local')assert.deepEqual(f.local[DURABLE_LAYOUT_KEY],old);noActions(f);
});

test('complete canonical readback mismatch fails closed without session commit',async()=>{
    const f=await setup();let fired=false;f.hooks.afterSet=(area,value)=>{if(!fired&&area==='local'&&value[DURABLE_LAYOUT_KEY]){fired=true;f.local.spaceTabSnapshot[0].url='https://tampered.test/';}};
    await assert.rejects(f.store.persist({skipGroupSync:true}),/Proven context checkpoint could not be verified/);
    assert.equal(f.store.initialized,false);assert(!f.effects.some(([area])=>area==='session'));noActions(f);
});

test('secondary session revocation during final native query is not hidden by preferred browser epoch',async()=>{
    const f=await setup({browser:true}),repair=await prepare(f);assert(repair);
    f.hooks.query=()=>{delete f.session.spaceExplicitTodayEpoch;};
    await assert.rejects(repair.validate(),/Proven context changed/);noActions(f);
});

test('a prepared repair never falls through to stale generic capture when committed proof changes during root validation',async()=>{
    const f=await setup();let fired=false;
    f.hooks.bookmark=()=>{if(!fired){fired=true;f.local[EXPLICIT_TODAY_CHECKPOINT].fingerprint='newer-checkpoint';f.local.spaces[1].temporaryTabs.reverse();}};
    await assert.rejects(f.store.persist({skipGroupSync:true}),/Proven context changed/);
    assert.equal(f.local[EXPLICIT_TODAY_CHECKPOINT].fingerprint,'newer-checkpoint');
    assert.deepEqual(f.local.spaces[1].temporaryTabs,[...f.ids].reverse());
    assert.equal(f.local[DURABLE_LAYOUT_KEY].cohorts.length,1);
    assert(!f.effects.some(([area,value])=>area==='local'&&value[DURABLE_LAYOUT_KEY]));noActions(f);
});

for(const changed of ['checkpoint','metadata','bookmark','tab','window'])test(`late ${changed} event invalidates earlier async read and listeners always detach`,async()=>{
    const f=await setup({browser:true}),repair=await prepare(f);assert(repair);
    assert(f.events.every(e=>e.listeners.size===0));
    for(let i=0;i<3;i++)await repair.validate();assert(f.events.every(e=>e.listeners.size===0));
    f.hooks.get=(area,key)=>{if(area==='session'&&key==='spaceExplicitTodayEpoch'){
        if(changed==='checkpoint'){f.local[EXPLICIT_TODAY_CHECKPOINT].fingerprint='late';chrome.storage.onChanged.emit({[EXPLICIT_TODAY_CHECKPOINT]:{}},'local');}
        if(changed==='metadata'){f.local.tabNameOverridesById[101]={name:'Late'};chrome.storage.onChanged.emit({tabNameOverridesById:{}},'local');}
        if(changed==='bookmark'){f.nodes.find(n=>n.id==='target-root').parentId='bar';chrome.bookmarks.onMoved.emit('target-root',{});}
        if(changed==='tab'){f.tabs[2].url='https://late.test/';chrome.tabs.onUpdated.emit(101,{url:'https://late.test/'});}
        if(changed==='window')chrome.windows.onRemoved.emit(10);
    }};
    await assert.rejects(repair.validate(),/Proven context changed/);assert(f.events.every(e=>e.listeners.size===0));noActions(f);
});

test('unavailable validation events refuse before planning, and partial installation failure cleans up',async()=>{
    const f=await setup(),repair=await prepare(f);assert(repair);
    delete chrome.windows.onRemoved;assert.equal(await prepare(f),null);
    await assert.rejects(repair.validate(),/observation is unavailable/);assert(f.events.every(e=>e.listeners.size===0));
    installEvents(f);chrome.bookmarks.onMoved.addListener=()=>{throw Error('listener unavailable');};
    await assert.rejects(repair.validate(),/listener unavailable/);assert(f.events.every(e=>e.listeners.size===0));noActions(f);
});

test('focus and title-only native churn does not invalidate representation proof',async()=>{
    const f=await setup(),repair=await prepare(f);assert(repair);
    f.hooks.query=()=>chrome.tabs.onUpdated.emit(101,{title:'Loaded title'});
    await repair.validate();assert(f.events.every(e=>e.listeners.size===0));noActions(f);
});

test('warm worker activation repairs existing proof without another move',async()=>{
    const f=await setup();const before=copy(f.store.spaces),history=copy(f.history);
    const warm=await reload(f);assert.equal(warm.durableLayout.cohorts.length,2);
    assert.deepEqual(warm.spaces,before);assert.deepEqual(warm.restoreQueue,history);
    assert.deepEqual(warm.durableLayout.cohorts[1].binding.tabIds,f.ids);noActions(f);
});

test('repair cannot swallow another window navigation or native layout update',async()=>{
    for(const kind of ['navigation','index']){
        const f=await setup();const t={id:200,windowId:20,index:0,url:'https://other.test/',pinned:false,incognito:false,splitViewId:-1};f.tabs.push(t);
        f.store.spaces[0].temporaryTabs.push(200);f.local.spaces=copy(f.store.spaces);f.store.restoredRanks.set(200,2);
        const record={tabId:200,spaceId:'source',section:'temporaryTabs',order:2,url:t.url,tabIndex:0,windowKey:'other'};
        f.snapshot.splice(2,0,record);f.local.spaceTabSnapshot=[...copy(f.snapshot),...copy(f.history)];
        f.local.spaceRankCheckpoint=await createSpaceRankCheckpoint([...f.store.restoredRanks],f.local.spaceTabSnapshot);
        f.local[EXPLICIT_TODAY_CHECKPOINT]=await createExplicitCheckpoint(f.snapshot.length,f.local.spaceRankCheckpoint.fingerprint);
        const other={id:'other-window',signature:[{index:0,url:t.url,pinned:false}],placements:[{index:0,spaceId:'source',bookmarkFolderId:'source-root',order:2}],binding:{epoch:copy(f.cohort.binding.epoch),windowId:20,tabIds:[200]},overrides:[]};
        f.local[DURABLE_LAYOUT_KEY]=await sealDurableLayout(2,[f.cohort,other],{liveCount:f.snapshot.length,rankFingerprint:f.local.spaceRankCheckpoint.fingerprint});f.store.durableLayout=copy(f.local[DURABLE_LAYOUT_KEY]);
        assert(await prepare(f));
        if(kind==='navigation'){t.url='https://updated.test/';record.url=t.url;}else{t.index=3;record.tabIndex=3;}
        assert.equal(await prepare(f),null);await f.store.persist({skipGroupSync:true});
        const captured=f.local[DURABLE_LAYOUT_KEY].cohorts.find(c=>c.id===other.id);assert.equal(captured.signature[0].url,t.url);assert.equal(captured.signature[0].index,t.index);
        assert.equal(f.local[DURABLE_LAYOUT_KEY].cohorts.length,2);
        await f.store.persist({skipGroupSync:true});assert.equal(f.local[DURABLE_LAYOUT_KEY].cohorts.length,3);
        assert.deepEqual(f.local[DURABLE_LAYOUT_KEY].cohorts.find(c=>c.id===other.id),captured);noActions(f);
    }
});

for(const key of ['pinnedTabStatesById','tabNameOverridesById'])for(const value of [null,[], 'malformed'])test(`malformed ${key} ${JSON.stringify(value)} cannot prove metadata absence`,async()=>{
    const f=await setup();f.local[key]=value;assert.equal(await prepare(f),null);noActions(f);
});

for(const kind of ['global','transient'])test(`late effective ${kind} eligibility change in unrelated native context rejects repair`,async()=>{
    const f=await setup(),repair=await prepare(f);assert(repair);
    if(kind==='global')f.globals.add(1);else f.store.isTransientTab=t=>(typeof t==='object'?t.id:t)===1;
    await assert.rejects(repair.validate(),/Proven context changed/);noActions(f);
});

for(const count of [999,1000])test(`repair never exceeds reader cohort capacity from ${count} cohorts`,async()=>{
    const f=await setup(),cohorts=[f.cohort,...Array.from({length:count-1},(_,i)=>({id:`unrelated-${i}`,signature:[{index:0,url:`https://history.test/${i}`,pinned:false}],placements:[],binding:null,overrides:[]}))];
    await reseal(f,cohorts,2);const repair=await prepare(f);
    if(count===1000)assert.equal(repair,null);else{assert(repair);assert.equal(repair.layout.cohorts.length,1000);assert(await readDurableLayout(repair.layout));}
    assert.equal(f.local[DURABLE_LAYOUT_KEY].cohorts.length,count);noActions(f);
});

test('repair refuses revision overflow instead of sealing an unreadable checkpoint',async()=>{
    const f=await setup();await reseal(f,[f.cohort],Number.MAX_SAFE_INTEGER);
    assert.equal(await prepare(f),null);assert(await readDurableLayout(f.local[DURABLE_LAYOUT_KEY]));noActions(f);
});


for(const inverted of [false,true])test(`combined no-move repair survives repeated authenticated neighbour replay and duplicate-context restart, inverted=${inverted}`,async()=>{
    const f=await setup({inverted,browser:true}),before=copy(f.store.spaces);
    await f.store.persist({skipGroupSync:true});
    const successor=f.store.durableLayout.cohorts.find(c=>c.id!==f.cohort.id);
    assert(successor);assert.equal(successor.signature.length,7);assert.deepEqual(f.store.spaces,before);
    for(let i=0;i<2;i++){
        delete f.session.spaceSession;const replay=await reload(f);
        assert(replay.explicitToday.has(1));assert(replay.explicitToday.has(2));
        assert.equal(replay.durableLayout.cohorts.length,2);
        const next=replay.durableLayout.cohorts.find(c=>c.id===successor.id);
        assert.deepEqual(next.signature,successor.signature);assert.deepEqual(next.placements,successor.placements);
        assert.deepEqual(replay.spaces,before);await replay.persist({skipGroupSync:true});
    }
    duplicateExtension(f);for(const key of Object.keys(f.session))delete f.session[key];
    for(const tab of f.tabs)tab.id+=1000;f.identity=null;
    const cold=await reload(f);
    assert(f.ids.every(id=>owner(cold,id+1000)==='target'&&cold.explicitToday.has(id+1000)));
    assert.deepEqual(cold.spaces.find(s=>s.id==='target').temporaryTabs.filter(id=>f.ids.includes(id-1000)),(inverted?[...f.ids].reverse():f.ids).map(id=>id+1000));
    for(const record of f.history)assert(cold.restoreQueue.some(r=>JSON.stringify(r)===JSON.stringify(record)));noActions(f);
});

// Regression: contextSubset means mapped relative to a larger native window;
// it does not guarantee that every retained signature slot is a placement.
for(const inverted of [false,true])test(`already-mapped subset with unplaced context is narrowed before cold restart, inverted=${inverted}`,async()=>{
    const f=await setup({inverted,contextSubset:true});
    // Both context slots share a URL, exactly the kind of irrelevant native
    // ambiguity retained by the user's newest checkpoint. Keep them unplaced.
    f.tabs[1].url=f.tabs[0].url;f.snapshot.find(r=>r.tabId===2).url=f.tabs[0].url;
    f.cohort.signature[1].url=f.tabs[0].url;
    f.local.spaceTabSnapshot=[...copy(f.snapshot),...copy(f.history)];
    f.local.spaceRankCheckpoint=await createSpaceRankCheckpoint([...f.store.restoredRanks],f.local.spaceTabSnapshot);
    f.local[EXPLICIT_TODAY_CHECKPOINT]=await createExplicitCheckpoint(f.snapshot.length,f.local.spaceRankCheckpoint.fingerprint);
    f.local[DURABLE_LAYOUT_KEY]=await sealDurableLayout(2,[f.cohort],{liveCount:f.snapshot.length,rankFingerprint:f.local.spaceRankCheckpoint.fingerprint});
    f.store.durableLayout=copy(f.local[DURABLE_LAYOUT_KEY]);
    const before=copy(f.store.spaces),old=copy(f.cohort),history=copy(f.history);
    await f.store.persist({skipGroupSync:true});
    const next=f.local[DURABLE_LAYOUT_KEY].cohorts.find(c=>c.id!==old.id);
    assert(next,'mapped subsets with unplaced context still need a proven representation repair');
    assert.deepEqual(next.binding.tabIds,f.ids);assert.equal(next.signature.length,7);
    assert.deepEqual(f.store.spaces,before);assert.deepEqual(f.local[DURABLE_LAYOUT_KEY].cohorts[0],{...old,blockedBy:[next.id]});
    // On the next full epoch one irrelevant duplicate disappears and the other
    // moves; all seven intended placements remain. No current-incarnation proof
    // survives, so only the narrowed saved successor can restore them.
    f.tabs.splice(f.tabs.findIndex(t=>t.id===2),1);
    f.tabs.find(t=>t.id===1).index=30;
    for(const key of Object.keys(f.session))delete f.session[key];for(const t of f.tabs)t.id+=1000;
    const cold=await reload(f);
    assert.deepEqual(cold.spaces.find(s=>s.id==='target').temporaryTabs.filter(id=>f.ids.includes(id-1000)),
        (inverted?[...f.ids].reverse():f.ids).map(id=>id+1000));
    for(const record of history)assert(cold.restoreQueue.some(r=>JSON.stringify(r)===JSON.stringify(record)));noActions(f);
});

for(const fault of ['no-epoch','no-witness','wrong-space','outgoing','override','missing-placement','duplicate-choice','other-window'])
test(`mapped unplaced-context repair still refuses ${fault}`,async()=>{
    const f=await setup({contextSubset:true});
    if(fault==='no-epoch')delete f.session.spaceExplicitTodayEpoch;
    if(fault==='no-witness')f.store.explicitToday.clear();
    if(fault==='wrong-space')f.store.explicitToday.get(101).spaceId='source';
    if(fault==='outgoing')await reseal(f,[{...f.cohort,blockedBy:['newer']},{...copy(f.cohort),id:'newer',choiceRevision:3,binding:null}]);
    if(fault==='override')await reseal(f,[{...f.cohort,overrides:[{tabId:999,incarnation:'unknown',epoch:copy(f.cohort.binding.epoch)}]}]);
    if(fault==='missing-placement')f.tabs.splice(f.tabs.findIndex(t=>t.id===101),1);
    if(fault==='duplicate-choice')f.tabs.push({...copy(f.tabs.find(t=>t.id===101)),id:999,index:1});
    if(fault==='other-window')f.tabs.push(...f.tabs.filter(t=>f.ids.includes(t.id)).map(t=>({...copy(t),id:t.id+1000,windowId:20})));
    const before=copy(f.local);assert.equal(await prepare(f),null);assert.deepEqual(f.local,before);noActions(f);
});

test('mapped context repair never repairs an outgoing predecessor but can narrow its proven latest leaf',async()=>{
    const f=await setup({contextSubset:true}),older={...copy(f.cohort),id:'older',choiceRevision:1,blockedBy:[f.cohort.id]};
    await reseal(f,[older,f.cohort]);const plan=await prepare(f);assert(plan);
    assert.deepEqual(plan.layout.cohorts[0],older);assert.equal(plan.layout.cohorts.length,3);
    assert.deepEqual(plan.layout.cohorts[2].binding.tabIds,f.ids);noActions(f);
});
