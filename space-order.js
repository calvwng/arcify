// The spaces array in SpaceStore is the only ordering record. Move one stable ID
// relative to another in the latest state; never replay a stale panel's full list.
export function moveSpace(spaces, { spaceId, anchorSpaceId, position }) {
    if (typeof spaceId !== 'string' || typeof anchorSpaceId !== 'string' || !['before', 'after'].includes(position)) {
        throw new Error('Invalid space move.');
    }
    const source = spaces.find(space => space.id === spaceId);
    const anchor = spaces.find(space => space.id === anchorSpaceId);
    if (!source || !anchor) throw new Error('A space changed or was deleted. Refresh and try again.');
    if (source === anchor) return spaces;
    const result = spaces.filter(space => space.id !== spaceId);
    const index = result.findIndex(space => space.id === anchorSpaceId) + (position === 'after' ? 1 : 0);
    result.splice(index, 0, source);
    return result;
}

// Project an acknowledged order onto current panel objects without resetting
// pending metadata/tab patches. Unseen/local-only IDs retain their slots until
// the normal authoritative refresh reconciles additions and deletions.
export function projectSpaceOrder(current, ordered) {
    const orderedIds = new Set(ordered.map(space => space.id));
    const known = new Map(current.filter(space => orderedIds.has(space.id)).map(space => [space.id, space]));
    const sequence = ordered.filter(space => known.has(space.id)).map(space => known.get(space.id));
    return current.map(space => known.has(space.id) ? sequence.shift() : space);
}
