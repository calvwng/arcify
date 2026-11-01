import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import {createSpaceContinuityStamp} from '../../space-continuity.js';
import {createHash} from 'node:crypto';
import {encodeFavoriteContinuityState as encode} from '../../favorite-continuity.js';
import {assertReloadSavedOwners} from '../../scripts/paired-chrome-little-arc-reload.mjs';
import { LITTLE_ARC_NATIVE_UNVERIFIED, installLittleArcReloadObservation, readLittleArcReloadObservation, stopLittleArcReloadObservation,
    assertLittleArcReloadObservation, readLittleArcReloadDocument, assertLittleArcReloadDocument, claimLittleArcReloadOnboarding,
    assertLittleArcReloadOnboardingUnchanged, assertLittleArcMissingControllerReload } from '../../scripts/paired-chrome-little-arc-reload.mjs';

import { readLittleArcRawState } from '../../scripts/paired-chrome-little-arc.mjs';

const ARCIFY = 'a'.repeat(32), PEER = 'b'.repeat(32), TOKEN = '00000000-0000-4000-8000-000000000001';
const URL = 'http://127.0.0.1:1234/little-arc/' + 'c'.repeat(32) + '/duplicate';
const marker = `chrome-extension://${ARCIFY}/transient-window.html?token=${TOKEN}`;
const onboarding = `chrome-extension://${ARCIFY}/installation-onboarding.html`;
const copy = structuredClone;
const tab = (id, windowId, url = URL) => ({ id, windowId, url, pendingUrl: null, pinned: false, incognito: false, groupId: -1, splitViewId: -1, active: false, index: id });
const win = id => ({ id, type: 'normal', incognito: false, focused: false, width: 800, height: 600 });
const doc = id => ({ documentId: `document-${id}`, timeOrigin: id, value: `unsaved-${id}`, notes: `notes-${id}`, checked: true,
    sameDocument: true, sameInput: true, sameNotes: true, topLevel: true, frameCount: 0 });
const native = (name, ...data) => ({ type: `tabs.${name}`, data });
function fixture() {
    const record = { token: TOKEN, controllerTabId: 201, tabId: 202, windowId: 9, originWindowId: 7, memberTabIds: [201,202,203], phase: 'ready' };
    const before = { tabs: [tab(101,7),tab(102,8),tab(103,7,`chrome-extension://${ARCIFY}/options.html`),tab(201,9,marker),tab(202,9),tab(203,9)],
        windows: [win(7),win(8),win(9)], groups: [], spaces: [{ id:'work',bookmarkFolderId:'folder',spaceBookmarks:[],temporaryTabs:[101,102] }],
        sessionPresence:{registry:true,journal:true},registry:{version:1,records:[record]},journal:[{response:{ok:true,token:TOKEN,tabId:202,transientWindowId:9}}],savedSnapshot:[],bindings:{},favoriteSession:{bindings:[],attempts:[]},
        snapshots:{8:{windowId:8,capturedAt:1,tabs:[tab(102,8)],spaces:[{id:'work',temporaryTabIds:[102]}]}},activeSpaces:{8:'work'},
        pageStates:{101:doc(101),202:doc(202),203:doc(203)} };
    const after = copy(before); after.tabs = after.tabs.filter(tab=>![103,201].includes(tab.id)); after.tabs.push(tab(301,7,`chrome-extension://${ARCIFY}/options.html`),tab(302,7,onboarding));
    after.registry.records=[];after.journal=[];after.spaces[0].temporaryTabs.push(202,203);
    after.savedSnapshot=[202,203].map(tabId=>({tabId,spaceId:'work',section:'temporaryTabs'}));
    after.snapshots[9]={windowId:9,tabs:[202,203].map(id=>({id,spaceId:'work'})),spaces:[{id:'work',temporaryTabIds:[202,203]}]};
    const events=[native('onRemoved',201,{windowId:9}),native('onRemoved',103,{windowId:7}),native('onCreated',copy(after.tabs.find(t=>t.id===301))),native('onCreated',copy(after.tabs.find(t=>t.id===302)))];
    return { before,after,options:{record:copy(record),twinId:203,oldApiTabId:103,newApiTabId:301,onboardingId:302,arcifyId:ARCIFY,windowB:8,events} };
}
const verify = f => assertLittleArcMissingControllerReload(f.before,f.after,f.options);
function witness() { return { tab:tab(302,7,onboarding),extensionId:ARCIFY,url:onboarding,timeOrigin:123,readyState:'complete',documentIds:['native-document-302'] }; }
function onboardingClaim() { const f=fixture();return {before:f.before,after:f.after,events:f.options.events,settings:{version:'5.1.0'},witness:witness(),arcifyId:ARCIFY,windowId:7}; }
function peer() { return {nonce:'nonce',extensionId:PEER,tab:tab(900,7,`chrome-extension://${PEER}/options.html`),timeOrigin:55,sameDocument:true,intact:true,overflow:false,captureError:false,stopped:false,events:[]}; }

test('full reload deterministically verifies absent controller, distinct ordinary exact-ID adoption and unchanged documents', () => {
    const f=fixture(), result=verify(f);assert.deepEqual(result.ordinaryTabIds,[202,203]);assert.equal(result.removedControllerTabId,201);assert.equal(result.noNativeReplayEffects,true);
    const noOnboarding=fixture();noOnboarding.after.tabs=noOnboarding.after.tabs.filter(t=>t.id!==302);noOnboarding.options.events=noOnboarding.options.events.filter(e=>e.type!=='tabs.onCreated'||e.data[0].id!==302);noOnboarding.options.onboardingId=null;verify(noOnboarding);
});

test('missing-controller reload rejects survival, recreation, old authority, clone/movement and ordinary adoption failures', () => {
    for (const mutate of [
        f=>f.after.tabs.push(tab(201,9,marker)), f=>f.after.tabs.push(tab(999,9,marker)), f=>f.after.tabs.find(t=>t.id===202).url=marker,
        f=>f.before.registry.records.push(copy(f.options.record)),f=>f.before.registry.records[0].controllerTabId=999,f=>f.before.registry.records[0].tabId=999,
        f=>f.before.registry.records[0].windowId=8,f=>f.before.registry.records[0].originWindowId=8,f=>f.before.registry.records[0].memberTabIds.pop(),
        f=>f.after.registry=null,f=>f.after.registry=false,f=>f.after.journal=null,f=>f.after.journal=false,f=>f.before.sessionPresence.registry=false,
        f=>f.after.registry.records.push(copy(f.options.record)), f=>f.after.journal.push({old:true}), f=>f.before.registry.records=[], f=>f.before.journal=[],
        f=>f.after.tabs.push(tab(999,9)),f=>f.after.tabs=f.after.tabs.filter(t=>t.id!==202),f=>f.after.tabs.find(t=>t.id===203).windowId=7,
        f=>f.after.spaces[0].temporaryTabs.pop(),f=>f.after.spaces[0].temporaryTabs.push(203),f=>f.after.spaces[0].spaceBookmarks.push(202),
        f=>f.before.spaces[0].temporaryTabs.push(202),f=>f.after.spaces[0].temporaryTabs=f.after.spaces[0].temporaryTabs.filter(id=>id!==101),
        f=>f.after.savedSnapshot.push({tabId:999,spaceId:'work',section:'temporaryTabs'}),f=>f.after.savedSnapshot.pop(),f=>f.after.savedSnapshot.push(copy(f.after.savedSnapshot[0])),f=>f.after.savedSnapshot[0].section='spaceBookmarks',
        f=>f.after.snapshots[9].tabs[0].id=999,f=>f.after.snapshots[9].spaces[0].temporaryTabIds.pop(),
        f=>f.after.bindings[202]={saved:true},f=>f.after.favoriteSession.bindings.push({tabId:203}),
        f=>f.after.windows.push(win(10)),f=>f.after.windows.find(w=>w.id===8).focused=true,f=>f.after.tabs.find(t=>t.id===102).active=true,
        f=>f.after.snapshots[8].tabs=[],f=>f.after.activeSpaces[8]='other', f=>f.after.spaces[0].bookmarkFolderId='other', f=>f.after.groups.push({id:1}),
        f=>f.options.events.push(native('onActivated',{tabId:102,windowId:8})),f=>f.options.events.push({type:'windows.onFocusChanged',data:[8]}),
        f=>f.options.events.push(native('onCreated',tab(999,9))),f=>f.options.events.push(native('onRemoved',202)),
        f=>f.options.events.push(native('onReplaced',999,202)),f=>f.options.events.push(native('onMoved',202,{})),
        f=>f.options.events.push(native('onAttached',203,{})),f=>f.options.events.push(native('onDetached',203,{})),
        f=>f.options.events.push(native('onUpdated',202,{status:'loading'})),f=>f.options.events.push(native('onUpdated',302,{url:marker})),
        f=>f.options.events.push({type:'bookmarks.onCreated',data:[]}),f=>f.options.events.push({type:'tabGroups.onUpdated',data:[]}),
        f=>f.options.events.push({type:'windows.onCreated',data:[win(10)]}),f=>f.options.events.pop()
    ]) { const f=fixture();mutate(f);assert.throws(()=>verify(f),mutate.toString()); }
    for (const key of ['pinned','splitViewId','groupId','windowId','incognito']) {
        const f=fixture(); f.options.events.push(native('onUpdated',202,{[key]:'changed'}),native('onUpdated',202,{[key]:f.before.tabs.find(t=>t.id===202)[key]}));
        assert.throws(()=>verify(f), `Rolled-back ${key} still fails.`);
    }
    for(const key of ['documentId','timeOrigin','value','notes','checked','sameDocument','sameInput','sameNotes','topLevel','frameCount']) {
        const f=fixture();f.after.pageStates[202][key]='changed';assert.throws(()=>verify(f),key);
    }
});

test('continuous peer observation rejects lost/reset/overflowed capture and changed observer identity', () => {
    const before=peer(),after=copy(before);after.events.push(native('onRemoved',201));assert.deepEqual(assertLittleArcReloadObservation(before,after,PEER),after.events);
    for(const mutate of [v=>v.extensionId=ARCIFY,v=>v.nonce='new',v=>v.timeOrigin++,v=>v.sameDocument=false,v=>v.intact=false,v=>v.overflow=true,v=>v.captureError=true,v=>v.stopped=true,v=>v.tab.id++,v=>v.tab.windowId++,v=>v.tab.url='changed']) {
        const bad=copy(after);mutate(bad);assert.throws(()=>assertLittleArcReloadObservation(before,bad,PEER));
    }
    const started=peer();started.events.push(native('onCreated',tab(5,7)));assert.throws(()=>assertLittleArcReloadObservation(started,peer(),PEER));
    const replaced=copy(started);replaced.events[0]=native('onRemoved',5);assert.throws(()=>assertLittleArcReloadObservation(started,replaced,PEER));
});

test('peer native listeners observe all relevant events through reload without observing Arcify transport or mutating APIs', async () => {
    const names={tabs:['onCreated','onRemoved','onReplaced','onActivated','onAttached','onDetached','onMoved','onUpdated'],windows:['onCreated','onRemoved','onFocusChanged'],tabGroups:['onCreated','onUpdated','onMoved','onRemoved'],bookmarks:['onCreated','onRemoved','onChanged','onMoved']};
    const listeners=[],chrome={runtime:{id:PEER}};
    for(const [api,events] of Object.entries(names)) {chrome[api]={};for(const name of events){const set=new Set();listeners.push(set);chrome[api][name]={addListener:f=>set.add(f),removeListener:f=>set.delete(f),hasListener:f=>set.has(f)};}}
    chrome.tabs.getCurrent=async()=>tab(900,7);const realm={chrome,document:{},performance:{timeOrigin:55},structuredClone};
    const run=(fn,arg)=>runInNewContext(`(${fn.toString()})(${JSON.stringify(arg)})`,realm);
    run(installLittleArcReloadObservation,{nonce:'nonce'});assert.equal(listeners.length,19);assert(listeners.every(set=>set.size===1));
    assert.throws(()=>run(installLittleArcReloadObservation,{nonce:'other'}),/already installed/);
    for(const set of listeners) for(const listener of set)listener(201,{});
    let value=await run(readLittleArcReloadObservation);assert.equal(value.events.length,19);assert.equal(value.intact,true);assert.equal(value.sameDocument,true);
    const first=listeners[0];first.delete([...first][0]);assert.equal((await run(readLittleArcReloadObservation)).intact,false);
    run(stopLittleArcReloadObservation);assert(listeners.every(set=>set.size===0));await assert.rejects(()=>run(readLittleArcReloadObservation),/missing/);
    const original=chrome.bookmarks.onMoved;delete chrome.bookmarks.onMoved.removeListener;
    assert.throws(()=>run(installLittleArcReloadObservation,{nonce:'missing-api'}),/Missing native observer/);assert(listeners.every(set=>set.size===0));
    original.removeListener=f=>listeners.at(-1).delete(f);const add=chrome.bookmarks.onMoved.addListener;
    chrome.bookmarks.onMoved.addListener=()=>{throw new Error('registration failed');};
    assert.throws(()=>run(installLittleArcReloadObservation,{nonce:'partial'}),/registration failed/);assert(listeners.every(set=>set.size===0));
    chrome.bookmarks.onMoved.addListener=add;
    run(installLittleArcReloadObservation,{nonce:'limit'});
    for(let i=0;i<2001;i++)for(const listener of listeners[0])listener(tab(i+1,7));
    assert.equal((await run(readLittleArcReloadObservation)).overflow,true);run(stopLittleArcReloadObservation);
});

test('onboarding cleanup authority requires actual version branch, exact newly observed ID and native document proof', () => {
    const c=onboardingClaim(),receipt=claimLittleArcReloadOnboarding(c);assert.equal(receipt.id,302);assert.match(receipt.attribution,/do not expose the API caller/);
    assertLittleArcReloadOnboardingUnchanged(witness(),receipt);
    for(const mutate of [c=>c.before.tabs.push(tab(302,7,onboarding)),c=>c.events.push(copy(c.events.at(-1))),c=>c.events.pop(),c=>c.events.at(-1).data[0].windowId=8,
        c=>c.settings.onboardingVersion='5.1.0',c=>c.settings.version='',c=>c.witness.tab.id=999,c=>c.witness.tab.windowId=8,c=>c.witness.extensionId=PEER,
        c=>c.witness.tab.splitViewId=8,c=>c.witness.tab.groupId=2,c=>c.witness.url+='?other',c=>c.witness.readyState='loading',c=>c.witness.documentIds=[],c=>c.witness.documentIds.push('other'),
        c=>c.after.tabs.push(tab(999,7,onboarding)),c=>c.after.tabs.find(t=>t.id===302).pendingUrl='https://other.test/']){
        const bad=onboardingClaim();mutate(bad);assert.throws(()=>claimLittleArcReloadOnboarding(bad),mutate.toString());
    }
    for(const mutate of [v=>v.tab.pinned=true,v=>v.tab.incognito=true,v=>v.tab.splitViewId=2,v=>v.timeOrigin++,v=>v.documentIds=['replacement'],v=>v.tab.url='https://other.test/',v=>v.tab.pendingUrl='https://other.test/',v=>v.extensionId=PEER]){
        const changed=witness();mutate(changed);assert.throws(()=>assertLittleArcReloadOnboardingUnchanged(changed,receipt));
    }
});

test('document identity witness uses real native tab and runtime contexts without writing state', async () => {
    const value=witness(),realm={chrome:{runtime:{id:ARCIFY,getContexts:async filter=>{assert.deepEqual(JSON.parse(JSON.stringify(filter)),{contextTypes:['TAB'],tabIds:[302]});return [{documentId:'native-document-302'}];}},tabs:{getCurrent:async()=>value.tab}},document:{URL:onboarding,readyState:'complete'},performance:{timeOrigin:123}};
    const result=await runInNewContext(`(${readLittleArcReloadDocument.toString()})()`,realm);assertLittleArcReloadDocument(result,{id:302,windowId:7,url:onboarding,extensionId:ARCIFY});
});

test('published case identity and evidence never present removed orphan scenarios as passed native recovery', () => {
    assert.equal(LITTLE_ARC_NATIVE_UNVERIFIED.length,5);
    const source=readFileSync(new globalThis.URL('../../scripts/paired-chrome-little-arc.mjs',import.meta.url),'utf8');
    assert.match(source,/missing-controller reload fallback/);assert.match(source,/status: 'not-run', nativeValidated: false/);
    assert.equal((source.match(/await reloadArcify\(\)/g)||[]).length,1);
    assert.doesNotMatch(source,/reloadLittleArcControllerDocument|recovery\.controller|click\('#recover'\)|storage\.session\.(?:set|remove|clear)/);
    assert.match(source,/assertLittleArcReloadOnboardingUnchanged\(await page.evaluate/);
    assert.match(source,/contexts\[0\]\.documentId !== receipt.documentIds\[0\]/);
    assert.match(source,/no fixture page may leak/);
});


test('raw authority preserves key presence and malformed falsy values instead of fabricating empty session state', async () => {
    for (const session of [{}, {transientWindowSession:{version:1,records:[]},spotlightBridgeRequests:[]},
        {transientWindowSession:null,spotlightBridgeRequests:false}, {transientWindowSession:false,spotlightBridgeRequests:null}]) {
        const realm={chrome:{storage:{local:{get:async()=>({})},session:{get:async()=>session}},tabs:{query:async()=>[]},windows:{getAll:async()=>[]},tabGroups:{query:async()=>[]},bookmarks:{getTree:async()=>[]}}};
        const result=JSON.parse(JSON.stringify(await runInNewContext(`(${readLittleArcRawState.toString()})()`,realm)));
        assert.deepEqual(result.sessionPresence,{registry:Object.hasOwn(session,'transientWindowSession'),journal:Object.hasOwn(session,'spotlightBridgeRequests')});
        assert.deepEqual(result.registry,Object.hasOwn(session,'transientWindowSession')?session.transientWindowSession:{version:1,records:[]});
        assert.deepEqual(result.journal,Object.hasOwn(session,'spotlightBridgeRequests')?session.spotlightBridgeRequests:[]);
    }
    const absent=fixture();absent.after.sessionPresence={registry:false,journal:false};verify(absent);
});

async function ownershipReplay(){
 const f=fixture(),epoch='10000000-0000-4000-8000-000000000001',generation='20000000-0000-4000-8000-000000000001';
 f.before.savedSnapshot=[101,102].map(tabId=>({tabId,spaceId:'work',section:'temporaryTabs',url:URL}));
 const receipt={version:1,schema:'exact-global-favorites-v2',peerId:PEER,epoch,generation,revision:4,fingerprint:createHash('sha256').update(encode(f.before.favoriteSession)).digest('hex')};
 f.before.continuityReceipt=copy(receipt);f.after.continuityReceipt=copy(receipt);
 f.before.continuityStamp=await createSpaceContinuityStamp({epoch,generation},f.before.savedSnapshot);
 f.after.savedSnapshot=f.before.savedSnapshot.map(row=>({...copy(row),currentOwnership:{version:1,epoch:{kind:'browser',epoch,generation},incarnation:`30000000-0000-4000-8000-${String(row.tabId).padStart(12,'0')}`,transaction:'40000000-0000-4000-8000-000000000001',windowId:f.before.tabs.find(t=>t.id===row.tabId).windowId,spaceId:'work',bookmarkFolderId:'folder'}}));
 return f;
}
test('authenticated replay can add exact current authority to unchanged native Today owners',async()=>{
 const f=await ownershipReplay();assertReloadSavedOwners(f.before,f.after,[],PEER);
 const integrated=await ownershipReplay();integrated.after.savedSnapshot.push(...fixture().after.savedSnapshot);integrated.options.spotlightId=PEER;verify(integrated);
 f.before.savedSnapshot[0].currentOwnership=copy(f.after.savedSnapshot[0].currentOwnership);
 f.before.savedSnapshot[0].currentOwnership.transaction='60000000-0000-4000-8000-000000000001';f.after.savedSnapshot[0].currentOwnership=copy(f.before.savedSnapshot[0].currentOwnership);
 f.before.continuityStamp=await createSpaceContinuityStamp(f.before.continuityReceipt,f.before.savedSnapshot);
 assertReloadSavedOwners(f.before,f.after,[],PEER);
 f.after.savedSnapshot[0].currentOwnership.transaction='50000000-0000-4000-8000-000000000001';assert.throws(()=>assertReloadSavedOwners(f.before,f.after,[],PEER));
});
test('reload authority rejects unproven identity, changed ownership, history and malformed witnesses',async()=>{
 const history=await ownershipReplay();history.before.continuityStamp=await createSpaceContinuityStamp(history.before.continuityReceipt,history.before.savedSnapshot.slice(0,1));assert.throws(()=>assertReloadSavedOwners(history.before,history.after,[],PEER),/Historical suffix/);
 for(const mutate of [
 f=>delete f.before.continuityStamp,f=>delete f.before.continuityReceipt,f=>delete f.after.continuityReceipt,
 f=>f.before.continuityStamp.fingerprint='0'.repeat(64),f=>f.before.continuityStamp.liveCount=0,f=>f.after.continuityReceipt.fingerprint='0'.repeat(64),
 f=>f.after.continuityReceipt.epoch='90000000-0000-4000-8000-000000000001',f=>f.after.continuityReceipt.phase='recovering',f=>{f.before.continuityReceipt.peerId=ARCIFY;f.after.continuityReceipt.peerId=ARCIFY;},f=>f.after.continuityReceipt.peerId=ARCIFY,
 f=>f.after.savedSnapshot[0].currentOwnership.extra=true,f=>delete f.after.savedSnapshot[0].currentOwnership.incarnation,
 f=>f.after.savedSnapshot[0].currentOwnership.epoch.kind='session',f=>f.after.savedSnapshot[0].currentOwnership.windowId=8,
 f=>f.after.savedSnapshot[0].currentOwnership.spaceId='other',f=>f.after.savedSnapshot[0].currentOwnership.bookmarkFolderId='other',
 f=>f.after.savedSnapshot[1].currentOwnership.incarnation=f.after.savedSnapshot[0].currentOwnership.incarnation,
 f=>f.after.savedSnapshot[0].currentOwnership.transaction=f.after.savedSnapshot[0].currentOwnership.incarnation,
 f=>f.after.savedSnapshot[0].url='https://changed.test/',f=>f.after.tabs[0].windowId=8,f=>f.before.tabs[0].pinned=true,
 f=>f.after.spaces[0].temporaryTabs=f.after.spaces[0].temporaryTabs.filter(id=>id!==101),
 f=>f.after.bindings[101]={bookmarkId:'pin'},f=>f.before.favoriteSession.bindings.push({tabId:101}),
 f=>f.before.registry.records[0].memberTabIds.push(101),f=>f.after.spaces.push({id:'other',bookmarkFolderId:'folder',temporaryTabs:[],spaceBookmarks:[]})
 ]){const f=await ownershipReplay();mutate(f);assert.throws(()=>assertReloadSavedOwners(f.before,f.after,[],PEER),mutate.toString());}
});
