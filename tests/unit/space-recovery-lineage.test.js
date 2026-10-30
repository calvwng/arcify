import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './space-recovery-lineage-fixture.js';
import {matchRestoreRecord} from '../../space-restore.js';
import {moveTodayTabsToSpace} from '../../today-move-store.js';
import {SpaceStore} from '../../space-store.js';
const url=i=>`https://synthetic.invalid/page-${i}`;
const tab=(id,index)=>({id,index,windowId:10,url:url(index),pinned:false,incognito:false,groupId:-1,splitViewId:-1});
const record=(index,key)=>({tabId:100+index,spaceId:'source',section:'temporaryTabs',order:index,url:url(index),windowKey:key,tabIndex:index});
const shape=t=>({index:t.index,url:t.url,pinned:Boolean(t.pinned)});
test('two-boundary prevention and three genuine-identity controls',async()=>{const results=[];
{
  const f=fixture({firstHasOldRecord:true});f.store.track(f.native[0]);
  assert.equal(f.store.restoreWindowKeys.get(10),'old-A');assert.equal(f.store.restoreQueue.length,6);
  await f.store.persist();
  for(let i=1;i<=6;i++){const t=tab(i+1,i);f.native.push(t);f.store.track(t);await f.store.persist();}
  assert.deepEqual([...f.store.recoveryCandidates],[2,3,4,5,6,7]);
  assert.equal(f.store.restoreQueue.length,6);assert.equal(f.session.spaceRestoreQueue.length,6);
  assert.equal(f.store.restoreWindowKeys.get(10),'old-A');assert.equal(f.store.windowKeys.get(10),'old-A');
  assert.deepEqual(f.local.spaces[0].temporaryTabs,[1,2,3,4,5,6,7]);
  const currentSaved=f.store.savedWindows.find(w=>w.key==='old-A');
  assert.deepEqual(currentSaved.tabs,f.native.map(shape));
  assert(f.store.restoreQueue.every(r=>r.windowKey==='old-B'&&!r.pinnedState&&!r.nameOverride));
  for(const t of f.native.slice(1))assert.equal(matchRestoreRecord(t,f.store.restoreQueue,f.store.savedWindows,new Map(f.store.restoreWindowKeys),f.native),-1);
  // Persistence alone cannot repair the association; no record is exhausted.
  await f.store.persist();assert.equal(f.store.restoreQueue.length,6);assert.equal(f.store.recoveryCandidates.size,6);
  results.push({case:'Genuine old-A anchor restores first; old-B tabs later enter same live window',passed:true,firstAssociationProvenByExactLayout:true,
    persistedAssociation:'old-A',pendingRecordKey:'old-B',pending:6,candidates:6,liveUniqueUrls:7,sourceTodayMembers:7,currentSavedLayoutEqualsLive:true,
    interpretation:'Reproduces reported relationships through genuine conflicting old-window origins; does not establish actual user history or wrong initial assignment.'});
}
{
  const f=fixture({firstHasOldRecord:false});f.store.track(f.native[0]);await f.store.persist();
  const synthesizedKey=f.store.windowKeys.get(10);assert(synthesizedKey);assert.equal(f.store.restoreWindowKeys.has(10),false);
  for(let i=1;i<=6;i++){const t=tab(i+1,i);f.native.push(t);f.store.track(t);await f.store.persist();}
  assert.equal(f.store.restoreWindowKeys.get(10),'old-B');assert.equal(f.store.restoreQueue.length,0);assert.equal(f.store.recoveryCandidates.size,0);
  results.push({case:'New unassociated first tab gets synthesized current-window key; old-B restoration follows',passed:true,
    synthesizedKeyDidNotPoisonRestoreAssociation:true,pending:0,candidates:0,
    interpretation:'track excludes synthesized snapshot keys not referenced by pending records or restore mappings; simple self-snapshot poisoning hypothesis is rejected.'});
}
{
  const tabs=[tab(1,0)],queue=[record(0,'old-B')],saved=[{key:'old-A',tabs:tabs.map(shape)},{key:'old-B',tabs:tabs.map(shape)}];
  assert.equal(matchRestoreRecord(tabs[0],queue,saved,new Map([[10,'old-A']]),tabs),-1);
  const clearedOnlyForSyntheticTest=new Map();assert.equal(matchRestoreRecord(tabs[0],queue,saved,clearedOnlyForSyntheticTest,tabs),-1);
  assert.equal(clearedOnlyForSyntheticTest.size,0);
  results.push({case:'Two identical saved windows; retained association conflicts with queued key',passed:true,
    deletingAssociationDoesNotProveIdentity:true,interpretation:'Matching the live key layout does not establish that a queued different key is the same original window.'});
}
{
  const f=fixture({firstHasOldRecord:false});
  f.native.push(...[1,2,3,4,5,6].map(i=>tab(i+1,i)),
    {id:11,index:0,windowId:20,url:'https://synthetic.invalid/second-new-anchor',pinned:false},
    ...[1,2,3,4,5,6].map(i=>({...tab(i+11,i),windowId:20})));
  f.store.liveTabs=new Map(f.native.map(t=>[t.id,t]));
  for(const t of f.native)f.store.track(t);
  await f.store.persist();
  const generatedKey=f.store.windowKeys.get(10);
  assert(generatedKey&&generatedKey!=='old-B');assert.equal(f.store.restoreWindowKeys.size,0);
  assert.equal(f.store.recoveryCandidates.size,12);assert.equal(f.store.restoreQueue.length,6);
  assert.deepEqual(f.local.spaceTabSnapshot.filter(r=>r.windowKey===generatedKey).map(r=>r.tabId),[1]);
  // Second recovery boundary: session evidence is absent; one of the duplicate
  // live windows is no longer present. Do not hand-seed any restore association.
  f.native.splice(7);for(const k of Object.keys(f.session))delete f.session[k];
  const cold=new SpaceStore();await cold.initialize();
  assert.equal(cold.restoreWindowKeys.get(10),'old-B');
  assert.equal(cold.windowKeys.get(10),'old-B');
  assert.deepEqual([...cold.recoveryCandidates],[]);
  assert.equal(cold.restoreQueue.filter(r=>r.windowKey==='old-B').length,0);
  assert.equal(cold.restoreQueue.filter(r=>r.url===url(1)).length,0);
  assert.equal(f.native.filter(t=>t.url===url(1)).length,1);
  assert.deepEqual(cold.savedWindows.find(w=>w.key==='old-B').tabs,f.native.map(shape));
  for(const t of f.native.slice(1))assert.equal(matchRestoreRecord(t,cold.restoreQueue,cold.savedWindows,new Map(cold.restoreWindowKeys),f.native),-1);
  // User's ordinary active-Space selection is independent of restore-window identity.
  cold.active[10]='source';cold.spaces.push({id:'target',name:'Target',bookmarkFolderId:'target-folder',temporaryTabs:[],spaceBookmarks:[]});
  const durableBefore=JSON.stringify({local:f.local,session:f.session}),membershipBefore=JSON.stringify(cold.spaces);
  const moved=await moveTodayTabsToSpace(cold,{type:'moveTodayTabsToSpace',windowId:10,spaceId:'source',bookmarkFolderId:'source-folder',destinationSpaceId:'target',destinationBookmarkFolderId:'target-folder',inverted:false,entries:f.native.map(t=>({tabId:t.id,url:t.url}))});
  assert.equal(moved.completed.length,7);assert.equal(moved.uncertain,false);
  assert.deepEqual(cold.spaces.find(s=>s.id==='target').temporaryTabs,[1,2,3,4,5,6,7]);
  assert.equal(cold.restoreQueue.filter(r=>r.windowKey==='old-B').length,0);
  results.push({case:'Two recovery boundaries: unresolved duplicate live windows generate fresh snapshot keys; later unproven/session-absent recovery promotes the generated key',passed:true,
    firstBoundaryRestoreAssociations:0,firstBoundaryCandidates:12,firstBoundaryPendingOldRecords:6,
    secondBoundaryGeneratedKeyBecameRestoreAssociation:false,secondBoundaryCandidates:0,secondBoundaryPendingOldRecords:0,
    selectedUrlsGloballyUniqueAtSecondBoundary:true,anyAssociationHandSeeded:false,
    completed:7,remaining:0,uncertain:false,
    interpretation:'Candidate labelled future snapshot does not claim historical window identity; old-B recovery completes and seven selected tabs move. Existing unlabelled state is deliberately unaffected.'});
}
assert.equal(results.length,4);});
