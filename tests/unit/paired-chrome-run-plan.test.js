import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readSourceText } from '../source-text.js';
import { createPairedChromeRunReport, beginPairedChromeCase, assertPairedChromeRunPassed } from '../../scripts/paired-chrome-run-plan.mjs';

const smoke = readSourceText(new URL('../../scripts/paired-chrome-smoke.mjs', import.meta.url));
const workflow = readSourceText(new URL('../../.github/workflows/paired-extension-smoke.yml', import.meta.url));
const namesBlock = smoke.match(/const stepNames = \[([\s\S]*?)\n\];/)[1];
const names = [...namesBlock.matchAll(/^\s*'([^']*)',?$/gm)].map(match => match[1]);
const fullOrder = [...Array.from({ length: 32 }, (_, index) => index), 33, 34, 35, 37, 38, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 36, 32];
const lifecycleOrder = [0, 1, 2, 36, 32];
const appearanceActionsOrder = [0, 1, 2, 33, 46, 47, 48, 49];
const indices = report => report.expectedCases.map(item => item.caseIndex);
const stepIndices = source => [...source.matchAll(/await step\(stepNames\[(\d+)\]/g)].map(match => Number(match[1]));
function passedReport(mode) {
    const report = createPairedChromeRunReport(names, mode);
    for (const item of report.expectedCases) beginPairedChromeCase(report, item.name).status = 'passed';
    return report;
}

test('full is the default and requires all 49 cases with menus before unchanged Favorite lifecycle cases', () => {
    const report = createPairedChromeRunReport(names);
    assert.equal(report.runMode, 'full');
    assert.equal(report.expectedCaseCount, 49);
    assert.deepEqual(indices(report), fullOrder);
    assert.deepEqual([...indices(report)].sort((a, b) => a - b), [...Array.from({ length: 39 }, (_, index) => index), 40, 41, 42, 43, 44, 45, 46, 47, 48, 49]);
    assert.deepEqual(report, createPairedChromeRunReport(names, 'full'));
    assert.deepEqual(report, createPairedChromeRunReport(names, undefined));
    assert.deepEqual(report.executedCaseIndices, []);
    assert(report.checks.every(check => check.status === 'not_run'));
});

test('Favorite lifecycle explicitly reports only setup, native close/reload, then full browser restart', () => {
    const report = createPairedChromeRunReport(names, 'favorite-lifecycle');
    assert.equal(report.runMode, 'favorite-lifecycle');
    assert.equal(report.expectedCaseCount, 5);
    assert.match(report.scope, /Supplemental fresh-profile/);
    assert.match(report.scope, /not a full-suite result/);
    assert.deepEqual(indices(report), lifecycleOrder);
    assert.deepEqual(report.checks, lifecycleOrder.map(caseIndex => ({ caseIndex, name: names[caseIndex], status: 'not_run' })));
    assert.match(report.checks[3].name, /native Ctrl\+W/);
    assert.match(report.checks[4].name, /Full same-profile browser restart/);
    assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
});

test('unknown, empty and malformed modes fail closed rather than silently choosing a subset', () => {
    for (const mode of ['', null, false, 'FULL', 'favorite', ' full', 'full ', 'full,favorite-lifecycle', '__proto__', [], 1]) {
        assert.throws(() => createPairedChromeRunReport(names, mode), /Unsupported ARCIFY_PAIRED_RUN_MODE/);
    }
});

test('new, omitted, duplicate or unnamed cases cannot silently escape the explicit full plan', () => {
    for (const invalid of [names.slice(1), [...names, 'New case'], names.map(() => 'Duplicate'), names.map((name, index) => index ? name : ''), null]) {
        assert.throws(() => createPairedChromeRunReport(invalid));
    }
});

for (const mode of ['full', 'favorite-lifecycle', 'native-split', 'appearance-actions']) {
    test(`${mode} requires every declared case to pass once in the declared order`, () => {
        assert.doesNotThrow(() => assertPairedChromeRunPassed(passedReport(mode)));
        const report = createPairedChromeRunReport(names, mode);
        assert.throws(() => beginPairedChromeCase(report, names[1]), /declared order/);
        assert.deepEqual(report.executedCaseIndices, []);
        beginPairedChromeCase(report, names[0]).status = 'passed';
        assert.throws(() => beginPairedChromeCase(report, names[0]), /exactly once/);
        assert.throws(() => assertPairedChromeRunPassed(report));
    });
    for (const status of ['not_run', 'running', 'failed', 'skipped', 'passed_with_skips']) {
        test(`${mode} rejects ${status} as a successful selected case`, () => {
            const report = passedReport(mode);
            report.checks[report.checks.length - 1].status = status;
            assert.throws(() => assertPairedChromeRunPassed(report), /must pass/);
        });
    }
    test(`${mode} rejects omitted, extra, duplicated, mislabeled or reordered evidence`, () => {
        const changes = [
            report => report.checks.pop(),
            report => report.checks.push({ caseIndex: 999, name: 'Unexpected', status: 'passed' }),
            report => { report.checks[1] = { ...report.checks[0] }; },
            report => { report.checks[0].name = 'Wrong case'; },
            report => report.checks.reverse(),
            report => report.executedCaseIndices.pop(),
            report => report.executedCaseIndices.push(32),
            report => report.executedCaseIndices.reverse(),
            report => { report.expectedCaseCount = 39 + 5; },
            report => report.expectedCases.pop(),
            report => { report.runMode = 'unknown'; }
        ];
        for (const change of changes) {
            const report = passedReport(mode); change(report);
            assert.throws(() => assertPairedChromeRunPassed(report));
        }
    });
}

test('an unselected full-suite case cannot run or appear as a passing lifecycle result', () => {
    const report = createPairedChromeRunReport(names, 'favorite-lifecycle');
    for (const caseIndex of [3, 37, 38]) {
        assert.throws(() => beginPairedChromeCase(report, names[caseIndex]), /not selected/);
    }
    assert.deepEqual(report.executedCaseIndices, []);
    const completed = passedReport('favorite-lifecycle');
    assert.equal(completed.checks.filter(check => check.status === 'passed').length, 5);
    assert.equal(completed.checks.filter(check => check.status === 'skipped').length, 0);
    completed.runMode = 'full';
    assert.throws(() => assertPairedChromeRunPassed(completed));
});

test('actual smoke orchestration preserves full order and explicitly gates each shared/full-only region', () => {
    const firstFull = smoke.indexOf("    if (report.runMode === 'full') {\n");
    const firstEnd = smoke.indexOf('    } // Full-only cases 3–31.');
    const appearance = smoke.indexOf("    if (report.runMode === 'full' || report.runMode === 'appearance-actions') {");
    const appearanceEnd = smoke.indexOf('    } // Shared appearance prerequisite: case 33.');
    const secondFull = smoke.indexOf("    if (report.runMode === 'full') {\n", firstFull + 1);
    const secondEnd = smoke.indexOf('    } // Full-only cases 34–35, 37–38 and 40–45.');
    const actions = smoke.indexOf("    if (report.runMode === 'full' || report.runMode === 'appearance-actions') {", appearance + 1);
    const actionsEnd = smoke.indexOf('    } // Shared appearance/actions cases 46–49;');
    const lifecycle = smoke.indexOf("    if (report.runMode === 'full' || report.runMode === 'favorite-lifecycle') {");
    assert(firstFull > 0 && firstFull < firstEnd && firstEnd < appearance && appearance < appearanceEnd &&
        appearanceEnd < secondFull && secondFull < secondEnd && secondEnd < actions && actions < actionsEnd && actionsEnd < lifecycle);
    assert.deepEqual(stepIndices(smoke), fullOrder, 'Every full case definition remains single and in its original order.');
    assert.deepEqual(stepIndices(smoke.slice(0, firstFull)), [0, 1, 2]);
    assert.deepEqual(stepIndices(smoke.slice(firstFull, firstEnd)), Array.from({ length: 29 }, (_, index) => index + 3));
    assert.deepEqual(stepIndices(smoke.slice(appearance, appearanceEnd)), [33]);
    assert.deepEqual(stepIndices(smoke.slice(secondFull, secondEnd)), [34, 35, 37, 38, 40, 41, 42, 43, 44, 45]);
    assert.deepEqual(stepIndices(smoke.slice(actions, actionsEnd)), [46, 47, 48, 49]);
    assert.deepEqual(stepIndices(smoke.slice(lifecycle)), [36, 32]);
    assert.match(smoke, /createPairedChromeRunReport\(stepNames, process\.env\.ARCIFY_PAIRED_RUN_MODE\)/);
    assert.match(smoke, /const check = beginPairedChromeCase\(report, name\)/);
    assert.match(smoke, /assert\(!detail\?\.skipped,/);
    assert.match(smoke, /assertPairedChromeRunPassed\(report\);\n    report.status = 'passed'/);
    assert.doesNotMatch(smoke, /passed_with_skips/);
    assert.match(smoke, /ordinaryFixture:ordinaryFixture\.restartFixture/);
    assert.match(smoke, /profile = await mkdtemp\(/);
    assert.match(smoke, /report\.runMode === 'full' \? 'test-results\/paired-chrome' : 'test-results\/paired-chrome-favorite-lifecycle'/);
    assert.match(smoke, /report\.runMode === 'appearance-actions' \? 'test-results\/paired-chrome-appearance-actions'/);
});

// Execute only the runner's real branch/step orchestration. The callbacks are
// never invoked: no runner import, Chrome, fixture mutation or native input.
const orchestration = smoke.slice(smoke.indexOf('    await step(stepNames[0]'), smoke.indexOf("    assert(report.screenshots.length > 0"));
async function runOrchestration(mode, failAt = null) {
    const report = createPairedChromeRunReport(names, mode);
    const failure = new Error('Selected case failed');
    const execute = new vm.Script(`(async () => { ${orchestration} })()`).runInNewContext({
        report, stepNames: names, NATIVE_SPLIT_CASE_NAME: names[39],
        step: async (name, callback, options) => {
            assert.equal(typeof callback, 'function');
            const check = beginPairedChromeCase(report, name);
            assert.deepEqual(options ? JSON.parse(JSON.stringify(options)) : null, check.caseIndex === 32 ? { windowIsolation: false } : null,
                'No selected case may acquire a window-isolation exemption.');
            if (check.caseIndex === failAt) { check.status = 'failed'; throw failure; }
            check.status = 'passed';
        }
    });
    if (failAt !== null) await assert.rejects(execute, error => error === failure);
    else await execute;
    return report;
}
for (const [mode, order] of [['full', fullOrder], ['favorite-lifecycle', lifecycleOrder], ['native-split', [0, 1, 2, 39]], ['appearance-actions', appearanceActionsOrder]]) {
    test(`actual ${mode} orchestration runs exactly its mandatory cases once without executing browser callbacks`, async () => {
        const report = await runOrchestration(mode);
        assert.deepEqual(report.executedCaseIndices, order);
        assertPairedChromeRunPassed(report);
    });
}
for (const caseIndex of appearanceActionsOrder) {
    test(`appearance-actions stops immediately when mandatory case ${caseIndex} fails, without retries or later cases`, async () => {
        const report = await runOrchestration('appearance-actions', caseIndex);
        assert.deepEqual(report.executedCaseIndices, appearanceActionsOrder.slice(0, appearanceActionsOrder.indexOf(caseIndex) + 1));
        assert.equal(report.checks.find(check => check.caseIndex === caseIndex).status, 'failed');
        assert.throws(() => assertPairedChromeRunPassed(report));
    });
}

test('workflow preserves original jobs and adds independent mandatory fresh-runner acceptance', () => {
    const jobs = [...workflow.matchAll(/^  ([a-z-]+):\n(?=    runs-on:)([\s\S]*?)(?=^  [a-z-]+:\n|$(?![\s\S]))/gm)];
    assert.deepEqual(jobs.map(match => match[1]), ['paired-chrome', 'favorite-lifecycle', 'appearance-actions', 'native-split']);
    const full = jobs[0][2], lifecycle = jobs[1][2], appearanceActions = jobs[2][2], nativeSplit = jobs[3][2];
    const peerPin = smoke.match(/const PINNED_SPOTLIGHT = '([0-9a-f]{40})'/)[1];
    for (const job of [full, lifecycle, appearanceActions, nativeSplit]) {
        assert.match(job, /runs-on: ubuntu-24\.04/);
        assert.match(job, /CI: 'true'/);
        assert.match(job, /ARCIFY_TEST_HEAD: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/);
        assert.match(job, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/);
        assert(job.includes(`ref: ${peerPin}`));
        assert.equal((job.match(/persist-credentials: false/g) || []).length, 2);
        assert.match(job, /npm test --prefix arcify\/scripts\/paired-chrome-runtime/);
        assert.match(job, /npm run build --prefix arcify\n\s+npm run build --prefix arcify-spotlight/);
        assert.match(job, /set -o pipefail/);
        assert.match(job, /xvfb-run --auto-servernum npm run test:paired-chrome -- \.\.\/arcify-spotlight 2>&1 \| tee/);
        assert.match(job, /if: always\(\)/);
        assert.doesNotMatch(job, /needs:|continue-on-error:|strategy:|secrets\.|no-sandbox|disable-web-security|CHROME_DEVEL_SANDBOX/);
    }
    assert.doesNotMatch(full, /ARCIFY_PAIRED_RUN_MODE/);
    assert.match(full, /tee test-results\/paired-chrome\/runner\.log/);
    assert.match(full, /name: paired-chrome-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
    assert.match(full, /path: arcify\/test-results\/paired-chrome\//);
    assert.match(lifecycle, /ARCIFY_PAIRED_RUN_MODE: favorite-lifecycle/);
    assert.match(lifecycle, /tee test-results\/paired-chrome-favorite-lifecycle\/runner\.log/);
    assert.match(lifecycle, /name: paired-chrome-favorite-lifecycle-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
    assert.match(lifecycle, /path: arcify\/test-results\/paired-chrome-favorite-lifecycle\//);
    assert.match(appearanceActions, /ARCIFY_PAIRED_RUN_MODE: appearance-actions/);
    assert.match(appearanceActions, /tee test-results\/paired-chrome-appearance-actions\/runner\.log/);
    assert.match(appearanceActions, /name: paired-chrome-appearance-actions-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
    assert.match(appearanceActions, /path: arcify\/test-results\/paired-chrome-appearance-actions\//);
    assert.doesNotMatch(appearanceActions, /vendor-update|native-split-update|retry|timeout-minutes: (?:[3-9][0-9]|[0-9]{3})/);
    assert.match(workflow, /^permissions:\n  contents: read$/m);
    for (const path of ['scripts/paired-chrome-run-plan.mjs', 'tests/unit/paired-chrome-run-plan.test.js', 'docs/appearance-actions-paired-ci.md']) {
        assert(workflow.includes(`      - '${path}'`), `Changes to ${path} must trigger all jobs.`);
    }
});


test('supplemental native split mode preserves full49/lifecycle5 and requires real positive case', () => {
    const report = createPairedChromeRunReport(names, 'native-split');
    assert.deepEqual(indices(report), [0, 1, 2, 39]);
    assert.equal(report.expectedCaseCount, 4);
    assert.match(report.scope, /Supplemental fresh-profile native Split View positive/);
    assert.match(report.scope, /not a full-suite result/);
    assert.match(report.expectedCases[3].name, /real drag and keyboard create native Split View/);
    assert.equal(createPairedChromeRunReport(names, 'full').expectedCaseCount, 49);
    assert.equal(createPairedChromeRunReport(names, 'favorite-lifecycle').expectedCaseCount, 5);
    const start = smoke.indexOf("    if (report.runMode === 'native-split') {");
    const end = smoke.indexOf("    if (report.runMode === 'full' || report.runMode === 'favorite-lifecycle') {", start);
    assert(start > 0 && end > start);
    assert.match(smoke.slice(start, end), /await step\(NATIVE_SPLIT_CASE_NAME, \(\) => exerciseNativeTodaySplit/);
    assert.equal((smoke.match(/exerciseNativeTodaySplit\(/g) || []).length, 1);
    assert.match(smoke, /captureNativeSplitWindow\(\{chromePid:browser.process\(\).pid/);
    assert.match(smoke, /report.nativeSplit=evidence;await saveReport\(\)/);
    assert.match(workflow, /ARCIFY_PAIRED_RUN_MODE: native-split/);
    assert.match(workflow, /name: paired-chrome-native-split-\$\{\{ github.run_id \}\}-\$\{\{ github.run_attempt \}\}/);
    assert.match(workflow, /path: arcify\/test-results\/paired-chrome-native-split\//);
    const nativeJob = workflow.slice(workflow.indexOf('  native-split:'));
    assert.match(nativeJob, /node scripts\/paired-chrome-native-split-vendor-update\.mjs/);
    assert.doesNotMatch(workflow.slice(0, workflow.indexOf('  native-split:')), /paired-chrome-native-split-vendor-update\.mjs/);
    assert.doesNotMatch(workflow, /apt-get|dpkg -i|google-chrome-stable_current|puppeteer browsers install/);
});


test('appearance-actions selects its exact eight setup/prerequisite/acceptance cases without replacing other plans', () => {
    const report = createPairedChromeRunReport(names, 'appearance-actions');
    assert.equal(report.runMode, 'appearance-actions');
    assert.equal(report.expectedCaseCount, 8);
    assert.deepEqual(indices(report), appearanceActionsOrder);
    assert.deepEqual(report.checks, appearanceActionsOrder.map(caseIndex => ({ caseIndex, name: names[caseIndex], status: 'not_run' })));
    assert.match(report.scope, /Supplemental fresh-profile appearance, theme, options, recovery and initial Spotlight actions/);
    assert.match(report.scope, /not a full-suite result/);
    assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
    assert.deepEqual(indices(createPairedChromeRunReport(names, 'full')), fullOrder);
    assert.deepEqual(indices(createPairedChromeRunReport(names, 'favorite-lifecycle')), lifecycleOrder);
    assert.deepEqual(indices(createPairedChromeRunReport(names, 'native-split')), [0, 1, 2, 39]);
    for (const caseIndex of [3, 31, 32, 34, 35, 36, 37, 38, 39, 40, 45]) {
        assert.throws(() => beginPairedChromeCase(report, names[caseIndex]), /not selected/);
    }
    assert.deepEqual(report.executedCaseIndices, []);
    for (const other of ['full', 'favorite-lifecycle', 'native-split']) {
        const completed = passedReport('appearance-actions'); completed.runMode = other;
        assert.throws(() => assertPairedChromeRunPassed(completed));
    }
});

test('shared appearance prerequisite owns its fixtures and persists defaults through real options input', () => {
    const appearance = readSourceText(new URL('../../scripts/paired-chrome-sidebar-appearance.mjs', import.meta.url));
    assert.equal((smoke.match(/exerciseSidebarAppearance\(/g) || []).length, 1);
    assert.match(appearance, /chrome\.bookmarks\.create\(options\)/);
    assert.match(appearance, /requestScopedFavorite\(page, fixture.windowA, 'addBookmark'/);
    assert.match(appearance, /apiPage.click\('#resetSidebarAppearance'\)/);
    assert.match(appearance, /state\?\.favoritesLayout === 'standard' && state.favoriteTileSize === 44 && state.spaceHeaderSize === 16/);
    assert.match(appearance, /Verify default appearance survives options reload/);
    assert.match(appearance, /for \(const favorite of saved\) await requestScopedFavorite\(page, fixture.windowA, 'remove', \{ favoriteId: favorite.id \}\)/);
    assert.match(appearance, /for \(const id of bookmarks\) await chrome.bookmarks.remove\(id\)/);
    assert.doesNotMatch(appearance, /persistentFixture|ordinaryFixture|sidebarFixture/);
});
