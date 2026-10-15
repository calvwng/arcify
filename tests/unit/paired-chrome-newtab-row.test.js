import test from 'node:test';
import assert from 'node:assert/strict';
import { readSourceText } from '../source-text.js';
import { assertTodayNewTabRow, assertRowDraftPreserved, assertOrdinaryRowFallback, cleanupNewTabFixtureSpace, recordNewTabRowEvidence, assertNonemptyDraftSelection } from '../../scripts/paired-chrome-newtab-row.mjs';
const id = 'a'.repeat(32);
const row = () => ({ count: 1, buttons: 1, obsolete: 0, activeSpaceId: 'space', rowSpaceId: 'space', tag: 'BUTTON', text: '+ New Tab',
    visible: true, disabled: false, insideSortable: false, draggable: false, immediatelyAfterHeader: true, immediatelyBeforeList: true,
    inverted: 'false', footerNotices: true, row: { x: 10, y: 100, width: 280, height: 28, bottom: 128 },
    header: { y: 80, bottom: 100 }, list: { y: 128 }, viewport: { width: 300, height: 700 }, todayIds: [], visibleTodayIds: [] });
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


const cleanupFixture = () => ({ folder: { spaceId: 'fixture', folderId: 'folder-9' },
    spaces: [{ id: 'original', bookmarkFolderId: 'folder-1', spaceBookmarks: [], temporaryTabs: [1] },
        { id: 'fixture', bookmarkFolderId: 'folder-9', spaceBookmarks: [], temporaryTabs: [] }] });
async function runCleanupProbe({ alter = () => {}, deleteError = null, converge = true } = {}) {
    const fixture = cleanupFixture(), calls = [], observations = [];
    alter(fixture); const oldChrome = globalThis.chrome;
    globalThis.chrome = { tabs: { query: async () => [{ id: 1 }] }, runtime: { sendMessage: async message => {
        calls.push(message);
        return message.action === 'get' ? { success: true, spaces: fixture.spaces } : deleteError ? { success: false, error: deleteError } : { success: true };
    } } };
    let result, error, reads = 0;
    try {
        result = await cleanupNewTabFixtureSpace({ folder: fixture.folder,
            apiPage: { evaluate: (callback, argument) => callback(argument) },
            snapshot: async () => ({ spaces: ++reads > 1 && converge ? fixture.spaces.filter(space => space.id !== 'fixture') : fixture.spaces }),
            poll: async (read, accept, label) => {
                assert.match(label, /authoritative removal/);
                for (let attempt = 0; attempt < 3; attempt++) {
                    const state = await read(); observations.push(state);
                    if (accept(state)) return state;
                }
                throw new Error('cleanup never converged');
            } });
    } catch (caught) { error = caught; }
    finally { globalThis.chrome = oldChrome; }
    return { result, error, calls, observations };
}
test('fixture cleanup uses exact canonical deletion once and waits through stale authoritative snapshots', async () => {
    const probe = await runCleanupProbe(); assert.equal(probe.error, undefined);
    assert.deepEqual(probe.calls, [{ type: 'spaceStore', action: 'get' }, { type: 'spaceStore', action: 'delete', spaceId: 'fixture' }]);
    assert.equal(probe.observations.length, 2, 'API completion alone must not release the global isolation gate.');
    assert.deepEqual(probe.result, { spaceId: 'fixture', folderId: 'folder-9', authoritativeSpaceIds: ['original'] });
});
for (const [name, alter] of [
    ['wrong folder', state => { state.spaces[1].bookmarkFolderId = 'other-folder'; }],
    ['missing canonical Space', state => { state.spaces.pop(); }],
    ['duplicate canonical Space', state => { state.spaces.push(structuredClone(state.spaces[1])); }],
    ['live owned tab', state => { state.spaces[1].temporaryTabs.push(1); }]
]) test(`cleanup refuses ${name} before any deletion`, async () => {
    const probe = await runCleanupProbe({ alter }); assert.match(probe.error?.message, /Refusing cleanup/);
    assert.deepEqual(probe.calls, [{ type: 'spaceStore', action: 'get' }]); assert.deepEqual(probe.observations, []);
});
test('cleanup errors and nonconvergence fail without retrying the mutation', async () => {
    for (const options of [{ deleteError: 'delete failed' }, { converge: false }]) {
        const probe = await runCleanupProbe(options); assert(probe.error);
        assert.equal(probe.calls.filter(call => call.action === 'delete').length, 1);
    }
});
test('cleanup input checkpoints retain full New Tab evidence and are kept separately', () => {
    const report = {}, full = { nativePanel: true, layouts: [{ label: 'normal' }], reuse: [{ method: 'double-click' }], fallback: { tabId: 9 } };
    recordNewTabRowEvidence(report, full);
    recordNewTabRowEvidence(report, { phase: 'native-new-tab-input', label: 'Restore initial Space after row proof' });
    assert.deepEqual(report.nativeNewTabRow, full);
    const completed = { ...full, cleanup: { spaceId: 'fixture', authoritativeSpaceIds: ['original'] } };
    recordNewTabRowEvidence(report, completed);
    recordNewTabRowEvidence(report, { phase: 'native-new-tab-input', label: 'later observation' });
    assert.deepEqual(report.nativeNewTabRow, completed);
    assert.equal(report.nativeNewTabRowActions.length, 2);
    completed.layouts.push({ label: 'not recorded' });
    assert.equal(report.nativeNewTabRow.layouts.length, 1, 'Saved evidence must not alias mutable live objects.');
});
test('actual runner retains evidence and keeps strict window-B comparison after authoritative cleanup', () => {
    const runner = readSourceText(new URL('../../scripts/paired-chrome-smoke.mjs', import.meta.url));
    const source = readSourceText(new URL('../../scripts/paired-chrome-newtab-row.mjs', import.meta.url));
    assert.match(runner, /recordNewTabRowEvidence\(report, observation\); await saveReport\(\)/);
    assert.doesNotMatch(runner, /report\.nativeNewTabRow = observation/);
    assert.match(runner, /assert\.deepEqual\(await windowBState\(\), fixture\.windowBBaseline/);
    assert.match(source, /evidence\.cleanup = await cleanupNewTabFixtureSpace\(\{ apiPage, folder, snapshot, poll \}\)/);
    assert.doesNotMatch(source, /chrome\.bookmarks\.removeTree|windowBBaseline/);
    assert.match(source, /if \(errors.length\) evidence.cleanupErrors = errors;\n        try \{ await record\(structuredClone\(evidence\)\)/);
});


test('fallback screenshot readiness requires the exact visible Today row as well as row geometry', () => {
    const state = row(); state.todayIds = [9]; state.visibleTodayIds = [9];
    assertTodayNewTabRow(state, { spaceId: 'space', inverted: false, requiredTabId: 9 });
    for (const [ids, visible] of [[[], []], [[8], [8]], [[9], []], [[9, 9], [9]]]) {
        assert.throws(() => assertTodayNewTabRow({ ...state, todayIds: ids, visibleTodayIds: visible }, { spaceId: 'space', inverted: false, requiredTabId: 9 }));
    }
});
test('reuse evidence cannot call an unchanged collapsed caret a preserved selection', () => {
    assertNonemptyDraftSelection(draft());
    for (const [start, end] of [[9, 9], [-1, 2], [4, 2], [0, 500]]) {
        const state = draft(); state.input.start = start; state.input.end = end;
        assert.throws(() => assertNonemptyDraftSelection(state), /nonempty/);
        assert.throws(() => assertRowDraftPreserved(state, structuredClone(state), [1], [1], id), /nonempty/);
    }
});
test('real selection and fallback rendering readiness precede their measured actions and capture', () => {
    const source = readSourceText(new URL('../../scripts/paired-chrome-newtab-row.mjs', import.meta.url));
    assert.match(source, /field.press\('ArrowLeft'\); await field.press\('ArrowLeft'\)/);
    assert.doesNotMatch(source, /field.press\('Home'\)|setSelectionRange/);
    assert(source.indexOf('assertNonemptyDraftSelection(before);') < source.indexOf('await input(`Activate native New Tab'));
    assert.match(source, /layout\('fallback-complete', folder.spaceId, false, false, fallback.tabId\)/);
});
