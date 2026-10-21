// Presentation follows the existing row action: a live tab closes without
// deleting its pin; a bookmark-only row removes its exact saved bookmark.
export function getTabRowAction({ isPinned = false, isBookmarkOnly = false } = {}) {
    if (isBookmarkOnly) return { className: 'tab-remove', glyph: '×', label: 'Remove Pin (delete bookmark)' };
    if (isPinned) return { className: 'tab-close', glyph: '−', label: 'Close Tab (keep pin)' };
    return { className: 'tab-close', glyph: '×', label: 'Close Tab' };
}
