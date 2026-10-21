/** Passive evidence and trusted-input choreography. Importing never launches Chrome. */
import assert from 'node:assert/strict';

// Runs in the actual page. This observer does not dispatch events, focus anything,
// mutate product state, or restore a menu that disappeared during observation.
export function observeExternalMenuFocus({ menuSelector = null, targetSelector = null }) {
    globalThis.__pairedMenuFocus?.stop();
    const events = [];
    const read = () => ({ url: location.href, timeOrigin: performance.timeOrigin,
        visibility: document.visibilityState, focused: document.hasFocus(),
        menuCount: menuSelector ? document.querySelectorAll(menuSelector).length : null,
        targetCount: targetSelector ? document.querySelectorAll(targetSelector).length : null,
        targetFocused: targetSelector ? document.activeElement === document.querySelector(targetSelector) : null,
        targetValue: targetSelector ? document.querySelector(targetSelector)?.value : null,
        events: [...events] });
    const record = event => {
        if (events.length >= 100) return;
        events.push({ type: event.type, trusted: event.isTrusted, key: event.key || null,
            visibility: document.visibilityState, focused: document.hasFocus(),
            targetMatches: targetSelector ? event.target === document.querySelector(targetSelector) : null });
    };
    const windowEvents = ['blur', 'focus', 'pagehide'], documentEvents = ['visibilitychange', 'click', 'keydown'];
    for (const name of windowEvents) window.addEventListener(name, record);
    for (const name of documentEvents) document.addEventListener(name, record, true);
    globalThis.__pairedMenuFocus = { read, stop() {
        for (const name of windowEvents) window.removeEventListener(name, record);
        for (const name of documentEvents) document.removeEventListener(name, record, true);
    } };
    return read();
}
export function readExternalMenuFocus() { return globalThis.__pairedMenuFocus.read(); }
export function stopExternalMenuFocus() { globalThis.__pairedMenuFocus?.stop(); }

export function assertExternalMenuOpened(state) {
    assert.match(state.url, /^chrome-extension:\/\/[^/]+\/sidebar\.html$/);
    assert.equal(state.menuCount, 1, 'The exact menu must exist before leaving the sidebar.');
    assert.equal(state.visibility, 'visible'); assert.equal(state.focused, true);
}
export function assertExternalMenuDismissed({ before, source, destinationBefore, destination }, { requireKey = true } = {}) {
    assertExternalMenuOpened(before);
    assert.equal(destinationBefore.targetCount, 1);
    assert.match(destinationBefore.url, /^http:\/\/127\.0\.0\.1(?::\d+)?\/tab-menu\/[a-f0-9]{32}\/outside$/);
    assert.equal(source.url, before.url); assert.equal(source.timeOrigin, before.timeOrigin, 'Dismissal must not reload the sidebar.');
    assert.equal(source.menuCount, 0, 'The background sidebar must remove the menu without being foregrounded again.');
    assert.equal(source.focused, false, 'Menu cleanup must not steal external browser focus.');
    assert.equal(destination.url, destinationBefore.url); assert.equal(destination.timeOrigin, destinationBefore.timeOrigin, 'The external destination document must survive.');
    assert.equal(destination.targetCount, 1); assert.equal(destination.visibility, 'visible');
    assert.equal(destination.focused, true); assert.equal(destination.targetFocused, true, 'The clicked external input must retain focus.');
    assert.equal(destination.targetValue, destinationBefore.targetValue, 'Focus testing must not alter the external input.');
    const clicks = destination.events.filter(event => event.type === 'click');
    assert.equal(clicks.length, 1, 'External evidence requires one click, never a replay.');
    assert.equal(clicks[0].trusted, true); assert.equal(clicks[0].targetMatches, true);
    const keys = destination.events.filter(event => event.type === 'keydown');
    assert.equal(keys.length, requireKey ? 1 : 0);
    if (requireKey) { assert.equal(keys[0].key, 'ArrowLeft'); assert.equal(keys[0].trusted, true); assert.equal(keys[0].targetMatches, true); }
    const lifecycle = source.events.filter(event => event.trusted &&
        ((event.type === 'blur' && !event.focused) || (event.type === 'visibilitychange' && event.visibility === 'hidden')));
    assert(lifecycle.length, 'Require an observed real browser blur or hidden-document lifecycle, not synthetic events.');
    return lifecycle.some(event => event.type === 'blur' && event.visibility === 'visible')
        ? 'window blur while sidebar document remained visible' : 'hidden sidebar document lifecycle';
}

/** The caller has already right-clicked the real menu, and owns fixture cleanup. */
export async function exerciseExternalMenuDismissal({ sidebar, destination, menuSelector, label, ui, screenshot, poll, record = async () => {} }) {
    assert.notEqual(sidebar, destination, 'External dismissal needs a separate browser page.');
    const evidence = { surface: 'regular sidebar.html tab', nativePanel: false, label, menuSelector,
        input: 'Real browser page foreground, one trusted mouse click and one trusted ArrowLeft', screenshots: [] };
    const read = async () => ({ before: evidence.before, destinationBefore: evidence.destinationBefore,
        source: await sidebar.evaluate(readExternalMenuFocus), destination: await destination.evaluate(readExternalMenuFocus) });
    const capture = async (page, suffix) => {
        const result = await screenshot(page, `outside-focus-${label}-${suffix}`, true, { fullPage: false });
        assert(result?.filename?.endsWith('.png'), 'External focus evidence requires a successful screenshot.');
        assert.equal(result.label, `outside-focus-${label}-${suffix}`); assert.equal(result.url, page.url());
        assert(Number.isFinite(Date.parse(result.capturedAt)), 'Required screenshot needs its capture timestamp.');
        evidence.screenshots.push(result);
    };
    try {
        evidence.before = await sidebar.evaluate(observeExternalMenuFocus, { menuSelector });
        evidence.destinationBefore = await destination.evaluate(observeExternalMenuFocus, { targetSelector: '#page-state' });
        assertExternalMenuOpened(evidence.before);
        assert.equal(evidence.destinationBefore.targetCount, 1);
        await capture(sidebar, 'menu-open');
        assertExternalMenuOpened(await sidebar.evaluate(readExternalMenuFocus));
        await record({ phase: 'outside-focus-before-input', ...evidence });
        await ui(destination, `Focus external fixture for ${label} with one real click`, async () => {
            await destination.waitForSelector('#page-state', { visible: true });
            await destination.click('#page-state');
        });
        // No ui(sidebar), bringToFront, click or focus call is allowed during
        // dismissal observation. Screenshot only the already-focused destination.
        await poll(() => sidebar.evaluate(readExternalMenuFocus), state => state.menuCount === 0,
            `outside focus removes ${label} menu while sidebar stays in the background`);
        evidence.afterClick = await read();
        assertExternalMenuDismissed(evidence.afterClick, { requireKey: false });
        // Do not foreground again: that would conceal a cleanup focus theft.
        await destination.keyboard.press('ArrowLeft');
        evidence.afterKey = await read();
        evidence.lifecycle = assertExternalMenuDismissed(evidence.afterKey);
        await capture(destination, 'destination-retains-focus');
        evidence.afterScreenshot = await read();
        assertExternalMenuDismissed(evidence.afterScreenshot);
        await record({ phase: 'outside-focus-dismissed', ...evidence });
        return evidence;
    } catch (error) {
        await record({ phase: 'outside-focus-failed', ...evidence, error: error.message }).catch(() => {});
        throw error;
    } finally {
        await Promise.all([sidebar, destination].map(page => page.evaluate(stopExternalMenuFocus).catch(() => {})));
    }
}

/** Read-only full identity baseline; deliberately includes every browser window. */
export async function readMenuPreservedState() {
    const bookmark = ({ id, parentId, index, title, url, children }) => ({ id, parentId, index, title,
        ...(url === undefined ? {} : { url }), ...(children ? { children: children.map(bookmark) } : {}) });
    const local = await chrome.storage.local.get(['spaces', 'spaceRegistry', 'persistentFavorites', 'pinnedTabStatesById', 'tabNameOverridesById']);
    return { local, session: await chrome.storage.session.get(['activeSpaces', 'favoriteSession', 'spaceSession']),
        bookmarks: (await chrome.bookmarks.getTree()).map(bookmark),
        tabs: (await chrome.tabs.query({})).map(({ id, windowId, index, url, pendingUrl, title, pinned, active, groupId, mutedInfo }) =>
            ({ id, windowId, index, url, pendingUrl: pendingUrl || null, title, pinned, active, groupId, muted: Boolean(mutedInfo?.muted) })).sort((a, b) => a.id - b.id) };
}
