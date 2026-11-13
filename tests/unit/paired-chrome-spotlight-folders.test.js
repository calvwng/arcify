import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertOwnedFolderTree, SPOTLIGHT_FOLDER_CASE_NAME } from '../../scripts/paired-chrome-spotlight-folders.mjs';
import { createPairedChromeRunReport, beginPairedChromeCase, assertPairedChromeRunPassed } from '../../scripts/paired-chrome-run-plan.mjs';
const smoke = readFileSync(new URL('../../scripts/paired-chrome-smoke.mjs', import.meta.url), 'utf8');
const fixture = readFileSync(new URL('../../scripts/paired-chrome-spotlight-folders.mjs', import.meta.url), 'utf8');
const names = [...smoke.match(/const stepNames = \[([\s\S]*?)\n\];/)[1].matchAll(/^\s*'([^']*)',?$/gm)].map(m => m[1]);
test('folder acceptance is an independent additive plan and cannot pass incomplete', () => {
    assert.equal(names[56], SPOTLIGHT_FOLDER_CASE_NAME);
    const report = createPairedChromeRunReport(names, 'folder-actions');
    assert.deepEqual(report.expectedCases.map(c => c.caseIndex), [0, 1, 2, 56]);
    assert.match(report.scope, /not overlay, browser-restart or full-suite/);
    assert.throws(() => assertPairedChromeRunPassed(report));
    for (const entry of report.expectedCases) beginPairedChromeCase(report, entry.name).status = 'passed';
    assertPairedChromeRunPassed(report);
});
test('cleanup rejects unowned descendants and bookmark leaves before recursive deletion', () => {
    assertOwnedFolderTree([{ id: '1', children: [{ id: '2', children: [] }] }], ['1', '2']);
    assert.throws(() => assertOwnedFolderTree([{ id: '1', children: [{ id: 'other' }] }], ['1']), /unowned/);
    assert.throws(() => assertOwnedFolderTree([{ id: '1', url: 'https://example.test' }], ['1']), /folders only/);
});
test('actual operations use visible trusted controls, real bookmark readback and isolated ownership', () => {
    for (const label of ['Create subfolder…', 'Rename folder…', 'Delete empty folder…', 'Move folder to another Space…', 'Back to search']) assert(fixture.includes(label));
    assert.match(fixture, /await button\('Cancel'\)/);
    assert.match(fixture, /nested child identity/i);
    assert.match(fixture, /await select\.press\('ArrowDown'\)/);
    assert.match(fixture, /assertOwnedFolderTree\(tree, owned\)/);
    assert.doesNotMatch(fixture, /chrome\.bookmarks\.(?:move|update)\(/);
    assert.doesNotMatch(fixture, /dispatchEvent|\.select\(|no-sandbox|puppeteer\.launch/);
});
