import { PEER_KEY, PAIRING_GENERATION_KEY, isExtensionId, isWindowId, isFavoriteUrl } from './spotlight-bridge-protocol.js';
import { isToken, isRevision, sendWitnessRequest } from './favorite-witness-protocol.js';
import { isStartupLauncherTab } from './startup-launcher-tab.js';

export const CONTINUITY_LOCAL_KEY = 'favoriteContinuity';
export const CONTINUITY_SESSION_KEY = 'favoriteContinuityReceipt';
const SESSION_KEY = 'favoriteSession';
const SCHEMA = 'exact-global-favorites-v2';
const empty = () => ({ version: 1, bindings: [], attempts: [] });
const copy = value => structuredClone(value);
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 200;
const same = (a, b) => a.peerId === b.peerId && a.generation === b.generation;
const identity = item => [item.id, item.url, item.sourceBookmarkId];
// Storage may reconstruct object properties in a different order. Sort only
// object keys: array order, exact IDs, values and optional fields still matter.
export const encodeFavoriteContinuityState = value => JSON.stringify(value, (_key, entry) =>
    entry && typeof entry === 'object' && !Array.isArray(entry)
        ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry);
const digest = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(encodeFavoriteContinuityState(value)))))
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
const receiptFields = value => ({ epoch: value.epoch, writerGeneration: value.generation, revision: value.revision });
// Optional, Arcify-local context. Including the receipt identity makes an older
// v2 writer advancing its revision invalidate unknown context rather than
// silently re-attest stale selection. Favorite ownership keeps its v2 digest.
const selectionIdentity = value => ({ epoch: value.epoch, generation: value.generation,
    revision: value.revision, fingerprint: value.fingerprint, selection: value.selection });
const validSelection = value => value?.version === 1 && !Array.isArray(value)
    && Object.keys(value).every(key => ['version', 'windows'].includes(key))
    && Array.isArray(value.windows) && value.windows.length <= 20000
    && value.windows.every(entry => entry && !Array.isArray(entry)
        && Object.keys(entry).every(key => ['windowId', 'spaceId', 'tabId'].includes(key))
        && isWindowId(entry.windowId) && id(entry.spaceId) && isWindowId(entry.tabId))
    && new Set(value.windows.map(entry => entry.windowId)).size === value.windows.length
    && new Set(value.windows.map(entry => entry.tabId)).size === value.windows.length;
const selectionFrom = async receipt => validSelection(receipt?.selection)
    && receipt.selectionFingerprint === await digest(selectionIdentity(receipt)) ? copy(receipt.selection) : null;

// Settings and revocation are one atomic local write. It remains effective even
// while Spotlight is offline, and never depends on an onChanged callback running.
export async function configureFavoriteContinuityPeer(api, peerId) {
    await api.storage.local.set({ [PEER_KEY]: peerId, [PAIRING_GENERATION_KEY]: crypto.randomUUID(),
        [CONTINUITY_LOCAL_KEY]: { version: 1, phase: 'invalid' } });
}

export function validContinuityState(state) {
    if (!state || Array.isArray(state) || state.version !== 1 || Object.keys(state).some(key => !['version', 'bindings', 'attempts'].includes(key))
        || !Array.isArray(state.bindings) || !Array.isArray(state.attempts) || state.bindings.length + state.attempts.length > 20000) return false;
    const allTabs = new Map(), allPairs = new Map();
    for (const [kind, entries] of [['binding', state.bindings], ['attempt', state.attempts]]) {
        const pairs = new Set();
        for (const entry of entries) {
            const fields = kind === 'binding' ? ['favoriteId', 'windowId', 'tabId', 'mode'] : ['favoriteId', 'windowId', 'tabId', 'mode', 'url', 'kind'];
            if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).some(key => !fields.includes(key))
                || !id(entry.favoriteId) || !isWindowId(entry.windowId) || !(isWindowId(entry.tabId) || kind === 'attempt' && entry.tabId === null)
                || entry.mode !== undefined && entry.mode !== 'ordinary'
                || kind === 'attempt' && (!isFavoriteUrl(entry.url) || entry.kind !== undefined && entry.kind !== 'adopt')) return false;
            const pair = `${entry.favoriteId}:${entry.windowId}`;
            if (pairs.has(pair) || entry.tabId !== null && allTabs.has(entry.tabId) && allTabs.get(entry.tabId) !== pair) return false;
            const previous = allPairs.get(pair);
            if (previous && (previous.tabId !== entry.tabId || previous.mode !== entry.mode)) return false;
            allPairs.set(pair, entry);
            pairs.add(pair); if (entry.tabId !== null) allTabs.set(entry.tabId, pair);
        }
    }
    return true;
}

// Single writer: FavoriteStore invokes these methods while holding SpaceStore's
// queue. This is a local exact-ID mirror, never a URL-based restore mechanism.
export function createFavoriteContinuity({ api = chrome, sendRequest = sendWitnessRequest } = {}) {
    let current = null, selection = null, recoveredSelection = null, selectionDirty = false, provenIdentity = null;
    const config = async () => {
        const values = await api.storage.local.get([PEER_KEY, PAIRING_GENERATION_KEY]);
        return { peerId: isExtensionId(values[PEER_KEY]) ? values[PEER_KEY] : null, generation: values[PAIRING_GENERATION_KEY] };
    };
    const ensureGeneration = async pairing => {
        if (isToken(pairing.generation)) return pairing;
        const generation = crypto.randomUUID();
        await api.storage.local.set({ [PAIRING_GENERATION_KEY]: generation, [CONTINUITY_LOCAL_KEY]: { version: 1, phase: 'invalid' } });
        const latest = await config();
        if (latest.peerId !== pairing.peerId || latest.generation !== generation) throw new Error('Favorite pairing changed. Try again.');
        return latest;
    };
    const newCurrent = pairing => ({ version: 1, schema: SCHEMA, epoch: crypto.randomUUID(), revision: 0, ...pairing });
    const validReceipt = receipt => receipt?.version === 1 && receipt.schema === SCHEMA && isToken(receipt.epoch)
        && isToken(receipt.generation) && isRevision(receipt.revision) && /^[a-f0-9]{64}$/.test(receipt.fingerprint) && (receipt.phase === undefined || receipt.phase === 'committed');
    const checkPairing = async pairing => {
        if (!same(pairing, await config())) throw new Error('Favorite pairing changed. Try again.');
    };
    async function save({ state, items, spaceSessionUpdate, selectedContext = selection, beforeWrite = null }, recovery = null) {
        if (!validContinuityState(state)) throw new Error('Invalid exact Favorite continuity state.');
        if (beforeWrite) await beforeWrite();
        const pairing = await ensureGeneration(await config());
        if (!current || !same(current, pairing) || current.revision >= Number.MAX_SAFE_INTEGER) current = newCurrent(pairing);
        const next = { ...current, revision: current.revision + 1, fingerprint: await digest(state) };
        delete next.selection; delete next.selectionFingerprint;
        if (selectedContext) {
            next.selection = copy(selectedContext);
            next.selectionFingerprint = await digest(selectionIdentity(next));
        }
        // Invalidate BEFORE writing session state or reporting a detach/remove.
        // A failure here forbids the caller's subsequent native mutation.
        if (beforeWrite) await beforeWrite();
        await api.storage.local.set({ [CONTINUITY_LOCAL_KEY]: { version: 1, phase: 'invalid' } });
        await checkPairing(pairing);
        if (beforeWrite) await beforeWrite();
        await api.storage.session.set({ ...spaceSessionUpdate, [SESSION_KEY]: copy(state), [CONTINUITY_SESSION_KEY]: { ...copy(next), ...(recovery ? { phase: 'recovering' } : {}) } });
        current = next; selection = copy(selectedContext);
        const journal = { ...next, phase: 'committed', items: items.map(identity), state: copy(state), peerGeneration: null };
        await checkPairing(pairing);
        if (!recovery) {
            if (beforeWrite) await beforeWrite();
            await api.storage.local.set({ [CONTINUITY_LOCAL_KEY]: journal });
        }
        await checkPairing(pairing);
        if (!pairing.peerId) return;
        let acknowledgement;
        if (beforeWrite) await beforeWrite();
        try { acknowledgement = await sendRequest(pairing.peerId, 'write', { ...receiptFields(next),
            ...(recovery ? { expectedPeerGeneration: recovery.peerGeneration, expectedRevision: recovery.revision } : {}) }, { api }); }
        catch (error) { if (recovery) throw error; return; } // Ordinary ownership works with its own surviving session.
        await checkPairing(pairing);
        if (!acknowledgement.matched || !isToken(acknowledgement.peerGeneration)
            || recovery && acknowledgement.peerGeneration !== recovery.peerGeneration) {
            if (recovery) throw Object.assign(new Error('Recovery witness changed.'), { code: 'STALE_RECEIPT' });
            return;
        }
        // Ack persistence failure leaves the mirror deliberately unrecoverable;
        // working session ownership stays valid and the caller sees the failure.
        if (beforeWrite) await beforeWrite();
        await api.storage.local.set({ [CONTINUITY_LOCAL_KEY]: { ...journal, peerGeneration: acknowledgement.peerGeneration } });
        await checkPairing(pairing);
        if (recovery) {
            if (beforeWrite) await beforeWrite();
            await api.storage.session.set({ [SESSION_KEY]: copy(state), [CONTINUITY_SESSION_KEY]: copy(next) });
        }
    }
    async function refresh({ state, items }) {
        if (!current || !validReceipt(current)) return;
        const pairing = await config();
        if (!pairing.peerId) return;
        const own = await api.storage.session.get([SESSION_KEY, CONTINUITY_SESSION_KEY]);
        if (!validReceipt(own[CONTINUITY_SESSION_KEY]) || own[CONTINUITY_SESSION_KEY].epoch !== current.epoch
            || own[CONTINUITY_SESSION_KEY].revision !== current.revision || current.fingerprint !== await digest(state)
            || current.fingerprint !== await digest(own[SESSION_KEY])) return;
        if (!same(current, pairing)) { await save({ state, items }); return; }
        let witness;
        try { witness = await sendRequest(pairing.peerId, 'read', receiptFields(current), { api }); } catch { /* fresh enrollment may restore a reloaded peer */ }
        await checkPairing(pairing);
        const { [CONTINUITY_LOCAL_KEY]: mirror } = await api.storage.local.get(CONTINUITY_LOCAL_KEY);
        if (!witness?.matched || mirror?.phase !== 'committed' || mirror.epoch !== current.epoch
            || mirror.revision !== current.revision || mirror.peerGeneration !== witness.peerGeneration) await save({ state, items });
    }
    // No queue entry here: both stores already hold SpaceStore.run(). Include
    // Space session state in the receipt write so no torn selection can be
    // acknowledged with an older recoverable journal.
    async function checkpointSelection({ state, items, spaces, activeSpaces, spaceSessionUpdate, beforeWrite = null }) {
        const live = await api.tabs.query({});
        const windows = [];
        for (const [key, spaceId] of Object.entries(activeSpaces)) {
            const windowId = Number(key);
            if (!isWindowId(windowId) || !spaces.some(space => space.id === spaceId)) continue;
            const candidates = live.filter(tab => tab.windowId === windowId && selectionAnchor(tab));
            const anchor = candidates.find(tab => tab.active) || candidates[0];
            if (!anchor) continue;
            const window = await api.windows.get(windowId);
            if (window?.id === windowId && window.type === 'normal' && !window.incognito)
                windows.push({ windowId, spaceId, tabId: anchor.id });
        }
        const nextSelection = { version: 1, windows: windows.sort((a, b) => a.windowId - b.windowId) };
        if (!selectionDirty && encodeFavoriteContinuityState(selection) === encodeFavoriteContinuityState(nextSelection)
            && current && same(current, await config())) {
            if (beforeWrite) await beforeWrite();
            await api.storage.session.set(spaceSessionUpdate);
            return;
        }
        selectionDirty = true;
        await save({ state, items, spaceSessionUpdate, selectedContext: nextSelection, beforeWrite });
        selectionDirty = false;
    }
    const selectionAnchor = tab => tab && !tab.incognito && !isStartupLauncherTab(tab, api)
        && ![tab.url, tab.pendingUrl].some(url => /^(chrome|moz)-extension:/.test(url || ''));
    async function recoverSelection(spaces) {
        const active = {};
        if (!recoveredSelection) return active;
        const live = new Map((await api.tabs.query({})).map(tab => [tab.id, tab]));
        for (const entry of recoveredSelection.windows) {
            const tab = live.get(entry.tabId);
            if (!spaces.some(space => space.id === entry.spaceId) || !selectionAnchor(tab) || tab.windowId !== entry.windowId) continue;
            const window = await api.windows.get(entry.windowId);
            if (window?.id === entry.windowId && window.type === 'normal' && !window.incognito) active[entry.windowId] = entry.spaceId;
        }
        recoveredSelection = null;
        return active;
    }
    async function load({ session, items }) {
        current = null; selection = null; recoveredSelection = null; selectionDirty = false; provenIdentity = null;
        const pairing = await config();
        const own = await api.storage.session.get([CONTINUITY_SESSION_KEY, 'spaceSession', 'activeSpaces']);
        const receipt = own[CONTINUITY_SESSION_KEY];
        const { [CONTINUITY_LOCAL_KEY]: journal } = await api.storage.local.get(CONTINUITY_LOCAL_KEY);
        let state = empty(), recovery = null;
        if (session !== null && session !== undefined) {
            // Own session is the preferred browser-lifetime proof. A receipt
            // mismatch detects unsupported code modifying the session schema.
            const legacy = !receipt && !session.bindings?.some(value => value.mode) && !session.attempts?.some(value => value.mode);
            if (validContinuityState(session) && (legacy || validReceipt(receipt) && receipt.fingerprint === await digest(session))) {
                state = copy(session);
                if (validReceipt(receipt) && same(receipt, pairing)) {
                    current = copy(receipt);
                    selection = await selectionFrom(receipt);
                }
            }
        } else if (journal?.phase === 'committed' && validReceipt(journal) && same(journal, pairing)
            && isExtensionId(pairing.peerId) && isToken(journal.peerGeneration) && validContinuityState(journal.state)
            && journal.fingerprint === await digest(journal.state) && Array.isArray(journal.items)) {
            const saved = new Map(items.map(item => [item.id, JSON.stringify(identity(item))]));
            const mirrored = new Map(journal.items.filter(value => Array.isArray(value) && value.length === 3).map(value => [value[0], JSON.stringify(value)]));
            const identities = [...journal.state.bindings, ...journal.state.attempts];
            if (mirrored.size === journal.items.length && identities.every(value => saved.has(value.favoriteId) && saved.get(value.favoriteId) === mirrored.get(value.favoriteId))) {
                let witness;
                // Crucially this is READ only, before any new enrollment/write.
                try { witness = await sendRequest(pairing.peerId, 'read', receiptFields(journal), { api }); } catch { /* unavailable is not proof */ }
                if (witness?.matched && witness.peerGeneration === journal.peerGeneration && same(pairing, await config())) {
                    const live = new Map((await api.tabs.query({})).map(tab => [tab.id, tab]));
                    const windows = new Map();
                    const exact = async entry => {
                        if (entry.tabId === null) return true; // Uncertain create still blocks duplicate retry.
                        const tab = live.get(entry.tabId);
                        if (!tab || tab.windowId !== entry.windowId || tab.incognito || isStartupLauncherTab(tab, api)
                            || entry.mode !== 'ordinary' && !tab.pinned) return false;
                        if (!windows.has(tab.windowId)) {
                            // A failed lookup is uncertainty, not proof of a closed
                            // or invalid window. Keep the journal untouched and
                            // block Space adoption until this read can be retried.
                            windows.set(tab.windowId, await api.windows.get(tab.windowId));
                        }
                        const window = windows.get(tab.windowId);
                        return window?.id === entry.windowId && window.type === 'normal' && !window.incognito;
                    };
                    state = empty();
                    for (const entry of journal.state.bindings) if (await exact(entry)) state.bindings.push(copy(entry));
                    for (const entry of journal.state.attempts) if (await exact(entry)) state.attempts.push(copy(entry));
                    await checkPairing(pairing);
                    selection = await selectionFrom(journal);
                    if (selection) {
                        const selected = [];
                        for (const entry of selection.windows) {
                            const tab = live.get(entry.tabId);
                            if (!selectionAnchor(tab) || tab.windowId !== entry.windowId) continue;
                            if (!windows.has(entry.windowId)) windows.set(entry.windowId, await api.windows.get(entry.windowId));
                            const window = windows.get(entry.windowId);
                            if (window?.id === entry.windowId && window.type === 'normal' && !window.incognito) selected.push(entry);
                        }
                        selection.windows = selected;
                    }
                    recovery = { peerGeneration: journal.peerGeneration, revision: journal.revision };
                    current = { ...journal }; delete current.state; delete current.items; delete current.phase; delete current.peerGeneration;
                }
            }
        }
        // Own Space intent wins even if initialization is interrupted before
        // SpaceStore can checkpoint it. Never re-attest an older context in that
        // gap, including when the authoritative selection was explicitly empty.
        if (own.spaceSession && selection?.windows.some(entry => own.activeSpaces?.[entry.windowId] !== entry.spaceId)) selection = null;
        // Missing/invalid proof starts a new epoch from empty/current session,
        // never seeds the unproven durable candidate into a fresh Spotlight.
        const proven = current ? { epoch: current.epoch, generation: current.generation } : null;
        if (!current) current = newCurrent(await ensureGeneration(await config()));
        try { await save({ state, items }, recovery); }
        catch (error) {
            if (!recovery || !['STALE_RECEIPT', 'UNAUTHORIZED', 'UNAVAILABLE', 'TIMEOUT', 'INVALID_RESPONSE', 'UNSUPPORTED'].includes(error.code)) throw error;
            current = null; state = empty(); selection = null;
            await save({ state, items });
        }
        // Publish context only after the conditional recovery acknowledgement
        // and final committed own-session receipt both succeeded.
        recoveredSelection = copy(selection);
        if (proven && proven.epoch === current.epoch && proven.generation === current.generation) provenIdentity = proven;
        return state;
    }
    async function browserIdentity({ recovered = false } = {}) {
        if (!current || !validReceipt(current) || !same(current, await config())) return null;
        if (recovered && (provenIdentity?.epoch !== current.epoch || provenIdentity?.generation !== current.generation)) return null;
        return { epoch: current.epoch, generation: current.generation };
    }
    return { load, save, refresh, checkpointSelection, recoverSelection, browserIdentity };
}
