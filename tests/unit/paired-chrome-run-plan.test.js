import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { readSourceText } from '../source-text.js';
import { createPairedChromeRunReport, beginPairedChromeCase, assertPairedChromeRunPassed } from '../../scripts/paired-chrome-run-plan.mjs';

const smoke = readSourceText(new URL('../../scripts/paired-chrome-smoke.mjs', import.meta.url));
const workflow = readSourceText(new URL('../../.github/workflows/paired-extension-smoke.yml', import.meta.url));
const namesBlock = smoke.match(/const stepNames = \[([\s\S]*?)\n\];/)[1];
const names = [...namesBlock.matchAll(/^\s*'([^']*)',?$/gm)].map(match => match[1]);
const fullOrder = [...Array.from({ length: 32 }, (_, index) => index), 33, 34, 35, 37, 38, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 36, 32];
const lifecycleOrder = [0, 1, 2, 36, 32];
const appearanceActionsOrder = [0, 1, 2, 33, 46, 47, 48, 49];
const recoveryActionsOrder = [0, 1, 2, 48, 49];
const extendedActionsOrder = [0, 1, 2, 50, 51];
const archiveActionsOrder = [0, 1, 2, 52, 53];
const archiveReopenOrder = [0, 1, 2, 53];
const allPlans = [['full', fullOrder], ['favorite-lifecycle', lifecycleOrder], ['native-split', [0, 1, 2, 39, 54]], ['appearance-actions', appearanceActionsOrder], ['recovery-actions', recoveryActionsOrder], ['extended-actions', extendedActionsOrder], ['archive-actions', archiveActionsOrder], ['archive-reopen', archiveReopenOrder]];
const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
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

for (const [mode] of allPlans) {
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
    const actionsEnd = smoke.indexOf('    } // Shared appearance cases 46–47;');
    const preparation = smoke.indexOf('    await prepareRecoverySidebarObservation();');
    const recovery = smoke.indexOf("    if (report.runMode === 'full' || report.runMode === 'appearance-actions' || report.runMode === 'recovery-actions') {");
    const recoveryEnd = smoke.indexOf('    } // Shared recovery/actions cases 48–49;');
    const extended = smoke.indexOf("    if (report.runMode === 'extended-actions') {");
    const extendedEnd = smoke.indexOf('    } // Supplemental extended-action cases 50–51;');
    const archive = smoke.indexOf("    if (report.runMode === 'archive-actions') {");
    const archiveOpenEnd = smoke.indexOf('    } // Native Archive opening remains mandatory in archive-actions.');
    const archiveReopen = smoke.indexOf("    if (report.runMode === 'archive-actions' || report.runMode === 'archive-reopen') {");
    const archiveEnd = smoke.indexOf('    } // Supplemental Archive cases 52–53;');
    const lifecycle = smoke.indexOf("    if (report.runMode === 'full' || report.runMode === 'favorite-lifecycle') {");
    assert(firstFull > 0 && firstFull < firstEnd && firstEnd < appearance && appearance < appearanceEnd &&
        appearanceEnd < secondFull && secondFull < secondEnd && secondEnd < actions && actions < actionsEnd && actionsEnd < recovery && recovery < preparation && preparation < recoveryEnd && recoveryEnd < extended && extended < extendedEnd && extendedEnd < archive && archive < archiveOpenEnd && archiveOpenEnd < archiveReopen && archiveReopen < archiveEnd && archiveEnd < lifecycle);
    assert.deepEqual(stepIndices(smoke), [...fullOrder.slice(0, -2), 50, 51, 52, 53, 54, ...fullOrder.slice(-2)], 'Every case definition remains single; the original full case order is unchanged.');
    assert.deepEqual(stepIndices(smoke.slice(0, firstFull)), [0, 1, 2]);
    assert.deepEqual(stepIndices(smoke.slice(firstFull, firstEnd)), Array.from({ length: 29 }, (_, index) => index + 3));
    assert.deepEqual(stepIndices(smoke.slice(appearance, appearanceEnd)), [33]);
    assert.deepEqual(stepIndices(smoke.slice(secondFull, secondEnd)), [34, 35, 37, 38, 40, 41, 42, 43, 44, 45]);
    assert.deepEqual(stepIndices(smoke.slice(actions, actionsEnd)), [46, 47]);
    assert.deepEqual(stepIndices(smoke.slice(recovery, preparation)), []);
    assert.deepEqual(stepIndices(smoke.slice(recovery, recoveryEnd)), [48, 49]);
    assert.deepEqual(stepIndices(smoke.slice(extended, extendedEnd)), [50, 51]);
    assert.deepEqual(stepIndices(smoke.slice(archive, archiveEnd)), [52, 53]);
    assert.deepEqual(stepIndices(smoke.slice(archive, archiveOpenEnd)), [52]);
    assert.deepEqual(stepIndices(smoke.slice(archiveReopen, archiveEnd)), [53]);
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
    assert.match(smoke, /report\.runMode === 'recovery-actions' \? 'test-results\/paired-chrome-recovery-actions'/);
});

// Execute only the runner's real branch/step orchestration. The callbacks are
// never invoked: no runner import, Chrome, fixture mutation or native input.
const orchestration = smoke.slice(smoke.indexOf('    await step(stepNames[0]'), smoke.indexOf("    assert(report.screenshots.length > 0"));
async function runOrchestration(mode, failAt = null, definitions = []) {
    const report = createPairedChromeRunReport(names, mode);
    const failure = new Error('Selected case failed');
    let preparations = 0;
    const execute = new vm.Script(`(async () => { ${orchestration} })()`).runInNewContext({
        report, stepNames: names, NATIVE_SPLIT_CASE_NAME: names[39],
        prepareRecoverySidebarObservation: async () => {
            preparations++;
            const order = allPlans.find(([plan]) => plan === mode)[1];
            assert.deepEqual(report.executedCaseIndices, order.slice(0, order.indexOf(48)), 'Observation is prepared in the current API realm immediately before recovery.');
            if (failAt === 'observation') throw failure;
        },
        step: async (name, callback, options) => {
            assert.equal(typeof callback, 'function');
            definitions.push({ caseIndex: names.indexOf(name), name, callback: String(callback), options: options ? JSON.parse(JSON.stringify(options)) : null });
            const check = beginPairedChromeCase(report, name);
            assert.deepEqual(options ? JSON.parse(JSON.stringify(options)) : null, check.caseIndex === 32 ? { windowIsolation: false } : null,
                'No selected case may acquire a window-isolation exemption.');
            if (check.caseIndex === failAt) { check.status = 'failed'; throw failure; }
            check.status = 'passed';
        }
    });
    if (failAt !== null) await assert.rejects(execute, error => error === failure);
    else await execute;
    const order = allPlans.find(([plan]) => plan === mode)[1], recoveryIndex = order.indexOf(48);
    assert.equal(preparations, recoveryIndex !== -1 && (failAt === null || failAt === 'observation' || order.indexOf(failAt) >= recoveryIndex) ? 1 : 0);
    return report;
}
for (const [mode, order] of allPlans) {
    test(`actual ${mode} orchestration runs exactly its mandatory cases once without executing browser callbacks`, async () => {
        const report = await runOrchestration(mode);
        assert.deepEqual(report.executedCaseIndices, order);
        assertPairedChromeRunPassed(report);
    });
}
for (const [mode, order] of allPlans) for (const caseIndex of order) {
    test(`${mode} stops immediately when mandatory case ${caseIndex} fails, without retries or later cases`, async () => {
        const report = await runOrchestration(mode, caseIndex);
        assert.deepEqual(report.executedCaseIndices, order.slice(0, order.indexOf(caseIndex) + 1));
        assert.equal(report.checks.find(check => check.caseIndex === caseIndex).status, 'failed');
        assert.throws(() => assertPairedChromeRunPassed(report));
    });
}

test('workflow preserves original jobs and adds independent mandatory fresh-runner acceptance', () => {
    const jobs = [...workflow.matchAll(/^  ([a-z-]+):\n(?=    runs-on:)([\s\S]*?)(?=^  [a-z-]+:\n|$(?![\s\S]))/gm)];
    assert.deepEqual(jobs.map(match => match[1]), ['paired-chrome', 'favorite-lifecycle', 'appearance-actions', 'native-split', 'recovery-actions', 'extended-actions', 'archive-actions', 'archive-reopen']);
    const full = jobs[0][2], lifecycle = jobs[1][2], appearanceActions = jobs[2][2], nativeSplit = jobs[3][2], recoveryActions = jobs[4][2], extendedActions = jobs[5][2], archiveActions = jobs[6][2], archiveReopen = jobs[7][2];
    const peerPin = smoke.match(/const PINNED_SPOTLIGHT = '([0-9a-f]{40})'/)[1];
    for (const job of [full, lifecycle, appearanceActions, nativeSplit, recoveryActions, extendedActions, archiveActions, archiveReopen]) {
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
    assert.match(recoveryActions, /ARCIFY_PAIRED_RUN_MODE: recovery-actions/);
    assert.match(recoveryActions, /tee test-results\/paired-chrome-recovery-actions\/runner\.log/);
    assert.match(recoveryActions, /name: paired-chrome-recovery-actions-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
    assert.match(recoveryActions, /path: arcify\/test-results\/paired-chrome-recovery-actions\//);
    assert.match(recoveryActions, /timeout-minutes: 20\n/);
    assert.doesNotMatch(recoveryActions, /vendor-update|native-split-update|retry|if: (?!always\(\))/);
    assert.match(extendedActions, /ARCIFY_PAIRED_RUN_MODE: extended-actions/);
    assert.match(extendedActions, /tee test-results\/paired-chrome-extended-actions\/runner\.log/);
    assert.match(extendedActions, /name: paired-chrome-extended-actions-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
    assert.match(extendedActions, /path: arcify\/test-results\/paired-chrome-extended-actions\//);
    assert.match(extendedActions, /timeout-minutes: 20\n/);
    assert.doesNotMatch(extendedActions, /vendor-update|native-split-update|retry|if: (?!always\(\))/);
    assert.match(workflow, /^permissions:\n  contents: read$/m);
    for (const path of ['scripts/paired-chrome-run-plan.mjs', 'tests/unit/paired-chrome-run-plan.test.js', 'docs/appearance-actions-paired-ci.md', 'docs/recovery-actions-paired-ci.md', 'docs/extended-actions-paired-ci.md']) {
        assert(workflow.includes(`      - '${path}'`), `Changes to ${path} must trigger all jobs.`);
    }
});


test('supplemental native split mode preserves full49/lifecycle5 and requires real positive case', () => {
    const report = createPairedChromeRunReport(names, 'native-split');
    assert.deepEqual(indices(report), [0, 1, 2, 39, 54]);
    assert.equal(report.expectedCaseCount, 5);
    assert.match(report.scope, /Supplemental fresh-profile native Split View and trusted Spotlight/);
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
    assert.deepEqual(indices(createPairedChromeRunReport(names, 'native-split')), [0, 1, 2, 39, 54]);
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

// Preservation receipts from reviewed Arcify 920c901cead1c497e6f6921952883744d948538c.
// These hash exact callback text/options and job text, not execution results.
// A later deliberate change must be reviewed before updating its receipt.
test('existing callbacks retain their reviewed bytes except exact additive routes and peer helper compatibility', async () => {
    const definitions = new Map();
    for (const [mode] of allPlans) {
        const observed = []; await runOrchestration(mode, null, observed);
        for (const definition of observed) {
            if (definitions.has(definition.caseIndex)) assert.deepEqual(definition, definitions.get(definition.caseIndex));
            else definitions.set(definition.caseIndex, definition);
        }
    }
    assert.deepEqual([...definitions.keys()].sort((a, b) => a - b), Array.from({ length: 55 }, (_, index) => index));
    // Normalize only these reviewed additive harness lines. The reviewed case 36 control-window setup
    // is retained in its new receipt; other original bodies/options/names stay unchanged. New wiring has its
    // own executable mocked-adapter tests in paired-chrome-extended-wiring.
    // Case 20's reviewed viewport/paint readiness is retained in this receipt;
    // its original refresh and exact native-identity gates are still required.
    const preserved = [...definitions].filter(([index]) => index < 50).sort(([a], [b]) => a - b).map(([, item]) => ({ ...item,
        callback: (item.caseIndex === 38 ? item.callback.replace(/^async \(\) => \{\n        await (exerciseTabMenuActions\([\s\S]*?\}\));\n        return exerciseMoveToNewWindow\([\s\S]*?\);\n    \}$/, (_, original) => '() => ' + original.replaceAll('\n            ', '\n        ')) : item.callback).replace('            if (serveSpotlightNavigationFixture(request, response)) return;\n', '')
            .replace('            if (serveSpotlightTabFixture(request, response)) return;\n', '')
            .replace('            if (serveSpotlightSplitFixture(request, response)) return;\n', '')
            .replace('            if (serveSpotlightArchiveFixture(request, response)) return;\n', '')
            // Only the exact additive case 7 route is normalized; its original callback bytes remain guarded.
            .replace("        await exerciseBookmarkFallback({apiPage:arcifyOptions,spotlightOptions,arcifyOptions,newTabPage,ui,screenshot,poll,fixture,\n            spotlightId,arcifyId,search,sidebarInput,typeUI,clickUI,snapshot,\n            record:async observation=>{report.bookmarkFallback=observation;await saveReport();}});\n", '')
            .replace('        helperNavigation:true,\n', '') }));
    assert.equal(digest(preserved), '78ad712cf32595be32920d118d0bd7206a85713620a140afe1f83ce468ca0088');
    // Supplemental callbacks 50–53 are unchanged from a56bd14; reopening shares the exact case 53 definition.
    assert.equal(digest([...definitions].filter(([index]) => index >= 50 && index < 54).sort(([a], [b]) => a - b).map(([, item]) => item)), '8f9a8a9f702230caf28fedeaf95b84cbbbc18ae15294506eb8eaf3c2f7ca0bef');
    assert.equal(digest(names.slice(0, 50)), '82b76b57d9a4a3fcefa59ea4db2f52af9664a1d5693b2efff89405c32827c36c');
});

test('all five original workflow jobs retain reviewed bytes and order except the exact peer-pin upgrade', () => {
    const jobs = [...workflow.matchAll(/^  ([a-z-]+):\n(?=    runs-on:)([\s\S]*?)(?=^  (?:[a-z-]+:|#)|$(?![\s\S]))/gm)];
    const receipts = [
        ['paired-chrome', '804ad3202df17883340f7790dadf5d86e73d8120cbe73f6a22c05856b4c40e52'],
        ['favorite-lifecycle', '7ef8bd8269d3951bcbbb3c6720d6ac7d25b19fd82b54f7c4936734ccc700f131'],
        ['appearance-actions', '0622e759d781ee59f367c5aeee5738601a629bb0471bf9966d7d300bf827d229'],
        ['native-split', 'e84564f44460142644c4bfa54d0e3818b004b82ec7d9f54e6dcb23356c7774c4'],
        ['recovery-actions', 'ef0ee6ab8d6275b1509f56446bc011c1e10b99c968b459ec8997f2f0ab328c5f']
    ];
    // Only this exact reviewed companion upgrade is excluded from legacy bytes.
    const legacyPinBytes = source => source.replaceAll('deb672a415ed58a61ae30c874926b7274615371c', '9c4462fb0f3cbfe2585757c43f34398e9c906fde');
    assert.deepEqual(jobs.slice(0, 5).map(match => [match[1], digest(legacyPinBytes(match[0].trimEnd()))]), receipts);
    assert.equal(jobs[5][1], 'extended-actions');
    assert.equal(jobs[6][1], 'archive-actions');
    assert.equal(jobs[7][1], 'archive-reopen');
    assert.equal(jobs.length, 8);
    // Existing supplemental jobs retain a56bd14 bytes except this exact peer-pin upgrade.
    const archivePinBytes = source => source.replaceAll('deb672a415ed58a61ae30c874926b7274615371c', 'b510b3dbe8cfae6441fbc55a23ce19de30805a6d');
    assert.equal(digest(archivePinBytes(jobs[5][0].trimEnd())), '0d01f7440c701db284e286566d4acbd7ba3d590e52e01c8e54435a14aa92875c');
    assert.equal(digest(archivePinBytes(jobs[6][0].trimEnd())), 'aefdebbb6af8c3c11e312ecb716bb5d7c172117a9cffd0df638e3002216b6cdc');
    // Normalize only the reviewed additive Split/display watch paths; event/security configuration is unchanged.
    const addedWatchPaths = ['new-tab-window-drop.js', 'tests/unit/new-tab-window-drop.test.js', 'scripts/paired-chrome-new-tab-drop.mjs', 'tests/unit/paired-chrome-new-tab-drop.test.js', 'scripts/paired-chrome-move-window.mjs', 'move-tab-new-window.js', 'tests/unit/paired-chrome-move-window.test.js', 'tests/unit/move-tab-new-window.test.js', 'archive-display-session.js', 'tests/unit/helpers/archive-display-fixture.js',
        'scripts/paired-chrome-spotlight-split.mjs', 'spotlight-split-actions.js',
        'tests/unit/spotlight-split-actions.test.js', 'tests/unit/paired-chrome-spotlight-split.test.js',
        'tests/unit/paired-chrome-split-wiring.test.js', 'scripts/lib/spotlight-pair-split-*.mjs', 'docs/spotlight-split-actions.md'];
    const originalEvents = addedWatchPaths.reduce((source, path) => source.replace(`      - '${path}'\n`, ''), workflow.slice(0, workflow.indexOf('jobs:')));
    assert.equal(digest(originalEvents), '1bc18e330dfd97cfdca18fa5cb05a035dd3061ed1a61e182c82019aee5d1e1d1');
    // No shared conditions or workflow event/security changes can hide a job.
    assert.equal(workflow.match(/^permissions:\n  contents: read$/gm)?.length, 1);
    assert.doesNotMatch(workflow, /pull_request_target:|\bneeds:|continue-on-error:|fail-fast:|strategy:|secrets\.|permissions:\s*write|concurrency:/);
});

test('recovery-actions requires exactly setup 0–2 and unchanged recovery 48/actions 49, without theme evidence', () => {
    const report = createPairedChromeRunReport(names, 'recovery-actions');
    assert.equal(report.expectedCaseCount, 5);
    assert.deepEqual(indices(report), recoveryActionsOrder);
    assert.deepEqual(report.checks, recoveryActionsOrder.map(caseIndex => ({ caseIndex, name: names[caseIndex], status: 'not_run' })));
    assert.match(report.scope, /Supplemental fresh-profile overlay recovery and initial Spotlight actions/);
    assert.match(report.scope, /not a full-suite or appearance result/);
    assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
    assert.match(report.expectedCases[3].name, /recovers dormant and orphaned overlays/);
    assert.match(report.expectedCases[4].name, /Initial Spotlight actions/);
});

for (const [mode, order] of allPlans) {
    test(`${mode} rejects every unselected case and cannot relabel its evidence as another plan`, () => {
        const report = createPairedChromeRunReport(names, mode);
        for (const index of names.keys()) if (!order.includes(index)) {
            assert.throws(() => beginPairedChromeCase(report, names[index]), /not selected/);
        }
        assert.deepEqual(report.executedCaseIndices, []);
        for (const [other] of allPlans) if (other !== mode) {
            const completed = passedReport(mode); completed.runMode = other;
            assert.throws(() => assertPairedChromeRunPassed(completed));
        }
    });
}

for (const [mode, order] of allPlans.filter(([, order]) => order.includes(48))) test(`${mode} observer preparation failure stops before 48/49 and cannot produce passing evidence`, async () => {
    const report = await runOrchestration(mode, 'observation');
    assert.deepEqual(report.executedCaseIndices, order.slice(0, order.indexOf(48)));
    assert.deepEqual(report.checks.slice(order.indexOf(48)).map(check => check.status), order.slice(order.indexOf(48)).map(() => 'not_run'));
    assert.throws(() => assertPairedChromeRunPassed(report));
});

function recoveryObservationHarness(initial) {
    const opened = [], closed = [];
    const realm = vm.createContext({ chrome: { sidePanel: {
        onOpened: { addListener: listener => opened.push(listener) },
        onClosed: { addListener: listener => closed.push(listener) }
    } } });
    if (initial !== undefined) realm.__pairedSidebarEvents = initial;
    const start = smoke.indexOf('async function prepareRecoverySidebarObservation()');
    const end = smoke.indexOf('async function resolveNativeSidebarTarget()', start);
    const evaluate = callback => vm.runInContext(`(${callback})()`, realm);
    const prepare = new vm.Script(`(${smoke.slice(start, end)})`).runInNewContext({ arcifyOptions: { evaluate } });
    return { prepare, realm, opened, closed, source: smoke.slice(start, end) };
}

test('fresh recovery setup only observes native Sidebar callbacks, without fabricating receipts or opening a helper', async () => {
    const h = recoveryObservationHarness(); await h.prepare();
    assert.equal(h.opened.length, 1); assert.equal(h.closed.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(h.realm.__pairedSidebarEvents)), []);
    const opened = { windowId: 7, path: 'sidebar.html' }, closed = { windowId: 7 };
    h.opened[0](opened); h.closed[0](closed);
    assert.deepEqual(JSON.parse(JSON.stringify(h.realm.__pairedSidebarEvents)), [{ type: 'opened', ...opened }, { type: 'closed', ...closed }]);
    await assert.rejects(h.prepare(), /exactly once in a fresh options realm/);
    assert.equal(h.opened.length, 1); assert.equal(h.closed.length, 1);
    assert.equal(h.realm.__pairedSidebarEvents.length, 2, 'Duplicate setup must not erase real observations.');
    assert.doesNotMatch(h.source, /\.open\(|\.close\(|newTabPage|nativeTodayMoveSidebar|sendMessage|storage|dispatchEvent|\.catch\(|retry/);
});

test('fresh recovery setup rejects pre-existing empty or populated observation state without replacing it', async () => {
    for (const initial of [[], [{ type: 'opened', windowId: 7 }], null, false]) {
        const h = recoveryObservationHarness(initial);
        await assert.rejects(h.prepare(), /exactly once in a fresh options realm/);
        assert.equal(h.realm.__pairedSidebarEvents, initial);
        assert.equal(h.opened.length, 0); assert.equal(h.closed.length, 0);
    }
});

test('setup 0–2 supplies every recovery/action fixture dependency; later cases own their fresh identities', () => {
    const setup = smoke.slice(smoke.indexOf('    await step(stepNames[0]'), smoke.indexOf("    if (report.runMode === 'full') {"));
    for (const source of ['profile = await mkdtemp(', 'arcifyOptions = await observePage(', 'spotlightOptions = await observePage(',
        'serveSpotlightActionFixture(request, response)', 'overlayRecoveryFixtureResponse(request.url)',
        "['work', 'Pair Work']", "['personal', 'Pair Personal']", "['empty', 'Pair Empty']", 'fixture.windowBBaseline = await windowBState()']) assert(setup.includes(source), source);
    const actions = readSourceText(new URL('../../scripts/paired-chrome-spotlight-actions.mjs', import.meta.url));
    assert.match(actions, /initial = await snapshot\(windowId\), initialB = await snapshot\(fixture.windowB\), source = exact\(initial.spaces, fixture.spaces.work\)/);
    assert.match(actions, /counterpart = initial.spaces.find\(space => space.id !== source.id && space.id !== fixture.spaces.empty\)/);
    assert.match(actions, /installSpotlightActionApiObservation/);
    assert.doesNotMatch(actions, /persistentFixture|ordinaryFixture|sidebarFixture|spaceTheme|spotlightOptionsAppearance/);
    const recovery = smoke.slice(smoke.indexOf('async function runHostedOverlayRecovery()'), smoke.indexOf('// Retain the same raw-target'));
    assert.match(recovery, /beforeTabs = await arcifyOptions.evaluate\(\(\) => chrome.tabs.query\(\{\}\)\)/);
    assert.match(recovery, /created = await arcifyOptions.evaluate\(options => chrome.tabs.create\(options\), \{ windowId: fixture.windowA, url, active: true \}\)/);
    assert.match(recovery, /reloadSpotlight: async \(\) => \(await reloadPairedExtension\('spotlight', \{ preserveForeground: true \}\)\).evidence/);
    assert.doesNotMatch(recovery, /persistentFixture|ordinaryFixture|sidebarFixture|spaceTheme|spotlightOptionsAppearance/);
});

test('shared step gates, recovery/sidebar evidence and final failure handling preserve their reviewed bytes', () => {
    for (const [start, end, expected] of [
        ['async function step(', 'async function internal(', '791e0719836b826f1e9fac58a48514b9cdbb3de25cb9c658c9e854888a930835'],
        ['async function runHostedOverlayRecovery()', '// Retain the same raw-target', '1b1dc1d20f36ee902e35121291cac88d4b9f3677d227f9083a187c03f7ba2e6c'],
        ['async function verifyRecoveredOverlaySidebar(', 'async function runHostedOverlayRecovery()', '27285659431753430ede7585b4027d73491e1ac1df4e8751fdedbc80f7173556'],
        ['    assert(report.screenshots.length > 0', null, 'b4864b3961076a90186da6bc9885b17c0eb31228514fa487d80daa7e9a46ef5b']
    ]) {
        const first = smoke.indexOf(start), last = end ? smoke.indexOf(end, first) : smoke.length;
        assert(first > 0 && last > first);
        assert.equal(digest(smoke.slice(first, last)), expected, start);
    }
    assert.match(smoke, /process.env.GITHUB_ACTIONS !== 'true' \|\| process.env.CI !== 'true'/);
    assert.match(smoke, /if \(process.getuid\?\.\(\) === 0\) throw new Error/);
});


test('extended-actions requires exactly setup and both new cases without changing existing scope', () => {
    const report = createPairedChromeRunReport(names, 'extended-actions');
    assert.equal(report.expectedCaseCount, 5);
    assert.deepEqual(indices(report), extendedActionsOrder);
    assert.match(report.scope, /Supplemental fresh-profile Spotlight Space navigation and tab-command/);
    assert.match(report.scope, /not a full-suite, recovery or appearance result/);
    assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
    assert.match(report.expectedCases[3].name, /genuine destination pickers/);
    assert.match(report.expectedCases[4].name, /tab commands preserve exact live and saved identities/);
});
