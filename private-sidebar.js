export function createPrivateTabs(chrome, windowId) {
    if (!Number.isInteger(windowId) || windowId < 0) throw new Error('Private window unavailable');
    const valid = tab => Number.isInteger(tab?.id) && tab.id >= 0 && tab.windowId === windowId && tab.incognito === true;
    async function windowExists() {
        const owner = await chrome.windows.get(windowId);
        if (owner.id !== windowId || owner.incognito !== true) throw new Error('Private window unavailable');
    }
    async function exactTab(id) {
        if (!Number.isInteger(id) || id < 0) throw new Error('Private tab unavailable');
        await windowExists();
        const tab = await chrome.tabs.get(id);
        if (!valid(tab) || tab.id !== id) throw new Error('Private tab unavailable');
        return tab;
    }
    return {
        async list() {
            await windowExists();
            return (await chrome.tabs.query({ windowId })).filter(valid).sort((a, b) => a.index - b.index);
        },
        async activate(id) { await exactTab(id); await chrome.tabs.update(id, { active: true }); },
        async close(id) { await exactTab(id); await chrome.tabs.remove(id); },
        async create() { await windowExists(); await chrome.tabs.create({ windowId, active: true, url: 'chrome://newtab/' }); }
    };
}

export async function mountPrivateSidebar({ chrome, document, windowId }) {
    const api = createPrivateTabs(chrome, windowId);
    const root = document.createElement('main');
    root.className = 'private-sidebar';
    const heading = document.createElement('h1');
    heading.textContent = 'Private window';
    const note = document.createElement('p');
    note.textContent = 'Live tabs in this window only. Arcify does not save or archive these tabs.';
    const add = document.createElement('button');
    add.textContent = 'New private tab';
    const status = document.createElement('p');
    status.setAttribute('role', 'status');
    const list = document.createElement('div');
    list.setAttribute('aria-label', 'Private tabs');
    root.append(heading, note, add, status, list);
    document.body.replaceChildren(root);
    let revision = 0, stopped = false;
    const subscriptions = [];
    function dispose() {
        stopped = true;
        revision++;
        for (const [event, listener] of subscriptions) event.removeListener(listener);
        list.replaceChildren();
        add.disabled = true;
    }
    async function refresh() {
        if (stopped) return;
        const ticket = ++revision;
        try {
            const tabs = await api.list();
            if (stopped || ticket !== revision) return;
            const focused = list.contains(document.activeElement) ? document.activeElement?.dataset : null;
            let restoreFocus;
            const rows = tabs.map(tab => {
                const row = document.createElement('div');
                row.className = 'private-tab';
                const activate = document.createElement('button');
                activate.textContent = tab.title || 'Untitled tab';
                activate.dataset.tabId = String(tab.id);
                activate.dataset.action = 'activate';
                activate.setAttribute('aria-pressed', String(tab.active === true));
                activate.addEventListener('click', () => run(() => api.activate(tab.id)));
                const close = document.createElement('button');
                close.textContent = '×';
                close.dataset.tabId = String(tab.id);
                close.dataset.action = 'close';
                close.setAttribute('aria-label', 'Close tab');
                close.addEventListener('click', () => run(() => api.close(tab.id)));
                row.append(activate, close);
                if (focused?.tabId === String(tab.id)) restoreFocus = focused.action === 'close' ? close : activate;
                return row;
            });
            list.replaceChildren(...rows);
            if (focused) (restoreFocus || add).focus();
        } catch {
            if (ticket !== revision || stopped) return;
            list.replaceChildren();
            status.textContent = 'Private tabs unavailable. Reopen the sidebar to retry.';
        }
    }
    async function run(action) {
        if (stopped) return;
        status.textContent = '';
        try { await action(); }
        catch { status.textContent = 'This tab or window changed. Please try again.'; }
        await refresh();
    }
    add.addEventListener('click', () => run(() => api.create()));
    const subscribe = (event, listener) => { event.addListener(listener); subscriptions.push([event, listener]); };
    subscribe(chrome.tabs.onCreated, tab => { if (tab.windowId === windowId) refresh(); });
    subscribe(chrome.tabs.onUpdated, (_id, _change, tab) => { if (tab.windowId === windowId) refresh(); });
    for (const name of ['onRemoved', 'onMoved', 'onAttached', 'onDetached']) {
        subscribe(chrome.tabs[name], (_id, info) => {
            if ([info.windowId, info.newWindowId, info.oldWindowId].includes(windowId)) refresh();
        });
    }
    subscribe(chrome.tabs.onActivated, info => { if (info.windowId === windowId) refresh(); });
    subscribe(chrome.windows.onRemoved, id => {
        if (id === windowId) { dispose(); status.textContent = 'Private window closed.'; }
    });
    document.defaultView.addEventListener('pagehide', dispose, { once: true });
    await refresh();
    return { dispose, refresh };
}
