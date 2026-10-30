import { PEER_KEY, PAIRING_GENERATION_KEY, isTransientUrl } from './spotlight-bridge-protocol.js';
import { destinationSpace, createTransientOwnershipCommit } from './transient-window-actions.js';
import { finishLittleArcPlacement } from './little-arc-direct.js';

export const PEEK_TYPE = 'arcify-peek-v1';
export const PEEK_AUTHORITY = 'arcifyPeekAuthorityV1';
export const PEEK_RECEIPTS_KEY = 'peekOperationsV1';
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const positive = n => Number.isSafeInteger(n) && n > 0;
const uuid = s => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
const fail = () => { throw Object.assign(new Error('Peek changed or its result is uncertain. Check Little Arc and the destination window; nothing will be retried.'), { code: 'PEEK_UNAVAILABLE' }); };

/** Original URL remains the receipt identity; an independently attested action
 * selection is frozen before native creation. Authority stays out of DOM. */
export function createPeekService(store, api = chrome, { now = Date.now, ttl = 30 * 60 * 1000 } = {}) {
    const sessions = new Map();
    const sameSource = (a, b) => ['tabId', 'windowId', 'url'].every(k => a?.[k] === b?.[k]);
    const receipts = async () => {
        const saved = (await api.storage.session.get(PEEK_RECEIPTS_KEY))[PEEK_RECEIPTS_KEY];
        if (saved === undefined) return [];
        if (!Array.isArray(saved) || saved.length > 128 || saved.some(r => !(exact(r, ['source', 'url', 'operation', 'connection', 'phase']) || exact(r, ['source', 'url', 'targetUrl', 'operation', 'connection', 'phase']))
            || !exact(r.source, ['tabId', 'windowId', 'url']) || !positive(r.source.tabId) || !positive(r.source.windowId) || !isTransientUrl(r.source.url)
            || !isTransientUrl(r.url) || Object.hasOwn(r, 'targetUrl') && !isTransientUrl(r.targetUrl) || !uuid(r.operation) || !uuid(r.connection) || !['pending', 'completed'].includes(r.phase))
            || new Set(saved.map(r => r.operation)).size !== saved.length) fail();
        return saved;
    };
    const saveReceipts = async values => {
        await api.storage.session.set({ [PEEK_RECEIPTS_KEY]: values });
        // Chrome storage may reorder object keys. Compare all validated semantic
        // fields in a fixed order, retaining meaningful receipt array order.
        const canonical = list => list.map(r => [r.source.tabId, r.source.windowId, r.source.url, r.url, Object.hasOwn(r, 'targetUrl'), r.targetUrl, r.operation, r.connection, r.phase]);
        if (JSON.stringify(canonical(await receipts())) !== JSON.stringify(canonical(values))) fail();
    };
    async function sourceLive(source, active = false) {
        if (!exact(source, ['tabId', 'windowId', 'url']) || !positive(source.tabId) || !positive(source.windowId) || !isTransientUrl(source.url)) fail();
        const [tab, window] = await Promise.all([api.tabs.get(source.tabId), api.windows.get(source.windowId)]);
        if (tab.id !== source.tabId || tab.windowId !== source.windowId || tab.incognito || window.id !== source.windowId || window.incognito || window.type !== 'normal'
            || tab.url !== source.url || tab.pendingUrl && tab.pendingUrl !== source.url || store.isTransientWindow(source.windowId) || store.isTransientTab(tab)
            || active && (!tab.active || !window.focused)) fail();
    }
    async function capability(source) { await sourceLive(source); return { version: 3 }; }
    async function prepare(source, url, connection, peerId, generation, check) {
        if (!isTransientUrl(url) || !uuid(connection)) fail();
        await sourceLive(source, true); await check();
        const pending = await receipts();
        if (pending.length >= 128 || pending.some(r => sameSource(r.source, source) && (r.url === url || r.targetUrl === url))) fail();
        // One immutable operation per connection. Reusing a connection never rearms it.
        for (const [key, value] of sessions) if (value.expires <= now()) sessions.delete(key);
        if (sessions.has(connection)) fail();
        if (sessions.size >= 256) sessions.delete(sessions.keys().next().value);
        const operation = crypto.randomUUID();
        sessions.set(connection, { source: structuredClone(source), url, operation, peerId, generation, expires: now() + ttl, consumed: false });
        return { operation };
    }
    async function execute(source, connection, operation, action, peerId, generation, check) {
        const s = sessions.get(connection);
        if (!s || s.consumed || s.operation !== operation || s.peerId !== peerId || s.generation !== generation || s.expires <= now()
            || !['tabId', 'windowId', 'url'].every(k => s.source[k] === source?.[k]) || !['expand', 'fallback'].includes(action)) fail();
        s.consumed = true; // Before any await; errors and acknowledgement loss never rearm.
        let changed = false;
        const removers = [], listen = (event, fn) => { if (event) { event.addListener(fn); removers.push(() => event.removeListener(fn)); } };
        // Tab-wide loading includes subframe navigation. Top-document lifecycle
        // is attested by the live broker Port/proof, plus URL/native identity events.
        listen(api.tabs.onUpdated, (id, update) => { if (id === source.tabId && ['url', 'pendingUrl'].some(k => Object.hasOwn(update, k))) changed = true; });
        for (const name of ['onRemoved', 'onDetached', 'onAttached']) listen(api.tabs[name], id => { if (id === source.tabId) changed = true; });
        listen(api.tabs.onReplaced, (added, removed) => { if ([added, removed].includes(source.tabId)) changed = true; });
        listen(api.windows.onRemoved, id => { if (id === source.windowId) changed = true; });
        let target = null, selection = null;
        const guard = async () => {
            await sourceLive(source);
            if (target) await destinationSpace(store, target);
            let timer, proof;
            try {
                proof = await Promise.race([api.runtime.sendMessage(peerId, { type: PEEK_AUTHORITY, connection, operation, action, source }),
                    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Peek authority timed out.')), 3000); })]);
            } finally { clearTimeout(timer); }
            if (proof?.authorized !== true) fail();
            const value = proof.selection;
            if (!exact(value, ['mode', 'url', 'documentId', 'frameId', 'revision']) || !isTransientUrl(value.url)
                || (value.mode === 'original' ? value.url !== s.url || value.documentId !== null || value.frameId !== null || value.revision !== null
                    : value.mode !== 'current' || !positive(value.frameId) || !uuid(value.revision) || value.documentId !== null && (typeof value.documentId !== 'string' || !value.documentId))) fail();
            if (!selection) selection = structuredClone(value);
            else if (!['mode', 'url', 'documentId', 'frameId', 'revision'].every(k => selection[k] === value[k])) fail();
            await check();
            if (changed || s.expires <= now() || target && (store.active[source.windowId] !== target.spaceId || !store.spaces.some(v => v.id === target.spaceId && v.bookmarkFolderId === target.bookmarkFolderId))) fail();
        };
        try {
            await sourceLive(source, true);
            if (action === 'expand') {
                // Deliberately no snapshot/owner/first-Space fallback.
                const id = store.active[source.windowId], matches = store.spaces.filter(v => v.id === id);
                if (matches.length !== 1) fail();
                target = { windowId: source.windowId, spaceId: id, bookmarkFolderId: matches[0].bookmarkFolderId };
            }
            await guard();
            // A session receipt is written/read back before dispatch. It survives a
            // worker restart or lost reply, and never represents permission to retry.
            const pending = await receipts();
            if (pending.length >= 128 || pending.some(r => sameSource(r.source, source) && (r.url === s.url || (r.targetUrl || r.url) === selection.url))) fail();
            await saveReceipts([...pending, { source: structuredClone(source), url: s.url, targetUrl: selection.url, operation, connection, phase: 'pending' }]);
            const record = await store.transientWindows.openUnlocked({ url: selection.url, originWindowId: source.windowId }, { beforeMutation: guard });
            store.littleArcHeader?.remember(record, source.windowId);
            const complete = async result => {
                const saved = await receipts(), receipt = saved.find(r => r.operation === operation && r.connection === connection);
                if (!receipt) fail(); receipt.phase = 'completed'; await saveReceipts(saved); return result;
            };
            if (action === 'fallback') return complete({ completed: true, action, tabId: record.tabId, windowId: record.windowId });
            await guard();
            const commit = createTransientOwnershipCommit(store);
            const guardedCommit = async (tab, request) => { await guard(); return commit(tab, request); };
            guardedCommit.validate = async (tab, request) => { await guard(); return commit.validate(tab, request); };
            const result = await store.transientWindows.promoteUnlocked({ token: record.token, tabId: record.tabId, ...target }, { beforeMutation: guard, commitOwnership: guardedCommit });
            // The existing adapter verifies persisted unique membership and the durable journal.
            const finished = await finishLittleArcPlacement(api, record, result);
            return complete({ completed: true, action, tabId: finished.tabId, windowId: finished.windowId, spaceId: finished.spaceId, focused: finished.focused });
        } finally { sessions.delete(connection); removers.forEach(fn => fn()); }
    }
    const acknowledge = async (source, connection, operation, check) => {
        const saved = await receipts(), receipt = saved.find(r => r.operation === operation && r.connection === connection && sameSource(r.source, source));
        if (!receipt || receipt.phase !== 'completed') fail();
        await check(); await saveReceipts(saved.filter(r => r !== receipt)); return { acknowledged: true };
    };
    const pulse = async (source, connection, operation, check) => {
        const s = sessions.get(connection);
        if (!s || s.consumed || s.expires <= now() || s.operation !== operation || !sameSource(s.source, source)) fail();
        await sourceLive(source); await check();
        if (s.consumed || s.expires <= now() || sessions.get(connection) !== s) fail();
        return { alive: true };
    };
    return { capability, prepare, execute, acknowledge, pulse, revoke: connection => { const s = sessions.get(connection); if (s) s.expires = 0; sessions.delete(connection); } };
}

export function registerPeek(store, api = chrome) {
    const service = createPeekService(store, api);
    api.runtime.onMessageExternal.addListener((request, sender, respond) => {
        if (request?.type !== PEEK_TYPE) return;
        const work = async () => {
            const initial = await api.storage.local.get([PEER_KEY, PAIRING_GENERATION_KEY]);
            const peerId = initial[PEER_KEY], generation = initial[PAIRING_GENERATION_KEY] ?? null;
            const check = async () => {
                const settings = await api.storage.local.get([PEER_KEY, PAIRING_GENERATION_KEY]);
                if (!peerId || sender.id !== peerId || sender.tab || sender.url && sender.url !== `chrome-extension://${peerId}/background.js`
                    || sender.origin && sender.origin !== `chrome-extension://${peerId}` || settings[PEER_KEY] !== peerId || (settings[PAIRING_GENERATION_KEY] ?? null) !== generation) fail();
            };
            await check();
            if (request.action === 'capability' && exact(request, ['type', 'action', 'source'])) return service.capability(request.source);
            if (request.action === 'prepare' && exact(request, ['type', 'action', 'source', 'url', 'connection'])) return service.prepare(request.source, request.url, request.connection, peerId, generation, check);
            if (['expand', 'fallback'].includes(request.action) && exact(request, ['type', 'action', 'source', 'connection', 'operation'])) return service.execute(request.source, request.connection, request.operation, request.action, peerId, generation, check);
            if (request.action === 'acknowledge' && exact(request, ['type', 'action', 'source', 'connection', 'operation'])) return service.acknowledge(request.source, request.connection, request.operation, check);
            if (request.action === 'pulse' && exact(request, ['type', 'action', 'source', 'connection', 'operation'])) return service.pulse(request.source, request.connection, request.operation, check);
            if (request.action === 'revoke' && exact(request, ['type', 'action', 'source', 'connection'])) { service.revoke(request.connection); return { revoked: true }; }
            fail();
        };
        store.run(work).then(result => respond({ success: true, ...result }), () => respond({ success: false, error: 'Peek could not confirm completion. Check Little Arc and your windows before opening another copy. Nothing was retried.' }));
        return true;
    });
    return service;
}
