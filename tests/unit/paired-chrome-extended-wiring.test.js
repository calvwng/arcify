// Execute only extracted harness orchestration against mocks. Never import the
// executable runner, launch Chrome, invoke a native helper or mutate a profile.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readSourceText } from '../source-text.js';
import { SPOTLIGHT_NAVIGATION_CASE_NAME, serveSpotlightNavigationFixture } from '../../scripts/paired-chrome-spotlight-navigation.mjs';
import { SPOTLIGHT_TAB_CASE_NAME, serveSpotlightTabFixture } from '../../scripts/paired-chrome-spotlight-tabs.mjs';
const runner = readSourceText(new URL('../../scripts/paired-chrome-smoke.mjs', import.meta.url));
const workflow = readSourceText(new URL('../../.github/workflows/paired-extension-smoke.yml', import.meta.url));
const block = runner.slice(runner.indexOf("    if (report.runMode === 'extended-actions') {"), runner.indexOf('    } // Supplemental extended-action cases 50–51;') + 5);

async function runExtended({ mode = 'extended-actions', failAt, saveFailure } = {}) {
    const dependencies = Object.fromEntries(['browser', 'observePage', 'arcifyOptions', 'spotlightOptions', 'newTabPage', 'openSavedMovePage', 'pageForUrl',
        'ui', 'screenshot', 'snapshot', 'bridge', 'external', 'poll', 'fixture', 'arcifyId', 'spotlightId', 'search'].map(name => [name, { name }]));
    const report = { runMode: mode }, calls = [], saves = [], error = new Error('exact extended failure');
    const names = Array(52).fill('unused'); names[50] = SPOTLIGHT_NAVIGATION_CASE_NAME; names[51] = SPOTLIGHT_TAB_CASE_NAME;
    const exercise = (index, field) => async adapters => {
        calls.push(index);
        const expected = { ...dependencies, apiPage: dependencies.arcifyOptions, openSavedPage: dependencies.openSavedMovePage };
        delete expected.arcifyOptions; delete expected.openSavedMovePage;
        if (index === 51) delete expected.pageForUrl;
        assert.deepEqual(Object.keys(adapters).sort(), [...Object.keys(expected), 'record'].sort());
        for (const [name, value] of Object.entries(expected)) assert.equal(adapters[name], value, `${name} must be the existing real adapter.`);
        const first = { checkpoints: [{ phase: 'observed-before-failure', index }], complete: false };
        await adapters.record(first); assert.equal(report[field], first);
        if (failAt === index) throw error;
        const complete = { ...first, complete: true }; await adapters.record(complete); return complete;
    };
    const result = new vm.Script(`(async () => { ${block} })()`).runInNewContext({ ...dependencies, report, stepNames: names,
        saveReport: async () => { if (saveFailure) throw error; saves.push(JSON.parse(JSON.stringify(report))); },
        exerciseSpotlightNavigation: exercise(50, 'spotlightNavigation'), exerciseSpotlightTabCommands: exercise(51, 'spotlightTabCommands'),
        step: async (name, callback, ...options) => { assert.deepEqual(options, [], 'No isolation exemptions.'); assert.equal(name, names[calls.length ? 51 : 50]); return callback(); }
    });
    if (failAt !== undefined || saveFailure) await assert.rejects(result, actual => actual === error);
    else await result;
    return { report, calls, saves };
}

test('extended case identities are explicit and execute once with exact shared adapters and incremental evidence', async () => {
    for (const [index, name, constant] of [[50, SPOTLIGHT_NAVIGATION_CASE_NAME, 'SPOTLIGHT_NAVIGATION_CASE_NAME'], [51, SPOTLIGHT_TAB_CASE_NAME, 'SPOTLIGHT_TAB_CASE_NAME']]) {
        assert(runner.includes(`'${name}'`)); assert(runner.includes(`assert.equal(stepNames[${index}], ${constant},`));
    }
    const { report, calls, saves } = await runExtended();
    assert.deepEqual(calls, [50, 51]); assert.equal(saves.length, 4);
    assert.equal(report.spotlightNavigation.complete, true); assert.equal(report.spotlightTabCommands.complete, true);
    assert.equal(saves[0].spotlightNavigation.complete, false); assert.equal(saves[2].spotlightTabCommands.complete, false);
    assert.doesNotMatch(block, /windowIsolation|prepareRecovery|\.catch\(|retry|skipped/);
});
for (const mode of ['full', 'favorite-lifecycle', 'native-split', 'appearance-actions', 'recovery-actions', 'archive-actions', 'archive-reopen']) test(`${mode} cannot run or claim extended-action evidence`, async () => {
    const { report, calls, saves } = await runExtended({ mode });
    assert.deepEqual(calls, []); assert.deepEqual(saves, []); assert.deepEqual(report, { runMode: mode });
});
for (const failAt of [50, 51]) test(`extended case ${failAt} preserves its exact failure, partial evidence and no retry`, async () => {
    const { report, calls, saves } = await runExtended({ failAt });
    assert.deepEqual(calls, failAt === 50 ? [50] : [50, 51]); assert.equal(saves.length, failAt === 50 ? 1 : 3);
    assert.equal(report[failAt === 50 ? 'spotlightNavigation' : 'spotlightTabCommands'].complete, false);
    if (failAt === 50) assert.equal(report.spotlightTabCommands, undefined);
});
test('evidence persistence failure stops before a later case without success or retry', async () => {
    const { report, calls, saves } = await runExtended({ saveFailure: true });
    assert.deepEqual(calls, [50]); assert.deepEqual(saves, []); assert.equal(report.spotlightNavigation.complete, false);
});

test('both exact nonce routes execute before the generic handler and preserve CSP and document identities', () => {
    const source = runner.slice(runner.indexOf('server = createServer('), runner.indexOf('await new Promise(resolve => server.listen'));
    const routes = ['serveSpotlightNavigationFixture', 'serveSpotlightTabFixture'];
    for (const route of routes) {
        assert(source.includes(`if (${route}(request, response)) return;`));
        assert(source.indexOf(route) < source.indexOf('const title = titles[path]'));
    }
    let handler; const noRoute = () => false;
    new vm.Script(source).runInNewContext({ createServer: value => { handler = value; }, URL, titles: {},
        serveSpotlightArchiveFixture: noRoute, serveSpotlightActionFixture: noRoute, serveSpotlightNavigationFixture, serveSpotlightTabFixture, overlayRecoveryFixtureResponse: () => null,
        serveNativeSplitFixture: noRoute, serveTabMenuFixture: noRoute, serveTodayMoveFixture: noRoute, serveSavedMoveFixture: noRoute,
        serveTodayOrderFixture: noRoute, serveOrdinaryFavoriteFixture: noRoute, serveFavoriteIconFixture: noRoute });
    for (const kind of ['spotlight-navigation', 'spotlight-tabs']) {
        const received = []; const response = { writeHead: (...args) => received.push(args), end: value => received.push(value) };
        handler({ url: `/${kind}/${'a'.repeat(32)}/source` }, response);
        assert.equal(received.length, 2); assert.equal(received[0][0], 200);
        assert.equal(received[0][1]['Cache-Control'], 'no-store'); assert.match(received[0][1]['Content-Security-Policy'], /default-src 'none'/);
        assert.match(received[1], /data-document-id="[a-f0-9]{32}"/); assert.match(received[1], /id="action-page-state"/);
        assert(!received[1].includes('Pair Local Fixture'));
    }
});

test('workflow watches all extended contracts and uses one isolated mandatory fresh-profile job', () => {
    for (const path of ['scripts/paired-chrome-spotlight-navigation.mjs', 'scripts/paired-chrome-spotlight-tabs.mjs',
        'tests/unit/paired-chrome-spotlight-navigation.test.js', 'tests/unit/paired-chrome-spotlight-tabs.test.js', 'tests/unit/paired-chrome-extended-wiring.test.js',
        'docs/extended-actions-paired-ci.md', 'docs/spotlight-navigation-paired-ci.md', 'docs/spotlight-tab-commands-hosted.md',
        'spotlight-space-navigation.js', 'spotlight-tab-actions.js', 'spotlight-action-guards.js',
        'tests/unit/spotlight-space-navigation*.test.js', 'tests/unit/spotlight-tab-actions*.test.js',
        'scripts/check-spotlight-pair.mjs', 'scripts/lib/spotlight-pair-extended-*.mjs', 'scripts/test-spotlight-pair-contract.mjs']) assert(workflow.includes(`- '${path}'`), path);
    assert.equal((workflow.match(/^  extended-actions:/gm) || []).length, 1);
    assert.match(runner, /report\.runMode === 'extended-actions' \? 'test-results\/paired-chrome-extended-actions'/);
    assert.equal((runner.match(/exerciseSpotlightNavigation\(/g) || []).length, 1);
    assert.equal((runner.match(/exerciseSpotlightTabCommands\(/g) || []).length, 1);
    assert.match(runner, /helperNavigation:true,\n        record:async evidence => \{ report\.spotlightActions/);
});
