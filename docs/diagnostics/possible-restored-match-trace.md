# Possible restored match: diagnostic trace

This is an observational diagnostic for the **Attach open Split View** picker,
not a change to candidate eligibility, linking, or restoration. It records
why the advisory label was omitted, and whether the worker sent the label
flag. The existing picker and attach guards stay in force.

The capture is bounded worker-local memory. The snapshot contains only
fixed diagnostic labels and flags, not URLs, titles, tab IDs, split IDs,
bookmark IDs, browser session markers, or raw error messages. No permission,
storage write, network request, or extra native query is added. Capture is off
by default. The in-memory snapshot can disappear when the worker is replaced.
An empty trace does not show that any particular check passed.

`npm run build` leaves capture disabled. Use
`VITE_ARCIFY_RESTORED_HINT_TRACE=true npm run build` for a deliberately
armed disposable QA worker. This captures the first picker call without
opening DevTools beforehand. To arm capture manually in a worker, call
`arcifyRestoredHintTrace.enable()` (starts a fresh buffer).

## Test in a disposable profile

1. Use the verified picker build with diagnostics and preserve a backup before
   replacing a disposable profile's extension files. Keep the normal profile
   unchanged.
2. Preserve the saved pin and current panes. Open the pin's existing
   **Attach open Split View** menu item once, note whether the label is visible,
   without selecting anything. Do not click the pin or attach/unlink during
   observation.
3. Before canceling, expand **QA: Restore match trace** in the picker.
   It reports the decision for that exact response and the worker diagnostic
   version. An ordinary build does not display or emit it. Then **Cancel**.
4. If that picker request errors or more detail is needed, read the snapshot
   promptly in that Arcify **service worker** console, not the sidebar console: `arcifyRestoredHintTrace.read()`. Stop capture with
   `arcifyRestoredHintTrace.disable()`. To explicitly clear it, call
   `arcifyRestoredHintTrace.clear()`. The buffer also resets when the worker
   is replaced or capture is re-enabled. A DevTools connection can keep the worker alive.
5. Record whether Arcify was reloaded apart from the browser. An extension
   reload can clear session storage, so a same-browser reload result does not
   establish what a cold Helium restart would do. An absent branch trace, or a
   different synthetic split, cannot establish the original run's cause.

If the worker reports that it emitted the flag but the panel still has no
badge, investigate rendering or response validation rather than weakening
identity checks. Where a specific helper check failed, inspect only that
predicate. A displayed suggestion never proves original pane identity or
authorizes auto-attach.
