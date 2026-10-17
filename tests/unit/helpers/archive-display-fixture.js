import assert from 'node:assert/strict';
import { SpotlightArchiveActions, ARCHIVE_OPEN_TYPE } from '../../../spotlight-archive-actions.js';
import { ARCHIVE_DISPLAY_PORT, ARCHIVE_DISPLAY_TYPE } from '../../../archive-display-session.js';
import { PEER_KEY, PAIRING_GENERATION_KEY } from '../../../spotlight-bridge-protocol.js';
export const peer = 'a'.repeat(32), own = 'b'.repeat(32);
export const context = { windowId: 10, spaceId: 'source', bookmarkFolderId: 'source-folder', sourceTabId: 1, sourceUrl: 'https://source.test/', pairingGeneration: 'g' };
export const entry = { entryId: 'entry-one', name: 'Original', url: 'https://same.test/', spaceId: 'original', archivedAt: 123, unknownLegacy: { untouched: true } };
export const event = () => {
    const listeners = new Set();
    return { addListener: listener => listeners.add(listener), removeListener: listener => listeners.delete(listener),
        emit: (...args) => [...listeners].forEach(listener => listener(...args)), listeners };
};
export function fixture(t, options = {}) {
    const state = { now: 1, pair: peer, generation: 'g', reads: [], opened: [], responses: [], sent: [], effects: [], ports: [], messages: [], currentWindow: 10,
        windows: new Map([[10, { id: 10, type: 'normal', incognito: false, focused: true }], [20, { id: 20, type: 'normal', incognito: false, focused: false }]]) };
    const browser = { extension: { inIncognitoContext: false }, runtime: { id: own, getURL: path => `chrome-extension://${own}/${path}`,
        onConnect: event(), onMessage: event(), sendMessage: async message => { state.sent.push(message); browser.runtime.onMessage.emit(message); } },
        tabs: { getCurrent: async () => state.rendererTab, ...Object.fromEntries(['onUpdated', 'onActivated', 'onRemoved', 'onReplaced', 'onAttached', 'onDetached'].map(name => [name, event()])) },
        windows: { get: async id => { await state.windowRead?.(); return structuredClone(state.windows.get(id)); }, getCurrent: async () => structuredClone(state.windows.get(state.currentWindow)), onFocusChanged: event(), onRemoved: event() },
        bookmarks: Object.fromEntries(['onChanged', 'onMoved', 'onRemoved', 'onCreated'].map(name => [name, event()])),
        storage: { onChanged: event(), local: { get(keys, callback) {
            state.reads.push(keys); const value = { [PEER_KEY]: state.pair, [PAIRING_GENERATION_KEY]: state.generation };
            if (callback) { state.callback = true; callback(value); state.callback = false; return; }
            return Promise.resolve(value);
        } } }, sidePanel: { onOpened: event(), onClosed: event(), open(target) {
            assert.equal(state.callback, true, 'Native open stays on the single callback stack'); state.opened.push(target);
            if (!state.skipOpened) browser.sidePanel.onOpened.emit({ windowId: 10, path: 'sidebar.html' });
            state.duringOpen?.(); if (state.throwOpen) throw new Error('gesture required');
            return state.rejectOpen ? Promise.reject(new Error('gesture required')) : Promise.resolve();
        } } };
    let queue = Promise.resolve();
    const store = { active: { 10: 'source' }, spaces: [{ id: 'source', bookmarkFolderId: 'source-folder' }], run: operation => { const result = queue.then(operation); queue = result.catch(() => {}); return result; }, archiveStore: {
        async viewUnlocked() { return { context: Object.fromEntries(Object.entries(context).filter(([key]) => key !== 'pairingGeneration')), entries: [{ entry: structuredClone(entry), bookmarkFolderId: 'original-folder' }, { entry: { ...entry, entryId: 'entry-two', name: 'Twin' }, bookmarkFolderId: 'original-folder' }] }; },
        async contextUnlocked(windowId, expected) { await state.contextRead?.(); if (state.stale || store.active[windowId] !== expected.spaceId) throw new Error('stale source'); },
        async reopenUnlocked(request, hooks) { await hooks.beforeMutation(); state.effects.push(request); if (state.uncertain) throw new Error('uncertain native result'); return { consumed: true, entryId: request.expected.entryId, tabId: 50, status: 'reopened' }; }
    } };
    globalThis.chrome = browser;
    const actions = new SpotlightArchiveActions(store, browser, { now: () => state.now, ackMs: 1000, ...options });
    const uninstall = actions.install();
    const prepare = () => actions.prepareUnlocked({ tabId: 1, windowId: 10 }, { peerId: peer, pairingGeneration: 'g' });
    const sender = () => ({ id: peer, frameId: 0, documentLifecycle: 'active', url: context.sourceUrl, origin: 'https://source.test', tab: { id: 1, windowId: 10, active: true, url: context.sourceUrl } });
    // Captured Chrome 155 native sidebar shape: documentId:null, tab:null.
    // origin is browser-attested, not a renderer-supplied registration field.
    const sidebar = () => ({ id: own, url: `chrome-extension://${own}/sidebar.html`, origin: `chrome-extension://${own}`, documentId: null, tab: null });
    const connect = (from = sidebar(), name = ARCHIVE_DISPLAY_PORT) => {
        let live = true;
        const client = { name, onMessage: event(), onDisconnect: event() }, worker = { name, sender: from, onMessage: event(), onDisconnect: event() };
        const disconnect = () => { if (!live) return; live = false; queueMicrotask(() => { client.onDisconnect.emit(); worker.onDisconnect.emit(); }); };
        Object.assign(client, { postMessage(message) { if (!live) throw new Error('Disconnected'); state.messages.push({ direction: 'request', message, worker }); queueMicrotask(() => { if (live) worker.onMessage.emit(structuredClone(message)); }); }, disconnect });
        Object.assign(worker, { postMessage(message) { if (!live) throw new Error('Disconnected'); state.messages.push({ direction: 'response', message, worker }); queueMicrotask(() => { if (live) client.onMessage.emit(structuredClone(message)); }); }, disconnect });
        state.ports.push({ client, worker, get live() { return live; } });
        queueMicrotask(() => browser.runtime.onConnect.emit(worker));
        return client;
    };
    browser.runtime.connect = ({ name }) => connect(state.rendererSender || sidebar(), name);
    const open = (scope, override = {}, from = sender()) => actions.open({ type: ARCHIVE_OPEN_TYPE, version: 1, requestId: 'req-open', token: scope.openIntent, ...override }, from, result => state.responses.push(result));
    const channel = (from = sidebar()) => {
        const port = connect(from); let sequence = 0, session;
        const pending = new Map();
        port.onMessage.addListener(reply => { if (reply.requestId && pending.has(reply.requestId)) { pending.get(reply.requestId)(reply); pending.delete(reply.requestId); } });
        port.onDisconnect.addListener(() => { for (const resolve of pending.values()) resolve({ success: false, code: 'DISCONNECTED' }); pending.clear(); });
        const request = (action, extra = {}, windowId = 10) => new Promise(resolve => {
            const requestId = String(++sequence); pending.set(requestId, resolve);
            try { port.postMessage({ type: ARCHIVE_DISPLAY_TYPE, requestId, action, windowId, ...(action !== 'register' ? { session } : {}), ...extra }); }
            catch { pending.delete(requestId); resolve({ success: false, code: 'DISCONNECTED' }); }
        });
        return { port, request, get session() { return session; }, async register(windowId = 10) { const reply = await request('register', {}, windowId); session = reply.result?.session; return reply; } };
    };
    const drain = async () => { for (let i = 0; i < 150; i++) await Promise.resolve(); };
    t.after(() => { for (const intent of actions.intents.values()) intent.finish?.(new Error('Test cleanup')); uninstall(); for (const port of state.ports) port.client.disconnect(); });
    return { state, browser, store, actions, prepare, sender, sidebar, open, connect, channel, drain };
}
