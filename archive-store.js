import { assertNotTransient } from './transient-safety.js';
import { observeArchiveCreate } from './archive-create-settlement.js';
import { getSpaceBookmarkFolder } from './space-bookmarks.js';
import { isStartupLauncherTab, isStartupLauncherUrl } from './startup-launcher-tab.js';
import { isPracticeUrl } from './tour-practice.js';
import { assertNotNativeSplit } from './native-split-safety.js';
import { isSafeUrl } from './spotlight-bridge-protocol.js';
import { Utils } from './utils.js';

export const ARCHIVE_KEY = 'archivedTabs';
export const ARCHIVE_CLAIMS_KEY = 'archiveReopenClaims';
export const ARCHIVE_SESSION_KEY = 'archiveBrowserSession';
const copy = value => structuredClone(value);
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 200;
const nativeId = value => Number.isSafeInteger(value) && value > 0;
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const encode = value => JSON.stringify(value, (_key, item) => record(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const same = (a, b) => encode(a) === encode(b);
const withoutId = entry => { const result = { ...entry }; delete result.entryId; return result; };
const fail = (code, message, extra = {}) => { throw Object.assign(new Error(message), { code, ...extra }); };
const stale = () => fail('STALE_ARCHIVE', 'This archived entry, window, or Space changed. Refresh the archive before trying again.');
const uncertain = extra => fail('UNCERTAIN_RESULT', 'An earlier reopen may have created a tab, but its exact identity cannot be safely confirmed. The archived entry is retained. Check your tabs; no second tab was created. Restarting does not clear this claim.', extra);
const locations = (store, tabId) => store.spaces.flatMap(space => ['spaceBookmarks', 'temporaryTabs'].flatMap(section =>
    (space[section] || []).filter(value => value === tabId).map(() => ({ space, section }))));
export const isReopenableArchiveUrl = url => isSafeUrl(url) && !/[\u0000-\u0020\u007f]/.test(url)
    && !isStartupLauncherUrl(url) && !isPracticeUrl(url) && !['chrome://newtab', 'chrome://newtab/'].includes(url.split(/[?#]/)[0]);

// Native/browser writes cannot be locked. Fence each final read boundary so
// events during awaited storage/bookmark/native reads cannot attest a stale tab.
export async function fencedArchiveRead(request, operation, tabId = null) {
    let changed = false;
    const cleanups = [], ids = new Set([request.context?.sourceTabId, tabId].filter(nativeId));
    const watch = (event, callback) => {
        if (!event?.addListener || !event.removeListener) return;
        event.addListener(callback); cleanups.push(() => event.removeListener(callback));
    };
    const change = () => { changed = true; };
    watch(chrome.tabs?.onUpdated, (id, update) => {
        if (!ids.has(id)) return;
        // A newly created inactive target may finish loading while its exact
        // native/store identity is read. Presentation and completion alone do
        // not change that identity. Keep every source event and all navigation,
        // mutation, malformed or unknown target updates fenced.
        const presentationOnly = id === tabId && id !== request.context?.sourceTabId && record(update)
            && Object.keys(update).length > 0 && Object.entries(update).every(([key, value]) =>
                key === 'status' ? value === 'complete' : ['title', 'favIconUrl'].includes(key) && typeof value === 'string');
        if (!presentationOnly) change();
    });
    for (const name of ['onRemoved', 'onAttached', 'onDetached']) watch(chrome.tabs?.[name], id => { if (ids.has(id)) change(); });
    watch(chrome.tabs?.onReplaced, (added, removed) => { if (ids.has(added) || ids.has(removed)) change(); });
    watch(chrome.tabs?.onActivated, info => { if (info.windowId === request.windowId) change(); });
    watch(chrome.windows?.onRemoved, windowId => { if (windowId === request.windowId) change(); });
    for (const name of ['onChanged', 'onMoved', 'onRemoved', 'onCreated']) watch(chrome.bookmarks?.[name], change);
    watch(chrome.storage?.onChanged, (changes, area) => {
        const keys = area === 'local' ? [ARCHIVE_KEY, 'spaces', 'pinnedTabStatesById', 'persistentFavorites', 'arcifyBridgePeerId', 'arcifyBridgePairingGeneration']
            : area === 'session' ? ['activeSpaces', 'favoriteSession', ARCHIVE_SESSION_KEY] : [];
        if (keys.some(key => key in changes && !same(changes[key].oldValue, changes[key].newValue))) change();
    });
    try { const result = await operation(); if (changed) stale(); return result; }
    finally { cleanups.forEach(cleanup => cleanup()); }
}

// Additive, order-preserving migration. Rotate ALL copies of a duplicated ID so
// a previously issued reference cannot silently select one arbitrary duplicate.
export function migrateArchiveEntries(entries) {
    if (!Array.isArray(entries)) fail('INVALID_ARCHIVE', 'Archive storage is malformed. Nothing was changed.');
    const counts = new Map();
    for (const entry of entries) if (record(entry) && id(entry.entryId)) counts.set(entry.entryId, (counts.get(entry.entryId) || 0) + 1);
    const used = new Set(counts.keys());
    return entries.map(entry => {
        if (!record(entry)) fail('INVALID_ARCHIVE', 'Archive storage contains an invalid entry. Nothing was changed.');
        if (id(entry.entryId) && counts.get(entry.entryId) === 1) return copy(entry);
        let entryId;
        do { entryId = crypto.randomUUID(); } while (used.has(entryId));
        used.add(entryId);
        return { ...copy(entry), entryId };
    });
}

// Sole archive writer. Public methods enter the existing SpaceStore queue;
// methods ending in Unlocked are ONLY for callers already holding that queue.
export class ArchiveStore {
    constructor(store) { this.store = store; this.pendingCreatedIds = new Set(); }
    run(operation) { return this.store.run(operation); }
    list() { return this.run(() => this.listUnlocked()); }
    view(windowId) { return this.run(() => this.viewUnlocked(windowId)); }
    add(entry) { return this.run(() => this.addUnlocked(entry)); }
    archive(request, options) { return this.run(() => this.archiveUnlocked(request, options)); }
    reopen(request) { return this.run(() => this.reopenUnlocked(request)); }
    async listUnlocked() {
        const stored = (await chrome.storage.local.get(ARCHIVE_KEY))[ARCHIVE_KEY];
        const value = stored === undefined ? [] : stored;
        const entries = migrateArchiveEntries(value);
        if (!same(value, entries)) await chrome.storage.local.set({ [ARCHIVE_KEY]: entries });
        return entries;
    }
    async initializeClaimsUnlocked() {
        const sessionId = (await chrome.storage.session.get(ARCHIVE_SESSION_KEY))[ARCHIVE_SESSION_KEY];
        const claims = await this.claimsUnlocked();
        this.pendingCreatedIds = new Set(Object.values(claims).filter(claim => claim?.sessionId === sessionId
            && id(sessionId) && ['created', 'assigned'].includes(claim.phase) && nativeId(claim.tabId)).map(claim => claim.tabId));
    }
    async migrateSpaceIdsUnlocked(idMap) {
        const entries = await this.listUnlocked();
        const next = entries.map(entry => ({ ...entry, spaceId: idMap.get(entry.spaceId) || entry.spaceId }));
        if (!same(entries, next)) await chrome.storage.local.set({ [ARCHIVE_KEY]: next });
    }
    async replaceUnlocked(entries, expected) {
        const current = await this.listUnlocked();
        if (!Array.isArray(expected) || !same(current, expected)) stale();
        const next = migrateArchiveEntries(entries);
        await chrome.storage.local.set({ [ARCHIVE_KEY]: next });
        return next;
    }
    resolve(entries, expected) {
        if (!record(expected)) stale();
        const matches = id(expected.entryId) ? entries.filter(entry => entry.entryId === expected.entryId && same(entry, expected))
            : entries.filter(entry => same(withoutId(entry), withoutId(expected)));
        if (matches.length !== 1) stale();
        return matches[0];
    }
    async removeUnlocked(expected) {
        const entries = await this.listUnlocked(), entry = this.resolve(entries, expected);
        await chrome.storage.local.set({ [ARCHIVE_KEY]: entries.filter(value => value.entryId !== entry.entryId) });
        return { entryId: entry.entryId };
    }
    async addUnlocked(data, { beforeWrite = async () => {} } = {}) {
        if (!record(data) || !data.url || !data.name || !data.spaceId || isStartupLauncherUrl(data.url)) return null;
        const entries = await this.listUnlocked();
        const existing = entries.find(entry => entry.url === data.url);
        if (existing) return { entry: existing, added: false };
        const entry = { ...copy(data), entryId: crypto.randomUUID(), archivedAt: Date.now() };
        const next = [...entries, entry].sort((a, b) => b.archivedAt - a.archivedAt).slice(0, 100);
        await beforeWrite();
        await chrome.storage.local.set({ [ARCHIVE_KEY]: next });
        return { entry, added: true };
    }
    space(spaceId, bookmarkFolderId) {
        const matches = this.store.spaces.filter(space => space.id === spaceId);
        if (matches.length !== 1 || !id(bookmarkFolderId) || matches[0].bookmarkFolderId !== bookmarkFolderId
            || this.store.spaces.filter(space => space.bookmarkFolderId === bookmarkFolderId).length !== 1) stale();
        return matches[0];
    }
    async window(windowId) {
        assertNotTransient(this.store, { windowId });
        if (!nativeId(windowId)) stale();
        const window = await chrome.windows.get(windowId);
        assertNotTransient(this.store, { windowId });
        if (window?.id !== windowId || window.type !== 'normal' || window.incognito) stale();
    }
    async rootUnlocked(space) {
        const folder = await getSpaceBookmarkFolder(space);
        const roots = (await chrome.bookmarks.search({ title: 'Arcify' })).filter(node => !node.url);
        if (roots.length !== 1 || folder.id !== space.bookmarkFolderId || folder.parentId !== roots[0].id) stale();
        this.space(space.id, space.bookmarkFolderId);
    }
    async contextUnlocked(windowId, expected = null) {
        await this.window(windowId);
        const space = this.store.spaces.find(space => space.id === this.store.active[windowId]);
        if (!space) stale();
        this.space(space.id, space.bookmarkFolderId);
        await this.rootUnlocked(space);
        const tabs = await chrome.tabs.query({ windowId, active: true });
        const active = tabs.filter(tab => tab.windowId === windowId && tab.active && !tab.incognito);
        if (active.length !== 1) stale();
        const tab = active[0];
        assertNotTransient(this.store, { windowId, tab });
        const context = { windowId, spaceId: space.id, bookmarkFolderId: space.bookmarkFolderId,
            sourceTabId: tab.id, sourceUrl: tab.url || tab.pendingUrl || '' };
        if (tab.pendingUrl && tab.pendingUrl !== context.sourceUrl) stale();
        if (expected && !same(context, expected)) stale();
        if (this.store.active[windowId] !== space.id) stale();
        return context;
    }
    async viewUnlocked(windowId) {
        await this.window(windowId);
        const entries = await this.listUnlocked(), context = await this.contextUnlocked(windowId);
        return { context, entries: entries.map(entry => ({ entry, bookmarkFolderId: this.store.spaces.find(space => space.id === entry.spaceId)?.bookmarkFolderId || null })) };
    }
    async targetUnlocked(request, tabId = null, { assigned = false, beforeMutation = async () => {}, settlement = null } = {}) {
        return fencedArchiveRead(request, async () => {
            settlement?.assert();
            assertNotTransient(this.store, { windowId: request.windowId, tabId: request.context?.sourceTabId });
            assertNotTransient(this.store, { tabId });
            if (!record(request.context) || request.context.windowId !== request.windowId) stale();
            const entry = this.resolve(await this.listUnlocked(), request.expected);
            const space = this.space(entry.spaceId, request.bookmarkFolderId);
            if (!isReopenableArchiveUrl(entry.url)) fail('UNSUPPORTED_URL', 'This URL cannot be reopened safely. The archived entry is retained.');
            const binding = tabId ? await Utils.getPinnedTabState(tabId) : null;
            await this.rootUnlocked(space);
            await this.contextUnlocked(request.windowId, request.context);
            this.resolve(await this.listUnlocked(), request.expected);
            this.space(entry.spaceId, request.bookmarkFolderId);
            // Storage and bookmark reads precede the final native snapshot.
            await beforeMutation();
            const tabs = await chrome.tabs.query({});
            const source = tabs.filter(tab => tab.windowId === request.windowId && tab.active);
            assertNotTransient(this.store, { windowId: request.windowId, tab: source[0] });
            if (source.length !== 1 || source[0].id !== request.context.sourceTabId || source[0].incognito
                || (source[0].url || source[0].pendingUrl || '') !== request.context.sourceUrl
                || source[0].pendingUrl && source[0].pendingUrl !== request.context.sourceUrl
                || this.store.active[request.windowId] !== request.context.spaceId) stale();
            const tab = tabId ? tabs.find(tab => tab.id === tabId) : null;
            if (tabId) {
                assertNotTransient(this.store, { windowId: request.windowId, tab });
                if (!tab || tab.windowId !== request.windowId || tab.pinned || tab.incognito
                    || this.store.isGlobalTab(tab) || isStartupLauncherTab(tab) || binding?.bookmarkId) stale();
                // A durable claim proves the native ID, not continued URL ownership.
                // Resumed claims have no fresh-create observer, so always enforce
                // the exact settled destination at every mutation boundary.
                if (tab.url !== entry.url || tab.pendingUrl || tab.status !== 'complete') stale();
                assertNotNativeSplit(tab);
                const owners = locations(this.store, tabId);
                if (owners.length && (owners.length !== 1 || owners[0].space.id !== space.id || owners[0].section !== 'temporaryTabs')
                    || assigned && owners.length !== 1) stale();
            }
            if (tabId) settlement?.verify(tab);
            return { entry, space, tab };
        }, tabId);
    }
    async sessionUnlocked() {
        const session = (await chrome.storage.session.get(ARCHIVE_SESSION_KEY))[ARCHIVE_SESSION_KEY];
        if (id(session)) return session;
        const next = crypto.randomUUID();
        await chrome.storage.session.set({ [ARCHIVE_SESSION_KEY]: next });
        return next;
    }
    async claimsUnlocked() {
        const claims = (await chrome.storage.local.get(ARCHIVE_CLAIMS_KEY))[ARCHIVE_CLAIMS_KEY];
        if (claims === undefined) return Object.create(null);
        if (!record(claims) || claims.version !== 1 || !record(claims.entries)) uncertain();
        for (const [entryId, claim] of Object.entries(claims.entries)) {
            if (!record(claim) || claim.entryId !== entryId || !id(entryId) || !id(claim.sessionId) || !id(claim.requestId)
                || !nativeId(claim.windowId) || !id(claim.bookmarkFolderId) || !record(claim.expected) || claim.expected.entryId !== entryId
                || !['creating', 'created', 'assigned', 'consumed'].includes(claim.phase)
                || (claim.phase === 'creating' ? claim.tabId !== null : !nativeId(claim.tabId))
                || claim.phase === 'consumed' && (!record(claim.result) || claim.result.consumed !== true || claim.result.entryId !== entryId
                    || claim.result.tabId !== claim.tabId)) uncertain();
        }
        return Object.assign(Object.create(null), claims.entries);
    }
    async writeClaimUnlocked(claim) {
        const entries = await this.claimsUnlocked();
        entries[claim.entryId] = copy(claim);
        this.compactClaims(entries);
        await chrome.storage.local.set({ [ARCHIVE_CLAIMS_KEY]: { version: 1, entries } });
    }
    compactClaims(entries) {
        // A pruned completed receipt can only cause a stale replay: its saved
        // entry is absent. Unresolved claims are never cleared or time-expired.
        const completed = Object.values(entries).filter(claim => claim.phase === 'consumed');
        for (const claim of completed.slice(0, Math.max(0, completed.length - 100))) delete entries[claim.entryId];
    }
    async reopenUnlocked(request, { beforeMutation = async () => {} } = {}) {
        await beforeMutation();
        if (!record(request) || !id(request.requestId) || !record(request.expected) || !nativeId(request.windowId)) stale();
        assertNotTransient(this.store, { windowId: request.windowId, tabId: request.context?.sourceTabId });
        await this.window(request.windowId);
        assertNotTransient(this.store, { windowId: request.windowId, tabId: request.context?.sourceTabId });
        const sessionId = await this.sessionUnlocked();
        let claims = await this.claimsUnlocked();
        const previous = id(request.expected.entryId) && claims[request.expected.entryId];
        if (previous?.phase === 'consumed' && same(previous.expected, request.expected)) {
            if (previous.windowId !== request.windowId || previous.bookmarkFolderId !== request.bookmarkFolderId) stale();
            if (previous.sessionId !== sessionId) return { status: 'reopened', consumed: true, entryId: previous.entryId, tabId: null,
                warning: 'This entry was reopened in an earlier browser session. Its old tab ID is no longer trusted.' };
            return { ...copy(previous.result), replayed: true };
        }
        const target = await this.targetUnlocked(request, null, { beforeMutation }), { entry } = target;
        let claim = claims[entry.entryId], settlement = null;
        if (!claim) {
            const currentIds = new Set((await this.listUnlocked()).map(value => value.entryId));
            // Repairing a damaged/duplicated entry ID cannot clear an unresolved
            // create. An exact unchanged tuple only blocks recreation here; it
            // never supplies native-tab identity or merges distinct live IDs.
            if (Object.values(claims).some(previous => previous.phase !== 'consumed' && !currentIds.has(previous.entryId)
                && same(withoutId(previous.expected), withoutId(entry)))) uncertain({ entryId: entry.entryId });
        }
        if (claim) {
            if (claim.sessionId !== sessionId || !nativeId(claim.tabId) || !['created', 'assigned'].includes(claim.phase)
                || !same(claim.expected, entry) || claim.windowId !== request.windowId || claim.bookmarkFolderId !== request.bookmarkFolderId) uncertain();
        } else {
            claim = { entryId: entry.entryId, expected: copy(entry), requestId: request.requestId, windowId: request.windowId,
                bookmarkFolderId: request.bookmarkFolderId, sessionId, phase: 'creating', tabId: null };
            await this.writeClaimUnlocked(claim);
            // If this final preflight fails, no native create was attempted, so
            // only this proven unstarted claim may be removed.
            try { settlement = observeArchiveCreate(request); await this.targetUnlocked(request, null, { beforeMutation }); settlement.assert(); }
            catch (error) {
                settlement?.stop();
                claims = await this.claimsUnlocked(); delete claims[entry.entryId];
                await chrome.storage.local.set({ [ARCHIVE_CLAIMS_KEY]: { version: 1, entries: claims } }); throw error;
            }
            let tab;
            try { tab = await chrome.tabs.create({ windowId: request.windowId, url: entry.url, active: false }); }
            catch { settlement.stop(); uncertain({ entryId: entry.entryId }); }
            if (!nativeId(tab?.id)) { settlement.stop(); uncertain({ entryId: entry.entryId }); }
            settlement.bind(tab);
            claim = { ...claim, tabId: tab.id, phase: 'created' };
            this.pendingCreatedIds.add(tab.id);
            try { await this.writeClaimUnlocked(claim); }
            catch { settlement.stop(); uncertain({ entryId: entry.entryId, tabId: tab.id }); }
        }
        try {
            await settlement?.wait();
            await this.store.readTodayPlacement();
            const { space, tab } = await this.targetUnlocked(request, claim.tabId, { beforeMutation, settlement });
            settlement?.handoffAuthority();
            const owned = locations(this.store, tab.id);
            if (!owned.length) {
                this.store.forgetTab(tab.id);
                this.store.insertCreatedToday(space, tab);
            }
            try {
                await this.store.persist({ skipGroupSync: true, beforeWrite: () => this.targetUnlocked(request, claim.tabId, { assigned: true, beforeMutation, settlement }) });
            } catch (error) {
                // A beforeWrite refusal or lost write response must not let a
                // later native event persist tentative in-memory membership.
                this.store.initialized = false;
                throw error;
            }
            claim = { ...claim, phase: 'assigned' };
            await this.writeClaimUnlocked(claim);
            const entries = await this.listUnlocked(); this.resolve(entries, request.expected);
            claims = await this.claimsUnlocked();
            const { tab: confirmed } = await this.targetUnlocked(request, claim.tabId, { assigned: true, beforeMutation, settlement });
            const result = { status: 'reopened', consumed: true, entryId: entry.entryId, tabId: tab.id, tab: confirmed, spaceId: space.id, windowId: request.windowId };
            claims[entry.entryId] = { ...claim, phase: 'consumed', result };
            this.compactClaims(claims);
            // Receipt and exact removal are one durable commit. A lost response
            // is replayable; no URL-based deletion or second native create.
            settlement?.assert();
            await chrome.storage.local.set({ [ARCHIVE_KEY]: entries.filter(value => value.entryId !== entry.entryId),
                [ARCHIVE_CLAIMS_KEY]: { version: 1, entries: claims } });
            this.pendingCreatedIds.delete(tab.id);
            try {
                // Consume is already durable. A newer user selection during
                // that storage call must not be overwritten by display work.
                await fencedArchiveRead(request, async () => {
                    await beforeMutation();
                    await this.contextUnlocked(request.windowId, request.context);
                    await this.rootUnlocked(space);
                    const live = await chrome.tabs.get(tab.id);
                    assertNotTransient(this.store, { windowId: request.windowId, tab: live });
                    if (!live || live.windowId !== request.windowId || live.incognito || live.pinned || this.store.isGlobalTab(live)
                        || live.url !== entry.url || live.pendingUrl || live.status !== 'complete') stale();
                    assertNotNativeSplit(live);
                    settlement?.verify(live);
                }, tab.id);
                settlement?.assert(); settlement?.stop();
                const focusRequest = { ...request, context: { ...request.context, spaceId: space.id, bookmarkFolderId: space.bookmarkFolderId } };
                this.store.active[request.windowId] = space.id; space.lastTab = tab.id;
                try {
                    await this.store.persist({ beforeWrite: () => fencedArchiveRead(focusRequest, async () => {
                        await beforeMutation();
                        await this.contextUnlocked(request.windowId, focusRequest.context);
                    }, tab.id) });
                } catch (error) {
                    // Reload durable selection before any later queued write;
                    // never guess which side of a failed storage call committed.
                    this.store.initialized = false;
                    throw error;
                }
                await fencedArchiveRead(focusRequest, async () => {
                    await beforeMutation();
                    await this.contextUnlocked(request.windowId, focusRequest.context);
                    const live = await chrome.tabs.get(tab.id);
                    assertNotTransient(this.store, { windowId: request.windowId, tab: live });
                    if (!live || live.windowId !== request.windowId || live.incognito || live.pinned || this.store.isGlobalTab(live)
                        || live.url !== entry.url || live.pendingUrl || live.status !== 'complete') stale();
                    assertNotNativeSplit(live);
                }, tab.id);
                await chrome.tabs.update(tab.id, { active: true });
                // Activating a tab is asynchronous and may revoke pairing or
                // yield to a newer selection. Do not focus the window on the
                // strength of authority checked before activation.
                const activatedRequest = { ...focusRequest, context: { ...focusRequest.context,
                    sourceTabId: tab.id, sourceUrl: confirmed.url || confirmed.pendingUrl || entry.url } };
                await fencedArchiveRead(activatedRequest, async () => {
                    await beforeMutation();
                    await this.contextUnlocked(request.windowId, activatedRequest.context);
                    const live = await chrome.tabs.get(tab.id);
                    assertNotTransient(this.store, { windowId: request.windowId, tab: live });
                    if (!live || live.windowId !== request.windowId || !live.active || live.incognito || live.pinned || this.store.isGlobalTab(live)
                        || live.url !== entry.url || live.pendingUrl || live.status !== 'complete') stale();
                    assertNotNativeSplit(live);
                }, tab.id);
                await chrome.windows.update(request.windowId, { focused: true });
            } catch (error) {
                const partial = { ...result, status: 'partial', warning: `The archived tab was reopened as tab ${tab.id}, but focus or display refresh failed. ${error.message} No second tab was created.` };
                try { await this.writeClaimUnlocked({ ...claim, phase: 'consumed', result: partial }); } catch { /* The committed consume receipt still prevents creation. */ }
                return partial;
            }
            return result;
        } catch (error) {
            // A storage call may commit atomically then lose its response.
            // Recover only its exact receipt; never infer success by URL/tab ID.
            try {
                const receipt = (await this.claimsUnlocked())[entry.entryId];
                if (receipt?.phase === 'consumed' && receipt.sessionId === sessionId && same(receipt.expected, entry)) {
                    this.pendingCreatedIds.delete(claim.tabId);
                    return { ...copy(receipt.result), status: 'partial', warning: `The archived tab was reopened as tab ${claim.tabId}, but completion or focus could not be confirmed. ${error.message} No second tab was created.` };
                }
            } catch { /* Unknown storage outcome remains an unresolved result. */ }
            fail('REOPEN_PARTIAL', `Tab ${claim.tabId} was created, but its exact Space assignment or archive removal could not be confirmed. The entry is retained unless its completed receipt was committed. Nothing was retried. ${error.message}`,
                { tabId: claim.tabId, entryId: entry.entryId, consumed: false });
        } finally { settlement?.stop(); }
    }
    async archiveUnlocked(request, { automatic = false, protectedUrlKeys = new Set() } = {}) {
        const resolve = async () => {
            const { tabId, windowId, spaceId, bookmarkFolderId, url } = request;
            assertNotTransient(this.store, { windowId, tabId });
            await this.window(windowId);
            const space = this.space(spaceId, bookmarkFolderId); await this.rootUnlocked(space);
            const bindings = await Utils.getPinnedTabStates();
            const tab = await chrome.tabs.get(tabId), owners = locations(this.store, tabId);
            assertNotTransient(this.store, { windowId, tab });
            if (!tab || tab.id !== tabId || tab.windowId !== windowId || tab.url !== url || tab.incognito || tab.pinned
                || this.store.isGlobalTab(tab) || isStartupLauncherTab(tab) || owners.length !== 1 || owners[0].space.id !== spaceId) stale();
            assertNotNativeSplit(tab);
            if (automatic && (tab.active || tab.audible || owners[0].section === 'spaceBookmarks' || bindings[tabId]?.bookmarkId
                || protectedUrlKeys.has(Utils.getPinnedUrlKey(tab.url)))) stale();
            return tab;
        };
        const tab = await resolve();
        const result = await this.addUnlocked({ url: tab.url, name: tab.title || tab.url, spaceId: request.spaceId }, { beforeWrite: resolve });
        if (!result) return { archived: false };
        await resolve();
        await chrome.tabs.remove(tab.id);
        this.store.forgetTab(tab.id);
        await this.store.persist();
        return { archived: true, entryId: result.entry.entryId };
    }
}

export function registerArchiveMessages(store) {
    chrome.runtime.onMessage.addListener((message, sender, respond) => {
        if (message?.type !== 'archiveStore') return;
        const ownUrl = chrome.runtime.getURL('');
        if (sender?.id !== chrome.runtime.id || sender.url && !sender.url.startsWith(ownUrl)
            || sender.origin && sender.origin !== ownUrl.replace(/\/$/, '')
            || sender.tab && (!nativeId(message.windowId) || sender.tab.windowId !== message.windowId)) {
            respond({ success: false, code: 'UNAUTHORIZED', error: 'Invalid archive sender.' }); return;
        }
        const fields = { list: ['windowId'], view: ['windowId'], add: ['entry', 'windowId'], replace: ['entries', 'expected', 'windowId'], remove: ['expected', 'windowId'],
            archive: ['tabId', 'windowId', 'spaceId', 'bookmarkFolderId', 'url'], reopen: ['requestId', 'windowId', 'context', 'expected', 'bookmarkFolderId'] };
        if (!Object.hasOwn(fields, message.action) || Object.keys(message).some(key => !['type', 'action', ...fields[message.action]].includes(key))
            || Object.hasOwn(message, 'windowId') && !nativeId(message.windowId)) {
            respond({ success: false, code: 'INVALID_REQUEST', error: 'Invalid archive request.' }); return;
        }
        const archive = store.archiveStore;
        store.run(async () => {
            switch (message.action) {
                case 'list': return archive.listUnlocked();
                case 'view': return archive.viewUnlocked(message.windowId);
                case 'add': return archive.addUnlocked(message.entry);
                case 'replace': return archive.replaceUnlocked(message.entries, message.expected);
                case 'remove': return archive.removeUnlocked(message.expected);
                case 'archive': return archive.archiveUnlocked(message);
                case 'reopen': return archive.reopenUnlocked(message);
            }
        }).then(result => respond({ success: true, result }), error => respond({ success: false, error: error.message,
            code: error.code, tabId: error.tabId, entryId: error.entryId, consumed: error.consumed }));
        return true;
    });
}
