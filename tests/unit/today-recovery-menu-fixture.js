import {connectRecoveryFixture} from './today-recovery-port-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseHTML } from 'linkedom';
import { createTodayTabSelection } from '../../today-tab-selection.js';
import { createTodaySpaceMoveAction } from '../../today-space-move-ui.js';
import { createTodaySplitUI } from '../../today-split-ui.js';
import { createContextMenuSession } from '../../context-menu-session.js';
import { EditSessionRegistry } from '../../edit-sessions.js';
import { RefreshCoordinator } from '../../refresh-coordinator.js';
import {fixture as backendFixture} from './today-recovery-fixture.js';
import {previewTodayRecovery,confirmTodayRecovery,registerTodayRecoveryMessages} from '../../today-recovery-store.js';
import {createBookmarkSelection} from '../../bookmark-selection.js';
import {createFavoritesStatus} from '../../favorites-status.js';
let showTabContextMenu,closeTabContextMenu;

const sidebar=await readFile(new URL('../../sidebar.js',import.meta.url),'utf8');
const menuBody=sidebar.slice(sidebar.indexOf('const openTabContextMenu = async'),sidebar.indexOf("    tabElement.addEventListener('contextmenu', openTabContextMenu)"));
const tick=()=>new Promise(resolve=>setImmediate(resolve));
export async function fixture({inverted=false,clicked=3,splitIds=[],invalidateOnClose=false,previewMode="normal",senderMode="normal",seven=false}={}){
 const backend=seven?await setupSeven({inverted}):await setup({inverted});const backendChrome=globalThis.chrome;
 const canonical=seven?[1,2,3,4,5,6,7]:[1,2,3];const ids=inverted?[...canonical].reverse():canonical;
 const {document,window}=parseHTML(`<html><body><div id="spacesList"><div class="space active" data-space-id="source"><div data-tab-type="temporary" data-today-order-inverted="${inverted}">${ids.map(id=>`<div class="tab" data-tab-id="${id}" data-url="https://tab-${id}.test/"><div class="tab-details"></div><button class="tab-close">Close</button></div>`).join('')}</div></div></div><div class="new-tab-btn-container"></div><button id="outside">Outside</button><div id="favoritesDropNotice" hidden><span id="favoritesDropStatus"></span><button id="favoritesDropDismiss">Dismiss</button></div></body></html>`);
 const previous={document:globalThis.document,window:globalThis.window,chrome:globalThis.chrome};Object.assign(globalThis,{document,window});
 ({showTabContextMenu,closeTabContextMenu}=await import('../../domManager.js'));
 let focus=document.body;Object.defineProperty(document,'activeElement',{get:()=>focus});window.HTMLElement.prototype.focus=function(){focus=this;};window.HTMLElement.prototype.getBoundingClientRect=()=>({width:250,height:200,left:0,bottom:20});
 const context={windowId:10,activeSpaceId:'source',spaces:backend.store.spaces};
 const native=backend.tabs;
 const row=id=>document.querySelector(`.tab[data-tab-id="${id}"]`),calls=[],statuses=[];

 const captures=[],submits=[],windowListeners=[],originalAdd=document.addEventListener.bind(document),originalRemove=document.removeEventListener.bind(document),create=document.createElement.bind(document);
 const addWindow=window.addEventListener.bind(window),removeWindow=window.removeEventListener.bind(window);
 window.addEventListener=(type,fn,options)=>{if(['blur','pagehide'].includes(type)){windowListeners.push({type,fn});return;}addWindow(type,fn,options);};
 window.removeEventListener=(type,fn,options)=>{if(['blur','pagehide'].includes(type)){const i=windowListeners.findIndex(x=>x.type===type&&x.fn===fn);if(i>=0)windowListeners.splice(i,1);return;}removeWindow(type,fn,options);};
 document.addEventListener=(type,fn,options)=>{if(options===true){captures.push({type,fn});return;}originalAdd(type,fn,options);};
 document.removeEventListener=(type,fn,options)=>{if(options===true){const i=captures.findIndex(x=>x.type===type&&x.fn===fn);if(i>=0)captures.splice(i,1);return;}originalRemove(type,fn,options);};
 document.createElement=tag=>{const element=create(tag);if(tag==='form'){const add=element.addEventListener.bind(element);element.addEventListener=(type,fn,...rest)=>{if(type==='submit')submits.push(fn);return add(type,fn,...rest);};}return element;};
 // LinkeDOM lacks capture semantics; invoke production document capture handlers
 // before target/bubble dispatch rather than accepting its reversed ordering.
 const event=(node,type,properties={})=>{const e=new window.Event(type,{bubbles:true,cancelable:true});Object.defineProperty(e,'isTrusted',{value:properties.trusted!==false});
  Object.assign(e,{button:0,...properties});Object.defineProperty(e,'target',{value:node,configurable:true});
  // LinkeDOM retargets window events to document. Dispatch these non-bubbling
  // lifecycle events to the real registered callbacks with browser target identity.
  if(node===window&&['blur','pagehide'].includes(type)){Object.defineProperty(e,'currentTarget',{value:window,configurable:true});for(const {type:t,fn} of [...windowListeners])if(t===type)fn(e);return e;}
  for(const {type:t,fn} of [...captures])if(t===type)fn(e);node.dispatchEvent(e);return e;};
 let selection;const bookmarks=createBookmarkSelection({document,getContext:()=>context,onGesture:()=>selection.clear()});
 selection=createTodayTabSelection({document,getContext:()=>context,onGesture:()=>bookmarks.clear()});
 const notice=createFavoritesStatus({document});const report=(value,preview=false,dismissible=true)=>{statuses.push(value);notice.show(value,{preview,dismissible});};
 const split=createTodaySplitUI({document,selection,getContext:()=>context,api:{tabs:{createSplit(){},unsplit(){}}},sendRequest:async request=>{calls.push(request);return{success:true};},showStatus:value=>statuses.push(value)});
 for(const id of ids){selection.register(row(id));split.register(row(id),native.find(tab=>tab.id===id));}
 const select=values=>{selection.clear();for(const id of values)event(row(id),'click',{ctrlKey:true});};
 let release;const tabRead=new Promise(resolve=>{release=()=>resolve(native.find(tab=>tab.id===clicked));});
 const sessions=new EditSessionRegistry();let paints=0,pendingMutations=0;
 const coordinator=new RefreshCoordinator({isBusy:()=>sessions.isActive()||pendingMutations>0,schedule:()=>null,cancel:()=>{},readSpaces:async()=>context.spaces,adoptSpaces:async()=>true,render:async()=>{
  paints++;for(const id of ids){const old=row(id),copy=old.cloneNode(true);selection.register(copy);old.replaceWith(copy);}selection.reconcile();return true;
 }});


 globalThis.chrome=backendChrome;
 // Captured native sidebar shape: documentId/tab can both be null.
 const sender={id:'test',url:'chrome-extension://test/sidebar.html',origin:'chrome-extension://test',documentId:null,tab:null,frameId:0,documentLifecycle:'active'};
 if(senderMode==='missing-document')sender.url='chrome-extension://test/options.html';
 Object.defineProperty(window,'top',{value:window,configurable:true});Object.defineProperty(window,'location',{value:{href:'chrome-extension://test/sidebar.html'},configurable:true});
 backendChrome.extension={inIncognitoContext:false};backendChrome.tabs.getCurrent=async()=>undefined;backendChrome.windows.getCurrent=async()=>({id:10,type:'normal',incognito:false,focused:true});
 let releasePreview;
 const ports=connectRecoveryFixture(backendChrome,{sender,requestHook:(envelope,deliver)=>{
  calls.push(envelope.request);
  if(previewMode==='held'&&envelope.request.type==='previewTodayRecovery'){const heldPort=ports.at(-1);releasePreview={reply:()=>{deliver();return Promise.resolve();},reject:()=>heldPort.server.disconnect()};return;}
  if(previewMode==='transport-error'){ports.at(-1).server.disconnect();return;}
  if(previewMode==='no-background'){ports.at(-1).server.postMessage({requestId:envelope.requestId,response:undefined});return;}
  queueMicrotask(deliver);
 },replyHook:reply=>{if(previewMode==='old-backend'&&reply.response?.preview)delete reply.response.preview.protocolVersion;if(previewMode==='malformed'&&reply.response?.preview)reply.response.preview.tabIds=[1];return reply;}});
 registerTodayRecoveryMessages(backend.store);
 const move=createTodaySpaceMoveAction({document,selection,getContext:()=>context,showStatus:report,sendRequest:()=>assert.fail('Recovery must use its bound Port'),
  begin:()=>{pendingMutations++;},end:()=>{pendingMutations--;coordinator.schedule();}});
 const deps={selectedTabClose:()=>null,document,window,tabMenuActions:{cancelEdit(){}},spaceContextMenu:{close(){}},closeTabContextMenu,createContextMenuSession:(...args)=>{const session=createContextMenuSession(...args);if(invalidateOnClose)session.onClose(()=>selection.clear());return session;},
  tabElement:row(clicked),tab:native.find(tab=>tab.id===clicked),isPinned:false,isBookmarkOnly:false,todaySelection:selection,bookmarkSelection:bookmarks,
  todaySplit:split,moveTodaySelection:move,pendingActiveSpaceId:null,showFavoritesStatus:report,chrome:{tabs:{get:()=>tabRead}},
  actionsForTabRow:(element,options)=>({selectionCount:options.selectionCount}),showTabContextMenu,closeTab(){},spaces:context.spaces,
  moveTabToSpace:()=>assert.fail('No singleton legacy move'),setActiveSpace:()=>assert.fail('No Space activation'),createSpaceFromInactive:()=>assert.fail('No new Space'),saveTodaySelection(){},editorSessions:sessions};
 const open=new Function('deps',`const {${Object.keys(deps).join(',')}}=deps;let tabContextMenuRequest=0;${menuBody};return openTabContextMenu;`)(deps);
 let opening;deps.tabElement.addEventListener('contextmenu',event=>{opening=open(event);});
 return{backend,ports,sender,submits,captures,pendingMutations:()=>pendingMutations,releasePreview:()=>releasePreview,notice:()=>document.getElementById('favoritesDropStatus').textContent,document,window,context,native,row,event,select,selection,split,calls,statuses,sessions,coordinator,release,paints:()=>paints,
  open:()=>{event(deps.tabElement,'contextmenu',{pageX:0,pageY:0});return opening;},cleanup:async()=>{closeTabContextMenu();await tick();Object.assign(globalThis,previous);}};
}
async function setup({inverted=false}={}){
 const f=backendFixture({inverted});f.tabs.forEach(t=>t.url=`https://tab-${t.id}.test/`);f.request.entries=f.request.entries.map(e=>({tabId:e.tabId,url:`https://tab-${e.tabId}.test/`}));
 f.request={...f.request,type:'previewTodayRecovery'};delete f.request.destinationSpaceId;delete f.request.destinationBookmarkFolderId;
 f.store.windowKeys=new Map([[10,'current'],[20,'other']]);f.store.restoreWindowKeys=new Map([[10,'current']]);
 f.store.recoveryCandidates.add(3);f.store.restoreQueue=[{tabId:200,spaceId:'source',section:'temporaryTabs',url:'https://tab-3.test/',windowKey:'historical',tabIndex:2,order:2},
  {tabId:201,spaceId:'target',section:'spaceBookmarks',url:'https://unrelated-saved.test/',windowKey:'other-old',order:0,pinnedState:{bookmarkId:'keep'},nameOverride:{name:'Keep'}}];
 f.store.savedWindows=[{key:'current',tabs:f.tabs.filter(t=>t.windowId===10)},{key:'historical',tabs:[]},{key:'other-old',tabs:[]}];
 await f.store.persist();f.effects.length=0;
 f.preview=()=>previewTodayRecovery(f.store,f.request);f.confirm=p=>confirmTodayRecovery(f.store,{type:'confirmTodayRecovery',token:p.token,confirmCurrentMembership:true});return f;
}

export {setup};

export async function setupSeven({inverted=false}={}){
 const f=await setup({inverted});
 f.tabs.splice(0,f.tabs.length,...Array.from({length:7},(_,i)=>({id:i+1,index:i,windowId:10,url:`https://tab-${i+1}.test/`,pinned:false,incognito:false,groupId:-1,splitViewId:-1})));
 f.store.spaces[0].temporaryTabs=[1,2,3,4,5,6,7];f.store.spaces[0].spaceBookmarks=[];f.store.spaces[1].temporaryTabs=[];
 f.store.liveTabs=new Map(f.tabs.map(t=>[t.id,t]));f.local.pinnedTabStatesById={};f.local.tabNameOverridesById={};
 f.store.recoveryCandidates=new Set([2,3,4,5,6,7]);f.store.provisional=new Set();f.store.restoredRanks=new Map(f.tabs.map(t=>[t.id,t.index]));
 f.store.restoreQueue=f.tabs.slice(1).map(t=>({tabId:100+t.id,spaceId:'source',section:'temporaryTabs',order:t.index,url:t.url,windowKey:'key2',tabIndex:t.index}));
 f.store.windowKeys=new Map([[10,'key1']]);f.store.restoreWindowKeys=new Map([[10,'key1']]);
 f.store.savedWindows=[{key:'key1',tabs:f.tabs.map(t=>({index:t.index,url:t.url,pinned:false}))},{key:'key2',tabs:[{index:0,url:'https://historical-anchor.test/',pinned:false},...f.tabs.slice(1).map(t=>({index:t.index,url:t.url,pinned:false}))]}];
 f.request={type:'previewTodayRecovery',windowId:10,spaceId:'source',bookmarkFolderId:'source-root',inverted,entries:(inverted?[...f.tabs].reverse():f.tabs).map(t=>({tabId:t.id,url:t.url}))};
 await f.store.persist();f.effects.length=0;return f;
}

