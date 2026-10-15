import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { serveOrdinaryFavoriteFixture, assertOrdinaryFavoriteState, assertOnlyNativeFavoriteClosed,
    assertOrdinaryFavoriteReopened, assertCommittedFavoriteWitness, assertSameBrowserFavoriteContinuity,
    readOrdinaryFavoriteRender, observedOwnershipFingerprint, summarizeFavoriteOwnership } from '../../scripts/paired-chrome-ordinary-favorites.mjs';

const arcifyId = 'a'.repeat(32), spotlightId = 'b'.repeat(32), nonce = 'c'.repeat(32);
const source = { id: 'source-1', parentId: 'folder-1', index: 0, title: 'Ordinary Favorite', url: `http://127.0.0.1/favorite-ordinary/${nonce}` };
const record = { id: 'saved-1', title: source.title, url: source.url, sourceBookmarkId: source.id };
const target = { favoriteId: record.id, tabId: 33, windowId: 10, url: source.url };
const ids = { arcifyId, spotlightId };
function state() {
    const live = { id: 33, windowId: 10, url: source.url, pinned: false, incognito: false, groupId: -1, index: 0, active: true, status: 'complete' };
    const other = { id: 44, windowId: 20, url: 'http://127.0.0.1/other', pinned: false, incognito: false, groupId: 8, index: 0, active: true, status: 'complete' };
    const value = { favorites: [{ ...record, tabId: 33 }], durable: [structuredClone(record)], iconCache: { entries: [{ favoriteId: record.id, faviconDataUrl: 'exact-bytes' }] },
        sources: [structuredClone(source)], tabs: [live, other],
        groupState: { syncTabGroups: true, activeSpaces: { 10: 'work', 20: 'personal' },
            spaces: [{ id: 'work', name: 'Work', color: 'blue', bookmarkFolderId: 'folder-1', spaceBookmarks: [], temporaryTabs: [] },
                { id: 'personal', name: 'Personal', color: 'red', bookmarkFolderId: 'folder-2', spaceBookmarks: [], temporaryTabs: [44] }],
            groups: [{ id: 8, windowId: 20, title: 'Personal', color: 'red', collapsed: false }] },
        session: { version: 1, bindings: [{ favoriteId: record.id, windowId: 10, tabId: 33, mode: 'ordinary' }], attempts: [] },
        snapshot: { windowId: 10, favorites: [{ ...record, tabId: 33 }], tabs: [{ ...live, spaceId: null }], activeSpaceId: 'work',
            spaces: [{ id: 'work', tabIds: [], pinnedTabIds: [], temporaryTabIds: [] }, { id: 'personal', tabIds: [], pinnedTabIds: [], temporaryTabIds: [] }] },
        render: { favoriteId: record.id, matches: 1, tabId: 33, closed: false, nativeDuplicates: [], spaceDuplicates: [] },
    };
    return witness(value);
}
function witness(value, revision = 5) {
    const journal = { version: 1, schema: 'exact-global-favorites-v2', phase: 'committed', epoch: 'browser-epoch', revision,
        peerId: spotlightId, generation: 'arcify-generation', peerGeneration: 'spotlight-generation',
        fingerprint: observedOwnershipFingerprint(value.session),
        items: value.durable.map(({ id, url, sourceBookmarkId }) => [id, url, sourceBookmarkId]), state: structuredClone(value.session) };
    value.continuity = journal;
    value.receipt = Object.fromEntries(['version', 'schema', 'epoch', 'revision', 'peerId', 'generation', 'fingerprint'].map(key => [key, journal[key]]));
    value.witness = { version: 1, peerId: arcifyId, peerGeneration: journal.peerGeneration, epoch: journal.epoch, writerGeneration: journal.generation, revision };
    return value;
}

test('independent witness evidence hashes canonical objects with the exact ownership values', () => {
    const value = state(), expected = '{"attempts":[],"bindings":[{"favoriteId":"saved-1","mode":"ordinary","tabId":33,"windowId":10}],"version":1}';
    assert.equal(observedOwnershipFingerprint(value.session), createHash('sha256').update(expected).digest('hex'));
    value.session = { attempts: [], bindings: [{ tabId: 33, mode: 'ordinary', windowId: 10, favoriteId: record.id }], version: 1 };
    assertCommittedFavoriteWitness(value, ids);
    value.continuity.schema = 'exact-global-favorites-v1';
    assert.throws(() => assertCommittedFavoriteWitness(value, ids));
});

test('worker restart evidence records exact ownership and raw/canonical fingerprints without links or icon bytes', () => {
    const value = state(); value.session.attempts.push({ favoriteId: 'pending', windowId: 10, tabId: null, mode: 'ordinary', url: source.url });
    const evidence = summarizeFavoriteOwnership(value);
    assert.deepEqual(evidence.session.keys, ['version', 'bindings', 'attempts']);
    assert.equal(evidence.session.bindings[0].tabId, 33);
    assert.equal(evidence.session.attempts[0].tabId, null);
    assert.equal(evidence.session.rawFingerprint, createHash('sha256').update(JSON.stringify(value.session)).digest('hex'));
    assert.equal(evidence.session.canonicalFingerprint, observedOwnershipFingerprint(value.session));
    assert.notEqual(evidence.session.rawFingerprint, evidence.session.canonicalFingerprint);
    assert(!JSON.stringify(evidence).includes(source.url)); assert(!JSON.stringify(evidence).includes('exact-bytes'));
    assert.equal(evidence.receipt.fingerprint, value.receipt.fingerprint);
    assert.equal(evidence.mirror.revision, value.continuity.revision);
});
function closedState(before = state()) {
    const value = structuredClone(before);
    value.tabs = value.tabs.filter(tab => tab.id !== 33);
    value.favorites[0].tabId = null;
    value.session.bindings = [];
    value.removed = [{ tabId: 33, windowId: 10, isWindowClosing: false }];
    value.destroyedPageTargets = ['target-33'];
    value.rawTargets = [{ type: 'page', targetId: 'target-44' }];
    return value;
}
function reopenedState() {
    const value = state();
    value.tabs[0].id = 55; value.favorites[0].tabId = 55;
    value.snapshot.favorites[0].tabId = 55; value.snapshot.tabs[0].id = 55;
    value.session.bindings[0].tabId = 55; value.render.tabId = 55;
    return witness(value);
}

test('localhost nonce route supplies the exact real document title and deterministic icon', () => {
    const calls = [];
    const response = { writeHead: (...args) => calls.push(args), end: text => calls.push(text) };
    assert.equal(serveOrdinaryFavoriteFixture({ url: `/favorite-ordinary/${nonce}` }, response), true);
    assert.match(calls[1], new RegExp(`<title>Ordinary Favorite ${nonce}</title>`));
    assert.match(calls[1], /href="\/favorite-retained-icon.png"/);
    assert.equal(calls[0][1]['Cache-Control'], 'no-store');
    for (const path of ['/other', '/favorite-ordinary/short', `/favorite-ordinary/${nonce}<script>`]) {
        assert.equal(serveOrdinaryFavoriteFixture({ url: path }, response), false);
    }
    assert.equal(calls.length, 2);
});
test('ordinary Favorite proof requires exact saved/native/session/snapshot/render identity', () => {
    assert.equal(assertOrdinaryFavoriteState(state(), { ...target, activeSpaceId: 'work', active: true }).id, 33);
});
for (const [label, mutate] of [
    ['native pin', value => { value.tabs[0].pinned = true; }],
    ['wrong native window', value => { value.tabs[0].windowId = 20; }],
    ['group ownership', value => { value.tabs[0].groupId = 7; }],
    ['duplicate URL', value => { value.tabs.push({ ...value.tabs[0], id: 999 }); }],
    ['Space membership', value => { value.snapshot.spaces[1].temporaryTabIds.push(33); }],
    ['Space owner', value => { value.snapshot.tabs[0].spaceId = 'work'; }],
    ['legacy binding mode', value => { delete value.session.bindings[0].mode; }],
    ['wrong binding', value => { value.session.bindings[0].tabId = 999; }],
    ['pending open receipt', value => { value.session.attempts.push({ favoriteId: record.id, windowId: 10, tabId: 33 }); }],
    ['native duplicate rendering', value => { value.render.nativeDuplicates.push(33); }],
    ['Space duplicate rendering', value => { value.render.spaceDuplicates.push(33); }],
    ['duplicate saved row', value => { value.render.matches = 2; }],
    ['different selected Space', value => { value.snapshot.activeSpaceId = 'personal'; }],
]) {
    test(`ordinary proof rejects ${label}`, () => {
        const value = state(); mutate(value);
        assert.throws(() => assertOrdinaryFavoriteState(value, { ...target, activeSpaceId: 'work', active: true }));
    });
}
test('native closure requires both actual removal and raw destruction while saved data stays exact', () => {
    const before = state(), after = closedState(before);
    assert.doesNotThrow(() => assertOnlyNativeFavoriteClosed(before, after, { ...target, targetId: 'target-33' }));
});
for (const [label, mutate] of [
    ['wrong removed tab', value => { value.removed[0].tabId = 44; }],
    ['extra removal event', value => { value.removed.push({ tabId: 999, windowId: 10, isWindowClosing: false }); }],
    ['closing whole window', value => { value.removed[0].isWindowClosing = true; }],
    ['unrelated raw page destruction', value => { value.destroyedPageTargets.push('target-44'); }],
    ['target still exists', value => { value.rawTargets.push({ type: 'page', targetId: 'target-33' }); }],
    ['another tab also closed', value => { value.tabs = []; }],
    ['another tab changed', value => { value.tabs[0].url += '-changed'; }],
    ['saved binding retained', value => { value.session.bindings.push({ favoriteId: record.id, windowId: 10, tabId: 33 }); }],
    ['source modified', value => { value.sources[0].parentId = 'other-folder'; }],
    ['icon bytes changed', value => { value.iconCache.entries[0].faviconDataUrl = 'other-bytes'; }],
    ['saved ID changed', value => { value.durable[0].id = 'different'; }],
]) {
    test(`native closure proof rejects ${label}`, () => {
        const before = state(), after = closedState(before); mutate(after);
        assert.throws(() => assertOnlyNativeFavoriteClosed(before, after, { ...target, targetId: 'target-33' }));
    });
}
test('one real reopen requires one new unpinned exact tab and retains every source/icon/other tab', () => {
    assert.equal(assertOrdinaryFavoriteReopened(closedState(), reopenedState(), { favoriteId: record.id, previousTabId: 33, windowId: 10, url: source.url }).id, 55);
    for (const mutate of [value => { value.tabs.push({ ...value.tabs[0], id: 77 }); }, value => { value.tabs[0].pinned = true; }, value => { value.sources[0].url += '?changed'; }]) {
        const after = reopenedState(); mutate(after);
        assert.throws(() => assertOrdinaryFavoriteReopened(closedState(), after, { favoriteId: record.id, previousTabId: 33, windowId: 10, url: source.url }));
    }
});
test('reload witness proof matches peer, epoch, revision, fingerprint, full exact session and saved identities', () => {
    assert.equal(assertCommittedFavoriteWitness(state(), ids).revision, 5);
});
for (const [label, mutate] of [
    ['invalid journal phase', value => { value.continuity.phase = 'invalid'; }],
    ['missing peer witness', value => { value.witness = null; }],
    ['different witness revision', value => { value.witness.revision++; }],
    ['different witness epoch', value => { value.witness.epoch = 'fresh-browser'; }],
    ['different writer generation', value => { value.witness.writerGeneration = 'different'; }],
    ['different peer generation', value => { value.witness.peerGeneration = 'different'; }],
    ['different paired extension', value => { value.witness.peerId = 'c'.repeat(32); }],
    ['session fingerprint mismatch', value => { value.session.bindings[0].tabId = 99; }],
    ['uncommitted own receipt', value => { value.receipt.phase = 'recovering'; }],
    ['different source provenance', value => { value.continuity.items[0][2] = 'another-bookmark'; }],
]) {
    test(`witness proof rejects ${label}`, () => {
        const value = state(); mutate(value); assert.throws(() => assertCommittedFavoriteWitness(value, ids));
    });
}
test('same-browser reload preserves exact state and native IDs with an advancing committed receipt', () => {
    const before = state(), after = witness(state(), 6);
    assert.doesNotThrow(() => assertSameBrowserFavoriteContinuity(before, after, ids));
    assert.throws(() => assertSameBrowserFavoriteContinuity(before, state(), ids));
    assert.doesNotThrow(() => assertSameBrowserFavoriteContinuity(before, state(), ids, { requireNewRevision: false }));
    const fresh = witness(state(), 6); fresh.continuity.epoch = fresh.receipt.epoch = fresh.witness.epoch = 'new-browser-epoch';
    assert.throws(() => assertSameBrowserFavoriteContinuity(before, fresh, ids), /session epoch/);
    const duplicate = witness(state(), 6); duplicate.tabs.push({ ...duplicate.tabs[0], id: 99 });
    assert.throws(() => assertSameBrowserFavoriteContinuity(before, duplicate, ids), /existing web tabs/);
});
test('render reader stays read-only and distinguishes closed from duplicate/native/Space projections', () => {
    const saved = { dataset: { favoriteId: record.id, tabId: '33' }, classList: { contains: () => false } };
    const old = globalThis.document;
    try {
        globalThis.document = { querySelectorAll: selector => selector.endsWith('.saved-favorite') ? [saved] : [] };
        assert.deepEqual(readOrdinaryFavoriteRender(record.id), { favoriteId: record.id, matches: 1, tabId: 33, closed: false, nativeDuplicates: [], spaceDuplicates: [] });
        delete saved.dataset.tabId; saved.classList.contains = () => true;
        assert.equal(readOrdinaryFavoriteRender(record.id).closed, true);
        assert.equal(readOrdinaryFavoriteRender(record.id).tabId, null);
    } finally { if (old === undefined) delete globalThis.document; else globalThis.document = old; }
});

function groupedReloadState() {
    const value = state();
    // Equal URLs intentionally cannot identify a Space, group or tab.
    const page = (id, windowId, index, groupId) => ({ id, windowId, index, groupId,
        url: 'https://same.test/', pinned: false, incognito: false });
    value.tabs.push(page(41, 10, 1, 80), page(42, 10, 2, 80), page(43, 10, 3, 81), page(45, 20, 1, 8));
    value.tabs.find(tab => tab.id === 44).url = 'https://same.test/';
    value.groupState.spaces[0].spaceBookmarks = [41]; value.groupState.spaces[0].temporaryTabs = [42];
    value.groupState.spaces[1].temporaryTabs = [43, 44, 45];
    value.groupState.groups.push({ id: 80, windowId: 10, title: 'Work', color: 'blue', collapsed: false },
        { id: 81, windowId: 10, title: 'Personal', color: 'red', collapsed: true });
    value.snapshot.spaces[0].tabIds = [41, 42]; value.snapshot.spaces[0].pinnedTabIds = [41]; value.snapshot.spaces[0].temporaryTabIds = [42];
    value.snapshot.spaces[1].tabIds = [43]; value.snapshot.spaces[1].temporaryTabIds = [43];
    value.snapshot.tabs.push(...value.tabs.filter(tab => tab.windowId === 10 && tab.groupId !== -1)
        .map(tab => ({ ...tab, spaceId: tab.groupId === 80 ? 'work' : 'personal' })));
    return value;
}
function renumberGroups(value) {
    for (const group of value.groupState.groups) {
        const oldId = group.id; group.id += 1000;
        for (const tab of value.tabs) if (tab.groupId === oldId) tab.groupId = group.id;
    }
    return witness(value, 6);
}

test('same-browser reload allows only numeric projection renumbering with exact all-window semantic groups', () => {
    const before = groupedReloadState(), after = renumberGroups(structuredClone(before));
    // API enumeration and absolute group indices are not ordering contracts.
    after.tabs.reverse(); after.groupState.groups.reverse();
    for (const tab of after.tabs) tab.index += 2;
    assert.doesNotThrow(() => assertSameBrowserFavoriteContinuity(before, after, ids));
});
for (const [label, mutate] of [
    ['merged groups', value => { value.tabs.find(tab => tab.id === 43).groupId = 1080; value.groupState.groups = value.groupState.groups.filter(group => group.id !== 1081); }],
    ['split group', value => { value.tabs.find(tab => tab.id === 42).groupId = 2000; value.groupState.groups.push({ ...value.groupState.groups.find(group => group.id === 1080), id: 2000 }); }],
    ['cross-window group', value => { value.groupState.groups.find(group => group.id === 1080).windowId = 20; }],
    ['wrong Space membership', value => { value.groupState.spaces[0].temporaryTabs = [43]; value.groupState.spaces[1].temporaryTabs[0] = 42; }],
    ['changed logical section', value => { value.groupState.spaces[0].spaceBookmarks = []; value.groupState.spaces[0].temporaryTabs = [41, 42]; }],
    ['changed logical order', value => { value.groupState.spaces.reverse(); }],
    ['changed logical title', value => { value.groupState.spaces[0].name += ' changed'; }],
    ['changed native title', value => { value.groupState.groups[0].title += ' changed'; }],
    ['changed native color', value => { value.groupState.groups[0].color = 'green'; }],
    ['changed native collapse', value => { value.groupState.groups[0].collapsed = true; }],
    ['lost active Space map', value => { value.groupState.activeSpaces = {}; }],
    ['changed snapshot active Space', value => { value.snapshot.activeSpaceId = 'personal'; }],
    ['changed snapshot membership', value => { value.snapshot.spaces[1].temporaryTabIds.push(41); }],
    ['changed published Space owner', value => { value.snapshot.tabs.find(tab => tab.id === 41).spaceId = 'personal'; }],
    ['global Favorite grouping', value => { value.tabs.find(tab => tab.id === 33).groupId = 1080; }],
    ['global Favorite Space ownership', value => { value.groupState.spaces[0].temporaryTabs.push(33); }],
    ['dropped native member', value => { value.tabs.find(tab => tab.id === 41).groupId = -1; }],
    ['native member reorder', value => { value.tabs.find(tab => tab.id === 41).index = 2; value.tabs.find(tab => tab.id === 42).index = 1; }],
    ['native group reorder', value => { value.tabs.find(tab => tab.id === 43).index = 1; value.tabs.find(tab => tab.id === 41).index = 2; value.tabs.find(tab => tab.id === 42).index = 3; }],
    ['missing group observation', value => { value.groupState.groups.pop(); }],
    ['missing logical observations', value => { delete value.groupState; }],
    ['web tab replacement', value => { value.tabs.find(tab => tab.id === 41).id = 99; }],
    ['web tab close', value => { value.tabs = value.tabs.filter(tab => tab.id !== 41); }],
    ['web tab duplicate', value => { value.tabs.push({ ...value.tabs[0], id: 99 }); }],
    ['web tab navigation', value => { value.tabs.find(tab => tab.id === 41).url += '?changed'; }],
    ['web tab window move', value => { value.tabs.find(tab => tab.id === 41).windowId = 20; }],
    ['web tab pin', value => { value.tabs.find(tab => tab.id === 41).pinned = true; }],
    ['web tab private change', value => { value.tabs.find(tab => tab.id === 41).incognito = true; }],
]) {
    test(`reload semantic continuity rejects ${label}`, () => {
        const before = groupedReloadState(), after = renumberGroups(structuredClone(before)); mutate(after);
        assert.throws(() => assertSameBrowserFavoriteContinuity(before, after, ids));
    });
}
test('disabled sync preserves native group IDs and metadata rather than allowing unowned renumbering', () => {
    const before = groupedReloadState(); before.groupState.syncTabGroups = false;
    assert.doesNotThrow(() => assertSameBrowserFavoriteContinuity(before, witness(structuredClone(before), 6), ids));
    assert.throws(() => assertSameBrowserFavoriteContinuity(before, renumberGroups(structuredClone(before)), ids));
});
test('unrelated native groups retain exact IDs even while Space sync is enabled', () => {
    const before = groupedReloadState();
    before.tabs.push({ id: 60, windowId: 30, index: 0, url: 'about:blank', groupId: 90, pinned: false, incognito: false });
    before.groupState.groups.push({ id: 90, windowId: 30, title: 'Unowned', color: 'grey', collapsed: false });
    assert.doesNotThrow(() => assertSameBrowserFavoriteContinuity(before, witness(structuredClone(before), 6), ids));
    const after = witness(structuredClone(before), 6);
    after.tabs.find(tab => tab.id === 60).groupId = 91; after.groupState.groups.find(group => group.id === 90).id = 91;
    assert.throws(() => assertSameBrowserFavoriteContinuity(before, after, ids));
});
test('reload validator rejects preexisting incorrect collapse relative to the active Space', () => {
    const before = groupedReloadState(); before.groupState.groups.find(group => group.id === 80).collapsed = true;
    assert.throws(() => assertSameBrowserFavoriteContinuity(before, renumberGroups(structuredClone(before)), ids), /collapse/);
});

test('reload evidence persists raw before and after observations before semantic assertions', () => {
    const source = readFileSync(new URL('../../scripts/paired-chrome-ordinary-favorites.mjs', import.meta.url), 'utf8');
    const reloadLoop = source.slice(source.indexOf("for (const [name, reload] of"));
    assert(reloadLoop.indexOf('evidence.reloads.push(reloadEvidence)') < reloadLoop.indexOf('const lifecycle = await reload()'));
    assert(reloadLoop.indexOf("await checkpoint('before-same-browser-reload'") < reloadLoop.indexOf('const lifecycle = await reload()'));
    assert(reloadLoop.indexOf('reloadEvidence.after = value') < reloadLoop.indexOf("await checkpoint('observed-same-browser-reload'"));
    assert(reloadLoop.indexOf("await checkpoint('observed-same-browser-reload'") < reloadLoop.indexOf('assertSameBrowserFavoriteContinuity(before, after'));
});

test('known-ID pending Favorite receipts remain global and explicitly ungrouped during reload', () => {
    const before = groupedReloadState();
    before.tabs.push({ id: 61, windowId: 30, index: 0, url: 'https://pending.test/', groupId: -1, pinned: false, incognito: false });
    before.session.attempts.push({ favoriteId: 'pending', tabId: 61, windowId: 30, mode: 'ordinary', kind: 'create' });
    before.session.attempts.push({ favoriteId: 'unknown', tabId: null, windowId: 30, mode: 'ordinary', kind: 'create' });
    witness(before);
    assert.doesNotThrow(() => assertSameBrowserFavoriteContinuity(before, renumberGroups(structuredClone(before)), ids));
    const after = renumberGroups(structuredClone(before)); after.tabs.find(tab => tab.id === 61).groupId = 1080;
    assert.throws(() => assertSameBrowserFavoriteContinuity(before, after, ids), /explicitly ungrouped/);
});
