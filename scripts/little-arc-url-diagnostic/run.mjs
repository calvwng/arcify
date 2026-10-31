import assert from 'node:assert/strict';
import {mkdtemp,mkdir,cp,writeFile,readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import http from 'node:http';
import puppeteer from '../paired-chrome-runtime/index.mjs';
import {CHROME_EXECUTABLE,inspectInstalledChromeRuntime,inspectChromeProcessRuntime,validateChromeLaunchArguments,validateNamespaceLaunchEnvironment,validateChromeNamespaceSandboxStatus} from '../paired-chrome-sandbox.mjs';
const HERE=dirname(fileURLToPath(import.meta.url)),ROOT=resolve(HERE,'../..'),SPOT=resolve(process.argv[2]||'');
const EXPECTED=new Set(['76559fbeaacc055ff7f987c0adf5b8b630820ada','b8b193c1f803179f86ab2e2397e5f1169256f49d']);
const MODE=process.env.DIAGNOSTIC_MODE||'baseline';assert(['baseline','candidate'].includes(MODE));
assert.equal(process.env.GITHUB_ACTIONS,'true');assert.equal(process.env.CI,'true');
assert.equal(process.env.GITHUB_REPOSITORY,'calvwng/arcify');assert.equal(process.env.GITHUB_REF,'refs/heads/diagnostics/little-arc-url-20261031');
assert(EXPECTED.has(process.env.SPOTLIGHT_SHA));assert(process.argv[2]);
const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8'}).trim();
assert.equal(git(SPOT,'rev-parse','HEAD'),process.env.SPOTLIGHT_SHA);
assert.equal(git(ROOT,'rev-parse','HEAD'),process.env.GITHUB_SHA);
assert.equal(git(SPOT,'status','--porcelain'),'');
const OUTPUT=join(ROOT,'test-results/little-arc-url-diagnostic');await mkdir(OUTPUT,{recursive:true});
const report={scope:'Synthetic browser metadata and unchanged Spotlight broker hello only; not a reproduction of the user YouTube incident or full product launch.',provenance:{arcify:git(ROOT,'rev-parse','HEAD'),spotlight:git(SPOT,'rev-parse','HEAD'),historicalDeployedSpotlight:'76559fbeaacc055ff7f987c0adf5b8b630820ada',existingHostedPin:'b8b193c1f803179f86ab2e2397e5f1169256f49d'},attempts:[],status:'running'};
const save=()=>writeFile(join(OUTPUT,'report.json'),JSON.stringify(report,null,2));
const hash=async p=>createHash('sha256').update(await readFile(p)).digest('hex');
async function inventory(dir,prefix=''){const result={};for(const e of await readdir(dir,{withFileTypes:true})){const key=prefix+e.name;if(e.isDirectory())Object.assign(result,await inventory(join(dir,e.name),key+'/'));else if(e.isFile())result[key]=await hash(join(dir,e.name));else throw Error('Unexpected non-regular source entry')}return result}
const original=await inventory(join(SPOT,'shared'));report.provenance.sharedHashes=original;
report.mode=MODE;
report.scope=`Synthetic browser metadata and ${MODE==='candidate'?'reviewed candidate':'unchanged Spotlight'} broker hello only; not the user's Helium/YouTube session or a full product launch.`;
const scratch=await mkdtemp(join(process.env.RUNNER_TEMP||tmpdir(),'little-arc-url-'));
const probe=join(scratch,'probe'),peer=join(scratch,'peer');await mkdir(probe);await mkdir(peer);
await cp(join(SPOT,'shared'),join(probe,'shared'),{recursive:true});assert.deepEqual(await inventory(join(probe,'shared')),original);
const effective={...original};
if(MODE==='candidate'){
 assert.equal(git(SPOT,'rev-parse','HEAD:shared/peek-broker.js'),'49006af99699d959bbbe1235d68583d89bca5bc1');
 await cp(join(HERE,'candidate/peek-broker.js'),join(probe,'shared/peek-broker.js'));
 effective['peek-broker.js']=await hash(join(HERE,'candidate/peek-broker.js'));
 report.provenance.candidateBrokerSha256=effective['peek-broker.js'];
}
assert.deepEqual(await inventory(join(probe,'shared')),effective);
for(const file of ['worker.js','content.js'])await cp(join(HERE,file),join(probe,file));
await cp(join(HERE,'companion.js'),join(peer,'worker.js'));
const manifest={manifest_version:3,version:'1.0',permissions:['storage','tabs','webNavigation'],host_permissions:['http://127.0.0.1/*'],background:{service_worker:'worker.js',type:'module'}};
await writeFile(join(probe,'manifest.json'),JSON.stringify({...manifest,name:'Little Arc URL diagnostic broker',content_scripts:[{matches:['http://127.0.0.1/*'],js:['content.js'],run_at:'document_idle'}]}));
await writeFile(join(peer,'manifest.json'),JSON.stringify({manifest_version:3,version:'1.0',name:'Little Arc synthetic capability peer',permissions:['storage'],background:{service_worker:'worker.js'}}));
for(const dir of [probe,peer])await writeFile(join(dir,'probe.html'),'<!doctype html><title>Synthetic diagnostic control</title>');
const server=http.createServer((request,response)=>{response.writeHead(200,{'Content-Type':'text/html','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; script-src 'none'; frame-src 'none'; connect-src 'none'"});response.end('<!doctype html><title>Synthetic same-document navigation</title><p>Local diagnostic fixture</p>')});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
let browser,child,exitPromise;
const bounded=async(p,ms,label)=>{let timer;try{return await Promise.race([p,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error(label)),ms))])}finally{clearTimeout(timer)}};
try{
 validateNamespaceLaunchEnvironment(process.env,process.getuid?.());
 const executable=await puppeteer.executablePath('chrome');assert.equal(executable,CHROME_EXECUTABLE);
 report.runtime=await inspectInstalledChromeRuntime(executable);
 const launch={channel:'chrome',headless:false,pipe:true,enableExtensions:true,userDataDir:join(scratch,'profile'),timeout:60000,protocolTimeout:15000,defaultViewport:{width:1000,height:700}};
 validateChromeLaunchArguments(await puppeteer.defaultArgs(structuredClone(launch)));await save();
 browser=await puppeteer.launch(structuredClone(launch));child=browser.process();
 exitPromise=new Promise(resolve=>child.once('exit',(code,signal)=>{report.rootExit={pid:child.pid,code,signal};resolve(report.rootExit)}));
 assert.equal(child.spawnfile,CHROME_EXECUTABLE);validateChromeLaunchArguments(child.spawnargs);
 report.process=await inspectChromeProcessRuntime(child.pid);report.version=await browser.version();
 assert.equal(report.version,`Chrome/${report.runtime.package.browserVersion}`);
 const sandbox=await browser.newPage();await sandbox.goto('chrome://sandbox/',{waitUntil:'domcontentloaded'});
 await sandbox.waitForFunction(()=>document.querySelector('#sandbox-status tr')&&document.getElementById('evaluation')?.textContent.trim());
 const status=await sandbox.evaluate(()=>({url:location.href,evaluation:document.getElementById('evaluation').textContent,rows:[...document.querySelectorAll('#sandbox-status tr')].map(row=>{const c=row.querySelectorAll('td');return{name:c[0]?.textContent||'',value:c[1]?.textContent||''}})}));
 report.sandbox=validateChromeNamespaceSandboxStatus(status);await sandbox.close();
 const peerId=await browser.installExtension(peer),probeId=await browser.installExtension(probe);report.extensions={peerId,probeId};
 const control=await browser.newPage();await control.goto(`chrome-extension://${probeId}/probe.html`);
 await control.evaluate(async peerId=>chrome.storage.local.set({peekEnabled:true,peekIframeEnabled:false,arcifyBridgePeerId:peerId,arcifyBridgePairingGeneration:'synthetic-diagnostic-v1'}),peerId);
 const peerControl=await browser.newPage();await peerControl.goto(`chrome-extension://${peerId}/probe.html`);
 const requests=()=>peerControl.evaluate(async()=>((await chrome.storage.session.get('requests')).requests||[]));
 const page=await browser.newPage();await page.goto(base+'/initial',{waitUntil:'domcontentloaded'});await page.bringToFront();
 async function run(label){
  await page.waitForFunction(()=>document.documentElement.dataset.diagnosticReady==='yes');
  const before=(await requests()).length;
  await page.evaluate(label=>{document.documentElement.dataset.diagnosticLabel=label;document.dispatchEvent(new Event('diagnostic-connect'))},label);
  await page.waitForFunction(label=>{try{return JSON.parse(document.documentElement.dataset.diagnosticResult).label===label}catch{return false}},{timeout:12000},label);
  const row=await page.evaluate(()=>JSON.parse(document.documentElement.dataset.diagnosticResult));
  row.peerRequests=(await requests()).slice(before);report.attempts.push(row);await save();
  assert(!row.diagnosticError,JSON.stringify(row));assert(row.broker.length);
  const port=row.broker.at(-1);assert(!port.snapshotError,JSON.stringify(port));
  assert.equal(port.sender.documentId,row.frame.documentId);assert.equal(port.sender.frameId,0);
  assert.equal(row.tab.url,row.contentUrl);assert.equal(row.frame.url,row.contentUrl);
  assert.deepEqual(port.messages,[{kind:'hello'}]);
  assert(['ready','error','disconnect'].includes(row.outcome.kind),JSON.stringify(row.outcome));
  if(MODE==='candidate'){assert.equal(row.outcome.kind,'ready');assert.equal(row.peerRequests.length,1);}
  assert(row.peerRequests.every(r=>r.type==='arcify-peek-v1'&&r.action==='capability'));
  row.classification=port.sender.url===row.tab.url?'current-sender-url':'stale-sender-url';
  console.log(JSON.stringify({label,classification:row.classification,senderUrl:port.sender.url,currentUrl:row.tab.url,documentId:port.sender.documentId,outcome:row.outcome.kind,capabilityRequests:row.peerRequests.length}));
  await save();return row;
 }
 const initial=await run('initial');assert.equal(initial.outcome.kind,'ready');
 for(const method of ['pushState','replaceState']){
  await page.evaluate(method=>history[method]({},'', '/'+method),method);
  // Wait for browser-owned tab URL to catch up before the first handshake.
  await control.waitForFunction(async expected=>(await chrome.tabs.query({})).some(t=>t.url===expected&&!t.pendingUrl),{},base+'/'+method);
  await control.waitForFunction(async url=>(await chrome.runtime.sendMessage({type:'diagnosticUrlObserved',url})).observed,{},base+'/'+method);
  const row=await run(method);assert.equal(row.frame.documentId,initial.frame.documentId);
  const retry=await run(method+'-reconnect');assert.equal(retry.frame.documentId,initial.frame.documentId);
 }
 await page.reload({waitUntil:'domcontentloaded'});const refreshed=await run('refresh');
 assert.notEqual(refreshed.frame.documentId,initial.frame.documentId);assert.equal(refreshed.outcome.kind,'ready');
 report.documentRouteChecks=await control.evaluate(async ({tabId,oldDocument,newDocument})=>{
  const route=async target=>{try{return{resolved:true,value:await chrome.tabs.sendMessage(tabId,{type:'arcifyPeekLiveProbe'},target)}}catch(error){return{resolved:false,error:String(error)}}};
  return{oldDocument:await route({documentId:oldDocument,frameId:0}),wrongFrame:await route({documentId:newDocument,frameId:42}),currentDocument:await route({documentId:newDocument,frameId:0})};
 },{tabId:refreshed.tab.id,oldDocument:initial.frame.documentId,newDocument:refreshed.frame.documentId});
 assert.equal(report.documentRouteChecks.oldDocument.resolved,false);assert.equal(report.documentRouteChecks.wrongFrame.resolved,false);assert.equal(report.documentRouteChecks.currentDocument.resolved,true);
 assert.equal(report.documentRouteChecks.currentDocument.value.url,refreshed.contentUrl);
 console.log(JSON.stringify({documentRouteChecks:report.documentRouteChecks}));
 const calls=await requests();assert(calls.every(r=>r.action==='capability'));report.peerRequestCount=calls.length;
 assert.deepEqual(await inventory(join(SPOT,'shared')),original);assert.deepEqual(await inventory(join(probe,'shared')),effective);
 report.status='complete';
}catch(error){report.status='failed';report.error={message:String(error),stack:error.stack};process.exitCode=1;}
finally{
 try{if(browser){await bounded(Promise.all([browser.close(),exitPromise]),15000,'Owned root exit not confirmed');assert.equal(report.rootExit?.code,0);assert.equal(report.rootExit?.signal,null);report.cleanup='owned root clean exit observed';}else report.cleanup='launch did not return a browser handle; no cleanup claim';}
 catch(error){report.cleanupError=String(error);report.status='failed';process.exitCode=1;}
 await new Promise(r=>server.close(r));report.serverClosed=!server.listening;await save();console.log(JSON.stringify({status:report.status,cleanup:report.cleanup,error:report.error,cleanupError:report.cleanupError}));
}
