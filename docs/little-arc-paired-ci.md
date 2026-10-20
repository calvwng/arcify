# Little Arc paired-browser acceptance candidate

Status: the reviewed runtime candidate, companion, and bounded PR acceptance route are published. The first Little Arc job passed exact-source/event checks and both production builds, then stopped at the post-build dependency-provenance check before Chrome launched. No native run has been performed for Little Arc. No workflow has been dispatched manually. A narrowly scoped test-only provenance correction is prepared locally; publication and build success do not establish native acceptance or authorize deployment.

## Isolated scope

`scripts/paired-chrome-little-arc.mjs` supplies an import-safe fixture server, evidence validators, and one real-browser scenario. `scripts/paired-chrome-smoke.mjs` registers it as stable case 55 in the supplemental `little-arc` run mode. That mode selects setup cases 0, 1, and 2, followed by case 55. Existing `full`, Favorite lifecycle, native Split, appearance, recovery, extended-action, and Archive plans retain their original cases and order.

The scenario is intended to establish:

- A trusted Spotlight action opens one compact normal window with an exact controller and a separate live top-level HTTP(S) page.
- The transient page and its controller are absent from Space/Favorite ownership and ordinary snapshots before explicit promotion.
- A separate, trusted controller choice moves the same native page into the selected Space's Today section while retaining its original document nonce and typed form value.
- A genuinely observed extension reload clears session authority. The intact controller proves only its own window; the controller requires an explicit live-tab choice even when two pages have the same URL.
- Recovery selection alone makes no native move, close, activation, or Space/Favorite adoption. The subsequent promotion moves only the chosen exact tab.
- Cancelled and stale choices do not silently recover, transfer, or adopt a tab. The controller, an unchosen equal-URL page, and unrelated ordinary-window state are preserved.

The module must fail on missing capability, absent evidence, stale exact IDs, untrusted input, failed reload proof, unexpected adoption, replacement documents, or uncertain outcomes. It must not synthesize a successful runtime response, erase session storage to simulate reload, match tabs by URL, recreate a controller, or close unknown pages during cleanup.

Launch success requires the exact persisted bridge response for the observed request, not merely a ready transient record. The surviving Spotlight UI must also show its real success status. If native tab activation has already retired the overlay, the report records that condition and explicitly leaves client-side response delivery unproved; the confirmed backend receipt and actual native result do not establish that the retired UI received the response.

## Safe cloud checks

These commands parse source or run unit tests. They do not launch Chrome:

```sh
node --check scripts/paired-chrome-little-arc.mjs
node --check scripts/paired-chrome-little-arc-context.mjs
node --check scripts/paired-chrome-little-arc-provenance.mjs
node --check scripts/paired-chrome-smoke.mjs
node --check scripts/paired-chrome-run-plan.mjs
node --test tests/unit/paired-chrome-little-arc.test.js tests/unit/paired-chrome-little-arc-wiring.test.js tests/unit/paired-chrome-little-arc-provenance.test.js tests/unit/paired-chrome-little-arc-context.test.js tests/unit/paired-chrome-run-plan.test.js
npm run test:unit
npm run build
git diff --check
```

Pure unit fixtures validate assertion rejection paths, run-plan wiring, actual event-file parsing, and the hosted receipt shell. They reject cross-repository fork heads, wrong repository/PR/branch/base identities, unsupported events, malformed or mismatched SHAs, missing/malformed event files, changed source, and missing build output. A valid same-repository PR fixture deliberately keeps its merge SHA different from the tested head. Because the authorized repository is itself a fork, its own `fork: true` metadata is accepted; a different head repository is rejected. The receipt test uses a local main clone and a disposable, explicitly labeled companion Git fixture containing committed Darwin-style dependencies and an internal `.bin` symlink. It simulates locked platform replacement with file writes only, without dependency installation, build, browser, network access, or user-repository commits. It loads the candidate validators from the working tree explicitly. Regression cases reject changed source/manifest/lockfiles, source additions and deletions, staged dependency changes, a source rename into dependencies, similar or nested dependency paths, ignored source additions, and root/nested symlink escapes. They are not browser acceptance evidence, even when they contain representative native-looking IDs or input observations.

## Requirements for a later authorized native run

Do not invoke the browser runner on this cloud workspace or the user's computer. The repository restricts it to its dedicated GitHub Actions environment, using a fresh disposable profile, headed installed Chrome under Xvfb, the ordinary non-root runner user, the isolated reviewed Puppeteer runtime, and Chrome's normal namespace sandbox. Keep every existing launch/security guard. A launch denial is a failed check, not permission to change the sandbox.

Both repositories must contain the reviewed Little Arc changes and must be rebuilt together. The eight legacy jobs and all legacy harness modes retain the published companion pin `c13511fd36d56358156c10336b8961b7ef95d5bc`. Only `little-arc` uses the separate literal candidate pin `3b0b178f2c11b3add351c430a1e7734f54f25c8f`. A pin alone does not establish that a published pair contains the approved changes: verify exact source provenance, the recorded source/build hashes, both production builds, and the real `transientWindowsV1` capability before accepting a result.

### Published baseline and exact acceptance identity

The published Arcify baseline is PR [#75](https://github.com/calvwng/arcify/pull/75), head `c8e1e69c7c28ef28c874cddcdc84e8dd10abc486`, on `integration/arcify-bridge-v1`. Its source tree is `cf98f802f9cdfd3840b08312d5edef4e5fbbb9d1`, identical to local preparation commit `3ead32f2c38d2e23617ca0d8f4ade20a5cf11c2c`. The published companion is exactly `3b0b178f2c11b3add351c430a1e7734f54f25c8f`. This follow-up changes test wiring, source-context validation, tests, and documentation only; production runtime source and the companion pin remain frozen.

The bounded PR route was published at `b28cdc0547c2c0fae379213591421c4d232b4059`. Its [first run](https://github.com/calvwng/arcify/actions/runs/39380837066) reached both builds but failed before browser launch: the pinned Spotlight repository tracks 313 `node_modules` paths, including Darwin binaries that locked `npm ci` legitimately replaces on Ubuntu. No native cases executed. This provenance correction will have a new Arcify head when published. A later acceptance run must record that exact event head and actual checkout, without treating an earlier SHA or equivalent tree as evidence that the new commit passed. The companion pin and production runtime remain unchanged.

### Bounded existing pull-request route

The existing workflow's triggers and path filters are unchanged. Its additional `little-arc` job may run on the existing `pull_request` event only for PR 75 in `calvwng/arcify`, with head repository `calvwng/arcify`, head branch `integration/arcify-bridge-v1`, and base repository `calvwng/arcify` targeting `main`. Both PR-number fields are checked. The job condition rejects other PRs, head branches, and cross-repository fork PRs before any job installation. `calvwng/arcify` is itself a GitHub fork; that repository-level flag does not disqualify its authorized same-repository head.

Checkout uses the immutable `github.event.pull_request.head.sha`. The shared source-context validator reads the actual `GITHUB_EVENT_PATH` before installation and again in the harness. It requires the event's full head SHA, declared `ARCIFY_TEST_HEAD` and `ARCIFY_PR_HEAD`, and the actual checkout to agree. It also checks event type, open PR state, repository/number/base/head identity, and the real runner refs. Missing or malformed payloads fail closed. GitHub's actual `GITHUB_SHA` and `GITHUB_REF` retain their pull-request merge provenance; they are recorded separately and are never rewritten or mislabeled as the tested head. See [GitHub pull-request workflow semantics](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request).

This is job-level isolation: `little-arc` selects exactly `[0, 1, 2, 55]`. All eight original jobs continue automatically on the PR event, with their original bodies, pins, permissions, ordering, and selection behavior. A green Little Arc job does not imply the complete workflow or required checks passed. Publishing the follow-up on this PR can start all nine jobs through the already existing PR event.

### Retained manual route and current limitation

The earlier assumption that a branch-only version of this workflow could provide an available web dispatch route was incorrect. The workflow is absent from default `main`, and the authenticated Actions page has no `Run workflow` control. GitHub documents that the workflow must exist on the default branch for `workflow_dispatch`; selecting a candidate branch does not remove that prerequisite. The connected GitHub tools also do not expose workflow dispatch. See [GitHub manual-workflow requirements](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow). No default-branch change or alternate browser execution is proposed.

The existing optional inputs are retained for a future separately supported and authorized manual run:

- `acceptance_scope` defaults to `legacy`; omitted/default/legacy dispatches keep the eight original jobs.
- Explicit `acceptance_scope=little-arc` selects only the Little Arc job and deliberately skips the eight legacy jobs. Only this manual selection isolates the overall workflow.
- `expected_arcify_head` must be a full 40-character SHA equal to the real dispatch input, `GITHUB_SHA`, and actual checkout. The actual event payload must explicitly select Little Arc. The companion checkout remains the separate fixed SHA above.

If either route is unavailable or rejects the candidate, retain the original failure and stop; do not change the default branch, fabricate event values, relax security/context checks, substitute local browser execution, or claim a skipped job as acceptance. If the companion ever changes, its job checkout, declared expected SHA, and harness literal must be reviewed together; never retarget the legacy jobs as a shortcut.

### Runtime and evidence gates

The isolated job retains Ubuntu 24.04, Node 22, all three locked `npm ci` installs, the separate Puppeteer 25.12.0 runtime self-test, installed stable Chrome, headed Xvfb, the ordinary non-root runner, and the existing normal namespace sandbox. It does not use the native-Split browser-update step. Workflow permissions remain only `contents: read`, both checkouts disable persisted credentials, and no secrets or new scopes are added.

Before dependency installation, the job records workflow ref/SHA/run identity, actual event ref/SHA, validated event provenance, expected and actual repository heads, Git tree/blob identities, and SHA-256 hashes of every tracked file, including the committed dependencies. Both complete trees must be clean. The companion verifier also rejects every pre-install untracked/ignored file and records separate protected-source and dependency snapshots. Root package manifests and lockfiles remain protected source.

After both builds, complete unfiltered Git status is retained for both checkouts in text and NUL-delimited form before verification can fail. Arcify retains its full clean-tree and original complete SHA-256 verification. Spotlight alone permits normal unstaged modifications/deletions/type changes and untracked additions under exactly `arcify-spotlight/node_modules/`, because locked installation replaces this repository's committed platform dependencies. Staged or unmerged changes are rejected, including within that root. No other source path receives this exception: every tracked protected path, mode, symlink target, and content hash must match its pre-install snapshot. Untracked and ignored source additions are checked too; only untracked `dist/` build output is handled separately by the production-output receipt. A rename checks both paths, so source moved into dependencies still fails.

The dependency root must remain a real directory. Internal npm `.bin` links are allowed only when their resolved targets remain inside that exact root; dangling links, root replacement with a symlink, and nested escapes fail. The evidence includes `arcify-spotlight-dependency-changes.json` with the exact allowed and unexpected Git entries, full before/after dependency manifests, and `arcify-spotlight-dependency-content-changes.json` showing added/deleted/changed dependency hashes and link targets, including ignored installed files. Nothing is silently dropped from the original pre-install hashes. Separate build logs and hashes of all `dist` files are retained. The harness independently checks the run-mode-specific companion pin and Little Arc's exact event-selected head before its first browser case. These receipts prove what was used, not native acceptance by themselves.

The existing browser command remains `xvfb-run --auto-servernum npm run test:paired-chrome -- ../arcify-spotlight`, with `ARCIFY_PAIRED_RUN_MODE=little-arc` supplied by the isolated job. This command is for a later separately authorized supported runner only; do not execute it locally. A failed checkout, source check, dependency step, build, runtime self-test, sandbox check, or browser case remains a failure. The job uses `pipefail` and always attempts to upload the evidence gathered so far; no same-profile retry or success fallback is added.

Results belong under `test-results/paired-chrome-little-arc/`. A successful result must include the complete case report, trusted-input and actual message/native-event observations, exact IDs, durable ownership before/after state, reload worker/view replacement proof, live document/form comparisons, required screenshots, and unchanged window B evidence. Missing, failed, skipped, or incomplete evidence cannot pass the selected run.

## Limits even after a successful run

An extension reload is not a full browser restart. This slice does not establish Chromium session-restore ordering, native-tab identity across a full restart, Helium behavior, or missing-controller recovery. It also does not replace the complete paired suite, visual/accessibility review, back/forward/login testing, drag-out/replacement testing, journal-boundary interruption coverage, or client-delivery confirmation when the Spotlight overlay retires before its response.

The approved v1 restart boundary is explicit: after session authority clears, an unmarked restored page follows ordinary restored-tab behavior. The user-facing warning appears up front and explains that Little Arc isolation may no longer hold across a full browser restart. These extension-reload cases do not prove full-browser restart ordering or make an unmarked page identifiable. Do not introduce automatic URL-based recovery, a broad startup adoption hold, or closure of unknown tabs.
