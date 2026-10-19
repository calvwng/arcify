import { assertNotNativeSplit } from './native-split-safety.js';

const live = source => source && ['live', 'bookmark', 'saved', 'native'].includes(source.kind)
    && Number.isSafeInteger(source.tabId) && source.tabId > 0;
const changed = () => new Error('The dragged tab or selection changed. Drag it again.');

// Local row provenance comes from the existing drag controller, never transfer
// text. Native identity/Split/ownership is checked again by the shared writer.
export function createNewTabWindowDrop({ button, getContext, inspectSource, validateSelection = () => true,
    getTab, sendRequest, settle = async () => {}, showStatus = () => {}, begin = () => {}, end = () => {},
    refresh = async () => {}, clearFeedback = () => {}, consumeDrag = () => {} }) {
    const document = button.ownerDocument, view = document.defaultView;
    const label = button.querySelector('[data-new-tab-label]');
    const normalTitle = button.title, normalLabel = button.getAttribute('aria-label');
    let drag = null, generation = 0, pending = null, suppressClick = false, wanted = false;
    function paint(active = false, hovered = false) {
        if (active) button.dataset.windowDrag = 'eligible'; else delete button.dataset.windowDrag;
        button.classList.toggle('new-tab-window-hover', Boolean(active && hovered));
        if (label) label.textContent = active ? 'Move to new window' : 'New Tab';
        button.setAttribute('aria-label', active ? 'Move to new window' : normalLabel);
        button.title = active ? 'Move this live tab to a new window' : normalTitle;
    }
    function clear() { if (drag) suppressClick = true; generation++; drag = null; wanted = false; paint(); }
    function valid(source) {
        const element = source?.element, context = getContext();
        if (!live(source) || !element?.isConnected || element.matches('.folder') || !validateSelection(source)
            || Number(element.dataset.tabId) !== source.tabId || context.windowId !== source.windowId
            || (element.dataset.bookmarkId || null) !== (source.bookmarkId || null)
            || (element.dataset.favoriteId || null) !== (source.favoriteId || null)
            || button.hidden || !button.closest('.space.active') || button.closest('.space').dataset.spaceId !== context.spaceId) return false;
        if (['saved', 'native'].includes(source.kind)) return element.parentElement?.id === 'pinnedFavicons';
        return source.spaceId === context.spaceId && source.bookmarkFolderId === context.bookmarkFolderId
            && element.closest('.space')?.dataset.spaceId === source.spaceId
            && (!source.bookmarkId || (element.parentElement?.closest('.folder')?.dataset.bookmarkId || context.bookmarkFolderId) === source.parentId);
    }
    function stillDragging(source) {
        const current = inspectSource()?.source;
        return current?.element === source.element && current.tabId === source.tabId && valid(source);
    }
    async function start() {
        clear(); suppressClick = false;
        if (pending || button.disabled || button.getAttribute('aria-busy') === 'true') return;
        const source = inspectSource()?.source;
        if (!valid(source)) return;
        const token = generation, snapshot = Object.freeze({ ...source });
        drag = { source: snapshot, eligible: false }; wanted = true;
        try {
            const tab = await getTab(snapshot.tabId);
            assertNotNativeSplit(tab);
            if (token !== generation || !stillDragging(snapshot) || tab.id !== snapshot.tabId || tab.windowId !== snapshot.windowId || tab.incognito) return;
            drag.eligible = true; paint(wanted, button.classList.contains('new-tab-window-hover'));
        } catch { if (token === generation) clear(); }
    }
    function over(event) {
        event.stopPropagation(); suppressClick = true; clearFeedback();
        wanted = true;
        const allowed = !pending && drag?.eligible && stillDragging(drag.source);
        if (event.dataTransfer) event.dataTransfer.dropEffect = allowed ? 'move' : 'none';
        // Reject even invalid row drops locally; do not let a sortable ancestor
        // reinterpret the New Tab button as an ordering destination.
        event.preventDefault(); paint(allowed, allowed);
    }
    function leave(event) {
        if (button.contains(event.relatedTarget)) return;
        wanted = false; paint();
    }
    function drop(event) {
        event.preventDefault(); event.stopImmediatePropagation(); clearFeedback(); suppressClick = true;
        const source = drag?.source;
        if (pending || !drag?.eligible || !stillDragging(source)) { clear(); showStatus('Select one live tab outside Split View, then drag it again.'); return; }
        const request = { type: 'moveTabToNewWindow', windowId: source.windowId, tabId: source.tabId,
            ...(['saved', 'native'].includes(source.kind) ? (source.favoriteId ? { favoriteId: source.favoriteId } : {})
                : { spaceId: source.spaceId, bookmarkFolderId: source.bookmarkFolderId,
                    ...(source.bookmarkId ? { bookmarkId: source.bookmarkId, parentId: source.parentId } : {}) }) };
        // Consume synchronously, before native dragend clears transient state.
        // Validation after awaits uses the frozen identity, not .dragging.
        clear(); consumeDrag(); begin();
        button.setAttribute('aria-busy', 'true'); button.setAttribute('aria-disabled', 'true');
        pending = Promise.resolve().then(async () => {
            await settle();
            if (!valid(source)) throw changed();
            const tab = await getTab(source.tabId); assertNotNativeSplit(tab);
            if (!valid(source) || tab.id !== source.tabId || tab.windowId !== source.windowId || tab.incognito) throw changed();
            const result = await sendRequest(request);
            if (!result?.success) throw new Error(result?.error || 'Move not confirmed. Check your windows before trying again.');
            showStatus('Tab moved to a new window. Saved pins and Favorites are kept.');
        }).catch(error => showStatus(error.message)).finally(async () => {
            pending = null; button.setAttribute('aria-busy', 'false'); button.setAttribute('aria-disabled', 'false'); paint(); end();
            try { await refresh(); } catch { showStatus('Refresh the sidebar before trying another action.'); }
        });
        return pending;
    }
    button.addEventListener('dragenter', over); button.addEventListener('dragover', over);
    button.addEventListener('dragleave', leave); button.addEventListener('drop', drop);
    // Native drops can be followed by a click. Only a new real pointer/key
    // gesture re-enables normal New Tab activation; no timeout can create a page.
    button.addEventListener('click', event => {
        if (drag || pending || suppressClick) { event.preventDefault(); event.stopImmediatePropagation(); }
    }, true);
    button.addEventListener('pointerdown', () => { if (!drag && !pending) suppressClick = false; }, true);
    button.addEventListener('keydown', event => { if (!drag && !pending && ['Enter', ' '].includes(event.key)) suppressClick = false; }, true);
    document.addEventListener('dragover', event => { if (button.contains(event.target)) suppressClick = true; else { wanted = false; paint(); } }, true);
    document.addEventListener('drop', event => { if (!button.contains(event.target)) clear(); }, true);
    document.addEventListener('dragend', clear, true);
    document.addEventListener('keydown', event => { if (event.key === 'Escape') clear(); }, true);
    view.addEventListener('blur', clear); view.addEventListener('pagehide', clear);
    document.addEventListener('visibilitychange', () => { if (document.hidden) clear(); });
    return { start, clear, get pending() { return pending; } };
}
