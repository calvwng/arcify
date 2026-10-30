# Sidebar multi-selection and native Ctrl+W: deferred research

Reconciliation note: the accepted source is now present in this isolated working copy. Historical checkout statements below describe the original documentation event; see [current provenance and limits](release-reconciliation.md).

Status: **deferred pending platform or design capability**, October 29, 2026.
This is a research record, not an implementation plan in progress or an assertion
that Ctrl+W is fixed.

## Goal and accepted alternative

The requested UX is to select multiple live tabs in Arcify and close that exact
selection using either the row context menu or Ctrl+W. Context-menu batch close
and unmodified Delete on a focused sidebar row are implemented in the isolated
`selection-anchor-fix-v2` candidate and accepted by the user. The candidate folder
is named `selected-close-fix-v2`. A plain-click anchor followed by Ctrl-click was
initially missed by tests and then corrected and tested with real sidebar inputs.
Closing live saved instances preserves their saved pins/Favorites. Closed saved
rows are excluded; Today and saved selection surfaces remain separate. Editor
focus is not treated as row-focused Delete.

The installed 53-file inventory SHA256 is
`860426c11095e6b474c4dab569fa63d53a8c58d7e88e46b755299f76621eb388`.
It includes the accepted latency fix and menu/Delete correction, but excludes
Ctrl+W. These changes live in isolated candidate source, not an integrated commit
in this documentation checkout. Existing checkout docs/code may describe an older
state. This note does not change that code or the
[latency postmortem](today-opener-latency-postmortem.md).

## Shortcut and API findings

Ctrl+W is a browser-reserved native close command. The research did not register
an unsupported override, install global hooks, or cascade closes from arbitrary
native tab-removal events. The proposed route was to synchronize native selection
and let the browser close its selected tabs. Chromium's native close implementation
supports that source-level rationale, but actual Helium Ctrl+W delivery and batch
closing were **not verified**. A user earlier observed only one tab closing in a
disposable test; exact focus/selection state was unconfirmed. CUA native input was
blocked because the browser URL could not be verified. That operation was not
retried or bypassed; synthetic keyboard events are not native acceptance evidence.

Disposable SIDE_PANEL experiments used Helium `Chrome/156.0.8078.47`:

* `tabs.highlight` with a fresh index list worked in the stable case, with active
  A first. Moving unrelated C between index lookup and execution instead selected
  C+A. Fresh reads and post-write checks do not remove that execution gap.
* Exact-ID `tabs.update(B, {highlighted:true, active:false})` avoids positional
  substitution, but adding B activates it. Chromium implements highlighting and
  activation separately; newly highlighting an unhighlighted target activates it; an already-highlighted target is a no-op.
* Adding B/C, removing A from selection, then re-adding A restored active A while
  all intermediate selections were subsets of intended A/B/C. The tested same-window reorder did not substitute IDs; a missing/replaced ID was rejected without selecting its replacement.
* Own activation cleared baseline Arcify UI selection. Expected-transition handling
  is modeled, not wired into production. Blur cannot simply be suppressed: it can
  mean external handoff. Panel closure/Space changes need ownership cancellation;
  cleanup must not replay stale native selection over a user's newer selection.

Exact IDs therefore improve targeting materially. Intermediate intended subsets
and activation are manageable design issues, not themselves wrong-ID failures.
Three **observed browser execution-boundary races** remain after the last read:

| Concurrent change before dispatched add-B executes | Observed native result |
|---|---|
| User/native selection changes to unrelated X | X+B: the late extension write appends after handoff |
| B moves into another window with active F | F+B in the destination window |
| B gains an unselected Split peer X | A+B+X: browser highlighting expands to the peer |

The ID controller stopped further writes on mismatch. It could not revoke its
already-dispatched write or prevent native close during the exposed interval.
One in-flight request bounds stale operation count, not exposure duration.

## Scope of the constraint and architectures considered

This is a bounded argument about current APIs and the three demonstrated external
changes, not universal impossibility under all future APIs or a demand to prevent
legitimate user changes. Stable and adversarial executions look identical to the
extension until one queued write executes. Current update receives no expected
window/selection/topology predicate to reject the changed execution.

Generation tokens, serialization, fresh validation, expected-own-activation
handling, debounce, focus checks, and post-write verification help stop subsequent
work. They cannot make that dispatched write conditional. Explicit arming or a
confirmation/preview narrows when writes happen but retains the same gap. Calling
native selection authoritative while sidebar clicks still write it also retains
the races; relabeling an unintended peer does not make it user-intended.

A passive native-selection observer performs no native selection writes or
restoring cleanup, so it causes none of these mutation races. The tradeoff is
explicit: users must select in the native tab strip; sidebar-local selection
cannot determine reserved Ctrl+W targets. Native selection changes remain
authoritative, including browser Split semantics. Any sidebar indicator is an
observational snapshot, may lag, and must not imply a durable armed state or hide
out-of-Space selected targets. This is an alternative UX, not fulfillment of the
original request. Keep menu/Delete for sidebar-local batches. Their validation is
not asserted here to prove immunity to every concurrent close/move race.

## Missing capability and revisit triggers

Safe selection commitment requires validation and mutation in one browser
operation: exact IDs, expected window and native selection/topology state, and
rejection of unexpected Split expansion or moved IDs. A browser-issued revision
or equivalent atomic explicit-state predicates could supply this. An extension's
own generation counter is insufficient. Private Arcify Space ownership also needs
coordination; a native revision alone cannot validate private store state.

Even atomic selection commitment cannot promise that later Ctrl+W closes the
earlier sidebar intent after legitimate native changes. That stronger contract
requires a browser-owned conditional close/lease checked at keyboard dispatch,
with exact target/scope validation and no implicit peer expansion. If focus loss
or panel closure revokes intent, browser-side invalidation must participate.
These are proposed capabilities, not available APIs or approved browser patches.

Revisit when:

1. Chromium/Helium exposes conditional exact-ID selection or conditional native
   close, with documented window, Split and lifecycle semantics.
2. A separately approved browser-side design can enforce those conditions at
   execution/keyboard dispatch.
3. The user explicitly accepts native-tab-strip selection as the control surface,
   enabling the passive-observer alternative without silently changing the goal.
4. An approved native-input path becomes available for disposable-profile keyboard
   acceptance. That resolves the test gap, not the demonstrated API safety gap.

Before any revived integration, reproduce current API semantics in a disposable
profile, test ownership handoff and queued-write interleavings, reconcile genuine
sidebar input/focus/refresh behavior, and independently review. No further build,
installation, normal-profile test, permissions change, or browser patch is part
of this documentation task.

## Evidence and provenance

These absolute local links are machine-specific evidence, not portable repository
assets. Preserve or relocate the research archives before removing the task folders.

* [Accepted selection correction](C:/Users/calvw/Documents/Codex/2026-10-28/task/selected-close-fix-v2/RESULT.txt)
  and [installation receipt](C:/Users/calvw/Documents/Codex/2026-10-28/task/selected-close-fix-v2/install-receipt/installation-receipt.json).
* [v1 report](C:/Users/calvw/Documents/Codex/2026-10-28/task/native-selection-prototype-v1/RESULT.md):
  stable/index-race API probes; 55 planner tests. The attempted webpage-focus
  probe did not establish webpage focus and is not evidence for that context.
* [v2 report](C:/Users/calvw/Documents/Codex/2026-10-28/task/native-id-research-v2/RESULT.md),
  [final controller browser log](C:/Users/calvw/Documents/Codex/2026-10-28/task/native-id-research-v2/id-controller-browser-final.log),
  and [Split probe](C:/Users/calvw/Documents/Codex/2026-10-28/task/native-id-research-v2/id-split.log):
  real ID API experiments and 32 passing controller tests. Independent review
  found a final-publication cancellation bug; three regressions preceded its fix.
  Fixture failures (nonadjacent Split setup and a click hitting the fixed footer)
  were corrected, retained in logs, and not counted as successful observations.
* [v3 report](C:/Users/calvw/Documents/Codex/2026-10-28/task/native-ownership-research-v3/RESULT.md)
  and [model](C:/Users/calvw/Documents/Codex/2026-10-28/task/native-ownership-research-v3/model.test.mjs):
  142 independently reviewed passing **abstract** tests, including 125 passive
  observer schedules, writing-architecture counterexamples and a hypothetical
  conditional primitive. These are not 142 browser tests, a real primitive, or
  native Ctrl+W verification. Passive safety follows from absence of writes;
  enumeration is only a sanity check.

Primary sources checked October 29, 2026:
[Tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs),
[commands restrictions](https://developer.chrome.com/docs/extensions/reference/api/commands),
[Chromium tabs implementation](https://raw.githubusercontent.com/chromium/chromium/main/chrome/browser/extensions/api/tabs/tabs_api.cc),
and [native browser commands](https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/ui/browser_commands.cc).
Current source may differ from the tested Helium binary; source reasoning and
actual API observations are distinguished above.

