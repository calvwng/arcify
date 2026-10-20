import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';

const html = readFileSync(new URL('../../transient-window.html', import.meta.url), 'utf8');
const source = readFileSync(new URL('../../transient-window.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const data = () => ({ success: true, record: { token: 'token', phase: 'ready', windowId: 20, originWindowId: 10, tabId: 7 },
    page: { id: 7, windowId: 20, title: '<img src=x onerror=alert(1)>', url: 'https://example.test/' },
    windows: [{ id: 10, origin: true, title: 'Original' }, { id: 30, origin: false, title: 'Other' }],
    spaces: [{ id: 'work', name: 'Work', bookmarkFolderId: 'folder' }] });
const orphanData = () => { const context = data(); context.record.phase = 'orphan'; context.record.tabId = null;
    context.record.originWindowId = null; context.page = null; context.windows.forEach(window => { window.origin = false; });
    context.recoveryTabs = [7, 8].map(id => ({ id, windowId: 20, title: `Restored page ${id}`, url: 'https://same.test/' })); return context; };
async function fixture({ context = data(), send } = {}) {
    const { window, document } = parseHTML(html), calls = [], timers = new Map(); let nextTimer = 1;
    const handler = send || (async request => request.action === 'context' ? context : { success: true, phase: 'committed' });
    const globals = { document, location: { href: 'chrome-extension://own/transient-window.html?token=token' }, URL,
        chrome: { runtime: { sendMessage: async request => { calls.push(request); return handler(request); } } },
        setTimeout: callback => { const id = nextTimer++; timers.set(id, callback); return id; }, clearTimeout: id => timers.delete(id) };
    vm.runInNewContext(source, globals); await tick();
    const node = id => document.getElementById(id);
    const emit = (element, type, trusted = true) => {
        const event = new window.Event(type, { cancelable: true, bubbles: true }); Object.defineProperty(event, 'isTrusted', { value: trusted }); element.dispatchEvent(event);
    };
    const select = (id, value) => { const options = [...node(id).querySelectorAll('option')];
        for (const option of options) option.selected = false;
        const chosen = options.find(option => option.value === value); if (chosen) chosen.selected = true;
        emit(node(id), 'change'); };
    return { window, document, node, calls, timers, emit, select, submit: trusted => emit(node('transfer-form'), 'submit', trusted) };
}

test('control UI defaults only to exact origin, requires Space, and renders page text safely', async () => {
    const f = await fixture();
    assert.equal(f.node('destination-window').value, '10');
    assert.equal(f.node('destination-space').value, ''); assert.equal(f.node('promote').disabled, true);
    assert.equal(f.node('page-title').textContent, '<img src=x onerror=alert(1)>');
    assert.equal(f.node('page-title').querySelector('img'), null);
    f.select('destination-space', 'work'); assert.equal(f.node('promote').disabled, false);
});

test('restart warning is visible before any choice and remains through orphan and committed states', async () => {
    for (const context of [data(), orphanData(), { ...data(), record: { ...data().record, phase: 'committed' } }]) {
        const f = await fixture({ context }), warning = f.node('restart-warning');
        assert.equal(warning.getAttribute('role'), 'note');
        assert.equal(warning.hasAttribute('hidden'), false);
        assert.equal(warning.closest('form'), null, 'The warning is not hidden with a recovery or transfer form.');
        assert.match(warning.textContent, /After a restart:/);
        assert.match(warning.textContent, /control tab is missing or your page restores in another window/);
        assert.match(warning.textContent, /behaves like an ordinary restored tab/);
        assert.match(warning.textContent, /extension reload or update clears session state/);
        assert.equal(f.calls.filter(request => ['recover', 'promote'].includes(request.action)).length, 0);
    }
});

test('missing origin requires explicit surviving window choice', async () => {
    const context = data(); context.windows = [{ id: 30, title: 'Other', origin: false }];
    const f = await fixture({ context });
    assert.equal(f.node('destination-window').value, '');
    assert.match(f.node('status').textContent, /original browser window is gone/);
    f.select('destination-space', 'work'); assert.equal(f.node('promote').disabled, true);
    f.select('destination-window', '30'); assert.equal(f.node('promote').disabled, false);
});

test('untrusted submit never transfers, trusted duplicate submits transfer only once', async () => {
    let resolve;
    const pending = new Promise(done => { resolve = done; });
    const f = await fixture({ send: async request => request.action === 'context' ? data() : pending });
    f.select('destination-space', 'work'); f.submit(false); await tick();
    assert.equal(f.calls.filter(request => request.action === 'promote').length, 0);
    f.submit(true); f.submit(true);
    assert.equal(f.node('promote').disabled, true); assert.equal(f.node('refresh').disabled, true);
    assert.equal(f.calls.filter(request => request.action === 'promote').length, 1);
    assert.equal(f.calls.at(-1).tabId, 7); assert.equal(f.calls.at(-1).windowId, 10);
    assert.equal(f.calls.at(-1).bookmarkFolderId, 'folder');
    resolve({ success: true, phase: 'committed' }); await tick();
    assert.equal(f.node('promote').disabled, true); assert.match(f.node('status').textContent, /Moved into Work/);
});

test('transport failure and timeout lock out retries while leaving the live page alone', async () => {
    for (const timeout of [false, true]) {
        const f = await fixture({ send: async request => {
            if (request.action === 'context') return data();
            if (timeout) return new Promise(() => {});
            throw new Error('Worker connection lost');
        } });
        f.select('destination-space', 'work'); f.submit(true); await tick();
        if (timeout) { for (const callback of f.timers.values()) callback(); await tick(); }
        assert.equal(f.node('promote').disabled, true);
        f.submit(true); f.emit(f.node('refresh'), 'click'); await tick(); f.select('destination-space', 'work'); f.submit(true);
        assert.equal(f.calls.filter(request => request.action === 'promote').length, 1);
    }
});

for (const phase of ['opening', 'moving', 'orphan', 'uncertain', 'committed']) test(`control UI does not transfer ${phase} records`, async () => {
    const context = data(); context.record.phase = phase;
    const f = await fixture({ context }); f.select('destination-space', 'work'); f.submit(true);
    assert.equal(f.node('promote').disabled, true); assert.equal(f.calls.filter(request => request.action === 'promote').length, 0);
});

test('closed or dragged-out exact page never enables a replacement transfer', async () => {
    for (const page of [null, { id: 7, windowId: 30, title: 'Moved', url: 'https://example.test/' }, { id: 8, windowId: 20, title: 'Same URL', url: 'https://example.test/' }]) {
        const context = data(); context.page = page; const f = await fixture({ context });
        f.select('destination-space', 'work'); f.submit(true);
        assert.equal(f.node('promote').disabled, true); assert.equal(f.calls.filter(request => request.action === 'promote').length, 0);
    }
});

test('orphan recovery starts unselected even for one candidate and separates same-URL exact IDs', async () => {
    for (const count of [1, 2]) {
        const context = orphanData(); context.recoveryTabs = context.recoveryTabs.slice(0, count);
        const f = await fixture({ context });
        assert.equal(f.node('recovery-form').hidden, false);
        assert.equal(f.node('recovery-page').value, ''); assert.equal(f.node('recover').disabled, true);
        assert.equal(f.node('recovery-page').querySelectorAll('option').length, count + 1);
        assert.equal(f.node('promote').disabled, true);
        assert.equal(f.calls.some(request => request.action !== 'context'), false);
    }
});

test('trusted recovery binds only the explicit page then requires a separate destination and transfer', async () => {
    let selected = false;
    const f = await fixture({ send: async request => {
        if (request.action === 'context') {
            const context = orphanData();
            if (selected) { context.record.phase = 'ready'; context.record.tabId = 8; context.page = context.recoveryTabs[1]; context.recoveryTabs = []; }
            return context;
        }
        assert.equal(request.action, 'recover'); selected = true;
        return { success: true, phase: 'ready', tabId: 8, windowId: 20 };
    } });
    f.select('recovery-page', '8'); f.emit(f.node('recovery-form'), 'submit', false); await tick();
    assert.equal(f.calls.filter(request => request.action === 'recover').length, 0);
    f.emit(f.node('recovery-form'), 'submit'); await tick(); await tick();
    assert.deepEqual(structuredClone(f.calls.find(request => request.action === 'recover')), { type: 'arcifyTransientWindow', token: 'token', action: 'recover', tabId: 8 });
    assert.equal(f.calls.some(request => request.action === 'promote'), false);
    assert.equal(f.node('recovery-form').hidden, true);
    assert.equal(f.node('destination-window').value, ''); assert.equal(f.node('destination-space').value, '');
    assert.equal(f.node('promote').disabled, true); assert.match(f.node('status').textContent, /Nothing moved/);
});

test('pending or timed-out recovery never resubmits or promotes automatically', async () => {
    const f = await fixture({ send: async request => request.action === 'context' ? orphanData() : new Promise(() => {}) });
    f.select('recovery-page', '7'); f.emit(f.node('recovery-form'), 'submit'); f.emit(f.node('recovery-form'), 'submit');
    assert.equal(f.calls.filter(request => request.action === 'recover').length, 1);
    assert.equal(f.node('refresh').disabled, true);
    for (const callback of f.timers.values()) callback(); await tick();
    f.emit(f.node('refresh'), 'click'); await tick(); f.select('recovery-page', '8'); f.emit(f.node('recovery-form'), 'submit');
    assert.equal(f.calls.filter(request => request.action === 'recover').length, 1);
    assert.equal(f.calls.some(request => request.action === 'promote'), false);
    assert.equal(f.node('recover').disabled, true);
});

test('recovery refuses a candidate in another window and an invalid success receipt', async () => {
    const context = orphanData(); context.recoveryTabs[0].windowId = 30;
    const f = await fixture({ context }); f.select('recovery-page', '7'); f.emit(f.node('recovery-form'), 'submit');
    assert.equal(f.calls.some(request => request.action === 'recover'), false);
    const other = await fixture({ send: async request => request.action === 'context' ? orphanData() : { success: true, phase: 'ready', tabId: 99, windowId: 20 } });
    other.select('recovery-page', '7'); other.emit(other.node('recovery-form'), 'submit'); await tick();
    assert.equal(other.node('recover').disabled, true); assert.equal(other.node('promote').disabled, true);
    assert.match(other.node('status').textContent, /not confirmed/);
});

test('a delayed post-recovery context refresh never reenables the old recovery choice', async () => {
    let reads = 0;
    const f = await fixture({ send: async request => {
        if (request.action === 'context') return ++reads === 1 ? orphanData() : new Promise(() => {});
        return { success: true, phase: 'ready', tabId: 7, windowId: 20 };
    } });
    f.select('recovery-page', '7'); f.emit(f.node('recovery-form'), 'submit'); await tick();
    assert.equal(f.node('recovery-form').hidden, true); assert.equal(f.node('recover').disabled, true);
    f.emit(f.node('recovery-form'), 'submit'); await tick();
    assert.equal(f.calls.filter(request => request.action === 'recover').length, 1);
    assert.equal(f.calls.some(request => request.action === 'promote'), false);
});
