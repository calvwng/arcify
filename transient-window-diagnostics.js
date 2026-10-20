// Test-installed, worker-local observation only. No route, storage, URL/token
// payloads, callbacks, native API reads or asynchronous work. With no sink this
// returns null and retains nothing. Diagnostics never authorize an operation.
export const TRANSIENT_OPEN_DIAGNOSTIC_KEY = 'arcify.transient-open.diagnostics.v1';
export const TRANSIENT_OPEN_DIAGNOSTIC_LIMIT = 256;
const errorCodes = new Set(['STALE_TRANSIENT', 'UNCERTAIN_RESULT', 'INVALID_TRANSIENT_REGISTRY',
    'TRANSIENT_STORAGE_UNAVAILABLE', 'TRANSIENT_CONTROLLER_TIMEOUT', 'NATIVE_SPLIT_ACTIVE', 'UNPAIRED', 'UNAUTHORIZED',
    'FEATURE_UNAVAILABLE', 'UNSUPPORTED_FEATURE', 'PAIRING_CHANGED']);
const id = value => Number.isSafeInteger(value) && value > 0 ? value : null;
const status = value => ['loading', 'complete', 'unloaded'].includes(value) ? value : null;
const boolean = value => typeof value === 'boolean' ? value : null;
const urlState = (value, expected) => !value ? 'absent' : value === expected ? 'exact-marker' : value === 'about:blank' ? 'about-blank' : 'other';

export function createTransientOpenDiagnostic(entry) {
    let sink;
    try {
        // Access data properties only, so installing an accessor is not a hook.
        sink = Object.getOwnPropertyDescriptor(globalThis, Symbol.for(TRANSIENT_OPEN_DIAGNOSTIC_KEY))?.value;
        if (!Array.isArray(sink)) return null;
    } catch { return null; }
    let stage = 'opening';
    const emit = (event, details = {}) => {
        try {
            const length = Object.getOwnPropertyDescriptor(sink, 'length')?.value;
            if (!Number.isSafeInteger(length) || length >= TRANSIENT_OPEN_DIAGNOSTIC_LIMIT) return;
            Array.prototype.push.call(sink, { sequence: length + 1, event, stage,
                originWindowId: id(entry.originWindowId), windowId: id(entry.windowId),
                controllerTabId: id(entry.controllerTabId), tabId: id(entry.tabId),
                phase: ['opening', 'ready', 'uncertain', 'orphan'].includes(entry.phase) ? entry.phase : 'other', ...details });
        } catch { /* Frozen, missing or otherwise broken observation must not affect the operation. */ }
    };
    return {
        stage(value) { stage = value; emit('stage'); },
        rejected(cause, event = 'rejected') {
            try {
                const code = Object.getOwnPropertyDescriptor(cause || {}, 'code')?.value;
                emit(event, { error: { name: cause instanceof TypeError ? 'TypeError' : cause instanceof Error ? 'Error' : 'non-Error',
                    code: errorCodes.has(code) ? code : null, messageOmitted: true } });
            } catch { /* Even an unusual thrown value cannot affect quarantine. */ }
        },
        controller(tab, expectedMarker) {
            try {
                emit('controller-read', { controller: { id: id(tab?.id), windowId: id(tab?.windowId),
                    status: status(tab?.status), pinned: boolean(tab?.pinned), incognito: boolean(tab?.incognito),
                    splitViewId: Number.isInteger(tab?.splitViewId) ? tab.splitViewId : null,
                    url: urlState(tab?.url, expectedMarker), pendingUrl: urlState(tab?.pendingUrl, expectedMarker) } });
            } catch { /* Observation cannot reject an otherwise valid controller. */ }
        },
        fence(label, event, tabId, update) {
            try {
                emit('fence-invalidated', { fence: label, nativeEvent: event, nativeId: id(tabId),
                    changed: update && typeof update === 'object'
                        ? ['pinned', 'splitViewId', 'windowId', 'incognito', 'url', 'pendingUrl', 'status'].filter(key => key in update) : [],
                    status: status(update?.status) });
            } catch { /* The fence was already invalidated; this cannot clear it. */ }
        },
        complete() { emit('complete'); }
    };
}
