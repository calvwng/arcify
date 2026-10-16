/** Shared explicit popup state prevents native and Spotlight toggles diverging. */
export function setArchivePopupOpen(space, open) {
    const popup = space?.querySelector('.archived-tabs-popup'), content = space?.querySelector('.space-content');
    if (!popup || !content) throw new Error('The archive view is no longer available.');
    popup.classList.toggle('visible', open);
    content.classList.toggle('hidden', open);
    space.querySelector('.sidebar-button')?.setAttribute('aria-expanded', String(open));
}

/** Native sidebar-only consumer. Notifications never substitute for an intent. */
export function createArchiveIntentConsumer({ api = chrome, document, getState, showPopup, onError = () => {} }) {
    let disposed = false, busy = false, again = false, started = false;
    const stateMatches = context => {
        const state = getState();
        return state.ready && state.windowId === context.windowId && state.spaceId === context.spaceId
            && state.bookmarkFolderId === context.bookmarkFolderId && document.visibilityState !== 'hidden';
    };
    const consume = async () => {
        if (disposed || !started || !getState().ready) return;
        if (busy) { again = true; return; }
        busy = true;
        let intent, popup, newlyOpened = false;
        try {
            const windowId = (await api.windows.getCurrent({ populate: false })).id;
            if (windowId !== getState().windowId) return;
            const registration = await api.runtime.sendMessage({ type: 'arcifyArchiveIntent', action: 'register', windowId });
            if (!registration?.success || disposed) return;
            const response = await api.runtime.sendMessage({ type: 'arcifyArchiveIntent', action: 'take', windowId });
            if (!response?.success || !response.result || disposed) return;
            intent = response.result;
            if (!stateMatches(intent.context)) throw new Error('The selected Space changed before its archive could open.');
            const space = [...document.querySelectorAll('[data-space-id]')].find(element => element.dataset.spaceId === intent.context.spaceId && element.classList.contains('space'));
            popup = space?.querySelector('.archived-tabs-popup');
            if (!popup || space.style.display === 'none') throw new Error('The selected Space is not visible.');
            await showPopup(intent.context.spaceId);
            if (disposed || !stateMatches(intent.context) || !popup.isConnected || space.style.display === 'none')
                throw new Error('The selected Space changed while its archive was loading.');
            newlyOpened = !popup.classList.contains('visible');
            setArchivePopupOpen(space, true);
            if ((await api.windows.getCurrent({ populate: false })).id !== windowId || !stateMatches(intent.context)
                || !popup.classList.contains('visible') || !space.querySelector('.space-content')?.classList.contains('hidden'))
                throw new Error('The sidebar window or selected Space changed.');
            const ack = await api.runtime.sendMessage({ type: 'arcifyArchiveIntent', action: 'ack', windowId,
                token: intent.token, displayed: true });
            if (!ack?.success || ack.result?.displayed !== true) throw new Error(ack?.error || 'Arcify could not confirm the archive display.');
            popup.querySelector('button, input')?.focus();
        } catch (error) {
            if (newlyOpened && popup?.isConnected) {
                setArchivePopupOpen(popup.closest('.space'), false);
            }
            if (intent) {
                try { await api.runtime.sendMessage({ type: 'arcifyArchiveIntent', action: 'ack', windowId: intent.context.windowId,
                    token: intent.token, displayed: false }); } catch { /* The one-use intent is never replayed. */ }
            }
            if (!disposed) onError(error.message);
        } finally {
            busy = false;
            if (again) { again = false; void consume(); }
        }
    };
    const listener = message => { if (message?.type === 'arcifyArchiveAvailable' && message.windowId === getState().windowId) void consume(); };
    api.runtime.onMessage.addListener(listener);
    return { start() { started = true; void consume(); }, consume,
        dispose() { disposed = true; api.runtime.onMessage.removeListener(listener); } };
}
