export async function sharedTodayRequest(action, payload) {
    let timer;
    try {
        const response = await Promise.race([chrome.runtime.sendMessage({ type: 'arcifySharedToday', action, ...payload }),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Today request was not confirmed. Check the owning window; nothing was retried.')), 10000); })]);
        if (!response?.success) throw new Error(response?.error || 'Shared Today is unavailable. Refresh the list.');
        return response;
    } finally { clearTimeout(timer); }
}

// Deliberately not a .tab: local selection, drag, menus, editors and close buttons
// must never treat a foreign-window page as a local actionable row.
export function createRemoteTodayRow(document, row, { windowId, request = sharedTodayRequest, onError = () => {} }) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'shared-today-remote'; button.draggable = false;
    button.textContent = `${row.title || row.url || 'Untitled page'} — Window ${row.windowId} · Open in owning window`;
    button.title = 'Open the existing page in its owning window';
    let pending = false;
    for (const name of ['contextmenu', 'dragstart', 'dblclick']) button.addEventListener(name, event => { event.preventDefault(); event.stopPropagation(); });
    button.addEventListener('click', async event => {
        event.preventDefault(); event.stopPropagation();
        if (!event.isTrusted || pending) return;
        pending = true; button.disabled = true;
        try { await request('open', { windowId, id: row.id, ownerWindowId: row.windowId, spaceId: row.spaceId, bookmarkFolderId: row.bookmarkFolderId }); }
        catch (error) { onError(error.message); }
        finally { pending = false; button.disabled = false; }
    });
    return button;
}
