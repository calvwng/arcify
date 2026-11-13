// Suggestions are presentation only. The worker issues short-lived, exact-tab
// tickets and rechecks ownership when the user explicitly confirms one.
const display = (value, limit) => String(value || '').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, limit);

export function createFavoriteAttachmentUI({ document, getWindowId, request, onStatus, onAttached }) {
    let current = null;
    const close = (restore = false) => {
        const session = current;
        if (!session) return;
        current = null;
        for (const cleanup of session.cleanups) cleanup();
        session.dialog.remove();
        if (restore && session.node.isConnected) session.node.focus();
    };
    async function open(node, favoriteId, windowId) {
        close();
        if (windowId !== getWindowId() || document.hidden || document.visibilityState === 'hidden') return;
        const dialog = document.createElement('dialog');
        dialog.className = 'favorite-attachment-dialog';
        dialog.setAttribute('aria-labelledby', 'favorite-attachment-title');
        dialog.setAttribute('aria-describedby', 'favorite-attachment-help');
        const title = document.createElement('h2'); title.id = 'favorite-attachment-title'; title.textContent = 'Attach existing tab';
        const help = document.createElement('p'); help.id = 'favorite-attachment-help';
        help.textContent = 'Choose an open tab in this window. Its current page and your saved shortcut stay unchanged.';
        const list = document.createElement('fieldset'); list.className = 'favorite-attachment-list';
        const legend = document.createElement('legend'); legend.textContent = 'Choose a tab'; list.appendChild(legend);
        const status = document.createElement('p'); status.setAttribute('role', 'status'); status.textContent = 'Loading open tabs…';
        const actions = document.createElement('div'); actions.className = 'favorite-attachment-actions';
        const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel';
        const confirm = document.createElement('button'); confirm.type = 'button'; confirm.textContent = 'Attach to this Favorite'; confirm.disabled = true;
        actions.append(cancel, confirm); dialog.append(title, help, list, status, actions);
        const session = { dialog, node, favoriteId, windowId, cleanups: [], busy: false, selected: null };
        current = session;
        const alive = () => current === session && windowId === getWindowId() && node.isConnected
            && node.dataset.favoriteId === favoriteId && !node.dataset.tabId
            && !document.hidden && document.visibilityState !== 'hidden';
        // Completion may arrive after the sidebar was hidden, disposed, or
        // replaced. Never present that result on a different interaction.
        const present = () => current === session && windowId === getWindowId()
            && !document.hidden && document.visibilityState !== 'hidden';
        const listen = (target, name, handler, capture = false) => {
            target.addEventListener(name, handler, capture);
            session.cleanups.push(() => target.removeEventListener(name, handler, capture));
        };
        listen(cancel, 'click', () => { if (!session.busy) close(true); });
        listen(dialog, 'cancel', event => { event.preventDefault(); if (!session.busy) close(true); });
        listen(document, 'keydown', event => {
            if (current !== session) return;
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!session.busy) close(true); }
            if (event.key === 'Tab') {
                const all = [...dialog.querySelectorAll('input, button')].filter(element => !element.disabled);
                const radios = all.filter(element => element.tagName === 'INPUT');
                const radioStop = radios.find(element => element.checked) || radios[0];
                const controls = all.filter(element => element.tagName !== 'INPUT' || element === radioStop);
                const first = controls[0], last = controls.at(-1);
                if (!controls.length) { event.preventDefault(); return; }
                if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
                else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
            }
        }, true);
        listen(document.defaultView, 'pagehide', () => close());
        listen(document.defaultView, 'blur', event => { if (event.target === event.currentTarget) close(); });
        listen(document, 'visibilitychange', () => { if (document.hidden || document.visibilityState === 'hidden') close(); });
        listen(confirm, 'click', async () => {
            if (session.busy || !session.selected) return;
            if (!alive()) { close(); onStatus('This Favorite or window changed. Open Attach existing tab again.'); return; }
            session.busy = true;
            for (const control of dialog.querySelectorAll('input, button')) control.disabled = true;
            status.textContent = 'Attaching tab…';
            try {
                const { tabId, token } = session.selected;
                const result = await request('attachExisting', { windowId, favoriteId, tabId, token });
                if (present()) {
                    close(true);
                    onStatus(result?.warning || 'Tab attached. Its current page and your saved shortcut were kept.');
                    await onAttached();
                } else if (current === session) close();
            } catch (error) {
                if (present()) {
                    close(true);
                    onStatus(error.message);
                    await onAttached();
                } else if (current === session) close();
            }
        });
        document.body.appendChild(dialog);
        if (dialog.showModal) dialog.showModal(); else dialog.setAttribute('open', '');
        cancel.focus();
        try {
            const response = await request('attachmentCandidates', { windowId, favoriteId });
            if (!alive()) { if (current === session) close(); return; }
            title.textContent = `Attach to ${display(response.favorite.title || response.favorite.url, 200)}`;
            const candidates = response.candidates || [];
            status.textContent = candidates.length ? (response.truncated ? 'Showing the first available tabs. Close this dialog and narrow your open tabs if needed.' : 'Select a tab, then confirm. Tabs from the same site are suggestions only.')
                : 'No available tabs in this window. Tabs already attached to a Favorite are not listed.';
            for (const candidate of candidates) {
                const label = document.createElement('label'); label.className = 'favorite-attachment-candidate';
                const radio = document.createElement('input'); radio.type = 'radio'; radio.name = 'favorite-attachment-choice'; radio.value = String(candidate.tabId);
                const text = document.createElement('span');
                const name = document.createElement('strong'); name.textContent = display(candidate.title || candidate.url, 200);
                const url = document.createElement('span'); url.textContent = display(candidate.url, 2048);
                const detail = document.createElement('small');
                detail.textContent = `Tab ${candidate.position} in this window - ${candidate.pinned ? 'Browser pin' : 'Ordinary tab'}${candidate.suggested ? ' - Same site as saved shortcut' : ''}`;
                text.append(name, url, detail); label.append(radio, text); list.appendChild(label);
                listen(radio, 'change', () => { if (alive() && !session.busy && radio.checked) { session.selected = candidate; confirm.disabled = false; } });
            }
        } catch (error) {
            if (current !== session) return;
            status.textContent = error.message;
        }
    }
    return { open, close, dispose: close, validate() {
        if (current && (current.windowId !== getWindowId() || !current.node.isConnected
            || current.node.dataset.favoriteId !== current.favoriteId || current.node.dataset.tabId)) close();
    } };
}
