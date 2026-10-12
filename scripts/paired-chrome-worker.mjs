import assert from 'node:assert/strict';

// Worker targets can appear before extension bindings are ready. Poll only the
// read-only observation; never retry an exception or a mismatched identity.
export async function waitForExtensionWorkerIdentity(worker, id, record = async () => {}, {
    timeout = 20_000, interval = 100, now = Date.now,
    sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
} = {}) {
    const expectedUrl = `chrome-extension://${id}/background.js`;
    const deadline = now() + timeout;
    let last;
    do {
        last = await worker.evaluate(() => ({
            url: globalThis.location?.href ?? null,
            globalType: globalThis.constructor?.name ?? null,
            chromeType: typeof globalThis.chrome,
            hasRuntime: typeof globalThis.chrome?.runtime?.getManifest === 'function',
            id: globalThis.chrome?.runtime?.id ?? null,
            manifest: typeof globalThis.chrome?.runtime?.getManifest === 'function'
                ? globalThis.chrome.runtime.getManifest() : null
        }));
        await record(last);
        assert.equal(last.url, expectedUrl, 'Worker execution context must match its exact extension target.');
        if (last.id !== null) assert.equal(last.id, id, 'Worker runtime ID must match the installed extension.');
        if (last.hasRuntime) {
            assert.equal(last.id, id, 'Ready worker must expose its own runtime ID.');
            assert(last.manifest && typeof last.manifest === 'object', 'Ready worker must expose its real manifest.');
            return last;
        }
        if (now() >= deadline) break;
        await sleep(interval);
    } while (now() < deadline);
    throw new Error(`Timed out waiting for extension worker bindings; last observation: ${JSON.stringify(last)}`);
}

export function assertNoWorkerExceptions(events) {
    assert(Array.isArray(events), 'Worker exception evidence must be present.');
    assert.equal(events.length, 0, `Uncaught worker startup exception: ${JSON.stringify(events)}`);
}

export function findExactWorkerTarget(targets, url) {
    const matches = targets.filter(target => target.type === 'service_worker' && target.url === url);
    assert.equal(matches.length, 1, 'Exactly one raw Chrome worker target must match the extension.');
    assert(typeof matches[0].targetId === 'string' && matches[0].targetId, 'Worker target must expose its real target ID.');
    return matches[0];
}

export async function terminateObservedWorker({ worker, url, readTargets, releaseNetwork, record }, {
    timeout = 20_000, interval = 100, now = Date.now,
    sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
} = {}) {
    const before = findExactWorkerTarget(await readTargets(), url);
    await record({ phase: 'before-close', target: before });
    const networkSessionId = await releaseNetwork();
    await record({ phase: 'network-observer-released', networkSessionId });
    // Chrome's documented extension-testing API closes the target and detaches
    // Puppeteer's own worker debugger. Never substitute an extension reload.
    await worker.close();
    const deadline = now() + timeout;
    let last;
    do {
        last = await readTargets();
        if (!last.some(target => target.targetId === before.targetId)) {
            await record({ phase: 'old-target-gone', oldTargetId: before.targetId,
                matchingTargets: last.filter(target => target.type === 'service_worker' && target.url === url) });
            return before;
        }
        if (now() >= deadline) break;
        await sleep(interval);
    } while (now() < deadline);
    throw new Error(`Worker close did not destroy raw Chrome target ${before.targetId}; remaining targets: ${JSON.stringify(last)}`);
}
