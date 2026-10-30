# Today recovery / Move to incident

Reconciliation note: the accepted source is now present in this isolated working copy. Historical checkout statements below describe the original documentation event; see [current provenance and limits](release-reconciliation.md).

## Outcome and scope

The user reported that explicit Today recovery followed by Move worked on
**October 21, 2026 Pacific / October 22 UTC** (report received at 04:19 UTC).
This is user-reported acceptance of that sequence, not independent verification
of Helium behavior after a browser restart.

The accepted runtime was an unpacked **V4 scratch build**, based on Arcify commit
`0995d9a817114b1ba3c17db20c93fd9779149e4e` plus the patches below. It was installed
without replacing checkout source or Spotlight. The documentation checkout was
at `173ac8cad22039dd95ef87fcfe1308dfc55d7c88`; its existing local source edits were
preserved. Adding this document does **not** integrate the scratch implementation
or its tests into that committed source. Manifest version `5.1.0` alone cannot
identify the loaded patch generation.

See also [Today selection](today-tab-selection.md), the
[Move request/receipt contract](today-space-move.md), and
[continuity behavior](favorite-continuity.md).

## Symptoms and what they mean

| Category | Observed message | Interpretation |
| --- | --- | --- |
| `TODAY_RECOVERY_PENDING` | “Nothing was moved. Some selected tabs are still being matched to their saved Spaces. Choose fully restored Today tabs and try again.” | At least one selected live tab remains a recovery candidate. Direct Move refuses ambiguous ownership; it does not open a recovery dialog. |
| Sender rejection | “Invalid recovery sender. Nothing was confirmed.” | The original recovery endpoint required a nonempty browser sender `documentId`. A valid native sidebar can lack it. |
| Preview validation rejection | “The recovery preview changed or expired. Select the tabs again and review a new preview. Nothing was confirmed.” | Before a dialog, this comes from backend request/state validation. It is not proof that time elapsed, that a token expired, or that the client selection changed. |
| Preview timeout | “Recovery preview timed out. Nothing was confirmed. Review the selected tabs before trying again; late replies will be ignored.” | The UI's separate 15-second preview wait ended. A late reply cannot open an old dialog or trigger recovery. |
| Uncertain confirmation | “Recovery confirmation could not be verified. Check the selected tabs before trying again; nothing was retried.” | A write or reply may have been interrupted. Inspect/read back the result before considering another operation. |

Messages appear in the status notice at the top of the sidebar. The early report
that a click “did nothing” did not establish a silent-exit or timeout cause: the
user later identified an error in that notice. Stale-selection and pending-reply
silent exits were separately reproduced and given explicit feedback.

## Why the guard and recovery choice were necessary

Saved recovery records carry historical Space/window identity, ordering and
possibly pin/name metadata. A live tab having the same URL is not enough to
assign that old identity safely. The observed sanitized relationship was seven
live ordinary Today tabs, with six still flagged and each having a pending record
for historical window B, while the live window was associated with A. The matching
live layout of A did not prove that records from B belonged to it. The guard stops
at a flagged entry; an all-remaining batch receipt does not mean every tab was
flagged, and by itself does not prove no write was attempted.

Synthetic lifecycle tests reproduced a **two-recovery-boundary snapshot-lineage
defect**: unresolved restoration first generated a fresh current-window snapshot;
later recovery without proven session continuity could promote that authored
snapshot into historical association evidence and strand other records. Merely
minting a current window key at the first boundary did not establish that defect.
Controls also reproduced a legitimate conflicting old-A/old-B history which must
remain guarded. Neither history was proved to be the original user's history.

The explicit choice confirms **only the exact selected live tabs as ordinary
Today members of the current Space**. It keeps every historical recovery record
and its metadata, without applying or remapping the old identity. It updates the
selected live snapshots and continuity/rank/session checkpoints, verifies
readback, and leaves unrelated state intact. It does not move, close, activate,
navigate or reload tabs, or automatically retry Move. Duplicate live URLs,
pin/name bindings, Favorites, native pins, Split View and other protected identity
remain refusal conditions; historical ordinary Today records are not discarded.

## Fix sequence and remaining limits

1. **V1 — lineage prevention and explicit recovery.** Newly authored window
   snapshots beside unresolved candidates receive `recoveryRole: 'current-only'`.
   They cannot establish a historical window association at a later boundary.
   A limited fallback handles unique, unadorned ordinary Today membership.
   Existing unlabelled records retain conservative protection. An explicit
   preview/confirmation writer was added for already-affected selected tabs.
2. **V2 — visible feedback.** Added preview progress, stale/backend errors,
   cancellation, a bounded wait, safe late-response handling and a compatibility
   version check. Earlier recovery UI tests stubbed backend replies; earlier full
   menu fixtures omitted `document`, disabling the recovery branch. Production
   menu-to-backend tests filled that gap. This did not prove the user's click
   failed because of event ordering.
3. **V3 — sender correction.** Chrome documents sender `documentId` as optional;
   repository native Chrome evidence already recorded null `documentId` and
   `tab` for a sidebar. The exact V2 handler reproduced the sender rejection for
   that shape. A dedicated internal Port now binds a one-use preview to a
   server-generated live connection identity. Exact own extension ID, packaged
   sidebar URL/origin, frame/private/lifecycle restrictions and trusted renderer
   current-window checks remain. A Port authenticates trusted packaged UI, not
   native `SIDE_PANEL` hosting; no unrelated `getContexts()` identity is joined.
   See [the existing sidebar sender precedent](archive-operations.md).
4. **V4 — object-order comparison correction.** `JSON.stringify` equality rejected
   identical objects reconstructed with a different property order. With the
   seven-tab fixture and asynchronous storage/native reads, changing only object
   key order reproduced the exact preview error at
   `same(local.spaces, store.spaces)`, with zero writes. Recovery now reuses
   `encodeFavoriteContinuityState` for equality and fingerprints, sorting object
   keys only. Array order, exact IDs, values and metadata remain guarded through
   prewrite validation and readback. This proves a serialization defect, not the
   precise failed predicate in the user's live profile.

Normal/inverted pointer and keyboard paths, connection/token isolation, queued
and in-flight interruption, genuine identity conflicts and restart controls have
synthetic coverage. Native Helium restart continuity, every alternative workflow,
and the original historical sequence were not independently established. A write
already authorized and begun can complete after connection loss; uncertainty must
not cause automatic retry or rollback.

## Safe recovery and recurrence handling

1. Confirm that the recovery implementation is actually in the installed build;
   inspect its source/patch and file-hash provenance. Do not infer this from the
   manifest version or this documentation-only checkout change. If a newly
   approved build was installed, reload Arcify once to load it.
2. Select the affected ordinary Today tabs in the intended Space. Right-click
   and choose **Review Today recovery…**, not direct Move. Read the top status
   notice, then the **Use selected tabs as current Today tabs?** dialog.
3. Choose **Use selected tabs** only if that describes the exact intended tabs.
   Before submitting, Cancel, Escape or leaving the sidebar applies no
   confirmation. A changed/protected selection may correctly refuse a preview.
4. Wait for “Current Today membership confirmed. Historical recovery records were
   kept. Select the tabs and choose Move to again.” Then reselect and use
   **Move to Space…**. Recovery confirmation itself does not move anything.
5. If an error, partial result or uncertainty remains, stop repeated attempts and
   preserve the exact stage/message and build provenance. Do not clear storage or
   queues, force a window association, or disable the guard.

This is not periodic maintenance. **The same confirmed tabs becoming blocked
again after restart is a remaining continuity/recovery bug**, not a reason to
normalize repeated manual confirmation. New-lineage prevention reduces one
reproduced cause; it is not proof that every existing ambiguous record or restart
case is resolved.

For recurrence, first distinguish direct Move, preview and confirmation. Use
supported read-only inspection if available; do not enable debug ports or restart
a live browser just to obtain evidence. Record whether a restart/reload occurred,
which exact build is loaded if verifiable, the fresh error category, write stage
and receipt/readback certainty. Privacy-minimized diagnostics can use local
aliases, counts, same/different window-key relationships, saved/live index and
layout-equality booleans. Keep in-memory candidate state distinct from persisted
or later snapshots. Do not publish page URLs/titles, real tab/window/Space IDs,
reusable URL hashes or machine receipt locations. Do not reconstruct historical
preflight state from a later snapshot or ask for repeated identical captures.

## Validation and artifact provenance

All four scratch generations built successfully. Full unit results below each
had zero failures and four skips; these are not native browser acceptance counts.

| Build | Passed | Additional focused evidence | Complete patch artifact |
| --- | ---: | --- | --- |
| V1 | 7,533 | 51 recovery/UI checks | `recovery-implementation.patch` |
| V2 | 7,556 | 23 production-path checks reviewed independently | `recovery-complete-v2.patch` |
| V3 | 7,595 | 113 focused; 62 channel/menu checks reviewed independently | `recovery-complete-v3.patch` |
| V4 | 7,607 | 12 new storage-order regressions reviewed independently | `recovery-complete-v4.patch` |

Complete patch SHA-256 values, all relative to base commit `0995d9a` above:

```text
V1 2dd3ba5b299ee58eb5e681abbf6cf32512fe4c78ccaa6f42b7d645fa37e5d73d
V2 b17944d7eab94c21ae90ab69aca8f254de410a15cb0530e62064c17405194ff3
V3 a118c9cc6bdf967f78d3f811b8c25d171fabaf14518b897b813d8755d1a30031
V4 b690a71f310cd20b2d6b01361e29a0eaf13e854f77cdc2c59678525e4f98db9c
```

The task also retains verification JSON, reproduction evidence, logs,
`installation-receipt.json`, `installed-hashes.json` and rollback payloads outside
the repository. Those locations and browsing data are intentionally omitted here.
Each delivery reproduced the tested build in isolated source, checked every
output byte for byte, backed up the preceding dist, and verified all 51 installed
files. V4's installed hash-manifest SHA-256 was
`2edd16a0ee8f24365d30babd6437db525abf8386e028351acc4c0a9fb705e407`.

Relevant patched-source tests include `space-recovery-lineage.test.js`,
`today-recovery-store.test.js`, `today-recovery-ui.test.js`,
`today-recovery-menu.test.js`, `today-recovery-channel.test.js` and
`today-recovery-storage-order.test.js` under `tests/unit/`. The implementation is
in `space-store.js`, `space-restore.js`, `today-recovery-store.js`,
`today-recovery-channel.js`, `today-recovery-ui.js` and the Today/sidebar wiring.
These artifact references are not claims that every file exists in this checkout.
When integrating, use an isolated source tree with the complete patch applied;
run the relevant unit files, `npm run test:unit` and `npm run build`. A build in the
user's live unpacked-extension directory would replace its runtime payload.
