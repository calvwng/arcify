import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parentPort, workerData } from 'node:worker_threads';
import { parseHTML } from 'linkedom';
import { applySpacePatch } from '../../space-store.js';

// Each worker imports a fresh real sidebar/module graph, like reopening the
// panel. Only Chrome facilities and DOM layout are substituted.
const { local, session, tabs, bookmarks, windowId = 10, concurrentPin } = workerData;
const { window } = parseHTML(await readFile(new URL('../../sidebar.html', import.meta.url), 'utf8'));
const { document } = window;
window.HTMLElement.prototype.getBoundingClientRect = () => ({ top: 0, bottom: 20, left: 0, right: 300, width: 300, height: 20 });
window.HTMLElement.prototype.scrollTo = () => {};
Object.defineProperty(window.HTMLSelectElement.prototype, 'value', {
    get() { return this.querySelector('option[selected]')?.value || ''; },
    set(value) { for (const option of this.querySelectorAll('option')) option.toggleAttribute('selected', option.value === value); }
});
const listeners = () => ({ addListener() {} });
const area = state => ({
    async get(keys) {
        const names = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys || state);
        return Object.fromEntries(names.map(key => [key, structuredClone(state[key] ?? keys?.[key])]));
    },
    async set(next) { Object.assign(state, structuredClone(next)); },
    async remove(key) { delete state[key]; }
});
const patches = [], bookmarkWrites = [], warnings = [];
let firstSpaceRead = true;
Object.assign(globalThis, {
    window, document, Event: window.Event, Node: window.Node,
    localStorage: { getItem() { return null; }, setItem() {} },
    getComputedStyle: () => ({ getPropertyValue() { return ''; } }),
    matchMedia: () => ({ matches: true, addEventListener() {} }),
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    MutationObserver: window.MutationObserver,
    alert(message) { assert.fail(message); }
});
globalThis.chrome = {
    runtime: {
        onMessage: listeners(), getURL: path => `chrome-extension://fixture/${path}`, getManifest: () => ({ version: 'test' }),
        async sendMessage(message) {
            if (message.type === 'favoriteStore') return { success: true, favorites: [], nativeTabs: tabs.filter(tab => tab.pinned) };
            if (message.type === 'sidebarTour') return { success: true, state: null };
            assert.equal(message.type, 'spaceStore');
            if (message.action === 'get') {
                const spaces = structuredClone(local.spaces);
                if (firstSpaceRead && concurrentPin) {
                    local.spaces.find(space => space.id === concurrentPin.spaceId).spaceBookmarks.push(concurrentPin.tabId);
                    local.pinnedTabStatesById[concurrentPin.tabId] = concurrentPin.binding;
                }
                firstSpaceRead = false;
                return { success: true, spaces };
            }
            if (message.action === 'patch') {
                patches.push(structuredClone(message));
                local.spaces = applySpacePatch(local.spaces, message.before, message.after);
            }
            if (message.action === 'activate') session.activeSpaces[message.windowId] = message.spaceId;
            return { success: true, spaces: structuredClone(local.spaces) };
        }
    },
    storage: { onChanged: listeners(), local: area(local), sync: area({ invertTabOrder: false }), session: area(session) },
    windows: { getCurrent(_options, callback) { callback?.({ id: windowId }); return Promise.resolve({ id: windowId }); } },
    tabs: {
        ...Object.fromEntries(['onActivated', 'onCreated', 'onUpdated', 'onRemoved', 'onAttached', 'onDetached', 'onMoved'].map(name => [name, listeners()])),
        async query(query) { return structuredClone(tabs.filter(tab =>
            (!query.windowId || tab.windowId === query.windowId) && (!query.currentWindow || tab.windowId === windowId) &&
            (!query.active || tab.active) && (query.pinned === undefined || query.pinned === tab.pinned))); },
        async get(id) { const tab = tabs.find(tab => tab.id === id); if (!tab) throw new Error('Missing tab'); return structuredClone(tab); }
    },
    bookmarks: {
        async get(id) { return structuredClone(bookmarks.filter(node => node.id === id)); },
        async search({ title }) { return structuredClone(bookmarks.filter(node => node.title === title)); },
        async getChildren(id) { return structuredClone(bookmarks.filter(node => node.parentId === id)); },
        ...Object.fromEntries(['create', 'update', 'move', 'remove', 'removeTree'].map(name => [name, async (...args) => {
            bookmarkWrites.push([name, ...args]); throw new Error('Sidebar initialization must not mutate bookmarks');
        }]))
    },
    tabGroups: { async query() { return []; } }
};
const domReady = [];
const addListener = document.addEventListener.bind(document);
document.addEventListener = (name, callback, ...rest) => {
    if (name === 'DOMContentLoaded') domReady.push(callback);
    else addListener(name, callback, ...rest);
};
const { Logger } = await import('../../logger.js');
Logger.warn = (...args) => warnings.push(args.map(String));
Logger.error = (...args) => warnings.push(args.map(String));
await import('../../sidebar.js');
await Promise.all(domReady.map(callback => callback()));
parentPort.postMessage({
    local, session, patches, bookmarkWrites, warnings,
    rows: [...document.querySelectorAll('.space.active .tab')].map(row => ({
        tabId: row.dataset.tabId ? Number(row.dataset.tabId) : null,
        bookmarkId: row.dataset.bookmarkId || null, pinnedUrl: row.dataset.pinnedUrl || null,
        title: row.querySelector('.tab-title-input')?.value,
        navigated: Boolean(row.querySelector('.tab-url-changed-slash.visible'))
    }))
});
