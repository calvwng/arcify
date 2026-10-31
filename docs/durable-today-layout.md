# Durable ordinary Today layout

`durable-today-layout.js` stores confirmed plain Today membership and canonical
order in `spaceDurableTodayLayout`, separately from historical recovery records.
It never infers historical names, pin metadata, or page identity.

Every saved eligible slot must have one unique ordered mapping into one native
window. Extra tabs are allowed but do not receive saved placement or become
required anchors through fallback tracking. Duplicate embeddings, competing
cohorts/windows, missing slots, navigation and reordered saved slots remain
unresolved. An explicit newer choice takes precedence. Private, transient,
startup-helper and native-pinned tabs are excluded; Favorite, split, metadata,
Space-root and exact native identity checks remain in force.

Partial startup and shutdown preserve the saved baseline. Native events retry
restoration as tabs return. A confirmed individual close updates its bound slot.
Restored placements receive fresh incarnation ownership. Canonical local writes
include snapshot/rank proofs and are read back before session acknowledgement.
Interrupted writes reconcile from committed state rather than blindly retrying.

## Storage and fallback compatibility

The reader accepts ledger versions 1, 2 and 3; writes use version 3. Initialization
can upgrade the format without an explicit move. Earlier writers must not be used
after that upgrade. Build the paired fallback with
`VITE_ARCIFY_AUTOMATIC_LAYOUT_RESTORE=false`: it keeps compatible storage handling
and normal moves but suspends automatic layout application. It is not a data
backup or protection against faults in the shared reader/writer.

See [fresh explicit layout authority](fresh-explicit-layout.md) for precedence,
mapped-subset persistence, ambiguity tradeoffs and compatibility details.

## Same-browser transitions

An authenticated live snapshot can preserve exact current membership when an
extension reload loses its session-local epoch. Its proven survivors retain the
global Space sequence across windows; older layout candidates cannot suppress
their snapshots or remove and reinsert them. New witnesses prefer the verified
browser epoch while still-valid session witnesses remain accepted.

Fresh subset evidence includes proven survivors and creations observed in an
initialized, bound window. It does not turn unobserved extra tabs into placements
or required anchors. Historical identities and metadata remain separate. Normal
new-tab placement still rebases pending ranks around their surviving anchors.

The local membership, snapshot, ranks and layout checkpoint are written together
and read back before session acknowledgement or group projection. These writes
are not an atomic transaction across local and session storage. A failure forces
reinitialization and reconciliation from committed evidence. The compatible
fallback retains this reader and ordinary current ownership while disabling
automatic cross-restart layout application. This correction keeps ledger v3.

## Read-only evidence

Select Today rows and choose **Explain recovery blocker**. The report combines
selected recovery reason counts with aggregate saved-layout evidence. Layout
counts cover the observed store, not just selected rows. Confirmed records mean
integrity-checked stored data, not proven current or historical identity.

Mismatch relations distinguish pinned anchors, shifted indices, additional native
slots, reordered slots and no sequence correspondence. Counts may overlap and
never authorize restoration. Reports contain no URLs, titles, IDs, raw records or
reusable hashes. See [recovery diagnostics](recovery-diagnostics.md) for schemas,
privacy bounds and the independent diagnostic build gate.

See [testing durable layouts](testing-durable-layout.md) for reproducible unit,
source-module and packaged native restart fixtures.
