import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForExtensionWorkerIdentity, assertNoWorkerExceptions } from '../../scripts/paired-chrome-worker.mjs';
const id = 'a'.repeat(32), url = `chrome-extension://${id}/background.js`;
const ready = { url, hasRuntime: true, id, manifest: { name: 'Fixture', version: '1.0.0' } };
const starting = { url, hasRuntime: false, id: null, manifest: null };
function harness(observations) {
    let time = 0, calls = 0;
    const records = [];
    return {
        worker: { async evaluate() { const value = observations[Math.min(calls++, observations.length - 1)]; if (value instanceof Error) throw value; return value; } },
        options: { timeout: 200, interval: 100, now: () => time, sleep: async duration => { time += duration; } },
        record: async value => records.push(value), records, calls: () => calls
    };
}
test('read-only worker readiness retains the exact location and runtime ID assertion', async () => {
    const h = harness([starting, ready]);
    assert.deepEqual(await waitForExtensionWorkerIdentity(h.worker, id, h.record, h.options), ready);
    assert.deepEqual(h.records, [starting, ready]);
});
for (const [label, observation] of [
    ['wrong context URL', { ...starting, url: 'about:blank' }],
    ['wrong runtime ID', { ...ready, id: 'b'.repeat(32) }],
    ['ready without ID', { ...ready, id: null }],
    ['ready without manifest', { ...ready, manifest: null }],
    ['evaluation exception', new Error('detached context')]
]) {
    test(`${label} fails immediately without retry or fallback`, async () => {
        const h = harness([observation, ready]);
        await assert.rejects(waitForExtensionWorkerIdentity(h.worker, id, h.record, h.options));
        assert.equal(h.calls(), 1);
    });
}
test('missing bindings time out with the last observation instead of passing or skipping', async () => {
    const h = harness([starting]);
    await assert.rejects(waitForExtensionWorkerIdentity(h.worker, id, h.record, h.options), /Timed out waiting.*"hasRuntime":false/);
    assert.equal(h.calls(), 2);
});
test('real probe safely observes missing chrome and then reads real runtime metadata', async () => {
    const oldLocation = globalThis.location, oldChrome = globalThis.chrome;
    try {
        globalThis.location = { href: url }; delete globalThis.chrome;
        const h = harness([]); let calls = 0;
        h.worker.evaluate = async probe => {
            const value = probe();
            if (++calls === 1) globalThis.chrome = { runtime: { id, getManifest: () => ready.manifest } };
            return value;
        };
        assert.deepEqual(await waitForExtensionWorkerIdentity(h.worker, id, h.record, h.options), { ...ready, globalType: 'Object', chromeType: 'object' });
        assert.deepEqual(h.records[0], { ...starting, globalType: 'Object', chromeType: 'undefined' });
    } finally {
        if (oldLocation === undefined) delete globalThis.location; else globalThis.location = oldLocation;
        if (oldChrome === undefined) delete globalThis.chrome; else globalThis.chrome = oldChrome;
    }
});

test('observed uncaught worker exceptions cannot be converted into a ready pass', () => {
    assert.doesNotThrow(() => assertNoWorkerExceptions([]));
    assert.throws(() => assertNoWorkerExceptions([{ text: 'Uncaught', exception: { description: 'startup error' } }]), /startup error/);
    assert.throws(() => assertNoWorkerExceptions(undefined), /evidence must be present/);
});
