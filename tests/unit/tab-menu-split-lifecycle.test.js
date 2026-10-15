import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

// Exercise production menu lifecycle only. No browser or native API is used.
test('Split menu releases its interaction gate exactly once for every exit', async t => {
    const previous = { document: globalThis.document, window: globalThis.window };
    const { document, window } = parseHTML('<html><body><div class="tab" tabindex="0"></div><button id="outside">Outside</button></body></html>');
    Object.assign(globalThis, { document, window });
    let focused = document.body;
    Object.defineProperty(document, 'activeElement', { get: () => focused });
    const oldFocus = window.HTMLElement.prototype.focus, oldRect = window.HTMLElement.prototype.getBoundingClientRect;
    window.HTMLElement.prototype.focus = function () { focused = this; };
    window.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 200, height: 100 });
    const { showTabContextMenu, closeTabContextMenu } = await import('../../domManager.js');
    try {
        const row = document.querySelector('.tab');
        const event = (node, type, extra = {}) => { const e = new window.Event(type, { bubbles: true, cancelable: true }); Object.assign(e, extra); node.dispatchEvent(e); };
        for (const exit of ['Enter', 'mouse', 'Escape', 'outside', 'superseding', 'removed', 'explicit']) await t.test(exit, async () => {
            let begins = 0, ends = 0, calls = 0;
            const open = () => showTabContextMenu(10, 10, { id: 11, url: 'https://fixture/left' }, false, false, row,
                () => {}, [], () => {}, () => {}, [], () => {}, null, null, { count: 2, save: () => {} }, null,
                { end: () => { calls++; }, keyboard: true, beginInteraction: () => { begins++; return () => { ends++; }; } });
            open();
            const item = document.querySelector('[data-action="endSplitView"]');
            assert.equal(document.activeElement, item); assert.equal(begins, 1); assert.equal(ends, 0);
            if (exit === 'Enter') event(item, 'keydown', { key: 'Enter' });
            if (exit === 'mouse') event(item, 'click');
            if (exit === 'Escape') event(item, 'keydown', { key: 'Escape' });
            if (exit === 'outside') event(document.getElementById('outside'), 'click');
            if (exit === 'explicit') closeTabContextMenu();
            if (exit === 'removed') { item.parentElement.remove(); await new Promise(resolve => setImmediate(resolve)); }
            if (exit === 'superseding') { open(); assert.equal(begins, 2); assert.equal(ends, 1); }
            else assert.equal(ends, 1);
            closeTabContextMenu(); closeTabContextMenu();
            assert.equal(ends, begins); assert.equal(calls, ['Enter', 'mouse'].includes(exit) ? 1 : 0);
            assert.equal(document.getElementById('tab-context-menu'), null);
        });
    } finally {
        closeTabContextMenu(); window.HTMLElement.prototype.focus = oldFocus; window.HTMLElement.prototype.getBoundingClientRect = oldRect;
        for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
    }
});
