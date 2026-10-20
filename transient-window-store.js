import { assertNotNativeSplit } from './native-split-safety.js';

export const TRANSIENT_WINDOW_SESSION_KEY = 'transientWindowSession';
const VERSION = 1, MAX_RECORDS = 128, MAX_MEMBERS = 2048, MAX_TOTAL_MEMBERS = 8192;
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const nativeId = value => Number.isSafeInteger(value) && value > 0;
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const copy = value => structuredClone(value);
const error = (code, message) => Object.assign(new Error(message), { code });
const fail = (code, message) => { throw error(code, message); };
const invalid = () => error('INVALID_TRANSIENT_REGISTRY', 'Transient-window session data is malformed. Nothing was overwritten; tab adoption is paused.');
const stale = () => error('STALE_TRANSIENT', 'This transient tab or window changed. Check your windows before trying again.');
const uncertain = () => error('UNCERTAIN_RESULT', 'The browser operation could not be confirmed. Check your windows; no tab was retried, recreated, or closed.');
const partial = () => error('PARTIAL_COMMIT', 'The tab moved, but its Space ownership could not be fully confirmed. Check the destination; the move was not retried or rolled back.');
const fields = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));
const phases = ['opening', 'ready', 'moving', 'committed', 'uncertain', 'orphan'];
const targetValid = target => fields(target, ['windowId', 'spaceId', 'bookmarkFolderId'])
    && nativeId(target.windowId) && text(target.spaceId) && text(target.bookmarkFolderId);

function parseRegistry(value) {
    if (value === undefined) return [];
    if (!fields(value, ['version', 'records']) || value.version !== VERSION || !Array.isArray(value.records)
        || value.records.length > MAX_RECORDS) throw invalid();
    const tokens = new Set(), controllers = new Set(), pages = new Set();
    let members = 0;
    for (const entry of value.records) {
        if (!fields(entry, ['token', 'originWindowId', 'windowId', 'controllerTabId', 'tabId', 'memberTabIds', 'phase', 'target', 'recovered'])
            || !uuid(entry.token) || tokens.has(entry.token) || !phases.includes(entry.phase)
            || !(nativeId(entry.originWindowId) || entry.originWindowId === null && (entry.phase === 'orphan' || entry.recovered === true))
            || entry.recovered !== undefined && entry.recovered !== true
            || entry.recovered === true && (entry.originWindowId !== null || entry.tabId === null
                || !['ready', 'moving', 'committed', 'uncertain'].includes(entry.phase))
            || !(nativeId(entry.windowId) || entry.windowId === null)
            || !(nativeId(entry.controllerTabId) || entry.controllerTabId === null)
            || (entry.windowId === null) !== (entry.controllerTabId === null)
            || !(nativeId(entry.tabId) || entry.tabId === null)
            || entry.tabId !== null && (entry.windowId === null || entry.tabId === entry.controllerTabId || pages.has(entry.tabId))
            || entry.controllerTabId !== null && controllers.has(entry.controllerTabId)
            || !Array.isArray(entry.memberTabIds) || entry.memberTabIds.length > MAX_MEMBERS
            || entry.memberTabIds.some(id => !nativeId(id)) || new Set(entry.memberTabIds).size !== entry.memberTabIds.length
            || entry.controllerTabId !== null && !entry.memberTabIds.includes(entry.controllerTabId)
            || entry.tabId !== null && entry.phase !== 'committed' && !entry.memberTabIds.includes(entry.tabId)
            || entry.windowId === null && (entry.memberTabIds.length || !['opening', 'uncertain'].includes(entry.phase))
            || ['ready', 'moving', 'committed'].includes(entry.phase) && entry.tabId === null
            || ['opening', 'orphan'].includes(entry.phase) && entry.tabId !== null
            || entry.target !== undefined && !targetValid(entry.target)
            || ['moving', 'committed'].includes(entry.phase) && !targetValid(entry.target)
            || ['opening', 'ready', 'orphan'].includes(entry.phase) && entry.target !== undefined
            || (members += entry.memberTabIds.length) > MAX_TOTAL_MEMBERS) throw invalid();
        tokens.add(entry.token);
        if (entry.controllerTabId !== null) controllers.add(entry.controllerTabId);
        if (entry.tabId !== null) pages.add(entry.tabId);
    }
    if ([...pages].some(id => controllers.has(id))) throw invalid();
    return copy(value.records);
}

function validateOpen(request) {
    if (!fields(request, ['url', 'originWindowId']) || !nativeId(request.originWindowId)
        || typeof request.url !== 'string' || request.url.length > 8192 || !/^https?:\/\/[^/]/i.test(request.url)
        || /[\s\\\x00-\x1f\x7f]/.test(request.url))
        fail('INVALID_TRANSIENT_REQUEST', 'Choose one HTTP or HTTPS URL and its originating browser window.');
    let url;
    try { url = new URL(request.url); } catch { /* Rejected below. */ }
    if (!url || !['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password)
        fail('INVALID_TRANSIENT_REQUEST', 'Transient windows require an HTTP or HTTPS URL without embedded credentials.');
}

// This registry is session-only. No persisted URL, URL lookup, restore/replay,
// ownership-model mutation, automatic cleanup, tab removal, or window removal.
// Unlocked methods belong inside the caller's existing SpaceStore queue.
export function createTransientWindowStore({ api = chrome } = {}) {
    const controllerPage = api.runtime.getURL('transient-window.html');
    const marker = token => `${controllerPage}?token=${token}`;
    const markerToken = tab => {
        for (const url of [tab?.url, tab?.pendingUrl]) {
            if (typeof url !== 'string' || !url.startsWith(`${controllerPage}?token=`)) continue;
            const token = url.slice(`${controllerPage}?token=`.length);
            if (uuid(token) && url === marker(token)) return token;
        }
        return null;
    };
    let records = [], initialized = false, provenanceReady = false, initializing, failure = null, revision = 0, savedRevision = 0;
    const admissions = new Map(), early = new Map(), extraIds = new Set(), extraWindows = new Set(), unsettled = new Set();
    const replacements = [], removedTabs = new Set(), removedWindows = new Set();
    const pendingRemovedTabs = new Set(), pendingRemovedWindows = new Set();
    const changed = () => { revision++; };
    const block = cause => { failure ||= cause; return cause; };
    const assertHealthy = () => { if (failure) throw failure; };
    const normal = (window, id) => window?.id === id && window.type === 'normal' && window.incognito === false;
    const windowKnown = id => extraWindows.has(id) || records.some(entry => entry.windowId === id);
    const include = (entry, id) => {
        if (!nativeId(id) || entry.memberTabIds.includes(id)) return;
        if (entry.memberTabIds.length >= MAX_MEMBERS || records.reduce((sum, item) => sum + item.memberTabIds.length, 0) >= MAX_TOTAL_MEMBERS) {
            block(invalid()); extraIds.add(id); return;
        }
        entry.memberTabIds.push(id); changed();
    };
    const releasedFrom = (tabId, windowId) => records.some(entry => entry.phase === 'committed'
        && entry.tabId === tabId && entry.windowId === windowId && !entry.memberTabIds.includes(tabId));
    const isKnownTransientWindow = windowId => nativeId(windowId) && windowKnown(windowId);
    const isTransientWindow = windowId => nativeId(windowId) && (!!failure || windowKnown(windowId));
    // Event provenance needs positive knowledge, not the public pre-initialize
    // fail-closed gate. Otherwise an ordinary cold removal/replacement becomes
    // a permanent transient claim simply because hydration has not finished.
    const isKnownExcluded = tabOrId => {
        const tabId = typeof tabOrId === 'number' ? tabOrId : tabOrId?.id;
        if (!nativeId(tabId)) return false;
        if (unsettled.has(tabId) || extraIds.has(tabId)) return true;
        if (typeof tabOrId === 'object' && (markerToken(tabOrId) || windowKnown(tabOrId.windowId) && !releasedFrom(tabId, tabOrId.windowId))) return true;
        return records.some(entry => entry.memberTabIds.includes(tabId) || entry.phase !== 'committed' && entry.tabId === tabId);
    };
    const isExcluded = tabOrId => {
        const tabId = typeof tabOrId === 'number' ? tabOrId : tabOrId?.id;
        if (!nativeId(tabId)) return false;
        if (!initialized || failure) return true;
        if (admissions.has(tabId)) return false;
        return isKnownExcluded(tabOrId);
    };
    function observe(tab) {
        if (!nativeId(tab?.id) || !nativeId(tab.windowId)) return false;
        if (failure) return true;
        if (!provenanceReady && pendingRemovedTabs.has(tab.id)) return isKnownExcluded(tab);
        const token = markerToken(tab);
        // First-version restart policy: after session state is cleared, only an
        // exact surviving controller can establish transient provenance. An
        // unmarked restored page follows ordinary tab handling; never infer its
        // old status from a web URL or impose a profile-wide recovery hold.
        if (!provenanceReady) {
            // Keep every observed native window provenance, not just the latest
            // snapshot: a tab can leave a transient window while storage loads.
            // Ordinary page URLs have no role in recovery and are not buffered.
            const key = `${tab.id}:${tab.windowId}:${token || ''}`;
            if (early.size >= MAX_TOTAL_MEMBERS && !early.has(key)) block(invalid());
            else early.set(key, { id: tab.id, windowId: tab.windowId, ...(token ? { url: marker(token) } : {}) });
        }
        if (token) {
            let entry = records.find(item => item.token === token);
            // A finished transfer is independent of the remaining control tab.
            // A replaced/moved/copied old marker quarantines that marker only;
            // it cannot rebind controller authority or re-exclude the page.
            if (entry?.phase === 'committed') {
                if (tab.id !== entry.tabId) { extraIds.add(tab.id); include(entry, tab.id); }
            } else {
                extraWindows.add(tab.windowId); extraIds.add(tab.id);
            }
            if (!entry) {
                if (records.length >= MAX_RECORDS) block(invalid());
                else {
                    entry = { token, originWindowId: null, windowId: tab.windowId, controllerTabId: tab.id,
                        tabId: null, memberTabIds: [tab.id], phase: 'orphan' };
                    records.push(entry); changed();
                }
            } else if (entry.phase === 'committed') {
                // Retain the original exact controller/window IDs as history.
            } else if (entry.windowId === null && entry.controllerTabId === null) {
                entry.windowId = tab.windowId; entry.controllerTabId = tab.id; include(entry, tab.id); changed();
            } else if (entry.windowId !== tab.windowId || entry.controllerTabId !== tab.id) {
                // A copied/restored marker is not permission to rebind an exact ID.
                block(error('UNCERTAIN_RESULT', 'Conflicting transient controller identities were found. Tab adoption is paused.'));
            }
        }
        for (const entry of records) if (entry.windowId === tab.windowId
            && !(entry.phase === 'committed' && entry.tabId === tab.id)) include(entry, tab.id);
        if (extraWindows.has(tab.windowId) && !releasedFrom(tab.id, tab.windowId)) extraIds.add(tab.id);
        return isExcluded(tab);
    }
    // Replacement is a new native identity, never proof of the original page.
    function observeReplacement(addedTabId, removedTabId) {
        if (!nativeId(addedTabId) || !nativeId(removedTabId)) return false;
        if (failure) return true;
        if (!provenanceReady) {
            if (replacements.length >= MAX_TOTAL_MEMBERS) block(invalid());
            else replacements.push([addedTabId, removedTabId]);
            return isExcluded(addedTabId);
        }
        if (!isKnownExcluded(removedTabId)) return false;
        extraIds.add(addedTabId);
        for (const entry of records) if (entry.memberTabIds.includes(removedTabId) || entry.tabId === removedTabId || entry.controllerTabId === removedTabId) {
            include(entry, addedTabId);
            if (entry.phase !== 'committed' || removedTabId === entry.tabId && unsettled.has(entry.tabId)) {
                if (entry.phase !== 'orphan') entry.phase = 'uncertain';
                if (nativeId(entry.tabId)) include(entry, entry.tabId);
            }
            changed();
        }
        return true;
    }
    const observeDetached = (tabId, oldWindowId) => observe({ id: tabId, windowId: oldWindowId });
    const bufferRemoval = (set, id) => {
        if (set.size >= MAX_TOTAL_MEMBERS && !set.has(id)) block(invalid());
        else set.add(id);
    };
    const observeRemoved = tabId => {
        if (!nativeId(tabId)) return;
        if (!provenanceReady) { bufferRemoval(pendingRemovedTabs, tabId); return; }
        if (extraIds.has(tabId) || records.some(entry => entry.memberTabIds.includes(tabId))) removedTabs.add(tabId);
    };
    const observeWindowRemoved = windowId => {
        if (!nativeId(windowId)) return;
        if (!provenanceReady) { bufferRemoval(pendingRemovedWindows, windowId); return; }
        if (windowKnown(windowId)) removedWindows.add(windowId);
    };
    function pruneClosed() {
        // Only exact native removal events prove closure. A missing controller
        // alone never releases a surviving or dragged-out page's quarantine.
        const survivors = records.filter(entry => !(removedWindows.has(entry.windowId)
            && entry.memberTabIds.every(id => removedTabs.has(id))));
        if (survivors.length !== records.length) { records = survivors; changed(); }
        for (const id of removedTabs) {
            extraIds.delete(id); unsettled.delete(id);
            if (!records.some(entry => entry.memberTabIds.includes(id))) removedTabs.delete(id);
        }
        for (const id of removedWindows) if (!records.some(entry => entry.windowId === id)) {
            extraWindows.delete(id); removedWindows.delete(id);
        }
    }
    async function save() {
        assertHealthy();
        const snapshot = { version: VERSION, records: copy(records) }, snapshotRevision = revision;
        parseRegistry(snapshot);
        try { await api.storage.session.set({ [TRANSIENT_WINDOW_SESSION_KEY]: snapshot }); }
        catch { throw block(error('TRANSIENT_STORAGE_UNAVAILABLE', 'Transient-window session data could not be saved. No pending browser action was retried.')); }
        savedRevision = snapshotRevision;
    }
    async function flushObservedUnlocked() {
        await initialize(); assertHealthy(); pruneClosed();
        while (savedRevision !== revision) await save();
    }
    async function quarantine(entry, cause) {
        if (entry.phase !== 'orphan') entry.phase = 'uncertain';
        if (nativeId(entry.tabId)) { include(entry, entry.tabId); unsettled.add(entry.tabId); }
        changed();
        if (!failure) { try { await save(); } catch { /* Pending journal remains authoritative. */ } }
        throw cause;
    }
    async function getWindow(id, code = 'STALE_TRANSIENT') {
        let window;
        try { window = await api.windows.get(id); } catch { fail(code, 'The exact browser window is no longer available. Choose a surviving destination explicitly.'); }
        if (!normal(window, id)) fail(code, 'Choose an ordinary, non-incognito browser window.');
        return window;
    }
    async function getPage(entry, windowId = entry.windowId) {
        let tab;
        try { tab = await api.tabs.get(entry.tabId); } catch { throw stale(); }
        if (tab?.id !== entry.tabId || tab.windowId !== windowId || tab.incognito !== false || tab.pinned !== false) throw stale();
        assertNotNativeSplit(tab);
        return tab;
    }
    async function getController(entry) {
        let tab;
        try { tab = await api.tabs.get(entry.controllerTabId); } catch { throw stale(); }
        if (tab?.id !== entry.controllerTabId || tab.windowId !== entry.windowId || markerToken(tab) !== entry.token
            || tab.url && tab.url !== marker(entry.token) || tab.pendingUrl && tab.pendingUrl !== marker(entry.token)
            || tab.incognito !== false || tab.pinned !== false) throw stale();
        assertNotNativeSplit(tab);
        return tab;
    }
    // Native browser operations cannot be locked. Events fence awaited reads and
    // journal writes; listeners are removed immediately before our own dispatch.
    function fence(tabIds, windowIds, controllerTabId = null, selectionTabId = null) {
        let invalidated = false;
        const removals = [], mark = () => { invalidated = true; };
        const listen = (event, callback) => {
            if (!event?.addListener || !event?.removeListener) return;
            event.addListener(callback); removals.push(() => event.removeListener(callback));
        };
        for (const name of ['onRemoved', 'onAttached', 'onDetached']) listen(api.tabs?.[name], id => { if (tabIds.includes(id)) mark(); });
        listen(api.tabs?.onReplaced, (added, removed) => { if (tabIds.includes(added) || tabIds.includes(removed)) mark(); });
        listen(api.tabs?.onUpdated, (id, update) => {
            if (tabIds.includes(id) && (!object(update)
                || ['pinned', 'splitViewId', 'windowId', 'incognito'].some(key => key in update)
                || (id === controllerTabId || id === selectionTabId) && (['url', 'pendingUrl'].some(key => key in update) || update.status === 'loading'))) mark();
        });
        listen(api.windows?.onRemoved, id => { if (windowIds.includes(id)) mark(); });
        return { assert() { if (invalidated) throw stale(); }, stop() { removals.splice(0).forEach(remove => remove()); } };
    }
    async function initialize() {
        if (initializing) return initializing;
        initializing = (async () => {
            try {
                const stored = await api.storage.session.get(TRANSIENT_WINDOW_SESSION_KEY);
                if (!object(stored)) throw invalid();
                records = parseRegistry(stored?.[TRANSIENT_WINDOW_SESSION_KEY]);
                revision = 0; savedRevision = 0;
                for (const entry of records) if (['opening', 'moving'].includes(entry.phase)) { entry.phase = 'uncertain'; changed(); }
                const controllers = await api.tabs.query({ url: `${controllerPage}?token=*` });
                if (!Array.isArray(controllers)) throw uncertain();
                for (const tab of controllers) if (markerToken(tab)) observe(tab);
                const buffered = [...early.values()];
                early.clear(); provenanceReady = true;
                for (const tab of buffered) observe(tab);
                for (const [added, removed] of replacements.splice(0)) observeReplacement(added, removed);
                // Apply closes only after every buffered identity/transition is
                // known. A replacement may survive a closed original window.
                for (const id of pendingRemovedTabs) observeRemoved(id);
                for (const id of pendingRemovedWindows) observeWindowRemoved(id);
                pendingRemovedTabs.clear(); pendingRemovedWindows.clear();
                pruneClosed(); assertHealthy();
                for (const entry of records) {
                    if (entry.windowId === null) continue;
                    let live = false;
                    try {
                        await getWindow(entry.windowId); live = true;
                        await getController(entry);
                        if (entry.phase === 'ready') await getPage(entry);
                    } catch {
                        if (!['orphan', 'committed', 'uncertain'].includes(entry.phase)) { entry.phase = 'uncertain'; changed(); }
                    }
                    if (live) {
                        const tabs = await api.tabs.query({ windowId: entry.windowId });
                        if (!Array.isArray(tabs)) throw uncertain();
                        for (const tab of tabs) if (tab?.windowId === entry.windowId) observe(tab);
                    }
                }
                assertHealthy(); pruneClosed();
                while (savedRevision !== revision) await save();
                initialized = true;
            } catch (cause) { block(cause); throw cause; }
        })();
        return initializing;
    }
    async function withAdmission(tabId, operation) {
        if (!nativeId(tabId) || typeof operation !== 'function') fail('INVALID_TRANSIENT_REQUEST', 'An exact tab ID and ownership operation are required.');
        await initialize(); assertHealthy();
        admissions.set(tabId, (admissions.get(tabId) || 0) + 1);
        try { return await operation(); }
        finally {
            const count = admissions.get(tabId) - 1;
            if (count) admissions.set(tabId, count); else admissions.delete(tabId);
        }
    }
    async function openUnlocked(request, { beforeMutation = async () => {} } = {}) {
        validateOpen(request);
        await initialize(); assertHealthy();
        if (typeof beforeMutation !== 'function') fail('INVALID_TRANSIENT_REQUEST', 'Invalid transient-window mutation guard.');
        if (records.length >= MAX_RECORDS) fail('TRANSIENT_LIMIT', 'This session has reached its transient-window safety limit.');
        const origin = async () => { await getWindow(request.originWindowId); if (windowKnown(request.originWindowId)) throw stale(); };
        await origin(); await beforeMutation(); await origin();
        const token = crypto.randomUUID();
        if (!uuid(token) || records.some(item => item.token === token)) throw invalid();
        const entry = { token, originWindowId: request.originWindowId, windowId: null, controllerTabId: null,
            tabId: null, memberTabIds: [], phase: 'opening' };
        records.push(entry); changed();
        const openingFence = fence([], [request.originWindowId]);
        let created;
        try {
            await save(); await origin();
            // Pairing/controller authority can change during every awaited read,
            // including the pending journal write. The guard is the last
            // persisted authority read; only synchronous checks follow it.
            await beforeMutation(); openingFence.assert(); assertHealthy();
            if (windowKnown(request.originWindowId)) throw stale();
            openingFence.stop();
            try { created = await api.windows.create({ url: marker(token), type: 'normal', width: 900, height: 720, focused: true, incognito: false }); }
            catch { return await quarantine(entry, uncertain()); }
        } finally { openingFence.stop(); }
        if (nativeId(created?.id)) extraWindows.add(created.id);
        for (const tab of Array.isArray(created?.tabs) ? created.tabs : []) if (nativeId(tab?.id)) extraIds.add(tab.id);
        try {
            if (!nativeId(created?.id) || !normal(created, created.id) || created.id === request.originWindowId
                || !Array.isArray(created.tabs) || created.tabs.length !== 1) throw uncertain();
            const controller = created.tabs[0];
            if (!nativeId(controller?.id) || controller.windowId !== created.id || markerToken(controller) !== token
                || entry.windowId !== null && (entry.windowId !== created.id || entry.controllerTabId !== controller.id)) throw uncertain();
            entry.windowId = created.id; entry.controllerTabId = controller.id; include(entry, controller.id); changed();
            // Journal exact returned controller/window IDs before any web tab.
            await save();
            const webFence = fence([entry.controllerTabId], [request.originWindowId, entry.windowId], entry.controllerTabId);
            let page;
            try {
                await beforeMutation(); await origin(); await getWindow(entry.windowId); await getController(entry);
                await beforeMutation();
                webFence.assert(); assertHealthy();
                if (entry.phase !== 'opening' || windowKnown(request.originWindowId)) throw uncertain();
                webFence.stop();
                try { page = await api.tabs.create({ windowId: entry.windowId, url: request.url, active: true, pinned: false }); }
                catch { throw uncertain(); }
            } finally { webFence.stop(); }
            if (nativeId(page?.id) && page.id !== entry.controllerTabId) { entry.tabId = page.id; include(entry, page.id); }
            if (!nativeId(entry.tabId) || page.windowId !== entry.windowId) throw uncertain();
            await getPage(entry); await getController(entry); await getWindow(entry.windowId);
            if (entry.phase !== 'opening') throw uncertain();
            entry.phase = 'ready'; changed(); await save();
            return copy(entry);
        } catch (cause) { return quarantine(entry, cause.code === 'UNCERTAIN_RESULT' ? cause : uncertain()); }
    }
    // Explicitly select an observed orphan member, without moving or admitting
    // it. The pending journal is uncertain so interruption cannot auto-select a
    // page. A recovered record deliberately retains an unknown origin window.
    async function recoverUnlocked(request, { beforeMutation = async () => {}, validateSelection } = {}) {
        if (!fields(request, ['token', 'tabId']) || !uuid(request.token) || !nativeId(request.tabId)
            || typeof beforeMutation !== 'function' || validateSelection !== undefined && typeof validateSelection !== 'function')
            fail('INVALID_TRANSIENT_REQUEST', 'Choose one exact observed page in this recovered transient window.');
        await initialize(); assertHealthy();
        const entry = records.find(item => item.token === request.token);
        if (!entry) throw stale();
        if (entry.recovered === true && entry.phase === 'ready')
            fail('ALREADY_RECOVERED', 'A page has already been selected for this transient window.');
        if (entry.phase !== 'orphan' || entry.tabId !== null || entry.originWindowId !== null) throw uncertain();
        const resolved = { token: request.token, tabId: request.tabId, windowId: entry.windowId };
        const assertSelection = () => {
            if (!records.includes(entry) || request.tabId === entry.controllerTabId || !entry.memberTabIds.includes(request.tabId)) throw stale();
            if (records.some(other => other !== entry && (other.memberTabIds.includes(request.tabId)
                || other.tabId === request.tabId || other.controllerTabId === request.tabId)))
                fail('AMBIGUOUS_TRANSIENT_MEMBERSHIP', 'This page has another transient identity and cannot be selected automatically.');
        };
        const readSelection = async () => {
            assertSelection();
            let tab;
            try { tab = await api.tabs.get(request.tabId); } catch { throw stale(); }
            if (tab?.id !== request.tabId || tab.windowId !== entry.windowId || tab.incognito !== false || tab.pinned !== false
                || [tab.url, tab.pendingUrl].some(url => typeof url === 'string' && /^chrome-extension:/i.test(url))) throw stale();
            assertNotNativeSplit(tab);
            validateOpen({ url: tab.pendingUrl || tab.url, originWindowId: entry.windowId });
            return tab;
        };
        const validate = async () => {
            await getWindow(entry.windowId); await getController(entry);
            const tab = await readSelection();
            if (validateSelection) {
                const result = await validateSelection(tab, copy(resolved));
                if (result === false || result?.success === false) throw stale();
            }
            await getWindow(entry.windowId); await getController(entry);
            return readSelection();
        };
        assertSelection();
        const selectionFence = fence([request.tabId, entry.controllerTabId], [entry.windowId], entry.controllerTabId, request.tabId);
        let journaled = false;
        try {
            await validate(); await beforeMutation(); await validate();
            await beforeMutation(); selectionFence.assert(); assertHealthy(); assertSelection();
            if (entry.phase !== 'orphan' || entry.tabId !== null) throw uncertain();
            entry.recovered = true; entry.tabId = request.tabId; entry.phase = 'uncertain'; changed(); journaled = true;
            await save();
            await validate(); await beforeMutation(); selectionFence.assert(); assertHealthy(); assertSelection();
            if (entry.phase !== 'uncertain' || entry.tabId !== request.tabId) throw uncertain();
            entry.phase = 'ready'; changed(); await save();
            await validate(); await beforeMutation(); selectionFence.assert(); assertHealthy(); assertSelection();
            if (entry.phase !== 'ready' || entry.tabId !== request.tabId) throw uncertain();
            return copy(entry);
        } catch (cause) {
            if (journaled) return quarantine(entry, cause);
            throw cause;
        } finally { selectionFence.stop(); }
    }
    async function promoteUnlocked(request, { beforeMutation = async () => {}, commitOwnership } = {}) {
        if (!fields(request, ['token', 'tabId', 'windowId', 'spaceId', 'bookmarkFolderId']) || !uuid(request.token)
            || !nativeId(request.tabId) || request.windowId !== undefined && !nativeId(request.windowId)
            || !text(request.spaceId) || !text(request.bookmarkFolderId) || typeof beforeMutation !== 'function'
            || typeof commitOwnership !== 'function' || commitOwnership.validate !== undefined && typeof commitOwnership.validate !== 'function')
            fail('INVALID_TRANSIENT_REQUEST', 'Choose the exact transient tab and an existing Space destination.');
        await initialize(); assertHealthy();
        const entry = records.find(item => item.token === request.token);
        if (!entry || entry.tabId !== request.tabId) throw stale();
        if (entry.phase === 'committed') fail('ALREADY_COMMITTED', 'This transient tab has already been moved to its Space.');
        if (entry.phase !== 'ready') throw uncertain();
        const assertExclusive = () => {
            if (records.some(other => other !== entry && (other.memberTabIds.includes(entry.tabId)
                || other.phase !== 'committed' && other.tabId === entry.tabId)))
                fail('AMBIGUOUS_TRANSIENT_MEMBERSHIP', 'This page has been observed in another transient window. Its ownership cannot be safely transferred automatically.');
        };
        assertExclusive();
        const resolved = { ...request, windowId: request.windowId ?? entry.originWindowId };
        if (!nativeId(resolved.windowId)) fail('TARGET_REQUIRED', 'Choose a destination window explicitly; the original window is unavailable.');
        const readTarget = async () => {
            await getWindow(resolved.windowId, request.windowId === undefined ? 'TARGET_REQUIRED' : 'STALE_TARGET');
            if (windowKnown(resolved.windowId)) fail('INVALID_TRANSIENT_TARGET', 'Choose a destination outside every transient window.');
        };
        const validate = async () => {
            assertExclusive();
            await getWindow(entry.windowId); await getController(entry);
            const tab = await getPage(entry);
            await readTarget();
            if (commitOwnership.validate) await commitOwnership.validate(tab, copy(resolved));
            await readTarget();
            return getPage(entry);
        };
        const movingFence = fence([entry.tabId, entry.controllerTabId], [entry.windowId, resolved.windowId], entry.controllerTabId);
        let moved, dispatched = false;
        try {
            await validate(); await beforeMutation(); await validate(); movingFence.assert();
            if (entry.phase !== 'ready') throw uncertain();
            entry.phase = 'moving'; entry.target = { windowId: resolved.windowId, spaceId: resolved.spaceId, bookmarkFolderId: resolved.bookmarkFolderId }; changed();
            await save(); await validate();
            await beforeMutation(); movingFence.assert(); assertHealthy(); assertExclusive();
            if (windowKnown(resolved.windowId)) throw stale();
            if (entry.phase !== 'moving') throw uncertain();
            movingFence.stop();
            dispatched = true;
            moved = await api.tabs.move(entry.tabId, { windowId: resolved.windowId, index: -1 });
            if (Array.isArray(moved)) moved = moved.length === 1 ? moved[0] : null;
            if (moved?.id !== entry.tabId || moved.windowId !== resolved.windowId) throw uncertain();
        } catch (cause) {
            if (dispatched) return quarantine(entry, uncertain());
            // A persisted moving journal is never reset for automatic replay.
            if (entry.phase === 'moving') return quarantine(entry, cause);
            throw cause;
        } finally { movingFence.stop(); }
        try {
            await readTarget(); moved = await getPage(entry, resolved.windowId);
            await withAdmission(entry.tabId, async () => {
                const result = await commitOwnership(moved, copy(resolved));
                if (result === false || result?.success === false) throw partial();
            });
            await readTarget(); await getPage(entry, resolved.windowId);
            // Do not release exclusion while the committed journal is in flight.
            if (entry.phase !== 'moving') throw partial();
            assertExclusive();
            unsettled.add(entry.tabId);
            entry.phase = 'committed'; entry.memberTabIds = entry.memberTabIds.filter(id => id !== entry.tabId); changed();
            await save();
            await readTarget(); const finalTab = await getPage(entry, resolved.windowId);
            assertHealthy(); assertExclusive();
            if (entry.phase !== 'committed') throw partial();
            unsettled.delete(entry.tabId); extraIds.delete(entry.tabId);
            if (isKnownExcluded(finalTab)) throw partial();
            return { token: entry.token, tabId: entry.tabId, windowId: resolved.windowId,
                spaceId: resolved.spaceId, bookmarkFolderId: resolved.bookmarkFolderId, phase: 'committed' };
        } catch { return quarantine(entry, partial()); }
    }
    async function listUnlocked() { await flushObservedUnlocked(); return copy(records); }
    return { initialize, isExcluded, isKnownExcluded, isTransientWindow, isKnownTransientWindow, observe, observeReplacement, observeDetached, observeRemoved, observeWindowRemoved, openUnlocked, recoverUnlocked, promoteUnlocked, listUnlocked, withAdmission, flushObservedUnlocked };
}
