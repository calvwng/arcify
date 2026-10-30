import test from 'node:test';
import assert from 'node:assert/strict';
import {captureRoutedOpenSource,runRoutedOpen,ROUTED_OPEN_FEATURE} from '../../spotlight-routed-open.js';
import {createSpotlightBridge} from '../../spotlight-bridge.js';
import {validateRequest} from '../../spotlight-bridge-protocol.js';

const clone=structuredClone, PEER='a'.repeat(32),SELF='b'.repeat(32);
const event=()=>{const listeners=new Set();return {addListener:f=>listeners.add(f),removeListener:f=>listeners.delete(f),fire(...args){for(const f of listeners)f(...args);}};};
function fixture(owned=true){
 const request={type:'arcify-bridge',version:1,command:'openRoutedTab',requestId:'route-1',windowId:2,supportedFeatures:[ROUTED_OPEN_FEATURE],url:'https://target.test/',source:{tabId:7,url:'https://source.test/',token:'01234567-89ab-4cde-8fab-0123456789ab'}};
 const source={id:7,windowId:2,url:request.source.url,active:true,pinned:false,incognito:false,status:'complete',index:0};
 const spaces=[{id:'work',name:'Work',color:'blue',bookmarkFolderId:'folder',spaceBookmarks:[],temporaryTabs:owned?[7]:[]}];
 const session={},local={arcifyBridgePeerId:PEER};const calls=[];const tabs=[source];
 const api={runtime:{id:SELF,getURL:p=>'chrome-extension://'+SELF+'/'+p,sendMessage(peer,message,reply){calls.push(['live',message]);reply({live:true});}},
 tabs:{async get(id){const t=tabs.find(t=>t.id===id);if(!t)throw Error('gone');return clone(t);},async query(){return clone(tabs);},async create(options){calls.push(['create',options]);const t={id:8,incognito:false,pinned:false,...options};tabs.push(t);return clone(t);},async update(id,changes){calls.push(['update',id,changes]);Object.assign(tabs.find(t=>t.id===id),changes);if(changes.active){source.active=false;api.tabs.onActivated.fire({tabId:id,windowId:2});}}},
 windows:{get:async id=>({id,type:'normal',incognito:false,focused:true}),update:async()=>{}},
 bookmarks:{get:async id=>[{id,parentId:'root'}],search:async()=>[{id:'root'}],getChildren:async()=>[]},
 storage:{local:{get:async()=>clone(local)},session:{get:async()=>clone(session),set:async data=>Object.assign(session,clone(data))}}};
 for(const name of ['onUpdated','onRemoved','onDetached','onReplaced','onActivated'])api.tabs[name]=event();api.windows.onRemoved=event();
 const store={initialized:true,spaces,active:{2:'work'},pendingCreations:new Set(),provisional:new Set(),recoveryCandidates:new Set(),archiveStore:{pendingCreatedIds:new Set()},
 favoriteStore:{initialized:true,state:{bindings:[],attempts:[]},items:[],read:async()=>({favorites:[]})},isGlobalTab:()=>false,isTransientTab:()=>false,isTransientWindow:()=>false,
 transientWindows:{observationState:()=>({initialized:true,provenanceReady:true,healthy:true,revision:0,savedRevision:0}),async openUnlocked(req,{beforeMutation}){calls.push(['transient',req]);await beforeMutation();return {tabId:9,windowId:3};}},
 discoverBookmarkSpaces:async()=>false,persist:async()=>{},async applyAction(action){calls.push(['assign',action]);if(action.action==='assign')spaces[0].temporaryTabs.push(action.tabId);if(action.action==='activate')this.active[action.windowId]=action.spaceId;local.spaces=clone(spaces);local.spaceTabSnapshot=spaces.flatMap(space=>space.temporaryTabs.map(tabId=>({tabId,spaceId:space.id,section:'temporaryTabs'})));session.activeSpaces=clone(this.active);},chain:Promise.resolve(),
 run(operation){const result=this.chain.then(operation);this.chain=result.catch(()=>{});return result;}};
 globalThis.chrome=api;
 return {api,store,request,source,calls,local,session};
}
async function run(f,beforeMutation=async()=>{}){const guard=captureRoutedOpenSource(f.store,f.request,f.api);try{return await runRoutedOpen(f.store,f.request,guard,{beforeMutation,api:f.api,peerId:PEER});}finally{guard.dispose();}}
test('proven source Space wins over selected Space and creates once without navigating source',async()=>{
 const f=fixture();f.store.active[2]='elsewhere';const result=await run(f);assert.equal(result.tabId,8);
 assert.equal(f.calls.filter(c=>c[0]==='create').length,1);assert.equal(f.calls.find(c=>c[0]==='assign')[1].spaceId,'work');assert.equal(f.source.url,'https://source.test/');
});
test('qualified absence uses serialized Little Arc creation once',async()=>{
 const f=fixture(false);assert.equal((await run(f)).transientWindowId,3);assert.equal(f.calls.filter(c=>c[0]==='transient').length,1);assert(!f.calls.some(c=>c[0]==='create'));
});
test('proven global Favorite is a reachable no-Space source without moving or changing it',async()=>{
 const f=fixture(false);f.source.pinned=true;f.store.favoriteStore.state.bindings=[{favoriteId:'favorite',tabId:7,windowId:2}];
 f.store.favoriteStore.items=[{id:'favorite',url:'https://saved.test/',sourceBookmarkId:'saved'}];f.store.favoriteStore.ownsTab=()=>true;f.store.isGlobalTab=()=>true;
 assert.equal((await run(f)).transientWindowId,3);assert.equal(f.source.url,'https://source.test/');assert.equal(f.source.pinned,true);assert(!f.calls.some(c=>c[0]==='update'));
});
test('a changed Favorite binding cannot become no-Space evidence',async()=>{
 const f=fixture(false);f.store.favoriteStore.state.bindings=[{favoriteId:'favorite',tabId:7,windowId:2,mode:'ordinary'}];
 f.store.favoriteStore.items=[{id:'favorite',url:'https://saved.test/'}];f.store.favoriteStore.ownsTab=()=>true;f.store.isGlobalTab=()=>true;
 const guard=captureRoutedOpenSource(f.store,f.request,f.api);f.store.favoriteStore.state.bindings[0].favoriteId='another';await assert.rejects(guard.check());guard.dispose();
});
for(const kind of ['cold','favorite-dirty','provisional','recovery','conflict','native-pin','global','split','archive-pending','saved-move','transient'])test(`rejects ${kind} before creation`,async()=>{
 const f=fixture();if(kind==='cold')f.store.initialized=false;if(kind==='favorite-dirty')f.store.favoriteStore.persistenceDirty=true;
 if(kind==='provisional')f.store.provisional.add(7);if(kind==='recovery')f.store.recoveryCandidates.add(7);if(kind==='conflict')f.store.spaces[0].temporaryTabs.push(7);
 if(kind==='native-pin')f.source.pinned=true;if(kind==='global')f.store.isGlobalTab=()=>true;if(kind==='split')f.source.splitViewId=1;
 if(kind==='archive-pending')f.store.archiveStore.pendingCreatedIds.add(7);if(kind==='saved-move')f.local.spaceSavedMoveJournal={phase:'prepared'};if(kind==='transient')f.store.isTransientTab=()=>true;
 await assert.rejects(run(f));assert(!f.calls.some(c=>['create','transient'].includes(c[0])));
});
for(const kind of ['url','same-url-loading','detached','replacement','closed','ownership'])test(`intake fence rejects ${kind} while waiting`,async()=>{
 const f=fixture();const guard=captureRoutedOpenSource(f.store,f.request,f.api);
 if(kind==='url')f.source.url='https://changed.test/';if(kind==='same-url-loading')f.api.tabs.onUpdated.fire(7,{status:'loading'});
 if(kind==='detached')f.api.tabs.onDetached.fire(7);if(kind==='replacement')f.api.tabs.onReplaced.fire(8,7);if(kind==='closed')f.api.tabs.onRemoved.fire(7);if(kind==='ownership')f.store.spaces[0].temporaryTabs=[];
 await assert.rejects(runRoutedOpen(f.store,f.request,guard,{beforeMutation:async()=>{},api:f.api,peerId:PEER}));guard.dispose();assert(!f.calls.some(c=>['create','transient'].includes(c[0])));
});
test('original document validation failure and late pairing failure prevent native dispatch',async()=>{
 for(const kind of ['document','pairing']){const f=fixture();if(kind==='document')f.api.runtime.sendMessage=(_p,_m,cb)=>cb({live:false});await assert.rejects(run(f,async()=>{if(kind==='pairing')throw Error('revoked');}));assert(!f.calls.some(c=>['create','transient'].includes(c[0])));}
});
test('uncertain create is not replayed, closed or reopened',async()=>{const f=fixture();f.api.tabs.create=async()=>{f.calls.push(['create']);throw Error('lost response');};await assert.rejects(run(f),{code:'UNCERTAIN_RESULT'});assert.equal(f.calls.filter(c=>c[0]==='create').length,1);});
test('protocol rejects forged source flags, missing token and nonweb destination',()=>{
 const f=fixture();assert.equal(validateRequest(f.request,['openRoutedTab']),f.request);
 for(const patch of [{source:{...f.request.source,owned:true}},{source:{tabId:7,url:f.request.source.url}},{url:'about:blank'},{supportedFeatures:[]}])assert.throws(()=>validateRequest({...f.request,...patch},['openRoutedTab']));
});
test('actual bridge journal serializes duplicate intake and worker replay without another create',async()=>{
 const f=fixture();const sender={id:PEER};const handle=createSpotlightBridge(f.store);
 const [a,b]=await Promise.all([handle(f.request,sender),handle(f.request,sender)]);assert.equal(a.ok,true,JSON.stringify(a));assert.equal(b.ok,true,JSON.stringify(b));
 const c=await createSpotlightBridge(f.store)(f.request,sender);assert.equal(c.ok,true,JSON.stringify(c));assert.equal(f.calls.filter(c=>c[0]==='create').length,1);
});
test('pending actual bridge journal blocks replay after uncertain dispatch',async()=>{
 const f=fixture();f.api.tabs.create=async()=>{f.calls.push(['create']);throw Error('uncertain');};const sender={id:PEER};
 assert.equal((await createSpotlightBridge(f.store)(f.request,sender)).ok,false);
 assert.equal((await createSpotlightBridge(f.store)(f.request,sender)).error.code,'UNCERTAIN_RESULT');assert.equal(f.calls.filter(c=>c[0]==='create').length,1);
});

test('post-create native or persisted readback failure is uncertain and never repeats creation',async()=>{
 for(const kind of ['membership','focus','persisted']){const f=fixture();const apply=f.store.applyAction.bind(f.store);f.store.applyAction=async action=>{await apply(action);if(kind==='membership')f.store.spaces[0].temporaryTabs=[];if(kind==='persisted')f.local.spaceTabSnapshot=[];};if(kind==='focus')f.api.tabs.update=async()=>{};
 await assert.rejects(run(f),{code:'UNCERTAIN_RESULT'});assert.equal(f.calls.filter(c=>c[0]==='create').length,1);}
});
test('routed receipts contain digests, protect uncertain claims and reject a reused grant under a new request ID',async()=>{
 const f=fixture();const handle=createSpotlightBridge(f.store);assert.equal((await handle(f.request,{id:PEER})).ok,true);
 const journal=Object.values(f.session).find(Array.isArray);assert.match(journal[0].fingerprint,/^[a-f0-9]{64}$/);assert(!JSON.stringify(journal).includes(f.request.source.url));assert(!JSON.stringify(journal).includes(f.request.source.token));
 assert.equal((await handle({...f.request,requestId:'new-id'},{id:PEER})).error.code,'INVALID_REQUEST');assert.equal(f.calls.filter(c=>c[0]==='create').length,1);
});
test('completed historical receipts do not impose a lifetime routed-open cap',async()=>{
 const f=fixture();f.session.spotlightBridgeRequests=Array.from({length:101},(_,i)=>({key:'old'+i,routed:true,createdAt:0,response:{ok:true},fingerprint:'old'}));
 assert.equal((await createSpotlightBridge(f.store)(f.request,{id:PEER})).ok,true);assert.equal(f.session.spotlightBridgeRequests.length,100);
});
test('malformed committed saved move remains blocked',async()=>{const f=fixture();f.local.spaceSavedMoveJournal={phase:'committed'};await assert.rejects(run(f));assert(!f.calls.some(c=>c[0]==='create'));});

test('unresolved routed claims survive journal pressure',async()=>{
 const f=fixture();f.session.spotlightBridgeRequests=[{key:'uncertain',routed:true,createdAt:0,fingerprint:'hash'},...Array.from({length:110},(_,i)=>({key:'done'+i,response:{ok:true}}))];
 assert.equal((await createSpotlightBridge(f.store)(f.request,{id:PEER})).ok,true);assert(f.session.spotlightBridgeRequests.some(entry=>entry.key==='uncertain'));
});
