export const MAX_BOOKMARK_SELECTION = 100;
const ROW = '.tab[data-bookmark-id]';
const CONTROL = 'button, input, textarea, select, a, [contenteditable="true"], [role="button"]';
const modifiers = event => event.shiftKey || event.ctrlKey || event.metaKey;
const same = (a, b) => a && b && ['element', 'bookmarkId', 'parentId', 'tabId', 'url', 'pinnedUrl'].every(key => a[key] === b[key]);
const sameBookmark = (a, b) => a && b && a.bookmarkId === b.bookmarkId && a.parentId === b.parentId &&
    (a.pinnedUrl || a.url) === (b.pinnedUrl || b.url);
const sameContext = (a, b) => a && b && ['windowId', 'spaceId', 'bookmarkFolderId'].every(key => a[key] === b[key]);

// Selection is local UI state. Only registered bookmark rows in the active
// Space participate; neither CSS classes nor transfer text create authority.
export function createBookmarkSelection({ document, getContext }) {
    const registered = new WeakMap();
    let selected = new Map(), anchor = null, scope = null, view = [], revision = 0, interaction = 0, image = null;
    const status = document.createElement('div');
    status.id = 'bookmarkSelectionStatus'; status.className = 'bookmark-selection-status';
    status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); status.setAttribute('aria-atomic', 'true');
    status.hidden = true; status.dataset.count = '0';
    // Showing a singleton count during dragstart must not move the source while
    // Chrome captures its native drag image. Keep this badge outside list flow.
    document.querySelector('.new-tab-btn-container').append(status);

    function context() {
        const value = getContext(), space = value.spaces.find(item => item.id === value.activeSpaceId);
        return { windowId: value.windowId, spaceId: space?.id, bookmarkFolderId: space?.bookmarkFolderId };
    }
    function descriptor(element, current = context()) {
        if (!element?.isConnected || registered.get(element) !== element.dataset.bookmarkId ||
            !current.spaceId || !current.bookmarkFolderId || !Number.isInteger(current.windowId) ||
            !document.getElementById('spacesList').contains(element) ||
            element.closest('.space')?.dataset.spaceId !== current.spaceId ||
            !element.closest('[data-tab-type="pinned"]') || element.closest('.favorite-fallback') ||
            element.closest('.space')?.dataset.bookmarkTreeUnavailable === 'true') return null;
        for (let node = element; node && node.id !== 'spacesList'; node = node.parentElement) {
            if (node.hidden || node.classList.contains('hidden') || node.matches('.folder-content.collapsed, .pinned-tabs.collapsed') ||
                (node.matches('.folder-collapsed-tabs') && !node.parentElement.classList.contains('collapsed'))) return null;
            const style = document.defaultView.getComputedStyle?.(node);
            if (style?.display === 'none' || style?.visibility === 'hidden') return null;
        }
        const rawTabId = element.dataset.tabId;
        const tabId = rawTabId === undefined ? null : Number(rawTabId);
        if (tabId !== null && (!Number.isInteger(tabId) || tabId < 0)) return null;
        return { element, bookmarkId: element.dataset.bookmarkId,
            parentId: element.parentElement.closest('.folder')?.dataset.bookmarkId || current.bookmarkFolderId,
            tabId, url: element.dataset.url, pinnedUrl: element.dataset.pinnedUrl };
    }
    function visible(current = context()) {
        const entries = [...document.querySelectorAll(`#spacesList ${ROW}`)].map(row => descriptor(row, current)).filter(Boolean);
        // Ambiguous duplicate DOM identities are never silently deduplicated.
        const counts = new Map();
        for (const entry of entries) counts.set(entry.bookmarkId, (counts.get(entry.bookmarkId) || 0) + 1);
        return entries.filter(entry => counts.get(entry.bookmarkId) === 1);
    }
    function paint() {
        for (const row of document.querySelectorAll(`#spacesList ${ROW}`)) {
            const on = selected.get(row.dataset.bookmarkId)?.element === row;
            row.classList.toggle('bookmark-selected', on);
            if (registered.has(row)) row.setAttribute('aria-selected', String(on));
        }
        status.dataset.count = String(selected.size); status.hidden = !selected.size;
        status.textContent = selected.size > MAX_BOOKMARK_SELECTION
            ? `${selected.size} bookmarks selected. Select at most ${MAX_BOOKMARK_SELECTION} for one Favorites drop.`
            : selected.size ? `${selected.size} bookmark${selected.size === 1 ? '' : 's'} selected. Drag to Favorites. Escape clears selection.` : '';
    }
    function clear() {
        interaction++;
        if (selected.size || anchor) revision++;
        selected.clear(); anchor = null; scope = null; paint();
    }
    function clearForActivation() {
        // Activation/blur clears the batch, but a still-visible exact saved
        // bookmark may remain the logical range anchor.
        if (selected.size) revision++;
        selected.clear(); paint();
    }
    function reconcile() {
        const current = context(), entries = visible(current);
        if (!sameContext(scope, current)) { clear(); scope = current; }
        let changed = view.length !== entries.length || entries.some((entry, index) => !same(entry, view[index]));
        view = entries;
        for (const [id, value] of selected) {
            const next = entries.find(entry => entry.bookmarkId === id);
            // UI selection belongs to an exact saved bookmark, not its current
            // DOM row or live tab. Only registered, visible rows in this context
            // can replace it. Every strict descriptor change still invalidates
            // a frozen drag through the revision and immutable view comparison.
            if (!sameBookmark(value, next)) { selected.delete(id); changed = true; }
            else if (!same(value, next)) { selected.set(id, next); changed = true; }
        }
        if (anchor) {
            const nextAnchor = entries.find(entry => entry.bookmarkId === anchor.bookmarkId);
            if (!sameBookmark(anchor, nextAnchor)) { anchor = null; changed = true; }
            else anchor = nextAnchor;
        }
        if (changed) { revision++; paint(); }
        return entries;
    }
    function select(element, event) {
        const entries = reconcile(), index = entries.findIndex(entry => entry.element === element);
        if (index < 0) return false;
        const entry = entries[index], additive = event.ctrlKey || event.metaKey;
        if (event.shiftKey) {
            const start = entries.findIndex(item => item.bookmarkId === anchor?.bookmarkId);
            if (!additive) selected.clear();
            for (const item of entries.slice(start < 0 ? index : Math.min(start, index), start < 0 ? index + 1 : Math.max(start, index) + 1)) selected.set(item.bookmarkId, item);
            if (start < 0) anchor = entry;
        } else {
            if (!additive) selected.clear();
            if (additive && selected.has(entry.bookmarkId)) selected.delete(entry.bookmarkId);
            else selected.set(entry.bookmarkId, entry);
            anchor = entry;
        }
        interaction++; revision++; paint(); return true;
    }
    function register(element) {
        if (!element.dataset.bookmarkId || registered.has(element)) return;
        registered.set(element, element.dataset.bookmarkId);
        element.setAttribute('role', 'treeitem'); element.setAttribute('aria-selected', 'false'); element.tabIndex = 0;
        element.addEventListener('click', event => {
            if (event.target.closest(CONTROL)) { clear(); return; }
            if ((event.button ?? 0) !== 0) { clear(); return; }
            if (modifiers(event)) {
                // Even an unavailable/hidden row must not activate on a modifier.
                event.preventDefault(); event.stopImmediatePropagation(); select(element, event);
            } else {
                const entry = reconcile().find(item => item.element === element);
                clear();
                // Ordinary activation clears the batch but establishes the
                // familiar Shift anchor for as long as this exact view survives.
                if (entry) { scope = context(); anchor = entry; revision++; }
            }
        }, true);
        element.addEventListener('dblclick', event => {
            if (modifiers(event) && !event.target.closest(CONTROL)) { event.preventDefault(); event.stopImmediatePropagation(); }
        }, true);
        element.addEventListener('keydown', event => {
            if (event.target !== element || event.isComposing || event.repeat) return;
            if (event.key === ' ') { event.preventDefault(); event.stopPropagation(); select(element, { shiftKey: event.shiftKey, ctrlKey: true }); }
            else if (event.key === 'Enter' && !modifiers(event) && !event.altKey) { event.preventDefault(); element.click(); }
        });
    }
    function freeze(element) {
        interaction++;
        const entries = reconcile(), entry = entries.find(item => item.element === element);
        if (!entry) { clear(); return null; }
        if (!selected.has(entry.bookmarkId)) { selected = new Map([[entry.bookmarkId, entry]]); anchor = entry; revision++; paint(); }
        if (selected.size > MAX_BOOKMARK_SELECTION) return { error: `Select at most ${MAX_BOOKMARK_SELECTION} bookmarks for one Favorites drop. Nothing was added.` };
        const visibleEntries = Object.freeze(entries.map(item => Object.freeze({ ...item })));
        return Object.freeze({ ...scope, revision, visibleEntries,
            entries: Object.freeze(visibleEntries.filter(item => selected.has(item.bookmarkId))) });
    }
    function validate(snapshot) {
        if (!snapshot || snapshot.revision !== revision || !sameContext(snapshot, context())) return false;
        const entries = visible();
        if (entries.length !== snapshot.visibleEntries.length || entries.some((entry, index) => !same(entry, snapshot.visibleEntries[index]))) return false;
        const selectedEntries = entries.filter(entry => selected.has(entry.bookmarkId));
        return selectedEntries.length === snapshot.entries.length && selectedEntries.every((entry, index) => same(entry, snapshot.entries[index]));
    }
    function dragImage(event, count) {
        image?.remove(); image = null;
        if (count < 2 || !event.dataTransfer?.setDragImage) return;
        image = document.createElement('div'); image.className = 'bookmark-drag-preview'; image.dataset.count = String(count);
        image.textContent = `${count} bookmarks → Favorites`; image.setAttribute('aria-hidden', 'true');
        document.body.append(image); event.dataTransfer.setDragImage(image, 20, 20);
    }
    function clearDragImage() { image?.remove(); image = null; }
    function onActivation() { clearForActivation(); reconcile(); }
    function captureActivation() {
        const started = interaction;
        // Browser ownership is checked by the caller before completion. An
        // asynchronous activation must not clear a newer user gesture, while
        // a harmless render alone must not suppress the activation clear.
        return () => { if (started === interaction) onActivation(); };
    }
    document.addEventListener('click', event => {
        if (!event.target.closest?.(ROW)) clear();
    }, true);
    document.addEventListener('keydown', event => { if (event.key === 'Escape') clear(); }, true);
    document.defaultView.addEventListener('blur', () => { onActivation(); clearDragImage(); });
    document.addEventListener('dragend', clearDragImage, true);
    // Row deletion, projection, navigation and outside refreshes can happen
    // without a click. Prune UI state, invalidating (never shrinking) a frozen
    // drag through its revision and immutable descriptor comparison.
    const Observer = document.defaultView.MutationObserver;
    if (Observer) new Observer(reconcile).observe(document.getElementById('spacesList'), {
        subtree: true, childList: true, attributes: true,
        attributeFilter: ['class', 'hidden', 'style', 'data-bookmark-id', 'data-tab-id', 'data-url', 'data-pinned-url', 'data-space-id', 'data-bookmark-tree-unavailable']
    });
    return { register, clear, reconcile, freeze, validate, dragImage, clearDragImage, onActivation, captureActivation };
}
