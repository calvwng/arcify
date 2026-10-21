/** Exact archive adapter and separate, gesture-preserving native panel transport. */
import { PEER_KEY, PAIRING_GENERATION_KEY, bridgeError, isArchiveActionContext, isWindowId, normalizeTabActionUrl } from './spotlight-bridge-protocol.js';
import { validateSidebarSender } from './sidebar-command.js';
import { isReopenableArchiveUrl, fencedArchiveRead } from './archive-store.js';
import { ARCHIVE_DISPLAY_PORT, ARCHIVE_DISPLAY_TYPE, observeArchiveDisplayChanges } from './archive-display-session.js';
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
        this.views = new Map(); this.intents = new Map(); this.panels = new Set(); this.openedWindows = new Set();
        this.stopObserving = () => {};
        browser.sidePanel?.onOpened?.addListener(info => {
            if (!isWindowId(info.windowId) || !['sidebar.html', '/sidebar.html'].includes(info.path)) return;
            this.openedWindows.add(info.windowId);
            try { Promise.resolve(browser.runtime.sendMessage({ type: 'arcifyArchiveAvailable', windowId: info.windowId })).catch(() => {}); } catch { /* Native sidebar may still be starting. */ }
            while (this.openedWindows.size > 64) this.openedWindows.delete(this.openedWindows.values().next().value);
        });
        browser.sidePanel?.onClosed?.addListener(info => {
            this.openedWindows.delete(info.windowId);
            for (const panel of this.panels) if (panel.windowId === info.windowId) panel.close();
            for (const intent of this.intents.values()) if (intent.context.windowId === info.windowId && intent.phase !== 'prepared') {
                intent.invalidated = true;
                intent.finish?.(bridgeError('OPEN_FAILED', 'The native sidebar closed before its archive display was confirmed.'));
            }
        });
    }
    supported() { return Boolean(this.store.archiveStore); }
    canOpen() { return typeof this.browser.sidePanel?.open === 'function' && typeof this.browser.runtime?.onConnect?.addListener === 'function'
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
        if (!intent || intent.invalidated || this.intents.get(intent.token) !== intent || intent.expires <= this.now()) stale();
        return fencedArchiveRead({ windowId: intent.context.windowId, context: intent.context }, async () => {
        const stored = await this.browser.storage.local.get([PEER_KEY, PAIRING_GENERATION_KEY]);
        if (stored[PEER_KEY] !== intent.peerId || (stored[PAIRING_GENERATION_KEY] ?? null) !== intent.pairingGeneration)
            throw bridgeError('UNAUTHORIZED', 'The Arcify connection changed.');
        await this.store.archiveStore.contextUnlocked(intent.context.windowId, withoutGeneration(intent.context));
        await this.normalWindow(intent.context.windowId, true);
        if (intent.invalidated || this.intents.get(intent.token) !== intent) stale();
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
                        if (error && intent.panel) this.sendPanel(intent.panel, { event: 'cancel', session: intent.session,
                            token: intent.token, code: error.code || 'OPEN_FAILED', error: error.message });
                        if (error) reject(error); else response({ ok: true, displayed: true });
                    };
                    intent.timer = setTimeout(() => intent.finish(bridgeError('UNCERTAIN_RESULT', 'Arcify did not confirm that the archive was displayed. Check its sidebar before trying again.')), this.ackMs);
                    Promise.resolve(opening).then(() => {
                        if (settled) return;
                        if (intent.invalidated) { intent.finish(bridgeError('STALE_ARCHIVE', 'The archive source changed.')); return; }
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
    async normalWindow(windowId, focused = false) {
        const window = await this.browser.windows.get(windowId, { populate: false });
        if (window?.id !== windowId || window.type !== 'normal' || window.incognito || focused && window.focused !== true) stale();
    }
    sendPanel(panel, payload) {
        if (!panel.live) return;
        try { panel.port.postMessage({ type: ARCHIVE_DISPLAY_TYPE, ...payload }); }
        catch { panel.close(); }
    }
    uniquePanel(panel) {
        return panel.live && panel.registered && this.panels.has(panel)
            && [...this.panels].filter(other => other.live && other.windowId === panel.windowId).length === 1;
    }
    // Authenticates only Arcify's packaged sidebar UI. Chrome 155 omits the
    // native sidebar sender documentId; a Port does NOT prove SIDE_PANEL.
    // Renderer eligibility comes from that trusted code, not caller assertions
    // accepted from websites, other extensions, or arbitrary runtime messages.
    connectPanel(port) {
        if (port.name !== ARCHIVE_DISPLAY_PORT) return;
        const sender = port.sender, url = this.browser.runtime.getURL('sidebar.html');
        if (sender?.id !== this.browser.runtime.id || sender.url !== url || sender.origin !== url.slice(0, -'/sidebar.html'.length)
            || sender.tab != null || sender.incognito === true || sender.frameId != null && sender.frameId !== 0
            || sender.documentLifecycle != null && sender.documentLifecycle !== 'active') {
            port.disconnect(); return;
        }
        if (this.panels.size >= 64) { port.disconnect(); return; }
        const panel = { port, live: true, registered: false, windowId: null, session: crypto.randomUUID(), seen: new Set() };
        const close = () => {
            if (!panel.live) return;
            panel.live = false; this.panels.delete(panel);
            port.onMessage.removeListener(listener); port.onDisconnect.removeListener(close);
            for (const intent of this.intents.values()) if (intent.panel === panel) {
                intent.invalidated = true;
                intent.finish?.(bridgeError('OPEN_FAILED', 'The archive display connection closed. Choose Open Archive again.'));
            }
            try { port.disconnect(); } catch { /* Already disconnected. */ }
        };
        panel.close = close;

        const listener = request => {
            (async () => {
                try {
                    const base = ['type', 'requestId', 'action', 'windowId'];
                    const keys = request?.action === 'register' ? base : [...base, 'session',
                        ...(['validate', 'ack', 'cancel'].includes(request?.action) ? ['token'] : []), ...(request?.action === 'ack' ? ['displayed'] : [])];
                    if (request?.type !== ARCHIVE_DISPLAY_TYPE || !['register', 'take', 'validate', 'ack', 'cancel'].includes(request.action)
                        || !exact(request, keys) || !id(request.requestId) || !isWindowId(request.windowId)
                        || panel.seen.has(request.requestId) || panel.seen.size >= 4096
                        || request.action !== 'register' && request.session !== panel.session
                        || ['validate', 'ack', 'cancel'].includes(request.action) && !id(request.token)
                        || request.action === 'ack' && typeof request.displayed !== 'boolean')
                        throw bridgeError('INVALID_REQUEST', 'Invalid archive display request.');
                    panel.seen.add(request.requestId);
                    if (request.action === 'register') {
                        if (panel.windowId !== null) throw bridgeError('INVALID_REQUEST', 'This archive display connection is already registered.');
                        panel.windowId = request.windowId;
                        this.panels.add(panel);
                        if ([...this.panels].filter(other => other.live && other.windowId === panel.windowId).length !== 1) {
                            for (const intent of this.intents.values()) if (intent.context.windowId === panel.windowId && intent.phase !== 'prepared')
                                intent.finish?.(bridgeError('PANEL_AMBIGUOUS', 'More than one Arcify archive display is registered for this window.'));
                            throw bridgeError('PANEL_AMBIGUOUS', 'More than one Arcify archive display is registered for this window.');
                        }
                        await this.normalWindow(panel.windowId);
                        panel.registered = true;
                        if (!this.uniquePanel(panel)) stale();
                        this.sendPanel(panel, { requestId: request.requestId, success: true, result: { registered: true, session: panel.session } });
                        return;
                    }
                    if (request.windowId !== panel.windowId || !this.uniquePanel(panel))
                        throw bridgeError('PANEL_UNVERIFIED', 'The archive display connection changed or is ambiguous.');
                    if (request.action === 'cancel') {
                        // Process renderer invalidation immediately, even while
                        // an older validate/ACK awaits the SpaceStore queue.
                        const intent = this.intents.get(request.token);
                        if (!intent || intent.panel !== panel || intent.session !== panel.session) stale();
                        intent.invalidated = true;
                        intent.finish(bridgeError('STALE_ARCHIVE', 'The archive display was interrupted by a newer UI action.'));
                        this.sendPanel(panel, { requestId: request.requestId, success: true, result: { cancelled: true } });
                        return;
                    }
                    const result = await this.store.run(async () => {
                        const intent = request.action === 'take'
                            ? [...this.intents.values()].find(value => value.phase === 'pending' && value.context.windowId === panel.windowId)
                            : this.intents.get(request.token);
                        if (!intent && request.action === 'take') return null;
                        if (!intent || request.action !== 'take' && (intent.panel !== panel || intent.session !== panel.session
                            || intent.context.windowId !== panel.windowId
                            || (request.action === 'validate' ? intent.phase !== 'claimed'
                                : request.displayed ? intent.phase !== 'validated' : !['claimed', 'validated'].includes(intent.phase)))) stale();
                        await this.checkIntent(intent);
                        if (!this.uniquePanel(panel) || !this.intents.has(intent.token)) stale();
                        if (request.action === 'take') {
                            intent.phase = 'claimed'; intent.panel = panel; intent.session = panel.session;
                            return { token: intent.token, context: copy(intent.context) };
                        }
                        if (request.action === 'validate') { intent.phase = 'validated'; return { valid: true }; }
                        intent.finish(request.displayed ? null : bridgeError('OPEN_FAILED', 'The archive popup was not displayed.'));
                        return { displayed: request.displayed };
                    });
                    this.sendPanel(panel, { requestId: request.requestId, success: true, result });
                } catch (error) {
                    // A failed claimed operation burns that invocation. It never
                    // turns a stale render or rejected ACK into a retry.
                    for (const intent of this.intents.values()) if (intent.panel === panel)
                        intent.finish?.(error);
                    this.sendPanel(panel, { requestId: request?.requestId, success: false, error: error.message, code: error.code || 'FAILED' });
                }
            })();
        };
        this.panels.add(panel);
        port.onMessage.addListener(listener); port.onDisconnect.addListener(close);
    }
    install() {
        if (!this.browser.runtime.onConnect?.addListener) return () => {};
        this.stopObserving = observeArchiveDisplayChanges(this.browser,
            () => [...this.intents.values()].filter(intent => intent.phase !== 'prepared'), intent => {
                intent.invalidated = true;
                intent.finish?.(bridgeError('STALE_ARCHIVE', 'The source, selected Space, or browser focus changed. Choose Open Archive again.'));
            });
        const listener = port => this.connectPanel(port);
        this.browser.runtime.onConnect.addListener(listener);
        return () => {
            this.browser.runtime.onConnect.removeListener(listener);
            this.stopObserving();
            for (const panel of this.panels) panel.close();
        };
    }
}
