import test from 'node:test';
import assert from 'node:assert/strict';
import { performVisibleAction, selectResultWithKeyboard } from '../../scripts/paired-chrome-ui.mjs';

const sidebar = { id: 'sidebar', type: 'arcify-sidebar-command', title: 'Open Arcify sidebar' };
const settings = { id: 'settings', type: 'arcify-space-action', title: 'Open Arcify settings' };
const web = { id: 'web', type: 'search-query', title: 'Search for "opn arcfi"' };
const live = { id: 'live', type: 'open-tab', title: 'Open Arcify sidebar' };
const matches = row => row.type === web.type && row.title === web.title;

function keyboardHarness({ initial = [sidebar, web, live], beforeKey, afterKey, dispatch } = {}) {
    let rows = initial, selectedId = initial[0]?.id;
    const keys = [], events = [];
    const state = {
        keys, events,
        get rows() { return rows; },
        get selectedIndex() { return rows.findIndex(row => row.id === selectedId); },
        select(index) { selectedId = rows[index]?.id; },
        replace(next) { rows = next; if (!rows.some(row => row.id === selectedId)) selectedId = undefined; }
    };
    state.read = async () => {
        events.push('read');
        return rows.map(row => ({ ...row, selected: row.id === selectedId }));
    };
    state.input = { press: async key => {
        assert(['Home', 'ArrowDown', 'ArrowUp'].includes(key), `Unexpected action key: ${key}`);
        keys.push(key); events.push(key);
        await beforeKey?.(state, key, keys.length);
        if (dispatch) await dispatch(state, key);
        else state.select(key === 'Home' ? 0 : key === 'ArrowDown'
            ? Math.min(state.selectedIndex + 1, rows.length - 1) : Math.max(state.selectedIndex - 1, 0));
        await afterKey?.(state, key, keys.length);
    } };
    state.run = () => selectResultWithKeyboard(state.input, state.read, matches);
    return state;
}

for (const at of [1, 2]) test(`late settings insertion before key ${at} cannot leave web-search navigation on settings`, async () => {
    const h = keyboardHarness({ beforeKey: (state, key, count) => {
        if (count === at) state.replace([sidebar, settings, web, live]);
    } });
    const result = await h.run();
    assert.deepEqual(result.keys, ['Home', 'ArrowDown', 'ArrowDown']);
    assert.equal(result.after.find(row => row.selected).id, web.id);
    assert.deepEqual(h.events, ['read', 'Home', 'read', 'ArrowDown', 'read', 'ArrowDown', 'read']);
    assert.equal(result.before.length, 3); assert.equal(result.after.length, 4);
    assert.equal(result.observations.length, result.keys.length);
});

test('insertion after web search is selected needs no extra navigation or execution', async () => {
    const h = keyboardHarness({ afterKey: (state, key, count) => {
        if (count === 2) state.replace([sidebar, settings, web, live]);
    } });
    const result = await h.run();
    assert.deepEqual(result.keys, ['Home', 'ArrowDown']);
    assert.equal(result.after.findIndex(row => row.selected), 2);
});

test('removal above the target uses the new indices after a key', async () => {
    const h = keyboardHarness({ initial: [sidebar, settings, web, live], afterKey: (state, key, count) => {
        if (count === 2) state.replace([settings, web, live]);
    } });
    const result = await h.run();
    assert.deepEqual(result.keys, ['Home', 'ArrowDown', 'ArrowDown']);
    assert.equal(result.after.find(row => row.selected).id, web.id);
});

test('a target reordered above the selected row is reached with observed ArrowUp steps', async () => {
    const h = keyboardHarness({ initial: [sidebar, settings, live, web], afterKey: (state, key, count) => {
        if (count === 2) state.replace([web, sidebar, settings, live]);
    } });
    const result = await h.run();
    assert.deepEqual(result.keys, ['Home', 'ArrowDown', 'ArrowUp', 'ArrowUp']);
    assert.equal(result.after[0].selected, true);
});

test('100 rows remain selectable within the independent key budget', async () => {
    const h = keyboardHarness({ initial: [...Array.from({ length: 99 }, (_, i) => ({ id: `row-${i}`, type: 'other' })), web] });
    const result = await h.run();
    assert.equal(result.keys.length, 100); assert.equal(result.after[99].selected, true);
});

test('Home explicitly establishes selection when the initial view has none', async () => {
    const h = keyboardHarness(); h.select(-1);
    assert.equal((await h.run()).after.find(row => row.selected).id, web.id);
    assert.deepEqual(h.keys, ['Home', 'ArrowDown']);
});

for (const rows of [null, [], [sidebar], [web, { ...web, id: 'duplicate' }],
    [web, ...Array.from({ length: 100 }, (_, i) => ({ id: `row-${i}` }))]]) {
    test(`invalid initial target/list fails before any input (${JSON.stringify(rows)?.slice(0, 70)})`, async () => {
        const keys = [];
        await assert.rejects(selectResultWithKeyboard({ press: async key => keys.push(key) }, async () => rows, matches), /one bounded/);
        assert.deepEqual(keys, []);
    });
}

for (const [label, rows] of [
    ['missing target', [sidebar, live]],
    ['duplicate target', [sidebar, web, { ...web, id: 'duplicate' }]],
    ['oversized list', [sidebar, web, ...Array.from({ length: 99 }, (_, i) => ({ id: `row-${i}` }))]]
]) test(`${label} after input fails immediately without restarting navigation`, async () => {
    const h = keyboardHarness({ afterKey: state => state.replace(rows) });
    await assert.rejects(h.run(), /one bounded/);
    assert.deepEqual(h.keys, ['Home']);
});

test('multiple initial selections are rejected before input', async () => {
    let presses = 0;
    await assert.rejects(selectResultWithKeyboard({ press: async () => { presses++; } },
        async () => [sidebar, web].map(row => ({ ...row, selected: true })), matches), /unique selected/);
    assert.equal(presses, 0);
});

for (const count of [0, 2]) test(`${count} selected rows after a key cannot be repaired by further input`, async () => {
    let reads = 0; const keys = [];
    await assert.rejects(selectResultWithKeyboard({ press: async key => keys.push(key) }, async () => {
        reads++; return [sidebar, web].map((row, index) => ({ ...row, selected: reads === 1 ? index === 0 : index < count }));
    }, matches), /unique selected/);
    assert.deepEqual(keys, ['Home']);
});

for (const key of ['Home', 'ArrowDown']) test(`ignored ${key} on an unchanged list is a hard navigation failure`, async () => {
    const h = keyboardHarness({ dispatch: (state, current) => { if (current !== key) state.select(0); } });
    if (key === 'Home') h.select(2);
    await assert.rejects(h.run(), /expected single step/);
    assert.deepEqual(h.keys, key === 'Home' ? ['Home'] : ['Home', 'ArrowDown']);
});

for (const wrongIndex of [0, 2]) test(`a Down key that lands at wrong index ${wrongIndex} is not retried`, async () => {
    const h = keyboardHarness({ initial: [sidebar, settings, live, web], dispatch: (state, key) => state.select(key === 'Home' ? 0 : wrongIndex) });
    await assert.rejects(h.run(), /expected single step/);
    assert.deepEqual(h.keys, ['Home', 'ArrowDown']);
});

test('a wrong-direction Up key cannot be hidden by eventual target selection', async () => {
    const h = keyboardHarness({ initial: [sidebar, settings, live, web],
        dispatch: (state, key) => state.select(key === 'Home' ? 0 : state.selectedIndex + 1),
        afterKey: (state, key, count) => {
        if (count === 2) state.replace([web, sidebar, settings, live]);
    } });
    await assert.rejects(h.run(), /expected single step/);
    assert.deepEqual(h.keys, ['Home', 'ArrowDown', 'ArrowUp']);
});

test('unending row churn stops at the fixed 200-key cap without Home replay or Enter', async () => {
    const h = keyboardHarness({ afterKey: (state, key, count) => {
        state.replace([{ ...sidebar, title: `changing-${count}` }, web]); state.select(0);
    } });
    await assert.rejects(h.run(), /bounded navigation budget/);
    assert.equal(h.keys.length, 200);
    assert.equal(h.keys.filter(key => key === 'Home').length, 1);
    assert(h.keys.slice(1).every(key => key === 'ArrowDown'));
});

function visibleHarness() {
    const records = [];
    const page = { url: () => 'https://local.test/', bringToFront: async () => {}, waitForFunction: async () => {},
        evaluate: async () => ({ visibility: 'visible', hasFocus: true }) };
    return { records, run: operation => performVisibleAction(page, 'Select exact web search', operation, async record => records.push(record)) };
}

test('failed navigation records the initial rows and every completed key observation', async () => {
    const h = keyboardHarness({ afterKey: (state, key, count) => { if (count === 2) state.replace([sidebar, live]); } });
    const visible = visibleHarness();
    await assert.rejects(visible.run(h.run), /one bounded/);
    const failure = visible.records.at(-1);
    assert.equal(failure.phase, 'failed'); assert.equal(failure.failedPhase, 'action');
    assert.equal(failure.keyboardSelection.phase, 'validate-after');
    assert.deepEqual(failure.keyboardSelection.keys, ['Home', 'ArrowDown']);
    assert.equal(failure.keyboardSelection.before.length, 3);
    assert.equal(failure.keyboardSelection.observations.length, 2);
    assert.deepEqual(failure.keyboardSelection.observations.at(-1).rows.map(row => row.id), ['sidebar', 'live']);
});

for (const frozen of [false, true]) test(`input error is preserved without replay and retains attempted-key evidence (frozen=${frozen})`, async () => {
    const error = new Error('uncertain input failure'); if (frozen) Object.freeze(error);
    const h = keyboardHarness({ beforeKey: (state, key, count) => { if (count === 2) throw error; } });
    const visible = visibleHarness();
    await assert.rejects(visible.run(h.run), observed => observed === error);
    const trace = visible.records.at(-1).keyboardSelection;
    assert.deepEqual(h.keys, ['Home', 'ArrowDown']); assert.deepEqual(trace.keys, h.keys);
    assert.equal(trace.phase, 'press'); assert.equal(trace.observations.length, 1);
});

for (const failureRead of [1, 2]) test(`read failure ${failureRead} is preserved without another read or key`, async () => {
    const error = new Error('read failed'), h = keyboardHarness(), visible = visibleHarness(); let reads = 0;
    await assert.rejects(visible.run(() => selectResultWithKeyboard(h.input, async () => {
        if (++reads === failureRead) throw error; return h.read();
    }, matches)), observed => observed === error);
    assert.equal(reads, failureRead); assert.equal(h.keys.length, failureRead - 1);
    const trace = visible.records.at(-1).keyboardSelection;
    assert.equal(trace.phase, failureRead === 1 ? 'read-before' : 'read-after');
    assert.equal(trace.observations.length, 0);
});

test('failure to record the trace cannot replay any keyboard input', async () => {
    const h = keyboardHarness({ afterKey: state => state.replace([sidebar]) });
    const error = new Error('report unavailable');
    const page = { url: () => 'https://local.test/', bringToFront: async () => {}, waitForFunction: async () => {}, evaluate: async () => ({}) };
    await assert.rejects(performVisibleAction(page, 'select', h.run, async record => { if (record.phase === 'failed') throw error; }), observed => observed === error);
    assert.deepEqual(h.keys, ['Home']);
});
