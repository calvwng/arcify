/** Import-safe Archive acceptance. Only the sandboxed hosted runner owns Chrome. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { spotlightSurface } from './paired-chrome-keyboard.mjs';
import { clickFreshResult, replaceInputText, selectResultWithKeyboard } from './paired-chrome-ui.mjs';
import { readSpotlightRows, assertMatchedActionFirst, evaluateWithoutGesture, revealNativeSidebarSpace, readNativeSidebarRender } from './paired-chrome-sidebar.mjs';
import { createNavigationFixturePage } from './paired-chrome-spotlight-navigation.mjs';
import { canonicalSavedMoveBookmarks } from './paired-chrome-saved-move.mjs';
import { finishBookmarkFixture } from './paired-chrome-bookmark-selection.mjs';
import { assertSpotlightActionEnvironment, installSpotlightActionApiObservation, readSpotlightActionPage } from './paired-chrome-spotlight-actions.mjs';

export const SPOTLIGHT_ARCHIVE_OPEN_CASE_NAME = 'Spotlight Open Archive requires trusted input and the existing popup in the native Side Panel';
export const SPOTLIGHT_ARCHIVE_REOPEN_CASE_NAME = 'Spotlight Archive reopens exact same-address entries in their original Space and source window without replay';
export const ARCHIVE_FEATURES = Object.freeze(['globalFavoritesV1', 'archiveActionsV1']);
export const ARCHIVE_OPEN_TITLE = 'Open Archive';
export const ARCHIVE_OPEN_TYPE = 'arcify-archive-action';
export const ARCHIVE_ENTRY_TYPE = 'arcify-archive-action';
const OPEN_QUERY = 'open archive';
const exact = (items, id, key = 'id') => { const found = items.filter(item => item[key] === id); assert.equal(found.length, 1, `Require exact unique ${key} ${id}.`); return found[0]; };
const changedStorage = events => events.filter(event => event.type === 'storage' && Object.values(event.data.changes).some(value => !isDeepStrictEqual(value.oldValue, value.newValue)));
const mutationEvents = events => events.filter(event => event.type.startsWith('bookmarks.') || /^tabs\.(?:onCreated|onRemoved|onReplaced|onAttached|onDetached|onMoved|onActivated)$/.test(event.type)
    || event.type === 'tabs.onUpdated' && ['url', 'pendingUrl', 'pinned', 'groupId', 'mutedInfo', 'discarded'].some(key => key in event.data.change));

export function serveSpotlightArchiveFixture(request, response) {
    const match = /^\/spotlight-archive\/([a-f0-9]{32})\/([a-z-]+)$/.exec(new URL(request.url, 'http://127.0.0.1').pathname);
    if (!match) return false;
    const title = `Spotlight Archive ${match[2]} ${match[1]}`;
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-src 'none'" });
    response.end(`<!doctype html><html><head><title>${title}</title><link rel="icon" href="data:,"></head><body data-document-id="${randomBytes(16).toString('hex')}"><h1>${title}</h1><input id="action-page-state" value="retained"></body></html>`);
    return true;
}

/** Observe the existing worker endpoint; never connect, respond, wrap or grant authority. */
export function installArchiveIntentObservation(observerId) {
    globalThis.__archiveIntentStop?.();
    const observation = { observerId, extensionId: chrome.runtime.id, workerUrl: location.href, events: [] };
    const removals = new Set(); let serial = 0;
    const record = (type, data) => { observation.events.push({ type, data: structuredClone(data) }); };
    const listener = port => {
        if (port.name !== 'arcify-archive-display-v1') return;
        const portId = `${observerId}:${++serial}`, sender = port.sender || {};
        record('archive.port-connect', { portId, name: port.name, sender: {
            id: sender.id || null, url: sender.url || null, origin: sender.origin || null,
            documentId: sender.documentId || null, frameId: sender.frameId ?? null,
            documentLifecycle: sender.documentLifecycle || null, tab: sender.tab || null
        } });
        const message = value => record('archive.port-message', { portId, message: value });
        const remove = () => { port.onMessage.removeListener(message); port.onDisconnect.removeListener(disconnect); removals.delete(remove); };
        const disconnect = () => { record('archive.port-disconnect', { portId }); remove(); };
        port.onMessage.addListener(message); port.onDisconnect.addListener(disconnect); removals.add(remove);
    };
    chrome.runtime.onConnect.addListener(listener);
    globalThis.__archiveDisplayObservation = observation;
    globalThis.__archiveIntentStop = () => {
        chrome.runtime.onConnect.removeListener(listener);
        for (const remove of [...removals]) remove();
        delete globalThis.__archiveDisplayObservation;
        delete globalThis.__archiveIntentStop;
    };
    return { observerId, extensionId: observation.extensionId, workerUrl: observation.workerUrl };
}
export function readArchiveIntentObservation(observerId) {
    const observation = globalThis.__archiveDisplayObservation;
    if (!observation || observation.observerId !== observerId) throw new Error('The original Archive worker observation was lost.');
    return observation;
}
/** Retain one real worker; a restart cannot silently replace its evidence. */
export async function observeArchiveDisplayWorker({ browser, arcifyId, observerId }) {
    const workerUrl = `chrome-extension://${arcifyId}/background.js`;
    const targets = browser.targets().filter(target => target.type() === 'service_worker' && target.url() === workerUrl);
    assert.equal(targets.length, 1, 'Archive observation requires exactly one existing real background worker.');
    const target = targets[0], worker = await target.worker(); assert(worker);
    const identity = await worker.evaluate(installArchiveIntentObservation, observerId);
    assert.deepEqual(identity, { observerId, extensionId: arcifyId, workerUrl });
    return {
        async read() {
            assert(browser.targets().includes(target), 'The original Archive worker retired; replacement observations cannot prove this attempt.');
            const observation = await worker.evaluate(readArchiveIntentObservation, observerId);
            assert.equal(observation.observerId, observerId); assert.equal(observation.extensionId, arcifyId); assert.equal(observation.workerUrl, workerUrl);
            return observation;
        },
        async stop() {
            // Retirement already destroys the listener. Never wake or attach to a
            // replacement worker merely to remove a dead observer.
            if (!browser.targets().includes(target)) return { retired: true };
            return worker.evaluate(observerId => {
                if (globalThis.__archiveDisplayObservation?.observerId !== observerId) throw new Error('Archive observer ownership changed.');
                globalThis.__archiveIntentStop(); return { stopped: true };
            }, observerId);
        }
    };
}
export function assertArchiveNativeAck(events, request, native, { arcifyId, windowId }) {
    const acknowledgements = events.filter(event => event.type === 'archive.port-message' && event.data.message?.action === 'ack' && event.data.message.token === request.token);
    assert.equal(acknowledgements.length, 1, 'Exactly one genuine internal Port ACK must match this one-use opening token.');
    const acknowledgement = acknowledgements[0], { portId, message } = acknowledgement.data;
    assert.equal(typeof message.session, 'string'); assert(message.session);
    assert.equal(typeof message.requestId, 'string'); assert(message.requestId);
    assert.deepEqual(message, { type: 'arcifyArchiveDisplay', action: 'ack', requestId: message.requestId,
        session: message.session, windowId, token: request.token, displayed: true });
    const connections = events.filter(event => event.type === 'archive.port-connect' && event.data.portId === portId);
    assert.equal(connections.length, 1, 'The ACK must come from one observed physical Port.');
    const connection = connections[0], { sender, name } = connection.data;
    assert.equal(name, 'arcify-archive-display-v1'); assert.equal(sender.id, arcifyId);
    assert.equal(sender.url, `chrome-extension://${arcifyId}/sidebar.html`);
    assert.equal(sender.origin, `chrome-extension://${arcifyId}`); assert.equal(sender.tab, null);
    assert(sender.frameId == null || sender.frameId === 0);
    assert(sender.documentLifecycle == null || sender.documentLifecycle === 'active');
    const preceding = events.slice(events.indexOf(connection) + 1, events.indexOf(acknowledgement));
    assert(events.indexOf(connection) < events.indexOf(acknowledgement));
    assert(!preceding.some(event => event.type === 'archive.port-disconnect' && event.data.portId === portId), 'A retired Port cannot acknowledge a display.');
    const messages = preceding.filter(event => event.type === 'archive.port-message' && event.data.portId === portId).map(event => event.data.message);
    assert(!messages.some(value => value.action === 'cancel' && value.token === request.token), 'A cancelled one-use intent cannot provide successful display evidence.');
    const registrations = messages.filter(value => value.action === 'register');
    assert.equal(registrations.length, 1);
    assert.deepEqual(registrations[0], { type: 'arcifyArchiveDisplay', action: 'register', requestId: registrations[0].requestId, windowId });
    const takes = messages.filter(value => value.action === 'take'); assert(takes.length > 0);
    for (const take of takes) assert.deepEqual(take, { type: 'arcifyArchiveDisplay', action: 'take', requestId: take.requestId, session: message.session, windowId });
    const validations = messages.filter(value => value.action === 'validate' && value.token === request.token);
    assert.equal(validations.length, 1);
    assert.deepEqual(validations[0], { type: 'arcifyArchiveDisplay', action: 'validate', requestId: validations[0].requestId,
        session: message.session, windowId, token: request.token });
    assert(messages.indexOf(registrations[0]) < messages.indexOf(takes[0]));
    assert(messages.indexOf(takes.at(-1)) < messages.indexOf(validations[0]));
    const requestIds = [...messages, message].map(value => value.requestId);
    assert(requestIds.every(value => typeof value === 'string' && value));
    assert.equal(new Set(requestIds).size, requestIds.length, 'The observed Port cannot reuse a request ID.');
    // Native hosting is independently established by the unchanged capture
    // adapter. Chrome can omit Port sender.documentId; it is not attestation.
    assert.equal(native.context.contextType, 'SIDE_PANEL');
    assert.equal(native.context.documentUrl, `chrome-extension://${arcifyId}/sidebar.html`);
    assert.equal(typeof native.context.documentId, 'string'); assert(native.context.documentId);
    assert.equal(native.hosting.tab, null); assert.equal(native.hosting.windowId, windowId);
    return { connection, registration: registrations[0], takes, validation: validations[0], acknowledgement,
        evidenceModel: 'trusted-own-extension-Port plus independent native hosting and visible popup' };
}

/** Negative-only actual transport. Rejection is observed, never simulated. */
export async function probeArchiveDisplayRegistration({ windowId, requestId }) {
    const port = chrome.runtime.connect({ name: 'arcify-archive-display-v1' });
    return new Promise((resolve, reject) => {
        const messages = [];
        const message = value => messages.push(value);
        const disconnected = () => {
            const error = chrome.runtime.lastError?.message || null;
            cleanup(); resolve({ disconnected: true, error, messages });
        };
        const cleanup = () => { clearTimeout(timeout); port.onMessage.removeListener(message); port.onDisconnect.removeListener(disconnected); };
        const timeout = setTimeout(() => { cleanup(); port.disconnect(); reject(new Error('An ordinary sidebar tab retained an unauthorized Archive display Port.')); }, 8000);
        port.onMessage.addListener(message); port.onDisconnect.addListener(disconnected);
        try { port.postMessage({ type: 'arcifyArchiveDisplay', action: 'register', requestId, windowId }); }
        catch (error) { cleanup(); reject(error); }
    });
}

/** All reads use raw non-gesture CDP; Puppeteer evaluation must not renew activation. */
export function readArchiveActivation() {
    return { isActive: navigator.userActivation?.isActive ?? null, hasBeenActive: navigator.userActivation?.hasBeenActive ?? null,
        url: document.URL, timeOrigin: performance.timeOrigin };
}
export async function probeArchiveOpenWithoutGesture({ page, poll, prepare, baseline, arcifyId, requestId }) {
    const session = await page.createCDPSession(), activationSamples = [];
    try {
        const expired = await poll(async () => {
            const value = await evaluateWithoutGesture(session, `(${readArchiveActivation.toString()})()`);
            assert.equal(typeof value?.isActive, 'boolean'); assert.equal(typeof value.hasBeenActive, 'boolean');
            assert.equal(typeof value.url, 'string'); assert(Number.isFinite(value.timeOrigin) && value.timeOrigin > 0);
            if (activationSamples.length) {
                assert.equal(value.url, activationSamples[0].url); assert.equal(value.timeOrigin, activationSamples[0].timeOrigin);
            }
            activationSamples.push(value); return value;
        }, value => value.isActive === false, 'expired Archive source activation before preparing a fresh negative intent');
        // Preparing only after observed expiry prevents an old/expired token
        // from satisfying a negative that must reach Chrome's gesture gate.
        const context = await prepare();
        assert.equal(context?.ok, true); assert.equal(typeof context.archiveActions?.openIntent, 'string'); assert(context.archiveActions.openIntent);
        const before = await baseline();
        const request = { type: 'arcify-archive-open', version: 1, requestId, token: context.archiveActions.openIntent };
        const result = await evaluateWithoutGesture(session, `(() => {
            const activation = (${readArchiveActivation.toString()})();
            if (activation.isActive !== false || activation.url !== ${JSON.stringify(expired.url)} || activation.timeOrigin !== ${JSON.stringify(expired.timeOrigin)})
                return { sent: false, activation };
            return new Promise(resolve => chrome.runtime.sendMessage(${JSON.stringify(arcifyId)}, ${JSON.stringify(request)}, response =>
                resolve({ sent: true, activation, response, transportError: chrome.runtime.lastError?.message || null })));
        })()`);
        return { activationSamples, context, baseline: before, request, ...result };
    } finally { await session.detach(); }
}
export function assertArchiveNoGestureRejection(probe) {
    assert.equal(probe.sent, true, 'The negative must send once only from the same inactive source document.');
    assert.equal(probe.activationSamples.at(-1)?.isActive, false); assert.equal(probe.activation.isActive, false);
    assert.equal(probe.activation.url, probe.activationSamples[0].url); assert.equal(probe.activation.timeOrigin, probe.activationSamples[0].timeOrigin);
    assert.equal(probe.transportError, null);
    const response = probe.response;
    assert.equal(response?.type, 'arcify-archive-open'); assert.equal(response.version, 1);
    assert.equal(response.requestId, probe.request.requestId); assert.equal(response.role, 'arcify');
    assert.equal(response.ok, false); assert.notEqual(response.displayed, true);
    assert.equal(response.error?.code, 'OPEN_FAILED', 'A fresh authorized negative must reach Chrome gesture enforcement.');
    assert.match(response.error.message, /user (?:gesture|action)/i);
}

/** Passive DOM input observation survives legitimate retirement of an overlay. */
export function installArchiveInputObservation() {
    globalThis.__archiveInput?.stop();
    const events = [], registrations = [];
    for (const type of ['input', 'click', 'keydown']) {
        const listener = event => {
            const row = event.target.closest?.('[data-testid="spotlight-result"]') || document.querySelector('[data-testid="spotlight-result"].selected');
            events.push({ type, trusted: event.isTrusted, key: event.key || null, button: event.button ?? null,
                repeat: Boolean(event.repeat), composing: Boolean(event.isComposing), shift: Boolean(event.shiftKey), ctrl: Boolean(event.ctrlKey), alt: Boolean(event.altKey), meta: Boolean(event.metaKey),
                resultType: row?.dataset.resultType || null, entryId: row?.dataset.archiveEntryId || null,
                title: row?.querySelector('.arcify-spotlight-result-title')?.textContent || null });
        };
        document.addEventListener(type, listener, true); registrations.push(() => document.removeEventListener(type, listener, true));
    }
    globalThis.__archiveInput = { events, stop: () => registrations.forEach(remove => remove()) };
    parent.__archiveInputEvents = events;
}
export function assertArchiveTrustedInput(events, { type, title, entryId = null, method }) {
    const activations = events.filter(event => event.type === 'click' || event.type === 'keydown' && event.key === 'Enter');
    assert.equal(activations.length, 1, 'Exactly one genuine activation must cause each measured Archive action.');
    const event = activations[0];
    assert.equal(event.trusted, true); assert.equal(event.type, method === 'Enter' ? 'keydown' : 'click');
    for (const key of ['repeat', 'composing', 'shift', 'ctrl', 'alt', 'meta']) assert.equal(event[key], false);
    if (method === 'click') assert.equal(event.button, 0);
    assert.equal(event.resultType, type); assert.equal(event.title, title); assert.equal(event.entryId, entryId);
}
export function readArchiveRows() {
    return [...document.querySelectorAll('[data-testid="spotlight-result"]')].map(row => ({ type: row.dataset.resultType,
        entryId: row.dataset.archiveEntryId || null, title: row.querySelector('.arcify-spotlight-result-title')?.textContent,
        selected: row.classList.contains('selected'), visible: row.getClientRects().length > 0 && getComputedStyle(row).visibility !== 'hidden' }));
}
/** Passive selection timeline; never invokes controllers, sends messages or repairs selection. */
export function installArchiveSelectionObservation() {
    globalThis.__archiveSelectionObservation?.stop();
    const events=[],removals=[],input=document.querySelector('[data-testid="spotlight-input"]');
    const snapshot=()=>({time:performance.now(),query:input?.value??null,visibility:document.visibilityState,hasFocus:document.hasFocus(),
        focused:{id:document.activeElement?.id||null,testId:document.activeElement?.dataset?.testid||null},
        rows:[...document.querySelectorAll('[data-testid="spotlight-result"]')].map(row=>({type:row.dataset.resultType,
            entryId:row.dataset.archiveEntryId||null,title:row.querySelector('.arcify-spotlight-result-title')?.textContent||'',
            selected:row.classList.contains('selected')}))});
    const record=(type,detail={})=>{events.push({type,...detail,...snapshot()});if(events.length>200)events.shift();};
    for(const type of ['input','keydown','focusin','focusout','visibilitychange']){
        const listener=event=>record(type,{trusted:event.isTrusted,key:event.key||null});
        document.addEventListener(type,listener,{capture:true,passive:true});
        removals.push(()=>document.removeEventListener(type,listener,{capture:true}));
    }
    const results=document.querySelector('[data-testid="spotlight-results"]');
    const observer=new MutationObserver(()=>record('result-mutation'));
    if(results)observer.observe(results,{subtree:true,childList:true,attributes:true,attributeFilter:['class','data-result-type','data-archive-entry-id']});
    const runtime=globalThis.chrome?.runtime;
    if(runtime?.onMessage?.addListener){
        const listener=(message,sender)=>{
            if(['spotlightLiveTabsChanged','spotlightArcifyResultsChanged'].includes(message?.action))record('context-refresh-delivery',{
                action:message.action,windowId:message.windowId??null,removedTabIds:message.removedTabIds||[],senderId:sender?.id||null});
        };
        runtime.onMessage.addListener(listener);removals.push(()=>runtime.onMessage.removeListener(listener));
    }
    globalThis.__archiveSelectionObservation={events,read:snapshot,runtimeObservationAvailable:Boolean(runtime?.onMessage?.addListener),
        stop:()=>{observer.disconnect();removals.splice(0).forEach(remove=>remove());}};
    record('installed-before-typing');
}
export function readArchiveSelectionEvidence() {
    const observation=globalThis.__archiveSelectionObservation;
    return observation?{current:observation.read(),events:structuredClone(observation.events),runtimeObservationAvailable:observation.runtimeObservationAvailable}:
        {unavailable:'Selection observation was not installed in this document.'};
}

/** Passive failure-only reads; never send a request, focus, retry or render UI. */
export function readArchiveDocumentStatus() {
    return { url: document.URL, visibility: document.visibilityState, hasFocus: document.hasFocus(), readyState: document.readyState,
        timeOrigin: performance.timeOrigin, statuses: [...document.querySelectorAll('[role="status"], [role="alert"]')].map(node => ({
            id: node.id || null, role: node.getAttribute('role'), text: node.textContent, hidden: node.hidden,
            className: node.className, connected: node.isConnected })), archiveInput: globalThis.__archiveInputEvents || [] };
}
const archiveFailureError = error => ({ name: error?.name || 'Error', message: error?.message || String(error), stack: error?.stack || null });
export async function collectArchiveOpenFailure({ sourcePage, sourceSurface, nativePage, nativePanel, trace }) {
    const read = async operation => { try { return { ok: true, value: await operation() }; }
        catch (error) { return { ok: false, error: archiveFailureError(error) }; } };
    // Do not resolve a new target or poll on failure: inspect only the source and
    // native document already observed by this exact attempted activation.
    const observations = { observed: await read(trace), source: await read(() => sourcePage.evaluate(readArchiveDocumentStatus)),
        spotlight: await read(() => sourceSurface.evaluate(readArchiveDocumentStatus)), nativeState: await read(() => nativePanel.state()) };
    observations.native = nativePage ? {
        status: await read(() => nativePage.evaluate(readArchiveDocumentStatus)),
        hosting: await read(() => nativePage.evaluate(async () => ({ tab: await chrome.tabs.getCurrent() || null, windowId: (await chrome.windows.getCurrent()).id }))),
        readiness: await read(() => nativePage.evaluate(readNativeSidebarRender)),
        popup: await read(() => nativePage.evaluate(readNativeArchivePopup))
    } : { unavailable: 'No native document was resolved before the original failure.' };
    return observations;
}
/** Passive exact-request journal read. A missing reply never implies in-flight work. */
export async function readArchiveReopenJournal({ spotlightId, entryId, windowId, sourceTabId, requests }) {
    if (!Array.isArray(requests)) return { journal: [], responseEvidence: 'unavailable',
        limitation: 'The request trace is unavailable; no journal response can be attributed to this attempt.' };
    const exactRequests = requests.filter(request => request?.command === 'reopenArchivedTab' && request.entryId === entryId
        && request.windowId === windowId && request.context?.sourceTabId === sourceTabId).map(request => ({
        key: `${spotlightId}:${request.context.pairingGeneration ? `${request.context.pairingGeneration}:` : ''}${request.requestId}`, fingerprint: JSON.stringify(request)
    }));
    const stored = await chrome.storage.session.get('spotlightBridgeRequests');
    const journal = (stored.spotlightBridgeRequests || []).filter(item => exactRequests.some(request => item.key === request.key && item.fingerprint === request.fingerprint));
    return { journal, responseEvidence: journal.some(item => Object.hasOwn(item, 'response')) ? 'retained-journal-response' : 'unavailable',
        limitation: 'Failed raw replies are not retained. A journal entry without a response does not prove the action is still in flight.' };
}
export async function collectArchiveReopenFailure({ apiPage, spotlightOptions, sourcePage, sourceSurface, spotlightId, entryId, windowId, sourceTabId }) {
    const read = async operation => { try { return { ok: true, value: await operation() }; }
        catch (error) { return { ok: false, error: archiveFailureError(error) }; } };
    const events = await read(() => apiPage.evaluate(() => globalThis.__spaceActionObservation.events));
    const requests = events.ok && Array.isArray(events.value) ? events.value.filter(event => event?.type === 'external' && event.data?.sender?.id === spotlightId).map(event => event.data.message) : null;
    // Each already-owned document is independent: a detached source must not
    // discard either extension's native/storage/request trace. No target lookup,
    // queued store read, transport wrapper, replay or UI interaction on failure.
    return {
        events,
        peerEvents: await read(() => spotlightOptions.evaluate(() => globalThis.__spaceActionObservation.events)),
        input: await read(() => sourcePage.evaluate(() => globalThis.__archiveInputEvents || [])),
        source: await read(() => sourcePage.evaluate(readArchiveDocumentStatus)),
        spotlight: await read(() => sourceSurface.evaluate(readArchiveDocumentStatus)),
        claim: await read(() => apiPage.evaluate(async entryId => (await chrome.storage.local.get('archiveReopenClaims')).archiveReopenClaims?.entries?.[entryId] || null, entryId)),
        receipt: await read(() => apiPage.evaluate(readArchiveReopenJournal, { spotlightId, entryId, windowId, sourceTabId, requests }))
    };
}
export async function withArchiveFailureEvidence(operation, diagnose, record) {
    try { return await operation(); }
    catch (error) {
        let observations;
        try { observations = await diagnose(); } catch (diagnosticError) { observations = { diagnosticError: archiveFailureError(diagnosticError) }; }
        try { await record({ error: archiveFailureError(error), observations }); } catch { /* Preserve the original failure even if evidence persistence fails. */ }
        throw error;
    }
}

export function readNativeArchivePopup() {
    const visible = node => {
        if (!node) return false;
        const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
        return style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse' && Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0 && rect.x < innerWidth && rect.y < innerHeight && rect.right > 0 && rect.bottom > 0;
    };
    const popups = [...document.querySelectorAll('.archived-tabs-popup.visible')];
    return { url: location.href, visibility: document.visibilityState, selectedSpaces: [...document.querySelectorAll('#spacesList > .space.active')].map(space => {
        const content = space.querySelector('.space-content'), popup = space.querySelector('.archived-tabs-popup');
        return { spaceId: space.dataset.spaceId, visible: visible(space), contentHidden: content?.classList.contains('hidden'), contentVisible: visible(content),
            expanded: space.querySelector('.sidebar-button')?.getAttribute('aria-expanded'), popupVisible: visible(popup), popupClassVisible: popup?.classList.contains('visible') };
    }), popups: popups.map(popup => ({ visible: visible(popup),
        spaceId: popup.closest('.space')?.dataset.spaceId || null,
        entries: [...popup.querySelectorAll('.archived-item')].map(row => ({ entryId: row.dataset.archiveEntryId, title: row.querySelector('.tab-title-display')?.textContent })),
        controls: Boolean(popup.querySelector('.archiving-controls input[role="switch"]')), message: popup.querySelector('.no-archived-tabs-message')?.textContent || '' })) };
}
export function assertNativeArchiveToggle(rendered, { arcifyId, spaceId, open }) {
    assert.equal(rendered.url, `chrome-extension://${arcifyId}/sidebar.html`); assert.equal(rendered.visibility, 'visible');
    assert.deepEqual(rendered.selectedSpaces, [{ spaceId, visible: true, contentHidden: open, contentVisible: !open,
        expanded: String(open), popupVisible: open, popupClassVisible: open }], 'Native popup, content visibility and button ARIA must agree in the exact selected Space.');
    if (!open) assert.deepEqual(rendered.popups, [], 'Closing Archive must restore content, not leave a transparent or blank sidebar.');
}
export function assertNativeArchivePopup(rendered, { arcifyId, spaceId, entries }) {
    assertNativeArchiveToggle(rendered, { arcifyId, spaceId, open: true });
    assert.equal(rendered.popups.length, 1, 'Exactly one existing global Archive popup must be visible in the verified native panel.');
    const popup = rendered.popups[0]; assert.equal(popup.visible, true); assert.equal(popup.spaceId, spaceId); assert.equal(popup.controls, true);
    assert.deepEqual(popup.entries, entries.map(entry => ({ entryId: entry.entryId, title: entry.name })), 'The existing global popup must include entries from their original Spaces, not a filtered or invented list.');
    return popup;
}
export function installArchiveButtonObservation() {
    globalThis.__archiveButtonInput?.stop();
    const events = [];
    const listener = event => {
        const button = event.target.closest?.('.sidebar-button');
        events.push({ trusted: event.isTrusted, button: event.button, shift: Boolean(event.shiftKey), ctrl: Boolean(event.ctrlKey),
            alt: Boolean(event.altKey), meta: Boolean(event.metaKey), spaceId: button?.closest('.space')?.dataset.spaceId || null,
            expandedBefore: button?.getAttribute('aria-expanded') || null });
    };
    document.addEventListener('click', listener, true);
    globalThis.__archiveButtonInput = { events, stop: () => document.removeEventListener('click', listener, true) };
}
export async function exerciseArchivePopupButtonRoundTrip({ page, arcifyId, spaceId, entries, ui, poll, settle, read, reset, trace, capture, checkpoint }) {
    assert.match(spaceId, /^[a-zA-Z0-9_-]+$/, 'Require the exact safe native Space selector.');
    return ui(page, 'Close and reopen Archive with its genuine native sidebar button', async () => {
        const before = await settle();
        assertNativeArchivePopup(await page.evaluate(readNativeArchivePopup), { arcifyId, spaceId, entries });
        for (const open of [false, true]) {
            await reset(); await page.evaluate(installArchiveButtonObservation);
            await page.click(`#spacesList > .space.active[data-space-id="${spaceId}"] .sidebar-button`);
            const rendered = await poll(() => page.evaluate(readNativeArchivePopup), state => {
                try { if (open) assertNativeArchivePopup(state, { arcifyId, spaceId, entries });
                    else assertNativeArchiveToggle(state, { arcifyId, spaceId, open }); return true; } catch { return false; }
            }, `native Archive button ${open ? 'reopens popup' : 'restores visible Space content'}`);
            const input = await page.evaluate(() => globalThis.__archiveButtonInput.events);
            assert.deepEqual(input, [{ trusted: true, button: 0, shift: false, ctrl: false, alt: false, meta: false,
                spaceId, expandedBefore: String(!open) }], 'Exactly one genuine native button click must cause this transition.');
            const after = await read(), observed = await trace(); assertArchiveNoMutation(before, after, observed.events);
            const screenshot = await capture(page, `native-archive-button-${open ? 'reopened' : 'closed'}`); assert(screenshot?.filename);
            assert.deepEqual(await page.evaluate(readNativeArchivePopup), rendered);
            assert.deepEqual(await read(), before);
            await checkpoint('native-archive-button-round-trip', { open, before, after, rendered, input, observed, screenshot });
        }
        await page.evaluate(() => globalThis.__archiveButtonInput.stop());
    });
}
export function assertArchiveOpenRequest(events, { spotlightId, sourceTabId, windowId, sourceUrl }) {
    const requests = events.filter(event => event.type === 'external' && event.data.message.type === 'arcify-archive-open');
    assert.equal(requests.length, 1, 'One trusted renderer activation sends one direct native-open request.');
    const { message, sender } = requests[0].data;
    assert.deepEqual(Object.keys(message).sort(), ['type', 'version', 'requestId', 'token'].sort());
    assert.equal(message.version, 1); assert.match(message.requestId, /^[\w.:-]{1,80}$/); assert.equal(typeof message.token, 'string'); assert(message.token.length > 0);
    assert.equal(sender.id, spotlightId);
    assert(sender.url === `chrome-extension://${spotlightId}/newtab.html` || sender.url === sourceUrl, 'Opening must be sent directly by an authenticated visible renderer, not relayed by a worker.');
    assert(!events.some(event => event.type === 'external' && event.data.message.type === 'arcify-sidebar'), 'Archive must not substitute the existing Sidebar command.');
    // Source binding is separately proven by the preceding real archiveContext request.
    const contexts = events.filter(event => event.type === 'external' && event.data.message.command === 'archiveContext');
    assert(contexts.some(event => event.data.message.tabId === sourceTabId && event.data.message.windowId === windowId), 'Source-bound intent must come from the exact invoking native tab and window.');
    return message;
}
export function assertArchiveReopenRequest(events, { spotlightId, sourceTabId, windowId, entryId }) {
    const requests = events.filter(event => event.type === 'external' && event.data.message.command === 'reopenArchivedTab');
    assert.equal(requests.length, 1, 'One visible entry activation sends one reopen mutation.');
    const { message, sender } = requests[0].data;
    assert.equal(sender.id, spotlightId); assert.equal(message.type, 'arcify-bridge'); assert.equal(message.version, 1); assert.match(message.requestId, /^[\w.:-]{1,80}$/);
    assert.deepEqual(Object.keys(message).sort(), ['type', 'version', 'requestId', 'windowId', 'command', 'context', 'viewId', 'entryId', 'supportedFeatures'].sort());
    assert.deepEqual(message.supportedFeatures, ARCHIVE_FEATURES); assert.equal(message.windowId, windowId); assert.equal(message.entryId, entryId);
    assert.equal(message.context.sourceTabId, sourceTabId); assert.equal(message.context.windowId, windowId); assert.equal(typeof message.viewId, 'string'); assert(message.viewId);
    assert(!Object.hasOwn(message, 'url') && !Object.hasOwn(message, 'expected'), 'Only an exact ID and private-view reference can select the stored record.');
    return message;
}
// Native activation legitimately retires tracked overlays before their Archive
// callback can render status. A missing renderer is never sufficient proof:
// require the actual request and durable/native commit first, then retirement.
export async function waitForArchiveReopenCompletion({ page, surface, kind, spaceName, events, expected, verifyCommitted }) {
    assert(['overlay', 'browser-newtab', 'owned-newtab'].includes(kind));
    assert.equal(typeof verifyCommitted, 'function');
    const request = assertArchiveReopenRequest(events, expected);
    const receipt = await verifyCommitted();
    if (kind === 'overlay') {
        assert.notEqual(surface, page, 'Overlay completion must belong to the isolated source frame.');
        await page.waitForFunction(() => !document.getElementById('arcify-spotlight-host'), { polling: 50 });
        const overlayRetired = await page.evaluate(() => !document.getElementById('arcify-spotlight-host'));
        assert.equal(overlayRetired, true, 'The original source overlay must retire after native tab activation.');
        return { request, receipt, status: null, overlayRetired };
    }
    assert.equal(surface, page, 'A New Tab helper retains its own renderer and must show real success.');
    await surface.waitForFunction(name => document.querySelector('.arcify-bridge-status [role="status"]')?.textContent === `Archived tab reopened in ${name}.`, { polling: 50 }, spaceName);
    const status = await surface.$eval('.arcify-bridge-status [role="status"]', node => node.textContent);
    assert.equal(status, `Archived tab reopened in ${spaceName}.`);
    return { request, receipt, status, overlayRetired: false };
}

/** Read-only destination evidence; the original source can legitimately be hidden. */
export function readArchiveDestinationDocument() {
    return { url: location.href, visibility: document.visibilityState, focused: document.hasFocus(), readyState: document.readyState,
        documentId: document.body?.dataset.documentId || null, timeOrigin: performance.timeOrigin,
        width: innerWidth, height: innerHeight };
}
export async function captureArchiveReopenedDestination({ browser, apiPage, observePage, poll, beforeTargets, before, receipt, windowId, url, capture, settle, read, trace, label }) {
    assert(beforeTargets instanceof Set); assert(Number.isSafeInteger(receipt.tabId) && receipt.tabId > 0);
    assert.equal(receipt.claim?.phase, 'consumed'); assert.equal(receipt.claim.tabId, receipt.tabId);
    assert.equal(receipt.claim.windowId, windowId); assert.equal(receipt.claim.expected.url, url);
    const beforeIds = before.tabs.map(tab => tab.id);
    assert(!beforeIds.includes(receipt.tabId), 'Destination must be the exact newly created native ID.');
    const baseline = await settle();
    assert.deepEqual(baseline.tabs.filter(tab => !beforeIds.includes(tab.id)).map(tab => tab.id), [receipt.tabId], 'One reopen must produce exactly one new native ID.');
    assert.deepEqual(baseline.claims?.entries?.[receipt.claim.entryId], receipt.claim, 'The exact consumed receipt must remain unchanged before capture.');
    assert.equal(baseline.activeSpaces[windowId], receipt.claim.expected.spaceId);
    const observedBefore = await trace();
    const freshTargets = () => browser.targets().filter(target => target.type() === 'page' && !beforeTargets.has(target));
    const target = await poll(() => {
        const fresh = freshTargets();
        assert(fresh.length <= 1, 'Ambiguous fresh destination targets cannot be selected by same URL.');
        return fresh.length === 1 && fresh[0].url() === url ? fresh[0] : null;
    }, Boolean, `one fresh destination target for reopened native tab ${receipt.tabId}`);
    const page = await observePage(await target.page());
    const native = () => apiPage.evaluate(async ({ tabId, windowId, beforeIds }) => {
        const tabs = await chrome.tabs.query({}), tab = tabs.find(tab => tab.id === tabId), window = await chrome.windows.get(windowId);
        return { tab: tab ? { id: tab.id, windowId: tab.windowId, url: tab.url, pendingUrl: tab.pendingUrl || null,
            active: tab.active, pinned: tab.pinned, incognito: tab.incognito, status: tab.status } : null,
            window: { id: window.id, type: window.type, incognito: window.incognito, focused: window.focused },
            newTabIds: tabs.filter(tab => !beforeIds.includes(tab.id)).map(tab => tab.id),
            activeTabIds: tabs.filter(tab => tab.windowId === windowId && tab.active).map(tab => tab.id) };
    }, { tabId: receipt.tabId, windowId, beforeIds });
    const verify = (nativeState, documentState) => {
        const fresh = freshTargets(); assert.equal(fresh.length, 1);
        assert.equal(fresh[0], target, 'The exact single fresh target identity must survive capture.');
        assert.equal(page.target(), target); assert.equal(target.url(), url); assert.equal(page.url(), url);
        assert.deepEqual(nativeState, { tab: { id: receipt.tabId, windowId, url, pendingUrl: null, active: true,
            pinned: false, incognito: false, status: 'complete' }, window: { id: windowId, type: 'normal', incognito: false, focused: true },
            newTabIds: [receipt.tabId], activeTabIds: [receipt.tabId] });
        assert.equal(documentState.url, url); assert.equal(documentState.visibility, 'visible'); assert.equal(documentState.focused, true);
        assert.equal(documentState.readyState, 'complete'); assert.match(documentState.documentId, /^[a-f0-9]{32}$/);
        assert(Number.isFinite(documentState.timeOrigin) && documentState.timeOrigin > 0);
        assert(documentState.width > 0 && documentState.height > 0);
    };
    const nativeBefore = await native(), documentBefore = await page.evaluate(readArchiveDestinationDocument);
    verify(nativeBefore, documentBefore);
    const screenshot = await capture(page, label); assert(screenshot?.filename); assert.equal(screenshot.url, url);
    const documentAfter = await page.evaluate(readArchiveDestinationDocument), nativeAfter = await native();
    verify(nativeAfter, documentAfter); assert.deepEqual(documentAfter, documentBefore, 'Capture must retain the same visible destination document.');
    const after = await read(), observedAfter = await trace();
    assert.deepEqual(observedAfter.events.slice(0, observedBefore.events.length), observedBefore.events, 'Capture cannot erase prior action observations.');
    assertArchiveNoMutation(baseline, after, observedAfter.events.slice(observedBefore.events.length));
    return { tabId: receipt.tabId, windowId, url, nativeBefore, nativeAfter, documentBefore, documentAfter, before: baseline, after, screenshot };
}

export function assertArchiveNoMutation(before, after, events, { pendingRequest = null, spotlightId } = {}) {
    const changed = changedStorage(events).filter(event => ['local', 'session'].includes(event.data.area));
    if (pendingRequest) {
        assert.match(spotlightId, /^[a-p]{32}$/); assert.equal(pendingRequest.command, 'reopenArchivedTab');
        assert.equal(pendingRequest.context.pairingGeneration, before.pairingGeneration);
        const key = `${spotlightId}:${before.pairingGeneration ? `${before.pairingGeneration}:` : ''}${pendingRequest.requestId}`;
        const previous = before.journal || [];
        assert(!previous.some(entry => entry.key === key), 'A new failed mutation must not replace an existing journal identity.');
        const pending = { key, fingerprint: JSON.stringify(pendingRequest) };
        const journal = [...previous.slice(-99), pending];
        assert.deepEqual(after, { ...before, journal }, 'Only the exact bounded pending request receipt may change after a rejected mutation.');
        assert.equal(changed.length, 1, 'Exactly one pending journal append, no unrelated local/session writes.');
        assert.equal(changed[0].data.area, 'session');
        assert.deepEqual(Object.keys(changed[0].data.changes), ['spotlightBridgeRequests']);
        const change = changed[0].data.changes.spotlightBridgeRequests;
        assert.deepEqual(change.oldValue || [], previous); assert.deepEqual(change.newValue, journal);
        assert.deepEqual(Object.keys(journal.at(-1)).sort(), ['fingerprint', 'key'], 'An unconfirmed action cannot gain a success response.');
    } else {
        assert.deepEqual(after, before, 'Rejected/repeated Archive requests preserve the full captured native and durable state.');
        assert.deepEqual(changed, [], 'No changed durable or session data may hide a failed action.');
    }
    assert.deepEqual([...mutationEvents(events), ...events.filter(event => /^(?:windows|sidePanel)\./.test(event.type))], [], 'No duplicate create, navigation, closure, focus, panel opening, reassignment or saved write is allowed.');
}
export function assertArchiveCachedReplay(response, request, state, { spotlightId }) {
    assert.deepEqual(Object.keys(response).sort(), ['type', 'version', 'requestId', 'role', 'ok', 'archiveResult', 'snapshot'].sort());
    assert.equal(response.type, request.type); assert.equal(response.version, request.version); assert.equal(response.requestId, request.requestId);
    assert.equal(response.role, 'arcify'); assert.equal(response.ok, true);
    assert.match(spotlightId, /^[a-p]{32}$/); assert.equal(request.context.pairingGeneration, state.pairingGeneration);
    const key = `${spotlightId}:${state.pairingGeneration ? `${state.pairingGeneration}:` : ''}${request.requestId}`;
    const entries = state.journal.filter(entry => entry.key === key);
    assert.equal(entries.length, 1, 'The cached acknowledgement must match one exact original request.');
    assert.equal(entries[0].fingerprint, JSON.stringify(request));
    const { snapshot, ...cached } = response; assert.deepEqual(cached, entries[0].response);
    const claim = state.claims?.entries?.[request.entryId]; assert.equal(claim?.phase, 'consumed');
    assert.deepEqual(response.archiveResult, { entryId: request.entryId, tabId: claim.tabId, spaceId: claim.expected.spaceId,
        windowId: request.windowId, consumed: true, status: 'reopened', warning: null });
    assert.equal(response.snapshot.windowId, request.windowId);
    return response.archiveResult;
}
export function assertArchiveReopened(before, after, events, { entry, sourceWindowId, selectedSpaceId }) {
    const created = events.filter(event => event.type === 'tabs.onCreated'); assert.equal(created.length, 1, 'A single exact archived-entry activation creates precisely one native tab.');
    const native = created[0].data[0]; assert(Number.isSafeInteger(native.id) && native.id > 0);
    assert.equal(native.windowId, sourceWindowId); assert.equal(native.pendingUrl || native.url, entry.url);
    const tab = exact(after.tabs, native.id); assert.equal(tab.windowId, sourceWindowId); assert.equal(tab.url, entry.url); assert.equal(tab.pinned, false); assert.equal(tab.active, true);
    assert(!before.tabs.some(tab => tab.id === native.id));
    assert.deepEqual(after.tabs.map(tab => tab.id).sort((a, b) => a - b), [...before.tabs.map(tab => tab.id), native.id].sort((a, b) => a - b));
    for (const previous of before.tabs) {
        const current = exact(after.tabs, previous.id);
        assert.deepEqual({ ...current, active: previous.active }, previous, 'Reopen cannot navigate, close, pin, move or replace a pre-existing native ID.');
        if (previous.windowId !== sourceWindowId) assert.deepEqual(current, previous, 'Other-window active tabs remain untouched.');
    }
    assert.notEqual(entry.spaceId, selectedSpaceId, 'The acceptance fixture must distinguish the original destination from the currently selected Space.');
    const memberships = after.spaces.flatMap(space => ['temporaryTabs', 'spaceBookmarks'].flatMap(section => space[section].filter(id => id === native.id).map(() => ({ id: space.id, folder: space.bookmarkFolderId, section }))));
    assert.deepEqual(memberships, [{ id: entry.spaceId, folder: entry.bookmarkFolderId, section: 'temporaryTabs' }]);
    for (const previous of before.spaces) {
        const current = exact(after.spaces, previous.id);
        assert.equal(current.bookmarkFolderId, previous.bookmarkFolderId);
        assert.deepEqual(current.spaceBookmarks, previous.spaceBookmarks);
        assert.deepEqual(current.temporaryTabs.filter(id => id !== native.id), previous.temporaryTabs);
    }
    assert.equal(after.activeSpaces[sourceWindowId], entry.spaceId);
    for (const [windowId, spaceId] of Object.entries(before.activeSpaces)) if (Number(windowId) !== sourceWindowId) assert.equal(after.activeSpaces[windowId], spaceId);
    for (const key of ['bookmarks', 'bindings', 'aliases', 'favorites', 'favoriteSession', 'groups', 'projection', 'pairingGeneration', 'pageStates', 'windows']) assert.deepEqual(after[key], before[key], `${key} is unchanged by restoring an archive entry.`);
    assert.deepEqual(after.archivedTabs, before.archivedTabs.filter(value => value.entryId !== entry.entryId), 'Consume only the chosen full record; preserve every same-address twin.');
    const claim = after.claims?.entries?.[entry.entryId]; assert(claim); assert.equal(claim.phase, 'consumed'); assert.equal(claim.tabId, native.id);
    assert.equal(claim.windowId, sourceWindowId); assert.equal(claim.bookmarkFolderId, entry.bookmarkFolderId);
    const expected = { ...entry }; delete expected.bookmarkFolderId;
    assert.deepEqual(claim.expected, expected, 'The durable receipt retains the complete exact record snapshot.');
    assert.equal(claim.result.consumed, true); assert.equal(claim.result.entryId, entry.entryId); assert.equal(claim.result.tabId, native.id);
    const consumes = changedStorage(events).filter(event => event.data.area === 'local' && event.data.changes.archivedTabs?.oldValue?.some(value => value.entryId === entry.entryId)
        && !event.data.changes.archivedTabs?.newValue?.some(value => value.entryId === entry.entryId));
    assert.equal(consumes.length, 1, 'Exactly one observable durable consume commit.');
    assert.deepEqual(consumes[0].data.changes.archiveReopenClaims?.newValue?.entries?.[entry.entryId], claim, 'Receipt and exact removal must share the same storage commit.');
    assert(!events.some(event => event.type.startsWith('bookmarks.')));
    return { tabId: native.id, claim, consumedCommit: consumes[0] };
}

/** Read native identity in the real owned setup document, never the control window. */
export async function readArchiveFixtureSource() {
    const tab = await chrome.tabs.getCurrent();
    if (!tab) throw new Error('Archive fixture requires its own native extension tab.');
    const window = await chrome.windows.getCurrent();
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['TAB'], tabIds: [tab.id] });
    return { extensionId: chrome.runtime.id, url: location.href, timeOrigin: performance.timeOrigin,
        tab: { id: tab.id, windowId: tab.windowId, url: tab.url, pendingUrl: tab.pendingUrl || null, status: tab.status, incognito: tab.incognito, pinned: tab.pinned },
        window: { id: window.id, type: window.type, incognito: window.incognito },
        contexts: contexts.map(({ contextType, documentId, documentUrl, tabId, windowId, frameId, incognito }) => ({ contextType, documentId, documentUrl, tabId, windowId, frameId, incognito })) };
}
export function assertArchiveFixtureSource(source, { arcifyId, windowId, tabId, url }, previous = null) {
    assert.match(arcifyId, /^[a-p]{32}$/); assert(Number.isSafeInteger(windowId) && windowId > 0); assert(Number.isSafeInteger(tabId) && tabId > 0);
    assert.match(url, new RegExp(`^chrome-extension://${arcifyId}/options\\.html\\?paired-archive-fixture=[a-f0-9]{32}$`));
    assert.equal(source.extensionId, arcifyId); assert.equal(source.url, url); assert(Number.isFinite(source.timeOrigin) && source.timeOrigin > 0);
    assert.deepEqual(source.tab, { id: tabId, windowId, url, pendingUrl: null, status: 'complete', incognito: false, pinned: false });
    assert.deepEqual(source.window, { id: windowId, type: 'normal', incognito: false });
    assert.equal(source.contexts.length, 1, 'Require exactly one browser-attested extension TAB document.');
    const context = source.contexts[0]; assert.equal(typeof context.documentId, 'string'); assert(context.documentId);
    assert.deepEqual(context, { contextType: 'TAB', documentId: context.documentId, documentUrl: url, tabId, windowId, frameId: 0, incognito: false });
    if (previous) assert.deepEqual(source, previous, 'Archive setup must retain its exact native document and source window.');
    return source;
}
export async function sendArchiveFixtureRequest(endpoint, message) {
    assert(endpoint?.page && endpoint.source, 'Archive setup requires its verified owned source document.');
    const { source, page } = endpoint;
    assert(['favoriteStore', 'archiveStore'].includes(message.type));
    assert(Number.isSafeInteger(message.windowId) && message.windowId > 0);
    assertArchiveFixtureSource(await page.evaluate(readArchiveFixtureSource), { arcifyId: source.extensionId,
        windowId: source.window.id, tabId: source.tab.id, url: source.url }, source);
    // A deliberate wrong-window probe also uses this genuine document. The
    // unchanged receiver, not this harness, must reject its mismatched window.
    return page.evaluate(message => chrome.runtime.sendMessage(message), message);
}
export function installArchiveFixtureMessageObservation() {
    globalThis.__archiveFixtureMessageStop?.();
    const listener = (message, sender) => {
        if (!['favoriteStore', 'archiveStore'].includes(message?.type)) return;
        globalThis.__spaceActionObservation.events.push({ type: 'archive.fixture-message', data: { message,
            sender: { id: sender.id, url: sender.url || null, origin: sender.origin || null, documentId: sender.documentId || null,
                frameId: sender.frameId ?? null, documentLifecycle: sender.documentLifecycle || null,
                tab: sender.tab ? { id: sender.tab.id, windowId: sender.tab.windowId } : null } } });
    };
    chrome.runtime.onMessage.addListener(listener);
    globalThis.__archiveFixtureMessageStop = () => chrome.runtime.onMessage.removeListener(listener);
}
export function assertArchiveFixtureSender(events, message, source) {
    const matches = events.filter(event => event.type === 'archive.fixture-message' && isDeepStrictEqual(event.data.message, message));
    assert.equal(matches.length, 1, 'Exactly one actual setup message must originate from the owned extension document.');
    assert.deepEqual(matches[0].data.sender, { id: source.extensionId, url: source.url, origin: `chrome-extension://${source.extensionId}`,
        documentId: source.contexts[0].documentId, frameId: 0, documentLifecycle: 'active', tab: { id: source.tab.id, windowId: source.window.id } });
    return matches[0];
}

/** Own only disposable records and native IDs; positive actions never use these setup adapters. */
async function archiveFixture(adapters, run) {
    assertSpotlightActionEnvironment();
    const { browser, observePage, apiPage, spotlightOptions, newTabPage, openSavedPage, ui, screenshot, snapshot, external, poll, fixture, arcifyId, spotlightId, search, record = async () => {} } = adapters;
    for (const fn of [observePage, newTabPage, openSavedPage, ui, screenshot, snapshot, external, poll, search]) assert.equal(typeof fn, 'function');
    const windowId = fixture.windowA, otherWindow = fixture.windowB, nonce = randomBytes(16).toString('hex');
    const original = await apiPage.evaluate(async () => ({ tabs: await chrome.tabs.query({}), windows: await chrome.windows.getAll(),
        local: await chrome.storage.local.get(['archivedTabs', 'archiveReopenClaims']), sync: await chrome.storage.sync.get(['syncTabGroups']),
        session: await chrome.storage.session.get(['activeSpaces', 'archiveBrowserSession']) }));
    const owned = [], roots = [], spaceRoots = [], pages = new Map(), favoriteIds = [];
    const evidence = { nonce, checkpoints: [], matrix: [], complete: false, unitOnly: ['deterministic lost ACK or response', 'mid-storage-callback revocation', 'worker/browser crash during native create', 'Helium and physical keyboard'] };
    let source, target, entries, overlayPage, fixtureApi, revoked = false, primaryError, activeSearch;
    const checkpoint = async (phase, data = {}) => { evidence.checkpoints.push({ phase, ...data }); await record(structuredClone(evidence)); };
    const local = async message => { const result = await apiPage.evaluate(message => chrome.runtime.sendMessage({ type: 'spaceStore', ...message }), message); assert.equal(result?.success, true, JSON.stringify(result)); return result; };
    const archive = async message => { const reply = await sendArchiveFixtureRequest(fixtureApi, { type: 'archiveStore', windowId, ...message }); assert.equal(reply?.success, true, JSON.stringify(reply)); return reply.result; };
    const favorite = async message => { const reply = await sendArchiveFixtureRequest(fixtureApi, { type: 'favoriteStore', ...message }); assert.equal(reply?.success, true, JSON.stringify(reply)); return reply; };
    const activate = async tabId => apiPage.evaluate(async tabId => { const tab = await chrome.tabs.update(tabId, { active: true }); await chrome.windows.update(tab.windowId, { focused: true }); }, tabId);
    const option = async value => {
        await ui(apiPage, 'Set isolated Archive fixture group-sync option', async () => { if (await apiPage.$eval('#syncTabGroups', node => node.checked) !== value) await apiPage.click('label.toggle-label[for="syncTabGroups"]'); });
        await poll(() => apiPage.evaluate(() => chrome.storage.sync.get('syncTabGroups')), settings => Boolean(settings.syncTabGroups) === value, 'Archive fixture group-sync setting saved');
    };
    const read = async () => {
        await local({ action: 'get' });
        const state = await apiPage.evaluate(async () => {
            const local = await chrome.storage.local.get(['spaces', 'archivedTabs', 'archiveReopenClaims', 'pinnedTabStatesById', 'tabNameOverridesById', 'persistentFavorites', 'arcifyBridgePairingGeneration']);
            const session = await chrome.storage.session.get(['activeSpaces', 'favoriteSession', 'spaceGroupProjection', 'spotlightBridgeRequests']);
            return { tabs: (await chrome.tabs.query({})).map(({ id, windowId, index, url, pendingUrl, pinned, incognito, active, groupId, splitViewId }) => ({ id, windowId, index, url, pendingUrl: pendingUrl || null, pinned, incognito, active, groupId, splitViewId: splitViewId ?? -1 })).sort((a, b) => a.id - b.id),
                windows: (await chrome.windows.getAll()).map(({ id, type, incognito, focused, state }) => ({ id, type, incognito, focused, state })).sort((a, b) => a.id - b.id),
                spaces: local.spaces || [], archivedTabs: local.archivedTabs || [], claims: local.archiveReopenClaims || null,
                bookmarks: await chrome.bookmarks.getTree(), bindings: local.pinnedTabStatesById || {}, aliases: local.tabNameOverridesById || {}, favorites: local.persistentFavorites || [],
                journal: session.spotlightBridgeRequests || [], activeSpaces: session.activeSpaces || {}, favoriteSession: session.favoriteSession || null, projection: session.spaceGroupProjection || {},
                groups: (await chrome.tabGroups.query({})).sort((a, b) => a.id - b.id), pairingGeneration: local.arcifyBridgePairingGeneration ?? null };
        });
        state.bookmarks = canonicalSavedMoveBookmarks(state.bookmarks);
        state.pageStates = Object.fromEntries(await Promise.all([...pages].map(async ([id, page]) => [id, await page.evaluate(readSpotlightActionPage)])));
        return state;
    };
    const settle = async () => { let previous, since; return poll(read, state => { const next = JSON.stringify(state); if (next !== previous) { previous = next; since = Date.now(); return false; } return Date.now() - since >= 400; }, 'stable Archive native/store state before measurement'); };
    const reset = async () => { await apiPage.evaluate(() => { globalThis.__spaceActionObservation.events.length = 0; }); await spotlightOptions.evaluate(() => { globalThis.__spaceActionObservation.events.length = 0; }); };
    const trace = async page => ({ events: await apiPage.evaluate(() => globalThis.__spaceActionObservation.events), peerEvents: await spotlightOptions.evaluate(() => globalThis.__spaceActionObservation.events), input: page ? await page.evaluate(() => globalThis.__archiveInputEvents || []) : [] });
    const capture = (page, label) => screenshot(page, `archive-${label}`, true, { fullPage: false });
    const closeOverlay = async () => {
        if (!overlayPage || overlayPage.isClosed() || !await overlayPage.evaluate(() => Boolean(document.getElementById('arcify-spotlight-host')))) return;
        const surface = await spotlightSurface(overlayPage);
        await ui(overlayPage, 'Dismiss Archive overlay', async () => { const input = await surface.$('[data-testid="spotlight-input"]'); assert(input); try { await input.press('Escape'); } finally { await input.dispose(); } });
        await overlayPage.waitForFunction(() => !document.getElementById('arcify-spotlight-host'));
    };
    const sourcePage = async (kind, sourceRecord) => {
        await closeOverlay(); await activate(sourceRecord.tab.id); await local({ action: 'activate', windowId, spaceId: source.id });
        await settle(); await reset();
        if (kind !== 'overlay') {
            const helper = await newTabPage(kind === 'browser-newtab' ? 'chrome://newtab/' : `chrome-extension://${spotlightId}/newtab.html`, windowId); owned.push(helper.tab.id);
            await helper.page.waitForSelector('[data-testid="spotlight-input"]', { visible: true });
            await poll(() => apiPage.evaluate(id => chrome.tabs.get(id), helper.tab.id), tab => tab.status === 'complete' && !tab.pendingUrl, 'settled exact Archive New Tab helper');
            return { ...helper, kind };
        }
        overlayPage = sourceRecord.page;
        const launched = await external(apiPage, spotlightId, 'launch', { windowId, mode: 'new-tab' }); assert.equal(launched?.ok, true, JSON.stringify(launched));
        await overlayPage.waitForFunction(() => document.getElementById('arcify-spotlight-host')?.shadowRoot?.querySelector('dialog')?.open);
        const surface = await spotlightSurface(overlayPage); assert.notEqual(surface, overlayPage);
        return { ...sourceRecord, kind };
    };
    const ready = async (page, { entryId = null, title = ARCHIVE_OPEN_TITLE } = {}) => {
        const surface=await spotlightSurface(page),query=entryId?title.replace(/^Reopen /,''):OPEN_QUERY;
        activeSearch={page,surface,query,entryId,title};
        await surface.evaluate(installArchiveSelectionObservation);
        await checkpoint('archive-selection-before-typing',{query,entryId,title,selection:await surface.evaluate(readArchiveSelectionEvidence)});
        await search(page,query);
        const type = entryId ? ARCHIVE_ENTRY_TYPE : ARCHIVE_OPEN_TYPE;
        const rows = await poll(() => surface.evaluate(readArchiveRows), rows => rows.some(row => row.type === type && row.entryId === entryId && row.title === title && row.visible), 'exact visible Archive action result');
        await checkpoint('archive-selection-before-default-Enter-assertion',{query,entryId,title,selection:await surface.evaluate(readArchiveSelectionEvidence)});
        if (!entryId) assertMatchedActionFirst(await surface.evaluate(readSpotlightRows), { type, title, query: OPEN_QUERY });
        else {
            const input = await surface.$('[data-testid="spotlight-input"]'); assert(input);
            try { await selectResultWithKeyboard(input, () => surface.evaluate(readArchiveRows), row => row.type === type && row.entryId === entryId); } finally { await input.dispose(); }
        }
        await surface.evaluate(installArchiveInputObservation);
        return { surface, rows, type, title, entryId };
    };
    const invoke = async (current, method) => {
        const { surface, type, title, entryId } = current;
        if (method === 'Enter') { const input = await surface.$('[data-testid="spotlight-input"]'); assert(input); try { await input.press('Enter'); } finally { await input.dispose(); } }
        else await clickFreshResult(async timeout => {
            await surface.waitForSelector(`[data-result-type="${type}"]`, { visible: true, timeout });
            const handle = await surface.evaluateHandle(({ type, title, entryId }) => {
                const found = [...document.querySelectorAll('[data-testid="spotlight-result"]')].filter(row => row.dataset.resultType === type && (row.dataset.archiveEntryId || null) === entryId && row.querySelector('.arcify-spotlight-result-title')?.textContent === title);
                if (found.length !== 1) throw new Error('Require exact unique Archive result identity.'); return found[0];
            }, { type, title, entryId }); assert(handle.asElement()); return handle.asElement();
        }, observation => checkpoint('fresh-archive-result-click', { type, entryId, observation }));
    };
    try {
        await option(false); await apiPage.evaluate(installSpotlightActionApiObservation); await spotlightOptions.evaluate(installSpotlightActionApiObservation);
        await apiPage.evaluate(installArchiveFixtureMessageObservation);
        fixtureApi = await createNavigationFixturePage({ browser, apiPage, observePage, poll, windowId,
            url: `chrome-extension://${arcifyId}/options.html?paired-archive-fixture=${nonce}` });
        owned.push(fixtureApi.tab.id);
        fixtureApi.source = assertArchiveFixtureSource(await fixtureApi.page.evaluate(readArchiveFixtureSource), {
            arcifyId, windowId, tabId: fixtureApi.tab.id, url: fixtureApi.url });
        const setupBefore = await settle(); await reset();
        const wrongWindowRequest = { type: 'favoriteStore', action: 'get', windowId: otherWindow };
        const wrongWindowResponse = await sendArchiveFixtureRequest(fixtureApi, wrongWindowRequest);
        assert.deepEqual(wrongWindowResponse, { success: false, code: 'UNAUTHORIZED', error: 'Invalid Favorites sender.' });
        const setupAfter = await read(), setupObserved = await trace();
        const wrongWindowSender = assertArchiveFixtureSender(setupObserved.events, wrongWindowRequest, fixtureApi.source);
        assertArchiveNoMutation(setupBefore, setupAfter, setupObserved.events);
        await checkpoint('owned-archive-fixture-source-verified', { source: fixtureApi.source, wrongWindowRequest, wrongWindowResponse,
            wrongWindowSender, before: setupBefore, after: setupAfter, observed: setupObserved });
        const root = await apiPage.evaluate(async () => { const roots = (await chrome.bookmarks.search({ title: 'Arcify' })).filter(node => !node.url); if (roots.length !== 1) throw new Error('Require one exact Arcify root.'); return roots[0]; });
        for (const name of ['Selected', 'Original']) { const folder = await apiPage.evaluate(options => chrome.bookmarks.create(options), { parentId: root.id, title: `Archive ${name} ${nonce}` }); spaceRoots.push(folder.id); }
        const discovered = await local({ action: 'get' }); [source, target] = spaceRoots.map(id => exact(discovered.spaces, id, 'bookmarkFolderId'));
        const seed = async (role, spaceId = source.id, atWindow = windowId, url = `${fixture.base}/spotlight-archive/${nonce}/${role}`) => {
            const result = await createNavigationFixturePage({ browser, apiPage, observePage, poll, windowId: atWindow, url }); owned.push(result.tab.id); pages.set(result.tab.id, result.page);
            await result.page.waitForSelector('#action-page-state'); await local({ action: 'assign', tabId: result.tab.id, spaceId });
            await ui(result.page, 'Preserve exact existing Archive fixture document state', () => result.page.type('#action-page-state', `-${result.tab.id}`)); return result;
        };
        const current = await seed('source');
        const sameUrl = `${fixture.base}/spotlight-archive/${nonce}/same-address`;
        const decoy = await seed('same-address', source.id, otherWindow, sameUrl);
        const pin = await apiPage.evaluate(options => chrome.bookmarks.create(options), { parentId: source.bookmarkFolderId, title: `Saved archive twin ${nonce}`, url: sameUrl }); roots.push(pin.id);
        const pinned = await openSavedPage({ windowId: otherWindow, spaceId: source.id, bookmarkId: pin.id, url: sameUrl }); owned.push(pinned.tab.id); pages.set(pinned.tab.id, pinned.page); await pinned.page.waitForSelector('#action-page-state');
        await activate(current.tab.id); await local({ action: 'activate', windowId, spaceId: source.id });
        const favoriteRequest = { action: 'addBookmark', windowId, spaceId: source.id, bookmarkFolderId: source.bookmarkFolderId, bookmarkId: pin.id, parentId: source.bookmarkFolderId };
        const savedFavorite = await favorite(favoriteRequest);
        const item = savedFavorite.favorites.filter(item => item.sourceBookmarkId === pin.id); assert.equal(item.length, 1); favoriteIds.push(item[0].id); owned.push(savedFavorite.tab.id);
        const favoriteSender = assertArchiveFixtureSender((await trace()).events, { type: 'favoriteStore', ...favoriteRequest }, fixtureApi.source);
        await checkpoint('owned-archive-favorite-setup', { source: fixtureApi.source, request: favoriteRequest, sender: favoriteSender, favoriteId: item[0].id, tabId: savedFavorite.tab.id });
        const now = Date.now();
        entries = [
            { entryId: `archive-first-${nonce}`, name: `Archive first twin ${nonce}`, url: sameUrl, spaceId: target.id, archivedAt: now, proof: { nonce, identity: 'first' } },
            { entryId: `archive-second-${nonce}`, name: `Archive second twin ${nonce}`, url: sameUrl, spaceId: target.id, archivedAt: now - 1, proof: { nonce, identity: 'second' } },
            { entryId: `archive-uncertain-${nonce}`, name: `Archive uncertain ${nonce}`, url: sameUrl, spaceId: target.id, archivedAt: now - 2, proof: { nonce, identity: 'uncertain' } }
        ];
        // Legacy same-address records are seeded through the sole store's exact
        // compare-and-replace API. No runtime outcome or response is fabricated.
        const beforeEntries = await archive({ action: 'list' });
        await archive({ action: 'replace', expected: beforeEntries, entries: [...entries, ...beforeEntries] });
        await activate(current.tab.id); await local({ action: 'activate', windowId, spaceId: source.id }); await settle();
        await checkpoint('owned-archive-fixture', { source, target, entries, sourceTabId: current.tab.id, decoyTabId: decoy.tab.id, savedPinTabId: pinned.tab.id, bookmarkId: pin.id, favoriteId: item[0].id });
        await run({ ...adapters, windowId, otherWindow, nonce, source, target, entries, current, evidence, checkpoint, local, archive, read, settle, reset, trace, capture, activate, sourcePage, ready, invoke, owned,
            markRevoked: () => { revoked = true; } });
        evidence.complete = true; await checkpoint('archive-case-complete'); return evidence;
    } catch (error) { primaryError = error; await checkpoint('archive-case-failed', { error: { message: error.message, stack: error.stack }, owned, roots }).catch(() => {}); throw error; }
    finally {
        if(activeSearch){
            let selection;try{selection=await activeSearch.surface.evaluate(readArchiveSelectionEvidence);}catch(error){selection={error:archiveFailureError(error)};}
            await checkpoint('archive-selection-before-cleanup',{query:activeSearch.query,entryId:activeSearch.entryId,title:activeSearch.title,selection}).catch(()=>{});
        }
        await finishBookmarkFixture([
            async () => { if (revoked) { await ui(apiPage, 'Restore exact Archive fixture pairing', async () => { const field = await apiPage.$('#bridgePeerId'); assert(field); try { await replaceInputText(apiPage, field, spotlightId); } finally { await field.dispose(); } await apiPage.click('#bridgeSave'); }); await apiPage.waitForSelector('#bridgeStatus[data-state="connected"]'); } },
            async () => { if (adapters.nativePanel && (await adapters.nativePanel.state()).contexts.length) await adapters.nativePanel.close(); },
            closeOverlay,
            async () => { for (const id of favoriteIds) await favorite({ action: 'remove', windowId, favoriteId: id }); },
            async () => { for (const [id, spaceId] of Object.entries(original.session.activeSpaces || {})) await local({ action: 'activate', windowId: Number(id), spaceId }); },
            () => apiPage.evaluate(async ids => { const live = new Set((await chrome.tabs.query({})).map(tab => tab.id)); const present = [...new Set(ids)].filter(id => live.has(id)); if (present.length) await chrome.tabs.remove(present); }, owned.filter(id => id !== fixtureApi?.tab.id)),
            async () => { if (!entries) return; const existing = await archive({ action: 'list' }); await archive({ action: 'replace', expected: existing, entries: existing.filter(entry => !entries?.some(owned => owned.entryId === entry.entryId)) }); },
            async () => { if (fixtureApi) await apiPage.evaluate(id => chrome.tabs.remove(id), fixtureApi.tab.id); },
            () => apiPage.evaluate(() => globalThis.__archiveFixtureMessageStop?.()),
            () => apiPage.evaluate(async ({ original, ids }) => { const claims = (await chrome.storage.local.get('archiveReopenClaims')).archiveReopenClaims; if (claims?.entries) { const kept = Object.fromEntries(Object.entries(claims.entries).filter(([id]) => !ids.includes(id))); const previous = original.archiveReopenClaims; if (JSON.stringify(kept) !== JSON.stringify(previous?.entries || {})) throw new Error('Cleanup refuses changed unrelated archive claims.'); if (Object.hasOwn(original, 'archiveReopenClaims')) await chrome.storage.local.set({ archiveReopenClaims: previous }); else await chrome.storage.local.remove('archiveReopenClaims'); } const archived = (await chrome.storage.local.get('archivedTabs')).archivedTabs || []; if (JSON.stringify(archived) !== JSON.stringify(original.archivedTabs || [])) throw new Error('Cleanup refuses changed unrelated archive records.'); if (!Object.hasOwn(original, 'archivedTabs')) await chrome.storage.local.remove('archivedTabs'); }, { original: original.local, ids: entries?.map(entry => entry.entryId) || [] }),
            () => apiPage.evaluate(async original => { if (Object.hasOwn(original, 'archiveBrowserSession')) await chrome.storage.session.set({ archiveBrowserSession: original.archiveBrowserSession }); else await chrome.storage.session.remove('archiveBrowserSession'); }, original.session),
            () => apiPage.evaluate(async ids => { for (const id of ids) { const [node] = await chrome.bookmarks.get(id); if (!node?.url) throw new Error('Cleanup refuses unexpected folder.'); await chrome.bookmarks.remove(id); } }, roots),
            async () => { const state = await local({ action: 'get' }); for (const space of state.spaces.filter(space => spaceRoots.includes(space.bookmarkFolderId))) { assert([...space.temporaryTabs, ...space.spaceBookmarks].every(id => owned.includes(id)), 'Cleanup refuses unowned membership.'); await local({ action: 'delete', spaceId: space.id }); } },
            () => apiPage.evaluate(async ids => { for (const id of ids) { let nodes; try { nodes = await chrome.bookmarks.getSubTree(id); } catch { continue; } const [node] = nodes; if (!node || node.url || node.children?.length) throw new Error('Cleanup refuses unexpected nonempty Space root.'); await chrome.bookmarks.removeTree(id); } }, spaceRoots),
            () => option(Boolean(original.sync.syncTabGroups)),
            () => apiPage.evaluate(async original => { if (!Object.hasOwn(original, 'syncTabGroups')) await chrome.storage.sync.remove('syncTabGroups'); }, original.sync),
            // Settings UI selects its own tab. Restore exact original native tabs only
            // after the last UI operation. Native activation may select its owning
            // Space, so restore the independent original selections afterward too.
            async () => { for (const tab of original.tabs.filter(tab => tab.active)) await apiPage.evaluate(id => chrome.tabs.update(id, { active: true }), tab.id);
                for (const [id, spaceId] of Object.entries(original.session.activeSpaces || {})) await local({ action: 'activate', windowId: Number(id), spaceId }); },
            async () => { const focused = original.windows.find(window => window.focused); if (focused) await apiPage.evaluate(id => chrome.windows.update(id, { focused: true }), focused.id); },
            async () => { await local({ action: 'get' }); const final = await apiPage.evaluate(async () => ({ tabs: await chrome.tabs.query({}), local: await chrome.storage.local.get(['archivedTabs', 'archiveReopenClaims']), session: await chrome.storage.session.get('activeSpaces') })); await checkpoint('archive-cleanup-observed', { original, final }); assert.deepEqual(final.local, original.local); assert.deepEqual(final.session.activeSpaces, original.session.activeSpaces); assert.deepEqual(final.tabs.map(tab => tab.id).sort((a, b) => a - b), original.tabs.map(tab => tab.id).sort((a, b) => a - b)); for (const tab of original.tabs) { const kept = exact(final.tabs, tab.id); for (const key of ['windowId', 'url', 'pinned', 'incognito', 'active', 'splitViewId']) assert.equal(kept[key], tab[key], `Cleanup preserves original native tab ${tab.id} ${key}.`); } await checkpoint('archive-cleanup-verified', { final }); }
        ], primaryError, failure => checkpoint('archive-cleanup-failed', { errors: failure.errors }));
    }
}

/** Observe a newly written status; identical stale text is not a new success. */
export function installArchiveStatusObservation() {
    globalThis.__archiveStatusObservation?.stop();
    const label = document.querySelector('.arcify-bridge-status [role="status"]');
    if (!label) throw new Error('Archive success status node is missing.');
    const events = [], observer = new MutationObserver(() => events.push({ text: label.textContent, connected: label.isConnected }));
    observer.observe(label, { childList: true, characterData: true, subtree: true });
    globalThis.__archiveStatusObservation = { events, stop: () => observer.disconnect() };
}

/** Already-open proof keeps the original real native opening and requires a new one-use intent. */
export async function exerciseArchiveExistingPanel({ nativePanel, origin, previousRequest, previousAck, previousNative, openingEventCount,
    arcifyId, spotlightId, source, ready, invoke, settle, read, reset, trace, capture, checkpoint, ui, poll, windowId }) {
    await ui(origin.page, 'Open Archive again in the same existing native Side Panel', async () => {
        const selected = await ready(origin.page), before = await settle(), sourceNative = exact(before.tabs, origin.tab.id);
        const documentBefore = await origin.page.evaluate(() => ({ url: document.URL, timeOrigin: performance.timeOrigin }));
        const panelBefore = await nativePanel.state(), preparation = await trace(); await reset();
        await capture(origin.page, 'existing-panel-open-selected');
        await selected.surface.evaluate(installArchiveStatusObservation);
        let statusWrites;
        try {
            await invoke(selected, 'Enter');
            await selected.surface.waitForFunction(() => globalThis.__archiveStatusObservation.events.some(event => event.connected && event.text === 'Arcify Archive opened.'), { polling: 50 });
            statusWrites = await selected.surface.evaluate(() => globalThis.__archiveStatusObservation.events);
        } finally { await selected.surface.evaluate(() => globalThis.__archiveStatusObservation?.stop()); }
        assert.deepEqual(statusWrites, [{ text: 'Arcify Archive opened.', connected: true }], 'A fresh successful reply must write the real renderer status exactly once.');
        const status = await selected.surface.$eval('.arcify-bridge-status [role="status"]', node => node.textContent);
        assert.equal(status, 'Arcify Archive opened.');
        // Reuse the first actual onOpened receipt only after proving that its
        // exact context/document survived. This is never a fresh-opening claim.
        const panelAfter = await nativePanel.state(); assert.deepEqual(panelAfter, panelBefore, 'Existing-panel reuse cannot manufacture another native opening or replace the document.');
        const native = await nativePanel.capture(openingEventCount, 'Archive existing native Side Panel reuse');
        assert.deepEqual(native.context, previousNative.context); assert.deepEqual(native.hosting, previousNative.hosting);
        const { page } = await nativePanel.resolve();
        const popup = await poll(() => page.evaluate(readNativeArchivePopup), state => {
            try { assertNativeArchivePopup(state, { arcifyId, spaceId: source.id, entries: before.archivedTabs }); return true; } catch { return false; }
        }, 'existing Archive popup remains visible after a fresh genuine action');
        const after = await read(), observed = await trace(origin.page);
        observed.events.unshift(...preparation.events.filter(event => event.type === 'external' && event.data.message.command === 'archiveContext'));
        assertArchiveNoMutation(before, after, observed.events);
        assertArchiveTrustedInput(observed.input, { type: ARCHIVE_OPEN_TYPE, title: ARCHIVE_OPEN_TITLE, method: 'Enter' });
        const request = assertArchiveOpenRequest(observed.events, { spotlightId, sourceTabId: origin.tab.id, windowId, sourceUrl: sourceNative.url });
        assert.notEqual(request.token, previousRequest.token); assert.notEqual(request.requestId, previousRequest.requestId);
        const nativeAck = assertArchiveNativeAck(observed.events, request, native, { arcifyId, windowId });
        assert.equal(nativeAck.acknowledgement.data.portId, previousAck.acknowledgement.data.portId);
        assert.equal(nativeAck.acknowledgement.data.message.session, previousAck.acknowledgement.data.message.session);
        assert.deepEqual(await origin.page.evaluate(() => ({ url: document.URL, timeOrigin: performance.timeOrigin })), documentBefore);
        const popupScreenshot = await capture(page, 'existing-panel-native-archive-popup'); assert(popupScreenshot?.filename);
        const popupAfterCapture = await page.evaluate(readNativeArchivePopup); assert.deepEqual(popupAfterCapture, popup);
        assert.deepEqual(await nativePanel.state(), panelBefore); assert.deepEqual(await read(), before);
        await checkpoint('trusted-existing-native-archive-open', { before, after, sourceTabId: origin.tab.id, documentBefore, panelBefore, panelAfter,
            observed, request, nativeAck, native, popup, popupAfterCapture, status, statusWrites, popupScreenshot });
    });
}

export async function exerciseSpotlightArchiveOpen(adapters) {
    for (const name of ['prepare', 'state', 'capture', 'resolve', 'close']) assert.equal(typeof adapters.nativePanel?.[name], 'function');
    let displayObserver, primaryError;
    try { return await archiveFixture(adapters, async ({ browser, observePage, nativePanel, apiPage, spotlightOptions, arcifyId, spotlightId, current, source, entries, windowId, otherWindow, owned, evidence,
        checkpoint, sourcePage, ready, invoke, read, settle, trace: fixtureTrace, capture, ui, poll, external, reset }) => {
        // Fixture setup has just used the genuine store; observe that existing
        // worker before any display request, without waking a worker ourselves.
        displayObserver = await observeArchiveDisplayWorker({ browser, arcifyId, observerId: randomBytes(16).toString('hex') });
        const trace = async page => {
            const observed = await fixtureTrace(page), displayRoute = await displayObserver.read();
            return { ...observed, events: [...observed.events, ...displayRoute.events], displayRoute };
        };
        await nativePanel.prepare(); assert.deepEqual((await nativePanel.state()).contexts, []);
        // This ordinary tab is an explicitly labeled rejection probe. It is
        // removed before any positive native target or screenshot is resolved.
        const ordinary = await createNavigationFixturePage({ browser, apiPage, observePage, poll, windowId,
            url: `chrome-extension://${arcifyId}/sidebar.html` }); owned.push(ordinary.tab.id);
        try {
            const hosting = await ordinary.page.evaluate(async () => ({ tab: await chrome.tabs.getCurrent(), windowId: (await chrome.windows.getCurrent()).id }));
            assert.equal(hosting.tab.id, ordinary.tab.id); assert.equal(hosting.windowId, windowId);
            for (const claimedWindow of [windowId, otherWindow]) {
                const before = await settle(); await reset(); const observationOffset = (await displayObserver.read()).events.length;
                const response = await ordinary.page.evaluate(probeArchiveDisplayRegistration, { windowId: claimedWindow, requestId: `ordinary-sidebar-${claimedWindow}` });
                assert.equal(response.disconnected, true); assert.deepEqual(response.messages, []);
                const after = await read(), observed = await trace(); assertArchiveNoMutation(before, after, observed.events);
                const connections = observed.displayRoute.events.slice(observationOffset).filter(event => event.type === 'archive.port-connect' && event.data.sender.tab?.id === ordinary.tab.id);
                assert.equal(connections.length, 1); const connection = connections[0]; assert.equal(connection.data.sender.id, arcifyId); assert.equal(connection.data.sender.tab.windowId, windowId);
                assert.equal(connection.data.sender.url, `chrome-extension://${arcifyId}/sidebar.html`);
                assert.deepEqual((await nativePanel.state()).contexts, []);
                assert.deepEqual((await ordinary.page.evaluate(readNativeArchivePopup)).popups, []);
                await checkpoint('ordinary-sidebar-display-port-rejected', { claimedWindow, hosting, response, connection, before, after, observed });
            }
        } finally { await apiPage.evaluate(id => chrome.tabs.remove(id), ordinary.tab.id); }
        assert(!((await read()).tabs.some(tab => tab.id === ordinary.tab.id)), 'The rejection-only ordinary sidebar tab must be retired before native acceptance.');
        for (const kind of ['owned-newtab', 'browser-newtab', 'overlay']) for (const method of ['click', 'Enter']) {
            const origin = await sourcePage(kind, current), selected = await ready(origin.page), attempt = {};
            await withArchiveFailureEvidence(() => ui(origin.page, `Open Archive with trusted ${method} from ${kind}`, async () => {
                const before = await settle(), sourceNative = exact(before.tabs, origin.tab.id);
                const documentBefore = await origin.page.evaluate(() => ({ url: document.URL, timeOrigin: performance.timeOrigin }));
                const eventCount = (await nativePanel.state()).events.length;
                const preparation = await trace(); await reset();
                attempt.baseline = { before, documentBefore, eventCount, preparation };
                await capture(origin.page, `${kind}-${method}-open-selected`);
                await invoke(selected, method);
                // An explicit fixture interaction reveals the already-selected
                // long Space chip. The shared helper proves one trusted wheel
                // and unchanged native selection/ownership; capture stays read-only.
                const { page } = await nativePanel.resolve();
                attempt.nativePage = page;
                const reveal = await revealNativeSidebarSpace({ page, poll, extensionId: arcifyId, windowId, spaceId: source.id });
                await checkpoint('native-archive-selected-space-revealed', { kind, method, reveal });
                // The established adapter proves SIDE_PANEL context, native onOpened,
                // no regular sidebar tab, nontrivial viewport and exact PNG pixels.
                const native = await nativePanel.capture(eventCount, `Archive ${kind} ${method} native Side Panel`);
                const popup = await poll(() => page.evaluate(readNativeArchivePopup), state => {
                    try { assertNativeArchivePopup(state, { arcifyId, spaceId: source.id, entries: before.archivedTabs }); return true; } catch { return false; }
                }, 'existing global Archive popup visible inside the actual native Side Panel');
                await selected.surface.waitForFunction(() => document.querySelector('.arcify-bridge-status [role="status"]')?.textContent === 'Arcify Archive opened.', { polling: 50 });
                const status = await selected.surface.$eval('.arcify-bridge-status [role="status"]', node => node.textContent);
                const after = await read(), observed = await trace(origin.page);
                observed.events.unshift(...preparation.events.filter(event => event.type === 'external' && event.data.message.command === 'archiveContext'));
                assert.deepEqual(after, before, 'Opening Archive must preserve every original native, saved and archived identity.');
                assert.deepEqual(mutationEvents(observed.events), []);
                assertArchiveTrustedInput(observed.input, { type: ARCHIVE_OPEN_TYPE, title: ARCHIVE_OPEN_TITLE, method });
                const request = assertArchiveOpenRequest(observed.events, { spotlightId, sourceTabId: origin.tab.id, windowId, sourceUrl: sourceNative.url });
                const nativeAck = assertArchiveNativeAck(observed.events, request, native, { arcifyId, windowId });
                assert.deepEqual(await origin.page.evaluate(() => ({ url: document.URL, timeOrigin: performance.timeOrigin })), documentBefore);
                const popupScreenshot = await capture(page, `${kind}-${method}-native-archive-popup`); assert(popupScreenshot?.filename);
                const popupAfterCapture = await page.evaluate(readNativeArchivePopup); assert.deepEqual(popupAfterCapture, popup);
                evidence.matrix.push({ kind, method, sourceTabId: origin.tab.id, nativeContextId: native.context.contextId, entryIds: popup.popups[0].entries.map(entry => entry.entryId) });
                await checkpoint('trusted-native-archive-open', { kind, method, before, after, documentBefore, observed, request, native, nativeAck, popup, popupAfterCapture, status, popupScreenshot });
                if (kind === 'owned-newtab' && method === 'click') {
                    await exerciseArchivePopupButtonRoundTrip({ page, arcifyId, spaceId: source.id,
                        entries: before.archivedTabs, ui, poll, settle, read, reset, trace, capture, checkpoint });
                    await exerciseArchiveExistingPanel({ nativePanel, origin, previousRequest: request, previousAck: nativeAck, previousNative: native,
                        openingEventCount: eventCount, arcifyId, spotlightId, source, ready, invoke, settle, read, reset, trace, capture, checkpoint, ui, poll, windowId });
                }
            }), () => collectArchiveOpenFailure({ sourcePage: origin.page, sourceSurface: selected.surface,
                nativePage: attempt.nativePage, nativePanel, trace: () => trace() }),
            failure => checkpoint('archive-open-attempt-failed', { kind, method, sourceTabId: origin.tab.id, baseline: attempt.baseline || null, ...failure }));
            await nativePanel.close();
        }
        // A real same-extension renderer with a fresh source-bound intent still
        // cannot turn a non-gesture protocol send into an accepted native open.
        const origin = await sourcePage('owned-newtab', current); await ready(origin.page);
        const probe = await probeArchiveOpenWithoutGesture({ page: origin.page, poll, arcifyId, requestId: `archive-no-gesture-${evidence.nonce}`,
            prepare: () => external(spotlightOptions, arcifyId, 'archiveContext', { windowId, tabId: origin.tab.id, supportedFeatures: ARCHIVE_FEATURES }),
            baseline: async () => { const before = await settle(); await reset(); return { before, panel: await nativePanel.state() }; } });
        const { before, panel } = probe.baseline, after = await read(), observed = await trace(), panelAfter = await nativePanel.state();
        // Retain the actual activation, raw reply and native result even when
        // the strict gesture/refusal assertion fails. No failed send is retried.
        await checkpoint('non-gesture-archive-open-observed', { probe, after, observed, panelAfter });
        assertArchiveNoGestureRejection(probe); assertArchiveNoMutation(before, after, observed.events);
        assert.deepEqual(panel.contexts, []); assert.deepEqual(panelAfter.contexts, []); assert.deepEqual(panelAfter.events, panel.events);
        await checkpoint('non-gesture-archive-open-rejected', { before, after, response: probe.response, probe, observed });
        assert.equal(evidence.matrix.length, 6);
    }); } catch (error) { primaryError = error; throw error; }
    finally { if (displayObserver) await finishBookmarkFixture([() => displayObserver.stop()], primaryError); }
}

export async function exerciseSpotlightArchiveReopen(adapters) {
    return archiveFixture(adapters, async ({ browser, observePage, apiPage, spotlightOptions, arcifyId, spotlightId, current, source, target, entries, windowId, evidence, owned,
        checkpoint, local, sourcePage, ready, invoke, read, settle, trace, capture, ui, poll, external, reset, markRevoked }) => {
        const requests = [];
        // Same URL and original Space are deliberate twins; each activation must
        // consume only its exact durable record while preserving the other.
        for (const [entry, kind, method] of [[entries[1], 'browser-newtab', 'Enter'], [entries[0], 'overlay', 'click']]) {
            const origin = await sourcePage(kind, current), title = `Reopen ${entry.name}`;
            const selected = await ready(origin.page, { entryId: entry.entryId, title }), attempt = {};
            await withArchiveFailureEvidence(() => ui(origin.page, `Reopen exact archived twin with trusted ${method}`, async () => {
                const before = await settle(); await reset();
                attempt.baseline = before;
                await capture(origin.page, `${kind}-exact-entry-selected`);
                const beforeTargets = new Set(browser.targets());
                await invoke(selected, method);
                const after = await poll(read, state => state.claims?.entries?.[entry.entryId]?.phase === 'consumed' && !state.archivedTabs.some(item => item.entryId === entry.entryId)
                    && state.tabs.some(tab => tab.id === state.claims.entries[entry.entryId].tabId && tab.active && tab.url === entry.url && !tab.pendingUrl), 'exact archive consumption and known created native ID active');
                const observed = await trace(origin.page);
                assertArchiveTrustedInput(observed.input, { type: ARCHIVE_ENTRY_TYPE, title, entryId: entry.entryId, method });
                const { request, receipt, status, overlayRetired } = await waitForArchiveReopenCompletion({ page: origin.page, surface: selected.surface, kind, spaceName: target.name,
                    events: observed.events, expected: { spotlightId, sourceTabId: origin.tab.id, windowId, entryId: entry.entryId },
                    verifyCommitted: () => { const receipt = assertArchiveReopened(before, after, observed.events, { entry: { ...entry, bookmarkFolderId: target.bookmarkFolderId }, sourceWindowId: windowId, selectedSpaceId: source.id }); owned.push(receipt.tabId); return receipt; } });
                requests.push(request);
                evidence.matrix.push({ kind, method, entryId: entry.entryId, tabId: receipt.tabId, sourceTabId: origin.tab.id, originalSpaceId: target.id });
                await checkpoint('exact-archive-entry-reopened', { kind, method, before, after, observed, request, receipt, status, overlayRetired });
                const destination = await captureArchiveReopenedDestination({ browser, apiPage, observePage, poll, beforeTargets, before, receipt, windowId, url: entry.url,
                    capture, settle, read, trace, label: `${kind}-exact-reopened-destination` });
                await checkpoint('exact-reopened-destination-captured', { kind, method, entryId: entry.entryId, destination });
            }), () => collectArchiveReopenFailure({ apiPage, spotlightOptions, sourcePage: origin.page, sourceSurface: selected.surface,
                spotlightId, entryId: entry.entryId, windowId, sourceTabId: origin.tab.id }),
            failure => checkpoint('archive-reopen-attempt-failed', { kind, method, entryId: entry.entryId, sourceTabId: origin.tab.id,
                windowId, baseline: attempt.baseline || null, ...failure }));
            // Repeating a captured real request exercises the actual receiver;
            // it cannot create or consume a URL twin, even after source activation changed.
            const request = requests.at(-1), before = await settle(); await reset();
            const replay = await external(spotlightOptions, arcifyId, request.command,
                Object.fromEntries(Object.entries(request).filter(([key]) => !['type', 'version', 'requestId', 'command'].includes(key))), request.requestId);
            assertArchiveCachedReplay(replay, request, before, { spotlightId });
            const after = await read(), observed = await trace(); assertArchiveNoMutation(before, after, observed.events);
            await checkpoint('captured-reopen-cached-receipt', { before, after, replay, observed });
            // A different request ID cannot reuse the already-consumed private
            // view. Its exact pending journal receipt is the only allowed write.
            await reset();
            const rejected = await external(spotlightOptions, arcifyId, request.command,
                Object.fromEntries(Object.entries(request).filter(([key]) => !['type', 'version', 'requestId', 'command'].includes(key))));
            assert.equal(rejected?.ok, false); assert.equal(rejected.error?.code, 'STALE_ARCHIVE');
            const afterFresh = await read(), freshObserved = await trace();
            const freshRequest = assertArchiveReopenRequest(freshObserved.events, { spotlightId, sourceTabId: request.context.sourceTabId, windowId, entryId: entry.entryId });
            assert.notEqual(freshRequest.requestId, request.requestId);
            assertArchiveNoMutation(after, afterFresh, freshObserved.events, { pendingRequest: freshRequest, spotlightId });
            await checkpoint('consumed-archive-view-rejected', { before: after, after: afterFresh, rejected, request: freshRequest, observed: freshObserved });
        }
        assert.notEqual(evidence.matrix[0].tabId, evidence.matrix[1].tabId, 'Same-address archive entries must never collapse distinct newly created identities.');

        // Seed only the documented durable crash boundary in this disposable
        // fixture; all subsequent requests, rejection and native read-back are real.
        const uncertain = entries[2];
        const durable = await apiPage.evaluate(async () => ({ sessionId: (await chrome.storage.session.get('archiveBrowserSession')).archiveBrowserSession,
            claims: (await chrome.storage.local.get('archiveReopenClaims')).archiveReopenClaims }));
        assert.equal(typeof durable.sessionId, 'string'); assert(durable.sessionId);
        const claim = { entryId: uncertain.entryId, expected: uncertain, requestId: `uncertain-fixture-${evidence.nonce}`, windowId,
            bookmarkFolderId: target.bookmarkFolderId, sessionId: durable.sessionId, phase: 'creating', tabId: null };
        await apiPage.evaluate(({ claims, entryId, claim }) => chrome.storage.local.set({ archiveReopenClaims: { ...claims, entries: { ...claims.entries, [entryId]: claim } } }), { claims: durable.claims, entryId: uncertain.entryId, claim });
        for (const method of ['click', 'Enter']) {
            const origin = await sourcePage('owned-newtab', current), title = `Reopen ${uncertain.name}`;
            const selected = await ready(origin.page, { entryId: uncertain.entryId, title });
            await ui(origin.page, 'Refuse a duplicate after an uncertain earlier native create', async () => {
                const before = await settle(); await reset(); await invoke(selected, method);
                await selected.surface.waitForFunction(() => { const node = document.querySelector('.arcify-bridge-status'); return node?.textContent?.includes('earlier reopen') || node?.textContent?.includes('could not be confirmed'); }, { polling: 50 });
                const status = await selected.surface.$eval('.arcify-bridge-status', node => node.textContent);
                const after = await read(), observed = await trace(origin.page);
                assertArchiveTrustedInput(observed.input, { type: ARCHIVE_ENTRY_TYPE, title, entryId: uncertain.entryId, method });
                const request = assertArchiveReopenRequest(observed.events, { spotlightId, sourceTabId: origin.tab.id, windowId, entryId: uncertain.entryId });
                assertArchiveNoMutation(before, after, observed.events, { pendingRequest: request, spotlightId }); assert.deepEqual(after.claims.entries[uncertain.entryId], claim);
                await checkpoint('durable-uncertain-create-rejected', { method, before, after, observed, status, screenshot: await capture(origin.page, `uncertain-${method}-error`) });
            });
        }
        // Real receiver stale-view probes do not fake UI contexts or acknowledgements.
        // They are separate from the genuine positive keyboard/click evidence.
        for (const change of ['selected-space', 'pairing']) {
            const origin = await sourcePage('owned-newtab', current);
            const context = await external(spotlightOptions, arcifyId, 'archiveContext', { windowId, tabId: origin.tab.id, supportedFeatures: ARCHIVE_FEATURES });
            assert.equal(context?.ok, true); const scope = context.archiveActions;
            if (change === 'selected-space') await local({ action: 'activate', windowId, spaceId: target.id });
            else { await ui(apiPage, 'Revoke exact paired peer before stale Archive request', () => apiPage.click('#bridgeDisconnect')); markRevoked(); await apiPage.waitForSelector('#bridgeStatus[data-state="disabled"]'); }
            const before = await settle(); await reset();
            const rejection = await external(spotlightOptions, arcifyId, 'reopenArchivedTab', { windowId, context: scope.context, viewId: scope.viewId, entryId: uncertain.entryId, supportedFeatures: ARCHIVE_FEATURES });
            assert.equal(rejection?.ok, false); assert(['STALE_CONTEXT', 'STALE_ARCHIVE', 'STALE_VIEW', 'UNAUTHORIZED', 'DISCONNECTED'].includes(rejection.error?.code), JSON.stringify(rejection));
            const after = await read(), observed = await trace();
            const request = assertArchiveReopenRequest(observed.events, { spotlightId, sourceTabId: origin.tab.id, windowId, entryId: uncertain.entryId });
            assertArchiveNoMutation(before, after, observed.events, change === 'selected-space' ? { pendingRequest: request, spotlightId } : {});
            await checkpoint(`stale-archive-${change}-rejected`, { before, after, rejection, observed });
        }
        assert.equal(evidence.matrix.length, 2);
    });
}
