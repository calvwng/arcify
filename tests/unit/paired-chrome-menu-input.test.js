import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import { observeMenuOpenInput, finishMenuOpenInputObservation } from '../../scripts/paired-chrome-menu-input.mjs';
import { clickFreshResult } from '../../scripts/paired-chrome-ui.mjs';

function fixture() {
    const { document, window } = parseHTML('<html><head></head><body><div id="favoritesDropNotice" hidden><span id="favoritesDropStatus"></span></div><div class="folder" data-bookmark-id="13"><div class="folder-header">Fixture</div></div></body></html>');
    document.hasFocus = () => true;
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    const context = { document, window, MutationObserver: window.MutationObserver, performance: { now: () => 1 } };
    const selector = '.folder[data-bookmark-id="13"] > .folder-header';
    const target = document.querySelector(selector);
    target.getBoundingClientRect = () => ({ x: 8, y: document.getElementById('favoritesDropNotice').hidden ? 242 : 290, width: 1264, height: 32 });
    const start = () => runInNewContext(`(${observeMenuOpenInput.toString()})(${JSON.stringify({ selector, menuSelector: '#folder-context-menu' })})`, context);
    const finish = () => runInNewContext(`(${finishMenuOpenInputObservation.toString()})()`, context);
    const event = type => { const e = new window.Event(type, { bubbles: true }); Object.assign(e, { clientX: 640, clientY: 258, button: 2, isTrusted: false }); target.dispatchEvent(e); };
    return { document, target, context, start, finish, event };
}
test('passive observer records initial layout without changing the fixture', () => {
    const f = fixture(), before = f.document.toString(), state = f.start();
    assert.equal(f.document.toString(), before); assert.equal(state.state.bounds.y, 242);
    assert.equal(state.state.noticeHidden, true); assert.equal(state.events.length, 1);
    assert.equal(f.finish().state.menuCount, 0);
});
test('observer exposes a 48 px notice shift and real target metadata without synthesizing input', () => {
    const f = fixture(); f.start();
    f.document.getElementById('favoritesDropNotice').hidden = false;
    f.document.getElementById('favoritesDropStatus').textContent = 'Use the Arcify sidebar.';
    f.event('contextmenu'); const out = f.finish();
    assert.equal(out.state.bounds.y, 290); assert.equal(out.state.noticeText, 'Use the Arcify sidebar.');
    const e = out.events.find(x => x.type === 'contextmenu');
    assert.equal(e.target.bookmarkId, '13'); assert.equal(e.target.matchesRequested, true);
    assert.equal(e.trusted, false); assert.equal(e.x, 640); assert.equal(e.y, 258);
    assert(out.events.some(x => x.type === 'state-change'));
});
test('observer distinguishes a replaced exact row and a missing menu', () => {
    const f = fixture(); f.start(); const replacement = f.target.cloneNode(true);
    replacement.getBoundingClientRect = f.target.getBoundingClientRect; f.target.replaceWith(replacement);
    const out = f.finish(); assert.equal(out.state.sameTarget, false);
    assert.equal(out.state.originalConnected, false); assert.equal(out.state.targetPresent, true);
    assert.equal(out.state.menuCount, 0);
});
test('observer records menu creation and removal, remains bounded, and removes its listeners', () => {
    const f = fixture(); f.start(); const menu = f.document.createElement('div'); menu.id = 'folder-context-menu';
    f.document.body.append(menu); f.event('contextmenu'); menu.remove();
    for (let i = 0; i < 160; i++) f.event('mousedown');
    const observation = f.context.__pairedMenuOpenInput; const out = f.finish();
    assert.equal(out.events.length, 128); assert(out.events.some(x => x.menuCount === 1));
    f.event('mouseup'); assert.equal(observation.read().events.length, 128);
    assert.equal(f.context.__pairedMenuOpenInput, undefined); assert.equal(f.finish(), null);
});

const text = readFileSync(new URL('../../scripts/paired-chrome-tab-menu.mjs', import.meta.url), 'utf8');
const body = text.slice(text.indexOf('export async function openFreshTabMenu'), text.indexOf('/**\n * Parent must provide')).replace('export ', '');
const helper = runInNewContext(`(${body})`, { assert, clickFreshResult, observeMenuOpenInput, finishMenuOpenInputObservation });
for (const observed of [false, true]) test(`menu timeout stays strict and is never replayed, observation=${observed}`, async () => {
    const expected = new Error('menu postcondition timeout'); let clicks = 0, evaluations = 0; const records = [];
    const page = { async evaluate(fn) { evaluations++; return fn === finishMenuOpenInputObservation ? { events: [] } : undefined; },
        async waitForSelector(selector) { if (selector === '#folder-context-menu') throw expected;
            return { async click() { clicks++; }, async dispose() {} }; } };
    await assert.rejects(helper({ page, selector: '.folder-header', menuSelector: '#folder-context-menu', observe: observed, record: async value => records.push(value) }), error => error === expected);
    assert.equal(clicks, 1); assert.equal(evaluations, observed ? 2 : 0);
    assert.equal(records[0].status, 'clicked');
    if (observed) assert.equal(records[1].outcome, 'failed');
});
test('observation cleanup failure never replaces the original menu failure', async () => {
    const expected = new Error('original missing menu'); let clicks = 0; const records = [];
    const page = { async evaluate(fn) { if (fn === finishMenuOpenInputObservation) throw new Error('page closed'); },
        async waitForSelector(selector) { if (selector === '#folder-context-menu') throw expected;
            return { async click() { clicks++; }, async dispose() {} }; } };
    await assert.rejects(helper({ page, selector: '.folder-header', menuSelector: '#folder-context-menu', observe: true, record: async value => records.push(value) }), error => error === expected);
    assert.equal(clicks, 1); assert.equal(records[1].status, 'menu-input-observation-failed');
});

test('ordinary tab-menu opens retain passive gesture and row-lifecycle evidence, not only later probes', () => {
    assert.match(text, /openFreshTabMenu\(\{ page: sidebar\.page, selector, menuSelector: '#tab-context-menu', observe: true,\s*record: observation => checkpoint\('context-menu-input'/);
});
