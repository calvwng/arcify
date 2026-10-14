const icons = container => [...container.querySelectorAll(':scope > .pinned-favicon')];
const identity = node => node.dataset.favoriteId || node.dataset.tabId;

// The same relative destination drives the overlay and the mutation. Saved
// records and unmanaged native pins are separate lists, even on a shared row.
export function resolveFavoritesDrop({ container, source, target, clientX, clientY, favorites = [] }) {
    if (!container || !source || !target || !container.contains(target) ||
        !Number.isFinite(clientX) || !Number.isFinite(clientY) ||
        !['saved', 'native', 'bookmark', 'live'].includes(source.kind)) return null;
    const list = source.kind === 'native' ? 'native' : 'saved';
    const all = icons(container);
    const members = all.filter(node => node.classList.contains(`${list}-favorite`));
    // Repeated bookmark/live drops reuse exact durable identity. Never infer a
    // match from a URL or title, and never use native pins as saved anchors.
    const movingId = source.kind === 'saved' ? source.favoriteId : source.kind === 'bookmark'
        ? favorites.find(item => item.sourceBookmarkId === source.bookmarkId)?.id
        : source.kind === 'live' ? favorites.find(item => item.tabId === source.tabId)?.id : null;
    const moving = source.kind === 'native' ? source.element : members.find(node => node.dataset.favoriteId === movingId);
    const internal = source.kind === 'saved' || source.kind === 'native';
    if (internal && (!members.includes(source.element) || moving !== source.element || source.element.contains(target))) return null;
    const others = members.filter(node => node !== moving);
    const hovered = target.closest?.('.pinned-favicon');
    let reference, placement, index;
    if (!others.length) {
        if (internal) return null;
        // An empty saved list still has a real insertion boundary ahead of pins.
        reference = all.find(node => node.classList.contains('native-favorite')) || moving || container.querySelector('.pinned-placeholder-container') || container;
        placement = reference.matches('.pinned-favicon') ? 'before' : 'empty';
        index = 0;
    } else if (hovered && all.includes(hovered) && !members.includes(hovered)) {
        reference = list === 'saved' ? others.at(-1) : others[0];
        placement = list === 'saved' ? 'after' : 'before';
        index = list === 'saved' ? others.length : 0;
    } else {
        // Prefer an actual hovered icon. In row/column gaps use the nearest
        // physical row, then its horizontal midpoints; X alone fails on wrap.
        if (others.includes(hovered)) {
            reference = hovered;
            const rect = hovered.getBoundingClientRect();
            placement = clientX < (rect.left + rect.right) / 2 ? 'before' : 'after';
        } else {
            const rows = [];
            for (const node of others) {
                const rect = node.getBoundingClientRect();
                let row = rows.at(-1);
                if (!row || rect.top >= row.bottom || rect.bottom <= row.top) {
                    row = { top: rect.top, bottom: rect.bottom, nodes: [] }; rows.push(row);
                }
                row.nodes.push(node); row.top = Math.min(row.top, rect.top); row.bottom = Math.max(row.bottom, rect.bottom);
            }
            const distance = row => Math.max(row.top - clientY, clientY - row.bottom, 0);
            const row = rows.reduce((nearest, row) => distance(row) < distance(nearest) ? row : nearest);
            const next = clientY < rows[0].top ? others[0] : clientY > rows.at(-1).bottom ? null : row.nodes.find(node => {
                const rect = node.getBoundingClientRect();
                return clientX < (rect.left + rect.right) / 2;
            });
            reference = next || (clientY > rows.at(-1).bottom ? others.at(-1) : row.nodes.at(-1));
            placement = next ? 'before' : 'after';
        }
        index = others.indexOf(reference) + (placement === 'after' ? 1 : 0);
    }
    if (internal && index === members.indexOf(moving)) return null;
    return { list, beforeId: list === 'saved' ? others[index]?.dataset.favoriteId || null : null,
        beforeTabId: list === 'native' ? others[index]?.dataset.tabId || null : null,
        index, reference, placement, anchorId: reference.matches('.pinned-favicon') ? identity(reference) : null };
}
