import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createSpaceSwitcher } from '../../space-switcher.js';
import { moveSpace, projectSpaceOrder } from '../../space-order.js';

function setup() {
    const { window, document } = parseHTML('<div id="switcher"></div><button id="outside"></button>');
    const container = document.getElementById('switcher');
    let spaces = ['Personal', 'GenAI', 'Finance'].map(id => ({ id, name: id }));
    const moves = [], activations = [], states = [], reports = [];
    const control = createSpaceSwitcher({ container, getSpaces: () => spaces, getActiveSpaceId: () => 'GenAI',
        activate: id => activations.push(id), onDragState: value => states.push(value), report: text => reports.push(text),
        move: async operation => { moves.push(operation); spaces = moveSpace(spaces, operation); control.render(); } });
    control.render();
    container.getBoundingClientRect = () => ({ left: 0, right: 400 });
    function buttons() { return [...container.querySelectorAll('button')]; }
    function event(target, type, extra = {}) {
        buttons().forEach((button, index) => { button.getBoundingClientRect = () => ({ left: index * 100, width: 80 }); });
        const e = new window.Event(type, { bubbles: true, cancelable: true });
        Object.assign(e, { clientX: 50, dataTransfer: { data: {}, setData(type, value) { this.data[type] = value; } }, ...extra });
        target.dispatchEvent(e); return e;
    }
    return { document, container, control, event, buttons, moves, activations, states, reports,
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
    f.event(target, 'drop', { clientX: 1 }); f.event(source, 'dragend'); await settle();
    assert.deepEqual(f.ids(), ['Finance', 'Personal', 'GenAI']);
    assert.deepEqual(f.moves, [{ spaceId: 'Finance', anchorSpaceId: 'Personal', position: 'before' }]);
    assert.deepEqual(f.states, [true, false]);
    assert.equal(f.container.querySelector('.active').dataset.spaceId, 'GenAI');
    assert.equal(f.container.querySelector('.space-drop-before'), null);
    assert.deepEqual(f.reports, ['Space order saved.']);
});

test('preview and gap/end drops use the same placement and self-drop does not move', async () => {
    const f = setup();
    const source = f.buttons()[0];
    f.event(source, 'dragstart'); f.event(f.container, 'dragover', { clientX: 395 });
    assert(f.buttons()[2].classList.contains('space-drop-after'));
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

test('refresh during drag defers replacing its source and stale moves do not resurrect deleted spaces', async () => {
    const f = setup(), source = f.buttons()[2];
    f.event(source, 'dragstart');
    f.setSpaces([{ id: 'Personal', name: 'Renamed' }, { id: 'GenAI', name: 'GenAI' }, { id: 'New', name: 'New' }]);
    f.control.render(); assert(source.isConnected);
    f.event(f.buttons()[0], 'drop', { clientX: 0 }); await settle();
    assert.deepEqual(f.ids(), ['Personal', 'GenAI', 'New']);
    assert.match(f.reports[0], /Could not reorder spaces.*deleted/);
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
    const { window, document } = parseHTML('<div id="switcher"></div><button id="outside"></button>');
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
