import test from 'node:test';
import assert from 'node:assert/strict';
import { createSidebarActivationSelection } from '../../sidebar-activation-selection.js';

const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
function fixture(){
 const context={windowId:10,spaceId:'s'},timers=new Map();let serial=0,interaction=0,selected=0,clears=0;
 const tab={id:1,windowId:10,active:false};
 const capture=()=>{const start=interaction;return()=>{if(start===interaction){selected=0;clears++;}};};
 const tracker=createSidebarActivationSelection({capture,getContext:()=>context,readTab:async()=>({...tab}),
  schedule:fn=>{timers.set(++serial,fn);return serial;},cancel:id=>timers.delete(id)});
 const event=(tabId=1,windowId=10)=>(tracker.consume({tabId,windowId})||capture())();
 return{tracker,context,tab,timers,event,begin:()=>tracker.begin({...context}),select:()=>{interaction++;selected=2;},selected:()=>selected,clears:()=>clears};
}
for(const timing of ['before-response','after-response','during-preparation'])test(`owned activation preserves newer selection: ${timing}`,async()=>{
 const f=fixture(),run=f.begin(),pending=deferred();
 if(timing==='during-preparation')f.select();
 const result=run(1,()=>pending.promise);await Promise.resolve();await Promise.resolve();
 if(timing!=='during-preparation')f.select();
 if(timing==='before-response')f.event();
 pending.resolve();await result;
 if(timing!=='before-response')f.event();
 assert.equal(f.selected(),2);assert.equal(f.timers.size,0);
 f.event();assert.equal(f.selected(),0,'The owned event is consumed only once');
});
test('owned activation still clears a pre-existing batch without a newer gesture',async()=>{
 const f=fixture();f.select();await f.begin()(1,async()=>{});f.event();assert.equal(f.selected(),0);
});
for(const invalidation of ['blur','removed','other-tab','new-request','space','window','timeout','failure','already-active','wrong-window'])
test(`activation intent cannot suppress external activation after ${invalidation}`,async()=>{
 const f=fixture();if(invalidation==='already-active')f.tab.active=true;if(invalidation==='wrong-window')f.tab.windowId=20;
 const run=f.begin();
 if(invalidation==='failure')await assert.rejects(run(1,async()=>{throw Error('failed');}));else await run(1,async()=>{});
 f.select();
 if(invalidation==='blur')f.tracker.clear();
 if(invalidation==='removed')f.tracker.remove(1);
 if(invalidation==='other-tab'){f.event(2);f.select();}
 if(invalidation==='new-request')f.begin();
 if(invalidation==='space')f.context.spaceId='other';
 if(invalidation==='window')f.context.windowId=20;
 if(invalidation==='timeout')for(const callback of [...f.timers.values()])callback();
 f.event();assert.equal(f.selected(),0);
});
test('foreign-window event cannot consume the local intent',async()=>{
 const f=fixture();await f.begin()(1,async()=>{});f.select();
 assert.equal(f.tracker.consume({tabId:2,windowId:20}),null);f.event();assert.equal(f.selected(),2);
});

for(const change of ['context','newer-request','external-event','blur','removed'])test(`held native read cannot activate after ${change}`,async()=>{
 const pending=deferred(),context={windowId:10,spaceId:'a'};let writes=0;
 const tracker=createSidebarActivationSelection({capture:()=>()=>{},getContext:()=>context,readTab:()=>pending.promise});
 const result=tracker.begin({...context})(1,async()=>{writes++;});
 if(change==='context')context.spaceId='b';
 if(change==='newer-request')tracker.begin({...context});
 if(change==='external-event')tracker.consume({windowId:10,tabId:2});
 if(change==='blur')tracker.clear();
 if(change==='removed')tracker.remove(1);
 pending.resolve({id:1,windowId:10,active:false});assert.equal(await result,false);assert.equal(writes,0);tracker.clear();
});
test('consecutive same-window requests completing in reverse order activate only the newest',async()=>{
 const reads=new Map([[1,deferred()],[2,deferred()]]),writes=[],context={windowId:10,spaceId:'s'};
 const tracker=createSidebarActivationSelection({capture:()=>()=>{},getContext:()=>context,readTab:id=>reads.get(id).promise});
 const a=tracker.begin(context)(1,async()=>writes.push(1)),b=tracker.begin(context)(2,async()=>writes.push(2));
 reads.get(2).resolve({id:2,windowId:10,active:false});assert.equal(await b,true);
 reads.get(1).resolve({id:1,windowId:10,active:false});assert.equal(await a,false);assert.deepEqual(writes,[2]);tracker.clear();
});
