import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseHTML } from 'linkedom';
import { createSidebarDropFeedback } from '../../sidebar-drop-feedback.js';

function fixture() {
    const { document, window } = parseHTML('<body><div class="space-content"><div class="tabs-container"><div class="tab"><span class="tab-title-display">Target</span></div><div class="folder"><div class="folder-header"></div></div></div></div></body>');
    window.innerHeight = 600; window.innerWidth = 300;
    const scroll = document.querySelector('.space-content'), section = document.querySelector('.tabs-container'), row = document.querySelector('.tab');
    scroll.getBoundingClientRect = () => ({ top: 10, bottom: 400, left: 0, right: 300, height: 390 });
    let top = 60;
    row.getBoundingClientRect = () => ({ top, bottom: top + 30, left: 12, right: 280, height: 30 });
    scroll.scrollHeight = 1000; scroll.clientHeight = 390; scroll.scrollTop = 100;
    let callback, cancelled = 0, cleared = 0, frameId = 0;
    window.requestAnimationFrame = fn => { callback = fn; return ++frameId; };
    window.cancelAnimationFrame = () => { callback = null; cancelled++; };
    const folder = document.querySelector('.folder');
    let destination = { section, container: section, reference: row, placement: 'before' };
    const calls = [];
    const feedback = createSidebarDropFeedback({ document,
        resolve(point) { calls.push(point); return destination; }, onClear() { cleared++; } });
    const line = document.querySelector('.sidebar-drop-anchor');
    return { document, window, scroll, row, section, folder, line, feedback, calls,
        setTop: value => { top = value; }, setDestination: value => { destination = value; },
        update: (y = 60) => feedback.update({ target: row, clientX: 40, clientY: y }, section),
        tick: time => callback(time), counts: () => ({ cancelled, cleared }),
        event(type, props = {}, target = document) { const event = new window.Event(type, { bubbles: true }); Object.assign(event, props); target.dispatchEvent(event); } };
}

test('a single non-interactive overlay shows the resolved slot and announces changes', () => {
    const f = fixture(); f.update();
    assert.equal(f.line.hidden, false);
    assert.equal(f.line.getAttribute('aria-hidden'), 'true');
    assert.equal(f.line.dataset.placement, 'before');
    assert.equal(f.line.style.top, '60px');
    assert.equal(f.document.querySelector('.sidebar-drop-status').textContent, 'Move before Target');
    f.update(); assert.equal(f.document.querySelectorAll('.sidebar-drop-anchor').length, 1);
    f.feedback.clear();
});

test('inside folder highlight replaces the line and clears on invalid destination', () => {
    const f = fixture(); f.update();
    f.setDestination({ section: f.section, container: f.section, reference: f.folder, placement: 'inside' });
    f.update();
    assert.equal(f.line.hidden, true);
    assert(f.folder.firstElementChild.classList.contains('sidebar-drop-inside'));
    f.setDestination(null); f.update();
    assert.equal(f.folder.firstElementChild.classList.contains('sidebar-drop-inside'), false);
    assert.equal(f.document.querySelector('.sidebar-drop-status').textContent, '');
    f.feedback.clear();
});

for (const type of ['dragend', 'drop', 'keydown', 'dragleave', 'blur']) test(`${type} cancels feedback and any pending scroll frame`, () => {
    const f = fixture(); f.update();
    f.event(type, type === 'keydown' ? { key: 'Escape' } : type === 'dragleave' ? { relatedTarget: null } : {}, type === 'blur' ? f.window : f.document);
    assert.equal(f.line.hidden, true);
    assert.equal(f.counts().cancelled, 1);
    assert.equal(f.document.querySelector('.sidebar-drop-status').textContent, '');
});

test('internal dragleave does not clear, while captured scroll and resize recalculate from the current hit target', () => {
    const f = fixture(); f.update();
    f.event('dragleave', { relatedTarget: f.row });
    assert.equal(f.line.hidden, false);
    f.setTop(30);
    f.document.elementFromPoint = () => f.folder;
    f.event('scroll');
    assert.equal(f.line.style.top, '30px');
    assert.equal(f.calls.at(-1).target, f.folder);
    f.setTop(5); f.event('resize', {}, f.window);
    assert.equal(f.line.hidden, true, 'An offscreen slot cannot paint outside the scroller');
    f.feedback.clear();
});

test('edge autoscroll re-hit-tests a stationary pointer and stops on clear', () => {
    const f = fixture(); f.update(395); f.document.elementFromPoint = () => f.folder;
    f.tick(16);
    assert(f.scroll.scrollTop > 100);
    assert.equal(f.calls.at(-1).target, f.folder);
    f.feedback.clear();
    assert.equal(f.counts().cancelled, 1);
});

test('drop uses the same resolver at current coordinates and clears before returning', () => {
    const f = fixture(); const hovered = f.update();
    const dropped = f.feedback.drop({ target: f.row, clientX: 40, clientY: 60 }, f.section);
    assert.equal(dropped, hovered);
    assert.equal(f.line.hidden, true);
    assert.deepEqual(f.calls[0], f.calls[1]);
});

test('feedback styles preserve hit-testing, dark mode and forced-color contrast without motion', async () => {
    const css = await readFile(new URL('../../styles.css', import.meta.url), 'utf8');
    const anchor = css.match(/\.sidebar-drop-anchor \{([^}]+)\}/)[1];
    assert.match(anchor, /position: fixed/);
    assert.match(anchor, /pointer-events: none/);
    assert.doesNotMatch(anchor, /transition|animation/);
    assert.match(css, /prefers-color-scheme: dark/);
    assert.match(css, /forced-colors: active/);
});
