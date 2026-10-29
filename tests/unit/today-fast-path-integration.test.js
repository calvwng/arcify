import { readSharedToday, openSharedToday } from '../../shared-today.js';
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
let treeReads = 0; let beforeTree, beforeGetBookmarks, beforeRemove, beforeGetTab, beforeTabMenuRequest, beforeTodayMoveRequest;
const mutations = [], saveRequests = [], splitRequests = [], nativeSplitCalls = [], todayMoveRequests = [], savedMoveRequests = [];
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
            if (message.type === 'moveSavedItemsToSpace') {
                savedMoveRequests.push(structuredClone(message));
                return { success: true, batch: { total: message.entries.length, completed: message.entries.map(entry => entry.bookmarkId),
                    remaining: [], uncertain: false, destinationSpaceId: message.destinationSpaceId } };
            }
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
            if (message.type === 'arcifySharedToday') { try { return { success: true, ...(message.action === 'read' ? { entries: await readSharedToday(store) } : await openSharedToday(store, message)) }; } catch (error) { return { success: false, error: error.message }; } }
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
    windows: { async getAll() { return [{id:10,type:'normal'}, {id:20,type:'normal'}]; }, async get(id) { return { id, type: 'normal', incognito: false }; }, getCurrent(_options, callback) { callback?.({ id: 10 }); return Promise.resolve({ id: 10 }); } },
    tabs: { ...Object.fromEntries(['onActivated', 'onCreated', 'onUpdated', 'onRemoved', 'onAttached', 'onDetached', 'onMoved'].map(name => [name, listeners()])),
        async query(query) { return structuredClone(tabs.filter(tab => (!query.windowId || tab.windowId === query.windowId) && (!query.active || tab.active))); },
        async get(id) { await beforeGetTab?.(id); return structuredClone(tabs.find(tab => tab.id === id)); },
        async remove(id) { tabs.splice(tabs.findIndex(tab => tab.id === id), 1); await beforeRemove?.(id); await chrome.tabs.onRemoved.emit(id, { windowId: 10 }); },
        async duplicate(id) { const next = { ...structuredClone(tabs.find(tab => tab.id === id)), id: 88, active: false }; tabs.push(next); return next; },
        async update(id, properties) { mutations.push(['tab-update', id, properties]); Object.assign(tabs.find(tab => tab.id === id), properties); return this.get(id); }
    },
    bookmarks: { ...Object.fromEntries(['onCreated','onChanged','onMoved','onRemoved','onChildrenReordered','onImportEnded'].map(name => [name, listeners()])),
        async create(data) { const node = { ...data, id: String(nextBookmarkId++) }; (node.url ? bookmarks : folders).push(node); mutations.push(['bookmark-create', structuredClone(node)]); return structuredClone(node); },
        async get(id) { await beforeGetBookmarks?.(id); const ids = Array.isArray(id) ? id : [id]; return structuredClone([...folders, ...bookmarks].filter(node => ids.includes(node.id))); },
        async getSubTree(id) {
            const read = async node => node.url ? node : { ...node, children: await Promise.all((await this.getChildren(node.id)).map(read)) };
            return Promise.all((await this.get(id)).map(read));
        },
        async search({ title }) { return structuredClone(folders.filter(node => node.title === title)); },
        async getChildren(id) { treeReads++; await beforeTree?.(); return structuredClone([...folders, ...bookmarks].filter(node => node.parentId === id).sort((a, b) => (a.index ?? Number(a.id.slice(1)) ?? 0) - (b.index ?? Number(b.id.slice(1)) ?? 0))); },
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

async function settle() { await wait(350); }
async function publishSpaces() {
    local.spaces = structuredClone(storedSpaces);
    await onChanged.emit({ spaces: { newValue: structuredClone(storedSpaces) } }, 'local');
    await settle();
}
function pinnedIdentity() { return row('b10'); }

test('Today-only create retains committed saved rows and avoids tree reads', async () => {
    await refresh();
    const pinned = pinnedIdentity(), before = treeReads;
    const child = { id: 70, openerTabId: 3, windowId: 10, active: false, pinned: false, title: 'New child', url: 'https://child.test/' };
    tabs.push(child); storedSpaces[0].temporaryTabs.splice(1, 0, child.id);
    await chrome.tabs.onCreated.emit(structuredClone(child)); await settle();
    assert(live(70)); assert.equal(pinnedIdentity(), pinned);
    assert.equal(treeReads, before, 'eligible creation must not traverse bookmark tree');
    assert.equal(live(3).nextElementSibling, live(70));
});

test('Today-only title/navigation update and removal retain saved rows', async () => {
    const pinned = pinnedIdentity(), before = treeReads;
    const child = tabs.find(tab => tab.id === 70); child.title = 'Updated child'; child.url = 'https://new-child.test/';
    await chrome.tabs.onUpdated.emit(70, { title: child.title, url: child.url }, structuredClone(child)); await settle();
    assert.equal(pinnedIdentity(), pinned); assert.match(live(70).textContent, /Updated child/);
    storedSpaces[0].temporaryTabs = storedSpaces[0].temporaryTabs.filter(id => id !== 70);
    tabs.splice(tabs.indexOf(child), 1);
    await chrome.tabs.onRemoved.emit(70, { windowId: 10 }); await settle();
    assert.equal(live(70), null); assert.equal(pinnedIdentity(), pinned); assert.equal(treeReads, before);
});

test('bookmark, sync setting and folder state changes force full saved refresh', async () => {
    let pinned = pinnedIdentity(), before = treeReads;
    bookmarks.find(node => node.id === 'b10').title = 'Changed saved title';
    await chrome.bookmarks.onChanged.emit('b10', { title: 'Changed saved title' }); await refresh();
    assert.notEqual(pinnedIdentity(), pinned); assert.match(pinnedIdentity().textContent, /Changed saved title/); assert(treeReads > before);
    pinned = pinnedIdentity(); before = treeReads;
    settings.invertTabOrder = true;
    await onChanged.emit({ invertTabOrder: { newValue: true, oldValue: false } }, 'sync'); await settle();
    assert.notEqual(pinnedIdentity(), pinned); assert(treeReads > before);
    pinned = pinnedIdentity(); before = treeReads;
    await onChanged.emit({ 'folderCollapsed:f': { newValue: false } }, 'local'); await settle();
    assert.notEqual(pinnedIdentity(), pinned); assert(treeReads > before);
    settings.invertTabOrder = false;
    await onChanged.emit({ invertTabOrder: { newValue: false, oldValue: true } }, 'sync'); await settle();
});

test('saved metadata and live saved navigation never reuse stale saved row', async () => {
    let pinned = row('b0');
    local.tabNameOverridesById = { 1: { name: 'Alias saved' } };
    await onChanged.emit({ tabNameOverridesById: { newValue: structuredClone(local.tabNameOverridesById) } }, 'local'); await settle();
    assert.notEqual(row('b0'), pinned);
    pinned = row('b0'); const tab = tabs.find(t => t.id === 1); tab.url = 'https://away.test/'; tab.title = 'Away title';
    await chrome.tabs.onUpdated.emit(1, { url: tab.url, title: tab.title }, structuredClone(tab)); await settle();
    assert.notEqual(row('b0'), pinned); assert.match(row('b0').textContent, /Away title/);
});

test('cross-section promotion rechecks represented saved IDs without duplicate Today row', async () => {
    const pinned = pinnedIdentity();
    bookmarks.push({ id: 'promoted', parentId: 'p', title: 'Promoted Today', url: 'https://same.test/' });
    local.pinnedTabStatesById[3] = { bookmarkId: 'promoted', pinnedUrl: 'https://same.test/' };
    storedSpaces[0].temporaryTabs = storedSpaces[0].temporaryTabs.filter(id => id !== 3);
    storedSpaces[0].spaceBookmarks.push(3);
    await chrome.bookmarks.onCreated.emit('promoted', structuredClone(bookmarks.at(-1)));
    await onChanged.emit({ pinnedTabStatesById: { newValue: structuredClone(local.pinnedTabStatesById) } }, 'local');
    await publishSpaces();
    assert.notEqual(pinnedIdentity(), pinned);
    assert.equal(content().querySelectorAll('[data-tab-id="3"]').length, 1);
    assert.equal(live(3).dataset.bookmarkId, 'promoted');
    assert(live(3).closest('[data-tab-type="pinned"]'));
});

test('bookmark mutation during a pending Today render invalidates reuse', async () => {
    const pinned = pinnedIdentity(); let release, reached;
    const gate = new Promise(resolve => release = resolve), ready = new Promise(resolve => reached = resolve);
    const send = chrome.runtime.sendMessage;
    let blocked = false;
    chrome.runtime.sendMessage = async function(message) {
        if (!blocked && message.type === 'arcifySharedToday' && message.action === 'read') { blocked = true; reached(); await gate; }
        return send.call(this, message);
    };
    const child = { id: 71, openerTabId: 4, windowId: 10, active: false, pinned: false, title: 'Race child', url: 'https://race.test/' };
    tabs.push(child); storedSpaces[0].temporaryTabs.push(71);
    const creation = chrome.tabs.onCreated.emit(structuredClone(child));
    await Promise.race([ready, wait(1500).then(() => { throw Error('render did not reach shared read'); })]);
    bookmarks.find(node => node.id === 'b10').title = 'Changed during render';
    await chrome.bookmarks.onChanged.emit('b10', { title: 'Changed during render' });
    release(); await creation; await settle(); chrome.runtime.sendMessage = send;
    assert.notEqual(pinnedIdentity(), pinned); assert.match(pinnedIdentity().textContent, /Changed during render/); assert(live(71));
});

test('repeated Today refreshes preserve saved handler identity and closed-row gesture semantics', async () => {
    const pinned = pinnedIdentity();
    for (let i = 0; i < 3; i++) {
        const child = tabs.find(t => t.id === 71); child.title = `Race child ${i}`;
        await chrome.tabs.onUpdated.emit(71, { title: child.title }, structuredClone(child)); await settle();
        assert.equal(pinnedIdentity(), pinned);
    }
    const before = mutations.length;
    event(pinned.querySelector('.tab-details'), 'dblclick'); await wait(30);
    assert.equal(mutations.length, before, 'closed saved row does not acquire a live editor handler');
});

test('active editor defers Today commit and a fresh event after cancellation retains saved section', async () => {
    const pinned = pinnedIdentity();
    event(live(71).querySelector('.tab-details'), 'dblclick'); await wait(40);
    assert(document.getElementById('tabEditDialog'));
    const child = { id: 72, openerTabId: 71, windowId: 10, active: false, pinned: false, title: 'Deferred child', url: 'https://deferred.test/' };
    tabs.push(child); storedSpaces[0].temporaryTabs.push(72);
    local.spaces = structuredClone(storedSpaces);
    await onChanged.emit({ spaces: { newValue: structuredClone(storedSpaces) } }, 'local');
    await chrome.tabs.onCreated.emit(structuredClone(child)); await wait(150);
    assert.equal(live(72), null); assert.equal(pinnedIdentity(), pinned);
    event(document.getElementById('tabEditCancel'), 'click'); await wait(30);
    // Baseline also needs a subsequent event here; automatic dialog-cancel refresh is outside this optimization.
    await chrome.tabs.onUpdated.emit(72, { url: child.url }, structuredClone(child)); await settle();
    assert(live(72)); assert.equal(pinnedIdentity(), pinned);
});

test('pagehide cancellation does not poison subsequent Today-only rendering', async () => {
    const pinned = pinnedIdentity();
    window.dispatchEvent(new window.Event('pagehide')); await wait(20);
    const child = { id: 73, openerTabId: 71, windowId: 10, active: false, pinned: false, title: 'After pagehide', url: 'https://resumed.test/' };
    tabs.push(child); storedSpaces[0].temporaryTabs.push(73);
    await chrome.tabs.onCreated.emit(structuredClone(child)); await settle();
    assert(live(73)); assert.equal(pinnedIdentity(), pinned);
});

test('saved frozen-only transition followed by Today creation retains saved DOM and avoids tree reads', async () => {
    const pinned = pinnedIdentity(), before = treeReads;
    const saved = tabs.find(tab => storedSpaces[0].spaceBookmarks.includes(tab.id));
    assert(saved); saved.frozen = !saved.frozen;
    await chrome.tabs.onUpdated.emit(saved.id, { frozen: saved.frozen }, structuredClone(saved));
    const child = { id: 74, openerTabId: 4, windowId: 10, active: false, pinned: false, title: 'Frozen transition child', url: 'https://frozen-child.test/' };
    tabs.push(child); storedSpaces[0].temporaryTabs.push(74);
    await chrome.tabs.onCreated.emit(structuredClone(child)); await settle();
    assert(live(74)); assert.equal(pinnedIdentity(), pinned); assert.equal(treeReads, before);
});

test('changed live saved native snapshots replace only changed rows and retain folder/closed DOM', async () => {
    folders.push({id:'retained-folder',parentId:'p',title:'Retained folder'});
    bookmarks.find(b=>b.id==='b30').parentId='retained-folder';
    await chrome.bookmarks.onCreated.emit('retained-folder',structuredClone(folders.at(-1)));await refresh();
    const saved=tabs.find(t=>t.id===1);
    for(const [index,[field,value]] of [['active',false],['highlighted',true],['index',9],['url','https://new-saved.test/'],['title','New saved page title'],['pendingUrl','https://pending-saved.test/'],['unknownNativeField',{version:1}]].entries()) {
        const old=row('b0'),closed=pinnedIdentity(),folder=row('retained-folder'),unchanged=row('b30'),reads=treeReads;
        saved[field]=value;
        await chrome.tabs.onUpdated.emit(saved.id,{[field]:value},structuredClone(saved));
        const child={id:100+index,openerTabId:4,windowId:10,active:false,pinned:false,title:`Snapshot child ${index}`,url:'https://snapshot-child.test/'};
        tabs.push(child);storedSpaces[0].temporaryTabs.push(child.id);
        await chrome.tabs.onCreated.emit(structuredClone(child));await settle();
        assert.notEqual(row('b0'),old,`${field} must replace captured saved handlers`);
        assert.equal(pinnedIdentity(),closed);assert.equal(row('retained-folder'),folder);assert.equal(row('b30'),unchanged);
        assert.equal(treeReads,reads);assert(live(child.id));
        assert.equal(row('b0').dataset.tabId,'1');assert.equal(row('b0').dataset.bookmarkId,'b0');
        if(field==='url')assert.equal(row('b0').dataset.url,value);
        if(field==='title')assert.match(row('b0').textContent,/New saved page title/);
    }
});

test('saved Split identity transition forces full refresh instead of retaining old registration', async () => {
    const old=pinnedIdentity(),saved=tabs.find(t=>t.id===1),reads=treeReads;
    saved.splitViewId=902;
    await chrome.tabs.onUpdated.emit(1,{splitViewId:902},structuredClone(saved));await settle();
    assert.notEqual(pinnedIdentity(),old);assert(treeReads>reads);
    saved.splitViewId=-1;await chrome.tabs.onUpdated.emit(1,{splitViewId:-1},structuredClone(saved));await settle();
});

test('bookmark race discards detached changed saved rows and commits latest bookmark title',async()=>{
    const old=row('b0'),saved=tabs.find(t=>t.id===1);let release,reached;
    const gate=new Promise(r=>release=r),ready=new Promise(r=>reached=r),send=chrome.runtime.sendMessage;let blocked=false;
    chrome.runtime.sendMessage=async function(message){
        if(!blocked&&message.type==='arcifySharedToday'&&message.action==='read'){blocked=true;reached();await gate;}
        return send.call(this,message);
    };
    try {
        saved.title='First pending title';
        const rendering=chrome.tabs.onAttached.emit(1,{newWindowId:10});
        await Promise.race([ready,wait(1500).then(()=>{throw Error('row replacement did not reach commit gate');})]);
        assert.equal(row('b0'),old,'changed saved row must remain detached until all checks pass');
        bookmarks.find(b=>b.id==='b0').title='Authoritative saved title';
        await chrome.bookmarks.onChanged.emit('b0',{title:'Authoritative saved title'});
        saved.title='Latest pending title';await chrome.tabs.onUpdated.emit(1,{title:saved.title},structuredClone(saved));
        release();await rendering;await settle();
        assert.notEqual(row('b0'),old);assert.equal(row('b0').dataset.bookmarkTitle,'Authoritative saved title');
        assert.match(row('b0').textContent,/Latest pending title/);
    } finally {release();chrome.runtime.sendMessage=send;}
});

test('active editor prevents saved-row replacement until cancellation and a fresh event',async()=>{
    const old=row('b0'),closed=pinnedIdentity(),saved=tabs.find(t=>t.id===1);
    event(live(71).querySelector('.tab-details'),'dblclick');await wait(40);assert(document.getElementById('tabEditDialog'));
    saved.index=(saved.index||0)+1;
    await chrome.tabs.onUpdated.emit(1,{index:saved.index},structuredClone(saved));
    const child={id:108,openerTabId:4,windowId:10,active:false,pinned:false,title:'Editor pending child',url:'https://editor-pending.test/'};
    tabs.push(child);storedSpaces[0].temporaryTabs.push(child.id);
    await chrome.tabs.onCreated.emit(structuredClone(child));await wait(150);
    assert.equal(row('b0'),old);assert.equal(pinnedIdentity(),closed);
    event(document.getElementById('tabEditCancel'),'click');await wait(30);
    await chrome.tabs.onUpdated.emit(108,{url:child.url},structuredClone(child));await settle();
    assert.notEqual(row('b0'),old);assert.equal(pinnedIdentity(),closed);assert(live(108));
});

test('row-only saved refresh preserves fresh immutable Split registration and refuses its drag',async()=>{
    const saved=tabs.find(t=>t.id===1);saved.splitViewId=903;
    await chrome.tabs.onUpdated.emit(1,{splitViewId:903},structuredClone(saved));await settle();
    const splitRow=row('b0'),closed=pinnedIdentity(),reads=treeReads;
    saved.index=(saved.index||0)+1;saved.pendingUrl='https://pending-split.test/';
    const child={id:109,openerTabId:4,windowId:10,active:false,pinned:false,title:'Split registration child',url:'https://split-registration.test/'};
    tabs.push(child);storedSpaces[0].temporaryTabs.push(child.id);
    await chrome.tabs.onCreated.emit(structuredClone(child));await settle();
    assert.notEqual(row('b0'),splitRow);assert.equal(pinnedIdentity(),closed);assert.equal(treeReads,reads);
    const before=structuredClone(mutations);
    const drag=event(row('b0'),'dragstart',{dataTransfer:{setData(){assert.fail('Split row must refuse payload registration');}}});
    assert(drag.defaultPrevented,'replacement row must register native Split guard anew');
    assert.deepEqual(mutations,before);
    saved.splitViewId=-1;delete saved.pendingUrl;await chrome.tabs.onUpdated.emit(1,{splitViewId:-1},structuredClone(saved));await settle();
});

test('replacement saved-row menu addresses exact live binding and rejects later binding drift',async()=>{
    clear();const saved=tabs.find(t=>t.id===1),old=row('b0'),closed=pinnedIdentity();
    saved.index=(saved.index||0)+1;
    await chrome.tabs.onAttached.emit(1,{newWindowId:10});await settle();
    assert.notEqual(row('b0'),old);assert.equal(pinnedIdentity(),closed);
    const requests=[];beforeTabMenuRequest=message=>{requests.push(structuredClone(message));};
    try {
        event(row('b0'),'contextmenu',{pageX:20,pageY:20});await wait(40);
        const mute=document.querySelector('[data-action="mute"]');assert(mute);
        const before=structuredClone(mutations),binding=local.pinnedTabStatesById[1];
        local.pinnedTabStatesById[1]={...binding,bookmarkId:'wrong-binding'};
        try {event(mute,'click');await wait(100);}
        finally {local.pinnedTabStatesById[1]=binding;}
        assert.deepEqual(mutations,before,'action must reread binding before native mute');
        assert(requests.length>0);assert(requests.every(r=>r.tabId===1&&r.bookmarkId==='b0'&&r.spaceId==='alpha'));
        assert(requests.some(r=>r.action==='describe'));
    } finally {beforeTabMenuRequest=null;clear();}
});

test('settled bookkeeping receipts followed by saved index change retain bookmark structure',async()=>{
    const saved=tabs.find(t=>t.id===1),old=row('b0'),closed=pinnedIdentity(),folder=row('retained-folder'),reads=treeReads;
    await onChanged.emit({tabLastActivity:{newValue:{}} ,favoriteContinuity:{newValue:{}}},'local');
    await onChanged.emit({favoriteContinuityReceipt:{newValue:{}}},'session');
    saved.index=(saved.index||0)+1;
    await chrome.tabs.onAttached.emit(1,{newWindowId:10});await settle();
    assert.notEqual(row('b0'),old);assert.equal(pinnedIdentity(),closed);assert.equal(row('retained-folder'),folder);assert.equal(treeReads,reads);
});

for(const boundary of ['ownership','metadata','shared']) test(`receipt during ${boundary} read discards changed saved rows before a fresh retry`,async()=>{
    const saved=tabs.find(t=>t.id===1),old=row('b0'),closed=pinnedIdentity();saved.index=(saved.index||0)+1;
    let release,reached,releaseRetry,reachedRetry,entered=false,shared=0,ownershipReads=0;
    const gate=new Promise(r=>release=r),ready=new Promise(r=>reached=r),retryGate=new Promise(r=>releaseRetry=r),retryReady=new Promise(r=>reachedRetry=r);
    const send=chrome.runtime.sendMessage,get=chrome.storage.local.get;
    const pause=async()=>{if(!entered){entered=true;reached();await gate;}};
    chrome.runtime.sendMessage=async function(message){
        // Attachment first refreshes the global Favorites strip; the second read is renderSpaceTabs ownership.
        if(boundary==='ownership'&&message.type==='favoriteStore'&&message.action==='get'&&++ownershipReads===2)await pause();
        if(message.type==='arcifySharedToday'&&message.action==='read'){
            shared++;if(boundary==='shared'&&shared===1)await pause();
            if(shared===2){reachedRetry();await retryGate;}
        }
        return send.call(this,message);
    };
    chrome.storage.local.get=async function(keys){
        const result=await get.call(this,keys);
        if(boundary==='metadata'&&Array.isArray(keys)&&keys.includes('pinnedTabStatesById')&&keys.includes('tabNameOverridesById'))await pause();
        return result;
    };
    const deadline=promise=>Promise.race([promise,wait(2000).then(()=>{throw Error(`missing ${boundary} render gate`);})]);
    try {
        const rendering=chrome.tabs.onAttached.emit(1,{newWindowId:10});await deadline(ready);
        await onChanged.emit({favoriteContinuityReceipt:{newValue:{}}},'session');release();
        await deadline(retryReady);
        assert.equal(row('b0'),old,'receipt must prevent publishing the first changed-row build');
        releaseRetry();await rendering;await settle();
        assert.notEqual(row('b0'),old);assert.equal(pinnedIdentity(),closed);
    } finally {release();releaseRetry();chrome.runtime.sendMessage=send;chrome.storage.local.get=get;}
});

test('Favorite ownership changes remain a full saved-section invalidation',async()=>{
    for(const [key,area] of [['favoriteSession','session'],['persistentFavorites','local']]) {
        const old=pinnedIdentity(),saved=tabs.find(t=>t.id===1),reads=treeReads;
        await onChanged.emit({[key]:{newValue:{}}},area);saved.index=(saved.index||0)+1;
        await chrome.tabs.onAttached.emit(1,{newWindowId:10});await settle();
        assert.notEqual(pinnedIdentity(),old);assert(treeReads>reads);
    }
});

test('projected saved-row replacement preserves bookmark anchor through collapse cycles',async()=>{
    for(const id of ['b29','b31'])bookmarks.find(b=>b.id===id).parentId='retained-folder';
    settings.showAllOpenTabsInCollapsedFolders=true;
    await onChanged.emit({showAllOpenTabsInCollapsedFolders:{newValue:true}},'sync');await refresh();
    const folder=row('retained-folder'),before=row('b29'),after=row('b31'),old=row('b30'),saved=tabs.find(t=>t.id===2),reads=treeReads;
    assert.equal(old.parentElement.className,'folder-collapsed-tabs');
    saved.index=(saved.index||0)+1;
    await chrome.tabs.onAttached.emit(2,{newWindowId:10});await settle();
    assert.notEqual(row('b30'),old);assert.equal(row('retained-folder'),folder);assert.equal(row('b29'),before);assert.equal(row('b31'),after);assert.equal(treeReads,reads);
    const header=folder.querySelector('.folder-header');event(header,'click');
    assert.deepEqual([...folder.querySelector('.folder-content').querySelectorAll(':scope > .tab')].map(n=>n.dataset.bookmarkId),['b29','b30','b31']);
    event(header,'click');assert.equal(row('b30').parentElement.className,'folder-collapsed-tabs');
    event(header,'click');
    assert.deepEqual([...folder.querySelector('.folder-content').querySelectorAll(':scope > .tab')].map(n=>n.dataset.bookmarkId),['b29','b30','b31']);
    await settle();
});

test('same-folder native bookmark reorder still forces full structural refresh',async()=>{
    const old=row('b29');bookmarks.find(b=>b.id==='b29').index=32;bookmarks.find(b=>b.id==='b31').index=29;
    await chrome.bookmarks.onChildrenReordered.emit('retained-folder',{childIds:['b31','b30','b29']});await refresh();
    assert.notEqual(row('b29'),old);
    assert.deepEqual([...row('retained-folder').querySelector('.folder-content').querySelectorAll(':scope > .tab')].map(n=>n.dataset.bookmarkId),['b31','b30','b29']);
});





