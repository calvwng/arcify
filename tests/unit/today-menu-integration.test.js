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
import { moveTodayTabsToSpace } from '../../today-move-store.js';
let showTabContextMenu,closeTabContextMenu;

const sidebar=await readFile(new URL('../../sidebar.js',import.meta.url),'utf8');
const menuBody=sidebar.slice(sidebar.indexOf('const openTabContextMenu = async'),sidebar.indexOf("    tabElement.addEventListener('contextmenu', openTabContextMenu)"));
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture({inverted=false,clicked=3,splitIds=[],invalidateOnClose=false}={}){
 const ids=inverted?[3,2,1]:[1,2,3];
 const {document,window}=parseHTML(`<html><body><div id="spacesList"><div class="space active" data-space-id="source"><div data-tab-type="temporary" data-today-order-inverted="${inverted}">${ids.map(id=>`<div class="tab" data-tab-id="${id}" data-url="https://same.test/"><div class="tab-details"></div><button class="tab-close">Close</button></div>`).join('')}</div></div></div><div class="new-tab-btn-container"></div><button id="outside">Outside</button></body></html>`);
 const previous={document:globalThis.document,window:globalThis.window,chrome:globalThis.chrome};Object.assign(globalThis,{document,window});
 ({showTabContextMenu,closeTabContextMenu}=await import('../../domManager.js'));
 let focus=document.body;Object.defineProperty(document,'activeElement',{get:()=>focus});window.HTMLElement.prototype.focus=function(){focus=this;};window.HTMLElement.prototype.getBoundingClientRect=()=>({width:250,height:200,left:0,bottom:20});
 const context={windowId:10,activeSpaceId:'source',spaces:[{id:'source',bookmarkFolderId:'root',temporaryTabs:[1,2,3],spaceBookmarks:[]},{id:'target',name:'Target',bookmarkFolderId:'dest',temporaryTabs:[8],spaceBookmarks:[]}]};
 const native=[1,2,3,8].map((id,index)=>({id,index,windowId:10,url:'https://same.test/',pinned:false,groupId:-1,splitViewId:splitIds.includes(id)?4:-1,active:id===2}));
 const row=id=>document.querySelector(`.tab[data-tab-id="${id}"]`),calls=[],statuses=[];
 const event=(node,type,properties={})=>{const e=new window.Event(type,{bubbles:true,cancelable:true});Object.assign(e,{button:0,...properties});node.dispatchEvent(e);return e;};
 const selection=createTodayTabSelection({document,getContext:()=>context});
 const split=createTodaySplitUI({document,selection,getContext:()=>context,api:{tabs:{createSplit(){},unsplit(){}}},sendRequest:async request=>{calls.push(request);return{success:true};},showStatus:value=>statuses.push(value)});
 for(const id of ids){selection.register(row(id));split.register(row(id),native.find(tab=>tab.id===id));}
 const select=values=>{selection.clear();for(const id of values)event(row(id),'click',{ctrlKey:true});};
 let release;const tabRead=new Promise(resolve=>{release=()=>resolve(native.find(tab=>tab.id===clicked));});
 const sessions=new EditSessionRegistry();let paints=0;
 const coordinator=new RefreshCoordinator({isBusy:()=>sessions.isActive(),schedule:()=>null,cancel:()=>{},readSpaces:async()=>context.spaces,adoptSpaces:async()=>true,render:async()=>{
  paints++;for(const id of ids){const old=row(id),copy=old.cloneNode(true);selection.register(copy);old.replaceWith(copy);}selection.reconcile();return true;
 }});
 const forbidden=()=>assert.fail('Menu move cannot create, close, navigate, activate, pin, regroup or rewindow a native page.');
 globalThis.chrome={runtime:{getURL:path=>`chrome-extension://fixture/${path}`},
  tabs:{query:async()=>structuredClone(native),create:forbidden,remove:forbidden,update:forbidden,move:forbidden,group:forbidden,ungroup:forbidden},
  windows:{get:async id=>({id,type:'normal',incognito:false}),update:forbidden,create:forbidden},
  bookmarks:{get:async id=>[{id,parentId:'arcify',title:id}],search:async()=>[{id:'arcify',title:'Arcify'}],create:forbidden,move:forbidden,remove:forbidden},
  storage:{local:{get:async()=>({pinnedTabStatesById:{},todayOrderRepresentation:{version:1,inverted}})}}};
 const store={run:operation=>operation(),spaces:context.spaces,active:{10:'source'},restoredRanks:new Map(),restoreQueue:[],
  rebaseSectionRanks(){},async persist({beforeWrite}){await beforeWrite();}};
 const move=createTodaySpaceMoveAction({selection,getContext:()=>context,showStatus:value=>statuses.push(value),sendRequest:async request=>{
  calls.push(request);
  try{const batch=await moveTodayTabsToSpace(store,request);context.spaces=store.spaces;return{success:true,batch};}
  catch(error){return{success:false,error:error.message,...(error.batch?{batch:error.batch}:{})};}
 }});
 const deps={document,window,tabMenuActions:{cancelEdit(){}},spaceContextMenu:{close(){}},closeTabContextMenu,createContextMenuSession:(...args)=>{const session=createContextMenuSession(...args);if(invalidateOnClose)session.onClose(()=>selection.clear());return session;},
  tabElement:row(clicked),tab:native.find(tab=>tab.id===clicked),isPinned:false,isBookmarkOnly:false,todaySelection:selection,bookmarkSelection:{clear(){}},
  todaySplit:split,moveTodaySelection:move,pendingActiveSpaceId:null,showFavoritesStatus:value=>statuses.push(value),chrome:{tabs:{get:()=>tabRead}},
  actionsForTabRow:(element,options)=>({selectionCount:options.selectionCount}),showTabContextMenu,closeTab(){},spaces:context.spaces,
  moveTabToSpace:()=>assert.fail('No singleton legacy move'),setActiveSpace:()=>assert.fail('No Space activation'),createSpaceFromInactive:()=>assert.fail('No new Space'),saveTodaySelection(){},editorSessions:sessions};
 const open=new Function('deps',`const {${Object.keys(deps).join(',')}}=deps;let tabContextMenuRequest=0;${menuBody};return openTabContextMenu;`)(deps);
 return{document,window,context,native,row,event,select,selection,split,calls,statuses,sessions,coordinator,release,paints:()=>paints,
  open:()=>open({preventDefault(){},stopPropagation(){},pageX:0,pageY:0}),cleanup:async()=>{closeTabContextMenu();await tick();Object.assign(globalThis,previous);}};
}
for(const inverted of [false,true])test(`complete Today context menu moves selected batch in display order (inverted=${inverted})`,async()=>{
 const f=await fixture({inverted});try{f.select([3,1]);const before=structuredClone(f.native);const opening=f.open();f.release();await opening;
 f.event(f.document.querySelector('[data-action="moveTodayTabsToSpace"]'),'click');f.event(f.document.querySelector('[data-action="moveTodayToDestination"]'),'click');await tick();
 assert.deepEqual(f.calls.map(call=>call.entries.map(entry=>entry.tabId)),[inverted?[3,1]:[1,3]]);assert.deepEqual(f.context.spaces[0].temporaryTabs,[2]);assert.deepEqual(f.context.spaces[1].temporaryTabs,[...inverted?[1,3,8]:[8,1,3]]);assert.deepEqual(f.native,before);assert.equal(f.context.activeSpaceId,'source');
 }finally{await f.cleanup();}
});
test('preparing selected Today menu holds incidental repaint before asynchronous clicked-tab lookup',async()=>{
 const f=await fixture();try{f.select([1,3]);const opening=f.open();assert(f.sessions.isActive(),'Exact batch needs a hold before the asynchronous read.');
 f.coordinator.invalidateSpaces();await f.coordinator.drain();assert.equal(f.paints(),0);f.release();await opening;
 assert(f.document.querySelector('[data-action="moveTodayTabsToSpace"]'));closeTabContextMenu();await tick();assert(!f.sessions.isActive());
 }finally{await f.cleanup();}
});
for(const change of ['navigation','selection','blur','Escape'])test(`pending menu ${change} never dispatches or leaks its hold`,async()=>{
 const f=await fixture();try{f.select([1,3]);const opening=f.open();if(change==='navigation')f.row(1).dataset.url='https://changed.test/';if(change==='selection')f.select([2]);if(change==='blur')f.event(f.window,'blur');if(change==='Escape')f.event(f.document,'keydown',{key:'Escape'});f.release();await opening;await tick();
 assert.equal(f.document.getElementById('tab-context-menu'),null);assert.deepEqual(f.calls,[]);assert(!f.sessions.isActive());
 }finally{await f.cleanup();}
});
test('mixed native Split selection explains why the entire Move action is unavailable',async()=>{
 const f=await fixture({splitIds:[1]});try{f.select([1,3]);const opening=f.open();f.release();await opening;
 assert.equal(f.document.querySelector('[data-action="moveTodayTabsToSpace"]'),null);const hint=f.document.querySelector('[data-action="todayMoveHint"]');assert(hint);assert.match(hint.textContent,/End Split View/);assert.deepEqual(f.calls,[]);
 }finally{await f.cleanup();}
});
test('right-clicking an unselected row scopes the menu to that row, without moving the old batch',async()=>{
 const f=await fixture();try{f.select([1,2]);const opening=f.open();f.release();await opening;
 f.event(f.document.querySelector('[data-action="moveTodayTabsToSpace"]'),'click');f.event(f.document.querySelector('[data-action="moveTodayToDestination"]'),'click');await tick();
 assert.deepEqual(f.calls[0].entries.map(entry=>entry.tabId),[3]);assert.deepEqual(f.context.spaces[0].temporaryTabs,[1,2]);assert.deepEqual(f.context.spaces[1].temporaryTabs,[8,3]);
 }finally{await f.cleanup();}
});
test('changing the frozen batch after opening the destination picker refuses the entire action',async()=>{
 const f=await fixture();try{f.select([1,3]);const opening=f.open();f.release();await opening;
 f.event(f.document.querySelector('[data-action="moveTodayTabsToSpace"]'),'click');const stale=f.document.querySelector('[data-action="moveTodayToDestination"]');f.row(1).dataset.url='https://changed.test/';f.event(stale,'click');await tick();
 assert.deepEqual(f.calls,[]);assert.deepEqual(f.context.spaces[0].temporaryTabs,[1,2,3]);assert.deepEqual(f.context.spaces[1].temporaryTabs,[8]);assert.match(f.statuses.at(-1),/Nothing was moved/);assert(!f.sessions.isActive());
 }finally{await f.cleanup();}
});
test('a superseding menu cancels pending preparation and releases both holds once dismissed',async()=>{
 const f=await fixture();try{f.select([1,3]);const first=f.open(),second=f.open();f.release();await Promise.all([first,second]);await tick();assert.equal(f.document.querySelectorAll('#tab-context-menu').length,1);assert.equal(f.sessions.sessions.size,1);closeTabContextMenu();await tick();assert.equal(f.sessions.sessions.size,0);assert.deepEqual(f.calls,[]);
 }finally{await f.cleanup();}
});

test('destination starts guarded exact batch before close hooks can invalidate selection', async () => {
 const f=await fixture({invalidateOnClose:true});try {
  f.select([1,3]);const opening=f.open();f.release();await opening;
  f.event(f.document.querySelector('[data-action="moveTodayTabsToSpace"]'),'click');
  f.event(f.document.querySelector('[data-action="moveTodayToDestination"]'),'click');await tick();
  assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0].entries.map(entry=>entry.tabId),[1,3]);
  assert.deepEqual(f.context.spaces[0].temporaryTabs,[2]);assert.deepEqual(f.context.spaces[1].temporaryTabs,[8,1,3]);
  assert.equal(f.document.getElementById('tab-context-menu'),null);assert(!f.sessions.isActive());
 }finally{await f.cleanup();}
});

for (const mode of ['pointer','keyboard']) test(`rendered destination ${mode} activation moves selected Today batch exactly once`, async () => {
 const f=await fixture();try {
  f.select([1,3]);const opening=f.open();f.release();await opening;
  const activate=node=>{if(mode==='keyboard'){f.event(node,'keydown',{key:'Enter'});return;}
   for(const type of ['pointerdown','mousedown'])f.event(node,type);node.focus();
   for(const type of ['pointerup','mouseup','click'])f.event(node,type);
  };
  activate(f.document.querySelector('[data-action="moveTodayTabsToSpace"]'));
  const choice=f.document.querySelector('[data-action="moveTodayToDestination"]');assert(choice);
  activate(choice);f.event(choice,'click');await tick();
  assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0].entries.map(entry=>entry.tabId),[1,3]);
  assert.deepEqual(f.context.spaces[0].temporaryTabs,[2]);assert.deepEqual(f.context.spaces[1].temporaryTabs,[8,1,3]);
  assert.equal(f.context.activeSpaceId,'source');assert.match(f.statuses.at(-1),/Moved 2 tabs/);
 }finally{await f.cleanup();}
});
