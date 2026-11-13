import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertOwnedFolderTree, assertOwnedEmptySpace, folderBrowseReady, SPOTLIGHT_FOLDER_CASE_NAME } from '../../scripts/paired-chrome-spotlight-folders.mjs';
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

test('browse readiness rejects previous parent and in-place management prompts', () => {
    const child = { visible: true, label: 'Browse Created nonce', heading: 'Bookmarks / Projects nonce / Created nonce', buttons: ['Back to search', 'Rename folder…'] };
    assert.equal(folderBrowseReady(child, 'Created nonce'), true);
    assert.equal(folderBrowseReady({ ...child, label: 'Browse Projects nonce', heading: 'Bookmarks / Projects nonce' }, 'Created nonce'), false);
    assert.equal(folderBrowseReady({ ...child, heading: 'Rename folder', buttons: ['Cancel', 'Save'] }, 'Created nonce'), false);
    assert.equal(folderBrowseReady({ ...child, visible: false }, 'Created nonce'), false);
    assert.equal(folderBrowseReady(null, 'Created nonce'), false);
    assert.match(fixture, /await button\(`▸ \$\{childTitle\}`\);[\s\S]*?await waitBrowse\(childTitle\);[\s\S]*?await button\('Rename folder…'\)/);
    assert.match(fixture, /await checkpoint\('failure-before-cleanup'\)/);
});

test('Space cleanup authorizes only exact fixture root with empty or already-closed helper membership', () => {
    const fixtureSpace = { bookmarkFolderId: 'root', spaceBookmarks: [], temporaryTabs: [] };
    assertOwnedEmptySpace(fixtureSpace, 'root', 42);
    assertOwnedEmptySpace({ ...fixtureSpace, temporaryTabs: [42] }, 'root', 42);
    assert.throws(() => assertOwnedEmptySpace(fixtureSpace, 'different', 42), /exact fixture/);
    assert.throws(() => assertOwnedEmptySpace({ ...fixtureSpace, temporaryTabs: [43] }, 'root', 42), /unowned/);
    assert.throws(() => assertOwnedEmptySpace({ ...fixtureSpace, spaceBookmarks: [43] }, 'root', 42), /unowned/);
    assert.match(fixture, /await local\(\{ action: 'delete', spaceId: matches\[0\]\.id \}\)/);
    assert.match(fixture, /remaining\.spaces\.map/);
});
