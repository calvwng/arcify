import assert from 'node:assert/strict';
import { TRANSIENT_OPEN_DIAGNOSTIC_KEY, TRANSIENT_OPEN_DIAGNOSTIC_LIMIT } from '../transient-window-diagnostics.js';

// Serialized into the existing real worker, never replacing a Chrome API,
// handler, guard, response or promise. This fixture installs no callbacks.
export function installLittleArcOpenDiagnosticSink({ key }) {
    const symbol = Symbol.for(key);
    if (Object.getOwnPropertyDescriptor(globalThis, symbol)) throw new Error('Little Arc diagnostic sink already exists.');
    Object.defineProperty(globalThis, symbol, { value: [], configurable: true });
}
export function readLittleArcOpenDiagnosticSink({ key }) {
    const sink = Object.getOwnPropertyDescriptor(globalThis, Symbol.for(key))?.value;
    if (!Array.isArray(sink)) throw new Error('Little Arc diagnostic sink is unavailable.');
    return sink;
}
export function removeLittleArcOpenDiagnosticSink({ key }) {
    delete globalThis[Symbol.for(key)];
}

/** Resolve exact worker identity before installing a bounded passive sink. */
export async function observeLittleArcOpenDiagnostics({ browser, arcifyId }) {
    const workerUrl = `chrome-extension://${arcifyId}/background.js`;
    const targets = browser.targets().filter(target => target.type() === 'service_worker' && target.url() === workerUrl);
    assert.equal(targets.length, 1, 'Diagnostics require the single exact live Arcify worker.');
    const worker = await targets[0].worker();
    assert(worker, 'The exact Arcify worker must be readable before the launch.');
    const options = { key: TRANSIENT_OPEN_DIAGNOSTIC_KEY };
    await worker.evaluate(installLittleArcOpenDiagnosticSink, options);
    return {
        read: async () => ({ workerUrl, limit: TRANSIENT_OPEN_DIAGNOSTIC_LIMIT,
            observation: 'Bounded synchronous stage and native-event breadcrumbs. No extra native reads, dispatches, retries, waits or changed guard decisions; instrumentation may still affect timing.',
            errors: 'Original error names and recognized codes only; arbitrary messages, stacks, URLs and controller tokens are intentionally omitted.',
            events: await worker.evaluate(readLittleArcOpenDiagnosticSink, options) }),
        stop: () => worker.evaluate(removeLittleArcOpenDiagnosticSink, options)
    };
}

/** Optional evidence must never suppress, retry or replace the real outcome. */
export async function withLittleArcOpenDiagnostics({ browser, arcifyId, record }, operation) {
    let observer;
    const observation = {};
    try { observer = await observeLittleArcOpenDiagnostics({ browser, arcifyId }); }
    catch { observation.installError = 'diagnostic-install-failed-message-omitted'; }
    try { return await operation(); }
    finally {
        if (observer) {
            try { Object.assign(observation, await observer.read()); }
            catch { observation.captureError = 'diagnostic-read-failed-message-omitted'; }
            try { await observer.stop(); }
            catch { observation.stopError = 'diagnostic-stop-failed-message-omitted'; }
        }
        try { await record(observation); }
        catch { /* Evidence persistence cannot replace the trusted operation's outcome. */ }
    }
}
