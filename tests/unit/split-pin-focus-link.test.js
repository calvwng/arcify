import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createSplitPinAttachUI } from '../../split-pin-attach-ui.js';
import { runSplitPinAction, validSplitPinState, SPLIT_PINS_KEY, SPLIT_PIN_SESSION_KEY } from '../../split-pins.js';
import { SpaceStore } from '../../space-store.js';
import { SPLIT_PIN_FOCUS_LINKS_KEY, sameFocusValue } from '../../split-pin-focus-links.js';
import { SAVED_SPLITS_KEY } from '../../saved-splits.js';
import { splitPinUrl } from '../../split-pin-identity.js';
import { SPLIT_RESTORED_HINTS_KEY, SPLIT_RESTORED_HINT_SESSION_KEY, settleRestoredSplitHintWrites } from '../../split-pin-restored-hints.js';
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
        windows: { async get(id) { await hooks.windowGet?.(); return { id, type: 'normal', incognito: false, ...hooks.window }; } },
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
    chrome.storage.session = { async get(key) { return Object.fromEntries([].concat(key).map(k=>[k,hooks.reorderStorage ? reorder(copy(session[k])) : copy(session[k])])); }, async set(value) { await hooks.beforeSessionSet?.(value); Object.assign(session, copy(value)); await hooks.afterSessionSet?.(value); } };
    chrome.tabs.remove = async ids => { effects.push(['remove', ids]); for (const id of [].concat(ids)) { const i = tabs.findIndex(t => t.id === id); if (i >= 0) tabs.splice(i, 1); } };
    Utils._pinnedStateChain = Promise.resolve();
    const request = { type: 'savedSplitAction', action: 'save', windowId: 10, spaceId: 's', bookmarkFolderId: 'root', entries: tabs.map(t => ({ tabId: t.id, url: t.url, index: t.index, groupId: t.groupId, pinned: t.pinned, splitViewId: t.splitViewId })) };
    return { nodes, session, tabs, effects, hooks, data, store, request, listeners, run: async extra => { const result = await runSplitPinAction(store, { ...request, type: 'splitPinAction', action: 'pin', ...extra }); await settleRestoredSplitHintWrites(); return result; } };
}


async function ready() { const f=fixture(); const {bookmarkId}=await f.run(); delete f.session[SPLIT_PIN_SESSION_KEY]; f.bookmarkId=bookmarkId; f.action=(action,extra={})=>f.run({action,bookmarkId,...extra}); return f; }
async function link(f) { const c=await f.action('attachCandidates'); assert.equal(c.candidates.length,1); return f.action('attach',{candidateToken:c.candidates[0].candidateToken}); }
const noCreates=f=>assert.equal(f.effects.filter(e=>e[0]==='create').length,0);
test('explicit focus link never becomes strong witness or hides Today; worker replacement focuses exact pair',async()=>{
 const f=await ready(); const before=structuredClone(f.data); await link(f);
 const withoutHints=data=>Object.fromEntries(Object.entries(data).filter(([key])=>key!==SPLIT_RESTORED_HINTS_KEY));
 assert.deepEqual(withoutHints(f.data),withoutHints(before)); assert.equal(f.session[SPLIT_PIN_SESSION_KEY],undefined);
 const presented=(await f.action('list')).pins[0];
 assert.deepEqual(presented.tabIds,[]); assert.deepEqual(presented.focusLinkedTabIds,[1,2]);
 assert.equal(presented.releaseAllowed,false);
 f.store={...f.store}; f.action=(action,extra={})=>runSplitPinAction(f.store,{...f.request,type:'splitPinAction',action,bookmarkId:f.bookmarkId,...extra});
 assert.equal((await f.action('activate')).focusOnly,true); noCreates(f);
 await assert.rejects(f.action('close')); assert.equal(f.tabs.length,2);
});
test('verified advisory rendering is exact and read-only, even with same-URL native decoys',async()=>{
 const f=await ready();
 f.tabs.push(...f.tabs.map((t,i)=>({...t,id:3+i,index:2+i,splitViewId:71})));
 f.store.spaces[0].temporaryTabs.push(3,4);
 const choices=await f.action('attachCandidates');
 assert.equal(choices.candidates.length,2);
 await f.action('attach',{candidateToken:choices.candidates.find(c=>c.entries[0].tabId===1).candidateToken});
 const before=structuredClone({session:f.session,data:f.data,tabs:f.tabs,spaces:f.store.spaces});
 const pin=(await f.action('list')).pins[0];
 assert.deepEqual(pin.focusLinkedTabIds,[1,2]); assert.deepEqual(pin.tabIds,[]); assert.equal(pin.releaseAllowed,false);
 assert.deepEqual({session:f.session,data:f.data,tabs:f.tabs,spaces:f.store.spaces},before);
 await assert.rejects(f.action('close')); noCreates(f);
});
test('a native lifecycle change during the final list context withdraws the advisory decoration',async()=>{
 const f=await ready(); await link(f);
 let reads=0; f.hooks.windowGet=()=>{ reads++; };
 assert.deepEqual((await f.action('list')).pins[0].focusLinkedTabIds,[1,2]);
 const finalRead=reads; reads=0;
 f.hooks.windowGet=()=>{
  if(++reads!==finalRead) return;
  f.tabs[1].splitViewId=-1;
  for(const cb of chrome.tabs.onUpdated.callbacks) cb(2,{splitViewId:-1});
 };
 const pin=(await f.action('list')).pins[0];
 assert.equal(reads,finalRead); assert.deepEqual(pin.focusLinkedTabIds,[]); noCreates(f);
});
for (const variant of ['cold','pending','dissolved','navigating','changed-marker','overlapping-witness']) test(`advisory rendering is absent for ${variant}`, async()=>{
 const f=await ready(); await link(f);
 const key=`10:${f.bookmarkId}`;
 if(variant==='cold') delete f.session[SPLIT_PIN_FOCUS_LINKS_KEY];
 if(variant==='pending')f.session[SPLIT_PIN_FOCUS_LINKS_KEY][key].phase='pending';
 if(variant==='dissolved')f.tabs[1].splitViewId=-1;
 if(variant==='navigating')f.tabs[0].pendingUrl='https://destination.test/pending';
 if(variant==='changed-marker')f.nodes.find(n=>n.id===f.bookmarkId).title='Changed';
 if(variant==='overlapping-witness')f.session[SPLIT_PIN_SESSION_KEY]={'10:other':{bookmarkId:'other',windowId:10,tabIds:[1,2],splitViewId:70}};
 const pin=(await f.action('list')).pins[0];
 assert.deepEqual(pin.focusLinkedTabIds,[]); assert.deepEqual(pin.tabIds,[]); assert.equal(pin.releaseAllowed,false); noCreates(f);
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
for (const id of [1, 999]) for (const change of [{title:'Loaded title'}, {favIconUrl:'https://page.test/icon'}, {title:'',favIconUrl:''}]) test(`focus cosmetic ${id} ${JSON.stringify(change)} keeps exact proof`,async()=>{
 const f=await ready();await link(f);const receipt=structuredClone(f.session);
 f.hooks.update=()=>emitUpdate(id,change);
 assert.equal((await f.action('activate')).focused,true);noCreates(f);
 assert.equal(f.effects.filter(e=>e[0]==='update').length,1);assert.deepEqual(f.session,receipt);
});
for (const change of [{},{title:null},{title:'x',unknown:true},{status:'unknown'},{url:'https://page.test/1'},{splitViewId:70},{pendingUrl:'https://page.test/1'}]) test(`unknown/structural update fails closed ${JSON.stringify(change)}`,async()=>{
 const f=await ready();await link(f);f.hooks.update=()=>emitUpdate(1,change);
 await assert.rejects(f.action('activate'),e=>!e.message.includes('verification is pending'));noCreates(f);
 assert.equal(f.effects.filter(e=>e[0]==='update').length,1);
});
for(const mode of ['loading','loading-complete','no-event-loading'])test(`post-activation ${mode} stays uncertain without retry`,async()=>{
 const f=await ready();await link(f);const receipt=structuredClone(f.session);
 f.hooks.update=()=>{f.tabs[0].status='loading';if(mode!=='no-event-loading')emitUpdate(1,{status:'loading'});if(mode==='loading-complete'){f.tabs[0].status='complete';emitUpdate(1,{status:'complete',title:'Ready'});}};
 await assert.rejects(f.action('activate'),/Focus verification is pending/);noCreates(f);
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
 await assert.rejects(f.action('activate'),e=>!e.message.includes('verification is pending'));noCreates(f);
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
 else await assert.rejects(f.action('activate'),e=>!e.message.includes('verification is pending'));
 noCreates(f);assert.equal(f.effects.filter(e=>e[0]==='update').length,1);
});

// Durable split-ID hints decorate the existing explicit chooser only.
async function restoredHintFixture({attach=false}={}) {
 const f=await ready();if(attach)await link(f);
 for(const key of Object.keys(f.session))delete f.session[key];
 f.tabs.forEach(t=>{t.id+=100;t.status='complete';});f.store.spaces[0].temporaryTabs=[101,102];
 return f;
}
test('strong native pin records bounded private hint and cold chooser annotates one existing capability only',async()=>{
 const f=await restoredHintFixture();const saved=structuredClone(f.data),native=structuredClone(f.tabs);
 const result=await f.action('attachCandidates');assert.equal(result.candidates.length,1);assert.equal(result.candidates[0].possibleRestoredMatch,true);
 assert(!('selected' in result.candidates[0]));assert(!('preselected' in result.candidates[0]));assert.deepEqual(f.tabs,native);assert.deepEqual(f.data,saved);assert.equal(f.session[SPLIT_PIN_FOCUS_LINKS_KEY],undefined);
 const row=f.data[SPLIT_RESTORED_HINTS_KEY].records[0];assert.deepEqual(Object.keys(row).sort(),['bookmarkFolderId','bookmarkId','recipeId','savedAt','sessionNonce','spaceId','splitViewId']);
 assert(!JSON.stringify(row).includes('https:'));assert.equal(row.splitViewId,70);noCreates(f);
 await f.action('attach',{candidateToken:result.candidates[0].candidateToken});assert.equal(f.session[SPLIT_PIN_FOCUS_LINKS_KEY][`10:${f.bookmarkId}`].phase,'linked');
 assert.equal((await f.action('attachCandidates')).candidates.filter(c=>c.possibleRestoredMatch).length,0);
});
test('explicit confirmed attach also records a hint and same-ID replacement is only a suggestion',async()=>{
 const f=await restoredHintFixture({attach:true});f.tabs.forEach((t,i)=>{t.url=`https://replaced.test/${i}`;t.title='Replacement';t.index+=3;});
 const before=structuredClone(f.tabs),result=await f.action('attachCandidates');assert.equal(result.candidates[0].possibleRestoredMatch,true);assert.deepEqual(f.tabs,before);assert.equal(f.session[SPLIT_PIN_SESSION_KEY],undefined);assert.equal(f.session[SPLIT_PIN_FOCUS_LINKS_KEY],undefined);noCreates(f);
});
test('same-session receipt absence never becomes a restored hint',async()=>{
 const f=await ready();f.tabs.forEach(t=>t.status='complete');assert(f.session[SPLIT_RESTORED_HINT_SESSION_KEY]);const result=await f.action('attachCandidates');assert.equal(result.candidates.length,1);assert.equal(result.candidates[0].possibleRestoredMatch,undefined);
});
test('hint never reorders candidates or selects a matching split beside same-URL decoys',async()=>{
 const f=await restoredHintFixture();f.tabs.unshift(...f.tabs.map((t,i)=>({...t,id:201+i,index:i,splitViewId:71})));f.tabs.filter(t=>t.id<200).forEach(t=>t.index+=2);f.store.spaces[0].temporaryTabs.push(201,202);
 const result=await f.action('attachCandidates');assert.deepEqual(result.candidates.map(c=>c.entries[0].splitViewId),[71,70]);assert.deepEqual(result.candidates.map(c=>c.possibleRestoredMatch),[undefined,true]);assert.equal(f.session[SPLIT_PIN_FOCUS_LINKS_KEY],undefined);
});
for(const mode of ['old-build','expired','future','wrong-space','wrong-root','wrong-recipe','negative','malformed','collision-window','unknown-global-hash','extra-pane','claim-other-window','claim-overlap','malformed-claim','loading','unloaded','pending','different-current-window'])test(`restored hint suppressed for ${mode}`,async()=>{
 const f=await restoredHintFixture(),row=f.data[SPLIT_RESTORED_HINTS_KEY].records[0];
 if(mode==='old-build')delete f.data[SPLIT_RESTORED_HINTS_KEY];
 if(mode==='expired')row.savedAt=Date.now()-31*86400000;
 if(mode==='future')row.savedAt=Date.now()+86400000;
 if(mode==='wrong-space')row.spaceId='other';if(mode==='wrong-root')row.bookmarkFolderId='other';if(mode==='wrong-recipe')row.recipeId='other';if(mode==='negative')row.splitViewId=-1;
 if(mode==='malformed')row.url='https://private.test';
 if(mode==='collision-window')f.tabs.push(...f.tabs.map(t=>({...t,id:t.id+100,windowId:20})));
 if(mode==='unknown-global-hash')f.tabs.push({...f.tabs[0],id:300,windowId:20,splitViewId:undefined});
 if(mode==='extra-pane'){f.tabs.push({...f.tabs[0],id:300,index:2});f.store.spaces[0].temporaryTabs.push(300);}
 if(mode==='claim-other-window')f.session[SPLIT_PIN_SESSION_KEY]={[`20:${f.bookmarkId}`]:{bookmarkId:f.bookmarkId,windowId:20,tabIds:[201,202],splitViewId:71}};
 if(mode==='claim-overlap')f.session[SPLIT_PIN_SESSION_KEY]={'10:other':{bookmarkId:'other',windowId:10,tabIds:[101,102],splitViewId:70}};
 if(mode==='malformed-claim')f.session[SPLIT_PIN_SESSION_KEY]='malformed';
 if(mode==='loading'||mode==='unloaded')f.tabs[0].status=mode;
 if(mode==='pending')f.tabs[0].pendingUrl='https://next.test';
 if(mode==='different-current-window')f.tabs.forEach(t=>t.windowId=20);
 const result=await f.action('attachCandidates');assert.equal(result.candidates.filter(c=>c.possibleRestoredMatch).length,0);noCreates(f);
});
test('different nonmatching current session marker permits a prior-session hint without changing action semantics',async()=>{
 const f=await restoredHintFixture();f.session[SPLIT_RESTORED_HINT_SESSION_KEY]=crypto.randomUUID();assert.equal((await f.action('attachCandidates')).candidates[0].possibleRestoredMatch,true);
});
test('explicit unlink forgets the suggestion best effort and normal metadata stays unchanged',async()=>{
 const f=await ready();await link(f);const c=await f.action('attachCandidates');await f.action('unlinkFocus',{candidateToken:c.unlinkToken});assert.deepEqual(f.data[SPLIT_RESTORED_HINTS_KEY].records,[]);assert.equal(f.session[SPLIT_PIN_FOCUS_LINKS_KEY][`10:${f.bookmarkId}`],undefined);
});
test('hint storage read/write faults do not fail pin/attach or alter chooser eligibility',async()=>{
 const f=fixture();f.hooks.localSet=async values=>{if(values[SPLIT_RESTORED_HINTS_KEY])throw Error('hint disk failed');};const pinned=await f.run();assert(pinned.bookmarkId);
 const g=await ready();delete g.data[SPLIT_RESTORED_HINTS_KEY];g.hooks.localSet=async values=>{if(values[SPLIT_RESTORED_HINTS_KEY])throw Error('hint disk failed');};await link(g);assert.equal(g.session[SPLIT_PIN_FOCUS_LINKS_KEY][`10:${g.bookmarkId}`].phase,'linked');
 const h=await restoredHintFixture();const get=chrome.storage.local.get;chrome.storage.local.get=async key=>{if(key===SPLIT_RESTORED_HINTS_KEY)throw Error('hint read failed');return get(key);};const result=await h.action('attachCandidates');assert.equal(result.candidates.length,1);assert.equal(result.candidates[0].possibleRestoredMatch,undefined);
});
test('late lifecycle change during hint lookup never returns stale chooser capabilities',async()=>{
 const f=await restoredHintFixture(),get=chrome.storage.local.get;chrome.storage.local.get=async key=>{const result=await get(key);if(key===SPLIT_RESTORED_HINTS_KEY){f.tabs[1].splitViewId=-1;chrome.tabs.onUpdated.callbacks.forEach(fn=>fn(102,{splitViewId:-1}));}return result;};
 await assert.rejects(f.action('attachCandidates'),/changed/);noCreates(f);
});
test('receipt change during hint lookup withholds annotation; existing attach revalidates',async()=>{
 const f=await restoredHintFixture(),get=chrome.storage.local.get;
 chrome.storage.local.get=async key=>{const result=await get(key);if(key===SPLIT_RESTORED_HINTS_KEY)f.session[SPLIT_PIN_FOCUS_LINKS_KEY]={[`10:${f.bookmarkId}`]:{version:1,phase:'pending',token:'other',windowId:10,spaceId:'s',bookmarkId:f.bookmarkId,target:{},entries:[]}};return result;};
 const result=await f.action('attachCandidates');assert.equal(result.candidates.length,1);assert.equal(result.candidates[0].possibleRestoredMatch,undefined);await assert.rejects(f.action('attach',{candidateToken:result.candidates[0].candidateToken}));noCreates(f);
});
test('late strong claim during suggested-token validation removes decoration without granting attach',async()=>{
 const f=await restoredHintFixture();const query=chrome.tabs.query;let completeReads=0;
 chrome.tabs.query=async options=>{const result=await query(options);if(!options?.windowId&&++completeReads===2)f.session[SPLIT_PIN_SESSION_KEY]={'10:other':{bookmarkId:'other',windowId:10,tabIds:[101,102],splitViewId:70}};return result;};
 const result=await f.action('attachCandidates');assert.equal(result.candidates[0].possibleRestoredMatch,undefined);await assert.rejects(f.action('attach',{candidateToken:result.candidates[0].candidateToken}));
});
test('successful authoritative attach does not await ancillary hint I/O',async()=>{
 const f=await ready(),c=await f.action('attachCandidates');let release,entered=false;const gate=new Promise(r=>release=r),get=chrome.storage.local.get;
 chrome.storage.local.get=async key=>{if(key===SPLIT_RESTORED_HINTS_KEY){entered=true;await gate;}return get(key);};
 let result;const action=runSplitPinAction(f.store,{...f.request,type:'splitPinAction',action:'attach',bookmarkId:f.bookmarkId,candidateToken:c.candidates[0].candidateToken}).then(v=>result=v);
 await new Promise(r=>setImmediate(r));assert(entered);assert.equal(result?.linked,true);release();await action;await settleRestoredSplitHintWrites();
});
test('slow hint lookup cannot return expired chooser tokens',async()=>{
 const f=await restoredHintFixture(),get=chrome.storage.local.get,now=Date.now;let elapsed=0;Date.now=()=>now()+elapsed;
 chrome.storage.local.get=async key=>{const value=await get(key);if(key===SPLIT_RESTORED_HINTS_KEY)elapsed=121000;return value;};
 try{await assert.rejects(f.action('attachCandidates'),/changed/);}finally{Date.now=now;}
});
test('unlink still succeeds and suppresses a hint when optional local deletion fails',async()=>{
 const f=await ready();await link(f);const choices=await f.action('attachCandidates');f.hooks.localSet=async values=>{if(values[SPLIT_RESTORED_HINTS_KEY])throw Error('optional deletion failed');};await f.action('unlinkFocus',{candidateToken:choices.unlinkToken});
 f.tabs.forEach(t=>t.status='complete');delete f.session[SPLIT_RESTORED_HINT_SESSION_KEY];const result=await f.action('attachCandidates');assert.equal(result.candidates[0].possibleRestoredMatch,undefined);
});
test('pending optional hint I/O cannot block ordinary chooser generation',async()=>{
 const f=await ready();const choices=await f.action('attachCandidates');let release;const gate=new Promise(r=>release=r),get=chrome.storage.local.get;
 chrome.storage.local.get=async key=>{if(key===SPLIT_RESTORED_HINTS_KEY)await gate;return get(key);};
 await runSplitPinAction(f.store,{...f.request,type:'splitPinAction',action:'attach',bookmarkId:f.bookmarkId,candidateToken:choices.candidates[0].candidateToken});
 let result;const picker=runSplitPinAction(f.store,{...f.request,type:'splitPinAction',action:'attachCandidates',bookmarkId:f.bookmarkId}).then(v=>result=v);
 await new Promise(r=>setImmediate(r));assert.equal(result?.candidates.length,1);assert.equal(result.candidates[0].possibleRestoredMatch,undefined);release();await picker;await settleRestoredSplitHintWrites();
});

test('actual cold worker hint reaches actual picker as an unselected label with no mutations on Cancel',async()=>{
 const f=await restoredHintFixture();
 const {document}=parseHTML('<html><body></body></html>'),create=document.createElement.bind(document);
 document.createElement=name=>{const el=create(name);if(name==='dialog'){el.showModal=()=>{};el.close=()=>{};}return el;};
 const before=structuredClone({tabs:f.tabs,session:f.session,data:f.data}),actions=[];
 const ui=createSplitPinAttachUI({document,context:()=>({windowId:f.request.windowId,spaceId:f.request.spaceId,bookmarkFolderId:f.request.bookmarkFolderId}),
  sendRequest:async request=>{actions.push(request.action);return {success:true,...await runSplitPinAction(f.store,request)};},refresh(){},showStatus(){}});
 await ui.open(f.bookmarkId);
 const radios=[...document.querySelectorAll('input[type=radio]')];
 assert.equal(radios.length,1);assert(!radios[0].checked);
 assert.equal(document.querySelector('.split-pin-possible-restored-match')?.textContent.trim(),'Possible restored match');
 const button=label=>[...document.querySelectorAll('button')].find(b=>b.textContent===label);
 assert.equal(button('Link selected pair for focus').disabled,true);
 button('Cancel').click();
 assert.deepEqual(actions,['attachCandidates']);assert.equal(document.querySelector('dialog'),null);
 assert.deepEqual({tabs:f.tabs,session:f.session,data:f.data},before);noCreates(f);
});

test('restored-hint trace is off by default and opt-in does not change the chooser or mutate state',async()=>{
 const {restoredHintTrace}=await import('../../split-restored-hint-trace.js');
 const trace=restoredHintTrace.controller;
 const f=await restoredHintFixture();
 const calls=[];
 const originalQuery=chrome.tabs.query;
 chrome.tabs.query=async options=>{calls.push(structuredClone(options));return originalQuery(options);};
 const snapshot=()=>structuredClone({tabs:f.tabs,data:f.data,session:f.session});
 const state=snapshot();
 const project=result=>result.candidates.map(({candidateToken,...candidate})=>candidate);
 f.effects.length=0;
 const baseline=await f.action('attachCandidates');
 const baselineQueries=calls.splice(0);
 const baselineEffects=f.effects.splice(0);
 assert.equal(baseline.candidates[0].possibleRestoredMatch,true);
 assert.equal(trace.read().enabled,false);
 assert.deepEqual(trace.read().attempts,[]);
 trace.enable();
 try {
  const tested=await f.action('attachCandidates');
  assert.deepEqual(project(tested),project(baseline));
  assert.deepEqual(calls,baselineQueries);
  assert.deepEqual(f.effects.splice(0),baselineEffects);
  const output=trace.read();
  assert.equal(output.attempts.length,1);
  assert.equal(output.attempts[0].flagged,true);
  const encoded=JSON.stringify(output);
  for(const forbidden of ['https://','Page 1','candidateToken','bookmarkId','recipeId','sessionNonce',tested.candidates[0].candidateToken,f.data[SPLIT_RESTORED_HINTS_KEY].records[0].sessionNonce]){
   assert(!encoded.includes(forbidden),`trace leaked ${forbidden}`);
  }
  output.attempts.pop();
  assert.equal(trace.read().attempts.length,1);
  assert.deepEqual(snapshot(),state);
  noCreates(f);
 } finally { trace.disable();trace.clear(); }
});

test('trace distinguishes same-session, changed native ID, and still-unloaded panes without attaching',async()=>{
 const {restoredHintTrace}=await import('../../split-restored-hint-trace.js');
 const trace=restoredHintTrace.controller;
 for(const scenario of ['unloaded','hash-changed','same-session']){
  const f=await restoredHintFixture({attach:true});
  if(scenario==='unloaded')f.tabs[0].status='unloaded';
  if(scenario==='hash-changed')f.tabs.forEach(t=>t.splitViewId++);
  if(scenario==='same-session')f.session[SPLIT_RESTORED_HINT_SESSION_KEY]=f.data[SPLIT_RESTORED_HINTS_KEY].records[0].sessionNonce;
  trace.enable();
  try {
   const before=structuredClone({tabs:f.tabs,session:f.session,data:f.data});
   const result=await f.action('attachCandidates');
   assert.equal(result.candidates.length,1,scenario);
   assert.equal(result.candidates[0].possibleRestoredMatch,undefined,scenario);
   const capture=trace.read();
   assert.equal(capture.attempts.length,1,scenario);
   const [attempt]=capture.attempts;
   assert.equal(attempt.source,'chooser');
   assert.equal(attempt.outcome,'returned');
   assert.equal(attempt.flagged,false);
   if(scenario==='same-session'){
    assert.equal(attempt.helperReason,'same-or-invalid-session');
    assert.equal(attempt.flags.sessionMatches,true);
   }else{
    assert.equal(attempt.helperReason,'pair-not-ready-or-eligible');
    assert.equal(attempt.flags.matchingPairExists,scenario==='unloaded');
    assert.equal(attempt.flags.candidateMatchesSavedSplit,scenario==='unloaded');
    if(scenario==='unloaded')assert.equal(attempt.flags.pairComplete,false);
   }
   assert.deepEqual({tabs:f.tabs,session:f.session,data:f.data},before);
  } finally { trace.disable();trace.clear(); }
 }
});

test('restored hint trace retains only its bounded tail, and disabling preserves locally readable evidence',async()=>{
 const {restoredHintTrace}=await import('../../split-restored-hint-trace.js');
 const trace=restoredHintTrace.controller;
 const f=await restoredHintFixture();
 trace.enable();
 try {
  for(let i=0;i<24;i++){
   f.tabs[0].status=i===23?'unloaded':'complete';
   await f.action('attachCandidates');
  }
  const captured=trace.read();
  assert.equal(captured.attempts.length,16);
  assert.equal(captured.attempts[0].flagged,true);
  assert.equal(captured.attempts.at(-1).flagged,false);
  trace.disable();
  f.tabs[0].status='complete';
  await f.action('attachCandidates');
  assert.deepEqual(trace.read(),{...captured,enabled:false});
  trace.clear();
  assert.deepEqual(trace.read().attempts,[]);
 } finally { trace.disable();trace.clear(); }
});
