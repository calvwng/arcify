export const MAX_TODAY_SELECTION = 100;
const ROW = '.tab[data-tab-id]:not([data-bookmark-id])';
const CONTROL = 'button, input, textarea, select, a, [contenteditable="true"], [role="button"]';
const modifiers = event => event.ctrlKey || event.metaKey || event.shiftKey;
const sameContext = (a, b) => a && b && ['windowId', 'spaceId', 'bookmarkFolderId', 'inverted'].every(key => a[key] === b[key]);
const same = (a, b) => a && b && a.tabId === b.tabId && a.url === b.url;

// Today and pinned bookmarks have different identities and actions. A gesture
// in either section ends the other selection; ranges never cross that boundary.
export function createTodayTabSelection({ document, getContext, onGesture = () => {} }) {
    const registered = new WeakMap();
    let selected = new Map(), anchor = null, scope = null, revision = 0, interaction = 0;
    let activationAnchorPending = false;
    const status = document.createElement('div');
    status.id = 'todaySelectionStatus'; status.className = 'bookmark-selection-status';
    status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    status.hidden = true;
    document.querySelector('.new-tab-btn-container').append(status);

    function context() {
        const value = getContext(), space = value.spaces.find(item => item.id === value.activeSpaceId);
        const element = [...document.querySelectorAll('#spacesList .space')].find(row => row.dataset.spaceId === space?.id);
        return { windowId: value.windowId, spaceId: space?.id, bookmarkFolderId: space?.bookmarkFolderId,
            inverted: element?.querySelector('[data-tab-type="temporary"]')?.dataset.todayOrderInverted === 'true' };
    }
    function descriptor(element, current) {
        const tabId = Number(element.dataset.tabId), value = getContext();
        const space = value.spaces.find(item => item.id === current.spaceId);
        if (registered.get(element) !== tabId || !element.isConnected || !Number.isInteger(tabId) || tabId < 0 ||
            !Number.isInteger(current.windowId) || !current.spaceId || !current.bookmarkFolderId ||
            !document.getElementById('spacesList').contains(element) ||
            element.closest('.space')?.dataset.spaceId !== current.spaceId ||
            !element.closest('[data-tab-type="temporary"]') || element.dataset.bookmarkId || element.closest('.favorite-fallback') ||
            !space?.temporaryTabs?.includes(tabId) || space.spaceBookmarks?.includes(tabId) ||
            value.spaces.filter(item => [...(item.temporaryTabs || []), ...(item.spaceBookmarks || [])].includes(tabId)).length !== 1) return null;
        for (let node = element; node && node.id !== 'spacesList'; node = node.parentElement) {
            if (node.hidden || node.classList.contains('hidden') || node.classList.contains('collapsed')) return null;
            const style = document.defaultView.getComputedStyle?.(node);
            if (style?.display === 'none' || style?.visibility === 'hidden') return null;
        }
        return { element, tabId, url: element.dataset.url };
    }
    function visible(current = context()) {
        const entries = [...document.querySelectorAll(`#spacesList ${ROW}`)].map(row => descriptor(row, current)).filter(Boolean);
        return entries.filter(entry => entries.filter(item => item.tabId === entry.tabId).length === 1);
    }
    function paint() {
        for (const row of document.querySelectorAll(`#spacesList ${ROW}`)) {
            const on = selected.get(Number(row.dataset.tabId))?.element === row;
            row.classList.toggle('today-selected', on);
            if (registered.has(row)) row.setAttribute('aria-selected', String(on));
        }
        status.hidden = !selected.size; status.dataset.count = String(selected.size);
        status.textContent = selected.size > MAX_TODAY_SELECTION
            ? `${selected.size} Today tabs selected. Select at most ${MAX_TODAY_SELECTION} for one action.`
            : selected.size ? `${selected.size} Today tab${selected.size === 1 ? '' : 's'} selected. Right-click for actions. Escape clears selection.` : '';
    }
    function clear({ keepAnchor = false } = {}) {
        interaction++;
        if (selected.size || (!keepAnchor && anchor)) revision++;
        selected.clear(); if (!keepAnchor) { anchor = null; scope = null; activationAnchorPending = false; }
        paint();
    }
    function reconcile() {
        const current = context(), entries = visible(current);
        if (!sameContext(scope, current)) { clear(); scope = current; }
        let changed = false;
        for (const [id, old] of selected) {
            const next = entries.find(item => item.tabId === id);
            if (!same(old, next)) { selected.delete(id); changed = true; }
            else if (old.element !== next.element) { selected.set(id, next); changed = true; }
        }
        if (anchor) {
            const next = entries.find(item => item.tabId === anchor.tabId);
            if (!same(anchor, next)) { anchor = null; activationAnchorPending = false; changed = true; }
            else anchor = next;
        }
        if (changed) { revision++; paint(); }
        return entries;
    }
    function select(element, event, extendActivation = false) {
        const entries = reconcile(), index = entries.findIndex(item => item.element === element);
        if (index < 0) return false;
        onGesture();
        const entry = entries[index], additive = event.ctrlKey || event.metaKey;
        // A plain activation is the first row of a subsequent Ctrl/Cmd-click
        // batch. Consume this once; toggling the batch empty must not resurrect it.
        if (extendActivation && additive && !event.shiftKey && activationAnchorPending && anchor && anchor.tabId !== entry.tabId) {
            selected.set(anchor.tabId, anchor);
        }
        activationAnchorPending = false;
        if (event.shiftKey) {
            const start = entries.findIndex(item => item.tabId === anchor?.tabId);
            if (!additive) selected.clear();
            for (const item of entries.slice(start < 0 ? index : Math.min(start, index), start < 0 ? index + 1 : Math.max(start, index) + 1)) selected.set(item.tabId, item);
            if (start < 0) anchor = entry;
        } else {
            if (!additive) selected.clear();
            if (additive && selected.has(entry.tabId)) selected.delete(entry.tabId);
            else selected.set(entry.tabId, entry);
            anchor = entry;
        }
        interaction++; revision++; paint(); return true;
    }
    function register(element) {
        const tabId = Number(element.dataset.tabId);
        if (registered.has(element) || !Number.isInteger(tabId) || element.dataset.bookmarkId) return;
        registered.set(element, tabId);
        element.setAttribute('role', 'treeitem'); element.setAttribute('aria-selected', 'false'); element.tabIndex = 0;
        element.addEventListener('click', event => {
            if (event.target.closest(CONTROL) || (event.button ?? 0) !== 0) { clear(); return; }
            if (modifiers(event)) {
                event.preventDefault(); event.stopImmediatePropagation(); select(element, event, true);
            } else {
                const entry = reconcile().find(item => item.element === element);
                clear(); onGesture();
                if (entry) { scope = context(); anchor = entry; activationAnchorPending = true; revision++; }
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
        const entries = reconcile(), entry = entries.find(item => item.element === element);
        if (!entry) { clear(); return null; }
        activationAnchorPending = false;
        onGesture(); interaction++;
        if (!selected.has(entry.tabId)) { selected = new Map([[entry.tabId, entry]]); anchor = entry; revision++; paint(); }
        if (selected.size > MAX_TODAY_SELECTION) return { error: `Select at most ${MAX_TODAY_SELECTION} Today tabs. No action was taken.` };
        return Object.freeze({ ...scope, revision,
            visibleEntries: Object.freeze(entries.map(item => Object.freeze({ ...item }))),
            entries: Object.freeze(entries.filter(item => selected.has(item.tabId)).map(item => Object.freeze({ ...item }))) });
    }
    function validate(snapshot) {
        if (!snapshot || snapshot.revision !== revision || !sameContext(snapshot, context())) return false;
        const entries = visible();
        return entries.length === snapshot.visibleEntries.length && entries.every((item, index) =>
            same(item, snapshot.visibleEntries[index]) && item.element === snapshot.visibleEntries[index].element);
    }
    function captureActivation() {
        const started = interaction;
        return () => { if (started === interaction) { clear({ keepAnchor: true }); reconcile(); } };
    }
    document.addEventListener('click', event => {
        if (event.target.closest?.('#tab-context-menu, #todayFolderDialog, #todayRecoveryDialog, #favoritesDropNotice')) return;
        const row = event.target.closest?.(ROW);
        if (!row || !descriptor(row, context())) clear();
    }, true);
    // Capture phase also handles the other section's modifier handlers, which
    // intentionally stop propagation before bubble listeners can see the click.
    document.addEventListener('keydown', event => { if (event.key === 'Escape') clear(); }, true);
    document.defaultView.addEventListener('blur', () => clear({ keepAnchor: true }));
    const Observer = document.defaultView.MutationObserver;
    if (Observer) new Observer(reconcile).observe(document.getElementById('spacesList'), {
        subtree: true, childList: true, attributes: true,
        attributeFilter: ['class', 'hidden', 'style', 'data-tab-id', 'data-bookmark-id', 'data-url', 'data-space-id', 'data-today-order-inverted']
    });
    return { register, clear, reconcile, freeze, validate, captureActivation,
        isSelected: element => { reconcile(); return selected.get(Number(element.dataset.tabId))?.element === element; },
        isBatch: () => { reconcile(); return selected.size > 1; } };
}
