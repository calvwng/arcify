import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdir,mkdtemp,readFile,writeFile,readdir,realpath} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import puppeteer from '../paired-chrome-runtime/index.mjs';
import {validateChromeLaunchArguments,validateNamespaceLaunchEnvironment,validateChromeNamespaceSandboxStatus} from '../paired-chrome-sandbox.mjs';
import {assertNativeSidebarEvidence,readNativeSidebarRender,createNativeSidebarReadiness,assertNativeSidebarScreenshot} from '../paired-chrome-sidebar.mjs';
const OUT=resolve('test-results/helium-first-focus');await mkdir(OUT,{recursive:true});
const report={status:'running',sourceHead:'f1e77e792069cf160e3ed2cb0eb2197aa703a210',diagnosticHead:process.env.GITHUB_SHA,scope:'Linux Helium synthetic native Split View and sidebar, not Windows/Helium parity',loadingDuringActivation:'not-tested',steps:[]};
const save=async(label,data)=>{if(label)report.steps.push({label,at:new Date().toISOString(),data});await writeFile(join(OUT,'report.json'),JSON.stringify(report,null,2));};
const poll=async(fn,accept,label,ms=15000)=>{const until=Date.now()+ms;let last;while(Date.now()<until){last=await fn();if(accept(last))return last;await new Promise(r=>setTimeout(r,100));}throw Error(`${label}: timeout; last=${JSON.stringify(last)?.slice(0,500)}`);};
const passive=async(page,fn,arg)=>{const s=await page.createCDPSession();try{const r=await s.send('Runtime.evaluate',{expression:`(${fn})(${JSON.stringify(arg)??'undefined'})`,awaitPromise:true,returnByValue:true,userGesture:false});assert(!r.exceptionDetails,JSON.stringify(r.exceptionDetails));return r.result.value;}finally{await s.detach();}};
let browser,server,api,extensionId,windowId,panel;
const profile=await mkdtemp(join(tmpdir(),'arcify-helium-profile-'));
const expected=JSON.parse(await readFile(new URL('./expected-build.json',import.meta.url),'utf8'));
const dist=resolve('dist');
const files=async(d,p='')=>(await Promise.all((await readdir(join(d,p),{withFileTypes:true})).map(async e=>e.isDirectory()?files(d,join(p,e.name)):[join(p,e.name)]))).flat();
assert.deepEqual((await files(dist)).sort(),Object.keys(expected.dist_sha256).sort(),'Exact artifact inventory');
for(const [f,h]of Object.entries(expected.dist_sha256))assert.equal(createHash('sha256').update(await readFile(join(dist,f))).digest('hex'),h,`Exact f1e77e7 built file ${f}`);
await save('exact-build-verified',{files:62,source:expected.commit});
const executable=await realpath(process.env.HELIUM_EXECUTABLE);
const version=execFileSync(executable,['--version'],{encoding:'utf8'}).trim();assert.equal(version,'Helium 0.21.3.1 (Chromium 157.0.8103.78)');
const args=[`--load-extension=${dist}`,`--disable-extensions-except=${dist}`,'--no-first-run','--no-default-browser-check','--disable-background-networking','--window-size=1440,1000'];
validateChromeLaunchArguments(args);validateNamespaceLaunchEnvironment(process.env,process.getuid());
async function launch(restoring=false){
 browser=await puppeteer.launch({executablePath:executable,headless:false,userDataDir:profile,defaultViewport:null,ignoreDefaultArgs:['--disable-extensions','--disable-component-extensions-with-background-pages'],args:[...args,...(restoring?['--restore-last-session']:[])]});
 const proc=browser.process();validateChromeLaunchArguments(proc.spawnargs.slice(1));assert.equal(await realpath(`/proc/${proc.pid}/exe`),executable);
 const session=await browser.target().createCDPSession();const protocol=await session.send('Browser.getVersion');await session.detach();assert.match(protocol.product,/157\.0\.8103\.78$/);
 const page=await browser.newPage();await page.goto('chrome://sandbox/');await page.waitForFunction(()=>document.querySelector('#sandbox-status tr')&&document.getElementById('evaluation')?.textContent.trim());
 const sandbox=await passive(page,()=>({url:location.href,evaluation:document.getElementById('evaluation').textContent,rows:[...document.querySelectorAll('#sandbox-status tr')].map(r=>{const c=r.querySelectorAll('td');return{name:c[0]?.textContent||'',value:c[1]?.textContent||''};})}));
 await save('runtime-and-sandbox',{restoring,pid:proc.pid,version,protocol,executable,arguments:proc.spawnargs,sandbox});
 validateChromeNamespaceSandboxStatus(sandbox);await page.close();
 const worker=await browser.waitForTarget(t=>t.type()==='service_worker'&&t.url().startsWith('chrome-extension://')&&t.url().endsWith('/background.js'),{timeout:15000});
 const id=new URL(worker.url()).host;if(extensionId)assert.equal(id,extensionId);extensionId=id;
 const pages=await browser.pages();api=pages.find(p=>p.url()===`chrome-extension://${id}/options.html`)||await browser.newPage();if(api.url()!==`chrome-extension://${id}/options.html`)await api.goto(`chrome-extension://${id}/options.html`);
 const manifest=await passive(api,()=>chrome.runtime.getManifest());const diskManifest=JSON.parse(await readFile(join(dist,'manifest.json'),'utf8'));assert.equal(manifest.name,diskManifest.name);assert.equal(manifest.version,diskManifest.version);
 const sender=await passive(api,async()=>chrome.tabs.getCurrent());windowId=sender.windowId;
 await passive(api,async()=>{globalThis.__heliumEvents=[];chrome.sidePanel.onOpened.addListener(e=>globalThis.__heliumEvents.push({type:'opened',...e}));});
 return proc.pid;
}
const state=()=>passive(api,async()=>({tabs:await chrome.tabs.query({}),local:await chrome.storage.local.get(['spaces','splitPinsV1','savedSplitRecipesV1']),session:await chrome.storage.session.get(['splitPinInstancesV1','splitPinFocusLinksV1','activeSpaces'])}));
async function nativePanel(label){
 await api.bringToFront();execFileSync('python3',[resolve('scripts/helium-diagnostic/native-key.py')],{stdio:'inherit'});
 const host=await poll(()=>passive(api,async()=>({contexts:await chrome.runtime.getContexts({contextTypes:['SIDE_PANEL']}),events:globalThis.__heliumEvents})),s=>s.events.some(e=>e.type==='opened'&&e.windowId===windowId)&&s.contexts.length>0,'native side panel opened');
 const context=assertNativeSidebarEvidence(host.contexts,host.events,{extensionId,windowId});
 const matches=[];for(const t of browser.targets().filter(t=>t.url()===`chrome-extension://${extensionId}/sidebar.html`)){const p=await t.asPage();const h=await passive(p,async()=>({tab:await chrome.tabs.getCurrent()||null,windowId:(await chrome.windows.getCurrent()).id}));if(h.tab===null&&h.windowId===windowId)matches.push({p,h});}
 assert.equal(matches.length,1);panel=matches[0].p;
 const render=await poll(()=>passive(panel,readNativeSidebarRender),createNativeSidebarReadiness(extensionId),'rendered native sidebar');
 const image=await panel.screenshot({path:join(OUT,`${label}.png`),fullPage:false});const dimensions=assertNativeSidebarScreenshot(image,render,extensionId);
 await save(label,{context,events:host.events,hosting:matches[0].h,render,dimensions});return panel;
}
async function clickExactButton(text){const b=await panel.$$('.split-pin-recovery-dialog button');const m=[];for(const h of b){if(await h.evaluate((n,t)=>n.textContent===t,text))m.push(h);else await h.dispose();}assert.equal(m.length,1);await m[0].click();await m[0].dispose();}
try{
 server=createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/html','Cache-Control':'no-store'});res.end(`<!doctype html><html><head><title>Helium synthetic ${randomUUID()}</title><link rel="icon" href="data:,"></head><body style="font:22px sans-serif;background:#cde;padding:30px"><h1>Native split fixture</h1><input id="value" value="unchanged"><script>if(!sessionStorage.getItem('helium-proof'))sessionStorage.setItem('helium-proof',crypto.randomUUID());document.body.dataset.proof=sessionStorage.getItem('helium-proof');</script></body></html>`);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}/same`;
 const pid1=await launch();
 const capability=await passive(api,()=>({createSplit:typeof chrome.tabs.createSplit,unsplit:typeof chrome.tabs.unsplit,none:chrome.tabs.SPLIT_VIEW_ID_NONE}));assert.deepEqual(capability,{createSplit:'function',unsplit:'function',none:-1});await save('native-capabilities',capability);
 await passive(api,async()=>{await chrome.storage.sync.set({onboardingCompleted:true,onboardingVersion:chrome.runtime.getManifest().version,syncTabGroups:false});});
 await passive(api,()=>chrome.runtime.sendMessage({type:'spaceStore',action:'get'}));
 const ready=await poll(state,s=>s.local.spaces?.length>0,'initial Space');const space=ready.local.spaces[0];
 const active=await passive(api,x=>chrome.runtime.sendMessage({type:'spaceStore',action:'activate',windowId:x.windowId,spaceId:x.spaceId}),{windowId,spaceId:space.id});assert(active.success,JSON.stringify(active));
 await nativePanel('native-sidebar-before');
 const seeds=[];
 for(const role of ['left','right','unrelated']){
  const existing=new Set(browser.targets());const tab=await passive(api,o=>chrome.tabs.create(o),{url,windowId,active:false});
  const target=await poll(async()=>browser.targets().find(t=>!existing.has(t)&&t.type()==='page'&&t.url()===url),Boolean,'fresh unique fixture target');const p=await target.page();await p.waitForFunction(()=>document.body.dataset.proof&&document.readyState==='complete');
  const proof=await passive(p,()=>({marker:sessionStorage.getItem('helium-proof'),title:document.title,url:location.href}));
  const assigned=await passive(api,o=>chrome.runtime.sendMessage({type:'spaceStore',action:'assign',tabId:o.tabId,spaceId:o.spaceId,pinned:false,newTodayTab:true}),{tabId:tab.id,spaceId:space.id});assert(assigned.success,JSON.stringify(assigned));
  seeds.push({role,tabId:tab.id,...proof});
 }
 const ids=seeds.slice(0,2).map(s=>s.tabId);await poll(state,s=>ids.every(id=>s.tabs.some(t=>t.id===id&&t.status==='complete'&&!t.pendingUrl)),'completed original pair');
 const split=await passive(api,ids=>chrome.tabs.createSplit(ids),ids);assert(Number.isSafeInteger(split)&&split>=0);
 const splitState=await poll(state,s=>s.tabs.filter(t=>t.splitViewId===split).length===2,'real native split');
 const pair=splitState.tabs.filter(t=>ids.includes(t.id)).sort((a,b)=>a.index-b.index);assert.deepEqual(pair.map(t=>t.splitViewId),[split,split]);
 const entries=pair.map(({id,url,index,groupId,pinned,splitViewId})=>({tabId:id,url,index,groupId,pinned,splitViewId}));
 const pin=await passive(api,m=>chrome.runtime.sendMessage(m),{type:'splitPinAction',action:'pin',windowId,spaceId:space.id,bookmarkFolderId:space.bookmarkFolderId,entries});assert(pin.success,JSON.stringify(pin));
 const before=await state();await save('saved-native-pair',{seeds,pin,before,split});
 await panel.screenshot({path:join(OUT,'saved-pair.png')});
 await passive(api,windowId=>chrome.sidePanel.close({windowId}),windowId);
 await browser.close();browser=null;
 const pid2=await launch(true);assert.notEqual(pid2,pid1);
 const documents=[];for(const p of await browser.pages()){if(p.url()===url){await p.waitForFunction(()=>document.readyState==='complete'&&document.body.dataset.proof);documents.push({page:p,...await passive(p,()=>({marker:sessionStorage.getItem('helium-proof'),title:document.title,url:location.href}))});}}
 const restored=await state();const originals=[];for(const seed of seeds){const match=documents.filter(d=>d.marker===seed.marker);assert.equal(match.length,1,'Independent sessionStorage marker identifies exactly one restored original');const tabs=restored.tabs.filter(t=>t.url===match[0].url&&t.title===match[0].title);assert.equal(tabs.length,1,'Fresh document title maps marker to native tab without URL-only adoption');originals.push({...seed,newTabId:tabs[0].id,page:match[0].page});}
 const restoredIds=originals.slice(0,2).map(s=>s.newTabId);const restoredPair=restored.tabs.filter(t=>restoredIds.includes(t.id));assert(restoredPair[0].splitViewId>=0&&restoredPair[0].splitViewId===restoredPair[1].splitViewId,'Helium restored the real native pair');
 assert.deepEqual(restored.local.splitPinsV1,before.local.splitPinsV1);assert.deepEqual(restored.local.savedSplitRecipesV1,before.local.savedSplitRecipesV1);
 assert(!Object.values(restored.session.splitPinInstancesV1||{}).some(v=>v.bookmarkId===pin.bookmarkId));assert(!Object.values(restored.session.splitPinFocusLinksV1||{}).some(v=>v.bookmarkId===pin.bookmarkId));
 await save('full-restart-restoration',{pid1,pid2,originals:originals.map(({page,...s})=>s),restored,loadingAtObservation:restoredPair.map(t=>t.status)});
 await nativePanel('native-sidebar-restored');
 await panel.waitForSelector(`#spaceSwitcher button[data-space-id="${space.id}"]`,{visible:true});await panel.click(`#spaceSwitcher button[data-space-id="${space.id}"]`);
 const selector=`.space.active .split-pin[data-bookmark-id="${pin.bookmarkId}"]`;await panel.waitForSelector(selector,{visible:true});await panel.click(selector,{button:'right'});
 await panel.waitForSelector('#tab-context-menu [data-action="attachSplitView"]',{visible:true});await panel.click('#tab-context-menu [data-action="attachSplitView"]');await panel.waitForSelector('.split-pin-recovery-dialog[open]',{visible:true});
 const radios=await panel.$$('.split-pin-recovery-dialog input[type="radio"]');const chosen=[];for(const r of radios){const text=await r.evaluate(n=>n.closest('label').textContent);if(restoredIds.every(id=>text.includes(`Tab ${id} ·`)))chosen.push(r);else await r.dispose();}assert.equal(chosen.length,1,'Exact original restored IDs explicitly selectable');await chosen[0].click();await chosen[0].dispose();await clickExactButton('Link selected pair for focus');
 const linked=await poll(state,s=>Object.values(s.session.splitPinFocusLinksV1||{}).some(v=>v.bookmarkId===pin.bookmarkId&&v.phase==='linked'),'confirmed explicit receipt');
 const receipt=Object.values(linked.session.splitPinFocusLinksV1).find(v=>v.bookmarkId===pin.bookmarkId);assert.deepEqual(receipt.entries.map(e=>e.tabId).sort(),restoredIds.slice().sort());await save('manual-link',{receipt,linked});
 await passive(api,id=>chrome.tabs.update(id,{active:true}),originals[2].newTabId);
 await panel.waitForFunction(s=>{const n=document.querySelector(s);return n&&n.dataset.splitBusy!=='true';},{},selector);
 const beforeBanner=await passive(panel,()=>{const n=document.getElementById('favoritesDropNotice');const visible=!!n&&!n.hidden&&getComputedStyle(n).display!=='none'&&getComputedStyle(n).visibility!=='hidden'&&n.getBoundingClientRect().width>0;return{status:document.getElementById('favoritesDropStatus')?.textContent,notice:n?.textContent,visible};});
 const pre=await state();assert(restoredIds.every(id=>pre.tabs.some(t=>t.id===id&&t.status==='complete'&&!t.pendingUrl)),'Both originals must be settled before input');await panel.click(selector);
 await poll(state,s=>s.tabs.some(t=>t.id===receipt.entries[0].tabId&&t.active),'original pane focused');
 await panel.waitForFunction(s=>document.querySelector(s)?.dataset.splitBusy!=='true',{},selector);
 const focused=await state();
 const banner=await passive(panel,()=>{const n=document.getElementById('favoritesDropNotice');const visible=!!n&&!n.hidden&&getComputedStyle(n).display!=='none'&&getComputedStyle(n).visibility!=='hidden'&&n.getBoundingClientRect().width>0;return{status:document.getElementById('favoritesDropStatus')?.textContent,notice:n?.textContent,visible};});
 await save('focus-action-settled',{pre,focused,beforeBanner,banner});
 assert(!(banner.visible&&/Focus may have changed|verification is pending|pair or saved pin changed|not be confirmed/i.test(JSON.stringify(banner))),'Settled first click produced an uncertainty/changed warning; not a pass');
 assert(restoredIds.every(id=>focused.tabs.some(t=>t.id===id&&t.status==='complete'&&!t.pendingUrl)),'Both originals must be settled after completion');
 assert.deepEqual(focused.tabs.map(t=>t.id).sort(),pre.tabs.map(t=>t.id).sort(),'No tabs added/removed');assert.deepEqual(focused.session.splitPinFocusLinksV1,pre.session.splitPinFocusLinksV1,'Focus receipt retained');
 for(const t of pre.tabs){const a=focused.tabs.find(x=>x.id===t.id);for(const key of ['url','windowId','index','groupId','splitViewId','pinned'])assert.equal(a[key],t[key],`No ${key} mutation during focus`);}
 await panel.screenshot({path:join(OUT,'first-focus.png')});await save('first-native-pin-focus',{pre,focused,beforeBanner,banner,limits:'Settled restored panes; loading during activation not established. No Windows parity claim.'});
 report.status='passed-scoped';report.loadingDuringActivation='not-tested';
}catch(e){report.status='failed';report.error={message:e.message,stack:e.stack};console.error(e);process.exitCode=1;}
finally{if(browser)await browser.close().catch(e=>{report.cleanupError=e.message;process.exitCode=1;});if(server)await new Promise(r=>server.close(r));await save();}
