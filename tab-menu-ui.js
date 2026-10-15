// One cancellable editor for exact live-tab aliases and saved Space bookmarks.
// Values are always text/input values, never HTML. Opening/cancelling writes nothing.
export function requestTabEdit(document, { action, value = '', saved = false, signal }) {
    if (signal?.aborted || document.getElementById('tabEditDialog')) return Promise.resolve(null);
    const previousFocus = document.activeElement;
    const overlay = document.createElement('div'); overlay.id = 'tabEditDialog'; overlay.className = 'today-folder-dialog';
    const form = document.createElement('form'); form.setAttribute('role', 'dialog'); form.setAttribute('aria-modal', 'true'); form.setAttribute('aria-labelledby', 'tabEditHeading');
    const heading = document.createElement('h2'); heading.id = 'tabEditHeading'; heading.textContent = action === 'editUrl' ? 'Edit pinned URL' : saved ? 'Rename pin' : 'Rename tab';
    const description = document.createElement('p'); description.textContent = action === 'editUrl'
        ? 'Changes the saved URL for future opens and Back to Pinned URL. Your open tab stays on its current page.'
        : saved ? 'Changes this saved pin’s name in this Space.' : 'Sets an Arcify tab name. Leave blank to use the page title.';
    const label = document.createElement('label'); label.htmlFor = 'tabEditValue'; label.textContent = action === 'editUrl' ? 'Saved URL' : 'Name';
    const input = document.createElement('input'); input.id = 'tabEditValue'; input.type = 'text'; input.value = value; input.autocomplete = 'off'; input.maxLength = action === 'editUrl' ? 16384 : 256;
    input.spellcheck = false;
    const buttons = document.createElement('div'); buttons.className = 'today-folder-buttons';
    const cancel = document.createElement('button'); cancel.id = 'tabEditCancel'; cancel.type = 'button'; cancel.textContent = 'Cancel';
    const save = document.createElement('button'); save.id = 'tabEditSave'; save.type = 'submit'; save.textContent = 'Save';
    const valid = () => input.value.length <= input.maxLength && (!(saved || action === 'editUrl') || Boolean(input.value.trim()));
    save.disabled = !valid(); buttons.append(cancel, save); form.append(heading, description, label, input, buttons); overlay.append(form); document.body.append(overlay);
    return new Promise(resolve => {
        let settled = false;
        const finish = result => {
            if (settled) return; settled = true; signal?.removeEventListener('abort', abort); overlay.remove();
            if (previousFocus?.isConnected) previousFocus.focus?.({ preventScroll: true });
            resolve(result);
        };
        const abort = () => finish(null);
        signal?.addEventListener('abort', abort, { once: true });
        input.addEventListener('input', () => { save.disabled = !valid(); });
        form.addEventListener('submit', event => { event.preventDefault(); if (valid()) finish(input.value); });
        cancel.addEventListener('click', () => finish(null));
        overlay.addEventListener('click', event => { if (event.target === overlay) finish(null); });
        overlay.addEventListener('keydown', event => {
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(null); }
            if (event.key === 'Tab') {
                const controls = [input, cancel, ...(!save.disabled ? [save] : [])];
                const index = controls.indexOf(document.activeElement);
                event.preventDefault(); controls[(index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length].focus();
            }
        });
        input.focus(); input.select?.();
    });
}

export function createTabMenuActions({ document, getContext, sendRequest, showStatus, begin = () => {}, end = () => {}, refresh = async () => {}, copy = text => navigator.clipboard.writeText(text) }) {
    let pending = false, editController = null;
    function actionsFor(target, { selectionCount = 1, muted = false } = {}) {
        const execute = async (action, useCurrent = false) => {
            if (pending || selectionCount > 1) return;
            pending = true; begin(); let attempted = false;
            const editor = ['rename', 'editUrl'].includes(action) && !useCurrent ? new AbortController() : null;
            if (editor) editController = editor;
            const request = async (verb, extra = {}) => {
                const context = getContext();
                if (context.windowId !== target.windowId || context.spaceId !== target.spaceId) throw new Error('The active Space changed. Reopen the menu.');
                const result = await sendRequest({ type: 'tabMenuAction', ...target, action: verb, ...extra });
                if (!result?.success) throw new Error(result?.error || 'The action could not be confirmed. Check the row before trying again.');
                return result;
            };
            try {
                if (action === 'copyLink') {
                    const result = await request(action); await copy(result.url); showStatus('Link copied.'); return;
                }
                let extra = {};
                if (action === 'rename' || action === 'editUrl') {
                    const current = await request('describe');
                    if (editor?.signal.aborted) return;
                    const value = useCurrent ? current.currentUrl : await requestTabEdit(document, { action, saved: Boolean(target.bookmarkId), value: action === 'rename' ? current.title : current.url, signal: editor?.signal });
                    if (value === null) return;
                    if (useCurrent && !value) throw new Error('This tab has no current URL.');
                    extra = { value, expected: current.expected };
                } else if (action === 'mute') {
                    const current = await request('describe'); extra = { value: !current.muted };
                }
                // Once Save was submitted, later menus cannot cancel or hide its result.
                if (editController === editor) editController = null;
                attempted = true; await request(action, extra);
                showStatus(({ rename: 'Name saved.', editUrl: 'Pinned URL saved. Your open page is unchanged.', mute: extra.value ? 'Tab muted.' : 'Tab unmuted.', duplicate: 'Tab duplicated in this Space.', removePin: 'Pin removed. Open tabs stay open.' })[action]);
            } catch (error) { if (!editor?.signal.aborted) showStatus(error.message); }
            finally {
                if (editController === editor) editController = null;
                pending = false; end();
                if (attempted) try { await refresh(); } catch { showStatus('The sidebar could not refresh. Reload it before trying again.'); }
            }
        };
        return { selectionCount, muted, copyLink: () => execute('copyLink'), rename: () => execute('rename'),
            ...(target.bookmarkId ? { editUrl: () => execute('editUrl'), removePin: () => execute('removePin'), ...(target.tabId ? { useCurrentUrl: () => execute('editUrl', true) } : {}) } : {}),
            ...(target.tabId ? { mute: () => execute('mute'), ...(!target.bookmarkId ? { duplicate: () => execute('duplicate') } : {}) } : {}) };
    }
    // Cancel only the unsubmitted editor/description, never an in-flight write.
    actionsFor.cancelEdit = () => editController?.abort();
    document.addEventListener('keydown', event => { if (event.key === 'Escape') actionsFor.cancelEdit(); }, true);
    return actionsFor;
}
