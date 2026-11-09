// Local-only, bounded counters. Never store page identity or raw exceptions here.
export const RESTART_DIAGNOSTIC_KEY = 'favoriteRestartDiagnostic';
export const RESTART_DIAGNOSTIC_SESSION_KEY = 'favoriteRestartDiagnosticSession';
export const RESTART_DIAGNOSTIC_COUNTS = Object.freeze([
    'savedFavorites', 'hintsSeen', 'hintsValid', 'hintJournalMissing', 'hintJournalInvalid', 'hintJournalExpired',
    'hintIdentityChanged', 'noHints', 'alreadyKnown', 'nativeTabs', 'settlePasses', 'settleBudgetExhausted',
    'missingFavorite', 'missingNativePage', 'duplicateNativePage', 'duplicateHint', 'duplicateSavedFavorite',
    'alreadyOwned', 'invalidPage', 'missingTitle', 'privatePage', 'pendingNavigation', 'pageLoading',
    'nativeSplit', 'nativeGroup', 'startupHelper', 'transientPage', 'ineligibleWindow', 'spaceBookmark',
    'windowNavigating', 'titleChanged', 'pinChanged', 'windowCohortChanged', 'nativeSampleChanged',
    'inferredCandidates', 'spaceBookmarkConflict', 'rollbackUnavailable', 'hintOversized', 'hintLimit',
    'recovered', 'exactBindings', 'inferredHintsRetained', 'attachmentPending', 'hintsWritten', 'operationFailed'
]);
const keys = new Set(RESTART_DIAGNOSTIC_COUNTS);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const count = value => Number.isSafeInteger(value) && value >= 0 && value <= 1000000;
function sanitizePart(value) {
    if (!object(value) || Object.keys(value).some(key => !['capturedAt', 'status', 'counts'].includes(key))
        || !Number.isSafeInteger(value.capturedAt) || value.capturedAt < 0 || value.capturedAt > 8640000000000000
        || !['complete', 'skipped', 'failed'].includes(value.status) || !object(value.counts)
        || Object.entries(value.counts).some(([key, value]) => !keys.has(key) || !count(value))) return null;
    return { capturedAt: value.capturedAt, status: value.status, counts: { ...value.counts } };
}
export function sanitizeRestartDiagnostic(value) {
    if (!object(value) || value.version !== 1 || Object.keys(value).some(key => !['version', 'startup', 'checkpoint', 'beforeStartup'].includes(key))) return null;
    const result = { version: 1 };
    for (const kind of ['startup', 'checkpoint', 'beforeStartup']) {
        if (value[kind] === undefined) continue;
        const part = sanitizePart(value[kind]);
        if (!part) return null;
        result[kind] = part;
    }
    return result.startup || result.checkpoint ? result : null;
}
export const addRestartDiagnosticCount = (report, key, amount = 1) => {
    if (report && keys.has(key) && count(amount)) report.counts[key] = Math.min(1000000, (report.counts[key] || 0) + amount);
};
export async function recordRestartDiagnostic(kind, report, api = chrome, { newStartup = false, attempted = false } = {}) {
    // Reporting failure cannot veto recovery, overwrite its journal, or trigger a retry.
    try {
        if (!['startup', 'checkpoint'].includes(kind)) return;
        const part = sanitizePart({ capturedAt: report.capturedAt, status: report.status, counts: report.counts });
        if (!part) return;
        const previous = sanitizeRestartDiagnostic((await api.storage.local.get(RESTART_DIAGNOSTIC_KEY))[RESTART_DIAGNOSTIC_KEY]) || { version: 1 };
        if (kind === 'startup' && newStartup) {
            const marker = (await api.storage.session?.get(RESTART_DIAGNOSTIC_SESSION_KEY))?.[RESTART_DIAGNOSTIC_SESSION_KEY];
            const validMarker = marker?.version === 1 && typeof marker.attempted === 'boolean';
            if (validMarker && (marker.attempted || !attempted)) return false;
            if (!validMarker) {
                if (previous.checkpoint) previous.beforeStartup = previous.checkpoint;
                else delete previous.beforeStartup;
            }
        }
        await api.storage.local.set({ [RESTART_DIAGNOSTIC_KEY]: { ...previous, [kind]: part } });
        if (kind === 'startup' && newStartup) await api.storage.session?.set({ [RESTART_DIAGNOSTIC_SESSION_KEY]: { version: 1, attempted: !!attempted } });
    } catch { /* Best effort only; do not save or print exception content. */ }
    return true;
}
