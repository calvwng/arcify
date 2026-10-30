// Display-only observations. Never use this snapshot or its revision to approve
// a tab/bookmark mutation; actions retain their existing fresh native checks.
export async function readRowDisplayMetadata() {
    const saved = await chrome.storage.local.get(['pinnedTabStatesById', 'tabNameOverridesById']);
    return { pinnedStatesById: saved.pinnedTabStatesById || {}, overrides: saved.tabNameOverridesById || {} };
}

export function observeDisplayChanges(api = chrome) {
    let revision = 0;
    const changed = () => { revision++; };
    for (const name of ['onCreated', 'onUpdated', 'onRemoved', 'onAttached', 'onDetached', 'onMoved', 'onReplaced', 'onActivated']) {
        api.tabs?.[name]?.addListener(changed);
    }
    for (const name of ['onCreated', 'onChanged', 'onMoved', 'onRemoved', 'onChildrenReordered', 'onImportEnded']) {
        api.bookmarks?.[name]?.addListener(changed);
    }
    api.storage?.onChanged?.addListener((changes, area) => {
        if (area === 'sync' || Object.keys(changes).some(key =>
            ['spaces', 'activeSpaces', 'spaceSession', 'favoriteSession', 'persistentFavorites', 'todayOrderRepresentation',
                'pinnedTabStatesById', 'tabNameOverridesById'].includes(key) || key.startsWith('folderCollapsed:'))) changed();
    });
    // Installed before initialization so a native event during the first render
    // cannot be missed merely because normal UI listeners are not ready yet.
    return { capture() { const captured = revision; return () => captured === revision; } };
}
