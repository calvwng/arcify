import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assertStickyNewTab, assertNoNewTabDropMutation } from '../../scripts/paired-chrome-new-tab-drop.mjs';
import { deriveSpaceTheme } from '../../sidebar-theme.js';

function geometry({stuck=false,drag=false}={}) {return{count:1,flowSlot:true,insideSortable:false,position:'sticky',opacity:1,pixels:[240,240,240,255],row:{x:8,y:stuck?100:140,width:280,height:40,bottom:stuck?140:180},port:{y:100},header:{bottom:84},favorites:{bottom:60},divider:{bottom:140},scrollTop:stuck?80:0,label:drag?'Move to new window':'New Tab',hover:drag,eligible:drag?'eligible':null,plus:drag?'none':'block',windowIcon:drag?'block':'none'};}
for(const stuck of [false,true])for(const drag of [false,true])test(`native sticky oracle accepts correct geometry stuck=${stuck} drag=${drag}`,()=>{
 assertStickyNewTab(geometry({stuck,drag}),{stuck,drag,baseline:geometry()});
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
 assert.match(source,/for\(const mode of \['light','dark'\]\)/);assert.match(source,/page.mouse.wheel/);assert.match(source,/page.mouse.down/);assert.match(source,/page.keyboard.press\('Escape'\)/);
 assert.match(source,/await drag\(id,\{cancel:true\}\);await drag\(id,\{cancel:true\}\);await drag\(id\)/);
 assert.match(source,/await drag\(id,\{stale:true\}\)/);assert.match(source,/t.windowId!==sourceId/);assert.match(source,/assertMoved\(before,after/);
 assert.match(source,/e.type==='drop'&&e.trusted&&e.target/);assert.match(source,/ids.filter\(id=>live.has\(id\)\)/);
 assert.doesNotMatch(source,/dispatchEvent|setDragInterception|no-sandbox|setBypassCSP/);
});
