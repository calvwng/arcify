// Extract only orchestration/adapters. Never import the executable Chrome runner.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readSourceText } from '../source-text.js';
import { createPairedChromeRunReport } from '../../scripts/paired-chrome-run-plan.mjs';

const read = name => readSourceText(new URL(`../../${name}`, import.meta.url));
const runner = read('scripts/paired-chrome-smoke.mjs');
const workflow = read('.github/workflows/paired-extension-smoke.yml');
const names = [...runner.match(/const stepNames = \[([\s\S]*?)\n\];/)[1].matchAll(/^\s*'([^']*)',?$/gm)].map(match => match[1]);
const start = runner.indexOf("    if (report.runMode === 'full' || report.runMode === 'move-drag') {");
const end = runner.indexOf('    } // Shared tab-menu and Move/drag case 38.', start) + 5;
assert(start > 0 && end > start);
const branch = runner.slice(start, end);

test('move-drag selects only fresh setup and the unchanged full-suite case 38', () => {
    const report = createPairedChromeRunReport(names, 'move-drag');
    assert.deepEqual(report.expectedCases.map(item => item.caseIndex), [0, 1, 2, 38]);
    assert.equal(report.expectedCaseCount, 4);
    assert.match(report.scope, /Supplemental fresh-profile tab-menu, native Move to New Window and sticky New Tab drag/);
    assert.match(report.scope, /not Little Arc, full-browser restart or full-suite acceptance/);
    assert.equal(createPairedChromeRunReport(names, 'full').expectedCaseCount, 49);
    assert(createPairedChromeRunReport(names, 'full').expectedCases.some(item => item.caseIndex === 38));
    assert.equal((runner.match(/await step\(stepNames\[38\]/g) || []).length, 1);
    assert.match(runner, /report.runMode === 'move-drag' \? 'test-results\/paired-chrome-move-drag'/);
});

async function runSharedCase({ mode = 'move-drag', failAt = null } = {}) {
    const dependencies = Object.fromEntries(['arcifyOptions', 'newTabPage', 'pageForUrl', 'nativeMoveWindowSidebar',
        'ui', 'screenshot', 'snapshot', 'poll', 'fixture', 'arcifyId', 'spotlightId', 'search'].map(name => [name, { name }]));
    const report = { runMode: mode }, calls = [], saves = [], failure = new Error('exact failed acceptance');
    let result, steps = 0;
    const exercise = (kind, keys, field) => async adapters => {
        calls.push(kind);
        assert.deepEqual(Object.keys(adapters).sort(), [...keys, 'record'].sort());
        for (const key of keys) assert.equal(adapters[key], dependencies[
            key === 'apiPage' ? 'arcifyOptions' : key === 'nativeSidebar' ? 'nativeMoveWindowSidebar' : key], key);
        const evidence = { kind, complete: false };
        await adapters.record(evidence);
        assert.equal(report[field], evidence);
        if (failAt === kind) throw failure;
        const complete = { kind, complete: true };
        await adapters.record(complete);
        return complete;
    };
    const execution = new vm.Script(`(async () => { ${branch} })()`).runInNewContext({
        ...dependencies, report, stepNames: names,
        step: async (name, callback, ...options) => {
            steps++; assert.equal(name, names[38]);
            assert.deepEqual(options, [], 'Shared case must retain all common isolation/error gates.');
            result = await callback();
        },
        exerciseTabMenuActions: exercise('menus', ['apiPage', 'newTabPage', 'pageForUrl', 'ui', 'screenshot',
            'snapshot', 'poll', 'fixture', 'arcifyId', 'spotlightId', 'search'], 'tabMenus'),
        exerciseMoveToNewWindow: exercise('move', ['apiPage', 'newTabPage', 'pageForUrl', 'nativeSidebar',
            'ui', 'screenshot', 'snapshot', 'poll', 'fixture', 'arcifyId'], 'moveWindow'),
        saveReport: async () => {
            if (failAt === 'save') throw failure;
            saves.push(JSON.parse(JSON.stringify(report)));
        }
    });
    if (failAt) await assert.rejects(execution, error => error === failure);
    else await execution;
    return { report, calls, saves, result, steps };
}

for (const mode of ['full', 'move-drag']) {
    test(`${mode} runs the same menu then native Move/drag callback once, with separate persisted evidence`, async () => {
        const result = await runSharedCase({ mode });
        assert.equal(result.steps, 1);
        assert.deepEqual(result.calls, ['menus', 'move']);
        assert.equal(result.saves.length, 4);
        assert.deepEqual(result.result, { kind: 'move', complete: true });
        assert.equal(result.report.tabMenus.complete, true);
        assert.equal(result.report.moveWindow.complete, true);
    });
    for (const failAt of ['menus', 'move', 'save']) test(`${mode} propagates ${failAt} failure with no retry or later acceptance`, async () => {
        const result = await runSharedCase({ mode, failAt });
        assert.equal(result.steps, 1);
        assert.deepEqual(result.calls, failAt === 'move' ? ['menus', 'move'] : ['menus']);
        assert.equal(result.result, undefined);
        assert.equal(result.report[failAt === 'move' ? 'moveWindow' : 'tabMenus'].complete, false);
        if (failAt !== 'move') assert.equal(result.report.moveWindow, undefined);
    });
}
for (const mode of ['favorite-lifecycle', 'native-split', 'appearance-actions', 'recovery-actions', 'extended-actions',
    'archive-actions', 'archive-reopen', 'little-arc']) test(`${mode} never runs or claims supplemental Move/drag evidence`, async () => {
    const result = await runSharedCase({ mode });
    assert.equal(result.steps, 0);
    assert.deepEqual(result.calls, []);
    assert.deepEqual(result.saves, []);
    assert.deepEqual(result.report, { runMode: mode });
});

test('setup already initializes Today ordering and supplies every owned menu/native Move dependency', () => {
    const setup = runner.slice(runner.indexOf('    await step(stepNames[0]'), runner.indexOf("    if (report.runMode === 'full') {"));
    for (const text of ['profile = await mkdtemp(', 'arcifyOptions = await observePage(', 'spotlightOptions = await observePage(',
        'serveTabMenuFixture(request, response)', "chrome.storage.sync.set({ syncTabGroups: false })",
        "chrome.runtime.sendMessage({ type: 'spaceStore', action: 'get' })",
        'fixture.windowBBaseline = await windowBState()']) assert(setup.includes(text), text);
    const options = read('options.js'), store = read('space-store.js'), ordering = read('today-order.js');
    assert.match(options, /async function restoreOptions\(\) \{\n  await Utils.getTodayOrderInverted\(\);/);
    assert.match(options, /await restoreOptions\(\);\n    setupAutoSave\(\);/);
    assert.match(store, /dispatch\(message\) \{\n        return this.run\(/);
    assert.match(store, /await this.initialize\(\);/);
    assert.match(store, /this.initializeUnlocked\(\)/);
    assert.match(store.slice(store.indexOf('async initializeUnlocked()'), store.indexOf('exactTodayOpener(')),
        /await this.readTodayPlacement\(\);/);
    assert.match(store, /async readTodayPlacement\(\{ getOrder = getTodayOrderInverted \} = \{\}\) \{\n        this.todayOrderInverted = await getOrder\(\);/);
    assert.match(ordering, /await chrome.storage.local.set\(\{ \[TODAY_ORDER_KEY\]: \{ version: 1, inverted \} \}\)/);
    const menus = read('scripts/paired-chrome-tab-menu.mjs'), move = read('scripts/paired-chrome-move-window.mjs');
    assert.match(menus, /assert.equal\(representation\?\.version, 1\)/);
    assert.match(menus, /initial = await snapshot\(windowId\), space = initial.spaces.find\(item => item.id === initial.activeSpaceId\)/);
    assert.match(move, /await exerciseStickyNewTabDrop\(/);
    assert.match(move, /initial=await snapshot\(sourceId\),space=initial.spaces.find\(s=>s.id===initial.activeSpaceId\)/);
    assert.doesNotMatch(menus + move + branch, /persistentFixture|ordinaryFixture|sidebarFixture|prepareRecoverySidebarObservation/);
});

const nativeStart = runner.indexOf('async function nativeMoveWindowSidebar(');
const nativeEnd = runner.indexOf('async function nativeTodayMoveSidebar(', nativeStart);
const nativeAdapter = runner.slice(nativeStart, nativeEnd);
test('native Move registers its own real observer before creating the helper, without earlier Sidebar setup', async () => {
    const listeners = [], calls = [];
    const realm = vm.createContext({ chrome: {
        tabs: { query: async () => [{ url: 'http://fixture/tab-menu/owned/outside' }] },
        sidePanel: { onOpened: { addListener: listener => listeners.push(listener) } }
    } });
    const failure = new Error('stop before any native input');
    const adapter = new vm.Script(`(${nativeAdapter})`).runInNewContext({
        assert, fixture: { windowA: 1, windowB: 2, base: 'http://fixture' },
        arcifyOptions: { evaluate: async (callback, argument) => vm.runInContext(`(${callback})`, realm)(argument) },
        newTabPage: async (url, windowId) => {
            calls.push({ url, windowId });
            assert.equal(listeners.length, 1);
            assert.deepEqual(JSON.parse(JSON.stringify(realm.__pairedMoveWindowEvents)), []);
            assert.equal(realm.__pairedSidebarEvents, undefined);
            const observed = { windowId, path: 'sidebar.html' };
            listeners[0](observed);
            assert.deepEqual(JSON.parse(JSON.stringify(realm.__pairedMoveWindowEvents)), [{ type: 'opened', ...observed }]);
            throw failure;
        }
    });
    await assert.rejects(adapter({ windowId: 3 }), error => error === failure);
    assert.deepEqual(calls, [{ url: 'chrome://newtab/', windowId: 3 }]);
    assert.doesNotMatch(nativeAdapter, /__pairedSidebarEvents|nativePanelState|prepareRecoverySidebarObservation|nativeTodayMoveSidebar/);
    for (const text of ['await waitSidebarCommand(helper.page)', 'await sidebarEnter(helper.page,',
        'assertNativeSidebarEvidence(proof.contexts, proof.events,', 'host.tab===null&&host.windowId===windowId',
        'createNativeSidebarReadiness(arcifyId)']) assert(nativeAdapter.includes(text), text);
});

test('new job retains the exact existing runner, peer pin, readonly checkouts and sandbox flow', () => {
    const job = name => workflow.match(new RegExp(`^  ${name}:\\n[\\s\\S]*?(?=^  (?:[a-z-]+:|#)|$(?![\\s\\S]))`, 'm'))?.[0].trimEnd();
    const selected = job('move-drag');
    // Exact copied mechanics, not a looser second implementation of launch/security.
    assert.equal(selected, job('archive-reopen').replaceAll('archive-reopen', 'move-drag')
        .replace('Exercise Spotlight Archive exact entry reopening in an independent fresh profile',
            'Exercise tab menus, native Move and sticky New Tab drag in an independent fresh profile'));
    assert.match(selected, /ref: b8b193c1f803179f86ab2e2397e5f1169256f49d/);
    assert.match(selected, /ARCIFY_TEST_HEAD: \$\{\{ github.event.pull_request.head.sha \|\| github.sha \}\}/);
    assert.match(selected, /ref: \$\{\{ github.event.pull_request.head.sha \|\| github.sha \}\}/);
    assert.equal((selected.match(/persist-credentials: false/g) || []).length, 2);
    assert.match(selected, /npm test --prefix arcify\/scripts\/paired-chrome-runtime/);
    assert.match(selected, /if: always\(\)/);
    assert.match(selected, /name: paired-chrome-move-drag-\$\{\{ github.run_id \}\}-\$\{\{ github.run_attempt \}\}/);
    assert.match(selected, /path: arcify\/test-results\/paired-chrome-move-drag\//);
    assert.match(workflow, /^permissions:\n  contents: read$/m);
    assert.doesNotMatch(selected.replace(/^\s*#.*$/gm, ''), /needs:|continue-on-error:|strategy:|secrets\.|permissions:|sudo|chmod|chown|sysctl|apparmor_parser|vendor-update|native-split-update|retry|no-sandbox|disable-web-security|CHROME_DEVEL_SANDBOX|puppeteer browsers install/);
    for (const path of ['tests/unit/paired-chrome-move-drag-wiring.test.js', 'docs/move-drag-paired-ci.md'])
        assert(workflow.includes(`      - '${path}'`), path);
});
