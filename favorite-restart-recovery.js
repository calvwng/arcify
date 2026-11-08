import { isFavoriteUrl, isWindowId } from './spotlight-bridge-protocol.js';
import { hasNativeSplit } from './native-split-safety.js';
import { isTransientTab, isTransientWindow } from './transient-safety.js';
import { isStartupLauncherTab } from './startup-launcher-tab.js';
import { Utils } from './utils.js';

export const RESTART_HINTS_KEY = 'favoriteRestartHints';
export const RESTART_SESSION_KEY = 'favoriteRestartRecovery';
const copy = value => structuredClone(value);
const MAX_HINTS = 64, MAX_HINT_BYTES = 16384;
const bytes = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const identity = item => JSON.stringify([item.id, item.url, item.sourceBookmarkId]);
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 4096;
const stale = () => { throw Object.assign(new Error('The recovered page changed. Refresh Favorites before reviewing it.'), { code: 'STALE_RECOVERY' }); };
const blocked = () => { throw Object.assign(new Error('Confirm this recovered tab or Undo recovery before changing or closing it.'), { code: 'RECOVERY_REVIEW_REQUIRED' }); };
const signature = async tabs => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(
    tabs.filter(tab => isFavoriteUrl(tab.url) && !tab.incognito).map(tab => [tab.url, !!tab.pinned])
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))))))).map(byte => byte.toString(16).padStart(2, '0')).join('');
const stable = tab => tab && isFavoriteUrl(tab.url) && text(tab.title) && !tab.incognito && !tab.pendingUrl
    && tab.status !== 'loading' && !hasNativeSplit(tab) && !(tab.groupId >= 0) && !isStartupLauncherTab(tab);
const shape = tab => JSON.stringify([tab.id, tab.windowId, tab.url, tab.title, !!tab.pinned, tab.pendingUrl, tab.status, tab.groupId, tab.splitViewId]);
const validHint = hint => hint && text(hint.favoriteId) && text(hint.identity) && isFavoriteUrl(hint.url)
    && text(hint.title) && (!hint.placement || typeof hint.placement.spaceId === 'string'
        && typeof hint.placement.bookmarkFolderId === 'string' && Array.isArray(hint.placement.before) && hint.placement.before.length <= 3 && Array.isArray(hint.placement.after) && hint.placement.after.length <= 3
        && [...hint.placement.before, ...hint.placement.after].every(page => page && isFavoriteUrl(page.url) && typeof page.title === 'string')) && typeof hint.pinned === 'boolean' && typeof hint.window === 'string' && /^[a-f0-9]{64}$/.test(hint.window);

// Inference is deliberately NOT a favoriteSession binding or continuity proof.
// Old/V3 readers keep their exact schemas. Every inferred tab stays guarded until
// an explicit confirmation promotes it through the existing attachment transaction.
export class FavoriteRestartRecovery {
    constructor(store) { this.store = store; this.entries = []; this.hints = []; this.ready = false; this.active = false; this.revision = 0; this.dirty = false; this.wait = ms => new Promise(resolve => setTimeout(resolve, ms)); this.checkpointStamp = null; }
    invalidate(tabId) {
        this.revision++;
        for (const entry of this.entries) if (entry.tabId === tabId) { entry.token = crypto.randomUUID(); this.dirty = true; }
    }
    entry(tabOrId) {
        const id = typeof tabOrId === 'object' ? tabOrId.id : tabOrId;
        return this.entries.find(entry => entry.phase !== 'undoing' && entry.tabId === id && (typeof tabOrId !== 'object'
            || entry.windowId === tabOrId.windowId && !tabOrId.incognito));
    }
    forFavorite(favoriteId, windowId) { return this.entries.find(entry => entry.phase !== 'undoing' && entry.favoriteId === favoriteId && entry.windowId === windowId); }
    assertConfirmed(tabId, favoriteId) {
        if (this.entry(tabId) || favoriteId && this.entries.some(entry => entry.phase !== 'undoing' && entry.favoriteId === favoriteId)) blocked();
    }
    async eligible(tab) {
        if (!stable(tab) || isTransientTab(this.store.spaceStore, tab) || isTransientWindow(this.store.spaceStore, tab.windowId)) return false;
        const window = await chrome.windows.get(tab.windowId);
        return window.type === 'normal' && !window.incognito && !(await Utils.getPinnedTabState(tab.id))?.bookmarkId;
    }
    async initialize() {
        this.ready = false; this.active = false; this.checkpointStamp = null;
        const local = await chrome.storage.local.get(RESTART_HINTS_KEY);
        const saved = (await chrome.storage.session.get(RESTART_SESSION_KEY))[RESTART_SESSION_KEY];
        const journal = local[RESTART_HINTS_KEY];
        this.hints = journal?.version === 1 && journal.phase === 'committed' && Array.isArray(journal.entries)
            && journal.entries.length <= MAX_HINTS && journal.entries.every(hint => validHint(hint) && bytes(hint) <= MAX_HINT_BYTES)
            && Number.isFinite(journal.capturedAt) && journal.capturedAt <= this.store.now()
            && this.store.now() - journal.capturedAt < 30 * 86400000 ? copy(journal.entries) : [];
        this.hints = this.hints.filter(hint => this.store.items.some(item => identity(item) === hint.identity));
        const known = [...this.store.state.bindings, ...this.store.state.attempts];
        if (saved == null && (!this.hints.length || this.hints.every(hint => known.some(entry => entry.favoriteId === hint.favoriteId)))) { this.entries = []; this.ready = true; return; }
        let tabs = await this.store.queryAttachmentTabs(undefined);
        if (saved == null && this.hints.length) {
            // Let native restoration settle before the single inference pass. A
            // partial/slow restore still fails closed and remains attachable.
            for (let pass = 0; pass < 8; pass++) {
                await this.wait(250);
                const next = await this.store.queryAttachmentTabs(undefined);
                const unchanged = JSON.stringify(tabs.map(shape).sort()) === JSON.stringify(next.map(shape).sort());
                tabs = next;
                if (unchanged) {
                    // One fast Favorite must not end the settling window for a
                    // slower hinted page. Final eligibility still fails closed.
                    let ready = true;
                    for (const hint of this.hints) {
                        const target = tabs.find(tab => tab.url === hint.url && tab.title === hint.title && stable(tab));
                        if (!target || await signature(tabs.filter(tab => tab.windowId === target.windowId)) !== hint.window) { ready = false; break; }
                    }
                    if (ready) break;
                }
            }
        }
        const revision = this.revision;
        const available = (favoriteId, tabId, windowId) => this.store.items.some(item => item.id === favoriteId)
            && !known.some(entry => entry.tabId === tabId || entry.favoriteId === favoriteId && entry.windowId === windowId);
        let entries = [];
        if (saved !== undefined && saved !== null) {
            // A malformed/present marker never permits a second inference pass.
            if (saved.version !== 1 || !Array.isArray(saved.entries) || saved.entries.length > MAX_HINTS
                || !saved.entries.every(entry => entry && validHint(entry.hint) && text(entry.token)
                    && isWindowId(entry.tabId) && isWindowId(entry.windowId) && entry.favoriteId === entry.hint.favoriteId && (entry.phase === undefined || entry.phase === 'undoing')
                    && (entry.source == null || typeof entry.source.spaceId === 'string' && entry.source.section === 'temporaryTabs'
                        && Array.isArray(entry.source.ids) && Array.isArray(entry.source.restoreQueue) && Array.isArray(entry.source.restoredMetadata)))
                || new Set(saved.entries.map(e => e.tabId)).size !== saved.entries.length
                || new Set(saved.entries.map(e => `${e.favoriteId}:${e.windowId}`)).size !== saved.entries.length) {
                throw new Error('Favorite recovery tracking could not be read. No tabs were changed.');
            }
            for (const entry of saved.entries) {
                const tab = tabs.find(tab => tab.id === entry.tabId);
                if (tab && tab.windowId === entry.windowId && !tab.incognito
                    && available(entry.favoriteId, entry.tabId, entry.windowId)
                    && identity(this.store.item(entry.favoriteId)) === entry.hint.identity
                    && !isTransientTab(this.store.spaceStore, tab) && !isTransientWindow(this.store.spaceStore, tab.windowId)) entries.push(entry);
            }
        } else {
            // Require exact current-page URL, title, pin bit AND the full window
            // URL/pin multiset. No saved-homepage, title-only, ID or index guessing.
            // Duplicate live URLs, saved identities, hints or windows are manual.
            for (const hint of this.hints) {
                const item = this.store.items.find(item => identity(item) === hint.identity);
                const matches = tabs.filter(tab => tab.url === hint.url && !tab.incognito);
                if (!item || matches.length !== 1 || this.hints.filter(h => h.url === hint.url || h.favoriteId === hint.favoriteId).length !== 1
                    || this.store.items.filter(other => other.url === item.url).length !== 1) continue;
                const tab = matches[0];
                if (!available(hint.favoriteId, tab.id, tab.windowId) || !await this.eligible(tab)
                    || tabs.some(other => other.windowId === tab.windowId && (other.pendingUrl && other.pendingUrl !== other.url))
                    || tab.title !== hint.title || !!tab.pinned !== hint.pinned
                    || await signature(tabs.filter(t => t.windowId === tab.windowId)) !== hint.window) continue;
                entries.push({ favoriteId: hint.favoriteId, tabId: tab.id, windowId: tab.windowId, token: crypto.randomUUID(), hint });
            }
            // Recheck the entire native sample after every asynchronous eligibility
            // read. A race or partial startup leaves the uncertain case manual.
            const fresh = await this.store.queryAttachmentTabs(undefined);
            if (revision !== this.revision || JSON.stringify(tabs.map(shape).sort()) !== JSON.stringify(fresh.map(shape).sort())) entries = [];
        }
        await chrome.storage.session.set({ [RESTART_SESSION_KEY]: { version: 1, entries: copy(entries) } });
        this.entries = entries; this.dirty = false; this.ready = true;
    }
    recoverySource(entry) {
        const spaces = this.store.spaceStore, current = this.store.captureRecoverySource(entry.tabId);
        const saved = entry.hint.placement;
        if (!saved) return current;
        const target = spaces.spaces.find(space => space.id === saved.spaceId && space.bookmarkFolderId === saved.bookmarkFolderId);
        if (!target) return undefined; // A removed/changed Space makes recovery manual.
        const tabs = [...spaces.liveTabs.values()];
        const resolve = page => {
            const matches = tabs.filter(tab => tab.windowId === entry.windowId && tab.url === page.url && (tab.title || '').slice(0, 256) === page.title);
            return matches.length === 1 && target.temporaryTabs.includes(matches[0].id) ? matches[0].id : null;
        };
        const after = saved.after.map(resolve).find(Boolean), before = saved.before.map(resolve).filter(Boolean).at(-1);
        if ((saved.before.length || saved.after.length) && !after && !before) return undefined;
        const ids = target.temporaryTabs.filter(id => id !== entry.tabId);
        const index = after ? ids.indexOf(after) : before ? ids.indexOf(before) + 1 : ids.length;
        ids.splice(index, 0, entry.tabId);
        // Historical numeric IDs and per-incarnation metadata never cross a full
        // restart. Stable Space plus unique surviving neighbors restore Undo's order.
        return { spaceId: target.id, section: 'temporaryTabs', ids, lastTab: false,
            provisional: false, recovery: false, restoreQueue: [], restoredMetadata: [] };
    }
    rememberPlacement(entry) {
        if (entry.hint.placement || !entry.source) return;
        const spaces = this.store.spaceStore, source = entry.source;
        const target = spaces.spaces.find(space => space.id === source.spaceId);
        const page = id => { const tab = spaces.liveTabs.get(id); return tab && isFavoriteUrl(tab.url) && tab.url.length <= 2048 ? { url: tab.url, title: (tab.title || '').slice(0, 256) } : null; };
        const position = source.ids.indexOf(entry.tabId);
        entry.hint = { ...entry.hint, placement: { spaceId: source.spaceId, bookmarkFolderId: target.bookmarkFolderId,
            before: source.ids.slice(0, position).map(page).filter(Boolean).slice(-3), after: source.ids.slice(position + 1).map(page).filter(Boolean).slice(0, 3) } };
    }
    async activate() {
        if (!this.ready || this.active || !this.store.spaceStore.initialized) return;
        const spaces = this.store.spaceStore;
        if (!this.entries.length) { this.active = true; return; }
        let entries = this.entries.filter(entry => !spaces.spaces.some(space => space.spaceBookmarks.includes(entry.tabId)));
        for (const entry of entries) {
            if (entry.phase === 'undoing') {
                this.store.restoreRecoverySource(entry.tabId, entry.source);
            } else if (!Object.hasOwn(entry, 'source')) entry.source = this.recoverySource(entry);
            if (entry.source !== undefined) this.rememberPlacement(entry);
        }
        entries = entries.filter(entry => entry.source !== undefined && bytes(entry.hint) <= MAX_HINT_BYTES).slice(0, MAX_HINTS);
        if (entries.length) {
            const hints = [...entries.filter(entry => entry.phase !== 'undoing').map(entry => entry.hint),
                ...this.hints.filter(hint => this.store.state.bindings.some(binding => binding.favoriteId === hint.favoriteId)
                    && !entries.some(entry => entry.favoriteId === hint.favoriteId))];
            await chrome.storage.local.set({ [RESTART_HINTS_KEY]: { version: 1, phase: 'committed', capturedAt: this.store.now(), entries: copy(hints) } });
            this.hints = hints; this.checkpointStamp = null;
        }
        // Persist rollback placement before inference can exclude any membership.
        await chrome.storage.session.set({ [RESTART_SESSION_KEY]: { version: 1, entries: copy(entries) } });
        this.entries = entries; this.active = true;
        for (const entry of entries.filter(entry => entry.phase !== 'undoing')) {
            const tab = spaces.liveTabs?.get(entry.tabId);
            if (tab) spaces.track(tab);
        }
    }
    async finishUndo() {
        if (!this.entries.some(entry => entry.phase === 'undoing')) return;
        const entries = this.entries.filter(entry => entry.phase !== 'undoing');
        await chrome.storage.session.set({ [RESTART_SESSION_KEY]: { version: 1, entries: copy(entries) } });
        this.entries = entries;
    }
    async beforeSave() {
        if (!this.ready || !this.hints.length) return;
        // Invalidate stale hints before release/close/remove can be acknowledged.
        await chrome.storage.local.set({ [RESTART_HINTS_KEY]: { version: 1, phase: 'invalid' } });
        this.checkpointStamp = null;
    }
    async checkpoint(tabs) {
        if (!this.ready) return;
        tabs ||= await this.store.queryAttachmentTabs(undefined);
        // The full native cohort is evidence too, including newly created tabs
        // that arrive complete and never emit an onUpdated event.
        const sample = JSON.stringify(tabs.map(shape).sort());
        const stamp = JSON.stringify([this.store.state, this.entries, this.revision, this.store.items.map(identity), sample]);
        if (stamp === this.checkpointStamp && this.store.now() - this.checkpointAt < 60000) return;
        const revision = this.revision, hints = this.entries.filter(entry => entry.phase !== 'undoing').map(entry => entry.hint);
        for (const binding of this.store.state.bindings) {
            const tab = tabs.find(tab => tab.id === binding.tabId && tab.windowId === binding.windowId);
            const item = this.store.items.find(item => item.id === binding.favoriteId);
            if (!item || !await this.eligible(tab) || binding.mode !== 'ordinary' && !tab.pinned
                || tabs.some(other => other.windowId === tab.windowId && (other.pendingUrl && other.pendingUrl !== other.url))
                || this.store.state.attempts.some(entry => entry.tabId === tab.id)
                || tabs.filter(other => other.url === tab.url && !other.incognito).length !== 1
                || this.store.items.filter(other => other.url === item.url).length !== 1) continue;
            hints.push({ favoriteId: item.id, identity: identity(item), url: tab.url, title: tab.title, pinned: !!tab.pinned,
                window: await signature(tabs.filter(other => other.windowId === tab.windowId)) });
        }
        const fresh = await this.store.queryAttachmentTabs(undefined);
        if (revision !== this.revision || sample !== JSON.stringify(fresh.map(shape).sort())) return;
        const bounded = hints.filter(hint => bytes(hint) <= MAX_HINT_BYTES).slice(0, MAX_HINTS);
        hints.splice(0, hints.length, ...bounded);
        if (!hints.length && !this.hints.length) return;
        await chrome.storage.local.set({ [RESTART_HINTS_KEY]: { version: 1, phase: 'committed', capturedAt: this.store.now(), entries: copy(hints) } });
        this.hints = hints; this.checkpointStamp = stamp; this.checkpointAt = this.store.now();
    }
    async reconcile(tabs) {
        const entries = this.entries.filter(entry => {
            const tab = tabs.get(entry.tabId);
            return tab && tab.windowId === entry.windowId && !tab.incognito
                && this.store.items.some(item => identity(item) === entry.hint.identity)
                && !isTransientTab(this.store.spaceStore, tab) && !isTransientWindow(this.store.spaceStore, tab.windowId)
                && ![...this.store.state.bindings, ...this.store.state.attempts].some(e => e.tabId === entry.tabId
                    || e.favoriteId === entry.favoriteId && e.windowId === entry.windowId);
        });
        if (this.dirty || entries.length !== this.entries.length) {
            await chrome.storage.session.set({ [RESTART_SESSION_KEY]: { version: 1, entries: copy(entries) } });
            this.entries = entries; this.dirty = false;
        }
    }
    async review(message, confirm) {
        const entry = this.forFavorite(message.favoriteId, message.windowId);
        if (!entry || entry.tabId !== message.tabId || entry.token !== message.token) stale();
        const tab = await this.store.currentTab(entry.tabId, entry.windowId);
        if (confirm && !await this.eligible(tab)) stale();
        if (entry.token !== message.token) stale();
        if (confirm) {
            const revision = this.revision, original = shape(tab);
            // Reuse the proven consent fence and rollback rather than inventing
            // another ownership transaction. The shared queue excludes callers.
            this.entries = this.entries.filter(e => e !== entry);
            try {
                const offers = await this.store.attachment.candidates(entry.favoriteId, entry.windowId);
                const offer = offers.candidates.find(offer => offer.tabId === entry.tabId);
                if (!offer || revision !== this.revision || original !== shape(await this.store.currentTab(entry.tabId, entry.windowId))) stale();
                await this.store.attachment.attach({ ...message, token: offer.token });
            } catch (error) { this.entries.push(entry); throw error; }
        } else {
            const hints = this.hints.filter(hint => hint.favoriteId !== entry.favoriteId);
            await chrome.storage.local.set({ [RESTART_HINTS_KEY]: { version: 1, phase: 'committed', capturedAt: this.store.now(), entries: copy(hints) } });
            this.hints = hints;
        }
        const remaining = confirm ? this.entries.filter(e => e !== entry)
            : this.entries.map(e => e === entry ? { ...e, phase: 'undoing' } : e);
        try { await chrome.storage.session.set({ [RESTART_SESSION_KEY]: { version: 1, entries: copy(remaining) } }); }
        catch (error) { this.store.initialized = false; throw error; }
        this.entries = remaining;
        if (!confirm) this.store.restoreRecoverySource(tab.id, entry.source);
        this.store.spaceStore.track(tab);
        try {
            await this.store.spaceStore.persist();
            await this.finishUndo();
        } catch (error) {
            this.store.initialized = false; this.store.spaceStore.initialized = false;
            throw error;
        }
        return {};
    }
}
