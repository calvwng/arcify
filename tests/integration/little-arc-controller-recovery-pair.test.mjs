// Synthetic transport/browser APIs; actual broker, registered header and transient registry execute unchanged.
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
import {createTransientWindowStore,TRANSIENT_WINDOW_SESSION_KEY as KEY} from '../../transient-window-store.js';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function settle(predicate){for(let i=0;i<100;i++){if(predicate())return;await tick();}assert.fail('Synthetic operation did not settle');}
async function paired(t,{lostCreateAck=false,lostRecoveryReply=false,createRace=null,afterCommitAuthorization=null}={}){
 const f=fixture(),requests=[],callbacks=[],notices=[],probes=[],created=[];let nextId=100,registry;
 let session={[KEY]:{version:1,records:[{...f.record,memberTabIds:[2,3],recovered:undefined}]}};
 delete session[KEY].records[0].recovered; for(const tab of f.tabs){tab.pinned=false;tab.splitViewId=-1;tab.status="complete";}
 for(const name of ['onCreated','onRemoved','onUpdated','onAttached','onDetached','onReplaced','onActivated'])f.api.tabs[name]=event();
 for(const name of ['onRemoved','onFocusChanged'])f.api.windows[name]=event();
 f.api.storage.session={get:async()=>structuredClone(session),set:async patch=>Object.assign(session,structuredClone(patch))};
 f.api.tabs.query=async query=>structuredClone(f.tabs.filter(tab=>query.windowId!==undefined?tab.windowId===query.windowId:query.url?tab.url.startsWith(query.url.slice(0,-1)):true));
 f.api.tabs.onCreated.addListener(tab=>registry.observe(tab));f.api.tabs.onRemoved.addListener(id=>registry.observeRemoved(id));
 f.api.tabs.onDetached.addListener((id,info)=>registry.observeDetached(id,info.oldWindowId));f.api.tabs.onReplaced.addListener((a,r)=>registry.observeReplacement(a,r));f.api.windows.onRemoved.addListener(id=>registry.observeWindowRemoved(id));
 f.api.tabs.create=async options=>{const tab={id:nextId++,...options,status:'complete',incognito:false,splitViewId:-1};created.push(structuredClone(tab));f.tabs.push(tab);await f.api.tabs.onCreated.emit(structuredClone(tab));if(createRace)await createRace(f,tab);if(lostCreateAck)throw Error('Synthetic lost tabs.create acknowledgment');return structuredClone(tab);};
 // Replace the seed fixture stub before any broker/header request; recovery always uses the actual registry.
 const restart=async()=>{registry=createTransientWindowStore({api:f.api});f.store.transientWindows=registry;await registry.initialize();};await restart();
 let queue=Promise.resolve();f.store.run=fn=>{const result=queue.then(fn);queue=result.catch(()=>{});return result;};
 registerLittleArcHeader(f.store,f.api);
 const local={arcifyBridgePeerId:SELF,arcifyBridgePairingGeneration:'g'},spotSession={};let challenge;
 const api={runtime:{id:PEER,getURL:p=>`chrome-extension://${PEER}/${p}`,onConnect:event(),onMessage:event(),onMessageExternal:event(),sendMessage:async(peer,request)=>{assert.equal(peer,SELF);requests.push(structuredClone(request));const result=await new Promise(resolve=>f.api.listener(request,{id:PEER,url:`chrome-extension://${PEER}/background.js`},resolve));if(lostRecoveryReply&&request.action==='recoverControls')throw Error('Synthetic lost recovery reply');return result;}},storage:{local:{get:async()=>structuredClone(local)},session:{get:async()=>structuredClone(spotSession),set:async patch=>Object.assign(spotSession,structuredClone(patch))},onChanged:event()},tabs:{...f.api.tabs,sendMessage:async(id,message,target)=>{probes.push({id,message,target});return {challenge,url:f.tabs.find(tab=>tab.id===3)?.url,safe:true};}},windows:f.api.windows};
 f.api.runtime.sendMessage=async(first,message)=>{if(typeof first!=='string'){notices.push(first);return;}assert.equal(first,PEER);callbacks.push(message);const response=await new Promise(resolve=>{void api.runtime.onMessageExternal.emit(message,{id:SELF,url:`chrome-extension://${SELF}/background.js`},resolve);});if(message.stage==='commit'&&afterCommitAuthorization)await afterCommitAuthorization(f,response);return response;};
 const broker=installLittleArcHeaderBroker(api);t.after(()=>{broker.dispose();delete globalThis.chrome;});
 const port=(name,frameId,url)=>{let closed=false;const p={name,sender:{id:PEER,frameId,documentId:'synthetic-source-document',url,origin:frameId?`chrome-extension://${PEER}`:'https://page.test',tab:structuredClone(f.tabs.find(tab=>tab.id===3))},messages:[],onMessage:event(),onDisconnect:event(),postMessage:m=>p.messages.push(m),disconnect:()=>{if(!closed){closed=true;void p.onDisconnect.emit();}}};return p;};
 const top=port(HEADER_TOP_PORT,0,f.source.url);await api.runtime.onConnect.emit(top);await top.onMessage.emit({kind:'hello'});challenge=top.messages.find(m=>m.kind==='mount').challenge;
 const frame=port(HEADER_FRAME_PORT,4,api.runtime.getURL(HEADER_PAGE));await api.runtime.onConnect.emit(frame);await frame.onMessage.emit({kind:'bind',challenge});
 const activate=async()=>{for(const tab of f.tabs)if(tab.windowId===20)tab.active=tab.id===3;await api.tabs.onActivated.emit({tabId:3,windowId:20});await tick();await settle(()=>!broker.sessions.get(3)?.inFlight);};
 const closeController=async()=>{const record=(await registry.listUnlocked())[0];const index=f.tabs.findIndex(tab=>tab.id===record.controllerTabId);assert(index>=0);f.tabs.splice(index,1);await f.api.tabs.onRemoved.emit(record.controllerTabId,{windowId:20,isWindowClosing:false});await activate();};
 return {...f,api,requests,callbacks,notices,probes,created,frame,broker,restart,closeController,activate,get registry(){return registry;},settings:()=>frame.onMessage.emit({kind:'sizeSettings'})};
}
test('actual paired recovery repeats close and source activation without manual Refresh or duplicate creation',async t=>{
 const f=await paired(t),before=structuredClone(f.store.spaces);await f.settings();assert.equal(f.created.length,0);
 for(let cycle=1;cycle<=3;cycle++){
  await f.closeController();assert.equal(f.created.length,cycle-1,'Returning/inspect cannot create');assert.equal(f.frame.messages.at(-1).context.controlsMissing,true);
  await Promise.all([f.settings(),f.settings()]);assert.equal(f.created.length,cycle);const record=(await f.registry.listUnlocked())[0];assert.equal(record.phase,'ready');assert.equal(record.controllerTabId,f.created.at(-1).id);assert.equal(record.tabId,3);assert.equal(record.windowId,20);assert.equal(f.tabs.find(tab=>tab.id===record.controllerTabId).active,true);assert.equal(f.created.at(-1).active,false);
 }
 assert.deepEqual(f.store.spaces,before);assert.equal(f.tabs.find(tab=>tab.id===3).url,f.source.url);assert.equal(f.requests.filter(r=>r.action==='recoverControls').length,3);assert.deepEqual(f.callbacks.map(m=>m.stage),['prepare','commit','prepare','commit','prepare','commit']);assert(f.probes.every(p=>p.target.documentId==='synthetic-source-document'));
});
for(const loss of ['lostCreateAck','lostRecoveryReply'])test(`actual paired recovery ${loss} never retries on return, click, Refresh or registry reload`,async t=>{
 const f=await paired(t,{[loss]:true});await f.closeController();await f.settings();assert.equal(f.created.length,1);await f.activate();await f.settings();await f.frame.onMessage.emit({kind:'refresh'});await f.settings();assert.equal(f.created.length,1);assert.equal(f.requests.filter(r=>r.action==='recoverControls').length,1);
 if(loss==='lostCreateAck'){assert.equal((await f.registry.listUnlocked())[0].phase,'uncertain');await assert.rejects(f.restart(),{code:'UNCERTAIN_RESULT'});}else await f.restart();assert.equal(f.created.length,1);
});
test('registry reload after controller closure cannot invent native closure proof',async t=>{const f=await paired(t);await f.closeController();await f.restart();await f.settings();assert.equal(f.created.length,0);assert.equal((await f.registry.listUnlocked())[0].phase,'uncertain');});
for(const race of ['wrong-window','source-navigation','controller-closed'])test(`actual recovery refuses ${race} during create without rebinding or replay`,async t=>{
 const f=await paired(t,{createRace:async(state,controller)=>{if(race==='wrong-window')controller.windowId=10;if(race==='source-navigation'){state.tabs.find(tab=>tab.id===3).url='https://changed.test/';await state.api.tabs.onUpdated.emit(3,{url:'https://changed.test/'});}if(race==='controller-closed'){state.tabs.splice(state.tabs.indexOf(controller),1);await state.api.tabs.onRemoved.emit(controller.id,{windowId:20,isWindowClosing:false});}}});
 await f.closeController();await f.settings();assert.equal(f.created.length,1);assert.equal((await f.registry.listUnlocked())[0].phase,'uncertain');assert.equal(f.mutations.length,0);await f.settings();assert.equal(f.created.length,1);
});
test('duplicate marker after actual commit authorization prevents binding and focus',async t=>{
 const f=await paired(t,{afterCommitAuthorization:async(state,response)=>{
  assert.deepEqual(response,{authorized:true});const controller=state.tabs.find(tab=>tab.id===100);
  const duplicate={...controller,id:999};state.tabs.push(duplicate);await state.api.tabs.onCreated.emit(structuredClone(duplicate));
 }});
 await f.closeController();await f.settings();const record=(await f.registry.listUnlocked())[0];
 assert.equal(f.created.length,1);assert.equal(record.controllerTabId,2);assert.equal(record.phase,'uncertain');assert.equal(f.mutations.length,0);
 await f.activate();await f.settings();assert.equal(f.created.length,1);assert.deepEqual(f.callbacks.map(m=>m.stage),['prepare','commit']);
});
