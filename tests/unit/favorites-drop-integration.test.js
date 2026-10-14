import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseHTML } from 'linkedom';
import { enqueueBookmarkOperation } from '../../bookmark-writer.js';
import { applySpacePatch } from '../../space-store.js';

// Import and initialize the real sidebar and all its modules against a DOM.
// Only browser facilities and persisted fixtures are substituted; no source
// extraction or replacement implementation of the event/render paths is used.
const { window } = parseHTML(await readFile(new URL('../../sidebar.html', import.meta.url), 'utf8'));
const { document } = window;
window.innerHeight = 800; window.innerWidth = 300;
window.HTMLElement.prototype.getBoundingClientRect = function () { return this._rect || { top: 10, bottom: this.classList.contains('space-content') ? 700 : 40, left: 0, right: 280, width: 280, height: this.classList.contains('space-content') ? 690 : 30 }; };
window.HTMLElement.prototype.scrollTo = () => {};
// LinkeDOM exposes the select getter but does not implement browser assignment.
Object.defineProperty(window.HTMLSelectElement.prototype, 'value', {
    get() { return this.querySelector('option[selected]')?.value || ''; },
    set(value) { for (const option of this.querySelectorAll('option')) option.toggleAttribute('selected', option.value === value); }
});
const listeners = () => {
    const callbacks = [];
    return { callbacks, addListener(callback) { callbacks.push(callback); },
        async emit(...args) { await Promise.all(callbacks.map(callback => callback(...args))); } };
};
const onChanged = listeners();
const tabs = [1, 2, 3].map(id => ({ id, windowId: 10, active: id === 2, pinned: false, title: `Tab ${id}`, url: `https://tab-${id}.test/` }));
let storedSpaces;
const local = { tabGroupImportDismissed: true };
const settings = { invertTabOrder: false, syncTabGroups: false, showAllOpenTabsInCollapsedFolders: true };
const session = { activeSpaces: { 10: 'alpha' } };
let tree, writes = [], alerts = [], nextId = 100, effects = [], hooks = {};
let startupPinRace = true;
const bookmark = (id, tabId = null) => ({ id, title: id, url: tabId ? tabs[tabId - 1].url : `https://${id}.test/` });
function resetData() {
    tabs.splice(0, tabs.length, ...[1, 2, 3].map(id => ({ id, windowId: 10, active: id === 2, pinned: false, index: id - 1, title: `Tab ${id}`, url: `https://tab-${id}.test/` })));
    session.activeSpaces = { 10: 'alpha' }; session.favoriteDropAttempts = {};
    effects = []; hooks = {}; nextId = 100;
    tree = { id: 'root', title: 'Arcify', children: [{ id: 'p', title: 'Alpha', children: [
        bookmark('a', 1), { id: 'f', title: 'Folder', children: [bookmark('b', 2), bookmark('closed')] },
        { id: 'g', title: 'Empty', children: [] }, bookmark('c')
    ] }] };
    storedSpaces = [{ id: 'alpha', name: 'Alpha', color: 'blue', bookmarkFolderId: 'p', spaceBookmarks: [1, 2], temporaryTabs: [3] }];
    Object.assign(local, { spaces: storedSpaces, pinnedTabStatesById: { 1: { bookmarkId: 'a', pinnedUrl: tabs[0].url }, 2: { bookmarkId: 'b', pinnedUrl: tabs[1].url } },
        'folderCollapsed:f': true, 'folderCollapsed:g': true });
    writes = []; alerts = [];
}
resetData();
function nodes(node = tree, parentId = null) { return [{ ...node, parentId }, ...(node.children || []).flatMap(child => nodes(child, node.id))]; }
function getNode(id, node = tree) { return node.id === id ? node : (node.children || []).map(child => getNode(id, child)).find(Boolean); }
const ids = parent => getNode(parent).children.map(node => node.id);
const allIds = () => nodes().map(node => node.id).sort();
const area = state => ({ async get(keys) {
    if (typeof keys === 'string') return { [keys]: structuredClone(state[keys]) };
    return structuredClone({ ...(Array.isArray(keys) ? {} : keys), ...state });
}, async set(next) { if (state === local && next.pinnedTabStatesById) await hooks.bindingSet?.(); Object.assign(state, structuredClone(next)); }, async remove() {} });
const onActivated = listeners();

const lockQueues = new Map();
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request(key, callback) {
    const run = (lockQueues.get(key) || Promise.resolve()).then(callback); lockQueues.set(key, run.catch(() => {})); return run;
} } } });
globalThis.window = window;
globalThis.document = document;
globalThis.Event = window.Event;
globalThis.Node = window.Node;
globalThis.alert = message => alerts.push(message);
globalThis.localStorage = { getItem() { return null; }, setItem() {} };
globalThis.getComputedStyle = () => ({ getPropertyValue() { return ''; } });
globalThis.matchMedia = () => ({ matches: true, addEventListener() {} });
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.MutationObserver = window.MutationObserver;
globalThis.chrome = {
    runtime: { onMessage: listeners(), getURL: path => `chrome-extension://fixture/${path}`, getManifest: () => ({ version: 'test' }),
        async sendMessage(message) {
            if (message.type === 'sidebarTour') return { success: true, state: null };
            if (message.type === 'bookmarkOrder') {
                try { return { success: true, ...await enqueueBookmarkOperation(message.operation) }; }
                catch (error) { return { success: false, error: error.message, code: error.code }; }
            }
            assert.equal(message.type, 'spaceStore');
            if (message.action === 'get') { const result = structuredClone(storedSpaces); return { success: true, spaces: result }; }
            if (message.action === 'patch') storedSpaces = applySpacePatch(storedSpaces, message.before, message.after);
            if (message.action === 'activate') session.activeSpaces[message.windowId] = message.spaceId;
            return { success: true, spaces: structuredClone(storedSpaces) };
        } },
    storage: { onChanged, local: area(local), sync: area(settings), session: area(session) },
    windows: { async get(id) { if (id !== 10) throw new Error('Window missing'); return { id }; }, getCurrent(_options, callback) { if (callback) callback({ id: 10 }); return Promise.resolve({ id: 10 }); } },
    tabs: { onActivated, ...Object.fromEntries(['onCreated', 'onUpdated', 'onRemoved', 'onAttached', 'onDetached', 'onMoved'].map(name => [name, listeners()])),
        async query(query) { return structuredClone(tabs.filter(tab => (!query.windowId || tab.windowId === query.windowId) && (!query.active || tab.active) && (query.pinned === undefined || query.pinned === tab.pinned))); },
        async get(id) { await hooks.tabGet?.(id); const tab = tabs.find(tab => tab.id === id); if (!tab) throw new Error('Tab closed'); return structuredClone(tab); },
        async create(properties) { effects.push(['create', properties]); await hooks.create?.(); const tab = { id: nextId++, title: 'Created', index: 0, ...properties }; tabs.push(tab); await chrome.tabs.onCreated.emit(structuredClone(tab)); return structuredClone(tab); },
        async update(id, properties) { const tab = tabs.find(tab => tab.id === id); if (!tab) throw new Error('Tab closed'); Object.assign(tab, properties); effects.push(['update', id, properties]); await chrome.tabs.onUpdated.emit(id, properties, structuredClone(tab)); return structuredClone(tab); },
        async move(id, properties) { await hooks.move?.(); const tab = tabs.find(tab => tab.id === id); Object.assign(tab, properties); effects.push(['move', id, properties]); return structuredClone(tab); },
        async remove() { assert.fail('Favorites never closes a user tab'); } },
    bookmarks: { async get(id) { return structuredClone(nodes().filter(node => node.id === id)); },
        async search({ title }) { return structuredClone(nodes().filter(node => node.title === title)); },
        async getChildren(id) { if (startupPinRace && id === 'p') { startupPinRace = false; tabs[0].pinned = true; } return structuredClone((getNode(id)?.children || []).map(node => ({ ...node, parentId: id }))); },
        async move(id, { parentId, index }) {
            const node = getNode(id), parent = nodes().find(item => item.children?.some(child => child.id === id));
            if (!node || !parent) throw new Error('Missing bookmark');
            const oldParent = getNode(parent.id);
            oldParent.children.splice(oldParent.children.findIndex(child => child.id === id), 1);
            getNode(parentId).children.splice(index, 0, node);
            writes.push({ kind: 'move', id, parentId, index });
            return structuredClone(node);
        },
        async create(data) { const node = { ...data, id: `created-${nextId++}` }; getNode(data.parentId).children.splice(data.index, 0, node); writes.push({ kind: 'create', id: node.id }); return structuredClone(node); },
        async remove(id) { const parent = nodes().find(item => item.children?.some(child => child.id === id)); getNode(parent.id).children.splice(getNode(parent.id).children.findIndex(child => child.id === id), 1); writes.push({ kind: 'remove', id }); }
    },
    tabGroups: { async query() { return []; } }
};
// Capture the asynchronous DOMContentLoaded callback so initialization failures
// fail this test instead of being lost in event dispatch.
const domReady = [];
const originalAddListener = document.addEventListener.bind(document);
document.addEventListener = (name, callback, ...rest) => {
    if (name === 'DOMContentLoaded') domReady.push(callback);
    else originalAddListener(name, callback, ...rest);
};
await import('../../sidebar.js');
await Promise.all(domReady.map(callback => callback()));
const bindingAfterStartupPinRace = structuredClone(local.pinnedTabStatesById[1]);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const row = id => document.querySelector(`#spacesList [data-bookmark-id="${id}"]`);
const root = () => document.querySelector('#spacesList [data-tab-type="pinned"]');
const temporary = () => document.querySelector('#spacesList [data-tab-type="temporary"]');
function rect(element, top, height = 30) { element._rect = { top, bottom: top + height, left: 12, right: 270, width: 258, height }; }
function drag(element, type, y = 100, extra = {}) {
    const event = new window.Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, { clientX: 30, clientY: y, dataTransfer: { setData() {} }, ...extra });
    element.dispatchEvent(event); return event;
}
async function reset({ inverted = false, empty = false } = {}) {
    resetData();
    settings.invertTabOrder = inverted;
    if (empty) { getNode('p').children = []; storedSpaces[0].spaceBookmarks = []; storedSpaces[0].temporaryTabs = [1, 2, 3]; local.pinnedTabStatesById = {}; }
    await onChanged.emit({ spaces: { newValue: structuredClone(storedSpaces) } }, 'local');
    await chrome.runtime.onMessage.emit({ action: 'arcifyBookmarksChanged' });
    await wait(180);
    alerts = []; writes = []; effects = [];
}
async function drop(source, target, y) {
    const handle = source.classList.contains('folder') ? source.querySelector(':scope > .folder-header') : source;
    drag(handle, 'dragstart'); drag(target, 'dragover', y);
    drag(target, 'drop', y); drag(handle, 'dragend'); await wait(180);
}

const favorites = () => document.getElementById('pinnedFavicons');
const status = () => document.getElementById('favoritesDropStatus').textContent;
const target = () => favorites().querySelector('.placeholder-title');

async function resetFavorites() {
    await reset();
    await chrome.tabs.onMoved.emit(1, { windowId: 10 });
    await wait(40);
    effects = []; writes = [];
}

test('startup pin race retains exact native binding even when initial all-tabs snapshot was nonnative', () => {
    assert.equal(bindingAfterStartupPinRace.bookmarkId, 'a');
});

for (const id of ['c', 'closed']) test(`actual sidebar opens closed ${id} as one inactive native Favorite and retains exact source`, async () => {
    await resetFavorites(); const before = structuredClone(tree), membership = structuredClone(storedSpaces), source = row(id);
    assert(source.classList.contains('bookmark-only')); assert.equal(source.dataset.tabId, undefined);
    drag(source, 'dragstart');
    const over = drag(target(), 'dragover', 25);
    assert.equal(over.defaultPrevented, true); assert.equal(over.dataTransfer.dropEffect, 'copy');
    assert.match(status(), /Opens a pinned tab.*bookmark stays/);
    drag(target(), 'drop', 25);
    assert.equal(favorites().getAttribute('aria-busy'), 'true'); assert.equal(favorites().dataset.dropState, 'pending');
    drag(source, 'dragend'); await wait(220);
    assert.deepEqual(tree, before); assert.deepEqual(writes, []); assert.deepEqual(storedSpaces, membership);
    assert.deepEqual(effects, [['create', { pinned: true, active: false, windowId: 10, url: getNode(id).url }], ['move', 100, { index: 0 }]]);
    assert.equal(local.pinnedTabStatesById[100].bookmarkId, id);
    assert(favorites().querySelector('[data-tab-id="100"]')); assert(row(id).classList.contains('bookmark-only'));
    assert.equal(tabs.find(tab => tab.active).id, 2); assert.equal(session.activeSpaces[10], 'alpha');
    assert.equal(favorites().getAttribute('aria-busy'), 'false'); assert.equal(favorites().dataset.dropState, 'success');
    assert.match(status(), /Added to Favorites/); assert.deepEqual(alerts, []);
});

test('actual sidebar repeats and concurrent drops reuse one exact pin; same-URL different bookmark creates another', async () => {
    await resetFavorites(); getNode('c').url = getNode('closed').url;
    await chrome.runtime.onMessage.emit({ action: 'arcifyBookmarksChanged' }); await wait(180);
    const source = row('closed');
    drag(source, 'dragstart'); drag(target(), 'drop', 25); drag(source, 'dragend');
    drag(source, 'dragstart'); drag(target(), 'drop', 25); drag(source, 'dragend'); await wait(220);
    const operation = Number(favorites().dataset.dropOperation);
    await drop(row('closed'), favorites(), 25);
    assert.equal(Number(favorites().dataset.dropOperation), operation + 1);
    assert.equal(effects.filter(([kind]) => kind === 'create').length, 1);
    await drop(row('c'), favorites(), 25);
    assert.equal(effects.filter(([kind]) => kind === 'create').length, 2);
    assert.equal(local.pinnedTabStatesById[100].bookmarkId, 'closed'); assert.equal(local.pinnedTabStatesById[101].bookmarkId, 'c');
    assert.deepEqual(writes, []);
});

test('actual native pin events retain binding and source bookmark, allowing later saved-row reuse', async () => {
    await resetFavorites(); const before = structuredClone(tree);
    await drop(row('b'), target(), 25);
    await wait(80);
    assert.deepEqual(tree, before); assert.deepEqual(writes, []);
    assert.equal(local.pinnedTabStatesById[2].bookmarkId, 'b');
    assert.equal(tabs.find(tab => tab.id === 2).pinned, true);
    assert(!storedSpaces[0].spaceBookmarks.includes(2));
    assert(row('b').classList.contains('bookmark-only'));
    await drop(row('b'), favorites(), 25);
    assert.equal(effects.filter(([kind]) => kind === 'create').length, 0);
    assert.equal(effects.filter(([kind]) => kind === 'update').length, 1);
    assert.equal(tabs.find(tab => tab.id === 2).active, true);
});

test('actual sidebar rejects folders, external transfers, forged classes, and stale row identities with useful feedback', async () => {
    await resetFavorites(); const before = structuredClone(tree);
    drag(row('f').firstElementChild, 'dragstart');
    const folderOver = drag(target(), 'dragover', 25);
    assert.equal(folderOver.defaultPrevented, false); assert.equal(folderOver.dataTransfer.dropEffect, 'none');
    assert.match(status(), /one bookmark at a time/);
    drag(target(), 'drop', 25); drag(row('f').firstElementChild, 'dragend');
    assert.match(status(), /one bookmark at a time/);
    row('c').classList.add('dragging');
    const external = drag(target(), 'dragover', 25, { dataTransfer: { getData: () => 'c', types: ['text/plain', 'text/uri-list'] } });
    assert.equal(external.defaultPrevented, false); assert.match(status(), /from this sidebar/);
    drag(target(), 'drop', 25); row('c').classList.remove('dragging');
    const source = row('c'); drag(source, 'dragstart'); source.dataset.bookmarkId = 'forged';
    drag(target(), 'drop', 25); drag(source, 'dragend'); await wait(180);
    assert.match(status(), /changed/); assert.deepEqual(effects, []); assert.deepEqual(tree, before); assert.deepEqual(writes, []);
});

test('actual stale moved/deleted bookmarks and moved live tabs fail without changing saved source', async () => {
    for (const change of ['moved', 'deleted', 'foreign-window']) {
        await resetFavorites(); const source = row(change === 'foreign-window' ? 'b' : 'closed');
        drag(source, 'dragstart');
        if (change === 'moved') { const node = getNode('closed'); getNode('f').children = getNode('f').children.filter(item => item.id !== 'closed'); getNode('p').children.push(node); }
        if (change === 'deleted') getNode('f').children = getNode('f').children.filter(item => item.id !== 'closed');
        if (change === 'foreign-window') tabs.find(tab => tab.id === 2).windowId = 99;
        const before = structuredClone(tree);
        drag(target(), 'drop', 25); drag(source, 'dragend'); await wait(180);
        assert.equal(favorites().dataset.dropState, 'error'); assert.match(status(), /Could not add Favorite/);
        assert.deepEqual(effects, []); assert.deepEqual(tree, before); assert.deepEqual(writes, []);
    }
});

test('actual binding failure shows partial error, keeps new tab, and retries without duplication', async () => {
    await resetFavorites(); const before = structuredClone(tree);
    hooks.bindingSet = () => { throw new Error('Binding store failed'); };
    await drop(row('closed'), target(), 25);
    assert.match(status(), /pinned tab was opened.*Binding store failed/); assert.equal(favorites().dataset.dropState, 'error');
    assert.equal(tabs.filter(tab => tab.pinned).length, 1); assert.deepEqual(tree, before); assert.deepEqual(writes, []);
    delete hooks.bindingSet;
    await drop(row('closed'), favorites(), 25);
    assert.equal(effects.filter(([kind]) => kind === 'create').length, 1); assert.equal(favorites().dataset.dropState, 'success');
});

test('actual native live reorder remains functional without activating or opening a tab', async () => {
    await resetFavorites();
    await drop(row('b'), target(), 25);
    await drop(temporary().querySelector('[data-tab-id="3"]'), favorites(), 25);
    const source = favorites().querySelector('[data-tab-id="3"]');
    await drop(source, favorites().querySelector('[data-tab-id="2"]'), 25);
    assert.equal(effects.filter(([kind]) => kind === 'create').length, 0);
    assert(effects.filter(([kind]) => kind === 'move').length >= 3);
    assert.equal(tabs.find(tab => tab.active).id, 2); assert.deepEqual(writes, []);
});

test('native Favorite dragged back to a space copies a pin without relocating its original saved bookmark', async () => {
    await resetFavorites();
    await drop(row('b'), target(), 25);
    const saved = structuredClone(getNode('b'));
    await drop(favorites().querySelector('[data-tab-id="2"]'), root(), 700);
    assert.deepEqual(getNode('b'), saved); assert(ids('f').includes('b'));
    assert(!writes.some(write => write.id === 'b'));
    assert.equal(writes.filter(write => write.kind === 'create').length, 1, JSON.stringify({ alerts, writes, effects }));
    assert.notEqual(local.pinnedTabStatesById[2]?.bookmarkId, 'b');
    assert.deepEqual(alerts, []);
    const copyId = local.pinnedTabStatesById[2].bookmarkId;
    await drop(row('b'), favorites(), 25);
    assert.equal(favorites().dataset.dropState, 'success');
    const newFavorite = tabs.find(tab => tab.pinned && local.pinnedTabStatesById[tab.id]?.bookmarkId === 'b');
    assert(newFavorite); assert.notEqual(newFavorite.id, 2);
    assert.equal(local.pinnedTabStatesById[2].bookmarkId, copyId);
    assert.equal(tabs.find(tab => tab.id === 2).pinned, false);
    assert.deepEqual(getNode('b'), saved);
});
