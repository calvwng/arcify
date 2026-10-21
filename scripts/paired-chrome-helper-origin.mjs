/** Read-only browser New Tab origin evidence, independent of any committed action. */
import assert from 'node:assert/strict';

const CONTEXT_ACTIONS = ['arcifySpaceActionsContext', 'arcifyTabActionsContext'];
const PROBE = 'spotlightNewTabReuseProbe';
const ACK = 'spotlightNewTabReuseAck';
const positiveId = value => Number.isSafeInteger(value) && value > 0;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasTab = sender => sender.tab !== null && sender.tab !== undefined;

function exactKeys(value, keys, label) {
    assert(record(value), `${label} must be an object.`);
    assert.deepEqual(Reflect.ownKeys(value).sort(), [...keys].sort(), `${label} must have exactly the observed product message keys.`);
}

/**
 * The caller must reset its passive observation before creating this helper and
 * capture this evidence before mutation. Array order and exact source identities
 * are the available correlation boundary: the product's context request carries
 * neither a request ID nor a nonce, and the observer records no document ID.
 * This does not prove an action, its response, journal, native effects, or input.
 */
export function assertSpotlightHelperOrigin(state, peerEvents, options) {
    return inspectSpotlightHelperOrigin(state, peerEvents, options).origin;
}

function assertHelperSource(state, { spotlightId, tabId, windowId }) {
    assert.match(spotlightId, /^[a-p]{32}$/, 'Require the exact Spotlight extension ID.');
    assert(positiveId(tabId) && positiveId(windowId), 'Require exact positive source tab and window IDs.');
    assert(record(state) && record(state.tab), 'Require the actual New Tab renderer state.');
    const renderer = `chrome-extension://${spotlightId}/newtab.html`;
    assert.equal(state.url, renderer, 'The document must be the exact owned New Tab renderer.');
    assert(['chrome://newtab', 'chrome://newtab/'].includes(state.tab.url), 'Require the browser-created New Tab alias.');
    assert.equal(state.tab.id, tabId); assert.equal(state.tab.windowId, windowId);
    assert.equal(state.tab.active, true); assert.equal(state.tab.status, 'complete');
    assert(!state.tab.pendingUrl, 'A pending navigation cannot establish helper origin.');
    assert.equal(state.visibility, 'visible');
    return renderer;
}

/** Inspection may defer missing evidence, but must validate every present entry. */
function inspectSpotlightHelperOrigin(state, peerEvents, { spotlightId, tabId, windowId, contextAction }, allowIncomplete = false) {
    const renderer = assertHelperSource(state, { spotlightId, tabId, windowId });
    assert(CONTEXT_ACTIONS.includes(contextAction), 'Require an exact supported renderer context-read action.');
    assert(Array.isArray(peerEvents), 'Require the reset passive observation trace.');
    const pendingReasons = [];

    const rendererSender = (sender, label, sourceTabId = tabId, sourceWindowId = windowId) => {
        assert(record(sender), `${label} requires Chrome sender metadata.`);
        assert.equal(sender.id, spotlightId, `${label} must originate in Spotlight.`);
        assert.equal(sender.url, renderer, `${label} must originate in the exact New Tab document.`);
        assert.equal(sender.frameId, 0, `${label} must originate in the main frame.`);
        assert.equal(sender.documentLifecycle, 'active', `${label} requires an active source document.`);
        if (hasTab(sender)) assert.deepEqual(sender.tab, { id: sourceTabId, windowId: sourceWindowId },
            `${label}: present sender.tab must match exactly; a nonce cannot replace mismatched metadata.`);
        return hasTab(sender);
    };
    const internal = peerEvents.flatMap((event, index) => event?.type === 'internal' ? [{ ...event.data, index }] : []);
    const contexts = [], unrelatedContexts = [];
    for (const entry of internal.filter(({ message }) => message?.action === contextAction)) {
        // Other mounted helpers can refresh even while hidden. A read is in scope
        // if either its request or Chrome's tab metadata names the tested source.
        // A mismatched present sender.tab therefore cannot escape validation.
        if (entry.message.tabId === tabId || entry.sender?.tab?.id === tabId) {
            contexts.push(entry);
            continue;
        }
        // Only separately identifiable, well-formed other-source reads may be
        // excluded. They never contribute source or nonce evidence for this tab.
        exactKeys(entry.message, ['action', 'tabId'], 'Other-source context read');
        assert(positiveId(entry.message.tabId), 'A context read with no identifiable source cannot be excluded.');
        assert(record(entry.sender) && entry.sender.id === spotlightId, 'An excluded context read still requires the real peer sender.');
        if (hasTab(entry.sender)) {
            exactKeys(entry.sender.tab, ['id', 'windowId'], 'Other-source sender.tab');
            assert.equal(entry.sender.tab.id, entry.message.tabId, 'An excluded context read cannot have conflicting source metadata.');
            assert(positiveId(entry.sender.tab.windowId), 'An excluded browser-attested source requires its own window ID.');
        }
        unrelatedContexts.push(entry);
    }
    if (!contexts.length) {
        if (!allowIncomplete) assert.fail('Require at least one real renderer context read, not a URL or an unrelated action.');
        pendingReasons.push('missing-context');
    }
    const missingTabContexts = [];
    for (const context of contexts) {
        exactKeys(context.message, ['action', 'tabId'], 'Context read');
        assert.equal(context.message.tabId, tabId, 'Every selected context read must use this exact source, never an earlier tab.');
        if (!rendererSender(context.sender, 'Context read')) missingTabContexts.push(context);
    }

    const probes = internal.filter(({ message }) => message?.action === PROBE);
    const acknowledgements = internal.filter(({ message }) => message?.action === ACK);
    // Include every partner of a source-relevant nonce, even if that partner's
    // request and sender both claim another source. It cannot be filtered away.
    const relevantNonces = new Set([...probes, ...acknowledgements]
        .filter(entry => entry.message.tabId === tabId || entry.sender?.tab?.id === tabId)
        .map(({ message }) => message.nonce));
    const byNonce = new Map();
    const challengeMessage = (message, action) => {
        exactKeys(message, ['action', 'nonce', 'tabId', 'windowId'], action);
        assert.equal(message.action, action);
        assert.match(message.nonce, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
            'Require the real challenge nonce format.');
        assert(positiveId(message.tabId) && positiveId(message.windowId), 'Every challenge event requires identifiable positive source and window IDs.');
    };
    // Validate ALL observed probes and ACKs, even if every context has sender.tab.
    // Only complete, internally consistent other-source pairs may be excluded.
    // Their native tab state is not inspected or established by this oracle.
    for (const probe of probes) {
        challengeMessage(probe.message, PROBE);
        const relevant = relevantNonces.has(probe.message.nonce);
        const sourceTabId = relevant ? tabId : probe.message.tabId;
        const sourceWindowId = relevant ? windowId : probe.message.windowId;
        assert.equal(probe.message.tabId, sourceTabId, 'Every relevant challenge event must name this exact source tab.');
        assert.equal(probe.message.windowId, sourceWindowId, 'Every relevant challenge event must name this exact source window.');
        assert(record(probe.sender), 'The probe requires Chrome sender metadata.');
        assert.equal(probe.sender.id, spotlightId);
        assert(!hasTab(probe.sender), 'The probe must come from the worker, never another tab.');
        assert(probe.sender.url === null || probe.sender.url === `chrome-extension://${spotlightId}/background.js`,
            'The probe must come from the real worker; only Chrome\'s normalized absent worker URL is allowed.');
        assert(!byNonce.has(probe.message.nonce), 'Every observed probe nonce must be unique.');
        byNonce.set(probe.message.nonce, { probe, acknowledgement: null, relevant, sourceTabId, sourceWindowId });
    }
    for (const acknowledgement of acknowledgements) {
        challengeMessage(acknowledgement.message, ACK);
        const pair = byNonce.get(acknowledgement.message.nonce);
        assert(pair, 'Every observed ACK must belong to a real observed probe.');
        assert.equal(acknowledgement.message.tabId, pair.sourceTabId, 'Every ACK must name its exact nonce-bound source tab.');
        assert.equal(acknowledgement.message.windowId, pair.sourceWindowId, 'Every ACK must name its exact nonce-bound source window.');
        rendererSender(acknowledgement.sender, 'Acknowledgement', pair.sourceTabId, pair.sourceWindowId);
        assert.equal(pair.acknowledgement, null, 'Each observed probe must receive exactly one ACK.');
        assert(acknowledgement.index > pair.probe.index, 'An ACK must follow its exact observed nonce probe.');
        pair.acknowledgement = acknowledgement;
    }
    const pairs = [...byNonce.values()];
    if (!pairs.every(pair => pair.acknowledgement)) {
        if (!allowIncomplete) assert.fail('Every observed probe must have a complete independent ACK.');
        pendingReasons.push('missing-ack');
    }
    const relevantPairs = pairs.filter(pair => pair.relevant), unrelatedPairs = pairs.filter(pair => !pair.relevant);
    for (const context of missingTabContexts) {
        // Concurrent reads can share this trace window. Do not invent a one-to-one
        // context/nonce mapping or require one nonce per refresh: none is emitted.
        if (!relevantPairs.some(({ probe, acknowledgement }) => acknowledgement && probe.index > context.index)) {
            if (!allowIncomplete) assert.fail('Without sender.tab, require a complete real probe/ACK after the matching context read; earlier proof is stale.');
            pendingReasons.push('missing-later-source-pair');
        }
    }
    if (pendingReasons.length) return { complete: false, pendingReasons: [...new Set(pendingReasons)] };
    return { complete: true, origin: {
        proofKind: missingTabContexts.length ? 'nonce-challenge-ack' : 'browser-attested-sender-tab',
        evidenceScope: 'pre-mutation-helper-origin',
        contextAction, contextReadCount: contexts.length, unrelatedContextReadCount: unrelatedContexts.length,
        renderer, browserUrl: state.tab.url, tabId, windowId,
        nonces: relevantPairs.map(({ probe }) => probe.message.nonce),
        unrelatedNoncePairCount: unrelatedPairs.length,
        correlation: {
            kind: 'reset-trace-order-and-exact-source',
            contextEventIndexes: contexts.map(({ index }) => index),
            unrelatedContextEventIndexes: unrelatedContexts.map(({ index }) => index),
            noncePairs: relevantPairs.map(({ probe, acknowledgement }) => ({
                nonce: probe.message.nonce, probeEventIndex: probe.index, acknowledgementEventIndex: acknowledgement.index
            })),
            unrelatedNoncePairs: unrelatedPairs.map(({ probe, acknowledgement, sourceTabId, sourceWindowId }) => ({
                nonce: probe.message.nonce, tabId: sourceTabId, windowId: sourceWindowId,
                probeEventIndex: probe.index, acknowledgementEventIndex: acknowledgement.index
            })),
            contextRequestIdAvailable: false,
            browserDocumentIdAvailable: false,
            oneToOneContextNonceCorrelationAvailable: false
        }
    } };
}

/**
 * Await only append-only passive evidence through the harness's bounded poll.
 * No context resend, mutation, input, controller call, timer, or separate retry.
 */
export async function collectSpotlightHelperOrigin({ initialState, read, poll, spotlightId, tabId, windowId, contextAction }) {
    assert.equal(typeof read, 'function'); assert.equal(typeof poll, 'function');
    const options = { spotlightId, tabId, windowId, contextAction };
    assert(CONTEXT_ACTIONS.includes(contextAction), 'Require an exact supported renderer context-read action.');
    const identity = state => {
        assertHelperSource(state, options);
        assert(Number.isFinite(state.timeOrigin) && state.timeOrigin > 0, 'Require the real positive renderer timeOrigin.');
        return { url: state.url, timeOrigin: state.timeOrigin, tabId: state.tab.id,
            windowId: state.tab.windowId, browserUrl: state.tab.url };
    };
    const baseline = identity(initialState);
    let previousEvents = [], accepted;
    const readValidated = async () => {
        const value = await read();
        assert(record(value), 'The passive read must return state and peerEvents.');
        assert.deepEqual(identity(value.state), baseline, 'The helper source and document must remain identical to the pre-collection snapshot.');
        assert(Array.isArray(value.peerEvents), 'Require the entire passive observation trace.');
        assert(value.peerEvents.length >= previousEvents.length, 'The passive trace must never drop observed events.');
        assert.deepEqual(value.peerEvents.slice(0, previousEvents.length), previousEvents,
            'The entire observed prefix must remain unchanged; no dropped, reordered, or rewritten evidence.');
        // Retain our own copy: an observer reusing and changing an array cannot
        // rewrite the prior sample and erase a malformed or mismatched event.
        const snapshot = structuredClone({ state: value.state, peerEvents: value.peerEvents });
        previousEvents = structuredClone(snapshot.peerEvents);
        return snapshot;
    };
    const result = await poll(readValidated, snapshot => {
        const inspection = inspectSpotlightHelperOrigin(snapshot.state, snapshot.peerEvents, options, true);
        if (!inspection.complete) return false;
        accepted = { snapshot, origin: assertSpotlightHelperOrigin(snapshot.state, snapshot.peerEvents, options) };
        return true;
    }, 'complete source-bound helper origin evidence without changing its document or observed trace');
    assert(accepted && result === accepted.snapshot, 'The bounded poll must return the exact strictly accepted passive snapshot.');
    return { state: result.state, peerEvents: result.peerEvents, origin: accepted.origin };
}
