# Supplemental fresh-profile Archive actions acceptance

Status: prepared, not browser-accepted. The import-safe module and assertion tests
never launch Chrome. The independent reopen-only plan below is also pending
hosted evidence. Actual acceptance requires the exact reviewed pair in the
sandboxed hosted job; no local browser or workflow run is implied by these tests.

The independent `archive-actions` job sets
`ARCIFY_PAIRED_RUN_MODE=archive-actions` and requires exactly five cases, once,
in this order:

- 0–2: unchanged sandbox/identity, genuine pairing UI, and localhost base fixture
- 52: genuine Open Archive input and existing global popup in a native Side Panel
- 53: genuine exact-entry reopening, durable receipts and fail-closed rejection

The independent `archive-reopen` job sets
`ARCIFY_PAIRED_RUN_MODE=archive-reopen` and requires exactly four cases:
`[0, 1, 2, 53]`. It uses a separate fresh runner/profile and the single unchanged
case 53 callback, whose fixture owns its setup, observations and cleanup. Case 52
is not a prerequisite: a native-popup failure in `archive-actions` cannot prevent
this separate job from reaching exact-entry reopening. The original five-case
`archive-actions` plan still requires both cases and still stops on any failure.
An `archive-reopen` pass cannot supply native-opening evidence or turn a failed
`archive-actions` run into a pass.

Every selected case is mandatory. Missing, skipped, duplicated, reordered,
mislabeled or extra results fail closed. Failure stops the plan; there is no
same-profile retry, isolation exemption, upstream dependency or allowed failure.
Both independent jobs use the same 20-minute timeout, installed Chrome package,
ordinary Developer Mode UI, read-only exact-head checkouts, sandbox/runtime and
crash/error guards as the other plans. They add no permissions or security changes.

The existing plans retain their original cases and order: full 49, Favorite
lifecycle 5, native Split View 4, appearance/actions 8, recovery/actions 5 and
extended-actions 5. Cases 0–51 retain their identities and order. Archive itself only adds its
explicit HTTP route and cases; the separately reviewed control-window fixture
normalization in case 36 is retained. Original job security/body receipts remain
unchanged. The original seven jobs remain mandatory, with `archive-reopen` added
as an eighth mandatory outcome. All eight jobs must use the same
reviewed exact Spotlight revision, currently
`b510b3dbe8cfae6441fbc55a23ce19de30805a6d`. This local pin does not publish it
or run a workflow.

## Case 52: native opening

The six required positive combinations are click and Enter, each on an owned
Spotlight New Tab, Chrome's real browser New Tab alias, and an ordinary localhost
page's isolated overlay iframe. Every invocation requires:

- A visible, matching Open Archive row above the retained web-search option
- Exactly one passive-observed trusted, unmodified activation
- One direct renderer `arcify-archive-open` request with an opaque one-use token;
  worker relays and the existing `arcify-sidebar` command cannot satisfy it
- A real native `sidePanel.onOpened` receipt in the exact source window
- A unique `runtime.getContexts` SIDE_PANEL identity, a renderer with no ordinary
  `tabs.getCurrent` tab, and exact browser-derived window ownership
- The existing native-capture adapter's stable nontrivial viewport, coherent
  Space rendering, and matching PNG dimensions
- Exactly one visible existing `.archived-tabs-popup.visible`, its normal archive
  controls, and the full global archive list with stable entry IDs and titles
- One actual `arcifyArchiveIntent` ACK with `displayed:true`, the invocation's
  token, and the same native `documentId`; ordinary sidebar tabs cannot ACK
- The real renderer status “Arcify Archive opened.”, retained source document
  identity, and unchanged tabs, saved state, archive records and Space membership

After the first genuine Spotlight open, the actual native `.sidebar-button` is
clicked to close and reopen the popup. Each trusted click must preserve all
underlying native/store identity. Closing requires visible `.space-content`
without its `hidden` class, an invisible popup and `aria-expanded=false`;
reopening requires the inverse and the same complete archive list. Visibility
checks include computed opacity, display, visibility and viewport geometry.
This round trip cannot be satisfied by closing the whole Side Panel or changing
DOM state in the driver.

The panel is closed between positive combinations so each requires a fresh real
opening receipt. An additional fresh-token non-gesture send uses explicitly
`userGesture:false` DevTools evaluation and must fail without a panel, native
mutation or state change. It is a negative protocol probe, never positive input.
Already-open panel reuse and worker-epoch/cold-open races remain separate runtime
unit coverage; this case does not manufacture new native events for them.

## Case 53: exact reopen and rejection

The fixture owns two distinct same-URL archive records with different stable IDs,
names/times and extra unknown legacy metadata. Their original Space differs from
the selected source Space. A same-URL Today tab and live saved-pin tab in the other
window, their saved bookmark, and a persistent Favorite provide independent
identity decoys. Setup uses the real stores and native APIs only for disposable
fixture creation; accepted reopen actions always start at a visible result.

The browser New Tab alias uses genuine Enter to reopen the second record. The
ordinary overlay uses a genuine click to reopen the first. Each must yield:

- Exactly one real `reopenArchivedTab` request carrying context, private view ID
  and exact entry ID, never a guessed URL or a client-supplied full record
- Exactly one native create receipt with a new ID in the invoking source window
- Exactly one Today membership in the original Space and its original folder
- The created native tab active and the original Space selected. The browser New
  Tab helper must show real success status naming that Space. Native activation
  closes the tracked overlay before its callback can render status, so overlay
  completion instead requires the verified real request and exact durable/native
  commit followed by retirement of the original source overlay. The driver never
  reactivates the source or invents a status to satisfy this proof
- Existing native IDs, pages, pin bindings, bookmark tree, Favorites and the
  other window's selection/active tab unchanged
- Only the chosen archived record removed; its same-URL twin remains unchanged
- A durable consumed claim retaining the full original record, native ID and
  original folder, in the same observed storage change as the exact removal

Each positive action keeps its selected-before screenshot and its original
source-status or overlay-retirement proof. The complete exact request, native
create and consumed receipt checkpoint is saved before the required after-shot.
That after-shot shows the newly active reopened destination. A target set taken
before trusted input must yield exactly one fresh page target, correlated with
exactly one new native ID from the original tab baseline. Existing same-URL tabs
cannot be selected. Before and after capture, the native tab must remain active
in its focused source window, the target and document URLs must match, and the
same visible, focused, fully loaded document must retain its identity. Full
native/durable state and intervening mutation observations must remain unchanged.
Capture never activates or navigates a tab; a missing or failed screenshot still
fails the case without retrying the action or the capture.

The two new native IDs must differ. Re-sending each captured real request ID through
actual Chrome extension transport must return its exact cached consumed result
without a second create, archive consume or storage/native mutation. A new request
ID carrying the consumed private view must instead reject as STALE_ARCHIVE.

An explicit fixture-only durable `creating` claim with no known native ID models
a previous unconfirmed create. Two fresh visible UI attempts (click, Enter) must
show the actual error, retain the exact claim and record, and create nothing.
This is seeded-state browser coverage, not a claim to reproduce a real crash or
lost callback. Prepared real views are also sent after a selected-Space change
and after genuine pairing revocation; both actual receiver requests must reject
without native/archive/saved changes. Contextually failed requests may append
only their exact pending request journal receipt: its sender/generation/request
key, full fingerprint and bounded prior tail are checked, with no success
response and no other changed local/session key. Revoked pairing and cached
replay allow no journal change. These stale-view probes are labeled transport negatives, not
fabricated renderer gestures.

Both cases own and remove only their disposable tab IDs, bookmarks, Space roots,
Favorites, archive records and claims. They restore selected Spaces, settings,
active tabs and focus, and verify cleanup. Unknown/unowned cleanup state fails.

## Evidence and limits

`test-results/paired-chrome-archive-actions/` contains report.json, required
screenshots and runner.log, uploaded on success or failure as
`paired-chrome-archive-actions-<run>-<attempt>`. Independent report fields
`spotlightArchiveOpen` and `spotlightArchiveReopen` retain incremental checkpoints,
including partial failures. The independent reopen-only job writes
`test-results/paired-chrome-archive-reopen/`, uploaded on either outcome as
`paired-chrome-archive-reopen-<run>-<attempt>`. Its report declares only the four
selected cases and records `spotlightArchiveReopen`; it contains no
`spotlightArchiveOpen` acceptance. Evidence-save and screenshot failures fail the
case in either plan.

Deterministic lost ACK, response tampering, mid-callback pairing/selection races,
and worker/browser crash boundaries remain unit/mock coverage. Physical keyboard,
Helium behavior and the actual hosted result remain unverified until separately
run and reviewed. All eight exact-head jobs must pass; independent reopen success
cannot override another job's failure. A passing Archive plan does not claim full-suite, extended,
recovery, appearance, Favorite lifecycle or native Split View acceptance.

Local checks with no browser launch:

```sh
node --check scripts/paired-chrome-spotlight-archive.mjs
node --check scripts/paired-chrome-smoke.mjs
node --test tests/unit/paired-chrome-spotlight-archive.test.js tests/unit/paired-chrome-archive-wiring.test.js tests/unit/paired-chrome-run-plan.test.js
npm run test:unit
```


## Reopen load-event fence regression

The first hosted `archive-reopen` run on Arcify `02cb27675120b9a14333be9048934581c24a07ad`
with Spotlight `b510b3dbe8cfae6441fbc55a23ce19de30805a6d` completed the browser New Tab
reopen but stopped after the overlay reopen created its exact inactive native
tab. The latter entry remained archived with its durable claim at `created`,
before assignment or consumption. That failed attempt did not retain its exact
receiver response or passive update trace, so its precise triggering event is
not proven.

Deterministic tests reproduce the same durable state when the created target
emits ordinary title, favicon or load-completion updates during the final read
boundary. The fence now permits only those presentation/completion updates on
the known target while still re-reading its native/store identity. Every source
update, target navigation/loading/ownership mutation, malformed or unknown
update, activation, removal, replacement, bookmark, storage and pairing change
retains its existing fail-closed guard. No mutation is retried. This fixes the
reproduced defect; attributing the historical hosted failure to it remains an
inference until new exact-pair hosted evidence is reviewed.


## Reopened destination screenshot evidence

Hosted Arcify `7706e1aa5b75b6a1b90e424df5a1916f0112c6a0` with the same exact
Spotlight peer reached both genuine Enter/click reopen proofs, including exact
consumed receipts, active created native tabs and overlay retirement. The run
then failed its required after-shot on the now-background overlay source page;
its later replay/rejection checks did not complete. The harness now captures
the verified active reopened destination as described above and persists the
action proof before that required capture. The later exact-pair run below
verified both required destination captures; the earlier failed run is not an
acceptance pass.


## Cleanup activation ordering regression

Hosted Arcify `d0b70273a4eed9eabceb21533e9a1b99ea50bb02` with the same exact
Spotlight peer reached `archive-case-complete`, both required exact reopened
destination screenshots, cached replay, consumed-view rejection, uncertain-create
rejection, and stale selection/pairing rejection. The job then failed the strict
cleanup comparison with `true !== false`; it is not a passing Archive plan.

The cleanup restored original active tabs before its last settings UI operation.
That visible operation selects the Arcify options tab again, invalidating the
restored active flags. Executing the actual cleanup sequence against a native-API
mock reproduces the same failure when the original active control tab is the
Spotlight options tab. This ordering defect matches the hosted UI trace; that
failed report did not retain the original/final cleanup snapshots or name the
mismatching tab field, so the precise historical mismatch remains inferred.

Cleanup now restores the original active tab IDs after all settings UI, then
restores the original selected Spaces and focused window. Reapplying the original
selection after native activation preserves a selected Space that differs from
the active tab’s owner; early Space restoration before fixture deletion remains. All existing exact native-tab, Archive
record/claim and selected-Space cleanup assertions remain mandatory. Original
and final cleanup snapshots are persisted before those assertions, and cleanup
failures are appended without replacing completed action evidence or an earlier
acceptance failure. The correction awaits fresh exact-pair hosted verification.
