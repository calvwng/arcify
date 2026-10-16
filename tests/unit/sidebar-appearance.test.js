import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseHTML } from 'linkedom';
import { DEFAULT_SIDEBAR_APPEARANCE as defaults, SIDEBAR_APPEARANCE_KEY as key,
    normalizeSidebarAppearance, applySidebarAppearance, initializeSidebarAppearance } from '../../sidebar-appearance.js';
import { initializeSidebarAppearanceOptions } from '../../sidebar-appearance-options.js';

const compact = { favoritesLayout: 'compact', favoriteTileSize: 44, spaceHeaderSize: 12, hideSpaceNames: false };
function apiFixture(initial = {}) {
    const data = structuredClone(initial), listeners = new Set(), writes = [];
    let locked = Promise.resolve();
    const locks = { request(_name, callback) { const next = locked.then(callback); locked = next.catch(() => {}); return next; } };
    let beforeRead, beforeWrite;
    const api = { storage: {
        onChanged: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) },
        local: {
            async get(name) { const result = { [name]: structuredClone(data[name]) }; await beforeRead?.(); return result; },
            async set(patch) {
                await beforeWrite?.();
                writes.push(structuredClone(patch));
                Object.assign(data, structuredClone(patch));
                emit({ [key]: { newValue: structuredClone(data[key]) } });
            }
        }
    } };
    const emit = (changes, area = 'local') => listeners.forEach(listener => listener(changes, area));
    return { api, locks, data, writes, listeners, emit, beforeRead: fn => { beforeRead = fn; }, beforeWrite: fn => { beforeWrite = fn; } };
}
async function optionsFixture(initial, shared = null) {
    const { document, window } = parseHTML(await readFile(new URL('../../options.html', import.meta.url), 'utf8'));
    Object.defineProperty(window.HTMLSelectElement.prototype, 'value', {
        configurable: true,
        get() { return this.querySelector('option[selected]')?.value || ''; },
        set(value) { for (const option of this.querySelectorAll('option')) option.toggleAttribute('selected', option.value === value); }
    });
    const f = shared || apiFixture(initial), controller = initializeSidebarAppearanceOptions({ document, api: f.api, locks: f.locks });
    const node = id => document.getElementById(id);
    const input = (id, value, type = 'input') => {
        node(id).value = String(value);
        node(id).dispatchEvent(new window.Event(type));
        return controller.whenSaved();
    };
    await controller.ready;
    return { ...f, controller, document, window, node, input };
}

test('appearance normalization preserves defaults and bounds only finite numeric inputs', () => {
    for (const value of [undefined, null, [], true, 'compact', 1, {}]) assert.deepEqual(normalizeSidebarAppearance(value), defaults);
    for (const bad of [null, true, '36', '44px', 'url(https://bad.test)', Infinity, -Infinity, NaN, {}, []]) {
        assert.deepEqual(normalizeSidebarAppearance({ favoriteTileSize: bad, spaceHeaderSize: bad }), defaults);
    }
    assert.deepEqual(normalizeSidebarAppearance({ favoritesLayout: 'compact', favoriteTileSize: -5, spaceHeaderSize: 200, unexpected: true }),
        { favoritesLayout: 'compact', favoriteTileSize: 36, spaceHeaderSize: 20, hideSpaceNames: false });
    assert.deepEqual(normalizeSidebarAppearance({ favoritesLayout: 'anything', favoriteTileSize: 99, spaceHeaderSize: -1 }),
        { favoritesLayout: 'standard', favoriteTileSize: 64, spaceHeaderSize: 12, hideSpaceNames: false });
    assert.deepEqual(normalizeSidebarAppearance({ favoriteTileSize: 45.6, spaceHeaderSize: 17.2 }),
        { favoritesLayout: 'standard', favoriteTileSize: 46, spaceHeaderSize: 17, hideSpaceNames: false });
});

test('in-place density updates preserve Favorite names, state, handlers and Space edit focus', () => {
    const { document, window } = parseHTML('<html><body><div class="pinned-favicon saved-favorite" title="Calendar\nClosed · click to open" aria-label="Calendar. Closed · click to open" role="button" tabindex="0"><span class="favorite-state">Closed</span></div><div class="space-header"><input class="space-name" value="Work"></div></body></html>');
    const favorite = document.querySelector('.pinned-favicon'), name = document.querySelector('.space-name');
    name.value = 'Uncommitted edit';
    Object.defineProperty(document, 'activeElement', { value: name });
    let clicks = 0; favorite.addEventListener('click', () => { clicks++; });
    for (const settings of [compact, { ...compact, favoriteTileSize: 64, spaceHeaderSize: 20 }, defaults]) {
        applySidebarAppearance(document, settings);
        assert.equal(document.activeElement, name); assert.equal(name.value, 'Uncommitted edit');
        assert.equal(document.querySelector('.pinned-favicon'), favorite);
        assert.equal(favorite.getAttribute('aria-label'), 'Calendar. Closed · click to open');
        assert.equal(favorite.title, 'Calendar\nClosed · click to open');
        assert.equal(favorite.querySelector('.favorite-state').textContent, 'Closed');
        favorite.dispatchEvent(new window.Event('click'));
        assert.equal(document.documentElement.dataset.favoritesLayout, settings.favoritesLayout);
        assert.equal(document.documentElement.dataset.spaceHeaderSize, String(settings.spaceHeaderSize));
        assert.equal(document.documentElement.style.getPropertyValue('--favorite-tile-size'), `${settings.favoriteTileSize}px`);
    }
    assert.equal(clicks, 3); assert.equal(document.documentElement.dataset.spaceHeaderCustom, 'false');
});

test('initial local read cannot overwrite a newer change; removal resets and sync is ignored', async () => {
    const { document } = parseHTML('<html><body></body></html>');
    const f = apiFixture({ [key]: defaults });
    let finish;
    f.beforeRead(() => new Promise(resolve => { finish = resolve; }));
    const controller = initializeSidebarAppearance({ document, api: f.api });
    assert.equal(document.documentElement.dataset.favoritesLayout, 'standard');
    f.emit({ [key]: { newValue: compact } });
    finish(); await controller.ready;
    assert.equal(document.documentElement.dataset.favoritesLayout, 'compact');
    f.emit({ [key]: { newValue: defaults } }, 'sync');
    assert.equal(document.documentElement.dataset.favoritesLayout, 'compact');
    f.emit({ [key]: { oldValue: compact } });
    assert.equal(document.documentElement.dataset.favoritesLayout, 'standard');
    assert.equal(document.documentElement.dataset.spaceHeaderSize, '16');
    assert.equal(f.writes.length, 0);
    controller.dispose(); assert.equal(f.listeners.size, 0);
});

test('failed appearance reads leave usable defaults and report the error', async () => {
    const { document } = parseHTML('<html><body></body></html>');
    const f = apiFixture(), errors = [];
    f.beforeRead(() => { throw new Error('storage unavailable'); });
    const controller = initializeSidebarAppearance({ document, api: f.api, onError: error => errors.push(error.message) });
    await controller.ready;
    assert.equal(document.documentElement.dataset.favoritesLayout, 'standard');
    assert.deepEqual(errors, ['storage unavailable']); controller.dispose();
});

test('options restore and independently autosave layout, tile and header through local storage', async () => {
    const f = await optionsFixture({ [key]: compact, persistentFavorites: ['preserve'], unrelated: true });
    assert.equal(f.node('favoritesLayout').value, 'compact');
    assert.equal(f.node('favoriteTileSize').value, '44'); assert.equal(f.node('favoriteTileSize').disabled, false);
    assert.equal(f.node('spaceHeaderSize').value, '12');
    await f.input('favoriteTileSize', 52);
    assert.equal(f.node('favoriteTileSizeValue').textContent, '52 px');
    await f.input('spaceHeaderSize', 19);
    await f.input('favoritesLayout', 'standard', 'change');
    assert.equal(f.node('favoriteTileSize').disabled, true);
    assert.equal(f.node('spaceHeaderSize').disabled, false);
    assert.deepEqual(f.data[key], { favoritesLayout: 'standard', favoriteTileSize: 52, spaceHeaderSize: 19, hideSpaceNames: false });
    assert.deepEqual(f.data.persistentFavorites, ['preserve']); assert.equal(f.data.unrelated, true);
    assert(f.writes.every(patch => Object.keys(patch).join() === key));
    assert.match(f.node('sidebarAppearanceStatus').textContent, /saved for this Chrome profile/);
    f.controller.dispose();
    const restored = await optionsFixture(f.data);
    assert.equal(restored.node('favoriteTileSize').value, '52'); assert.equal(restored.node('spaceHeaderSize').value, '19');
    restored.controller.dispose();
});

test('reset restores appearance defaults without touching unrelated profile data', async () => {
    const f = await optionsFixture({ [key]: { ...compact, favoriteTileSize: 64, hideSpaceNames: true }, colorOverrides: { blue: '#000000' }, spaces: ['unchanged'] });
    f.node('resetSidebarAppearance').dispatchEvent(new f.window.Event('click'));
    await f.controller.whenSaved();
    assert.deepEqual(f.data[key], defaults); assert.deepEqual(f.data.colorOverrides, { blue: '#000000' }); assert.deepEqual(f.data.spaces, ['unchanged']);
    assert.equal(f.node('favoritesLayout').value, 'standard'); assert.equal(f.node('favoriteTileSize').disabled, true);
    assert.equal(f.node('favoriteTileSizeValue').textContent, '44 px'); assert.equal(f.node('spaceHeaderSizeValue').textContent, '16 px');
    f.controller.dispose();
});

test('rapid slider changes serialize and retain the final values, including a queued reset', async () => {
    const f = await optionsFixture({ [key]: compact });
    let finish, first = true;
    f.beforeWrite(() => first ? new Promise(resolve => { finish = resolve; first = false; }) : undefined);
    f.input('favoriteTileSize', 45); f.input('favoriteTileSize', 46); f.input('spaceHeaderSize', 14);
    for (let i = 0; i < 5 && !finish; i++) await Promise.resolve();
    assert.equal(f.node('favoriteTileSize').value, '46'); assert.equal(f.node('spaceHeaderSize').value, '14');
    finish(); await f.controller.whenSaved();
    assert.deepEqual(f.data[key], { ...compact, favoriteTileSize: 46, spaceHeaderSize: 14 });
    f.input('favoriteTileSize', 64);
    f.node('resetSidebarAppearance').dispatchEvent(new f.window.Event('click'));
    await f.controller.whenSaved(); assert.deepEqual(f.data[key], defaults);
    f.controller.dispose();
});

test('options report rejected writes honestly, can retry, and follow external resets', async () => {
    const f = await optionsFixture({ [key]: compact });
    f.beforeWrite(() => { throw new Error('disk failure'); });
    await f.input('favoriteTileSize', 55);
    assert.match(f.node('sidebarAppearanceStatus').textContent, /Could not save/);
    assert.equal(f.data[key].favoriteTileSize, 44);
    f.beforeWrite(null); await f.input('favoriteTileSize', 55);
    assert.equal(f.data[key].favoriteTileSize, 55); assert.match(f.node('sidebarAppearanceStatus').textContent, /saved/);
    f.emit({ [key]: { newValue: defaults } });
    assert.equal(f.node('favoritesLayout').value, 'standard'); assert.equal(f.node('spaceHeaderSize').value, '16');
    f.controller.dispose(); assert.equal(f.listeners.size, 0);
});


test('two options pages serialize independent patches and reconcile to the same saved appearance', async () => {
    const shared = apiFixture({ [key]: defaults });
    const a = await optionsFixture({}, shared), b = await optionsFixture({}, shared);
    await Promise.all([a.input('favoritesLayout', 'compact', 'change'), b.input('spaceHeaderSize', 12)]);
    assert.deepEqual(shared.data[key], compact);
    for (const f of [a, b]) {
        assert.equal(f.node('favoritesLayout').value, 'compact');
        assert.equal(f.node('spaceHeaderSize').value, '12');
    }
    await Promise.all([b.input('favoriteTileSize', 52), a.input('spaceHeaderSize', 20)]);
    assert.deepEqual(shared.data[key], { ...compact, favoriteTileSize: 52, spaceHeaderSize: 20, hideSpaceNames: false });
    for (const f of [a, b]) {
        assert.equal(f.node('favoriteTileSize').value, '52');
        assert.equal(f.node('spaceHeaderSize').value, '20');
        f.controller.dispose();
    }
});

test('missing cross-page locking fails safely without an unlocked write', async () => {
    const shared = apiFixture({ [key]: compact });
    shared.locks = null;
    const f = await optionsFixture({}, shared);
    await f.input('favoriteTileSize', 55);
    assert.equal(f.writes.length, 0);
    assert.match(f.node('sidebarAppearanceStatus').textContent, /Could not save/);
    f.controller.dispose();
});

test('CSS uses fixed compact tracks, hidden visual labels, bounded controls and visible keyboard focus', async () => {
    const css = await readFile(new URL('../../styles.css', import.meta.url), 'utf8');
    assert.match(css, /data-favorites-layout="compact"\] \.pinned-favicons\s*\{[^}]*display: grid;[^}]*repeat\(auto-fill, var\(--favorite-tile-size, 44px\)\)[^}]*justify-content: start;/);
    assert.match(css, /data-favorites-layout="compact"\] \.pinned-favicon\s*\{[^}]*width: var\(--favorite-tile-size, 44px\);[^}]*height: var\(--favorite-tile-size, 44px\);/);
    assert.match(css, /data-favorites-layout="compact"\] \.favorite-state \{ display: none;/);
    assert.match(css, /\.space-name-container:focus-within \.space-toggle-chevron\s*\{[^}]*min-width: 24px;[^}]*min-height: 24px;/);
    assert.match(css, /\.space-name:focus-visible \{ outline: 2px/);
    assert.match(css, /data-space-header-custom="true"\] \.space-name\s*\{[^}]*font-size: var\(--space-header-font-size\)/);
});

test('icon-only switcher appearance is opt-in, boolean-only and updates existing elements in place', () => {
    for (const value of ['true', 1, null, [], {}]) assert.equal(normalizeSidebarAppearance({ hideSpaceNames: value }).hideSpaceNames, false);
    assert.equal(normalizeSidebarAppearance({ hideSpaceNames: true }).hideSpaceNames, true);
    const { document } = parseHTML('<html><body><div class="space-header"><input class="space-name" value="Work"></div><div class="space-switcher"><button data-space-id="a" title="Work" aria-label="Switch to space Work"><span class="space-icon">👩🏽‍💻</span><span class="space-switcher-name">Work</span></button></div><div role="dialog"><h2>Rename Work</h2></div></body></html>');
    const chip = document.querySelector('button'), name = document.querySelector('.space-name');
    Object.defineProperty(document, 'activeElement', { value: chip });
    for (const hideSpaceNames of [true, false, true]) {
        applySidebarAppearance(document, { hideSpaceNames });
        assert.equal(document.documentElement.dataset.hideSpaceNames, String(hideSpaceNames));
        assert.equal(document.querySelector('button'), chip); assert.equal(document.activeElement, chip);
        assert.equal(chip.title, 'Work'); assert.equal(chip.getAttribute('aria-label'), 'Switch to space Work');
        assert.equal(chip.querySelector('.space-switcher-name').textContent, 'Work');
        assert.equal(name.value, 'Work'); assert.equal(document.querySelector('h2').textContent, 'Rename Work');
    }
});

test('hide-names toggle persists across options pages and sidebar reload, merges independently, and resets', async () => {
    const shared = apiFixture({ [key]: compact });
    const a = await optionsFixture({}, shared), b = await optionsFixture({}, shared);
    const sidebar = parseHTML('<html><body></body></html>').document;
    const listener = initializeSidebarAppearance({ document: sidebar, api: shared.api }); await listener.ready;
    assert.equal(a.node('hideSpaceNames').checked, false); assert.equal(a.node('hideSpaceNames').disabled, false);
    a.node('hideSpaceNames').checked = true; a.node('hideSpaceNames').dispatchEvent(new a.window.Event('change'));
    await Promise.all([a.controller.whenSaved(), b.input('spaceHeaderSize', 18)]);
    assert.deepEqual(shared.data[key], { ...compact, spaceHeaderSize: 18, hideSpaceNames: true });
    assert.equal(b.node('hideSpaceNames').checked, true); assert.equal(sidebar.documentElement.dataset.hideSpaceNames, 'true');
    const c = await optionsFixture(shared.data);
    assert.equal(c.node('hideSpaceNames').checked, true);
    listener.dispose();
    const nextSidebar = initializeSidebarAppearance({ document: sidebar, api: shared.api }); await nextSidebar.ready;
    assert.equal(sidebar.documentElement.dataset.hideSpaceNames, 'true');
    a.node('resetSidebarAppearance').dispatchEvent(new a.window.Event('click')); await a.controller.whenSaved();
    assert.deepEqual(shared.data[key], defaults); assert.equal(b.node('hideSpaceNames').checked, false);
    assert.equal(sidebar.documentElement.dataset.hideSpaceNames, 'false');
    for (const f of [a, b, c]) f.controller.dispose(); nextSidebar.dispose();
});

test('icon-only CSS leaves headers and menus intact and preserves a 32px button target and visible fallback', async () => {
    const css = await readFile(new URL('../../styles.css', import.meta.url), 'utf8');
    assert.match(css, /data-hide-space-names="true"\] \.space-switcher-name \{ display: none; \}/);
    assert.match(css, /data-hide-space-names="true"\] \.space-switcher button \{ width: 32px; padding: 0; \}/);
    assert.match(css, /data-hide-space-names="true"\] \.space-switcher \.space-icon \{ margin-right: 0; \}/);
    assert.match(css, /data-hide-space-names="true"\] \.space-switcher \.space-icon-fallback \{ display: inline-block; \}/);
    assert.match(css, /\.space-switcher button:focus-visible \{ outline: 2px solid currentColor;/);
    assert.doesNotMatch(css, /data-hide-space-names="true"\][^{]*\.(?:space-name|space-header|space-context-menu)\s*\{/);
});
