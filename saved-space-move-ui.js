import { appendSpaceMovePicker, todayMoveDestinations } from './today-space-move-ui.js';
import { createContextMenuSession } from './context-menu-session.js';

const STALE = 'The saved selection changed. Reopen its menu. Nothing was moved.';
const UNKNOWN = 'The move result is unknown. Check both Spaces before trying again; nothing was retried.';
const CHANGED_DESTINATION = 'The destination Space changed or was deleted. Reopen the menu. Nothing was moved.';
const same = (a, b, keys) => a && b && keys.every(key => a[key] === b[key]);

function sourceCurrent(snapshot, getContext) {
    const current = getContext(), source = current.spaces.find(space => space.id === snapshot.spaceId);
    return !current.pendingActiveSpaceId && current.windowId === snapshot.windowId && current.activeSpaceId === snapshot.spaceId &&
        source?.bookmarkFolderId === snapshot.bookmarkFolderId &&
        current.spaces.filter(space => space.id === snapshot.spaceId || space.bookmarkFolderId === snapshot.bookmarkFolderId).length === 1;
}

// A saved title/URL is read by bookmark ID, never inferred from a live tab's
// current page or alias. The strict UI snapshot remains valid across every read.
export async function captureSavedSelectionMove(snapshot, { selection, getContext, readBookmarks, readInverted, active = () => true }) {
    const valid = () => active() && selection.validate(snapshot) && sourceCurrent(snapshot, getContext);
    if (!snapshot || snapshot.error || !valid()) return null;
    const [bookmarks, inverted] = await Promise.all([
        readBookmarks(snapshot.entries.map(entry => entry.bookmarkId)), readInverted()
    ]);
    if (!valid()) return null;
    if (typeof inverted !== 'boolean' || inverted !== snapshot.inverted || !Array.isArray(bookmarks) || bookmarks.length !== snapshot.entries.length) throw new Error(STALE);
    const entries = snapshot.entries.map(entry => {
        const matches = bookmarks.filter(bookmark => bookmark.id === entry.bookmarkId), bookmark = matches[0];
        if (matches.length !== 1 || !bookmark.url || bookmark.parentId !== entry.parentId ||
            bookmark.url !== (entry.pinnedUrl || entry.url) || typeof bookmark.title !== 'string' ||
            entry.title !== undefined && bookmark.title !== entry.title) throw new Error(STALE);
        return Object.freeze({ bookmarkId: bookmark.id, parentId: bookmark.parentId, title: bookmark.title,
            url: bookmark.url, tabId: entry.tabId });
    });
    return Object.freeze({ windowId: snapshot.windowId, spaceId: snapshot.spaceId, bookmarkFolderId: snapshot.bookmarkFolderId,
        kind: 'pins', inverted, entries: Object.freeze(entries), validate: () => selection.validate(snapshot) && sourceCurrent(snapshot, getContext) });
}

// Child arrays are canonical bookmark order, including hidden/collapsed nodes.
// No DOM projection, tab URL matching or sort can silently omit/reorder a child.
export function freezeSavedMoveTree(node, seen = new Set()) {
    if (!node || typeof node.id !== 'string' || !node.id || seen.has(node.id) ||
        typeof node.parentId !== 'string' || !node.parentId || typeof node.title !== 'string' ||
        (node.url !== undefined && node.url !== null && (typeof node.url !== 'string' || !node.url))) throw new Error(STALE);
    seen.add(node.id);
    const url = node.url ?? null;
    if ((node.children !== undefined && !Array.isArray(node.children)) ||
        (url && node.children?.length) || (!url && !Array.isArray(node.children))) throw new Error(STALE);
    const children = (node.children || []).map(child => {
        if (child.parentId !== node.id) throw new Error(STALE);
        return freezeSavedMoveTree(child, seen);
    });
    return Object.freeze({ id: node.id, parentId: node.parentId, title: node.title, url, children: Object.freeze(children) });
}

function folderDescriptor(element, document, getContext) {
    const current = getContext(), space = current.spaces.find(item => item.id === current.activeSpaceId);
    if (!element?.isConnected || !element.matches('.folder[data-bookmark-id]') ||
        !document.getElementById('spacesList')?.contains(element) || !element.closest('[data-tab-type="pinned"]') ||
        element.closest('.space')?.dataset.spaceId !== space?.id || !space?.bookmarkFolderId ||
        element.closest('.space')?.dataset.bookmarkTreeUnavailable === 'true' || !Number.isInteger(current.windowId)) return null;
    if ([...document.querySelectorAll('#spacesList .folder[data-bookmark-id]')].filter(folder =>
        folder.dataset.bookmarkId === element.dataset.bookmarkId).length !== 1) return null;
    for (let node = element; node && node.id !== 'spacesList'; node = node.parentElement) {
        if (node.hidden || node.classList.contains('hidden') || node.matches('.folder-content.collapsed, .pinned-tabs.collapsed')) return null;
        const style = document.defaultView.getComputedStyle?.(node);
        if (style?.display === 'none' || style?.visibility === 'hidden') return null;
    }
    return { windowId: current.windowId, spaceId: space.id, bookmarkFolderId: space.bookmarkFolderId,
        bookmarkId: element.dataset.bookmarkId,
        parentId: element.parentElement.closest('.folder')?.dataset.bookmarkId || space.bookmarkFolderId,
        title: element.querySelector(':scope > .folder-header .folder-title')?.textContent,
        inverted: element.closest('[data-tab-type="pinned"]')?.dataset.savedOrderInverted === 'true' };
}

export async function captureSavedFolderMove(element, { document, selection, getContext, readTree, readInverted, active = () => true }) {
    const descriptor = folderDescriptor(element, document, getContext);
    const selectionCurrent = selection?.captureInteraction?.() || (() => true);
    const validate = () => selectionCurrent() && sourceCurrent(descriptor, getContext) &&
        same(descriptor, folderDescriptor(element, document, getContext), ['windowId', 'spaceId', 'bookmarkFolderId', 'bookmarkId', 'parentId', 'title', 'inverted']);
    if (!descriptor || !active() || !validate()) return null;
    const [nodes, inverted] = await Promise.all([readTree(descriptor.bookmarkId), readInverted()]);
    if (!active() || !validate()) return null;
    if (typeof inverted !== 'boolean' || inverted !== descriptor.inverted || !Array.isArray(nodes) || nodes.length !== 1) throw new Error(STALE);
    const tree = freezeSavedMoveTree(nodes[0]);
    if (tree.url !== null || tree.id !== descriptor.bookmarkId || tree.parentId !== descriptor.parentId ||
        tree.title !== descriptor.title) throw new Error(STALE);
    const entry = Object.freeze({ bookmarkId: tree.id, parentId: tree.parentId, title: tree.title, url: null, tabId: null, tree });
    return Object.freeze({ windowId: descriptor.windowId, spaceId: descriptor.spaceId, bookmarkFolderId: descriptor.bookmarkFolderId,
        kind: 'folder', inverted, entries: Object.freeze([entry]), validate });
}

export function describeSavedMoveOutcome(response, entries, destination) {
    const ids = entries.map(entry => entry.bookmarkId), batch = response?.batch;
    const validIds = list => Array.isArray(list) && new Set(list).size === list.length && list.every(id => ids.includes(id));
    if (typeof response?.success !== 'boolean' || !batch || batch.total !== ids.length ||
        batch.destinationSpaceId !== destination.id || typeof batch.uncertain !== 'boolean' ||
        !validIds(batch.completed) || !validIds(batch.remaining) ||
        batch.completed.length + batch.remaining.length !== ids.length ||
        batch.completed.some(id => batch.remaining.includes(id))) return UNKNOWN;
    const count = batch.completed.length, folder = entries.length === 1 && entries[0].url === null;
    const noun = folder ? 'folder' : 'saved pin';
    if (response.success && !batch.uncertain && count === ids.length) {
        return `Moved ${count} ${noun}${count === 1 ? '' : 's'}${folder ? ' with its saved pins' : ''} to “${destination.name}”. You’re still in the current Space.`;
    }
    if (response.success) return UNKNOWN;
    const error = typeof response.error === 'string' ? `${response.error} ` : '';
    if (!count && !batch.uncertain) return `Nothing was moved. ${error}`.trim();
    return `${count} of ${ids.length} ${noun}${ids.length === 1 ? '' : 's'} confirmed moved to “${destination.name}”. ` +
        (batch.uncertain ? 'Some moves could not be confirmed. ' : '') + error +
        'Check both Spaces before trying again; nothing was retried.';
}

export function createSavedSpaceMoveAction({ selection, getContext, readInverted, sendRequest, showStatus,
    begin = () => {}, end = () => {}, refresh = async () => {} }) {
    let pending = false;
    return snapshot => {
        if (!snapshot) return null;
        let consumed = false;
        const destinations = Object.freeze(todayMoveDestinations(getContext().spaces, snapshot.spaceId));
        const destinationCurrent = destination => destinations.includes(destination) &&
            todayMoveDestinations(getContext().spaces, snapshot.spaceId).some(item => item.id === destination.id && item.bookmarkFolderId === destination.bookmarkFolderId);
        return { count: snapshot.entries.length, kind: snapshot.kind, destinations, move: async destination => {
            if (pending || consumed) return;
            if (!snapshot.validate()) { showStatus(STALE); return; }
            if (!destinationCurrent(destination)) { showStatus(CHANGED_DESTINATION); return; }
            pending = true; begin();
            let attempted = false, lastStatus = '';
            const report = (...args) => { lastStatus = args[0]; showStatus(...args); };
            try {
                const inverted = await readInverted();
                if (inverted !== snapshot.inverted || !snapshot.validate()) { report(STALE); return; }
                if (!destinationCurrent(destination)) { report(CHANGED_DESTINATION); return; }
                consumed = true;
                selection.clear();
                report(snapshot.kind === 'folder' ? 'Moving saved folder…' : `Moving ${snapshot.entries.length} saved pin${snapshot.entries.length === 1 ? '' : 's'}…`, false, false);
                attempted = true;
                const result = await sendRequest({ type: 'moveSavedItemsToSpace', windowId: snapshot.windowId,
                    spaceId: snapshot.spaceId, bookmarkFolderId: snapshot.bookmarkFolderId,
                    destinationSpaceId: destination.id, destinationBookmarkFolderId: destination.bookmarkFolderId,
                    inverted: snapshot.inverted, entries: snapshot.entries });
                report(describeSavedMoveOutcome(result, snapshot.entries, destination));
            } catch (error) { report(attempted ? UNKNOWN : `Nothing was moved. ${error.message}`); }
            finally {
                pending = false; end();
                if (attempted) try { await refresh(); }
                catch { showStatus(`${lastStatus} The sidebar could not refresh. Reload it before trying again.`); }
            }
        } };
    };
}

export function appendSavedMovePicker(options) {
    const folder = options.actions?.kind === 'folder', count = options.actions?.count;
    return appendSpaceMovePicker({ ...options, labels: {
        action: 'moveSavedItemsToSpace', destinationAction: 'moveSavedToDestination',
        hint: folder ? 'Move this folder and all its saved pins. Keep its structure and stay in the current Space.'
            : `Move ${count} saved pin${count === 1 ? '' : 's'}. Stay in the current Space.`,
        menu: folder ? 'Move saved folder to Space' : 'Move saved pins to Space',
        destination: name => `Move ${folder ? 'saved folder' : 'saved pins'} to ${name}`
    } });
}

// Preparation and the picker share one cancellable session. Stale menu nodes
// cannot dispatch even if they are retained after Back, dismissal or replacement.
export async function openSavedFolderContextMenu({ document, element, event, keyboard = false, prepareMove, createMoveAction,
    canCreate = async () => false, createFolder, deleteFolder, beginInteraction = () => () => {}, showStatus = () => {} }) {
    const focusTarget = element.querySelector(':scope > .folder-header') || element;
    const session = createContextMenuSession(document, { onEscape: () => { if (keyboard && focusTarget.isConnected) focusTarget.focus(); } });
    let attached = false;
    try {
        const snapshot = await prepareMove(() => session.active);
        if (!session.active || !snapshot?.validate()) return;
        const allowCreate = await canCreate();
        if (!session.active || !snapshot.validate()) return;
        const menu = document.createElement('div'); menu.id = 'folder-context-menu'; menu.className = 'context-menu';
        menu.setAttribute('role', 'menu'); menu.style.position = 'fixed';
        const anchor = focusTarget.getBoundingClientRect();
        const x = keyboard ? anchor.left : event.clientX, y = keyboard ? anchor.bottom : event.clientY;
        function reposition() {
            const bounds = menu.getBoundingClientRect(), view = document.defaultView;
            menu.style.left = `${Math.max(5, Math.min(x, view.innerWidth - bounds.width - 5))}px`;
            menu.style.top = `${Math.max(5, Math.min(y, view.innerHeight - bounds.height - 5))}px`;
        }
        function item(label, action, callback) {
            const control = document.createElement('div'); control.className = 'context-menu-item';
            control.textContent = label; control.dataset.action = action; control.setAttribute('role', 'menuitem'); control.tabIndex = 0;
            control.addEventListener('click', () => {
                if (!session.active || !menu.contains(control)) return;
                if (!snapshot.validate()) { session.close(); showStatus(STALE); return; }
                session.close(); void Promise.resolve().then(callback).catch(error => showStatus(error.message));
            });
            control.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); control.click(); } });
            menu.append(control);
        }
        if (allowCreate) item('New Folder', 'newFolder', createFolder);
        appendSavedMovePicker({ document, menu, actions: createMoveAction(snapshot), close: session.close, active: () => session.active, reposition });
        item('Delete Folder', 'deleteFolder', deleteFolder);
        attached = session.attach(menu);
        if (!attached) return;
        reposition();
        session.onClose(beginInteraction());
        if (keyboard) menu.querySelector('[role="menuitem"]')?.focus();
        menu.addEventListener('keydown', event => {
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
            const items = [...menu.querySelectorAll('[role="menuitem"]')];
            if (!items.length) return;
            event.preventDefault();
            const index = items.indexOf(document.activeElement);
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 :
                (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
            items[next].focus();
        });
    } catch (error) { if (session.active) showStatus(error.message); }
    finally { if (!attached) session.close(); }
}
