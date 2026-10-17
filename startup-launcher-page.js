// Resolve this page's own tab before enabling the button. Passing that stable tab
// ID lets Chrome target its current window, including after the tab is moved.
export async function initializeLauncherPage(document, browser) {
    const button = document.getElementById('openSidebar');
    const status = document.getElementById('launcherStatus');
    button.disabled = true;
    if (typeof browser.sidePanel?.open !== 'function') {
        status.textContent = 'This browser cannot open the sidebar from this page. Use the Arcify toolbar icon, or update to Chrome 116 or later.';
        return;
    }
    let tab;
    try {
        tab = await browser.tabs.getCurrent();
        if (!Number.isInteger(tab?.id) || tab.id < 0) throw new Error('No browsing tab');
    } catch {
        status.textContent = 'Could not find this browsing tab. Reload this page, or use the Arcify toolbar icon.';
        return;
    }
    button.disabled = false;
    status.textContent = 'Your tabs stay where they are. Open the sidebar when you’re ready.';
    button.addEventListener('click', event => {
        if (!event.isTrusted || button.disabled) return;
        // No await, runtime message, timer, or synthetic activation before open().
        // The browser still enforces its own user-gesture requirement.
        let opening;
        try { opening = browser.sidePanel.open({ tabId: tab.id }); }
        catch { showError(); return; }
        button.disabled = true;
        status.textContent = 'Opening Arcify…';
        Promise.resolve(opening).then(() => {
            status.textContent = 'Arcify is open. You can close this tab and keep browsing.';
        }, showError).finally(() => { button.disabled = false; });
    });
    function showError() {
        status.textContent = 'The sidebar could not open. Click the button again, or use the Arcify toolbar icon.';
    }
}

if (typeof document !== 'undefined' && globalThis.chrome) initializeLauncherPage(document, chrome);
