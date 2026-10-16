# Hosted Spotlight recovery acceptance

`paired-chrome-overlay-recovery.mjs` is an import-safe fixture module. It does not
launch Chrome, change the workflow, dispatch internal command messages, grant
permissions, refresh the source, or weaken existing sandbox/network/pairing gates.
The caller must use the existing dedicated non-root GitHub Actions Chrome/Xvfb
fixture. Local tests use pure/injected fakes only; never run the native helper on
a user's desktop or this development environment.

## Native command transport

`probeNativeSpotlightCommandTarget` / `sendOneNativeSpotlightCommand` extend the
existing reviewed native-close transport with one fixed `Alt_L+t` chord. The
existing `probeNativeCloseTarget` / `sendOneNativeClose` API remains fixed to
`Control_L+w`. There is no caller-selected key/chord interface; probes cannot
cross-authorize either action. An attempted send consumes its opaque probe before
starting the helper, including timeouts and failed evidence. Never retry an input
whose outcome is uncertain.

Both actions keep the CI/non-root check, exact Chrome and Xvfb executable/PID/UID/
start-tick checks, exact display-lock check, one fresh 32-hex title nonce, exact
focused native window ancestry/title/PID, read-only probe, final focus recheck,
neutral physical/XKB key-state check, neutral-group key mapping, and best-effort
release of only the chord's owned keys. Alt must be the ordinary Mod1 key; `t`
must be a non-modifier. No shell keyboard utility, browser security setting,
modifier clearing, focus override, arbitrary key, or extra keydown is introduced.

This is **X11 XTEST native input in hosted Chrome**. It is not physical keyboard
hardware, CDP keypress proof of `activeTab`, or Helium desktop acceptance. The
transport explicitly cannot prove browser command dispatch by itself. The warm
recovery fixture observes the actual registered `toggleSpotlightNewTab` command,
checks `chrome.commands.getAll()` reports Alt+T, and verifies real browser results.

## Four mandatory subscenarios

`exerciseOverlayRecovery` records all four on the same nonce-bearing HTTP(S)
source document:

1. Dormant receiver: reload Spotlight for real, prove the old worker target and
   original options realm invalidated, prove there is no live current receiver,
   then invoke the native registered command once. Require one packaged isolated
   `overlay.js` injection and one document-targeted ensure-open, one modal/frame,
   one live main-frame receiver singleton, no helper/new tab, and exact source
   tab/window/URL/document time origin/host input identity/unsaved draft continuity.
   Every counterpart retains its URL, pending URL, group, order, pin, active state,
   and window; all native window identities and focus remain unchanged. The sole
   helper fallback may shift later indices only by its single observed insertion.
   Trusted typing of `w` must stay inside the iframe without invoking pre-existing
   host listeners. A direct trusted sidebar-command gesture must still produce
   native side-panel evidence.
2. Cold worker: close that overlay through trusted Escape, use the existing
   `terminateObservedWorker` helper, and prove the exact raw worker target is gone
   with no replacement. One native command then wakes a distinct real worker and
   reuses the same live page receiver. No pre-wake worker evaluation or internal
   command message substitutes for this wake. Reattach the existing network guard
   to the replacement; require unchanged source identity and no helper. Focus,
   snapshots, and the read-only native probe are prepared before stopping; only
   the final raw-target absence read occurs between stop and send. The native
   helper timestamps immediately before its first XTEST call and its `t` keydown
   call. An observed replacement creation before that command-key timestamp fails,
   including a wake during helper process startup/preflight. This is observed
   XTEST/target ordering, not physical input or a claim about unobserved browser
   scheduling. Failed sends retain their full uncertainty and cleanup evidence.
3. Marked orphan: type a draft and select part of it through trusted input, reload
   Spotlight, then invoke the native command once. Require exact text and selection
   retention, successful replacement before old-host retirement, and the same
   source/keyboard/tab/singleton invariants.
4. Unmarked legacy shape: remove only the ownership marker from a current-build
   orphan, reload, and invoke the native command once. Require a single helper in
   the original source window while the exact old host, iframe draft, selection,
   and source document survive. This reproduces the unmarked first-upgrade DOM
   shape; it does **not** claim an actual historical binary installation/update.

There are no optional skips or mutation retries. A failed/uncertain native send,
missing command, wrong source, policy denial, lost draft, unexpected new tab,
missing receiver, missing sidebar evidence, or missing lifecycle proof fails the
case. Only read-only readiness observations may poll.

## Mandatory hosted integration

Case 48 of the full runner invokes all four subscenarios. Case 49 then invokes
the separate initial Space-action fixture, before unchanged Favorite lifecycle
receipts and the final browser restart. All previous 47 full cases remain; the
full/lifecycle/native-split plans require exactly 49/5/4 passes. No skip, subset,
same-profile retry or window-B exemption satisfies the full report. The
[appearance/actions job](appearance-actions-paired-ci.md) requires 8 cases; the
[recovery/actions job](recovery-actions-paired-ci.md) requires exactly 0–2/48/49
on another fresh profile with passive Sidebar event observation initialized.
These supplemental outcomes do not replace any other job or establish a full pass.

The runner and all six workflow jobs pin the reviewed integrated Spotlight
commit `6379d3a22608507a4865bb44d17344ef8ea1eff6`. Hosted acceptance remains pending
for the final integrated Arcify commit; local oracle checks are not browser proof.

`runHostedOverlayRecovery` creates one nonce-bearing ordinary source through its
actual Chrome tab receipt and one fresh target, and retains separate recovery
checkpoints. It returns the complete real reload evidence, releases the exact
network debugger before the existing worker close helper, and performs no peer,
page, status or worker evaluation between close and the exercise's final raw
absence/read-and-send boundary. The replacement rejoins the unchanged HTTPS
network guard. The Sidebar adapter uses real Enter on the recovered iframe and
captures the existing native-panel proof without a helper launch. It closes the
panel, retains the same overlay, and returns focus to its input.

Cleanup removes only the exact owned source ID and the unique newly observed
Spotlight helper ID in that source window, including after failure. It leaves
replacement options realms from real reloads intact for the next case.

## Integration contract

The integrated orchestrator calls `overlayRecoveryFixtureResponse(requestUrl)`
in its local HTTP server and return its `body`, `type`, and `csp` unchanged. A null
return means the route is unrelated. Create one source tab at
`/overlay-recovery-host?nonce=<fresh 32-hex nonce>` in the known test window, obtain
its actual settled native tab identity, and resolve its actual browser Page.

Pass these existing fixture adapters to `exerciseOverlayRecovery`:

- `browser`, `page`, `sourceTab`, `arcifyOptions`, and exact `spotlightId`
- `reloadSpotlight()`: run the existing complete Spotlight reload helper and
  return its `evidence`, retaining raw targets, original view invalidation,
  installed-registry checks, new worker identity, and all network safeguards
- `stopSpotlightWorker()`: run `terminateObservedWorker` with the exact worker,
  existing network observer release, and raw target reader; return
  `{ observations }` containing its full phase records
- `observeReplacementWorker(target)`: attach/reuse the existing exact-target
  network/security observer, with no relaxed routes or new host allowances
- `verifySidebar({ page, surface, sourceTab })`: select the sidebar command with
  real trusted input, perform its direct gesture, verify actual native panel
  context/window/open event/rendering, and close the panel while leaving the
  Spotlight overlay available. Return the complete native panel evidence.
- Existing `ui`, bounded read-only `poll`, `record`, and `screenshot` helpers

The orchestrator owns fixture creation and eventual cleanup. After legacy
fallback it must remove the returned helper and source tab using their exact
verified IDs, including on failure. No source refresh or receiver injection is a
setup/cleanup substitute. The cold-worker export is also available independently,
but the main exercise invokes it mandatorily as part of the four-subscenario case.

## Evidence and limitations

Warm cases install narrowly scoped, explicitly labeled passive taps in the real
Spotlight worker for `scripting.executeScript`, `tabs.sendMessage`, and
`tabs.create`. Each original method receives the same `this` and argument objects
exactly once, and its exact original promise is returned. Taps observe fulfilled
or rejected values without replacing results, injecting success, invoking
commands, suppressing failure, or replaying mutations. A separate passive
`commands.onCommand` listener records the real browser event. Originals/listener
are restored after every case. Cold wake uses no pre-wake tap.

Receiver evidence reads existing CDP main-frame isolated contexts without creating
an isolated world or injecting a content script for evidence. It verifies one live
same-extension receiver singleton; it is not a general enumeration of all Chrome
listeners. Runtime singleton/idempotency regressions establish listener ownership.

Restricted-page and uncertain-delivery behavior is covered by the Spotlight
production-module unit suite and local fixture-oracle tests; no hosted site-policy
bypass or simulated successful privileged injection is attempted. Oracle tests
alone are not real-browser evidence. Native command/reload acceptance is not
claimed until the integrated hosted workflow actually passes this case for the
pinned reviewed companion build. Current target runtime is the reviewed recovery
candidate plus its consumed-on-window-focus-loss follow-up.

Run focused pure tests with:

    node --test tests/unit/paired-chrome-native-close.test.js tests/unit/paired-chrome-overlay-recovery.test.js tests/unit/paired-chrome-spotlight-wiring.test.js

The native-close Node suite runs its Python injected fake-library tests. It never
opens X, inspects a real process, or sends native input in local testing.
