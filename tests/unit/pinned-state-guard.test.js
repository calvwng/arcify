import test from 'node:test';
import assert from 'node:assert/strict';
import { Utils } from '../../utils.js';

for (const boundary of ['queue', 'read']) test(`pinned binding callback validates after ${boundary} wait before write`, async () => {
    const writes = [], events = []; let release;
    const held = new Promise(resolve => { release = resolve; });
    globalThis.chrome = { tabs: { get: async id => ({ id, incognito: false }) }, storage: { local: {
        async get() { events.push('read'); if (boundary === 'read') await held; return { pinnedTabStatesById: { 7: { bookmarkId: 'existing' } } }; },
        async set(value) { writes.push(value); }
    } } };
    const utils = { ...Utils, _pinnedStateChain: boundary === 'queue' ? held : Promise.resolve() };
    let split = false;
    const run = utils.setPinnedTabState(8, { bookmarkId: 'new' }, { beforeWrite: async () => { events.push('guard'); if (split) throw new Error('End Split View'); } });
    await Promise.resolve(); split = true; release();
    await assert.rejects(run, /End Split View/); assert.deepEqual(events, ['read', 'guard']); assert.deepEqual(writes, []);
    await utils.setPinnedTabState(9, { bookmarkId: 'unrelated' }); assert.equal(writes.length, 1, 'A rejected validation never wedges the serialization queue');
});

for (const previous of [undefined, { bookmarkId: 'old', pinnedUrl: 'https://old.test/' }]) test(`guarded binding restores ${previous ? 'existing' : 'absent'} prior state when native split appears during storage write`, async () => {
    let bindings = { 7: { bookmarkId: 'unrelated', pinnedUrl: 'https://other.test/' }, ...(previous ? { 8: previous } : {}) };
    const before = structuredClone(bindings), writes = []; let split = false;
    globalThis.chrome = { tabs: { get: async id => ({ id, incognito: false }) }, storage: { local: {
        async get() { return { pinnedTabStatesById: structuredClone(bindings) }; },
        async set(value) { bindings = structuredClone(value.pinnedTabStatesById); writes.push(structuredClone(bindings)); split = true; }
    } } };
    const utils = { ...Utils, _pinnedStateChain: Promise.resolve() };
    await assert.rejects(utils.setPinnedTabState(8, { bookmarkId: 'new', pinnedUrl: 'https://new.test/' }, { beforeWrite: async () => { if (split) throw new Error('End Split View'); } }), /End Split View/);
    assert.equal(writes.length, 2); assert.deepEqual(bindings, before);
});

test('guarded cleanup never overwrites another writer’s newer binding', async () => {
    let bindings = {}, checks = 0, writes = 0;
    const newer = { bookmarkId: 'newer', pinnedUrl: 'https://newer.test/' };
    globalThis.chrome = { tabs: { get: async id => ({ id, incognito: false }) }, storage: { local: {
        async get() { return { pinnedTabStatesById: structuredClone(bindings) }; },
        async set(value) { bindings = structuredClone(value.pinnedTabStatesById); writes++; }
    } } };
    const utils = { ...Utils, _pinnedStateChain: Promise.resolve() };
    await assert.rejects(utils.setPinnedTabState(8, { bookmarkId: 'ours' }, { beforeWrite: async () => {
        if (++checks > 1) { bindings[8] = newer; throw new Error('End Split View'); }
    } }), /End Split View/);
    assert.equal(writes, 1); assert.deepEqual(bindings[8], newer);
});

for (const failure of ['read', 'write']) test(`guarded cleanup ${failure} failure explicitly reports uncertainty`, async () => {
    let bindings = {}, split = false, reads = 0, writes = 0;
    globalThis.chrome = { tabs: { get: async id => ({ id, incognito: false }) }, storage: { local: {
        async get() { if (++reads > 1 && failure === 'read') throw new Error('Read failed'); return { pinnedTabStatesById: structuredClone(bindings) }; },
        async set(value) { if (++writes > 1 && failure === 'write') throw new Error('Write failed'); bindings = structuredClone(value.pinnedTabStatesById); split = true; }
    } } };
    const utils = { ...Utils, _pinnedStateChain: Promise.resolve() };
    await assert.rejects(utils.setPinnedTabState(8, { bookmarkId: 'ours' }, { beforeWrite: async () => { if (split) throw new Error('End Split View'); } }), error => {
        assert.equal(error.cleanupUncertain, true); assert.match(error.message, /cleanup could not be confirmed/); return true;
    });
});

for (const newer of [false, true]) test(`guarded binding removal restores its exact batch${newer ? ' while preserving a newer binding' : ''}`, async () => {
    const original = { 1: { bookmarkId: 'pin', pinnedUrl: 'https://old.test/' }, 2: { bookmarkId: 'pin', pinnedUrl: 'https://old.test/' }, 7: { bookmarkId: 'other' } };
    let bindings = structuredClone(original), checks = 0, writes = 0;
    globalThis.chrome = { tabs: { get: async id => ({ id, incognito: false }) }, storage: { local: {
        async get() { return { pinnedTabStatesById: structuredClone(bindings) }; },
        async set(value) { bindings = structuredClone(value.pinnedTabStatesById); writes++; }
    } } };
    const utils = { ...Utils, _pinnedStateChain: Promise.resolve() };
    await assert.rejects(utils.removePinnedTabStates([1, 2], { expectedBookmarkId: 'pin', beforeWrite: async () => {
        if (++checks > 1) { if (newer) bindings[1] = { bookmarkId: 'newer' }; throw new Error('End Split View'); }
    } }), /End Split View/);
    assert.equal(writes, 2); assert.deepEqual(bindings, { ...original, ...(newer ? { 1: { bookmarkId: 'newer' } } : {}) });
});

for (const failure of ['read', 'write']) test(`guarded binding removal reports uncertain ${failure} cleanup without hiding partial deletion`, async () => {
    let bindings = { 1: { bookmarkId: 'pin', pinnedUrl: 'https://old.test/' } }, checks = 0, reads = 0, writes = 0;
    globalThis.chrome = { tabs: { get: async id => ({ id, incognito: false }) }, storage: { local: {
        async get() { if (++reads > 1 && failure === 'read') throw new Error('Read failed'); return { pinnedTabStatesById: structuredClone(bindings) }; },
        async set(value) { if (++writes > 1 && failure === 'write') throw new Error('Write failed'); bindings = structuredClone(value.pinnedTabStatesById); }
    } } };
    const utils = { ...Utils, _pinnedStateChain: Promise.resolve() };
    await assert.rejects(utils.removePinnedTabState(1, { expectedBookmarkId: 'pin', beforeWrite: async () => { if (++checks > 1) throw new Error('End Split View'); } }), error => {
        assert(error.cleanupUncertain); assert.match(error.message, /cleanup could not be confirmed/); return true;
    });
});

test('guarded removal rejects a replacement bookmark before writing any binding', async () => {
    let writes = 0;
    globalThis.chrome = { tabs: { get: async id => ({ id, incognito: false }) }, storage: { local: { async get() { return { pinnedTabStatesById: { 1: { bookmarkId: 'newer' } } }; }, async set() { writes++; } } } };
    const utils = { ...Utils, _pinnedStateChain: Promise.resolve() };
    await assert.rejects(utils.removePinnedTabState(1, { expectedBookmarkId: 'old', beforeWrite: async () => {} }), /different bookmark/);
    assert.equal(writes, 0);
});
