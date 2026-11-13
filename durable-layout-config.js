// Compatibility fallback: retain compatible storage and explicit writes, but suspend
// automatic layout application. This is not a rollback of the shared writer.
export const automaticLayoutRestoreEnabled = import.meta.env?.VITE_ARCIFY_AUTOMATIC_LAYOUT_RESTORE !== 'false';
