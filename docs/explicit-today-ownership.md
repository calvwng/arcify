# Explicit moves and unresolved Today history

Choosing a destination in Move to Space establishes current membership for the
exact selected ordinary live tabs. An unresolved historical association no longer
requires a separate recovery confirmation. Existing native pin/Favorite, Split
View, private/transient, provisional, exact selection and navigation protections
still refuse unsupported or changed batches. The source Space stays selected.

Already proven ordinary moves keep their existing path. A batch containing a
recovery candidate, or a tab with a previous explicit ownership witness, uses the
additional checkpoint path. The first-click Ctrl/Shift sidebar path is tested
through the production move handler and SpaceStore, not just a success stub.

## Evidence and persistence

`explicit-today-ownership.js` records a `currentOwnership` witness on the canonical
live snapshot record: version, native window, Space and bookmark root, browser or
session epoch, incarnation token and transaction token. Tokens correlate records;
they are not independent native identity proof. No URL-wide exemption is stored.
Only a witness agreeing with current membership, eligible native tab and proven
epoch may suppress historical matching.

`spaceExplicitTodayCheckpoint` binds the live-prefix length to the canonical
snapshot/ranks fingerprint. Historical records remain in the existing suffix;
their numeric IDs cannot identify current incarnations. Native cleanup therefore
does not delete pending history solely by numeric ID. Unrelated native tabs retain
their historical matching opportunities, including matching URLs in other windows.

The move is serialized on SpaceStore's existing queue. It stages membership and
witnesses together, preserves the complete historical queue and metadata, and
revalidates native/source/destination identity at the persistence boundary. Live
ranks are rebased without rewriting historical orders. One canonical local set
writes membership, snapshot, ranks, continuity and explicit boundary proof, then
the session checkpoint follows. Native tabs are not recreated or navigated.

If a write rejects, readback classifies durable exact survivors and uncertainty;
it never blindly retries or rolls back a possibly completed write. Initialization
checks the proven local live prefix before stale session flags can invoke matching.
It reconciles a committed explicit choice and lets ordinary persistence repair the
session checkpoint. A failed local write cannot manufacture an explicit choice.
The boundary marker is updated or cleared on every canonical persistence.

## Restart limits

Session fallback proof remains valid while its original session token survives,
even if browser continuity proof becomes available later. Browser witnesses require
their own epoch/generation proof. Every witness is checked against its own kind;
the incarnation token alone never authorizes replay. Same-epoch native navigation
does not turn a tab into an old historical page; asynchronous reconciliation checks
the complete captured live batch again before releasing any recovery flags.

Across a new browser epoch or loss of all applicable proof, native IDs are not
replayed as exact identity. Existing conservative restoration rules continue, and
ambiguous history remains pending. The next explicit live-tab move can establish
fresh placement without historical repair. Perfect automatic placement after every
ambiguous browser restart is not promised. History is not deleted or deduplicated
by URL; unresolved historical records can remain indefinitely.

The built-in read-only diagnostic remains available, with its separate documented
build switch. Neither the move nor diagnostic transmits telemetry.

## Verification

- Synthetic flagged batches with cross-Space associations and duplicate historical
  URLs; native-ID collisions and unchanged historical metadata.
- Repeated moves/persistence, worker reload, interrupted local/session writes,
  fallback-to-browser proof transition, same and changed browser epochs.
- Unrelated same-URL recovery, private/pin/Favorite/Split/provisional rejection,
  stale navigation, asynchronous reconciliation and corrupted checkpoint boundary.
- Existing Today, Favorites, Spotlight, recovery and real-sidebar regression suites.

The coupled durable-layout writer uses ledger v3 and reads v1/v2/v3. Activation can
upgrade the checkpoint during initialization. Earlier writers fail closed; use the
paired compatible fallback described in `fresh-explicit-layout.md`, never an older
extension or an isolated old storage key. A fallback build is not a state backup.
