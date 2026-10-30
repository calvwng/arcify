import test from 'node:test';
import assert from 'node:assert/strict';
import { getTodayOrderInverted, getTodayInsertionIndex, TODAY_ORDER_KEY } from '../../today-order.js';

function fixture(invertTabOrder) {
    const local = {}, sync = invertTabOrder === undefined ? {} : { invertTabOrder }, writes = [];
    const area = data => ({ async get(keys) {
        const names = typeof keys === 'string' ? [keys] : Object.keys(keys);
        return Object.fromEntries(names.map(key => [key, key in data ? data[key] : typeof keys === 'object' ? keys[key] : undefined]));
    }, async set(value) { writes.push(value); Object.assign(data, structuredClone(value)); } });
    globalThis.chrome = { storage: { local: area(local), sync: area(sync) } };
    return { local, sync, writes };
}

for (const legacy of [undefined, false, true]) test(`Today freezes legacy effective orientation ${legacy} without rewriting any model`, async () => {
    const f = fixture(legacy); f.local.spaces = [{ temporaryTabs: [9, 7], spaceBookmarks: [3, 2] }];
    f.local.spaceTabSnapshot = [{ tabId: 7, order: 9 }]; f.local.spaceRankCheckpoint = { untouched: true };
    const original = structuredClone(f.local), expected = legacy !== false;
    assert.equal(await getTodayOrderInverted(), expected);
    assert.deepEqual(f.local, { ...original, [TODAY_ORDER_KEY]: { version: 1, inverted: expected } });
    f.sync.invertTabOrder = !expected;
    assert.equal(await getTodayOrderInverted(), expected);
    assert.equal(f.writes.length, 1);
});

test('independent extension contexts serialize first freeze on the shared origin lock', async () => {
    const f = fixture(false), requests = [];
    let chain = Promise.resolve();
    const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request(name, callback) {
        requests.push(name); const next = chain.then(callback); chain = next.catch(() => {}); return next;
    } } } });
    try {
        const a = await import('../../today-order.js?worker'), b = await import('../../today-order.js?sidebar');
        assert.deepEqual(await Promise.all([a.getTodayOrderInverted(), b.getTodayOrderInverted()]), [false, false]);
        assert.deepEqual(requests, ['arcify-today-order-representation', 'arcify-today-order-representation']);
        assert.equal(f.writes.length, 1);
    } finally {
        if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
        else delete globalThis.navigator;
    }
});

test('a failed first metadata write retries without a stale cached orientation', async () => {
    const f = fixture(false), set = chrome.storage.local.set;
    chrome.storage.local.set = async () => { throw new Error('Unavailable'); };
    await assert.rejects(getTodayOrderInverted(), /Unavailable/);
    f.sync.invertTabOrder = true; chrome.storage.local.set = set;
    assert.equal(await getTodayOrderInverted(), true);
});

test('unknown representation is retained and fails closed instead of silently reinterpreting arrays', async () => {
    const f = fixture(true); f.local[TODAY_ORDER_KEY] = { version: 2, inverted: false };
    await assert.rejects(getTodayOrderInverted(), /Unrecognized Today/); assert.equal(f.writes.length, 0);
});

for (const inverted of [false, true]) for (const newTabsAtTop of [false, true]) test(`pure placement preserves visible intent inverted=${inverted}, top=${newTabsAtTop}`, () => {
    const ids = [1, 2, 3], options = { inverted, newTabsAtTop };
    const standalone = [...ids]; standalone.splice(getTodayInsertionIndex(ids, options), 0, 4);
    const visible = inverted ? standalone.reverse() : standalone;
    assert.equal(visible[newTabsAtTop ? 0 : visible.length - 1], 4);
    const child = [...ids]; child.splice(getTodayInsertionIndex(ids, { ...options, openerTabId: 2 }), 0, 4);
    const childVisible = inverted ? child.reverse() : child;
    assert.equal(childVisible[childVisible.indexOf(2) + 1], 4);
});
