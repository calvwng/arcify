/** Pure run selection/report guards. Importing this module never launches Chrome. */
import assert from 'node:assert/strict';

// Case indices are stable identities in paired-chrome-smoke.mjs. Restart must
// remain last: it intentionally invalidates the original browser-session IDs.
const FULL_CASE_INDICES = Object.freeze([...Array.from({ length: 32 }, (_, index) => index), 33, 34, 35, 37, 38, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 36, 32]);
const FAVORITE_LIFECYCLE_CASE_INDICES = Object.freeze([0, 1, 2, 36, 32]);
// Supplemental positive capability coverage never removes full/lifecycle cases.
export const NATIVE_SPLIT_CASE_NAME = 'Today real drag and keyboard create native Split View pairs without replacing pages';
const NATIVE_SPLIT_CASE_INDICES = Object.freeze([0, 1, 2, 39]);
// Case 33 owns its density fixtures and persists Standard/default appearance.
// Run it unchanged before the native theme/options/recovery/initial-action cases.
const APPEARANCE_ACTION_CASE_INDICES = Object.freeze([0, 1, 2, 33, 46, 47, 48, 49]);
// Recovery/actions own their fixtures; only native Sidebar event observation
// needs initialization when the earlier appearance cases have not run.
const RECOVERY_ACTION_CASE_INDICES = Object.freeze([0, 1, 2, 48, 49]);
// Extended actions own their setup/cleanup and require no prior case mutations.
const EXTENDED_ACTION_CASE_INDICES = Object.freeze([0, 1, 2, 50, 51]);
// Archive needs independent native-host and exact-entry evidence, never a Sidebar substitute.
const ARCHIVE_ACTION_CASE_INDICES = Object.freeze([0, 1, 2, 52, 53]);
// Reopen owns its fixtures; native-popup failure must not suppress exact-entry evidence.
const ARCHIVE_REOPEN_CASE_INDICES = Object.freeze([0, 1, 2, 53]);
const ALL_CASE_INDICES = Object.freeze([...new Set([...FULL_CASE_INDICES, ...FAVORITE_LIFECYCLE_CASE_INDICES,
    ...NATIVE_SPLIT_CASE_INDICES, ...APPEARANCE_ACTION_CASE_INDICES, ...RECOVERY_ACTION_CASE_INDICES,
    ...EXTENDED_ACTION_CASE_INDICES, ...ARCHIVE_ACTION_CASE_INDICES, ...ARCHIVE_REOPEN_CASE_INDICES])].sort((a, b) => a - b));

function caseIndicesForMode(mode) {
    assert(mode === 'full' || mode === 'favorite-lifecycle' || mode === 'native-split' || mode === 'appearance-actions' || mode === 'recovery-actions' || mode === 'extended-actions' || mode === 'archive-actions' || mode === 'archive-reopen',
        `Unsupported ARCIFY_PAIRED_RUN_MODE: ${String(mode)}. Expected full, favorite-lifecycle, native-split, appearance-actions, recovery-actions, extended-actions, archive-actions or archive-reopen.`);
    return mode === 'full' ? FULL_CASE_INDICES : mode === 'favorite-lifecycle' ? FAVORITE_LIFECYCLE_CASE_INDICES :
        mode === 'native-split' ? NATIVE_SPLIT_CASE_INDICES : mode === 'appearance-actions' ? APPEARANCE_ACTION_CASE_INDICES : mode === 'recovery-actions' ? RECOVERY_ACTION_CASE_INDICES : mode === 'extended-actions' ? EXTENDED_ACTION_CASE_INDICES : mode === 'archive-actions' ? ARCHIVE_ACTION_CASE_INDICES : ARCHIVE_REOPEN_CASE_INDICES;
}

export function createPairedChromeRunReport(caseNames, mode = 'full') {
    const indices = caseIndicesForMode(mode);
    assert(Array.isArray(caseNames) && caseNames.length === ALL_CASE_INDICES.length,
        'Every paired-Chrome case must be included in an explicit run plan.');
    assert.deepEqual(ALL_CASE_INDICES, caseNames.map((_, index) => index), 'Explicit run plans must cover every case identity without gaps.');
    assert(caseNames.every(name => typeof name === 'string' && name.trim()), 'Every case requires a name.');
    assert.equal(new Set(caseNames).size, caseNames.length, 'Case names must be unique.');
    assert.equal(caseNames[39], NATIVE_SPLIT_CASE_NAME, 'Native case 39 must retain its stable identity.');
    const expectedCases = indices.map(caseIndex => ({ caseIndex, name: caseIndex === 39 ? NATIVE_SPLIT_CASE_NAME : caseNames[caseIndex] }));
    return {
        runMode: mode,
        scope: mode === 'full' ? 'Full paired-extension suite.' : mode === 'archive-reopen' ?
            'Supplemental fresh-profile Spotlight Archive exact-entry reopen coverage; this is not native-panel opening, archive-actions or full-suite acceptance.' : mode === 'archive-actions' ?
            'Supplemental fresh-profile Spotlight Archive native-panel and exact-entry reopen coverage; this is not a full-suite or extended-actions result.' : mode === 'extended-actions' ?
            'Supplemental fresh-profile Spotlight Space navigation and tab-command coverage; this is not a full-suite, recovery or appearance result.' : mode === 'recovery-actions' ?
            'Supplemental fresh-profile overlay recovery and initial Spotlight actions coverage; this is not a full-suite or appearance result.' : mode === 'appearance-actions' ?
            'Supplemental fresh-profile appearance, theme, options, recovery and initial Spotlight actions coverage; this is not a full-suite result.' : mode === 'native-split' ?
            'Supplemental fresh-profile native Split View positive coverage; this is not a full-suite result.' :
            'Supplemental fresh-profile Favorite lifecycle coverage; this is not a full-suite result.',
        expectedCaseCount: indices.length,
        expectedCases,
        executedCaseIndices: [],
        checks: expectedCases.map(item => ({ ...item, status: 'not_run' }))
    };
}

export function beginPairedChromeCase(report, name) {
    const check = report.checks.find(item => item.name === name);
    assert(check, `Case is not selected for ${report.runMode}: ${name}`);
    assert.equal(check.status, 'not_run', 'A selected case must run exactly once, without same-profile retries.');
    const expected = caseIndicesForMode(report.runMode)[report.executedCaseIndices.length];
    assert.equal(check.caseIndex, expected, 'Selected cases must run in the declared order.');
    report.executedCaseIndices.push(check.caseIndex);
    return check;
}

export function assertPairedChromeRunPassed(report) {
    const indices = caseIndicesForMode(report.runMode);
    assert.equal(report.expectedCaseCount, indices.length, 'The declared count must match the selected run mode.');
    assert.deepEqual(report.expectedCases.map(item => item.caseIndex), indices, 'The report must declare every selected case in order.');
    assert.deepEqual(report.checks.map(({ caseIndex, name }) => ({ caseIndex, name })), report.expectedCases,
        'The report must contain exactly the selected cases, with no omitted or extra results.');
    assert.deepEqual(report.executedCaseIndices, indices, 'Every selected case must have run exactly once in order.');
    assert(report.checks.every(check => check.status === 'passed'),
        `All ${indices.length} selected ${report.runMode} cases must pass; skipped, failed or incomplete checks cannot pass the run.`);
}
