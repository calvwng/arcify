import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';
import { createArchiveIntentConsumer, setArchivePopupOpen } from '../../archive-intent-ui.js';
import { fixture, own, context } from './helpers/archive-display-fixture.js';

async function uiFixture(t, options = {}) {
    const f = fixture(t, options);
    const { document, window } = parseHTML('<html><body><section class="space" data-space-id="source"><button class="sidebar-button"></button><div class="space-content">Today tabs</div><div class="archived-tabs-popup"><button>Restore</button></div></section></body></html>');
    window.top = window; window.location = { href: `chrome-extension://${own}/sidebar.html` };
    Object.defineProperty(document, 'visibilityState', { value: 'visible', writable: true, configurable: true });
    const state = { ready: true, windowId: 10, spaceId: 'source', bookmarkFolderId: 'source-folder', revision: 0 }, errors = [], hooks = {};
    const popup = document.querySelector('.archived-tabs-popup'), space = popup.closest('.space');
    let renders = 0, focuses = 0;
    popup.querySelector('button').focus = () => { focuses++; };
    const consumer = createArchiveIntentConsumer({ api: f.browser, document, getState: () => state,
        showPopup: async () => { renders++; await hooks.render?.(); }, onError: error => errors.push(error) });
    t.after(() => consumer.dispose());
    const scope = await f.prepare();
    const run = async () => { f.open(scope); await f.drain(); consumer.start(); await f.drain(); await f.drain(); };
    return { ...f, uiState: state, document, window, popup, space, consumer, errors, hooks, scope, run,
        get renders() { return renders; }, get focuses() { return focuses; },
        requests: () => f.state.messages.filter(item => item.direction === 'request').map(item => item.message) };
}
test('actual worker + renderer modules accept captured null documentId and ACK only the shared visible popup', async t => {
    const f = await uiFixture(t); await f.run();
    assert(f.popup.classList.contains('visible')); assert(f.space.querySelector('.space-content').classList.contains('hidden'));
    assert.equal(f.space.querySelector('.sidebar-button').getAttribute('aria-expanded'), 'true');
    assert.deepEqual(f.requests().map(message => message.action), ['register', 'take', 'validate', 'ack']);
    assert.equal(f.state.responses[0].displayed, true); assert.equal(f.focuses, 0); assert.equal(f.state.effects.length, 0);
    assert.equal(f.state.ports[0].worker.sender.documentId, null);
    f.browser.runtime.onMessage.emit({ type: 'arcifyArchiveAvailable', windowId: 10 }); await f.drain();
    assert.equal(f.requests().filter(message => message.action === 'ack').length, 1);
});
for (const kind of ['tab-hosted', 'iframe', 'wrong-page', 'query', 'offscreen', 'incognito', 'wrong-window', 'popup-window', 'unfocused'])
    test(`${kind} renderer cannot register or display even with own-extension API access`, async t => {
        const f = await uiFixture(t);
        if (kind === 'tab-hosted') f.state.rendererTab = { id: 30, windowId: 10 };
        if (kind === 'iframe') f.window.top = {};
        if (kind === 'wrong-page') f.window.location.href = f.browser.runtime.getURL('options.html');
        if (kind === 'query') f.window.location.href += '?native=1';
        if (kind === 'offscreen') f.document.visibilityState = 'hidden';
        if (kind === 'incognito') f.browser.extension.inIncognitoContext = true;
        if (kind === 'wrong-window') f.state.currentWindow = 20;
        if (kind === 'popup-window') f.state.windows.get(10).type = 'popup';
        if (kind === 'unfocused') f.state.windows.get(10).focused = false;
        await f.run();
        assert.equal(f.state.ports.length, 0); assert.equal(f.renders, 0); assert(!f.popup.classList.contains('visible'));
        assert(!f.state.responses.some(response => response.ok));
    });
for (const kind of ['space', 'folder', 'window', 'hidden', 'detached', 'dispose', 'same-space-new-revision', 'source-away-back'])
    test(`changed ${kind} during popup read never acknowledges display`, async t => {
        const f = await uiFixture(t);
        f.hooks.render = async () => {
            if (kind === 'space') f.uiState.spaceId = 'other'; if (kind === 'folder') f.uiState.bookmarkFolderId = 'other';
            if (kind === 'window') f.uiState.windowId = 20;
            if (kind === 'hidden') { f.document.visibilityState = 'hidden'; f.document.dispatchEvent(new f.window.Event('visibilitychange')); }
            if (kind === 'detached') f.popup.remove(); if (kind === 'dispose') f.consumer.dispose();
            if (kind === 'same-space-new-revision') { f.uiState.revision++; f.consumer.invalidate(); }
            if (kind === 'source-away-back') { f.browser.tabs.onUpdated.emit(1, { url: 'https://away.test/' }); f.browser.tabs.onUpdated.emit(1, { url: context.sourceUrl }); }
        };
        await f.run(); assert(!f.popup.classList.contains('visible'));
        assert(!f.requests().some(message => message.action === 'ack' && message.displayed));
        assert(!f.state.responses.some(response => response.ok)); assert.equal(f.focuses, 0);
    });
test('already-open popup is idempotent and retains its live focused controls on success', async t => {
    const f = await uiFixture(t), button = f.popup.querySelector('button'); setArchivePopupOpen(f.space, true);
    await f.run(); assert.equal(f.renders, 0); assert.equal(f.popup.querySelector('button'), button);
    assert(f.popup.classList.contains('visible')); assert.equal(f.state.responses[0].displayed, true); assert.equal(f.focuses, 0);
});
for (const initiallyOpen of [false, true]) test(`late rejected ACK preserves ${initiallyOpen ? 'existing' : 'newly owned'} popup ownership`, async t => {
    const f = await uiFixture(t); if (initiallyOpen) setArchivePopupOpen(f.space, true);
    f.state.contextRead = async () => { if ([...f.actions.intents.values()].some(intent => intent.phase === 'validated')) throw new Error('Source changed'); };
    await f.run(); assert.equal(f.popup.classList.contains('visible'), initiallyOpen);
    assert.equal(f.state.responses[0].ok, false); assert.equal(f.focuses, 0);
});
for (const kind of ['hide/show', 'revision away/back', 'newer manual close/reopen', 'newer input', 'detach', 'replace same Space', 'transient Space hide', 'detach/reinsert', 'replace content'])
    test(`${kind} while worker ACK read waits cancels externally and preserves newer UI`, async t => {
        const f = await uiFixture(t);
        f.state.contextRead = async () => {
            if (![...f.actions.intents.values()].some(intent => intent.phase === 'validated')) return;
            f.state.contextRead = null;
            if (kind === 'hide/show') { f.document.visibilityState = 'hidden'; f.document.dispatchEvent(new f.window.Event('visibilitychange')); f.document.visibilityState = 'visible'; }
            if (kind === 'revision away/back') { f.uiState.revision++; f.consumer.invalidate(); }
            if (kind === 'newer manual close/reopen') { setArchivePopupOpen(f.space, false); setArchivePopupOpen(f.space, true); }
            if (kind === 'newer input') f.document.dispatchEvent(new f.window.Event('pointerdown', { bubbles: true }));
            if (kind === 'detach') f.popup.remove();
            if (kind === 'replace same Space') f.space.replaceWith(f.space.cloneNode(true));
            if (kind === 'transient Space hide') { f.space.style.display = 'none'; f.space.style.display = ''; }
            if (kind === 'detach/reinsert') { f.popup.remove(); f.space.appendChild(f.popup); }
            if (kind === 'replace content') { const content = f.space.querySelector('.space-content'); content.replaceWith(content.cloneNode(true)); }
            await f.drain();
        };
        await f.run();
        assert(f.requests().some(message => message.action === 'cancel'), 'Local invalidation must reach the worker before pending ACK completes');
        assert.equal(f.state.responses[0].ok, false);
        assert.equal(f.popup.classList.contains('visible'), kind.startsWith('newer') || ['detach', 'replace same Space', 'transient Space hide', 'detach/reinsert', 'replace content'].includes(kind));
        assert.equal(f.focuses, 0); assert.equal(f.state.effects.length, 0);
    });

test('unchanged sidebar refresh class/style writes during ACK do not cancel current display', async t => {
    const f = await uiFixture(t);
    f.space.classList.add('active'); f.space.style.display = 'block';
    f.state.contextRead = async () => {
        if (![...f.actions.intents.values()].some(intent => intent.phase === 'validated')) return;
        f.state.contextRead = null;
        f.space.setAttribute('class', f.space.getAttribute('class'));
        f.space.setAttribute('style', f.space.getAttribute('style'));
        f.popup.setAttribute('class', f.popup.getAttribute('class'));
        await f.drain();
    };
    await f.run();
    assert.equal(f.state.responses[0].displayed, true); assert(f.popup.classList.contains('visible'));
    assert(!f.requests().some(message => message.action === 'cancel')); assert.equal(f.focuses, 0);
});
test('newer input while take is awaiting source read wins over the late delivery', async t => {
    const f = await uiFixture(t);
    f.state.contextRead = async () => { f.state.contextRead = null; f.document.dispatchEvent(new f.window.Event('keydown', { bubbles: true })); };
    await f.run(); assert.equal(f.renders, 0); assert(!f.popup.classList.contains('visible'));
    assert.equal(f.state.responses[0].ok, false);
});
test('already-running eligible panel consumes a fresh command without another onOpened receipt', async t => {
    const f = await uiFixture(t); f.state.skipOpened = true;
    f.consumer.start(); await f.drain(); assert.equal(f.requests().at(-1).action, 'take');
    f.open(f.scope); await f.drain(); assert.equal(f.state.responses[0].displayed, true); assert.equal(f.actions.openedWindows.size, 0);
});
test('Port loss during render burns invocation; fresh user command reconnects with a new session', async t => {
    const f = await uiFixture(t); let oldSession;
    f.hooks.render = async () => { oldSession = [...f.actions.panels][0].session; f.state.ports[0].client.disconnect(); await f.drain(); };
    await f.run(); assert.equal(f.state.responses[0].ok, false); assert(!f.popup.classList.contains('visible'));
    f.hooks.render = null;
    const fresh = await f.prepare(); f.open(fresh); await f.drain();
    assert.equal(f.state.responses[1].displayed, true); assert.notEqual([...f.actions.panels][0].session, oldSession);
    assert.equal(f.state.opened.length, 2); assert.equal(f.state.effects.length, 0);
});
test('uninitialized sidebar and cross-window hint do not connect or claim', async t => {
    const f = await uiFixture(t); f.uiState.ready = false; f.consumer.start(); await f.drain(); assert.equal(f.state.ports.length, 0);
    f.uiState.ready = true; f.browser.runtime.onMessage.emit({ type: 'arcifyArchiveAvailable', windowId: 20 }); await f.drain(); assert.equal(f.state.ports.length, 0);
    f.open(f.scope); await f.drain(); assert.equal(f.state.responses[0].displayed, true);
});
test('native button close/reopen retains explicit shared popup state after Spotlight display', async t => {
    const f = await uiFixture(t); await f.run();
    setArchivePopupOpen(f.space, false); assert(!f.popup.classList.contains('visible')); assert(!f.space.querySelector('.space-content').classList.contains('hidden'));
    setArchivePopupOpen(f.space, true); assert(f.popup.classList.contains('visible')); assert.equal(f.space.querySelector('.sidebar-button').getAttribute('aria-expanded'), 'true');
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
