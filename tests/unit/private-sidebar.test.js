import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createPrivateTabs, mountPrivateSidebar } from '../../private-sidebar.js';
import { startSidebar } from '../../sidebar-context.js';
import { readFile } from 'node:fs/promises';

function fixture() {
    const { document } = parseHTML('<html><body data-sidebar-pending><div id="normal">Spaces Favorites</div></body></html>');
    const events = () => ({ listeners: new Set(), addListener(fn) { this.listeners.add(fn); }, removeListener(fn) { this.listeners.delete(fn); }, fire(...args) { for (const fn of this.listeners) fn(...args); } });
    let tabs = [{ id: 1, windowId: 7, incognito: true, title: 'SYNTHETIC PRIVATE', index: 0, active: true }];
    const mutations = [], queries = [], forbiddenAccess = [];
    const chrome = {
        windows: { getCurrent: async () => ({ id: 7, incognito: true }), get: async id => ({ id, incognito: true }), onRemoved: events() },
        tabs: { query: async q => { queries.push(q); return tabs; }, get: async id => { const tab = tabs.find(t => t.id === id); if (!tab) throw Error('synthetic stale'); return tab; },
            update: async (...args) => mutations.push(['update', ...args]), remove: async (...args) => mutations.push(['remove', ...args]), create: async (...args) => mutations.push(['create', ...args]) }
    };
    for (const name of ['onCreated', 'onUpdated', 'onRemoved', 'onMoved', 'onAttached', 'onDetached', 'onActivated']) chrome.tabs[name] = events();
    Object.defineProperty(chrome, 'storage', { get() { forbiddenAccess.push('chrome.storage'); assert.fail('Private UI accessed storage'); } });
    Object.defineProperty(chrome, 'runtime', { get() { forbiddenAccess.push('chrome.runtime'); assert.fail('Private UI accessed normal messaging'); } });
    return { chrome, document, mutations, queries, forbiddenAccess, setTabs(value) { tabs = value; } };
}

test('native private context loads only private module and clears normal UI', async () => {
    const f = fixture();
    await startSidebar({ ...f, loadNormal: () => assert.fail('normal module loaded'), loadPrivate: async () => ({ mountPrivateSidebar }) });
    assert.equal(f.document.getElementById('normal'), null);
    assert.match(f.document.body.textContent, /Private window/);
    assert.match(f.document.body.textContent, /SYNTHETIC PRIVATE/);
    assert.equal(f.document.body.hasAttribute('data-sidebar-pending'), false);
});

test('real HTML entry keeps private UI and clicks within the native owner without persistence or normal initialization', async () => {
    const f = fixture();
    const { document, window } = parseHTML(await readFile(new URL('../../sidebar.html', import.meta.url), 'utf8'));
    const script = document.querySelector('script[type="module"]');
    assert.equal(script.getAttribute('src'), 'sidebar-entry.js');
    const previous = { chrome: globalThis.chrome, document: globalThis.document };
    const forbidden = [], logged = [];
    const originals = Object.fromEntries(['log', 'warn', 'error'].map(key => [key, console[key]]));
    const storageDescriptors = Object.fromEntries(['localStorage', 'sessionStorage'].map(key => [key, Object.getOwnPropertyDescriptor(window, key)]));
    for (const key of ['localStorage', 'sessionStorage']) Object.defineProperty(window, key, {
        configurable: true, get() { forbidden.push(key); throw Error('Persistence forbidden'); }
    });
    const allowed = { id: 1, windowId: 7, incognito: true, title: 'SYNTHETIC OWNER', url: 'https://synthetic-owner.invalid/', index: 0 };
    const other = { id: 2, windowId: 8, incognito: true, title: 'SYNTHETIC OTHER PRIVATE', index: 1 };
    const normal = { id: 3, windowId: 9, incognito: false, title: 'SYNTHETIC NORMAL', index: 2 };
    const inconsistent = { id: 4, windowId: 7, incognito: false, title: 'SYNTHETIC NOT PRIVATE', index: 3 };
    const settle = () => new Promise(resolve => setImmediate(resolve));
    try {
        Object.assign(globalThis, { chrome: f.chrome, document });
        for (const key of Object.keys(originals)) console[key] = (...args) => logged.push(args);
        f.setTabs([allowed, other, normal, inconsistent]);
        await import(new URL('../../' + script.getAttribute('src'), import.meta.url));
        for (let attempt = 0; document.body.hasAttribute('data-sidebar-pending') && attempt < 100; attempt++) await settle();
        assert.equal(document.body.hasAttribute('data-sidebar-pending'), false);
        assert.equal(document.querySelectorAll('.private-tab').length, 1);
        assert.match(document.body.textContent, /SYNTHETIC OWNER/);
        assert.doesNotMatch(document.body.textContent, /SYNTHETIC OTHER|SYNTHETIC NORMAL|SYNTHETIC NOT PRIVATE/);
        for (const selector of ['#spacesList', '#spaceSwitcher', '#pinnedFavicons', '#newTabBtn', '#addSpaceBtn', '#spaceTemplate']) assert.equal(document.querySelector(selector), null);
        assert.equal(document.querySelector('img'), null, 'No private URL favicon request');
        assert.doesNotMatch(document.body.innerHTML, /synthetic-owner\.invalid/);
        assert.deepEqual(f.queries, [{ windowId: 7 }]);

        // Capture rendered controls before a move, private-boundary change, or close.
        for (const replacement of [{ ...allowed, windowId: 8 }, { ...allowed, incognito: false }, null]) {
            f.setTabs([allowed, other, normal]);
            f.chrome.tabs.onAttached.fire(1, { newWindowId: 7 }); await settle();
            const activate = document.querySelector('[data-action="activate"]');
            const close = document.querySelector('[data-action="close"]');
            f.setTabs([...(replacement ? [replacement] : []), other, normal]);
            activate.click(); await settle();
            close.click(); await settle();
            assert.deepEqual(f.mutations, []);
            assert.equal(document.querySelectorAll('.private-tab').length, 0);
            assert.match(document.querySelector('[role="status"]').textContent, /changed/);
        }

        f.setTabs([allowed, other, normal]);
        f.chrome.tabs.onAttached.fire(1, { newWindowId: 7 }); await settle();
        document.querySelector('[data-action="activate"]').click(); await settle();
        document.querySelector('[data-action="close"]').click(); await settle();
        document.querySelector('.private-sidebar > button').click(); await settle();
        assert.deepEqual(f.mutations, [['update', 1, { active: true }], ['remove', 1], ['create', { windowId: 7, active: true, url: 'chrome://newtab/' }]]);
        assert.ok(f.queries.every(query => query.windowId === 7));
        const oldAction = document.querySelector('[data-action="activate"]');
        window.dispatchEvent(new window.Event('pagehide'));
        oldAction.click(); await settle();
        assert.equal(f.mutations.length, 3, 'Disposed UI cannot mutate through old controls');
        for (const event of Object.values(f.chrome.tabs)) if (event.listeners) assert.equal(event.listeners.size, 0);
        assert.equal(f.chrome.windows.onRemoved.listeners.size, 0);
        assert.deepEqual(forbidden, []);
        assert.deepEqual(f.forbiddenAccess, []);
        assert.deepEqual(logged, []);
    } finally {
        window.dispatchEvent(new window.Event('pagehide'));
        Object.assign(console, originals);
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
        }
        for (const [key, descriptor] of Object.entries(storageDescriptors)) {
            if (descriptor) Object.defineProperty(window, key, descriptor); else delete window[key];
        }
    }
});
test('normal context retains normal DOM and loads only original sidebar', async () => {
    const f = fixture(); let count = 0;
    f.chrome.windows.getCurrent = async () => ({ id: 9, incognito: false });
    await startSidebar({ ...f, loadNormal: async () => { count++; }, loadPrivate: () => assert.fail('private module loaded') });
    assert.equal(count, 1);
    assert.ok(f.document.getElementById('normal'));
    assert.deepEqual(f.queries, []);
});
test('unknown context fails closed without importing either sidebar or exposing errors', async () => {
    const f = fixture();
    f.chrome.windows.getCurrent = async () => { throw Error('SYNTHETIC PRIVATE'); };
    await startSidebar({ ...f, loadNormal: () => assert.fail(), loadPrivate: () => assert.fail() });
    assert.doesNotMatch(f.document.body.textContent, /SYNTHETIC|Spaces|Favorites/);
});
test('private query and mutations use exact native window and tab identity', async () => {
    const f = fixture(), api = createPrivateTabs(f.chrome, 7);
    f.setTabs([{ id: 1, windowId: 7, incognito: true, index: 0 }, { id: 2, windowId: 8, incognito: true }, { id: 3, windowId: 7, incognito: false }]);
    assert.deepEqual((await api.list()).map(t => t.id), [1]);
    assert.deepEqual(f.queries, [{ windowId: 7 }]);
    for (const id of [2, 3, 999]) {
        await assert.rejects(api.activate(id)); await assert.rejects(api.close(id));
    }
    assert.deepEqual(f.mutations, []);
    await api.activate(1); await api.close(1); await api.create();
    assert.deepEqual(f.mutations, [['update', 1, { active: true }], ['remove', 1], ['create', { windowId: 7, active: true, url: 'chrome://newtab/' }]]);
    f.chrome.windows.get = async () => ({ id: 7, incognito: false });
    await assert.rejects(api.create()); await assert.rejects(api.list());
});
test('native move/close events requery, foreign events ignored, window close clears private data and listeners', async () => {
    const f = fixture(); const ui = await mountPrivateSidebar({ ...f, windowId: 7 });
    const before = f.queries.length;
    f.chrome.tabs.onActivated.fire({ windowId: 99 });
    assert.equal(f.queries.length, before);
    f.setTabs([]);
    f.chrome.tabs.onDetached.fire(1, { oldWindowId: 7 });
    await ui.refresh();
    assert.doesNotMatch(f.document.body.textContent, /SYNTHETIC PRIVATE/);
    f.chrome.windows.onRemoved.fire(7);
    assert.equal(f.chrome.tabs.onUpdated.listeners.size, 0);
    assert.equal(f.document.querySelector('button').disabled, true);
});
test('out of order native queries cannot resurrect stale titles', async () => {
    const f = fixture(); const ui = await mountPrivateSidebar({ ...f, windowId: 7 });
    let resolveOld;
    f.chrome.tabs.query = () => new Promise(resolve => { resolveOld = resolve; });
    const old = ui.refresh();
    await new Promise(resolve => setImmediate(resolve));
    f.chrome.tabs.query = async () => [];
    await ui.refresh();
    resolveOld([{ id: 1, windowId: 7, incognito: true, title: 'SYNTHETIC STALE' }]);
    await old;
    assert.doesNotMatch(f.document.body.textContent, /SYNTHETIC/);
    ui.dispose();
});
test('native failures expose neither private markers nor logs and reload uses fresh native state', async () => {
    const f = fixture(), logged = [];
    const originals = Object.fromEntries(['log', 'warn', 'error'].map(key => [key, console[key]]));
    try {
        for (const key of Object.keys(originals)) console[key] = (...args) => logged.push(args);
        f.chrome.tabs.query = async () => { throw Error('https://synthetic-private.invalid/ PRIVATE TITLE'); };
        const first = await mountPrivateSidebar({ ...f, windowId: 7 });
        assert.doesNotMatch(f.document.body.textContent, /synthetic-private|PRIVATE TITLE/);
        first.dispose();
        f.chrome.tabs.query = async () => [{ id: 5, windowId: 7, incognito: true, title: 'SYNTHETIC FRESH' }];
        const second = await mountPrivateSidebar({ ...f, windowId: 7 });
        assert.match(f.document.body.textContent, /SYNTHETIC FRESH/);
        second.dispose();
        assert.deepEqual(logged, []);
    } finally { Object.assign(console, originals); }
});
test('refresh preserves keyboard focus by exact tab and action, closed target returns to new tab', async () => {
    const f = fixture();
    let active;
    Object.defineProperty(f.document, 'activeElement', { get: () => active });
    const prototype = f.document.defaultView.HTMLElement.prototype, original = prototype.focus;
    prototype.focus = function () { active = this; };
    try {
        const ui = await mountPrivateSidebar({ ...f, windowId: 7 });
        f.document.querySelector('[data-action="close"]').focus();
        await ui.refresh();
        assert.equal(active.dataset.tabId, '1');
        assert.equal(active.dataset.action, 'close');
        assert.ok(f.document.body.contains(active));
        f.setTabs([]);
        await ui.refresh();
        assert.equal(active.textContent, 'New private tab');
        ui.dispose();
    } finally { prototype.focus = original; }
});
