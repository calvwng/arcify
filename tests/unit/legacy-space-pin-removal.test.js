import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { removeSpacePin } from '../../space-bookmarks.js';
import { assertNotNativeSplit } from '../../native-split-safety.js';
import { Utils } from '../../utils.js';

// Execute the production drag/quick-pin caller with simulated native APIs.
const source = await readFile(new URL('../../sidebar.js', import.meta.url), 'utf8');
const body = source.slice(source.indexOf('async function moveTabToTemp('), source.indexOf('// Helper function to manage folder placeholder state'));
const makeCaller = new Function('spaces', 'removeSpacePin', 'assertNotNativeSplit', 'Utils', 'document', 'persistSpaceTabOrder', 'refreshActiveSpaceUI', `${body}; return moveTabToTemp;`);
function event() {
    const listeners = new Set();
    return { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn), emit: (...args) => [...listeners].forEach(fn => fn(...args)), listeners };
}
function fixture() {
    const nodes = [{ id: 'root', title: 'Arcify' }, { id: 'space', parentId: 'root', title: 'Space' },
        { id: 'nested', parentId: 'space', title: 'Nested' }, { id: 'pin', parentId: 'nested', title: 'Saved', url: 'https://saved.test/' },
        { id: 'twin', parentId: 'nested', title: 'Twin', url: 'https://saved.test/' }];
    const spaces = [{ id: 's', bookmarkFolderId: 'space', spaceBookmarks: [1], temporaryTabs: [] }];
    const tab = { id: 1, windowId: 10, splitViewId: -1, url: 'https://navigated.test/' }, initial = structuredClone(tab);
    const data = { pinnedTabStatesById: { 1: { bookmarkId: 'pin', pinnedUrl: 'https://saved.test/' } } }, hooks = {}, removed = [], writes = [];
    let reads = 0;
    globalThis.chrome = {
        storage: { onChanged: event(), local: { async get() { await hooks.storage?.(); return structuredClone(data); }, async set(values) {
            const old = structuredClone(data); Object.assign(data, structuredClone(values)); writes.push(structuredClone(values));
            chrome.storage.onChanged.emit(Object.fromEntries(Object.keys(values).map(key => [key, { oldValue: old[key], newValue: data[key] }])), 'local');
        } } },
        tabs: { async get() { await hooks.tab?.(++reads); return structuredClone(tab); } },
        bookmarks: { onMoved: event(), onRemoved: event(), onChanged: event(),
            async get(id) { await hooks.bookmark?.(id); return structuredClone(nodes.filter(node => node.id === id)); },
            async search() { return structuredClone(nodes.filter(node => node.id === 'root')); },
            async getChildren(id) { await hooks.children?.(id); return structuredClone(nodes.filter(node => node.parentId === id)); },
            async remove(id) { removed.push(id); nodes.splice(nodes.findIndex(node => node.id === id), 1); chrome.bookmarks.onRemoved.emit(id); await hooks.remove?.(); }
        }
    };
    const run = makeCaller(spaces, removeSpacePin, assertNotNativeSplit, Utils, { querySelector: () => null }, async () => {}, async () => {});
    const clean = () => { for (const e of [chrome.storage.onChanged, chrome.bookmarks.onMoved, chrome.bookmarks.onRemoved, chrome.bookmarks.onChanged]) assert.equal(e.listeners.size, 0); };
    return { nodes, spaces, tab, initial, data, hooks, removed, writes, clean, run: () => run(spaces[0], initial) };
}

for (const target of ['pin', 'nested', 'space']) for (const boundary of ['binding', 'tree', 'native']) test(`legacy unpin preserves moved ${target} during ${boundary} read`, async () => {
    const f = fixture(); let changed = false;
    const move = () => { if (changed) return; changed = true; const node = f.nodes.find(n => n.id === target); const oldParentId = node.parentId; node.parentId = 'outside'; chrome.bookmarks.onMoved.emit(target, { oldParentId, parentId: 'outside' }); };
    if (boundary === 'binding') f.hooks.storage = move;
    if (boundary === 'tree') f.hooks.children = move;
    if (boundary === 'native') f.hooks.tab = count => { if (count === 2) move(); };
    await assert.rejects(f.run(), /changed|no longer inside/);
    assert.deepEqual(f.removed, []); assert.deepEqual(f.writes, []); f.clean();
});
for (const change of ['away-back', 'deleted', 'binding', 'ownership', 'window', 'split', 'folder-identity', 'space-replaced']) test(`legacy final native guard rejects ${change}`, async () => {
    const f = fixture();
    f.hooks.tab = count => {
        if (count !== 2) return;
        if (change === 'away-back') { chrome.bookmarks.onMoved.emit('pin'); chrome.bookmarks.onMoved.emit('pin'); }
        if (change === 'deleted') { f.nodes.splice(f.nodes.findIndex(n => n.id === 'pin'), 1); chrome.bookmarks.onRemoved.emit('pin'); }
        if (change === 'binding') { const oldValue = structuredClone(f.data.pinnedTabStatesById); f.data.pinnedTabStatesById[1].bookmarkId = 'twin'; chrome.storage.onChanged.emit({ pinnedTabStatesById: { oldValue, newValue: f.data.pinnedTabStatesById } }, 'local'); }
        if (change === 'ownership') { f.spaces[0].spaceBookmarks = []; f.spaces[0].temporaryTabs = [1]; }
        if (change === 'window') f.tab.windowId = 20;
        if (change === 'split') f.tab.splitViewId = 2;
        if (change === 'folder-identity') f.spaces[0].bookmarkFolderId = 'replacement';
        if (change === 'space-replaced') f.spaces[0] = structuredClone(f.spaces[0]);
    };
    await assert.rejects(f.run(), /changed|Split/); assert.deepEqual(f.removed, []); assert.deepEqual(f.writes, []); f.clean();
});
test('missing backing folder refuses before bookmark removal', async () => {
    const f = fixture(); f.nodes.splice(f.nodes.findIndex(n => n.id === 'space'), 1);
    await assert.rejects(f.run(), /unavailable/); assert.deepEqual(f.removed, []); f.clean();
});
test('successful legacy unpin accepts own removal event, keeps URL twin, clears binding and moves live tab to Today', async () => {
    const f = fixture(); await f.run(); assert.deepEqual(f.removed, ['pin']); assert(f.nodes.some(n => n.id === 'twin'));
    assert.deepEqual(f.data.pinnedTabStatesById, {}); assert.deepEqual(f.spaces[0].spaceBookmarks, []); assert.deepEqual(f.spaces[0].temporaryTabs, [1]); f.clean();
});
test('post-delete Split is partial and never recreates or demotes the saved tab', async () => {
    const f = fixture(); f.hooks.remove = () => { f.tab.splitViewId = 2; };
    await assert.rejects(f.run(), error => error.bookmarkRemoved === true && /Nothing was retried/.test(error.message));
    assert.deepEqual(f.removed, ['pin']); assert.deepEqual(f.spaces[0].spaceBookmarks, [1]); assert.equal(f.data.pinnedTabStatesById[1].bookmarkId, 'pin'); f.clean();
});
test('uncertain bookmark removal reports uncertainty without retry or live-state writes', async () => {
    const f = fixture(); f.hooks.remove = () => { throw new Error('Response lost'); };
    await assert.rejects(f.run(), error => error.code === 'UNCERTAIN_RESULT' && /Nothing was retried/.test(error.message));
    assert.deepEqual(f.removed, ['pin']); assert.deepEqual(f.writes, []); f.clean();
});
test('missing bookmark event capability refuses all destructive work', async () => {
    const f = fixture(); delete chrome.bookmarks.onMoved;
    await assert.rejects(f.run(), /observation is unavailable/); assert.deepEqual(f.removed, []);
});
