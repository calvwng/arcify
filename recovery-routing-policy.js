// PORTABLE PROTOTYPE. Trusted latest-candidate adapters and integration are NOT
// implemented or verified. This module does not import Chrome, storage or UI.
const MAX_AGE_MS = 30_000;
const MAX_RECORDS = 10_000;
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const nativeId = value => Number.isSafeInteger(value) && value > 0;
const revision = value => Number.isSafeInteger(value) && value >= 0;
const timestamp = value => Number.isSafeInteger(value) && value >= 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Both times must come from the adapter's same monotonic clock domain. A revision
// alone does not prove freshness: the adapter must observe it under the writer's
// queue immediately before execution and reject epoch/session changes separately.
export function qualifySnapshot(value) {
    if (!object(value) || !object(value.capture)
        || !revision(value.capture.revision) || !revision(value.currentRevision)
        || !id(value.capture.epoch) || !id(value.currentEpoch)
        || !timestamp(value.capture.observedAtMs) || !timestamp(value.nowMs)
        || !Number.isSafeInteger(value.maxAgeMs) || value.maxAgeMs < 0 || value.maxAgeMs > MAX_AGE_MS)
        return 'invalid';
    if (value.capture.epoch !== value.currentEpoch || value.capture.revision !== value.currentRevision
        || value.nowMs < value.capture.observedAtMs
        || value.nowMs - value.capture.observedAtMs > value.maxAgeMs) return 'stale';
    return 'fresh';
}

function destination(value) {
    return object(value) && value.proof === 'exact' && id(value.spaceId) && nativeId(value.windowId);
}

function preservation(page) {
    if (object(page) && page.state === 'not-created' && page.tabId === undefined && page.documentId === undefined)
        return { mode: 'create-once-no-replay' };
    if (object(page) && page.state === 'existing' && nativeId(page.tabId) && id(page.documentId))
        return { mode: 'same-tab-and-document', tabId: page.tabId, documentId: page.documentId };
    return null;
}

// No operation is performed. A plan is not an authorization/capability. Only a
// trusted extension adapter may supply provenance and ownership evidence.
export function classifyOpenDestination(context) {
    const observe = reason => ({ action: 'observe-only', reason });
    const freshness = qualifySnapshot(context);
    if (freshness !== 'fresh') return observe(`${freshness}-snapshot`);
    const preserve = preservation(context.page);
    if (!preserve) return observe('unknown-page-identity');
    // This feature is only a controlled web-opening policy. Exclusions precede
    // destination selection; this never silently changes browser-internal flows.
    if (context.targetKind !== 'web') return observe('unsupported-target');
    if (context.provenance !== 'extension-controlled') return observe('uncontrolled-opening');
    if (context.flow !== 'ordinary-link') return observe('excluded-or-unknown-flow');
    // Missing destinations are absence only after the trusted adapter completed
    // both explicit-choice and saved-ownership lookups. Unknown is not absence.
    if (context.destinationEvidence !== 'complete') return observe('unknown-destination-evidence');
    if (context.explicitDestination !== undefined && context.explicitDestination !== null) {
        if (!destination(context.explicitDestination)) return observe('invalid-explicit-destination');
        return { action: 'keep-destination', reason: 'explicit-choice',
            destination: { spaceId: context.explicitDestination.spaceId, windowId: context.explicitDestination.windowId }, preserve };
    }
    if (context.savedDestination !== undefined && context.savedDestination !== null) {
        if (!destination(context.savedDestination)) return observe('invalid-saved-destination');
        return { action: 'keep-destination', reason: 'saved-ownership',
            destination: { spaceId: context.savedDestination.spaceId, windowId: context.savedDestination.windowId }, preserve };
    }
    if (!object(context.source) || !['none-confirmed', 'ambiguous', 'proven'].includes(context.source.status))
        return observe('unknown-source-ownership');
    if (context.source.status === 'proven') {
        if (!Array.isArray(context.source.destinations) || context.source.destinations.length !== 1
            || !destination(context.source.destinations[0])) return observe('conflicting-source-ownership');
        const chosen = context.source.destinations[0];
        return { action: 'inherit-space', reason: 'proven-source',
            destination: { spaceId: chosen.spaceId, windowId: chosen.windowId }, preserve };
    }
    // Ambiguity is a reason to use the holding area, never a license to invent a
    // Space. In contrast, missing/unqualified evidence above remains observation.
    if (context.source.destinations !== undefined) return observe('contradictory-source-evidence');
    return { action: 'little-arc', reason: context.source.status === 'ambiguous'
        ? 'ambiguous-source-space' : 'no-source-space', preserve };
}

const emptyCounts = () => ({ 'native-candidates-absent': 0, 'membership-unresolved': 0,
    'membership-recovered': 0, 'favorite-unbound': 0, 'favorite-bound': 0, unknown: 0 });

function classifyRecord(record) {
    if (!object(record)) return 'unknown';
    if (record.kind === 'favorite') {
        if (record.savedRecordConfirmed !== true) return 'unknown';
        if (record.candidateCount !== undefined
            && (!Number.isSafeInteger(record.candidateCount) || record.candidateCount < 0)) return 'unknown';
        if (record.identity !== undefined && !['unknown', 'ambiguous', 'proven'].includes(record.identity)) return 'unknown';
        if (record.identity === 'proven' && record.candidateCount !== 1) return 'unknown';
        if (record.identity === 'ambiguous' && record.candidateCount === 0) return 'unknown';
        if (record.liveBinding === 'unbound') return 'favorite-unbound';
        if (record.liveBinding === 'proven' && record.identity === 'proven' && record.candidateCount === 1)
            return 'favorite-bound';
        return 'unknown';
    }
    if (record.kind !== 'today' || record.savedRecordConfirmed !== true
        || !Number.isSafeInteger(record.candidateCount) || record.candidateCount < 0
        || !['unknown', 'ambiguous', 'proven'].includes(record.identity)
        || !['unknown', 'unresolved', 'recovered'].includes(record.membership))
        return 'unknown';
    if (record.identity === 'proven' && record.candidateCount !== 1) return 'unknown';
    if (record.candidateCount === 0) {
        if (record.nativeScanComplete === true && record.identity === 'unknown'
            && record.membership !== 'recovered') return 'native-candidates-absent';
        return 'unknown';
    }
    if (record.membership === 'recovered') {
        return record.identity === 'proven' && record.candidateCount === 1
            ? 'membership-recovered' : 'unknown';
    }
    if (record.membership === 'unresolved' && ['unknown', 'ambiguous', 'proven'].includes(record.identity))
        return 'membership-unresolved';
    return 'unknown';
}

// Summarizes trusted adapter evidence, not browser state itself. Candidate counts
// mean compatible observed candidates, never proof based only on matching URLs.
// Records must be unique saved occurrences; the adapter must not deduplicate URLs.
// Only aggregate counts leave this function: no URLs, titles, tokens or errors.
export function summarizeRecoverySnapshot(snapshot) {
    const status = qualifySnapshot(snapshot);
    const counts = emptyCounts();
    if (!object(snapshot) || !Array.isArray(snapshot.records) || snapshot.records.length > MAX_RECORDS)
        return { status: 'invalid', capture: null, total: null, counts };
    if (status !== 'fresh') {
        counts.unknown = snapshot.records.length;
        return { status, capture: null, total: snapshot.records.length, counts };
    }
    for (const record of snapshot.records) counts[classifyRecord(record)]++;
    return { status: 'fresh', capture: { revision: snapshot.capture.revision,
        epoch: snapshot.capture.epoch, observedAtMs: snapshot.capture.observedAtMs },
        total: snapshot.records.length, counts };
}
