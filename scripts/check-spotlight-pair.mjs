#!/usr/bin/env node
/**
 * Mocked cross-repository protocol smoke test; does not launch or automate Chrome.
 * Run from the Arcify checkout: node scripts/check-spotlight-pair.mjs ../arcify-spotlight
 */
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SpaceStore, ownerOf } from '../space-store.js';
import { FavoriteStore } from '../favorite-store.js';
import { createSpotlightBridge, getBridgeSnapshot } from '../spotlight-bridge.js';
import { BRIDGE_TYPE, BRIDGE_VERSION, PEER_KEY } from '../spotlight-bridge-protocol.js';
import * as arcifyProtocol from '../spotlight-bridge-protocol.js';
import { assertCommonV1Contract, assertInitialSpaceActionsContract } from './lib/spotlight-pair-contract.mjs';
import { assertInitialSpaceActionRoundTrips } from './lib/spotlight-pair-actions.mjs';
import { assertExtendedActionsContract } from './lib/spotlight-pair-extended-contract.mjs';
import { assertSplitActionsContract } from './lib/spotlight-pair-split-contract.mjs';
import { assertArchiveActionsContract } from './lib/spotlight-pair-archive-contract.mjs';
import { assertArchiveActionRoundTrips } from './lib/spotlight-pair-archive-actions.mjs';
import { assertExtendedActionRoundTrips } from './lib/spotlight-pair-extended-actions.mjs';

if (process.argv.length !== 3) {
    console.error('Usage: node scripts/check-spotlight-pair.mjs <spotlight-checkout>');
    process.exit(1);
}
const spotlightRoot = resolve(process.argv[2]);
const peerModule = path => import(pathToFileURL(resolve(spotlightRoot, path)).href);
const spotlightProtocol = await peerModule('shared/arcify-bridge-protocol.js');
const spotlightActions = await peerModule('shared/arcify-space-actions-protocol.js');
await assertCommonV1Contract(arcifyProtocol, spotlightProtocol);
assertInitialSpaceActionsContract(arcifyProtocol, spotlightActions);
const spotlightTabActions = await peerModule('shared/arcify-tab-actions-protocol.js');
assertExtendedActionsContract(arcifyProtocol, spotlightActions, spotlightTabActions);
const spotlightArchive = await peerModule('shared/arcify-archive-actions-protocol.js');
assertArchiveActionsContract(arcifyProtocol, spotlightArchive);
const spotlightSplit = await peerModule('shared/arcify-split-actions-protocol.js');
assertSplitActionsContract(arcifyProtocol, spotlightSplit);

const ARCIFY = 'a'.repeat(32);
const SPOTLIGHT = 'b'.repeat(32);
const WINDOW = 7;
const clone = value => structuredClone(value);
const area = data => ({
    async get(keys) {
        const names = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys || data);
        return Object.fromEntries(names.map(key => [key, clone(data[key] ?? keys?.[key])]));
    },
    async set(values) { Object.assign(data, clone(values)); }
});
const local = {
    [PEER_KEY]: SPOTLIGHT, spaceModelVersion: 2,
    spaces: [
        { id: 'work', spaceUuid: 'work', name: 'Work', color: 'blue', bookmarkFolderId: 'work-folder', spaceBookmarks: [], temporaryTabs: [1, 11] },
        { id: 'empty', spaceUuid: 'empty', name: 'Empty', color: 'grey', bookmarkFolderId: 'empty-folder', spaceBookmarks: [], temporaryTabs: [] }
    ]
};
const session = { spaceSession: true, activeSpaces: { [WINDOW]: 'work', 8: 'work' } };
const tabs = [
    { id: 1, windowId: WINDOW, index: 0, title: 'Current tab', url: 'https://example.test/', active: true },
    { id: 11, windowId: 8, index: 0, title: 'Other window', url: 'https://example.test/', active: true }
];
const bookmarks = [
    { id: 'root', title: 'Arcify' },
    { id: 'work-folder', parentId: 'root', title: 'Work' },
    { id: 'empty-folder', parentId: 'root', title: 'Empty' },
    { id: 'favorite-1', parentId: 'work-folder', title: 'First saved identity', url: 'https://same.test/' },
    { id: 'favorite-2', parentId: 'work-folder', title: 'Second saved identity', url: 'https://same.test/' }
];
const sent = [];
let created = 0;
let returnWrongVersion = false;
let handle;
const sender = { id: SPOTLIGHT, url: `chrome-extension://${SPOTLIGHT}/background.js`, origin: `chrome-extension://${SPOTLIGHT}` };
const previousChrome = globalThis.chrome;
globalThis.chrome = {
    runtime: {
        id: ARCIFY,
        getURL: path => `chrome-extension://${ARCIFY}/${path}`,
        // Spotlight's actual sendBridgeRequest calls this mocked transport. All
        // provider-side Chrome APIs below belong to the Arcify endpoint.
        sendMessage(peerId, message, callback) {
            assert.equal(peerId, ARCIFY);
            sent.push(clone(message));
            handle(clone(message), sender).then(response => callback(returnWrongVersion
                ? { ...response, version: BRIDGE_VERSION + 1 } : clone(response)));
        }
    },
    storage: { local: area(local), session: area(session), sync: area({}) },
    windows: {
        async get(id) { assert([WINDOW, 8].includes(id)); return { id, type: 'normal' }; },
        async update(id, values) { assert.equal(id, WINDOW); return { id, ...values }; }
    },
    tabs: {
        async query(query) { return clone(tabs.filter(tab => Object.entries(query).every(([key, value]) => tab[key] === value))); },
        async get(id) { const tab = tabs.find(tab => tab.id === id); assert(tab); return clone(tab); },
        async create(options) {
            created++;
            const tab = { id: 100 + created, index: tabs.length, title: '', ...options };
            tabs.push(tab);
            return clone(tab);
        },
        async update(id, values) {
            const tab = tabs.find(tab => tab.id === id); assert(tab);
            if (values.active) for (const other of tabs) if (other.windowId === tab.windowId) other.active = false;
            return clone(Object.assign(tab, values));
        }
    },
    bookmarks: {
        async search(query) { return clone(bookmarks.filter(node => node.title === query.title)); },
        async get(id) { return clone(bookmarks.filter(node => node.id === id)); },
        async getChildren(id) { return clone(bookmarks.filter(node => node.parentId === id)); }
    }
};
try {
    const { ArcifyBridgeClient, validateSnapshot } = await import(pathToFileURL(resolve(spotlightRoot, 'shared/arcify-bridge.js')).href);
    const store = new SpaceStore();
    handle = createSpotlightBridge(store);
    const client = new ArcifyBridgeClient({ runtime: { id: SPOTLIGHT }, storage: { local: area({ [PEER_KEY]: ARCIFY }) } }, 1000);

    // Exercise the actual provider snapshot and strict consumer validator directly.
    const initial = validateSnapshot(await getBridgeSnapshot(store, WINDOW), WINDOW);
    assert.deepEqual(initial.spaces.map(space => space.id), ['work', 'empty']);
    assert.deepEqual(initial.tabs.map(tab => tab.id), [1]);
    assert.deepEqual(initial.bookmarks.map(bookmark => bookmark.id), ['favorite-1', 'favorite-2']);
    assert.deepEqual(initial.spaces[1].tabIds, []);

    // Exercise actual consumer -> shared transport -> provider -> consumer paths.
    const hello = await client.request('hello', WINDOW);
    assert.equal(hello.extensionId, ARCIFY);
    assert.equal(hello.role, 'arcify');
    assert.equal(hello.capabilities?.includes('persistentFavorites'), false, 'The pre-capability peer remains supported.');
    assert.equal(hello.snapshot.favorites, undefined);
    assert.equal((await client.snapshot(WINDOW)).activeSpaceId, 'work');
    const opened = await client.request('openTab', WINDOW, { spaceId: 'empty', url: 'https://opened.test/' });
    assert.equal(created, 1);
    assert.equal(ownerOf(store.spaces, opened.tabId).id, 'empty');
    assert.equal(opened.snapshot.activeSpaceId, 'empty');
    assert.equal(opened.snapshot.tabs.find(tab => tab.id === opened.tabId).windowId, WINDOW);
    assert.equal(session.activeSpaces[8], 'work');
    assert.deepEqual(sent.map(message => message.command), ['hello', 'hello', 'hello', 'openTab']);
    assert(sent.every(message => message.type === BRIDGE_TYPE && message.version === BRIDGE_VERSION));

    // An inaccessible folder must not break the consumer's live-tab snapshot.
    bookmarks.splice(bookmarks.findIndex(node => node.id === 'empty-folder'), 1);
    const degraded = await client.snapshot(WINDOW);
    assert.deepEqual(degraded.warnings.map(warning => [warning.code, warning.spaceId]), [['BOOKMARKS_UNAVAILABLE', 'empty']]);
    assert.equal(degraded.tabs.find(tab => tab.id === opened.tabId).spaceId, 'empty');

    const rejected = await handle({ ...sent[0], version: BRIDGE_VERSION + 1 }, sender);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, 'VERSION_MISMATCH');
    returnWrongVersion = true;
    await assert.rejects(client.request('hello', WINDOW), { code: 'VERSION_MISMATCH' });
    assert.equal(created, 1, 'Version mismatch must not retry the mutation.');

    // Activate the real optional store only after all original legacy-v1 smoke
    // assertions, keeping both compatibility paths exercised in the same run.
    returnWrongVersion = false;
    const favoriteStore = new FavoriteStore(store);
    const originalBookmarks = clone(bookmarks);
    await store.dispatch({ action: 'activate', windowId: WINDOW, spaceId: 'work' });
    const addFavorite = bookmarkId => favoriteStore.dispatch({ type: 'favoriteStore', action: 'addBookmark',
        windowId: WINDOW, spaceId: 'work', bookmarkFolderId: 'work-folder', bookmarkId, parentId: 'work-folder' });
    const firstSaved = await addFavorite('favorite-1');
    const secondSaved = await addFavorite('favorite-2');
    const firstId = firstSaved.favorites.find(favorite => favorite.sourceBookmarkId === 'favorite-1').id;
    const secondId = secondSaved.favorites.find(favorite => favorite.sourceBookmarkId === 'favorite-2').id;
    assert.notEqual(firstId, secondId, 'Equal source URLs never collapse saved identities.');
    for (const tabId of [firstSaved.tab.id, secondSaved.tab.id]) tabs.splice(tabs.findIndex(tab => tab.id === tabId), 1);
    const createsBeforeOpen = created;

    const favoriteHello = await client.request('hello', WINDOW);
    assert(favoriteHello.capabilities.includes('persistentFavorites'));
    assert.deepEqual(favoriteHello.snapshot.favorites.map(favorite => [favorite.id, favorite.sourceBookmarkId, favorite.tabId]),
        [[firstId, 'favorite-1', null], [secondId, 'favorite-2', null]]);
    const beforeSnapshot = sent.length;
    const closedFavorites = await client.snapshot(WINDOW);
    assert.deepEqual(sent.slice(beforeSnapshot).map(message => message.command), ['hello'],
        "Optional Favorites data uses Spotlight's authenticated capability check.");
    assert.deepEqual(closedFavorites.favorites, favoriteHello.snapshot.favorites);
    assert.equal(created, createsBeforeOpen, 'Reading closed Favorites must never restore tabs.');

    const favoriteOpened = await client.request('openFavorite', WINDOW, { favoriteId: secondId });
    assert.equal(created, createsBeforeOpen + 1);
    assert.equal(favoriteOpened.snapshot.favorites.find(favorite => favorite.id === secondId).tabId, favoriteOpened.tabId);
    assert.equal(favoriteOpened.snapshot.favorites.find(favorite => favorite.id === firstId).tabId, null);
    assert.equal(ownerOf(store.spaces, favoriteOpened.tabId), undefined, 'Global Favorite stays outside Spaces.');
    const openedFavoriteTab = favoriteOpened.snapshot.tabs.find(tab => tab.id === favoriteOpened.tabId);
    assert.equal(openedFavoriteTab.pinned, true); assert.equal(openedFavoriteTab.windowId, WINDOW);
    assert.equal(openedFavoriteTab.url, 'https://same.test/');
    const nativeTab = tabs.find(tab => tab.id === favoriteOpened.tabId);
    nativeTab.url = 'https://navigated-favorite.test/'; nativeTab.title = 'Navigated elsewhere';
    const reusedFavorite = await client.request('openFavorite', WINDOW, { favoriteId: secondId });
    assert.equal(reusedFavorite.tabId, favoriteOpened.tabId);
    assert.equal(created, createsBeforeOpen + 1, 'Repeated opens reuse only the exact current-window instance.');
    assert.equal(reusedFavorite.snapshot.tabs.find(tab => tab.id === favoriteOpened.tabId).url, nativeTab.url);
    assert.equal(reusedFavorite.snapshot.favorites.find(favorite => favorite.id === secondId).url, 'https://same.test/',
        'Live navigation cannot overwrite the saved URL.');
    const otherWindowFavorites = await client.snapshot(8);
    assert.deepEqual(otherWindowFavorites.favorites.map(favorite => [favorite.id, favorite.tabId]), [[firstId, null], [secondId, null]]);
    assert.deepEqual(bookmarks, originalBookmarks, 'Favorite operations never modify original source bookmarks.');
    assert(sent.slice(beforeSnapshot).filter(message => message.command === 'openFavorite').every(message =>
        message.favoriteId === secondId && message.windowId === WINDOW && !Object.hasOwn(message, 'url')));
    const exactOpenRequest = sent.find(message => message.command === 'openFavorite');
    const replayedFavorite = await handle(clone(exactOpenRequest), sender);
    assert.equal(replayedFavorite.ok, true);
    assert.equal(replayedFavorite.tabId, favoriteOpened.tabId);
    validateSnapshot(replayedFavorite.snapshot, WINDOW);
    assert.equal(created, createsBeforeOpen + 1, 'Journal replay preserves the exact opened Favorite without creating a duplicate.');

    // A native tab event can occur between FavoriteStore's read and the later
    // bridge tab sample despite the shared worker queue. Exercise real producer
    // snapshots through the actual client's strict validator, without retries.
    const baselineTabs = clone(tabs), baselineState = clone(favoriteStore.state);
    const baselineSession = clone(session.favoriteSession);
    const readFavorites = favoriteStore.read;
    try {
        for (const [label, ordinary, initialPinned, change, retained, adopting = false] of [
            ['pinned closes', false, true, tab => tabs.splice(tabs.indexOf(tab), 1), false],
            ['pinned moves', false, true, tab => { tab.windowId = 8; }, false],
            ['pinned unpins', false, true, tab => { tab.pinned = false; }, false],
            ['pinned unpins with retained adoption receipt', false, true, tab => { tab.pinned = false; }, false, true],
            ['pinned navigates', false, true, tab => { tab.url = 'https://different.test/'; }, true],
            ['ordinary closes', true, false, tab => tabs.splice(tabs.indexOf(tab), 1), false],
            ['ordinary moves', true, false, tab => { tab.windowId = 8; }, false],
            ['ordinary stays unpinned', true, false, () => {}, true],
            ['ordinary repins', true, false, tab => { tab.pinned = true; }, true],
            ['ordinary unpins', true, true, tab => { tab.pinned = false; }, true]
        ]) {
            tabs.splice(0, tabs.length, ...clone(baselineTabs));
            const native = tabs.find(tab => tab.id === favoriteOpened.tabId);
            native.pinned = initialPinned;
            tabs.push({ ...clone(native), id: 999, pinned: true, title: 'Unrelated same-URL pin' });
            favoriteStore.state = clone(baselineState);
            const binding = favoriteStore.state.bindings.find(entry => entry.favoriteId === secondId);
            if (ordinary) binding.mode = 'ordinary';
            if (adopting) favoriteStore.state.attempts.push({ ...binding, url: native.url, kind: 'adopt' });
            session.favoriteSession = clone(favoriteStore.state);
            const ownership = clone(favoriteStore.state), saved = clone(local.persistentFavorites);
            const sentBefore = sent.length, createdBefore = created;
            let reads = 0;
            favoriteStore.read = async function(windowId) {
                const result = await readFavorites.call(this, windowId);
                assert.equal(result.favorites.find(favorite => favorite.id === secondId).tabId, native.id, label);
                reads++;
                change(native);
                return result;
            };
            const projected = await client.snapshot(WINDOW);
            assert.equal(validateSnapshot(projected, WINDOW, { allowOrdinaryFavorites: ordinary }), projected, label);
            assert.equal(projected.favorites.find(favorite => favorite.id === secondId).tabId, retained ? native.id : null, label);
            assert(projected.tabs.some(tab => tab.id === 999), 'Same-URL twin stays independent');
            assert.equal(reads, 1, 'No snapshot retries');
            assert.deepEqual(sent.slice(sentBefore).map(message => message.command), ['hello'], 'No mutation request or retry');
            assert.equal(created, createdBefore, 'No replacement page is opened');
            assert.deepEqual(favoriteStore.state, ownership, 'Snapshot projection leaves session ownership alone');
            assert.deepEqual(session.favoriteSession, ownership, 'Persisted ownership is not rewritten');
            assert.deepEqual(local.persistentFavorites, saved, 'Saved identity and metadata remain exact');
            assert.deepEqual(bookmarks, originalBookmarks, 'Source bookmarks remain untouched');
        }
    } finally {
        favoriteStore.read = readFavorites;
        favoriteStore.state = baselineState;
        session.favoriteSession = baselineSession;
        tabs.splice(0, tabs.length, ...baselineTabs);
    }

    // Keep every original legacy/Favorite assertion above intact. The optional
    // action adapter uses a fresh Chrome mock and restores this one afterward.
    const { ArcifySpaceActionsClient } = await peerModule('shared/arcify-space-actions.js');
    await assertInitialSpaceActionRoundTrips({ ArcifyBridgeClient, ArcifySpaceActionsClient,
        validateActionResult: spotlightActions.validateActionResult });

    const { ArcifyTabActionsClient } = await peerModule('shared/arcify-tab-actions.js');
    await assertExtendedActionRoundTrips({ ArcifyBridgeClient, ArcifySpaceActionsClient, ArcifyTabActionsClient });

    const { ArcifyArchiveActionsClient } = await peerModule('shared/arcify-archive-actions.js');
    await assertArchiveActionRoundTrips({ ArcifyBridgeClient, ArcifyArchiveActionsClient });

    console.log('PASS: mocked Arcify ↔ Spotlight contract smoke test');
    console.log('Verified exported constants/common-v1 wire contracts, initial four-action contexts/payloads/results and real client/provider round trips, real snapshot validation, hello/snapshot/openTab round trips, window isolation, bookmark warnings, version rejection on both sides, and optional saved-Favorite capability/closed snapshots/exact open reuse.');
    console.log('Also verified additive Space-navigation/tab-action contracts and real client/provider round trips for switch, move, Today/saved rename, saved URL editing, duplicate, offscreen copy and explicit mute, preserving exact identities, window isolation and no-replay rejection.');
    console.log('Also verified optional Archive strict contracts and exact same-URL reopening through the real client/provider/store, durable consume receipts, lost response/no duplicate and untouched saved pins/other window.');
    console.log('Also verified exact Favorite snapshot bindings during native close/move/unpin races, ordinary repin/unpin preservation, strict client validation and unchanged durable/session ownership without retrying any action.');
    console.log('Chrome transport and APIs were mocked; no browser or extension-loading verification was performed.');
} finally {
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
}

const { assertSplitActionRoundTrips } = await import('./lib/spotlight-pair-split-actions.mjs');
await assertSplitActionRoundTrips(await peerModule('shared/arcify-split-actions.js'));
console.log('Actual Split create/end round trips passed for both original source sides.');
