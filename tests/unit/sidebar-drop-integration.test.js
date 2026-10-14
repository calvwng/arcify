import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseHTML } from 'linkedom';
import { enqueueBookmarkOperation } from '../../bookmark-writer.js';
import { applySpacePatch } from '../../space-store.js';
import { moveSpace } from '../../space-order.js';

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
let tree, writes = [], alerts = [], nextId = 10;
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
const area = state => ({ async get(keys) {
    if (typeof keys === 'string') return { [keys]: structuredClone(state[keys]) };
    return structuredClone({ ...(Array.isArray(keys) ? {} : keys), ...state });
}, async set(next) { Object.assign(state, structuredClone(next)); }, async remove() {} });
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
                try { return { success: true, ...await enqueueBookmarkOperation(message.operation) }; }
                catch (error) { return { success: false, error: error.message, code: error.code }; }
            }
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
        async get(id) { return structuredClone(tabs.find(tab => tab.id === id)); } },
    bookmarks: { async get(id) { return structuredClone(nodes().filter(node => node.id === id)); },
        async search({ title }) { return structuredClone(nodes().filter(node => node.title === title)); },
        async getChildren(id) { return structuredClone((getNode(id)?.children || []).map(node => ({ ...node, parentId: id }))); },
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

for (const inverted of [false, true]) test(`live pin-to-temporary drop keeps all other bookmarks and the indicated tab order (inverted=${inverted})`, async () => {
    await reset({ inverted });
    const target = temporary().querySelector('[data-tab-id="3"]'); rect(target, 100);
    await drop(row('a'), target, 101);
    assert.deepEqual(ids('p'), ['f', 'g', 'c']); assert.deepEqual(ids('f'), ['b', 'closed']);
    assert.deepEqual(storedSpaces[0].temporaryTabs, inverted ? [3, 1] : [1, 3]);
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
    await wait(180); assert(source.isConnected); assert.equal(spaceChips()[0].textContent, 'Alpha');
    drag(document, 'keydown', 730, { key: 'Escape' }); await wait(180);
    assert.deepEqual(chipIds(), ['alpha', 'beta', 'gamma']);
    assert.equal(spaceChips()[0].textContent, 'Renamed Alpha');
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
