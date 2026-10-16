// Evidence validators and input adapter only. No browser launches.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readSourceText } from '../source-text.js';
import { runInNewContext } from 'node:vm';
import { SPACE_MENU_ITEMS, SPACE_PICKER_IDS, assertSpaceContextMenu, assertSpaceIconPicker,
    assertSpaceIconProjection, assertSpaceContextUnchanged, assertSpaceIconSaved,
    assertSpaceDeleteWarning, cancelSpaceDeleteWithInput, assertSpaceContextFixtureEnvironment, captureRequiredSpaceScreenshot,
    rightClickFreshSpaceTrigger, assertSpaceFolderScreenshot, readSpaceFolderScreenshot, captureStableSpaceMenu, observeSpaceMenuEvents, observeSpaceContextOpening, assertSpaceMetadataSaved, assertSpaceFolderCreated, SPACE_COLOR_IDS, assertSpaceColorPicker, assertSpaceNameEditor, assertSpaceDetailsProjection, readSpaceDetailsProjection } from '../../scripts/paired-chrome-space-context.mjs';

test('Space detail reader compares resolved theme color while preserving a genuine mismatch', () => {
    const root = {}, container = { style: { getPropertyValue: () => 'var(--chrome-purple-color, rgba(255, 255, 255, 0.1))' } };
    const color = 'rgba(148, 85, 202, 0.2)'; let applied = color;
    const header = { dataset: { spaceId: 'work' }, getClientRects: () => [1], querySelectorAll: () => [],
        querySelector: selector => ({ value: selector === '.space-name' ? 'Work' : 'purple' }) };
    const chip = { dataset: { spaceId: 'work' }, lastElementChild: { textContent: 'Work' }, getAttribute: () => 'Switch to space Work' };
    const document = { documentElement: root,
        querySelectorAll: selector => selector.startsWith('#spaceSwitcher') ? [chip] : [header],
        querySelector: selector => selector === '#sidebar-container' ? container : header };
    const context = { document, getComputedStyle: element => ({ visibility: 'visible', getPropertyValue: () => element === container ? applied : color }) };
    const read = () => runInNewContext(`(${readSpaceDetailsProjection.toString()})('work')`, context);
    const request = { spaceId: 'work', name: 'Work', color: 'purple', requireVisibleTheme: true };
    const state = read(); assert.equal(state.appliedColor, color); assert.notEqual(state.appliedColor, container.style.getPropertyValue('--space-bg-color'));
    assertSpaceDetailsProjection(state, request);
    applied = 'rgba(0, 0, 255, 0.2)'; assert.throws(() => assertSpaceDetailsProjection(read(), request));
});

const geometry = () => ({ rect: { x: 12, y: 30, width: 200, height: 300 }, viewport: { width: 224, height: 600 }, visible: true, focusInside: true });
const menu = () => ({ ...geometry(), role: 'menu', name: 'Space options: Work', items: SPACE_MENU_ITEMS.map(label => ({ label, role: 'menuitem', tag: 'BUTTON', disabled: false })) });
const picker = () => ({ ...geometry(), role: 'dialog', modal: 'true', title: 'Change Space Icon: Work', cancel: 'Cancel', submit: 'Save emoji', input: { label: 'Emoji', maxLength: -1, disabled: false },
    choices: SPACE_PICKER_IDS.map(id => ({ id, label: `Named ${id}`, tag: 'BUTTON', disabled: false, pressed: String(id === 'rocket') })) });
const projection = () => ({ spaceId: 'work', headerCount: 1, chipCount: 1, headerText: '🚀', headerHidden: false,
    headerAriaHidden: 'true', chipText: '🚀', chipAriaHidden: 'true' });
const state = () => ({ spaces: [{ id: 'other', name: 'Other', bookmarkFolderId: 'other-folder', temporaryTabs: [30], spaceBookmarks: [] },
    { id: 'work', name: 'Work', color: 'blue', bookmarkFolderId: 'work-folder', temporaryTabs: [11, 22], spaceBookmarks: [] }],
    registry: { 'other-folder': { spaceUuid: 'other' }, 'work-folder': { spaceUuid: 'work', color: 'blue' } },
    tabs: [{ id: 11, windowId: 1, url: 'https://one.test', active: false }, { id: 22, windowId: 2, url: 'https://two.test', active: false }],
    activeSpaces: { 1: 'other', 2: 'other' }, favorites: [{ id: 'favorite', url: 'https://favorite.test' }], bindings: {},
    bookmarks: [{ id: 'work-folder', children: [{ id: 'nested', children: [{ id: 'link', url: 'https://saved.test' }] }] }] });
const saved = before => { const after = structuredClone(before); after.spaces[1].icon = 'rocket'; after.registry['work-folder'].icon = 'rocket'; return after; };

test('menu proof requires exactly the five approved actions, names, real focus and bounded layout', () => assertSpaceContextMenu(menu(), 'Work'));
for (const [name, mutate] of Object.entries({ missingAction: s => s.items.pop(), reordered: s => s.items.reverse(), wrongTarget: s => s.name = 'Space options: Other',
    hidden: s => s.visible = false, escapedFocus: s => s.focusInside = false, wrongRole: s => s.role = 'list', disabled: s => s.items[0].disabled = true,
    unnamed: s => s.items[1].label = '', wide: s => s.rect.width = 250, offscreen: s => s.rect.y = 550, zeroHeight: s => s.rect.height = 0, invalid: s => s.rect.width = NaN
})) test(`menu proof rejects ${name}`, () => { const s = menu(); mutate(s); assert.throws(() => assertSpaceContextMenu(s, 'Work')); });
test('picker proof includes the bounded allowlist, selected ID, named dialog and Cancel', () => assertSpaceIconPicker(picker(), 'Work', 'rocket'));
for (const [name, mutate] of Object.entries({ missingIcon: s => s.choices.pop(), extraIcon: s => s.choices.push({ id: 'unknown' }), noSelection: s => s.choices.forEach(c => c.pressed = 'false'),
    doubleSelection: s => s.choices[0].pressed = 'true', wrongName: s => s.title = 'Icons', hidden: s => s.visible = false, escapedFocus: s => s.focusInside = false,
    unnamedIcon: s => s.choices[0].label = '', notModal: s => s.modal = null, missingCancel: s => s.cancel = '', clipped: s => s.rect.x = -1
})) test(`picker proof rejects ${name}`, () => { const s = picker(); mutate(s); assert.throws(() => assertSpaceIconPicker(s, 'Work', 'rocket')); });
test('icon projection requires both exact header and switcher and supports the no-icon default', () => {
    assertSpaceIconProjection(projection(), { spaceId: 'work', glyph: '🚀' });
    assertSpaceIconProjection({ ...projection(), headerText: '', headerHidden: true, chipText: null, chipAriaHidden: null }, { spaceId: 'work', glyph: null });
});
for (const [name, mutate] of Object.entries({ wrongTarget: s => s.spaceId = 'other', duplicateHeader: s => s.headerCount = 2, missingChip: s => s.chipCount = 0,
    wrongHeader: s => s.headerText = '⭐', missingHeader: s => s.headerHidden = true, wrongChip: s => s.chipText = '⭐', accessibleNoise: s => s.headerAriaHidden = null
})) test(`icon projection rejects ${name}`, () => { const s = projection(); mutate(s); assert.throws(() => assertSpaceIconProjection(s, { spaceId: 'work', glyph: '🚀' })); });
test('icon persistence proof allows only matching UUID-local and registry icon writes, including reset', () => {
    const before = state(), after = saved(before); assertSpaceIconSaved(before, after, { spaceId: 'work', icon: 'rocket' });
    const reset = structuredClone(after); reset.spaces[1].icon = null; reset.registry['work-folder'].icon = null;
    assertSpaceIconSaved(after, reset, { spaceId: 'work', icon: null });
});
for (const [name, mutate] of Object.entries({ reorder: s => s.spaces.reverse(), activate: s => s.activeSpaces[1] = 'work', changeOther: s => s.spaces[0].name = 'Changed',
    deleteTab: s => s.tabs.pop(), navigateTab: s => s.tabs[0].url = 'https://changed.test', transferTab: s => s.spaces[1].temporaryTabs.pop(), nativeActivate: s => s.tabs[0].active = true,
    deleteFavorite: s => s.favorites.pop(), changeBookmark: s => s.bookmarks[0].children = [], wrongRegistry: s => s.registry['work-folder'].spaceUuid = 'other',
    missingRegistryIcon: s => delete s.registry['work-folder'].icon, missingLocalIcon: s => delete s.spaces[1].icon
})) test(`icon persistence rejects ${name}`, () => { const before = state(), after = saved(before); mutate(after); assert.throws(() => assertSpaceIconSaved(before, after, { spaceId: 'work', icon: 'rocket' })); });
test('delete Cancel and reload proof requires byte-equivalent normalized captured state', () => {
    const before = state(); assertSpaceContextUnchanged(before, structuredClone(before));
    for (const key of Object.keys(before)) { const after = structuredClone(before); after[key] = null; assert.throws(() => assertSpaceContextUnchanged(before, after)); }
});
const warning = 'Delete Space “Work”? This deletes all saved bookmarks and folders in its backing bookmark subtree and closes its owned tabs across all windows. Shared saved Favorites survive. This cannot be undone in Arcify.';
test('delete warning proof requires the exact Space name and every consequence', () => {
    assertSpaceDeleteWarning(warning, 'Work');
    for (const fragment of ['Work', 'all saved bookmarks and folders', 'backing bookmark subtree', 'owned tabs across all windows', 'Shared saved Favorites survive']) assert.throws(() => assertSpaceDeleteWarning(warning.replace(fragment, ''), 'Work'));
});
test('native confirmation input is installed first, dismissed once, and listener is removed', async () => {
    const page = new EventEmitter(); let dismisses = 0, clicks = 0;
    const message = await cancelSpaceDeleteWithInput(page, 'Work', async () => {
        clicks++; assert.equal(page.listenerCount('dialog'), 1);
        page.emit('dialog', { type: () => 'confirm', message: () => warning, dismiss: async () => { dismisses++; } });
    });
    assert.equal(message, warning); assert.equal(dismisses, 1); assert.equal(clicks, 1); assert.equal(page.listenerCount('dialog'), 0);
});
test('unexpected warning is still safely dismissed and never accepted', async () => {
    const page = new EventEmitter(); let dismisses = 0;
    await assert.rejects(cancelSpaceDeleteWithInput(page, 'Work', async () => page.emit('dialog', { type: () => 'confirm', message: () => 'Wrong', dismiss: async () => { dismisses++; } })));
    assert.equal(dismisses, 1); assert.equal(page.listenerCount('dialog'), 0);
});
test('uncertain native dismissal is not replayed', async () => {
    const page = new EventEmitter(); let dismisses = 0;
    await assert.rejects(cancelSpaceDeleteWithInput(page, 'Work', async () => page.emit('dialog', { type: () => 'confirm', message: () => warning,
        dismiss: async () => { dismisses++; throw Error('Uncertain dismissal'); } })), /Uncertain dismissal/);
    assert.equal(dismisses, 1);
});
test('missing dialog times out and uncertain clicks are not retried', async () => {
    const page = new EventEmitter(); let clicks = 0;
    await assert.rejects(cancelSpaceDeleteWithInput(page, 'Work', async () => { clicks++; }, { timeoutMs: 5 }), /did not appear/);
    assert.equal(clicks, 1); assert.equal(page.listenerCount('dialog'), 0);
    await assert.rejects(cancelSpaceDeleteWithInput(page, 'Work', async () => { clicks++; throw Error('Uncertain click'); }), /Uncertain click/);
    assert.equal(clicks, 2); assert.equal(page.listenerCount('dialog'), 0);
});
test('fixture entry point stays separate, uses actual input and cannot launch a browser by import', async () => {
    const source = readSourceText(new URL('../../scripts/paired-chrome-space-context.mjs', import.meta.url));
    assert.match(source, /export async function exerciseSpaceContextBasics/);
    assert.match(source, /element\.click\(\{ button: 'right' \}\)/);
    assert.match(source, /await rightClickFreshSpaceTrigger\(page, selector, record\)/);
    assert.match(source, /page\.keyboard\.press\('F10'\)/); assert.match(source, /page\.reload/);
    assert.doesNotMatch(source, /dispatchEvent\(|puppeteer\.launch|spawn\(|\.value\s*=/);
});

test('visible header proof requires actual visibility and deliberate matching Space activation', () => {
    const visible = { ...projection(), headerVisible: true, activeSpaceId: 'work' };
    assertSpaceIconProjection(visible, { spaceId: 'work', glyph: '🚀', requireVisibleHeader: true });
    assert.throws(() => assertSpaceIconProjection({ ...visible, headerVisible: false }, { spaceId: 'work', glyph: '🚀', requireVisibleHeader: true }));
    assert.throws(() => assertSpaceIconProjection({ ...visible, activeSpaceId: 'other' }, { spaceId: 'work', glyph: '🚀', requireVisibleHeader: true }));
});


test('Space fixture is restricted to non-root GitHub CI before touching any browser data', async () => {
    assertSpaceContextFixtureEnvironment({ GITHUB_ACTIONS: 'true', CI: 'true' }, 1001);
    for (const env of [{}, { GITHUB_ACTIONS: 'true' }, { CI: 'true' }, { GITHUB_ACTIONS: 'false', CI: 'true' }]) {
        assert.throws(() => assertSpaceContextFixtureEnvironment(env, 1001));
    }
    assert.throws(() => assertSpaceContextFixtureEnvironment({ GITHUB_ACTIONS: 'true', CI: 'true' }, 0));
    const source = readSourceText(new URL('../../scripts/paired-chrome-space-context.mjs', import.meta.url));
    assert.match(source, /export async function exerciseSpaceContextBasics[^\n]+\n    assertSpaceContextFixtureEnvironment\(\);/);
});
const shot = () => ({ filename: '01-space.png', label: 'proof', url: 'chrome-extension://fixture/sidebar.html', capturedAt: '2026-10-15T06:00:00.000Z' });
test('every capture explicitly requires a screenshot and retains returned metadata', async () => {
    const page = {}, expected = shot(); let calls = 0;
    const actual = await captureRequiredSpaceScreenshot(async (...args) => { calls++; assert.deepEqual(args, [page, 'proof', true, { fullPage: false }]); return expected; }, page, 'proof');
    assert.equal(actual, expected); assert.equal(calls, 1);
});
for (const [name, mutate] of Object.entries({ missingFilename: s => delete s.filename, wrongFormat: s => s.filename = 'proof.jpg', wrongLabel: s => s.label = 'other', missingUrl: s => delete s.url,
    emptyUrl: s => s.url = '', missingTime: s => delete s.capturedAt, invalidTime: s => s.capturedAt = 'unknown'
})) test(`required screenshot rejects ${name}`, async () => { const s = shot(); mutate(s); await assert.rejects(captureRequiredSpaceScreenshot(async () => s, {}, 'proof')); });
test('missing or failed screenshots fail evidence without replay', async () => {
    await assert.rejects(captureRequiredSpaceScreenshot(async () => undefined, {}, 'proof'), /missing/);
    let calls = 0;
    await assert.rejects(captureRequiredSpaceScreenshot(async () => { calls++; throw Error('Capture failed'); }, {}, 'proof'), /Capture failed/);
    assert.equal(calls, 1);
});

test('unresolved input cannot defeat the missing-dialog deadline', { timeout: 1000 }, async () => {
    const page = new EventEmitter(); let clicks = 0;
    await assert.rejects(cancelSpaceDeleteWithInput(page, 'Work', () => { clicks++; return new Promise(() => {}); }, { timeoutMs: 10 }), /did not appear/);
    assert.equal(clicks, 1); assert.equal(page.listenerCount('dialog'), 0);
});
test('unresolved input cannot swallow a native dismissal rejection', { timeout: 1000 }, async () => {
    const page = new EventEmitter(); let clicks = 0, dismisses = 0;
    await assert.rejects(cancelSpaceDeleteWithInput(page, 'Work', () => {
        clicks++;
        page.emit('dialog', { type: () => 'confirm', message: () => warning, dismiss: async () => { dismisses++; throw Error('Dismissal failed'); } });
        return new Promise(() => {});
    }, { timeoutMs: 500 }), /Dismissal failed/);
    assert.equal(clicks, 1); assert.equal(dismisses, 1); assert.equal(page.listenerCount('dialog'), 0);
});
test('successful dismissal still requires input completion and is bounded by the same deadline', { timeout: 1000 }, async () => {
    const page = new EventEmitter(); let dismisses = 0;
    await assert.rejects(cancelSpaceDeleteWithInput(page, 'Work', () => {
        page.emit('dialog', { type: () => 'confirm', message: () => warning, dismiss: async () => { dismisses++; } });
        return new Promise(() => {});
    }, { timeoutMs: 10 }), /input\/dismissal did not complete/);
    assert.equal(dismisses, 1); assert.equal(page.listenerCount('dialog'), 0);
});
test('pending dismissal cannot defeat the deadline or be replayed', { timeout: 1000 }, async () => {
    const page = new EventEmitter(); let dismisses = 0;
    await assert.rejects(cancelSpaceDeleteWithInput(page, 'Work', async () => page.emit('dialog', { type: () => 'confirm', message: () => warning,
        dismiss: () => { dismisses++; return new Promise(() => {}); } }), { timeoutMs: 10 }), /input\/dismissal did not complete/);
    assert.equal(dismisses, 1); assert.equal(page.listenerCount('dialog'), 0);
});
test('successful confirmation waits for both real input and native dismissal', async () => {
    const page = new EventEmitter(); let releaseInput, settled = false;
    const result = cancelSpaceDeleteWithInput(page, 'Work', () => {
        page.emit('dialog', { type: () => 'confirm', message: () => warning, dismiss: async () => {} });
        return new Promise(resolve => { releaseInput = resolve; });
    });
    result.then(() => { settled = true; });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
    releaseInput(); assert.equal(await result, warning);
});

test('menu and editor observations capture baseline before any gesture and return both proofs', async () => {
    const original = state(), events = [], surface = menu();
    const result = await observeSpaceContextOpening({ read: async () => { events.push('read'); return structuredClone(original); },
        open: async () => events.push('input'), inspect: async () => { events.push('inspect'); return surface; }, inactive: { windowId: 1, spaceId: 'work' } });
    assert.deepEqual(events, ['read', 'input', 'inspect', 'read']);
    assert.deepEqual(result, { before: original, after: original, surface });
});
for (const [name, mutate] of Object.entries({ activate: s => s.activeSpaces[1] = 'work', reorder: s => s.spaces.reverse(), nativeActivate: s => s.tabs[0].active = true,
    bookmark: s => s.bookmarks.pop(), otherSpace: s => s.spaces[0].color = 'red'
})) test(`opening proof rejects opening-only ${name} before it can become an accepted edit baseline`, async () => {
    const live = state();
    await assert.rejects(observeSpaceContextOpening({ read: async () => structuredClone(live), open: async () => mutate(live), inspect: async () => picker(), inactive: { windowId: 1, spaceId: 'work' } }));
});
test('inactive-target proof refuses input when the target is already active in the acting window', async () => {
    const live = state(); live.activeSpaces[1] = 'work'; let inputs = 0;
    await assert.rejects(observeSpaceContextOpening({ read: async () => live, open: async () => { inputs++; }, inspect: async () => menu(), inactive: { windowId: 1, spaceId: 'work' } }), /inactive/);
    assert.equal(inputs, 0);
});
test('inactive-target proof is scoped to the acting window, preserving another window active on that Space', async () => {
    const live = state(); live.activeSpaces[2] = 'work';
    await observeSpaceContextOpening({ read: async () => structuredClone(live), open: async () => {}, inspect: async () => menu(), inactive: { windowId: 1, spaceId: 'work' } });
});

const metadataSaved = (before, changes) => {
    const after = structuredClone(before); Object.assign(after.spaces[1], changes); Object.assign(after.registry['work-folder'], changes);
    if (changes.name !== undefined) after.bookmarks[0].title = changes.name;
    return after;
};
for (const [kind, changes] of Object.entries({ rename: { name: 'Renamed Work' }, color: { color: 'purple', customTint: null } })) {
    test(`${kind} proof allows only exact UUID metadata and corresponding saved fields`, () => {
        const before = state(); assertSpaceMetadataSaved(before, metadataSaved(before, changes), { spaceId: 'work', changes });
    });
    for (const [name, mutate] of Object.entries({ reorder: s => s.spaces.reverse(), activate: s => s.activeSpaces[1] = 'work', changeOther: s => s.spaces[0].name = 'Changed',
        deleteTab: s => s.tabs.pop(), navigateTab: s => s.tabs[0].url = 'https://changed.test', transferTab: s => s.spaces[1].temporaryTabs.pop(), nativeActivate: s => s.tabs[0].active = true,
        deleteFavorite: s => s.favorites.pop(), changeBookmark: s => s.bookmarks[0].children = [], wrongRegistry: s => s.registry['work-folder'].spaceUuid = 'other',
        missingRegistryField: s => delete s.registry['work-folder'][Object.keys(changes)[0]], missingLocalField: s => delete s.spaces[1][Object.keys(changes)[0]],
        unrelatedMetadata: s => s.spaces[1].icon = 'star'
    })) test(`${kind} persistence rejects ${name}`, () => { const before = state(), after = metadataSaved(before, changes); mutate(after); assert.throws(() => assertSpaceMetadataSaved(before, after, { spaceId: 'work', changes })); });
}
test('Rename proof requires the backing bookmark folder title to change too', () => {
    const before = state(), after = metadataSaved(before, { name: 'Renamed Work' }); delete after.bookmarks[0].title;
    assert.throws(() => assertSpaceMetadataSaved(before, after, { spaceId: 'work', changes: { name: 'Renamed Work' } }));
});
const folderCreated = before => {
    const after = structuredClone(before);
    after.bookmarks[0].children.push({ id: 'new-folder', parentId: 'work-folder', index: 1, title: 'New folder', children: [] }); return after;
};
test('New Folder proof permits one appended folder in the exact backing root only', () => {
    const before = state(), after = folderCreated(before);
    assert.deepEqual(assertSpaceFolderCreated(before, after, { spaceId: 'work', title: 'New folder' }), after.bookmarks[0].children[1]);
});
for (const [name, mutate] of Object.entries({ wrongParent: s => s.bookmarks[0].children[1].parentId = 'other-folder', wrongIndex: s => s.bookmarks[0].children[1].index = 0,
    wrongName: s => s.bookmarks[0].children[1].title = 'Other', bookmarkInstead: s => s.bookmarks[0].children[1].url = 'https://wrong.test',
    unexpectedChild: s => s.bookmarks[0].children[1].children.push({ id: 'extra' }), duplicate: s => s.bookmarks[0].children.push({ id: 'second-new' }),
    reorder: s => s.spaces.reverse(), activate: s => s.activeSpaces[1] = 'work', changeOther: s => s.spaces[0].name = 'Changed', deleteTab: s => s.tabs.pop(),
    transferTab: s => s.spaces[1].temporaryTabs.pop(), nativeActivate: s => s.tabs[0].active = true, deleteFavorite: s => s.favorites.pop(),
    changeRegistry: s => s.registry['work-folder'].color = 'red', changeSavedLink: s => s.bookmarks[0].children[0].children[0].url = 'https://changed.test'
})) test(`New Folder proof rejects ${name}`, () => { const before = state(), after = folderCreated(before); mutate(after); assert.throws(() => assertSpaceFolderCreated(before, after, { spaceId: 'work', title: 'New folder' })); });

const colorPicker = () => ({ ...picker(), title: 'Theme Color: Work', choices: SPACE_COLOR_IDS.map(id => ({ id, label: id, tag: 'BUTTON', disabled: false, pressed: String(id === 'purple') })) });
test('basic Theme Color dialog exposes exactly eight named options and the saved selection', () => assertSpaceColorPicker(colorPicker(), 'Work', 'purple'));
for (const [name, mutate] of Object.entries({ missing: s => s.choices.pop(), extra: s => s.choices.push({ id: 'orange' }), wrongSelection: s => s.choices[0].pressed = 'true', wrongTarget: s => s.title = 'Theme Color: Other',
    hidden: s => s.visible = false, escapedFocus: s => s.focusInside = false, clipped: s => s.rect.x = -1
})) test(`Theme Color dialog rejects ${name}`, () => { const s = colorPicker(); mutate(s); assert.throws(() => assertSpaceColorPicker(s, 'Work', 'purple')); });
const nameEditor = (folder = false) => ({ ...geometry(), role: 'dialog', modal: 'true', title: folder ? 'New Folder in Work' : 'Rename Work',
    input: { label: folder ? 'Folder name' : 'Space name', value: 'Entered name', required: true, maxLength: 256, disabled: false }, submit: folder ? 'Create Folder' : 'Save', cancel: 'Cancel' });
for (const folder of [false, true]) {
    test(`${folder ? 'folder' : 'rename'} editor validates actual typed value and accessible bounded form`, () => assertSpaceNameEditor(nameEditor(folder), 'Work', 'Entered name', folder));
    for (const [name, mutate] of Object.entries({ wrongTarget: s => s.title = 'Other', wrongValue: s => s.input.value = 'Untitled', unnamed: s => s.input.label = '', disabled: s => s.input.disabled = true,
        unbounded: s => s.input.maxLength = -1, escapedFocus: s => s.focusInside = false, hidden: s => s.visible = false, missingCancel: s => s.cancel = ''
    })) test(`${folder ? 'folder' : 'rename'} editor rejects ${name}`, () => { const s = nameEditor(folder); mutate(s); assert.throws(() => assertSpaceNameEditor(s, 'Work', 'Entered name', folder)); });
}
const details = () => ({ spaceId: 'work', headerCount: 1, chipCount: 1, headerName: 'Renamed Work', headerColor: 'purple', chipName: 'Renamed Work', chipLabel: 'Switch to space Renamed Work',
    folders: [{ id: 'new-folder', title: 'New folder', visible: true }] });
const detailOptions = { spaceId: 'work', name: 'Renamed Work', color: 'purple', folder: { id: 'new-folder', title: 'New folder' } };
test('saved details projection requires the exact renamed header/chip, color and visible created folder', () => assertSpaceDetailsProjection(details(), detailOptions));
for (const [name, mutate] of Object.entries({ wrongTarget: s => s.spaceId = 'other', missingHeader: s => s.headerCount = 0, duplicateChip: s => s.chipCount = 2, staleName: s => s.headerName = 'Work',
    staleChip: s => s.chipName = 'Work', staleColor: s => s.headerColor = 'blue', wrongLabel: s => s.chipLabel = 'Switch', wrongFolder: s => s.folders[0].id = 'other-folder',
    staleTitle: s => s.folders[0].title = 'Untitled', hiddenFolder: s => s.folders[0].visible = false
})) test(`saved details projection rejects ${name}`, () => { const s = details(); mutate(s); assert.throws(() => assertSpaceDetailsProjection(s, detailOptions)); });

test('real basic-edit fixture types and submits forms, verifies all exact-ID mutations, and retains required screenshots', async () => {
    const source = readSourceText(new URL('../../scripts/paired-chrome-space-context.mjs', import.meta.url));
    assert.match(source, /await page\.keyboard\.type\(text\)/);
    assert.match(source, /await page\.keyboard\.press\('Enter'\)/);
    for (const label of ['Rename', 'Theme Color', 'New Folder']) assert(source.includes(`openEditor(page, '${label}'`));
    assert.match(source, /assertSpaceMetadataSaved\(beforeRename, afterRename/); assert.match(source, /assertSpaceMetadataSaved\(beforeColor, afterColor/);
    assert.match(source, /assertSpaceFolderCreated\(beforeFolder, afterFolder/);
    assert.match(source, /evidence\.screenshots\.push\(result\)/);
    assert.equal((source.match(/await screenshot\(/g) || []).length, 1, 'All captures flow through the required evidence helper.');
});


test('visible created-folder screenshot proof also requires the applied theme of the explicitly activated Space', () => {
    const visible = { ...details(), activeSpaceId: 'work', headerVisible: true, expectedColor: 'rgb(100, 80, 150)', appliedColor: 'rgb(100, 80, 150)', expectedTint: '#aabbcc', appliedTint: '#aabbcc' };
    const options = { ...detailOptions, requireVisibleTheme: true };
    assertSpaceDetailsProjection(visible, options);
    for (const changes of [{ activeSpaceId: 'other' }, { headerVisible: false }, { expectedColor: '' }, { appliedColor: 'rgb(0, 0, 0)' }, { expectedTint: '' }, { appliedTint: '#000000' }]) {
        assert.throws(() => assertSpaceDetailsProjection({ ...visible, ...changes }, options));
    }
});
test('icon-modal Cancel uses real input and checks pre-open state plus restored origin focus', async () => {
    const source = readSourceText(new URL('../../scripts/paired-chrome-space-context.mjs', import.meta.url));
    assert.match(source, /Cancel the icon picker[^\n]+page\.click\('\.space-editor > button'\)/);
    assert.match(source, /evidence\.iconCancelled = \{ before: evidence\.picker\.before, after: await read\(\) \}/);
    assert.match(source, /assertSpaceContextUnchanged\(evidence\.iconCancelled\.before, evidence\.iconCancelled\.after\);\n        assert\.equal\(await page\.\$eval\(chip\(target\.id\), node => node === document\.activeElement\), true\)/);
});


test('stable menu capture proves surface before foreground, before screenshot and afterward', async () => {
    const events = [], records = [];
    const result = await captureStableSpaceMenu({ name: 'Work',
        observe: async () => { events.push('observe'); return { surface: menu(), observation: { events: [] } }; },
        record: async state => records.push(structuredClone(state)),
        foreground: async action => { events.push('foreground'); await action(); },
        capture: async () => events.push('capture') });
    assert.deepEqual(events, ['observe', 'foreground', 'observe', 'capture', 'observe']);
    assert.deepEqual(result.map(item => item.phase), ['before-foreground', 'before-screenshot', 'after-screenshot']);
    assert.equal(records.length, 3);
});
for (const missingAt of [0, 1, 2]) test(`missing menu at capture checkpoint ${missingAt} fails without reopening or replay`, async () => {
    let reads = 0, captures = 0, foregrounds = 0; const records = [];
    await assert.rejects(captureStableSpaceMenu({ name: 'Work',
        observe: async () => ({ surface: reads++ === missingAt ? null : menu() }),
        record: async state => records.push(structuredClone(state)),
        foreground: async action => { foregrounds++; await action(); },
        capture: async () => { captures++; } }), /must remain present/);
    assert.equal(reads, missingAt + 1); assert.equal(captures, missingAt === 2 ? 1 : 0);
    assert.equal(foregrounds, missingAt ? 1 : 0); assert.equal(records.length, missingAt + 1);
});
test('capture failure preserves its original error even if diagnostic surface disappears', async () => {
    let reads = 0, captures = 0; const original = Error('Original capture failure');
    await assert.rejects(captureStableSpaceMenu({ name: 'Work',
        observe: async () => ({ surface: ++reads === 3 ? null : menu() }), record: async () => {},
        foreground: action => action(), capture: async () => { captures++; throw original; } }), error => error === original);
    assert.equal(reads, 3); assert.equal(captures, 1);
});
test('passive menu diagnostics observe bounded events without mutating focus, viewport or menu', () => {
    const handlers = new Map(), removals = [], root = {};
    const window = { addEventListener: (name, fn) => handlers.set(name, fn), removeEventListener: (name, fn) => removals.push([name, fn]) };
    const document = { visibilityState: 'visible', hasFocus: () => true, querySelector: () => root,
        addEventListener: window.addEventListener, removeEventListener: window.removeEventListener };
    const context = { window, document, innerWidth: 224, innerHeight: 600 };
    runInNewContext(`(${observeSpaceMenuEvents.toString()})()`, context);
    for (let i = 0; i < 110; i++) handlers.get('blur')({ type: 'blur' });
    const state = context.__spaceMenuCaptureObservation.read();
    assert.equal(state.events.length, 100); assert.equal(state.menuPresent, true); assert.equal(state.width, 224);
    context.__spaceMenuCaptureObservation.stop(); assert.equal(removals.length, 4);
});


const folderScreenshot = () => ({ spaceId: 'work', activeSpaceId: 'work', folderId: 'saved-folder', matches: 1, title: 'Created folder',
    rect: { x: 8, y: 120, width: 208, height: 30 }, viewport: { width: 224, height: 600 }, unobscured: true });
const folderScreenshotOptions = { spaceId: 'work', folder: { id: 'saved-folder', title: 'Created folder' } };
test('created-folder screenshot requires the exact unobscured row inside its viewport', () => assertSpaceFolderScreenshot(folderScreenshot(), folderScreenshotOptions));
for (const [name, mutate] of Object.entries({ wrongSpace: s => s.spaceId = 'other', inactive: s => s.activeSpaceId = 'other', wrongFolder: s => s.folderId = 'other', duplicate: s => s.matches = 2,
    staleName: s => s.title = 'Old name', belowViewport: s => s.rect.y = 700, clipped: s => s.rect.x = -1, hidden: s => s.rect.height = 0, covered: s => s.unobscured = false
})) test(`created-folder screenshot rejects ${name}`, () => { const state = folderScreenshot(); mutate(state); assert.throws(() => assertSpaceFolderScreenshot(state, folderScreenshotOptions)); });
test('folder screenshot observer requires real hit-tested edge midpoints and center and has no scrolling or focus effect', () => {
    const points = [], leaf = {}, other = {}; let hit = leaf;
    const header = { getBoundingClientRect: () => ({ x: 8, y: 120, width: 208, height: 30 }), querySelector: () => ({ textContent: 'Created folder' }), contains: node => node === leaf };
    const folder = { dataset: { bookmarkId: 'saved-folder' }, querySelector: () => header };
    const space = { dataset: { spaceId: 'work' }, querySelectorAll: () => [folder] };
    const context = { innerWidth: 224, innerHeight: 600, document: { querySelectorAll: () => [space], querySelector: () => space,
        elementFromPoint: (x, y) => { points.push([x, y]); return hit; } } };
    const read = () => runInNewContext(`(${readSpaceFolderScreenshot.toString()})({spaceId:'work',folderId:'saved-folder'})`, context);
    assertSpaceFolderScreenshot(read(), folderScreenshotOptions); assert.deepEqual(points, [[112,122],[112,148],[10,135],[214,135],[112,135]]);
    hit = other; assert.equal(read().unobscured, false);
});

test('rounded folder corners are not treated as opaque row pixels', () => {
    const leaf = {}, background = {};
    const header = { getBoundingClientRect: () => ({ x: 8, y: 120, width: 208, height: 30 }), querySelector: () => ({ textContent: 'Created folder' }), contains: node => node === leaf };
    const folder = { dataset: { bookmarkId: 'saved-folder' }, querySelector: () => header };
    const space = { dataset: { spaceId: 'work' }, querySelectorAll: () => [folder] };
    const context = { innerWidth: 224, innerHeight: 600, document: { querySelectorAll: () => [space], querySelector: () => space,
        elementFromPoint: (x, y) => ((x < 16 || x > 208) && (y < 128 || y > 142)) ? background : leaf } };
    const state = runInNewContext(`(${readSpaceFolderScreenshot.toString()})({spaceId:'work',folderId:'saved-folder'})`, context);
    assertSpaceFolderScreenshot(state, folderScreenshotOptions); assert.equal(state.hits.length, 5);
});

for (const blocked of [0, 1, 2, 3, 4]) test(`folder screenshot rejects obstruction at point ${blocked} and records every hit`, () => {
    const leaf = {}, other = {}; let index = 0;
    const header = { getBoundingClientRect: () => ({ x: 8, y: 120, width: 208, height: 30 }), querySelector: () => ({ textContent: 'Created folder' }), contains: node => node === leaf };
    const folder = { dataset: { bookmarkId: 'saved-folder' }, querySelector: () => header };
    const space = { dataset: { spaceId: 'work' }, querySelectorAll: () => [folder] };
    const context = { innerWidth: 224, innerHeight: 600, document: { querySelectorAll: () => [space], querySelector: () => space, elementFromPoint: () => index++ === blocked ? other : leaf } };
    const state = runInNewContext(`(${readSpaceFolderScreenshot.toString()})({spaceId:'work',folderId:'saved-folder'})`, context);
    assert.equal(state.hits.length, 5); assert.equal(index, 5); assert.equal(state.hits[blocked].inside, false);
    assert.throws(() => assertSpaceFolderScreenshot(state, folderScreenshotOptions), /edge midpoints and center/);
});


function spaceTriggerFixture(errors = []) {
    const calls = [], records = []; let clicks = 0, disposed = 0;
    return { page: { waitForSelector: async (selector, options) => { calls.push({ selector, options });
        return { click: async options => { assert.deepEqual(options, { button: 'right' }); const error = errors[clicks++]; if (error) throw error; }, dispose: async () => { disposed++; } }; } },
        calls, records, record: async state => records.push(state), get clicks() { return clicks; }, get disposed() { return disposed; } };
}
const triggerDetachedError = () => {
    const error = Error('Node is detached from document');
    error.stack = 'Error: Node is detached from document\n    at CdpElementHandle.assertConnectedElement (/runtime/puppeteer-core/lib/puppeteer/api/ElementHandle.js:1314:23)\n    at async CdpElementHandle.scrollIntoView (/runtime/puppeteer-core/lib/puppeteer/cdp/ElementHandle.js:106:13)';
    return error;
};
test('Space context trigger uses one genuine right click on the exact selected identity', async () => {
    const f = spaceTriggerFixture(); await rightClickFreshSpaceTrigger(f.page, '#spaceSwitcher [data-space-id="exact"]', f.record);
    assert.equal(f.clicks, 1); assert.equal(f.disposed, 1); assert.equal(f.calls[0].selector, '#spaceSwitcher [data-space-id="exact"]');
    assert.equal(f.calls[0].options.visible, true); assert.equal(f.records[0].status, 'clicked');
});
test('Space context trigger reacquires only a proven pre-input detached target', async () => {
    const f = spaceTriggerFixture([triggerDetachedError()]); await rightClickFreshSpaceTrigger(f.page, '#exact', f.record);
    assert.equal(f.clicks, 2); assert.equal(f.disposed, 2); assert.deepEqual(f.calls.map(item => item.selector), ['#exact', '#exact']);
    assert.deepEqual(f.records.map(item => item.status), ['detached-before-input', 'clicked']);
});
for (const error of [Error('Input.dispatchMouseEvent timed out'), Error('Node is detached from document')]) test(`Space context trigger never replays uncertain error ${error.message}`, async () => {
    const f = spaceTriggerFixture([error]); await assert.rejects(rightClickFreshSpaceTrigger(f.page, '#exact', f.record), value => value === error);
    assert.equal(f.clicks, 1); assert.equal(f.disposed, 1);
});
test('repeated detached Space context targets fail at the shared three-attempt cap', async () => {
    const errors = [triggerDetachedError(), triggerDetachedError(), triggerDetachedError()], f = spaceTriggerFixture(errors);
    await assert.rejects(rightClickFreshSpaceTrigger(f.page, '#exact', f.record), value => value === errors[2]);
    assert.equal(f.clicks, 3); assert.equal(f.disposed, 3);
});
