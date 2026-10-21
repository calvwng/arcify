import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { readActionPromptGeometry, assertActionPromptGeometry, requireActionPromptGeometry, waitForActionSurfaceCompletion } from '../../scripts/paired-chrome-action-surface.mjs';
import { installNavigationInputObservation, assertNavigationInput, NAVIGATION_TITLES } from '../../scripts/paired-chrome-spotlight-navigation.mjs';
import { installTabCommandInputObservation, assertTabCommandInput } from '../../scripts/paired-chrome-spotlight-tabs.mjs';

const bounds = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height, visible: true, clientWidth: width, scrollWidth: width });
function geometry() {
    return { viewport: { width: 650, height: 350 }, prompt: bounds(16, 16, 618, 310), heading: bounds(32, 32, 586, 24), description: bounds(32, 64, 586, 48), control: bounds(32, 125, 586, 40), cancel: bounds(420, 275, 80, 32), confirm: bounds(510, 275, 108, 32) };
}
test('read-only geometry accepts a bounded prompt including wrapped long text', () => { assert.equal(assertActionPromptGeometry(geometry()).viewport.width, 650); });
for (const key of ['prompt', 'heading', 'description', 'control', 'cancel', 'confirm']) {
    for (const [name, alter] of Object.entries({ missing: value => value[key] = null, hidden: value => value[key].visible = false, zeroWidth: value => value[key].width = 0, nonfinite: value => value[key].right = NaN, rightClipped: value => value[key].right = 900, bottomClipped: value => value[key].bottom = 900, leftClipped: value => value[key].left = -10 })) {
        test(`geometry rejects ${key} ${name}`, () => { const value = geometry(); alter(value); assert.throws(() => assertActionPromptGeometry(value)); });
    }
}
for (const key of ['prompt', 'heading', 'description', 'error']) test(`geometry rejects horizontal overflow in ${key}`, () => {
    const value = geometry(); value.error = bounds(32, 190, 586, 40); value[key].scrollWidth += 50;
    assert.throws(() => assertActionPromptGeometry(value), /overflow horizontally/);
});
test('geometry rejects a control outside its prompt even inside the viewport', () => { const value = geometry(); value.control.left = 1; assert.throws(() => assertActionPromptGeometry(value), /inside its prompt/); });
test('geometry allows normal intrinsic option text without requiring an unbounded select', () => { const value = geometry(); value.control.scrollWidth = 4000; assertActionPromptGeometry(value); });
test('geometry poll only reads and waits for actual settled bounds', async () => {
    const clipped = geometry(); clipped.confirm.right = 900;
    const reads = [clipped, geometry()]; let count = 0;
    const surface = { async evaluate(fn, selector) { assert.equal(fn, readActionPromptGeometry); assert.equal(selector, '.prompt'); count++; return reads.shift(); } };
    const result = await requireActionPromptGeometry({ surface, selector: '.prompt', poll: async (read, accept, label) => {
        assert.match(label, /every confirmation control/); assert.equal(accept(await read()), false); const value = await read(); assert.equal(accept(value), true); return value;
    } });
    assert.equal(count, 2); assert.deepEqual(result, geometry());
});
test('geometry poll propagates read failures instead of treating a vanished prompt as usable', async () => {
    const error = new Error('frame detached');
    await assert.rejects(requireActionPromptGeometry({ surface: { evaluate: async () => { throw error; } }, selector: '.prompt', poll: async read => read() }), value => value === error);
});
test('browser geometry reader captures real bounds and nonempty error without mutation', () => {
    const expected = geometry(); expected.error = bounds(32, 190, 586, 40);
    const node = key => ({ ...expected[key], textContent: key === 'error' ? 'Choose a destination Space first.' : '', getBoundingClientRect: () => expected[key], getClientRects: () => [expected[key]] });
    const nodes = Object.fromEntries(['prompt', 'heading', 'description', 'control', 'cancel', 'confirm', 'error'].map(key => [key, node(key)]));
    nodes.prompt.getAttribute = name => ({ 'aria-labelledby': 'heading', 'aria-describedby': 'description' })[name];
    nodes.prompt.querySelector = selector => nodes[({ '[data-space-destination], [data-tab-action-input]': 'control', '[data-action-cancel]': 'cancel', '[data-action-confirm]': 'confirm', '[role="alert"]': 'error' })[selector]];
    const actual = runInNewContext(`(${readActionPromptGeometry})('.prompt')`, { document: { querySelector: () => nodes.prompt, getElementById: id => nodes[id] }, innerWidth: 650, innerHeight: 350, getComputedStyle: () => ({ visibility: 'visible', display: 'block' }) });
    assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected);
});
test('expected retired iframe requires the original source host to disappear without reading frame status', async () => {
    let waited = 0;
    const page = { async waitForFunction(fn, options) {
        waited++; assert.deepEqual(options, { polling: 50 });
        for (const host of [null, {}]) assert.equal(runInNewContext(`(${fn})()`, { document: { getElementById: id => { assert.equal(id, 'arcify-spotlight-host'); return host; } } }), host === null);
    } };
    const result = await waitForActionSurfaceCompletion({ page, surface: {}, retiresOverlay: true, waitStatus: () => assert.fail('retired frame must not be read') });
    assert.deepEqual(result, { surface: 'retired-overlay', hostRemoved: true }); assert.equal(waited, 1);
});
for (const [name, isPage, retiresOverlay] of [['retained overlay', false, false], ['newtab without activation', true, false], ['newtab with native activation', true, true]]) test(`${name} still requires real status`, async () => {
    const page = { waitForFunction: () => assert.fail('status cannot be replaced by a host-absence check') }; let status = 0;
    const result = await waitForActionSurfaceCompletion({ page, surface: isPage ? page : {}, retiresOverlay, waitStatus: async () => { status++; } });
    assert.equal(status, 1); assert.deepEqual(result, { surface: isPage ? 'newtab' : 'retained-overlay', statusObserved: true });
});
for (const retiresOverlay of [true, false]) test(`completion propagates ${retiresOverlay ? 'host-removal' : 'status'} failure without retry or fallback`, async () => {
    const error = new Error('frame detached or timed out'); let calls = 0;
    const fail = async () => { calls++; throw error; };
    await assert.rejects(waitForActionSurfaceCompletion({ page: { waitForFunction: fail }, surface: {}, retiresOverlay, waitStatus: fail }), value => value === error);
    assert.equal(calls, 1);
});
test('completion requires an explicit expected-retirement decision', async () => { await assert.rejects(waitForActionSurfaceCompletion({ page: {}, surface: {}, waitStatus: () => assert.fail() })); });

for (const [name, install, alias, controller, rowType, title, command, validate] of [
    ['navigation', installNavigationInputObservation, '__navigationInputEvents', '__navigationInput', 'arcify-space-action', NAVIGATION_TITLES.switchSpace, 'switchSpace', input => assertNavigationInput(input, 'switchSpace', { outcome: 'cancel', activation: 'click' })],
    ['tab command', installTabCommandInputObservation, '__tabCommandInputEvents', '__tabCommandInput', 'arcify-tab-action', 'Rename current tab', 'renameCurrentTab', input => assertTabCommandInput(input, 'renameCurrentTab', { tab: { section: 'today' } }, { outcome: 'cancel' })]
]) {
    test(`${name} passive records survive iframe retirement and retain actual trustedness`, () => {
        const listeners = new Map(), parent = {}, selected = { dataset: { resultType: rowType }, querySelector: () => ({ textContent: title }) };
        const document = { addEventListener(type, fn, capture) { assert.equal(capture, true); listeners.set(type, fn); }, removeEventListener(type, fn, capture) { assert.equal(listeners.get(type), fn); assert.equal(capture, true); listeners.delete(type); }, querySelector: () => selected };
        const scope = { document, parent };
        runInNewContext(`(${install})({retainInParent:true})`, scope);
        const target = { closest: () => null, matches: () => false, hasAttribute: () => false, dataset: {} };
        listeners.get('click')({ target, isTrusted: true, button: 0 });
        listeners.get('keydown')({ target: { ...target, closest: selector => selector.includes('prompt') ? {} : null, hasAttribute: key => key === 'data-action-cancel' }, isTrusted: false, key: 'Escape' });
        assert.equal(parent[alias], scope[alias]); assert.equal(parent[alias], scope[controller].events);
        assert.equal(parent[alias][0].trusted, true); assert.equal(parent[alias][1].trusted, false);
        assert.equal(parent[alias][0].title, title); assert.equal(parent[alias][0].resultType, rowType);
        const preserved = JSON.parse(JSON.stringify(parent[alias]));
        assert.throws(() => validate(preserved), /trusted|genuine/i);
        validate(preserved.map(record => ({ ...record, trusted: true }))); // Only unit fixtures alter trust; the real observer never does.
        scope[controller].stop(); delete scope[controller]; delete scope[alias];
        assert.equal(listeners.size, 0); assert.deepEqual(JSON.parse(JSON.stringify(parent[alias])), preserved);
        assert.equal(Object.keys(parent).length, 1); assert(Array.isArray(parent[alias]));
        assert(parent[alias].every(record => Object.values(record).every(value => typeof value !== 'object' || value === null)));
    });
    test(`${name} whole-page observation stays local by default`, () => {
        const parent = {}, scope = { parent, document: { addEventListener() {}, removeEventListener() {} } };
        runInNewContext(`(${install})()`, scope);
        assert.equal(parent[alias], undefined); assert.equal(scope[alias], scope[controller].events);
    });
}
test('completion and geometry helpers are import-safe and contain no action, browser, or DOM repair path', () => {
    const source = readFileSync(new URL('../../scripts/paired-chrome-action-surface.mjs', import.meta.url), 'utf8');
    assert(!/\.launch\(|\.click\(|\.press\(|dispatchEvent\(|\.style\.|setAttribute\(|\.remove\(|\.catch\(/.test(source));
});
