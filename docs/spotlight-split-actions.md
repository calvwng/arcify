# Spotlight Split / End Split

This additive stage has verified hosted Split evidence at Arcify `eb0e279` and Spotlight `e2ffbe0`: run `38900776291`, job `116972199344`, all 5 required cases passed with 31 screenshots and strict fixture cleanup. No merge, release, permissions, runtime security, or browser-setting changes are part of the feature.

## Exact optional contract

`splitActionsV1` is advertised only when both actual `chrome.tabs.createSplit` and `chrome.tabs.unsplit` exist. Chrome documents these APIs at [createSplit](https://developer.chrome.com/docs/extensions/reference/api/tabs#method-createSplit) and [unsplit](https://developer.chrome.com/docs/extensions/reference/api/tabs#method-unsplit). The positive hosted route requires official Chrome 155+; compatible Helium builds remain feature-detected. Protocol v1 snapshots, Space contexts, and tab-action contexts keep their existing exact schemas.

`splitActionContext` returns a dedicated context and `splitTargets`. The context contains exact window, selected Space/folder, pairing generation, source tab, optional source descriptor and an empty or verified two-member native pair. Each descriptor contains native ID, exact URL, projected title, native index/group/pin/split state. Native group IDs are compatibility witnesses, never Space identities.

Create requires an explicitly chosen ordinary Today tab in the same window, selected Space and native group. No choice is preselected. Equal titles/URLs remain separate identities in the picker, with native tab ID and position shown. End accepts only the exact adjacent two-member current native pair, including split ID 0. Helpers/New Tab aliases, Favorites, saved pins, native pinned tabs, provisional/restoring tabs and ambiguous memberships are excluded.

The provider owns all mutations inside the existing store queue. The Today native-split core is queue-free for this caller and remains wrapped for sidebar callers. General `safeLive` still rejects split tabs for all unrelated actions.

## Mutation and race boundaries

The provider continuously fences pairing, root/folder, Space, source focus, native descriptors, ordering and relevant events across every awaited action boundary. The final source remains active in its focused normal window. A native move can only move the later selected member immediately after the earlier member; unrelated relative ordering, other-window canonical slots and existing unrelated native pairs are preserved. Canonical persistence uses `skipGroupSync: true` and revalidates before each store write.

Only exact own adjacency/split/persistence events are allowed. There is no pin/unpin/group coercion, page navigation/recreation, URL inference, focus compensation, arbitrary execution, rollback over new state or mutation retry. Partial adjacency or uncertain native results explicitly warn and retain the one-shot journal state. The client rereads exact context, rereads persisted local pairing after final native checks, checks its monotonic native/pairing epoch, validates original source/target IDs and consumes only the exact native receipt. It never falls through to native APIs.

## Local verification

- Existing Today split tests still exercise the shared queue wrapper.
- Actual bridge/module tests cover left/right sources, aliases, unsupported capabilities, native split ID 0, incompatible/ambiguous members, exact own events, root/pairing/Space/source races, post-move failures, persistence fences, no replay and unrelated native pairs.
- Actual client/controller/overlay/New Tab DOM tests cover strict descriptors/receipts, pairing/native epochs, trusted explicit target selection, duplicate disambiguation, focus trap, Cancel/Escape/Enter, stale selection, projected aliases and helper exclusion.
- `node scripts/check-spotlight-pair.mjs ../arcify-spotlight` executes both real implementations through mocked Chrome APIs. `node scripts/test-spotlight-pair-contract.mjs ../arcify-spotlight` includes deliberate provider and consumer drift failures.

Mock and DOM checks do not establish native browser behavior or rendered geometry.

## Mandatory hosted evidence

The existing independent `native-split` job now requires cases `[0, 1, 2, 39, 54]`. Case 39 retains the sidebar evidence. New case 54 separately proves genuine Spotlight create/end, because sidebar-active acceptance does not establish a content source pane.

Case 54 requires:

1. Actual native API capability and installed Chrome major 155+; all existing fresh-profile, extension Developer-mode, process, package, sandbox and security checks remain mandatory.
2. Trusted Spotlight row activation, an initially unselected exact target picker, genuine target selection, and one click/Enter confirmation. Cancellation must preserve native and durable state.
3. Both left-source and right-source create/end with group sync off and on. Browser-attested content sender tab/window/URL and immutable external request must agree with the focused source.
4. Exact native pair membership and durable receipt, original document IDs/time origins/draft inputs, stable other-window state, all original IDs and no native activation/focus compensation.
5. Native X11 window screenshots proving both original colored top-level panes, and End Split screenshots. Parent-retained passive input evidence survives overlay iframe retirement; no retired iframe is polled for success.
6. One attempt per selected case, no skipped or retried success, incremental failure artifacts, and verified fixture cleanup.

The existing exact official Google HTTPS Chrome-update route, TLS/provenance checks, sandbox defaults and Developer-mode input route are reused unchanged. The verified hosted result covers Split only; Archive reopen intermittency and the separate Open Archive native-binding limitation remain independent, and manual Helium/physical-keyboard acceptance remains outstanding. The verified companion pin is `e2ffbe0982a19eacad23cc803aa42e8e6013c6d0`; integration must update it if the companion changes.
