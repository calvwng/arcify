# Supplemental fresh-profile Move and drag acceptance

The independent `move-drag` GitHub Actions job sets
`ARCIFY_PAIRED_RUN_MODE=move-drag`. It requires exactly **0, 1, 2, 38**, once in
that order, in a new disposable profile:

- **0–2:** installed Chrome with normal namespace/PID/network/seccomp sandbox
  evidence, exact paired extension identities, real options-UI pairing, a real
  localhost fixture server and independent native windows with a window-B baseline.
- **38:** the existing tab-menu fixture, then the existing native Move to New
  Window fixture, including sticky New Tab drag acceptance. Both must finish.
  A menu failure still fails case 38; isolation never skips its prerequisite.

There is only one case-38 definition, shared with the unchanged 49-case full
plan. The supplemental mode does not depend on earlier appearance, recovery,
Space-menu, Little Arc or other full-suite results. The tab-menu fixture owns
its nonce-bearing pages, saved folder/pins, helper tabs and outside-focus window.
The native Move fixture owns a separate disposable source window and opens its
genuine Side Panel through trusted Spotlight input. Its own `onOpened` observer,
SIDE_PANEL context, native renderer and render-readiness checks require no prior
Sidebar case or ordinary sidebar-tab substitute.

Fresh-profile Today ordering is a real dependency, not a seeded test override:
the options page opened in case 0 initializes the representation before restoring
settings. Case 2 also awaits `spaceStore/get`; production store initialization
awaits `readTodayPlacement()` and `getTodayOrderInverted()`, which persists version
1 before returning. Case 38 retains its existing version/type assertion. Cases
0–2 supply pairing, the nonce page route, source/control windows, active Spaces
and bookmark roots; each acceptance fixture creates the remaining data it owns.

Coverage includes genuine tab-menu editing/copy/mute/duplicate/removal;
normal and stuck New Tab placement in light/dark appearance; drag preview,
leave/reentry, repeated supported cancellation, successful native drops and
stale-tab rejection; and menu moves for Today, saved pins, Favorites and a
last-tab source window. Existing exact-tab/document-state, logical membership,
bookmark/Favorite identity, cleanup, native-host and screenshot assertions remain
mandatory. Physical Escape/hardware input and Helium remain manual.

The new job is independent, with no `needs`, retries, failure exemption, secret,
permission change or browser update. It retains the legacy companion pin
`c13511fd36d56358156c10336b8961b7ef95d5bc`, isolated driver, locked dependencies and
production builds. Arcify checks out and verifies the actual PR head, not its
synthetic merge; manual legacy dispatch tests its actual dispatched commit.
Read-only permissions and `persist-credentials: false` remain unchanged.

Existing jobs, pins and case ordering are preserved. In particular, the
Little Arc-only manual route remains Little Arc-only; `move-drag` runs alongside
the existing suite on matching PR events or a legacy manual dispatch. It is not
a new manual dispatch option. A passing supplemental result cannot override any
failed full, Little Arc or other acceptance result.

Evidence is separate: `test-results/paired-chrome-move-drag/report.json`, runner
logs and screenshots are uploaded on success or failure as
`paired-chrome-move-drag-<run>-<attempt>`. The report explicitly labels this scope
as supplemental, not Little Arc, browser-restart or full-suite acceptance.
Missing, duplicate, reordered, skipped, failed or incomplete cases fail the run.

Unit tests execute real source orchestration with inert adapters, including
every selected-case failure, callback/recording failures, all excluded modes,
fresh observer registration and the production Today-initialization dependency.
They preserve the existing callback and workflow byte receipts. These tests and
syntax/build checks do not launch Chrome and are not native acceptance.
The exact integrated commit still requires its GitHub-hosted browser result.
