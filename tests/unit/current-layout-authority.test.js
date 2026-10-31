import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './today-recovery-fixture.js';
import { stageCurrentLayoutAuthority, stageObservedLayoutCreation } from '../../current-layout-authority.js';
import { explicitTodayEpochs } from '../../explicit-today-ownership.js';
import { DURABLE_LAYOUT_KEY } from '../../durable-today-layout.js';
import { SpaceStore } from '../../space-store.js';

async function setup() {
    const f=fixture();
    for(const tab of f.tabs)tab.url=`https://authority.test/${tab.id}`;
    f.session.spaceExplicitTodayEpoch='surviving-session';
    f.identity={epoch:'browser-epoch-token',generation:'writer-generation-token'};
    f.favorite={initialize:async()=>{},reconcile:async()=>{},ownsTab:()=>false,
        ownershipPersistence:{browserIdentity:async()=>f.identity}};
    f.store.favoriteStore=f.favorite;
    f.records=[1,2,3,9].map(tabId=>({tabId,spaceId:'source',section:'temporaryTabs'}));
    f.proof={kind:'session',epoch:'surviving-session'};
    return f;
}
const stage=f=>stageCurrentLayoutAuthority(f.store,f.records,f.tabs,f.proof);
async function reload(f){const s=new SpaceStore();s.favoriteStore=f.favorite;s.discoverBookmarkSpaces=async()=>false;await s.initialize();return s;}

test('valid session proof remains acceptable while browser issuance is preferred',async()=>{
    const f=await setup();assert.deepEqual((await explicitTodayEpochs(f.store)).map(e=>e.kind),['browser','session']);
    const before=structuredClone(f.store.spaces);await stage(f);
    assert.equal(f.store.explicitToday.get(1).epoch.kind,'browser');assert.deepEqual(f.store.spaces,before);
    await f.store.persist();assert.deepEqual(f.local.spaces,before);
    assert.deepEqual(f.local.tabNameOverridesById[2],{name:'Named'});
    assert.deepEqual((await reload(f)).spaces,before);
});

for(const kind of ['pin','queued-pin','private','native-pin','split','transient','global','pending-navigation','saved-pin'])test(`current proof cannot promote ${kind}`,async()=>{
    const f=await setup(),tab=f.tabs.find(t=>t.id===1);f.records=f.records.slice(0,1);
    if(kind==='pin')f.local.pinnedTabStatesById[1]={bookmarkId:'pin'};
    if(kind==='queued-pin')f.store.restoredMetadata=[{tabId:1,pinnedState:{bookmarkId:'pin'}}];
    if(kind==='private')tab.incognito=true;
    if(kind==='native-pin')tab.pinned=true;
    if(kind==='split')tab.splitViewId=3;
    if(kind==='transient')f.store.isTransientTab=t=>(typeof t==='object'?t.id:t)===1;
    if(kind==='global')f.globals.add(1);
    if(kind==='pending-navigation')tab.pendingUrl='https://changed.test/';
    if(kind==='saved-pin'){f.store.spaces[0].temporaryTabs.shift();f.store.spaces[0].spaceBookmarks.push(1);}
    assert.equal(await stage(f),undefined);assert(!f.store.explicitToday?.has(1));
});

for(const race of ['epoch','generation','session-proof','navigation','close','window','pin','private','split','owner','root','alias','queued-pin','unpromoted-order'])test(`checkpoint rejects changed ${race} after staging current authority`,async()=>{
    const f=await setup();f.records=f.records.slice(0,1);await stage(f);
    const t=f.tabs.find(t=>t.id===1);
    if(race==='epoch')f.identity.epoch='new-epoch';
    if(race==='generation')f.identity.generation='new-generation';
    if(race==='session-proof')delete f.session.spaceExplicitTodayEpoch;
    if(race==='navigation')t.url='https://changed.test/';
    if(race==='close')f.tabs.splice(f.tabs.indexOf(t),1);
    if(race==='window')t.windowId=20;
    if(race==='pin')f.local.pinnedTabStatesById[1]={bookmarkId:'pin'};
    if(race==='private')t.incognito=true;
    if(race==='split')t.splitViewId=3;
    if(race==='owner')f.store.spaces[1].temporaryTabs.push(1);
    if(race==='root')f.store.spaces[0].bookmarkFolderId='target-root';
    if(race==='alias')f.local.tabNameOverridesById[1]={name:'Changed'};
    if(race==='queued-pin')f.store.restoredMetadata.push({tabId:1,pinnedState:{bookmarkId:'pin'}});
    if(race==='unpromoted-order')f.store.spaces[0].temporaryTabs=[1,3,2,9];
    await assert.rejects(f.store.currentLayoutFence());
    assert(!f.effects.some(([area,value])=>area==='local'&&value[DURABLE_LAYOUT_KEY]));
});

for(const phase of ['before-local','after-local','before-session','after-session'])test(`current authority reconciles ${phase} interruption from committed storage`,async()=>{
    const f=await setup();await f.store.persist();await stage(f);
    const expected=structuredClone(f.store.spaces);let fired=false;
    f.hooks[phase.startsWith('before')?'beforeSet':'afterSet']=(area,value)=>{
        if(!fired&&(phase.includes('local')?area==='local'&&value[DURABLE_LAYOUT_KEY]:area==='session'&&value.spaceSession)){
            fired=true;throw Error('injected interruption');
        }
    };
    await assert.rejects(f.store.persist(),/injected interruption/);assert(fired);assert.equal(f.store.initialized,false);
    f.hooks.beforeSet=f.hooks.afterSet=null;
    const warm=await reload(f);assert.deepEqual(warm.spaces,expected);
    delete f.session.spaceSession;const replay=await reload(f);assert.deepEqual(replay.spaces,expected);
    assert.deepEqual(f.local.tabNameOverridesById[2],{name:'Named'});
});

test('checkpoint readback validates membership as well as the ledger',async()=>{
    const f=await setup();await stage(f);let fired=false;
    f.hooks.afterSet=(area,value)=>{if(!fired&&area==='local'&&value[DURABLE_LAYOUT_KEY]){fired=true;f.local.spaces[0].temporaryTabs.reverse();}};
    await assert.rejects(f.store.persist(),/Current layout checkpoint could not be verified/);
    assert.equal(f.store.initialized,false);
    assert(!f.effects.some(([area,value])=>area==='session'&&value.spaceSession));
});

async function creation(){
    const f=await setup();await stage(f);await f.store.persist();
    const tab={id:9900,windowId:10,index:20,url:'https://creation.test/',pinned:false,incognito:false,splitViewId:-1};
    f.tabs.push(tab);f.store.spaces[0].temporaryTabs.push(tab.id);
    f.store.currentLayoutWorker='worker-token';f.event={worker:'worker-token',token:'event-token',windowId:10};
    f.store.layoutObservedCreations=new Map([[tab.id,f.event]]);return f;
}
test('creation event issues a fresh session witness after deliberate browser-proof disconnection',async()=>{
    const f=await creation();f.identity=null;delete f.session.spaceExplicitTodayEpoch;
    await stageObservedLayoutCreation(f.store,9900,f.event,f.tabs);await f.store.persist();
    assert.equal(f.store.explicitToday.get(9900).epoch.kind,'session');
    assert(f.local.spaces[0].temporaryTabs.includes(9900));
    await assert.rejects(stageCurrentLayoutAuthority(f.store,f.records,f.tabs,{kind:'browser',epoch:'browser-epoch-token',generation:'writer-generation-token'}),/proof expired/);
});
for(const race of ['removed','replacement','transfer','worker','reinitialize','generation'])test(`creation-event fence rejects ${race} after staging`,async()=>{
    const f=await creation();await stageObservedLayoutCreation(f.store,9900,f.event,f.tabs);
    if(race==='removed')f.store.layoutObservedCreations.delete(9900);
    if(race==='replacement')f.store.layoutObservedCreations.set(9900,{...f.event,token:'different-event'});
    if(race==='transfer')f.tabs.find(t=>t.id===9900).windowId=20;
    if(race==='worker')f.store.currentLayoutWorker='other-worker';
    if(race==='reinitialize')f.store.initialized=false;
    if(race==='generation')f.identity.generation='changed-generation-token';
    await assert.rejects(f.store.currentLayoutFence());
});
