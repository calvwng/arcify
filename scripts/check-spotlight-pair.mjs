#!/usr/bin/env node
/**
 * Mocked cross-repository protocol smoke test; does not launch or automate Chrome.
 * Run from the Arcify checkout: node scripts/check-spotlight-pair.mjs ../arcify-spotlight
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SpaceStore, ownerOf } from '../space-store.js';
import { createSpotlightBridge, getBridgeSnapshot } from '../spotlight-bridge.js';
import { BRIDGE_TYPE, BRIDGE_VERSION, PEER_KEY } from '../spotlight-bridge-protocol.js';

if (process.argv.length !== 3) {
    console.error('Usage: node scripts/check-spotlight-pair.mjs <spotlight-checkout>');
    process.exit(1);
}
const arcifyRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const spotlightRoot = resolve(process.argv[2]);
assert.deepEqual(
    await readFile(resolve(arcifyRoot, 'spotlight-bridge-protocol.js')),
    await readFile(resolve(spotlightRoot, 'shared/arcify-bridge-protocol.js')),
    'Arcify and Spotlight protocol helpers must be byte-identical.'
);

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
    assert.equal((await client.snapshot(WINDOW)).activeSpaceId, 'work');
    const opened = await client.request('openTab', WINDOW, { spaceId: 'empty', url: 'https://opened.test/' });
    assert.equal(created, 1);
    assert.equal(ownerOf(store.spaces, opened.tabId).id, 'empty');
    assert.equal(opened.snapshot.activeSpaceId, 'empty');
    assert.equal(opened.snapshot.tabs.find(tab => tab.id === opened.tabId).windowId, WINDOW);
    assert.equal(session.activeSpaces[8], 'work');
    assert.deepEqual(sent.map(message => message.command), ['hello', 'snapshot', 'openTab']);
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

    console.log('PASS: mocked Arcify ↔ Spotlight contract smoke test');
    console.log('Verified byte-identical protocol helpers, real snapshot validation, hello/snapshot/openTab round trips, window isolation, bookmark warnings, and version rejection on both sides.');
    console.log('Chrome transport and APIs were mocked; no browser or extension-loading verification was performed.');
} finally {
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
}
