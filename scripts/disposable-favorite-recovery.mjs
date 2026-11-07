// Local synthetic fixture. Always creates its own temporary profile and closes only its owned browser.
// No API mocks. Ordinary sidebar.html rendering is not native side-panel or Helium acceptance.
import puppeteer from 'puppeteer';
import {mkdtemp,mkdir,cp,writeFile,readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const root=path.resolve(import.meta.dirname,'..');
const scenario=process.env.ARCIFY_FAVORITE_RECOVERY_CASE||'undo';assert(['undo','confirm','ambiguous','undo-repeat'].includes(scenario));
const scratch=await mkdtemp(path.join(os.tmpdir(),'arcify-favorite-recovery-'));
const extension=path.join(scratch,'extension'),profile=path.join(scratch,'profile');
await cp(path.join(root,'dist'),extension,{recursive:true}); await mkdir(profile);
async function inventory(dir,prefix=''){const entries=[];for(const f of await readdir(dir,{withFileTypes:true})){const name=prefix+f.name;if(f.isDirectory())entries.push(...await inventory(path.join(dir,f.name),name+'/'));else entries.push({path:name,sha256:createHash('sha256').update(await readFile(path.join(dir,f.name))).digest('hex')});}return entries.sort((a,b)=>a.path.localeCompare(b.path));}
await writeFile(path.join(scratch,'build-inventory.json'),JSON.stringify(await inventory(extension),null,2));
const server=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'text/html'});res.end(`<title>Synthetic Favorite ${req.url}</title><h1>Favorite document</h1><input id="draft" value="Preserve this draft"><script>window.documentToken=crypto.randomUUID()</script>`)});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
const report={scenario,scratch,checks:[],limits:['Disposable headless Edge, not Helium or a native sidebar panel.'],disposals:[]};
let browser,id,control;
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function close(){if(!browser)return;const p=browser.process();await browser.close();browser=null;report.disposals.push({pid:p.pid,exitCode:p.exitCode,signalCode:p.signalCode});}
async function launch(){browser=await puppeteer.launch({executablePath:process.env.ARCIFY_DISPOSABLE_BROWSER||'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',headless:true,protocolTimeout:20000,userDataDir:profile,waitForInitialPage:false,ignoreDefaultArgs:['--disable-extensions','about:blank'],args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'--restore-last-session','--no-first-run']});
const worker=await browser.waitForTarget(t=>t.type()==='service_worker'&&t.url().endsWith('/background.js'),{timeout:20000});id=new URL(worker.url()).host;
control=(await browser.pages()).find(p=>p.url()===`chrome-extension://${id}/sidebar.html`);if(!control){control=await browser.newPage();await control.goto(`chrome-extension://${id}/sidebar.html`);}await control.setViewport({width:380,height:850});await pause(1800);}
async function req(action,payload={}){const r=await control.evaluate(async({action,payload})=>{const t=await chrome.tabs.getCurrent();return chrome.runtime.sendMessage({type:'favoriteStore',action,windowId:t.windowId,...payload});},{action,payload});assert.equal(r.success,true,JSON.stringify(r));return r;}
try{await launch();report.browser=await browser.version();console.log('LAUNCHED',report.browser,scratch);
await control.evaluate(()=>chrome.storage.sync.set({ordinaryFavoriteTabs:true,syncTabGroups:false,onboardingCompleted:true,startupLauncherEnabled:false}));
const page=await browser.newPage();await page.goto(base+'/unique');await pause(700);
const tab=await control.evaluate(async url=>(await chrome.tabs.query({})).find(t=>t.url===url),page.url());
await req('addTab',{tabId:tab.id});if(scenario==='ambiguous'){const duplicate=await browser.newPage();await duplicate.goto(base+'/unique');}await pause(1000);report.before=await req('get');
report.hints=await control.evaluate(()=>chrome.storage.local.get('favoriteRestartHints'));console.log('BEFORE',JSON.stringify(report.before),'HINTS',JSON.stringify(report.hints));
await close();await launch();await pause(3000);report.after=await req('get');console.log('AFTER',JSON.stringify(report.after));
if(scenario==='undo-repeat'){await close();await launch();await pause(3000);report.afterSecondRestart=await req('get');report.after=report.afterSecondRestart;}
report.diagnostics=await control.evaluate(async()=>({tabs:await chrome.tabs.query({}),local:await chrome.storage.local.get(['favoriteRestartHints','spaces','spaceTabSnapshot']),session:await chrome.storage.session.get(['favoriteRestartRecovery','favoriteSession'])}));
const row=report.after.favorites.find(r=>r.url===base+'/unique');if(scenario==='ambiguous'){assert.equal(row.tabId,null);assert.equal(row.recovery,undefined);assert.equal((await browser.pages()).filter(p=>p.url()===base+'/unique').length,2);report.checks.push('Duplicate live URL remains manual after full browser restart; no third page created');}else{assert(row?.recovery?.token,'Native browser restart must recover unique page');report.checks.push('Native full browser-process close/relaunch recovered unique Favorite');
const restored=(await browser.pages()).find(p=>p.url()===base+'/unique');assert(restored);const token=await restored.evaluate(()=>({token:window.documentToken,draft:document.querySelector('#draft').value,history:history.length}));
await control.bringToFront();await control.reload();await pause(1200);await control.waitForSelector('.favorite-recovery-card');await control.screenshot({path:path.join(scratch,'recovered.png')});
const buttons=await control.$$eval('.favorite-recovery-card button',es=>es.map(e=>e.textContent));assert.deepEqual(buttons,['Undo','Confirm']);report.checks.push('Rendered recovered card exposes Undo and Confirm');
console.log('UI_SCREENSHOT_DONE');const beforeTabs=await control.evaluate(()=>chrome.tabs.query({}));await control.click(scenario==='confirm'?'.favorite-recovery-card button:nth-of-type(2)':'.favorite-recovery-card button');console.log('REVIEW_CLICK_DONE');await pause(1000);report.undone=await req('get');assert.equal(report.undone.favorites.find(r=>r.id===row.id).tabId,scenario==='confirm'?row.tabId:null);assert.equal(report.undone.favorites.find(r=>r.id===row.id).recovery,undefined);
console.log('REVIEW_READ_DONE',JSON.stringify(report.undone));await restored.bringToFront();assert.deepEqual(await restored.evaluate(()=>({token:window.documentToken,draft:document.querySelector('#draft').value,history:history.length})),token);assert.deepEqual((await control.evaluate(()=>chrome.tabs.query({}))).map(t=>[t.id,t.url]),beforeTabs.map(t=>[t.id,t.url]));report.checks.push(`${scenario} preserved same document, draft, history and exact tab IDs/URLs`);await control.screenshot({path:path.join(scratch,'undone.png')});
}
report.status='passed';
}catch(error){report.status='failed';report.error=String(error.stack);console.error(error);process.exitCode=1;}finally{await close();server.close();await writeFile(path.join(scratch,'receipt.json'),JSON.stringify(report,null,2));console.log('RECEIPT',path.join(scratch,'receipt.json'));}
