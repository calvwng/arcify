import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readSourceText } from '../source-text.js';

async function withSource(text, check) {
    const dir = await mkdtemp(join(tmpdir(), 'arcify-source-text-'));
    try {
        const path = join(dir, 'source.txt');
        await writeFile(path, text, 'utf8');
        await check(pathToFileURL(path));
        assert.equal(await readFile(path, 'utf8'), text, 'Inspecting a source must not rewrite the checkout.');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

const source = "permissions:\n  contents: read\n\n    if (report.runMode === 'full') {\n        verify();\n    }\n";
for (const [name, text] of [
    ['LF', source],
    ['CRLF', source.replace(/\n/g, '\r\n')],
    ['mixed LF/CRLF', source.replace('permissions:\n', 'permissions:\r\n')]
]) {
    test(`source-contract reads normalize ${name} without changing other source text`, async () => {
        await withSource(text, path => assert.equal(readSourceText(path), source));
    });
}

test('source-contract reads preserve lone CR, indentation, trailing spaces, blank lines and Unicode', async () => {
    const text = "\ufeff  exact\tcontent  \r\n\r\nα → β\rcarriage\n'\\r\\n' escapes\nlast line";
    await withSource(text, path => assert.equal(readSourceText(path), "\ufeff  exact\tcontent  \n\nα → β\rcarriage\n'\\r\\n' escapes\nlast line"));
});

for (const ending of ['\n', '\r\n']) {
    test(`source-contract normalization cannot hide permission or sandbox changes (${JSON.stringify(ending)})`, async () => {
        await withSource(`permissions:${ending}  contents: write${ending}args: ['--no-sandbox']${ending}`, path => {
            const text = readSourceText(path);
            assert.throws(() => assert.match(text, /^permissions:\n  contents: read$/m));
            assert.throws(() => assert.doesNotMatch(text, /no-sandbox/));
        });
    });
    test(`source-contract normalization retains missing/reordered gates (${JSON.stringify(ending)})`, async () => {
        await withSource(`    report.status = 'passed';${ending}    assertPairedChromeRunPassed(report);${ending}`, path => {
            assert.throws(() => assert.match(readSourceText(path), /assertPairedChromeRunPassed\(report\);\n    report.status = 'passed'/));
        });
    });
}

test('missing source files remain hard failures', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'arcify-source-missing-'));
    try {
        assert.throws(() => readSourceText(pathToFileURL(join(dir, 'missing.txt'))), { code: 'ENOENT' });
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
