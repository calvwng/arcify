// Resolve one destination for both feedback and the eventual bookmark operation.
// A folder header has before / inside / after zones. Its children retain their
// own destinations, including live tabs projected out of collapsed folders.
const isRow = element => element?.matches?.('.tab, .folder');
const contentOf = folder => folder.querySelector(':scope > .folder-content');

export function sidebarDropChildren(container) {
    const projected = container.parentElement?.querySelector(':scope > .folder-collapsed-tabs');
    return [...container.childNodes].map(node => {
        if (node.nodeType === 8 && node.bookmarkKey) {
            return [...(projected?.children || [])].find(row =>
                (row.dataset.bookmarkId || row.dataset.tabId) === node.bookmarkKey);
        }
        return node;
    }).filter(isRow);
}

function rowContainer(row) {
    const parent = row.parentElement;
    return parent?.classList.contains('folder-collapsed-tabs') ? contentOf(parent.parentElement) : parent;
}

function folderDepth(folder) {
    let depth = 0;
    for (let node = folder; node; node = node.parentElement?.closest('.folder')) depth++;
    return depth;
}

function subtreeDepth(folder) {
    return 1 + Math.max(0, ...[...contentOf(folder).children]
        .filter(child => child.classList.contains('folder')).map(subtreeDepth));
}

export function resolveSidebarDrop({ section, dragging, target, clientY, maxFolderDepth = 2 }) {
    if (!section || !dragging || !target || !section.contains(target) || dragging.contains(target)) return null;
    if (!dragging.matches('.tab, .folder, .pinned-favicon')) return null;
    const sourceSpace = dragging.closest('.space');
    if (sourceSpace && sourceSpace !== section.closest('.space')) return null;
    const pinned = section.dataset.tabType === 'pinned';
    if (pinned && section.closest('.space')?.dataset.bookmarkTreeUnavailable === 'true') return null;
    if (!pinned && (dragging.classList.contains('folder') || !dragging.dataset.tabId)) return null;

    let container = section, reference = null, placement = 'empty';
    const row = target.closest?.('.tab, .folder');
    if (row && section.contains(row)) {
        if (row.classList.contains('folder')) {
            const header = row.querySelector(':scope > .folder-header');
            const rect = header.getBoundingClientRect();
            if (clientY <= rect.bottom) {
                const edge = Math.min(8, rect.height / 4);
                placement = clientY < rect.top + edge ? 'before' : clientY > rect.bottom - edge ? 'after' : 'inside';
                reference = row;
                container = placement === 'inside' ? contentOf(row) : rowContainer(row);
            } else {
                container = contentOf(row);
            }
        } else {
            reference = row;
            container = rowContainer(row);
            const rect = row.getBoundingClientRect();
            placement = clientY < rect.top + rect.height / 2 ? 'before' : 'after';
        }
    } else {
        container = target.closest?.('.folder-content') || section;
    }
    if (!container || !section.contains(container) || dragging.contains(container)) return null;
    const folder = container.closest('.folder');
    if (folder && !folder.dataset.bookmarkId) return null;
    const children = sidebarDropChildren(container).filter(child => child !== dragging);
    if (!reference) {
        // Gaps and whitespace, including below the last item, have an explicit
        // line rather than silently falling back to append on drop.
        reference = children.find(child => {
            const rect = child.getBoundingClientRect();
            return clientY < rect.top + rect.height / 2;
        }) || children.at(-1) || container;
        placement = reference === container ? 'empty'
            : clientY < reference.getBoundingClientRect().top + reference.getBoundingClientRect().height / 2 ? 'before' : 'after';
    }
    const before = placement === 'before' ? reference
        : placement === 'after' ? children[children.indexOf(reference) + 1] || null : null;
    if (dragging.classList.contains('folder')) {
        if (!dragging.dataset.bookmarkId) return null;
        // Reordering an imported, deeper tree is safe; moving it may not create
        // new levels beyond the same policy used by folder creation.
        if (container !== rowContainer(dragging) && folderDepth(folder) + subtreeDepth(dragging) > maxFolderDepth) return null;
    }
    const originalChildren = sidebarDropChildren(container);
    const originalIndex = originalChildren.indexOf(dragging);
    if (originalIndex >= 0 && (originalChildren[originalIndex + 1] || null) === before) return null;
    return { section, container, before, folder, reference, placement };
}

export function insertAtSidebarDrop(destination, dragging) {
    const { container, before } = destination;
    // Opening a projected tab's folder must restore its real row before insert.
    if (before && before.parentElement !== container) throw new Error('The drop destination changed. Refresh and retry.');
    if (dragging.contains(container)) throw new Error('A folder cannot be moved inside itself.');
    container.insertBefore(dragging, before);
    container.querySelector(':scope > .tab-placeholder')?.classList.add('hidden');
}
