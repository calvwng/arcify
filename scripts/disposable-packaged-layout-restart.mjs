// Exact production dist, fresh synthetic profile only. Never attach to a browser.
import puppeteer from 'puppeteer';
import {mkdtemp,mkdir,cp,writeFile,readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import os from 'node:os';
const root=path.resolve(import.meta.dirname,'..'),scenario=process.env.ARCIFY_PACKAGED_LAYOUT_CASE||'baseline';
assert(['baseline','extra-startup','native-newtab','own-launcher','interleaved','duplicate-mapping','partial-startup','navigation'].includes(scenario));
async function files(dir,prefix=''){const result=[];for(const item of await readdir(dir,{withFileTypes:true})){const name=prefix+item.name;if(item.isDirectory())result.push(...await files(path.join(dir,item.name),name+'/'));else result.push(name);}return result;}
const dist=path.join(root,'dist');
const inventory=await Promise.all((await files(dist)).sort().map(async name=>({path:name,sha256:createHash('sha256').update(await readFile(path.join(dist,name))).digest('hex')})));
const receipt=process.env.ARCIFY_PACKAGED_LAYOUT_RECEIPT?JSON.parse(await readFile(process.env.ARCIFY_PACKAGED_LAYOUT_RECEIPT,'utf8')):
 {commit:process.env.ARCIFY_TEST_SOURCE_REVISION||'local-build',artifacts:{forward:{inventory}}};
const scratch=await mkdtemp(path.join(os.tmpdir(),'arcify-packaged-layout-')),extension=path.join(scratch,'extension'),profile=path.join(scratch,'profile');
await mkdir(profile);await cp(dist,extension,{recursive:true});
await writeFile(path.join(scratch,'input-inventory.json'),JSON.stringify(receipt,null,2));
assert.deepEqual((await files(extension)).sort(),receipt.artifacts.forward.inventory.map(i=>i.path).sort());
for(const entry of receipt.artifacts.forward.inventory)assert.equal(createHash('sha256').update(await readFile(path.join(extension,entry.path))).digest('hex'),entry.sha256);
const server=http.createServer((_req,res)=>{res.writeHead(200,{'content-type':'text/html'});res.end('<title>Synthetic layout page</title>');});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
let browser,extensionId;const disposals=[];
const executable=process.env.ARCIFY_DISPOSABLE_BROWSER||puppeteer.executablePath();
const nativeNewTabUrl=/msedge/i.test(path.basename(executable))?'edge://newtab/':'chrome://newtab/';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function close(){if(!browser)return;const p=browser.process();await browser.close();browser=null;disposals.push({pid:p.pid,exitCode:p.exitCode,signalCode:p.signalCode,exited:p.exitCode!==null||p.signalCode!==null});}
async function launch(){
 const extra=scenario==='extra-startup'?`${base}/extra-startup`:scenario==='native-newtab'?nativeNewTabUrl:scenario==='own-launcher'?`chrome-extension://${extensionId}/startup-launcher.html`:null;
 browser=await puppeteer.launch({executablePath:executable,headless:true,userDataDir:profile,waitForInitialPage:false,protocolTimeout:30000,
 ignoreDefaultArgs:['--disable-extensions','about:blank'],args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'--restore-last-session','--no-first-run',...(disposals.length?(extra?[extra]:[]):[''])]});
 const target=await browser.waitForTarget(t=>t.type()==='service_worker'&&t.url().endsWith('/background.js'),{timeout:20000});extensionId=new URL(target.url()).host;
 if(disposals.length){const restored=await browser.waitForTarget(t=>t.type()==='page'&&t.url()===`chrome-extension://${extensionId}/options.html`,{timeout:20000});return restored.page();}
 const control=await browser.newPage();await control.goto(`chrome-extension://${extensionId}/options.html`);return control;
}
async function report(page){return page.evaluate(async base=>{
 const response=await chrome.runtime.sendMessage({type:'spaceStore',action:'get'});if(!response.success)throw Error(response.error);
 const data=await chrome.storage.local.get(['spaceDurableTodayLayout','spaceTabSnapshot']);const tabs=await chrome.tabs.query({});
 const selected=tabs.filter(t=>t.url?.startsWith(base+'/page/')).sort((a,b)=>Number(a.url.split('/page/')[1])-Number(b.url.split('/page/')[1]));
 const target=response.spaces.find(s=>s.name==='Packaged target');
 return {selectedCount:selected.length,targetOrder:(target?.temporaryTabs||[]).flatMap(id=>{const t=selected.find(t=>t.id===id);return t?[Number(t.url.split('/page/')[1])]:[]}),
  layouts:data.spaceDurableTodayLayout?.cohorts.map(c=>({id:c.id,slots:c.signature.length,placements:c.placements.length,blockedBy:c.blockedBy?.length||0,signature:c.signature.map(t=>({index:t.index,url:t.url}))})),
  native:tabs.map(t=>({id:t.id,windowId:t.windowId,index:t.index,url:t.url,pinned:t.pinned})),snapshotCount:data.spaceTabSnapshot?.length};
 },base);}
try{
 let page=await launch();
 const setup=await page.evaluate(async base=>{
  await chrome.storage.sync.set({syncTabGroups:false,startupLauncherEnabled:true,onboardingCompleted:true});
  const request=async(action,extra={})=>{const r=await chrome.runtime.sendMessage({type:'spaceStore',action,...extra});if(!r.success)throw Error(r.error);return r.spaces;};
  const before=await request('get'),source=before[0];
  const parent=(await chrome.bookmarks.get(source.bookmarkFolderId))[0].parentId;
  const folder=await chrome.bookmarks.create({parentId:parent,title:'Packaged target'});const spaces=await request('get'),target=spaces.find(s=>s.bookmarkFolderId===folder.id);if(!target)throw Error('Target discovery failed');
  const win=await chrome.windows.create({url:base+'/anchor',focused:false});
  const control=await chrome.tabs.getCurrent();await chrome.tabs.move(control.id,{windowId:win.id,index:-1});
  // Keep a single owned synthetic window so a positional startup page cannot
  // accidentally exercise a different window from the moved tabs.
  await chrome.windows.remove(control.windowId);await chrome.windows.update(win.id,{focused:true});
  await request('activate',{windowId:win.id,spaceId:source.id});
  await chrome.tabs.create({windowId:win.id,url:base+'/native-pin',pinned:true,active:false});
  const selected=[];for(let i=0;i<7;i++)selected.push({...await chrome.tabs.create({windowId:win.id,url:base+'/page/'+i,active:false}),url:base+'/page/'+i});
  const deadline=Date.now()+12000;while(Date.now()<deadline){const tabs=await chrome.tabs.query({windowId:win.id});if(selected.every(t=>tabs.some(n=>n.id===t.id&&n.url===t.url&&!n.pendingUrl)))break;await new Promise(r=>setTimeout(r,100));}
  const current=await request('get');const ordered=current.find(s=>s.id===source.id).temporaryTabs.filter(id=>selected.some(t=>t.id===id));
  const inverted=(await chrome.storage.local.get('todayOrderRepresentation')).todayOrderRepresentation.inverted;
  const response=await chrome.runtime.sendMessage({type:'moveTodayTabsToSpace',inverted,windowId:win.id,spaceId:source.id,bookmarkFolderId:source.bookmarkFolderId,destinationSpaceId:target.id,destinationBookmarkFolderId:target.bookmarkFolderId,entries:(inverted?[...ordered].reverse():ordered).map(tabId=>({tabId,url:selected.find(t=>t.id===tabId).url}))});
  if(!response.success)throw Error(JSON.stringify(response));return {response,windowId:win.id,expectedOrder:ordered.map(id=>Number(selected.find(t=>t.id===id).url.split('/page/')[1]))};
 },base);
 await pause(1500);const before=await report(page);assert.equal(before.targetOrder.length,7);assert.deepEqual(before.targetOrder,setup.expectedOrder);console.log('Pre-restart move confirmed',JSON.stringify({scenario,order:before.targetOrder,layouts:before.layouts.map(c=>({slots:c.slots,placements:c.placements}))}));
 if(['interleaved','duplicate-mapping','partial-startup','navigation'].includes(scenario)){
  const worker=await browser.waitForTarget(t=>t.type()==='service_worker'&&t.url().endsWith('/background.js'));
  const client=await worker.createCDPSession();await client.send('Debugger.enable');await client.send('Debugger.pause');
  // Pause only this owned fixture worker to retain the confirmed checkpoint
  // while native session contents change at the shutdown boundary.
  await page.evaluate(async({scenario,base})=>{const tabs=await chrome.tabs.query({});const first=tabs.find(t=>t.url===base+'/page/0');
   if(scenario==='partial-startup')await chrome.tabs.remove(tabs.filter(t=>[4,5,6].some(i=>t.url===base+'/page/'+i)).map(t=>t.id));
   else if(scenario==='navigation')await chrome.tabs.update(tabs.find(t=>t.url===base+'/page/3').id,{url:base+'/changed-page'});
   else await chrome.tabs.create({windowId:first.windowId,index:scenario==='duplicate-mapping'?first.index:first.index+3,url:scenario==='duplicate-mapping'?first.url:base+'/interleaved-extra',active:false});
  },{scenario,base});await pause(500);
 }
 await close();page=await launch();await pause(5000);let after=await report(page),partial=null;
 if(scenario==='partial-startup'){
  partial=after;assert.equal(partial.targetOrder.length,0,'partial startup must defer the entire cohort');
  await page.evaluate(async base=>{const tabs=await chrome.tabs.query({});const first=tabs.find(t=>t.url===base+'/page/0');for(const i of [4,5,6])await chrome.tabs.create({windowId:first.windowId,url:base+'/page/'+i,active:false});},base);
 }
 const deadline=Date.now()+25000;
 while(JSON.stringify(after.targetOrder)!==JSON.stringify(setup.expectedOrder)&&Date.now()<deadline){await pause(1000);after=await report(page);}
 if(scenario==='extra-startup')assert.equal(after.native.find(t=>t.url===base+'/extra-startup')?.windowId,after.native.find(t=>t.url===base+'/page/0')?.windowId,'extra startup page must be in affected window');
 if(scenario==='native-newtab')assert.equal(after.native.find(t=>/^(edge|chrome):\/\/newtab\/?$/.test(t.url))?.windowId,after.native.find(t=>t.url===base+'/page/0')?.windowId,'native new tab must be in affected window');
 if(scenario==='own-launcher')assert.equal(after.native.find(t=>t.url?.endsWith('/startup-launcher.html'))?.windowId,after.native.find(t=>t.url===base+'/page/0')?.windowId,'launcher must be in affected window');
 const negative=['duplicate-mapping','navigation'].includes(scenario);
 if(process.env.ARCIFY_EXPECT_BOUNDED_MAPPING==='true'){
  if(negative)assert.equal(after.targetOrder.length,0,'uncertain mapping must remain unresolved');else assert.deepEqual(after.targetOrder,setup.expectedOrder,'bounded mapping must restore expected order');
 }else if(scenario==='baseline')assert.deepEqual(after.targetOrder,setup.expectedOrder,'unchanged packaged restart baseline must restore');
 let repeated=null;
 if(scenario==='interleaved'&&process.env.ARCIFY_EXPECT_BOUNDED_MAPPING==='true'){
  await page.evaluate(async base=>{const tabs=await chrome.tabs.query({});await chrome.tabs.remove(tabs.filter(t=>t.url===base+'/interleaved-extra').map(t=>t.id));},base);await pause(1000);
  await close();page=await launch();await pause(5000);repeated=await report(page);assert.deepEqual(repeated.targetOrder,setup.expectedOrder,'removing an extra must not make it a required anchor');
 }
 const result={scenario,sourceCommit:receipt.commit,exactProductionFilesVerified:true,scratch,before,after,partial,repeated,setup,restored:JSON.stringify(after.targetOrder)===JSON.stringify(setup.expectedOrder)};
 await writeFile(path.join(scratch,'receipt.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({scenario,scratch,restored:result.restored,beforeOrder:before.targetOrder,afterOrder:after.targetOrder,layouts:after.layouts.map(c=>({slots:c.slots,placements:c.placements})),nativeCount:after.native.length}));
}finally{await close();server.close();await writeFile(path.join(scratch,'disposal.json'),JSON.stringify(disposals,null,2));console.log('Owned fixture process disposal',JSON.stringify(disposals));}
