import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initializeSpotlightBridgeOptions } from '../../spotlight-bridge-options.js';
import { PEER_KEY } from '../../spotlight-bridge-protocol.js';

const SELF = 'a'.repeat(32), PEER = 'b'.repeat(32);
function setup(storedPeer = '') {
    const ids = ['bridgePeerId', 'bridgeOwnId', 'bridgeStatus', 'bridgeCopyStatus', 'bridgeSavedPeerId', 'bridgeSave', 'bridgeCheck', 'bridgeDisconnect', 'bridgeCopyId'];
    const nodes = Object.fromEntries(ids.map(id => [id, {
        value: '', textContent: '', dataset: {}, disabled: false, listeners: {},
        addEventListener(event, fn) { this.listeners[event] = fn; },
        focus() { this.focused = true; }, select() { this.selected = true; }
    }]));
    const state = { peer: storedPeer, writes: [], calls: [], clipboard: [] };
    const api = {
        runtime: { id: SELF }, windows: { getCurrent: async () => ({ id: 9 }) },
        storage: { local: {
            get: async key => { assert.equal(key, PEER_KEY); return { [key]: state.peer }; },
            set: async values => { state.writes.push(values); state.peer = values[PEER_KEY]; },
            remove: async key => { assert.equal(key, PEER_KEY); state.peer = ''; }
        } }
    };
    state.reply = async () => ({ extensionId: PEER });
    const ui = initializeSpotlightBridgeOptions({
        document: { getElementById: id => nodes[id] }, api,
        sendRequest: async (...args) => { state.calls.push(args); return state.reply(...args); },
        clipboard: { writeText: async value => { state.clipboard.push(value); if (state.copyFails) throw new Error('denied'); } }
    });
    return { nodes, state, api, ui, status: nodes.bridgeStatus };
}

test('opening settings distinguishes a saved ID from a verified connection', async () => {
    for (const peer of ['', PEER]) {
        const { ui, nodes, state, status } = setup(peer);
        await ui.ready;
        assert.equal(nodes.bridgeOwnId.value, SELF);
        assert.equal(nodes.bridgePeerId.value, peer);
        assert.equal(status.dataset.state, peer ? 'saved' : 'disabled');
        assert.equal(state.calls.length, 0);
    }
});

test('first-side save persists the ID and explains awaiting reciprocal approval', async () => {
    const { ui, nodes, state, status } = setup(); await ui.ready;
    nodes.bridgePeerId.value = ` ${PEER} `;
    state.reply = async () => { throw Object.assign(new Error('not paired'), { code: 'UNAUTHORIZED' }); };
    await ui.save();
    assert.equal(state.peer, PEER);
    assert.equal(nodes.bridgePeerId.value, PEER);
    assert.equal(status.dataset.state, 'pending');
    assert.match(status.textContent, /Awaiting Spotlight approval/);
    assert.match(status.textContent, /ID is saved in Arcify/);
    assert.match(status.textContent, /save this Arcify extension ID/);
    assert.equal(state.writes.length, 1);
    // Once Spotlight explicitly saves its own reciprocal setting, either order works.
    state.reply = async () => ({ extensionId: PEER });
    await ui.check();
    assert.equal(status.dataset.state, 'connected');
    assert.equal(state.writes.length, 1);
});

for (const code of ['UNAVAILABLE', 'TIMEOUT', 'VERSION_MISMATCH', 'INVALID_RESPONSE']) {
    test(`${code} does not masquerade as reciprocal approval pending`, async () => {
        const { ui, state, status } = setup(PEER); await ui.ready;
        state.reply = async () => { throw Object.assign(new Error('diagnostic'), { code }); };
        await ui.check();
        assert.equal(status.dataset.state, ['UNAVAILABLE', 'TIMEOUT'].includes(code) ? 'unavailable' : 'error');
        assert.match(status.textContent, new RegExp(code));
        assert.equal(state.peer, PEER);
    });
}

test('invalid/self IDs never save or contact a peer', async () => {
    for (const value of ['', SELF, 'x'.repeat(32)]) {
        const { ui, nodes, state, status } = setup(); await ui.ready;
        nodes.bridgePeerId.value = value; await ui.save();
        assert.equal(status.dataset.state, 'error');
        assert.equal(state.writes.length, 0);
        assert.equal(state.calls.length, 0);
    }
});

test('storage failure is shown without claiming the ID was saved', async () => {
    const { ui, nodes, state, status, api } = setup(); await ui.ready;
    nodes.bridgePeerId.value = PEER;
    api.storage.local.set = async () => { throw new Error('storage failed'); };
    await ui.save();
    assert.equal(status.dataset.state, 'error');
    assert.match(status.textContent, /storage failed/);
    assert.doesNotMatch(status.textContent, /ID saved/);
    assert.equal(state.calls.length, 0);
    assert.equal(nodes.bridgeSave.disabled, false);
});

test('unknown hello identity is never connected', async () => {
    const { ui, state, status } = setup(PEER); await ui.ready;
    state.reply = async () => ({ extensionId: SELF });
    await ui.check();
    assert.equal(status.dataset.state, 'error');
    assert.match(status.textContent, /identity mismatch/);
});

test('busy controls prevent overlapping save/check/disconnect actions', async () => {
    const { ui, nodes, state, status } = setup(PEER); await ui.ready;
    let release;
    state.reply = () => new Promise(resolve => { release = resolve; });
    const checking = ui.check();
    while (!release) await new Promise(resolve => setImmediate(resolve));
    assert.equal(nodes.bridgeDisconnect.disabled, true);
    await ui.check(); await ui.disconnect();
    assert.equal(state.calls.length, 1);
    assert.equal(state.peer, PEER);
    release({ extensionId: PEER }); await checking;
    await ui.disconnect();
    assert.equal(status.dataset.state, 'disabled');
    assert.equal(nodes.bridgePeerId.value, '');
    assert.equal(nodes.bridgeDisconnect.disabled, false);
});

for (const rejects of [false, true]) test(`a ${rejects ? 'failed' : 'successful'} old check cannot claim another tab's changed pairing`, async () => {
    const { ui, state, status } = setup(PEER); await ui.ready;
    state.reply = async () => {
        state.peer = '';
        if (rejects) throw Object.assign(new Error('old rejection'), { code: 'UNAUTHORIZED' });
        return { extensionId: PEER };
    };
    await ui.check();
    assert.equal(status.dataset.state, 'changed');
    assert.match(status.textContent, /Pairing changed/);
    assert.doesNotMatch(status.textContent, /Connected|Awaiting/);
});

test('copy ID succeeds or selects the readonly ID for manual copying without permission changes', async () => {
    const { ui, nodes, state } = setup(); await ui.ready;
    await ui.copy();
    assert.deepEqual(state.clipboard, [SELF]);
    assert.match(nodes.bridgeCopyStatus.textContent, /copied/);
    state.copyFails = true; await ui.copy();
    assert.equal(nodes.bridgeOwnId.selected, true);
    assert.match(nodes.bridgeCopyStatus.textContent, /selected/);
});

 test('check uses and displays the saved ID while preserving an unsaved edit', async () => {
    const { ui, nodes, state, status } = setup(PEER); await ui.ready;
    const edited = 'c'.repeat(32);
    nodes.bridgePeerId.value = edited;
    await ui.check();
    assert.equal(state.calls[0][0], PEER);
    assert.equal(nodes.bridgeSavedPeerId.textContent, PEER);
    assert.equal(nodes.bridgePeerId.value, edited);
    assert.equal(status.dataset.state, 'connected');
});
