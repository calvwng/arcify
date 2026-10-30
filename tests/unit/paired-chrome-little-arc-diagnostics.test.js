import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readSourceText } from '../source-text.js';
import { installLittleArcOpenDiagnosticSink, readLittleArcOpenDiagnosticSink, removeLittleArcOpenDiagnosticSink,
    withLittleArcOpenDiagnostics } from '../../scripts/paired-chrome-little-arc-diagnostics.mjs';
const arcifyId = 'a'.repeat(32), workerUrl = `chrome-extension://${arcifyId}/background.js`;
const secretError = Object.assign(new Error('https://private.test/?secret token=secret'), { code: 'PRIVATE_SECRET' });

function fixture(failure) {
    const calls = [], observations = [];
    const worker = { evaluate: async (fn, options) => {
        calls.push(fn.name);
        if (failure === fn.name) throw secretError;
        assert.equal(options.key, 'arcify.transient-open.diagnostics.v1');
        if (fn === readLittleArcOpenDiagnosticSink) return [{ stage: 'web-fence', event: 'rejected', error: { code: 'STALE_TRANSIENT' } }];
    } };
    return { calls, observations, context: { arcifyId,
        browser: { targets: () => failure === 'missing-worker' ? [] : [{ type: () => 'service_worker', url: () => workerUrl, worker: async () => worker }] },
        record: async observation => { observations.push(observation); if (failure === 'record') throw secretError; }
    } };
}
for (const failure of [undefined, 'missing-worker', 'installLittleArcOpenDiagnosticSink', 'readLittleArcOpenDiagnosticSink', 'removeLittleArcOpenDiagnosticSink', 'record']) {
    for (const succeeds of [true, false]) test(`diagnostic ${failure || 'success'} preserves original ${succeeds ? 'success' : 'rejection'} exactly`, async () => {
        const f = fixture(failure), result = { exact: 'native-result' }, original = new Error('Original launch failure');
        let operations = 0;
        const promise = withLittleArcOpenDiagnostics(f.context, async () => { operations++; if (!succeeds) throw original; return result; });
        if (succeeds) assert.equal(await promise, result);
        else await assert.rejects(promise, cause => cause === original);
        assert.equal(operations, 1, 'Diagnostics cannot suppress or retry the trusted action.');
        assert.equal(f.observations.length, 1);
        assert.equal(JSON.stringify(f.observations).includes('private.test'), false);
        assert.equal(JSON.stringify(f.observations).includes('token=secret'), false);
        if (!['missing-worker', 'installLittleArcOpenDiagnosticSink'].includes(failure)) assert(f.calls.includes('removeLittleArcOpenDiagnosticSink'));
        if (!failure) {
            assert.equal(f.observations[0].workerUrl, workerUrl);
            assert.equal(f.observations[0].events[0].error.code, 'STALE_TRANSIENT');
            assert.match(f.observations[0].observation, /instrumentation may still affect timing/);
        }
    });
}
test('serialized sink functions create, read and remove only their worker-local symbol', () => {
    const context = vm.createContext({});
    const execute = fn => new vm.Script(`(${fn.toString()})({key:'test-key'})`).runInContext(context);
    assert.equal(execute(installLittleArcOpenDiagnosticSink), undefined);
    assert.equal(execute(readLittleArcOpenDiagnosticSink).length, 0);
    assert.throws(() => execute(installLittleArcOpenDiagnosticSink), /already exists/);
    execute(removeLittleArcOpenDiagnosticSink);
    assert.throws(() => execute(readLittleArcOpenDiagnosticSink), /unavailable/);
});
test('real Little Arc launch records diagnostics on success and failure without replacing UI or adding a fallback', () => {
    const source = readSourceText(new URL('../../scripts/paired-chrome-little-arc.mjs', import.meta.url));
    const start = source.indexOf('    const launch = async (explicit, method) => {');
    const launch = source.slice(start, source.indexOf('    const refreshController', start));
    assert.match(launch, /return withLittleArcOpenDiagnostics\(\{ browser, arcifyId/);
    assert.match(launch, /evidence\.openDiagnostics\.push\(\{ explicit, method, \.\.\.observation \}\)/);
    assert.match(launch, /await input\.press\('Enter'\)/);
    assert.match(launch, /await clickFreshResult/);
    assert.match(launch, /one real ready transient registry receipt/);
    assert.doesNotMatch(launch, /chrome\.(?:tabs|windows)\.(?:create|update|remove)/);
});
