/** Mandatory hosted-only Spotlight native Split proof. Importing never launches Chrome. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spotlightSurface } from './paired-chrome-keyboard.mjs';
import { clickFreshResult } from './paired-chrome-ui.mjs';
import { readSpotlightRows } from './paired-chrome-sidebar.mjs';
import { assertNativeSplitCapability, assertNativeSplitPair, readNativeSplitPage } from './paired-chrome-native-split.mjs';
import { createNavigationFixturePage, installNavigationGroupObservation } from './paired-chrome-spotlight-navigation.mjs';
import { installSpotlightActionApiObservation } from './paired-chrome-spotlight-actions.mjs';
import { finishBookmarkFixture } from './paired-chrome-bookmark-selection.mjs';
import { mergeVisibleOrder } from '../sidebar-tabs.js';
export const SPOTLIGHT_SPLIT_CASE_NAME = 'Spotlight Split and End Split keep exact left and right source panes and original documents';
export const SPLIT_FEATURES = Object.freeze(['globalFavoritesV1', 'splitActionsV1']);
const exact = (values, id) => { const matches = values.filter(value => value.id === id); assert.equal(matches.length, 1); return matches[0]; };
const copy = value => structuredClone(value);
export function serveSpotlightSplitFixture(request, response) {
    const match = /^\/spotlight-split\/([a-f0-9]{32})\/(left|right|middle|other|twin)$/.exec(new URL(request.url, 'http://127.0.0.1').pathname);
    if (!match) return false;
    const color = match[2] === 'left' ? '#f8d7da' : match[2] === 'right' ? '#d3f4e0' : '#e8e8ff';
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'none'" });
    response.end(`<!doctype html><html><head><title>Split ${match[2]} ${match[1]}</title><link rel="icon" href="data:,"><style>html,body{margin:0;min-height:100%;background:${color};font:20px system-ui}main{padding:36px}input{font:inherit;width:90%}</style></head><body data-document-id="${randomBytes(16).toString('hex')}"><main><h1>Spotlight Split ${match[2]}</h1><label>Original draft <input id="split-input" value="retained"></label></main></body></html>`);
    return true;
}
export function installSpotlightSplitInputObservation() {
    globalThis.__splitInput?.stop(); const events = [], cleanup = [];
    parent.__spotlightSplitInputs = events;
    for (const type of ['click', 'keydown']) {
        const listener = event => {
            const row = event.target.closest?.('[data-testid="spotlight-result"]') || document.querySelector('[data-testid="spotlight-result"].selected');
            events.push({ type, key: event.key || null, trusted: event.isTrusted, repeat: Boolean(event.repeat), composing: Boolean(event.isComposing),
                keyCode: event.keyCode ?? null, button: event.button ?? null, ctrl: Boolean(event.ctrlKey), alt: Boolean(event.altKey), meta: Boolean(event.metaKey), shift: Boolean(event.shiftKey),
                resultType: row?.dataset.resultType || null, title: row?.querySelector('.arcify-spotlight-result-title')?.textContent || null,
                inPrompt: Boolean(event.target.closest?.('.arcify-split-action-prompt')), targetId: Number(event.target.closest?.('[data-split-target-id]')?.dataset.splitTargetId) || null,
                confirm: event.target.hasAttribute?.('data-split-confirm') || false, cancel: event.target.hasAttribute?.('data-split-cancel') || false });
        };
        document.addEventListener(type, listener, true); cleanup.push(() => document.removeEventListener(type, listener, true));
    }
    globalThis.__splitInput = { events, stop: () => cleanup.forEach(remove => remove()) };
}
export function assertSpotlightSplitInput(events, { command, targetId, method, cancelled = false }) {
    assert(events.length); assert(events.every(event => event.trusted && !event.repeat && !event.composing && event.keyCode !== 229 && !event.ctrl && !event.alt && !event.meta && !event.shift));
    const activate = event => event.type === 'click' ? event.button === 0 : event.key === 'Enter';
    const rows = events.filter(event => !event.inPrompt && event.resultType === 'arcify-split-action' && activate(event));
    assert.equal(rows.length, 1, 'Exactly one trusted result activation; no retries.');
    assert.equal(rows[0].title, command === 'createSplitView' ? 'Split current tab' : 'End Split');
    assert.equal(rows[0].type, method === 'Enter' ? 'keydown' : 'click');
    if (cancelled) {
        assert.equal(events.filter(event => event.inPrompt && (event.cancel && event.type === 'click' || event.key === 'Escape')).length, 1);
        assert(!events.some(event => event.inPrompt && event.confirm && activate(event))); return;
    }
    if (command === 'createSplitView') {
        assert.equal(events.filter(event => event.inPrompt && event.targetId === targetId && event.type === 'click' && event.button === 0).length, 1, 'Exact target requires a separate trusted explicit selection.');
        assert.equal(events.filter(event => event.inPrompt && event.confirm && activate(event)).length, 1, 'Exactly one confirmation after selection.');
    } else assert(!events.some(event => event.inPrompt));
}
export function assertSpotlightSplitRequest(events, { command, sourceTabId, targetId, windowId, spotlightId }) {
    const mutations = events.filter(event => event.type === 'external' && !['hello', 'snapshot', 'splitActionContext', 'tabActionContext', 'actionContext', 'navigationContext', 'archiveContext'].includes(event.data.message.command));
    assert.equal(mutations.length, 1, 'One visible command dispatches one immutable mutation, never fallback or replay.');
    const { message, sender } = mutations[0].data;
    assert.equal(sender.id, spotlightId); assert.equal(message.type, 'arcify-bridge'); assert.equal(message.version, 1); assert.match(message.requestId, /^[\w.:-]{1,80}$/);
    assert.equal(message.command, command); assert.equal(message.windowId, windowId); assert.equal(message.context.windowId, windowId); assert.equal(message.context.sourceTabId, sourceTabId);
    assert.equal(message.context.tab.id, sourceTabId); assert.deepEqual(message.supportedFeatures, SPLIT_FEATURES);
    assert.deepEqual(Object.keys(message).sort(), ['type', 'version', 'requestId', 'command', 'windowId', 'supportedFeatures', 'context', ...(command === 'createSplitView' ? ['target'] : [])].sort());
    if (command === 'createSplitView') assert.equal(message.target.id, targetId);
    else assert.deepEqual(message.context.pair.map(tab => tab.id).sort((a, b) => a - b), [sourceTabId, targetId].sort((a, b) => a - b));
    return message;
}
export function assertSpotlightSplitSource(events, request, sourceUrl) {
    const dispatches = events.filter(event => event.type === 'internal' && event.data.message.action === 'arcifySplitAction');
    assert.equal(dispatches.length, 1, 'One browser-attested content source must dispatch the action.');
    const { message, sender } = dispatches[0].data;
    assert.equal(sender.tab?.id, request.context.sourceTabId); assert.equal(sender.tab?.windowId, request.windowId);
    assert.equal(sender.url, sourceUrl); assert.equal(sender.frameId, 0);
    assert.equal(message.command, request.command); assert.deepEqual(message.scope.context, request.context);
    return dispatches[0].data;
}
export function assertSpotlightSplitCommitted(before, after, request, events) {
    const context = request.context, create = request.command === 'createSplitView';
    const pair = (create ? [context.tab, request.target] : context.pair).sort((a, b) => a.index - b.index), ids = pair.map(tab => tab.id);
    const receipts = after.journal.filter(entry => entry.fingerprint === JSON.stringify(request)); assert.equal(receipts.length, 1);
    const response = receipts[0].response; assert.equal(response?.ok, true); assert.equal(response.requestId, request.requestId); assert.equal(response.role, 'arcify');
    const splitId = create ? exact(after.tabs, ids[0]).splitViewId : -1;
    const reordered = create && pair[1].index !== pair[0].index + 1;
    assert.deepEqual(response.splitResult, { action: create ? 'create' : 'end', windowId: context.windowId, spaceId: context.spaceId, sourceTabId: context.sourceTabId, tabIds: ids, splitViewId: splitId, reordered });
    if (create) assertNativeSplitPair(after, { tabIds: ids, windowId: context.windowId, spaceId: context.spaceId, splitViewId: splitId });
    else { assertNativeSplitPair(before, { tabIds: ids, windowId: context.windowId, spaceId: context.spaceId }); assert(ids.every(id => exact(after.tabs, id).splitViewId === -1)); }
    assert.equal(exact(before.tabs, context.sourceTabId).active, true); assert.equal(exact(after.tabs, context.sourceTabId).active, true, 'The same left/right source remains active; no focus compensation.');
    assert(before.windows.some(window => window.id === context.windowId && window.focused));
    const expectedTabs = copy(before.tabs), local = expectedTabs.filter(tab => tab.windowId === context.windowId).sort((a, b) => a.index - b.index);
    if (reordered) { const moved = local.splice(local.findIndex(tab => tab.id === ids[1]), 1)[0]; local.splice(local.findIndex(tab => tab.id === ids[0]) + 1, 0, moved); local.forEach((tab, index) => { tab.index = index; }); }
    for (const tab of expectedTabs) if (ids.includes(tab.id)) tab.splitViewId = splitId;
    assert.deepEqual(after.tabs, expectedTabs, 'Only the exact pair split membership and minimal adjacency move may change.');
    const spaces = copy(before.spaces), space = exact(spaces, context.spaceId);
    if (reordered) {
        const inWindow = new Set(local.map(tab => tab.id)), visible = space.temporaryTabs.filter(id => inWindow.has(id) && id !== ids[1]);
        visible.splice(visible.indexOf(ids[0]) + 1, 0, ids[1]); space.temporaryTabs = mergeVisibleOrder(space.temporaryTabs, visible);
    }
    assert.deepEqual(after.spaces, spaces, 'Other-window Today slots and every other Space retain their order.');
    for (const key of ['windows', 'activeSpaces', 'bookmarks', 'bindings', 'aliases', 'favorites', 'favoriteSession', 'pageStates', 'groups', 'pairingGeneration']) assert.deepEqual(after[key], before[key], `${key} changed outside Split.`);
    assert(Object.keys(before.pageStates).length >= 4); assert(new Set(Object.values(before.pageStates).map(page => page.documentId)).size >= 4);
    assert.equal(events.filter(event => event.type === 'tabs.onMoved').length, reordered ? 1 : 0);
    assert(!events.some(event => /^tabs\.(onCreated|onRemoved|onReplaced|onAttached|onDetached|onActivated)$|^windows\.|^bookmarks\.|^tabGroups\.|^sidePanel\./.test(event.type)), 'No activation, regrouping, pinning, replacement, closure or focus writes.');
    assert(!events.some(event => event.type === 'tabs.onUpdated' && Object.keys(event.data.change).some(key => key !== 'splitViewId')));
    return response.splitResult;
}

export async function exerciseSpotlightSplit({ browser, observePage, apiPage, spotlightOptions, ui, screenshot, captureNativeWindow,
    snapshot, external, poll, fixture, arcifyId, spotlightId, search, record = async () => {} }) {
    assert.equal(process.env.GITHUB_ACTIONS, 'true'); assert.equal(process.env.CI, 'true'); assert.notEqual(process.getuid?.(), 0);
    for (const adapter of [observePage, ui, screenshot, captureNativeWindow, snapshot, external, poll, search, record]) assert.equal(typeof adapter, 'function');
    const capability = await apiPage.evaluate(() => ({ createSplit: typeof chrome.tabs.createSplit, unsplit: typeof chrome.tabs.unsplit, none: chrome.tabs.SPLIT_VIEW_ID_NONE, major: Number(/(?:Chrome|Chromium)\/(\d+)/.exec(navigator.userAgent)?.[1]) }));
    assertNativeSplitCapability(capability);
    const nonce = randomBytes(16).toString('hex'), windowId = fixture.windowA, otherWindow = fixture.windowB, spaceId = fixture.spaces.work;
    const owned = [], pages = new Map(), evidence = { nonce, capability, checkpoints: [], sourceSides: ['left', 'right'], groupSync: [false, true], realTrustedInput: true, unitOnly: ['deterministic race and lost-reply injection'] };
    const initial = await apiPage.evaluate(async () => ({ tabs: await chrome.tabs.query({}), windows: await chrome.windows.getAll(), sync: await chrome.storage.sync.get('syncTabGroups'), active: (await chrome.storage.session.get('activeSpaces')).activeSpaces || {} }));
    let primaryError, overlayPage;
    const checkpoint = async (phase, data) => { evidence.checkpoints.push({ phase, ...data }); await record(copy(evidence)); };
    const local = async message => { const result = await apiPage.evaluate(message => chrome.runtime.sendMessage({ type: 'spaceStore', ...message }), message); assert.equal(result.success, true, JSON.stringify(result)); };
    const settle = () => local({ action: 'get' });
    const setting = async value => {
        await ui(apiPage, 'Set group sync for isolated Spotlight Split acceptance', async () => { if (await apiPage.$eval('#syncTabGroups', node => node.checked) !== value) await apiPage.click('label.toggle-label[for="syncTabGroups"]'); });
        await poll(() => apiPage.evaluate(() => chrome.storage.sync.get('syncTabGroups')), state => Boolean(state.syncTabGroups) === value, 'group sync fixture setting'); await settle();
    };
    const read = async () => {
        await settle();
        const state = await apiPage.evaluate(async () => {
            const local = await chrome.storage.local.get(['spaces', 'pinnedTabStatesById', 'tabNameOverridesById', 'persistentFavorites', 'arcifyBridgePairingGeneration']);
            const session = await chrome.storage.session.get(['activeSpaces', 'favoriteSession', 'spotlightBridgeRequests']);
            return { tabs: (await chrome.tabs.query({})).map(({ id, windowId, index, url, pendingUrl, pinned, incognito, active, groupId, splitViewId }) => ({ id, windowId, index, url, pendingUrl: pendingUrl || null, pinned, incognito, active, groupId, splitViewId: splitViewId ?? -1 })).sort((a,b) => a.id-b.id),
                windows: (await chrome.windows.getAll()).map(({ id, type, incognito, focused, state }) => ({ id, type, incognito, focused, state })).sort((a,b) => a.id-b.id),
                spaces: (local.spaces || []).map(({ id, bookmarkFolderId, temporaryTabs, spaceBookmarks }) => ({ id, bookmarkFolderId, temporaryTabs, spaceBookmarks })),
                activeSpaces: session.activeSpaces || {}, groups: (await chrome.tabGroups.query({})).sort((a,b) => a.id-b.id), bookmarks: await chrome.bookmarks.getTree(),
                bindings: local.pinnedTabStatesById || {}, aliases: local.tabNameOverridesById || {}, favorites: local.persistentFavorites || [], favoriteSession: session.favoriteSession || null,
                pairingGeneration: local.arcifyBridgePairingGeneration ?? null, journal: session.spotlightBridgeRequests || [] };
        });
        state.pageStates = Object.fromEntries(await Promise.all([...pages].map(async ([id, page]) => [id, await page.evaluate(readNativeSplitPage)])));
        return state;
    };
    const closeOverlay = async () => {
        if (!overlayPage || overlayPage.isClosed() || !await overlayPage.evaluate(() => Boolean(document.getElementById('arcify-spotlight-host')))) return;
        const surface = await spotlightSurface(overlayPage), input = await surface.$('[data-testid="spotlight-input"]'); assert(input);
        try { await input.press('Escape'); } finally { await input.dispose(); }
        await overlayPage.waitForFunction(() => !document.getElementById('arcify-spotlight-host'));
    };
    const activate = async id => { await closeOverlay(); await apiPage.evaluate(async id => { const tab = await chrome.tabs.update(id, { active: true }); await chrome.windows.update(tab.windowId, { focused: true }); }, id); await local({ action: 'activate', windowId, spaceId }); };
    const open = async (sourceId, command) => {
        await activate(sourceId); overlayPage = pages.get(sourceId);
        const reply = await external(apiPage, spotlightId, 'launch', { windowId, mode: 'new-tab' }); assert.equal(reply?.ok, true, JSON.stringify(reply));
        await overlayPage.waitForFunction(() => document.getElementById('arcify-spotlight-host')?.shadowRoot?.querySelector('dialog')?.open);
        const surface = await spotlightSurface(overlayPage); assert.notEqual(surface, overlayPage);
        await search(overlayPage, command === 'createSplitView' ? 'split current tab' : 'end split');
        const rows = await poll(() => surface.evaluate(readSpotlightRows), rows => rows[0]?.type === 'arcify-split-action' && rows[0]?.title === (command === 'createSplitView' ? 'Split current tab' : 'End Split') && rows[0].selected, 'exact Split command is visibly selected');
        const before = await read(); assert.equal(exact(before.tabs, sourceId).active, true); assert(before.windows.some(window => window.id === windowId && window.focused));
        await surface.evaluate(installSpotlightSplitInputObservation);
        await apiPage.evaluate(() => { globalThis.__spaceActionObservation.events.length = 0; });
        await spotlightOptions.evaluate(() => { globalThis.__spaceActionObservation.events.length = 0; });
        return { surface, rows, before };
    };
    const invoke = async (surface, method) => {
        if (method === 'Enter') { const input = await surface.$('[data-testid="spotlight-input"]'); try { await input.press('Enter'); } finally { await input.dispose(); } }
        else await clickFreshResult(async timeout => { await surface.waitForSelector('[data-result-type="arcify-split-action"]', { visible: true, timeout }); return surface.$('[data-result-type="arcify-split-action"]'); });
    };
    const run = async (sourceId, targetId, command, method, cancelled = false) => {
        const { surface, rows, before } = await open(sourceId, command); await invoke(surface, method);
        let pickerShot;
        if (command === 'createSplitView') {
            await surface.waitForSelector('.arcify-split-action-prompt', { visible: true });
            assert.equal(await surface.$eval('[data-split-confirm]', node => node.disabled), true);
            assert.equal(await surface.$$eval('[data-split-target-id][aria-selected="true"]', nodes => nodes.length), 0, 'Nothing may be preselected.');
            const chosen = `[data-split-target-id="${targetId}"]`;
            assert.equal(await surface.$eval(chosen, node => node.getAttribute('role')), 'option');
            pickerShot = await screenshot(overlayPage, `spotlight-split-picker-${sourceId}-${method}`, true, { fullPage: false }); assert(pickerShot?.filename);
            if (cancelled) await surface.click('[data-split-cancel]');
            else {
                await surface.click(chosen); assert.equal(await surface.$eval(chosen, node => node.getAttribute('aria-selected')), 'true');
                if (method === 'Enter') { const confirm = await surface.$('[data-split-confirm]'); try { await confirm.focus(); await confirm.press('Enter'); } finally { await confirm.dispose(); } }
                else await surface.click('[data-split-confirm]');
            }
        }
        const expected = { command, sourceTabId: sourceId, targetId, windowId, spotlightId };
        if (cancelled) {
            await surface.waitForSelector('.arcify-split-action-prompt', { hidden: true });
            const after = await read(); assert.deepEqual(after, before);
            const inputs = await overlayPage.evaluate(() => parent.__spotlightSplitInputs || globalThis.__spotlightSplitInputs || []);
            assertSpotlightSplitInput(inputs, { command, targetId, method, cancelled });
            await checkpoint('explicit-picker-cancelled', { before, after, inputs, rows, pickerShot }); return;
        }
        const events = await poll(() => apiPage.evaluate(() => globalThis.__spaceActionObservation.events), values => values.some(event => event.type === 'external' && event.data.message.command === command), 'one actual external Split request');
        const request = assertSpotlightSplitRequest(events, expected);
        const after = await poll(read, value => value.journal.some(entry => entry.fingerprint === JSON.stringify(request) && entry.response?.ok === true), 'durable exact native Split receipt; never retry');
        // Read only the retained parent-world trace. A retired iframe is never a
        // substitute failure or reason to dispatch again after a native commit.
        const inputs = await overlayPage.evaluate(() => globalThis.__spotlightSplitInputs || []);
        const allEvents = await apiPage.evaluate(() => globalThis.__spaceActionObservation.events);
        assertSpotlightSplitInput(inputs, { command, targetId, method }); assertSpotlightSplitRequest(allEvents, expected);
        const peerEvents = await spotlightOptions.evaluate(() => globalThis.__spaceActionObservation.events);
        const sourceProof = assertSpotlightSplitSource(peerEvents, request, exact(before.tabs, sourceId).url);
        const receipt = assertSpotlightSplitCommitted(before, after, request, allEvents);
        await closeOverlay();
        const screenshotProof = command === 'createSplitView' ? await captureNativeWindow({ nonce, colors: [[248,215,218],[211,244,224]] })
            : await screenshot(overlayPage, `spotlight-unsplit-${sourceId}-${method}`, true, { fullPage: false });
        assert(screenshotProof?.filename, 'Every create/end needs native/page screenshot evidence.');
        const final = await read(), finalEvents = await apiPage.evaluate(() => globalThis.__spaceActionObservation.events);
        assertSpotlightSplitCommitted(before, final, request, finalEvents);
        await checkpoint('trusted-split-committed', { sourceId, targetId, command, method, before, after: final, request, receipt, sourceProof, inputs, rows, pickerShot, screenshot: screenshotProof, requestEvents: events, events: allEvents, peerEvents, finalEvents });
    };
    try {
        await setting(false);
        await apiPage.evaluate(installSpotlightActionApiObservation); await apiPage.evaluate(installNavigationGroupObservation); await spotlightOptions.evaluate(installSpotlightActionApiObservation);
        const seeded = [];
        for (const role of ['left', 'middle', 'right', 'twin', 'other']) {
            const atWindow = role === 'other' ? otherWindow : windowId;
            const created = await createNavigationFixturePage({ browser, apiPage, observePage, poll, windowId: atWindow, url: `${fixture.base}/spotlight-split/${role === 'other' ? randomBytes(16).toString('hex') : nonce}/${role === 'twin' ? 'left' : role}` });
            owned.push(created.tab.id); pages.set(created.tab.id, created.page); seeded.push(created);
            await local({ action: 'assign', tabId: created.tab.id, spaceId, pinned: false, newTodayTab: true });
            await ui(created.page, 'Type an original draft before Split actions', () => created.page.type('#split-input', `-${created.tab.id}`));
        }
        const [left, , right] = seeded;
        for (const sync of [false, true]) {
            await setting(sync);
            for (const source of [left, right]) {
                const target = source === left ? right : left, method = source === left ? 'click' : 'Enter';
                await run(source.tab.id, target.tab.id, 'createSplitView', method, true);
                await run(source.tab.id, target.tab.id, 'createSplitView', method);
                await run(source.tab.id, target.tab.id, 'endSplitView', method);
            }
            await checkpoint('both-source-panes-proved', { sync, state: await read() });
        }
    } catch (error) {
        primaryError = error;
        await checkpoint('spotlight-split-failed', { message: error.message }).catch(evidenceError => {
            try { primaryError.evidenceErrors = [evidenceError.message]; } catch { /* Diagnostic attachment cannot replace a read-only original error or prevent cleanup. */ }
        });
    }
    await finishBookmarkFixture([
        closeOverlay,
        () => apiPage.evaluate(ids => chrome.tabs.remove(ids), owned),
        () => setting(Boolean(initial.sync.syncTabGroups)),
        () => apiPage.evaluate(async original => { if (!Object.hasOwn(original, 'syncTabGroups')) await chrome.storage.sync.remove('syncTabGroups'); }, initial.sync),
        async () => {
            for (const tab of initial.tabs.filter(tab => tab.active)) await apiPage.evaluate(id => chrome.tabs.update(id, { active: true }), tab.id);
            for (const [id, selected] of Object.entries(initial.active)) await local({ action: 'activate', windowId: Number(id), spaceId: selected });
            const focused = initial.windows.find(window => window.focused); if (focused) await apiPage.evaluate(id => chrome.windows.update(id, { focused: true }), focused.id);
            await settle(); const remaining = await apiPage.evaluate(() => chrome.tabs.query({}));
            assert.deepEqual(remaining.map(tab => tab.id).sort((a,b) => a-b), initial.tabs.map(tab => tab.id).sort((a,b) => a-b));
            for (const tab of initial.tabs) for (const key of ['windowId', 'url', 'pendingUrl', 'index', 'active', 'pinned', 'incognito', 'splitViewId']) assert.deepEqual(exact(remaining, tab.id)[key], tab[key]);
            await checkpoint('spotlight-split-cleanup-verified', {});
        },
        () => apiPage.evaluate(() => { globalThis.__navigationGroupObservation?.stop(); globalThis.__spaceActionObservation?.stop(); }),
        () => spotlightOptions.evaluate(() => globalThis.__spaceActionObservation?.stop())
    ], primaryError, ({ errors }) => checkpoint('spotlight-split-cleanup-failed', { errors }));
    if (primaryError) throw primaryError;
    return evidence;
}
