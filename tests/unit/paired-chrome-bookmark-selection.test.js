// Evidence-validator tests only; importing these modules never launches Chrome.
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertBookmarkSelection, assertBatchFavoriteResult, cancelHeldBookmarkDrag, finishBookmarkFixture, cleanupBookmarkFavoritesInSourceWindow, clickBookmarkFixtureRow, assertNativeDragSourceStable } from '../../scripts/paired-chrome-bookmark-selection.mjs';
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
