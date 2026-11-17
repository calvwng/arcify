# Possible restored match: attach picker

Base: `f1e77e792069cf160e3ed2cb0eb2197aa703a210`.
This backend adds an optional `candidate.possibleRestoredMatch === true` on at
most one EXISTING Attach open Split View candidate. The matching UI must label
it **Possible restored match**, explain that the same split ID is only a hint,
and require explicit selection/confirmation. Never preselect, even for one option.
The picker shows a text label beside that candidate and an accessible explanation.

## Useful flow

After a verified native split is pinned (the existing strong witness `remember`
path), or after a confirmed manual focus-only attach, an independent ancillary
queue remembers its numeric split ID. After session state is lost and native tabs
restore, opening the existing picker in the correct active Space/window can
annotate the matching currently eligible candidate. The user chooses it manually.
There is no additional window-confirmation prompt: explicitly opening this picker
in its already validated active Space/window supplies the scope for this hint.

The persisted scope is the exact bookmark ID, Space ID, root folder ID and recipe
ID. No URL/title/position comparison establishes historical identity. Neither a
newly created same-URL pair nor the first enumerated pair is preferred. Candidate
order and original opaque chooser tokens remain unchanged.

## Data, lifetime and failures

`splitPinRestoredHintsV1` in local storage holds at most 64 records, expiring after
30 days. Record fields are exactly scope IDs, split ID, save timestamp and a
random session nonce. No pane IDs, native window IDs, titles, URLs or page contents
are persisted or retained in queued writes. The existing session receipts and
all ownership fields remain unchanged.

A separate session nonce suppresses hints for same-session receipt loss and
worker suspension. Browser restart and extension operations that clear session
storage are not distinguished; hence **possible**, never proof. Old builds have
no remembered hint; no historical data is guessed or backfilled.

The primary pin/attach/unlink result never awaits optional hint I/O. Missing,
malformed or failed auxiliary storage only removes the hint. While an optional
write is pending the picker skips hints rather than waiting. Queued writes are
best effort and may be lost on worker/browser shutdown. Their failure must never
trigger a retry of native activation or a fresh split.

Explicit unlink synchronously suppresses that scope in memory, then independently
queues session suppression and local deletion. These optional failures cannot
fail unlink. If BOTH persistent cleanup/suppression fail and the worker is later
replaced, an old non-authoritative hint could reappear; this is a documented I/O
limitation, not identity or action permission. Memory/session suppression is
bounded; overflow withholds all hints for that lifetime.

## Conservative matching

Require a complete all-window `tabs.query({})` result with valid tab/window IDs
and a well-formed split ID on every row (-1 unpaired; nonnegative safe integer
paired). The remembered numeric split ID must occur on exactly two eligible
current panes in the requested window, with native adjacent/group shape. Any
extra member, same hash in another window, malformed inventory, pending/loading/
unloaded/private/pinned/discarded/frozen pane withholds the annotation.

Existing focus or strong claims for the target pin anywhere, overlapping claims,
malformed claims, another remembered pin using the hash, changed Space/root/
recipe, expired hints, or ambiguity also withhold it. Original chooser guard is
run again for the suggested token after the extra reads. Native lifecycle fences
and capability expiration are checked again before returning candidates.

Chromium may preserve a split ID when panes are replaced, and numeric IDs can
collide/replay. A replacement pair can therefore get the same **possible** label.
This intentionally DOES NOT prove original panes. The explicit regression changes
both native tab IDs and their pages while retaining the split ID. The user still
must select the pair, and the original attach handler revalidates every guard.

No changes to focus, close, release, move, hiding/Today suppression or strong
witness authority. No automatic association, extra browser permission, browser
profile change, EVOO operation, PR update or remote publication is included.

## Local validation

`node --test tests/unit/split-pin-focus-link.test.js`

Tests use mocked Chrome APIs, not real browser execution. They cover strong and
explicit attach recording, simulated cold receipt loss/changed tab IDs, no default
or reorder, global collisions, same-ID replacements, overlap and malformed state,
late native/claim changes, slow storage and token expiry, unlink failures, and
unchanged authoritative behavior. Native restart and combined picker UI validation
must be reported separately; this backend alone does not certify either.
