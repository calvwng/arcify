import { createContextMenuSession } from './context-menu-session.js';
import { Utils } from './utils.js';
import { isStartupLauncherTab } from './startup-launcher-tab.js';
import { favoriteIconCacheUrl, isFavoriteIcon } from './favorite-icons.js';
import { createFavoriteAttachmentUI } from './favorite-attachment-ui.js';

// The background worker is the sole durable Favorites writer. Never send a
// cached record/URL or whole-array order back from a sidebar.
export async function favoriteRequest(action, payload, api = globalThis.chrome) {
    const response = await api.runtime.sendMessage({ type: 'favoriteStore', action, ...payload });
    if (!response?.success) {
        const error = new Error(response?.error || 'Saved Favorites are temporarily unavailable.');
        error.code = response?.code;
        if (response?.batch) error.batch = response.batch;
        throw error;
    }
    return response;
}

export function savedDropBeforeId(container, target, position, movingId = null) {
    const saved = [...container.querySelectorAll('.saved-favorite')].filter(node => node.dataset.favoriteId !== movingId);
    if (!target?.dataset.favoriteId) return null;
    const index = saved.indexOf(target);
    if (index < 0) return null;
    return (position === 'left' ? saved[index] : saved[index + 1])?.dataset.favoriteId || null;
}

export function createSavedFavoritesUI({ document, container, getWindowId, onStatus = () => {},
    onDragStart = () => {}, onDragEnd = () => {}, api = globalThis.chrome }) {
    let generation = 0, snapshot = { favorites: [], nativeTabs: [] };
    const pending = new Map();
    let disposed = false;
    const recoveryPanel = document.createElement('section');
    recoveryPanel.className = 'favorite-recovery-review';
    recoveryPanel.setAttribute('aria-label', 'Recovered Favorites to review');
    recoveryPanel.hidden = true;
    container.after(recoveryPanel);
    let disposeMenu = () => {};
    const request = (action, payload = {}) => favoriteRequest(action, { windowId: getWindowId(), ...payload }, api);
    const attachment = createFavoriteAttachmentUI({ document, getWindowId, request, onStatus, onAttached: () => refresh() });

    async function refresh() {
        if (disposed) return;
        attachment.validate();
        const token = ++generation, windowId = getWindowId();
        if (!Number.isInteger(windowId)) return;
        try {
            const next = await request('get');
            const active = (await api.tabs.query({ windowId, active: true }))[0];
            if (token !== generation || windowId !== getWindowId()) return;
            snapshot = next;
            render(next, active?.id);
            attachment.validate();
        } catch (error) {
            if (token === generation) onStatus(error.message);
        }
    }

    async function run(key, task, success = '') {
        if (pending.has(key)) return pending.get(key);
        const operationWindowId = getWindowId();
        const isCurrent = () => !disposed && operationWindowId === getWindowId();
        const operation = (async () => {
            try {
                const result = await task();
                if (isCurrent() && (result?.warning || success)) onStatus(result?.warning || success);
                return result;
            } catch (error) { if (isCurrent()) onStatus(error.message); }
            finally { pending.delete(key); if (isCurrent()) await refresh(); }
        })();
        pending.set(key, operation);
        return operation;
    }

    function reviewRecovery(action, favoriteId, tabId, token, windowId) {
        return run(`recovery:${favoriteId}`, async () => {
            const current = snapshot.favorites.find(row => row.id === favoriteId);
            if (disposed || getWindowId() !== windowId || current?.tabId !== tabId || current?.recovery?.token !== token) {
                throw new Error('This recovered Favorite changed. Refresh and review it again.');
            }
            return request(action, { favoriteId, tabId, token, windowId });
        }, action === 'undoRecovery' ? 'Recovery undone. Your tab and saved Favorite were kept.' : 'Recovered tab confirmed.');
    }

    function renderRecoveryReview(favorites) {
        const existing = new Map([...recoveryPanel.children].map(card => [card.dataset.favoriteId, card]));
        for (const row of favorites.filter(row => row.tabId && row.recovery?.token)) {
            const windowId = getWindowId(), token = row.recovery.token;
            let card = existing.get(row.id);
            existing.delete(row.id);
            if (!card || card.dataset.token !== token || card.dataset.windowId !== String(windowId) || card.dataset.tabId !== String(row.tabId)) {
                card?.remove();
                card = document.createElement('div');
                card.className = 'favorite-recovery-card';
                Object.assign(card.dataset, { favoriteId: row.id, token, tabId: String(row.tabId), windowId: String(windowId) });
                const label = document.createElement('p');
                card.appendChild(label);
                for (const [text, action] of [['Undo', 'undoRecovery'], ['Confirm', 'confirmRecovery']]) {
                    const button = document.createElement('button');
                    button.type = 'button'; button.textContent = text;
                    button.setAttribute('aria-label', `${text} recovery for ${row.title || row.url}`);
                    button.addEventListener('click', () => void reviewRecovery(action, row.id, row.tabId, token, windowId));
                    card.appendChild(button);
                }
            }
            card.querySelector('p').textContent = `Recovered: ${row.title || row.url}. Review this tab association.`;
            recoveryPanel.appendChild(card);
        }
        for (const card of existing.values()) card.remove();
        recoveryPanel.hidden = !recoveryPanel.children.length;
    }

    async function activate(node) {
        const favoriteId = node.dataset.favoriteId;
        if (favoriteId) return run(`open:${favoriteId}`, () => request('open', { favoriteId }));
        const tabId = Number(node.dataset.tabId), windowId = getWindowId();
        return run(`open-native:${tabId}`, async () => {
            const tab = await api.tabs.get(tabId);
            if (windowId !== getWindowId() || tab.windowId !== windowId || !tab.pinned) throw new Error('This pinned tab changed. Refresh and try again.');
            await api.tabs.update(tabId, { active: true });
        });
    }

    function menu(node, event) {
        event.preventDefault(); event.stopPropagation();
        disposeMenu();
        attachment.close();
        const session = createContextMenuSession(document, { onEscape: () => { if (node.isConnected) node.focus(); } });
        disposeMenu = session.close;
        document.getElementById('tab-context-menu')?.remove();
        const menu = document.createElement('div');
        menu.id = 'tab-context-menu'; menu.className = 'context-menu'; menu.setAttribute('role', 'menu');
        const anchor = node.getBoundingClientRect?.() || { left: 0, bottom: 0 };
        const x = event.clientX ?? anchor.left, y = event.clientY ?? anchor.bottom;
        menu.style.left = `${x}px`; menu.style.top = `${y}px`;
        const favoriteId = node.dataset.favoriteId, tabId = Number(node.dataset.tabId), windowId = getWindowId();
        const recoveryToken = node.dataset.recoveryToken;
        const item = (text, action) => {
            const button = document.createElement('button'); button.type = 'button'; button.className = 'context-menu-item';
            button.textContent = text; button.setAttribute('role', 'menuitem');
            button.addEventListener('click', () => { if (!session.active) return; session.close(); void action(); });
            menu.appendChild(button);
        };
        item(favoriteId && !tabId ? 'Open Favorite' : 'Go to Tab', () => activate(node));
        if (favoriteId && !tabId) item('Attach existing tab…', () => attachment.open(node, favoriteId, windowId));
        if (recoveryToken) {
            item('Undo recovery', () => reviewRecovery('undoRecovery', favoriteId, tabId, recoveryToken, windowId));
            item('Confirm recovered tab', () => reviewRecovery('confirmRecovery', favoriteId, tabId, recoveryToken, windowId));
        }
        if (tabId && !recoveryToken) item('Move to New Window', () => run(`move-window:${tabId}`, async () => {
            if (getWindowId() !== windowId) throw new Error('This window changed. Reopen the menu.');
            const result = await api.runtime.sendMessage({ type: 'moveTabToNewWindow', windowId, tabId, ...(favoriteId ? { favoriteId } : {}) });
            if (!result?.success) throw new Error(result?.error || 'Move not confirmed. Check your windows before retrying.');
        }, 'Tab moved to a new window. Your Favorite is kept.'));
        if (favoriteId && tabId && !recoveryToken) item('Close Tab (Keep Favorite)', () => run(`close:${favoriteId}`, async () => {
            if (getWindowId() !== windowId) throw new Error('This Favorite’s window changed. Refresh and try again.');
            await request('closeTab', { favoriteId, tabId });
        }, 'Tab closed. Your Favorite is saved.'));
        if (favoriteId && !recoveryToken) item('Remove Favorite', () => run(`remove:${favoriteId}`, () => request('remove', { favoriteId }), 'Favorite removed. Open pages and source bookmarks were kept.'));
        else if (!favoriteId) item('Keep as saved Favorite', () => run(`adopt:${tabId}`, () => request('addTab', { tabId }), 'Favorite saved across Spaces and windows.'));
        const keydown = event => {
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || !menu.contains(document.activeElement)) return;
            event.preventDefault();
            const options = [...menu.querySelectorAll('button')], current = options.indexOf(document.activeElement);
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1
                : (current + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
            options[next]?.focus();
        };
        if (!session.attach(menu)) return;
        session.onClose(() => document.removeEventListener('keydown', keydown));
        const bounds = menu.getBoundingClientRect?.(), viewport = document.defaultView;
        if (bounds && viewport) {
            menu.style.left = `${Math.max(5, Math.min(x, viewport.innerWidth - bounds.width - 5))}px`;
            menu.style.top = `${Math.max(5, Math.min(y, viewport.innerHeight - bounds.height - 5))}px`;
        }
        document.addEventListener('keydown', keydown);
        menu.firstElementChild?.focus();
    }

    function createNode(saved) {
        const node = document.createElement('div');
        node.className = `pinned-favicon ${saved ? 'saved-favorite' : 'native-favorite'}`;
        node.setAttribute('role', 'button'); node.tabIndex = 0; node.draggable = true;
        const img = document.createElement('img'); img.alt = ''; node.appendChild(img);
        const state = document.createElement('span'); state.className = 'favorite-state'; state.setAttribute('aria-hidden', 'true'); node.appendChild(state);
        node.addEventListener('click', () => void activate(node));
        node.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void activate(node); }
            if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) menu(node, event);
        });
        node.addEventListener('contextmenu', event => menu(node, event));
        node.addEventListener('dragstart', event => { if (node.dataset.recoveryToken) { event.preventDefault(); return; } node.classList.add('dragging'); onDragStart(node, event); });
        node.addEventListener('dragend', event => { node.classList.remove('dragging'); onDragEnd(node, event); });
        return node;
    }

    function render({ favorites = [], nativeTabs = [] }, activeTabId) {
        const existing = new Map([...container.querySelectorAll('.pinned-favicon')].map(node => [node.dataset.favoriteId ? `saved:${node.dataset.favoriteId}` : `native:${node.dataset.tabId}`, node]));
        const rows = [
            ...favorites.map(record => ({ ...record, saved: true, key: `saved:${record.id}` })),
            ...nativeTabs.filter(tab => !isStartupLauncherTab(tab)).sort((a, b) => a.index - b.index).map(tab => ({ ...tab, tabId: tab.id, key: `native:${tab.id}` }))
        ];
        for (const row of rows) {
            const node = existing.get(row.key) || createNode(row.saved);
            existing.delete(row.key);
            if (row.saved) node.dataset.favoriteId = row.id;
            if (row.tabId) node.dataset.tabId = String(row.tabId); else delete node.dataset.tabId;
            const recovered = Boolean(row.saved && row.tabId && row.recovery?.token);
            if (recovered) node.dataset.recoveryToken = row.recovery.token; else delete node.dataset.recoveryToken;
            node.draggable = !recovered;
            const state = recovered ? 'Recovered - review or undo the tab association below' : row.saved ? (row.tabId ? 'Open in this window' : 'Closed · click to open') : 'Browser pin · not saved';
            const recovery = row.saved && !row.tabId ? '. Right-click or press Shift+F10 to attach an existing tab' : '';
            node.title = `${row.title || row.url}\n${state}${recovery}`; node.setAttribute('aria-label', `${row.title || row.url}. ${state}${recovery}`);
            node.classList.toggle('favorite-closed', Boolean(row.saved && !row.tabId));
            node.classList.toggle('active', Boolean(row.tabId && row.tabId === activeTabId));
            node.querySelector('.favorite-state').textContent = recovered ? 'Recovered' : row.saved ? (row.tabId ? 'Open' : 'Closed') : 'Pin';
            const img = node.querySelector('img');
            const cached = row.saved && favoriteIconCacheUrl(row.url, api) || Utils.getFaviconUrl(row.url, '96');
            const icon = row.saved && isFavoriteIcon(row.faviconDataUrl) ? row.faviconDataUrl : cached;
            // Record the intended source separately from fallback src. Ordinary
            // refreshes must not repeatedly retry a failed image or revive an old
            // error handler after a new retained icon arrives.
            if (img.dataset.favoriteIcon !== icon) {
                img.dataset.favoriteIcon = icon;
                let fallback = icon === cached ? 'assets/default_icon.png' : cached;
                img.onerror = () => {
                    if (img.dataset.favoriteIcon !== icon) return;
                    img.src = fallback;
                    if (fallback === 'assets/default_icon.png') img.onerror = null;
                    else fallback = 'assets/default_icon.png';
                };
                img.src = icon;
            }
            container.appendChild(node);
        }
        for (const node of existing.values()) node.remove();
        renderRecoveryReview(favorites);
        const placeholder = container.querySelector('.pinned-placeholder-container');
        if (placeholder) placeholder.style.display = rows.length ? 'none' : 'block';
    }

    return { refresh, request, getSnapshot: () => snapshot, dispose() { disposed = true; recoveryPanel.remove(); ++generation; disposeMenu(); attachment.dispose(); } };
}
