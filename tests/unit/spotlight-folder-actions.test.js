import test from 'node:test';
import assert from 'node:assert/strict';
import { readFolderActionContext, runFolderAction, prepareFolderMove } from '../../spotlight-folder-actions.js';
function event() { const listeners = new Set(); return { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn), emit: (...args) => [...listeners].forEach(fn => fn(...args)), get size() { return listeners.size; } }; }
function fixture() {
 const nodes = [{id:'arc', parentId:'bar', title:'Arcify'}, {id:'root',parentId:'arc',title:'Work'}, {id:'folder',parentId:'root',title:'Areas'}, {id:'sub',parentId:'folder',title:'Child'}, {id:'dest',parentId:'arc',title:'Personal'}];
 const store = {spaces:[{id:'work',bookmarkFolderId:'root'},{id:'personal',bookmarkFolderId:'dest'}],active:{7:'work'}};
 const writes=[]; const sync={};
 const tree = id => ({...nodes.find(n => n.id===id), children:nodes.filter(n => n.parentId===id).map(n => tree(n.id))});
 globalThis.chrome = { windows:{get:async id=>({id,type:'normal'})}, tabs:{query:async()=>[{id:1,windowId:7,active:true}]}, storage:{sync:{get:async()=>({...sync})},onChanged:event()}, bookmarks:{
  get:async id=>structuredClone(nodes.filter(n=>n.id===id)), getSubTree:async id=> nodes.some(n=>n.id===id)?[tree(id)]:[], search:async ({title})=>nodes.filter(n=>n.title===title),
  create:async value=>{ const node={id:'new',...value}; nodes.push(node);writes.push(['create',value]);return node; },
  update:async (id,value)=>{ Object.assign(nodes.find(n=>n.id===id),value);writes.push(['update',id,value]); },
  remove:async id=>{ if(nodes.some(n=>n.parentId===id)) throw new Error('not empty');nodes.splice(nodes.findIndex(n=>n.id===id),1);writes.push(['remove',id]); },
  onCreated:event(),onChanged:event(),onMoved:event(),onRemoved:event()
 }};
 const read = (folderId='folder',options={})=>readFolderActionContext(store,{windowId:7,tabId:1,folderId},options);
 const run = (command,context,fields={},options={})=>runFolderAction(store,{command,windowId:7,context,...fields},options);
 return {nodes,store,writes,sync,read,run};
}
test('captures exact nested subtree and ancestors',async()=>{const f=fixture(); const c=await f.read(); assert.equal(c.folder.children[0].id,'sub');assert.deepEqual(c.ancestors.map(x=>x.id),['root']);});
test('rejects a folder outside selected Space',async()=>{const f=fixture();await assert.rejects(f.read('dest'));});
test('never renames or deletes Space roots',async()=>{const f=fixture();const c=await f.read('root');await assert.rejects(f.run('renameSavedFolder',c,{title:'Oops'}),/Space roots/);await assert.rejects(f.run('deleteEmptyFolder',c,{confirmed:true}),/Space roots/);assert.equal(f.writes.length,0);});
test('renames exact folder; creates under root or first level only',async()=>{const f=fixture();await f.run('renameSavedFolder',await f.read(),{title:'Projects'});assert.equal(f.nodes.find(x=>x.id==='folder').title,'Projects');await f.run('createChildFolder',await f.read(),{title:'Extra'});await assert.rejects(f.run('createChildFolder',await f.read('sub'),{title:'Too deep'}),/two folder levels/);});
test('group sync prevents nested creation',async()=>{const f=fixture();f.sync.syncTabGroups=true;await assert.rejects(f.run('createChildFolder',await f.read(),{title:'Extra'}),/tab group sync/);assert.equal(f.writes.length,0);});
test('requires confirmation and emptiness; uses nonrecursive remove',async()=>{const f=fixture();await assert.rejects(f.run('deleteEmptyFolder',await f.read('sub')),/Confirm/);await assert.rejects(f.run('deleteEmptyFolder',await f.read(),{confirmed:true}),/empty folders/);await f.run('deleteEmptyFolder',await f.read('sub'),{confirmed:true});assert.deepEqual(f.writes,[['remove','sub']]);});
test('stale name, subtree, Space and policy changes are zero-write failures',async()=>{for(const mutate of [f=>f.nodes.find(x=>x.id==='folder').title='Other',f=>f.nodes.push({id:'new',parentId:'folder',title:'new'}),f=>f.store.active[7]='personal',f=>f.sync.syncTabGroups=true]){const f=fixture();const c=await f.read();mutate(f);await assert.rejects(f.run('renameSavedFolder',c,{title:'Rename'}));assert.equal(f.writes.length,0);}});
test('policy changes during authority check invalidate and clean listeners',async()=>{const f=fixture();await assert.rejects(f.read('folder',{beforeReturn:async()=>chrome.storage.onChanged.emit({syncTabGroups:{}},'sync')}),/policy changed/);assert.equal(chrome.storage.onChanged.size,0);});
test('rejects invalid titles without write',async()=>{const f=fixture();const c=await f.read();for(const title of ['', '  ', 'x\ny','x'.repeat(257)])await assert.rejects(f.run('renameSavedFolder',c,{title}));assert.equal(f.writes.length,0);});
test('move preparation retains exact tree and uses existing transaction request',async()=>{const f=fixture(); const c=await f.read(); const r=await prepareFolderMove(f.store,c,'personal');assert.equal(r.type,'moveSavedItemsToSpace');assert.deepEqual(r.entries[0].tree,c.folder);assert.equal(r.destinationBookmarkFolderId,'dest');assert.equal(f.writes.length,0);});
