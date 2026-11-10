import assert from 'node:assert/strict';
import {readDurableLayout} from '../durable-today-layout.js';
export async function assertTerminalEvidence(before,after,chosenId,historyId,{allowNewerChoiceEdges=false,beforeSnapshot}={}){
 assert(await readDurableLayout(before),'Pre-close ledger must be valid');
 assert(await readDurableLayout(after),'Persisted terminal ledger must pass the production reader');
 assert.equal(after.version,4,'Real removal events must produce v4, not merely avoid an error');
 const chosen=before.cohorts.find(c=>c.id===chosenId);assert(chosen?.contextSubset&&chosen.binding&&chosen.placements.length===1);
 assert.deepEqual(after.cohorts.find(c=>c.id===chosenId),chosen,'Final chosen cohort must remain byte-equivalent');
 const oldHistory=before.cohorts.find(c=>c.id===historyId),newHistory=after.cohorts.find(c=>c.id===historyId);
 if(allowNewerChoiceEdges){assert.deepEqual({...newHistory,blockedBy:oldHistory.blockedBy},oldHistory,'Explicit remedy may add edges, never rewrite historical placement evidence');for(const id of oldHistory.blockedBy||[])assert(newHistory.blockedBy?.includes(id));}
 else assert.deepEqual(newHistory,oldHistory,'Pending historical cohort must remain intact');
 const receipt=after.retirements.find(r=>r.cohortId===chosenId);assert(receipt,'Exact chosen cohort must have terminal evidence');
 assert.deepEqual(receipt.closed.map(x=>x.tabId),chosen.binding.tabIds,'The final committed slot must have real observed-close receipts');
 assert(Array.isArray(beforeSnapshot),'Preclose committed snapshot evidence is required');
 for(const closed of receipt.closed){const records=beforeSnapshot.filter(r=>r.tabId===closed.tabId&&r.section==='temporaryTabs');assert.equal(records.length,1);assert.deepEqual(closed.witness,records[0].currentOwnership,'Terminal receipt must equal the exact preclose committed ownership witness');assert.equal(records[0].tabIndex,closed.index);}
 return receipt;
}
export function assertNoRevival(observation,targetId,urls){
 assert.equal(observation.tabs.filter(t=>urls.includes(t.url)).length,urls.length,'Exactly the requested fresh same-URL tabs must exist');
 const ids=new Set(observation.tabs.filter(t=>urls.includes(t.url)).map(t=>t.id));
 assert(!(observation.snapshot||[]).some(r=>ids.has(r.tabId)&&r.currentOwnership),'Unproven reopened tabs must not acquire historical ownership witnesses');
 assert.equal(observation.spaces.find(s=>s.id===targetId).temporaryTabs.filter(id=>ids.has(id)).length,0,'Terminal URLs must not revive historical target assignments');
}

export function assertUnrelatedPreserved(before,after,url){
 const select=o=>{const tabs=o.tabs.filter(t=>t.url===url);assert.equal(tabs.length,1,'Exactly one unrelated anchor must survive');const t=tabs[0];return {native:{id:t.id,windowId:t.windowId,index:t.index,url:t.url,pinned:!!t.pinned},owners:o.spaces.filter(s=>s.temporaryTabs.includes(t.id)).map(s=>s.id)};};
 const expected=select(before);assert.equal(expected.owners.length,1);assert.deepEqual(select(after),expected,'Closing chosen scope must not move, replace or reassign unrelated anchor');return expected;
}
