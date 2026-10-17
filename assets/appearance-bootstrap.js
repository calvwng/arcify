// Parser-blocking, packaged script: paint the last validated profile preference
// before styles/content. This cache is only a first-paint hint; chrome.storage
// remains authoritative and the lifecycle-owned module observes later changes.
(() => {
    let mode = 'system';
    try {
        const cached = localStorage.getItem('arcify-theme-mode');
        if (cached === 'light' || cached === 'dark') mode = cached;
    } catch { /* Storage can be unavailable; System is the safe default. */ }
    const dark = mode === 'dark' || (mode === 'system' && globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches);
    const root = document.documentElement;
    root.dataset.themeMode = mode;
    root.dataset.theme = dark ? 'dark' : 'light';
    root.style.colorScheme = root.dataset.theme;
})();
