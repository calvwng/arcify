/** CI-only real-input Space-menu proof. Importing this module never launches a browser. */
import assert from 'node:assert/strict';
import { tabToSelector } from './paired-chrome-sidebar-appearance.mjs';
import { finishBookmarkFixture } from './paired-chrome-bookmark-selection.mjs';
import { clickFreshResult } from './paired-chrome-ui.mjs';
import { randomBytes } from 'node:crypto';
import { exerciseSpaceEmojiInput, exerciseSpaceIconOnlySwitcher, assertIconOnlySpaceActivated, replaceSpaceEmojiWithInput, clickUnobscuredSpaceChip } from './paired-chrome-space-icon-input.mjs';
import { exerciseExternalMenuDismissal, readMenuPreservedState } from './paired-chrome-menu-focus.mjs';

export function assertSpaceContextFixtureEnvironment(env = process.env, uid = process.getuid?.()) {
    assert.equal(env.GITHUB_ACTIONS, 'true', 'The real Space-menu fixture is restricted to GitHub Actions.');
    assert.equal(env.CI, 'true', 'The real Space-menu fixture requires its dedicated CI runner.');
    assert.notEqual(uid, 0, 'The Space-menu fixture never disables the native Chrome sandbox for root.');
}
export async function captureRequiredSpaceScreenshot(screenshot, page, label) {
    const captured = await screenshot(page, label, true, { fullPage: false });
    assert(captured, `Required screenshot evidence is missing: ${label}`);
    assert.match(captured.filename, /\.png$/); assert.equal(captured.label, label);
    assert.equal(typeof captured.url, 'string'); assert(captured.url.length > 0);
    assert(Number.isFinite(Date.parse(captured.capturedAt)), 'Screenshot evidence must include its capture timestamp.');
    return captured;
}

// Passive diagnostics only: no focus, input, resize or surface restoration.
export function observeSpaceMenuEvents() {
    const events = [], snapshot = type => ({ type, at: Date.now(), visibility: document.visibilityState,
        focused: document.hasFocus(), width: innerWidth, height: innerHeight,
        menuPresent: Boolean(document.querySelector('.space-context-menu')) });
    const record = event => { if (events.length < 100) events.push(snapshot(event.type)); };
    for (const name of ['blur', 'focus', 'resize']) window.addEventListener(name, record);
    document.addEventListener('visibilitychange', record);
    globalThis.__spaceMenuCaptureObservation = { read: () => ({ ...snapshot('read'), events: [...events] }),
        stop: () => { for (const name of ['blur', 'focus', 'resize']) window.removeEventListener(name, record);
            document.removeEventListener('visibilitychange', record); } };
}
export async function captureStableSpaceMenu({ observe, capture, foreground, record, name }) {
    const stages = [];
    const checkpoint = async phase => {
        const state = await observe(); stages.push({ phase, ...state });
        await record({ phase: 'space-menu-capture-observation', stages });
        assertSpaceContextMenu(state.surface, name);
    };
    await checkpoint('before-foreground');
    await foreground(async () => {
        await checkpoint('before-screenshot');
        let primaryError;
        try { await capture(); } catch (error) { primaryError = error; }
        try { await checkpoint('after-screenshot'); } catch (error) { primaryError ||= error; }
        if (primaryError) throw primaryError;
    });
    return stages;
}

export async function rightClickFreshSpaceTrigger(page, selector, record = async () => {}) {
    // Reuse the bounded, stack-verified pre-input guard. Preserve the exact
    // selector and right button; never replay a successful or uncertain click.
    await clickFreshResult(async timeout => {
        const element = await page.waitForSelector(selector, { visible: true, timeout });
        return { click: () => element.click({ button: 'right' }), dispose: () => element.dispose() };
    }, observation => record({ phase: 'space-context-trigger-input', selector, ...observation }));
}

export const SPACE_COLOR_IDS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan'];
export const SPACE_MENU_ITEMS = ['Change Space Icon', 'Rename', 'Theme Color', 'New Folder', 'Delete'];
export const SPACE_PICKER_IDS = ['none', 'home', 'work', 'star', 'heart', 'book', 'code', 'idea', 'rocket', 'globe', 'leaf', 'music', 'art', 'camera', 'coffee', 'travel', 'fitness', 'science', 'game', 'shopping', 'sun'];
const flatten = nodes => nodes.flatMap(node => [node, ...flatten(node.children || [])]);
const bounds = state => {
    const { rect, viewport } = state;
    for (const value of [...Object.values(rect), ...Object.values(viewport)]) assert(Number.isFinite(value));
    assert(rect.width > 0 && rect.height > 0);
    assert(rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= viewport.width + 1 && rect.y + rect.height <= viewport.height + 1,
        'The actual painted surface must fit the narrow viewport.');
};

export function assertSpaceContextMenu(state, name) {
    assert(state, 'The exact Space menu must remain present before input or capture.');
    assert.equal(state.role, 'menu'); assert.equal(state.name, `Space options: ${name}`);
    assert.equal(state.visible, true); assert.equal(state.focusInside, true); bounds(state);
    assert.deepEqual(state.items.map(item => item.label), SPACE_MENU_ITEMS);
    for (const item of state.items) { assert.equal(item.role, 'menuitem'); assert.equal(item.tag, 'BUTTON'); assert.equal(item.disabled, false); }
    return state;
}
export function assertSpaceIconPicker(state, name, selected = 'none') {
    assert.equal(state.role, 'dialog'); assert.equal(state.modal, 'true'); assert.equal(state.title, `Change Space Icon: ${name}`);
    assert.equal(state.visible, true); assert.equal(state.focusInside, true); bounds(state);
    assert.deepEqual(state.choices.map(choice => choice.id), SPACE_PICKER_IDS);
    assert.deepEqual(state.choices.filter(choice => choice.pressed === 'true').map(choice => choice.id), selected === null ? [] : [selected]);
    for (const choice of state.choices) { assert(choice.label); assert.equal(choice.tag, 'BUTTON'); assert.equal(choice.disabled, false); }
    assert.equal(state.submit, 'Save emoji');
    assert.equal(state.input?.label, 'Emoji'); assert.equal(state.input?.maxLength, -1); assert.equal(state.input?.disabled, false);
    assert.equal(state.cancel, 'Cancel'); return state;
}
export function assertSpaceColorPicker(state, name, selected) {
    assert.equal(state.role, 'dialog'); assert.equal(state.modal, 'true'); assert.equal(state.title, `Theme Color: ${name}`);
    assert.equal(state.visible, true); assert.equal(state.focusInside, true); bounds(state);
    assert.deepEqual(state.choices.map(choice => choice.id), SPACE_COLOR_IDS);
    assert.deepEqual(state.choices.filter(choice => choice.pressed === 'true').map(choice => choice.id), [selected]);
    for (const choice of state.choices) { assert(choice.label); assert.equal(choice.tag, 'BUTTON'); assert.equal(choice.disabled, false); }
    assert.equal(state.cancel, 'Cancel'); return state;
}
export function assertSpaceNameEditor(state, name, value, folder = false) {
    assert.equal(state.role, 'dialog'); assert.equal(state.modal, 'true');
    assert.equal(state.title, folder ? `New Folder in ${name}` : `Rename ${name}`);
    assert.equal(state.visible, true); assert.equal(state.focusInside, true); bounds(state);
    assert.deepEqual(state.input, { label: folder ? 'Folder name' : 'Space name', value, required: true, maxLength: 256, disabled: false });
    assert.equal(state.submit, folder ? 'Create Folder' : 'Save'); assert.equal(state.cancel, 'Cancel'); return state;
}
export function assertSpaceDetailsProjection(state, { spaceId, name, color, folder, requireVisibleTheme = false }) {
    assert.equal(state.spaceId, spaceId); assert.equal(state.headerCount, 1); assert.equal(state.chipCount, 1);
    assert.equal(state.headerName, name); assert.equal(state.headerColor, color);
    assert.equal(state.chipName, name); assert.equal(state.chipLabel, `Switch to space ${name}`);
    if (requireVisibleTheme) {
        assert.equal(state.activeSpaceId, spaceId); assert.equal(state.headerVisible, true);
        assert(state.expectedColor?.trim()); assert.equal(state.appliedColor, state.expectedColor);
    }
    if (folder) assert.deepEqual(state.folders.filter(item => item.id === folder.id), [{ id: folder.id, title: folder.title, visible: true }]);
    return state;
}
export function assertSpaceIconProjection(state, { spaceId, glyph, requireVisibleHeader = false }) {
    assert.equal(state.spaceId, spaceId); assert.equal(state.headerCount, 1); assert.equal(state.chipCount, 1);
    assert.equal(state.headerText, glyph || ''); assert.equal(state.headerHidden, !glyph);
    assert.equal(state.chipText, glyph || null);
    assert.equal(state.headerAriaHidden, 'true');
    if (glyph) assert.equal(state.chipAriaHidden, 'true');
    if (requireVisibleHeader) { assert.equal(state.headerVisible, true); assert.equal(state.activeSpaceId, spaceId); }
    return state;
}
export function assertSpaceContextUnchanged(before, after) {
    assert.deepEqual(after, before, 'Opening/cancelling a Space menu or reloading must preserve all captured durable and live state.');
}
export function assertSpaceMetadataSaved(before, after, { spaceId, changes }) {
    assert(Object.keys(changes).length > 0 && Object.keys(changes).every(key => ['icon', 'name', 'color'].includes(key)));
    const expected = structuredClone(before), matches = expected.spaces.filter(space => space.id === spaceId);
    assert.equal(matches.length, 1, 'The exact target Space must exist before editing.');
    const target = matches[0], entry = expected.registry[target.bookmarkFolderId];
    assert.equal(entry?.spaceUuid, spaceId, 'The durable registry must already map the target folder to its exact UUID.');
    Object.assign(target, changes); Object.assign(entry, changes);
    if (changes.name !== undefined) {
        const folders = flatten(expected.bookmarks).filter(node => node.id === target.bookmarkFolderId);
        assert.equal(folders.length, 1); assert.equal(folders[0].url, undefined); folders[0].title = changes.name;
    }
    assert.deepEqual(after, expected, 'Metadata edits may change only the clicked Space, its matching registry fields and renamed backing folder title.');
    return { spaceId, bookmarkFolderId: target.bookmarkFolderId, changes };
}
export function assertSpaceIconSaved(before, after, { spaceId, icon }) {
    assertSpaceMetadataSaved(before, after, { spaceId, changes: { icon } });
    return { spaceId, bookmarkFolderId: before.spaces.find(space => space.id === spaceId).bookmarkFolderId, icon };
}
export function assertSpaceFolderCreated(before, after, { spaceId, title }) {
    const target = before.spaces.find(space => space.id === spaceId);
    assert(target); assert.equal(before.registry[target.bookmarkFolderId]?.spaceUuid, spaceId);
    const oldIds = new Set(flatten(before.bookmarks).map(node => node.id));
    const added = flatten(after.bookmarks).filter(node => !oldIds.has(node.id));
    assert.equal(added.length, 1, 'Create Folder must append exactly one new bookmark folder.');
    const created = added[0], expected = structuredClone(before);
    const parent = flatten(expected.bookmarks).find(node => node.id === target.bookmarkFolderId);
    assert(parent && !parent.url);
    assert.deepEqual(created, { id: created.id, parentId: target.bookmarkFolderId, index: (parent.children || []).length, title, children: [] });
    assert.equal(typeof created.id, 'string'); assert(created.id.length > 0);
    parent.children ||= []; parent.children.push(structuredClone(created));
    assert.deepEqual(after, expected, 'New Folder may only append a folder to the clicked Space backing root; all other durable and live state must survive.');
    return created;
}
// Caller foregrounds the document first. The baseline must precede every input,
// including Tab traversal, rather than accepting accidental activation as baseline.
export async function observeSpaceContextOpening({ read, open, inspect, inactive }) {
    const before = await read();
    if (inactive) assert.notEqual(before.activeSpaces[inactive.windowId], inactive.spaceId, 'The edited Space must be inactive in the acting window.');
    await open();
    const surface = await inspect(), after = await read();
    assertSpaceContextUnchanged(before, after);
    return { before, after, surface };
}
export function assertSpaceDeleteWarning(message, name) {
    assert(message.includes(`Delete Space “${name}”?`));
    assert.match(message, /all saved bookmarks and folders.*backing bookmark subtree/);
    assert.match(message, /owned tabs across all windows/); assert.match(message, /Shared saved Favorites survive/);
}

// Install before genuine input, dismiss exactly once, and never retry uncertain input.
export async function cancelSpaceDeleteWithInput(page, name, click, { timeoutMs = 15_000 } = {}) {
    let timer, handler;
    const result = new Promise((resolve, reject) => {
        handler = async dialog => {
            let invalid, message;
            try { assert.equal(dialog.type(), 'confirm'); message = dialog.message(); assertSpaceDeleteWarning(message, name); }
            catch (error) { invalid = error; }
            try { await dialog.dismiss(); }
            catch (error) { reject(error); return; }
            if (invalid) reject(invalid); else resolve(message);
        };
        page.once('dialog', handler);
    });
    const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Space deletion confirmation did not appear or its input/dismissal did not complete.')), timeoutMs);
    });
    // Both promises are observed immediately. Either failure must win even when
    // the other never resolves, and success requires both input and dismissal.
    const completed = Promise.all([Promise.resolve().then(click), result]).then(([, message]) => message);
    try { return await Promise.race([completed, deadline]); }
    finally { clearTimeout(timer); page.off('dialog', handler); }

}

// These readers execute in the actual extension document. They observe only.
export function readSpaceContextSurface() {
    const menu = document.querySelector('.space-context-menu'), dialog = document.querySelector('.space-editor');
    const node = dialog || menu;
    if (!node) return null;
    const { x, y, width, height } = node.getBoundingClientRect();
    const visible = Boolean(node.getClientRects().length && getComputedStyle(node).visibility === 'visible' && getComputedStyle(node).display !== 'none');
    return { role: node.getAttribute('role'), name: node.getAttribute('aria-label'), modal: node.getAttribute('aria-modal'),
        title: node.querySelector('h2')?.textContent, visible, focusInside: node.contains(document.activeElement),
        rect: { x, y, width, height }, viewport: { width: innerWidth, height: innerHeight },
        items: [...node.querySelectorAll('[role="menuitem"]')].map(item => ({ label: item.textContent, role: item.getAttribute('role'), tag: item.tagName, disabled: item.disabled })),
        choices: [...node.querySelectorAll('[data-choice]')].map(item => ({ id: item.dataset.choice, label: item.textContent, pressed: item.getAttribute('aria-pressed'), tag: item.tagName, disabled: item.disabled })),
        input: node.querySelector('input') ? { label: node.querySelector('label')?.firstChild?.textContent, value: node.querySelector('input').value, required: node.querySelector('input').required, maxLength: node.querySelector('input').maxLength, disabled: node.querySelector('input').disabled } : null,
        submit: node.querySelector('button[type="submit"]')?.textContent,
        cancel: [...node.querySelectorAll('button')].find(item => item.textContent === 'Cancel')?.textContent };
}
export function readSpaceIconProjection(spaceId) {
    const headers = [...document.querySelectorAll('.space[data-space-id]')].filter(node => node.dataset.spaceId === spaceId);
    const chips = [...document.querySelectorAll('#spaceSwitcher button[data-space-id]')].filter(node => node.dataset.spaceId === spaceId);
    const header = headers[0]?.querySelector('.space-icon'), chip = chips[0]?.querySelector('.space-icon');
    return { spaceId, headerCount: headers.length, chipCount: chips.length, headerText: header?.textContent,
        headerHidden: header?.hidden, headerAriaHidden: header?.getAttribute('aria-hidden'), chipText: chip?.textContent || null,
        chipAriaHidden: chip?.getAttribute('aria-hidden') || null,
        headerVisible: Boolean(header && header.getClientRects().length && !header.hidden && getComputedStyle(header).visibility === 'visible'),
        activeSpaceId: document.querySelector('.space.active')?.dataset.spaceId };
}

export function readSpaceFolderScreenshot({ spaceId, folderId }) {
    const space = [...document.querySelectorAll('.space[data-space-id]')].find(node => node.dataset.spaceId === spaceId);
    const matches = [...(space?.querySelectorAll('.folder[data-bookmark-id]') || [])].filter(node => node.dataset.bookmarkId === folderId);
    const header = matches[0]?.querySelector(':scope > .folder-header');
    if (!header) return null;
    const { x, y, width, height } = header.getBoundingClientRect();
    // The folder clips its rounded 8px corners. Probe each edge midpoint and
    // center instead of a point outside that legitimate painted shape.
    const insetX = Math.min(2, width / 4), insetY = Math.min(2, height / 4);
    const points = [[x + width / 2, y + insetY], [x + width / 2, y + height - insetY],
        [x + insetX, y + height / 2], [x + width - insetX, y + height / 2], [x + width / 2, y + height / 2]];
    const hits = points.map(([px, py]) => { const hit = document.elementFromPoint(px, py);
        return { x: px, y: py, inside: header.contains(hit), tag: hit?.tagName || null, className: hit?.getAttribute?.('class') || null }; });
    return { spaceId, folderId, matches: matches.length, title: header.querySelector('.folder-title')?.textContent,
        activeSpaceId: document.querySelector('.space.active')?.dataset.spaceId,
        rect: { x, y, width, height }, viewport: { width: innerWidth, height: innerHeight },
        hits, unobscured: hits.every(hit => hit.inside) };
}
export function assertSpaceFolderScreenshot(state, { spaceId, folder }) {
    assert(state, 'The exact created folder header must exist for its screenshot.');
    assert.equal(state.spaceId, spaceId); assert.equal(state.activeSpaceId, spaceId);
    assert.equal(state.folderId, folder.id); assert.equal(state.matches, 1); assert.equal(state.title, folder.title);
    bounds(state); assert.equal(state.unobscured, true, 'The folder-header edge midpoints and center must hit the actual visible row.');
    return state;
}

export function readSpaceDetailsProjection(spaceId) {
    const headers = [...document.querySelectorAll('.space[data-space-id]')].filter(node => node.dataset.spaceId === spaceId);
    const chips = [...document.querySelectorAll('#spaceSwitcher button[data-space-id]')].filter(node => node.dataset.spaceId === spaceId);
    const header = headers[0], chip = chips[0], color = header?.querySelector('.space-color-select')?.value;
    const container = document.querySelector('#sidebar-container');
    return { spaceId, headerCount: headers.length, chipCount: chips.length, headerName: header?.querySelector('.space-name')?.value,
        headerColor: color, activeSpaceId: document.querySelector('.space.active')?.dataset.spaceId,
        headerVisible: Boolean(header?.getClientRects().length && getComputedStyle(header).visibility === 'visible'),
        expectedColor: getComputedStyle(document.documentElement).getPropertyValue(`--chrome-${color}-color`).trim(),
        appliedColor: container ? getComputedStyle(container).getPropertyValue('--space-bg-color').trim() : null, chipName: chip?.lastElementChild?.textContent, chipLabel: chip?.getAttribute('aria-label'),
        folders: [...(header?.querySelectorAll('.folder[data-bookmark-id]') || [])].map(node => ({ id: node.dataset.bookmarkId, title: node.querySelector('.folder-title')?.textContent,
            visible: Boolean(node.getClientRects().length && getComputedStyle(node).visibility === 'visible') })) };
}

// Fixture setup/cleanup uses synthetic, exact-owned data; every feature action
// below uses real mouse/keyboard input. No DOM value assignment or synthetic events.
export async function exerciseSpaceContextBasics({ apiPage, newTabPage, pageForUrl, ui, screenshot, screenshotBytes, snapshot, poll, fixture, arcifyId, record = async () => {} }) {
    assertSpaceContextFixtureEnvironment();
    for (const fn of [newTabPage, pageForUrl, ui, screenshot, screenshotBytes, snapshot, poll]) assert.equal(typeof fn, 'function');
    const initial = await snapshot();
    assert(initial.spaces[0]?.bookmarkFolderId);
    const original = await apiPage.evaluate(async () => ({
        activeSpaces: (await chrome.storage.session.get('activeSpaces')).activeSpaces || {},
        activeTabs: (await chrome.tabs.query({ active: true })).map(tab => ({ id: tab.id, windowId: tab.windowId }))
    }));
    let target, seedFolder, sidebarA, sidebarB, outsideWindow, outsidePage, primaryError;
    const seededTabs = [], evidence = { realMouseAndKeyboard: true, nativePanel: false, screenshots: [] };
    const capture = async (page, label) => {
        const result = await captureRequiredSpaceScreenshot(screenshot, page, label); evidence.screenshots.push(result); return result;
    };
    const chip = id => `#spaceSwitcher button[data-space-id="${id}"]`;
    const read = () => apiPage.evaluate(async () => {
        const bookmark = ({ id, parentId, index, title, url, children }) => ({ id, parentId, index, title, ...(url === undefined ? {} : { url }), ...(children ? { children: children.map(bookmark) } : {}) });
        const local = await chrome.storage.local.get(['spaces', 'spaceRegistry', 'persistentFavorites', 'pinnedTabStatesById', 'sidebarAppearance']);
        return { appearance: local.sidebarAppearance ?? null, spaces: local.spaces, registry: local.spaceRegistry || {}, favorites: local.persistentFavorites || [], bindings: local.pinnedTabStatesById || {},
            activeSpaces: (await chrome.storage.session.get('activeSpaces')).activeSpaces || {}, bookmarks: (await chrome.bookmarks.getTree()).map(bookmark),
            tabs: (await chrome.tabs.query({})).map(({ id, windowId, index, url, pinned, active, groupId }) => ({ id, windowId, index, url, pinned, active, groupId })).sort((a, b) => a.id - b.id) };
    });
    const inactiveTarget = page => ({ spaceId: target.id, windowId: page === sidebarA?.page ? fixture.windowA : fixture.windowB });
    const openMenu = async (page, selector, name, keyboard = false) => ui(page, `Open ${name} Space menu with ${keyboard ? 'keyboard' : 'mouse'}`, () => observeSpaceContextOpening({
        read, inactive: selector === chip(target.id) ? inactiveTarget(page) : null,
        open: async () => {
            if (keyboard) {
                await tabToSelector(page, selector, 300);
                await page.keyboard.down('Shift');
                try { await page.keyboard.press('F10'); } finally { await page.keyboard.up('Shift'); }
            } else await rightClickFreshSpaceTrigger(page, selector, record);
            await page.waitForSelector('.space-context-menu', { visible: true });
        },
        inspect: async () => assertSpaceContextMenu(await page.evaluate(readSpaceContextSurface), name)
    }));
    const choose = async (page, label) => {
        const items = await page.$$('[role="menuitem"]');
        try {
            const labels = await Promise.all(items.map(item => item.evaluate(node => node.textContent)));
            assert.equal(labels.filter(text => text === label).length, 1);
            await items[labels.indexOf(label)].click();
        } finally { await Promise.all(items.map(item => item.dispose())); }
    };
    const openEditor = (page, label, inspect) => ui(page, `Open ${label} editor on inactive Space`, () => observeSpaceContextOpening({
        read, inactive: inactiveTarget(page),
        open: async () => { await choose(page, label); await page.waitForSelector('.space-editor', { visible: true }); },
        inspect: async () => inspect(await page.evaluate(readSpaceContextSurface))
    }));
    const picker = (page, selected) => openEditor(page, 'Change Space Icon', state => assertSpaceIconPicker(state, target.name, selected));
    const replaceName = async (page, text) => {
        await page.click('.space-editor input');
        await page.keyboard.down('Control');
        try { await page.keyboard.press('KeyA'); } finally { await page.keyboard.up('Control'); }
        await page.keyboard.press('Backspace'); await page.keyboard.type(text);
    };
    const awaitEditorClosed = page => page.waitForFunction(() => !document.querySelector('.space-editor'), { polling: 50 });
    const details = (page, folder, requireVisibleTheme = false) => poll(() => page.evaluate(readSpaceDetailsProjection, target.id), state => {
        try { assertSpaceDetailsProjection(state, { ...target, spaceId: target.id, folder, requireVisibleTheme }); return true; } catch { return false; }
    }, 'exact Space name, color and saved folder projection');
    const projection = (page, glyph) => poll(() => page.evaluate(readSpaceIconProjection, target.id), state => {
        try { assertSpaceIconProjection(state, { spaceId: target.id, glyph }); return true; } catch { return false; }
    }, 'matching header and switcher icon projection');
    const selectIcon = async (page, value, glyph) => {
        const before = await read();
        await ui(page, `Choose Space icon ${value || 'none'}`, () => page.click(`[data-choice="${value || 'none'}"]`));
        await awaitEditorClosed(page);
        const after = await poll(read, state => state.spaces.find(space => space.id === target.id)?.icon === value && state.registry[target.bookmarkFolderId]?.icon === value, 'exact icon persisted to Space and registry');
        const proof = assertSpaceIconSaved(before, after, { spaceId: target.id, icon: value });
        return { before, after, proof, projection: await projection(page, glyph) };
    };
    try {
        const outsideUrl = `${fixture.base}/tab-menu/${randomBytes(16).toString('hex')}/outside`;
        outsideWindow = await apiPage.evaluate(url => chrome.windows.create({ url, type: 'normal', focused: false }), outsideUrl);
        assert(![fixture.windowA, fixture.windowB].includes(outsideWindow.id));
        outsidePage = await pageForUrl(outsideUrl); await outsidePage.waitForSelector('#page-state');
        await ui(outsidePage, 'Initialize the disposable external window before identity baselines', () => outsidePage.click('#page-state'));
        seedFolder = await apiPage.evaluate(async ({ baseFolderId }) => {
            const [base] = await chrome.bookmarks.get(baseFolderId);
            if (!base?.parentId) throw new Error('Fixture requires an existing Arcify bookmark root.');
            return chrome.bookmarks.create({ parentId: base.parentId, title: `CI Space Menu ${crypto.randomUUID().slice(0, 8)}` });
        }, { baseFolderId: initial.spaces[0].bookmarkFolderId });
        target = await apiPage.evaluate(async folderId => {
            const child = await chrome.bookmarks.create({ parentId: folderId, title: 'Nested saved folder' });
            await chrome.bookmarks.create({ parentId: child.id, title: 'Saved link retained on Cancel', url: 'https://example.test/space-menu-cancel' });
            const response = await chrome.runtime.sendMessage({ type: 'spaceStore', action: 'get' });
            if (!response.success) throw new Error(response.error);
            const space = response.spaces.find(space => space.bookmarkFolderId === folderId);
            if (!space) throw new Error('Fixture Space was not discovered.');
            return space;
        }, seedFolder.id);
        for (const windowId of [fixture.windowA, fixture.windowB]) {
            const tab = await apiPage.evaluate(options => chrome.tabs.create(options),
                { windowId, url: `${fixture.base}/alpha?space-menu=${windowId}`, active: false });
            seededTabs.push(tab.id); // Retain the creation receipt before assignment can fail.
            await apiPage.evaluate(async ({ spaceId, tabId }) => {
                const result = await chrome.runtime.sendMessage({ type: 'spaceStore', action: 'assign', spaceId, tabId });
                if (!result.success) throw new Error(result.error);
            }, { spaceId: target.id, tabId: tab.id });
        }
        await poll(() => apiPage.evaluate(ids => Promise.all(ids.map(id => chrome.tabs.get(id))), seededTabs), tabs => tabs.every(tab => tab.status === 'complete'), 'both disposable Space tabs loaded');
        sidebarA = await newTabPage(`chrome-extension://${arcifyId}/sidebar.html`, fixture.windowA);
        const page = sidebarA.page;
        await page.setViewport({ width: 224, height: 600, deviceScaleFactor: 1 });
        await page.waitForSelector(chip(target.id));
        const active = await page.$eval('.space.active', node => ({ id: node.dataset.spaceId, name: node.querySelector('.space-name').value }));
        assert.notEqual(active.id, target.id, 'The edited Space must initially be inactive.');
        evidence.headerMenu = await openMenu(page, '.space.active .space-name', active.name);
        const beforeHeaderCancel = evidence.headerMenu.before;
        await ui(page, 'Cancel header Space menu with Escape', () => page.keyboard.press('Escape'));
        assertSpaceContextUnchanged(beforeHeaderCancel, await read());
        assert.equal(await page.$eval('.space.active .space-name', node => node === document.activeElement), true);
        evidence.outsideOpen = await openMenu(page, chip(target.id), target.name);
        evidence.outsidePreservedBefore = await apiPage.evaluate(readMenuPreservedState);
        evidence.outsideFocus = await exerciseExternalMenuDismissal({ sidebar: page, destination: outsidePage,
            menuSelector: '.space-context-menu', label: 'inactive-space', ui, screenshot, poll, record });
        assertSpaceContextUnchanged(evidence.outsideOpen.before, await read());
        evidence.outsidePreservedAfter = await apiPage.evaluate(readMenuPreservedState);
        assert.deepEqual(evidence.outsidePreservedAfter, evidence.outsidePreservedBefore);
        // Reopen through genuine keyboard input and choose the icon picker. Its
        // existing Cancel, later Save and exact-state assertions prove the menu
        // interaction gate is released rather than only hiding stale pixels.
        evidence.switcherMenu = await openMenu(page, chip(target.id), target.name, true);
        evidence.picker = await ui(page, 'Choose Change Space Icon with genuine Enter after outside dismissal', () => observeSpaceContextOpening({
            read, inactive: inactiveTarget(page),
            open: async () => { await page.keyboard.press('Home'); await page.keyboard.press('Enter'); await page.waitForSelector('.space-editor', { visible: true }); },
            inspect: async () => assertSpaceIconPicker(await page.evaluate(readSpaceContextSurface), target.name, 'none')
        }));
        await ui(page, 'Verify real Tab wrap in the icon dialog', async () => {
            await tabToSelector(page, '.space-editor > button');
            await page.keyboard.press('Tab');
            assert.equal(await page.$eval('.space-emoji-form input', node => node === document.activeElement), true);
            await page.keyboard.press('Tab');
            assert.equal(await page.$eval('.space-emoji-form button[type="submit"]', node => node === document.activeElement), true);
            await page.keyboard.press('Tab');
            assert.equal(await page.$eval('[data-choice="none"]', node => node === document.activeElement), true);
            await tabToSelector(page, '.space-emoji-form input', 120, { backward: true });
            await page.keyboard.down('Shift');
            try { await page.keyboard.press('Tab'); } finally { await page.keyboard.up('Shift'); }
            assert.equal(await page.$eval('.space-editor > button', node => node === document.activeElement), true);
            await capture(page, 'space-context-icon-picker-narrow-keyboard-focus');
        });
        await ui(page, 'Cancel the icon picker without changing its inactive Space', () => page.click('.space-editor > button'));
        await awaitEditorClosed(page);
        evidence.iconCancelled = { before: evidence.picker.before, after: await read() };
        assertSpaceContextUnchanged(evidence.iconCancelled.before, evidence.iconCancelled.after);
        assert.equal(await page.$eval(chip(target.id), node => node === document.activeElement), true);
        await openMenu(page, chip(target.id), target.name); await picker(page, 'none');
        evidence.saved = await selectIcon(page, 'rocket', '🚀');
        assert.equal(await page.$eval(chip(target.id), node => node === document.activeElement), true);
        const beforeReload = await read();
        await ui(page, 'Reload sidebar with saved Space icon', () => page.reload({ waitUntil: 'domcontentloaded' }));
        evidence.reload = await projection(page, '🚀'); assertSpaceContextUnchanged(beforeReload, await read());
        await ui(page, 'Capture restored inactive Space icon', () => capture(page, 'space-context-icon-survives-sidebar-reload'));
        evidence.emojiInput = await exerciseSpaceEmojiInput({ page, target, ui, read,
            open: async () => {
                const icon = (await read()).spaces.find(space => space.id === target.id).icon;
                await openMenu(page, chip(target.id), target.name, true);
                await picker(page, SPACE_PICKER_IDS.includes(icon) ? icon : icon ? null : 'none');
            }, closed: () => awaitEditorClosed(page), saveProof: assertSpaceIconSaved, unchanged: assertSpaceContextUnchanged,
            projection: glyph => projection(page, glyph), capture, poll, record });
        await openMenu(page, chip(target.id), target.name); await picker(page, null);
        evidence.presetAfterCustom = await selectIcon(page, 'rocket', '🚀');
        // Genuine Rename, Theme Color and New Folder edits target the inactive
        // UUID. The validators compare the entire pre-action durable/live state.
        await openMenu(page, chip(target.id), target.name, true);
        evidence.renameEditor = await openEditor(page, 'Rename', state => assertSpaceNameEditor(state, target.name, target.name));
        const renamed = `${target.name} Renamed`, beforeRename = await read();
        await ui(page, 'Rename the exact inactive Space with keyboard input', async () => {
            await replaceName(page, renamed);
            evidence.renameEntered = assertSpaceNameEditor(await page.evaluate(readSpaceContextSurface), target.name, renamed);
            await capture(page, 'space-context-rename-inactive-target'); await page.keyboard.press('Enter');
        });
        await awaitEditorClosed(page);
        const afterRename = await poll(read, state => state.spaces.find(space => space.id === target.id)?.name === renamed && state.registry[target.bookmarkFolderId]?.name === renamed, 'exact inactive Space renamed');
        evidence.renamed = { before: beforeRename, after: afterRename, proof: assertSpaceMetadataSaved(beforeRename, afterRename, { spaceId: target.id, changes: { name: renamed } }) };
        target.name = renamed; await details(page);
        assert.equal(await page.$eval(chip(target.id), node => node === document.activeElement), true);
        await ui(page, 'Capture saved inactive Space name', () => capture(page, 'space-context-renamed-inactive-switcher'));

        await openMenu(page, chip(target.id), target.name);
        evidence.colorEditor = await openEditor(page, 'Theme Color', state => assertSpaceColorPicker(state, target.name, target.color));
        const color = target.color === 'purple' ? 'cyan' : 'purple', beforeColor = await read();
        await ui(page, 'Choose a basic color on the exact inactive Space', () => page.click(`[data-choice="${color}"]`));
        await awaitEditorClosed(page);
        const afterColor = await poll(read, state => state.spaces.find(space => space.id === target.id)?.color === color && state.registry[target.bookmarkFolderId]?.color === color, 'exact inactive Space color saved');
        evidence.colored = { before: beforeColor, after: afterColor, proof: assertSpaceMetadataSaved(beforeColor, afterColor, { spaceId: target.id, changes: { color } }) };
        target.color = color; await details(page);
        assert.equal(await page.$eval(chip(target.id), node => node === document.activeElement), true);
        await openMenu(page, chip(target.id), target.name);
        evidence.savedColorEditor = await openEditor(page, 'Theme Color', state => assertSpaceColorPicker(state, target.name, color));
        await ui(page, 'Capture all eight colors and saved selection', async () => {
            await capture(page, 'space-context-eight-colors-saved-selection'); await page.keyboard.press('Escape');
        });
        assertSpaceContextUnchanged(evidence.savedColorEditor.before, await read());

        await openMenu(page, chip(target.id), target.name, true);
        evidence.folderEditor = await openEditor(page, 'New Folder', state => assertSpaceNameEditor(state, target.name, 'Untitled', true));
        const title = 'Created through Space menu', beforeFolder = await read();
        await ui(page, 'Create a folder in the exact inactive Space with real input', async () => {
            await replaceName(page, title);
            evidence.folderEntered = assertSpaceNameEditor(await page.evaluate(readSpaceContextSurface), target.name, title, true);
            await capture(page, 'space-context-new-folder-inactive-target'); await page.click('.space-editor button[type="submit"]');
        });
        await awaitEditorClosed(page);
        const oldBookmarkIds = new Set(flatten(beforeFolder.bookmarks).map(node => node.id));
        const afterFolder = await poll(read, state => flatten(state.bookmarks).some(node => !oldBookmarkIds.has(node.id) && node.parentId === target.bookmarkFolderId && node.title === title), 'new folder in exact inactive Space root');
        evidence.folderCreated = { before: beforeFolder, after: afterFolder, folder: assertSpaceFolderCreated(beforeFolder, afterFolder, { spaceId: target.id, title }) };
        assert.equal(await page.$eval(chip(target.id), node => node === document.activeElement), true);
        const beforeDetailsReload = await read();
        await ui(page, 'Reload sidebar after inactive Space basic edits', () => page.reload({ waitUntil: 'domcontentloaded' }));
        evidence.detailsReload = await details(page); assertSpaceContextUnchanged(beforeDetailsReload, await read());

        sidebarB = await newTabPage(`chrome-extension://${arcifyId}/sidebar.html`, fixture.windowB);
        await sidebarB.page.setViewport({ width: 224, height: 600, deviceScaleFactor: 1 });
        await sidebarB.page.waitForSelector(chip(target.id));
        evidence.secondWindowBefore = await projection(sidebarB.page, '🚀');
        evidence.secondWindowDetails = await details(sidebarB.page);
        await openMenu(sidebarB.page, chip(target.id), target.name, true);
        await picker(sidebarB.page, 'rocket');
        evidence.crossWindowSave = await selectIcon(sidebarB.page, 'star', '⭐');
        // Sidebar storage listeners refresh even while hidden; this passive read
        // deliberately does not foreground it or synthesize a visibility event.
        evidence.crossWindowProjection = await projection(page, '⭐');
        await openMenu(sidebarB.page, chip(target.id), target.name, true); await picker(sidebarB.page, 'star');
        const beforeCustomHidden = await read();
        evidence.customForIconOnly = await ui(sidebarB.page, 'Save a custom ZWJ icon before enabling icon-only mode', async () => {
            const entered = await replaceSpaceEmojiWithInput(sidebarB.page, '👩🏽‍💻', 'paste');
            await sidebarB.page.keyboard.press('Enter'); return entered;
        });
        await awaitEditorClosed(sidebarB.page);
        const afterCustomHidden = await poll(read, state => state.spaces.find(space => space.id === target.id)?.icon === '👩🏽‍💻' && state.registry[target.bookmarkFolderId]?.icon === '👩🏽‍💻', 'custom ZWJ saved before icon-only mode');
        evidence.customForIconOnlySaved = { before: beforeCustomHidden, after: afterCustomHidden, proof: assertSpaceIconSaved(beforeCustomHidden, afterCustomHidden, { spaceId: target.id, icon: '👩🏽‍💻' }) };
        await projection(page, '👩🏽‍💻'); await projection(sidebarB.page, '👩🏽‍💻');
        evidence.iconOnly = await exerciseSpaceIconOnlySwitcher({ apiPage, pages: [page, sidebarB.page],
            windowIds: [fixture.windowA, fixture.windowB], ui, read, unchanged: assertSpaceContextUnchanged,
            capture, screenshotBytes, poll, record, whileHidden: async () => {
                // Deliberate activation is separate from the inactive metadata tests above.
                const beforeIconOnlyActivation = await read();
                evidence.iconOnlySelectionInput = await ui(page, 'Show edited Space header using its chip', () =>
                    clickUnobscuredSpaceChip({ page, spaceId: target.id, read, unchanged: assertSpaceContextUnchanged, poll, capture, record }));
                await page.waitForFunction(id => document.querySelector('.space.active')?.dataset.spaceId === id, { polling: 50 }, target.id);
                await poll(() => apiPage.evaluate(windowId => chrome.tabs.query({ windowId, active: true }), fixture.windowA),
                    tabs => tabs[0]?.id === seededTabs[0], 'explicit Space activation reached its exact owned tab');
                const afterIconOnlyActivation = await poll(read, state => state.spaces.find(space => space.id === target.id)?.lastTab === seededTabs[0], 'selected icon-only Space remembers its exact owned tab');
                assertIconOnlySpaceActivated(beforeIconOnlyActivation, afterIconOnlyActivation, { spaceId: target.id, windowId: fixture.windowA, tabId: seededTabs[0] });
                evidence.iconOnlySelection = { before: beforeIconOnlyActivation, after: afterIconOnlyActivation };
                await ui(page, 'Capture the visible updated Space header and switcher', async () => {
                    evidence.visibleHeader = assertSpaceIconProjection(await page.evaluate(readSpaceIconProjection, target.id),
                        { spaceId: target.id, glyph: '👩🏽‍💻', requireVisibleHeader: true });
                    await capture(page, 'space-context-visible-header-and-switcher-icon');
                    const folder = evidence.folderCreated.folder, beforeFolderCapture = await read();
                    const folderHeader = await page.waitForSelector(`.space[data-space-id="${target.id}"] .folder[data-bookmark-id="${folder.id}"] > .folder-header`, { visible: true });
                    try { await folderHeader.scrollIntoView(); } finally { await folderHeader.dispose(); }
                    evidence.visibleCreatedFolder = await details(page, folder, true);
                    const inspectFolder = () => page.evaluate(readSpaceFolderScreenshot, { spaceId: target.id, folderId: folder.id });
                    evidence.createdFolderScreenshotBefore = await inspectFolder();
                    await record({ phase: 'space-created-folder-before-capture', state: evidence.createdFolderScreenshotBefore });
                    // Preserve the actual pixels and geometry even when a paint guard
                    // fails. Capturing is passive; no reopen, activation or retry occurs.
                    await capture(page, 'space-context-created-folder-renamed-header-and-theme-color');
                    evidence.createdFolderScreenshotAfter = await inspectFolder();
                    await record({ phase: 'space-created-folder-after-capture', state: evidence.createdFolderScreenshotAfter });
                    assertSpaceFolderScreenshot(evidence.createdFolderScreenshotBefore, { spaceId: target.id, folder });
                    assertSpaceFolderScreenshot(evidence.createdFolderScreenshotAfter, { spaceId: target.id, folder });
                    assertSpaceContextUnchanged(beforeFolderCapture, await read());
                });
                await openMenu(sidebarB.page, chip(target.id), target.name, true);
                await picker(sidebarB.page, null); evidence.reset = await selectIcon(sidebarB.page, null, null);
                await projection(page, null);
                const beforeResetReload = await read();
                await ui(sidebarB.page, 'Reload reset Space icon in the second window', () => sidebarB.page.reload({ waitUntil: 'domcontentloaded' }));
                evidence.resetReload = await projection(sidebarB.page, null); assertSpaceContextUnchanged(beforeResetReload, await read());
            } });
        await sidebarB.page.evaluate(observeSpaceMenuEvents);
        await openMenu(sidebarB.page, chip(target.id), target.name);
        evidence.deleteCapture = await captureStableSpaceMenu({ name: target.name, record,
            observe: async () => ({ observation: await sidebarB.page.evaluate(() => globalThis.__spaceMenuCaptureObservation.read()),
                surface: await sidebarB.page.evaluate(readSpaceContextSurface) }),
            foreground: action => ui(sidebarB.page, 'Capture exact Space Delete command before cancellation', action),
            capture: () => capture(sidebarB.page, 'space-context-delete-cancel-keeps-saved-subtree') });
        const beforeDeleteCancel = await read();
        assert.equal(seededTabs.filter(id => beforeDeleteCancel.tabs.some(tab => tab.id === id)).length, 2);
        assert(flatten(beforeDeleteCancel.bookmarks).some(node => node.parentId === target.bookmarkFolderId && !node.url));
        evidence.deleteMessage = await cancelSpaceDeleteWithInput(sidebarB.page, target.name,
            () => ui(sidebarB.page, 'Cancel native Space deletion confirmation', () => choose(sidebarB.page, 'Delete')));
        const afterDeleteCancel = await read(); assertSpaceContextUnchanged(beforeDeleteCancel, afterDeleteCancel);
        evidence.deleteCancelled = { before: beforeDeleteCancel, after: afterDeleteCancel };
        assert.equal(await sidebarB.page.$eval(chip(target.id), node => node === document.activeElement), true);
        await record({ phase: 'space-context-basics-complete', target, ...evidence }); return evidence;
    } catch (error) {
        primaryError = error;
        if (sidebarB?.page && !sidebarB.page.isClosed()) {
            try { evidence.deleteCaptureLast = await sidebarB.page.evaluate(() => globalThis.__spaceMenuCaptureObservation?.read() || null); }
            catch (diagnosticError) { evidence.deleteCaptureDiagnosticError = diagnosticError.message; }
        }
        await record({ phase: 'space-context-basics-failed', target, seedFolder, seededTabs, ...evidence, error: { message: error.message, stack: error.stack } }).catch(() => {});
        throw error;
    } finally {
        await finishBookmarkFixture([
            async () => { if (outsideWindow) await apiPage.evaluate(id => chrome.windows.remove(id), outsideWindow.id); },
            () => apiPage.evaluate(async ({ activeSpaces }) => {
                for (const [windowId, spaceId] of Object.entries(activeSpaces)) {
                    const result = await chrome.runtime.sendMessage({ type: 'spaceStore', action: 'activate', windowId: Number(windowId), spaceId });
                    if (!result.success) throw new Error(result.error);
                }
            }, original),
            async () => { if (seedFolder) await apiPage.evaluate(async folderId => {
                const state = await chrome.runtime.sendMessage({ type: 'spaceStore', action: 'get' });
                if (!state.success) throw new Error(state.error);
                const exact = state.spaces.find(space => space.bookmarkFolderId === folderId);
                if (exact) {
                    const result = await chrome.runtime.sendMessage({ type: 'spaceStore', action: 'delete', spaceId: exact.id });
                    if (!result.success) throw new Error(result.error);
                } else await chrome.bookmarks.removeTree(folderId);
            }, seedFolder.id); },
            () => apiPage.evaluate(async ids => { const live = new Set((await chrome.tabs.query({})).map(tab => tab.id)); const present = ids.filter(id => live.has(id)); if (present.length) await chrome.tabs.remove(present); }, [...seededTabs, sidebarA?.tab.id, sidebarB?.tab.id].filter(Number.isInteger)),
            () => apiPage.evaluate(async activeTabs => { const live = new Set((await chrome.tabs.query({})).map(tab => tab.id)); for (const tab of activeTabs) if (live.has(tab.id)) await chrome.tabs.update(tab.id, { active: true }); }, original.activeTabs)
        ], primaryError, record);
    }
}
