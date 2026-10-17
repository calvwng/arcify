// Evidence-validator tests only; importing these modules never launches Chrome.
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSkippedBookmarkOutcome, assertBookmarkSelection, assertBatchFavoriteResult, cancelHeldBookmarkDrag, finishBookmarkFixture, cleanupBookmarkFavoritesInSourceWindow, clickBookmarkFixtureRow, assertNativeDragSourceStable, installBookmarkSelectionTrace, installBookmarkDragTrace, readBookmarkDragState, prepareBookmarkSidebar, moveInsideBookmarkDropTarget } from '../../scripts/paired-chrome-bookmark-selection.mjs';
const selection = () => ({ ids: ['a','b','d'], count: 3, text: '3 bookmarks selected', rows: ['a','b','d'].map(id => ({ id, ariaSelected: 'true', visible: true })) });
test('selection requires exact visible order, announced count and accessible state', () => {
    assertBookmarkSelection(selection(), ['a','b','d']);
    assertBookmarkSelection({ ids: [], rows: [], count: 0, text: '' }, []);
});
for (const [label, mutate] of Object.entries({
    reordered: state => state.ids.reverse(), duplicate: state => state.ids[1] = 'a', wrongCount: state => state.count--,
    hidden: state => state.rows[1].visible = false, missingAria: state => state.rows[0].ariaSelected = null,
    wrongRows: state => state.rows.reverse(),
})) test(`selection rejects ${label} false evidence`, () => { const state = selection(); mutate(state); assert.throws(() => assertBookmarkSelection(state, ['a','b','d'])); });
const favorite = (id, bookmarkId, tabId) => ({ id, sourceBookmarkId: bookmarkId, tabId, title: `Title ${bookmarkId}`, url: 'http://fixture.test/same' });
const tab = (id, pinned = true) => ({ id, windowId: 1, index: 0, url: 'http://fixture.test/same', pinned, active: false, incognito: false, groupId: -1 });
const before = () => ({ windowId: 1, otherFavorites: [favorite('f-old','old',130)], favorites: [favorite('f-old','old',30)], tabs: [tab(30), { ...tab(50,false), active: true }],
    bookmarks: [{id:'root',children:['a','b','old'].map((id,index) => ({id,parentId:'root',index,title:`Title ${id}`,url:'http://fixture.test/same'}))}],
    spaces: [{windowId:1,activeSpaceId:'work',spaces:[{id:'work',tabIds:[50]}]},{windowId:2,activeSpaceId:'other',spaces:[]}],
    windows: [{id:1,type:'normal',incognito:false},{id:2,type:'normal',incognito:false}] });
const scenario = () => { const a=before(), b=structuredClone(a); b.favorites.unshift(favorite('f-a','a',31),favorite('f-b','b',32)); b.tabs.push(tab(31),tab(32)); b.otherFavorites.unshift(favorite('f-a','a',null),favorite('f-b','b',null)); return {before:a,after:b,expected:{bookmarkIds:['a','b'],beforeId:'f-old',newCount:2}}; };
test('batch proof preserves two same-URL identities and exact insertion order', () => {
    const s=scenario(); assert.deepEqual(assertBatchFavoriteResult(s.before,s.after,s.expected),{favoriteIds:['f-a','f-b'],tabIds:[31,32],order:['f-a','f-b','f-old']});
    assertBatchFavoriteResult(s.after,structuredClone(s.after),{...s.expected,newCount:0});
});
for (const [label, mutate] of Object.entries({
    wrongOrder: s => s.after.favorites.reverse(), lostSource: s => s.after.bookmarks[0].children.pop(),
    movedSource: s => s.after.bookmarks[0].children[0].parentId='other', renamedSource: s => s.after.bookmarks[0].children[0].title='changed',
    collapsedIdentity: s => s.after.favorites[1].tabId=31, unpinned: s => s.after.tabs.find(t=>t.id===31).pinned=false,
    foregroundSteal: s => s.after.tabs.find(t=>t.id===31).active=true, privateTab: s => s.after.tabs.find(t=>t.id===31).incognito=true,
    wrongWindow: s => s.after.tabs.find(t=>t.id===31).windowId=2, extraTab: s => s.after.tabs.push(tab(40)),
    lostOriginal: s => s.after.tabs.splice(s.after.tabs.findIndex(t=>t.id===50),1), wrongMetadata: s => s.after.favorites[0].title='wrong',
    changedExisting: s => s.after.favorites.at(-1).tabId=999, alteredSpace: s => s.after.spaces[0].activeSpaceId='other',
    otherWindowAdoption: s => s.after.otherFavorites[0].tabId=31, otherWindowOrder: s => s.after.otherFavorites.reverse(),
    closedWindow: s => s.after.windows.pop(), unsupportedAnchor: s => s.expected.beforeId='unknown',
    missingFavorite: s => s.after.favorites.pop(), unexpectedFavorite: s => s.after.favorites.push(favorite('extra','x',80)),
})) test(`batch evidence rejects ${label}`, () => { const s=scenario(); mutate(s); assert.throws(()=>assertBatchFavoriteResult(s.before,s.after,s.expected)); });
test('repeat must reuse each exact previously-bound instance', () => {
    const s=scenario(), repeated=structuredClone(s.after); repeated.favorites[0].tabId=33; repeated.tabs=repeated.tabs.filter(t=>t.id!==31); repeated.tabs.push(tab(33));
    assert.throws(()=>assertBatchFavoriteResult(s.after,repeated,{...s.expected,newCount:0}));
});

for (const [name, acknowledged, ended] of [['cancel failed',false,false],['ack without end',true,false],['trusted end observed',true,true]]) test(`held drag cleanup: ${name}`, async () => {
    const calls=[]; const page={_client:()=>({send:async command=>{calls.push(command); if(!acknowledged)throw Error('protocol failure');}}),
        evaluate:async()=>ended,mouse:{up:async()=>calls.push('mouse.up')}};
    await cancelHeldBookmarkDrag(page);
    assert.deepEqual(calls,ended?['Input.cancelDragging','mouse.up']:['Input.cancelDragging']);
});
test('held drag cleanup never releases when observation fails', async () => {
    let released=false; const page={_client:()=>({send:async()=>{}}),evaluate:async()=>{throw Error('closed renderer');},mouse:{up:async()=>{released=true;}}};
    await cancelHeldBookmarkDrag(page);assert.equal(released,false);
});


test('fixture cleanup preserves the primary failure and still restores independent state', async () => {
    const primary = Error('original selection failure'), calls = [], evidence = [];
    await finishBookmarkFixture([async () => { calls.push('records'); throw Error('cleanup denied'); }, async () => calls.push('restore')], primary, async item => evidence.push(item));
    assert.deepEqual(calls, ['records', 'restore']); assert.equal(primary.message, 'original selection failure');
    assert.deepEqual(primary.cleanupErrors, ['cleanup denied']); assert.equal(evidence[0].phase, 'cleanup-failed');
});
test('cleanup failure remains hard failure when behavioral assertions succeeded', async () => {
    await assert.rejects(() => finishBookmarkFixture([async () => { throw Error('cleanup failed'); }], null), /cleanup failed/);
});
test('cleanup diagnostic failure cannot erase the original failure', async () => {
    const primary = Error('input failed');
    await finishBookmarkFixture([async () => { throw Error('cleanup failed'); }], primary, async () => { throw Error('record failed'); });
    assert.equal(primary.message, 'input failed'); assert.deepEqual(primary.cleanupErrors, ['cleanup failed', 'Evidence: record failed']);
});
test('Favorite cleanup uses the actual source-window renderer and exact owned bookmark identities', async () => {
    const calls = []; globalThis.chrome = { tabs: { getCurrent: async () => ({ windowId: 10 }) }, runtime: { sendMessage: async message => {
        calls.push(message); return message.action === 'get' ? { success: true, favorites: [
            { id: 'owned', sourceBookmarkId: 'a', tabId: 42 }, { id: 'unrelated', sourceBookmarkId: 'b', tabId: 43 }
        ] } : { success: true };
    } } };
    try { assert.deepEqual(await cleanupBookmarkFavoritesInSourceWindow({ windowId: 10, ids: ['a'] }), [42]);
        assert.deepEqual(calls, [{ type: 'favoriteStore', action: 'get', windowId: 10 }, { type: 'favoriteStore', action: 'remove', windowId: 10, favoriteId: 'owned' }]);
    } finally { delete globalThis.chrome; }
});
test('Favorite cleanup rejects a different renderer window before sending any mutation', async () => {
    let sent = false; globalThis.chrome = { tabs: { getCurrent: async () => ({ windowId: 20 }) }, runtime: { sendMessage: async () => { sent = true; } } };
    try { await assert.rejects(() => cleanupBookmarkFavoritesInSourceWindow({ windowId: 10, ids: ['a'] }), /exact source window/); assert.equal(sent, false); }
    finally { delete globalThis.chrome; }
});
test('Favorite cleanup stops on an explicit rejection and does not replay', async () => {
    let calls = 0; globalThis.chrome = { tabs: { getCurrent: async () => ({ windowId: 10 }) }, runtime: { sendMessage: async () => { calls++; return { success: false, error: 'denied' }; } } };
    try { await assert.rejects(() => cleanupBookmarkFavoritesInSourceWindow({ windowId: 10, ids: ['a'] }), /denied/); assert.equal(calls, 1); }
    finally { delete globalThis.chrome; }
});


test('bookmark fixture reacquires only a proven detached-before-input row with modifiers retained', async () => {
    const calls = [], observations = []; let attempts = 0;
    const detached = Error('Node is detached from document'); detached.stack = 'Error: Node is detached from document\n    at CdpElementHandle.assertConnectedElement (api.js:1)\n    at CdpElementHandle.scrollIntoViewIfNeeded (api.js:2)';
    const page = { keyboard: { down: async key => calls.push(`down:${key}`), up: async key => calls.push(`up:${key}`) },
        waitForSelector: async selector => { assert.equal(selector, '#exact'); const attempt = ++attempts; return { click: async () => { calls.push(`click:${attempt}`); if (attempt === 1) throw detached; }, dispose: async () => {} }; } };
    await clickBookmarkFixtureRow(page, '#exact', ['Control', 'Shift'], async value => observations.push(value));
    assert.deepEqual(calls, ['down:Control', 'down:Shift', 'click:1', 'click:2', 'up:Shift', 'up:Control']);
    assert.deepEqual(observations.map(item => item.status), ['detached-before-input', 'clicked']);
});
test('bookmark fixture never retries an uncertain delivered click and releases its modifier', async () => {
    let attempts = 0; const calls = [];
    const page = { keyboard: { down: async key => calls.push(`down:${key}`), up: async key => calls.push(`up:${key}`) },
        waitForSelector: async () => { attempts++; return { click: async () => { throw Error('Input.dispatchMouseEvent timed out'); }, dispose: async () => {} }; } };
    await assert.rejects(() => clickBookmarkFixtureRow(page, '#exact', ['Shift']), /timed out/);
    assert.equal(attempts, 1); assert.deepEqual(calls, ['down:Shift', 'up:Shift']);
});


const nativeGeometry = () => ({ startCount: 1, trusted: true, selectorMatches: true, connected: true, startRect: { y: 40, height: 36 }, rect: { y: 40, height: 36 } });
test('native drag geometry is tied to the exact trusted event source', () => assertNativeDragSourceStable(nativeGeometry()));
for (const [label, mutate] of Object.entries({
    absentStart: value => value.startCount = 0, replayedStart: value => value.startCount = 2,
    synthetic: value => value.trusted = false, wrongSource: value => value.selectorMatches = false,
    removedSource: value => value.connected = false, shifted: value => value.rect.y += 16,
    resized: value => value.rect.height += 2, missingStart: value => delete value.startRect,
    missingRect: value => delete value.rect
})) test(`native drag geometry rejects ${label}`, () => { const value = nativeGeometry(); mutate(value); assert.throws(() => assertNativeDragSourceStable(value)); });


test('passive selection trace records trusted modifier evidence without dispatching input or changing selection', async () => {
    const keys = ['document', 'window', 'MutationObserver', '__pairedBookmarkSelectionTrace'];
    const originals = keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]), listeners = new Map();
    const rows = [{ dataset: { bookmarkId: 'a' } }, { dataset: { bookmarkId: 'b' } }], status = { dataset: { count: '2' } }; let mutation;
    try {
        globalThis.document = { getElementById: id => { assert.equal(id, 'bookmarkSelectionStatus'); return status; }, hasFocus: () => true, querySelectorAll: () => rows };
        globalThis.window = { addEventListener: (type, callback, options) => { assert.deepEqual(options, { capture: true, passive: true }); listeners.set(type, callback); } };
        globalThis.MutationObserver = class { constructor(callback) { mutation = callback; } observe(node) { assert.equal(node, status); } };
        installBookmarkSelectionTrace();
        listeners.get('click')({ type: 'click', isTrusted: true, shiftKey: true, target: { closest: () => rows[0] } });
        await new Promise(resolve => queueMicrotask(resolve));
        assert.deepEqual(globalThis.__pairedBookmarkSelectionTrace.map(item => item.type), ['click', 'click-microtask']);
        assert(globalThis.__pairedBookmarkSelectionTrace.every(item => item.trusted && item.shift && item.bookmarkId === 'a' && item.count === 2));
        assert.deepEqual(rows.map(item => item.dataset.bookmarkId), ['a', 'b']); assert.equal(status.dataset.count, '2');
        for (let i = 0; i < 210; i++) mutation();
        assert.equal(globalThis.__pairedBookmarkSelectionTrace.length, 200);
    } finally { for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } }
});


test('held drag diagnostics preserve exact row replacement identity and never dispatch or mutate product state', () => {
    const keys = ['document','window','getComputedStyle','__pairedBatchDragEvents','__pairedBatchDragObserved','__pairedBatchDragStartRows','__pairedBookmarkRowIdentities','__pairedBookmarkRowSerial'];
    const originals = keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis,key)]), listeners = new Map();
    const make = id => ({ tagName:'DIV',id:'',className:'tab',isConnected:true,hidden:false,dataset:{bookmarkId:id},
        parentElement:{closest:()=>null},getClientRects:()=>[{}],getBoundingClientRect:()=>({x:10,y:20,width:50,height:30}),closest:()=>null });
    let rows = [make('a'),make('b')]; const target = make('favorite'); let hits=0;
    try {
        for (const key of keys.slice(3)) delete globalThis[key];
        globalThis.getComputedStyle=()=>({display:'block',visibility:'visible'});
        globalThis.window={addEventListener:(type,callback,options)=>{assert.deepEqual(options,{capture:true,passive:true});listeners.set(type,callback);}};
        globalThis.document={querySelectorAll:()=>rows,querySelector:selector=>selector==='#source'?rows[0]:target,
            getElementById:()=>({textContent:'Source changed'}),hasFocus:()=>true,visibilityState:'visible',elementFromPoint:()=>{hits++;return target;}};
        installBookmarkDragTrace();
        listeners.get('dragstart')({type:'dragstart',isTrusted:true,target:rows[0],clientX:35,clientY:35,dataTransfer:{dropEffect:'copy'}});
        const before=readBookmarkDragState({sourceSelector:'#source',targetSelector:'#target',from:{x:10,y:20,width:50,height:30},to:{x:60,y:20,width:50,height:30}});
        rows[0]=make('a');
        const after=readBookmarkDragState({sourceSelector:'#source',targetSelector:'#target'});
        assert.equal(before.startRows[0].identity,before.rows[0].identity);
        assert.notEqual(after.rows[0].identity,before.rows[0].identity);
        assert.deepEqual(after.rows[0].dataset,before.rows[0].dataset);
        assert.equal(after.status,'Source changed');assert.equal(hits,2);
        for(let i=0;i<210;i++)listeners.get('dragover')({type:'dragover',isTrusted:true,target,clientX:i,clientY:20});
        assert.equal(globalThis.__pairedBatchDragEvents.length,200);
        assert.deepEqual(rows.map(row=>row.dataset.bookmarkId),['a','b']);
    } finally {for(const[key,descriptor]of originals){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}}
});


test('bookmark sidebar mounts only after display configuration has completed', async () => {
    const calls=[]; let release; const pending=new Promise(resolve=>{release=resolve;});
    const result=prepareBookmarkSidebar(async()=>{calls.push('configure');await pending;calls.push('configured');},async()=>{calls.push('create');return 'sidebar';},[async()=>calls.push('cleanup')]);
    await Promise.resolve();assert.deepEqual(calls,['configure']);release();
    assert.equal(await result,'sidebar');assert.deepEqual(calls,['configure','configured','create']);
});
for(const stage of ['configure','create'])test(`bookmark sidebar ${stage} failure restores settings and seed without hiding the original error`,async()=>{
    const error=Error(stage), calls=[];
    await assert.rejects(()=>prepareBookmarkSidebar(async()=>{calls.push('configure');if(stage==='configure')throw error;},async()=>{calls.push('create');throw error;},[
        async()=>{calls.push('seed cleanup');throw Error('cleanup failure');},async()=>calls.push('restore ordering')],async()=>{}),received=>received===error);
    assert.deepEqual(calls,stage==='configure'?['configure','seed cleanup','restore ordering']:['configure','create','seed cleanup','restore ordering']);
    assert.deepEqual(error.cleanupErrors,['cleanup failure']);
});


test('held bookmark drag continues inside the exact target instead of stopping at dragenter',async()=>{
    const moves=[];await moveInsideBookmarkDropTarget({mouse:{move:async(...args)=>moves.push(args)}},{x:962,y:128,width:310,height:48});
    assert.deepEqual(moves,[[965,152,{steps:18}],[970,152,{steps:2}]]);
});
test('target approach failure cannot replay pointer input or a drop',async()=>{
    let moves=0;const error=Error('uncertain pointer transport');
    await assert.rejects(()=>moveInsideBookmarkDropTarget({mouse:{move:async()=>{moves++;throw error;}}},{x:1,y:2,width:32,height:48}),received=>received===error);
    assert.equal(moves,1);
});
test('unusable target geometry refuses pointer input',async()=>{
    await assert.rejects(()=>moveInsideBookmarkDropTarget({mouse:{move:async()=>assert.fail('must not move')}},{x:1,y:2,width:10,height:48}),/interior/);
});

const mixedOutcome = () => ({ state: 'warning', message: '7 completed, 0 failed, 0 not attempted, 1 skipped. Skipped “Extension Page” (bookmark 28): Only HTTP and HTTPS links can be saved as Favorites. Source bookmarks stay in their folders.' });
test('mixed batch evidence requires visible named skip while retaining supported completion', () => {
    assertSkippedBookmarkOutcome(mixedOutcome(), { completed: 7, title: 'Extension Page', bookmarkId: '28' });
});
for (const [name, change] of Object.entries({ success: s => s.state = 'success', missingReason: s => s.message = s.message.replace('Only HTTP and HTTPS', 'Unsupported'),
    wrongCount: s => s.message = s.message.replace('7 completed', '8 completed'), wrongId: s => s.message = s.message.replace('bookmark 28', 'bookmark 29'),
    wrongTitle: s => s.message = s.message.replace('Extension Page', 'Other Page'), missingPreservation: s => s.message = s.message.replace('Source bookmarks stay in their folders.', '')
})) test(`mixed batch evidence rejects ${name}`, () => { const status = mixedOutcome(); change(status); assert.throws(() => assertSkippedBookmarkOutcome(status, { completed: 7, title: 'Extension Page', bookmarkId: '28' })); });
