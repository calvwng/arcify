// Real packages, fresh synthetic profile only. Never attach to an existing browser.
import puppeteer from 'puppeteer';
import {mkdtemp,cp,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import assert from 'node:assert/strict';
const root=path.resolve(import.meta.dirname,'..');
assert(process.argv[2],'Pass the exact built Spotlight dist directory.');
const spotlightDist=path.resolve(process.argv[2]);
const executable=process.env.ARCIFY_DISPOSABLE_BROWSER||puppeteer.executablePath();
const scratch=await mkdtemp(path.join(os.tmpdir(),'arcify-paired-transition-'));
const arc=path.join(scratch,'arcify'),spot=path.join(scratch,'spotlight');
await cp(process.argv[3]?path.resolve(process.argv[3]):path.join(root,'dist'),arc,{recursive:true});
await cp(spotlightDist,spot,{recursive:true});
const server=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'text/html'});res.end('<title>Synthetic '+req.url+'</title>');});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));let browser;const observations=[];
async function poll(fn,predicate,label){for(let i=0;i<80;i++){const v=await fn();if(predicate(v))return v;await sleep(250);}throw Error('Timeout '+label);}
try{
 browser=await puppeteer.launch({executablePath:executable,headless:true,protocolTimeout:30000,userDataDir:path.join(scratch,'profile'),waitForInitialPage:false,
  ignoreDefaultArgs:['--disable-extensions','about:blank'],args:[`--disable-extensions-except=${arc},${spot}`,`--load-extension=${arc},${spot}`,'--no-first-run']});
 await poll(async()=>browser.targets().filter(t=>t.type()==='service_worker'),t=>t.length===2,'two workers');
 const ids={};for(const target of browser.targets().filter(t=>t.type()==='service_worker')){const worker=await target.worker();const name=await worker.evaluate(()=>chrome.runtime.getManifest().name);ids[name.includes('Spotlight')?'spotlight':'arcify']=new URL(target.url()).host;}
 let ap=await browser.newPage(),sp=await browser.newPage();await ap.goto(`chrome-extension://${ids.arcify}/options.html`);await sp.goto(`chrome-extension://${ids.spotlight}/options.html`);
 const request=async(action,extra={})=>ap.evaluate(async({action,extra})=>{const r=await chrome.runtime.sendMessage({type:'spaceStore',action,...extra});if(!r.success)throw Error(r.error);return r;},{action,extra});
 const read=async label=>{await request('get');const data=await ap.evaluate(async()=>({local:await chrome.storage.local.get(['spaces','spaceDurableTodayLayout','spaceTabSnapshot','spaceRankCheckpoint','spaceContinuityStamp','spaceExplicitTodayCheckpoint','pinnedTabStatesById','tabNameOverridesById']),session:await chrome.storage.session.get(['spaceExplicitTodayEpoch','spaceRecoveryCandidates','spaceRestoreQueue','activeSpaces']),tabs:await chrome.tabs.query({}),groups:await chrome.tabGroups.query({})}));observations.push({label,...data});await writeFile(path.join(scratch,'evidence.json'),JSON.stringify({ids,observations},null,2));return data;};
 await ap.evaluate(()=>chrome.storage.sync.set({syncTabGroups:true}));
 const spaces=(await request('get')).spaces,home=spaces[0];
 const folder=await ap.evaluate(async parent=>chrome.bookmarks.create({parentId:(await chrome.bookmarks.get(parent))[0].parentId,title:'Synthetic Work'}),home.bookmarkFolderId);
 const work=(await request('get')).spaces.find(s=>s.bookmarkFolderId===folder.id);
 const setup=await ap.evaluate(async base=>{const a=await chrome.windows.create({url:base+'/a0',focused:false}),b=await chrome.windows.create({url:base+'/b0',focused:false});const aIds=[a.tabs[0].id],bIds=[b.tabs[0].id];for(let i=1;i<4;i++)aIds.push((await chrome.tabs.create({windowId:a.id,url:base+'/a'+i,active:false})).id);for(let i=1;i<3;i++)bIds.push((await chrome.tabs.create({windowId:b.id,url:base+'/b'+i,active:false})).id);return{a:a.id,b:b.id,aIds,bIds};},base);
 for(const id of setup.aIds)await request('assign',{tabId:id,spaceId:work.id});for(const id of setup.bIds)await request('assign',{tabId:id,spaceId:home.id});
 await sleep(500);await read('unpaired-session-layout');
 console.log('Pair Arcify');await ap.bringToFront();await ap.type('#bridgePeerId',ids.spotlight);await ap.click('#bridgeSave');console.log('Pair Spotlight');await sp.bringToFront();await sp.waitForSelector('#arcify-peer-id:not([disabled])');await sp.type('#arcify-peer-id',ids.arcify);await sp.click('#save-connection');await sp.waitForSelector('#connection-status[data-state="connected"]');await ap.bringToFront();await ap.click('#bridgeCheck');await ap.waitForSelector('#bridgeStatus[data-state="connected"]');
 await request('activate',{windowId:setup.a,spaceId:work.id});await sleep(500);await read('paired-browser-witness');
 const movePage=await browser.newPage();await movePage.goto(`chrome-extension://${ids.arcify}/sidebar.html`);await movePage.evaluate(async windowId=>{const tab=await chrome.tabs.getCurrent();await chrome.tabs.move(tab.id,{windowId,index:-1});},setup.a);
 const moved=await movePage.evaluate(async({setup,work,home})=>{const current=await chrome.runtime.sendMessage({type:'spaceStore',action:'get'}),tabs=await chrome.tabs.query({}),inverted=(await chrome.storage.local.get('todayOrderRepresentation')).todayOrderRepresentation.inverted;const selected=current.spaces.find(s=>s.id===work.id).temporaryTabs.filter(id=>setup.aIds.slice(0,3).includes(id));return chrome.runtime.sendMessage({type:'moveTodayTabsToSpace',windowId:setup.a,spaceId:work.id,bookmarkFolderId:work.bookmarkFolderId,destinationSpaceId:home.id,destinationBookmarkFolderId:home.bookmarkFolderId,inverted,entries:(inverted?[...selected].reverse():selected).map(tabId=>({tabId,url:tabs.find(t=>t.id===tabId).url}))});},{setup,work,home});assert(moved.success,JSON.stringify(moved));await movePage.close();await sleep(500);
 const before=await read('before-arcify-reload');console.log('Move committed; reload Arcify');
 const reload=async(which)=>{const old=which==='arcify'?ap:sp,id=ids[which],target=browser.targets().find(t=>t.type()==='service_worker'&&new URL(t.url()).host===id);await old.bringToFront();const worker=await target.worker();await worker.client.detach();await old.evaluate(()=>{setTimeout(()=>chrome.runtime.reload(),50);});await poll(async()=>browser.targets().includes(target),x=>!x,which+' old worker gone');const page=await browser.newPage();await page.goto(`chrome-extension://${id}/options.html`);if(!old.isClosed())await old.close();if(which==='arcify')ap=page;else sp=page;await sleep(1000);};
 await reload('arcify');await sp.bringToFront();await sp.click('#refresh-connection');await sp.waitForSelector('#connection-status[data-state="connected"]');const afterArc=await read('after-arcify-reload');
 await reload('spotlight');await ap.bringToFront();await ap.click('#bridgeCheck');await ap.waitForSelector('#bridgeStatus[data-state="connected"]');await sleep(1000);const afterSpot=await read('after-spotlight-reload');
 const canonical=d=>d.local.spaces.map(s=>({id:s.id,temporaryTabs:s.temporaryTabs.filter(id=>before.tabs.some(t=>t.id===id)),spaceBookmarks:s.spaceBookmarks}));
 const result={scratch,ids,moved:moved.completed,orderPreserved:JSON.stringify(canonical(before))===JSON.stringify(canonical(afterArc)),ungrouped:afterSpot.tabs.filter(t=>t.groupId===-1&&afterSpot.local.spaces.some(s=>s.temporaryTabs.includes(t.id))).map(t=>({id:t.id,url:t.url})),epochs:observations.map(o=>({label:o.label,session:o.session.spaceExplicitTodayEpoch,browser:o.local.spaceContinuityStamp?.epoch,cohorts:o.local.spaceDurableTodayLayout?.cohorts.map(c=>({epoch:c.binding?.epoch,slots:c.signature.length}))}))};
 await writeFile(path.join(scratch,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 assert(result.orderPreserved,'Arcify reload must preserve the complete cross-window canonical order');
 assert.deepEqual(result.ungrouped,[],'Recreated ordinary companion pages must receive normal group projection');
 const launchPage=await browser.newPage();await launchPage.goto(`chrome-extension://${ids.arcify}/sidebar.html`);
 await launchPage.evaluate(async windowId=>{const tab=await chrome.tabs.getCurrent();await chrome.tabs.move(tab.id,{windowId,index:-1});},setup.a);
 const emptyFolder=await ap.evaluate(async parent=>chrome.bookmarks.create({parentId:(await chrome.bookmarks.get(parent))[0].parentId,title:'Synthetic empty fallback'}),home.bookmarkFolderId);
 const empty=(await request('get')).spaces.find(s=>s.bookmarkFolderId===emptyFolder.id);
 await ap.bringToFront();await ap.click('#bridgeDisconnect');await ap.waitForSelector('#bridgeStatus[data-state="disabled"]');
 const source=await (await browser.waitForTarget(t=>t.type()==='page'&&t.url()===base+'/a0')).page();await source.bringToFront();await sleep(500);
 await request('activate',{windowId:setup.a,spaceId:empty.id});await sleep(500);
 const fallback=await launchPage.evaluate(({windowId,spaceId})=>chrome.runtime.sendMessage({type:'spotlightBridgeLaunch',fallbackToNewTab:true,windowId,spaceId}),{windowId:setup.a,spaceId:empty.id});
 console.log('Disconnected New Tab result',JSON.stringify(fallback));
 await read('after-disconnected-new-tab');
 assert(fallback.ok,'Disconnected New Tab must complete through the ordinary provider');
}finally{if(browser){const proc=browser.process();await browser.close();console.log('Owned process disposal',JSON.stringify({pid:proc.pid,exitCode:proc.exitCode,signalCode:proc.signalCode}));}server.close();console.log('Evidence',scratch);}
