// Pure mocked fixture scheduling tests. Never launches a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readSourceText } from '../source-text.js';
import { appearanceSaveComplete, waitForAppearanceControlSaved, setAppearanceControl, assertAppearanceSelectTrace } from '../../scripts/paired-chrome-sidebar-appearance.mjs';
import { chooseThemeMode, assertThemeModeKeyboardTrace, themeSelectionTab, assertThemeSelectionComplete, selectThemeFixtureSpace, pollThemeConservation,
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

/** Model the native popup swallowing document keydowns until real Escape closes it. */
async function withSelectPage({ id, initial, choices, open = false, rejectKey, swallowKeys = false }, action) {
    const saved = Object.fromEntries(['document', 'chrome', '__spaceThemeInput', '__appearanceSelectInput'].map(key => [key, globalThis[key]]));
    const calls = [], listeners = new Map(); let popup = open, value = initial;
    const node = { get value() { return value; }, matches: selector => selector === `#${id}` };
    globalThis.document = { activeElement: node, querySelector: selector => selector === '#sidebarAppearanceStatus'
        ? { textContent: 'Sidebar appearance saved for this Chrome profile.' } : node, getElementById: () => node,
        addEventListener: (type, handler) => { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(handler); },
        removeEventListener: (type, handler) => listeners.get(type)?.delete(handler) };
    globalThis.chrome = { storage: { local: { get: async () => ({ sidebarAppearance: { [id]: value } }) } } };
    const emit = (type, key = null) => { for (const handler of listeners.get(type) || []) handler({ type, target: node, isTrusted: true, key }); };
    const page = { evaluate: (fn, arg) => fn(arg), $eval: (_selector, fn) => fn(node), waitForSelector: async () => {},
        waitForFunction: async (fn, _options, arg) => assert.equal(await fn(arg), true),
        keyboard: { press: async key => {
            calls.push(key); if (key === rejectKey) throw Error('uncertain native input');
            if (key === 'Escape') { popup = false; return; }
            if (key === 'Enter') { popup = !popup; return; }
            if (popup || swallowKeys) return;
            emit('keydown', key); const before = value;
            if (key === 'Home') value = choices[0];
            if (key === 'ArrowDown') value = choices[Math.min(choices.indexOf(value) + 1, choices.length - 1)];
            if (before !== value) { emit('input'); emit('change'); }
        } } };
    try { return await action({ page, calls, isOpen: () => popup }); }
    finally { Object.assign(globalThis, saved); }
}
for (const open of [false, true]) for (const before of ['system', 'light', 'dark']) for (const mode of ['system', 'light', 'dark']) {
    test(`theme ${before}→${mode} from ${open ? 'open' : 'closed'} native popup requires exact trusted keys and completes closed`, async () => {
        await withSelectPage({ id: 'themeMode', initial: before, choices: ['system', 'light', 'dark'], open }, async ({ page, calls, isOpen }) => {
            const result = await chooseThemeMode(page, mode);
            assert.deepEqual(calls, ['Escape', 'Home', ...Array(['system', 'light', 'dark'].indexOf(mode)).fill('ArrowDown')]);
            assert.equal(result.before, before); assert.equal(result.saved.stored.themeMode, mode); assert.equal(isOpen(), false);
            assertThemeModeKeyboardTrace(result.trace, before, mode);
        });
    });
}
for (const open of [false, true]) for (const before of ['standard', 'compact']) for (const value of ['standard', 'compact']) {
    test(`layout ${before}→${value} from ${open ? 'open' : 'closed'} popup follows the same closed-select protocol`, async () => {
        await withSelectPage({ id: 'favoritesLayout', initial: before, choices: ['standard', 'compact'], open }, async ({ page, calls, isOpen }) => {
            const result = await setAppearanceControl(page, 'favoritesLayout', value);
            assert.deepEqual(calls, ['Escape', 'Home', ...(value === 'compact' ? ['ArrowDown'] : [])]);
            assert.equal(result.stored.favoritesLayout, value); assert.equal(isOpen(), false);
            assertAppearanceSelectTrace(result.trace, before, value, ['standard', 'compact']);
        });
    });
}
test('the exact observed popup-swallowed trusted input/change trace still fails without page keydowns', () => {
    assert.throws(() => assertThemeModeKeyboardTrace([{ type: 'input', trusted: true, key: null, value: 'light' },
        { type: 'change', trusted: true, key: null, value: 'light' }], 'system', 'light'), /complete page-delivered/);
});
test('repeated Light or Dark must show the intermediate genuine selection changes; only System→System can be key-only', () => {
    const key = value => ({ type: 'keydown', trusted: true, key: value });
    assertThemeModeKeyboardTrace([key('Home')], 'system', 'system');
    for (const [mode, count] of [['light', 1], ['dark', 2]]) {
        assert.throws(() => assertThemeModeKeyboardTrace([key('Home'), ...Array.from({ length: count }, () => key('ArrowDown'))], mode, mode), /Missing trusted select input/);
    }
    assert.throws(() => assertThemeModeKeyboardTrace([], 'system', 'system'));
    assert.throws(() => assertThemeModeKeyboardTrace([{ ...key('Home'), trusted: false }], 'system', 'system'));
    assert.throws(() => assertThemeModeKeyboardTrace([key('Home'), key('Enter')], 'system', 'system'));
});
test('uncertain native key input is never replayed and no later keys or save poll run', async () => {
    await withSelectPage({ id: 'themeMode', initial: 'system', choices: ['system', 'light', 'dark'], rejectKey: 'Home' }, async ({ page, calls }) => {
        page.waitForFunction = async () => assert.fail('Cannot claim a save after uncertain input');
        await assert.rejects(chooseThemeMode(page, 'dark'), /uncertain native input/);
        assert.deepEqual(calls, ['Escape', 'Home']);
    });
});
test('a no-op request cannot hide keys still consumed outside the page', async () => {
    await withSelectPage({ id: 'themeMode', initial: 'system', choices: ['system', 'light', 'dark'], swallowKeys: true }, async ({ page }) => {
        await assert.rejects(chooseThemeMode(page, 'system'), /native trusted input/);
    });
});
