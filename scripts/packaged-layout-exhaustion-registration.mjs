// One legitimate full-extension reload during fresh-profile SETUP only. Chrome156
// discards CDP-installed registrations at startup; normal unpacked reload uses
// its persistent installer. A separate real browser preflight must prove this.
import assert from 'node:assert/strict';
import {reloadObservedExtension,requestObservedExtensionReload,findExactWorkerTarget} from './paired-chrome-worker.mjs';
import {findInstalledExtension} from './paired-chrome-extensions.mjs';
import {waitForExactRestartRegistry} from './packaged-layout-exhaustion-registry.mjs';
export function assertPersistentSetupBeforeScenario(evidence){
 assert.equal(evidence?.reloadObserved,true,'Full extension unload/replacement proof is required');
 assert.equal(evidence?.preflightRestart,'passed','A real pre-seed browser restart must preserve registration');
 assert.equal(evidence?.packageUnchanged,true,'Production source copy must remain unchanged');
 assert.equal(evidence?.scenarioStarted,false,'Registration preparation must precede all synthetic scenario seeds');
}
export async function reloadPackagedExtensionForPersistence({browser,control,expected,record=async()=>{}}){
 const url=`chrome-extension://${expected.id}/background.js`,events=[];
 const targets=await browser.target().createCDPSession(),view=await control.createCDPSession();
 const contexts=new Set();let invalidated=false;
 const created=event=>{if(event.context.auxData?.isDefault)contexts.add(event.context.id);};
 const destroyed=event=>{if(contexts.has(event.executionContextId))invalidated=true;};
 const cleared=()=>{if(contexts.size)invalidated=true;};
 view.on('Runtime.executionContextCreated',created);view.on('Runtime.executionContextDestroyed',destroyed);view.on('Runtime.executionContextsCleared',cleared);
 const registry=async()=>{const session=await browser.target().createCDPSession();try{return (await session.send('Extensions.getExtensions')).extensions;}finally{await session.detach();}};
 try{
  const before=await registry();assert.equal(findInstalledExtension(before,expected).enabled,true);
  await control.evaluate(async()=>{const reply=await chrome.runtime.sendMessage({type:'spaceStore',action:'get'});if(!reply.success)throw Error(reply.error);});
  const target=await browser.waitForTarget(t=>t.type()==='service_worker'&&t.url()===url),worker=await target.worker();
  await view.send('Runtime.enable');assert(contexts.size>0,'Original options realm must be observed before reload');
  const old=await reloadObservedExtension({url,readTargets:async()=>(await targets.send('Target.getTargets')).targetInfos,
   releaseObservers:()=>worker.client.detach(),
   reload:()=>requestObservedExtensionReload(control,(_page,_label,action)=>action(),{name:'Arcify setup'}),
   viewInvalidated:async()=>control.isClosed()||invalidated,
   record:async event=>{events.push(event);await record({phase:'setup-extension-reload',event});}});
  assert(events.some(e=>e.phase==='reload-observed'));
  await waitForExactRestartRegistry({read:registry,before,expected,record:entries=>record({phase:'setup-reloaded-registry',entries})});
  const replacement=await browser.newPage();await replacement.goto(`chrome-extension://${expected.id}/options.html`);
  const identity=await replacement.evaluate(async()=>{const reply=await chrome.runtime.sendMessage({type:'spaceStore',action:'get'});if(!reply.success)throw Error(reply.error);return {id:chrome.runtime.id,manifest:chrome.runtime.getManifest()};});
  assert.equal(identity.id,expected.id);assert.equal(identity.manifest.name,expected.name);assert.equal(identity.manifest.version,expected.version);
  await browser.waitForTarget(t=>t.type()==='service_worker'&&t.url()===url);
  const next=findExactWorkerTarget((await targets.send('Target.getTargets')).targetInfos,url);assert.notEqual(next.targetId,old.targetId,'Full extension reload requires a replacement worker');
  if(!control.isClosed())await control.close();
  await record({phase:'setup-reload-complete',oldTargetId:old.targetId,newTargetId:next.targetId,identity:{id:identity.id,name:identity.manifest.name,version:identity.manifest.version}});
  return {control:replacement,reloadObserved:true};
 }finally{
  view.off('Runtime.executionContextCreated',created);view.off('Runtime.executionContextDestroyed',destroyed);view.off('Runtime.executionContextsCleared',cleared);
  await view.detach().catch(error=>record({phase:'setup-view-detach',message:error.message}));await targets.detach();
 }
}
