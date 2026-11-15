import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createGeneralUndoUI } from '../../general-undo-ui.js';
const settle = () => new Promise(resolve => setImmediate(resolve));
function fixture(sendRequest = async () => ({ success: true })) {
    const { document } = parseHTML('<html><body><div id="favoritesDropNotice"></div></body></html>');
    const messages = [], calls = [], gates = [];
    const ui = createGeneralUndoUI({ document, getWindowId: () => 10,
        sendRequest: request => { calls.push(request); return sendRequest(request); },
        refresh: async () => gates.push('refresh'), showStatus: text => messages.push(text),
        begin: () => gates.push('begin'), end: () => gates.push('end') });
    return { document, ui, messages, calls, gates, button: document.getElementById('generalUndo') };
}
test('Undo starts hidden, offers a real button, dispatches once and refreshes', async () => {
    const f = fixture(); assert.equal(f.button.hidden, true); f.ui.offer('token');
    assert.equal(f.button.hidden, false); f.button.click(); f.button.click(); await settle();
    assert.deepEqual(f.calls, [{ type: 'undoGeneralAction', token: 'token', windowId: 10 }]);
    assert.deepEqual(f.gates, ['begin', 'refresh', 'end']); assert.deepEqual(f.messages, ['Undone.']);
    assert.equal(f.button.hidden, true);
});
test('newer status clears the old receipt and malformed token is not offered', async () => {
    const f = fixture(); f.ui.offer('token'); f.ui.clear(); f.button.click(); f.ui.offer(undefined); await settle();
    assert.equal(f.calls.length, 0); assert.equal(f.button.hidden, true);
});
test('transport failure does not retry or claim no-op', async () => {
    const f = fixture(async () => { throw new Error('lost'); }); f.ui.offer('token'); f.button.click(); await settle();
    assert.equal(f.calls.length, 1); assert.match(f.messages[0], /could not be confirmed/);
    assert.equal(f.messages[0].includes('Nothing was undone'), false); assert.deepEqual(f.gates, ['begin', 'end']);
});
