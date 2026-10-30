import { ARCHIVE_DISPLAY_PORT, ARCHIVE_DISPLAY_TYPE, observeArchiveDisplayChanges } from './archive-display-session.js';

const popupRevisions = new WeakMap(), popupObservers = new WeakMap();

/** Shared explicit popup state prevents native and Spotlight toggles diverging. */
export function setArchivePopupOpen(space, open) {
    const popup = space?.querySelector('.archived-tabs-popup'), content = space?.querySelector('.space-content');
    if (!popup || !content) throw new Error('The archive view is no longer available.');
    popupObservers.get(space)?.();
    popup.classList.toggle('visible', open);
    content.classList.toggle('hidden', open);
    space.querySelector('.sidebar-button')?.setAttribute('aria-expanded', String(open));
    const revision = (popupRevisions.get(space) || 0) + 1;
    popupRevisions.set(space, revision);
    return revision;
}

/** Trusted packaged UI consumer; the Port is not proof of a native host. */
export function createArchiveIntentConsumer({ api = chrome, document, getState, showPopup, onError = () => {} }) {
    let disposed = false, busy = false, again = false, started = false, connection = null, attempt = null;
    let sequence = 0;
    const view = document.defaultView;
    const fail = () => new Error('The archive display context changed. Choose Open Archive again.');
    const invalidate = () => {
        const current = attempt;
        if (!current) return;
        current.invalidated = true;
        if (current.intent && current.channel?.live && !current.cancelSent) {
            current.cancelSent = true;
            try { current.channel.port.postMessage({ type: ARCHIVE_DISPLAY_TYPE, requestId: String(++sequence), action: 'cancel',
                windowId: current.context.windowId, session: current.channel.session, token: current.intent.token }); }
            catch { current.channel.close(); }
        }
    };
    const stopObserving = observeArchiveDisplayChanges(api, () => attempt ? [attempt] : [], invalidate);
    const onVisibility = () => { if (document.visibilityState === 'hidden') invalidate(); };
    document.addEventListener('visibilitychange', onVisibility);
    // An explicit newer user action wins over any delayed display response.
    const onInput = () => { if (attempt?.taking || attempt?.intent) { attempt.userChanged = true; invalidate(); } };
    document.addEventListener('pointerdown', onInput, true);
    document.addEventListener('keydown', onInput, true);
    const assertCurrent = current => {
        const state = getState();
        if (disposed || current.invalidated || attempt !== current || !state.ready || state.revision !== current.revision
            || state.windowId !== current.context.windowId || state.spaceId !== current.context.spaceId
            || state.bookmarkFolderId !== current.context.bookmarkFolderId || document.visibilityState === 'hidden') throw fail();
    };
    const eligible = async current => {
        const url = api.runtime.getURL('sidebar.html');
        if (view?.top !== view || view?.location?.href !== url || api.extension?.inIncognitoContext !== false) throw fail();
        if (await api.tabs.getCurrent() !== undefined) throw fail();
        const window = await api.windows.getCurrent({ populate: false });
        if (window?.id !== current.context.windowId || window.type !== 'normal' || window.incognito || window.focused !== true) throw fail();
        assertCurrent(current);
        return window.id;
    };
    const connect = () => {
        if (connection?.live) return connection;
        const port = api.runtime.connect({ name: ARCHIVE_DISPLAY_PORT });
        const current = { port, live: true, session: null, pending: new Map() };
        const message = reply => {
            if (!current.live || reply?.type !== ARCHIVE_DISPLAY_TYPE) return;
            if (reply.event === 'cancel' && reply.session === current.session && reply.token === attempt?.intent?.token) { invalidate(); return; }
            const pending = current.pending.get(reply.requestId);
            if (!pending) return;
            current.pending.delete(reply.requestId); clearTimeout(pending.timer);
            if (reply.success) pending.resolve(reply.result); else pending.reject(new Error(reply.error || 'Arcify could not confirm the archive display.'));
        };
        current.close = () => {
            if (!current.live) return;
            current.live = false;
            if (connection === current) { connection = null; invalidate(); }
            port.onMessage.removeListener(message); port.onDisconnect.removeListener(current.close);
            for (const pending of current.pending.values()) { clearTimeout(pending.timer); pending.reject(fail()); }
            current.pending.clear();
            try { port.disconnect(); } catch { /* Already disconnected. */ }
        };
        port.onMessage.addListener(message); port.onDisconnect.addListener(current.close);
        connection = current;
        return current;
    };
    const request = (current, action, windowId, extra = {}) => new Promise((resolve, reject) => {
        if (!current.live) { reject(fail()); return; }
        const requestId = String(++sequence);
        const timer = setTimeout(() => { current.pending.delete(requestId); reject(fail()); current.close(); }, 7000);
        current.pending.set(requestId, { resolve, reject, timer });
        try { current.port.postMessage({ type: ARCHIVE_DISPLAY_TYPE, requestId, action, windowId,
            ...(action !== 'register' ? { session: current.session } : {}), ...extra }); }
        catch (error) { current.pending.delete(requestId); clearTimeout(timer); reject(error); current.close(); }
    });
    const consume = async () => {
        if (disposed || !started || !getState().ready) return;
        if (busy) { again = true; return; }
        busy = true;
        const state = getState(), current = { context: { windowId: state.windowId, spaceId: state.spaceId,
            bookmarkFolderId: state.bookmarkFolderId }, revision: state.revision, invalidated: false };
        attempt = current;
        let channel, popup, space, displayRevision, newlyOpened = false;
        try {
            const windowId = await eligible(current);
            channel = connect(); current.channel = channel;
            if (!channel.session) {
                const registration = await request(channel, 'register', windowId);
                if (!registration?.registered || typeof registration.session !== 'string') throw fail();
                channel.session = registration.session;
            }
            assertCurrent(current);
            current.taking = true;
            const intent = await request(channel, 'take', windowId);
            current.taking = false;
            if (!intent) return;
            current.intent = intent;
            if (current.invalidated) { invalidate(); throw fail(); }
            if (intent.context.windowId !== current.context.windowId || intent.context.spaceId !== current.context.spaceId
                || intent.context.bookmarkFolderId !== current.context.bookmarkFolderId) throw fail();
            current.context = intent.context;
            await eligible(current);
            space = [...document.querySelectorAll('[data-space-id]')].find(element => element.dataset.spaceId === intent.context.spaceId && element.classList.contains('space'));
            popup = space?.querySelector('.archived-tabs-popup');
            const content = space?.querySelector('.space-content');
            const visibleSpace = () => popup?.isConnected && space.isConnected && space.style.display !== 'none' && !space.hidden
                && content?.isConnected && space.dataset.spaceId === intent.context.spaceId
                && space.querySelector('.archived-tabs-popup') === popup && space.querySelector('.space-content') === content;
            if (!visibleSpace()) throw fail();
            current.popupObserver = () => { if (!current.settingPopup) { current.userChanged = true; invalidate(); } };
            popupObservers.set(space, current.popupObserver);
            const changedDOM = records => {
                if (!visibleSpace() || records.some(record => record.type === 'attributes'
                    && [space, popup, content].includes(record.target)
                    && ['class', 'style', 'hidden', 'data-space-id'].includes(record.attributeName)
                    && record.oldValue !== record.target.getAttribute(record.attributeName)
                    || record.type === 'childList' && [...record.removedNodes].some(node =>
                        [space, popup, content].some(target => node === target || node.contains?.(target))))) {
                    current.userChanged = true;
                    invalidate();
                }
            };
            current.domObserver = new view.MutationObserver(changedDOM);
            current.domObserver.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeOldValue: true });
            // Own visibility writes are synchronous. Drain earlier records first,
            // then discard only the records emitted by this exact helper call.
            const setOwnedPopup = open => {
                changedDOM(current.domObserver.takeRecords());
                assertCurrent(current);
                current.settingPopup = true;
                const revision = setArchivePopupOpen(space, open);
                current.domObserver.takeRecords();
                current.settingPopup = false;
                return revision;
            };
            // Already-open native UI owns its live rows and focus. Rebuilding
            // it merely to show it would destroy controls the user is using.
            if (!popup.classList.contains('visible')) await showPopup(intent.context.spaceId);
            await eligible(current);
            if (!visibleSpace()) throw fail();
            const validation = await request(channel, 'validate', windowId, { token: intent.token });
            if (validation?.valid !== true) throw fail();
            await eligible(current);
            if (!visibleSpace()) throw fail();
            newlyOpened = !popup.classList.contains('visible');
            displayRevision = setOwnedPopup(true);
            const displayed = () => visibleSpace() && popupRevisions.get(space) === displayRevision && popup.classList.contains('visible')
                && space.querySelector('.space-content')?.classList.contains('hidden');
            if (!displayed()) throw fail();
            const ack = await request(channel, 'ack', windowId, { token: intent.token, displayed: true });
            await eligible(current);
            if (ack?.displayed !== true || !displayed()) throw fail();
            // Display-only: do not focus a control, tab, window, or Space.
        } catch (error) {
            if (newlyOpened && !current.userChanged && popupRevisions.get(space) === displayRevision && popup?.isConnected && space?.isConnected
                && getState().spaceId === current.context.spaceId && getState().windowId === current.context.windowId) {
                current.settingPopup = true;
                setArchivePopupOpen(space, false);
                current.domObserver?.takeRecords();
                current.settingPopup = false;
            }
            if (channel && !channel.session) channel.close();
            if (current.intent && channel?.live) {
                try { await request(channel, 'ack', current.context.windowId, { token: current.intent.token, displayed: false }); }
                catch { /* An expired/invalidated one-use intent is never replayed. */ }
            }
            if (!disposed && current.intent) onError(error.message);
        } finally {
            current.domObserver?.disconnect();
            if (space && popupObservers.get(space) === current.popupObserver) popupObservers.delete(space);
            if (attempt === current) attempt = null;
            busy = false;
            if (again) { again = false; void consume(); }
        }
    };
    const listener = message => { if (message?.type === 'arcifyArchiveAvailable' && message.windowId === getState().windowId) void consume(); };
    api.runtime.onMessage.addListener(listener);
    return { start() { started = true; void consume(); }, consume, invalidate,
        dispose() {
            disposed = true; invalidate(); connection?.close(); stopObserving();
            api.runtime.onMessage.removeListener(listener);
            document.removeEventListener('visibilitychange', onVisibility);
            document.removeEventListener('pointerdown', onInput, true); document.removeEventListener('keydown', onInput, true);
        } };
}
