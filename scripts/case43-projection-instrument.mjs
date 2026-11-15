// Isolated diagnostic overlay only. Never ship or use in product builds.
import {readFile,writeFile} from 'node:fs/promises';
const root=new URL('../',import.meta.url), patches=[];
function replace(source,old,next){if(source.split(old).length!==2)throw Error('Diagnostic site changed: '+old.slice(0,100));return source.replace(old,next);}
async function edit(file,fn){const url=new URL(file,root),old=await readFile(url,'utf8');patches.push({url,old,next:fn(old)});}
await edit('background.js',s=>s+`
// DIAGNOSTIC ONLY: in-memory bounded read-only receipts, no storage/message endpoint.
const projectionAudit=[];const projectionAuditWorker=crypto.randomUUID();let projectionAuditSequence=0,projectionAuditDropped=0,projectionAuditBytes=0;
globalThis.__projectionAuditArmed=false;
globalThis.__projectionAudit=(phase,data)=>{if(!globalThis.__projectionAuditArmed)return;try{const item={sequence:++projectionAuditSequence,at:Date.now(),phase,data:structuredClone(data)};let encoded=JSON.stringify(item);if(encoded.length>262144){item.data={gap:'Event exceeded256KiB',size:encoded.length};encoded=JSON.stringify(item);}while(projectionAudit.length&&(projectionAudit.length>=128||projectionAuditBytes+encoded.length>4194304)){projectionAuditBytes-=JSON.stringify(projectionAudit.shift()).length;projectionAuditDropped++;}projectionAuditBytes+=encoded.length;projectionAudit.push(item);}catch{projectionAuditDropped++;}};
globalThis.__readProjectionAudit=()=>({workerId:projectionAuditWorker,events:structuredClone(projectionAudit),dropped:projectionAuditDropped,sequence:projectionAuditSequence,nonAtomic:true});
`);
await edit('durable-today-layout.js',s=>replace(s,
    '    return new Set(tabs.filter(t=>eligible(store,t)&&(terminalLayoutRefusal(store,t)||urls.has(t.url)&&!current.has(t.windowId))).map(t=>t.windowId));',
    `    const diagnosticResult = new Set(tabs.filter(t=>eligible(store,t)&&(terminalLayoutRefusal(store,t)||urls.has(t.url)&&!current.has(t.windowId))).map(t=>t.windowId));
    globalThis.__projectionAuditArmed && globalThis.__projectionAudit?.('pending-layout-decision',{epochs,cachedEpochs:store.explicitTodayEpochs,layoutPending:[...(store.layoutPending||[])],currentWindows:[...current],pendingWindows:[...diagnosticResult],
        cohorts:(store.durableLayout?.cohorts||[]).map(c=>({id:c.id,binding:c.binding,signature:c.signature,placements:c.placements,retired:layoutRetired(store.durableLayout,c),explicitOnly:c.explicitOnly,contextSubset:c.contextSubset})),
        tabs:tabs.map(t=>({id:t.id,windowId:t.windowId,index:t.index,url:t.url,eligible:eligible(store,t),terminal:terminalLayoutRefusal(store,t),pendingUrlMatch:urls.has(t.url),explicitOwner:explicitTodayOwner(store,t),provisional:!!store.provisional?.has(t.id),layoutProvisional:!!store.layoutProvisional?.has(t.id),recoveryCandidate:!!store.recoveryCandidates?.has(t.id)}))});
    return diagnosticResult;`));
await edit('space-store.js',s=>{
 s=replace(s,'        try { if (!skipGroupSync) await syncSpaceGroups(',`        globalThis.__projectionAuditArmed && globalThis.__projectionAudit?.('persist-projection-dispatch',{skipGroupSync,pendingWindows:[...pendingLayoutWindows]});
        try { if (!skipGroupSync) await syncSpaceGroups(`);
 return replace(s,"        catch (error) { console.warn('Tab group sync deferred:', error); }",`        catch (error) { globalThis.__projectionAuditArmed && globalThis.__projectionAudit?.('projection-error',{name:error?.name,message:error?.message}); console.warn('Tab group sync deferred:', error); }`);
});
await edit('tab-group-sync.js',s=>{
 s=replace(s,'    await detachGlobalTabs(globalTabIds, options);',`    globalThis.__projectionAuditArmed && globalThis.__projectionAudit?.('sync-enter',{spaces,activeSpaces,globalTabIds});
    await detachGlobalTabs(globalTabIds, options);`);
 s=replace(s,'    if (!syncTabGroups) {',`    globalThis.__projectionAuditArmed && globalThis.__projectionAudit?.('sync-setting',{syncTabGroups});
    if (!syncTabGroups) {`);
 s=replace(s,'    const byId = new Map(tabs.map(t => [t.id, t]));',`    globalThis.__projectionAuditArmed && globalThis.__projectionAudit?.('sync-inputs',{spaceGroupProjection,groups,tabs,windowExclusions:[...new Set(tabs.map(t=>t.windowId))].map(id=>({id,transient:!!options.isExcludedWindow?.(id),layout:!!options.isProjectionDeferredWindow?.(id)}))});
    const byId = new Map(tabs.map(t => [t.id, t]));`);
 s=replace(s,'        return { missing, blocked, excluded: excludedPartition, metadataSafe, activeMember:',`        globalThis.__projectionAuditArmed && globalThis.__projectionAudit?.('partition',{windowId,ids,groupId,missing,blocked,excluded:excludedPartition,metadataSafe,current});
        return { missing, blocked, excluded: excludedPartition, metadataSafe, activeMember:`);
 s=replace(s,'                groupId = await chrome.tabs.group({ tabIds: ids, ...(groupId === undefined ? { createProperties: { windowId } } : { groupId }) });',`                globalThis.__projectionAuditArmed && globalThis.__projectionAudit?.('native-group-request',{windowId,ids,groupId});
                groupId = await chrome.tabs.group({ tabIds: ids, ...(groupId === undefined ? { createProperties: { windowId } } : { groupId }) });
                globalThis.__projectionAuditArmed && globalThis.__projectionAudit?.('native-group-result',{windowId,ids,groupId});`);
 return replace(s,'    await chrome.storage.session.set({ spaceGroupProjection: next, spaceGroupSplitDeferrals: [...deferred.values()] });',`    globalThis.__projectionAuditArmed && globalThis.__projectionAudit?.('sync-result',{next,deferred:[...deferred.values()]});
    await chrome.storage.session.set({ spaceGroupProjection: next, spaceGroupSplitDeferrals: [...deferred.values()] });`);
});
const harnessUrl=new URL('scripts/paired-chrome-smoke.mjs',root);
const harnessOriginal=await readFile(harnessUrl,'utf8');
const harnessDiagnostic=replace(harnessOriginal.replace('#!/usr/bin/env node',"#!/usr/bin/env node\nimport {exerciseCase43Diagnostic} from './case43-projection-reader.mjs';"),
 'await step(stepNames[43], () => exerciseTodayCreationOrder({',
 'await step(stepNames[43], () => exerciseCase43Diagnostic({browser,arcifyId,report,saveReport},exerciseTodayCreationOrder,{');
// Validate every exact source site before writing anything. Build then restore
// originals in a finally block; no diagnostic source remains in checkout.
if(process.argv.includes('--build')){
 const {spawnSync}=await import('node:child_process');
 try{for(const p of patches)await writeFile(p.url,p.next);const result=spawnSync('npm',['run','build'],{cwd:root,stdio:'inherit'});if(result.status!==0)throw Error('Diagnostic build failed');}
 finally{for(const p of patches)await writeFile(p.url,p.old);}
 await writeFile(new URL('scripts/.case43-paired-chrome-smoke.mjs',root),harnessDiagnostic);
}else {
 const {spawnSync}=await import('node:child_process');
 for(const p of [...patches,{next:harnessDiagnostic}]){const checked=spawnSync(process.execPath,['--input-type=module','--check'],{input:p.next,encoding:'utf8'});if(checked.status!==0)throw Error(checked.stderr);}
 console.log('Validated exact overlay sites and generated module syntax:',patches.length);
}
