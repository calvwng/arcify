import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecoveryObserver, trustedRecoveryReader, registerRecoveryObservation } from '../../recovery-observation.js';
import { RECOVERY_COUNT_KEYS, validateRecoveryReport } from '../../recovery-report-protocol.js';
const report=()=>({schema:'arcify-recovery-report-v1',observationId:'worker:1',capturedAt:100,authoritative:true,status:'stable',counts:Object.fromEntries(RECOVERY_COUNT_KEYS.map(k=>[k,0]))});

function event() { const listeners=new Set(); return {addListener: f=>listeners.add(f),removeListener: f=>listeners.delete(f),fire(...a){for(const f of listeners)f(...a);},listeners}; }
function fixture() {
    const forbidden=()=>{throw Error('Mutating store helper must never run');};
    const store={chain:Promise.resolve(),initialized:true,spaces:[{id:'space-a',temporaryTabs:[7],spaceBookmarks:[]}],
        restoreQueue:[],recoveryCandidates:new Set(),provisional:new Set(),windowKeys:new Map([[2,'key']]),
        restoreWindowKeys:new Map(),restoredRanks:new Map(),favoriteStore:{initialized:true,items:[],state:{bindings:[],attempts:[]}},
        run:forbidden,initialize:forbidden,reconcile:forbidden,persist:forbidden,queryTabs:forbidden};
    const state={local:{spaceModelVersion:2,spaces:structuredClone(store.spaces)},session:{spaceSession:true},
        tabs:[{id:7,windowId:2,index:0,url:'https://private-fixture.invalid/',title:'PRIVATE TITLE',incognito:false,pinned:false},
            {id:8,windowId:3,index:0,url:'https://incognito.invalid/',incognito:true,pinned:false}],
        windows:[{id:2,type:'normal',incognito:false},{id:3,type:'normal',incognito:true},{id:4,type:'popup',incognito:false}]};
    const api={runtime:{id:'a'.repeat(32),getURL:p=>'chrome-extension://'+'a'.repeat(32)+'/'+p,onMessage:event()},
        tabs:{query:async()=>structuredClone(state.tabs)},windows:{getAll:async()=>structuredClone(state.windows)},
        storage:{local:{get:async()=>structuredClone(state.local),set:forbidden},session:{get:async()=>structuredClone(state.session),set:forbidden},onChanged:event()}};
    for(const name of ['onCreated','onRemoved','onUpdated','onMoved','onDetached','onAttached','onReplaced'])api.tabs[name]=event();
    api.windows.onCreated=event();api.windows.onRemoved=event();
    const sender={id:api.runtime.id,url:api.runtime.getURL('options.html'),origin:api.runtime.getURL('').slice(0,-1),frameId:0,documentLifecycle:'active',tab:{incognito:false}};
    return {store,state,api,sender};
}

test('stable capture is queued, private-window filtered and has no mutation-producing helper calls',async()=>{
    const {store,api}=fixture(); const before=structuredClone(store.spaces);
    const observer=createRecoveryObserver(store,api,{workerId:'worker',now:()=>100});
    const result=await observer.capture();
    assert.equal(result.stable,true);assert.equal(result.atomic,false);assert.equal(result.scope,'live-store');
    assert.deepEqual(result.tabs.map(t=>t.id),[7]);assert.deepEqual(result.windows.map(w=>w.id),[2]);
    assert.deepEqual(result.revision,{workerId:'worker',sequence:1,start:0,end:0});
    assert.deepEqual(store.spaces,before);assert.equal((await observer.capture()).revision.sequence,2);observer.dispose();
});
test('cold capture does not initialize either store or turn persisted IDs into live ownership',async()=>{
    const {store,api}=fixture();store.initialized=false;store.favoriteStore.initialized=false;
    const observer=createRecoveryObserver(store,api);const result=await observer.capture();
    assert.equal(result.scope,'persisted-projection');assert.equal(result.memory.initialized,false);
    assert.equal(store.initialized,false);observer.dispose();
});
test('group sync setting is read twice and a changed setting invalidates the observation',async()=>{
    const {store,api}=fixture();let calls=0;
    api.storage.sync={get:async key=>{assert.equal(key,'syncTabGroups');return {syncTabGroups:++calls===1};},set:()=>assert.fail('read only')};
    const observer=createRecoveryObserver(store,api);const result=await observer.capture();
    assert.equal(calls,2);assert.equal(result.stable,false);observer.dispose();
});
test('capture waits for the existing writer and does not enter SpaceStore.run',async()=>{
    const {store,api}=fixture();let release,queried=false;
    store.chain=new Promise(resolve=>{release=resolve;});
    const query=api.tabs.query;api.tabs.query=async()=>{queried=true;return query();};
    const observer=createRecoveryObserver(store,api);const pending=observer.capture();
    await Promise.resolve();assert.equal(queried,false);release();await pending;assert.equal(queried,true);observer.dispose();
});
for(const kind of ['native-event','native-read','storage-read','memory-read'])test(`changes during ${kind} capture are explicitly unstable`,async()=>{
    const {store,state,api}=fixture();let count=0;const query=api.tabs.query;
    api.tabs.query=async()=>{const result=await query();if(++count===1){
        if(kind==='native-event')api.tabs.onUpdated.fire(7,{status:'complete'});
        if(kind==='native-read')state.tabs[0].windowId=9;
        if(kind==='storage-read')state.local.spaceModelVersion=3;
        if(kind==='memory-read')store.recoveryCandidates.add(7);
    }return result;};
    const observer=createRecoveryObserver(store,api);assert.equal((await observer.capture()).stable,false);observer.dispose();
});
test('a failed read does not poison the writer queue and raw errors never reach the UI',async()=>{
    const {store,api,sender}=fixture();api.storage.local.get=async()=>{throw Error('SECRET browsing data');};
    const dispose=registerRecoveryObservation(store,api,()=>{throw Error('must not classify');});
    const reply=await new Promise(resolve=>api.runtime.onMessage.fire({type:'arcifyRecoveryObservation'},sender,resolve));
    assert.equal(reply.success,false);assert(!JSON.stringify(reply).includes('SECRET'));
    await store.chain;dispose();
});
test('only the aggregate returned by the policy adapter leaves the worker',async()=>{
    const {store,api,sender}=fixture();
    const expected=report();expected.counts.nativePages=1;
    const dispose=registerRecoveryObservation(store,api,snapshot=>({...report(),counts:{...report().counts,nativePages:snapshot.tabs.length}}));
    const reply=await new Promise(resolve=>api.runtime.onMessage.fire({type:'arcifyRecoveryObservation'},sender,resolve));
    assert.deepEqual(reply,{success:true,report:expected});assert(!JSON.stringify(reply).includes('private'));dispose();
});
test('reader allowlist accepts packaged top-level options/sidebar without mandatory documentId',()=>{
    const {api,sender}=fixture();assert(trustedRecoveryReader(api,sender));
    assert(trustedRecoveryReader(api,{...sender,url:api.runtime.getURL('sidebar.html'),frameId:undefined,documentLifecycle:undefined}));
    for(const patch of [{id:'b'.repeat(32)},{url:'https://example.invalid/'},{url:api.runtime.getURL('options.html')+'?embedded'},
        {url:api.runtime.getURL('transient-window.html')},{frameId:1},{documentLifecycle:'cached'},{origin:'https://example.invalid'},{tab:{incognito:true}}])
        assert.equal(trustedRecoveryReader(api,{...sender,...patch}),false,JSON.stringify(patch));
});
test('unknown request properties are refused before reading browser data',async()=>{
    const {store,api,sender}=fixture();api.tabs.query=()=>{throw Error('must not read');};
    const dispose=registerRecoveryObservation(store,api,()=>({}));let reply;
    api.runtime.onMessage.fire({type:'arcifyRecoveryObservation',tabId:7},sender,r=>reply=r);
    assert.equal(reply.success,false);dispose();
});
test('disposed observers reject and release all event listeners',async()=>{
    const {store,api}=fixture();const observer=createRecoveryObserver(store,api);observer.dispose();
    await assert.rejects(observer.capture(),/unavailable/);assert.equal(api.tabs.onUpdated.listeners.size,0);
});
for(const extra of [{url:'https://private.invalid/'},{title:'SECRET'},{tabId:7},{error:'PRIVATE'},{observationId:'https://private.invalid/'},
    {counts:{...report().counts,tabIds:[7]}},{counts:{...report().counts,nativePages:-1}},{authoritative:true,status:'cold'}])
    test(`aggregate rejects extra data or malformed value ${Object.keys(extra)[0]} ${JSON.stringify(extra).length}`,()=>assert.throws(()=>validateRecoveryReport({...report(),...extra})));
test('untrusted summarizer output is refused without leaking its values',async()=>{
    const {store,api,sender}=fixture();const dispose=registerRecoveryObservation(store,api,()=>({...report(),title:'SECRET'}));
    const reply=await new Promise(resolve=>api.runtime.onMessage.fire({type:'arcifyRecoveryObservation'},sender,resolve));
    assert.equal(reply.success,false);assert(!JSON.stringify(reply).includes('SECRET'));dispose();
});
