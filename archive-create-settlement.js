// Ephemeral proof for one fresh tabs.create call, never a resumed durable claim.
// This tracks observable native-ID/URL continuity, not page-document identity.
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const encode = value => JSON.stringify(value, (_key, item) => record(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const same = (a, b) => encode(a) === encode(b);
const error = (code, message) => Object.assign(new Error(message), { code });
export const ARCHIVE_CREATE_SETTLE_TIMEOUT_MS = 4000;
export const ARCHIVE_CREATE_EVENT_LIMIT = 256;

export function observeArchiveCreate(request, { api = chrome, timeoutMs = ARCHIVE_CREATE_SETTLE_TIMEOUT_MS,
    schedule = setTimeout, cancel = clearTimeout } = {}) {
    const cleanup = [], authorityCleanup = [], buffered = [];
    let tabId = null, phase = 'unbound', created = false, failure = null, stopped = false, wake = null, timer;
    const notify = () => { wake?.(); wake = null; };
    const reject = (reason, code = 'STALE_ARCHIVE') => { failure ||= error(code, reason); notify(); };
    const assert = () => { if (failure) throw failure; if (stopped) throw error('STALE_ARCHIVE', 'The initial archived-tab observation ended.'); };
    const ordinary = tab => Number.isSafeInteger(tabId) && tabId > 0 && record(tab) && tab.id === tabId && tab.windowId === request.windowId && tab.active === false
        && tab.pinned === false && tab.incognito === false && (tab.splitViewId ?? -1) === -1 && (tab.groupId ?? -1) === -1;
    const presentation = change => record(change) && Object.keys(change).length > 0 && Object.entries(change).every(([key, value]) =>
        ['title', 'favIconUrl'].includes(key) && typeof value === 'string' || key === 'status' && value === 'complete');
    const process = event => {
        if (event.kind === 'created') {
            if (created || !ordinary(event.tab)) return reject('The newly created archived tab changed before it could be confirmed.');
            created = true;
            if (event.tab.url === '' && event.tab.pendingUrl === request.expected.url && event.tab.status === 'loading') phase = 'pending';
            else reject('The initial archived-tab URL could not be confirmed.');
        } else if (!created) reject('The initial archived-tab creation event was missing.');
        else if (event.kind !== 'updated') reject('The newly created archived tab was moved, activated, removed or replaced.');
        else {
            const change = event.change;
            if (phase === 'pending' && record(change) && Object.keys(change).length === 2 && change.status === 'loading' && change.url === request.expected.url) phase = 'loading';
            else if (presentation(change)) {
                if (change.status === 'complete') {
                    if (phase === 'pending') reject('The initial archived-tab navigation could not be confirmed.');
                    else phase = 'complete';
                }
            } else reject('The newly created archived tab navigated again or changed.');
        }
        if (phase === 'complete') { cancel(timer); timer = undefined; notify(); }
    };
    const native = event => {
        if (event.id === request.context.sourceTabId) return reject('The Archive source tab changed during creation.');
        if (tabId !== null) { if (event.id === tabId) process(event); return; }
        if (buffered.length >= ARCHIVE_CREATE_EVENT_LIMIT) return reject('Too many native events arrived to confirm the archived tab safely.');
        buffered.push(event);
    };
    const listen = (event, callback, authority = false) => {
        if (!event?.addListener || !event.removeListener) throw error('UNAVAILABLE', 'Native archived-tab lifecycle observation is unavailable.');
        event.addListener(callback); const remove = () => event.removeListener(callback); cleanup.push(remove); if (authority) authorityCleanup.push(remove);
    };
    const stop = () => { if (stopped) return; stopped = true; cancel(timer); cleanup.forEach(remove => remove()); buffered.length = 0; notify(); };
    try {
        listen(api.tabs.onCreated, tab => native({ kind: 'created', id: tab?.id, tab: structuredClone(tab) }));
        listen(api.tabs.onUpdated, (id, change) => native({ kind: 'updated', id, change: structuredClone(change) }));
        for (const name of ['onRemoved', 'onAttached', 'onDetached', 'onMoved']) listen(api.tabs[name], id => native({ kind: name, id }));
        listen(api.tabs.onReplaced, (added, removed) => { native({ kind: 'replaced', id: added }); native({ kind: 'replaced', id: removed }); });
        listen(api.tabs.onActivated, info => { if (info.windowId === request.windowId) reject('The active Archive source changed during creation.'); });
        listen(api.windows.onRemoved, id => { if (id === request.windowId) reject('The Archive source window closed during creation.'); });
        for (const name of ['onChanged', 'onMoved', 'onRemoved', 'onCreated']) listen(api.bookmarks[name], () => reject('The Archive bookmark context changed during creation.'), true);
        listen(api.storage.onChanged, (changes, area) => {
            const keys = area === 'local' ? ['archivedTabs', 'spaces', 'pinnedTabStatesById', 'persistentFavorites', 'arcifyBridgePeerId', 'arcifyBridgePairingGeneration']
                : area === 'session' ? ['activeSpaces', 'favoriteSession', 'archiveBrowserSession'] : [];
            if (keys.some(key => key in changes && !same(changes[key].oldValue, changes[key].newValue)))
                reject('The Archive record, Space or pairing changed during creation.');
        }, true);
        timer = schedule(() => reject('The newly created archived tab did not finish its initial load. The entry is retained; nothing was retried.', 'ARCHIVE_LOAD_TIMEOUT'), timeoutMs);
    } catch (cause) { stop(); throw cause; }
    return {
        bind(tab) {
            if (tabId !== null) { reject('The initial archived-tab identity was bound twice.'); return; }
            tabId = tab.id;
            if (!ordinary(tab) || !(tab.url === request.expected.url && (!tab.pendingUrl || tab.pendingUrl === request.expected.url)
                || tab.url === '' && tab.pendingUrl === request.expected.url)) reject('The returned archived-tab identity or URL changed.');
            for (const event of buffered) if (event.id === tabId) process(event);
            buffered.length = 0;
            if (!created) reject('The exact archived-tab creation event was not observed.');
        },
        async wait() {
            assert();
            if (phase !== 'complete') await new Promise(resolve => { wake = resolve; });
            assert();
            if (phase !== 'complete') throw error('STALE_ARCHIVE', 'The archived tab did not reach a confirmed initial load.');
            cancel(timer); timer = undefined;
        },
        assert,
        verify(tab) {
            assert();
            if (phase !== 'complete' || !ordinary(tab) || tab.url !== request.expected.url || tab.pendingUrl || tab.status !== 'complete')
                reject('The exact newly created archived tab is no longer settled at its requested URL.');
            assert();
        },
        handoffAuthority() {
            // Called synchronously after the first strict target read returns.
            // Native source/target observation continues until consumption.
            assert(); authorityCleanup.splice(0).forEach(remove => remove());
        },
        stop
    };
}
