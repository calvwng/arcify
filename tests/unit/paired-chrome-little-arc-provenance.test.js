// Execute only receipt/check shell fragments. No install, build or browser runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSourceText } from '../source-text.js';
import { parseGitStatus, recordSpotlightProvenance, verifySpotlightProvenance } from '../../scripts/paired-chrome-little-arc-provenance.mjs';

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
const provenanceCommand = 'arcify/scripts/paired-chrome-little-arc-provenance.mjs';
const fixtureProvenanceCommand = JSON.stringify(fileURLToPath(new URL('../../scripts/paired-chrome-little-arc-provenance.mjs', import.meta.url)));
const fixtureRecord = record.replace(moduleImport,
    JSON.stringify(new URL('../../scripts/paired-chrome-little-arc-context.mjs', import.meta.url).href))
    .replaceAll(provenanceCommand, fixtureProvenanceCommand);
const build = shellStep('Build the exact pair and retain production hashes');
// Run only post-build verification against clearly labeled fixture files.
const verify = 'set -euo pipefail\nevidence="$GITHUB_WORKSPACE/arcify/test-results/paired-chrome-little-arc"\n'
    + build.slice(build.indexOf('for repo in arcify arcify-spotlight; do')).replaceAll(provenanceCommand, fixtureProvenanceCommand);
assert(!/npm |xvfb|test:paired-chrome/.test(record + verify));

function fixtureGit(root, args) {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function writeFixture(root, path, text) {
    const full = join(root, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, text);
}
function createCompanionFixture(workspace) {
    const companion = join(workspace, 'arcify-spotlight');
    mkdirSync(companion);
    fixtureGit(companion, ['init', '--quiet']);
    for (const [path, text] of Object.entries({
        '.gitignore': 'node_modules/\ndist/\n.env\n',
        'package.json': '{"private":true,"fixtureOnly":true}\n',
        'package-lock.json': '{"lockfileVersion":3,"fixtureOnly":true}\n',
        'src/runtime.js': '// Protected source-only fixture.\n',
        'node_modules/pkg/bin/tool.js': '// Source-only tool fixture, never executed.\n',
        'node_modules/pkg/index.js': '// Pinned dependency fixture.\n',
        'node_modules/@fixture/darwin-arm64/binary': 'Source-only Darwin binary fixture.\n'
    })) writeFixture(companion, path, text);
    mkdirSync(join(companion, 'node_modules', '.bin'));
    symlinkSync('../pkg/bin/tool.js', join(companion, 'node_modules', '.bin', 'tool'));
    fixtureGit(companion, ['add', '--force', '.']);
    // Commit only this disposable test repository; never the user checkout.
    fixtureGit(companion, ['-c', 'user.name=Source Fixture', '-c', 'user.email=fixture@example.invalid',
        '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Source-only provenance fixture']);
    return companion;
}
function replacePlatformDependencies(companion) {
    rmSync(join(companion, 'node_modules', '@fixture', 'darwin-arm64'), { recursive: true });
    writeFixture(companion, 'node_modules/@fixture/linux-x64/binary', 'Source-only Linux binary fixture.\n');
    writeFixture(companion, 'node_modules/pkg/index.js', '// Locked installation replacement fixture.\n');
}

test('actual hosted receipt shell fails closed on wrong heads and modified or missing sources', {
    skip: process.platform === 'win32' ? 'The hosted receipt shell targets Ubuntu Bash.' : false
}, () => {
    const workspace = mkdtempSync(join(tmpdir(), 'little-arc-receipt-unit-'));
    const run = (script, overrides = {}) => execFileSync('bash', ['--noprofile', '--norc', '-c', script], {
        cwd: workspace, env: { ...env, ...overrides }, stdio: 'pipe'
    });
    let env;
    try {
        // Clone main source locally. The companion is a clearly labeled disposable
        // Git fixture with tracked platform dependencies, matching the pinned layout.
        execFileSync('git', ['clone', '--quiet', '--local', '--no-hardlinks', root, join(workspace, 'arcify')], { stdio: 'pipe' });
        const companion = createCompanionFixture(workspace);
        const spotlightHead = fixtureGit(companion, ['rev-parse', 'HEAD']).trim();
        const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
        const eventPath = join(workspace, 'source-only-event-fixture.json');
        const repository = { full_name: 'calvwng/arcify', fork: true };
        const dispatch = { repository, inputs: { acceptance_scope: 'little-arc', expected_arcify_head: head } };
        writeFileSync(eventPath, JSON.stringify(dispatch));
        env = {
            PATH: process.env.PATH, HOME: workspace, GITHUB_WORKSPACE: workspace,
            GITHUB_WORKFLOW_REF: 'unit-fixture/workflow@refs/heads/unit-fixture',
            GITHUB_WORKFLOW_SHA: head, GITHUB_RUN_ID: 'source-only-unit-fixture', GITHUB_RUN_ATTEMPT: '1',
            ARCIFY_TEST_HEAD: head, ARCIFY_SPOTLIGHT_HEAD: spotlightHead, GITHUB_SHA: head,
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
        replacePlatformDependencies(companion);
        run(verify);
        const evidence = join(workspace, 'arcify', 'test-results', 'paired-chrome-little-arc');
        for (const repo of ['arcify', 'arcify-spotlight']) {
            assert.match(readFileSync(join(evidence, `${repo}-build-sha256.txt`), 'utf8'),
                /^[0-9a-f]{64}  dist\/manifest\.json\n$/);
        }
        const dependencyChanges = JSON.parse(readFileSync(join(evidence, 'arcify-spotlight-dependency-content-changes.json'), 'utf8'));
        assert(dependencyChanges.some(change => change.path.includes('darwin-arm64') && change.after === null));
        assert(dependencyChanges.some(change => change.path.includes('linux-x64') && change.before === null));
        assert.match(readFileSync(join(evidence, 'arcify-spotlight-post-build-git-status.txt'), 'utf8'), /darwin-arm64/);
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


test('Spotlight dependency exception remains exact and rejects source changes, staged changes, and symlink escapes', {
    skip: process.platform === 'win32' ? 'The hosted verifier targets Ubuntu filesystem and Git semantics.' : false
}, () => {
    const mutations = [
        ['runtime edit', root => writeFixture(root, 'src/runtime.js', 'changed')],
        ['lockfile edit', root => writeFixture(root, 'package-lock.json', 'changed')],
        ['manifest edit', root => writeFixture(root, 'package.json', 'changed')],
        ['source deletion', root => rmSync(join(root, 'src/runtime.js'))],
        ['source addition', root => writeFixture(root, 'src/new.js', 'unexpected')],
        ['similar root prefix', root => writeFixture(root, 'node_modules-other/extra.js', 'unexpected')],
        ['ignored nested dependency source', root => writeFixture(root, 'src/node_modules/extra.js', 'unexpected')],
        ['ignored environment source', root => writeFixture(root, '.env', 'unexpected')],
        ['rename source into dependencies', root => {
            fixtureGit(root, ['mv', 'src/runtime.js', 'node_modules/moved-runtime.js']);
        }],
        ['staged dependency change', root => {
            writeFixture(root, 'node_modules/pkg/index.js', 'staged');
            fixtureGit(root, ['add', '--force', 'node_modules/pkg/index.js']);
        }],
        ['dependency root symlink', root => {
            renameSync(join(root, 'node_modules'), join(root, '..', 'outside-dependencies'));
            symlinkSync('../outside-dependencies', join(root, 'node_modules'));
        }],
        ['nested symlink escape', root => symlinkSync('../src', join(root, 'node_modules', 'escape'))],
        ['bin symlink escape', root => {
            rmSync(join(root, 'node_modules', '.bin', 'tool'));
            symlinkSync('../../src/runtime.js', join(root, 'node_modules', '.bin', 'tool'));
        }],
        ['dangling dependency symlink', root => symlinkSync('missing', join(root, 'node_modules', 'broken'))]
    ];
    for (const [label, mutate] of mutations) {
        const workspace = mkdtempSync(join(tmpdir(), 'little-arc-dependencies-unit-'));
        try {
            const root = createCompanionFixture(workspace), evidence = join(workspace, 'evidence');
            mkdirSync(evidence);
            recordSpotlightProvenance(root, evidence);
            replacePlatformDependencies(root);
            assert.equal(verifySpotlightProvenance(root, evidence).status, 'passed', 'Valid npm-style replacements and internal .bin link pass.');
            mutate(root);
            assert.throws(() => verifySpotlightProvenance(root, evidence), label);
            assert.equal(typeof readFileSync(join(evidence, 'arcify-spotlight-post-build-git-status.z'), 'utf8'), 'string');
        } finally { rmSync(workspace, { recursive: true, force: true }); }
    }
});

test('pre-install companion provenance never allows dependency modifications or extra source', {
    skip: process.platform === 'win32' ? 'The hosted verifier targets Ubuntu filesystem and Git semantics.' : false
}, () => {
    for (const path of ['node_modules/pkg/index.js', 'node_modules/untracked.js', 'package-lock.json',
        'src/runtime.js', '.env', 'src/node_modules/extra.js', 'dist/unexpected.js']) {
        const workspace = mkdtempSync(join(tmpdir(), 'little-arc-preinstall-unit-'));
        try {
            const root = createCompanionFixture(workspace), evidence = join(workspace, 'evidence');
            mkdirSync(evidence);
            writeFixture(root, path, 'unexpected pre-install edit');
            assert.throws(() => recordSpotlightProvenance(root, evidence), path);
        } finally { rmSync(workspace, { recursive: true, force: true }); }
    }
});

test('NUL Git status parsing preserves both rename paths, spaces, and newlines', () => {
    assert.deepEqual(parseGitStatus('R  node_modules/new name.js\0src/old name.js\0?? node_modules/new\nfile.js\0'), [
        { status: 'R ', paths: ['node_modules/new name.js', 'src/old name.js'] },
        { status: '??', paths: ['node_modules/new\nfile.js'] }
    ]);
    assert.deepEqual(parseGitStatus(''), []);
    assert.throws(() => parseGitStatus(' M node_modules/file.js'));
    assert.throws(() => parseGitStatus('R  node_modules/file.js\0'));
});
