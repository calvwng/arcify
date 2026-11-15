import test from 'node:test';
import assert from 'node:assert/strict';
import {characterizeColdSplit} from './paired-chrome-split-cold-diagnostic.mjs';
function fixture(){
 const url='http://127.0.0.1:1234/native-split/fixture/right';
 const seeds=['left','right','unrelated'].map((role,i)=>({role,marker:`marker-${role}`,tab:{id:i+1}}));
 const documents=seeds.map((s,i)=>({marker:s.marker,url,documentId:String(i+1).repeat(32),title:`Split right ${String(i+1).repeat(32)}`}));
 const tabs=documents.map((d,i)=>({id:i+101,windowId:20,splitViewId:i<2?40:-1,url,title:d.title}));
 return {before:{url,seeds,spaceId:'home',bookmarkFolderId:'root',pin:{bookmarkId:'bookmark'}},after:{tabs,local:{spaces:[{id:'home',bookmarkFolderId:'root'}]},session:{splitPinInstancesV1:{}}},documents};
}
const run=f=>characterizeColdSplit(f.before,f.after,f.documents);
test('identical URLs distinguished by independently observed markers, no product authority implied',()=>{const r=run(fixture());assert.equal(r.allThreeObserved,true);assert.equal(r.nativePairPresent,true);assert.equal(r.productAssociationCount,0);assert.deepEqual(r.unknownSameUrlNativeIds,[]);});
test('missing marker leaves unknown rather than adopting same URL',()=>{const f=fixture();f.documents[0].marker=null;const r=run(f);assert.equal(r.bothOriginalPanesObserved,false);assert.deepEqual(r.unknownSameUrlNativeIds,[101]);});
test('missing native split is characterized without inventing recovery',()=>{const f=fixture();f.after.tabs.forEach(t=>t.splitViewId=-1);assert.equal(run(f).nativePairPresent,false);});
test('unexpected marker rejected',()=>{const f=fixture();f.documents[0].marker='unknown';assert.throws(()=>run(f),/Unexpected/);});
test('duplicated observation token rejected',()=>{const f=fixture();f.documents[1].marker=f.documents[0].marker;assert.throws(()=>run(f),/Duplicated/);});
test('ambiguous current random title rejected',()=>{const f=fixture();f.after.tabs[1].title=f.after.tabs[0].title;assert.throws(()=>run(f),/exactly one/);});
test('wrong document title prefix rejected',()=>{const f=fixture();f.documents[0].title='Other title '+f.documents[0].documentId;f.after.tabs[0].title=f.documents[0].title;assert.throws(()=>run(f));});
test('native split must not contain unrelated duplicate',()=>{const f=fixture();f.after.tabs[2].splitViewId=40;assert.throws(()=>run(f),/unrelated/);});
test('exact product association accepted only with both observed original panes',()=>{const f=fixture();f.after.session.splitPinInstancesV1={'20:bookmark':{windowId:20,spaceId:'home',bookmarkId:'bookmark',splitViewId:40,tabIds:[101,102]}};assert.equal(run(f).productAssociationCount,1);});
test('product adoption of unrelated duplicate rejected',()=>{const f=fixture();f.after.session.splitPinInstancesV1={'20:bookmark':{windowId:20,spaceId:'home',bookmarkId:'bookmark',splitViewId:40,tabIds:[101,103]}};assert.throws(()=>run(f),/must not adopt/);});
test('product association without surviving identity evidence rejected',()=>{const f=fixture();f.documents[0].marker=null;f.after.session.splitPinInstancesV1={'20:bookmark':{windowId:20,spaceId:'home',bookmarkId:'bookmark',splitViewId:40,tabIds:[101,102]}};assert.throws(()=>run(f),/independently observed/);});

test('stale native split witness rejected',()=>{const f=fixture();f.after.session.splitPinInstancesV1={'20:bookmark':{windowId:20,spaceId:'home',bookmarkId:'bookmark',splitViewId:99,tabIds:[101,102]}};assert.throws(()=>run(f),/observed native split/);});

for(const [field,value,pattern] of [['windowId',99,/observed window/],['spaceId','other',/owning Space/]]){
 test(`wrong association ${field} rejected`,()=>{const f=fixture();f.after.session.splitPinInstancesV1={'20:bookmark':{windowId:20,spaceId:'home',bookmarkId:'bookmark',splitViewId:40,tabIds:[101,102],[field]:value}};assert.throws(()=>run(f),pattern);});
}
test('wrong association key rejected',()=>{const f=fixture();f.after.session.splitPinInstancesV1={wrong:{windowId:20,spaceId:'home',bookmarkId:'bookmark',splitViewId:40,tabIds:[101,102]}};assert.throws(()=>run(f),/map key/);});
test('missing saved Space rejected',()=>{const f=fixture();f.after.local.spaces=[];assert.throws(()=>run(f),/Space must still exist/);});
test('changed saved root rejected',()=>{const f=fixture();f.after.local.spaces[0].bookmarkFolderId='changed';assert.throws(()=>run(f),/Space root/);});

import {readFile,mkdtemp,writeFile,mkdir,symlink,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {captureSplitColdPackageInventory,prepareSplitColdRegistration} from './paired-chrome-split-cold-diagnostic.mjs';
test('inventory hashes only exact package regular files and rejects symlinks',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'split-cold-inventory-'));
 try{await mkdir(path.join(root,'nested'));await writeFile(path.join(root,'nested','a.js'),'one');
 const expected=[{id:'arcify',path:root}];const before=await captureSplitColdPackageInventory(expected);
 assert.deepEqual(before[0].files.map(f=>f.path),['nested/a.js']);assert.match(before[0].files[0].sha256,/^[0-9a-f]{64}$/);
 await writeFile(path.join(root,'nested','a.js'),'two');assert.notDeepEqual(await captureSplitColdPackageInventory(expected),before);
 await symlink(path.join(root,'nested','a.js'),path.join(root,'link'));await assert.rejects(()=>captureSplitColdPackageInventory(expected),/rejects symlinks/);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('preflight rejects changed original launch condition without launch or mutation',async()=>{
 const records=[];let launches=0;await assert.rejects(()=>prepareSplitColdRegistration({launchOptions:{args:[]},launch:async()=>{launches++;},record:e=>records.push(e)}));
 assert.equal(launches,0);assert.equal(records.at(-1).status,'failed');assert.equal(records.at(-1).scenarioStarted,false);
});
test('both phases use shared passive bounded registration gate, no setup reload inside module',async()=>{
 const source=await readFile(new URL('./paired-chrome-split-cold-diagnostic.mjs',import.meta.url),'utf8');
 assert.equal((source.match(/await validatedSplitColdRestart\(/g)||[]).length,2);
 assert.match(source,/for\(const expected of expectedExtensions\)/);assert.match(source,/await waitForExactRestartRegistry/);
 assert.match(source,/mode.manager.inDevMode,true/);assert.doesNotMatch(source,/enableDeveloperModeViaUi|runtime\.reload\(|Extensions\.loadUnpacked/);
});
