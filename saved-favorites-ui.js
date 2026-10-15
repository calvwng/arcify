import { Utils } from './utils.js';
import { isStartupLauncherTab } from './startup-launcher-tab.js';
import { favoriteIconCacheUrl, isFavoriteIcon } from './favorite-icons.js';

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
    let disposeMenu = () => {};
    const request = (action, payload = {}) => favoriteRequest(action, { windowId: getWindowId(), ...payload }, api);

    async function refresh() {
        const token = ++generation, windowId = getWindowId();
        if (!Number.isInteger(windowId)) return;
        try {
            const next = await request('get');
            const active = (await api.tabs.query({ windowId, active: true }))[0];
            if (token !== generation || windowId !== getWindowId()) return;
            snapshot = next;
            render(next, active?.id);
        } catch (error) {
            if (token === generation) onStatus(error.message);
        }
    }

    async function run(key, task, success = '') {
        if (pending.has(key)) return pending.get(key);
        const operation = (async () => {
            try {
                const result = await task();
                if (result?.warning || success) onStatus(result?.warning || success);
                return result;
            } catch (error) { onStatus(error.message); }
            finally { pending.delete(key); await refresh(); }
        })();
        pending.set(key, operation);
        return operation;
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
        document.getElementById('tab-context-menu')?.remove();
        const menu = document.createElement('div');
        menu.id = 'tab-context-menu'; menu.className = 'context-menu'; menu.setAttribute('role', 'menu');
        const anchor = node.getBoundingClientRect?.() || { left: 0, bottom: 0 };
        const x = event.clientX ?? anchor.left, y = event.clientY ?? anchor.bottom;
        menu.style.left = `${x}px`; menu.style.top = `${y}px`;
        const favoriteId = node.dataset.favoriteId, tabId = Number(node.dataset.tabId), windowId = getWindowId();
        const item = (text, action) => {
            const button = document.createElement('button'); button.type = 'button'; button.className = 'context-menu-item';
            button.textContent = text; button.setAttribute('role', 'menuitem');
            button.addEventListener('click', () => { disposeMenu(); void action(); });
            menu.appendChild(button);
        };
        item(favoriteId && !tabId ? 'Open Favorite' : 'Go to Tab', () => activate(node));
        if (favoriteId && tabId) item('Close Tab (Keep Favorite)', () => run(`close:${favoriteId}`, async () => {
            const latest = await request('get');
            if (getWindowId() !== windowId || !latest.favorites.some(record => record.id === favoriteId && record.tabId === tabId)) throw new Error('This Favorite’s open tab changed. Refresh and try again.');
            const tab = await api.tabs.get(tabId);
            if (tab.windowId !== windowId || !tab.pinned) throw new Error('This Favorite’s open tab changed. Refresh and try again.');
            await api.tabs.remove(tabId);
        }, 'Tab closed. Your Favorite is saved.'));
        if (favoriteId) item('Remove Favorite', () => run(`remove:${favoriteId}`, () => request('remove', { favoriteId }), 'Favorite removed. Open pages and source bookmarks were kept.'));
        else item('Keep as saved Favorite', () => run(`adopt:${tabId}`, () => request('addTab', { tabId }), 'Favorite saved across Spaces and windows.'));
        const outside = event => { if (!menu.contains(event.target)) disposeMenu(); };
        const keydown = event => {
            if (event.key === 'Escape') { event.preventDefault(); disposeMenu(); node.focus(); return; }
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || !menu.contains(document.activeElement)) return;
            event.preventDefault();
            const options = [...menu.querySelectorAll('button')], current = options.indexOf(document.activeElement);
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1
                : (current + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
            options[next]?.focus();
        };
        disposeMenu = () => { menu.remove(); document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', keydown); disposeMenu = () => {}; };
        document.body.appendChild(menu);
        const bounds = menu.getBoundingClientRect?.(), viewport = document.defaultView;
        if (bounds && viewport) {
            menu.style.left = `${Math.max(5, Math.min(x, viewport.innerWidth - bounds.width - 5))}px`;
            menu.style.top = `${Math.max(5, Math.min(y, viewport.innerHeight - bounds.height - 5))}px`;
        }
        document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', keydown);
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
        node.addEventListener('dragstart', event => { node.classList.add('dragging'); onDragStart(node, event); });
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
            const state = row.saved ? (row.tabId ? 'Open in this window' : 'Closed · click to open') : 'Browser pin · not saved';
            node.title = `${row.title || row.url}\n${state}`; node.setAttribute('aria-label', `${row.title || row.url}. ${state}`);
            node.classList.toggle('favorite-closed', Boolean(row.saved && !row.tabId));
            node.classList.toggle('active', Boolean(row.tabId && row.tabId === activeTabId));
            node.querySelector('.favorite-state').textContent = row.saved ? (row.tabId ? 'Open' : 'Closed') : 'Pin';
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
        const placeholder = container.querySelector('.pinned-placeholder-container');
        if (placeholder) placeholder.style.display = rows.length ? 'none' : 'block';
        let notice = document.getElementById('nativeFavoritesNotice');
        if (!notice) { notice = document.createElement('p'); notice.id = 'nativeFavoritesNotice'; notice.className = 'native-favorites-notice'; container.after(notice); }
        notice.textContent = 'Browser pins are kept as they are. Right-click one and choose “Keep as saved Favorite” to keep its icon after closing.';
        notice.hidden = !rows.some(row => !row.saved);
    }

    return { refresh, request, getSnapshot: () => snapshot, dispose() { ++generation; disposeMenu(); } };
}
