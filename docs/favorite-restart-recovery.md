# Conservative Favorite recovery after restart

Arcify can reconnect a uniquely matching restored page without opening, navigating,
pinning, focusing, closing, or moving it. The Favorite quietly appears Open. It
retains an **inferred association**, not proof of browser identity. Existing exact session/witness
continuity remains unchanged.

## Eligibility

An initial hint must have been captured while Arcify owned the exact Favorite
tab. Later observations may refresh an existing inference, retaining its original
evidence and inferred provenance without establishing exact ownership.
The first upgrade cannot infer a history that earlier builds never recorded.
Hints are local only, expire after 30 days, and do not change saved Favorite URLs,
titles, source bookmarks, manifests, permissions, or the V3 bridge schema.
At most 64 hints of 16 KiB each are considered. Rollback placement keeps at most
three nearby page descriptors per side; oversized or ambiguous cases stay manual.

Recovery requires all of these to match:

- The saved Favorite ID, shortcut URL and bookmark provenance.
- The actual page's complete URL, title, and native pin state.
- A SHA-256 fingerprint of the complete normal window's HTTP(S) URL/pin multiset.
- Exactly one matching live URL across normal windows and no competing saved
  Favorite or hint for that URL/identity.

Private, transient, startup-helper, loading/navigating, grouped, Split View and
Space-bookmark pages are excluded. Native restoration gets a bounded settling
period, followed by fresh sample validation. Slow/partial restoration, changed
windows, duplicate pages, changed titles, missing evidence, and malformed hints
remain manual. The existing **Attach existing tab** flow is available for them.
No late new-tab opening is automatically claimed after the startup pass.

Exact bindings refresh their checkpoint when the sampled native cohort changes,
including a newly created already-complete tab, or when only a page title changes.
An asynchronous capture is discarded if the native sample changes before writing.
Inferred associations refresh their current URL, title, pin state and full window
cohort only after the same eligibility, uniqueness, fresh-sample and revision checks.
They retain their first recovery time, original evidence, inferred provenance and
independent Undo placement. A later restart must again pass every matching gate;
refreshing observations never creates an exact binding or a V3 continuity receipt.
Ineligible observations remove restart eligibility while keeping same-session Undo.
Worker activation never republishes stale session observations over the local journal.
A native change during checkpoint persistence invalidates the committed journal.

## Quiet recovery and Undo

There is no persistent review card or Confirm prompt. A recovered Favorite looks
Open and activates the existing page. Its tooltip explains automatic reconnection;
right-click or Shift+F10 offers **Undo recovery**, including in compact layout.
Moving, closing, releasing, re-adopting or removing an inferred association remains
guarded. Undo first to return it to Today, then perform the intended explicit action.
Stale UI requests use the same backend guards. No automatic path calls Confirm.
The legacy explicit Confirm transaction remains compatible with an already-open
older sidebar, but is not surfaced or required by the quiet UI.

A late duplicate live URL or saved Favorite revokes the inference through durable
rollback, preserving both pages. It does not retry the rejected association. A
session-only safety record keeps the formerly inferred native tab protected from
automatic grouping and cleanup after rollback, including across worker restarts.
These numeric safety guards never cross a full browser restart or attach a page.

**Undo** removes only the inferred association, keeps the saved Favorite and page,
and restores the prior normal Space and relative order. Its session journal
survives a worker interruption. A local stable-Space/unique-neighbor descriptor
preserves the rollback destination across a further full browser restart; old
numeric IDs are never reused as identity. Changed/deleted Space or ambiguous
neighbor evidence leaves the restart case manual. Newer unrelated placements are
not overwritten, and a Space bookmark is never stolen.

## Storage and compatibility

- `favoriteRestartHints` in local storage holds bounded recent evidence, a compact
  window fingerprint, optional stable rollback placement, and explicit inferred
  provenance plus original evidence. V2 observations are ignored by V1 readers.
- `favoriteRestartRecovery` in session storage holds inferred tab associations,
  Undo tokens, the current-session Undo receipt, and revoked-match safety guards.
- Neither key is `favoriteSession`, a continuity receipt, or a saved Favorite.
  Inferred associations are never exported as exact Favorite bindings to V3.
- Hint invalidation precedes acknowledged ownership removal. Failed writes do not
  authorize native tab mutation. Durable suppression prevents a failed Undo session
  acknowledgement from recreating restart hints. Interrupted Undo stays journaled until Space
  persistence succeeds.

Older builds ignore these auxiliary keys. They cannot maintain inferred recovery
or its safeguards; Undo inferred associations before downgrading. Saved link and exact
ownership schemas remain compatible. No installed extension or normal browser
profile is changed by the implementation/test process.

## Verification

Run `npm run test:unit`, `npm run build`, and the disposable native recovery
fixture `node scripts/disposable-favorite-recovery.mjs`. Set
`ARCIFY_DISPOSABLE_BROWSER` to an already-installed browser executable and
`ARCIFY_FAVORITE_RECOVERY_CASE` to `quiet-repeat`, `undo-repeat`, `confirm`, `ambiguous`, or
`title-update`, or `diagnostic-title-change`. The title case removes sidebar listeners before changing only the
page title, observes the stored checkpoint without a Favorite read, then verifies
full restart recovery and Undo. The diagnostic case changes a synthetic page title only after closing the disposable browser, then verifies fail-closed recovery and the packaged Settings report. `ARCIFY_FAVORITE_RECOVERY_BUILD` can select an
existing build directory for baseline comparison; that directory is copied, never
modified.
It always creates a fresh temporary profile and closes only its own processes. Unit coverage
includes ambiguity, stale consent, destructive-route guards, V3 projection,
Space-bookmark precedence, exact Undo placement, failed local/session writes,
worker restart, and a second full browser restart. Native acceptance evidence is
recorded separately and is not implied by mock tests. The quiet-repeat case changes
the inferred page and window cohort, performs two more full restarts, then uses
menu Undo without Confirm and verifies the same live document, draft and history. Physical Helium restart,
mixed-profile behavior and installed-build acceptance remain separate checks.


## Persistent startup diagnostic

Settings > Recovery status > **Read Favorite restart diagnostic** displays the
latest locally recorded startup decision, the last relevant hint checkpoint,
and a frozen copy of that checkpoint from before the startup decision. **Copy
diagnostic** copies only that displayed sanitized report on an explicit click.
Opening Settings or reading this report never runs recovery, retries inference,
changes settings, or modifies tabs or saved Favorites.

The diagnostic contains only allowlisted bounded counters, status values and
capture timestamps. It includes no URLs, titles, IDs, names, window fingerprints,
review tokens, exceptions or telemetry. It is stored under the separate local
`favoriteRestartDiagnostic` key; it does not participate in any matching or
ownership decision. Failed diagnostic writes do not veto recovery. At most three
fixed-shape summaries are retained and overwritten by subsequent observations;
this is not an event history or evidence of a clean browser shutdown.

Startup counters explain the first failing gate for each hint, including missing
or invalid evidence, duplicate candidates, loading/navigation, changed title/pin,
changed window cohort, and the final changed-sample check. A successful match and
an activated association are counted separately; later Space-bookmark or rollback
placement refusals are visible. A separate diagnostic-only session marker preserves the startup decision across
worker wakeups, including a skipped no-hint decision. If the unchanged recovery
lifecycle later makes its first actual inference attempt, that attempt replaces
the earlier skip. This marker never authorizes or suppresses recovery itself.

Checkpoint counters can distinguish a missing hint from a prior capture refusal.
For example, the current checkpoint replacement policy can drop evidence while a
page is loading or another page in its window is navigating, and a tab disappearing
can make its prior binding ineligible. These paths are reproduced by synthetic unit
tests, not established as the cause of any particular Helium session. This diagnostic
change does not alter that policy, the bounded settling interval, matching safeguards,
the rule against claiming arbitrary late-created tabs. Quiet recovery keeps
inferred provenance and Undo while refreshing eligible observations as described above.

Identical skipped-checkpoint status/counters are not saved again just to advance the timestamp.
Their timestamp remains the first observation of that unchanged summary; a changed
reason, status or count creates a fresh report. No matching or Archive mutation
guard is relaxed.

The report describes historical observations, not the live browser state. It cannot
reconstruct a failure from before this build captured it. Validate an installed build
and reproduce the browser restart before treating its report as native evidence.
