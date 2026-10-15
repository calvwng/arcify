import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { assertTabMenuFixtureEnvironment, serveTabMenuFixture, assertTabMenuCancelled, assertTabMenuClosedTargetGone, assertTabMenuAlias,
    assertTabMenuSavedEdit, assertTabMenuMuted, assertTabMenuDuplicated, assertTabMenuPinRemoved, watchTabMenuInvalidation, readRenamedTabSearch } from '../../scripts/paired-chrome-tab-menu.mjs';

function aliasSearchHarness({ stale = false, query = 'nonce', twinChanged = false, timeOrigin = 42 } = {}) {
    let visible = false;
    const calls = [], rows = () => [{ type: 'open-tab', title: visible && !stale ? 'alias' : 'source' },
        { type: 'open-tab', title: twinChanged ? 'alias' : 'source' }];
    const page = {
        async evaluate(fn) { if (fn.name === 'readSpotlightRows') { calls.push('rows'); return rows(); } calls.push('document'); return timeOrigin; },
        async $eval(selector, read) { assert.equal(selector, '[data-testid="spotlight-input"]'); calls.push('query'); return read({ value: query }); }
    };
    return { page, calls, query: 'nonce', alias: 'alias', sourceTitle: 'source', documentTimeOrigin: 42,
        async ui(actual, label, action) { assert.equal(actual, page); calls.push('return'); visible = true; return action(); },
        async poll(read, accept) { const observed = await read(); assert(accept(observed)); return observed; } };
}
test('alias evidence returns to the same mounted query before polling deferred results without replacement search', async () => {
    const h = aliasSearchHarness(); await readRenamedTabSearch(h);
    assert.deepEqual(h.calls, ['return', 'rows', 'query', 'document']);
});
for (const [name, options] of Object.entries({ stale: { stale: true }, twinChanged: { twinChanged: true }, queryChanged: { query: 'other' }, reloaded: { timeOrigin: 43 } })) {
    test(`alias query evidence rejects ${name} after foregrounding`, async () => {
        const h = aliasSearchHarness(options); await assert.rejects(readRenamedTabSearch(h));
        assert.equal(h.calls[0], 'return'); assert.equal(h.calls.filter(call => call === 'return').length, 1);
    });
}
test('alias invalidation observer accepts only the exact paired window and authenticated worker with strict message shape', () => {
    let receive;
    const context = { performance: { timeOrigin: 42 }, document: { visibilityState: 'hidden' },
        chrome: { runtime: { id: 'spotlight', getURL: path => `chrome-extension://spotlight/${path}`, onMessage: { addListener(fn) { receive = fn; } } } } };
    const original = runInNewContext(`(${watchTabMenuInvalidation.toString()})({ windowId: 7, peerId: 'arcify' })`, context);
    const message = { action: 'spotlightArcifyResultsChanged', windowId: 7, peerId: 'arcify' }, sender = { id: 'spotlight' };
    for (const invalid of [{ id: 'wrong' }, { ...sender, tab: {} }, { ...sender, url: 'https://wrong.test/' }, { ...sender, origin: 'https://wrong.test' }]) receive(message, invalid);
    for (const invalid of [null, [], { ...message, windowId: 8 }, { ...message, peerId: 'wrong' }, { ...message, unexpected: true }]) receive(invalid, sender);
    assert.equal(context.__pairedTabMenuSearch.changes.length, 0);
    receive(message, { ...sender, url: 'chrome-extension://spotlight/background.js', origin: 'chrome-extension://spotlight' });
    assert.equal(context.__pairedTabMenuSearch.changes.length, 1);
    assert.equal(context.__pairedTabMenuSearch.changes[0].visibility, 'hidden');
    assert.equal(context.__pairedTabMenuSearch.documentTimeOrigin, original.documentTimeOrigin);
});

function sample() {
    const tab = (id, windowId, index, url, title) => ({ id, windowId, index, url, pendingUrl: null, title, pinned: false, incognito: false, active: false, groupId: -1, muted: false });
    const before = {
        tabs: [tab(11, 7, 0, 'http://fixture/ordinary', 'Same page'), tab(12, 7, 1, 'http://fixture/ordinary', 'Same page'), tab(21, 7, 2, 'http://fixture/pin', 'Native pin page'), tab(99, 8, 0, 'http://fixture/other', 'Other window')],
        bookmarks: [{ id: 'closed', parentId: 'folder', index: 1, title: 'Closed URL twin', url: 'http://fixture/pin' },
            { id: 'folder', parentId: 'root', index: 2, title: 'Folder' }, { id: 'other', parentId: 'other-root', index: 0, title: 'Unrelated', url: 'http://fixture/other' },
            { id: 'pin', parentId: 'folder', index: 0, title: 'Saved Pin', url: 'http://fixture/pin' }],
        spaces: [{ id: 'work', bookmarkFolderId: 'root', temporaryTabs: [11, 12], spaceBookmarks: [21] }, { id: 'other-space', bookmarkFolderId: 'other-root', temporaryTabs: [], spaceBookmarks: [99] }],
        aliases: { 21: { name: 'Obsolete pin alias' }, 99: { name: 'Keep independent alias' } },
        bindings: { 21: { bookmarkId: 'pin', pinnedUrl: 'http://fixture/pin' }, 99: { bookmarkId: 'other', pinnedUrl: 'http://fixture/other' } },
        favorites: [{ id: 'favorite', title: 'Unchanged Favorite', url: 'http://fixture/favorite', sourceBookmarkId: null }],
        activeSpaceId: 'work', pageStates: { 11: { url: 'http://fixture/ordinary', title: 'Same page', documentId: 'original-document', value: 'user-kept-input' }, 21: { url: 'http://fixture/pin', title: 'Native pin page', documentId: 'pin-document', value: 'pin-kept-input' } }
    };
    before.snapshot = { tabs: before.tabs.map(tab => ({ id: tab.id, title: tab.id === 21 ? 'Saved Pin' : tab.title, url: tab.url, spaceId: tab.windowId === 7 ? 'work' : 'other-space' })),
        bookmarks: before.bookmarks.filter(node => node.url).map(node => ({ id: node.id, title: node.title, url: node.url, spaceId: node.id === 'other' ? 'other-space' : 'work', tabId: node.id === 'pin' ? 21 : node.id === 'other' ? 99 : null })),
        spaces: [{ id: 'work', temporaryTabIds: [11, 12], pinnedTabIds: [21] }, { id: 'other-space', temporaryTabIds: [], pinnedTabIds: [99] }] };
    return { before, after: structuredClone(before) };
}
function aliasSample() { const f = sample(); f.request = { tabId: 11, twinId: 12, alias: 'Only this exact tab' }; f.after.aliases[11] = { name: f.request.alias, originalDomain: 'fixture' }; f.after.snapshot.tabs.find(tab => tab.id === 11).title = f.request.alias; return f; }
function editSample({ closed = false, field = 'url' } = {}) {
    const f = sample(); f.request = { bookmarkId: closed ? 'closed' : 'pin', field, value: field === 'url' ? 'http://fixture/edited' : 'Renamed pin', spaceId: 'work' };
    f.after.bookmarks.find(node => node.id === f.request.bookmarkId)[field] = f.request.value;
    f.after.snapshot.bookmarks.find(node => node.id === f.request.bookmarkId)[field] = f.request.value;
    if (!closed) { delete f.after.aliases[21]; if (field === 'url') { f.after.bindings[21].pinnedUrl = f.request.value; f.after.snapshot.tabs.find(tab => tab.id === 21).title = 'Native pin page'; } else f.after.snapshot.tabs.find(tab => tab.id === 21).title = f.request.value; }
    return f;
}
function duplicateSample() {
    const f = sample(); f.request = { sourceId: 11, windowId: 7, spaceId: 'work' };
    f.after.tabs.filter(tab => tab.windowId === 7 && tab.index > 0).forEach(tab => tab.index++);
    f.after.tabs.push({ ...f.before.tabs[0], id: 100, index: 1, active: true }); f.after.tabs.sort((a, b) => a.id - b.id);
    f.after.spaces[0].temporaryTabs.splice(1, 0, 100); f.after.snapshot.tabs.push({ ...f.before.snapshot.tabs[0], id: 100 }); f.after.snapshot.spaces[0].temporaryTabIds.splice(1, 0, 100);
    return f;
}
function removeSample() {
    const f = sample(); f.request = { bookmarkId: 'pin', tabId: 21, spaceId: 'work' };
    f.after.bookmarks = f.after.bookmarks.filter(node => node.id !== 'pin'); f.after.bookmarks.find(node => node.id === 'closed').index--;
    delete f.after.bindings[21]; delete f.after.aliases[21]; f.after.spaces[0].spaceBookmarks = []; f.after.spaces[0].temporaryTabs.push(21);
    f.after.snapshot.bookmarks = f.after.snapshot.bookmarks.filter(node => node.id !== 'pin'); return f;
}
const check = (validator, f) => validator(f.before, f.after, f.request);

for (const env of [{}, { CI: 'true' }, { GITHUB_ACTIONS: 'true' }, { CI: 'false', GITHUB_ACTIONS: 'true' }]) test(`real fixture rejects non-CI environment ${JSON.stringify(env)}`, () => assert.throws(() => assertTabMenuFixtureEnvironment(env, 1001)));
test('real fixture rejects root without weakening Chrome sandbox', () => assert.throws(() => assertTabMenuFixtureEnvironment({ CI: 'true', GITHUB_ACTIONS: 'true' }, 0)));
test('fixture import is browser-free and guarded ordinary CI is accepted', () => assertTabMenuFixtureEnvironment({ CI: 'true', GITHUB_ACTIONS: 'true' }, 1001));

test('source server route emits distinct response identities and a real user-input field', () => {
    const responses = []; const request = { url: '/tab-menu/0123456789abcdef0123456789abcdef/ordinary' };
    for (let i = 0; i < 2; i++) {
        let headers, body; const response = { writeHead(code, values) { assert.equal(code, 200); headers = values; }, end(value) { body = value; } };
        assert.equal(serveTabMenuFixture(request, response), true); assert.equal(headers['Cache-Control'], 'no-store'); assert.match(body, /id="page-state"/); assert.match(body, /default|Tab Menu ordinary/); responses.push(body.match(/data-document-id="([a-f0-9]{32})"/)[1]);
    }
    assert.notEqual(responses[0], responses[1]);
    assert.equal(serveTabMenuFixture({ url: '/unrelated' }, { writeHead() { assert.fail(); } }), false);
    assert.equal(serveTabMenuFixture({ url: '/tab-menu/not-a-nonce/ordinary' }, { writeHead() { assert.fail(); } }), false);
});

test('cancel comparison forbids mutation or loss of real page state', () => {
    const f = sample(); assertTabMenuCancelled(f.before, f.after);
    for (const field of ['tabs', 'bookmarks', 'spaces', 'bindings', 'aliases', 'favorites', 'activeSpaceId', 'pageStates']) {
        const after = structuredClone(f.after); after[field] = null; assert.throws(() => assertTabMenuCancelled(f.before, after), field);
    }
});

test('closed-tab stale baseline requires native, bridge, Space and metadata cleanup to settle', () => {
    const f = sample(), state = f.after;
    state.tabs = state.tabs.filter(tab => tab.id !== 12); state.snapshot.tabs = state.snapshot.tabs.filter(tab => tab.id !== 12); state.spaces[0].temporaryTabs = [11];
    assertTabMenuClosedTargetGone(state, 12);
    for (const mutate of [s => s.tabs.push(f.before.tabs[1]), s => s.snapshot.tabs.push(f.before.snapshot.tabs[1]), s => s.spaces[0].temporaryTabs.push(12), s => s.spaces[1].spaceBookmarks.push(12), s => s.aliases[12] = { name: 'stale' }, s => s.bindings[12] = { bookmarkId: 'stale' }]) {
        const changed = structuredClone(state); mutate(changed); assert.throws(() => assertTabMenuClosedTargetGone(changed, 12));
    }
});

test('alias proof requires exact ID and real bridge title while equal-URL twin stays separate', () => check(assertTabMenuAlias, aliasSample()));
for (const [name, mutate] of Object.entries({
    sourceUrl: f => f.after.tabs[0].url = 'http://changed', sourceTitle: f => f.after.tabs[0].title = 'Changed native title',
    browserIdentity: f => f.after.tabs[0].windowId = 8, sourceClosed: f => f.after.tabs.shift(), sourceReloaded: f => f.after.pageStates[11].documentId = 'new-document',
    lostInput: f => f.after.pageStates[11].value = 'untouched', sameUrlAliasCopied: f => f.after.aliases[12] = f.after.aliases[11],
    wrongAlias: f => f.after.aliases[11].name = 'Wrong', staleBridge: f => f.after.snapshot.tabs[0].title = 'Same page',
    twinBridgeChanged: f => f.after.snapshot.tabs[1].title = f.request.alias, favoritesChanged: f => f.after.favorites = [],
    unrelatedNameRemoved: f => delete f.after.aliases[99], bookmarkChanged: f => f.after.bookmarks[0].title = 'Unexpected'
})) test(`alias proof rejects ${name}`, () => { const f = aliasSample(); mutate(f); assert.throws(() => check(assertTabMenuAlias, f)); });

for (const closed of [false, true]) for (const field of ['title', 'url']) test(`${closed ? 'closed' : 'live'} ${field} edit proof preserves all unrelated identity and page state`, () => check(assertTabMenuSavedEdit, editSample({ closed, field })));
for (const [name, mutate] of Object.entries({
    newId: f => f.after.bookmarks.find(node => node.id === 'pin').id = 'replacement', movedFolder: f => f.after.bookmarks.find(node => node.id === 'pin').parentId = 'other-root',
    reordered: f => f.after.bookmarks.find(node => node.id === 'pin').index = 8, overwrittenTitle: f => f.after.bookmarks.find(node => node.id === 'pin').title = 'Lost name',
    equalUrlTwinChanged: f => f.after.bookmarks.find(node => node.id === 'closed').url = f.request.value,
    openPageNavigated: f => f.after.tabs.find(tab => tab.id === 21).url = f.request.value, pageReloaded: f => f.after.pageStates[21].documentId = 'new',
    stalePinnedTarget: f => f.after.bindings[21].pinnedUrl = 'http://fixture/pin', changedOtherBinding: f => f.after.bindings[99].bookmarkId = 'pin',
    obsoleteAlias: f => f.after.aliases[21] = { name: 'Old name' }, changedFavorite: f => f.after.favorites[0].url = f.request.value,
    staleSavedSnapshot: f => f.after.snapshot.bookmarks.find(node => node.id === 'pin').url = 'http://fixture/pin',
    snapshotTitleCorrupt: f => f.after.snapshot.bookmarks.find(node => node.id === 'pin').title = 'Wrong projected title',
    duplicateBridgeSavedRow: f => f.after.snapshot.bookmarks.push({ ...f.after.snapshot.bookmarks.find(node => node.id === 'pin') }),
    changedLiveBinding: f => f.after.snapshot.bookmarks.find(node => node.id === 'pin').tabId = 12, switchedSpace: f => f.after.activeSpaceId = 'other-space'
})) test(`saved-edit proof rejects ${name}`, () => { const f = editSample(); mutate(f); assert.throws(() => check(assertTabMenuSavedEdit, f)); });
test('saved title proof rejects stale projected live title at saved URL', () => { const f = editSample({ field: 'title' }); f.after.snapshot.tabs.find(tab => tab.id === 21).title = 'Old'; assert.throws(() => check(assertTabMenuSavedEdit, f)); });

test('mute proof allows only the requested live bit', () => { const f = sample(); f.after.tabs[0].muted = true; assertTabMenuMuted(f.before, f.after, { tabId: 11, muted: true }); f.after.tabs[1].muted = true; assert.throws(() => assertTabMenuMuted(f.before, f.after, { tabId: 11, muted: true })); });
test('mute proof rejects source navigation, alias changes and lost page state', () => {
    for (const mutate of [f => f.after.tabs[0].url = 'http://changed', f => f.after.aliases[11] = { name: 'Changed' }, f => f.after.pageStates[11].value = 'lost']) {
        const f = sample(); f.after.tabs[0].muted = true; mutate(f); assert.throws(() => assertTabMenuMuted(f.before, f.after, { tabId: 11, muted: true }));
    }
});

test('duplicate proof accepts one new ordinary identity in canonical source-adjacent Today order', () => assert.equal(check(assertTabMenuDuplicated, duplicateSample()), 100));
for (const [name, mutate] of Object.entries({
    duplicateTwice: f => f.after.tabs.push({ ...f.after.tabs.at(-1), id: 101 }), sourceClosed: f => f.after.tabs = f.after.tabs.filter(tab => tab.id !== 11),
    wrongTwinDuplicated: f => f.after.tabs.at(-1).index = f.before.tabs[1].index + 1,
    duplicateInactive: f => f.after.tabs.at(-1).active = false, otherSourceActivated: f => f.after.tabs[0].active = true,
    wrongWindow: f => f.after.tabs.at(-1).windowId = 8, nativePinned: f => f.after.tabs.at(-1).pinned = true, privateTab: f => f.after.tabs.at(-1).incognito = true,
    wrongPage: f => f.after.tabs.at(-1).url = 'http://wrong', sourceMoved: f => f.after.tabs[0].windowId = 8,
    existingNativeOrderChanged: f => { f.after.tabs[0].index = 2; f.after.tabs[1].index = 0; }, otherWindowActivated: f => f.after.tabs.find(tab => tab.id === 99).active = true,
    copiedAlias: f => f.after.aliases[100] = { name: 'Copy' }, copiedBinding: f => f.after.bindings[100] = { bookmarkId: 'pin' },
    wrongTodayOrder: f => f.after.spaces[0].temporaryTabs = [11, 12, 100], lostOtherSpace: f => f.after.spaces.pop(),
    pinMembership: f => f.after.spaces[0].spaceBookmarks.push(100), wrongBridgeOwner: f => f.after.snapshot.tabs.at(-1).spaceId = 'other-space',
    bridgeMissingToday: f => f.after.snapshot.spaces[0].temporaryTabIds = [11, 12], sourceReloaded: f => f.after.pageStates[11].documentId = 'new',
    sourceBookmarkDeleted: f => f.after.bookmarks.pop()
})) test(`duplicate proof rejects ${name}`, () => { const f = duplicateSample(); mutate(f); assert.throws(() => check(assertTabMenuDuplicated, f)); });

test('Remove Pin proof retains live page and exact sibling while detaching saved membership', () => check(assertTabMenuPinRemoved, removeSample()));
for (const [name, mutate] of Object.entries({
    closedLivePage: f => f.after.tabs = f.after.tabs.filter(tab => tab.id !== 21), sourceReloaded: f => f.after.pageStates[21].documentId = 'new',
    removedTwin: f => f.after.bookmarks = f.after.bookmarks.filter(node => node.id !== 'closed'), staleSiblingIndex: f => f.after.bookmarks.find(node => node.id === 'closed').index = 1,
    staleBinding: f => f.after.bindings[21] = f.before.bindings[21], erasedOtherBinding: f => delete f.after.bindings[99],
    staleAlias: f => f.after.aliases[21] = { name: 'Old' }, stillPinned: f => f.after.spaces[0].spaceBookmarks = [21],
    missingToday: f => f.after.spaces[0].temporaryTabs = [11, 12], favoriteRemoved: f => f.after.favorites = [],
    snapshotStillSaved: f => f.after.snapshot.bookmarks.push(f.before.snapshot.bookmarks.find(node => node.id === 'pin'))
})) test(`Remove Pin proof rejects ${name}`, () => { const f = removeSample(); mutate(f); assert.throws(() => check(assertTabMenuPinRemoved, f)); });

test('fixture uses real UI transport, required screenshots, existing cleanup, no product message bypass or launch', async () => {
    const source = await readFile(new URL('../../scripts/paired-chrome-tab-menu.mjs', import.meta.url), 'utf8');
    assert.match(source, /assertTabMenuFixtureEnvironment\(\);/); assert.match(source, /finishBookmarkFixture\(/);
    assert.match(source, /screenshot\(sidebar\.page, label, true\)/); assert.match(source, /captureVisibleFailurePage/);
    assert.match(source, /page\.click\(selector, \{ button: 'right' \}\)/); assert.match(source, /replaceInputText/); assert.match(source, /input\.press\('KeyV'\)/);
    assert.doesNotMatch(source, /navigator\.clipboard\.read|overridePermissions|--no-sandbox|\.launch\(|dispatchEvent\(|\.value\s*=(?!=)|type:\s*['"]tabMenuAction['"]/);
});
