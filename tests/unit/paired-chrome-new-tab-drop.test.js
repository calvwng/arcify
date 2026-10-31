import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assertStickyNewTab, assertNoNewTabDropMutation, assertNativeNewTabDragCancelled, cancelNativeNewTabDrag, cancelHeldNewTabDrag } from '../../scripts/paired-chrome-new-tab-drop.mjs';
import { deriveSpaceTheme } from '../../sidebar-theme.js';

function geometry({stuck=false,drag=false}={}) {return{count:1,flowSlot:true,insideSortable:false,position:'sticky',opacity:1,pixels:[240,240,240,255],row:{x:8,y:stuck?100:140,width:280,height:40,bottom:stuck?140:180},port:{y:100},header:{bottom:84},favorites:{bottom:60},divider:{bottom:140},scrollTop:stuck?80:0,label:drag?'Move to new window':'New Tab',hover:drag,eligible:drag?'eligible':null,plus:drag?'none':'block',windowIcon:drag?'block':'none'};}
for(const stuck of [false,true])for(const drag of [false,true])test(`native sticky oracle accepts correct geometry stuck=${stuck} drag=${drag}`,()=>{
 assertStickyNewTab(geometry({stuck,drag}),{stuck,drag,baseline:geometry()});
});
test('native preview oracle requires label and icon before target entry with highlight reserved for hover',()=>{
 const preview=geometry({drag:true});preview.hover=false;
 assertStickyNewTab(preview,{drag:true,hovered:false,baseline:geometry()});
 const old=structuredClone(preview);old.label='New Tab';assert.throws(()=>assertStickyNewTab(old,{drag:true,hovered:false}));
 const premature=structuredClone(preview);premature.hover=true;assert.throws(()=>assertStickyNewTab(premature,{drag:true,hovered:false}));
});
for(const [name,change] of [
 ['transparent surface',s=>s.pixels[3]=180],['translucent busy state',s=>s.opacity=.7],['covering header',s=>s.header.bottom=120],['covering Favorites',s=>s.favorites.bottom=120],
 ['not sticky',s=>s.position='relative'],['floating above scrollport',s=>s.row.y=50],['stuck below edge',s=>s.row.y=110],['duplicate row',s=>s.count=2],['sortable child',s=>s.insideSortable=true],
 ['changed height',s=>s.row.height=56],['changed width',s=>s.row.width=260],['missing window icon',s=>s.windowIcon='none'],['old label',s=>s.label='New Tab']
])test(`native sticky evidence rejects ${name}`,()=>{
 const s=geometry({stuck:true,drag:true});change(s);assert.throws(()=>assertStickyNewTab(s,{stuck:true,drag:true,baseline:geometry()}));
});
test('cancel/stale oracle rejects any new window/page, reordering, binding or membership mutation',()=>{
 const before={tabs:[{id:7,windowId:10,index:0,url:'https://fixture.test',pinned:false,groupId:1}],windows:[{id:10}],bookmarks:[{id:'pin'}],pinBindings:{7:{bookmarkId:'pin'}},favorites:[{id:'fav'}],favoriteBindings:[{favoriteId:'fav',windowId:10,tabId:7}],spaces:[{id:'s',spaceBookmarks:[],temporaryTabs:[7]}]};
 assertNoNewTabDropMutation(before,structuredClone(before));
 for(const change of [s=>s.windows.push({id:20}),s=>s.tabs.push({id:9}),s=>s.tabs[0].index=1,s=>s.tabs[0].windowId=20,s=>s.pinBindings={},s=>s.favoriteBindings=[],s=>s.spaces[0].temporaryTabs=[]]){
  const after=structuredClone(before);change(after);assert.throws(()=>assertNoNewTabDropMutation(before,after));
 }
});
test('theme palette supplies solid surfaces/hover/selected colors for both modes and extreme tints',()=>{
 for(const mode of ['light','dark'])for(const tint of ['#000000','#ffffff','#ff00ff','#3564af']){
  const theme=deriveSpaceTheme(tint,mode);for(const key of ['surface','hover','selected','selectedText','border'])assert.match(theme[key],/^#[a-f\d]{6}$/i);
 }
});
test('hosted drag coverage is mandatory, uses real input without replay, and retains owned cleanup',async()=>{
 const source=await readFile(new URL('../../scripts/paired-chrome-new-tab-drop.mjs',import.meta.url),'utf8');
 const parent=await readFile(new URL('../../scripts/paired-chrome-move-window.mjs',import.meta.url),'utf8');
 assert.match(parent,/await exerciseStickyNewTabDrop/);assert(parent.indexOf('await exerciseStickyNewTabDrop')<parent.indexOf("const today=await create('ordinary')"));
 assert.match(source,/for\(const mode of \['light','dark'\]\)/);assert.match(source,/page.mouse.wheel/);assert.match(source,/page.mouse.down/);assert.match(source,/client.send\('Input.cancelDragging'\)/);assert.doesNotMatch(source,/page.keyboard.press\('Escape'\)/);
 assert.match(source,/await drag\(id,\{cancel:true\}\);await drag\(id,\{cancel:true\}\);await drag\(id\)/);
 assert.match(source,/await drag\(id,\{stale:true\}\)/);assert.match(source,/t.windowId!==sourceId/);assert.match(source,/assertMoved\(before,after/);
 assert.match(source,/e.type==='drop'&&e.trusted&&e.target/);assert.match(source,/ids.filter\(id=>live.has\(id\)\)/);
 assert.doesNotMatch(source,/dispatchEvent|setDragInterception|no-sandbox|setBypassCSP/);
 assert.match(source,/sticky-preview-before-target-entry/);
 assert(source.indexOf("observation('sticky-preview-before-target-entry'")<source.indexOf("'eligible sticky New Tab target'"));
});


const cancellation = () => ({ method:'Input.cancelDragging',acknowledged:true,mouseReleased:false,
 events:[{type:'dragstart',trusted:true,tabId:7},{type:'dragend',trusted:true,tabId:7,dropEffect:'none'}],
 draggingCount:0,row:{label:'New Tab',eligible:null,hover:false,busy:'false'} });
test('native cancellation oracle requires trusted exact-source end before release and no drop',()=>{
 assertNativeNewTabDragCancelled(cancellation(),{tabId:7});
});
for(const [name,change] of [
 ['keyboard Escape',e=>e.method='Input.dispatchKeyEvent'],['no acknowledgement',e=>e.acknowledged=false],['after release',e=>e.mouseReleased=true],
 ['no start',e=>e.events.shift()],['no native end',e=>e.events.pop()],['duplicate end',e=>e.events.push({...e.events[1]})],['wrong order',e=>e.events.reverse()],
 ['synthetic start',e=>e.events[0].trusted=false],['synthetic end',e=>e.events[1].trusted=false],['other source',e=>e.events[1].tabId=8],
 ['delivered drop',e=>e.events.splice(1,0,{type:'drop',trusted:true,target:true})],['successful drop effect',e=>e.events[1].dropEffect='move'],
 ['drag still held',e=>e.draggingCount=1],['move label',e=>e.row.label='Move to new window'],['armed target',e=>e.row.eligible='eligible'],
 ['stale hover',e=>e.row.hover=true],['mutation pending',e=>e.row.busy='true']
])test(`native cancellation evidence rejects ${name}`,()=>{
 const e=cancellation();change(e);assert.throws(()=>assertNativeNewTabDragCancelled(e,{tabId:7}));
});
test('supported cancellation records evidence before validation and never releases the mouse itself',async()=>{
 const calls=[],e=cancellation();const page={evaluate:async()=>{calls.push('read');return structuredClone(e);},mouse:{up:async()=>calls.push('release')}};
 const result=await cancelNativeNewTabDrag({page,client:{send:async command=>calls.push(command)},tabId:7,
  poll:async(read,accept)=>{calls.push('poll');const value=await read();assert(accept(value));return value;},
  checkpoint:async(phase,detail)=>{calls.push('record');assert.equal(phase,'native-cancel-before-release');assert.equal(detail.physicalEscapeAsserted,false);}});
 assert.deepEqual(calls,['Input.cancelDragging','poll','read','record']);assert.equal(result.mouseReleased,false);
});
test('a delivered drop is saved before the cancellation assertion fails',async()=>{
 const e=cancellation();e.events.splice(1,0,{type:'drop',trusted:true,target:true});let saved;
 await assert.rejects(cancelNativeNewTabDrag({page:{evaluate:async()=>e},client:{send:async()=>{}},tabId:7,
  poll:async(read,accept)=>{const value=await read();assert(accept(value));return value;},checkpoint:async(phase,detail)=>{saved=structuredClone(detail);}}),/never deliver a drop/);
 assert(saved.cancellation.events.some(event=>event.type==='drop'));
});
for(const [name,mutate,release] of [
 ['ack without end',e=>{e.events.pop();e.draggingCount=1;},false],['trusted end',()=>{},true],
 ['wrong source',e=>e.events[1].tabId=8,false],['synthetic end',e=>e.events[1].trusted=false,false],['drop delivered',e=>e.events.push({type:'drop'}),false]
])test(`held drag cleanup: ${name}`,async()=>{
 const calls=[],e=cancellation();mutate(e);
 await cancelHeldNewTabDrag({evaluate:async()=>e,mouse:{up:async()=>calls.push('mouse.up')}},{send:async command=>calls.push(command)},7);
 assert.deepEqual(calls,release?['Input.cancelDragging','mouse.up']:['Input.cancelDragging']);
});
test('failure diagnostics precede cleanup, strict mutation oracles remain and physical Escape is manual',async()=>{
 const source=await readFile(new URL('../../scripts/paired-chrome-new-tab-drop.mjs',import.meta.url),'utf8');
 assert.match(source,/favoriteDragInputClient\(page\)/);assert.doesNotMatch(source,/createCDPSession/);
 const diagnostic=source.indexOf("checkpoint('sticky-drag-failed-before-cleanup'");assert(diagnostic>0&&diagnostic<source.indexOf('}finally{',diagnostic));
 assert.match(source,/failure.dragEvidence=await page.evaluate/);assert.match(source,/failure.state=await raw\(\)/);
 assert.match(source,/assertNoNewTabDropMutation\(before,cancelledState\)/);assert.match(source,/assertNoNewTabDropMutation\(before,after\)/);
 assert.match(source,/Mouse release after cancellation must not deliver a late drop/);assert.match(source,/physicalEscapeAsserted:false/);
 const docs=await readFile(new URL('../../docs/move-to-new-window.md',import.meta.url),'utf8');assert.match(docs,/Physical Escape.*manual/);
});

function readyFixture(){return {geometry:{hosting:{tab:null,windowId:10},activeSpaceId:'s',activeSpaceIds:['s'],renderedTodayIds:[99,7,8],scrollHeight:700,clientHeight:400,row:{height:40}},raw:{tabs:[{id:7,windowId:10},{id:8,windowId:10}],spaces:[{id:'s',spaceBookmarks:[],temporaryTabs:[99,7,8]}]}};}
const readyRequest={ids:[7,8],spaceId:'s',windowId:10};
test('sticky readiness waits for asynchronous rendering without replaying fixture creation',async()=>{
 const {waitForStickyFixtureReady,assertStickyFixtureReady}=await import('../../scripts/paired-chrome-new-tab-drop.mjs');
 const delayed=readyFixture();delayed.geometry.renderedTodayIds=[99,7];
 const samples=[delayed,readyFixture()],observed=[];let reads=0;
 const result=await waitForStickyFixtureReady({read:async()=>samples[reads++],request:readyRequest,observe:s=>observed.push(s),
  poll:async(read,accept)=>{const first=await read();assert.equal(accept(first),false);const second=await read();assert.equal(accept(second),true);return second;}});
 assert.equal(reads,2);assert.equal(observed.length,2);assert.equal(assertStickyFixtureReady(result,readyRequest),result);
});
for(const [name,change] of [
 ['wrong Space',s=>s.geometry.activeSpaceId='other'],['multiple active Spaces',s=>s.geometry.activeSpaceIds.push('other')],
 ['wrong native host',s=>s.geometry.hosting.windowId=20],['tab-hosted page',s=>s.geometry.hosting.tab={id:55}],
 ['missing owned row',s=>s.geometry.renderedTodayIds.pop()],['duplicate owned row',s=>s.geometry.renderedTodayIds.push(7)],
 ['wrong native window',s=>s.raw.tabs[0].windowId=20],['wrong logical owner',s=>s.raw.spaces[0].id='other'],
 ['duplicate membership',s=>s.raw.spaces[0].temporaryTabs.push(7)],['saved rather than Today',s=>s.raw.spaces[0].spaceBookmarks.push(7)],
 ['insufficient overflow',s=>s.geometry.scrollHeight=480]
])test(`sticky readiness rejects ${name}`,async()=>{
 const {assertStickyFixtureReady,waitForStickyFixtureReady}=await import('../../scripts/paired-chrome-new-tab-drop.mjs');
 const sample=readyFixture();change(sample);assert.throws(()=>assertStickyFixtureReady(sample,readyRequest));let observed;
 await assert.rejects(waitForStickyFixtureReady({read:async()=>sample,request:readyRequest,observe:s=>{observed=s;},poll:async(read,accept)=>{assert.equal(accept(await read()),false);throw Error('bounded timeout');}}),/bounded timeout/);
 assert.equal(observed,sample,'Failed readiness retains the raw sample for pre-cleanup evidence');
});
test('sticky setup samples geometry once per observation and records original error before cleanup',async()=>{
 const source=await readFile(new URL('../../scripts/paired-chrome-new-tab-drop.mjs',import.meta.url),'utf8');
 assert.match(source,/for\(let i=0;i<36;i\+\+\)/);
 assert.doesNotMatch(source,/\(await geometry\(\)\)\.scrollHeight/);
 assert.match(source,/geometry:await geometry\(\),raw:await raw\(\)/);
 assert.match(source,/await checkpoint\('sticky-fixture-ready-before-validation'/);
 const failure=source.indexOf("checkpoint('sticky-fixture-failed-before-cleanup'");
 assert(failure>0&&failure<source.indexOf('finally{',failure));
 assert.match(source,/error:\{name:error.name,message:error.message,stack:error.stack\}/);
 assert.match(source,/failure.raw=await raw\(\)/);assert.match(source,/failure.geometry=await geometry\(\)/);
 assert.match(source,/request:\{ids,spaceId:space.id,windowId:sourceId\}/);
});
