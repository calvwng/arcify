/** CI-only native accelerator transport. No browser/tab APIs or retry fallback. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const HELPER = fileURLToPath(new URL('./paired-chrome-native-close.py', import.meta.url));
const probes = new WeakMap();

export function nativeDisplayNumber(display) {
    assert.equal(typeof display, 'string', 'An explicit DISPLAY is required');
    assert.match(display, /^:[0-9]+(?:\.0)?$/, 'Only a local Xvfb display with screen 0 is supported');
    return Number(display.slice(1).split('.')[0]);
}

/** Reads the existing X lock only; the helper independently verifies PID/exe/UID. */
export async function readExpectedXvfbPid(display, { read = readFile } = {}) {
    const value = (await read(`/tmp/.X${nativeDisplayNumber(display)}-lock`, 'ascii')).trim();
    assert.match(value, /^[0-9]+$/, 'X lock must contain one PID');
    const pid = Number(value);
    assert(Number.isSafeInteger(pid) && pid > 1, 'Invalid Xvfb PID');
    return pid;
}

function validateExpected({ display, xvfbPid, chromePid, windowTitle = null, nonce }) {
    nativeDisplayNumber(display);
    for (const pid of [xvfbPid, chromePid]) assert(Number.isSafeInteger(pid) && pid > 1, 'Expected process PIDs are required');
    assert.notEqual(xvfbPid, chromePid, 'Xvfb and Chrome are distinct processes');
    assert.equal(typeof nonce, 'string');
    assert.match(nonce, /^[a-f0-9]{32}$/, 'A fresh 32-hex fixture title nonce is required');
    if (windowTitle !== null) {
        assert.equal(typeof windowTitle, 'string');
        assert(windowTitle.length <= 512 && windowTitle.split(nonce).length === 2 && !/[\x00-\x1f]/.test(windowTitle), 'Expected exact title must contain the nonce once');
    }
    return { display, xvfbPid, chromePid, windowTitle, nonce };
}

function runHelper(request) {
    return new Promise((resolve, reject) => {
        execFile('python3', [HELPER, '--request-json', JSON.stringify(request)], {
            encoding: 'utf8', timeout: 15_000, killSignal: 'SIGTERM', maxBuffer: 256 * 1024,
        }, (error, stdout, stderr) => {
            if (error) {
                error.stdout = stdout; error.stderr = stderr;
                reject(error);
            } else resolve({ stdout, stderr });
        });
    });
}

async function invoke(request, run) {
    let output;
    try { output = await run(request); }
    catch (cause) {
        const error = new Error(`Native close ${request.mode} failed; no input retry is permitted: ${cause.message}`, { cause });
        try { error.nativeCloseEvidence = JSON.parse(cause.stdout); } catch { /* Preserve unknown outcome below. */ }
        error.nativeCloseUncertain = request.mode === 'send';
        error.stderr = cause.stderr || '';
        throw error;
    }
    let evidence;
    try { evidence = JSON.parse(output.stdout); }
    catch (cause) {
        const error = new Error('Native close helper returned invalid evidence; do not retry input', { cause });
        error.nativeCloseUncertain = request.mode === 'send'; throw error;
    }
    try {
        assert.equal(evidence.schemaVersion, 1);
        assert.equal(evidence.status, 'ok', evidence.error?.message || 'Native close helper rejected the request');
        assert.equal(evidence.mode, request.mode);
        assert.equal(evidence.route, 'X11 XTEST native Control_L+w');
        assert.equal(evidence.physicalKeyboard, false);
        assert.equal(evidence.browserClosureVerified, false, 'The input helper cannot prove Chrome tab closure');
        const expected = validateExpected(evidence.expected);
        assert.notEqual(expected.windowTitle, null, 'Probe must return the exact observed nonce title');
        assert.deepEqual({ ...expected, windowTitle: request.expected.windowTitle }, request.expected);
        if (request.expected.windowTitle !== null) assert.equal(expected.windowTitle, request.expected.windowTitle);
        assert.equal(evidence.target.windowTitle, expected.windowTitle);
        for (const name of ['focusWindow', 'window', 'rootWindow']) assert(Number.isSafeInteger(evidence.target[name]) && evidence.target[name] > 1);
        assert.equal(evidence.host.display, expected.display);
        assert.equal(evidence.host.chrome.pid, expected.chromePid);
        assert.equal(evidence.host.xvfb.pid, expected.xvfbPid);
        assert.equal(evidence.keyboardBefore.pressedKeycodes.length, 0);
        assert(Object.values(evidence.keyboardBefore.xkb).every(value => value === 0));
        if (request.mode === 'probe') {
            assert.equal(evidence.chordAttempted, false); assert.equal(evidence.chordCompleted, false);
            assert.deepEqual(evidence.events, []); assert.deepEqual(evidence.cleanup, []);
        } else {
            assert.equal(evidence.chordAttempted, true); assert.equal(evidence.chordCompleted, true);
            assert.deepEqual(evidence.target, request.baseline.target);
            assert.deepEqual(evidence.host, request.baseline.host);
            assert.deepEqual(evidence.keycodes, request.baseline.keycodes);
            assert.deepEqual(evidence.events.map(({ key, pressed }) => [key, pressed]),
                [['Control_L', true], ['w', true], ['w', false], ['Control_L', false]]);
            assert(evidence.events.every(event => event.result !== 0 && Number.isInteger(event.result)
                && event.delayMs === 0 && event.keycode === evidence.keycodes[event.key]));
            assert.deepEqual(evidence.cleanup, []);
            assert.deepEqual(evidence.sendSync.xErrors, []);
            assert.deepEqual(evidence.keyboardAfter.pressedKeycodes, []);
            assert(Object.values(evidence.keyboardAfter.xkb).every(value => value === 0));
        }
        assert(!output.stderr, `Unexpected helper stderr: ${output.stderr}`);
    } catch (cause) {
        const error = new Error(`Native close ${request.mode} evidence failed validation; do not retry input: ${cause.message}`, { cause });
        error.nativeCloseEvidence = evidence;
        error.nativeCloseUncertain = request.mode === 'send'; throw error;
    }
    return evidence;
}

/** Returns an opaque one-use probe plus reviewable JSON evidence. No input sent. */
export async function probeNativeCloseTarget(target, { run = runHelper } = {}) {
    const expected = validateExpected(target);
    const evidence = await invoke({ mode: 'probe', expected }, run);
    // Internal copies prevent callers from changing the target between probe/send.
    const token = Object.freeze({ evidence: structuredClone(evidence) });
    probes.set(token, { baseline: structuredClone(evidence), run, consumed: false });
    return token;
}

/** Call only AFTER exact tab/Favorite/target identities and removal observers are armed. */
export async function sendOneNativeClose(probe) {
    const state = probes.get(probe);
    assert(state, 'A probe issued by probeNativeCloseTarget is required');
    assert.equal(state.consumed, false, 'This native-close probe has already been consumed; never repeat an uncertain chord');
    state.consumed = true; // Before starting the process: a timeout is not retry permission.
    return invoke({ mode: 'send', expected: state.baseline.expected, baseline: state.baseline }, state.run);
}
