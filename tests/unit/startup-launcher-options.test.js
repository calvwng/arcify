import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../../options.js', import.meta.url), 'utf8').replace(/^import .*;\s*$/gm, '');
test('startup setting restores and autosaves without replacing other sync data', async () => {
    const values = { startupLauncherEnabled: true, defaultSpaceName: 'Work', autoArchiveEnabled: true,
        autoArchiveIdleMinutes: 90, ordinaryFavoriteTabs: false, syncTabGroups: true, invertTabOrder: false,
        showAllOpenTabsInCollapsedFolders: true, debugLoggingEnabled: true,
        colorOverrides: null, unrelatedSavedSetting: 'keep me' };
    const listeners = {};
    const elements = Object.fromEntries(['startupLauncherEnabled', 'ordinaryFavoriteTabs', 'autoArchiveEnabled', 'syncTabGroups', 'invertTabOrder',
        'showAllOpenTabsInCollapsedFolders', 'debugLoggingEnabled'].map(id => [id, { checked: false, addEventListener(type, fn) { listeners[id] = fn; } }]));
    elements.defaultSpaceName = { value: '', innerHTML: '', appendChild() {}, addEventListener() {} };
    elements.autoArchiveIdleMinutes = { value: '', disabled: false, reportValidity: () => true, addEventListener() {} };
    elements.autoArchiveIdleMinutesContainer = { style: {} };
    const document = { getElementById: id => elements[id], addEventListener() {}, createElement: () => ({}),
        documentElement: { style: { setProperty() {}, removeProperty() {} } } };
    const context = { document, console, setTimeout, clearTimeout,
        Utils: { getSettings: async () => ({ ...values }) }, LocalStorage: { getSpaceNames: async () => ['Work'] },
        Logger: { log() {}, error() {} }, chrome: { storage: { sync: { set: async patch => Object.assign(values, patch) } },
            runtime: { sendMessage: async () => ({ success: true }) } } };
    runInNewContext(source, context);
    await context.restoreOptions();
    assert.equal(elements.startupLauncherEnabled.checked, true);
    context.setupAutoSave();
    assert.equal(typeof listeners.startupLauncherEnabled, 'function');
    elements.startupLauncherEnabled.checked = false;
    await listeners.startupLauncherEnabled();
    assert.deepEqual(values, { startupLauncherEnabled: false, defaultSpaceName: 'Work', autoArchiveEnabled: true,
        autoArchiveIdleMinutes: 90, ordinaryFavoriteTabs: false, syncTabGroups: true, invertTabOrder: false,
        showAllOpenTabsInCollapsedFolders: true, debugLoggingEnabled: true,
        colorOverrides: null, unrelatedSavedSetting: 'keep me' });
});
