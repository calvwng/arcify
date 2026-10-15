import test from 'node:test';
import assert from 'node:assert/strict';
import { readSourceText } from '../source-text.js';
import { createPairedChromeRunReport, beginPairedChromeCase, assertPairedChromeRunPassed } from '../../scripts/paired-chrome-run-plan.mjs';

const smoke = readSourceText(new URL('../../scripts/paired-chrome-smoke.mjs', import.meta.url));
const workflow = readSourceText(new URL('../../.github/workflows/paired-extension-smoke.yml', import.meta.url));
const namesBlock = smoke.match(/const stepNames = \[([\s\S]*?)\n\];/)[1];
const names = [...namesBlock.matchAll(/^\s*'([^']*)',?$/gm)].map(match => match[1]);
const fullOrder = [...Array.from({ length: 32 }, (_, index) => index), 33, 34, 35, 37, 38, 36, 32];
const lifecycleOrder = [0, 1, 2, 36, 32];
const indices = report => report.expectedCases.map(item => item.caseIndex);
const stepIndices = source => [...source.matchAll(/await step\(stepNames\[(\d+)\]/g)].map(match => Number(match[1]));
function passedReport(mode) {
    const report = createPairedChromeRunReport(names, mode);
    for (const item of report.expectedCases) beginPairedChromeCase(report, item.name).status = 'passed';
    return report;
}

test('full is the default and requires all 39 cases with menus before unchanged Favorite lifecycle cases', () => {
    const report = createPairedChromeRunReport(names);
    assert.equal(report.runMode, 'full');
    assert.equal(report.expectedCaseCount, 39);
    assert.deepEqual(indices(report), fullOrder);
    assert.deepEqual([...indices(report)].sort((a, b) => a - b), Array.from({ length: 39 }, (_, index) => index));
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

for (const mode of ['full', 'favorite-lifecycle', 'native-split']) {
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

test('actual smoke orchestration preserves full order and gates only unrelated cases', () => {
    const start = smoke.indexOf("    if (report.runMode === 'full') {\n");
    const end = smoke.indexOf("    } // Full-only cases 3–31, 33–35 and 37–38; preserve the original cases' order.");
    assert(start > 0 && end > start);
    assert.deepEqual(stepIndices(smoke), fullOrder);
    assert.deepEqual(stepIndices(smoke.slice(0, start)), [0, 1, 2]);
    assert.deepEqual(stepIndices(smoke.slice(start, end)), fullOrder.filter(index => !lifecycleOrder.includes(index)));
    assert.deepEqual(stepIndices(smoke.slice(end)), [36, 32]);
    assert.match(smoke, /createPairedChromeRunReport\(stepNames, process\.env\.ARCIFY_PAIRED_RUN_MODE\)/);
    assert.match(smoke, /const check = beginPairedChromeCase\(report, name\)/);
    assert.match(smoke, /assert\(!detail\?\.skipped,/);
    assert.match(smoke, /assertPairedChromeRunPassed\(report\);\n    report.status = 'passed'/);
    assert.doesNotMatch(smoke, /passed_with_skips/);
    assert.match(smoke, /ordinaryFixture:ordinaryFixture\.restartFixture/);
    assert.match(smoke, /profile = await mkdtemp\(/);
    assert.match(smoke, /report\.runMode === 'full' \? 'test-results\/paired-chrome' : 'test-results\/paired-chrome-favorite-lifecycle'/);
});

test('workflow keeps the original full job and adds an independent mandatory fresh-runner lifecycle job', () => {
    const jobs = [...workflow.matchAll(/^  ([a-z-]+):\n(?=    runs-on:)([\s\S]*?)(?=^  [a-z-]+:\n|$(?![\s\S]))/gm)];
    assert.deepEqual(jobs.map(match => match[1]), ['paired-chrome', 'favorite-lifecycle', 'native-split']);
    const full = jobs[0][2], lifecycle = jobs[1][2], nativeSplit = jobs[2][2];
    const peerPin = smoke.match(/const PINNED_SPOTLIGHT = '([0-9a-f]{40})'/)[1];
    for (const job of [full, lifecycle, nativeSplit]) {
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
    assert.match(workflow, /^permissions:\n  contents: read$/m);
    for (const path of ['scripts/paired-chrome-run-plan.mjs', 'tests/unit/paired-chrome-run-plan.test.js']) {
        assert(workflow.includes(`      - '${path}'`), `Changes to ${path} must trigger both jobs.`);
    }
});


test('supplemental native split mode preserves original full39/lifecycle5 and requires real positive case', () => {
    const report = createPairedChromeRunReport(names, 'native-split');
    assert.deepEqual(indices(report), [0, 1, 2, 39]);
    assert.equal(report.expectedCaseCount, 4);
    assert.match(report.scope, /Supplemental fresh-profile native Split View positive/);
    assert.match(report.scope, /not a full-suite result/);
    assert.match(report.expectedCases[3].name, /real drag and keyboard create native Split View/);
    assert.equal(createPairedChromeRunReport(names, 'full').expectedCaseCount, 39);
    assert.equal(createPairedChromeRunReport(names, 'favorite-lifecycle').expectedCaseCount, 5);
    const start = smoke.indexOf("    if (report.runMode === 'native-split') {");
    const end = smoke.indexOf('    } else {', start);
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
