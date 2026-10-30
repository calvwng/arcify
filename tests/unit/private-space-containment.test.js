import test from 'node:test';
import assert from 'node:assert/strict';
import { SpaceStore } from '../../space-store.js';
import { FavoriteStore } from '../../favorite-store.js';
import { createFavoriteContinuity } from '../../favorite-continuity.js';
import { createTransientWindowStore } from '../../transient-window-store.js';
import { captureWindowTabs, matchRestoreRecord } from '../../space-restore.js';
import { Utils } from '../../utils.js';
const secret='https://private.example/secret?token=private';
const clone=x=>structuredClone(x);
function fixture() {
 const local={spaceModelVersion:2,spaces:[{id:'home',name:'Home',color:'blue',bookmarkFolderId:'home',spaceBookmarks:[],temporaryTabs:[]}]},session={spaceSession:true},sync={};
 const f={local,session,tabs:[{id:1,windowId:1,url:'https://normal.example/',incognito:false,pinned:false,groupId:-1,index:0}],writes:[]};
 const area=(data,name)=>({async get(keys){const names=typeof keys==='string'?[keys]:Array.isArray(keys)?keys:Object.keys(keys||data);return Object.fromEntries(names.map(k=>[k,clone(data[k]??keys?.[k])]));},async set(v){f.writes.push({name,values:clone(v)});Object.assign(data,clone(v));}});
 const event=()=>({listeners:[],addListener(fn){this.listeners.push(fn)},removeListener(fn){this.listeners=this.listeners.filter(x=>x!==fn)},emit(...args){for(const fn of this.listeners)fn(...clone(args))}});
 globalThis.chrome={runtime:{getURL:p=>`chrome-extension://arcify/${p}`},storage:{local:area(local,'local'),session:area(session,'session'),sync:area(sync,'sync'),onChanged:event()},windows:{get:async id=>({id,type:'normal',incognito:id===2})},tabs:{query:async q=>clone(f.tabs.filter(t=>q?.windowId===undefined||t.windowId===q.windowId)),get:async id=>{const tab=f.tabs.find(t=>t.id===id);if(!tab)throw Error('No tab');return clone(tab)},onCreated:event(),onUpdated:event(),onRemoved:event(),onReplaced:event(),onActivated:event(),onMoved:event()},tabGroups:{onRemoved:event(),onUpdated:event()},bookmarks:{search:async()=>[{id:'root'}],getChildren:async()=>[],create:async({title})=>({id:title,title})}};
 f.privateTab=(pinned=false)=>({id:2,windowId:2,url:secret,incognito:true,pinned,groupId:-1,index:0});
 f.store=()=>{const store=new SpaceStore();store.transientWindows=createTransientWindowStore();new FavoriteStore(store,{captureIcon:async()=>null,ownershipPersistence:createFavoriteContinuity({isTransientTab:t=>store.isTransientTab(t),isTransientWindow:id=>store.isTransientWindow(id)})});return store};
 f.assertPrivateAbsent=()=>{assert(!JSON.stringify(f.writes).includes(secret));assert(!JSON.stringify(local).includes(secret));assert(!JSON.stringify(session).includes(secret));assert(local.spaceTabSnapshot.some(r=>r.url==='https://normal.example/'))};
 return f;
}
for(const pinned of [false,true])test(`private ${pinned?'native pin':'ordinary tab'} never enters Space snapshots at startup`,async()=>{
 const f=fixture();f.tabs.push(f.privateTab(pinned));const store=f.store();await store.dispatch({action:'get'});
 f.assertPrivateAbsent();assert(!store.spaces.some(s=>[...s.spaceBookmarks,...s.temporaryTabs].includes(2)));assert(!store.snapshotByTab.has(2));
});
test('warm private creation and private-window close remain absent through worker and browser restart',async()=>{
 const f=fixture(),store=f.store();await store.dispatch({action:'get'});store.install();await store.run(()=>{});
 const tab=f.privateTab();f.tabs.push(tab);chrome.tabs.onCreated.emit(tab);await store.run(()=>{});f.assertPrivateAbsent();
 const worker=f.store();await worker.dispatch({action:'get'});f.assertPrivateAbsent();
 f.tabs=f.tabs.filter(t=>t.id!==2);chrome.tabs.onRemoved.emit(2,{windowId:2,isWindowClosing:true});await store.run(()=>{});
 assert(!store.restoreQueue.some(r=>r.tabId===2));f.assertPrivateAbsent();
 for(const key of Object.keys(f.session))delete f.session[key];await f.store().dispatch({action:'get'});f.assertPrivateAbsent();
});
test('private close never queues a stale in-memory snapshot and preserves unrelated normal restore data',async()=>{
 const f=fixture(),store=f.store();f.tabs.push(f.privateTab());await store.dispatch({action:'get'});store.install();await store.run(()=>{});
 store.snapshotByTab.set(2,{tabId:2,spaceId:'home',section:'temporaryTabs',url:secret,order:0});
 f.tabs=f.tabs.filter(t=>t.id!==2);chrome.tabs.onRemoved.emit(2,{windowId:2,isWindowClosing:true});await store.run(()=>{});f.assertPrivateAbsent();
 f.tabs=[];chrome.tabs.onRemoved.emit(1,{windowId:1,isWindowClosing:true});await store.run(()=>{});
 assert(store.restoreQueue.some(r=>r.url==='https://normal.example/'));
});
test('private numeric ID reuse never deletes indistinguishable historical normal restoration records',async()=>{
 const f=fixture();for(const key of Object.keys(f.session))delete f.session[key];
 const historical={tabId:2,spaceId:'home',section:'temporaryTabs',order:0,url:'https://historical.example/'};f.local.spaceTabSnapshot=[historical];f.tabs.push(f.privateTab());
 const store=f.store();await store.dispatch({action:'get'});assert(store.restoreQueue.some(r=>r.url===historical.url));assert(f.local.spaceTabSnapshot.some(r=>r.url===historical.url));
 assert(!JSON.stringify(f.local).includes(secret));
});
test('private layouts cannot be captured or supply normal restoration identity',()=>{
 const privateTab={id:2,windowId:2,index:0,url:secret,incognito:true};assert.deepEqual(captureWindowTabs([privateTab]),[]);
 const keys=new Map(),queue=[{spaceId:'home',url:secret}];assert.equal(matchRestoreRecord(privateTab,queue,[],keys,[privateTab]),-1);assert.equal(keys.size,0);
});
for(const kind of ['alias','binding'])test(`private direct ${kind} writer rejects after queue and storage waits`,async()=>{
 const f=fixture();f.tabs.push(f.privateTab());const utils={...Utils,_tabNameChain:Promise.resolve(),_pinnedStateChain:Promise.resolve()};
 const action=kind==='alias'?()=>utils.setTabNameOverride(2,secret,'Private alias'):()=>utils.setPinnedTabState(2,{pinnedUrl:secret,bookmarkId:'private'});
 await assert.rejects(action,/Private tabs/);assert.equal(f.writes.length,0);
});

test('private stale saved membership cannot hydrate bookmark metadata',async()=>{
 const f=fixture();f.tabs.push(f.privateTab());f.local.spaces[0].spaceBookmarks=[2];
 const { BookmarkUtils }=await import('../../bookmark-utils.js');const { getSpaceTabs }=await import('../../space-client.js');
 assert.deepEqual(await getSpaceTabs('home'),[]);
 const writes=[];const bound=await BookmarkUtils.matchTabsWithBookmarks({id:'home',children:[{id:'pin',url:secret,title:'Private'}]},'home',(...args)=>writes.push(args),(...args)=>writes.push(args));
 assert.deepEqual(bound,[]);assert.deepEqual(writes,[]);assert.equal(f.writes.length,0);
});
test('native metadata privacy read precedes the final caller mutation guard',async()=>{
 const f=fixture(),utils={...Utils,_pinnedStateChain:Promise.resolve()};let changed=false;
 const get=chrome.tabs.get;chrome.tabs.get=async id=>{const tab=await get(id);changed=true;return tab};
 await assert.rejects(utils.setPinnedTabState(1,{bookmarkId:'pin',pinnedUrl:'https://normal.example/'},{beforeWrite:async()=>{if(changed)throw Error('Caller identity changed')}}),/Caller identity changed/);
 assert.equal(f.writes.length,0);
});
test('private native group import cannot persist its group title',async()=>{
 const f=fixture(),store=f.store();await store.dispatch({action:'get'});f.tabs.push(f.privateTab());
 let groupReads=0;chrome.tabGroups.query=async()=>{groupReads++;return [{id:2,title:'Private group',windowId:2}]};
 await assert.rejects(store.dispatch({action:'import',windowId:2}),/Private windows/);assert.equal(groupReads,0);f.assertPrivateAbsent();
});
test('all-window legacy import skips private group titles even without an explicit window ID',async()=>{
 const f=fixture(),store=f.store();await store.dispatch({action:'get'});f.tabs.push(f.privateTab());
 let groupReads=0;chrome.tabGroups.query=async()=>{groupReads++;return [{id:2,title:'Private group',windowId:2}]};
 await store.dispatch({action:'import'});assert.equal(groupReads,1);assert(!JSON.stringify(f.local).includes('Private group'));f.assertPrivateAbsent();
});
