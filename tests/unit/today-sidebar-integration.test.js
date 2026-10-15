import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseHTML } from 'linkedom';
import { applySpacePatch, SpaceStore } from '../../space-store.js';
import { saveTodayTabsInNewFolder } from '../../today-folder-store.js';

// The real sidebar, Chrome listeners, close buttons and refresh coordinator are
// exercised together. Only Chrome persistence and DOM layout/focus are fakes.
const { window } = parseHTML(await readFile(new URL('../../sidebar.html', import.meta.url), 'utf8'));
const { document } = window;
const listeners = () => {
    const callbacks = [];
    return { addListener(callback) { callbacks.push(callback); },
        async emit(...args) { await Promise.all(callbacks.map(callback => callback(...args))); } };
};
const onChanged = listeners(), onMessage = listeners();
let focused = document.body;
Object.defineProperty(document, 'activeElement', { get: () => focused });
window.HTMLElement.prototype.focus = function (options) { focused = this; this.focusOptions = options; };
window.HTMLElement.prototype.blur = function () { if (focused === this) focused = document.body; };
Object.defineProperty(window.HTMLSelectElement.prototype, 'value', {
    get() { return this.querySelector('option[selected]')?.value || ''; },
    set(value) { for (const option of this.querySelectorAll('option')) option.toggleAttribute('selected', option.value === value); }
});
function contentRows(content) { return [...(content?.querySelectorAll('.tab') || [])]; }
Object.defineProperties(window.HTMLElement.prototype, {
    scrollHeight: { get() { return contentRows(this).length * 30; } },
    clientHeight: { get() { return 210; } },
    scrollTop: {
        get() { return Math.min(this._scrollTop || 0, Math.max(0, this.scrollHeight - this.clientHeight)); },
        set(value) { this._scrollTop = Math.max(0, Math.min(value, Math.max(0, this.scrollHeight - this.clientHeight))); }
    }
});
window.HTMLElement.prototype.getBoundingClientRect = function () {
    const content = this.closest('.space-content');
    const top = this.classList.contains('tab') ? contentRows(content).indexOf(this) * 30 - content.scrollTop : 0;
    const height = this.classList.contains('space-content') ? 210 : 30;
    return { top, bottom: top + height, left: 0, right: 300, height, width: 300 };
};
const tabs = [
    { id: 1, windowId: 10, active: true, pinned: false, title: 'Active bookmark', url: 'https://bookmark-0.test/' },
    { id: 2, windowId: 10, active: false, pinned: false, title: 'Inactive live bookmark', url: 'https://bookmark-30.test/' },
    { id: 3, windowId: 10, active: false, pinned: false, title: 'Today A', url: 'https://same.test/' },
    { id: 4, windowId: 10, active: false, pinned: false, title: 'Today B', url: 'https://same.test/' },
    { id: 5, windowId: 10, active: false, pinned: false, title: 'Today C', url: 'https://other.test/' },
    { id: 9, windowId: 20, active: true, pinned: false, title: 'Other window', url: 'https://same.test/' }
];
let storedSpaces = [{ id: 'alpha', name: 'Alpha', color: 'blue', bookmarkFolderId: 'p', spaceBookmarks: [1, 2], temporaryTabs: [3, 4, 5, 9] }];
const bookmarks = Array.from({ length: 40 }, (_, index) => ({ id: `b${index}`, parentId: 'p', title: `Bookmark ${index}`, url: `https://bookmark-${index}.test/` }));
const folders = [{ id: 'root', title: 'Arcify' }, { id: 'p', title: 'Alpha', parentId: 'root' }];
const local = { spaces: storedSpaces, tabGroupImportDismissed: true,
    pinnedTabStatesById: { 1: { bookmarkId: 'b0', pinnedUrl: tabs[0].url }, 2: { bookmarkId: 'b30', pinnedUrl: tabs[1].url } } };
const session = { activeSpaces: { 10: 'alpha' } };
const area = state => ({ async get(keys) {
    if (typeof keys === 'string') return { [keys]: structuredClone(state[keys]) };
    return structuredClone({ ...(Array.isArray(keys) ? {} : keys), ...state });
}, async set(next) { Object.assign(state, structuredClone(next)); }, async remove(key) { delete state[key]; } });
let beforeTree, beforeRemove;
const mutations = [], saveRequests = [];
let nextBookmarkId = 100;
const store = new SpaceStore(); store.initialized = true; store.spaces = storedSpaces; store.active = session.activeSpaces; store.restoredRanks = new Map(); store.isGlobalTab = () => false;
store.persist = async () => { storedSpaces = structuredClone(store.spaces); local.spaces = storedSpaces; await onChanged.emit({ spaces: { newValue: structuredClone(storedSpaces) } }, 'local'); };
Object.assign(globalThis, { window, document, Event: window.Event, Node: window.Node,
    localStorage: { getItem() { return null; }, setItem() {} },
    getComputedStyle: () => ({ getPropertyValue() { return ''; } }),
    matchMedia: () => ({ matches: true, addEventListener() {} }),
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    MutationObserver: window.MutationObserver,
    alert(message) { assert.fail(message); }
});
globalThis.chrome = {
    runtime: { onMessage, getURL: path => `chrome-extension://fixture/${path}`, getManifest: () => ({ version: 'test' }),
        async sendMessage(message) {
            if (message.type === 'saveTodayTabsInNewFolder') {
                saveRequests.push(structuredClone(message)); store.spaces = structuredClone(storedSpaces);
                try { return { success: true, batch: await saveTodayTabsInNewFolder(store, message) }; }
                catch (error) { return { success: false, error: error.message, batch: error.batch }; }
            }
            if (message.type === 'favoriteStore') return { success: true, favorites: [], nativeTabs: [] };
            if (message.type === 'sidebarTour') return { success: true, state: null };
            assert.equal(message.type, 'spaceStore');
            if (message.action === 'patch') {
                storedSpaces = applySpacePatch(storedSpaces, message.before, message.after);
                await onChanged.emit({ spaces: { newValue: structuredClone(storedSpaces) } }, 'local');
            }
            if (message.action === 'activate') session.activeSpaces[message.windowId] = message.spaceId;
            return { success: true, spaces: structuredClone(storedSpaces) };
        } },
    storage: { onChanged, local: area(local), sync: area({ invertTabOrder: false }), session: area(session) },
    windows: { async get(id) { return { id, type: 'normal', incognito: false }; }, getCurrent(_options, callback) { callback?.({ id: 10 }); return Promise.resolve({ id: 10 }); } },
    tabs: { ...Object.fromEntries(['onActivated', 'onCreated', 'onUpdated', 'onRemoved', 'onAttached', 'onDetached', 'onMoved'].map(name => [name, listeners()])),
        async query(query) { return structuredClone(tabs.filter(tab => (!query.windowId || tab.windowId === query.windowId) && (!query.active || tab.active))); },
        async get(id) { return structuredClone(tabs.find(tab => tab.id === id)); },
        async remove(id) { tabs.splice(tabs.findIndex(tab => tab.id === id), 1); await beforeRemove?.(id); await chrome.tabs.onRemoved.emit(id, { windowId: 10 }); },
        async update(id, properties) { mutations.push(['tab-update', id, properties]); Object.assign(tabs.find(tab => tab.id === id), properties); return this.get(id); }
    },
    bookmarks: {
        async create(data) { const node = { ...data, id: String(nextBookmarkId++) }; (node.url ? bookmarks : folders).push(node); mutations.push(['bookmark-create', structuredClone(node)]); return structuredClone(node); },
        async get(id) { return structuredClone([...folders, ...bookmarks].filter(node => node.id === id)); },
        async search({ title }) { return structuredClone(folders.filter(node => node.title === title)); },
        async getChildren(id) { await beforeTree?.(); return structuredClone([...folders, ...bookmarks].filter(node => node.parentId === id).sort((a, b) => (a.index ?? Number(a.id.slice(1)) ?? 0) - (b.index ?? Number(b.id.slice(1)) ?? 0))); },
        async remove(id) { bookmarks.splice(bookmarks.findIndex(node => node.id === id), 1); await onMessage.emit({ action: 'arcifyBookmarksChanged' }); }
    },
    tabGroups: { async query() { return []; } }
};
const domReady = [];
const originalAddListener = document.addEventListener.bind(document);
document.addEventListener = (name, callback, ...rest) => {
    if (name === 'DOMContentLoaded') domReady.push(callback);
    else originalAddListener(name, callback, ...rest);
};
await import('../../sidebar.js');
await Promise.all(domReady.map(callback => callback()));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const content = () => document.querySelector('.space.active .space-content');
const row = id => content().querySelector(`[data-bookmark-id="${id}"]`);
const live = id => content().querySelector(`[data-tab-id="${id}"]`);
const close = row => {
    const button = row.querySelector('.tab-close, .tab-remove'); button.focus({ preventScroll: true });
    const event = new window.Event('click', { bubbles: true }); event.button = 0; button.dispatchEvent(event);
};
async function refresh() { await onMessage.emit({ action: 'arcifyBookmarksChanged' }); await wait(240); }
async function activate(id) {
    for (const tab of tabs) tab.active = tab.id === id;
    await chrome.tabs.onActivated.emit({ tabId: id, windowId: 10 }); await wait(30);
}
await wait(240);


const event = (element, type, properties = {}) => {
    const e = new window.Event(type, { bubbles: true, cancelable: true }); Object.assign(e, { button: 0, ...properties }); element.dispatchEvent(e); return e;
};
const selected = () => [...document.querySelectorAll('.today-selected')].map(row => Number(row.dataset.tabId));
const clear = () => event(document.body, 'keydown', { key: 'Escape' });
async function context(id) { event(live(id), 'contextmenu', { pageX: 30, pageY: 60 }); await wait(30); }
function dialog() { event(document.getElementById('saveTodayTabsInNewFolder'), 'click'); }

test('real sidebar registers Today modifier selection without activation, and refuses silent single-row batch drag', async () => {
    const before = mutations.length;
    event(live(3), 'click', { ctrlKey: true }); event(live(5), 'click', { shiftKey: true });
    assert.deepEqual(selected(), [3, 4, 5]);
    assert.equal(document.getElementById('todaySelectionStatus').dataset.count, '3');
    assert.equal(live(9), null, 'Other-window identity is excluded from the actual Today render');
    assert.equal(mutations.length, before); assert.equal(tabs.find(tab => tab.id === 1).active, true);
    const drag = event(live(3), 'dragstart', { dataTransfer: { setData() { assert.fail('Batch may not become a singleton drag'); } } });
    assert.equal(drag.defaultPrevented, true); assert.equal(document.querySelector('.dragging'), null);
});

test('dragging an unselected Today row keeps ordinary singleton drag semantics', async () => {
    clear(); event(live(3), 'click', { ctrlKey: true }); event(live(4), 'click', { ctrlKey: true });
    let payload = null;
    const drag = event(live(5), 'dragstart', { dataTransfer: { setData(type, value) { payload = [type, value]; } } });
    assert.equal(drag.defaultPrevented, false); assert.deepEqual(payload, ['text/plain', '5']);
    assert.deepEqual(selected(), []); assert(live(5).classList.contains('dragging'));
    event(live(5), 'dragend');
    event(live(3), 'click', { ctrlKey: true }); event(live(5), 'click', { shiftKey: true });
});

test('real context menu retains a selected batch, switches unselected singleton, and Cancel performs no save', async () => {
    await context(4); assert.match(document.getElementById('saveTodayTabsInNewFolder').textContent, /Save 3 tabs/);
    assert.equal(document.querySelectorAll('#tab-context-menu .context-menu-item').length, 1, 'Batch menu must not imply singular mutations affect the entire selection');
    const before = structuredClone(mutations);
    dialog(); assert(document.getElementById('todayFolderDialog'));
    event(document.getElementById('todayFolderCancel'), 'click'); await wait(40);
    assert.deepEqual(mutations, before); assert.deepEqual(saveRequests, []);
    clear(); event(live(3), 'click', { ctrlKey: true }); event(live(4), 'click', { ctrlKey: true });
    await context(5); assert.deepEqual(selected(), [5]); assert.match(document.getElementById('saveTodayTabsInNewFolder').textContent, /Save 1 tab/);
    document.getElementById('tab-context-menu').remove(); clear();
});

test('real sidebar dialog submits through guarded backend and refreshes exact live rows into named pinned folder', async () => {
    const beforeTabs = structuredClone(tabs);
    event(live(5), 'click', { metaKey: true }); event(live(3), 'click', { shiftKey: true });
    assert.deepEqual(selected(), [3, 4, 5]);
    await context(4); dialog();
    const input = document.getElementById('todayFolderName'); input.value = 'Collected Today'; event(input, 'input');
    event(input.closest('form'), 'submit'); await wait(450);
    assert.equal(saveRequests.length, 1); assert.deepEqual(saveRequests[0].entries.map(item => item.tabId), [3, 4, 5]);
    const folder = folders.find(item => item.title === 'Collected Today'); assert(folder);
    const children = bookmarks.filter(item => item.parentId === folder.id); assert.equal(children.length, 3);
    assert.deepEqual(children.map(item => item.title), ['Today A', 'Today B', 'Today C']);
    assert.equal(children[0].url, children[1].url); assert.notEqual(children[0].id, children[1].id);
    for (const [index, id] of [3, 4, 5].entries()) {
        assert.equal(local.pinnedTabStatesById[id].bookmarkId, children[index].id);
        assert.equal(live(id).closest('.folder').dataset.bookmarkId, folder.id);
        assert(live(id).closest('[data-tab-type="pinned"]'));
    }
    assert.deepEqual(tabs, beforeTabs); assert.deepEqual(storedSpaces[0].temporaryTabs, [9]);
    assert.match(document.getElementById('favoritesDropNotice').textContent, /Saved 3 tabs/);
    assert.equal(document.getElementById('todayFolderDialog'), null);
});

test('ordinary Today context commands stay available if its bookmark root becomes unavailable', async () => {
    tabs.push({ id: 6, windowId: 10, pinned: false, active: false, title: 'New Today', url: 'https://new.test/' });
    storedSpaces[0].temporaryTabs.push(6);
    await onChanged.emit({ spaces: { newValue: structuredClone(storedSpaces) } }, 'local'); await wait(240);
    const root = folders.find(node => node.id === 'p'); const parent = root.parentId; root.parentId = 'elsewhere';
    const before = mutations.length;
    await context(6);
    assert.match(document.getElementById('tab-context-menu').textContent, /Close Tab/);
    dialog(); event(document.getElementById('todayFolderCancel'), 'click'); await wait(50);
    assert.equal(mutations.length, before); assert.equal(saveRequests.length, 1);
    root.parentId = parent;
});
