# Little Arc controller startup ordering

The diagnostic run for published head `e2560377e6335fe2e8e11dbf90c2c40a9c4be4ad`
returned the exact new controller with an empty URL, its expected marker in
`pendingUrl`, and status `loading`. Its own initial marker commit then emitted
`tabs.onUpdated` with URL and `loading` while the pre-web authority check was
awaited. The strict navigation fence correctly rejected that event, but it had
been armed before the controller's initial navigation was finished.

The startup fix gives only that exact returned controller a one-use readiness
phase, installed before the controller journal write. It waits at most five
seconds for a fresh exact-ID read with the expected committed marker, status
`complete`, no pending navigation, and the existing eligibility requirements.
Only an as-yet-uncommitted controller may receive its initial marker commit.
Once the receipt, a read or an event establishes commitment, later URL/loading
or pending-navigation events fail closed, even at the same marker: a delayed
initial notification cannot be distinguished safely from a reload. Only
completion and benign metadata may follow. Unexpected URLs, repeated navigation,
changes after completion, removal, replacement, detachment, window loss and
eligibility changes latch failure even if a later snapshot looks safe.

Reads are versioned against the initial marker commit and completion, so an old
snapshot returned after those events can only cause a second fresh read, never
become readiness authority. A read started after either transition cannot use a
later unrelated event to hide regression. Missing lifecycle observers fail
closed. A timeout is terminal, even if an outstanding read later completes.

The ordinary strict web fence is installed synchronously before startup
observation is removed. Existing fresh origin, window, controller and pairing
checks then run, including the final authority check before the fence assertion
and the sole web-tab dispatch. The shared controller predicate and strict fence,
recovery and promotion behavior are unchanged. No uncertain native operation is
retried; failure retains quarantine and never automatically closes a tab.

Existing opt-in diagnostics report `controller-initial-readiness` and
`controller-ready-strict-fence` stages, without storing URLs or tokens. Unit
regressions cover the initial-load race, adverse and away/back events, stale
reads, timeout/late resolution, permission revocation, journal failures, strict
handoff and restart non-replay. Source tests do not establish native browser
acceptance: the exact published fix must still pass the hosted sandboxed Chrome
job. No local Chrome run is part of this validation.
