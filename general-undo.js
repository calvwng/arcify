import { rememberGeneralUndo, takeGeneralUndo } from './general-undo-state.js';
import { moveTodayTabsToSpaceCore } from './today-move-store.js';
import { assertNotTransient } from './transient-safety.js';

async function normalWindow(store, windowId) {
    if (!Number.isSafeInteger(windowId) || windowId < 1) throw new Error('Choose a normal browser window.');
    assertNotTransient(store, { windowId });
    const window = await chrome.windows.get(windowId);
    if (window.id !== windowId || window.incognito || window.type !== 'normal') throw new Error('Undo is only available in normal browser windows.');
}
export function reorderSpaceWithUndo(store, request) {
    return store.run(async () => {
        await normalWindow(store, request.windowId);
        const originalOrder = store.spaces.map(space => space.id);
        let spaces;
        try {
            spaces = await store.applyAction({ ...request, action: 'reorder' });
            const persisted = await chrome.storage.local.get('spaces');
            if (JSON.stringify(persisted.spaces?.map(space => space.id)) !== JSON.stringify(spaces.map(space => space.id))) {
                throw new Error('Space reorder could not be confirmed. Refresh before continuing.');
            }
        } catch (error) { store.initialized = false; throw error; }
        const undoToken = JSON.stringify(originalOrder) === JSON.stringify(spaces.map(space => space.id)) ? null :
            rememberGeneralUndo(store, { kind: 'spaces', windowId: request.windowId, originalOrder });
        return { spaces, undoToken };
    });
}
export function undoGeneralAction(store, request) {
    return store.run(async () => {
        await normalWindow(store, request.windowId);
        const receipt = takeGeneralUndo(store, request.token, request.windowId);
        if (receipt.kind === 'spaces') {
            // Change order only. Never replay metadata or membership snapshots.
            const byId = new Map(store.spaces.map(space => [space.id, space]));
            if (byId.size !== receipt.originalOrder.length || receipt.originalOrder.some(id => !byId.has(id))) throw new Error('The Spaces changed. Nothing was undone.');
            store.spaces = receipt.originalOrder.map(id => byId.get(id));
            try {
                await store.persist();
                const persisted = await chrome.storage.local.get('spaces');
                if (JSON.stringify(persisted.spaces?.map(space => space.id)) !== JSON.stringify(receipt.originalOrder)) {
                    throw new Error('Undo could not be confirmed. Refresh before continuing.');
                }
            }
            catch (error) { store.initialized = false; throw error; }
        } else {
            const forward = receipt.request;
            const reverse = { ...forward, spaceId: forward.destinationSpaceId, bookmarkFolderId: forward.destinationBookmarkFolderId,
                destinationSpaceId: forward.spaceId, destinationBookmarkFolderId: forward.bookmarkFolderId };
            await moveTodayTabsToSpaceCore(store, reverse, { activeSpaceId: forward.spaceId, targetOrder: receipt.originalOrder });
        }
        return { spaces: structuredClone(store.spaces) };
    });
}
export function registerGeneralUndoMessages(store) {
    chrome.runtime.onMessage.addListener((message, sender, respond) => {
        if (!['reorderSpaceWithUndo', 'undoGeneralAction'].includes(message?.type)) return;
        const ownUrl = chrome.runtime.getURL('');
        if (sender?.id !== chrome.runtime.id || sender.incognito || !sender.url?.startsWith(ownUrl) ||
            sender.origin && sender.origin !== ownUrl.replace(/\/$/, '') || sender.tab?.incognito ||
            sender.tab && sender.tab.windowId !== message.windowId) {
            respond({ success: false, error: 'Invalid Undo sender.' }); return;
        }
        const operation = message.type === 'reorderSpaceWithUndo' ? reorderSpaceWithUndo : undoGeneralAction;
        operation(store, message).then(result => respond({ success: true, ...result }),
            error => respond({ success: false, error: error.message }));
        return true;
    });
}
