import { getSpaceBookmarkById } from './space-bookmarks.js';
import { Utils } from './utils.js';
import { isStartupLauncherTab } from './startup-launcher-tab.js';
import { isFavoriteUrl, isWindowId } from './spotlight-bridge-protocol.js';
import { captureFavoriteIcon, favoriteIconCacheSize, isFavoriteIcon, MAX_FAVORITE_ICON_CACHE, FAVORITE_ICON_CACHE_KEY } from './favorite-icons.js';

export const FAVORITES_KEY = 'persistentFavorites';
export const FAVORITE_SESSION_KEY = 'favoriteSession';
export const MAX_FAVORITE_BOOKMARK_BATCH = 100;
const copy = value => structuredClone(value);
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 200;
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const key = value => `${value.favoriteId}:${value.windowId}`;
const fields = {
    get: [], addTab: ['tabId', 'beforeId'],
    addBookmark: ['spaceId', 'bookmarkFolderId', 'bookmarkId', 'parentId', 'tabId', 'beforeId'],
    addBookmarks: ['spaceId', 'bookmarkFolderId', 'bookmarks', 'beforeId'],
    open: ['favoriteId'], remove: ['favoriteId'], reorder: ['favoriteId', 'beforeId']
};
export function validateFavoriteRequest(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message) || message.type !== 'favoriteStore' || !Object.hasOwn(fields, message.action) || !isWindowId(message.windowId)
        || Object.keys(message).some(name => !['type', 'action', 'windowId', ...fields[message.action]].includes(name))
        || ['open', 'remove', 'reorder'].includes(message.action) && !id(message.favoriteId)
        || message.action === 'addTab' && !isWindowId(message.tabId)
        || message.tabId !== undefined && !isWindowId(message.tabId)
        || message.action === 'addBookmark' && !['spaceId', 'bookmarkFolderId', 'bookmarkId', 'parentId'].every(name => id(message[name]))
        || message.beforeId !== undefined && message.beforeId !== null && !id(message.beforeId)
        || message.action === 'reorder' && message.beforeId === undefined
        || message.action === 'addBookmarks' && (!id(message.spaceId) || !id(message.bookmarkFolderId)
            || message.beforeId === undefined || !Array.isArray(message.bookmarks)
            || message.bookmarks.length < 1 || message.bookmarks.length > MAX_FAVORITE_BOOKMARK_BATCH
            || Array.from(message.bookmarks).some(entry => !entry || typeof entry !== 'object' || Array.isArray(entry)
                || Object.keys(entry).some(name => !['bookmarkId', 'parentId', 'tabId'].includes(name))
                || !Object.hasOwn(entry, 'bookmarkId') || !Object.hasOwn(entry, 'parentId')
                || !id(entry.bookmarkId) || !id(entry.parentId) || entry.tabId !== undefined && !isWindowId(entry.tabId))
            || new Set(message.bookmarks.map(entry => entry.bookmarkId)).size !== message.bookmarks.length
            || new Set(message.bookmarks.filter(entry => entry.tabId !== undefined).map(entry => entry.tabId)).size
                !== message.bookmarks.filter(entry => entry.tabId !== undefined).length)) {
        fail('INVALID_REQUEST', 'Invalid Favorites request.');
    }
}

// There is exactly one writer, sharing SpaceStore's worker queue. Internal methods
// below are called only while that queue is held; they never call run/dispatch.
// Durable links and browser-session identities are deliberately separate. Clearing
// storage.session at browser restart never causes URL-based adoption or tab opens.
export class FavoriteStore {
    constructor(spaceStore, { captureIcon = captureFavoriteIcon, now = Date.now } = {}) {
        this.spaceStore = spaceStore;
        this.initialized = false;
        this.replacements = new Map();
        this.captureIcon = captureIcon;
        this.now = now;
        this.iconJobs = new Map();
        this.iconAttempts = new Map();
        this.activeIconJobs = 0;
        spaceStore.favoriteStore = this;
    }
    run(operation) { return this.spaceStore.run(async () => { await this.initialize(); return operation(); }); }
    async initialize() {
        if (this.initialized) return;
        const local = await chrome.storage.local.get(FAVORITES_KEY);
        const session = await chrome.storage.session.get(FAVORITE_SESSION_KEY);
        const items = local[FAVORITES_KEY] ?? [];
        if (!Array.isArray(items) || items.some(item => !item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(name => !['id', 'title', 'url', 'sourceBookmarkId'].includes(name)) || !id(item.id) || typeof item.title !== 'string' || item.title.length > 4096 || !isFavoriteUrl(item.url)
            || item.sourceBookmarkId !== null && !id(item.sourceBookmarkId)) || new Set(items.map(item => item.id)).size !== items.length
            || new Set(items.filter(item => item.sourceBookmarkId !== null).map(item => item.sourceBookmarkId)).size !== items.filter(item => item.sourceBookmarkId !== null).length) {
            fail('INVALID_STORAGE', 'The saved Favorites list could not be read. No links were changed.');
        }
        const state = session[FAVORITE_SESSION_KEY] ?? { version: 1, bindings: [], attempts: [] };
        if (state.version !== 1 || !Array.isArray(state.bindings) || !Array.isArray(state.attempts)
            || state.bindings.some(b => !id(b.favoriteId) || !isWindowId(b.windowId) || !isWindowId(b.tabId))
            || state.attempts.some(a => !id(a.favoriteId) || !isWindowId(a.windowId) || a.tabId !== null && !isWindowId(a.tabId) || !isFavoriteUrl(a.url))) {
            fail('INVALID_STORAGE', 'Favorites session tracking could not be read. No tabs were changed.');
        }
        this.items = copy(items);
        await this.loadIcons();
        this.state = copy(state);
        this.initialized = true;
    }
    async loadIcons() {
        // This separate auxiliary key never changes the original durable links'
        // four-key schema, so preceding Arcify readers still work on rollback.
        let local;
        try { local = await chrome.storage.local.get(FAVORITE_ICON_CACHE_KEY); }
        catch { local = {}; }
        const cache = local?.[FAVORITE_ICON_CACHE_KEY], saved = new Map(this.items.map(item => [item.id, item.url]));
        this.icons = new Map();
        if (!cache || cache.version !== 1 || !Array.isArray(cache.entries)
            || Object.keys(cache).some(name => !['version', 'entries'].includes(name))) return;
        let size = favoriteIconCacheSize([]);
        for (const entry of cache.entries) {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)
                || Object.keys(entry).some(name => !['favoriteId', 'url', 'faviconDataUrl'].includes(name))
                || !id(entry.favoriteId) || saved.get(entry.favoriteId) !== entry.url || !isFavoriteUrl(entry.url)
                || this.icons.has(entry.favoriteId) || !isFavoriteIcon(entry.faviconDataUrl)) continue;
            const bytes = new TextEncoder().encode(JSON.stringify(entry)).byteLength + (this.icons.size ? 1 : 0);
            if (size + bytes > MAX_FAVORITE_ICON_CACHE) continue;
            size += bytes; this.icons.set(entry.favoriteId, copy(entry));
        }
    }
    icon(item) { const cached = this.icons.get(item.id); return cached?.url === item.url ? cached.faviconDataUrl : undefined; }
    async saveIcons(icons) {
        const entries = [...icons.values()].filter(entry => this.items.some(item => item.id === entry.favoriteId && item.url === entry.url));
        if (favoriteIconCacheSize(entries) > MAX_FAVORITE_ICON_CACHE) return false;
        try { await chrome.storage.local.set({ [FAVORITE_ICON_CACHE_KEY]: { version: 1, entries: copy(entries) } }); }
        catch { return false; } // Auxiliary quota/failures never invalidate link state.
        this.icons = new Map(entries.map(entry => [entry.favoriteId, entry]));
        return true;
    }
    scheduleIcon(item, tab, { refresh = false } = {}) {
        if (!refresh && (this.icon(item) || this.iconJobs.has(item.id)
            || this.now() - (this.iconAttempts.get(item.id) ?? -Infinity) < 60000)) return;
        // Tab-supplied bytes belong to the saved page only at its exact URL, never
        // to a same-host page, pending navigation, unbound twin, or private tab.
        const samePage = tab && !tab.incognito && tab.pinned && tab.status !== 'loading' && tab.url === item.url
            && (!tab.pendingUrl || tab.pendingUrl === item.url)
            && this.state.bindings.some(binding => binding.favoriteId === item.id && binding.tabId === tab.id && binding.windowId === tab.windowId);
        const job = { id: item.id, url: item.url, previousIcon: this.icon(item),
            dataUrl: samePage ? tab.favIconUrl : undefined, started: false };
        this.iconJobs.set(item.id, job);
        this.iconAttempts.set(item.id, this.now());
        this.pumpIcons();
    }
    pumpIcons() {
        while (this.activeIconJobs < 4) {
            const job = [...this.iconJobs.values()].find(job => !job.started);
            if (!job) return;
            job.started = true; this.activeIconJobs++;
            // Do not hold SpaceStore's mutation queue while fetching cache bytes.
            job.promise = Promise.resolve().then(() => this.captureIcon(job.url, { dataUrl: job.dataUrl }))
                .then(icon => {
                    if (!isFavoriteIcon(icon)) return;
                    return this.run(async () => {
                        const current = this.items.find(item => item.id === job.id);
                        if (this.iconJobs.get(job.id) !== job || !current || current.url !== job.url
                            || this.icon(current) !== job.previousIcon || this.icon(current) === icon) return;
                        const next = new Map(this.icons);
                        next.set(current.id, { favoriteId: current.id, url: current.url, faviconDataUrl: icon });
                        await this.saveIcons(next);
                    });
                }).catch(() => { /* Icons are best effort; saved links stay usable. */ })
                .finally(() => {
                    this.activeIconJobs--;
                    if (this.iconJobs.get(job.id) === job) this.iconJobs.delete(job.id);
                    this.pumpIcons();
                });
        }
    }
    async saveItems(items) {
        try { await chrome.storage.local.set({ [FAVORITES_KEY]: copy(items) }); }
        catch (error) { this.initialized = false; throw error; }
        this.items = items;
    }
    async saveSession() {
        // Keep exact receipts in memory even if a write fails. On worker restart,
        // the prior pending receipt safely blocks a duplicate create.
        await chrome.storage.session.set({ [FAVORITE_SESSION_KEY]: copy(this.state) });
    }
    async normalWindow(windowId) {
        if (!isWindowId(windowId)) fail('INVALID_WINDOW', 'Choose a normal browser window.');
        const window = await chrome.windows.get(windowId);
        if (window.id !== windowId || window.type !== 'normal' || window.incognito) fail('INVALID_WINDOW', 'Favorites is available in normal, non-private browser windows.');
        return window;
    }
    exactId(tabId) {
        const seen = new Set();
        while (this.replacements.has(tabId) && !seen.has(tabId)) { seen.add(tabId); tabId = this.replacements.get(tabId); }
        return tabId;
    }
    async reconcile() {
        const before = JSON.stringify(this.state);
        const tabs = new Map((await chrome.tabs.query({})).map(tab => [tab.id, tab]));
        const saved = new Set(this.items.map(item => item.id));
        const windows = new Map();
        const allowed = async windowId => {
            if (!windows.has(windowId)) {
                const window = await chrome.windows.get(windowId);
                windows.set(windowId, window.type === 'normal' && !window.incognito);
            }
            return windows.get(windowId);
        };
        const existing = [], moved = [];
        for (const binding of this.state.bindings) {
            if (!saved.has(binding.favoriteId)) continue;
            const tabId = this.exactId(binding.tabId), tab = tabs.get(tabId);
            // Absence is projected as closed but retained until a close event or
            // explicit open proves it absent. This preserves queued replacements.
            if (!tab) { existing.push({ ...binding, tabId }); continue; }
            if (!tab.pinned || tab.incognito || isStartupLauncherTab(tab) || !await allowed(tab.windowId)) continue;
            (tab.windowId === binding.windowId ? existing : moved).push({ ...binding, tabId, windowId: tab.windowId });
        }
        const ordered = [...existing.filter(binding => tabs.has(binding.tabId)), ...moved, ...existing.filter(binding => !tabs.has(binding.tabId))];
        const occupied = new Set(), usedTabs = new Set();
        this.state.bindings = ordered.filter(binding => {
            if (occupied.has(key(binding)) || usedTabs.has(binding.tabId)) return false;
            occupied.add(key(binding)); usedTabs.add(binding.tabId); return true;
        });
        this.state.attempts = this.state.attempts.filter(attempt => saved.has(attempt.favoriteId)).map(attempt => ({ ...attempt,
            tabId: attempt.tabId === null ? null : this.exactId(attempt.tabId) }));
        if (before !== JSON.stringify(this.state)) await this.saveSession();
        return tabs;
    }
    async read(windowId) {
        await this.initialize();
        await this.normalWindow(windowId);
        const tabs = await this.reconcile();
        const liveBindings = this.state.bindings.filter(binding => binding.windowId === windowId
            && tabs.get(binding.tabId)?.windowId === windowId && tabs.get(binding.tabId)?.pinned);
        const used = new Set(liveBindings.map(binding => binding.tabId));
        for (const item of this.items) {
            const binding = liveBindings.find(binding => binding.favoriteId === item.id);
            this.scheduleIcon(item, binding && tabs.get(binding.tabId));
        }
        return {
            favorites: this.items.map(item => ({ ...copy(item), ...(this.icon(item) ? { faviconDataUrl: this.icon(item) } : {}),
                tabId: liveBindings.find(binding => binding.favoriteId === item.id)?.tabId ?? null })),
            nativeTabs: [...tabs.values()].filter(tab => tab.windowId === windowId && tab.pinned && !tab.incognito
                && !isStartupLauncherTab(tab) && !used.has(tab.id)).map(copy)
        };
    }
    item(favoriteId) {
        const item = this.items.find(item => item.id === favoriteId);
        if (!item) fail('STALE_FAVORITE', 'This Favorite was removed. Refresh Favorites.');
        return item;
    }
    positioned(items, favoriteId, beforeId) {
        if (beforeId === undefined || beforeId === favoriteId) return items;
        if (beforeId !== null && !items.some(item => item.id === beforeId)) fail('STALE_FAVORITE', 'The destination Favorite changed. Drag it again.');
        const moving = items.find(item => item.id === favoriteId);
        const rest = items.filter(item => item.id !== favoriteId);
        rest.splice(beforeId === null ? rest.length : rest.findIndex(item => item.id === beforeId), 0, moving);
        return rest;
    }
    async currentTab(tabId, windowId) {
        const tab = await chrome.tabs.get(this.exactId(tabId));
        if (!tab || tab.windowId !== windowId || tab.incognito || isStartupLauncherTab(tab)) fail('STALE_TAB', 'The tab or its window changed. Refresh Favorites.');
        return tab;
    }
    async bind(favoriteId, tab, windowId) {
        const current = await this.currentTab(tab.id, windowId);
        if (!current.pinned) fail('STALE_TAB', 'This tab is no longer pinned. Its saved Favorite was kept.');
        const conflict = this.state.bindings.find(binding => binding.favoriteId === favoriteId && binding.windowId === windowId && binding.tabId !== current.id);
        if (conflict) fail('FAVORITE_CONFLICT', 'This Favorite already has a live tab in this window. Both tabs were kept.');
        if (this.state.bindings.some(binding => binding.tabId === current.id && binding.favoriteId !== favoriteId)) fail('FAVORITE_CONFLICT', 'This tab already belongs to another Favorite. No tabs were merged.');
        this.state.bindings = this.state.bindings.filter(binding => binding.tabId !== current.id);
        this.state.bindings.push({ favoriteId, windowId, tabId: current.id });
        this.state.attempts = this.state.attempts.filter(attempt => key(attempt) !== key({ favoriteId, windowId }));
        await this.saveSession();
        const confirmed = await this.currentTab(current.id, windowId);
        if (!confirmed.pinned) fail('STALE_TAB', 'This tab was unpinned while saving its Favorite. Its page was kept.');
        this.spaceStore.track(confirmed);
        await this.spaceStore.persist();
        const latest = await this.currentTab(confirmed.id, windowId);
        if (!latest.pinned) fail('STALE_TAB', 'This tab was unpinned while saving its Favorite. Its page was kept.');
        this.scheduleIcon(this.item(favoriteId), latest);
        return latest;
    }
    async open(favoriteId, windowId, { activate = true, tabId, beforeMutation = async () => {} } = {}) {
        await this.initialize();
        await this.normalWindow(windowId);
        const item = this.item(favoriteId), tabs = await this.reconcile();
        const targetKey = key({ favoriteId, windowId });
        let binding = this.state.bindings.find(binding => key(binding) === targetKey);
        let tab = binding && tabs.get(binding.tabId);
        if (binding && !tab) {
            // A fresh all-window absence, never a failed get or URL match.
            this.state.bindings = this.state.bindings.filter(entry => entry !== binding);
            await this.saveSession();
            binding = null;
        }
        if (tabId && tab && tab.id !== this.exactId(tabId)) fail('FAVORITE_CONFLICT', 'This Favorite already has a live tab in this window. The dragged tab was kept unchanged.');
        if (!tab) {
            const attempt = this.state.attempts.find(attempt => key(attempt) === targetKey);
            if (attempt) {
                if (attempt.tabId === null) fail('UNCERTAIN_RESULT', 'An earlier Favorite open could not be verified. Check your tabs; another tab will not be opened automatically.');
                tab = tabs.get(attempt.tabId);
                if (tab && (tab.windowId !== windowId || !tab.pinned && !(attempt.kind === 'adopt' && tabId === tab.id))) fail('STALE_TAB', 'The previously opened Favorite moved or was unpinned. Its page was kept unchanged.');
                if (!tab) { this.state.attempts = this.state.attempts.filter(entry => entry !== attempt); await this.saveSession(); }
            }
        }
        if (!tab && tabId) tab = await this.currentTab(tabId, windowId);
        if (tab && this.state.bindings.some(binding => binding.tabId === tab.id && binding.favoriteId !== favoriteId)) {
            fail('FAVORITE_CONFLICT', 'This tab already belongs to another Favorite. No tabs were changed.');
        }
        if (tab) {
            tab = await this.currentTab(tab.id, windowId);
            if (!tab.pinned) {
                await beforeMutation();
                tab = await this.currentTab(tab.id, windowId);
                tab = await chrome.tabs.update(tab.id, { pinned: true });
            }
        } else {
            this.state.attempts.push({ favoriteId, windowId, tabId: null, url: item.url });
            try { await this.saveSession(); } // Must succeed before the irreversible create.
            catch (error) {
                this.state.attempts = this.state.attempts.filter(attempt => key(attempt) !== targetKey);
                await this.saveSession().catch(() => {});
                throw error;
            }
            try { await this.normalWindow(windowId); await beforeMutation(); }
            catch (error) {
                this.state.attempts = this.state.attempts.filter(attempt => key(attempt) !== targetKey);
                await this.saveSession();
                throw error;
            }
            try { tab = await chrome.tabs.create({ windowId, url: item.url, pinned: true, active: false }); }
            catch (error) { fail('UNCERTAIN_RESULT', `Chrome could not confirm the Favorite tab. Check your tabs; another will not open automatically. ${error.message}`); }
            if (!isWindowId(tab?.id)) fail('UNCERTAIN_RESULT', 'Chrome did not return the new Favorite identity. Check your tabs before retrying.');
            const attempt = this.state.attempts.find(attempt => key(attempt) === targetKey);
            attempt.tabId = tab.id;
            await this.saveSession();
        }
        tab = await this.bind(favoriteId, tab, windowId);
        if (activate) {
            tab = await this.currentTab(tab.id, windowId);
            if (!tab.pinned) fail('STALE_TAB', 'This tab is no longer pinned.');
            tab = await chrome.tabs.update(tab.id, { active: true });
            if (tab.windowId !== windowId) fail('STALE_TAB', 'The Favorite moved to another window.');
            await chrome.windows.update(windowId, { focused: true });
        }
        return tab;
    }
    async validateBookmark(message, { allowUnsupportedUrl = false } = {}) {
        const space = this.spaceStore.spaces.find(space => space.id === message.spaceId);
        if (!space || space.bookmarkFolderId !== message.bookmarkFolderId || this.spaceStore.active[message.windowId]
            && this.spaceStore.active[message.windowId] !== space.id) fail('STALE_BOOKMARK', 'The bookmark or its Space changed. Drag it again.');
        const bookmark = await getSpaceBookmarkById(space, message.bookmarkId);
        if (!bookmark || String(bookmark.parentId) !== message.parentId || !allowUnsupportedUrl && !isFavoriteUrl(bookmark.url)) fail('STALE_BOOKMARK', 'The saved bookmark changed or cannot be opened.');
        if (message.tabId) {
            const tab = await this.currentTab(message.tabId, message.windowId);
            if (message.requireNativePin && !tab.pinned) fail('STALE_TAB', 'The earlier native Favorite was unpinned. Its page was kept unchanged.');
            const state = await Utils.getPinnedTabState(tab.id);
            if (String(state?.bookmarkId) !== message.bookmarkId || !tab.pinned && ![...space.spaceBookmarks, ...space.temporaryTabs].includes(tab.id)) {
                fail('STALE_BOOKMARK', 'The dragged tab no longer belongs to this bookmark.');
            }
        }
        return bookmark;
    }
    async prepareBookmark(message, { allowUnsupportedUrl = false } = {}) {
        const source = await this.validateBookmark(message, { allowUnsupportedUrl });
        const item = this.items.find(item => item.sourceBookmarkId === message.bookmarkId);
        let sourceMessage = message;
        const legacyBindings = await Utils.getPinnedTabStates();
        if (!item) {
            // An extension upgrade can retain the old native-only writer's
            // uncertain create receipt. Never turn that unknown outcome
            // into permission to create a second page under the new model.
            const { favoriteDropAttempts = {} } = await chrome.storage.session.get('favoriteDropAttempts');
            const receipt = favoriteDropAttempts[JSON.stringify([message.windowId, message.bookmarkId])];
            if (receipt) {
                if (!isWindowId(receipt.tabId)) fail('UNCERTAIN_RESULT', 'An earlier Favorite open from before this update could not be verified. Check your native pins; no additional tab was opened.');
                const previous = (await chrome.tabs.query({})).find(tab => tab.id === receipt.tabId);
                if (previous && (previous.windowId !== message.windowId || !previous.pinned || previous.incognito
                    || String(legacyBindings[previous.id]?.bookmarkId) !== message.bookmarkId || receipt.url !== source.url)) {
                    fail('UNCERTAIN_RESULT', 'An earlier Favorite tab cannot be safely adopted. Use or explicitly adopt its native pin; no additional tab was opened.');
                }
                if (previous) {
                    if (message.tabId && message.tabId !== previous.id) fail('FAVORITE_CONFLICT', 'The dragged tab differs from the earlier Favorite receipt. No tab was changed.');
                    // Carry identity across every later lookup. A move or
                    // closure cannot turn a verified receipt into a create.
                    sourceMessage = { ...message, tabId: previous.id, requireNativePin: true };
                }
                // A fresh all-window absence proves a known receipt closed.
                // Retain the old receipt untouched; unknown receipts are
                // never discarded, and no URL is used to recover identity.
            }
        }
        const legacyMatches = (await chrome.tabs.query({ windowId: message.windowId })).filter(tab => !tab.incognito
            && !isStartupLauncherTab(tab) && String(legacyBindings[tab.id]?.bookmarkId) === message.bookmarkId);
        const legacyNative = legacyMatches.filter(tab => tab.pinned);
        const sourceSpace = this.spaceStore.spaces.find(space => space.id === message.spaceId);
        if (!message.tabId && !legacyNative.length && legacyMatches.some(tab => ![...sourceSpace.spaceBookmarks, ...sourceSpace.temporaryTabs].includes(tab.id))) {
            fail('STALE_BOOKMARK', 'This bookmark is linked to a live tab in another Space. Refresh the source before dragging it.');
        }
        if (legacyNative.length > 1 || sourceMessage.tabId && legacyNative.some(tab => tab.id !== sourceMessage.tabId)) {
            fail('FAVORITE_CONFLICT', 'This bookmark already has another native Favorite in this window. Use its existing icon; no tab was changed.');
        }
        if (!sourceMessage.tabId && legacyNative.length === 1) sourceMessage = { ...message, tabId: legacyNative[0].id, requireNativePin: true };
        const current = await this.validateBookmark(sourceMessage, { allowUnsupportedUrl });
        if (current.url !== source.url) fail('STALE_BOOKMARK', 'The saved bookmark URL changed while preparing this Favorite. Select it again.');
        return { item, source, sourceMessage };
    }
    async addFavorite(message, { prepared, onItem = () => {}, validate = async () => {} } = {}) {
        let item, source, sourceMessage = message;
        if (message.action === 'addBookmark') {
            ({ item, source, sourceMessage } = prepared || await this.prepareBookmark(message));
        } else {
            source = await this.currentTab(message.tabId, message.windowId);
            const sourceFavoriteId = this.state.bindings.find(binding => binding.tabId === source.id)?.favoriteId
                || this.state.attempts.find(attempt => attempt.kind === 'adopt' && attempt.tabId === source.id)?.favoriteId;
            item = this.items.find(item => item.id === sourceFavoriteId);
        }
        await validate();
        if (!item) {
            const url = source.url || source.pendingUrl;
            if (!isFavoriteUrl(url)) fail('UNSUPPORTED_URL', 'Only HTTP and HTTPS links up to 16,384 characters can be saved as Favorites.');
            item = { id: crypto.randomUUID(), title: (source.title || url).slice(0, 4096), url,
                sourceBookmarkId: message.action === 'addBookmark' ? message.bookmarkId : null };
            onItem(item);
            const next = this.positioned([...this.items, item], item.id, message.beforeId);
            if (sourceMessage.tabId) {
                this.state.attempts.push({ favoriteId: item.id, windowId: message.windowId, tabId: sourceMessage.tabId, url: item.url, kind: 'adopt' });
                await this.saveSession();
                await validate();
            }
            await this.saveItems(next);
        } else {
            onItem(item);
            if (message.beforeId !== undefined) await this.saveItems(this.positioned(this.items, item.id, message.beforeId));
        }
        if (message.action === 'addBookmark') await this.validateBookmark(sourceMessage);
        await validate();
        const tab = await this.open(item.id, message.windowId, { activate: false, tabId: sourceMessage.tabId || prepared?.favoriteTabId,
            beforeMutation: message.action === 'addBookmark' ? async () => {
                const current = await this.validateBookmark(sourceMessage);
                if (current.url !== source.url) fail('STALE_BOOKMARK', 'The saved URL changed while adding this Favorite. No additional tab was opened.');
                await validate();
            } : async () => {} });
        if (message.action === 'addBookmark') await this.validateBookmark(sourceMessage);
        await validate();
        return tab;
    }
    batchSpace(message) {
        // A batch belongs to one currently displayed Space in one normal window.
        // Missing active-window state is not permission to use a stale selection.
        if (this.spaceStore.active[message.windowId] !== message.spaceId) {
            fail('STALE_BOOKMARK', 'The selected bookmarks or their active Space changed. Select them again.');
        }
    }
    async prepareBatchBookmark(message, previous) {
        await this.normalWindow(message.windowId);
        this.batchSpace(message);
        // Preserve a discovered native receipt's exact tab identity at every
        // later lookup. Its disappearance must never turn into a new create.
        const prepared = await this.prepareBookmark(previous?.sourceMessage || message, { allowUnsupportedUrl: true });
        prepared.skipped = !isFavoriteUrl(prepared.source.url);
        if (previous && (prepared.source.url !== previous.source.url
            || this.exactId(prepared.sourceMessage.tabId) !== this.exactId(previous.sourceMessage.tabId))) {
            fail('STALE_BOOKMARK', 'A selected bookmark or its live tab changed. Select it again.');
        }
        const { item, sourceMessage } = prepared;
        if (sourceMessage.tabId) {
            const tab = await this.currentTab(sourceMessage.tabId, message.windowId);
            const reserved = [...(tab.pinned ? this.state.bindings : []), ...this.state.attempts];
            if (reserved.some(binding => this.exactId(binding.tabId) === tab.id && binding.favoriteId !== item?.id
                && this.items.some(saved => saved.id === binding.favoriteId))) {
                fail('FAVORITE_CONFLICT', 'A selected tab already belongs to another Favorite. No tabs were merged.');
            }
        }
        if (item) {
            const tabs = await chrome.tabs.query({});
            const targetKey = key({ favoriteId: item.id, windowId: message.windowId });
            const binding = this.state.bindings.find(entry => key(entry) === targetKey);
            const bound = binding && tabs.find(tab => tab.id === this.exactId(binding.tabId));
            if (bound && (bound.windowId !== message.windowId || !bound.pinned || bound.incognito || isStartupLauncherTab(bound))) {
                fail('STALE_TAB', 'The selected Favorite moved or was unpinned. Refresh before dragging it again.');
            }
            if (bound && sourceMessage.tabId && bound.id !== this.exactId(sourceMessage.tabId)) {
                fail('FAVORITE_CONFLICT', 'This Favorite already has a live tab in this window. The selected tab was kept unchanged.');
            }
            const attempt = !bound && this.state.attempts.find(entry => key(entry) === targetKey);
            let previousTab;
            if (attempt) {
                if (attempt.tabId === null) fail('UNCERTAIN_RESULT', 'An earlier Favorite open could not be verified. Check your tabs; another tab will not be opened automatically.');
                const tab = tabs.find(tab => tab.id === this.exactId(attempt.tabId));
                if (tab && (tab.windowId !== message.windowId || tab.incognito || isStartupLauncherTab(tab)
                    || !tab.pinned && !(attempt.kind === 'adopt' && this.exactId(sourceMessage.tabId) === tab.id))) {
                    fail('STALE_TAB', 'The previously opened Favorite moved or was unpinned. Its page was kept unchanged.');
                }
                previousTab = tab;
            }
            const known = bound || previousTab;
            if (previous?.favoriteTabId && known?.id !== this.exactId(previous.favoriteTabId)) {
                fail('STALE_TAB', 'A selected Favorite closed or changed while adding this batch. No replacement tab was opened.');
            }
            // Owned Favorite identities do not depend on legacy bookmark state.
            // Freeze them separately; a later fresh absence cannot authorize a
            // replacement page in the middle of this already-preflighted drop.
            prepared.favoriteTabId = known?.id;
            prepared.requireFavoritePin = Boolean(known?.pinned);
        }
        this.batchSpace(message);
        return prepared;
    }
    async validateBatchBookmark(message, prepared) {
        const current = await this.validateBookmark(prepared.sourceMessage);
        if (current.url !== prepared.source.url) fail('STALE_BOOKMARK', 'A selected bookmark URL changed. Select it again.');
        if (prepared.favoriteTabId) {
            const tab = await this.currentTab(prepared.favoriteTabId, message.windowId);
            if (prepared.requireFavoritePin && !tab.pinned) fail('STALE_TAB', 'A selected Favorite was unpinned. Its page was kept unchanged.');
        }
        await this.normalWindow(message.windowId);
        this.batchSpace(message);
    }
    async addBookmarks(message) {
        // This is one bounded, explicit drop, not an import or a replay job.
        // All source validation is read-only until every selected entry passes.
        const batch = { complete: false, entries: message.bookmarks.map(entry => ({ bookmarkId: entry.bookmarkId, status: 'unattempted' })) };
        const prepared = [], requests = message.bookmarks.map(entry => ({ type: 'favoriteStore', action: 'addBookmark',
            windowId: message.windowId, spaceId: message.spaceId, bookmarkFolderId: message.bookmarkFolderId, ...entry }));
        let index = -1;
        try {
            await this.normalWindow(message.windowId);
            this.batchSpace(message);
            if (message.beforeId !== null) this.item(message.beforeId);
            for (index = 0; index < requests.length; index++) {
                prepared[index] = await this.prepareBatchBookmark(requests[index]);
            }
            // A later async lookup may have invalidated an earlier row. Check
            // the whole selection again before writing any record or receipt.
            for (index = 0; index < requests.length; index++) {
                prepared[index] = await this.prepareBatchBookmark(requests[index], prepared[index]);
            }
            // Only supported selections move. A skipped bookmark may already
            // have a saved HTTP(S) Favorite, whose position remains untouched.
            const selected = new Set(requests.filter((_, i) => !prepared[i].skipped).map(entry => entry.bookmarkId));
            const anchorIndex = this.items.findIndex(item => item.id === message.beforeId);
            const beforeId = message.beforeId === null ? null
                : this.items.slice(anchorIndex).find(item => !selected.has(item.sourceBookmarkId))?.id ?? null;
            for (const request of requests) request.beforeId = beforeId;
            for (index = 0; index < requests.length; index++) {
                prepared[index] = await this.prepareBatchBookmark(requests[index], prepared[index]);
                const entry = batch.entries[index];
                if (prepared[index].skipped) {
                    Object.assign(entry, { status: 'skipped', title: (prepared[index].source.title || 'Untitled bookmark').slice(0, 4096),
                        code: 'UNSUPPORTED_URL', reason: 'Only HTTP and HTTPS links up to 16,384 characters can be saved as Favorites.' });
                    continue;
                }
                const tab = await this.addFavorite(requests[index], { prepared: prepared[index],
                    onItem: item => { entry.favoriteId = item.id; },
                    validate: () => this.validateBatchBookmark(requests[index], prepared[index]) });
                Object.assign(entry, { status: 'completed', saved: true, tabId: tab.id });
            }
            index = -1;
            batch.complete = true;
            // The caller refreshes its view separately. An all-skipped action
            // performs no reconciliation, icon work, or storage/tab mutations.
            if (batch.entries.every(entry => entry.status === 'skipped')) return { batch };
            return { ...await this.read(message.windowId), batch };
        } catch (error) {
            if (index >= 0 && index < batch.entries.length) {
                const entry = batch.entries[index], item = this.items.find(item => item.sourceBookmarkId === entry.bookmarkId);
                if (item) {
                    entry.favoriteId = item.id;
                    // Absence after a failed storage response is inconclusive.
                    // `saved` is only asserted after a verified durable commit.
                    if (this.initialized) entry.saved = true;
                }
                const receipt = entry.favoriteId && [...this.state.bindings, ...this.state.attempts]
                    .find(value => value.favoriteId === entry.favoriteId && value.windowId === message.windowId);
                if (receipt?.tabId) entry.tabId = this.exactId(receipt.tabId);
                Object.assign(entry, { status: 'failed', code: error.code || 'FAILED', error: error.message || 'This Favorite could not be added.' });
            }
            // No rollback closes a page, undoes a completed entry, or discards
            // an uncertain create receipt. Only a new explicit drop may retry.
            error.batch = batch;
            throw error;
        }
    }
    async applyAction(message) {
        validateFavoriteRequest(message);
        await this.initialize();
        if (message.action === 'addBookmarks') return this.addBookmarks(message);
        await this.normalWindow(message.windowId);
        await this.reconcile();
        let tab, warning;
        if (message.action === 'addBookmark' || message.action === 'addTab') {
            tab = await this.addFavorite(message);
        } else if (message.action === 'open') tab = await this.open(message.favoriteId, message.windowId);
        else if (message.action === 'reorder') {
            this.item(message.favoriteId);
            await this.saveItems(this.positioned(this.items, message.favoriteId, message.beforeId));
        } else if (message.action === 'remove') {
            this.item(message.favoriteId);
            const bindings = this.state.bindings.filter(binding => binding.favoriteId === message.favoriteId);
            await this.saveItems(this.items.filter(item => item.id !== message.favoriteId));
            this.iconJobs.delete(message.favoriteId);
            this.iconAttempts.delete(message.favoriteId);
            this.icons.delete(message.favoriteId);
            await this.saveIcons(this.icons); // Orphan cleanup is best effort only.
            this.state.bindings = this.state.bindings.filter(binding => binding.favoriteId !== message.favoriteId);
            this.state.attempts = this.state.attempts.filter(attempt => attempt.favoriteId !== message.favoriteId);
            await this.saveSession();
            for (const binding of bindings) {
                try {
                    await this.normalWindow(binding.windowId);
                    const current = await this.currentTab(binding.tabId, binding.windowId);
                    if (current.pinned) {
                        const ordinary = await chrome.tabs.update(current.id, { pinned: false });
                        this.spaceStore.track(ordinary);
                    }
                } catch { warning = 'Favorite removed. Some open tabs could not be unpinned; their pages were left open.'; }
            }
            await this.spaceStore.persist();
        }
        return { ...await this.read(message.windowId), ...(tab ? { tab } : {}), ...(warning ? { warning } : {}) };
    }
    async dispatch(message) { validateFavoriteRequest(message); return this.run(() => this.applyAction(message)); }
    install() {
        const handle = operation => this.run(operation).catch(error => console.warn('Favorites tracking deferred:', error));
        chrome.tabs.onRemoved.addListener(tabId => handle(async () => {
            if (!this.state.bindings.some(binding => binding.tabId === tabId) && !this.state.attempts.some(attempt => attempt.tabId === tabId)) return;
            this.state.bindings = this.state.bindings.filter(binding => binding.tabId !== tabId);
            this.state.attempts = this.state.attempts.filter(attempt => attempt.tabId !== tabId);
            await this.saveSession();
        }));
        chrome.tabs.onReplaced.addListener((added, removed) => {
            this.replacements.set(removed, added);
            handle(() => this.reconcile());
        });
        chrome.tabs.onUpdated.addListener((tabId, change) => {
            if (change.pinned === undefined && change.favIconUrl === undefined && change.status !== 'complete') return;
            handle(async () => {
                const tabs = await this.reconcile();
                const binding = this.state.bindings.find(binding => binding.tabId === this.exactId(tabId));
                const item = binding && this.items.find(item => item.id === binding.favoriteId), tab = binding && tabs.get(binding.tabId);
                // A page finishing without an icon (or explicitly clearing one)
                // is not evidence that a retained site icon should be replaced.
                if (item && this.icon(item) && (!tab?.favIconUrl || change.favIconUrl === '')) return;
                if (item && tab && tab.url === item.url && (!tab.pendingUrl || tab.pendingUrl === item.url)
                    && (change.favIconUrl !== undefined || change.status === 'complete')) this.scheduleIcon(item, tab, { refresh: true });
            });
        });
        chrome.tabs.onAttached?.addListener(() => handle(() => this.reconcile()));
        // No automatic migration, restoration, or tab opening at startup.
    }
}

export function registerFavoriteMessages(store) {
    chrome.runtime.onMessage.addListener((message, sender, respond) => {
        if (message?.type !== 'favoriteStore') return;
        const ownUrl = chrome.runtime.getURL('');
        if (sender?.id !== chrome.runtime.id || sender.url && !sender.url.startsWith(ownUrl)
            || sender.origin && sender.origin !== ownUrl.replace(/\/$/, '')
            || sender.tab && sender.tab.windowId !== message.windowId) {
            respond({ success: false, code: 'UNAUTHORIZED', error: 'Invalid Favorites sender.' });
            return;
        }
        store.dispatch(message).then(result => respond({ success: true, ...result }), error => respond({ success: false,
            code: error.code || 'FAILED', error: error.message || 'Favorites could not be updated.', ...(error.batch ? { batch: error.batch } : {}) }));
        return true;
    });
}
