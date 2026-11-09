import { encodeFavoriteContinuityState as encode } from './favorite-continuity.js';
import { explicitTodayEpochs } from './explicit-today-ownership.js';
import { RECOVERY_OBSERVATION_TYPE, validateRecoveryReport } from './recovery-report-protocol.js';

export { RECOVERY_OBSERVATION_TYPE } from './recovery-report-protocol.js';
const LOCAL_KEYS = ['spaces', 'spaceModelVersion', 'spaceTabSnapshot', 'spaceWindowSnapshot', 'persistentFavorites', 'spaceSavedMoveJournal', 'archiveReopenClaims', 'spaceDurableTodayLayout'];
const SESSION_KEYS = ['spaceSession', 'activeSpaces', 'spaceRestoreQueue', 'spaceRecoveryCandidates', 'spaceWindowKeys', 'spaceRestoreWindowKeys', 'favoriteSession'];
const clone = value => structuredClone(value);
const array = value => Array.isArray(value) ? value : [];
const unavailable = () => Object.assign(new Error('Recovery status is unavailable. No recovery action was requested.'), { code: 'RECOVERY_STATUS_UNAVAILABLE' });

// This observer never initializes/reconciles the stores, calls their queryTabs
// wrapper, invokes the matcher, persists a checkpoint, or writes browser data.
// Its in-memory counter measures observed events, not a durable model revision.
export function createRecoveryObserver(store, api = chrome, { now = Date.now, monotonicNow = () => Math.floor(performance.now()), workerId = crypto.randomUUID(), layoutDetails = false } = {}) {
    let revision = 0, sequence = 0, disposed = false;
    const listeners = [];
    const changed = () => { revision++; };
    for (const event of [api.tabs?.onCreated, api.tabs?.onRemoved, api.tabs?.onUpdated, api.tabs?.onMoved,
        api.tabs?.onDetached, api.tabs?.onAttached, api.tabs?.onReplaced, api.windows?.onCreated,
        api.windows?.onRemoved, api.storage?.onChanged,
        ...(layoutDetails ? [api.bookmarks?.onMoved, api.bookmarks?.onRemoved, api.bookmarks?.onChanged, api.bookmarks?.onCreated] : [])]) {
        if (event?.addListener) { event.addListener(changed); listeners.push(() => event.removeListener(changed)); }
    }
    function memory() {
        return clone({ initialized: store.initialized === true, spaces: array(store.spaces), active: store.active || {},
            restoreQueue: array(store.restoreQueue), recoveryCandidates: [...(store.recoveryCandidates || [])],
            provisional: [...(store.provisional || [])], restoredRanks: [...(store.restoredRanks || [])],
            windowKeys: [...(store.windowKeys || [])], restoreWindowKeys: [...(store.restoreWindowKeys || [])],
            snapshotByTab: [...(store.snapshotByTab || [])],
            pendingCreations: [...(store.pendingCreations || [])], archivePending: [...(store.archiveStore?.pendingCreatedIds || [])],
            durableLayout: store.durableLayout || null, layoutPending: [...(store.layoutPending || [])],
            ...(layoutDetails ? { automaticLayoutRestore: store.automaticLayoutRestore !== false,
                explicitToday: [...(store.explicitToday || [])], explicitTodayEpoch: store.explicitTodayEpoch || null,
                explicitTodayEpochs: store.explicitTodayEpochs || null,
                favoriteRecovery: { active: store.favoriteStore?.recovery?.active === true,
                    entries: array(store.favoriteStore?.recovery?.entries).map(({tabId,windowId,phase})=>({tabId,windowId,phase})) } } : {}),
            favoriteInitialized: store.favoriteStore?.initialized === true,
            favoriteDirty: store.favoriteStore?.persistenceDirty === true,
            favorites: array(store.favoriteStore?.items), favoriteState: store.favoriteStore?.state ?? null,
            transient: store.transientWindows?.observationState?.() ?? null });
    }
    // Only the selected layout report needs these extra read-only checks. The
    // aggregate reader retains its existing read surface. No epoch is created.
    const bookmarkRoots = async () => {
        const ids = [...new Set(array(store.spaces).map(s=>s.bookmarkFolderId).filter(id=>typeof id==='string'&&id.length))];
        if (ids.length > 200 || !api.bookmarks?.get || !api.bookmarks?.search
            || [api.bookmarks.onMoved,api.bookmarks.onRemoved,api.bookmarks.onChanged,api.bookmarks.onCreated].some(event=>!event?.addListener||!event?.removeListener)) return null;
        const root = (await api.bookmarks.search({title:'Arcify'})).find(node=>!node.url);
        return Promise.all(ids.map(async id=>{
            try { const [folder] = await api.bookmarks.get(id);
                return [id, Boolean(folder && !folder.url && root && String(folder.parentId)===String(root.id))];
            } catch { return [id, false]; }
        }));
    };
    const reads = async () => {
        const [local, session, tabs, windows, groupSyncSetting] = await Promise.all([
            api.storage.local.get(layoutDetails ? [...LOCAL_KEYS,'pinnedTabStatesById'] : LOCAL_KEYS), api.storage.session.get(SESSION_KEYS),
            api.tabs.query({}), api.windows.getAll({ populate: false }),
            api.storage.sync?.get ? api.storage.sync.get('syncTabGroups') : Promise.resolve(null)
        ]);
        const decorate = tab => ({ ...tab, knownTransient: store.transientWindows?.isKnownExcluded?.(tab) === true,
            ...(layoutDetails ? {knownGlobal: Boolean(store.isGlobalTab?.(tab)), knownGlobalId: Boolean(store.isGlobalTab?.(tab.id)), effectiveTransient: Boolean(store.isTransientTab?.(tab))} : {}) });
        const layoutChecks = layoutDetails ? { currentEpochs: await explicitTodayEpochs(store, api), bookmarkRoots: await bookmarkRoots(),
            tabs: array(tabs).filter(tab=>tab.incognito===false).map(decorate),
            windows: array(windows).filter(w=>w.incognito===false).map(({id,type,incognito})=>({id,type,incognito})) } : null;
        // Keep private-window data out of the policy input as well as the output.
        const eligibleWindows = array(windows).filter(w => w.type === 'normal' && w.incognito === false);
        const ids = new Set(eligibleWindows.map(w => w.id));
        return { local, session, ...(layoutDetails ? {layoutChecks} : {}), groupSyncEnabled:groupSyncSetting===null?null:typeof groupSyncSetting.syncTabGroups==='boolean'
            ?groupSyncSetting.syncTabGroups:groupSyncSetting.syncTabGroups===undefined?false:null,
            tabs: array(tabs).filter(t => t.incognito === false && ids.has(t.windowId))
            .map(decorate),
            windows: eligibleWindows.map(({ id, type, incognito }) => ({ id, type, incognito })) };
    };
    const comparable = input => ({ ...input,
        tabs: input.tabs.map(({ id, windowId, index, url, pendingUrl, pinned, groupId, splitViewId, knownTransient, knownGlobal, knownGlobalId, effectiveTransient }) =>
            ({ id, windowId, index, url, pendingUrl, pinned, groupId, splitViewId, knownTransient, knownGlobal, knownGlobalId, effectiveTransient })).sort((a,b) => a.id-b.id),
        windows: [...input.windows].sort((a,b) => a.id-b.id) });
    async function capture() {
        if (disposed) throw unavailable();
        const startedAt = now(), observedAtMs = monotonicNow(), startRevision = revision, beforeMemory = memory();
        const first = await reads(), second = await reads(), afterMemory = memory();
        if (disposed) throw unavailable();
        const stable = revision === startRevision && encode(comparable(first)) === encode(comparable(second))
            && encode(beforeMemory) === encode(afterMemory);
        return { schema: 'arcify-recovery-observation-v1', startedAt, capturedAt: now(),
            observedAtMs, completedAtMs: monotonicNow(),
            revision: { workerId, sequence: ++sequence, start: startRevision, end: revision },
            stable, atomic: false, scope: afterMemory.initialized ? 'live-store' : 'persisted-projection',
            memory: afterMemory, ...second };
    }
    return {
        // Do not substitute SpaceStore.run: it has write-producing preambles.
        capture() {
            const pending = store.chain.then(capture);
            store.chain = pending.catch(() => {});
            return pending;
        },
        dispose() { disposed = true; for (const remove of listeners) remove(); }
    };
}

export function trustedRecoveryReader(api, sender) {
    if (!sender || sender.id !== api.runtime.id || sender.frameId !== undefined && sender.frameId !== 0
        || sender.documentLifecycle !== undefined && sender.documentLifecycle !== 'active'
        || sender.tab?.incognito === true) return false;
    const root = api.runtime.getURL('');
    if (sender.origin !== undefined && sender.origin !== root.slice(0, -1)) return false;
    return ['options.html', 'sidebar.html'].some(page => sender.url === api.runtime.getURL(page));
}

// The policy adapter must return an allowlisted aggregate report. Raw capture
// evidence remains inside the worker and must never be returned to the UI.
export function registerRecoveryObservation(store, api, summarize) {
    const observer = createRecoveryObserver(store, api);
    const listener = (message, sender, respond) => {
        if (message?.type !== RECOVERY_OBSERVATION_TYPE) return false;
        if (!trustedRecoveryReader(api, sender) || Object.keys(message).length !== 1) {
            respond({ success: false, error: 'Recovery status is available only from Arcify settings or its sidebar.' });
            return false;
        }
        observer.capture().then(snapshot => summarize(snapshot)).then(validateRecoveryReport).then(report => respond({ success: true, report }),
            () => respond({ success: false, error: unavailable().message }));
        return true;
    };
    api.runtime.onMessage.addListener(listener);
    return () => { observer.dispose(); api.runtime.onMessage.removeListener(listener); };
}
