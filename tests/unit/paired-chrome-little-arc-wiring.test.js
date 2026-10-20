// Source orchestration only. These adapters never execute a browser callback.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { readSourceText } from '../source-text.js';
import { LITTLE_ARC_CASE_NAME, serveLittleArcFixture } from '../../scripts/paired-chrome-little-arc.mjs';
import { createPairedChromeRunReport } from '../../scripts/paired-chrome-run-plan.mjs';
import { validateLittleArcAcceptanceContext } from '../../scripts/paired-chrome-little-arc-context.mjs';

const source = readSourceText(new URL('../../scripts/paired-chrome-smoke.mjs', import.meta.url));
const workflow = readSourceText(new URL('../../.github/workflows/paired-extension-smoke.yml', import.meta.url));
const names = [...source.match(/const stepNames = \[([\s\S]*?)\n\];/)[1].matchAll(/^\s*'([^']*)',?$/gm)].map(match => match[1]);
const start = source.indexOf("    if (report.runMode === 'little-arc') {");
const end = source.indexOf('    } // Supplemental Little Arc case 55;', start) + '    }'.length;
assert(start > 0 && end > start);
const branch = source.slice(start, end);

test('Little Arc imported case identity agrees with the smoke source and isolated run plan', () => {
    assert.equal(names[55], LITTLE_ARC_CASE_NAME);
    assert.deepEqual(createPairedChromeRunReport(names, 'little-arc').expectedCases.map(item => item.caseIndex), [0, 1, 2, 55]);
    assert.match(source, /import \{ exerciseLittleArc, serveLittleArcFixture, LITTLE_ARC_CASE_NAME \} from '\.\/paired-chrome-little-arc\.mjs';/);
    assert.match(source, /if \(serveLittleArcFixture\(request, response\)\) return;/);
    assert.match(workflow, /ARCIFY_PAIRED_RUN_MODE: little-arc/);
});

test('the real Little Arc nonce route executes before the generic HTTP fixture handler', () => {
    const routeSource = source.slice(source.indexOf('server = createServer('), source.indexOf('await new Promise(resolve => server.listen'));
    let handler;
    const noRoute = () => false;
    const otherRoutes = Object.fromEntries(['serveSpotlightSplitFixture', 'serveSpotlightArchiveFixture', 'serveSpotlightActionFixture',
        'serveSpotlightNavigationFixture', 'serveSpotlightTabFixture', 'serveNativeSplitFixture', 'serveTabMenuFixture',
        'serveTodayMoveFixture', 'serveSavedMoveFixture', 'serveTodayOrderFixture', 'serveOrdinaryFavoriteFixture',
        'serveFavoriteIconFixture'].map(name => [name, noRoute]));
    new vm.Script(routeSource).runInNewContext({ ...otherRoutes, URL, titles: {}, serveLittleArcFixture,
        overlayRecoveryFixtureResponse: () => null, createServer: value => { handler = value; } });
    const documents = [];
    for (let index = 0; index < 2; index++) {
        const received = [];
        handler({ url: `/little-arc/${'a'.repeat(32)}/duplicate` }, {
            writeHead: (...args) => received.push(args), end: value => received.push(value)
        });
        assert.equal(received.length, 2);
        assert.equal(received[0][0], 200);
        assert.equal(received[0][1]['Cache-Control'], 'no-store');
        assert.match(received[0][1]['Content-Security-Policy'], /frame-src 'none'/);
        assert.match(received[1], /id="little-arc-draft"/);
        documents.push(received[1].match(/data-document-id="([a-f0-9]{32})"/)[1]);
    }
    assert.notEqual(documents[0], documents[1], 'Equal fixture URLs must represent distinct native documents.');
});

test('source callback passes live harness adapters and refreshes the API realm through the real reload helper', async () => {
    const values = Object.fromEntries(['browser', 'observePage', 'arcifyOptions', 'spotlightOptions', 'ui', 'screenshot',
        'snapshot', 'external', 'poll', 'fixture', 'arcifyId', 'spotlightId', 'search'].map(name => [name, { name }]));
    const refreshed = { name: 'fresh Arcify options realm' };
    const reloadEvidence = { name: 'actual reload proof supplied by runner' };
    const report = { runMode: 'little-arc' };
    let captured, stepCalls = 0, saves = 0, reloads = 0;
    await new vm.Script(`(async () => { ${branch} })()`).runInNewContext({
        ...values, report, stepNames: names,
        step: async (name, callback, options) => {
            assert.equal(name, LITTLE_ARC_CASE_NAME);
            assert.equal(options, undefined, 'Little Arc must retain the common window-isolation/error gates.');
            stepCalls++;
            assert.equal(await callback(), 'source callback result');
        },
        exerciseLittleArc: async context => { captured = context; return 'source callback result'; },
        reloadPairedExtension: async name => {
            assert.equal(name, 'arcify'); reloads++;
            return { arcifyOptions: refreshed, evidence: reloadEvidence };
        },
        saveReport: async () => { saves++; }
    });
    assert.equal(stepCalls, 1);
    for (const key of ['browser', 'observePage', 'spotlightOptions', 'ui', 'screenshot', 'snapshot', 'external', 'poll', 'fixture', 'arcifyId', 'spotlightId', 'search'])
        assert.equal(captured[key], values[key], key);
    assert.equal(captured.apiPage, values.arcifyOptions);
    const result = await captured.reloadArcify();
    assert.equal(result.apiPage, refreshed);
    assert.equal(result.evidence, reloadEvidence);
    assert.equal(reloads, 1);
    const evidence = { phase: 'unit adapter witness, not native acceptance' };
    await captured.record(evidence);
    assert.equal(report.littleArc, evidence);
    assert.equal(saves, 1);
});

test('the supplemental source branch cannot run in any pre-existing mode', async () => {
    for (const mode of ['full', 'favorite-lifecycle', 'native-split', 'appearance-actions', 'recovery-actions', 'extended-actions', 'archive-actions', 'archive-reopen']) {
        await new vm.Script(`(async () => { ${branch} })()`).runInNewContext({
            report: { runMode: mode },
            step: () => assert.fail('An unchanged mode cannot invoke Little Arc.')
        });
    }
});

test('native environment guards and explicit source-only requirements remain present', () => {
    assert.match(source, /process\.env\.GITHUB_ACTIONS !== 'true' \|\| process\.env\.CI !== 'true'/);
    assert.match(source, /process\.getuid\?\.\(\) === 0/);
    const docs = readSourceText(new URL('../../docs/little-arc-paired-ci.md', import.meta.url));
    assert.match(docs, /No native run has been performed/);
    assert.match(docs, /No workflow has been dispatched/);
    assert.match(docs, /acceptance_scope=little-arc/);
    assert.match(docs, /pin alone does not establish/);
    assert.match(docs, /An extension reload is not a full browser restart/);
});


const legacyJobNames = ['paired-chrome', 'favorite-lifecycle', 'appearance-actions', 'native-split',
    'recovery-actions', 'extended-actions', 'archive-actions', 'archive-reopen'];
const legacyGate = "github.event_name != 'workflow_dispatch' || inputs.acceptance_scope != 'little-arc'";
const littleArcGate = "(github.event_name == 'workflow_dispatch' && inputs.acceptance_scope == 'little-arc') || (github.event_name == 'pull_request' && github.repository == 'calvwng/arcify' && github.event.number == 75 && github.event.pull_request.number == 75 && github.event.pull_request.head.repo.full_name == github.repository && github.event.pull_request.head.ref == 'integration/arcify-bridge-v1' && github.event.pull_request.base.repo.full_name == github.repository && github.event.pull_request.base.ref == 'main')";
const dispatchInput = `    inputs:
      acceptance_scope:
        description: 'Run the legacy suite or only isolated Little Arc acceptance'
        required: false
        default: legacy
        type: choice
        options:
          - legacy
          - little-arc
      expected_arcify_head:
        description: 'Full reviewed Arcify commit SHA; required only for Little Arc'
        required: false
        type: string
`;
const jobSource = name => workflow.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z-]+:|$(?![\\s\\S]))`, 'm'))?.[1];
const littleArcJob = jobSource('little-arc');

test('only an explicit manual Little Arc selection gates the eight unchanged legacy jobs', () => {
    assert(workflow.includes(`  workflow_dispatch:
${dispatchInput}  pull_request:`));
    const jobNames = [...workflow.matchAll(/^  ([a-z-]+):\n(?=    runs-on:)/gm)].map(match => match[1]);
    assert.deepEqual(jobNames, [...legacyJobNames, 'little-arc']);
    for (const name of legacyJobNames) assert.equal(jobSource(name).match(/^    if: (.*)$/m)?.[1], legacyGate);
    assert.equal(littleArcJob.match(/^    if: (.*)$/m)?.[1], littleArcGate);
    for (const event_name of ['pull_request', 'push', 'workflow_dispatch', 'schedule']) {
        for (const acceptance_scope of [undefined, '', 'legacy', 'little-arc', 'unknown']) {
            const context = { github: { event_name, repository: 'unselected/unit-fixture', event: {} }, inputs: { acceptance_scope } };
            const selected = event_name === 'workflow_dispatch' && acceptance_scope === 'little-arc';
            assert.equal(new vm.Script(legacyGate).runInNewContext(context), !selected);
            assert.equal(new vm.Script(littleArcGate).runInNewContext(context), selected);
        }
    }
    const restored = workflow.slice(0, workflow.indexOf('  # Isolated acceptance:'))
        .replace(dispatchInput, '').replaceAll(`    if: ${legacyGate}\n`, '').replace(/\n$/, '');
    assert.equal(createHash('sha256').update(restored).digest('hex'),
        'ee6bc1245b90a30d2f4ffa17cbeb961f8ce08e95ea65aa4434316194cfc2ab74',
        'Every original workflow byte, including events, permissions, job bodies, pins and order, must be preserved apart from the exact manual opt-in gate.');
});

test('the additional job gate selects only the exact same-repository PR and leaves all eight legacy jobs selected', () => {
    const github = { event_name: 'pull_request', repository: 'calvwng/arcify', event: { number: 75,
        pull_request: { number: 75,
            head: { ref: 'integration/arcify-bridge-v1', repo: { full_name: 'calvwng/arcify', fork: true } },
            base: { ref: 'main', repo: { full_name: 'calvwng/arcify' } } } } };
    const selected = value => new vm.Script(littleArcGate).runInNewContext({ github: value, inputs: {} });
    assert.equal(selected(github), true);
    assert.equal(new vm.Script(legacyGate).runInNewContext({ github, inputs: {} }), true);
    for (const mutate of [
        value => { value.event_name = 'pull_request_target'; },
        value => { value.repository = 'fork/arcify'; },
        value => { value.event.number = 76; },
        value => { value.event.pull_request.number = 76; },
        value => { value.event.pull_request.head.repo.full_name = 'fork/arcify'; },
        value => { value.event.pull_request.head.ref = 'other-branch'; },
        value => { value.event.pull_request.base.repo.full_name = 'other/arcify'; },
        value => { value.event.pull_request.base.ref = 'other-branch'; }
    ]) {
        const value = structuredClone(github);
        mutate(value);
        assert.equal(selected(value), false, mutate.toString());
    }
});

test('Little Arc alone uses its exact reviewed companion pin and shared actual-event provenance guard', () => {
    const legacyPin = source.match(/const PINNED_SPOTLIGHT = '([0-9a-f]{40})';/)[1];
    const littleArcPin = source.match(/const PINNED_LITTLE_ARC_SPOTLIGHT = '([0-9a-f]{40})';/)?.[1];
    assert(littleArcPin, 'Little Arc must have a reviewed literal full commit ID, never a placeholder or a mutable branch.');
    assert.notEqual(littleArcPin, legacyPin);
    assert.equal(legacyPin, 'c13511fd36d56358156c10336b8961b7ef95d5bc');
    for (const name of legacyJobNames) {
        assert.equal(jobSource(name).match(/repository: calvwng\/arcify-spotlight\n          ref: (.*)/)?.[1], legacyPin);
        assert(!jobSource(name).includes(littleArcPin));
    }
    assert(littleArcJob.includes(`ARCIFY_SPOTLIGHT_HEAD: ${littleArcPin}\n`));
    assert(littleArcJob.includes(`repository: calvwng/arcify-spotlight\n          ref: ${littleArcPin}\n`));
    assert.match(littleArcJob, /ARCIFY_TEST_HEAD: \$\{\{ github\.event_name == 'pull_request' && github\.event\.pull_request\.head\.sha \|\| inputs\.expected_arcify_head \}\}/);
    assert.match(littleArcJob, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/);
    assert.match(littleArcJob, /ARCIFY_PR_HEAD: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
    const guardStart = source.indexOf('    report.environment.arcifyHead = head(ROOT);');
    const guardEnd = source.indexOf('    report.environment.puppeteer = ', guardStart);
    const guard = source.slice(guardStart, guardEnd);
    for (const runMode of ['full', 'favorite-lifecycle', 'native-split', 'appearance-actions', 'recovery-actions',
        'extended-actions', 'archive-actions', 'archive-reopen', 'little-arc']) {
        const expected = runMode === 'little-arc' ? littleArcPin : legacyPin;
        const context = { assert, report: { runMode, environment: {} }, ROOT: 'main', COMPANION: 'peer',
            PINNED_SPOTLIGHT: legacyPin, PINNED_LITTLE_ARC_SPOTLIGHT: littleArcPin,
            process: { env: { ARCIFY_TEST_HEAD: 'a'.repeat(40), GITHUB_SHA: 'a'.repeat(40), ARCIFY_SPOTLIGHT_HEAD: littleArcPin,
                GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REPOSITORY: 'calvwng/arcify' } },
            readLittleArcAcceptanceContext: (env, actualHead) => validateLittleArcAcceptanceContext(env, {
                repository: { full_name: 'calvwng/arcify', fork: true },
                inputs: { acceptance_scope: 'little-arc', expected_arcify_head: 'a'.repeat(40) }
            }, actualHead),
            head: path => path === 'main' ? 'a'.repeat(40) : expected };
        new vm.Script(guard).runInNewContext(context);
        assert.equal(context.report.environment.expectedSpotlightHead, expected);
        for (const wrongHead of [runMode === 'little-arc' ? legacyPin : littleArcPin, 'b'.repeat(40)]) {
            assert.throws(() => new vm.Script(guard).runInNewContext({ ...context,
                head: path => path === 'main' ? 'a'.repeat(40) : wrongHead }), /reviewed pinned commit/);
        }
        assert.throws(() => new vm.Script(guard).runInNewContext({ ...context,
            head: path => path === 'main' ? 'b'.repeat(40) : expected }));
        if (runMode === 'little-arc') for (const mismatch of [
            { ARCIFY_TEST_HEAD: undefined }, { ARCIFY_TEST_HEAD: 'main' }, { GITHUB_SHA: 'b'.repeat(40) },
            { ARCIFY_SPOTLIGHT_HEAD: legacyPin }, { GITHUB_EVENT_NAME: 'pull_request' }
        ]) assert.throws(() => new vm.Script(guard).runInNewContext({ ...context,
            process: { env: { ...context.process.env, ...mismatch } } }));
    }
});

test('Little Arc job preserves locked runtimes, normal sandbox, evidence and original failures', () => {
    assert.match(workflow, /^permissions:\n  contents: read$/m);
    assert.match(littleArcJob, /runs-on: ubuntu-24\.04\n/);
    assert.match(littleArcJob, /timeout-minutes: 20\n/);
    assert.match(littleArcJob, /CI: 'true'/);
    assert.match(littleArcJob, /node-version: '22'/);
    assert.equal((littleArcJob.match(/persist-credentials: false/g) || []).length, 2);
    assert.match(littleArcJob, /PUPPETEER_SKIP_DOWNLOAD: 'true'/);
    for (const path of ['arcify', 'arcify/scripts/paired-chrome-runtime', 'arcify-spotlight'])
        assert(littleArcJob.includes(`npm ci --prefix ${path}\n`));
    assert.match(littleArcJob, /npm test --prefix arcify\/scripts\/paired-chrome-runtime/);
    assert.match(littleArcJob, /set -o pipefail\n/);
    assert.match(littleArcJob, /xvfb-run --auto-servernum npm run test:paired-chrome -- \.\.\/arcify-spotlight 2>&1 \| tee test-results\/paired-chrome-little-arc\/runner.log/);
    assert.match(littleArcJob, /if: always\(\)/);
    assert.match(littleArcJob, /name: paired-chrome-little-arc-\$\{\{ github.run_id \}\}-\$\{\{ github.run_attempt \}\}/);
    assert.match(littleArcJob, /path: arcify\/test-results\/paired-chrome-little-arc\//);
    assert.doesNotMatch(littleArcJob, /needs:|continue-on-error:|strategy:|secrets\.|permissions:|sudo|chmod|chown|sysctl|apparmor_parser|vendor-update|native-split-update|retry|no-sandbox|disable-web-security|CHROME_DEVEL_SANDBOX|puppeteer browsers install/);
    assert.match(source, /workflowFileSha: process.env.GITHUB_WORKFLOW_SHA/);
    assert.match(source, /workflowRef: process.env.GITHUB_WORKFLOW_REF/);
});

test('source and build receipts precede the browser and cannot hide head or build failure', () => {
    const provenance = littleArcJob.indexOf('name: Record and verify exact source provenance');
    const install = littleArcJob.indexOf('name: Install locked dependencies');
    const build = littleArcJob.indexOf('name: Build the exact pair');
    const browser = littleArcJob.indexOf('name: Exercise only Little Arc');
    const upload = littleArcJob.indexOf('name: Upload success or failure evidence');
    assert(provenance >= 0 && provenance < install && install < build && build < browser && browser < upload);
    for (const exact of [
        '[[ "$ARCIFY_TEST_HEAD" =~ ^[0-9a-f]{40}$ ]]',
        'test "$(git -C arcify rev-parse HEAD)" = "$ARCIFY_TEST_HEAD"',
        'test "$(git -C arcify-spotlight rev-parse HEAD)" = "$ARCIFY_SPOTLIGHT_HEAD"',
        'test -z "$(git -C "$repo" status --porcelain)"',
        'git -C "$repo" ls-tree -r --full-tree HEAD',
        'git ls-files -z | LC_ALL=C sort -z | xargs -0 sha256sum',
        'sha256sum --check "$evidence/$repo-source-sha256.txt"',
        'test -f "$repo/dist/manifest.json"',
        'find dist -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum'
    ]) assert(littleArcJob.includes(exact), exact);
    for (const repo of ['arcify', 'arcify-spotlight'])
        assert(littleArcJob.includes(`npm run build --prefix ${repo} 2>&1 | tee "$evidence/${repo}-build.log"`));
    assert.match(littleArcJob, /readLittleArcAcceptanceContext\(process.env, head\)/);
    assert.match(littleArcJob, /tee "\$evidence\/event-provenance\.json"/);
    assert.match(source, /readLittleArcAcceptanceContext\(process.env, report.environment.arcifyHead\)/);
    assert(littleArcJob.indexOf('test -z "$(git -C "$repo" status --porcelain)"')
        < littleArcJob.indexOf("node --input-type=module <<'NODE'"),
    'Reject changed checked-out source before executing its validator.');
    assert.match(littleArcJob, /node arcify\/scripts\/paired-chrome-little-arc-provenance\.mjs record arcify-spotlight "\$evidence"/);
    assert.match(littleArcJob, /if \[ "\$repo" = arcify \]; then\n              test -z "\$\(git -C "\$repo" status --porcelain\)"/);
    assert.match(littleArcJob, /node arcify\/scripts\/paired-chrome-little-arc-provenance\.mjs verify "\$repo" "\$evidence"/);
    assert.match(littleArcJob, /status --porcelain=v1 -z --untracked-files=all > "\$evidence\/\$repo-post-build-git-status.z"/);
    assert(littleArcJob.indexOf('$repo-post-build-git-status.z') < littleArcJob.indexOf('if [ "$repo" = arcify ]; then'),
        'Retain complete status for both checkouts before post-build verification can fail.');
    assert.equal((littleArcJob.match(/set -euo pipefail/g) || []).length, 2);
    assert.doesNotMatch(littleArcJob, /\|\| true|catch|exit 0|continue-on-error/);
});
