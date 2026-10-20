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
        env = {
            PATH: process.env.PATH, HOME: workspace, GITHUB_WORKSPACE: workspace,
            GITHUB_WORKFLOW_REF: 'unit-fixture/workflow@refs/heads/unit-fixture',
            GITHUB_WORKFLOW_SHA: head, GITHUB_RUN_ID: 'source-only-unit-fixture', GITHUB_RUN_ATTEMPT: '1',
            ARCIFY_TEST_HEAD: head, ARCIFY_SPOTLIGHT_HEAD: head, GITHUB_SHA: head
        };
        run(record);
        for (const overrides of [
            { ARCIFY_TEST_HEAD: '' }, { ARCIFY_TEST_HEAD: 'main' }, { ARCIFY_TEST_HEAD: '0'.repeat(40) },
            { GITHUB_SHA: '0'.repeat(40) }, { ARCIFY_SPOTLIGHT_HEAD: '0'.repeat(40) }
        ]) assert.throws(() => run(record, overrides), 'Invalid head identity must fail the exact shell.');

        const source = join(workspace, 'arcify', 'package.json');
        const original = readFileSync(source);
        writeFileSync(source, `${original}\n`);
        assert.throws(() => run(record), 'Tracked source edits must fail before dependency installation.');
        writeFileSync(source, original);
        const extra = join(workspace, 'arcify-spotlight', 'unreviewed-receipt-fixture.js');
        writeFileSync(extra, '// Source-only test fixture.\n');
        assert.throws(() => run(record), 'Untracked source additions must fail before installation.');
        rmSync(extra);
        run(record);
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
