// A real button, not a global Ctrl+Z handler that could steal editor undo.
export function createGeneralUndoUI({ document, getWindowId, sendRequest, refresh, showStatus, begin = () => {}, end = () => {} }) {
    const notice = document.getElementById('favoritesDropNotice');
    const button = document.createElement('button');
    button.type = 'button'; button.textContent = 'Undo'; button.hidden = true;
    button.id = 'generalUndo'; button.setAttribute('aria-label', 'Undo last Space or Today move');
    notice.append(button);
    let token = null, pending = false;
    const clear = () => { token = null; button.hidden = true; };
    button.addEventListener('click', async event => {
        event.stopPropagation();
        if (pending || !token) return;
        const selected = token; clear(); pending = true; button.disabled = true;
        begin();
        try {
            const result = await sendRequest({ type: 'undoGeneralAction', token: selected, windowId: getWindowId() });
            showStatus(result?.success ? 'Undone.' : result?.error || 'Undo could not be confirmed. Check the current layout before continuing.');
            await refresh();
        } catch { showStatus('Undo could not be confirmed. Check the current layout before continuing; nothing was retried.'); }
        finally { pending = false; button.disabled = false; end(); }
    });
    return { clear, offer(value) { if (typeof value === 'string' && value && !pending) { token = value; button.hidden = false; } } };
}
