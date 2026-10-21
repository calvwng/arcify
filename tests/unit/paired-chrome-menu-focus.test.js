// Pure evidence/adapter regressions only. No browser process is started here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { readSourceText } from '../source-text.js';
import { observeExternalMenuFocus, readExternalMenuFocus, stopExternalMenuFocus,
    assertExternalMenuOpened, assertExternalMenuDismissed, exerciseExternalMenuDismissal,
    readMenuPreservedState } from '../../scripts/paired-chrome-menu-focus.mjs';

const source = () => ({ url: 'chrome-extension://arcify/sidebar.html', timeOrigin: 10, visibility: 'visible', focused: true, menuCount: 1, events: [] });
const destination = () => ({ url: 'http://127.0.0.1/tab-menu/0123456789abcdef0123456789abcdef/outside', timeOrigin: 20, visibility: 'visible', focused: false,
    targetCount: 1, targetFocused: false, targetValue: 'untouched', events: [] });
const blur = () => ({ type: 'blur', trusted: true, visibility: 'visible', focused: false });
const click = () => ({ type: 'click', trusted: true, key: null, targetMatches: true });
const key = () => ({ type: 'keydown', trusted: true, key: 'ArrowLeft', targetMatches: true });
const proof = () => ({ before: source(), source: { ...source(), menuCount: 0, focused: false, events: [blur()] },
    destinationBefore: destination(), destination: { ...destination(), focused: true, targetFocused: true, events: [click(), key()] } });

test('outside evidence distinguishes genuine visible-window blur from hidden-document lifecycle', () => {
    const p = proof(); assert.match(assertExternalMenuDismissed(p), /window blur while sidebar document remained visible/);
    p.source.visibility = 'hidden'; p.source.events = [{ type: 'visibilitychange', trusted: true, visibility: 'hidden', focused: false }];
    assert.match(assertExternalMenuDismissed(p), /hidden sidebar document lifecycle/);
});
for (const [name, mutate] of Object.entries({
    wrongSource: p => p.before.url = p.source.url = 'http://127.0.0.1/page', missingInputBaseline: p => p.destinationBefore.targetCount = 0,
    extensionDestination: p => p.destinationBefore.url = p.destination.url = 'chrome-extension://arcify/sidebar.html',
    wrongExternalPage: p => p.destinationBefore.url = p.destination.url = 'http://127.0.0.1/other',
    neverOpened: p => p.before.menuCount = 0, duplicateMenus: p => p.before.menuCount = 2,
    backgroundBeforeInput: p => p.before.visibility = 'hidden', unfocusedBeforeInput: p => p.before.focused = false,
    staleMenu: p => p.source.menuCount = 1, hiddenStaleMenu: p => { p.source.visibility = 'hidden'; p.source.menuCount = 1; },
    sourceReloaded: p => p.source.timeOrigin++, sourceNavigated: p => p.source.url = 'chrome-extension://arcify/other.html',
    sourceStealsFocus: p => p.source.focused = true, destinationBlurred: p => p.destination.focused = false,
    wrongInput: p => p.destination.targetFocused = false, duplicateInput: p => p.destination.targetCount = 2,
    lostInput: p => p.destination.targetValue = 'changed', hiddenDestination: p => p.destination.visibility = 'hidden',
    destinationReloaded: p => p.destination.timeOrigin++, destinationNavigated: p => p.destination.url += '/other',
    missingClick: p => p.destination.events.shift(), fakeClick: p => p.destination.events[0].trusted = false,
    replayedClick: p => p.destination.events.push(click()), clickWrongTarget: p => p.destination.events[0].targetMatches = false,
    noKey: p => p.destination.events.pop(), fakeKey: p => p.destination.events[1].trusted = false,
    wrongKey: p => p.destination.events[1].key = 'Escape', keyWrongTarget: p => p.destination.events[1].targetMatches = false,
    replayedKey: p => p.destination.events.push(key()), noLifecycle: p => p.source.events = [],
    syntheticBlur: p => p.source.events[0].trusted = false,
    focusOnly: p => p.source.events[0].type = 'focus',
    visibilityStillVisible: p => p.source.events[0] = { type: 'visibilitychange', trusted: true, visibility: 'visible' },
    fakeHiddenEvent: p => p.source.events[0] = { type: 'visibilitychange', trusted: false, visibility: 'hidden' }
})) test(`outside evidence rejects ${name}`, () => { const p = proof(); mutate(p); assert.throws(() => assertExternalMenuDismissed(p)); });
test('pre-key checkpoint rejects any unexpected keyboard dispatch', () => {
    const p = proof(); assert.throws(() => assertExternalMenuDismissed(p, { requireKey: false }));
    p.destination.events.pop(); assertExternalMenuDismissed(p, { requireKey: false });
});

function harness(options = {}) {
    const calls = [], records = []; let src = source(), dst = destination(), captures = 0;
    const evaluate = side => async fn => {
        calls.push(`${side}:${fn.name}`);
        if (fn === stopExternalMenuFocus) return;
        if (fn === observeExternalMenuFocus || fn === readExternalMenuFocus) return structuredClone(side === 'source' ? src : dst);
        throw new Error('Unexpected page evaluation');
    };
    const sidebar = { url: () => src.url, evaluate: evaluate('source'), bringToFront() { assert.fail('Never foreground source during observation'); } };
    const external = { url: () => dst.url, evaluate: evaluate('destination'),
        waitForSelector: async selector => { assert.equal(selector, '#page-state'); calls.push('destination:ready'); },
        click: async selector => {
            assert.equal(selector, '#page-state'); calls.push('destination:click');
            if (options.clickError) throw options.clickError;
            dst.focused = true; dst.targetFocused = true; dst.events.push(click());
            src.focused = false; src.events.push(blur()); if (!options.menuStays) src.menuCount = 0;
        },
        keyboard: { press: async value => { assert.equal(value, 'ArrowLeft'); calls.push('destination:key'); if (options.keyError) throw options.keyError; dst.events.push(key()); } } };
    return { sidebar, destination: external, menuSelector: '#menu', label: 'test', calls, records,
        record: async entry => records.push(structuredClone(entry)),
        ui: async (page, label, action) => { assert.equal(page, external); calls.push('destination:foreground'); return action(); },
        poll: async (read, accept) => { calls.push('background:poll'); const state = await read(); assert(accept(state), 'menu removal timed out'); if (options.stealAfterPoll) dst.focused = false; return state; },
        screenshot: async (page, label, required, screenshotOptions) => {
            assert.equal(required, true); assert.deepEqual(screenshotOptions, { fullPage: false }); captures++; calls.push(`screenshot:${page === sidebar ? 'source' : 'destination'}`);
            if (captures === options.failedCapture) throw options.screenshotError;
            if (options.noScreenshot) return null;
            if (captures === 2 && options.stealDuringCapture) dst.focused = false;
            return { filename: `${label}.png`, label, url: page.url(), capturedAt: '2026-10-15T12:00:00Z' };
        } };
}
test('adapter proves menu removal in background before one keyboard dispatch and captures only external destination afterward', async () => {
    const h = harness(), result = await exerciseExternalMenuDismissal(h);
    assert.equal(result.nativePanel, false); assert.equal(result.surface, 'regular sidebar.html tab');
    assert.equal(result.screenshots.length, 2);
    assert.equal(h.calls.filter(call => call === 'destination:foreground').length, 1);
    assert.equal(h.calls.filter(call => call === 'destination:click').length, 1);
    assert.equal(h.calls.filter(call => call === 'destination:key').length, 1);
    const switched = h.calls.indexOf('destination:foreground');
    assert(h.calls.indexOf('background:poll') > switched); assert(h.calls.indexOf('destination:key') > h.calls.indexOf('background:poll'));
    assert(!h.calls.slice(switched).includes('screenshot:source'));
    assert.deepEqual(h.records.map(record => record.phase), ['outside-focus-before-input', 'outside-focus-dismissed']);
    assert.deepEqual(h.calls.slice(-2), ['source:stopExternalMenuFocus', 'destination:stopExternalMenuFocus']);
});
for (const options of [{ menuStays: true }, { stealAfterPoll: true }, { stealDuringCapture: true }, { noScreenshot: true }]) {
    test(`adapter fails without reopening or replaying ${JSON.stringify(options)}`, async () => {
        const h = harness(options); await assert.rejects(exerciseExternalMenuDismissal(h));
        assert(h.calls.filter(call => call === 'destination:foreground').length <= 1);
        assert(h.calls.filter(call => call === 'destination:click').length <= 1);
        assert.equal(h.records.at(-1).phase, 'outside-focus-failed');
        if (options.stealAfterPoll || options.menuStays) assert(!h.calls.includes('destination:key'));
        assert.deepEqual(h.calls.slice(-2), ['source:stopExternalMenuFocus', 'destination:stopExternalMenuFocus']);
    });
}
for (const options of [{ clickError: Error('Uncertain click dispatch') }, { keyError: Error('Uncertain key dispatch') },
    { failedCapture: 1, screenshotError: Error('Opening screenshot failed') }, { failedCapture: 2, screenshotError: Error('Destination screenshot failed') }]) {
    test(`adapter retains original ${Object.values(options).find(value => value instanceof Error).message}`, async () => {
        const h = harness(options), expected = options.clickError || options.keyError || options.screenshotError;
        await assert.rejects(exerciseExternalMenuDismissal(h), error => error === expected);
        assert(h.calls.filter(call => call === 'destination:click').length <= 1);
        assert(h.calls.filter(call => call === 'destination:key').length <= 1);
    });
}

test('passive observer records bounded trusted flags and removes exact listeners without focus or DOM changes', () => {
    const listeners = new Map(), removals = [], input = { value: 'untouched' };
    const target = side => ({ addEventListener: (name, fn, capture) => listeners.set(`${side}:${name}`, { fn, capture }),
        removeEventListener: (name, fn, capture) => { assert.deepEqual(listeners.get(`${side}:${name}`), { fn, capture }); removals.push(`${side}:${name}`); } });
    const context = { window: target('window'), document: { ...target('document'), visibilityState: 'visible', hasFocus: () => true,
        activeElement: input, querySelector: () => input, querySelectorAll: () => [input] },
        location: { href: 'http://127.0.0.1/outside' }, performance: { timeOrigin: 3 } };
    runInNewContext(`(${observeExternalMenuFocus.toString()})({targetSelector:'#page-state'})`, context);
    for (let i = 0; i < 110; i++) listeners.get('document:click').fn({ type: 'click', isTrusted: i % 2 === 0, target: input });
    const state = runInNewContext(`(${readExternalMenuFocus.toString()})()`, context);
    assert.equal(state.events.length, 100); assert.equal(state.events[0].trusted, true); assert.equal(state.events[1].trusted, false);
    assert.equal(state.targetFocused, true); assert.equal(state.targetValue, 'untouched');
    runInNewContext(`(${stopExternalMenuFocus.toString()})()`, context); assert.equal(removals.length, 6);
});

test('full identity reader retains durable and current-session ownership across every window', async () => {
    const local = { spaces: [{ id: 'space' }], persistentFavorites: [{ id: 'saved' }], tabNameOverridesById: { 7: { name: 'alias' } } };
    const session = { activeSpaces: { 1: 'space', 2: 'other' }, favoriteSession: { bindings: [{ favoriteId: 'saved', windowId: 1, tabId: 7 }] }, spaceSession: { 1: {} } };
    const tree = [{ id: '0', title: '', children: [{ id: '1', parentId: '0', index: 0, title: 'Folder', children: [{ id: '2', parentId: '1', index: 0, title: 'Saved', url: 'https://fixture/' }] }] }];
    const tabs = [{ id: 8, windowId: 2, active: true, pinned: false }, { id: 7, windowId: 1, active: true, pinned: true, mutedInfo: { muted: true } }];
    const context = { chrome: { storage: { local: { get: async () => local }, session: { get: async () => session } }, bookmarks: { getTree: async () => tree },
        tabs: { query: async query => { assert.deepEqual(Object.keys(query), []); return tabs; } } } };
    const state = await runInNewContext(`(${readMenuPreservedState.toString()})()`, context);
    assert.equal(state.local, local); assert.equal(state.session, session);
    assert.deepEqual(JSON.parse(JSON.stringify(state.bookmarks)), tree);
    assert.deepEqual(Array.from(state.tabs, tab => [tab.id, tab.windowId, tab.active, tab.pinned, tab.muted]), [[7, 1, true, true, true], [8, 2, true, false, false]]);
});

const helperSource = readSourceText(new URL('../../scripts/paired-chrome-menu-focus.mjs', import.meta.url));
test('outside focus helper is passive except real destination input, with no synthetic blur/click, permissions, launch or retry', () => {
    assert.doesNotMatch(helperSource, /dispatchEvent\(|\.focus\(|\.blur\(|\.launch\(|overridePermissions|--no-sandbox|retry|setTimeout/);
    assert.match(helperSource, /await destination\.click\('#page-state'\)/); assert.match(helperSource, /await destination\.keyboard\.press\('ArrowLeft'\)/);
    assert.equal((helperSource.match(/await ui\(/g) || []).length, 1);
    assert.match(helperSource, /await capture\(destination, 'destination-retains-focus'\)/);
});

test('existing paired cases exercise every menu family and preserve guarded execution and exact state', () => {
    const tab = readSourceText(new URL('../../scripts/paired-chrome-tab-menu.mjs', import.meta.url));
    const space = readSourceText(new URL('../../scripts/paired-chrome-space-context.mjs', import.meta.url));
    const favorites = readSourceText(new URL('../../scripts/paired-chrome-persistent-favorites.mjs', import.meta.url));
    for (const label of ['ordinary-tab', 'closed-space-pin', 'saved-folder']) assert(tab.includes(`'${label}'`));
    assert.match(tab, /assertTabMenuCancelled\(before, after\)/); assert.match(tab, /assertTabMenuFixtureEnvironment\(\)/);
    assert.match(space, /label: 'inactive-space'/); assert.match(space, /assertSpaceContextUnchanged\(evidence\.outsideOpen\.before, await read\(\)\)/);
    assert.match(space, /assertSpaceContextFixtureEnvironment\(\)/); assert.match(space, /Choose Change Space Icon with genuine Enter/);
    for (const label of ['saved-favorite', 'native-pin']) assert(favorites.includes(`'${label}'`));
    assert.match(favorites, /assert\.deepEqual\(after, before/); assert.match(favorites, /persistentHintCount, 0/);
    assert.match(favorites, /Keep as saved Favorite/);
    assert.match(favorites, /primaryError = error/); assert.match(favorites, /await finishBookmarkFixture\(\[/);
    assert.match(favorites, /\], primaryError, record\)/); assert.match(favorites, /captureVisibleFailurePage/);
    for (const fixture of [tab, space, favorites]) {
        assert.match(fixture, /assert\(!\[fixture\.windowA, fixture\.windowB\]\.includes\(outsideWindow\.id\)\)/);
        assert.match(fixture, /chrome\.windows\.remove\(id\),\s*outsideWindow\.id/);
    }
});
test('workflow watches shared lifecycle and evidence without changing runner launch or existing window-B gates', () => {
    const workflow = readSourceText(new URL('../../.github/workflows/paired-extension-smoke.yml', import.meta.url));
    const runner = readSourceText(new URL('../../scripts/paired-chrome-smoke.mjs', import.meta.url));
    for (const path of ['context-menu-session.js', 'tests/unit/context-menu-session.test.js', 'scripts/paired-chrome-menu-focus.mjs', 'tests/unit/paired-chrome-menu-focus.test.js']) assert(workflow.includes(`- '${path}'`));
    assert.match(runner, /await windowBState\(\), fixture\.windowBBaseline/);
    assert.match(runner, /process\.env\.GITHUB_ACTIONS !== 'true' \|\| process\.env\.CI !== 'true'/);
    assert.match(runner, /process\.getuid\?\.\(\) === 0/);
    assert.match(runner, /exercisePersistentFavorites\(\{apiPage:arcifyOptions,newTabPage,pageForUrl/);
    assert.match(runner, /exerciseSpaceContextBasics\(\{ apiPage:arcifyOptions,newTabPage,pageForUrl/);
});
