import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseHTML } from 'linkedom';
import { createSidebarNewTabRow, placeNewTabRow } from '../../sidebar-new-tab.js';

const html = await readFile(new URL('../../sidebar.html', import.meta.url), 'utf8');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture() {
    const { document, window } = parseHTML(html), button = document.getElementById('newTabBtn'), status = document.getElementById('spotlightStatus');
    // These controller/focus cases represent the initialized, enabled sidebar.
    button.disabled = false;
    let focused = document.body, hasFocus = true;
    Object.defineProperty(document, 'activeElement', { get: () => focused });
    document.hasFocus = () => hasFocus;
    window.HTMLElement.prototype.focus = function (options) {
        if (!this.isConnected || this.disabled) return;
        for (let node = this; node; node = node.parentElement) if (node.hidden || node.style?.display === 'none') return;
        focused = this; this.focusOptions = options;
    };
    const space = id => {
        const element = document.getElementById('spaceTemplate').content.cloneNode(true).querySelector('.space');
        element.dataset.spaceId = id; document.getElementById('spacesList').append(element); return element;
    };
    const first = space('first'), empty = space('empty'), requests = [], response = deferred();
    const context = { windowId: 10, spaceId: 'first' };
    const controller = createSidebarNewTabRow({ button, status, getContext: () => context,
        sendRequest: request => { requests.push(request); return response.promise; } });
    return { document, window, button, status, first, empty, context, controller, requests, response,
        blur: () => { focused = document.body; hasFocus = false; }, setFocus: value => { focused = value; } };
}

test('one accessible native New Tab row replaces both footer actions and stays outside sortable Today rows', () => {
    const f = fixture();
    assert.equal(f.document.querySelectorAll('#newTabBtn').length, 1); assert.equal(f.document.getElementById('spotlightBtn'), null);
    assert.equal(f.button.tagName, 'BUTTON'); assert.equal(f.button.getAttribute('type'), 'button');
    assert.equal(f.button.getAttribute('aria-label'), 'New Tab'); assert.equal(f.button.getAttribute('draggable'), 'false');
    assert.equal(f.status.getAttribute('role'), 'status'); assert.equal(f.status.getAttribute('aria-live'), 'polite');
    for (const space of [f.first, f.empty, f.first]) {
        placeNewTabRow(f.button, space);
        assert.equal(space.querySelector('.temp-header').nextElementSibling, f.button);
        assert.equal(f.button.nextElementSibling, space.querySelector('[data-tab-type="temporary"]'));
        assert.equal(f.button.closest('.tabs-container'), null); assert.equal(f.button.matches('.tab, .folder'), false);
        assert.equal(f.document.querySelectorAll('#newTabBtn').length, 1);
        assert.equal(f.document.querySelector('.new-tab-btn-container button'), null);
    }
    assert(f.document.querySelector('.new-tab-btn-container').contains(f.status));
    assert(f.document.querySelector('.new-tab-btn-container').contains(f.document.getElementById('urlCopyToast')));
});

test('busy button keeps focus, coalesces clicks across movement and retains the captured context', async () => {
    const f = fixture(); placeNewTabRow(f.button, f.first); f.button.disabled = false; f.button.focus();
    const first = f.controller.launch(); assert.equal(f.controller.launch(), first);
    assert.equal(f.button.getAttribute('aria-busy'), 'true'); assert.equal(f.button.getAttribute('aria-disabled'), 'true');
    assert.equal(f.button.disabled, false); assert.equal(f.document.activeElement, f.button);
    placeNewTabRow(f.button, f.empty); f.context.spaceId = 'empty';
    f.button.dispatchEvent(new f.window.Event('click')); await Promise.resolve();
    assert.deepEqual(f.requests, [{ type: 'spotlightBridgeLaunch', windowId: 10, spaceId: 'first', fallbackToNewTab: true }]);
    f.response.resolve({ ok: true, outcome: 'spotlight' }); await first;
    assert.equal(f.status.textContent, 'Spotlight opened.'); assert.equal(f.button.getAttribute('aria-busy'), 'false');
    assert.equal(f.document.activeElement, f.button);
});

test('fallback status is announced without native creation in the UI', async () => {
    const f = fixture(); const pending = f.controller.launch(); f.response.resolve({ ok: true, outcome: 'new-tab', tabId: 42 }); await pending;
    assert.equal(f.status.textContent, 'Opened a new tab. Spotlight is unavailable.');
    assert.equal(f.requests.length, 1);
});

for (const result of ['reject', 'error', 'missing']) test(`${result} outcome never retries or performs UI fallback`, async () => {
    const f = fixture(); const pending = f.controller.launch();
    if (result === 'reject') f.response.reject(new Error('Response lost. Check your tabs.'));
    else f.response.resolve(result === 'error' ? { ok: false, error: { message: 'Spotlight may have opened. Check your tabs.' } } : undefined);
    await pending; assert.equal(f.requests.length, 1); assert.match(f.status.textContent, /Check your tabs/);
    assert.equal(f.button.getAttribute('aria-disabled'), 'false');
});

for (const context of [{ windowId: null, spaceId: 'first' }, { windowId: 10, spaceId: null }, { windowId: 10, spaceId: '' }]) test('uninitialized context cannot send or create a tab', async () => {
    const f = fixture(); Object.assign(f.context, context); await f.controller.launch();
    assert.equal(f.requests.length, 0); assert.match(f.status.textContent, /finish loading/);
});

test('moving the focused identity preserves focus but never steals it from an editor or after external blur', () => {
    const f = fixture(); placeNewTabRow(f.button, f.first); f.button.focus(); placeNewTabRow(f.button, f.empty);
    assert.equal(f.document.activeElement, f.button); assert.deepEqual(f.button.focusOptions, { preventScroll: true });
    const input = f.empty.querySelector('.space-name'); input.value = 'Unsubmitted draft'; input.focus();
    placeNewTabRow(f.button, f.first); assert.equal(f.document.activeElement, input); assert.equal(input.value, 'Unsubmitted draft');
    f.button.focus(); f.blur(); placeNewTabRow(f.button, f.empty, { restoreFocus: true });
    assert.equal(f.document.activeElement, f.document.body);
});

test('no keyboard interceptor consumes Ctrl+T or typed input', () => {
    const f = fixture();
    for (const target of [f.document.body, f.first.querySelector('.space-name')]) {
        const event = new f.window.Event('keydown', { bubbles: true, cancelable: true }); Object.assign(event, { key: 't', ctrlKey: true });
        target.dispatchEvent(event); assert.equal(event.defaultPrevented, false); assert.equal(f.requests.length, 0);
    }
});
