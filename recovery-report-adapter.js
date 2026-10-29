import { summarizeRecoverySnapshot } from './recovery-routing-policy.js';
import { encodeFavoriteContinuityState as encode } from './favorite-continuity.js';
import { validateRecoveryReport } from './recovery-report-protocol.js';
import { journalValid } from './saved-move-store.js';

const array = value => Array.isArray(value) ? value : [];
const positive = value => Number.isSafeInteger(value) && value > 0;
const text = value => typeof value === 'string' && value.length > 0;
const unordered = value => Array.isArray(value) ? value.map(encode).sort() : null;
function containsOccurrences(haystack, needles) {
    if (!Array.isArray(haystack) || !Array.isArray(needles)) return false;
    const remaining = new Map();
    for (const entry of haystack) { const key=encode(entry); remaining.set(key,(remaining.get(key)||0)+1); }
    for (const entry of needles) { const key=encode(entry), count=remaining.get(key)||0; if(!count)return false;remaining.set(key,count-1); }
    return true;
}

// Called only with private worker observations, never request-supplied evidence.
// This reads no APIs and invokes no restore matcher. URL equality is candidate
// evidence only; current membership additionally needs exact live/session IDs.
export function summarizeRecoveryObservation(snapshot) {
    const { memory: m, local, session, tabs } = snapshot;
    const favoriteState = m.favoriteState;
    const favorites = array(local.persistentFavorites);
    const favoriteReady = m.favoriteInitialized && !m.favoriteDirty && Array.isArray(favoriteState?.bindings)
        && Array.isArray(favoriteState?.attempts) && encode(favorites) === encode(m.favorites)
        && encode(favoriteState) === encode(session.favoriteSession);
    const transient = m.transient;
    const archive = local.archiveReopenClaims;
    const archiveSettled = archive === undefined || archive?.version === 1 && archive.entries
        && !Array.isArray(archive.entries) && Object.values(archive.entries).every(entry => entry?.phase === 'consumed');
    const savedMoveSettled = local.spaceSavedMoveJournal === undefined
        || local.spaceSavedMoveJournal?.phase === 'committed' && journalValid(local.spaceSavedMoveJournal);
    const sessionReady = Array.isArray(session.spaceRestoreQueue) && encode(session.spaceRestoreQueue) === encode(m.restoreQueue)
        && encode(unordered(session.spaceRecoveryCandidates)) === encode(unordered([...new Set([...array(m.recoveryCandidates),...array(m.provisional)])]))
        && encode(unordered(session.spaceWindowKeys)) === encode(unordered(m.windowKeys))
        && encode(unordered(session.spaceRestoreWindowKeys)) === encode(unordered(m.restoreWindowKeys))
        && containsOccurrences(local.spaceTabSnapshot,m.restoreQueue);
    const ready = snapshot.stable && snapshot.scope === 'live-store' && favoriteReady && session.spaceSession === true
        && transient?.initialized === true && transient.provenanceReady === true && transient.healthy === true
        && transient.revision === transient.savedRevision && savedMoveSettled && archiveSettled && sessionReady
        && !array(m.archivePending).length && !array(m.pendingCreations).length
        && Array.isArray(local.spaceTabSnapshot) && Array.isArray(local.spaces)
        && encode(local.spaces) === encode(m.spaces);
    const protectedIds = new Set([...array(favoriteState?.bindings), ...array(favoriteState?.attempts)].map(x => x.tabId));
    const savedPins = new Set(array(m.spaces).flatMap(s => array(s.spaceBookmarks)));
    const native = tabs.filter(t => positive(t.id) && positive(t.windowId) && t.pinned === false
        && !t.knownTransient && !protectedIds.has(t.id) && !savedPins.has(t.id)
        && typeof t.url === 'string' && !t.url.startsWith('chrome-extension://'));
    const snapshots = new Map(array(m.snapshotByTab));
    const candidates = new Set(array(m.recoveryCandidates));
    const provisional = new Set(array(m.provisional));
    const counted = new Set();
    const records = array(local.spaceTabSnapshot).filter(r => r?.section !== 'spaceBookmarks').map(record => {
        if (!ready || record?.section !== 'temporaryTabs' || !text(record.spaceId) || !text(record.url)) return {};
        const exact = native.filter(t => t.id === record.tabId && t.url === record.url && !t.pendingUrl);
        const owners = array(m.spaces).filter(s => array(s.temporaryTabs).includes(record.tabId));
        const current = exact.length === 1 && owners.length === 1 && owners[0].id === record.spaceId
            && !candidates.has(record.tabId) && !provisional.has(record.tabId) && !counted.has(record.tabId)
            && encode(snapshots.get(record.tabId)) === encode(record)
            && !array(m.restoreQueue).some(r => encode(r) === encode(record));
        if (current) {
            counted.add(record.tabId);
            return { kind:'today', savedRecordConfirmed:true, candidateCount:1, nativeScanComplete:true,
                identity:'proven', membership:'recovered' };
        }
        const matches = native.filter(t => t.url === record.url || t.pendingUrl === record.url).length;
        return { kind:'today', savedRecordConfirmed:true, candidateCount:matches, nativeScanComplete:true,
            identity:matches > 1 ? 'ambiguous' : 'unknown', membership:'unresolved' };
    });
    // A pending in-memory occurrence missing from the durable snapshot is not
    // silently dropped from the report, and is never promoted to saved proof.
    const durableOccurrences = new Map();
    for (const entry of array(local.spaceTabSnapshot)) { const key=encode(entry);durableOccurrences.set(key,(durableOccurrences.get(key)||0)+1); }
    for (const entry of array(m.restoreQueue)) {
        const key=encode(entry), count=durableOccurrences.get(key)||0;
        if(count)durableOccurrences.set(key,count-1);else if(entry?.section !== 'spaceBookmarks')records.push({});
    }
    for (const item of favorites) {
        if (!ready || !text(item?.id) || favorites.filter(f => f?.id === item.id).length !== 1) { records.push({}); continue; }
        const bindings = favoriteState.bindings.filter(b => b.favoriteId === item.id);
        const attempts = favoriteState.attempts.filter(b => b.favoriteId === item.id);
        if (!bindings.length && !attempts.length) records.push({kind:'favorite', savedRecordConfirmed:true,liveBinding:'unbound'});
        else if (!attempts.length && bindings.length === 1 && tabs.some(t => t.id === bindings[0].tabId
            && t.windowId === bindings[0].windowId && !t.knownTransient && (bindings[0].mode === 'ordinary' ? !t.pinned : t.pinned)))
            records.push({kind:'favorite', savedRecordConfirmed:true,liveBinding:'proven',identity:'proven',candidateCount:1});
        else records.push({});
    }
    const result = summarizeRecoverySnapshot({ records,
        capture:{epoch:snapshot.revision.workerId,revision:snapshot.revision.start,observedAtMs:snapshot.observedAtMs},
        currentEpoch:snapshot.revision.workerId,currentRevision:snapshot.revision.end,
        nowMs:snapshot.completedAtMs,maxAgeMs:30000 });
    const status = !snapshot.stable || result.status !== 'fresh' ? 'changing'
        : snapshot.scope !== 'live-store' ? 'cold' : !ready ? 'incomplete' : 'stable';
    const counts = result.counts;
    return validateRecoveryReport({schema:'arcify-recovery-report-v1',
        observationId:`${snapshot.revision.workerId}:${snapshot.revision.sequence}:${snapshot.revision.end}`,
        capturedAt:snapshot.capturedAt,status,authoritative:status === 'stable',counts:{
            nativePages:native.length,ownedPages:counts['membership-recovered'],
            unresolvedPages:counts['membership-unresolved'],recordsWithoutNativeCandidates:counts['native-candidates-absent'],
            savedFavorites:favorites.length,unboundFavorites:counts['favorite-unbound'],unknownRecords:counts.unknown }});
}
