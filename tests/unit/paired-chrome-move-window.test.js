import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assertMovedWindowPage, invokeWindowMoveOnce } from '../../scripts/paired-chrome-move-window.mjs';

function fixture({saved=false,favorite=false,last=false}={}) {
 const before={tabs:[{id:7,windowId:10,url:'https://fixture.test',pinned:favorite,incognito:false},...(!last?[{id:8,windowId:10,url:'https://twin.test'}]:[])],windows:[{id:10}],page:{documentId:'nonce',value:'typed-kept'},bookmarks:[{id:'pin',parentId:'folder',url:'https://fixture.test'}],pinBindings:saved?{7:{bookmarkId:'pin'}}:{},favorites:favorite?[{id:'fav',url:'https://fixture.test'}]:[],favoriteBindings:favorite?[{favoriteId:'fav',windowId:10,tabId:7}]:[],spaces:[{id:'s',spaceBookmarks:saved?[7]:[],temporaryTabs:!saved&&!favorite?[7]:[]}]};
 const after=structuredClone(before);after.tabs[0].windowId=20;after.windows=last?[{id:20}]:[{id:10},{id:20}];if(favorite)after.favoriteBindings[0].windowId=20;
 after.source={tabs:after.tabs.filter(t=>t.windowId===10)};after.destination={activeSpaceId:'s',tabs:[after.tabs[0]]};
 const target={tabId:7,sourceWindowId:10,...(!favorite?{spaceId:'s',section:saved?'spaceBookmarks':'temporaryTabs'}:{}),...(saved?{bookmarkId:'pin'}:{}),...(favorite?{favoriteId:'fav'}:{}),last};
 return{before,after,target};
}
for(const options of [{},{saved:true},{favorite:true},{last:true}])test(`hosted oracle accepts exact native move ${JSON.stringify(options)}`,()=>{
 const f=fixture(options);assert.equal(assertMovedWindowPage(f.before,f.after,f.target),20);
});
for(const [label,change] of [
 ['recreated tab',f=>f.after.tabs[0].id=9],['same URL reopened',f=>f.after.page.documentId='replacement'],['lost input',f=>f.after.page.value='untouched'],
 ['wrong membership',f=>f.after.spaces[0].temporaryTabs=[]],['wrong destination Space',f=>f.after.destination.activeSpaceId='other'],
 ['missing source destruction',f=>f.after.windows.push({id:10})],['extra page',f=>f.after.tabs.push({id:99})],['moved sibling',f=>f.after.tabs[1].windowId=20]
])test(`hosted evidence refuses ${label}`,()=>{
 const f=fixture({last:label==='missing source destruction'});change(f);assert.throws(()=>assertMovedWindowPage(f.before,f.after,f.target));
});
test('hosted evidence refuses pin/Favorite association loss',()=>{
 for(const saved of [true,false]){const f=fixture({saved,favorite:!saved});if(saved)f.after.pinBindings={};else f.after.favoriteBindings=[];assert.throws(()=>assertMovedWindowPage(f.before,f.after,f.target));}
});
test('hosted case is mandatory in existing full tab-menu step and preserves launch guards',async()=>{
 const smoke=await readFile(new URL('../../scripts/paired-chrome-smoke.mjs',import.meta.url),'utf8');
 const block=smoke.slice(smoke.indexOf('await step(stepNames[38]'),smoke.indexOf('await step(stepNames[40]'));
 assert.match(block,/await exerciseTabMenuActions/);assert.match(block,/return exerciseMoveToNewWindow/);
 assert.match(smoke,/process.env.GITHUB_ACTIONS !== 'true' \|\| process.env.CI !== 'true'/);
 const adapter=smoke.slice(smoke.indexOf('async function nativeMoveWindowSidebar'),smoke.indexOf('async function nativeTodayMoveSidebar'));
 assert.match(adapter,/!\[fixture.windowA, fixture.windowB\].includes\(windowId\)/);
 assert.match(adapter,/host.tab===null&&host.windowId===windowId/);
 assert.match(adapter,/contextTypes:\['SIDE_PANEL'\]/);assert.match(adapter,/data.events.some/);
 const fixtureSource=await readFile(new URL('../../scripts/paired-chrome-move-window.mjs',import.meta.url),'utf8');
 assert.match(fixtureSource,/assertTabMenuFixtureEnvironment\(\)/);
 assert.match(fixtureSource,/await choose\('Move to New Window',last\)/);
 assert.match(fixtureSource,/last:true/);assert.match(fixtureSource,/assert.equal\(refusal\?\.success,false\)/);
 assert.doesNotMatch(fixtureSource,/no-sandbox|setBypassCSP|GITHUB_ACTIONS\s*=/);
});

test('last-tab host destruction is recorded after one input, never replayed or declared success',async()=>{
 let clicks=0,disposals=0;
 const receipt=await invokeWindowMoveOnce({allowHostClosure:true,click:async()=>{clicks++;throw Error('Target closed');},dispose:async()=>{disposals++;throw Error('Execution context was destroyed');}});
 assert.equal(clicks,1);assert.equal(disposals,1);assert.equal(receipt.hostClosureErrors.length,2);assert.equal(receipt.success,undefined);
 const f=fixture({last:true});f.after.tabs[0].windowId=10;assert.throws(()=>assertMovedWindowPage(f.before,f.after,f.target),'A closed renderer alone cannot pass native acceptance.');
});
test('ordinary input errors and unrelated last-tab errors remain failures',async()=>{
 for(const [allowHostClosure,message] of [[false,'Target closed'],[true,'Node is not clickable']])await assert.rejects(invokeWindowMoveOnce({allowHostClosure,click:async()=>{throw Error(message);},dispose:async()=>{}}));
});
