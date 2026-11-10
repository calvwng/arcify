import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { mountFavoriteRestartDiagnostics } from '../../favorite-restart-diagnostics-ui.js';
import { RESTART_DIAGNOSTIC_KEY, sanitizeRestartDiagnostic } from '../../favorite-restart-diagnostics.js';

const report = () => ({ version: 1, startup: { capturedAt: 100, status: 'complete', counts: {} } });
const pause = () => new Promise(resolve => setTimeout(resolve, 35));
function fixture(get, writeText = async () => {}) {
    const { document, window } = parseHTML('<html><body><button id="favorite-restart-diagnostic-read">Read</button><button id="favorite-restart-diagnostic-copy">Copy</button><p id="favorite-restart-diagnostic-notice"></p><div id="favorite-restart-diagnostic-output"></div></body></html>');
    const readButton = document.getElementById('favorite-restart-diagnostic-read');
    const copyButton = document.getElementById('favorite-restart-diagnostic-copy');
    const handlers = {};
    for (const [key, button] of [['read', readButton], ['copy', copyButton]]) {
        const add = button.addEventListener.bind(button);
        button.addEventListener = (name, fn, ...args) => { if (name === 'click') handlers[key] = fn; add(name, fn, ...args); };
    }
    const dispose = mountFavoriteRestartDiagnostics(document, { storage: { local: { get } } }, { timeoutMs: 20, clipboard: { writeText } });
    return { document, window, readButton, copyButton, dispose,
        read: (event = { isTrusted: true }) => handlers.read(event),
        copy: (event = { isTrusted: true }) => handlers.copy(event),
        text: () => document.body.textContent,
        hide: () => { Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new window.Event('visibilitychange')); }
    };
}

test('read and copy require separate trusted gestures and access only the saved diagnostic', async () => {
    const calls = [], copies = [];
    const raw = report();
    const f = fixture(async key => { calls.push(key); return { [key]: raw }; }, async text => copies.push(text));
    assert.equal(calls.length, 0); assert.equal(f.copyButton.disabled, true);
    await f.copy(); await f.read({ isTrusted: false }); await f.read({});
    assert.equal(calls.length, 0); assert.equal(copies.length, 0);
    await f.read();
    assert.deepEqual(calls, [RESTART_DIAGNOSTIC_KEY]);
    assert.match(f.text(), /Historical diagnostic, not live/);
    assert.match(f.text(), /Last captured startup/); assert.match(f.text(), /No captured diagnostic for this stage/);
    assert.equal(f.copyButton.disabled, false);
    await f.copy({ isTrusted: false }); assert.equal(copies.length, 0);
    // Mutating raw storage after the read must not change the copied snapshot.
    raw.startup.status = 'failed';
    await f.copy(); assert.equal(copies.length, 1);
    assert.deepEqual(JSON.parse(copies[0]), sanitizeRestartDiagnostic(report()));
    assert.equal(calls.length, 1); f.dispose();
});

test('missing and invalid diagnostics leave copy disabled and never expose raw fields', async () => {
    for (const raw of [undefined, { version: 99, url: 'https://private.invalid', error: '<script>secret</script>' }]) {
        const f = fixture(async () => ({ [RESTART_DIAGNOSTIC_KEY]: raw }));
        await f.read(); assert.match(f.text(), /No captured diagnostic in this build yet/);
        assert.equal(f.copyButton.disabled, true); assert(!f.text().includes('private.invalid')); assert(!f.text().includes('secret')); f.dispose();
    }
});

test('storage failure is bounded and exposes no exception data', async () => {
    const f = fixture(async () => { throw new Error('secret title https://private.invalid'); });
    await f.read(); assert.match(f.text(), /could not be read/); assert(!f.text().includes('private.invalid'));
    assert.equal(f.readButton.disabled, false); assert.equal(f.copyButton.disabled, true); f.dispose();
});

test('pending reads are repeat-protected and a late rejection cannot clear a newer result', async () => {
    let reject, calls = 0;
    const f = fixture(() => ++calls === 1 ? new Promise((resolve, fail) => { reject = fail; }) : Promise.resolve({ [RESTART_DIAGNOSTIC_KEY]: report() }));
    const pending = f.read(); await f.read(); assert.equal(calls, 1);
    await pause(); assert.match(f.text(), /timed out/); assert.equal(f.readButton.disabled, false);
    await f.read(); reject(new Error('late')); await pending;
    assert.match(f.text(), /Last captured startup/); assert.equal(f.copyButton.disabled, false); f.dispose();
});

test('hidden page and pagehide invalidate late storage results', async () => {
    for (const action of ['hide', 'pagehide', 'dispose']) {
        let release;
        const f = fixture(() => new Promise(resolve => { release = resolve; }));
        const pending = f.read();
        if (action === 'pagehide') f.window.dispatchEvent(new f.window.Event('pagehide'));
        else f[action]();
        release({ [RESTART_DIAGNOSTIC_KEY]: report() }); await pending;
        assert(!f.text().includes('Last captured startup')); assert.equal(f.copyButton.disabled, true);
        if (action !== 'hide') { await f.read(); assert.equal(f.readButton.disabled, true); }
        f.dispose();
    }
});

test('clipboard errors are safe and timeout never retries or rereads storage', async () => {
    let calls = 0, copies = 0, release;
    const f = fixture(async () => { calls++; return { [RESTART_DIAGNOSTIC_KEY]: report() }; }, () => { copies++; return new Promise(resolve => { release = resolve; }); });
    await f.read(); const pending = f.copy(); await f.copy(); assert.equal(copies, 1);
    await pause(); assert.match(f.text(), /completion could not be confirmed/); assert.equal(calls, 1);
    release(); await pending; assert.match(f.text(), /completion could not be confirmed/); f.dispose();
    const g = fixture(async () => ({ [RESTART_DIAGNOSTIC_KEY]: report() }), async () => { throw new Error('private error'); });
    await g.read(); await g.copy(); assert.match(g.text(), /could not be copied/); assert(!g.text().includes('private error')); g.dispose();
});

test('counts have understandable labels and all three stages remain historical', async () => {
    const raw = {
        version: 1,
        beforeStartup: { capturedAt: 10, status: 'complete', counts: { hintsWritten: 3 } },
        startup: { capturedAt: 20, status: 'complete', counts: { titleChanged: 2, windowCohortChanged: 1 } },
        checkpoint: { capturedAt: 30, status: 'skipped', counts: { attachmentPending: 1 } }
    };
    const copies = [], f = fixture(async () => ({ [RESTART_DIAGNOSTIC_KEY]: raw }), async text => copies.push(text));
    await f.read();
    assert.match(f.text(), /Saved checkpoint before last captured startup/);
    assert.match(f.text(), /earlier recorded evidence/); assert.match(f.text(), /Page title changed/);
    assert.match(f.text(), /Window page set changed/); assert.match(f.text(), /Favorite attachment pending/);
    assert.equal(f.document.querySelectorAll('dt').length, 4);
    await f.copy(); assert.deepEqual(JSON.parse(copies[0]), raw); f.dispose();
});

test('unknown identity and exception fields are not rendered or copied', async () => {
    for (const raw of [
        { ...report(), url: 'https://private.invalid' },
        { version: 1, startup: { ...report().startup, title: '<img src=x onerror=alert(1)>' } },
        { version: 1, startup: { ...report().startup, counts: { 'https://private.invalid': 1 } } }
    ]) {
        let copies = 0;
        const f = fixture(async () => ({ [RESTART_DIAGNOSTIC_KEY]: raw }), async () => copies++);
        await f.read(); await f.copy();
        assert.equal(copies, 0); assert.equal(f.copyButton.disabled, true);
        assert(!f.text().includes('private.invalid')); assert.equal(f.document.querySelectorAll('img').length, 0); f.dispose();
    }
});
