// Isolated diagnostic build only; original tracked source restored after build.
import {readFile,writeFile} from 'node:fs/promises';import {spawnSync} from 'node:child_process';
const root=new URL('../',import.meta.url),patches=[];
function replace(s,a,b){if(s.split(a).length!==2)throw Error('Diagnostic site changed');return s.replace(a,b);}
async function edit(name,fn){const url=new URL(name,root),old=await readFile(url,'utf8');patches.push({url,old,next:fn(old)});}
await edit('background.js',s=>s+`
// PASSIVE DIAGNOSTIC: no Chrome API calls, storage writes, or authority issuance.
const pre42Worker=crypto.randomUUID();
globalThis.__pre42Armed=true;
globalThis.__readPre42=({stop,permitSnapshot,previous:pre42Previous})=>{
 const layout=spaceStore.durableLayout,cohorts=layout?.cohorts||[],retired=new Set((layout?.retirements||[]).map(r=>r.cohortId)),windows={};
 for(const c of cohorts){const id=c.binding?.windowId??'unbound',v=windows[id]||={total:0,ordinary:0,subset:0,explicit:0,retired:0,nonpendingExplicit:0};v.total++;v.ordinary+=!c.contextSubset&&!c.explicitOnly?1:0;v.subset+=c.contextSubset?1:0;v.explicit+=c.explicitOnly?1:0;v.retired+=retired.has(c.id)?1:0;v.nonpendingExplicit+=c.explicitOnly&&!retired.has(c.id)&&!spaceStore.layoutPending?.has(c.id)?1:0;}
 const current={workerId:pre42Worker,at:Date.now(),initialized:spaceStore.initialized,revision:layout?.revision,fingerprint:layout?.fingerprint,cohortCount:cohorts.length,retiredCount:retired.size,windows,pendingIds:[...(spaceStore.layoutPending||[])].sort(),cachedEpoch:spaceStore.explicitTodayEpoch,cachedEpochs:spaceStore.explicitTodayEpochs,lastDecision:globalThis.__pre42Decision||null,lastDispatch:globalThis.__pre42Dispatch||null,nonAtomic:true};
 const reasons=[];
 if(!pre42Previous)reasons.push('worker-baseline');
 if(retired.size>(pre42Previous?.retiredCount||0))reasons.push('retirement-increased');
 if(pre42Previous)for(const [id,w]of Object.entries(windows))if(pre42Previous.windows[id]?.ordinary>0&&w.ordinary===0)reasons.push('ordinary-cohort-shape-disappeared:'+id);
 const oldPending=new Set(pre42Previous?.lastDecision?.pendingWindows||[]);
 const newPending=(current.lastDecision?.pendingWindows||[]).filter(id=>!oldPending.has(id));
 if(newPending.length)reasons.push('window-reservation-began:'+newPending.join(','));
 current.reasons=reasons;
 if(reasons.length&&permitSnapshot){
  const snap={layout,layoutPending:[...(spaceStore.layoutPending||[])],layoutProvisional:[...(spaceStore.layoutProvisional||[])],provisional:[...(spaceStore.provisional||[])],recoveryCandidates:[...(spaceStore.recoveryCandidates||[])],spaces:spaceStore.spaces,explicitToday:[...(spaceStore.explicitToday||[])],cachedLiveTabs:[...(spaceStore.liveTabs||[])],note:'Cached worker state at boundary, NOT native atomic/event-time state'};
  const json=JSON.stringify(snap);if(json.length<=262144)current.snapshot=JSON.parse(json);else current.snapshotGap={reason:'256KiB cap',size:json.length};
 }else if(reasons.length)current.snapshotGap={reason:'Six-snapshot cap'};
 if(stop)globalThis.__pre42Armed=false;
 return structuredClone(current);
};
`);
await edit('durable-today-layout.js',s=>replace(s,'    return new Set(tabs.filter(t=>eligible(store,t)&&(terminalLayoutRefusal(store,t)||urls.has(t.url)&&!current.has(t.windowId))).map(t=>t.windowId));',`    const diagnosticResult=new Set(tabs.filter(t=>eligible(store,t)&&(terminalLayoutRefusal(store,t)||urls.has(t.url)&&!current.has(t.windowId))).map(t=>t.windowId));
    if(globalThis.__pre42Armed)globalThis.__pre42Decision={at:Date.now(),revision:store.durableLayout?.revision,epochs:structuredClone(epochs),currentWindows:[...current],pendingWindows:[...diagnosticResult]};
    return diagnosticResult;`));
await edit('space-store.js',s=>replace(s,'        try { if (!skipGroupSync) await syncSpaceGroups(',`        if(globalThis.__pre42Armed)globalThis.__pre42Dispatch={at:Date.now(),skipGroupSync,pendingWindows:[...pendingLayoutWindows]};
        try { if (!skipGroupSync) await syncSpaceGroups(`));
const original=await readFile(new URL('scripts/paired-chrome-smoke.mjs',root),'utf8');
let harness=replace(original,'#!/usr/bin/env node',"#!/usr/bin/env node\nimport {capturePre42} from './pre42-provenance-reader.mjs';");
harness=replace(harness,"    check.status = 'running'; check.startedAt = new Date().toISOString();","    check.status = 'running'; check.startedAt = new Date().toISOString();\n    await capturePre42({browser,arcifyId,report,caseIndex:check.caseIndex,phase:'before'});");
harness=replace(harness,'    } finally { check.finishedAt = new Date().toISOString(); await saveReport(); }',"    } finally { await capturePre42({browser,arcifyId,report,caseIndex:check.caseIndex,phase:'after'}); check.finishedAt = new Date().toISOString(); await saveReport(); }");
for(const p of [...patches,{next:harness}]){const r=spawnSync(process.execPath,['--input-type=module','--check'],{input:p.next,encoding:'utf8'});if(r.status!==0)throw Error(r.stderr);}
if(process.argv.includes('--build')){try{for(const p of patches)await writeFile(p.url,p.next);const r=spawnSync('npm',['run','build'],{cwd:root,stdio:'inherit'});if(r.status!==0)throw Error('Build failed');}finally{for(const p of patches)await writeFile(p.url,p.old);}await writeFile(new URL('scripts/.pre42-paired-chrome-smoke.mjs',root),harness);}
console.log('Validated exact passive overlay sites and original full-run harness');
