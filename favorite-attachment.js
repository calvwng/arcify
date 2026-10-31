import { isFavoriteUrl } from './spotlight-bridge-protocol.js';
import { isTransientTab, isTransientWindow } from './transient-safety.js';
import { isStartupLauncherTab } from './startup-launcher-tab.js';
import { hasNativeSplit } from './native-split-safety.js';
import { Utils } from './utils.js';

const copy = value => structuredClone(value);
export const ATTACHMENT_PENDING_KEY = 'favoriteAttachmentPending';
const stale = () => { throw Object.assign(new Error('The tab or Favorite changed. Choose the tab again.'), { code: 'STALE_ATTACHMENT' }); };
const shape = tab => JSON.stringify([tab.id, tab.windowId, tab.url, tab.pendingUrl || null,
    !!tab.pinned, tab.groupId, tab.splitViewId, tab.status, tab.title]);
const placement = (store, id) => JSON.stringify({
    spaces: store.spaces.filter(s => s.temporaryTabs.includes(id) || s.spaceBookmarks.includes(id)),
    explicit: store.explicitToday?.get(id)
});

// Short-lived offers are consent snapshots, never durable identity evidence.
// Losing the worker or observing navigation invalidates them, even at the same URL.
export class FavoriteAttachment {
    constructor(store) { this.store = store; this.offers = new Map(); this.revision = 0; }
    invalidate(tabId) {
        this.revision++;
        for (const [token, offer] of this.offers) if (tabId === undefined || offer.tabId === tabId) this.offers.delete(token);
    }
    async recoverInterrupted() {
        const { [ATTACHMENT_PENDING_KEY]: pending } = await chrome.storage.local.get(ATTACHMENT_PENDING_KEY);
        if (pending === null || pending === undefined) return;
        if (pending.version !== 1 || typeof pending.favoriteId !== 'string'
            || !Number.isSafeInteger(pending.windowId) || !Number.isSafeInteger(pending.tabId)) {
            throw new Error('An interrupted Favorite attachment could not be read. No tabs were changed.');
        }
        const store = this.store;
        // A durable marker fences both own-session and witnessed-journal loads.
        // Clear the marker only after the rejected ownership is safely persisted.
        for (const field of ['bindings', 'attempts']) store.state[field] = store.state[field].filter(entry =>
            !(entry.favoriteId === pending.favoriteId && entry.windowId === pending.windowId && entry.tabId === pending.tabId));
        await store.saveSession();
        await chrome.storage.local.set({ [ATTACHMENT_PENDING_KEY]: null });
    }
    eligible(tab, windowId) {
        const store = this.store, spaces = store.spaceStore;
        return tab && tab.windowId === windowId && !tab.incognito && isFavoriteUrl(tab.url)
            && !tab.pendingUrl && tab.status !== 'loading' && !hasNativeSplit(tab)
            && !isStartupLauncherTab(tab) && !isTransientTab(spaces, tab) && !isTransientWindow(spaces, windowId)
            && !store.ownsTab(tab) && !spaces.spaces.some(s => s.spaceBookmarks.includes(tab.id))
            && ![...store.state.bindings, ...store.state.attempts].some(e => e.tabId === tab.id);
    }
    vacant(favoriteId, windowId) {
        return ![...this.store.state.bindings, ...this.store.state.attempts]
            .some(e => e.favoriteId === favoriteId && e.windowId === windowId);
    }
    async candidates(favoriteId, windowId) {
        const store = this.store, item = store.item(favoriteId);
        if (!this.vacant(favoriteId, windowId)) stale();
        // Bound memory and expiry across multiple sidebars. Refreshing one offer
        // does not grant a new lifetime to an older offer.
        for (const [token, offer] of this.offers) if (offer.expires <= store.now()) this.offers.delete(token);
        const revision = this.revision, tabs = await store.queryAttachmentTabs(windowId), candidates = [];
        const suggested = tab => isFavoriteUrl(tab.url) && new URL(tab.url).origin === new URL(item.url).origin;
        tabs.sort((a, b) => Number(suggested(b)) - Number(suggested(a)) || a.index - b.index);
        for (const tab of tabs) {
            if (!this.eligible(tab, windowId) || (await Utils.getPinnedTabState(tab.id))?.bookmarkId) continue;
            if (revision !== this.revision) stale();
            const token = crypto.randomUUID();
            const offer = { favoriteId, tabId: tab.id, windowId, item: JSON.stringify(item), tab: shape(tab),
                placement: placement(store.spaceStore, tab.id), state: JSON.stringify(store.state), expires: store.now() + 120000 };
            this.offers.set(token, offer);
            while (this.offers.size > 400) this.offers.delete(this.offers.keys().next().value);
            candidates.push({ tabId: tab.id, position: tab.index + 1, title: tab.title || tab.url, url: tab.url, pinned: !!tab.pinned,
                suggested: suggested(tab), token });
            if (candidates.length === 200) break;
        }
        return { favorite: copy(item), candidates, truncated: candidates.length === 200 };
    }
    async attach({ favoriteId, tabId, windowId, token }) {
        const store = this.store, offer = this.offers.get(token);
        if (!offer || offer.favoriteId !== favoriteId || offer.tabId !== tabId || offer.windowId !== windowId) stale();
        const validate = async (committing = false) => {
            await store.normalWindow(windowId);
            // Never follow an observed replacement to a different document/tab.
            const tab = await chrome.tabs.get(tabId);
            const bookmark = await Utils.getPinnedTabState(tabId);
            if (this.offers.get(token) !== offer || offer.expires <= store.now()
                || JSON.stringify(store.item(favoriteId)) !== offer.item || shape(tab) !== offer.tab
                || placement(store.spaceStore, tabId) !== offer.placement || bookmark?.bookmarkId
                || (!committing && (!this.eligible(tab, windowId) || !this.vacant(favoriteId, windowId)
                    || JSON.stringify(store.state) !== offer.state))) stale();
            if (committing && (hasNativeSplit(tab) || isTransientTab(store.spaceStore, tab)
                || isTransientWindow(store.spaceStore, windowId))) stale();
            return tab;
        };
        const tab = await validate(), previous = copy(store.state);
        // Journal a refusal fence before writing ordinary ownership. Startup
        // discards this exact binding if the worker never finalizes confirmation.
        try { await chrome.storage.local.set({ [ATTACHMENT_PENDING_KEY]: { version: 1, favoriteId, tabId, windowId } }); }
        catch (error) {
            // A rejected acknowledgement may still have written the fence.
            store.initialized = false;
            this.invalidate();
            throw error;
        }
        // Preserve the selected page's actual pin state, independent of the
        // preference for future opens. No navigation, focus, create or close.
        store.state.bindings.push({ favoriteId, tabId, windowId, ...(!tab.pinned ? { mode: 'ordinary' } : {}) });
        try {
            await validate(true);
            await store.saveSession();
            await validate(true);
            // Final validation is the consent linearization point. Clearing the
            // fence makes that decision recoverable; later navigation is normal.
            await chrome.storage.local.set({ [ATTACHMENT_PENDING_KEY]: null });
        } catch (error) {
            store.state = previous;
            try {
                await store.saveSession();
                await chrome.storage.local.set({ [ATTACHMENT_PENDING_KEY]: null });
            }
            catch {
                store.initialized = false;
                error.message += ' Ownership rollback could not be persisted; refresh before retrying.';
            }
            this.invalidate();
            throw error;
        }
        // Subsequent navigation belongs to this explicitly attached Favorite.
        this.invalidate();
        store.spaceStore.track(tab);
        try { await store.spaceStore.persist(); }
        catch { return { warning: 'Tab attached. Space display could not refresh; refresh the sidebar.' }; }
        return {};
    }
}
