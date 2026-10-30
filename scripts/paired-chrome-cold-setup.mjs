import assert from 'node:assert/strict';

// Source-derived debounce observation window, not an end-to-end async bound:
// Arcify space-store.js group projection (200), spotlight-invalidation.js (100),
// Spotlight shared/live-tab-results.js paired cooldown (100) + renderer (40).
// Native tab fan-out (30) + renderer (40) is shorter. Activity restarts this
// observation window; pending requests must finish independently of elapsed time.
export const COLD_SETUP_QUIET_MS = 200 + 100 + 100 + 40;

/** Serialized into an existing Spotlight realm. Observe delivery; never send. */
export function installColdSetupObserver({ kind, peerId, windowId }) {
    if (globalThis.__pairedColdSetup) throw new Error('Cold setup observer is already installed.');
    const results = kind === 'page' ? document.querySelector('[data-testid="spotlight-results"]') : null;
    if (kind === 'page' && !results) throw new Error('Cold setup requires an existing result surface.');
    const events = [], pending = new Map(), failures = [], removers = [];
    let sequence = 0, lastActivity = Date.now(), stopped = false;
    const record = (phase, detail = {}) => {
        lastActivity = Date.now();
        events.push({ phase, ...detail, observedAt: lastActivity });
    };
    const original = chrome.runtime.sendMessage;
    const actions = new Set(['getSpotlightSuggestions', 'getLocalSuggestions', 'getActiveSpaceColor', 'arcifyBridgeStatus', 'spotlightLiveTabContext']);
    function observedSend(...args) {
        const message = kind === 'worker' ? args[1] : args[0];
        const relevant = kind === 'worker'
            ? args[0] === peerId && message?.type === 'arcify-bridge'
            : message && typeof message === 'object' && actions.has(message.action);
        if (!relevant) return Reflect.apply(original, this, args);
        const request = { id: ++sequence, action: message.action || message.command,
            ...(message.requestId ? { requestId: message.requestId } : {}) };
        pending.set(request.id, request); record('request-start', request);
        const finish = (response, error) => {
            if (!pending.delete(request.id)) return;
            const validHello = kind === 'worker' && request.action === 'hello' && response?.type === 'arcify-bridge' &&
                response.version === 1 && response.requestId === message.requestId && response.role === 'arcify' &&
                response.ok === true && response.extensionId === peerId;
            if (kind === 'worker' && request.action === 'hello' && !validHello && !error) error = new Error('Paired hello response was not valid.');
            const failed = !!error || response?.success === false || response?.ok === false;
            record('request-complete', { ...request, failed, ...(request.action === 'hello' ? { validHello } : {}) });
            if (failed) failures.push({ ...request, error: error?.message || response?.error?.message || response?.error || 'Request failed.' });
        };
        const callback = args.at(-1);
        if (typeof callback === 'function') {
            args[args.length - 1] = function (...values) {
                // Read within Chrome's callback scope; the original callback
                // still runs synchronously and sees the same runtime.lastError.
                const transportError = chrome.runtime.lastError;
                let callbackError;
                try { return Reflect.apply(callback, this, values); }
                catch (error) { callbackError = error; throw error; }
                finally { finish(values[0], callbackError || transportError); }
            };
        }
        try {
            const result = Reflect.apply(original, this, args);
            if (typeof callback !== 'function') {
                if (typeof result?.then !== 'function') {
                    finish(undefined, new Error('Observed request has no completion signal.'));
                } else {
                    // Return the original promise unchanged, including rejection.
                    result.then(value => finish(value), error => finish(undefined, error));
                }
            }
            return result;
        } catch (error) { finish(undefined, error); throw error; }
    }
    chrome.runtime.sendMessage = observedSend;
    if (chrome.runtime.sendMessage !== observedSend) throw new Error('Cannot observe real runtime request completion.');
    const listen = (target, name, callback) => {
        target.addEventListener(name, callback); removers.push(() => target.removeEventListener(name, callback));
    };
    const receive = message => {
        if (message?.action === 'spotlightArcifyResultsChanged' && message.windowId === windowId && message.peerId === peerId ||
            message?.action === 'spotlightLiveTabsChanged' && (message.windowId === windowId || message.windowId === null)) {
            record('invalidation', { action: message.action });
        }
        return false;
    };
    try {
        if (kind === 'page') {
            listen(window, 'focus', () => record('focus'));
            listen(document, 'visibilitychange', () => record('visibility', { visibility: document.visibilityState }));
            chrome.runtime.onMessage.addListener(receive);
            removers.push(() => chrome.runtime.onMessage.removeListener(receive));
            const mutation = new MutationObserver(() => record('render'));
            removers.push(() => mutation.disconnect());
            mutation.observe(results, { childList: true, subtree: true, attributes: true, characterData: true });
        }
    } catch (error) {
        chrome.runtime.sendMessage = original;
        removers.forEach(remove => remove());
        throw error;
    }
    record('installed', { kind });
    globalThis.__pairedColdSetup = {
        read() {
            return { kind, now: Date.now(), lastActivity, pending: [...pending.values()], failures: [...failures], events: [...events], stopped,
                ...(kind === 'page' ? { surface: {
                    visible: document.visibilityState === 'visible', focused: document.hasFocus(),
                    inputFocused: document.activeElement?.matches('[data-testid="spotlight-input"]') === true,
                    selected: document.querySelector('[data-testid="spotlight-result"].selected')?.dataset.resultType === 'arcify-sidebar-command',
                    ordinaryResults: document.querySelectorAll('[data-testid="spotlight-result"]:not([data-result-type="arcify-sidebar-command"])').length
                } } : {}) };
        },
        stop() {
            if (stopped) return this.read();
            if (chrome.runtime.sendMessage !== observedSend) throw new Error('Runtime request observer was replaced during setup.');
            chrome.runtime.sendMessage = original;
            if (chrome.runtime.sendMessage !== original) throw new Error('Runtime request observer could not be restored.');
            removers.forEach(remove => remove()); stopped = true; record('observer-restored', { kind });
            return this.read();
        }
    };
}

export function readColdSetupObserver() {
    if (!globalThis.__pairedColdSetup) throw new Error('Cold setup observer is missing.');
    return globalThis.__pairedColdSetup.read();
}
export function stopColdSetupObserver() {
    if (!globalThis.__pairedColdSetup) throw new Error('Cold setup observer is missing.');
    const result = globalThis.__pairedColdSetup.stop();
    delete globalThis.__pairedColdSetup;
    return result;
}

/** Passive reads only. A timeout or failed request fails setup before one stop. */
export async function waitForColdSetupQuiescence(read, record = async () => {}, {
    timeout = 20_000, quietMs = COLD_SETUP_QUIET_MS, interval = 25, now = Date.now,
    sleep = duration => new Promise(resolve => setTimeout(resolve, duration))
} = {}) {
    const deadline = now() + timeout;
    let last;
    do {
        last = await read();
        for (const state of [last.page, last.worker]) {
            assert(state && Array.isArray(state.pending) && Array.isArray(state.events), 'Actual setup observation is required.');
            assert.equal(state.stopped, false, 'Readiness cannot use a stopped observer.');
            assert.equal(state.failures.length, 0, `Setup request failed: ${JSON.stringify(state.failures)}`);
        }
        const surface = last.page.surface;
        const ready = surface?.visible && surface.focused && surface.inputFocused && surface.selected && surface.ordinaryResults > 0;
        const completedHello = last.worker.events.some(event => event.phase === 'request-complete' && event.action === 'hello' && event.validHello === true && !event.failed);
        const idle = [last.page, last.worker].every(state => state.pending.length === 0 && state.now - state.lastActivity >= quietMs);
        // No focus event is required: Chrome may already have focused this tab.
        // If focus did occur, the observed refresh must have completed after it.
        const focus = last.page.events.findLast(event => event.phase === 'focus' || event.phase === 'visibility' && event.visibility === 'visible');
        const focusRefreshFinished = !focus || last.page.events.some(event => event.phase === 'request-complete' &&
            event.action === 'getSpotlightSuggestions' && event.observedAt >= focus.observedAt && !event.failed);
        if (ready && completedHello && idle && focusRefreshFinished) {
            await record({ phase: 'setup-quiescent', quietMs, ...last });
            return last;
        }
        if (now() >= deadline) break;
        await sleep(interval);
    } while (now() < deadline);
    await record({ phase: 'setup-not-quiescent', quietMs, ...last });
    throw new Error(`Cold-worker setup did not quiesce before the single stop: ${JSON.stringify(last)}`);
}
