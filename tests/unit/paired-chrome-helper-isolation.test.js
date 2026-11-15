import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {committedHelperWitness,readCommittedHelperState} from '../../scripts/paired-chrome-helper-isolation.mjs';
import {createSpaceRankCheckpoint} from '../../space-continuity.js';
import {createExplicitCheckpoint} from '../../explicit-today-ownership.js';
import {sealDurableLayout} from '../../durable-today-layout.js';
const expected={tabId:2,url:'chrome-extension://peer/options.html',windowId:20,spaceId:'home',root:'home-root'};
async function fixture(){
 const epoch={kind:'session',epoch:'current-session'},witness={version:1,epoch,incarnation:'new-incarnation',transaction:'native-creation',windowId:20,spaceId:'home',bookmarkFolderId:'home-root'};
 const snapshot=[{tabId:2,url:expected.url,tabIndex:0,spaceId:'home',section:'temporaryTabs',currentOwnership:witness}];
 const rankCheckpoint=await createSpaceRankCheckpoint([],snapshot),explicitCheckpoint=await createExplicitCheckpoint(1,rankCheckpoint.fingerprint);
 const layout=await sealDurableLayout(1,[{id:'fresh',signature:[{index:0,url:expected.url,pinned:false}],placements:[{index:0,spaceId:'home',bookmarkFolderId:'home-root',order:0}],binding:{epoch,windowId:20,tabIds:[2]},overrides:[],contextSubset:true,explicitOnly:true,choiceRevision:1}],{liveCount:1,rankFingerprint:rankCheckpoint.fingerprint});
 return{tabs:[{id:2,url:expected.url,windowId:20,index:0,status:'complete',pinned:false,incognito:false,splitViewId:-1}],spaces:[{id:'home',bookmarkFolderId:'home-root',temporaryTabs:[2],spaceBookmarks:[]}],snapshot,rankCheckpoint,explicitCheckpoint,layout,sessionEpoch:epoch.epoch};
}
test('supported realm read verifies exact sealed session witness without worker instrumentation',async()=>{const s=await fixture();const observed=await readCommittedHelperState({evaluate:async()=>structuredClone(s)});assert.deepEqual(committedHelperWitness(observed,expected).ownership,s.snapshot[0].currentOwnership);});
for(const change of ['missing-snapshot','wrong-incarnation-cohort','bad-layout-seal','browser-epoch','stale-session','window','Space','root','duplicate-owner','navigation','pending-navigation','split','private','pin','retired','missing-ranks','historical-tail','tampered-snapshot','mismatched-prefix'])test(`rejects helper proof with ${change}`,async()=>{
 const s=await fixture();
 if(change==='missing-snapshot')s.snapshot=[];
 if(change==='wrong-incarnation-cohort')s.layout.cohorts[0].binding.tabIds=[999];
 if(change==='bad-layout-seal')s.layout.fingerprint='bad';
 if(change==='browser-epoch')s.snapshot[0].currentOwnership.epoch={kind:'browser',epoch:s.sessionEpoch,generation:'paired'};
 if(change==='stale-session')s.sessionEpoch='another-session';
 if(change==='window')s.tabs[0].windowId=21;
 if(change==='Space')s.snapshot[0].currentOwnership.spaceId='other';
 if(change==='root')s.spaces[0].bookmarkFolderId='other';
 if(change==='duplicate-owner')s.spaces.push({...s.spaces[0],id:'other'});
 if(change==='navigation')s.tabs[0].url='https://changed.test';
 if(change==='pending-navigation')s.tabs[0].pendingUrl='https://changed.test';
 if(change==='split')s.tabs[0].splitViewId=3;
 if(change==='private')s.tabs[0].incognito=true;
 if(change==='pin')s.tabs[0].pinned=true;
 if(change==='missing-ranks')delete s.rankCheckpoint;
 if(change==='tampered-snapshot')s.snapshot[0].currentOwnership.incarnation='altered';
 if(change==='historical-tail')s.explicitCheckpoint=await createExplicitCheckpoint(0,s.rankCheckpoint.fingerprint);
 if(change==='mismatched-prefix')s.layout=await sealDurableLayout(1,s.layout.cohorts,{liveCount:0,rankFingerprint:s.rankCheckpoint.fingerprint});
 if(change==='retired')s.layout.retirements=[{cohortId:'fresh'}];
 const observed=await readCommittedHelperState({evaluate:async()=>structuredClone(s)});assert.equal(committedHelperWitness(observed,expected),null);
});
for(const mode of ['full','favorite-lifecycle'])test(`main ${mode} setup preserves ordering and propagates refusal before Favorite`,async()=>{
 const source=readFileSync(new URL('../../scripts/paired-chrome-smoke.mjs',import.meta.url),'utf8');
 const start=source.indexOf('    await step(stepNames[36], async () => {'),end=source.indexOf('    await step(stepNames[32]',start),fragment=source.slice(start,end),calls=[];
 const run=Function('step','stepNames','normalizeReloadControlWindow','exerciseOrdinaryFavorites','fixture','report','saveReport','arcifyOptions','spotlightOptions','pageForUrl','poll','arcifyId','spotlightId','browser','observePage','recreateFixtureHelpers',`return(async()=>{${fragment}})()`);
 await assert.rejects(run(async(_name,fn)=>fn(),[],async()=>{calls.push('normalize');throw Error('unsafe-normalize');},async()=>calls.push('lifecycle'),{windowA:2},{runMode:mode},async()=>{},{},{},()=>{},()=>{},'a','b',{},()=>{},async()=>{calls.push('fresh');throw Error('unsafe-fresh');}),mode==='full'?/unsafe-fresh/:/unsafe-normalize/);
 assert.deepEqual(calls,mode==='full'?['fresh']:['normalize']);
});
