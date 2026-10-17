/** Import-safe mandatory hosted evidence. The existing paired harness owns Chrome. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { requireActionPromptGeometry, waitForActionSurfaceCompletion } from './paired-chrome-action-surface.mjs';
import { collectSpotlightHelperOrigin } from './paired-chrome-helper-origin.mjs';
import { spotlightSurface } from './paired-chrome-keyboard.mjs';
import { clickFreshResult, replaceInputText } from './paired-chrome-ui.mjs';
import { readSpotlightRows, assertMatchedActionFirst } from './paired-chrome-sidebar.mjs';
import { canonicalSavedMoveBookmarks } from './paired-chrome-saved-move.mjs';
import { finishBookmarkFixture } from './paired-chrome-bookmark-selection.mjs';
import { watchTabMenuInvalidation } from './paired-chrome-tab-menu.mjs';
import { readNewTabReuseState } from './paired-chrome-newtab.mjs';
import { projectTabTitle } from '../tab-title-projection.js';
import { isStartupLauncherTab } from '../startup-launcher-tab.js';

export const SPOTLIGHT_TAB_CASE_NAME = 'Spotlight tab commands preserve exact live and saved identities through trusted input';
export const TAB_COMMAND_FEATURES = Object.freeze(['globalFavoritesV1', 'tabActionsV1']);
export const TAB_COMMAND_TITLES = Object.freeze({ renameCurrentTab: 'Rename current tab', editCurrentPinUrl: 'Edit saved pin URL', duplicateCurrentTab: 'Duplicate current tab', copyCurrentLink: 'Copy current link', setCurrentTabMuted: 'Mute current tab' });
export const TAB_COMMAND_QUERIES = Object.freeze({ renameCurrentTab: 'rename curent tab', editCurrentPinUrl: 'edit saved pin url', duplicateCurrentTab: 'duplicate curent tab', copyCurrentLink: 'copy curent link', setCurrentTabMuted: 'mute curent tab' });
const commands = Object.keys(TAB_COMMAND_TITLES);
const mutations = [...commands, 'pinCurrentTab', 'removeCurrentPin', 'createSpaceFolder', 'openSettings', 'switchSpace', 'moveCurrentTodayTab', 'activateSpace', 'activateTab', 'navigateTab', 'openTab', 'openBookmark', 'openFavorite'];
const flat = nodes => nodes.flatMap(node => [node, ...flat(node.children || [])]);
const exact = (values, id) => { const found = values.filter(value => value.id === id); assert.equal(found.length, 1, `Require exact unique identity ${id}.`); return found[0]; };
const same = (before, after, keys) => { for (const key of keys) assert.deepEqual(after[key], before[key], `${key} changed outside this exact tab action.`); };
const byTab = values => [...values].sort((a, b) => a.tabId - b.tabId);
const canonical = state => ({ ...state, snapshots: Object.fromEntries(Object.entries(state.snapshots).map(([key, { capturedAt, ...value }]) => [key, value])) });
const changedStorage = events => events.filter(event => event.type === 'storage' && Object.values(event.data.changes).some(change => JSON.stringify(change.oldValue) !== JSON.stringify(change.newValue)));
export const tabCommandTitle = (command, context) => command === 'renameCurrentTab' && context.tab?.section === 'saved' ? 'Rename saved Space pin' : command === 'setCurrentTabMuted' && context.tab?.muted ? 'Unmute current tab' : TAB_COMMAND_TITLES[command];

export function assertTabCommandEnvironment(env = process.env, uid = process.getuid?.()) {
    assert.equal(env.GITHUB_ACTIONS, 'true', 'Tab-command acceptance belongs to the dedicated hosted job.');
    assert.equal(env.CI, 'true'); assert.notEqual(uid, 0, 'Never disable Chrome sandboxing for root.');
}
export function serveSpotlightTabFixture(request, response) {
    const match = /^\/spotlight-tabs\/([a-f0-9]{32})\/([a-z-]+)$/.exec(new URL(request.url, 'http://127.0.0.1').pathname);
    if (!match) return false;
    const title = `Spotlight Tab ${match[2]} ${match[1]}`;
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-src 'none'" });
    response.end(`<!doctype html><html><head><title>${title}</title><link rel="icon" href="data:,"></head><body data-document-id="${randomBytes(16).toString('hex')}"><h1>${title}</h1><input id="action-page-state" value="retained"></body></html>`);
    return true;
}
export function installTabCommandInputObservation({ retainInParent = false } = {}) {
    globalThis.__tabCommandInput?.stop(); const events = [], registrations = [];
    for (const type of ['input', 'click', 'keydown', 'paste']) {
        const listener = event => {
            const row = event.target.closest?.('[data-testid="spotlight-result"]') || document.querySelector('[data-testid="spotlight-result"].selected');
            events.push({ type, trusted: event.isTrusted, key: event.key || null, keyCode: event.keyCode ?? null, button: event.button ?? null,
                repeat: Boolean(event.repeat), composing: Boolean(event.isComposing), ctrl: Boolean(event.ctrlKey), alt: Boolean(event.altKey), meta: Boolean(event.metaKey),
                title: row?.querySelector('.arcify-spotlight-result-title')?.textContent || null, resultType: row?.dataset.resultType || null,
                inPrompt: Boolean(event.target.closest?.('.arcify-tab-action-prompt')), input: event.target.hasAttribute?.('data-tab-action-input') || false,
                confirm: event.target.dataset?.actionConfirm || null, cancel: event.target.hasAttribute?.('data-action-cancel') || false,
                value: event.target.value ?? null, pastedText: type === 'paste' ? event.clipboardData?.getData('text/plain') : null });
        };
        document.addEventListener(type, listener, true); registrations.push(() => document.removeEventListener(type, listener, true));
    }
    globalThis.__tabCommandInput = { events, stop: () => registrations.forEach(remove => remove()) };
    // Duplicate activates its new tab; only passive records survive in the source.
    globalThis.__tabCommandInputEvents = events;
    if (retainInParent) parent.__tabCommandInputEvents = events;
}
export function readTabCommandPrompt() {
    const prompt = document.querySelector('.arcify-tab-action-prompt'); if (!prompt) return null;
    const input = prompt.querySelector('[data-tab-action-input]'), confirm = prompt.querySelector('[data-action-confirm]'), rect = prompt.getBoundingClientRect();
    return { role: prompt.getAttribute('role'), modal: prompt.getAttribute('aria-modal'), title: document.getElementById(prompt.getAttribute('aria-labelledby'))?.textContent,
        description: document.getElementById(prompt.getAttribute('aria-describedby'))?.textContent,
        visible: rect.width > 0 && rect.height > 0 && getComputedStyle(prompt).visibility !== 'hidden', command: confirm?.dataset.actionConfirm, confirm: confirm?.textContent,
        cancel: prompt.querySelector('[data-action-cancel]')?.textContent, input: input ? { value: input.value, maxLength: input.maxLength, focused: document.activeElement === input } : null };
}
export function assertTabCommandPrompt(prompt, command, context) {
    assert.equal(prompt?.role, 'dialog'); assert.equal(prompt.modal, 'true'); assert.equal(prompt.visible, true); assert.equal(prompt.command, command); assert.equal(prompt.cancel, 'Cancel');
    const url = command === 'editCurrentPinUrl', saved = context.tab.section === 'saved';
    assert.equal(prompt.title, url ? 'Edit saved pin URL' : saved ? 'Rename saved Space pin' : 'Rename Today tab');
    assert.equal(prompt.confirm, url ? 'Save URL' : 'Save name');
    assert.deepEqual(prompt.input, { value: url ? context.tab.bookmark.url : saved ? context.tab.bookmark.title : context.tab.alias || context.tab.title, maxLength: url ? 16384 : 256, focused: true });
    assert.match(prompt.description, url ? /saved title.*current page stay unchanged/ : saved ? /exact pin.*linked tab display/ : /Leave it blank.*page title/);
}
export function assertTabCommandInput(events, command, context, { outcome = 'commit', value, activation = 'click', submission = 'click' } = {}) {
    assert(events.length); assert(events.every(event => event.trusted && !event.repeat && !event.composing && event.keyCode !== 229 && !event.alt && !event.meta && (event.type !== 'click' || event.button === 0)), 'Require trusted ordinary input.');
    const enter = event => event.type === 'keydown' && event.key === 'Enter';
    const actions = events.filter(event => !event.inPrompt && event.resultType === 'arcify-tab-action' && event.title === tabCommandTitle(command, context) && (event.type === 'click' || enter(event)));
    assert.equal(actions.length, 1); assert.equal(actions[0].ctrl, false); assert.equal(actions[0].type, activation === 'Enter' ? 'keydown' : 'click');
    const prompts = ['renameCurrentTab', 'editCurrentPinUrl'].includes(command);
    const submits = events.filter(event => event.inPrompt && (event.type === 'click' && event.confirm === command || enter(event) && !event.cancel && (event.input || event.confirm === command)));
    assert.equal(submits.length, prompts && outcome !== 'cancel' ? 1 : 0, 'Exactly one confirmation, no retry.');
    if (submits.length) { assert.equal(submits[0].ctrl, false); assert.equal(submits[0].type, submission === 'Enter' ? 'keydown' : 'click'); }
    if (outcome === 'cancel') assert.equal(events.filter(event => event.inPrompt && (event.type === 'click' && event.cancel || event.type === 'keydown' && event.key === 'Escape')).length, 1);
    if (value !== undefined) assert(events.some(event => event.type === 'input' && event.inPrompt && event.input && event.value === value), 'Edited value needs genuine native input.');
    assert(!events.some(event => event.ctrl && (event.type !== 'keydown' || !['Control', 'a', 'A'].includes(event.key))), 'Only the existing select-all editing chord is permitted in command input evidence.');
}
export function assertTabCommandContext(context, state, { windowId, sourceTabId, section, bookmarkId = null }) {
    assert.deepEqual(Object.keys(context).sort(), ['windowId', 'spaceId', 'bookmarkFolderId', 'pairingGeneration', 'sourceTabId', 'tab'].sort());
    const space = exact(state.spaces, state.activeSpaces[windowId]), source = exact(state.tabs, sourceTabId);
    assert.equal(context.windowId, windowId); assert.equal(context.sourceTabId, sourceTabId); assert.equal(context.spaceId, space.id); assert.equal(context.bookmarkFolderId, space.bookmarkFolderId); assert.equal(context.pairingGeneration, state.pairingGeneration);
    assert.equal(source.windowId, windowId); assert.equal(source.active, true);
    if (section === null) { assert.equal(context.tab, null, 'Helper/Favorite context cannot borrow an ordinary tab.'); return; }
    const projected = exact(state.snapshots[windowId].tabs, sourceTabId), bookmark = bookmarkId ? exact(flat(state.bookmarks), bookmarkId) : null;
    assert.deepEqual(context.tab, { id: sourceTabId, url: source.url, title: projected.title, section,
        bookmark: bookmark ? { id: bookmark.id, parentId: bookmark.parentId, title: bookmark.title, url: bookmark.url } : null,
        alias: section === 'saved' ? '' : state.aliases[sourceTabId]?.name || '', muted: source.muted });
    assert.equal(source.pinned, false); assert.equal(source.incognito, false); assert.equal(source.splitViewId, -1); assert.equal(source.pendingUrl, null);
    assert.equal(state.spaces.flatMap(item => [...item.temporaryTabs, ...item.spaceBookmarks]).filter(id => id === sourceTabId).length, 1);
    assert(space[section === 'saved' ? 'spaceBookmarks' : 'temporaryTabs'].includes(sourceTabId));
    if (bookmark) assert.deepEqual(state.bindings[sourceTabId], { bookmarkId, pinnedUrl: bookmark.url }); else assert.equal(state.bindings[sourceTabId], undefined);
}
export function assertTabCommandRequest(events, command, context, spotlightId, fields = {}) {
    const requests = events.filter(event => event.type === 'external' && mutations.includes(event.data.message.command));
    assert.equal(requests.length, 1, 'One UI action dispatches one exact mutation, with no fallback.');
    const { message, sender } = requests[0].data;
    assert.equal(sender.id, spotlightId); assert.equal(message.type, 'arcify-bridge'); assert.equal(message.version, 1); assert.match(message.requestId, /^[\w.:-]{1,80}$/);
    assert.equal(message.windowId, context.windowId); assert.equal(message.command, command); assert.deepEqual(message.context, context); assert.deepEqual(message.supportedFeatures, TAB_COMMAND_FEATURES);
    assert.deepEqual(Object.keys(message).sort(), ['type', 'version', 'requestId', 'command', 'windowId', 'supportedFeatures', 'context', ...Object.keys(fields)].sort());
    for (const [key, value] of Object.entries(fields)) assert.deepEqual(message[key], value);
    assert(!events.some(event => event.type === 'external' && event.data.message.type === 'arcify-sidebar'));
    return message;
}
export function assertTabCommandNoEffects(before, after, events, { rejected = false, journal = false } = {}) {
    const clean = state => { const result = canonical(state); if (journal) delete result.journal; return result; };
    assert.deepEqual(clean(after), clean(before), 'Rejected/cancelled action preserves all native and durable identities.');
    assert(!events.some(event => /^bookmarks\.|^tabs\.(?!onUpdated)|^windows\.|^tabGroups\.|^sidePanel\./.test(event.type)
        || event.type === 'tabs.onUpdated' && ['url', 'pendingUrl', 'mutedInfo', 'pinned', 'groupId', 'discarded'].some(key => key in event.data.change)), 'No observable native side effect.');
    assert.deepEqual(changedStorage(events).filter(event => !journal || Object.keys(event.data.changes).some(key => key !== 'spotlightBridgeRequests')), []);
    if (!rejected) assert.deepEqual(events.filter(event => event.type === 'external' && mutations.includes(event.data.message.command)), []);
    assert.deepEqual(events.filter(event => event.type === 'internal' && event.data.message.type === 'copyToClipboard'), []);
}
export function assertTabCommandSnapshots(state) {
    assert.deepEqual(Object.keys(state.snapshots).sort(), state.snapshotWindowIds.map(String).sort());
    for (const [key, snapshot] of Object.entries(state.snapshots)) {
        const windowId = Number(key), local = ids => ids.filter(id => exact(state.tabs, id).windowId === windowId);
        assert.equal(snapshot.windowId, windowId); assert.equal(snapshot.activeSpaceId, state.activeSpaces[key]);
        assert.equal(new Set(snapshot.tabs.map(tab => tab.id)).size, snapshot.tabs.length);
        assert.deepEqual(snapshot.spaces.map(space => space.id), state.spaces.map(space => space.id));
        for (const space of state.spaces) {
            const projected = exact(snapshot.spaces, space.id); assert.equal(projected.bookmarkFolderId, space.bookmarkFolderId);
            assert.deepEqual(projected.temporaryTabIds, local(space.temporaryTabs)); assert.deepEqual(projected.pinnedTabIds, local(space.spaceBookmarks)); assert.deepEqual(projected.tabIds, local([...space.spaceBookmarks, ...space.temporaryTabs]));
        }
        const expected = state.tabs.filter(tab => tab.windowId === windowId && !isStartupLauncherTab(tab, { runtime: { getURL: path => `chrome-extension://${state.arcifyId}/${path}` } })).map(tab => {
            const owner = state.spaces.find(space => [...space.temporaryTabs, ...space.spaceBookmarks].includes(tab.id));
            const binding = state.bindings[tab.id], bookmark = binding && flat(state.bookmarks).find(node => node.id === binding.bookmarkId);
            return { id: tab.id, windowId, title: projectTabTitle(tab, { overrides: state.aliases, binding, bookmark, isSpacePin: Boolean(owner?.spaceBookmarks.includes(tab.id)) }), url: tab.url, active: tab.active, pinned: tab.pinned, spaceId: owner?.id ?? null };
        });
        assert.deepEqual([...snapshot.tabs].sort((a, b) => a.id - b.id), expected.sort((a, b) => a.id - b.id));
        const expectedBookmarks = state.spaces.flatMap(space => flat([exact(flat(state.bookmarks), space.bookmarkFolderId)]).filter(node => node.url).map(node => ({ id: node.id, spaceId: space.id, title: node.title, url: node.url,
            tabId: local(space.spaceBookmarks).find(id => state.bindings[id]?.bookmarkId === node.id) ?? null })));
        assert.deepEqual(snapshot.bookmarks, expectedBookmarks, 'Every exact saved leaf and live binding refreshes in both windows.');
    }
}
export function findTabCommandReceipt(journal, request) {
    const matches = journal.filter(entry => entry.fingerprint === JSON.stringify(request));
    assert(matches.length <= 1, 'An immutable request has at most one durable receipt.');
    return matches[0];
}
export function assertTabCommandCommitted(before, after, { command, context, fields = {}, events, request }) {
    assert(commands.includes(command)); assertTabCommandSnapshots(before); assertTabCommandSnapshots(after);
    same(before, after, ['windows', 'groups', 'projection', 'favorites', 'favoriteSession', 'activeSpaces', 'pageStates', 'pairingGeneration', 'representation']);
    assert(!events.some(event => /^windows\.|^tabGroups\.|^sidePanel\.|^tabs\.(onRemoved|onReplaced|onMoved|onAttached|onDetached)$/.test(event.type)));
    const expectedTabs = structuredClone(before.tabs), bookmarks = structuredClone(before.bookmarks), spaces = structuredClone(before.spaces), bindings = structuredClone(before.bindings), aliases = structuredClone(before.aliases);
    const tab = context.tab, source = exact(before.tabs, tab.id); let duplicate = null, affected = [tab.id];
    if (command === 'renameCurrentTab' || command === 'editCurrentPinUrl') {
        if (tab.section === 'saved') {
            const node = exact(flat(bookmarks), tab.bookmark.id); node[command === 'renameCurrentTab' ? 'title' : 'url'] = fields[command === 'renameCurrentTab' ? 'title' : 'url'];
            affected = Object.keys(before.bindings).map(Number).filter(id => before.bindings[id].bookmarkId === node.id && before.tabs.some(tab => tab.id === id));
            for (const id of affected) { bindings[id].pinnedUrl = node.url; delete aliases[id]; }
        } else if (fields.title && fields.title !== source.title) aliases[tab.id] = { name: fields.title, originalDomain: new URL(tab.url).hostname };
        else delete aliases[tab.id];
    } else if (command === 'setCurrentTabMuted') exact(expectedTabs, tab.id).muted = fields.muted;
    else if (command === 'duplicateCurrentTab') {
        const added = after.tabs.filter(value => !before.tabs.some(old => old.id === value.id)); assert.equal(added.length, 1); duplicate = added[0];
        assert.equal(duplicate.url, source.url); assert.equal(duplicate.windowId, context.windowId); assert.equal(duplicate.index, source.index + 1); assert.equal(duplicate.active, true); assert.equal(duplicate.pinned, false); assert.equal(duplicate.incognito, false); assert.equal(duplicate.splitViewId, -1);
        for (const value of expectedTabs) if (value.windowId === context.windowId) { value.active = false; if (value.index > source.index) value.index++; }
        expectedTabs.push(duplicate); expectedTabs.sort((a, b) => a.id - b.id);
        const space = exact(spaces, context.spaceId), index = space.temporaryTabs.indexOf(tab.id); assert(index >= 0);
        space.temporaryTabs.splice(index + (before.representation.inverted ? 0 : 1), 0, duplicate.id); space.lastTab = duplicate.id;
        assert.equal(aliases[duplicate.id], undefined); assert.equal(bindings[duplicate.id], undefined);
    }
    assert.deepEqual(after.tabs, expectedTabs, 'Native pages, focus, order, window and mute state change only as explicitly requested.');
    assert.deepEqual(after.bookmarks, bookmarks, 'Only the exact saved bookmark field changes; equal-URL decoys and sibling order survive.');
    assert.deepEqual(after.spaces, spaces); assert.deepEqual(after.bindings, bindings); assert.deepEqual(after.aliases, aliases);
    for (const key of Object.keys(before.snapshots)) for (const field of ['favorites', 'warnings']) assert.deepEqual(after.snapshots[key][field], before.snapshots[key][field], `Tab commands preserve paired ${field}.`);
    const expectedSaved = before.savedSnapshot.map(old => {
        const record = structuredClone(old), live = after.tabs.find(tab => tab.id === record.tabId);
        if (affected.includes(record.tabId) && ['renameCurrentTab', 'editCurrentPinUrl'].includes(command)) {
            if (aliases[record.tabId]) record.nameOverride = aliases[record.tabId]; else delete record.nameOverride;
            if (bindings[record.tabId]) record.pinnedState = bindings[record.tabId];
        }
        if (duplicate && live) { record.tabIndex = live.index; if (record.spaceId === context.spaceId && record.section === 'temporaryTabs') record.order = exact(spaces, context.spaceId).temporaryTabs.indexOf(record.tabId); }
        return record;
    });
    if (duplicate) {
        const sourceRecord = before.savedSnapshot.find(record => record.tabId === source.id); assert(sourceRecord);
        const added = { ...sourceRecord, tabId: duplicate.id, url: duplicate.url, tabIndex: duplicate.index, order: exact(spaces, context.spaceId).temporaryTabs.indexOf(duplicate.id) };
        delete added.nameOverride; delete added.pinnedState; expectedSaved.push(added);
    }
    assert.deepEqual(byTab(after.savedSnapshot), byTab(expectedSaved), 'Aliases and saved URLs persist on exact IDs, without borrowing a twin or navigation.');
    const bookmarkEvents = events.filter(event => event.type.startsWith('bookmarks.'));
    if (tab.bookmark && ['renameCurrentTab', 'editCurrentPinUrl'].includes(command)) { assert.equal(bookmarkEvents.length, 1); assert.equal(bookmarkEvents[0].type, 'bookmarks.onChanged'); assert.equal(bookmarkEvents[0].data[0], tab.bookmark.id); }
    else assert.deepEqual(bookmarkEvents, []);
    const creations = events.filter(event => event.type === 'tabs.onCreated'), activations = events.filter(event => event.type === 'tabs.onActivated');
    assert.equal(creations.length, duplicate ? 1 : 0); assert.equal(activations.length, duplicate ? 1 : 0, 'Only duplication may activate a native identity.');
    if (duplicate) { assert.equal(creations[0].data[0].id, duplicate.id); assert.equal(activations[0].data[0].tabId, duplicate.id); assert.equal(activations[0].data[0].windowId, context.windowId); }
    for (const event of events.filter(event => event.type === 'tabs.onUpdated' && ['url', 'pendingUrl', 'pinned', 'groupId', 'discarded'].some(key => key in event.data.change))) {
        assert(duplicate && event.data.id === duplicate.id, 'No original native page may navigate, repin or regroup even transiently.');
        assert(!['pinned', 'groupId', 'discarded'].some(key => key in event.data.change));
    }
    const muteEvents = events.filter(event => event.type === 'tabs.onUpdated' && 'mutedInfo' in event.data.change);
    if (command === 'setCurrentTabMuted') { assert.equal(muteEvents.length, 1); assert.equal(muteEvents[0].data.id, tab.id); assert.equal(muteEvents[0].data.change.mutedInfo.muted, fields.muted); }
    else assert.deepEqual(muteEvents, []);
    const entry = findTabCommandReceipt(after.journal, request); assert(entry); const receipt = [entry]; assert.equal(entry.response?.ok, true);
    assert.equal(receipt[0].response.tabId, duplicate?.id ?? tab.id);
    if (command === 'renameCurrentTab') { assert.equal(receipt[0].response.title, fields.title); assert.equal(receipt[0].response.bookmarkId, tab.bookmark?.id ?? null); }
    if (command === 'editCurrentPinUrl') { assert.equal(receipt[0].response.url, fields.url); assert.equal(receipt[0].response.bookmarkId, tab.bookmark.id); }
    if (command === 'setCurrentTabMuted') assert.equal(receipt[0].response.muted, fields.muted);
    if (command === 'copyCurrentLink') { assert.equal(receipt[0].response.copied, true); assert.equal(receipt[0].response.url, tab.url); }
    return { duplicateId: duplicate?.id ?? null, affected };
}
export function assertTabCommandClipboard({ events, contexts, pasted, pasteEvents, expected, arcifyId }) {
    const writes = events.filter(event => event.type === 'internal' && event.data.message.type === 'copyToClipboard');
    assert.equal(writes.length, 1, 'Exactly one real offscreen clipboard write, no fallback or retry.');
    assert.deepEqual(writes[0].data.message, { target: 'offscreen', type: 'copyToClipboard', text: expected }); assert.equal(writes[0].data.sender.id, arcifyId);
    assert.equal(contexts.filter(context => context.contextType === 'OFFSCREEN_DOCUMENT' && context.documentUrl === `chrome-extension://${arcifyId}/offscreen.html`).length, 1);
    assert.equal(pasted, expected, 'Native paste must expose exactly the live URL, never a forged response or saved URL.');
    const pastes = pasteEvents.filter(event => event.type === 'paste'); assert.equal(pastes.length, 1); assert.equal(pastes[0].trusted, true); assert.equal(pastes[0].pastedText, expected);
    assert(pasteEvents.some(event => event.type === 'input' && event.trusted && event.value === expected));
}
export function assertTabCommandReplay(before, after, events, reply, expected) {
    assertTabCommandNoEffects(before, after, events, { rejected: true });
    const replayed = events.filter(event => event.type === 'external' && mutations.includes(event.data.message.command));
    assert.equal(replayed.length, 1); assert.equal(replayed[0].data.message.requestId, expected.requestId);
    assert.equal(reply?.ok, expected.ok); assert.equal(reply.requestId, expected.requestId);
    if (expected.ok) { for (const key of ['tabId', 'bookmarkId', 'title', 'url', 'copied', 'muted']) if (Object.hasOwn(expected, key)) assert.deepEqual(reply[key], expected[key]); }
    else { assert.equal(reply.error?.code, 'UNCERTAIN_RESULT'); assert.equal(reply.snapshot, undefined); }
}

/**
 * Mandatory adapters are the existing paired harness, not replacement transports.
 * Shared initial-action/navigation helpers are loaded only inside the hosted entry,
 * leaving pure evidence assertions importable on the reviewed backend base.
 */
export async function exerciseSpotlightTabCommands({ browser, observePage, apiPage, spotlightOptions, newTabPage, openSavedPage, ui, screenshot,
    snapshot, bridge, external, poll, fixture, arcifyId, spotlightId, search, record = async () => {} }) {
    assertTabCommandEnvironment();
    assert.equal(typeof browser?.targets, 'function');
    for (const adapter of [observePage, newTabPage, openSavedPage, ui, screenshot, snapshot, bridge, external, poll, search, record]) assert.equal(typeof adapter, 'function', 'All tab-command evidence adapters are mandatory.');
    const { installSpotlightActionApiObservation, readSpotlightActionPage } = await import('./paired-chrome-spotlight-actions.mjs');
    const { createNavigationFixturePage, installNavigationGroupObservation } = await import('./paired-chrome-spotlight-navigation.mjs');
    const windowId = fixture.windowA, otherWindow = fixture.windowB, nonce = randomBytes(16).toString('hex'), base = `${fixture.base}/spotlight-tabs/${nonce}`;
    const initial = await apiPage.evaluate(async () => ({ tabs: await chrome.tabs.query({}), windows: await chrome.windows.getAll(),
        sync: await chrome.storage.sync.get('syncTabGroups'), activeSpaces: (await chrome.storage.session.get('activeSpaces')).activeSpaces || {} }));
    const first = await snapshot(windowId), sourceSpace = exact(first.spaces, fixture.spaces.work), otherSpace = first.spaces.find(space => space.id !== sourceSpace.id && space.id !== fixture.spaces.empty);
    assert(otherSpace?.bookmarkFolderId);
    const owned = new Set(), bookmarkIds = new Set(), roots = [], pages = new Map(), evidence = { nonce, checkpoints: [], surfaces: ['isolated-overlay-frame', 'owned-newtab', 'browser-newtab-alias'],
        unitOnly: ['deterministic lost-ack PARTIAL_COMMIT/UNCERTAIN_RESULT races and repeat-request rejection', 'closed/moved/split/Favorite source guards', 'late pairing fences'] };
    let overlayPage, searchHelper, aliasHelper, primaryError, pendingDuplicate = null, revoked = false;
    const checkpoint = async (phase, data = {}) => { evidence.checkpoints.push({ phase, ...data }); await record(structuredClone(evidence)); };
    const capture = async (page, label) => { const shot = await screenshot(page, `spotlight-tabs-${label}`, true, { fullPage: false }); assert(shot?.filename && shot?.capturedAt, 'Screenshots are mandatory evidence.'); return shot; };
    const local = async message => { const reply = await apiPage.evaluate(message => chrome.runtime.sendMessage({ type: 'spaceStore', ...message }), message); assert.equal(reply?.success, true, JSON.stringify(reply)); return reply; };
    const settle = () => apiPage.evaluate(async () => { const reply = await chrome.runtime.sendMessage({ type: 'spaceStore', action: 'get' }); if (reply?.success !== true) throw new Error(reply?.error || 'Space store queue did not settle.'); });
    const setting = async value => {
        await ui(apiPage, 'Set isolated tab-command group projection', async () => { if (await apiPage.$eval('#syncTabGroups', node => node.checked) !== value) await apiPage.click('label.toggle-label[for="syncTabGroups"]'); });
        await poll(() => apiPage.evaluate(() => chrome.storage.sync.get('syncTabGroups')), state => Boolean(state.syncTabGroups) === value, 'fixture group projection saved'); await settle();
    };
    const read = async () => {
        await settle(); const snapshots = { [windowId]: await snapshot(windowId), [otherWindow]: await snapshot(otherWindow) };
        const state = await apiPage.evaluate(async () => {
            const local = await chrome.storage.local.get(['spaces', 'pinnedTabStatesById', 'tabNameOverridesById', 'persistentFavorites', 'spaceTabSnapshot', 'arcifyBridgePairingGeneration', 'todayOrderRepresentation']);
            const session = await chrome.storage.session.get(['activeSpaces', 'spaceGroupProjection', 'favoriteSession', 'spotlightBridgeRequests']);
            return { tabs: (await chrome.tabs.query({})).map(({ id, windowId, index, url, pendingUrl, title, pinned, incognito, active, groupId, splitViewId, mutedInfo }) => ({ id, windowId, index, url, pendingUrl: pendingUrl || null, title, pinned, incognito, active, groupId, splitViewId: splitViewId ?? -1, muted: Boolean(mutedInfo?.muted) })).sort((a, b) => a.id - b.id),
                windows: (await chrome.windows.getAll()).map(({ id, type, incognito, focused, state }) => ({ id, type, incognito, focused, state })).sort((a, b) => a.id - b.id),
                spaces: (local.spaces || []).map(({ id, name, color, icon, bookmarkFolderId, spaceBookmarks, temporaryTabs, lastTab }) => ({ id, name, color, icon, bookmarkFolderId, spaceBookmarks, temporaryTabs, ...(lastTab === undefined ? {} : { lastTab }) })),
                bookmarks: await chrome.bookmarks.getTree(), bindings: local.pinnedTabStatesById || {}, aliases: local.tabNameOverridesById || {}, favorites: local.persistentFavorites || [],
                savedSnapshot: local.spaceTabSnapshot || [], pairingGeneration: local.arcifyBridgePairingGeneration ?? null, representation: local.todayOrderRepresentation,
                activeSpaces: session.activeSpaces || {}, projection: session.spaceGroupProjection || {}, favoriteSession: session.favoriteSession || null, journal: session.spotlightBridgeRequests || [], groups: (await chrome.tabGroups.query({})).sort((a, b) => a.id - b.id) };
        });
        state.bookmarks = canonicalSavedMoveBookmarks(state.bookmarks); state.snapshots = snapshots; state.snapshotWindowIds = [windowId, otherWindow]; state.arcifyId = arcifyId;
        state.pageStates = Object.fromEntries(await Promise.all([...pages].map(async ([id, page]) => [id, await page.evaluate(readSpotlightActionPage)])));
        return state;
    };
    const reset = async surface => {
        await apiPage.evaluate(() => { globalThis.__spaceActionObservation.events.length = 0; });
        await spotlightOptions.evaluate(() => { globalThis.__spaceActionObservation.events.length = 0; });
        if (surface) await surface.evaluate(() => { globalThis.__tabCommandInput.events.length = 0; });
    };
    const observed = async (surface, inputOwner = surface) => ({ events: await apiPage.evaluate(() => globalThis.__spaceActionObservation.events), peerEvents: await spotlightOptions.evaluate(() => globalThis.__spaceActionObservation.events), input: inputOwner ? await inputOwner.evaluate(() => globalThis.__tabCommandInputEvents) : [] });
    const activate = async id => { await apiPage.evaluate(async id => { const tab = await chrome.tabs.update(id, { active: true }); await chrome.windows.update(tab.windowId, { focused: true }); }, id); await settle(); };
    const closeOverlay = async () => {
        if (!overlayPage || overlayPage.isClosed() || !await overlayPage.evaluate(() => Boolean(document.getElementById('arcify-spotlight-host')))) return;
        const surface = await spotlightSurface(overlayPage);
        await ui(overlayPage, 'Dismiss the completed Spotlight tab-command surface', async () => { const input = await surface.$('[data-testid="spotlight-input"]'); assert(input); try { await input.press('Escape'); } finally { await input.dispose(); } });
        await overlayPage.waitForFunction(() => !document.getElementById('arcify-spotlight-host'), { polling: 50 });
    };
    const overlay = async tabId => {
        await closeOverlay(); overlayPage = pages.get(tabId); assert(overlayPage); await activate(tabId);
        const reply = await external(apiPage, spotlightId, 'launch', { windowId, mode: 'new-tab' }); assert.equal(reply?.ok, true, JSON.stringify(reply));
        await overlayPage.waitForFunction(() => document.getElementById('arcify-spotlight-host')?.shadowRoot?.querySelector('dialog')?.open);
        const surface = await spotlightSurface(overlayPage); assert.notEqual(surface, overlayPage);
        const rendered = await surface.evaluate(() => ({ embedded: top !== window, url: document.URL, ready: Boolean(document.querySelector('[data-testid="spotlight-input"]')), timeOrigin: performance.timeOrigin }));
        assert.equal(rendered.embedded, true); assert.equal(rendered.ready, true); await checkpoint('real-overlay-source', { tabId, rendered }); return surface;
    };
    const context = async (tabId, section, bookmarkId) => {
        const before = await read(), reply = await external(spotlightOptions, arcifyId, 'tabActionContext', { windowId, tabId, supportedFeatures: TAB_COMMAND_FEATURES });
        assert.equal(reply?.ok, true, JSON.stringify(reply)); assert.equal(reply.extensionId, arcifyId); assertTabCommandContext(reply.tabActionContext, before, { windowId, sourceTabId: tabId, section, bookmarkId }); return reply.tabActionContext;
    };
    const ready = async (page, command, sourceContext) => {
        const query = command === 'renameCurrentTab' && sourceContext.tab.section === 'saved' ? 'rename saved space pin' : command === 'setCurrentTabMuted' && sourceContext.tab.muted ? 'unmute curent tab' : TAB_COMMAND_QUERIES[command];
        await search(page, query); const surface = await spotlightSurface(page), title = tabCommandTitle(command, sourceContext);
        const rows = await poll(() => surface.evaluate(readSpotlightRows), rows => rows[0]?.type === 'arcify-tab-action' && rows[0]?.title === title && rows[0]?.selected, `visible exact ${command} with ordinary web search retained`);
        assertMatchedActionFirst(rows, { type: 'arcify-tab-action', title, query }); await surface.evaluate(installTabCommandInputObservation, { retainInParent: surface !== page }); return { surface, rows, query, inputOwner: page };
    };
    const invoke = async (surface, command, sourceContext, keyboard = false) => {
        if (keyboard) { const input = await surface.$('[data-testid="spotlight-input"]'); assert(input); try { await input.press('Enter'); } finally { await input.dispose(); } return; }
        await clickFreshResult(async timeout => {
            await surface.waitForSelector('[data-result-type="arcify-tab-action"]', { visible: true, timeout });
            const handle = await surface.evaluateHandle(title => { const rows = [...document.querySelectorAll('[data-result-type="arcify-tab-action"]')].filter(row => row.querySelector('.arcify-spotlight-result-title')?.textContent === title); if (rows.length !== 1) throw new Error('Expected one exact current tab command.'); return rows[0]; }, tabCommandTitle(command, sourceContext));
            assert(handle.asElement()); return handle.asElement();
        }, observation => checkpoint('fresh-tab-command-click', { command, observation }));
    };
    const edit = async (page, surface, value) => { const input = await surface.$('[data-tab-action-input]'); assert(input); try { await replaceInputText(page, input, value); } finally { await input.dispose(); } };
    const status = (surface, text) => surface.waitForFunction(text => [...document.querySelectorAll('.arcify-bridge-status')].some(node => node.textContent.includes(text)), { polling: 50 }, text);
    const successText = (command, sourceContext, fields) => ({ renameCurrentTab: sourceContext.tab.section === 'saved' ? 'Saved pin renamed.' : 'Today tab name updated.', editCurrentPinUrl: 'Saved URL updated. This tab stays on its current page.', duplicateCurrentTab: 'Tab duplicated in Today.', copyCurrentLink: 'Current link copied.', setCurrentTabMuted: fields.muted ? 'Current tab muted.' : 'Current tab unmuted.' }[command]);
    const cancel = async (page, command, sourceContext, method) => {
        const { surface, rows, query } = await ready(page, command, sourceContext);
        await ui(page, `Cancel ${command} with genuine ${method}`, async () => {
            const before = await read(); await reset(surface); await invoke(surface, command, sourceContext);
            await surface.waitForSelector('.arcify-tab-action-prompt', { visible: true }); const prompt = await surface.evaluate(readTabCommandPrompt); assertTabCommandPrompt(prompt, command, sourceContext);
            const geometry = await requireActionPromptGeometry({ surface, selector: '.arcify-tab-action-prompt', poll });
            const value = command === 'editCurrentPinUrl' ? `${base}/cancelled` : `Cancelled ${nonce}`; await edit(page, surface, value);
            const editedGeometry = await requireActionPromptGeometry({ surface, selector: '.arcify-tab-action-prompt', poll });
            const shot = await capture(page, `${command}-cancel-${method}`);
            if (method === 'Escape') await page.keyboard.press('Escape'); else await surface.click('[data-action-cancel]');
            await surface.waitForSelector('.arcify-tab-action-prompt', { hidden: true }); const after = await read(), trace = await observed(surface);
            assertTabCommandNoEffects(before, after, trace.events); assertTabCommandInput(trace.input, command, sourceContext, { outcome: 'cancel', value });
            assert.equal(await surface.$eval('[data-testid="spotlight-input"]', node => node.value), query);
            assert.equal(await surface.$eval('[data-testid="spotlight-input"]', node => document.activeElement === node), true);
            await checkpoint('tab-prompt-cancelled', { command, method, prompt, geometry, editedGeometry, rows, before, after, trace, screenshot: shot });
        });
    };
    const commit = async (page, command, sourceContext, fields = {}, keyboard = false) => {
        const { surface, rows, inputOwner } = await ready(page, command, sourceContext); let result;
        await ui(page, `Run ${command} once through the visible Spotlight row`, async () => {
            const before = await read(); assert.equal(before.activeSpaces[otherWindow], otherSpace.id, 'Other window keeps its independently selected Space.'); await reset(surface);
            const targetsBefore = command === 'duplicateCurrentTab' ? new Set(browser.targets()) : null;
            if (command === 'duplicateCurrentTab') pendingDuplicate = { ids: before.tabs.map(tab => tab.id), windowId, url: sourceContext.tab.url };
            await invoke(surface, command, sourceContext, keyboard);
            let prompt, geometry;
            if (['renameCurrentTab', 'editCurrentPinUrl'].includes(command)) {
                await surface.waitForSelector('.arcify-tab-action-prompt', { visible: true }); prompt = await surface.evaluate(readTabCommandPrompt); assertTabCommandPrompt(prompt, command, sourceContext);
                geometry = await requireActionPromptGeometry({ surface, selector: '.arcify-tab-action-prompt', poll });
                await edit(page, surface, fields.title ?? fields.url);
                geometry = await requireActionPromptGeometry({ surface, selector: '.arcify-tab-action-prompt', poll });
                await capture(page, `${command}-explicit-prompt`);
                if (keyboard) await page.keyboard.press('Enter'); else await surface.click(`[data-action-confirm="${command}"]`);
            }
            const dispatched = await poll(() => observed(surface, inputOwner), value => value.events.some(event => event.type === 'external' && mutations.includes(event.data.message.command)), 'one observed tab-command dispatch');
            await checkpoint('tab-command-dispatched-before-validation', { command, before, fields, prompt, geometry, rows, dispatched });
            const request = assertTabCommandRequest(dispatched.events, command, sourceContext, spotlightId, fields);
            let after = await poll(read, state => {
                const receipt = findTabCommandReceipt(state.journal, request);
                return typeof receipt?.response?.ok === 'boolean';
            }, 'one durable exact request fingerprint and receipt');
            await checkpoint('tab-command-receipt-before-validation', { command, before, after, fields, request, dispatched });
            assert.equal(findTabCommandReceipt(after.journal, request)?.response?.ok, true, 'Exact tab command must have a successful receipt.');
            if (command === 'duplicateCurrentTab') {
                const duplicateId = findTabCommandReceipt(after.journal, request).response.tabId;
                const added = after.tabs.filter(tab => !before.tabs.some(old => old.id === tab.id)); assert.equal(added.length, 1); assert.equal(added[0].id, duplicateId); assert.equal(added[0].windowId, windowId); owned.add(duplicateId);
                await poll(() => apiPage.evaluate(id => chrome.tabs.get(id), duplicateId), tab => tab.status === 'complete' && !tab.pendingUrl && tab.url === sourceContext.tab.url, 'exact native duplicate finishes loading before durable comparison');
                after = await read(); pendingDuplicate = null;
            }
            const trace = await observed(surface, inputOwner); assert.deepEqual(assertTabCommandRequest(trace.events, command, sourceContext, spotlightId, fields), request);
            assertTabCommandInput(trace.input, command, sourceContext, { activation: keyboard ? 'Enter' : 'click', submission: keyboard ? 'Enter' : 'click', ...(prompt ? { value: fields.title ?? fields.url } : {}) });
            assertTabCommandCommitted(before, after, { command, context: sourceContext, fields, events: trace.events, request });
            const completion = await waitForActionSurfaceCompletion({ page, surface, retiresOverlay: command === 'duplicateCurrentTab',
                waitStatus: () => status(surface, successText(command, sourceContext, fields)) });
            after = await read();
            const completionTrace = await observed(surface, inputOwner);
            assert.deepEqual(assertTabCommandRequest(completionTrace.events, command, sourceContext, spotlightId, fields), request, 'Completion must not replay the action.');
            const committed = assertTabCommandCommitted(before, after, { command, context: sourceContext, fields, events: completionTrace.events, request });
            let shot;
            if (command === 'duplicateCurrentTab') {
                const target = await poll(() => { const fresh = browser.targets().filter(target => target.type() === 'page' && !targetsBefore.has(target)); assert(fresh.length <= 1, 'Exact duplicate target cannot be selected by matching an existing equal URL.'); return fresh.length === 1 && fresh[0].url() === sourceContext.tab.url ? fresh[0] : null; }, Boolean, 'one fresh duplicate target tied to the exact new native receipt');
                const duplicatePage = await observePage(await target.page()); await duplicatePage.waitForSelector('#action-page-state'); await duplicatePage.waitForFunction(() => document.visibilityState === 'visible', { polling: 50 });
                shot = await capture(duplicatePage, 'exact-native-duplicate-active');
                const visible = await duplicatePage.evaluate(readSpotlightActionPage); assert.notEqual(visible.timeOrigin, before.pageStates[sourceContext.tab.id].timeOrigin);
            } else shot = await capture(page, `${command}-committed`);
            await checkpoint('tab-command-committed-once', { command, before, after, fields, prompt, geometry, rows, trace, completionTrace, completion, request, committed, screenshot: shot });
            result = { before, after, trace, request, committed, surface };
        });
        return result;
    };
    const replay = async result => {
        const { request } = result, { type, version, command, requestId, ...payload } = request;
        const before = await read(); await reset(); const reply = await external(spotlightOptions, arcifyId, command, payload, requestId); const after = await read(), trace = await observed();
        const receipt = result.after.journal.find(entry => entry.fingerprint === JSON.stringify(request));
        assertTabCommandReplay(before, after, trace.events, reply, receipt.response); await checkpoint('same-request-replay-no-effect', { request, reply, before, after, trace });
    };
    const refreshProof = async ({ title, oldTitle, type = 'open-tab', expectedCount = 1, domain, label }) => {
        const delivered = await poll(() => searchHelper.page.evaluate(() => ({ timeOrigin: performance.timeOrigin, changes: globalThis.__pairedTabMenuSearch?.changes || [] })), state => state.changes.length > 0, 'real paired invalidation reached the existing hidden query');
        assert.equal(delivered.timeOrigin, searchHelper.timeOrigin);
        const rows = await ui(searchHelper.page, 'Return to mounted paired search without typing or reloading', async () => {
            const rows = await poll(() => searchHelper.page.evaluate(readSpotlightRows), rows => rows.filter(row => row.type === type && row.title === title).length === expectedCount && (!oldTitle || !rows.some(row => row.type === type && row.title === oldTitle)), 'paired exact displayed title refresh');
            if (domain !== undefined) await poll(() => searchHelper.page.evaluate(({ title, type }) => [...document.querySelectorAll('[data-testid="spotlight-result"]')].filter(row => row.dataset.resultType === type && row.querySelector('.arcify-spotlight-result-title')?.textContent === title).map(row => row.querySelector('.arcify-spotlight-result-url-text')?.textContent || row.querySelector('.arcify-spotlight-result-url')?.textContent), { title, type }), domains => domains.length === 1 && domains[0] === domain, 'saved URL domain repaints in the existing paired query');
            assert.equal(await searchHelper.page.$eval('[data-testid="spotlight-input"]', node => node.value), nonce);
            assert.equal(await searchHelper.page.evaluate(() => performance.timeOrigin), searchHelper.timeOrigin); await capture(searchHelper.page, label); return rows;
        });
        await checkpoint('paired-query-refreshed', { title, oldTitle, rows, delivered });
    };
    const watchRefresh = () => searchHelper.page.evaluate(watchTabMenuInvalidation, { windowId, peerId: arcifyId });
    const make = async (url, targetWindow = windowId) => {
        const created = await createNavigationFixturePage({ browser, apiPage, observePage, poll, windowId: targetWindow, url }); owned.add(created.tab.id); pages.set(created.tab.id, created.page);
        await created.page.waitForSelector('#action-page-state'); return created;
    };
    try {
        await setting(false); await apiPage.evaluate(installSpotlightActionApiObservation); await spotlightOptions.evaluate(installSpotlightActionApiObservation); await apiPage.evaluate(installNavigationGroupObservation);
        await bridge('activateSpace', { windowId, spaceId: sourceSpace.id }); await bridge('activateSpace', { windowId: otherWindow, spaceId: otherSpace.id });
        const today = await make(`${base}/today`), twin = await make(`${base}/today`);
        for (const item of [today, twin]) await ui(item.page, 'Retain distinct state in same-URL native pages', () => item.page.type('#action-page-state', `-${item.tab.id}`));
        const nested = await apiPage.evaluate(options => chrome.bookmarks.create(options), { parentId: sourceSpace.bookmarkFolderId, title: `Nested tab pins ${nonce}` }); roots.push(nested.id); bookmarkIds.add(nested.id);
        const saved = await apiPage.evaluate(options => chrome.bookmarks.create(options), { parentId: nested.id, title: `Exact saved pin ${nonce}`, url: `${base}/pin` }); bookmarkIds.add(saved.id);
        const decoy = await apiPage.evaluate(options => chrome.bookmarks.create(options), { parentId: nested.id, title: `Same URL separate pin ${nonce}`, url: `${base}/pin` }); bookmarkIds.add(decoy.id);
        const otherPin = await apiPage.evaluate(options => chrome.bookmarks.create(options), { parentId: otherSpace.bookmarkFolderId, title: `Other Space pin ${nonce}`, url: `${base}/pin` }); roots.push(otherPin.id); bookmarkIds.add(otherPin.id);
        const live = await openSavedPage({ windowId, spaceId: sourceSpace.id, bookmarkId: saved.id, url: saved.url }); owned.add(live.tab.id); pages.set(live.tab.id, live.page);
        const linked = await openSavedPage({ windowId: otherWindow, spaceId: sourceSpace.id, bookmarkId: saved.id, url: saved.url }); owned.add(linked.tab.id); pages.set(linked.tab.id, linked.page);
        const decoyLive = await openSavedPage({ windowId: otherWindow, spaceId: sourceSpace.id, bookmarkId: decoy.id, url: decoy.url }); owned.add(decoyLive.tab.id); pages.set(decoyLive.tab.id, decoyLive.page);
        for (const item of [live, linked, decoyLive]) { await item.page.waitForSelector('#action-page-state'); await ui(item.page, 'Retain each exact saved live-copy document', () => item.page.type('#action-page-state', `-${item.tab.id}`)); }
        await bridge('activateSpace', { windowId: otherWindow, spaceId: otherSpace.id });
        searchHelper = await newTabPage(`chrome-extension://${spotlightId}/newtab.html`, windowId); owned.add(searchHelper.tab.id);
        await search(searchHelper.page, nonce); searchHelper.timeOrigin = await searchHelper.page.evaluate(() => performance.timeOrigin);
        await poll(() => searchHelper.page.evaluate(readSpotlightRows), rows => rows.filter(row => row.type === 'open-tab' && row.title === `Spotlight Tab today ${nonce}`).length === 2, 'both same-URL Today rows visible before alias mutation');
        await overlay(today.tab.id); let current = await context(today.tab.id, 'today');
        for (const method of ['Escape', 'Cancel']) await cancel(today.page, 'renameCurrentTab', current, method);
        await watchRefresh(); const alias = `Exact Today name ${nonce}`;
        const renamed = await commit(today.page, 'renameCurrentTab', current, { title: alias }, true); await replay(renamed);
        await refreshProof({ title: alias, label: 'today-alias-paired-refresh' });
        await overlay(today.tab.id); current = await context(today.tab.id, 'today'); await watchRefresh();
        await commit(today.page, 'renameCurrentTab', current, { title: '' });
        await refreshProof({ title: `Spotlight Tab today ${nonce}`, oldTitle: alias, expectedCount: 2, label: 'cleared-alias-paired-refresh' });
        await overlay(today.tab.id);
        for (const muted of [true, false]) { current = await context(today.tab.id, 'today'); await commit(today.page, 'setCurrentTabMuted', current, { muted }, muted); }
        current = await context(today.tab.id, 'today'); await commit(today.page, 'renameCurrentTab', current, { title: `Source-only duplicate alias ${nonce}` });
        current = await context(today.tab.id, 'today'); assert(current.tab.alias); const duplicated = await commit(today.page, 'duplicateCurrentTab', current, {}, true); await replay(duplicated);
        assert.equal(duplicated.after.bindings[duplicated.committed.duplicateId], undefined);
        await overlay(live.tab.id); current = await context(live.tab.id, 'saved', saved.id);
        await cancel(live.page, 'renameCurrentTab', current, 'Cancel'); await watchRefresh(); const savedTitle = `Renamed saved pin ${nonce}`;
        const savedRename = await commit(live.page, 'renameCurrentTab', current, { title: savedTitle });
        for (const [wid, id] of [[windowId, live.tab.id], [otherWindow, linked.tab.id]]) assert.equal(exact(savedRename.after.snapshots[wid].tabs, id).title, savedTitle, 'Both linked live titles independently project the exact saved name.');
        await refreshProof({ title: savedTitle, oldTitle: saved.title, type: 'bookmark', label: 'saved-title-paired-refresh' });
        await overlay(live.tab.id); current = await context(live.tab.id, 'saved', saved.id);
        for (const method of ['Escape', 'Cancel']) await cancel(live.page, 'editCurrentPinUrl', current, method);
        const editedAddress = new URL(`${base}/edited`); editedAddress.hostname = editedAddress.hostname === 'localhost' ? '127.0.0.1' : 'localhost'; const editedUrl = editedAddress.href;
        await watchRefresh(); const edited = await commit(live.page, 'editCurrentPinUrl', current, { url: editedUrl }, true); await replay(edited);
        assert.equal(exact(flat(edited.after.bookmarks), saved.id).title, savedTitle);
        for (const id of [live.tab.id, linked.tab.id]) { assert.equal(edited.after.bindings[id].pinnedUrl, editedUrl); assert.equal(exact(edited.after.tabs, id).url, saved.url); }
        assert.equal(edited.after.bindings[decoyLive.tab.id].bookmarkId, decoy.id);
        for (const [wid, id] of [[windowId, live.tab.id], [otherWindow, linked.tab.id]]) assert.equal(exact(edited.after.snapshots[wid].tabs, id).title, exact(edited.after.tabs, id).title, 'A divergent saved URL keeps each live page title.');
        await refreshProof({ title: savedTitle, type: 'bookmark', domain: editedAddress.hostname, label: 'saved-url-keeps-title-paired-refresh' });
        // The edited saved URL and the live URL now deliberately differ.
        await overlay(live.tab.id); current = await context(live.tab.id, 'saved', saved.id);
        for (const muted of [true, false]) { current = await context(live.tab.id, 'saved', saved.id); await commit(live.page, 'setCurrentTabMuted', current, { muted }); }
        current = await context(live.tab.id, 'saved', saved.id); const copied = await commit(live.page, 'copyCurrentLink', current, {}, true); await replay(copied);
        const contexts = await apiPage.evaluate(() => chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }));
        const inspector = await ready(live.page, 'renameCurrentTab', await context(live.tab.id, 'saved', saved.id));
        await ui(live.page, 'Observe exact clipboard text through native paste in a cancellable prompt', async () => {
            const beforePaste = await read(); await reset(inspector.surface);
            await invoke(inspector.surface, 'renameCurrentTab', current); await inspector.surface.waitForSelector('[data-tab-action-input]', { visible: true });
            await requireActionPromptGeometry({ surface: inspector.surface, selector: '.arcify-tab-action-prompt', poll });
            await inspector.surface.evaluate(() => { globalThis.__tabCommandInput.events.length = 0; });
            const input = await inspector.surface.$('[data-tab-action-input]'); assert(input); let pasted;
            try { await input.focus(); await live.page.keyboard.down('Control'); try { await input.press('KeyA'); await input.press('KeyV'); } finally { await live.page.keyboard.up('Control'); } pasted = await input.evaluate(node => node.value); }
            finally { await input.dispose(); }
            const pasteEvents = await inspector.surface.evaluate(() => globalThis.__tabCommandInput.events);
            assertTabCommandClipboard({ events: copied.trace.events, contexts, pasted, pasteEvents, expected: current.tab.url, arcifyId });
            const geometry = await requireActionPromptGeometry({ surface: inspector.surface, selector: '.arcify-tab-action-prompt', poll });
            const shot = await capture(live.page, 'actual-offscreen-clipboard-native-paste'); await inspector.surface.click('[data-action-cancel]'); await inspector.surface.waitForSelector('.arcify-tab-action-prompt', { hidden: true });
            const afterPaste = await read(), inspectionTrace = await observed(); assertTabCommandNoEffects(beforePaste, afterPaste, inspectionTrace.events);
            await checkpoint('real-offscreen-copy-exact-text', { contexts, pasted, pasteEvents, geometry, beforePaste, afterPaste, inspectionTrace, expected: current.tab.url, screenshot: shot });
        });
        // A real bookmark edit while the visible prompt is open must invalidate
        // the prepared context. This fixture mutation is outside the command trace.
        const stale = await ready(live.page, 'editCurrentPinUrl', current);
        await ui(live.page, 'Prepare URL edit before an external bookmark title change', async () => { await invoke(stale.surface, 'editCurrentPinUrl', current); await stale.surface.waitForSelector('[data-tab-action-input]', { visible: true }); await edit(live.page, stale.surface, `${base}/must-not-save`); });
        await apiPage.evaluate(({ id, title }) => chrome.bookmarks.update(id, { title }), { id: saved.id, title: `Externally changed ${nonce}` }); await settle();
        await ui(live.page, 'Reject stale prepared URL edit without changing the native page', async () => {
            const before = await read(); await reset(stale.surface); const geometry = await requireActionPromptGeometry({ surface: stale.surface, selector: '.arcify-tab-action-prompt', poll }); await stale.surface.click('[data-action-confirm="editCurrentPinUrl"]'); await stale.surface.waitForSelector('.arcify-bridge-status[data-state="error"]', { visible: true });
            const after = await read(), trace = await observed(stale.surface); assertTabCommandNoEffects(before, after, trace.events);
            assert.equal(trace.peerEvents.filter(event => event.type === 'internal' && event.data.message.action === 'arcifyTabAction').length, 1);
            await checkpoint('stale-prepared-tab-edit-rejected', { before, after, geometry, trace, screenshot: await capture(live.page, 'stale-edit-error') });
        });
        await closeOverlay();
        for (const requestedUrl of [`chrome-extension://${spotlightId}/newtab.html`, 'chrome://newtab/']) {
            await reset(); aliasHelper = await newTabPage(requestedUrl, windowId); owned.add(aliasHelper.tab.id);
            await aliasHelper.page.waitForSelector('[data-testid="spotlight-input"]', { visible: true }); await poll(() => apiPage.evaluate(id => chrome.tabs.get(id), aliasHelper.tab.id), tab => tab.status === 'complete' && !tab.pendingUrl, 'settled exact helper context');
            await context(aliasHelper.tab.id, null); await search(aliasHelper.page, '');
            for (const query of ['', ...Object.values(TAB_COMMAND_QUERIES), 'unmute curent tab', 'rename saved space pin']) {
                await search(aliasHelper.page, query); const rows = await aliasHelper.page.evaluate(readSpotlightRows); assert(!rows.some(row => row.type === 'arcify-tab-action'), 'Helper must not borrow a previous Today, saved pin, or Favorite.');
            }
            const state = await aliasHelper.page.evaluate(readNewTabReuseState);
            let trace, origin = null, originState = state;
            if (requestedUrl === 'chrome://newtab/') {
                const collected = await collectSpotlightHelperOrigin({ initialState: state, poll, spotlightId, tabId: aliasHelper.tab.id, windowId, contextAction: 'arcifyTabActionsContext',
                    read: async () => { trace = await observed(); const state = await aliasHelper.page.evaluate(readNewTabReuseState); return { state, peerEvents: trace.peerEvents }; } });
                origin = collected.origin; originState = collected.state;
            } else trace = await observed();
            await checkpoint('helper-excludes-all-tab-commands', { requestedUrl, state, originState, trace, origin, screenshot: await capture(aliasHelper.page, requestedUrl.startsWith('chrome://') ? 'browser-newtab-excluded' : 'owned-helper-excluded') });
        }
        await overlay(live.tab.id); current = await context(live.tab.id, 'saved', saved.id); const prepared = await ready(live.page, 'renameCurrentTab', current);
        await ui(live.page, 'Prepare exact saved rename before receiver-side revocation', async () => { await invoke(prepared.surface, 'renameCurrentTab', current); await prepared.surface.waitForSelector('[data-tab-action-input]', { visible: true }); await edit(live.page, prepared.surface, `Revoked ${nonce}`); });
        await ui(apiPage, 'Revoke the actual Arcify paired grant', () => apiPage.click('#bridgeDisconnect')); revoked = true; await apiPage.waitForSelector('#bridgeStatus[data-state="disabled"]');
        await ui(live.page, 'Reject prepared tab rename after pairing revocation', async () => {
            const raw = () => apiPage.evaluate(async () => ({ tabs: await chrome.tabs.query({}), bookmarks: await chrome.bookmarks.getTree(), local: await chrome.storage.local.get(null), session: await chrome.storage.session.get(null), windows: await chrome.windows.getAll() }));
            await settle(); const before = await raw(); await reset(prepared.surface); const geometry = await requireActionPromptGeometry({ surface: prepared.surface, selector: '.arcify-tab-action-prompt', poll }); await prepared.surface.click('[data-action-confirm="renameCurrentTab"]');
            await prepared.surface.waitForSelector('.arcify-bridge-status[data-state="error"]', { visible: true }); await settle(); const after = await raw(), trace = await observed(prepared.surface);
            assert.deepEqual(after, before); assert(!trace.events.some(event => event.type === 'external' && commands.includes(event.data.message.command)));
            assert.equal(trace.peerEvents.filter(event => event.type === 'internal' && event.data.message.action === 'arcifyTabAction').length, 1);
            await checkpoint('revoked-prepared-tab-edit-rejected', { before, after, geometry, trace, screenshot: await capture(live.page, 'revoked-tab-error') });
        });
        return evidence;
    } catch (error) {
        primaryError = error;
        if (pendingDuplicate) {
            try { const added = (await apiPage.evaluate(() => chrome.tabs.query({}))).filter(tab => !pendingDuplicate.ids.includes(tab.id));
                assert(added.length <= 1, 'Cannot adopt ambiguous new native identities after an unconfirmed duplicate.');
                if (added.length) { const tab = added[0]; assert.equal(tab.windowId, pendingDuplicate.windowId); assert.equal(tab.url || tab.pendingUrl, pendingDuplicate.url); owned.add(tab.id); }
            } catch (cleanupError) { error.duplicateOwnershipError = cleanupError.message; }
        }
        await checkpoint('spotlight-tab-commands-failed', { error: { message: error.message, stack: error.stack }, owned: [...owned], roots }).catch(() => {});
        if (overlayPage && !overlayPage.isClosed()) await screenshot(overlayPage, 'spotlight-tabs-failure', false).catch(() => {}); throw error;
    } finally {
        await finishBookmarkFixture([
            async () => { if (!revoked) return; await ui(apiPage, 'Restore the exact paired fixture grant', async () => { const input = await apiPage.$('#bridgePeerId'); assert(input); try { await replaceInputText(apiPage, input, spotlightId); } finally { await input.dispose(); } await apiPage.click('#bridgeSave'); }); await apiPage.waitForSelector('#bridgeStatus[data-state="connected"]'); revoked = false; },
            () => closeOverlay(),
            () => apiPage.evaluate(async ids => { const live = new Set((await chrome.tabs.query({})).map(tab => tab.id)); const present = ids.filter(id => live.has(id)); if (present.length) await chrome.tabs.remove(present); }, [...owned]),
            () => apiPage.evaluate(async ({ roots, owned }) => { for (const id of roots) { let node; try { [node] = await chrome.bookmarks.getSubTree(id); } catch { continue; }
                const all = node => [node, ...(node.children || []).flatMap(all)]; if (all(node).some(value => !owned.includes(value.id))) throw new Error('Cleanup refuses an unowned bookmark inside the fixture root.');
                if (node.url) await chrome.bookmarks.remove(id); else await chrome.bookmarks.removeTree(id); } }, { roots, owned: [...bookmarkIds] }),
            () => setting(Boolean(initial.sync.syncTabGroups)),
            () => apiPage.evaluate(async original => { if (!Object.hasOwn(original, 'syncTabGroups')) await chrome.storage.sync.remove('syncTabGroups'); }, initial.sync),
            async () => {
                for (const tab of initial.tabs.filter(tab => tab.active)) await apiPage.evaluate(id => chrome.tabs.update(id, { active: true }), tab.id);
                for (const [id, spaceId] of Object.entries(initial.activeSpaces)) if (initial.windows.some(window => window.id === Number(id))) await local({ action: 'activate', windowId: Number(id), spaceId });
                const focused = initial.windows.find(window => window.focused); if (focused) await apiPage.evaluate(id => chrome.windows.update(id, { focused: true }), focused.id); await settle();
                const restored = await apiPage.evaluate(async () => ({ tabs: await chrome.tabs.query({}), windows: await chrome.windows.getAll(), activeSpaces: (await chrome.storage.session.get('activeSpaces')).activeSpaces || {}, sync: await chrome.storage.sync.get('syncTabGroups'), spaces: (await chrome.storage.local.get('spaces')).spaces || [], bookmarks: await chrome.bookmarks.getTree() }));
                assert.deepEqual(restored.sync, initial.sync);
                assert(!flat(restored.bookmarks).some(node => bookmarkIds.has(node.id)));
                assert(!restored.spaces.some(space => [...space.temporaryTabs, ...space.spaceBookmarks].some(id => owned.has(id))));
                for (const tab of initial.tabs) for (const key of ['windowId', 'url', 'pendingUrl', 'index', 'active', 'pinned', 'incognito', 'splitViewId']) assert.deepEqual(exact(restored.tabs, tab.id)[key], tab[key], `Cleanup preserves original native ${key}.`);
                assert.deepEqual(restored.tabs.map(tab => tab.id).sort((a, b) => a - b), initial.tabs.map(tab => tab.id).sort((a, b) => a - b));
                assert.deepEqual(restored.tabs.filter(tab => tab.active).map(tab => tab.id).sort((a, b) => a - b), initial.tabs.filter(tab => tab.active).map(tab => tab.id).sort((a, b) => a - b));
                assert.deepEqual(restored.activeSpaces, initial.activeSpaces); assert.deepEqual(restored.windows.filter(window => window.focused).map(window => window.id), initial.windows.filter(window => window.focused).map(window => window.id));
                await checkpoint('tab-command-cleanup-verified', { restored });
            },
            () => apiPage.evaluate(() => { globalThis.__navigationGroupObservation?.stop(); globalThis.__spaceActionObservation?.stop(); }),
            () => spotlightOptions.evaluate(() => globalThis.__spaceActionObservation?.stop())
        ], primaryError, record);
    }
}
