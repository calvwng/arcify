import test from 'node:test';
import assert from 'node:assert/strict';
import { closeSelectedTabs, registerSelectedTabClose } from '../../selected-tab-close.js';
import { createSelectedTabClose, installSelectionCloseKeys } from '../../selected-tab-close-ui.js';
import { Utils } from '../../utils.js';
import { parseHTML } from 'linkedom';
function fixture() {
 const removed=[], hooks={}, bindings={2:{bookmarkId:'pin'}};
 const tabs=new Map([1,2,3].map(id=>[id,{id,windowId:10,url:`https://a.test/${id}`} ]));
 const store={spaces:[{id:'s',bookmarkFolderId:'root',temporaryTabs:[1,3],spaceBookmarks:[2]}],active:{10:'s'},run:fn=>fn(),isGlobalTab:id=>hooks.global===id,isTransientTab:id=>hooks.transient !== undefined && hooks.transient===(id?.id||id)};
 const nodes=[{id:'root',parentId:'arc'},{id:'pin',parentId:'root',url:'https://pin.test/'}];
 globalThis.chrome={windows:{get:async id=>({id,type:'normal'})},bookmarks:{get:async id=>nodes.filter(n=>n.id===id),search:async()=>[{id:'arc'}],getChildren:async id=>nodes.filter(n=>n.parentId===id)},tabs:{get:async id=>{await hooks.get?.(id);if(!tabs.has(id))throw Error('Missing');return {...tabs.get(id)};},remove:async id=>{removed.push(id);await hooks.remove?.(id);tabs.delete(id);}}};
 Utils.getPinnedTabState=async id=>{await hooks.binding?.(id);return bindings[id]};
 const request={windowId:10,spaceId:'s',bookmarkFolderId:'root',entries:[{tabId:1,url:tabs.get(1).url},{tabId:2,url:tabs.get(2).url,bookmarkId:'pin',parentId:'root'}]};
 return {removed,hooks,bindings,tabs,store,nodes,request,run:()=>closeSelectedTabs(store,request)};
}
test('closes exact Today and pin live IDs, leaves saved records and unrelated tab',async()=>{const f=fixture();const r=await f.run();assert.equal(r.success,true);assert.deepEqual(f.removed,[1,2]);assert(f.tabs.has(3));assert.equal(f.nodes.length,2);assert.equal(f.bindings[2].bookmarkId,'pin')});
for(const reason of ['removed','replaced','moved','url','owner','duplicate','global','transient','binding','pin-parent','active','split','native-pin'])test(`rejects whole batch before remove: ${reason}`,async()=>{
 const f=fixture();if(reason==='removed'||reason==='replaced')f.tabs.delete(2);
 if(reason==='replaced')f.tabs.set(20,{id:20,windowId:10,url:f.request.entries[1].url});
 if(reason==='moved')f.tabs.get(2).windowId=11;
 if(reason==='url')f.tabs.get(2).url='https://different.test/';
 if(reason==='owner')f.store.spaces[0].spaceBookmarks=[];
 if(reason==='duplicate')f.store.spaces[0].temporaryTabs.push(2);
 if(reason==='global')f.hooks.global=2;
 if(reason==='transient')f.hooks.transient=2;
 if(reason==='binding')f.bindings[2].bookmarkId='other';
 if(reason==='pin-parent')f.nodes[1].parentId='elsewhere';
 if(reason==='active')f.store.active[10]='other';
 if(reason==='split')f.tabs.get(2).splitViewId=4;
 if(reason==='native-pin')f.tabs.get(2).pinned=true;
 assert.equal((await f.run()).success,false);assert.deepEqual(f.removed,[]);
});
test('fresh ownership and window reads stop after first removal',async()=>{const f=fixture();f.hooks.remove=id=>{if(id===1)f.tabs.get(2).windowId=11};const r=await f.run();assert.deepEqual(r.completed,[1]);assert.equal(r.uncertain,false);assert.deepEqual(f.removed,[1])});
test('remove rejection is uncertain and never retried',async()=>{const f=fixture();f.hooks.remove=id=>{if(id===2)throw Error('API failure')};const r=await f.run();assert.deepEqual(r.completed,[1]);assert.equal(r.uncertain,true);assert.deepEqual(f.removed,[1,2])});
test('ownership change during last tab read aborts',async()=>{const f=fixture();f.hooks.get=id=>{if(id===1)f.store.active[10]='other'};assert.equal((await f.run()).success,false);assert.deepEqual(f.removed,[])});
test('duplicate IDs are rejected',async()=>{const f=fixture();f.request.entries.push(f.request.entries[0]);assert.equal((await f.run()).success,false);assert.deepEqual(f.removed,[])});
test('sender must be exact sidebar',()=>{let handler;globalThis.chrome={runtime:{id:'x',getURL:p=>`chrome-extension://x/${p}`,onMessage:{addListener:fn=>handler=fn}}};registerSelectedTabClose({});let result;handler({type:'closeSelectedTabs'},{id:'x',url:'https://untrusted.test/'},r=>result=r);assert.equal(result.success,false)});
test('mixed closed/live pin selection sends only frozen live IDs; clears selection',async()=>{let sent,cleared=0;const statuses=[];const selection={validate:()=>true,clear:()=>cleared++};const close=createSelectedTabClose({sendRequest:async r=>(sent=r,{success:true,completed:[2],uncertain:false}),showStatus:s=>statuses.push(s)});const action=close({windowId:10,spaceId:'s',bookmarkFolderId:'root',entries:[{tabId:null,bookmarkId:'closed'},{tabId:2,url:'https://a.test/2',bookmarkId:'pin',parentId:'root'}]},selection);assert.equal(action.count,1);await action.close();assert.equal(sent.entries.length,1);assert.equal(cleared,1);assert.match(statuses[0],/Saved pins and Favorites are kept/)});
test('stale UI snapshots do not send',async()=>{let sent=false;const action=createSelectedTabClose({sendRequest:()=>sent=true,showStatus:()=>{}})({entries:[{tabId:1,url:''}]},{validate:()=>false});await action.close();assert.equal(sent,false)});
test('shortcut handles exact rows, ignores editors/repeats/modifiers',()=>{const {document,window}=parseHTML('<html><body><div id="spacesList"><div class="tab"><input></div></div></body></html>');let closed=0;installSelectionCloseKeys(document,()=>({close:()=>closed++}));const fire=(target,props)=>{const e=new window.Event('keydown',{bubbles:true,cancelable:true});Object.assign(e,{key:'Delete',...props});target.dispatchEvent(e);return e};const row=document.querySelector('.tab');assert.equal(fire(row).defaultPrevented,true);fire(row,{key:'w',ctrlKey:true});fire(row.querySelector('input'));fire(row,{repeat:true});fire(row,{shiftKey:true});fire(row,{isComposing:true});assert.equal(closed,1)});

test('store finalizer failure retains committed progress',async()=>{const f=fixture();f.store.run=async fn=>{await fn();throw Error('flush failed')};const r=await f.run();assert.equal(r.success,false);assert.deepEqual(r.completed,[1,2]);assert.equal(r.uncertain,false)});


test('Ctrl+W and Cmd+W remain untouched by the selection close listener',()=>{
 const {document,window}=parseHTML('<html><body><div id="spacesList"><div class="tab"></div></div></body></html>');
 let captures=0;installSelectionCloseKeys(document,()=>{captures++;return {close(){throw Error('must not close')}}});
 for(const modifiers of [{ctrlKey:true},{metaKey:true}]){const e=new window.Event('keydown',{bubbles:true,cancelable:true});Object.assign(e,{key:'w',...modifiers});document.querySelector('.tab').dispatchEvent(e);assert.equal(e.defaultPrevented,false)}
 assert.equal(captures,0);
});
