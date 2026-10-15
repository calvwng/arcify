// Refreshing rows is not navigation. Keep the visible management anchor and
// keyboard control when the same Space is repainted or a row is removed.
const ROW = '.tab, .folder';
const CONTROLS = ['.tab-close, .tab-remove', '.folder-toggle', '.tab-title-input', '.folder-name-input'];
const rowRect = row => (row.classList.contains('folder') ? row.querySelector('.folder-header') || row : row).getBoundingClientRect();
const identity = row => row?.classList.contains('folder') ? `folder:${row.dataset.bookmarkId}` :
    row?.dataset.bookmarkId ? `bookmark:${row.dataset.bookmarkId}` :
    row?.dataset.tabId ? `tab:${row.dataset.tabId}` : null;
const visibleRows = content => [...content.querySelectorAll(ROW)].filter(row => {
    for (let node = row; node && node !== content; node = node.parentElement) {
        if (node.hidden || node.matches('.folder-content.collapsed, .pinned-tabs.collapsed') ||
            (node.matches('.folder-collapsed-tabs') && !node.parentElement.classList.contains('collapsed'))) return false;
    }
    return rowRect(row).height > 0;
});

// Capture immediately before a synchronous DOM mutation, after any awaits, so
// intervening scrolling or focus changes always win over an older snapshot.
export function captureSidebarViewport(content) {
    if (!content?.isConnected) return () => {};
    const document = content.ownerDocument;
    const top = content.getBoundingClientRect().top;
    const bottom = content.getBoundingClientRect().bottom;
    const scrollTop = content.scrollTop;
    const rows = visibleRows(content);
    const anchors = rows.filter(row => {
        const rect = rowRect(row);
        return rect.bottom > top && rect.top < bottom;
    }).map(row => ({ id: identity(row), offset: rowRect(row).top - top })).filter(row => row.id);
    const focused = document.activeElement;
    const focusRow = content.contains(focused) ? focused.closest(ROW) : null;
    const focusIndex = rows.indexOf(focusRow);
    const focusControl = CONTROLS.find(selector => focused?.matches(selector));
    // Only restore known row controls or the row itself. Editors are protected
    // by the caller's edit-session guard; unrelated UI must never gain focus.
    const restoreFocus = focusIndex >= 0 && (focused === focusRow || focusControl);
    const focusCandidates = restoreFocus ? [focusRow, ...rows.slice(focusIndex + 1), ...rows.slice(0, focusIndex).reverse()].map(identity) : [];
    return () => {
        if (!content.isConnected) return;
        const currentRows = visibleRows(content);
        const byId = new Map(currentRows.map(row => [identity(row), row]));
        if (restoreFocus && !focused.isConnected && (!document.activeElement || document.activeElement === document.body || document.activeElement === focused)) {
            const target = focusCandidates.map(id => {
                const row = byId.get(id);
                if (!row) return null;
                if (!focusControl) return row;
                // A folder's descendant close button belongs to a different
                // row (and may be hidden). Continue to the next visible row.
                const control = row.querySelector(focusControl);
                return control?.closest(ROW) === row ? control : null;
            }).find(Boolean);
            target?.focus({ preventScroll: true });
        }
        const anchor = anchors.find(candidate => byId.has(candidate.id));
        const target = anchor ? content.scrollTop + rowRect(byId.get(anchor.id)).top -
            content.getBoundingClientRect().top - anchor.offset : scrollTop;
        // The content may have become shorter. Clamp once to its actual extent;
        // never bounce to the active tab or to an obsolete bottom offset.
        const max = Math.max(0, content.scrollHeight - content.clientHeight);
        content.scrollTop = Math.min(max, Math.max(0, target));
    };
}

// Reveal is an explicit, short-lived navigation intent, never a side effect of
// applying an active highlight or receiving a loading/bookmark/storage update.
export function createActiveTabReveal({ getContext, schedule = callback => setTimeout(callback, 0) }) {
    let pending = null;
    function flush() {
        const intent = pending;
        if (!intent) return;
        schedule(() => {
            if (pending !== intent) return;
            const { tabId, spaceId, content } = getContext();
            if (tabId !== intent.tabId || spaceId !== intent.spaceId) { pending = null; return; }
            if (!content?.isConnected || content.closest('.space')?.style.display === 'none') return;
            const row = [...content.querySelectorAll('.tab[data-tab-id]')].find(row => row.dataset.tabId === String(tabId));
            // Activation may precede membership adoption or the initial row
            // render. Keep that intent until the relevant view actually exists.
            if (!row) return;
            // A deliberately hidden existing row is not a delayed render.
            // Consume the intent so expanding its folder later cannot revive
            // an old activation during ordinary bookmark management.
            if (!visibleRows(content).includes(row)) { pending = null; return; }
            const rect = row.getBoundingClientRect(), viewport = content.getBoundingClientRect();
            if (rect.top < viewport.top || rect.bottom > viewport.bottom) {
                content.scrollTop += rect.top - viewport.top;
            }
            pending = null;
        });
    }
    return {
        request(tabId) { pending = { tabId, spaceId: getContext().spaceId }; flush(); },
        flush
    };
}
