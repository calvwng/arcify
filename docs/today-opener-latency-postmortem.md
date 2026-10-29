# Today child placement and sidebar latency postmortem

## Outcome and source status

After installation of `saved-row-refresh-v1`, the user reported on October 29,
2026: **“It's much faster now!”** This is qualitative acceptance of the observed
improvement, not a new timed measurement or a guarantee for every profile,
restart, link, or ordering case. The user had separately confirmed correct child
placement after the earlier same-Space placement fix.

This incident had two distinct problems: a recovery-marked live parent could
lose child adjacency, and a correctly placed child could appear late in Arcify.
The separate Ctrl+W/context-menu multi-selection closing work is not included
in this build and remains outside this postmortem's resolution.

This record originally accompanied a documentation-only checkout at
`173ac8cad22039dd95ef87fcfe1308dfc55d7c88`. The isolated reconciliation now
includes the accepted implementation and tests, including
[sidebar-saved-section.js](../sidebar-saved-section.js). Its later menu/Delete
selection fix is separate from the latency incident. Native Ctrl+W remains deferred.
See [reconciliation provenance and current validation](release-reconciliation.md).
Manifest version `5.1.0` alone does not identify the loaded build.

See also [recovery/Move](today-recovery-move-incident.md),
[Today insertion](today-insertion-order.md), and
[sidebar scrolling](sidebar-management-scroll.md).

## Problem 1: current live placement versus historical recovery

The user's read-only capture showed a normal Today parent, an exact native
same-window opener, and a child created with a web `pendingUrl` while `url` was
missing. This was not evidence of genuine blank/New Tab creation. The parent
had one ordinary Today owner, no saved-pin binding, and a stored recovery or
provisional indication. Two historical records matched its URL. The child had
the same current owner but appeared at the configured top instead of below the
parent. These were non-atomic persisted observations; the exact executing
worker generation was not established. Two URL matches do not establish
duplicate identity, and they do not justify deleting recovery records.

Arcify recovery reconciles historical Space/window identity, ranks and metadata
with current browser tabs. Native browser restoration creates/restores native
tabs; it does not by itself prove Arcify's historical identity association.
A tab can therefore have a visible, unambiguous current Today owner while its
historical association remains provisional. Existing automatic reconciliation
and restoration guards must not be bypassed merely because the row is visible.

The narrow correction in [SpaceStore][space-store] separated two questions:

- Selecting a child's Space still requires the original ownership evidence.
- Once the child destination is independently established, an exact live parent
  with one ordinary Today owner in that same Space may supply creation adjacency.

`exactTodayOpener(..., placementSpace)` permits that second use without clearing
the parent's flags, consuming historical records, adopting old identity, or
using URL equality as authority. `insertCreatedToday` preserves verified Split
boundaries, sibling policy and rank bookkeeping. Restored-tab precedence,
cross-window and ambiguous-owner exclusions, pins/Favorites/transient exclusions,
and genuine blank/New Tab handling remain guarded. Later navigation is not a
new placement instruction and cannot undo manual reordering. This solved the
placement disruption without declaring recovery complete.

## Problem 2: a correctly placed row appeared late

The user confirmed that the native Helium tab appeared promptly while Arcify's
row was delayed by roughly three seconds. This narrowed the investigation to
the extension's model/render pipeline, without proving which stage was slow.
No inference that “three seconds means two 1.5-second timeouts” was justified.

| Iteration | Change and result | Why it was incomplete |
| --- | --- | --- |
| `same-space-recovery-child-v1` | Corrected creation-only adjacency using proven live ownership. User confirmed placement. | Did not address rendering cost. |
| `render-retry-candidate-v1` | Added coalesced prompt retries for superseded renders, bounded by the normal debounce interval. Small-fixture timing improved. | A prompt retry still rebuilt the expensive saved section. The user still reported delay. |
| `today-fast-path-v1` | Reused an already committed saved section when its complete display signature matched; updated Today alone. | Whole native snapshots, Space fields and conservative invalidation made reuse less common than a small fixture suggested. User observed mixed fast/slow attempts. |
| `frozen-signature-v1` | Removed only `frozen` from the saved-display signature, retaining the separate native-update commit fence. | `active`, `highlighted`, `index`, other row fields and structural revisions could still differ. This was not a general solution to saved-row refresh. |
| `saved-row-refresh-v1` | Retained proven structure while recreating affected live rows; separated receipt bookkeeping from structural revisions; recognized same-folder row projection. | Final fixture and qualitative user acceptance support the improvement, with the limits below. |

The retry implementation is in [refresh-coordinator.js][coordinator]. It keeps
the pending wake fixed so subsequent invalidations coalesce instead of pushing
it back indefinitely; it does not remove freshness, editor or cancellation checks.

### Measured stage evidence

Actual-session intervals below are transcribed from the approved captures in
the task conversation; they are distinct from the archived disposable benchmark
JSON linked later. Arithmetic was checked independently.

The first passive capture measured **1,735.3 ms** from native creation to row
observation. A storage checkpoint occurred after **45.5 ms**, leaving
**1,689.8 ms** until the row. A checkpoint event was not proof that this child's
model commit had completed.

An earlier temporary phase build measured **2,038.8 ms** native-to-correct-row,
with **58.4 ms** for the created-model request. Its ownership-to-bookmark-fragment
intervals were **803.7 ms** and **847.4 ms**. The first render was discarded and
the work repeated. Shared-Today reads took **7.5 ms** and **10.2 ms**.

The later `arcify-latency-diagnostic-v2` capture measured:

| Observed interval | Duration |
| --- | ---: |
| Native creation → correct adjacent DOM row | 2,110.4 ms |
| Created-model request | 71.7 ms |
| Ownership-read end → bookmark-tree end, first / second render | 18.2 / 17.1 ms |
| Metadata-read end → bookmark-tree end, first / second render | 17.8 / 16.6 ms |
| Cache mismatch mark → bookmark-tree end, first / second render | 17.5 / 16.4 ms |
| Folder-state end → bookmark-fragment end, first / second render | 906.7 / 851.1 ms |

The last pair totals **1,757.8 ms**, approximately **83.3%** of the observed
2,110.4 ms. The measured tree intervals include surrounding dispatch overhead;
they are not isolated API-duration measurements. The much larger fragment
interval contains sequential asynchronous row creation, DOM construction and
handler setup, not simply bookmark-tree API time or proven pure CPU time.
Worker initialization was not separately observed; it could be included in a
request span. DOM observation is not paint timing, and DevTools/reloads can alter
the behavior being measured.

The first v2 render was discarded with `displayStale=true` and
`savedRevisionStale=false`, after native status/URL/title events. The global event
log did not identify which tab caused the invalidation. Both signature mismatches
compared against the same old committed proof: repeated mismatch is not evidence
of a second mutation. Components were `space`, `savedTabs`, `revision`; native
field labels were `active`, `highlighted`, `index`, `other`. Neither that `other`
nor a storage `other` label identifies the hidden field/value. No later fixture
finding retroactively proves the exact user's hidden key.

## Final mechanism and safety boundaries

The final production delta from `frozen-signature-v1` is confined to
[sidebar.js][sidebar] and [sidebar-saved-section.js][saved-section].

1. **Separate structure from live row data.** Keep only already committed DOM.
   Exact Space/folder context, saved membership, binding metadata, settings and
   structural revision must agree. `lastTab` focus bookkeeping is excluded.
   Changed native row snapshots are compared; affected rows are recreated through
   `createTabElement`, including handlers and immutable Split registration.
   `active` affects CSS, while index/window/group/pin/Split/URL/pending URL enter
   captured action data. They cannot be blanket-ignored or merely painted over.
   Identity/window/group/Split/pin/incognito changes retain full fallback.
2. **Separate settled receipts from structure, not from freshness.** A disposable
   fixture first exposed revision 3 → 15 before the child, caused by local
   `tabLastActivity`, local `favoriteContinuity`, and session
   `favoriteContinuityReceipt`. Those exact-area bookkeeping keys now leave the
   structural revision unchanged but still advance the whole-render revision.
   That commit revision is captured before any await, covering ownership and
   metadata reads as well as construction. Fresh worker Favorite ownership,
   native tabs and bindings are still read. `favoriteSession`, persistent
   Favorites, pairing, active Space, unknown keys and mixed structural writes
   remain conservative. Schema transitions remain structural; only an explicit
   local supported-version `2 → 2` notification is a no-op.
3. **Recognize intentional folder projection.** A second fixture exposed a
   descendant row-list mismatch after the earlier guards passed. Existing
   collapse/reveal code moves the same live rows between a folder's direct
   content and collapsed display containers. The proof now requires the same
   exact row-node set and owning folder, allowing only those two direct parents.
   Root rows remain direct children; top-level order stays exact. Added/replaced
   nodes, cross-folder moves and arbitrary wrappers fail. Bookmark-ID anchors
   survive replacement. This is not a claim of canonical-order protection
   against arbitrary same-folder DOM tampering; native reorder events still
   invalidate structure.
4. **Commit only fresh work.** Keep the global display fence, structural/read
   revisions, Space checks, editor/drag guards, DOM revalidation and action-time
   checks. Abandoned detached replacements are never committed or cached as the
   saved proof. First render, unavailable tree, binding/membership or structural
   changes still use the full path. Recovery and Today creation ordering were
   not redesigned in this final rendering patch.

Both unsuccessful intermediate native comparisons remain in `performance/`
and `performance-final/` under the candidate artifact directory. Their timing
differences were not accepted as evidence of the intended optimization because
they rebuilt all 418 unaffected nodes. The final passing comparison is
[performance-projection-final/summary.json][performance].

## Validation and acceptance

Final full suite: **8,143 tests: 8,139 passed, four skipped, zero failed**.
The 46 focused tests passed, the production build passed, the patch applied to
the exact base with `git apply --check`, and independent source review found no
remaining blocker. The [verification report][verification] records these gates.

Verified regression names in the exact candidate include:

| Test source | Representative checks |
| --- | --- |
| [space-store.test.js][placement-tests] | `recovery parent places pendingUrl child locally without adopting history inverted=...`; `provisional parent can position locally without clearing its flag or selecting a Space`; recovery-placement refusal cases; repeated navigation and manual order. |
| [today-fast-path-integration.test.js][integration-tests] | `changed live saved native snapshots replace only changed rows and retain folder/closed DOM`; `replacement saved-row menu addresses exact live binding and rejects later binding drift`; `receipt during ... read discards changed saved rows before a fresh retry`; `Favorite ownership changes remain a full saved-section invalidation`; `projected saved-row replacement preserves bookmark anchor through collapse cycles`; `same-folder native bookmark reorder still forces full structural refresh`. |
| [saved-row-refresh.test.js][row-tests] | Exact-area/mixed-key revision handling, changed row snapshots, identity/binding negatives, projection cycles and cross-folder/wrapper/replaced-node refusal. |
| [sidebar-saved-section.test.js][signature-tests] | Frozen-only normalization without mutation, separate in-flight fence, exact committed DOM, schema transitions and structural invalidation. |
| [refresh-coordinator.test.js][retry-tests] | Superseded-render retry scheduling and existing coordinator protections. |

The final disposable Helium fixture had 400 bookmarks, 20 folders, two live saved
pins and 12 initial tabs. Each child shifted both saved native indices; activation
changes occurred between samples. There were three ordinary and three burst
samples per variant, run sequentially without concurrent tests/builds.

| Median | Frozen baseline | Final candidate |
| --- | ---: | ---: |
| Native child → correct DOM row, ordinary | 642.6 ms | 166.7 ms |
| Native child → correct DOM row, burst | 930.8 ms | 504.3 ms |
| Ownership end → bookmark phase end, ordinary | 196.0 ms | 6.25 ms |
| Ownership end → bookmark phase end, burst | 160.1 ms | 5.1 ms |

All 12 baseline/candidate first child rows were correct. Every candidate sample
retained all **418 unaffected bookmark/folder nodes**, replaced exactly **two
live rows**, and performed **zero sidebar bookmark-tree reads**. Freshness
discards still occurred. The fixture used the actual sidebar document in an
extension tab, not the native side-panel container; Spotlight was unpaired.
These are DOM measurements, small sequential samples, not randomized trials or
percentile estimates. The user's subsequent “much faster” report is separate
qualitative real-profile acceptance, not these fixture timings.

## Reproduction and diagnostic checklist

1. Establish the exact installed artifact and loaded generation separately;
   installation on disk does not prove a running worker/sidebar reloaded.
2. Reproduce one fresh child from an ordinary Today parent. Note native-strip
   appearance versus sidebar appearance, final adjacency, selected Space,
   current window and whether the row appears late or moves later.
3. For placement, distinguish web `pendingUrl` from genuine blank/New Tab,
   exact native opener from URL similarity, current unique owner from historical
   recovery, and independent destination from opener-derived destination.
   Include saved-pin/Favorite/transient/Split and manual-order controls.
4. For latency, capture native-created, model request, ownership/metadata read,
   cache eligibility, tree/folder/fragment phases, discard reason, commit and
   first correct row. Label every interval's endpoints. A storage event alone
   is not a child's commit. Preserve the full global freshness check.
5. Use disposable fixtures first with large bookmark trees, live saved tabs,
   native index/activation changes, activity/continuity storage events, collapsed
   projection and update bursts. Assert unaffected-node retention, changed-row
   action freshness and correct order, not just faster timers or fewer API calls.
6. Any new actual-profile diagnostic requires a bounded, explicit workflow:
   user manually reloads/arms; one child/timeout/cancel cleanup; no raw URL,
   title, ID or stored-content output; verified rollback of temporary builds.
   Do not automatically open the worker inspector or change browser security
   flags. Record the disturbance caused by inspection/reload.

## Installation, rollback and evidence

The exact tested archive was installed without rebuilding on October 29, 2026
at 04:19 UTC. Only installed `sidebar.js` changed. All 53 Arcify files matched;
the 84 Spotlight files and existing checkout edits were verified unchanged.
Settings, permissions and pairing were not changed. No browser operation or
extension reload was automated; runtime activation cannot be proved from the
installation receipt alone.

| Artifact | SHA-256 |
| --- | --- |
| `arcify-saved-row-refresh-v1.zip` | `8a06d5b0627abec4ff4a37c66603fa9c89a680ebe9f6244d7d02ca8608779c33` |
| Installed 53-file inventory JSON | `887b2b15cb561673293a3d3049ad3e98d3b3bd64c33c81ae01da99ef3d156694` |
| `saved-row-refresh.patch` | `43011acfc6f252dae97bed64386f93cde56264345699b1645661e990d67a24cf` |
| Frozen rollback inventory JSON | `1765f1c642514d4130349f6d29594480b214597738816d82fbf77d9b618d10cb` |
| Spotlight inventory JSON | `735a36ac9b00c1e415ddc641211464dae852ee28237e08b176d68dc21ddae8fa` |

The [installation receipt][receipt] and [rollback instructions][rollback] identify
the verified backup at `saved-row-refresh-v1/install-receipt/rollback/arcify-dist`.
For a separately authorized rollback, verify the current entire installation
against its installed manifest and the backup against its prior manifest before
copying. Stop on unrelated drift. Restore exact bytes without rebuilding, verify
all files and Spotlight, then have the user reload Arcify. Do not uninstall,
clear storage, re-pair, overwrite source edits or assume an uncertain copy failed.
Inventory hashes above are hashes of manifest JSON files, not of one executable.

The tested source used Node 25.2.1, npm 11.6.2 and the existing lockfile/dependencies;
Python 3.11.9 supported the test harness. Full tests used `node --test
tests/unit/*.test.js` with explicit `ARCIFY_TEST_PYTHON` and
`PYTHONDONTWRITEBYTECODE=1`; build used `npm run build`. The
[SOURCE-PROVENANCE.txt][provenance] and [verification report][verification] are
pre-install validation snapshots and retain their historical not-installed
status. The later [installation receipt][receipt] establishes the installed
state. Consult all three and the artifact manifests before reproducing.

## Lessons

- Diagnose placement and presentation separately; a correct persisted order can
  still be rendered late.
- Optimize the expensive measured phase. Faster retries alone can repeat costly
  construction, and tree-read counts miss per-row construction and handler cost.
- A cache proof must model display dependencies, live action data and structural
  identity separately. Do not erase important fields to increase hit rate.
- Keep a whole-render race fence even when settled bookkeeping is eligible for
  structure reuse. Read ownership freshly; never make cache identity action authority.
- Include real index shifts, live saved rows, continuity writes and collapsed
  projection in fixtures. Small/static fixtures overstated earlier readiness.
- Preserve failed experiments and exact artifact provenance. Distinguish fixture
  evidence, actual-session observations and qualitative acceptance throughout.

[source]: ../
[space-store]: ../space-store.js
[coordinator]: ../refresh-coordinator.js
[sidebar]: ../sidebar.js
[saved-section]: ../sidebar-saved-section.js
[placement-tests]: ../tests/unit/space-store.test.js
[integration-tests]: ../tests/unit/today-fast-path-integration.test.js
[row-tests]: ../tests/unit/saved-row-refresh.test.js
[signature-tests]: ../tests/unit/sidebar-saved-section.test.js
[retry-tests]: ../tests/unit/refresh-coordinator.test.js
[performance]: C:/Users/calvw/Documents/Codex/2026-10-27/task/saved-row-refresh-v1/performance-projection-final/summary.json
[verification]: C:/Users/calvw/Documents/Codex/2026-10-27/task/saved-row-refresh-v1/verification-summary.json
[receipt]: C:/Users/calvw/Documents/Codex/2026-10-27/task/saved-row-refresh-v1/install-receipt/installation-receipt.json
[rollback]: C:/Users/calvw/Documents/Codex/2026-10-27/task/saved-row-refresh-v1/install-receipt/rollback-instructions.json
[provenance]: C:/Users/calvw/Documents/Codex/2026-10-27/task/saved-row-refresh-v1/SOURCE-PROVENANCE.txt
