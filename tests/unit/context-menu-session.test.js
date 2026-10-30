import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createContextMenuSession } from '../../context-menu-session.js';

function fixture() {
    const { document, window } = parseHTML('<html><body><button id="outside">Outside</button></body></html>');
    const event = (target, type, options = {}) => target.dispatchEvent(new window.Event(type, options));
    const menu = () => { const node = document.createElement('div'); node.innerHTML = '<button>Action</button><input>'; return node; };
    return { document, window, event, menu };
}

for (const exit of ['blur', 'hidden', 'pagehide', 'pointerdown', 'click', 'contextmenu', 'Escape', 'superseding']) {
    test(`pending menu session cannot attach after ${exit}`, () => {
        const f = fixture(); let closed = 0;
        const session = createContextMenuSession(f.document); session.onClose(() => closed++);
        if (['blur', 'pagehide'].includes(exit)) f.event(f.window, exit);
        if (exit === 'hidden') {
            Object.defineProperty(f.document, 'visibilityState', { value: 'hidden' });
            f.event(f.document, 'visibilitychange');
        }
        if (['pointerdown', 'click', 'contextmenu'].includes(exit)) f.event(f.document.getElementById('outside'), exit, { bubbles: true });
        if (exit === 'Escape') {
            const event = new f.window.Event('keydown'); event.key = 'Escape'; f.document.dispatchEvent(event);
        }
        if (exit === 'superseding') createContextMenuSession(f.document).close();
        assert.equal(session.active, false); assert.equal(session.attach(f.menu()), false);
        session.close(); assert.equal(closed, 1);
    });
}

test('within-menu focus/pointer moves and visible visibilitychange keep the menu; removal cleans up once', async () => {
    const f = fixture(), menu = f.menu(); let closed = 0;
    const session = createContextMenuSession(f.document); session.onClose(() => closed++); session.attach(menu);
    f.event(menu.querySelector('input'), 'blur', { bubbles: true });
    f.event(menu.querySelector('button'), 'pointerdown', { bubbles: true });
    f.event(f.document, 'visibilitychange'); assert(session.active); assert(menu.isConnected);
    menu.remove(); await new Promise(resolve => setImmediate(resolve));
    assert(!session.active); assert.equal(closed, 1);
    f.event(f.window, 'blur'); assert.equal(closed, 1);
});

test('repeated menus release all listeners on close, replacement, and direct surface removal', async () => {
    const f = fixture(), originals = [], installed = [];
    for (const target of [f.document, f.window]) {
        const add = target.addEventListener, remove = target.removeEventListener;
        originals.push(() => { target.addEventListener = add; target.removeEventListener = remove; });
        target.addEventListener = function (type, callback, capture) { installed.push({ target, type, callback, capture }); return add.call(this, type, callback, capture); };
        target.removeEventListener = function (type, callback, capture) {
            const index = installed.findIndex(item => item.target === target && item.type === type && item.callback === callback && item.capture === capture);
            if (index >= 0) installed.splice(index, 1);
            return remove.call(this, type, callback, capture);
        };
    }
    try {
        for (let i = 0; i < 12; i++) {
            const session = createContextMenuSession(f.document), menu = f.menu(); session.attach(menu);
            assert.equal(installed.length, 7);
            if (i % 3 === 0) session.close();
            if (i % 3 === 1) createContextMenuSession(f.document).close();
            if (i % 3 === 2) { menu.remove(); await new Promise(resolve => setImmediate(resolve)); }
            assert.equal(installed.length, 0);
        }
    } finally { for (const restore of originals.reverse()) restore(); }
});
