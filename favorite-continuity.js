import { PEER_KEY, PAIRING_GENERATION_KEY, isExtensionId, isWindowId, isFavoriteUrl } from './spotlight-bridge-protocol.js';
import { isToken, isRevision, sendWitnessRequest } from './favorite-witness-protocol.js';
import { isStartupLauncherTab } from './startup-launcher-tab.js';

export const CONTINUITY_LOCAL_KEY = 'favoriteContinuity';
export const CONTINUITY_SESSION_KEY = 'favoriteContinuityReceipt';
const SESSION_KEY = 'favoriteSession';
const SCHEMA = 'exact-global-favorites-v1';
const empty = () => ({ version: 1, bindings: [], attempts: [] });
const copy = value => structuredClone(value);
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 200;
const same = (a, b) => a.peerId === b.peerId && a.generation === b.generation;
const identity = item => [item.id, item.url, item.sourceBookmarkId];
const digest = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)))))
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
const receiptFields = value => ({ epoch: value.epoch, writerGeneration: value.generation, revision: value.revision });

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
    let current = null;
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
    async function save({ state, items }, recovery = null) {
        if (!validContinuityState(state)) throw new Error('Invalid exact Favorite continuity state.');
        const pairing = await ensureGeneration(await config());
        if (!current || !same(current, pairing) || current.revision >= Number.MAX_SAFE_INTEGER) current = newCurrent(pairing);
        const next = { ...current, revision: current.revision + 1, fingerprint: await digest(state) };
        // Invalidate BEFORE writing session state or reporting a detach/remove.
        // A failure here forbids the caller's subsequent native mutation.
        await api.storage.local.set({ [CONTINUITY_LOCAL_KEY]: { version: 1, phase: 'invalid' } });
        await checkPairing(pairing);
        await api.storage.session.set({ [SESSION_KEY]: copy(state), [CONTINUITY_SESSION_KEY]: { ...copy(next), ...(recovery ? { phase: 'recovering' } : {}) } });
        current = next;
        const journal = { ...next, phase: 'committed', items: items.map(identity), state: copy(state), peerGeneration: null };
        await checkPairing(pairing);
        if (!recovery) await api.storage.local.set({ [CONTINUITY_LOCAL_KEY]: journal });
        await checkPairing(pairing);
        if (!pairing.peerId) return;
        let acknowledgement;
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
        await api.storage.local.set({ [CONTINUITY_LOCAL_KEY]: { ...journal, peerGeneration: acknowledgement.peerGeneration } });
        await checkPairing(pairing);
        if (recovery) await api.storage.session.set({ [SESSION_KEY]: copy(state), [CONTINUITY_SESSION_KEY]: copy(next) });
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
    async function load({ session, items }) {
        current = null;
        const pairing = await config();
        const { [CONTINUITY_SESSION_KEY]: receipt } = await api.storage.session.get(CONTINUITY_SESSION_KEY);
        const { [CONTINUITY_LOCAL_KEY]: journal } = await api.storage.local.get(CONTINUITY_LOCAL_KEY);
        let state = empty(), recovery = null;
        if (session !== null && session !== undefined) {
            // Own session is the preferred browser-lifetime proof. A receipt
            // mismatch detects unsupported code modifying the session schema.
            const legacy = !receipt && !session.bindings?.some(value => value.mode) && !session.attempts?.some(value => value.mode);
            if (validContinuityState(session) && (legacy || validReceipt(receipt) && receipt.fingerprint === await digest(session))) {
                state = copy(session);
                if (validReceipt(receipt) && same(receipt, pairing)) current = copy(receipt);
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
                    recovery = { peerGeneration: journal.peerGeneration, revision: journal.revision };
                    current = { ...journal }; delete current.state; delete current.items; delete current.phase; delete current.peerGeneration;
                }
            }
        }
        // Missing/invalid proof starts a new epoch from empty/current session,
        // never seeds the unproven durable candidate into a fresh Spotlight.
        if (!current) current = newCurrent(await ensureGeneration(await config()));
        try { await save({ state, items }, recovery); }
        catch (error) {
            if (!recovery || !['STALE_RECEIPT', 'UNAUTHORIZED', 'UNAVAILABLE', 'TIMEOUT', 'INVALID_RESPONSE', 'UNSUPPORTED'].includes(error.code)) throw error;
            current = null; state = empty();
            await save({ state, items });
        }
        return state;
    }
    return { load, save, refresh };
}
