import test from 'node:test';
import assert from 'node:assert/strict';
import { readSourceText } from '../source-text.js';
import { assertTodayNewTabRow, assertRowDraftPreserved, assertOrdinaryRowFallback } from '../../scripts/paired-chrome-newtab-row.mjs';
const id = 'a'.repeat(32);
const row = () => ({ count: 1, buttons: 1, obsolete: 0, activeSpaceId: 'space', rowSpaceId: 'space', tag: 'BUTTON', text: '+ New Tab',
    visible: true, disabled: false, insideSortable: false, draggable: false, immediatelyAfterHeader: true, immediatelyBeforeList: true,
    inverted: 'false', footerNotices: true, row: { x: 10, y: 100, width: 280, height: 28, bottom: 128 },
    header: { y: 80, bottom: 100 }, list: { y: 128 }, viewport: { width: 300, height: 700 }, todayIds: [] });
const expected = { spaceId: 'space', inverted: false, empty: true };
test('native geometry requires one usable unsortable row immediately beneath Today even when empty', () => assertTodayNewTabRow(row(), expected));
for (const [name, change] of [
    ['duplicate ID', s => { s.count = 2; }], ['duplicate control', s => { s.buttons = 2; }], ['old Spotlight control', s => { s.obsolete = 1; }],
    ['inactive Space row', s => { s.rowSpaceId = 'other'; }], ['nonbutton', s => { s.tag = 'DIV'; }], ['disabled', s => { s.disabled = true; }],
    ['inside sortable', s => { s.insideSortable = true; }], ['draggable', s => { s.draggable = true; }],
    ['wrong DOM order', s => { s.immediatelyAfterHeader = false; }], ['tabs before row', s => { s.list.y = 50; }],
    ['row above divider', s => { s.row.y = 10; }], ['offscreen', s => { s.row.bottom = 800; }],
    ['wrong order setting', s => { s.inverted = 'true'; }], ['hidden', s => { s.visible = false; }],
    ['tiny hit target', s => { s.row.height = 2; }], ['nonempty', s => { s.todayIds = [8]; }], ['removed notices', s => { s.footerNotices = false; }]
]) test(`row evidence rejects ${name}`, () => { const state = row(); change(state); assert.throws(() => assertTodayNewTabRow(state, expected)); });
test('inversion changes Today order without relocating the row', () => {
    const state = row(); state.inverted = 'true'; state.todayIds = [9, 8];
    assertTodayNewTabRow(state, { spaceId: 'space', inverted: true });
});
const draft = () => ({ url: `chrome-extension://${id}/newtab.html`, timeOrigin: 10,
    tab: { id: 1, windowId: 2, url: 'chrome://newtab/', incognito: false, pinned: false, active: true, status: 'complete' },
    input: { value: 'real draft', start: 2, end: 5, direction: 'forward', focused: true }, documentFocused: true,
    selected: [{ type: 'search-query', title: 'real draft' }] });
test('native row reuse permits deliberate focus transfer while conserving document and full draft', () => {
    const after = draft(); after.documentFocused = false; after.input.focused = false;
    assertRowDraftPreserved(draft(), after, [1, 2], [2, 1], id);
});
for (const [name, change] of [
    ['reload', s => { s.timeOrigin++; }], ['new tab', s => { s.tab.id = 4; }], ['wrong window', s => { s.tab.windowId = 4; }],
    ['cleared draft', s => { s.input.value = ''; }], ['caret lost', s => { s.input.end = 2; }],
    ['selected result lost', s => { s.selected = []; }], ['navigation', s => { s.tab.pendingUrl = 'https://example.test/'; }]
]) test(`draft evidence rejects ${name}`, () => { const after = draft(); change(after); assert.throws(() => assertRowDraftPreserved(draft(), after, [1], [1], id)); });
test('row reuse rejects duplicate tabs even when original draft survives', () => assert.throws(() => assertRowDraftPreserved(draft(), draft(), [1], [1, 2], id)));
const before = () => ({ tabs: [{ id: 1, windowId: 2, url: 'https://example.test/', active: true, pinned: false, incognito: false },
    { id: 3, windowId: 4, url: 'https://elsewhere.test/', active: true, pinned: false, incognito: false }],
    activeSpaces: { 2: 'space', 4: 'other' }, spaces: [{ id: 'space', temporaryTabs: [1], spaceBookmarks: [] }] });
const after = () => { const s = before(); s.tabs[0].active = false; s.tabs.push({ id: 5, windowId: 2, url: 'chrome://newtab/', active: true, pinned: false, incognito: false }); s.spaces[0].temporaryTabs.push(5); return s; };
const context = { windowId: 2, spaceId: 'space' };
test('ordinary fallback proves one canonically owned native alias and preserves current Space', () => {
    assert.deepEqual(assertOrdinaryRowFallback(before(), after(), context), { tabId: 5, windowId: 2, spaceId: 'space', browserUrl: 'chrome://newtab/', owners: ['space'] });
});
for (const [name, change] of [
    ['two new tabs', s => { s.tabs.push({ ...s.tabs[2], id: 6 }); }], ['wrong window', s => { s.tabs[2].windowId = 4; }],
    ['hardcoded helper', s => { s.tabs[2].url = `chrome-extension://${id}/newtab.html`; }], ['changed current Space', s => { s.activeSpaces[2] = 'other'; }],
    ['other-window activation', s => { s.tabs[1].active = false; }], ['removed source', s => { s.tabs.shift(); }],
    ['unassigned fallback', s => { s.spaces[0].temporaryTabs = [1]; }],
    ['wrong owner', s => { s.spaces.push({ id: 'other', temporaryTabs: [5], spaceBookmarks: [] }); }], ['duplicate owner', s => { s.spaces[0].temporaryTabs.push(5); s.spaces.push({ id: 'other', temporaryTabs: [5], spaceBookmarks: [] }); }]
]) test(`fallback evidence rejects ${name}`, () => { const s = after(); change(s); assert.throws(() => assertOrdinaryRowFallback(before(), s, context)); });

test('real row scenarios remain mandatory inside existing full-suite cases and retain security boundaries', () => {
    const runner = readSourceText(new URL('../../scripts/paired-chrome-smoke.mjs', import.meta.url));
    const source = readSourceText(new URL('../../scripts/paired-chrome-newtab-row.mjs', import.meta.url));
    const workflow = readSourceText(new URL('../../.github/workflows/paired-extension-smoke.yml', import.meta.url));
    assert.equal((runner.match(/exerciseNativeNewTabRow\(/g) || []).length, 1);
    const case14 = runner.slice(runner.indexOf('await step(stepNames[14]'), runner.indexOf('await step(stepNames[15]'));
    assert.match(case14, /captureNativeSidebar/); assert.match(case14, /assertSidebarHelperUnchanged/);
    assert.match(case14, /resolveNativeSidebarTarget/); assert.match(case14, /exerciseNativeNewTabRow/);
    assert.match(runner, /await clickUI\(sidebar.page, '#newTabBtn'\)/); assert.doesNotMatch(runner, /#spotlightBtn/);
    assert(runner.includes("await sidebar.page.waitForSelector('.space.active .temporary-tabs > #newTabBtn:not([disabled])')"), 'Case 8 must observe the initialized enabled row before its one real click.');
    for (const label of ['normal', 'inverted', 'empty-inverted', 'empty-normal', 'compact-inverted', 'empty-after-metadata-repaint']) assert(source.includes(`layout('${label}'`));
    assert.match(source, /page\.click\('#newTabBtn', \{ count: 2 \}\)/);
    assert.match(source, /trace\.filter\(event => event.type === 'click'\)\.length, 2/);
    assert.match(source, /tabToSelector\(page, '#newTabBtn'\)/);
    assert.match(source, /page.keyboard.press\('Enter'\)/);
    assert.match(source, /trace.every\(event => event.trusted\)/);
    assert.match(source, /apiPage.click\('#bridgeDisconnect'\)/); assert.match(source, /apiPage.click\('#bridgeSave'\)/);
    assert.match(source, /chrome.runtime.getContexts\(\{ contextTypes: \['TAB'\] \}\)/);
    assert.doesNotMatch(source, /setViewport|dispatchEvent|chrome\.developerPrivate|chrome\.management|setTimeout|puppeteer\.launch/);
    assert(source.includes('A later successful launch cannot add a stale fallback.'));
    for (const path of ['scripts/paired-chrome-newtab-row.mjs', 'tests/unit/paired-chrome-newtab-row.test.js']) assert(workflow.includes(`- '${path}'`));
});
