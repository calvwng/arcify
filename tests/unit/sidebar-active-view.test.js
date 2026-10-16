import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseHTML } from 'linkedom';
import { applySpacePatch } from '../../space-store.js';

// Import and initialize the real sidebar and all its modules against a DOM.
// Only browser facilities and persisted fixtures are substituted; no source
// extraction or replacement implementation of the event/render paths is used.
const { window } = parseHTML(await readFile(new URL('../../sidebar.html', import.meta.url), 'utf8'));
const { document } = window;
window.HTMLElement.prototype.getBoundingClientRect = () => ({ top: 0, bottom: 20, left: 0, right: 100, width: 100, height: 20 });
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
const tabs = [
    { id: 1, windowId: 10, active: true, pinned: false, title: 'Alpha tab', url: 'https://alpha.test/' },
    { id: 2, windowId: 10, active: false, pinned: false, title: 'Beta tab', url: 'https://beta.test/' }
];
let storedSpaces = [
    { id: 'alpha', name: 'Alpha', color: 'blue', bookmarkFolderId: 'folder-alpha', spaceBookmarks: [], temporaryTabs: [1], lastTab: 1 },
    { id: 'beta', name: 'Beta', color: 'red', bookmarkFolderId: 'folder-beta', spaceBookmarks: [], temporaryTabs: [2], lastTab: 2 },
    { id: 'empty', name: 'Empty', color: 'green', bookmarkFolderId: 'folder-empty', spaceBookmarks: [], temporaryTabs: [] }
];
const local = { tabGroupImportDismissed: true, spaces: storedSpaces };
const session = { activeSpaces: { 10: 'alpha' } };
const area = state => ({ async get(keys) {
    if (typeof keys === 'string') return { [keys]: structuredClone(state[keys]) };
    return structuredClone({ ...(Array.isArray(keys) ? {} : keys), ...state });
}, async set(next) { Object.assign(state, structuredClone(next)); }, async remove() {} });
const onActivated = listeners();
let beforeRead;
const newTabRequests = [];
let beforeNewTab;
let beforeWindow;
let currentWindowId = 10;
let beforeTree;
const folders = [{ id: 'root', title: 'Arcify' }, ...storedSpaces.map(space => ({ id: space.bookmarkFolderId, parentId: 'root', title: space.name }))];
globalThis.window = window;
globalThis.document = document;
globalThis.Event = window.Event;
globalThis.localStorage = { getItem() { return null; }, setItem() {} };
globalThis.getComputedStyle = () => ({ getPropertyValue() { return ''; } });
globalThis.matchMedia = () => ({ matches: true, addEventListener() {} });
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.MutationObserver = window.MutationObserver;
globalThis.chrome = {
    runtime: { onMessage: listeners(), getURL: path => `chrome-extension://fixture/${path}`, getManifest: () => ({ version: 'test' }),
        async sendMessage(message) {
            if (message.type === 'spotlightBridgeLaunch') { newTabRequests.push(structuredClone(message)); return beforeNewTab?.(message) || { ok: true, outcome: 'spotlight' }; }
            if (message.type === 'favoriteStore') return { success: true, favorites: [], nativeTabs: tabs.filter(tab => tab.pinned) };
            if (message.type === 'sidebarTour') return { success: true, state: null };
            assert.equal(message.type, 'spaceStore');
            if (message.action === 'get') { const result = structuredClone(storedSpaces); await beforeRead?.(); return { success: true, spaces: result }; }
            if (message.action === 'patch') storedSpaces = applySpacePatch(storedSpaces, message.before, message.after);
            if (message.action === 'activate') session.activeSpaces[message.windowId] = message.spaceId;
            return { success: true, spaces: structuredClone(storedSpaces) };
        } },
    storage: { onChanged, local: area(local), sync: area({}), session: area(session) },
    windows: { getCurrent(_options, callback) { if (callback) { if (beforeWindow) beforeWindow(callback); else callback({ id: currentWindowId }); } return Promise.resolve({ id: currentWindowId }); } },
    tabs: { onActivated, ...Object.fromEntries(['onCreated', 'onUpdated', 'onRemoved', 'onAttached', 'onDetached', 'onMoved'].map(name => [name, listeners()])),
        async query(query) { return structuredClone(tabs.filter(tab => (!query.windowId || tab.windowId === query.windowId) && (!query.active || tab.active) && (query.pinned === undefined || query.pinned === tab.pinned))); },
        async get(id) { return structuredClone(tabs.find(tab => tab.id === id)); } },
    bookmarks: { async get(id) { return structuredClone(folders.filter(folder => folder.id === id)); },
        async search({ title }) { return structuredClone(folders.filter(folder => folder.title === title)); },
        async getChildren(id) { await beforeTree?.(id); return []; } },
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
const visible = () => [...document.querySelectorAll('#spacesList > .space')].filter(space => space.style.display !== 'none').map(space => space.dataset.spaceId);
const selected = () => [...document.querySelectorAll('#spaceSwitcher > button.active')].map(button => button.dataset.spaceId);
async function settled(spaceId) {
    for (let attempt = 0; attempt < 30; attempt++) {
        if (JSON.stringify(visible()) === JSON.stringify([spaceId]) && JSON.stringify(selected()) === JSON.stringify([spaceId])) return;
        await wait(20);
    }
    assert.deepEqual(visible(), [spaceId]);
    assert.deepEqual(selected(), [spaceId]);
}
async function selectSession(spaceId) {
    session.activeSpaces[10] = spaceId;
    await onChanged.emit({ activeSpaces: { newValue: structuredClone(session.activeSpaces) } }, 'session');
}
async function selectTab(id) {
    for (const tab of tabs) tab.active = tab.id === id;
    await onActivated.emit({ windowId: 10, tabId: id });
}

test('real sidebar renders session-only selection of an empty space', async () => {
    await settled('alpha');
    await selectSession('empty');
    await settled('empty');
    assert.equal(document.querySelector('[data-space-id="empty"].space').querySelectorAll('.tab').length, 0);
});

for (const sessionFirst of [true, false]) test(`real sidebar renders nonempty selection with ${sessionFirst ? 'session' : 'tab'} event first`, async () => {
    const id = sessionFirst ? 'beta' : 'alpha';
    const tabId = sessionFirst ? 2 : 1;
    if (sessionFirst) { await selectSession(id); await selectTab(tabId); }
    else { await selectTab(tabId); await selectSession(id); }
    await settled(id);
    const row = document.querySelector(`.space[data-space-id="${id}"] .tab[data-tab-id="${tabId}"]`);
    assert(row, 'The selected space must contain its actual rendered live-tab row');
    assert.equal(row.classList.contains('active'), true);
});

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}
function drag(row, type) {
    const event = new window.Event(type);
    event.dataTransfer = { setData() {} };
    row.dispatchEvent(event);
}

test('an active-view change during a delayed metadata read survives an already-fired wake', async () => {
    const started = deferred(), release = deferred();
    beforeRead = async () => { beforeRead = null; started.resolve(); await release.promise; };
    await selectSession('beta');
    await started.promise;
    await selectSession('empty');
    await wait(130); // Consume the newer scheduled wake while the drain is running.
    release.resolve();
    await settled('empty');
});

test('a newer active-view selection during rendering cannot commit the stale target', async () => {
    const original = document.querySelector('.space[data-space-id="beta"] .tab');
    const started = deferred(), release = deferred();
    beforeTree = async id => {
        if (id !== 'folder-beta') return;
        beforeTree = null; started.resolve(); await release.promise;
    };
    await selectSession('beta');
    await started.promise;
    await selectSession('alpha');
    await wait(130);
    release.resolve();
    await settled('alpha');
    assert.equal(document.querySelector('.space[data-space-id="beta"] .tab'), original, 'Stale asynchronous render must not replace rows');
});

for (const kind of ['editor', 'drag']) test(`active-view work stays pending until a busy ${kind} ends`, async () => {
    const space = document.querySelector('.space[data-space-id="alpha"]');
    const row = space.querySelector('.tab');
    const input = space.querySelector('.space-name');
    if (kind === 'editor') input.dispatchEvent(new window.Event('focus'));
    else drag(row, 'dragstart');
    await selectSession('beta');
    await selectTab(2);
    await wait(160);
    assert.deepEqual(visible(), ['alpha']);
    assert.deepEqual(selected(), ['alpha']);
    assert.equal(space.querySelector('.tab'), row, 'Busy interactions must retain their live DOM nodes');
    if (kind === 'editor') input.dispatchEvent(new window.Event('blur'));
    else drag(row, 'dragend');
    await settled('beta');
    await selectSession('alpha');
    await selectTab(1);
    await settled('alpha');
});

for (const kind of ['editor', 'drag']) test(`a busy ${kind} beginning during render defers the DOM switch until idle`, async () => {
    const original = document.querySelector('.space[data-space-id="beta"] .tab');
    const active = document.querySelector('.space[data-space-id="alpha"]');
    const input = active.querySelector('.space-name');
    const row = active.querySelector('.tab');
    const started = deferred(), release = deferred();
    beforeTree = async id => {
        if (id !== 'folder-beta') return;
        beforeTree = null; started.resolve(); await release.promise;
    };
    await selectSession('beta');
    await started.promise;
    if (kind === 'editor') input.dispatchEvent(new window.Event('focus'));
    else drag(row, 'dragstart');
    release.resolve();
    await wait(130);
    assert.deepEqual(visible(), ['alpha']);
    assert.equal(document.querySelector('.space[data-space-id="beta"] .tab'), original);
    if (kind === 'editor') input.dispatchEvent(new window.Event('blur'));
    else drag(row, 'dragend');
    await settled('beta');
    await selectSession('alpha');
    await settled('alpha');
});

test('session changes from another window do not change the rendered sidebar', async () => {
    await onChanged.emit({ activeSpaces: { newValue: { 10: 'alpha', 20: 'empty' } } }, 'session');
    await wait(130);
    assert.deepEqual(visible(), ['alpha']);
    assert.deepEqual(selected(), ['alpha']);
});

for (const kind of ['editor', 'drag']) test(`a busy ${kind} beginning during a metadata read defers adoption and switching`, async () => {
    const active = document.querySelector('.space[data-space-id="alpha"]');
    const input = active.querySelector('.space-name');
    const row = active.querySelector('.tab');
    const started = deferred(), release = deferred();
    beforeRead = async () => { beforeRead = null; started.resolve(); await release.promise; };
    await selectSession('beta');
    await started.promise;
    if (kind === 'editor') input.dispatchEvent(new window.Event('focus'));
    else drag(row, 'dragstart');
    release.resolve();
    await wait(130);
    assert.deepEqual(visible(), ['alpha']);
    assert.deepEqual(selected(), ['alpha']);
    assert.equal(active.querySelector('.tab'), row);
    if (kind === 'editor') input.dispatchEvent(new window.Event('blur'));
    else drag(row, 'dragend');
    await settled('beta');
    await selectSession('alpha');
    await settled('alpha');
});

function addStoredSpace(id, tabId) {
    const space = { id, name: id, color: 'purple', bookmarkFolderId: `folder-${id}`,
        spaceBookmarks: [], temporaryTabs: tabId ? [tabId] : [] };
    storedSpaces.push(space);
    folders.push({ id: space.bookmarkFolderId, parentId: 'root', title: space.name });
    if (tabId) tabs.push({ id: tabId, windowId: 10, active: false, pinned: false, title: `Tab ${tabId}`, url: `https://tab-${tabId}.test/` });
    return space;
}
async function publishSpaces() {
    await onChanged.emit({ spaces: { newValue: structuredClone(storedSpaces) } }, 'local');
}

for (const sessionFirst of [true, false]) for (const empty of [true, false]) {
    test(`new ${empty ? 'empty' : 'nonempty'} space is selected with ${sessionFirst ? 'session' : 'metadata'} event first`, async () => {
        await selectSession('alpha');
        await settled('alpha');
        const id = `new-${sessionFirst}-${empty}`;
        const tabId = empty ? null : sessionFirst ? 3 : 4;
        addStoredSpace(id, tabId);
        if (sessionFirst) { await selectSession(id); await publishSpaces(); }
        else { await publishSpaces(); await selectSession(id); }
        if (tabId) await selectTab(tabId);
        await settled(id);
        const rows = document.querySelector(`.space[data-space-id="${id}"]`).querySelectorAll('.tab');
        assert.equal(rows.length, empty ? 0 : 1);
        if (tabId) assert.equal(rows[0].dataset.tabId, String(tabId));
    });
}

test('an unknown selection survives a completed old metadata read until its space arrives', async () => {
    await selectSession('alpha');
    await settled('alpha');
    const started = deferred(), release = deferred();
    beforeRead = async () => { beforeRead = null; started.resolve(); await release.promise; };
    await selectSession('later-empty');
    await started.promise;
    release.resolve();
    await wait(150);
    assert.deepEqual(visible(), ['alpha'], 'Missing metadata must retain the last visible view');
    addStoredSpace('later-empty');
    await publishSpaces();
    await settled('later-empty');
});

for (const next of ['alpha', 'beta']) test(`a newer ${next} selection supersedes an unresolved space before metadata arrives`, async () => {
    await selectSession('alpha');
    await settled('alpha');
    const pendingId = `superseded-by-${next}`;
    await selectSession(pendingId);
    await selectSession(next);
    addStoredSpace(pendingId);
    await publishSpaces();
    await settled(next);
    await wait(150);
    assert.deepEqual(visible(), [next]);
    assert.deepEqual(selected(), [next]);
});

test('a stale metadata read cannot erase a new-space selection made while it was pending', async () => {
    await selectSession('alpha');
    await settled('alpha');
    const started = deferred(), release = deferred();
    beforeRead = async () => { beforeRead = null; started.resolve(); await release.promise; };
    await publishSpaces();
    await started.promise;
    addStoredSpace('new-during-read');
    await publishSpaces();
    await selectSession('new-during-read');
    await wait(130);
    release.resolve();
    await settled('new-during-read');
});

test('stale tab ownership cannot supersede a pending newly discovered space', async () => {
    await selectSession('beta');
    await settled('beta');
    const space = addStoredSpace('moved-tab-new-space');
    storedSpaces.find(space => space.id === 'alpha').temporaryTabs = [];
    space.temporaryTabs = [1];
    await selectSession(space.id);
    await selectTab(1); // The sidebar still thinks tab 1 belongs to Alpha.
    await publishSpaces();
    await settled(space.id);
    assert(document.querySelector(`.space[data-space-id="${space.id}"] .tab[data-tab-id="1"].active`));
});

test('only the latest unresolved selection is applied as new metadata arrives', async () => {
    await selectSession('alpha');
    await settled('alpha');
    await selectSession('older-pending');
    await selectSession('latest-pending');
    addStoredSpace('older-pending');
    await publishSpaces();
    await wait(160);
    assert.deepEqual(visible(), ['alpha']);
    addStoredSpace('latest-pending');
    await publishSpaces();
    await settled('latest-pending');
});

test('a newly discovered empty-space selection waits for editing and ignores another window selection', async () => {
    await selectSession('alpha');
    await settled('alpha');
    const input = document.querySelector('.space[data-space-id="alpha"] .space-name');
    input.dispatchEvent(new window.Event('focus'));
    addStoredSpace('new-while-editing');
    await selectSession('new-while-editing');
    await onChanged.emit({ activeSpaces: { newValue: { 10: 'new-while-editing', 20: 'beta' } } }, 'session');
    await publishSpaces();
    await wait(160);
    assert.deepEqual(visible(), ['alpha']);
    assert.deepEqual(selected(), ['alpha']);
    input.dispatchEvent(new window.Event('blur'));
    await settled('new-while-editing');
});

test('real sidebar excludes startup launcher from native pinned favicons', async () => {
    const launcher = { id: 800, windowId: 10, pinned: true, active: false,
        url: chrome.runtime.getURL('startup-launcher.html'), title: 'Open Arcify sidebar' };
    tabs.push(launcher);
    await chrome.tabs.onCreated.emit(launcher);
    await wait(200);
    assert.equal(document.querySelector('#pinnedFavicons [data-tab-id="800"]'), null);
    assert.equal(document.querySelector('#spacesList [data-tab-id="800"]'), null);
    tabs.splice(tabs.indexOf(launcher), 1);
});


async function resetActivationOwners() {
    beforeWindow = null; beforeRead = null; currentWindowId = 10;
    for (const space of storedSpaces) {
        space.spaceBookmarks = space.spaceBookmarks.filter(id => id !== 1);
        space.temporaryTabs = space.temporaryTabs.filter(id => id !== 1);
    }
    storedSpaces.find(space => space.id === 'alpha').temporaryTabs.push(1);
    await publishSpaces(); await selectSession('alpha'); await selectTab(1); await settled('alpha'); await wait(180);
}

test('an older activation cannot switch Space or highlight after a newer authoritative read completes', async () => {
    await resetActivationOwners();
    const started = deferred(), release = deferred();
    beforeRead = async () => { beforeRead = null; started.resolve(); await release.promise; };
    await selectTab(1); await started.promise;
    await selectTab(2); await settled('beta');
    const latest = document.querySelector('.space[data-space-id="beta"] .tab[data-tab-id="2"]');
    assert(latest.classList.contains('active'));
    release.resolve(); await wait(240);
    assert.deepEqual(visible(), ['beta']); assert.deepEqual(selected(), ['beta']);
    assert(latest.classList.contains('active'), 'the older read must not replace the latest highlight');
    await selectSession('alpha'); await selectTab(1); await settled('alpha');
});

test('an older window callback cannot reset the latest activation before its authoritative read', async () => {
    await resetActivationOwners();
    let oldCallback;
    beforeWindow = callback => { beforeWindow = null; oldCallback = callback; };
    await selectTab(1); assert.equal(typeof oldCallback, 'function');
    await selectTab(2); await settled('beta');
    await oldCallback({ id: 10 }); await wait(240);
    assert.deepEqual(visible(), ['beta']);
    assert(document.querySelector('.space[data-space-id="beta"] .tab[data-tab-id="2"]').classList.contains('active'));
    await selectSession('alpha'); await selectTab(1); await settled('alpha');
});

test('another window activation does not discard a still-current local authoritative read', async () => {
    await resetActivationOwners();
    const started = deferred(), release = deferred();
    beforeRead = async () => { beforeRead = null; started.resolve(); await release.promise; };
    await selectTab(2); await started.promise;
    await onActivated.emit({ windowId: 99, tabId: 999 });
    release.resolve(); await settled('beta');
    assert(document.querySelector('.space[data-space-id="beta"] .tab[data-tab-id="2"]').classList.contains('active'));
    await selectSession('alpha'); await selectTab(1); await settled('alpha');
});

test('a panel window change during the authoritative read prevents stale activation side effects', async () => {
    await resetActivationOwners();
    const started = deferred(), release = deferred();
    beforeRead = async () => { beforeRead = null; started.resolve(); await release.promise; };
    await selectTab(2); await started.promise; currentWindowId = 99;
    release.resolve(); await wait(240);
    assert.deepEqual(visible(), ['alpha']); assert.deepEqual(selected(), ['alpha']);
    currentWindowId = 10; await selectTab(1); await settled('alpha');
});

test('a delayed callback from a previous panel window cannot cancel a newer local activation', async () => {
    await resetActivationOwners();
    let previousWindowCallback;
    currentWindowId = 99;
    beforeWindow = callback => { beforeWindow = null; previousWindowCallback = callback; };
    await onActivated.emit({ windowId: 99, tabId: 999 });
    assert.equal(typeof previousWindowCallback, 'function');
    currentWindowId = 10;
    const started = deferred(), release = deferred();
    beforeRead = async () => { beforeRead = null; started.resolve(); await release.promise; };
    await selectTab(2); await started.promise;
    await previousWindowCallback({ id: 99 });
    release.resolve(); await settled('beta');
    assert(document.querySelector('.space[data-space-id="beta"] .tab[data-tab-id="2"]').classList.contains('active'));
});

const newTabButton = document.getElementById('newTabBtn');
function assertNewTabRow(spaceId) {
    const space = document.querySelector(`.space[data-space-id="${spaceId}"]`);
    assert.equal(document.querySelectorAll('#newTabBtn').length, 1);
    assert.equal(space.querySelector('.temp-header').nextElementSibling, newTabButton);
    assert.equal(newTabButton.nextElementSibling, space.querySelector('[data-tab-type="temporary"]'));
    assert.equal(newTabButton.closest('.tabs-container'), null);
    assert.equal(document.getElementById('spotlightBtn'), null);
    assert.equal(document.querySelector('.new-tab-btn-container button'), null);
    assert.equal(newTabButton.hidden, false);
}

test('actual sidebar moves one New Tab identity across empty/nonempty Spaces and metadata replacement', async () => {
    for (const id of ['empty', 'alpha', 'beta']) { await selectSession(id); await settled(id); assertNewTabRow(id); }
    const before = newTabButton.closest('.space');
    storedSpaces.find(space => space.id === 'beta').color = 'green'; await publishSpaces(); await wait(240);
    assertNewTabRow('beta'); assert.notEqual(newTabButton.closest('.space'), before);
    for (const id of ['bookmarkSelectionStatus', 'todaySelectionStatus', 'spotlightStatus', 'urlCopyToast']) {
        assert(document.querySelector('.new-tab-btn-container').contains(document.getElementById(id)), `${id} retains its stable notice host`);
    }
    assert(document.getElementById('arcify-tour').nextElementSibling.matches('.new-tab-btn-container'));
});

test('actual sidebar New Tab retains one in-flight gesture across external Space refresh and deletion', async () => {
    await selectSession('alpha'); await settled('alpha'); const gate = deferred(); beforeNewTab = () => gate.promise;
    const before = newTabRequests.length; newTabButton.click(); await wait(0);
    assert.equal(newTabButton.getAttribute('aria-busy'), 'true');
    await selectSession('empty'); await settled('empty'); assertNewTabRow('empty'); newTabButton.click();
    storedSpaces = storedSpaces.filter(space => space.id !== 'empty'); await publishSpaces(); await wait(240);
    assertNewTabRow(visible()[0]); newTabButton.click();
    assert.equal(newTabRequests.length, before + 1);
    assert.deepEqual(newTabRequests.at(-1), { type: 'spotlightBridgeLaunch', windowId: 10, spaceId: 'alpha', fallbackToNewTab: true });
    gate.resolve({ ok: true, outcome: 'spotlight' }); await wait(0); beforeNewTab = null;
    assert.equal(newTabButton.getAttribute('aria-busy'), 'false');
});

test('actual sidebar keeps New Tab fixed above Today independently of either ordering setting', async () => {
    await selectSession('alpha'); await settled('alpha');
    const alpha = storedSpaces.find(space => space.id === 'alpha'), beta = storedSpaces.find(space => space.id === 'beta');
    const beforeAlpha = [...alpha.temporaryTabs], beforeBeta = [...beta.temporaryTabs], beforeRepresentation = local.todayOrderRepresentation;
    beta.temporaryTabs = beta.temporaryTabs.filter(id => id !== 2); alpha.temporaryTabs = [1, 2];
    const get = chrome.storage.sync.get;
    try {
        for (const todayInverted of [false, true]) {
            local.todayOrderRepresentation = { version: 1, inverted: todayInverted };
            await publishSpaces(); await wait(240);
            for (const savedInverted of [false, true]) {
                chrome.storage.sync.get = async () => ({ invertTabOrder: savedInverted, todayNewTabsAtTop: !savedInverted });
                await onChanged.emit({ invertTabOrder: { newValue: savedInverted }, todayNewTabsAtTop: { newValue: !savedInverted } }, 'sync'); await wait(300);
                assertNewTabRow('alpha');
                assert.deepEqual([...newTabButton.nextElementSibling.querySelectorAll('.tab')].map(row => Number(row.dataset.tabId)), todayInverted ? [2, 1] : [1, 2]);
                assert.deepEqual(alpha.temporaryTabs, [1, 2]);
            }
        }
    } finally {
        chrome.storage.sync.get = get; alpha.temporaryTabs = beforeAlpha; beta.temporaryTabs = beforeBeta; local.todayOrderRepresentation = beforeRepresentation;
        await publishSpaces(); await onChanged.emit({ invertTabOrder: { newValue: false } }, 'sync'); await wait(300);
    }
});

test('actual sidebar restores focused New Tab only after destination visibility and synchronous metadata replacement', async () => {
    await selectSession('alpha'); await settled('alpha');
    let focused = document.body, hasFocus = true;
    const activeDescriptor = Object.getOwnPropertyDescriptor(document, 'activeElement'), hasFocusOriginal = document.hasFocus;
    Object.defineProperty(document, 'activeElement', { configurable: true, get: () => focused }); document.hasFocus = () => hasFocus;
    const ownFocus = newTabButton.focus;
    newTabButton.focus = function () {
        if (!this.isConnected) return;
        for (let node = this; node; node = node.parentElement) if (node.hidden || node.style?.display === 'none') return;
        focused = this;
    };
    try {
        newTabButton.focus(); await selectSession('beta'); await settled('beta');
        assertNewTabRow('beta'); assert.equal(document.activeElement, newTabButton);
        const space = newTabButton.closest('.space'), remove = space.remove;
        space.remove = function () { if (this.contains(focused)) focused = document.body; return remove.call(this); };
        storedSpaces.find(space => space.id === 'beta').color = 'purple'; await publishSpaces(); await wait(240);
        assertNewTabRow('beta'); assert.equal(document.activeElement, newTabButton);
        hasFocus = false; focused = document.body;
        storedSpaces.find(space => space.id === 'beta').color = 'blue'; await publishSpaces(); await wait(240);
        assert.equal(document.activeElement, document.body);
    } finally {
        newTabButton.focus = ownFocus; document.hasFocus = hasFocusOriginal;
        if (activeDescriptor) Object.defineProperty(document, 'activeElement', activeDescriptor); else delete document.activeElement;
    }
});

test('a deferred old-view New Tab click cannot target the hidden logical Space or disturb an editor draft', async () => {
    await selectSession('alpha'); await settled('alpha');
    const input = document.querySelector('.space[data-space-id="alpha"] .space-name');
    input.value = 'Unsubmitted Space draft'; input.dispatchEvent(new window.Event('focus'));
    const before = newTabRequests.length;
    try {
        await selectSession('beta'); await wait(160);
        assert.deepEqual(visible(), ['alpha']); assertNewTabRow('alpha');
        newTabButton.click(); await wait(0);
        assert.equal(newTabRequests.length, before); assert.equal(input.value, 'Unsubmitted Space draft');
        assert.match(document.getElementById('spotlightStatus').textContent, /finish loading/);
    } finally { input.dispatchEvent(new window.Event('blur')); }
    await settled('beta'); assertNewTabRow('beta');
});
