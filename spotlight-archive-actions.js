/** Exact archive adapter and separate, gesture-preserving native panel transport. */
import { PEER_KEY, PAIRING_GENERATION_KEY, bridgeError, isArchiveActionContext, isWindowId, normalizeTabActionUrl } from './spotlight-bridge-protocol.js';
import { validateSidebarSender } from './sidebar-command.js';
import { isReopenableArchiveUrl, fencedArchiveRead } from './archive-store.js';
export const ARCHIVE_OPEN_TYPE = 'arcify-archive-open';
const copy = value => structuredClone(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
const stale = () => { throw bridgeError('STALE_ARCHIVE', 'This archive selection or source changed. Refresh Spotlight and choose again.'); };
const withoutGeneration = ({ pairingGeneration, ...context }) => context;
const descriptor = ({ entry, bookmarkFolderId }) => ({ entryId: entry.entryId, title: entry.name, url: entry.url,
    spaceId: entry.spaceId, bookmarkFolderId, archivedAt: entry.archivedAt });
const validDescriptor = entry => id(entry.entryId) && id(entry.spaceId) && id(entry.bookmarkFolderId)
    && typeof entry.title === 'string' && entry.title.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(entry.title)
    && isReopenableArchiveUrl(entry.url) && normalizeTabActionUrl(entry.url) !== null && Number.isFinite(entry.archivedAt) && entry.archivedAt >= 0;

export class SpotlightArchiveActions {
    constructor(store, browser = globalThis.chrome, { ttlMs = 300000, ackMs = 8000, maxViews = 64, now = Date.now } = {}) {
        Object.assign(this, { store, browser, ttlMs, ackMs, maxViews, now });
        this.views = new Map(); this.intents = new Map(); this.panels = new Map(); this.openedWindows = new Set();
        browser.sidePanel?.onOpened?.addListener(info => {
            if (!isWindowId(info.windowId) || !['sidebar.html', '/sidebar.html'].includes(info.path)) return;
            this.openedWindows.add(info.windowId);
            try { Promise.resolve(browser.runtime.sendMessage({ type: 'arcifyArchiveAvailable', windowId: info.windowId })).catch(() => {}); } catch { /* Native sidebar may still be starting. */ }
            while (this.openedWindows.size > 64) this.openedWindows.delete(this.openedWindows.values().next().value);
        });
        browser.sidePanel?.onClosed?.addListener(info => {
            this.openedWindows.delete(info.windowId);
            for (const [documentId, windowId] of this.panels) if (windowId === info.windowId) this.panels.delete(documentId);
            for (const intent of this.intents.values()) if (intent.context.windowId === info.windowId && intent.finish)
                intent.finish(bridgeError('OPEN_FAILED', 'The native sidebar closed before its archive display was confirmed.'));
        });
    }
    supported() { return Boolean(this.store.archiveStore); }
    canOpen() { return typeof this.browser.sidePanel?.open === 'function' && typeof this.browser.runtime?.getContexts === 'function'
        && typeof this.browser.sidePanel?.onOpened?.addListener === 'function' && typeof this.browser.sidePanel?.onClosed?.addListener === 'function'; }
    prune() {
        for (const [key, view] of this.views) if (view.expires <= this.now()) this.views.delete(key);
        while (this.views.size >= this.maxViews) this.views.delete(this.views.keys().next().value);
        for (const [key, intent] of this.intents) if (intent.expires <= this.now() || !this.views.has(intent.viewId)) {
            if (intent.finish) intent.finish(bridgeError('STALE_ARCHIVE', 'Archive intent expired. Choose Open Archive again.'));
            else this.intents.delete(key);
        }
    }
    async prepareUnlocked(request, { peerId, pairingGeneration, beforeReturn = async () => {} }) {
        if (!this.supported()) throw bridgeError('UNSUPPORTED_FEATURE', 'This Arcify build has no exact archive actions.');
        const view = await this.store.archiveStore.viewUnlocked(request.windowId);
        if (view.context.sourceTabId !== request.tabId) stale();
        const context = { ...view.context, pairingGeneration };
        if (!isArchiveActionContext(context)) stale();
        await beforeReturn();
        // Private full records preserve unknown legacy fields. The wire only
        // carries bounded display descriptors and opaque, worker-local authority.
        const entries = view.entries.filter(item => validDescriptor(descriptor(item)));
        if (entries.length > 1000 || JSON.stringify(entries).length > 1024 * 1024) throw bridgeError('ARCHIVE_TOO_LARGE', 'Open the Arcify archive to choose an entry.');
        this.prune();
        const viewId = crypto.randomUUID(), openIntent = this.canOpen() ? crypto.randomUUID() : null;
        const expires = this.now() + this.ttlMs;
        this.views.set(viewId, { peerId, pairingGeneration, context: copy(context), entries: copy(entries), expires });
        if (openIntent) this.intents.set(openIntent, { token: openIntent, viewId, context: copy(context), peerId, pairingGeneration, expires, phase: 'prepared' });
        return { context, viewId, openIntent, entries: entries.map(descriptor) };
    }
    async reopenUnlocked(request, { peerId, pairingGeneration, beforeMutation = async () => {} }) {
        const view = this.views.get(request.viewId);
        if (!view || view.expires <= this.now() || view.peerId !== peerId || view.pairingGeneration !== pairingGeneration
            || !same(view.context, request.context)) stale();
        const target = view.entries.find(item => item.entry.entryId === request.entryId);
        if (!target) stale();
        // A view is one-shot even on failure. A later explicit fresh view can
        // reconcile the durable exact native-ID receipt, never recreate by URL.
        this.views.delete(request.viewId);
        const result = await this.store.archiveStore.reopenUnlocked({ requestId: request.requestId, windowId: request.windowId,
            context: withoutGeneration(request.context), expected: target.entry, bookmarkFolderId: target.bookmarkFolderId }, { beforeMutation });
        if (!result?.consumed || result.entryId !== request.entryId) throw bridgeError('UNCERTAIN_RESULT', 'Archive completion was not confirmed. Check Arcify before trying again.');
        return { archiveResult: { entryId: result.entryId, tabId: result.tabId ?? null, spaceId: target.entry.spaceId,
            windowId: request.windowId, consumed: true, status: result.status === 'partial' || result.warning || !result.tabId ? 'partial' : 'reopened',
            warning: result.status === 'partial' || result.warning || !result.tabId
                ? String(result.warning || 'This archived entry was consumed, but its current tab could not be confirmed. Check Arcify before trying again.').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 2048) : null } };
    }
    async checkIntent(intent) {
        if (!intent || intent.expires <= this.now()) stale();
        return fencedArchiveRead({ windowId: intent.context.windowId, context: intent.context }, async () => {
        const stored = await this.browser.storage.local.get([PEER_KEY, PAIRING_GENERATION_KEY]);
        if (stored[PEER_KEY] !== intent.peerId || (stored[PAIRING_GENERATION_KEY] ?? null) !== intent.pairingGeneration)
            throw bridgeError('UNAUTHORIZED', 'The Arcify connection changed.');
        await this.store.archiveStore.contextUnlocked(intent.context.windowId, withoutGeneration(intent.context));
        });
    }
    open(request, sender, respond) {
        if (request?.type !== ARCHIVE_OPEN_TYPE) return;
        const response = payload => respond({ type: ARCHIVE_OPEN_TYPE, version: 1, requestId: request.requestId, role: 'arcify', ...payload });
        const reject = error => response({ ok: false, error: { code: error.code || 'OPEN_FAILED', message: error.message || 'Open the archive from Arcify’s sidebar.' } });
        try {
            if (!exact(request, ['type', 'version', 'requestId', 'token']) || request.version !== 1
                || typeof request.requestId !== 'string' || !/^[\w.:-]{1,80}$/.test(request.requestId) || !id(request.token))
                throw bridgeError('INVALID_REQUEST', 'Invalid archive opening request.');
            // Exactly one storage callback before the native gesture API. No
            // queue, Promise continuation or second browser API may precede open.
            this.browser.storage.local.get([PEER_KEY, PAIRING_GENERATION_KEY], settings => {
                let intent;
                try {
                    if (this.browser.runtime.lastError) throw bridgeError('STORAGE_FAILED', 'Could not verify Arcify pairing.');
                    const tabId = validateSidebarSender(sender, settings?.[PEER_KEY]);
                    intent = this.intents.get(request.token);
                    if (!intent || intent.phase !== 'prepared' || intent.expires <= this.now() || !this.views.has(intent.viewId)
                        || intent.peerId !== settings[PEER_KEY] || intent.pairingGeneration !== (settings[PAIRING_GENERATION_KEY] ?? null)
                        || tabId !== intent.context.sourceTabId || sender.tab.windowId !== intent.context.windowId
                        || sender.tab.url !== intent.context.sourceUrl || this.store.active[intent.context.windowId] !== intent.context.spaceId
                        || this.store.spaces.find(space => space.id === intent.context.spaceId)?.bookmarkFolderId !== intent.context.bookmarkFolderId) stale();
                    if (!this.canOpen()) throw bridgeError('UNSUPPORTED_FEATURE', 'Use Arcify’s toolbar button and open its archive.');
                    for (const current of this.intents.values()) if (current !== intent && current.finish && current.context.windowId === intent.context.windowId)
                        throw bridgeError('ARCHIVE_BUSY', 'An archive opening is already awaiting confirmation.');
                    intent.phase = 'opening';
                    // Consume before invoking Chrome. Repeated sends cannot open
                    // twice, including synchronous failures or lost responses.
                    const opening = this.browser.sidePanel.open({ tabId });
                    let settled = false;
                    intent.finish = error => {
                        if (settled) return; settled = true; clearTimeout(intent.timer); this.intents.delete(intent.token);
                        if (error) reject(error); else response({ ok: true, displayed: true });
                    };
                    intent.timer = setTimeout(() => intent.finish(bridgeError('UNCERTAIN_RESULT', 'Arcify did not confirm that the archive was displayed. Check its sidebar before trying again.')), this.ackMs);
                    Promise.resolve(opening).then(() => {
                        if (settled) return;
                        intent.phase = 'pending';
                        // Sidebar startup also polls once after its normal init.
                        // Notifications are hints, not authority or success proof.
                        try { Promise.resolve(this.browser.runtime.sendMessage({ type: 'arcifyArchiveAvailable', windowId: intent.context.windowId })).catch(() => {}); } catch { /* No sidebar listener yet. */ }
                    }, intent.finish);
                } catch (error) {
                    if (intent?.phase === 'opening') this.intents.delete(intent.token);
                    reject(error);
                }
            });
        } catch (error) { reject(error); }
        return true;
    }
    async nativeSidebar(sender, windowId) {
        const url = this.browser.runtime.getURL('sidebar.html');
        if (sender?.id !== this.browser.runtime.id || sender.url !== url || sender.origin !== url.slice(0, -'/sidebar.html'.length)
            || !id(sender.documentId) || !isWindowId(windowId)) throw bridgeError('UNAUTHORIZED', 'Only the native Arcify sidebar can consume an archive intent.');
        const contexts = await this.browser.runtime.getContexts({ contextTypes: ['SIDE_PANEL'], documentIds: [sender.documentId] });
        if (!contexts.some(context => context.contextType === 'SIDE_PANEL' && context.documentId === sender.documentId
            && context.documentUrl === url && context.incognito !== true && [windowId, -1].includes(context.windowId))) throw bridgeError('UNAUTHORIZED', 'The archive sidebar context changed.');
    }
    install() {
        const listener = (request, sender, respond) => {
            if (request?.type !== 'arcifyArchiveIntent') return;
            (async () => {
                try {
                    const keys = ['take', 'register'].includes(request.action) ? ['type', 'action', 'windowId'] : ['type', 'action', 'windowId', 'token', 'displayed'];
                    if (!['register', 'take', 'ack'].includes(request.action) || !exact(request, keys) || request.action === 'ack' && (!id(request.token) || typeof request.displayed !== 'boolean'))
                        throw bridgeError('INVALID_REQUEST', 'Invalid archive intent request.');
                    await this.nativeSidebar(sender, request.windowId);
                    if (request.action === 'register') {
                        // SIDE_PANEL.windowId is -1 on Chromium. Only our native
                        // sidebar can register its browser-derived current window,
                        // corroborated by a real onOpened in this worker epoch.
                        if (!this.openedWindows.has(request.windowId)) throw bridgeError('PANEL_UNVERIFIED', 'Open Arcify’s sidebar once to verify this window.');
                        this.panels.set(sender.documentId, request.windowId);
                        while (this.panels.size > 64) this.panels.delete(this.panels.keys().next().value);
                        respond({ success: true, result: { registered: true } }); return;
                    }
                    if (this.panels.get(sender.documentId) !== request.windowId || !this.openedWindows.has(request.windowId))
                        throw bridgeError('PANEL_UNVERIFIED', 'The native sidebar window must be verified before opening its archive.');
                    const result = await this.store.run(async () => {
                        const intent = request.action === 'take'
                            ? [...this.intents.values()].find(value => value.phase === 'pending' && value.context.windowId === request.windowId)
                            : this.intents.get(request.token);
                        if (!intent) return null;
                        if (request.action === 'ack' && (intent.phase !== 'claimed' || intent.documentId !== sender.documentId || intent.context.windowId !== request.windowId)) stale();
                        await this.checkIntent(intent);
                        if (!this.intents.has(intent.token) || this.panels.get(sender.documentId) !== request.windowId || !this.openedWindows.has(request.windowId)) stale();
                        if (request.action === 'take') { intent.phase = 'claimed'; intent.documentId = sender.documentId; return { token: intent.token, context: copy(intent.context) }; }
                        intent.finish(request.displayed ? null : bridgeError('OPEN_FAILED', 'The archive popup was not displayed.'));
                        return { displayed: request.displayed };
                    });
                    respond({ success: true, result });
                } catch (error) { respond({ success: false, error: error.message, code: error.code || 'FAILED' }); }
            })();
            return true;
        };
        this.browser.runtime.onMessage.addListener(listener);
        return () => this.browser.runtime.onMessage.removeListener(listener);
    }
}
