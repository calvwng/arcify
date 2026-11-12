export const STARTUP_LAUNCHER_PATH = 'startup-launcher.html';

// Match only our helper page, including a pending navigation during session restore.
export function isStartupLauncherUrl(url, browser = globalThis.chrome) {
    if (typeof url !== 'string' || !browser?.runtime?.getURL) return false;
    const actual = url.split(/[?#]/, 1)[0];
    return [STARTUP_LAUNCHER_PATH, 'startup-prompt.html'].some(path => actual === browser.runtime.getURL(path));
}

export function isStartupLauncherTab(tab, browser = globalThis.chrome) {
    return isStartupLauncherUrl(tab?.url, browser) || isStartupLauncherUrl(tab?.pendingUrl, browser);
}
