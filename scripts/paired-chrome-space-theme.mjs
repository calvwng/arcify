/** Hosted, real-input Space theme evidence. Importing this module never starts Chrome. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { tabToSelector, setAppearanceControl } from './paired-chrome-sidebar-appearance.mjs';
import { clickBookmarkFixtureRow, finishBookmarkFixture } from './paired-chrome-bookmark-selection.mjs';
import { rightClickFreshSpaceTrigger, captureRequiredSpaceScreenshot, assertSpaceContextFixtureEnvironment } from './paired-chrome-space-context.mjs';
import { replaceSpaceEmojiWithInput } from './paired-chrome-space-icon-input.mjs';
import { requestScopedFavorite } from './paired-chrome-favorites-restart.mjs';
import { favoriteDragInputClient } from './paired-chrome-favorites-marker.mjs';
import { locateFreshDragGeometry } from './paired-chrome-ui.mjs';
import { readSpaceDropMarker, assertSpaceDropMarker, readMarkerScreenshotPixels, assertMarkerScreenshotPixels, installSpaceDragObservation, readSpaceDragObservation } from './paired-chrome-space-marker.mjs';
import { readNativeSidebarRender, nativeSidebarRenderIdentity, assertNativeSidebarScreenshot } from './paired-chrome-sidebar.mjs';

export const THEME_MODES = ['system', 'light', 'dark'];
export const THEME_PRESETS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan'];
export const THEME_EXTREMES = ['#000000', '#ffffff', '#ffff00', '#0000ff'];
export const THEME_HEX_INPUT = '.space-tint-form input[type="text"]';
const chip = id => `#spaceSwitcher button[data-space-id="${id}"]`;
const today = id => `.space.active [data-tab-type="temporary"] .tab[data-tab-id="${id}"]`;
const targetSpace = (state, id) => { const matches = state.spaces.filter(space => space.id === id); assert.equal(matches.length, 1); return matches[0]; };
const accepted = (validate, value) => { try { validate(value); return true; } catch { return false; } };

// Independent sRGB compositor: do not use the runtime's token/contrast helpers.
export function parseThemeRgb(value) {
    const match = /^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)(?:\s*,\s*((?:\d+(?:\.\d+)?|\.\d+)))?\s*\)$/.exec(value);
    assert(match, `Expected a resolved computed sRGB color, received ${value}`);
    const result = [...match.slice(1, 4).map(Number), match[4] === undefined ? 1 : Number(match[4])];
    assert(result.slice(0, 3).every(channel => channel >= 0 && channel <= 255) && result[3] >= 0 && result[3] <= 1);
    return result;
}
const composite = (foreground, background) => foreground.slice(0, 3).map((value, index) => value * foreground[3] + background[index] * (1 - foreground[3]));
export function computedThemeContrast(color, backgrounds) {
    assert(backgrounds.length, 'Capture the actual ancestor background chain.');
    const layers = backgrounds.map(parseThemeRgb);
    assert.equal(layers.at(-1)[3], 1, 'An opaque painted ancestor is required; never guess the canvas color.');
    const background = layers.reverse().reduce((under, layer) => composite(layer, under), [0, 0, 0]);
    const foreground = composite(parseThemeRgb(color), background);
    const luminance = rgb => rgb.map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
        .reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
    const a = luminance(foreground), b = luminance(background);
    return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}
export function assertThemeSample(sample, minimum = 4.5) {
    assert(sample && sample.count === 1 && sample.connected && sample.visible && sample.unobscured, 'Require one actually visible, unobscured rendered sample.');
    assert.equal(sample.opacity, 1, 'Translucent ancestor groups need explicit pixel proof, not an optimistic CSS comparison.');
    const { rect, viewport } = sample;
    for (const value of [...Object.values(rect), ...Object.values(viewport)]) assert(Number.isFinite(value));
    assert(rect.width > 0 && rect.height > 0 && rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= viewport.width + 1 && rect.y + rect.height <= viewport.height + 1);
    const ratio = computedThemeContrast(sample.color, sample.backgrounds);
    assert(ratio >= minimum, `${sample.selector}: rendered contrast ${ratio.toFixed(3)} is below ${minimum}`);
    return { selector: sample.selector, ratio, minimum };
}

/** Passive observer, suitable for page.evaluate. No style/value/focus/event injection. */
export function readThemeSamples(selectors) {
    return selectors.map(selector => {
        const nodes = [...document.querySelectorAll(selector)], node = nodes[0];
        if (!node) return { selector, count: 0 };
        const rect = node.getBoundingClientRect(), style = getComputedStyle(node), backgrounds = [];
        let opacity = 1, visible = true;
        for (let parent = node; parent; parent = parent.parentElement) {
            const computed = getComputedStyle(parent); opacity *= Number(computed.opacity);
            visible &&= computed.display !== 'none' && computed.visibility === 'visible';
            backgrounds.push(computed.backgroundColor);
        }
        // CSS root's background can be transparent while body paints the canvas.
        const opaque = backgrounds.findIndex(value => /^rgb\(/.test(value) || /,\s*1\s*\)$/.test(value));
        if (opaque >= 0) backgrounds.splice(opaque + 1);
        const points = [[rect.x + rect.width / 2, rect.y + rect.height / 2]];
        return { selector, count: nodes.length, connected: node.isConnected, visible, opacity, color: style.color, backgrounds,
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, viewport: { width: innerWidth, height: innerHeight },
            unobscured: points.every(([x, y]) => { const hit = document.elementFromPoint(x, y); return node === hit || node.contains(hit); }) };
    });
}
export function readThemeState() {
    const root = document.documentElement;
    return { mode: root.dataset.themeMode, resolved: root.dataset.theme, tint: getComputedStyle(root).getPropertyValue('--space-tint').trim(),
        systemDark: matchMedia('(prefers-color-scheme: dark)').matches, colorScheme: getComputedStyle(root).colorScheme };
}
export function assertThemeResolved(state, { mode, tint, systemDark }) {
    assert(THEME_MODES.includes(mode));
    assert.equal(state.mode, mode); assert.equal(state.tint, tint);
    if (systemDark !== undefined) assert.equal(state.systemDark, systemDark);
    const expected = mode === 'system' ? (state.systemDark ? 'dark' : 'light') : mode;
    assert.equal(state.resolved, expected); assert.equal(state.colorScheme, expected);
    return state;
}

/** A metadata comparison cannot prove Chrome compatibility without a real group. */
export function assertThemeNativeProjection(state, { spaceId, windowId }) {
    assert(Number.isInteger(windowId), 'Require the exact fixture window.');
    assert.equal(state.sync.syncTabGroups, true, 'Native sync must be enabled for this proof.');
    const space = targetSpace(state, spaceId), key = `${spaceId}:${windowId}`;
    assert(THEME_PRESETS.includes(space.color), 'Space color remains a native enum.');
    assert(Object.hasOwn(state.projection, key), 'The exact target/window projection must exist.');
    const groupId = state.projection[key];
    assert(Number.isInteger(groupId) && groupId >= 0, 'Require a real projected native group ID.');
    const groups = state.groups.filter(group => group.id === groupId);
    assert.equal(groups.length, 1, 'The projected group must exist exactly once in Chrome.');
    const group = groups[0];
    assert.equal(group.windowId, windowId, 'The native group belongs to the exact fixture window.');
    assert.equal(group.color, space.color, 'Custom tint must never replace the native named color.');
    assert(THEME_PRESETS.includes(group.color), 'Chrome receives only its supported native color enum.');
    const owned = new Set([...space.spaceBookmarks, ...space.temporaryTabs]);
    const members = state.tabs.filter(tab => owned.has(tab.id) && tab.windowId === windowId && !tab.pinned);
    assert(members.length > 0, 'A projected ID without a live owned member is not native evidence.');
    for (const tab of members) assert.equal(tab.groupId, groupId, 'Every live target member is in its exact projected group.');
    const bridge = state.bridgeColors.filter(item => item.id === spaceId);
    assert.equal(bridge.length, 1); assert.equal(bridge[0].color, group.color);
    return { spaceId, windowId, groupId, color: group.color, tabIds: members.map(tab => tab.id) };
}

export function assertThemeMetadataSaved(before, after, { spaceId, windowId, changes }) {
    const nativeBefore = assertThemeNativeProjection(before, { spaceId, windowId });
    const nativeAfter = assertThemeNativeProjection(after, { spaceId, windowId });
    assert.equal(nativeAfter.groupId, nativeBefore.groupId, 'Theme edits never replace the native group.');
    assert(Object.keys(changes).length && Object.keys(changes).every(key => ['color', 'customTint'].includes(key)));
    if (Object.hasOwn(changes, 'customTint')) assert(changes.customTint === null || /^#[0-9a-f]{6}$/.test(changes.customTint));
    if (Object.hasOwn(changes, 'color')) { assert(THEME_PRESETS.includes(changes.color)); assert.equal(changes.customTint, null); }
    const expected = structuredClone(before), target = targetSpace(expected, spaceId);
    assert.equal(expected.registry[target.bookmarkFolderId]?.spaceUuid, spaceId);
    Object.assign(target, changes); Object.assign(expected.registry[target.bookmarkFolderId], changes);
    if (changes.color !== undefined) {
        const projectionIds = Object.entries(expected.projection).filter(([key]) => key.startsWith(`${spaceId}:`)).map(([, id]) => id);
        for (const group of expected.groups) if (projectionIds.includes(group.id)) group.color = changes.color;
        expected.bridgeColors.find(space => space.id === spaceId).color = changes.color;
    }
    assert.deepEqual(after, expected, 'Only exact UUID metadata, its named native group color and the unchanged v1 color shape may change.');
    assert(after.bridgeColors.every(space => THEME_PRESETS.includes(space.color)));
    return { spaceId, changes, nativeBefore, nativeAfter };
}
const modeComparable = state => { const copy = structuredClone(state); delete copy.activeSpaces; for (const tab of copy.tabs) delete tab.active; return copy; };
export function assertThemeModeSaved(before, after, mode) {
    assert(THEME_MODES.includes(mode));
    const expected = modeComparable(before);
    expected.appearance = { favoritesLayout: 'standard', favoriteTileSize: 44, spaceHeaderSize: 16, hideSpaceNames: false, ...expected.appearance, themeMode: mode };
    assert.deepEqual(modeComparable(after), expected, 'Real Settings activation may change active tab/Space only; mode writes must retain all other appearance, palette, metadata and native identities.');
}
export function assertThemeReload(before, after) {
    assert.deepEqual(modeComparable(after), modeComparable(before), 'Sidebar document reload must retain every captured durable field and native content identity.');
}

export function installThemeInputTrace(selector) {
    globalThis.__spaceThemeInput?.dispose();
    const events = [], listen = event => {
        if (event.target.matches?.(selector)) events.push({ type: event.type, trusted: event.isTrusted, key: event.key || null, value: event.target.value });
    };
    for (const name of ['keydown', 'beforeinput', 'input', 'change']) document.addEventListener(name, listen, true);
    globalThis.__spaceThemeInput = { events, dispose() { for (const name of ['keydown', 'beforeinput', 'input', 'change']) document.removeEventListener(name, listen, true); } };
}
export function assertThemeKeyboardTrace(events, value, { select = false } = {}) {
    assert(events.length && events.every(event => event.trusted), 'Every captured input must be native trusted input.');
    assert(events.some(event => event.type === 'keydown'), 'Typing/selecting requires actual keyboard input.');
    for (const type of select ? ['change'] : ['beforeinput', 'input']) assert(events.some(event => event.type === type), `Missing trusted ${type}.`);
    assert.equal(events.filter(event => ['input', 'change'].includes(event.type)).at(-1)?.value, value);
    return events;
}
export async function replaceThemeHex(page, value) {
    await tabToSelector(page, THEME_HEX_INPUT, 100);
    await page.evaluate(installThemeInputTrace, THEME_HEX_INPUT);
    await page.keyboard.down('Control');
    try { await page.keyboard.press('KeyA'); } finally { await page.keyboard.up('Control'); }
    await page.keyboard.press('Backspace'); await page.keyboard.type(value);
    assert.equal(await page.$eval(THEME_HEX_INPUT, node => node.value), value);
    return assertThemeKeyboardTrace(await page.evaluate(() => globalThis.__spaceThemeInput.events), value);
}
export async function chooseThemeMode(page, mode) {
    assert(THEME_MODES.includes(mode));
    await page.waitForSelector('#themeMode:not([disabled])');
    await tabToSelector(page, '#themeMode', 200);
    const before = await page.$eval('#themeMode', node => node.value);
    await page.evaluate(installThemeInputTrace, '#themeMode');
    await page.keyboard.press('Home');
    for (let index = 0; index < THEME_MODES.indexOf(mode); index++) await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    assert.equal(await page.$eval('#themeMode', node => node.value), mode);
    const trace = await page.evaluate(() => globalThis.__spaceThemeInput.events);
    if (before !== mode) assertThemeKeyboardTrace(trace, mode, { select: true });
    else assert(trace.every(event => event.trusted));
    return { before, mode, trace };
}
export function readThemeFocus(selector) {
    const node = document.querySelector(selector), probe = globalThis.__themeNodeIdentity ||= { nodes: new WeakMap(), next: 0 };
    if (!node) return null;
    if (!probe.nodes.has(node)) probe.nodes.set(node, ++probe.next);
    return { nodeId: probe.nodes.get(node), timeOrigin: performance.timeOrigin, connected: node.isConnected,
        active: node === document.activeElement, value: node.value, start: node.selectionStart, end: node.selectionEnd, direction: node.selectionDirection,
        todaySelection: [...document.querySelectorAll('.today-selected')].map(row => row.dataset.tabId) };
}
export function assertThemeFocusKept(before, after) {
    assert(before && before.connected && before.active && before.start < before.end, 'Real selected text must exist before a theme change.');
    assert.deepEqual(after, before, 'Changing theme must preserve the same mounted input, activeElement, text range and Today selection.');
}
export function assertThemeNativeHost(host, { windowId, extensionId, narrow = true }) {
    assert.equal(host.tab, null, 'A regular sidebar.html tab is not native evidence.');
    assert.equal(host.windowId, windowId); assert.equal(host.url, `chrome-extension://${extensionId}/sidebar.html`);
    assert.equal(host.visibility, 'visible'); assert(host.height >= 100);
    assert(host.width >= 224 && (!narrow || host.width <= 420), 'Require an actual narrow native host viewport, never setViewport on the panel.');
    assert.equal(host.context.contextType, 'SIDE_PANEL'); assert.equal(typeof host.context.contextId, 'string'); assert(host.context.contextId.length); assert([windowId, -1].includes(host.context.windowId)); assert.equal(host.context.documentUrl, host.url);
    assert(host.openedEvents.some(event => event.type === 'opened' && event.windowId === windowId && ['sidebar.html', '/sidebar.html'].includes(event.path)), 'Raw SIDE_PANEL window -1 requires the actual onOpened source-window receipt.');
}

export function observeThemeFirstPaint() {
    const evidence = globalThis.__themeFirstPaint = { paints: [], themes: [] };
    const state = () => ({ mode: document.documentElement?.dataset.themeMode || null, resolved: document.documentElement?.dataset.theme || null });
    const mutations = new MutationObserver(() => { const current = state(); if (current.resolved && JSON.stringify(evidence.themes.at(-1)) !== JSON.stringify(current)) evidence.themes.push(current); });
    mutations.observe(document, { subtree: true, attributes: true, attributeFilter: ['data-theme', 'data-theme-mode'] });
    const paints = new PerformanceObserver(list => { for (const entry of list.getEntries()) evidence.paints.push({ name: entry.name, startTime: entry.startTime, ...state() }); });
    paints.observe({ type: 'paint', buffered: true });
}
export function assertThemeFirstPaint(evidence, mode, resolved) {
    assert(evidence.paints.some(paint => paint.name === 'first-contentful-paint'), 'Require actual first-contentful-paint timing after reload.');
    assert(evidence.themes.length, 'Observe the bootstrap and authoritative mode application.');
    for (const state of [...evidence.paints, ...evidence.themes]) { assert.equal(state.mode, mode); assert.equal(state.resolved, resolved, 'Cached explicit mode must not flash through an opposite System theme.'); }
    return evidence;
}

export function readThemeHeaderGeometry() {
    const header = document.querySelector('.space.active .space-header'), icon = header?.querySelector('.space-icon'), name = header?.querySelector('.space-name');
    if (!header || !icon || !name) return null;
    const rect = node => { const { x, y, width, height } = node.getBoundingClientRect(); return { x, y, width, height }; };
    const style = getComputedStyle(name);
    return { header: rect(header), icon: rect(icon), name: rect(name), glyph: icon.textContent, iconHidden: icon.hidden,
        iconDisplay: getComputedStyle(icon).display, nameDisplay: style.display, fontSize: parseFloat(style.fontSize),
        overflow: style.textOverflow, value: name.value, disabled: name.disabled, readOnly: name.readOnly,
        focused: name === document.activeElement, controls: [...header.querySelectorAll('.sidebar-button, .space-options')].map(rect),
        viewport: { width: innerWidth, height: innerHeight } };
}
export function assertThemeHeaderGeometry(state, { glyph, name, size, focused = false }) {
    assert(state); assert.equal(state.glyph, glyph || ''); assert.equal(state.value, name); assert.equal(state.fontSize, size);
    assert.equal(state.disabled, false); assert.equal(state.readOnly, false); assert.notEqual(state.nameDisplay, 'none');
    assert.equal(state.focused, focused); assert.equal(state.overflow, focused ? 'clip' : 'ellipsis');
    assert.equal(state.iconHidden, !glyph); assert.equal(state.controls.length, 2);
    for (const rect of [state.header, state.name, ...state.controls, ...(glyph ? [state.icon] : [])]) {
        for (const value of Object.values(rect)) assert(Number.isFinite(value));
        assert(rect.width > 0 && rect.height > 0 && rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= state.viewport.width + 1 && rect.y + rect.height <= state.viewport.height + 1);
    }
    if (glyph) {
        assert.notEqual(state.iconDisplay, 'none');
        assert(Math.abs(state.icon.y + state.icon.height / 2 - state.name.y - state.name.height / 2) <= 1, 'The full emoji and editable name share one centered line box.');
        const gap = state.name.x - state.icon.x - state.icon.width;
        assert(gap >= 0 && gap <= 8, 'The complete icon sits immediately beside its name.');
    } else assert.equal(state.iconDisplay, 'none');
    assert(state.name.x + state.name.width <= Math.min(...state.controls.map(rect => rect.x)) + 1, 'Long names cannot overlap archive/menu controls.');
    return state;
}
export function assertThemeHeaderSaved(before, after, { spaceId, changes }) {
    assert(Object.keys(changes).length && Object.keys(changes).every(key => ['name', 'icon'].includes(key)));
    const expected = structuredClone(before), target = targetSpace(expected, spaceId);
    assert.equal(expected.registry[target.bookmarkFolderId]?.spaceUuid, spaceId);
    Object.assign(target, changes); Object.assign(expected.registry[target.bookmarkFolderId], changes);
    if (changes.name !== undefined) {
        const flatten = nodes => nodes.flatMap(node => [node, ...flatten(node.children || [])]);
        const folder = flatten(expected.bookmarks).find(node => node.id === target.bookmarkFolderId); assert(folder && !folder.url); folder.title = changes.name;
        const groups = Object.entries(expected.projection).filter(([key]) => key.startsWith(`${spaceId}:`)).map(([, id]) => id);
        for (const group of expected.groups) if (groups.includes(group.id)) group.title = changes.name;
    }
    assert.deepEqual(after, expected, 'Header evidence may edit only exact UUID icon/name metadata and the matching bookmark/native group title.');
}

/** Real Settings checkbox input. Caller foregrounds this ordinary Settings tab. */
export async function setThemeGroupSync(page, enabled) {
    assert.equal(typeof enabled, 'boolean');
    await page.waitForSelector('#syncTabGroups');
    // The legacy form loads asynchronously and initially contains a Loading option.
    await page.waitForFunction(() => Boolean(document.querySelector('#defaultSpaceName')?.value), { polling: 50 });
    const before = await page.$eval('#syncTabGroups', node => node.checked);
    if (before !== enabled) {
        await page.evaluate(installThemeInputTrace, '#syncTabGroups');
        await page.click('label.toggle-label[for="syncTabGroups"]');
        const trace = await page.evaluate(() => globalThis.__spaceThemeInput.events);
        assert(trace.length && trace.every(event => event.trusted));
        assert(trace.some(event => event.type === 'change'), 'Group sync uses the real checkbox change.');
    }
    assert.equal(await page.$eval('#syncTabGroups', node => node.checked), enabled);
}

export function assertThemeFixtureRestored(before, after, spaceId) {
    const normalize = state => {
        const result = structuredClone(state), space = targetSpace(result, spaceId);
        // The metadata API represents an originally absent tint as an explicit reset.
        space.customTint ??= null; space.icon ??= null;
        result.registry[space.bookmarkFolderId].customTint ??= null; result.registry[space.bookmarkFolderId].icon ??= null;
        for (const item of result.spaces) item.lastTab ??= null;
        return result;
    };
    assert.deepEqual(normalize(after), normalize(before), 'Cleanup must restore every original Space, group identity/color/member/order, setting, tab, Favorite, bookmark and active selection.');
}

/** Restore only remembered-tab hints changed by explicit fixture activation. */
export async function restoreThemeLastTabs(apiPage, originalSpaces) {
    await apiPage.evaluate(async originals => {
        const reply = await chrome.runtime.sendMessage({ type: 'spaceStore', action: 'get' });
        if (!reply.success) throw Error(reply.error);
        const before = reply.spaces;
        if (before.length !== originals.length || before.some(space => !originals.some(original => original.id === space.id))) throw Error('Cleanup cannot replace or remove a Space.');
        const after = structuredClone(before);
        for (const space of after) space.lastTab = originals.find(original => original.id === space.id).lastTab ?? null;
        if (JSON.stringify(before) !== JSON.stringify(after)) {
            const saved = await chrome.runtime.sendMessage({ type: 'spaceStore', action: 'patch', before, after });
            if (!saved.success) throw Error(saved.error);
        }
    }, originalSpaces);
}

/** Explicit fixture cleanup only; never used to make an acceptance assertion pass. */
export async function restoreThemeNativeFixture(apiPage, original) {
    await apiPage.evaluate(async ({ groups, tabs, projection }) => {
        if ((await chrome.storage.sync.get('syncTabGroups')).syncTabGroups !== false) throw Error('Disable sync through Settings before native fixture cleanup.');
        const liveGroups = await chrome.tabGroups.query({}), liveTabs = await chrome.tabs.query({});
        for (const group of groups) if (!liveGroups.some(item => item.id === group.id && item.windowId === group.windowId)) throw Error(`Original native group disappeared: ${group.id}`);
        for (const tab of tabs) if (!liveTabs.some(item => item.id === tab.id && item.windowId === tab.windowId && item.url === tab.url && item.pinned === tab.pinned)) throw Error(`Original native tab identity changed: ${tab.id}`);
        const ungroup = tabs.filter(tab => tab.groupId < 0 && liveTabs.find(item => item.id === tab.id).groupId >= 0).map(tab => tab.id);
        if (ungroup.length) await chrome.tabs.ungroup(ungroup);
        for (const group of groups) {
            const members = tabs.filter(tab => tab.groupId === group.id).sort((a, b) => a.index - b.index);
            if (members.length) {
                const current = await chrome.tabs.query({ groupId: group.id });
                if (members.some(tab => !current.some(item => item.id === tab.id))) await chrome.tabs.group({ groupId: group.id, tabIds: members.map(tab => tab.id) });
            }
        }
        for (const windowId of new Set(tabs.map(tab => tab.windowId))) {
            const ordered = tabs.filter(tab => tab.windowId === windowId).sort((a, b) => a.index - b.index), done = new Set();
            for (const tab of ordered) {
                if (done.has(tab.id)) continue;
                const block = tab.groupId < 0 ? [tab] : ordered.filter(item => item.groupId === tab.groupId);
                if (tab.groupId < 0) {
                    const current = await chrome.tabs.query({ windowId });
                    if (current.find(live => live.id === tab.id)?.index !== tab.index) await chrome.tabs.move(tab.id, { index: tab.index });
                } else {
                    // tabs.move(array) processes members separately and can ungroup
                    // a member while crossing another block. Move the group atomically.
                    const current = (await chrome.tabs.query({ groupId: tab.groupId })).sort((a, b) => a.index - b.index);
                    if (current.length !== block.length || block.some(item => !current.some(live => live.id === item.id))) throw Error('Original group membership was not restored.');
                    const start = current[0].index;
                    for (const [offset, member] of block.entries()) {
                        const live = (await chrome.tabs.query({ groupId: tab.groupId })).find(item => item.id === member.id);
                        if (live.index !== start + offset) await chrome.tabs.move(member.id, { index: start + offset });
                    }
                    if (start !== tab.index) await chrome.tabGroups.move(tab.groupId, { index: tab.index });
                }
                block.forEach(item => done.add(item.id));
            }
        }
        for (const group of groups) await chrome.tabGroups.update(group.id, { title: group.title, color: group.color, collapsed: group.collapsed });
        // Restore the exact pre-fixture projection after removing only owned test tabs.
        // No Space/store metadata or durable user settings are written here.
        await chrome.storage.session.set({ spaceGroupProjection: projection });
    }, { groups: original.groups, tabs: original.tabs, projection: original.projection });
}

/** Choose a visible non-no-op preview without changing persisted Space order. */
export function chooseThemeMarkerRequest(visibleIds, orderedIds) {
    for (const ids of [visibleIds, orderedIds]) {
        assert(Array.isArray(ids) && ids.every(id => typeof id === 'string' && id.length));
        assert.equal(new Set(ids).size, ids.length, 'Duplicate chip identity cannot authorize drag evidence.');
    }
    assert(visibleIds.length >= 2, 'At least two visible native chips are needed for a real insertion marker.');
    const indices = visibleIds.map(id => orderedIds.indexOf(id));
    assert(indices.every((index, offset) => index >= 0 && (!offset || index > indices[offset - 1])), 'Visible chips must retain the authoritative Space order.');
    // The old first-before-second gesture describes the existing slot, so the
    // real resolver correctly suppresses its marker. Reverse those identities.
    return { sourceSpaceId: visibleIds[1], anchorSpaceId: visibleIds[0], placement: 'before' };
}

/** Drain authoritative reconciliation before reading the composite fixture baseline. */
export async function readThemeFixtureState(apiPage, snapshot, windowId) {
    const bridge = await snapshot(windowId);
    const state = await apiPage.evaluate(async () => {
        const bookmark = ({ id, parentId, index, title, url, children }) => ({ id, parentId, index, title, ...(url === undefined ? {} : { url }), ...(children ? { children: children.map(bookmark) } : {}) });
        const local = await chrome.storage.local.get(['spaces', 'spaceRegistry', 'sidebarAppearance', 'persistentFavorites', 'pinnedTabStatesById']);
        const session = await chrome.storage.session.get(['activeSpaces', 'spaceGroupProjection']);
        return { spaces: local.spaces, registry: local.spaceRegistry || {}, appearance: local.sidebarAppearance ?? null,
            favorites: local.persistentFavorites || [], bindings: local.pinnedTabStatesById || {}, sync: await chrome.storage.sync.get(null),
            bookmarks: (await chrome.bookmarks.getTree()).map(bookmark), activeSpaces: session.activeSpaces || {}, projection: session.spaceGroupProjection || {},
            groups: (await chrome.tabGroups.query({})).sort((a, b) => a.id - b.id),
            windows: (await chrome.windows.getAll()).map(({ id, focused }) => ({ id, focused })).sort((a, b) => a.id - b.id),
            tabs: (await chrome.tabs.query({})).map(({ id, windowId, index, url, pinned, active, groupId }) => ({ id, windowId, index, url, pinned, active, groupId })).sort((a, b) => a.id - b.id) };
    });
    state.bridgeColors = bridge.spaces.map(({ id, color, ...rest }) => { assert(!Object.hasOwn(rest, 'customTint'), 'v1 must not acquire a new metadata field.'); return { id, color }; });
    return state;
}

/** All cleanup targets come from the same post-reconciliation baseline. */
export function themeRestorationState(state, spaceId) {
    return structuredClone({ space: targetSpace(state, spaceId), appearance: state.appearance,
        activeSpaces: state.activeSpaces, activeTabs: state.tabs.filter(tab => tab.active).map(tab => tab.id),
        focusedWindowId: state.windows.find(window => window.focused)?.id });
}

/** Runner owns browser launch, sandbox and native mounting. Reload evidence is a real document reload. */
export async function exerciseSpaceTheme({ apiPage, nativeSidebar, newTabPage, ui, screenshot, screenshotBytes, snapshot, poll, fixture, arcifyId, record = async () => {} }) {
    assertSpaceContextFixtureEnvironment();
    for (const fn of [nativeSidebar, newTabPage, ui, screenshot, screenshotBytes, snapshot, poll]) assert.equal(typeof fn, 'function');
    const nonce = randomBytes(8).toString('hex'), windowId = fixture.windowA;
    const initial = await snapshot(windowId), target = initial.spaces.find(space => space.id === fixture.spaces.work);
    assert(target?.bookmarkFolderId);
    const ownedTabs = [], ownedBookmarks = [], ownedFavorites = [];
    let native, settings, primaryError, beforeFixture, original;
    const evidence = { nativePanel: true, nonce, checkpoints: [], screenshots: [], nativeColorPicker: 'Manual follow-up: the OS color dialog is not automated. Hex saves use real keyboard input.', systemPreference: 'Chrome rendering-media emulation, not a physical OS setting change.' };
    const checkpoint = async (phase, data = {}) => { evidence.checkpoints.push({ phase, ...data }); await record(structuredClone(evidence)); };
    const read = () => readThemeFixtureState(apiPage, snapshot, windowId);
    const host = async () => {
        const value = await native.page.evaluate(async () => ({ tab: await chrome.tabs.getCurrent() || null, windowId: (await chrome.windows.getCurrent()).id,
            url: location.href, visibility: document.visibilityState, width: innerWidth, height: innerHeight,
            contexts: await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] }) }));
        const contexts = value.contexts.filter(context => [windowId, -1].includes(context.windowId) && context.documentUrl === value.url);
        assert.equal(contexts.length, 1); const result = { ...value, context: contexts[0], openedEvents: native.evidence.openedEvents }; delete result.contexts;
        assertThemeNativeHost(result, { windowId, extensionId: arcifyId }); return result;
    };
    const input = async (label, action) => { await checkpoint('native-input', { label, host: await host() }); return action(); };
    const capture = async label => {
        const hosting = await host(), before = await native.page.evaluate(readNativeSidebarRender);
        const shot = await captureRequiredSpaceScreenshot(screenshot, native.page, label);
        const bytes = await screenshotBytes(shot), dimensions = assertNativeSidebarScreenshot(bytes, before, arcifyId);
        const after = await native.page.evaluate(readNativeSidebarRender);
        assert.deepEqual(nativeSidebarRenderIdentity(after), nativeSidebarRenderIdentity(before));
        evidence.screenshots.push({ ...shot, hosting, dimensions }); await record(structuredClone(evidence)); return { shot, bytes };
    };
    const samples = async (label, selectors) => {
        const measured = await native.page.evaluate(readThemeSamples, selectors), contrast = measured.map(sample => assertThemeSample(sample));
        await checkpoint(label, { measured, contrast }); return measured;
    };
    const clickText = async (scope, text) => {
        const buttons = await native.page.$$(`${scope} button`);
        try { const labels = await Promise.all(buttons.map(button => button.evaluate(node => node.textContent)));
            assert.equal(labels.filter(label => label === text).length, 1); await buttons[labels.indexOf(text)].click();
        } finally { await Promise.all(buttons.map(button => button.dispose())); }
    };
    const open = async () => input('Open Space Theme Color', async () => {
        await rightClickFreshSpaceTrigger(native.page, '.space.active .space-options', observation => checkpoint('space-menu-input', { observation }));
        await native.page.waitForSelector('.space-context-menu', { visible: true });
        await samples('menu-contrast', ['.space-context-menu [role="menuitem"]:first-of-type']);
        await capture('space-theme-menu'); await clickText('.space-context-menu', 'Theme Color');
        await native.page.waitForSelector(THEME_HEX_INPUT, { visible: true });
        assert.deepEqual(await native.page.$$eval('.space-choice-grid [data-choice]', nodes => nodes.map(node => node.dataset.choice)), THEME_PRESETS);
        assert.equal(await native.page.$eval('.space-tint-form input[type="color"]', node => node.disabled), false);
        await samples('editor-contrast', ['#spaceEditorTitle', THEME_HEX_INPUT, '#spaceTintHint']);
    });
    const closed = () => native.page.waitForFunction(() => !document.querySelector('.space-editor'));
    const save = async value => {
        await open(); const before = await read();
        const trace = await input('Type and save custom tint', async () => { const events = await replaceThemeHex(native.page, value); await native.page.keyboard.press('Enter'); return events; });
        await closed(); const changes = { customTint: value.toLowerCase() };
        const after = await poll(read, state => accepted(after => assertThemeMetadataSaved(before, after, { spaceId: target.id, windowId, changes }), state), 'exact custom tint and unchanged native/v1 named colors');
        await checkpoint('custom-tint-saved', { before, after, trace });
    };
    const setMode = async mode => {
        let before, after, trace;
        await ui(settings.page, `Choose ${mode} appearance using Settings keyboard`, async () => {
            before = await read(); trace = await chooseThemeMode(settings.page, mode);
            after = await poll(read, state => accepted(value => assertThemeModeSaved(before, value, mode), state), 'profile appearance saved without overwriting other settings');
        });
        await checkpoint('appearance-saved', { before, after, trace });
        await poll(() => native.page.evaluate(readThemeState), state => state.mode === mode, 'native sidebar observes appearance storage change');
    };
    const selectTarget = async () => {
        await input('Select exact theme fixture Space', () => native.page.click(chip(target.id)));
        await poll(() => native.page.evaluate(readNativeSidebarRender), state => state.selectedSpaces[0] === target.id, 'theme Space rendered');
    };
    try {
        beforeFixture = await read();
        original = themeRestorationState(beforeFixture, target.id);
        await checkpoint('before-theme-fixture', { before: beforeFixture });
        settings = await newTabPage(`chrome-extension://${arcifyId}/options.html`, windowId); ownedTabs.push(settings.tab.id);
        await settings.page.evaluateOnNewDocument(observeThemeFirstPaint);
        await apiPage.evaluate(async ({ tabId, spaceId }) => { const reply = await chrome.runtime.sendMessage({ type: 'spaceStore', action: 'assign', tabId, spaceId }); if (!reply.success) throw Error(reply.error); }, { tabId: settings.tab.id, spaceId: target.id });
        for (let index = 0; index < 2; index++) {
            const tab = await apiPage.evaluate(options => chrome.tabs.create(options), { windowId, url: `${fixture.base}/alpha?theme=${nonce}-${index}`, active: false });
            ownedTabs.push(tab.id);
            await apiPage.evaluate(async ({ tabId, spaceId }) => { const reply = await chrome.runtime.sendMessage({ type: 'spaceStore', action: 'assign', tabId, spaceId }); if (!reply.success) throw Error(reply.error); }, { tabId: tab.id, spaceId: target.id });
        }
        const bookmark = await apiPage.evaluate(options => chrome.bookmarks.create(options), { parentId: target.bookmarkFolderId, title: `Theme Favorite ${nonce}`, url: `${fixture.base}/alpha?theme-favorite=${nonce}` });
        ownedBookmarks.push(bookmark.id);
        const added = await requestScopedFavorite(settings.page, windowId, 'addBookmark', { spaceId: target.id, bookmarkFolderId: target.bookmarkFolderId, bookmarkId: bookmark.id, parentId: bookmark.parentId });
        const favorite = added.favorites.find(item => item.sourceBookmarkId === bookmark.id); assert(favorite?.tabId);
        ownedFavorites.push(favorite.id); ownedTabs.push(favorite.tabId);
        const favoriteSelector = `#pinnedFavicons .saved-favorite[data-favorite-id="${favorite.id}"]`;
        await poll(() => apiPage.evaluate(ids => chrome.tabs.query({}).then(tabs => tabs.filter(tab => ids.includes(tab.id)).map(tab => ({ id: tab.id, status: tab.status }))), ownedTabs), tabs => tabs.length === ownedTabs.length && tabs.every(tab => tab.status === 'complete'), 'owned fixture pages finish loading before theme baselines');
        // Explicit test setup: native compatibility must use a real target group,
        // even when the preceding case left projection disabled.
        await ui(settings.page, 'Enable native group sync for exact theme fixture Space', () => setThemeGroupSync(settings.page, true));
        const projected = await poll(read, state => accepted(value => assertThemeNativeProjection(value, { spaceId: target.id, windowId }), state), 'real target-window native group and owned members');
        await checkpoint('native-projection-required', { projection: assertThemeNativeProjection(projected, { spaceId: target.id, windowId }) });
        native = await nativeSidebar({ revealSpaceId: target.id }); await selectTarget();
        // Normalize the initial appearance through the real control before using strict snapshots.
        await setMode('light'); await selectTarget();
        await open(); const beforeInvalid = await read();
        for (const invalid of ['#fff', '#12345z', 'red', 'url(javascript:bad)']) {
            const trace = await input('Reject malformed hex without persistence', async () => { const events = await replaceThemeHex(native.page, invalid); await native.page.keyboard.press('Enter'); return events; });
            await native.page.waitForSelector(`${THEME_HEX_INPUT}[aria-invalid="true"]`);
            assert.match(await native.page.$eval('.space-editor-status', node => node.textContent), /six-digit hex/);
            assert.deepEqual(await read(), beforeInvalid); await checkpoint('invalid-tint-rejected', { invalid, trace });
        }
        await capture('space-theme-invalid-hex');
        await input('Cancel invalid custom tint', () => native.page.keyboard.press('Escape')); await closed(); assert.deepEqual(await read(), beforeInvalid);
        await open(); const beforeCancel = await read(); await input('Type valid tint then Cancel', () => replaceThemeHex(native.page, '#123456'));
        await input('Cancel valid unsaved custom tint', () => clickText('.space-editor', 'Cancel')); await closed(); assert.deepEqual(await read(), beforeCancel);
        await save('#A1B2C3');
        await open(); const beforeReset = await read();
        await input('Reset custom tint to its existing named preset', () => clickText('.space-editor', `Reset to ${targetSpace(beforeReset, target.id).color} preset`)); await closed();
        await poll(read, state => accepted(value => assertThemeMetadataSaved(beforeReset, value, { spaceId: target.id, windowId, changes: { customTint: null } }), state), 'custom reset persisted');
        for (const mode of ['light', 'dark']) {
            await setMode(mode); await selectTarget();
            for (const tint of THEME_EXTREMES) {
                await save(tint);
                await poll(() => native.page.evaluate(readThemeState), state => accepted(value => assertThemeResolved(value, { mode, tint }), state), 'extreme tint rendered');
                await input('Activate exact owned Favorite', () => native.page.click(favoriteSelector));
                await native.page.waitForSelector(`${favoriteSelector}.active`);
                // Ctrl-click selection does not replace the active Favorite content page.
                await input('Select Today while retaining active Favorite', () => clickBookmarkFixtureRow(native.page, today(ownedTabs[1]), ['Control']));
                await native.page.waitForSelector(`${today(ownedTabs[1])}.today-selected`);
                await samples('extreme-rendered-contrast', ['.space.active .space-name', `${today(ownedTabs[1])} .tab-title-display`, `${favoriteSelector} .favorite-state`, `${chip(target.id)}.active`]);
                await capture(`space-theme-${mode}-${tint.slice(1)}-native-panel`);
                await input('Clear Today selection with Escape', () => native.page.keyboard.press('Escape'));
            }
            // A real drag reveals the marker. Cancel through the native input session; never drop or mutate Space order.
            const visible = await native.page.$$eval('#spaceSwitcher button[data-space-id]', nodes => nodes.filter(node => { const r = node.getBoundingClientRect(); return r.x >= 6 && r.right < innerWidth - 6; }).map(node => node.dataset.spaceId));
            const beforeDrag = await read();
            const request = chooseThemeMarkerRequest(visible, beforeDrag.spaces.map(space => space.id));
            const { sourceSpaceId: sourceId, anchorSpaceId: anchorId } = request;
            const { source, target: anchor, from, to } = await locateFreshDragGeometry(native.page, chip(sourceId), chip(anchorId), observation => checkpoint('drag-geometry', { observation }));
            let held = false;
            await native.page.evaluate(installSpaceDragObservation);
            try {
                await input('Drag exact visible Space chip to reveal insertion marker', async () => {
                    await native.page.mouse.move(from.x + from.width / 2, from.y + from.height / 2); await native.page.mouse.down(); held = true;
                    await native.page.mouse.move(from.x + from.width / 2, from.y - 12, { steps: 5 });
                    await native.page.mouse.move(to.x + 7, to.y + to.height / 2, { steps: 20 });
                });
                const marker = await poll(() => native.page.evaluate(readSpaceDropMarker), state => accepted(value => assertSpaceDropMarker(value, request), state), 'genuine visible Space insertion marker');
                const { bytes } = await capture(`space-theme-${mode}-native-drop-marker`);
                const pixels = await native.page.evaluate(readMarkerScreenshotPixels, { base64: bytes.toString('base64'), marker });
                const paint = assertMarkerScreenshotPixels(pixels, marker); await checkpoint('marker-paint', { mode, marker, paint });
                await favoriteDragInputClient(native.page).send('Input.cancelDragging');
                const trace = await poll(() => native.page.evaluate(readSpaceDragObservation), state => state.events.some(event => event.type === 'dragend' && event.trusted), 'native drag cancellation');
                assert.equal(trace.events.filter(event => event.type === 'dragstart' && event.trusted).length, 1);
                assert(!trace.events.some(event => event.type === 'drop'));
                await native.page.mouse.up(); held = false; assert.deepEqual(await read(), beforeDrag);
            } finally {
                await checkpoint('theme-drag-observation', { request, trace: await native.page.evaluate(readSpaceDragObservation).catch(error => ({ error: error.message })) }).catch(() => {});
                if (held) { await favoriteDragInputClient(native.page).send('Input.cancelDragging').catch(() => {}); const trace = await native.page.evaluate(readSpaceDragObservation).catch(() => null); if (trace?.events.some(event => event.type === 'dragend' && event.trusted)) await native.page.mouse.up(); }
                await source.dispose(); await anchor.dispose();
            }
            await ui(settings.page, 'Capture narrow real Settings appearance control', async () => {
                await settings.page.setViewport({ width: 350, height: 900 });
                await tabToSelector(settings.page, '#themeMode', 200);
                const measured = await settings.page.evaluate(readThemeSamples, ['#themeMode', 'label[for="themeMode"]', '#favoriteTileSizeValue']); measured.forEach(value => assertThemeSample(value));
                evidence.screenshots.push(await captureRequiredSpaceScreenshot(screenshot, settings.page, `space-theme-${mode}-narrow-settings`));
                const disabled = await settings.page.$eval('#favoriteTileSize', node => ({ disabled: node.disabled, opacity: getComputedStyle(node).opacity, background: getComputedStyle(node).backgroundColor, color: getComputedStyle(node).color }));
                assert.equal(disabled.disabled, true, 'The preceding density fixture must leave Standard layout so disabled control evidence is visible.');
                assert.equal(disabled.opacity, '1'); assert(computedThemeContrast(disabled.color, [disabled.background]) >= 4.5);
                await checkpoint('settings-contrast', { measured, disabled });
                const beforeNotice = await read(), originalPeer = await settings.page.$eval('#bridgePeerId', node => node.value);
                await tabToSelector(settings.page, '#bridgePeerId', 200);
                await settings.page.keyboard.down('Control'); try { await settings.page.keyboard.press('KeyA'); } finally { await settings.page.keyboard.up('Control'); }
                await settings.page.keyboard.press('Backspace'); await settings.page.keyboard.type('invalid');
                await tabToSelector(settings.page, '#bridgeSave', 200); await settings.page.keyboard.press('Enter');
                await settings.page.waitForSelector('#bridgeStatus[data-state="error"]');
                const notice = await settings.page.evaluate(readThemeSamples, ['#bridgePeerId', '#bridgeSave', '#bridgeStatus']); notice.forEach(value => assertThemeSample(value));
                assert.deepEqual(await read(), beforeNotice, 'Invalid companion ID changes only its visible validation notice.');
                evidence.screenshots.push(await captureRequiredSpaceScreenshot(screenshot, settings.page, `space-theme-${mode}-settings-validation-notice`));
                await tabToSelector(settings.page, '#bridgePeerId', 200);
                await settings.page.keyboard.down('Control'); try { await settings.page.keyboard.press('KeyA'); } finally { await settings.page.keyboard.up('Control'); }
                await settings.page.keyboard.press('Backspace'); await settings.page.keyboard.type(originalPeer);
                const focus = await settings.page.$eval('#bridgePeerId', node => ({ focused: node === document.activeElement, width: parseFloat(getComputedStyle(node).outlineWidth), style: getComputedStyle(node).outlineStyle, color: getComputedStyle(node).outlineColor }));
                assert.equal(focus.focused, true); assert(focus.width >= 2 && focus.style !== 'none');
                assert(computedThemeContrast(focus.color, notice[0].backgrounds) >= 3);
                await checkpoint('settings-validation-and-focus', { notice, focus });
                await settings.page.reload({ waitUntil: 'domcontentloaded' });
                await settings.page.waitForSelector('#themeMode:not([disabled])');
                const firstPaint = await poll(() => settings.page.evaluate(() => globalThis.__themeFirstPaint), value => accepted(data => assertThemeFirstPaint(data, mode, mode), value), 'recorded Settings first paint matches saved explicit appearance');
                await checkpoint('settings-first-paint', { mode, firstPaint });
            });
        }
        // Full graphemes and a deliberately long name are entered through the same real editors.
        await selectTarget();
        const longName = 'Theme alignment with a deliberately long Space name that must yield to archive and menu controls';
        const openHeaderEditor = async label => input(`Open ${label} for header geometry`, async () => {
            await rightClickFreshSpaceTrigger(native.page, '.space.active .space-options');
            await native.page.waitForSelector('.space-context-menu', { visible: true }); await clickText('.space-context-menu', label);
            await native.page.waitForSelector('.space-editor', { visible: true });
        });
        await openHeaderEditor('Rename'); const beforeName = await read();
        await input('Enter a long Space name with actual keyboard input', async () => {
            await tabToSelector(native.page, '.space-editor input');
            await native.page.keyboard.down('Control'); try { await native.page.keyboard.press('KeyA'); } finally { await native.page.keyboard.up('Control'); }
            await native.page.keyboard.press('Backspace'); await native.page.keyboard.type(longName); await native.page.keyboard.press('Enter');
        }); await closed();
        await poll(read, state => accepted(value => assertThemeHeaderSaved(beforeName, value, { spaceId: target.id, changes: { name: longName } }), state), 'exact long header name saved');
        for (const glyph of ['👩🏽‍💻', '👨‍👩‍👧‍👦', '🇺🇳', null]) {
            await openHeaderEditor('Change Space Icon'); const beforeIcon = await read();
            await input('Save complete header emoji using keyboard text input or clear preset', async () => { if (glyph) { await replaceSpaceEmojiWithInput(native.page, glyph, 'keyboard'); await native.page.keyboard.press('Enter'); } else await native.page.click('[data-choice="none"]'); });
            await closed(); await poll(read, state => accepted(value => assertThemeHeaderSaved(beforeIcon, value, { spaceId: target.id, changes: { icon: glyph } }), state), 'whole header grapheme saved');
            for (const size of [12, 16, 20]) {
                await ui(settings.page, 'Choose header size through the actual Settings range', () => setAppearanceControl(settings.page, 'spaceHeaderSize', size));
                await poll(() => native.page.evaluate(readThemeHeaderGeometry), state => state?.fontSize === size, 'header size reached native panel');
                // A real click on the already-selected chip makes the name intentionally unfocused.
                await selectTarget();
                const geometry = assertThemeHeaderGeometry(await native.page.evaluate(readThemeHeaderGeometry), { glyph, name: longName, size });
                await capture(`space-theme-header-${glyph ? Array.from(glyph).map(c => c.codePointAt(0).toString(16)).join('-') : 'cleared'}-${size}`);
                await input('Focus the same editable header name with real Tab', () => tabToSelector(native.page, '.space.active .space-name', 200));
                const focused = assertThemeHeaderGeometry(await native.page.evaluate(readThemeHeaderGeometry), { glyph, name: longName, size, focused: true });
                await checkpoint('header-geometry', { geometry, focused });
            }
        }
        await ui(settings.page, 'Restore header size before theme reload proof', () => setAppearanceControl(settings.page, 'spaceHeaderSize', original.appearance?.spaceHeaderSize || 16));
        // Preset resets the custom field but still emits only a Chrome named color.
        await selectTarget(); await open(); const beforePreset = await read();
        await input('Choose the named purple preset', () => native.page.click('[data-choice="purple"]')); await closed();
        await poll(read, state => accepted(value => assertThemeMetadataSaved(beforePreset, value, { spaceId: target.id, windowId, changes: { color: 'purple', customTint: null } }), state), 'named preset and native projection remain compatible');
        await save('#000000'); await setMode('system'); await selectTarget();
        await input('Select header text using real keyboard', async () => { await tabToSelector(native.page, '.space.active .space-name', 200); await native.page.keyboard.press('Home'); await native.page.keyboard.down('Shift'); try { await native.page.keyboard.press('End'); } finally { await native.page.keyboard.up('Shift'); } });
        const focusBefore = await native.page.evaluate(readThemeFocus, '.space.active .space-name');
        for (const systemDark of [false, true, false]) {
            await native.page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: systemDark ? 'dark' : 'light' }]);
            await settings.page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: systemDark ? 'dark' : 'light' }]);
            const settingsResolved = await poll(() => settings.page.evaluate(readThemeState), state => state.mode === 'system' && state.resolved === (systemDark ? 'dark' : 'light'), 'Settings also follows live System preference');
            const resolved = await poll(() => native.page.evaluate(readThemeState), state => accepted(value => assertThemeResolved(value, { mode: 'system', tint: '#000000', systemDark }), state), 'live System media change');
            assertThemeFocusKept(focusBefore, await native.page.evaluate(readThemeFocus, '.space.active .space-name'));
            await checkpoint('system-live-and-focus-kept', { resolved, settingsResolved, focusBefore });
        }
        for (const mode of ['light', 'dark']) {
            await setMode(mode);
            assertThemeFocusKept(focusBefore, await native.page.evaluate(readThemeFocus, '.space.active .space-name'));
            await native.page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: mode === 'light' ? 'dark' : 'light' }]);
            const resolved = await poll(() => native.page.evaluate(readThemeState), state => accepted(value => assertThemeResolved(value, { mode, tint: '#000000', systemDark: mode === 'light' }), state), 'explicit mode ignores opposite media preference');
            await checkpoint('explicit-mode-kept', { resolved });
        }
        await native.page.emulateMediaFeatures([]); await settings.page.emulateMediaFeatures([]);
        const beforeReload = await read();
        await input('Reload native sidebar document', () => native.page.reload({ waitUntil: 'domcontentloaded' }));
        await native.page.waitForSelector('.space.active .space-name', { visible: true });
        const afterReload = await poll(read, state => accepted(value => assertThemeReload(beforeReload, value), state), 'exact theme metadata survives native sidebar document reload');
        await checkpoint('native-sidebar-document-reload', { before: beforeReload, after: afterReload });
        await selectTarget(); await open();
        assert.equal(await native.page.$eval(THEME_HEX_INPUT, node => node.value), '#000000');
        await capture('space-theme-persisted-editor-after-document-reload'); await input('Close persisted tint editor', () => native.page.keyboard.press('Escape'));
        await ui(settings.page, 'Reload Settings and verify persisted Dark mode', () => settings.page.reload({ waitUntil: 'domcontentloaded' }));
        await settings.page.waitForFunction(() => document.querySelector('#themeMode:not([disabled])')?.value === 'dark');
        assert.equal((await settings.page.evaluate(readThemeState)).resolved, 'dark');
        await checkpoint('space-theme-complete'); return evidence;
    } catch (error) {
        primaryError = error; await checkpoint('space-theme-failed', { error: { message: error.message, stack: error.stack } }).catch(() => {}); throw error;
    } finally {
        if (original) await finishBookmarkFixture([
            async () => { if (native) { await native.page.emulateMediaFeatures([]); await native.close(); } },
            async () => { // Exact-owned fixture cleanup, not acceptance input or broad storage replacement.
                const cleanup = await newTabPage(`chrome-extension://${arcifyId}/options.html`, windowId); ownedTabs.push(cleanup.tab.id);
                await ui(cleanup.page, 'Pause native sync while removing exact owned theme fixture data', () => setThemeGroupSync(cleanup.page, false));
                await poll(() => cleanup.page.evaluate(() => chrome.storage.sync.get('syncTabGroups')), data => data.syncTabGroups === false, 'cleanup sync is disabled');
                for (const favoriteId of ownedFavorites) await requestScopedFavorite(cleanup.page, windowId, 'remove', { favoriteId });
                await ui(cleanup.page, 'Restore prior profile appearance mode and header size', async () => { await chooseThemeMode(cleanup.page, original.appearance?.themeMode || 'system'); await setAppearanceControl(cleanup.page, 'spaceHeaderSize', original.appearance?.spaceHeaderSize || 16); });
                await poll(() => cleanup.page.evaluate(() => chrome.storage.local.get('sidebarAppearance')), data => data.sidebarAppearance?.themeMode === (original.appearance?.themeMode || 'system') && data.sidebarAppearance?.spaceHeaderSize === (original.appearance?.spaceHeaderSize || 16), 'cleanup appearance writes finish before closing the owned page');
            },
            () => apiPage.evaluate(async ({ spaceId, color, customTint, name, icon }) => { const reply = await chrome.runtime.sendMessage({ type: 'spaceStore', action: 'metadata', spaceId, changes: { color, customTint, name, icon } }); if (!reply.success) throw Error(reply.error); }, { spaceId: target.id, color: original.space.color, customTint: original.space.customTint ?? null, name: original.space.name, icon: original.space.icon ?? null }),
            () => apiPage.evaluate(async ids => { for (const id of ids) await chrome.bookmarks.remove(id); }, ownedBookmarks),
            () => apiPage.evaluate(async ids => { const live = new Set((await chrome.tabs.query({})).map(tab => tab.id)); const present = ids.filter(id => live.has(id)); if (present.length) await chrome.tabs.remove(present); }, ownedTabs),
            () => apiPage.evaluate(async ({ activeSpaces, activeTabs }) => { for (const [windowId, spaceId] of Object.entries(activeSpaces)) { const reply = await chrome.runtime.sendMessage({ type: 'spaceStore', action: 'activate', windowId: Number(windowId), spaceId }); if (!reply.success) throw Error(reply.error); } const live = new Set((await chrome.tabs.query({})).map(tab => tab.id)); for (const id of activeTabs) if (live.has(id)) await chrome.tabs.update(id, { active: true }); }, original),
            async () => { if (beforeFixture) {
                await restoreThemeNativeFixture(apiPage, beforeFixture);
                await ui(apiPage, 'Restore original native group sync setting', async () => { await apiPage.reload({ waitUntil: 'domcontentloaded' }); await setThemeGroupSync(apiPage, beforeFixture.sync.syncTabGroups === true); });
                // Restore focus after the explicit settings/cleanup operations.
                await apiPage.evaluate(async ({ activeTabs, focusedWindowId }) => { for (const id of activeTabs) await chrome.tabs.update(id, { active: true }); if (focusedWindowId !== undefined) await chrome.windows.update(focusedWindowId, { focused: true }); }, original);
                await restoreThemeLastTabs(apiPage, beforeFixture.spaces);
                await checkpoint('before-theme-cleanup-assertion', { before: beforeFixture, after: await read() });
                const restored = await poll(read, state => accepted(value => assertThemeFixtureRestored(beforeFixture, value, target.id), state), 'exact original theme fixture state restored');
                await checkpoint('theme-fixture-restored', { before: beforeFixture, after: restored });
            } }
        ], primaryError, async cleanup => { evidence.cleanup = cleanup; await record(structuredClone(evidence)); });
    }
}
