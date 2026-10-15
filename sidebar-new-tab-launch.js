import { PEER_KEY, PAIRING_GENERATION_KEY, bridgeError, isExtensionId, isWindowId, sendBridgeRequest } from './spotlight-bridge-protocol.js';

// Only a read-only hello can produce a safe fallback decision. In particular,
// LAUNCH_FAILED, closed channels, malformed replies and timeouts after dispatch
// can all hide a completed launch. They must never create a second tab.
const SAFE_HELLO_FAILURES = new Set(['NOT_CONFIGURED', 'UNAVAILABLE', 'UNAUTHORIZED', 'VERSION_MISMATCH', 'UNSUPPORTED_COMMAND', 'UNSUPPORTED_FEATURE']);
const changed = () => bridgeError('STALE_CONTEXT', 'The window, active tab, Space, or pairing changed. Try New Tab again in the current Space.');

export function createSidebarNewTabLauncher(store, { api = globalThis.chrome, send = sendBridgeRequest } = {}) {
    const pending = new Map();
    function validate(request, sender) {
        const ownUrl = api.runtime.getURL('sidebar.html');
        if (!request || Object.keys(request).some(key => !['type', 'windowId', 'spaceId', 'fallbackToNewTab'].includes(key)) ||
            request.type !== 'spotlightBridgeLaunch' || request.fallbackToNewTab !== true ||
            !isWindowId(request.windowId) || typeof request.spaceId !== 'string' || !request.spaceId || request.spaceId.length > 256 ||
            sender?.id !== api.runtime.id || sender.url !== ownUrl ||
            sender.origin && sender.origin !== api.runtime.getURL('').replace(/\/$/, '') ||
            sender.frameId !== undefined && sender.frameId !== 0 ||
            sender.tab && (sender.tab.windowId !== request.windowId || sender.tab.incognito)) {
            throw bridgeError('INVALID_REQUEST', 'Invalid New Tab source. Open it from this window’s Arcify sidebar.');
        }
    }
    async function run(request) {
        const { windowId, spaceId } = request;
        let sourceTabId = null, drifted = false;
        const cleanups = [];
        const listen = (event, callback) => {
            if (!event?.addListener || !event?.removeListener) return;
            event.addListener(callback); cleanups.push(() => event.removeListener(callback));
        };
        const sourceChanged = id => { if (id === sourceTabId) drifted = true; };
        listen(api.tabs.onActivated, info => { if (info.windowId === windowId && info.tabId !== sourceTabId) drifted = true; });
        listen(api.tabs.onUpdated, (id, changes, tab) => {
            if (changes.url !== undefined || changes.status === 'loading') {
                if (sourceTabId === null && tab?.windowId === windowId && tab.active === true) drifted = true;
                else sourceChanged(id);
            }
        });
        listen(api.tabs.onRemoved, sourceChanged);
        listen(api.tabs.onReplaced, (_added, removed) => sourceChanged(removed));
        listen(api.tabs.onDetached, sourceChanged);
        listen(api.windows.onRemoved, id => { if (id === windowId) drifted = true; });
        listen(api.windows.onFocusChanged, id => { if (id !== windowId) drifted = true; });
        listen(api.storage.onChanged, (changes, area) => {
            if (area === 'local' && (PEER_KEY in changes || PAIRING_GENERATION_KEY in changes) ||
                area === 'session' && changes.activeSpaces && changes.activeSpaces.newValue?.[windowId] !== spaceId) drifted = true;
        });
        const assertUnchanged = () => { if (drifted) throw changed(); };
        try {
            // The shared gate initializes a cold worker before canonical Space reads.
            // It is released before contacting Spotlight to avoid bridge deadlocks.
            await store.run(async () => {});
            const assertSpace = () => {
                if (store.active?.[windowId] !== spaceId || store.spaces.filter(space => space.id === spaceId).length !== 1) throw changed();
            };
            const readContext = async () => {
                assertUnchanged();
                assertSpace();
                const window = await api.windows.get(windowId);
                if (window?.id !== windowId || window.type !== 'normal' || window.incognito || window.focused !== true) throw changed();
                const active = await api.tabs.query({ windowId, active: true });
                if (active.length !== 1 || !isWindowId(active[0].id) || active[0].windowId !== windowId || active[0].incognito) throw changed();
                if (active[0].pendingUrl || active[0].status === 'loading') throw changed();
                sourceTabId ??= active[0].id;
                const pairing = await api.storage.local.get([PEER_KEY, PAIRING_GENERATION_KEY]);
                assertUnchanged();
                assertSpace();
                return { window, tabId: active[0].id, url: active[0].url, pairing };
            };
            const initial = await readContext();
            const peerId = initial.pairing[PEER_KEY];
            const check = async () => {
                const latest = await readContext();
                if (latest.tabId !== initial.tabId || latest.url !== initial.url || initial.window.focused === true && latest.window.focused !== true ||
                    latest.pairing[PEER_KEY] !== peerId || latest.pairing[PAIRING_GENERATION_KEY] !== initial.pairing[PAIRING_GENERATION_KEY]) throw changed();
            };
            let useFallback = peerId === undefined || peerId === null || peerId === '';
            if (!useFallback) {
                // Invalid persisted identity is not evidence of a missing companion.
                if (!isExtensionId(peerId) || peerId === api.runtime.id) throw bridgeError('INVALID_PEER', 'Check the Spotlight pairing in Settings.');
                try {
                    const hello = await send(peerId, 'hello', { windowId });
                    if (hello.extensionId !== peerId) throw bridgeError('INVALID_RESPONSE', 'Companion identity mismatch. Check the Spotlight pairing in Settings.');
                } catch (error) {
                    if (!SAFE_HELLO_FAILURES.has(error.code)) throw error;
                    useFallback = true;
                }
            }
            if (!useFallback) {
                await check();
                // No store lock across a companion launch: Spotlight may read Arcify
                // while opening its UI. The check and dispatch are one continuation.
                assertUnchanged();
                try { await send(peerId, 'launch', { windowId, mode: 'new-tab' }); }
                catch (error) {
                    throw bridgeError(error.code || 'UNCERTAIN_RESULT', 'Spotlight may have opened. Check this window before trying New Tab again.');
                }
                return { ok: true, outcome: 'spotlight' };
            }
            return await store.run(async () => {
                await check();
                let created = false;
                try {
                    // Omit URL so Chrome honors its ordinary/default new-tab provider.
                    // Assign the exact returned tab to the captured Space even when a
                    // provider URL or incidental opener would suggest another owner.
                    assertUnchanged();
                    const tab = await api.tabs.create({ windowId, active: false });
                    created = true;
                    if (!isWindowId(tab?.id) || tab.windowId !== windowId) throw changed();
                    await check();
                    assertUnchanged();
                    await store.applyAction({ action: 'assign', tabId: tab.id, spaceId, pinned: false });
                    await check();
                    assertUnchanged();
                    await api.tabs.update(tab.id, { active: true });
                    return { ok: true, outcome: 'new-tab', tabId: tab.id };
                } catch (error) {
                    throw bridgeError(error.code || 'UNCERTAIN_RESULT', created
                        ? 'A new tab was opened, but its final state could not be confirmed. Check your tabs before trying again.'
                        : 'The new tab result could not be confirmed. Check your tabs before trying again.');
                }
            });
        } finally { for (const cleanup of cleanups) cleanup(); }
    }
    return (request, sender) => {
        try { validate(request, sender); }
        catch (error) { return Promise.reject(error); }
        const existing = pending.get(request.windowId);
        if (existing) return existing.spaceId === request.spaceId ? existing.promise : Promise.reject(changed());
        const promise = run({ ...request }).finally(() => {
            if (pending.get(request.windowId)?.promise === promise) pending.delete(request.windowId);
        });
        pending.set(request.windowId, { spaceId: request.spaceId, promise });
        return promise;
    };
}
