import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseHTML } from 'linkedom';
import { createSpaceSwitcher } from '../../space-switcher.js';
import { moveSpace, projectSpaceOrder } from '../../space-order.js';

function setup() {
    const { window, document } = parseHTML('<html><body><div id="switcher"></div><button id="outside"></button></body></html>');
    window.innerWidth = 400; window.innerHeight = 800;
    const container = document.getElementById('switcher');
    container.scrollLeft = 0; container.scrollWidth = 400; container.clientWidth = 400;
    const frames = new Map(); let nextFrame = 0;
    window.requestAnimationFrame = callback => { frames.set(++nextFrame, callback); return nextFrame; };
    window.cancelAnimationFrame = id => frames.delete(id);
    let spaces = ['Personal', 'GenAI', 'Finance'].map(id => ({ id, name: id }));
    const moves = [], activations = [], states = [], reports = [];
    const control = createSpaceSwitcher({ container, getSpaces: () => spaces, getActiveSpaceId: () => 'GenAI',
        activate: id => activations.push(id), onDragState: value => states.push(value), report: text => reports.push(text),
        move: async operation => { moves.push(operation); spaces = moveSpace(spaces, operation); control.render(); } });
    control.render();
    container.getBoundingClientRect = () => ({ left: 0, right: container.clientWidth, width: container.clientWidth, top: 492, bottom: 536, height: 44 });
    function buttons() { return [...container.querySelectorAll('button')]; }
    function event(target, type, extra = {}) {
        buttons().forEach((button, index) => { button.getBoundingClientRect = () => ({ left: 8 + index * 100 - container.scrollLeft, right: 88 + index * 100 - container.scrollLeft, width: 80, top: 500, bottom: 532, height: 32 }); });
        const e = new window.Event(type, { bubbles: true, cancelable: true });
        Object.assign(e, { clientX: 50, clientY: 516, dataTransfer: { data: {}, setData(type, value) { this.data[type] = value; } }, ...extra });
        target.dispatchEvent(e); return e;
    }
    return { window, document, container, control, event, buttons, moves, activations, states, reports, frames,
        line: document.querySelector('.space-drop-anchor'),
        tick(time) { const [id, callback] = frames.entries().next().value; frames.delete(id); callback(time); },
        ids: () => buttons().map(button => button.dataset.spaceId), setSpaces: next => { spaces = next; } };
}
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };

test('real switcher controller renders stable IDs and saves exactly one move after repeated renders', async () => {
    const f = setup();
    for (let i = 0; i < 6; i++) f.control.render();
    const source = f.buttons()[2], target = f.buttons()[0];
    const started = f.event(source, 'dragstart');
    assert.equal(started.dataTransfer.data['application/x-arcify-space'], 'Finance');
    assert.equal(source.classList.contains('dragging-switcher'), true);
    const over = f.event(target, 'dragover', { clientX: 1 });
    assert(over.defaultPrevented); assert(target.classList.contains('space-drop-before'));
    assert.equal(f.line.hidden, false);
    assert.equal(f.line.dataset.sourceSpaceId, 'Finance');
    assert.equal(f.line.dataset.anchorSpaceId, 'Personal');
    assert.equal(f.line.dataset.placement, 'before');
    assert.equal(f.line.style.left, '4px');
    assert.equal(f.line.style.top, '498px');
    assert.equal(f.line.style.height, '36px');
    f.event(target, 'drop', { clientX: 1 }); f.event(source, 'dragend'); await settle();
    assert.deepEqual(f.ids(), ['Finance', 'Personal', 'GenAI']);
    assert.deepEqual(f.moves, [{ spaceId: 'Finance', anchorSpaceId: 'Personal', position: 'before' }]);
    assert.deepEqual(f.states, [true, false]);
    assert.equal(f.container.querySelector('.active').dataset.spaceId, 'GenAI');
    assert.equal(f.container.querySelector('.space-drop-before'), null);
    assert.equal(f.line.hidden, true);
    assert.equal(f.line.dataset.placement, undefined);
    assert.equal(f.frames.size, 0);
    assert.deepEqual(f.reports, ['Space order saved.']);
});

test('preview and gap/end drops use the same placement and self-drop does not move', async () => {
    const f = setup();
    const source = f.buttons()[0];
    f.event(source, 'dragstart'); f.event(f.container, 'dragover', { clientX: 395 });
    assert(f.buttons()[2].classList.contains('space-drop-after'));
    assert.equal(f.line.hidden, false);
    assert.equal(f.line.dataset.placement, 'after');
    assert.equal(f.line.style.left, '292px');
    f.event(f.container, 'drop', { clientX: 395 }); await settle();
    assert.deepEqual(f.ids(), ['GenAI', 'Finance', 'Personal']);
    const middle = f.buttons()[1];
    f.event(middle, 'dragstart'); f.event(middle, 'drop', { clientX: 180 }); await settle();
    assert.equal(f.moves.length, 1); assert.deepEqual(f.ids(), ['GenAI', 'Finance', 'Personal']);
});

test('external drags are ignored and Escape or an outside dragend clears drag state without saving', () => {
    const f = setup();
    assert.equal(f.event(f.container, 'dragover').defaultPrevented, false);
    assert.equal(f.event(f.container, 'drop').defaultPrevented, false);
    const source = f.buttons()[0];
    f.event(source, 'dragstart'); f.event(f.buttons()[2], 'dragover', { clientX: 300 });
    f.event(f.document, 'keydown', { key: 'Escape' });
    assert.equal(f.container.querySelector('.dragging-switcher'), null);
    f.event(source, 'dragstart'); f.event(f.document.getElementById('outside'), 'dragend');
    assert.deepEqual(f.states, [true, false, true, false]); assert.deepEqual(f.moves, []);
});

test('refresh during drag defers replacing its source and rejects known-deleted sources without a marker or save', async () => {
    const f = setup(), source = f.buttons()[2];
    f.event(source, 'dragstart');
    f.setSpaces([{ id: 'Personal', name: 'Renamed' }, { id: 'GenAI', name: 'GenAI' }, { id: 'New', name: 'New' }]);
    f.control.render(); assert(source.isConnected);
    f.event(f.buttons()[0], 'drop', { clientX: 0 }); await settle();
    assert.deepEqual(f.ids(), ['Personal', 'GenAI', 'New']);
    assert.equal(f.line.hidden, true);
    assert.deepEqual(f.moves, []);
    assert.deepEqual(f.reports, []);
});

test('keyboard reorders one neighbor without changing selection or wrapping and exposes a shortcut', async () => {
    const f = setup(); const source = f.buttons()[1];
    assert.match(source.getAttribute('aria-keyshortcuts'), /Alt\+Shift\+ArrowLeft/);
    f.event(source, 'keydown', { key: 'ArrowLeft', altKey: true, shiftKey: true }); await settle();
    assert.deepEqual(f.ids(), ['GenAI', 'Personal', 'Finance']);
    assert.equal(f.container.querySelector('.active').dataset.spaceId, 'GenAI');
    f.event(f.buttons()[0], 'keydown', { key: 'ArrowLeft', altKey: true, shiftKey: true }); await settle();
    assert.equal(f.moves.length, 1); assert.deepEqual(f.activations, []);
    f.event(f.buttons()[0], 'keydown', { key: 'ArrowRight', altKey: true, shiftKey: true }); await settle();
    assert.deepEqual(f.ids(), ['Personal', 'GenAI', 'Finance']);
});


test('projected authoritative order retains current objects and local-only slots without replaying metadata', () => {
    const current = [{ id: 'a', name: 'Editing' }, { id: 'local' }, { id: 'b' }, { id: 'c' }];
    const saved = [{ id: 'c' }, { id: 'remote' }, { id: 'a', name: 'Old' }, { id: 'b' }];
    const projected = projectSpaceOrder(current, saved);
    assert.deepEqual(projected.map(space => space.id), ['c', 'local', 'a', 'b']);
    assert.equal(projected[2], current[0]); assert.equal(projected[2].name, 'Editing');
});

test('render restores chip focus only while the chip still owns focus', async () => {
    const { window, document } = parseHTML('<html><body><div id="switcher"></div><button id="outside"></button></body></html>');
    let active = null;
    Object.defineProperty(document, 'activeElement', { get: () => active });
    window.HTMLElement.prototype.focus = function () { active = this; };
    let spaces = ['a', 'b', 'c'].map(id => ({ id, name: id }));
    let release;
    const container = document.getElementById('switcher');
    const control = createSpaceSwitcher({ container, getSpaces: () => spaces, getActiveSpaceId: () => 'a', activate() {},
        async move(operation) { await new Promise(resolve => { release = resolve; }); spaces = moveSpace(spaces, operation); control.render(); } });
    control.render();
    const key = target => {
        const event = new window.Event('keydown', { bubbles: true, cancelable: true });
        Object.assign(event, { key: 'ArrowRight', altKey: true, shiftKey: true }); target.dispatchEvent(event);
    };
    container.firstElementChild.focus(); key(container.firstElementChild);
    release(); await settle(); await settle();
    assert.equal(active.dataset.spaceId, 'a'); assert(active.isConnected);
    key(active); document.getElementById('outside').focus(); release(); await settle(); await settle();
    assert.equal(active.id, 'outside');
});

test('immediate repeated keyboard moves use acknowledged order before an external refresh arrives', async () => {
    const f = setup();
    f.event(f.buttons()[0], 'keydown', { key: 'ArrowRight', altKey: true, shiftKey: true }); await settle();
    f.event(f.buttons()[1], 'keydown', { key: 'ArrowRight', altKey: true, shiftKey: true }); await settle();
    assert.deepEqual(f.ids(), ['GenAI', 'Finance', 'Personal']);
    assert.deepEqual(f.moves.map(move => move.anchorSpaceId), ['GenAI', 'Finance']);
});

test('one non-interactive overlay survives repeated renders without changing chip geometry or order', () => {
    const f = setup();
    const source = f.buttons()[2], target = f.buttons()[0];
    f.event(source, 'dragstart');
    const before = f.buttons().map(button => button.getBoundingClientRect());
    f.event(target, 'dragover', { clientX: 10 });
    for (let i = 0; i < 5; i++) f.control.render();
    assert.equal(f.document.querySelectorAll('.space-drop-anchor').length, 1);
    assert.equal(f.line.parentElement, f.document.body);
    assert.equal(f.line.getAttribute('aria-hidden'), 'true');
    assert.equal(f.line.hasAttribute('tabindex'), false);
    assert.equal(f.container.contains(f.line), false);
    assert.equal(f.line.hidden, false);
    assert.deepEqual(f.buttons().map(button => button.getBoundingClientRect()), before);
    assert.deepEqual(f.ids(), ['Personal', 'GenAI', 'Finance']);
    f.event(source, 'dragend');
    assert.equal(f.line.hidden, true);
});

test('both source halves, adjacent no-op slots and one remaining Space never advertise or save a move', async () => {
    for (const [sourceIndex, targetIndex, clientX] of [[1, 1, 110], [1, 1, 185], [0, 1, 110], [1, 2, 210], [2, null, 395]]) {
        const f = setup(), source = f.buttons()[sourceIndex], target = f.buttons()[targetIndex] || f.container;
        f.event(source, 'dragstart');
        const over = f.event(target, 'dragover', { clientX });
        assert.equal(f.line.hidden, true);
        assert.equal(over.dataTransfer.dropEffect, 'none');
        f.event(target, 'drop', { clientX }); await settle();
        assert.deepEqual(f.moves, []);
        assert.deepEqual(f.ids(), ['Personal', 'GenAI', 'Finance']);
    }
    const f = setup(); f.setSpaces([{ id: 'Personal', name: 'Personal' }]); f.control.render();
    f.event(f.buttons()[0], 'dragstart'); f.event(f.container, 'dragover', { clientX: 395 });
    assert.equal(f.line.hidden, true);
    f.event(f.container, 'drop', { clientX: 395 }); await settle();
    assert.deepEqual(f.moves, []);
});

test('invalid, removed and external sources or anchors clear the marker without a write', async () => {
    const f = setup();
    const source = f.buttons()[2], target = f.buttons()[0];
    f.event(source, 'dragstart'); f.event(target, 'dragover', { clientX: 10 });
    assert.equal(f.line.hidden, false);
    f.event(target, 'dragover', { clientX: NaN });
    assert.equal(f.line.hidden, true);
    f.event(target, 'dragover', { clientX: 10 });
    f.setSpaces([{ id: 'GenAI', name: 'GenAI' }, { id: 'Finance', name: 'Finance' }]); f.control.render();
    assert.equal(f.line.hidden, true, 'A known-deleted anchor is no longer a target');
    f.event(target, 'drop', { clientX: 10 }); await settle();
    assert.deepEqual(f.moves, []);
    const external = f.event(f.container, 'dragover', { dataTransfer: { types: ['application/x-arcify-space'], dropEffect: 'none' } });
    assert.equal(external.defaultPrevented, false);
    assert.equal(f.line.hidden, true);
    const invalidStart = f.event(f.container, 'dragstart');
    assert.equal(invalidStart.defaultPrevented, true);
    assert.deepEqual(f.states, [true, false]);
});

test('scroll and resize re-resolve the exact visible boundary beneath a stationary pointer', async () => {
    const f = setup(), source = f.buttons()[2], first = f.buttons()[0];
    f.event(source, 'dragstart'); f.event(first, 'dragover', { clientX: 10 });
    assert.equal(f.line.style.left, '4px');
    f.document.elementFromPoint = () => f.container;
    f.container.scrollLeft = 50;
    f.event(f.container, 'scroll');
    assert.equal(f.line.hidden, false);
    assert.equal(f.line.dataset.anchorSpaceId, 'GenAI');
    assert.equal(f.line.style.left, '54px');
    const expected = { spaceId: f.line.dataset.sourceSpaceId, anchorSpaceId: f.line.dataset.anchorSpaceId, position: f.line.dataset.placement };
    f.event(f.container, 'drop', { clientX: 10 }); await settle();
    assert.deepEqual(f.moves, [expected]);

    const g = setup();
    g.event(g.buttons()[0], 'dragstart'); g.event(g.container, 'dragover', { clientX: 395 });
    assert.equal(g.line.hidden, false);
    g.container.clientWidth = 280; g.event(g.window, 'resize');
    assert.equal(g.line.hidden, true, 'Offscreen boundaries must not clamp to a misleading visible slot');
    g.container.clientWidth = 400; g.event(g.window, 'resize');
    assert.equal(g.line.hidden, false);
    g.event(g.document, 'keydown', { key: 'Escape' });
});

test('edge autoscroll refreshes operation-aligned geometry and cancels every scheduled frame on leave', () => {
    const f = setup(); f.container.clientWidth = 180; f.container.scrollWidth = 400;
    f.event(f.buttons()[0], 'dragstart'); f.event(f.container, 'dragover', { clientX: 170 });
    f.document.elementFromPoint = () => f.container;
    assert.equal(f.line.hidden, true, 'The next insertion boundary starts outside the viewport');
    for (let i = 1; i <= 6; i++) f.tick(i * 16);
    assert(f.container.scrollLeft > 0);
    assert.equal(f.line.hidden, false);
    const anchor = f.buttons().find(button => button.dataset.spaceId === f.line.dataset.anchorSpaceId).getBoundingClientRect();
    assert.equal(Number.parseFloat(f.line.style.left), f.line.dataset.placement === 'before' ? anchor.left - 4 : anchor.right + 4);
    f.event(f.container, 'dragleave', { relatedTarget: f.document.getElementById('outside') });
    assert.equal(f.line.hidden, true);
    assert.equal(f.frames.size, 0);
    assert.deepEqual(f.moves, []);
    f.event(f.document, 'dragend');
});

for (const type of ['dragend', 'drop', 'keydown', 'blur']) test(`${type} clears the marker, metadata and scroll frames, including repeated cleanup`, () => {
    const f = setup(); f.event(f.buttons()[2], 'dragstart'); f.event(f.buttons()[0], 'dragover', { clientX: 10 });
    assert.equal(f.line.hidden, false);
    const target = type === 'blur' ? f.window : type === 'drop' ? f.document.getElementById('outside') : f.document;
    f.event(target, type, type === 'keydown' ? { key: 'Escape' } : {});
    f.event(f.document, 'dragend');
    assert.equal(f.line.hidden, true);
    assert.equal(f.line.dataset.anchorSpaceId, undefined);
    assert.equal(f.frames.size, 0);
    assert.equal(f.container.querySelector('.space-drop-before, .space-drop-after, .dragging-switcher'), null);
    assert.deepEqual(f.states, [true, false]);
    assert.deepEqual(f.moves, []);
});

test('internal dragleave keeps feedback, while a document exit clears it until re-entry', () => {
    const f = setup(), source = f.buttons()[2], target = f.buttons()[0];
    f.event(source, 'dragstart'); f.event(target, 'dragover', { clientX: 10 });
    f.event(target, 'dragleave', { relatedTarget: f.buttons()[1] });
    assert.equal(f.line.hidden, false);
    f.event(f.document, 'dragleave', { relatedTarget: null });
    assert.equal(f.line.hidden, true); assert.equal(f.frames.size, 0);
    f.event(target, 'dragover', { clientX: 10 });
    assert.equal(f.line.hidden, false);
    f.event(source, 'dragend');
});

test('line styles keep a visible independent paint surface with dark/forced-color support and no motion', async () => {
    const css = await readFile(new URL('../../styles.css', import.meta.url), 'utf8');
    const style = css.match(/\.space-drop-anchor \{([^}]+)\}/)[1];
    assert.match(style, /position: fixed/);
    assert.match(style, /pointer-events: none/);
    assert.match(style, /width: 3px/);
    assert.match(style, /background: var\(--sidebar-drop-color, #2563eb\)/);
    assert.doesNotMatch(style, /transition|animation/);
    assert.match(css, /\.space-drop-anchor\[hidden\] \{ display: none; \}/);
    const theme = await readFile(new URL('../../sidebar-theme.js', import.meta.url), 'utf8');
    assert.match(theme, /prefers-color-scheme: dark/);
    assert.match(theme, /'--sidebar-drop-color': theme.marker/);
    assert.match(css, /\.space-drop-anchor \{\s*background: Highlight;[^}]*forced-color-adjust: none/);
});

test('icon-only setting retains full emoji, name tooltips, stable drag/keyboard targets and iconless fallbacks', async () => {
    const f = setup();
    f.setSpaces([{ id: 'Personal', name: 'My family', icon: '👨‍👩‍👧‍👦' }, { id: 'GenAI', name: 'Research', icon: '🇭🇰' }, { id: 'Finance', name: 'Budget' }]);
    f.control.render();
    const nodes = f.buttons();
    for (const hide of [true, false, true]) {
        f.document.documentElement.dataset.hideSpaceNames = String(hide);
        assert.deepEqual(f.buttons(), nodes);
        assert.equal(nodes[0].querySelector('.space-icon').textContent, '👨‍👩‍👧‍👦');
        assert.equal(nodes[0].querySelector('.space-switcher-name').textContent, 'My family');
        assert.match(nodes[0].title, /^My family\n/); assert.equal(nodes[0].getAttribute('aria-label'), 'Switch to space My family');
        assert.equal(nodes[2].querySelector('.space-icon-fallback').getAttribute('aria-hidden'), 'true');
        assert.equal(nodes[2].draggable, true);
    }
    f.event(nodes[0].querySelector('.space-icon'), 'click', { detail: 0, button: 0 });
    assert.deepEqual(f.activations, ['Personal']);
    f.event(nodes[2].querySelector('.space-icon-fallback'), 'dragstart');
    f.event(nodes[0].querySelector('.space-icon'), 'dragover', { clientX: 1 });
    f.control.refresh();
    assert.equal(f.line.dataset.anchorSpaceId, 'Personal'); assert.equal(f.line.dataset.sourceSpaceId, 'Finance');
    f.event(nodes[0].querySelector('.space-icon'), 'drop', { clientX: 1 }); await settle();
    assert.deepEqual(f.moves[0], { spaceId: 'Finance', anchorSpaceId: 'Personal', position: 'before' });
    f.event(f.buttons()[0], 'keydown', { key: 'ArrowRight', altKey: true, shiftKey: true }); await settle();
    assert.deepEqual(f.moves[1], { spaceId: 'Finance', anchorSpaceId: 'Personal', position: 'after' });
});

test('appearance geometry refresh retargets the live marker without replacing drag nodes or changing IDs', () => {
    const f = setup(), nodes = f.buttons();
    f.event(nodes[2], 'dragstart'); f.event(nodes[1], 'dragover', { clientX: 110 });
    assert.equal(f.line.dataset.anchorSpaceId, 'GenAI'); assert.equal(f.line.dataset.placement, 'before');
    nodes.forEach((node, index) => { node.getBoundingClientRect = () => ({ left: 8 + index * 40, right: 40 + index * 40, width: 32, top: 500, bottom: 532, height: 32 }); });
    f.document.elementFromPoint = () => nodes[2];
    f.control.refresh();
    assert.equal(f.line.hidden, true); // Pointer now hits its source, a no-op.
    assert.deepEqual(f.buttons(), nodes); assert.equal(nodes[2].classList.contains('dragging-switcher'), true);
    assert.deepEqual(f.moves, []); f.event(nodes[2], 'dragend');
});
