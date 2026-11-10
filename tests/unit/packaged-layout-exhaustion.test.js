import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {sealDurableLayout} from '../../durable-today-layout.js';
import {encodeFavoriteContinuityState as encode} from '../../favorite-continuity.js';
import {assertTerminalEvidence,assertNoRevival,assertUnrelatedPreserved} from '../../scripts/packaged-layout-exhaustion-assertions.mjs';
async function fixture(){
 const epoch={kind:'session',epoch:'synthetic'},c={id:'chosen',contextSubset:true,explicitOnly:true,choiceRevision:1,signature:[{index:3,url:'http://127.0.0.1/chosen/0',pinned:false}],placements:[{index:3,spaceId:'target',bookmarkFolderId:'root',order:0}],binding:{epoch,windowId:1,tabIds:[7]},overrides:[]};
 const history={id:'history',signature:[{index:1,url:'http://127.0.0.1/old',pinned:false}],placements:[],binding:null,overrides:[],blockedBy:['chosen']};
 const before=await sealDurableLayout(1,[history,c]),retirement={cohortId:c.id,cohortFingerprint:createHash('sha256').update(encode(c)).digest('hex'),reason:'observed-individual-close',revision:2,closed:[{tabId:7,index:3,witness:{version:1,epoch,incarnation:'inc',transaction:'tx',windowId:1,spaceId:'target',bookmarkFolderId:'root'}}]};
 return {before,beforeSnapshot:[{tabId:7,tabIndex:3,section:'temporaryTabs',currentOwnership:retirement.closed[0].witness}],after:await sealDurableLayout(2,[history,c],null,[retirement])};
}
test('fixture requires real v4 terminal evidence for exact final slot and preserved historical cohort',async()=>{
 const f=await fixture();assert(await assertTerminalEvidence(f.before,f.after,'chosen','history',{beforeSnapshot:f.beforeSnapshot}));
 await assert.rejects(assertTerminalEvidence(f.before,f.before,'chosen','history',{beforeSnapshot:f.beforeSnapshot}),/Real removal/);
});
test('fixture rejects missing/forged receipt and rewritten predecessor',async()=>{
 const f=await fixture();for(const change of [l=>l.retirements[0].closed=[],l=>l.cohorts[0].signature[0].url='changed',l=>l.cohorts[1].placements=[]]){
 const l=structuredClone(f.after);change(l);await assert.rejects(assertTerminalEvidence(f.before,l,'chosen','history',{beforeSnapshot:f.beforeSnapshot}));
 }
});
test('no-revival assertion rejects reassignment and missing fresh tabs',()=>{
 const urls=['http://127.0.0.1/chosen/0'],o={tabs:[{id:70,url:urls[0]}],spaces:[{id:'target',temporaryTabs:[]}]};assertNoRevival(o,'target',urls);
 assert.throws(()=>assertNoRevival({...o,tabs:[]},'target',urls));o.spaces[0].temporaryTabs.push(70);assert.throws(()=>assertNoRevival(o,'target',urls),/revive/);
});
test('hosted fixture uses owned profile, production APIs, observed restart, and normal sandbox only',async()=>{
 const source=await readFile(new URL('../../scripts/packaged-layout-exhaustion.mjs',import.meta.url),'utf8');
 for(const required of ["process.env.GITHUB_ACTIONS","mkdtemp(","userDataDir:profile","browser.installExtension(extension)","moveTodayTabsToSpace","chrome.tabs.remove(ids)","restartObservedBrowser(","assertTerminalEvidence(","assertNoRevival(","validateChromeNamespaceSandboxStatus(","receipt.profileRemoved=false"] )assert(source.includes(required),required);
 for(const forbidden of ['puppeteer.connect','--no-sandbox','--disable-setuid-sandbox','--disable-web-security','Debugger.pause','runtime.reload','stageDurableExhaustion(','observeDurableIndividualClose('])assert(!source.includes(forbidden),forbidden);
 assert.match(source,/Array\.from\(\{length:1\}/);assert(!source.includes('process.kill('));
});
test('workflow is bounded, exact-head, locked existing runtime, and uploads no profile',async()=>{
 const source=await readFile(new URL('../../.github/workflows/layout-exhaustion-lifecycle.yml',import.meta.url),'utf8');
 for(const required of ['contents: read','timeout-minutes: 10','github.event.pull_request.head.sha','persist-credentials: false','PUPPETEER_SKIP_DOWNLOAD','npm ci --prefix scripts/paired-chrome-runtime','xvfb-run --auto-servernum node scripts/packaged-layout-exhaustion.mjs','path: test-results/layout-exhaustion/','if: always()'])assert(source.includes(required),required);
 for(const forbidden of ['sudo ','chmod','sysctl','--no-sandbox','path: /tmp','workflow_dispatch'])assert(!source.includes(forbidden),forbidden);
});
test('validly sealed but different terminal incarnation is rejected against actual preclose witness',async()=>{
 const f=await fixture(),retirements=structuredClone(f.after.retirements);retirements[0].closed[0].witness.incarnation='different';
 const forged=await sealDurableLayout(f.after.revision,f.after.cohorts,null,retirements);
 await assert.rejects(assertTerminalEvidence(f.before,forged,'chosen','history',{beforeSnapshot:f.beforeSnapshot}),/exact preclose/);
});
test('unrelated anchor identity and ownership must survive exact close boundary',()=>{
 const before={tabs:[{id:2,windowId:1,index:0,url:'anchor',pinned:false}],spaces:[{id:'source',temporaryTabs:[2]}]};assertUnrelatedPreserved(before,structuredClone(before),'anchor');
 for(const change of [o=>o.tabs[0].id=3,o=>o.tabs[0].windowId=2,o=>o.spaces[0].temporaryTabs=[]]){const after=structuredClone(before);change(after);assert.throws(()=>assertUnrelatedPreserved(before,after,'anchor'));}
});

test('actual Today receiver rejects cross-window options sender before any move',async()=>{
 const {fixture}=await import('./today-recovery-fixture.js');const {registerTodayMoveMessages}=await import('../../today-move-store.js');
 const f=fixture();registerTodayMoveMessages(f.store);const before=structuredClone(f.store.spaces),effects=f.effects.length;let reply;
 const keep=f.listeners.at(-1)(f.request,{id:'test',url:'chrome-extension://test/options.html',origin:'chrome-extension://test',tab:{id:700,windowId:20}},r=>{reply=r;});
 assert.equal(keep,undefined);assert.deepEqual(reply,{success:false,error:'Invalid Today move sender.'});assert.deepEqual(f.store.spaces,before);assert.equal(f.effects.length,effects);
});
test('actual Today receiver accepts legitimate same-window options sender',async()=>{
 const {fixture}=await import('./today-recovery-fixture.js');const {registerTodayMoveMessages}=await import('../../today-move-store.js');
 const f=fixture();registerTodayMoveMessages(f.store);
 const reply=await new Promise(resolve=>{assert.equal(f.listeners.at(-1)(f.request,{id:'test',url:'chrome-extension://test/options.html',origin:'chrome-extension://test',tab:{id:700,windowId:10}},resolve),true);});
 assert.equal(reply.success,true,reply.error);assert(f.store.spaces.find(s=>s.id==='target').temporaryTabs.includes(1));assert(f.store.spaces.find(s=>s.id==='target').temporaryTabs.includes(3));
});
test('packaged controller is placed and freshly reverified before each Move without sender spoofing',async()=>{
 const source=await readFile(new URL('../../scripts/packaged-layout-exhaustion.mjs',import.meta.url),'utf8');
 for(const required of ["location.href!==chrome.runtime.getURL('options.html')","chrome.tabs.move(current.id,{windowId,index:-1})","fresh.id!==current.id||fresh.windowId!==windowId","sender.windowId!==windowId","receipt.moveSenders"])assert(source.includes(required),required);
 assert(source.indexOf('chrome.tabs.move(current.id')<source.indexOf("const r=await chrome.runtime.sendMessage({type:'moveTodayTabsToSpace'"));
 for(const forbidden of ['registerTodayMoveMessages(',"sender:{",'sidebar.html','__layoutOpenPanel'])assert(!source.includes(forbidden),forbidden);
});
