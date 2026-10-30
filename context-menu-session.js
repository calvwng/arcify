// A menu owns its pending preparation as well as its attached surface. Starting
// another menu or leaving the sidebar cancels both, without moving focus. Dialogs
// and actions must close their menu session before taking over the interaction.
const sessions = new WeakMap();

export function createContextMenuSession(document, { onEscape = () => {} } = {}) {
    sessions.get(document)?.close();
    const view = document.defaultView;
    let surface = null, closed = false, observer = null;
    const cleanups = [];
    function listen(target, type, callback, capture = false) {
        target.addEventListener(type, callback, capture);
        cleanups.push(() => target.removeEventListener(type, callback, capture));
    }
    function close() {
        if (closed) return;
        closed = true;
        observer?.disconnect();
        if (sessions.get(document) === session) sessions.delete(document);
        surface?.remove();
        for (const cleanup of cleanups.splice(0)) cleanup();
    }
    const session = {
        get active() { return !closed; },
        close,
        onClose(callback) { if (closed) callback(); else cleanups.push(callback); },
        attach(element) {
            if (closed) return false;
            surface = element;
            document.body.appendChild(surface);
            observer = new view.MutationObserver(() => { if (!surface.isConnected) close(); });
            observer.observe(document.body, { childList: true });
            return true;
        }
    };
    sessions.set(document, session);
    const outside = event => { if (!surface?.contains(event.target)) close(); };
    // Capture outside gestures before another surface stops their propagation.
    for (const type of ['pointerdown', 'click', 'contextmenu']) listen(document, type, outside, true);
    listen(document, 'keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); close(); onEscape(); }
    }, true);
    // Non-capturing window blur excludes ordinary focus moves between controls.
    listen(view, 'blur', event => { if (event.target === event.currentTarget) close(); });
    listen(view, 'pagehide', close);
    listen(document, 'visibilitychange', () => { if (document.hidden || document.visibilityState === 'hidden') close(); });
    if (document.hidden || document.visibilityState === 'hidden') close();
    return session;
}
