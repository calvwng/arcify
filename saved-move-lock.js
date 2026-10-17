// One cross-document barrier prevents startup's legacy bookmark reconciliation
// from observing the gap between the bookmark commit and Space membership.
let chain = Promise.resolve();
export function withSavedMoveLock(operation) {
    if (globalThis.navigator?.locks?.request) return navigator.locks.request('arcify-saved-space-move', operation);
    const result = chain.then(operation, operation);
    chain = result.catch(() => {});
    return result;
}
export const SAVED_MOVE_JOURNAL_KEY = 'spaceSavedMoveJournal';
export async function assertSavedMoveSettled() {
    const data = await chrome.storage.local.get(SAVED_MOVE_JOURNAL_KEY);
    if (data[SAVED_MOVE_JOURNAL_KEY]?.phase === 'prepared') throw new Error('A saved-item move needs recovery. Reload the sidebar before changing pins.');
}
