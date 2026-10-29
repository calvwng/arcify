import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './today-recovery-menu-fixture.js';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const wait=async predicate=>{for(let i=0;i<100&&!predicate();i++)await tick();assert(predicate(),'Expected asynchronous recovery stage');};
async function open(f){f.select([1,3]);const opening=f.open();f.release();await opening;return f.document.querySelector('[data-action="reviewTodayRecovery"]');}
function activate(f,item,mode='pointer'){
 if(mode==='keyboard'){item.focus();f.event(item,'keydown',{key:'Enter'});return;}
 for(const type of ['pointerdown','mousedown'])f.event(item,type);item.focus();
 for(const type of ['pointerup','mouseup','click'])f.event(item,type);
}
const dialog=f=>f.document.getElementById('todayRecoveryDialog');
const cancel=f=>f.event([...dialog(f).querySelectorAll('button')].find(x=>x.textContent==='Cancel'),'click');
const completed=f=>f.pendingMutations()===0;

for(const mode of ['pointer','keyboard'])for(const inverted of [false,true])test(`production ${mode} capture/selection/menu/backend opens dialog (inverted=${inverted}); only explicit trusted submit writes`,async()=>{
 const f=await fixture({inverted});try{
  const item=await open(f),before=structuredClone(f.backend.tabs),queue=structuredClone(f.backend.store.restoreQueue);
  activate(f,item,mode);assert.match(f.notice(),/Reviewing selected Today tabs/);assert.equal(f.document.getElementById('tab-context-menu'),null);
  assert.equal(f.document.getElementById('favoritesDropDismiss').hidden,true);
  // Menu close releases its editor session, while recovery retains the mutation hold.
  f.coordinator.invalidateSpaces();await f.coordinator.drain();assert.equal(f.paints(),0);
  await wait(()=>dialog(f));assert.equal(f.pendingMutations(),1);assert.equal(f.backend.effects.length,0);
  const confirm=f.document.getElementById('todayRecoveryConfirm');f.event(confirm,'click');
  f.submits.at(-1)({preventDefault(){},isTrusted:false});assert(dialog(f));assert.equal(f.calls.length,1);
  f.submits.at(-1)({preventDefault(){},isTrusted:true});await wait(()=>completed(f));
  assert.deepEqual(f.calls.map(c=>c.type),['previewTodayRecovery','confirmTodayRecovery']);
  assert.deepEqual(f.calls[0].entries.map(e=>e.tabId),inverted?[3,1]:[1,3]);
  assert.match(f.notice(),/membership confirmed/);assert.deepEqual(f.backend.store.restoreQueue,queue);assert.deepEqual(f.backend.tabs,before);
  assert(!f.backend.store.recoveryCandidates.has(3));assert(!f.calls.some(c=>c.type.includes('move')));
 }finally{await f.cleanup();}
});

for(const exit of ['Cancel','Escape','blur','pagehide'])test(`production dialog ${exit} never confirms`,async()=>{
 const f=await fixture();try{activate(f,await open(f));await wait(()=>dialog(f));
  if(exit==='Cancel')cancel(f);if(exit==='Escape')f.event(dialog(f),'keydown',{key:'Escape'});if(exit==='blur')f.event(f.window,'blur');if(exit==='pagehide')f.event(f.window,'pagehide');
  await wait(()=>completed(f));assert(!dialog(f));assert.match(f.notice(),/cancelled/);assert.deepEqual(f.calls.map(c=>c.type),['previewTodayRecovery']);assert.equal(f.backend.effects.length,0);
 }finally{await f.cleanup();}
});

test('stale selection before trusted menu click reports instead of silently exiting',async()=>{
 const f=await fixture();try{const item=await open(f);f.selection.clear();activate(f,item);await tick();assert.match(f.notice(),/selection changed/);assert.deepEqual(f.calls,[]);assert.equal(f.pendingMutations(),0);}finally{await f.cleanup();}
});

test('ordinary pointer ordering and menu close do not invalidate selection while a preview waits',async()=>{
 const f=await fixture({previewMode:'held'});try{activate(f,await open(f));await wait(()=>f.releasePreview());
  f.coordinator.invalidateSpaces();await f.coordinator.drain();assert.equal(f.paints(),0);assert.equal(f.pendingMutations(),1);
  await f.releasePreview().reply();await wait(()=>dialog(f));assert.equal(f.backend.effects.length,0);cancel(f);await wait(()=>completed(f));
 }finally{await f.cleanup();}
});

test('selection changed while preview waits reports stale and never opens a dialog',async()=>{
 const f=await fixture({previewMode:'held'});try{activate(f,await open(f));await wait(()=>f.releasePreview());f.select([2]);await f.releasePreview().reply();await wait(()=>completed(f));
  assert.match(f.notice(),/selection changed/);assert(!dialog(f));assert.equal(f.calls.length,1);assert.equal(f.backend.effects.length,0);
 }finally{await f.cleanup();}
});

for(const mode of ['wrong-sidebar-path','stale-backend','old-backend'])test(`production preview ${mode} surfaces an error without confirming`,async()=>{
 const f=await fixture({senderMode:mode==='wrong-sidebar-path'?'missing-document':mode,previewMode:mode==='old-backend'?mode:'normal'});try{const item=await open(f);if(mode==='stale-backend')f.backend.session.activeSpaces[10]='target';activate(f,item);await wait(()=>completed(f));
  assert.match(f.notice(),mode==='wrong-sidebar-path'?/preview unavailable/:mode==='old-backend'?/incompatible.*Reload Arcify/:/preview changed or expired/);
  assert(!dialog(f));assert.equal(f.calls.length,mode==='wrong-sidebar-path'?0:1);assert.equal(f.backend.effects.length,0);
 }finally{await f.cleanup();}
});

for(const late of ['reply','reject'])test(`bounded preview timeout ignores late ${late}, releases hold, allows fresh explicit review`,async t=>{
 const f=await fixture({previewMode:'held'});try{t.mock.timers.enable({apis:['setTimeout']});activate(f,await open(f));await wait(()=>f.releasePreview());const first=f.releasePreview();
  t.mock.timers.tick(15000);await wait(()=>completed(f));assert.match(f.notice(),/timed out/);const notice=f.notice();assert(!dialog(f));
  activate(f,await open(f));await wait(()=>f.releasePreview()!==first);const second=f.releasePreview();const loading=f.notice();assert.match(loading,/Reviewing selected Today tabs/);
  // An old response must not overwrite the new review's status, release its hold,
  // or open its old dialog while this second exact preview is still pending.
  if(late==='reply')await first.reply();else first.reject();await tick();assert.equal(f.notice(),loading);assert(!dialog(f));assert.equal(f.pendingMutations(),1);
  await second.reply();await wait(()=>dialog(f));cancel(f);await wait(()=>completed(f));
  assert.deepEqual(f.calls.map(c=>c.type),['previewTodayRecovery','previewTodayRecovery']);assert.equal(f.backend.effects.length,0);
 }finally{t.mock.timers.reset();await f.cleanup();}
});

for(const mode of ['transport-error','no-background','malformed'])test(`production preview ${mode} is visible and never confirms`,async()=>{
 const f=await fixture({previewMode:mode});try{activate(f,await open(f));await wait(()=>completed(f));
  assert.match(f.notice(),mode==='malformed'?/did not match the exact selection/:/preview unavailable/);assert(!dialog(f));assert.equal(f.calls.length,1);assert.equal(f.backend.effects.length,0);
 }finally{await f.cleanup();}
});

for(const exit of ['Escape','blur','pagehide','hidden'])test(`pending preview ${exit} cancels and ignores a late reply`,async()=>{
 const f=await fixture({previewMode:'held'});try{activate(f,await open(f));await wait(()=>f.releasePreview());
  if(exit==='Escape')f.event(f.document,'keydown',{key:'Escape'});if(exit==='blur')f.event(f.window,'blur');if(exit==='pagehide')f.event(f.window,'pagehide');if(exit==='hidden'){Object.defineProperty(f.document,'hidden',{value:true,configurable:true});f.event(f.document,'visibilitychange');}
  await wait(()=>completed(f));assert.match(f.notice(),/cancelled/);const notice=f.notice();await f.releasePreview().reply();await tick();assert(!dialog(f));assert.equal(f.notice(),notice);assert.equal(f.backend.effects.length,0);
 }finally{await f.cleanup();}
});

test('production confirmation losing its worker connection reports unknown and never retries',async()=>{
 const f=await fixture();try{activate(f,await open(f));await wait(()=>dialog(f));
  f.backend.hooks.query=()=>{delete f.backend.hooks.query;f.ports.at(-1).server.disconnect();};
  f.submits.at(-1)({preventDefault(){},isTrusted:true});await wait(()=>completed(f));await f.backend.store.run(async()=>{});
  assert.match(f.notice(),/could not be verified/);assert.deepEqual(f.calls.map(c=>c.type),['previewTodayRecovery','confirmTodayRecovery']);assert.equal(f.backend.effects.length,0);
 }finally{await f.cleanup();}
});
