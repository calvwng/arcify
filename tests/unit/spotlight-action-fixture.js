import assert from 'node:assert/strict';
import { createSpotlightBridge } from '../../spotlight-bridge.js';
import { readSpaceActionContext } from '../../spotlight-space-actions.js';
import { SpaceStore } from '../../space-store.js';
import { Utils } from '../../utils.js';
import { BRIDGE_TYPE, BRIDGE_VERSION, PEER_KEY, PAIRING_GENERATION_KEY, SPACE_ACTIONS_FEATURE, validateRequest, isSpaceActionContext } from '../../spotlight-bridge-protocol.js';

const PEER = 'a'.repeat(32), SELF = 'b'.repeat(32), URL = 'https://same.test/';
const clone = value => structuredClone(value);
const event = () => {
    const listeners = new Set();
    return { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn), emit: (...args) => { for (const fn of listeners) fn(...args); }, get size() { return listeners.size; } };
};
export function fixture() {
    const hooks = {}, effects = [], globalTabs = new Set();
    const tabs = [{ id: 1, windowId: 10, index: 0, active: true, title: 'Today', url: URL },
        { id: 2, windowId: 10, index: 1, active: false, title: 'Saved', url: URL },
        { id: 3, windowId: 10, index: 2, active: false, title: 'Twin', url: URL },
        { id: 9, windowId: 20, index: 0, active: true, title: 'Other window copy', url: URL }];
    const windows = [{ id: 10, type: 'normal' }, { id: 20, type: 'normal' }];
    const nodes = [{ id: 'arc', parentId: 'bar', title: 'Arcify' }, { id: 'root', parentId: 'arc', title: 'Space' },
        { id: 'nested', parentId: 'root', title: 'Nested' }, { id: 'pin', parentId: 'nested', title: 'Saved', url: URL },
        { id: 'twin', parentId: 'nested', title: 'Separate same URL pin', url: URL }];
    const local = { [PEER_KEY]: PEER, [PAIRING_GENERATION_KEY]: 'generation-1', pinnedTabStatesById: {
        2: { bookmarkId: 'pin', pinnedUrl: URL }, 9: { bookmarkId: 'pin', pinnedUrl: URL }
    }, tabNameOverridesById: { 1: { name: 'My exact Today', originalDomain: 'same.test' }, 2: { name: 'Old alias' }, 3: { name: 'Other alias' }, 9: { name: 'Old alias' } } };
    const session = {}, sync = {};
    const area = (data, areaName) => ({
        async get(keys) {
            await hooks.storageGet?.(areaName, keys);
            const ids = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys || data);
            const result = Object.fromEntries(ids.map(id => [id, clone(data[id] ?? (typeof keys === 'object' && !Array.isArray(keys) ? keys?.[id] : undefined))]));
            await hooks.storageAfterGet?.(areaName, keys); return result;
        },
        async set(values) {
            await hooks.storageSet?.(areaName, values);
            const changes = Object.fromEntries(Object.entries(values).map(([key, newValue]) => [key, { oldValue: clone(data[key]), newValue: clone(newValue) }]));
            Object.assign(data, clone(values)); effects.push(['storage', areaName, clone(values)]);
            chrome.storage.onChanged.emit(changes, areaName);
            await hooks.storageAfterSet?.(areaName, values);
        }
    });
    globalThis.chrome = {
        runtime: { id: SELF, getURL: path => `chrome-extension://${SELF}/${path}` },
        storage: { local: area(local, 'local'), session: area(session, 'session'), sync: area(sync, 'sync'), onChanged: event() },
        windows: { async get(id) { await hooks.windowGet?.(id); const result = windows.find(window => window.id === id); if (!result) throw new Error('Closed window'); return clone(result); },
            async update() { effects.push(['forbidden-focus']); throw new Error('No cross-window focus'); } },
        tabs: {
            onActivated: event(), onUpdated: event(), onRemoved: event(), onAttached: event(), onDetached: event(), onReplaced: event(),
            async query(query = {}) { await hooks.tabQuery?.(query); const result = clone(tabs.filter(tab => query.windowId === undefined || tab.windowId === query.windowId)); await hooks.tabAfterQuery?.(); return result; },
            async get(id) { await hooks.tabGet?.(id); const tab = tabs.find(tab => tab.id === id); if (!tab) throw new Error('Closed tab'); return clone(tab); },
            async create(options) { const tab = { ...options, id: 100, title: 'Arcify settings', index: tabs.length }; tabs.push(tab); for (const other of tabs) if (other.windowId === tab.windowId && other.id !== tab.id) other.active = false; effects.push(['create-tab', clone(options)]); await hooks.createdTab?.(tab); return clone(tab); },
            async update() { effects.push(['forbidden-tab-update']); throw new Error('No native tab mutation'); },
            async move() { effects.push(['forbidden-tab-move']); throw new Error('No native tab reorder'); },
            async remove() { effects.push(['forbidden-tab-close']); throw new Error('No tab closures'); }
        },
        bookmarks: {
            onChanged: event(), onRemoved: event(), onMoved: event(), onCreated: event(),
            async get(id) { await hooks.bookmarkGet?.(id); return clone(nodes.filter(node => node.id === id)); },
            async search({ title }) { await hooks.bookmarkSearch?.(); return clone(nodes.filter(node => node.title === title)); },
            async getChildren(id) { await hooks.children?.(id); return clone(nodes.filter(node => node.parentId === id)); },
            async create(options) { await hooks.beforeCreate?.(options); const node = { ...clone(options), id: `created-${nodes.length}` }; nodes.push(node); effects.push(['create-bookmark', clone(node)]); chrome.bookmarks.onCreated.emit(node.id, clone(node)); await hooks.created?.(node); return clone(node); },
            async remove(id) { await hooks.beforeRemove?.(id); const index = nodes.findIndex(node => node.id === id); if (index < 0) throw new Error('Missing bookmark'); nodes.splice(index, 1); effects.push(['remove-bookmark', id]); chrome.bookmarks.onRemoved.emit(id); await hooks.removed?.(id); }
        }
    };
    Utils._pinnedStateChain = Promise.resolve(); Utils._tabNameChain = Promise.resolve();
    const store = new SpaceStore(); store.initialized = true;
    store.spaces = [{ id: 'space', name: 'Space', color: 'blue', bookmarkFolderId: 'root', temporaryTabs: [1, 3], spaceBookmarks: [2, 9] }];
    store.active = { 10: 'space', 20: 'space' }; store.provisional = new Set(); store.recoveryCandidates = new Set();
    store.isGlobalTab = id => globalTabs.has(typeof id === 'object' ? id.id : id);
    store.discoverBookmarkSpaces = async () => false;
    store.persist = async ({ beforeWrite, skipGroupSync } = {}) => {
        await hooks.persist?.(); await beforeWrite?.();
        await chrome.storage.local.set({ spaces: clone(store.spaces) });
        await beforeWrite?.(); await chrome.storage.session.set({ activeSpaces: clone(store.active) });
        effects.push(['persist', { skipGroupSync }]);
    };
    let id = 0;
    const request = (command, payload = {}) => ({ type: BRIDGE_TYPE, version: BRIDGE_VERSION, windowId: 10,
        requestId: `space-actions-${++id}`, supportedFeatures: [SPACE_ACTIONS_FEATURE], command, ...payload });
    const sender = { id: PEER, url: `chrome-extension://${PEER}/background.js` }, handle = createSpotlightBridge(store);
    const active = id => { for (const tab of tabs) if (tab.windowId === 10) tab.active = tab.id === id; };
    const capture = async (tabId = 1) => { const result = await handle(request('actionContext', { tabId }), sender); assert.equal(result.ok, true, JSON.stringify(result)); return result.actionContext; };
    const run = (command, context, payload = {}) => handle(request(command, { context, ...payload }), sender);
    const writes = () => effects.filter(([type, area, data]) => type !== 'storage' || !Object.hasOwn(data, 'spotlightBridgeRequests'));
    return { hooks, effects, tabs, windows, nodes, local, session, globalTabs, store, request, sender, handle, active, capture, run, writes };
}

export function success(result) { assert.equal(result.ok, true, JSON.stringify(result)); return result; }
export function error(result, code) { assert.equal(result.ok, false, JSON.stringify(result)); if (code) assert.equal(result.error.code, code, JSON.stringify(result)); }
