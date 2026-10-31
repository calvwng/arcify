// Integration check: actual source modules in an isolated MV3 fixture, a fresh
// temporary profile, synthetic localhost tabs, and a real browser process restart.
// Never attach to a running browser or accept an existing user-data directory.
import puppeteer from 'puppeteer';
import {mkdtemp,mkdir,readdir,copyFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import os from 'node:os';
const root=path.resolve(import.meta.dirname,'..');
const scenario=process.env.ARCIFY_LAYOUT_FIXTURE_CASE||'baseline';
assert(['baseline','pinned-import','pending-grouping','fresh-choice'].includes(scenario));
const scratch=await mkdtemp(path.join(os.tmpdir(),'arcify-source-layout-'));
const extension=path.join(scratch,'extension'),profile=path.join(scratch,'profile');
await mkdir(extension);await mkdir(profile);
for(const name of await readdir(root))if(name.endsWith('.js'))await copyFile(path.join(root,name),path.join(extension,name));
await writeFile(path.join(extension,'manifest.json'),JSON.stringify({manifest_version:3,name:'Arcify isolated layout restart test',version:'1.0',
    permissions:['storage','tabs','bookmarks','tabGroups'],host_permissions:['http://127.0.0.1/*'],background:{service_worker:'fixture.mjs',type:'module'}}));
await writeFile(path.join(extension,'fixture.mjs'),`
import {SpaceStore} from './space-store.js';
import {moveTodayTabsToSpace} from './today-move-store.js';
import {encodeFavoriteContinuityState as encode} from './favorite-continuity.js';
let store;
const scenario=${JSON.stringify(scenario)};let partialVisibility=false;
const make=()=>{const s=new SpaceStore();s.discoverBookmarkSpaces=async()=>false;
 const query=s.queryTabs.bind(s);s.queryTabs=async filter=>(await query(filter)).filter(t=>!partialVisibility||!t.url?.includes('/page/')||Number(t.url.split('/page/')[1])<4);
 return s;};
globalThis.layoutFixture={
 async releasePartial(){await store.run(async()=>{partialVisibility=false;await store.persist();});return this.report();},
 async chooseFresh(){
  const tabs=(await chrome.tabs.query({})).filter(t=>['0','1','2','3','4','5','6'].includes((t.url||'').split('/page/')[1])).sort((a,b)=>a.index-b.index);
  if(tabs.length!==7)throw Error('Selected fixture tabs incomplete');
  const source=store.spaces.find(s=>s.temporaryTabs.includes(tabs[0].id)),target=store.spaces.find(s=>s.id==='target'),windowId=tabs[0].windowId;
  await store.dispatch({action:'activate',windowId,spaceId:source.id});
  const ordered=store.spaces.find(s=>s.id===source.id).temporaryTabs.filter(id=>tabs.some(t=>t.id===id)).map(id=>tabs.find(t=>t.id===id));
  await moveTodayTabsToSpace(store,{type:'moveTodayTabsToSpace',windowId,spaceId:source.id,bookmarkFolderId:source.bookmarkFolderId,
   destinationSpaceId:target.id,destinationBookmarkFolderId:target.bookmarkFolderId,inverted:false,entries:ordered.map(t=>({tabId:t.id,url:t.url}))});
  await chrome.storage.local.set({layoutFixtureFreshChosen:true});return {...await this.report(),expectedChoiceOrder:ordered.map(t=>t.url.split('/page/')[1])};
 },
 async seed(base){
  const original=await chrome.tabs.query({});
  const opened=[];for(let i=0;i<13;i++)opened.push(await chrome.tabs.create({url:base+'/page/'+i,active:false}));
  for(const t of original)await chrome.tabs.remove(t.id);
  if(scenario==='pinned-import')await chrome.tabs.create({url:base+'/native-pin',pinned:true,active:false});
  const deadline=Date.now()+15000;let tabs;
  do{tabs=(await chrome.tabs.query({})).filter(t=>t.url?.startsWith(base+'/page/'));if(tabs.length===13&&tabs.every(t=>t.status==='complete'&&!t.pendingUrl))break;await new Promise(r=>setTimeout(r,100));}while(Date.now()<deadline);
  if(tabs.length!==13)throw Error('Synthetic tabs incomplete');tabs.sort((a,b)=>a.index-b.index);
  const folder=await chrome.bookmarks.create({parentId:'1',title:'Arcify'});
  const source=await chrome.bookmarks.create({parentId:folder.id,title:'Personal'}),target=await chrome.bookmarks.create({parentId:folder.id,title:'Work'});
  const spaces=[{id:'source',name:'Personal',color:'blue',bookmarkFolderId:source.id,temporaryTabs:tabs.map(t=>t.id),spaceBookmarks:[]},
    {id:'target',name:'Work',color:'green',bookmarkFolderId:target.id,temporaryTabs:[],spaceBookmarks:[]}];
  const windowId=tabs[0].windowId,ids=tabs.slice(0,7).map(t=>t.id),queue=tabs.slice(0,8).flatMap((t,i)=>Array.from({length:i<5?2:1},(_,j)=>({tabId:10000+i,url:t.url,spaceId:i<6?'target':'source',section:'temporaryTabs',windowKey:'old-'+i+'-'+j,tabIndex:0,order:i})));
  await chrome.storage.sync.set({syncTabGroups:false,invertTabOrder:false,defaultSpaceName:'Personal'});
  await chrome.storage.local.set({spaces,spaceModelVersion:2,pinnedTabStatesById:{},tabNameOverridesById:{},todayOrderRepresentation:{version:1,inverted:false}});
  await chrome.storage.session.set({spaceSession:true,activeSpaces:{[windowId]:'source'}});
  store=make();Object.assign(store,{initialized:true,spaces,active:{[windowId]:'source'},liveTabs:new Map(tabs.map(t=>[t.id,t])),snapshotByTab:new Map(),provisional:new Set(),
   recoveryCandidates:new Set(tabs.slice(0,8).map(t=>t.id)),windowKeys:new Map([[windowId,'current']]),restoreWindowKeys:new Map(),savedWindows:[],restoredMetadata:[],restoredRanks:new Map(),restoreQueue:queue});
  await store.persist();const committedHistory=structuredClone(store.restoreQueue);
  await moveTodayTabsToSpace(store,{type:'moveTodayTabsToSpace',windowId,spaceId:'source',bookmarkFolderId:source.id,destinationSpaceId:'target',destinationBookmarkFolderId:target.id,inverted:false,entries:tabs.slice(0,7).map(t=>({tabId:t.id,url:t.url}))});
  await chrome.storage.local.set({layoutFixtureSeeded:true,layoutFixtureBase:base,layoutFixtureHistory:committedHistory});store.install();await store.chain;
  return this.report();
 },
 async report(){
  if(!store)return {ready:false};await store.run(()=>{});
  const tabs=await chrome.tabs.query({}),data=await chrome.storage.local.get(['layoutFixtureHistory','spaceDurableTodayLayout']);
  const target=store.spaces.find(s=>s.id==='target');
  return {ready:true,nativeCount:tabs.length,nativeGroupCount:(await chrome.tabGroups.query({})).length,nativeSlots:tabs.map(t=>({index:t.index,page:t.url?.split('/page/')[1]??'nonfixture',pending:!!t.pendingUrl})),
   savedSlots:data.spaceDurableTodayLayout?.cohorts.map(c=>c.signature.map(t=>({index:t.index,page:t.url?.split('/page/')[1]??'nonfixture'}))),
   targetOrder:(target?.temporaryTabs||[]).map(id=>tabs.find(t=>t.id===id)?.url?.split('/page/')[1]??'missing'),
   pendingLayouts:store.layoutPending?.size||0,historyPreserved:(data.layoutFixtureHistory||[]).every(r=>store.restoreQueue.some(p=>encode(p)===encode(r))),
   pendingFreshLayouts:(store.durableLayout?.cohorts||[]).filter(c=>c.explicitOnly&&store.layoutPending?.has(c.id)).length,
   unresolvedNeighbours:tabs.filter(t=>t.url?.endsWith('/page/7')&&store.recoveryCandidates.has(t.id)).length,
   retainedNeighbourHistoryRecords:store.restoreQueue.filter(r=>r.url?.endsWith('/page/7')).length,
   savedPlacements:data.spaceDurableTodayLayout?.cohorts.reduce((n,c)=>n+c.placements.length,0)||0};
 }
};
// Extension service-worker modules cannot use top-level await. Keep module
// evaluation synchronous, then expose readiness through the fixture report.
chrome.storage.local.get(['layoutFixtureSeeded','layoutFixtureFreshChosen','layoutFixtureBase']).then(async data=>{if(data.layoutFixtureSeeded){
 if(scenario==='pinned-import')await chrome.storage.local.remove('spaceDurableTodayLayout'); // emulate the previous build's input in this synthetic profile only
 if(scenario==='pending-grouping'){partialVisibility=true;await chrome.storage.sync.set({syncTabGroups:true});}
 if(scenario==='fresh-choice'&&!data.layoutFixtureFreshChosen){
  let anchor;const deadline=Date.now()+15000;
  do{anchor=(await chrome.tabs.query({})).find(t=>(t.url||t.pendingUrl)?.endsWith('/page/12'));if(anchor)break;await new Promise(r=>setTimeout(r,100));}while(Date.now()<deadline);
  if(!anchor)throw Error('Fixture context anchor absent');
  await chrome.tabs.update(anchor.id,{url:data.layoutFixtureBase+'/changed-anchor'});
  while(Date.now()<deadline){const current=await chrome.tabs.get(anchor.id);if(current.url===data.layoutFixtureBase+'/changed-anchor'&&!current.pendingUrl)break;await new Promise(r=>setTimeout(r,100));}
 }
 store=make();store.install();await store.chain;
}}).catch(error=>console.error(error));
`);
const server=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><title>Layout fixture</title><p>Synthetic restart fixture</p>');});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
const executable=process.env.ARCIFY_DISPOSABLE_BROWSER || puppeteer.executablePath();
let browser;const disposals=[];
async function closeFixture(){
 const current=browser;if(!current)return;const child=current.process();
 await current.close();browser=null;
 const result={pid:child?.pid,exitCode:child?.exitCode,signalCode:child?.signalCode,exited:child?.exitCode!==null||child?.signalCode!==null};
 disposals.push(result);console.log('Fixture process disposal:',JSON.stringify(result));
}
async function launch(){
 // One seed call creates thirteen native tabs and has a 15s readiness budget.
 // Its transport timeout must cover that work, including loaded CI machines.
 browser=await puppeteer.launch({executablePath:executable,headless:true,userDataDir:profile,waitForInitialPage:false,protocolTimeout:30000,
  // Initial empty positional argument avoids Edge's protected startup NTP.
  // On restart omit all positional tabs: either about:blank or an empty argument
  // adds a tab to the restored window. Never weaken matching for harness tabs.
  ignoreDefaultArgs:['--disable-extensions','about:blank'],args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'--restore-last-session','--no-first-run',...(disposals.length?[]:[''])]});
 const target=await browser.waitForTarget(t=>t.type()==='service_worker'&&t.url().endsWith('/fixture.mjs'),{timeout:20000});
 const client=await target.createCDPSession();client.on('Runtime.exceptionThrown',e=>console.error('Isolated fixture exception:',e.exceptionDetails.exception?.description||e.exceptionDetails.text));await client.send('Runtime.enable');await client.send('Runtime.runIfWaitingForDebugger');
 // Evaluate directly in this fixture target: some Edge versions expose an
 // unusable default Puppeteer worker realm during extension module startup.
 const worker={async evaluate(fn,...args){
  const response=await client.send('Runtime.evaluate',{expression:`(${fn.toString()})(${args.map(arg=>JSON.stringify(arg)).join(',')})`,awaitPromise:true,returnByValue:true});
  if(response.exceptionDetails)throw Error(response.exceptionDetails.exception?.description||response.exceptionDetails.text);
  return response.result.value;
 }};const deadline=Date.now()+10000;
 while(Date.now()<deadline){if(await worker.evaluate(()=>typeof globalThis.layoutFixture==='object'))return worker;await new Promise(r=>setTimeout(r,100));}
 throw Error('Isolated fixture worker did not initialize');
}
try{
 let expectedOrder=['0','1','2','3','4','5','6'];
 let worker=await launch();let before=await worker.evaluate(base=>globalThis.layoutFixture.seed(base),base);
 console.log('Before restart:',JSON.stringify(before));
 assert.deepEqual(before.targetOrder,['0','1','2','3','4','5','6']);assert(before.historyPreserved);assert.equal(before.unresolvedNeighbours,1);
 await closeFixture();worker=await launch();
 if(scenario==='fresh-choice'){
  let changed;const deadline=Date.now()+15000;
  do{changed=await worker.evaluate(()=>globalThis.layoutFixture.report());if(changed.ready)break;await new Promise(r=>setTimeout(r,100));}while(Date.now()<deadline);
  console.log('Changed old layout:',JSON.stringify(changed));assert(changed.pendingLayouts>0);assert.deepEqual(changed.targetOrder,[]);
  before=await worker.evaluate(()=>globalThis.layoutFixture.chooseFresh());console.log('Fresh explicit choice:',JSON.stringify(before));
  expectedOrder=before.expectedChoiceOrder;assert.equal(expectedOrder.length,7);assert.deepEqual(before.targetOrder,expectedOrder);assert(before.historyPreserved);
  await closeFixture();worker=await launch();
 }
 if(scenario==='pending-grouping'){
  let partial;const deadline=Date.now()+15000;
  do{partial=await worker.evaluate(()=>globalThis.layoutFixture.report());if(partial.ready)break;await new Promise(r=>setTimeout(r,100));}while(Date.now()<deadline);
  console.log('Controlled partial visibility:',JSON.stringify(partial));assert(partial.pendingLayouts>0);assert.equal(partial.nativeGroupCount,0);
  await worker.evaluate(()=>globalThis.layoutFixture.releasePartial());
 }
 let after;const deadline=Date.now()+25000;
 do{after=await worker.evaluate(()=>globalThis.layoutFixture.report());if(after.targetOrder?.join(',')===expectedOrder.join(',')&&(scenario==='fresh-choice'?after.pendingFreshLayouts:after.pendingLayouts)===0&&after.savedPlacements===before.savedPlacements)break;await new Promise(r=>setTimeout(r,100));}while(Date.now()<deadline);
 console.log('After restart:',JSON.stringify(after));
 assert.deepEqual(after.targetOrder,expectedOrder);assert(after.historyPreserved);
 assert.equal(after.nativeCount,scenario==='pinned-import'?14:13);
 // Historical preservation is the invariant. Report ephemeral live recovery
 // flags separately from whether the historical record was consumed.
 assert.equal(after.retainedNeighbourHistoryRecords,1);
 if(scenario!=='pending-grouping')assert.equal(after.unresolvedNeighbours,1);
 assert.equal(scenario==='fresh-choice'?after.pendingFreshLayouts:after.pendingLayouts,0);assert.equal(after.savedPlacements,before.savedPlacements);
 if(scenario==='pending-grouping')assert.equal(after.nativeGroupCount,2);
 const receipt={passed:true,scenario,executable,scratch,before,after};await writeFile(path.join(scratch,'receipt.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));
}finally{await closeFixture();await new Promise(resolve=>server.close(resolve));await writeFile(path.join(scratch,'disposal.json'),JSON.stringify(disposals,null,2));}
