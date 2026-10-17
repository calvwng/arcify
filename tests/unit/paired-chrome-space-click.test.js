import test from 'node:test';
import assert from 'node:assert/strict';
import { readSourceText } from '../source-text.js';
import { clickExactSpaceChip, readSpaceChipGeometry } from '../../scripts/paired-chrome-space-click.mjs';

const sourceFile = 'file:///fixture/scripts/paired-chrome-runtime/node_modules/puppeteer-core/lib/puppeteer/api/ElementHandle.js';
function pointError(stack) {
    const error = new Error('Node is either not clickable or not an Element');
    error.stack = stack ?? `Error: ${error.message}\n    at CdpElementHandle.clickablePoint (${sourceFile}:693:23)\n    at async CdpElementHandle.<anonymous> (${sourceFile}:119:20)\n    at async clickExactSpaceChip (file:///fixture/scripts/paired-chrome-space-click.mjs:62:41)`;
    return error;
}
const chip = overrides => ({ tag: 'BUTTON', spaceId: 'work', connected: true, disabled: false, display: 'block', visibility: 'visible', opacity: '1', pointerEvents: 'auto',
    rects: [{ x: 20, y: 800, width: 80, height: 32 }], ...overrides });
const state = overrides => ({ spaceId: 'work', visibility: 'visible', focused: true, source: chip(), current: chip(),
    currentCount: 1, sourceIsCurrent: true, pointHitsCurrent: true, ...overrides });
const replaced = overrides => state({ source: chip({ connected: false, rects: [] }), sourceIsCurrent: false, ...overrides });
function harness(attempts = [{}], { mouseError, recordError } = {}) {
    let lookups = 0, mouseCalls = 0;
    const records = [], calls = [];
    const page = { async waitForSelector(selector) {
        assert.equal(selector, '#spaceSwitcher button[data-space-id="work"]');
        const attempt = attempts[lookups++];
        if (!attempt) throw new Error('Unexpected reacquisition');
        calls.push('lookup');
        if (attempt.lookupError) throw attempt.lookupError;
        if (attempt.missing) return null;
        let observations = 0;
        return {
            async evaluate(fn, args) {
                assert.equal(fn, readSpaceChipGeometry); assert.equal(args.spaceId, 'work');
                calls.push('observe');
                if (attempt.observeError && observations > 0) throw attempt.observeError;
                return structuredClone(observations++ ? (attempt.after ?? state()) : (attempt.before ?? state()));
            },
            async scrollIntoView() { calls.push('scroll'); if (attempt.scrollError) throw attempt.scrollError; },
            async clickablePoint() { calls.push('point'); if (attempt.pointError) throw attempt.pointError; return attempt.point ?? { x: 60, y: 816 }; },
            async dispose() { calls.push('dispose'); if (attempt.disposeError) throw attempt.disposeError; }
        };
    }, mouse: { async click(x, y) { assert.deepEqual([x, y], [60, 816]); mouseCalls++; calls.push('mouse'); if (mouseError) throw mouseError; } } };
    return { page, calls, records, counts: () => ({ lookups, mouseCalls }),
        record: async value => { records.push(value); if (recordError) throw recordError; } };
}

test('exact current chip dispatches one real mouse call after measurement and hit test', async () => {
    const h = harness(); const result = await clickExactSpaceChip(h.page, 'work', h.record);
    assert.deepEqual(h.counts(), { lookups: 1, mouseCalls: 1 });
    assert.deepEqual(h.calls, ['lookup', 'observe', 'scroll', 'point', 'observe', 'mouse', 'dispose']);
    assert.equal(result.mouseClickAttempts, 1); assert.equal(result.status, 'clicked');
    assert.deepEqual(result.observations.map(item => item.phase), ['before-measurement', 'before-input']);
});
test('locked pre-input point failure and positive replacement proof allow exactly one fresh lookup', async () => {
    const h = harness([{ pointError: pointError(), after: replaced() }, {}]);
    await clickExactSpaceChip(h.page, 'work', h.record);
    assert.deepEqual(h.counts(), { lookups: 2, mouseCalls: 1 });
    assert.equal(h.records[0].mouseClickAttempts, 1);
    assert.equal(h.records[0].observations[1].source.connected, false);
    assert.equal(h.records[0].observations[1].current.connected, true);
    assert.equal(h.records[0].observations[1].preInputVerified, true);
    assert.match(h.records[0].observations[1].error.stack, /CdpElementHandle\.clickablePoint/);
    assert.deepEqual(h.records[0].observations[1].source.rects, []);
    assert.equal(h.calls.filter(call => call === 'dispose').length, 2);
});
for (const [name, after] of [
    ['connected chip', state()],
    ['connected hidden chip', state({ source: chip({ display: 'none', rects: [] }), current: chip({ display: 'none', rects: [] }) })],
    ['hidden replacement', replaced({ current: chip({ display: 'none', rects: [] }) })],
    ['disabled replacement', replaced({ current: chip({ disabled: true }) })],
    ['invisible replacement', replaced({ current: chip({ visibility: 'hidden' }) })],
    ['transparent replacement', replaced({ current: chip({ opacity: '0' }) })],
    ['pointer-disabled replacement', replaced({ current: chip({ pointerEvents: 'none' }) })],
    ['missing replacement', replaced({ current: null, currentCount: 0 })],
    ['duplicate replacement', replaced({ currentCount: 2 })],
    ['wrong source ID', replaced({ source: chip({ spaceId: 'personal', connected: false }) })],
    ['wrong source element', replaced({ source: chip({ tag: 'DIV', connected: false }) })],
    ['wrong replacement ID', replaced({ current: chip({ spaceId: 'personal' }) })],
    ['wrong replacement element', replaced({ current: chip({ tag: 'DIV' }) })],
    ['contradictory source identity', replaced({ sourceIsCurrent: true })],
    ['background page', replaced({ visibility: 'hidden' })],
    ['unfocused page', replaced({ focused: false })],
    ['non-finite geometry', replaced({ current: chip({ rects: [{ x: NaN, y: 1, width: 80, height: 32 }] }) })],
    ['zero geometry', replaced({ current: chip({ rects: [{ x: 0, y: 0, width: 0, height: 0 }] }) })]
]) test(`point failure never reacquires ${name}`, async () => {
    const error = pointError(), h = harness([{ pointError: error, after }]);
    await assert.rejects(clickExactSpaceChip(h.page, 'work', h.record), value => value === error);
    assert.deepEqual(h.counts(), { lookups: 1, mouseCalls: 0 });
    assert.equal(h.records[0].mouseClickAttempts, 0); assert.equal(h.records[0].status, 'failed');
});
for (const [name, transform] of [
    ['missing stack', () => undefined], ['malformed stack', () => 'not a driver error'],
    ['wrong source', stack => stack.replaceAll('/puppeteer-core/', '/other-driver/')],
    ['wrong caller source', stack => stack.replace('119:20', '119:20').replace(`.<anonymous> (${sourceFile}`, '.<anonymous> (file:///other')],
    ['wrong origin', stack => stack.replace('.clickablePoint ', '.click ')],
    ['missing caller', stack => stack.split('\n').slice(0, 2).join('\n')],
    ...['Input.dispatchMouseEvent', 'Mouse.click', 'mouse.click', 'CdpMouse.click'].map(frame => [frame, stack => `${stack}\n    at ${frame} (Input.js:1:1)`])
]) test(`invalid or uncertain driver proof never reacquires: ${name}`, async () => {
    const error = pointError(); error.stack = transform(error.stack);
    const h = harness([{ pointError: error, after: replaced() }]);
    await assert.rejects(clickExactSpaceChip(h.page, 'work', h.record), value => value === error);
    assert.deepEqual(h.counts(), { lookups: 1, mouseCalls: 0 });
    assert.equal(h.records[0].observations.length, 1);
});
test('second proven point detachment is terminal without a third lookup or mouse call', async () => {
    const error = pointError(), h = harness([{ pointError: pointError(), after: replaced() }, { pointError: error, after: replaced() }]);
    await assert.rejects(clickExactSpaceChip(h.page, 'work', h.record), value => value === error);
    assert.deepEqual(h.counts(), { lookups: 2, mouseCalls: 0 });
});
for (const key of ['lookupError', 'scrollError', 'observeError']) test(`${key} never reacquires`, async () => {
    const error = pointError(), h = harness([{ [key]: error, after: replaced() }]);
    await assert.rejects(clickExactSpaceChip(h.page, 'work', h.record), value => value === error);
    assert.deepEqual(h.counts(), { lookups: 1, mouseCalls: 0 });
});
for (const before of [state({ sourceIsCurrent: false }), state({ currentCount: 2 }), state({ current: chip({ display: 'none' }) })]) {
    test('invalid initial exact chip readiness fails before measuring or input', async () => {
        const h = harness([{ before }]); await assert.rejects(clickExactSpaceChip(h.page, 'work', h.record), /uniquely connected and visible/);
        assert.deepEqual(h.counts(), { lookups: 1, mouseCalls: 0 }); assert(!h.calls.includes('point'));
    });
}
for (const after of [replaced(), state({ pointHitsCurrent: false })]) test('changed identity or occluded point after measurement fails without reacquisition', async () => {
    const h = harness([{ after }]); await assert.rejects(clickExactSpaceChip(h.page, 'work', h.record), /changed before input/);
    assert.deepEqual(h.counts(), { lookups: 1, mouseCalls: 0 });
});
test('uncertain mouse failure cannot replay a mutation even with an apparent point-error stack', async () => {
    const error = pointError(), h = harness([{}], { mouseError: error });
    await assert.rejects(clickExactSpaceChip(h.page, 'work', h.record), value => value === error);
    assert.deepEqual(h.counts(), { lookups: 1, mouseCalls: 1 }); assert.equal(h.records[0].mouseClickAttempts, 1);
    assert.equal(h.records[0].status, 'failed');
});
for (const kind of ['record', 'dispose']) test(`${kind} failure after successful input never replays it`, async () => {
    const error = pointError(), h = harness([{ ...(kind === 'dispose' ? { disposeError: error } : {}) }], kind === 'record' ? { recordError: error } : {});
    await assert.rejects(clickExactSpaceChip(h.page, 'work', h.record), value => value === error);
    assert.deepEqual(h.counts(), { lookups: 1, mouseCalls: 1 });
});
test('renderer observation records retained/current exact identities, geometry and point hit without DOM writes', () => {
    const rect = { x: 20, y: 800, width: 80, height: 32 };
    const make = connected => ({ tagName: 'BUTTON', dataset: { spaceId: 'work' }, isConnected: connected, disabled: false,
        getClientRects: () => connected ? [rect] : [], contains: hit => hit?.child === true });
    const source = make(false), current = make(true), selector = '#spaceSwitcher button[data-space-id="work"]';
    const oldDocument = globalThis.document, oldStyle = globalThis.getComputedStyle;
    globalThis.document = { visibilityState: 'visible', hasFocus: () => true,
        querySelectorAll: actual => { assert.equal(actual, selector); return [current]; }, elementFromPoint: (x, y) => { assert.deepEqual([x, y], [60, 816]); return { child: true }; } };
    globalThis.getComputedStyle = () => ({ display: 'block', visibility: 'visible', opacity: '1', pointerEvents: 'auto' });
    try {
        const result = readSpaceChipGeometry(source, { selector, spaceId: 'work', point: { x: 60, y: 816 } });
        assert.equal(result.sourceIsCurrent, false); assert.equal(result.source.connected, false); assert.equal(result.current.connected, true);
        assert.deepEqual(result.source.rects, []); assert.deepEqual(result.current.rects, [rect]); assert.equal(result.pointHitsCurrent, true);
    } finally {
        if (oldDocument === undefined) delete globalThis.document; else globalThis.document = oldDocument;
        if (oldStyle === undefined) delete globalThis.getComputedStyle; else globalThis.getComputedStyle = oldStyle;
    }
});
test('Favorite lifecycle uses narrow chip helper only for Space switching and preserves native close', () => {
    const source = readSourceText(new URL('../../scripts/paired-chrome-ordinary-favorites.mjs', import.meta.url));
    assert.match(source, /await clickExactSpaceChip\(sidebar\.page, spaceId, observation =>\s*checkpoint\('space-chip-input', \{ sync, spaceId, \.\.\.observation \}\)\)/);
    assert.match(source, /await sidebar\.page\.click\(favoriteSelector\(favoriteId\)\)/);
    assert.equal((source.match(/nativeInput\.sendOneNativeClose\(probe\)/g) || []).length, 1);
});


test('paired hosted workflow watches the exact Space click helper and regression file', () => {
    const workflow = readSourceText(new URL('../../.github/workflows/paired-extension-smoke.yml', import.meta.url));
    const paths = workflow.split('    paths:\n')[1]?.split('\npermissions:')[0];
    assert(paths, 'The paired pull-request workflow must declare watched paths');
    for (const path of ['scripts/paired-chrome-space-click.mjs', 'tests/unit/paired-chrome-space-click.test.js']) {
        assert(paths.split('\n').some(line => line === `      - '${path}'`), `${path} must trigger paired hosted verification`);
    }
});
