import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseHTML } from 'linkedom';
import { applySpacePatch } from '../../space-store.js';

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
    { id: 3, windowId: 10, active: false, pinned: false, title: 'Temporary', url: 'https://temporary.test/' }
];
let storedSpaces = [{ id: 'alpha', name: 'Alpha', color: 'blue', bookmarkFolderId: 'p', spaceBookmarks: [1, 2], temporaryTabs: [3] }];
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
            if (message.action === 'patch') {
                storedSpaces = applySpacePatch(storedSpaces, message.before, message.after);
                await onChanged.emit({ spaces: { newValue: structuredClone(storedSpaces) } }, 'local');
            }
            if (message.action === 'activate') session.activeSpaces[message.windowId] = message.spaceId;
            return { success: true, spaces: structuredClone(storedSpaces) };
        } },
    storage: { onChanged, local: area(local), sync: area({ invertTabOrder: false }), session: area(session) },
    windows: { getCurrent(_options, callback) { callback?.({ id: 10 }); return Promise.resolve({ id: 10 }); } },
    tabs: { ...Object.fromEntries(['onActivated', 'onCreated', 'onUpdated', 'onRemoved', 'onAttached', 'onDetached', 'onMoved'].map(name => [name, listeners()])),
        async query(query) { return structuredClone(tabs.filter(tab => (!query.windowId || tab.windowId === query.windowId) && (!query.active || tab.active))); },
        async get(id) { return structuredClone(tabs.find(tab => tab.id === id)); },
        async remove(id) { tabs.splice(tabs.findIndex(tab => tab.id === id), 1); await beforeRemove?.(id); await chrome.tabs.onRemoved.emit(id, { windowId: 10 }); },
        async update(id, properties) { Object.assign(tabs.find(tab => tab.id === id), properties); return this.get(id); }
    },
    bookmarks: {
        async get(id) { return structuredClone([...folders, ...bookmarks].filter(node => node.id === id)); },
        async search({ title }) { return structuredClone(folders.filter(node => node.title === title)); },
        async getChildren(id) { await beforeTree?.(); return structuredClone([...folders, ...bookmarks].filter(node => node.parentId === id)); },
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

test('closing an inactive live bookmark preserves viewport, binding and focused close control across refresh', async () => {
    content().scrollTop = 840;
    const anchorTop = row('b28').getBoundingClientRect().top;
    close(row('b30'));
    await wait(240);
    await refresh();
    assert.equal(tabs.some(tab => tab.id === 2), false);
    assert.equal(bookmarks.some(node => node.id === 'b30'), true, 'Closing its live instance must retain the saved bookmark');
    assert.equal(row('b30').classList.contains('bookmark-only'), true);
    assert.equal(row('b28').getBoundingClientRect().top, anchorTop);
    assert.equal(content().scrollTop, 840);
    assert(document.activeElement === row('b30').querySelector('.tab-close, .tab-remove'), 'Expected focus to stay on the management control');
    assert.deepEqual(document.activeElement.focusOptions, { preventScroll: true });
    assert.equal(live(1).classList.contains('active'), true);
    assert(live(1).getBoundingClientRect().bottom < 0, 'Current active tab remains offscreen');
});

test('removing a closed saved bookmark preserves anchor and focuses the following management control', async () => {
    content().scrollTop = 840;
    const offset = row('b28').getBoundingClientRect().top;
    close(row('b30'));
    await wait(260);
    assert.equal(row('b30'), null);
    assert.equal(bookmarks.some(node => node.id === 'b30'), false);
    assert.equal(row('b28').getBoundingClientRect().top, offset);
    assert(document.activeElement === row('b31').querySelector('.tab-close, .tab-remove'), 'Expected focus to stay on the management control');
    assert.equal(content().scrollTop, 840);
});

test('repeated near-bottom removals clamp naturally without revealing the current tab', async () => {
    for (const id of ['b39', 'b38', 'b37']) {
        content().scrollTop = content().scrollHeight;
        close(row(id));
        await wait(260);
        assert.equal(row(id), null);
        assert.equal(content().scrollTop, content().scrollHeight - content().clientHeight);
        assert(content().scrollTop > 600);
        assert(document.activeElement === live(3).querySelector('.tab-close, .tab-remove'), 'Expected focus to stay on the management control');
    }
});

test('closing an inactive temporary tab preserves the visible bookmark anchor', async () => {
    content().scrollTop = 810;
    const offset = row('b28').getBoundingClientRect().top;
    close(live(3));
    await wait(240);
    await refresh();
    assert.equal(live(3), null);
    assert.equal(row('b28').getBoundingClientRect().top, offset);
});

test('loading and duplicate activation notifications cannot pull the list back to the active tab', async () => {
    content().scrollTop = 780;
    await chrome.tabs.onUpdated.emit(1, { status: 'loading' }, structuredClone(tabs[0]));
    await chrome.tabs.onUpdated.emit(1, { status: 'complete' }, structuredClone(tabs[0]));
    await activate(1);
    await wait(140);
    assert.equal(content().scrollTop, 780);
});

test('a refresh awaiting bookmark data preserves the user’s newer scroll and focus', async () => {
    let release, started;
    const ready = new Promise(resolve => { started = resolve; });
    beforeTree = async () => { beforeTree = null; started(); await new Promise(resolve => { release = resolve; }); };
    await onMessage.emit({ action: 'arcifyBookmarksChanged' });
    await ready;
    content().scrollTop = 660;
    row('b24').querySelector('.tab-close, .tab-remove').focus({ preventScroll: true });
    release(); await wait(160);
    assert.equal(content().scrollTop, 660);
    assert(document.activeElement === row('b24').querySelector('.tab-close, .tab-remove'), 'Expected focus to stay on the management control');
});

test('genuine active-tab changes still reveal and update the highlight after management', async () => {
    tabs.push({ id: 4, windowId: 10, active: false, pinned: false, title: 'New tab', url: 'https://new.test/' });
    storedSpaces[0].temporaryTabs.push(4);
    await onChanged.emit({ spaces: { newValue: structuredClone(storedSpaces) } }, 'local');
    await wait(240);
    await activate(4);
    assert.equal(live(4).classList.contains('active'), true);
    content().scrollTop = 700;
    await activate(1);
    assert.equal(content().scrollTop, 0);
    assert.equal(live(1).classList.contains('active'), true);
    // A later incidental refresh must not retain a consumed reveal intent.
    content().scrollTop = 700;
    await refresh();
    assert.equal(content().scrollTop, 700);
});

test('activation before the new row exists still reveals after membership adoption', async () => {
    tabs.push({ id: 5, windowId: 10, active: false, pinned: false, title: 'Late tab', url: 'https://late.test/' });
    content().scrollTop = 0;
    await activate(5);
    assert.equal(live(5), null);
    storedSpaces[0].temporaryTabs.push(5);
    await onChanged.emit({ spaces: { newValue: structuredClone(storedSpaces) } }, 'local');
    // Membership repaint and its queued reveal are separate tasks. Wait for
    // the actual invariant rather than racing a fixed sleep under full-suite
    // CPU load; a missing reveal still fails at the same assertions below.
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
        const row = live(5), rect = row?.getBoundingClientRect();
        if (rect && rect.top >= 0 && rect.bottom <= content().clientHeight && content().scrollTop > 700) break;
        await wait(10);
    }
    const rect = live(5).getBoundingClientRect();
    assert(rect.top >= 0 && rect.bottom <= content().clientHeight);
    assert(content().scrollTop > 700);
});


test('background membership arriving before onRemoved retains the closed bookmark’s own focus', async () => {
    const tab = { id: 6, windowId: 10, active: false, pinned: false, title: 'Storage first', url: 'https://bookmark-25.test/' };
    tabs.push(tab);
    storedSpaces[0].spaceBookmarks.push(6);
    local.pinnedTabStatesById[6] = { bookmarkId: 'b25', pinnedUrl: tab.url };
    await onChanged.emit({ spaces: { newValue: structuredClone(storedSpaces) } }, 'local');
    await wait(240);
    content().scrollTop = 660;
    const offset = row('b24').getBoundingClientRect().top;
    beforeRemove = async id => {
        beforeRemove = null;
        storedSpaces[0].spaceBookmarks = storedSpaces[0].spaceBookmarks.filter(tabId => tabId !== id);
        await onChanged.emit({ spaces: { newValue: structuredClone(storedSpaces) } }, 'local');
        // Model the worker event winning while the sidebar awaits tab cleanup.
        await wait(160);
    };
    close(row('b25'));
    await wait(400);
    assert(row('b25').classList.contains('bookmark-only'));
    assert.equal(row('b24').getBoundingClientRect().top, offset);
    assert(document.activeElement === row('b25').querySelector('.tab-remove'), 'Storage-first close retains the bookmark’s own management action');
});
