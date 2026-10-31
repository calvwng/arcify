import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {diagnoseSelectedRecovery,registerSelectedRecoveryDiagnostics,SELECTED_RECOVERY_DIAGNOSTIC,validateDiagnosticReport} from '../../selected-recovery-diagnostics.js';
import {createSelectedRecoveryDiagnosticAction,appendSelectedRecoveryDiagnostic} from '../../selected-recovery-diagnostics-ui.js';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(count=7){
 const entries=Array.from({length:count},(_,i)=>({tabId:101+i,url:`https://secret.test/${i}`}));
 const spaces=[{id:'secret-space',bookmarkFolderId:'secret-folder',temporaryTabs:entries.map(e=>e.tabId),spaceBookmarks:[]}];
 const queue=entries.map(e=>({...e,spaceId:'secret-space',section:'temporaryTabs'}));
 const request={type:SELECTED_RECOVERY_DIAGNOSTIC,windowId:10,spaceId:'secret-space',bookmarkFolderId:'secret-folder',entries};
 const snapshot={stable:true,scope:'live-store',memory:{spaces,active:{10:'secret-space'},restoreQueue:queue,recoveryCandidates:entries.map(e=>e.tabId),provisional:[]},
 local:{spaces:structuredClone(spaces)},session:{spaceSession:true,activeSpaces:{10:'secret-space'},spaceRestoreQueue:structuredClone(queue),spaceRecoveryCandidates:entries.map(e=>e.tabId)},
 tabs:entries.map(e=>({id:e.tabId,url:e.url,windowId:10,pinned:false,incognito:false})),windows:[{id:10,type:'normal',incognito:false}]};
 return {request,snapshot,sync:()=>{snapshot.session.spaceRestoreQueue=structuredClone(snapshot.memory.restoreQueue);}};
}
for(const reason of ['multipleHistoricalRecords','otherSpace','nonTodaySection','pinMetadata','nameMetadata'])test(`selected classifier ${reason} exposes counts only`,()=>{
 const f=fixture(),q=f.snapshot.memory.restoreQueue;
 if(reason==='multipleHistoricalRecords')q.push({...q[0]});
 if(reason==='otherSpace')q[0].spaceId='secret-other';if(reason==='nonTodaySection')q[0].section='spaceBookmarks';
 if(reason==='pinMetadata')q[0].pinnedState={bookmarkId:'secret-pin'};if(reason==='nameMetadata')q[0].nameOverride={name:'secret-title'};
 f.sync();const before=JSON.stringify(f),r=diagnoseSelectedRecovery(f.snapshot,f.request);
 assert.equal(r.counts[reason],1);assert.equal(r.counts.blockedSelected,1);assert.equal(r.selectedCount,7);
 assert.doesNotMatch(JSON.stringify(r),/secret|https|tabId|windowId|spaceId/);assert.equal(JSON.stringify(f),before);
});
for(const change of ['unstable','cold','queue','flags','source','url','private','owner','window'])test(`selected classifier refuses ${change} without counts`,()=>{
 const f=fixture();if(change==='unstable')f.snapshot.stable=false;if(change==='cold')f.snapshot.scope='persisted-projection';
 if(change==='queue')f.snapshot.session.spaceRestoreQueue=[];if(change==='flags')f.snapshot.session.spaceRecoveryCandidates=[];if(change==='source')f.snapshot.memory.active[10]='other';
 if(change==='url')f.snapshot.tabs[0].url='https://changed.test/';if(change==='private')f.snapshot.tabs[0].incognito=true;
 if(change==='owner')f.snapshot.memory.spaces[0].spaceBookmarks.push(101);if(change==='window')f.snapshot.tabs[0].windowId=20;
 const r=diagnoseSelectedRecovery(f.snapshot,f.request);assert.notEqual(r.status,'stable');assert.equal(r.counts,null);
});
test('report validator rejects unknown fields and out-of-range counts',()=>{
 const f=fixture(),r=diagnoseSelectedRecovery(f.snapshot,f.request);
 assert.throws(()=>validateDiagnosticReport({...r,url:'secret'}));assert.throws(()=>validateDiagnosticReport({...r,counts:{...r.counts,otherSpace:8}}));
});
test('disabled receiver registers nothing; enabled sender/schema failures expose no raw data',()=>{
 const listeners=[];const event={addListener:fn=>listeners.push(fn),removeListener:fn=>listeners.splice(listeners.indexOf(fn),1)};
 const api={runtime:{id:'self',getURL:path=>'chrome-extension://self/'+path,onMessage:event}};
 registerSelectedRecoveryDiagnostics({},api,{enabled:false});assert.equal(listeners.length,0);
 const dispose=registerSelectedRecoveryDiagnostics({},api);let reply;
 const f=fixture();listeners[0](f.request,{id:'foreign'},v=>reply=v);assert.deepEqual(reply,{success:false});
 listeners[0](f.request,{id:'self',url:api.runtime.getURL('sidebar.html'),incognito:true},v=>reply=v);assert.deepEqual(reply,{success:false});
 listeners[0]({...f.request,extra:'secret'},{id:'self',url:api.runtime.getURL('sidebar.html')},v=>reply=v);assert.deepEqual(reply,{success:false});dispose();assert.equal(listeners.length,0);
});
test('real receiver captures twice behind queue without running mutating store helpers',async()=>{
 const f=fixture(),listeners=[];let reads=0,release;
 const forbidden=()=>assert.fail('diagnostic must not mutate or initialize');
 const store={...f.snapshot.memory,initialized:true,chain:new Promise(r=>release=r),run:forbidden,initialize:forbidden,track:forbidden,persist:forbidden,
 recoveryCandidates:new Set(f.snapshot.memory.recoveryCandidates),provisional:new Set(),snapshotByTab:new Map(),windowKeys:new Map(),restoreWindowKeys:new Map()};
 const api={runtime:{id:'self',getURL:path=>'chrome-extension://self/'+path,onMessage:{addListener:fn=>listeners.push(fn),removeListener:()=>{}}},
 storage:{local:{get:async()=>structuredClone(f.snapshot.local),set:forbidden},session:{get:async()=>structuredClone(f.snapshot.session),set:forbidden}},
 tabs:{query:async()=>{reads++;return structuredClone(f.snapshot.tabs);}},windows:{getAll:async()=>structuredClone(f.snapshot.windows)}};
 const dispose=registerSelectedRecoveryDiagnostics(store,api);
 const response=new Promise(resolve=>assert.equal(listeners[0](f.request,{id:'self',url:api.runtime.getURL('sidebar.html')},resolve),true));
 await tick();assert.equal(reads,0);release();const result=await response;
 assert.equal(reads,2);assert.equal(result.report.status,'stable');assert.equal(result.report.selectedCount,7);
 assert.doesNotMatch(JSON.stringify(result),/secret|https|tabId/);dispose();
});
function ui({enabled=true,timeoutMs=10000}={}){
 const {document,window}=parseHTML('<html><body><div id="tab-context-menu"></div></body></html>');
 let valid=true,resolve,reject,begins=0,ends=0;const requests=[],copied=[],statuses=[];
 const f=fixture(2),snapshot={...f.request};
 const action=createSelectedRecoveryDiagnosticAction({document,selection:{validate:()=>valid},enabled,timeoutMs,
 sendRequest:request=>{requests.push(request);return new Promise((yes,no)=>{resolve=yes;reject=no;});},copy:async text=>copied.push(text),showStatus:text=>statuses.push(text),begin:()=>begins++,end:()=>ends++});
 const event=(node,type,extra={})=>{const e=new window.Event(type,{bubbles:true,cancelable:true});Object.assign(e,extra);node.dispatchEvent(e);};
 return {document,window,action,snapshot,requests,copied,statuses,event,invalid:()=>valid=false,resolve:layoutReport=>resolve({success:true,report:diagnoseSelectedRecovery(f.snapshot,f.request),...(layoutReport?{layoutReport}:{})}),reject:()=>reject(Error('secret error')),counts:()=>[begins,ends]};
}
test('built-in layout evidence appears in the dialog and its sanitized copy',async()=>{
 const {LAYOUT_COUNT_KEYS}=await import('../../durable-layout-diagnostics.js');const f=ui();f.action(f.snapshot);await tick();
 f.resolve({schema:'arcify-layout-diagnostic-v2',status:'stable',nativeGroupSync:'enabled',counts:Object.fromEntries(LAYOUT_COUNT_KEYS.map(k=>[k,k==='pendingTodayPlacements'?7:0]))});await tick();
 assert.match(f.document.querySelector('[role="status"]').textContent,/Saved layout evidence/);
 f.event(f.document.querySelector('button'),'click');await tick();const report=JSON.parse(f.copied[0]);assert.equal(report.layout.counts.pendingTodayPlacements,7);
 assert.doesNotMatch(f.copied[0],/https|tabId|windowId|fingerprint|incarnation/);f.event(f.document.querySelectorAll('button')[1],'click');
});
test('menu captures exact batch before close; repeated on-demand use and sanitized copy work',async()=>{
 const f=ui();for(let i=0;i<2;i++){
 const menu=f.document.getElementById('tab-context-menu');menu.replaceChildren();let closed=0;
 appendSelectedRecoveryDiagnostic({document:f.document,menu,actions:{diagnose:()=>f.action(f.snapshot)},close:()=>closed++});
 f.event(menu.firstChild,'click');assert.equal(closed,1);await tick();assert.equal(f.requests.length,i+1);
 f.resolve();await tick();assert.match(f.document.querySelector('[role="status"]').textContent,/2 selected tabs checked/);
 const buttons=f.document.querySelectorAll('button');f.event(buttons[0],'click');await tick();assert.doesNotMatch(f.copied.at(-1),/secret|https|tabId/);
 f.event(buttons[1],'click');assert.equal(f.document.getElementById('selectedRecoveryDiagnosticDialog'),null);
 }assert.deepEqual(f.counts(),[2,2]);
});
for(const exit of ['close','blur','hidden','pagehide','stale','timeout','reject'])test(`diagnostic ${exit} ignores obsolete results and releases once`,async()=>{
 const f=ui({timeoutMs:exit==='timeout'?1:10000});f.action(f.snapshot);await tick();
 if(exit==='close')f.event(f.document.querySelectorAll('button')[1],'click');
 if(exit==='blur'||exit==='pagehide')f.event(f.window,exit);
 if(exit==='hidden'){Object.defineProperty(f.document,'hidden',{value:true});f.event(f.document,'visibilitychange');}
 if(exit==='stale')f.invalid();if(exit==='timeout')await new Promise(r=>setTimeout(r,5));
 if(exit==='reject')f.reject();else f.resolve();await tick();
 assert.deepEqual(f.counts(),[1,1]);assert.doesNotMatch(f.document.body.textContent,/secret|2 selected tabs checked/);
});
test('disabled UI and initially stale selection do not send',async()=>{
 const disabled=ui({enabled:false});disabled.action(disabled.snapshot);await tick();assert.equal(disabled.requests.length,0);assert.equal(disabled.document.querySelector('[role="dialog"]'),null);
 const stale=ui();stale.invalid();stale.action(stale.snapshot);await tick();assert.equal(stale.requests.length,0);assert.equal(stale.statuses.length,1);
});
