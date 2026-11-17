// One isolated hosted-only native Chrome observation. No sandbox fallback.
import assert from 'node:assert/strict';
import { verifyDist, assertPickerReadout } from './checks.mjs';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import puppeteer from '../paired-chrome-runtime/index.mjs';
import { snapshotChromeLaunchOptions } from '../paired-chrome-browser-restart.mjs';
import { CHROME_EXECUTABLE, inspectInstalledChromeRuntime, inspectChromeProcessRuntime,
    validateChromeLaunchArguments, validateNamespaceLaunchEnvironment, validateChromeNamespaceSandboxStatus } from '../paired-chrome-sandbox.mjs';
assert.equal(process.env.GITHUB_ACTIONS, 'true'); assert.equal(process.env.CI, 'true');
validateNamespaceLaunchEnvironment(process.env, process.getuid?.());
const output=resolve('test-results/hosted-restored-trace'); await mkdir(output,{recursive:true});
const report={status:'running',scope:'Native Chromium QA restored-match picker trace, not Windows/Helium acceptance',checkpoints:[],input:'Trusted native sidebar pin/picker/Cancel; synthetic same-session receipt-loss setup explicitly recorded'};
const save=()=>writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2));
const poll=async(fn,predicate,label)=>{const start=Date.now();while(Date.now()-start<20000){const value=await fn();if(predicate(value))return value;await new Promise(r=>setTimeout(r,100));}throw new Error(`Timed out: ${label}`);};
let browser, server;
try {
    report.dist=await verifyDist(resolve('dist'),resolve('scripts/hosted-restored-trace/expected-dist.sha256'));
    report.runtime=await inspectInstalledChromeRuntime(CHROME_EXECUTABLE);
    const profile=await mkdtemp(resolve(process.env.RUNNER_TEMP||tmpdir(),'highlight-'));
    const launch=snapshotChromeLaunchOptions({channel:'chrome',headless:false,pipe:true,enableExtensions:true,dumpio:true,userDataDir:profile,timeout:60000,protocolTimeout:30000,defaultViewport:{width:1280,height:900},args:['--restore-last-session']});
    validateChromeLaunchArguments(await puppeteer.defaultArgs(structuredClone(launch)));
    browser=await puppeteer.launch(structuredClone(launch));
    assert.equal(browser.process().spawnfile,CHROME_EXECUTABLE);
    validateChromeLaunchArguments(browser.process().spawnargs);
    report.process=await inspectChromeProcessRuntime(browser.process().pid);
    report.version=await browser.version();assert.equal(report.version,`Chrome/${report.runtime.package.browserVersion}`);
    const sandbox=await browser.newPage();await sandbox.goto('chrome://sandbox/');
    await sandbox.waitForFunction(()=>document.querySelector('#sandbox-status tr')&&document.getElementById('evaluation')?.textContent.trim());
    report.sandbox=await sandbox.evaluate(()=>({url:location.href,title:document.title,bodyText:document.body.innerText,evaluation:document.getElementById('evaluation')?.textContent||'',rows:[...document.querySelectorAll('#sandbox-status tr')].map(row=>{const c=row.querySelectorAll('td');return{name:c[0]?.textContent||'',value:c[1]?.textContent||''};})}));
    await sandbox.screenshot({path:resolve(output,'sandbox.png')});await save();
    validateChromeNamespaceSandboxStatus(report.sandbox);await sandbox.close();
    const id=await browser.installExtension(resolve('dist'));report.extensionId=id;
    await browser.waitForTarget(t=>t.type()==='service_worker'&&t.url()===`chrome-extension://${id}/background.js`);
    let api=await browser.newPage();await api.goto(`chrome-extension://${id}/options.html`);
    await poll(()=>api.evaluate(()=>chrome.runtime.sendMessage({type:'spaceStore',action:'get'})),r=>r.success&&r.spaces?.some(s=>s.bookmarkFolderId),'initialized SpaceStore');
    for(const page of await browser.pages())if(page.url().includes('/installation-onboarding.html'))await page.close();
    const pages={
        '/first':'<!doctype html><title>First synthetic pane</title><h1>First synthetic pane</h1>',
        '/second':'<!doctype html><title>Second synthetic pane</title><h1>Second synthetic pane</h1>',
        '/neutral':'<!doctype html><title>Neutral synthetic control</title><h1>Neutral synthetic control</h1>'
    };
    server=createServer((req,res)=>{const body=pages[req.url];res.writeHead(body?200:404,{'content-type':'text/html','cache-control':'no-store'});res.end(body||'Not found');});
    await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
    let fixture=await api.evaluate(async base=>{
        await chrome.storage.sync.set({syncTabGroups:false});
        const response=await chrome.runtime.sendMessage({type:'spaceStore',action:'get'});if(!response.success)throw new Error(response.error);
        const space=response.spaces.find(s=>s.bookmarkFolderId);if(!space)throw new Error('No owned Space');
        const window=await chrome.windows.create({type:'normal',url:[`${base}/first`,`${base}/second`,`${base}/neutral`],focused:true});
        const tabs=await chrome.tabs.query({windowId:window.id});
        const ids=['/first','/second','/neutral'].map(suffix=>tabs.find(t=>(t.url||t.pendingUrl)===`${base}${suffix}`)?.id);if(ids.some(id=>!Number.isSafeInteger(id)))throw new Error('Missing synthetic tabs');
        for(const tabId of ids){const r=await chrome.runtime.sendMessage({type:'spaceStore',action:'assign',tabId,spaceId:space.id});if(!r.success)throw new Error(r.error);}
        const activation=await chrome.runtime.sendMessage({type:'spaceStore',action:'activate',windowId:window.id,spaceId:space.id});if(!activation.success)throw new Error(activation.error);
        globalThis.highlightPanelEvents=[];chrome.sidePanel.onOpened.addListener(info=>globalThis.highlightPanelEvents.push(info));
        const button=document.createElement('button');button.id='open-highlight-panel';button.textContent='Open test sidebar';button.style='position:fixed;top:0;left:0;z-index:2147483647';button.addEventListener('click',()=>chrome.sidePanel.open({windowId:window.id}));document.body.appendChild(button);
        return{windowId:window.id,spaceId:space.id,bookmarkFolderId:space.bookmarkFolderId,ids};
    },base);report.fixture=fixture;
    await poll(()=>api.evaluate(windowId=>chrome.tabs.query({windowId}),fixture.windowId),tabs=>tabs.length===3&&tabs.every(t=>t.status==='complete'&&!t.pendingUrl),'three settled fixture tabs');
    const split=await api.evaluate(async ids=>{if(typeof chrome.tabs.createSplit!=='function')throw new Error('Native createSplit unavailable');return chrome.tabs.createSplit(ids);},fixture.ids.slice(0,2));report.nativeSplit=split;
    await api.bringToFront();await api.click('#open-highlight-panel');
    report.panelOpened=await poll(()=>api.evaluate(async()=>({events:globalThis.highlightPanelEvents,contexts:await chrome.runtime.getContexts({contextTypes:['SIDE_PANEL']})})),s=>s.events.some(e=>e.windowId===fixture.windowId)&&s.contexts.some(c=>c.documentUrl===`chrome-extension://${id}/sidebar.html`),'native panel opened/context');
    const target=await browser.waitForTarget(t=>t.url()===`chrome-extension://${id}/sidebar.html`);let panel=await target.asPage();
    report.panel=await panel.evaluate(async()=>({tab:await chrome.tabs.getCurrent()||null,windowId:(await chrome.windows.getCurrent()).id,contexts:await chrome.runtime.getContexts({contextTypes:['SIDE_PANEL']})}));
    assert.equal(report.panel.tab,null);assert.equal(report.panel.windowId,fixture.windowId);
    assert.equal(report.panel.contexts.filter(c=>c.documentUrl===`chrome-extension://${id}/sidebar.html`).length,1,'Exactly one native panel context');
    const browserTabIds=await api.evaluate(async()=>(await chrome.tabs.query({})).map(t=>t.id).sort((a,b)=>a-b));
    report.browserTabIds=browserTabIds;
    assert.equal((await api.evaluate(()=>chrome.tabs.query({}))).filter(t=>t.url===`chrome-extension://${id}/sidebar.html`).length,0);
    const todayId=fixture.ids[0], today=`.space.active [data-tab-type="temporary"] .tab[data-tab-id="${todayId}"]`;
    await panel.waitForSelector(today,{visible:true});await panel.click(today,{button:'right'});
    await panel.waitForSelector('#tab-context-menu [data-action="saveSplitView"]',{visible:true});await panel.click('#tab-context-menu [data-action="saveSplitView"]');
    const pin=await poll(()=>api.evaluate(async()=>{const s=(await chrome.storage.local.get('splitPinsV1')).splitPinsV1;return s?.pins?.find(p=>p.phase==='committed');}),p=>!!p?.bookmarkId,'committed exact pin');
    const selector=`.space.active .split-pin[data-bookmark-id="${pin.bookmarkId}"]`;
    await panel.waitForSelector(`${selector}[data-split-live="true"]`,{visible:true});
    // Deliberately model receipt loss in this fresh synthetic fixture, not a
    // cold restore: retain the saved native-ID hint and SAME session nonce.
    await poll(()=>api.evaluate(async bookmarkId=>{const d=await chrome.storage.local.get('splitPinRestoredHintsV1');return d.splitPinRestoredHintsV1?.records?.some(r=>r.bookmarkId===bookmarkId);},pin.bookmarkId),Boolean,'hint saved off-path');
    await api.evaluate(async({windowId,bookmarkId})=>{const d=await chrome.storage.session.get('splitPinInstancesV1');const w=d.splitPinInstancesV1||{};delete w[`${windowId}:${bookmarkId}`];await chrome.storage.session.set({splitPinInstancesV1:w});},{windowId:fixture.windowId,bookmarkId:pin.bookmarkId});
    report.syntheticSetup='Removed fixture strong witness only; session nonce and saved hint preserved. This is NOT cold-restore evidence.';
    await panel.waitForSelector(`${selector}[data-split-live="false"]`,{visible:true});
    const conservation=()=>api.evaluate(async()=>({tabs:(await chrome.tabs.query({})).map(({id,windowId,splitViewId,index,active})=>({id,windowId,splitViewId,index,active})).sort((a,b)=>a.id-b.id),session:await chrome.storage.session.get(['splitPinInstancesV1','splitPinFocusLinksV1','splitPinRestoredHintSessionV1','splitPinRestoredHintSuppressionV1']),local:await chrome.storage.local.get(['spaces','splitPinsV1','savedSplitRecipesV1','splitPinRestoredHintsV1'])}));
    const todayState=()=>panel.evaluate(ids=>ids.map(id=>document.querySelectorAll(`.space.active [data-tab-type="temporary"] .tab[data-tab-id="${id}"]`).length),fixture.ids.slice(0,2));
    async function inspectPicker(label,expectedReason=null) {
        await poll(todayState,s=>s.every(n=>n===1),'both original panes in Today');
        const before=await conservation(),todayBefore=await todayState();
        await panel.click(selector,{button:'right'});await panel.waitForSelector('#tab-context-menu [data-action="attachSplitView"]',{visible:true});await panel.click('#tab-context-menu [data-action="attachSplitView"]');
        await panel.waitForSelector('dialog .qa-restored-hint-trace');
        const read=()=>panel.evaluate(()=>({text:document.querySelector('.qa-restored-hint-decision')?.textContent||'',collapsed:!document.querySelector('.qa-restored-hint-trace')?.open,candidateCount:document.querySelectorAll('dialog input[type="radio"]').length,checked:[...document.querySelectorAll('dialog input[type="radio"]')].some(r=>r.checked),confirmDisabled:[...document.querySelectorAll('dialog button')].find(b=>b.textContent==='Link selected pair for focus')?.disabled===true,badgeCount:document.querySelectorAll('dialog .split-pin-possible-restored-match').length}));
        const state=await read();assertPickerReadout(state,expectedReason);
        // Expanding a disclosure is the only interaction before Cancel. Never
        // check a radio, confirm an attach, or manufacture worker output.
        await panel.click('dialog .qa-restored-hint-trace summary');
        await panel.screenshot({path:resolve(output,`${label}-trace.png`)});
        const cancel=await panel.evaluateHandle(()=>[...document.querySelectorAll('dialog button')].find(b=>b.textContent==='Cancel'));await cancel.asElement().click();await cancel.dispose();
        await panel.waitForSelector('dialog',{hidden:true});
        const after=await conservation();assert.deepEqual(after,before,'Readout/Cancel must not mutate native state, storage, selection or receipt');assert.deepEqual(await todayState(),todayBefore);
        report.checkpoints.push({label,...state,cancelPreserved:true,today:todayBefore});await save();return state;
    }
    await inspectPicker('same-session','same-or-invalid-session');
    // Explicit synthetic session-boundary control, NOT a browser restart.
    // Keep the native pair and saved hint exactly as observed; remove only
    // the named session nonce in this disposable synthetic fixture.
    const boundaryBefore=await conservation();
    assert.equal(typeof boundaryBefore.session.splitPinRestoredHintSessionV1,'string');
    await api.evaluate(()=>chrome.storage.session.remove('splitPinRestoredHintSessionV1'));
    const boundaryAfter=await conservation();
    const expectedBoundary=structuredClone(boundaryBefore);
    delete expectedBoundary.session.splitPinRestoredHintSessionV1;
    assert.deepEqual(boundaryAfter,expectedBoundary,'Synthetic boundary changes only the named nonce');
    report.syntheticBoundary={removedOnly:'splitPinRestoredHintSessionV1',nativePairAndSavedHintPreserved:true,realRestart:false};
    await inspectPicker('simulated-session-boundary','suggested');
    report.cold={status:'not-attempted',reason:'Synthetic session-boundary control only; no real cold or unloaded coverage'};
    report.status='passed-synthetic-negative-and-positive-controls';
} catch(error) {report.status='failed';report.error={message:error.message,stack:error.stack};throw error;}
finally {await save();await browser?.close();if(server)await new Promise(r=>server.close(r));}
