import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {assertRestoredOriginals,assertNoAssociation,assertFocusOnlyReceipt,assertUnchangedFocusNative} from './paired-chrome-focus-link-acceptance.mjs';
const exact={ids:[11,12],unrelatedId:13,windowId:8,spaceId:'home',bookmarkId:'b'};
function state(){const tabs=[11,12,13].map((id,i)=>({id,windowId:8,url:'http://same/',index:i,groupId:4,pinned:false,splitViewId:i<2?42:-1,active:false}));return{window:{id:8,type:'normal',incognito:false},tabs,documents:[{id:11,marker:'left',timeOrigin:1},{id:12,marker:'right',timeOrigin:2},{id:13,marker:'other',timeOrigin:3}],local:{spaces:[],savedSplitRecipesV1:[],bookmarks:[]},session:{activeSpaces:{8:'home'},splitPinInstancesV1:{},splitPinFocusLinksV1:{'8:b':{version:1,phase:'linked',windowId:8,spaceId:'home',bookmarkId:'b',target:{space:{id:'home',bookmarkFolderId:'root'},bookmark:{id:'b'}},entries:tabs.slice(0,2).map(({id,...t})=>({tabId:id,url:t.url,index:t.index,groupId:t.groupId,pinned:t.pinned,splitViewId:t.splitViewId}))}}}};}
test('valid focus-only receipt has exact original tabs and native shape',()=>assertFocusOnlyReceipt(state(),exact));
for(const [label,mutate] of [
 ['wrong pair',s=>s.session.splitPinFocusLinksV1['8:b'].entries[1].tabId=13],
 ['wrong Space',s=>s.session.splitPinFocusLinksV1['8:b'].spaceId='other'],
 ['wrong window',s=>s.session.splitPinFocusLinksV1['8:b'].windowId=9],
 ['pending receipt',s=>s.session.splitPinFocusLinksV1['8:b'].phase='pending'],
 ['strong association',s=>s.session.splitPinInstancesV1.x={bookmarkId:'b'}],
 ['wrong key',s=>{s.session.splitPinFocusLinksV1.wrong=s.session.splitPinFocusLinksV1['8:b'];delete s.session.splitPinFocusLinksV1['8:b'];}],
 ['native changed',s=>s.tabs[0].splitViewId=-1],
 ['unrelated added to pair',s=>s.tabs[2].splitViewId=42],
 ['stale URL',s=>s.tabs[0].url='http://different/']
])test(`reject ${label}`,()=>{const s=state();mutate(s);assert.throws(()=>assertFocusOnlyReceipt(s,exact));});
test('no implicit strong or focus receipt allowed at baseline',()=>{const s=state();assert.throws(()=>assertNoAssociation(s,'b'));s.session.splitPinFocusLinksV1={};assertNoAssociation(s,'b');s.session.splitPinInstancesV1.x={bookmarkId:'b'};assert.throws(()=>assertNoAssociation(s,'b'));});
test('activation alone allowed, all native inventory/document changes refused',()=>{const a=state(),b=structuredClone(a);b.tabs[0].active=true;assertUnchangedFocusNative(a,b);for(const change of [s=>s.tabs.pop(),s=>s.tabs[0].windowId++,s=>s.tabs[0].index++,s=>s.tabs[0].groupId++,s=>s.tabs[0].url+='x',s=>s.documents[0].timeOrigin++,s=>s.local.bookmarks.push({id:'new'})]){const c=structuredClone(a);change(c);assert.throws(()=>assertUnchangedFocusNative(a,c));}});
test('explicit unsplit exception changes only split membership, not identity',()=>{const a=state(),b=structuredClone(a);b.tabs.forEach(t=>t.splitViewId=-1);assert.throws(()=>assertUnchangedFocusNative(a,b));assertUnchangedFocusNative(a,b,{allowUnsplit:true});b.tabs[0].id++;assert.throws(()=>assertUnchangedFocusNative(a,b,{allowUnsplit:true}));});
test('cold baseline requires original unique tokens, no inferred ownership',()=>{const c={status:'passed',targetWindow:{spaceId:'home'},pin:{bookmarkId:'b'},seeds:['left','right','unrelated'].map(role=>({role,marker:role})),characterization:{allThreeObserved:true,nativePairPresent:true,productAssociationCount:0,roles:Object.fromEntries(['left','right','unrelated'].map((r,i)=>[r,{newTabId:11+i,windowId:8,marker:r}]))}};assert.deepEqual(assertRestoredOriginals(c),exact);for(const change of [v=>v.characterization.allThreeObserved=false,v=>v.characterization.productAssociationCount=1,v=>v.characterization.roles.left.marker='wrong',v=>v.characterization.roles.right.newTabId=11]){const bad=structuredClone(c);change(bad);assert.throws(()=>assertRestoredOriginals(bad));}});
test('harness uses worker close only and real UI, never direct attach request or reload',async()=>{const s=await readFile(new URL('./paired-chrome-focus-link-acceptance.mjs',import.meta.url),'utf8');assert.match(s,/await terminateObservedWorker/);assert.doesNotMatch(s,/runtime\.reload\(|action:\s*['"](?:attach|unlinkFocus)['"]/);assert.match(s,/original\[0\]\.click\(\)/);assert.match(s,/Remove link; keep panes/);});

import {installFocusActivateObserver,assertConfirmedFocusResponse} from './paired-chrome-focus-link-acceptance.mjs';
test('passive observer returns exact real promise, receiver and args with one dispatch',async()=>{
 const prior=globalThis.chrome;let calls=0,receiver,args;const response={success:true,focused:true,focusOnly:true,tabIds:[11,12]};const promise=Promise.resolve(response);
 const original=function(...actual){calls++;receiver=this;args=actual;return promise;};globalThis.chrome={runtime:{sendMessage:original}};
 try{installFocusActivateObserver(exact);const message={type:'splitPinAction',action:'activate',windowId:8,spaceId:'home',bookmarkId:'b'};assert.equal(chrome.runtime.sendMessage(message),promise);await promise;assert.equal(calls,1);assert.equal(receiver,chrome.runtime);assert.equal(args[0],message);const events=globalThis.__pairedFocusActivateObserver.stop();assert.equal(chrome.runtime.sendMessage,original);assertConfirmedFocusResponse(events,exact);
 const bad=structuredClone(events);bad[0].response={success:false,error:'Focus may have changed, but result could not be confirmed'};assert.throws(()=>assertConfirmedFocusResponse(bad,exact));assert.throws(()=>assertConfirmedFocusResponse([...events,...events],exact));
 }finally{globalThis.__pairedFocusActivateObserver?.stop();globalThis.chrome=prior;}
});
test('passive observer preserves actual rejection and synchronous error',async()=>{
 const prior=globalThis.chrome,error=Error('real failure');const promise=Promise.reject(error);promise.catch(()=>{});globalThis.chrome={runtime:{sendMessage:()=>promise}};
 try{installFocusActivateObserver(exact);const message={type:'splitPinAction',action:'activate',windowId:8,spaceId:'home',bookmarkId:'b'};assert.equal(chrome.runtime.sendMessage(message),promise);await assert.rejects(promise);const events=globalThis.__pairedFocusActivateObserver.stop();assert.equal(events[0].state,'rejected');assert.throws(()=>assertConfirmedFocusResponse(events,exact));chrome.runtime.sendMessage=()=>{throw error;};installFocusActivateObserver(exact);assert.throws(()=>chrome.runtime.sendMessage(message),e=>e===error);assert.equal(globalThis.__pairedFocusActivateObserver.stop()[0].state,'threw');
 }finally{globalThis.__pairedFocusActivateObserver?.stop();globalThis.chrome=prior;}
});

import {assertConfirmedLinkResponse} from './paired-chrome-focus-link-acceptance.mjs';
test('actual attach rejection fails immediately with product error, without receipt polling',async()=>{
 const prior=globalThis.chrome;let calls=0;const promise=Promise.resolve({success:false,error:'Candidate changed; no link saved'});globalThis.chrome={runtime:{sendMessage:()=>{calls++;return promise;}}};
 try{installFocusActivateObserver({...exact,action:'attach'});const message={type:'splitPinAction',action:'attach',windowId:8,spaceId:'home',bookmarkId:'b',candidateToken:'opaque'};assert.equal(chrome.runtime.sendMessage(message),promise);await promise;const events=globalThis.__pairedFocusActivateObserver.stop();assert.equal(calls,1);assert.throws(()=>assertConfirmedLinkResponse(events,exact),/Candidate changed; no link saved/);events[0].response={success:true,linked:true,focusOnly:true};assertConfirmedLinkResponse(events,exact);events[0].response.linked=false;assert.throws(()=>assertConfirmedLinkResponse(events,exact));
 }finally{globalThis.__pairedFocusActivateObserver?.stop();globalThis.chrome=prior;}
});
test('generalized observer preserves callback overload arguments, this and return value without callback wrapping',()=>{
 const prior=globalThis.chrome;let calls=0,receiver,actualArgs,callbackCalls=0;
 const callback=()=>callbackCalls++;const token={originalReturn:true};globalThis.chrome={runtime:{sendMessage:function(...args){calls++;receiver=this;actualArgs=args;args[1]({success:true});return token;}}};
 try{installFocusActivateObserver({...exact,action:'attach'});const message={type:'splitPinAction',action:'attach',windowId:8,spaceId:'home',bookmarkId:'b'};assert.equal(chrome.runtime.sendMessage(message,callback),token);assert.equal(calls,1);assert.equal(callbackCalls,1);assert.equal(receiver,chrome.runtime);assert.equal(actualArgs[0],message);assert.equal(actualArgs[1],callback);const events=globalThis.__pairedFocusActivateObserver.stop();assert.equal(events[0].state,'unsupported');assert.throws(()=>assertConfirmedLinkResponse(events,exact));
 }finally{globalThis.__pairedFocusActivateObserver?.stop();globalThis.chrome=prior;}
});
test('published six-step summary contract remains exact; attach response is evidence only',async()=>{
 const s=await readFile(new URL('./paired-chrome-focus-link-acceptance.mjs',import.meta.url),'utf8');
 assert.deepEqual([...s.matchAll(/await save\('([^']+)'/g)].map(m=>m[1]),['two-pairs-before-explicit-choice','linked','worker-replaced','focused-originals','stale-link-refused','unlinked']);
 assert.match(s,/evidence\.linkResponse=await finishActivation\(\);await record\(structuredClone\(evidence\)\);assertConfirmedLinkResponse/);
});

import {assertStaleFocusRefusal,assertConfirmedUnlinkResponse} from './paired-chrome-focus-link-acceptance.mjs';
const staleError='This Split View pin or its Space changed. Refresh the sidebar before trying again.';
function refusal(){const before=state();const receipt=structuredClone(before.session.splitPinFocusLinksV1['8:b']);before.tabs[0].splitViewId=before.tabs[1].splitViewId=-1;return{before,after:structuredClone(before),receipt,events:[{request:{type:'splitPinAction',action:'activate',windowId:8,spaceId:'home',bookmarkId:'b',bookmarkFolderId:'root'},state:'resolved',response:{success:false,error:staleError}}]};}
const successfulFocus=()=>[{request:{type:'splitPinAction',action:'activate',windowId:8,spaceId:'home',bookmarkId:'b',bookmarkFolderId:'root'},state:'resolved',response:{success:true,focused:true,focusOnly:true,tabIds:[11,12]}}];
const checkRefusal=f=>assertStaleFocusRefusal(f.before,f.after,f.events,exact,f.receipt,successfulFocus());
test('exact legitimate stale response accepted only with complete unchanged unsplit evidence',()=>assert.equal(checkRefusal(refusal()),staleError));
for(const message of ['Wrong window context','Could not establish connection. Receiving end does not exist.','An unexpected error occurred','No fresh pair was opened','Focus link storage is invalid. No fresh pair was opened.'])test(`generic or wrong-scope refusal rejected: ${message}`,()=>{const f=refusal();f.events[0].response.error=message;assert.throws(()=>checkRefusal(f),/Unexpected failure/);});
for(const [name,change] of [['wrong request window',f=>f.events[0].request.windowId=9],['transport rejection',f=>f.events[0].state='rejected'],['new tab',f=>f.after.tabs.push({...f.after.tabs[0],id:999})],['document reload',f=>f.after.documents[0].timeOrigin++],['durable change',f=>f.after.local.bookmarks.push({id:'changed'})],['receipt loss',f=>delete f.after.session.splitPinFocusLinksV1['8:b']],['strong witness',f=>f.after.session.splitPinInstancesV1.x={bookmarkId:'b'}],['active changed',f=>f.after.tabs[0].active=true],['original not unsplit',f=>f.before.tabs[0].splitViewId=f.after.tabs[0].splitViewId=42]])test(`stale refusal rejects ${name}`,()=>{const f=refusal();change(f);assert.throws(()=>checkRefusal(f));});
test('unlink requires exact actual action response with confirmed removal',()=>{const events=refusal().events;events[0].request.action='unlinkFocus';events[0].response={success:true,unlinked:true};assertConfirmedUnlinkResponse(events,exact);events[0].response.unlinked=false;assert.throws(()=>assertConfirmedUnlinkResponse(events,exact));events[0].response={success:true,unlinked:true};events[0].request.bookmarkId='other';assert.throws(()=>assertConfirmedUnlinkResponse(events,exact));});
test('post-stale native receipt state recorded before interpreting any error',async()=>{const s=await readFile(new URL('./paired-chrome-focus-link-acceptance.mjs',import.meta.url),'utf8');assert.match(s,/evidence\.refusalResponse=await finishActivation\(\);evidence\.refusalState=await read\(\);await record\(structuredClone\(evidence\)\);/);assert.match(s,/await startActivation\('unlinkFocus'\)/);});

test('generic stale string cannot mask changed bookmark root or extra scope fields',()=>{for(const change of [e=>e.request.bookmarkFolderId='wrong-root',e=>e.request.type='wrong-type',e=>e.request.extraScope='unexpected']){const f=refusal();change(f.events[0]);assert.throws(()=>checkRefusal(f),/previously successful scope/);}});

test('pre-stale independent baseline persisted before actual click',async()=>{const s=await readFile(new URL('./paired-chrome-focus-link-acceptance.mjs',import.meta.url),'utf8');assert.match(s,/evidence\.refusalBeforeState=unsplit;await record\(structuredClone\(evidence\)\);assertCurrentFocusScope\(unsplit,exact\);\s+await startActivation\(\);await pinInput\('stale'/);});

import {assertOnlyFocusReceiptRemoved} from './paired-chrome-focus-link-acceptance.mjs';
test('unlink removes only exact scoped receipt without unrelated session changes',()=>{
 const before=state();before.session.splitPinFocusLinksV1.other={bookmarkId:'other',token:'keep'};const after=structuredClone(before);delete after.session.splitPinFocusLinksV1['8:b'];assertOnlyFocusReceiptRemoved(before,after,exact);
 for(const mutate of [s=>delete s.session.splitPinFocusLinksV1.other,s=>s.session.splitPinInstancesV1.x={bookmarkId:'new'},s=>s.tabs[0].active=true]){const bad=structuredClone(after);mutate(bad);assert.throws(()=>assertOnlyFocusReceiptRemoved(before,bad,exact));}
});

import {assertCurrentFocusScope} from './paired-chrome-focus-link-acceptance.mjs';
for(const [name,mutate] of [['wrong active map',s=>s.session.activeSpaces[8]='other'],['missing map',s=>delete s.session.activeSpaces],['missing window mapping',s=>delete s.session.activeSpaces[8]],['wrong window',s=>s.window.id=9],['private',s=>s.window.incognito=true],['popup',s=>s.window.type='popup'],['missing native window',s=>delete s.window]])test(`unchanged invalid native scope rejected: ${name}`,()=>{const f=refusal();mutate(f.before);mutate(f.after);assert.throws(()=>assertCurrentFocusScope(f.before,exact));assert.throws(()=>checkRefusal(f));});
