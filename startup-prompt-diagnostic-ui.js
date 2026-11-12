export function mountStartupPromptDiagnostic(document, browser) {
    const button = document.getElementById('startupPromptReadStatus');
    const output = document.getElementById('startupPromptStatus');
    if (!button || !output) return;
    button.addEventListener('click', async () => {
        button.disabled = true;
        try {
            const data = await browser.storage.session.get(['arcifyStartupPromptSession', 'arcifyStartupPromptDiagnostic']);
            const record = data.arcifyStartupPromptSession;
            const diag = data.arcifyStartupPromptDiagnostic;
            const fields = { sessionStatus: record?.status || 'none', diagnostic: diag ? {
                phase: diag.phase, reason: diag.reason, elapsedMs: diag.elapsedMs,
                initialNavigationAccepted: diag.initialNavigationAccepted, initialNavigationConflict: diag.initialNavigationConflict,
                captureElapsedMs: diag.captureElapsedMs, navigationBeforeCapture: diag.navigationBeforeCapture,
                candidateFound: diag.candidateFound, changed: diag.changed, navigationObserved: diag.navigationObserved,
                focusMismatch: diag.focusMismatch, activeMismatch: diag.activeMismatch
            } : null };
            output.textContent = JSON.stringify(fields);
        } catch { output.textContent = 'Could not read startup status.'; }
        finally { button.disabled = false; }
    });
}
