import test from 'node:test';
import assert from 'node:assert/strict';
import { RESTART_DIAGNOSTIC_KEY as key, sanitizeRestartDiagnostic, recordRestartDiagnostic, addRestartDiagnosticCount } from '../../favorite-restart-diagnostics.js';
const part = (counts = {}) => ({ capturedAt: 100, status: 'complete', counts });

test('diagnostic sanitizer allows only bounded counts and timestamps without identities or raw errors', () => {
    const report = { version: 1, startup: part({ titleChanged: 1 }), beforeStartup: part({ hintsWritten: 1 }) };
    assert.deepEqual(sanitizeRestartDiagnostic(report), report);
    for (const value of [null, [], { ...report, url: 'https://private.invalid/' }, { ...report, startup: { ...part(), error: 'private' } },
        { ...report, startup: part({ secret: 1 }) }, { ...report, startup: part({ recovered: -1 }) },
        { ...report, startup: part({ recovered: 1000001 }) }, { ...report, startup: part({ recovered: 'title' }) },
        { ...report, startup: { ...part(), capturedAt: Infinity } }, { ...report, beforeStartup: { ...part(), status: 'private' } }]) {
        assert.equal(sanitizeRestartDiagnostic(value), null);
    }
});

test('new startup freezes prior checkpoint; activation and later checkpoint leave it intact', async () => {
    let data = { [key]: { version: 1, checkpoint: part({ pageLoading: 1, hintsWritten: 0 }) } };
    const api = { storage: { local: { async get() { return structuredClone(data); }, async set(value) { data = structuredClone(value); } } } };
    await recordRestartDiagnostic('startup', part({ noHints: 1 }), api, { newStartup: true });
    const beforeStartup = structuredClone(data[key].beforeStartup);
    await recordRestartDiagnostic('checkpoint', part({ hintsWritten: 1 }), api);
    await recordRestartDiagnostic('startup', part({ recovered: 1 }), api);
    assert.deepEqual(data[key].beforeStartup, beforeStartup);
    assert.equal(data[key].checkpoint.counts.hintsWritten, 1);
    assert.equal(data[key].startup.counts.recovered, 1);
});

test('writer catches failed storage and rejects non-allowlisted records without saving them', async () => {
    let writes = 0;
    const api = { storage: { local: { async get() { return {}; }, async set() { writes++; throw new Error('private failure'); } } } };
    await recordRestartDiagnostic('checkpoint', part({ recovered: 1 }), api);
    assert.equal(writes, 1);
    await recordRestartDiagnostic('checkpoint', part({ url: 1 }), api);
    await recordRestartDiagnostic('unknown', part(), api);
    assert.equal(writes, 1);
    const report = part();
    addRestartDiagnosticCount(report, 'titleChanged', 1000000);
    addRestartDiagnosticCount(report, 'titleChanged', 1);
    addRestartDiagnosticCount(report, 'private title');
    assert.deepEqual(report.counts, { titleChanged: 1000000 });
});


test('diagnostic-only session marker preserves skips but allows a first actual inference report', async () => {
    let local = { [key]: { version: 1, checkpoint: part({ hintsWritten: 2 }) } }, session = {};
    const area = data => ({ async get() { return structuredClone(data); }, async set(value) { Object.assign(data, structuredClone(value)); } });
    const api = { storage: { local: area(local), session: area(session) } };
    await recordRestartDiagnostic('startup', part({ noHints: 1 }), api, { newStartup: true });
    await recordRestartDiagnostic('checkpoint', part({ hintsWritten: 1 }), api);
    assert.equal(await recordRestartDiagnostic('startup', part({ alreadyKnown: 1 }), api, { newStartup: true }), false);
    assert.equal(local[key].startup.counts.noHints, 1);
    assert.equal(local[key].beforeStartup.counts.hintsWritten, 2);
    await recordRestartDiagnostic('startup', part({ inferredCandidates: 1 }), api, { newStartup: true, attempted: true });
    assert.equal(local[key].startup.counts.inferredCandidates, 1);
    assert.equal(local[key].beforeStartup.counts.hintsWritten, 2);
    assert.equal(await recordRestartDiagnostic('startup', part({ alreadyKnown: 1 }), api, { newStartup: true }), false);
    assert.equal(local[key].startup.counts.inferredCandidates, 1);
});


test('diagnostic writer touches only exact auxiliary keys and preserves recovery authority', async () => {
    const local = { favoriteRestartHints: { privateEvidence: 'unchanged' }, persistentFavorites: ['unchanged'] };
    const session = { favoriteRestartRecovery: { entries: ['unchanged'] }, favoriteSession: { bindings: ['unchanged'] } };
    const writes = [];
    const area = (data, name) => ({ async get() { return structuredClone(data); }, async set(value) { writes.push([name, structuredClone(value)]); Object.assign(data, structuredClone(value)); } });
    const api = { storage: { local: area(local, 'local'), session: area(session, 'session') } };
    await recordRestartDiagnostic('startup', part({ noHints: 1 }), api, { newStartup: true });
    assert.deepEqual(writes.map(([name, value]) => [name, Object.keys(value)]), [['local', ['favoriteRestartDiagnostic']], ['session', ['favoriteRestartDiagnosticSession']]]);
    assert.deepEqual(local.favoriteRestartHints, { privateEvidence: 'unchanged' });
    assert.deepEqual(local.persistentFavorites, ['unchanged']);
    assert.deepEqual(session.favoriteRestartRecovery, { entries: ['unchanged'] });
    assert.deepEqual(session.favoriteSession, { bindings: ['unchanged'] });
    assert(sanitizeRestartDiagnostic(local[key]));
});


test('unchanged checkpoint summaries retain their observation time without another write', async () => {
    const original = { capturedAt: 100, status: 'skipped', counts: { exactBindings: 1, duplicateNativePage: 1 } };
    const data = { [key]: { version: 1, checkpoint: original } }, writes = [];
    const api = { storage: { local: { async get() { return structuredClone(data); }, async set(value) { writes.push(value); Object.assign(data, structuredClone(value)); } } } };
    await recordRestartDiagnostic('checkpoint', { capturedAt: 200, status: 'skipped', counts: { duplicateNativePage: 1, exactBindings: 1 } }, api);
    assert.deepEqual(writes, []);
    assert.deepEqual(data[key].checkpoint, original);
    await recordRestartDiagnostic('checkpoint', { capturedAt: 300, status: 'complete', counts: { exactBindings: 1, hintsWritten: 1 } }, api);
    assert.equal(writes.length, 1);
    assert.equal(data[key].checkpoint.capturedAt, 300);
    await recordRestartDiagnostic('checkpoint', { capturedAt: 400, status: 'complete', counts: { exactBindings: 2, hintsWritten: 2 } }, api);
    assert.equal(writes.length, 2, 'Changed counters remain observable');
    await recordRestartDiagnostic('checkpoint', { capturedAt: 500, status: 'complete', counts: { exactBindings: 2, hintsWritten: 2 } }, api);
    assert.equal(writes.length, 3, 'A completed capture retains its new timestamp');
    assert.equal(data[key].checkpoint.capturedAt, 500);
});
