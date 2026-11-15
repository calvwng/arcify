import {createHash} from 'node:crypto';
let stopped=false,previousWorker=null;
export async function capturePre42({browser,arcifyId,report,caseIndex,phase}) {
 if(stopped)return;const stop=caseIndex===42;
 const journal=report.pre42Provenance ||= {scope:'Isolated passive pre42 provenance, not a product fix',samples:[],gaps:[],snapshotCount:0};
 if(journal.samples.length>=90){journal.gaps.push({reason:'Summary cap'});stopped=true;return;}
 try{
  const targets=browser.targets().filter(t=>t.type()==='service_worker'&&t.url().startsWith(`chrome-extension://${arcifyId}/`));
  if(targets.length!==1){journal.gaps.push({caseIndex,phase,reason:'No unique existing worker',count:targets.length});return;}
  const worker=await targets[0].worker();
  const prior=journal.samples.at(-1);
  const previous=prior?{retiredCount:prior.retiredCount,windows:prior.windows,lastDecision:prior.lastDecision}:null;
  const sample=await worker.evaluate(({stop,permitSnapshot,previous})=>typeof globalThis.__readPre42==='function'?globalThis.__readPre42({stop,permitSnapshot,previous}):{gap:'Observer absent'}, {stop,permitSnapshot:journal.snapshotCount<6,previous});
  if(sample.snapshot)journal.snapshotCount++;
  sample.workerChanged=previousWorker!==null&&sample.workerId!==previousWorker;
  previousWorker=sample.workerId||previousWorker;
  if(sample.pendingIds){sample.pendingHash=createHash('sha256').update(JSON.stringify(sample.pendingIds)).digest('hex');sample.pendingCount=sample.pendingIds.length;delete sample.pendingIds;}
  journal.samples.push({caseIndex,phase,...sample});
 }catch(error){journal.gaps.push({caseIndex,phase,reason:error.message});}
 finally{if(stop)stopped=true;}
}
