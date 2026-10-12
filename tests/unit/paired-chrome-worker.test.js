import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForExtensionWorkerIdentity, assertNoWorkerExceptions, findExactWorkerTarget, terminateObservedWorker, reloadObservedExtension } from '../../scripts/paired-chrome-worker.mjs';
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

const oldTarget = { type: 'service_worker', url, targetId: 'old-worker' };
const newTarget = { type: 'service_worker', url, targetId: 'new-worker' };
function terminationHarness(targetLists = [[oldTarget], []]) {
    let index = 0, time = 0;
    const calls = [], records = [];
    return { calls, records,
        args: { url, worker: { close: async () => calls.push('close') },
            releaseNetwork: async () => calls.push('release-network'),
            readTargets: async () => { calls.push('raw-targets'); return targetLists[Math.min(index++, targetLists.length - 1)]; },
            record: async value => records.push(value) },
        options: { timeout: 200, interval: 100, now: () => time, sleep: async duration => { time += duration; } }
    };
}
test('worker termination releases the network observer, closes once and verifies raw target destruction', async () => {
    const h = terminationHarness([[oldTarget], [oldTarget], [newTarget]]);
    assert.deepEqual(await terminateObservedWorker(h.args, h.options), oldTarget);
    assert.deepEqual(h.calls, ['raw-targets', 'release-network', 'close', 'raw-targets', 'raw-targets']);
    assert.equal(h.records.at(-1).phase, 'old-target-gone');
    assert.deepEqual(h.records.at(-1).matchingTargets, [newTarget]);
});
test('a resolved close or absent Puppeteer wrapper cannot replace raw target destruction', async () => {
    const h = terminationHarness([[oldTarget]]);
    await assert.rejects(terminateObservedWorker(h.args, h.options), /did not destroy raw Chrome target old-worker/);
    assert.equal(h.calls.filter(call => call === 'close').length, 1);
    assert.equal(h.records.some(record => record.phase === 'old-target-gone'), false);
});
for (const stage of ['releaseNetwork', 'close']) {
    test(`failure during ${stage} stops the termination procedure without replay`, async () => {
        const h = terminationHarness();
        if (stage === 'close') h.args.worker.close = async () => { h.calls.push('failed-close'); throw new Error('blocked'); };
        else h.args.releaseNetwork = async () => { throw new Error('blocked'); };
        await assert.rejects(terminateObservedWorker(h.args, h.options), /blocked/);
        assert.equal(h.calls.filter(call => call === 'raw-targets').length, 1);
        assert.equal(h.records.length, stage === 'close' ? 2 : 1);
    });
}
test('raw worker selection rejects absent, ambiguous, wrong-type and missing-ID identities', () => {
    assert.deepEqual(findExactWorkerTarget([oldTarget], url), oldTarget);
    for (const targets of [[], [oldTarget, newTarget], [{ ...oldTarget, type: 'page' }], [{ ...oldTarget, targetId: '' }]]) {
        assert.throws(() => findExactWorkerTarget(targets, url));
    }
});

function reloadHarness({ detached = oldTarget, targets = [newTarget], invalidated = true, invalidatedBefore = false } = {}) {
    let reads = 0, time = 0, dispatched = false;
    const calls = [], records = [];
    return { calls, records,
        args: { url,
            readTargets: async () => { calls.push('raw-targets'); return ++reads === 1 ? [oldTarget] : reads === 2 ? [detached] : targets; },
            releaseObservers: async () => calls.push('release-observers'),
            reload: async () => { dispatched = true; calls.push('runtime.reload'); },
            viewInvalidated: async () => dispatched ? invalidated : invalidatedBefore,
            record: async value => records.push(value) },
        options: { timeout: 200, interval: 100, now: () => time, sleep: async duration => { time += duration; } }
    };
}
test('extension reload requires original view invalidation and old raw worker destruction after one reload', async () => {
    const h = reloadHarness();
    assert.deepEqual(await reloadObservedExtension(h.args, h.options), oldTarget);
    assert.deepEqual(h.calls, ['raw-targets', 'release-observers', 'raw-targets', 'runtime.reload', 'raw-targets']);
    assert.equal(h.records.at(-1).phase, 'reload-observed');
});
test('observer detachment or a pre-call natural restart cannot stand in for runtime.reload', async () => {
    const h = reloadHarness({ detached: newTarget });
    await assert.rejects(reloadObservedExtension(h.args, h.options), /detachment must not be counted/);
    assert.equal(h.calls.includes('runtime.reload'), false);
});
for (const options of [{ invalidated: false }, { targets: [oldTarget] }]) {
    test(`reload rejects incomplete lifecycle evidence ${JSON.stringify(options)}`, async () => {
        const h = reloadHarness(options);
        await assert.rejects(reloadObservedExtension(h.args, h.options), /did not invalidate/);
        assert.equal(h.calls.filter(call => call === 'runtime.reload').length, 1);
    });
}
test('reload dispatch errors are retained without replay or successful lifecycle claim', async () => {
    const h = reloadHarness(); h.args.reload = async () => { throw new Error('reload denied'); };
    await assert.rejects(reloadObservedExtension(h.args, h.options), /reload denied/);
    assert.equal(h.records.some(record => record.phase === 'reload-observed'), false);
});

test('view invalidation before reload dispatch cannot prove an extension reload', async () => {
    const h = reloadHarness({ invalidatedBefore: true });
    await assert.rejects(reloadObservedExtension(h.args, h.options), /realm must still be valid/);
    assert.equal(h.calls.includes('runtime.reload'), false);
});
