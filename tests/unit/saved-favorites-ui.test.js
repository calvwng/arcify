import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createSavedFavoritesUI, favoriteRequest, savedDropBeforeId } from '../../saved-favorites-ui.js';
import { createFavoritesDragSource, createSavedBookmarkFavoriteDrop } from '../../favorites-drop.js';
import { pngIcon } from '../fixtures/favorite-icons.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 5));
function fixture() {
    const { document, window } = parseHTML('<body><div id="pinnedFavicons"><div class="pinned-placeholder-container"></div></div><div id="spacesList"></div></body>');
    const container = document.getElementById('pinnedFavicons');
    const favorites = [{ id: 'one', title: 'Saved One', url: 'https://one.test/', sourceBookmarkId: 'b1', tabId: 10 },
        { id: 'two', title: 'Saved Two', url: 'https://two.test/', sourceBookmarkId: 'b2', tabId: null }];
    const nativeTabs = [{ id: 20, title: 'Native', url: 'https://native.test/', pinned: true, windowId: 1, index: 1 }];
    const tabs = [{ id: 10, title: 'Navigated', url: 'https://one.test/deep', pinned: true, active: true, windowId: 1 }, ...nativeTabs];
    let windowId = 1, beforeGet, attachmentReply;
    const calls = [], statuses = [];
    const api = {
        runtime: { getURL: path => `chrome-extension://fixture/${path}`, async sendMessage(message) {
            calls.push(structuredClone(message));
            if (['attachmentCandidates', 'attachExisting'].includes(message.action) && attachmentReply) return attachmentReply(message);
            if (message.action === 'get') { const result = structuredClone({ success: true, favorites, nativeTabs }); await beforeGet?.(); return result; }
            if (message.action === 'closeTab') {
                const favorite = favorites.find(item => item.id === message.favoriteId && item.tabId === message.tabId);
                const tab = tabs.find(tab => tab.id === message.tabId);
                if (!favorite || !tab || tab.windowId !== message.windowId) return { success: false, code: 'STALE_TAB', error: 'This Favorite’s open tab changed.' };
                await api.tabs.remove(message.tabId);
            }
            return { success: true, favorites, nativeTabs };
        } },
        tabs: { async query() { return tabs.filter(tab => tab.windowId === windowId && tab.active); },
            async get(id) { return structuredClone(tabs.find(tab => tab.id === id)); },
            async update(id, patch) { calls.push({ update: id, patch }); Object.assign(tabs.find(tab => tab.id === id), patch); },
            async remove(id) { calls.push({ close: id }); tabs.splice(tabs.findIndex(tab => tab.id === id), 1); favorites.find(f => f.tabId === id).tabId = null; } }
    };
    globalThis.chrome = api;
    const context = { spaces: [], activeSpaceId: null, windowId };
    const drag = createFavoritesDragSource({ document, getContext: () => context });
    const ui = createSavedFavoritesUI({ document, container, getWindowId: () => windowId, api, onStatus: message => statuses.push(message), onDragStart: node => drag.start(node) });
    const event = (node, type, properties = {}) => { const event = new window.Event(type, { bubbles: true, cancelable: true }); Object.assign(event, properties); node.dispatchEvent(event); return event; };
    const row = id => [...container.querySelectorAll('.saved-favorite')].find(node => node.dataset.favoriteId === id);
    const menu = (node, text) => { event(node, 'contextmenu'); const item = [...document.querySelectorAll('[role="menuitem"]')].find(node => node.textContent === text); assert(item, text); event(item, 'click'); };
    return { document, window, container, favorites, nativeTabs, tabs, calls, statuses, ui, row, event, menu, drag, context,
        setWindow(id) { windowId = id; context.windowId = id; }, setBeforeGet(value) { beforeGet = value; }, setAttachmentReply(value) { attachmentReply = value; } };
}

test('real renderer keeps stable saved IDs, visible closed state and native distinction without migration hint', async () => {
    const f = fixture(); await f.ui.refresh();
    assert.deepEqual([...f.container.querySelectorAll('.pinned-favicon')].map(node => node.dataset.favoriteId || node.dataset.tabId), ['one', 'two', '20']);
    assert(f.row('one').classList.contains('active')); assert.equal(f.row('two').dataset.tabId, undefined);
    assert.equal(f.row('two').querySelector('.favorite-state').textContent, 'Closed');
    assert.match(f.row('two').getAttribute('aria-label'), /Closed.*click to open/);
    assert.equal(Boolean(f.document.getElementById('nativeFavoritesNotice')), false);
    assert.equal(Boolean(f.document.querySelector('.native-favorites-notice')), false);
    assert.match(f.container.querySelector('.native-favorite').getAttribute('aria-label'), /Browser pin · not saved/);
    assert(!f.document.body.textContent.includes('Browser pins are kept as they are.'));
    assert(f.calls.every(message => message.action === 'get'), 'render must never adopt, pin, open or close tabs');
});

test('retained Favorite data is preferred and remains identical across close and new renderer', async () => {
    const f = fixture(), icon = pngIcon(); f.favorites[0].faviconDataUrl = icon;
    await f.ui.refresh(); const img = f.row('one').querySelector('img'); assert.equal(img.src, icon);
    f.favorites[0].tabId = null; await f.ui.refresh(); assert.equal(f.row('one').querySelector('img'), img); assert.equal(img.src, icon);
    f.ui.dispose();
    const next = createSavedFavoritesUI({ document: f.document, container: f.container, getWindowId: () => 1 });
    await next.refresh(); assert.equal(f.row('one').querySelector('img').src, icon);
});

test('invalid icon fields use browser-local fallback, and failed sources do not retry on every refresh', async () => {
    const f = fixture(); f.favorites[0].faviconDataUrl = 'https://tracker.test/icon.png';
    await f.ui.refresh(); const img = f.row('one').querySelector('img');
    assert.match(img.src, /^chrome-extension:/); assert(!img.src.includes('tracker.test'));
    img.onerror(); assert.equal(img.src, 'assets/default_icon.png'); assert.equal(img.onerror, null);
    await f.ui.refresh(); assert.equal(img.src, 'assets/default_icon.png');
});

test('image failure falls back locally; late errors from an older icon cannot replace newer data', async () => {
    const f = fixture(), first = pngIcon(), second = pngIcon({ red: 200 }); f.favorites[0].faviconDataUrl = first;
    await f.ui.refresh(); const img = f.row('one').querySelector('img'), oldError = img.onerror;
    img.onerror(); assert.match(img.src, /^chrome-extension:/);
    img.onerror(); assert.equal(img.src, 'assets/default_icon.png'); assert.equal(img.onerror, null);
    f.favorites[0].faviconDataUrl = second; await f.ui.refresh(); assert.equal(img.src, second);
    oldError(); assert.equal(img.src, second);
});

test('close changes only live instance; record keeps the same DOM identity and reopens by stable ID', async () => {
    const f = fixture(); await f.ui.refresh(); const original = f.row('one');
    f.menu(original, 'Close Tab (Keep Favorite)'); await tick();
    assert.equal(f.row('one'), original); assert.equal(original.dataset.tabId, undefined);
    assert.equal(original.querySelector('.favorite-state').textContent, 'Closed');
    assert(f.calls.some(call => call.close === 10)); assert(!f.calls.some(call => call.action === 'remove'));
    f.event(original, 'click'); await tick();
    assert.deepEqual(f.calls.find(call => call.action === 'open'), { type: 'favoriteStore', action: 'open', windowId: 1, favoriteId: 'one' });
});

test('saved activation never resets navigation, matches URLs, or directly manipulates native tabs', async () => {
    const f = fixture(); await f.ui.refresh();
    f.event(f.row('one'), 'click'); f.event(f.row('one'), 'click'); await tick();
    assert.equal(f.calls.filter(call => call.action === 'open').length, 1);
    assert.equal(f.tabs[0].url, 'https://one.test/deep'); assert(!f.calls.some(call => call.update));
    f.event(f.row('two'), 'keydown', { key: 'Enter' }); await tick();
    assert.equal(f.calls.filter(call => call.action === 'open').at(-1).favoriteId, 'two');
});

test('explicit Remove Favorite uses sole writer and does not close pages or delete source bookmarks', async () => {
    const f = fixture(); await f.ui.refresh(); f.menu(f.row('one'), 'Remove Favorite'); await tick();
    assert.deepEqual(f.calls.find(call => call.action === 'remove'), { type: 'favoriteStore', action: 'remove', windowId: 1, favoriteId: 'one' });
    assert(!f.calls.some(call => call.close || call.update)); assert.match(f.statuses.at(-1), /pages and source bookmarks were kept/);
});

test('native pins stay unmanaged until explicit adoption, and activation uses only exact current-window tab', async () => {
    const f = fixture(); await f.ui.refresh(); const native = f.container.querySelector('.native-favorite');
    f.event(native, 'click'); await tick(); assert.deepEqual(f.calls.find(call => call.update), { update: 20, patch: { active: true } });
    assert(!f.calls.some(call => call.action === 'addTab'));
    f.menu(native, 'Keep as saved Favorite'); await tick();
    assert.deepEqual(f.calls.find(call => call.action === 'addTab'), { type: 'favoriteStore', action: 'addTab', windowId: 1, tabId: 20 });
});

test('a stale close menu never closes a newly rebound Favorite or foreign-window instance', async () => {
    for (const change of ['binding', 'window']) {
        const f = fixture(); await f.ui.refresh(); f.event(f.row('one'), 'contextmenu');
        if (change === 'binding') f.favorites[0].tabId = 11; else f.tabs[0].windowId = 9;
        const close = [...f.document.querySelectorAll('[role="menuitem"]')].find(node => node.textContent.startsWith('Close Tab'));
        f.event(close, 'click'); await tick(); assert(!f.calls.some(call => call.close)); assert.match(f.statuses.at(-1), /changed/);
    }
});

test('late refresh cannot roll back a newer snapshot or a new window', async () => {
    const f = fixture(); let release;
    const waiting = new Promise(resolve => { release = resolve; });
    f.setBeforeGet(() => waiting); const old = f.ui.refresh();
    f.setBeforeGet(null); f.favorites[0].tabId = null; await f.ui.refresh(); release(); await old;
    assert.equal(f.row('one').dataset.tabId, undefined);
    f.setBeforeGet(() => new Promise(resolve => { release = resolve; })); const foreign = f.ui.refresh(); f.setWindow(2); release(); await foreign;
    assert.equal(f.row('one').dataset.tabId, undefined);
});

test('closed saved icons have own-drag provenance and reorder by saved IDs separately from native pins', async () => {
    const f = fixture(); await f.ui.refresh();
    f.event(f.row('two'), 'dragstart'); assert.equal(f.drag.inspect().source.kind, 'saved');
    assert.equal(f.drag.inspect().source.favoriteId, 'two'); assert.equal(f.drag.inspect().source.tabId, null);
    assert.equal(savedDropBeforeId(f.container, f.row('one'), 'left', 'two'), 'one');
    assert.equal(savedDropBeforeId(f.container, f.container.querySelector('.native-favorite'), 'left', 'two'), null);
    f.row('two').dataset.favoriteId = 'forged'; assert.match(f.drag.inspect().error, /changed/);
});

test('source bookmark client forwards exact provenance only, fails local context changes and preserves worker errors', async () => {
    const f = fixture(); f.context.spaces = [{ id: 's', bookmarkFolderId: 'root' }]; f.context.activeSpaceId = 's';
    const add = createSavedBookmarkFavoriteDrop({ getContext: () => f.context, api: globalThis.chrome });
    const source = { windowId: 1, spaceId: 's', bookmarkFolderId: 'root', bookmarkId: 'b', parentId: 'folder', tabId: 10,
        url: 'https://untrusted-row.test/', element: {} };
    await add(source, 'one');
    assert.deepEqual(f.calls.at(-1), { type: 'favoriteStore', action: 'addBookmark', windowId: 1, spaceId: 's', bookmarkFolderId: 'root', bookmarkId: 'b', parentId: 'folder', tabId: 10, beforeId: 'one' });
    f.context.activeSpaceId = 'other'; await assert.rejects(add(source), /changed/); assert.equal(f.calls.length, 1);
    await assert.rejects(favoriteRequest('get', { windowId: 1 }, { runtime: { sendMessage: async () => ({ success: false, error: 'Tracking unavailable', code: 'UNCERTAIN_CREATE' }) } }), { message: 'Tracking unavailable', code: 'UNCERTAIN_CREATE' });
});


test('saved and native Favorite menus dismiss on external focus loss without activating or stealing focus', async () => {
    const f = fixture(); await f.ui.refresh();
    let focused = f.document.body;
    Object.defineProperty(f.document, 'activeElement', { get: () => focused });
    const oldFocus = f.window.HTMLElement.prototype.focus;
    f.window.HTMLElement.prototype.focus = function () { focused = this; };
    try {
        for (const node of [f.row('one'), f.container.querySelector('.native-favorite')]) {
            for (const exit of ['blur', 'hidden', 'pagehide']) {
                const before = structuredClone(f.calls);
                f.event(node, 'contextmenu'); assert(f.document.getElementById('tab-context-menu'));
                f.document.body.focus();
                if (exit === 'hidden') {
                    Object.defineProperty(f.document, 'visibilityState', { configurable: true, value: 'hidden' });
                    f.event(f.document, 'visibilitychange');
                    delete f.document.visibilityState;
                } else f.event(f.window, exit);
                assert.equal(Boolean(f.document.getElementById('tab-context-menu')), false);
                assert.equal(f.document.activeElement, f.document.body);
                assert.deepEqual(f.calls, before);
                f.event(node, 'keydown', { key: 'ContextMenu' });
                assert(f.document.getElementById('tab-context-menu'));
                f.event(f.document, 'keydown', { key: 'Escape' });
                assert.equal(f.document.activeElement, node);
            }
        }
    } finally { f.ui.dispose(); f.window.HTMLElement.prototype.focus = oldFocus; }
});

test('Move to New Window dispatches exact saved/native identities and is absent for closed Favorites', async () => {
 const f = fixture(); await f.ui.refresh();
 f.menu(f.row('one'), 'Move to New Window'); await tick();
 assert.deepEqual(f.calls.find(m => m.type === 'moveTabToNewWindow'), { type: 'moveTabToNewWindow', windowId: 1, tabId: 10, favoriteId: 'one' });
 f.menu(f.container.querySelector('.native-favorite'), 'Move to New Window'); await tick();
 assert.deepEqual(f.calls.filter(m => m.type === 'moveTabToNewWindow').at(-1), { type: 'moveTabToNewWindow', windowId: 1, tabId: 20 });
 f.event(f.row('two'), 'contextmenu');
 assert(![...f.document.querySelectorAll('[role="menuitem"]')].some(n => n.textContent === 'Move to New Window'));
});

const attachmentCandidates = () => ({ success: true, favorite: { id: 'two', title: 'Saved Two', url: 'https://two.test/' }, candidates: [
    { tabId: 30, position: 1, title: 'Video', url: 'https://two.test/watch?v=current', pinned: false, suggested: true, token: 'ticket-30' },
    { tabId: 31, position: 2, title: 'Video', url: 'https://two.test/watch?v=current', pinned: true, token: 'ticket-31' },
    { tabId: 32, position: 3, title: 'Saved homepage', url: 'https://two.test/', pinned: false, suggested: true, token: 'ticket-32' }
] });
const attachmentButton = (f, text) => [...f.document.querySelectorAll('dialog button')].find(button => button.textContent === text);
const chooseAttachment = (f, index = 0) => {
    const radio = [...f.document.querySelectorAll('dialog input')][index]; radio.checked = true; f.event(radio, 'change');
};

test('attachment picker refreshes candidates, labels duplicate pages, and requires selection plus confirmation', async () => {
    const f = fixture(); f.setAttachmentReply(message => message.action === 'attachmentCandidates' ? attachmentCandidates() : { success: true });
    await f.ui.refresh();
    assert.match(f.row('two').title, /attach an existing tab/);
    f.menu(f.row('two'), 'Attach existing tab…'); await tick();
    assert.deepEqual(f.calls.find(call => call.action === 'attachmentCandidates'), { type: 'favoriteStore', action: 'attachmentCandidates', favoriteId: 'two', windowId: 1 });
    const dialog = f.document.querySelector('dialog'); assert(dialog.hasAttribute('open'));
    assert.equal(dialog.getAttribute('aria-labelledby'), 'favorite-attachment-title');
    const radios = [...dialog.querySelectorAll('input')]; assert.equal(radios.length, 3); assert(radios.every(radio => !radio.checked));
    assert.match(dialog.textContent, /Tab 1 in this window - Ordinary tab/); assert.match(dialog.textContent, /Tab 2 in this window - Browser pin/);
    assert.match(dialog.textContent, /Same site as saved shortcut/);
    const confirm = attachmentButton(f, 'Attach to this Favorite'); assert(confirm.disabled);
    chooseAttachment(f, 1); assert.equal(confirm.disabled, false);
    f.event(confirm, 'click'); f.event(confirm, 'click'); await tick();
    assert.deepEqual(f.calls.filter(call => call.action === 'attachExisting'), [{ type: 'favoriteStore', action: 'attachExisting', favoriteId: 'two', windowId: 1, tabId: 31, token: 'ticket-31' }]);
    assert(!f.calls.some(call => call.action === 'open' || call.close || call.update));
    assert.equal(f.favorites[1].url, 'https://two.test/');
    assert.match(f.statuses.at(-1), /current page and your saved shortcut were kept/);
    assert.equal(f.document.querySelector('dialog'), null);
});

test('attachment cancellation and stale picker/window responses never attach or revive a dismissed dialog', async () => {
    for (const exit of ['cancel', 'Escape', 'pagehide', 'window', 'dispose', 'new-menu']) {
        const f = fixture(); let release;
        f.setAttachmentReply(() => new Promise(resolve => { release = resolve; }));
        await f.ui.refresh(); f.menu(f.row('two'), 'Attach existing tab…');
        if (exit === 'cancel') f.event(attachmentButton(f, 'Cancel'), 'click');
        else if (exit === 'Escape') f.event(f.document, 'keydown', { key: 'Escape' });
        else if (exit === 'pagehide') f.event(f.window, 'pagehide');
        else if (exit === 'window') { f.setWindow(2); await f.ui.refresh(); }
        else if (exit === 'dispose') f.ui.dispose();
        else f.event(f.row('one'), 'contextmenu');
        release(attachmentCandidates()); await tick();
        assert.equal(f.document.querySelector('dialog'), null, exit);
        assert(!f.calls.some(call => call.action === 'attachExisting'), exit);
        f.ui.dispose();
    }
});

test('attachment cancellation after selection leaves pages and Favorite untouched', async () => {
    const f = fixture(); f.setAttachmentReply(() => attachmentCandidates()); await f.ui.refresh();
    f.menu(f.row('two'), 'Attach existing tab…'); await tick(); chooseAttachment(f);
    f.event(attachmentButton(f, 'Cancel'), 'click');
    assert.equal(f.document.querySelector('dialog'), null);
    assert(!f.calls.some(call => call.action === 'attachExisting' || call.action === 'open' || call.close || call.update));
});

test('attachment closes on refreshed Favorite removal or new binding and refuses changed window at confirmation', async () => {
    for (const change of ['remove', 'bind', 'window']) {
        const f = fixture(); f.setAttachmentReply(() => attachmentCandidates()); await f.ui.refresh();
        f.menu(f.row('two'), 'Attach existing tab…'); await tick(); chooseAttachment(f);
        const confirm = attachmentButton(f, 'Attach to this Favorite');
        if (change === 'remove') { f.favorites.splice(1, 1); await f.ui.refresh(); }
        if (change === 'bind') { f.favorites[1].tabId = 30; await f.ui.refresh(); }
        if (change === 'window') f.setWindow(2);
        f.event(confirm, 'click'); await tick();
        assert(!f.calls.some(call => call.action === 'attachExisting'), change);
        assert.equal(f.document.querySelector('dialog'), null, change);
    }
});

test('worker stale-ticket errors close the picker and never retry or open another tab', async () => {
    const f = fixture(); f.setAttachmentReply(message => message.action === 'attachmentCandidates' ? attachmentCandidates()
        : { success: false, code: 'STALE_TAB', error: 'The tab changed. Choose it again.' });
    await f.ui.refresh(); f.menu(f.row('two'), 'Attach existing tab…'); await tick(); chooseAttachment(f);
    f.event(attachmentButton(f, 'Attach to this Favorite'), 'click'); await tick();
    assert.equal(f.document.querySelector('dialog'), null); assert.match(f.statuses.at(-1), /tab changed/);
    assert.equal(f.calls.filter(call => call.action === 'attachExisting').length, 1);
    assert(!f.calls.some(call => call.action === 'open'));
});

test('attachment dialog traps keyboard focus and Escape returns focus to the Favorite', async () => {
    const f = fixture(); let focused = f.document.body;
    Object.defineProperty(f.document, 'activeElement', { get: () => focused });
    const oldFocus = f.window.HTMLElement.prototype.focus;
    f.window.HTMLElement.prototype.focus = function () { focused = this; };
    try {
        f.setAttachmentReply(() => attachmentCandidates()); await f.ui.refresh();
        f.event(f.row('two'), 'keydown', { key: 'ContextMenu' });
        const menuItem = [...f.document.querySelectorAll('[role="menuitem"]')].find(node => node.textContent === 'Attach existing tab…');
        f.event(menuItem, 'click'); await tick();
        const cancel = attachmentButton(f, 'Cancel'); assert.equal(f.document.activeElement, cancel);
        f.event(f.document, 'keydown', { key: 'Tab' }); assert.equal(f.document.activeElement, f.document.querySelector('dialog input'));
        f.event(f.document, 'keydown', { key: 'Tab', shiftKey: true }); assert.equal(f.document.activeElement, cancel);
        f.event(f.document, 'keydown', { key: 'Escape' }); assert.equal(f.document.activeElement, f.row('two'));
    } finally { f.ui.dispose(); f.window.HTMLElement.prototype.focus = oldFocus; }
});

test('attachment text is bounded plain text, and empty results cannot confirm', async () => {
    const f = fixture(); const response = attachmentCandidates();
    response.favorite.title = '<img src=x>\u202e'; response.candidates[0].title = '<script>x</script>' + 'x'.repeat(1000); response.candidates[0].url = 'https://example.test/' + 'x'.repeat(3000);
    f.setAttachmentReply(() => response); await f.ui.refresh(); f.menu(f.row('two'), 'Attach existing tab…'); await tick();
    const dialog = f.document.querySelector('dialog'); assert.equal(dialog.querySelector('img,script'), null);
    assert.equal(dialog.querySelector('strong').textContent.length, 200); assert(!dialog.textContent.includes('\u202e'));
    f.event(attachmentButton(f, 'Cancel'), 'click');
    response.candidates = []; f.menu(f.row('two'), 'Attach existing tab…'); await tick();
    assert(attachmentButton(f, 'Attach to this Favorite').disabled); assert.match(f.document.querySelector('dialog').textContent, /No available tabs/);
    f.ui.dispose();
});

test('attachment completion after leaving the surface never presents status or refreshes another context', async () => {
    for (const outcome of ['success', 'error']) for (const exit of ['pagehide', 'dispose', 'window', 'new-menu']) {
        const f = fixture(); let release;
        f.setAttachmentReply(message => message.action === 'attachmentCandidates' ? attachmentCandidates()
            : new Promise(resolve => { release = resolve; }));
        await f.ui.refresh(); f.menu(f.row('two'), 'Attach existing tab…'); await tick(); chooseAttachment(f);
        f.event(attachmentButton(f, 'Attach to this Favorite'), 'click');
        if (exit === 'pagehide') f.event(f.window, 'pagehide');
        if (exit === 'dispose') f.ui.dispose();
        if (exit === 'window') f.setWindow(2);
        if (exit === 'new-menu') f.event(f.row('one'), 'contextmenu');
        const reads = f.calls.filter(call => call.action === 'get').length;
        release(outcome === 'success' ? { success: true } : { success: false, error: 'Stale tab.' }); await tick();
        assert.equal(f.statuses.length, 0, `${outcome}: ${exit}`);
        assert.equal(f.calls.filter(call => call.action === 'get').length, reads, `${outcome}: ${exit}`);
        assert.equal(f.document.querySelector('dialog'), null);
        f.ui.dispose();
    }
});
