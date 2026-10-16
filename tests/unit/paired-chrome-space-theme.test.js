// Pure validators and mocked adapters only. No browser is launched by these tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readSourceText } from '../source-text.js';
import { themeRestorationState, readThemeFixtureState, chooseThemeMarkerRequest, THEME_MODES, THEME_EXTREMES, parseThemeRgb, computedThemeContrast, assertThemeSample,
    assertThemeResolved, assertThemeNativeProjection, assertThemeMetadataSaved, assertThemeFixtureRestored, setThemeGroupSync, restoreThemeNativeFixture, restoreThemeLastTabs, assertThemeModeSaved, assertThemeReload, assertThemeKeyboardTrace,
    assertThemeFocusKept, assertThemeNativeHost, assertThemeHeaderGeometry, assertThemeHeaderSaved, assertThemeFirstPaint, chooseThemeMode, replaceThemeHex, THEME_HEX_INPUT } from '../../scripts/paired-chrome-space-theme.mjs';

const sample = () => ({ selector: '.actual', count: 1, connected: true, visible: true, unobscured: true, opacity: 1,
    color: 'rgb(255, 255, 255)', backgrounds: ['rgba(0, 0, 0, 0)', 'rgb(0, 0, 0)'],
    rect: { x: 10, y: 20, width: 100, height: 25 }, viewport: { width: 350, height: 800 } });
test('independent rendered contrast composites actual transparent ancestor backgrounds', () => {
    assert.deepEqual(parseThemeRgb('rgba(1, 2, 3, 0.5)'), [1, 2, 3, .5]);
    assert.equal(computedThemeContrast('rgb(255, 255, 255)', ['rgba(255, 255, 255, 0)', 'rgb(0, 0, 0)']), 21);
    assert(computedThemeContrast('rgba(255, 255, 255, .5)', ['rgb(0, 0, 0)']) < 6);
    assert(computedThemeContrast('rgb(0, 0, 0)', ['rgba(0, 0, 0, .5)', 'rgb(255, 255, 255)']) > 5);
    assert.equal(assertThemeSample(sample()).ratio, 21);
});
for (const value of ['#fff', 'white', 'var(--text)', 'url(bad)', 'rgb(256,0,0)', 'rgb(-1,0,0)', 'rgba(1,2,3,2)', 'rgba(1,2,3,-1)', 'rgba(1,2,3,)' , 'rgb(NaN,0,0)', ''])
    test(`computed RGB parser rejects ${value}`, () => assert.throws(() => parseThemeRgb(value)));
test('contrast cannot invent an opaque white canvas behind transparent CSS', () => assert.throws(() => computedThemeContrast('rgb(0,0,0)', ['rgba(0,0,0,0)'])));
for (const [name, mutate] of Object.entries({ duplicate: s => s.count++, missing: s => s.count = 0, detached: s => s.connected = false, hidden: s => s.visible = false,
    overlay: s => s.unobscured = false, translucent: s => s.opacity = .8, clipped: s => s.rect.x = -2, overflow: s => s.rect.width = 400, empty: s => s.rect.height = 0,
    nonfinite: s => s.rect.y = NaN, insufficient: s => s.color = 'rgb(90,90,90)', unresolved: s => s.color = 'currentColor', transparent: s => s.color = 'rgba(255,255,255,0)' }))
    test(`rendered text evidence rejects ${name}`, () => { const value = sample(); mutate(value); assert.throws(() => assertThemeSample(value)); });
for (const mode of THEME_MODES) for (const systemDark of [false, true]) test(`${mode} resolves correctly with media dark=${systemDark}`, () => {
    const expected = { mode, tint: '#ffffff', systemDark }, resolved = mode === 'system' ? systemDark ? 'dark' : 'light' : mode;
    const value = { ...expected, resolved, colorScheme: resolved }; assertThemeResolved(value, expected);
    for (const bad of [{ mode: 'invalid' }, { tint: '#000000' }, { resolved: resolved === 'dark' ? 'light' : 'dark' }, { colorScheme: 'normal' }, { systemDark: !systemDark }])
        assert.throws(() => assertThemeResolved({ ...value, ...bad }, expected));
});
const state = () => ({ spaces: [{ id: 'work', bookmarkFolderId: 'folder', name: 'Work', color: 'blue', icon: '🚀', temporaryTabs: [1], spaceBookmarks: [] }, { id: 'other', color: 'red' }],
    registry: { folder: { spaceUuid: 'work', name: 'Work', color: 'blue', icon: '🚀' } }, appearance: { favoritesLayout: 'compact', favoriteTileSize: 48, spaceHeaderSize: 12, hideSpaceNames: true, themeMode: 'system' },
    sync: { colorOverrides: { blue: '#334455' }, syncTabGroups: true }, activeSpaces: { 1: 'work' }, projection: { 'work:1': 22 }, groups: [{ id: 22, windowId: 1, color: 'blue', title: 'Work', collapsed: false }],
    tabs: [{ id: 1, windowId: 1, url: 'https://fixture.test', active: true, pinned: false, groupId: 22 }], bridgeColors: [{ id: 'work', color: 'blue' }, { id: 'other', color: 'red' }],
    bookmarks: [{ id: 'folder', title: 'Work' }], favorites: [{ id: 'favorite' }], bindings: { 1: { bookmarkId: 'pin' } } });
const saved = (before, changes) => { const after = structuredClone(before); Object.assign(after.spaces[0], changes); Object.assign(after.registry.folder, changes);
    if (changes.color) { after.groups[0].color = changes.color; after.bridgeColors[0].color = changes.color; } return after; };
for (const changes of [{ customTint: '#ffffff' }, { customTint: '#000000' }, { customTint: null }, { color: 'purple', customTint: null }])
    test(`theme metadata persistence ${JSON.stringify(changes)} stays UUID-scoped`, () => { const before = state(); assertThemeMetadataSaved(before, saved(before, changes), { spaceId: 'work', windowId: 1, changes }); });
for (const [name, mutate] of Object.entries({ nativeHex: s => s.groups[0].color = '#123456', bridgeHex: s => s.bridgeColors[0].color = '#123456', palette: s => s.sync.colorOverrides.blue = '#123456',
    uuid: s => s.registry.folder.spaceUuid = 'other', wrongSpace: s => s.spaces[1].customTint = '#000000', lostIcon: s => delete s.spaces[0].icon,
    missingRegistry: s => delete s.registry.folder.customTint, missingLocal: s => delete s.spaces[0].customTint, names: s => s.spaces[0].name = 'Changed',
    mode: s => s.appearance.themeMode = 'dark', ownership: s => s.spaces[0].temporaryTabs = [], activation: s => s.tabs[0].active = false,
    nativeOrder: s => s.tabs.reverse().push({ id: 8 }), groups: s => s.groups[0].collapsed = true, bookmarks: s => s.bookmarks = [], favorites: s => s.favorites = [], binding: s => s.bindings = {} }))
    test(`tint-only proof rejects unrelated ${name}`, () => { const before = state(), changes = { customTint: '#000000' }, after = saved(before, changes); mutate(after); assert.throws(() => assertThemeMetadataSaved(before, after, { spaceId: 'work', windowId: 1, changes })); });
for (const changes of [{ customTint: '#fff' }, { customTint: 'red' }, { customTint: '#AABBCC' }, { customTint: 'var(--theme)' }, { color: '#000000', customTint: null }, { color: 'blue' }, { icon: 'star' }, {}])
    test(`metadata proof rejects malformed or non-theme change ${JSON.stringify(changes)}`, () => assert.throws(() => assertThemeMetadataSaved(state(), state(), { spaceId: 'work', windowId: 1, changes })));
test('preset proof requires custom reset and native named projection while preserving global override', () => {
    const before = state(); before.spaces[0].customTint = '#000000'; before.registry.folder.customTint = '#000000';
    const changes = { color: 'purple', customTint: null }, after = saved(before, changes); assertThemeMetadataSaved(before, after, { spaceId: 'work', windowId: 1, changes });
    const bad = structuredClone(after); bad.groups[0].color = 'blue'; assert.throws(() => assertThemeMetadataSaved(before, bad, { spaceId: 'work', windowId: 1, changes }));
});
test('mode control preserves other appearance choices, custom metadata and sync palette despite real options activation', () => {
    const before = state(), after = structuredClone(before); after.appearance.themeMode = 'dark'; after.activeSpaces[1] = 'other'; after.tabs[0].active = false;
    assertThemeModeSaved(before, after, 'dark');
    for (const mutate of [s => s.appearance.favoriteTileSize = 44, s => s.appearance.hideSpaceNames = false, s => s.spaces[0].color = 'red', s => s.sync = {}, s => s.tabs[0].url = 'https://bad.test']) {
        const bad = structuredClone(after); mutate(bad); assert.throws(() => assertThemeModeSaved(before, bad, 'dark'));
    }
});
test('first mode save allows only the established default shape with selected mode', () => {
    const before = state(); before.appearance = null; const after = structuredClone(before);
    after.appearance = { favoritesLayout: 'standard', favoriteTileSize: 44, spaceHeaderSize: 16, hideSpaceNames: false, themeMode: 'dark' };
    assertThemeModeSaved(before, after, 'dark');
});
test('reload proof retains custom tint, native named color and registry, rather than checking only DOM appearance', () => {
    const before = saved(state(), { customTint: '#000000' }); assertThemeReload(before, structuredClone(before));
    for (const key of ['spaces', 'registry', 'appearance', 'sync', 'tabs', 'groups', 'favorites', 'bookmarks', 'bindings', 'bridgeColors']) {
        const after = structuredClone(before); after[key] = null; assert.throws(() => assertThemeReload(before, after));
    }
});
const trace = (value = '#000000', select = false) => [{ type: 'keydown', trusted: true }, ... (select ? [] : [{ type: 'beforeinput', trusted: true, value: '' }]), { type: select ? 'change' : 'input', trusted: true, value }];
test('keyboard evidence requires trusted keys and complete text input/change events', () => { assertThemeKeyboardTrace(trace(), '#000000'); assertThemeKeyboardTrace(trace('dark', true), 'dark', { select: true }); });
for (const [name, value] of Object.entries({ synthetic: trace().map(event => ({ ...event, trusted: false })), missingKey: trace().slice(1), missingInput: trace().slice(0, 2), missingBeforeInput: trace().filter(event => event.type !== 'beforeinput'), wrongValue: trace('#ffffff'), empty: [] }))
    test(`keyboard proof rejects ${name}`, () => assert.throws(() => assertThemeKeyboardTrace(value, '#000000')));
const focus = () => ({ nodeId: 1, timeOrigin: 100, connected: true, active: true, value: 'Work', start: 0, end: 4, direction: 'forward', todaySelection: ['1', '2'] });
test('focus proof retains exact mounted identity, activeElement, text selection and Today selection', () => assertThemeFocusKept(focus(), focus()));
for (const [name, value] of Object.entries({ nodeId: 2, timeOrigin: 200, connected: false, active: false, value: 'Changed', start: 4, end: 0, direction: 'backward', todaySelection: [] }))
    test(`theme focus proof rejects changed ${name}`, () => assert.throws(() => assertThemeFocusKept(focus(), { ...focus(), [name]: value })));
const host = () => ({ tab: null, windowId: 1, url: 'chrome-extension://extension/sidebar.html', visibility: 'visible', width: 350, height: 900,
    context: { contextType: 'SIDE_PANEL', contextId: 'native-context', windowId: 1, documentUrl: 'chrome-extension://extension/sidebar.html' }, openedEvents: [{ type: 'opened', windowId: 1, path: 'sidebar.html' }] });
const hostRequest = { windowId: 1, extensionId: 'extension' };
test('native host evidence requires real narrow SIDE_PANEL identity, never a regular extension tab', () => assertThemeNativeHost(host(), hostRequest));
for (const [name, value] of Object.entries({ tab: { id: 2 }, windowId: 2, url: 'chrome-extension://extension/options.html', visibility: 'hidden', width: 900, height: 0, context: { contextType: 'TAB', windowId: 1, documentUrl: 'chrome-extension://extension/sidebar.html' } }))
    test(`native host rejects invalid ${name}`, () => assert.throws(() => assertThemeNativeHost({ ...host(), [name]: value }, hostRequest)));
test('fixture is standalone import-safe and never injects user input or forces native geometry', () => {
    const source = readSourceText(new URL('../../scripts/paired-chrome-space-theme.mjs', import.meta.url));
    assert.match(source, /export async function exerciseSpaceTheme/); assert.match(source, /assertSpaceContextFixtureEnvironment\(\)/);
    assert.match(source, /nativeSidebar\(\{ revealSpaceId: target.id \}\)/); assert.match(source, /assertNativeSidebarScreenshot/); assert.match(source, /assertMarkerScreenshotPixels/);
    assert.match(source, /native\.page\.reload/); assert.match(source, /settings\.page\.reload/); assert.match(source, /emulateMediaFeatures/);
    assert.doesNotMatch(source, /dispatchEvent\(|\.value\s*=(?!=)|setAttribute\(|\.focus\(|puppeteer\.launch|spawn\(|native\.page\.setViewport|style\.setProperty/);
    assert.match(source, /Input.cancelDragging/); assert.match(source, /Manual follow-up/);
    assert.deepEqual(THEME_EXTREMES, ['#000000', '#ffffff', '#ffff00', '#0000ff']);
});

const header = () => ({ header: { x: 8, y: 20, width: 320, height: 28 }, icon: { x: 16, y: 20, width: 20, height: 28 }, name: { x: 41, y: 20, width: 211, height: 28 },
    glyph: '👩🏽‍💻', iconHidden: false, iconDisplay: 'inline-flex', nameDisplay: 'block', fontSize: 16, overflow: 'ellipsis', value: 'A long name', disabled: false, readOnly: false,
    focused: false, controls: [{ x: 252, y: 20, width: 28, height: 28 }, { x: 280, y: 20, width: 28, height: 28 }], viewport: { width: 350, height: 900 } });
const headerRequest = { glyph: '👩🏽‍💻', name: 'A long name', size: 16 };
test('header geometry aligns the complete grapheme and name while leaving archive/menu controls separate', () => {
    assertThemeHeaderGeometry(header(), headerRequest);
    const cleared = { ...header(), glyph: '', iconHidden: true, iconDisplay: 'none' }; assertThemeHeaderGeometry(cleared, { ...headerRequest, glyph: null });
    assertThemeHeaderGeometry({ ...header(), focused: true, overflow: 'clip' }, { ...headerRequest, focused: true });
});
for (const [name, mutate] of Object.entries({ splitGrapheme: s => s.glyph = '👩', hiddenName: s => s.nameDisplay = 'none', iconOffset: s => s.icon.y += 3,
    nameOffset: s => s.name.y += 3, detachedIcon: s => s.name.x += 15, overlap: s => s.name.width += 10, clippedControl: s => s.controls[1].x = 340,
    noMenu: s => s.controls.pop(), wrongSize: s => s.fontSize = 12, noEllipsis: s => s.overflow = 'clip', notEditable: s => s.readOnly = true,
    iconHidden: s => s.iconHidden = true, truncation: s => s.value = 'A long…' }))
    test(`header geometry rejects ${name}`, () => { const value = header(); mutate(value); assert.throws(() => assertThemeHeaderGeometry(value, headerRequest)); });
test('header fixture persistence allows exact full grapheme and matching native/bookmark name edits only', () => {
    const before = state(), after = structuredClone(before), changes = { icon: '👩🏽‍💻', name: 'A long name' };
    Object.assign(after.spaces[0], changes); Object.assign(after.registry.folder, changes); after.groups[0].title = changes.name; after.bookmarks[0].title = changes.name;
    assertThemeHeaderSaved(before, after, { spaceId: 'work', windowId: 1, changes });
    after.spaces[0].customTint = '#123456'; assert.throws(() => assertThemeHeaderSaved(before, after, { spaceId: 'work', windowId: 1, changes }));
});
test('native host retains Chromium window -1 only with the true source-window open receipt', () => {
    const value = host(); value.context.windowId = -1; assertThemeNativeHost(value, hostRequest);
    value.openedEvents = []; assert.throws(() => assertThemeNativeHost(value, hostRequest));
    value.openedEvents = [{ type: 'opened', windowId: 2, path: 'sidebar.html' }]; assert.throws(() => assertThemeNativeHost(value, hostRequest));
});

test('first paint proof rejects opposite cached/default flashes rather than inspecting only final loaded CSS', () => {
    const value = { paints: [{ name: 'first-paint', mode: 'dark', resolved: 'dark' }, { name: 'first-contentful-paint', mode: 'dark', resolved: 'dark' }], themes: [{ mode: 'dark', resolved: 'dark' }] };
    assertThemeFirstPaint(value, 'dark', 'dark');
    for (const mutate of [s => s.paints.pop(), s => s.themes.unshift({ mode: 'system', resolved: 'light' }), s => s.paints[0].resolved = 'light']) {
        const bad = structuredClone(value); mutate(bad); assert.throws(() => assertThemeFirstPaint(bad, 'dark', 'dark'));
    }
});

const projectionRequest = { spaceId: 'work', windowId: 1 };
test('native tint evidence includes the exact target/window group and real owned members', () => {
    assert.deepEqual(assertThemeNativeProjection(state(), projectionRequest), { spaceId: 'work', windowId: 1, groupId: 22, color: 'blue', tabIds: [1] });
});
for (const [name, mutate] of Object.entries({
    absentGroups: s => s.groups = [], absentProjection: s => s.projection = {}, disabledSync: s => s.sync.syncTabGroups = false,
    missingSync: s => delete s.sync.syncTabGroups, wrongWindowKey: s => s.projection = { 'work:2': 22 }, wrongSpaceKey: s => s.projection = { 'other:1': 22 },
    staleProjection: s => s.projection['work:1'] = 23, negativeGroup: s => s.projection['work:1'] = -1,
    stringGroup: s => s.projection['work:1'] = '22', wrongWindowGroup: s => s.groups[0].windowId = 2,
    duplicateGroup: s => s.groups.push({ ...s.groups[0] }), missingNativeMembers: s => s.tabs = [],
    emptyOwnership: s => s.spaces[0].temporaryTabs = [], ungroupedMember: s => s.tabs[0].groupId = -1,
    wrongGroupMember: s => s.tabs[0].groupId = 23, wrongWindowMember: s => s.tabs[0].windowId = 2,
    pinnedMember: s => s.tabs[0].pinned = true, nonNativeColor: s => { s.groups[0].color = '#112233'; s.spaces[0].color = '#112233'; s.bridgeColors[0].color = '#112233'; },
    mismatchedEnum: s => s.groups[0].color = 'red', missingBridgeTarget: s => s.bridgeColors.shift()
})) test(`even matching before/after snapshots reject ${name} as native tint proof`, () => {
    const before = state(), changes = { customTint: '#000000' }, after = saved(before, changes);
    mutate(before); mutate(after);
    assert.throws(() => assertThemeNativeProjection(before, projectionRequest));
    assert.throws(() => assertThemeMetadataSaved(before, after, { ...projectionRequest, changes }));
});
test('a missing after-group and a replaced group identity fail despite valid native setup', () => {
    const before = state(), changes = { customTint: '#000000' };
    for (const mutate of [s => s.groups = [], s => s.projection = {}, s => { s.groups[0].id = 23; s.tabs[0].groupId = 23; s.projection['work:1'] = 23; }]) {
        const after = saved(before, changes); mutate(after);
        assert.throws(() => assertThemeMetadataSaved(before, after, { ...projectionRequest, changes }));
    }
    assert.throws(() => assertThemeMetadataSaved(before, saved(before, changes), { spaceId: 'work', changes }), /exact fixture window/);
});
test('cleanup accepts only an equivalent absent-tint reset and retains every captured field', () => {
    const before = state(), after = structuredClone(before);
    after.spaces[0].customTint = null; after.registry.folder.customTint = null;
    assertThemeFixtureRestored(before, after, 'work');
    for (const mutate of [s => s.groups = [], s => s.projection = {}, s => s.groups[0].id = 23,
        s => s.tabs[0].groupId = -1, s => s.tabs[0].active = false, s => s.tabs[0].index = 8,
        s => s.activeSpaces[1] = 'other', s => s.spaces[0].name = 'Changed', s => s.spaces[0].temporaryTabs = [],
        s => s.sync.syncTabGroups = false, s => s.sync.colorOverrides = {}, s => s.appearance.themeMode = 'dark',
        s => s.bookmarks = [], s => s.favorites = [], s => s.bindings = {}, s => s.spaces[1].customTint = null]) {
        const bad = structuredClone(after); mutate(bad); assert.throws(() => assertThemeFixtureRestored(before, bad, 'work'));
    }
});
test('native sync setup clicks the actual checkbox and rejects untrusted changes', async () => {
    for (const trusted of [true, false]) {
        let checked = false; const calls = [];
        const page = { waitForSelector: async selector => calls.push(['wait', selector]), waitForFunction: async () => calls.push(['ready']),
            $eval: async () => checked,
            evaluate: async fn => fn.name === 'installThemeInputTrace' ? undefined : [{ type: 'change', trusted }],
            click: async selector => { calls.push(['click', selector]); checked = true; } };
        if (trusted) { await setThemeGroupSync(page, true); const count = calls.length; await setThemeGroupSync(page, true); assert.equal(calls.length, count + 2); }
        else await assert.rejects(() => setThemeGroupSync(page, true));
        assert.equal(calls.filter(([type]) => type === 'click').length, 1);
        assert(calls.some(([type, selector]) => type === 'click' && selector === 'label.toggle-label[for="syncTabGroups"]'));
    }
});
test('native restoration fails before recreating a missing original group', async () => {
    const prior = globalThis.chrome; let wrote = false;
    globalThis.chrome = {
        storage: { sync: { get: async () => ({ syncTabGroups: false }) }, session: { set: async () => { wrote = true; } } },
        tabGroups: { query: async () => [] }, tabs: { query: async () => state().tabs }
    };
    try { await assert.rejects(() => restoreThemeNativeFixture({ evaluate: (fn, args) => fn(args) }, state()), /Original native group disappeared/); assert.equal(wrote, false); }
    finally { if (prior === undefined) delete globalThis.chrome; else globalThis.chrome = prior; }
});
test('fixture cleanup patches only the remembered-tab hint without overwriting live Space metadata or membership', async () => {
    const original = state().spaces, current = structuredClone(original); original[0].lastTab = 1;
    current[0].lastTab = 999; current[0].name = 'Live name'; current[0].customTint = '#123456'; current[0].temporaryTabs.push(3);
    const prior = globalThis.chrome, calls = [];
    globalThis.chrome = { runtime: { sendMessage: async message => {
        calls.push(message); return message.action === 'get' ? { success: true, spaces: current } : { success: true };
    } } };
    try {
        await restoreThemeLastTabs({ evaluate: (fn, args) => fn(args) }, original);
        assert.equal(calls.length, 2); assert.equal(calls[1].action, 'patch');
        assert.deepEqual(calls[1].before, current);
        const expected = structuredClone(current); expected[0].lastTab = 1; expected[1].lastTab = null;
        assert.deepEqual(calls[1].after, expected);
        calls.length = 0;
        await assert.rejects(() => restoreThemeLastTabs({ evaluate: (fn, args) => fn(args) }, original.slice(1)), /cannot replace or remove a Space/);
        assert.equal(calls.length, 1);
    } finally { if (prior === undefined) delete globalThis.chrome; else globalThis.chrome = prior; }
});
test('native cleanup relocates whole groups atomically without tabs.move array ungrouping', async () => {
    const original = { projection: { 'work:1': 22 }, groups: [{ id: 22, windowId: 1, title: 'Work', color: 'blue', collapsed: false }],
        tabs: [{ id: 1, groupId: 22 }, { id: 2, groupId: 22 }, { id: 3, groupId: -1 }].map((tab, index) => ({ ...tab, index, windowId: 1, pinned: false, url: `https://fixture.test/${tab.id}` })) };
    const live = [original.tabs[2], original.tabs[1], original.tabs[0]].map((tab, index) => ({ ...tab, index }));
    const calls = [], prior = globalThis.chrome;
    const reindex = () => live.forEach((tab, index) => { tab.index = index; });
    globalThis.chrome = {
        storage: { sync: { get: async () => ({ syncTabGroups: false }) }, session: { set: async value => calls.push(['projection', value]) } },
        tabs: { query: async (query = {}) => structuredClone(live.filter(tab => query.groupId === undefined || tab.groupId === query.groupId)),
            move: async (id, { index }) => { assert.equal(typeof id, 'number', 'Never move a group through a sequential tab-ID array.');
                const tab = live.find(tab => tab.id === id), members = live.filter(item => item.groupId === tab.groupId);
                if (tab.groupId >= 0) assert(index >= members[0].index && index <= members.at(-1).index, 'Member reorder must stay within the current group range.');
                calls.push(['tab', id, index]); live.splice(live.indexOf(tab), 1); live.splice(index, 0, tab); reindex(); } },
        tabGroups: { query: async () => structuredClone(original.groups), update: async () => {},
            move: async (id, { index }) => { calls.push(['group', id, index]); const members = live.filter(tab => tab.groupId === id); for (const tab of members) live.splice(live.indexOf(tab), 1); live.splice(index, 0, ...members); reindex(); } }
    };
    try {
        await restoreThemeNativeFixture({ evaluate: (fn, args) => fn(args) }, original);
        assert.deepEqual(live, original.tabs);
        assert.deepEqual(calls, [['tab', 1, 1], ['group', 22, 0], ['projection', { spaceGroupProjection: original.projection }]]);
    } finally { if (prior === undefined) delete globalThis.chrome; else globalThis.chrome = prior; }
});


test('theme marker gesture moves the second visible Space before the first, never the adjacent no-op', () => {
    assert.deepEqual(chooseThemeMarkerRequest(['a', 'b'], ['a', 'b', 'c']), { sourceSpaceId: 'b', anchorSpaceId: 'a', placement: 'before' });
    assert.deepEqual(chooseThemeMarkerRequest(['b', 'd'], ['a', 'b', 'c', 'd']), { sourceSpaceId: 'd', anchorSpaceId: 'b', placement: 'before' });
});
for (const [name, visible, ordered] of [
    ['one visible', ['a'], ['a', 'b']], ['duplicate visible', ['a', 'a'], ['a', 'b']],
    ['duplicate stored', ['a', 'b'], ['a', 'b', 'b']], ['stale chip', ['a', 'missing'], ['a', 'b']],
    ['reversed DOM', ['b', 'a'], ['a', 'b']], ['invalid identity', ['a', null], ['a', 'b']]
]) test(`theme marker planning rejects ${name}`, () => assert.throws(() => chooseThemeMarkerRequest(visible, ordered)));


test('theme composite baseline drains authoritative reconciliation before raw API capture', async () => {
    const order = [], live = { spaces: [{ id: 'work', color: 'blue', temporaryTabs: [1] }], tabs: [{ id: 1, groupId: -1 }] };
    const snapshot = async windowId => {
        assert.equal(windowId, 7); order.push('snapshot');
        // Queue draining can reconcile live group/member metadata before capture.
        live.tabs[0].groupId = 22;
        return { spaces: structuredClone(live.spaces) };
    };
    const page = { evaluate: async () => { order.push('raw'); return structuredClone(live); } };
    const result = await readThemeFixtureState(page, snapshot, 7);
    assert.deepEqual(order, ['snapshot', 'raw']);
    assert.equal(result.tabs[0].groupId, 22);
    assert.deepEqual(result.bridgeColors, [{ id: 'work', color: 'blue' }]);
});
test('theme baseline fails closed if the authoritative barrier fails or v1 colors acquire tint', async () => {
    let reads = 0; const page = { evaluate: async () => { reads++; return {}; } };
    await assert.rejects(() => readThemeFixtureState(page, async () => { throw Error('snapshot failed'); }, 7), /snapshot failed/);
    assert.equal(reads, 0);
    await assert.rejects(() => readThemeFixtureState(page, async () => ({ spaces: [{ id: 'work', color: 'blue', customTint: '#ffffff' }] }), 7), /v1 must not acquire/);
});

test('cleanup targets derive from the same captured baseline without another asynchronous raw read', () => {
    const before = state(); before.windows = [{ id: 1, focused: false }, { id: 2, focused: true }];
    before.tabs.push({ id: 8, active: false }, { id: 9, active: true });
    const result = themeRestorationState(before, 'work');
    assert.deepEqual(result, { space: before.spaces[0], appearance: before.appearance, activeSpaces: before.activeSpaces, activeTabs: [1, 9], focusedWindowId: 2 });
    result.space.color = 'red'; result.activeSpaces[1] = 'other';
    assert.equal(before.spaces[0].color, 'blue'); assert.equal(before.activeSpaces[1], 'work');
    assert.throws(() => themeRestorationState(before, 'missing'));
});

test('theme cleanup cannot run when exact restoration target derivation fails', async () => {
    const source = await readSourceText(new URL('../../scripts/paired-chrome-space-theme.mjs', import.meta.url));
    assert.match(source, /beforeFixture = await read\(\);\s+original = themeRestorationState\(beforeFixture, target\.id\);/);
    assert.match(source, /finally \{\s+if \(original\) await finishBookmarkFixture\(\[/);
});
