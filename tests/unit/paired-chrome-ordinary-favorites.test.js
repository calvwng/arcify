import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { serveOrdinaryFavoriteFixture, assertOrdinaryFavoriteState, assertOnlyNativeFavoriteClosed,
    assertOrdinaryFavoriteReopened, assertCommittedFavoriteWitness, assertSameBrowserFavoriteContinuity,
    readOrdinaryFavoriteRender } from '../../scripts/paired-chrome-ordinary-favorites.mjs';

const arcifyId = 'a'.repeat(32), spotlightId = 'b'.repeat(32), nonce = 'c'.repeat(32);
const source = { id: 'source-1', parentId: 'folder-1', index: 0, title: 'Ordinary Favorite', url: `http://127.0.0.1/favorite-ordinary/${nonce}` };
const record = { id: 'saved-1', title: source.title, url: source.url, sourceBookmarkId: source.id };
const target = { favoriteId: record.id, tabId: 33, windowId: 10, url: source.url };
const ids = { arcifyId, spotlightId };
function state() {
    const live = { id: 33, windowId: 10, url: source.url, pinned: false, incognito: false, groupId: -1, active: true, status: 'complete' };
    const other = { id: 44, windowId: 20, url: 'http://127.0.0.1/other', pinned: false, incognito: false, groupId: 8, active: true, status: 'complete' };
    const value = { favorites: [{ ...record, tabId: 33 }], durable: [structuredClone(record)], iconCache: { entries: [{ favoriteId: record.id, faviconDataUrl: 'exact-bytes' }] },
        sources: [structuredClone(source)], tabs: [live, other],
        session: { version: 1, bindings: [{ favoriteId: record.id, windowId: 10, tabId: 33, mode: 'ordinary' }], attempts: [] },
        snapshot: { favorites: [{ ...record, tabId: 33 }], tabs: [{ ...live, spaceId: null }], activeSpaceId: 'work',
            spaces: [{ id: 'work', tabIds: [], pinnedTabIds: [], temporaryTabIds: [] }, { id: 'personal', tabIds: [], pinnedTabIds: [], temporaryTabIds: [] }] },
        render: { favoriteId: record.id, matches: 1, tabId: 33, closed: false, nativeDuplicates: [], spaceDuplicates: [] },
    };
    return witness(value);
}
function witness(value, revision = 5) {
    const journal = { version: 1, schema: 'exact-global-favorites-v1', phase: 'committed', epoch: 'browser-epoch', revision,
        peerId: spotlightId, generation: 'arcify-generation', peerGeneration: 'spotlight-generation',
        fingerprint: createHash('sha256').update(JSON.stringify(value.session)).digest('hex'),
        items: value.durable.map(({ id, url, sourceBookmarkId }) => [id, url, sourceBookmarkId]), state: structuredClone(value.session) };
    value.continuity = journal;
    value.receipt = Object.fromEntries(['version', 'schema', 'epoch', 'revision', 'peerId', 'generation', 'fingerprint'].map(key => [key, journal[key]]));
    value.witness = { version: 1, peerId: arcifyId, peerGeneration: journal.peerGeneration, epoch: journal.epoch, writerGeneration: journal.generation, revision };
    return value;
}
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
