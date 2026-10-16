// Pure evidence validators and a mocked driver adapter. These tests never launch Chrome.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { readSourceText } from '../source-text.js';
import { EMOJI_INPUT_SELECTOR, SPACE_EMOJI_EXAMPLES, assertSpaceIconInputEnvironment,
    installSpaceEmojiInputObservation, readSpaceEmojiEditor, assertSpaceEmojiEditor, assertSpaceEmojiInputEvents,
    replaceSpaceEmojiWithInput, assertSpaceNameAppearance, assertSpaceChipAccessibility,
    assertSpaceAppearanceOnlyChanged, assertIconOnlySpaceReordered, assertIconOnlySpaceActivated, finishIconOnlySpaceDrag,
    readSpaceChipInputGeometry, planSpaceChipInputReveal, assertSpaceChipInputRevealed, clickUnobscuredSpaceChip } from '../../scripts/paired-chrome-space-icon-input.mjs';

const event = (type, fields = {}) => ({ type, trusted: true, key: null, ctrlKey: false, inputType: null, data: null, composing: false, value: '', ...fields });
const events = (value, route = 'keyboard') => [event('keydown', { key: 'a', ctrlKey: true }),
    ...(route === 'paste' ? [event('keydown', { key: 'v', ctrlKey: true }), event('paste')] : []),
    event('beforeinput', { inputType: route === 'paste' ? 'insertFromPaste' : 'insertText', data: value }),
    event('input', { inputType: route === 'paste' ? 'insertFromPaste' : 'insertText', data: value, value })];
const editor = (value = '👩🏽‍💻', route = 'keyboard') => ({ value, label: 'Emoji', type: 'text', maxLength: -1,
    disabled: false, invalid: null, describedBy: 'spaceEmojiHint', hint: 'Type or paste one emoji. Leave empty to remove the icon.',
    save: 'Save emoji', saveDisabled: false, alert: '', alertRole: 'alert', visible: true, focused: true,
    rect: { x: 26, y: 40, width: 172, height: 34 }, viewport: { width: 224, height: 600 }, events: events(value, route) });

test('emoji matrix includes exact ZWJ, modifier, regional flag and variation sequences across both native input routes', () => {
    assert.deepEqual(SPACE_EMOJI_EXAMPLES.map(({ name, value, route, submit }) => [name, value, route, submit]), [
        ['zwj-skin-tone', '\u{1F469}\u{1F3FD}\u200D\u{1F4BB}', 'keyboard', 'Enter'],
        ['regional-flag', '\u{1F1FA}\u{1F1F3}', 'paste', 'button'],
        ['variation-selector', '\u2708\uFE0F', 'paste', 'Enter'],
        ['skin-tone', '\u{1F44D}\u{1F3FD}', 'keyboard', 'button'],
        ['trimmed-zwj-flag', '  \u{1F3F3}\uFE0F\u200D\u{1F308}  ', 'paste', 'Enter']
    ]);
    for (const example of SPACE_EMOJI_EXAMPLES) {
        assertSpaceEmojiEditor(editor(example.value, example.route), { value: example.value });
        assertSpaceEmojiInputEvents(events(example.value, example.route), example);
    }
});
for (const [name, mutate] of Object.entries({ truncated: s => s.value = '👩', maxlength: s => s.maxLength = 2, noLabel: s => s.label = '', wrongType: s => s.type = 'number',
    hidden: s => s.visible = false, blurred: s => s.focused = false, disabled: s => s.disabled = true, missingSave: s => s.save = '', disabledSave: s => s.saveDisabled = true,
    noDescription: s => s.describedBy = null, noHint: s => s.hint = '', staleError: s => s.alert = 'Old error', invalid: s => s.invalid = 'true', wrongAlertRole: s => s.alertRole = null,
    clipped: s => s.rect.x = -1, zeroWidth: s => s.rect.width = 0, nonfinite: s => s.rect.y = NaN
})) test(`emoji editor proof rejects ${name}`, () => { const state = editor(); mutate(state); assert.throws(() => assertSpaceEmojiEditor(state, { value: '👩🏽‍💻' })); });
test('invalid input proof requires the complete unchanged string, validation state and accessible error', () => {
    const state = { ...editor('🚀⭐'), invalid: 'true', alert: 'Enter one complete emoji, or leave this field empty to remove the icon.' };
    assertSpaceEmojiEditor(state, { value: '🚀⭐', invalid: true });
    for (const patch of [{ value: '🚀' }, { invalid: null }, { alert: '' }, { focused: false }]) assert.throws(() => assertSpaceEmojiEditor({ ...state, ...patch }, { value: '🚀⭐', invalid: true }));
});
for (const route of ['paste', 'keyboard']) {
    test(`${route} proof rejects untrusted, missing, truncated and invented input`, () => {
        const value = '👩🏽‍💻', mutations = [s => { s[0].trusted = false; }, s => { s.at(-1).value = '👩'; }, s => s.splice(0, 1),
            s => s.splice(s.findIndex(e => e.type === 'beforeinput'), 1), s => s.splice(s.findIndex(e => e.type === 'input'), 1)];
        if (route === 'paste') mutations.push(s => s.splice(s.findIndex(e => e.type === 'paste'), 1), s => { s.at(-1).inputType = 'insertText'; }, s => s.push(event('paste')));
        else mutations.push(s => s.push(event('paste')), s => { s.at(-1).inputType = 'insertFromPaste'; });
        for (const mutate of mutations) { const state = events(value, route); mutate(state); assert.throws(() => assertSpaceEmojiInputEvents(state, { value, route })); }
    });
    test(`${route} adapter uses actual Tab, keys and clipboard once without DOM writes`, async () => {
        const calls = [], value = '👩🏽‍💻';
        const page = { keyboard: Object.fromEntries(['down', 'up', 'press', 'type'].map(method => [method, async key => calls.push([method, key])])),
            evaluate: async (fn, arg) => {
                if (fn === installSpaceEmojiInputObservation) { calls.push(['observe']); return; }
                if (fn === readSpaceEmojiEditor) return editor(value, route);
                if (fn.toString().includes('navigator.clipboard.writeText')) { calls.push(['clipboardWrite', arg]); return; }
                assert.equal(arg, EMOJI_INPUT_SELECTOR); return true;
            }, waitForFunction: async (_fn, _options, actual) => assert.equal(actual, value) };
        await replaceSpaceEmojiWithInput(page, value, route);
        assert.deepEqual(calls, [['observe'], ...(route === 'paste' ? [['clipboardWrite', value]] : []), ['down', 'Control'], ['press', 'KeyA'], ['up', 'Control'],
            ...(route === 'paste' ? [['down', 'Control'], ['press', 'KeyV'], ['up', 'Control']] : [['press', 'Backspace'], ['type', value]])]);
    });
}
test('uncertain paste is never replayed or replaced with fake input, and modifier keys are released', async () => {
    const calls = [], page = { evaluate: async () => true, keyboard: { down: async key => calls.push(`down:${key}`), up: async key => calls.push(`up:${key}`),
        press: async key => { calls.push(key); if (key === 'KeyV') throw Error('Uncertain native paste'); } } };
    await assert.rejects(replaceSpaceEmojiWithInput(page, '🇺🇳', 'paste'), /Uncertain native paste/);
    assert.equal(calls.filter(key => key === 'KeyV').length, 1); assert.equal(calls.at(-1), 'up:Control');
});
test('input observer records native provenance passively and replaces old listeners without replaying events', () => {
    const added = [], removed = [], previous = [];
    const context = { document: { addEventListener: (...args) => added.push(args), removeEventListener: (...args) => removed.push(args), querySelector: () => ({ value: '🇺🇳' }) },
        __spaceEmojiInputObservation: { stop: () => previous.push('stop') } };
    runInNewContext(`(${installSpaceEmojiInputObservation.toString()})()`, context);
    assert.deepEqual(previous, ['stop']); assert.equal(added.length, 9);
    for (const [_type, _handler, options] of added) { assert.equal(options.capture, true); assert.equal(options.passive, true); }
    added[0][1]({ type: 'input', isTrusted: true, inputType: 'insertFromPaste', target: { closest: () => ({}) } });
    assert.equal(context.__spaceEmojiInputObservation.events[0].value, '🇺🇳');
    assert.equal(context.__spaceEmojiInputObservation.events[0].trusted, true);
    context.__spaceEmojiInputObservation.stop(); assert.equal(removed.length, added.length);
});

const spaces = () => [{ id: 'home', name: 'Personal', temporaryTabs: [], icon: null }, { id: 'work', name: 'Work', temporaryTabs: [22], icon: 'star' }];
const appearance = (hidden = true) => ({ hideNames: String(hidden), activeSpaceId: 'home', viewport: { width: 224, height: 600 },
    chips: spaces().map(space => ({ id: space.id, name: space.name, headerName: space.name, nameVisible: !hidden,
        title: `${space.name}\nDrag to reorder. Keyboard: Alt+Shift+Left or Right. Right-click or Shift+F10 for Space options.`,
        aria: `Switch to space ${space.name}`, shortcuts: 'Alt+Shift+ArrowLeft Alt+Shift+ArrowRight Shift+F10', tag: 'BUTTON', disabled: false,
        draggable: true, tabIndex: 0, active: space.id === 'home', glyph: space.icon ? '⭐' : null, iconVisible: Boolean(space.icon), iconAriaHidden: space.icon ? 'true' : null,
        fallback: space.icon ? null : '●', fallbackVisible: !space.icon && hidden, fallbackAriaHidden: space.icon ? null : 'true', rect: { x: 8, y: 560, width: hidden ? 32 : 80, height: 32 } })) });
const appearanceRequest = hidden => ({ spaces: spaces(), activeSpaceId: 'home', hidden });
test('switcher proof preserves full names, native titles and labels while allowing only visual name hiding', () => {
    for (const hidden of [true, false]) assertSpaceNameAppearance(appearance(hidden), appearanceRequest(hidden));
});
for (const [name, mutate] of Object.entries({ stillNamed: s => s.chips[0].nameVisible = true, missingName: s => s.chips[0].name = '', headerChanged: s => s.chips[0].headerName = 'P',
    tooltipLost: s => s.chips[0].title = 'Drag to reorder.', ariaLost: s => s.chips[0].aria = '●', shortcutLost: s => s.chips[0].shortcuts = '',
    missingFallback: s => s.chips[0].fallbackVisible = false, fallbackNoise: s => s.chips[0].fallbackAriaHidden = null, iconLost: s => { s.chips[1].glyph = null; s.chips[1].iconVisible = false; },
    wrongIcon: s => s.chips[1].glyph = '🚀', glyphNoise: s => s.chips[1].iconAriaHidden = null, activated: s => s.chips[0].active = false,
    notDraggable: s => s.chips[0].draggable = false, disabled: s => s.chips[0].disabled = true, untabbable: s => s.chips[0].tabIndex = -1,
    reordered: s => s.chips.reverse(), duplicated: s => s.chips.push(s.chips[0]), collapsedTarget: s => s.chips[0].rect.height = 2, wrongWidth: s => s.chips[0].rect.width = 80
})) test(`icon-only projection rejects ${name}`, () => { const state = appearance(); mutate(state); assert.throws(() => assertSpaceNameAppearance(state, appearanceRequest(true))); });
test('accessibility proof checks the actual Chrome button name, not hidden text or the DOM aria attribute alone', () => {
    const space = spaces()[1]; assertSpaceChipAccessibility({ role: 'button', name: 'Switch to space Work' }, space);
    for (const snapshot of [null, { role: 'generic', name: 'Switch to space Work' }, { role: 'button', name: '⭐' }, { role: 'button', name: 'Switch to space Work', disabled: true }]) assert.throws(() => assertSpaceChipAccessibility(snapshot, space));
});
const durable = () => ({ spaces: spaces(), appearance: { favoritesLayout: 'standard', favoriteTileSize: 44, spaceHeaderSize: 16, hideSpaceNames: false },
    registry: { folder: { spaceUuid: 'work', name: 'Work', icon: 'star' } }, activeSpaces: { 1: 'home', 2: 'work' },
    bookmarks: [{ id: 'folder', title: 'Work' }], favorites: [{ id: 'f', title: 'Keep' }], bindings: { 22: { bookmarkId: 'pin' } },
    tabs: [{ id: 21, windowId: 1, index: 0, url: 'https://one.test', active: true, groupId: -1 }, { id: 22, windowId: 1, index: 1, url: 'https://two.test', active: false, groupId: -1 }, { id: 23, windowId: 2, index: 0, url: 'https://three.test', active: true, groupId: -1 }] });
const mutateCases = { rename: s => s.spaces[0].name = 'Changed', icon: s => s.spaces.find(space => space.id === 'home').icon = 'star', membership: s => s.spaces.find(space => space.id === 'work').temporaryTabs = [],
    registry: s => s.registry.folder.spaceUuid = 'home', bookmark: s => s.bookmarks.pop(), favorite: s => s.favorites.pop(), binding: s => s.bindings = {},
    navigate: s => s.tabs[0].url = 'https://changed.test', move: s => s.tabs[0].windowId = 2, close: s => s.tabs.pop(), nativeOrder: s => s.tabs[0].index = 5,
    group: s => s.tabs[0].groupId = 8, unrelatedOption: s => s.appearance.favoriteTileSize = 64, otherWindow: s => s.activeSpaces[2] = 'home' };
for (const kind of ['setting', 'reorder', 'selection']) {
    const after = before => {
        const state = structuredClone(before);
        if (kind === 'setting') state.appearance.hideSpaceNames = true;
        if (kind === 'reorder') state.spaces.reverse();
        if (kind === 'selection') { state.activeSpaces[1] = 'work'; state.spaces[1].lastTab = 22; state.tabs[0].active = false; state.tabs[1].active = true; }
        return state;
    };
    const verify = (before, state) => kind === 'setting' ? assertSpaceAppearanceOnlyChanged(before, state, true) : kind === 'reorder' ? assertIconOnlySpaceReordered(before, state, ['work', 'home']) : assertIconOnlySpaceActivated(before, state, { spaceId: 'work', windowId: 1, tabId: 22 });
    test(`${kind} proof permits exactly its intended change`, () => { const before = durable(); verify(before, after(before)); });
    for (const [name, mutate] of Object.entries(mutateCases)) test(`${kind} rejects unrelated ${name}`, () => { const before = durable(), state = after(before); mutate(state); assert.throws(() => verify(before, state)); });
}

test('new browser entry points remain non-root CI only; validators import without touching a browser', () => {
    assertSpaceIconInputEnvironment({ GITHUB_ACTIONS: 'true', CI: 'true' }, 1001);
    for (const env of [{}, { CI: 'true' }, { GITHUB_ACTIONS: 'true' }]) assert.throws(() => assertSpaceIconInputEnvironment(env, 1001));
    assert.throws(() => assertSpaceIconInputEnvironment({ GITHUB_ACTIONS: 'true', CI: 'true' }, 0));
    const source = readSourceText(new URL('../../scripts/paired-chrome-space-icon-input.mjs', import.meta.url));
    for (const name of ['exerciseSpaceEmojiInput', 'exerciseSpaceIconOnlySwitcher']) assert.match(source, new RegExp(`export async function ${name}[^\\n]+\\n    assertSpaceIconInputEnvironment\\(\\);`));
    assert.doesNotMatch(source, /dispatchEvent\(|\.value\s*=(?!=)|\.checked\s*=(?!=)|navigator\.clipboard\.read|overridePermissions|\.launch\(|spawn\(|execFile|waitForTimeout|setTimeout\(|sleep\(/);
    assert.match(source, /navigator\.clipboard\.writeText\(text\)/); assert.match(source, /page\.keyboard\.press\('KeyV'\)/);
    assert.match(source, /page\.accessibility\.snapshot\(\{ root: button, interestingOnly: false \}\)/);
    assert.match(source, /assertAcceptedSpaceDragover\(await page\.evaluate\(readSpaceDragObservation\), destination\)/);
    assert.match(source, /assertMarkerScreenshotPixels/); assert.match(source, /Input\.cancelDragging/);
});
test('emoji and icon-only proof is mandatory inside existing full case 37 with preserved full-suite coverage and 5/4 supplemental plans', () => {
    const context = readSourceText(new URL('../../scripts/paired-chrome-space-context.mjs', import.meta.url));
    const smoke = readSourceText(new URL('../../scripts/paired-chrome-smoke.mjs', import.meta.url));
    const plan = readSourceText(new URL('../../scripts/paired-chrome-run-plan.mjs', import.meta.url));
    const workflow = readSourceText(new URL('../../.github/workflows/paired-extension-smoke.yml', import.meta.url));
    for (const name of ['exerciseSpaceEmojiInput', 'exerciseSpaceIconOnlySwitcher']) assert.equal((context.match(new RegExp(`await ${name}\\(`, 'g')) || []).length, 1);
    assert.match(context, /\.space-emoji-form input', node => node === document\.activeElement/);
    assert.match(context, /assertIconOnlySpaceActivated\(beforeIconOnlyActivation, afterIconOnlyActivation/);
    assert.match(smoke, /await step\(stepNames\[37\], \(\) => exerciseSpaceContextBasics/);
    assert.match(smoke, /snapshot,poll,fixture,arcifyId,screenshotBytes:shot=>readFile\(resolve\(OUTPUT,shot\.filename\)\)/);
    assert.match(plan, /const FAVORITE_LIFECYCLE_CASE_INDICES = Object\.freeze\(\[0, 1, 2, 36, 32\]\)/);
    assert.match(plan, /const NATIVE_SPLIT_CASE_INDICES = Object\.freeze\(\[0, 1, 2, 39\]\)/);
    for (const path of ['scripts/paired-chrome-space-icon-input.mjs', 'tests/unit/paired-chrome-space-icon-input.test.js', 'docs/space-icon-input-validation.md']) assert(workflow.includes(`- '${path}'`));
    assert.match(smoke, /IME candidate windows\/composition/); assert.match(smoke, /tooltip painting is not captured/);
});

test('held mouse before dragstart releases once without requiring an impossible dragend', async () => {
    const calls = [];
    await finishIconOnlySpaceDrag({ held: true, read: async () => ({ events: [] }), cancel: async () => calls.push('cancel'), ended: async () => calls.push('ended'),
        release: async () => calls.push('release'), dispose: [async () => calls.push('source'), async () => calls.push('target')] });
    assert.deepEqual(calls, ['release', 'source', 'target']);
});
test('started drag cancels with trusted dragend before release and disposes both handles', async () => {
    const calls = [];
    await finishIconOnlySpaceDrag({ held: true, read: async () => ({ events: [event('dragstart')] }), cancel: async () => calls.push('cancel'),
        ended: async () => { calls.push('ended'); return { events: [event('dragstart'), event('dragend')] }; },
        release: async () => calls.push('release'), dispose: [async () => calls.push('source'), async () => calls.push('target')] });
    assert.deepEqual(calls, ['cancel', 'ended', 'release', 'source', 'target']);
});
test('failed drag cancellation never releases a live drop or masks original error and still disposes geometry', async () => {
    const calls = [], primaryError = Error('Original failure');
    await finishIconOnlySpaceDrag({ held: true, primaryError, read: async () => ({ events: [event('dragstart')] }), cancel: async () => { calls.push('cancel'); throw Error('Cancel failed'); },
        release: async () => calls.push('release'), dispose: [async () => { calls.push('source'); throw Error('Source disposal failed'); }, async () => calls.push('target')] });
    assert.deepEqual(calls, ['cancel', 'source', 'target']); assert.equal(primaryError.message, 'Original failure');
    assert.deepEqual(primaryError.dragCleanupErrors, ['Cancel failed', 'Source disposal failed']);
});
test('drag handles are always disposed even when native input completed successfully', async () => {
    const calls = [];
    await assert.rejects(finishIconOnlySpaceDrag({ held: false, dispose: [async () => { calls.push('source'); throw Error('Dispose failed'); }, async () => calls.push('target')] }), /Dispose failed/);
    assert.deepEqual(calls, ['source', 'target']);
});
test('cross-window renders are polled through their complete assertion after persisted ordering changes', () => {
    const source = readSourceText(new URL('../../scripts/paired-chrome-space-icon-input.mjs', import.meta.url));
    assert.match(source, /poll\(\(\) => page\.evaluate\(readSpaceNameAppearance\), view => \{\s*try \{ assertSpaceNameAppearance\(view, expected\); return true;/);
    const context = readSourceText(new URL('../../scripts/paired-chrome-space-context.mjs', import.meta.url));
    assert(context.indexOf('evidence.customForIconOnlySaved') < context.indexOf('evidence.iconOnly = await exerciseSpaceIconOnlySwitcher'));
    assert.match(context, /glyph: '👩🏽‍💻', requireVisibleHeader: true/);
});

// Geometry from the hosted screenshot142/report: the fifth 32px chip center
// overlaps the separate + control. The prior click target was not recorded, so
// interception is an inference; the revised fixture observes it before input.
const occludedChip = () => ({ spaceId: 'custom', matches: 1, visibility: 'visible', focused: true,
    viewport: { width: 224, height: 600 }, activeSpaceId: 'work',
    chip: { x: 168, y: 533, width: 32, height: 32, visible: true },
    overlay: { x: 184, y: 533, width: 32, height: 32, visible: true },
    strip: { x: 0, y: 525, width: 216, height: 44, visible: true, scrollLeft: 0, scrollWidth: 248, clientWidth: 216 },
    center: { x: 184, y: 549, hit: { spaceId: null, add: true, inSwitcher: false } },
    pointer: { x: 90, y: 549, hit: { spaceId: 'personal', add: false, inSwitcher: true } } });
const uncoveredChip = before => {
    const state = structuredClone(before); state.strip.scrollLeft = 32; state.chip.x -= 32;
    state.center.x -= 32; state.center.hit = { spaceId: 'custom', add: false, inSwitcher: true }; return state;
};
test('fifth icon-only chip reveal plans one real bounded wheel outside the separate + overlay', () => {
    const before = occludedChip(), input = planSpaceChipInputReveal(before, 'custom');
    assert.deepEqual(input, { x: 90, y: 549, deltaX: 32, deltaY: 0 });
    assertSpaceChipInputRevealed(before, uncoveredChip(before), input);
    assert.equal(planSpaceChipInputReveal(uncoveredChip(before), 'custom'), null);
});
for (const [name, mutate] of Object.entries({ wrongId: s => s.spaceId = 'other', duplicate: s => s.matches = 2,
    hidden: s => s.visibility = 'hidden', unfocused: s => s.focused = false, hiddenChip: s => s.chip.visible = false,
    hiddenStrip: s => s.strip.visible = false, hiddenOverlay: s => s.overlay.visible = false, invalidGeometry: s => s.chip.x = NaN,
    changedCenter: s => s.center.x = 180, verticalClip: s => { s.chip.y = 580; s.center.y = 596; },
    unknownOverlay: s => s.center.hit.add = false, wrongOverlayPosition: s => s.overlay.x = 200,
    noOverflow: s => s.strip.scrollWidth = 216, impossibleScroll: s => s.strip.scrollLeft = 33,
    wheelOnAdd: s => s.pointer.hit.add = true, wheelOutsideStrip: s => s.pointer.hit.inSwitcher = false,
    wheelOutsideSafeArea: s => s.pointer.x = 190, insufficientScroll: s => s.strip.scrollWidth = 226
})) test(`chip reveal refuses ${name} before input`, () => { const before = occludedChip(); mutate(before); assert.throws(() => planSpaceChipInputReveal(before, 'custom')); });
for (const [name, mutate] of Object.entries({ noMovement: s => s.strip.scrollLeft = 0, wrongMovement: s => s.strip.scrollLeft = 30,
    viewport: s => s.viewport.width = 230, activation: s => s.activeSpaceId = 'custom', metadata: s => s.spaceId = 'other',
    changedStrip: s => s.strip.width++, changedChip: s => s.chip.width++, movedOverlay: s => s.overlay.x++,
    detachedChipMovement: s => { s.chip.x += 2; s.center.x += 2; }, stillOccluded: s => { s.center.hit.spaceId = null; s.center.hit.add = true; }
})) test(`chip reveal rejects ${name} rather than retrying input`, () => { const before = occludedChip(), after = uncoveredChip(before); mutate(after); assert.throws(() => assertSpaceChipInputRevealed(before, after, planSpaceChipInputReveal(before, 'custom'))); });

test('chip input sends one measured wheel and one native click with trusted exact-target evidence', async () => {
    for (const failure of [null, 'wrong-click', 'untrusted', 'wrong-wheel', 'state-change', 'uncertain-click']) {
        const before = occludedChip(), after = uncoveredChip(before), calls = [], records = [], baseline = { activeSpaceId: 'work', names: ['Work', 'Custom'], tabs: [1, 2] };
        let geometryReads = 0, stateReads = 0;
        const inputEvents = [{ type: 'wheel', trusted: true, deltaX: failure === 'wrong-wheel' ? 30 : 32, deltaY: 0, inSwitcher: true, add: false },
            ...['mousedown', 'mouseup', 'click'].map(type => ({ type, trusted: failure !== 'untrusted', x: 152, y: 549, spaceId: failure === 'wrong-click' ? null : 'custom', add: failure === 'wrong-click' }))];
        const page = { mouse: { move: async (...values) => calls.push(['move', ...values]), wheel: async input => calls.push(['wheel', input]),
            click: async (...values) => { calls.push(['click', ...values]); if (failure === 'uncertain-click') throw Error('Uncertain native click'); } },
            evaluate: async (fn, spaceId) => {
                if (fn === readSpaceChipInputGeometry) { assert.equal(spaceId, 'custom'); return geometryReads++ ? after : before; }
                if (fn.toString().includes('const events = globalThis')) { calls.push(['listen']); return; }
                if (fn.toString().includes('__stopSpaceChipNativeInput')) { calls.push(['stop']); return; }
                if (fn.toString().includes('__spaceChipNativeInput')) return inputEvents;
                assert.fail(`Unexpected browser mutation: ${fn}`);
            } };
        const operation = clickUnobscuredSpaceChip({ page, spaceId: 'custom',
            read: async () => { const state = structuredClone(baseline); if (stateReads++ && failure === 'state-change') state.activeSpaceId = 'custom'; return state; },
            unchanged: (a, b) => assert.deepEqual(b, a), poll: async (read, valid) => { const state = await read(); assert(valid(state)); return state; },
            capture: async () => ({ filename: 'required.png' }), record: async value => records.push(value) });
        if (failure) await assert.rejects(operation); else assert.deepEqual((await operation).events, inputEvents);
        assert.equal(calls.filter(([type]) => type === 'wheel').length, 1);
        assert.equal(calls.filter(([type]) => type === 'click').length, failure === 'state-change' ? 0 : 1);
        assert.equal(calls.at(-1)[0], 'stop');
        if (['wrong-click', 'untrusted', 'wrong-wheel'].includes(failure)) assert(records.some(item => item.phase === 'space-chip-observed-native-input'));
    }
});
test('selection wiring keeps the original UUID/native-tab activation assertions and forbids a DOM click or input retry', () => {
    const source = readSourceText(new URL('../../scripts/paired-chrome-space-icon-input.mjs', import.meta.url));
    const helper = source.slice(source.indexOf('export async function clickUnobscuredSpaceChip'), source.indexOf('async function dragIconOnlySpace'));
    assert.equal((helper.match(/page\.mouse\.wheel\(/g) || []).length, 1); assert.equal((helper.match(/page\.mouse\.click\(/g) || []).length, 1);
    assert.match(helper, /assertSpaceChipInputRevealed\(before, await page\.evaluate\(readSpaceChipInputGeometry, spaceId\), input\)/);
    assert.doesNotMatch(helper, /page\.click\(|dispatchEvent\(|\.scrollLeft\s*=|\.click\(\)|setTimeout|sleep\(/);
    const context = readSourceText(new URL('../../scripts/paired-chrome-space-context.mjs', import.meta.url));
    assert.match(context, /clickUnobscuredSpaceChip\(\{ page, spaceId: target\.id, read, unchanged: assertSpaceContextUnchanged, poll, capture, record \}\)/);
    assert.match(context, /document\.querySelector\('\.space\.active'\)\?\.dataset\.spaceId === id/);
    assert.match(context, /tabs => tabs\[0\]\?\.id === seededTabs\[0\]/);
    assert.match(context, /assertIconOnlySpaceActivated\(beforeIconOnlyActivation, afterIconOnlyActivation/);
});
