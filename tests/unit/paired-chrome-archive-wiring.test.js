// Extract orchestration only. No executable runner import, browser or workflow run.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readSourceText } from '../source-text.js';
import { SPOTLIGHT_ARCHIVE_OPEN_CASE_NAME, SPOTLIGHT_ARCHIVE_REOPEN_CASE_NAME, serveSpotlightArchiveFixture } from '../../scripts/paired-chrome-spotlight-archive.mjs';
import { createPairedChromeRunReport } from '../../scripts/paired-chrome-run-plan.mjs';
const runner = readSourceText(new URL('../../scripts/paired-chrome-smoke.mjs', import.meta.url));
const workflow = readSourceText(new URL('../../.github/workflows/paired-extension-smoke.yml', import.meta.url));
const block = runner.slice(runner.indexOf("    if (report.runMode === 'archive-actions') {"), runner.indexOf('    } // Supplemental Archive cases 52–53;') + 5);
const names = [...runner.match(/const stepNames = \[([\s\S]*?)\n\];/)[1].matchAll(/^\s*'([^']*)',?$/gm)].map(match => match[1]);
const oldModes = ['full', 'favorite-lifecycle', 'native-split', 'appearance-actions', 'recovery-actions', 'extended-actions'];
async function runArchive({ mode = 'archive-actions', failAt, saveFailure } = {}) {
    const dependencies = Object.fromEntries(['browser', 'observePage', 'arcifyOptions', 'spotlightOptions', 'newTabPage', 'openSavedMovePage', 'ui', 'screenshot', 'snapshot', 'external', 'poll', 'fixture', 'arcifyId', 'spotlightId', 'search'].map(name => [name, { name }]));
    const native = Object.fromEntries(['prepareRecoverySidebarObservation', 'nativePanelState', 'captureNativeSidebar', 'resolveNativeSidebarTarget', 'closeNativeSidebar'].map(name => [name, { name }]));
    const selected = createPairedChromeRunReport(names, mode).expectedCases.filter(item => item.caseIndex >= 52);
    const report = { runMode: mode }, calls = [], saves = [], error = new Error('exact Archive failure');
    const exercise = (index, field) => async adapters => {
        calls.push(index);
        const expected = { ...dependencies, apiPage: dependencies.arcifyOptions, openSavedPage: dependencies.openSavedMovePage };
        delete expected.arcifyOptions; delete expected.openSavedMovePage;
        assert.deepEqual(Object.keys(adapters).sort(), [...Object.keys(expected), 'record', ...(index === 52 ? ['nativePanel'] : [])].sort());
        for (const [name, value] of Object.entries(expected)) assert.equal(adapters[name], value, `${name} must retain the real shared adapter.`);
        if (index === 52) for (const [key, name] of [['prepare', 'prepareRecoverySidebarObservation'], ['state', 'nativePanelState'], ['capture', 'captureNativeSidebar'], ['resolve', 'resolveNativeSidebarTarget'], ['close', 'closeNativeSidebar']]) assert.equal(adapters.nativePanel[key], native[name]);
        const first = { checkpoints: [{ phase: 'before-native-proof', index }], complete: false };
        await adapters.record(first); assert.equal(report[field], first);
        if (failAt === index) throw error;
        const final = { ...first, complete: true }; await adapters.record(final); return final;
    };
    const result = new vm.Script(`(async () => { ${block} })()`).runInNewContext({ ...dependencies, ...native, report, stepNames: names,
        saveReport: async () => { if (saveFailure) throw error; saves.push(JSON.parse(JSON.stringify(report))); },
        exerciseSpotlightArchiveOpen: exercise(52, 'spotlightArchiveOpen'), exerciseSpotlightArchiveReopen: exercise(53, 'spotlightArchiveReopen'),
        step: async (name, callback, ...options) => { assert.deepEqual(options, [], 'Archive cannot gain a window-isolation or skip exemption.'); assert.equal(name, selected[calls.length].name); return callback(); }
    });
    if (failAt !== undefined || saveFailure) await assert.rejects(result, actual => actual === error); else await result;
    return { report, calls, saves };
}

test('archive-actions mandates setup and both stable new cases, exactly once', async () => {
    const plan = createPairedChromeRunReport(names, 'archive-actions');
    assert.deepEqual(plan.expectedCases.map(item => item.caseIndex), [0, 1, 2, 52, 53]); assert.equal(plan.expectedCaseCount, 5);
    assert.equal(names[52], SPOTLIGHT_ARCHIVE_OPEN_CASE_NAME); assert.equal(names[53], SPOTLIGHT_ARCHIVE_REOPEN_CASE_NAME);
    assert.match(plan.scope, /not a full-suite or extended-actions result/);
    for (const [index, constant] of [[52, 'SPOTLIGHT_ARCHIVE_OPEN_CASE_NAME'], [53, 'SPOTLIGHT_ARCHIVE_REOPEN_CASE_NAME']]) assert(runner.includes(`assert.equal(stepNames[${index}], ${constant},`));
    const { report, calls, saves } = await runArchive(); assert.deepEqual(calls, [52, 53]); assert.equal(saves.length, 4);
    assert.equal(report.spotlightArchiveOpen.complete, true); assert.equal(report.spotlightArchiveReopen.complete, true);
    assert.equal(saves[0].spotlightArchiveOpen.complete, false); assert.equal(saves[2].spotlightArchiveReopen.complete, false);
    assert.doesNotMatch(block, /windowIsolation|\.catch\(|retry|skipped|nativeTodayMoveSidebar/);
});
test('archive-reopen mandates fresh setup and the unchanged exact-entry case without opening the panel', async () => {
    const plan = createPairedChromeRunReport(names, 'archive-reopen');
    assert.deepEqual(plan.expectedCases.map(item => item.caseIndex), [0, 1, 2, 53]); assert.equal(plan.expectedCaseCount, 4);
    assert.equal(plan.expectedCases[3].name, SPOTLIGHT_ARCHIVE_REOPEN_CASE_NAME);
    assert.match(plan.scope, /Supplemental fresh-profile Spotlight Archive exact-entry reopen/);
    assert.match(plan.scope, /not native-panel opening, archive-actions or full-suite acceptance/);
    const { report, calls, saves } = await runArchive({ mode: 'archive-reopen' });
    assert.deepEqual(calls, [53]); assert.equal(saves.length, 2);
    assert.equal(report.spotlightArchiveOpen, undefined); assert.equal(report.spotlightArchiveReopen.complete, true);
    assert.equal(saves[0].spotlightArchiveReopen.complete, false); assert.equal(saves[1].spotlightArchiveReopen.complete, true);
    assert(saves.every(saved => saved.spotlightArchiveOpen === undefined));
    const fixture = readSourceText(new URL('../../scripts/paired-chrome-spotlight-archive.mjs', import.meta.url));
    const reopen = fixture.slice(fixture.indexOf('export async function exerciseSpotlightArchiveReopen('));
    assert.match(reopen, /return archiveFixture\(adapters,/);
    assert.doesNotMatch(reopen, /nativePanel|exerciseSpotlightArchiveOpen|prepareRecoverySidebarObservation/);
    const setup = fixture.slice(fixture.indexOf('async function archiveFixture('), fixture.indexOf('export async function exerciseSpotlightArchiveOpen('));
    assert.match(setup, /await option\(false\); await apiPage.evaluate\(installSpotlightActionApiObservation\); await spotlightOptions.evaluate\(installSpotlightActionApiObservation\)/);
    assert.match(setup, /fixtureApi = await createNavigationFixturePage\(/);
    assert.match(setup, /owned-archive-fixture/);
    assert.match(setup, /finishBookmarkFixture\(/);
});
test('independent reopen failure retains partial evidence and cannot borrow native-opening evidence', async () => {
    const { report, calls, saves } = await runArchive({ mode: 'archive-reopen', failAt: 53 });
    assert.deepEqual(calls, [53]); assert.equal(saves.length, 1);
    assert.equal(report.spotlightArchiveOpen, undefined); assert.equal(report.spotlightArchiveReopen.complete, false);
});
test('independent reopen persistence failure remains fatal without retry or borrowed evidence', async () => {
    const { report, calls, saves } = await runArchive({ mode: 'archive-reopen', saveFailure: true });
    assert.deepEqual(calls, [53]); assert.deepEqual(saves, []);
    assert.equal(report.spotlightArchiveOpen, undefined); assert.equal(report.spotlightArchiveReopen.complete, false);
});
for (const mode of oldModes) test(`${mode} cannot run or claim Archive acceptance`, async () => {
    const { report, calls, saves } = await runArchive({ mode }); assert.deepEqual(report, { runMode: mode }); assert.deepEqual(calls, []); assert.deepEqual(saves, []);
    assert(!createPairedChromeRunReport(names, mode).expectedCases.some(item => [52, 53].includes(item.caseIndex)));
});
for (const failAt of [52, 53]) test(`Archive case ${failAt} keeps partial evidence and aborts without retry`, async () => {
    const { report, calls, saves } = await runArchive({ failAt }); assert.deepEqual(calls, failAt === 52 ? [52] : [52, 53]); assert.equal(saves.length, failAt === 52 ? 1 : 3);
    assert.equal(report[failAt === 52 ? 'spotlightArchiveOpen' : 'spotlightArchiveReopen'].complete, false);
    if (failAt === 52) assert.equal(report.spotlightArchiveReopen, undefined);
});
test('Archive evidence persistence failure aborts before a subsequent case', async () => {
    const { calls, saves } = await runArchive({ saveFailure: true }); assert.deepEqual(calls, [52]); assert.deepEqual(saves, []);
});

test('dedicated real nonce HTTP route precedes generic handler and never serves invalid paths', () => {
    const source = runner.slice(runner.indexOf('server = createServer('), runner.indexOf('await new Promise(resolve => server.listen'));
    assert(source.includes('if (serveSpotlightArchiveFixture(request, response)) return;')); assert(source.indexOf('serveSpotlightArchiveFixture') < source.indexOf('const title = titles[path]'));
    let handler; const noRoute = () => false;
    new vm.Script(source).runInNewContext({ createServer: value => { handler = value; }, URL, titles: {}, serveSpotlightSplitFixture: noRoute, serveSpotlightArchiveFixture,
        serveSpotlightActionFixture: noRoute, serveSpotlightNavigationFixture: noRoute, serveSpotlightTabFixture: noRoute, overlayRecoveryFixtureResponse: () => null,
        serveNativeSplitFixture: noRoute, serveTabMenuFixture: noRoute, serveTodayMoveFixture: noRoute, serveSavedMoveFixture: noRoute, serveTodayOrderFixture: noRoute, serveOrdinaryFavoriteFixture: noRoute, serveFavoriteIconFixture: noRoute });
    const responses = [];
    for (let index = 0; index < 2; index++) { const received = []; handler({ url: `/spotlight-archive/${'a'.repeat(32)}/same-address` }, { writeHead: (...args) => received.push(args), end: value => received.push(value) }); responses.push(received);
        assert.equal(received[0][0], 200); assert.equal(received[0][1]['Cache-Control'], 'no-store'); assert.match(received[0][1]['Content-Security-Policy'], /default-src 'none'/);
        assert.match(received[1], /data-document-id="[a-f0-9]{32}"/); assert.match(received[1], /id="action-page-state"/); }
    assert.notEqual(responses[0][1], responses[1][1], 'Each real document carries an independent retained identity.');
    for (const path of ['/spotlight-archive/short/source', `/spotlight-archive/${'a'.repeat(32)}/<script>`, `/spotlight-archive/${'a'.repeat(32)}/source/extra`]) assert.equal(serveSpotlightArchiveFixture({ url: path }, { writeHead: () => assert.fail('No invalid route response'), end: () => assert.fail('No invalid route response') }), false);
});

for (const mode of ['archive-actions', 'archive-reopen']) test(`${mode} remains an isolated mandatory Archive job with all sandbox and exact-head gates`, () => {
    const jobs = [...workflow.matchAll(/^  ([a-z-]+):\n(?=    runs-on:)([\s\S]*?)(?=^  [a-z-]+:\n|$(?![\s\S]))/gm)];
    assert.equal(jobs.length, 8); const selected = jobs.filter(job => job[1] === mode); assert.equal(selected.length, 1); const job = selected[0][2];
    assert(job.includes(`ARCIFY_PAIRED_RUN_MODE: ${mode}\n`)); assert.match(job, /timeout-minutes: 20\n/); assert.match(job, /CI: 'true'/);
    assert.match(job, /persist-credentials: false/); assert.match(job, /npm test --prefix arcify\/scripts\/paired-chrome-runtime/); assert.match(job, /set -o pipefail/);
    assert(job.includes(`tee test-results/paired-chrome-${mode}/runner.log`)); assert(job.includes(`name: paired-chrome-${mode}-` + '${{ github.run_id }}-${{ github.run_attempt }}'));
    assert(job.includes(`path: arcify/test-results/paired-chrome-${mode}/`)); assert.match(job, /if: always\(\)/);
    assert.doesNotMatch(job, /vendor-update|native-split-update|needs:|continue-on-error:|strategy:|secrets\.|no-sandbox|disable-web-security|retry|if: (?!always\(\))/);
    assert(runner.includes(`report.runMode === '${mode}' ? 'test-results/paired-chrome-${mode}'`));
    for (const path of ['scripts/paired-chrome-spotlight-archive.mjs', 'tests/unit/paired-chrome-spotlight-archive.test.js', 'tests/unit/paired-chrome-archive-wiring.test.js', 'docs/archive-actions-paired-ci.md', 'spotlight-archive-actions.js', 'archive-store.js', 'archive-client.js', 'archive-intent-ui.js', 'archive-display-session.js', 'tests/unit/helpers/archive-display-fixture.js', 'tests/unit/archive-intent-ui.test.js', 'tests/unit/archive-popup.test.js', 'docs/archive-operations.md', 'tests/unit/spotlight-archive*.test.js', 'tests/unit/archive-store*.test.js', 'scripts/lib/spotlight-pair-archive-*.mjs']) assert(workflow.includes(`- '${path}'`), path);
});
