import { readSharedToday, openSharedToday } from '../../shared-today.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseHTML } from 'linkedom';
import { applySpacePatch, SpaceStore } from '../../space-store.js';
import { saveTodayTabsInNewFolder } from '../../today-folder-store.js';
import { runTabMenuAction } from '../../tab-menu-actions.js';
import { runTodaySplitAction } from '../../today-split-action.js';
import { moveTodayTabsToSpace } from '../../today-move-store.js';

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
let beforeTree, beforeGetBookmarks, beforeRemove, beforeGetTab, beforeTabMenuRequest, beforeTodayMoveRequest;
const closeRequests = [];
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
            if (message.type === 'closeSelectedTabs') { closeRequests.push(structuredClone(message)); return { success: true, completed: message.entries.map(e => e.tabId), uncertain: false }; }
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
    windows: { async update(id, properties) { mutations.push(['window-update',id,properties]); return {id,...properties}; }, async getAll() { return [{id:10,type:'normal'}, {id:20,type:'normal'}]; }, async get(id) { return { id, type: 'normal', incognito: false }; }, getCurrent(_options, callback) { callback?.({ id: 10 }); return Promise.resolve({ id: 10 }); } },
    tabs: { ...Object.fromEntries(['onActivated', 'onCreated', 'onUpdated', 'onRemoved', 'onAttached', 'onDetached', 'onMoved'].map(name => [name, listeners()])),
        async query(query) { return structuredClone(tabs.filter(tab => (!query.windowId || tab.windowId === query.windowId) && (!query.active || tab.active))); },
        async get(id) { await beforeGetTab?.(id); return structuredClone(tabs.find(tab => tab.id === id)); },
        async remove(id) { tabs.splice(tabs.findIndex(tab => tab.id === id), 1); await beforeRemove?.(id); await chrome.tabs.onRemoved.emit(id, { windowId: 10 }); },
        async duplicate(id) { const next = { ...structuredClone(tabs.find(tab => tab.id === id)), id: 88, active: false }; tabs.push(next); return next; },
        async update(id, properties) { mutations.push(['tab-update', id, properties]); Object.assign(tabs.find(tab => tab.id === id), properties); return this.get(id); }
    },
    bookmarks: { ...Object.fromEntries(['onCreated', 'onChanged', 'onMoved', 'onRemoved', 'onChildrenReordered', 'onImportEnded'].map(name => [name, listeners()])),
        async create(data) { const node = { ...data, id: String(nextBookmarkId++) }; (node.url ? bookmarks : folders).push(node); mutations.push(['bookmark-create', structuredClone(node)]); return structuredClone(node); },
        async get(id) { await beforeGetBookmarks?.(id); const ids = Array.isArray(id) ? id : [id]; return structuredClone([...folders, ...bookmarks].filter(node => ids.includes(node.id))); },
        async getSubTree(id) {
            const read = async node => node.url ? node : { ...node, children: await Promise.all((await this.getChildren(node.id)).map(read)) };
            return Promise.all((await this.get(id)).map(read));
        },
        async search({ title }) { return structuredClone(folders.filter(node => node.title === title)); },
        async getChildren(id) { await beforeTree?.(); return structuredClone([...folders, ...bookmarks].filter(node => node.parentId === id).sort((a, b) => (a.index ?? Number(a.id.slice(1)) ?? 0) - (b.index ?? Number(b.id.slice(1)) ?? 0))); },
        async update(id, values) {
            Object.assign(bookmarks.find(node => node.id === id), values); mutations.push(['bookmark-update', id, values]);
            // Real Chrome emits this event for API writes as well as external edits.
            // The display proof must see it before a later action reuses saved rows.
            await this.onChanged.emit(id, structuredClone(values));
            return structuredClone(bookmarks.find(node => node.id === id));
        },
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

const returnProbeInitial=structuredClone({tabs,storedSpaces,bookmarks,folders,local,session,settings});
test.beforeEach(async t=>{
 if(!t.name.startsWith('return '))return;
 clear();beforeTodayMoveRequest=null;beforeGetTab=null;
 tabs.splice(0,tabs.length,...structuredClone(returnProbeInitial.tabs));
 storedSpaces=structuredClone(returnProbeInitial.storedSpaces);
 bookmarks.splice(0,bookmarks.length,...structuredClone(returnProbeInitial.bookmarks));
 folders.splice(0,folders.length,...structuredClone(returnProbeInitial.folders));
 for(const [target,source]of [[local,returnProbeInitial.local],[session,returnProbeInitial.session],[settings,returnProbeInitial.settings]]){
  for(const key of Object.keys(target))delete target[key];Object.assign(target,structuredClone(source));
 }
 storedSpaces.push({id:'probe-other',name:'Probe other',color:'green',bookmarkFolderId:'probe-other-root',temporaryTabs:[],spaceBookmarks:[]});
 folders.push({id:'probe-other-root',parentId:'root',title:'Probe other'});
 store.spaces=storedSpaces;store.active=session.activeSpaces;
 await publishSpaces();await refresh();
 event(document.querySelector('#spaceSwitcher button[data-space-id="alpha"]'),'click');await wait(100);await refresh();
});

test('built-in diagnostic captures plain-click batch through real sidebar menu without recovery writes',async()=>{
 const original=chrome.runtime.sendMessage,requests=[];let respond;
 chrome.runtime.sendMessage=message=>{
  if(message.type!=='arcifySelectedRecoveryDiagnostic')return original(message);
  requests.push(structuredClone(message));return new Promise(resolve=>{respond=resolve;});
 };
 const before=structuredClone(storedSpaces),native=structuredClone(tabs),effects=mutations.length;
 try{
  event(live(3),'click');await activate(3);event(live(4),'click',{ctrlKey:true});await context(4);
  event(document.querySelector('[data-action="explainTodayRecovery"]'),'click');await wait(20);
  assert.equal(document.getElementById('tab-context-menu'),null);assert(document.getElementById('selectedRecoveryDiagnosticDialog'));
  assert.deepEqual(requests[0].entries.map(e=>e.tabId),[3,4]);
  const {REASON_KEYS}=await import('../../selected-recovery-diagnostics.js');
  respond({success:true,report:{schema:'arcify-selected-recovery-diagnostic-v1',status:'stable',selectedCount:2,
   counts:{...Object.fromEntries(REASON_KEYS.map(key=>[key,0])),otherSpace:1,blockedSelected:1,recoveryFlagged:1}}});await wait(20);
  const panel=document.getElementById('selectedRecoveryDiagnosticDialog');assert.match(panel.textContent,/Saved record belongs to another Space: 1/);
  assert.match(panel.textContent,/Normal Move to Space/);assert.doesNotMatch(panel.textContent,/https:/);
  event(panel.querySelectorAll('button')[1],'click');await wait(120);
  assert.equal(document.getElementById('selectedRecoveryDiagnosticDialog'),null);
  assert.equal(saveRequests.length,0);assert.equal(todayMoveRequests.length,0);
  assert.deepEqual(storedSpaces[0].temporaryTabs,before[0].temporaryTabs);
  assert.deepEqual(tabs.map(t=>[t.id,t.url]),native.map(t=>[t.id,t.url]));
  assert(mutations.slice(effects).every(([kind,,properties])=>kind==='tab-update'&&properties.active || kind==='window-update'), 'Only initial user activation may have native effects');
 }finally{chrome.runtime.sendMessage=original;clear();await activate(1);}
});

test('real sidebar registers Today modifier selection without activation, and refuses silent single-row batch drag', async () => {
    const before = mutations.length;
    event(live(3), 'click', { ctrlKey: true }); event(live(5), 'click', { shiftKey: true });
    assert.deepEqual(selected(), [3, 4, 5]);
    assert.equal(document.getElementById('todaySelectionStatus').dataset.count, '3');
    assert.equal(live(9), null, 'Remote identity must not be a local tab row');
    const remote = content().querySelector('.shared-today-remote');
    assert(remote); assert.match(remote.textContent,/Window 20/);
    assert.equal(remote.matches('[data-tab-id],.tab,.pinned-favicon'),false);
    event(remote,'contextmenu');event(remote,'click',{ctrlKey:true});
    assert.deepEqual(selected(),[3,4,5]);
    assert.equal(mutations.length, before); assert.equal(tabs.find(tab => tab.id === 1).active, true);
    const drag = event(live(3), 'dragstart', { dataTransfer: { setData() { assert.fail('Batch may not become a singleton drag'); } } });
    assert.equal(drag.defaultPrevented, true); assert.equal(document.querySelector('.dragging'), null);
});

test('production remote row opens its existing owner window without entering the selected local batch',async()=>{
 const remote=content().querySelector('.shared-today-remote');assert(remote);
 const originalGet=chrome.windows.get,originalUpdate=chrome.windows.update;
 let focusedWindow=10;
 chrome.windows.get=async id=>({id,type:'normal',incognito:false,focused:id===focusedWindow});
 chrome.windows.update=async(id,properties)=>{assert.deepEqual(properties,{focused:true});focusedWindow=id;return chrome.windows.get(id);};
 const before=tabs.map(t=>({id:t.id,windowId:t.windowId,url:t.url})),sourceSpace=store.active[10];
 try {
  const click=new window.Event('click',{bubbles:true});Object.defineProperty(click,'isTrusted',{value:true});remote.dispatchEvent(click);await wait(120);
  assert.equal(focusedWindow,20);assert.equal(store.active[20],'alpha');assert.equal(store.active[10],sourceSpace);
  assert.deepEqual(tabs.map(t=>({id:t.id,windowId:t.windowId,url:t.url})),before);assert.deepEqual(selected(),[3,4,5]);assert.equal(tabs.find(t=>t.id===1).active,true);
 } finally {chrome.windows.get=originalGet;chrome.windows.update=originalUpdate;}
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
    assert.equal(document.querySelectorAll('#tab-context-menu  .context-menu-item:not([data-action="reviewTodayRecovery"]):not([data-action="explainTodayRecovery"]):not([data-action="closeSelectedTabs"])').length, 1, 'Batch menu must not imply singular mutations affect the entire selection');
    assert.equal(document.querySelectorAll('#tab-context-menu [data-action="explainTodayRecovery"]').length,1);
    assert.equal(document.querySelectorAll('#tab-context-menu [data-action="reviewTodayRecovery"]').length,1);
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
        if (exit === 'superseding') {
            await context(6);
            await wait(160);
            assert.equal(live(101), original, 'The superseding Today menu owns a fresh row-protection hold.');
            clear(); // Closing that new menu must release both old and new holds.
        }
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
    beforeGetTab = async id => { if (id === 101) { entered = true; await delayed; } };
    try {
        event(live(101), 'keydown', { key: 'F10', shiftKey: true }); await wait(20);
        assert(entered); assert.equal(document.getElementById('tab-context-menu'), null);
        session.activeSpaces[10] = other.id;
        await onChanged.emit({ activeSpaces: { newValue: structuredClone(session.activeSpaces) } }, 'session');
        beforeGetTab = null; release(); await wait(25);
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
        beforeGetTab = null; release(); clear(); session.activeSpaces[10] = 'alpha';
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


test('keyboard Split menu returns to the live row and never steals newer focus during its request', async () => {
    clear(); const original = chrome.tabs.createSplit;
    try {
        for (const stealFocus of [false, true]) {
            let release; const waiting = new Promise(resolve => { release = resolve; });
            chrome.tabs.createSplit = async ids => { await waiting; return original(ids); };
            event(live(101), 'click', { ctrlKey: true }); event(live(103), 'click', { ctrlKey: true });
            await splitKeyboardMenu(103);
            const action = menuItem('createSplitView'); assert.equal(document.activeElement, action);
            event(action, 'keydown', { key: 'Enter' }); await wait(10);
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
            await open(); assert(document.querySelector('#tab-context-menu, #folder-context-menu'), `${open.name || 'row'}/${exit}: ${document.getElementById('favoritesDropNotice')?.textContent}`);
            leaveSidebar(exit); await wait(40);
            assert.equal(document.querySelector('#tab-context-menu, #folder-context-menu'), null);
            assert.equal(document.activeElement, document.getElementById('newTabBtn'));
            await open(); assert(document.querySelector('#tab-context-menu, #folder-context-menu'), `${open.name || 'row'}/${exit}: ${document.getElementById('favoritesDropNotice')?.textContent}`); clear();
        }
    }
    assert.deepEqual(mutations, before);
});

test('async Today/live-pin/closed-pin menu preparations cannot reopen after leaving the sidebar', async () => {
    clear(); const before = structuredClone(mutations);
    for (const kind of ['today', 'live-pin', 'closed-pin']) for (const exit of ['blur', 'hidden', 'pagehide', 'pointerdown', 'Escape']) {
        let release; const waiting = new Promise(resolve => { release = resolve; });
        const target = kind === 'today' ? live(6) : kind === 'live-pin' ? live(1) : row('b10');
        if (kind === 'closed-pin') beforeGetBookmarks = ids => Array.isArray(ids) ? waiting : undefined;
        else beforeGetTab = id => [1, 6].includes(id) ? waiting : undefined;
        try {
            event(target, 'contextmenu', { pageX: 20, pageY: 40 }); await wait(10);
            if (['blur', 'hidden', 'pagehide'].includes(exit)) leaveSidebar(exit);
            else if (exit === 'Escape') clear();
            else event(document.body, 'pointerdown');
        } finally { beforeGetBookmarks = null; beforeGetTab = null; release(); }
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


// This verifies real sidebar request wiring; durable movement itself is exercised
// by saved-move-store tests. The response stub deliberately leaves source data
// intact so each fresh menu can be tested against the same exact bookmark IDs.
test('real sidebar wires closed/live saved batches and clicked folders to exact guarded requests without switching Space', async () => {
    clear(); const beforeMutations = structuredClone(mutations), beforeTabs = structuredClone(tabs);
    try {
        for (const inverted of [false, true]) {
            settings.invertTabOrder = inverted; await refresh();
            for (const ids of [['b10'], ['b0'], ['b10', 'b0']]) {
                clear(); for (const id of ids) event(row(id), 'click', { ctrlKey: true });
                const expected = [...content().querySelectorAll('.bookmark-selected')].map(node => node.dataset.bookmarkId);
                event(row(ids[0]), 'keydown', { key: 'F10', shiftKey: true }); await wait(30);
                const trigger = menuItem('moveSavedItemsToSpace'); assert(trigger);
                assert.equal(menuItem('moveTodayTabsToSpace'), null); assert.equal(document.querySelector('.with-submenu'), null);
                event(trigger, 'click');
                const choice = document.querySelector('[data-action="moveSavedToDestination"][data-space-id="move-dest"]');
                const beforeCount = savedMoveRequests.length;
                event(choice, 'keydown', { key: 'Enter' }); event(choice, 'click'); await wait(260);
                assert.equal(savedMoveRequests.length, beforeCount + 1);
                const request = savedMoveRequests.at(-1);
                assert.equal(request.inverted, inverted); assert.equal(request.spaceId, 'alpha'); assert.equal(request.bookmarkFolderId, 'p');
                assert.equal(request.destinationBookmarkFolderId, 'move-folder');
                assert.deepEqual(request.entries, expected.map(id => {
                    const bookmark = bookmarks.find(node => node.id === id);
                    return { bookmarkId: id, parentId: bookmark.parentId, title: bookmark.title, url: bookmark.url, tabId: id === 'b0' ? 1 : null };
                }));
                assert.equal(document.querySelector('.space.active').dataset.spaceId, 'alpha'); assert.equal(session.activeSpaces[10], 'alpha');
            }
            clear(); const folder = existingFolder(), folderId = folder.dataset.bookmarkId;
            event(folder.querySelector(':scope > .folder-header'), 'keydown', { key: 'F10', shiftKey: true }); await wait(30);
            event(document.querySelector('#folder-context-menu [data-action="moveSavedItemsToSpace"]'), 'click');
            const choice = document.querySelector('[data-action="moveSavedToDestination"][data-space-id="move-dest"]');
            event(choice, 'click'); await wait(260);
            const request = savedMoveRequests.at(-1), entry = request.entries[0];
            assert.equal(request.inverted, inverted); assert.equal(entry.bookmarkId, folderId); assert.equal(entry.url, null); assert.equal(entry.tabId, null);
            assert.equal(entry.tree.id, folderId); assert.deepEqual(entry.tree.children.map(child => child.id), (await chrome.bookmarks.getChildren(folderId)).map(child => child.id));
            assert.equal(document.querySelector('.space.active').dataset.spaceId, 'alpha'); assert.equal(session.activeSpaces[10], 'alpha');
        }
        assert.deepEqual(mutations, beforeMutations); assert.deepEqual(tabs, beforeTabs);
    } finally { settings.invertTabOrder = false; clear(); await refresh(); }
});


test('real sidebar close selected pins keeps closed pins out of live request and consumes selection', async () => {
    clear(); await refresh();
    const a = row('b0'), b = row('b10'); assert(a && b);
    event(a, 'click', { ctrlKey: true }); event(b, 'click', { ctrlKey: true });
    event(b, 'contextmenu', { pageX: 20, pageY: 20 }); await wait(40);
    const close = menuItem('closeSelectedTabs'); assert(close);
    const before = closeRequests.length;
    event(close, 'click'); await wait(300);
    assert.equal(closeRequests.length, before + 1);
    assert.deepEqual(closeRequests.at(-1).entries.map(e => e.tabId), [1]);
    assert.equal(closeRequests.at(-1).entries[0].bookmarkId, 'b0');
    assert.equal(document.querySelectorAll('.bookmark-selected').length, 0);
});

test('real sidebar Delete closes selected Today IDs; outside focused row uses singleton semantics', async () => {
    clear(); await refresh();
    const rows = [...document.querySelectorAll('.space.active [data-tab-type="temporary"] .tab[data-tab-id]')];
    assert(rows.length >= 2);
    event(rows[0], 'click', { ctrlKey: true }); event(rows[1], 'click', { ctrlKey: true });
    const ids = rows.slice(0, 2).map(e => Number(e.dataset.tabId));
    event(rows[0], 'keydown', { key: 'Delete' }); await wait(300);
    assert.deepEqual(closeRequests.at(-1).entries.map(e => e.tabId), ids);
    clear(); await refresh();
    const first = live(ids[0]), second = live(ids[1]);
    event(first, 'click', { ctrlKey: true });
    event(second, 'keydown', { key: 'Delete' }); await wait(300);
    assert.deepEqual(closeRequests.at(-1).entries.map(e => e.tabId), [ids[1]]);
});

test('selected saved rows reconcile across selective refresh and close uses fresh row URL', async () => {
    clear(); await refresh();
    const oldRow=row('b0'), closedRow=row('b10'); assert(oldRow && closedRow);
    event(oldRow,'click',{ctrlKey:true});event(closedRow,'click',{ctrlKey:true});
    const tab=tabs.find(t=>t.id===1), originalUrl=tab.url;tab.url='https://fresh-selected-pin.test/';tab.title='Fresh selected pin';
    await chrome.tabs.onUpdated.emit(1,{url:tab.url,title:tab.title},structuredClone(tab));await wait(400);
    const replacement=row('b0');assert.notEqual(replacement,oldRow);assert.equal(row('b10'),closedRow);
    assert(replacement.classList.contains('bookmark-selected'));assert(closedRow.classList.contains('bookmark-selected'));
    event(replacement,'contextmenu',{pageX:20,pageY:20});await wait(40);
    const close=menuItem('closeSelectedTabs');assert(close);
    const before=closeRequests.length;event(close,'click');await wait(300);
    assert.equal(closeRequests.length,before+1);assert.deepEqual(closeRequests.at(-1).entries,[{tabId:1,url:tab.url,bookmarkId:'b0',parentId:'p'}]);
    event(oldRow,'contextmenu',{pageX:20,pageY:20});await wait(40);assert.equal(closeRequests.length,before+1);assert.equal(menuItem('closeSelectedTabs'),null);
    tab.url=originalUrl;await refresh();
});


test('plain activation then Ctrl-click keeps both Today rows through refresh for menu and Delete', async () => {
    for(const action of ['menu','delete']) {
        clear();await refresh();const rows=[...document.querySelectorAll('.space.active [data-tab-type="temporary"] .tab[data-tab-id]')];assert(rows.length>=3);
        const ids=rows.slice(0,2).map(e=>Number(e.dataset.tabId));
        event(rows[0],'click');await activate(ids[0]);await refresh();
        event(live(ids[1]),'click',{ctrlKey:true});await refresh();
        assert.deepEqual([...document.querySelectorAll('.today-selected')].map(e=>Number(e.dataset.tabId)),ids);
        const before=closeRequests.length;
        if(action==='menu'){event(live(ids[1]),'contextmenu',{pageX:20,pageY:20});await wait(40);const close=menuItem('closeSelectedTabs');assert.match(close.textContent,/Close 2 Tabs/);event(close,'click');}
        else event(live(ids[1]),'keydown',{key:'Delete'});
        await wait(300);assert.equal(closeRequests.length,before+1);assert.deepEqual(closeRequests.at(-1).entries.map(e=>e.tabId),ids);
    }
});

test('batch-size probe real sidebar plain click then Ctrl/Shift sends two or seven exact Today tabs', async () => {
    const destination = { id: 'batch-probe', name: 'Batch probe', color: 'green', bookmarkFolderId: 'batch-probe-folder', temporaryTabs: [], spaceBookmarks: [] };
    storedSpaces.push(destination); folders.push({id:destination.bookmarkFolderId,parentId:'root',title:destination.name});
    const allIds = Array.from({length:7},(_,i)=>701+i);
    for (const id of allIds) { tabs.push({id,index:tabs.length,windowId:10,active:false,pinned:false,incognito:false,groupId:-1,splitViewId:-1,title:'Batch probe',url:'https://batch.test/same'}); storedSpaces[0].temporaryTabs.push(id); }
    await publishSpaces();
    try {
        for (const count of [2,7]) for (const modifier of ['ctrlKey','shiftKey']) for (const sameUrl of [false,true]) {
            clear(); for(const id of allIds) tabs.find(tab=>tab.id===id).url=`https://batch.test/${sameUrl?'same':id}`;
            await refresh(); const ids=allIds.slice(0,count);
            event(live(ids[0]),'click');await activate(ids[0]);
            if(modifier==='ctrlKey') for(const id of ids.slice(1)) event(live(id),'click',{ctrlKey:true});
            else event(live(ids.at(-1)),'click',{shiftKey:true});
            assert.deepEqual(selected(),ids);await context(ids.at(-1));
            event(menuItem('moveTodayTabsToSpace'),'click');
            assert.match(document.querySelector('.today-move-hint').textContent,new RegExp(`Move ${count} tabs`));
            const before=todayMoveRequests.length;
            beforeTodayMoveRequest=async message=>({success:true,batch:{total:count,completed:ids,remaining:[],uncertain:false,destinationSpaceId:message.destinationSpaceId}});
            const choice=document.querySelector('[data-action="moveTodayToDestination"][data-space-id="batch-probe"]');
            for(const type of ['pointerdown','mousedown','mouseup','click']) event(choice,type);
            await wait(260);assert.equal(todayMoveRequests.length,before+1);
            assert.deepEqual(todayMoveRequests.at(-1).entries.map(entry=>entry.tabId),ids);
            assert.match(document.getElementById('favoritesDropStatus').textContent,new RegExp(`Moved ${count} tabs`));
        }
    } finally {beforeTodayMoveRequest=null;clear();}
});

test('plain Today activation then Ctrl/Shift selection reaches the destination click with a pending native callback', async () => {
    const originalGetCurrent = chrome.windows.getCurrent;
    for (const modifier of ['ctrlKey', 'shiftKey']) for (const delayed of [false, true]) {
        clear(); await refresh();
        const rows = [...content().querySelectorAll('[data-tab-type="temporary"] .tab[data-tab-id]')];
        const ids = rows.slice(0, 2).map(node => Number(node.dataset.tabId));
        let pendingCallback;
        try {
            event(rows[0], 'click'); await wait(30);
            chrome.windows.getCurrent = (options, callback) => {
                if (callback && delayed) { pendingCallback = callback; return Promise.resolve({ id: 10 }); }
                return originalGetCurrent(options, callback);
            };
            await activate(ids[0]);
            event(live(ids[1]), 'click', { [modifier]: true });
            await openMovePicker(ids[1]);
            if (delayed) { assert(pendingCallback); await pendingCallback({ id: 10 }); }
            chrome.windows.getCurrent = originalGetCurrent;
            await chrome.tabs.onUpdated.emit(ids[0], { status: 'complete' }, structuredClone(tabs.find(tab => tab.id === ids[0])));
            await wait(160);
            assert.deepEqual(selected(), ids);
            const count = todayMoveRequests.length;
            beforeTodayMoveRequest = async message => ({ success: true, batch: {
                total: message.entries.length, completed: message.entries.map(entry => entry.tabId), remaining: [],
                uncertain: false, destinationSpaceId: message.destinationSpaceId
            } });
            const choice = moveTarget();
            for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) event(choice, type);
            await wait(300);
            assert.equal(todayMoveRequests.length, count + 1);
            assert.deepEqual(todayMoveRequests.at(-1).entries.map(entry => entry.tabId), ids);
            assert.equal(session.activeSpaces[10], 'alpha');
            assert.equal(document.getElementById('favoritesDropNotice').hidden, false);
            assert.match(document.getElementById('favoritesDropStatus').textContent, /Moved 2 tabs/);
        } finally {
            chrome.windows.getCurrent = originalGetCurrent;
            beforeTodayMoveRequest = null;
            clear();
        }
    }
});

test('Today destination click exposes recovery, stale-row and transport failures in the real sidebar', async () => {
    for (const failure of ['recovery', 'stale-row', 'late-activation', 'transport']) {
        clear(); await refresh();
        const rows = [...content().querySelectorAll('[data-tab-type="temporary"] .tab[data-tab-id]')];
        const ids = rows.slice(0, 2).map(node => Number(node.dataset.tabId));
        event(rows[0], 'click'); await activate(ids[0]);
        event(live(ids[1]), 'click', { ctrlKey: true });
        await openMovePicker(ids[1]);
        const count = todayMoveRequests.length;
        beforeTodayMoveRequest = async message => {
            if (failure === 'transport') throw new Error('Disconnected');
            return { success: false, code: 'TODAY_RECOVERY_PENDING',
                error: 'Some selected tabs are still being matched to their saved Spaces.',
                batch: { total: message.entries.length, completed: [], remaining: ids,
                    uncertain: false, destinationSpaceId: message.destinationSpaceId } };
        };
        try {
            if (failure === 'stale-row') live(ids[0]).dataset.url = 'https://changed.test/';
            if (failure === 'late-activation') await activate(ids[0]);
            event(moveTarget(), 'click'); await wait(300);
            assert.equal(todayMoveRequests.length, count + (['stale-row', 'late-activation'].includes(failure) ? 0 : 1));
            assert.equal(document.getElementById('favoritesDropNotice').hidden, false);
            const text = document.getElementById('favoritesDropStatus').textContent;
            assert.match(text, failure === 'recovery' ? /Nothing was moved.*still being matched/
                : ['stale-row', 'late-activation'].includes(failure) ? /selection changed.*Nothing was moved/ : /result is unknown.*nothing was retried/);
            assert.equal(session.activeSpaces[10], 'alpha');
        } finally { beforeTodayMoveRequest = null; clear(); }
    }
});

 test('real first-click Ctrl/Shift seven-tab move commits explicit ownership through production store', async()=>{
    const savedLocal=structuredClone(local),savedSession=structuredClone(session),savedTabs=structuredClone(tabs),savedSpaces=structuredClone(storedSpaces);
    const ids=[801,802,803,804,805,806,807],target={id:'explicit-target',name:'Explicit target',bookmarkFolderId:'explicit-root',color:'blue',temporaryTabs:[],spaceBookmarks:[]};
    folders.push({id:'explicit-root',parentId:'root',title:'Explicit target'});
    try {
        for(const modifier of ['ctrlKey','shiftKey']) {
            clear();tabs.splice(0,tabs.length,...structuredClone(savedTabs));
            storedSpaces=structuredClone(savedSpaces);storedSpaces.push(structuredClone(target));
            const source=storedSpaces.find(s=>s.id==='alpha');source.temporaryTabs.push(...ids);
            for(const id of ids)tabs.push({id,index:tabs.length,windowId:10,url:`https://explicit.test/${id}`,title:'Explicit test',pinned:false,incognito:false,splitViewId:-1,active:false});
            local.todayOrderRepresentation={version:1,inverted:false};session.activeSpaces[10]='alpha';
            await publishSpaces();await refresh();event(live(ids[0]),'click');await activate(ids[0]);
            if(modifier==='ctrlKey')for(const id of ids.slice(1))event(live(id),'click',{ctrlKey:true});
            else event(live(ids.at(-1)),'click',{shiftKey:true});
            assert.deepEqual(selected(),ids);
            const backend=new SpaceStore();Object.assign(backend,{initialized:true,spaces:structuredClone(storedSpaces),active:structuredClone(session.activeSpaces),
                liveTabs:new Map(tabs.map(t=>[t.id,t])),snapshotByTab:new Map(),provisional:new Set(),recoveryCandidates:new Set(ids),savedWindows:[],
                windowKeys:new Map([[10,'current'],[20,'other']]),restoreWindowKeys:new Map([[10,'current']]),restoredMetadata:[],restoredRanks:new Map(),
                restoreQueue:ids.flatMap((id,i)=>Array.from({length:i<5?2:1},(_,j)=>({tabId:id,url:`https://explicit.test/${id}`,spaceId:i<6?target.id:'alpha',section:'temporaryTabs',windowKey:`old-${i}-${j}`,order:i})))});
            backend.isGlobalTab=()=>false;const history=structuredClone(backend.restoreQueue);let result;
            beforeTodayMoveRequest=async message=>{
                try {result=await moveTodayTabsToSpace(backend,message);storedSpaces=structuredClone(backend.spaces);await onChanged.emit({spaces:{newValue:storedSpaces}},'local');return {success:true,batch:result};}
                catch(error){return {success:false,error:error.message,batch:error.batch};}
            };
            await context(ids.at(-1));event(menuItem('moveTodayTabsToSpace'),'click');
            const choice=document.querySelector('[data-action="moveTodayToDestination"][data-space-id="explicit-target"]');assert(choice);
            for(const type of ['pointerdown','mousedown','mouseup','click'])event(choice,type);
            await wait(600);assert.deepEqual(result?.completed,ids,document.getElementById('favoritesDropStatus').textContent);
            assert.deepEqual(backend.restoreQueue,history);assert.equal(backend.recoveryCandidates.size,0);
            assert.equal(session.activeSpaces[10],'alpha');assert.equal(document.getElementById('todayRecoveryDialog'),null);
            for(const id of ids)assert(local.spaces.find(s=>s.id===target.id).temporaryTabs.includes(id));
        }
    } finally {
        beforeTodayMoveRequest=null;clear();tabs.splice(0,tabs.length,...savedTabs);storedSpaces=savedSpaces;
        for(const key of Object.keys(local))delete local[key];Object.assign(local,savedLocal);
        for(const key of Object.keys(session))delete session[key];Object.assign(session,savedSession);
        folders.splice(folders.findIndex(f=>f.id==='explicit-root'),1);await publishSpaces();await refresh();
    }
 });
test('return probe real sidebar sends both tabs back from an otherwise empty interim Space',async()=>{
 const ids=[3,4],destination={id:'return-probe',name:'Return probe',color:'green',bookmarkFolderId:'return-root',temporaryTabs:[],spaceBookmarks:[]};
 storedSpaces.push(destination);folders.push({id:'return-root',parentId:'root',title:'Return probe'});await publishSpaces();await refresh();
 beforeTodayMoveRequest=async message=>{
  const source=storedSpaces.find(s=>s.id===message.spaceId),target=storedSpaces.find(s=>s.id===message.destinationSpaceId),moved=message.entries.map(e=>e.tabId);
  source.temporaryTabs=source.temporaryTabs.filter(id=>!moved.includes(id));target.temporaryTabs.push(...moved);
  await publishSpaces();
  return {success:true,batch:{total:moved.length,completed:moved,remaining:[],uncertain:false,destinationSpaceId:target.id}};
 };
 try{
  for(const modifier of ['ctrlKey','shiftKey'])for(const [from,to]of [['alpha','return-probe'],['return-probe','alpha']]){
   event(document.querySelector(`#spaceSwitcher button[data-space-id="${from}"]`),'click');await wait(300);await refresh();
   if(from==='return-probe')assert.deepEqual(storedSpaces.find(s=>s.id===from).temporaryTabs,ids);
   event(live(ids[0]),'click');await activate(ids[0]);event(live(ids[1]),'click',{[modifier]:true});await refresh();
   assert.deepEqual(selected(),ids);await context(ids[1]);event(menuItem('moveTodayTabsToSpace'),'click');
   assert.match(document.querySelector('.today-move-hint').textContent,/Move 2 tabs/);
   const prior=todayMoveRequests.length,choice=document.querySelector(`[data-action="moveTodayToDestination"][data-space-id="${to}"]`);
   for(const type of ['pointerdown','mousedown','mouseup','click'])event(choice,type);await wait(300);
   assert.equal(todayMoveRequests.length,prior+1);assert.deepEqual(todayMoveRequests.at(-1).entries.map(e=>e.tabId),ids);
   assert.match(document.getElementById('favoritesDropStatus').textContent,/Moved 2 tabs/);
   if(from==='return-probe')assert.deepEqual(storedSpaces.find(s=>s.id===from).temporaryTabs,[]);
  }
 }finally{beforeTodayMoveRequest=null;clear();}
});

test('return probe focus loss before opening menu reduces a prior batch to the context row',async()=>{
 clear();event(document.querySelector('#spaceSwitcher button[data-space-id="alpha"]'),'click');await wait(300);await refresh();event(live(3),'click');await activate(3);event(live(4),'click',{ctrlKey:true});assert.deepEqual(selected(),[3,4]);
 window.dispatchEvent(new window.Event('blur'));assert.deepEqual(selected(),[]);
 await context(4);event(menuItem('moveTodayTabsToSpace'),'click');assert.match(document.querySelector('.today-move-hint').textContent,/Move 1 tab/);clear();
});

test('return lifecycle owned late native activation preserves the two-row menu',async()=>{
 if(storedSpaces.length===1){storedSpaces.push({id:'late-target',name:'Late target',color:'green',bookmarkFolderId:'late-root',temporaryTabs:[],spaceBookmarks:[]});folders.push({id:'late-root',parentId:'root',title:'Late target'});await publishSpaces();}
 clear();event(document.querySelector('#spaceSwitcher button[data-space-id="alpha"]'),'click');await wait(300);await refresh();
 event(live(3),'click');event(live(4),'click',{ctrlKey:true});assert.deepEqual(selected(),[3,4]);
 await wait(30);await activate(3);assert.deepEqual(selected(),[3,4]);
 await context(4);event(menuItem('moveTodayTabsToSpace'),'click');assert.match(document.querySelector('.today-move-hint').textContent,/Move 2 tabs/);clear();
});

test('return activation Space switch preserves fresh Ctrl selection when its native event first arrives late',async()=>{
 const savedSpaces=structuredClone(storedSpaces),originalUpdate=chrome.tabs.update;
 const target={id:'activation-target',name:'Activation target',color:'green',bookmarkFolderId:'activation-root',temporaryTabs:[3,4],spaceBookmarks:[]};
 for(const s of storedSpaces)s.temporaryTabs=s.temporaryTabs.filter(id=>![3,4].includes(id));
 storedSpaces.push(target);folders.push({id:'activation-root',parentId:'root',title:'Activation target'});await publishSpaces();await refresh();
 let release,deliver;
 chrome.tabs.update=async(id,props)=>{
  const result=await originalUpdate.call(chrome.tabs,id,props);
  if(props.active&&[3,4].includes(id))await new Promise(resolve=>{release=resolve;deliver=()=>activate(id);});
  return result;
 };
 try{
  clear();event(document.querySelector('#spaceSwitcher button[data-space-id="activation-target"]'),'click');
  for(let i=0;i<50&&!deliver;i++)await wait(5);assert(deliver,'Native activation request must be pending');
  assert(live(3)&&live(4));event(live(3),'click',{ctrlKey:true});event(live(4),'click',{ctrlKey:true});assert.deepEqual(selected(),[3,4]);
  await deliver();release();await wait(30);assert.deepEqual(selected(),[3,4]);
  await context(4);event(menuItem('moveTodayTabsToSpace'),'click');assert.match(document.querySelector('.today-move-hint').textContent,/Move 2 tabs/);clear();
  event(live(3),'click',{ctrlKey:true});event(live(4),'click',{ctrlKey:true});await activate(5);assert.deepEqual(selected(),[],'Unrelated native activation still clears selection');
 }finally{
  release?.();chrome.tabs.update=originalUpdate;storedSpaces=savedSpaces;folders.splice(folders.findIndex(f=>f.id==='activation-root'),1);await publishSpaces();await refresh();clear();
 }
});

test('return activation held read from Space A cannot activate after switching to B',async()=>{
 const savedSpaces=structuredClone(storedSpaces),added=[];let release,held=false;
 for(const [id,tabId] of [['race-a',3],['race-b',4]]){
  for(const s of storedSpaces)s.temporaryTabs=s.temporaryTabs.filter(x=>x!==tabId);
  storedSpaces.push({id,name:id,color:'green',bookmarkFolderId:id+'-root',temporaryTabs:[tabId],spaceBookmarks:[]});folders.push({id:id+'-root',parentId:'root',title:id});added.push(id+'-root');
 }
 await publishSpaces();await refresh();const start=mutations.length;
 beforeGetTab=async id=>{if(id===3&&!held){held=true;await new Promise(r=>{release=r;});}};
 try{
  event(document.querySelector('#spaceSwitcher button[data-space-id="race-a"]'),'click');
  for(let i=0;i<80&&!held;i++)await wait(5);assert(held);
  event(document.querySelector('#spaceSwitcher button[data-space-id="race-b"]'),'click');
  for(let i=0;i<80&&!mutations.slice(start).some(m=>m[0]==='tab-update'&&m[1]===4&&m[2].active);i++)await wait(5);
  assert(mutations.slice(start).some(m=>m[0]==='tab-update'&&m[1]===4&&m[2].active));
  release();await wait(100);assert(!mutations.slice(start).some(m=>m[0]==='tab-update'&&m[1]===3&&m[2].active));
  assert.equal(document.querySelector('.space.active').dataset.spaceId,'race-b');
 }finally{release?.();beforeGetTab=null;storedSpaces=savedSpaces;for(const id of added)folders.splice(folders.findIndex(f=>f.id===id),1);await publishSpaces();await refresh();clear();}
});
