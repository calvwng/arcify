import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import { Utils } from '../../utils.js';

const source = readFileSync(new URL('../../options.js', import.meta.url), 'utf8').replace(/^import .*;\s*$/gm, '');
function fixture(initial = {}) {
    const sync = { invertTabOrder: false, ...initial }, spaces = [{ id: 's', temporaryTabs: [1, 2], spaceBookmarks: [3, 4] }];
    const local = { spaces: structuredClone(spaces) }, events = [], listeners = {};
    globalThis.chrome = { storage: { onChanged: { addListener() {} },
        sync: { async get(defaults) { return { ...defaults, ...sync }; }, async set(patch) { events.push(['sync', structuredClone(patch)]); Object.assign(sync, patch); } },
        local: { async get(key) { return { [key]: structuredClone(local[key]) }; }, async set(patch) { events.push(['local', structuredClone(patch)]); Object.assign(local, patch); } }
    }, runtime: { sendMessage: async () => ({ success: true }) } };
    const controls = ['startupLauncherEnabled', 'ordinaryFavoriteTabs', 'autoArchiveEnabled', 'syncTabGroups', 'invertTabOrder',
        'todayNewTabsAtTop', 'showAllOpenTabsInCollapsedFolders', 'debugLoggingEnabled'];
    const elements = Object.fromEntries(controls.map(id => [id, { checked: false, addEventListener(type, fn) { listeners[id] = fn; } }]));
    elements.defaultSpaceName = { value: 'Home', innerHTML: '', appendChild() {}, addEventListener() {} };
    elements.autoArchiveIdleMinutes = { value: '360', disabled: false, reportValidity: () => true, addEventListener() {} };
    elements.autoArchiveIdleMinutesContainer = { style: {} };
    const document = { getElementById: id => elements[id], addEventListener() {}, createElement: () => ({}),
        documentElement: { style: { setProperty() {}, removeProperty() {} } } };
    const context = { document, console, setTimeout, clearTimeout, Utils,
        LocalStorage: { getSpaceNames: async () => ['Home'] }, Logger: { log() {}, error() {} }, chrome };
    runInNewContext(source, context);
    return { sync, local, spaces, events, listeners, elements, context };
}

test('Today placement defaults to top while the disabled saved-pin reversal stays disabled', async () => {
    const f = fixture();
    assert.equal(await Utils.getTodayNewTabsAtTop(), true);
    await f.context.restoreOptions();
    assert.equal(f.elements.todayNewTabsAtTop.checked, true);
    assert.equal(f.elements.invertTabOrder.checked, false);
    assert.deepEqual(f.local.todayOrderRepresentation, { version: 1, inverted: false });
    assert.deepEqual(f.local.spaces, f.spaces);
});

test('new placement toggle autosaves independently and does not reorder existing tabs or pins', async () => {
    const f = fixture();
    await f.context.restoreOptions(); f.context.setupAutoSave();
    assert.equal(typeof f.listeners.todayNewTabsAtTop, 'function');
    f.elements.todayNewTabsAtTop.checked = false;
    await f.listeners.todayNewTabsAtTop();
    assert.equal(f.sync.todayNewTabsAtTop, false); assert.equal(f.sync.invertTabOrder, false);
    assert.equal(await Utils.getTodayNewTabsAtTop(), false);
    assert.deepEqual(f.local.spaces, f.spaces);
    assert.deepEqual(f.local.todayOrderRepresentation, { version: 1, inverted: false });
    f.elements.invertTabOrder.checked = true;
    await f.listeners.invertTabOrder();
    assert.equal(f.sync.invertTabOrder, true); assert.equal(f.sync.todayNewTabsAtTop, false);
    assert.equal(await Utils.getTodayOrderInverted(), false);
    assert.deepEqual(f.local.spaces, f.spaces);
});

test('saving Settings before first restore freezes the old orientation before changing it', async () => {
    const f = fixture({ invertTabOrder: true });
    f.elements.invertTabOrder.checked = false; f.elements.todayNewTabsAtTop.checked = true;
    await f.context.saveOptions();
    assert.deepEqual(f.events.map(([area]) => area), ['local', 'sync']);
    assert.deepEqual(f.local.todayOrderRepresentation, { version: 1, inverted: true });
    assert.equal(f.sync.invertTabOrder, false);
    assert.equal(await Utils.getTodayOrderInverted(), true);
});

test('settings helpers never couple future placement to saved-pin reversal', async () => {
    const f = fixture();
    await Utils.setInvertTabOrder(true);
    await Utils.setTodayNewTabsAtTop(false);
    assert.equal(await Utils.getInvertTabOrder(), true);
    assert.equal(await Utils.getTodayOrderInverted(), false);
    assert.equal(await Utils.getTodayNewTabsAtTop(), false);
    assert.deepEqual(f.local.spaces, f.spaces);
});

test('Today setting has an accessible switch, label, and prospective-placement description', () => {
    const { document } = parseHTML(readFileSync(new URL('../../options.html', import.meta.url), 'utf8'));
    const input = document.getElementById('todayNewTabsAtTop');
    assert.equal(input.type, 'checkbox'); assert.equal(input.getAttribute('role'), 'switch');
    assert.match(document.querySelector('label.options-label[for="todayNewTabsAtTop"]').textContent, /Today tabs at the top/);
    const description = document.getElementById(input.getAttribute('aria-describedby')).textContent;
    assert.match(description, /below \+ New Tab/); assert.match(description, /directly below it either way/);
    assert.match(description, /Existing tabs, saved pins, and folders stay in place/);
    assert.equal(document.querySelector('label.options-label[for="invertTabOrder"]').textContent, 'Reverse saved pin and folder order');
});
