import { normalizeSpaceIcon } from './space-icons.js';
import { SPACE_COLORS } from './space-colors.js';
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
import { captureWindowTabs, matchRestoreRecord } from './space-restore.js';
import { SPACE_CONTINUITY_KEY, createSpaceContinuityStamp, readSpaceContinuitySnapshot } from './space-continuity.js';

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
            target = { ...clone(next), spaceBookmarks: [], temporaryTabs: [] };
            result.push(target);
        }
        for (const [key, value] of Object.entries(next)) {
            if (!sections.includes(key) && JSON.stringify(value) !== JSON.stringify(prev?.[key])) target[key] = clone(value);
        }
        for (const key of sections) {
            const oldIds = prev?.[key] || [];
            const newIds = next[key] || [];
            if (JSON.stringify(oldIds) === JSON.stringify(newIds)) continue;
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
    constructor() { this.chain = Promise.resolve(); this.initialized = false; }
    run(operation) {
        const pending = this.chain.then(async () => {
            // Favorite initialization never enters run(): the single shared gate
            // validates exact global ownership before Space restore/adoption.
            if (this.favoriteStore) { await this.favoriteStore.initialize(); await this.favoriteStore.reconcile({ updateSpaces: this.initialized }); }
            await this.initialize(); return operation();
        });
        this.chain = pending.catch(console.error);
        return pending;
    }
    async makeSpace(name, color = 'grey', folder = null) {
        folder ||= await LocalStorage.getOrCreateSpaceFolder(name);
        const entry = await LocalStorage.getOrCreateSpaceRegistryEntry(folder.id, { name, color });
        return { id: entry.spaceUuid, spaceUuid: entry.spaceUuid, uuid: entry.spaceUuid,
            bookmarkFolderId: folder.id, name, color: entry.color || color,
            ...(normalizeSpaceIcon(entry.icon) ? { icon: normalizeSpaceIcon(entry.icon) } : {}), spaceBookmarks: [], temporaryTabs: [] };
    }
    async initialize() {
        if (this.initialized) return;
        if (this.favoriteStore) { await this.favoriteStore.initialize(); await this.favoriteStore.reconcile({ updateSpaces: false }); }
        const data = await chrome.storage.local.get(['spaces', 'spaceModelVersion', 'spaceTabSnapshot', 'spaceWindowSnapshot', 'archivedTabs', SPACE_CONTINUITY_KEY]);
        const session = await chrome.storage.session.get(['spaceSession', 'spaceRestoreQueue', 'activeSpaces', 'restoredTabRanks', 'spaceWindowKeys', 'spaceRestoreWindowKeys', 'spaceRecoveryCandidates']);
        this.spaces = data.spaces || [];
        this.snapshotByTab = new Map((data.spaceTabSnapshot || []).filter(t => t.tabId).map(t => [t.tabId, t]));
        this.provisional = new Set();
        this.recoveryCandidates = new Set(session.spaceSession ? session.spaceRecoveryCandidates || [] : []);
        this.savedWindows = data.spaceWindowSnapshot || [];
        this.windowKeys = new Map(session.spaceSession ? session.spaceWindowKeys || [] : []);
        this.restoreWindowKeys = new Map(session.spaceSession ? session.spaceRestoreWindowKeys || [] : []);
        this.restoredMetadata = [];
        this.restoredRanks = new Map(session.restoredTabRanks || []);
        this.active = session.activeSpaces || {};
        this.defaultSpaceName = (await chrome.storage.sync.get('defaultSpaceName')).defaultSpaceName || 'Home';
        const live = await chrome.tabs.query({});
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
                const members = live.filter(t => legacyIds.has(t.groupId) && !t.pinned && !this.isGlobalTab(t));
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
            if (data.archivedTabs) await chrome.storage.local.set({ archivedTabs: data.archivedTabs.map(t => ({ ...t, spaceId: idMap.get(t.spaceId) || t.spaceId })) });
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
        const restoreKeys = new Set([...this.restoreQueue.map(t => t.windowKey), ...this.restoreWindowKeys.values()]);
        this.savedWindows = this.savedWindows.filter(w => restoreKeys.has(w.key));
        await this.discoverBookmarkSpaces();
        if (!this.spaces.length) {
            this.spaces.push(await this.makeSpace(this.defaultSpaceName));
        }
        if (!session.spaceSession && this.favoriteStore?.ownershipPersistence?.recoverSelection) {
            this.active = await this.favoriteStore.ownershipPersistence.recoverSelection(this.spaces);
        }
        const valid = new Set(live.map(t => t.id));
        for (const space of this.spaces) for (const key of sections) space[key] = (space[key] || []).filter(id => valid.has(id));
        for (const tab of live) this.track(tab);
        this.initialized = true;
        try { await this.persist(); }
        catch (error) { this.initialized = false; throw error; }
    }
    async readSameSessionSnapshot(data) {
        const continuity = this.favoriteStore?.ownershipPersistence;
        const identity = await continuity?.browserIdentity?.({ recovered: true });
        const replay = await readSpaceContinuitySnapshot(identity, data[SPACE_CONTINUITY_KEY], data.spaceTabSnapshot);
        if (!replay) return null;
        const tabs = new Map((await chrome.tabs.query({})).map(tab => [tab.id, tab])), windows = new Map();
        const eligible = tab => tab && !tab.pinned && !tab.incognito && !this.isGlobalTab(tab) && !isStartupLauncherTab(tab);
        for (const record of replay.live) {
            const tab = tabs.get(record.tabId);
            if (eligible(tab) && !windows.has(tab.windowId)) windows.set(tab.windowId, await chrome.windows.get(tab.windowId));
        }
        // Native changes can happen while awaited window reads run. Recheck the
        // exact survivors; an observed normal-window move keeps ordinary Space
        // ownership. A move during validation is uncertainty, not permission
        // to downgrade a saved pin to a temporary tab. Retry before any writes.
        const latest = new Map((await chrome.tabs.query({})).map(tab => [tab.id, tab]));
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
                spaceUuid: space.id, name: space.name, color: space.color, icon: space.icon
            });
            // Only recover metadata belonging to this stable Space identity.
            if (entry.spaceUuid === space.id && space.icon === undefined && normalizeSpaceIcon(entry.icon)) space.icon = normalizeSpaceIcon(entry.icon);
        }
        return before !== JSON.stringify(this.spaces);
    }
    isGlobalTab(tabOrId) { return this.favoriteStore?.ownsTab(tabOrId) || false; }
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
    track(tab, { nativeTabs = null } = {}) {
        this.liveTabs.set(tab.id, tab);
        const url = tab.url || tab.pendingUrl;
        if (tab.pinned || this.isGlobalTab(tab) || isStartupLauncherTab(tab)) {
            this.forgetTab(tab.id);
            return;
        }
        if (url?.startsWith(chrome.runtime?.getURL?.('') || 'chrome-extension://invalid/') && !isPracticeUrl(url)) {
            for (const space of this.spaces) for (const key of sections) space[key] = space[key].filter(id => id !== tab.id);
            return;
        }
        const existing = ownerOf(this.spaces, tab.id);
        if (existing) {
            if ((!this.provisional.has(tab.id) && !this.recoveryCandidates.has(tab.id)) || !url) return;
            this.provisional.delete(tab.id);
        }
        if (!url) this.provisional.add(tab.id);
        const validQueue = this.restoreQueue.filter(t => this.spaces.some(s => s.id === t.spaceId));
        this.restoreQueue = validQueue;
        const restoreKeys = new Set([...validQueue.map(t => t.windowKey), ...this.restoreWindowKeys.values()]);
        const restoredIndex = matchRestoreRecord(tab, validQueue, this.savedWindows.filter(w => restoreKeys.has(w.key)), this.restoreWindowKeys, [...this.liveTabs.values()].filter(tab => !this.isGlobalTab(tab)));
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
        const openerSpace = isNewTabPage ? null : ownerOf(this.spaces, tab.openerTabId);
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
            space[key].push(tab.id);
            space[key].sort((a, b) => (this.restoredRanks.get(a) ?? Infinity) - (this.restoredRanks.get(b) ?? Infinity));
        } else {
            const openerIndex = space[key].indexOf(tab.openerTabId);
            let insertAt = openerIndex < 0 ? space[key].length : openerIndex + 1;
            const opener = nativeTabs ? nativeTabs.find(item => item.id === tab.openerTabId) : this.liveTabs.get(tab.openerTabId);
            if (openerIndex >= 0 && (hasNativeSplit(opener) || nativeTabs && !opener)) {
                // New browser-created children must not split an intact canonical
                // pair. Only a fresh exact native pair proves its insertion edge;
                // an uncertain opener appends without repairing browser state.
                const peers = nativeTabs?.filter(item => item.windowId === tab.windowId &&
                    hasNativeSplit(item) && item.splitViewId === opener?.splitViewId) || [];
                const indices = peers.map(item => space[key].indexOf(item.id));
                const intact = opener?.windowId === tab.windowId && peers.length === 2 && peers.some(item => item.id === tab.openerTabId) &&
                    indices.every(index => index >= 0) && Math.abs(indices[0] - indices[1]) === 1 &&
                    peers.every(item => !item.incognito && item.groupId === opener.groupId && item.pinned === opener.pinned) &&
                    Math.abs(peers[0].index - peers[1].index) === 1;
                insertAt = intact ? Math.max(...indices) + 1 : space[key].length;
            }
            space[key].splice(insertAt, 0, tab.id);
        }
    }
    async persist({ skipGroupSync = false } = {}) {
        const tabs = new Map((await chrome.tabs.query({})).map(t => [t.id, t]));
        this.liveTabs = tabs;
        const liveWindows = new Set([...tabs.values()].map(t => t.windowId));
        for (const keys of [this.windowKeys, this.restoreWindowKeys]) {
            for (const id of keys.keys()) if (!liveWindows.has(id)) keys.delete(id);
        }
        for (const tab of tabs.values()) if (tab.pinned || this.isGlobalTab(tab)) this.forgetTab(tab.id);
        for (const id of this.recoveryCandidates) if (tabs.has(id)) this.track(tabs.get(id));
        this.restoreQueue = this.restoreQueue.filter(t => this.spaces.some(s => s.id === t.spaceId) && !isStartupLauncherUrl(t.url));
        const metadata = await chrome.storage.local.get(['pinnedTabStatesById', 'tabNameOverridesById']);
        const pinnedStates = metadata.pinnedTabStatesById || {};
        const overrides = metadata.tabNameOverridesById || {};
        if (this.restoredMetadata.length) {
            for (const record of this.restoredMetadata) {
                if (record.pinnedState) pinnedStates[record.tabId] = record.pinnedState;
                if (record.nameOverride) overrides[record.tabId] = record.nameOverride;
            }
            await chrome.storage.local.set({ pinnedTabStatesById: pinnedStates, tabNameOverridesById: overrides });
            this.restoredMetadata = [];
        }
        const snapshot = [];
        for (const space of this.spaces) for (const section of sections) {
            space[section] = [...new Set(space[section])].filter(id => {
                if (!tabs.has(id)) return false;
                if (tabs.get(id).pinned || this.isGlobalTab(tabs.get(id)) || isStartupLauncherTab(tabs.get(id))) { this.snapshotByTab.delete(id); return false; }
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
            if (!windowSnapshot.some(w => w.key === key)) windowSnapshot.push({ key, tabs: captureWindowTabs([...tabs.values()].filter(t => t.windowId === windowId && !this.isGlobalTab(t) && !isStartupLauncherTab(t))) });
        }
        this.savedWindows = windowSnapshot;
        const identity = await this.favoriteStore?.ownershipPersistence?.browserIdentity?.();
        const stamp = await createSpaceContinuityStamp(identity, snapshot);
        await chrome.storage.local.set({ spaces: clone(this.spaces), spaceModelVersion: 2, spaceTabSnapshot: [...snapshot, ...this.restoreQueue], spaceWindowSnapshot: windowSnapshot, [SPACE_CONTINUITY_KEY]: stamp });
        const spaceSessionUpdate = { spaceSession: true, activeSpaces: this.active, spaceRestoreQueue: this.restoreQueue, restoredTabRanks: [...this.restoredRanks], spaceWindowKeys: [...this.windowKeys], spaceRestoreWindowKeys: [...this.restoreWindowKeys], spaceRecoveryCandidates: [...new Set([...this.recoveryCandidates, ...this.provisional])] };
        const favorites = this.favoriteStore;
        if (favorites?.ownershipPersistence?.checkpointSelection) {
            try {
                await favorites.ownershipPersistence.checkpointSelection({ state: favorites.state, items: favorites.items,
                    spaces: this.spaces, activeSpaces: this.active, spaceSessionUpdate });
            } catch (error) {
                // A rejected checkpoint must reload its authoritative session
                // before a later read can expose the uncommitted selection.
                this.initialized = false;
                throw error;
            }
        } else await chrome.storage.session.set(spaceSessionUpdate);
        try { if (!skipGroupSync) await syncSpaceGroups(this.spaces, this.active, [...tabs.values()].filter(tab => this.isGlobalTab(tab)).map(tab => tab.id)); }
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
            case 'patch': {
                const nextSpaces = applySpacePatch(this.spaces, message.before, message.after);
                assertNativeSplitMembershipPreserved(this.spaces, nextSpaces, await chrome.tabs.query({}));
                for (const next of message.after) {
                    const prev = message.before.find(s => s.id === next.id);
                    for (const key of sections) if (JSON.stringify(next[key]) !== JSON.stringify(prev?.[key])) {
                        for (const id of next[key] || []) this.restoredRanks.delete(id);
                    }
                }
                this.spaces = nextSpaces;
                if (!this.spaces.length) this.spaces.push(await this.makeSpace(this.defaultSpaceName));
                break;
            }
            case 'metadata': {
                const space = this.spaces.find(space => space.id === message.spaceId);
                if (!space) throw new Error('This Space no longer exists.');
                const attrs = message.changes || {};
                if (Object.keys(attrs).some(key => !['name', 'color', 'icon'].includes(key))) throw new Error('Unsupported Space setting.');
                if (attrs.name !== undefined && (typeof attrs.name !== 'string' || !attrs.name.trim() || attrs.name.trim().length > 256)) throw new Error('Enter a Space name between 1 and 256 characters.');
                if (attrs.color !== undefined && !SPACE_COLORS.includes(attrs.color)) throw new Error('Choose one of the eight Space colors.');
                if (attrs.icon !== undefined && attrs.icon !== null && normalizeSpaceIcon(attrs.icon) !== attrs.icon) throw new Error('Choose an icon from the Space icon picker.');
                const folder = await getSpaceBookmarkFolder(space);
                const entry = await LocalStorage.getOrCreateSpaceRegistryEntry(folder.id, { spaceUuid: space.id, name: space.name, color: space.color, icon: space.icon });
                if (entry.spaceUuid !== space.id) throw new Error('This Space bookmark identity has changed. Refresh and try again.');
                const changes = { ...attrs, ...(attrs.name !== undefined ? { name: attrs.name.trim() } : {}) };
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
            case 'activate': this.active[message.windowId] = message.spaceId; break;
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
                if (this.isGlobalTab(message.tabId)) break;
                const target = this.spaces.find(s => s.id === message.spaceId);
                if (target) {
                    assertNotNativeSplit((await chrome.tabs.query({})).find(tab => tab.id === message.tabId));
                    this.provisional.delete(message.tabId);
                    this.recoveryCandidates.delete(message.tabId);
                    for (const space of this.spaces) for (const key of sections) space[key] = space[key].filter(id => id !== message.tabId);
                    target[message.pinned ? 'spaceBookmarks' : 'temporaryTabs'].push(message.tabId);
                }
                break;
            }
            case 'import': {
                const groups = await chrome.tabGroups.query({ windowId: message.windowId });
                const tabs = await chrome.tabs.query({ windowId: message.windowId });
                for (const group of groups) {
                    let name = group.title || 'Imported space';
                    const base = name;
                    for (let i = 2; this.spaces.some(s => s.name === name); i++) name = `${base} ${i}`;
                    const space = await this.makeSpace(name, group.color);
                    const ids = tabs.filter(t => t.groupId === group.id && !t.pinned && !this.isGlobalTab(t)).map(t => t.id);
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
        return clone(this.spaces);
    }
    async closeOwnedTabs(spaceId, { windowId, temporaryOnly = false } = {}) {
        const space = this.spaces.find(space => space.id === spaceId);
        if (!space) return [];
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
        for (const tab of await chrome.tabs.query({})) {
            if (windowId !== undefined && tab.windowId !== windowId || tab.pinned || tab.incognito || isStartupLauncherTab(tab)
                || this.isGlobalTab(tab) || ownerOf(this.spaces, tab.id)?.id !== spaceId
                || temporaryOnly && isProtectedFavorite(tab, protectedIds, legacyBindings, protectedUrls)) continue;
            // Revalidate the exact tab immediately before removal while holding
            // the same queue as Favorite adoption, release, cleanup and archive.
            let current;
            try { current = await chrome.tabs.get(tab.id); } catch { continue; }
            if (current.windowId !== tab.windowId || current.pinned || current.incognito || this.isGlobalTab(current)
                || ownerOf(this.spaces, current.id)?.id !== spaceId) continue;
            await chrome.tabs.remove(current.id); this.forgetTab(current.id); closed.push(current.id);
        }
        return closed;
    }
    install() {
        const handle = operation => this.run(async () => { await operation(); await this.persist(); }).catch(console.error);
        chrome.tabs.onCreated.addListener(tab => handle(async () => {
            if (!tab.openerTabId) return this.track(tab);
            let nativeTabs;
            try { nativeTabs = (await chrome.tabs.query({ windowId: tab.windowId })).filter(item => item.windowId === tab.windowId); }
            catch { nativeTabs = []; }
            this.track(nativeTabs.find(item => item.id === tab.id) || tab, { nativeTabs });
        }));
        chrome.tabs.onUpdated.addListener((id, change, tab) => {
            if (change.url || change.pinned !== undefined) handle(() => this.track(tab));
        });
        chrome.tabs.onRemoved.addListener((id, info) => handle(() => {
            const record = this.snapshotByTab.get(id);
            if (info?.isWindowClosing && record && this.spaces.some(s => s.id === record.spaceId)) this.restoreQueue.push(record);
            this.snapshotByTab.delete(id);
            this.provisional.delete(id);
            this.recoveryCandidates.delete(id);
            this.liveTabs.delete(id);
            for (const space of this.spaces) {
                for (const key of sections) space[key] = space[key].filter(t => t !== id);
                if (space.lastTab === id) delete space.lastTab;
            }
        }));
        chrome.tabs.onReplaced.addListener((added, removed) => handle(() => {
            for (const ids of [this.provisional, this.recoveryCandidates]) {
                if (ids.delete(removed)) ids.add(added);
            }
            for (const space of this.spaces) {
                for (const key of sections) space[key] = space[key].map(id => id === removed ? added : id);
                if (space.lastTab === removed) space.lastTab = added;
            }
        }));
        chrome.tabs.onActivated.addListener(info => handle(() => {
            const space = this.isGlobalTab(info.tabId) ? null : ownerOf(this.spaces, info.tabId);
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
        chrome.tabs.onAttached?.addListener(tabId => handle(async () => {
            // Native attachment can race a Favorite release. Re-track the exact
            // survivor, rather than only persisting its now-empty old ownership.
            this.track(await chrome.tabs.get(tabId));
        }));
        chrome.tabs.onDetached?.addListener(scheduleSync);
        chrome.tabs.onUpdated.addListener((id, change) => { if (change.groupId !== undefined || change.splitViewId !== undefined) scheduleSync(); });
        chrome.tabGroups.onRemoved.addListener(scheduleSync);
        chrome.tabGroups.onUpdated.addListener(scheduleSync);
        this.run(() => {}).catch(console.error);
    }
}
