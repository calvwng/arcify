# Confirm current Today membership

When Move reports that selected tabs are still being matched to saved Spaces,
select those ordinary Today tabs again, open their context menu, and choose
**Review Today recovery…**. Review the preview and choose **Use selected tabs**
only if those exact open tabs should be current Today members in the current
Space. Cancel, Escape, leaving the sidebar, or a stale selection applies no
confirmation. Preview expires after two minutes.

This choice does not move, activate, close, navigate or reload any native tab.
It does not automatically retry Move. After verified confirmation, select the
tabs and choose Move to again. Every historical recovery record and its metadata
is retained without applying its old identity to the selected tabs. Existing
unlabelled historical window associations are never automatically remapped.

Pinned tabs, Favorites, transient tabs, Split View, duplicate live URLs, changed
identities, names/pin bindings, and matching queued saved identity remain
protected. A preview may therefore refuse confirmation and require separate
review rather than discard metadata.

## Persistence and evidence

Recovery state equality and preview fingerprints use the existing continuity
encoder, which sorts object keys only. Storage can reconstruct property order;
that must not make identical Space or restore-record values appear changed.
Array order, exact IDs, field values and optional metadata remain guarded. The
same comparison is used for final prewrite validation and checkpoint readback;
this does not delete, remap or ignore historical recovery records.

Review shows a persistent loading status while the read-only preview is pending.
A changed selection, backend rejection, incompatible preview protocol or transport
failure reports a visible result instead of silently closing the menu. Escape,
leaving the sidebar or hiding its document cancels a pending preview. The preview
wait ends after 15 seconds; its late reply or rejection cannot open a dialog,
overwrite a later review's status, submit confirmation or trigger Move. A fresh
review still needs a new explicit gesture and exact-selection validation.

The preview protocol version checks UI/backend compatibility, not the exact
loaded commit. Synthetic production-menu tests include actual selection capture
handlers, message registration and preview inspection with mocked Chrome data.
They cannot establish native Helium event ordering or which branch occurred in
the user's existing sidebar.

Recovery uses its own internal runtime Port from the exact packaged sidebar URL.
Chrome's optional sender `documentId` can be absent on native side panels; the
worker binds each preview to a new server-generated connection identity instead
of inventing a document ID or joining an unrelated `getContexts()` result.
Own extension ID and exact sidebar URL/origin are mandatory; tab-hosted, child
frame, private and inactive senders are rejected when those fields are present.
The trusted renderer also requires top-level exact-sidebar code, no host tab, and
a browser-read normal, focused, nonprivate current window matching the selection.
This authenticates trusted packaged UI, not native SIDE_PANEL hosting or a
browser-attested window identity. Other packaged code is not an allowed sender.

Only preview and confirm are accepted on this connection. A token is single use,
expires after two minutes, and cannot be replayed from another connection even
when both senders lack document IDs. Disconnect invalidates its tokens and queued
confirmation authority before writes. A write already authorized and begun may
complete without a reply after connection loss: the UI reports uncertainty and
never automatically retries. The old one-off message route remains restricted
to an exact own-sidebar sender with an actual nonempty document ID.

The background binds an expiring, single-use preview to the originating sidebar
document and exact current context. Confirmation runs on the SpaceStore queue and
saved-move lock, revalidates its complete preview fingerprint immediately before
writing, and authors only selected live snapshot records, the continuity/rank
checkpoint, and selected session confirmation flags/ranks. It deliberately avoids
normal persistence's unrelated restore-queue reconciliation. It preserves the
complete queue suffix, membership, window mappings and unrelated metadata.

Both local and session checkpoints are read back. A failed promise can follow a
completed write, so no write attempt is automatically retried or overwritten as
rollback. Receipts distinguish confirmed unchanged state, durable-only evidence,
verified completion and uncertainty. On uncertain/failed persistence, the next
queued operation reloads authoritative state. Concurrent changes detected after
the local checkpoint do not get overwritten by the session checkpoint.

For future recovery, newly authored current-window snapshots beside unresolved
candidates are labelled `current-only`; they cannot become evidence for a
historical window association on a later recovery boundary. Their fallback is
limited to unique, unadorned ordinary Today membership. Existing unlabelled
snapshots retain conservative historical protection.

Synthetic tests cover the two-boundary failure, genuine conflicting old windows,
single-boundary recovery, duplicate/pin/name/Favorite guards, stale previews,
cancel/trusted confirmation ordering, worker and browser-ID restart cases, write
failures, lost acknowledgements, readback failure and concurrent changes. These
do not establish the original user's historical sequence or native Helium
acceptance. This candidate has not been installed or applied to a real profile.
