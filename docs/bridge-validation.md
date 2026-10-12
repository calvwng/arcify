# Bridge validation record

## Unchanged baselines (2026-10-11)

- Arcify `f714c449e1d88236de9bb45de2259abe5bf5be81`: install/build passed;
  **96/96 unit tests passed**. Existing Vite warning: `onboarding-script.js` in
  `onboarding.html` has no `type="module"`; not changed by this integration.
- Spotlight `137ea1bbe503ec00e08da7d81b462e0ed87a82d1`: install/build passed;
  **689 tests passed, 7 failed** across two integration files. These unchanged
  tests raced the unmocked remote autocomplete timeout at 3000 ms. An external
  test-only fetch stub made all 35 tests in the two affected files pass. No
  production autocomplete behavior was changed to hide the baseline failure.
- Confirmed existing Arcify event-order defect: if a pin-change persistence pass
  overlaps a different tab's `onReplaced` event, pruning can remove the old ID before
  the replacement handler transfers ownership. The same reproduction fails against
  the unchanged baseline `space-store.js`. It is retained as an explicitly skipped
  regression, not fixed or counted as a passing bridge case in this PR.
- Node v24.19.0 / npm 11.9.0, Linux cloud VM. Initial install needed a writable npm
  cache (`--cache /tmp/npm-arcify-cache`); this was an environment setup issue.

## Interactive cloud-browser blocker

The supported cloud Chromium browser was inspected. Opening the required
`chrome://extensions/` page was rejected with:

> Browser Use rejected this action due to browser security policy. Reason: The
> browser URL policy blocks this action. Cloud browser cannot visit the requested
> page. The requested URL protocol is not allowed. Allowed protocols: "http:",
> "https:".

The restriction was not bypassed with another automation technology or native
route. **Neither baseline nor integrated unpacked extensions were loaded through this
interactive browser.** The independently provisioned CI results below are separate. The same restriction
prevents extension reload/worker-stop inspection through that route. Automated
mocked checks do not substitute for this missing evidence.

On 2026-10-12 the user reported enabling Developer mode. Selecting the existing,
user-opened Extensions tab still received the same browser-tool URL denial. The
user then reported that manual **Load unpacked** was blocked by browser policy.
No policy, browser flags, alternate local browser, or profile was used to bypass
either restriction.

## Independently provisioned paired CI

The dedicated `Paired extension smoke` workflow uses an independent GitHub-hosted
runner, not the managed interactive cloud browser above. It builds the exact
Arcify PR head and the pinned Spotlight companion revision, then runs
`npm run test:paired-chrome`. The workflow and its generated JSON evidence record
the actual source revisions, Chrome version, extension IDs, and tested cases.
The peer pin must be updated deliberately when a paired source change is tested.

The fixture uses Puppeteer's supported unpacked-extension API in an isolated
temporary profile with the browser sandbox and web security intact. It does not
reuse the legacy E2E helper's security-disabling flags. A sandbox or extension
installation-policy failure is a failed/blocked run, never a passing skip or a
reason to relax protections. Do not run this fixture to evade an environment's
extension policy.

The first independent run stopped before extension loading with `No usable
sandbox!` on Ubuntu. Five later existing-setuid-helper attempts stopped before
launch because the runner's `/opt` hierarchy and helper are writable mode 0777,
and the helper lacks setuid. This matches the
[runner image's `/opt` provisioning](https://github.com/actions/runner-images/blob/ubuntu24/20261004.327/images/ubuntu/scripts/build/configure-system.sh#L9-L13).
Those failures exercised no paired behavior; the privileged-helper validator was
not loosened and no helper permissions were repaired.

The approved repair uses Puppeteer's `channel: 'chrome'` with the Ubuntu 24.04
image's **already installed Google Chrome stable**. Chromium documents an existing
Ubuntu AppArmor allowance for that installed browser. `CHROME_DEVEL_SANDBOX` and
executable-path overrides are rejected. Nothing installs or modifies a helper,
changes permissions, edits AppArmor, or changes sysctl settings. The workflow keeps
its automatic PR trigger, read-only contents permission and exact companion pin.

Before launch the fixture records the fixed executable/metadata, installed package
ownership/version/checksum and existing AppArmor profile. Writable `/opt` metadata
is disclosed rather than treated as suitable for a privileged helper: this route
runs an ordinary unprivileged browser and requires its namespace sandbox. Package
checksums establish consistency with the runner installation, not independent
remote signature verification. After launch it checks the actual executable,
package/runtime version agreement, arguments and available process/profile evidence.
Before installing either extension, real `chrome://sandbox` diagnostics must report
**Namespace**, PID namespaces, network namespaces, seccomp-BPF and an adequate
sandbox. SUID-only, missing/unknown/negative or ambiguous evidence fails closed.
Raw diagnostics and screenshots are preserved on failure. No disabled-sandbox or
web-security fallback is allowed.

The installed stable browser version comes from the runner image rather than a
Puppeteer-downloaded Chrome for Testing pin. Each report records image identifiers,
actual browser and Puppeteer versions, both source revisions, and runtime evidence.
The paired job has its own locked Puppeteer Core **25.12.0** under
`scripts/paired-chrome-runtime`, requiring Node >=22.12. It is installed only by
this job; Arcify's root dependencies and legacy Node 20/22 tests remain unchanged.
This version targets Chrome 154 in Puppeteer's supported-browser mapping. Actual
compatibility and extension installation still require a successful run; matching
versions alone are not acceptance evidence. A failure remains a failed run.

See [Chromium's AppArmor guidance](https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md),
[Puppeteer's installed-channel option](https://pptr.dev/api/puppeteer.launchoptions)
and [runtime extension installation](https://pptr.dev/guides/chrome-extensions).
The first namespace run established actual sandboxed startup and both extension
identities with Chrome **154.0.8037.97** / Puppeteer **24.37.1**. Subsequent runs
found and corrected fixture input/focus, capture scheduling and debugger-observer
lifecycle issues without changing extension runtime code or security guards.

[Run 38245774262](https://github.com/calvwng/arcify/actions/runs/38245774262), Arcify
`245e0c675e90c3669f50d3511661d6e5322c1fcf` with Spotlight
`63288bebc3c6e01fbc481c8ccb360a06bbf7bec0`, recorded **12 passed, 1 failed,
1 not run, 0 skipped**, with 29 screenshots. Actual passes cover reciprocal
pairing in both orders, multiwindow snapshots/isolation, live-tab overlay selection,
rendered sidebar selection, distinct equal-URL saved pins/titles/reuse, current-tab
URL navigation, empty-space/new-tab/helper flows, group sync off/on, malformed and
unauthorized requests, and genuine worker termination plus duplicate-request
journal replay. Reload destroyed the original view and worker but then waited for
a replacement before sending a normal wake event. The fixture now reconnects via
fresh settings and a real companion Check/Refresh request before requiring that
replacement. Reload and final command checks have not yet passed as a full run.

[Run 38247184764](https://github.com/calvwng/arcify/actions/runs/38247184764) at
`b172596e825ed65df7d3eef0aac962e8b1a59cad` failed earlier: the initial worker
identity evaluation timed out, with Crashpad diagnostics but no recorded target
crash event. It has **0 passed, 1 failed, 13 not run, 0 skipped**. The native
crash/hung-target cause is unconfirmed. The new isolated driver includes
[Puppeteer's worker-script readiness fix](https://github.com/puppeteer/puppeteer/pull/15099),
which waits for script execution before evaluation. This addresses a known timing
hazard, not a proven fix for the native crash. Each identity evaluation also has a
30-second deadline if script readiness never settles. Raw target lifecycle/crash
and existing debugger-session events are now retained; a recorded crash fails the
check. There is no mutation retry or alternate execution context.

Intentional real Puppeteer input is foregrounded and visibility-checked; exact
input focus precedes actual key events. Required screenshots remain fatal.
Background sidebar assertions/captures do not activate the sidebar. Only optional
failure-cleanup captures omit hidden/closed pages, recording their state/reason
without changing focus or replacing the original error. These harness changes
still need a complete actual paired run. Browser-free driver tests check the
isolated version and reject environment-derived sandbox disabling.

Worker termination follows [Chrome's documented Puppeteer method](https://developer.chrome.com/docs/extensions/how-to/test/test-serviceworker-termination-with-puppeteer):
release the fixture's worker Network observer, then call `WebWorker.close()`.
Debugger sessions can keep workers alive, so a resolved stop command alone is
not proof of termination. The fixture requires the exact old worker target ID to
disappear from Chrome's raw `Target.getTargets` list and a distinct exact-URL worker
with the correct runtime identity after wake. Replaying the same bridge request
must return the original tab without creating a duplicate. This case is mandatory;
it no longer relies on an optional ServiceWorker-domain capability or a skip.
The separate extension-reload case detaches its worker observers without stopping
the worker, verifies the original raw worker/view are still present, invokes the
real `chrome.runtime.reload()`, and requires original options-context invalidation
plus destruction of the original raw worker target. Fresh settings and a normal
companion request wake the reloaded extension; a distinct worker with exact
runtime identity, connected status, ordered space IDs and the two selected tab
memberships are mandatory. This does not verify every saved-pin binding, and a
worker restart alone cannot pass the reload case.

The job uploads machine-readable results and screenshots, including successful
checkpoints. Read the exact-head run and artifacts linked in the paired PRs for
actual outcomes; adding a fixture does not itself establish a pass. Real Chrome
API setup/inspection, cross-extension message assertions, and visible UI actions
are identified separately. Existing mocked bridge tests remain a separate layer.

CI under a virtual display is not manual acceptance: a `sidebar.html` tab is not Chrome's native
side panel. Command registration is not an OS-level shortcut invocation. Native
side-panel docking/focus, browser-chrome shortcuts, ordinary session restoration,
and any matrix case absent from the generated results remain pending below.

## User-reported local pairing check (2026-10-12)

The user loaded the manual builds in their own Helium browser on Windows (Arcify
`2ef8f9d7a38daf73870b4e0c49321d52da7d4a68`, Spotlight
`05dca262001e09f420efeb2bcd3a86a32a4480f5`). The initial Spotlight screenshot showed
Arcify's `UNAUTHORIZED` response because reciprocal setup was incomplete. The user
reported that saving the Spotlight ID in Arcify, then saving Arcify's ID in
Spotlight, connected successfully. This is a user-reported handshake result, not
an automated paired acceptance run or verification of the full matrix below.

The follow-up improves both settings pages: either side can save first, pending
reciprocal approval is distinct from transport errors, and saved IDs are shown
separately from unsaved edits. No sender validation or explicit two-sided trust
requirement is relaxed. The pinned-row glyph/accessible-label correction retains
existing close-versus-delete handlers. New tests cover these states with mocked
Chrome/DOM APIs; browser interaction for the updated UI remains pending.

## Four-finding regression follow-up

The follow-up regression suite imports the actual sidebar/coordinator, overlay,
bridge client/action router and server modules. DOM implementations and Chrome
APIs are substituted in these tests; they are not paired-browser evidence.
Coverage includes empty/nonempty active-view changes in either event order,
overlapping reads/renders and busy editors/drags; a current-tab search timeout
that leaves the original page intact; repeated launch, pending close teardown and
lost worker tracking; and exact saved-pin title/binding initialization before
membership is published. The wire protocol remains v1.

The paired fixture now also waits for the rendered sidebar's visible space and
selected space chip after Spotlight actions, and verifies saved bookmark titles
after the opened pages load with different document titles. These assertions do
not establish a browser pass until the guarded job actually reaches them.

## Manual acceptance matrix

This is the full acceptance checklist, not a list of CI passes. Consult generated
CI results for the subset exercised automatically; remaining interactive cases
still require a browser where extension installation is permitted.

Use a test profile, both paired builds, two normal windows, at least two spaces
including an empty one, and equal-URL bookmarks in different spaces. Record Chrome
version, extension IDs, both commits, sync setting, screenshots, and actual results.
Repeat relevant cases with Chrome group sync **off** and **on**.

1. Standalone Spotlight: history/bookmarks/top sites/default-engine search,
   suggestions, autocomplete, overlay and new-tab page retain upstream behavior.
2. Pair IDs in both settings. Check clear connected status; test typo/self-ID,
   missing/disabled companion, unpairing, protocol mismatch, and reconnection.
3. Search/select a live tab in another space; assert exactly one existing tab is
   activated, Arcify selects its owner in both logical state and the visible
   sidebar/space chip, and the other window is unchanged.
4. Search/select each of two same-URL bookmarks in different spaces and nested
   folders. Confirm correct bookmark identity, no duplicate live pin after repeated
   selection, and no collision with an ordinary same-URL tab.
   Reopened pins must retain their saved custom row titles after the page loads.
5. Switch to an empty space through Spotlight. It stays empty and selected. Open
   a URL/default-engine search/new tab; it belongs to that selected space only.
6. Open current-tab and new-tab overlays using Alt+L and Alt+T (or configured
   shortcuts). Check focus, keyboard selection, Enter/Escape, close/cancel, repeated
   clicks, and updated results while a slower prior search is still outstanding.
7. Launch from **Search with Spotlight** in each Arcify sidebar. Confirm window
   targeting/focus, repeated launches keep the overlay open, and reopening during
   close animation or after worker restart stays visible. Normal shortcuts still
   toggle. Confirm the original New Tab button still works.
8. Open new tabs from each window while editing/sidebar refresh is pending;
   confirm membership/order and that stale snapshots never erase newer tabs.
9. Reload either extension; refresh existing content-script pages; suspend/stop
   workers; re-open search. Verify fresh handshake/snapshot and unchanged membership.
10. Fully restart Chrome with session restore on, then without restored tabs;
    verify stable spaces/empty spaces and correct per-window restoration within
    Arcify's existing documented duplicate-URL restoration limitations.
11. From a separate, unpaired test extension, send valid-looking and malformed
    requests, wrong versions, unsupported commands, forged window/tab IDs, and
    repeated request IDs. Verify rejection/no state mutation; do not expose a
    website message gateway for this test.
12. Induce a response timeout after an action. Verify visible error, no automatic
    retry/native fallback, fresh state on next search, and no duplicate action when
    the same request ID is delivered again within the same browser session.
    For a current-tab text search, timeout during its fresh snapshot check must
    preserve the original page without navigating it to an intermediate blank URL.

Final automated counts and paired draft PR links are recorded in the PR descriptions.
