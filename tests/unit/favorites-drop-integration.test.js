import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseHTML } from 'linkedom';
import { enqueueBookmarkOperation } from '../../bookmark-writer.js';
import { SpaceStore, applySpacePatch, ownerOf } from '../../space-store.js';
import { FavoriteStore } from '../../favorite-store.js';
import { pngIcon } from '../fixtures/favorite-icons.js';

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
let storedSpaces, favoriteStore;
const local = { tabGroupImportDismissed: true };
const settings = { invertTabOrder: false, syncTabGroups: false, showAllOpenTabsInCollapsedFolders: true };
const session = { activeSpaces: { 10: 'alpha' } };
let tree, writes = [], alerts = [], nextId = 100, effects = [], hooks = {}, favoriteMessages = [];
let startupPinRace = true;
const bookmark = (id, tabId = null) => ({ id, title: id, url: tabId ? tabs[tabId - 1].url : `https://${id}.test/` });
function resetData() {
    tabs.splice(0, tabs.length, ...[1, 2, 3].map(id => ({ id, windowId: 10, active: id === 2, pinned: false, index: id - 1, title: `Tab ${id}`, url: `https://tab-${id}.test/` })));
    session.activeSpaces = { 10: 'alpha' }; session.favoriteDropAttempts = {}; session.favoriteSession = { version: 1, bindings: [], attempts: [] };
    local.persistentFavorites = []; local.favoriteIconCache = { version: 1, entries: [] }; if (favoriteStore) favoriteStore.initialized = false;
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
}, async set(next) { if (state === session) await hooks.sessionSet?.(next); if (state === local && next.pinnedTabStatesById) await hooks.bindingSet?.(); Object.assign(state, structuredClone(next)); }, async remove() {} });
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
            if (message.type === 'favoriteStore') {
                favoriteMessages.push(structuredClone(message));
                try {
                    const result = await favoriteStore.dispatch(message);
                    await hooks.afterFavoriteDispatch?.(message, result);
                    return { success: true, ...result };
                } catch (error) { return { success: false, error: error.message, code: error.code, ...(error.batch ? { batch: error.batch } : {}) }; }
            }
            if (message.type === 'sidebarTour') return { success: true, state: null };
            if (message.type === 'bookmarkOrder') {
                try { return { success: true, ...await enqueueBookmarkOperation(message.operation) }; }
                catch (error) { return { success: false, error: error.message, code: error.code }; }
            }
            assert.equal(message.type, 'spaceStore');
            if (hooks.spaceStore) return { success: true, spaces: await hooks.spaceStore.dispatch(message) };
            if (message.action === 'get') { const result = structuredClone(storedSpaces); return { success: true, spaces: result }; }
            if (message.action === 'patch') storedSpaces = applySpacePatch(storedSpaces, message.before, message.after);
            if (message.action === 'activate') session.activeSpaces[message.windowId] = message.spaceId;
            return { success: true, spaces: structuredClone(storedSpaces) };
        } },
    storage: { onChanged, local: area(local), sync: area(settings), session: area(session) },
    windows: { async get(id) { if (![10, 99].includes(id)) throw new Error('Window missing'); return { id, type: 'normal', incognito: false }; }, async update(id) { return { id }; }, getCurrent(_options, callback) { if (callback) callback({ id: 10 }); return Promise.resolve({ id: 10 }); } },
    tabs: { onActivated, ...Object.fromEntries(['onCreated', 'onUpdated', 'onRemoved', 'onAttached', 'onDetached', 'onMoved', 'onReplaced'].map(name => [name, listeners()])),
        async query(query) { return structuredClone(tabs.filter(tab => (!query.windowId || tab.windowId === query.windowId) && (!query.active || tab.active) && (query.pinned === undefined || query.pinned === tab.pinned))); },
        async get(id) { await hooks.tabGet?.(id); const tab = tabs.find(tab => tab.id === id); if (!tab) throw new Error('Tab closed'); return structuredClone(tab); },
        async create(properties) { effects.push(['create', properties]); await hooks.create?.(); const tab = { id: nextId++, title: 'Created', index: 0, ...properties }; tabs.push(tab); await chrome.tabs.onCreated.emit(structuredClone(tab)); return structuredClone(tab); },
        async update(id, properties) { const tab = tabs.find(tab => tab.id === id); if (!tab) throw new Error('Tab closed'); Object.assign(tab, properties); effects.push(['update', id, properties]); await chrome.tabs.onUpdated.emit(id, properties, structuredClone(tab)); return structuredClone(tab); },
        async move(id, properties) { await hooks.move?.(); const tab = tabs.find(tab => tab.id === id); Object.assign(tab, properties); effects.push(['move', id, properties]); return structuredClone(tab); },
        async remove(id) { effects.push(['remove', id]); const index = tabs.findIndex(tab => tab.id === id); if (index >= 0) tabs.splice(index, 1); await chrome.tabs.onRemoved.emit(id, { windowId: 10, isWindowClosing: false }); } },
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
    tabGroups: { onRemoved: listeners(), onUpdated: listeners(), async query() { return []; } }
};
// Use the actual authoritative FavoriteStore with the same serialization and
// membership boundary as the worker; all browser APIs and storage are fixtures.
let favoriteQueue = Promise.resolve();
const favoriteSpaces = {
    run(operation) { const next = favoriteQueue.then(operation); favoriteQueue = next.catch(() => {}); return next; },
    get spaces() { return storedSpaces; }, get active() { return session.activeSpaces; },
    track(tab) {
        if (tab.pinned) for (const space of storedSpaces) {
            space.spaceBookmarks = space.spaceBookmarks.filter(id => id !== tab.id);
            space.temporaryTabs = space.temporaryTabs.filter(id => id !== tab.id);
        }
    },
    async persist() { local.spaces = structuredClone(storedSpaces); }
};
favoriteStore = new FavoriteStore(favoriteSpaces);
favoriteStore.install();
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
    delete favorites()._rect;
    effects = []; writes = []; favoriteMessages = [];
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
    assert.deepEqual(effects, [['create', { pinned: true, active: false, windowId: 10, url: getNode(id).url }]]);
    assert.equal(local.persistentFavorites.find(item => item.sourceBookmarkId === id)?.url, getNode(id).url);
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
    assert.deepEqual(local.persistentFavorites.map(item => item.sourceBookmarkId).sort(), ['c', 'closed']);
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
    assert.match(status(), /does not accept folders/);
    drag(target(), 'drop', 25); drag(row('f').firstElementChild, 'dragend');
    assert.match(status(), /does not accept folders/);
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
    hooks.sessionSet = next => { if (next.favoriteSession?.bindings.length) throw new Error('Binding store failed'); };
    await drop(row('closed'), target(), 25);
    assert.match(status(), /Binding store failed/); assert.equal(favorites().dataset.dropState, 'error');
    assert.equal(tabs.filter(tab => tab.pinned).length, 1); assert.deepEqual(tree, before); assert.deepEqual(writes, []);
    delete hooks.sessionSet;
    await drop(row('closed'), favorites(), 25);
    assert.equal(effects.filter(([kind]) => kind === 'create').length, 1); assert.equal(favorites().dataset.dropState, 'success');
});

test('actual saved Favorites reorder remains functional without activating, opening or moving native tabs', async () => {
    await resetFavorites();
    await drop(row('b'), target(), 25);
    await drop(temporary().querySelector('[data-tab-id="3"]'), favorites(), 25);
    const source = favorites().querySelector('[data-tab-id="3"]');
    await drop(source, favorites().querySelector('[data-tab-id="2"]'), 25);
    assert.equal(effects.filter(([kind]) => kind === 'create').length, 0);
    assert.equal(effects.filter(([kind]) => kind === 'move').length, 0, 'Saved order never reorders native tabs');
    assert.deepEqual([...favorites().querySelectorAll('.saved-favorite')].map(node => node.dataset.tabId), ['3', '2']);
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
    const savedFavorite = local.persistentFavorites.find(item => item.sourceBookmarkId === 'b');
    const newFavorite = tabs.find(tab => tab.pinned && session.favoriteSession.bindings.some(binding => binding.favoriteId === savedFavorite.id && binding.tabId === tab.id));
    assert(newFavorite); assert.notEqual(newFavorite.id, 2);
    assert.equal(local.pinnedTabStatesById[2].bookmarkId, copyId);
    assert.equal(tabs.find(tab => tab.id === 2).pinned, false);
    assert.deepEqual(getNode('b'), saved);
});

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

test('native Favorite unpin notification racing closure never resurrects or looks up the closed tab', async () => {
    await resetFavorites();
    await drop(row('closed'), target(), 25);
    const favorite = tabs.find(tab => tab.id === 100);
    assert(favorites().querySelector('[data-tab-id="100"]'));
    const before = structuredClone(storedSpaces), bookmarks = structuredClone(tree);
    const release = deferred();
    const lookups = [];
    hooks.tabGet = async id => { lookups.push(id); if (id === favorite.id) await release.promise; };
    // Chrome detaching a native pin can emit pinned:false before onRemoved.
    // Keep the real sidebar's tab lookup pending while the tab disappears.
    await chrome.tabs.onUpdated.emit(favorite.id, { pinned: false }, { ...favorite, pinned: false });
    tabs.splice(tabs.indexOf(favorite), 1);
    release.resolve();
    await chrome.tabs.onRemoved.emit(favorite.id, { windowId: 10, isWindowClosing: false });
    await wait(220);
    assert.deepEqual(storedSpaces, before);
    assert.deepEqual(tree, bookmarks);
    assert.equal(local.pinnedTabStatesById[favorite.id], undefined);
    assert(!document.querySelector('[data-tab-id="100"]'));
    assert.equal(favorites().querySelector('.pinned-placeholder-container').style.display, 'none');
    assert.equal(favorites().querySelector('.saved-favorite .favorite-state').textContent, 'Closed');
    assert(row('closed').classList.contains('bookmark-only'));
    assert(!effects.some(([kind, , update]) => kind === 'update' && update.pinned === false), 'A native lifecycle notification must not trigger an optimistic tab move');
    assert.deepEqual(alerts, []);
});

for (const destination of ['alpha', 'beta']) test(`native unpin renders the real SpaceStore owner ${destination} without an optimistic reassignment`, async () => {
    await resetFavorites();
    await drop(row('closed'), target(), 25);
    tree.children.push({ id: 'q', title: 'Beta', children: [] });
    storedSpaces.push({ id: 'beta', name: 'Beta', color: 'red', bookmarkFolderId: 'q', spaceBookmarks: [], temporaryTabs: [] });
    local.spaces = structuredClone(storedSpaces);
    local.spaceModelVersion = 2;
    session.spaceSession = true;
    const store = new SpaceStore();
    await store.dispatch({ action: 'get' });
    // The worker may know a newer selected space before the sidebar receives
    // that session event. It must remain the only native membership writer.
    await store.dispatch({ action: 'activate', windowId: 10, spaceId: destination });
    hooks.spaceStore = store;
    const events = [onChanged, ...Object.values(chrome.tabs), ...Object.values(chrome.tabGroups)].filter(event => event?.callbacks);
    const lengths = events.map(event => event.callbacks.length);
    store.install();
    try {
        const favorite = tabs.find(tab => tab.id === 100);
        const saved = structuredClone(getNode('closed'));
        favorite.pinned = false;
        await chrome.tabs.onUpdated.emit(favorite.id, { pinned: false }, structuredClone(favorite));
        await store.run(() => {});
        await wait(220);
        assert.equal(ownerOf(local.spaces, favorite.id)?.id, destination);
        assert(!favorites().querySelector('[data-tab-id="100"]'));
        await onChanged.emit({ activeSpaces: { newValue: structuredClone(session.activeSpaces) } }, 'session');
        await wait(220);
        const liveRow = document.querySelector(`.space[data-space-id="${destination}"] .tab[data-tab-id="100"]`);
        assert(liveRow, 'The genuine unpin must render from the worker-owned membership');
        assert(liveRow.closest('[data-tab-type="temporary"]'), 'A saved Favorite instance is independent from its source bookmark');
        assert.equal(document.querySelectorAll('#spacesList .tab[data-tab-id="100"]').length, 1);
        assert.deepEqual(getNode('closed'), saved);
        assert.equal(local.pinnedTabStatesById[100], undefined);
        assert.deepEqual(alerts, []);
    } finally {
        await store.run(() => {});
        events.forEach((event, index) => event.callbacks.splice(lengths[index]));
        delete hooks.spaceStore;
    }
});

for (const state of ['repinned', 'other-window']) test(`delayed native unpin notification respects the current ${state} tab state`, async () => {
    await resetFavorites();
    await drop(row('closed'), target(), 25);
    const favorite = tabs.find(tab => tab.id === 100);
    const before = structuredClone(storedSpaces), bookmarks = structuredClone(tree), actions = structuredClone(effects);
    const staleUnpinned = { ...favorite, pinned: false };
    if (state === 'other-window') favorite.windowId = 99;
    await chrome.tabs.onUpdated.emit(favorite.id, { pinned: false }, staleUnpinned);
    await wait(220);
    assert.deepEqual(storedSpaces, before);
    assert.deepEqual(tree, bookmarks);
    assert.deepEqual(effects, actions);
    assert(!document.querySelector('#spacesList .tab[data-tab-id="100"]'));
    assert.equal(Boolean(favorites().querySelector('[data-tab-id="100"]')), state === 'repinned');
    assert.equal(local.pinnedTabStatesById[100], undefined);
    assert.deepEqual(alerts, []);
});

const savedIcon = id => [...favorites().querySelectorAll('.saved-favorite')].find(node => node.dataset.favoriteId === id);
function click(element, type = 'click') { const event = new window.Event(type, { bubbles: true, cancelable: true }); Object.assign(event, { clientX: 20, clientY: 20 }); element.dispatchEvent(event); }
function chooseContext(element, text) {
    click(element, 'contextmenu');
    const option = [...document.querySelectorAll('#tab-context-menu button')].find(node => node.textContent === text);
    assert(option, `Missing context action: ${text}`); click(option);
}

test('Ctrl+W-equivalent close preserves saved icon; clicking reopens its saved URL and later activation preserves navigation', async () => {
    await resetFavorites(); await drop(row('closed'), target(), 25);
    const favoriteId = local.persistentFavorites[0].id;
    const source = structuredClone(tree);
    await chrome.tabs.remove(100); await wait(180);
    assert(savedIcon(favoriteId)); assert.equal(savedIcon(favoriteId).dataset.tabId, undefined);
    assert.equal(savedIcon(favoriteId).querySelector('.favorite-state').textContent, 'Closed');
    assert.equal(local.persistentFavorites.length, 1); assert.deepEqual(tree, source);
    click(savedIcon(favoriteId)); await wait(180);
    const reopenedId = Number(savedIcon(favoriteId).dataset.tabId), reopened = tabs.find(tab => tab.id === reopenedId);
    assert.notEqual(reopenedId, 100); assert.equal(reopened.url, getNode('closed').url); assert.equal(reopened.pinned, true); assert.equal(reopened.active, true);
    reopened.url = 'https://navigated.test/deep'; reopened.active = false;
    effects = []; click(savedIcon(favoriteId)); await wait(180);
    assert.equal(reopened.url, 'https://navigated.test/deep');
    assert.deepEqual(effects, [['update', reopenedId, { active: true }]]);
    assert.deepEqual(tree, source);
});

test('explicit Remove Favorite removes shared record and unpins pages without closing or deleting source bookmark', async () => {
    await resetFavorites(); await drop(row('closed'), target(), 25);
    const id = local.persistentFavorites[0].id, original = structuredClone(tree);
    effects = []; chooseContext(savedIcon(id), 'Remove Favorite'); await wait(220);
    assert.equal(local.persistentFavorites.length, 0); assert(!savedIcon(id));
    assert(tabs.some(tab => tab.id === 100)); assert.equal(tabs.find(tab => tab.id === 100).pinned, false);
    assert(!effects.some(([kind]) => kind === 'remove')); assert.deepEqual(tree, original); assert.deepEqual(writes, []);
});

test('real sidebar navigation handler cannot replace retained saved-page favicon with the live page icon', async () => {
    await resetFavorites(); await drop(row('closed'), target(), 25);
    const record = local.persistentFavorites[0], icon = pngIcon();
    local.favoriteIconCache = { version: 1, entries: [{ favoriteId: record.id, url: record.url, faviconDataUrl: icon }] }; favoriteStore.initialized = false;
    await onChanged.emit({ favoriteIconCache: { newValue: structuredClone(local.favoriteIconCache) } }, 'local'); await wait(120);
    assert.equal(savedIcon(record.id).querySelector('img').src, icon);
    const tab = tabs.find(tab => tab.id === 100); tab.url = 'https://navigated.test/'; tab.favIconUrl = 'https://navigated.test/icon.png';
    await chrome.tabs.onUpdated.emit(tab.id, { url: tab.url, favIconUrl: tab.favIconUrl }, structuredClone(tab)); await wait(120);
    assert.equal(savedIcon(record.id).querySelector('img').src, icon);
    assert.equal(local.persistentFavorites[0].url, record.url);
    await chrome.tabs.remove(tab.id); await wait(180);
    assert.equal(savedIcon(record.id).querySelector('img').src, icon);
});

test('existing browser pins remain native until explicit per-tab adoption and native reorder never rewrites saved order', async () => {
    await resetFavorites(); await drop(row('closed'), target(), 25);
    const savedOrder = structuredClone(local.persistentFavorites);
    tabs.push({ id: 201, windowId: 10, pinned: true, active: false, index: 1, title: 'Existing A', url: 'https://legacy.test/a' },
        { id: 202, windowId: 10, pinned: true, active: false, index: 2, title: 'Existing B', url: 'https://legacy.test/b' });
    await chrome.tabs.onMoved.emit(201, { windowId: 10 }); await wait(80);
    assert.equal(favorites().querySelectorAll('.native-favorite').length, 2); assert.deepEqual(local.persistentFavorites, savedOrder);
    assert.equal(document.getElementById('nativeFavoritesNotice').hidden, false);
    effects = [];
    const first = favorites().querySelector('.native-favorite[data-tab-id="201"]');
    const second = favorites().querySelector('.native-favorite[data-tab-id="202"]');
    first._rect = { left: 0, right: 40, top: 10, bottom: 58, width: 40, height: 48 };
    // Explicitly choose the left half; the right half is its existing slot.
    drag(second, 'dragstart'); drag(first, 'dragover', 25, { clientX: 10 });
    drag(first, 'drop', 25, { clientX: 10 }); drag(second, 'dragend'); await wait(180);
    assert(effects.some(([kind]) => kind === 'move')); assert(!effects.some(([kind]) => kind === 'create' || kind === 'update'));
    assert.deepEqual(local.persistentFavorites, savedOrder);
    chooseContext(favorites().querySelector('.native-favorite[data-tab-id="201"]'), 'Keep as saved Favorite'); await wait(220);
    assert.equal(local.persistentFavorites.length, 2); assert.equal(local.persistentFavorites[1].sourceBookmarkId, null);
    assert(favorites().querySelector('.saved-favorite[data-tab-id="201"]')); assert(favorites().querySelector('.native-favorite[data-tab-id="202"]'));
    assert(!effects.some(([kind]) => kind === 'create' || kind === 'remove'));
});

test('shared saved storage refresh renders closed records and keeps exact distinct identities with equal URLs', async () => {
    await resetFavorites();
    local.persistentFavorites = [{ id: 'other-window-a', title: 'One', url: 'https://shared.test/', sourceBookmarkId: null },
        { id: 'other-window-b', title: 'Two', url: 'https://shared.test/', sourceBookmarkId: null }];
    favoriteStore.initialized = false;
    await onChanged.emit({ persistentFavorites: { newValue: structuredClone(local.persistentFavorites) } }, 'local'); await wait(120);
    assert.equal(favorites().querySelectorAll('.saved-favorite.favorite-closed').length, 2);
    assert(savedIcon('other-window-a')); assert(savedIcon('other-window-b'));
    assert.deepEqual(effects, []); assert.deepEqual(writes, []);
});


test('unmanaged native pin reverse drag retains legacy copy behavior without implicit saved adoption', async () => {
    await resetFavorites(); const original = structuredClone(getNode('b'));
    await chrome.tabs.update(2, { pinned: true }); await wait(120);
    const native = favorites().querySelector('.native-favorite[data-tab-id="2"]'); assert(native);
    await drop(native, root(), 700);
    assert.deepEqual(getNode('b'), original); assert(ids('f').includes('b'));
    assert.equal(local.persistentFavorites.length, 0); assert.equal(tabs.find(tab => tab.id === 2).pinned, false);
    assert.equal(writes.filter(write => write.kind === 'create').length, 1); assert(!writes.some(write => write.id === 'b'));
    assert.notEqual(local.pinnedTabStatesById[2]?.bookmarkId, 'b'); assert.deepEqual(alerts, []);
});

test('legacy uncertain drop from before upgrade is surfaced without a second page or saved-record write', async () => {
    await resetFavorites();
    const receiptKey = JSON.stringify([10, 'closed']);
    session.favoriteDropAttempts[receiptKey] = { tabId: null, url: getNode('closed').url };
    const before = structuredClone(tree);
    await drop(row('closed'), target(), 25);
    assert.equal(favorites().dataset.dropState, 'error'); assert.equal(favorites().getAttribute('aria-busy'), 'false');
    assert.match(status(), /before this update could not be verified/);
    assert.deepEqual(effects, []); assert.deepEqual(writes, []); assert.deepEqual(tree, before);
    assert.deepEqual(local.persistentFavorites, []); assert.equal(session.favoriteDropAttempts[receiptKey].tabId, null);
});

const favoriteMarker = () => document.querySelector('.favorites-drop-anchor');
const favoriteIds = () => local.persistentFavorites.map(item => item.id);
async function seedFavoriteGrid({ saved = ['saved-a', 'saved-b', 'saved-c', 'saved-d', 'saved-e'], native = [] } = {}) {
    await resetFavorites();
    local.persistentFavorites = saved.map(id => ({ id, title: id, url: 'https://same-url.test/', sourceBookmarkId: null }));
    favoriteStore.initialized = false;
    tabs.push(...native.map((id, index) => ({ id, index, windowId: 10, pinned: true, active: false, title: `Native ${id}`, url: 'https://native.test/' })));
    await onChanged.emit({ persistentFavorites: { newValue: structuredClone(local.persistentFavorites) } }, 'local'); await wait(120);
    layoutFavoriteGrid(); effects = []; writes = [];
}
function layoutFavoriteGrid() {
    favorites()._rect = { left: 8, right: 288, top: 10, bottom: 240, width: 280, height: 230 };
    [...favorites().querySelectorAll('.pinned-favicon')].forEach((node, index) => {
        const left = 8 + index % 3 * 88, top = 10 + Math.floor(index / 3) * 56;
        node._rect = { left, right: left + 80, top, bottom: top + 48, width: 80, height: 48 };
    });
}
function favoritePoint(node, placement = 'before') {
    const rect = node.getBoundingClientRect(); return { clientX: placement === 'before' ? rect.left + 8 : rect.right - 8, clientY: rect.top + 20 };
}
async function commitFavoriteDrag(source, target, placement, expectedBeforeId) {
    const point = favoritePoint(target, placement);
    drag(source, 'dragstart'); drag(target, 'dragover', point.clientY, point);
    assert.equal(favoriteMarker().hidden, false);
    assert.equal(favoriteMarker().dataset.beforeId, expectedBeforeId || '');
    assert.equal(favoriteMarker().dataset.placement, placement);
    drag(target, 'drop', point.clientY, point);
    assert.equal(favoriteMarker().hidden, true, 'drop immediately clears its preview');
    drag(source, 'dragend'); await wait(180); layoutFavoriteGrid();
}

test('actual Favorites marker commits first, middle, wrapped-row and append slots without losing any saved record', async () => {
    await seedFavoriteGrid(); const original = structuredClone(local.persistentFavorites), bookmarks = structuredClone(tree);
    const exact = favoriteIds().sort();
    await commitFavoriteDrag(savedIcon('saved-e'), savedIcon('saved-a'), 'before', 'saved-a');
    assert.deepEqual(favoriteIds(), ['saved-e', 'saved-a', 'saved-b', 'saved-c', 'saved-d']);
    await commitFavoriteDrag(savedIcon('saved-e'), savedIcon('saved-c'), 'after', 'saved-d');
    assert.deepEqual(favoriteIds(), ['saved-a', 'saved-b', 'saved-c', 'saved-e', 'saved-d']);
    await commitFavoriteDrag(savedIcon('saved-b'), savedIcon('saved-d'), 'after', null);
    assert.deepEqual(favoriteIds(), ['saved-a', 'saved-c', 'saved-e', 'saved-d', 'saved-b']);
    await commitFavoriteDrag(savedIcon('saved-b'), savedIcon('saved-d'), 'before', 'saved-d');
    assert.deepEqual(favoriteIds(), ['saved-a', 'saved-c', 'saved-e', 'saved-b', 'saved-d']);
    assert.deepEqual(favoriteIds().sort(), exact);
    for (const item of local.persistentFavorites) assert.deepEqual(item, original.find(record => record.id === item.id));
    assert.deepEqual(tree, bookmarks); assert.deepEqual(writes, []); assert.deepEqual(effects, [], 'closed record reorder never opens, closes or moves a tab');
});

test('actual saved/native boundary previews the saved append slot and keeps unmanaged pins independent', async () => {
    await seedFavoriteGrid({ saved: ['saved-a', 'saved-b'], native: [201, 202] });
    const source = savedIcon('saved-a'), native = favorites().querySelector('[data-tab-id="202"]');
    const point = favoritePoint(native, 'after'), bookmarks = structuredClone(tree);
    drag(source, 'dragstart'); drag(native, 'dragover', point.clientY, point);
    assert.equal(favoriteMarker().dataset.list, 'saved'); assert.equal(favoriteMarker().dataset.anchorId, 'saved-b'); assert.equal(favoriteMarker().dataset.beforeId, '');
    drag(native, 'drop', point.clientY, point); drag(source, 'dragend'); await wait(180); layoutFavoriteGrid();
    assert.deepEqual(favoriteIds(), ['saved-b', 'saved-a']); assert.deepEqual(effects, []);
    const records = structuredClone(local.persistentFavorites);
    const nativeSource = favorites().querySelector('[data-tab-id="202"]'), savedTarget = savedIcon('saved-b');
    const nativePoint = favoritePoint(savedTarget);
    drag(nativeSource, 'dragstart'); drag(savedTarget, 'dragover', nativePoint.clientY, nativePoint);
    assert.equal(favoriteMarker().dataset.list, 'native'); assert.equal(favoriteMarker().dataset.anchorId, '201'); assert.equal(favoriteMarker().dataset.placement, 'before');
    drag(savedTarget, 'drop', nativePoint.clientY, nativePoint); drag(nativeSource, 'dragend'); await wait(180);
    assert.deepEqual(effects.filter(([kind]) => kind === 'move').map(([, id, patch]) => [id, patch.index]), [[202, 0], [201, 1]]);
    assert.deepEqual(local.persistentFavorites, records); assert.deepEqual(tree, bookmarks); assert.deepEqual(writes, []);
    assert(!effects.some(([kind]) => kind === 'create' || kind === 'remove' || kind === 'update'));
});

test('actual external bookmark drops use the marker before a saved ID, including empty-saved/native-only boundary', async () => {
    for (const saved of [['saved-a', 'saved-b'], []]) {
        await seedFavoriteGrid({ saved, native: [201] });
        const source = row('closed'), target = saved.length ? savedIcon('saved-b') : favorites().querySelector('[data-tab-id="201"]');
        const point = favoritePoint(target), bookmarks = structuredClone(tree);
        drag(source, 'dragstart'); drag(target, 'dragover', point.clientY, point);
        assert.equal(favoriteMarker().hidden, false); assert.equal(favoriteMarker().dataset.list, 'saved');
        assert.equal(favoriteMarker().dataset.beforeId, saved.length ? 'saved-b' : '');
        assert.equal(favoriteMarker().dataset.anchorId, saved.length ? 'saved-b' : '201');
        drag(target, 'drop', point.clientY, point); drag(source, 'dragend'); await wait(220);
        const added = local.persistentFavorites.find(item => item.sourceBookmarkId === 'closed'); assert(added);
        assert.deepEqual(favoriteIds(), saved.length ? ['saved-a', added.id, 'saved-b'] : [added.id]);
        assert(favorites().querySelector('.native-favorite[data-tab-id="201"]'));
        assert.deepEqual(tree, bookmarks); assert.deepEqual(writes, []); assert(!effects.some(([kind]) => kind === 'remove' || kind === 'move'));
    }
});

test('actual own-slot and adjacent no-op drops do not paint or submit a mutation', async () => {
    await seedFavoriteGrid({ native: [201, 202] });
    const records = structuredClone(local.persistentFavorites), operation = favorites().dataset.dropOperation;
    for (const [source, target, placement] of [
        [savedIcon('saved-c'), savedIcon('saved-c'), 'after'],
        [savedIcon('saved-c'), savedIcon('saved-b'), 'after'],
        [savedIcon('saved-c'), savedIcon('saved-d'), 'before'],
        [favorites().querySelector('[data-tab-id="202"]'), favorites().querySelector('[data-tab-id="201"]'), 'after']
    ]) {
        const point = favoritePoint(target, placement);
        drag(source, 'dragstart'); const event = drag(target, 'dragover', point.clientY, point);
        assert.equal(favoriteMarker().hidden, true); assert.equal(event.dataTransfer.dropEffect, 'none');
        drag(target, 'drop', point.clientY, point); drag(source, 'dragend');
    }
    await wait(180); assert.deepEqual(local.persistentFavorites, records); assert.deepEqual(effects, []); assert.deepEqual(writes, []);
    assert.equal(favorites().dataset.dropOperation, operation);
});

test('actual Escape, blur, external drop, leave and end clear a visible Favorites preview without mutation', async () => {
    await seedFavoriteGrid(); const records = structuredClone(local.persistentFavorites);
    for (const type of ['keydown', 'blur', 'drop', 'dragleave', 'dragend']) {
        const source = savedIcon('saved-e'), target = savedIcon('saved-a'), point = favoritePoint(target);
        drag(source, 'dragstart'); drag(target, 'dragover', point.clientY, point); assert.equal(favoriteMarker().hidden, false);
        const destination = type === 'blur' ? window : type === 'dragleave' ? favorites() : type === 'dragend' ? source : document.body;
        drag(destination, type, 25, { key: 'Escape', relatedTarget: null });
        assert.equal(favoriteMarker().hidden, true); assert.equal(favoriteMarker().dataset.beforeId, undefined);
        if (['keydown', 'blur'].includes(type)) drag(target, 'drop', point.clientY, point);
        drag(source, 'dragend');
    }
    await wait(180); assert.deepEqual(local.persistentFavorites, records); assert.deepEqual(effects, []); assert.deepEqual(writes, []);
});

test('actual drop recomputes the final pointer destination instead of committing stale hover coordinates', async () => {
    await seedFavoriteGrid();
    const source = savedIcon('saved-a'), hovered = savedIcon('saved-c'), target = savedIcon('saved-e');
    const hoverPoint = favoritePoint(hovered), dropPoint = favoritePoint(target, 'after');
    drag(source, 'dragstart'); drag(hovered, 'dragover', hoverPoint.clientY, hoverPoint); assert.equal(favoriteMarker().dataset.beforeId, 'saved-c');
    drag(target, 'drop', dropPoint.clientY, dropPoint); drag(source, 'dragend'); await wait(180);
    assert.deepEqual(favoriteIds(), ['saved-b', 'saved-c', 'saved-d', 'saved-e', 'saved-a']);
    assert.deepEqual(effects, []); assert.deepEqual(writes, []);
});

const selectedBookmarkIds = () => [...document.querySelectorAll('#spacesList .bookmark-selected')].map(node => node.dataset.bookmarkId);
const selectBookmark = (id, modifiers = { ctrlKey: true }) => drag(row(id), 'click', 100, { button: 0, ...modifiers });
const batchRequests = () => favoriteMessages.filter(message => message.action === 'addBookmarks');

test('actual sidebar modifier selection spans visible projected rows without activation, folder expansion or writes', async () => {
    await resetFavorites(); const original = structuredClone(tree), beforeTabs = structuredClone(tabs);
    selectBookmark('a'); selectBookmark('c', { shiftKey: true });
    assert.deepEqual(selectedBookmarkIds(), ['a', 'b', 'c']);
    assert.equal(document.getElementById('bookmarkSelectionStatus').dataset.count, '3');
    assert.equal(row('a').getAttribute('aria-selected'), 'true'); assert.equal(row('closed').getAttribute('aria-selected'), 'false');
    assert(row('f').classList.contains('collapsed')); assert.deepEqual(tabs, beforeTabs);
    assert.deepEqual(tree, original); assert.deepEqual(effects, []); assert.deepEqual(writes, []); assert.deepEqual(batchRequests(), []);
    selectBookmark('b', { metaKey: true }); assert.deepEqual(selectedBookmarkIds(), ['a', 'c']);
    drag(document.body, 'keydown', 0, { key: 'Escape' }); assert.deepEqual(selectedBookmarkIds(), []);
});

test('actual ordinary closed-bookmark activation/re-render/blur preserves only its logical range anchor', async () => {
    await resetFavorites(); const original = row('c');
    selectBookmark('c', {}); await wait(240);
    assert(effects.some(([kind, properties]) => kind === 'create' && properties.url === getNode('c').url && properties.active));
    assert(row('c') && row('c') !== original, 'the actual activation replaces the closed row');
    assert(row('c').dataset.tabId, 'new exact live binding is rendered');
    assert.deepEqual(selectedBookmarkIds(), []);
    drag(window, 'blur'); selectBookmark('a', { shiftKey: true });
    assert.deepEqual(selectedBookmarkIds(), ['a', 'b', 'c']);
    assert.equal(local.persistentFavorites.length, 0, 'range selection never adds Favorites');
    drag(document.body, 'keydown', 0, { key: 'Escape' });
});

test('ordinary singleton drag retains row identity while selection count appears and a refresh waits', async () => {
    await resetFavorites();
    const source = row('c'), destination = row('a'), status = document.getElementById('bookmarkSelectionStatus');
    assert.equal(status.hidden, true);
    drag(source, 'dragstart');
    assert.equal(status.hidden, false); assert.equal(status.dataset.count, '1');
    assert.equal(status.parentElement, document.querySelector('.new-tab-btn-container'));
    await chrome.runtime.onMessage.emit({ action: 'arcifyBookmarksChanged' });
    await wait(180);
    assert.equal(row('c'), source); assert.equal(row('a'), destination);
    assert(source.classList.contains('dragging'));
    assert.deepEqual(effects, []); assert.deepEqual(writes, []);
    drag(source, 'dragend'); await wait(180);
});

test('actual batch drag shows count and marker, preserves source bookmarks, and reuses exact repeated instances', async () => {
    await resetFavorites(); const original = structuredClone(tree), originalActive = tabs.filter(tab => tab.active).map(tab => tab.id);
    selectBookmark('a'); selectBookmark('c', { shiftKey: true });
    let ghost;
    const started = drag(row('b'), 'dragstart', 100, { dataTransfer: { setData() {}, setDragImage(node) { ghost = node; } } });
    assert.equal(started.dataTransfer.effectAllowed, 'copy'); assert.equal(ghost.dataset.count, '3');
    assert.equal(document.querySelectorAll('.dragging').length, 1);
    drag(target(), 'dragover', 25); assert.equal(favoriteMarker().hidden, false, `Batch marker status: ${status()}; ${favoriteMarker().outerHTML}`);
    assert.match(status(), /Add 3 bookmarks/);
    drag(target(), 'drop', 25); assert.equal(favorites().getAttribute('aria-busy'), 'true');
    drag(row('b'), 'dragend'); await wait(260);
    assert.deepEqual(batchRequests()[0], { type: 'favoriteStore', action: 'addBookmarks', windowId: 10, spaceId: 'alpha', bookmarkFolderId: 'p', beforeId: null,
        bookmarks: [{ bookmarkId: 'a', parentId: 'p', tabId: 1 }, { bookmarkId: 'b', parentId: 'f', tabId: 2 }, { bookmarkId: 'c', parentId: 'p' }] });
    assert.deepEqual(local.persistentFavorites.map(item => item.sourceBookmarkId), ['a', 'b', 'c']);
    assert.equal(tabs.filter(tab => tab.pinned).length, 3); assert.deepEqual(tabs.filter(tab => tab.active).map(tab => tab.id), originalActive);
    assert.deepEqual(tree, original); assert.deepEqual(writes, []);
    assert.equal(favorites().dataset.dropState, 'success'); assert.match(status(), /3 completed, 0 failed, 0 not attempted/);
    assert.equal(favorites().getAttribute('aria-busy'), 'false'); assert.equal(document.querySelector('.bookmark-drag-preview'), null);
    const before = structuredClone(local.persistentFavorites), instances = session.favoriteSession.bindings.map(item => [item.favoriteId, item.tabId]);
    // All source rows are now closed placeholders; open the folder to make the
    // exact b row visible, then repeat in the same visible order.
    click(row('f').querySelector('.folder-header'));
    selectBookmark('a'); selectBookmark('b'); selectBookmark('c');
    await drop(row('a'), savedIcon(before[0].id), 25);
    assert.equal(batchRequests().length, 2); assert.deepEqual(local.persistentFavorites, before);
    assert.deepEqual(session.favoriteSession.bindings.map(item => [item.favoriteId, item.tabId]), instances);
    assert.equal(effects.filter(([kind]) => kind === 'create').length, 1, 'repeat does not create a new page');
    assert.deepEqual(tree, original); assert.deepEqual(writes, []);
});

test('actual batch is blocked from legacy Space, folder and temporary destinations before any row moves', async () => {
    await resetFavorites(); const original = structuredClone(tree), memberships = structuredClone(storedSpaces);
    selectBookmark('a'); selectBookmark('c');
    const a = row('a'), parent = a.parentElement; drag(a, 'dragstart');
    for (const destination of [root(), temporary(), row('g').querySelector('.folder-header'), row('f').querySelector('.folder-content')]) {
        const over = drag(destination, 'dragover', 100);
        assert.equal(over.dataTransfer.dropEffect, 'none'); drag(destination, 'drop', 100);
        assert.equal(a.parentElement, parent); assert(row('g').classList.contains('collapsed'));
        assert.match(status(), /only be dropped into Favorites/);
    }
    drag(a, 'dragend'); await wait(180);
    assert.deepEqual(tree, original); assert.deepEqual(storedSpaces, memberships); assert.deepEqual(effects, []); assert.deepEqual(writes, []);
    assert.deepEqual(batchRequests(), []); assert.equal(local.persistentFavorites.length, 0);
});

test('actual batch never shrinks to the dragged row after a selected row changes or disappears', async () => {
    for (const change of ['binding', 'remove', 'hide', 'space']) {
        await resetFavorites(); selectBookmark('a'); selectBookmark('b'); const a = row('a'); drag(a, 'dragstart');
        if (change === 'binding') row('b').dataset.tabId = '999';
        if (change === 'remove') row('b').remove();
        if (change === 'hide') row('b').hidden = true;
        if (change === 'space') await onChanged.emit({ activeSpaces: { newValue: { 10: 'unavailable-space' } } }, 'session');
        drag(target(), 'drop', 25); assert.match(status(), /changed/);
        drag(a, 'dragend'); await wait(180);
        assert.deepEqual(batchRequests(), [], change); assert.deepEqual(effects, []); assert.deepEqual(writes, []);
    }
});

test('actual partial batch reports completed, failed, and unattempted sources without automatic retries', async () => {
    await resetFavorites();
    getNode('p').children.push(bookmark('d'), bookmark('e'));
    await chrome.runtime.onMessage.emit({ action: 'arcifyBookmarksChanged' }); await wait(180);
    const original = structuredClone(tree); let attempts = 0;
    hooks.create = () => { if (++attempts === 2) throw new Error('Second create result was not verified'); };
    selectBookmark('c'); selectBookmark('e', { shiftKey: true });
    assert.deepEqual(selectedBookmarkIds(), ['c', 'd', 'e']);
    await drop(row('c'), target(), 25);
    assert.equal(favorites().dataset.dropState, 'error'); assert.equal(favorites().getAttribute('aria-busy'), 'false');
    assert.match(status(), /1 completed, 1 failed, 1 not attempted/);
    assert.match(status(), /Completed bookmark IDs: c/); assert.match(status(), /Failed bookmark d/); assert.match(status(), /Not attempted bookmark IDs: e/);
    assert.match(status(), /Nothing was retried automatically/);
    await wait(220); assert.equal(attempts, 2); assert.equal(batchRequests().length, 1);
    assert(local.persistentFavorites.some(item => item.sourceBookmarkId === 'c'));
    assert(!local.persistentFavorites.some(item => item.sourceBookmarkId === 'e'));
    assert.equal(tabs.filter(tab => tab.pinned).length, 1); assert.deepEqual(tree, original); assert.deepEqual(writes, []);
});

test('actual batch with a lost reply reports unknown completion and never retries completed effects', async () => {
    await resetFavorites(); getNode('p').children.push(bookmark('d'));
    await chrome.runtime.onMessage.emit({ action: 'arcifyBookmarksChanged' }); await wait(180);
    hooks.afterFavoriteDispatch = message => { if (message.action === 'addBookmarks') throw new Error('Worker response was interrupted'); };
    selectBookmark('c'); selectBookmark('d'); await drop(row('c'), target(), 25);
    assert.equal(favorites().dataset.dropState, 'error'); assert.equal(favorites().getAttribute('aria-busy'), 'false');
    assert.match(status(), /Could not confirm the batch result/); assert.match(status(), /Some Favorites may have been added/);
    assert.match(status(), /Check Favorites before trying again/); assert.match(status(), /Nothing was retried automatically/);
    assert.equal(batchRequests().length, 1); assert.deepEqual(local.persistentFavorites.map(item => item.sourceBookmarkId), ['c', 'd']);
    assert.equal(favorites().querySelectorAll('.saved-favorite').length, 2, 'best-effort refresh exposes completed effects');
    await wait(180); assert.equal(batchRequests().length, 1); assert.equal(effects.filter(([kind]) => kind === 'create').length, 2);
});

test('actual selected equal-URL bookmarks remain distinct exact Favorites and inactive instances', async () => {
    await resetFavorites(); getNode('p').children.push({ ...bookmark('d'), url: getNode('c').url });
    await chrome.runtime.onMessage.emit({ action: 'arcifyBookmarksChanged' }); await wait(180);
    const original = structuredClone(tree); selectBookmark('d'); selectBookmark('c'); await drop(row('d'), target(), 25);
    assert.deepEqual(local.persistentFavorites.map(item => item.sourceBookmarkId), ['c', 'd']);
    assert.equal(new Set(local.persistentFavorites.map(item => item.id)).size, 2);
    const opened = tabs.filter(tab => tab.pinned); assert.equal(opened.length, 2); assert.equal(new Set(opened.map(tab => tab.id)).size, 2);
    assert(opened.every(tab => tab.url === getNode('c').url && tab.active === false));
    assert.deepEqual(tree, original); assert.deepEqual(writes, []); assert.equal(batchRequests().length, 1);
});
