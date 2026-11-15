// Existing unique worker only. Never wake/poll a worker or send product requests.
export async function readCase41Audit(browser,arcifyId,{arm=false,disarm=false,workerId=null,afterSequence=0}={}){
 const matches=browser.targets().filter(t=>t.type()==='service_worker'&&t.url()===`chrome-extension://${arcifyId}/background.js`);
 if(matches.length!==1)return{gap:'no-unique-existing-worker',count:matches.length};
 try{return await (await matches[0].worker()).evaluate(({arm,disarm,workerId,afterSequence})=>{
  if(typeof globalThis.__c41Read!=='function')return{gap:'observer-absent'};
  const before=globalThis.__c41Read();if(arm)globalThis.__c41Armed=true;if(disarm)globalThis.__c41Armed=false;
  const state=globalThis.__c41Read(),changed=workerId!==null&&workerId!==state.workerId,cursor=changed?0:afterSequence;
  return{...state,workerChanged:changed,armBoundary:{requested:arm,wasArmed:before.armed,isArmed:state.armed},startupUnobserved:arm&&!before.armed,missedEvents:state.firstSequence===null?0:Math.max(0,state.firstSequence-cursor-1),events:state.events.filter(e=>e.sequence>cursor)};
 },{arm,disarm,workerId,afterSequence});}catch(error){return{gap:'existing-worker-read-failed',errorName:error.name};}
}
export function summarizeCase41Coverage(journal){
 const samples=journal.samples||[],events=samples.flatMap(s=>s.events||[]),case41=samples.filter(s=>s.caseIndex===41),relevant=case41.flatMap(s=>s.events||[]);
 const gaps=samples.filter(s=>s.gap).length,missed=samples.reduce((n,s)=>n+(s.missedEvents||0),0),nodeTruncations=events.filter(e=>e.nodeLimitReached||e.data?.overflow||e.data?.oversize).length;
 const names=new Set(relevant.map(e=>e.phase)),decisions=names.has('pending-decision')&&names.has('persist-projection-dispatch')&&names.has('queue-start');
 const ended=case41.some(s=>s.phase==='case41-active-single-moved'||s.phase==='case41-today-move-failed');
 const uncertain=gaps||missed||nodeTruncations||journal.truncated;
 return{status:relevant.length===0?'unavailable':decisions&&ended&&!uncertain?'observed':'partial',gapCount:gaps,missedEvents:missed,nodeTruncations,reportTruncated:!!journal.truncated,case41EventCount:relevant.length,decisiveFamiliesPresent:decisions,endedAtFirstMoveOrFailure:ended,
  retainedIntervals:samples.map(s=>({phase:s.phase,workerId:s.workerId||null,first:s.events?.[0]?.sequence??null,last:s.events?.at(-1)?.sequence??null,startupUnobserved:!!s.startupUnobserved,missed:s.missedEvents||0})),
  limits:'Observed means these instrumented decision families survived, not uninstrumented reproduction or proof of every guard. No events is never evidence that no blocker existed.'};
}
export async function exerciseCase41Comparison({browser,arcifyId,report,saveReport,caseIndex},exercise,options){
 const journal=report.case41Comparison||={scope:'Actual synchronous operand receipts; boundary CDP reads perturb timing. Startup/reload gaps explicit. No proof from absent events. Native API results are not physical membership proof.',samples:[],bytes:0,truncated:false,armed:false,done:false,workerId:null,afterSequence:0};
 const capture=async(phase,{arm=true,disarm=false}={})=>{
  const sample=await readCase41Audit(browser,arcifyId,{arm,disarm,workerId:journal.workerId,afterSequence:journal.afterSequence});
  journal.workerId=sample.workerId||journal.workerId;journal.afterSequence=sample.sequence??journal.afterSequence;journal.armed=sample.armed??journal.armed;
  const value={phase,caseIndex,...sample},size=JSON.stringify(value).length;
  if(journal.bytes+size<=8388608&&journal.samples.length<48){journal.samples.push(value);journal.bytes+=size;}else journal.truncated=true;
  journal.coverage=summarizeCase41Coverage(journal);
 };
 const stop=async phase=>{if(journal.done)return;await capture(phase,{arm:false,disarm:true});journal.done=true;};
 if(caseIndex===41)await capture('case41-before-settings');
 const originalRecord=options.record||(()=>{});
 try{return await exercise({...options,
  reloadArcify:async(...args)=>{const result=await options.reloadArcify(...args);if(journal.armed&&!journal.done)await capture('case40-after-reload-existing-worker-rearm');return result;},
  poll:async(...args)=>{const result=await options.poll(...args);if(caseIndex===41&&!journal.done&&['syncTabGroups persisted','invertTabOrder persisted','todayNewTabsAtTop persisted'].includes(args[2]))await capture(args[2]==='todayNewTabsAtTop persisted'?'case41-pre-seed':`case41-original-readback:${args[2]}`);return result;},
  record:async observation=>{
   await originalRecord(observation);const last=observation?.checkpoints?.at(-1),phase=last?.phase;
   if(caseIndex===40&&phase==='before-witnessed-extension-reload'&&!journal.armed)await capture('case40-before-reload-and-teardown');
   if(caseIndex===40&&phase==='witnessed-extension-reload'&&!journal.done)await capture('case40-reload-verified-before-cleanup');
   if(caseIndex===41&&!journal.done){
    if(phase==='native-today-move-input'&&last.label==='Choose the existing destination Space')await capture('case41-before-first-move-input');
    if(phase==='destination-choice-cancelled')await capture('case41-pre-first-move');
    if(phase==='active-single-moved'||phase==='today-move-failed')await stop(`case41-${phase}`);
   }
  }
 });}finally{if(caseIndex===41&&!journal.done)await stop('case41-final-without-first-move');await saveReport();}
}
