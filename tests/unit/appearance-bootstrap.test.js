import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import { readSourceText } from '../source-text.js';
import { initializeSidebarAppearance } from '../../sidebar-appearance.js';
import { contrastRatio, deriveSpaceTheme } from '../../sidebar-theme.js';
const bootstrap = readSourceText(new URL('../../assets/appearance-bootstrap.js', import.meta.url));
for (const cached of [null, 'system', 'light', 'dark', 'bogus', 'url(bad)', '#ffffff']) for (const dark of [false, true])
    test(`early Settings paint validates ${cached} with media dark=${dark}`, () => {
        const root = { dataset: {}, style: {} }, expectedMode = ['light', 'dark'].includes(cached) ? cached : 'system';
        runInNewContext(bootstrap, { document: { documentElement: root }, localStorage: { getItem: key => { assert.equal(key, 'arcify-theme-mode'); return cached; } }, matchMedia: () => ({ matches: dark }) });
        const expected = expectedMode === 'system' ? dark ? 'dark' : 'light' : expectedMode;
        assert.equal(root.dataset.themeMode, expectedMode); assert.equal(root.dataset.theme, expected); assert.equal(root.style.colorScheme, expected);
    });
test('early Settings paint tolerates unavailable local cache and missing matchMedia', () => {
    const root = { dataset: {}, style: {} };
    runInNewContext(bootstrap, { document: { documentElement: root }, localStorage: { getItem() { throw Error('Unavailable'); } } });
    assert.equal(root.dataset.theme, 'light'); assert.equal(root.dataset.themeMode, 'system');
});
for (const authoritative of ['light', 'dark', undefined]) test(`authoritative ${authoritative} resolves cached initial mode without a provisional System repaint`, async () => {
    const { document } = parseHTML('<html data-theme-mode="dark" data-theme="dark"><body></body></html>');
    const writes = [], events = new Set(); let resolve;
    Object.defineProperty(document.defaultView, 'localStorage', { configurable: true, value: { setItem: (...args) => writes.push(args) } });
    const api = { storage: { local: { get: () => new Promise(done => { resolve = done; }) }, onChanged: { addListener: fn => events.add(fn), removeListener: fn => events.delete(fn) } } };
    const lifecycle = initializeSidebarAppearance({ document, api, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
    assert.equal(document.documentElement.dataset.theme, 'dark'); assert.deepEqual(writes, []);
    resolve({ sidebarAppearance: { themeMode: authoritative } }); await lifecycle.ready;
    assert.equal(document.documentElement.dataset.themeMode, authoritative || 'system');
    assert.deepEqual(writes, [['arcify-theme-mode', authoritative || 'system']]);
    events.forEach(fn => fn({ sidebarAppearance: { newValue: { themeMode: 'dark' } } }, 'local'));
    assert.equal(document.documentElement.dataset.theme, 'dark'); assert.deepEqual(writes.at(-1), ['arcify-theme-mode', 'dark']); lifecycle.dispose();
});
test('first-paint cache failure never prevents authoritative profile updates or lifecycle cleanup', async () => {
    const { document } = parseHTML('<html><body></body></html>'), events = new Set();
    Object.defineProperty(document.defaultView, 'localStorage', { configurable: true, get() { throw Error('Denied'); } });
    const api = { storage: { local: { get: async () => ({ sidebarAppearance: { themeMode: 'dark' } }) }, onChanged: { addListener: fn => events.add(fn), removeListener: fn => events.delete(fn) } } };
    const lifecycle = initializeSidebarAppearance({ document, api }); await lifecycle.ready; assert.equal(document.documentElement.dataset.theme, 'dark'); lifecycle.dispose(); assert.equal(events.size, 0);
});
test('packaged bootstrap precedes fonts, stylesheet and content, without new permissions or inline executable code', () => {
    const html = readSourceText(new URL('../../options.html', import.meta.url));
    assert(html.indexOf('assets/appearance-bootstrap.js') < html.indexOf('fonts.googleapis.com'));
    assert(html.indexOf('assets/appearance-bootstrap.js') < html.indexOf('styles.css'));
    assert.match(html, /<script src="assets\/appearance-bootstrap.js"><\/script>/);
    assert.doesNotMatch(bootstrap, /chrome\.storage.*set|innerHTML|eval\(|setTimeout|fetch\(/);
});
test('Settings text, disabled control text, notices and focus contrast use neutral tokens in both modes', () => {
    for (const mode of ['light', 'dark']) {
        const t = deriveSpaceTheme('#000000', mode);
        for (const background of [t.panel, t.input, t.panelHover]) {
            assert(contrastRatio(t.panelText, background) >= 4.5);
            assert(contrastRatio(t.panelMuted, background) >= 4.5);
            assert(contrastRatio(t.danger, background) >= 4.5);
        }
    }
    const css = readSourceText(new URL('../../styles.css', import.meta.url));
    assert.match(css, /:root:not\(\[data-theme\]\)/);
    assert.match(css, /\.options-page :is\(button, input, select, textarea\):disabled\s*\{\s*opacity: 1;/);
    for (const selector of ['[role="dialog"]', '[role="status"]', '#bridgeStatus[data-state="error"]', '.save-toast', 'textarea)::placeholder']) assert(css.includes(selector));
});
test('shared header sizing centers whole glyph line boxes, keeps long inputs shrinkable and preserves keyboard edit focus', () => {
    const css = readSourceText(new URL('../../styles.css', import.meta.url));
    const block = css.slice(css.indexOf('/* One shared header line box'));
    assert.match(block, /\.space-header \.space-icon\s*\{[^}]*display: inline-flex; align-items: center; justify-content: center; align-self: center;/);
    assert.match(block, /\.space-header \.space-name\s*\{[^}]*min-width: 0;[^}]*box-sizing: border-box;[^}]*text-overflow: ellipsis;/);
    assert.match(block, /\.space-header \.space-name:focus \{ text-overflow: clip; \}/);
    assert.match(block, /\.space-header \.space-icon\[hidden\] \{ display: none; \}/);
    assert.doesNotMatch(block, /translateY|vertical-align|data-emoji|nth-child/);
    const html = readSourceText(new URL('../../sidebar.html', import.meta.url));
    assert.match(html, /<span class="space-icon"[^>]*><\/span>\s*<input[^>]*class="space-name"/);
});
