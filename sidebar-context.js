// Resolve the native owner before importing modules with normal-session effects.
export async function startSidebar({ chrome, document, loadNormal, loadPrivate }) {
    try {
        const owner = await chrome.windows.getCurrent();
        if (!Number.isInteger(owner?.id) || owner.id < 0 || typeof owner.incognito !== 'boolean') throw new Error();
        if (owner.incognito) {
            document.body.replaceChildren();
            const { mountPrivateSidebar } = await loadPrivate();
            await mountPrivateSidebar({ chrome, document, windowId: owner.id });
        } else {
            await loadNormal();
        }
    } catch {
        // Never print native error payloads: they can contain private metadata.
        document.body.textContent = 'Sidebar unavailable. Reopen it in this window.';
    } finally {
        document.body.removeAttribute('data-sidebar-pending');
    }
}
