// Deliberately ephemeral: restart cannot prove native identity continuity.
const receipts = new WeakMap();
const revisions = new WeakMap();
export const undoRevision = store => revisions.get(store) || 0;
export function invalidateGeneralUndo(store) {
    revisions.set(store, undoRevision(store) + 1);
    receipts.delete(store);
}
export const undoFingerprint = store => JSON.stringify({ spaces: store.spaces, active: store.active });
export function rememberGeneralUndo(store, receipt) {
    const token = crypto.randomUUID();
    receipts.set(store, { ...structuredClone(receipt), token, revision: undoRevision(store), fingerprint: undoFingerprint(store) });
    return token;
}
export function takeGeneralUndo(store, token, windowId) {
    const receipt = receipts.get(store);
    if (!receipt || receipt.token !== token || receipt.windowId !== windowId || receipt.revision !== undoRevision(store) || receipt.fingerprint !== undoFingerprint(store)) {
        throw new Error('Undo is no longer available because the browser state changed. Nothing was undone.');
    }
    receipts.delete(store); // One attempt only, including uncertain writes.
    return receipt;
}
