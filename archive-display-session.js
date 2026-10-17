/** Internal display-only transport. This is not native SIDE_PANEL attestation. */
export const ARCHIVE_DISPLAY_PORT = 'arcify-archive-display-v1';
export const ARCHIVE_DISPLAY_TYPE = 'arcifyArchiveDisplay';

// A sticky observer for the entire invocation, not just its individual reads.
// Contexts are supplied live so the background can subscribe before any gesture
// arrives, without adding another browser API before sidePanel.open.
const encode = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const validSpaces = spaces => Array.isArray(spaces) && spaces.every(space => space && typeof space === 'object' && !Array.isArray(space)
    && typeof space.id === 'string' && space.id.length > 0 && typeof space.bookmarkFolderId === 'string' && space.bookmarkFolderId.length > 0);
const spaceAuthority = (spaces, context) => spaces.filter(space =>
    space.id === context.spaceId || space.bookmarkFolderId === context.bookmarkFolderId)
    .map(({ id, bookmarkFolderId }) => ({ id, bookmarkFolderId })).sort((a, b) => a.id.localeCompare(b.id));

export function observeArchiveDisplayChanges(api, contexts, invalidate) {
    const cleanups = [];
    const watch = (event, listener) => {
        if (!event?.addListener || !event.removeListener) return;
        event.addListener(listener); cleanups.push(() => event.removeListener(listener));
    };
    const change = predicate => { for (const item of contexts()) if (predicate(item.context)) invalidate(item); };
    watch(api.tabs?.onUpdated, tabId => change(context => context.sourceTabId === tabId));
    for (const name of ['onRemoved', 'onAttached', 'onDetached'])
        watch(api.tabs?.[name], tabId => change(context => context.sourceTabId === tabId));
    watch(api.tabs?.onReplaced, (added, removed) => change(context => [added, removed].includes(context.sourceTabId)));
    watch(api.tabs?.onActivated, info => change(context => context.windowId === info.windowId));
    watch(api.windows?.onRemoved, windowId => change(context => context.windowId === windowId));
    watch(api.windows?.onFocusChanged, windowId => change(context => context.windowId !== windowId));
    for (const name of ['onChanged', 'onMoved', 'onRemoved', 'onCreated'])
        watch(api.bookmarks?.[name], () => change(() => true));
    watch(api.storage?.onChanged, (changes, area) => {
        const keys = area === 'local' ? ['archivedTabs', 'spaces', 'arcifyBridgePeerId', 'arcifyBridgePairingGeneration']
            : area === 'session' ? ['activeSpaces', 'archiveBrowserSession'] : [];
        change(context => keys.some(key => {
            if (!Object.hasOwn(changes, key)) return false;
            if (!changes[key] || typeof changes[key] !== 'object'
                || key === 'spaces' && (!validSpaces(changes[key].oldValue) || !validSpaces(changes[key].newValue))) return true;
            const project = value => key === 'spaces' ? spaceAuthority(value, context)
                : key === 'activeSpaces' ? value?.[context.windowId] : value;
            return encode(project(changes[key].oldValue)) !== encode(project(changes[key].newValue));
        }));
    });
    return () => cleanups.splice(0).forEach(cleanup => cleanup());
}
