import { encodeFavoriteContinuityState as encode } from './favorite-continuity.js';
import { EXPLICIT_TODAY_CHECKPOINT, readExplicitCheckpoint, explicitTodayEpochs, validExplicitWitness } from './explicit-today-ownership.js';
import { DURABLE_LAYOUT_KEY, readDurableLayout, sealDurableLayout, layoutWindows, layoutEvidence, layoutEligible, layoutSpaceRoot } from './durable-today-layout.js';
import { getSpaceBookmarkFolder } from './space-bookmarks.js';
import { PEER_KEY, PAIRING_GENERATION_KEY } from './spotlight-bridge-protocol.js';

const keys = ['spaces', 'spaceTabSnapshot', 'spaceRankCheckpoint', EXPLICIT_TODAY_CHECKPOINT, DURABLE_LAYOUT_KEY];
const metadataKeys = ['pinnedTabStatesById', 'tabNameOverridesById'];
const membership = spaces => spaces?.map(s => ({ id: s.id, root: s.bookmarkFolderId,
    today: s.temporaryTabs, saved: s.spaceBookmarks }));
const native = (store,tabs) => tabs.map(t => ({ eligible: !!layoutEligible(store,t), id: t.id, windowId: t.windowId, index: t.index, url: t.url,
    pendingUrl: t.pendingUrl, pinned: t.pinned, incognito: t.incognito, splitViewId: t.splitViewId }))
    .sort((a,b) => a.id - b.id);
const same = (a,b) => encode(a) === encode(b);
const validMetadata = metadata => metadataKeys.every(key => metadata[key] === undefined
    || metadata[key] && typeof metadata[key] === 'object' && !Array.isArray(metadata[key]));

// Temporary invalidation, not a lock or a substitute for the fresh reads below.
// A late asynchronous read must not hide a change to an earlier observation.
function validationEvents(invalidate) {
    const events = [[chrome.storage.onChanged,(changes,area) => {
        if (Object.keys(changes).some(key => keys.includes(key) || metadataKeys.includes(key)
            || key.startsWith('space') || key.startsWith('favorite')
            || [PEER_KEY,PAIRING_GENERATION_KEY,'invertTabOrder'].includes(key))) invalidate();
    }], [chrome.tabs.onUpdated,(_id,changes) => {
        if (['url','pendingUrl','pinned','splitViewId','status'].some(key => key in changes)) invalidate();
    }]];
    for (const key of ['onCreated','onRemoved','onReplaced','onMoved','onAttached','onDetached'])
        events.push([chrome.tabs[key],invalidate]);
    for (const key of ['onCreated','onRemoved','onMoved','onChanged'])
        events.push([chrome.bookmarks[key],invalidate]);
    events.push([chrome.windows.onRemoved,invalidate]);
    return events;
}
const canObserve = () => validationEvents(() => {}).every(([event]) => event?.addListener && event.removeListener);
function observeValidation() {
    let changed = false;
    const installed = [];
    const stop = () => { for (const [event,listener] of installed) event.removeListener(listener); };
    try {
        for (const [event,listener] of validationEvents(() => { changed = true; })) {
            if (!event?.addListener || !event.removeListener) throw new Error('Proven context observation is unavailable.');
            installed.push([event,listener]); event.addListener(listener);
        }
    } catch (error) { stop(); throw error; }
    return { stop, assertUnchanged() { if (changed) throw new Error('Proven context changed during validation.'); } };
}

// A representation repair is not a move, a new choice, or a historical match.
// Only an already committed complete explicit placement set can be narrowed.
// The cohort's numeric binding alone never supplies incarnation authority.
export async function prepareProvenContextRepair(store, tabs, snapshot, rankFingerprint) {
    if (!store.durableLayout || store.durableLayout.version===4 || store.automaticLayoutRestore === false || store.currentLayoutTransition
        || store.currentLayoutFence || store.layoutWriteFence || store.restoredMetadata?.length
        || !store.durableLayout.cohorts.some(c => c.explicitOnly && !c.contextSubset
            && c.binding && c.placements.length && c.signature.length > c.placements.length && !c.blockedBy?.length)) return null;
    if (!canObserve()) return null;
    const committed = await chrome.storage.local.get(keys);
    const layout = await readDurableLayout(committed[DURABLE_LAYOUT_KEY]);
    const proof = await readExplicitCheckpoint(committed);
    if (!layout || !proof || !same(layout,store.durableLayout)
        || layout.snapshotProof?.liveCount !== proof.live.length
        || layout.snapshotProof?.rankFingerprint !== committed.spaceRankCheckpoint.fingerprint
        || !same(membership(committed.spaces),membership(store.spaces))
        || !same(proof.history,store.restoreQueue)
        || !same(snapshot,proof.live)) return null;
    const epochs = await explicitTodayEpochs(store);
    const metadata = await chrome.storage.local.get(metadataKeys);
    if (!validMetadata(metadata)) return null;
    const originalMembership = structuredClone(membership(store.spaces));
    const originalRanks = structuredClone([...store.restoredRanks]);
    const originalNative = native(store,tabs);
    const originalWitnesses = structuredClone([...store.explicitToday || []]);
    const originalPending = [...store.layoutPending || []];
    const originalHistory = structuredClone(store.restoreQueue);
    const ranks = new Map(proof.ranks);
    const live = layoutWindows(store,tabs);
    const cohorts = structuredClone(layout.cohorts);
    const plans = [];
    const authentic = (c, p, currentTabs, currentEpochs, currentMetadata) => {
        const slot = c.signature.findIndex(t => t.index === p.index), id = c.binding.tabIds[slot];
        const matches = currentTabs.filter(t => t.id === id), tab = matches[0];
        const records = proof.live.filter(r => r.tabId === id), record = records[0];
        const currentRecords = snapshot.filter(r => r.tabId === id), currentRecord = currentRecords[0];
        const witness = store.explicitToday?.get(id), space = layoutSpaceRoot(store,p);
        const owners = store.spaces.flatMap(s => ['temporaryTabs','spaceBookmarks'].flatMap(section =>
            s[section].filter(value => value === id).map(() => ({s,section}))));
        return matches.length === 1 && records.length === 1 && currentRecords.length === 1
            && validExplicitWitness(witness,currentEpochs) && validExplicitWitness(record.currentOwnership,currentEpochs)
            && same(record.currentOwnership,witness) && same(currentRecord.currentOwnership,witness)
            && same(witness.epoch,c.binding.epoch) && witness.windowId === c.binding.windowId
            && witness.spaceId === p.spaceId && witness.bookmarkFolderId === p.bookmarkFolderId
            && layoutEligible(store,tab) && tab.windowId === c.binding.windowId
            && !(Number.isInteger(tab.splitViewId) && tab.splitViewId >= 0)
            && record.url === c.signature[slot].url && tab.url === record.url && currentRecord.url === record.url
            && record.tabIndex === p.index && currentRecord.tabIndex === tab.index
            && record.section === 'temporaryTabs' && currentRecord.section === 'temporaryTabs'
            && record.spaceId === p.spaceId && currentRecord.spaceId === p.spaceId
            && record.order === p.order && currentRecord.order === p.order && ranks.get(id) === p.order
            && store.restoredRanks.get(id) === p.order && space?.temporaryTabs.indexOf(id) === p.order
            && owners.length === 1 && owners[0].s === space && owners[0].section === 'temporaryTabs'
            && !record.pinnedState && !record.nameOverride && !currentRecord.pinnedState && !currentRecord.nameOverride
            && !currentMetadata.pinnedTabStatesById?.[id] && !currentMetadata.tabNameOverridesById?.[id]
            && !store.provisional?.has(id) && !store.recoveryCandidates?.has(id)
            && !store.restoredMetadata?.some(r => r.tabId === id);
    };
    for (const c of cohorts) {
        if (!c.explicitOnly || c.contextSubset || !c.binding || !c.placements.length
            || c.signature.length <= c.placements.length || c.blockedBy?.length || c.overrides.length
            || !epochs.some(epoch => same(epoch,c.binding.epoch))
            || !c.placements.every(p => authentic(c,p,tabs,epochs,metadata))) continue;
        const ids = c.placements.map(p => c.binding.tabIds[c.signature.findIndex(t => t.index === p.index)]);
        const w = live.find(w => w.id === c.binding.windowId);
        const selected = w?.tabs.filter(t => ids.includes(t.id));
        const savedOrder = c.binding.tabIds.filter(id => ids.includes(id));
        if (!selected || !same(selected.map(t => t.id),savedOrder)) continue;
        const successor = { id: crypto.randomUUID(), explicitOnly: true, contextSubset: true,
            choiceRevision: layout.revision + 1,
            signature: selected.map(t => ({ index: t.index, url: t.url, pinned: false })),
            placements: c.placements.map(p => ({ ...p, index: selected.find(t =>
                t.id === c.binding.tabIds[c.signature.findIndex(slot => slot.index === p.index)]).index })),
            binding: { ...structuredClone(c.binding), tabIds: selected.map(t => t.id) }, overrides: [] };
        c.blockedBy = [...c.blockedBy || [],successor.id];
        plans.push({ predecessor: c, successor });
    }
    if (!plans.length) return null;
    // Evaluate every successor against the complete final graph. Revision alone
    // never authorizes dominance over an unrelated or genuinely newer choice.
    cohorts.push(...plans.map(p => p.successor));
    const unambiguous = currentTabs => {
        const evidence = layoutEvidence(cohorts,layoutWindows(store,currentTabs));
        return plans.every(({successor}) => {
            const item = evidence.find(e => e.cohort.id === successor.id);
            return item?.status === 'ready' && item.matches[0].id === successor.binding.windowId;
        });
    };
    if (!unambiguous(tabs)) return null;
    const validate = async () => {
        const observation = observeValidation();
        try {
        for (const {predecessor:c} of plans) {
            const window = await chrome.windows.get(c.binding.windowId);
            if (window?.id !== c.binding.windowId || window.type !== 'normal' || window.incognito)
                throw new Error('Proven context changed before checkpoint.');
            for (const p of c.placements) await getSpaceBookmarkFolder(layoutSpaceRoot(store,p));
        }
        // These fresh reads occur after every awaited root/window validation.
        // Validate the whole epoch set, including secondary session witnesses.
        const freshMetadata = await chrome.storage.local.get(metadataKeys);
        const freshCommitted = await chrome.storage.local.get(keys);
        const currentTabs = await store.queryTabs({});
        const freshEpochs = await explicitTodayEpochs(store);
        if (!same(freshCommitted,committed) || !same(store.durableLayout,layout)
            || !same(freshEpochs,epochs) || !validMetadata(freshMetadata) || !same(freshMetadata,metadata)
            || !same(membership(store.spaces),originalMembership) || !same([...store.restoredRanks],originalRanks)
            || !same([...store.explicitToday || []],originalWitnesses) || !same([...store.layoutPending || []],originalPending)
            || !same(store.restoreQueue,originalHistory) || !same(native(store,currentTabs),originalNative)
            || store.currentLayoutTransition || store.currentLayoutFence || store.restoredMetadata?.length
            || !plans.every(({predecessor:c}) => c.placements.every(p => authentic(c,p,currentTabs,freshEpochs,freshMetadata)))
            || !unambiguous(currentTabs)) throw new Error('Proven context changed before checkpoint.');
        observation.assertUnchanged();
        } finally { observation.stop(); }
    };
    const repaired = await sealDurableLayout(layout.revision + 1,cohorts,{liveCount:snapshot.length,rankFingerprint});
    if (!await readDurableLayout(repaired)) return null;
    await validate();
    return { layout: repaired, validate };
}
