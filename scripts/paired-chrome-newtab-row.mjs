/** Native-panel New Tab evidence. Importing this module never launches Chrome. */
import assert from 'node:assert/strict';
import { tabToSelector, setAppearanceControl } from './paired-chrome-sidebar-appearance.mjs';
import { readNewTabReuseState } from './paired-chrome-newtab.mjs';
import { normalizeSidebarAppearance } from '../sidebar-appearance.js';
import { readSpotlightRows } from './paired-chrome-sidebar.mjs';
import { selectResultWithKeyboard } from './paired-chrome-ui.mjs';

export function assertFrozenTodayRowOrder(before, after, inverted) {
    assert.equal(before.inverted, String(inverted));
    assert.equal(after.inverted, String(inverted));
    assert.deepEqual(after.todayIds, before.todayIds, 'Changing saved pin order cannot reorder Today.');
}

// Read-only layout evidence from the actual native panel, never a replacement tab.
export function readTodayNewTabRow() {
    const box = node => { const r = node?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom } : null; };
    const visible = node => Boolean(node && node.getClientRects().length && getComputedStyle(node).display !== 'none' && getComputedStyle(node).visibility === 'visible');
    const row = document.querySelector('#newTabBtn'), active = document.querySelector('.space.active');
    const header = active?.querySelector('.temp-header'), list = active?.querySelector('[data-tab-type="temporary"]');
    return { count: document.querySelectorAll('#newTabBtn').length, buttons: document.querySelectorAll('.new-tab-btn').length,
        obsolete: document.querySelectorAll('#spotlightBtn').length, activeSpaceId: active?.dataset.spaceId,
        rowSpaceId: row?.closest('.space')?.dataset.spaceId, tag: row?.tagName, text: row?.textContent.trim(),
        visible: visible(row), disabled: row?.disabled, busy: row?.getAttribute('aria-busy'),
        insideSortable: Boolean(row?.closest('[data-tab-type="temporary"]')), draggable: row?.draggable,
        immediatelyAfterHeader: header?.nextElementSibling === row, immediatelyBeforeList: row?.nextElementSibling === list,
        row: box(row), header: box(header), list: box(list), viewport: { width: innerWidth, height: innerHeight },
        inverted: list?.dataset.todayOrderInverted, todayIds: [...(list?.querySelectorAll('.tab[data-tab-id]') || [])].map(node => Number(node.dataset.tabId)),
        visibleTodayIds: [...(list?.querySelectorAll('.tab[data-tab-id]') || [])].filter(visible).map(node => Number(node.dataset.tabId)),
        footerNotices: Boolean(document.querySelector('.new-tab-btn-container #spotlightStatus')) };
}

export function assertTodayNewTabRow(state, { spaceId, inverted, empty = false, requiredTabId = null }) {
    assert.equal(state.count, 1, 'The document must contain exactly one New Tab row.');
    assert.equal(state.buttons, 1); assert.equal(state.obsolete, 0);
    assert.equal(state.activeSpaceId, spaceId); assert.equal(state.rowSpaceId, spaceId);
    assert.equal(state.tag, 'BUTTON'); assert.match(state.text, /New Tab/);
    assert.equal(state.visible, true); assert.equal(state.disabled, false);
    assert.equal(state.insideSortable, false); assert.equal(state.draggable, false);
    assert.equal(state.immediatelyAfterHeader, true); assert.equal(state.immediatelyBeforeList, true);
    assert.equal(state.inverted, String(inverted)); assert.equal(state.footerNotices, true);
    for (const key of ['row', 'header', 'list']) assert(state[key] && Number.isFinite(state[key].y));
    assert(state.row.width >= 80 && state.row.height >= 24, 'The native row must have a usable hit target.');
    assert(state.row.y >= state.header.bottom - 1, 'New Tab must appear below Today’s divider.');
    assert(state.list.y >= state.row.bottom - 1, 'Today tabs must start below the New Tab row in either order.');
    assert(state.row.y >= 0 && state.row.bottom <= state.viewport.height && state.row.x >= 0 &&
        state.row.x + state.row.width <= state.viewport.width + 1, 'The full row must be inside the native panel viewport.');
    if (requiredTabId !== null) {
        assert.equal(state.todayIds.filter(id => id === requiredTabId).length, 1, 'The exact fallback tab must render once in Today.');
        assert(state.visibleTodayIds.includes(requiredTabId), 'The fallback Today row must be visible before its screenshot.');
    }
    if (empty) assert.deepEqual(state.todayIds, [], 'Empty-layout proof must have no Today rows.');
    return state;
}

export function assertNonemptyDraftSelection(state) {
    assert(state.input && Number.isInteger(state.input.start) && Number.isInteger(state.input.end) && state.input.start >= 0 &&
        state.input.start < state.input.end && state.input.end <= state.input.value.length, 'Reuse proof requires a real nonempty selected draft range.');
}

export function assertRowDraftPreserved(before, after, beforeIds, afterIds, extensionId) {
    assert.equal(before.url, `chrome-extension://${extensionId}/newtab.html`);
    assert.equal(after.url, before.url); assert.equal(after.timeOrigin, before.timeOrigin, 'Row reuse cannot reload the helper.');
    for (const key of ['id', 'windowId', 'url', 'incognito', 'pinned']) assert.equal(after.tab[key], before.tab[key], key);
    assert.equal(after.tab.active, true); assert.equal(after.tab.status, 'complete');
    assert(!after.tab.pendingUrl, 'Reuse cannot leave an outbound navigation.');
    assert(before.input?.value, 'Proof must start with an actual typed draft.');
    assertNonemptyDraftSelection(before);
    // Clicking the native panel intentionally transfers focus; content and caret
    // are conserved, without pretending the helper must retain document focus.
    const draft = state => ({ value: state.input.value, start: state.input.start, end: state.input.end, direction: state.input.direction });
    assert.deepEqual(draft(after), draft(before)); assert.deepEqual(after.selected, before.selected);
    assert.deepEqual([...afterIds].sort((a, b) => a - b), [...beforeIds].sort((a, b) => a - b), 'Repeated row launch cannot create or close any native tab.');
}

export function assertOrdinaryRowFallback(before, after, { windowId, spaceId }) {
    const previous = new Set(before.tabs.map(tab => tab.id)), created = after.tabs.filter(tab => !previous.has(tab.id));
    assert.equal(created.length, 1, 'Known-unpaired fallback must create exactly one native tab.');
    const added = created[0];
    assert.equal(added.windowId, windowId); assert.equal(added.active, true); assert.equal(added.incognito, false);
    assert(['chrome://newtab', 'chrome://newtab/'].includes(added.url), 'Fallback must use the ordinary browser New Tab provider.');
    assert.equal(before.activeSpaces[windowId], spaceId); assert.deepEqual(after.activeSpaces, before.activeSpaces);
    assert.equal(after.tabs.length, before.tabs.length + 1);
    for (const old of before.tabs) {
        const live = after.tabs.find(tab => tab.id === old.id); assert(live, 'Fallback cannot remove another tab.');
        for (const key of ['id', 'windowId', 'url', 'pinned', 'incognito']) assert.equal(live[key], old[key], key);
        if (old.windowId !== windowId) assert.deepEqual(live, old, 'Fallback cannot alter another window.');
    }
    const owners = after.spaces.filter(space => [...space.spaceBookmarks, ...space.temporaryTabs].includes(added.id)).map(space => space.id);
    assert.deepEqual(owners, [spaceId], 'The exact fallback tab must have one canonical owner: the originating Space.');
    return { tabId: added.id, windowId, spaceId, browserUrl: added.url, owners };
}

export function installNewTabRowTrace() {
    const events = [];
    const listener = event => {
        if (event.target.closest?.('#newTabBtn')) events.push({ type: event.type, key: event.key || null, trusted: event.isTrusted,
            busy: event.target.closest('#newTabBtn').getAttribute('aria-busy'), detail: event.detail || 0 });
    };
    for (const name of ['click', 'keydown']) document.addEventListener(name, listener, true);
    globalThis.__newTabRowTrace = { events, stop: () => { for (const name of ['click', 'keydown']) document.removeEventListener(name, listener, true); } };
}

// Input checkpoints must never replace the accumulated layout/draft/fallback proof.
export function recordNewTabRowEvidence(report, observation) {
    if (observation.phase === 'native-new-tab-input') {
        (report.nativeNewTabRowActions ||= []).push(structuredClone(observation));
        return;
    }
    assert.equal(observation.nativePanel, true); assert(Array.isArray(observation.layouts)); assert(Array.isArray(observation.reuse));
    report.nativeNewTabRow = structuredClone(observation);
}

// Removing a bookmark folder alone does not remove its canonical Space. Use the
// same production delete operation as Space management, only for our exact empty
// fixture, then observe authoritative convergence before global isolation gates.
export async function cleanupNewTabFixtureSpace({ apiPage, folder, snapshot, poll }) {
    assert(folder && typeof folder.spaceId === 'string' && folder.spaceId && typeof folder.folderId === 'string' && folder.folderId);
    await apiPage.evaluate(async ({ spaceId, folderId }) => {
        const state = await chrome.runtime.sendMessage({ type: 'spaceStore', action: 'get' });
        if (!state.success) throw new Error(state.error);
        const matches = state.spaces.filter(space => space.id === spaceId);
        if (matches.length !== 1 || matches[0].bookmarkFolderId !== folderId) throw new Error('Refusing cleanup of an unverified New Tab fixture Space.');
        const members = new Set([...matches[0].spaceBookmarks, ...matches[0].temporaryTabs]);
        if ((await chrome.tabs.query({})).some(tab => members.has(tab.id))) throw new Error('Refusing cleanup while the New Tab fixture Space still owns a live tab.');
        const removed = await chrome.runtime.sendMessage({ type: 'spaceStore', action: 'delete', spaceId });
        if (!removed.success) throw new Error(removed.error);
    }, folder);
    const state = await poll(snapshot, state => state.spaces.every(space => space.id !== folder.spaceId && space.bookmarkFolderId !== folder.folderId),
        'authoritative removal of the exact New Tab fixture Space');
    return { ...folder, authoritativeSpaceIds: state.spaces.map(space => space.id) };
}

export async function exerciseNativeNewTabRow({ page, helper, apiPage, peerPage, spotlightId, windowId, snapshot, poll,
    ui, search, activate, screenshot, record }) {
    const initial = await snapshot(), settings = await apiPage.evaluate(() => chrome.storage.sync.get('invertTabOrder'));
    const appearance = normalizeSidebarAppearance(await apiPage.evaluate(async () => (await chrome.storage.local.get('sidebarAppearance')).sidebarAppearance));
    const representation = await apiPage.evaluate(async () => (await chrome.storage.local.get('todayOrderRepresentation')).todayOrderRepresentation);
    assert.equal(representation?.version, 1); assert.equal(typeof representation.inverted, 'boolean');
    const inverted = representation.inverted;
    const evidence = { nativePanel: true, todayOrderRepresentation: representation, layouts: [], reuse: [] };
    let folder, fallback, disconnected = false, primaryError;
    const read = () => apiPage.evaluate(async () => ({ tabs: (await chrome.tabs.query({})).map(({ id, windowId, url, pinned, incognito, active }) =>
        ({ id, windowId, url, pinned, incognito, active })).sort((a, b) => a.id - b.id),
        activeSpaces: (await chrome.storage.session.get('activeSpaces')).activeSpaces || {},
        spaces: (await chrome.storage.local.get('spaces')).spaces || [] }));
    const input = async (label, action) => {
        const hosting = await page.evaluate(async () => ({ tab: await chrome.tabs.getCurrent() || null,
            windowId: (await chrome.windows.getCurrent()).id, visibility: document.visibilityState }));
        assert.equal(hosting.tab, null); assert.equal(hosting.windowId, windowId); assert.equal(hosting.visibility, 'visible');
        await record({ phase: 'native-new-tab-input', label, hosting }); return action();
    };
    const focusWindow = () => apiPage.evaluate(windowId => chrome.windows.update(windowId, { focused: true }), windowId);
    const option = async value => {
        await ui(apiPage, 'Set saved pin order for New Tab row independence proof', async () => {
            if (await apiPage.$eval('#invertTabOrder', node => node.checked) !== value) await apiPage.click('label.toggle-label[for="invertTabOrder"]');
        });
        await poll(() => apiPage.evaluate(() => chrome.storage.sync.get('invertTabOrder')), state => Boolean(state.invertTabOrder) === value, 'persisted saved pin order');
        await focusWindow();
    };
    const compact = async (favoritesLayout, spaceHeaderSize) => {
        await ui(apiPage, 'Set native New Tab row density through appearance controls', async () => {
            await setAppearanceControl(apiPage, 'favoritesLayout', favoritesLayout);
            await setAppearanceControl(apiPage, 'spaceHeaderSize', spaceHeaderSize);
        });
        await page.waitForFunction(({ favoritesLayout, spaceHeaderSize }) => document.documentElement.dataset.favoritesLayout === favoritesLayout &&
            document.documentElement.dataset.spaceHeaderSize === String(spaceHeaderSize), { polling: 50 }, { favoritesLayout, spaceHeaderSize });
        await focusWindow();
    };
    const layout = async (label, spaceId, inverted, empty = false, requiredTabId = null) => {
        const state = await poll(() => page.evaluate(readTodayNewTabRow), state => {
            try { assertTodayNewTabRow(state, { spaceId, inverted, empty, requiredTabId }); return true; } catch { return false; }
        }, `native New Tab row layout: ${label}`);
        const shot = await screenshot(page, `native-new-tab-row-${label}`, true, { fullPage: false });
        assert(shot?.filename, 'Native row evidence requires a screenshot.');
        evidence.layouts.push({ label, ...state, screenshot: shot.filename }); await record(structuredClone(evidence)); return state;
    };
    const settled = () => page.waitForFunction(() => document.querySelector('#newTabBtn')?.getAttribute('aria-busy') === 'false' &&
        document.querySelector('#spotlightStatus')?.textContent === '', { polling: 50 });
    const reconnect = async () => {
        await ui(apiPage, 'Restore exact Spotlight pairing after fallback proof', async () => {
            await apiPage.type('#bridgePeerId', spotlightId); await apiPage.click('#bridgeSave');
            await apiPage.waitForSelector('#bridgeStatus[data-state="connected"]');
        }); disconnected = false;
    };
    try {
        await page.evaluate(installNewTabRowTrace);
        await option(false); const firstLayout = await layout('saved-normal', initial.activeSpaceId, inverted);
        await option(true); const secondLayout = await layout('saved-inverted', initial.activeSpaceId, inverted);
        assertFrozenTodayRowOrder(firstLayout, secondLayout, inverted);
        await compact('compact', 12); await layout('compact-saved-inverted', initial.activeSpaceId, inverted);
        await search(helper.page, 'retained native New Tab draft');
        await poll(() => helper.page.evaluate(readSpotlightRows), rows => rows.some(row => row.type === 'search-query' && row.title === 'Search for "retained native New Tab draft"'), 'draft search result rendered');
        const field = await helper.page.$('[data-testid="spotlight-input"]');
        await ui(helper.page, 'Give the Spotlight draft a real caret selection', async () => {
            await selectResultWithKeyboard(field, () => helper.page.evaluate(readSpotlightRows), row => row.type === 'search-query' && row.title === 'Search for "retained native New Tab draft"');
            // Spotlight consumes Home for result navigation. Left remains native
            // text editing, so select backwards from the freshly typed end.
            await helper.page.keyboard.down('Shift');
            try { await field.press('ArrowLeft'); await field.press('ArrowLeft'); } finally { await helper.page.keyboard.up('Shift'); }
            assertNonemptyDraftSelection(await helper.page.evaluate(readNewTabReuseState));
        }); await field.dispose();
        for (const method of ['double-click', 'Enter']) {
            const before = await helper.page.evaluate(readNewTabReuseState), beforeIds = (await read()).tabs.map(tab => tab.id);
            assertNonemptyDraftSelection(before);
            const traceStart = await page.evaluate(() => globalThis.__newTabRowTrace.events.length);
            await input(`Activate native New Tab with ${method}`, async () => {
                if (method === 'double-click') await page.click('#newTabBtn', { count: 2 });
                else {
                    // Click the Today header to enter the native document, then
                    // traverse to the real row with trusted Tab input.
                    await page.click('.space.active .temp-header');
                    await tabToSelector(page, '#newTabBtn'); await page.keyboard.press('Enter');
                }
            });
            await settled();
            const after = await helper.page.evaluate(readNewTabReuseState), afterIds = (await read()).tabs.map(tab => tab.id);
            assertRowDraftPreserved(before, after, beforeIds, afterIds, spotlightId);
            const trace = await page.evaluate(start => globalThis.__newTabRowTrace.events.slice(start), traceStart);
            assert(trace.length && trace.every(event => event.trusted));
            assert(trace.some(event => event.type === 'click'));
            if (method === 'double-click') {
                assert.equal(trace.filter(event => event.type === 'click').length, 2, 'Both rapid trusted activations must be observed.');
                assert(trace.some(event => event.type === 'click' && event.busy === 'true'), 'A repeated trusted click must arrive while the first launch is still pending.');
            }
            if (method === 'Enter') assert(trace.some(event => event.type === 'keydown' && event.key === 'Enter'));
            evidence.reuse.push({ method, before, after, trace }); await record(structuredClone(evidence));
        }
        // A real empty bookmark-backed Space, created only as disposable setup.
        folder = await apiPage.evaluate(async () => {
            const root = (await chrome.bookmarks.search({ title: 'Arcify' })).find(node => !node.url);
            const folder = await chrome.bookmarks.create({ parentId: root.id, title: 'New Tab row empty fixture' });
            const state = await chrome.runtime.sendMessage({ type: 'spaceStore', action: 'get' });
            if (!state.success) throw new Error(state.error);
            return { folderId: folder.id, spaceId: state.spaces.find(space => space.bookmarkFolderId === folder.id).id };
        });
        await page.waitForSelector(`#spaceSwitcher > button[data-space-id="${folder.spaceId}"]`);
        await input('Select genuinely empty Space', () => page.click(`#spaceSwitcher > button[data-space-id="${folder.spaceId}"]`));
        await poll(snapshot, state => state.activeSpaceId === folder.spaceId, 'empty current Space');
        await layout('empty-saved-inverted', folder.spaceId, inverted);
        await option(false);
        await input('Keep empty Space selected after returning from options', () => page.click(`#spaceSwitcher > button[data-space-id="${folder.spaceId}"]`));
        await poll(snapshot, state => state.activeSpaceId === folder.spaceId, 'empty current Space after options');
        await layout('empty-saved-normal', folder.spaceId, inverted);
        await apiPage.evaluate(id => chrome.bookmarks.update(id, { title: 'New Tab row renamed fixture' }), folder.folderId);
        await page.waitForFunction(spaceId => document.querySelector(`.space[data-space-id="${spaceId}"] .space-name`)?.value === 'New Tab row renamed fixture', { polling: 50 }, folder.spaceId);
        await layout('empty-after-metadata-repaint', folder.spaceId, inverted);
        await ui(apiPage, 'Disconnect companion through real Arcify options', async () => {
            await apiPage.click('#bridgeDisconnect'); await apiPage.waitForSelector('#bridgeStatus[data-state="disabled"]');
        }); disconnected = true;
        await focusWindow();
        await input('Keep empty Space selected after disconnect', () => page.click(`#spaceSwitcher > button[data-space-id="${folder.spaceId}"]`));
        await poll(read, state => state.activeSpaces[windowId] === folder.spaceId, 'empty current Space after disconnect');
        const beforeFallback = await read();
        await input('Open one ordinary New Tab while companion is disconnected', () => page.click('#newTabBtn'));
        await settled();
        const afterFallback = await poll(read, state => state.tabs.length === beforeFallback.tabs.length + 1 &&
            state.tabs.some(tab => !beforeFallback.tabs.some(old => old.id === tab.id) && ['chrome://newtab', 'chrome://newtab/'].includes(tab.url)), 'one ordinary browser New Tab');
        fallback = { tabId: afterFallback.tabs.find(tab => !beforeFallback.tabs.some(old => old.id === tab.id)).id };
        fallback = assertOrdinaryRowFallback(beforeFallback, afterFallback, { windowId, spaceId: folder.spaceId });
        // Existing provider stays installed; no settings/security policy is changed.
        const provider = await apiPage.evaluate(id => chrome.tabs.get(id), fallback.tabId);
        assert.equal(provider.url, 'chrome://newtab/');
        const providerContext = await poll(() => peerPage.evaluate(async id => (await chrome.runtime.getContexts({ contextTypes: ['TAB'] })).find(context => context.tabId === id), fallback.tabId),
            context => context?.documentUrl === `chrome-extension://${spotlightId}/newtab.html`, 'installed provider handling the browser New Tab');
        evidence.fallback = { ...fallback, actualPairingDisconnected: true, existingNewTabOverridePreserved: true, providerContext, before: beforeFallback, after: afterFallback };
        await layout('fallback-complete', folder.spaceId, inverted, false, fallback.tabId);
        const reconnectDraft = await helper.page.evaluate(readNewTabReuseState);
        await reconnect(); await activate(helper.tab.id);
        await poll(snapshot, state => state.activeSpaceId === initial.activeSpaceId, 'original helper Space after reconnect');
        await layout('reconnected-original-space', initial.activeSpaceId, inverted);
        await settled();
        const stable = await read();
        assert.equal(stable.tabs.length, afterFallback.tabs.length, 'Reconnecting must not replay an old fallback.');
        await input('Reuse existing draft after reconnect', () => page.click('#newTabBtn'));
        await settled();
        const afterReconnect = await read(), retainedDraft = await helper.page.evaluate(readNewTabReuseState);
        assert.deepEqual(afterReconnect.tabs.map(tab => tab.id), stable.tabs.map(tab => tab.id), 'A later successful launch cannot add a stale fallback.');
        assertRowDraftPreserved(reconnectDraft, retainedDraft, stable.tabs.map(tab => tab.id), afterReconnect.tabs.map(tab => tab.id), spotlightId);
        evidence.reconnected = { draft: retainedDraft, noDeferredFallback: true };
        await record(structuredClone(evidence));
        return evidence;
    } catch (error) { primaryError = error; throw error; }
    finally {
        const cleanups = [
            () => page.evaluate(() => globalThis.__newTabRowTrace?.stop()),
            async () => { if (disconnected) await reconnect(); },
            async () => { if (fallback) await apiPage.evaluate(id => chrome.tabs.remove(id), fallback.tabId); },
            () => option(Boolean(settings.invertTabOrder)),
            () => compact(appearance.favoritesLayout, appearance.spaceHeaderSize),
            async () => {
                await input('Restore initial Space after row proof', () => page.click(`#spaceSwitcher > button[data-space-id="${initial.activeSpaceId}"]`));
                await poll(snapshot, state => state.activeSpaceId === initial.activeSpaceId, 'original current Space restored');
            },
            async () => { if (folder) evidence.cleanup = await cleanupNewTabFixtureSpace({ apiPage, folder, snapshot, poll }); }
        ];
        const errors = [];
        for (const cleanup of cleanups) try { await cleanup(); } catch (error) { errors.push(error.message); }
        if (errors.length) evidence.cleanupErrors = errors;
        try { await record(structuredClone(evidence)); } catch (error) { errors.push(`Could not save cleanup evidence: ${error.message}`); }
        if (errors.length) { if (primaryError) primaryError.cleanupErrors = errors; else throw new Error(`New Tab fixture cleanup failed: ${errors.join('; ')}`); }
    }
}
