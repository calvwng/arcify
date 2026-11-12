import test from 'node:test';
import assert from 'node:assert/strict';
import {createLayoutRestoreGuards,layoutWindows,layoutEvidence} from '../../durable-today-layout.js';
import {layoutPrecedenceCounts,LAYOUT_PRECEDENCE_COUNT_KEYS} from '../../layout-precedence-diagnostics.js';
import {fixture} from './today-recovery-fixture.js';
import {stageExplicitToday} from '../../explicit-today-ownership.js';

const tab=(id,windowId,url,index=0)=>({id,windowId,url,index,pinned:false,incognito:false});
const cohort=(id,url,blockedBy=[])=>({id,signature:[{index:0,url,pinned:false}],
    placements:[{index:0,spaceId:'target',bookmarkFolderId:'target-root',order:0}],
    blockedBy,binding:null,overrides:[]});
function setup(){
    const f=fixture();f.tabs.splice(0,f.tabs.length,tab(1,10,'https://private-old.test/'),tab(2,20,'https://private-new.test/'));
    for(const s of f.store.spaces){s.temporaryTabs=[];s.spaceBookmarks=[];}
    f.store.explicitToday=new Map();f.store.explicitTodayEpoch=null;f.store.explicitTodayEpochs=[];
    f.store.isTransientTab=()=>false;
    f.old=cohort('private-old',f.tabs[0].url,['private-new']);f.next=cohort('private-new',f.tabs[1].url);
    f.store.durableLayout={cohorts:[f.old,f.next]};f.store.layoutPending=new Set([f.old.id]);return f;
}
function report(f,{evidence:override,guards:guardOverride,...options}={}){
    const evidence=override||layoutEvidence(f.store.durableLayout.cohorts,layoutWindows(f.store,f.tabs),f.store.durableLayout.retirements);
    const guards=guardOverride||createLayoutRestoreGuards(f.store,evidence,f.store.explicitTodayEpoch);
    const observed=()=>({layout:f.store.durableLayout,spaces:f.store.spaces,pending:[...f.store.layoutPending],explicit:[...f.store.explicitToday],tabs:f.tabs,local:f.local,session:f.session,effects:f.effects});
    const before=structuredClone(observed());
    const result=layoutPrecedenceCounts(f.store,evidence,guards,options);
    assert.deepEqual(observed(),before);
    assert.deepEqual(Object.keys(result),LAYOUT_PRECEDENCE_COUNT_KEYS);
    assert.doesNotMatch(JSON.stringify(result),/private-|https|tabId|windowId|spaceId|fingerprint|epoch|incarnation/);
    assert.equal(result.newerChoiceEdgesBlocking,LAYOUT_PRECEDENCE_COUNT_KEYS.slice(2).reduce((n,k)=>n+result[k],0));
    return result;
}
test('independent placeable newer layout permits edge without labeling it a blocker',()=>{
    const f=setup(),r=report(f);assert.equal(r.newerChoiceEdgesChecked,1);assert.equal(r.newerChoiceEdgesBlocking,0);
});
for(const [label,key,change] of [
    ['missing record','newerChoiceMissingRecords',f=>f.store.durableLayout.cohorts.pop()],
    ['retired record','newerChoiceRetiredRecords',f=>f.store.durableLayout.retirements=[{cohortId:f.next.id}]],
    ['changed layout','newerChoiceChangedOrMissing',f=>f.tabs[1].url='https://changed.test/'],
    ['incomplete layout','newerChoiceIncomplete',f=>f.next.signature.push({index:1,url:'https://not-yet-restored.test/',pinned:false})],
    ['ambiguous windows','newerChoiceAmbiguous',f=>f.tabs.push(tab(3,30,f.next.signature[0].url))],
    ['same window','newerChoiceSameWindow',f=>Object.assign(f.tabs[1],{windowId:10,index:1})],
    ['failed placement elsewhere','newerChoiceUnplaceableElsewhere',f=>f.next.placements[0].spaceId='nonexistent']
])test('blocking edge reason: '+label,()=>{
    const f=setup();change(f);const r=report(f);assert.equal(r.newerChoiceEdgesChecked,1);assert.equal(r.newerChoiceEdgesBlocking,1);assert.equal(r[key],1);
});
test('missing observation fails closed without throwing raw data',()=>{
    const f=setup(),evidence=layoutEvidence(f.store.durableLayout.cohorts,layoutWindows(f.store,f.tabs)).filter(e=>e.cohort.id===f.old.id);
    assert.equal(report(f,{evidence}).newerChoiceNoObservation,1);
});
test('exact current ownership passes in the same window',async()=>{
    const f=setup();Object.assign(f.tabs[1],{windowId:10,index:1});f.store.spaces[1].temporaryTabs=[2];
    const stage=await stageExplicitToday(f.store,[f.tabs[1]],{spaceId:'target',bookmarkFolderId:'target-root'});
    f.store.explicitToday=stage.bindings;f.store.explicitTodayEpoch=stage.epoch;f.store.explicitTodayEpochs=stage.epochs;
    f.next.binding={epoch:stage.epoch,windowId:10,tabIds:[2]};
    const r=report(f);assert.equal(r.newerChoiceEdgesChecked,1);assert.equal(r.newerChoiceEdgesBlocking,0);
});
test('all direct failures are counted even when production stops at first failure',()=>{
    const f=setup(),last=cohort('private-last','https://missing.test/');f.old.blockedBy.push(last.id);f.store.durableLayout.cohorts.push(last);
    Object.assign(f.tabs[1],{windowId:10,index:1});
    const r=report(f);assert.equal(r.newerChoiceEdgesBlocking,2);assert.equal(r.newerChoiceSameWindow,1);assert.equal(r.newerChoiceChangedOrMissing,1);
});
test('dependent blockers are traversed and shared edges counted once',()=>{
    const f=setup(),last=cohort('private-last','https://missing.test/');f.next.blockedBy=[last.id];f.store.durableLayout.cohorts.push(last);
    f.store.layoutPending.add(f.next.id);
    const r=report(f);assert.equal(r.newerChoiceEdgesChecked,2);assert.equal(r.newerChoiceEdgesBlocking,2);
    assert.equal(r.newerChoiceBlockedElsewhere,1);assert.equal(r.newerChoiceChangedOrMissing,1);
});
test('non-ready, nonpending and retired roots do not inflate edge counts',()=>{
    for(const kind of ['not-pending','changed','retired']){
        const f=setup();if(kind==='not-pending')f.store.layoutPending.clear();if(kind==='changed')f.tabs[0].url='changed';
        if(kind==='retired')f.store.durableLayout.retirements=[{cohortId:f.old.id}];
        assert.equal(report(f).newerChoiceEdgesChecked,0);
    }
});
test('additional placement checks charge diagnostic budget and fail closed',()=>{
    const f=setup();f.next.placements[0].spaceId='missing';
    assert.throws(()=>report(f,{beforePlacementCheck:()=>{throw Error('budget');}}),/budget/);
});
