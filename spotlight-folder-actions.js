import { moveSavedItemsToSpaceUnlocked } from './saved-move-store.js';
import { readRoot, sourceTab, fencedRead } from './spotlight-space-actions.js';
import { createFolder } from './folder-policy.js';
import { bridgeError, sameSplitValue, isFolderActionContext } from './spotlight-bridge-protocol.js';
import { Utils } from './utils.js';

// This module runs inside SpaceStore.run(), except prepared moves, which must be
// dispatched through moveSavedItemsToSpace outside that queue (it queues itself).
const fail = message => { throw bridgeError('STALE_CONTEXT', message || 'The folder or selected Space changed. Browse it again.'); };
const same = sameSplitValue;
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const validTitle = title => typeof title === 'string' && title.trim().length > 0 && title.length <= 256 && !/[\u0000-\u001f\u007f]/.test(title);
function shapeTree(node, seen = new Set(), depth = 0) {
    if (!node || !validId(node.id) || seen.has(node.id) || seen.size >= 2000 || depth > 32 || typeof node.title !== 'string')
        fail('This folder is invalid or too large for one action.');
    seen.add(node.id);
    const children = (node.children || []).map(child => {
        if (child.parentId !== node.id) fail();
        return shapeTree(child, seen, depth + 1);
    });
    if (node.url && children.length) fail();
    return { id: node.id, parentId: node.parentId, title: node.title, url: node.url || null, children };
}
async function inspect(store, request, pairingGeneration) {
    const space = await readRoot(store, request.windowId, request.context);
    sourceTab(store, await chrome.tabs.query({}), request.windowId, request.tabId, request.context);
    if (!validId(request.folderId)) fail();
    const [nativeTree] = await chrome.bookmarks.getSubTree(request.folderId);
    const tree = shapeTree(nativeTree);
    if (tree.url) fail('Choose a saved folder, not a bookmark.');
    const ancestors = [];
    let cursor = tree;
    const seen = new Set([tree.id]);
    while (cursor.id !== space.bookmarkFolderId) {
        if (!validId(cursor.parentId) || seen.has(cursor.parentId) || ancestors.length >= 32) fail();
        const [parent] = await chrome.bookmarks.get(cursor.parentId);
        if (!parent || parent.url) fail();
        ancestors.push({ id: parent.id, parentId: parent.parentId, title: parent.title });
        seen.add(parent.id); cursor = parent;
    }
    const { syncTabGroups = false } = await chrome.storage.sync.get('syncTabGroups');
    return { windowId: request.windowId, sourceTabId: request.tabId, pairingGeneration,
        spaceId: space.id, bookmarkFolderId: space.bookmarkFolderId,
        folder: tree, ancestors, syncTabGroups: Boolean(syncTabGroups) };
}
export async function readFolderActionContext(store, request, { pairingGeneration = null, beforeReturn = async () => {} } = {}) {
    let policyChanged = false;
    const policyListener = (changes, area) => { if (area === 'sync' && changes.syncTabGroups) policyChanged = true; };
    chrome.storage.onChanged?.addListener(policyListener);
    try { return await fencedRead(async assertUnchanged => {
        const context = await inspect(store, request, pairingGeneration);
        await beforeReturn();
        // Root/source checks after asynchronous authority reads prevent a stale
        // selected Space from authorizing a folder from the previous selection.
        await readRoot(store, request.windowId, context);
        sourceTab(store, await chrome.tabs.query({}), request.windowId, request.tabId, context);
        // Pairing may revoke during those final native reads before its storage
        // event is delivered. Re-read persisted authority last as well.
        await beforeReturn();
        assertUnchanged();
        if (policyChanged) fail('The folder nesting policy changed. Browse the folder again.');
        if (!isFolderActionContext(context)) fail('This folder context is invalid or too large.');
        return context;
    }, { windowId: request.windowId, tabIds: new Set([request.tabId]) });
    } finally { chrome.storage.onChanged?.removeListener(policyListener); }
}

export async function runFolderAction(store, request, { beforeMutation = async () => {} } = {}) {
    if (!request.context || request.context.windowId !== request.windowId || !validId(request.context.folder?.id)) fail();
    if (!['createChildFolder', 'renameSavedFolder', 'deleteEmptyFolder'].includes(request.command)) throw bridgeError('INVALID_REQUEST', 'Unsupported folder action.');
    if (request.command !== 'deleteEmptyFolder' && !validTitle(request.title)) throw bridgeError('INVALID_REQUEST', 'Choose a folder name of 1–256 characters.');
    if (request.command === 'deleteEmptyFolder' && request.confirmed !== true) throw bridgeError('INVALID_REQUEST', 'Confirm deletion of this empty folder.');
    const expected = request.context;
    if (request.command !== 'createChildFolder' && expected.folder.id === expected.bookmarkFolderId) throw bridgeError('PROTECTED_FOLDER', 'Space roots must be managed through Space actions.');
    const guard = async () => {
        const context = await readFolderActionContext(store, { windowId: request.windowId, tabId: expected.sourceTabId,
            folderId: expected.folder.id, context: expected }, { pairingGeneration: expected.pairingGeneration, beforeReturn: beforeMutation });
        if (!same(context, expected)) fail();
        if (request.command === 'deleteEmptyFolder' && context.folder.children.length) throw bridgeError('NONEMPTY_FOLDER', 'Only empty folders can be deleted here. Move or remove their contents first.');
    };
    await guard();
    let attempted = false;
    try {
        if (request.command === 'createChildFolder') {
            const result = await createFolder(expected.bookmarkFolderId, expected.folder.id, request.title.trim(), {
                beforeWrite: async () => { await guard(); attempted = true; }
            });
            if (!result?.id) throw new Error('No folder identity returned.');
            return { folderId: result.id };
        }
        await guard();
        attempted = true;
        if (request.command === 'renameSavedFolder') await chrome.bookmarks.update(expected.folder.id, { title: request.title.trim() });
        // Native remove (not removeTree) atomically refuses a newly nonempty
        // folder, so concurrent child creation can never silently delete data.
        else await chrome.bookmarks.remove(expected.folder.id);
        return { folderId: expected.folder.id };
    } catch (error) {
        if (attempted) throw bridgeError('UNCERTAIN_RESULT', `The folder action could not be confirmed. Inspect the folder before trying again. ${error.message}`);
        throw error;
    }
}

export async function prepareFolderMove(store, context, destinationSpaceId, { beforeReturn = async () => {} } = {}) {
    const fresh = await readFolderActionContext(store, { windowId: context.windowId, tabId: context.sourceTabId,
        folderId: context.folder.id, context }, { pairingGeneration: context.pairingGeneration, beforeReturn });
    if (!same(fresh, context) || context.folder.id === context.bookmarkFolderId) fail();
    const targets = store.spaces.filter(space => space.id === destinationSpaceId && space.id !== context.spaceId);
    if (targets.length !== 1 || !validId(targets[0].bookmarkFolderId)) fail('Choose another existing Space.');
    // Existing cross-Space transaction owns live pin reconciliation, journaling,
    // recovery, URL identities and order. Never replace it with bookmarks.move.
    const folder = context.folder;
    const folderDepth = node => node.url ? 0 : 1 + Math.max(0, ...node.children.map(folderDepth));
    const depth = folderDepth(folder);
    if (depth > 2 || context.syncTabGroups && depth > 1) throw bridgeError('FOLDER_DEPTH', 'This move would exceed the destination folder nesting policy.');
    return { type: 'moveSavedItemsToSpace', windowId: context.windowId, spaceId: context.spaceId,
        bookmarkFolderId: context.bookmarkFolderId, destinationSpaceId,
        destinationBookmarkFolderId: targets[0].bookmarkFolderId, inverted: Boolean(await Utils.getInvertTabOrder()),
        entries: [{ bookmarkId: folder.id, parentId: folder.parentId, title: folder.title, url: null, tabId: null, tree: folder }] };
}

// Existing cross-Space transaction is deliberately reused for all bookmark,
// live-pin, persistence and crash-recovery semantics.
export async function runFolderMove(store, request, { beforeMutation = async () => {} } = {}) {
    const context = request.context;
    const move = await prepareFolderMove(store, context, request.destination.spaceId, { beforeReturn: beforeMutation });
    if (move.destinationBookmarkFolderId !== request.destination.bookmarkFolderId) fail('The destination Space changed. Choose it again.');
    const guard = async () => {
        let policyChanged = false;
        const policyListener = (changes, area) => { if (area === 'sync' && changes.syncTabGroups) policyChanged = true; };
        chrome.storage.onChanged?.addListener(policyListener);
        try { return await fencedRead(async assertUnchanged => {
            await readRoot(store, context.windowId, context);
            sourceTab(store, await chrome.tabs.query({}), context.windowId, context.sourceTabId, context);
            const { syncTabGroups = false } = await chrome.storage.sync.get('syncTabGroups');
            if (Boolean(syncTabGroups) !== context.syncTabGroups) fail('The folder nesting policy changed.');
            await beforeMutation();
            assertUnchanged();
            if (policyChanged) fail('The folder nesting policy changed.');
        }, { windowId: context.windowId, tabIds: new Set([context.sourceTabId]) });
        } finally { chrome.storage.onChanged?.removeListener(policyListener); }
    };
    const batch = await moveSavedItemsToSpaceUnlocked(store, move, { beforeMutation: guard });
    if (batch.uncertain || !same(batch.completed, [context.folder.id]) || batch.remaining.length)
        throw bridgeError('UNCERTAIN_RESULT', 'The folder move was not fully confirmed. Inspect both Spaces before trying again.');
    return { folderId: context.folder.id, destinationSpaceId: request.destination.spaceId };
}
