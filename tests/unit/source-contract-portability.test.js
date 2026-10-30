import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const suites = [
    'tests/unit/paired-chrome-helper-origin-wiring.test.js',
    'tests/unit/paired-chrome-space-click.test.js'
];
const files = [
    ...suites, 'tests/source-text.js',
    'scripts/paired-chrome-helper-origin.mjs', 'scripts/paired-chrome-newtab.mjs',
    'scripts/paired-chrome-space-click.mjs', 'scripts/paired-chrome-spotlight-navigation.mjs',
    'scripts/paired-chrome-spotlight-tabs.mjs', 'scripts/paired-chrome-ordinary-favorites.mjs',
    '.github/workflows/paired-extension-smoke.yml'
];
const originCase = 'tabs actual helper call site executes the strict origin implementation';
const workflowCase = 'paired hosted workflow watches the exact Space click helper and regression file';
const navigationCase = 'navigation actual helper call site executes the strict origin implementation';

function replaceOnce(source, before, after) {
    assert.equal(source.split(before).length - 1, 1, 'Mutation must change exactly one real source location.');
    return source.replace(before, after);
}

// Run the actual suites against isolated checkout bytes, not duplicate assertion
// implementations. The executable imports are pure fixture helpers; neither the
// browser runner nor the inspected workflow is executed. Never rewrite the repo.
async function runCheckout(ending, mutation) {
    const directory = await mkdtemp(join(tmpdir(), 'arcify-source-contract-'));
    const env = { ...process.env };
    // This is a separate runner, not a nested node:test worker. Inheriting this
    // private marker can make Node skip every child test and exit successfully.
    delete env.NODE_TEST_CONTEXT;
    try {
        await writeFile(join(directory, 'package.json'), '{"type":"module"}\n');
        for (const path of files) {
            let source = (await readFile(new URL(`../../${path}`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
            if (mutation === 'origin' && path === 'scripts/paired-chrome-spotlight-tabs.mjs') {
                source = replaceOnce(source, "contextAction: 'arcifyTabActionsContext'", "contextAction: 'wrongContext'");
            }
            if (mutation === 'workflow' && path === '.github/workflows/paired-extension-smoke.yml') {
                source = replaceOnce(source, "      - 'scripts/paired-chrome-space-click.mjs'\n", '');
            }
            const output = join(directory, path);
            await mkdir(dirname(output), { recursive: true });
            await writeFile(output, source.replace(/\n/g, ending));
        }
        try {
            return { code: 0, ...await execute(process.execPath, ['--test', '--test-reporter=tap', ...suites], {
                cwd: directory, env, timeout: 30_000, maxBuffer: 2 * 1024 * 1024
            }) };
        } catch (error) {
            // Timeout, signal, missing executable and other harness failures must
            // never count as successful rejection of a semantic mutation.
            if (typeof error.code !== 'number' || error.killed || error.signal) throw error;
            return { code: error.code, stdout: error.stdout, stderr: error.stderr };
        }
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

function caseResult(output, name, passed) {
    const prefix = passed ? 'ok' : 'not ok';
    assert(output.split('\n').some(line => new RegExp(`^${prefix} \\d+ - `).test(line) && line.endsWith(name)),
        `Expected ${prefix} for ${name}\n${output}`);
}

for (const [name, ending] of [['LF', '\n'], ['CRLF', '\r\n']]) {
    test(`actual source-contract suites pass with ${name} checkout bytes`, async () => {
        const result = await runCheckout(ending);
        assert.equal(result.code, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /^# fail 0$/m);
        assert.match(result.stdout, /^# skipped 0$/m);
        for (const label of [originCase, workflowCase, navigationCase,
            'tabs actual call site rejects malformed evidence immediately instead of waiting for a valid suffix']) {
            caseResult(result.stdout, label, true);
        }
    });
    test(`${name} normalization still rejects a changed actual origin context`, async () => {
        const result = await runCheckout(ending, 'origin');
        assert.equal(result.code, 1, result.stdout + result.stderr);
        caseResult(result.stdout, originCase, false);
        caseResult(result.stdout, navigationCase, true);
        caseResult(result.stdout, workflowCase, true);
    });
    test(`${name} normalization still rejects a missing exact workflow watch path`, async () => {
        const result = await runCheckout(ending, 'workflow');
        assert.equal(result.code, 1, result.stdout + result.stderr);
        caseResult(result.stdout, workflowCase, false);
        caseResult(result.stdout, originCase, true);
        assert.match(result.stdout, /scripts\/paired-chrome-space-click\.mjs must trigger paired hosted verification/);
    });
}
