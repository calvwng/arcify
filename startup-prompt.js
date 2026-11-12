export const STARTUP_PROMPT_SETTING = 'startupPromptEnabled';
export const STARTUP_PROMPT_SESSION = 'arcifyStartupPromptSession';
export const STARTUP_PROMPT_DIAGNOSTIC = 'arcifyStartupPromptDiagnostic';
export const STARTUP_PROMPT_PATH = 'startup-prompt.html';
const DEADLINE_MS = 5000;
const SETTLE_MS = 750;

// Opt-in, once per real browser startup. Never replay a pending claim when an
// MV3 worker wakes: skipping a prompt is safer than stealing focus much later.
export function registerStartupPrompt(browser = globalThis.chrome, {
    now = Date.now, wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
    randomToken = () => crypto.randomUUID(), prepareWindowEligibility = async () => {},
    isExcludedWindow = () => false,
    reportError = error => console.warn('Arcify startup prompt:', error)
} = {}) {
    let running;
    let candidate;
    let changed = false;
    let observing = false;
    let observedFocus;
    let phase = 'registered';
    let reason = 'not-run';
    let beganAt;
    let capturedAt;
    let initialNavigationAccepted = false;
    let initialNavigationConflict = false;
    const skip = value => { reason = value; };

    const observedActive = new Map();
    const observedNavigation = new Map();
    const navigationBeforeCapture = new Set();
    // Session restoration can announce the current URL without navigating away.
    // Keep every distinct URL so a genuine away-and-back change still cancels.
    const navigationChanged = value => value && [...(observedNavigation.get(value.tabId) || [])]
        .some(observedUrl => observedUrl !== value.url);
    const url = tab => tab?.pendingUrl || tab?.url || '';
    const enabled = async () => (await browser.storage.sync.get({ [STARTUP_PROMPT_SETTING]: false }))[STARTUP_PROMPT_SETTING] === true;
    const save = value => browser.storage.session.set({ [STARTUP_PROMPT_SESSION]: value });
    const readCandidate = async () => {
        const windows = await browser.windows.getAll({ windowTypes: ['normal'], populate: true });
        const window = windows.find(value => value.type === 'normal' && value.focused
            && !value.incognito && !isExcludedWindow(value.id));
        const tab = window?.tabs?.find(value => value.active && !value.incognito);
        return window && Number.isInteger(tab?.id) && url(tab)
            ? { windowId: window.id, tabId: tab.id, url: url(tab) } : null;
    };
    const capture = value => {
        candidate = value;
        if (!candidate) return;
        capturedAt = now();
        // The first eligible snapshot is the opted-in startup baseline. A matching
        // URL announcement may be session restore or immediate user navigation;
        // the API cannot distinguish those. Reconcile once, never rebaseline.
        initialNavigationConflict = navigationBeforeCapture.has(candidate.tabId) && navigationChanged(candidate);
        initialNavigationAccepted = navigationBeforeCapture.has(candidate.tabId) && !initialNavigationConflict;
    };
    const same = value => value && value.windowId === candidate?.windowId
        && value.tabId === candidate.tabId && value.url === candidate.url;
    browser.windows.onFocusChanged.addListener(id => {
        if (!observing) return;
        if (observedFocus !== undefined && id !== observedFocus) changed = true;
        observedFocus = id;
        if (candidate && id !== candidate.windowId) changed = true;
    });
    browser.windows.onRemoved.addListener(id => { if (id === candidate?.windowId) changed = true; });
    browser.tabs.onActivated.addListener(value => {
        if (!observing) return;
        if (observedActive.has(value.windowId) && observedActive.get(value.windowId) !== value.tabId) changed = true;
        observedActive.set(value.windowId, value.tabId);
        if (value.windowId === candidate?.windowId && value.tabId !== candidate.tabId) changed = true;
    });
    browser.tabs.onUpdated.addListener((id, update) => {
        if (!observing || !(Object.hasOwn(update, 'url') || Object.hasOwn(update, 'pendingUrl'))) return;
        if (!candidate) navigationBeforeCapture.add(id);
        const urls = observedNavigation.get(id) || new Set();
        for (const key of ['url', 'pendingUrl']) {
            if (Object.hasOwn(update, key) && typeof update[key] === 'string' && update[key]) urls.add(update[key]);
        }
        observedNavigation.set(id, urls);
        if (id === candidate?.tabId && navigationChanged(candidate)) changed = true;
    });
    browser.tabs.onRemoved.addListener(id => { if (id === candidate?.tabId) changed = true; });
    browser.tabs.onDetached.addListener(id => { if (id === candidate?.tabId) changed = true; });
    browser.tabs.onReplaced.addListener((added, removed) => { if (removed === candidate?.tabId) changed = true; });
    browser.storage.onChanged?.addListener((changes, area) => {
        if (observing && area === 'sync' && Object.hasOwn(changes, STARTUP_PROMPT_SETTING)
            && changes[STARTUP_PROMPT_SETTING].newValue !== true) changed = true;
    });

    async function run(startedAt) {
        // Anchor the active tab before storage/setting work. Session restore may
        // announce its unchanged URL while those asynchronous operations run.
        // Matching URL events during this snapshot join the initial baseline;
        // conflicting URLs, window changes and later navigation still cancel.
        phase = 'initial-capture';
        capture(await readCandidate());
        phase = 'claim';
        if ((await browser.storage.session.get(STARTUP_PROMPT_SESSION))[STARTUP_PROMPT_SESSION]) return skip('already-claimed');
        await save({ status: 'claimed', startedAt });
        phase = 'eligibility';
        if (!await enabled()) return skip('disabled');
        if (typeof browser.sidePanel?.open !== 'function') return skip('unsupported');
        const until = startedAt + DEADLINE_MS;
        phase = 'find-window';
        while (!candidate && now() < until) {
            capture(await readCandidate());
            if (candidate) break;
            await wait(100);
        }
        if (initialNavigationConflict) return skip('initial-capture-url-conflict');
        if (!candidate || changed || now() + SETTLE_MS > until
            || (observedFocus !== undefined && observedFocus !== candidate.windowId)
            || (observedActive.has(candidate.windowId) && observedActive.get(candidate.windowId) !== candidate.tabId)
            || navigationChanged(candidate)) return skip('initial-candidate-not-stable');
        // Anchor first, then initialize transient-window exclusion. A navigation
        // that conflicts with the initial snapshot was rejected above.
        phase = 'prepare-window';
        await prepareWindowEligibility();
        if (changed || now() + SETTLE_MS > until || isExcludedWindow(candidate.windowId)
            || !same(await readCandidate())) return skip('window-preparation-check');
        phase = 'settle';
        await wait(SETTLE_MS);
        if (changed || now() > until || !await enabled() || !same(await readCandidate())) return skip('settle-check');
        phase = 'prepare-popup';
        const record = { status: 'creating', token: randomToken(), ...candidate, createdAt: now() };
        await save(record); // Claim before dispatch, including uncertain create outcomes.
        if (changed || now() > until || !same(await readCandidate())) return skip('final-candidate-check');
        if (changed || now() > until) return skip('final-deadline-or-change');
        phase = 'create-popup';
        const popup = await browser.windows.create({ type: 'popup', width: 440, height: 280, focused: true,
            url: browser.runtime.getURL(`${STARTUP_PROMPT_PATH}?token=${encodeURIComponent(record.token)}`) });
        await save({ ...record, status: 'open', promptWindowId: popup.id });
        phase = 'open'; reason = 'created';
    }
    function start() {
        if (!running) {
            observing = true;
            beganAt = now();
            running = run(beganAt).catch(error => { reason = 'error'; reportError(error); }).finally(async () => {
                observing = false;
                const diagnostic = { version: 2, capturedAt: now(), phase, reason, elapsedMs: now() - beganAt,
                    initialNavigationAccepted, initialNavigationConflict,
                    candidateFound: Boolean(candidate), captureElapsedMs: capturedAt === undefined ? null : capturedAt - beganAt, changed, navigationBeforeCapture: Boolean(candidate && navigationBeforeCapture.has(candidate.tabId)), navigationObserved: Boolean(candidate && observedNavigation.has(candidate.tabId)),
                    focusMismatch: Boolean(candidate && observedFocus !== undefined && observedFocus !== candidate.windowId),
                    activeMismatch: Boolean(candidate && observedActive.has(candidate.windowId) && observedActive.get(candidate.windowId) !== candidate.tabId) };
                candidate = undefined;
                try { await browser.storage.session.set({ [STARTUP_PROMPT_DIAGNOSTIC]: diagnostic }); } catch {}
            });
        }
        return running;
    }
    browser.runtime.onStartup.addListener(start);
    return { start };
}
