import { RESTART_DIAGNOSTIC_KEY, sanitizeRestartDiagnostic } from './favorite-restart-diagnostics.js';

const reasonLabels = {
    savedFavorites: 'Saved Favorites', hintsSeen: 'Saved restart hints seen', hintsValid: 'Valid restart hints',
    hintJournalMissing: 'No saved hint journal', hintJournalInvalid: 'Invalid saved hint journal',
    hintJournalExpired: 'Expired saved hint journal', hintIdentityChanged: 'Saved Favorite identity changed',
    noHints: 'No usable restart hints', alreadyKnown: 'Favorites already tracked', nativeTabs: 'Native tabs observed',
    settlePasses: 'Restore settling checks', settleBudgetExhausted: 'Restore settling limit reached',
    missingFavorite: 'Saved Favorite missing', missingNativePage: 'No matching restored page',
    duplicateNativePage: 'Multiple matching restored pages', duplicateHint: 'Duplicate saved hints',
    duplicateSavedFavorite: 'Duplicate saved Favorites', alreadyOwned: 'Page or Favorite already owned',
    invalidPage: 'Ineligible page', missingTitle: 'Page title missing', privatePage: 'Private page excluded',
    pendingNavigation: 'Page navigation pending', pageLoading: 'Page still loading', nativeSplit: 'Native split page excluded',
    nativeGroup: 'Native grouped page excluded', startupHelper: 'Startup helper page excluded',
    transientPage: 'Temporary page or window excluded', ineligibleWindow: 'Window ineligible',
    spaceBookmark: 'Page is a Space bookmark', windowNavigating: 'Another page in the window is navigating',
    titleChanged: 'Page title changed', pinChanged: 'Native pin state changed',
    windowCohortChanged: 'Window page set changed', nativeSampleChanged: 'Native pages changed during checks',
    inferredCandidates: 'Candidates matched before activation', spaceBookmarkConflict: 'Space bookmark conflict',
    rollbackUnavailable: 'Safe rollback placement unavailable', hintOversized: 'Saved hint too large',
    hintLimit: 'Saved hint count limit reached', recovered: 'Associations activated',
    exactBindings: 'Exact Favorite bindings', inferredHintsRetained: 'Inferred hints retained',
    attachmentPending: 'Favorite attachment pending', hintsWritten: 'Restart hints saved',
    operationFailed: 'Operation could not complete'
};

// This is a historical, local-only diagnostic, never a live recovery command.
export function mountFavoriteRestartDiagnostics(document, api = chrome, {
    timeoutMs = 15000,
    clipboard = document.defaultView?.navigator?.clipboard
} = {}) {
    const readButton = document.getElementById('favorite-restart-diagnostic-read');
    const copyButton = document.getElementById('favorite-restart-diagnostic-copy');
    const notice = document.getElementById('favorite-restart-diagnostic-notice');
    const output = document.getElementById('favorite-restart-diagnostic-output');
    if (!readButton || !copyButton || !notice || !output) return () => {};
    let generation = 0, pending = false, disposed = false, timer, snapshot = null;
    const buttons = () => {
        readButton.disabled = pending || disposed;
        copyButton.disabled = pending || disposed || !snapshot;
    };
    const cancel = () => { generation++; pending = false; clearTimeout(timer); buttons(); };
    const begin = (copying = false) => {
        const ticket = ++generation;
        pending = true; buttons();
        timer = setTimeout(() => {
            if (disposed || generation !== ticket) return;
            cancel();
            notice.textContent = copying
                ? 'Clipboard completion could not be confirmed in time. No automatic retry was made.'
                : 'Diagnostic read timed out. You may request another read. No recovery action was requested.';
        }, timeoutMs);
        return ticket;
    };
    const finish = ticket => {
        if (!disposed && generation === ticket) { clearTimeout(timer); pending = false; buttons(); }
    };
    const render = report => {
        for (const [key, heading] of [['beforeStartup', 'Saved checkpoint before last captured startup'], ['startup', 'Last captured startup'], ['checkpoint', 'Latest saved checkpoint']]) {
            const section = report[key];
            const title = document.createElement('h3'); title.textContent = heading; output.append(title);
            const stamp = document.createElement('p');
            stamp.textContent = section
                ? `${new Date(section.capturedAt).toLocaleString()} · ${section.status}`
                : 'No captured diagnostic for this stage.';
            output.append(stamp);
            if (!section) continue;
            const list = document.createElement('dl');
            for (const [reason, count] of Object.entries(section.counts)) {
                const term = document.createElement('dt'), value = document.createElement('dd');
                term.textContent = reasonLabels[reason] || reason;
                value.textContent = String(count); list.append(term, value);
            }
            output.append(list);
        }
    };
    async function read(event) {
        if (event?.isTrusted !== true || disposed || pending) return;
        snapshot = null; output.replaceChildren();
        const ticket = begin(); notice.textContent = 'Reading the saved Favorite restart diagnostic.';
        try {
            const stored = await api.storage.local.get(RESTART_DIAGNOSTIC_KEY);
            if (disposed || generation !== ticket) return;
            const report = sanitizeRestartDiagnostic(stored?.[RESTART_DIAGNOSTIC_KEY]);
            if (!report) {
                notice.textContent = 'No captured diagnostic in this build yet.';
                return;
            }
            // Keep only a fresh sanitized copy; never retain or copy the raw storage object.
            snapshot = JSON.stringify(report, null, 2);
            render(report);
            notice.textContent = 'Historical diagnostic, not live recovery status. Startup counts describe the last captured startup and persist across background worker wakeups. The pre-startup checkpoint is earlier recorded evidence; the latest checkpoint may be newer. No recovery action was requested.';
        } catch {
            if (!disposed && generation === ticket) {
                snapshot = null; output.replaceChildren();
                notice.textContent = 'The saved diagnostic could not be read. No recovery action was requested.';
            }
        } finally { finish(ticket); }
    }
    async function copy(event) {
        if (event?.isTrusted !== true || disposed || pending || !snapshot) return;
        const text = snapshot, ticket = begin(true);
        notice.textContent = 'Copying the already-read diagnostic.';
        try {
            if (typeof clipboard?.writeText !== 'function') throw new Error('Unavailable');
            await clipboard.writeText(text);
            if (!disposed && generation === ticket) notice.textContent = 'Copied the already-read historical diagnostic. It contains only stage statuses, counts and timestamps.';
        } catch {
            if (!disposed && generation === ticket) notice.textContent = 'The diagnostic could not be copied. You may try again.';
        } finally { finish(ticket); }
    }
    const hide = () => {
        if (document.visibilityState !== 'hidden') return;
        const wasPending = pending;
        snapshot = null; cancel(); output.replaceChildren();
        notice.textContent = wasPending
            ? 'Diagnostic operation cancelled. A clipboard write already requested may still finish. Read again when you return.'
            : 'Read the saved diagnostic again when you return.';
    };
    const dispose = () => {
        disposed = true; snapshot = null; cancel();
        readButton.removeEventListener('click', read); copyButton.removeEventListener('click', copy);
        document.removeEventListener('visibilitychange', hide);
        document.defaultView?.removeEventListener('pagehide', dispose);
    };
    buttons();
    readButton.addEventListener('click', read); copyButton.addEventListener('click', copy);
    document.addEventListener('visibilitychange', hide);
    document.defaultView?.addEventListener('pagehide', dispose);
    return dispose;
}
