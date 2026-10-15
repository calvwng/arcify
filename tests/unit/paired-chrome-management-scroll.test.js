// Native scroll evidence validation only; no browser or profile is launched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertManagementScrollPreserved, removeBookmarkRecord, exerciseManagementScroll } from '../../scripts/paired-chrome-management-scroll.mjs';

const before = () => ({ panel: { width: 350, height: 900, visibility: 'visible' }, viewport: { x: 8, y: 160, width: 334, height: 680 },
    scrollTop: 680, maxScroll: 1000, anchorId: 'anchor', anchorOffset: 120, anchorVisible: true,
    activeTabId: 70, activeVisible: false, targetId: 'target', targetVisible: true,
    focused: { bookmarkId: 'target', tag: 'BUTTON', className: 'tab-close', connected: true } });
const after = () => ({ ...before(), focused: { bookmarkId: 'target', tag: 'BUTTON', className: 'tab-remove', connected: true } });
const expected = { focusBookmarkId: 'target', focusClass: 'tab-remove' };
test('native inactive close preserves real offscreen-active position and logical control focus', () => {
    assertManagementScrollPreserved(before(), after(), expected);
});
test('removing near the content end permits only the unavoidable natural maximum clamp', () => {
    const state = after(); state.maxScroll = 660; state.scrollTop = 660; state.anchorOffset = 140;
    assertManagementScrollPreserved(before(), state, expected);
});
test('closed bookmark removal may move focus to its exact surviving next row action', () => {
    const state = after(); state.focused.bookmarkId = 'next';
    assertManagementScrollPreserved(before(), state, { focusBookmarkId: 'next', focusClass: 'tab-remove' });
});
for (const [name, mutate] of Object.entries({ resized: (a,b) => b.panel.width++, hiddenNative: a => a.panel.visibility = 'hidden',
    offscreenAnchor: a => a.anchorVisible = false, unscrolled: a => a.scrollTop = 0, noScrollArea: a => a.maxScroll = 0,
    alreadyVisibleActive: a => a.activeVisible = true, revealedActive: (a,b) => b.activeVisible = true,
    wrongActive: (a,b) => b.activeTabId = 71, wrongAnchor: (a,b) => b.anchorId = 'other', hiddenSurvivor: (a,b) => b.anchorVisible = false,
    wrongScroll: (a,b) => b.scrollTop = 0, shiftedAnchor: (a,b) => b.anchorOffset += 16,
    lostFocus: (a,b) => b.focused.bookmarkId = null, detachedFocus: (a,b) => b.focused.connected = false,
    bodyFocus: (a,b) => b.focused.tag = 'BODY', wrongAction: (a,b) => b.focused.className = 'tab-close',
    invisibleTarget: a => a.targetVisible = false, nanScroll: (a,b) => b.scrollTop = NaN,
    fakeClamp: (a,b) => { b.maxScroll = 660; b.scrollTop = 660; },
    overClamp: (a,b) => { b.maxScroll = 660; b.scrollTop = 620; b.anchorOffset += 60; }
})) test(`native scroll proof rejects ${name}`, () => { const a = before(), b = after(); mutate(a,b); assert.throws(() => assertManagementScrollPreserved(a,b,expected)); });

test('expected bookmark deletion keeps untouched identity and recursively reindexes siblings', () => {
    const nodes = [{ id: 'a', index: 0, parentId: 'root', title: 'A' }, { id: 'folder', index: 1, parentId: 'root', children: [
        { id: 'b', index: 0, parentId: 'folder', title: 'B' }, { id: 'c', index: 1, parentId: 'folder', title: 'C' }, { id: 'd', index: 2, parentId: 'folder', title: 'D' }
    ] }, { id: 'e', index: 2, parentId: 'root', title: 'E' }];
    const original = structuredClone(nodes);
    assert.deepEqual(removeBookmarkRecord(nodes, 'c'), [nodes[0], { ...nodes[1], children: [nodes[1].children[0], { ...nodes[1].children[2], index: 1 }] }, nodes[2]]);
    assert.deepEqual(removeBookmarkRecord(nodes, 'a'), [{ ...nodes[1], index: 0 }, { ...nodes[2], index: 1 }]);
    assert.deepEqual(nodes, original, 'Expected-state construction must not mutate captured evidence.');
});

function managementSetupHarness(t, { failSeedAt = null, selectedSpace = 'home', visibleSpace = selectedSpace, windowId = 7 } = {}) {
    const previousChrome = globalThis.chrome;
    t.after(() => { if (previousChrome === undefined) delete globalThis.chrome; else globalThis.chrome = previousChrome; });
    const events = [], created = [], removed = [], observations = [];
    const stop = new Error('Stop after seeded fixture, before management input');
    const seedFailure = new Error('Bookmark seed failed');
    let invertTabOrder = true, logicalSpace = 'work', nativeClosed = 0;
    globalThis.chrome = {
        storage: { sync: { get: async () => ({ invertTabOrder }) } },
        bookmarks: {
            create: async options => {
                events.push('seed');
                if (created.length + 1 === failSeedAt) throw seedFailure;
                const bookmark = { ...options, id: String(created.length + 1) };
                created.push(bookmark); return bookmark;
            },
            get: async id => created.filter(bookmark => bookmark.id === id && !removed.includes(id)),
            remove: async id => { removed.push(id); }
        },
        tabs: { query: async () => [], remove: async () => { throw Error('No live tab fixture was created.'); } }
    };
    const apiPage = {
        $eval: async selector => { assert.equal(selector, '#invertTabOrder'); return invertTabOrder; },
        evaluate: async (operation, argument) => operation(argument),
        click: async selector => {
            assert.equal(selector, 'label.toggle-label[for="invertTabOrder"]');
            invertTabOrder = !invertTabOrder; events.push(`ordering:${invertTabOrder}`);
        }
    };
    const page = {
        evaluate: async operation => {
            assert.equal(operation.name, 'readNativeSidebarRender'); events.push('render');
            return { selectedSpaces: [selectedSpace], visibleSpaces: [visibleSpace] };
        },
        waitForSelector: async selector => { events.push('rows'); assert(selector.includes('data-bookmark-id="40"')); throw stop; }
    };
    return { events, created, removed, observations, stop, seedFailure, nativeClosed: () => nativeClosed,
        restoredOrdering: () => invertTabOrder,
        run: () => exerciseManagementScroll({ apiPage,
            nativeSidebar: async () => {
                events.push('native'); logicalSpace = 'home';
                return { page, evidence: {}, close: async () => { nativeClosed++; events.push('close'); } };
            },
            snapshot: async () => {
                events.push(`snapshot:${logicalSpace}`);
                return { windowId, activeSpaceId: logicalSpace, spaces: ['work', 'home'].map(id => ({ id, bookmarkFolderId: `${id}-folder` })) };
            },
            ui: async (_page, _label, action) => action(),
            poll: async (read, accept) => { const value = await read(); assert(accept(value)); return value; },
            fixture: { windowA: 7, base: 'http://fixture.test' }, record: async observation => observations.push(observation)
        }) };
}

test('native management seeds the authoritative rendered Space only after ordering and native helper setup', async t => {
    const harness = managementSetupHarness(t);
    await assert.rejects(harness.run, error => error === harness.stop);
    assert.deepEqual(harness.events.slice(0, 5), ['ordering:false', 'native', 'snapshot:home', 'render', 'seed']);
    assert.equal(harness.created.length, 40);
    assert(harness.created.every(bookmark => bookmark.parentId === 'home-folder'));
    assert.deepEqual(harness.observations[0], { phase: 'native-fixture-space', windowId: 7,
        spaceId: 'home', bookmarkFolderId: 'home-folder', rendered: { selectedSpaces: ['home'], visibleSpaces: ['home'] } });
    assert.equal(harness.nativeClosed(), 1);
    assert.deepEqual(harness.removed, harness.created.map(bookmark => bookmark.id));
    assert.equal(harness.restoredOrdering(), true);
});

test('partial bookmark seeding failure still closes the established native helper and removes only created bookmarks', async t => {
    const harness = managementSetupHarness(t, { failSeedAt: 2 });
    await assert.rejects(harness.run, error => error === harness.seedFailure);
    assert.equal(harness.created.length, 1); assert.deepEqual(harness.removed, ['1']);
    assert.equal(harness.nativeClosed(), 1); assert.equal(harness.restoredOrdering(), true);
    assert(!harness.events.includes('rows'));
});

for (const [label, options, message] of [
    ['selected Space', { selectedSpace: 'work' }, /selected Space must match/],
    ['visible Space', { visibleSpace: 'work' }, /visible Space must match/],
    ['source window', { windowId: 8 }, /native panel source window/]
]) test(`native fixture refuses mismatched ${label} before seeding and cleans up its helper`, async t => {
    const harness = managementSetupHarness(t, options);
    await assert.rejects(harness.run, message);
    assert.deepEqual(harness.created, []); assert.deepEqual(harness.removed, []);
    assert.equal(harness.nativeClosed(), 1); assert.equal(harness.restoredOrdering(), true);
});
