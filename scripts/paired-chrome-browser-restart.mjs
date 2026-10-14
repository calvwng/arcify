/** Test-only lifecycle guard. Importing this module never launches a browser. */
import assert from 'node:assert/strict';
import { isAbsolute } from 'node:path';
import { CHROME_EXECUTABLE, validateChromeLaunchArguments } from './paired-chrome-sandbox.mjs';

// Signal 0 only observes process existence. Never terminate Chrome to make a
// failed graceful shutdown or denied relaunch appear successful.
function processAlive(pid) {
    try { process.kill(pid, 0); return true; }
    catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
function freeze(value) {
    if (value && typeof value === 'object') {
        Object.values(value).forEach(freeze);
        Object.freeze(value);
    }
    return value;
}

/** Capture before any driver call. Puppeteer may add a non-cloneable logger or
 * consume args; pass a fresh structuredClone(snapshot) at each driver boundary.
 * Never sanitize an already contaminated configuration by dropping fields. */
export function snapshotChromeLaunchOptions(options) {
    assert(options && typeof options === 'object' && !Array.isArray(options), 'Original launch options are required.');
    return freeze(structuredClone(options));
}
function liveProcess(browser, isProcessAlive) {
    const child = browser.process();
    assert(child && Number.isSafeInteger(child.pid) && child.pid > 0, 'A real browser child process PID is required.');
    assert.equal(child.exitCode, null, 'Browser process must not have exited.');
    assert.equal(child.signalCode, null, 'Browser process must not have received a terminating signal.');
    assert.equal(isProcessAlive(child.pid), true, 'Browser process PID must still be live.');
    return child;
}
function processEvidence(child, userDataDir) {
    assert.equal(child.spawnfile, CHROME_EXECUTABLE, 'Restart must retain the fixed installed Chrome executable.');
    validateChromeLaunchArguments(child.spawnargs);
    assert.deepEqual(child.spawnargs.filter(arg => /^--?user-data-dir(?:=|$)/.test(arg.trim())),
        [`--user-data-dir=${userDataDir}`], 'Chrome must use exactly the original disposable profile.');
    return { pid: child.pid, executable: child.spawnfile, arguments: [...child.spawnargs] };
}
async function closeAndObserveExit(browser, child, isProcessAlive, timeout, observeExit) {
    let onExit, onError, timer;
    const exited = new Promise((resolve, reject) => {
        onExit = (code, signal) => {
            const observation = { pid: child.pid, exitCode: code, signalCode: signal };
            observeExit(observation);
            resolve(observation);
        };
        onError = reject;
        child.once('exit', onExit);
        child.once('error', onError);
    });
    try {
        const closing = Promise.resolve().then(() => {
            assert.equal(liveProcess(browser, isProcessAlive), child, 'Original browser process changed before close.');
            return browser.close();
        });
        const [, exit] = await Promise.race([
            Promise.all([closing, exited]),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(`Graceful browser close and process exit exceeded ${timeout}ms; no relaunch attempted.`)), timeout);
            })
        ]);
        assert.equal(exit.exitCode, 0, 'Graceful browser shutdown must exit successfully.');
        assert.equal(exit.signalCode, null, 'A killed browser is not a graceful browser restart.');
        assert.equal(child.exitCode, 0, 'The original child must confirm its clean exit.');
        assert.equal(child.signalCode, null, 'The original child must confirm an unsignaled exit.');
        assert.equal(isProcessAlive(child.pid), false, 'Original browser PID is still live; do not relaunch.');
        return exit;
    } finally {
        clearTimeout(timer);
        child.off('exit', onExit);
        child.off('error', onError);
    }
}

/**
 * The CI fixture supplies its ORIGINAL launch options and one launch callback.
 * No profile edits, extension reinstall, fallback flags, or launch retries occur.
 * revalidate must recheck the installed/runtime process, real sandbox diagnostics,
 * and the same enabled extension registry, then return all three flags as true.
 * Retain the newly launched browser in the caller too, for ordinary final cleanup
 * if revalidation fails. Errors retain the original cause and restart evidence.
 * The launch callback receives an immutable baseline; it must give Puppeteer a
 * fresh structuredClone of that baseline so driver mutations stay disposable.
 * The timeout bounds close/exit only; the original launch timeout is unchanged.
 */
export async function restartObservedBrowser({ browser, launchOptions, launch, revalidate, record }, {
    timeout = 30_000, isProcessAlive = processAlive
} = {}) {
    const evidence = { status: 'running', phase: 'preflight', observations: [] };
    let restarted;
    const checkpoint = async (phase, detail = {}) => {
        evidence.phase = phase;
        const observation = { phase, observedAt: new Date().toISOString(), ...detail };
        evidence.observations.push(observation);
        await record(observation);
    };
    try {
        for (const [name, callback] of Object.entries({ launch, revalidate, record, isProcessAlive })) {
            assert.equal(typeof callback, 'function', `${name} callback is required for browser restart.`);
        }
        assert(Number.isFinite(timeout) && timeout > 0, 'Browser close timeout must be positive.');
        const options = snapshotChromeLaunchOptions(launchOptions);
        assert.equal(options.channel, 'chrome', 'Restart must retain the installed stable Chrome channel.');
        assert.equal(options.headless, false, 'Restart must retain headed Chrome.');
        assert.equal(options.pipe, true, 'Restart must retain the original pipe transport.');
        assert.equal(options.enableExtensions, true, 'Restart must retain extension debugging support.');
        assert(typeof options.userDataDir === 'string' && isAbsolute(options.userDataDir), 'Original disposable profile path is required.');
        validateChromeLaunchArguments(options.args || []);
        const original = liveProcess(browser, isProcessAlive);
        evidence.original = processEvidence(original, options.userDataDir);
        evidence.userDataDir = options.userDataDir;
        await checkpoint('before-close', { original: evidence.original });
        evidence.phase = 'closing';
        await closeAndObserveExit(browser, original, isProcessAlive, timeout, exit => { evidence.originalExit = exit; });
        await checkpoint('original-exited', evidence.originalExit);
        // No awaited work may separate this final old-PID check from launch.
        await checkpoint('before-launch');
        assert.equal(isProcessAlive(original.pid), false, 'Original browser PID must be absent before launch.');
        evidence.phase = 'launching';
        restarted = await launch(options);
        assert.notEqual(restarted, browser, 'Restart must create a new browser connection.');
        const next = liveProcess(restarted, isProcessAlive);
        assert.notEqual(next, original, 'Restart must create a new child process.');
        assert.notEqual(next.pid, original.pid, 'Restart must expose a distinct live process PID.');
        evidence.restarted = processEvidence(next, options.userDataDir);
        assert.deepEqual(evidence.restarted.arguments, evidence.original.arguments, 'Actual Chrome launch arguments must remain unchanged on restart.');
        await checkpoint('new-process', { restarted: evidence.restarted });
        evidence.phase = 'revalidating';
        evidence.validation = await revalidate(restarted, { original: evidence.original, restarted: evidence.restarted,
            originalExit: evidence.originalExit, launchOptions: options });
        for (const name of ['runtime', 'sandbox', 'registry']) {
            assert.equal(evidence.validation?.[name], true, `Restart requires successful ${name} revalidation.`);
        }
        assert.equal(liveProcess(restarted, isProcessAlive), next, 'Restarted browser process changed during revalidation.');
        evidence.status = 'passed';
        await checkpoint('revalidated', { validation: evidence.validation });
        return { browser: restarted, evidence };
    } catch (error) {
        evidence.status = 'failed';
        const failedPhase = evidence.phase;
        try { await checkpoint('failed', { failedPhase, error: { name: error.name, message: error.message, stack: error.stack } }); }
        catch (recordError) { evidence.recordError = { message: recordError.message, stack: recordError.stack }; }
        error.browserRestartEvidence = evidence;
        if (restarted) error.restartedBrowser = restarted;
        throw error;
    }
}
