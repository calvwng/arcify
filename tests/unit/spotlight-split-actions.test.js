import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture as baseFixture, success, error } from './spotlight-action-fixture.js';
import { SPLIT_ACTIONS_FEATURE, PEER_KEY, PAIRING_GENERATION_KEY, isSplitActionContext, isSpaceActionContext, sameSplitValue, validateRequest } from '../../spotlight-bridge-protocol.js';
import { safeLive } from '../../spotlight-space-actions.js';
const clone = value => structuredClone(value);
const event = () => { const set = new Set(); return { addListener: fn => set.add(fn), removeListener: fn => set.delete(fn), emit: (...args) => { for (const fn of set) fn(...args); }, get size() { return set.size; } }; };
function fixture({ adjacent = false, source = 1 } = {}) {
    const f = baseFixture();
    f.windows.forEach(window => { window.focused = window.id === 10; });
    for (const tab of f.tabs) Object.assign(tab, { pinned: false, groupId: -1, splitViewId: -1, status: 'complete' });
    delete f.local.tabNameOverridesById[3];
    f.tabs.find(tab => tab.id === 2).index = 4;
    f.tabs.find(tab => tab.id === 3).index = adjacent ? 1 : 3;
    f.tabs.push(...[4, 5].map((id, offset) => ({ id, windowId: 10, index: (adjacent ? 2 : 1) + offset, active: false, title: `Unrelated ${id}`, url: `https://unrelated.test/${id}`, pinned: false, groupId: -1, splitViewId: 66, status: 'complete' })));
    f.store.spaces[0].temporaryTabs = adjacent ? [1, 3, 4, 5] : [1, 4, 5, 3];
    f.active(source);
    chrome.tabs.onMoved = event(); chrome.tabs.onCreated = event();
    chrome.windows.onRemoved = event();
    chrome.tabs.move = async (id, { index }) => {
        f.effects.push(['move', id, index]); await f.hooks.beforeMove?.();
        const tab = f.tabs.find(tab => tab.id === id), fromIndex = tab.index;
        const list = f.tabs.filter(tab => tab.windowId === 10 && tab.id !== id).sort((a, b) => a.index - b.index);
        list.splice(index, 0, tab); list.forEach((tab, index) => { tab.index = index; });
        chrome.tabs.onMoved.emit(id, f.hooks.moveInfo?.({ windowId: 10, fromIndex, toIndex: index }) || { windowId: 10, fromIndex, toIndex: index });
        await f.hooks.afterMove?.(); return clone(tab);
    };
    chrome.tabs.createSplit = async ids => {
        f.effects.push(['split', clone(ids)]); await f.hooks.beforeSplit?.();
        for (const id of ids) { const tab = f.tabs.find(tab => tab.id === id); tab.splitViewId = 77; chrome.tabs.onUpdated.emit(id, { splitViewId: 77 }, clone(tab)); }
        await f.hooks.afterSplit?.(); return f.hooks.splitResult ?? 77;
    };
    chrome.tabs.unsplit = async id => {
        f.effects.push(['unsplit', id]);
        for (const tab of f.tabs.filter(tab => tab.splitViewId === id)) { tab.splitViewId = -1; chrome.tabs.onUpdated.emit(tab.id, { splitViewId: -1 }, clone(tab)); }
        await f.hooks.afterEnd?.();
    };
    const request = (command, payload = {}) => ({ ...f.request(command, payload), supportedFeatures: [SPLIT_ACTIONS_FEATURE] });
    const send = (command, payload) => f.handle(request(command, payload), f.sender);
    const capture = async (id = source) => success(await send('splitActionContext', { tabId: id }));
    const create = async (view, target = view.splitTargets[0]) => send('createSplitView', { context: view.splitActionContext, target });
    const end = view => send('endSplitView', { context: view.splitActionContext });
    return { ...f, request, send, capture, create, end };
}
for (const source of [1, 3]) for (const adjacent of [false, true]) test(`create/end from exact ${source === 1 ? 'left' : 'right'} source; adjacent=${adjacent}`, async () => {
    const f = fixture({ source, adjacent }), before = clone(f.tabs), view = await f.capture();
    assert.deepEqual(view.splitTargets.map(tab => tab.id), [source === 1 ? 3 : 1]);
    const result = success(await f.create(view)).splitResult;
    assert.deepEqual(result, { action: 'create', windowId: 10, spaceId: 'space', sourceTabId: source, tabIds: [1, 3], splitViewId: 77, reordered: !adjacent });
    assert.equal(f.tabs.find(tab => tab.active && tab.windowId === 10).id, source);
    assert.deepEqual(f.tabs.find(tab => tab.id === 9), before.find(tab => tab.id === 9));
    assert.deepEqual(f.tabs.map(({ index, splitViewId, ...tab }) => tab), before.map(({ index, splitViewId, ...tab }) => tab));
    assert.deepEqual(f.writes().filter(([type]) => type === 'persist').map(([, options]) => options), adjacent ? [] : [{ skipGroupSync: true }]);
    const split = await f.capture(); assert.equal(split.splitTargets.length, 0); assert.deepEqual(split.splitActionContext.pair.map(tab => tab.id), [1, 3]);
    assert.equal(safeLive(f.store, f.tabs.find(tab => tab.id === source)), false);
    assert.equal(isSpaceActionContext(split.splitActionContext), false);
    assert.deepEqual(success(await f.end(split)).splitResult, { ...result, action: 'end', reordered: false, splitViewId: -1 });
    assert.equal(f.tabs.find(tab => tab.active && tab.windowId === 10).id, source);
});
for (const missing of ['createSplit', 'unsplit']) test(`capability needs actual ${missing}`, async () => {
    const f = fixture(); delete chrome.tabs[missing];
    assert(!success(await f.send('hello')).capabilities.includes(SPLIT_ACTIONS_FEATURE));
    error(await f.send('splitActionContext', { tabId: 1 }), 'UNSUPPORTED_FEATURE'); assert.deepEqual(f.writes(), []);
});
for (const reason of ['saved', 'favorite', 'native-pin', 'helper', 'newtab', 'pending', 'loading', 'provisional', 'recovery', 'duplicate-owner', 'different-group']) test(`context excludes ${reason}`, async () => {
    const f = fixture(), target = f.tabs.find(tab => tab.id === 3);
    if (reason === 'saved') f.local.pinnedTabStatesById[3] = { bookmarkId: 'pin' };
    if (reason === 'favorite') f.globalTabs.add(3);
    if (reason === 'native-pin') target.pinned = true;
    if (reason === 'helper') target.url = 'chrome-extension://test/startup-launcher.html';
    if (reason === 'newtab') target.url = 'chrome://newtab/';
    if (reason === 'pending') target.pendingUrl = target.url;
    if (reason === 'loading') target.status = 'loading';
    if (reason === 'provisional') f.store.provisional.add(3);
    if (reason === 'recovery') f.store.recoveryCandidates.add(3);
    if (reason === 'duplicate-owner') f.store.spaces[0].spaceBookmarks.push(3);
    if (reason === 'different-group') target.groupId = 3;
    assert.deepEqual((await f.capture()).splitTargets, []); assert.deepEqual(f.writes(), []);
});
for (const phase of ['windowGet', 'bookmarkSearch', 'tabQuery', 'storageGet']) for (const change of ['source', 'target', 'pairing-aba', 'space-aba']) test(`reject ${change} during ${phase} before native mutation`, async () => {
    const f = fixture(), view = await f.capture(); let done = false;
    f.hooks[phase] = () => {
        if (done) return; done = true;
        if (change === 'source') { f.active(3); chrome.tabs.onActivated.emit({ tabId: 3, windowId: 10 }); }
        if (change === 'target') { f.tabs.find(tab => tab.id === 3).title = 'Changed'; chrome.tabs.onUpdated.emit(3, { title: 'Changed' }); }
        if (change === 'pairing-aba') { chrome.storage.onChanged.emit({ [PEER_KEY]: { oldValue: f.local[PEER_KEY], newValue: null } }, 'local'); }
        if (change === 'space-aba') { chrome.storage.onChanged.emit({ activeSpaces: { oldValue: { 10: 'space' }, newValue: { 10: 'other' } } }, 'session'); }
    };
    // The first bridge pairing/storage read can precede the continuous split
    // fence; the persisted generation remains a separate source of authority.
    if (phase === 'storageGet' && change.endsWith('aba')) f.hooks.storageGet = (area, key) => {
        if (key !== 'pinnedTabStatesById' || done) return; done = true;
        chrome.storage.onChanged.emit(change === 'pairing-aba' ? { [PEER_KEY]: { oldValue: f.local[PEER_KEY], newValue: null } }
            : { spaces: { oldValue: [], newValue: ['changed'] } }, 'local');
    };
    error(await f.create(view)); assert(!f.writes().some(([kind]) => ['move', 'split', 'unsplit', 'persist'].includes(kind)));
});
for (const reason of ['source-focus', 'target-title', 'group', 'other-order', 'pairing', 'lost-reply']) test(`after adjacency ${reason} reports partial with no split/retry`, async () => {
    const f = fixture(), view = await f.capture();
    f.hooks.afterMove = () => {
        if (reason === 'source-focus') { f.active(3); chrome.tabs.onActivated.emit({ tabId: 3, windowId: 10 }); }
        if (reason === 'target-title') f.tabs.find(tab => tab.id === 3).title = 'Changed';
        if (reason === 'group') f.tabs.find(tab => tab.id === 3).groupId = 2;
        if (reason === 'other-order') f.tabs.find(tab => tab.id === 2).index = 8;
        if (reason === 'pairing') f.local[PAIRING_GENERATION_KEY] = 'new';
        if (reason === 'lost-reply') throw new Error('lost reply');
    };
    const result = await f.create(view); error(result); assert.match(result.error.code, /PARTIAL_COMMIT|UNCERTAIN_RESULT/);
    assert.equal(f.writes().filter(([kind]) => kind === 'move').length, 1); assert(!f.writes().some(([kind]) => kind === 'split'));
});
test('persistence callback rechecks source and pairing before every store write', async () => {
    const f = fixture(), view = await f.capture();
    f.hooks.persist = () => { f.active(3); chrome.tabs.onActivated.emit({ windowId: 10, tabId: 3 }); };
    error(await f.create(view), 'PARTIAL_COMMIT'); assert.deepEqual(f.writes(), [['move', 3, 1]]);
});
for (const reason of ['extra-member', 'wrong-partner', 'nonadjacent', 'same-url-twin']) test(`end exact pair rejects ${reason}`, async () => {
    const f = fixture({ adjacent: true }); f.tabs.filter(tab => [1, 3].includes(tab.id)).forEach(tab => { tab.splitViewId = 77; });
    const view = await f.capture();
    if (reason === 'extra-member') f.tabs.find(tab => tab.id === 2).splitViewId = 77;
    if (reason === 'wrong-partner') f.tabs.find(tab => tab.id === 3).splitViewId = 78;
    if (reason === 'nonadjacent') f.tabs.find(tab => tab.id === 3).index = 8;
    if (reason === 'same-url-twin') { f.tabs.find(tab => tab.id === 3).splitViewId = -1; f.tabs.find(tab => tab.id === 2).splitViewId = 77; }
    error(await f.end(view)); assert.deepEqual(f.writes(), []);
});
test('journal persists unknown outcome across worker reload with no replay', async () => {
    const f = fixture({ adjacent: true }), view = await f.capture();
    f.hooks.afterSplit = () => { throw new Error('lost native reply'); };
    const request = f.request('createSplitView', { context: view.splitActionContext, target: view.splitTargets[0] });
    error(await f.handle(request, f.sender), 'UNCERTAIN_RESULT');
    const { createSpotlightBridge } = await import('../../spotlight-bridge.js');
    error(await createSpotlightBridge(f.store)(request, f.sender), 'UNCERTAIN_RESULT');
    assert.equal(f.writes().filter(([kind]) => kind === 'split').length, 1);
});
test('native source focus change after split fails exact receipt without focus compensation', async () => {
    const f = fixture({ adjacent: true, source: 3 }), view = await f.capture(); f.hooks.afterSplit = () => f.active(1);
    error(await f.create(view), 'PARTIAL_COMMIT'); assert(!f.effects.some(([kind]) => kind.includes('forbidden')));
});
test('native event/API split ID mismatch is uncertain and cannot return successful receipt', async () => {
    const f = fixture({ adjacent: true }), view = await f.capture(); f.hooks.splitResult = 88;
    error(await f.create(view)); assert.equal(f.writes().filter(([kind]) => kind === 'split').length, 1);
});
test('strict protocol validates exact descriptors and preserves older context schemas', async () => {
    const f = fixture(), view = await f.capture(), context = view.splitActionContext, target = view.splitTargets[0];
    assert(isSplitActionContext(context));
    for (const patch of [{ extra: true }, { tab: { ...context.tab, pinned: true } }, { pair: [target] }, { sourceTabId: 3 }]) assert.equal(Boolean(isSplitActionContext({ ...context, ...patch })), false);
    for (const patch of [{ target: { ...target, extra: true } }, { target: context.tab }, { target: { ...target, groupId: 8 } }, { context: { ...context, pair: [target] } }])
        assert.throws(() => validateRequest({ ...f.request('createSplitView', { context, target }), ...patch }, ['createSplitView']));
});

test('split identity zero is a valid exact native two-member End Split context', async () => {
    const f = fixture({ adjacent: true }); f.tabs.filter(tab => [1, 3].includes(tab.id)).forEach(tab => { tab.splitViewId = 0; });
    const view = await f.capture(); assert.equal(view.splitActionContext.tab.splitViewId, 0);
    assert.equal(success(await f.end(view)).splitResult.splitViewId, -1);
    assert.deepEqual(f.writes(), [['unsplit', 0]]);
});

for (const keys of [['fromIndex', 'toIndex', 'windowId'], ['toIndex', 'windowId', 'fromIndex']]) test(`own native move accepts API fields independent of enumeration order ${keys.join(',')}`, async () => {
    const f = fixture(), view = await f.capture();
    f.hooks.moveInfo = info => Object.fromEntries(keys.map(key => [key, info[key]]));
    assert.equal(success(await f.create(view)).splitResult.reordered, true);
    assert.deepEqual(f.writes().map(([kind]) => kind).filter(kind => kind !== 'storage'), ['move', 'persist', 'split']);
});
for (const patch of [{ extra: true }, { windowId: 11 }, { fromIndex: 2 }, { toIndex: 2 }]) test(`unrelated native movement is not an own-mutation allowance ${JSON.stringify(patch)}`, async () => {
    const f = fixture(), view = await f.capture();
    f.hooks.moveInfo = info => ({ ...info, ...patch });
    error(await f.create(view), 'PARTIAL_COMMIT'); assert.deepEqual(f.writes(), [['move', 3, 1]]);
});

const sortedKeys = value => Array.isArray(value) ? value.map(sortedKeys) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sortedKeys(value[key])])) : value;
test('own persisted storage values and create/end wire descriptors accept permuted object fields', async () => {
    const f = fixture(), view = await f.capture(), emit = chrome.storage.onChanged.emit;
    chrome.storage.onChanged.emit = (changes, area) => emit(sortedKeys(changes), area);
    const created = success(await f.create(sortedKeys(view))).splitResult;
    assert.equal(created.reordered, true);
    const split = await f.capture();
    split.splitActionContext.tab = sortedKeys(split.splitActionContext.tab);
    assert(isSplitActionContext(split.splitActionContext));
    assert.equal(success(await f.end(sortedKeys(split))).splitResult.action, 'end');
    assert.deepEqual(f.writes().map(([kind]) => kind).filter(kind => kind !== 'storage'), ['move', 'persist', 'split', 'unsplit']);
});
test('structural Split equality keeps exact keys, primitive types and array order', () => {
    assert(sameSplitValue({ a: [{ x: 1, y: 'two' }], b: null }, { b: null, a: [{ y: 'two', x: 1 }] }));
    for (const [left, right] of [[[1, 2], [2, 1]], [[1], { 0: 1 }], [{ x: 1 }, { x: '1' }], [{ x: 1 }, { x: 1, extra: undefined }], [[1], [1, undefined]], [null, {}]]) assert.equal(sameSplitValue(left, right), false);
});
test('changed storage array order is never allowed as an own persistence event', async () => {
    const f = fixture(), view = await f.capture(), emit = chrome.storage.onChanged.emit;
    chrome.storage.onChanged.emit = (changes, area) => {
        if (changes.spaces) changes.spaces.newValue[0].temporaryTabs.reverse();
        emit(changes, area);
    };
    error(await f.create(view), 'PARTIAL_COMMIT');
    assert.deepEqual(f.writes().map(([kind]) => kind).filter(kind => kind !== 'storage'), ['move']);
});
