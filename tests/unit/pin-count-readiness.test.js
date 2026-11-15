import test from 'node:test';import assert from 'node:assert/strict';import {requireBaseline,requirePinnedResult} from '../e2e/helpers/pin-count-readiness.js';
const base=()=>({newTabEnabled:true,windowId:5,activeSpaceId:'home',folder:{id:'folder'},spaces:[{id:'home',bookmarkFolderId:'folder',temporaryTabs:[1,2,3],spaceBookmarks:[]}],tabs:[1,2,3].map(id=>({id,windowId:5,url:`https://fixture.test/${id}`})),visibleSpaces:[{spaceId:'home',temporarySection:true,pinnedSection:true,tempIds:[1,2,3],pinIds:[]}]});
const done=()=>{const s=base();s.spaces[0].temporaryTabs=[2,3];s.spaces[0].spaceBookmarks=[1];s.visibleSpaces[0].tempIds=[2,3];s.visibleSpaces[0].pinIds=[1];s.bindings={1:{bookmarkId:'new-pin',pinnedUrl:'https://fixture.test/1'}};s.bookmark={id:'new-pin',parentId:'folder',url:'https://fixture.test/1'};return s;};
test('same exact source and survivors pass',()=>requirePinnedResult(done(),requireBaseline(base()),1));
for(const change of ['uninitialized','wrong-space','survivor-replaced','source-closed','source-not-pinned','missing-binding','wrong-folder','folder-not-url','changed-pin-url','survivor-navigation'])test(`reject ${change} rather than manufacture zero or success`,()=>{const s=done();if(change==='uninitialized')s.visibleSpaces=[];if(change==='wrong-space')s.activeSpaceId='other';if(change==='survivor-replaced')s.visibleSpaces[0].tempIds=[2,99];if(change==='source-closed')s.tabs.shift();if(change==='source-not-pinned')s.visibleSpaces[0].pinIds=[];if(change==='missing-binding')s.bindings={};if(change==='wrong-folder')s.bookmark.parentId='other';if(change==='folder-not-url')delete s.bookmark.url;if(change==='changed-pin-url')s.bookmark.url='https://wrong.test';if(change==='survivor-navigation')s.tabs[1].url='https://wrong.test';assert.throws(()=>requirePinnedResult(s,requireBaseline(base()),1));});

test('bounded polling cannot turn missing initialization into zero success',async()=>{
 const {waitForPinCountState}=await import('../e2e/helpers/pin-count-readiness.js');
 const states=[{...base(),visibleSpaces:[]},base()];let reads=0;
 const result=await waitForPinCountState({page:{evaluate:async()=>states[reads++]},check:requireBaseline,waitForCondition:async predicate=>{assert.equal(await predicate(),false);assert.equal(await predicate(),true);}});
 assert.equal(result.result.initialTemp,3);assert.equal(reads,2);
});
test('persistent identity mismatch fails with last-state evidence',async()=>{
 const {waitForPinCountState}=await import('../e2e/helpers/pin-count-readiness.js');
 await assert.rejects(waitForPinCountState({page:{evaluate:async()=>({...base(),visibleSpaces:[]})},check:requireBaseline,waitForCondition:async predicate=>{assert.equal(await predicate(),false);throw Error('timeout');}}),/timeout; readiness=[\s\S]*observed=/);
});
