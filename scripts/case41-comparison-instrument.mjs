import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {installCase41Audit} from './case41-comparison-runtime.mjs';
const arg=process.argv.indexOf('--root');if(arg<0)throw Error('--root exact target checkout required');
const root=path.resolve(process.argv[arg+1]),here=path.dirname(fileURLToPath(import.meta.url)),patches=[];
const hash=s=>createHash('sha256').update(s).digest('hex');
const once=(s,a,b)=>{if(s.split(a).length!==2)throw Error('Exact site changed: '+a.slice(0,100));return s.replace(a,()=>b);};
const audit=(phase,data)=>`globalThis.__c41Armed && globalThis.__c41Audit('${phase}',${data});`;
const value=(phase,expr,data)=>`(globalThis.__c41Armed ? globalThis.__c41Value('${phase}',(${expr}),${data}) : (${expr}))`;
async function edit(file,fn){const before=await readFile(path.join(root,file),'utf8'),replacements=[];const rep=(s,a,b)=>{replacements.push({before:a,after:b});return once(s,a,b);};const after=fn(before,rep);patches.push({file,before,after,replacements});}
await edit('background.js',s=>s+`\n// Isolated diagnostic only.\n(${installCase41Audit.toString()})();\n`);
await edit('space-store.js',(s,r)=>{
 s=r(s,'    run(operation) {\n        const pending = this.chain.then(async () => {',`    run(operation) {\n        const diagnosticOperation=globalThis.__c41Armed?globalThis.__c41Queue('enqueue'):null;\n        const pending = this.chain.then(async () => {\n            globalThis.__c41Armed && globalThis.__c41Queue('start',diagnosticOperation);\n            try {`);
 s=r(s,'        });\n        this.chain = pending.catch(console.error);',`            } finally { globalThis.__c41Armed && globalThis.__c41Queue('end',diagnosticOperation); }\n        });\n        this.chain = pending.catch(console.error);`);
 s=r(s,'        if (!undoInvalidatedAtEvent) invalidateGeneralUndo(this);',`        ${audit('persist-enter','{skipGroupSync,preserveRecoveryQueue,explicitLayoutIntentIds,initialized:this.initialized}')}\n        if (!undoInvalidatedAtEvent) invalidateGeneralUndo(this);`);
 s=r(s,'        this.liveTabs = tabs;\n        await stageDurableExhaustion',`        this.liveTabs = tabs;\n        ${audit('persist-native-read','{tabs:[...tabs.values()].map(t=>({id:t.id,windowId:t.windowId,index:t.index,groupId:t.groupId,splitViewId:t.splitViewId,pinned:t.pinned,incognito:t.incognito}))}')}\n        await stageDurableExhaustion`);
 for(const site of ['await chrome.storage.local.set(checkpoint);','await chrome.storage.session.set(spaceSessionUpdate);']){
  s=r(s,site,`${audit('persist-before-write',site.includes('local')?'{layoutRevision:checkpoint.spaceDurableTodayLayout?.revision,cohortCount:checkpoint.spaceDurableTodayLayout?.cohorts?.length,snapshotCount:checkpoint.spaceTabSnapshot?.length}':'{activeSpaces:spaceSessionUpdate.activeSpaces,recoveryCandidates:spaceSessionUpdate.spaceRecoveryCandidates}')}\n            ${site}\n            ${audit('persist-after-write',site.includes('local')?'{layoutRevision:checkpoint.spaceDurableTodayLayout?.revision,cohortCount:checkpoint.spaceDurableTodayLayout?.cohorts?.length,snapshotCount:checkpoint.spaceTabSnapshot?.length}':'{activeSpaces:spaceSessionUpdate.activeSpaces,recoveryCandidates:spaceSessionUpdate.spaceRecoveryCandidates}')}`);
 }
 s=r(s,'isExcludedTab: tab => this.isTransientTab(tab) || Boolean(this.favoriteStore?.recovery?.protects(tab))',`isExcludedTab: tab => ${value('excluded-transient','this.isTransientTab(tab)','{tabId:tab?.id,windowId:tab?.windowId}')} || ${value('excluded-favorite-recovery','Boolean(this.favoriteStore?.recovery?.protects(tab))','{tabId:tab?.id,windowId:tab?.windowId}')}`);
 s=r(s,'        try { if (!skipGroupSync) await syncSpaceGroups(',`        ${audit('persist-projection-dispatch','{skipGroupSync,pendingWindows:[...pendingLayoutWindows]}')}\n        try { if (!skipGroupSync) await syncSpaceGroups(`);
 s=r(s,"        catch (error) { console.warn('Tab group sync deferred:', error); }",`        catch (error) { ${audit('projection-error','{name:error?.name,message:error?.message}')} console.warn('Tab group sync deferred:', error); }\n        ${audit('persist-end','{}')}`);
 return s;
});
await edit('durable-today-layout.js',(s,r)=>{
 const start=s.indexOf('export function pendingLayoutWindowIds('),end=s.indexOf('\nfunction partial(',start);if(start<0||end<0)throw Error('pending layout boundary missing');const original=s.slice(start,end);let part=original;
 part=once(part,'    const urls=',`    globalThis.__c41Armed && globalThis.__c41PendingBegin({epochs,cachedEpochs:store.explicitTodayEpochs,layoutPending:store.layoutPending,layoutRevision:store.durableLayout?.revision,cohortCount:store.durableLayout?.cohorts?.length,provisional:store.provisional,layoutProvisional:store.layoutProvisional,recoveryCandidates:store.recoveryCandidates});\n    const urls=`);
 // Each original expression evaluates once at its original short-circuit position.
 const expressions=[['epoch-equal','epochs.some(epoch=>epoch&&encode(epoch)===encode(c.binding.epoch))','{cohort:c.id}'],['binding-ids-equal','encode(c.binding.tabIds)===encode(w.tabs.map(t=>t.id))','{cohort:c.id,windowId:w.id}'],['signature-equal','encode(c.signature)===encode(w.signature)','{cohort:c.id,windowId:w.id}'],['candidate-retired','layoutRetired(store.durableLayout,c)','{cohort:c.id}'],['candidate-pending','store.layoutPending?.has(c.id)','{cohort:c.id}'],['candidate-explicit-only','c.explicitOnly','{cohort:c.id}'],['candidate-subset','c.contextSubset','{cohort:c.id}'],['terminal-refusal','terminalLayoutRefusal(store,t)','{tabId:t.id,windowId:t.windowId}'],['tab-eligible','eligible(store,t)','{tabId:t.id,windowId:t.windowId}'],['url-reserved','urls.has(t.url)','{tabId:t.id,windowId:t.windowId}'],['window-current','current.has(t.windowId)','{tabId:t.id,windowId:t.windowId}'],['explicit-owner','explicitTodayOwner(store,tab)','{tabId:tab?.id,windowId:tab?.windowId}'],['provisional','store.provisional?.has(tab.id)','{tabId:tab?.id,windowId:tab?.windowId}'],['recovery-candidate','store.recoveryCandidates?.has(tab.id)','{tabId:tab?.id,windowId:tab?.windowId}'],['layout-provisional','store.layoutProvisional?.has(tab.id)','{tabId:tab?.id,windowId:tab?.windowId}'],['placement-count','c.placements.length','{cohort:c.id}'],['placement-owner','space?.temporaryTabs.includes(tab.id)','{cohort:c.id,tabId:tab?.id}'],['placement-unique','store.spaces.filter(s=>s.temporaryTabs.includes(tab.id)||s.spaceBookmarks.includes(tab.id)).length===1','{cohort:c.id,tabId:tab?.id}']];
 for(const [phase,expr,data] of expressions){if(!part.includes(expr))throw Error('Missing actual operand '+expr);part=part.split(expr).join(value(phase,expr,data));}
 part=once(part,'    const current=',`    globalThis.__c41Armed && globalThis.__c41PendingStage(1);\n    const current=`);
 part=once(part,'    const live=windows(store,tabs);',`    globalThis.__c41Armed && globalThis.__c41PendingStage(2);\n    const live=windows(store,tabs);`);
 part=once(part,'map(c=>c.binding.windowId)',`map(c=>${value('explicit-current-window','c.binding.windowId','{cohort:c.id}')})`);
 part=once(part,'        const w=live.find(w=>w.id===c.binding.windowId);',`        const w=live.find(w=>w.id===c.binding.windowId);
        ${audit('ordinary-binding-observation','{cohort:c.id,boundWindow:c.binding.windowId,liveFound:!!w,tabIds:c.binding.tabIds,epoch:c.binding.epoch}')} `);
 part=once(part,'    return new Set(tabs.filter(',`    globalThis.__c41Armed && globalThis.__c41PendingStage(3);\n    const diagnosticPendingResult=new Set(tabs.filter(`);
 part=once(part,'.map(t=>t.windowId));\n}',`.map(t=>t.windowId));\n    globalThis.__c41Armed && globalThis.__c41PendingEnd({pendingWindows:[...diagnosticPendingResult],currentWindows:[...current]});\n    return diagnosticPendingResult;\n}`);
 s=r(s,original,part);
 s=r(s,'const terminalUrlMatch = (store,tab) => !!tab&&(store.durableLayout?.cohorts||[]).some(c=>layoutRetired(store.durableLayout,c)&&c.signature.some(slot=>slot.url===tab.url));',`const terminalUrlMatch = (store,tab) => !!tab&&(store.durableLayout?.cohorts||[]).some(c=>${value('terminal-cohort-retired','layoutRetired(store.durableLayout,c)','{cohort:c.id,tabId:tab.id}')}&&c.signature.some(slot=>${value('terminal-cohort-url-equal','slot.url===tab.url','{cohort:c.id,tabId:tab.id,slotIndex:slot.index}')}));`);
 return r(s,'export const terminalLayoutRefusal = (store,tab) => terminalUrlMatch(store,tab)&&!explicitTodayOwner(store,tab);',`export const terminalLayoutRefusal = (store,tab) => ${value('terminal-url-match','terminalUrlMatch(store,tab)','{tabId:tab?.id,windowId:tab?.windowId}')}&&!${value('terminal-explicit-owner','explicitTodayOwner(store,tab)','{tabId:tab?.id,windowId:tab?.windowId}')};`);
});
await edit('tab-group-sync.js',(s,r)=>{
 s=r(s,'    await detachGlobalTabs(globalTabIds, options);',`    ${audit('sync-enter','{spaces:spaces.map(s=>({id:s.id,temporaryTabs:s.temporaryTabs,spaceBookmarks:s.spaceBookmarks})),activeSpaces,globalTabIds}')}\n    await detachGlobalTabs(globalTabIds, options);`);
 s=r(s,"    if (!syncTabGroups) {",`    ${audit('sync-setting','{syncTabGroups}')}\n    if (!syncTabGroups) {`);
 s=r(s,'    const byId = new Map(tabs.map(t => [t.id, t]));',`    ${audit('sync-read-inputs','{spaceGroupProjection,groups:groups.map(g=>({id:g.id,windowId:g.windowId,collapsed:g.collapsed})),tabs:tabs.map(t=>({id:t.id,windowId:t.windowId,groupId:t.groupId,splitViewId:t.splitViewId,pinned:t.pinned,incognito:t.incognito}))}')}\n    const byId = new Map(tabs.map(t => [t.id, t]));`);
 s=r(s,'        return { missing, blocked, excluded: excludedPartition, metadataSafe, activeMember:',`        ${audit('partition','{windowId,ids,groupId,missing,blocked,excludedPartition,metadataSafe,members:members.map(t=>({id:t.id,groupId:t.groupId,splitViewId:t.splitViewId})),protectedGroups:[...protectedGroups],excludedGroups:[...excludedGroups]}')}\n        return { missing, blocked, excluded: excludedPartition, metadataSafe, activeMember:`);
 s=r(s,'                groupId = await chrome.tabs.group({ tabIds: ids, ...(groupId === undefined ? { createProperties: { windowId } } : { groupId }) });',`                ${audit('native-group-request','{windowId,ids,groupId}')}\n                groupId = await chrome.tabs.group({ tabIds: ids, ...(groupId === undefined ? { createProperties: { windowId } } : { groupId }) });\n                ${audit('native-group-result','{windowId,ids,groupId}')}`);
 s=r(s,'    await chrome.storage.session.set({ spaceGroupProjection: next, spaceGroupSplitDeferrals: [...deferred.values()] });',`    ${audit('sync-result','{next,deferred:[...deferred.values()]}')}\n    await chrome.storage.session.set({ spaceGroupProjection: next, spaceGroupSplitDeferrals: [...deferred.values()] });`);
 // Observe values from original hooks; no diagnostic predicate replay/query.
 for(const expr of ['options.isExcludedTab?.(tab)','options.isExcludedWindow?.(id)','options.isProjectionDeferredWindow?.(id)']){
  if(!s.includes(expr))throw Error('Missing exclusion site');s=s.split(expr).join(value(expr.includes('Tab')?'exclude-tab':expr.includes('Deferred')?'defer-window':'exclude-window',expr,expr.includes('Tab')?'{tabId:tab?.id,windowId:tab?.windowId}':'{windowId:id}'));
 }
 return s;
});
const splitSource=await readFile(path.join(root,'split-pins.js'),'utf8');
if(splitSource.includes('const focusLinks = await readSplitPinFocusLinks();'))await edit('split-pins.js',(s,r)=>r(s,'            const focusLinks = await readSplitPinFocusLinks();',`            ${audit('focus-list-read-start','{windowId:request.windowId,spaceId:request.spaceId}')}
            const focusLinks = await readSplitPinFocusLinks();
            ${audit('focus-list-read-end','{windowId:request.windowId,spaceId:request.spaceId,linkCount:Object.keys(focusLinks).length}')}`));
const source=await readFile(path.join(root,'scripts/paired-chrome-smoke.mjs'),'utf8');let runner=once(source,'#!/usr/bin/env node',"#!/usr/bin/env node\nimport {exerciseCase41Comparison} from './case41-comparison-reader.mjs';");
for(const index of [40,41])runner=once(runner,`await step(stepNames[${index}], () => exerciseTodayMove({`,`await step(stepNames[${index}], () => exerciseCase41Comparison({browser,arcifyId,report,saveReport,caseIndex:${index}},exerciseTodayMove,{`);
for(const p of [...patches,{after:runner}]){const checked=spawnSync(process.execPath,['--input-type=module','--check'],{input:p.after,encoding:'utf8'});if(checked.status!==0)throw Error(checked.stderr);}
const proof={scope:'Ephemeral synchronous hooks, no extra native queries/awaits or changed original assertions; runner boundary reads perturb timing',sourceHash:hash(source),runnerHash:hash(runner),files:patches.map(p=>({file:p.file,before:hash(p.before),instrumented:hash(p.after),originalSource:p.before,instrumentedSource:p.after,replacements:p.replacements})),restored:false};
if(process.argv.includes('--build')){
 try{for(const p of patches)await writeFile(path.join(root,p.file),p.after);const built=spawnSync('npm',['run','build'],{cwd:root,stdio:'inherit'});if(built.status!==0)throw Error('Instrumented build failed');}
 finally{for(const p of patches)await writeFile(path.join(root,p.file),p.before);for(const p of patches){const restored=hash(await readFile(path.join(root,p.file)));if(restored!==hash(p.before))throw Error('Source restoration failed');proof.files.find(f=>f.file===p.file).restored=restored;}proof.restored=true;await mkdir(path.join(root,'test-results/paired-chrome'),{recursive:true});await writeFile(path.join(root,'test-results/paired-chrome/instrumentation.json'),JSON.stringify(proof,null,2));}
 await copyFile(path.join(here,'case41-comparison-reader.mjs'),path.join(root,'scripts/case41-comparison-reader.mjs'));
 await writeFile(path.join(root,'scripts/.case41-paired-chrome-smoke.mjs'),runner);
}else console.log(JSON.stringify({validated:true,files:proof.files.map(({file,before,instrumented})=>({file,before,instrumented})),runnerHash:proof.runnerHash}));
