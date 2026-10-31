import test from 'node:test';
import assert from 'node:assert/strict';
import {diagnoseDurableLayout,validateLayoutDiagnostic,LAYOUT_COUNT_KEYS} from '../../durable-layout-diagnostics.js';
import {encodeFavoriteContinuityState as encode} from '../../favorite-continuity.js';
const slots=values=>values.map((url,index)=>({url,index,pinned:false}));
async function snapshot(live=slots(['a','b','c']),saved=slots(['a','b','c'])){
 const cohort={id:'private-cohort',signature:saved,placements:[{index:saved[0].index,spaceId:'private-space',bookmarkFolderId:'private-root',order:0}],binding:null,overrides:[]};
 const body={revision:1,cohorts:[cohort],snapshotProof:null};
 const fingerprint=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(encode(body)))).toString('hex');
 const ledger={version:1,...body,fingerprint};
 return {stable:true,scope:'live-store',groupSyncEnabled:true,local:{spaceDurableTodayLayout:ledger},memory:{durableLayout:ledger,layoutPending:[cohort.id],restoreQueue:[]},
  tabs:live.map((t,i)=>({...t,id:i+1,windowId:10,incognito:false,title:'PRIVATE TITLE'}))};
}
for(const [name,live,key] of [
 ['extra slot',slots(['a','b','new','c']),'additionalNativeSlots'],
 ['index shift',slots(['a','b','c']).map(t=>({...t,index:t.index+1})),'indexOnlyMismatch'],
 ['reorder',slots(['b','a','c']),'reorderedNativeSlots'],
 ['navigation',slots(['a','new','c']),'noSequenceCorrespondence'],
 ['missing window',[],'noSequenceCorrespondence']
])test(`layout mismatch count: ${name}`,async()=>{
 const report=await diagnoseDurableLayout(await snapshot(live));assert.equal(report.counts[key],1);
 assert.equal(report.nativeGroupSync,'enabled');assert.equal(report.counts.observedEligibleSlots,live.length);
 assert.doesNotMatch(JSON.stringify(report),/private-|PRIVATE|https|tabId|windowId|fingerprint|incarnation/);
 assert(JSON.stringify(report).length<1800);
});
test('missing-only and pinned-anchor relations remain distinct from changed content',async()=>{
 const missing=await diagnoseDurableLayout(await snapshot(slots(['a','c'])));assert.equal(missing.counts.incompleteCandidates,1);assert.equal(missing.counts.noSequenceCorrespondence,0);
 const saved=[{index:0,url:'pin',pinned:true},...slots(['a','b','c']).map(t=>({...t,index:t.index+1}))];
 const original=await snapshot(saved.slice(1),saved);const report=await diagnoseDurableLayout(original);
 assert.equal(report.counts.pendingWithPinnedAnchors,1);assert.equal(report.counts.incompleteCandidates,1);
});
test('mismatch analysis is nonmutating, excludes private/transient/native pins, and can report unknown sync',async()=>{
 const input=await snapshot();input.groupSyncEnabled=null;input.tabs.push({id:90,windowId:10,index:5,url:'PRIVATE',incognito:true},{id:91,windowId:10,index:6,url:'TRANSIENT',knownTransient:true},{id:92,windowId:10,index:7,url:'PIN',pinned:true});
 const before=structuredClone(input),report=await diagnoseDurableLayout(input);assert.deepEqual(input,before);assert.equal(report.counts.observedEligibleSlots,3);assert.equal(report.nativeGroupSync,'unknown');
 input.groupSyncEnabled=false;assert.equal((await diagnoseDurableLayout(input)).nativeGroupSync,'disabled');
});
test('oversized evidence and unstable observations return no counts or sync setting',async()=>{
 const input=await snapshot();input.tabs=Array.from({length:10001},()=>input.tabs[0]);
 assert.equal((await diagnoseDurableLayout(input)).status,'incomplete');
 input.stable=false;assert.deepEqual(await diagnoseDurableLayout(input),{schema:'arcify-layout-diagnostic-v2',status:'changing',counts:null,nativeGroupSync:null});
});
test('URL-size and comparison-work budgets bound queued diagnostic work',async()=>{
 const input=await snapshot();input.tabs=Array.from({length:100},(_,i)=>({...input.tabs[0],id:i+1,url:'x'.repeat(10001)}));
 assert.equal((await diagnoseDurableLayout(input)).status,'incomplete');
 const moderate=await snapshot(slots(Array.from({length:100},(_,i)=>`https://fixture/${i}`)),slots(Array.from({length:100},(_,i)=>`https://fixture/${i}`)));
 assert.equal((await diagnoseDurableLayout(moderate)).status,'stable');
 const work=await snapshot(slots(['a']),slots(Array.from({length:20},(_,i)=>`${i}`+'x'.repeat(100))));
 const ledger=work.local.spaceDurableTodayLayout,template=ledger.cohorts[0];
 ledger.cohorts=Array.from({length:100},(_,i)=>({...structuredClone(template),id:`cohort-${i}`}));
 ledger.fingerprint=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(encode({revision:ledger.revision,cohorts:ledger.cohorts,snapshotProof:ledger.snapshotProof})))).toString('hex');
 assert.equal((await diagnoseDurableLayout(work)).status,'incomplete');
});
test('strict v2 report schema rejects data-bearing, missing, oversized and invalid fields',async()=>{
 const good=await diagnoseDurableLayout(await snapshot());assert.equal(Object.keys(good.counts).length,LAYOUT_COUNT_KEYS.length);
 for(const bad of [{...good,url:'secret'},{...good,schema:'arcify-layout-diagnostic-v1'},{...good,nativeGroupSync:'secret'},
  {...good,counts:{...good.counts,additionalNativeSlots:1000001}},{...good,counts:{...good.counts,additionalNativeSlots:-1}},
  {...good,counts:{...good.counts,url:0}},{...good,status:'changing'}])assert.throws(()=>validateLayoutDiagnostic(bad));
});
test('malformed checkpoint structures return incomplete without raw errors',async()=>{
 for(const cohorts of [[null],[{signature:[null]}],[{signature:'secret'}]]){
  const input=await snapshot();input.local.spaceDurableTodayLayout.cohorts=cohorts;
  const report=await diagnoseDurableLayout(input);assert.equal(report.status,'incomplete');assert.equal(report.counts,null);
 }
});
