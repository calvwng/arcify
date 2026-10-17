import { encodeFavoriteContinuityState } from './favorite-continuity.js';
import { isToken } from './favorite-witness-protocol.js';
import { isWindowId } from './spotlight-bridge-protocol.js';

export const SPACE_CONTINUITY_KEY = 'spaceContinuityStamp';
const identityValid = value => isToken(value?.epoch) && isToken(value?.generation);
const digest = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
    new TextEncoder().encode(encodeFavoriteContinuityState(value)))))
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
const proof = (stamp, snapshot) => ({ epoch: stamp.epoch, generation: stamp.generation,
    liveCount: stamp.liveCount, live: snapshot.slice(0, stamp.liveCount) });

// This is provenance for the existing snapshot, not another membership store.
// The snapshot's suffix may contain unresolved records from an older browser.
export async function createSpaceContinuityStamp(identity, liveSnapshot) {
    if (!identityValid(identity)) return null;
    const stamp = { version: 1, epoch: identity.epoch, generation: identity.generation, liveCount: liveSnapshot.length };
    return { ...stamp, fingerprint: await digest(proof(stamp, liveSnapshot)) };
}

export async function readSpaceContinuitySnapshot(identity, stamp, snapshot) {
    if (!identityValid(identity) || !stamp || Array.isArray(stamp) || stamp.version !== 1
        || Object.keys(stamp).some(key => !['version', 'epoch', 'generation', 'liveCount', 'fingerprint'].includes(key))
        || stamp.epoch !== identity.epoch || stamp.generation !== identity.generation
        || !Array.isArray(snapshot) || !Number.isSafeInteger(stamp.liveCount) || stamp.liveCount < 0 || stamp.liveCount > snapshot.length
        || typeof stamp.fingerprint !== 'string' || stamp.fingerprint !== await digest(proof(stamp, snapshot))) return null;
    const live = snapshot.slice(0, stamp.liveCount);
    if (live.some(record => !record || !isWindowId(record.tabId) || typeof record.spaceId !== 'string'
        || !['spaceBookmarks', 'temporaryTabs'].includes(record.section))
        || new Set(live.map(record => record.tabId)).size !== live.length) return null;
    return { live: structuredClone(live), pending: structuredClone(snapshot.slice(stamp.liveCount)) };
}

const validRanks = ranks => Array.isArray(ranks) && ranks.every(entry => Array.isArray(entry) && entry.length === 2 &&
    Number.isSafeInteger(entry[0]) && entry[0] > 0 && Number.isSafeInteger(entry[1]) && entry[1] >= 0) &&
    new Set(ranks.map(([id]) => id)).size === ranks.length;

// Ordering hints checkpoint with the canonical local write. A failed later
// session write must not restore stale source ranks after a membership move.
// Binding to the full snapshot prevents an older writer's changed snapshot from
// accidentally making an obsolete optional checkpoint authoritative.
export async function createSpaceRankCheckpoint(ranks, snapshot) {
    if (!validRanks(ranks) || !Array.isArray(snapshot)) throw new Error('Invalid Space rank checkpoint.');
    return { version: 1, ranks: structuredClone(ranks), fingerprint: await digest({ snapshot, ranks }) };
}

export async function readSpaceRankCheckpoint(checkpoint, snapshot) {
    if (!checkpoint || Array.isArray(checkpoint) || checkpoint.version !== 1 ||
        Object.keys(checkpoint).some(key => !['version', 'ranks', 'fingerprint'].includes(key)) ||
        !validRanks(checkpoint.ranks) || !Array.isArray(snapshot) || typeof checkpoint.fingerprint !== 'string' ||
        checkpoint.fingerprint !== await digest({ snapshot, ranks: checkpoint.ranks })) return null;
    return structuredClone(checkpoint.ranks);
}
