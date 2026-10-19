import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { readFile } from 'node:fs/promises';
import { createNewTabWindowDrop } from '../../new-tab-window-drop.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(kind='live') {
    const {document,window}=parseHTML('<body><div id="pinnedFavicons"></div><div id="spacesList"><div class="space active" data-space-id="s"><div class="space-header">Space</div><div class="space-content"><div class="temporary-tabs"><div class="temp-header">Today</div><button id="newTabBtn" aria-label="New Tab" title="Open new tab"><span data-new-tab-label>New Tab</span></button><div class="tabs-container"><div class="tab dragging" data-tab-id="7"></div></div></div></div></div></div></body>');
    const button=document.getElementById('newTabBtn'),element=document.querySelector('.tab');
    let source={kind,element,tabId:7,windowId:10,spaceId:'s',bookmarkFolderId:'folder',bookmarkId:null,favoriteId:null,parentId:'folder'};
    if(kind==='bookmark'){element.dataset.bookmarkId='pin';source.bookmarkId='pin';}
    if(['saved','native'].includes(kind)){document.getElementById('pinnedFavicons').append(element);delete source.spaceId;delete source.bookmarkFolderId;if(kind==='saved'){source.favoriteId='fav';element.dataset.favoriteId='fav';}}
    const original=source,context={windowId:10,spaceId:'s',bookmarkFolderId:'folder'},calls=[],statuses=[];
    let selection=true,launches=0,consumes=0,read=async()=>({id:7,windowId:10,incognito:false}),response=async()=>({success:true});
    const controller=createNewTabWindowDrop({button,getContext:()=>context,inspectSource:()=>({source}),validateSelection:()=>selection,
        getTab:id=>read(id),sendRequest:async request=>{calls.push(request);return response();},showStatus:message=>statuses.push(message),
        consumeDrag:()=>{consumes++;source=null;element.classList.remove('dragging');}});
    button.addEventListener('click',()=>launches++);
    const event=(node,type,properties={})=>{const e=new window.Event(type,{bubbles:true,cancelable:true});Object.assign(e,{dataTransfer:{dropEffect:'none'},...properties});node.dispatchEvent(e);return e;};
    return{document,window,button,element,context,original,controller,calls,statuses,event,setSource:s=>source=s,setSelection:v=>selection=v,setRead:fn=>read=fn,setResponse:fn=>response=fn,counts:()=>({launches,consumes})};
}
for(const kind of ['live','bookmark','saved','native'])test(`single ${kind} drag sends only exact movement once and suppresses post-drop clicks`,async()=>{
 const f=fixture(kind);await f.controller.start();const before=f.button.outerHTML;
 const over=f.event(f.button,'dragover');assert.equal(over.dataTransfer.dropEffect,'move');assert.match(f.button.textContent,/Move to new window/);
 f.event(f.button,'dragleave');assert.equal(f.button.textContent,'New Tab');assert(!f.button.classList.contains('new-tab-window-hover'));
 f.event(f.button,'dragenter');assert.match(f.button.textContent,/Move to new window/);assert(f.button.classList.contains('new-tab-window-hover'));
 let ancestor=0;f.button.parentElement.addEventListener('drop',()=>ancestor++);
 f.event(f.button,'drop');const pending=f.controller.pending;f.event(f.button,'drop');f.event(f.button,'click');f.event(f.document,'dragend');await pending;
 assert.equal(ancestor,0);assert.equal(f.calls.length,1);assert.equal(f.counts().consumes,1);assert.equal(f.counts().launches,0);
 const expected={type:'moveTabToNewWindow',windowId:10,tabId:7,...(['saved','native'].includes(kind)?kind==='saved'?{favoriteId:'fav'}:{}:{spaceId:'s',bookmarkFolderId:'folder',...(kind==='bookmark'?{bookmarkId:'pin',parentId:'folder'}:{})})};assert.deepEqual(f.calls[0],expected);
 assert.equal(f.button.textContent,'New Tab');assert.equal(f.button.getAttribute('aria-busy'),'false');
 f.event(f.button,'click');assert.equal(f.counts().launches,0);f.event(f.button,'pointerdown');f.event(f.button,'click');assert.equal(f.counts().launches,1);
 assert.equal(f.button.querySelector('[data-new-tab-label]').tagName,'SPAN');assert(before.includes('data-new-tab-label'));
});
for(const kind of ['folder','bookmarks','closed'])test(`rejects ${kind} without move or sortable fallback`,async()=>{
 const f=fixture(kind);if(kind==='closed'){f.original.kind='bookmark';f.original.tabId=null;delete f.element.dataset.tabId;}
 await f.controller.start();const over=f.event(f.button,'dragover');assert.equal(over.dataTransfer.dropEffect,'none');
 f.event(f.button,'drop');await tick();assert.deepEqual(f.calls,[]);assert.equal(f.counts().consumes,0);assert.equal(f.button.textContent,'New Tab');
});
for(const cancel of ['dragend','Escape','blur','pagehide'])test(`${cancel} fences a late eligibility read and restores ordinary New Tab`,async()=>{
 const f=fixture();let release;f.setRead(()=>new Promise(resolve=>release=resolve));const preparing=f.controller.start();
 if(cancel==='Escape')f.event(f.document,'keydown',{key:'Escape'});else f.event(['blur','pagehide'].includes(cancel)?f.window:f.document,cancel);
 release({id:7,windowId:10});await preparing;f.event(f.button,'drop');await tick();assert.deepEqual(f.calls,[]);assert.equal(f.button.textContent,'New Tab');
});
for(const change of [f=>f.setSelection(false),f=>f.element.remove(),f=>f.element.dataset.tabId='8',f=>f.context.spaceId='other',f=>f.setRead(async()=>({id:7,windowId:11})),f=>f.setRead(async()=>({id:7,windowId:10,splitViewId:0}))])test('changed row, selection, window or native Split cannot dispatch',async()=>{
 const f=fixture();await f.controller.start();change(f);f.event(f.button,'drop');await f.controller.pending;assert.deepEqual(f.calls,[]);assert.equal(f.button.textContent,'New Tab');
});
test('Split cannot arm a target and external transfer text is never authority',async()=>{
 const f=fixture();f.setRead(async()=>({id:7,windowId:10,splitViewId:0}));await f.controller.start();assert.equal(f.button.dataset.windowDrag,undefined);
 f.setSource(null);f.event(f.button,'dragover',{dataTransfer:{getData:()=> '7'}});f.event(f.button,'drop');await tick();assert.deepEqual(f.calls,[]);
});
test('one uncertain movement has no replay/fallback; a new drag may be used later',async()=>{
 const f=fixture();f.setResponse(async()=>{throw Error('Response lost; inspect windows');});await f.controller.start();f.event(f.button,'drop');await f.controller.pending;
 assert.equal(f.calls.length,1);assert.match(f.statuses.at(-1),/Response lost/);assert.equal(f.button.textContent,'New Tab');
 f.setSource(f.original);f.element.classList.add('dragging');f.setResponse(async()=>({success:true}));await f.controller.start();f.event(f.button,'drop');await f.controller.pending;assert.equal(f.calls.length,2);
});
test('sticky geometry and theme states change neither padding nor row/icon dimensions',async()=>{
 const css=await readFile(new URL('../../styles.css',import.meta.url),'utf8');
 const row=css.slice(css.lastIndexOf('#newTabBtn {'));assert.match(row,/position: sticky; top: 0/);assert.match(row,/background: var\(--space-bg-color, #f0f0f0\)/);assert.match(row,/opacity: 1/);
 assert.match(row,/white-space: nowrap/);assert.match(row,/flex: 0 0 20px/);assert.match(row,/\.new-tab-window-hover \{ background: var\(--theme-selected-bg/);
 assert(!/window-hover[^}]*\b(?:padding|height|width|border-width):/.test(row));
 const source=await readFile(new URL('../../sidebar.js',import.meta.url),'utf8');assert.match(source,/void newTabWindowDrop.start\(\)/);assert.match(source,/validateSelection: source => !todaySelection.isBatch\(\)/);
});

test('cancelled eligible drag suppresses a trailing click but accepts the next deliberate New Tab gesture',async()=>{
 const f=fixture();await f.controller.start();f.event(f.button,'dragover');f.event(f.document,'keydown',{key:'Escape'});f.event(f.button,'click');
 assert.equal(f.counts().launches,0);assert.equal(f.button.textContent,'New Tab');assert.deepEqual(f.calls,[]);
 f.event(f.button,'keydown',{key:'Enter'});f.event(f.button,'click');assert.equal(f.counts().launches,1);
});

test('rejected hover with no native drop event cannot turn dragend into a New Tab click',async()=>{
 const f=fixture('folder');await f.controller.start();f.event(f.button,'dragover');f.event(f.document,'dragend');f.event(f.button,'click');
 assert.equal(f.counts().launches,0);assert.deepEqual(f.calls,[]);f.event(f.button,'pointerdown');f.event(f.button,'click');assert.equal(f.counts().launches,1);
});
