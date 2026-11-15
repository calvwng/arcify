// Read-only CDP diagnostic access to the already-running unique Arcify worker.
// No service-worker wake, production message, storage write, or convergence poll.
export async function readProjectionAudit(browser,arcifyId,{arm=false,disarm=false,afterSequence=0,workerId=null}={}) {
 const targets=browser.targets().filter(t=>t.type()==='service_worker'&&t.url().startsWith(`chrome-extension://${arcifyId}/`));
 if(targets.length!==1)return {gap:'No unique existing worker',count:targets.length};
 try {
  const worker=await targets[0].worker();
  return await worker.evaluate(({arm,disarm,afterSequence,workerId})=>{
   if(typeof globalThis.__readProjectionAudit!=='function')return {gap:'Observer absent in this worker'};
   if(arm)globalThis.__projectionAuditArmed=true;
   if(disarm)globalThis.__projectionAuditArmed=false;
   const r=globalThis.__readProjectionAudit();const changed=workerId!==null&&workerId!==r.workerId;return {...r,workerChanged:changed,events:r.events.filter(e=>e.sequence>(changed?0:afterSequence))};
  },{arm,disarm,afterSequence,workerId});
 }catch(error){return {gap:error.message};}
}
export async function exerciseCase43Diagnostic({browser,arcifyId,report,saveReport},exercise,options) {
 const journal=report.case43Projection={scope:'Read-only instrumented timing; original suite/assertions unchanged',samples:[],truncated:false};
 let workerId=null,afterSequence=0,bytes=0;
 const capture=async phase=>{
  const sample=await readProjectionAudit(browser,arcifyId,{arm:true,workerId,afterSequence});
  workerId=sample.workerId||workerId;afterSequence=sample.sequence??afterSequence;
  const value={phase,at:Date.now(),...sample},size=JSON.stringify(value).length;
  if(bytes+size<=8388608){journal.samples.push(value);bytes+=size;}else journal.truncated=true;
 };
 await capture('before-case43');
 try{return await exercise({...options,record:async observation=>{
  await capture(observation.checkpoints?.at(-1)?.phase||'checkpoint');
  await options.record(observation);
 }});}finally{await capture('case43-final');journal.disarm=await readProjectionAudit(browser,arcifyId,{disarm:true,workerId,afterSequence});await saveReport();}
}
