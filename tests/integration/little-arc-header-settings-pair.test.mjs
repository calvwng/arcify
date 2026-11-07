// Synthetic transport and browser APIs; both production header modules execute unchanged.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {createLittleArcHeaderService,registerLittleArcHeader} from '../../little-arc-header.js';
const root=process.env.ARCIFY_DIMMING_SPOTLIGHT_ROOT;assert(root,'Set ARCIFY_DIMMING_SPOTLIGHT_ROOT');
const {installLittleArcHeaderBroker}=await import(pathToFileURL(resolve(root,'shared/little-arc-header-broker.js')));
const {HEADER_TOP_PORT,HEADER_FRAME_PORT,HEADER_PAGE}=await import(pathToFileURL(resolve(root,'shared/little-arc-header-protocol.js')));
const SELF='a'.repeat(32),PEER='b'.repeat(32),token='11111111-1111-4111-8111-111111111111';
function fixture(){
 const tabs=[{id:1,windowId:10,url:'https://source.test/',active:true,incognito:false,pinned:false,splitViewId:-1},{id:2,windowId:20,url:`chrome-extension://${SELF}/transient-window.html?token=${token}`,active:false,incognito:false},{id:3,windowId:20,url:'https://page.test/',active:true,incognito:false,pinned:false,splitViewId:-1}];
 const windows=[{id:10,type:'normal',incognito:false,focused:false},{id:20,type:'normal',incognito:false,focused:true}];
 const local={arcifyBridgePeerId:PEER,arcifyBridgePairingGeneration:'g'},mutations=[];
 const record={token,originWindowId:10,windowId:20,controllerTabId:2,tabId:3,phase:'ready'};
 const nodes=[{id:'fa',title:'A',parentId:'root'},{id:'root',title:'Arcify'}];
 const api={runtime:{id:SELF,getURL:p=>`chrome-extension://${SELF}/${p}`,onMessageExternal:{addListener:fn=>api.listener=fn},sendMessage:async()=>{}},storage:{local:{get:async()=>structuredClone(local)},sync:{get:async()=>({})}},
 tabs:{get:async id=>{const t=tabs.find(t=>t.id===id);if(!t)throw Error('closed');return structuredClone(t);},update:async(id,change)=>{mutations.push(['tab',id,change]);const t=tabs.find(t=>t.id===id);for(const other of tabs)if(other.windowId===t.windowId)other.active=other.id===id;return structuredClone(t);}},
 windows:{getAll:async()=>structuredClone(windows),get:async id=>{const w=windows.find(w=>w.id===id);if(!w)throw Error('closed');return structuredClone(w);},update:async(id,change)=>{mutations.push(['window',id,change]);for(const w of windows)w.focused=w.id===id;return structuredClone(windows.find(w=>w.id===id));}},
 bookmarks:{get:async id=>nodes.filter(n=>n.id===id),search:async()=>[nodes[1]],getChildren:async id=>nodes.filter(n=>n.parentId===id)}};
 const store={spaces:[{id:'a',name:'A',bookmarkFolderId:'fa',spaceBookmarks:[],temporaryTabs:[1]}],active:{10:'a'},run:fn=>fn(),favoriteStore:{state:{bindings:[],attempts:[]}},isGlobalTab:()=>false,isTransientTab:()=>false,isTransientWindow:id=>id===20,
 transientWindows:{listUnlocked:async()=>[record],openUnlocked:async(request,options)=>{await options.beforeMutation();mutations.push(['open',request]);return record;}}};
 globalThis.chrome=api;const service=createLittleArcHeaderService(store,api);store.littleArcHeader=service;
 return {api,store,service,tabs,windows,local,record,mutations,source:{tabId:3,windowId:20,url:'https://page.test/'},target:{windowId:10,spaceId:'a',bookmarkFolderId:'fa'}};
}
const event=()=>{const handlers=new Set();return {addListener:f=>handlers.add(f),removeListener:f=>handlers.delete(f),emit:(...args)=>Promise.all([...handlers].map(f=>f(...args)))};};
for(const invalidation of ['expired','replaced'])for(const failAfterDispatch of [false,true])test(`real paired settings refreshes ${invalidation} view; dispatch error=${failAfterDispatch}`,async t=>{
 const f=fixture(),originalNow=Date.now;let now=originalNow();Date.now=()=>now;t.after(()=>{Date.now=originalNow;delete globalThis.chrome;});
 registerLittleArcHeader(f.store,f.api);const requests=[],notices=[];f.api.runtime.sendMessage=async m=>notices.push(m);
 const local={arcifyBridgePeerId:SELF,arcifyBridgePairingGeneration:'g'},session={};
 const api={runtime:{id:PEER,getURL:p=>`chrome-extension://${PEER}/${p}`,onConnect:event(),onMessage:event(),onMessageExternal:event(),sendMessage:async(peer,request)=>{
  assert.equal(peer,SELF);requests.push(structuredClone(request));const result=await new Promise(resolve=>f.api.listener(request,{id:PEER,url:`chrome-extension://${PEER}/background.js`},resolve));
  if(failAfterDispatch&&request.action==='settings')throw Error('Synthetic response lost after dispatch');return result;
 }},storage:{local:{get:async()=>structuredClone(local)},session:{get:async()=>structuredClone(session),set:async v=>Object.assign(session,v)},onChanged:event()},tabs:{...f.api.tabs,onUpdated:event(),onRemoved:event(),onAttached:event(),onDetached:event(),onReplaced:event()},windows:{...f.api.windows,onRemoved:event()}};
 const broker=installLittleArcHeaderBroker(api);t.after(()=>broker.dispose());
 const makePort=(name,frameId,url)=>{let closed=false;const p={name,sender:{id:PEER,frameId,url,origin:new URL(url).origin==='null'?`chrome-extension://${PEER}`:new URL(url).origin,tab:structuredClone(f.tabs[2])},messages:[],onMessage:event(),onDisconnect:event(),postMessage:m=>p.messages.push(m),disconnect:()=>{if(!closed){closed=true;void p.onDisconnect.emit();}}};return p;};
 const top=makePort(HEADER_TOP_PORT,0,f.source.url);await api.runtime.onConnect.emit(top);await top.onMessage.emit({kind:'hello'});
 const frame=makePort(HEADER_FRAME_PORT,4,api.runtime.getURL(HEADER_PAGE));await api.runtime.onConnect.emit(frame);await frame.onMessage.emit({kind:'bind',challenge:top.messages.find(m=>m.kind==='mount').challenge});
 const cached=frame.messages.find(m=>m.kind==='context').context;
 if(invalidation==='expired')now+=120001;else await f.store.littleArcHeader.inspect(f.source,PEER,'g');
 await assert.rejects(f.store.littleArcHeader.review(f.source,cached.viewId,null,PEER,'g',async()=>{},'window-size'),{code:'STALE_HEADER'});
 assert.equal(f.mutations.length,0);const spaces=structuredClone(f.store.spaces);
 await frame.onMessage.emit({kind:'sizeSettings'});
 assert.deepEqual(requests.map(r=>r.action),['inspect','inspect','settings']);
 const fresh=frame.messages.find(m=>m.kind==='settingsContext').context;assert.notEqual(fresh.viewId,cached.viewId);assert.equal(requests[2].viewId,fresh.viewId);
 for(const request of requests)assert.deepEqual(request.source,f.source);
 assert.deepEqual(f.mutations,[['tab',2,{active:true}],['window',20,{focused:true}]]);assert.deepEqual(f.store.spaces,spaces);assert.equal(f.tabs[2].windowId,20);assert.equal(f.tabs[2].url,f.source.url);assert.equal(notices[0].section,'window-size');
 await frame.onMessage.emit({kind:'sizeSettings'});assert.equal(requests.filter(r=>r.action==='settings').length,1,'A response error or repeated click must never replay settings dispatch');assert.equal(f.mutations.length,2);
});
