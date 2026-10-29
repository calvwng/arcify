import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { readFile } from 'node:fs/promises';
import { SPACE_COLORS, DEFAULT_SPACE_COLORS, normalizeCustomTint, normalizeColorOverrides, getSpaceTint } from '../../space-colors.js';
import { deriveSpaceTheme, contrastRatio, applySpaceTheme, setThemeMode, setSpaceColorOverrides,
    initializeSidebarTheme, initializeSpaceColorOverrides, getDocumentSpaceTint } from '../../sidebar-theme.js';
import { initializeSidebarAppearance } from '../../sidebar-appearance.js';

const doc = () => parseHTML('<html><body><input id="name" value="Editing"><button id="favorite" aria-selected="true">Saved</button><div class="space-editor"><input id="hex" value="#000000"></div></body></html>').document;
function mediaFixture(matches = false) {
    const listeners = new Set();
    const media = { matches, addEventListener: (type, listener) => listeners.add(listener), removeEventListener: (type, listener) => listeners.delete(listener) };
    return { media, listeners, matchMedia: () => media, change(value) { media.matches = value; listeners.forEach(listener => listener({ matches: value })); } };
}

test('custom colors admit only six-digit sRGB hex, with safe native presets and palette fallbacks', () => {
    assert.equal(normalizeCustomTint('#aAbBcC'), '#aabbcc');
    for (const invalid of [null, undefined, {}, [], 123456, '#123', '#12345678', '#zzzzzz', '#123456\n', ' #123456', 'red', 'rgb(0 0 0)', 'var(--bad)', 'url(https://bad.test)', '#000000; color:red']) assert.equal(normalizeCustomTint(invalid), null);
    assert.deepEqual(normalizeColorOverrides({ blue: '#000000', pink: '#FFFFFF', unknown: '#111111', grey: 'url(https://bad.test)' }), { blue: '#000000', pink: '#ffffff' });
    assert.equal(getSpaceTint({ color: 'blue' }), DEFAULT_SPACE_COLORS.blue);
    assert.equal(getSpaceTint({ color: '#ff0000', customTint: 'var(--bad)' }), DEFAULT_SPACE_COLORS.grey);
    assert.equal(getSpaceTint({ color: 'blue', customTint: '#ffffff' }, { blue: '#000000' }), '#ffffff');
    assert.equal(getSpaceTint({ color: 'blue', customTint: null }, { blue: '#000000' }), '#000000');
});

test('extreme and intermediate custom tints derive readable normal, muted, hover, selection, panel and marker colors', () => {
    const colors = new Set(['#000000', '#ffffff', '#ff0000', '#00ff00', '#0000ff', '#ffff00', '#00ffff', '#ff00ff', ...Object.values(DEFAULT_SPACE_COLORS)]);
    for (let r = 0; r <= 255; r += 51) for (let g = 0; g <= 255; g += 51) for (let b = 0; b <= 255; b += 51) colors.add('#' + [r, g, b].map(n => n.toString(16).padStart(2, '0')).join(''));
    for (const mode of ['light', 'dark']) for (const tint of colors) {
        const t = deriveSpaceTheme(tint, mode);
        const pairs = [[t.text, t.surface, 4.5], [t.muted, t.surface, 4.5], [t.text, t.hover, 4.5],
            [t.text, t.secondary, 4.5], [t.selectedText, t.selected, 4.5], [t.marker, t.surface, 3],
            [t.marker, t.hover, 3], [t.marker, t.selected, 3], [t.panelText, t.panel, 4.5],
            [t.panelMuted, t.panel, 4.5], [t.panelText, t.input, 4.5], [t.panelText, t.panelHover, 4.5], [t.danger, t.panel, 4.5]];
        for (const [fg, bg, minimum] of pairs) assert(contrastRatio(fg, bg) >= minimum, `${mode} ${tint}: ${fg} on ${bg} is ${contrastRatio(fg, bg)}`);
        for (const color of Object.values(t)) assert.match(color, /^#[0-9a-f]{6}$/);
    }
});

test('System follows matchMedia changes; explicit modes override it; disposal removes exactly the listener', () => {
    const document = doc(), f = mediaFixture(true), controller = initializeSidebarTheme({ document, matchMedia: f.matchMedia });
    const root = document.documentElement;
    assert.equal(root.dataset.themeMode, 'system'); assert.equal(root.dataset.theme, 'dark');
    f.change(false); assert.equal(root.dataset.theme, 'light');
    setThemeMode(document, 'dark'); f.change(true); f.change(false); assert.equal(root.dataset.theme, 'dark');
    setThemeMode(document, 'light'); f.change(true); assert.equal(root.dataset.theme, 'light');
    setThemeMode(document, 'system'); assert.equal(root.dataset.theme, 'dark');
    assert.equal(root.style.getPropertyValue('color-scheme'), 'dark');
    setThemeMode(document, 'url(bad)'); assert.equal(root.dataset.themeMode, 'system');
    controller.dispose(); assert.equal(f.listeners.size, 0); f.change(false); assert.equal(root.dataset.theme, 'dark');
});

test('theme, custom tint and palette changes only mutate root tokens, retaining live editor/selection/menu identity', () => {
    const document = doc(), f = mediaFixture(), controller = initializeSidebarTheme({ document, matchMedia: f.matchMedia });
    const name = document.getElementById('name'), favorite = document.getElementById('favorite'), hex = document.getElementById('hex');
    const editor = document.querySelector('.space-editor');
    Object.defineProperty(document, 'activeElement', { value: hex });
    hex.selectionStart = 2; hex.selectionEnd = 5; name.value = 'Unsaved name';
    for (const themeMode of ['dark', 'light', 'system']) for (const customTint of ['#000000', '#ffffff', '#e135ff', null]) {
        setThemeMode(document, themeMode); applySpaceTheme(document, { id: 'a', color: 'blue', customTint });
        setSpaceColorOverrides(document, { blue: '#010101', unexpected: 'url(https://bad.test)' }); f.change(true);
        assert.equal(document.activeElement, hex); assert.equal(hex.selectionStart, 2); assert.equal(hex.selectionEnd, 5);
        assert.equal(document.querySelector('.space-editor'), editor); assert.equal(document.getElementById('favorite'), favorite);
        assert.equal(favorite.getAttribute('aria-selected'), 'true'); assert.equal(name.value, 'Unsaved name');
        assert.equal(document.documentElement.style.getPropertyValue('--chrome-blue-color'), '#010101');
        assert.equal(getDocumentSpaceTint(document, { color: 'blue', customTint }), customTint || '#010101');
    }
    setSpaceColorOverrides(document, null); assert.equal(getDocumentSpaceTint(document, { color: 'blue' }), DEFAULT_SPACE_COLORS.blue);
    controller.dispose();
});

test('appearance initial read cannot overwrite an incoming theme choice, removal restores System and listeners dispose', async () => {
    const document = doc(), f = mediaFixture(true), listeners = new Set(); let finish;
    const api = { storage: { local: { get: () => new Promise(resolve => { finish = resolve; }) },
        onChanged: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) } } };
    const appearance = initializeSidebarAppearance({ document, api, matchMedia: f.matchMedia });
    listeners.forEach(fn => fn({ sidebarAppearance: { newValue: { themeMode: 'light' } } }, 'local'));
    finish({ sidebarAppearance: { themeMode: 'dark' } }); await appearance.ready;
    assert.equal(document.documentElement.dataset.theme, 'light');
    listeners.forEach(fn => fn({ sidebarAppearance: { newValue: undefined } }, 'local'));
    assert.equal(document.documentElement.dataset.themeMode, 'system'); assert.equal(document.documentElement.dataset.theme, 'dark');
    appearance.dispose(); assert.equal(f.listeners.size, 0); assert.equal(listeners.size, 0);
});

test('controlled CSS has explicit readable surfaces and header-name visibility is unaffected by icon-only mode', async () => {
    const css = await readFile(new URL('../../styles.css', import.meta.url), 'utf8');
    assert.match(css, /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root:not\(\[data-theme\]\)/, 'Only the unhydrated System fallback may use an OS-only rule.');
    for (const token of ['--theme-panel-bg', '--theme-panel-text', '--theme-selected-bg', '--theme-selected-text', '--sidebar-drop-color']) assert(css.includes(`var(${token})`));
    assert.doesNotMatch(css, /data-hide-space-names[^}]+\.space-name\s*\{/);
    const sidebar = await readFile(new URL('../../sidebar.html', import.meta.url), 'utf8');
    assert.match(sidebar, /<span class="space-icon"[^>]*><\/span>\s*<input[^>]*class="space-name"/);
    for (const color of SPACE_COLORS) assert(css.includes(`--chrome-${color}-color`));
});

test('palette subscription precedes its read and rejects stale initial snapshots, including external reset', async () => {
    for (const latest of [{ blue: '#abcdef' }, undefined]) {
        const document = doc(), listeners = new Set(); let finish;
        const api = { storage: { sync: { get: () => new Promise(resolve => { finish = resolve; }) },
            onChanged: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) } } };
        const palette = initializeSpaceColorOverrides({ document, api });
        assert.equal(listeners.size, 1);
        listeners.forEach(fn => fn({ colorOverrides: { newValue: latest } }, 'sync'));
        finish({ colorOverrides: { blue: '#000000' } }); await palette.ready;
        assert.equal(getDocumentSpaceTint(document, { color: 'blue' }), latest?.blue || DEFAULT_SPACE_COLORS.blue);
        listeners.forEach(fn => fn({ colorOverrides: { newValue: { blue: '#ff0000' } } }, 'local'));
        assert.equal(getDocumentSpaceTint(document, { color: 'blue' }), latest?.blue || DEFAULT_SPACE_COLORS.blue);
        palette.dispose(); assert.equal(listeners.size, 0);
    }
});

test('palette disposal suppresses an outstanding read; failures report once and keep safe colors', async () => {
    const document = doc(), listeners = new Set(); let finish;
    const api = { storage: { sync: { get: () => new Promise(resolve => { finish = resolve; }) },
        onChanged: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) } } };
    const palette = initializeSpaceColorOverrides({ document, api });
    palette.dispose(); finish({ colorOverrides: { blue: '#000000' } }); await palette.ready;
    assert.equal(getDocumentSpaceTint(document, { color: 'blue' }), DEFAULT_SPACE_COLORS.blue);
    const errors = []; api.storage.sync.get = async () => { throw new Error('Unavailable'); };
    const failed = initializeSpaceColorOverrides({ document, api, onError: error => errors.push(error.message) });
    await failed.ready; assert.deepEqual(errors, ['Unavailable']); assert.equal(getDocumentSpaceTint(document, { color: 'blue' }), DEFAULT_SPACE_COLORS.blue);
    failed.dispose(); assert.equal(listeners.size, 0);
});

test('switcher chips own their Space themes while live palette/appearance changes preserve DOM identity', async () => {
    const {applySpaceSwitcherTheme}=await import('../../sidebar-theme.js');
    const document=doc();document.body.insertAdjacentHTML('beforeend','<div class="space-switcher"><button data-space-id="a">Home</button><button data-space-id="b">Work</button></div><button id="plus">+</button>');
    const [a,b]=document.querySelectorAll('.space-switcher button');const spaces=[{id:'a',color:'blue'},{id:'b',color:'green',customTint:'#001122'}];
    setThemeMode(document,'dark');applySpaceSwitcherTheme(document,a,spaces[0]);applySpaceSwitcherTheme(document,b,spaces[1]);
    const ownB=b.style.getPropertyValue('--space-chip-bg');assert.notEqual(a.style.getPropertyValue('--space-chip-bg'),ownB);
    applySpaceTheme(document,spaces[0]);applySpaceTheme(document,{color:'red'});assert.equal(b.style.getPropertyValue('--space-chip-bg'),ownB);
    assert.equal(document.querySelector('[data-space-id="a"]'),a);assert.equal(document.getElementById('plus').getAttribute('style'),null);
    setSpaceColorOverrides(document,{blue:'#aabbcc'});assert.equal(a.style.getPropertyValue('--space-chip-tint'),'#aabbcc');assert.equal(b.style.getPropertyValue('--space-chip-tint'),'#001122');
    setThemeMode(document,'light');assert.equal(b.style.getPropertyValue('--space-chip-bg'),deriveSpaceTheme('#001122','light').secondary);assert.equal(document.querySelector('[data-space-id="b"]'),b);
});
test('invalid switcher tint falls back and cannot inject arbitrary CSS', async()=>{
    const {applySpaceSwitcherTheme}=await import('../../sidebar-theme.js');const document=doc(),button=document.createElement('button');
    const theme=applySpaceSwitcherTheme(document,button,{color:'var(--evil)',customTint:'url(https://evil.test)'});assert.equal(theme.tint,'#cccccc');
    for(const key of ['tint','bg','text','hover','selected','selectedText','marker'])assert.match(button.style.getPropertyValue('--space-chip-'+key),/^#[0-9a-f]{6}$/);
});
test('Space chip CSS preserves own hover/selection contrast, circle sizing and separate plus',async()=>{
    const css=await readFile(new URL('../../styles.css',import.meta.url),'utf8');
    const delta=css.slice(css.indexOf('/* Bottom Space switcher: every chip owns its tint;'));
    assert.match(delta,/button\[data-space-id\]\.active/);assert.match(delta,/--space-chip-selectedText/);assert.match(delta,/inset 0 0 0 2px var\(--space-chip-marker/);
    assert.doesNotMatch(delta,/add-space-toggle|width:|height:|border-radius:/);
});
