// A local name dialog has no persistence side effects. It also avoids the
// side-panel/native-prompt focus boundary discarding the selected batch.
export function requestTodayFolderName(document, count) {
    if (document.getElementById('todayFolderDialog')) return Promise.resolve(null);
    const previousFocus = document.activeElement;
    const overlay = document.createElement('div'); overlay.id = 'todayFolderDialog';
    overlay.className = 'today-folder-dialog';
    const form = document.createElement('form');
    form.setAttribute('role', 'dialog'); form.setAttribute('aria-modal', 'true'); form.setAttribute('aria-labelledby', 'todayFolderHeading');
    const heading = document.createElement('h2'); heading.id = 'todayFolderHeading'; heading.textContent = 'New pinned folder';
    const description = document.createElement('p'); description.textContent = `Save ${count} Today tab${count === 1 ? '' : 's'} in this Space. Your tabs stay open.`;
    const label = document.createElement('label'); label.htmlFor = 'todayFolderName'; label.textContent = 'Folder name';
    const input = document.createElement('input'); input.id = 'todayFolderName'; input.type = 'text'; input.maxLength = 256; input.required = true; input.autocomplete = 'off';
    const buttons = document.createElement('div'); buttons.className = 'today-folder-buttons';
    const cancel = document.createElement('button'); cancel.id = 'todayFolderCancel'; cancel.type = 'button'; cancel.textContent = 'Cancel';
    const create = document.createElement('button'); create.id = 'todayFolderCreate'; create.type = 'submit'; create.textContent = 'Create folder'; create.disabled = true;
    buttons.append(cancel, create); form.append(heading, description, label, input, buttons); overlay.append(form); document.body.append(overlay);
    return new Promise(resolve => {
        let settled = false;
        function finish(value) {
            if (settled) return; settled = true; overlay.remove();
            if (previousFocus?.isConnected) previousFocus.focus?.({ preventScroll: true });
            resolve(value);
        }
        input.addEventListener('input', () => { create.disabled = !input.value.trim(); });
        form.addEventListener('submit', event => { event.preventDefault(); const name = input.value.trim(); if (name && name.length <= 256) finish(name); });
        cancel.addEventListener('click', () => finish(null));
        overlay.addEventListener('click', event => { if (event.target === overlay) finish(null); });
        overlay.addEventListener('keydown', event => {
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(null); }
            if (event.key === 'Tab') {
                const controls = [input, cancel, ...(!create.disabled ? [create] : [])];
                const index = controls.indexOf(document.activeElement);
                const next = controls[(index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length];
                event.preventDefault(); next.focus();
            }
        });
        input.focus();
    });
}

export function describeTodayFolderOutcome(response, total) {
    if (!response || typeof response.success !== 'boolean') return 'The save result is unknown. Check Pinned before trying again; nothing was retried.';
    const batch = response?.batch;
    if (response?.success) return `Saved ${batch.completed.length} tab${batch.completed.length === 1 ? '' : 's'} in “${batch.title}”. Your tabs stay open.`;
    const error = response?.error || 'The save result is unknown. Check Pinned before trying again.';
    if (!batch?.folderId && !batch?.uncertain) return `Nothing was saved. ${error}`;
    const count = batch.completed.length;
    const extra = batch.created.length - count;
    return `${count} of ${batch.total || total} tabs fully saved${batch.folderId ? ` in “${batch.title}”` : ''}. ` +
        (extra ? `${extra} additional bookmark${extra === 1 ? '' : 's'} may need its live-tab binding checked. ` : '') +
        (batch.cleanupUncertain ? 'Live-tab binding cleanup could not be confirmed. ' : '') +
        `${error} Check the folder before trying again; nothing was retried.`;
}

export function createTodayFolderAction({ document, selection, showStatus, sendRequest, begin = () => {}, end = () => {}, refresh = async () => {} }) {
    let pending = false;
    return async snapshot => {
        if (pending) return;
        if (!selection.validate(snapshot)) { showStatus('The Today selection changed. Select the tabs again. Nothing was saved.'); return; }
        pending = true; begin();
        let attempted = false, lastStatus = '';
        const report = (...args) => { lastStatus = args[0]; showStatus(...args); };
        try {
            const title = await requestTodayFolderName(document, snapshot.entries.length);
            if (title === null) return;
            if (!selection.validate(snapshot)) { showStatus('The Today selection changed. Select the tabs again. Nothing was saved.'); return; }
            selection.clear();
            report(`Saving ${snapshot.entries.length} Today tabs…`, false, false);
            attempted = true;
            const response = await sendRequest({ type: 'saveTodayTabsInNewFolder', title,
                windowId: snapshot.windowId, spaceId: snapshot.spaceId, bookmarkFolderId: snapshot.bookmarkFolderId,
                inverted: snapshot.inverted, entries: snapshot.entries.map(({ tabId, url }) => ({ tabId, url })) });
            report(describeTodayFolderOutcome(response, snapshot.entries.length));
        } catch (error) {
            report(attempted ? 'The save result is unknown. Check Pinned before trying again; nothing was retried.' : error.message);
        } finally {
            pending = false; end();
            if (attempted) {
                try { await refresh(); }
                catch { showStatus(`${lastStatus} The sidebar could not refresh. Reload it before trying again.`); }
            }
        }
    };
}
