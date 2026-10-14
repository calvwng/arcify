// Pure evidence checks only. No browser, Chrome process or profile is opened.
import test from 'node:test';
import assert from 'node:assert/strict';
import { durableFavoriteRecords, nativePinContents, assertUnchangedExtensionRegistry,
    assertFreshFavoriteRead, assertFavoritesAfterRestart, assertFavoriteReopened, requestScopedFavorite, assertFavoriteRender } from '../../scripts/paired-chrome-favorites-restart.mjs';
import { FAVORITE_FAVICON_PNG, assertLegacyFavoriteRegistry } from '../../scripts/paired-chrome-favorite-icons.mjs';

const retainedIcon = `data:image/png;base64,${FAVORITE_FAVICON_PNG.toString('base64')}`;

test('scoped Favorite requests validate the real sender window before dispatch', async () => {
    const oldChrome = globalThis.chrome, messages = [];
    try {
        globalThis.chrome = { tabs: { getCurrent: async () => ({ id: 700, windowId: 70 }) },
            runtime: { sendMessage: async message => { messages.push(message); return { success: true, favorites: [] }; } } };
        const page = { evaluate: async (callback, message) => callback(message) };
        await requestScopedFavorite(page, 70, 'get');
        assert.deepEqual(messages, [{ type: 'favoriteStore', action: 'get', windowId: 70 }]);
        await assert.rejects(requestScopedFavorite(page, 90, 'open', { favoriteId: 'saved-first' }), /exact target window/);
        assert.equal(messages.length, 1, 'A cross-window fixture shortcut must never reach production dispatch.');
        globalThis.chrome.tabs.getCurrent = async () => undefined;
        await assert.rejects(requestScopedFavorite(page, 70, 'get'), /exact target window/);
        assert.equal(messages.length, 1);
    } finally { if (oldChrome === undefined) delete globalThis.chrome; else globalThis.chrome = oldChrome; }
});

const favorites = () => [
    { id: 'saved-second', title: 'Same URL, second identity', url: 'http://fixture.test/same', sourceBookmarkId: 'bookmark-two' },
    { id: 'saved-first', title: 'First identity', url: 'http://fixture.test/same', sourceBookmarkId: 'bookmark-one' },
    { id: 'older-favorite', title: 'Earlier scenario record', url: 'http://fixture.test/earlier', sourceBookmarkId: null }
];
const iconCache = () => ({ version: 1, entries: [{ favoriteId: 'saved-second', url: 'http://fixture.test/same', faviconDataUrl: retainedIcon }] });
const tab = (id, windowId = 70, options = {}) => ({ id, windowId, url: 'http://fixture.test/same', pinned: true, incognito: false, active: false, ...options });
const sources = () => ({ bookmarks: [
    { id: 'bookmark-one', parentId: 'folder', index: 0, title: 'First identity', url: 'http://fixture.test/same' },
    { id: 'bookmark-two', parentId: 'folder', index: 1, title: 'Same URL, second identity', url: 'http://fixture.test/same' }
], parents: [{ id: 'folder', parentId: 'root', index: 1, title: 'Space' }] });
function states(tabs) {
    return [70, 90].map(windowId => ({ windowId, favorites: favorites().map(item => ({ ...item, tabId: null, ...(item.id === 'saved-second' ? { faviconDataUrl: retainedIcon } : {}) })),
        nativeTabs: tabs.filter(tab => tab.windowId === windowId && tab.pinned) }));
}
function restarted() {
    const tabs = [tab(701), tab(702), tab(900, 90), tab(703, 70, { pinned: false, url: 'chrome-extension://fixture/options.html' })];
    return { durable: favorites(), iconCache: iconCache(), sources: sources(), tabs, states: states(tabs), windows: [{ id: 70 }, { id: 90 }],
        session: null, sessionAfterGet: { version: 1, bindings: [], attempts: [] } };
}
function beforeRestart() {
    return { durable: favorites(), iconCache: iconCache(), sources: sources(), tabs: [tab(1, 1), tab(2, 1), tab(3, 2)] };
}
function reopened() {
    const before = restarted(), after = structuredClone(before), created = tab(704, 70, { active: true });
    after.tabs.push(created);
    after.states.find(state => state.windowId === 70).favorites.find(item => item.id === 'saved-first').tabId = created.id;
    after.sessionAfterGet.bindings = [{ favoriteId: 'saved-first', windowId: 70, tabId: created.id }];
    return { before, after, created, expected: { favoriteId: 'saved-first', windowId: 70 } };
}

test('durable projection retains every identity, metadata field and exact order without session IDs', () => {
    const original = favorites().map((item, index) => ({ ...item, tabId: index + 10 }));
    original[0].faviconDataUrl = retainedIcon;
    assert.deepEqual(durableFavoriteRecords(original), favorites());
    assert.equal(original[0].tabId, 10);
    assert.equal(original[0].faviconDataUrl, retainedIcon, 'Projection must not mutate the internal joined UI record.');
    assert.equal(Object.hasOwn(durableFavoriteRecords(original)[0], 'faviconDataUrl'), false);
    assert.equal(Object.hasOwn(durableFavoriteRecords(original)[1], 'faviconDataUrl'), false, 'Older records need no optional icon.');
});
test('old durable lists remain compatible without inventing retained icons', () => {
    const old = favorites();
    assert.deepEqual(durableFavoriteRecords(old), old);
});
for (const icon of [null, '', 'https://fixture.test/icon.png', 'data:image/png;base64,AAAA']) {
    test('any optional icon field in the legacy registry fails raw compatibility evidence', () => {
        const list = favorites(); list[0].faviconDataUrl = icon; assert.throws(() => assertLegacyFavoriteRegistry(list));
    });
}
for (const mutate of [list => list.push(list[0]), list => { list[0].id = ''; }, list => { delete list[0].sourceBookmarkId; }, list => { list[0].title = null; }]) {
    test('invalid durable records cannot form passing restart evidence', () => {
        const list = favorites(); mutate(list); assert.throws(() => durableFavoriteRecords(list));
    });
}
test('native content observations preserve duplicate counts and do not claim stable browser-session IDs', () => {
    assert.deepEqual(nativePinContents([tab(1), tab(2)]), nativePinContents([tab(90, 10), tab(91, 20)]));
    assert.equal(nativePinContents([tab(1), tab(2), tab(3, 70, { pinned: false }), tab(4, 70, { incognito: true })]).length, 2);
    assert.notDeepEqual(nativePinContents([tab(1)]), nativePinContents([tab(2), tab(3)]));
});
test('durable identities survive while fresh exact IDs identify restored pins separately in every window', () => {
    assert.doesNotThrow(() => assertFavoritesAfterRestart(beforeRestart(), restarted()));
});
test('legacy profiles without an auxiliary icon cache still preserve every original restart assertion', () => {
    const before = beforeRestart(), after = restarted(); before.iconCache = null; after.iconCache = null;
    for (const state of after.states) for (const favorite of state.favorites) delete favorite.faviconDataUrl;
    assert.doesNotThrow(() => assertFavoritesAfterRestart(before, after));
});
test('Chrome is not required to restore any pins, and no old/new URL-based mapping is invented', () => {
    const after = restarted(); after.tabs = after.tabs.filter(tab => !tab.pinned); after.states = states(after.tabs);
    assert.doesNotThrow(() => assertFavoritesAfterRestart(beforeRestart(), after));
});
for (const [name, mutate] of [
    ['missing earlier Favorite', after => { after.durable.pop(); }],
    ['changed order', after => { after.durable.reverse(); }],
    ['changed durable ID', after => { after.durable[0].id = 'replacement'; }],
    ['changed durable title', after => { after.durable[0].title = 'changed'; }],
    ['changed durable URL', after => { after.durable[0].url = 'http://different.test/'; }],
    ['changed source identity', after => { after.durable[0].sourceBookmarkId = 'different'; }],
    ['lost retained icon cache', after => { after.iconCache = null; }],
    ['changed retained icon bytes', after => { after.iconCache.entries[0].faviconDataUrl = 'data:image/png;base64,changed'; }],
    ['changed cache owner', after => { after.iconCache.entries[0].favoriteId = 'saved-first'; }],
    ['changed cache saved URL', after => { after.iconCache.entries[0].url = 'http://fixture.test/changed'; }],
    ['legacy registry icon pollution', after => { after.durable[0].faviconDataUrl = retainedIcon; }],
    ['window omitted retained icon', after => { delete after.states[0].favorites[0].faviconDataUrl; }],
    ['changed source bookmark', after => { after.sources.bookmarks[0].title = 'changed'; }],
    ['moved source parent', after => { after.sources.parents[0].index++; }],
    ['stale raw binding', after => { after.session = { bindings: [{ favoriteId: 'saved-first', tabId: 1, windowId: 1 }] }; }],
    ['stale raw receipt', after => { after.session = { attempts: [{ favoriteId: 'saved-first', tabId: 1, windowId: 1 }] }; }],
    ['get invented a binding', after => { after.sessionAfterGet.bindings.push({ tabId: 701 }); }],
    ['get attempted to open', after => { after.sessionAfterGet.attempts.push({ tabId: null }); }],
    ['equal-URL pin adoption', after => { after.states[0].favorites[0].tabId = 701; }],
    ['missing fresh window check', after => { after.states.pop(); }],
    ['different window list', after => { after.states[1].favorites.reverse(); }],
    ['native pin hidden by Favorite model', after => { after.states[0].nativeTabs.pop(); }],
    ['native pin identity replaced', after => { after.states[0].nativeTabs[0] = { ...after.states[0].nativeTabs[0], id: 111 }; }]
]) {
    test(`${name} fails browser-restart evidence checks`, () => {
        const after = restarted(); mutate(after);
        assert.throws(() => assertFavoritesAfterRestart(beforeRestart(), after));
    });
}

test('a fresh read may finish page loading or change titles but cannot mutate exact tab identity or contents', () => {
    assert.doesNotThrow(() => assertFreshFavoriteRead([tab(1, 70, { status: 'loading' })], [tab(1, 70, { status: 'complete', title: 'Loaded' })]));
    for (const after of [[tab(1), tab(2)], [], [tab(2)], [tab(1, 80)], [tab(1, 70, { url: 'http://changed.test/' })], [tab(1, 70, { pinned: false })]]) {
        assert.throws(() => assertFreshFavoriteRead([tab(1)], after));
    }
});

test('sidebar proof requires exact saved order, closed state and separate native rows', () => {
    const state = restarted().states[0];
    const render = { favorites: state.favorites.map(({ id, tabId }) => ({ id, tabId, closed: true })), nativeTabIds: state.nativeTabs.map(tab => tab.id) };
    assert.doesNotThrow(() => assertFavoriteRender(state, render));
    for (const mutate of [value => value.favorites.reverse(), value => { value.favorites[0].closed = false; },
        value => { value.favorites[0].tabId = 701; }, value => { value.nativeTabIds.pop(); }, value => { value.nativeTabIds.push(701); }]) {
        const bad = structuredClone(render); mutate(bad); assert.throws(() => assertFavoriteRender(state, bad));
    }
});

test('explicit reopen creates one exact new Favorite while every earlier tab and native pin remains unchanged', () => {
    const h = reopened(); assert.deepEqual(assertFavoriteReopened(h.before, h.after, h.expected), h.created);
});
for (const [name, mutate] of [
    ['matching existing URL reused', h => { h.after.tabs.pop(); h.after.states[0].favorites[1].tabId = 701; }],
    ['second additional tab', h => h.after.tabs.push(tab(705))],
    ['preexisting tab closed', h => { h.after.tabs = h.after.tabs.filter(tab => tab.id !== 703); }],
    ['preexisting tab navigated', h => { h.after.tabs[0].url = 'http://changed.test/'; }],
    ['restored native pin unpinned', h => { h.after.tabs[0].pinned = false; }],
    ['new tab unpinned', h => { h.after.tabs.at(-1).pinned = false; }],
    ['wrong target window', h => { h.after.tabs.at(-1).windowId = 90; }],
    ['new tab not active', h => { h.after.tabs.at(-1).active = false; }],
    ['second Favorite rebound', h => { h.after.states[0].favorites[0].tabId = 701; }],
    ['other window rebound', h => { h.after.states[1].favorites[1].tabId = 900; }],
    ['native pin hidden', h => { h.after.states[0].nativeTabs.pop(); }],
    ['extra raw session binding', h => { h.after.sessionAfterGet.bindings.push({ favoriteId: 'saved-second', tabId: 701, windowId: 70 }); }],
    ['pending raw open receipt', h => { h.after.sessionAfterGet.attempts.push({ favoriteId: 'saved-first' }); }],
    ['source bookmark modified', h => { h.after.sources.bookmarks[0].url = 'http://changed.test/'; }],
    ['durable Favorite removed', h => { h.after.durable.pop(); }],
    ['retained icon removed', h => { h.after.iconCache.entries = []; }],
    ['legacy registry icon pollution', h => { h.after.durable[0].faviconDataUrl = retainedIcon; }],
    ['window changed retained icon', h => { delete h.after.states[0].favorites[0].faviconDataUrl; }]
]) {
    test(`explicit reopen rejects ${name}`, () => {
        const h = reopened(); mutate(h); assert.throws(() => assertFavoriteReopened(h.before, h.after, h.expected));
    });
}

const extensions = () => [
    { id: 'a'.repeat(32), name: 'Arcify', version: '5.1.0', path: '/ci/arcify/dist', enabled: true },
    { id: 'b'.repeat(32), name: 'Spotlight', version: '1.0.0', path: '/ci/spotlight/dist', enabled: true }
];
test('exact extension registry identity accepts order changes but keeps paths, IDs, names, versions and enabled state', () => {
    assert.doesNotThrow(() => assertUnchangedExtensionRegistry(extensions(), extensions().reverse(), extensions()));
});
for (const [name, mutate] of [
    ['different ID', list => { list[0].id = 'c'.repeat(32); }],
    ['different path', list => { list[0].path = '/tmp/reinstalled/dist'; }],
    ['different version', list => { list[0].version = 'changed'; }],
    ['different name', list => { list[0].name = 'changed'; }],
    ['disabled extension', list => { list[0].enabled = false; }],
    ['missing extension', list => { list.pop(); }],
    ['additional extension', list => { list.push({ ...list[0], id: 'c'.repeat(32) }); }]
]) {
    test(`${name} fails the postrestart registry check without repair`, () => {
        const after = extensions(); mutate(after);
        assert.throws(() => assertUnchangedExtensionRegistry(extensions(), after, extensions()));
    });
}
