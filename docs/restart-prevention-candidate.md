# Combined Today restart-prevention candidate

Base: `e335800523cf7021ea2d3e6b6d4e957dffc015c3`.
Local branch: `fix/durable-explicit-subset`.

## Reproduction and cause

A synthetic window has seven explicitly chosen Today rows and unrelated context.
The old ordinary Move path sets `allowFreshExplicit`, but not `provenContextOnly`.
It saves seven placements with fourteen required signature slots. At a new browser
session epoch, an additional unrelated `chrome://extensions/` slot makes the
complete ordered embedding ambiguous. The unchanged strict matcher correctly
refuses the entire cohort, and newer-choice edges prevent replaying older conflicts.

The final normal and inverted reproduction tests were copied into an isolated
source snapshot of the base commit. Both failed with zero of the seven expected
IDs in the destination after restart. On this candidate both pass after a worker
reload and through repeated fresh epochs, preserving canonical order and every
historical recovery record. All data is synthetic; no user profile, storage dump,
raw backup or live browser state was read.

## Combined implementation

1. Future explicit capture uses prior proven placement IDs plus exact validated
   Move IDs or actually observed creation IDs. Internal intent IDs survive the
   persistence retry path and are never accepted from a runtime request field.
   Replay-only witnesses cannot expand the same or another window's scope.
2. Pure authenticated replay preserves existing explicit/subset placement scope.
   A pending baseline can supply retained scope only with complete same-epoch
   native-ID ownership proof. Unresolved newer choices, unproven overrides and
   expired binding proof do not authorize a successor. Genuine new intent can
   retain exact current overrides only within its retained/intended scope.
3. `prepareProvenContextRepair` can append a selected-only representation during
   ordinary persistence when the committed checkpoint and all current placement
   witnesses agree. It preserves membership/order, predecessor signatures,
   unrelated cohorts and pending history, and adds only predecessor edges. It
   neither moves tabs nor issues new ownership witnesses.
4. Fresh and repair final fences check native state, actual current epochs, exact
   witness/incarnation/transaction identity, destination/root/order and metadata.
   Repair additionally validates the entire committed checkpoint and observes
   relevant events across awaited reads. Full readback confirms the repair commit.
5. Complete-ledger validation prevents over-capacity or revision-overflow writes.
   No matcher, ledger schema, unique-embedding requirement or fallback operating
   mode was weakened. There is no URL-based identity migration or partial restore.

## Activation boundary

The combined candidate includes an actual no-move current-data repair, rather than
requiring Move-away/Move-back or clearing session storage. Ordinary same-session
persistence or warm initialization can perform it only with complete, stable proof.
If another live change first requires a normal checkpoint, a subsequent stable
checkpoint can qualify. No installation or live activation has been performed.

A cold restart that has already lost exact current-incarnation proof cannot use
this repair. Already ambiguous chosen URLs, competing windows/cohorts, missing
chosen slots, invalid roots or newer unresolved choices still defer restoration.
Installation alone does not establish that any particular live record qualifies.

Authenticated replay may certify Extensions for current membership, but it cannot
widen an existing durable subset. Later genuine Moves or creations add only their
exact IDs. Tests require the repaired seven-slot layout to survive two later
replays and a duplicate-context cold restart without moving or reordering tabs.

## Focused verification

`node --test tests/unit/fresh-explicit-layout.test.js tests/unit/proven-context-repair.test.js tests/unit/durable-today-layout.test.js tests/unit/current-layout-authority.test.js tests/unit/explicit-today-move.test.js tests/unit/current-layout-projection.test.js tests/unit/durable-layout-diagnostics.test.js`

Result at combined candidate freeze: **340 passed, 0 failed**.
`git diff --check` passed. The fresh-capture suite has 55 tests; the integrated
repair suite has 88. Generated logs are under ignored `test-results/`.

Coverage includes normal/inverted ordering and repeated epochs; complete
predecessor/history preservation; pure replay scope retention; real Move/creation
after replay; two-window intent isolation; unplaced in-binding anchor Moves;
pending seven plus one-tab Move; duplicate/missing/reordered chosen slots; multiple
matching windows; pinned/Favorite/Split/private/navigation/root exclusions;
metadata and ownership races; actual and secondary epoch expiry; incarnation and
transaction replacement; canonical order changes; newer blockers; unresolved
overrides; cohort/revision bounds; complete committed proof; late event
invalidation/listener cleanup; interruption and readback failure; warm no-move
activation; and combined repair/replay/restart behavior.

Existing precedence tests that previously changed an unrelated context URL now
change a genuinely chosen slot to isolate the same guard. Identical chosen subsets
in distinct surrounding context remain ambiguous. A separate positive test still
restores older placements when genuinely different proven chosen slots distinguish
the windows.

The parent task performs the complete unit suite, build and isolated headless
source-browser checks. Those results are separate from this focused run; this
report does not claim packaged Helium, live user state, deployment or manual UI
acceptance. The partial-review prototype is not part of this candidate.

## Final combined local verification (2026-11-09)

- Full unit suite: `node --test --test-concurrency=4 tests/unit/*.test.js`: **9,220 passed, 4 skipped, 0 failed**.
- Production build: `npm run build`: passed. No installation or reload.
- Independent combined source review: 318 focused tests passed; no open source safety findings.
- Headless source-module restart: `ARCIFY_LAYOUT_FIXTURE_CASE=proven-context-repair`, using installed Edge 156 in a newly created temporary profile: passed.

The native fixture makes a real seven-tab choice, models the older full-window
explicit checkpoint while retaining its genuine committed ownership/rank proof,
then performs ordinary persistence without moving tabs. Its first ordinary
checkpoint legitimately expands the stable live prefix from 8 to 12 records, so
repair correctly defers. A subsequent stable checkpoint appends the seven-slot
successor. Assertions confirm unchanged membership, ordering, native IDs/URLs,
and historical records during repair.

After a full test-browser restart with duplicate unrelated context, all seven
return to their destination in order. Both old checkpoints remain pending history;
only the terminal explicit successor must be resolved. All three test browser
processes exited successfully. No signed-in browser, user profile, live storage,
or Computer Use session was accessed for these tests.

This is source-module/native-browser integration plus unit/build validation, not
packaged Helium acceptance. No remote checks, publication, merge, installation,
or real-profile activation have occurred. The user's live checkpoint must still
qualify under the unchanged proof guards before a real restart can be called
verified.
