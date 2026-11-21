import test from 'node:test';
import assert from 'node:assert/strict';
import { registerSplitPinMessages, runSplitPinAction, validSplitPinState, SPLIT_PINS_KEY, SPLIT_PIN_SESSION_KEY } from '../../split-pins.js';
import { SpaceStore } from '../../space-store.js';
import { SPLIT_PIN_FOCUS_LINKS_KEY, sameFocusValue } from '../../split-pin-focus-links.js';
import { SAVED_SPLITS_KEY } from '../../saved-splits.js';
import { splitPinUrl } from '../../split-pin-identity.js';
import { Utils } from '../../utils.js';
const reorder = v => Array.isArray(v) ? v.map(reorder) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k,reorder(v[k])])) : v;
function fixture() {
    const effects = [], hooks = {}, data = {}, listeners = [];
    const tabs = [1, 2].map((id, index) => ({ id, windowId: 10, url: `https://page.test/${id}`, title: `Page ${id}`, index, groupId: -1, pinned: false, splitViewId: 70, incognito: false }));
    const copy = x => structuredClone(x);
    const store = { spaces: [{ id: 's', bookmarkFolderId: 'root', temporaryTabs: [1, 2], spaceBookmarks: [] }], active: { 10: 's' },
        run: fn => fn(), isGlobalTab: id => hooks.global === id,
        insertCreatedToday(space, tab) { space.temporaryTabs.push(tab.id); }, rebaseSectionRanks() {},
        async persist(options = {}) { effects.push('persist'); await hooks.persist?.(); await options.beforeWrite?.(); effects.push('persistCommitted'); } };
    globalThis.chrome = {
        runtime: { id: 'test', getURL: p => `chrome-extension://test/${p}`, onMessage: { addListener: fn => listeners.push(fn) } },
        windows: { async get(id) { return { id, type: 'normal', incognito: false, ...hooks.window }; } },
        storage: { local: {
            async get(key) { effects.push(['read', key]); return Object.fromEntries([].concat(key).map(k=>[k,k === 'pinnedTabStatesById' ? hooks.bindings || {} : copy(data[k])])); },
            async set(values) { effects.push('save'); Object.assign(data, copy(values)); await hooks.localSet?.(values); }
        } },
        tabs: {
            async query({ windowId } = {}) { await hooks.query?.(); return copy(tabs.filter(t => windowId === undefined || t.windowId === windowId)); },
            async get(id) { await hooks.get?.(id); return copy(tabs.find(t => t.id === id)); },
            async create(options) { effects.push(['create', options]); await hooks.create?.(); const tab = { ...copy(tabs[0]), id: Math.max(...tabs.map(t => t.id)) + 1, index: tabs.length, url: options.url, splitViewId: -1 }; tabs.push(tab); return copy(tab); },
            async update(id, update) { effects.push(['update', id, update]); await hooks.update?.(); Object.assign(tabs.find(t => t.id === id), update); return copy(tabs.find(t=>t.id===id)); },
            async createSplit(ids) { effects.push(['split', ids]); for (const id of ids) tabs.find(t => t.id === id).splitViewId = 80; return 80; },
            async unsplit() {}, async move() { throw new Error('Unexpected move'); }
        }
    };
    const nodes = [{ id: 'arc', title: 'Arcify', parentId: '0' }, { id: 'root', title: 'Personal', parentId: 'arc' }];
    let next = 100;
    chrome.bookmarks = {
        async get(id) { return nodes.filter(n => [].concat(id).includes(n.id)).map(copy); },
        async getChildren(id) { return nodes.filter(n => n.parentId === id).map(copy); },
        async search(q) { return nodes.filter(n => Object.entries(q).every(([k,v]) => n[k] === v)).map(copy); },
        async create(input) { effects.push(['bookmark', input]); const item = { id: String(next++), ...input }; const siblings = nodes.filter(n => n.parentId === input.parentId); const before = siblings[input.index]; nodes.splice(before ? nodes.indexOf(before) : nodes.length, 0, item); await hooks.bookmarkCreate?.(); return copy(item); }
    };
    const events = () => ({ callbacks: [], addListener(fn) { this.callbacks.push(fn); }, removeListener(fn) { this.callbacks = this.callbacks.filter(f => f !== fn); } });
    for (const key of ['onMoved', 'onRemoved', 'onChanged']) chrome.bookmarks[key] = events();
    chrome.bookmarks.remove = async id => { await hooks.beforeRemove?.(); const at = nodes.findIndex(n => n.id === id); if (at < 0) throw new Error('Missing bookmark'); nodes.splice(at, 1); effects.push(['bookmarkRemove', id]); await hooks.afterRemove?.(); };
    for (const key of ['onUpdated','onRemoved','onReplaced','onAttached','onDetached','onMoved']) chrome.tabs[key] = events();
    const session = {};
    chrome.storage.session = { async get(key) { return { [key]: hooks.reorderStorage ? reorder(copy(session[key])) : copy(session[key]) }; }, async set(value) { await hooks.beforeSessionSet?.(value); Object.assign(session, copy(value)); await hooks.afterSessionSet?.(value); } };
    chrome.tabs.remove = async ids => { effects.push(['remove', ids]); for (const id of [].concat(ids)) { const i = tabs.findIndex(t => t.id === id); if (i >= 0) tabs.splice(i, 1); } };
    Utils._pinnedStateChain = Promise.resolve();
    const request = { type: 'savedSplitAction', action: 'save', windowId: 10, spaceId: 's', bookmarkFolderId: 'root', entries: tabs.map(t => ({ tabId: t.id, url: t.url, index: t.index, groupId: t.groupId, pinned: t.pinned, splitViewId: t.splitViewId })) };
    return { nodes, session, tabs, effects, hooks, data, store, request, listeners, run: extra => runSplitPinAction(store, { ...request, type: 'splitPinAction', action: 'pin', ...extra }) };
}


async function ready() { const f=fixture(); const {bookmarkId}=await f.run(); delete f.session[SPLIT_PIN_SESSION_KEY]; f.bookmarkId=bookmarkId; f.action=(action,extra={})=>f.run({action,bookmarkId,...extra}); return f; }
async function link(f) { const c=await f.action('attachCandidates'); assert.equal(c.candidates.length,1); return f.action('attach',{candidateToken:c.candidates[0].candidateToken}); }
const terminalNoOffer="Couldn't confirm focus on this split. No new tabs were opened.";
const noCreates=f=>assert.equal(f.effects.filter(e=>e[0]==='create').length,0);
test('explicit focus link never becomes strong witness or hides Today; worker replacement focuses exact pair',async()=>{
 const f=await ready(); const before=structuredClone(f.data); await link(f);
 assert.deepEqual(f.data,before); assert.equal(f.session[SPLIT_PIN_SESSION_KEY],undefined);
 assert.deepEqual((await f.action('list')).pins[0].tabIds,[]);
 f.store={...f.store}; f.action=(action,extra={})=>runSplitPinAction(f.store,{...f.request,type:'splitPinAction',action,bookmarkId:f.bookmarkId,...extra});
 assert.equal((await f.action('activate')).focusOnly,true); noCreates(f);
 await assert.rejects(f.action('close')); assert.equal(f.tabs.length,2);
});
for (const kind of ['dissolve','navigation','private','loading','binding','global','root','pin','space','removed']) test(`stale ${kind} choice is rejected`,async()=>{
 const f=await ready(), c=await f.action('attachCandidates');
 if(kind==='dissolve')f.tabs[1].splitViewId=-1;
 if(kind==='navigation')f.tabs[0].url='https://different.test';
 if(kind==='private')f.tabs[0].incognito=true;
 if(kind==='loading')f.tabs[0].status='loading';
 if(kind==='binding')f.hooks.bindings={1:{bookmarkId:'x'}};
 if(kind==='global')f.hooks.global=1;
 if(kind==='root')f.store.spaces[0].bookmarkFolderId='else';
 if(kind==='pin')f.nodes.find(n=>n.id===f.bookmarkId).title='Changed';
 if(kind==='space')f.store.active[10]='other';
 if(kind==='removed')f.tabs.pop();
 await assert.rejects(f.action('attach',{candidateToken:c.candidates[0].candidateToken})); noCreates(f);
});
test('same URL unsplit twin is never chosen or focused',async()=>{
 const f=await ready(); f.tabs.push({...f.tabs[0],id:3,index:2,splitViewId:-1});f.store.spaces[0].temporaryTabs.push(3);
 await link(f); await f.action('activate'); assert.equal(f.tabs[2].active,undefined); noCreates(f);
});
test('stale linked receipt blocks fallback; explicit unlink allows a separate open',async()=>{
 const f=await ready(); await link(f);f.tabs[1].splitViewId=-1;
 await assert.rejects(f.action('activate'));noCreates(f);
 const c=await f.action('attachCandidates');assert.ok(c.unlinkToken);await f.action('unlinkFocus',{candidateToken:c.unlinkToken});noCreates(f);
 await f.action('activate');assert.equal(f.effects.filter(e=>e[0]==='create').length,2);
});
test('old chooser cannot survive worker replacement',async()=>{
 const f=await ready(), c=await f.action('attachCandidates');f.store={...f.store};
 await assert.rejects(runSplitPinAction(f.store,{...f.request,type:'splitPinAction',action:'attach',bookmarkId:f.bookmarkId,candidateToken:c.candidates[0].candidateToken}));noCreates(f);
});
test('pending write acknowledgement and rollback failure leaves no focus or ownership',async()=>{
 const f=await ready(), c=await f.action('attachCandidates');let writes=0;
 f.hooks.beforeSessionSet=()=>{if(++writes>1)throw Error('rollback unavailable');};f.hooks.afterSessionSet=()=>{throw Error('ack lost');};
 await assert.rejects(f.action('attach',{candidateToken:c.candidates[0].candidateToken}));
 assert.equal(f.session[SPLIT_PIN_FOCUS_LINKS_KEY][`10:${f.bookmarkId}`].phase,'pending');
 await assert.rejects(f.action('activate'));assert.equal(f.session[SPLIT_PIN_SESSION_KEY],undefined);noCreates(f);
});
test('linked write acknowledgement plus rollback failure leaves advisory receipt only',async()=>{
 const f=await ready(), c=await f.action('attachCandidates');let writes=0;
 f.hooks.beforeSessionSet=()=>{if(++writes>2)throw Error('rollback unavailable');};f.hooks.afterSessionSet=()=>{if(writes===2)throw Error('ack lost');};
 await assert.rejects(f.action('attach',{candidateToken:c.candidates[0].candidateToken}));
 assert.equal(f.session[SPLIT_PIN_SESSION_KEY],undefined);assert.deepEqual((await f.action('list')).pins[0].tabIds,[]);
 await f.action('activate');noCreates(f);await assert.rejects(f.action('close'));
});
test('inactive focus result is not reported confirmed',async()=>{
 const f=await ready();await link(f);chrome.tabs.update=async()=>({...f.tabs[0],active:false});
 await assert.rejects(f.action('activate'),/could not be confirmed/);noCreates(f);
});
test('late lifecycle event during post-focus reads is not reported confirmed',async()=>{
 const f=await ready();await link(f);f.hooks.update=()=>{f.hooks.query=()=>chrome.tabs.onUpdated.callbacks.forEach(fn=>fn());};
 await assert.rejects(f.action('activate'),/could not be confirmed/);noCreates(f);
});
test('queued same-target submits have one winner and no native mutation',async()=>{
 const f=await ready();f.store.chain=Promise.resolve();f.store.initialized=false;f.store.initialize=async()=>{};f.store.forgetTransientOwnership=()=>{};f.store.run=SpaceStore.prototype.run;
 const c=await f.action('attachCandidates'); const results=await Promise.allSettled([1,2].map(()=>f.action('attach',{candidateToken:c.candidates[0].candidateToken})));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);noCreates(f);
});
test('malformed scoped receipt blocks fallback but permits explicit unlink',async()=>{
 const f=await ready();f.session[SPLIT_PIN_FOCUS_LINKS_KEY]={[`10:${f.bookmarkId}`]:null};await assert.rejects(f.action('activate'));noCreates(f);
 const c=await f.action('attachCandidates');await f.action('unlinkFocus',{candidateToken:c.unlinkToken});assert.deepEqual(f.session[SPLIT_PIN_FOCUS_LINKS_KEY],{});
});
test('duplicate intact same-URL pairs stay distinct explicit choices',async()=>{
 const f=await ready();f.tabs.push(...f.tabs.map(t=>({...t,id:t.id+2,index:t.index+2,splitViewId:71})));f.store.spaces[0].temporaryTabs.push(3,4);
 const c=await f.action('attachCandidates');assert.equal(c.candidates.length,2);await f.action('attach',{candidateToken:c.candidates[1].candidateToken});await f.action('activate');
 assert.equal(f.tabs[2].active,true);assert.equal(f.tabs[0].active,undefined);noCreates(f);
});
test('late strong claim blocks old candidate and cannot be overwritten',async()=>{
 const f=await ready(),c=await f.action('attachCandidates');f.session[SPLIT_PIN_SESSION_KEY]={'10:other':{windowId:10,spaceId:'s',bookmarkId:'other',tabIds:[1,2],splitViewId:70}};
 await assert.rejects(f.action('attach',{candidateToken:c.candidates[0].candidateToken}));assert.ok(f.session[SPLIT_PIN_SESSION_KEY]['10:other']);noCreates(f);
});
test('late advisory claim blocks old candidate without rewriting the newer receipt',async()=>{
 const f=await ready(),c=await f.action('attachCandidates');const claim={unexpected:true};f.session[SPLIT_PIN_FOCUS_LINKS_KEY]={[`10:${f.bookmarkId}`]:claim};
 await assert.rejects(f.action('attach',{candidateToken:c.candidates[0].candidateToken}));assert.deepEqual(f.session[SPLIT_PIN_FOCUS_LINKS_KEY][`10:${f.bookmarkId}`],claim);
});
test('lifecycle event invalidates a chooser even when exact descriptors return',async()=>{
 const f=await ready(),c=await f.action('attachCandidates');chrome.tabs.onUpdated.callbacks.forEach(fn=>fn());await assert.rejects(f.action('attach',{candidateToken:c.candidates[0].candidateToken}));noCreates(f);
});
test('unchanged strong witness activation remains normal',async()=>{
 const f=fixture(),{bookmarkId}=await f.run();assert.equal((await f.run({action:'activate',bookmarkId})).reused,true);assert.equal(f.session[SPLIT_PIN_FOCUS_LINKS_KEY],undefined);
});
function anotherPin(f) {
 const recipe={...structuredClone(f.data[SAVED_SPLITS_KEY][0]),id:'another'};f.data[SAVED_SPLITS_KEY].push(recipe);
 const pin={...f.data[SPLIT_PINS_KEY].pins[0],recipeId:recipe.id,bookmarkId:'another'};f.data[SPLIT_PINS_KEY].pins.push(pin);
 f.nodes.push({...f.nodes.find(n=>n.id===f.bookmarkId),id:'another',url:splitPinUrl(recipe.id)});return 'another';
}
test('active advisory ownership rejects competing pin and malformed claims fail closed',async()=>{
 const f=await ready();await link(f);anotherPin(f);
 assert.equal((await f.action('attachCandidates',{bookmarkId:'another'})).candidates.length,0);
 const original=f.session[SPLIT_PIN_FOCUS_LINKS_KEY][`10:${f.bookmarkId}`];f.session[SPLIT_PIN_FOCUS_LINKS_KEY]={'wrong-key':original};
 assert.equal((await f.action('attachCandidates',{bookmarkId:'another'})).candidates.length,0);noCreates(f);
});
test('deleted original marker allows new explicit link; revival fails closed without record deletion',async()=>{
 const f=await ready();await link(f);anotherPin(f);const node=f.nodes.find(n=>n.id===f.bookmarkId);f.nodes.splice(f.nodes.indexOf(node),1);
 const c=await f.action('attachCandidates',{bookmarkId:'another'});assert.equal(c.candidates.length,1);await f.action('attach',{bookmarkId:'another',candidateToken:c.candidates[0].candidateToken});
 assert.equal(Object.keys(f.session[SPLIT_PIN_FOCUS_LINKS_KEY]).length,2);await f.action('activate',{bookmarkId:'another'});noCreates(f);
 f.nodes.push(node);await assert.rejects(f.action('activate',{bookmarkId:'another'}));await assert.rejects(f.action('activate'));noCreates(f);
});
test('moved-window original IDs permit explicit new link without granting old window authority',async()=>{
 const f=await ready();await link(f);anotherPin(f);f.tabs.forEach(t=>t.windowId=20);f.store.active[20]='s';
 const c=await f.action('attachCandidates',{windowId:20,bookmarkId:'another'});assert.equal(c.candidates.length,1);
 await f.action('attach',{windowId:20,bookmarkId:'another',candidateToken:c.candidates[0].candidateToken});await f.action('activate',{windowId:20,bookmarkId:'another'});
 await assert.rejects(f.action('activate'));noCreates(f);
});
test('same pin links distinct pairs in different windows without cross-window focus',async()=>{
 const f=await ready();await link(f);f.tabs.push(...f.tabs.map(t=>({...t,id:t.id+10,windowId:20})));f.store.spaces[0].temporaryTabs.push(11,12);f.store.active[20]='s';
 const c=await f.action('attachCandidates',{windowId:20});assert.equal(c.candidates.length,1);await f.action('attach',{windowId:20,candidateToken:c.candidates[0].candidateToken});
 await f.action('activate',{windowId:20});assert.equal(f.tabs.find(t=>t.id===11).active,true);assert.equal(f.tabs.find(t=>t.id===1).active,undefined);noCreates(f);
});
test('missing link never auto-associates existing same-URL pair; ordinary explicit open remains fresh',async()=>{
 const f=await ready();assert.deepEqual((await f.action('list')).pins[0].tabIds,[]);assert.equal(f.session[SPLIT_PIN_FOCUS_LINKS_KEY],undefined);
 await f.action('activate');assert.equal(f.effects.filter(e=>e[0]==='create').length,2);assert.equal(f.session[SPLIT_PIN_FOCUS_LINKS_KEY],undefined);
});
test('semantic equality ignores only object key ordering recursively, not values/presence/array order',()=>{
 const a={windowId:10,entries:[{tabId:1,url:'https://a.test'},{tabId:2,url:'https://b.test'}],target:{space:{id:'s',bookmarkFolderId:'root'}}};
 assert.equal(sameFocusValue(a,reorder(a)),true);
 for(const mutate of [v=>v.entries.reverse(),v=>v.entries[0].url='https://changed.test',v=>v.windowId='10',v=>v.extra=null,v=>delete v.target.space.id]){const b=structuredClone(a);mutate(b);assert.equal(sameFocusValue(a,reorder(b)),false);}
 assert.equal(sameFocusValue({a:undefined},{}),false);assert.equal(sameFocusValue([1,2],{'0':1,'1':2}),false);
});
test('Chrome-style recursively reordered storage readback commits and focuses exact pair',async()=>{
 const f=await ready();f.hooks.reorderStorage=true;await link(f);
 assert.equal(f.session[SPLIT_PIN_FOCUS_LINKS_KEY][`10:${f.bookmarkId}`].phase,'linked');
 assert.equal((await f.action('activate')).focused,true);noCreates(f);assert.equal(f.session[SPLIT_PIN_SESSION_KEY],undefined);
});
for(const mutation of ['url','pane-order','extra-key'])test(`reordered storage still refuses real ${mutation} change without overwriting it`,async()=>{
 const f=await ready();f.hooks.reorderStorage=true;const c=await f.action('attachCandidates');let writes=0;
 f.hooks.afterSessionSet=()=>{if(++writes===1){const r=f.session[SPLIT_PIN_FOCUS_LINKS_KEY][`10:${f.bookmarkId}`];if(mutation==='url')r.entries[0].url='https://changed.test';if(mutation==='pane-order')r.entries.reverse();if(mutation==='extra-key')r.extra=true;}};
 await assert.rejects(f.action('attach',{candidateToken:c.candidates[0].candidateToken}));assert.equal(writes,1);assert.equal(f.session[SPLIT_PIN_FOCUS_LINKS_KEY][`10:${f.bookmarkId}`].phase,'pending');noCreates(f);
});
test('reordered pending receipt with lost acknowledgement is exactly rolled back',async()=>{
 const f=await ready();f.hooks.reorderStorage=true;let writes=0;f.hooks.afterSessionSet=()=>{if(++writes===1)throw Error('lost ack');};
 await assert.rejects(link(f));assert.equal(writes,2);assert.deepEqual(f.session[SPLIT_PIN_FOCUS_LINKS_KEY],{});noCreates(f);
});
test('reordered replacement receipt failure restores exact existing predecessor, not a newer receipt',async()=>{
 const f=await ready();f.hooks.reorderStorage=true;await link(f);const before=structuredClone(f.session[SPLIT_PIN_FOCUS_LINKS_KEY]);const c=await f.action('attachCandidates');let writes=0;
 f.hooks.afterSessionSet=()=>{if(++writes===1)throw Error('lost ack');};
 await assert.rejects(f.action('attach',{candidateToken:c.candidates[0].candidateToken}));assert.deepEqual(f.session[SPLIT_PIN_FOCUS_LINKS_KEY],reorder(before));assert.equal((await f.action('activate')).focused,true);noCreates(f);
});
test('reordered final linked receipt lost acknowledgement is rolled back without ownership',async()=>{
 const f=await ready();f.hooks.reorderStorage=true;let writes=0;f.hooks.afterSessionSet=()=>{if(++writes===2)throw Error('lost final ack');};
 await assert.rejects(link(f));assert.equal(writes,3);assert.deepEqual(f.session[SPLIT_PIN_FOCUS_LINKS_KEY],{});assert.equal(f.session[SPLIT_PIN_SESSION_KEY],undefined);noCreates(f);
});

const emitUpdate = (id, change) => chrome.tabs.onUpdated.callbacks.forEach(fn => fn(id, change));
const focusConfirm=(f,t)=>runSplitPinAction(f.store,{type:'splitPinAction',action:'confirmFocus',windowId:10,spaceId:'s',bookmarkFolderId:'root',bookmarkId:f.bookmarkId,confirmationToken:t.confirmationToken});
async function loadingFixture() {
 const f=await ready();await link(f);f.tabs.forEach(t=>t.status='complete');
 const event=()=>({callbacks:new Set(),addListener(fn){this.callbacks.add(fn);},removeListener(fn){this.callbacks.delete(fn);},fire(...args){for(const fn of this.callbacks)fn(...args);}});
 chrome.tabs.onActivated=event();chrome.windows.onFocusChanged=event();chrome.storage.onChanged=event();
 f.store.chain=Promise.resolve();f.store.initialized=false;f.store.initialize=async()=>{};f.store.forgetTransientOwnership=()=>{};f.store.run=SpaceStore.prototype.run;
 f.hooks.update=()=>{f.tabs[0].status='loading';f.tabs[0].pendingUrl=f.tabs[0].url;};
 f.begin=()=>f.action('activate',{deferFocusConfirmation:true});
 return f;
}
test('same exact pending URL after successful activation without loading needs no deferred proof',async()=>{
 const f=await loadingFixture();
 f.hooks.update=()=>f.tabs.forEach(t=>{t.pendingUrl=t.url;});
 assert.deepEqual(await f.begin(),{focused:true,focusOnly:true,tabIds:[1,2]});noCreates(f);
 assert.deepEqual(f.effects.filter(e=>e[0]==='update'),[['update',1,{active:true}]]);
});
for(const pending of ['same','https://page.test/1#different',null,false,0,{}])test(`preflight refuses pending ${JSON.stringify(pending)}`,async()=>{
 const f=await loadingFixture();f.tabs[0].pendingUrl=pending==='same'?f.tabs[0].url:pending;
 await assert.rejects(f.begin(),e=>!e.message.includes('Focus may have changed'));
 assert.equal(f.effects.filter(e=>e[0]==='update').length,0);noCreates(f);
});
for(const mode of ['window-away','window-aba','unknown-pane','revision-only','unsupported','offered'])test(`worker activation returns truthful lifetime wording for ${mode}`,async()=>{
 const f=await loadingFixture(),before=structuredClone({session:f.session,data:f.data,spaces:f.store.spaces});
 let writes=0;
 f.hooks.beforeSessionSet=()=>{writes++;};
 f.hooks.localSet=()=>{writes++;};
 if(mode==='unsupported')delete chrome.windows.onFocusChanged;
 f.hooks.update=()=>{
  f.tabs[0].status='loading';
  if(mode==='window-away'||mode==='window-aba')chrome.windows.onFocusChanged.fire(11);
  if(mode==='window-aba')chrome.windows.onFocusChanged.fire(10);
  if(mode==='unknown-pane')f.tabs[1].status='unloaded';
  if(mode==='revision-only'){
   emitUpdate(1,{status:'loading'});f.tabs[0].status='complete';emitUpdate(1,{status:'complete'});
  }
 };
 registerSplitPinMessages(f.store);
 const message=(action,extra={})=>new Promise(resolve=>{
  const request={type:'splitPinAction',action,windowId:10,spaceId:'s',bookmarkFolderId:'root',bookmarkId:f.bookmarkId,...extra};
  assert.equal(f.listeners.at(-1)(request,{id:'test',url:'chrome-extension://test/sidebar.html'},resolve),true);
 });
 const reply=await message('activate',{deferFocusConfirmation:true});
 if(mode==='offered'){
  assert.equal(reply.success,true);
  assert.equal(reply.pendingMessage,'Focus verification is pending because page loading changed during activation. The existing link was kept; no second activation or fresh pair was attempted.');
  assert.equal(typeof reply.confirmationToken,'string');
  assert.equal(reply.activeTabId,1);
  f.tabs[0].status='complete';
  assert.deepEqual(await message('confirmFocus',{confirmationToken:reply.confirmationToken}),{success:true,confirmed:true});
 }else{
  assert.deepEqual(reply,{success:false,error:terminalNoOffer});
  assert.equal(chrome.tabs.onActivated.callbacks.size,0);
 }
 assert.equal(writes,0);
 assert.deepEqual({session:f.session,data:f.data,spaces:f.store.spaces},before);
 assert.deepEqual(f.tabs.map(({id,splitViewId})=>[id,splitViewId]),[[1,70],[2,70]]);
 assert.deepEqual(f.effects.filter(e=>e[0]==='update'),[['update',1,{active:true}]]);
 noCreates(f);
});
for(const mode of ['first-pane','second-pane','unlinked-identical','malformed','pending-receipt','stale-identity','loading',
    'pending-url','conflicting-link','strong-witness','global','inactive','two-active'])test(`list paints only the active exact receipt: ${mode}`,async()=>{
 const f=await loadingFixture();
 f.tabs[mode==='second-pane'?1:0].active=true;
 const key=`10:${f.bookmarkId}`, links=f.session[SPLIT_PIN_FOCUS_LINKS_KEY], record=links[key];
 if(mode==='unlinked-identical')delete links[key];
 if(mode==='malformed')links[key]={entries:{some:true}};
 if(mode==='pending-receipt')record.phase='pending';
 if(mode==='stale-identity'){f.tabs[1].id=3;f.store.spaces[0].temporaryTabs=[1,3];}
 if(mode==='loading')f.tabs[1].status='loading';
 if(mode==='pending-url')f.tabs[1].pendingUrl=f.tabs[1].url;
 if(mode==='conflicting-link'){
  links['10:other']={...structuredClone(record),bookmarkId:'other'};
  links['10:other'].target.bookmark.id='other';
  links['10:other'].entries[0].tabId=2;
  links['10:other'].entries[1].tabId=1;
  f.nodes.push({...f.nodes.find(node=>node.id===f.bookmarkId),id:'other'});
 }
 if(mode==='strong-witness')f.session[SPLIT_PIN_SESSION_KEY]={[key]:{bookmarkId:f.bookmarkId,spaceId:'s',windowId:10,tabIds:[1,2],splitViewId:70}};
 if(mode==='global')f.hooks.global=2;
 if(mode==='inactive')f.tabs[0].active=false;
 if(mode==='two-active')f.tabs[1].active=true;
 let writes=0,queries=0;f.hooks.beforeSessionSet=()=>writes++;f.hooks.localSet=()=>writes++;f.hooks.query=()=>queries++;
 const before=structuredClone({session:f.session,data:f.data,spaces:f.store.spaces});
 const result=await f.action('list');
 const eligible=['first-pane','second-pane','inactive','two-active'].includes(mode);
 assert.deepEqual(result.linkedSplitIndicators,eligible?[{bookmarkId:f.bookmarkId,paneIds:[1,2]}]:undefined);
 assert.equal(result.activePaneId,eligible?(mode==='first-pane'?1:mode==='second-pane'?2:null):undefined);
 const pin=result.pins.find(pin=>pin.bookmarkId===f.bookmarkId);
 assert.deepEqual(pin.tabIds,mode==='strong-witness'?[1,2]:[]);
 assert.equal(pin.releaseAllowed,mode==='strong-witness');
 assert.equal(f.effects.filter(e=>e[0]==='update').length,0);
 assert.deepEqual({session:f.session,data:f.data,spaces:f.store.spaces},before);
 assert.equal(writes,0);assert.equal(queries,1);noCreates(f);
});
test('one read-only proof confirms exact settled pair outside real FIFO',async()=>{
 const f=await loadingFixture(),before=structuredClone({session:f.session,data:f.data,spaces:f.store.spaces});
 const ticket=await f.begin();assert.match(ticket.pendingMessage,/verification is pending/);
 assert(!ticket.focused&&ticket.confirmationToken);
 chrome.tabs.onActivated.fire({windowId:10,tabId:1});
 const result=focusConfirm(f,ticket);assert.deepEqual(await focusConfirm(f,ticket),{confirmed:false});
 assert.equal(await f.store.run(()=>{f.tabs[0].status='complete';emitUpdate(1,{status:'complete'});return 'unblocked';}),'unblocked');
 assert.deepEqual(await result,{confirmed:true});
 assert.deepEqual(await focusConfirm(f,ticket),{confirmed:false});
 assert.deepEqual({session:f.session,data:f.data,spaces:f.store.spaces},before);
 assert.deepEqual(f.effects.filter(e=>e[0]==='update'),[['update',1,{active:true}]]);
 assert.equal(chrome.tabs.onActivated.callbacks.size,0);noCreates(f);
});
test('newer admitted split intent prevents the original watcher from issuing a later confirmation',async()=>{
 const f=await loadingFixture();let entered,released;
 const started=new Promise(r=>{entered=r;}),gate=new Promise(r=>{released=r;});
 f.hooks.update=async()=>{f.tabs[0].status='loading';entered();await gate;};
 const old=f.begin();await started;
 const newer=f.begin();
 const checked=Promise.all([assert.rejects(old,{message:terminalNoOffer}),assert.rejects(newer,/changed/)]);
 released();await checked;assert.equal(f.effects.filter(e=>e[0]==='update').length,1);noCreates(f);
});
for(const mode of ['tab-aba','window-aba','space-aba','receipt-change','scope','unloaded','late-load-aba','structural','queue','error','hung'])test(`deferred proof refuses ${mode} and never reactivates`,async()=>{
 const f=await loadingFixture(),ticket=await f.begin();assert(ticket.confirmationToken);
 f.tabs[0].status=mode==='unloaded'?'unloaded':'complete';
 if(mode==='scope')assert.deepEqual(await runSplitPinAction(f.store,{type:'splitPinAction',action:'confirmFocus',windowId:10,spaceId:'wrong',bookmarkFolderId:'root',bookmarkId:f.bookmarkId,confirmationToken:ticket.confirmationToken}),{confirmed:false});
 let resume,entered,queries=0;const started=new Promise(r=>{entered=r;});
 if(mode==='scope')f.tabs[0].status='loading';
 f.hooks.query=async()=>{
  if(++queries!==1)return;
  entered();
  if(mode==='late-load-aba'){emitUpdate(1,{status:'loading'});emitUpdate(1,{status:'complete'});}
  if(mode==='structural')emitUpdate(1,{pendingUrl:f.tabs[0].url});
  if(mode==='queue')await f.store.run(()=>null);
  if(mode==='error')throw Error('scripted read error');
  if(mode==='hung')await new Promise(r=>{resume=r;});
 };
 const result=focusConfirm(f,ticket);
 if(mode==='tab-aba'){chrome.tabs.onActivated.fire({windowId:10,tabId:99});chrome.tabs.onActivated.fire({windowId:10,tabId:1});}
 if(mode==='window-aba'){chrome.windows.onFocusChanged.fire(8);chrome.windows.onFocusChanged.fire(10);}
 if(mode==='space-aba'){chrome.storage.onChanged.fire({activeSpaces:{oldValue:{10:'s'},newValue:{10:'other'}}},'session');chrome.storage.onChanged.fire({activeSpaces:{oldValue:{10:'other'},newValue:{10:'s'}}},'session');}
 if(mode==='receipt-change')chrome.storage.onChanged.fire({splitPinFocusLinksV1:{oldValue:f.session[SPLIT_PIN_FOCUS_LINKS_KEY],newValue:{}}},'session');
 if(mode==='hung'){await started;assert.equal(await f.store.run(()=>true),true);}
 assert.deepEqual(await result,{confirmed:false});
 if(mode==='hung'){resume();await new Promise(r=>setImmediate(r));assert.equal(queries,1);}
 assert.deepEqual(await focusConfirm(f,ticket),{confirmed:false});
 assert.equal(chrome.tabs.onActivated.callbacks.size,0);assert.equal(f.effects.filter(e=>e[0]==='update').length,1);noCreates(f);
});


// The admission handoff is allowed to outlive routine FIFO bookkeeping, but
// the exact guard must begin only once and never overlap a changing tail.
const afterFocusTick=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const gateFocusQueue=()=>{let release;return {value:new Promise(resolve=>{release=resolve;}),release:()=>release()};};
test('repeated real SpaceStore queue admissions settle before one guarded focus proof',async()=>{
 const f=await loadingFixture(),ticket=await f.begin();assert(ticket.confirmationToken);
 f.tabs[0].status='complete';
 const before=structuredClone({session:f.session,data:f.data,spaces:f.store.spaces});
 let proofReads=0;f.hooks.query=()=>{proofReads++;};
 const first=gateFocusQueue(),second=gateFocusQueue(),third=gateFocusQueue();
 const a=f.store.run(()=>first.value);
 const proof=focusConfirm(f,ticket);
 await afterFocusTick(340);
 assert.equal(proofReads,0);
 const b=f.store.run(()=>second.value);
 first.release();await a;await afterFocusTick(15);
 assert.equal(proofReads,0);
 const c=f.store.run(()=>third.value);
 second.release();await b;await afterFocusTick(15);
 assert.equal(proofReads,0);
 third.release();await c;
 assert.deepEqual(await proof,{confirmed:true});
 assert.equal(proofReads,2); // The once-only existing guard reads current window and all tabs.
 assert.deepEqual(await focusConfirm(f,ticket),{confirmed:false});
 assert.deepEqual({session:f.session,data:f.data,spaces:f.store.spaces},before);
 assert.deepEqual(f.effects.filter(e=>e[0]==='update'),[['update',1,{active:true}]]);noCreates(f);
});
test('ongoing harmless FIFO churn cannot extend the original ticket or start a proof',async()=>{
 const f=await loadingFixture(), ticket=await f.begin();assert(ticket.confirmationToken);
 f.tabs[0].status='complete';let reads=0;f.hooks.query=()=>{reads++;};
 const initial=gateFocusQueue();let gate=initial, tail=f.store.run(()=>initial.value);
 const churn=setInterval(()=>{
  const old=gate,next=gateFocusQueue();
  gate=next;tail=f.store.run(()=>next.value);old.release();
 },40);
 try{
  assert.deepEqual(await focusConfirm(f,ticket),{confirmed:false});
  assert.equal(reads,0);
 }finally{clearInterval(churn);gate.release();await tail;}
 assert.equal(reads,0);noCreates(f);
 assert.deepEqual(f.effects.filter(e=>e[0]==='update'),[['update',1,{active:true}]]);
});
for(const outcome of ['deadline','newer-native-activation','newer-space-intent','newer-split-intent'])test(`pre-proof recapture remains fail-closed on ${outcome}`,async()=>{
 const f=await loadingFixture(),ticket=await f.begin();assert(ticket.confirmationToken);
 f.tabs[0].status='complete';
 let proofReads=0;f.hooks.query=()=>{proofReads++;};
 const first=gateFocusQueue(),second=gateFocusQueue();
 const a=f.store.run(()=>first.value), proof=focusConfirm(f,ticket);
 await afterFocusTick(340);
 const b=f.store.run(()=>second.value);
 first.release();await a;await afterFocusTick(15);
 assert.equal(proofReads,0);
 if(outcome==='newer-native-activation')chrome.tabs.onActivated.fire({windowId:10,tabId:99});
 if(outcome==='newer-space-intent'){
  f.store.applyAction=async()=>null; // The real SpaceStore dispatch invalidates at ingress.
  void SpaceStore.prototype.dispatch.call(f.store,{action:'activate',windowId:10,spaceId:'other'});
 }
 let newer;
 if(outcome==='newer-split-intent'){
  f.tabs[0].status='loading';
  newer=assert.rejects(f.begin(),/changed/); // Invalidates when admitted, before the queue drains.
 }
 assert.deepEqual(await proof,{confirmed:false});
 assert.equal(proofReads,0);
 second.release();await b;await newer;await afterFocusTick(0);
 if(outcome!=='newer-split-intent')assert.equal(proofReads,0);
 assert.deepEqual(await focusConfirm(f,ticket),{confirmed:false});
 assert.deepEqual(f.effects.filter(e=>e[0]==='update'),[['update',1,{active:true}]]);noCreates(f);
 assert.equal(chrome.tabs.onActivated.callbacks.size,0);
});

for (const id of [1, 999]) for (const change of [{title:'Loaded title'}, {favIconUrl:'https://page.test/icon'}, {title:'',favIconUrl:''}]) test(`focus cosmetic ${id} ${JSON.stringify(change)} keeps exact proof`,async()=>{
 const f=await ready();await link(f);const receipt=structuredClone(f.session);
 f.hooks.update=()=>emitUpdate(id,change);
 assert.equal((await f.action('activate')).focused,true);noCreates(f);
 assert.equal(f.effects.filter(e=>e[0]==='update').length,1);assert.deepEqual(f.session,receipt);
});
for (const change of [{},{title:null},{title:'x',unknown:true},{status:'unknown'},{url:'https://page.test/1'},{splitViewId:70},{pendingUrl:'https://page.test/1'}]) test(`unknown/structural update fails closed ${JSON.stringify(change)}`,async()=>{
 const f=await ready();await link(f);f.hooks.update=()=>emitUpdate(1,change);
 await assert.rejects(f.action('activate'),e=>e.message.startsWith('Focus may have changed, but the result could not be confirmed. No fresh pair was opened.'));noCreates(f);
 assert.equal(f.effects.filter(e=>e[0]==='update').length,1);
});
for(const mode of ['loading','loading-complete','no-event-loading'])test(`post-activation ${mode} stays uncertain without retry`,async()=>{
 const f=await ready();await link(f);const receipt=structuredClone(f.session);
 f.hooks.update=()=>{f.tabs[0].status='loading';if(mode!=='no-event-loading')emitUpdate(1,{status:'loading'});if(mode==='loading-complete'){f.tabs[0].status='complete';emitUpdate(1,{status:'complete',title:'Ready'});}};
 await assert.rejects(f.action('activate'),{message:terminalNoOffer});noCreates(f);
 assert.equal(f.effects.filter(e=>e[0]==='update').length,1);assert.deepEqual(f.session,receipt);
});
for(const mode of ['navigation-aba','split-aba','space','receipt','inactive'])test(`loading never masks ${mode}`,async()=>{
 const f=await ready();await link(f);f.hooks.update=()=>{
  f.tabs[0].status='loading';emitUpdate(1,{status:'loading'});
  if(mode==='navigation-aba')emitUpdate(1,{url:'https://else.test'});
  if(mode==='split-aba')chrome.tabs.onMoved.callbacks.forEach(fn=>fn(1,{}));
  if(mode==='space')f.store.active[10]='else';
  if(mode==='receipt')f.session[SPLIT_PIN_FOCUS_LINKS_KEY][`10:${f.bookmarkId}`].token='replacement';
  if(mode==='inactive')f.hooks.query=()=>{f.tabs[0].active=false;};
 };
 await assert.rejects(f.action('activate'),e=>e.message.startsWith('Focus may have changed, but the result could not be confirmed. No fresh pair was opened.'));noCreates(f);
});
test('cosmetic event still invalidates chooser and strict loading preflight',async()=>{
 const f=await ready(),c=await f.action('attachCandidates');emitUpdate(1,{title:'New'});
 await assert.rejects(f.action('attach',{candidateToken:c.candidates[0].candidateToken}));await link(f);
 f.tabs[0].status='loading';await assert.rejects(f.action('activate'));assert.equal(f.effects.filter(e=>e[0]==='update').length,0);noCreates(f);
});
for(const kind of ['cosmetic','structural','inactive'])test(`late post-focus read ${kind} retains final proof fence`,async()=>{
 const f=await ready();await link(f);
 f.hooks.update=()=>{f.hooks.query=()=>{
  if(kind==='cosmetic')emitUpdate(999,{title:'Unrelated'});
  if(kind==='structural'){emitUpdate(1,{status:'loading'});emitUpdate(1,{unknown:true});}
  if(kind==='inactive'){emitUpdate(1,{status:'loading'});f.tabs[0].active=false;}
 };};
 if(kind==='cosmetic')assert.equal((await f.action('activate')).focused,true);
 else await assert.rejects(f.action('activate'),e=>e.message.startsWith('Focus may have changed, but the result could not be confirmed. No fresh pair was opened.'));
 noCreates(f);assert.equal(f.effects.filter(e=>e[0]==='update').length,1);
});
