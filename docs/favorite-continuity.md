# Exact Favorite continuity with a surviving Spotlight witness

This is an optional extension-only recovery path. It adds no permissions, native
host, browser patch, URL matching, or second workspace database in Spotlight.
It does **not** preserve live Favorite identity across a full browser restart.

## Identity and compatibility

Arcify remains the only Favorite/Space owner. Saved links retain their existing
four-key schema. The bridge Favorite projection retains its five keys, including
nullable exact `tabId`; `tabs[].pinned` always reports the real native pin bit.
`globalFavoritesV1` in `hello.capabilities` allows a bound Favorite to refer to an
ordinary, same-window tab outside all Space membership. Every other exact-ID,
unique ownership and saved-identity constraint remains enforced.

New Spotlight starts each operation with a read-only `hello` containing
`supportedFeatures: ['globalFavoritesV1']`. An exact `INVALID_REQUEST` response
permits one legacy **hello-only** fallback. Other failures do not trigger fallback.
The negotiated hello contains the fresh snapshot, so snapshot consumers do not
need another read. Mutations carry the marker only when the provider advertised
the capability. Mutations are never automatically replayed or retried.

Arcify rejects an unmarked request before its action journal or requested native
mutation whenever ordinary mode is selected or ordinary ownership remains. It
rechecks at execution and gates successful request-ID replay too. This includes
read-only old-client hellos: they receive `UNSUPPORTED_FEATURE`, never a nominal
success they cannot interpret. Pinned-only old/new combinations remain supported.
Both endpoints scope in-flight results to the current pairing generation, so an
A → disconnect/B → A change cannot revive a prior authenticated request.

## Storage and proof

Arcify stores:

- `storage.session.favoriteSession`: authoritative current ownership/attempts.
- `storage.session.favoriteContinuityReceipt`: version/schema, random epoch,
  checkpoint revision, paired ID/generation and a digest of that exact ownership state.
- `storage.local.favoriteContinuity`: a local-only, versioned exact mirror and
  saved-ID/URL/provenance identities, plus the acknowledged peer generation.
  It is not synced, exported, or used to guess browser identity.

Spotlight stores **only** `storage.session.arcifyFavoriteWitness`: version,
paired ID/generation, Arcify's opaque epoch/writer generation, and latest revision.
There are no tabs, windows, URLs, titles, Favorites, Spaces or snapshots in it.
Pair IDs and random pairing generations remain in each extension's local settings.

The independent `arcify-favorite-witness` version-1 endpoint accepts only the
currently paired browser-authenticated extension sender/origin. Requests and
responses have strict bounded schemas, correlated unpredictable IDs, explicit
roles, and a 1.5-second timeout. Reads are side-effect free. Writes reject older
revisions. Conditional recovery writes require the exact previously attested
peer generation, epoch, writer generation and previous revision.

## Single writer and commit order

FavoriteStore and SpaceStore call the adapter only under SpaceStore's queue. Ownership loads
before any Space restoration/adoption. A surviving own session with a matching
receipt digest is preferred; legacy pinned-only session state can start a new
compatible epoch. A mismatched own receipt is not repaired from the durable mirror.

Local schema `exact-global-favorites-v2` fingerprints canonical JSON: recursively
sorted object keys, with array order and all ownership values preserved. Browser
storage may reorder object properties without changing the ownership state.
Pre-fix `v1` insertion-order receipts are incompatible and fail closed, even if a
hash happens to match; they are not migrated by rehashing unproven current data.
Saved Favorite records remain intact, but old live bindings can project closed.

Each current-session ownership save performs these awaited steps:

1. Write an invalid local mirror tombstone.
2. Atomically write exact session state plus its new revision/digest receipt.
3. Write a committed local mirror with no peer acknowledgement.
4. Ask the paired Spotlight to witness the opaque latest revision.
5. Persist the acknowledged peer generation on the local mirror.

Failure at step 1 blocks subsequent native mutation. Failures at later persistence
boundaries surface to FavoriteStore; its dirty-state gate retries known exact
receipts before any next ownership-dependent operation. An unavailable companion
is optional: current-session ownership remains usable, but the mirror cannot be
recovered. A stale witness cannot authorize a different/newer local revision.
Detach/removal/release receipts are saved before reporting successful ownership
release. Revocation in settings invalidates the local mirror and rotates the
pairing generation in the **same local write**, including when the peer is offline.

With Arcify's session absent, recovery first validates the committed mirror,
compatible schema, digest and current saved identities, then asks the current
Spotlight for a **read-only** matching receipt. It never enrolls the old candidate
into a fresh companion. It queries exact current tabs and normal windows; missing,
private, helper, moved-window or no-longer-native-pinned legacy bindings are
excluded. Arbitrary API read failures abort initialization and preserve the
candidate for a later retry; uncertainty is not proof that a tab was removed.

A valid candidate then uses a separate two-phase recovery commit:

1. Invalidate its local mirror and write a **provisional** session receipt, which
   ordinary session loading refuses to trust.
2. Advance the witness by an exact conditional commit at the originally attested
   peer generation and previous ownership revision.
3. Commit the acknowledged local mirror, then finalize the session receipt.

The conditional witness commit is recovery's authorization/linearization point.
A peer revocation or superseding receipt before it rejects the old candidate;
there is no blind reenrollment. After that commit, a successfully finalized
Arcify session owns its state independently of future Spotlight availability.
Interrupted provisional states fail closed. Once proof fails, any new enrollment
uses a fresh epoch and empty/currently proven session state only.

Authenticated bridge reads refresh the witness from a verified **surviving own
session**. This reestablishes continuity after Spotlight-only reload or an explicit
pairing change, without authorizing an old durable candidate.

## Selected Space continuity

The same Arcify-owned journal can optionally carry `selection: { version: 1,
windows: [{ windowId, spaceId, tabId }] }` and `selectionFingerprint`. Each row
records a selected stable Space ID and an exact surviving browser-tab anchor in
its normal, non-private window. The anchor need not belong to that Space: a
selected Space may be empty while a global Favorite is the active browser tab.
Extension UI tabs, including pending navigations to them, cannot serve as anchors.
No selection data is sent to Spotlight or added to saved Favorite records.

The optional selection digest covers the selection plus its epoch, pairing
writer generation, checkpoint revision and Favorite ownership fingerprint.
Favorite v2 ownership validation is unchanged. Missing or invalid selection
context drops only selection recovery. Older v2 writers can still read ownership;
if they advance a receipt without understanding its optional context, the stale
selection digest no longer matches the new revision and is refused.

Selection changes checkpoint even when Favorite bindings do not change. While
holding the shared queue, SpaceStore uses the same invalidation-first writer to
atomically persist its Space session fields and the new receipt before group
projection. Failed checkpoints force SpaceStore to reload its authoritative own
session before a subsequent read. An offline selection change cannot revive the
older witnessed selection after extension reload.

A surviving own `spaceSession` always wins, including an empty `activeSpaces`.
Otherwise, context becomes available only after the same conditional witness
commit and final own-receipt write used for Favorite recovery. Before installing
it, Arcify rechecks the exact anchor/window and current Space definitions. Missing,
moved or private anchors, non-normal windows, and deleted/unknown Spaces are
refused. API lookup uncertainty blocks initialization instead of guessing.
Loss of both extension sessions or a full browser restart never restores this
selection context. Existing full-restart Space membership restoration is unchanged.
Native group IDs remain ephemeral projections, not Space identity or proof.

## Supported lifecycle and explicit limits

| Event | Result |
| --- | --- |
| Worker sleep/restart, own session survives | Current ownership remains authoritative |
| Arcify reload/update, Spotlight session and latest receipt survive | Exact validated bindings may recover before Space adoption |
| Spotlight-only reload, then successful current-session bridge read | Spotlight is safely reenrolled from Arcify's valid own session |
| Both extension sessions lost before reenrollment, or full browser restart | Saved Favorites project closed; restored numeric IDs are not adopted |
| Missing/old/unavailable companion; stale/malformed receipt or schema | No durable identity recovery |
| Either side changes/revokes pairing during recovery before its conditional commit | Candidate rejected |
| Tab moves to another window while Arcify is down | That binding is refused; no cross-window recovery/URL guessing |
| Transient tab/window API lookup failure | Initialization blocks; journal is retained for retry |
| Explicit current-session native tab move | FavoriteStore's ordinary live move/collision handling applies |

A saved-closed Favorite can be reopened while a restored ordinary page is already
present, producing another page. Unbound ordinary pages may subsequently be
classified as normal Space tabs; this feature is not a broad tab quarantine.

Arbitrary **unobserved unsupported downgrade/re-upgrade interludes are not safe or
supported**. Old code can alter ownership without updating this journal and
without ever contacting Spotlight, which is indistinguishable from a supported
reload. Observed incompatible state/schema fails closed, but a browser-session
witness cannot prove that compatible code ran continuously. Close ordinary live
Favorites before downgrading, or explicitly pin/reattach them as a separate user
action. No automatic mass repinning is performed.

## Verification

- `npm run test:unit` in Arcify
- `npm test` in Spotlight
- `node scripts/check-spotlight-pair.mjs <spotlight-checkout>`
- `node scripts/check-favorite-witness-pair.mjs <spotlight-checkout>`
- Production builds in both repositories

These checks include schema/authentication, exact generation/revision conditional
commits, offline detach and revoke, both reload orders, restart refusal, transient
read failures, torn persistence boundaries, replay guards and mixed protocol
versions. They use mocks and are not physical-browser or native Ctrl+W evidence.
