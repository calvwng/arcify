import { ArchiveStore } from './archive-store.js';
import { getTodayOrderInverted, getTodayInsertionIndex } from './today-order.js';
import { mergeVisibleOrder } from './sidebar-tabs.js';
import { normalizeSpaceIcon } from './space-icons.js';
import { SPACE_COLORS, normalizeCustomTint, normalizeSpaceColor } from './space-colors.js';
import { createFolder } from './folder-policy.js';
import { getSpaceBookmarkFolder } from './space-bookmarks.js';
import { moveSpace } from './space-order.js';
import { isStartupLauncherTab, isStartupLauncherUrl } from './startup-launcher-tab.js';
import { isPracticeUrl } from './tour-practice.js';
import { syncSpaceGroups } from './tab-group-sync.js';
import { hasNativeSplit, assertNotNativeSplit, assertNativeSplitMembershipPreserved } from './native-split-safety.js';
import { Utils } from './utils.js';
import { isProtectedFavorite } from './favorite-safety.js';
import { LocalStorage } from './localstorage.js';
import { checkpointSavedMove, recoverSavedMoveData, finishSavedMoveRecovery, recoverSavedMove } from './saved-move-store.js';
import { withSavedMoveLock, SAVED_MOVE_JOURNAL_KEY } from './saved-move-lock.js';
import { captureWindowTabs, matchRestoreRecord } from './space-restore.js';
import { SPACE_CONTINUITY_KEY, createSpaceContinuityStamp, readSpaceContinuitySnapshot, createSpaceRankCheckpoint, readSpaceRankCheckpoint } from './space-continuity.js';

const sections = ['spaceBookmarks', 'temporaryTabs'];
export const tabIds = space => sections.flatMap(key => space?.[key] || []);
export const ownerOf = (spaces, tabId) => spaces.find(space => tabIds(space).includes(tabId));
const clone = value => structuredClone(value);

// The service worker is the only writer. UI patches express changes relative to the
// panel's previous view, so a stale panel cannot erase tabs created in another window.
export function applySpacePatch(current, before, after) {
    const removed = new Set(before.filter(s => !after.some(n => n.id === s.id)).map(s => s.id));
    let result = clone(current.filter(s => !removed.has(s.id)));
    for (const next of after) {
        const prev = before.find(s => s.id === next.id);
        let target = result.find(s => s.id === next.id);
        if (!target) {
            if (prev) continue; // A different panel deleted this space.
            target = { ...clone(next), color: normalizeSpaceColor(next.color),
                ...(next.customTint !== undefined ? { customTint: normalizeCustomTint(next.customTint) } : {}), spaceBookmarks: [], temporaryTabs: [] };
            result.push(target);
        }
        for (const [key, value] of Object.entries(next)) {
            if (key === 'color' && !SPACE_COLORS.includes(value)) continue;
            if (key === 'customTint' && value !== null && !normalizeCustomTint(value)) continue;
            if (!sections.includes(key) && JSON.stringify(value) !== JSON.stringify(prev?.[key])) target[key] = key === 'customTint' ? normalizeCustomTint(value) : clone(value);
        }
        for (const key of sections) {
            const oldIds = prev?.[key] || [];
            const newIds = next[key] || [];
            if (JSON.stringify(oldIds) === JSON.stringify(newIds)) continue;
            const oldSet = new Set(oldIds);
            if (key === 'temporaryTabs' && oldSet.size === oldIds.length && newIds.length === oldIds.length
                && new Set(newIds).size === newIds.length && newIds.every(id => oldSet.has(id))) {
                // A stale drag only rearranges its surviving captured IDs. Keep
                // concurrent creations and other uncaptured IDs in their current
                // slots, and never resurrect a tab closed or moved in the meantime.
                target[key] = mergeVisibleOrder(target[key], newIds.filter(id => target[key].includes(id)));
                continue;
            }
            const deleted = oldIds.filter(id => !newIds.includes(id));
            const added = newIds.filter(id => !oldIds.includes(id));
            for (const id of added) {
                for (const space of result) for (const section of sections) space[section] = space[section].filter(t => t !== id);
            }
            const existing = target[key].filter(id => !deleted.includes(id));
            target[key] = [...newIds.filter(id => existing.includes(id) || added.includes(id)), ...existing.filter(id => !newIds.includes(id))];
        }
    }
    // A generic metadata/membership patch never reorders surviving spaces.
    // Only the explicit ID-relative reorder action can change their order.
    return result;
}

export class SpaceStore {
    constructor() { this.chain = Promise.resolve(); this.initialized = false; this.pendingCreations = new Set(); this.archiveStore = new ArchiveStore(this); }
    run(operation) {
        const pending = this.chain.then(async () => {
            // Transient identity is loaded before either ownership system can
            // adopt live tabs. Observations are durable on this same queue.
            await this.transientWindows?.initialize();
            await this.transientWindows?.flushObservedUnlocked();
            // Favorite initialization never enters run(): the single shared gate
            // validates exact global ownership before Space restore/adoption.
            if (this.favoriteStore) await this.favoriteStore.initialize();
            if (this.initialized) await recoverSavedMove(this);
            await this.initialize();
            this.forgetTransientOwnership();
            if (this.favoriteStore) await this.favoriteStore.reconcile({ updateSpaces: true });
            this.forgetTransientOwnership();
            try { return await operation(); }
            finally {
                // A failed promotion can leave staged membership after its
                // exact admission closes. Never expose that uncertain owner.
                this.forgetTransientOwnership();
                await this.transientWindows?.flushObservedUnlocked();
            }
        });
        this.chain = pending.catch(console.error);
        return pending;
    }
    async makeSpace(name, color = 'grey', folder = null) {
        folder ||= await LocalStorage.getOrCreateSpaceFolder(name);
        const entry = await LocalStorage.getOrCreateSpaceRegistryEntry(folder.id, { name, color });
        return { id: entry.spaceUuid, spaceUuid: entry.spaceUuid, uuid: entry.spaceUuid,
            bookmarkFolderId: folder.id, name, color: normalizeSpaceColor(entry.color || color),
            ...(normalizeCustomTint(entry.customTint) ? { customTint: normalizeCustomTint(entry.customTint) } : {}),
            ...(normalizeSpaceIcon(entry.icon) ? { icon: normalizeSpaceIcon(entry.icon) } : {}), spaceBookmarks: [], temporaryTabs: [] };
    }
    async initialize() {
        if (this.initialized) return;
        return withSavedMoveLock(async () => {
            const journal = (await chrome.storage.local.get(SAVED_MOVE_JOURNAL_KEY))[SAVED_MOVE_JOURNAL_KEY];
            return journal ? Utils._serializePinnedStateOp(() => this.initializeUnlocked()) : this.initializeUnlocked();
        });
    }
    async initializeUnlocked() {
        if (this.initialized) return;
        await this.transientWindows?.initialize();
        await this.transientWindows?.flushObservedUnlocked();
        if (this.favoriteStore) await this.favoriteStore.initialize();
        await this.readTodayPlacement();
        const data = await chrome.storage.local.get(['spaces', 'spaceModelVersion', 'spaceTabSnapshot', 'spaceWindowSnapshot', 'archivedTabs', 'spaceRankCheckpoint', SPACE_CONTINUITY_KEY, SAVED_MOVE_JOURNAL_KEY]);
        const session = await chrome.storage.session.get(['spaceSession', 'spaceRestoreQueue', 'activeSpaces', 'restoredTabRanks', 'spaceWindowKeys', 'spaceRestoreWindowKeys', 'spaceRecoveryCandidates', 'spaceSavedMoveSession']);
        this.provisional = new Set();
        this.recoveryCandidates = new Set(session.spaceSession ? session.spaceRecoveryCandidates || [] : []);
        const savedMoveRecovery = await recoverSavedMoveData(this, data, session);
        if (this.favoriteStore) await this.favoriteStore.reconcile({ updateSpaces: false });
        this.spaces = (data.spaces || []).map(space => ({ ...space, color: normalizeSpaceColor(space.color),
            ...(space.customTint !== undefined ? { customTint: normalizeCustomTint(space.customTint) } : {}) }));
        this.snapshotByTab = new Map((data.spaceTabSnapshot || []).filter(t => t.tabId).map(t => [t.tabId, t]));
        this.provisional = new Set();
        this.recoveryCandidates = new Set(session.spaceSession ? session.spaceRecoveryCandidates || [] : []);
        this.savedWindows = data.spaceWindowSnapshot || [];
        this.windowKeys = new Map(session.spaceSession ? session.spaceWindowKeys || [] : []);
        this.restoreWindowKeys = new Map(session.spaceSession ? session.spaceRestoreWindowKeys || [] : []);
        this.restoredMetadata = [];
        // Use the local ordering checkpoint only in a live browser session and
        // only when it matches the exact durable snapshot. Legacy/older writers
        // retain the existing session-only fallback; cold recovery clears ranks.
        const rankCheckpoint = session.spaceSession ? await readSpaceRankCheckpoint(data.spaceRankCheckpoint, data.spaceTabSnapshot) : null;
        this.restoredRanks = new Map(rankCheckpoint ?? session.restoredTabRanks ?? []);
        this.active = session.activeSpaces || {};
        this.defaultSpaceName = (await chrome.storage.sync.get('defaultSpaceName')).defaultSpaceName || 'Home';
        let live = await this.queryTabs({});
        this.liveTabs = new Map(live.map(t => [t.id, t]));
        if (data.spaceModelVersion !== 2) {
            const idMap = new Map();
            const migrated = [];
            const legacyGroups = this.spaces.length ? await chrome.tabGroups.query({}) : [];
            for (const old of this.spaces) {
                const space = await this.makeSpace(old.name, old.color);
                idMap.set(old.id, space.id);
                // Legacy groups are read once to preserve existing users' membership.
                const namedGroups = legacyGroups.filter(g => g.title === old.name);
                const legacyIds = new Set(namedGroups.length ? namedGroups.map(g => g.id) : [old.id]);
                const members = live.filter(t => legacyIds.has(t.groupId) && !t.pinned && !this.isGlobalTab(t) && !this.isTransientTab(t));
                const pinned = old.spaceBookmarks || [];
                space.spaceBookmarks = members.filter(t => pinned.includes(t.id)).map(t => t.id);
                space.temporaryTabs = members.filter(t => !pinned.includes(t.id)).map(t => t.id);
                const existing = migrated.find(s => s.id === space.id);
                if (existing) {
                    for (const key of sections) existing[key].push(...space[key]);
                } else migrated.push(space);
            }
            this.spaces = migrated;
            if (migrated.length) await chrome.storage.local.set({ tabGroupImportDismissed: true });
            if (data.archivedTabs) {
                try { await this.archiveStore.migrateSpaceIdsUnlocked(idMap); }
                catch (error) {
                    // Never commit model v2 after a transient mapping write
                    // failure: that would strand numeric legacy archive owners.
                    if (error.code !== 'INVALID_ARCHIVE') throw error;
                    console.warn('Archive migration deferred:', error.message);
                }
            }
            this.restoreQueue = [];
        } else if (!session.spaceSession) {
            // Exact replay requires both a proven browser epoch and a snapshot
            // written in that epoch. The pending suffix never supplies ID proof.
            const replay = await this.readSameSessionSnapshot(data);
            this.snapshotByTab.clear();
            this.restoreQueue = replay ? replay.pending : data.spaceTabSnapshot || [];
            this.spaces.forEach(s => { s.spaceBookmarks = []; s.temporaryTabs = []; delete s.lastTab; });
            this.active = {};
            this.restoredRanks.clear();
            await chrome.storage.local.set({ pinnedTabStatesById: {}, tabNameOverridesById: {} });
            for (const record of replay?.live || []) {
                const space = this.spaces.find(space => space.id === record.spaceId);
                space[record.section].push(record.tabId);
                this.restoredMetadata.push(record);
            }
        } else {
            this.restoreQueue = session.spaceRestoreQueue || [];
        }
        try {
            await this.archiveStore.listUnlocked();
            await this.archiveStore.initializeClaimsUnlocked();
        } catch (error) {
            // Archive corruption refuses archive operations, but cannot disable
            // unrelated Spaces. Never replace malformed data with an empty list.
            console.warn('Archive initialization deferred:', error.message);
        }
        const restoreKeys = new Set([...this.restoreQueue.map(t => t.windowKey), ...this.restoreWindowKeys.values()]);
        this.savedWindows = this.savedWindows.filter(w => restoreKeys.has(w.key));
        await this.discoverBookmarkSpaces();
        if (!this.spaces.length) {
            this.spaces.push(await this.makeSpace(this.defaultSpaceName));
        }
        if (!session.spaceSession && this.favoriteStore?.ownershipPersistence?.recoverSelection) {
            this.active = await this.favoriteStore.ownershipPersistence.recoverSelection(this.spaces);
        }
        if (this.pendingCreations.size) {
            // Initialization may await bookmark/recovery I/O after its first
            // settings and native reads. Resolve pending creations at the same
            // fresh boundary as a warm onCreated event.
            await this.readTodayPlacement();
            live = await this.queryTabs({});
            this.liveTabs = new Map(live.map(tab => [tab.id, tab]));
        }
        const valid = new Set(live.map(t => t.id));
        for (const space of this.spaces) for (const key of sections) space[key] = (space[key] || []).filter(id => valid.has(id));
        // An onCreated event can wake a cold worker whose initial query already
        // contains that tab. Adopt/restore older tabs first, then consume the
        // exact creation intent once; real restoration still takes precedence.
        for (const tab of live.filter(tab => !this.pendingCreations.has(tab.id))) this.track(tab, { nativeTabs: live });
        // Creation arrival order is intentional even if Chrome enumerates its
        // native strip differently (or places each new native tab at index 0).
        const initializedCreations = [...this.pendingCreations];
        for (const id of initializedCreations) {
            const tab = this.liveTabs.get(id);
            if (tab) this.track(tab, { nativeTabs: live, created: true });
            else this.pendingCreations.delete(id);
        }
        this.initialized = true;
        try {
            if (savedMoveRecovery) await finishSavedMoveRecovery(this, savedMoveRecovery);
            else await this.persist();
            for (const id of initializedCreations) this.pendingCreations.delete(id);
        } catch (error) { this.initialized = false; throw error; }
    }
    async readSameSessionSnapshot(data) {
        const continuity = this.favoriteStore?.ownershipPersistence;
        const identity = await continuity?.browserIdentity?.({ recovered: true });
        const replay = await readSpaceContinuitySnapshot(identity, data[SPACE_CONTINUITY_KEY], data.spaceTabSnapshot);
        if (!replay) return null;
        const tabs = new Map((await this.queryTabs({})).map(tab => [tab.id, tab])), windows = new Map();
        const eligible = tab => tab && !tab.pinned && !tab.incognito && !this.isGlobalTab(tab) && !this.isTransientTab(tab) && !isStartupLauncherTab(tab);
        for (const record of replay.live) {
            const tab = tabs.get(record.tabId);
            if (eligible(tab) && !windows.has(tab.windowId)) windows.set(tab.windowId, await chrome.windows.get(tab.windowId));
        }
        // Native changes can happen while awaited window reads run. Recheck the
        // exact survivors; an observed normal-window move keeps ordinary Space
        // ownership. A move during validation is uncertainty, not permission
        // to downgrade a saved pin to a temporary tab. Retry before any writes.
        const latest = new Map((await this.queryTabs({})).map(tab => [tab.id, tab]));
        if (replay.live.some(record => eligible(latest.get(record.tabId))
            && latest.get(record.tabId).windowId !== tabs.get(record.tabId)?.windowId)) {
            throw Object.assign(new Error('A tab moved during Space recovery. Retry when its window is stable.'), { code: 'SPACE_REPLAY_CHANGED' });
        }
        replay.live = replay.live.filter(record => {
            const tab = latest.get(record.tabId), window = windows.get(tab?.windowId);
            return this.spaces.some(space => space.id === record.spaceId) && eligible(tab)
                && tab.windowId === tabs.get(record.tabId)?.windowId && window?.id === tab.windowId
                && window.type === 'normal' && !window.incognito;
        });
        const finalIdentity = await continuity.browserIdentity({ recovered: true });
        return finalIdentity?.epoch === identity.epoch && finalIdentity.generation === identity.generation ? replay : null;
    }
    // Bookmark folders are durable space definitions regardless of Chrome group sync.
    // Run on every worker startup and sidebar read, including version-2 installations.
    async discoverBookmarkSpaces() {
        const before = JSON.stringify(this.spaces);
        const root = await LocalStorage.getOrCreateArcifyFolder();
        const folders = (await chrome.bookmarks.getChildren(root.id)).filter(node => !node.url);
        for (const folder of folders) {
            let space = this.spaces.find(space => space.bookmarkFolderId === folder.id);
            if (!space) {
                // Recover a missing/stale folder association without duplicating the space.
                space = this.spaces.find(space => space.name === folder.title && !folders.some(node => node.id === space.bookmarkFolderId));
                if (space) space.bookmarkFolderId = folder.id;
                else { this.spaces.push(await this.makeSpace(folder.title, 'grey', folder)); continue; }
            }
            space.name = folder.title;
            const entry = await LocalStorage.getOrCreateSpaceRegistryEntry(folder.id, {
                spaceUuid: space.id, name: space.name, color: space.color, icon: space.icon, customTint: space.customTint
            });
            if (entry.spaceUuid === space.id && space.customTint === undefined && normalizeCustomTint(entry.customTint)) space.customTint = normalizeCustomTint(entry.customTint);
            // Only recover metadata belonging to this stable Space identity.
            if (entry.spaceUuid === space.id && space.icon === undefined && normalizeSpaceIcon(entry.icon)) space.icon = normalizeSpaceIcon(entry.icon);
        }
        return before !== JSON.stringify(this.spaces);
    }
    isGlobalTab(tabOrId) { return this.favoriteStore?.ownsTab(tabOrId) || false; }
    isTransientTab(tabOrId) { return this.transientWindows?.isExcluded(tabOrId) || false; }
    isTransientWindow(windowId) { return this.transientWindows?.isTransientWindow(windowId) || false; }
    observeTab(tab) { this.transientWindows?.observe(tab); return tab; }
    async queryTabs(query = {}) {
        const tabs = await chrome.tabs.query(query);
        for (const tab of tabs) this.observeTab(tab);
        await this.transientWindows?.flushObservedUnlocked();
        return tabs;
    }
    excludeTransientMembership(spaces = this.spaces) {
        for (const space of spaces || []) {
            for (const section of sections) space[section] = (space[section] || []).filter(id => !this.isTransientTab(id));
            if (this.isTransientTab(space.lastTab)) delete space.lastTab;
        }
        return spaces;
    }
    forgetTransientOwnership() {
        if (!this.transientWindows) return;
        const ids = new Set([
            ...(this.spaces || []).flatMap(space => [...tabIds(space), space.lastTab]),
            ...(this.snapshotByTab?.keys() || []), ...(this.provisional || []), ...(this.recoveryCandidates || []),
            ...(this.restoredRanks?.keys() || []), ...(this.restoreQueue || []).map(record => record.tabId),
            ...(this.restoredMetadata || []).map(record => record.tabId)
        ]);
        for (const id of ids) if (this.isTransientTab(id)) this.forgetTab(id);
        for (const id of Object.keys(this.active || {})) if (this.isTransientWindow(Number(id))) delete this.active[id];
        for (const keys of [this.windowKeys, this.restoreWindowKeys]) {
            for (const id of keys?.keys() || []) if (this.isTransientWindow(id)) keys.delete(id);
        }
    }
    forgetTab(tabId) {
        if (this.isGlobalTab(tabId) && (!this.initialized || ownerOf(this.spaces || [], tabId))) this.favoriteStore.noteSpaceExclusion?.(tabId);
        for (const space of this.spaces || []) {
            for (const section of sections) space[section] = (space[section] || []).filter(id => id !== tabId);
            if (space.lastTab === tabId) delete space.lastTab;
        }
        this.snapshotByTab?.delete(tabId);
        this.provisional?.delete(tabId);
        this.recoveryCandidates?.delete(tabId);
        this.restoredRanks?.delete(tabId);
        this.restoredMetadata = (this.restoredMetadata || []).filter(record => record.tabId !== tabId);
        this.restoreQueue = (this.restoreQueue || []).filter(record => record.tabId !== tabId);
    }
    async readTodayPlacement({ getOrder = getTodayOrderInverted } = {}) {
        this.todayOrderInverted = await getOrder();
        const [setting, bindings] = await Promise.all([
            chrome.storage.sync.get({ todayNewTabsAtTop: true }), chrome.storage.local.get('pinnedTabStatesById')
        ]);
        this.todayNewTabsAtTop = setting.todayNewTabsAtTop !== false;
        this.todayPinnedBindings = bindings.pinnedTabStatesById || {};
    }
    exactTodayOpener(tab, nativeTabs, openerTabId = tab.openerTabId, placementSpace = null) {
        const opener = nativeTabs?.find(item => item.id === openerTabId);
        if (this.isTransientTab(tab) || !opener || this.isTransientTab(opener) || opener.windowId !== tab.windowId || opener.incognito || opener.pinned || this.isGlobalTab(opener)
            || this.todayPinnedBindings?.[opener.id]?.bookmarkId
            || isStartupLauncherTab(opener)) return null;
        const owners = this.spaces.flatMap(space => sections.flatMap(section =>
            (space[section] || []).filter(id => id === opener.id).map(() => ({ space, section }))));
        if (owners.length !== 1 || owners[0].section !== 'temporaryTabs') return null;
        // Historical uncertainty cannot select a child's Space. Once its destination
        // is independently established, exact live ownership can place it locally
        // without consuming recovery records or certifying the parent's history.
        if ((this.provisional?.has(opener.id) || this.recoveryCandidates?.has(opener.id))
            && owners[0].space !== placementSpace) return null;
        return { tab: opener, space: owners[0].space };
    }
    insertCreatedToday(space, tab, { nativeTabs = [], openerTabId = null } = {}) {
        this.observeTab(tab);
        if (this.isTransientTab(tab)) return;
        const before = [...space.temporaryTabs];
        const opener = this.exactTodayOpener(tab, nativeTabs, openerTabId, space);
        const validOpener = opener?.space === space ? opener.tab : null;
        let insertAt = getTodayInsertionIndex(before, { inverted: this.todayOrderInverted,
            newTabsAtTop: this.todayNewTabsAtTop, openerTabId: validOpener?.id });
        if (hasNativeSplit(validOpener)) {
            const peers = nativeTabs.filter(item => item.windowId === tab.windowId && hasNativeSplit(item)
                && item.splitViewId === validOpener.splitViewId);
            const indices = peers.map(item => before.indexOf(item.id));
            const intact = peers.length === 2 && indices.every(index => index >= 0) && Math.abs(indices[0] - indices[1]) === 1
                && peers.every(item => this.exactTodayOpener(tab, nativeTabs, item.id, space)?.space === space
                    && item.groupId === validOpener.groupId && item.pinned === validOpener.pinned)
                && Number.isInteger(peers[0].index) && Number.isInteger(peers[1].index) && Math.abs(peers[0].index - peers[1].index) === 1;
            // Never insert between a verified pair; uncertainty means standalone.
            insertAt = intact ? this.todayOrderInverted ? Math.min(...indices) : Math.max(...indices) + 1
                : getTodayInsertionIndex(before, { inverted: this.todayOrderInverted, newTabsAtTop: this.todayNewTabsAtTop });
        }
        space.temporaryTabs.splice(insertAt, 0, tab.id);
        this.rebaseSectionRanks(space, 'temporaryTabs', before);
        // Cold initialization must retain exact intent until its first write is
        // confirmed. A rejected/uncertain write re-reads durable membership;
        // an already persisted ID is adopted without inserting it again.
        if (this.initialized) this.pendingCreations.delete(tab.id);
    }
    rebaseSectionRanks(space, section, beforeIds = space[section]) {
        this.restoredRanks ||= new Map();
        const pending = (this.restoreQueue || []).filter(record => record.spaceId === space.id && record.section === section)
            .sort((a, b) => a.order - b.order);
        const ids = space[section];
        if (!pending.length) {
            for (const id of new Set([...beforeIds, ...ids])) this.restoredRanks.delete(id);
            return;
        }
        // Keep unresolved records beside their previous surviving anchors while
        // giving the actual live order authority. Late restoration only inserts
        // its new ID and can never sort an intentional live order back to old ranks.
        const ranks = new Map(beforeIds.map((id, index) => [id, this.restoredRanks.get(id)
            ?? (this.snapshotByTab?.get(id)?.spaceId === space.id && this.snapshotByTab.get(id).section === section
                ? this.snapshotByTab.get(id).order : index)]));
        const slots = Array.from({ length: ids.length + 1 }, () => []);
        for (const record of pending) {
            const next = beforeIds.find(id => ids.includes(id) && ranks.get(id) > record.order);
            const previous = beforeIds.filter(id => ids.includes(id) && ranks.get(id) <= record.order).at(-1);
            const slot = next !== undefined ? ids.indexOf(next) : previous !== undefined ? ids.indexOf(previous) + 1
                : this.todayOrderInverted && section === 'temporaryTabs' ? 0 : ids.length;
            slots[slot].push(record);
        }
        let order = 0;
        for (let index = 0; index <= ids.length; index++) {
            for (const record of slots[index]) record.order = order++;
            if (index < ids.length) this.restoredRanks.set(ids[index], order++);
        }
        for (const id of beforeIds) if (!ids.includes(id)) this.restoredRanks.delete(id);
    }
    track(tab, { nativeTabs = null, created = false } = {}) {
        this.observeTab(tab);
        for (const nativeTab of nativeTabs || []) this.observeTab(nativeTab);
        if (created && this.initialized) this.pendingCreations.delete(tab.id);
        this.liveTabs.set(tab.id, tab);
        const url = tab.url || tab.pendingUrl;
        if (tab.pinned || this.isGlobalTab(tab) || this.isTransientTab(tab) || isStartupLauncherTab(tab)) {
            this.forgetTab(tab.id);
            return;
        }
        if (url?.startsWith(chrome.runtime?.getURL?.('') || 'chrome-extension://invalid/') && !isPracticeUrl(url)) {
            for (const space of this.spaces) for (const key of sections) space[key] = space[key].filter(id => id !== tab.id);
            return;
        }
        // A journaled archive create stays unowned until its exact reopen
        // operation confirms assignment; worker restart cannot adopt it by URL.
        if (this.archiveStore.pendingCreatedIds.has(tab.id) && !ownerOf(this.spaces, tab.id)) return;
        const existing = ownerOf(this.spaces, tab.id);
        if (existing) {
            if ((!this.provisional.has(tab.id) && !this.recoveryCandidates.has(tab.id)) || !url) return;
            this.provisional.delete(tab.id);
        }
        if (!url) this.provisional.add(tab.id);
        const validQueue = this.restoreQueue.filter(t => this.spaces.some(s => s.id === t.spaceId));
        this.restoreQueue = validQueue;
        const restoreKeys = new Set([...validQueue.map(t => t.windowKey), ...this.restoreWindowKeys.values()]);
        const restoredIndex = matchRestoreRecord(tab, validQueue, this.savedWindows.filter(w => restoreKeys.has(w.key)), this.restoreWindowKeys, [...this.liveTabs.values()].filter(tab => !this.isGlobalTab(tab) && !this.isTransientTab(tab)));
        for (const [id, key] of this.restoreWindowKeys) this.windowKeys.set(id, key);
        const restored = restoredIndex >= 0 ? this.restoreQueue.splice(restoredIndex, 1)[0] : null;
        if (restored) this.recoveryCandidates.delete(tab.id);
        else if (url && this.restoreQueue.some(t => t.url === url)) this.recoveryCandidates.add(tab.id);
        else this.recoveryCandidates.delete(tab.id);
        if (existing && !restored) return;
        if (existing) for (const key of sections) existing[key] = existing[key].filter(id => id !== tab.id);
        // Chrome can attach the current tab as opener even for Cmd/Ctrl+T.
        // A blank new-tab page belongs to the selected space, not that incidental opener.
        const isNewTabPage = !url || /^(chrome:\/\/(newtab|new-tab-page)\/?|about:blank)$/.test(url);
        const openerSpace = isNewTabPage ? null : this.exactTodayOpener(tab, nativeTabs, tab.openerTabId)?.space;
        const space = this.spaces.find(s => s.id === restored?.spaceId) || openerSpace
            || this.spaces.find(s => s.id === this.active[tab.windowId])
            || this.spaces.find(s => s.name === this.defaultSpaceName) || this.spaces[0];
        if (!space) return;
        const key = restored?.section || 'temporaryTabs';
        if (restored) {
            this.restoredMetadata.push({ ...restored, tabId: tab.id });
            // Preserve extension order when Chrome restores tabs in a different order.
            this.restoredRanks ||= new Map();
            this.restoredRanks.set(tab.id, restored.order);
            const insertAt = space[key].findIndex(id => (this.restoredRanks.get(id) ?? Infinity) > restored.order);
            space[key].splice(insertAt < 0 ? space[key].length : insertAt, 0, tab.id);
        } else if (created) {
            this.insertCreatedToday(space, tab, { nativeTabs: nativeTabs || [], openerTabId: isNewTabPage ? null : tab.openerTabId });
        } else {
            // Initialization, attachment, Favorite release and URL updates adopt
            // membership without applying the prospective new-tab placement.
            space[key].push(tab.id);
        }
    }

    async persist({ skipGroupSync = false, beforeWrite = null, savedMove = null } = {}) {
        const tabs = new Map((await this.queryTabs({})).map(t => [t.id, t]));
        this.liveTabs = tabs;
        const excludedAtRead = new Set([...tabs.values()].filter(tab => this.isTransientTab(tab)).map(tab => tab.id));
        const transientChanged = () => [...tabs.values()].some(tab => this.isTransientTab(tab) && !excludedAtRead.has(tab.id));
        const retry = () => this.persist({ skipGroupSync, beforeWrite, savedMove });
        const liveWindows = new Set([...tabs.values()].filter(tab => !this.isTransientTab(tab) && !this.isTransientWindow(tab.windowId)).map(t => t.windowId));
        for (const windowId of Object.keys(this.active)) if (this.isTransientWindow(Number(windowId))) delete this.active[windowId];
        for (const keys of [this.windowKeys, this.restoreWindowKeys]) {
            for (const id of keys.keys()) if (!liveWindows.has(id)) keys.delete(id);
        }
        for (const tab of tabs.values()) if (tab.pinned || this.isGlobalTab(tab) || this.isTransientTab(tab)) this.forgetTab(tab.id);
        for (const id of this.recoveryCandidates) if (tabs.has(id)) this.track(tabs.get(id));
        this.restoreQueue = this.restoreQueue.filter(t => this.spaces.some(s => s.id === t.spaceId) && !isStartupLauncherUrl(t.url) && !this.isTransientTab(t.tabId));
        // A later candidate can consume the final record for an earlier one's
        // URL in this pass. Recheck after all matching/filtering, so the earlier
        // tab is not persisted as unresolved once no applicable record remains.
        // Keep genuinely ambiguous records and blank provisional tabs protected.
        for (const id of this.recoveryCandidates) {
            const tab = tabs.get(id), url = tab?.url || tab?.pendingUrl;
            if (url && !this.restoreQueue.some(record => record.url === url)) this.recoveryCandidates.delete(id);
        }
        const metadata = await chrome.storage.local.get(['pinnedTabStatesById', 'tabNameOverridesById']);
        const pinnedStates = metadata.pinnedTabStatesById || {};
        const overrides = metadata.tabNameOverridesById || {};
        if (this.restoredMetadata.length) {
            for (const record of this.restoredMetadata) {
                if (this.isTransientTab(record.tabId)) continue;
                if (record.pinnedState) pinnedStates[record.tabId] = record.pinnedState;
                if (record.nameOverride) overrides[record.tabId] = record.nameOverride;
            }
            if (beforeWrite) await beforeWrite();
            if (transientChanged()) return retry();
            await chrome.storage.local.set({ pinnedTabStatesById: pinnedStates, tabNameOverridesById: overrides });
            this.restoredMetadata = [];
        }
        const snapshot = [];
        for (const space of this.spaces) for (const section of sections) {
            space[section] = [...new Set(space[section])].filter(id => {
                if (!tabs.has(id)) return false;
                if (tabs.get(id).pinned || this.isGlobalTab(tabs.get(id)) || this.isTransientTab(tabs.get(id)) || isStartupLauncherTab(tabs.get(id))) { this.snapshotByTab.delete(id); return false; }
                return true;
            });
            space[section].forEach((id, order) => {
                // An unresolved recovery tab has only a provisional space owner.
                // Keep its original record instead of persisting that guess.
                if (this.recoveryCandidates.has(id)) {
                    this.snapshotByTab.delete(id);
                    return;
                }
                const tab = tabs.get(id);
                if (!this.windowKeys.has(tab.windowId)) this.windowKeys.set(tab.windowId, crypto.randomUUID());
                const record = { tabId: id, spaceId: space.id, section, order: this.restoredRanks.get(id) ?? order, url: tab.url || tab.pendingUrl || '',
                    windowKey: this.windowKeys.get(tab.windowId), tabIndex: tab.index,
                    ...(pinnedStates[id] ? { pinnedState: pinnedStates[id] } : {}),
                    ...(overrides[id] ? { nameOverride: overrides[id] } : {}) };
                snapshot.push(record);
                this.snapshotByTab.set(id, record);
            });
        }
        const pendingWindows = new Set(this.restoreQueue.map(t => t.windowKey));
        const windowSnapshot = this.savedWindows.filter(w => pendingWindows.has(w.key));
        for (const windowId of liveWindows) {
            if (!this.windowKeys.has(windowId)) this.windowKeys.set(windowId, crypto.randomUUID());
            const key = this.windowKeys.get(windowId);
            if (!windowSnapshot.some(w => w.key === key)) windowSnapshot.push({ key,
                ...(!this.restoreWindowKeys.has(windowId) && [...tabs.values()].some(tab =>
                    tab.windowId === windowId && this.recoveryCandidates.has(tab.id)) ? { recoveryRole: 'current-only' } : {}),
                tabs: captureWindowTabs([...tabs.values()].filter(t => t.windowId === windowId && !this.isGlobalTab(t) && !this.isTransientTab(t) && !isStartupLauncherTab(t))) });
        }
        this.savedWindows = windowSnapshot;
        const identity = await this.favoriteStore?.ownershipPersistence?.browserIdentity?.();
        const stamp = await createSpaceContinuityStamp(identity, snapshot);
        const spaceTabSnapshot = [...snapshot, ...this.restoreQueue];
        const spaceRankCheckpoint = await createSpaceRankCheckpoint([...this.restoredRanks], spaceTabSnapshot);
        const checkpoint = { spaces: clone(this.spaces), spaceModelVersion: 2, spaceTabSnapshot, spaceRankCheckpoint, spaceWindowSnapshot: windowSnapshot, [SPACE_CONTINUITY_KEY]: stamp };
        if (savedMove) checkpoint[SAVED_MOVE_JOURNAL_KEY] = await checkpointSavedMove(savedMove, checkpoint, snapshot.length);
        if (beforeWrite) await beforeWrite();
        if (transientChanged()) return retry();
        await chrome.storage.local.set(checkpoint);
        if (transientChanged()) return retry();
        const spaceSessionUpdate = { spaceSession: true, activeSpaces: this.active, spaceRestoreQueue: this.restoreQueue, restoredTabRanks: [...this.restoredRanks], spaceWindowKeys: [...this.windowKeys], spaceRestoreWindowKeys: [...this.restoreWindowKeys], spaceRecoveryCandidates: [...new Set([...this.recoveryCandidates, ...this.provisional])] };
        const favorites = this.favoriteStore;
        if (favorites?.ownershipPersistence?.checkpointSelection) {
            try {
                await favorites.ownershipPersistence.checkpointSelection({ state: favorites.state, items: favorites.items,
                    spaces: this.spaces, activeSpaces: this.active, spaceSessionUpdate, beforeWrite });
            } catch (error) {
                // A rejected checkpoint must reload its authoritative session
                // before a later read can expose the uncommitted selection.
                this.initialized = false;
                throw error;
            }
        } else {
            if (beforeWrite) await beforeWrite();
            await chrome.storage.session.set(spaceSessionUpdate);
        }
        if (transientChanged()) return retry();
        try { if (!skipGroupSync) await syncSpaceGroups(this.spaces, this.active, [...tabs.values()].filter(tab => this.isGlobalTab(tab)).map(tab => tab.id), {
            isExcludedTab: tab => this.isTransientTab(tab), isExcludedWindow: id => this.isTransientWindow(id),
            observeTab: tab => this.observeTab(tab), flushObserved: () => this.transientWindows?.flushObservedUnlocked()
        }); }
        catch (error) { console.warn('Tab group sync deferred:', error); }
    }
    async dispatch(message) {
        return this.run(() => this.applyAction(message));
    }
    // Internal only: callers already holding run() may compose the existing operations.
    async applyAction(message) {
        switch (message.action) {
            case 'get':
                if (await this.discoverBookmarkSpaces()) await this.persist();
                break;
            case 'reconcilePins': {
                // Startup's legacy matcher releases the cross-document barrier
                // before entering this queue. Its observed membership must still
                // be current; stale recovery can never demote a newly moved pin.
                if (JSON.stringify(this.spaces) !== JSON.stringify(message.before)) return clone(this.spaces);
                const nativeTabs = await this.queryTabs({});
                const next = this.excludeTransientMembership(applySpacePatch(this.spaces, message.before, message.after));
                assertNativeSplitMembershipPreserved(this.spaces, next, nativeTabs.filter(tab => !this.isTransientTab(tab)));
                const previous = this.spaces; this.spaces = next;
                for (const space of next) for (const section of sections) {
                    const before = previous.find(value => value.id === space.id)?.[section] || [];
                    if (JSON.stringify(before) !== JSON.stringify(space[section])) this.rebaseSectionRanks(space, section, before);
                }
                break;
            }
            case 'patch': {
                const nativeTabs = await this.queryTabs({});
                const nextSpaces = this.excludeTransientMembership(applySpacePatch(this.spaces, message.before, message.after));
                assertNativeSplitMembershipPreserved(this.spaces, nextSpaces, nativeTabs.filter(tab => !this.isTransientTab(tab)));
                const previous = this.spaces;
                this.spaces = nextSpaces;
                for (const next of nextSpaces) for (const key of sections) {
                    const before = previous.find(space => space.id === next.id)?.[key] || [];
                    if (JSON.stringify(next[key]) !== JSON.stringify(before)) this.rebaseSectionRanks(next, key, before);
                }
                if (!this.spaces.length) this.spaces.push(await this.makeSpace(this.defaultSpaceName));
                break;
            }
            case 'metadata': {
                const space = this.spaces.find(space => space.id === message.spaceId);
                if (!space) throw new Error('This Space no longer exists.');
                const attrs = message.changes || {};
                if (Object.keys(attrs).some(key => !['name', 'color', 'icon', 'customTint'].includes(key))) throw new Error('Unsupported Space setting.');
                if (attrs.name !== undefined && (typeof attrs.name !== 'string' || !attrs.name.trim() || attrs.name.trim().length > 256)) throw new Error('Enter a Space name between 1 and 256 characters.');
                if (attrs.color !== undefined && !SPACE_COLORS.includes(attrs.color)) throw new Error('Choose one of the eight Space colors.');
                if (attrs.customTint !== undefined && attrs.customTint !== null && !normalizeCustomTint(attrs.customTint)) throw new Error('Enter a six-digit hex color, such as #8bb3f3.');
                if (attrs.icon !== undefined && attrs.icon !== null && normalizeSpaceIcon(attrs.icon) !== attrs.icon) throw new Error('Choose a preset or enter one complete emoji.');
                const folder = await getSpaceBookmarkFolder(space);
                const entry = await LocalStorage.getOrCreateSpaceRegistryEntry(folder.id, { spaceUuid: space.id, name: space.name, color: space.color, icon: space.icon, customTint: space.customTint });
                if (entry.spaceUuid !== space.id) throw new Error('This Space bookmark identity has changed. Refresh and try again.');
                const changes = { ...attrs, ...(attrs.customTint !== undefined ? { customTint: normalizeCustomTint(attrs.customTint) } : {}), ...(attrs.name !== undefined ? { name: attrs.name.trim() } : {}) };
                if (changes.name !== undefined) await chrome.bookmarks.update(folder.id, { title: changes.name });
                await LocalStorage.updateSpaceRegistryEntry(folder.id, changes);
                Object.assign(space, changes);
                break;
            }
            case 'newFolder': {
                const space = this.spaces.find(space => space.id === message.spaceId);
                if (!space) throw new Error('This Space no longer exists.');
                if (typeof message.title !== 'string' || !message.title.trim() || message.title.trim().length > 256) throw new Error('Enter a folder name between 1 and 256 characters.');
                const folder = await getSpaceBookmarkFolder(space);
                await createFolder(folder.id, folder.id, message.title.trim());
                // The bookmark API is the commit. This action changes no Space
                // state; a later ancillary persist failure must not invite a
                // retry that creates a second folder. Bookmark events refresh UIs.
                return clone(this.spaces);
            }
            case 'reorder':
                this.spaces = moveSpace(this.spaces, message);
                break;
            case 'activate':
                if (!this.isTransientWindow(message.windowId)) this.active[message.windowId] = message.spaceId;
                break;
            case 'clean':
                await this.closeOwnedTabs(message.spaceId, { windowId: message.windowId, temporaryOnly: true });
                break;
            case 'delete': {
                const space = this.spaces.find(space => space.id === message.spaceId);
                if (!space) break;
                await this.closeOwnedTabs(space.id);
                if (space.bookmarkFolderId) {
                    await chrome.bookmarks.removeTree(space.bookmarkFolderId);
                    await LocalStorage.removeSpaceRegistryEntry(space.bookmarkFolderId);
                }
                this.spaces = this.spaces.filter(entry => entry !== space);
                if (!this.spaces.length) this.spaces.push(await this.makeSpace(this.defaultSpaceName));
                break;
            }
            case 'assign': {
                if (this.isGlobalTab(message.tabId) || this.isTransientTab(message.tabId)) break;
                const target = this.spaces.find(s => s.id === message.spaceId);
                if (target) {
                    if (message.newTodayTab === true && !message.pinned) await this.readTodayPlacement();
                    const nativeTabs = await this.queryTabs({});
                    const tab = nativeTabs.find(tab => tab.id === message.tabId);
                    if (this.isTransientTab(tab || message.tabId)) break;
                    assertNotNativeSplit(tab);
                    this.provisional.delete(message.tabId);
                    this.recoveryCandidates.delete(message.tabId);
                    for (const space of this.spaces) for (const key of sections) space[key] = space[key].filter(id => id !== message.tabId);
                    if (message.newTodayTab === true && !message.pinned && tab && !tab.pinned && !tab.incognito) {
                        this.insertCreatedToday(target, tab);
                    } else target[message.pinned ? 'spaceBookmarks' : 'temporaryTabs'].push(message.tabId);
                }
                break;
            }
            case 'import': {
                if (this.isTransientWindow(message.windowId)) break;
                const groups = await chrome.tabGroups.query({ windowId: message.windowId });
                const tabs = await this.queryTabs({ windowId: message.windowId });
                for (const group of groups) {
                    if (this.isTransientWindow(group.windowId)) continue;
                    let name = group.title || 'Imported space';
                    const base = name;
                    for (let i = 2; this.spaces.some(s => s.name === name); i++) name = `${base} ${i}`;
                    const space = await this.makeSpace(name, group.color);
                    const ids = tabs.filter(t => t.groupId === group.id && !t.pinned && !this.isGlobalTab(t) && !this.isTransientTab(t)).map(t => t.id);
                    for (const old of this.spaces) for (const key of sections) old[key] = old[key].filter(id => !ids.includes(id));
                    space.temporaryTabs = ids;
                    this.spaces.push(space);
                }
                await chrome.storage.local.set({ tabGroupImportDismissed: true });
                break;
            }
            default: throw new Error('Unknown space action');
        }
        if (message.action !== 'get') await this.persist();
        this.forgetTransientOwnership();
        return clone(this.spaces);
    }
    async closeOwnedTabs(spaceId, { windowId, temporaryOnly = false } = {}) {
        const space = this.spaces.find(space => space.id === spaceId);
        if (!space || this.isTransientWindow(windowId)) return [];
        if (windowId !== undefined) {
            const window = await chrome.windows.get(windowId);
            if (window.type !== 'normal' || window.incognito) throw new Error('Choose a normal browser window.');
        }
        const protectedUrls = new Set();
        if (temporaryOnly && space.bookmarkFolderId) {
            const [root] = await chrome.bookmarks.getSubTree(space.bookmarkFolderId);
            const visit = node => { if (node.url) protectedUrls.add(Utils.getPinnedUrlKey(node.url)); for (const child of node.children || []) visit(child); };
            if (root) visit(root);
        }
        const legacyBindings = temporaryOnly ? await Utils.getPinnedTabStates() : {};
        const protectedIds = new Set(temporaryOnly ? space.spaceBookmarks : []), closed = [];
        for (const tab of await this.queryTabs({})) {
            if (windowId !== undefined && tab.windowId !== windowId || tab.pinned || tab.incognito || isStartupLauncherTab(tab)
                || this.isGlobalTab(tab) || this.isTransientTab(tab) || ownerOf(this.spaces, tab.id)?.id !== spaceId
                || temporaryOnly && isProtectedFavorite(tab, protectedIds, legacyBindings, protectedUrls)) continue;
            // Revalidate the exact tab immediately before removal while holding
            // the same queue as Favorite adoption, release, cleanup and archive.
            let current;
            try { current = this.observeTab(await chrome.tabs.get(tab.id)); } catch { continue; }
            await this.transientWindows?.flushObservedUnlocked();
            if (current.windowId !== tab.windowId || current.pinned || current.incognito || this.isGlobalTab(current) || this.isTransientTab(current)
                || ownerOf(this.spaces, current.id)?.id !== spaceId) continue;
            await chrome.tabs.remove(current.id); this.forgetTab(current.id); closed.push(current.id);
        }
        return closed;
    }
    install() {
        const handle = operation => this.run(async () => { await operation(); await this.persist(); }).catch(console.error);
        const trackCurrent = async id => {
            if (this.pendingCreations.has(id)) await this.readTodayPlacement();
            // Events may wait behind a move and controller/window cleanup.
            // Resolve the live ID and its current peers, never the old snapshot.
            // Retry only this read once; persistent failure retains creation
            // intent for a later native update without adopting stale evidence.
            let nativeTabs;
            try { nativeTabs = await this.queryTabs({}); }
            catch { nativeTabs = await this.queryTabs({}); }
            const current = nativeTabs.find(item => item.id === id);
            if (!current) { this.pendingCreations.delete(id); return; }
            if (this.pendingCreations.has(id)) this.track(current, {
                nativeTabs: nativeTabs.filter(item => item.windowId === current.windowId), created: true });
            else this.track(current);
        };
        chrome.tabs.onCreated.addListener(tab => {
            // Event-time quarantine must precede any older queued persistence.
            this.observeTab(tab);
            this.pendingCreations.add(tab.id);
            handle(() => trackCurrent(tab.id));
        });
        chrome.tabs.onUpdated.addListener((id, change, tab) => {
            this.observeTab(tab);
            if (change.url || change.pinned !== undefined) handle(() => trackCurrent(id));
        });
        chrome.tabs.onRemoved.addListener((id, info) => {
            // Public exclusion deliberately fails closed before registry loading.
            // Capture only positive identity evidence here; the queued handler
            // rechecks authoritative exclusion after initialization.
            const wasTransient = this.transientWindows?.isKnownExcluded?.({ id, windowId: info?.windowId }) || false;
            this.transientWindows?.observeRemoved?.(id);
            // Cleanup must not depend on initialization succeeding: the creation
            // operation may still be blocked before it consumes this exact ID.
            this.pendingCreations.delete(id);
            return handle(() => {
                const record = this.snapshotByTab.get(id);
                if (!wasTransient && !this.isTransientTab(id) && !this.isTransientWindow(info?.windowId) && info?.isWindowClosing && record && this.spaces.some(s => s.id === record.spaceId)) this.restoreQueue.push(record);
                this.snapshotByTab.delete(id);
                this.provisional.delete(id);
                this.recoveryCandidates.delete(id);
                this.liveTabs.delete(id);
                for (const space of this.spaces) {
                    for (const key of sections) space[key] = space[key].filter(t => t !== id);
                    if (space.lastTab === id) delete space.lastTab;
                }
            });
        });
        chrome.tabs.onReplaced.addListener((added, removed) => {
            this.transientWindows?.observeReplacement?.(added, removed);
            // Native replacement is an adoption, not a new creation gesture.
            this.pendingCreations.delete(removed);
            return handle(async () => {
                if (this.transientWindows && chrome.tabs.get) {
                    try { this.observeTab(await chrome.tabs.get(added)); } catch { /* Gone before replacement processing. */ }
                    await this.transientWindows.flushObservedUnlocked();
                }
                if (this.isTransientTab(removed) || this.isTransientTab(added)) {
                    this.forgetTab(removed); this.forgetTab(added);
                    this.liveTabs.delete(removed);
                    return;
                }
                for (const ids of [this.provisional, this.recoveryCandidates]) {
                    if (ids.delete(removed)) ids.add(added);
                }
                for (const space of this.spaces) {
                    for (const key of sections) space[key] = space[key].map(id => id === removed ? added : id);
                    if (space.lastTab === removed) space.lastTab = added;
                }
            });
        });
        chrome.tabs.onActivated.addListener(info => handle(() => {
            const space = this.isGlobalTab(info.tabId) || this.isTransientTab(info.tabId) || this.isTransientWindow(info.windowId) ? null : ownerOf(this.spaces, info.tabId);
            if (space) { space.lastTab = info.tabId; this.active[info.windowId] = space.id; }
        }));
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area === 'local' && (changes.pinnedTabStatesById || changes.tabNameOverridesById)) handle(() => {});
            if (area === 'sync' && changes.syncTabGroups) handle(() => {});
            if (area === 'sync' && changes.defaultSpaceName) handle(() => { this.defaultSpaceName = changes.defaultSpaceName.newValue || 'Home'; });
        });
        // Refresh restoration positions after native moves without changing space
        // membership. The projection is idempotent, so its follow-up event settles.
        let syncTimer;
        const scheduleSync = () => {
            clearTimeout(syncTimer);
            syncTimer = setTimeout(() => this.run(() => this.persist()).catch(console.error), 200);
        };
        chrome.tabs.onMoved.addListener(scheduleSync);
        chrome.tabs.onAttached?.addListener((tabId, info) => {
            this.observeTab({ id: tabId, windowId: info?.newWindowId });
            return handle(async () => {
                // Native attachment can race a Favorite release. Re-track the exact
                // survivor, rather than only persisting its now-empty old ownership.
                this.track(this.observeTab(await chrome.tabs.get(tabId)));
            });
        });
        chrome.tabs.onDetached?.addListener((tabId, info) => {
            this.transientWindows?.observeDetached?.(tabId, info?.oldWindowId);
            scheduleSync();
        });
        chrome.tabs.onUpdated.addListener((id, change) => { if (change.groupId !== undefined || change.splitViewId !== undefined) scheduleSync(); });
        chrome.tabGroups.onRemoved.addListener(scheduleSync);
        chrome.tabGroups.onUpdated.addListener(scheduleSync);
        this.run(() => {}).catch(console.error);
    }
}
