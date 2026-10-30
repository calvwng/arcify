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

Native API resolution is not display confirmation. The internal `arcify-archive-display-v1` runtime Port is deliberately a **trusted packaged-UI display route**, not proof of a native `SIDE_PANEL` document. Chrome 155's native sidebar sender was captured with `documentId: null` and `tab: null`, while `runtime.getContexts()` independently reported a native document ID. We do not join those unbound identities, infer native hosting from one available context, or treat a Port name or an `onOpened` receipt as receiver authentication.

The worker accepts the named Port only through its own `runtime.onConnect`, with Chrome-attested own extension ID, exact origin and exact `sidebar.html` URL; tab-hosted, non-top-frame, private and inactive senders are rejected when those sender fields are present. Missing/null sender document ID is explicitly allowed under this trusted-own-UI model. No external registration, generic command, archive record, or archive mutation is accepted on this route. The packaged renderer independently requires `top === self`, the exact unparameterized sidebar URL, a non-incognito extension context, `tabs.getCurrent() === undefined`, and its own fresh browser-derived normal/non-incognito/focused window matching the initialized selected-Space UI. This excludes the ordinary sidebar tab, iframe, wrong page, offscreen/ineligible and wrong-window UI without pretending those renderer checks are browser-attested native-host proof. Compromised Arcify packaged code is outside this trust boundary; that code already has the existing separately guarded archive reads/mutations.

Registration binds one live physical Port to a worker-random session nonce and its exact window. Two registered candidates for a window make it ambiguous and burn any active display invocation; a second window's panel is independent. The one-use external intent is claimed by one exact live Port/session, with expiry and disconnect cancellation. After rendering, `validate` rechecks current pairing generation, browser source, selected Space and exact folder before the renderer ensures the shared popup is open. `ack` rechecks those authorities and browser focus again. It returns only a display boolean to Spotlight; it cannot authorize a restore, removal, new archive read, or data disclosure. The old `arcifyArchiveIntent` runtime-message registration route is removed.

A continuous per-invocation event fence starts at native opening and lasts through final ACK. Observable source navigation/removal/replacement/activation, focus loss, authority changes, panel close and Port loss invalidate it permanently, even if the old values return between reads. No-op storage writes, unrelated Space metadata and another window's selected Space do not cancel the new display fence; the existing strict per-read archive fence remains unchanged. The renderer similarly observes visibility, selected-Space revision and newer input. Its same-Port `cancel` invalidates immediately outside the store queue, including while a previously sent ACK waits. The shared popup helper tracks exact display ownership: rollback can undo only this invocation's still-owned new visibility. An already-open native popup is not repopulated, preserving its existing controls and focus; a newer manual close/reopen wins. No synthetic click or automatic control/tab/window/Space focus is used.

`sidePanel.onOpened` and `onClosed` remain native lifecycle corroboration and cancellation signals, not receiver authentication. An already-open eligible renderer can register after worker restart and consume a **fresh** user command even if opening an already-open panel emits no new `onOpened`. Old tokens/session nonces are never recovered. Cold panel startup consumes after normal initialization; connection loss/reload cancels in-flight work and only a new explicit command can create new authority. An available-hint message can reconnect and poll, but contains no intent or authority. Missing native open/lifecycle or internal Port APIs hide only Open Archive preparation.

`tests/unit/spotlight-archive-actions.test.js` and `tests/unit/archive-intent-ui.test.js` exercise the actual worker and renderer modules together through DOM and paired mock Ports using the captured null-documentId sender shape. They cover eligibility refusals, exact session/window ownership, ambiguity, stale reads and away/back changes, native close/Port loss/reconnect, interrupted ACK, popup ownership and no mutation/focus effects. These tests are not native browser evidence: the hosted paired fixture must still prove the real Chrome native panel, source invariants and visibly open shared popup independently. Its mandatory Open Archive acceptance case remains required.

Archive display timeout, rejected gesture, document loss, stale selection and uncertain native results are never replayed. Only confirmed archive consumption removes the selected entry. Full browser-restart native-ID reuse and saved pins/Favorites retain the original foundation protections.
