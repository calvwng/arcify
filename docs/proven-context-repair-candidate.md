# Proven current-context repair candidate

Local-only candidate based on e335800523cf7021ea2d3e6b6d4e957dffc015c3. No installation, publication, profile inspection, or live browser action is part of this work.

## Purpose

An existing explicit Today cohort can contain seven proven placements but a full native-window signature. An irrelevant duplicate URL in that wider context can block the strict restart matcher. This candidate can retain the original cohort and append a selected-only representation of exactly those already committed placements. It does not move tabs, change membership or order, issue ownership witnesses, or infer a new user choice.

## Required proof

- Ordinary canonical persistence only: no explicit move, saved-move journal, staged creation/replay transition, pending write fence, or queued restored metadata.
- The validated committed durable layout must equal the in-memory baseline. Its snapshot proof, explicit live-prefix checkpoint, and rank checkpoint must agree.
- The entire proposed live snapshot must equal the committed live prefix. Full membership/order/roots and unresolved history must match. A navigation, new record, native-index change, or window-key refresh first uses ordinary capture; a later stable checkpoint may repair.
- Every existing placement maps through its signature slot to one native ID. Every ID must have exactly one committed live record, exact currentOwnership witness (incarnation, transaction, epoch, window, Space, root), identical current witness, URL, rank, order, and single Today owner.
- Reject selected Favorites/pins, Split tabs, transient/private tabs, pending navigation, metadata, incomplete placement sets, malformed metadata maps, or missing current epoch evidence.
- Reject any predecessor with outgoing blockedBy edges or unresolved overrides. Preserve all existing cohorts and incoming edges. Only add predecessor-to-successor edges.
- Evaluate all successors against the unchanged strict matcher and complete final graph. Competing cohorts/windows or duplicate selected URLs cannot become authority through a higher revision.

The successor uses the next revision because the v3 format requires edges to advance revisions. This is permitted only with the same authenticated placement set and no outgoing newer-choice dependency; it is not permission to override an unrelated choice.

## Async and interruption safety

Validation rechecks committed checkpoints/layout/history, full membership/ranks/witnesses, roots and normal windows, metadata, full native identity and effective eligibility, and every fresh witness epoch. Epochs are read after final native queries. Temporary storage/bookmark/native invalidation listeners catch late changes to earlier reads and are removed on every exit. These listeners are not atomic locks.

Once a plan exists, a stale validation aborts persistence rather than falling through to generic capture with stale observations. The canonical write is followed by complete checkpoint readback. A failed/uncertain write never causes an automatic retry of the representation transition. Ordinary initialization resumes from whichever complete canonical checkpoint actually committed.

## Activation and limits

Synthetic warm-worker initialization with unchanged current proof performs this repair without another move. Ordinary same-session persistence also works. If another live change needs capture, that checkpoint is allowed to settle normally before a subsequent stable checkpoint can repair. Installation alone is not claimed to guarantee activation, and no installation was performed.

A cold restart that has already lost valid current-incarnation proof cannot use this repair. It must keep strict existing restoration behavior.

The combined restart-prevention candidate now separately bounds generic capture by exact intent IDs. Authenticated replay can prove neighbours for current membership but cannot expand an existing explicit/subset placement scope. A genuine Move or observed creation contributes only its actual intended IDs, not every replay-promoted witness in the same or another window. Two integrated normal/inverted tests exercise repair, repeated authenticated neighbour replay, and duplicate-context cold restart. This helper itself still skips all staged replay/creation transitions.

## Verification

Dedicated synthetic tests cover seven-only repair, normal/inverted order, preserved predecessor/history/incoming edges, refusal of stale/reused IDs and changed transactions/epochs/metadata/roots, outgoing blockers and competing windows/cohorts, final-query epoch revocation, late event invalidation and listener cleanup, failed checkpoint/readback, all four interruption boundaries, effective Favorite/transient changes, unrelated-window capture, native index refresh, and warm activation. Native/bookmark action spies ensure the repair tests do not move, group, navigate, close, create, or edit real state.


Combined verification: the 88 helper/integration tests pass within the 340-test
focused restart-prevention run. Broader build, full unit and isolated headless
browser results are recorded by the coordinating task, not inferred from this run.
