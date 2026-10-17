export const STARTUP_LAUNCHER_PATH = 'startup-launcher.html';

// Match only our helper page, including a pending navigation during session restore.
export function isStartupLauncherUrl(url, browser = globalThis.chrome) {
    if (typeof url !== 'string' || !browser?.runtime?.getURL) return false;
    const expected = browser.runtime.getURL(STARTUP_LAUNCHER_PATH);
    return url.split(/[?#]/, 1)[0] === expected;
}

export function isStartupLauncherTab(tab, browser = globalThis.chrome) {
    return isStartupLauncherUrl(tab?.url, browser) || isStartupLauncherUrl(tab?.pendingUrl, browser);
}
