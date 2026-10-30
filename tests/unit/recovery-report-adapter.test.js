import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeRecoveryObservation as report} from '../../recovery-report-adapter.js';
const record={tabId:7,spaceId:'space-a',section:'temporaryTabs',order:0,url:'https://secret.invalid/',windowKey:'key-a',tabIndex:0};
function fixture(){
    const spaces=[{id:'space-a',temporaryTabs:[7],spaceBookmarks:[]}];
    const favoriteState={version:1,bindings:[],attempts:[]};
    return {schema:'arcify-recovery-observation-v1',scope:'live-store',stable:true,atomic:false,capturedAt:100,
        observedAtMs:10,completedAtMs:20,revision:{workerId:'worker-a',sequence:1,start:0,end:0},
        local:{spaces:structuredClone(spaces),spaceTabSnapshot:[structuredClone(record)],persistentFavorites:[]},
        session:{spaceSession:true,favoriteSession:structuredClone(favoriteState),spaceRestoreQueue:[],spaceRecoveryCandidates:[],spaceWindowKeys:[],spaceRestoreWindowKeys:[]},
        memory:{initialized:true,spaces,restoreQueue:[],windowKeys:[],restoreWindowKeys:[],snapshotByTab:[[7,structuredClone(record)]],recoveryCandidates:[],provisional:[],
            favoriteInitialized:true,favorites:[],favoriteState,transient:{initialized:true,provenanceReady:true,healthy:true,revision:1,savedRevision:1}},
        tabs:[{id:7,windowId:2,index:0,url:record.url,pinned:false,incognito:false,knownTransient:false}]};
}
test('exact current ownership is distinct from unresolved historical URL candidates and absent candidates',()=>{
    const f=fixture();f.local.spaceTabSnapshot.push({...record,tabId:70,windowKey:'old'}, {...record,tabId:80,url:'https://absent.invalid/'});
    f.memory.restoreQueue=f.local.spaceTabSnapshot.slice(1);
    f.session.spaceRestoreQueue=structuredClone(f.memory.restoreQueue);
    const r=report(f);assert.equal(r.status,'stable');assert.equal(r.counts.ownedPages,1);
    assert.equal(r.counts.unresolvedPages,1);assert.equal(r.counts.recordsWithoutNativeCandidates,1);
    for(const secret of ['secret.invalid','absent.invalid','space-a','tabId','windowKey'])assert(!JSON.stringify(r).includes(secret));
});
for(const reason of ['recovery','provisional','duplicate-owner','pin','transient','native-pinned','snapshot-mismatch','pending-url'])test(`current identity is not inferred through ${reason}`,()=>{
    const f=fixture();
    if(reason==='recovery')f.memory.recoveryCandidates=[7];
    if(reason==='provisional')f.memory.provisional=[7];
    if(reason==='duplicate-owner'){f.memory.spaces.push({id:'second',temporaryTabs:[7],spaceBookmarks:[]});f.local.spaces=structuredClone(f.memory.spaces);}
    if(reason==='pin'){f.memory.spaces[0].spaceBookmarks=[7];f.local.spaces=structuredClone(f.memory.spaces);}
    if(reason==='transient')f.tabs[0].knownTransient=true;
    if(reason==='native-pinned')f.tabs[0].pinned=true;
    if(reason==='snapshot-mismatch')f.memory.snapshotByTab[0][1].windowKey='other';
    if(reason==='pending-url')f.tabs[0].pendingUrl='https://next.invalid/';
    assert.equal(report(f).counts.ownedPages,0);
});
test('duplicate saved occurrences stay separate and never become two recovered pages',()=>{
    const f=fixture();f.local.spaceTabSnapshot.push(structuredClone(record));
    const r=report(f);assert.equal(r.counts.ownedPages,1);assert.equal(r.counts.unresolvedPages,1);
});
for(const reason of ['cold','dirty-favorite','missing-session','pending-archive','archive-claim','saved-move','pending-create','transient-unready','storage-mismatch'])test(`unqualified ${reason} evidence does not claim recovery or native absence`,()=>{
    const f=fixture();f.local.spaceTabSnapshot.push({...record,tabId:90,url:'https://absent.invalid/'});
    if(reason==='cold')f.scope='persisted-projection';
    if(reason==='dirty-favorite')f.memory.favoriteDirty=true;
    if(reason==='missing-session')delete f.session.spaceSession;
    if(reason==='pending-archive')f.memory.archivePending=[9];
    if(reason==='archive-claim')f.local.archiveReopenClaims={version:1,entries:{x:{phase:'created'}}};
    if(reason==='saved-move')f.local.spaceSavedMoveJournal={phase:'prepared'};
    if(reason==='pending-create')f.memory.pendingCreations=[9];
    if(reason==='transient-unready')f.memory.transient.provenanceReady=false;
    if(reason==='storage-mismatch')f.local.spaces=[];
    const r=report(f);assert.equal(r.authoritative,false);assert.equal(r.counts.ownedPages,0);
    assert.equal(r.counts.recordsWithoutNativeCandidates,0);assert.equal(r.counts.unknownRecords,2);
});
test('Favorite without an exact binding remains unbound despite an ordinary same-URL tab',()=>{
    const f=fixture();f.local.persistentFavorites=[{id:'favorite',url:record.url,title:'private title',sourceBookmarkId:null}];
    f.memory.favorites=structuredClone(f.local.persistentFavorites);
    const r=report(f);assert.equal(r.counts.savedFavorites,1);assert.equal(r.counts.unboundFavorites,1);
    assert(!JSON.stringify(r).includes('private title'));
});
test('incomplete or competing Favorite claims are unknown and never adopted',()=>{
    const f=fixture();f.local.persistentFavorites=[{id:'favorite',url:record.url}];f.memory.favorites=structuredClone(f.local.persistentFavorites);
    f.memory.favoriteState.attempts=[{favoriteId:'favorite',tabId:7,windowId:2}];f.session.favoriteSession=structuredClone(f.memory.favoriteState);
    const r=report(f);assert.equal(r.counts.unboundFavorites,0);assert.equal(r.counts.unknownRecords,1);
});
for(const reason of ['revision','age','unstable'])test(`changing ${reason} snapshots cannot claim current recovery`,()=>{
    const f=fixture();if(reason==='revision')f.revision.end=1;if(reason==='age')f.completedAtMs=40000;if(reason==='unstable')f.stable=false;
    const r=report(f);assert.equal(r.status,'changing');assert.equal(r.authoritative,false);assert.equal(r.counts.ownedPages,0);
});
test('consumed archive claims do not permanently make observation incomplete',()=>{
    const f=fixture();f.local.archiveReopenClaims={version:1,entries:{x:{phase:'consumed'}}};
    assert.equal(report(f).status,'stable');
});
test('malformed committed saved-move receipt cannot establish settled evidence',()=>{
    const f=fixture();f.local.spaceSavedMoveJournal={phase:'committed'};assert.equal(report(f).status,'incomplete');
});
for(const kind of ['queue','candidate','window-key','restore-key','missing-durable-occurrence'])test(`memory/persisted ${kind} mismatch is incomplete`,()=>{
    const f=fixture();
    if(kind==='queue')f.memory.restoreQueue=[{...record,tabId:90}];
    if(kind==='candidate')f.session.spaceRecoveryCandidates=[7];
    if(kind==='window-key')f.memory.windowKeys=[[2,'key']];
    if(kind==='restore-key')f.session.spaceRestoreWindowKeys=[[2,'key']];
    if(kind==='missing-durable-occurrence'){f.memory.restoreQueue=[{...record,tabId:90}];f.session.spaceRestoreQueue=structuredClone(f.memory.restoreQueue);}
    const r=report(f);assert.equal(r.status,'incomplete');assert.equal(r.counts.ownedPages,0);
    if(kind==='queue'||kind==='missing-durable-occurrence')assert.equal(r.counts.unknownRecords,2);
});
