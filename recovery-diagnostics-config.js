// Optional development diagnostic. Vite replaces this value in both UI/worker.
// Disabled builds retain the existing aggregate Recovery status and all guards.
export const selectedRecoveryDiagnosticsEnabled = import.meta.env?.VITE_ARCIFY_RECOVERY_DIAGNOSTICS !== 'false';
