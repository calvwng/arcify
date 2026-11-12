import { STARTUP_PROMPT_SETTING, STARTUP_PROMPT_SESSION } from './startup-prompt.js';

export async function initializeStartupPrompt(document, browser, host = globalThis.window, {
    now = Date.now, wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
    setTimer = setTimeout
} = {}) {
    const button = document.getElementById('openSidebar');
    const status = document.getElementById('promptStatus');
    let target, busy = false, invalid = false;
    const expire = () => {
        invalid = true; button.disabled = true;
        status.textContent = 'This prompt has expired. Use the Arcify toolbar icon to open the sidebar.';
    };
    const cancel = () => host.close();
    document.getElementById('cancel').addEventListener('click', cancel);
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); cancel(); }
    });
    host.addEventListener('blur', expire);
    browser.tabs.onRemoved.addListener(id => { if (id === target?.tabId) expire(); });
    browser.tabs.onDetached.addListener(id => { if (id === target?.tabId) expire(); });
    browser.tabs.onReplaced.addListener((added, removed) => { if (removed === target?.tabId) expire(); });
    browser.tabs.onActivated.addListener(value => {
        if (value.windowId === target?.windowId && value.tabId !== target.tabId) expire();
    });
    browser.tabs.onUpdated.addListener((id, update) => {
        if (id === target?.tabId && ['url', 'pendingUrl'].some(key =>
            Object.hasOwn(update, key) && update[key] && update[key] !== target.url)) expire();
    });
    browser.windows.onRemoved.addListener(id => { if (id === target?.windowId) expire(); });
    browser.storage.onChanged.addListener((changes, area) => {
        if (area === 'sync' && Object.hasOwn(changes, STARTUP_PROMPT_SETTING)
            && changes[STARTUP_PROMPT_SETTING].newValue !== true) expire();
    });
    button.addEventListener('click', event => {
        if (!event.isTrusted || !host.navigator.userActivation.isActive || !document.hasFocus()
            || invalid || busy || !target || button.disabled) return;
        if (now() >= target.createdAt + 60000) { expire(); return; }
        busy = true; button.disabled = true;
        // Preserve the genuine gesture. No await, lookup, message or timer before open.
        let opening;
        try { opening = browser.sidePanel.open({ tabId: target.tabId, windowId: target.windowId }); }
        catch { fail(); return; }
        Promise.resolve(opening).then(() => host.close(), fail);
        function fail() {
            busy = false;
            if (invalid) return;
            button.disabled = false;
            status.textContent = 'Could not open Arcify. Press Enter to retry, or use the toolbar icon.';
        }
    });
    try {
        if (typeof browser.sidePanel?.open !== 'function') { expire(); return; }
        const token = new URL(host.location.href).searchParams.get('token');
        if (!token) { expire(); return; }
        // The page may load just before windows.create resolves in the worker.
        for (let attempt = 0; attempt < 20; attempt++) {
            target = (await browser.storage.session.get(STARTUP_PROMPT_SESSION))[STARTUP_PROMPT_SESSION];
            if (target?.token !== token) { expire(); return; }
            if (target.status === 'open') break;
            if (target.status !== 'creating') { expire(); return; }
            await wait(100);
        }
        const own = await browser.windows.getCurrent();
        const tab = await browser.tabs.get(target.tabId);
        const window = await browser.windows.get(target.windowId);
        const settings = await browser.storage.sync.get({ [STARTUP_PROMPT_SETTING]: false });
        if (invalid || target.status !== 'open' || own.id !== target.promptWindowId || own.type !== 'popup'
            || !own.focused || !document.hasFocus() || settings[STARTUP_PROMPT_SETTING] !== true
            || window.type !== 'normal' || window.incognito || tab.incognito || !tab.active
            || tab.windowId !== target.windowId || (tab.pendingUrl || tab.url) !== target.url
            || !Number.isFinite(target.createdAt) || now() >= target.createdAt + 60000) { expire(); return; }
        button.disabled = false;
        button.focus();
        status.textContent = 'Press Enter to open the sidebar, or Escape to cancel.';
        setTimer(expire, Math.max(1, target.createdAt + 60000 - now()));
    } catch { expire(); }
}

if (typeof document !== 'undefined' && globalThis.chrome) initializeStartupPrompt(document, chrome);
