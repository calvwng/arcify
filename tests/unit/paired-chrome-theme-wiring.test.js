// Source integration contracts only; never import the browser runner locally.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readSourceText } from '../source-text.js';
const runner = readSourceText(new URL('../../scripts/paired-chrome-smoke.mjs', import.meta.url));
const workflow = readSourceText(new URL('../../.github/workflows/paired-extension-smoke.yml', import.meta.url));
const theme = readSourceText(new URL('../../scripts/paired-chrome-space-theme.mjs', import.meta.url));

test('both new theme cases execute exactly once in mandatory full scope before unchanged lifecycle and restart', () => {
    const start = runner.indexOf("    if (report.runMode === 'full') {\n");
    const end = runner.indexOf('    } // Full-only cases 3–31, 33–35, 37–38 and 40–49;');
    assert(start > 0 && end > start);
    for (const [name, index] of [['exerciseSpaceTheme', 46], ['exerciseSpotlightOptionsAppearance', 47]]) {
        assert.equal((runner.match(new RegExp(`${name}\\(`, 'g')) || []).length, 1);
        const call = runner.indexOf(`await step(stepNames[${index}]`);
        assert(call > start && call < end);
        assert(call > runner.indexOf('await step(stepNames[45]'));
        assert(call < runner.indexOf('await step(stepNames[36]'));
        assert(call < runner.indexOf('await step(stepNames[32]'));
    }
    assert.match(runner, /exerciseSpaceTheme\(\{ apiPage:arcifyOptions,nativeSidebar:nativeTodayMoveSidebar,newTabPage,ui,screenshot,/);
    assert.match(runner, /await import\(pathToFileURL\(resolve\(COMPANION, 'test\/e2e\/options-appearance-evidence.js'\)\)\.href\)/);
    assert.match(runner, /exerciseSpotlightOptionsAppearance\(\{ browser,collectOptionsAppearanceEvidence,observePage,apiPage:arcifyOptions,peerPage:spotlightOptions,/);
    assert.match(runner, /report.spaceTheme = evidence; await saveReport\(\)/);
    assert.match(runner, /report.spotlightOptionsAppearance = evidence; await saveReport\(\)/);
    assert.doesNotMatch(runner.slice(runner.indexOf('await step(stepNames[46]'), end), /windowIsolation|\.catch\(/);
});
test('native enum proof requires real setup and restoration rather than a vacuous empty projection', () => {
    assert.match(theme, /space\.id === fixture\.spaces\.work/);
    assert.match(theme, /ui\(settings.page, 'Enable native group sync for exact theme fixture Space', \(\) => setThemeGroupSync\(settings.page, true\)\)/);
    assert.match(theme, /assertThemeNativeProjection\(value, \{ spaceId: target.id, windowId \}\)/);
    assert.match(theme, /nativeSidebar\(\{ revealSpaceId: target.id \}\)/);
    assert.match(theme, /assertThemeNativeProjection\(before, \{ spaceId, windowId \}\)/);
    assert.match(theme, /assertThemeNativeProjection\(after, \{ spaceId, windowId \}\)/);
    assert.match(theme, /assertThemeFixtureRestored\(beforeFixture, value, target.id\)/);
    assert.match(theme, /evidence.cleanup = cleanup; await record\(structuredClone\(evidence\)\)/);
    assert.match(theme, /settings.page.evaluateOnNewDocument\(observeThemeFirstPaint\)/);
    assert.match(theme, /assertThemeFirstPaint\(data, mode, mode\)/);
    assert.doesNotMatch(theme, /dispatchEvent\(|\.value\s*=(?!=)|native\.page\.setViewport|style\.setProperty|emulateFocus/);
});
test('workflow watches new evidence/runtime/paint/docs with all three exact peer pins and unchanged security gates', () => {
    for (const path of ['scripts/paired-chrome-space-theme.mjs', 'scripts/paired-chrome-spotlight-appearance.mjs',
        'tests/unit/paired-chrome-space-theme.test.js', 'tests/unit/paired-chrome-spotlight-appearance.test.js', 'tests/unit/paired-chrome-theme-wiring.test.js',
        'tests/unit/sidebar-theme.test.js', 'tests/unit/appearance-bootstrap.test.js', 'assets/appearance-bootstrap.js', 'docs/space-themes.md', 'docs/theme-paired-ci.md']) {
        assert(workflow.includes(`- '${path}'`), `Missing required workflow watch path: ${path}`);
    }
    const pin = runner.match(/const PINNED_SPOTLIGHT = '([0-9a-f]{40})'/)[1];
    assert.equal(pin, 'dae17a24d4e3b90cecd42a19ceeb7322b755370b');
    assert.equal((workflow.match(new RegExp(`ref: ${pin}`, 'g')) || []).length, 3);
    assert.match(runner, /assert\.deepEqual\(await windowBState\(\), fixture.windowBBaseline/);
    assert.match(runner, /assertNoPageErrors\(report.diagnostics\)/);
    assert.match(runner, /assertNoTargetCrashes\(report.targetLifecycle\)/);
    assert.doesNotMatch(workflow, /continue-on-error:|no-sandbox|disable-web-security|CHROME_DEVEL_SANDBOX/);
});
