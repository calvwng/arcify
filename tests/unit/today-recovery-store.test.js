import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './today-recovery-fixture.js';
import { previewTodayRecovery,confirmTodayRecovery,registerTodayRecoveryMessages } from '../../today-recovery-store.js';
import { SpaceStore } from '../../space-store.js';
async function setup(){
 const f=fixture();f.tabs.forEach(t=>t.url=`https://tab-${t.id}.test/`);f.request.entries=f.request.entries.map(e=>({tabId:e.tabId,url:`https://tab-${e.tabId}.test/`}));
 f.request={...f.request,type:'previewTodayRecovery'};delete f.request.destinationSpaceId;delete f.request.destinationBookmarkFolderId;
 f.store.windowKeys=new Map([[10,'current'],[20,'other']]);f.store.restoreWindowKeys=new Map([[10,'current']]);
 f.store.recoveryCandidates.add(3);f.store.restoreQueue=[{tabId:200,spaceId:'source',section:'temporaryTabs',url:'https://tab-3.test/',windowKey:'historical',tabIndex:2,order:2},
  {tabId:201,spaceId:'target',section:'spaceBookmarks',url:'https://unrelated-saved.test/',windowKey:'other-old',order:0,pinnedState:{bookmarkId:'keep'},nameOverride:{name:'Keep'}}];
 f.store.savedWindows=[{key:'current',tabs:f.tabs.filter(t=>t.windowId===10)},{key:'historical',tabs:[]},{key:'other-old',tabs:[]}];
 await f.store.persist();f.effects.length=0;
 f.preview=()=>previewTodayRecovery(f.store,f.request);f.confirm=p=>confirmTodayRecovery(f.store,{type:'confirmTodayRecovery',token:p.token,confirmCurrentMembership:true});return f;
}
test('preview writes nothing; explicit confirmation preserves all historical records and unrelated storage',async()=>{
 const f=await setup(),queue=structuredClone(f.store.restoreQueue),local=structuredClone(f.local),session=structuredClone(f.session),tabs=structuredClone(f.tabs);
 const p=await f.preview();assert.equal(f.effects.length,0);assert.deepEqual(p.tabIds,[1,3]);
 const receipt=await f.confirm(p);assert.deepEqual(receipt.completed,[1,3]);assert.equal(receipt.stage,'confirmed');assert.equal(receipt.uncertain,false);assert.equal(receipt.queuePreserved,true);
 assert.deepEqual(f.store.restoreQueue,queue);assert.deepEqual(f.session.spaceRestoreQueue,queue);assert.deepEqual(f.local.spaceTabSnapshot.slice(-queue.length),queue);
 for(const key of ['spaces','spaceWindowSnapshot','pinnedTabStatesById','tabNameOverridesById','favoriteData'])assert.deepEqual(f.local[key],local[key]);
 for(const key of ['activeSpaces','spaceWindowKeys','spaceRestoreWindowKeys','spaceGroupProjection'])assert.deepEqual(f.session[key],session[key]);
 assert.deepEqual(f.tabs,tabs);assert(!f.store.recoveryCandidates.has(3));
 await assert.rejects(f.confirm(p),/preview changed or expired/);
});
for(const kind of ['url','pending-url','window','index','pin','split','favorite','name','binding','duplicate-live','queue','membership','active','session-candidates','folder','rank'])test(`stale preview rejects ${kind} with no confirmation writes`,async()=>{
 const f=await setup(),p=await f.preview(),tab=f.tabs.find(t=>t.id===3);
 if(kind==='url')tab.url='https://changed.test/';if(kind==='pending-url')tab.pendingUrl='https://changed.test/';
 if(kind==='window')tab.windowId=20;if(kind==='index')tab.index++;if(kind==='pin')tab.pinned=true;if(kind==='split')tab.splitViewId=2;
 if(kind==='favorite')f.globals.add(3);if(kind==='name')f.local.tabNameOverridesById[3]={name:'Named'};if(kind==='binding')f.local.pinnedTabStatesById[3]={bookmarkId:'pin'};
 if(kind==='duplicate-live')f.tabs.push({...tab,id:88});if(kind==='queue')f.store.restoreQueue[0].order++;
 if(kind==='membership')f.store.spaces[0].temporaryTabs.reverse();if(kind==='active')f.store.active[10]='target';
 if(kind==='session-candidates')f.session.spaceRecoveryCandidates.push(99);if(kind==='folder')f.nodes.find(n=>n.id==='source-root').parentId='elsewhere';if(kind==='rank')f.store.restoredRanks.set(3,99);
 const count=f.effects.length;await assert.rejects(f.confirm(p));assert.equal(f.effects.length,count);
});
for(const kind of ['queued-pin','queued-name','queued-other-space','queued-duplicate','provisional','protected-helper'])test(`preview refuses ${kind}`,async()=>{
 const f=await setup();if(kind==='queued-pin')f.store.restoreQueue[0].pinnedState={bookmarkId:'old'};
 if(kind==='queued-name')f.store.restoreQueue[0].nameOverride={name:'Old'};if(kind==='queued-other-space')f.store.restoreQueue[0].spaceId='target';
 if(kind==='queued-duplicate')f.store.restoreQueue.push({...f.store.restoreQueue[0],tabId:299});
 if(kind==='provisional')f.store.provisional.add(3);if(kind==='protected-helper')f.tabs.find(t=>t.id===3).url='chrome-extension://test/startup-launcher.html';
 f.session.spaceRestoreQueue=structuredClone(f.store.restoreQueue);f.local.spaceTabSnapshot=f.local.spaceTabSnapshot.filter(r=>r.tabId!==200&&r.tabId!==299).concat(f.store.restoreQueue);
 await assert.rejects(f.preview());
});
test('expired preview never writes',async()=>{const f=await setup(),p=await f.preview(),now=Date.now;Date.now=()=>now()+120001;try{await assert.rejects(f.confirm(p));}finally{Date.now=now;}assert.equal(f.effects.length,0);});
test('cancelled/malformed or absent acknowledgement never confirms',async()=>{const f=await setup(),p=await f.preview();await assert.rejects(confirmTodayRecovery(f.store,{type:'confirmTodayRecovery',token:p.token}));assert.equal(f.effects.length,0);});
test('failed local write is read back as confirmed unchanged, without retry',async()=>{
 const f=await setup(),p=await f.preview();let attempts=0;f.hooks.beforeSet=(area,values)=>{if(area==='local'&&values.spaceTabSnapshot){attempts++;throw Error('write rejected');}};
 await assert.rejects(f.confirm(p),e=>e.receipt.writeAttempted&&e.receipt.confirmedUnchanged&&!e.receipt.uncertain&&e.receipt.completed.length===0);assert.equal(attempts,1);
});
test('write completed then rejected before session is partial/uncertain with durable evidence only',async()=>{
 const f=await setup(),p=await f.preview();f.hooks.afterSet=(area,values)=>{if(area==='local'&&values.spaceTabSnapshot)throw Error('lost acknowledgement');};
 await assert.rejects(f.confirm(p),e=>e.receipt.uncertain&&e.receipt.durableConfirmed.length===2&&e.receipt.completed.length===0);assert(f.session.spaceRecoveryCandidates.includes(3));
});
test('session write completed then rejected is classified by exact readback',async()=>{
 const f=await setup(),p=await f.preview();f.hooks.afterSet=(area,values)=>{if(area==='session'&&values.spaceRecoveryCandidates)throw Error('lost acknowledgement');};
 await assert.rejects(f.confirm(p),e=>!e.receipt.uncertain&&e.receipt.completed.length===2&&e.receipt.queuePreserved);assert.equal(f.store.initialized,false);
});
test('unreadable post-write state remains uncertain and is never rolled back or retried',async()=>{
 const f=await setup(),p=await f.preview();let written=false,attempts=0;f.hooks.afterSet=(area,values)=>{if(area==='local'&&values.spaceTabSnapshot){written=true;attempts++;throw Error('lost acknowledgement');}};
 f.hooks.get=()=>{if(written)throw Error('unavailable');};await assert.rejects(f.confirm(p),e=>e.receipt.uncertain&&e.receipt.completed.length===0);assert.equal(attempts,1);
});
test('late native protection change after local write prevents a verified completion',async()=>{
 const f=await setup(),p=await f.preview();f.hooks.afterSet=(area,values)=>{if(area==='local'&&values.spaceTabSnapshot)f.globals.add(3);};
 await assert.rejects(f.confirm(p),e=>e.receipt.uncertain&&!e.receipt.completed.includes(3));
});
test('endpoint accepts only own sidebar and requires an opaque preview, not raw IDs',async()=>{
 const f=await setup();registerTodayRecoveryMessages(f.store);const listener=f.listeners.at(-1);
 const response=await new Promise(resolve=>listener(f.request,{id:'test',url:'chrome-extension://test/options.html'},resolve));assert.equal(response.success,false);assert.match(response.error,/sender/);assert.equal(f.effects.length,0);
});
test('preview token cannot be confirmed from a different sidebar document',async()=>{
 const f=await setup();registerTodayRecoveryMessages(f.store);const listener=f.listeners.at(-1);
 const send=(message,documentId)=>new Promise(resolve=>listener(message,{id:'test',url:'chrome-extension://test/sidebar.html',origin:'chrome-extension://test',documentId},resolve));
 const p=await send(f.request,'document-a');assert(p.success);
 const result=await send({type:'confirmTodayRecovery',token:p.preview.token,confirmCurrentMembership:true},'document-b');
 assert.equal(result.success,false);assert.equal(f.effects.length,0);
});
for(const attrs of [{pinnedState:{bookmarkId:'keep'}},{nameOverride:{name:'Keep'}},{section:'spaceBookmarks'},{spaceId:'target'},{url:'https://wrong.test/'}])test(`protected selected prefix is preserved: ${JSON.stringify(attrs)}`,async()=>{
 const f=await setup();Object.assign(f.local.spaceTabSnapshot.find(r=>r.tabId===1),attrs);const before=structuredClone(f.local);
 await assert.rejects(f.preview());assert.deepEqual(f.local,before);assert.equal(f.effects.length,0);
});
test('session delta after local checkpoint is not overwritten and yields uncertainty',async()=>{
 const f=await setup(),p=await f.preview();f.hooks.afterSet=(area,values)=>{if(area==='local'&&values.spaceTabSnapshot)f.session.activeSpaces[10]='target';};
 await assert.rejects(f.confirm(p),e=>e.receipt.uncertain&&e.receipt.completed.length===0);assert.equal(f.session.activeSpaces[10],'target');assert(f.session.spaceRecoveryCandidates.includes(3));
});
test('checked writer survives worker restart and unchanged-layout browser restart with new IDs, retaining old metadata',async()=>{
 const f=await setup(),historical=structuredClone(f.store.restoreQueue),p=await f.preview();await f.confirm(p);
 chrome.bookmarks.getChildren=async()=>[];
 const warm=new SpaceStore();await warm.initialize();assert(!warm.recoveryCandidates.has(3));assert.deepEqual(warm.restoreQueue,historical);
 for(const tab of f.tabs)tab.id+=1000;
 for(const key of Object.keys(f.session))delete f.session[key];
 const cold=new SpaceStore();await cold.initialize();assert(!cold.recoveryCandidates.has(1003));assert.deepEqual(cold.restoreQueue,historical);
 assert(cold.spaces.find(s=>s.id==='source').temporaryTabs.includes(1003));assert(!f.local.pinnedTabStatesById[1003]);
});
test('changed native layout on browser restart preserves unresolved historical identities',async()=>{
 const f=await setup(),historical=structuredClone(f.store.restoreQueue),p=await f.preview();await f.confirm(p);chrome.bookmarks.getChildren=async()=>[];
 for(const tab of f.tabs){tab.id+=1000;tab.index+=2;}
 for(const key of Object.keys(f.session))delete f.session[key];
 const cold=new SpaceStore();await cold.initialize();assert.deepEqual(cold.restoreQueue.filter(r=>historical.some(old=>JSON.stringify(old)===JSON.stringify(r))),historical);
 assert(!f.local.pinnedTabStatesById[1003]);
});
test('only selected session rank tuples change; warm restart still trusts the local checkpoint',async()=>{
 const f=await setup();f.session.restoredTabRanks=[[999,20],[2,700],[2,701],[1,8],[4,123]];
 const before=structuredClone(f.session.restoredTabRanks),p=await f.preview();await f.confirm(p);
 assert.deepEqual(f.session.restoredTabRanks.filter(pair=>![1,3].includes(pair[0])),before.filter(pair=>![1,3].includes(pair[0])));
 chrome.bookmarks.getChildren=async()=>[];const warm=new SpaceStore();await warm.initialize();
 assert.equal(warm.restoredRanks.get(2),f.store.restoredRanks.get(2));
});
test('ambiguous selected session rank tuples refuse preview instead of normalizing data',async()=>{
 const f=await setup();f.session.restoredTabRanks.push([1,99]);const before=structuredClone(f.session);
 await assert.rejects(f.preview());assert.deepEqual(f.session,before);assert.equal(f.effects.length,0);
});
for(const rank of [-1,0.5,Number.MAX_SAFE_INTEGER+1])test(`invalid selected session rank ${rank} refuses preview`,async()=>{
 const f=await setup();f.session.restoredTabRanks=f.session.restoredTabRanks.filter(pair=>pair[0]!==1);f.session.restoredTabRanks.push([1,rank]);
 await assert.rejects(f.preview());assert.equal(f.effects.length,0);
});
test('browser restart with indistinguishable historical layouts stays conservative after explicit confirmation',async()=>{
 const f=await setup(),historical=structuredClone(f.store.restoreQueue);
 f.local.spaceWindowSnapshot.find(w=>w.key==='historical').tabs=structuredClone(f.local.spaceWindowSnapshot.find(w=>w.key==='current').tabs);
 f.store.savedWindows=structuredClone(f.local.spaceWindowSnapshot);
 const p=await f.preview();await f.confirm(p);chrome.bookmarks.getChildren=async()=>[];
 for(const tab of f.tabs)tab.id+=1000;for(const key of Object.keys(f.session))delete f.session[key];
 const cold=new SpaceStore();await cold.initialize();assert(cold.recoveryCandidates.has(1003));
 assert(historical.every(record=>cold.restoreQueue.some(r=>JSON.stringify(record)===JSON.stringify(r))));assert(!f.local.pinnedTabStatesById[1003]);
});
