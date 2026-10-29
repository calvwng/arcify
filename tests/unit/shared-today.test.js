import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSharedToday, openSharedToday, registerSharedToday } from '../../shared-today.js';
import { createRemoteTodayRow } from '../../shared-today-ui.js';
import { parseHTML } from 'linkedom';
function fixture() {
 const windows = [1,2,3].map(id => ({ id, type:'normal', incognito:false, focused:id===1 }));
 const tabs = [1,2,3,4].map((id,index) => ({ id, windowId:id<3?1:2, title:`Tab ${id}`, url:'https://same.test/', pinned:false, incognito:false, active:id===1||id===3, index, splitViewId:-1 }));
 const mutations=[];
 const store={ spaces:[{ id:'a',bookmarkFolderId:'fa',spaceBookmarks:[],temporaryTabs:[3,1,4] },{id:'b',bookmarkFolderId:'fb',spaceBookmarks:[],temporaryTabs:[2]}], active:{1:'b',2:'b'}, recoveryCandidates:new Set(),provisional:new Set(),
  async applyAction(m){mutations.push(['space',m]);this.active[m.windowId]=m.spaceId;}, run:fn=>fn(), isGlobalTab:()=>false,isTransientTab:()=>false,isTransientWindow:()=>false };
 let hook=()=>{};
 const api={ runtime:{id:'a'.repeat(32),getURL:p=>`chrome-extension://${'a'.repeat(32)}/${p}`,onMessage:{addListener:fn=>{api.listener=fn;}}},storage:{local:{get:async()=>({})}},
 windows:{getAll:async()=>structuredClone(windows),get:async id=>{const w=windows.find(w=>w.id===id);if(!w)throw Error('closed');return structuredClone(w);},update:async(id,m)=>{mutations.push(['window',id,m]);for(const w of windows)w.focused=w.id===id;hook('window');return structuredClone(windows.find(w=>w.id===id));}},
 tabs:{query:async()=>structuredClone(tabs),get:async id=>{const t=tabs.find(t=>t.id===id);if(!t)throw Error('closed');return structuredClone(t);},update:async(id,m)=>{mutations.push(['tab',id,m]);const t=tabs.find(t=>t.id===id);for(const other of tabs)if(other.windowId===t.windowId)other.active=other.id===id;hook('tab');return structuredClone(t);}}};
 globalThis.chrome=api;
 return {api,store,tabs,windows,mutations,hook:fn=>{hook=fn;},request:{windowId:1,id:3,ownerWindowId:2,spaceId:'a',bookmarkFolderId:'fa'}};
}
test('shared projection preserves canonical identity/order across equal URLs and Spaces',async()=>{const f=fixture();assert.deepEqual((await readSharedToday(f.store)).map(r=>r.id),[3,1,4,2]);assert.equal(f.mutations.length,0);});
for (const reason of ['private','popup','pin','favorite','transient','recovery','provisional','split','duplicateOwner']) test(`projection excludes ${reason}`,async()=>{
 const f=fixture();if(reason==='private')f.windows[1].incognito=true;if(reason==='popup')f.windows[1].type='popup';if(reason==='pin')f.tabs[2].pinned=true;if(reason==='favorite')f.store.isGlobalTab=t=>t.id===3;if(reason==='transient')f.store.isTransientTab=t=>t.id===3;if(reason==='recovery')f.store.recoveryCandidates.add(3);if(reason==='provisional')f.store.provisional.add(3);if(reason==='split')f.tabs[2].splitViewId=7;if(reason==='duplicateOwner')f.store.spaces[1].temporaryTabs.push(3);
 assert.equal((await readSharedToday(f.store)).some(r=>r.id===3),false);assert.equal(f.mutations.length,0);
});
test('open existing tab focuses owner and selects its Space only; repeated clicks create nothing',async()=>{const f=fixture();for(let i=0;i<2;i++)assert.equal((await openSharedToday(f.store,f.request)).tabId,3);assert.equal(f.store.active[1],'b');assert.equal(f.store.active[2],'a');assert.equal(f.tabs[0].active,true);assert.equal(f.tabs[2].url,'https://same.test/');assert.equal(f.tabs[2].windowId,2);assert.equal(f.tabs.length,4);assert.equal(f.mutations.filter(m=>m[0]==='tab').length,2);});
for(const change of ['closed','moved','reassigned','folder','private','recovery'])test(`stale ${change} rejects before focus`,async()=>{const f=fixture();if(change==='closed')f.tabs.splice(2,1);if(change==='moved')f.tabs[2].windowId=3;if(change==='reassigned'){f.store.spaces[0].temporaryTabs=[1,4];f.store.spaces[1].temporaryTabs.push(3);}if(change==='folder')f.store.spaces[0].bookmarkFolderId='replacement';if(change==='private')f.windows[1].incognito=true;if(change==='recovery')f.store.recoveryCandidates.add(3);await assert.rejects(openSharedToday(f.store,f.request));assert.equal(f.mutations.length,0);});
test('pairing authority is rechecked before every native mutation',async()=>{const f=fixture();let n=0;await assert.rejects(openSharedToday(f.store,f.request,{beforeMutation:async()=>{if(++n===2)throw Error('revoked');}}));assert.equal(f.mutations.some(m=>m[0]==='tab'),false);});
test('changed identity after tab activation fails and never focuses wrong window',async()=>{const f=fixture();f.hook(stage=>{if(stage==='tab')f.tabs[2].windowId=3;});await assert.rejects(openSharedToday(f.store,f.request));assert.equal(f.mutations.some(m=>m[0]==='window'),false);});
test('failed focus readback cannot report success',async()=>{const f=fixture();f.hook(stage=>{if(stage==='window')f.windows[1].focused=false;});await assert.rejects(openSharedToday(f.store,f.request),{code:'SHARED_TODAY_UNCONFIRMED'});});
test('remote DOM row cannot enter local tab selection/menus/drag; one pending open',async()=>{const f=fixture();const {document}=parseHTML('<html><body></body></html>');let done,calls=0;const row=createRemoteTodayRow(document,(await readSharedToday(f.store))[0],{windowId:1,request:async()=>{calls++;await new Promise(r=>done=r);}});assert.equal(row.matches('.tab,[data-tab-id],.pinned-favicon'),false);assert.equal(row.draggable,false);assert.match(row.textContent,/Window 2/);const {Event}=document.defaultView;for(let i=0;i<2;i++){const event=new Event('click');Object.defineProperty(event,'isTrusted',{value:true});row.dispatchEvent(event);}assert.equal(calls,1);done();await Promise.resolve();});
test('internal listener rejects content, tab-hosted and wrong extension senders',async()=>{const f=fixture();registerSharedToday(f.store);for(const sender of [{id:'x',url:f.api.runtime.getURL('sidebar.html')},{id:f.api.runtime.id,url:f.api.runtime.getURL('sidebar.html'),tab:{id:1}},{id:f.api.runtime.id,url:'https://web.test/'}]){const response=await new Promise(resolve=>f.api.listener({type:'arcifySharedToday',action:'read',windowId:1},sender,resolve));assert.equal(response.success,false);assert.equal(response.code,'UNAUTHORIZED');}});

for(const boundary of [1,2,3])test(`revocation during identity read at boundary ${boundary} cannot reach next mutation`,async()=>{
 const f=fixture();let reads=0,revoked=false;const query=f.api.tabs.query;f.api.tabs.query=async(...args)=>{const result=await query(...args);if(++reads===boundary)revoked=true;return result;};
 await assert.rejects(openSharedToday(f.store,f.request,{beforeMutation:async()=>{if(revoked)throw Error('pairing revoked');}}));
 assert.equal(f.mutations.filter(m=>m[0]==='space').length,boundary>1?1:0);assert.equal(f.mutations.filter(m=>m[0]==='tab').length,boundary>2?1:0);assert.equal(f.mutations.filter(m=>m[0]==='window').length,0);
});
test('native detach during final authority await fences the pending exact-ID focus',async()=>{
 const f=fixture();const listeners=new Set();f.api.tabs.onDetached={addListener:fn=>listeners.add(fn),removeListener:fn=>listeners.delete(fn)};
 await assert.rejects(openSharedToday(f.store,f.request,{beforeMutation:async()=>{f.tabs[2].windowId=3;for(const fn of listeners)fn(3,{oldWindowId:2});}}),{code:'STALE_SHARED_TODAY'});
 assert.equal(f.mutations.length,0);assert.equal(listeners.size,0);
});
