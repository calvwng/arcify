import { STARTUP_LAUNCHER_PATH, isStartupLauncherTab, isStartupLauncherUrl } from './startup-launcher-tab.js';

export const STARTUP_LAUNCHER_SETTING = 'startupLauncherEnabled';
export const STARTUP_LAUNCHER_SESSION = 'arcifyStartupLauncherSession';
export const STARTUP_LAUNCHER_ALARM = 'arcifyStartupLauncher';
const SETTLE_MS = 750;
const FOREGROUND_MS = 3000;

// This controller creates an ordinary tab only. Opening the side panel is reserved
// for a real click in that tab. Session storage survives service-worker suspension.
export function registerStartupLauncher(browser = globalThis.chrome, {
    setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now,
    reportError = error => console.warn('Arcify startup launcher:', error)
} = {}) {
    let chain = Promise.resolve();
    let timer;
    let startupView = null;
    let activity = 0;
    const enqueue = task => {
        const result = chain.then(task);
        chain = result.catch(reportError);
        return chain;
    };
    const readState = async () => (await browser.storage.session.get(STARTUP_LAUNCHER_SESSION))[STARTUP_LAUNCHER_SESSION];
    const writeState = state => browser.storage.session.set({ [STARTUP_LAUNCHER_SESSION]: state });
    const isEnabled = async () => (await browser.storage.sync.get({ [STARTUP_LAUNCHER_SETTING]: false }))[STARTUP_LAUNCHER_SETTING] === true;
    const normalWindows = async () => (await browser.windows.getAll({ windowTypes: ['normal'] }))
        .filter(window => window.type === 'normal' && !window.incognito);
    const clearWake = async () => {
        clearTimer(timer);
        timer = undefined;
        await browser.alarms.clear(STARTUP_LAUNCHER_ALARM);
    };
    const schedule = async state => {
        clearTimer(timer);
        timer = setTimer(() => enqueue(reconcile), SETTLE_MS);
        // The timer makes startup prompt; an alarm is the durable fallback if the
        // worker is suspended. Chrome may delay alarms, so a late launch stays quiet.
        if (state.pending) await browser.alarms.create(STARTUP_LAUNCHER_ALARM, { when: state.fallbackAt });
    };

    async function reconcile() {
        const state = await readState();
        if (!state || (!state.pending && !state.createdTabId)) return;
        if (!await isEnabled()) {
            await writeState({ pending: false });
            await clearWake();
            return;
        }
        const windows = await normalWindows();
        const windowIds = new Set(windows.map(window => window.id));
        const tabs = await browser.tabs.query({});
        const launchers = tabs.filter(tab => windowIds.has(tab.windowId) && isStartupLauncherTab(tab, browser));

        if (!state.pending) {
            // A restored launcher can arrive after our create. Remove only the
            // redundant tab we created, never a restored or manually opened tab.
            if (launchers.some(tab => tab.id !== state.createdTabId)) {
                let created;
                try { created = await browser.tabs.get(state.createdTabId); } catch { /* Already closed. */ }
                if (created) {
                    const siblings = await browser.tabs.query({ windowId: created.windowId });
                    created = siblings.find(tab => tab.id === state.createdTabId);
                    const stillLauncher = isStartupLauncherTab(created, browser)
                        && (!created.pendingUrl || isStartupLauncherUrl(created.pendingUrl, browser));
                    // Do not close a browser window or an outbound navigation just
                    // to remove a redundant helper. A moved tab is also left alone.
                    if (stillLauncher && siblings.some(tab => tab.id !== created.id)) await browser.tabs.remove(created.id);
                }
                await writeState({ pending: false });
            }
            return;
        }

        if (launchers.length) {
            await writeState({ pending: false });
            await clearWake();
            return; // Reuse restored tabs without changing selection or focus.
        }

        // Do not create a window. Wait for a normal browsing window with a tab;
        // popups, DevTools and incognito windows are never startup targets.
        const candidates = windows.filter(window => tabs.some(tab => tab.windowId === window.id));
        const target = candidates.find(window => window.focused) || candidates[0];
        if (!target) {
            await clearWake();
            return; // onCreated resumes this persisted pending request.
        }
        const activeTab = tabs.find(tab => tab.windowId === target.id && tab.active);
        const active = Boolean(startupView && now() <= startupView.until && activity === startupView.activity
            && target.focused && target.id === startupView.windowId && activeTab?.id === startupView.tabId);
        // Claim before creation: neither a second event nor a worker restart can
        // create another tab if Chrome has already accepted the create operation.
        await writeState({ pending: false });
        await clearWake();
        try {
            const tab = await browser.tabs.create({ windowId: target.id,
                url: browser.runtime.getURL(STARTUP_LAUNCHER_PATH),
                active: active && activity === startupView.activity && now() <= startupView.until });
            await writeState({ pending: false, createdTabId: tab.id });
            await reconcile(); // Catch a restore that raced the create call.
        } catch (error) {
            // Do not retry a possibly accepted create. A later browser startup can
            // try again; existing browsing tabs and saved settings remain intact.
            reportError(error);
        }
    }

    function start() {
        const startedAt = now();
        const initialActivity = activity;
        return enqueue(async () => {
            if (await readState()) return; // At most once in this browser session.
            if (!await isEnabled()) {
                await writeState({ pending: false });
                return;
            }
            const windows = await normalWindows();
            const focused = windows.find(window => window.focused);
            const tabs = focused ? await browser.tabs.query({ windowId: focused.id }) : [];
            const activeTab = tabs.find(tab => tab.active);
            if (focused && activeTab) startupView = { windowId: focused.id, tabId: activeTab.id,
                activity: initialActivity, until: startedAt + FOREGROUND_MS };
            const state = { pending: true, fallbackAt: startedAt + 30000 };
            await writeState(state);
            await schedule(state);
        });
    }

    const onTab = tab => enqueue(async () => {
        const state = await readState();
        if (state?.pending || (state?.createdTabId && isStartupLauncherTab(tab, browser))) await schedule(state);
    });
    browser.runtime.onStartup.addListener(start);
    browser.windows.onCreated.addListener(() => onTab());
    browser.windows.onFocusChanged.addListener(() => { activity++; });
    browser.tabs.onActivated.addListener(() => { activity++; });
    browser.tabs.onCreated.addListener(onTab);
    browser.tabs.onUpdated.addListener((id, change, tab) => {
        // Count navigation even while start() is awaiting its initial snapshot.
        // Conservatively treat restoration/loading activity as a reason to stay quiet.
        if (change.url || change.status === 'loading') activity++;
        if (change.url || change.status === 'complete') onTab(tab);
    });
    browser.alarms.onAlarm.addListener(alarm => {
        if (alarm.name === STARTUP_LAUNCHER_ALARM) return enqueue(reconcile);
    });
    const ready = enqueue(async () => {
        const state = await readState();
        if (state?.pending) await schedule(state);
        else if (state?.createdTabId) await reconcile();
    });
    return { ready, start, flush: () => enqueue(reconcile) };
}
