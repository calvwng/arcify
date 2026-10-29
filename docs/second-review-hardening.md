# Second paired review corrections

The second independent review started from Arcify
`27c0c3149981ea128c8f34e081fe80428bc30e14` and Spotlight
`b8b193c1f803179f86ab2e2397e5f1169256f49d`. It found two additional
destructive-action blockers and two narrower follow-ups. These corrections are
Arcify-only; the exact Spotlight companion and all pair pins remain unchanged.

## Corrected behavior

1. Selected Close checks the pending destination separately from the committed
   URL. Chrome can expose both during navigation; the old committed URL must not
   conceal a changed pending destination. Whole-batch preflight rejects before
   any close, and per-item validation retains confirmed earlier progress without
   closing a later changed tab. Same-destination pending navigation remains valid.
2. Remove Pin checks the exact saved parent and backing folder ancestry after
   reading linked-tab ownership. Bookmark move/removal/change observation spans
   the asynchronous ancestry and final ownership reads, so a later read does not
   revive stale deletion authority. Both sidebar and paired callers supply the
   captured parent. Observation ends after deletion; successful removal still
   preserves linked live pages and performs its existing post-delete bookkeeping.
3. Clean reapplies saved protection to its final native tab snapshot, including
   both committed and pending saved URLs. This repairs a pre-existing cleanup
   gap. Unrelated ordinary tabs still close, and explicit Space deletion retains
   its all-owned-tabs semantics. Bookmark/binding snapshot semantics are unchanged.
4. Startup duplicate cleanup records the original created window and preserves
   moved helpers. Detachment/replacement revokes cleanup synchronously and retires
   its session receipt, including move-away-and-back. Legacy receipts without a
   window identity are conservative. A temporary native-event fence protects the
   final reads and last-tab check; an uncertain cleanup is never retried.

The original failures were reproduced with isolated simulated browser APIs, not
new native Helium tests. Browser operations remain non-atomic; these fixes reject
observable changes across the identified gaps without claiming atomic deletion.
Native Ctrl+W remains deferred.

## Regression and independent review

New regressions exercise pending navigation before preflight and during earlier
removal, Today and saved selections, moved pins and backing ancestors during
storage/tree/native reads, missing bookmark observation, successful own-delete
events and listener cleanup, committed/pending saved cleanup destinations, and
startup moves/replacements/navigation/sibling removal across awaited reads.
Existing successful ownership, partial-result and genuine duplicate-cleanup
assertions remain in place.

An independent reviewer inspected all four production corrections and callers,
then passed 285 tests across seven focused files covering close/UI refresh,
Clean/startup, menu/paired pin removal and transient boundaries. No substantive
finding remained in those patches. Full integration and exact-head CI results
are recorded by the integration owner after completion; historical green runs do
not qualify this new source.

Final local integration passed 8,311 unit tests with four existing skips and no
failures on Node 25.2.1, using Python 3.11 for the Python-backed pure helpers.
Production build and ZIP packaging passed. The real client/provider/store smoke
with simulated browser APIs and all 71 strict paired-contract regressions passed
against the unchanged Spotlight commit. The smoke fixture now exposes native-style
bookmark events required by the removal fence; its original assertions remain.
The initial build was blocked by Windows sandbox parent-directory access and
passed with the required build access. No runtime code workaround was necessary.
Exact-head native CI remains separate from these local results.

Work uses an isolated checkout and locked dependencies. No normal checkout,
installed extension, browser profile or user setting is changed, and neither
draft PR is merged. Existing native coverage limitations, including intact
Little Arc orphan recovery documented in `little-arc-reload-boundary.md`, remain.
