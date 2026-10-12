import test from 'node:test';
import assert from 'node:assert/strict';
import { performVisibleAction, replaceInputText } from '../../scripts/paired-chrome-ui.mjs';

function harness() {
    const calls = [], records = [];
    const page = {
        url: () => 'chrome-extension://fixture/options.html',
        async bringToFront() { calls.push('foreground'); },
        async waitForFunction(predicate, options) {
            calls.push('visible');
            assert.deepEqual(options, { polling: 50, timeout: 20_000 });
            const old = globalThis.document;
            try {
                globalThis.document = { visibilityState: 'hidden' }; assert.equal(predicate(), false);
                globalThis.document.visibilityState = 'visible'; assert.equal(predicate(), true);
            } finally { if (old === undefined) delete globalThis.document; else globalThis.document = old; }
        },
        async evaluate() { calls.push('observe'); return { visibility: 'visible', hasFocus: true }; }
    };
    return { page, calls, records, record: async value => { records.push(value); } };
}

test('foreground and visible-page verification precede the real supplied UI operation', async () => {
    const h = harness();
    const result = await performVisibleAction(h.page, 'save peer', async () => { h.calls.push('real click'); return 42; }, h.record);
    assert.equal(result, 42);
    assert.deepEqual(h.calls, ['foreground', 'visible', 'observe', 'real click']);
    assert.deepEqual(h.records.map(item => item.phase), ['focus', 'action', 'completed']);
    assert.equal(h.records[1].document.visibility, 'visible');
    assert.equal(h.records[2].label, 'save peer');
});
for (const method of ['bringToFront', 'waitForFunction', 'evaluate']) {
    test(`failure in ${method} cannot run or silently retry the UI operation`, async () => {
        const h = harness(); let actions = 0;
        h.page[method] = async () => { throw new Error('unavailable'); };
        await assert.rejects(performVisibleAction(h.page, 'save peer', async () => { actions++; }, h.record), /unavailable/);
        assert.equal(actions, 0);
        assert.equal(h.records.at(-1).phase, 'failed');
        assert.equal(h.records.at(-1).failedPhase, 'focus');
    });
}
test('an action failure records its location and never repeats a possibly applied mutation', async () => {
    const h = harness(); let actions = 0;
    await assert.rejects(performVisibleAction(h.page, 'save peer', async () => { actions++; throw new Error('click failed'); }, h.record), /click failed/);
    assert.equal(actions, 1);
    assert.equal(h.records.at(-1).failedPhase, 'action');
    assert.equal(h.records.at(-1).error, 'click failed');
});

test('a successful navigation or closing action needs no post-action page probe', async () => {
    const h = harness();
    const result = await performVisibleAction(h.page, 'select result', async () => {
        for (const method of ['url', 'bringToFront', 'waitForFunction', 'evaluate']) {
            h.page[method] = () => { throw new Error('page closed'); };
        }
        return 'selected';
    }, h.record);
    assert.equal(result, 'selected');
    assert.equal(h.records.at(-1).phase, 'completed');
});

function keyboardHarness(failedKey) {
    const calls = [];
    return { calls,
        page: { keyboard: { down: async key => calls.push(['down', key]), up: async key => calls.push(['up', key]) } },
        input: { click: async options => calls.push(['click', options]),
            press: async key => { calls.push(['press', key]); if (key === failedKey) throw new Error('input unavailable'); },
            type: async text => calls.push(['type', text]) }
    };
}
test('query replacement sends real separate modifier/key events before typing', async () => {
    const h = keyboardHarness();
    await replaceInputText(h.page, h.input, 'Pair Alpha Target');
    assert.deepEqual(h.calls, [['click', { clickCount: 3 }], ['down', 'Control'], ['press', 'KeyA'], ['up', 'Control'], ['press', 'Backspace'], ['type', 'Pair Alpha Target']]);
});
test('failed selection releases Control and does not erase/type/retry', async () => {
    const h = keyboardHarness('KeyA');
    await assert.rejects(replaceInputText(h.page, h.input, 'replacement'), /input unavailable/);
    assert.deepEqual(h.calls, [['click', { clickCount: 3 }], ['down', 'Control'], ['press', 'KeyA'], ['up', 'Control']]);
});
test('failed clearing never types replacement text', async () => {
    const h = keyboardHarness('Backspace');
    await assert.rejects(replaceInputText(h.page, h.input, 'replacement'), /input unavailable/);
    assert.equal(h.calls.some(([event]) => event === 'type'), false);
});
