import test from 'node:test';
import assert from 'node:assert/strict';
import { moveTabToNewWindow, registerMoveTabWindowMessages } from '../../move-tab-new-window.js';
import { FavoriteStore } from '../../favorite-store.js';

function fixture({saved=false, favorite=false, pinned=false}={}) {
 const calls=[], tab={id:7,windowId:10,pinned,groupId:4,url:'https://same.test',incognito:false};
 const binding=saved?{bookmarkId:'pin',pinnedUrl:tab.url}:null;
 const store={spaces:[{id:'space',bookmarkFolderId:'folder',spaceBookmarks:saved?[7]:[],temporaryTabs:!saved&&!favorite&&!pinned?[7]:[]}],active:{10:'space'},run:fn=>fn(),isGlobalTab:t=>favorite&&t.id===7,track:t=>calls.push(['track',t.id]),persist:async()=>calls.push(['persist'])};
 const favorites={items:favorite?[{id:'fav',title:'Saved identity'}]:[],state:{bindings:favorite?[{favoriteId:'fav',tabId:7,windowId:10,...(!pinned?{mode:'ordinary'}:{})}]:[],attempts:[]},spaceExclusions:new Set(),exactId:x=>x,saveSession:async()=>calls.push(['session']),spaceStore:store};
 favorites.reconcile=FavoriteStore.prototype.reconcile.bind(favorites);
 let listener;
 globalThis.chrome={runtime:{id:'own',getURL:p=>'chrome-extension://own/'+p,onMessage:{addListener:l=>listener=l}},
 tabs:{get:async()=>({...tab}),query:async()=>[{...tab}],update:async(id,patch)=>{calls.push(['update',id,patch]);Object.assign(tab,patch);return {...tab};}},
 windows:{get:async id=>({id,type:'normal',incognito:false}),create:async options=>{calls.push(['create',options]);tab.windowId=20;tab.groupId=-1;tab.pinned=false;return{id:20,type:'normal'};}},
 storage:{local:{get:async()=>({pinnedTabStatesById:binding?{7:binding}:{}})}},
 bookmarks:{get:async()=>[{id:'folder',parentId:'root'}],search:async()=>[{id:'root',title:'Arcify'}],getChildren:async()=>[{id:'pin',parentId:'folder',url:tab.url}]}};
 const request={type:'moveTabToNewWindow',tabId:7,windowId:10,...(favorite?{favoriteId:'fav'}:pinned?{}:{spaceId:'space',bookmarkFolderId:'folder',...(saved?{bookmarkId:'pin',parentId:'folder'}:{})})};
 return{tab,binding,store,favorites,request,calls,listen:()=>{registerMoveTabWindowMessages(store,favorites);return listener;}};
}
for(const kind of ['today','saved','ordinaryFavorite','nativeFavorite','native']) test(`moves exact ${kind} tab without recreation and retains saved identity`,async()=>{
 const f=fixture({saved:kind==='saved',favorite:kind.includes('Favorite'),pinned:kind==='nativeFavorite'||kind==='native'});
 const before=JSON.stringify(f.favorites.items); const result=await moveTabToNewWindow(f.store,f.favorites,f.request);
 assert.deepEqual(result,{tabId:7,windowId:20});
 assert.deepEqual(f.calls.filter(c=>c[0]==='create'),[['create',{tabId:7,type:'normal',focused:true}]]);
 assert.equal(f.tab.url,'https://same.test');assert.equal(f.tab.groupId,-1);
 assert.equal(JSON.stringify(f.favorites.items),before);
 if(kind.includes('Favorite')){assert.equal(f.favorites.state.bindings[0].favoriteId,'fav');assert.equal(f.favorites.state.bindings[0].windowId,20);assert.equal(f.favorites.state.bindings[0].tabId,7);}
 if(kind==='saved'){assert.equal(f.binding.bookmarkId,'pin');assert.deepEqual(f.store.spaces[0].spaceBookmarks,[7]);}
 if(f.request.spaceId){assert.equal(f.store.active[10],'space');assert.equal(f.store.active[20],'space');}
 assert.equal(f.tab.pinned,kind==='nativeFavorite'||kind==='native');
});
for(const mutate of [f=>f.tab.windowId=11,f=>f.tab.splitViewId=0,f=>f.store.active[10]='other',f=>f.store.spaces[0].temporaryTabs=[],f=>f.request.tabIds=[7,8],f=>f.tab.incognito=true]) test('stale, Split, ambiguous and multi-tab requests perform no native move',async()=>{
 const f=fixture();mutate(f);await assert.rejects(moveTabToNewWindow(f.store,f.favorites,f.request));assert.deepEqual(f.calls,[]);
});
test('Split appearing during an awaited validation is rejected before dispatch',async()=>{
 const f=fixture();let reads=0;chrome.tabs.get=async()=>({...f.tab,...(++reads===3?{splitViewId:0}:{})});
 await assert.rejects(moveTabToNewWindow(f.store,f.favorites,f.request),/End Split/);assert.deepEqual(f.calls,[]);
});
test('deleted bookmark or rebound pin cannot move an unrelated saved tab',async()=>{
 const f=fixture({saved:true});f.binding.bookmarkId='replacement';await assert.rejects(moveTabToNewWindow(f.store,f.favorites,f.request));assert.deepEqual(f.calls,[]);
});
test('uncertain native failure is never retried or replaced with a URL tab',async()=>{
 const f=fixture();chrome.windows.create=async()=>{f.calls.push(['create']);throw Error('timeout');};
 await assert.rejects(moveTabToNewWindow(f.store,f.favorites,f.request),/Check your windows before retrying/);assert.deepEqual(f.calls,[['create']]);
});
test('post-move persistence failure reports moved state without rollback or retry',async()=>{
 const f=fixture();f.store.persist=async()=>{throw Error('storage unavailable');};
 await assert.rejects(moveTabToNewWindow(f.store,f.favorites,f.request),/tab was moved/);assert.equal(f.tab.windowId,20);assert.equal(f.calls.filter(c=>c[0]==='create').length,1);
});
test('last tab move needs no source window after native dispatch or extra blank page',async()=>{
 const f=fixture();const get=chrome.windows.get;chrome.windows.get=async id=>{if(id===10&&f.tab.windowId===20)throw Error('source closed');return get(id);};
 await moveTabToNewWindow(f.store,f.favorites,f.request);assert.equal(f.tab.windowId,20);
});
test('message route rejects external and stale-window senders',()=>{
 const f=fixture(),listener=f.listen();for(const sender of [{id:'other',url:'chrome-extension://own/sidebar.html'},{id:'own',url:'chrome-extension://own/options.html'},{id:'own',url:'chrome-extension://own/sidebar.html',tab:{windowId:11}}]){let response;listener(f.request,sender,r=>response=r);assert.equal(response.success,false);}assert.deepEqual(f.calls,[]);
});

for (const phase of ['reconcile', 'beforeWrite', 'afterPersist']) test(`native reattachment during ${phase} is reported as partial failure without replay`, async () => {
 const f=fixture({favorite:true});
 if(phase==='reconcile'){const reconcile=f.favorites.reconcile;f.favorites.reconcile=async options=>{await reconcile(options);f.tab.windowId=30;};}
 else f.store.persist=async({beforeWrite})=>{if(phase==='beforeWrite')f.tab.windowId=30;await beforeWrite();if(phase==='afterPersist')f.tab.windowId=30;};
 await assert.rejects(moveTabToNewWindow(f.store,f.favorites,f.request),/tab was moved/);
 assert.equal(f.calls.filter(c=>c[0]==='create').length,1);
});
test('tab moved or Split before pin restoration cannot receive a pin write',async()=>{
 for(const change of [{windowId:30},{splitViewId:0}]){
  const f=fixture({favorite:true,pinned:true});let reads=0;
  chrome.tabs.get=async()=>{if(++reads===5)Object.assign(f.tab,change);return {...f.tab};};
  await assert.rejects(moveTabToNewWindow(f.store,f.favorites,f.request),/tab was moved/);
  assert.equal(f.calls.filter(c=>c[0]==='update').length,0);
 }
});
test('binding changed while reading bookmark tree is rejected before native move',async()=>{
 const f=fixture({saved:true});let reads=0;chrome.bookmarks.getChildren=async()=>{if(++reads===2)f.binding.bookmarkId='replacement';return [{id:'pin',parentId:'folder',url:f.tab.url}];};
 await assert.rejects(moveTabToNewWindow(f.store,f.favorites,f.request));assert.deepEqual(f.calls,[]);
});
test('duplicate requests serialize and stale source window prevents a second native move',async()=>{
 const f=fixture();let chain=Promise.resolve();f.store.run=fn=>{const pending=chain.then(fn);chain=pending.catch(()=>{});return pending;};
 const results=await Promise.allSettled([moveTabToNewWindow(f.store,f.favorites,f.request),moveTabToNewWindow(f.store,f.favorites,f.request)]);
 assert.equal(results[0].status,'fulfilled');assert.equal(results[1].status,'rejected');assert.equal(f.calls.filter(c=>c[0]==='create').length,1);
});

test('exact tab closure during Favorite reconciliation reports partial failure',async()=>{
 const f=fixture({favorite:true});const reconcile=f.favorites.reconcile;
 f.favorites.reconcile=async options=>{await reconcile(options);chrome.tabs.get=async()=>{throw Error('No tab with id');};};
 await assert.rejects(moveTabToNewWindow(f.store,f.favorites,f.request),/tab was moved/);assert.equal(f.calls.filter(c=>c[0]==='create').length,1);
});
test('lost Favorite binding after reconciliation cannot report success',async()=>{
 const f=fixture({favorite:true});f.favorites.reconcile=async()=>{f.favorites.state.bindings=[];};
 await assert.rejects(moveTabToNewWindow(f.store,f.favorites,f.request),/tab was moved/);
});
test('saved ownership changed before persistence is fenced without replay',async()=>{
 const f=fixture({saved:true});f.store.persist=async({beforeWrite})=>{f.store.spaces[0].spaceBookmarks=[];await beforeWrite();};
 await assert.rejects(moveTabToNewWindow(f.store,f.favorites,f.request),/tab was moved/);
});
