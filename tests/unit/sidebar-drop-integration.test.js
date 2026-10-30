import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseHTML } from 'linkedom';
import { enqueueBookmarkOperation } from '../../bookmark-writer.js';
import { applySpacePatch } from '../../space-store.js';
import { moveSpace } from '../../space-order.js';
import { createNativeSplitWriteGuard } from '../../native-split-safety.js';

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
        removeListener(callback) { const index = callbacks.indexOf(callback); if (index >= 0) callbacks.splice(index, 1); },
        async emit(...args) { await Promise.all([...callbacks].map(callback => callback(...args))); } };
};
const onChanged = listeners();
const tabs = [1, 2, 3].map(id => ({ id, windowId: 10, active: id === 2, pinned: false, title: `Tab ${id}`, url: `https://tab-${id}.test/` }));
let storedSpaces;
const local = { tabGroupImportDismissed: true };
const settings = { invertTabOrder: false, syncTabGroups: false, showAllOpenTabsInCollapsedFolders: true };
const session = { activeSpaces: { 10: 'alpha' } };
let tree, writes = [], alerts = [], nextId = 10, hooks = {};
const bookmark = (id, tabId = null) => ({ id, title: id, url: tabId ? tabs[tabId - 1].url : `https://${id}.test/` });
function resetData() {
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
const area = state => ({ async get(keys, callback) {
    if (state === local) await hooks.storageRead?.(keys);
    const result = typeof keys === 'string' ? { [keys]: structuredClone(state[keys]) } : structuredClone({ ...(Array.isArray(keys) ? {} : keys), ...state });
    if (state === local) await hooks.storageReadResult?.(keys, result);
    callback?.(result); return result;
}, async set(next) {
    if (state === local) await hooks.beforeStorageSet?.(next);
    Object.assign(state, structuredClone(next));
    if (state === local) await hooks.storageSet?.(next);
}, async remove() {} });
const onActivated = listeners();

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
            if (message.type === 'favoriteStore') return { success: true, favorites: [], nativeTabs: tabs.filter(tab => tab.pinned) };
            if (message.type === 'sidebarTour') return { success: true, state: null };
            if (message.type === 'bookmarkOrder') {
                try { return { success: true, ...await enqueueBookmarkOperation(message.operation, { beforeWrite: createNativeSplitWriteGuard(message.guardTab) }) }; }
                catch (error) { return { success: false, error: error.message, code: error.code, moved: error.moved, createdId: error.createdId }; }
            }
            if (message.type === 'arcifySharedToday') return { success: true, entries: [] };
            assert.equal(message.type, 'spaceStore');
            if (message.action === 'get') { const result = structuredClone(storedSpaces); return { success: true, spaces: result }; }
            if (message.action === 'patch') storedSpaces = applySpacePatch(storedSpaces, message.before, message.after);
            if (message.action === 'reorder') storedSpaces = moveSpace(storedSpaces, message);
            if (message.action === 'activate') session.activeSpaces[message.windowId] = message.spaceId;
            return { success: true, spaces: structuredClone(storedSpaces) };
        } },
    storage: { onChanged, local: area(local), sync: area(settings), session: area(session) },
    windows: { getCurrent(_options, callback) { if (callback) callback({ id: 10 }); return Promise.resolve({ id: 10 }); } },
    tabs: { onActivated, ...Object.fromEntries(['onCreated', 'onUpdated', 'onRemoved', 'onAttached', 'onDetached', 'onMoved'].map(name => [name, listeners()])),
        async query(query) { return structuredClone(tabs.filter(tab => (!query.windowId || tab.windowId === query.windowId) && (!query.active || tab.active) && (query.pinned === undefined || query.pinned === tab.pinned))); },
        async get(id, callback) { const result = structuredClone(tabs.find(tab => tab.id === id)); callback?.(result); return result; } },
    bookmarks: { ...Object.fromEntries(['onChanged', 'onMoved', 'onRemoved'].map(name => [name, listeners()])), async get(id) { await hooks.bookmarkGet?.(id); return structuredClone(nodes().filter(node => node.id === id)); },
        async search({ title }) { return structuredClone(nodes().filter(node => node.title === title)); },
        async getChildren(id) { return structuredClone((getNode(id)?.children || []).map(node => ({ ...node, parentId: id }))); },
        async move(id, { parentId, index }) {
            const node = getNode(id), parent = nodes().find(item => item.children?.some(child => child.id === id));
            if (!node || !parent) throw new Error('Missing bookmark');
            const oldParent = getNode(parent.id);
            oldParent.children.splice(oldParent.children.findIndex(child => child.id === id), 1);
            getNode(parentId).children.splice(index, 0, node);
            writes.push({ kind: 'move', id, parentId, index });
            await chrome.bookmarks.onMoved.emit(id, { parentId, oldParentId: parent.id, index });
            return structuredClone(node);
        },
        async create(data) { const node = { ...data, id: `created-${nextId++}` }; getNode(data.parentId).children.splice(data.index, 0, node); writes.push({ kind: 'create', id: node.id }); await hooks.afterCreate?.(node); return structuredClone(node); },
        async remove(id) {
            const parent = nodes().find(item => item.children?.some(child => child.id === id));
            const [node] = getNode(parent.id).children.splice(getNode(parent.id).children.findIndex(child => child.id === id), 1);
            writes.push({ kind: 'remove', id });
            await chrome.bookmarks.onRemoved.emit(id, { parentId: parent.id, node });
            await hooks.afterRemove?.(id);
        }
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
async function reset({ inverted = false, todayInverted = false, empty = false } = {}) {
    resetData();
    settings.invertTabOrder = inverted;
    local.todayOrderRepresentation = { version: 1, inverted: todayInverted };
    if (empty) { getNode('p').children = []; storedSpaces[0].spaceBookmarks = []; storedSpaces[0].temporaryTabs = [1, 2, 3]; local.pinnedTabStatesById = {}; }
    await onChanged.emit({ spaces: { newValue: structuredClone(storedSpaces) } }, 'local');
    await chrome.runtime.onMessage.emit({ action: 'arcifyBookmarksChanged' });
    await wait(180);
    alerts = []; writes = [];
}
async function drop(source, target, y) {
    const handle = source.classList.contains('folder') ? source.querySelector(':scope > .folder-header') : source;
    drag(handle, 'dragstart'); drag(target, 'dragover', y);
    drag(target, 'drop', y); drag(handle, 'dragend'); await wait(180);
}

test('actual sidebar persists folder reorder and keeps every descendant identity', async () => {
    await reset(); const before = allIds();
    assert.equal(row('f').firstElementChild.draggable, true);
    rect(row('a'), 80);
    await drop(row('f'), row('a'), 81);
    assert.deepEqual(ids('p'), ['f', 'a', 'g', 'c']);
    assert.deepEqual(ids('f'), ['b', 'closed']);
    assert.deepEqual(allIds(), before);
    assert(writes.length > 0 && writes.every(write => write.kind === 'move'));
    assert.deepEqual(alerts, []);
});

test('actual sidebar nests an empty folder, then moves it back beside the whole parent', async () => {
    await reset(); const before = allIds();
    rect(row('f').firstElementChild, 80, 32);
    await drop(row('g'), row('f').firstElementChild, 96);
    assert.deepEqual(ids('p'), ['a', 'f', 'c']); assert.deepEqual(ids('f'), ['b', 'closed', 'g']);
    rect(row('f').firstElementChild, 80, 32);
    await drop(row('g'), row('f').firstElementChild, 111);
    assert.deepEqual(ids('p'), ['a', 'f', 'g', 'c']); assert.deepEqual(ids('f'), ['b', 'closed']);
    assert.deepEqual(allIds(), before); assert.deepEqual(alerts, []);
});

for (const inverted of [false, true]) test(`projected open tab drops preserve canonical bookmark order (inverted=${inverted})`, async () => {
    await reset({ inverted });
    assert.equal(row('b').parentElement.className, 'folder-collapsed-tabs');
    rect(row('c'), 100);
    await drop(row('b'), row('c'), 101);
    assert.deepEqual(ids('f'), ['closed']);
    assert.deepEqual(ids('p'), inverted ? ['a', 'f', 'g', 'c', 'b'] : ['a', 'f', 'g', 'b', 'c']);
    assert.deepEqual(alerts, []);
});

test('dropping after a projected row uses the hidden sibling as its persisted insertion reference', async () => {
    await reset(); rect(row('b'), 100);
    await drop(row('c'), row('b'), 126);
    assert.deepEqual(ids('f'), ['b', 'c', 'closed']); assert.deepEqual(ids('p'), ['a', 'f', 'g']);
    assert.deepEqual(alerts, []);
});

test('folder self/cycle and temporary-section attempts do not mutate bookmark or visible hierarchy', async () => {
    await reset(); const before = allIds(), order = ids('p');
    rect(row('b'), 100);
    await drop(row('f'), row('b'), 101);
    await drop(row('f'), temporary(), 101);
    await drop(row('c'), temporary(), 101);
    assert.deepEqual(ids('p'), order); assert.deepEqual(allIds(), before);
    assert.equal(row('f').parentElement, root()); assert.equal(row('c').parentElement, root());
    assert.deepEqual(writes, []); assert.deepEqual(alerts, []);
});

test('temporary-to-pinned insertion creates exactly one bookmark at the indicated empty slot', async () => {
    await reset({ empty: true });
    const source = temporary().querySelector('[data-tab-id="3"]');
    await drop(source, root(), 20);
    assert.equal(ids('p').length, 1);
    assert.equal(getNode(ids('p')[0]).url, tabs[2].url);
    assert.equal(writes.filter(write => write.kind === 'create').length, 1);
    assert(storedSpaces[0].spaceBookmarks.includes(3));
    assert(!storedSpaces[0].temporaryTabs.includes(3));
    assert.deepEqual(alerts, []);
});

test('Escape and leaving a folder cancel the delayed auto-open and remove feedback', async () => {
    for (const cancel of ['Escape', 'dragleave']) {
        await reset(); const source = row('c'), header = row('f').firstElementChild;
        rect(header, 80, 32);
        drag(source, 'dragstart'); drag(header, 'dragover', 96);
        assert(header.classList.contains('sidebar-drop-inside'));
        if (cancel === 'Escape') { const event = new window.Event('keydown', { bubbles: true }); event.key = 'Escape'; document.dispatchEvent(event); }
        else drag(root(), 'dragleave', 96, { relatedTarget: temporary() });
        await wait(280);
        assert(row('f').classList.contains('collapsed'));
        assert.equal(header.classList.contains('sidebar-drop-inside'), false);
        assert.equal(document.querySelector('.sidebar-drop-anchor').hidden, true);
        drag(source, 'dragend');
        assert.deepEqual(writes, []);
    }
});

test('a stale bookmark baseline fails safely and restores the saved tree', async () => {
    await reset();
    const source = row('f'); rect(row('a'), 80);
    drag(source.firstElementChild, 'dragstart'); drag(row('a'), 'dragover', 81);
    getNode('p').children.reverse(); // Simulate another editor before this drop commits.
    const saved = ids('p');
    drag(row('a'), 'drop', 81); drag(source.firstElementChild, 'dragend'); await wait(180);
    assert.deepEqual(ids('p'), saved); assert.deepEqual(writes, []);
    assert.equal(alerts.length, 1); assert.match(alerts[0], /changed before/);
    assert.deepEqual([...root().children].filter(element => element.dataset.bookmarkId).map(element => element.dataset.bookmarkId), saved);
});

for (const inverted of [false, true]) for (const todayInverted of [false, true]) test(`live pin-to-temporary drop keeps all other bookmarks and the indicated tab order (bookmarks=${inverted}, Today=${todayInverted})`, async () => {
    await reset({ inverted, todayInverted });
    const target = temporary().querySelector('[data-tab-id="3"]'); rect(target, 100);
    await drop(row('a'), target, 101);
    assert.deepEqual(ids('p'), ['f', 'g', 'c']); assert.deepEqual(ids('f'), ['b', 'closed']);
    assert.deepEqual(storedSpaces[0].temporaryTabs, todayInverted ? [3, 1] : [1, 3]);
    assert.deepEqual([...temporary().querySelectorAll('.tab[data-tab-id]')].map(row => Number(row.dataset.tabId)), [1, 3]);
    assert.deepEqual(writes, [{ kind: 'remove', id: 'a' }]);
    assert.deepEqual(alerts, []);
});

test('temporary tab reorder persists the indicated slot without touching bookmarks', async () => {
    await reset({ empty: true });
    const source = temporary().querySelector('[data-tab-id="1"]');
    const target = temporary().querySelector('[data-tab-id="3"]'); rect(target, 100);
    await drop(source, target, 128);
    assert.deepEqual(storedSpaces[0].temporaryTabs, [2, 3, 1]);
    assert.deepEqual(writes, []); assert.deepEqual(alerts, []);
});

test('hover opens a collapsed folder without changing its resolved inside destination', async () => {
    await reset(); const source = row('c'), header = row('f').firstElementChild; rect(header, 80, 32);
    drag(source, 'dragstart'); drag(header, 'dragover', 96);
    assert(header.classList.contains('sidebar-drop-inside'));
    await wait(280);
    assert.equal(row('f').classList.contains('collapsed'), false);
    assert(header.classList.contains('sidebar-drop-inside'));
    drag(header, 'drop', 96); drag(source, 'dragend'); await wait(180);
    assert.deepEqual(ids('f'), ['b', 'closed', 'c']);
    assert.deepEqual(alerts, []);
});

test('folder sync policy rejects nesting before showing feedback or saving', async () => {
    await reset();
    settings.syncTabGroups = true;
    await onChanged.emit({ syncTabGroups: { newValue: true } }, 'sync');
    rect(row('f').firstElementChild, 80, 32);
    const source = row('g'), header = row('f').firstElementChild;
    drag(source.firstElementChild, 'dragstart');
    const over = drag(header, 'dragover', 96);
    assert.equal(over.defaultPrevented, false);
    assert.equal(header.classList.contains('sidebar-drop-inside'), false);
    drag(header, 'drop', 96); drag(source.firstElementChild, 'dragend'); await wait(180);
    assert.deepEqual(ids('p'), ['a', 'f', 'g', 'c']); assert.deepEqual(writes, []); assert.deepEqual(alerts, []);
    settings.syncTabGroups = false;
    await onChanged.emit({ syncTabGroups: { newValue: false } }, 'sync');
});

test('a folder cannot advertise the native Chrome favorites strip as a drop destination', async () => {
    await reset(); const source = row('f');
    drag(source.firstElementChild, 'dragstart');
    const favorites = document.getElementById('pinnedFavicons');
    const event = drag(favorites, 'dragover', 25);
    assert.equal(event.defaultPrevented, false);
    assert.equal(event.dataTransfer.dropEffect, 'none');
    assert.equal(favorites.classList.contains('drag-over'), false);
    assert.equal(document.querySelector('.drop-indicator-vertical'), null);
    drag(source.firstElementChild, 'dragend');
    assert.deepEqual(writes, []);
});


async function resetSpaces() {
    await reset();
    for (const id of ['beta', 'gamma']) {
        storedSpaces.push({ id, name: id, color: 'blue', bookmarkFolderId: id, spaceBookmarks: [], temporaryTabs: [] });
        tree.children.push({ id, title: id, children: [] });
    }
    await onChanged.emit({ spaces: { newValue: structuredClone(storedSpaces) } }, 'local');
    await wait(180);
}
const spaceChips = () => [...document.querySelectorAll('#spaceSwitcher button[data-space-id]')];
const chipIds = () => spaceChips().map(button => button.dataset.spaceId);
function spaceRects() {
    spaceChips().forEach((button, index) => { button._rect = { left: index * 90, width: 80, right: index * 90 + 80, top: 720, bottom: 752, height: 32 }; });
}

test('actual sidebar Space drag saves relative order, preserves membership/selection and does not touch bookmarks', async () => {
    await resetSpaces(); spaceRects();
    const baseline = structuredClone(storedSpaces), active = structuredClone(session.activeSpaces);
    const source = spaceChips()[2], target = spaceChips()[0];
    drag(source, 'dragstart', 730); drag(target, 'dragover', 730, { clientX: 1 });
    assert(target.classList.contains('space-drop-before'));
    drag(target, 'drop', 730, { clientX: 1 });
    drag(source, 'click', 730, { detail: 1 }); drag(source, 'dragend', 730);
    await wait(180);
    assert.deepEqual(chipIds(), ['gamma', 'alpha', 'beta']);
    assert.deepEqual(storedSpaces.map(space => space.id), chipIds());
    assert.deepEqual(session.activeSpaces, active);
    for (const space of storedSpaces) assert.deepEqual(space, baseline.find(old => old.id === space.id));
    assert.deepEqual(writes, []); assert.deepEqual(alerts, []);
});

test('actual sidebar defers bookmark/storage refresh during Space drag and cancels cleanly', async () => {
    await resetSpaces(); spaceRects();
    const source = spaceChips()[2]; drag(source, 'dragstart', 730);
    storedSpaces[0].name = 'Renamed Alpha'; tree.children[0].title = 'Renamed Alpha';
    await onChanged.emit({ spaces: { newValue: structuredClone(storedSpaces) } }, 'local');
    await chrome.runtime.onMessage.emit({ action: 'arcifyBookmarksChanged' });
    await wait(180); assert(source.isConnected); assert.equal(spaceChips()[0].querySelector('.space-switcher-name').textContent, 'Alpha');
    drag(document, 'keydown', 730, { key: 'Escape' }); await wait(180);
    assert.deepEqual(chipIds(), ['alpha', 'beta', 'gamma']);
    assert.equal(spaceChips()[0].querySelector('.space-switcher-name').textContent, 'Renamed Alpha');
    assert.equal(document.querySelector('.dragging-switcher'), null); assert.deepEqual(writes, []);
});

test('actual sidebar keyboard ordering persists and repeated renders install one handler', async () => {
    await resetSpaces();
    for (let i = 0; i < 3; i++) {
        await chrome.runtime.onMessage.emit({ action: 'arcifyBookmarksChanged' }); await wait(150);
    }
    drag(spaceChips()[2], 'keydown', 730, { key: 'ArrowLeft', altKey: true, shiftKey: true });
    await wait(180); assert.deepEqual(chipIds(), ['alpha', 'gamma', 'beta']);
    drag(spaceChips()[1], 'keydown', 730, { key: 'ArrowLeft', altKey: true, shiftKey: true });
    await wait(180); assert.deepEqual(chipIds(), ['gamma', 'alpha', 'beta']);
    assert.deepEqual(storedSpaces.map(space => space.id), chipIds());
    assert.deepEqual(writes, []); assert.equal(session.activeSpaces[10], 'alpha');
});


test('actual sidebar rapid keyboard moves use the acknowledged order before scheduled refresh', async () => {
    await resetSpaces();
    drag(spaceChips()[0], 'keydown', 730, { key: 'ArrowRight', altKey: true, shiftKey: true });
    await wait(10); assert.deepEqual(chipIds(), ['beta', 'alpha', 'gamma']);
    drag(spaceChips()[1], 'keydown', 730, { key: 'ArrowRight', altKey: true, shiftKey: true });
    await wait(10); assert.deepEqual(chipIds(), ['beta', 'gamma', 'alpha']);
    assert.deepEqual(storedSpaces.map(space => space.id), chipIds());
    await wait(180); assert.deepEqual(chipIds(), ['beta', 'gamma', 'alpha']);
});

test('native Split rows cannot start ordinary sidebar drag', async () => {
    tabs[1].splitViewId = 71;
    try {
        await reset();
        const source = row('b'), before = structuredClone(storedSpaces), bookmarkIds = allIds();
        const start = drag(source, 'dragstart');
        assert(start.defaultPrevented); assert.equal(document.querySelector('.dragging'), null);
        assert.match(document.getElementById('favoritesDropNotice').textContent, /End Split View/);
        assert.deepEqual(storedSpaces, before); assert.deepEqual(allIds(), bookmarkIds); assert.deepEqual(writes, []);
    } finally { delete tabs[1].splitViewId; }
});

test('a native split appearing during drag is rejected before a projected bookmark or anchor can move', async () => {
    await reset(); const source = row('b'), target = row('c'), before = structuredClone(storedSpaces), beforeTree = structuredClone(tree);
    rect(target, 100); drag(source, 'dragstart'); drag(target, 'dragover', 101);
    tabs[1].splitViewId = 72;
    try {
        drag(target, 'drop', 101); drag(source, 'dragend'); await wait(200);
        assert.deepEqual(tree, beforeTree); assert.deepEqual(storedSpaces, before); assert.deepEqual(writes, []);
        assert(alerts.some(message => /End Split View/.test(message)));
        assert.equal(row('b').parentElement.className, 'folder-collapsed-tabs'); assert.deepEqual(ids('f'), ['b', 'closed']);
    } finally { delete tabs[1].splitViewId; }
});


for (const phase of ['root-read', 'created', 'binding-read', 'binding-write']) test(`quick pin rechecks native split at ${phase} boundary`, async () => {
    await reset(); const before = structuredClone(storedSpaces), beforeBindings = structuredClone(local.pinnedTabStatesById);
    if (phase === 'root-read') hooks.bookmarkGet = async id => { if (id === 'p') { hooks.bookmarkGet = null; tabs[2].splitViewId = 81; } };
    else hooks.afterCreate = async () => {
        hooks.afterCreate = null;
        if (phase === 'created') tabs[2].splitViewId = 81;
        else if (phase === 'binding-read') hooks.storageRead = async key => { if (key === 'pinnedTabStatesById') { hooks.storageRead = null; tabs[2].splitViewId = 81; } };
        else hooks.storageSet = async next => { if (next.pinnedTabStatesById) { hooks.storageSet = null; tabs[2].splitViewId = 81; } };
    };
    try {
        await chrome.runtime.onMessage.emit({ command: 'toggleSpacePin', tabId: 3 }); await wait(220);
        assert.deepEqual(storedSpaces, before); assert.deepEqual(local.pinnedTabStatesById, beforeBindings);
        assert.equal(writes.filter(write => write.kind === 'create').length, phase === 'root-read' ? 0 : 1);
        const message = document.getElementById('favoritesDropNotice').textContent;
        assert.match(message, /End Split View/);
        if (phase !== 'root-read') assert.match(message, /bookmark was saved.*live-tab update.*Nothing was retried/);
        await chrome.runtime.onMessage.emit({ action: 'arcifyBookmarksChanged' }); await wait(180);
        assert(temporary().querySelector('[data-tab-id="3"]')); assert.deepEqual(local.pinnedTabStatesById, beforeBindings); assert.deepEqual(storedSpaces, before);
    } finally { hooks = {}; delete tabs[2].splitViewId; }
});

for (const phase of ['root-read', 'created', 'binding-read', 'binding-write']) test(`live bookmark drop rechecks native split at ${phase} boundary`, async () => {
    await reset(); const before = structuredClone(storedSpaces), beforeBindings = structuredClone(local.pinnedTabStatesById);
    const source = temporary().querySelector('[data-tab-id="3"]'), target = row('c'); rect(target, 100);
    if (phase === 'root-read') hooks.bookmarkGet = async id => { if (id === 'p') { hooks.bookmarkGet = null; tabs[2].splitViewId = 82; } };
    else hooks.afterCreate = async () => {
        hooks.afterCreate = null;
        if (phase === 'created') tabs[2].splitViewId = 82;
        else if (phase === 'binding-read') hooks.storageRead = async key => { if (key === 'pinnedTabStatesById') { hooks.storageRead = null; tabs[2].splitViewId = 82; } };
        else hooks.storageSet = async next => { if (next.pinnedTabStatesById) { hooks.storageSet = null; tabs[2].splitViewId = 82; } };
    };
    try {
        await drop(source, target, 101);
        assert.deepEqual(storedSpaces, before); assert.deepEqual(local.pinnedTabStatesById, beforeBindings);
        assert.equal(writes.filter(write => write.kind === 'create').length, phase === 'root-read' ? 0 : 1);
        assert(alerts.some(message => /End Split View/.test(message)));
        if (phase !== 'root-read') assert(alerts.some(message => /bookmark was saved.*live-tab update.*Nothing was retried/.test(message)));
        await chrome.runtime.onMessage.emit({ action: 'arcifyBookmarksChanged' }); await wait(180);
        assert(temporary().querySelector('[data-tab-id="3"]')); assert.deepEqual(local.pinnedTabStatesById, beforeBindings); assert.deepEqual(storedSpaces, before);
    } finally { hooks = {}; delete tabs[2].splitViewId; }
});


for (const phase of ['lookup', 'deleted', 'binding-write']) test(`saved-pin demotion stops native split at ${phase} without changing ownership`, async () => {
    await reset(); const before = structuredClone(storedSpaces), bindings = structuredClone(local.pinnedTabStatesById);
    if (phase === 'lookup') hooks.bookmarkGet = async id => { if (id === 'p') { hooks.bookmarkGet = null; tabs[1].splitViewId = 91; } };
    else hooks.afterRemove = async () => {
        hooks.afterRemove = null;
        if (phase === 'deleted') tabs[1].splitViewId = 91;
        else hooks.storageSet = async next => { if (next.pinnedTabStatesById) { hooks.storageSet = null; tabs[1].splitViewId = 91; } };
    };
    try {
        await drop(row('b'), temporary(), 101);
        assert.deepEqual(storedSpaces, before); assert.deepEqual(local.pinnedTabStatesById, bindings);
        assert.equal(writes.filter(write => write.kind === 'remove').length, phase === 'lookup' ? 0 : 1);
        assert(alerts.some(message => /End Split View/.test(message)));
        if (phase !== 'lookup') assert(alerts.some(message => /saved pin was removed.*Nothing was retried or recreated/.test(message)));
        await chrome.runtime.onMessage.emit({ action: 'arcifyBookmarksChanged' }); await wait(180);
        assert.deepEqual(storedSpaces, before); assert.deepEqual(local.pinnedTabStatesById, bindings);
        assert(document.querySelector('#spacesList [data-tab-id="2"]'), 'The same native tab remains represented even when a deleted bookmark requires fallback rendering');
    } finally { hooks = {}; delete tabs[1].splitViewId; }
});

// Folder toggles stay immediate even while the real sidebar builds a detached
// replacement. Gate recovery too, so a transient stale commit cannot be hidden
// by a later correct repaint.
function renderGate() {
    let reached, release, entered = false;
    const ready = new Promise(resolve => { reached = resolve; });
    const blocked = new Promise(resolve => { release = resolve; });
    return { ready, release, get entered() { return entered; }, async pause() { entered = true; reached(); await blocked; } };
}
async function until(predicate, message) {
    const deadline = Date.now() + 2500;
    while (!predicate()) {
        assert(Date.now() < deadline, message);
        await wait(5);
    }
}
async function reached(gate) {
    let timer;
    try { await Promise.race([gate.ready, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Render gate not reached')), 2500); })]); }
    finally { clearTimeout(timer); }
}
function toggleFolder(id = 'f') {
    row(id).querySelector(':scope > .folder-header').dispatchEvent(new window.Event('click', { bubbles: true }));
}
function assertFolder(collapsed) {
    assert.equal(row('f').classList.contains('collapsed'), collapsed);
    assert.equal(row('f').getAttribute('aria-expanded'), String(!collapsed));
    assert.equal(row('f').querySelector(':scope > .folder-content').classList.contains('collapsed'), collapsed);
    assert.equal(row('f').querySelector('.folder-toggle').getAttribute('aria-expanded'), String(!collapsed));
    assert.equal(row('b').parentElement.className, collapsed ? 'folder-collapsed-tabs' : 'folder-content');
    assert.equal(document.querySelectorAll('#spacesList [data-bookmark-id="b"]').length, 1);
}
async function startFolderRefresh(path) {
    if (path === 'coordinator') await chrome.runtime.onMessage.emit({ action: 'arcifyBookmarksChanged' });
    // Settings now coalesce through the coordinator. The native attachment
    // handler still has a real direct-render path; dispatch without awaiting
    // the deliberate render gate, and surface any asynchronous failure.
    else {
        // This race deliberately targets a full saved-tree read. A Today-only
        // attachment can now correctly skip it, so establish a bookmark revision
        // first without scheduling a coordinator render or mutating fixture data.
        await chrome.bookmarks.onChanged.emit('f', { title: getNode('f').title });
        void chrome.tabs.onAttached.emit(2, { newWindowId: 10 }).catch(error => alerts.push(error.message));
    }
}
function folderRaceViewport() {
    const content = root().closest('.space-content');
    const originalRect = window.HTMLElement.prototype.getBoundingClientRect;
    const originalFocus = window.HTMLElement.prototype.focus;
    let focused = document.body, top = 400;
    const scrollWrites = [];
    Object.defineProperty(document, 'activeElement', { configurable: true, get: () => focused });
    window.HTMLElement.prototype.focus = function (options) { focused = this; this.focusOptions = options; };
    Object.defineProperties(content, {
        scrollHeight: { configurable: true, value: 1200 },
        clientHeight: { configurable: true, value: 210 },
        scrollTop: { configurable: true, get: () => top, set(value) { top = value; scrollWrites.push(value); } }
    });
    window.HTMLElement.prototype.getBoundingClientRect = function () {
        // The active bookmark is deliberately offscreen. An accidental reveal
        // during folder-state recovery would visibly change scrollTop.
        const top = this.dataset.tabId === '2' ? -300 : 10;
        if (this === content) return { top: 0, bottom: 210, left: 0, right: 280, width: 280, height: 210 };
        return { top, bottom: top + 30, left: 0, right: 280, width: 280, height: 30 };
    };
    row('f').querySelector('.folder-toggle').focus();
    return {
        assert() {
            assert.equal(content.scrollTop, 400);
            assert(scrollWrites.every(value => value === 400), 'Folder recovery must never transiently reveal the offscreen active tab');
            assert(document.activeElement === row('f').querySelector('.folder-toggle'), 'Focus must stay on the managed folder control');
        },
        restore() {
            window.HTMLElement.prototype.getBoundingClientRect = originalRect;
            window.HTMLElement.prototype.focus = originalFocus;
            delete document.activeElement;
            for (const property of ['scrollHeight', 'clientHeight', 'scrollTop']) delete content[property];
        }
    };
}
function folderRaceBaseline() {
    const baseline = structuredClone({ tree, storedSpaces, tabs, session, bindings: local.pinnedTabStatesById });
    return () => {
        assert.deepEqual({ tree, storedSpaces, tabs, session, bindings: local.pinnedTabStatesById }, baseline,
            'A folder repaint cannot change bookmarks, tab ownership, bindings, selection or browser tabs');
        assert.deepEqual(writes, []);
        assert.deepEqual(alerts, []);
    };
}

for (const path of ['coordinator', 'direct']) {
    for (const scenario of ['expand', 'collapse', 'rapid toggles']) test(`folder ${scenario} survives an older ${path} render without a stale commit`, async () => {
        await reset();
        if (scenario === 'collapse') {
            toggleFolder();
            await until(() => local['folderCollapsed:f'] === false, 'Initial expansion must persist');
        }
        const old = row('f'), oldRender = renderGate(), recovery = renderGate();
        const viewport = folderRaceViewport(), assertUnchanged = folderRaceBaseline();
        const folderWrites = [];
        let reads = 0;
        hooks.storageRead = key => (Array.isArray(key) && key.includes('folderCollapsed:g')) ? (++reads === 1 ? oldRender.pause() : reads === 2 ? recovery.pause() : undefined) : undefined;
        hooks.storageSet = next => { if ('folderCollapsed:f' in next) folderWrites.push(next['folderCollapsed:f']); };
        const collapsed = scenario === 'collapse';
        try {
            await startFolderRefresh(path); await reached(oldRender);
            assert(row('f') === old);
            toggleFolder(); assertFolder(collapsed); viewport.assert();
            if (scenario === 'rapid toggles') {
                toggleFolder(); assertFolder(true);
                toggleFolder(); assertFolder(false);
            }
            await until(() => folderWrites.length === (scenario === 'rapid toggles' ? 3 : 1), 'Every toggle must persist in order');
            assert.deepEqual(folderWrites, scenario === 'rapid toggles' ? [false, true, false] : [collapsed]);
            oldRender.release();
            await until(() => recovery.entered || row('f') !== old, 'Recovery must start after rejecting the old render');
            assert(row('f') === old, 'The stale detached tree must never replace the clicked folder');
            await reached(recovery);
            assertFolder(collapsed); viewport.assert();
            recovery.release();
            await until(() => row('f') !== old, 'A fresh repaint must complete');
            assertFolder(collapsed); viewport.assert();
            assert.deepEqual(document.activeElement.focusOptions, { preventScroll: true });
            assert.equal(local['folderCollapsed:f'], collapsed);
            assertUnchanged();
        } finally {
            hooks = {}; oldRender.release(); recovery.release(); viewport.restore();
            await wait(150);
        }
    });

    test(`folder toggle fences a pending ${path} storage read and waits for its durable write`, async () => {
        await reset();
        const old = row('f'), oldRead = renderGate(), write = renderGate(), recovery = renderGate();
        const viewport = folderRaceViewport(), assertUnchanged = folderRaceBaseline();
        let first = true, recovering = false;
        hooks.storageReadResult = (key, result) => {
            if (Array.isArray(key) && key.includes('folderCollapsed:f') && first) {
                first = false; assert.equal(result['folderCollapsed:f'], true); return oldRead.pause();
            }
        };
        hooks.beforeStorageSet = next => 'folderCollapsed:f' in next ? write.pause() : undefined;
        hooks.storageRead = key => Array.isArray(key) && key.includes('folderCollapsed:g') && recovering ? recovery.pause() : undefined;
        try {
            await startFolderRefresh(path); await reached(oldRead);
            toggleFolder(); assertFolder(false); await reached(write);
            assert.equal(local['folderCollapsed:f'], true, 'The test holds the write before persistence');
            oldRead.release();
            await wait(180); // Let recovery start; its folder read must wait for the held write.
            assert(row('f') === old, 'Neither the old render nor recovery may replace the live toggle with unpersisted state');
            assertFolder(false); viewport.assert();
            recovering = true; write.release(); await reached(recovery);
            assert(row('f') === old); assert.equal(local['folderCollapsed:f'], false);
            recovery.release();
            await until(() => row('f') !== old, 'Recovery must finish after the pending write');
            assertFolder(false); viewport.assert(); assertUnchanged();
        } finally {
            hooks = {}; oldRead.release(); write.release(); recovery.release(); viewport.restore();
            await wait(150);
        }
    });

    for (const change of [false, undefined]) test(`external folder state ${change === false ? 'expansion' : 'removal'} invalidates an older ${path} render`, async () => {
        await reset();
        if (change === undefined) {
            toggleFolder();
            await until(() => local['folderCollapsed:f'] === false, 'Initial expansion must persist');
        }
        const old = row('f'), oldRender = renderGate(), recovery = renderGate();
        const viewport = folderRaceViewport(), assertUnchanged = folderRaceBaseline();
        let reads = 0;
        hooks.storageRead = key => (Array.isArray(key) && key.includes('folderCollapsed:g')) ? (++reads === 1 ? oldRender.pause() : reads === 2 ? recovery.pause() : undefined) : undefined;
        try {
            await startFolderRefresh(path); await reached(oldRender);
            const oldValue = local['folderCollapsed:f'];
            if (change === undefined) delete local['folderCollapsed:f'];
            else local['folderCollapsed:f'] = change;
            await onChanged.emit({ 'folderCollapsed:f': { oldValue, newValue: change } }, 'local');
            oldRender.release();
            await until(() => recovery.entered || row('f') !== old, 'Recovery must start after the external state change');
            assert(row('f') === old, 'An external state event fences direct renders as well as coordinated renders');
            await reached(recovery);
            recovery.release();
            await until(() => row('f') !== old, 'External state change must repaint');
            assertFolder(change !== false); viewport.assert(); assertUnchanged();
        } finally {
            hooks = {}; oldRender.release(); recovery.release(); viewport.restore();
            await wait(150);
        }
    });
}

test('folder storage changes repaint an idle sidebar without affecting unrelated or sync storage', async () => {
    await reset();
    const original = row('f'), viewport = folderRaceViewport(), assertUnchanged = folderRaceBaseline();
    try {
        await onChanged.emit({ unrelated: { newValue: 1 } }, 'local');
        await onChanged.emit({ 'folderCollapsed:f': { newValue: false } }, 'sync');
        await wait(160);
        assert(row('f') === original);
        local['folderCollapsed:f'] = false;
        await onChanged.emit({ 'folderCollapsed:f': { oldValue: true, newValue: false } }, 'local');
        await until(() => row('f') !== original, 'An idle sidebar must receive the changed folder state');
        assertFolder(false); viewport.assert(); assertUnchanged();
    } finally { viewport.restore(); await wait(150); }
});

for (const todayInverted of [false, true]) test(`saved reversal and prospective placement cannot reorder existing Today rows (frozen=${todayInverted})`, async () => {
    await reset({ todayInverted });
    tabs.push(...[4, 5].map(id => ({ id, windowId: 10, pinned: false, active: false, title: `Tab ${id}`, url: `https://tab-${id}.test/` })));
    storedSpaces[0].temporaryTabs = [3, 4, 5];
    try {
        await onChanged.emit({ spaces: { newValue: structuredClone(storedSpaces) } }, 'local'); await wait(180);
        const before = structuredClone(storedSpaces), bookmarkIds = allIds();
        for (const bookmarkInverted of [true, false]) for (const newTabsAtTop of [true, false]) {
            settings.invertTabOrder = bookmarkInverted; settings.todayNewTabsAtTop = newTabsAtTop;
            await onChanged.emit({ invertTabOrder: { newValue: bookmarkInverted }, todayNewTabsAtTop: { newValue: newTabsAtTop } }, 'sync'); await wait(180);
            assert.deepEqual([...temporary().querySelectorAll('.tab[data-tab-id]')].map(row => Number(row.dataset.tabId)), todayInverted ? [5, 4, 3] : [3, 4, 5]);
            assert.deepEqual([...root().children].filter(row => row.dataset.bookmarkId).map(row => row.dataset.bookmarkId), bookmarkInverted ? ['c', 'g', 'f', 'a'] : ['a', 'f', 'g', 'c']);
            assert.deepEqual(storedSpaces, before); assert.deepEqual(allIds(), bookmarkIds); assert.deepEqual(writes, []);
            assert.equal(temporary().dataset.todayOrderInverted, String(todayInverted));
        }
    } finally { tabs.splice(3); delete settings.todayNewTabsAtTop; await reset(); }
});

for (const todayInverted of [false, true]) for (const inverted of [false, true]) {
    test(`unavailable bookmark tree preserves saved-pin and Today orders independently (Today=${todayInverted}, saved=${inverted})`, async () => {
        await reset({ todayInverted, inverted });
        tabs.push({ id: 4, windowId: 10, pinned: false, active: false, title: 'Other Today tab', url: 'https://tab-4.test/' });
        storedSpaces[0].temporaryTabs = [3, 4];
        const before = structuredClone(storedSpaces), beforeTree = structuredClone(tree), beforeBindings = structuredClone(local.pinnedTabStatesById);
        try {
            hooks.bookmarkGet = id => { if (id === 'p') throw new Error('Bookmark tree unavailable'); };
            await onChanged.emit({ spaces: { newValue: structuredClone(storedSpaces) } }, 'local');
            await chrome.runtime.onMessage.emit({ action: 'arcifyBookmarksChanged' }); await wait(180);
            assert(root().querySelector('.bookmark-association-error'));
            const fallback = [...temporary().querySelectorAll('.favorite-fallback')];
            const today = [...temporary().querySelectorAll('.tab:not(.favorite-fallback)')];
            assert.deepEqual(fallback.map(row => Number(row.dataset.tabId)), inverted ? [2, 1] : [1, 2]);
            assert.deepEqual(today.map(row => Number(row.dataset.tabId)), todayInverted ? [4, 3] : [3, 4]);
            assert.deepEqual(fallback.map(row => row.dataset.bookmarkId), inverted ? ['b', 'a'] : ['a', 'b']);
            assert(fallback.every(row => !row.draggable));
            const allRows = [...temporary().querySelectorAll('.tab[data-tab-id]')];
            assert.equal(allRows.length, 4); assert.equal(new Set(allRows.map(row => row.dataset.tabId)).size, 4);
            assert.deepEqual(storedSpaces, before); assert.deepEqual(tree, beforeTree);
            assert.deepEqual(local.pinnedTabStatesById, beforeBindings); assert.deepEqual(writes, []);
            delete hooks.bookmarkGet;
            await chrome.runtime.onMessage.emit({ action: 'arcifyBookmarksChanged' }); await wait(180);
            assert.equal(temporary().querySelector('.favorite-fallback'), null);
            assert.deepEqual([...temporary().querySelectorAll('.tab[data-tab-id]')].map(row => Number(row.dataset.tabId)), todayInverted ? [4, 3] : [3, 4]);
            assert.equal(root().querySelectorAll('[data-tab-id="1"]').length, 1);
            assert.equal(root().querySelectorAll('[data-tab-id="2"]').length, 1);
            assert.deepEqual(storedSpaces, before); assert.deepEqual(writes, []);
        } finally { delete hooks.bookmarkGet; tabs.splice(3); await reset(); }
    });
}
for (const todayInverted of [false, true]) for (const closePeer of [false, true]) test(`new Today top survives an actual stale sidebar drag inverted=${todayInverted} closePeer=${closePeer}`, async () => {
    const originalTabs = structuredClone(tabs);
    await reset({ empty: true, todayInverted }); settings.todayNewTabsAtTop = true;
    const sourceId = todayInverted ? 1 : 3, targetId = todayInverted ? 3 : 1;
    const source = temporary().querySelector(`[data-tab-id="${sourceId}"]`);
    const target = temporary().querySelector(`[data-tab-id="${targetId}"]`);
    try {
        rect(target, 80); drag(source, 'dragstart');
        tabs.push({ id: 4, windowId: 10, active: false, pinned: false, title: 'Tab 4', url: 'https://tab-4.test/' });
        if (todayInverted) storedSpaces[0].temporaryTabs.push(4);
        else storedSpaces[0].temporaryTabs.unshift(4);
        if (closePeer) {
            tabs.splice(tabs.findIndex(tab => tab.id === 2), 1);
            storedSpaces[0].temporaryTabs = storedSpaces[0].temporaryTabs.filter(id => id !== 2);
        }
        await onChanged.emit({ spaces: { newValue: structuredClone(storedSpaces) } }, 'local'); await wait(180);
        assert.deepEqual([...temporary().querySelectorAll('.tab[data-tab-id]')].map(row => Number(row.dataset.tabId)),
            todayInverted ? [3, 2, 1] : [1, 2, 3], 'drag holds the stale captured rows while refresh is busy');
        drag(target, 'dragover', 81); drag(target, 'drop', 81); drag(source, 'dragend'); await wait(180);
        const expected = todayInverted ? [2, 3, 1, 4] : [4, 3, 1, 2];
        assert.deepEqual(storedSpaces[0].temporaryTabs, closePeer ? expected.filter(id => id !== 2) : expected);
        assert.deepEqual(writes, []); assert.deepEqual(alerts, []);
    } finally {
        drag(source, 'dragend'); tabs.splice(0, tabs.length, ...originalTabs);
        delete settings.todayNewTabsAtTop; await reset();
    }
});
