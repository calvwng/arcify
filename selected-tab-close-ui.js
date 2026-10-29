export function createSelectedTabClose({ sendRequest, showStatus, begin = () => {}, end = () => {}, refresh = async () => {} }) {
    let pending = false;
    return (snapshot, selection) => {
        if (!snapshot || snapshot.error) return null;
        const entries = snapshot.entries.filter(e => Number.isSafeInteger(e.tabId) && e.tabId > 0)
            .map(({ tabId, url, bookmarkId, parentId }) => ({ tabId, url, ...(bookmarkId ? { bookmarkId, parentId } : {}) }));
        if (!entries.length) return null;
        return { count: entries.length, async close() {
            if (pending) return;
            if (!selection.validate(snapshot)) { showStatus('The selection changed. Reopen its menu.'); return; }
            pending = true; begin(); selection.clear();
            try {
                const result = await sendRequest({ type: 'closeSelectedTabs', windowId: snapshot.windowId,
                    spaceId: snapshot.spaceId, bookmarkFolderId: snapshot.bookmarkFolderId, entries });
                const valid = typeof result?.success === 'boolean' && typeof result?.uncertain === 'boolean' && Array.isArray(result?.completed) && new Set(result.completed).size === result.completed.length &&
                    result.completed.every(id => entries.some(e => e.tabId === id));
                if (!valid) throw new Error('The close result could not be confirmed. Check the tabs before trying again.');
                showStatus(result.success && result.completed.length === entries.length && !result.uncertain
                    ? `Closed ${entries.length} tab${entries.length === 1 ? '' : 's'}. Saved pins and Favorites are kept.`
                    : `${result.completed.length} of ${entries.length} tabs confirmed closed. ${result.error || ''} ${result.uncertain ? 'The last close result is uncertain. ' : ''}Check the tabs before trying again.`);
            } catch (error) { showStatus(`${error.message} Nothing was retried.`); }
            finally { pending = false; end(); try { await refresh(); } catch { showStatus('Reload the sidebar to check the close result.'); } }
        } };
    };
}

// Only handle shortcuts delivered to an exact row, never editors or page focus.
// Native browser close shortcuts remain browser-owned.
export function installSelectionCloseKeys(document, actionForRow) {
    document.addEventListener('keydown', event => {
        const row = event.target;
        if (!row?.matches?.('#spacesList .tab') || event.defaultPrevented || event.repeat || event.isComposing || event.altKey || event.shiftKey) return;
        const fallback = !event.ctrlKey && !event.metaKey && event.key === 'Delete';
        if (!fallback) return;
        const action = actionForRow(row);
        if (!action) return;
        event.preventDefault(); event.stopImmediatePropagation(); void action.close();
    }, true);
}
