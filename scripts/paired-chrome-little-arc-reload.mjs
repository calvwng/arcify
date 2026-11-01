/** Import-safe native reload-boundary assertions. No runtime or browser-launch changes. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {encodeFavoriteContinuityState as encode} from '../favorite-continuity.js';

/** Snapshot replay may issue current authority, but cannot change its saved owner. */
export function assertReloadSavedOwners(before, after, excluded=[], spotlightId) {
    const rows=state=>state.savedSnapshot.filter(row=>!excluded.includes(row.tabId));
    const prior=rows(before),next=rows(after);
    assert.equal(next.length,prior.length);
    const uuid=value=>assert.match(value,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    const existingTokens=new Set(before.savedSnapshot.flatMap(row=>row.currentOwnership?[row.currentOwnership.incarnation,row.currentOwnership.transaction]:[]));
    const newIncarnations=new Set(),newTransactions=new Set();
    let live;
    const replayProof=()=>{
        if(live)return live;
        const stamp=before.continuityStamp,receipt=before.continuityReceipt,afterReceipt=after.continuityReceipt;
        assert(stamp&&receipt&&afterReceipt,'New ownership requires independently captured replay evidence.');
        assert.deepEqual(Object.keys(stamp).sort(),['version','epoch','generation','liveCount','fingerprint'].sort());
        assert.equal(stamp.version,1);assert(Number.isSafeInteger(stamp.liveCount)&&stamp.liveCount>=0&&stamp.liveCount<=before.savedSnapshot.length);
        for(const state of [before,after]){
            const value=state.continuityReceipt;
            assert.equal(value.version,1);assert.equal(value.schema,'exact-global-favorites-v2');assert(value.phase===undefined||value.phase==='committed');
            assert.equal(value.epoch,stamp.epoch);assert.equal(value.generation,stamp.generation);uuid(value.epoch);uuid(value.generation);
            assert(Number.isSafeInteger(value.revision)&&value.revision>=0);assert.match(value.fingerprint,/^[a-f0-9]{64}$/);
            assert.equal(value.fingerprint,createHash('sha256').update(encode(state.favoriteSession)).digest('hex'),'Browser receipt must bind its independently read session state.');
        }
        assert.equal(afterReceipt.peerId,receipt.peerId);assert.match(receipt.peerId,/^[a-p]{32}$/);
        assert.equal(receipt.peerId,spotlightId,'Replay must belong to the exact paired Spotlight build.');
        live=before.savedSnapshot.slice(0,stamp.liveCount);
        assert.equal(new Set(live.map(row=>row.tabId)).size,live.length);
        assert.equal(stamp.fingerprint,createHash('sha256').update(encode({epoch:stamp.epoch,generation:stamp.generation,liveCount:stamp.liveCount,live})).digest('hex'));
        return live;
    };
    for(let index=0;index<prior.length;index++){
        const old=prior[index],row=next[index];
        const stable=({order,tabIndex,windowKey,currentOwnership,...value})=>value;
        assert.deepEqual(stable(row),stable(old),'Reload cannot change stable saved owner fields.');
        if(Object.hasOwn(old,'currentOwnership')){assert.deepEqual(row.currentOwnership,old.currentOwnership);continue;}
        if(!Object.hasOwn(row,'currentOwnership'))continue;
        assert(replayProof().some(value=>value===old),'Historical suffix is not current replay authority.');
        const witness=row.currentOwnership;
        assert(witness&&Object.getPrototypeOf(witness)===Object.prototype);
        assert.deepEqual(Object.keys(witness).sort(),['version','epoch','incarnation','transaction','windowId','spaceId','bookmarkFolderId'].sort());
        assert.equal(witness.version,1);assert.deepEqual(witness.epoch,{kind:'browser',epoch:before.continuityStamp.epoch,generation:before.continuityStamp.generation});
        const native=exact(before.tabs,row.tabId),kept=exact(after.tabs,row.tabId);
        for(const key of ['id','windowId','url','pendingUrl','pinned','incognito','splitViewId','groupId'])assert.deepEqual(kept[key],native[key]);
        assert.equal(native.url,row.url);assert(!native.pendingUrl&&!native.pinned&&!native.incognito);assert.equal(native.splitViewId??-1,-1);
        for(const state of [before,after]){
            assert.deepEqual(owners(state,row.tabId),[{spaceId:row.spaceId,section:'temporaryTabs'}]);
            assert(!state.registry.records.some(record=>record.memberTabIds?.includes(row.tabId)||record.tabId===row.tabId||record.controllerTabId===row.tabId));
            assert(!Object.hasOwn(state.bindings,String(row.tabId)));
            assert(![...(state.favoriteSession?.bindings||[]),...(state.favoriteSession?.attempts||[])].some(value=>value.tabId===row.tabId));
            const space=exact(state.spaces,row.spaceId),window=exact(state.windows,native.windowId);
            assert.equal(state.spaces.filter(s=>s.bookmarkFolderId===space.bookmarkFolderId).length,1);
            assert.equal(window.type,'normal');assert(!window.incognito);
            assert.equal(witness.spaceId,space.id);assert.equal(witness.bookmarkFolderId,space.bookmarkFolderId);
        }
        assert.equal(row.section,'temporaryTabs');assert(!row.pinnedState);assert.equal(witness.windowId,native.windowId);
        uuid(witness.incarnation);uuid(witness.transaction);
        assert(!existingTokens.has(witness.incarnation)&&!existingTokens.has(witness.transaction));
        assert(!newIncarnations.has(witness.incarnation)&&!newTransactions.has(witness.incarnation)&&!newIncarnations.has(witness.transaction)&&witness.incarnation!==witness.transaction);
        newIncarnations.add(witness.incarnation);newTransactions.add(witness.transaction); // One replay batch legitimately shares a transaction.
    }
}

export const LITTLE_ARC_NATIVE_UNVERIFIED = Object.freeze([
    'intact-controller same-window orphan recovery',
    'abandonment of an orphan recovery choice',
    'stale orphan selection rejection',
    'explicit duplicate-ID recovery without movement',
    'chosen-only promotion after orphan recovery'
]);
const exact = (items, id) => { const found = items.filter(item => item.id === id); assert.equal(found.length, 1, `Require one exact native identity ${id}.`); return found[0]; };
const sorted = ids => [...ids].sort((a, b) => a - b);
const owners = (state, id) => state.spaces.flatMap(space => ['spaceBookmarks', 'temporaryTabs'].flatMap(section => (space[section] || []).filter(value => value === id).map(() => ({ spaceId: space.id, section }))));

/** Installed in the unaffected peer document, with no transport or API wrappers. */
export function installLittleArcReloadObservation({ nonce }) {
    if (globalThis.__littleArcReloadObservation) throw new Error('Reload observer is already installed.');
    const events = [], registrations = [];
    const observation = { nonce, document, timeOrigin: performance.timeOrigin, events, overflow: false, captureError: false, stopped: false };
    const sources = [
        ['tabs', ['onCreated', 'onRemoved', 'onReplaced', 'onActivated', 'onAttached', 'onDetached', 'onMoved', 'onUpdated']],
        ['windows', ['onCreated', 'onRemoved', 'onFocusChanged']],
        ['tabGroups', ['onCreated', 'onUpdated', 'onMoved', 'onRemoved']],
        ['bookmarks', ['onCreated', 'onRemoved', 'onChanged', 'onMoved']]
    ].flatMap(([api, names]) => names.map(name => ({ event: chrome[api]?.[name], type: `${api}.${name}` })));
    for (const { event, type } of sources) {
        if (!event?.addListener || !event.removeListener || !event.hasListener) throw new Error(`Missing native observer ${type}.`);
    }
    try { for (const { event, type } of sources) {
        const listener = (...data) => {
            if (events.length >= 2000) { observation.overflow = true; return; }
            try { events.push({ type, data: structuredClone(data) }); }
            catch { observation.captureError = true; }
        };
        event.addListener(listener); registrations.push({ event, listener });
    } } catch (error) { for (const { event, listener } of registrations) event.removeListener(listener); throw error; }
    observation.intact = () => registrations.every(({ event, listener }) => event.hasListener(listener));
    observation.stop = () => { observation.stopped = true; for (const { event, listener } of registrations) event.removeListener(listener); };
    globalThis.__littleArcReloadObservation = observation;
}
export async function readLittleArcReloadObservation() {
    const observation = globalThis.__littleArcReloadObservation;
    if (!observation) throw new Error('The continuous reload observer is missing.');
    return { nonce: observation.nonce, extensionId: chrome.runtime.id, tab: await chrome.tabs.getCurrent(),
        timeOrigin: performance.timeOrigin, sameDocument: observation.document === document && observation.timeOrigin === performance.timeOrigin,
        intact: observation.intact(), captureError: observation.captureError, overflow: observation.overflow, stopped: observation.stopped, events: observation.events };
}
export function stopLittleArcReloadObservation() {
    globalThis.__littleArcReloadObservation?.stop(); delete globalThis.__littleArcReloadObservation;
}
export function assertLittleArcReloadObservation(before, after, spotlightId) {
    for (const value of [before, after]) {
        assert.equal(value.extensionId, spotlightId); assert.equal(value.sameDocument, true); assert.equal(value.intact, true);
        assert.equal(value.captureError, false); assert.equal(value.overflow, false); assert.equal(value.stopped, false);
        assert(Number.isFinite(value.timeOrigin) && value.timeOrigin > 0); assert(value.nonce);
        assert(Number.isSafeInteger(value.tab?.id) && value.tab.id > 0);
    }
    assert.equal(after.nonce, before.nonce); assert.equal(after.timeOrigin, before.timeOrigin);
    for (const key of ['id', 'windowId', 'url', 'pinned', 'incognito']) assert.equal(after.tab[key], before.tab[key]);
    assert(after.events.length >= before.events.length);
    assert.deepEqual(after.events.slice(0, before.events.length), before.events, 'Native observations must never be reset across reload.');
    return after.events.slice(before.events.length);
}

/** Read-only identity, used both before granting onboarding cleanup ownership and before removal. */
export async function readLittleArcReloadDocument() {
    if (typeof chrome === 'undefined' || !chrome.tabs?.getCurrent || !chrome.runtime?.getContexts) return null;
    const tab = await chrome.tabs.getCurrent();
    if (!tab) return null;
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['TAB'], tabIds: [tab.id] });
    return { tab, extensionId: chrome.runtime.id, url: document.URL, timeOrigin: performance.timeOrigin,
        readyState: document.readyState, documentIds: contexts.map(context => context.documentId) };
}
export function assertLittleArcReloadDocument(value, { id, windowId, url, extensionId }) {
    assert.equal(value?.tab?.id, id, 'URL equality is not native cleanup ownership.'); assert.equal(value.tab.windowId, windowId);
    assert.equal(value.tab.url, url); assert(!value.tab.pendingUrl); assert.equal(value.tab.pinned, false); assert.equal(value.tab.incognito, false);
    assert.equal(value.tab.splitViewId ?? -1, -1); assert.equal(value.tab.groupId ?? -1, -1);
    assert.equal(value.extensionId, extensionId); assert.equal(value.url, url); assert.equal(value.readyState, 'complete');
    assert(Number.isFinite(value.timeOrigin) && value.timeOrigin > 0);
    assert.equal(value.documentIds.length, 1); assert.equal(typeof value.documentIds[0], 'string'); assert(value.documentIds[0]);
}
export function claimLittleArcReloadOnboarding({ before, after, events, settings, witness, arcifyId, windowId }) {
    const url = `chrome-extension://${arcifyId}/installation-onboarding.html`;
    assert(settings.version && settings.onboardingVersion !== settings.version, 'Require the actual update/version-mismatch onboarding branch.');
    assert(!before.tabs.some(tab => tab.url === url || tab.pendingUrl === url), 'Preexisting onboarding is not fixture-owned.');
    const created = events.filter(event => event.type === 'tabs.onCreated' && (event.data[0].pendingUrl || event.data[0].url) === url);
    assert.equal(created.length, 1, 'Require one exact onboarding creation observed during this reload.');
    const native = created[0].data[0]; assert(!before.tabs.some(tab => tab.id === native.id)); assert.equal(native.windowId, windowId);
    assert.equal(after.tabs.filter(tab => tab.url === url || tab.pendingUrl === url).length, 1);
    const tab = exact(after.tabs, native.id); assert.equal(tab.windowId, windowId); assert.equal(tab.url, url); assert(!tab.pendingUrl);
    const identity = { id: tab.id, windowId, url, extensionId: arcifyId }; assertLittleArcReloadDocument(witness, identity);
    return { ...identity, timeOrigin: witness.timeOrigin, documentIds: witness.documentIds,
        attribution: 'Passive corroboration: one new native creation during the observed reload, the actual onboarding version-mismatch branch, and exact runtime/document identity. Chrome tab events do not expose the API caller.' };
}
export function assertLittleArcReloadOnboardingUnchanged(witness, receipt) {
    assertLittleArcReloadDocument(witness, receipt);
    assert.equal(witness.timeOrigin, receipt.timeOrigin); assert.deepEqual(witness.documentIds, receipt.documentIds);
}

export function assertLittleArcMissingControllerReload(before, after, { record, twinId, oldApiTabId, newApiTabId, onboardingId, arcifyId, spotlightId, windowB, events }) {
    const pair = [record.tabId, twinId], removed = [record.controllerTabId, oldApiTabId], created = [newApiTabId, ...(onboardingId === null ? [] : [onboardingId])];
    assert.equal(new Set([...pair, ...removed, ...created]).size, pair.length + removed.length + created.length);
    const originalController = exact(before.tabs, record.controllerTabId), oldOptions = exact(before.tabs, oldApiTabId);
    assert.equal(originalController.windowId, record.windowId);
    assert.equal(originalController.url, `chrome-extension://${arcifyId}/transient-window.html?token=${record.token}`);
    assert(!originalController.pendingUrl);
    assert.equal(oldOptions.url, `chrome-extension://${arcifyId}/options.html`);
    const newOptions = exact(after.tabs, newApiTabId);
    assert.equal(newOptions.url, oldOptions.url); assert.equal(newOptions.windowId, oldOptions.windowId); assert(!newOptions.pendingUrl);
    assert.equal(newOptions.pinned, false); assert.equal(newOptions.incognito, false);
    const authority = before.registry.records.filter(value => value.token === record.token);
    assert.equal(authority.length, 1); assert.equal(authority[0].phase, 'ready');
    for (const key of ['controllerTabId', 'tabId', 'windowId', 'originWindowId']) assert.equal(authority[0][key], record[key], 'Creation of the twin cannot rebind prior authority.');
    assert.deepEqual(sorted(authority[0].memberTabIds), sorted([record.controllerTabId, ...pair]));
    assert(before.journal.some(entry => entry.response?.ok === true && entry.response.token === record.token
        && entry.response.tabId === record.tabId && entry.response.transientWindowId === record.windowId), 'Require genuine pre-reload committed session authority.');
    assert.deepEqual(before.sessionPresence, { registry: true, journal: true });
    for (const key of ['registry', 'journal']) assert.equal(typeof after.sessionPresence[key], 'boolean');
    assert.deepEqual(after.registry, { version: 1, records: [] }, 'Full reload must leave no old or replacement transient authority.');
    assert.deepEqual(after.journal, [], 'Old bridge receipts cannot survive full extension reload.');
    assert(!after.tabs.some(tab => tab.id === record.controllerTabId));
    const marker = `chrome-extension://${arcifyId}/transient-window.html`;
    assert(!after.tabs.some(tab => [tab.url, tab.pendingUrl].some(url => url?.startsWith(marker))), 'No controller marker may be recreated or rebound.');
    assert.deepEqual(sorted(after.tabs.map(tab => tab.id)), sorted(before.tabs.filter(tab => !removed.includes(tab.id)).map(tab => tab.id).concat(created)), 'Every extra, replaced or missing native tab is fatal.');
    assert.deepEqual(sorted(after.windows.map(window => window.id)), sorted(before.windows.map(window => window.id)));
    assert.deepEqual(after.groups, before.groups);
    for (const tab of before.tabs.filter(tab => !removed.includes(tab.id))) {
        const kept = exact(after.tabs, tab.id);
        for (const key of ['windowId', 'url', 'pendingUrl', 'pinned', 'incognito', 'groupId', 'splitViewId']) assert.deepEqual(kept[key], tab[key]);
        if (pair.includes(tab.id)) assert.deepEqual(owners(before, tab.id), [], 'Both pages must be unowned before genuine session loss.');
        else assert.deepEqual(owners(after, tab.id), owners(before, tab.id));
    }
    assert.equal(exact(before.tabs, pair[0]).url, exact(before.tabs, pair[1]).url);
    assert.notEqual(before.pageStates[pair[0]].documentId, before.pageStates[pair[1]].documentId);
    for (const [id, document] of Object.entries(before.pageStates)) {
        assert.deepEqual(after.pageStates[id], document, `Native ${id} must retain its document, references and unsaved form.`);
        for (const key of ['sameDocument', 'sameInput', 'sameNotes', 'topLevel']) assert.equal(after.pageStates[id][key], true);
        assert.equal(after.pageStates[id].frameCount, 0);
    }
    for (const id of pair) {
        assert.equal(exact(after.tabs, id).windowId, record.windowId);
        const membership = owners(after, id); assert.equal(membership.length, 1); assert.equal(membership[0].section, 'temporaryTabs');
        const saved = after.savedSnapshot.filter(value => value.tabId === id); assert.equal(saved.length, 1);
        assert.equal(saved[0].spaceId, membership[0].spaceId); assert.equal(saved[0].section, 'temporaryTabs');
        const snapshot = after.snapshots[record.windowId]; assert.equal(snapshot.windowId, record.windowId);
        assert.equal(exact(snapshot.tabs, id).spaceId, membership[0].spaceId);
        const projected = snapshot.spaces.flatMap(space => (space.temporaryTabIds || []).filter(value => value === id).map(() => space.id));
        assert.deepEqual(projected, [membership[0].spaceId]);
        assert(!Object.hasOwn(after.bindings, String(id)));
        assert(![...(after.favoriteSession?.bindings || []), ...(after.favoriteSession?.attempts || [])].some(value => value.tabId === id));
    }
    const shape = state => state.spaces.map(({ lastTab, temporaryTabs, ...space }) => ({ ...space, temporaryTabs: temporaryTabs.filter(id => !pair.includes(id)) }));
    assert.deepEqual(shape(after), shape(before), 'Only the two ordinary Today admissions may change Space ownership.');
    // Native strip indices/session window keys can change on reload, but saved live ownership cannot.
    assertReloadSavedOwners(before,after,pair,spotlightId);
    assert.deepEqual(exact(after.windows, windowB), exact(before.windows, windowB));
    assert.deepEqual(after.tabs.filter(tab => tab.windowId === windowB), before.tabs.filter(tab => tab.windowId === windowB));
    const snapshot = value => { const { capturedAt, ...rest } = value; return rest; };
    assert.deepEqual(snapshot(after.snapshots[windowB]), snapshot(before.snapshots[windowB]));
    assert.deepEqual(after.activeSpaces[windowB], before.activeSpaces[windowB]);
    assert.deepEqual(sorted(events.filter(event => event.type === 'tabs.onCreated').map(event => event.data[0].id)), sorted(created));
    assert.deepEqual(sorted(events.filter(event => event.type === 'tabs.onRemoved').map(event => event.data[0])), sorted(removed));
    assert(!events.some(event => /^(?:tabs\.(?:onReplaced|onAttached|onDetached|onMoved)|windows\.(?:onCreated|onRemoved)|tabGroups\.|bookmarks\.)/.test(event.type)), 'No native replay, transfer, grouping or saved-data mutation may occur.');
    assert(!events.some(event => event.type === 'tabs.onActivated' && event.data[0].windowId === windowB
        || event.type === 'windows.onFocusChanged' && event.data[0] === windowB), 'Window B cannot be activated even temporarily.');
    for (const event of events.filter(event => event.type === 'tabs.onUpdated')) {
        const [id, change] = event.data;
        assert(![change.url, change.pendingUrl].some(url => url?.startsWith(marker)), 'A transient marker cannot reappear even temporarily.');
        if (!created.includes(id) && !removed.includes(id)) assert(!(['url', 'pendingUrl', 'pinned', 'splitViewId', 'groupId', 'windowId', 'incognito'].some(key => key in change) || change.status === 'loading'), 'Protected pages cannot navigate or reload.');
    }
    return { ordinaryTabIds: pair, removedControllerTabId: record.controllerTabId, noNativeReplayEffects: true,
        transportLimit: 'The unaffected peer observes native effects continuously, not all Arcify internal messages. No recover/promote input is issued in this scenario.' };
}
