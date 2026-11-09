# Recovery diagnostics

During active development, select ordinary Today rows, right-click a selected row,
and choose **Explain recovery blocker**. Arcify freezes the same exact selection
used by the move menu before opening its report. No DevTools or pasted script is
needed. The report can be copied with **Copy diagnostic** for troubleshooting.

This reads only. It never adopts, restores, moves or closes tabs, invokes the
recovery matcher, clears flags, or writes storage. Counts explain saved-identity
refusal conditions; zero blockers is not permission or proof that recovery will
succeed. Normal Move to Space assigns exact live tabs independently from historical identity. The layout evidence uses schema v3; see durable-today-layout.md for its mismatch counts and limitations.

## Report and privacy boundary

The optional endpoint `arcifySelectedRecoveryDiagnostic` accepts a bounded exact
selection only from the extension's packaged sidebar. Request identities remain
inside the extension. The worker queues on `store.chain` directly, **not**
`SpaceStore.run`, whose preambles may initialize or reconcile state. It reuses the
existing two-read recovery observer, excludes private/native-ineligible windows,
and verifies live tab URLs/IDs, current Space/root, memory/persisted queue and flags.
Changed, cold or inconsistent evidence returns a status without reason counts.

Only schema, status, selected count and allowlisted bounded reason/layout counts leave
the worker. No URLs, titles, tab/window/Space IDs, names, window keys, raw records,
exceptions or reusable hashes appear in the report or clipboard. There is no
telemetry, network call, automatic clipboard write, persistence or automatic retry.
Counts overlap; `blockedSelected` counts each affected selected row once.

The dialog holds refresh while reading. Close, Escape, external blur, hidden or
pagehide dismiss it. Timeout releases the hold and ignores a late response.
Selection changes also suppress stale counts. Reopening starts an independent read.
The report describes its completed observation, not a continuing monitor.

## Build switch and removal

Enabled by default while developing. Disable **the selected and layout diagnostics**:

```powershell
$env:VITE_ARCIFY_RECOVERY_DIAGNOSTICS='false'
npm run build
node scripts/check-recovery-diagnostics-package.mjs dist disabled
Remove-Item Env:\VITE_ARCIFY_RECOVERY_DIAGNOSTICS
```

On POSIX use `VITE_ARCIFY_RECOVERY_DIAGNOSTICS=false npm run build`.
Re-enable by omitting the variable and rebuilding. This is a compile-time switch,
not a persisted user setting. The disabled bundle contains neither its menu label
nor endpoint; its listener is not registered. Existing aggregate **Settings >
Recovery status  >  Read recovery status** remains in both configurations.

The module boundary is `recovery-diagnostics-config.js`,
`selected-recovery-diagnostics.js`, `durable-layout-diagnostics.js` and `selected-recovery-diagnostics-ui.js`. The core `durable-today-layout.js` is independent and must remain enabled.
For permanent removal, remove the gated background/menu wiring and dialog selection
exception, then remove these modules/tests/check script. Existing recovery writers,
guards, aggregate reader and menu lifecycle do not depend on these modules. The
observer's additional active-Space fields are private read-only evidence, reusable
by future diagnostics; they can also be removed if unused.

## Retention and checks

Keep reusable readers and their schemas/tests in source control. Imported modules
are bundled; do not install one-off scripts by dropping them into `dist` because
Vite regenerates that directory. `scripts/zip.js` packages the generated `dist`.

- `tests/unit/selected-recovery-diagnostics.test.js`: classification, successful
  registered read with mutation traps, privacy, validation, cancellation, timeout,
  repeated use and disabled reader/UI.
- `tests/unit/today-sidebar-integration.test.js`: real selection/context menu path.
- Existing recovery-observation/report tests protect the aggregate diagnostic.
- `node scripts/check-recovery-diagnostics-package.mjs dist enabled` checks shipped
  enabled output; use `disabled` after a disabled build to prove removal and retention
  of the aggregate reader.

Developer-only transient-window hooks and paired-Chrome probes remain separate
from this user-facing counts-only diagnostic. Their activation/privacy contracts
must not be conflated with this report. No additional diagnostic was removed here.

## Snapshot refusal counts (layout diagnostic v3)

The layout report uses the same pure native-window eligibility, sequence mapping,
Space association and precedence/override predicates as production. Effective
Favorite ownership includes active inferred recovery, not just exact bindings.
All non-private native windows participate in matching, including popup windows
that can make a match ambiguous; only eligible normal windows may be restored.
The selected-row and aggregate report retain their existing narrower window view.

Complete sequence candidates are then counted against automatic-mode, newer-choice,
unproven-override, Space association, bookmark-folder, saved-pin, native-split and
window checks. Counts overlap. Passing these observed checks does not establish
historical identity, run recovery or guarantee a later restore: production still
revalidates asynchronous evidence before applying anything. Saved placement counts
are records across historical layouts and may repeat the same live tabs.

The selected report adds two bounded read-only epoch/folder observations, effective
exclusion flags, and bookmark-event stability checks. It never creates an epoch,
initializes stores, invokes their query/reconcile wrappers, writes storage, or
performs native actions. Missing capabilities, races or work-budget exhaustion
return incomplete/changing without counts. Extra fields remain inside the worker;
only allowlisted counts and mode values reach the UI/clipboard. The aggregate
settings reader does not perform the new folder/epoch reads.

`tests/unit/layout-refusal-diagnostics.test.js` compares refusals to the actual
restoration path, including precedence, overrides, roots, saved pins, splits,
popup competition and zero-placement semantics. It also covers read/write traps,
privacy, admission eligibility, mode, races and work limits. Integrated ordinary
Favorite tests cover active quiet recovery plus both unchanged and reordered
Today layouts. The ledger remains version 3; matching and restore behavior are
unchanged.

For packaged native validation without touching an existing browser profile, build
the extension and run `ARCIFY_FAVORITE_RECOVERY_CASE=layout-diagnostic node
scripts/disposable-favorite-recovery.mjs` (set the environment variable separately
in PowerShell). The fixture creates its own temporary headless browser profile,
checks the actual packaged receiver after a full restart, verifies quiet-Favorite
exclusion and unchanged storage/tabs, then exercises Undo. It closes only its owned
browser. This is not Helium-profile acceptance.
