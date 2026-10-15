// One persistent native button lives just above the active Space's sortable Today
// rows. Moving it never replaces its listener, pending request, or focus identity.
export function placeNewTabRow(button, space, { restoreFocus } = {}) {
    if (!button) return;
    const document = button.ownerDocument;
    const focused = restoreFocus ?? (document.activeElement === button && document.hasFocus?.() !== false);
    const header = space?.querySelector('.temporary-tabs > .temp-header');
    if (!header) { button.hidden = true; return; }
    if (header.nextElementSibling !== button) header.after(button);
    button.hidden = false;
    if (focused && document.hasFocus?.() !== false &&
        (!document.activeElement || document.activeElement === document.body || document.activeElement === button)) {
        button.focus({ preventScroll: true });
    }
}

export function createSidebarNewTabRow({ button, status, getContext, sendRequest }) {
    let pending = null;
    function launch() {
        if (pending) return pending;
        const { windowId, spaceId } = getContext();
        if (!Number.isSafeInteger(windowId) || windowId <= 0 || typeof spaceId !== 'string' || !spaceId) {
            status.textContent = 'Wait for this Space to finish loading, then try New Tab again.';
            return Promise.resolve();
        }
        button.setAttribute('aria-busy', 'true');
        button.setAttribute('aria-disabled', 'true');
        status.textContent = 'Opening Spotlight…';
        // Snapshot before any await. A newer Space/window never becomes the target
        // of this gesture, and a lost worker response never triggers a UI fallback.
        pending = Promise.resolve().then(() => sendRequest({ type: 'spotlightBridgeLaunch', windowId, spaceId, fallbackToNewTab: true }))
            .then(response => {
                if (!response?.ok) throw new Error(response?.error?.message || 'The New Tab result could not be confirmed. Check your tabs before trying again.');
                status.textContent = response.outcome === 'new-tab'
                    ? 'Opened a new tab. Spotlight is unavailable.' : 'Spotlight opened.';
            }).catch(error => { status.textContent = error.message || 'The New Tab result could not be confirmed. Check your tabs before trying again.'; })
            .finally(() => {
                pending = null;
                button.setAttribute('aria-busy', 'false');
                button.setAttribute('aria-disabled', 'false');
            });
        return pending;
    }
    button.addEventListener('click', launch);
    return { launch };
}
