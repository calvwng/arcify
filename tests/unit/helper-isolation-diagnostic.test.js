import test from 'node:test';import assert from 'node:assert/strict';
import {recreateFixtureHelpers} from '../../scripts/paired-chrome-helper-isolation.mjs';
for(const condition of ['missing-proof','stale-generation','wrong-Space','uncommitted','missing-snapshot'])test(`fixture keeps old helper when ${condition}`,async()=>{
 const epoch={kind:'browser',epoch:'current',generation:'current'};
 const old={id:1,windowId:10,url:'chrome-extension://peer/options.html',active:false,pinned:false,incognito:false,status:'complete'};
 const created={...old,id:2,windowId:20};let removed=false,targetRead=0;
 const oldDocument={extensionId:'peer',tab:old,documentUrl:old.url,timeOrigin:1};const newDocument={extensionId:'peer',tab:created,documentUrl:old.url,timeOrigin:2};
 const page={waitForFunction:async()=>{},evaluate:async fn=>fn.name==='readControlDocument'?newDocument:2};const target={type:()=> 'page',url:()=>old.url,page:async()=>page};
 const apiPage={evaluate:async(fn,args)=>{if(fn.name==='readControlWindowState')return{tabs:[old],spaces:[{id:'home',bookmarkFolderId:'home-root'}],activeSpaces:{20:'home'}};if(fn.name==='readControlDocument')return{tab:{id:99,windowId:20}};if(args?.url&&args?.windowId===20)return created;removed=true;throw Error('Unexpected mutation');}};
 const proof={layout:{fingerprint:'same'},committedLayout:{fingerprint:'same',cohorts:[{id:'fresh',binding:{windowId:20,epoch,tabIds:[2]},signature:[{url:old.url,index:0}],placements:[{index:0,spaceId:'home',bookmarkFolderId:'home-root'}]}]},epochs:[epoch],decisions:[{tabId:2,url:old.url,windowId:20,explicitOwner:true,terminal:false,ownership:{spaceId:'home',bookmarkFolderId:'home-root',epoch:{...epoch}}}]};
 proof.committedSnapshot=[{tabId:2,url:old.url,spaceId:'home',section:'temporaryTabs',currentOwnership:structuredClone(proof.decisions[0].ownership)}];
 if(condition==='missing-snapshot')proof.committedSnapshot=[];
 if(condition==='missing-proof')proof.decisions=[];if(condition==='stale-generation')proof.decisions[0].ownership.epoch.generation='old';if(condition==='wrong-Space')proof.decisions[0].ownership.spaceId='other';if(condition==='uncommitted')proof.committedLayout.fingerprint='older';
 await assert.rejects(()=>recreateFixtureHelpers({browser:{targets:()=>targetRead++? [target]:[]},apiPage,spotlightId:'peer',oldOptions:{evaluate:async()=>oldDocument},pageForUrl:async()=>{},observePage:async p=>p,
 poll:async(read,accept,label)=>{const result=await read();if(!accept(result))throw Error(label);return result;},readProof:async()=>proof,record:async()=>{}}),/fresh final-window helper/);
 assert.equal(removed,false,'No old helper may be removed when new authority fails');
});
