// Only an attention button and on-demand dialog, never a separate pin section.
export function createSplitPinRecoveryUI({ document, sendRequest, context, refresh, showStatus }) {
    const button = document.createElement('button');
    button.type = 'button'; button.id = 'splitPinRecovery'; button.hidden = true;
    button.textContent = 'Review saved pair recovery';
    document.getElementById('favoritesDropNotice').after(button);
    let dialog = null, busy = false;
    const request = async (action, extra = {}, captured = context()) => {
        const result = await sendRequest({ type: 'splitPinAction', action, ...captured, ...extra });
        if (!result?.success) throw new Error(result?.error || 'Recovery was not confirmed. Refresh before trying again.');
        return result;
    };
    const close = () => { dialog?.close(); dialog?.remove(); dialog = null; button.focus(); };
    const open = async () => {
        if (busy || dialog) return;
        busy = true;
        try {
            const captured = { ...context() };
            const result = await request('recoveryList', {}, captured);
            if (!result.items?.length) { button.hidden = true; showStatus('No interrupted saved pair needs review.'); return; }
            dialog = document.createElement('dialog'); dialog.className = 'split-pin-recovery-dialog';
            const title = document.createElement('h2'); title.id = 'splitPinRecoveryTitle'; title.textContent = 'Recover saved pairs';
            dialog.setAttribute('aria-labelledby', title.id); dialog.append(title);
            const description = document.createElement('p'); description.textContent = 'Choose a bookmark explicitly to use for a saved pair. No pages will open, and other bookmarks will remain untouched.'; dialog.append(description);
            const status = document.createElement('p'); status.setAttribute('role', 'status'); dialog.append(status);
            for (const item of result.items) {
                const group = document.createElement('fieldset'); const legend = document.createElement('legend'); legend.textContent = item.recipe.name; group.append(legend);
                const pages = document.createElement('p'); pages.textContent = item.recipe.pages.map(page => page.url).join(' + '); group.append(pages);
                const act = async (action, extra) => {
                    if (busy) return; busy = true;
                    dialog.querySelectorAll('button').forEach(node => { node.disabled = true; });
                    try {
                        await request(action, { recipe: item.recipe, ...extra }, captured);
                        close(); await refresh();
                        showStatus(action === 'defer' ? 'Saved pair kept for later. Other pairs can be pinned; no bookmark was retried or removed.' : 'Selected bookmark now represents the saved pair. No pages opened; other bookmarks were left untouched.');
                    } catch (error) { status.textContent = error.message; }
                    finally { busy = false; dialog?.querySelectorAll('button').forEach(node => { node.disabled = false; }); }
                };
                for (const candidate of item.candidates) {
                    const use = document.createElement('button'); use.type = 'button';
                    use.textContent = `Use this bookmark: ${candidate.title} · ${candidate.spaceName} / ${candidate.parentName} · ID ${candidate.bookmarkId}`;
                    use.addEventListener('click', () => void act('recover', { candidate })); group.append(use);
                }
                if (!item.candidates.length) { const empty = document.createElement('p'); empty.textContent = 'No eligible bookmark is visible. Refresh later, or keep the recipe for later without retrying creation.'; group.append(empty); }
                const defer = document.createElement('button'); defer.type = 'button'; defer.textContent = 'Keep recipe for later';
                defer.addEventListener('click', () => void act('defer')); group.append(defer); dialog.append(group);
            }
            const reload = document.createElement('button'); reload.type = 'button'; reload.textContent = 'Refresh';
            reload.addEventListener('click', () => { close(); void open(); }); dialog.append(reload);
            const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Close'; cancel.addEventListener('click', close); dialog.append(cancel);
            dialog.addEventListener('cancel', event => { event.preventDefault(); if (!busy) close(); });
            document.body.append(dialog); dialog.showModal();
        } catch (error) { showStatus(error.message); }
        finally { busy = false; }
    };
    button.addEventListener('click', () => void open());
    return { update(state) { button.hidden = !(state?.pins || []).some(pin => ['pending', 'deferred'].includes(pin.phase)); } };
}
