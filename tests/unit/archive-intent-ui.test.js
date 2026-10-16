import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';
import { createArchiveIntentConsumer, setArchivePopupOpen } from '../../archive-intent-ui.js';
const context = { windowId: 10, spaceId: 'source', bookmarkFolderId: 'folder', sourceTabId: 1, sourceUrl: 'https://source.test/', pairingGeneration: 'g' };
function fixture() {
    const { document } = parseHTML('<html><body><section class="space" data-space-id="source"><button class="sidebar-button"></button><div class="space-content">Today tabs</div><div class="archived-tabs-popup"><button>Restore</button></div></section></body></html>');
    const state = { ready: true, windowId: 10, spaceId: 'source', bookmarkFolderId: 'folder' }, calls = [], errors = [], listeners = [], hooks = {};
    let available = true;
    const api = { windows: { getCurrent: async () => ({ id: state.windowId }) }, runtime: { onMessage: { addListener: listener => listeners.push(listener), removeListener: listener => listeners.splice(listeners.indexOf(listener), 1) },
        async sendMessage(request) { calls.push(request); if (request.action === 'register') return { success: true, result: { registered: true } }; if (request.action === 'take') { if (!available) return { success: true, result: null }; available = false; return { success: true, result: { token: 'one', context } }; }
            await hooks.ack?.(); return hooks.badAck ? { success: false, error: 'Source changed' } : { success: true, result: { displayed: request.displayed } }; } } };
    const popup = document.querySelector('.archived-tabs-popup');
    const consumer = createArchiveIntentConsumer({ api, document, getState: () => state, showPopup: async () => { await hooks.render?.(); }, onError: error => errors.push(error) });
    const drain = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
    return { document, state, calls, errors, listeners, hooks, popup, consumer, drain };
}
test('only initialized matching sidebar renders existing popup and ACKs its visible state', async () => {
    const f = fixture(); f.consumer.start(); await f.drain();
    assert(f.popup.classList.contains('visible')); assert(f.document.querySelector('.space-content').classList.contains('hidden')); assert.equal(f.calls[2].action, 'ack'); assert.equal(f.calls[2].displayed, true);
    assert.equal(f.document.querySelector('.sidebar-button').getAttribute('aria-expanded'), 'true');
    f.listeners[0]({ type: 'arcifyArchiveAvailable', windowId: 10 }); await f.drain(); assert.equal(f.calls.filter(call => call.action === 'ack').length, 1);
});
for (const change of ['space', 'window', 'folder', 'hidden', 'detached', 'render-change', 'dispose']) test(`changed ${change} never acknowledges a visible popup`, async () => {
    const f = fixture();
    if (change === 'space') f.state.spaceId = 'other'; if (change === 'window') f.state.windowId = 20; if (change === 'folder') f.state.bookmarkFolderId = 'other';
    if (change === 'hidden') Object.defineProperty(f.document, 'visibilityState', { value: 'hidden' });
    if (change === 'detached') f.hooks.render = async () => f.popup.remove();
    if (change === 'render-change') f.hooks.render = async () => { f.state.spaceId = 'other'; };
    if (change === 'dispose') f.hooks.render = async () => f.consumer.dispose();
    f.consumer.start(); await f.drain();
    assert(!f.popup.classList.contains('visible')); assert(!f.calls.some(call => call.action === 'ack' && call.displayed));
});
test('negative authoritative ACK closes only newly opened popup and reports failure', async () => {
    const f = fixture(); f.hooks.badAck = true; f.consumer.start(); await f.drain();
    assert(!f.popup.classList.contains('visible')); assert(!f.document.querySelector('.space-content').classList.contains('hidden')); assert.equal(f.document.querySelector('.sidebar-button').getAttribute('aria-expanded'), 'false'); assert.equal(f.errors[0], 'Source changed');
    const old = fixture(); old.popup.classList.add('visible'); old.hooks.badAck = true; old.consumer.start(); await old.drain(); assert(old.popup.classList.contains('visible'));
});
test('uninitialized sidebar and cross-window hints cannot take an intent', async () => {
    const f = fixture(); f.state.ready = false; f.consumer.start(); await f.drain(); assert.equal(f.calls.length, 0);
    f.state.ready = true; f.listeners[0]({ type: 'arcifyArchiveAvailable', windowId: 20 }); await f.drain(); assert.equal(f.calls.length, 0);
    f.listeners[0]({ type: 'arcifyArchiveAvailable', windowId: 10 }); await f.drain(); assert.equal(f.calls.length, 3);
});

test('Spotlight open and native button close/reopen share explicit complete popup state', async () => {
    const f = fixture(); f.consumer.start(); await f.drain(); const space = f.document.querySelector('.space'), content = space.querySelector('.space-content');
    setArchivePopupOpen(space, !f.popup.classList.contains('visible'));
    assert(!f.popup.classList.contains('visible')); assert(!content.classList.contains('hidden')); assert.equal(space.querySelector('button').getAttribute('aria-expanded'), 'false');
    setArchivePopupOpen(space, !f.popup.classList.contains('visible'));
    assert(f.popup.classList.contains('visible')); assert(content.classList.contains('hidden')); assert.equal(space.querySelector('button').getAttribute('aria-expanded'), 'true');
});

for (const initiallyOpen of [false, true]) test(`actual sidebar Archive callback survives template insertion (${initiallyOpen ? 'already open' : 'closed'})`, () => {
    const { document, window } = parseHTML(readFileSync(new URL('../../sidebar.html', import.meta.url), 'utf8'));
    const source = readFileSync(new URL('../../sidebar.js', import.meta.url), 'utf8');
    const createStart = source.indexOf('function createSpaceElement(space) {');
    const start = source.indexOf("    const popup = spaceElement.querySelector('.archived-tabs-popup');", createStart);
    const end = source.indexOf('    // Add to DOM', start);
    assert(createStart >= 0 && start > createStart && end > start, 'Exercise the production native Archive callback, not a copied handler.');

    const template = document.getElementById('spaceTemplate');
    const spaceElement = template.content.cloneNode(true), spaceContainer = spaceElement.querySelector('.space');
    const otherElement = template.content.cloneNode(true), otherContainer = otherElement.querySelector('.space');
    spaceContainer.dataset.spaceId = 'source'; otherContainer.dataset.spaceId = 'other';
    const populated = [];
    const bind = new Function('spaceElement', 'spaceContainer', 'space', 'showArchivedTabsPopup', 'setArchivePopupOpen', source.slice(start, end));
    bind(spaceElement, spaceContainer, { id: 'source' }, id => populated.push(id), setArchivePopupOpen);

    // Appending the real template empties the fragment captured during setup.
    assert.equal(spaceElement.nodeType, 11);
    document.getElementById('spacesList').appendChild(spaceElement);
    document.getElementById('spacesList').appendChild(otherElement);
    assert.equal(spaceElement.childNodes.length, 0);
    assert.equal(spaceContainer.isConnected, true);
    const popup = spaceContainer.querySelector('.archived-tabs-popup'), content = spaceContainer.querySelector('.space-content');
    const button = spaceContainer.querySelector('.sidebar-button');
    if (initiallyOpen) setArchivePopupOpen(spaceContainer, true);

    for (const open of [!initiallyOpen, initiallyOpen, !initiallyOpen]) {
        assert.doesNotThrow(() => button.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true })));
        assert.equal(popup.classList.contains('visible'), open);
        assert.equal(content.classList.contains('hidden'), open);
        assert.equal(button.getAttribute('aria-expanded'), String(open));
        assert.equal(spaceContainer.querySelector('.archived-tabs-popup'), popup);
        assert.equal(otherContainer.querySelector('.archived-tabs-popup').classList.contains('visible'), false);
        assert.equal(otherContainer.querySelector('.space-content').classList.contains('hidden'), false);
        assert.equal(otherContainer.querySelector('.sidebar-button').getAttribute('aria-expanded'), 'false');
    }
    assert.deepEqual(populated, Array(initiallyOpen ? 1 : 2).fill('source'), 'Only opening populates the exact Space archive.');
});
