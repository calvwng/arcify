# Fresh explicit layout authority

This corrects the approved durable-layout behavior: a successful explicit Today
move must remain durable even when older window evidence cannot match. It does not
add a repair dialog or infer old historical identity.

When a validated explicit move encounters an unmatched pending layout, capture a
fresh complete eligible native signature. Only exact current explicit ownership
contributes placements and canonical order; fallback neighbours are matching
context, not adopted placements. Existing authoritative cohorts update in place.

Retain old cohorts and historical records. A strictly newer choice revision and
`blockedBy` references record potential conflict, never proof that two cohorts
represent the same window. Every relevant newer choice must be uniquely established
in another window before an older conflicting cohort can restore. Missing newer
windows, deleted destinations and unproven overrides cannot revive older authority.
Current-epoch exact ownership also permits an older full baseline to restore around
newer choices during partial startup. It never overwrites the newer placements.

Precedence is evaluated before ambiguity: a predecessor does not make its successor
ambiguous, but unrelated identical cohorts/windows still do. The final write fence
rechecks unique correspondence, native IDs, signatures, epoch, metadata and relevant
newer evidence. Fresh cohort, precedence, ownership, ranks and snapshot proof share
the canonical local commit and existing readback/interrupted-write reconciliation.

The conservative tradeoff is possible deferral of an unrelated same-URL old layout
while a potentially conflicting newer window is absent or incomplete. Distinct
uniquely mapped windows release that deferral; records are never purged. Every
saved slot must map uniquely in order into one native window. Extra native tabs
are allowed; missing, changed or reordered saved slots remain unresolved. This
does not recover uncertain old order or guarantee restoration after arbitrary
native layout changes.

## Compatibility

The reader accepts ledger v1/v2/v3; writes use v3. Older builds reject v3 instead of
silently ignoring mapped-subset protection. After activation has written v3 data, rolling back
only the extension files is not seamless: an older build fails initialization while
preserving the ledger. No user storage migration, reset or rollback is performed by
the development/install scripts.

## Compatible fallback build

Build with `VITE_ARCIFY_AUTOMATIC_LAYOUT_RESTORE=false` to suspend automatic
durable-layout application. The normal build leaves this variable unset. This is
a recovery operating mode, not a downgrade to the old writer or ledger format.

Both builds retain v1/v2/v3 validation, v3 writes, precedence, snapshot/rank proofs,
explicit-move capture and final write fences. The fallback still classifies pending
layout candidates before returning from restoration, so historical matching cannot
substitute for deferred layout application. Exact current-epoch ownership replay
and normal Space operations remain enabled. Unrelated historical recovery remains
subject to its existing guards.

After a full browser epoch, saved membership/order is retained but automatic layout
application is deliberately suspended. Returning to the normal build can apply it
when complete unique evidence is available; newer fallback moves take precedence.
This fallback isolates automatic layout application defects only. It does not
protect against a shared ledger parser, capture, storage writer, or corruption
defect. It is not a coherent pre-upgrade state backup.

Initialization reads v1/v2 without modifying the ledger, then its normal persist writes
v3 with the canonical spaces/snapshot/rank/ownership checkpoint in one local set.
Layout readback must match before the session checkpoint is written. A rejected or
uncertain write invalidates initialization; retry re-reads durable state. This is
the existing local-then-session reconciliation protocol, not an atomic transaction
across storage areas. Migration may occur on initial activation without a move.

Deployment would keep both verified artifacts. If automatic restoration malfunctions,
replace extension files with the compatible fallback and reload the extension;
do not restore older storage or use an earlier v1/v2-only build.
Re-enable the normal artifact
only after investigation. These steps require separate installation/activation
authorization; no deployment, browser access, or state backup is part of these tests.

## Bounded extra-tab mapping

Earliest and latest complete ordered embeddings must select identical positions.
All candidate windows count, including windows with multiple internal embeddings.
Unrelated competing cohorts block; ancestral cohorts still require the existing
newer-choice proof before merging. Saved absolute indices never select live tabs:
mapped native IDs drive placement, binding and final global revalidation.

An embedded restoration records `contextSubset` in ledger v3. Later capture keeps
the original mapped anchors and placements, so an extra tab does not acquire
saved membership, metadata or a required anchor merely through fallback tracking.
Normal tracking can manage extras independently. An explicit move of an extra
creates newer authority while retaining the predecessor. Observed individual
closures update the mapped subset; incomplete startup/shutdown preserves it.

Conservative compatibility tradeoff: a short old cohort may also embed into a
longer window and now create ambiguity that the former exact-only matcher did
not expose. Such competing claims remain deferred; no joint assignment is guessed.
The matching rule applies to the ordinary durable layout, never to historical
identity or metadata restoration.

## Evidence

The durable-layout suite covers the changed-pending regression, seven/eight-tab
moves, repeated epochs and order, old signatures returning, missing/branching newer
choices, independent same-URL windows, ambiguity appearing during awaited reads,
deleted destinations, partial restoration, stale context/metadata and interrupted
local/session writes. Existing privacy, split, pin and historical recovery checks
remain in force.

`ARCIFY_LAYOUT_FIXTURE_CASE=fresh-choice node scripts/disposable-layout-restart.mjs`
uses a new synthetic profile: seed a layout, restart and change a nonselected native
anchor before initialization, activate the source Space normally, move seven exact
rows in visible order, close the process, then restore again. It asserts the new
membership/order and unchanged history while the old pending evidence remains.
This is actual source-module/native-browser integration, not packaged Helium
acceptance or evidence about the user's original mismatch.
