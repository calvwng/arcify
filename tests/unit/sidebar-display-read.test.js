import test from 'node:test';
import assert from 'node:assert/strict';
import { observeDisplayChanges, readRowDisplayMetadata } from '../../sidebar-display-read.js';
import { loadFolderStates, saveFolderCollapsed } from '../../folder-state.js';
import { Utils } from '../../utils.js';

const event = () => { const callbacks = []; return { addListener: fn => callbacks.push(fn), emit: (...args) => callbacks.forEach(fn => fn(...args)) }; };
test('display observations fence native, bookmark and relevant storage events, without writes or actions', async () => {
    const api = { tabs: {}, bookmarks: {}, storage: { onChanged: event() } };
    for (const name of ['onCreated', 'onUpdated', 'onRemoved', 'onAttached', 'onDetached', 'onMoved', 'onReplaced', 'onActivated']) api.tabs[name] = event();
    for (const name of ['onCreated', 'onChanged', 'onMoved', 'onRemoved', 'onChildrenReordered', 'onImportEnded']) api.bookmarks[name] = event();
    const fence = observeDisplayChanges(api);
    for (const object of [api.tabs, api.bookmarks]) for (const item of Object.values(object)) {
        const current = fence.capture(); assert(current()); item.emit(); assert(!current()); assert(fence.capture()());
    }
    for (const [area, key] of [['local', 'spaces'], ['local', 'pinnedTabStatesById'], ['local', 'tabNameOverridesById'],
        ['local', 'folderCollapsed:a'], ['session', 'favoriteSession'], ['session', 'activeSpaces'], ['sync', 'invertTabOrder']]) {
        const current = fence.capture(); api.storage.onChanged.emit({ [key]: {} }, area); assert(!current());
    }
    const current = fence.capture(); api.storage.onChanged.emit({ irrelevantCache: {} }, 'local'); assert(current());
});

test('one metadata read handles missing maps and does not expose a mutation helper', async () => {
    const requests = [];
    globalThis.chrome = { storage: { local: { async get(keys) { requests.push(keys); return {}; } } } };
    assert.deepEqual(await readRowDisplayMetadata(), { pinnedStatesById: {}, overrides: {} });
    assert.deepEqual(requests, [['pinnedTabStatesById', 'tabNameOverridesById']]);
});

test('nested folder display batch waits for pending toggles and preserves independent defaults', async () => {
    let release; const held = new Promise(resolve => { release = resolve; });
    const data = {}, reads = [];
    globalThis.chrome = { storage: { local: {
        async get(keys) { reads.push(keys); return { ...data }; },
        async set(value) { await held; Object.assign(data, value); }
    } } };
    const write = saveFolderCollapsed('a', false);
    const read = loadFolderStates({ children: [{ id: 'a', children: [{ id: 'b', children: [] }, { id: 'link', url: 'https://test.invalid/' }] }] });
    await Promise.resolve(); assert.equal(reads.length, 0); release(); await write;
    assert.deepEqual([...await read], [['a', false], ['b', true]]);
    assert.deepEqual(reads, [['folderCollapsed:a', 'folderCollapsed:b']]);
    assert.deepEqual([...await loadFolderStates(null)], []); assert.equal(reads.length, 1);
});

function utilityFixture() {
    const data = { pinnedTabStatesById: {}, tabNameOverridesById: {} }, writes = [], locks = [];
    globalThis.chrome = { storage: { local: {
        async get(key) { return { [key]: structuredClone(data[key]) }; },
        async set(value) { writes.push(structuredClone(value)); Object.assign(data, structuredClone(value)); }
    } } };
    const utils = { ...Utils, _pinnedStateChain: Promise.resolve(), _tabNameChain: Promise.resolve() };
    return { data, writes, locks, utils };
}

test('same values skip writes after a fresh locked read; concurrent different entries survive', async () => {
    const { data, writes, utils } = utilityFixture();
    await Promise.all(Array.from({ length: 10 }, () => utils.setTabNameOverride(1, 'https://one.test/path', 'One')));
    assert.equal(writes.length, 1);
    await Promise.all([utils.setTabNameOverride(1, 'https://one.test/path', 'New'), utils.setTabNameOverride(2, 'https://two.test/', 'Two')]);
    assert.deepEqual(data.tabNameOverridesById, { 1: { name: 'New', originalDomain: 'one.test' }, 2: { name: 'Two', originalDomain: 'two.test' } });
    const binding = { bookmarkId: 'pin', pinnedUrl: 'https://one.test/' };
    await Promise.all(Array.from({ length: 10 }, () => utils.setPinnedTabState(1, binding)));
    assert.equal(writes.length, 4);
    await Promise.all([utils.setPinnedTabState(1, { ...binding, pinnedUrl: 'https://changed.test/' }), utils.setPinnedTabState(2, { bookmarkId: 'other' })]);
    assert.equal(data.pinnedTabStatesById[1].pinnedUrl, 'https://changed.test/');
    assert.deepEqual(data.pinnedTabStatesById[2], { bookmarkId: 'other', pinnedUrl: null });
});

test('a no-op still runs guard after waiting and rejects changed ownership', async () => {
    const { data, writes, utils } = utilityFixture();
    const binding = { bookmarkId: 'pin', pinnedUrl: 'https://one.test/' };
    data.pinnedTabStatesById[1] = binding;
    let calls = 0;
    await assert.rejects(utils.setPinnedTabState(1, binding, { beforeWrite: async () => { calls++; throw Error('Native identity changed'); } }), /identity changed/);
    assert.equal(calls, 1); assert.equal(writes.length, 0);
    await assert.rejects(utils.setPinnedTabState(1, { ...binding, bookmarkId: 'other' }, { onlyIfUnboundOrMatching: true }), /different bookmark/);
    await utils.setPinnedTabState(1, binding, { beforeWrite: async () => { calls++; } });
    assert.equal(calls, 2); assert.equal(writes.length, 0);
});

test('no-op decision follows queue acquisition rather than an earlier display observation', async () => {
    const { data, writes, utils } = utilityFixture();
    let release; utils._pinnedStateChain = new Promise(resolve => { release = resolve; });
    const binding = { bookmarkId: 'pin', pinnedUrl: 'https://one.test/' };
    data.pinnedTabStatesById[1] = binding;
    const run = utils.setPinnedTabState(1, binding, { onlyIfUnboundOrMatching: true });
    data.pinnedTabStatesById[1] = { ...binding, bookmarkId: 'replacement' }; release();
    await assert.rejects(run, /different bookmark/); assert.equal(writes.length, 0);
});

test('failed reads and changed-value writes reject without wedging future operations', async () => {
    const { data, writes, utils } = utilityFixture();
    const read = chrome.storage.local.get, write = chrome.storage.local.set;
    chrome.storage.local.get = async () => { throw Error('Read failed'); };
    await assert.rejects(utils.setTabNameOverride(1, 'https://one.test/', 'One'), /Read failed/);
    chrome.storage.local.get = read;
    chrome.storage.local.set = async () => { throw Error('Write failed'); };
    await assert.rejects(utils.setPinnedTabState(1, { bookmarkId: 'pin' }), /Write failed/);
    chrome.storage.local.set = write;
    await utils.setTabNameOverride(1, 'https://one.test/', 'One'); await utils.setPinnedTabState(1, { bookmarkId: 'pin' });
    assert.equal(writes.length, 2); assert.equal(data.pinnedTabStatesById[1].bookmarkId, 'pin');
});
