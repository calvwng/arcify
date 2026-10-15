// Evidence-validator tests only; importing these modules never launches Chrome.
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertBookmarkSelection, assertBatchFavoriteResult, cancelHeldBookmarkDrag } from '../../scripts/paired-chrome-bookmark-selection.mjs';
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
