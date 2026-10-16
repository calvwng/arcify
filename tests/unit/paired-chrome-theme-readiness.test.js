// Pure mocked fixture scheduling tests. Never launches a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readSourceText } from '../source-text.js';
import { appearanceSaveComplete, waitForAppearanceControlSaved } from '../../scripts/paired-chrome-sidebar-appearance.mjs';
import { themeSelectionTab, assertThemeSelectionComplete, selectThemeFixtureSpace, pollThemeConservation,
    THEME_LEGACY_SYNC_KEYS, restoreThemeLegacySync, captureThemeSettingsSamples } from '../../scripts/paired-chrome-space-theme.mjs';

const expected = { spaceId: 'work', windowId: 1, extensionId: 'fixture', tabId: 3 };
function selection(selected = 'work') {
    return { rendered: { selectedSpaces: [selected], visibleSpaces: [selected] }, authoritative: { windowId: 1, activeSpaceId: selected, favorites: [{ tabId: 4 }] },
        activeRows: [3], state: { spaces: [{ id: 'work', lastTab: 3, spaceBookmarks: [5, 1], temporaryTabs: [3, 2, 4, 6, 7] }],
            tabs: [{ id: 1, windowId: 1 }, { id: 2, windowId: 2 }, { id: 3, windowId: 1, active: true }, { id: 4, windowId: 1 },
                { id: 5, windowId: 1, pinned: true }, { id: 6, windowId: 1, url: 'chrome-extension://fixture/startup-launcher.html?x' }]
                .map(tab => ({ url: `https://fixture.test/${tab.id}`, pinned: false, active: false, ...tab })) } };
}
test('native completion rejects DOM/session readiness until Chrome active tab, durable lastTab and rendered row all agree', () => {
    assertThemeSelectionComplete(selection(), expected);
    for (const change of [s => s.state.tabs[2].active = false, s => s.state.spaces[0].lastTab = 1,
        s => s.activeRows = [1], s => s.rendered.visibleSpaces = ['other'], s => s.authoritative.activeSpaceId = 'other']) {
        const state = selection(); change(state); assert.throws(() => assertThemeSelectionComplete(state, expected));
    }
});
test('selection prediction respects stored owned ordering, live window, remembered tab and Favorite/launcher exclusions', () => {
    const state = selection().state;
    assert.equal(themeSelectionTab(state, { ...expected, favoriteTabIds: [4] }), 3);
    state.spaces[0].lastTab = 99; assert.equal(themeSelectionTab(state, { ...expected, favoriteTabIds: [4] }), 3);
    state.tabs[0].active = true; state.spaces[0].lastTab = 1; assert.equal(themeSelectionTab(state, { ...expected, favoriteTabIds: [4] }), 1);
});
test('an already authoritative and rendered selected Space is not clicked again', async () => {
    let clicks = 0;
    const result = await selectThemeFixtureSpace({ read: async () => selection(), expected, click: async () => clicks++,
        poll: async () => assert.fail('No pending selection was initiated'), record: async () => {} });
    assert.equal(result.clicked, false); assert.equal(clicks, 0);
});
test('one native click waits through DOM-only and Chrome-only readiness before returning', async () => {
    const initial = selection('other'), early = selection(), chromeOnly = selection();
    early.state.tabs[2].active = false; early.state.spaces[0].lastTab = 1; early.activeRows = [1];
    chromeOnly.state.spaces[0].lastTab = 1;
    const states = [initial, early, chromeOnly, selection()]; let clicks = 0, reads = 0;
    const result = await selectThemeFixtureSpace({ read: async () => { reads++; return states.shift(); }, expected,
        click: async () => clicks++, record: async () => {}, poll: async (read, accept) => {
            assert.equal(accept(await read()), false); assert.equal(accept(await read()), false);
            const final = await read(); assert.equal(accept(final), true); return final;
        } });
    assert.equal(result.tabId, 3); assert.equal(clicks, 1); assert.equal(reads, 4);
});
test('conservation timeout persists last actual/expected difference before propagating the original failure', async () => {
    const records = [], failure = Error('bounded poll expired'); let index = 0;
    await assert.rejects(pollThemeConservation({ read: async () => ({ mode: 'light', unrelated: ++index }),
        validate: state => assert.deepEqual(state, { mode: 'light', unrelated: 0 }), label: 'strict mode state', record: async row => records.push(row),
        poll: async (read, accept) => { assert.equal(accept(await read()), false); assert.equal(accept(await read()), false); throw failure; } }), error => error === failure);
    assert.equal(records.length, 1); assert.deepEqual(records[0].after, { mode: 'light', unrelated: 2 });
    assert.deepEqual(records[0].difference.expected, { mode: 'light', unrelated: 0 });
    assert.deepEqual(records[0].difference.actual, records[0].after);
});
test('appearance completion rejects transient target storage while the real queue is saving', () => {
    const state = { control: '16', stored: { spaceHeaderSize: 16 }, status: 'Saving sidebar appearance…' };
    assert.equal(appearanceSaveComplete(state, 'spaceHeaderSize', 16), false);
    state.status = 'Sidebar appearance saved for this Chrome profile.';
    assert.equal(appearanceSaveComplete(state, 'spaceHeaderSize', 16), true);
    state.stored.spaceHeaderSize = 14; assert.equal(appearanceSaveComplete(state, 'spaceHeaderSize', 16), false);
    state.stored.spaceHeaderSize = 16; state.control = '14'; assert.equal(appearanceSaveComplete(state, 'spaceHeaderSize', 16), false);
});
test('save wait observes the actual UI queue and final exact value, not an earlier target-value write', async () => {
    const previous = { chrome: globalThis.chrome, document: globalThis.document };
    let stored = 16, status = 'Saving sidebar appearance…', polls = 0;
    globalThis.document = { getElementById: () => ({ value: '16' }), querySelector: () => ({ textContent: status }) };
    globalThis.chrome = { storage: { local: { get: async () => ({ sidebarAppearance: { spaceHeaderSize: stored } }) } } };
    try {
        const page = { evaluate: (fn, arg) => fn(arg), waitForFunction: async (fn, _options, arg) => {
            assert.equal(await fn(arg), false); polls++;
            stored = 14; assert.equal(await fn(arg), false); polls++;
            stored = 16; status = 'Sidebar appearance saved for this Chrome profile.'; assert.equal(await fn(arg), true); polls++;
        } };
        const receipt = await waitForAppearanceControlSaved(page, 'spaceHeaderSize', 16);
        assert.equal(polls, 3); assert.equal(receipt.stored.spaceHeaderSize, 16);
    } finally { Object.assign(globalThis, previous); }
});
function syncFixture() {
    const original = { syncTabGroups: false, untouched: { secret: 'retained' } };
    let current = { ...original, ...Object.fromEntries(THEME_LEGACY_SYNC_KEYS.map(key => [key, key === 'syncTabGroups' ? false : `fixture-${key}`])) };
    const calls = [], receipt = { wrote: true, trace: [{ type: 'change', trusted: true }], sync: structuredClone(current) };
    return { original, receipt, calls, get current() { return current; }, api: { storage: { sync: {
        get: async () => structuredClone(current), set: async changes => { calls.push(['set', changes]); Object.assign(current, changes); },
        remove: async keys => { calls.push(['remove', keys]); for (const key of keys) delete current[key]; }
    } } } };
}
test('legacy cleanup restores exact original key presence and preserves every unowned key', async () => {
    const prior = globalThis.chrome, f = syncFixture(); globalThis.chrome = f.api;
    try { await restoreThemeLegacySync({ evaluate: (fn, args) => fn(args) }, f.original, f.receipt);
        assert.deepEqual(f.current, f.original); assert.deepEqual(f.calls[0], ['set', { syncTabGroups: false }]);
        assert.equal(f.calls[1][1].length, 10); assert(!f.calls[1][1].includes('untouched'));
    } finally { globalThis.chrome = prior; }
});
test('legacy cleanup refuses an unowned concurrent change without overwriting or removing anything', async () => {
    const prior = globalThis.chrome, f = syncFixture(); globalThis.chrome = f.api; f.current.defaultSpaceName = 'new external value';
    try { await assert.rejects(restoreThemeLegacySync({ evaluate: (fn, args) => fn(args) }, f.original, f.receipt), /unowned sync change/); assert.deepEqual(f.calls, []); }
    finally { globalThis.chrome = prior; }
});
test('narrow Settings captures every required sample after genuine wheel input with full visibility assertions', async () => {
    const calls = [], y = new Map([['#themeMode', 20], ['#favoriteTileSizeValue', 950]]);
    const page = { evaluate: async (_fn, selectors) => selectors.map(selector => ({ selector, count: 1, connected: true, visible: true, unobscured: true, opacity: 1,
        color: 'rgb(255,255,255)', backgrounds: ['rgb(0,0,0)'], rect: { x: 10, y: y.get(selector), width: 100, height: 25 }, viewport: { width: 350, height: 900 } })),
        mouse: { move: async () => calls.push('pointer'), wheel: async input => { calls.push(['wheel', input.deltaY]); y.set('#favoriteTileSizeValue', 400); } },
        waitForFunction: async () => calls.push('visible') };
    const measured = await captureThemeSettingsSamples({ page, selectors: [...y.keys()], capture: async (index, selector) => calls.push(['shot', index, selector]) });
    assert.equal(measured.length, 2); assert.deepEqual(calls, [['shot', 0, '#themeMode'], 'pointer', ['wheel', 512.5], 'visible', ['shot', 1, '#favoriteTileSizeValue']]);
});
test('scrolling cannot turn a contrast or occlusion failure into passing evidence', async () => {
    const page = { evaluate: async () => [{ count: 1, connected: true, visible: true, unobscured: false, rect: { y: 10, height: 20 }, viewport: { height: 900 } }] };
    await assert.rejects(captureThemeSettingsSamples({ page, selectors: ['#themeMode'], capture: async () => assert.fail('No screenshot may substitute for a failed oracle') }), /unobscured/);
});
test('theme diagnostics precede input and strict comparison, and no runtime queue hook or native viewport mutation is introduced', () => {
    const source = readSourceText(new URL('../../scripts/paired-chrome-space-theme.mjs', import.meta.url));
    assert(source.indexOf("checkpoint('before-appearance-input'") < source.indexOf('trace = await chooseThemeMode(settings.page, mode)'));
    assert.match(source, /appearance-conservation-failed/); assert.match(source, /appearance-input-failed/); assert.match(source, /theme-cleanup-conservation-failed/);
    assert.doesNotMatch(source, /whenSaved|native\.page\.setViewport|dispatchEvent\(|scrollIntoView\(|\.value\s*=(?!=)/);
});
test('a diagnostic write failure cannot replace the primary conservation error', async () => {
    const failure = Error('primary strict failure');
    await assert.rejects(pollThemeConservation({ read: async () => ({}), poll: async () => { throw failure; }, validate: () => {}, label: 'strict',
        record: async () => { throw Error('disk write failed'); } }), error => error === failure);
});
