import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createSplitPinRecoveryUI } from '../../split-pin-recovery-ui.js';
const settle = () => new Promise(resolve => setImmediate(resolve));
function fixture(candidates = [], mutate = async () => ({ success: true })) {
    const { document } = parseHTML('<html><body><div id="favoritesDropNotice"></div></body></html>');
    const create = document.createElement.bind(document);
    document.createElement = tag => { const el = create(tag); if (tag === 'dialog') { el.showModal = () => el.setAttribute('open', ''); el.close = () => el.removeAttribute('open'); } return el; };
    const calls = [], messages = [], current = { windowId: 10, spaceId: 's', bookmarkFolderId: 'root' };
    const recipe = { id: 'r', name: 'Planning', pages: [{ url: 'https://a.test' }, { url: 'https://b.test' }] };
    const ui = createSplitPinRecoveryUI({ document, context: () => current,
        sendRequest: async request => { calls.push(request); return request.action === 'recoveryList' ? { success: true, items: [{ recipe, phase: 'pending', candidates }] } : mutate(request); },
        refresh() {}, showStatus: text => messages.push(text) });
    return { document, ui, calls, messages, current, recipe, button: document.getElementById('splitPinRecovery') };
}
test('recovery attention is conditional; opening shows no mutation and zero-candidate defer preserves frozen context', async () => {
    const f = fixture(); assert.equal(f.button.hidden, true);
    f.ui.update({ pins: [{ phase: 'pending' }] }); assert.equal(f.button.hidden, false);
    f.button.click(); await settle(); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].action, 'recoveryList');
    const dialog = f.document.querySelector('dialog'); assert(dialog.hasAttribute('open')); assert.match(dialog.textContent, /No eligible bookmark/);
    f.current.spaceId = 'changed';
    const defer = [...dialog.querySelectorAll('button')].find(b => b.textContent === 'Keep recipe for later');
    defer.click(); defer.click(); await settle();
    assert.equal(f.calls.length, 2); assert.equal(f.calls[1].spaceId, 's'); assert.equal(f.calls[1].action, 'defer');
    assert.deepEqual(f.calls[1].recipe, f.recipe); assert.equal(f.document.querySelector('dialog'), null);
});
test('each candidate requires exact explicit user choice; no extras are deleted', async () => {
    const candidates = ['one', 'two'].map(bookmarkId => ({ bookmarkId, parentId: 'folder', title: 'Same title', spaceId: 's', bookmarkFolderId: 'root', spaceName: 'Personal', parentName: 'Areas' }));
    const f = fixture(candidates); f.button.click(); await settle();
    const buttons = [...f.document.querySelectorAll('dialog button')].filter(b => b.textContent.startsWith('Use this bookmark:'));
    assert.equal(buttons.length, 2); assert.match(buttons[1].textContent, /ID two/); buttons[1].click(); await settle();
    assert.equal(f.calls.length, 2); assert.deepEqual(f.calls[1].candidate, candidates[1]); assert.equal(f.calls[1].action, 'recover');
});
test('failed association stays visible, reports uncertainty and does not automatically retry', async () => {
    const f = fixture([{ bookmarkId: 'one', title: 'Saved', spaceName: 'Personal', parentName: 'Areas' }], async () => { throw new Error('Changed; refresh'); });
    f.button.click(); await settle(); f.document.querySelector('fieldset button').click(); await settle();
    assert.equal(f.calls.length, 2); assert.match(f.document.querySelector('[role="status"]').textContent, /Changed; refresh/);
    assert(f.document.querySelector('dialog')); assert.equal(f.document.querySelector('fieldset button').disabled, false);
});
