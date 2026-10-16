import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseHTML } from 'linkedom';
import { applySpacePatch, SpaceStore } from '../../space-store.js';

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
window.HTMLElement.prototype.focus = function (options) {
    if (focused === this) return;
    const previous = focused; focused = this; this.focusOptions = options;
    if (previous.tagName === 'INPUT' && previous._focusValue !== previous.value) previous.dispatchEvent(new window.Event('change', { bubbles: true }));
    previous.dispatchEvent(new window.Event('blur'));
    const out = new window.Event('focusout', { bubbles: true }); out.relatedTarget = this; previous.dispatchEvent(out);
    this._focusValue = this.value;
    this.dispatchEvent(new window.Event('focus'));
    const into = new window.Event('focusin', { bubbles: true }); into.relatedTarget = previous; this.dispatchEvent(into);
};
window.HTMLElement.prototype.blur = function () { if (focused === this) document.body.focus(); };
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
let storedSpaces = [{ id: 'alpha', name: 'Alpha', color: 'blue', bookmarkFolderId: 'p', spaceBookmarks: [1, 2], temporaryTabs: [3, 4, 5, 9] }, { id: 'beta', name: 'Beta', color: 'red', bookmarkFolderId: 'q', spaceBookmarks: [], temporaryTabs: [] }];
const bookmarks = Array.from({ length: 40 }, (_, index) => ({ id: `b${index}`, parentId: 'p', title: `Bookmark ${index}`, url: `https://bookmark-${index}.test/` }));
const folders = [{ id: 'root', title: 'Arcify' }, { id: 'p', title: 'Alpha', parentId: 'root' }, { id: 'q', title: 'Beta', parentId: 'root' }];
const local = { spaces: storedSpaces, tabGroupImportDismissed: true,
    pinnedTabStatesById: { 1: { bookmarkId: 'b0', pinnedUrl: tabs[0].url }, 2: { bookmarkId: 'b30', pinnedUrl: tabs[1].url } } };
const session = { activeSpaces: { 10: 'alpha' } };
const area = state => ({ async get(keys) {
    if (typeof keys === 'string') return { [keys]: structuredClone(state[keys]) };
    return structuredClone({ ...(Array.isArray(keys) ? {} : keys), ...state });
}, async set(next) { Object.assign(state, structuredClone(next)); }, async remove(key) { delete state[key]; } });
let beforeTree, beforeRemove;
const mutations = [];
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
            if (message.type === 'favoriteStore') return { success: true, favorites: [], nativeTabs: [] };
            if (message.type === 'sidebarTour') return { success: true, state: null };
            assert.equal(message.type, 'spaceStore');
            if (['metadata', 'newFolder'].includes(message.action)) {
                mutations.push(['space-action', structuredClone(message)]); store.spaces = structuredClone(storedSpaces);
                try { await store.applyAction(message); } catch (error) { return { success: false, error: error.message }; }
            }
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
        async update(id, attrs) { const node = [...folders, ...bookmarks].find(node => node.id === id); Object.assign(node, attrs); mutations.push(['bookmark-update', id, attrs]); return structuredClone(node); },
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
function fire(target, type, attrs = {}) {
    const event = new window.Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, { clientX: 100, clientY: 100, ...attrs }); target.dispatchEvent(event); return event;
}
const spaceNode = id => document.querySelector(`.space[data-space-id="${id}"]`);
const spaceChip = id => document.querySelector(`#spaceSwitcher button[data-space-id="${id}"]`);
function menuAction(origin, label) {
    fire(origin, 'contextmenu');
    fire([...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent === label), 'click');
}

test('real sidebar edits an inactive Space icon, name and color through the worker and refreshes both projections without activation', async () => {
    const initialTabChanges = mutations.filter(item => item[0] === 'tab-update').length;
    menuAction(spaceChip('beta'), 'Change Space Icon');
    fire(document.querySelector('[data-choice="rocket"]'), 'click'); await wait(300);
    assert.equal(storedSpaces[1].icon, 'rocket'); assert.equal(local.spaceRegistry.q.spaceUuid, 'beta');
    assert.equal(spaceNode('beta').querySelector('.space-icon').textContent, '🚀');
    assert.equal(spaceChip('beta').querySelector('.space-icon').textContent, '🚀');
    menuAction(spaceNode('beta').querySelector('.space-name'), 'Rename');
    document.querySelector('[role="dialog"] input').value = 'Research'; fire(document.querySelector('form'), 'submit'); await wait(300);
    assert.equal(spaceNode('beta').querySelector('.space-name').value, 'Research');
    assert.equal(folders.find(folder => folder.id === 'q').title, 'Research');
    menuAction(spaceChip('beta'), 'Theme Color'); fire(document.querySelector('[data-choice="cyan"]'), 'click'); await wait(300);
    assert.equal(storedSpaces[1].color, 'cyan'); assert.equal(local.spaceRegistry.q.color, 'cyan');
    assert.equal(document.querySelector('.space.active').dataset.spaceId, 'alpha');
    assert.equal(session.activeSpaces[10], 'alpha');
    assert.equal(mutations.filter(item => item[0] === 'tab-update').length, initialTabChanges);
    assert.deepEqual(storedSpaces.map(space => space.id), ['alpha', 'beta']);
});

test('real sidebar creates a root folder in the exact inactive Space and exposes it when selected later', async () => {
    menuAction(spaceChip('beta'), 'New Folder'); document.querySelector('[role="dialog"] input').value = 'Sources';
    fire(document.querySelector('form'), 'submit'); await wait(300);
    assert.equal(folders.find(folder => folder.title === 'Sources').parentId, 'q');
    assert.equal(document.querySelector('.space.active').dataset.spaceId, 'alpha');
    fire(spaceChip('beta'), 'click', { button: 0 }); await wait(300);
    assert.equal(document.querySelector('.space.active').dataset.spaceId, 'beta');
    assert.equal(spaceNode('beta').querySelector('.folder-title').textContent, 'Sources');
});

test('existing inline Space rename and color controls use the same queued metadata operations', async () => {
    const name = spaceNode('beta').querySelector('.space-name'); name.value = 'Inline edit'; fire(name, 'change'); await wait(300);
    assert.equal(storedSpaces[1].name, 'Inline edit');
    const select = spaceNode('beta').querySelector('#spaceColorSelect'); select.value = 'green'; fire(select, 'change'); await wait(300);
    assert.equal(storedSpaces[1].color, 'green'); assert.equal(local.spaceRegistry.q.color, 'green');
    assert.equal(storedSpaces[1].icon, 'rocket');
    assert.equal(mutations.filter(item => item[0] === 'space-action').length, 6);
});


test('active-header New Folder paints before focus returns to the name editor', async () => {
    const name = spaceNode('beta').querySelector('.space-name'); name.focus();
    menuAction(name, 'New Folder'); document.querySelector('[role="dialog"] input').value = 'Visible immediately';
    fire(document.querySelector('form'), 'submit'); await wait(300);
    assert.equal(document.activeElement, name);
    assert([...spaceNode('beta').querySelectorAll('.folder-title')].some(node => node.textContent === 'Visible immediately'));
    assert.equal(document.querySelector('.space.active').dataset.spaceId, 'beta');
    name.blur();
});

test('committed folder creation closes its editor even when the immediate sidebar repaint fails', async () => {
    const originalCreate = chrome.bookmarks.create, originalQuery = chrome.tabs.query;
    let failNextQuery = false;
    chrome.bookmarks.create = async data => { const result = await originalCreate(data); failNextQuery = true; return result; };
    chrome.tabs.query = async query => {
        if (failNextQuery) { failNextQuery = false; throw new Error('Injected post-commit render failure'); }
        return originalQuery(query);
    };
    try {
        menuAction(spaceChip('beta'), 'New Folder'); document.querySelector('[role="dialog"] input').value = 'Committed once';
        fire(document.querySelector('form'), 'submit'); await wait(300);
        assert.equal(folders.filter(folder => folder.title === 'Committed once').length, 1);
        assert.equal(document.querySelector('[role="dialog"]'), null);
        assert.match(document.getElementById('spaceOrderStatus').textContent, /Folder created/);
    } finally { chrome.bookmarks.create = originalCreate; chrome.tabs.query = originalQuery; }
});

test('real sidebar custom emoji and icon-only setting preserve both projections and the live name editor', async () => {
    menuAction(spaceChip('alpha'), 'Change Space Icon');
    const input = document.querySelector('.space-emoji-form input'); input.value = '👩🏽‍💻';
    fire(input, 'input', { inputType: 'insertFromPaste' }); fire(input.closest('form'), 'submit'); await wait(300);
    assert.equal(storedSpaces[0].icon, '👩🏽‍💻'); assert.equal(local.spaceRegistry.p.icon, '👩🏽‍💻');
    assert.equal(spaceNode('alpha').querySelector('.space-icon').textContent, '👩🏽‍💻');
    const chip = spaceChip('alpha'); assert.equal(chip.querySelector('.space-icon').textContent, '👩🏽‍💻');
    const name = spaceNode('beta').querySelector('.space-name'); name.focus();
    for (const hideSpaceNames of [true, false, true]) {
        await onChanged.emit({ sidebarAppearance: { newValue: { hideSpaceNames } } }, 'local');
        assert.equal(document.documentElement.dataset.hideSpaceNames, String(hideSpaceNames));
        assert.equal(spaceChip('alpha'), chip); assert.equal(document.activeElement, name);
        assert.match(chip.title, /^Alpha\n/); assert.equal(chip.getAttribute('aria-label'), 'Switch to space Alpha');
        assert.equal(chip.querySelector('.space-switcher-name').textContent, 'Alpha');
        assert.equal(name.value, 'Inline edit');
    }
    assert.equal(document.querySelector('.space.active').dataset.spaceId, 'beta');
    menuAction(chip, 'Change Space Icon'); assert.match(document.querySelector('[role="dialog"] h2').textContent, /Alpha/);
    assert.equal(document.querySelector('.space-emoji-form input').value, '👩🏽‍💻');
    fire(document.querySelector('[data-choice="none"]'), 'click'); await wait(300);
    assert.equal(local.spaceRegistry.p.icon, null); assert.equal(spaceNode('alpha').querySelector('.space-icon').hidden, true);
    assert.equal(spaceChip('alpha').querySelector('.space-icon'), null);
    assert.equal(spaceChip('alpha').querySelector('.space-icon-fallback').textContent, '●');
});
