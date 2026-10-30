// Separate keys keep simultaneous updates to different folders independent.
const pendingWrites = new Map();
const keyFor = folderId => `folderCollapsed:${folderId}`;

export function saveFolderCollapsed(folderId, collapsed) {
    if (!folderId) return Promise.resolve();
    const previous = pendingWrites.get(folderId) || Promise.resolve();
    const write = previous.catch(() => {}).then(() =>
        chrome.storage.local.set({ [keyFor(folderId)]: collapsed })
    );
    pendingWrites.set(folderId, write);
    return write.finally(() => {
        if (pendingWrites.get(folderId) === write) pendingWrites.delete(folderId);
    });
}

export async function loadFolderCollapsed(folderId) {
    await pendingWrites.get(folderId);
    const key = keyFor(folderId);
    const saved = await chrome.storage.local.get(key);
    // Existing folders keep the previous collapsed default until toggled.
    return saved[key] !== false;
}

// One display read for the whole tree, after this document's queued toggles.
// The caller fences storage events before committing its rendered fragment.
export async function loadFolderStates(tree) {
    const ids = [];
    const visit = node => {
        for (const child of node?.children || []) {
            if (!child.url) { ids.push(child.id); visit(child); }
        }
    };
    visit(tree);
    if (!ids.length) return new Map();
    await Promise.all(ids.map(id => pendingWrites.get(id)));
    const saved = await chrome.storage.local.get(ids.map(keyFor));
    return new Map(ids.map(id => [id, saved[keyFor(id)] !== false]));
}
