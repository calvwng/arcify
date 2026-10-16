// Pure evidence validators; importing the adapter does not import or start Chrome.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readSourceText } from '../source-text.js';
import { SPOTLIGHT_APPEARANCE_SCREENSHOTS, assertSpotlightOptionsFirstPaint, assertSpotlightOptionsEvidence } from '../../scripts/paired-chrome-spotlight-appearance.mjs';

const paint = (mode = 'dark', systemDark = false) => ({ mode, systemDark, themes: [mode], paints: [
    { name: 'first-paint', startTime: 10, mode, resolved: mode === 'system' ? systemDark ? 'dark' : 'light' : mode },
    { name: 'first-contentful-paint', startTime: 12, mode, resolved: mode === 'system' ? systemDark ? 'dark' : 'light' : mode }
] });
for (const mode of ['system', 'light', 'dark']) for (const systemDark of [true, false]) {
    test(`companion first-paint evidence requires ${mode} on media dark=${systemDark}`, () => assertSpotlightOptionsFirstPaint(paint(mode, systemDark)));
}
for (const [name, mutate] of Object.entries({ absentPaints: s => s.paints = [], missingContentful: s => s.paints.pop(),
    missingBootstrap: s => s.themes = [], oppositeBootstrap: s => s.themes.unshift('system'), oppositePaint: s => s.paints[0].resolved = 'light',
    wrongMode: s => s.paints[0].mode = 'system', missingMode: s => s.mode = null, inventedTime: s => s.paints[1].startTime = NaN,
    missingMedia: s => delete s.systemDark })) test(`companion first paint rejects ${name}`, () => {
    const value = paint(); mutate(value); assert.throws(() => assertSpotlightOptionsFirstPaint(value));
});
const evidence = () => ({ screenshots: [...SPOTLIGHT_APPEARANCE_SCREENSHOTS], checks: Array.from({ length: 7 }, (_, index) => `Checked ${index}`),
    states: [['system', 'dark'], ['system', 'light'], ['dark', 'dark'], ['dark', 'dark'], ['light', 'light'], ['light', 'light'],
        ['system', 'dark'], ['system', 'dark'], ['light', 'light'], ['system', 'dark']].map(([preference, colorScheme]) => ({ preference, colorScheme })) });
test('the exact reviewed collector must deliver every screenshot, check and state', () => assertSpotlightOptionsEvidence(evidence()));
for (const [name, mutate] of Object.entries({ missingScreenshot: s => s.screenshots.pop(), renamedScreenshot: s => s.screenshots[0] = 'optional.png',
    reorderedScreenshot: s => s.screenshots.reverse(), missingCheck: s => s.checks.pop(), duplicateCheck: s => s.checks[1] = s.checks[0],
    emptyCheck: s => s.checks[0] = '', missingState: s => s.states.pop(), missingLightSystem: s => s.states[1].preference = 'light',
    missingDarkMode: s => s.states.forEach(state => { if (state.preference === 'dark') state.colorScheme = 'light'; }) })) test(`companion evidence rejects ${name}`, () => {
    const value = evidence(); mutate(value); assert.throws(() => assertSpotlightOptionsEvidence(value));
});
test('adapter adds only passive observation and exact fixture cleanup around reviewed native inputs', () => {
    const source = readSourceText(new URL('../../scripts/paired-chrome-spotlight-appearance.mjs', import.meta.url));
    assert.match(source, /collectOptionsAppearanceEvidence\(\{ browser: adapter, extensionId, outputDir \}\)/);
    assert.match(source, /observePage\(await browser.newPage\(\)\)/);
    assert.match(source, /evaluateOnNewDocument\(observeSpotlightOptionsFirstPaint\)/);
    assert.match(source, /const result = await target\[key\]\(\.\.\.args\)/);
    assert.match(source, /assert\.deepEqual\(value, before\)/);
    assert.match(source, /finishBookmarkFixture/);
    assert.match(source, /evidence.cleanup = cleanup; await record\(structuredClone\(evidence\)\)/);
    assert.doesNotMatch(source, /dispatchEvent\(|\.value\s*=(?!=)|\.focus\(|setAttribute\(|style\.setProperty|puppeteer\.launch|spawn\(|chrome\.storage\.(local|sync)\.(set|remove|clear)\(/);
});
