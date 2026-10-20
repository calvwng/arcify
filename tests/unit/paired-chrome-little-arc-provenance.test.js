// Execute only receipt/check shell fragments. No install, build or browser runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSourceText } from '../source-text.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const workflow = readSourceText(new URL('../../.github/workflows/paired-extension-smoke.yml', import.meta.url));
const job = workflow.slice(workflow.indexOf('\n  little-arc:\n'));
function shellStep(name) {
    const start = job.indexOf(`      - name: ${name}\n`);
    assert(start >= 0);
    const end = job.indexOf('      - name:', start + 1);
    const block = job.slice(start, end === -1 ? undefined : end);
    return block.slice(block.indexOf('        run: |\n') + '        run: |\n'.length)
        .split('\n').map(line => line.replace(/^          /, '')).join('\n');
}
const record = shellStep('Record and verify exact source provenance before installation');
// The disposable clones below contain committed source only. Load this candidate's
// actual validator from the working tree while keeping the receipt shell intact.
const moduleImport = "'./arcify/scripts/paired-chrome-little-arc-context.mjs'";
assert.equal(record.split(moduleImport).length, 2);
const fixtureRecord = record.replace(moduleImport,
    JSON.stringify(new URL('../../scripts/paired-chrome-little-arc-context.mjs', import.meta.url).href));
const build = shellStep('Build the exact pair and retain production hashes');
// Run only post-build verification against clearly labeled fixture files.
const verify = 'set -euo pipefail\nevidence="$GITHUB_WORKSPACE/arcify/test-results/paired-chrome-little-arc"\n'
    + build.slice(build.indexOf('for repo in arcify arcify-spotlight; do'));
assert(!/npm |xvfb|test:paired-chrome/.test(record + verify));

test('actual hosted receipt shell fails closed on wrong heads and modified or missing sources', {
    skip: process.platform === 'win32' ? 'The hosted receipt shell targets Ubuntu Bash.' : false
}, () => {
    const workspace = mkdtempSync(join(tmpdir(), 'little-arc-receipt-unit-'));
    const run = (script, overrides = {}) => execFileSync('bash', ['--noprofile', '--norc', '-c', script], {
        cwd: workspace, env: { ...env, ...overrides }, stdio: 'pipe'
    });
    let env;
    try {
        // Clone existing local commits without creating commits or using a network remote.
        for (const repo of ['arcify', 'arcify-spotlight']) {
            execFileSync('git', ['clone', '--quiet', '--local', '--no-hardlinks', root, join(workspace, repo)],
                { stdio: 'pipe' });
        }
        const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
        const eventPath = join(workspace, 'source-only-event-fixture.json');
        const repository = { full_name: 'calvwng/arcify', fork: true };
        const dispatch = { repository, inputs: { acceptance_scope: 'little-arc', expected_arcify_head: head } };
        writeFileSync(eventPath, JSON.stringify(dispatch));
        env = {
            PATH: process.env.PATH, HOME: workspace, GITHUB_WORKSPACE: workspace,
            GITHUB_WORKFLOW_REF: 'unit-fixture/workflow@refs/heads/unit-fixture',
            GITHUB_WORKFLOW_SHA: head, GITHUB_RUN_ID: 'source-only-unit-fixture', GITHUB_RUN_ATTEMPT: '1',
            ARCIFY_TEST_HEAD: head, ARCIFY_SPOTLIGHT_HEAD: head, GITHUB_SHA: head,
            GITHUB_REPOSITORY: 'calvwng/arcify', GITHUB_EVENT_NAME: 'workflow_dispatch',
            GITHUB_REF: 'refs/heads/source-only-unit-fixture', GITHUB_EVENT_PATH: eventPath
        };
        run(fixtureRecord);
        for (const overrides of [
            { ARCIFY_TEST_HEAD: '' }, { ARCIFY_TEST_HEAD: 'main' }, { ARCIFY_TEST_HEAD: '0'.repeat(40) },
            { GITHUB_SHA: '0'.repeat(40) }, { ARCIFY_SPOTLIGHT_HEAD: '0'.repeat(40) }, { GITHUB_EVENT_PATH: '' }
        ]) assert.throws(() => run(fixtureRecord, overrides), 'Invalid head identity must fail the exact shell.');
        const pr = { action: 'synchronize', number: 75, repository,
            pull_request: { number: 75, state: 'open',
                head: { sha: head, ref: 'integration/arcify-bridge-v1', repo: repository },
                base: { ref: 'main', repo: repository } } };
        const prEnv = { GITHUB_EVENT_NAME: 'pull_request', GITHUB_SHA: 'b'.repeat(40),
            GITHUB_REF: 'refs/pull/75/merge', GITHUB_HEAD_REF: 'integration/arcify-bridge-v1',
            GITHUB_BASE_REF: 'main', ARCIFY_PR_HEAD: head };
        writeFileSync(eventPath, JSON.stringify(pr));
        run(fixtureRecord, prEnv);
        const receipt = JSON.parse(readFileSync(join(workspace, 'arcify', 'test-results',
            'paired-chrome-little-arc', 'event-provenance.json'), 'utf8'));
        assert.equal(receipt.githubSha, prEnv.GITHUB_SHA);
        assert.equal(receipt.pullRequestHead, head);
        assert.notEqual(receipt.githubSha, receipt.pullRequestHead);
        for (const mutate of [
            value => { value.number = 76; },
            value => { value.pull_request.head.repo = { full_name: 'fork/arcify', fork: true }; },
            value => { value.pull_request.head.ref = 'other-branch'; },
            value => { value.pull_request.head.sha = 'main'; },
            value => { value.pull_request.head.sha = 'b'.repeat(40); }
        ]) {
            const invalid = structuredClone(pr);
            mutate(invalid);
            writeFileSync(eventPath, JSON.stringify(invalid));
            assert.throws(() => run(fixtureRecord, prEnv), 'Actual PR receipt shell must reject invalid event payloads.');
        }
        writeFileSync(eventPath, '{invalid json');
        assert.throws(() => run(fixtureRecord, prEnv), 'Malformed event files must fail before installation.');
        writeFileSync(eventPath, JSON.stringify(dispatch));

        const source = join(workspace, 'arcify', 'package.json');
        const original = readFileSync(source);
        writeFileSync(source, `${original}\n`);
        assert.throws(() => run(fixtureRecord), 'Tracked source edits must fail before dependency installation.');
        writeFileSync(source, original);
        const extra = join(workspace, 'arcify-spotlight', 'unreviewed-receipt-fixture.js');
        writeFileSync(extra, '// Source-only test fixture.\n');
        assert.throws(() => run(fixtureRecord), 'Untracked source additions must fail before installation.');
        rmSync(extra);
        run(fixtureRecord);
        for (const repo of ['arcify', 'arcify-spotlight']) {
            mkdirSync(join(workspace, repo, 'dist'), { recursive: true });
            writeFileSync(join(workspace, repo, 'dist', 'manifest.json'), '{"unitFixtureOnly":true}\n');
        }
        run(verify);
        const evidence = join(workspace, 'arcify', 'test-results', 'paired-chrome-little-arc');
        for (const repo of ['arcify', 'arcify-spotlight']) {
            assert.match(readFileSync(join(evidence, `${repo}-build-sha256.txt`), 'utf8'),
                /^[0-9a-f]{64}  dist\/manifest\.json\n$/);
        }
        writeFileSync(source, `${original}\n`);
        assert.throws(() => run(verify), 'Source changed after receipt recording must fail.');
        writeFileSync(source, original);
        rmSync(source);
        assert.throws(() => run(verify), 'A missing tracked source must fail.');
        writeFileSync(source, original);
        rmSync(join(workspace, 'arcify-spotlight', 'dist', 'manifest.json'));
        assert.throws(() => run(verify), 'A missing production manifest must fail.');
    } finally {
        rmSync(workspace, { recursive: true, force: true });
    }
});
