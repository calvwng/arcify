import assert from 'node:assert/strict';

// Worker targets can appear before extension bindings are ready. Poll only the
// read-only observation; never retry an exception or a mismatched identity.
export async function waitForExtensionWorkerIdentity(worker, id, record = async () => {}, {
    timeout = 20_000, evaluationTimeout = 30_000, interval = 100, now = Date.now,
    sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
} = {}) {
    const expectedUrl = `chrome-extension://${id}/background.js`;
    const deadline = now() + timeout;
    let last;
    do {
        // The supported driver also waits for Inspector.workerScriptLoaded.
        // Bound that wait even if Chrome never reports a finished script.
        let evaluationTimer;
        try {
            last = await Promise.race([worker.evaluate(() => ({
                url: globalThis.location?.href ?? null,
                globalType: globalThis.constructor?.name ?? null,
                chromeType: typeof globalThis.chrome,
                hasRuntime: typeof globalThis.chrome?.runtime?.getManifest === 'function',
                id: globalThis.chrome?.runtime?.id ?? null,
                manifest: typeof globalThis.chrome?.runtime?.getManifest === 'function'
                    ? globalThis.chrome.runtime.getManifest() : null
            })), new Promise((_, reject) => {
                evaluationTimer = setTimeout(() => reject(new Error(
                    `Worker identity evaluation exceeded ${evaluationTimeout}ms, including script-load readiness.`)), evaluationTimeout);
            })]);
        } finally { clearTimeout(evaluationTimer); }
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

export async function reloadObservedExtension({ url, readTargets, releaseObservers, reload, viewInvalidated, record }, {
    timeout = 20_000, interval = 100, now = Date.now,
    sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
} = {}) {
    const before = findExactWorkerTarget(await readTargets(), url);
    await record({ phase: 'before-reload', target: before });
    await releaseObservers();
    const unobserved = findExactWorkerTarget(await readTargets(), url);
    assert.equal(unobserved.targetId, before.targetId, 'Observer detachment must not be counted as the extension reload.');
    assert.equal(await viewInvalidated(), false, 'The original options realm must still be valid before invoking reload.');
    await record({ phase: 'observers-released', target: unobserved, originalViewValid: true });
    await reload();
    const deadline = now() + timeout;
    let last;
    do {
        last = { targets: await readTargets(), viewInvalidated: await viewInvalidated() };
        if (!last.targets.some(target => target.targetId === before.targetId) && last.viewInvalidated) {
            await record({ phase: 'reload-observed', oldTargetId: before.targetId, ...last });
            return before;
        }
        if (now() >= deadline) break;
        await sleep(interval);
    } while (now() < deadline);
    throw new Error(`Extension reload did not invalidate its original view and raw worker ${before.targetId}; last observation: ${JSON.stringify(last)}`);
}

// Observe existing debugger sessions without attaching another worker debugger.
export function observeTargetDiagnostics(session, source, record) {
    const events = ['Target.targetCreated', 'Target.targetInfoChanged', 'Target.targetDestroyed',
        'Target.targetCrashed', 'Inspector.targetCrashed', 'Inspector.detached', 'Inspector.workerScriptLoaded'];
    const listeners = events.map(event => {
        const listener = details => record({ source, event, details, observedAt: new Date().toISOString() });
        session.on(event, listener);
        return [event, listener];
    });
    return () => { for (const [event, listener] of listeners) session.off(event, listener); };
}

export function assertNoTargetCrashes(events) {
    assert(Array.isArray(events), 'Target lifecycle evidence must be present.');
    const crashes = events.filter(({ event }) => ['Target.targetCrashed', 'Inspector.targetCrashed'].includes(event));
    assert.equal(crashes.length, 0, `Chrome target crash: ${JSON.stringify(crashes)}`);
}
