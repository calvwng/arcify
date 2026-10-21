import test from 'node:test';
import assert from 'node:assert/strict';
import { createTransientOpenDiagnostic, TRANSIENT_OPEN_DIAGNOSTIC_KEY, TRANSIENT_OPEN_DIAGNOSTIC_LIMIT } from '../../transient-window-diagnostics.js';
const symbol = Symbol.for(TRANSIENT_OPEN_DIAGNOSTIC_KEY);
const entry = { originWindowId: 10, windowId: 20, controllerTabId: 100, tabId: null, phase: 'opening', token: 'secret-token' };

test('diagnostics are inert by default and do not call an installed accessor', () => {
    assert.equal(createTransientOpenDiagnostic(entry), null);
    Object.defineProperty(globalThis, symbol, { configurable: true, get() { assert.fail('Accessor cannot be a diagnostic hook.'); } });
    try { assert.equal(createTransientOpenDiagnostic(entry), null); }
    finally { delete globalThis[symbol]; }
});
test('sink is bounded, bypasses supplied push callback and records only scalar redacted evidence', () => {
    const sink = [];
    sink.push = () => assert.fail('Sink callbacks cannot run.');
    Object.defineProperty(globalThis, symbol, { value: sink, configurable: true });
    try {
        const diagnostic = createTransientOpenDiagnostic(entry);
        diagnostic.controller({ id: 100, windowId: 20, url: 'https://private.test/?secret', pendingUrl: 'chrome-extension://own/secret-token', title: 'private' }, 'expected');
        diagnostic.rejected(Object.assign(new Error('https://private.test/?secret secret-token'), { code: 'UNRECOGNIZED_SECRET' }));
        diagnostic.rejected(Object.defineProperty({}, 'code', { get() { assert.fail('Error getters cannot run.'); } }));
        for (let index = 0; index < TRANSIENT_OPEN_DIAGNOSTIC_LIMIT + 10; index++) diagnostic.stage('web-fence');
        assert.equal(sink.length, TRANSIENT_OPEN_DIAGNOSTIC_LIMIT);
        assert.equal(sink[0].controller.url, 'other'); assert.equal(sink[0].controller.pendingUrl, 'other');
        assert.deepEqual(sink[1].error, { name: 'Error', code: null, messageOmitted: true });
        assert.equal(JSON.stringify(sink).includes('secret'), false); assert.equal(JSON.stringify(sink).includes('private'), false);
        assert.equal(sink.at(-1).sequence, TRANSIENT_OPEN_DIAGNOSTIC_LIMIT);
    } finally { delete globalThis[symbol]; }
});
