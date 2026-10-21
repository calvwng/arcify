import { assertNotNativeSplit } from './native-split-safety.js';

export const TRANSIENT_CONTROLLER_READY_TIMEOUT_MS = 5000;
const stale = () => Object.assign(new Error('The initial Little Arc controller changed before it was ready.'), { code: 'STALE_TRANSIENT' });
const timeout = () => Object.assign(new Error('The initial Little Arc controller did not become ready in time. No web tab was created or retried.'), { code: 'TRANSIENT_CONTROLLER_TIMEOUT' });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// One-use startup observation for the exact controller returned by windows.create.
// Only its initial marker commit is expected here. The ordinary strict fence is
// never relaxed, and must be installed before this observer is stopped.
export function observeInitialTransientController({ api, controller, windowId, originWindowId, marker, diagnostic = null }) {
    const tabId = controller.id, removals = [];
    let invalidated = null, stopped = false, complete = controller.status === 'complete';
    let revision = 0, completionRevision = complete ? 0 : null;
    let committed = controller.url === marker, commitRevision = committed ? 0 : null;
    let commitEventSeen = false, loadingEventSeen = false, pendingEventSeen = false;
    let signalCompletion, signalFailure;
    const completion = new Promise(resolve => { signalCompletion = resolve; });
    const failure = new Promise(resolve => { signalFailure = resolve; });
    const assert = () => { if (invalidated) throw invalidated; if (stopped) throw stale(); };
    const invalidate = (event, id, update, cause = stale()) => {
        invalidated ||= cause;
        diagnostic?.fence('controller-startup', event, id, update);
        signalFailure(); signalCompletion();
    };
    const markCommitted = () => { if (!committed) commitRevision = revision; committed = true; };
    const markComplete = () => { if (!complete) completionRevision = revision; complete = true; };
    const snapshot = (tab, readRevision = revision) => {
        if (tab?.id !== tabId || tab.windowId !== windowId || tab.incognito !== false || tab.pinned !== false
            || !['loading', 'complete'].includes(tab.status)
            || tab.url && tab.url !== marker && tab.url !== 'about:blank'
            || tab.pendingUrl && tab.pendingUrl !== marker
            || tab.url !== marker && tab.pendingUrl !== marker
            || tab.url === marker && Boolean(tab.pendingUrl)
            || committed && tab.url !== marker && !(readRevision < commitRevision)
            || complete && tab.status === 'loading' && !(readRevision < completionRevision)
            || tab.status === 'complete' && (tab.url !== marker || Boolean(tab.pendingUrl))) throw stale();
        assertNotNativeSplit(tab);
        if (tab.url === marker) markCommitted();
        if (tab.status === 'complete') markComplete();
    };
    snapshot(controller);
    const timer = setTimeout(() => invalidate('timeout', tabId, undefined, timeout()), TRANSIENT_CONTROLLER_READY_TIMEOUT_MS);
    const stop = () => {
        stopped = true; clearTimeout(timer);
        removals.splice(0).forEach(remove => remove());
        signalFailure(); signalCompletion();
    };
    const listen = (event, callback) => {
        if (typeof event?.addListener !== 'function' || typeof event?.removeListener !== 'function') throw stale();
        event.addListener(callback); removals.push(() => event.removeListener(callback));
    };
    try {
        for (const name of ['onRemoved', 'onAttached', 'onDetached']) listen(api.tabs[name], id => {
            if (id === tabId) invalidate(`tabs.${name}`, id);
        });
        listen(api.tabs.onReplaced, (added, removed) => { if (added === tabId || removed === tabId) invalidate('tabs.onReplaced', removed); });
        listen(api.windows.onRemoved, id => { if (id === windowId || id === originWindowId) invalidate('windows.onRemoved', id); });
        listen(api.tabs.onUpdated, (id, update, tab) => {
            if (id !== tabId || invalidated || stopped) return;
            revision++;
            try {
                if (!object(update) || ['pinned', 'splitViewId', 'windowId', 'incognito'].some(key => key in update)
                    || 'status' in update && !['loading', 'complete'].includes(update.status)
                    || 'url' in update && update.url !== marker
                    || 'pendingUrl' in update && update.pendingUrl && update.pendingUrl !== marker
                    || complete && ('url' in update || 'pendingUrl' in update || update.status === 'loading')
                    || committed && ('url' in update || update.status === 'loading' || Boolean(update.pendingUrl))
                    || 'url' in update && commitEventSeen
                    || update.status === 'loading' && commitEventSeen
                    || update.status === 'loading' && !('url' in update) && (committed || loadingEventSeen)
                    || update.pendingUrl && (committed || pendingEventSeen)) throw stale();
                if ('url' in update) { commitEventSeen = true; markCommitted(); }
                if (update.status === 'loading') loadingEventSeen = true;
                if (update.pendingUrl) pendingEventSeen = true;
                if (tab !== undefined) snapshot(tab);
                if (update.status === 'complete') markComplete();
                if (complete) signalCompletion();
            } catch (cause) { invalidate('tabs.onUpdated', id, update, cause); }
        });
    } catch (cause) { stop(); throw cause; }
    return {
        assert, stop,
        async wait() {
            const read = async () => {
                const readRevision = revision;
                let tab;
                try { tab = await api.tabs.get(tabId); }
                catch (cause) { diagnostic?.rejected(cause, 'controller-read-rejected'); throw cause; }
                assert(); diagnostic?.controller(tab, marker);
                snapshot(tab, readRevision);
                return tab.status === 'complete';
            };
            const ready = async () => {
                if (!await read()) {
                    await completion; assert();
                    // An event is only a wake-up, never readiness authority.
                    if (!await read()) throw stale();
                }
                assert();
            };
            try { assert(); await Promise.race([ready(), failure.then(() => assert())]); }
            catch (cause) { invalidated ||= cause; throw cause; }
            finally { clearTimeout(timer); }
        }
    };
}
