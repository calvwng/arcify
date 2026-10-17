/** Actual consumer -> provider Split round trips, with only browser APIs mocked. */
import assert from 'node:assert/strict';
import { fixture } from '../../tests/unit/spotlight-action-fixture.js';
import { SPLIT_ACTIONS_FEATURE } from '../../spotlight-bridge-protocol.js';
const event = () => { const listeners = new Set(); return { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn), emit: (...args) => listeners.forEach(fn => fn(...args)) }; };
export async function assertSplitActionRoundTrips({ ArcifySplitActionsClient }) {
    const original = globalThis.chrome;
    try {
        for (const sourceId of [1,3]) {
            const f = fixture(); f.windows[0].focused = true;
            for (const tab of f.tabs) Object.assign(tab, { groupId: -1, pinned: false, splitViewId: -1, status: 'complete' });
            f.tabs.find(tab => tab.id === 3).index = 3;
            f.tabs.push({ id: 4, windowId: 10, index: 2, title: 'Middle', url: 'https://same.test/', active: false, groupId: -1, pinned: false, splitViewId: -1, status: 'complete' });
            f.store.spaces[0].temporaryTabs = [1,4,3]; f.active(sourceId);
            chrome.tabs.onMoved = event();
            chrome.tabs.move = async (id, { index }) => {
                const tab = f.tabs.find(tab => tab.id === id), fromIndex = tab.index;
                const window = f.tabs.filter(tab => tab.windowId === 10 && tab.id !== id).sort((a,b) => a.index-b.index); window.splice(index,0,tab); window.forEach((tab,index) => { tab.index=index; });
                f.effects.push(['move',id,index]); chrome.tabs.onMoved.emit(id, { windowId:10,fromIndex,toIndex:index }); return structuredClone(tab);
            };
            chrome.tabs.createSplit = async ids => { f.effects.push(['createSplit', [...ids]]); for (const id of ids) { f.tabs.find(tab => tab.id === id).splitViewId=0; chrome.tabs.onUpdated.emit(id, { splitViewId:0 }); } return 0; };
            chrome.tabs.unsplit = async splitId => { f.effects.push(['unsplit',splitId]); for (const tab of f.tabs.filter(tab => tab.splitViewId === splitId)) { tab.splitViewId=-1; chrome.tabs.onUpdated.emit(tab.id, { splitViewId:-1 }); } };
            const api = { storage: { local: { get: async () => ({ arcifyBridgePeerId: chrome.runtime.id, arcifyBridgePairingGeneration: 'spotlight-generation' }) } } };
            const sent = [], bridge = { getPeerId: async () => chrome.runtime.id, serializeAction: operation => operation(), timeoutMs:1000 };
            const send = async (peerId, command, payload) => {
                assert.equal(peerId, chrome.runtime.id); sent.push(command);
                const response = await f.handle({ ...f.request(command), ...payload }, f.sender);
                if (!response.ok) throw Object.assign(new Error(response.error.message), { code:response.error.code }); return response;
            };
            const client = new ArcifySplitActionsClient(api, bridge, send), source = { windowId:10,tabId:sourceId };
            const scope = await client.read(source); assert.equal(scope.context.sourceTabId,sourceId); assert.equal(scope.context.pair.length,0);
            assert.equal(scope.context.pairingGeneration,'generation-1'); assert.equal(scope.generation,'spotlight-generation');
            const target = scope.targets.find(tab => tab.id === (sourceId === 1 ? 3 : 1)); assert(target);
            const created = await client.execute(source,scope,'createSplitView',{target});
            assert.deepEqual(created, { action:'create',windowId:10,spaceId:'space',sourceTabId:sourceId,tabIds:[1,3],splitViewId:0,reordered:true });
            assert.equal(f.tabs.find(tab => tab.windowId === 10 && tab.active).id,sourceId);
            const end = await client.read(source); assert.deepEqual(end.targets,[]); assert.deepEqual(end.context.pair.map(tab => tab.id),[1,3]);
            const ended = await client.execute(source,end,'endSplitView',{}); assert.deepEqual(ended,{...created,action:'end',splitViewId:-1,reordered:false});
            assert.equal(sent.filter(command => command === 'createSplitView').length,1); assert.equal(sent.filter(command => command === 'endSplitView').length,1);
            assert.deepEqual(f.effects.filter(([kind]) => ['move','createSplit','unsplit'].includes(kind)), [['move',3,1],['createSplit',[1,3]],['unsplit',0]]);
            assert.equal(f.tabs.find(tab => tab.windowId === 20).active,true);
            await assert.rejects(client.execute(source,end,'endSplitView',{})); assert.equal(sent.filter(command => command === 'endSplitView').length,1);
            const unsupported = await f.handle({ ...f.request('hello'),supportedFeatures:[SPLIT_ACTIONS_FEATURE] },f.sender); assert(unsupported.capabilities.includes(SPLIT_ACTIONS_FEATURE));
            delete chrome.tabs.unsplit; assert.equal(await client.read(source),null);
        }
    } finally { if (original === undefined) delete globalThis.chrome; else globalThis.chrome=original; }
}
