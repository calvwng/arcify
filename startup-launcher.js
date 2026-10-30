import { STARTUP_LAUNCHER_PATH, isStartupLauncherTab, isStartupLauncherUrl } from './startup-launcher-tab.js';
import { prepareStartupSuggestion, offerStartupSuggestion } from './startup-spotlight.js';

export const STARTUP_LAUNCHER_SETTING = 'startupLauncherEnabled';
export const STARTUP_LAUNCHER_SESSION = 'arcifyStartupLauncherSession';
export const STARTUP_LAUNCHER_ALARM = 'arcifyStartupLauncher';
const SETTLE_MS = 750;
const FOREGROUND_MS = 3000;
const RETRY_WINDOW_MS = 30000;

// This controller creates an ordinary tab only. Opening the side panel is reserved
// for a real click in that tab. Session storage survives service-worker suspension.
export function registerStartupLauncher(browser = globalThis.chrome, {
    setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now,
    beforeWindowRead = async () => {}, isExcludedWindow = () => false,
    reportError = error => console.warn('Arcify startup launcher:', error),
    prepareSuggestion = tab => prepareStartupSuggestion(browser, tab),
    offerSuggestion = context => offerStartupSuggestion(browser, context)
} = {}) {
    let chain = Promise.resolve();
    let timer;
    let startupView = null;
    let foregroundUntil = 0;
    let foregroundSuppressed = false;
    let observedFocus;
    const observedActiveTabs = new Map();
    const observedNavigations = new Map();
    const initialTabUrls = new Map();
    const changedBeforeCapture = new Set();
    const cleanupRevoked = new Set();
    const enqueue = task => {
        const result = chain.then(task);
        chain = result.catch(reportError);
        return chain;
    };
    const readState = async () => (await browser.storage.session.get(STARTUP_LAUNCHER_SESSION))[STARTUP_LAUNCHER_SESSION];
    const writeState = state => browser.storage.session.set({ [STARTUP_LAUNCHER_SESSION]: state });
    const isEnabled = async () => (await browser.storage.sync.get({ [STARTUP_LAUNCHER_SETTING]: false }))[STARTUP_LAUNCHER_SETTING] === true;
    const normalWindows = async () => {
        await beforeWindowRead();
        return (await browser.windows.getAll({ windowTypes: ['normal'] }))
            .filter(window => window.type === 'normal' && !window.incognito && !isExcludedWindow(window.id));
    };
    const clearWake = async () => {
        clearTimer(timer);
        timer = undefined;
        // Alarm housekeeping must not consume an otherwise valid startup request.
        try { await browser.alarms.clear(STARTUP_LAUNCHER_ALARM); } catch (error) { reportError(error); }
    };
    const schedule = async (state, delay = SETTLE_MS) => {
        clearTimer(timer);
        timer = setTimer(() => { timer = undefined; return enqueue(reconcile); }, delay);
        // The timer makes startup prompt; an alarm is the durable fallback if the
        // worker is suspended. Chrome may delay alarms, so a late launch stays quiet.
        if (state.pending && state.fallbackAt > now()) {
            try { await browser.alarms.create(STARTUP_LAUNCHER_ALARM, { when: state.fallbackAt }); }
            catch (error) { reportError(error); }
        }
    };
    const tabUrl = tab => tab?.pendingUrl || tab?.url || '';
    const mayForeground = () => foregroundUntil > 0 && now() <= foregroundUntil && !foregroundSuppressed;
    function captureStartupView(windows, tabs) {
        if (startupView || !mayForeground()) return false;
        const window = windows.find(window => window.focused);
        const tab = tabs.find(tab => tab.windowId === window?.id && tab.active);
        if (!window || !tab) return false;
        if (!tabUrl(tab)) {
            if (!initialTabUrls.has(tab.id)) initialTabUrls.set(tab.id, '');
            return false;
        }
        startupView = { windowId: window.id, tabId: tab.id, url: tabUrl(tab) };
        // Events may have arrived while an initial API snapshot was in flight.
        if ((observedFocus >= 0 && observedFocus !== window.id)
            || (observedActiveTabs.has(window.id) && observedActiveTabs.get(window.id) !== tab.id)
            || changedBeforeCapture.has(tab.id)
            || (observedNavigations.has(tab.id) && observedNavigations.get(tab.id) !== startupView.url)) {
            foregroundSuppressed = true;
        }
        return true;
    }

    async function tryStartupSuggestion(state, tab, active) {
        if (!active || !mayForeground() || state.suggestionAttempted) return false;
        let context;
        try { context = await prepareSuggestion(tab); }
        catch (error) { reportError(error); return false; }
        if (!context) return false;
        // Pairing/handshake readiness may finish after the user starts browsing.
        // Re-read the candidate; never select a different or late Spotlight tab.
        if (!await isEnabled()) {
            await writeState({ pending: false }); await clearWake(); return true;
        }
        const windows = await normalWindows();
        const tabs = await browser.tabs.query({ windowId: tab.windowId });
        const current = tabs.find(candidate => candidate.id === tab.id);
        if (!mayForeground() || !windows.some(window => window.id === tab.windowId && window.focused)
            || !current?.active || tabUrl(current) !== startupView?.url) {
            foregroundSuppressed = true;
            await reconcile();
            return true;
        }
        // Claim before dispatch. An interrupted worker or an uncertain reply must
        // not create a second prompt after Spotlight may already have accepted.
        state.suggestionAttempted = true;
        await writeState({ pending: false, suggestionAttempted: true });
        await clearWake();
        if (!mayForeground()) {
            await writeState(state);
            await reconcile();
            return true;
        }
        try {
            const response = await offerSuggestion(context);
            if (response?.accepted === false) {
                if (response.reason !== 'not-ready') return true;
                // A decline can mean the user typed or selected something in
                // Spotlight, activity which tabs.onUpdated cannot observe.
                foregroundSuppressed = true;
                await writeState(state);
                await reconcile();
                return true; // Only an explicit authenticated decline is safe.
            }
        } catch (error) { reportError(error); }
        return true; // Accepted, timeout, malformed or otherwise uncertain.
    }

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
                // Old session records lack original-window authority. Keep them,
                // and never reacquire cleanup permission after a native move.
                if (Number.isSafeInteger(state.createdWindowId) && state.createdWindowId > 0
                    && !cleanupRevoked.has(state.createdTabId)) {
                    let changed = false;
                    const removers = [];
                    const listen = (event, callback) => {
                        if (!event?.addListener) return;
                        event.addListener(callback); removers.push(() => event.removeListener(callback));
                    };
                    listen(browser.tabs.onUpdated, (id, update) => {
                        if (id === state.createdTabId && (['url', 'pendingUrl', 'pinned', 'splitViewId'].some(key => Object.hasOwn(update, key))
                            || update.status === 'loading')) changed = true;
                    });
                    listen(browser.tabs.onRemoved, (id, info) => { if (id === state.createdTabId || info?.windowId === state.createdWindowId) changed = true; });
                    listen(browser.tabs.onDetached, (id, info) => { if (id === state.createdTabId || info?.oldWindowId === state.createdWindowId) changed = true; });
                    const eligible = tab => tab?.id === state.createdTabId && tab.windowId === state.createdWindowId
                        && !tab.incognito && !tab.pinned && (tab.splitViewId === undefined || tab.splitViewId === -1)
                        && isStartupLauncherTab(tab, browser) && (!tab.pendingUrl || isStartupLauncherUrl(tab.pendingUrl, browser));
                    try {
                        const created = await browser.tabs.get(state.createdTabId);
                        if (eligible(created)) {
                            const siblings = await browser.tabs.query({ windowId: state.createdWindowId });
                            const latest = await browser.tabs.get(state.createdTabId);
                            if (!changed && !cleanupRevoked.has(state.createdTabId) && eligible(latest)
                                && siblings.some(tab => tab.id !== latest.id)) await browser.tabs.remove(latest.id);
                        }
                    } catch { /* Missing or changing native state retires cleanup without replay. */ }
                    finally { removers.forEach(remove => remove()); }
                }
                await writeState({ pending: false });
            }
            return;
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
        if (launchers.length && (!activeTab || isStartupLauncherTab(activeTab, browser))) {
            await writeState({ pending: false }); await clearWake(); return;
        }
        // onStartup is delivered at profile readiness, which can precede the
        // first browser window/focus/tab URL. Give the first ready candidate the
        // same quiet period, without waiting beyond the startup deadline.
        if (!startupView && mayForeground()) {
            captureStartupView(windows, tabs);
            await schedule(state, Math.max(1, Math.min(SETTLE_MS, foregroundUntil - now() + 1)));
            return;
        }
        const active = Boolean(startupView && mayForeground() && target.focused
            && target.id === startupView.windowId && activeTab?.id === startupView.tabId
            && tabUrl(activeTab) === startupView.url);
        if (await tryStartupSuggestion(state, activeTab, active)) return;
        if (launchers.length) {
            await writeState({ pending: false });
            await clearWake();
            return; // Reuse restored tabs without changing selection or focus.
        }
        // Claim before creation: neither a second event nor a worker restart can
        // create another tab if Chrome has already accepted the create operation.
        await writeState({ pending: false });
        await clearWake();
        let tab;
        try {
            tab = await browser.tabs.create({ windowId: target.id,
                url: browser.runtime.getURL(STARTUP_LAUNCHER_PATH),
                active: active && mayForeground() });
        } catch (error) {
            reportError(error);
            // A definite API rejection did not satisfy this request. Restore it
            // and always rescan tabs/windows before another attempt. The claim
            // still protects an interrupted, unresolved create from blind replay.
            const retry = { ...state, pending: true, failures: (state.failures || 0) + 1 };
            await writeState(retry);
            const remaining = (state.retryUntil || state.fallbackAt || 0) - now();
            if (remaining > 0) {
                await schedule(retry, Math.min(1000 * 2 ** Math.min(retry.failures - 1, 3), 5000, remaining));
            }
            return;
        }
        await writeState(cleanupRevoked.has(tab.id) ? { pending: false }
            : { pending: false, createdTabId: tab.id, createdWindowId: target.id });
        await reconcile(); // Catch a restore that raced the create call.
    }

    function start() {
        const startedAt = now();
        return enqueue(async () => {
            if (await readState()) return; // At most once in this browser session.
            if (!await isEnabled()) {
                await writeState({ pending: false });
                return;
            }
            foregroundUntil = startedAt + FOREGROUND_MS;
            observedFocus = undefined;
            observedActiveTabs.clear();
            observedNavigations.clear();
            initialTabUrls.clear();
            changedBeforeCapture.clear();
            const state = { pending: true, fallbackAt: startedAt + RETRY_WINDOW_MS, retryUntil: startedAt + RETRY_WINDOW_MS };
            await writeState(state);
            try {
                const windows = await normalWindows();
                const focused = windows.find(window => window.focused);
                const tabs = focused ? await browser.tabs.query({ windowId: focused.id }) : [];
                captureStartupView(windows, tabs);
            } catch (error) { reportError(error); }
            await schedule(state);
        });
    }

    const onTab = tab => enqueue(async () => {
        const state = await readState();
        // Background restores must not keep postponing a ready startup candidate
        // until its foreground deadline expires. Reconciliation rescans all tabs.
        if ((state?.pending && timer === undefined)
            || (state?.createdTabId && isStartupLauncherTab(tab, browser))) await schedule(state);
    });
    browser.runtime.onStartup.addListener(start);
    const revokeCleanup = id => {
        cleanupRevoked.add(id);
        // Mark synchronously to fence in-flight reads; persist retirement on the
        // same queue so it also survives a later worker restart.
        void enqueue(async () => {
            const state = await readState();
            if (state?.createdTabId === id) await writeState({ pending: false });
        });
    };
    browser.tabs.onDetached?.addListener(revokeCleanup);
    browser.tabs.onReplaced?.addListener((added, removed) => { revokeCleanup(added); revokeCleanup(removed); });
    browser.windows.onCreated.addListener(() => onTab());
    browser.windows.onFocusChanged.addListener(windowId => {
        if (!mayForeground()) return;
        observedFocus = windowId;
        if (startupView && windowId >= 0 && windowId !== startupView.windowId) foregroundSuppressed = true;
    });
    browser.tabs.onActivated.addListener(({ windowId, tabId }) => {
        if (!mayForeground()) return;
        observedActiveTabs.set(windowId, tabId);
        if (startupView?.windowId === windowId && tabId !== startupView.tabId) foregroundSuppressed = true;
    });
    browser.tabs.onCreated.addListener(tab => {
        if (mayForeground() && !startupView) initialTabUrls.set(tab.id, tabUrl(tab));
        return onTab(tab);
    });
    browser.tabs.onUpdated.addListener((id, change, tab) => {
        // Loading/restoring tabs and duplicate initial focus/activation events are
        // not evidence of user activity. Only changes to the candidate suppress it.
        if (change.url && mayForeground()) {
            if (!startupView) {
                // A real navigation during the initial read must not be mistaken
                // for the baseline just because the query returns its new URL.
                // The first URL of a known newly created/URL-less tab is readiness.
                const initial = initialTabUrls.get(id);
                const expected = observedNavigations.get(id) || initial;
                if (initial === undefined || (expected && change.url !== expected)) changedBeforeCapture.add(id);
            }
            observedNavigations.set(id, change.url);
            if (startupView?.tabId === id && change.url !== startupView.url) foregroundSuppressed = true;
        }
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
