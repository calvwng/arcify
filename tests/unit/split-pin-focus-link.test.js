import test from 'node:test';
import assert from 'node:assert/strict';
import { runSplitPinAction, validSplitPinState, SPLIT_PINS_KEY, SPLIT_PIN_SESSION_KEY } from '../../split-pins.js';
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
