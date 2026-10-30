import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './today-recovery-menu-fixture.js';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const sorted=value=>Array.isArray(value)?value.map(sorted):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,sorted(value[k])])):value;
function storageBoundary(mode){
 for(const [name,area] of Object.entries({local:chrome.storage.local,session:chrome.storage.session})){
  const get=area.get.bind(area),set=area.set.bind(area);
  area.get=async keys=>{await tick();const value=await get(keys);
   if(mode==='all')return sorted(value);
   const field=mode==='spaces'&&name==='local'?'spaces':mode==='queue'&&name==='session'?'spaceRestoreQueue':mode==='snapshot'&&name==='local'?'spaceTabSnapshot':null;
   if(field&&field in value)value[field]=sorted(value[field]);return value;
  };
  area.set=async values=>{await tick();return set(mode==='all'?sorted(values):values);};
 }
 const query=chrome.tabs.query.bind(chrome.tabs),getWindow=chrome.windows.get.bind(chrome.windows);
 chrome.tabs.query=async filter=>{await tick();return query(filter);};chrome.windows.get=async id=>{await tick();return getWindow(id);};
}
async function open(f){
 f.select([1,2,3,4,5,6,7]);const opening=f.open();f.release();await opening;
 // Observe the actual UI stage, not an arbitrary count of event-loop turns.
 let observer;const dialog=new Promise(resolve=>{observer=new f.window.MutationObserver(()=>{if(f.document.getElementById('todayRecoveryDialog'))resolve();});observer.observe(f.document,{childList:true,subtree:true});});
 try{f.event(f.document.querySelector('[data-action="reviewTodayRecovery"]'),'click');await Promise.race([dialog,f.whenIdle()]);}finally{observer.disconnect();}
}
const confirm=f=>f.submits.at(-1)({preventDefault(){},isTrusted:true});

for(const mode of ['spaces','queue','snapshot','all','confirm-only','held-confirm-read'])test(`seven-tab production recovery tolerates object key reconstruction at ${mode}; preserves all key2 history`,{timeout:10000},async()=>{
 const f=await fixture({seven:true});try{
  const queue=structuredClone(f.backend.store.restoreQueue),tabs=structuredClone(f.backend.tabs),space=structuredClone(f.backend.store.spaces);
  if(!['confirm-only','held-confirm-read'].includes(mode))storageBoundary(mode);await open(f);assert(f.document.getElementById('todayRecoveryDialog'));assert.equal(f.backend.effects.length,0);
  assert.equal(f.backend.store.restoreWindowKeys.get(10),'key1');assert.equal(queue.length,6);assert(queue.every(r=>r.windowKey==='key2'));
  if(mode==='confirm-only')storageBoundary('all');
  let entered,release;
  if(mode==='held-confirm-read'){
   const get=chrome.storage.local.get.bind(chrome.storage.local);let signal;
   entered=new Promise(resolve=>{signal=resolve;});const held=new Promise(resolve=>{release=resolve;});
   chrome.storage.local.get=async keys=>{signal();await held;return get(keys);};
  }
  confirm(f);
  if(entered){await entered;for(let i=0;i<350;i++)await tick();assert.equal(f.pendingMutations(),1);release();}
  await f.whenIdle();
  assert.match(f.notice(),/membership confirmed/);assert.deepEqual(f.calls.map(c=>c.type),['previewTodayRecovery','confirmTodayRecovery']);
  assert.deepEqual(f.backend.store.restoreQueue,queue);assert.deepEqual(f.backend.session.spaceRestoreQueue,queue);assert.deepEqual(f.backend.local.spaceTabSnapshot.slice(-6),queue);
  assert.deepEqual(f.backend.tabs,tabs);assert.deepEqual(f.backend.store.spaces,space);assert.equal(f.backend.store.recoveryCandidates.size,0);
  assert.equal(f.backend.store.restoreWindowKeys.get(10),'key1');
 }finally{await f.cleanup();}
});

for(const change of ['queue-order','snapshot-order','membership-order','rank-value','rank-order','record-metadata','live-url'])test(`key-order-independent guard still rejects actual ${change} drift before writes`,{timeout:10000},async()=>{
 const f=await fixture({seven:true});try{
  storageBoundary('all');await open(f);assert(f.document.getElementById('todayRecoveryDialog'));
  if(change==='queue-order')f.backend.session.spaceRestoreQueue.reverse();
  if(change==='snapshot-order'){const snapshot=f.backend.local.spaceTabSnapshot;snapshot.splice(-6,6,...snapshot.slice(-6).reverse());}
  if(change==='membership-order')f.backend.local.spaces[0].temporaryTabs.reverse();
  if(change==='rank-value')f.backend.session.restoredTabRanks[0][1]=999;
  if(change==='rank-order')f.backend.session.restoredTabRanks.reverse();
  if(change==='record-metadata')f.backend.local.spaceTabSnapshot.at(-1).nameOverride={name:'Synthetic protected metadata'};
  if(change==='live-url')f.backend.tabs[0].url='https://changed.test/';
  confirm(f);await f.whenIdle();assert.doesNotMatch(f.notice(),/membership confirmed/);assert.equal(f.backend.effects.length,0);
  assert.equal(f.calls.length,2);assert.equal(f.backend.store.recoveryCandidates.size,6);
 }finally{await f.cleanup();}
});
