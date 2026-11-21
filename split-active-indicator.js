// Separate visual/accessibility state: .active and splitLive have other
// callers and may influence tab operations, menus, or Today representation.
export function applyActiveLinkedSplitIndicator(root, bookmarkId) {
    for (const row of root.querySelectorAll('.split-pin-current')) {
        row.classList.remove('split-pin-current');
        row.removeAttribute('aria-current');
    }
    if (typeof bookmarkId !== 'string' || !bookmarkId) return;
    const rows = [...root.querySelectorAll('.split-pin.bookmark-only')]
        .filter(row => row.dataset.bookmarkId === bookmarkId && row.dataset.splitLive === 'false');
    if (rows.length !== 1) return;
    rows[0].classList.add('split-pin-current');
    rows[0].setAttribute('aria-current','true');
}

export function linkedSplitBookmarkForPane(indicators, paneId) {
    if (!Number.isSafeInteger(paneId) || paneId <= 0 || !Array.isArray(indicators)) return null;
    const matches = indicators.filter(indicator => Array.isArray(indicator?.paneIds) && indicator.paneIds.includes(paneId));
    return matches.length === 1 ? matches[0].bookmarkId : null;
}

// A last-tab bookkeeping write is not a membership change. Unknown storage
// shapes expire the decoration rather than being read as settled.
export function sameSplitDisplayMembership({oldValue,newValue} = {}) {
    if (!Array.isArray(oldValue) || !Array.isArray(newValue)) return false;
    const project = spaces => spaces.map(space => [space?.id, space?.bookmarkFolderId, space?.temporaryTabs, space?.spaceBookmarks]);
    return JSON.stringify(project(oldValue)) === JSON.stringify(project(newValue));
}
