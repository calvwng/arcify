import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { nativeDisplayNumber, readExpectedXvfbPid, probeNativeCloseTarget, sendOneNativeClose } from '../../scripts/paired-chrome-native-close.mjs';

const nonce = 'a'.repeat(32);
const target = { display: ':99', xvfbPid: 123, chromePid: 456, nonce };
const expected = { ...target, windowTitle: `Fixture ${nonce} - Observed title` };
function evidence(mode = 'probe') {
    const keycodes = { minimum: 8, maximum: 255, Control_L: 37, w: 25 };
    return { schemaVersion: 1, status: 'ok', mode, route: 'X11 XTEST native Control_L+w',
        physicalKeyboard: false, browserClosureVerified: false,
        expected, host: { display: ':99', chrome: { pid: 456 }, xvfb: { pid: 123 } },
        target: { focusWindow: 50, window: 30, rootWindow: 10, windowTitle: expected.windowTitle },
        keycodes, keyboardBefore: { pressedKeycodes: [], xkb: { mods: 0 } },
        keyboardAfter: { pressedKeycodes: [], xkb: { mods: 0 } },
        chordAttempted: mode === 'send', chordCompleted: mode === 'send',
        cleanup: [], sendSync: { xErrors: [] }, events: mode === 'probe' ? [] :
            [['Control_L', true], ['w', true], ['w', false], ['Control_L', false]]
                .map(([key, pressed]) => ({ key, keycode: keycodes[key], pressed, delayMs: 0, result: 1 })),
    };
}
function harness(transform = value => value) {
    const requests = [];
    return { requests, options: { run: async request => {
        requests.push(structuredClone(request));
        return { stdout: JSON.stringify(transform(evidence(request.mode), request)), stderr: '' };
    } } };
}

test('Python fake-library and failure-cleanup tests are part of npm test:unit, without loading X', () => {
    const path = fileURLToPath(new URL('./paired_chrome_native_close_test.py', import.meta.url));
    const output = execFileSync('python3', [path], {
        encoding: 'utf8', timeout: 20_000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, stdio: 'pipe',
    });
    assert.equal(output, '');
});

test('display parser rejects remote hosts, shell syntax, other screens and missing display', () => {
    assert.equal(nativeDisplayNumber(':99'), 99);
    assert.equal(nativeDisplayNumber(':99.0'), 99);
    for (const value of ['', undefined, 'localhost:99', ':99.1', ':99; touch nope', '99']) assert.throws(() => nativeDisplayNumber(value));
});
test('Xvfb PID reader only reads the exact existing lock and rejects ambiguous contents', async () => {
    const calls = [];
    assert.equal(await readExpectedXvfbPid(':99.0', { read: async (...args) => { calls.push(args); return '  123\n'; } }), 123);
    assert.deepEqual(calls, [['/tmp/.X99-lock', 'ascii']]);
    for (const value of ['0', '123 124', 'word', '9007199254740993']) {
        await assert.rejects(readExpectedXvfbPid(':99', { read: async () => value }));
    }
});
test('read-only probe discovers exact native title and one consumed send dispatches only once', async () => {
    const h = harness();
    const probe = await probeNativeCloseTarget(target, h.options);
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].mode, 'probe');
    assert.equal(h.requests[0].expected.windowTitle, null);
    const sent = await sendOneNativeClose(probe);
    assert.equal(sent.chordCompleted, true);
    assert.equal(sent.browserClosureVerified, false);
    assert.equal(h.requests[1].expected.windowTitle, expected.windowTitle);
    await assert.rejects(sendOneNativeClose(probe), /already been consumed/);
    assert.equal(h.requests.length, 2);
});
test('external mutation of reviewable evidence cannot change the private send target', async () => {
    const h = harness();
    const probe = await probeNativeCloseTarget(target, h.options);
    probe.evidence.expected.chromePid = 777;
    probe.evidence.target.window = 999;
    await sendOneNativeClose(probe);
    assert.equal(h.requests[1].expected.chromePid, 456);
    assert.equal(h.requests[1].baseline.target.window, 30);
});
test('a plain object or cloned probe cannot authorize a native send', async () => {
    await assert.rejects(sendOneNativeClose({ evidence: evidence() }), /probe issued/);
    const h = harness(); const probe = await probeNativeCloseTarget(target, h.options);
    await assert.rejects(sendOneNativeClose(structuredClone(probe)), /probe issued/);
    assert.equal(h.requests.length, 1);
});
for (const failure of ['timeout', 'malformed', 'failed', 'wrong-sequence', 'x-error', 'keys-held', 'claims-browser-close']) {
    test(`send ${failure} preserves failed/uncertain evidence and consumes the probe without replay`, async () => {
        let calls = 0;
        const probe = await probeNativeCloseTarget(target, { run: async request => {
            calls++;
            const value = evidence(request.mode);
            if (request.mode === 'send') {
                if (failure === 'timeout') throw Object.assign(new Error('timed out'), { stdout: '', stderr: 'transport ended' });
                if (failure === 'malformed') return { stdout: 'not-json', stderr: '' };
                if (failure === 'failed') { value.status = 'failed'; value.error = { message: 'focus changed' }; }
                if (failure === 'wrong-sequence') value.events.reverse();
                if (failure === 'x-error') value.sendSync.xErrors.push({ error_code: 3 });
                if (failure === 'keys-held') value.keyboardAfter.pressedKeycodes.push(37);
                if (failure === 'claims-browser-close') value.browserClosureVerified = true;
            }
            return { stdout: JSON.stringify(value), stderr: '' };
        } });
        await assert.rejects(sendOneNativeClose(probe), error => {
            assert.equal(error.nativeCloseUncertain, true);
            if (!['timeout', 'malformed'].includes(failure)) assert(error.nativeCloseEvidence);
            return true;
        });
        await assert.rejects(sendOneNativeClose(probe), /already been consumed/);
        assert.equal(calls, 2);
    });
}
for (const change of [value => { value.expected = { ...expected, nonce: 'b'.repeat(32) }; },
    value => { value.chordAttempted = true; }, value => { value.events = [{ pressed: true }]; },
    value => { value.expected = { ...expected, windowTitle: null }; }]) {
    test('invalid read-only probe evidence never creates a usable send token', async () => {
        const h = harness(value => { change(value); return value; });
        await assert.rejects(probeNativeCloseTarget(target, h.options));
        assert.equal(h.requests.length, 1);
    });
}
test('invalid caller target is rejected before invoking even an injected helper', async () => {
    const h = harness();
    for (const changes of [{ nonce: 'short' }, { chromePid: 0 }, { windowTitle: 'no nonce' }, { xvfbPid: 456 }]) {
        await assert.rejects(probeNativeCloseTarget({ ...target, ...changes }, h.options));
    }
    assert.equal(h.requests.length, 0);
});
