/** Mandatory case-37 real-input helpers. Importing this file never launches Chrome. */
import assert from 'node:assert/strict';
import { tabToSelector } from './paired-chrome-sidebar-appearance.mjs';
import { locateFreshDragGeometry } from './paired-chrome-ui.mjs';
import { favoriteDragInputClient } from './paired-chrome-favorites-marker.mjs';
import { installSpaceDragObservation, readSpaceDragObservation, assertAcceptedSpaceDragover,
    readSpaceDropMarker, assertSpaceDropMarker, readMarkerScreenshotPixels, assertMarkerScreenshotPixels } from './paired-chrome-space-marker.mjs';

const PRESET_GLYPHS = Object.freeze({ home: '🏠', work: '💼', star: '⭐', heart: '❤️', book: '📚', code: '💻', idea: '💡', rocket: '🚀', globe: '🌐', leaf: '🌿', music: '🎵', art: '🎨', camera: '📷', coffee: '☕', travel: '✈️', fitness: '🏃', science: '🔬', game: '🎮', shopping: '🛍️', sun: '☀️' });

export const EMOJI_INPUT_SELECTOR = '.space-emoji-form input';
export const SPACE_EMOJI_EXAMPLES = Object.freeze([
    { name: 'zwj-skin-tone', value: '👩🏽‍💻', route: 'keyboard', submit: 'Enter' },
    { name: 'regional-flag', value: '🇺🇳', route: 'paste', submit: 'button' },
    { name: 'variation-selector', value: '✈️', route: 'paste', submit: 'Enter' },
    { name: 'skin-tone', value: '👍🏽', route: 'keyboard', submit: 'button' },
    { name: 'trimmed-zwj-flag', value: '  🏳️‍🌈  ', saved: '🏳️‍🌈', route: 'paste', submit: 'Enter' }
]);

export function assertSpaceIconInputEnvironment(env = process.env, uid = process.getuid?.()) {
    assert.equal(env.GITHUB_ACTIONS, 'true'); assert.equal(env.CI, 'true');
    assert.notEqual(uid, 0, 'Space icon input fixture never disables Chrome sandboxing.');
}

// Passive listeners retain native input provenance and exact UTF-16 text. They
// neither synthesize events nor repair focus, values, validation or composition.
export function installSpaceEmojiInputObservation() {
    globalThis.__spaceEmojiInputObservation?.stop?.();
    const events = [];
    const types = ['keydown', 'keyup', 'beforeinput', 'input', 'paste', 'compositionstart', 'compositionupdate', 'compositionend', 'submit'];
    const observe = event => {
        if (!event.target.closest?.('.space-emoji-form')) return;
        events.push({ type: event.type, trusted: event.isTrusted, key: event.key ?? null,
            ctrlKey: Boolean(event.ctrlKey), inputType: event.inputType ?? null, data: event.data ?? null,
            composing: Boolean(event.isComposing), value: document.querySelector('.space-emoji-form input')?.value ?? null });
    };
    for (const type of types) document.addEventListener(type, observe, { capture: true, passive: true });
    globalThis.__spaceEmojiInputObservation = { events,
        stop: () => { for (const type of types) document.removeEventListener(type, observe, true); } };
}
export function readSpaceEmojiEditor() {
    const input = document.querySelector('.space-emoji-form input'), form = input?.closest('form');
    if (!input || !form) return null;
    const hint = document.getElementById(input.getAttribute('aria-describedby'));
    const button = form.querySelector('button[type="submit"]');
    const status = input.closest('.space-editor').querySelector('[role="alert"]');
    const rect = input.getBoundingClientRect(), style = getComputedStyle(input);
    return { value: input.value, label: input.closest('label')?.firstChild?.textContent, type: input.type,
        maxLength: input.maxLength, disabled: input.disabled, invalid: input.getAttribute('aria-invalid'),
        describedBy: input.getAttribute('aria-describedby'), hint: hint?.textContent,
        save: button?.textContent, saveDisabled: button?.disabled, alert: status?.textContent, alertRole: status?.getAttribute('role'),
        visible: Boolean(input.getClientRects().length && style.display !== 'none' && style.visibility === 'visible'),
        focused: document.activeElement === input, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        viewport: { width: innerWidth, height: innerHeight }, events: [...(globalThis.__spaceEmojiInputObservation?.events || [])] };
}
export function assertSpaceEmojiEditor(state, { value, invalid = false, focused = true }) {
    assert(state); assert.equal(state.value, value); assert.equal(state.label, 'Emoji'); assert.equal(state.type, 'text');
    assert.equal(state.maxLength, -1, 'Complete Unicode graphemes must not be truncated by a UTF-16 maxlength.');
    assert.equal(state.disabled, false); assert.equal(state.save, 'Save emoji'); assert.equal(state.saveDisabled, false);
    assert.equal(state.describedBy, 'spaceEmojiHint'); assert.match(state.hint, /one emoji/); assert.match(state.hint, /empty.*remove/);
    assert.equal(state.visible, true); if (focused) assert.equal(state.focused, true);
    const { rect, viewport } = state;
    for (const number of [...Object.values(rect), ...Object.values(viewport)]) assert(Number.isFinite(number));
    assert(rect.width > 0 && rect.height > 0 && rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= viewport.width + 1 && rect.y + rect.height <= viewport.height + 1);
    assert.equal(state.invalid, invalid ? 'true' : null); assert.equal(state.alertRole, 'alert');
    if (invalid) assert.match(state.alert, /one complete emoji/); else assert.equal(state.alert, '');
    return state;
}
export function assertSpaceEmojiInputEvents(events, { value, route }) {
    assert(['keyboard', 'paste'].includes(route)); assert(Array.isArray(events) && events.length > 0);
    assert(events.every(event => event.trusted === true), 'Synthetic input cannot establish native emoji handling.');
    const inputs = events.filter(event => event.type === 'input');
    assert(inputs.length > 0); assert.equal(inputs.at(-1).value, value, 'The whole grapheme must reach the actual input unchanged.');
    assert(events.some(event => event.type === 'keydown' && event.ctrlKey && event.key?.toLowerCase() === 'a'));
    assert(events.some(event => event.type === 'beforeinput'));
    if (route === 'paste') {
        assert.equal(events.filter(event => event.type === 'paste').length, 1);
        assert(events.some(event => event.type === 'keydown' && event.ctrlKey && event.key?.toLowerCase() === 'v'));
        assert(inputs.some(event => event.inputType === 'insertFromPaste' && event.value === value));
    } else {
        assert.equal(events.filter(event => event.type === 'paste').length, 0);
        assert(inputs.some(event => event.inputType === 'insertText'));
    }
    return events;
}
export async function replaceSpaceEmojiWithInput(page, value, route) {
    assert(['keyboard', 'paste'].includes(route));
    await tabToSelector(page, EMOJI_INPUT_SELECTOR);
    await page.evaluate(installSpaceEmojiInputObservation);
    // This is a disposable CI clipboard, using the extension's existing
    // clipboardWrite permission. No clipboard read/grant or fake paste event.
    if (route === 'paste') await page.evaluate(text => navigator.clipboard.writeText(text), value);
    await page.keyboard.down('Control');
    try { await page.keyboard.press('KeyA'); } finally { await page.keyboard.up('Control'); }
    if (route === 'paste') {
        await page.keyboard.down('Control');
        try { await page.keyboard.press('KeyV'); } finally { await page.keyboard.up('Control'); }
    } else {
        await page.keyboard.press('Backspace');
        await page.keyboard.type(value);
    }
    await page.waitForFunction(expected => document.querySelector('.space-emoji-form input')?.value === expected, { polling: 50 }, value);
    const state = assertSpaceEmojiEditor(await page.evaluate(readSpaceEmojiEditor), { value });
    assertSpaceEmojiInputEvents(state.events, { value, route }); return state;
}

export async function exerciseSpaceEmojiInput({ page, target, ui, read, open, closed, saveProof, unchanged, projection, capture, poll, record }) {
    assertSpaceIconInputEnvironment();
    const evidence = { entries: [], nativeTextInput: true, nativePaste: true, physicalKeyboard: false,
        ime: 'OS emoji picker and IME candidate/composition behavior remain manual; no synthetic composition evidence.' };
    const save = async ({ name, value, saved = value, route, submit }) => {
        await open(); const before = await read();
        const entered = await ui(page, `Enter complete ${name} emoji through ${route}`, async () => {
            const state = await replaceSpaceEmojiWithInput(page, value, route);
            await capture(page, `space-emoji-${name}-entered`);
            if (submit === 'Enter') await page.keyboard.press('Enter');
            else await page.click('.space-emoji-form button[type="submit"]');
            return state;
        });
        await closed();
        const after = await poll(read, state => state.spaces.find(space => space.id === target.id)?.icon === saved && state.registry[target.bookmarkFolderId]?.icon === saved, `exact ${name} emoji saved`);
        const proof = saveProof(before, after, { spaceId: target.id, icon: saved });
        const rendered = await projection(saved);
        assert.equal(await page.$eval(`#spaceSwitcher button[data-space-id="${target.id}"]`, node => node === document.activeElement), true);
        const result = { name, value, saved, codePoints: Array.from(saved, character => `U+${character.codePointAt(0).toString(16).toUpperCase()}`), route, submit, entered, before, after, proof, rendered };
        evidence.entries.push(result); await record({ phase: 'space-emoji-saved', ...result });
    };
    for (const example of SPACE_EMOJI_EXAMPLES) await save(example);
    await open(); const beforeCancel = await read();
    evidence.cancelEntered = await ui(page, 'Paste a family ZWJ draft and cancel without saving', async () => {
        const entered = await replaceSpaceEmojiWithInput(page, '👨‍👩‍👧‍👦', 'paste');
        await capture(page, 'space-emoji-family-draft-before-cancel'); await page.keyboard.press('Escape'); return entered;
    });
    await closed(); evidence.cancel = { before: beforeCancel, after: await read() }; unchanged(beforeCancel, evidence.cancel.after);
    assert.equal(await page.$eval(`#spaceSwitcher button[data-space-id="${target.id}"]`, node => node === document.activeElement), true);
    await open(); const beforeInvalid = await read();
    await ui(page, 'Reject two complete emoji without silently truncating or persisting', async () => {
        await replaceSpaceEmojiWithInput(page, '🚀⭐', 'keyboard'); await page.keyboard.press('Enter');
        await page.waitForSelector('.space-emoji-form input[aria-invalid="true"]');
        evidence.invalid = assertSpaceEmojiEditor(await page.evaluate(readSpaceEmojiEditor), { value: '🚀⭐', invalid: true });
        await capture(page, 'space-emoji-invalid-keeps-complete-input');
    });
    unchanged(beforeInvalid, await read());
    await ui(page, 'Clear the rejected emoji and save an empty input', async () => {
        await page.keyboard.down('Control');
        try { await page.keyboard.press('KeyA'); } finally { await page.keyboard.up('Control'); }
        await page.keyboard.press('Backspace');
        evidence.empty = assertSpaceEmojiEditor(await page.evaluate(readSpaceEmojiEditor), { value: '' });
        await page.keyboard.press('Enter');
    });
    await closed();
    const reset = await poll(read, state => state.spaces.find(space => space.id === target.id)?.icon === null && state.registry[target.bookmarkFolderId]?.icon === null, 'empty emoji reset saved');
    evidence.reset = { before: beforeInvalid, after: reset, proof: saveProof(beforeInvalid, reset, { spaceId: target.id, icon: null }), projection: await projection(null) };
    await save({ name: 'reload-zwj', value: '👩🏽‍💻', route: 'paste', submit: 'button' });
    const beforeReload = await read();
    await ui(page, 'Reload sidebar with a complete custom ZWJ emoji', () => page.reload({ waitUntil: 'domcontentloaded' }));
    evidence.reload = await projection('👩🏽‍💻'); unchanged(beforeReload, await read());
    await open();
    await ui(page, 'Verify reloaded custom emoji is editable and cancel with its button', async () => {
        await tabToSelector(page, EMOJI_INPUT_SELECTOR);
        evidence.reopened = assertSpaceEmojiEditor(await page.evaluate(readSpaceEmojiEditor), { value: '👩🏽‍💻' });
        await capture(page, 'space-emoji-reloaded-custom-value'); await page.click('.space-editor > button');
    });
    await closed(); unchanged(beforeReload, await read());
    await record({ phase: 'space-emoji-input-complete', ...evidence }); return evidence;
}

export function readSpaceNameAppearance() {
    const visible = node => Boolean(node && !node.hidden && node.getClientRects().length && getComputedStyle(node).display !== 'none' && getComputedStyle(node).visibility === 'visible');
    return { hideNames: document.documentElement.dataset.hideSpaceNames, viewport: { width: innerWidth, height: innerHeight },
        activeSpaceId: document.querySelector('.space.active')?.dataset.spaceId,
        chips: [...document.querySelectorAll('#spaceSwitcher button[data-space-id]')].map(button => {
            const name = button.querySelector('.space-switcher-name'), icon = button.querySelector('.space-icon'), fallback = button.querySelector('.space-icon-fallback');
            const rect = button.getBoundingClientRect();
            const header = [...document.querySelectorAll('.space[data-space-id]')].find(node => node.dataset.spaceId === button.dataset.spaceId);
            return { id: button.dataset.spaceId, name: name?.textContent, nameVisible: visible(name), title: button.title,
                aria: button.getAttribute('aria-label'), shortcuts: button.getAttribute('aria-keyshortcuts'), tag: button.tagName,
                disabled: button.disabled, draggable: button.draggable, tabIndex: button.tabIndex, active: button.classList.contains('active'),
                glyph: icon?.textContent || null, iconVisible: visible(icon), iconAriaHidden: icon?.getAttribute('aria-hidden') || null,
                fallback: fallback?.textContent || null, fallbackVisible: visible(fallback), fallbackAriaHidden: fallback?.getAttribute('aria-hidden') || null,
                headerName: header?.querySelector('.space-name')?.value,
                rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
        }) };
}
export function assertSpaceNameAppearance(state, { spaces, activeSpaceId, hidden }) {
    assert.equal(state.hideNames, String(hidden)); assert.equal(state.activeSpaceId, activeSpaceId);
    assert.deepEqual(state.chips.map(chip => chip.id), spaces.map(space => space.id));
    for (const [index, chip] of state.chips.entries()) {
        const space = spaces[index];
        assert.equal(chip.name, space.name); assert.equal(chip.headerName, space.name); assert.equal(chip.nameVisible, !hidden);
        assert.equal(chip.title, `${space.name}\nDrag to reorder. Keyboard: Alt+Shift+Left or Right. Right-click or Shift+F10 for Space options.`);
        assert.equal(chip.aria, `Switch to space ${space.name}`); assert.equal(chip.shortcuts, 'Alt+Shift+ArrowLeft Alt+Shift+ArrowRight Shift+F10');
        assert.equal(chip.tag, 'BUTTON'); assert.equal(chip.disabled, false); assert.equal(chip.draggable, true); assert.equal(chip.tabIndex, 0);
        assert.equal(chip.active, chip.id === activeSpaceId);
        assert.equal(chip.glyph, space.icon ? PRESET_GLYPHS[space.icon] || space.icon : null);
        assert.equal(chip.iconVisible, Boolean(chip.glyph));
        if (chip.glyph) { assert.equal(chip.iconAriaHidden, 'true'); assert.equal(chip.fallback, null); assert.equal(chip.fallbackVisible, false); }
        else { assert.equal(chip.fallback, '●'); assert.equal(chip.fallbackAriaHidden, 'true'); assert.equal(chip.fallbackVisible, hidden); }
        assert(Number.isFinite(chip.rect.width) && Number.isFinite(chip.rect.height));
        assert(chip.rect.height >= 32); if (hidden) assert.equal(chip.rect.width, 32);
    }
    return state;
}
export function assertSpaceChipAccessibility(snapshot, space) {
    assert(snapshot, 'Chrome must expose the exact Space button in its accessibility tree.');
    assert.equal(snapshot.role, 'button'); assert.equal(snapshot.name, `Switch to space ${space.name}`);
    assert.notEqual(snapshot.disabled, true); return snapshot;
}
async function readSpaceChipAccessibility(page, spaces) {
    const evidence = [];
    for (const space of spaces) {
        const button = await page.$(`#spaceSwitcher button[data-space-id="${space.id}"]`); assert(button);
        try { evidence.push({ spaceId: space.id, snapshot: assertSpaceChipAccessibility(await page.accessibility.snapshot({ root: button, interestingOnly: false }), space) }); }
        finally { await button.dispose(); }
    }
    return evidence;
}
export function assertDefaultSpaceAppearance(appearance) {
    assert.deepEqual(appearance, { favoritesLayout: 'standard', favoriteTileSize: 44, spaceHeaderSize: 16, hideSpaceNames: false, themeMode: 'system' });
}
export function assertSpaceAppearanceOnlyChanged(before, after, hidden) {
    const expected = structuredClone(before); assert(expected.appearance && typeof hidden === 'boolean');
    expected.appearance.hideSpaceNames = hidden;
    assert.deepEqual(after, expected, 'The options toggle may change only hideSpaceNames; all saved names, metadata, tabs, selection and ordering must survive.');
}
export function assertIconOnlySpaceReordered(before, after, order) {
    assert.equal(new Set(order).size, before.spaces.length);
    assert.deepEqual([...order].sort(), before.spaces.map(space => space.id).sort());
    const expected = structuredClone(before); expected.spaces = order.map(id => expected.spaces.find(space => space.id === id));
    assert.deepEqual(after, expected, 'Icon-only reordering may change only the exact Space array order.');
}
export function assertIconOnlySpaceActivated(before, after, { spaceId, windowId, tabId }) {
    const expected = structuredClone(before), space = expected.spaces.find(space => space.id === spaceId);
    assert(space); assert.notEqual(expected.activeSpaces[windowId], spaceId);
    const tab = expected.tabs.find(tab => tab.id === tabId); assert.equal(tab?.windowId, windowId);
    assert(space.temporaryTabs.includes(tabId));
    expected.activeSpaces[windowId] = spaceId; space.lastTab = tabId;
    for (const entry of expected.tabs.filter(tab => tab.windowId === windowId)) entry.active = entry.id === tabId;
    assert.deepEqual(after, expected, 'Clicking the icon-only chip may activate only its exact Space and owned tab in the acting window.');
}

// An in-viewport chip can still sit underneath the switcher's separate +
// control. Observe the actual center hit before the single native click; never
// substitute a DOM click, choose a different Space, or retry uncertain input.
export function readSpaceChipInputGeometry(spaceId) {
    const strip = document.getElementById('spaceSwitcher');
    const matches = [...(strip?.querySelectorAll('button[data-space-id]') || [])].filter(node => node.dataset.spaceId === spaceId);
    const chip = matches[0], add = document.querySelector('.add-space-toggle');
    const rect = node => { if (!node) return null; const { x, y, width, height } = node.getBoundingClientRect(); return { x, y, width, height }; };
    const box = rect(strip), target = rect(chip), overlay = rect(add);
    const visible = node => Boolean(node && node.getClientRects().length && getComputedStyle(node).visibility === 'visible' && getComputedStyle(node).display !== 'none');
    const hit = point => { const node = document.elementFromPoint(point.x, point.y); return {
        spaceId: node?.closest('#spaceSwitcher button[data-space-id]')?.dataset.spaceId || null,
        add: Boolean(node?.closest('.add-space-toggle')), inSwitcher: Boolean(node?.closest('#spaceSwitcher')),
        tag: node?.tagName || null, className: node?.getAttribute('class') || null }; };
    const center = target ? { x: target.x + target.width / 2, y: target.y + target.height / 2 } : null;
    const safeRight = box && overlay ? Math.min(innerWidth, box.x + box.width, overlay.x - 4) : null;
    const pointer = box && target ? { x: (Math.max(0, box.x) + safeRight) / 2, y: target.y + target.height / 2 } : null;
    return { spaceId, matches: matches.length, visibility: document.visibilityState, focused: document.hasFocus(),
        viewport: { width: innerWidth, height: innerHeight }, activeSpaceId: document.querySelector('.space.active')?.dataset.spaceId,
        chip: target && { ...target, visible: visible(chip) }, overlay: overlay && { ...overlay, visible: visible(add) },
        strip: box && { ...box, visible: visible(strip), scrollLeft: strip.scrollLeft, scrollWidth: strip.scrollWidth, clientWidth: strip.clientWidth },
        center: center && { ...center, hit: hit(center) }, pointer: pointer && { ...pointer, hit: hit(pointer) } };
}
export function planSpaceChipInputReveal(state, spaceId) {
    assert.equal(state.spaceId, spaceId); assert.equal(state.matches, 1);
    assert.equal(state.visibility, 'visible'); assert.equal(state.focused, true);
    for (const value of Object.values(state.viewport)) assert(Number.isFinite(value) && value >= 100);
    for (const box of [state.chip, state.strip, state.overlay]) {
        assert(box?.visible); for (const key of ['x', 'y', 'width', 'height']) assert(Number.isFinite(box[key]));
        assert(box.width > 0 && box.height > 0);
    }
    const { chip, strip, overlay, center, pointer, viewport } = state;
    assert.equal(center.x, chip.x + chip.width / 2); assert.equal(center.y, chip.y + chip.height / 2);
    assert(center.x > Math.max(0, strip.x) && center.x < Math.min(viewport.width, strip.x + strip.width));
    assert(chip.y >= Math.max(0, strip.y) && chip.y + chip.height <= Math.min(viewport.height, strip.y + strip.height));
    if (center.hit.spaceId === spaceId && !center.hit.add) return null;
    assert.equal(center.hit.add, true, 'Only the measured + overlay can authorize this horizontal reveal.');
    assert(center.x >= overlay.x && center.x <= overlay.x + overlay.width && center.y >= overlay.y && center.y <= overlay.y + overlay.height);
    for (const key of ['scrollLeft', 'scrollWidth', 'clientWidth']) assert(Number.isFinite(strip[key]));
    const max = strip.scrollWidth - strip.clientWidth, safeRight = Math.min(viewport.width, strip.x + strip.width, overlay.x - 4);
    assert(max > 0 && strip.scrollLeft >= 0 && strip.scrollLeft <= max);
    assert.equal(pointer.hit.inSwitcher, true); assert.equal(pointer.hit.add, false);
    assert(pointer.x > Math.max(0, strip.x) && pointer.x < safeRight && pointer.y > strip.y && pointer.y < strip.y + strip.height);
    const deltaX = Math.min(max - strip.scrollLeft, center.x - pointer.x);
    assert(deltaX > 0 && center.x - deltaX > Math.max(0, strip.x) && chip.x + chip.width - deltaX < safeRight,
        'One bounded horizontal wheel must fully uncover the same chip.');
    return { x: pointer.x, y: pointer.y, deltaX, deltaY: 0 };
}
export function assertSpaceChipInputRevealed(before, after, input) {
    assert.deepEqual(planSpaceChipInputReveal(before, before.spaceId), input);
    assert.equal(planSpaceChipInputReveal(after, before.spaceId), null, 'The final click center must hit the exact target chip.');
    for (const key of ['spaceId', 'matches', 'visibility', 'focused', 'viewport', 'activeSpaceId', 'overlay']) assert.deepEqual(after[key], before[key]);
    for (const key of ['x', 'y', 'width', 'height', 'visible', 'scrollWidth', 'clientWidth']) assert.equal(after.strip[key], before.strip[key]);
    for (const key of ['y', 'width', 'height', 'visible']) assert.equal(after.chip[key], before.chip[key]);
    const moved = after.strip.scrollLeft - before.strip.scrollLeft;
    assert(Math.abs(moved - (input?.deltaX || 0)) <= 1);
    if (input) assert(moved > 0);
    assert(Math.abs(after.chip.x - before.chip.x + moved) <= 1, 'The same chip must move with its actual scrollport.');
    return after;
}
export async function clickUnobscuredSpaceChip({ page, spaceId, read, unchanged, poll, capture, record }) {
    const baseline = await read(), before = await page.evaluate(readSpaceChipInputGeometry, spaceId);
    await record({ phase: 'space-chip-before-native-input', before });
    const input = planSpaceChipInputReveal(before, spaceId), evidence = { before, input };
    await page.evaluate(() => {
        const events = globalThis.__spaceChipNativeInput = [];
        const observe = event => events.push({ type: event.type, trusted: event.isTrusted, x: event.clientX, y: event.clientY,
            deltaX: event.deltaX ?? null, deltaY: event.deltaY ?? null,
            spaceId: event.target.closest?.('#spaceSwitcher button[data-space-id]')?.dataset.spaceId || null,
            inSwitcher: Boolean(event.target.closest?.('#spaceSwitcher')), add: Boolean(event.target.closest?.('.add-space-toggle')) });
        for (const type of ['wheel', 'mousedown', 'mouseup', 'click']) document.addEventListener(type, observe, { capture: true, passive: true });
        globalThis.__stopSpaceChipNativeInput = () => { for (const type of ['wheel', 'mousedown', 'mouseup', 'click']) document.removeEventListener(type, observe, true); };
    });
    try {
        if (input) {
            await page.mouse.move(input.x, input.y); await page.mouse.wheel({ deltaX: input.deltaX, deltaY: 0 });
            evidence.revealed = await poll(() => page.evaluate(readSpaceChipInputGeometry, spaceId), state => {
                try { assertSpaceChipInputRevealed(before, state, input); return true; } catch { return false; }
            }, 'one measured horizontal wheel uncovers the exact Space chip from the + overlay');
        } else evidence.revealed = before;
        unchanged(baseline, await read());
        evidence.screenshot = await capture(page, 'space-icon-only-exact-chip-unobscured-before-selection');
        const ready = assertSpaceChipInputRevealed(before, await page.evaluate(readSpaceChipInputGeometry, spaceId), input);
        unchanged(baseline, await read());
        await record({ phase: 'space-chip-ready-for-single-click', ...evidence, ready });
        await page.mouse.click(ready.center.x, ready.center.y);
        const events = await page.evaluate(() => globalThis.__spaceChipNativeInput);
        evidence.events = events; await record({ phase: 'space-chip-observed-native-input', ...evidence });
        assert(events.every(event => event.trusted));
        const wheels = events.filter(event => event.type === 'wheel'); assert.equal(wheels.length, input ? 1 : 0);
        if (input) { assert.equal(wheels[0].inSwitcher, true); assert.equal(wheels[0].add, false); assert.equal(wheels[0].deltaY, 0); assert(Math.abs(wheels[0].deltaX - input.deltaX) <= 1); }
        for (const type of ['mousedown', 'mouseup', 'click']) {
            const matches = events.filter(event => event.type === type); assert.equal(matches.length, 1);
            assert.equal(matches[0].spaceId, spaceId); assert.equal(matches[0].add, false);
            assert(Math.abs(matches[0].x - ready.center.x) <= 1 && Math.abs(matches[0].y - ready.center.y) <= 1);
        }
        evidence.events = events; await record({ phase: 'space-chip-single-native-click', ...evidence }); return evidence;
    } finally { await page.evaluate(() => globalThis.__stopSpaceChipNativeInput()); }
}

async function dragIconOnlySpace({ page, sourceId, anchorId, ui, poll, capture, screenshotBytes, record }) {
    const selector = id => `#spaceSwitcher button[data-space-id="${id}"]`;
    return ui(page, 'Drag adjacent icon-only Space chips with native mouse input', async () => {
        const { source, target, from, to } = await locateFreshDragGeometry(page, selector(sourceId), selector(anchorId), record);
        let held = false, primaryError;
        await page.evaluate(installSpaceDragObservation);
        try {
            const x = from.x + from.width / 2, y = from.y + from.height / 2, tx = to.x + 2, ty = to.y + to.height / 2;
            const hits = await page.evaluate(({ x, y, tx, ty, sourceSelector, targetSelector }) => ({
                source: Boolean(document.elementFromPoint(x, y)?.closest(sourceSelector)), target: Boolean(document.elementFromPoint(tx, ty)?.closest(targetSelector))
            }), { x, y, tx, ty, sourceSelector: selector(sourceId), targetSelector: selector(anchorId) });
            assert(hits.source && hits.target, 'Real drag points must hit the exact visible source and target chips.');
            await page.mouse.move(x, y); await page.mouse.down(); held = true;
            await page.mouse.move(x, y - 12, { steps: 5 }); await page.mouse.move(tx, ty, { steps: 20 });
            const previous = await page.evaluate(readSpaceDragObservation);
            const destination = { sourceSpaceId: sourceId, anchorSpaceId: anchorId, placement: 'before', x: tx + 1, y: ty, after: previous.events.at(-1)?.at ?? -1 };
            await page.mouse.move(destination.x, destination.y, { steps: 2 });
            const accepted = await poll(() => page.evaluate(readSpaceDragObservation), state => {
                try { assertAcceptedSpaceDragover(state, destination); return true; } catch { return false; }
            }, 'fresh accepted native dragover on exact icon-only chip');
            const marker = assertSpaceDropMarker(await page.evaluate(readSpaceDropMarker), destination);
            const shot = await capture(page, 'space-icon-only-native-drag-painted-marker');
            const paint = assertMarkerScreenshotPixels(await page.evaluate(readMarkerScreenshotPixels,
                { base64: (await screenshotBytes(shot)).toString('base64'), marker }), marker);
            assert.deepEqual(assertSpaceDropMarker(await page.evaluate(readSpaceDropMarker), destination).rect, marker.rect);
            assertAcceptedSpaceDragover(await page.evaluate(readSpaceDragObservation), destination);
            await page.mouse.up(); held = false;
            const released = await poll(() => page.evaluate(readSpaceDragObservation), state => state.marker?.hidden === true && state.events.some(event => event.type === 'dragend'), 'icon-only native drag completed');
            for (const type of ['dragstart', 'drop', 'dragend']) assert.equal(released.events.filter(event => event.type === type && event.trusted).length, 1);
            const evidence = { from, to, hits, accepted, marker, paint, screenshot: shot, released };
            await record({ phase: 'space-icon-only-drag', ...evidence }); return evidence;
        } catch (error) { primaryError = error; throw error; }
        finally {
            await finishIconOnlySpaceDrag({ held, primaryError,
                read: () => page.evaluate(readSpaceDragObservation),
                cancel: () => favoriteDragInputClient(page).send('Input.cancelDragging'),
                ended: () => poll(() => page.evaluate(readSpaceDragObservation), state => state.events.some(event => event.type === 'dragend' && event.trusted), 'failed icon-only drag cancellation'),
                release: () => page.mouse.up(), dispose: [() => source.dispose(), () => target.dispose()] });
        }
    });
}

// Cleanup is not an input retry. Never release an uncertain active drag onto a
// destination; retain the first failure and always dispose geometry handles.
export async function finishIconOnlySpaceDrag({ held, primaryError, read, cancel, ended, release, dispose }) {
    const errors = [];
    if (held) try {
        const state = await read();
        if (state.events.some(event => event.type === 'dragstart' && event.trusted)) {
            await cancel();
            const stopped = await ended();
            assert(stopped.events.some(event => event.type === 'dragend' && event.trusted), 'Cleanup requires a witnessed trusted dragend.');
            assert(!stopped.events.some(event => event.type === 'drop'), 'Failure cancellation must not perform a drop.');
        }
        await release();
    } catch (error) { errors.push(error.message); }
    for (const close of dispose) try { await close(); } catch (error) { errors.push(error.message); }
    if (errors.length) {
        if (primaryError) primaryError.dragCleanupErrors = errors;
        else throw Error(`Icon-only drag cleanup failed: ${errors.join('; ')}`);
    }
}

export async function exerciseSpaceIconOnlySwitcher({ apiPage, pages, windowIds, ui, read, unchanged, capture, screenshotBytes, poll, record, whileHidden }) {
    assertSpaceIconInputEnvironment();
    const evidence = { realOptionsInput: true, nativePanel: false, tooltip: 'Real hover plus retained title attribute; native browser tooltip painting remains manual.' };
    const inspect = async hidden => {
        const state = await read(), renders = [];
        for (const [index, page] of pages.entries()) {
            const expected = { spaces: state.spaces, activeSpaceId: state.activeSpaces[windowIds[index]], hidden };
            const rendered = await poll(() => page.evaluate(readSpaceNameAppearance), view => {
                try { assertSpaceNameAppearance(view, expected); return true; } catch { return false; }
            }, `complete icon-only projection in window ${windowIds[index]}`);
            renders.push(assertSpaceNameAppearance(rendered, expected));
        }
        return renders;
    };
    const set = async hidden => ui(apiPage, `Set icon-only Space switcher to ${hidden} through options keyboard`, async () => {
        await apiPage.waitForFunction(() => document.getElementById('hideSpaceNames')?.disabled === false, { polling: 50 });
        const before = await read();
        assert.equal(await apiPage.$eval('#hideSpaceNames', node => node.checked), !hidden);
        assert.equal(await apiPage.$eval('#hideSpaceNames', node => node.getAttribute('role')), 'switch');
        await tabToSelector(apiPage, '#hideSpaceNames'); await apiPage.keyboard.press('Space');
        const after = await poll(read, state => state.appearance?.hideSpaceNames === hidden, 'exact icon-only option saved');
        assertSpaceAppearanceOnlyChanged(before, after, hidden);
        assert.equal(await apiPage.$eval('#hideSpaceNames', node => node.checked), hidden);
        await capture(apiPage, `space-icon-only-options-${hidden}`); return { before, after };
    });
    let primaryError;
    try {
        const initial = await read();
        assertDefaultSpaceAppearance(initial.appearance);
        evidence.default = await inspect(false); evidence.enabled = await set(true); evidence.hidden = await inspect(true);
        evidence.hiddenAccessibility = await readSpaceChipAccessibility(pages[0], initial.spaces);
        assert(evidence.hidden[0].chips.some(chip => chip.glyph), 'Include a real saved icon.');
        assert(evidence.hidden[0].chips.some(chip => !chip.glyph), 'Include an iconless legacy Space fallback.');
        const page = pages[0];
        await ui(page, 'Hover and focus a named icon-only Space chip', async () => {
            const chip = `#spaceSwitcher button[data-space-id="${initial.spaces[0].id}"]`;
            await tabToSelector(page, chip); await page.hover(chip);
            evidence.hover = assertSpaceNameAppearance(await page.evaluate(readSpaceNameAppearance), { spaces: initial.spaces, activeSpaceId: initial.activeSpaces[windowIds[0]], hidden: true });
            await capture(page, 'space-icon-only-narrow-hover-and-focus');
        });
        unchanged(evidence.enabled.after, await read());
        await ui(apiPage, 'Reload actual options after icon-only selection', () => apiPage.reload({ waitUntil: 'domcontentloaded' }));
        await apiPage.waitForFunction(() => document.getElementById('hideSpaceNames')?.checked && !document.getElementById('hideSpaceNames').disabled, { polling: 50 });
        await ui(pages[1], 'Reload second-window sidebar with icon-only preference', () => pages[1].reload({ waitUntil: 'domcontentloaded' }));
        evidence.reload = await inspect(true); unchanged(evidence.enabled.after, await read());
        const beforeDrag = await read(), order = beforeDrag.spaces.map(space => space.id);
        assert(order.length >= 2);
        const sourceId = order[1], anchorId = order[0], reordered = [sourceId, anchorId, ...order.slice(2)];
        evidence.drag = await dragIconOnlySpace({ page, sourceId, anchorId, ui, poll, capture, screenshotBytes, record });
        const afterDrag = await poll(read, state => JSON.stringify(state.spaces.map(space => space.id)) === JSON.stringify(reordered), 'icon-only persisted native drag order');
        assertIconOnlySpaceReordered(beforeDrag, afterDrag, reordered); evidence.reordered = await inspect(true);
        await ui(page, 'Restore icon-only Space order with Alt+Shift+Right', async () => {
            await tabToSelector(page, `#spaceSwitcher button[data-space-id="${sourceId}"]`);
            await page.keyboard.down('Alt'); await page.keyboard.down('Shift');
            try { await page.keyboard.press('ArrowRight'); } finally { await page.keyboard.up('Shift'); await page.keyboard.up('Alt'); }
            const restored = await poll(read, state => JSON.stringify(state.spaces.map(space => space.id)) === JSON.stringify(order), 'icon-only exact keyboard reorder restoration');
            unchanged(beforeDrag, restored); evidence.keyboardRestored = restored;
            assert.equal(await page.$eval(`#spaceSwitcher button[data-space-id="${sourceId}"]`, node => node === document.activeElement), true);
            await capture(page, 'space-icon-only-keyboard-order-restored');
        });
        await inspect(true);
        // Existing exact-target selection, visible header/folder evidence, and
        // No icon reset now execute while icon-only mode is actually enabled.
        await whileHidden(); evidence.afterSelectionAndReset = await inspect(true);
        evidence.disabled = await set(false); evidence.namesRestored = await inspect(false);
        evidence.reenabled = await set(true);
        await ui(apiPage, 'Reset sidebar appearance through its actual button', async () => {
            const before = await read(); await apiPage.click('#resetSidebarAppearance');
            const after = await poll(read, state => state.appearance?.hideSpaceNames === false, 'appearance reset restores names');
            assertSpaceAppearanceOnlyChanged(before, after, false); evidence.reset = { before, after };
        });
        evidence.resetProjection = await inspect(false);
        evidence.resetAccessibility = await readSpaceChipAccessibility(pages[0], (await read()).spaces);
        await ui(page, 'Capture switcher names restored by appearance reset', () => capture(page, 'space-icon-only-reset-restores-names'));
        unchanged(evidence.reset.after, await read());
        await ui(apiPage, 'Reload options after icon-only default reset', () => apiPage.reload({ waitUntil: 'domcontentloaded' }));
        await apiPage.waitForFunction(() => document.getElementById('hideSpaceNames')?.checked === false && !document.getElementById('hideSpaceNames').disabled, { polling: 50 });
        unchanged(evidence.reset.after, await read());
        await record({ phase: 'space-icon-only-complete', ...evidence }); return evidence;
    } catch (error) { primaryError = error; await record({ phase: 'space-icon-only-failed', ...evidence, error: error.message }); throw error; }
    finally {
        try { if ((await read()).appearance?.hideSpaceNames === true) await set(false); }
        catch (error) { if (primaryError) primaryError.appearanceCleanupError = error.message; else throw error; }
    }
}
