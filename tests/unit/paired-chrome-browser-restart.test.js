// Fake browser/child-process interfaces only. These tests never launch Chrome.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { restartObservedBrowser } from '../../scripts/paired-chrome-browser-restart.mjs';
import { CHROME_EXECUTABLE } from '../../scripts/paired-chrome-sandbox.mjs';

function harness() {
    const calls = [], records = [], alive = new Set([101, 202]);
    const launchOptions = { channel: 'chrome', headless: false, pipe: true, enableExtensions: true, dumpio: true,
        userDataDir: '/tmp/paired-chrome-fake', timeout: 60_000, protocolTimeout: 30_000,
        defaultViewport: { width: 1280, height: 900 } };
    const child = pid => Object.assign(new EventEmitter(), { pid, exitCode: null, signalCode: null,
        spawnfile: CHROME_EXECUTABLE,
        spawnargs: [CHROME_EXECUTABLE, '--remote-debugging-pipe', `--user-data-dir=${launchOptions.userDataDir}`] });
    const original = child(101), next = child(202);
    const exit = (process = original, code = 0, signal = null) => {
        calls.push(`exit:${process.pid}`);
        process.exitCode = code; process.signalCode = signal; alive.delete(process.pid);
        process.emit('exit', code, signal);
    };
    const browser = { process: () => original, close: async () => { calls.push('close'); exit(); } };
    const restarted = { process: () => next };
    const args = { browser, launchOptions,
        launch: async options => { calls.push('launch'); assert.deepEqual(options, launchOptions); assert.equal(alive.has(101), false); return restarted; },
        revalidate: async (actual, context) => {
            calls.push('revalidate'); assert.equal(actual, restarted);
            assert.equal(context.original.pid, 101); assert.equal(context.restarted.pid, 202);
            assert.deepEqual(context.originalExit, { pid: 101, exitCode: 0, signalCode: null });
            return { runtime: true, sandbox: true, registry: true };
        },
        record: async value => records.push(value)
    };
    return { args, original, next, restarted, calls, records, alive, exit,
        options: { timeout: 100, isProcessAlive: pid => alive.has(pid) } };
}
const execute = h => restartObservedBrowser(h.args, h.options);
const unlaunched = h => { assert.equal(h.calls.includes('launch'), false); assert.equal(h.calls.includes('revalidate'), false); };
const cleanListeners = h => { assert.equal(h.original.listenerCount('exit'), 0); assert.equal(h.original.listenerCount('error'), 0); };

test('clean exit precedes exactly one same-profile launch and all mandatory revalidation', async () => {
    const h = harness(), result = await execute(h);
    assert.equal(result.browser, h.restarted); assert.equal(result.evidence.status, 'passed');
    assert.deepEqual(h.calls, ['close', 'exit:101', 'launch', 'revalidate']);
    assert.deepEqual(h.records.map(item => item.phase), ['before-close', 'original-exited', 'before-launch', 'new-process', 'revalidated']);
    assert.equal(result.evidence.userDataDir, h.args.launchOptions.userDataDir);
    assert.deepEqual(result.evidence.original.arguments, result.evidence.restarted.arguments);
    cleanListeners(h);
});

test('resolved browser.close does not substitute for an original process exit', async () => {
    const h = harness(); h.options.timeout = 10;
    h.args.browser.close = async () => h.calls.push('close');
    await assert.rejects(execute(h), /Graceful browser close and process exit exceeded/);
    assert.deepEqual(h.calls, ['close']); unlaunched(h); cleanListeners(h);
    assert.equal(h.records.at(-1).failedPhase, 'closing');
});

test('process exit does not substitute for a close operation that never resolves', async () => {
    const h = harness(); h.options.timeout = 10;
    h.args.browser.close = () => { h.calls.push('close'); h.exit(); return new Promise(() => {}); };
    await assert.rejects(execute(h), /Graceful browser close and process exit exceeded/);
    unlaunched(h); cleanListeners(h);
});

test('launch waits for exit when close resolves first', async () => {
    const h = harness();
    h.args.browser.close = async () => { h.calls.push('close'); setImmediate(() => h.exit()); };
    await execute(h);
    assert.deepEqual(h.calls, ['close', 'exit:101', 'launch', 'revalidate']); cleanListeners(h);
});

for (const [code, signal] of [[1, null], [null, 'SIGKILL'], [0, 'SIGTERM']]) {
    test(`abnormal exit ${code}/${signal} never relaunches or retries`, async () => {
        const h = harness(); h.args.browser.close = async () => { h.calls.push('close'); h.exit(h.original, code, signal); };
        await assert.rejects(execute(h), error => {
            assert.deepEqual(error.browserRestartEvidence.originalExit, { pid: 101, exitCode: code, signalCode: signal });
            return true;
        });
        unlaunched(h); cleanListeners(h);
        assert.equal(h.calls.filter(call => call === 'close').length, 1);
    });
}

for (const reason of ['already-exited', 'missing-pid', 'not-live', 'remote-connection']) {
    test(`invalid original process (${reason}) fails before closing`, async () => {
        const h = harness();
        if (reason === 'already-exited') h.original.exitCode = 0;
        if (reason === 'missing-pid') h.original.pid = undefined;
        if (reason === 'not-live') h.alive.delete(101);
        if (reason === 'remote-connection') h.args.browser.process = () => null;
        await assert.rejects(execute(h)); assert.deepEqual(h.calls, []); unlaunched(h);
    });
}

test('a process that exits before close dispatch is not counted as a graceful restart', async () => {
    const h = harness(); h.args.record = async record => { h.records.push(record); if (record.phase === 'before-close') h.exit(); };
    await assert.rejects(execute(h), /must not have exited/);
    assert.equal(h.calls.includes('close'), false); unlaunched(h); cleanListeners(h);
});

test('an exit event with a still-live original PID cannot permit relaunch', async () => {
    const h = harness(); h.args.browser.close = async () => { h.exit(); h.alive.add(101); };
    await assert.rejects(execute(h), /Original browser PID is still live/); unlaunched(h); cleanListeners(h);
});

test('the old PID is checked again after recording diagnostics and before launch', async () => {
    const h = harness(); h.args.record = async record => {
        h.records.push(record); if (record.phase === 'before-launch') h.alive.add(101);
    };
    await assert.rejects(execute(h), /Original browser PID must be absent before launch/); unlaunched(h);
});

test('a process observation error fails closed without substituting browser connection state', async () => {
    const h = harness(), denied = Object.assign(new Error('process observation denied'), { code: 'EPERM' });
    h.options.isProcessAlive = () => { throw denied; };
    await assert.rejects(execute(h), error => error === denied); assert.deepEqual(h.calls, []);
});

for (const operation of ['close', 'child-error', 'launch', 'revalidate']) {
    test(`${operation} failure retains the same error and diagnostics without replay`, async () => {
        const h = harness(), failure = new Error(`${operation} denied`);
        failure.runtimeEvidence = { detail: 'original diagnostic' };
        if (operation === 'close') h.args.browser.close = async () => { h.calls.push('close'); throw failure; };
        if (operation === 'child-error') h.args.browser.close = async () => h.original.emit('error', failure);
        if (operation === 'launch') h.args.launch = async () => { h.calls.push('launch'); throw failure; };
        if (operation === 'revalidate') h.args.revalidate = async () => { h.calls.push('revalidate'); throw failure; };
        await assert.rejects(execute(h), error => {
            assert.equal(error, failure); assert.equal(error.runtimeEvidence.detail, 'original diagnostic');
            assert.equal(error.browserRestartEvidence.status, 'failed');
            if (operation === 'revalidate') assert.equal(error.restartedBrowser, h.restarted);
            return true;
        });
        for (const call of ['close', 'launch', 'revalidate']) assert(h.calls.filter(value => value === call).length <= 1);
        assert.equal(h.records.some(record => record.phase === 'revalidated'), false); cleanListeners(h);
    });
}

for (const missing of ['launch', 'revalidate', 'record']) {
    test(`missing ${missing} callback fails before any close or launch`, async () => {
        const h = harness(); delete h.args[missing];
        await assert.rejects(execute(h), new RegExp(`${missing} callback is required`)); assert.deepEqual(h.calls, []);
    });
}

for (const validation of [undefined, {}, { runtime: true }, { runtime: true, sandbox: true }, { runtime: true, sandbox: false, registry: true }]) {
    test(`incomplete revalidation ${JSON.stringify(validation)} cannot report success`, async () => {
        const h = harness(); h.args.revalidate = async () => validation;
        await assert.rejects(execute(h), /requires successful .* revalidation/);
        assert.equal(h.records.at(-1).failedPhase, 'revalidating');
        assert.equal(h.records.some(record => record.phase === 'revalidated'), false);
    });
}

test('a new browser that dies during mandatory revalidation cannot pass', async () => {
    const h = harness(); h.args.revalidate = async () => { h.exit(h.next); return { runtime: true, sandbox: true, registry: true }; };
    await assert.rejects(execute(h), /must not have exited/);
});

for (const reason of ['same-browser', 'same-process', 'same-pid', 'exited', 'not-live', 'wrong-executable', 'wrong-profile', 'different-args', 'unsafe-args']) {
    test(`invalid relaunched browser (${reason}) fails before revalidation`, async () => {
        const h = harness();
        if (reason === 'same-browser') h.args.launch = async () => h.args.browser;
        if (reason === 'same-process') h.args.launch = async () => {
            h.original.exitCode = null; h.alive.add(101); return { process: () => h.original };
        };
        if (reason === 'same-pid') h.args.launch = async () => { h.next.pid = 101; h.alive.add(101); return h.restarted; };
        if (reason === 'exited') h.next.exitCode = 0;
        if (reason === 'not-live') h.alive.delete(202);
        if (reason === 'wrong-executable') h.next.spawnfile = '/tmp/different-chrome';
        if (reason === 'wrong-profile') h.next.spawnargs[2] = '--user-data-dir=/tmp/other-profile';
        if (reason === 'different-args') h.next.spawnargs.push('--some-new-option');
        if (reason === 'unsafe-args') h.next.spawnargs.push('--no-sandbox');
        await assert.rejects(execute(h)); assert.equal(h.calls.includes('revalidate'), false);
    });
}

for (const reason of ['relative-profile', 'profile-mismatch', 'duplicate-profile', 'unsafe-original', 'unsafe-options', 'wrong-channel']) {
    test(`invalid original configuration (${reason}) cannot close or restart`, async () => {
        const h = harness();
        if (reason === 'relative-profile') h.args.launchOptions.userDataDir = 'relative/profile';
        if (reason === 'profile-mismatch') h.args.launchOptions.userDataDir = '/tmp/other-profile';
        if (reason === 'duplicate-profile') h.original.spawnargs.push('--user-data-dir=/tmp/extra-profile');
        if (reason === 'unsafe-original') h.original.spawnargs.push('--disable-web-security');
        if (reason === 'unsafe-options') h.args.launchOptions.args = ['--no-sandbox'];
        if (reason === 'wrong-channel') h.args.launchOptions.channel = 'chrome-canary';
        await assert.rejects(execute(h)); assert.deepEqual(h.calls, []);
    });
}

test('launch receives a recursively frozen copy with the original options and cannot change its profile', async () => {
    const h = harness(), baseline = structuredClone(h.args.launchOptions);
    h.args.launch = async options => {
        assert.notEqual(options, h.args.launchOptions); assert.deepEqual(options, baseline);
        assert(Object.isFrozen(options)); assert(Object.isFrozen(options.defaultViewport));
        assert.throws(() => { options.userDataDir = '/tmp/other'; }, TypeError);
        assert.throws(() => { options.defaultViewport.width = 1; }, TypeError);
        return h.restarted;
    };
    await execute(h); assert.deepEqual(h.args.launchOptions, baseline);
});

test('diagnostic recording failure cannot replace the original startup error', async () => {
    const h = harness(), denied = new Error('Chrome startup denied');
    h.args.launch = async () => { throw denied; };
    h.args.record = async record => { if (record.phase === 'failed') throw new Error('report write failed'); };
    await assert.rejects(execute(h), error => {
        assert.equal(error, denied); assert.equal(error.browserRestartEvidence.recordError.message, 'report write failed');
        assert.equal(error.browserRestartEvidence.observations.at(-1).error.message, 'Chrome startup denied');
        return true;
    });
});
