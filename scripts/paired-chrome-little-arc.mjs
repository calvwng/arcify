/** Import-safe, source-only Little Arc acceptance. The hosted paired runner owns Chrome. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spotlightSurface } from './paired-chrome-keyboard.mjs';
import { readSpotlightRows } from './paired-chrome-sidebar.mjs';
import { clickFreshResult, replaceInputText } from './paired-chrome-ui.mjs';
import { createNavigationFixturePage } from './paired-chrome-spotlight-navigation.mjs';
import { canonicalSavedMoveBookmarks } from './paired-chrome-saved-move.mjs';
import { finishBookmarkFixture } from './paired-chrome-bookmark-selection.mjs';
import { installSpotlightActionApiObservation } from './paired-chrome-spotlight-actions.mjs';
import { withLittleArcOpenDiagnostics } from './paired-chrome-little-arc-diagnostics.mjs';
import { LITTLE_ARC_NATIVE_UNVERIFIED, installLittleArcReloadObservation, readLittleArcReloadObservation, stopLittleArcReloadObservation,
    assertLittleArcReloadObservation, readLittleArcReloadDocument, assertLittleArcReloadDocument, claimLittleArcReloadOnboarding,
    assertLittleArcReloadOnboardingUnchanged, assertLittleArcMissingControllerReload } from './paired-chrome-little-arc-reload.mjs';

export const LITTLE_ARC_CASE_NAME = 'Little Arc trusted launch and same-tab transfer preserve documents with missing-controller reload fallback';
export const LITTLE_ARC_TITLE = 'Open link in Little Arc';
export const LITTLE_ARC_TYPE = 'arcify-transient-action';
const SESSION_KEY = 'transientWindowSession';
const exact = (items, id, key = 'id') => { const found = items.filter(item => item[key] === id); assert.equal(found.length, 1, `Require one exact ${key}: ${id}.`); return found[0]; };
const owner = (state, tabId) => state.spaces.flatMap(space => ['spaceBookmarks', 'temporaryTabs'].flatMap(section => (space[section] || []).filter(id => id === tabId).map(() => ({ spaceId: space.id, bookmarkFolderId: space.bookmarkFolderId, section }))));
const ownership = state => state.spaces.map(({ id, bookmarkFolderId, spaceBookmarks, temporaryTabs }) => ({ id, bookmarkFolderId, spaceBookmarks, temporaryTabs }));
const eventTabId = event => Array.isArray(event.data) ? (typeof event.data[0] === 'object' ? event.data[0]?.id : event.data[0]) : event.data.id;
const controlRequests = events => events.filter(event => event.type === 'internal' && event.data.message.type === 'arcifyTransientWindow' && ['recover', 'promote'].includes(event.data.message.action));
const tabMutations = events => events.filter(event => /^tabs\.(?:onCreated|onRemoved|onReplaced|onAttached|onDetached|onMoved)$/.test(event.type));

export function assertLittleArcEnvironment(env = process.env, uid = process.getuid?.()) {
    assert.equal(env.GITHUB_ACTIONS, 'true', 'Little Arc acceptance is restricted to the dedicated hosted job.');
    assert.equal(env.CI, 'true'); assert(Number.isInteger(uid) && uid > 0, 'Require the ordinary sandboxed hosted runner, never root.');
}
export function serveLittleArcFixture(request, response) {
    const match = /^\/little-arc\/([a-f0-9]{32})\/([a-z-]+)$/.exec(new URL(request.url, 'http://127.0.0.1').pathname);
    if (!match) return false;
    const title = `Little Arc ${match[2]} ${match[1]}`;
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-src 'none'; form-action 'none'" });
    response.end(`<!doctype html><html><head><title>${title}</title><link rel="icon" href="data:,"></head><body data-document-id="${randomBytes(16).toString('hex')}"><h1>${title}</h1><form><label>Unsaved title <input id="little-arc-draft" value="initial"></label><label>Unsaved notes <textarea id="little-arc-notes">initial notes</textarea></label><label>Keep checked <input id="little-arc-check" type="checkbox"></label></form></body></html>`);
    return true;
}
/** Store only passive reference witnesses, never manufacture input or page state. */
export function installLittleArcDocumentObservation() {
    globalThis.__littleArcDocumentWitness = { document, input: document.querySelector('#little-arc-draft'), notes: document.querySelector('#little-arc-notes') };
}
export function readLittleArcPage() {
    const witness = globalThis.__littleArcDocumentWitness;
    return { url: document.URL, title: document.title, documentId: document.body.dataset.documentId,
        timeOrigin: performance.timeOrigin, topLevel: top === self, frameCount: document.querySelectorAll('iframe,frame').length,
        value: document.querySelector('#little-arc-draft')?.value, notes: document.querySelector('#little-arc-notes')?.value,
        checked: document.querySelector('#little-arc-check')?.checked,
        sameDocument: witness?.document === document, sameInput: witness?.input === document.querySelector('#little-arc-draft'), sameNotes: witness?.notes === document.querySelector('#little-arc-notes') };
}
/** Listeners only: no transport wrappers, responders, fake gestures or controller calls. */
export function installLittleArcInputObservation({ retainInParent = false } = {}) {
    globalThis.__littleArcInputObservation?.stop();
    const events = [], removals = [];
    for (const type of ['click', 'keydown', 'change', 'submit']) {
        const listener = event => {
            const row = event.target.closest?.('[data-testid="spotlight-result"]') || document.querySelector('[data-testid="spotlight-result"].selected');
            events.push({ type, trusted: event.isTrusted, key: event.key || null, button: event.button ?? null,
                id: event.target.id || null, value: event.target.value ?? null, submitter: event.submitter?.id || null,
                repeat: Boolean(event.repeat), composing: Boolean(event.isComposing), ctrl: Boolean(event.ctrlKey), alt: Boolean(event.altKey), meta: Boolean(event.metaKey), shift: Boolean(event.shiftKey),
                resultType: row?.dataset.resultType || null, title: row?.querySelector('.arcify-spotlight-result-title')?.textContent || null });
        };
        document.addEventListener(type, listener, true); removals.push(() => document.removeEventListener(type, listener, true));
    }
    const statuses = [], statusNode = document.querySelector('.arcify-bridge-status');
    const captureStatus = () => { if (statusNode) statuses.push({ state: statusNode.dataset.state || null, text: statusNode.querySelector('[role="status"]')?.textContent || '', time: performance.now() }); };
    if (statusNode) {
        const observer = new MutationObserver(captureStatus); observer.observe(statusNode, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['data-state'] });
        removals.push(() => observer.disconnect()); captureStatus();
    }
    globalThis.__littleArcInputObservation = { events, stop: () => removals.forEach(remove => remove()) };
    (retainInParent ? parent : globalThis).__littleArcInputEvents = events;
    (retainInParent ? parent : globalThis).__littleArcStatusEvents = statuses;
}
/** Local native group listeners, sharing only the passive action-event ledger. */
export function installLittleArcGroupObservation() {
    globalThis.__littleArcGroupObservation?.stop();
    if (!globalThis.__spaceActionObservation?.events) throw new Error('Install the passive action observer before native group observation.');
    const removals = [];
    for (const name of ['onCreated', 'onUpdated', 'onMoved', 'onRemoved']) {
        const listener = (...data) => globalThis.__spaceActionObservation.events.push({ type: `tabGroups.${name}`, data });
        chrome.tabGroups[name].addListener(listener);
        removals.push(() => chrome.tabGroups[name].removeListener(listener));
    }
    globalThis.__littleArcGroupObservation = { stop: () => removals.splice(0).forEach(remove => remove()) };
}
export function readLittleArcControls() {
    const select = id => { const node = document.getElementById(id); return { value: node.value, disabled: node.disabled,
        options: [...node.options].map(option => ({ value: option.value, text: option.textContent, selected: option.selected, disabled: option.disabled })) }; };
    return { url: document.URL, timeOrigin: performance.timeOrigin, recoveryHidden: document.getElementById('recovery-form').hidden,
        recovery: select('recovery-page'), window: select('destination-window'), space: select('destination-space'),
        recoverDisabled: document.getElementById('recover').disabled, promoteDisabled: document.getElementById('promote').disabled,
        status: document.getElementById('status').textContent };
}
export function assertLittleArcTrustedInput(events, { action, method = 'click', selectedId, destination } = {}) {
    assert(Array.isArray(events) && events.length > 0);
    assert(events.every(event => event.trusted && !event.repeat && !event.composing && !event.ctrl && !event.alt && !event.meta && !event.shift), 'Acceptance needs genuine unmodified browser input.');
    if (action === 'open') {
        const activations = events.filter(event => event.type === 'click' || event.type === 'keydown' && event.key === 'Enter');
        assert.equal(activations.length, 1); assert.equal(activations[0].type, method === 'Enter' ? 'keydown' : 'click');
        assert.equal(activations[0].resultType, LITTLE_ARC_TYPE); assert.equal(activations[0].title, LITTLE_ARC_TITLE);
        if (method === 'click') assert.equal(activations[0].button, 0);
    } else {
        const submits = events.filter(event => event.type === 'submit');
        assert.equal(submits.length, 1); assert.equal(submits[0].id, action === 'recover' ? 'recovery-form' : 'transfer-form');
        assert.equal(submits[0].submitter, action === 'recover' ? 'recover' : 'promote');
        if (selectedId !== undefined) assert(events.some(event => event.type === 'change' && event.id === 'recovery-page' && event.value === String(selectedId)), 'A trusted exact-ID selection precedes recovery.');
        if (action === 'promote') {
            assert(destination, 'Promotion must retain its explicit destination choice.');
            for (const [id, value] of [['destination-window', destination.windowId], ['destination-space', destination.spaceId]])
                assert(events.some(event => event.type === 'change' && event.id === id && event.value === String(value)), `Trusted ${id} selection must identify the exact destination.`);
        }
    }
}
export function assertLittleArcExcluded(state, ids) {
    for (const id of ids) {
        assert.equal(owner(state, id).length, 0, `Transient ${id} cannot become Space-owned.`);
        assert(!state.savedSnapshot.some(item => item.tabId === id), `Transient ${id} cannot enter restore snapshots.`);
        assert(!Object.hasOwn(state.bindings, String(id)), `Transient ${id} cannot have a saved-pin binding.`);
        assert(![...(state.favoriteSession?.bindings || []), ...(state.favoriteSession?.attempts || [])].some(item => item.tabId === id), `Transient ${id} cannot become a Favorite.`);
        for (const snapshot of Object.values(state.snapshots || {})) {
            assert(!(snapshot.tabs || []).some(tab => tab.id === id));
            for (const space of snapshot.spaces || []) for (const key of ['tabIds', 'pinnedTabIds', 'temporaryTabIds']) assert(!(space[key] || []).includes(id));
            assert(!(snapshot.favorites || []).some(item => item.tabId === id));
        }
    }
}
/** Cleanup authority comes only from exact newly journaled native identities. */
export function collectLittleArcOwnedIds(before, after, { arcifyId, originWindowId, request, spotlightId }) {
    const candidates = after.registry.records.filter(record => !before.registry.records.some(old => old.token === record.token));
    assert(candidates.length <= 1, 'Multiple new records are ambiguous; do not claim any unknown page.');
    if (!candidates.length) return { tabIds: [], windowIds: [] };
    const pending = after.journal.filter(entry => entry.fingerprint === JSON.stringify(request));
    assert.equal(pending.length, 1, 'Cleanup identities require the actual observed request journal.');
    assert(pending[0].key.startsWith(`${spotlightId}:`) && pending[0].key.endsWith(`:${request.requestId}`));
    const record = candidates[0]; assert.match(record.token, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
    assert.equal(record.originWindowId, originWindowId); assert(['opening', 'ready', 'uncertain'].includes(record.phase));
    if (pending[0].response) { assert.equal(pending[0].response.token, record.token); assert.equal(pending[0].response.tabId, record.tabId); assert.equal(pending[0].response.transientWindowId, record.windowId); }
    if (record.windowId === null || record.controllerTabId === null) return { tabIds: [], windowIds: [] };
    assert(!before.windows.some(window => window.id === record.windowId));
    assert(!before.tabs.some(tab => [record.controllerTabId, record.tabId].includes(tab.id)));
    const controller = exact(after.tabs, record.controllerTabId);
    assert.equal(controller.windowId, record.windowId);
    assert.equal(controller.pendingUrl || controller.url, `chrome-extension://${arcifyId}/transient-window.html?token=${record.token}`);
    assert(record.memberTabIds.includes(controller.id));
    const tabIds = [controller.id];
    if (record.tabId !== null) {
        assert.notEqual(record.tabId, controller.id); const page = exact(after.tabs, record.tabId); assert.equal(page.windowId, record.windowId);
        assert(record.memberTabIds.includes(page.id)); tabIds.push(page.id);
    }
    return { tabIds, windowIds: [record.windowId] };
}
export function assertLittleArcSavedUnchanged(before, after, events = []) {
    assert.deepEqual(canonicalSavedMoveBookmarks(after.bookmarks), canonicalSavedMoveBookmarks(before.bookmarks));
    for (const key of ['favorites', 'archivedTabs', 'bindings']) assert.deepEqual(after[key], before[key], `${key} cannot change during Little Arc actions.`);
    assert(!events.some(event => event.type.startsWith('bookmarks.')), 'Little Arc cannot write native bookmarks.');
    for (const event of events.filter(event => event.type === 'storage')) for (const key of ['persistentFavorites', 'archivedTabs', 'pinnedTabStatesById']) {
        const change = event.data.changes[key]; if (change) assert.deepEqual(change.newValue, change.oldValue, `Little Arc cannot transiently mutate ${key}.`);
    }
}
export function assertLittleArcPagesUnchanged(before, after, { movedTabId, destinationWindowId } = {}) {
    for (const tab of before.tabs) {
        const kept = exact(after.tabs, tab.id);
        for (const key of ['url', 'pendingUrl', 'pinned', 'incognito', 'splitViewId']) assert.deepEqual(kept[key], tab[key], `Native ${tab.id} ${key} must survive.`);
        assert.equal(kept.windowId, tab.id === movedTabId ? destinationWindowId : tab.windowId, `Only the chosen native tab may change windows.`);
        if (tab.id !== movedTabId) assert.equal(kept.groupId, tab.groupId);
    }
    for (const [id, document] of Object.entries(before.pageStates || {})) {
        assert.deepEqual(after.pageStates[id], document, `Native page ${id} must retain its exact document and unsaved form.`);
        for (const key of ['sameDocument', 'sameInput', 'sameNotes', 'topLevel']) assert.equal(after.pageStates[id][key], true);
        assert.equal(after.pageStates[id].frameCount, 0);
    }
}
/** Negative and selection-only actions cannot hide focus, index or ownership changes. */
export function assertLittleArcNoEffects(before, after, events, { selectedToken = null } = {}) {
    assertLittleArcPagesUnchanged(before, after); assertLittleArcSavedUnchanged(before, after, events);
    for (const key of ['tabs', 'windows', 'groups', 'spaces', 'savedSnapshot', 'activeSpaces', 'favoriteSession', 'journal'])
        assert.deepEqual(after[key], before[key], `Selection/cancellation must preserve exact ${key}.`);
    const snapshots = state => Object.fromEntries(Object.entries(state.snapshots || {}).map(([id, { capturedAt, ...snapshot }]) => [id, snapshot]));
    assert.deepEqual(snapshots(after), snapshots(before));
    if (selectedToken === null) assert.deepEqual(after.registry, before.registry);
    else {
        assert.equal(after.registry.version, before.registry.version);
        assert.deepEqual(after.registry.records.filter(record => record.token !== selectedToken), before.registry.records.filter(record => record.token !== selectedToken));
    }
    assert(!events.some(event => /^(?:tabs|windows|tabGroups|bookmarks|sidePanel)\./.test(event.type)), 'No native mutation, activation or focus event belongs to a selection-only or cancelled action.');
    for (const event of events.filter(event => event.type === 'storage')) for (const key of ['spaces', 'spaceTabSnapshot', 'pinnedTabStatesById', 'persistentFavorites', 'archivedTabs', 'activeSpaces', 'favoriteSession']) {
        const change = event.data.changes[key]; if (change) assert.deepEqual(change.newValue, change.oldValue, `No transient ${key} write may be rolled back into a passing final state.`);
    }
}
export function assertLittleArcDraft(value, { label, nonce, tabId }) {
    assert.equal(value.value, `Unsubmitted ${label} ${nonce}`);
    assert.equal(value.notes, `Unsaved notes ${label} for native tab ${tabId} ${nonce}`);
    assert.equal(value.checked, true); assert.match(value.documentId, /^[a-f0-9]{32}$/);
    assert(Number.isFinite(value.timeOrigin) && value.timeOrigin > 0);
    for (const key of ['sameDocument', 'sameInput', 'sameNotes', 'topLevel']) assert.equal(value[key], true);
    assert.equal(value.frameCount, 0);
}
export function assertLittleArcBridgeReceipt(state, request, record, spotlightId) {
    const matches = state.journal.filter(entry => entry.fingerprint === JSON.stringify(request)); assert.equal(matches.length, 1, 'Require exactly one committed receipt for this observed request fingerprint.');
    const receipt = matches[0]; assert(receipt.key.startsWith(`${spotlightId}:`) && receipt.key.endsWith(`:${request.requestId}`));
    assert.deepEqual(receipt.response, { type: 'arcify-bridge', version: 1, requestId: request.requestId, role: 'arcify', ok: true,
        tabId: record.tabId, transientWindowId: record.windowId, token: record.token });
    return receipt;
}
export function assertLittleArcLaunch(before, after, { record, events, spotlightId, originWindowId, url }) {
    const mutations = events.filter(event => event.type === 'external' && ['openTransient', 'openTab', 'navigateTab', 'openBookmark', 'openFavorite'].includes(event.data.message.command));
    assert.equal(mutations.length, 1); const { message, sender } = mutations[0].data;
    assert.equal(sender.id, spotlightId); assert.equal(message.type, 'arcify-bridge'); assert.equal(message.version, 1);
    assert.equal(message.command, 'openTransient'); assert.equal(message.windowId, originWindowId); assert.equal(message.url, url); assert(message.requestId);
    assertLittleArcBridgeReceipt(after, message, record, spotlightId);
    assert.equal(record.phase, 'ready'); assert.equal(record.originWindowId, originWindowId); assert.notEqual(record.tabId, record.controllerTabId);
    assert(!before.tabs.some(tab => [record.tabId, record.controllerTabId].includes(tab.id)));
    assert.deepEqual(after.tabs.filter(tab => !before.tabs.some(old => old.id === tab.id)).map(tab => tab.id).sort((a,b) => a-b), [record.tabId, record.controllerTabId].sort((a,b) => a-b));
    assert.deepEqual(after.windows.filter(window => !before.windows.some(old => old.id === window.id)).map(window => window.id), [record.windowId]);
    const window = exact(after.windows, record.windowId); assert.equal(window.type, 'normal'); assert.equal(window.incognito, false);
    assert(window.width <= 900 && window.width > 0 && window.height <= 720 && window.height > 0);
    const tab = exact(after.tabs, record.tabId); assert.equal(tab.windowId, record.windowId); assert.equal(tab.url, url); assert.equal(tab.pinned, false);
    assert.equal(exact(after.tabs, record.controllerTabId).windowId, record.windowId);
    assert.deepEqual(ownership(after), ownership(before)); assertLittleArcExcluded(after, [record.tabId, record.controllerTabId]);
    assertLittleArcSavedUnchanged(before, after, events); assertLittleArcPagesUnchanged(before, after);
    assert.deepEqual(tabMutations(events).filter(event => event.type !== 'tabs.onCreated'), []);
    assert.deepEqual(events.filter(event => event.type === 'tabs.onCreated').map(eventTabId).sort((a,b) => a-b), [record.tabId, record.controllerTabId].sort((a,b) => a-b));
    return message;
}
export function assertLittleArcRecoveryControls(controls, records, expectedIds) {
    assert.equal(records.phase, 'orphan'); assert.equal(records.tabId, null); assert.equal(records.originWindowId, null);
    assert.equal(controls.recoveryHidden, false); assert.equal(controls.recovery.value, ''); assert.equal(controls.recoverDisabled, true);
    assert.equal(controls.window.value, ''); assert.equal(controls.space.value, ''); assert.equal(controls.promoteDisabled, true);
    const choices = controls.recovery.options.filter(option => option.value);
    assert.deepEqual(choices.map(option => Number(option.value)).sort((a,b) => a-b), [...expectedIds].sort((a,b) => a-b));
    for (const choice of choices) { assert.equal(choice.selected, false); assert(choice.text.includes(`(tab ${choice.value})`)); }
    assert(!controls.window.options.some(option => /Original window/.test(option.text)), 'Recovered records must not infer an originating window.');
}
export function assertLittleArcControlRequest(events, { action, record, tabId, arcifyId, destination }) {
    const requests = controlRequests(events); assert.equal(requests.length, 1, 'One explicit control submission, without a retry.');
    const { message, sender } = requests[0].data;
    assert.equal(sender.id, arcifyId); assert.equal(sender.tab.id, record.controllerTabId); assert.equal(sender.tab.windowId, record.windowId);
    assert.equal(sender.url, `chrome-extension://${arcifyId}/transient-window.html?token=${record.token}`);
    assert.deepEqual(message, { type: 'arcifyTransientWindow', token: record.token, action, tabId, ...(destination || {}) });
    return message;
}
export function assertLittleArcRecovered(before, after, { record, chosenId, events, arcifyId }) {
    assertLittleArcControlRequest(events, { action: 'recover', record, tabId: chosenId, arcifyId });
    const recovered = exact(after.registry.records, record.token, 'token');
    assert.deepEqual(recovered, { ...record, phase: 'ready', tabId: chosenId, recovered: true, originWindowId: null }, 'Selection can change only the explicit chosen page and recovery provenance.');
    assert.deepEqual(recovered.memberTabIds, record.memberTabIds); assert.deepEqual(ownership(after), ownership(before));
    assertLittleArcExcluded(after, record.memberTabIds); assertLittleArcNoEffects(before, after, events, { selectedToken: record.token });
    return recovered;
}
export function assertLittleArcPromoted(before, after, { record, destination, events, arcifyId }) {
    assertLittleArcControlRequest(events, { action: 'promote', record, tabId: record.tabId, arcifyId, destination });
    const committed = exact(after.registry.records, record.token, 'token'); assert.equal(committed.phase, 'committed');
    assert.equal(committed.tabId, record.tabId); assert.deepEqual(committed.target, destination);
    assert(!committed.memberTabIds.includes(record.tabId)); assert(committed.memberTabIds.includes(record.controllerTabId));
    assert.deepEqual(owner(after, record.tabId), [{ spaceId: destination.spaceId, bookmarkFolderId: destination.bookmarkFolderId, section: 'temporaryTabs' }]);
    const saved = after.savedSnapshot.filter(item => item.tabId === record.tabId); assert.equal(saved.length, 1); assert.equal(saved[0].spaceId, destination.spaceId); assert.equal(saved[0].section, 'temporaryTabs');
    for (const space of before.spaces) for (const key of ['spaceBookmarks', 'temporaryTabs']) assert.deepEqual(exact(after.spaces, space.id)[key].filter(id => id !== record.tabId), space[key]);
    assert.deepEqual(after.tabs.map(tab => tab.id), before.tabs.map(tab => tab.id)); assert.deepEqual(after.windows.map(window => window.id), before.windows.map(window => window.id));
    assertLittleArcExcluded(after, committed.memberTabIds); assertLittleArcSavedUnchanged(before, after, events);
    assertLittleArcPagesUnchanged(before, after, { movedTabId: record.tabId, destinationWindowId: destination.windowId });
    const mutations = tabMutations(events); assert.deepEqual(mutations.map(event => event.type).sort(), ['tabs.onAttached', 'tabs.onDetached']);
    assert(mutations.every(event => eventTabId(event) === record.tabId));
    assert.equal(mutations.find(event => event.type === 'tabs.onDetached').data[1].oldWindowId, record.windowId);
    assert.equal(mutations.find(event => event.type === 'tabs.onAttached').data[1].newWindowId, destination.windowId);
    const receipts = events.filter(event => event.type === 'storage' && event.data.area === 'session' && event.data.changes[SESSION_KEY]).map(event => event.data.changes[SESSION_KEY].newValue?.records.find(item => item.token === record.token)).filter(Boolean);
    assert(receipts.some(item => item.phase === 'moving'), 'A real moving journal must precede native movement.');
    const firstMove = events.findIndex(event => event.type === 'tabs.onDetached');
    assert(events.slice(0, firstMove).some(event => event.type === 'storage' && event.data.changes[SESSION_KEY]?.newValue?.records.some(item => item.token === record.token && item.phase === 'moving')));
    assert.equal(receipts.at(-1)?.phase, 'committed'); return committed;
}
export function assertLittleArcReload(evidence, arcifyId) {
    assert.equal(evidence?.name, 'arcify'); const url = `chrome-extension://${arcifyId}/background.js`;
    const before = evidence.observations.find(item => item.phase === 'before-reload')?.target;
    const released = evidence.observations.find(item => item.phase === 'observers-released');
    const observed = evidence.observations.find(item => item.phase === 'reload-observed');
    assert.equal(before?.type, 'service_worker'); assert.equal(before?.url, url); assert(before.targetId);
    assert.equal(released?.target.targetId, before.targetId); assert.equal(released.originalViewValid, true);
    assert.equal(observed?.oldTargetId, before.targetId); assert.equal(observed.viewInvalidated, true);
    assert(!observed.targets.some(target => target.targetId === before.targetId));
    assert(evidence.view.closed || evidence.view.invalidations.length > 0);
    assert.equal(evidence.replacement.type, 'service_worker'); assert.equal(evidence.replacement.url, url); assert.notEqual(evidence.replacement.targetId, before.targetId);
    assert.equal(evidence.identity.id, arcifyId); assert.equal(evidence.identity.globalType, 'ServiceWorkerGlobalScope'); return evidence;
}

/** Bind only the two previously captured targets; never expand candidates or select by URL. */
export async function attachLittleArcControllerTargets({ targets, controllerTabId, poll, observePage }) {
    assert.equal(targets.length, 2); assert.equal(new Set(targets).size, 2);
    assert(Number.isSafeInteger(controllerTabId) && controllerTabId > 0);
    const captured = [...targets];
    const match = await poll(async () => {
        const matches = [];
        for (const target of captured) {
            const page = await target.page(); let native;
            try { native = await page.evaluate(async () => typeof chrome !== 'undefined' && chrome.tabs?.getCurrent ? await chrome.tabs.getCurrent() : null); }
            catch (error) {
                if (/Execution context was destroyed|Cannot find context with specified id/.test(error.message)) continue;
                throw error;
            }
            if (native?.id === controllerTabId) matches.push({ target, page });
            else assert(native === null, 'An unexpected native tab ID cannot stand in for the controller or web page.');
        }
        assert(matches.length <= 1, 'The controller native ID must identify exactly one captured target.');
        return matches[0] || null;
    }, Boolean, 'exact controller native ID after its real navigation completes');
    assert(captured.includes(match.target));
    const remaining = captured.filter(target => target !== match.target); assert.equal(remaining.length, 1);
    return { controller: await observePage(match.page), controllerTarget: match.target, pageTarget: remaining[0] };
}

export async function readLittleArcRawState() {
        const local = await chrome.storage.local.get(['spaces', 'spaceTabSnapshot', 'pinnedTabStatesById', 'persistentFavorites', 'archivedTabs']);
        const session = await chrome.storage.session.get(['activeSpaces', 'favoriteSession', 'transientWindowSession', 'spotlightBridgeRequests']);
        return { tabs: (await chrome.tabs.query({})).map(({ id, windowId, index, url, pendingUrl, pinned, incognito, active, groupId, splitViewId }) => ({ id, windowId, index, url, pendingUrl: pendingUrl || null, pinned, incognito, active, groupId, splitViewId: splitViewId ?? -1 })).sort((a,b) => a.id-b.id),
            windows: (await chrome.windows.getAll()).map(({ id, type, incognito, focused, width, height }) => ({ id, type, incognito, focused, width, height })).sort((a,b) => a.id-b.id),
            groups: (await chrome.tabGroups.query({})).sort((a,b) => a.id-b.id), spaces: local.spaces || [], savedSnapshot: local.spaceTabSnapshot || [], bindings: local.pinnedTabStatesById || {}, favorites: local.persistentFavorites || [], archivedTabs: local.archivedTabs || [],
            sessionPresence: { registry: Object.hasOwn(session, 'transientWindowSession'), journal: Object.hasOwn(session, 'spotlightBridgeRequests') },
            journal: Object.hasOwn(session, 'spotlightBridgeRequests') ? session.spotlightBridgeRequests : [], favoriteSession: session.favoriteSession || null, activeSpaces: session.activeSpaces || {}, registry: Object.hasOwn(session, 'transientWindowSession') ? session.transientWindowSession : { version: 1, records: [] }, bookmarks: await chrome.bookmarks.getTree() };
}

/** No positive transport adapter: open, recover and promote originate only in genuine visible UI. */
export async function exerciseLittleArc({ browser, observePage, apiPage, spotlightOptions, ui, screenshot, snapshot, external, poll, fixture, arcifyId, spotlightId, search, reloadArcify, record = async () => {} }) {
    assertLittleArcEnvironment();
    for (const adapter of [observePage, ui, screenshot, snapshot, external, poll, search, reloadArcify, record]) assert.equal(typeof adapter, 'function');
    const nonce = randomBytes(16).toString('hex'), originWindowId = fixture.windowA, targetWindowId = fixture.windowB;
    const ownedTabs = new Set(), ownedWindows = new Set(), pages = new Map();
    const evidence = { nonce, nativeUnverified: LITTLE_ARC_NATIVE_UNVERIFIED.map(name => ({ name, status: 'not-run', nativeValidated: false, reason: 'Full extension reload removes the controller. An intact restored controller requires separate native acceptance.' })), checkpoints: [], setup: [], cleanup: [], openDiagnostics: [], realTrustedInput: true, scope: 'Source acceptance for the disposable hosted Chrome profile only',
        limits: ['Browser restart with missing controller or cross-window restored pages remains a release blocker.', 'Real extension reload tests missing-controller ordinary adoption only, not intact-controller recovery. Full browser restore, login state, back/forward, drag-out/replacement and journal-boundary interruption remain separate acceptance work.', 'No OS link handling, user profile, Helium or deployment acceptance is claimed.'] };
    let primaryError, source, overlayPage, reloadObserverBefore, reloadOnboarding;
    const checkpoint = async (phase, data = {}) => { evidence.checkpoints.push({ phase, ...data }); await record(structuredClone(evidence)); };
    const setup = async (label, action) => { const result = await action(); evidence.setup.push({ label, result }); await record(structuredClone(evidence)); return result; };
    const local = async message => { const result = await apiPage.evaluate(message => chrome.runtime.sendMessage({ type: 'spaceStore', ...message }), message); assert.equal(result.success, true, JSON.stringify(result)); return result; };
    const settle = () => local({ action: 'get' });
    const raw = () => apiPage.evaluate(readLittleArcRawState);
    const read = async () => { await settle(); const state = await raw(); state.pageStates = Object.fromEntries(await Promise.all([...pages].map(async ([id,page]) => [id, await page.evaluate(readLittleArcPage)]))); state.snapshots = { [originWindowId]: await snapshot(originWindowId), [targetWindowId]: await snapshot(targetWindowId) }; return state; };
    const original = await raw(), oldApiTab = await apiPage.evaluate(() => chrome.tabs.getCurrent());
    const reset = () => apiPage.evaluate(() => { globalThis.__spaceActionObservation.events.length = 0; });
    const trace = () => apiPage.evaluate(() => globalThis.__spaceActionObservation.events);
    const writeDraft = async (id, page, label) => {
        await ui(page, `Type unsaved ${label} form state`, async () => {
            const input = await page.$('#little-arc-draft'); assert(input); try { await replaceInputText(page, input, `Unsubmitted ${label} ${nonce}`); } finally { await input.dispose(); }
            const notes = await page.$('#little-arc-notes'); assert(notes); try { await replaceInputText(page, notes, `Unsaved notes ${label} for native tab ${id} ${nonce}`); } finally { await notes.dispose(); }
            await page.click('#little-arc-check');
        });
        await page.evaluate(installLittleArcDocumentObservation);
        const draft = await page.evaluate(readLittleArcPage); assertLittleArcDraft(draft, { label, nonce, tabId: id });
        for (const [otherId, other] of pages) if (otherId !== id) assert.notEqual((await other.evaluate(readLittleArcPage)).documentId, draft.documentId, 'Every fixture document needs its independent server nonce.');
        pages.set(id, page); await setup('Observed exact trusted unsaved fixture form values', async () => ({ tabId: id, draft }));
    };
    const selectExact = async (page, selector, value) => {
        const options = await page.$$eval(`${selector} option`, nodes => nodes.map(node => ({ value: node.value, disabled: node.disabled })));
        const index = options.findIndex(option => option.value === String(value)); assert(index >= 0 && !options[index].disabled);
        const handle = await page.$(selector); assert(handle);
        try { await handle.focus(); await handle.press('Home'); for (let i = 0; i < index; i++) await handle.press('ArrowDown'); await handle.press('Tab'); }
        finally { await handle.dispose(); }
        assert.equal(await page.$eval(selector, node => node.value), String(value));
    };
    const closeOverlay = async () => {
        if (!overlayPage || overlayPage.isClosed() || !await overlayPage.evaluate(() => Boolean(document.getElementById('arcify-spotlight-host')))) return;
        await ui(overlayPage, 'Dismiss remaining Spotlight overlay', async () => { const surface = await spotlightSurface(overlayPage), input = await surface.$('[data-testid="spotlight-input"]'); try { await input.press('Escape'); } finally { await input.dispose(); } });
        await overlayPage.waitForFunction(() => !document.getElementById('arcify-spotlight-host'), { polling: 50 });
    };
    const prepareLaunch = async explicit => {
        await closeOverlay(); await setup('Activate the exact ordinary source before Spotlight launch', async () => {
            await apiPage.evaluate(async id => { const tab = await chrome.tabs.update(id, { active: true }); await chrome.windows.update(tab.windowId, { focused: true }); }, source.tab.id);
            return local({ action: 'activate', windowId: originWindowId, spaceId: fixture.spaces.work });
        });
        overlayPage = source.page;
        const opened = await external(apiPage, spotlightId, 'launch', { windowId: originWindowId, mode: 'new-tab' }); assert.equal(opened?.ok, true);
        await source.page.waitForFunction(() => document.getElementById('arcify-spotlight-host')?.shadowRoot?.querySelector('dialog')?.open, { polling: 50 });
        const surface = await spotlightSurface(source.page); assert.notEqual(surface, source.page);
        const url = `${fixture.base}/little-arc/${nonce}/duplicate`;
        await search(source.page, `${explicit ? 'little arc ' : ''}${url}`);
        const rows = await poll(() => surface.evaluate(readSpotlightRows), rows => rows.some(row => row.type === LITTLE_ARC_TYPE && row.title === LITTLE_ARC_TITLE), 'actual paired Little Arc URL choice');
        if (explicit) { assert.equal(rows[0].type, LITTLE_ARC_TYPE); assert.equal(rows[0].selected, true); }
        else { assert.notEqual(rows[0].type, LITTLE_ARC_TYPE); assert(rows.findIndex(row => row.type === LITTLE_ARC_TYPE) > 0, 'Bare URL keeps ordinary navigation first.'); }
        return { surface, rows, url };
    };
    const launch = async (explicit, method) => {
        const prepared = await prepareLaunch(explicit), beforeTargets = new Set(browser.targets());
        return withLittleArcOpenDiagnostics({ browser, arcifyId, record: async observation => {
            evidence.openDiagnostics.push({ explicit, method, ...observation });
            await record(structuredClone(evidence));
        } }, async () => {
        let before;
        await ui(source.page, `Open exact HTTP link in Little Arc with ${method}`, async () => {
            before = await read(); await prepared.surface.evaluate(installLittleArcInputObservation, { retainInParent: true }); await reset();
            if (method === 'Enter') { const input = await prepared.surface.$('[data-testid="spotlight-input"]'); try { await input.press('Enter'); } finally { await input.dispose(); } }
            else await clickFreshResult(async timeout => { await prepared.surface.waitForSelector(`[data-result-type="${LITTLE_ARC_TYPE}"]`, { visible: true, timeout }); return prepared.surface.$(`[data-result-type="${LITTLE_ARC_TYPE}"]`); });
        });
        // Claim only exact IDs in the single new, witnessed controller receipt.
        // Unexpected concurrent tabs remain unowned and must survive failure cleanup.
        const state = await poll(async () => {
            const value = await raw();
            const requests = (await trace()).filter(event => event.type === 'external' && event.data.message.command === 'openTransient');
            assert(requests.length <= 1, 'Ambiguous launches cannot grant cleanup ownership.');
            if (requests.length === 1) {
                assert.equal(requests[0].data.sender.id, spotlightId); assert.equal(requests[0].data.message.url, prepared.url);
                assert.equal(requests[0].data.message.windowId, originWindowId);
                const claim = collectLittleArcOwnedIds(before, value, { arcifyId, originWindowId, request: requests[0].data.message, spotlightId });
                for (const id of claim.tabIds) ownedTabs.add(id);
                for (const id of claim.windowIds) ownedWindows.add(id);
            }
            return value;
        }, state => state.registry.records.filter(item => !before.registry.records.some(old => old.token === item.token) && item.phase === 'ready').length === 1, 'one real ready transient registry receipt');
        const record = state.registry.records.find(item => !before.registry.records.some(old => old.token === item.token));
        assert(record); assert(ownedTabs.has(record.tabId) && ownedTabs.has(record.controllerTabId)); assert(ownedWindows.has(record.windowId));
        const fresh = await poll(() => browser.targets().filter(target => target.type() === 'page' && !beforeTargets.has(target)), targets => targets.length === 2, 'the exactly two fresh native page targets');
        assert.equal(fresh.length, 2);
        const { controller, pageTarget } = await attachLittleArcControllerTargets({ targets: fresh, controllerTabId: record.controllerTabId, poll, observePage });
        const page = await observePage(await pageTarget.page());
        await poll(() => apiPage.evaluate(id => chrome.tabs.get(id), record.tabId), tab => tab.status === 'complete' && tab.url === prepared.url && !tab.pendingUrl, 'the exact registry page has loaded');
        await page.waitForSelector('#little-arc-draft'); await page.evaluate(installLittleArcDocumentObservation); pages.set(record.tabId, page);
        assert.equal(page.url(), prepared.url, 'URL verifies navigation only after native identity and fresh-target cardinality were proved.');
        const client = await poll(() => source.page.evaluate(() => ({ statuses: globalThis.__littleArcStatusEvents,
            hostPresent: Boolean(document.getElementById('arcify-spotlight-host')) })), value => {
            assert(!value.statuses.some(status => status.state === 'error'), 'A real Little Arc client error is never success, even if its native page exists.');
            return !value.hostPresent || value.statuses.some(status => status.state === 'connected' && status.text === 'Opened in Little Arc. Choose a Space there when you’re ready.');
        }, 'actual client success or observed retirement of the original overlay');
        client.delivery = client.statuses.some(status => status.text === 'Opened in Little Arc. Choose a Space there when you’re ready.') ? 'observed-success' : 'unobserved-after-overlay-retirement';
        if (client.delivery !== 'observed-success') evidence.limits.push('This launch retired the original overlay before a client success status was observed. The exact persisted bridge response proves backend completion; client delivery is not claimed.');
        await poll(async () => {
            const state = await raw(), requests = (await trace()).filter(event => event.type === 'external' && event.data.message.command === 'openTransient');
            assert.equal(requests.length, 1); const entries = state.journal.filter(entry => entry.fingerprint === JSON.stringify(requests[0].data.message));
            assert(entries.length <= 1); if (entries[0]?.response) assertLittleArcBridgeReceipt(state, requests[0].data.message, record, spotlightId);
            return Boolean(entries[0]?.response);
        }, Boolean, 'the exact durable successful bridge response, not merely a ready native registry');
        const after = await read(), events = await trace(), input = await source.page.evaluate(() => globalThis.__littleArcInputEvents);
        assertLittleArcTrustedInput(input, { action: 'open', method }); assertLittleArcLaunch(before, after, { record, events, spotlightId, originWindowId, url: prepared.url });
        assert.equal(after.pageStates[record.tabId].topLevel, true); assert.equal(after.pageStates[record.tabId].frameCount, 0);
        await checkpoint('trusted-little-arc-launch', { explicit, method, before, after, record, rows: prepared.rows, events, input, client, screenshot: await screenshot(page, `Little Arc exact top-level ${method} page`) });
        await closeOverlay(); await writeDraft(record.tabId, page, method);
        return { record, page, controller };
        });
    };
    const refreshController = async controller => { await ui(controller, 'Refresh exact Little Arc choices', () => controller.click('#refresh')); await poll(() => controller.evaluate(readLittleArcControls), state => state.recoveryHidden ? !state.window.disabled : !state.recovery.disabled, 'refreshed live control choices'); };
    const promote = async (flow, destination) => {
        let before, controlsBefore;
        await ui(flow.controller, 'Explicitly transfer the selected same native page into a Space', async () => {
            before = await read(); controlsBefore = await flow.controller.evaluate(readLittleArcControls);
            await flow.controller.evaluate(installLittleArcInputObservation); await reset();
            await selectExact(flow.controller, '#destination-window', '');
            await selectExact(flow.controller, '#destination-window', destination.windowId); await selectExact(flow.controller, '#destination-space', destination.spaceId);
            await flow.controller.click('#promote');
            await flow.controller.waitForFunction(() => document.getElementById('status').textContent.startsWith('Moved into '), { polling: 50 });
        });
        const after = await read(), events = await trace(), input = await flow.controller.evaluate(() => globalThis.__littleArcInputEvents), controlsAfter = await flow.controller.evaluate(readLittleArcControls);
        assertLittleArcTrustedInput(input, { action: 'promote', destination });
        const committed = assertLittleArcPromoted(before, after, { record: flow.record, destination, events, arcifyId });
        assert.equal(controlsAfter.timeOrigin, controlsBefore.timeOrigin); assert.equal(controlsAfter.url, controlsBefore.url); assert.equal(flow.controller.isClosed(), false);
        await checkpoint('same-native-page-promoted', { before, after, events, input, committed, controlsBefore, controlsAfter, screenshot: await screenshot(flow.page, 'Same transferred page with unsaved form state') });
        return committed;
    };
    try {
        await apiPage.evaluate(installSpotlightActionApiObservation); await apiPage.evaluate(installLittleArcGroupObservation);
        source = await createNavigationFixturePage({ browser, apiPage, observePage, poll, windowId: originWindowId, url: `${fixture.base}/little-arc/${nonce}/source` });
        ownedTabs.add(source.tab.id); await setup('Assign only the ordinary source fixture to Today', () => local({ action: 'assign', tabId: source.tab.id, spaceId: fixture.spaces.work, pinned: false, newTodayTab: true }));
        await writeDraft(source.tab.id, source.page, 'ordinary source');
        // Cancel the real visible Spotlight choice before any launch.
        const cancel = await prepareLaunch(true); let cancelBefore;
        await ui(source.page, 'Cancel Little Arc launch with trusted Escape', async () => {
            cancelBefore = await read(); await cancel.surface.evaluate(installLittleArcInputObservation, { retainInParent: true }); await reset();
            const input = await cancel.surface.$('[data-testid="spotlight-input"]'); try { await input.press('Escape'); } finally { await input.dispose(); }
        });
        await source.page.waitForFunction(() => !document.getElementById('arcify-spotlight-host'), { polling: 50 });
        const cancelled = await read(), cancelEvents = await trace(), cancelInput = await source.page.evaluate(() => globalThis.__littleArcInputEvents);
        assertLittleArcNoEffects(cancelBefore, cancelled, cancelEvents);
        assert.deepEqual(cancelled.registry, cancelBefore.registry); assert.deepEqual(ownership(cancelled), ownership(cancelBefore)); assert.deepEqual(tabMutations(cancelEvents), []);
        assert(!cancelEvents.some(event => event.type === 'external' && event.data.message.command === 'openTransient'));
        assert.equal(cancelInput.filter(event => event.type === 'keydown' && event.key === 'Escape' && event.trusted).length, 1);
        await checkpoint('spotlight-cancel-no-launch', { before: cancelBefore, after: cancelled, events: cancelEvents, input: cancelInput });

        const first = await launch(false, 'click'); await refreshController(first.controller);
        const target = exact((await read()).spaces, fixture.spaces.work);
        const initialControls = await first.controller.evaluate(readLittleArcControls);
        assert.equal(initialControls.window.value, String(originWindowId)); assert.equal(initialControls.space.value, ''); assert.equal(initialControls.promoteDisabled, true);
        await promote(first, { windowId: originWindowId, spaceId: target.id, bookmarkFolderId: target.bookmarkFolderId });
        // Retire only this completed fixture's controller before the separate reload scenario.
        await setup('Close the first completed fixture controller by its exact ID', () => apiPage.evaluate(id => chrome.tabs.remove(id), first.record.controllerTabId));
        ownedTabs.delete(first.record.controllerTabId); ownedWindows.delete(first.record.windowId);

        const reloadFlow = await launch(true, 'Enter');
        const twin = await createNavigationFixturePage({ browser, apiPage, observePage, poll, windowId: reloadFlow.record.windowId, url: reloadFlow.page.url() });
        ownedTabs.add(twin.tab.id); await writeDraft(twin.tab.id, twin.page, 'same-address ordinary survivor');
        await setup('Keep two independently created same-address native pages across full extension reload', async () => ({ ids: [reloadFlow.record.tabId, twin.tab.id], windowId: reloadFlow.record.windowId }));
        const beforeReload = await read(); assertLittleArcExcluded(beforeReload, [reloadFlow.record.controllerTabId, reloadFlow.record.tabId, twin.tab.id]);
        const settings = await apiPage.evaluate(async () => ({ ...(await chrome.storage.sync.get('onboardingVersion')), version: chrome.runtime.getManifest().version }));
        const oldReloadApiTab = await apiPage.evaluate(() => chrome.tabs.getCurrent());
        await spotlightOptions.evaluate(installLittleArcReloadObservation, { nonce });
        reloadObserverBefore = await spotlightOptions.evaluate(readLittleArcReloadObservation);
        assertLittleArcReloadObservation(reloadObserverBefore, reloadObserverBefore, spotlightId);
        evidence.reloadBoundary = { before: beforeReload, observerBefore: reloadObserverBefore, settings };
        await record(structuredClone(evidence));
        // Exactly one real full extension reload. Chrome closes extension tabs;
        // do not reload/recreate a controller or substitute a worker restart.
        const reloaded = await reloadArcify(); assertLittleArcReload(reloaded.evidence, arcifyId); assert(reloaded.apiPage); apiPage = reloaded.apiPage;
        await apiPage.evaluate(installSpotlightActionApiObservation); await apiPage.evaluate(installLittleArcGroupObservation);
        const newApiTab = await apiPage.evaluate(() => chrome.tabs.getCurrent());
        let afterReload = await poll(read, state => [reloadFlow.record.tabId, twin.tab.id].every(id => owner(state, id).length === 1), 'both surviving exact native IDs have ordinary Space ownership');
        afterReload.snapshots[reloadFlow.record.windowId] = await snapshot(reloadFlow.record.windowId);
        const observerAfter = await poll(() => spotlightOptions.evaluate(readLittleArcReloadObservation), value => {
            const observed = assertLittleArcReloadObservation(reloadObserverBefore, value, spotlightId);
            if (settings.onboardingVersion === settings.version) return true;
            const created = observed.filter(event => event.type === 'tabs.onCreated'
                && (event.data[0].pendingUrl || event.data[0].url) === `chrome-extension://${arcifyId}/installation-onboarding.html`);
            assert(created.length <= 1, 'Duplicate onboarding creations are not cleanup authority.');
            return created.length === 1;
        }, 'the expected onboarding creation within the continuously observed reload');
        const nativeEvents = assertLittleArcReloadObservation(reloadObserverBefore, observerAfter, spotlightId);
        Object.assign(evidence.reloadBoundary, { after: afterReload, observerAfter, nativeEvents, reload: reloaded.evidence });
        await record(structuredClone(evidence));
        let onboardingId = null;
        if (settings.onboardingVersion !== settings.version) {
            const onboardingUrl = `chrome-extension://${arcifyId}/installation-onboarding.html`;
            const created = nativeEvents.filter(event => event.type === 'tabs.onCreated' && (event.data[0].pendingUrl || event.data[0].url) === onboardingUrl);
            assert.equal(created.length, 1, 'Require the exact reload-created onboarding event, never a URL-only cleanup guess.');
            const id = created[0].data[0].id;
            const match = await poll(async () => {
                const matches = [];
                for (const target of browser.targets().filter(target => target.type() === 'page' && target.url() === onboardingUrl)) {
                    const page = await target.page(); let witness;
                    try { witness = await page.evaluate(readLittleArcReloadDocument); }
                    catch (error) { if (/Execution context was destroyed|Cannot find context with specified id/.test(error.message)) continue; throw error; }
                    if (!witness) continue;
                    assert.equal(witness.tab.id, id, 'A same-address onboarding tab cannot replace the observed native ID.');
                    if (witness.readyState !== 'complete') continue;
                    assertLittleArcReloadDocument(witness, { id, windowId: oldReloadApiTab.windowId, url: onboardingUrl, extensionId: arcifyId });
                    matches.push({ page, witness });
                }
                assert(matches.length <= 1); return matches[0] || null;
            }, Boolean, 'the exact observed onboarding tab and its actual extension document');
            afterReload = await read(); afterReload.snapshots[reloadFlow.record.windowId] = await snapshot(reloadFlow.record.windowId);
            const receipt = claimLittleArcReloadOnboarding({ before: beforeReload, after: afterReload, events: nativeEvents, settings,
                witness: match.witness, arcifyId, windowId: oldReloadApiTab.windowId });
            reloadOnboarding = { page: match.page, receipt }; onboardingId = receipt.id;
            evidence.reloadBoundary.onboarding = receipt;
        }
        // Read every page/ownership witness again after onboarding document validation.
        afterReload = await read(); afterReload.snapshots[reloadFlow.record.windowId] = await snapshot(reloadFlow.record.windowId);
        // Capture through final identity validation too; an intervening event cannot be hidden.
        const finalObserver = await spotlightOptions.evaluate(readLittleArcReloadObservation);
        const finalEvents = assertLittleArcReloadObservation(reloadObserverBefore, finalObserver, spotlightId);
        Object.assign(evidence.reloadBoundary, { after: afterReload, observerAfter: finalObserver, nativeEvents: finalEvents });
        const result = assertLittleArcMissingControllerReload(beforeReload, afterReload, { record: reloadFlow.record, twinId: twin.tab.id,
            oldApiTabId: oldReloadApiTab.id, newApiTabId: newApiTab.id, onboardingId, arcifyId, windowB: targetWindowId, events: finalEvents });
        assertLittleArcSavedUnchanged(beforeReload, afterReload, finalEvents);
        await checkpoint('real-reload-missing-controller-ordinary-survivors', { before: beforeReload, after: afterReload, result,
            observerBefore: reloadObserverBefore, observerAfter: finalObserver, nativeEvents: finalEvents, reload: reloaded.evidence,
            onboarding: reloadOnboarding?.receipt || null, screenshot: await screenshot(twin.page, 'Same native HTTP page and unsaved form after controller removal') });
    } catch (error) { primaryError = error; if (reloadObserverBefore) { evidence.reloadBoundary ||= {}; try { evidence.reloadBoundary.observerAtFailure = await spotlightOptions.evaluate(readLittleArcReloadObservation); } catch (capture) { evidence.reloadBoundary.observerCaptureError = capture.message; } } try { await checkpoint('failed', { error: { message: error.message, stack: error.stack }, ownedTabIds: [...ownedTabs], ownedWindowIds: [...ownedWindows] }); } catch {} throw error; }
    finally {
        await finishBookmarkFixture([
            closeOverlay,
            async () => {
                if (!reloadOnboarding) return;
                const { page, receipt } = reloadOnboarding;
                assertLittleArcReloadOnboardingUnchanged(await page.evaluate(readLittleArcReloadDocument), receipt);
                await apiPage.evaluate(async receipt => {
                    const tab = await chrome.tabs.get(receipt.id);
                    const contexts = await chrome.runtime.getContexts({ contextTypes: ['TAB'], tabIds: [receipt.id] });
                    if (chrome.runtime.id !== receipt.extensionId || tab.id !== receipt.id || tab.windowId !== receipt.windowId || tab.url !== receipt.url || tab.pendingUrl
                        || tab.pinned !== false || tab.incognito !== false || (tab.splitViewId ?? -1) !== -1 || (tab.groupId ?? -1) !== -1
                        || contexts.length !== 1 || contexts[0].documentId !== receipt.documentIds[0]) throw new Error('Reload onboarding identity changed before exact cleanup.');
                    await chrome.tabs.remove(receipt.id);
                }, receipt);
                evidence.cleanup.push({ removedReloadOnboardingTabId: receipt.id, receipt });
            },
            async () => { const alive = await apiPage.evaluate(() => chrome.tabs.query({})); const ids = [...ownedTabs].filter(id => alive.some(tab => tab.id === id)); if (ids.length) await apiPage.evaluate(ids => chrome.tabs.remove(ids), ids); evidence.cleanup.push({ removedExactTabIds: ids }); pages.clear(); },
            async () => { const alive = await apiPage.evaluate(() => chrome.windows.getAll()); for (const id of ownedWindows) if (alive.some(window => window.id === id)) { const tabs = await apiPage.evaluate(id => chrome.tabs.query({ windowId: id }), id); assert(tabs.every(tab => ownedTabs.has(tab.id)), 'Never remove an untracked page during fixture cleanup.'); await apiPage.evaluate(id => chrome.windows.remove(id), id); evidence.cleanup.push({ removedExactWindowId: id }); } },
            async () => { const alive = await apiPage.evaluate(() => chrome.tabs.query({})); for (const tab of original.tabs.filter(tab => tab.active && alive.some(current => current.id === tab.id))) await apiPage.evaluate(id => chrome.tabs.update(id, { active: true }), tab.id); for (const [id, spaceId] of Object.entries(original.activeSpaces)) await local({ action: 'activate', windowId: Number(id), spaceId }); const focused = original.windows.find(window => window.focused); if (focused && (await apiPage.evaluate(() => chrome.windows.getAll())).some(window => window.id === focused.id)) await apiPage.evaluate(id => chrome.windows.update(id, { focused: true }), focused.id); await settle(); },
            async () => { const final = await raw(), currentApiTab = await apiPage.evaluate(() => chrome.tabs.getCurrent()); const expected = original.tabs.filter(tab => tab.id !== oldApiTab.id).map(tab => tab.id).concat(currentApiTab.id).sort((a,b) => a-b); assert.deepEqual(final.tabs.map(tab => tab.id), expected, 'Only the real reload may replace the harness options tab; no fixture page may leak.'); assertLittleArcSavedUnchanged(original, final); evidence.cleanup.push({ verified: true, currentApiTabId: currentApiTab.id, finalTabIds: final.tabs.map(tab => tab.id) }); await record(structuredClone(evidence)); },
            () => apiPage.evaluate(() => { globalThis.__littleArcGroupObservation?.stop(); globalThis.__spaceActionObservation?.stop(); }),
            () => spotlightOptions.evaluate(stopLittleArcReloadObservation)
        ], primaryError, async failure => { evidence.cleanup.push(failure); await record(structuredClone(evidence)); });
    }
    return evidence;
}
