/** Initial paired Space-action acceptance. Import-safe; the hosted harness owns Chrome. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { spotlightSurface } from './paired-chrome-keyboard.mjs';
import { replaceInputText, clickFreshResult, selectResultWithKeyboard } from './paired-chrome-ui.mjs';
import { readSpotlightRows, assertMatchedActionFirst, evaluateWithoutGesture } from './paired-chrome-sidebar.mjs';
import { readNewTabReuseState } from './paired-chrome-newtab.mjs';
import { canonicalSavedMoveBookmarks } from './paired-chrome-saved-move.mjs';
import { finishBookmarkFixture } from './paired-chrome-bookmark-selection.mjs';

export const SPOTLIGHT_ACTION_CASE_NAME = 'Initial Spotlight actions preserve exact live and saved identities through overlay and browser New Tab input';
export const SPACE_ACTION_FEATURES = ['globalFavoritesV1', 'spaceActionsV1'];
export const SPACE_ACTION_TITLES = Object.freeze({ pinCurrentTab: 'Pin current tab to this Space', removeCurrentPin: 'Remove current saved Space pin', createSpaceFolder: 'Create folder in this Space', openSettings: 'Open Arcify settings' });
export const SPACE_ACTION_QUERIES = Object.freeze({ pinCurrentTab: 'pin curent tab', removeCurrentPin: 'remvoe pin', createSpaceFolder: 'new fodler', openSettings: 'arcify settngs' });
const commands = Object.keys(SPACE_ACTION_TITLES);
const flat = nodes => nodes.flatMap(node => [node, ...flat(node.children || [])]);
const exact = (nodes, id) => { const found = nodes.filter(node => node.id === id); assert.equal(found.length, 1, `Require exact unique identity ${id}.`); return found[0]; };
const snapshots = value => Object.fromEntries(Object.entries(value).map(([id, { capturedAt, ...state }]) => [id, state]));
const canonical = state => ({ ...state, snapshots: snapshots(state.snapshots) });

// The initial peer exposes exactly folder/settings; the reviewed extended peer
// adds only Switch Space. Neither helper surface can acquire a source-tab action.
export function assertSpotlightHelperActionRows(rows, { helperNavigation = false } = {}) {
    assert.equal(typeof helperNavigation, 'boolean');
    assert.deepEqual(rows.filter(row => row.type === 'arcify-space-action').map(row => row.title).sort(),
        [SPACE_ACTION_TITLES.createSpaceFolder, SPACE_ACTION_TITLES.openSettings, ...(helperNavigation ? ['Switch Space'] : [])].sort());
    assert(!rows.some(row => row.type === 'arcify-tab-action'), 'A helper cannot borrow a previous native tab for tab commands.');
}

export function assertSpotlightActionEnvironment(env = process.env, uid = process.getuid?.()) {
    assert.equal(env.GITHUB_ACTIONS, 'true', 'Space-action acceptance runs only in the dedicated hosted job.');
    assert.equal(env.CI, 'true'); assert.notEqual(uid, 0, 'Never launch a browser or disable its sandbox for root.');
}
export function serveSpotlightActionFixture(request, response) {
    const match = /^\/spotlight-actions\/([a-f0-9]{32})\/([a-z-]+)$/.exec(new URL(request.url, 'http://127.0.0.1').pathname);
    if (!match) return false;
    const title = `Spotlight Action ${match[2]} ${match[1]}`;
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-src 'none'" });
    response.end(`<!doctype html><html><head><title>${title}</title><link rel="icon" href="data:,"></head><body data-document-id="${randomBytes(16).toString('hex')}"><h1>${title}</h1><input id="action-page-state" value="retained"></body></html>`);
    return true;
}
export function readSpotlightActionPage() {
    return { url: document.URL, documentId: document.body.dataset.documentId, timeOrigin: performance.timeOrigin, value: document.querySelector('#action-page-state')?.value };
}

/** A passive listener, never a replacement transport, response, click, or success injector. */
export function installSpotlightActionApiObservation() {
    globalThis.__spaceActionObservation?.stop();
    const events = [], registrations = [];
    const listen = (event, type, transform = (...args) => args) => {
        const listener = (...args) => { events.push({ type, data: transform(...args) }); };
        event.addListener(listener); registrations.push(() => event.removeListener(listener));
    };
    listen(chrome.runtime.onMessageExternal, 'external', (message, sender) => ({ message, sender: { id: sender.id, url: sender.url || null, origin: sender.origin || null } }));
    listen(chrome.runtime.onMessage, 'internal', (message, sender) => ({ message, sender: { id: sender.id, url: sender.url || null, frameId: sender.frameId ?? null, documentLifecycle: sender.documentLifecycle || null,
        tab: sender.tab ? { id: sender.tab.id, windowId: sender.tab.windowId } : null } }));
    for (const name of ['onCreated', 'onRemoved', 'onChanged', 'onMoved']) listen(chrome.bookmarks[name], `bookmarks.${name}`);
    for (const name of ['onCreated', 'onRemoved', 'onReplaced', 'onActivated', 'onAttached', 'onDetached', 'onMoved']) listen(chrome.tabs[name], `tabs.${name}`);
    listen(chrome.tabs.onUpdated, 'tabs.onUpdated', (id, change) => ({ id, change }));
    for (const name of ['onCreated', 'onRemoved', 'onFocusChanged']) listen(chrome.windows[name], `windows.${name}`);
    if (chrome.sidePanel?.onOpened) listen(chrome.sidePanel.onOpened, 'sidePanel.onOpened');
    listen(chrome.storage.onChanged, 'storage', (changes, area) => ({ area, changes }));
    globalThis.__spaceActionObservation = { events, stop: () => registrations.forEach(remove => remove()) };
}
export function installSpotlightActionInputObservation({ retainInParent = false } = {}) {
    globalThis.__spaceActionInput?.stop();
    const events = [], registrations = [];
    for (const type of ['input', 'click', 'keydown']) {
        const listener = event => {
            const row = event.target.closest?.('[data-testid="spotlight-result"]');
            const selected = document.querySelector('[data-testid="spotlight-result"].selected');
            events.push({ type, trusted: event.isTrusted, key: event.key || null, repeat: Boolean(event.repeat), composing: Boolean(event.isComposing),
                ctrl: Boolean(event.ctrlKey), alt: Boolean(event.altKey), meta: Boolean(event.metaKey),
                title: (row || selected)?.querySelector('.arcify-spotlight-result-title')?.textContent || null,
                resultType: (row || selected)?.dataset.resultType || null,
                confirm: event.target.dataset?.actionConfirm || null, cancel: event.target.hasAttribute?.('data-action-cancel') || false,
                inPrompt: Boolean(event.target.closest?.('.arcify-space-action-prompt')), value: event.target.value ?? null });
        };
        document.addEventListener(type, listener, true); registrations.push(() => document.removeEventListener(type, listener, true));
    }
    globalThis.__spaceActionInput = { events, stop: () => registrations.forEach(remove => remove()) };
    // Settings activates another tab, legitimately retiring the overlay iframe.
    // Retain only passive event data in the unchanged source document, never a
    // live frame/controller or a replacement event/response transport.
    (retainInParent ? parent : globalThis).__spaceActionInputEvents = events;
}
export async function waitForSpotlightActionCompletion({ page, surface, command, waitStatus, waitSettings }) {
    assert(commands.includes(command));
    if (command === 'openSettings' && surface !== page) {
        await waitSettings();
        await page.waitForFunction(() => !document.getElementById('arcify-spotlight-host'), { polling: 50 });
        return;
    }
    await waitStatus(surface, { pinCurrentTab: 'Current tab saved as a Space pin.', removeCurrentPin: 'Saved pin removed. All linked tabs stay open as Today.', createSpaceFolder: 'Folder created in the selected Space.', openSettings: 'Arcify settings opened. This tab stays open.' }[command]);
    if (command === 'openSettings') await waitSettings();
}

export function readSpotlightActionPrompt() {
    const prompt = document.querySelector('.arcify-space-action-prompt'); if (!prompt) return null;
    const input = prompt.querySelector('input'), confirm = prompt.querySelector('[data-action-confirm]'), cancel = prompt.querySelector('[data-action-cancel]');
    const rect = prompt.getBoundingClientRect();
    return { role: prompt.getAttribute('role'), modal: prompt.getAttribute('aria-modal'), title: document.getElementById(prompt.getAttribute('aria-labelledby'))?.textContent,
        description: document.getElementById(prompt.getAttribute('aria-describedby'))?.textContent, visible: rect.width > 0 && rect.height > 0 && getComputedStyle(prompt).visibility !== 'hidden',
        input: input ? { value: input.value, maxLength: input.maxLength, focused: document.activeElement === input } : null,
        confirm: confirm?.textContent, command: confirm?.dataset.actionConfirm, cancel: cancel?.textContent, cancelFocused: document.activeElement === cancel };
}
export function assertSpotlightActionPrompt(prompt, command, title) {
    assert.equal(prompt?.role, 'dialog'); assert.equal(prompt.modal, 'true'); assert.equal(prompt.visible, true); assert.equal(prompt.command, command); assert.equal(prompt.cancel, 'Cancel');
    if (command === 'removeCurrentPin') {
        assert.equal(prompt.title, 'Remove saved Space pin?'); assert.equal(prompt.confirm, 'Remove saved pin'); assert.equal(prompt.cancelFocused, true); assert.equal(prompt.input, null);
        assert(prompt.description.includes(title)); assert.match(prompt.description, /Delete the saved bookmark/); assert.match(prompt.description, /Every live tab.*stay open as Today/); assert.match(prompt.description, /Other same-address pins are unchanged/);
    } else { assert.equal(prompt.title, 'Create a folder'); assert.equal(prompt.confirm, 'Create folder'); assert.deepEqual(prompt.input, { value: '', maxLength: 256, focused: true }); }
}
export function assertSpotlightActionContext(context, before, { windowId, sourceTabId, section, bookmarkId = null }) {
    assert.deepEqual(Object.keys(context).sort(), ['windowId', 'spaceId', 'bookmarkFolderId', 'pairingGeneration', 'sourceTabId', 'tab'].sort());
    assert.equal(context.windowId, windowId); assert.equal(context.sourceTabId, sourceTabId); assert.equal(context.pairingGeneration, before.pairingGeneration);
    const space = exact(before.spaces, before.activeSpaces[windowId]);
    assert.equal(context.spaceId, space.id); assert.equal(context.bookmarkFolderId, space.bookmarkFolderId);
    const source = exact(before.tabs, sourceTabId); assert.equal(source.windowId, windowId); assert.equal(source.active, true);
    if (section === null) { assert.equal(context.tab, null, 'A helper may never borrow a previous tab.'); return; }
    assert.deepEqual(Object.keys(context.tab).sort(), ['id', 'url', 'title', 'section', 'bookmark'].sort());
    assert.equal(context.tab.id, sourceTabId); assert.equal(context.tab.url, source.url); assert.equal(context.tab.section, section);
    const live = exact(before.snapshots[windowId].tabs, sourceTabId); assert.equal(context.tab.title, live.title);
    assert.equal(before.spaces.filter(item => [...item.spaceBookmarks, ...item.temporaryTabs].includes(sourceTabId)).length, 1);
    assert(space[section === 'today' ? 'temporaryTabs' : 'spaceBookmarks'].includes(sourceTabId));
    if (section === 'today') { assert.equal(context.tab.bookmark, null); assert.equal(before.bindings[sourceTabId], undefined); }
    else {
        const node = exact(flat(before.bookmarks), bookmarkId);
        assert.deepEqual(context.tab.bookmark, { id: node.id, parentId: node.parentId, title: node.title, url: node.url });
        assert.deepEqual(before.bindings[sourceTabId], { bookmarkId, pinnedUrl: node.url });
    }
}
export function assertSpotlightActionUnchanged(before, after) {
    assert.deepEqual(canonical(after), canonical(before), 'Cancellation/rejection must preserve every captured native, saved, binding, journal and per-window identity.');
}
const quietEvents = events => events.filter(event => /^tabs\.(?!onUpdated)|^windows\.|^sidePanel\./.test(event.type) || event.type === 'tabs.onUpdated' && ['url', 'pendingUrl', 'pinned', 'groupId', 'mutedInfo', 'discarded'].some(key => key in event.data.change));
export function assertSpotlightActionNoWrites(events, { allowRejectedRequests = false } = {}) {
    assert.deepEqual(quietEvents(events), [], 'No native mutation, reordering, window focus or panel-open events.');
    assert.deepEqual(events.filter(event => event.type.startsWith('bookmarks.')), [], 'Cancelled/rejected actions must perform zero bookmark writes.');
    assert.deepEqual(events.filter(event => event.type === 'storage' && ['local', 'session'].includes(event.data.area) && Object.values(event.data.changes).some(change => JSON.stringify(change.oldValue) !== JSON.stringify(change.newValue))), [], 'Cancelled/rejected actions must perform zero changed storage writes.');
    if (!allowRejectedRequests) assert.deepEqual(events.filter(event => event.type === 'external' && commands.includes(event.data.message.command)), [], 'Cancellation must not dispatch any mutation.');
}
export function assertSpotlightActionInput(events, command, { confirmed = false, cancelled = false, folderTitle } = {}) {
    assert(events.length); assert(events.every(event => event.trusted && !event.repeat && !event.composing && !event.ctrl && !event.alt && !event.meta), 'Only genuine unmodified input can satisfy action evidence.');
    const activations = events.filter(event => (event.type === 'click' || event.type === 'keydown' && event.key === 'Enter') && !event.inPrompt && event.resultType === 'arcify-space-action' && event.title === SPACE_ACTION_TITLES[command]);
    assert.equal(activations.length, 1, 'Exactly one real action activation, never a replay.');
    const submits = events.filter(event => event.inPrompt && (event.type === 'click' && event.confirm === command || event.type === 'keydown' && event.key === 'Enter' && !event.cancel));
    assert.equal(submits.length, confirmed ? 1 : 0);
    if (cancelled) assert.equal(events.filter(event => event.inPrompt && (event.type === 'click' && event.cancel || event.type === 'keydown' && event.key === 'Escape')).length, 1);
    if (folderTitle !== undefined) assert(events.some(event => event.type === 'input' && event.inPrompt && event.value === folderTitle), 'The folder name must have genuine input evidence.');
}
export function assertSpotlightActionRequest(events, command, context, spotlightId, fields = {}) {
    const requests = events.filter(event => event.type === 'external' && commands.includes(event.data.message.command));
    assert.equal(requests.length, 1, 'One UI action must send exactly one mutation.');
    const { message, sender } = requests[0].data; assert.equal(sender.id, spotlightId); assert.equal(message.command, command);
    assert.deepEqual(message.context, context); assert.equal(message.windowId, context.windowId); assert.deepEqual(message.supportedFeatures, SPACE_ACTION_FEATURES);
    assert.match(message.requestId, /^[\w.:-]{1,80}$/); assert.equal(message.type, 'arcify-bridge'); assert.equal(message.version, 1);
    assert.deepEqual(Object.keys(message).sort(), ['type', 'version', 'requestId', 'windowId', 'command', 'supportedFeatures', 'context', ...Object.keys(fields)].sort());
    for (const [key, value] of Object.entries(fields)) assert.deepEqual(message[key], value);
    assert(!events.some(event => event.type === 'external' && event.data.message.type === 'arcify-sidebar'), 'Space actions cannot replace or route through the physical sidebar transport.');
    return message;
}
export function assertSpotlightHelperProof(state, events, { spotlightId, arcifyId, tabId, windowId, request }) {
    assert.equal(state.url, `chrome-extension://${spotlightId}/newtab.html`); assert(['chrome://newtab', 'chrome://newtab/'].includes(state.tab.url));
    assert.equal(state.tab.id, tabId); assert.equal(state.tab.windowId, windowId); assert.equal(state.tab.active, true); assert.equal(state.tab.status, 'complete'); assert(!state.tab.pendingUrl); assert.equal(state.visibility, 'visible');
    const internal = events.filter(event => event.type === 'internal').map(event => event.data);
    // Bind Chrome's sender metadata to the exact action already proven committed,
    // never an unrelated context query or a URL/title-only helper match.
    assert.equal(request.command, 'createSpaceFolder'); assert.match(request.requestId, /^[\w.:-]{1,80}$/);
    assert.equal(request.windowId, windowId); assert.equal(request.context.windowId, windowId);
    assert.equal(request.context.sourceTabId, tabId); assert.equal(request.context.tab, null);
    const actions = internal.filter(({ message }) => message.action === 'arcifySpaceAction');
    assert.equal(actions.length, 1, 'Require exactly one internal action matching the committed alias operation.');
    const { message: action, sender: actionSender } = actions[0];
    assert.deepEqual(Object.keys(action).sort(), ['action', 'command', 'scope', 'fields', 'tabId'].sort());
    assert.equal(action.command, request.command); assert.equal(action.tabId, tabId); assert.deepEqual(action.fields, { title: request.title });
    assert.deepEqual(Object.keys(action.scope).sort(), ['peerId', 'generation', 'context'].sort());
    assert.equal(action.scope.peerId, arcifyId); assert(action.scope.generation === null || typeof action.scope.generation === 'string' && action.scope.generation.length > 0 && action.scope.generation.length <= 200);
    assert.deepEqual(action.scope.context, request.context);
    assert.equal(actionSender.id, spotlightId); assert.equal(actionSender.url, state.url);
    assert.equal(actionSender.frameId, 0); assert.equal(actionSender.documentLifecycle, 'active');
    const direct = actionSender.tab !== null && actionSender.tab !== undefined;
    if (direct) assert.deepEqual(actionSender.tab, { id: tabId, windowId }, 'Present sender.tab must match; it cannot fall back to a nonce.');
    const probes = internal.filter(({ message }) => message.action === 'spotlightNewTabReuseProbe');
    if (!direct) assert(probes.length > 0, 'Without browser-attested sender.tab, alias ownership requires the real nonce challenge.');
    assert.equal(new Set(probes.map(({ message }) => message.nonce)).size, probes.length);
    for (const { message, sender } of probes) {
        assert.match(message.nonce, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/); assert.equal(message.tabId, tabId); assert.equal(message.windowId, windowId); assert.equal(sender.id, spotlightId); assert.equal(sender.tab, null);
        assert(sender.url === null || sender.url === `chrome-extension://${spotlightId}/background.js`);
        const acknowledgements = internal.filter(item => item.message.action === 'spotlightNewTabReuseAck' && item.message.nonce === message.nonce);
        assert.equal(acknowledgements.length, 1); const ack = acknowledgements[0];
        assert.equal(ack.sender.id, spotlightId); assert.equal(ack.sender.url, state.url); assert([null, 0].includes(ack.sender.frameId)); assert([null, 'active'].includes(ack.sender.documentLifecycle));
        assert.equal(ack.message.tabId, tabId); assert.equal(ack.message.windowId, windowId);
        if (ack.sender.tab) assert.deepEqual(ack.sender.tab, { id: tabId, windowId });
    }
    assert.equal(internal.filter(({ message }) => message.action === 'spotlightNewTabReuseAck').length, probes.length, 'Every observed ACK must belong to exactly one verified probe.');
    return { proofKind: direct ? 'browser-attested-sender-tab' : 'nonce-challenge-ack', requestId: request.requestId,
        renderer: state.url, browserUrl: state.tab.url, tabId, windowId, nonces: probes.map(item => item.message.nonce) };
}

function stable(before, after) {
    for (const key of ['tabs', 'windows', 'groups', 'projection', 'favorites', 'favoriteSession', 'activeSpaces', 'pageStates', 'pairingGeneration']) assert.deepEqual(after[key], before[key], `${key} must be unchanged.`);
}
function assertSnapshotMembership(state) {
    for (const [wid, snapshot] of Object.entries(state.snapshots)) {
        assert.equal(snapshot.windowId, Number(wid)); assert.equal(snapshot.activeSpaceId, state.activeSpaces[wid]);
        for (const space of state.spaces) {
            const projected = exact(snapshot.spaces, space.id), local = ids => ids.filter(id => exact(state.tabs, id).windowId === Number(wid));
            assert.deepEqual(projected.pinnedTabIds, local(space.spaceBookmarks)); assert.deepEqual(projected.temporaryTabIds, local(space.temporaryTabs)); assert.deepEqual(projected.tabIds, local([...space.spaceBookmarks, ...space.temporaryTabs]));
        }
        for (const bookmark of snapshot.bookmarks) {
            const node = exact(flat(state.bookmarks), bookmark.id); assert.equal(bookmark.title, node.title); assert.equal(bookmark.url, node.url);
            if (bookmark.tabId !== null) { assert.equal(state.bindings[bookmark.tabId]?.bookmarkId, bookmark.id); assert.equal(exact(state.tabs, bookmark.tabId).windowId, Number(wid)); }
        }
    }
    for (const space of state.spaces) for (const id of [...space.spaceBookmarks, ...space.temporaryTabs]) assert.equal(state.spaces.flatMap(item => [...item.spaceBookmarks, ...item.temporaryTabs]).filter(value => value === id).length, 1, 'Never duplicate a native binding or membership.');
}
export function assertSpotlightActionCommitted(before, after, { command, context, resultId, title, events, request }) {
    assert(['pinCurrentTab', 'removeCurrentPin', 'createSpaceFolder'].includes(command)); stable(before, after);
    assert.deepEqual(quietEvents(events), [], 'Pin/removal/folder actions never mutate native pages or open a physical panel.');
    const expectedBookmarks = structuredClone(before.bookmarks), source = exact(before.spaces, context.spaceId), root = exact(flat(expectedBookmarks), context.bookmarkFolderId);
    const expectedSpaces = structuredClone(before.spaces), expectedSource = exact(expectedSpaces, source.id), bindings = structuredClone(before.bindings), aliases = structuredClone(before.aliases);
    const newNode = command === 'removeCurrentPin' ? null : exact(flat(after.bookmarks), resultId);
    let affected = [];
    if (command === 'removeCurrentPin') {
        assert.equal(resultId, context.tab.bookmark.id); const old = exact(flat(expectedBookmarks), resultId), parent = exact(flat(expectedBookmarks), old.parentId);
        parent.children = parent.children.filter(node => node.id !== resultId); parent.children.forEach((node, index) => { node.index = index; });
        affected = Object.entries(before.bindings).filter(([, binding]) => binding.bookmarkId === resultId).map(([id]) => Number(id)).filter(id => before.tabs.some(tab => tab.id === id));
        assert(affected.includes(context.sourceTabId));
        for (const id of affected) { assert(source.spaceBookmarks.includes(id)); delete bindings[id]; delete aliases[id]; }
        expectedSource.spaceBookmarks = source.spaceBookmarks.filter(id => !affected.includes(id)); expectedSource.temporaryTabs = [...source.temporaryTabs, ...affected];
    } else {
        assert(!flat(before.bookmarks).some(node => node.id === resultId));
        assert.equal(newNode.parentId, root.id); assert.equal(newNode.index, root.children.length); assert(Number.isFinite(newNode.dateAdded));
        assert.equal(newNode.title, command === 'pinCurrentTab' ? context.tab.title : title);
        if (command === 'pinCurrentTab') { assert.equal(newNode.url, context.tab.url); affected = [context.sourceTabId]; bindings[context.sourceTabId] = { bookmarkId: resultId, pinnedUrl: context.tab.url };
            expectedSource.temporaryTabs = source.temporaryTabs.filter(id => id !== context.sourceTabId); expectedSource.spaceBookmarks = [...source.spaceBookmarks, context.sourceTabId];
        } else { assert.equal(newNode.url, undefined); assert.deepEqual(newNode.children, []); }
        root.children.push(structuredClone(newNode));
    }
    assert.deepEqual(after.bookmarks, expectedBookmarks, 'Only one exact bookmark changes; unrelated metadata, nested children and sibling order survive.');
    assert.deepEqual(after.spaces, expectedSpaces); assert.deepEqual(after.bindings, bindings); assert.deepEqual(after.aliases, aliases);
    const bookmarkEvents = events.filter(event => event.type.startsWith('bookmarks.'));
    assert.equal(bookmarkEvents.length, 1); assert.equal(bookmarkEvents[0].type, command === 'removeCurrentPin' ? 'bookmarks.onRemoved' : 'bookmarks.onCreated'); assert.equal(bookmarkEvents[0].data[0], resultId);
    assertSnapshotMembership(after);
    const expectedSaved = before.savedSnapshot.map(old => {
        const expected = structuredClone(old);
        if (affected.includes(old.tabId)) {
            expected.section = command === 'pinCurrentTab' ? 'spaceBookmarks' : 'temporaryTabs';
            if (command === 'pinCurrentTab') expected.pinnedState = bindings[old.tabId]; else { delete expected.pinnedState; delete expected.nameOverride; }
        }
        if (command !== 'createSpaceFolder' && old.spaceId === source.id && before.tabs.some(tab => tab.id === old.tabId))
            expected.order = expectedSource[expected.section].indexOf(old.tabId);
        return expected;
    });
    const byId = records => [...records].sort((a, b) => a.tabId - b.tabId);
    assert.deepEqual(byId(after.savedSnapshot), byId(expectedSaved), 'Persist every exact native identity, bookmark metadata and canonical section/order once, retaining unrelated records.');
    for (const id of affected) assert.equal(after.savedSnapshot.filter(item => item.tabId === id).length, 1);
    if (command === 'createSpaceFolder') assert.deepEqual(snapshots(after.snapshots), snapshots(before.snapshots), 'Empty-folder creation cannot change leaf search results or native ownership.');
    const receipt = after.journal.filter(item => item.fingerprint === JSON.stringify(request)); assert.equal(receipt.length, 1); assert.equal(receipt[0].response?.ok, true);
    assert.equal(receipt[0].response[command === 'createSpaceFolder' ? 'folderId' : 'bookmarkId'], resultId);
    return { command, resultId, affected, bookmarkEvents };
}
export function assertSpotlightSettingsOpened(before, after, { context, arcifyId, events, platform = process.platform }) {
    const added = after.tabs.filter(tab => !before.tabs.some(previous => previous.id === tab.id)); assert.equal(added.length, 1);
    const settings = added[0]; assert.equal(settings.windowId, context.windowId); assert.equal(settings.url, `chrome-extension://${arcifyId}/options.html`); assert.equal(settings.active, true); assert.equal(settings.pinned, false);
    assert.deepEqual(after.tabs.filter(tab => tab.id !== settings.id).map(tab => ({ ...tab, active: exact(before.tabs, tab.id).active })), before.tabs, 'Settings retains all pre-existing IDs, native order, URLs, windows and pin state.');
    for (const tab of before.tabs) assert.equal(exact(after.tabs, tab.id).active, tab.windowId === context.windowId ? false : tab.active);
    for (const key of ['windows', 'bookmarks', 'bindings', 'aliases', 'favorites', 'favoriteSession', 'activeSpaces', 'pageStates']) assert.deepEqual(after[key], before[key], `Settings must preserve ${key}.`);
    for (const [endpoint, state] of [['before', before], ['after', after]]) {
        exact(state.windows, context.windowId);
        assert(state.windows.every(window => window.focused === (window.id === context.windowId)), `Settings requires the source window alone focused ${endpoint} the action.`);
    }
    const other = Number(Object.keys(before.snapshots).find(wid => Number(wid) !== context.windowId)); assert.deepEqual(snapshots({ [other]: after.snapshots[other] }), snapshots({ [other]: before.snapshots[other] }));
    assert.equal(events.filter(event => event.type === 'tabs.onCreated').length, 1);
    // Chrome documents Linux WINDOW_ID_NONE notifications during native focus transitions:
    // https://developer.chrome.com/docs/extensions/reference/api/windows#event-onFocusChanged
    // Permit only the single exact sentinel observed in hosted Settings acceptance.
    // The guards above prove endpoint focus, not uninterrupted transient native focus.
    // Keep the notification in raw evidence and reject every positive/extra focus event.
    const focusEvents = events.filter(event => event.type === 'windows.onFocusChanged');
    const allowedFocusEvent = platform === 'linux' && focusEvents.length === 1 && isDeepStrictEqual(focusEvents[0].data, [-1]) ? focusEvents[0] : null;
    const forbidden = events.filter(event => event !== allowedFocusEvent && /^tabs\.(onRemoved|onReplaced|onAttached|onDetached|onMoved)$|^windows\.|^bookmarks\.|^sidePanel\./.test(event.type));
    assert.equal(forbidden.length, 0, `Settings emitted forbidden native events: ${JSON.stringify(forbidden)}`);
    return settings;
}

/**
 * Adapters are the existing hosted harness functions, not replacement APIs.
 * external(page, peerId, command, payload, requestId) returns the real envelope.
 * newTabPage/openSavedPage attest Chrome's exact created ID before attaching.
 * No adapter may fabricate action responses or mutate a renderer's controller.
 */
export async function exerciseSpotlightActions({ apiPage, spotlightOptions, newTabPage, openSavedPage, pageForUrl, ui, screenshot, snapshot, bridge, external, poll, fixture, arcifyId, spotlightId, search, helperNavigation = false, record = async () => {} }) {
    assertSpotlightActionEnvironment();
    assert.equal(typeof helperNavigation, 'boolean');
    for (const adapter of [newTabPage, openSavedPage, pageForUrl, ui, screenshot, snapshot, bridge, external, poll, search]) assert.equal(typeof adapter, 'function', 'All hosted action adapters are mandatory.');
    const nonce = randomBytes(16).toString('hex'), url = `${fixture.base}/spotlight-actions/${nonce}/source`, windowId = fixture.windowA;
    const initial = await snapshot(windowId), initialB = await snapshot(fixture.windowB), source = exact(initial.spaces, fixture.spaces.work);
    const counterpart = initial.spaces.find(space => space.id !== source.id && space.id !== fixture.spaces.empty); assert(counterpart?.bookmarkFolderId);
    const originalSetting = await apiPage.evaluate(() => chrome.storage.sync.get('syncTabGroups'));
    const owned = [], roots = [], pages = new Map(), evidence = { nonce, checkpoints: [], surfaces: ['isolated-overlay-frame', 'owned-newtab', 'browser-newtab-alias'], groupSync: false };
    let sourcePage, helper, primaryError, revoked = false, pinnedId;
    const checkpoint = async (phase, data = {}) => { evidence.checkpoints.push({ phase, ...data }); await record(structuredClone(evidence)); };
    const option = value => ui(apiPage, 'Set native group projection for isolated Space-action acceptance', async () => {
        if (await apiPage.$eval('#syncTabGroups', node => node.checked) !== value) await apiPage.click('label.toggle-label[for="syncTabGroups"]');
        await poll(() => apiPage.evaluate(() => chrome.storage.sync.get('syncTabGroups')), state => Boolean(state.syncTabGroups) === value, 'group-sync fixture setting saved');
    });
    const activate = async id => apiPage.evaluate(async id => { const tab = await chrome.tabs.update(id, { active: true }); await chrome.windows.update(tab.windowId, { focused: true }); }, id);
    const settleStore = () => apiPage.evaluate(async () => { const reply = await chrome.runtime.sendMessage({ type: 'spaceStore', action: 'get' }); if (reply?.success !== true) throw new Error(reply?.error || 'Cannot settle the authoritative Space queue.'); });
    const read = async () => {
        await settleStore();
        const currentSnapshots = { [windowId]: await snapshot(windowId), [fixture.windowB]: await snapshot(fixture.windowB) };
        const state = await apiPage.evaluate(async () => {
            const local = await chrome.storage.local.get(['spaces', 'pinnedTabStatesById', 'tabNameOverridesById', 'persistentFavorites', 'spaceTabSnapshot', 'arcifyBridgePairingGeneration']);
            const session = await chrome.storage.session.get(['activeSpaces', 'spaceGroupProjection', 'favoriteSession', 'spotlightBridgeRequests']);
            return { tabs: (await chrome.tabs.query({})).map(({ id, windowId, index, url, pendingUrl, title, pinned, incognito, active, groupId, splitViewId }) => ({ id, windowId, index, url, pendingUrl: pendingUrl || null, title, pinned, incognito, active, groupId, splitViewId: splitViewId ?? -1 })).sort((a, b) => a.id - b.id),
                windows: (await chrome.windows.getAll()).map(({ id, type, incognito, focused, state }) => ({ id, type, incognito, focused, state })).sort((a, b) => a.id - b.id),
                spaces: (local.spaces || []).map(({ id, name, color, icon, bookmarkFolderId, spaceBookmarks, temporaryTabs }) => ({ id, name, color, icon, bookmarkFolderId, spaceBookmarks, temporaryTabs })), bookmarks: await chrome.bookmarks.getTree(),
                bindings: local.pinnedTabStatesById || {}, aliases: local.tabNameOverridesById || {}, favorites: local.persistentFavorites || [], savedSnapshot: local.spaceTabSnapshot || [],
                pairingGeneration: local.arcifyBridgePairingGeneration ?? null, activeSpaces: session.activeSpaces || {}, projection: session.spaceGroupProjection || {}, favoriteSession: session.favoriteSession || null,
                journal: session.spotlightBridgeRequests || [], groups: (await chrome.tabGroups.query({})).sort((a, b) => a.id - b.id) };
        });
        state.bookmarks = canonicalSavedMoveBookmarks(state.bookmarks);
        state.snapshots = currentSnapshots;
        state.pageStates = Object.fromEntries(await Promise.all([...pages].map(async ([id, page]) => [id, await page.evaluate(readSpotlightActionPage)])));
        return state;
    };
    const reset = async surface => {
        await apiPage.evaluate(() => { globalThis.__spaceActionObservation.events.length = 0; });
        await spotlightOptions.evaluate(() => { globalThis.__spaceActionObservation.events.length = 0; });
        if (surface) await surface.evaluate(() => { globalThis.__spaceActionInput.events.length = 0; });
    };
    const observed = async (surface, inputOwner = surface) => ({ events: await apiPage.evaluate(() => globalThis.__spaceActionObservation.events),
        peerEvents: await spotlightOptions.evaluate(() => globalThis.__spaceActionObservation.events),
        input: inputOwner ? await inputOwner.evaluate(() => globalThis.__spaceActionInputEvents) : [] });
    const capture = async (page, label) => { const result = await screenshot(page, `spotlight-actions-${label}`, true, { fullPage: false }); assert(result?.filename && result?.capturedAt, 'Action screenshots are mandatory evidence.'); return result; };
    const context = async (tabId, section, bookmarkId) => {
        const before = await read();
        const reply = await external(spotlightOptions, arcifyId, 'actionContext', { windowId, tabId, supportedFeatures: SPACE_ACTION_FEATURES });
        assert.equal(reply?.ok, true, JSON.stringify(reply)); assert.equal(reply.extensionId, arcifyId);
        assertSpotlightActionContext(reply.actionContext, before, { windowId, sourceTabId: tabId, section, bookmarkId }); return reply.actionContext;
    };
    const ready = async (page, command) => {
        await search(page, SPACE_ACTION_QUERIES[command]); const surface = await spotlightSurface(page);
        const rows = await poll(() => surface.evaluate(readSpotlightRows), rows => rows[0]?.type === 'arcify-space-action' && rows[0]?.title === SPACE_ACTION_TITLES[command] && rows[0].selected, `visible fuzzy ${command} wins while retaining web search`);
        assertMatchedActionFirst(rows, { type: 'arcify-space-action', title: SPACE_ACTION_TITLES[command], query: SPACE_ACTION_QUERIES[command] });
        // Inspect the actual painted row, not just an in-memory action result.
        assert.equal(await surface.$eval('[data-testid="spotlight-result"]', node => node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0 && getComputedStyle(node).visibility !== 'hidden'), true);
        const retainInParent = command === 'openSettings' && surface !== page;
        await surface.evaluate(installSpotlightActionInputObservation, { retainInParent });
        return { surface, rows, inputOwner: retainInParent ? page : surface };
    };
    const clickAction = async (surface, command) => clickFreshResult(async timeout => {
        await surface.waitForSelector('[data-result-type="arcify-space-action"]', { visible: true, timeout });
        const handle = await surface.evaluateHandle(title => {
            const nodes = [...document.querySelectorAll('[data-result-type="arcify-space-action"]')].filter(node => node.querySelector('.arcify-spotlight-result-title')?.textContent === title);
            if (nodes.length !== 1) throw new Error('Expected one exact visible action row.'); return nodes[0];
        }, SPACE_ACTION_TITLES[command]); assert(handle.asElement()); return handle.asElement();
    }, observation => checkpoint('fresh-action-click', { command, observation }));
    const pressAction = async surface => { const input = await surface.$('[data-testid="spotlight-input"]'); assert(input); try { await input.press('Enter'); } finally { await input.dispose(); } };
    const status = (surface, expected) => surface.waitForFunction(expected => [...document.querySelectorAll('.arcify-bridge-status')].some(node => node.textContent.includes(expected)), { polling: 50 }, expected);
    const closeOverlay = async () => {
        if (!sourcePage || !await sourcePage.evaluate(() => Boolean(document.getElementById('arcify-spotlight-host')))) return;
        const surface = await spotlightSurface(sourcePage); await ui(sourcePage, 'Dismiss the completed Spotlight overlay', async () => { const input = await surface.$('[data-testid="spotlight-input"]'); assert(input); try { await input.press('Escape'); } finally { await input.dispose(); } });
        await sourcePage.waitForFunction(() => !document.getElementById('arcify-spotlight-host'), { polling: 50 });
    };
    const openOverlay = async tabId => {
        await closeOverlay(); await activate(tabId);
        const reply = await external(apiPage, spotlightId, 'launch', { windowId, mode: 'new-tab' }); assert.equal(reply?.ok, true, JSON.stringify(reply));
        await sourcePage.waitForFunction(() => document.getElementById('arcify-spotlight-host')?.shadowRoot?.querySelector('dialog')?.open);
        const surface = await spotlightSurface(sourcePage); assert.notEqual(surface, sourcePage, 'The ordinary page must use a real isolated iframe, never a stand-in newtab document.');
        const rendered = await surface.evaluate(() => ({ embedded: window.top !== window, url: document.URL, timeOrigin: performance.timeOrigin, ready: Boolean(document.querySelector('[data-testid="spotlight-input"]')) }));
        assert.equal(rendered.embedded, true); assert.equal(rendered.ready, true); await checkpoint('genuine-overlay-frame', rendered); return surface;
    };
    const cancelPrompt = async (page, command, sourceContext, method) => {
        const { surface, rows } = await ready(page, command);
        await ui(page, `Cancel ${command} through genuine ${method} input`, async () => {
            const before = await read(); await reset(surface); await clickAction(surface, command);
            await surface.waitForSelector('.arcify-space-action-prompt', { visible: true }); const prompt = await surface.evaluate(readSpotlightActionPrompt);
            assertSpotlightActionPrompt(prompt, command, sourceContext.tab?.bookmark?.title);
            if (command === 'createSpaceFolder') await surface.type('.arcify-space-action-prompt input', `Cancelled ${nonce}`);
            const screenshot = await capture(page, `${command}-cancel-${method}`);
            if (method === 'Escape') await page.keyboard.press('Escape'); else await surface.click('[data-action-cancel]');
            await surface.waitForSelector('.arcify-space-action-prompt', { hidden: true });
            const after = await read(), trace = await observed(surface); assertSpotlightActionUnchanged(before, after); assertSpotlightActionNoWrites(trace.events); assertSpotlightActionInput(trace.input, command, { cancelled: true });
            assert.equal(await surface.$eval('[data-testid="spotlight-input"]', node => node.value), SPACE_ACTION_QUERIES[command]);
            await checkpoint('prompt-cancelled-with-zero-writes', { command, method, before, after, rows, prompt, trace, screenshot });
        });
    };
    const commit = async (page, command, sourceContext, { title, keyboard = false } = {}) => {
        const { surface, rows, inputOwner } = await ready(page, command); let outcome;
        await ui(page, `Perform ${command} using the visible Spotlight UI`, async () => {
            const before = await read(); await reset(surface);
            if (keyboard) await pressAction(surface); else await clickAction(surface, command);
            let prompt;
            if (['createSpaceFolder', 'removeCurrentPin'].includes(command)) {
                await surface.waitForSelector('.arcify-space-action-prompt', { visible: true }); prompt = await surface.evaluate(readSpotlightActionPrompt);
                assertSpotlightActionPrompt(prompt, command, sourceContext.tab?.bookmark?.title);
                if (title) await surface.type('.arcify-space-action-prompt input', title);
                await capture(page, `${command}-explicit-prompt`);
                if (title && keyboard) await page.keyboard.press('Enter'); else await surface.click(`[data-action-confirm="${command}"]`);
            }
            await waitForSpotlightActionCompletion({ page, surface, command, waitStatus: status,
                waitSettings: () => poll(() => apiPage.evaluate(() => chrome.tabs.query({})), tabs => tabs.some(tab => !before.tabs.some(previous => previous.id === tab.id) && tab.url === `chrome-extension://${arcifyId}/options.html` && tab.status === 'complete' && !tab.pendingUrl), 'new settings page fully loaded without another navigation') });
            const after = await poll(read, state => {
                const requests = state.journal.filter(entry => { try { const request = JSON.parse(entry.fingerprint); return request.command === command && JSON.stringify(request.context) === JSON.stringify(sourceContext) && entry.response?.ok; } catch { return false; } });
                return requests.length === 1;
            }, `one confirmed durable ${command} receipt`);
            const trace = await observed(surface, inputOwner);
            // Persist raw observations before any oracle can throw. This checkpoint
            // records an unvalidated attempt, never a successful action.
            await checkpoint('action-observed-before-validation', { command, sourceContext, before, after, rows, prompt, trace });
            const request = assertSpotlightActionRequest(trace.events, command, sourceContext, spotlightId, title ? { title } : command === 'removeCurrentPin' ? { confirmed: true } : {});
            assertSpotlightActionInput(trace.input, command, { confirmed: Boolean(prompt), ...(title ? { folderTitle: title } : {}) });
            const receipt = after.journal.find(entry => entry.fingerprint === JSON.stringify(request));
            const resultId = receipt.response[command === 'createSpaceFolder' ? 'folderId' : command === 'openSettings' ? 'tabId' : 'bookmarkId'];
            if (command === 'openSettings') { const created = assertSpotlightSettingsOpened(before, after, { context: sourceContext, arcifyId, events: trace.events }); assert.equal(created.id, resultId); owned.push(resultId); }
            else assertSpotlightActionCommitted(before, after, { command, context: sourceContext, resultId, title, events: trace.events, request });
            if (['createSpaceFolder', 'pinCurrentTab'].includes(command)) roots.push(resultId);
            await checkpoint('action-committed-once', { command, before, after, rows, prompt, trace, request, resultId }); outcome = { resultId, before, after, trace, request };
        });
        return outcome;
    };
    try {
        await option(false);
        await apiPage.evaluate(installSpotlightActionApiObservation); await spotlightOptions.evaluate(installSpotlightActionApiObservation);
        await bridge('activateSpace', { windowId, spaceId: source.id });
        const sourceTab = await apiPage.evaluate(options => chrome.tabs.create(options), { windowId, url, active: true }); owned.push(sourceTab.id);
        sourcePage = await pageForUrl(url); await sourcePage.waitForSelector('#action-page-state'); pages.set(sourceTab.id, sourcePage);
        await ui(sourcePage, 'Keep independent page input through Spotlight actions', () => sourcePage.type('#action-page-state', `-${sourceTab.id}`));
        // Same address, separate exact bookmark and live identity, plus counterpart Space metadata.
        const decoy = await apiPage.evaluate(options => chrome.bookmarks.create(options), { parentId: source.bookmarkFolderId, title: `Same URL separate pin ${nonce}`, url }); roots.push(decoy.id);
        const counterpartPin = await apiPage.evaluate(options => chrome.bookmarks.create(options), { parentId: counterpart.bookmarkFolderId, title: `Counterpart untouched ${nonce}`, url }); roots.push(counterpartPin.id);
        const decoyLive = await openSavedPage({ windowId: fixture.windowB, spaceId: source.id, bookmarkId: decoy.id, url }); owned.push(decoyLive.tab.id); pages.set(decoyLive.tab.id, decoyLive.page);
        await decoyLive.page.waitForSelector('#action-page-state');
        await bridge('activateSpace', { windowId: fixture.windowB, spaceId: counterpart.id });
        await openOverlay(sourceTab.id);
        await poll(read, state => exact(state.spaces, source.id).temporaryTabs.includes(sourceTab.id) && state.savedSnapshot.some(item => item.tabId === sourceTab.id), 'exact Today source and persisted identity ready');
        const todayContext = await context(sourceTab.id, 'today');
        const pin = await commit(sourcePage, 'pinCurrentTab', todayContext, { keyboard: true }); pinnedId = pin.resultId;
        assert.notEqual(pinnedId, decoy.id); await capture(sourcePage, 'pinned-current-overlay-keeps-page');
        await closeOverlay();
        const linked = await openSavedPage({ windowId: fixture.windowB, spaceId: source.id, bookmarkId: pinnedId, url }); owned.push(linked.tab.id); pages.set(linked.tab.id, linked.page);
        await linked.page.waitForSelector('#action-page-state'); await ui(linked.page, 'Keep distinct linked-copy input', () => linked.page.type('#action-page-state', `-${linked.tab.id}`));
        await bridge('activateSpace', { windowId: fixture.windowB, spaceId: counterpart.id });
        await openOverlay(sourceTab.id); const savedContext = await context(sourceTab.id, 'saved', pinnedId);
        await cancelPrompt(sourcePage, 'removeCurrentPin', savedContext, 'Escape');
        await cancelPrompt(sourcePage, 'removeCurrentPin', savedContext, 'Cancel');
        const remove = await commit(sourcePage, 'removeCurrentPin', savedContext);
        assert.deepEqual([sourceTab.id, linked.tab.id].sort((a, b) => a - b), remove.before.tabs.filter(tab => remove.before.bindings[tab.id]?.bookmarkId === pinnedId).map(tab => tab.id));
        assert.equal(remove.after.bindings[decoyLive.tab.id]?.bookmarkId, decoy.id);
        await capture(sourcePage, 'removed-exact-pin-keeps-linked-pages');
        const removedContext = await context(sourceTab.id, 'today');
        await cancelPrompt(sourcePage, 'createSpaceFolder', removedContext, 'Escape');
        await commit(sourcePage, 'createSpaceFolder', removedContext, { title: `Overlay folder ${nonce}`, keyboard: true });
        await commit(sourcePage, 'openSettings', removedContext, { keyboard: true });
        await activate(sourceTab.id); await closeOverlay();
        // Both owned and browser-alias helpers retain the exact reviewed peer action set.
        for (const requestedUrl of [`chrome-extension://${spotlightId}/newtab.html`, 'chrome://newtab/']) {
            await reset(); helper = await newTabPage(requestedUrl, windowId); owned.push(helper.tab.id);
            await helper.page.waitForSelector('[data-testid="spotlight-input"]', { visible: true });
            await poll(() => apiPage.evaluate(id => chrome.tabs.get(id), helper.tab.id), tab => tab.status === 'complete' && !tab.pendingUrl, 'settled exact helper source');
            const helperContext = await context(helper.tab.id, null);
            await search(helper.page, '');
            const rows = await poll(() => helper.page.evaluate(readSpotlightRows), rows => rows.some(row => row.title === SPACE_ACTION_TITLES.createSpaceFolder), 'helper exposes selected-Space actions');
            assertSpotlightHelperActionRows(rows, { helperNavigation });
            for (const query of ['pin curent tab', 'remvoe pin']) {
                await search(helper.page, query); const filtered = await helper.page.evaluate(readSpotlightRows);
                assert(!filtered.some(row => row.type === 'arcify-space-action' && [SPACE_ACTION_TITLES.pinCurrentTab, SPACE_ACTION_TITLES.removeCurrentPin].includes(row.title)));
                assert(filtered.some(row => row.type === 'search-query'), 'Unavailable helper actions retain normal web search.');
            }
            // Manual web-search selection remains usable without executing a search/navigation.
            const prepared = await ready(helper.page, 'createSpaceFolder');
            const input = await prepared.surface.$('[data-testid="spotlight-input"]');
            await ui(helper.page, 'Choose retained web search with the real keyboard', () => selectResultWithKeyboard(input, () => prepared.surface.evaluate(readSpotlightRows), row => row.type === 'search-query')); await input.dispose();
            assert.equal((await prepared.surface.evaluate(readSpotlightRows)).find(row => row.selected)?.type, 'search-query');
            const helperBefore = await helper.page.evaluate(readNewTabReuseState);
            await cancelPrompt(helper.page, 'createSpaceFolder', helperContext, 'Cancel');
            const created = await commit(helper.page, 'createSpaceFolder', helperContext, { title: `${requestedUrl.startsWith('chrome://') ? 'Alias' : 'Helper'} folder ${nonce}` });
            const helperAfter = await helper.page.evaluate(readNewTabReuseState);
            assert.equal(helperAfter.tab.id, helperBefore.tab.id); assert.equal(helperAfter.tab.windowId, helperBefore.tab.windowId); assert.equal(helperAfter.tab.url, helperBefore.tab.url); assert.equal(helperAfter.url, helperBefore.url); assert.equal(helperAfter.timeOrigin, helperBefore.timeOrigin);
            if (requestedUrl === 'chrome://newtab/') {
                const options = { spotlightId, arcifyId, tabId: helper.tab.id, windowId, request: created.request };
                const trace = await poll(() => observed(), value => { try { assertSpotlightHelperProof(helperAfter, value.peerEvents, options); return true; } catch { return false; } }, 'committed alias action has browser-attested source metadata or a verified nonce acknowledgement');
                await checkpoint('browser-alias-attested-renderer', { proof: assertSpotlightHelperProof(helperAfter, trace.peerEvents, options), helperBefore, helperAfter, trace, rows });
            }
            await capture(helper.page, requestedUrl === 'chrome://newtab/' ? 'alias-folder-created' : 'owned-helper-folder-created');
            await commit(helper.page, 'openSettings', helperContext);
        }
        // Real malformed transport and unauthorized source probes use the existing
        // non-user-gesture CDP mechanism. They never inject a successful reply.
        await activate(helper.tab.id); const helperContext = await context(helper.tab.id, null);
        const malformedPayloads = [
            ['createSpaceFolder', { context: helperContext, title: 'Reject malformed', unexpected: true }],
            ['pinCurrentTab', { context: helperContext }],
            ['removeCurrentPin', { context: savedContext, confirmed: false }]
        ];
        for (const [command, payload] of malformedPayloads) {
            const before = await read(); await reset();
            const reply = await external(spotlightOptions, arcifyId, command, { windowId, supportedFeatures: SPACE_ACTION_FEATURES, ...payload });
            assert.equal(reply?.ok, false); assert.equal(reply.error?.code, 'INVALID_REQUEST'); assert.equal(reply.snapshot, undefined);
            const after = await read(), trace = await observed(); assertSpotlightActionUnchanged(before, after); assertSpotlightActionNoWrites(trace.events, { allowRejectedRequests: true });
            await checkpoint('malformed-action-fails-closed', { command, payload, reply, before, after, trace });
        }
        for (const tabId of [sourceTab.id, decoyLive.tab.id]) {
            const before = await read(); await reset();
            const reply = await external(spotlightOptions, arcifyId, 'actionContext', { windowId, tabId, supportedFeatures: SPACE_ACTION_FEATURES });
            assert.equal(reply?.ok, false); assert.equal(reply.error?.code, 'STALE_CONTEXT'); assert.equal(reply.actionContext, undefined);
            const after = await read(), trace = await observed(); assertSpotlightActionUnchanged(before, after); assertSpotlightActionNoWrites(trace.events);
            await checkpoint('inactive-or-wrong-window-source-rejected', { tabId, reply, before, after, trace });
        }
        const beforeUnauthorized = await read(); await reset(); const cdp = await spotlightOptions.target().createCDPSession(); let unauthorized;
        try { unauthorized = await evaluateWithoutGesture(cdp, `chrome.runtime.sendMessage(${JSON.stringify({ action: 'arcifySpaceActionsContext', tabId: helper.tab.id })})`); }
        finally { await cdp.detach(); }
        assert.equal(unauthorized?.success, false); assert.equal(unauthorized.errorCode, 'UNAUTHORIZED');
        const afterUnauthorized = await read(), unauthorizedTrace = await observed(); assertSpotlightActionUnchanged(beforeUnauthorized, afterUnauthorized); assertSpotlightActionNoWrites(unauthorizedTrace.events);
        await checkpoint('options-source-cannot-impersonate-helper', { unauthorized, before: beforeUnauthorized, after: afterUnauthorized, trace: unauthorizedTrace });
        // A prepared prompt survives receiver-side revocation, but cannot commit.
        const prepared = await ready(helper.page, 'createSpaceFolder');
        await ui(helper.page, 'Prepare a named action before receiver-side revocation', async () => { await clickAction(prepared.surface, 'createSpaceFolder'); await prepared.surface.type('.arcify-space-action-prompt input', `Revoked ${nonce}`); });
        await ui(apiPage, 'Revoke the real paired grant in Arcify settings', () => apiPage.click('#bridgeDisconnect')); revoked = true;
        await apiPage.waitForSelector('#bridgeStatus[data-state="disabled"]');
        await ui(helper.page, 'Reject the previously prepared folder after pairing revocation', async () => {
            // The ordinary snapshot adapter is unauthorized now. Compare raw
            // authoritative state after revocation through the existing local API page.
            const raw = () => apiPage.evaluate(async () => ({ tabs: await chrome.tabs.query({}), bookmarks: await chrome.bookmarks.getTree(), local: await chrome.storage.local.get(null), session: await chrome.storage.session.get(null), windows: await chrome.windows.getAll() }));
            await settleStore();
            const before = await raw(); await reset(prepared.surface);
            await prepared.surface.click('[data-action-confirm="createSpaceFolder"]');
            await prepared.surface.waitForSelector('.arcify-bridge-status[data-state="error"]', { visible: true });
            await settleStore();
            const after = await raw(), trace = await observed(prepared.surface); assert.deepEqual(after, before, 'Revoked prepared action cannot mutate any authoritative native or stored state.'); assertSpotlightActionNoWrites(trace.events);
            assert.equal(helper.page.isClosed(), false); assert.equal(await prepared.surface.$('.arcify-space-action-prompt'), null);
            const error = await prepared.surface.$eval('.arcify-bridge-status[data-state="error"]', node => node.textContent); assert(error.length);
            await checkpoint('revoked-prepared-action-fails-closed', { before, after, trace, error, screenshot: await capture(helper.page, 'revoked-action-error') });
        });
        return evidence;
    } catch (error) {
        primaryError = error; await checkpoint('initial-space-actions-failed', { error: { message: error.message, stack: error.stack }, owned, roots }).catch(() => {});
        if (helper?.page && !helper.page.isClosed()) await screenshot(helper.page, 'spotlight-actions-failure', false).catch(() => {});
        throw error;
    } finally {
        await finishBookmarkFixture([
            async () => { if (revoked) {
                await ui(apiPage, 'Restore the fixture pairing through Arcify settings', async () => {
                    const field = await apiPage.$('#bridgePeerId'); try { await replaceInputText(apiPage, field, spotlightId); } finally { await field.dispose(); }
                    await apiPage.click('#bridgeSave');
                });
                await apiPage.waitForSelector('#bridgeStatus[data-state="connected"]'); revoked = false;
            } },
            () => closeOverlay(),
            async () => { for (const state of [initial, initialB]) { const active = state.tabs.find(tab => tab.active); if (active) await apiPage.evaluate(id => chrome.tabs.update(id, { active: true }), active.id); await bridge('activateSpace', { windowId: state.windowId, spaceId: state.activeSpaceId }); } },
            () => apiPage.evaluate(async ids => { const live = new Set((await chrome.tabs.query({})).map(tab => tab.id)); const present = [...new Set(ids)].filter(id => live.has(id)); if (present.length) await chrome.tabs.remove(present); }, owned),
            () => apiPage.evaluate(async ids => { for (const id of [...new Set(ids)]) { let node; try { [node] = await chrome.bookmarks.get(id); } catch { continue; } if (node.url) await chrome.bookmarks.remove(id); else await chrome.bookmarks.removeTree(id); } }, roots),
            () => option(Boolean(originalSetting.syncTabGroups)),
            () => apiPage.evaluate(() => globalThis.__spaceActionObservation?.stop()),
            () => spotlightOptions.evaluate(() => globalThis.__spaceActionObservation?.stop())
        ], primaryError, record);
    }
}
