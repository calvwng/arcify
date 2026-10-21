import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { cleanupMoveWindowFavorites, recordMoveWindowCleanup } from '../../scripts/paired-chrome-move-window.mjs';
import { finishBookmarkFixture } from '../../scripts/paired-chrome-bookmark-selection.mjs';
import { assertFallbackSearch, replaceFallbackPeer, assertFallbackNavigation } from '../../scripts/paired-chrome-bookmark-fallback.mjs';

const sidebarUrl='chrome-extension://fixture/sidebar.html';
const request={windowId:10,sidebarUrl,favoriteId:'exact',url:'https://fixture.test/nonce/away'};
async function withChrome(current,send,operation){
 const previous=globalThis.chrome;
 globalThis.chrome={tabs:{getCurrent:async()=>current},runtime:{sendMessage:send}};
 try{return await operation();}finally{if(previous===undefined)delete globalThis.chrome;else globalThis.chrome=previous;}
}
test('move cleanup uses verified window-owned Sidebar and only exact fixture Favorites',async()=>{
 const calls=[];
 const result=await withChrome({id:9,windowId:10,url:sidebarUrl},async message=>{
  calls.push(message);return message.action==='get'?{success:true,favorites:[{id:'exact',url:'https://changed.test/'},{id:'nonce',url:request.url},{id:'other',url:'https://unrelated.test/'}]}:{success:true};
 },()=>cleanupMoveWindowFavorites(request));
 assert.deepEqual(result,{senderTabId:9,windowId:10,removed:['exact','nonce']});
 assert.deepEqual(calls,[{type:'favoriteStore',action:'get',windowId:10},...['exact','nonce'].map(favoriteId=>({type:'favoriteStore',action:'remove',favoriteId,windowId:10}))]);
});
for(const [label,current] of [['Options page',{id:9,windowId:10,url:'chrome-extension://fixture/options.html'}],['wrong window',{id:9,windowId:20,url:sidebarUrl}],['native-less Options',null]])test(`move cleanup refuses ${label} before dispatch`,async()=>{
 let calls=0;await withChrome(current,async()=>{calls++;},()=>assert.rejects(cleanupMoveWindowFavorites(request),/exact window-owned Sidebar/));assert.equal(calls,0);
});
for(const action of ['get','remove'])test(`move cleanup preserves ${action} guard rejection`,async()=>{
 await withChrome({id:9,windowId:10,url:sidebarUrl},async message=>message.action===action?{success:false,error:'Invalid Favorites sender.'}:{success:true,favorites:[{id:'exact'}]},()=>assert.rejects(cleanupMoveWindowFavorites(request),/Invalid Favorites sender/));
});
test('cleanup failure appends to move evidence without losing native operation checkpoints',async()=>{
 const evidence={nonce:'owned',checkpoints:[{phase:'last-tab',tabId:7,before:{id:7},after:{id:7}}],screenshots:['native.png']},records=[];
 const original=structuredClone(evidence);let later=false;
 await assert.rejects(finishBookmarkFixture([async()=>{throw Error('cleanup failed');},async()=>{later=true;}],null,detail=>recordMoveWindowCleanup(evidence,detail,async value=>records.push(value))),/cleanup failed/);
 assert(later);assert.deepEqual(evidence.checkpoints,original.checkpoints);assert.deepEqual(evidence.screenshots,original.screenshots);
 assert.deepEqual(evidence.cleanup,[{phase:'cleanup-failed',errors:['cleanup failed']}]);assert.deepEqual(records,[evidence]);
 records[0].checkpoints.length=0;assert.equal(evidence.checkpoints.length,1,'Stored snapshots cannot mutate operation evidence.');
});
test('primary move failure survives cleanup failure and both receipts remain available',async()=>{
 const error=Error('native assertion failed'),evidence={checkpoints:[{phase:'failed',message:error.message}]};
 await finishBookmarkFixture([async()=>{throw Error('cleanup rejected');}],error,detail=>recordMoveWindowCleanup(evidence,detail,async()=>{}));
 assert.equal(error.message,'native assertion failed');assert.deepEqual(error.cleanupErrors,['cleanup rejected']);assert.equal(evidence.checkpoints[0].phase,'failed');assert.equal(evidence.cleanup.length,1);
});
function fallback(unavailable=false){return {input:{value:'Probe',focused:true},state:'bookmark-fallback',status:`Saved-bookmark fallback (ready). ${unavailable?'Arcify connection unavailable':'Standalone navigation'}`,rows:['Probe First','Probe Second'].map(title=>({type:'bookmark',title,text:`${title} Saved bookmarks: Arcify / Fixture / ${title}`,selected:false}))};}
for(const previous of ['', 'a'.repeat(32), 'b'.repeat(32)])test(`fallback restoration replaces a prefilled peer (${previous.length} chars)`,async()=>{
 const node={value:previous},calls=[];const field={evaluate:async read=>read(node),dispose:async()=>calls.push('dispose')};
 const page={waitForSelector:async selector=>{assert.equal(selector,'#peer:not([disabled])');return field;}};
 await replaceFallbackPeer(page,'#peer','a'.repeat(32),async(page,label,action)=>action(),async(page,field,value)=>{calls.push('replace');node.value=value;});
 assert.equal(node.value,'a'.repeat(32));assert.deepEqual(calls,['replace','dispose']);
});
function navigation(){const before=[{id:7,windowId:10,url:'chrome-extension://fixture/newtab.html',pinned:false,active:true,status:'complete'},{id:8,windowId:20,url:'https://retained.test/',pinned:true,status:'complete'}];const after=structuredClone(before);after[0].url='https://fixture.test/';return {before,after,target:{helperTabId:7,url:'https://fixture.test/',windowId:10}};}
test('ordinary fallback Enter navigates its exact helper tab without creating a replacement',()=>{
 const f=navigation();assert.equal(assertFallbackNavigation(f.before,f.after,f.target).id,7);
});
for(const [label,change] of [['replacement',f=>f.after[0].id=9],['extra new tab',f=>f.after.push({...f.after[0],id:9})],['other page changed',f=>f.after[1].url='https://changed.test/'],['wrong window',f=>f.after[0].windowId=20],['not loaded',f=>f.after[0].status='loading'],['wrong target',f=>f.after[0].url='https://wrong.test/']])test(`fallback navigation rejects ${label}`,()=>{const f=navigation();change(f);assert.throws(()=>assertFallbackNavigation(f.before,f.after,f.target));});
for(const unavailable of [false,true])test(`hosted fallback oracle accepts real typed distinct saved rows unavailable=${unavailable}`,()=>assertFallbackSearch(fallback(unavailable),{query:'Probe',titles:['Probe First','Probe Second'],unavailable}));
for(const [label,change] of [['lost query',e=>e.input.value='Preview'],['lost focus',e=>e.input.focused=false],['passive connection overwrite',e=>e.state='pending'],['no limitation',e=>e.status='Connected'],['collapsed duplicate',e=>e.rows.pop()],['missing saved path',e=>e.rows[0].text='Probe First'],['pretend Space',e=>e.rows.push({type:'arcify-space'})]])test(`fallback evidence rejects ${label}`,()=>{
 const e=fallback();change(e);assert.throws(()=>assertFallbackSearch(e,{query:'Probe',titles:['Probe First','Probe Second'],unavailable:false}));
});
test('hosted wiring requires actual input and retains authenticated sender and all original move barriers',async()=>{
 const smoke=await readFile(new URL('../../scripts/paired-chrome-smoke.mjs',import.meta.url),'utf8');
 const move=await readFile(new URL('../../scripts/paired-chrome-move-window.mjs',import.meta.url),'utf8');
 const fallback=await readFile(new URL('../../scripts/paired-chrome-bookmark-fallback.mjs',import.meta.url),'utf8');
 assert.match(smoke,/await exerciseBookmarkFallback/);assert.match(smoke,/report.bookmarkFallback=observation/);
 assert.match(move,/newTabPage\(sidebarUrl,fixture.windowA\)/);assert.match(move,/cleanupSource.page.evaluate\(cleanupMoveWindowFavorites/);
 assert.doesNotMatch(move,/apiPage.evaluate\(\(\{favoriteId,windowId\}\)=>chrome.runtime.sendMessage/);
 assert.match(move,/detail=>recordMoveWindowCleanup\(evidence,detail,record\)/);assert.match(move,/await exerciseStickyNewTabDrop/);assert.match(move,/last:true/);assert.match(move,/assertMovedWindowPage\(before,after/);
 assert.match(fallback,/for\(const unavailable of \[false,true\]\)/);assert.match(fallback,/await search\(helper.page,token\)/);assert.match(fallback,/selectResultWithKeyboard/);assert.match(fallback,/press\('Enter'\)/);
 assert.match(fallback,/assert.deepEqual\(await bookmarks\(\),originalBookmarks\)/);assert.match(fallback,/reconnect/);
 assert.doesNotMatch(fallback,/dispatchEvent|spotlightHandleResult|setBypassCSP|no-sandbox/);
});
