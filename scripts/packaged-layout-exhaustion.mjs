// Hosted-only. Exact production package, owned temporary profile, no attach path.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,cp,readFile,readdir,writeFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import os from 'node:os';
import path from 'node:path';
import puppeteer from './paired-chrome-runtime/index.mjs';
import {sealDurableLayout,readDurableLayout} from '../durable-today-layout.js';
import {assertTerminalEvidence,assertNoRevival,assertUnrelatedPreserved} from './packaged-layout-exhaustion-assertions.mjs';
import {readDeveloperModeDomState,developerModeStateReady,enableDeveloperModeViaUi,findInstalledExtension} from './paired-chrome-extensions.mjs';
import {CHROME_EXECUTABLE,inspectInstalledChromeRuntime,inspectChromeProcessRuntime,validateChromeLaunchArguments,validateNamespaceLaunchEnvironment,validateChromeNamespaceSandboxStatus} from './paired-chrome-sandbox.mjs';
import {snapshotChromeLaunchOptions,restartObservedBrowser} from './paired-chrome-browser-restart.mjs';
assert.equal(process.env.GITHUB_ACTIONS,'true','Only an owned GitHub-hosted disposable runner may execute this fixture');
assert.equal(process.env.CI,'true');assert.notEqual(process.getuid?.(),0,'Do not disable sandbox for root');
validateNamespaceLaunchEnvironment(process.env,process.getuid());
const root=path.resolve(import.meta.dirname,'..'),output=path.join(root,'test-results/layout-exhaustion');await mkdir(output,{recursive:true});
const receipt={schema:'arcify-packaged-final-cohort-lifecycle-v1',sourceCommit:process.env.ARCIFY_TEST_HEAD,status:'running',checks:[],disposals:[]};
const save=()=>writeFile(path.join(output,'receipt.json'),JSON.stringify(receipt,null,2));
const scratch=await mkdtemp(path.join(os.tmpdir(),'arcify-final-cohort-')),profile=path.join(scratch,'profile'),extension=path.join(scratch,'extension');
await mkdir(profile);await cp(path.join(root,'dist'),extension,{recursive:true});
async function inventory(dir,prefix=''){const result=[];for(const entry of await readdir(path.join(dir,prefix),{withFileTypes:true})){
 const name=path.join(prefix,entry.name);if(entry.isDirectory())result.push(...await inventory(dir,name));else result.push({path:name,sha256:createHash('sha256').update(await readFile(path.join(dir,name))).digest('hex')});
}return result.sort((a,b)=>a.path.localeCompare(b.path));}
receipt.inventory=await inventory(path.join(root,'dist'));assert.deepEqual(await inventory(extension),receipt.inventory);
const server=createServer((_q,res)=>{res.writeHead(200,{'content-type':'text/html'});res.end('<title>Synthetic final cohort</title>');});
let browser,extensionId,control;const launchOptions=snapshotChromeLaunchOptions({channel:'chrome',headless:false,pipe:true,enableExtensions:true,userDataDir:profile,args:['--restore-last-session'],timeout:60000,protocolTimeout:30000});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function poll(read,accept,label){const end=Date.now()+20000;let value;do{value=await read();if(accept(value))return value;await sleep(100);}while(Date.now()<end);throw Error(`Timed out observing ${label}`);}
async function sandboxCheck(b){
 assert.equal(b.process().spawnfile,CHROME_EXECUTABLE);validateChromeLaunchArguments(b.process().spawnargs);await inspectChromeProcessRuntime(b.process().pid);
 const p=await b.newPage();try{await p.goto('chrome://sandbox/');await p.waitForFunction(()=>document.querySelector('#sandbox-status tr')&&document.querySelector('#evaluation')?.textContent.trim());
 const status=await p.evaluate(()=>({url:location.href,evaluation:document.querySelector('#evaluation').textContent,rows:[...document.querySelectorAll('#sandbox-status tr')].map(row=>({name:row.querySelectorAll('td')[0]?.textContent||'',value:row.querySelectorAll('td')[1]?.textContent||''}))}));
 receipt.sandbox=validateChromeNamespaceSandboxStatus(status);
 }finally{await p.close();}
}
async function observe(){return control.evaluate(async()=>{const reply=await chrome.runtime.sendMessage({type:'spaceStore',action:'get'});if(!reply.success)throw Error(reply.error);const data=await chrome.storage.local.get(['spaceDurableTodayLayout','spaceTabSnapshot']);return {spaces:reply.spaces,tabs:await chrome.tabs.query({}),ledger:data.spaceDurableTodayLayout,snapshot:data.spaceTabSnapshot};});}
async function move(ids,destination){
 // The production receiver permits options.html, but an ordinary-tab sender
 // must belong to the requested native window. Move only our owned controller.
 const senderProof=await control.evaluate(async ids=>{
  if(location.href!==chrome.runtime.getURL('options.html'))throw Error('Unexpected fixture controller realm');
  const current=await chrome.tabs.getCurrent(),tabs=await chrome.tabs.query({});if(!current)throw Error('Expected owned ordinary options controller');
  const selected=ids.map(id=>tabs.find(t=>t.id===id));if(selected.some(t=>!t)||new Set(selected.map(t=>t.windowId)).size!==1)throw Error('Selected fixture tabs must share one real window');
  const windowId=selected[0].windowId;if(current.windowId!==windowId)await chrome.tabs.move(current.id,{windowId,index:-1});
  const fresh=await chrome.tabs.getCurrent();if(fresh.id!==current.id||fresh.windowId!==windowId)throw Error('Options sender did not enter the exact requested window');
  return {tabId:fresh.id,windowId:fresh.windowId,requestedWindowId:windowId,url:location.href};
 },ids);(receipt.moveSenders||=[]).push(senderProof);await save();
 return control.evaluate(async({ids,destination})=>{
 const reply=await chrome.runtime.sendMessage({type:'spaceStore',action:'get'});if(!reply.success)throw Error(reply.error);const tabs=await chrome.tabs.query({});
 const source=reply.spaces.find(s=>ids.every(id=>s.temporaryTabs.includes(id)));if(!source)throw Error('Move entries lack one exact current source');
 const target=reply.spaces.find(s=>s.id===destination),inverted=(await chrome.storage.local.get('todayOrderRepresentation')).todayOrderRepresentation.inverted;
 const ordered=source.temporaryTabs.filter(id=>ids.includes(id));
 const sender=await chrome.tabs.getCurrent(),live=await chrome.tabs.query({}),windowId=live.find(t=>t.id===ids[0])?.windowId;
 if(!sender||sender.windowId!==windowId||ids.some(id=>live.find(t=>t.id===id)?.windowId!==windowId))throw Error('Real sender/window proof changed before Move');
 const r=await chrome.runtime.sendMessage({type:'moveTodayTabsToSpace',windowId,spaceId:source.id,bookmarkFolderId:source.bookmarkFolderId,destinationSpaceId:target.id,destinationBookmarkFolderId:target.bookmarkFolderId,inverted,entries:(inverted?[...ordered].reverse():ordered).map(tabId=>({tabId,url:tabs.find(t=>t.id===tabId).url}))});
 if(!r.success)throw Error(JSON.stringify(r));return r;
},{ids,destination});}
try{
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});const base=`http://127.0.0.1:${server.address().port}`,urls=Array.from({length:1},(_,i)=>`${base}/chosen/${i}`);
 receipt.runtime=await inspectInstalledChromeRuntime(CHROME_EXECUTABLE);validateChromeLaunchArguments(await puppeteer.defaultArgs(structuredClone(launchOptions)));
 browser=await puppeteer.launch(structuredClone(launchOptions));await sandboxCheck(browser);
 const extensions=await browser.newPage();await extensions.goto('chrome://extensions/');
 await enableDeveloperModeViaUi({read:()=>extensions.evaluate(readDeveloperModeDomState),record:async()=>{},click:async()=>{
  const fresh=await extensions.evaluate(readDeveloperModeDomState);assert(developerModeStateReady(fresh)&&!fresh.manager.inDevMode);
  const handle=await extensions.evaluateHandle(()=>document.querySelector('extensions-manager').shadowRoot.querySelector('extensions-toolbar').shadowRoot.querySelector('#devMode'));
  try{await handle.asElement().click();}finally{await handle.dispose();}
 }});await extensions.close();extensionId=await browser.installExtension(extension);
 control=await browser.newPage();await control.goto(`chrome-extension://${extensionId}/options.html`);
 const setup=await control.evaluate(async({urls,base})=>{
  await chrome.storage.sync.set({syncTabGroups:false,onboardingCompleted:true});
  const reply=await chrome.runtime.sendMessage({type:'spaceStore',action:'get'});if(!reply.success)throw Error(reply.error);const source=reply.spaces[0];
  const parent=(await chrome.bookmarks.get(source.bookmarkFolderId))[0].parentId;
  const folder=await chrome.bookmarks.create({parentId:parent,title:'Synthetic terminal target'});
  const win=await chrome.windows.create({url:base+'/unrelated-anchor',focused:false});
  const tabs=[];for(const url of urls)tabs.push(await chrome.tabs.create({windowId:win.id,url,active:false}));
  return {sourceId:source.id,folderId:folder.id,windowId:win.id,ids:tabs.map(t=>t.id)};
 },{urls,base});
 let observed=await poll(observe,o=>setup.ids.every(id=>o.tabs.some(t=>t.id===id&&urls.includes(t.url)&&!t.pendingUrl))&&o.spaces.some(s=>s.bookmarkFolderId===setup.folderId),'real selected tabs and discovered target');
 const target=observed.spaces.find(s=>s.bookmarkFolderId===setup.folderId),selected=observed.tabs.filter(t=>setup.ids.includes(t.id)).sort((a,b)=>a.index-b.index);
 // Only synthetic historical INPUT is seeded. Neither a chosen subset nor v4
 // terminal evidence is injected; production Move and onRemoved must author them.
 const historyId='synthetic-pending-history',history={id:historyId,signature:[...selected.map(t=>({index:t.index,url:t.url,pinned:false})),{index:Math.max(...selected.map(t=>t.index))+1,url:base+'/missing-historical-anchor',pinned:false}],placements:selected.map((t,i)=>({index:t.index,spaceId:setup.sourceId,bookmarkFolderId:observed.spaces.find(s=>s.id===setup.sourceId).bookmarkFolderId,order:i})),binding:null,overrides:[]};
 const seed=await sealDurableLayout(1,[history]);assert(await readDurableLayout(seed));
 await control.evaluate(seed=>chrome.storage.local.set({spaceDurableTodayLayout:seed}),seed);
 const workerTarget=await browser.waitForTarget(t=>t.type()==='service_worker'&&t.url()===`chrome-extension://${extensionId}/background.js`);const worker=await workerTarget.worker();await worker.close();
 await poll(async()=>browser.targets().includes(workerTarget),present=>!present,'old synthetic worker exit');
 const seeded=await observe();assert(await readDurableLayout(seeded.ledger));const seededHistory=seeded.ledger.cohorts.find(c=>c.id===historyId);assert(seededHistory,'Synthetic pending input was lost before Move');assert.deepEqual({...seededHistory,overrides:[]},history,'Synthetic historical input must retain signature, placements and unbound identity before Move');receipt.seedObserved=seededHistory;receipt.checks.push('seeded pending historical precondition observed after real worker restart');await move(setup.ids,target.id);
 observed=await poll(observe,o=>o.ledger?.cohorts.some(c=>c.contextSubset&&c.placements.length===1&&c.binding?.tabIds.length===1&&c.binding.tabIds.every(id=>setup.ids.includes(id))),'production chosen subset');
 const chosen=observed.ledger.cohorts.find(c=>c.contextSubset&&c.binding?.tabIds.length===1&&c.binding.tabIds.every(id=>setup.ids.includes(id))),before=observed.ledger,beforeSnapshot=observed.snapshot,beforeClose=observed;
 assert.equal(observed.spaces.find(s=>s.id===target.id).temporaryTabs.filter(id=>setup.ids.includes(id)).length,1);receipt.checks.push('real Move produced exact one-slot subset');
 await control.evaluate(ids=>chrome.tabs.remove(ids),setup.ids);
 observed=await poll(observe,o=>o.ledger?.version===4&&o.ledger.retirements?.some(r=>r.cohortId===chosen.id),'real removal terminal commit');
 await assertTerminalEvidence(before,observed.ledger,chosen.id,historyId,{beforeSnapshot});receipt.unrelatedAnchor=assertUnrelatedPreserved(beforeClose,observed,base+'/unrelated-anchor');receipt.before=before;receipt.preCloseSnapshot=beforeSnapshot;receipt.terminal=observed.ledger;receipt.checks.push('real removal events persisted valid v4 and intact history');await save();
 const restart=await restartObservedBrowser({browser,launchOptions,launch:options=>puppeteer.launch(structuredClone(options)),revalidate:async b=>{await sandboxCheck(b);await inspectInstalledChromeRuntime(CHROME_EXECUTABLE);const session=await b.target().createCDPSession();try{const entries=(await session.send('Extensions.getExtensions')).extensions;const manifest=JSON.parse(await readFile(path.join(extension,'manifest.json'),'utf8'));assert.equal(findInstalledExtension(entries,{id:extensionId,name:manifest.name,version:manifest.version,path:extension}).enabled,true);}finally{await session.detach();}return {runtime:true,sandbox:true,registry:true};},record:async event=>{(receipt.restart||=[]).push(event);await save();}});browser=restart.browser;
 control=await browser.newPage();await control.goto(`chrome-extension://${extensionId}/options.html`);const afterRestart=await observe();await assertTerminalEvidence(before,afterRestart.ledger,chosen.id,historyId,{beforeSnapshot});receipt.checks.push('actual browser restart retained terminal evidence');
 const reopened=await control.evaluate(async urls=>{const win=await chrome.windows.create({url:urls[0],focused:false});const ids=[win.tabs[0].id];for(const url of urls.slice(1))ids.push((await chrome.tabs.create({windowId:win.id,url,active:false})).id);return ids;},urls);
 observed=await poll(observe,o=>reopened.every(id=>o.tabs.some(t=>t.id===id&&urls.includes(t.url)&&!t.pendingUrl)),'fresh same-URL native tabs');
 assertNoRevival(observed,target.id,urls);for(let i=0;i<3;i++)assertNoRevival(await observe(),target.id,urls);await assertTerminalEvidence(before,observed.ledger,chosen.id,historyId,{beforeSnapshot});receipt.checks.push('one new same-URL tab did not revive historical target');
 await move(reopened,target.id);observed=await poll(observe,o=>o.spaces.find(s=>s.id===target.id).temporaryTabs.filter(id=>reopened.includes(id)).length===1,'explicit Move remedy');
 await assertTerminalEvidence(before,observed.ledger,chosen.id,historyId,{allowNewerChoiceEdges:true,beforeSnapshot});assert(observed.snapshot.some(r=>reopened.includes(r.tabId)&&r.currentOwnership?.spaceId===target.id));receipt.checks.push('explicit Move establishes new ownership without deleting terminal history');receipt.status='passed';
}catch(error){if(error.restartedBrowser)browser=error.restartedBrowser;receipt.status='failed';receipt.error={message:error.message,stack:error.stack};throw error;}
finally{
 let disposed=!browser,cleanupError;try{if(browser){const child=browser.process();await browser.close();assert.equal(child.exitCode,0);assert.equal(child.signalCode,null);receipt.disposals.push({exitCode:child.exitCode,signalCode:child.signalCode});disposed=true;}}
 catch(error){cleanupError=error;receipt.status='failed';receipt.cleanupError={message:error.message};}
 finally{server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));receipt.profileRemoved=false;try{if(disposed){await rm(scratch,{recursive:true,force:true});receipt.profileRemoved=true;}}catch(error){cleanupError ||= error;receipt.status='failed';receipt.cleanupError={message:error.message};}await save();}
 if(cleanupError)throw cleanupError;
}
