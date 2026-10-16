# Exact archive operation foundation

The foundation described here serves the existing Arcify archive controls. The optional Spotlight adapter described below builds on that same store; neither layer adds permissions, a new archive page, or a recovery/reset UI.

## Data compatibility

`archivedTabs` remains an array readable by previous versions. Migration only adds random `entryId` values (or repairs invalid/duplicate IDs). Every existing row, timestamp, Space ID, unknown field, and array position survives; equal URLs are never merged by migration. Every copy of a duplicate ID is replaced so old references cannot choose an arbitrary survivor. Legacy Space-ID migration runs through the same writer and retains entry IDs.

New additions preserve existing behavior: exact-URL deduplication across all Spaces, newest-first order, and a maximum of 100 entries. The popup remains global across Spaces. A restore creates an ordinary Today tab in the entry's original Space; the archive cannot reconstruct saved pin identity.

## Authoritative writer and entry points

`SpaceStore` owns `archiveStore`. Public `list`, `view`, `add`, `archive`, and `reopen` methods enter `SpaceStore.run`. Methods ending in `Unlocked` are internal-only and require that queue already be held. Auto-archive and initialization use those methods directly, so they never queue recursively.

Existing sidebar Utils functions use the authenticated `archiveStore` internal message route. Website/foreign-extension senders, mismatched sender windows, and unknown message fields are rejected. Reopen explicitly carries:

- `requestId`, `windowId`
- `expected`: the complete archived record, including `entryId`
- `bookmarkFolderId`: the original Space's captured folder identity
- `context`: originating window, selected Space/folder, active source tab ID and URL

`view(windowId)` returns that source context and the global list of `{entry, bookmarkFolderId}` descriptors. An unchanged legacy object without `entryId` resolves only if its entire remaining record has exactly one match. URL-only removal is no longer accepted. Full-array replacement requires the complete expected prior snapshot, preventing a stale sidebar from erasing concurrent additions.

A stale ordinary sidebar row has no archived timestamp or entry identity. Its old first-URL fallback now asks the user to choose the exact entry in the existing archive popup. It never guesses among archived rows or rebuilds a pin.

## Reopen lifecycle

1. Validate the exact record, requested normal/non-incognito window, current source context, original Space and its exact bookmark folder under the unique Arcify root, and supported URL.
2. Persist a per-entry `creating` claim before attempting native creation.
3. Revalidate, then create inactive with explicit `windowId`.
4. Persist Chrome's returned exact native tab ID as a `created` receipt before assignment.
5. For a fresh create only, observe its initial empty URL/exact pending URL creation and one exact loading-to-complete transition. Wait at most four seconds from starting observation, without another create or navigation. Confirm the returned exact ID has the requested committed URL, no pending URL, complete status, and remains inactive, nonpinned/nonprivate, ungrouped and outside native Split View. Assign ordinary Today membership to the original Space and persist it.
6. Read archive and claim data, then perform a final event-fenced read of the exact record, source, folders, native ID and assigned membership. Atomically remove only that `entryId` and write its `consumed` completion receipt.
7. After confirmed consumption, select the original Space, activate the created tab, and focus its window. A focus/display failure returns a known partial success with the exact created ID and a warning, rather than inviting another create.

Fresh-create observation starts before the final create preflight. A bounded 256-event buffer retains early lifecycle events until Chrome returns the exact native ID; no URL lookup can bind an identity. Missing, duplicate, late or conflicting creation proof refuses settlement. The four-second load timer ends when that bound initial load completes; source/target listeners remain active. Even if observation has already rejected or timed out, a returned valid native ID is persisted as a `created` claim before the error is reported.

The initial observer catches source, bookmark, Space, archive and pairing changes through the first strict target verification. Only then does its authority observation detach, synchronously and after checking sticky invalidation; subsequent authority validation remains in the existing strict read fences. Exact source/target native observation continues across assignment and consumption awaits to reject observable repeat navigation, redirects, moves, activation, removal or replacement. It overlaps the first post-consumption strict native/source verification and ends before intentional Space selection and native activation. There are no storage-write exemptions. Any failure before consumption retains the saved entry and known created claim; a failure after consumption returns the existing known partial outcome without focusing over the newer change.

This guarantee concerns the exact newly returned native tab and its requested URL, not a particular page document. Browser events can omit or coalesce a same-URL reload before its first commit; this observer cannot prove unreported document continuity. It grants no initial-load allowance to existing tabs, resumed claims or restarted workers, never relaxes `fencedArchiveRead`, and never replays creation or navigation. All listeners and timers are removed on every exit.

Chrome APIs and extension storage are not one transaction. Read/event fences detect native changes during awaited checks; they cannot prevent a user or Chrome from changing a tab after a native/storage call has begun. No rollback guesses or URL matching are used.

## Failure and recovery contract

An unresolved per-entry claim blocks another create even with a different request ID. If creation may have occurred but no exact ID was durably recorded, the saved entry remains and the UI explains that the outcome is uncertain. It does not retry, expire, or clear the claim automatically. Restarting is not a reset. Repairing a missing or duplicated entry ID also cannot detach an unresolved claim from its exact unchanged record; that ambiguous record remains blocked under its repaired ID.

A random `chrome.storage.session` token proves browser-session continuity. Worker restart may reconcile a durably known created ID on a later explicit reopen request. The pending ID is excluded from automatic source-Space adoption. Missing/changed session proof refuses reconciliation; a full browser restart never trusts old native IDs or searches for URL matches, even when a new tab reuses both the ID and URL.

Completed receipts prevent duplicate creates after lost responses. At most 100 completed receipts are kept; old completed receipts may be pruned because their archive entries were already removed and a replay can only fail stale. Unresolved claims are never pruned. A claim whose exact record/folder/window no longer matches is not substituted or repaired by guessing.

Malformed archive/claim data is retained and affected archive operations fail closed, while unrelated Space initialization continues. Deleted Spaces, missing/replaced/moved folders, unsupported URLs, and stale source contexts preserve the entry and refuse native creation.

The popup awaits `consumed: true` before removing the exact rendered row. Ambiguous/failing operations remain visible with an error. Confirmed partial results remove the consumed row and show their warning. Double-clicks are gated, subsequent rows use refreshed source context, and detached old rows cannot start a new operation.

## Verification

`tests/unit/archive-store.test.js` exercises migration/older readers, global deduplication/cap, concurrent writers, exact same-URL identities, stale source/window/folder/Space, unsupported URLs, claim/create/receipt/assignment/consume/focus boundaries, lost responses, worker/full-browser restart, transient native-event fencing, receipt bounds and authenticated routing.

`tests/unit/archive-popup.test.js` checks global rendering, same-URL rows, pending and repeated clicks, refusal/unknown outcomes, partial success, subsequent-row context refresh and detached responses. Existing SpaceStore, auto-archive/background and onboarding fixtures use the authoritative route. No local browser or publication is part of this foundation slice.

## Optional Spotlight adapter

`archiveActionsV1` adds `archiveContext` and `reopenArchivedTab` without changing legacy snapshots or commands. The context binds the source window, active source tab/URL, selected Space/folder and pairing generation. A bounded, five-minute worker-local opaque view retains each full exact archived record: at most 64 views, 1,048,576 UTF-16 code units of serialized private record payload per view, and 1000 display descriptors. Oversized or unsupported rows remain saved and available to the existing archive controls. The wire exposes only stable entry IDs and bounded display descriptors. Changed records, including unknown legacy fields, fail exact comparison. A view is consumed once at dispatch, even on failure; cold worker or expired views require a new explicit selection. The existing durable claim/known native-ID receipt still prevents a fresh selection from duplicating an uncertain creation. Pairing/capability checks now participate in the native-event fence before creation, assignment, consume and focus.

After atomic consumption, a fresh source/authority fence runs before changing selected Space, and another after native activation runs before window focus. Rejected assignment or selection persistence marks the in-memory Space store uninitialized, so its next queued operation reloads durable state rather than committing tentative membership or selection through a later unrelated event. A known consumed result still reports partial completion when display cannot be confirmed.

`Open Archive` uses a separate `arcify-archive-open` transport and one-use opaque intent. Preparation may await; invocation sends directly from trusted renderer input. Arcify validates the browser-attested paired top-frame sender and pairing generation in one storage callback, then calls `sidePanel.open` synchronously there. No queue or second browser API precedes it. The ordinary sidebar command is unchanged.

Native API resolution is not display confirmation. The existing sidebar must consume the intent, render the global popup in the still-selected Space, and ACK. Only the exact authenticated `sidebar.html` native `SIDE_PANEL` document can do this. Chromium may return native context window `-1`: a real `sidePanel.onOpened` receipt plus a native sidebar registration of its browser-derived current window binds the document in the same worker epoch. Consume/ACK re-read the browser-derived window and revalidate pairing/source/Space. `onClosed` invalidates the binding. An already-open verified panel reuses that binding without manufacturing another event. After worker restart an old panel without a new real opening receipt fails safely; it is never closed/reopened automatically. Missing native context/opened/closed APIs hide Open Archive while exact reopen remains available.

Archive display timeout, rejected gesture, document loss, stale selection and uncertain native results are never replayed. Only confirmed archive consumption removes the selected entry. Full browser-restart native-ID reuse and saved pins/Favorites retain the original foundation protections.
