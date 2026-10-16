// Static integration contract only. Importing the real runner would launch Chrome.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readSourceText } from '../source-text.js';
const runner = readSourceText(new URL('../../scripts/paired-chrome-smoke.mjs', import.meta.url));
const workflow = readSourceText(new URL('../../.github/workflows/paired-extension-smoke.yml', import.meta.url));

test('menu evidence modules execute once in full-only scope before Favorite receipts and browser restart', () => {
    const fullStart = runner.indexOf("    if (report.runMode === 'full') {\n");
    const fullEnd = runner.indexOf('    } // Full-only cases 3–31, 33–35, 37–38 and 40–43;');
    assert(fullStart > 0 && fullEnd > fullStart);
    for (const [name, index] of [['exerciseSpaceContextBasics', 37], ['exerciseTabMenuActions', 38]]) {
        assert.match(runner, new RegExp(`import \\{[^}]*${name}[^}]*\\} from './paired-chrome-`));
        assert.equal((runner.match(new RegExp(`${name}\\(`, 'g')) || []).length, 1);
        const call = runner.indexOf(`await step(stepNames[${index}]`);
        assert(call > fullStart && call < fullEnd, `${name} must remain full-only.`);
        assert(call > runner.indexOf('await step(stepNames[35]'));
        assert(call < runner.indexOf('await step(stepNames[36]'));
        assert(call < runner.indexOf('await step(stepNames[32]'));
    }
    assert.match(runner, /exerciseTabMenuActions\(\{ apiPage:arcifyOptions,newTabPage,pageForUrl,ui,screenshot,\s*snapshot,poll,fixture,arcifyId,spotlightId,search,/);
    assert.match(runner, /report\.spaceContextMenus\.push\(observation\); await saveReport\(\)/);
    assert.match(runner, /report\.tabMenus = observation; await saveReport\(\)/);
});

test('nonce page server runs before generic fallback without replacing existing fixture handlers', () => {
    const start = runner.indexOf('server = createServer('), end = runner.indexOf('const title = titles[path]', start);
    const handlers = runner.slice(start, end);
    for (const name of ['serveTabMenuFixture', 'serveOrdinaryFavoriteFixture', 'serveFavoriteIconFixture']) {
        assert.match(handlers, new RegExp(`if \\(${name}\\(request, response\\)\\) return;`));
    }
});

test('paired workflow watches menu sources and tests while retaining reviewed peer and sandbox boundaries', () => {
    for (const path of ['scripts/paired-chrome-space-context.mjs', 'scripts/paired-chrome-tab-menu.mjs',
        'scripts/paired-chrome-menu-focus.mjs', 'tests/unit/paired-chrome-menu-focus.test.js',
        'context-menu-session.js', 'tests/unit/context-menu-session.test.js',
        'tests/unit/paired-chrome-space-context.test.js', 'tests/unit/paired-chrome-tab-menu.test.js', 'tests/unit/paired-chrome-menu-wiring.test.js',
        'space-context-menu.js', 'space-icons.js', 'space-colors.js', 'localstorage.js', 'tab-menu-*.js', 'tab-title-projection.js', 'domManager.js']) {
        assert(workflow.includes(`- '${path}'`), `Missing trigger path ${path}`);
    }
    assert.match(workflow, /ref: 019b52718c84c84f785081537534b8902e47946a/);
    assert.match(workflow, /permissions:\n  contents: read/);
    assert.match(runner, /process\.env\.GITHUB_ACTIONS !== 'true' \|\| process\.env\.CI !== 'true'/);
    assert.match(runner, /process\.getuid\?\.\(\) === 0/);
    assert.match(runner, /await windowBState\(\), fixture\.windowBBaseline/);
    assert.match(runner, /assertNoTargetCrashes\(report\.targetLifecycle\)/);
    assert.match(runner, /assertNoPageErrors\(report\.diagnostics\)/);
});
