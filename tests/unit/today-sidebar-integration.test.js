import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseHTML } from 'linkedom';
import { applySpacePatch, SpaceStore } from '../../space-store.js';
import { saveTodayTabsInNewFolder } from '../../today-folder-store.js';
import { runTabMenuAction } from '../../tab-menu-actions.js';
import { runTodaySplitAction } from '../../today-split-action.js';

// The real sidebar, Chrome listeners, close buttons and refresh coordinator are
// exercised together. Only Chrome persistence and DOM layout/focus are fakes.
const { window } = parseHTML(await readFile(new URL('../../sidebar.html', import.meta.url), 'utf8'));
const { document } = window;
const listeners = () => {
    const callbacks = [];
    return { addListener(callback) { callbacks.push(callback); },
        removeListener(callback) { const index = callbacks.indexOf(callback); if (index >= 0) callbacks.splice(index, 1); },
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
let beforeTree, beforeRemove, beforeGetTab, beforeTabMenuRequest, beforeTodayMoveRequest;
const mutations = [], saveRequests = [], splitRequests = [], nativeSplitCalls = [], todayMoveRequests = [];
const settings = { invertTabOrder: false };
let nextBookmarkId = 100;
const store = new SpaceStore(); store.initialized = true; store.spaces = storedSpaces; store.active = session.activeSpaces; store.restoredRanks = new Map(); store.restoredMetadata = []; store.isGlobalTab = () => false;
store.persist = async () => { storedSpaces = structuredClone(store.spaces); local.spaces = storedSpaces; await onChanged.emit({ spaces: { newValue: structuredClone(storedSpaces) } }, 'local'); };
Object.assign(globalThis, { window, document, Event: window.Event, Node: window.Node,
    localStorage: { getItem() { return null; }, setItem() {} },
    getComputedStyle: () => ({ getPropertyValue() { return ''; } }),
    matchMedia: () => ({ matches: true, addEventListener() {} }),
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    MutationObserver: window.MutationObserver,
    cancelAnimationFrame() {},
    alert(message) { assert.fail(message); }
});
globalThis.chrome = {
    runtime: { onMessage, getURL: path => `chrome-extension://fixture/${path}`, getManifest: () => ({ version: 'test' }),
        async sendMessage(message) {
            if (message.type === 'moveTodayTabsToSpace') {
                todayMoveRequests.push(structuredClone(message));
                return beforeTodayMoveRequest?.(message);
            }
            if (message.type === 'saveTodayTabsInNewFolder') {
                saveRequests.push(structuredClone(message)); store.spaces = structuredClone(storedSpaces);
                try { return { success: true, batch: await saveTodayTabsInNewFolder(store, message) }; }
                catch (error) { return { success: false, error: error.message, batch: error.batch }; }
            }
            if (message.type === 'todaySplitAction') {
                splitRequests.push(structuredClone(message)); store.spaces = structuredClone(storedSpaces);
                try { return { success: true, ...await runTodaySplitAction(store, message) }; }
                catch (error) { return { success: false, error: error.message }; }
            }
            if (message.type === 'tabMenuAction') {
                await beforeTabMenuRequest?.(message);
                store.spaces = structuredClone(storedSpaces);
                try { return { success: true, ...await runTabMenuAction(store, message) }; }
                catch (error) { return { success: false, error: error.message }; }
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
    storage: { onChanged, local: area(local), sync: area(settings), session: area(session) },
    windows: { async get(id) { return { id, type: 'normal', incognito: false }; }, getCurrent(_options, callback) { callback?.({ id: 10 }); return Promise.resolve({ id: 10 }); } },
    tabs: { ...Object.fromEntries(['onActivated', 'onCreated', 'onUpdated', 'onRemoved', 'onAttached', 'onDetached', 'onMoved'].map(name => [name, listeners()])),
        async query(query) { return structuredClone(tabs.filter(tab => (!query.windowId || tab.windowId === query.windowId) && (!query.active || tab.active))); },
        async get(id) { await beforeGetTab?.(id); return structuredClone(tabs.find(tab => tab.id === id)); },
        async remove(id) { tabs.splice(tabs.findIndex(tab => tab.id === id), 1); await beforeRemove?.(id); await chrome.tabs.onRemoved.emit(id, { windowId: 10 }); },
        async duplicate(id) { const next = { ...structuredClone(tabs.find(tab => tab.id === id)), id: 88, active: false }; tabs.push(next); return next; },
        async update(id, properties) { mutations.push(['tab-update', id, properties]); Object.assign(tabs.find(tab => tab.id === id), properties); return this.get(id); }
    },
    bookmarks: {
        async create(data) { const node = { ...data, id: String(nextBookmarkId++) }; (node.url ? bookmarks : folders).push(node); mutations.push(['bookmark-create', structuredClone(node)]); return structuredClone(node); },
        async get(id) { return structuredClone([...folders, ...bookmarks].filter(node => node.id === id)); },
        async search({ title }) { return structuredClone(folders.filter(node => node.title === title)); },
        async getChildren(id) { await beforeTree?.(); return structuredClone([...folders, ...bookmarks].filter(node => node.parentId === id).sort((a, b) => (a.index ?? Number(a.id.slice(1)) ?? 0) - (b.index ?? Number(b.id.slice(1)) ?? 0))); },
        async update(id, values) { Object.assign(bookmarks.find(node => node.id === id), values); mutations.push(['bookmark-update', id, values]); return structuredClone(bookmarks.find(node => node.id === id)); },
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


const menuItem = action => document.querySelector(`#tab-context-menu [data-action="${action}"]`);
async function pinContext(id) { clear(); event(row(id), 'contextmenu', { pageX: 20, pageY: 20 }); await wait(30); }
async function startEdit(action) { event(menuItem(action), 'click'); await wait(30); assert(document.getElementById('tabEditDialog')); }
async function submitEdit(value) { const input = document.getElementById('tabEditValue'); input.value = value; event(input, 'input'); event(input.closest('form'), 'submit'); await wait(300); }

test('real sidebar ordinary Rename cancels with no mutation, saves text safely and clears alias', async () => {
    await context(6); await startEdit('rename');
    const before = structuredClone(mutations); event(document.getElementById('tabEditCancel'), 'click'); await wait(30); assert.deepEqual(mutations, before);
    await context(6); await startEdit('rename'); await submitEdit('<img src=x onerror=alert(1)>');
    assert.equal(live(6).querySelector('.tab-title-display').textContent, '<img src=x onerror=alert(1)>');
    assert.equal(live(6).querySelector('.tab-title-display img'), null); assert.equal(tabs.find(tab => tab.id === 6).title, 'New Today');
    await context(6); await startEdit('rename'); await submitEdit(''); assert.equal(live(6).querySelector('.tab-title-display').textContent, 'New Today');
});

test('real sidebar closed pin Rename and URL editor preserve folder/order/title and do not open a page', async () => {
    const beforeTabs = structuredClone(tabs), original = structuredClone(bookmarks.find(node => node.id === 'b10'));
    await pinContext('b10'); assert.equal(menuItem('mute'), null); assert.equal(menuItem('duplicate'), null);
    assert.match(document.getElementById('tab-context-menu').textContent, /Remove Pin/);
    await startEdit('rename'); await submitEdit('Closed saved title');
    await pinContext('b10'); await startEdit('editUrl'); await submitEdit('https://edited.test/path');
    assert.deepEqual(bookmarks.find(node => node.id === 'b10'), { ...original, title: 'Closed saved title', url: 'https://edited.test/path' });
    assert.equal(row('b10').querySelector('.tab-title-display').textContent, 'Closed saved title'); assert.equal(row('b10').dataset.url, 'https://edited.test/path');
    assert.deepEqual(tabs, beforeTabs);
});

test('real sidebar saved live title stays coherent through URL navigation and title events', async () => {
    await pinContext('b0'); await startEdit('rename'); await submitEdit('Exact saved title');
    assert.equal(live(1).querySelector('.tab-title-display').textContent, 'Exact saved title');
    const tab = tabs.find(item => item.id === 1); tab.title = 'New page title';
    await chrome.tabs.onUpdated.emit(1, { title: tab.title }, structuredClone(tab)); await wait(30);
    assert.equal(live(1).querySelector('.tab-title-display').textContent, 'Exact saved title');
    tab.url = 'https://away.test/'; tab.title = 'Away page'; await chrome.tabs.onUpdated.emit(1, { url: tab.url, title: tab.title }, structuredClone(tab)); await wait(30);
    assert.equal(live(1).querySelector('.tab-title-display').textContent, 'Away page');
    await pinContext('b0'); await startEdit('editUrl'); await submitEdit('https://new-pin.test/');
    assert.equal(tab.url, 'https://away.test/'); assert.equal(bookmarks.find(node => node.id === 'b0').title, 'Exact saved title');
    assert.equal(live(1).dataset.pinnedUrl, 'https://new-pin.test/');
});

test('real sidebar multi-pin context hides singleton actions and preserves Today named-folder behavior', async () => {
    clear(); event(row('b10'), 'click', { ctrlKey: true }); event(row('b11'), 'click', { ctrlKey: true });
    event(row('b10'), 'contextmenu', { pageX: 20, pageY: 20 }); await wait(30);
    assert.equal(menuItem('rename'), null); assert.equal(menuItem('copyLink'), null);
    assert.match(document.getElementById('tab-context-menu').textContent, /Select one pin/);
    await context(6); assert(menuItem('rename')); assert(menuItem('duplicate')); assert(document.getElementById('saveTodayTabsInNewFolder'));
});

test('real sidebar refuses save after exact saved bookmark moves while dialog is open', async () => {
    await pinContext('b10'); await startEdit('editUrl');
    const node = bookmarks.find(node => node.id === 'b10'), parent = node.parentId; node.parentId = 'elsewhere';
    await submitEdit('https://must-not-save.test/'); assert.equal(node.url, 'https://edited.test/path');
    assert.match(document.getElementById('favoritesDropNotice').textContent, /changed/); node.parentId = parent; await refresh();
});


test('real sidebar alias-only storage change repaints unchanged Space projection', async () => {
    const before = structuredClone(storedSpaces);
    local.tabNameOverridesById ||= {}; local.tabNameOverridesById[6] = { name: 'Other panel alias' };
    await onChanged.emit({ tabNameOverridesById: { newValue: structuredClone(local.tabNameOverridesById) } }, 'local'); await wait(240);
    assert.deepEqual(storedSpaces, before); assert.equal(live(6).querySelector('.tab-title-display').textContent, 'Other panel alias');
    delete local.tabNameOverridesById[6]; await onChanged.emit({ tabNameOverridesById: { newValue: structuredClone(local.tabNameOverridesById) } }, 'local'); await wait(240);
    assert.equal(live(6).querySelector('.tab-title-display').textContent, 'New Today');
});

test('real sidebar copies clicked row rather than active tab, exposes live mute, and duplicates ordinary identity', async () => {
    const copied = []; Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { async writeText(value) { copied.push(value); } } } });
    await context(6); event(menuItem('copyLink'), 'click'); await wait(30); assert.deepEqual(copied, ['https://new.test/']);
    await pinContext('b10'); event(menuItem('copyLink'), 'click'); await wait(30); assert.deepEqual(copied, ['https://new.test/', 'https://edited.test/path']);
    await context(6); event(menuItem('mute'), 'click'); await wait(300); assert(mutations.some(([kind, id, values]) => kind === 'tab-update' && id === 6 && values.muted === true));
    await context(6); event(menuItem('duplicate'), 'click'); await wait(300);
    assert(live(88)?.closest('[data-tab-type="temporary"]')); assert.equal(local.pinnedTabStatesById[88], undefined);
    assert.equal(local.tabNameOverridesById[88], undefined); assert.equal(storedSpaces[0].temporaryTabs.indexOf(88), storedSpaces[0].temporaryTabs.indexOf(6) + 1);
});


test('real sidebar discards async Today/pin menus after a newer selection gesture', async () => {
    clear(); document.getElementById('tab-context-menu')?.remove();
    for (const [id, newer] of [[6, () => event(live(88), 'click', { ctrlKey: true })], [1, () => event(row('b10'), 'click', { ctrlKey: true })]]) {
        let release; const waitForTab = new Promise(resolve => { release = resolve; });
        beforeGetTab = async current => { if (current === id) await waitForTab; };
        event(live(id), 'contextmenu', { pageX: 20, pageY: 20 }); await wait(20); newer(); beforeGetTab = null; release(); await wait(40);
        assert.equal(document.getElementById('tab-context-menu'), null); clear();
    }
});

test('real sidebar live double-click retains Rename, closed double-click adds no competing editor', async () => {
    event(row('b10').querySelector('.tab-details'), 'dblclick'); await wait(20); assert.equal(document.getElementById('tabEditDialog'), null);
    event(live(6).querySelector('.tab-details'), 'dblclick'); await wait(20); assert(document.getElementById('tabEditDialog'));
    event(document.getElementById('tabEditValue'), 'keydown', { key: 'Escape' }); await wait(20); assert.equal(document.getElementById('tabEditDialog'), null);
    await context(6); assert(document.getElementById('tab-context-menu')); event(document.body, 'keydown', { key: 'Escape' }); assert.equal(document.getElementById('tab-context-menu'), null);
});

test('Space and Tab context menus share one visible surface in either gesture order', async () => {
    await context(6); assert(document.getElementById('tab-context-menu'));
    const header = document.querySelector('.space.active .space-name');
    event(header, 'keydown', { key: 'F10', shiftKey: true });
    assert(document.querySelector('.space-context-menu'));
    assert.equal(Boolean(document.getElementById('tab-context-menu')), false, 'Space keyboard menu dismisses the previous Tab menu');
    await context(6);
    assert(document.getElementById('tab-context-menu'));
    assert.equal(Boolean(document.querySelector('.space-context-menu')), false, 'Tab menu dismisses the previous Space menu');
    clear();
});

test('newer Space menu prevents an outstanding async Tab menu from reopening', async () => {
    clear(); document.getElementById('tab-context-menu')?.remove();
    let release; const waitForTab = new Promise(resolve => { release = resolve; });
    beforeGetTab = async id => { if (id === 6) await waitForTab; };
    try {
        event(live(6), 'contextmenu', { pageX: 20, pageY: 20 }); await wait(20);
        event(document.querySelector('#spaceSwitcher button[data-space-id="alpha"]'), 'contextmenu');
        assert(document.querySelector('.space-context-menu'));
    } finally { beforeGetTab = null; release(); }
    await wait(40);
    assert.equal(Boolean(document.getElementById('tab-context-menu')), false, 'Delayed Tab result cannot override a later Space gesture');
    assert(document.querySelector('.space-context-menu')); clear();
});


for (const delayed of [false, true]) test(`newer Space editor replaces ${delayed ? 'pending' : 'visible'} Tab editor without mutation`, async () => {
    clear(); const before = structuredClone(mutations); let release;
    const held = new Promise(resolve => { release = resolve; });
    await context(6);
    if (delayed) beforeTabMenuRequest = async message => { if (message.action === 'describe') await held; };
    event(menuItem('rename'), 'click'); await wait(20);
    if (!delayed) assert(document.getElementById('tabEditDialog'));
    try {
        event(document.querySelector('#spaceSwitcher button[data-space-id="alpha"]'), 'contextmenu');
        const rename = [...document.querySelectorAll('.space-context-menu [role="menuitem"]')].find(item => item.textContent === 'Rename');
        event(rename, 'click');
    } finally { beforeTabMenuRequest = null; release(); }
    await wait(40);
    assert.equal(Boolean(document.getElementById('tabEditDialog')), false);
    assert.equal(document.querySelectorAll('[role="dialog"]').length, 1);
    assert.equal(document.querySelector('[role="dialog"] h2').textContent, 'Rename Alpha');
    assert(document.querySelector('[role="dialog"]').contains(document.activeElement));
    assert.deepEqual(mutations, before); clear();
    // Completion of the abandoned editor releases the mutation gate for a later edit.
    await context(6); await startEdit('rename');
    event(document.getElementById('tabEditCancel'), 'click'); await wait(20);
});

// Genuine sidebar event/render/menu paths with mocked native Split APIs. These
// tests do not stand in for the separately authorized real Chrome fixture.
async function splitKeyboardMenu(id, key = 'F10') {
    const target = live(id); target.focus();
    event(target, 'keydown', { key, shiftKey: key === 'F10' }); await wait(35);
}
function fakeNativeSplitApis() {
    chrome.tabs.createSplit = async ids => {
        nativeSplitCalls.push(['create', [...ids]]);
        for (const id of ids) tabs.find(tab => tab.id === id).splitViewId = 701;
        return 701;
    };
    chrome.tabs.unsplit = async id => {
        nativeSplitCalls.push(['end', id]);
        for (const tab of tabs) if (tab.splitViewId === id) tab.splitViewId = -1;
    };
    chrome.tabs.move = async (id, { index }) => {
        nativeSplitCalls.push(['move', id, index]);
        const moving = tabs.find(tab => tab.id === id);
        const list = tabs.filter(tab => tab.windowId === moving.windowId).sort((a, b) => a.index - b.index).filter(tab => tab.id !== id);
        list.splice(index, 0, moving); list.forEach((tab, i) => { tab.index = i; });
        return structuredClone(moving);
    };
}

test('real sidebar feature-detects both Split APIs and exposes explanatory keyboard context menu', async () => {
    clear(); await splitKeyboardMenu(6, 'ContextMenu');
    assert.match(menuItem('splitViewHint').textContent, /unavailable/);
    assert.equal(menuItem('createSplitView'), null); assert.equal(document.querySelector('.today-split-target'), null);
    assert(document.getElementById('tab-context-menu').contains(document.activeElement));
    clear(); assert.equal(document.activeElement, live(6));
});

test('real sidebar keyboard selected pair creates and ends native Split View without affecting other rows', async () => {
    fakeNativeSplitApis();
    for (const id of [101, 102, 103]) tabs.push({ id, windowId: 10, active: false, pinned: false, incognito: false, groupId: -1, title: `Split ${id}`, url: 'https://split-same.test/' });
    for (const windowId of [10, 20]) tabs.filter(tab => tab.windowId === windowId).forEach((tab, index) => { Object.assign(tab, { index, groupId: -1, incognito: false }); });
    storedSpaces[0].temporaryTabs.push(101, 102, 103); local.spaces = structuredClone(storedSpaces); await onChanged.emit({ spaces: { newValue: structuredClone(storedSpaces) } }, 'local'); await wait(260);
    const beforeIds = tabs.map(tab => tab.id), beforeBookmarks = structuredClone(bookmarks), beforeAliases = structuredClone(local.tabNameOverridesById);
    event(live(101), 'click', { ctrlKey: true }); event(live(102), 'click', { ctrlKey: true }); await splitKeyboardMenu(102);
    assert.equal(document.activeElement, menuItem('createSplitView'));
    assert.equal(menuItem('rename'), null); assert.equal(menuItem('duplicate'), null);
    event(document.activeElement, 'keydown', { key: 'Enter' }); await wait(320);
    assert.deepEqual(nativeSplitCalls, [['create', [101, 102]]]);
    assert.equal(document.activeElement, live(102)); assert(document.activeElement.isConnected);
    assert.equal(splitRequests.length, 1); assert.deepEqual(splitRequests[0].entries.map(entry => entry.tabId), [101, 102]);
    assert(live(101).querySelector('.today-split-badge')); assert(live(102).querySelector('.today-split-badge')); assert.equal(live(101).querySelector('.today-split-target'), null);
    assert.deepEqual(tabs.map(tab => tab.id), beforeIds); assert.deepEqual(bookmarks, beforeBookmarks); assert.deepEqual(local.tabNameOverridesById, beforeAliases);
    const drag = event(live(101), 'dragstart', { dataTransfer: { setData() { assert.fail('Split members cannot start moving'); } } }); assert(drag.defaultPrevented);
    await splitKeyboardMenu(101, 'ContextMenu'); assert.equal(document.activeElement, menuItem('endSplitView'));
    event(document.activeElement, 'keydown', { key: 'Enter' }); await wait(320);
    assert.deepEqual(nativeSplitCalls.at(-1), ['end', 701]); assert.equal(splitRequests.at(-1).entries.length, 2);
    assert.equal(document.activeElement, live(101)); assert(document.activeElement.isConnected);
    assert.equal(live(101).querySelector('.today-split-badge'), null); assert(live(101).querySelector('.today-split-target'));
});

test('native update refresh does not invalidate a freshly opened keyboard End menu', async () => {
    clear();
    for (const id of [101, 102]) tabs.find(tab => tab.id === id).splitViewId = 703;
    await refresh();
    // Native Create emits splitViewId changes, queuing a second debounced render.
    await chrome.tabs.onUpdated.emit(101, { splitViewId: 703 }, structuredClone(tabs.find(tab => tab.id === 101)));
    await splitKeyboardMenu(101);
    const action = menuItem('endSplitView');
    assert.equal(document.activeElement, action);
    const before = nativeSplitCalls.length;
    await wait(150);
    event(action, 'keydown', { key: 'Enter' }); await wait(260);
    assert.deepEqual(nativeSplitCalls.slice(before), [['end', 703]], document.getElementById('favoritesDropNotice')?.textContent);
    assert.equal(document.activeElement, live(101));
});

test('Split menu cancellation resumes queued refresh without a native action', async () => {
    const before = nativeSplitCalls.length;
    for (const exit of ['Escape', 'outside', 'superseding', 'removed', 'blur', 'hidden', 'pagehide']) {
        clear(); event(live(101), 'click', { ctrlKey: true }); event(live(102), 'click', { ctrlKey: true });
        await splitKeyboardMenu(101);
        const original = live(101); assert(menuItem('createSplitView'));
        await chrome.tabs.onUpdated.emit(101, { splitViewId: -1 }, structuredClone(tabs.find(tab => tab.id === 101)));
        await wait(160); assert.equal(live(101), original, 'Frozen rows stay connected during the menu interaction');
        if (exit === 'Escape') clear();
        if (exit === 'outside') event(document.body, 'click');
        if (exit === 'superseding') await context(6);
        if (exit === 'removed') document.getElementById('tab-context-menu').remove();
        if (['blur', 'hidden', 'pagehide'].includes(exit)) leaveSidebar(exit);
        await wait(260);
        if (['blur', 'hidden', 'pagehide'].includes(exit)) assert.equal(document.activeElement, document.getElementById('newTabBtn'));
        assert.notEqual(live(101), original, `${exit} releases pending refresh`);
        clear();
    }
    assert.equal(nativeSplitCalls.length, before);
});

test('Space navigation dismisses a Split menu and resumes destination rendering without stealing focus', async () => {
    clear();
    const before = splitRequests.length, activeIds = tabs.filter(tab => tab.active).map(tab => tab.id);
    const other = { id: 'split-other', name: 'Split Other', color: 'green', bookmarkFolderId: 'split-other-folder', spaceBookmarks: [], temporaryTabs: [201] };
    tabs.push({ id: 201, windowId: 10, index: tabs.filter(tab => tab.windowId === 10).length, active: false, pinned: false, incognito: false, groupId: -1, splitViewId: -1, title: 'Other Space', url: 'https://other-space.test/' });
    folders.push({ id: other.bookmarkFolderId, parentId: 'root', title: other.name });
    storedSpaces.push(other); local.spaces = structuredClone(storedSpaces);
    await onChanged.emit({ spaces: { newValue: structuredClone(storedSpaces) } }, 'local'); await wait(260);
    try {
        for (const route of ['wheel', 'session', 'native']) {
            clear(); event(live(101), 'click', { ctrlKey: true }); event(live(102), 'click', { ctrlKey: true });
            await splitKeyboardMenu(101); const original = live(101);
            await chrome.tabs.onUpdated.emit(101, { splitViewId: -1 }, structuredClone(tabs.find(tab => tab.id === 101)));
            document.getElementById('newTabBtn').focus();
            if (route === 'wheel') event(document.getElementById('sidebar-container'), 'wheel', { deltaX: 40, deltaY: 0 });
            if (route === 'session') {
                session.activeSpaces[10] = other.id;
                await onChanged.emit({ activeSpaces: { newValue: structuredClone(session.activeSpaces) } }, 'session');
            }
            if (route === 'native') await activate(201);
            await wait(260);
            assert.equal(document.getElementById('tab-context-menu'), null, `${route} closes the obsolete menu`);
            assert.equal(content().closest('.space').dataset.spaceId, other.id);
            assert(live(201), `${route} renders the exact destination tab after the gate releases`);
            assert.equal(splitRequests.length, before);
            assert.equal(document.activeElement, document.getElementById('newTabBtn'));
            session.activeSpaces[10] = 'alpha';
            await onChanged.emit({ activeSpaces: { newValue: structuredClone(session.activeSpaces) } }, 'session'); await wait(260);
            assert.notEqual(live(101), original); assert(live(101));
        }
    } finally {
        clear(); session.activeSpaces[10] = 'alpha';
        await onChanged.emit({ activeSpaces: { newValue: structuredClone(session.activeSpaces) } }, 'session');
        storedSpaces = storedSpaces.filter(space => space.id !== other.id); local.spaces = structuredClone(storedSpaces);
        tabs.splice(tabs.findIndex(tab => tab.id === 201), 1); folders.splice(folders.findIndex(folder => folder.id === other.bookmarkFolderId), 1);
        for (const tab of tabs) tab.active = activeIds.includes(tab.id);
        await onChanged.emit({ spaces: { newValue: structuredClone(storedSpaces) } }, 'local'); await wait(260);
    }
});

test('a pending new Space cancels an older async Split menu before adoption', async () => {
    clear(); const before = splitRequests.length;
    event(live(101), 'click', { ctrlKey: true }); event(live(102), 'click', { ctrlKey: true });
    const other = { id: 'split-pending', name: 'Pending Space', color: 'green', bookmarkFolderId: 'split-pending-folder', spaceBookmarks: [], temporaryTabs: [202] };
    let release, entered = false;
    const delayed = new Promise(resolve => { release = resolve; });
    beforeTree = async () => { entered = true; await delayed; };
    try {
        event(live(101), 'keydown', { key: 'F10', shiftKey: true }); await wait(20);
        assert(entered); assert.equal(document.getElementById('tab-context-menu'), null);
        session.activeSpaces[10] = other.id;
        await onChanged.emit({ activeSpaces: { newValue: structuredClone(session.activeSpaces) } }, 'session');
        beforeTree = null; release(); await wait(25);
        assert.equal(document.getElementById('tab-context-menu'), null, 'An old request cannot reopen its actionable menu while the next Space is pending');
        event(live(101), 'keydown', { key: 'F10', shiftKey: true }); await wait(25);
        assert.equal(document.getElementById('tab-context-menu'), null, 'A new menu on the obsolete Space must not block pending destination adoption either');
        tabs.push({ id: 202, windowId: 10, index: tabs.filter(tab => tab.windowId === 10).length, active: false, pinned: false, incognito: false, groupId: -1, splitViewId: -1, title: 'Pending Space Tab', url: 'https://pending-space.test/' });
        folders.push({ id: other.bookmarkFolderId, parentId: 'root', title: other.name });
        storedSpaces.push(other); local.spaces = structuredClone(storedSpaces);
        await onChanged.emit({ spaces: { newValue: structuredClone(storedSpaces) } }, 'local'); await wait(260);
        assert.equal(content().closest('.space').dataset.spaceId, other.id); assert(live(202));
        assert.equal(document.getElementById('tab-context-menu'), null); assert.equal(splitRequests.length, before);
    } finally {
        beforeTree = null; release(); clear(); session.activeSpaces[10] = 'alpha';
        await onChanged.emit({ activeSpaces: { newValue: structuredClone(session.activeSpaces) } }, 'session');
        storedSpaces = storedSpaces.filter(space => space.id !== other.id); local.spaces = structuredClone(storedSpaces);
        const tabIndex = tabs.findIndex(tab => tab.id === 202); if (tabIndex >= 0) tabs.splice(tabIndex, 1);
        const folderIndex = folders.findIndex(folder => folder.id === other.bookmarkFolderId); if (folderIndex >= 0) folders.splice(folderIndex, 1);
        await onChanged.emit({ spaces: { newValue: structuredClone(storedSpaces) } }, 'local'); await wait(260);
    }
});

test('Split menu refresh gate never bypasses fresh native-state validation', async () => {
    clear();
    for (const id of [101, 102]) tabs.find(tab => tab.id === id).splitViewId = 704;
    await refresh(); await splitKeyboardMenu(101);
    const original = live(101), before = nativeSplitCalls.length, requests = splitRequests.length;
    const changed = tabs.find(tab => tab.id === 102), previous = structuredClone(changed);
    try {
        changed.groupId = 88;
        await chrome.tabs.onUpdated.emit(102, { groupId: 88 }, structuredClone(changed));
        await wait(160); assert.equal(live(101), original);
        event(menuItem('endSplitView'), 'keydown', { key: 'Enter' }); await wait(260);
        assert.equal(splitRequests.length, requests + 1, 'The unchanged row snapshot reaches the live writer');
        assert.equal(splitRequests.at(-1).action, 'end');
        assert.equal(nativeSplitCalls.length, before, 'Fresh group mismatch must prevent native unsplit');
        assert.match(document.getElementById('favoritesDropNotice').textContent, /Today tabs.*changed/);
        assert.equal(changed.groupId, 88); assert.equal(changed.splitViewId, 704);
        assert.notEqual(live(101), original, 'Rejected action still releases its interaction gate');
    } finally {
        Object.assign(changed, previous);
        for (const id of [101, 102]) tabs.find(tab => tab.id === id).splitViewId = -1;
        clear(); await refresh();
    }
});

test('real sidebar split target consumes non-adjacent drag once without legacy drop or Favorite promotion', async () => {
    clear(); const before = nativeSplitCalls.length, beforeRequests = splitRequests.length;
    const source = live(101), target = live(103).querySelector('.today-split-target');
    const transfer = { setData() {} }; event(source, 'dragstart', { dataTransfer: transfer });
    assert(source.classList.contains('dragging'));
    event(target, 'dragover', { dataTransfer: transfer }); const dropped = event(target, 'drop', { dataTransfer: transfer }); event(target, 'drop', { dataTransfer: transfer });
    event(source, 'dragend'); await wait(360);
    assert(dropped.defaultPrevented); assert.equal(splitRequests.length, beforeRequests + 1);
    assert.deepEqual(nativeSplitCalls.slice(before), [['move', 103, tabs.find(tab => tab.id === 101).index + 1], ['create', [101, 103]]]);
    assert.equal(document.querySelector('.dragging'), null); assert.equal(document.querySelector('.today-split-dragging'), null);
    assert.deepEqual(storedSpaces[0].temporaryTabs.slice(-3), [101, 103, 102]);
    await splitKeyboardMenu(101); event(menuItem('endSplitView'), 'click'); await wait(300);
});

test('native splitViewId event refreshes badges, and pin/promotion guards write nothing', async () => {
    for (const id of [101, 103]) tabs.find(tab => tab.id === id).splitViewId = 702;
    await chrome.tabs.onUpdated.emit(101, { splitViewId: 702 }, structuredClone(tabs.find(tab => tab.id === 101))); await wait(280);
    assert(live(101).querySelector('.today-split-badge'));
    const before = structuredClone(bookmarks), calls = nativeSplitCalls.length;
    await context(101);
    const pin = [...document.querySelectorAll('#tab-context-menu .context-menu-item')].find(item => item.textContent === 'Pin Tab');
    event(pin, 'click'); await wait(30); assert.match(document.getElementById('favoritesDropNotice').textContent, /End Split View/);
    await context(101);
    const favorite = [...document.querySelectorAll('#tab-context-menu .context-menu-item')].find(item => item.textContent === 'Add to Favorites');
    event(favorite, 'click'); await wait(30);
    assert.match(document.getElementById('favoritesDropNotice').textContent, /End Split View/); assert.deepEqual(bookmarks, before); assert.equal(nativeSplitCalls.length, calls);
    await splitKeyboardMenu(101); event(menuItem('endSplitView'), 'click'); await wait(300);
});

test('session split deferral is scoped to active window/Space and clears when projection resumes', async () => {
    const notice = document.getElementById('todaySplitDeferralStatus');
    await onChanged.emit({ spaceGroupSplitDeferrals: { newValue: [{ spaceId: 'alpha', windowId: 20, reason: 'native-split' }] } }, 'session');
    assert(notice.hidden);
    await onChanged.emit({ spaceGroupSplitDeferrals: { newValue: [{ spaceId: 'alpha', windowId: 10, reason: 'native-split' }] } }, 'session');
    assert(!notice.hidden); assert.match(notice.textContent, /End Split View.*pending tab-group changes/);
    const before = notice.textContent; await refresh(); assert.equal(notice.textContent, before);
    await onChanged.emit({ spaceGroupSplitDeferrals: { newValue: [] } }, 'session'); assert(notice.hidden); assert.equal(notice.textContent, '');
});


test('keyboard split target returns to the live row and never steals newer focus during its request', async () => {
    clear(); const original = chrome.tabs.createSplit;
    try {
        for (const stealFocus of [false, true]) {
            let release; const waiting = new Promise(resolve => { release = resolve; });
            chrome.tabs.createSplit = async ids => { await waiting; return original(ids); };
            event(live(101), 'click', { ctrlKey: true }); event(live(103), 'click', { ctrlKey: true });
            const target = live(103).querySelector('.today-split-target'); target.focus();
            // Browsers synthesize click for Enter/Space on this native button.
            event(target, 'click'); await wait(10);
            assert.equal(document.activeElement, live(103));
            if (stealFocus) document.getElementById('newTabBtn').focus();
            release(); await wait(300);
            assert.equal(document.activeElement, stealFocus ? document.getElementById('newTabBtn') : live(103)); assert(document.activeElement.isConnected);
            await splitKeyboardMenu(101); event(menuItem('endSplitView'), 'click'); await wait(300);
        }
    } finally { chrome.tabs.createSplit = original; }
});


function leaveSidebar(exit) {
    // Model focus having already moved away. Dismissal must not focus a row or
    // menu as its queued refresh completes; the real browser fixture tests the
    // OS/tab focus boundary separately.
    document.getElementById('newTabBtn').focus();
    if (exit === 'hidden') {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
        event(document, 'visibilitychange'); delete document.visibilityState;
    } else event(window, exit);
}

const existingFolder = () => content().querySelector('.folder[data-bookmark-id]');
async function folderContext() { event(existingFolder(), 'contextmenu', { clientX: 20, clientY: 40 }); await wait(30); }

test('visible Today, saved/live pin and folder menus dismiss across external focus boundaries', async () => {
    clear(); const before = structuredClone(mutations);
    for (const open of [() => context(6), () => pinContext('b10'), () => context(1), folderContext]) {
        for (const exit of ['blur', 'hidden', 'pagehide']) {
            await open(); assert(document.querySelector('#tab-context-menu, #folder-context-menu'));
            leaveSidebar(exit); await wait(40);
            assert.equal(document.querySelector('#tab-context-menu, #folder-context-menu'), null);
            assert.equal(document.activeElement, document.getElementById('newTabBtn'));
            await open(); assert(document.querySelector('#tab-context-menu, #folder-context-menu')); clear();
        }
    }
    assert.deepEqual(mutations, before);
});

test('async Today/live-pin/closed-pin menu preparations cannot reopen after leaving the sidebar', async () => {
    clear(); const before = structuredClone(mutations);
    for (const kind of ['today', 'live-pin', 'closed-pin']) for (const exit of ['blur', 'hidden', 'pagehide', 'pointerdown', 'Escape']) {
        let release; const waiting = new Promise(resolve => { release = resolve; });
        const target = kind === 'today' ? live(6) : kind === 'live-pin' ? live(1) : row('b10');
        if (kind === 'closed-pin') beforeTree = () => waiting;
        else beforeGetTab = id => [1, 6].includes(id) ? waiting : undefined;
        try {
            event(target, 'contextmenu', { pageX: 20, pageY: 40 }); await wait(10);
            if (['blur', 'hidden', 'pagehide'].includes(exit)) leaveSidebar(exit);
            else if (exit === 'Escape') clear();
            else event(document.body, 'pointerdown');
        } finally { beforeTree = null; beforeGetTab = null; release(); }
        await wait(35);
        assert.equal(document.getElementById('tab-context-menu'), null, `${kind}/${exit} must cancel pending attachment`);
        clear();
    }
    assert.deepEqual(mutations, before);
});

test('async folder preparation is canceled by focus loss or a newer menu and cannot override it', async () => {
    clear(); const before = structuredClone(mutations), originalGet = chrome.bookmarks.get;
    for (const exit of ['blur', 'hidden', 'pagehide', 'space']) {
        let release; const waiting = new Promise(resolve => { release = resolve; });
        chrome.bookmarks.get = async id => { if (id === 'p') await waiting; return originalGet(id); };
        try {
            event(existingFolder(), 'contextmenu', { clientX: 20, clientY: 40 }); await wait(10);
            if (exit === 'space') event(document.querySelector('#spaceSwitcher button[data-space-id="alpha"]'), 'keydown', { key: 'F10', shiftKey: true });
            else leaveSidebar(exit);
        } finally { chrome.bookmarks.get = originalGet; release(); }
        await wait(35);
        assert.equal(document.getElementById('folder-context-menu'), null);
        if (exit === 'space') assert(document.querySelector('.space-context-menu'));
        clear();
    }
    assert.deepEqual(mutations, before);
});

test('folder actions retire their menu before a native prompt; cancellation allows immediate reopening', async () => {
    clear(); const before = structuredClone(mutations), previousConfirm = globalThis.confirm; let confirms = 0;
    globalThis.confirm = () => {
        confirms++;
        assert.equal(document.getElementById('folder-context-menu'), null);
        leaveSidebar('blur'); return false;
    };
    try {
        await folderContext();
        event([...document.querySelectorAll('#folder-context-menu .context-menu-item')].find(item => item.textContent === 'Delete Folder'), 'click');
        await wait(30); assert.equal(confirms, 1); assert.deepEqual(mutations, before);
        await folderContext(); assert(document.getElementById('folder-context-menu')); clear();
    } finally { if (previousConfirm === undefined) delete globalThis.confirm; else globalThis.confirm = previousConfirm; }
});

test('choosing an editor ends the menu lifecycle without closing the new tab or Today dialog', async () => {
    clear(); const before = structuredClone(mutations);
    for (const kind of ['tab', 'today']) {
        await context(6);
        if (kind === 'tab') { event(menuItem('rename'), 'click'); await wait(25); }
        else dialog();
        const id = kind === 'tab' ? 'tabEditDialog' : 'todayFolderDialog';
        const overlay = document.getElementById(id); assert(overlay);
        assert.equal(document.getElementById('tab-context-menu'), null);
        for (const exit of ['blur', 'hidden', 'pagehide']) {
            leaveSidebar(exit); await wait(10);
            assert.equal(document.getElementById(id), overlay);
            assert.equal(document.activeElement, document.getElementById('newTabBtn'));
        }
        event(document.getElementById(kind === 'tab' ? 'tabEditCancel' : 'todayFolderCancel'), 'click'); await wait(30);
        assert.equal(document.getElementById(id), null);
    }
    assert.deepEqual(mutations, before);
});

const moveTarget = () => document.querySelector('[data-action="moveTodayToDestination"][data-space-id="move-dest"]');
const publishSpaces = async () => {
    local.spaces = structuredClone(storedSpaces);
    await onChanged.emit({ spaces: { newValue: structuredClone(storedSpaces) } }, 'local'); await wait(260);
};
const openMovePicker = async id => { await context(id); event(menuItem('moveTodayTabsToSpace'), 'click'); assert(moveTarget()); };

test('real sidebar destination picker holds exact rows, and every dismissal releases queued rendering without focus theft', async () => {
    const other = { id: 'move-dest', name: '<img> Destination', color: 'green', bookmarkFolderId: 'move-folder', spaceBookmarks: [], temporaryTabs: [] };
    storedSpaces.push(other); folders.push({ id: other.bookmarkFolderId, parentId: 'root', title: other.name });
    for (const id of [301, 302]) {
        tabs.push({ id, windowId: 10, index: tabs.length, active: false, pinned: false, incognito: false, groupId: -1, splitViewId: -1, title: `Move ${id}`, url: 'https://same-move.test/' });
        storedSpaces[0].temporaryTabs.push(id);
    }
    await publishSpaces();
    const before = structuredClone(mutations);
    for (const id of [301, 302]) tabs.find(tab => tab.id === id).splitViewId = 901;
    await refresh();
    event(live(301), 'click', { ctrlKey: true }); event(live(302), 'click', { ctrlKey: true }); await context(301);
    assert.equal(menuItem('moveTodayTabsToSpace'), null, 'End native Split View before moving its members');
    clear(); for (const id of [301, 302]) tabs.find(tab => tab.id === id).splitViewId = -1;
    await refresh();
    for (const exit of ['Escape', 'outside', 'superseding', 'removed', 'blur', 'hidden', 'pagehide']) {
        clear(); event(live(302), 'click', { ctrlKey: true }); event(live(301), 'click', { ctrlKey: true });
        await openMovePicker(301);
        const original = live(301), stale = moveTarget();
        assert.deepEqual([...document.querySelectorAll('[data-action="moveTodayToDestination"]')].map(node => node.dataset.spaceId), ['move-dest']);
        assert.equal(stale.querySelector('img'), null);
        await chrome.tabs.onUpdated.emit(301, { splitViewId: -1 }, structuredClone(tabs.find(tab => tab.id === 301)));
        await wait(160); assert.equal(live(301), original);
        if (exit === 'Escape') clear();
        if (exit === 'outside') event(document.body, 'click');
        if (exit === 'superseding') {
            event(document.querySelector('#spaceSwitcher button[data-space-id="alpha"]'), 'keydown', { key: 'F10', shiftKey: true });
        }
        if (exit === 'removed') document.getElementById('tab-context-menu').remove();
        if (['blur', 'hidden', 'pagehide'].includes(exit)) leaveSidebar(exit);
        await wait(260); assert.notEqual(live(301), original, `${exit} releases the picker refresh gate`);
        if (['blur', 'hidden', 'pagehide'].includes(exit)) assert.equal(document.activeElement, document.getElementById('newTabBtn'));
        event(stale, 'click'); await wait(10); assert.equal(todayMoveRequests.length, 0);
        clear();
    }
    assert.deepEqual(mutations, before);
});

test('real sidebar single/multi picker dispatches visible order once and adopts the acknowledged projection without switching or activating', async () => {
    const beforeNative = structuredClone(tabs), beforeBookmarks = structuredClone(bookmarks), beforeMutations = structuredClone(mutations);
    beforeTodayMoveRequest = async message => {
        const source = storedSpaces.find(space => space.id === message.spaceId), target = storedSpaces.find(space => space.id === message.destinationSpaceId);
        const ids = message.entries.map(entry => entry.tabId);
        source.temporaryTabs = source.temporaryTabs.filter(id => !ids.includes(id));
        target.temporaryTabs = message.inverted ? [...ids].reverse().concat(target.temporaryTabs) : target.temporaryTabs.concat(ids);
        local.spaces = structuredClone(storedSpaces);
        await onChanged.emit({ spaces: { newValue: structuredClone(storedSpaces) } }, 'local');
        return { success: true, batch: { total: ids.length, completed: ids, remaining: [], uncertain: false, destinationSpaceId: target.id } };
    };
    try {
        for (const inverted of [false, true]) for (const ids of [[301], [302, 301]]) {
            clear(); settings.invertTabOrder = !inverted;
            local.todayOrderRepresentation = { version: 1, inverted };
            const source = storedSpaces.find(space => space.id === 'alpha'), target = storedSpaces.find(space => space.id === 'move-dest');
            source.temporaryTabs = source.temporaryTabs.filter(id => ![301, 302].includes(id)).concat([301, 302]); target.temporaryTabs = [];
            await publishSpaces(); await refresh();
            for (const id of ids) event(live(id), 'click', { ctrlKey: true });
            const expected = [...content().querySelectorAll('.today-selected')].map(row => Number(row.dataset.tabId));
            await openMovePicker(ids[0]);
            const choice = moveTarget(), count = todayMoveRequests.length;
            event(choice, 'keydown', { key: 'Enter' }); event(choice, 'click'); await wait(340);
            assert.equal(todayMoveRequests.length, count + 1);
            const request = todayMoveRequests.at(-1);
            assert.deepEqual(request.entries.map(entry => entry.tabId), expected); assert.equal(request.inverted, inverted);
            assert.equal(request.destinationBookmarkFolderId, 'move-folder');
            assert.equal(document.querySelector('.space.active').dataset.spaceId, 'alpha'); assert.equal(session.activeSpaces[10], 'alpha');
            for (const id of ids) assert.equal(live(id), null);
            assert.deepEqual(tabs, beforeNative); assert.deepEqual(bookmarks, beforeBookmarks); assert.deepEqual(mutations, beforeMutations);
            assert.match(document.getElementById('favoritesDropNotice').textContent, /still in the current Space/);
        }
    } finally { beforeTodayMoveRequest = null; settings.invertTabOrder = false; local.todayOrderRepresentation = { version: 1, inverted: false }; }
});

test('real sidebar rejects stale Today row instead of falling back to legacy move', async () => {
    clear(); const target = live(6); target.hidden = true;
    try { await context(6); assert.equal(document.getElementById('tab-context-menu'), null); }
    finally { target.hidden = false; clear(); }
    assert.match(document.getElementById('favoritesDropNotice').textContent, /Today row changed/);
});
