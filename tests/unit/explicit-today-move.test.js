import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './today-recovery-fixture.js';
import { SpaceStore } from '../../space-store.js';
import { restoreExplicitToday, EXPLICIT_TODAY_CHECKPOINT,createExplicitCheckpoint } from '../../explicit-today-ownership.js';
import { createSpaceRankCheckpoint } from '../../space-continuity.js';
const { moveTodayTabsToSpace } = await import(process.env.ARCIFY_BASELINE_MOVE ? '../../.baseline-today-move-store.js' : '../../today-move-store.js');
const owner = (spaces,id) => spaces.find(s=>s.temporaryTabs.includes(id))?.id;
async function setup({browserIdentity}={}) {
    const f=fixture(), ids=[101,102,103,104,105,106,107];
    for(const id of ids) f.tabs.push({id,index:f.tabs.length,windowId:10,url:`https://selected.test/${id}`,pinned:false,incognito:false,splitViewId:-1});
    f.store.spaces[0].temporaryTabs.push(...ids);
    f.store.windowKeys=new Map([[10,'current'],[20,'other']]);
    f.store.restoreWindowKeys=new Map([[10,'current'],[20,'other']]);
    f.store.restoreQueue=ids.flatMap((id,i)=>Array.from({length:i<5?2:1},(_,j)=>({
        tabId: id, url:`https://selected.test/${id}`,spaceId:i<6?'target':'source',section:'temporaryTabs',
        windowKey:`historical-${i}-${j}`,tabIndex:0,order:i, historicalMarker:`keep-${i}-${j}`
    })));
    f.store.recoveryCandidates=new Set(ids);
    if(browserIdentity)f.store.favoriteStore={initialize:async()=>{},reconcile:async()=>{},ownershipPersistence:{browserIdentity}};
    await f.store.persist();
    assert.equal(f.store.recoveryCandidates.size,7);
    f.history=structuredClone(f.store.restoreQueue); f.ids=ids;
    f.request.entries=ids.map(tabId=>({tabId,url:`https://selected.test/${tabId}`}));
    f.move=()=>moveTodayTabsToSpace(f.store,f.request);
    f.effects.length=0;
    return f;
}
async function reload(f) {
    const store=new SpaceStore(); store.discoverBookmarkSpaces=async()=>false;
    store.favoriteStore=f.store.favoriteStore;store.isGlobalTab=f.store.isGlobalTab;
    await store.initialize(); return store;
}
test('seven selected flagged Today tabs move directly, preserve all colliding history and persist fresh identity',async()=>{
    const f=await setup(), native=structuredClone(f.tabs);
    assert.deepEqual((await f.move()).completed,f.ids);
    for(const id of f.ids) assert.equal(owner(f.local.spaces,id),'target');
    assert.deepEqual(f.store.restoreQueue,f.history);assert.deepEqual(f.session.spaceRestoreQueue,f.history);
    assert.deepEqual(f.local.spaceTabSnapshot.slice(f.local[EXPLICIT_TODAY_CHECKPOINT].liveCount),f.history);
    assert.equal(f.store.recoveryCandidates.size,0);assert.deepEqual(f.tabs,native);
    const records=f.local.spaceTabSnapshot.slice(0,f.local[EXPLICIT_TODAY_CHECKPOINT].liveCount).filter(r=>f.ids.includes(r.tabId));
    assert.equal(records.length,7);assert.equal(new Set(records.map(r=>r.currentOwnership.incarnation)).size,7);
    await f.store.persist();assert.deepEqual(f.store.restoreQueue,f.history);
    for(const id of f.ids) assert.equal(owner(f.store.spaces,id),'target');
});
test('repeated explicit moves replace current placement without accumulating history or changing incarnation',async()=>{
    const f=await setup();await f.move();const tokens=f.ids.map(id=>f.store.explicitToday.get(id).incarnation);
    f.store.active[10]='target';f.session.activeSpaces[10]='target';
    Object.assign(f.request,{spaceId:'target',bookmarkFolderId:'target-root',destinationSpaceId:'source',destinationBookmarkFolderId:'source-root'});
    await f.move();assert.deepEqual(f.store.restoreQueue,f.history);
    assert.deepEqual(f.ids.map(id=>f.store.explicitToday.get(id).incarnation),tokens);
    assert.equal(f.store.explicitToday.size,7);
    for(const id of f.ids) assert.equal(owner(f.local.spaces,id),'source');
});
test('worker reload reconciles explicit live identities before historical matching',async()=>{
    const f=await setup();await f.move();const warm=await reload(f);
    assert.deepEqual(warm.restoreQueue,f.history);assert.equal(warm.recoveryCandidates.size,0);
    assert.equal(warm.explicitToday.size,7);for(const id of f.ids) assert.equal(owner(warm.spaces,id),'target');
});
for(const failure of ['before-local','after-local','before-session','after-session']) test(`interrupted ${failure} preserves history and recovers only committed placement`,async()=>{
    const f=await setup();let attempts=0;
    const fail=(area,value)=>{
        const boundary=failure.includes('local')?area==='local'&&value.spaces:area==='session'&&value.spaceSession;
        if(boundary){attempts++;throw Error('injected interrupted acknowledgement');}
    };
    f.hooks[failure.startsWith('before')?'beforeSet':'afterSet']=fail;
    await assert.rejects(f.move());assert.equal(attempts,1);
    f.hooks.beforeSet=null;f.hooks.afterSet=null;
    const warm=await reload(f), committed=failure!=='before-local';
    for(const id of f.ids) assert.equal(owner(warm.spaces,id),committed?'target':'source');
    assert.deepEqual(warm.restoreQueue,f.history);
    if(committed){assert.equal(warm.recoveryCandidates.size,0);assert.equal(f.session.spaceRecoveryCandidates.length,0);}
});
test('new browser epoch cannot replay numeric IDs as explicit identity; next explicit move remains usable',async()=>{
    const f=await setup();await f.move();const oldTokens=f.ids.map(id=>f.store.explicitToday.get(id).incarnation);for(const key of Object.keys(f.session))delete f.session[key];
    const cold=await reload(f);assert(f.ids.every((id,index)=>cold.explicitToday.get(id)?.incarnation!==oldTokens[index]));
    for(const r of f.history)assert(cold.restoreQueue.some(x=>JSON.stringify(x)===JSON.stringify(r)));
    const source=owner(cold.spaces,101), target=source==='source'?'target':'source';cold.active[10]=source;
    const ids=f.ids.filter(id=>owner(cold.spaces,id)===source);
    const request={...f.request,spaceId:source,bookmarkFolderId:`${source}-root`,destinationSpaceId:target,destinationBookmarkFolderId:`${target}-root`,entries:ids.map(tabId=>({tabId,url:`https://selected.test/${tabId}`}))};
    await moveTodayTabsToSpace(cold,request);for(const id of ids)assert.equal(owner(cold.spaces,id),target);
});
test('unrelated native tab can recover its historical record sharing an explicitly moved URL',async()=>{
    const f=await setup();await f.move();
    const record=f.store.restoreQueue.find(r=>r.url==='https://selected.test/106');
    const tab={id:900,windowId:90,url:record.url,index:0,pinned:false,incognito:false};
    f.tabs.push(tab);f.store.liveTabs.set(tab.id,tab);f.store.restoreWindowKeys.set(90,record.windowKey);
    f.store.track(tab);assert.equal(owner(f.store.spaces,900),'target');
    assert.equal(f.store.restoreQueue.length,f.history.length-1);assert.equal(owner(f.store.spaces,106),'target');
    assert.equal(f.store.explicitToday.has(900),false);
});
test('historical metadata stays historical and current names stay bound to exact live tab',async()=>{
    const f=await setup();f.store.restoreQueue[0].pinnedState={bookmarkId:'historical-pin'};f.store.restoreQueue[0].nameOverride={name:'old name'};
    f.local.tabNameOverridesById[101]={name:'current name'};f.history=structuredClone(f.store.restoreQueue);
    await f.move();assert.deepEqual(f.store.restoreQueue,f.history);
    assert.equal(f.local.pinnedTabStatesById[101],undefined);assert.deepEqual(f.local.tabNameOverridesById[101],{name:'current name'});
});
test('forgetting a native ID never deletes a historical ID collision',async()=>{
    const f=await setup();await f.move();f.store.forgetTab(101);assert.deepEqual(f.store.restoreQueue,f.history);assert(!f.store.explicitToday.has(101));
});
test('contradictory checkpoint cannot clear recovery flags from an explicit witness alone',async()=>{
    const f=await setup();await f.move();f.local.spaceTabSnapshot[0].url='https://corrupt.test/';
    f.store.recoveryCandidates=new Set(f.ids);await restoreExplicitToday(f.store,f.local,f.tabs);
    assert.equal(f.store.explicitToday.size,0);assert.equal(f.store.recoveryCandidates.size,7);
});
test('late navigation refuses whole batch before canonical write, preserving flags and history',async()=>{
    const f=await setup();f.hooks.get=(area,key)=>{if(area==='session'&&key==='spaceExplicitTodayEpoch')f.tabs.find(t=>t.id===101).url='https://changed.test/';};
    await assert.rejects(f.move());assert.equal(f.effects.filter(([area,value])=>area==='local'&&value.spaces).length,0);
    assert.deepEqual(f.store.restoreQueue,f.history);assert.equal(f.store.recoveryCandidates.size,7);
});
test('history ID collision with a transient tab does not erase pending record during persistence',async()=>{
    const f=await setup();f.store.isTransientTab=value=>(typeof value==='object'?value?.id:value)===101;
    f.store.forgetTab(101);await f.store.persist();assert(f.store.restoreQueue.some(r=>r.tabId===101));
});
test('fallback session witness survives newly proven browser identity and a lost session acknowledgement',async()=>{
    const f=await setup();let identity=null;
    f.store.favoriteStore={initialize:async()=>{},reconcile:async()=>{},ownershipPersistence:{browserIdentity:async()=>identity}};
    f.hooks.beforeSet=(area,value)=>{if(area==='session'&&value.spaceSession)throw Error('session interrupted');};
    await assert.rejects(f.move());f.hooks.beforeSet=null;
    identity={epoch:'proven-browser-epoch',generation:'proven-browser-generation'};
    const warm=await reload(f);assert.equal(warm.explicitToday.size,7);assert.equal(warm.recoveryCandidates.size,0);
    assert.deepEqual(warm.restoreQueue,f.history);for(const id of f.ids)assert.equal(owner(warm.spaces,id),'target');
});
test('tampered historical boundary cannot turn historical witnesses into live proof',async()=>{
    const f=await setup();await f.move();f.local[EXPLICIT_TODAY_CHECKPOINT].liveCount++;
    f.store.recoveryCandidates=new Set(f.ids);await restoreExplicitToday(f.store,f.local,f.tabs);
    assert.equal(f.store.explicitToday.size,0);assert.equal(f.store.recoveryCandidates.size,7);
});
test('canonical persistence clears the explicit boundary when its last live binding disappears',async()=>{
    const f=await setup();await f.move();for(const id of f.ids)f.store.forgetTab(id);
    f.tabs.splice(0,f.tabs.length,...f.tabs.filter(tab=>!f.ids.includes(tab.id)));await f.store.persist();
    assert.equal(f.local[EXPLICIT_TODAY_CHECKPOINT],null);assert.deepEqual(f.store.restoreQueue,f.history);
});
test('proven browser witness survives same-epoch session loss but never a different browser epoch',async()=>{
    let identity={epoch:'a-browser-epoch-token',generation:'a-browser-generation-token'};const f=await setup({browserIdentity:async()=>identity});
    await f.move();assert(f.ids.every(id=>f.store.explicitToday.get(id).epoch.kind==='browser'));for(const key of Object.keys(f.session))delete f.session[key];
    const same=await reload(f);assert(f.ids.every(id=>same.explicitToday.has(id)));assert.deepEqual(same.restoreQueue,f.history);
    identity={epoch:'different-browser-epoch',generation:'different-browser-generation'};
    f.store.recoveryCandidates=new Set(f.ids);await restoreExplicitToday(f.store,f.local,f.tabs);
    assert.equal(f.store.explicitToday.size,0);assert.equal(f.store.recoveryCandidates.size,7);
});

for(const failure of ['different-epoch','duplicate-record','missing-destination','existing-owner','owner-race','destination-race'])test(`unowned exact witness rejects ${failure} without guessing membership`,async()=>{
    let identity={epoch:'stable-browser',generation:'stable-generation'};const f=await setup({browserIdentity:async()=>identity});await f.move();
    for(const space of f.store.spaces)space.temporaryTabs=space.temporaryTabs.filter(id=>!f.ids.includes(id));
    if(failure==='different-epoch')identity={epoch:'new-browser',generation:'new-generation'};
    if(failure==='missing-destination')f.store.spaces=f.store.spaces.filter(space=>space.id!=='target');
    if(failure==='existing-owner')f.store.spaces.find(space=>space.id==='source').temporaryTabs.push(101);
    if(failure==='duplicate-record'){
        const count=f.local[EXPLICIT_TODAY_CHECKPOINT].liveCount,rows=f.local.spaceTabSnapshot;
        f.local.spaceTabSnapshot=[...rows.slice(0,count),structuredClone(rows.find(r=>r.tabId===101&&r.currentOwnership)),...rows.slice(count)];
        f.local.spaceRankCheckpoint=await createSpaceRankCheckpoint([...f.store.restoredRanks],f.local.spaceTabSnapshot);
        f.local[EXPLICIT_TODAY_CHECKPOINT]=await createExplicitCheckpoint(count+1,f.local.spaceRankCheckpoint.fingerprint);
    }
    let fired=false;const query=chrome.tabs.query;chrome.tabs.query=async filter=>{if(!fired&&failure.endsWith('race')){fired=true;
        if(failure==='owner-race')f.store.spaces.find(space=>space.id==='source').temporaryTabs.push(101);
        else f.store.spaces=f.store.spaces.filter(space=>space.id!=='target');
    }return query(filter);};
    const run=()=>restoreExplicitToday(f.store,f.local,f.tabs);
    if(failure.endsWith('race'))await assert.rejects(run);else await run();
    assert(!f.store.explicitToday.has(101));assert.notEqual(owner(f.store.spaces,101),'target');
    if(failure==='existing-owner'||failure==='owner-race')assert.equal(owner(f.store.spaces,101),'source');
});

for(const change of ['pin','epoch'])test(`unowned witness rejects ${change} changes during final destination lookup`,async()=>{
    let identity={epoch:'stable-browser',generation:'stable-generation'};const f=await setup({browserIdentity:async()=>identity});await f.move();
    for(const space of f.store.spaces)space.temporaryTabs=space.temporaryTabs.filter(id=>!f.ids.includes(id));
    let calls=0;f.hooks.bookmark=()=>{if(++calls===8){if(change==='pin')f.local.pinnedTabStatesById[101]={bookmarkId:'new-pin'};else identity={epoch:'changed-browser',generation:'changed-generation'};}};
    await assert.rejects(()=>restoreExplicitToday(f.store,f.local,f.tabs),/changed during ownership recovery/);
    assert(f.ids.every(id=>!f.store.explicitToday.has(id)&&owner(f.store.spaces,id)===undefined));
});
test('native change during asynchronous ownership reconciliation cannot release any recovery flags',async()=>{
    const f=await setup();await f.move();f.store.recoveryCandidates=new Set(f.ids);
    f.hooks.window=()=>{f.tabs.find(t=>t.id===101).url='https://changed-during-read.test/';};
    await assert.rejects(restoreExplicitToday(f.store,f.local,structuredClone(f.tabs)),/changed during ownership recovery/);
    assert.equal(f.store.recoveryCandidates.size,7);assert.equal(f.store.explicitToday.size,0);
});
for(const protection of ['split','pin','favorite','binding','private','provisional'])test(`flagged live adoption still refuses ${protection}`,async()=>{
    const f=await setup(),tab=f.tabs.find(t=>t.id===101);
    if(protection==='split')tab.splitViewId=0;
    if(protection==='pin')tab.pinned=true;
    if(protection==='favorite')f.globals.add(101);
    if(protection==='binding')f.local.pinnedTabStatesById[101]={bookmarkId:'current-pin'};
    if(protection==='private')tab.incognito=true;
    if(protection==='provisional')f.store.provisional.add(101);
    await assert.rejects(f.move());assert.equal(f.effects.filter(([area,value])=>area==='local'&&value.spaces).length,0);
    assert.deepEqual(f.store.restoreQueue,f.history);
});
