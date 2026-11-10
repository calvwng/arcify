import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './today-recovery-fixture.js';
import {createSpaceRankCheckpoint} from '../../space-continuity.js';
import {stageExplicitToday} from '../../explicit-today-ownership.js';
import {diagnoseDurableLayout,validateLayoutDiagnostic} from '../../durable-layout-diagnostics.js';
import {SpaceStore} from '../../space-store.js';
import {DURABLE_LAYOUT_KEY,sealDurableLayout,readDurableLayout,observeDurableIndividualClose,stageDurableExhaustion,
 initializeDurableLayout,captureDurableLayout,layoutCandidate,layoutWindows,layoutEvidence,createLayoutRestoreGuards,pendingLayoutWindowIds,invalidateDurableCloseEvidence,durableRestartQueue} from '../../durable-today-layout.js';
const copy=structuredClone;
async function setup(){
 const f=fixture(); f.events=[];const event=()=>{const listeners=new Set();const e={listeners,addListener:f=>listeners.add(f),removeListener:f=>listeners.delete(f),emit:(...args)=>{for(const f of listeners)f(...args);}};f.events.push(e);return e;};f.event=event;chrome.storage.onChanged=event();for(const key of ['onCreated','onRemoved','onReplaced','onUpdated','onAttached','onDetached'])chrome.tabs[key]=event();chrome.windows.onRemoved=event(); for(const tab of f.tabs)tab.url=`https://synthetic.test/${tab.id}`;
 const tab=f.tabs.find(t=>t.id===9),stage=await stageExplicitToday(f.store,[tab],{spaceId:'source',bookmarkFolderId:'source-root'});
 f.store.explicitToday=stage.bindings;f.store.explicitTodayEpoch=stage.epoch;f.store.explicitTodayEpochs=stage.epochs;
 const c={id:'chosen',contextSubset:true,explicitOnly:true,choiceRevision:1,signature:[{index:tab.index,url:tab.url,pinned:false}],placements:[{index:tab.index,spaceId:'source',bookmarkFolderId:'source-root',order:3}],binding:{epoch:stage.epoch,windowId:20,tabIds:[9]},overrides:[]};
 f.local[DURABLE_LAYOUT_KEY]=await sealDurableLayout(1,[c]);f.store.durableLayout=copy(f.local[DURABLE_LAYOUT_KEY]);f.store.layoutCommittedBaseline=copy(f.local[DURABLE_LAYOUT_KEY]);f.store.layoutPending=new Set();f.store.layoutProvisional=new Set();f.local.spaceTabSnapshot=[{tabId:9,tabIndex:tab.index,url:tab.url,spaceId:'source',section:'temporaryTabs',currentOwnership:copy(stage.bindings.get(9))}];f.store.layoutCommittedSnapshot=copy(f.local.spaceTabSnapshot);f.c=c;f.effects.length=0;
 return f;
}
function close(f,info={windowId:20,isWindowClosing:false}){
 observeDurableIndividualClose(f.store,9,info);f.tabs.splice(f.tabs.findIndex(t=>t.id===9),1);
 f.store.spaces[0].temporaryTabs=f.store.spaces[0].temporaryTabs.filter(id=>id!==9);f.store.explicitToday.delete(9);
 (f.store.layoutRemovedIds ||= new Set()).add(9);
}
test('final observed close preserves cohort and seals valid terminal intent without native actions',async()=>{
 const f=await setup();close(f);await f.store.persist({skipGroupSync:true});const layout=f.local[DURABLE_LAYOUT_KEY];
 assert.equal(layout.version,4);assert.equal(layout.retirements.length,1);assert.deepEqual(layout.cohorts.find(c=>c.id==='chosen'),f.c);assert(await readDurableLayout(layout));
 assert(!f.effects.some(([area])=>['move','group','groupMove'].includes(area)));
 const before=copy(layout.retirements);await f.store.persist({skipGroupSync:true});assert.deepEqual(f.local[DURABLE_LAYOUT_KEY].retirements,before);
});
for(const info of [{windowId:20,isWindowClosing:true},{windowId:20},{windowId:99,isWindowClosing:false}])test(`no retirement for ${JSON.stringify(info)}`,async()=>{
 const f=await setup();close(f,info);await stageDurableExhaustion(f.store,f.tabs);assert.equal(f.store.durableLayout.version,3);
});
test('missing evidence avoids empty reconciliation without claiming durable close correctness',async()=>{
 const f=await setup();close(f,{windowId:20,isWindowClosing:true});await initializeDurableLayout(f.store,f.local,f.tabs);
 assert.deepEqual(f.store.durableLayout.cohorts[0],f.c);assert(await readDurableLayout(await captureDurableLayout(f.store,f.tabs,[],null)));
});
for(const change of ['epoch','reappeared','committed'])test(`retirement final fence rejects changed ${change}`,async()=>{
 const f=await setup();close(f);await stageDurableExhaustion(f.store,f.tabs);assert.equal(f.store.durableLayout.version,4);
 if(change==='epoch')delete f.session.spaceExplicitTodayEpoch;
 if(change==='reappeared')f.tabs.push({id:9,index:99,windowId:30,url:'https://other.test/',pinned:false});
 if(change==='committed')f.local[DURABLE_LAYOUT_KEY].revision++;
 await assert.rejects(f.store.layoutRetirementFence,/Observed close evidence changed/);
});
test('terminal URL defers legacy candidate and projection despite unrelated current window cohort',async()=>{
 const f=await setup();close(f);await stageDurableExhaustion(f.store,f.tabs);
 const tab={id:1009,index:0,windowId:30,url:f.c.signature[0].url,pinned:false};f.tabs.push(tab);
 f.store.durableLayout.cohorts.push({...copy(f.c),id:'other',contextSubset:undefined,explicitOnly:undefined,choiceRevision:undefined,binding:{...copy(f.c.binding),windowId:30,tabIds:[55]}});
 assert.equal(layoutCandidate(f.store,tab),true);assert(pendingLayoutWindowIds(f.store,f.tabs).has(30));
 const live=layoutWindows(f.store,f.tabs),evidence=layoutEvidence(f.store.durableLayout.cohorts,live,f.store.durableLayout.retirements);
 const guards=createLayoutRestoreGuards(f.store,evidence,null),other=f.store.durableLayout.cohorts[1];
 assert.equal(guards.placeable(other,live.find(w=>w.id===30)),false);
});
test('terminal successor remains an ancestor blocker',async()=>{
 const f=await setup();close(f);await stageDurableExhaustion(f.store,f.tabs);
 const ancestor={...copy(f.c),id:'ancestor',choiceRevision:0,blockedBy:['chosen']};
 const guards=createLayoutRestoreGuards(f.store,[],f.c.binding.epoch);
 assert.equal(guards.precedenceAllows(ancestor,{id:20,tabs:[]}),false);
});
test('tampered terminal evidence fails full ledger validation',async()=>{
 const f=await setup();close(f);await stageDurableExhaustion(f.store,f.tabs);const l=f.store.durableLayout;
 for(const mutate of [r=>r.cohortFingerprint='x',r=>r.closed[0].tabId=111,r=>r.revision=0,r=>r.closed=[],r=>r.reason='missing']){
  const records=copy(l.retirements);mutate(records[0]);assert.equal(await readDurableLayout(await sealDurableLayout(l.revision,l.cohorts,l.snapshotProof,records)),null);
 }
});
test('unsupported future ledger refuses before recovery writes',async()=>{
 const f=await setup();f.local[DURABLE_LAYOUT_KEY].version=99;f.effects.length=0;
 const store=new SpaceStore();await assert.rejects(store.initialize(),/compatible build/);assert.deepEqual(f.effects,[]);
});
for(const fault of ['incarnation','transaction','snapshot','epoch','absent-witness'])test(`event proof refuses ${fault}`,async()=>{
 const f=await setup();
 if(fault==='incarnation')f.store.explicitToday.get(9).incarnation='reused-native-id';
 if(fault==='transaction')f.store.explicitToday.get(9).transaction='different-intent';
 if(fault==='snapshot')f.store.layoutCommittedSnapshot[0].url='https://different.test/';
 if(fault==='epoch')f.store.explicitTodayEpochs=[];
 if(fault==='absent-witness')f.store.explicitToday.delete(9);
 close(f);await stageDurableExhaustion(f.store,f.tabs);assert.equal(f.store.durableLayout.version,3);
});
test('fresh exact explicit ownership can release terminal refusal without erasing history',async()=>{
 const f=await setup();close(f);await stageDurableExhaustion(f.store,f.tabs);
 const tab={id:1009,index:0,windowId:30,url:f.c.signature[0].url,pinned:false};f.tabs.push(tab);f.store.spaces[0].temporaryTabs.push(tab.id);
 assert(layoutCandidate(f.store,tab));const stage=await stageExplicitToday(f.store,[tab],{spaceId:'source',bookmarkFolderId:'source-root'});
 f.store.explicitToday=stage.bindings;f.store.explicitTodayEpoch=stage.epoch;f.store.explicitTodayEpochs=stage.epochs;
 assert.equal(layoutCandidate(f.store,tab),false);assert.deepEqual(f.store.durableLayout.cohorts[0],f.c);
});
test('late retirement fence is not overwritten by other capture fences',async()=>{
 const f=await setup();close(f);await stageDurableExhaustion(f.store,f.tabs);
 const fence=f.store.layoutRetirementFence;f.store.layoutWriteFence=async()=>{};
 await captureDurableLayout(f.store,f.tabs,[],null);assert.equal(f.store.layoutRetirementFence,fence);
 f.local[DURABLE_LAYOUT_KEY].revision++;await assert.rejects(f.store.persist({skipGroupSync:true}),/Observed close evidence changed/);
});
for(const phase of ['before-local','after-local'])test(`retirement ${phase} write failure retains readable committed baseline and does not retry`,async()=>{
 const f=await setup();close(f);let count=0;
 f.hooks[phase==='before-local'?'beforeSet':'afterSet']=(area,update)=>{if(area==='local'&&update[DURABLE_LAYOUT_KEY]){count++;throw Error('injected-write-failure');}};
 await assert.rejects(f.store.persist({skipGroupSync:true}),/injected-write-failure/);assert.equal(count,1);assert(await readDurableLayout(f.local[DURABLE_LAYOUT_KEY]));
 assert.equal(f.local[DURABLE_LAYOUT_KEY].version,phase==='before-local'?3:4);assert.equal(f.store.initialized,false);
});
test('full canonical readback mismatch rejects without a session commit',async()=>{
 const f=await setup();close(f);f.hooks.afterSet=(area,update)=>{if(area==='local'&&update[DURABLE_LAYOUT_KEY])f.local.spaces[0].name='tampered';};
 await assert.rejects(f.store.persist({skipGroupSync:true}),/checkpoint could not be verified/);
 assert(!f.effects.some(([area])=>area==='session'));assert(await readDurableLayout(f.local[DURABLE_LAYOUT_KEY]));
});
test('cold new-epoch same-URL tab stays quarantined without historical reassignment',async()=>{
 const f=await setup();close(f);await f.store.persist({skipGroupSync:true});
 for(const key of Object.keys(f.session))delete f.session[key];for(const tab of f.tabs)tab.id+=1000;
 f.tabs.push({id:1009,index:99,windowId:30,url:f.c.signature[0].url,pinned:false,splitViewId:-1});
 const s=new SpaceStore();s.discoverBookmarkSpaces=async()=>false;await s.initialize();
 assert(s.layoutProvisional.has(1009));assert.equal(s.explicitToday.has(1009),false);assert.deepEqual(s.durableLayout.cohorts.find(c=>c.id==='chosen'),f.c);
});
for(const kind of ['native','storage'])test(`late ${kind} event invalidates earlier fence reads and removes listeners`,async()=>{
 const f=await setup();close(f);await stageDurableExhaustion(f.store,f.tabs);
 f.hooks.get=(area,key)=>{if(area==='session'&&key==='spaceExplicitTodayEpoch'){
  if(kind==='native'){f.tabs.push({id:9,index:99,windowId:30,url:'https://late.test/',pinned:false});chrome.tabs.onCreated.emit(f.tabs.at(-1));}
  else {f.local[DURABLE_LAYOUT_KEY].revision++;chrome.storage.onChanged.emit({[DURABLE_LAYOUT_KEY]:{}},'local');}
 }};
 await assert.rejects(f.store.layoutRetirementFence,/Observed close evidence changed/);assert(f.events.every(e=>e.listeners.size===0));
});
test('unavailable validation observation defers terminal transition',async()=>{
 const f=await setup();close(f);delete chrome.tabs.onReplaced;await stageDurableExhaustion(f.store,f.tabs);assert.equal(f.store.durableLayout.version,3);
});
test('scope characterization: prior partial close leaves its URL outside final-cohort terminal evidence',async()=>{
 const f=await setup(),tab=f.tabs.find(t=>t.id===10);
 f.store.spaces[1].temporaryTabs=f.store.spaces[1].temporaryTabs.filter(id=>id!==10);f.store.spaces[0].temporaryTabs.push(10);
 const stage=await stageExplicitToday(f.store,[tab],{spaceId:'source',bookmarkFolderId:'source-root'});
 f.store.explicitToday=stage.bindings;f.store.explicitTodayEpochs=stage.epochs;
 f.c.signature.push({index:tab.index,url:tab.url,pinned:false});f.c.binding.tabIds.push(10);f.c.placements.push({index:tab.index,spaceId:'source',bookmarkFolderId:'source-root',order:4});
 f.local[DURABLE_LAYOUT_KEY]=await sealDurableLayout(1,[f.c]);f.store.durableLayout=copy(f.local[DURABLE_LAYOUT_KEY]);f.store.layoutCommittedBaseline=copy(f.local[DURABLE_LAYOUT_KEY]);
 f.local.spaceTabSnapshot.push({tabId:10,tabIndex:tab.index,url:tab.url,spaceId:'source',section:'temporaryTabs',currentOwnership:copy(stage.bindings.get(10))});f.store.layoutCommittedSnapshot=copy(f.local.spaceTabSnapshot);
 close(f);await f.store.persist({skipGroupSync:true});assert.equal(f.local[DURABLE_LAYOUT_KEY].version,3);
 assert.deepEqual(f.local[DURABLE_LAYOUT_KEY].cohorts.find(c=>c.id==='chosen').binding.tabIds,[10]);
 observeDurableIndividualClose(f.store,10,{windowId:20,isWindowClosing:false});f.tabs.splice(f.tabs.findIndex(t=>t.id===10),1);f.store.spaces[0].temporaryTabs=f.store.spaces[0].temporaryTabs.filter(id=>id!==10);f.store.explicitToday.delete(10);f.store.layoutRemovedIds.add(10);
 await f.store.persist({skipGroupSync:true});assert.equal(f.local[DURABLE_LAYOUT_KEY].version,4);
 const terminal=f.local[DURABLE_LAYOUT_KEY].cohorts.find(c=>c.id==='chosen');assert.deepEqual(terminal.signature.map(t=>t.url),['https://synthetic.test/10']);
 // Deliberately documents the bound, not a safety guarantee for earlier URLs.
 assert.equal(terminal.signature.some(t=>t.url==='https://synthetic.test/9'),false);
});
for(const lifecycle of ['created','replaced-added','replaced-removed','updated','attached','detached','moved','window-close'])test(`intervening ${lifecycle} invalidates obsolete observed-close evidence`,async()=>{
 const f=await setup();close(f);assert(f.store.layoutCloseEvidence.size>0);
 // Exercise the actual synchronous listeners, suppressing their queued adoption.
 for(const key of ['onMoved','onActivated'])chrome.tabs[key]=f.event();
 for(const key of ['onRemoved','onUpdated'])chrome.tabGroups[key]=f.event();
 f.store.run=()=>Promise.resolve();f.store.install();
 const tab={id:9,windowId:20,index:99,url:'https://new-incarnation.test/',pinned:false};
 if(lifecycle==='created')chrome.tabs.onCreated.emit(tab);
 if(lifecycle==='replaced-added')chrome.tabs.onReplaced.emit(9,88);
 if(lifecycle==='replaced-removed')chrome.tabs.onReplaced.emit(88,9);
 if(lifecycle==='updated')chrome.tabs.onUpdated.emit(9,{url:tab.url},tab);
 if(lifecycle==='attached')chrome.tabs.onAttached.emit(9,{newWindowId:20});
 if(lifecycle==='detached')chrome.tabs.onDetached.emit(9,{oldWindowId:20});
 if(lifecycle==='moved')chrome.tabs.onMoved.emit(9,{windowId:20});
 if(lifecycle==='window-close')chrome.tabs.onRemoved.emit(9,{windowId:20,isWindowClosing:true});
 await stageDurableExhaustion(f.store,f.tabs);
 assert.equal(f.store.durableLayout.version,3);assert.equal(f.store.layoutRemovedIds.has(9),false);
});
test('compatible fallback preserves valid final-cohort terminal intent without restoration',async()=>{
 const f=await setup();f.store.automaticLayoutRestore=false;close(f);await f.store.persist({skipGroupSync:true});
 assert.equal(f.local[DURABLE_LAYOUT_KEY].version,4);assert(await readDurableLayout(f.local[DURABLE_LAYOUT_KEY]));
});
test('v4 diagnostic conservatively refuses sibling-ready counts without leaking terminal proof',async()=>{
 const f=await setup();close(f);await stageDurableExhaustion(f.store,f.tabs);const ledger=f.store.durableLayout;
 const snapshot={stable:true,scope:'live-store',local:{[DURABLE_LAYOUT_KEY]:ledger},memory:{durableLayout:ledger},tabs:f.tabs,groupSyncEnabled:false};
 const before=copy(snapshot),report=await diagnoseDurableLayout(snapshot);assert.equal(report.status,'incomplete');assert.equal(report.counts,null);assert.deepEqual(snapshot,before);assert.deepEqual(validateLayoutDiagnostic(report),report);
 const json=JSON.stringify(report);for(const secret of ['synthetic.test','chosen','source-root',...ledger.retirements[0].closed.map(x=>x.witness.incarnation)])assert(!json.includes(secret));
});
test('retired historical cohort retains negative live-prefix suppression while preserving queue history',async()=>{
 const f=await setup(),record=copy(f.local.spaceTabSnapshot[0]);close(f);await stageDurableExhaustion(f.store,f.tabs);
 const history={...copy(record),tabId:999,windowKey:'unresolved-history'},records=[record,history];
 const rank=await createSpaceRankCheckpoint([[9,0]],records),layout=f.store.durableLayout;
 const sealed=await sealDurableLayout(layout.revision,layout.cohorts,{liveCount:1,rankFingerprint:rank.fingerprint},layout.retirements);
 assert.deepEqual(await durableRestartQueue({[DURABLE_LAYOUT_KEY]:sealed,spaceTabSnapshot:records,spaceRankCheckpoint:rank}),[history]);
});
test('final close retires even when no eligible tab remains in its window',async()=>{
 const f=await setup();f.tabs.splice(f.tabs.findIndex(t=>t.id===10),1);close(f);await stageDurableExhaustion(f.store,f.tabs);
 assert.equal(f.store.durableLayout.version,4);assert(await readDurableLayout(f.store.durableLayout));
});
test('two concurrent observed closes preserve the complete final committed cohort',async()=>{
 const f=await setup(),tab=f.tabs.find(t=>t.id===10);
 f.store.spaces[1].temporaryTabs=f.store.spaces[1].temporaryTabs.filter(id=>id!==10);f.store.spaces[0].temporaryTabs.push(10);
 const stage=await stageExplicitToday(f.store,[tab],{spaceId:'source',bookmarkFolderId:'source-root'});f.store.explicitToday=stage.bindings;f.store.explicitTodayEpochs=stage.epochs;
 f.c.signature.push({index:tab.index,url:tab.url,pinned:false});f.c.binding.tabIds.push(10);f.c.placements.push({index:tab.index,spaceId:'source',bookmarkFolderId:'source-root',order:4});
 f.local[DURABLE_LAYOUT_KEY]=await sealDurableLayout(1,[f.c]);f.store.durableLayout=copy(f.local[DURABLE_LAYOUT_KEY]);f.store.layoutCommittedBaseline=copy(f.local[DURABLE_LAYOUT_KEY]);
 f.local.spaceTabSnapshot.push({tabId:10,tabIndex:tab.index,url:tab.url,spaceId:'source',section:'temporaryTabs',currentOwnership:copy(stage.bindings.get(10))});f.store.layoutCommittedSnapshot=copy(f.local.spaceTabSnapshot);
 close(f);observeDurableIndividualClose(f.store,10,{windowId:20,isWindowClosing:false});f.tabs.splice(f.tabs.findIndex(t=>t.id===10),1);f.store.explicitToday.delete(10);f.store.spaces[0].temporaryTabs=f.store.spaces[0].temporaryTabs.filter(id=>id!==10);
 await stageDurableExhaustion(f.store,f.tabs);assert.equal(f.store.durableLayout.retirements[0].closed.length,2);assert.deepEqual(f.store.durableLayout.cohorts[0],f.c);await f.store.layoutRetirementFence();
});
