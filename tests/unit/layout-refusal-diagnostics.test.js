import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './today-recovery-fixture.js';
import { restoreDurableLayout } from '../../durable-today-layout.js';
import { diagnoseDurableLayout, LAYOUT_GUARD_COUNT_KEYS } from '../../durable-layout-diagnostics.js';
import { createRecoveryObserver } from '../../recovery-observation.js';
import { encodeFavoriteContinuityState as encode } from '../../favorite-continuity.js';
const clone=value=>structuredClone(value);
const event=()=>{const listeners=new Set();return {addListener:f=>listeners.add(f),removeListener:f=>listeners.delete(f),fire:()=>{for(const f of listeners)f();}};};
async function seal(f){
 const layout=f.store.durableLayout;
 layout.fingerprint=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(encode({revision:layout.revision,cohorts:layout.cohorts,snapshotProof:layout.snapshotProof})))).toString('hex');
 f.local.spaceDurableTodayLayout=clone(layout);f.local.spaces=clone(f.store.spaces);
}
async function setup(){
 const f=fixture();f.tabs.splice(1);Object.assign(f.tabs[0],{url:'https://private-guard.test/page',incognito:false,index:0});
 f.store.spaces[0].temporaryTabs=[1];f.store.spaces[0].spaceBookmarks=[];f.store.spaces[1].temporaryTabs=[];
 f.store.explicitToday=new Map();f.store.explicitTodayEpoch=null;f.store.explicitTodayEpochs=[];
 f.store.isTransientTab=()=>false;f.store.layoutPending=new Set(['private-cohort']);f.store.layoutRestored=new Set();
 f.store.durableLayout={version:3,revision:2,snapshotProof:null,cohorts:[{id:'private-cohort',signature:[{index:0,url:f.tabs[0].url,pinned:false}],
  placements:[{index:0,spaceId:'target',bookmarkFolderId:'target-root',order:0}],binding:null,overrides:[]}]};
 f.store.liveTabs=new Map(f.tabs.map(t=>[t.id,t]));f.store.restoreQueue=[];
 chrome.windows.getAll=async()=>[{id:10,type:'normal',incognito:false}];
 for(const key of ['onMoved','onRemoved','onChanged','onCreated'])chrome.bookmarks[key]=event();
 await seal(f);return f;
}
async function report(f){
 const before=encode({local:f.local,session:f.session,spaces:f.store.spaces,layout:f.store.durableLayout,explicit:[...f.store.explicitToday]}),effects=f.effects.length;
 const observer=createRecoveryObserver(f.store,chrome,{layoutDetails:true});
 const observation=await observer.capture();observer.dispose();
 const result=await diagnoseDurableLayout(observation);
 assert.equal(encode({local:f.local,session:f.session,spaces:f.store.spaces,layout:f.store.durableLayout,explicit:[...f.store.explicitToday]}),before);
 assert.equal(f.effects.length,effects,'diagnostic writes nothing');
 assert.doesNotMatch(JSON.stringify(result),/private-|https|tabId|windowId|spaceId|bookmarkFolderId|fingerprint|incarnation|epoch/);
 return result;
}
for(const [name,key,change,outcome] of [
 ['pass','readyPassingObservedGuards',()=>{},'restore'],
 ['disabled','readyBlockedByAutomaticRestore',f=>{f.store.automaticLayoutRestore=false;},'pending'],
 ['unproven override','readyBlockedByUnprovenOverrides',f=>{f.store.durableLayout.cohorts[0].overrides=[{tabId:1,incarnation:'old-incarnation',epoch:{kind:'session',epoch:'old-epoch'}}];},'pending'],
 ['missing Space','readyBlockedBySpaceRoot',f=>{f.store.spaces[1].id='changed';},'pending'],
 ['duplicate root','readyBlockedBySpaceRoot',f=>{f.store.spaces.push({...clone(f.store.spaces[1]),id:'duplicate'});},'pending'],
 ['missing bookmark root','readyBlockedByBookmarkRoot',f=>{f.nodes.splice(f.nodes.findIndex(n=>n.id==='target-root'),1);},'reject'],
 ['wrong bookmark parent','readyBlockedByBookmarkRoot',f=>{f.nodes.find(n=>n.id==='target-root').parentId='elsewhere';},'reject'],
 ['saved pin metadata','readyBlockedBySavedPin',f=>{f.local.pinnedTabStatesById[1]={bookmarkId:'private-pin'};},'pending'],
 ['Space bookmark','readyBlockedBySavedPin',f=>{f.store.spaces[0].spaceBookmarks=[1];},'pending'],
 ['native split','readyBlockedByNativeSplit',f=>{f.tabs[0].splitViewId=7;},'pending'],
 ['zero placements retains production semantics','readyPassingObservedGuards',f=>{f.store.durableLayout.cohorts[0].placements=[];},'restore']
])test('observed guard matches production: '+name,async()=>{
 const f=await setup();change(f);await seal(f);const diagnostic=await report(f);
 assert.equal(diagnostic.status,'stable');assert.equal(diagnostic.counts.completeUniqueCandidates,1);
 assert.equal(diagnostic.counts[key],1);
 if(outcome==='reject')await assert.rejects(restoreDurableLayout(f.store,f.tabs));else await restoreDurableLayout(f.store,f.tabs);
 assert.equal(f.store.layoutPending.has('private-cohort'),outcome!=='restore');
});

test('newer choices and override refusal explain complete but unapplied historical layouts',async()=>{
 const f=await setup(),old=f.store.durableLayout.cohorts[0];
 old.blockedBy=['newer'];f.store.durableLayout.cohorts.push({...clone(old),id:'newer',blockedBy:[],explicitOnly:true,choiceRevision:2,
  overrides:[{tabId:1,incarnation:'old-incarnation',epoch:{kind:'session',epoch:'old-epoch'}}]});f.store.layoutPending.add('newer');
 await seal(f);const diagnostic=await report(f);
 assert.equal(diagnostic.counts.completeUniqueCandidates,2);assert.equal(diagnostic.counts.readyBlockedByNewerChoices,1);
 assert.equal(diagnostic.counts.readyBlockedByUnprovenOverrides,1);assert.equal(diagnostic.counts.readyPassingObservedGuards,0);
 await restoreDurableLayout(f.store,f.tabs);assert.equal(f.store.layoutPending.size,2);
});

test('guard counts overlap rather than stopping after the first refusal',async()=>{
 const f=await setup();f.store.automaticLayoutRestore=false;f.tabs[0].splitViewId=3;f.local.pinnedTabStatesById[1]={bookmarkId:'pin'};
 const diagnostic=await report(f);assert.equal(diagnostic.counts.readyBlockedByAutomaticRestore,1);
 assert.equal(diagnostic.counts.readyBlockedByNativeSplit,1);assert.equal(diagnostic.counts.readyBlockedBySavedPin,1);
 assert.equal(diagnostic.counts.readyPassingObservedGuards,0);
});

test('effective ownership excludes recovered Favorite slots while dormant or undoing entries remain ordinary',async()=>{
 for(const mode of ['active','dormant','undoing']){
  const f=await setup();f.tabs.push({...f.tabs[0],id:2,index:1,url:'https://private-favorite.test/'});
  f.store.favoriteStore={initialized:true,state:{bindings:[],attempts:[]},recovery:{active:mode!=='dormant',entries:[{tabId:2,windowId:10,...(mode==='undoing'?{phase:'undoing'}:{})}]}};
  f.store.isGlobalTab=value=>(typeof value==='object'?value.id:value)===2&&mode==='active';
  const diagnostic=await report(f);assert.equal(diagnostic.counts.observedEligibleSlots,mode==='active'?1:2);
  assert.equal(diagnostic.counts.excludedGlobalSlots,mode==='active'?1:0);assert.equal(diagnostic.counts.readyPassingObservedGuards,1);
 }
});

test('admitted transient slots use effective production eligibility rather than historical quarantine',async()=>{
 const f=await setup();f.store.transientWindows={isKnownExcluded:()=>true,observationState:()=>({})};
 assert.equal((await report(f)).counts.observedEligibleSlots,1);
 f.store.isTransientTab=()=>true;assert.equal((await report(f)).counts.observedEligibleSlots,0);
});

test('bookmark event capability gaps do not claim stable layout checks',async()=>{
 const f=await setup();delete chrome.bookmarks.onMoved;const diagnostic=await report(f);
 assert.equal(diagnostic.status,'incomplete');assert.equal(diagnostic.counts,null);
});

test('new observations never create an epoch or run native/write helpers',async()=>{
 const f=await setup(),forbidden=()=>assert.fail('read-only report must not write or initialize');
 for(const method of ['initialize','run','persist','track','queryTabs'])f.store[method]=forbidden;
 for(const method of ['create','remove','move','update','group','ungroup'])chrome.tabs[method]=forbidden;
 chrome.storage.local.set=chrome.storage.session.set=forbidden;
 const diagnostic=await report(f);assert.equal(diagnostic.status,'stable');assert.equal(f.session.spaceExplicitTodayEpoch,undefined);
});

test('competing normal and popup windows match production ambiguity',async()=>{
 const f=await setup();f.tabs.push({...f.tabs[0],id:2,windowId:20});
 chrome.windows.getAll=async()=>[{id:10,type:'normal',incognito:false},{id:20,type:'popup',incognito:false}];
 const diagnostic=await report(f);assert.equal(diagnostic.counts.observedEligibleWindows,2);
 assert.equal(diagnostic.counts.ambiguousCandidates,1);assert.equal(diagnostic.counts.readyPassingObservedGuards,0);
 await restoreDurableLayout(f.store,f.tabs);assert.equal(f.store.layoutPending.size,1);
});

test('popup-only unique match reports the later production window refusal',async()=>{
 const f=await setup();chrome.windows.getAll=async()=>[{id:10,type:'popup',incognito:false}];f.hooks.windowAttrs={type:'popup'};
 const diagnostic=await report(f);assert.equal(diagnostic.counts.completeUniqueCandidates,1);
 assert.equal(diagnostic.counts.readyBlockedByWindow,1);assert.equal(diagnostic.counts.readyPassingObservedGuards,0);
 await restoreDurableLayout(f.store,f.tabs);assert.equal(f.store.layoutPending.size,1);
});

for(const kind of ['bookmark-event','bookmark-read','epoch-read','effective-owner'])test('guard observation rejects racing '+kind,async()=>{
 const f=await setup();let calls=0;
 if(kind==='bookmark-event')f.hooks.bookmark=()=>{if(++calls===1)chrome.bookmarks.onMoved.fire();};
 if(kind==='bookmark-read')f.hooks.bookmark=id=>{if(++calls===3)f.nodes.find(n=>n.id===id).parentId='changed';};
 if(kind==='epoch-read')f.store.favoriteStore={ownershipPersistence:{browserIdentity:async()=>({epoch:'private-'+(++calls===1?'first':'second'),generation:'private-generation'})}};
 if(kind==='effective-owner')f.store.isGlobalTab=()=>++calls>2;
 const diagnostic=await report(f);assert.equal(diagnostic.status,'changing');assert.equal(diagnostic.counts,null);
});

for(const kind of ['memberships','overrides','guard-work'])test('guard work refuses oversized '+kind,async()=>{
 const f=await setup(),c=f.store.durableLayout.cohorts[0];
 if(kind==='memberships')f.store.spaces[0].temporaryTabs=Array.from({length:20001},(_,i)=>i+1);
 if(kind==='overrides')c.overrides=Array.from({length:2001},(_,i)=>({tabId:i+1,incarnation:'x',epoch:{kind:'session',epoch:'x'}}));
 if(kind==='guard-work'){
  f.store.spaces[0].temporaryTabs=Array.from({length:10000},(_,i)=>i+1);
  c.overrides=Array.from({length:1000},(_,i)=>({tabId:i+1,incarnation:'x',epoch:{kind:'session',epoch:'x'}}));
 }
 await seal(f);const diagnostic=await report(f);assert.equal(diagnostic.status,'incomplete');assert.equal(diagnostic.counts,null);
});
