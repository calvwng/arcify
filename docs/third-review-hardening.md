# Third paired review corrections

The review started from Arcify `e02fb15f45847e9061b160cd334404df5943b1d5`
and Spotlight `b8b193c1f803179f86ab2e2397e5f1169256f49d`. Three findings
were reproduced independently with production methods and simulated Chrome APIs.
These corrections are Arcify-only; the companion source and exact pairing pins
remain unchanged.

## Saved-pin removal

Dragging a live saved pin to Today used a different removal helper from the
recently hardened menu/paired Remove Pin action. Its awaited native Split check
could permit deletion of a bookmark that had just moved outside its Space.
Both helpers now share bookmark-change observation. The legacy path also observes
its exact binding through awaited reads, and its live caller validates captured
Space identity, folder, membership, window, native pin/private state and Split.
Own successful deletion ends observation before post-delete bookkeeping; uncertain
deletion and partial live-tab updates are reported without replay or recreation.

The caller audit covered drag, quick-pin and closed saved-row removal, plus the
authoritative menu/paired action. Regressions execute the production sidebar
caller, including target and ancestor movement, move-away-and-back, missing
folders, changed ownership/binding/window/Split, successful deletion, partial
outcomes and listener cleanup. This closes an added awaited-read gap without
claiming browser bookmark operations are atomic.

## Pending destinations during archive and cleanup

Automatic archive retained an older defect: a committed URL could mask a different
pending destination. The shared manual/automatic archive core now checks pending
navigation independently before writing and before closing. Automatic saved-URL
protection examines both URL fields. Same-destination pending navigation remains
valid. If navigation changes after the archive record was committed, the live tab
stays open and the saved record is retained; rejected retries do not duplicate it.

Related-caller review found the same masking pattern in tutorial practice cleanup.
It now checks pending destinations and rereads each exact candidate before removal,
preserving tabs changed while an earlier candidate was closed. Archive reopen,
selected Close and startup cleanup already have separate pending-URL checks.
Native changes after the final read remain a non-atomic API boundary.

## Narrow private-session containment

The preexisting Space pipeline could admit private tabs and persist their URLs in
normal local snapshots, retaining them after private-window closure and restart.
Private tabs now stay out of ordinary Space admission, persistence, window-layout
capture and restoration. Ephemeral private identity observations prevent private
close events from becoming restore records. Auxiliary activity, search projection,
bookmark hydration and metadata-write boundaries receive matching exclusions.

Synthetic tests exercise actual store methods, private events, pinned private
tabs, private-window closure, worker/browser restart, and ordinary-session controls.
No actual private browser content is read and no incognito permission is changed.
The full private-session UX redesign remains deferred.

Older records did not retain private provenance. This patch does **not** guess
which historical URLs or recycled native IDs were private, erase ambiguous saved
data, or claim that previously persisted private history has been cleaned up.
New writes are contained; historical cleanup requires separately established
provenance or an explicit user-directed policy.

## Verification boundaries

Final local validation passed 8,372 Arcify unit tests with four existing skips and
zero failures on Node 25.2.1, using Python 3.11.9 for the pure Python helpers.
Production build and ZIP packaging passed. The unchanged Spotlight companion
passed 2,603 tests in 88 files with coverage and its production build. The real
client/provider/store smoke with simulated APIs and all 71 strict paired-contract
regressions passed. Focused runs overlap the full suite and are not added to it.

Initial integration runs exposed fixture setup gaps: native bookmark event APIs
were missing in two sidebar fixtures, and the independent metadata-writer fixture
had no native tabs. Those fixtures now model the required API capabilities with
their original assertions intact. A stale Python launcher path was replaced with
the installed interpreter for execution only. No production fence or assertion
was weakened to obtain green results.

Independent review inspected the shared removal fence, archive and practice
cleanup, private persistence and metadata guard ordering. It caught a new native
privacy read placed after a caller's final ownership guard; that read was moved
before the guard, preserving the existing final validation boundary.

Local reproductions and unit tests use simulated browser APIs. Builds, packaging
and client/provider/store contract checks are separate from native acceptance.
Exact published-head CI must qualify the final pair. No installed extension,
normal checkout, browser profile, user setting or upstream repository is changed.
Both PRs remain draft and unmerged. Native Ctrl+W and the intact-controller orphan
recovery scenarios in `little-arc-reload-boundary.md` remain outside this work.
