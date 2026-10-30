import test from 'node:test';
import assert from 'node:assert/strict';
import { createPeekService, registerPeek, PEEK_TYPE, PEEK_RECEIPTS_KEY } from '../../peek.js';

const SELF = 'a'.repeat(32), PEER = 'b'.repeat(32), CONNECTION = '11111111-1111-4111-8111-111111111111';
const source = { tabId: 1, windowId: 10, url: 'https://source.test/private?parent=secret' };
const event = () => { const listeners = new Set(); return { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn), emit: (...args) => { for (const fn of listeners) fn(...args); } }; };
function fixture() {
    let time = 1000, authorized = true;
    const selection = { mode: 'original', url: 'https://target.test/original', documentId: null, frameId: null, revision: null };
    const calls = [], session = {}, local = { arcifyBridgePeerId: PEER, arcifyBridgePairingGeneration: 'g' };
    const tabs = new Map([[1, { id: 1, windowId: 10, url: source.url, active: true, incognito: false, pinned: false }]]);
    const windows = new Map([[10, { id: 10, type: 'normal', incognito: false, focused: true }]]);
    const record = { token: CONNECTION, tabId: 3, windowId: 20, controllerTabId: 2, phase: 'ready' };
    const nodes = [{ id: 'root', title: 'Arcify' }, { id: 'fa', parentId: 'root' }, { id: 'fb', parentId: 'root' }];
    const api = globalThis.chrome = {
        runtime: { id: SELF, getURL: p => `chrome-extension://${SELF}/${p}`, sendMessage: async () => ({ authorized, selection: structuredClone(selection) }), onMessageExternal: { addListener: fn => api.listener = fn } },
        storage: { local: { get: async () => structuredClone(local) }, session: { get: async () => structuredClone(session), set: async values => Object.assign(session, structuredClone(values)) }, sync: { get: async () => ({}) } },
        bookmarks: { get: async id => nodes.filter(n => n.id === id), search: async () => nodes.filter(n => n.id === 'root'), getChildren: async id => nodes.filter(n => n.parentId === id) },
        tabs: { onUpdated: event(), onRemoved: event(), onAttached: event(), onDetached: event(), onReplaced: event(),
            get: async id => { if (!tabs.has(id)) throw Error('closed'); return structuredClone(tabs.get(id)); },
            update: async (id, changes) => { for (const t of tabs.values()) if (t.windowId === tabs.get(id).windowId) t.active = t.id === id; Object.assign(tabs.get(id), changes); },
            remove: async id => { tabs.delete(id); calls.push(['remove', id]); } },
        windows: { onRemoved: event(), get: async id => { if (!windows.has(id)) throw Error('closed'); return structuredClone(windows.get(id)); }, update: async (id, values) => Object.assign(windows.get(id), values) }
    };
    const store = { spaces: [{ id: 'a', bookmarkFolderId: 'fa', spaceBookmarks: [], temporaryTabs: [1] }, { id: 'b', bookmarkFolderId: 'fb', spaceBookmarks: [], temporaryTabs: [] }], active: { 10: 'a' },
        run: fn => fn(), isTransientTab: () => false, isTransientWindow: id => id === 20, isGlobalTab: () => false, readTodayPlacement: async () => {},
        forgetTab: id => { for (const s of store.spaces) s.temporaryTabs = s.temporaryTabs.filter(v => v !== id); },
        insertCreatedToday: (space, tab) => space.temporaryTabs.push(tab.id),
        persist: async ({ beforeWrite }) => { await beforeWrite(); local.spaces = structuredClone(store.spaces); local.spaceTabSnapshot = store.spaces.flatMap(s => s.temporaryTabs.map(tabId => ({ tabId, spaceId: s.id, section: 'temporaryTabs' }))); },
        transientWindows: {
            openUnlocked: async (request, options) => {
                await options.beforeMutation(); calls.push(['open', request]);
                windows.get(10).focused = false; windows.set(20, { id: 20, type: 'normal', incognito: false, focused: true });
                tabs.set(2, { id: 2, windowId: 20, url: api.runtime.getURL('transient-window.html') + '?token=' + CONNECTION, incognito: false, pinned: false });
                await options.beforeMutation();
                tabs.set(3, { id: 3, windowId: 20, url: request.url, incognito: false, pinned: false }); return record;
            },
            promoteUnlocked: async (request, options) => {
                await options.beforeMutation(); await options.commitOwnership.validate(tabs.get(3), request);
                calls.push(['move', request]); tabs.get(3).windowId = request.windowId;
                await options.commitOwnership(tabs.get(3), request); return { ...request, phase: 'committed' };
            }
        }
    };
    const service = createPeekService(store, api, { now: () => time });
    const prepare = () => service.prepare(source, 'https://target.test/original', CONNECTION, PEER, 'g', async () => {});
    const execute = (operation, action = 'expand', check = async () => {}) => service.execute(source, CONNECTION, operation, action, PEER, 'g', check);
    return { api, store, tabs, windows, nodes, calls, local, session, service, prepare, execute, selection, setTime: v => time = v, authorize: v => authorized = v };
}
test('preparation/capability never create; action resolves new current Space and commits persisted unique membership', async () => {
    const f = fixture(); assert.deepEqual(await f.service.capability(source), { version: 3 });
    const p = await f.prepare(); assert.equal(f.calls.length, 0); f.store.active[10] = 'b';
    const result = await f.execute(p.operation); assert.equal(result.completed, true); assert.equal(result.spaceId, 'b');
    assert.equal(f.calls.filter(c => c[0] === 'open').length, 1); assert.equal(f.calls.filter(c => c[0] === 'move').length, 1);
    assert.deepEqual(f.calls[0][1], { url: 'https://target.test/original', originWindowId: 10 });
    assert.equal(f.local.spaces.find(s => s.id === 'b').temporaryTabs.includes(3), true);
    assert.equal(f.local.spaceTabSnapshot.filter(r => r.tabId === 3).length, 1);
    assert.equal(f.tabs.get(3).windowId, 10); assert.equal(f.tabs.has(2), false);
});
test('explicit fallback uses existing Little Arc open and never promotes', async () => {
    const f = fixture(), p = await f.prepare(); const result = await f.execute(p.operation, 'fallback');
    assert.equal(result.action, 'fallback'); assert.deepEqual(f.calls.map(c => c[0]), ['open']); assert.equal(f.tabs.get(3).windowId, 20);
});

for (const action of ['expand', 'fallback']) test(`${action} opens only the frozen validated current URL and preserves original receipt identity`, async () => {
    const f = fixture(), p = await f.prepare();
    Object.assign(f.selection, { mode: 'current', url: 'https://redirect.test/current#history', frameId: 9, documentId: 'current-document', revision: crypto.randomUUID() });
    const result = await f.execute(p.operation, action); assert.equal(result.completed, true);
    assert.equal(f.calls.find(c => c[0] === 'open')[1].url, f.selection.url);
    assert.equal(f.session[PEEK_RECEIPTS_KEY][0].url, 'https://target.test/original'); assert.equal(f.session[PEEK_RECEIPTS_KEY][0].targetUrl, f.selection.url);
    f.tabs.get(1).active = true; f.windows.get(10).focused = true;
    const cold = createPeekService(f.store, f.api);
    for (const url of ['https://target.test/original', f.selection.url]) await assert.rejects(cold.prepare(source, url, crypto.randomUUID(), PEER, 'g', async () => {}));
});
test('optional documentId uses the exact private binding revision and native frame ID', async () => {
    const f = fixture(), p = await f.prepare(); Object.assign(f.selection, { mode: 'current', url: 'https://current.test/', frameId: 9, documentId: null, revision: crypto.randomUUID() });
    await f.execute(p.operation); assert.equal(f.calls[0][1].url, 'https://current.test/');
});
for (const key of ['url', 'documentId', 'frameId', 'revision']) test(`changed selected ${key} fails before native creation and retains uncertainty suppression`, async () => {
    const f = fixture(), p = await f.prepare(); Object.assign(f.selection, { mode: 'current', url: 'https://current.test/', frameId: 9, documentId: 'document-a', revision: crypto.randomUUID() });
    const send = f.api.runtime.sendMessage; let count = 0;
    f.api.runtime.sendMessage = async (...args) => { if (++count === 2) f.selection[key] = key === 'frameId' ? 10 : key === 'url' ? 'https://changed.test/' : key === 'revision' ? crypto.randomUUID() : 'document-b'; return send(...args); };
    await assert.rejects(f.execute(p.operation)); assert.equal(f.calls.length, 0); assert.equal(f.session[PEEK_RECEIPTS_KEY][0].phase, 'pending');
    await assert.rejects(createPeekService(f.store, f.api).prepare(source, 'https://target.test/original', crypto.randomUUID(), PEER, 'g', async () => {}));
});
for (const change of [{ mode: 'original', url: 'https://forged.test/' }, { mode: 'current', url: 'javascript:alert(1)' }, { mode: 'current', url: 'https://user:pass@current.test/' }, { mode: 'current', frameId: 0 }, { mode: 'current', revision: null }]) test(`invalid selection ${JSON.stringify(change)} never creates`, async () => {
    const f = fixture(), p = await f.prepare(); Object.assign(f.selection, { mode: 'current', url: 'https://current.test/', frameId: 9, documentId: 'doc', revision: crypto.randomUUID() }, change);
    await assert.rejects(f.execute(p.operation)); assert.equal(f.calls.length, 0);
});
for (const phase of ['pending', 'completed']) test(`legacy v1 ${phase} receipt remains unchanged and blocks reopened original link`, async () => {
    const f = fixture(), receipt = { source, url: 'https://target.test/original', operation: crypto.randomUUID(), connection: crypto.randomUUID(), phase };
    f.session[PEEK_RECEIPTS_KEY] = structuredClone([receipt]); await assert.rejects(f.prepare());
    assert.deepEqual(f.session[PEEK_RECEIPTS_KEY], [receipt]); assert.equal(f.calls.length, 0);
});
test('legacy backend authority without current-selection schema fails closed', async () => {
    const f = fixture(), p = await f.prepare(); f.api.runtime.sendMessage = async () => ({ authorized: true });
    await assert.rejects(f.execute(p.operation)); assert.equal(f.calls.length, 0);
});
for (const cause of ['activeMissing', 'activeDuplicate', 'folderDeleted', 'folderReparented', 'windowClosed', 'windowPrivate', 'sourceNavigated', 'sourcePending', 'sourceInactive', 'sourceTransient', 'proof', 'expired', 'revoked', 'generation']) test(`rejects ${cause} before creating`, async () => {
    const f = fixture(), p = await f.prepare();
    if (cause === 'activeMissing') f.store.active[10] = 'missing';
    if (cause === 'activeDuplicate') f.store.spaces.push({ ...f.store.spaces[0] });
    if (cause === 'folderDeleted') f.nodes.splice(1, 1);
    if (cause === 'folderReparented') f.nodes[1].parentId = 'other';
    if (cause === 'windowClosed') f.windows.delete(10);
    if (cause === 'windowPrivate') f.windows.get(10).incognito = true;
    if (cause === 'sourceNavigated') f.tabs.get(1).url = 'https://new.test/';
    if (cause === 'sourcePending') f.tabs.get(1).pendingUrl = 'https://new.test/';
    if (cause === 'sourceInactive') f.tabs.get(1).active = false;
    if (cause === 'sourceTransient') f.store.isTransientTab = () => true;
    if (cause === 'proof') f.authorize(false);
    if (cause === 'expired') f.setTime(2000000);
    if (cause === 'revoked') f.service.revoke(CONNECTION);
    await assert.rejects(cause === 'generation' ? f.service.execute(source, CONNECTION, p.operation, 'expand', PEER, 'wrong', async () => {}) : f.execute(p.operation));
    assert.equal(f.calls.length, 0);
});
test('pinned/global source is readable and is not moved or altered', async () => {
    const f = fixture(); f.tabs.get(1).pinned = true; f.store.isGlobalTab = tab => (tab?.id ?? tab) === 1;
    const p = await f.prepare(); await f.execute(p.operation); assert.equal(f.tabs.get(1).pinned, true); assert.equal(f.tabs.get(1).windowId, 10);
});
test('duplicate concurrent/replayed actions consume once, including fallback after expansion', async () => {
    const f = fixture(), p = await f.prepare(); const outcomes = await Promise.allSettled([f.execute(p.operation), f.execute(p.operation), f.execute(p.operation, 'fallback')]);
    assert.equal(outcomes.filter(v => v.status === 'fulfilled').length, 1); assert.equal(f.calls.filter(c => c[0] === 'open').length, 1);
    await assert.rejects(f.execute(p.operation));
});
test('cold worker has no authority and cannot retry a prepared operation', async () => {
    const f = fixture(), p = await f.prepare(); const cold = createPeekService(f.store, f.api);
    await assert.rejects(cold.execute(source, CONNECTION, p.operation, 'expand', PEER, 'g', async () => {})); assert.equal(f.calls.length, 0);
});
test('read-only heartbeat preserves only live unconsumed authority, does not extend TTL or write receipts', async () => {
    const f=fixture(),p=await f.prepare();
    assert.deepEqual(await f.service.pulse(source,CONNECTION,p.operation,async()=>{}),{alive:true});assert.equal(f.calls.length,0);assert.deepEqual(f.session,{});
    f.setTime(2000000);await assert.rejects(f.service.pulse(source,CONNECTION,p.operation,async()=>{}));
    const cold=createPeekService(f.store,f.api);await assert.rejects(cold.pulse(source,CONNECTION,p.operation,async()=>{}));
});
for (const cause of ['navigationABA', 'spaceChanged', 'authorityLost', 'windowClosed']) test(`in-flight ${cause} retains original temporary page and forbids automatic second create`, async () => {
    const f = fixture(), p = await f.prepare(), open = f.store.transientWindows.openUnlocked;
    f.store.transientWindows.openUnlocked = async (...args) => { const result = await open(...args);
        if (cause === 'navigationABA') { f.api.tabs.onUpdated.emit(1, { url: 'https://changed.test/' }); f.api.tabs.onUpdated.emit(1, { url: source.url }); }
        if (cause === 'spaceChanged') f.store.active[10] = 'b';
        if (cause === 'authorityLost') f.authorize(false);
        if (cause === 'windowClosed') f.windows.delete(10);
        return result;
    };
    await assert.rejects(f.execute(p.operation)); await assert.rejects(f.execute(p.operation, 'fallback'));
    assert.equal(f.calls.filter(c => c[0] === 'open').length, 1); assert.equal(f.calls.some(c => c[0] === 'move'), false); assert(f.tabs.has(3)); assert(f.tabs.has(2));
});
test('status-only iframe navigation during action does not revoke unchanged top-document proof',async()=>{
    const f=fixture(),p=await f.prepare(),open=f.store.transientWindows.openUnlocked;
    f.store.transientWindows.openUnlocked=async(...args)=>{const result=await open(...args);f.api.tabs.onUpdated.emit(1,{status:'loading'});f.api.tabs.onUpdated.emit(1,{status:'complete'});return result;};
    assert.equal((await f.execute(p.operation)).completed,true);assert.equal(f.calls.filter(c=>c[0]==='open').length,1);
});
test('same-URL top-document replacement loses broker proof and cannot move or retry',async()=>{
    const f=fixture(),p=await f.prepare(),open=f.store.transientWindows.openUnlocked;
    f.store.transientWindows.openUnlocked=async(...args)=>{const result=await open(...args);f.api.tabs.onUpdated.emit(1,{status:'loading'});f.authorize(false);return result;};
    await assert.rejects(f.execute(p.operation));await assert.rejects(f.execute(p.operation));assert.equal(f.calls.filter(c=>c[0]==='open').length,1);assert.equal(f.calls.some(c=>c[0]==='move'),false);
});
for (const cause of ['createAcknowledgement', 'persistWrite', 'persistReadback']) test(`uncertain ${cause} never reports completion, retries or closes controller`, async () => {
    const f = fixture(), p = await f.prepare();
    if (cause === 'createAcknowledgement') { const open = f.store.transientWindows.openUnlocked; f.store.transientWindows.openUnlocked = async (...args) => { await open(...args); throw Error('ack lost'); }; }
    if (cause === 'persistWrite') f.store.persist = async () => { throw Error('write failed'); };
    if (cause === 'persistReadback') f.store.persist = async ({ beforeWrite }) => { await beforeWrite(); f.local.spaces = []; f.local.spaceTabSnapshot = []; };
    await assert.rejects(f.execute(p.operation)); await assert.rejects(f.execute(p.operation)); assert(f.tabs.has(2)); assert(f.tabs.has(3)); assert.equal(f.calls.filter(c => c[0] === 'open').length, 1);
});
test('immutable original URL cannot be substituted by execution request', async () => {
    const f = fixture(); registerPeek(f.store, f.api);
    const call = request => new Promise(resolve => f.api.listener({ type: PEEK_TYPE, ...request }, { id: PEER }, resolve));
    const prepared = await call({ action: 'prepare', source, url: 'https://target.test/', connection: CONNECTION });
    const result = await call({ action: 'expand', source, operation: prepared.operation, connection: CONNECTION, url: 'https://evil.test/' });
    assert.equal(result.success, false); assert.equal(f.calls.length, 0);
});
for (const action of ['expand', 'fallback']) test(`lost ${action} reply latches original link across fresh connection and worker restart`, async () => {
    const f = fixture(), p = await f.prepare(); await f.execute(p.operation, action);
    f.tabs.get(1).active = true; f.windows.get(10).focused = true;
    const cold = createPeekService(f.store, f.api), next = '22222222-2222-4222-8222-222222222222';
    await assert.rejects(cold.prepare(source, 'https://target.test/original', next, PEER, 'g', async () => {}));
    assert.equal(f.calls.filter(c => c[0] === 'open').length, 1);
    // Only receipt of a confirmed completion authorizes acknowledgement, never pending recovery.
    await cold.acknowledge(source, CONNECTION, p.operation, async () => {});
    assert.equal(f.session[PEEK_RECEIPTS_KEY].length, 0);
    assert(await cold.prepare(source, 'https://target.test/original', next, PEER, 'g', async () => {}));
});
test('unknown create receipt cannot be acknowledged and blocks new workers without retry', async () => {
    const f = fixture(), p = await f.prepare(); f.store.transientWindows.openUnlocked = async () => { f.calls.push(['open']); throw Error('unknown create'); };
    await assert.rejects(f.execute(p.operation)); const cold = createPeekService(f.store, f.api);
    await assert.rejects(cold.acknowledge(source, CONNECTION, p.operation, async () => {}));
    await assert.rejects(cold.prepare(source, 'https://target.test/original', crypto.randomUUID(), PEER, 'g', async () => {}));
    assert.equal(f.calls.length, 1); assert.equal(f.session[PEEK_RECEIPTS_KEY][0].phase, 'pending');
});
for (const fault of ['write', 'readback', 'malformed']) test(`receipt ${fault} fails closed before native dispatch`, async () => {
    const f = fixture(), p = await f.prepare();
    if (fault === 'write') f.api.storage.session.set = async () => { throw Error('write failed'); };
    if (fault === 'readback') f.api.storage.session.set = async () => {};
    if (fault === 'malformed') f.session[PEEK_RECEIPTS_KEY] = { corrupt: true };
    await assert.rejects(f.execute(p.operation)); assert.equal(f.calls.length, 0);
});
test('receipt readback accepts recursively reordered object keys without weakening field comparison',async()=>{
    const f=fixture(),p=await f.prepare();
    const reorder=v=>Array.isArray(v)?v.map(reorder):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).reverse().map(([k,value])=>[k,reorder(value)])):v;
    f.api.storage.session.get=async()=>reorder(structuredClone(f.session));
    assert.equal((await f.execute(p.operation)).completed,true);
    await f.service.acknowledge(source,CONNECTION,p.operation,async()=>{});
    assert.equal(f.session[PEEK_RECEIPTS_KEY].length,0);
});
test('receipt readback with a changed valid field fails closed before create',async()=>{
    const f=fixture(),p=await f.prepare();f.api.storage.session.set=async values=>{Object.assign(f.session,structuredClone(values));f.session[PEEK_RECEIPTS_KEY][0].url='https://changed.test/';};
    await assert.rejects(f.execute(p.operation));assert.equal(f.calls.length,0);
});
for (const sender of [{ id: SELF }, { id: PEER, tab: { id: 1 } }, { id: PEER, url: 'https://evil.test/' }, { id: PEER, url: `chrome-extension://${PEER}/options.html` }, { id: PEER, origin: 'https://evil.test' }]) test('rejects unattested external source ' + JSON.stringify(sender), async () => {
    const f = fixture(); registerPeek(f.store, f.api);
    const result = await new Promise(resolve => f.api.listener({ type: PEEK_TYPE, action: 'capability', source }, sender, resolve));
    assert.equal(result.success, false); assert.equal(f.calls.length, 0);
});
