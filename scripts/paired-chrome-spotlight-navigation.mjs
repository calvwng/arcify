/** Import-safe hosted acceptance. Only the paired harness owns Chrome and native input. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { requireActionPromptGeometry, waitForActionSurfaceCompletion } from './paired-chrome-action-surface.mjs';
import { collectSpotlightHelperOrigin } from './paired-chrome-helper-origin.mjs';
import { spotlightSurface } from './paired-chrome-keyboard.mjs';
import { clickFreshResult, replaceInputText, selectResultWithKeyboard, attachCreatedFixtureTab } from './paired-chrome-ui.mjs';
import { readSpotlightRows, assertMatchedActionFirst } from './paired-chrome-sidebar.mjs';
import { canonicalSavedMoveBookmarks } from './paired-chrome-saved-move.mjs';
import { finishBookmarkFixture } from './paired-chrome-bookmark-selection.mjs';
import { projectTabTitle } from '../tab-title-projection.js';
import { isStartupLauncherTab } from '../startup-launcher-tab.js';
import { readNewTabReuseState } from './paired-chrome-newtab.mjs';
import { assertSpotlightActionEnvironment, installSpotlightActionApiObservation, readSpotlightActionPage,
    assertSpotlightActionContext, assertSpotlightActionUnchanged, assertSpotlightActionNoWrites } from './paired-chrome-spotlight-actions.mjs';

export const SPOTLIGHT_NAVIGATION_CASE_NAME = 'Spotlight Space navigation uses genuine destination pickers and preserves exact Today/native identities';
export const NAVIGATION_FEATURES = Object.freeze(['globalFavoritesV1', 'spaceActionsV1', 'spaceNavigationV1']);
export const NAVIGATION_TITLES = Object.freeze({ switchSpace: 'Switch Space', moveCurrentTodayTab: 'Move current tab to another Space' });
export const NAVIGATION_QUERIES = Object.freeze({ switchSpace: 'swich space', moveCurrentTodayTab: 'move curent tab' });
const commands = Object.keys(NAVIGATION_TITLES);
const mutations = [...commands, 'openSettings', 'createSpaceFolder', 'pinCurrentTab', 'removeCurrentPin', 'activateSpace', 'activateTab', 'assign', 'navigateTab', 'openBookmark', 'openTab', 'openFavorite'];
const flat = nodes => nodes.flatMap(node => [node, ...flat(node.children || [])]);
const exact = (values, id) => { const matches = values.filter(value => value.id === id); assert.equal(matches.length, 1, `Require exact unique ${id}.`); return matches[0]; };
const identity = space => ({ spaceId: space.id, bookmarkFolderId: space.bookmarkFolderId });
const canonSnapshots = values => Object.fromEntries(Object.entries(values).map(([key, { capturedAt, ...value }]) => [key, value]));
const active = (state, windowId) => { const tabs = state.tabs.filter(tab => tab.windowId === windowId && tab.active); assert.equal(tabs.length, 1); return tabs[0].id; };
const changedStorage = events => events.filter(event => event.type === 'storage' && Object.values(event.data.changes).some(value => JSON.stringify(value.oldValue) !== JSON.stringify(value.newValue)));

// Decide from exact pre-action native membership, never from a detached-frame
// exception or an outcome that could hide the wrong destination activation.
export function navigationRetiresOverlay(before, command, captured, destination) {
    assert(commands.includes(command));
    if (command !== 'switchSpace') return false;
    const space = exact(before.spaces, destination.spaceId);
    assert.equal(space.bookmarkFolderId, destination.bookmarkFolderId);
    return [...space.spaceBookmarks, ...space.temporaryTabs].some(id => exact(before.tabs, id).windowId === captured.context.windowId);
}

export function serveSpotlightNavigationFixture(request, response) {
    const match = /^\/spotlight-navigation\/([a-f0-9]{32})\/([a-z-]+)$/.exec(new URL(request.url, 'http://127.0.0.1').pathname);
    if (!match) return false;
    const title = `Spotlight Navigation ${match[2]} ${match[1]}`;
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-src 'none'" });
    response.end(`<!doctype html><html><head><title>${title}</title><link rel="icon" href="data:,"></head><body data-document-id="${randomBytes(16).toString('hex')}"><h1>${title}</h1><input id="action-page-state" value="retained"></body></html>`);
    return true;
}

/** Capture listeners only. Never sets isTrusted or calls a controller. */
export function installNavigationInputObservation({ retainInParent = false } = {}) {
    globalThis.__navigationInput?.stop();
    const events = [], registrations = [];
    for (const type of ['input', 'change', 'click', 'keydown']) {
        const listener = event => {
            const row = event.target.closest?.('[data-testid="spotlight-result"]') || document.querySelector('[data-testid="spotlight-result"].selected');
            const prompt = event.target.closest?.('.arcify-space-action-prompt');
            events.push({ type, trusted: event.isTrusted, key: event.key || null, button: event.button ?? null,
                keyCode: event.keyCode ?? null, shift: Boolean(event.shiftKey), repeat: Boolean(event.repeat), composing: Boolean(event.isComposing), ctrl: Boolean(event.ctrlKey), alt: Boolean(event.altKey), meta: Boolean(event.metaKey),
                title: row?.querySelector('.arcify-spotlight-result-title')?.textContent || null, resultType: row?.dataset.resultType || null,
                inPrompt: Boolean(prompt), destination: event.target.matches?.('[data-space-destination]') || false,
                value: event.target.value ?? null, confirm: event.target.dataset?.actionConfirm || null, cancel: event.target.hasAttribute?.('data-action-cancel') || false });
        };
        document.addEventListener(type, listener, true); registrations.push(() => document.removeEventListener(type, listener, true));
    }
    globalThis.__navigationInput = { events, stop: () => registrations.forEach(remove => remove()) };
    // Retain passive event records only, as Switch may retire this exact iframe.
    globalThis.__navigationInputEvents = events;
    if (retainInParent) parent.__navigationInputEvents = events;
}
export function installNavigationGroupObservation() {
    globalThis.__navigationGroupObservation?.stop(); const registrations = [];
    for (const name of ['onCreated', 'onRemoved', 'onUpdated', 'onMoved']) {
        const listener = (...data) => globalThis.__spaceActionObservation.events.push({ type: `tabGroups.${name}`, data });
        chrome.tabGroups[name].addListener(listener); registrations.push(() => chrome.tabGroups[name].removeListener(listener));
    }
    globalThis.__navigationGroupObservation = { stop: () => registrations.forEach(remove => remove()) };
}
export function readNavigationPicker() {
    const prompt = document.querySelector('.arcify-space-action-prompt'); if (!prompt) return null;
    const select = prompt.querySelector('[data-space-destination]'), confirm = prompt.querySelector('[data-action-confirm]');
    const rect = prompt.getBoundingClientRect();
    return { role: prompt.getAttribute('role'), modal: prompt.getAttribute('aria-modal'), title: document.getElementById(prompt.getAttribute('aria-labelledby'))?.textContent,
        description: document.getElementById(prompt.getAttribute('aria-describedby'))?.textContent, visible: rect.width > 0 && rect.height > 0 && getComputedStyle(prompt).visibility !== 'hidden',
        command: confirm?.dataset.actionConfirm, confirm: confirm?.textContent, cancel: prompt.querySelector('[data-action-cancel]')?.textContent,
        value: select?.value, focused: document.activeElement === select,
        options: select ? [...select.options].map(option => ({ value: option.value, text: option.textContent, disabled: option.disabled, selected: option.selected })) : [],
        error: prompt.querySelector('[role="alert"]')?.textContent };
}
export function assertNavigationContext(reply, state, { windowId, sourceTabId, section }) {
    assert.equal(reply?.ok, true, JSON.stringify(reply));
    assertSpotlightActionContext(reply.actionContext, state, { windowId, sourceTabId, section });
    const navigation = reply.navigationContext;
    assert.deepEqual(Object.keys(navigation).sort(), ['destinations', 'inverted', 'sourceUrl']);
    assert.equal(navigation.sourceUrl, exact(state.tabs, sourceTabId).url);
    if (section === 'today') {
        const tab = exact(state.tabs, sourceTabId);
        assert.equal(tab.pinned, false); assert.equal(tab.incognito, false); assert.equal(tab.splitViewId, -1);
        assert(!/^(?:chrome:\/\/newtab(?:[/?#]|$)|(?:chrome|moz)-extension:\/\/[^/]+\/(?:newtab|startup-launcher)\.html(?:[?#]|$))/.test(tab.url), 'A helper cannot be current Today context.');
    }
    assert.equal(navigation.inverted, state.representation.inverted); assert.equal(state.representation.version, 1);
    const roots = flat(state.bookmarks).filter(node => node.title === 'Arcify' && !node.url); assert.equal(roots.length, 1);
    const nodes = flat(state.bookmarks);
    const eligible = state.spaces.filter(space => space.id !== reply.actionContext.spaceId && state.spaces.filter(other => other.id === space.id).length === 1
        && state.spaces.filter(other => other.bookmarkFolderId === space.bookmarkFolderId).length === 1
        && nodes.filter(node => node.id === space.bookmarkFolderId && !node.url && node.parentId === roots[0].id).length === 1)
        .map(space => ({ ...identity(space), name: space.name }));
    assert.deepEqual(navigation.destinations, eligible, 'Only exact existing valid non-source Spaces, in canonical order.');
    assert.equal(new Set(navigation.destinations.map(item => item.spaceId)).size, eligible.length);
    return { context: reply.actionContext, navigation };
}
export function assertNavigationPicker(picker, command, navigation, selectedIndex = null) {
    assert.equal(picker?.role, 'dialog'); assert.equal(picker.modal, 'true'); assert.equal(picker.visible, true);
    assert.equal(picker.command, command); assert.equal(picker.cancel, 'Cancel');
    assert.equal(picker.title, command === 'switchSpace' ? 'Switch Space' : 'Move current Today tab');
    assert.equal(picker.confirm, command === 'switchSpace' ? 'Switch Space' : 'Move tab');
    assert.match(picker.description, command === 'switchSpace' ? /last open tab.*empty Space/ : /exact tab.*visible bottom.*selected Space.*focus/);
    assert.equal(picker.value, selectedIndex === null ? '' : String(selectedIndex));
    if (selectedIndex === null) assert.equal(picker.focused, true, 'No destination is preselected; select owns initial focus.');
    assert.deepEqual(picker.options, [{ value: '', text: 'Choose a Space…', disabled: true, selected: selectedIndex === null }, ...navigation.destinations.map((target, index) => ({
        value: String(index), disabled: false, selected: selectedIndex === index,
        text: navigation.destinations.filter(other => other.name === target.name).length > 1 ? `${target.name} (${target.spaceId})` : target.name || target.spaceId
    }))]);
}
export function assertNavigationInput(events, command, { outcome, destinationIndex, activation = 'click', submission = 'click' }) {
    assert(events.length); assert(events.every(event => event.trusted && event.keyCode !== 229 && !event.repeat && !event.composing && !event.ctrl && !event.alt && !event.meta
        && (event.type !== 'click' || event.button === 0)), 'Only genuine ordinary input satisfies acceptance.');
    const enters = event => event.type === 'keydown' && event.key === 'Enter';
    const invoke = events.filter(event => !event.inPrompt && event.resultType === 'arcify-space-action' && event.title === NAVIGATION_TITLES[command] && (event.type === 'click' || enters(event)));
    assert.equal(invoke.length, 1); assert.equal(invoke[0].type, activation === 'Enter' ? 'keydown' : 'click');
    const submits = events.filter(event => event.inPrompt && (event.type === 'click' && event.confirm === command || enters(event) && !event.cancel && (event.destination || event.confirm === command)));
    assert.equal(submits.length, outcome === 'cancel' ? 0 : 1, 'Exactly one attempt, never an automatic retry.');
    if (outcome !== 'cancel') assert.equal(submits[0].type, submission === 'Enter' ? 'keydown' : 'click');
    if (outcome === 'commit') assert(events.some(event => event.type === 'change' && event.destination && event.value === String(destinationIndex)), 'Real select change must attest the exact destination option.');
    if (outcome === 'no-choice') { assert(!events.some(event => event.type === 'change' && event.destination && event.value !== '')); assert.equal(submits[0].value, ''); }
    if (outcome === 'cancel') assert.equal(events.filter(event => event.inPrompt && (event.type === 'click' && event.cancel || event.type === 'keydown' && event.key === 'Escape')).length, 1);
}
export function assertNavigationNoMutation(events) {
    assertSpotlightActionNoWrites(events);
    assert.deepEqual(events.filter(event => event.type === 'external' && mutations.includes(event.data.message.command)), [], 'Cancellation cannot dispatch navigation or a legacy mutation.');
    assert.deepEqual(changedStorage(events), [], 'No changed storage area, including sync.');
    assert.deepEqual(events.filter(event => event.type.startsWith('tabGroups.')), []);
}
export function assertNavigationRequest(events, command, captured, destination, spotlightId) {
    const requests = events.filter(event => event.type === 'external' && mutations.includes(event.data.message.command));
    assert.equal(requests.length, 1, 'One genuine picker confirmation must dispatch exactly one mutation, with no fallback.');
    const { message, sender } = requests[0].data;
    assert.equal(sender.id, spotlightId); assert.equal(message.type, 'arcify-bridge'); assert.equal(message.version, 1);
    assert.match(message.requestId, /^[\w.:-]{1,80}$/); assert.equal(message.command, command); assert.equal(message.windowId, captured.context.windowId);
    assert.deepEqual(message.context, captured.context); assert.deepEqual(message.destination, destination); assert.equal(message.sourceUrl, captured.navigation.sourceUrl);
    assert.deepEqual(message.supportedFeatures, NAVIGATION_FEATURES);
    const keys = ['type', 'version', 'requestId', 'windowId', 'command', 'supportedFeatures', 'context', 'destination', 'sourceUrl'];
    if (command === 'moveCurrentTodayTab') { keys.push('inverted'); assert.equal(message.inverted, captured.navigation.inverted); }
    assert.deepEqual(Object.keys(message).sort(), keys.sort());
    assert(!events.some(event => event.type === 'external' && event.data.message.type === 'arcify-sidebar'));
    return message;
}
export function assertNavigationSnapshot(state) {
    assert.deepEqual(Object.keys(state.snapshots).sort(), (state.snapshotWindowIds || Object.keys(state.activeSpaces).filter(key => state.tabs.some(tab => tab.windowId === Number(key)))).map(String).sort(), 'Every captured ordinary window needs its snapshot.');
    for (const [key, snapshot] of Object.entries(state.snapshots)) {
        const windowId = Number(key), local = ids => ids.filter(id => exact(state.tabs, id).windowId === windowId);
        assert.equal(snapshot.windowId, windowId); assert.equal(snapshot.activeSpaceId, state.activeSpaces[key]);
        assert.deepEqual(snapshot.spaces.map(space => space.id), state.spaces.map(space => space.id));
        for (const space of state.spaces) {
            const projected = exact(snapshot.spaces, space.id);
            assert.equal(projected.bookmarkFolderId, space.bookmarkFolderId);
            assert.deepEqual(projected.temporaryTabIds, local(space.temporaryTabs)); assert.deepEqual(projected.pinnedTabIds, local(space.spaceBookmarks));
            assert.deepEqual(projected.tabIds, local([...space.spaceBookmarks, ...space.temporaryTabs]));
        }
        const expectedTabs = state.tabs.filter(tab => tab.windowId === windowId && !isStartupLauncherTab(tab, { runtime: { getURL: path => `chrome-extension://${state.arcifyId || ''}/${path}` } })).map(tab => {
            const space = state.spaces.find(space => [...space.temporaryTabs, ...space.spaceBookmarks].includes(tab.id));
            const binding = state.bindings[tab.id], bookmark = binding?.bookmarkId ? flat(state.bookmarks).find(node => node.id === binding.bookmarkId) : undefined;
            return { id: tab.id, windowId, title: projectTabTitle(tab, { overrides: state.aliases, binding, bookmark, isSpacePin: Boolean(space?.spaceBookmarks.includes(tab.id)) }), url: tab.url || tab.pendingUrl || '', active: tab.active, pinned: tab.pinned, spaceId: space?.id ?? null };
        });
        assert.deepEqual([...snapshot.tabs].sort((a, b) => a.id - b.id), expectedTabs.sort((a, b) => a.id - b.id), 'Every exact native identity/content appears once in its window snapshot.');
        for (const tab of snapshot.tabs) {
            const owners = state.spaces.filter(space => [...space.temporaryTabs, ...space.spaceBookmarks].includes(tab.id));
            assert(owners.length <= 1); assert.equal(tab.spaceId, owners[0]?.id ?? null); assert.equal(tab.active, exact(state.tabs, tab.id).active);
        }
    }
}
export function assertNavigationCommitted(before, after, { command, captured, destination, request, events, groupSync = false }) {
    const { context, navigation } = captured, windowId = context.windowId, sourceId = context.sourceTabId;
    assertNavigationSnapshot(before); assertNavigationSnapshot(after);
    for (const key of ['bookmarks', 'bindings', 'aliases', 'favorites', 'favoriteSession', 'pageStates', 'pairingGeneration', 'representation'])
        assert.deepEqual(after[key], before[key], `${key} cannot change during Space navigation.`);
    assert.deepEqual(after.tabs.map(tab => tab.id), before.tabs.map(tab => tab.id));
    assert.deepEqual(after.windows, before.windows, 'Source is already foreground; no other window may change.');
    assert.deepEqual(after.projection, before.projection);
    const expectedGroups = structuredClone(before.groups);
    const hasLocalDestination = [...exact(before.spaces, destination.spaceId).spaceBookmarks, ...exact(before.spaces, destination.spaceId).temporaryTabs].some(id => exact(before.tabs, id).windowId === windowId);
    if (command === 'switchSpace' && groupSync && hasLocalDestination) for (const group of expectedGroups) {
        if (group.windowId !== windowId) continue;
        const space = before.spaces.find(space => before.projection[`${space.id}:${windowId}`] === group.id);
        if (space) group.collapsed = space.id !== destination.spaceId;
    }
    assert.deepEqual(after.groups, expectedGroups, 'Settled Switch may only change expected source-window group collapse state.');
    const spaces = structuredClone(before.spaces), source = exact(spaces, context.spaceId), target = exact(spaces, destination.spaceId);
    assert.notEqual(source.id, target.id); assert.equal(target.bookmarkFolderId, destination.bookmarkFolderId);
    const expectedActive = { ...before.activeSpaces }, expectedTabs = structuredClone(before.tabs);
    let resultId = sourceId;
    if (command === 'moveCurrentTodayTab') {
        assert.equal(context.tab?.section, 'today'); assert.equal(active(before, windowId), sourceId);
        assert.equal(source.temporaryTabs.filter(id => id === sourceId).length, 1); assert(!before.bindings[sourceId]);
        source.temporaryTabs = source.temporaryTabs.filter(id => id !== sourceId);
        if (source.lastTab === sourceId) delete source.lastTab;
        target.temporaryTabs = navigation.inverted ? [sourceId, ...target.temporaryTabs] : [...target.temporaryTabs, sourceId];
    } else {
        assert.equal(command, 'switchSpace'); expectedActive[windowId] = target.id;
        const ids = [...target.spaceBookmarks, ...target.temporaryTabs].filter(id => exact(before.tabs, id).windowId === windowId);
        resultId = ids.includes(target.lastTab) ? target.lastTab : ids.at(-1) ?? null;
        if (resultId !== null) { for (const tab of expectedTabs) if (tab.windowId === windowId) tab.active = tab.id === resultId; target.lastTab = resultId; }
    }
    assert.deepEqual(after.tabs, expectedTabs, 'No creation, replacement, URL deduplication, native reorder, regroup, pin or rewindow.');
    assert.deepEqual(after.activeSpaces, expectedActive); assert.deepEqual(after.spaces, spaces);
    const other = Object.keys(before.snapshots).filter(key => Number(key) !== windowId);
    for (const key of other) assert.deepEqual(canonSnapshots({ [key]: after.snapshots[key] }), canonSnapshots({ [key]: before.snapshots[key] }), 'Other-window snapshot stays unchanged.');
    const expectedSaved = before.savedSnapshot.map(record => {
        if (command !== 'moveCurrentTodayTab' || ![source.id, target.id].includes(record.spaceId) || record.section !== 'temporaryTabs') return record;
        const space = record.tabId === sourceId || record.spaceId === target.id ? target : source;
        const order = space.temporaryTabs.indexOf(record.tabId); assert(order >= 0);
        return { ...record, spaceId: space.id, order };
    });
    const sorted = records => [...records].sort((a, b) => a.tabId - b.tabId);
    assert.deepEqual(sorted(after.savedSnapshot), sorted(expectedSaved), 'Durable records keep exact tab/window/URL identities and canonical ordering.');
    const native = events.filter(event => /^tabs\.(?!onUpdated)|^windows\.|^sidePanel\.|^bookmarks\./.test(event.type)
        || event.type === 'tabs.onUpdated' && ['url', 'pendingUrl', 'pinned', 'groupId', 'splitViewId', 'mutedInfo', 'discarded'].some(key => key in event.data.change));
    if (command === 'moveCurrentTodayTab' || resultId === null) assert.deepEqual(native, [], 'Move/empty Switch cannot transiently affect native pages or focus.');
    else {
        const activations = native.filter(event => event.type === 'tabs.onActivated'); assert.equal(activations.length, 1); assert.deepEqual(activations[0].data, [{ tabId: resultId, windowId }]);
        for (const event of native) assert(event.type === 'tabs.onActivated' || event.type === 'windows.onFocusChanged' && event.data[0] === windowId, 'Only exact destination activation and source-window focus are allowed.');
    }
    const groupEvents = events.filter(event => event.type.startsWith('tabGroups.'));
    if (command === 'switchSpace' && groupSync && resultId !== null) {
        for (const event of groupEvents) {
            assert.equal(event.type, 'tabGroups.onUpdated'); const group = event.data[0];
            assert.equal(group.windowId, windowId); assert.deepEqual(group, exact(expectedGroups, group.id));
        }
    } else assert.deepEqual(groupEvents, [], 'Move and empty/sync-off Switch cannot transiently alter groups.');
    const receipts = after.journal.filter(entry => entry.fingerprint === JSON.stringify(request)); assert.equal(receipts.length, 1);
    assert.equal(receipts[0].response?.ok, true); assert.equal(receipts[0].response.spaceId, target.id); assert.equal(receipts[0].response.tabId, resultId);
    return { command, spaceId: target.id, tabId: resultId, inverted: navigation.inverted };
}

/** Attach only one new native tab and one new page target, never a same-URL predecessor. */
export async function createNavigationFixturePage({ browser, apiPage, observePage, poll, windowId, url }) {
    const beforeTargets = new Set(browser.targets());
    const beforeTabs = new Set((await apiPage.evaluate(() => chrome.tabs.query({}))).map(tab => tab.id));
    const created = await apiPage.evaluate(options => chrome.tabs.create(options), { windowId, url, active: false });
    assert(Number.isSafeInteger(created.id) && !beforeTabs.has(created.id));
    return attachCreatedFixtureTab(created, async () => {
        const tab = await poll(() => apiPage.evaluate(id => chrome.tabs.get(id), created.id), tab => tab.status === 'complete' && tab.url === url && !tab.pendingUrl, 'exact disposable native page loaded');
        assert.equal(tab.windowId, windowId);
        const newIds = (await apiPage.evaluate(() => chrome.tabs.query({}))).filter(tab => !beforeTabs.has(tab.id)).map(tab => tab.id);
        assert.deepEqual(newIds, [created.id], 'One fixture create must produce one exact native tab.');
        const target = await poll(() => {
            const fresh = browser.targets().filter(target => target.type() === 'page' && !beforeTargets.has(target));
            assert(fresh.length <= 1, 'Ambiguous new page targets cannot be selected by equal URL.');
            return fresh.length === 1 && fresh[0].url() === url ? fresh[0] : null;
        }, Boolean, 'one fresh target matching the exact native create receipt');
        return { tab, page: await observePage(await target.page()), url };
    }, id => apiPage.evaluate(id => chrome.tabs.remove(id), id));
}

/** No positive mutation adapter: every accepted action starts at a visible row and picker. */
export async function exerciseSpotlightNavigation({ browser, observePage, apiPage, spotlightOptions, newTabPage, openSavedPage, pageForUrl, ui, screenshot,
    snapshot, bridge, external, poll, fixture, arcifyId, spotlightId, search, record = async () => {} }) {
    assertSpotlightActionEnvironment();
    assert.equal(typeof browser?.targets, 'function');
    for (const adapter of [observePage, newTabPage, openSavedPage, pageForUrl, ui, screenshot, snapshot, bridge, external, poll, search]) assert.equal(typeof adapter, 'function');
    const windowId = fixture.windowA, otherWindow = fixture.windowB, nonce = randomBytes(16).toString('hex');
    const initial = await snapshot(windowId), initialOther = await snapshot(otherWindow);
    let source, empty, target;
    const settings = await apiPage.evaluate(async () => ({ sync: await chrome.storage.sync.get(['syncTabGroups']), local: await chrome.storage.local.get('todayOrderRepresentation'),
        windows: await chrome.windows.getAll(), tabs: await chrome.tabs.query({}), session: await chrome.storage.session.get('activeSpaces') }));
    const owned = [], roots = [], spaceRoots = [], spaceIds = [], pages = new Map(), evidence = { nonce, checkpoints: [], matrix: [], surfaces: ['isolated-overlay-frame', 'owned-newtab', 'browser-newtab-alias'], unitOnly: ['closed/moved source race', 'post-commit partial/no-replay', 'query/hash helper aliases', 'late pairing/order fences'] };
    let primaryError, overlayPage, helper, revoked = false;
    const checkpoint = async (phase, data = {}) => { evidence.checkpoints.push({ phase, ...data }); await record(structuredClone(evidence)); };
    const option = async value => {
        await ui(apiPage, 'Set group sync for isolated navigation acceptance', async () => { if (await apiPage.$eval('#syncTabGroups', node => node.checked) !== value) await apiPage.click('label.toggle-label[for="syncTabGroups"]'); });
        await poll(() => apiPage.evaluate(() => chrome.storage.sync.get('syncTabGroups')), data => Boolean(data.syncTabGroups) === value, 'group-sync setting saved');
    };
    const local = async message => {
        const reply = await apiPage.evaluate(message => chrome.runtime.sendMessage({ type: 'spaceStore', ...message }), message);
        assert.equal(reply?.success, true, JSON.stringify(reply)); return reply;
    };
    const activate = async id => apiPage.evaluate(async id => { const tab = await chrome.tabs.update(id, { active: true }); await chrome.windows.update(tab.windowId, { focused: true }); }, id);
    const read = async () => {
        await local({ action: 'get' });
        const snapshots = { [windowId]: await snapshot(windowId), [otherWindow]: await snapshot(otherWindow) };
        const state = await apiPage.evaluate(async () => {
            const local = await chrome.storage.local.get(['spaces', 'pinnedTabStatesById', 'tabNameOverridesById', 'persistentFavorites', 'spaceTabSnapshot', 'arcifyBridgePairingGeneration', 'todayOrderRepresentation']);
            const session = await chrome.storage.session.get(['activeSpaces', 'spaceGroupProjection', 'favoriteSession', 'spotlightBridgeRequests']);
            return { tabs: (await chrome.tabs.query({})).map(({ id, windowId, index, url, pendingUrl, title, pinned, incognito, active, groupId, splitViewId }) => ({ id, windowId, index, url, pendingUrl: pendingUrl || null, title, pinned, incognito, active, groupId, splitViewId: splitViewId ?? -1 })).sort((a, b) => a.id - b.id),
                windows: (await chrome.windows.getAll()).map(({ id, type, incognito, focused, state }) => ({ id, type, incognito, focused, state })).sort((a, b) => a.id - b.id),
                spaces: local.spaces || [], bookmarks: await chrome.bookmarks.getTree(), bindings: local.pinnedTabStatesById || {}, aliases: local.tabNameOverridesById || {}, favorites: local.persistentFavorites || [], savedSnapshot: local.spaceTabSnapshot || [],
                pairingGeneration: local.arcifyBridgePairingGeneration ?? null, representation: local.todayOrderRepresentation,
                activeSpaces: session.activeSpaces || {}, projection: session.spaceGroupProjection || {}, favoriteSession: session.favoriteSession || null,
                journal: session.spotlightBridgeRequests || [], groups: (await chrome.tabGroups.query({})).sort((a, b) => a.id - b.id) };
        });
        state.bookmarks = canonicalSavedMoveBookmarks(state.bookmarks); state.snapshots = snapshots; state.arcifyId = arcifyId; state.snapshotWindowIds = [windowId, otherWindow];
        state.pageStates = Object.fromEntries(await Promise.all([...pages].map(async ([id, page]) => [id, await page.evaluate(readSpotlightActionPage)])));
        return state;
    };
    // Normal activation and group setup have 200ms projection debounces. Wait for
    // stable real read-back for longer than that before zeroing action observers.
    const settle = async () => {
        let prior, since;
        return poll(read, state => {
            const next = JSON.stringify({ ...state, snapshots: canonSnapshots(state.snapshots) });
            if (next !== prior) { prior = next; since = Date.now(); return false; }
            return Date.now() - since >= 400;
        }, 'setup native/store/projection convergence before measuring action');
    };
    const reset = async surface => {
        await apiPage.evaluate(() => { globalThis.__spaceActionObservation.events.length = 0; });
        await spotlightOptions.evaluate(() => { globalThis.__spaceActionObservation.events.length = 0; });
        if (surface) await surface.evaluate(() => { globalThis.__navigationInput.events.length = 0; });
    };
    const trace = async (surface, inputOwner = surface) => ({ events: await apiPage.evaluate(() => globalThis.__spaceActionObservation.events), peerEvents: await spotlightOptions.evaluate(() => globalThis.__spaceActionObservation.events),
        input: inputOwner ? await inputOwner.evaluate(() => globalThis.__navigationInputEvents) : [] });
    const capture = async (page, label) => { const result = await screenshot(page, `spotlight-navigation-${label}`, true, { fullPage: false }); assert(result?.filename && result?.capturedAt, 'Screenshot evidence is mandatory.'); return result; };
    const context = async (id, section) => {
        const state = await read(), reply = await external(spotlightOptions, arcifyId, 'navigationContext', { windowId, tabId: id, supportedFeatures: NAVIGATION_FEATURES });
        assert.equal(reply.extensionId, arcifyId); const captured = assertNavigationContext(reply, state, { windowId, sourceTabId: id, section });
        await checkpoint('exact-navigation-context', { state, reply }); return captured;
    };
    const closeOverlay = async () => {
        if (!overlayPage || overlayPage.isClosed() || !await overlayPage.evaluate(() => Boolean(document.getElementById('arcify-spotlight-host')))) return;
        const surface = await spotlightSurface(overlayPage);
        await ui(overlayPage, 'Dismiss completed navigation overlay', async () => { const input = await surface.$('[data-testid="spotlight-input"]'); assert(input); try { await input.press('Escape'); } finally { await input.dispose(); } });
        await overlayPage.waitForFunction(() => !document.getElementById('arcify-spotlight-host'));
    };
    const openOverlay = async (tab, page) => {
        await closeOverlay(); overlayPage = page; await activate(tab.id); await local({ action: 'activate', windowId, spaceId: source.id });
        const reply = await external(apiPage, spotlightId, 'launch', { windowId, mode: 'new-tab' }); assert.equal(reply?.ok, true, JSON.stringify(reply));
        await page.waitForFunction(() => document.getElementById('arcify-spotlight-host')?.shadowRoot?.querySelector('dialog')?.open);
        const surface = await spotlightSurface(page); assert.notEqual(surface, page);
        const rendered = await surface.evaluate(() => ({ embedded: window.top !== window, url: document.URL, timeOrigin: performance.timeOrigin, ready: Boolean(document.querySelector('[data-testid="spotlight-input"]')) }));
        assert.equal(rendered.embedded, true); assert.equal(rendered.ready, true); await checkpoint('real-isolated-overlay', rendered); return surface;
    };
    const seed = async (role, spaceId = source.id, atWindow = windowId) => {
        const url = `${fixture.base}/spotlight-navigation/${nonce}/${role}`;
        const { tab, page } = await createNavigationFixturePage({ browser, apiPage, observePage, poll, windowId: atWindow, url }); owned.push(tab.id);
        await page.waitForSelector('#action-page-state'); pages.set(tab.id, page);
        await local({ action: 'assign', tabId: tab.id, spaceId });
        await ui(page, 'Keep disposable page input through navigation', () => page.type('#action-page-state', `-${tab.id}`));
        return { tab, page, url };
    };
    const ready = async (page, command) => {
        await search(page, NAVIGATION_QUERIES[command]); const surface = await spotlightSurface(page);
        const rows = await poll(() => surface.evaluate(readSpotlightRows), rows => rows[0]?.type === 'arcify-space-action' && rows[0]?.title === NAVIGATION_TITLES[command] && rows[0].selected, 'fuzzy navigation action selected above preserved web search');
        assertMatchedActionFirst(rows, { type: 'arcify-space-action', title: NAVIGATION_TITLES[command], query: NAVIGATION_QUERIES[command] });
        assert.equal(await surface.$eval('[data-testid="spotlight-result"]', node => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden'), true);
        await surface.evaluate(installNavigationInputObservation, { retainInParent: surface !== page }); return { surface, rows, inputOwner: page };
    };
    const invoke = async (surface, command, method) => {
        if (method === 'Enter') { const input = await surface.$('[data-testid="spotlight-input"]'); assert(input); try { await input.press('Enter'); } finally { await input.dispose(); } }
        else await clickFreshResult(async timeout => {
            await surface.waitForSelector('[data-result-type="arcify-space-action"]', { visible: true, timeout });
            const handle = await surface.evaluateHandle(title => { const rows = [...document.querySelectorAll('[data-result-type="arcify-space-action"]')].filter(row => row.querySelector('.arcify-spotlight-result-title')?.textContent === title); if (rows.length !== 1) throw new Error('Require one exact navigation action row.'); return rows[0]; }, NAVIGATION_TITLES[command]);
            assert(handle.asElement()); return handle.asElement();
        }, observation => checkpoint('fresh-navigation-action-click', { command, observation }));
    };
    const choose = async (surface, captured, destination) => {
        const index = captured.navigation.destinations.findIndex(item => item.spaceId === destination.spaceId && item.bookmarkFolderId === destination.bookmarkFolderId); assert(index >= 0);
        const select = await surface.$('[data-space-destination]'); assert(select);
        try {
            // Native select keyboard changes, no Puppeteer select()/DOM setter or
            // synthetic change event. Assert every real movement before continuing.
            await select.press('Home');
            let value = await surface.$eval('[data-space-destination]', node => node.value);
            assert(value === '' || value === '0', 'Home must remain on the placeholder or first enabled choice.');
            if (value === '') { await select.press('ArrowDown'); value = await surface.$eval('[data-space-destination]', node => node.value); assert.equal(value, '0'); }
            for (let at = 0; at < index; at++) { await select.press('ArrowDown'); assert.equal(await surface.$eval('[data-space-destination]', node => node.value), String(at + 1)); }
        } finally { await select.dispose(); }
        assertNavigationPicker(await surface.evaluate(readNavigationPicker), captured.command, captured.navigation, index); return index;
    };
    const cancel = async (page, command, captured, method, activation) => {
        const { surface, rows } = await ready(page, command);
        await ui(page, 'Cancel a real destination picker without changing any state', async () => {
            const before = await settle(); await reset(surface); await invoke(surface, command, activation);
            await surface.waitForSelector('.arcify-space-action-prompt', { visible: true }); const picker = await surface.evaluate(readNavigationPicker); assertNavigationPicker(picker, command, captured.navigation);
            const geometry = await requireActionPromptGeometry({ surface, selector: '.arcify-space-action-prompt', poll });
            const screenshot = await capture(page, `${command}-cancel-${method}`);
            if (method === 'Escape') { const select = await surface.$('[data-space-destination]'); try { await select.press('Escape'); } finally { await select.dispose(); } }
            else await surface.click('[data-action-cancel]');
            await surface.waitForSelector('.arcify-space-action-prompt', { hidden: true });
            const after = await read(), observed = await trace(surface); assertSpotlightActionUnchanged(before, after); assertNavigationNoMutation(observed.events);
            assertNavigationInput(observed.input, command, { outcome: 'cancel', activation });
            assert.equal(await surface.$eval('[data-testid="spotlight-input"]', node => node.value), NAVIGATION_QUERIES[command]);
            await checkpoint('picker-cancelled-zero-mutation', { command, method, activation, before, after, rows, picker, geometry, observed, screenshot });
        });
    };
    const commit = async (page, command, captured, destination, { activation = 'click', submission = 'click', groupSync = false } = {}) => {
        const { surface, rows, inputOwner } = await ready(page, command); let outcome;
        await ui(page, 'Choose an exact existing Space through genuine Spotlight input', async () => {
            const before = await settle(); await reset(surface); await invoke(surface, command, activation);
            await surface.waitForSelector('.arcify-space-action-prompt', { visible: true }); const picker = await surface.evaluate(readNavigationPicker); assertNavigationPicker(picker, command, captured.navigation);
            const initialGeometry = await requireActionPromptGeometry({ surface, selector: '.arcify-space-action-prompt', poll });
            const index = await choose(surface, { ...captured, command }, destination);
            const geometry = await requireActionPromptGeometry({ surface, selector: '.arcify-space-action-prompt', poll });
            const screenshot = await capture(page, `${command}-chosen-${destination.spaceId}`);
            if (submission === 'Enter') { const select = await surface.$('[data-space-destination]'); try { await select.press('Enter'); } finally { await select.dispose(); } }
            else await surface.click(`[data-action-confirm="${command}"]`);
            // A populated Switch activates a different native tab and retires the
            // original overlay. Read only retained passive input and native APIs.
            const observed = await poll(() => trace(surface, inputOwner), value => value.events.some(event => event.type === 'external' && mutations.includes(event.data.message.command)), 'one observed navigation dispatch');
            await checkpoint('navigation-dispatched-before-validation', { command, before, rows, picker, initialGeometry, geometry, observed, screenshot });
            const request = assertNavigationRequest(observed.events, command, captured, destination, spotlightId);
            const after = await poll(read, state => state.journal.some(entry => entry.fingerprint === JSON.stringify(request) && typeof entry.response?.ok === 'boolean'), 'one exact durable navigation receipt');
            await checkpoint('navigation-receipt-before-validation', { command, before, after, request, observed });
            assertNavigationInput(observed.input, command, { outcome: 'commit', destinationIndex: index, activation, submission });
            const finalState = groupSync && command === 'switchSpace' ? await settle() : await read();
            const finalTrace = await trace(surface, inputOwner);
            assert.deepEqual(assertNavigationRequest(finalTrace.events, command, captured, destination, spotlightId), request, 'No late automatic retry during settled readback.');
            assertNavigationCommitted(before, finalState, { command, captured, destination, request, events: finalTrace.events, groupSync });
            const retiresOverlay = navigationRetiresOverlay(before, command, captured, destination);
            const completion = await waitForActionSurfaceCompletion({ page, surface, retiresOverlay,
                waitStatus: () => surface.waitForFunction(text => [...document.querySelectorAll('.arcify-bridge-status')].some(node => node.textContent.includes(text)), { polling: 50 }, command === 'switchSpace' ? 'Selected Space switched.' : 'Current tab moved. This Space stays selected.') });
            const completedState = await read();
            const completionTrace = await trace(surface, inputOwner);
            assert.deepEqual(assertNavigationRequest(completionTrace.events, command, captured, destination, spotlightId), request, 'Completion must not replay the action.');
            const proof = assertNavigationCommitted(before, completedState, { command, captured, destination, request, events: completionTrace.events, groupSync });
            await checkpoint('navigation-committed-exactly-once', { before, after: completedState, rows, picker, initialGeometry, geometry, observed, finalTrace, completionTrace, completion, request, proof, screenshot });
            outcome = { before, after: completedState, request, proof, surface };
        }); return outcome;
    };
    const rejectPrepared = async (page, captured, command, destination, label, alter) => {
        const { surface } = await ready(page, command);
        await ui(page, 'Prepare an exact destination before its context changes', async () => { await invoke(surface, command, 'click'); await surface.waitForSelector('.arcify-space-action-prompt', { visible: true }); await choose(surface, { ...captured, command }, destination); await requireActionPromptGeometry({ surface, selector: '.arcify-space-action-prompt', poll }); });
        await alter();
        await ui(page, 'Reject the stale destination once without retry', async () => {
            // Raw read remains valid after peer revocation, unlike bridge snapshot.
            const raw = () => apiPage.evaluate(async () => ({ tabs: await chrome.tabs.query({}), windows: await chrome.windows.getAll(), bookmarks: await chrome.bookmarks.getTree(), local: await chrome.storage.local.get(null), session: await chrome.storage.session.get(null) }));
            let stableRaw, stableSince;
            const before = await poll(async () => { await local({ action: 'get' }); return raw(); }, value => { const serialized = JSON.stringify(value); if (serialized !== stableRaw) { stableRaw = serialized; stableSince = Date.now(); return false; } return Date.now() - stableSince >= 400; }, 'settled raw state before rejected confirmation'); await reset(surface);
            const geometry = await requireActionPromptGeometry({ surface, selector: '.arcify-space-action-prompt', poll });
            await surface.click(`[data-action-confirm="${command}"]`);
            await surface.waitForSelector('.arcify-bridge-status[data-state="error"]', { visible: true });
            await local({ action: 'get' }); const after = await raw(), observed = await trace(surface);
            assert.deepEqual(after, before, 'Rejected prepared action cannot change native or stored state.'); assertNavigationNoMutation(observed.events);
            const attempts = observed.peerEvents.filter(event => event.type === 'internal' && event.data.message.action === 'arcifySpaceAction'); assert.equal(attempts.length, 1);
            const error = await surface.$eval('.arcify-bridge-status[data-state="error"]', node => node.textContent); assert(error.length > 0);
            await checkpoint(label, { before, after, geometry, observed, error, screenshot: await capture(page, label) });
        });
    };
    try {
        await option(false);
        await apiPage.evaluate(installSpotlightActionApiObservation); await spotlightOptions.evaluate(installSpotlightActionApiObservation); await apiPage.evaluate(installNavigationGroupObservation);
        const root = await apiPage.evaluate(async () => { const roots = (await chrome.bookmarks.search({ title: 'Arcify' })).filter(node => !node.url); if (roots.length !== 1) throw new Error('Require one Arcify root.'); return roots[0]; });
        for (const name of ['Source', 'Destination', 'Empty']) { const folder = await apiPage.evaluate(options => chrome.bookmarks.create(options), { parentId: root.id, title: `Navigation ${name === 'Source' ? 'Source' : 'Duplicate destination'} ${nonce}` }); spaceRoots.push(folder.id); }
        const discovered = await local({ action: 'get' });
        [source, target, empty] = spaceRoots.map(id => { const matches = discovered.spaces.filter(space => space.bookmarkFolderId === id); assert.equal(matches.length, 1); spaceIds.push(matches[0].id); return matches[0]; });
        // Canonical representation is fixture configuration, never an action shortcut.
        await apiPage.evaluate(() => chrome.storage.local.set({ todayOrderRepresentation: { version: 1, inverted: false } }));
        const sourcePage = await seed('switch-source'), destinationPage = await seed('destination-one', target.id), destinationTail = await seed('destination-two', target.id);
        await activate(destinationPage.tab.id); await local({ action: 'get' });
        await openOverlay(sourcePage.tab, sourcePage.page); let captured = await context(sourcePage.tab.id, 'today');
        await cancel(sourcePage.page, 'switchSpace', captured, 'Escape', 'Enter');
        await cancel(sourcePage.page, 'moveCurrentTodayTab', captured, 'Cancel', 'click');
        // Empty selection must reject Enter without inventing a target.
        {
            const command = 'switchSpace', { surface } = await ready(sourcePage.page, command);
            await ui(sourcePage.page, 'Require an explicit destination before Enter', async () => {
                const before = await settle(); await reset(surface); await invoke(surface, command, 'Enter'); await surface.waitForSelector('[data-space-destination]');
                const select = await surface.$('[data-space-destination]'); try { await select.press('Enter'); } finally { await select.dispose(); }
                const picker = await surface.evaluate(readNavigationPicker); assertNavigationPicker(picker, command, captured.navigation);
                const geometry = await requireActionPromptGeometry({ surface, selector: '.arcify-space-action-prompt', poll }); assert.equal(picker.error, 'Choose a destination Space first.');
                const after = await read(), observed = await trace(surface); assertSpotlightActionUnchanged(before, after); assertNavigationNoMutation(observed.events);
                assertNavigationInput(observed.input, command, { outcome: 'no-choice', activation: 'Enter', submission: 'Enter' });
                await checkpoint('empty-picker-enter-does-not-guess', { before, after, picker, geometry, observed, screenshot: await capture(sourcePage.page, 'no-destination-error') });
                await surface.click('[data-action-cancel]');
            });
        }
        await commit(sourcePage.page, 'switchSpace', captured, identity(target), { activation: 'Enter', submission: 'click' });
        await capture(destinationPage.page, 'populated-switch-destination-active');
        await openOverlay(sourcePage.tab, sourcePage.page); captured = await context(sourcePage.tab.id, 'today');
        assert.equal(exact((await read()).snapshots[windowId].spaces, empty.id).tabIds.length, 0, 'Fixture requires a genuinely empty local destination.');
        await commit(sourcePage.page, 'switchSpace', captured, identity(empty), { submission: 'Enter' }); await capture(sourcePage.page, 'empty-switch-source-retained');
        await closeOverlay();
        // Other-window-only destination is locally empty and must remain unfocused.
        await seed('other-window-empty', empty.id, otherWindow);
        await openOverlay(sourcePage.tab, sourcePage.page); captured = await context(sourcePage.tab.id, 'today');
        await commit(sourcePage.page, 'switchSpace', captured, identity(empty), { activation: 'Enter', submission: 'Enter' });
        await closeOverlay();
        for (const requestedUrl of [`chrome-extension://${spotlightId}/newtab.html`, 'chrome://newtab/']) {
            await activate(sourcePage.tab.id); await local({ action: 'activate', windowId, spaceId: source.id }); await reset();
            helper = await newTabPage(requestedUrl, windowId); owned.push(helper.tab.id);
            await helper.page.waitForSelector('[data-testid="spotlight-input"]', { visible: true });
            await poll(() => apiPage.evaluate(id => chrome.tabs.get(id), helper.tab.id), tab => tab.status === 'complete' && !tab.pendingUrl, 'settled exact New Tab helper');
            const helperCaptured = await context(helper.tab.id, null); await search(helper.page, '');
            const rows = await poll(() => helper.page.evaluate(readSpotlightRows), rows => rows.some(row => row.title === NAVIGATION_TITLES.switchSpace), 'helper exposes Switch and never Move');
            assert.deepEqual(rows.filter(row => row.type === 'arcify-space-action').map(row => row.title).sort(), ['Create folder in this Space', 'Open Arcify settings', NAVIGATION_TITLES.switchSpace].sort());
            await search(helper.page, NAVIGATION_QUERIES.moveCurrentTodayTab); const unavailable = await helper.page.evaluate(readSpotlightRows);
            assert(!unavailable.some(row => row.type === 'arcify-space-action' && row.title === NAVIGATION_TITLES.moveCurrentTodayTab)); assert(unavailable.some(row => row.type === 'search-query'));
            const helperState = await helper.page.evaluate(readNewTabReuseState);
            if (requestedUrl === 'chrome://newtab/') {
                let observed;
                const { state: originState, origin } = await collectSpotlightHelperOrigin({ initialState: helperState, poll, spotlightId, tabId: helper.tab.id, windowId, contextAction: 'arcifySpaceActionsContext',
                    read: async () => { observed = await trace(); const state = await helper.page.evaluate(readNewTabReuseState); return { state, peerEvents: observed.peerEvents }; } });
                await checkpoint('browser-helper-real-nonce-proof', { helperState, originState, observed, origin });
            }
            const before = await read(); await reset();
            const rejection = await external(spotlightOptions, arcifyId, 'moveCurrentTodayTab', { windowId, supportedFeatures: NAVIGATION_FEATURES, context: helperCaptured.context, sourceUrl: helperCaptured.navigation.sourceUrl, destination: identity(target), inverted: helperCaptured.navigation.inverted });
            assert.equal(rejection?.ok, false); assert.equal(rejection.error?.code, 'INVALID_REQUEST'); const after = await read(), rejectedTrace = await trace();
            assertSpotlightActionUnchanged(before, after); assertSpotlightActionNoWrites(rejectedTrace.events, { allowRejectedRequests: true });
            assertNavigationRequest(rejectedTrace.events, 'moveCurrentTodayTab', helperCaptured, identity(target), spotlightId); assert.deepEqual(changedStorage(rejectedTrace.events), []); assert.deepEqual(rejectedTrace.events.filter(event => event.type.startsWith('tabGroups.')), []);
            await checkpoint('helper-move-real-transport-rejected', { before, after, rejection, rejectedTrace, rows, unavailable });
            await cancel(helper.page, 'switchSpace', helperCaptured, 'Cancel', 'Enter');
            await commit(helper.page, 'switchSpace', helperCaptured, identity(empty), { activation: 'click', submission: 'Enter' });
            const retained = await helper.page.evaluate(readNewTabReuseState);
            for (const key of ['url', 'timeOrigin']) assert.equal(retained[key], helperState[key]); assert.equal(retained.tab.id, helper.tab.id); assert.equal(retained.tab.active, true);
            await capture(helper.page, requestedUrl.startsWith('chrome://') ? 'browser-helper-empty-switch' : 'owned-helper-empty-switch');
        }
        for (const groupSync of [false, true]) for (const inverted of [false, true]) {
            await option(groupSync); await apiPage.evaluate(inverted => chrome.storage.local.set({ todayOrderRepresentation: { version: 1, inverted } }), inverted);
            const current = await seed(`move-${groupSync ? 'on' : 'off'}-${inverted ? 'inverted' : 'normal'}`);
            const bookmark = await apiPage.evaluate(options => chrome.bookmarks.create(options), { parentId: source.bookmarkFolderId, title: `Decoy ${nonce} ${current.tab.id}`, url: current.url }); roots.push(bookmark.id);
            const decoy = await openSavedPage({ windowId: otherWindow, spaceId: source.id, bookmarkId: bookmark.id, url: current.url }); owned.push(decoy.tab.id); pages.set(decoy.tab.id, decoy.page); await decoy.page.waitForSelector('#action-page-state');
            const twinPage = await createNavigationFixturePage({ browser, apiPage, observePage, poll, windowId, url: current.url }); const twin = twinPage.tab; owned.push(twin.id); pages.set(twin.id, twinPage.page);
            await twinPage.page.waitForSelector('#action-page-state'); await local({ action: 'assign', tabId: twin.id, spaceId: source.id });
            await ui(twinPage.page, 'Preserve independent same-address Today twin input', () => twinPage.page.type('#action-page-state', `-twin-${twin.id}`));
            await openOverlay(current.tab, current.page); const moveContext = await context(current.tab.id, 'today');
            const result = await commit(current.page, 'moveCurrentTodayTab', moveContext, identity(target), { activation: inverted ? 'click' : 'Enter', submission: inverted ? 'Enter' : 'click' });
            assert.equal(result.after.bindings[decoy.tab.id]?.bookmarkId, bookmark.id);
            assert.deepEqual(exact(result.after.tabs, twin.id), exact(result.before.tabs, twin.id)); assert(exact(result.after.spaces, source.id).temporaryTabs.includes(twin.id)); assert.equal(result.after.tabs.find(tab => tab.id === current.tab.id)?.active, true);
            // Genuine typed search refreshes the still-open live renderer. The
            // exact current-window ID is independently proven by bridge snapshot.
            await search(current.page, `Spotlight Navigation move-${groupSync ? 'on' : 'off'}-${inverted ? 'inverted' : 'normal'}`);
            const refreshed = await poll(() => result.surface.evaluate(readSpotlightRows), rows => { const matches = rows.filter(row => row.type === 'open-tab' && row.title === exact(result.after.tabs, current.tab.id).title); return matches.some(row => row.space === target.name) && matches.some(row => row.space === source.name); }, 'live Spotlight row reflects exact moved tab destination');
            const freshContext = await external(spotlightOptions, arcifyId, 'navigationContext', { windowId, tabId: current.tab.id, supportedFeatures: NAVIGATION_FEATURES });
            assert.equal(freshContext?.ok, true); assert.equal(freshContext.actionContext.spaceId, source.id); assert.equal(freshContext.actionContext.tab, null, 'Moved active tab is no longer a Today member of selected source; never borrow another source tab.');
            const { surface } = await ready(current.page, 'switchSpace');
            const input = await surface.$('[data-testid="spotlight-input"]'); try { await ui(current.page, 'Keep ordinary web search manually selectable after Move', () => selectResultWithKeyboard(input, () => surface.evaluate(readSpotlightRows), row => row.type === 'search-query')); } finally { await input.dispose(); }
            assert.equal((await surface.evaluate(readSpotlightRows)).find(row => row.selected)?.type, 'search-query');
            await surface.evaluate(() => { globalThis.__navigationRenderWatch?.disconnect(); globalThis.__navigationRenderRevision = 0; const watch = new MutationObserver(records => { if (records.some(record => [...record.addedNodes, ...record.removedNodes].some(node => node.nodeType === 1 && (node.matches?.('[data-testid=\"spotlight-result\"]') || node.querySelector?.('[data-testid=\"spotlight-result\"]'))))) globalThis.__navigationRenderRevision++; }); watch.observe(document.body, { childList: true, subtree: true }); globalThis.__navigationRenderWatch = watch; });
            const refreshBookmark = await apiPage.evaluate(options => chrome.bookmarks.create(options), { parentId: source.bookmarkFolderId, title: `Passive refresh ${nonce} ${current.tab.id}`, url: current.url }); roots.push(refreshBookmark.id);
            await poll(() => surface.evaluate(() => globalThis.__navigationRenderRevision), value => value > 0, 'actual passive result-row refresh after real bookmark invalidation');
            const passiveRows = await surface.evaluate(readSpotlightRows); assert.equal(passiveRows.find(row => row.selected)?.type, 'search-query');
            assert.equal(await surface.$eval('[data-testid=\"spotlight-input\"]', node => node.value), NAVIGATION_QUERIES.switchSpace);
            await surface.evaluate(() => globalThis.__navigationRenderWatch.disconnect());
            await checkpoint('manual-web-search-survives-passive-refresh', { passiveRows, refreshBookmarkId: refreshBookmark.id, observed: await trace(surface) });
            evidence.matrix.push({ groupSync, inverted, sourceTabId: current.tab.id, twinTabId: twin.id, decoyTabId: decoy.tab.id });
            await checkpoint('live-move-refresh', { groupSync, inverted, refreshed, freshContext, screenshot: await capture(current.page, `moved-${groupSync}-${inverted}`) }); await closeOverlay();
        }
        // Settled sync-on Switch permits only expected source-window collapse changes.
        await option(true); await openOverlay(sourcePage.tab, sourcePage.page);
        const switchSynced = await context(sourcePage.tab.id, 'today');
        await commit(sourcePage.page, 'switchSpace', switchSynced, identity(target), { activation: 'Enter', submission: 'Enter', groupSync: true }); await closeOverlay();
        await option(false); await activate(helper.tab.id); await local({ action: 'activate', windowId, spaceId: source.id });
        let helperContext = await context(helper.tab.id, null);
        await rejectPrepared(helper.page, helperContext, 'switchSpace', identity(target), 'source-space-changed-rejected', () => local({ action: 'activate', windowId, spaceId: empty.id }));
        await local({ action: 'activate', windowId, spaceId: source.id });
        // Context rejection clears stale action rows. A fresh helper document is
        // an ordinary retry only after a new user-like surface, never action replay.
        await helper.page.reload({ waitUntil: 'domcontentloaded' }); await helper.page.waitForSelector('[data-testid="spotlight-input"]', { visible: true }); helperContext = await context(helper.tab.id, null);
        await rejectPrepared(helper.page, helperContext, 'switchSpace', identity(target), 'pairing-revoked-rejected', async () => {
            await ui(apiPage, 'Revoke the actual Arcify pairing before confirming Switch', () => apiPage.click('#bridgeDisconnect')); revoked = true;
            await apiPage.waitForSelector('#bridgeStatus[data-state="disabled"]');
        });
        return evidence;
    } catch (error) {
        primaryError = error; await checkpoint('space-navigation-failed', { error: { message: error.message, stack: error.stack }, owned, roots }).catch(() => {}); throw error;
    } finally {
        await finishBookmarkFixture([
            async () => { if (revoked) { await ui(apiPage, 'Restore exact paired peer in Arcify settings', async () => { const field = await apiPage.$('#bridgePeerId'); try { await replaceInputText(apiPage, field, spotlightId); } finally { await field.dispose(); } await apiPage.click('#bridgeSave'); }); await apiPage.waitForSelector('#bridgeStatus[data-state="connected"]'); revoked = false; } },
            closeOverlay,
            async () => { for (const state of [initial, initialOther]) { const tab = state.tabs.find(tab => tab.active); if (tab) await apiPage.evaluate(id => chrome.tabs.update(id, { active: true }), tab.id); await local({ action: 'activate', windowId: state.windowId, spaceId: state.activeSpaceId }); } },
            () => apiPage.evaluate(async ids => { const live = new Set((await chrome.tabs.query({})).map(tab => tab.id)); const present = [...new Set(ids)].filter(id => live.has(id)); if (present.length) await chrome.tabs.remove(present); }, owned),
            () => apiPage.evaluate(async ids => { for (const id of ids) { let node; try { [node] = await chrome.bookmarks.get(id); } catch { continue; } if (!node.url) throw new Error('Cleanup refuses unexpected non-leaf bookmark.'); await chrome.bookmarks.remove(id); } }, roots),
            async () => { const discovered = await local({ action: 'get' }); for (const space of discovered.spaces.filter(space => spaceRoots.includes(space.bookmarkFolderId))) { assert([...space.spaceBookmarks, ...space.temporaryTabs].every(id => owned.includes(id)), 'Cleanup refuses unowned tab membership.'); await local({ action: 'delete', spaceId: space.id }); } },
            () => apiPage.evaluate(async ids => { for (const id of ids) { let nodes; try { nodes = await chrome.bookmarks.getSubTree(id); } catch { continue; } if (nodes.length !== 1 || nodes[0].url || nodes[0].children?.length) throw new Error('Cleanup refuses unexpected nonempty nonce Space root.'); await chrome.bookmarks.removeTree(id); } }, spaceRoots),
            () => apiPage.evaluate(async original => { if (Object.hasOwn(original, 'todayOrderRepresentation')) await chrome.storage.local.set(original); else await chrome.storage.local.remove('todayOrderRepresentation'); }, settings.local),
            () => option(Boolean(settings.sync.syncTabGroups)),
            () => apiPage.evaluate(async original => { if (!Object.hasOwn(original, 'syncTabGroups')) await chrome.storage.sync.remove('syncTabGroups'); }, settings.sync),
            async () => { for (const tab of settings.tabs.filter(tab => tab.active)) await apiPage.evaluate(id => chrome.tabs.update(id, { active: true }), tab.id);
                for (const [id, spaceId] of Object.entries(settings.session.activeSpaces || {})) if (settings.windows.some(window => window.id === Number(id))) await local({ action: 'activate', windowId: Number(id), spaceId }); },
            async () => { const focused = settings.windows.find(window => window.focused); if (focused) await apiPage.evaluate(id => chrome.windows.update(id, { focused: true }), focused.id); },
            async () => { await local({ action: 'get' }); const remaining = await apiPage.evaluate(async ({ owned, roots }) => ({ nativeTabs: await chrome.tabs.query({}), windows: await chrome.windows.getAll(), tabs: (await chrome.tabs.query({})).filter(tab => owned.includes(tab.id)).map(tab => tab.id), bookmarks: (await chrome.bookmarks.getTree()).flatMap(function flatten(node) { return [node, ...(node.children || []).flatMap(flatten)]; }).filter(node => roots.includes(node.id)).map(node => node.id), local: await chrome.storage.local.get(['spaces', 'todayOrderRepresentation']), sync: await chrome.storage.sync.get('syncTabGroups'), session: await chrome.storage.session.get('activeSpaces') }), { owned, roots: [...roots, ...spaceRoots] });
                assert.deepEqual(remaining.tabs, []); assert.deepEqual(remaining.bookmarks, []);
                assert.deepEqual(remaining.nativeTabs.map(tab => tab.id).sort((a, b) => a - b), settings.tabs.map(tab => tab.id).sort((a, b) => a - b));
                for (const tab of settings.tabs) { const kept = exact(remaining.nativeTabs, tab.id); for (const key of ['windowId', 'url', 'pinned', 'incognito', 'active', 'splitViewId']) assert.equal(kept[key], tab[key], `Cleanup preserves original native ${key}.`); }
                assert.deepEqual(remaining.windows.filter(window => window.focused).map(window => window.id), settings.windows.filter(window => window.focused).map(window => window.id));
                for (const space of remaining.local.spaces) { assert(!spaceIds.includes(space.id)); assert(![...space.temporaryTabs, ...space.spaceBookmarks].some(id => owned.includes(id))); }
                assert.deepEqual(remaining.sync, settings.sync); assert.deepEqual(Object.fromEntries(Object.entries(remaining.local).filter(([key]) => key === 'todayOrderRepresentation')), settings.local);
                assert.deepEqual(remaining.session.activeSpaces, settings.session.activeSpaces);
                await checkpoint('cleanup-verified', { remaining }); },
            () => apiPage.evaluate(() => { globalThis.__spaceActionObservation?.stop(); globalThis.__navigationGroupObservation?.stop(); }),
            () => spotlightOptions.evaluate(() => globalThis.__spaceActionObservation?.stop())
        ], primaryError, record);
    }
}
