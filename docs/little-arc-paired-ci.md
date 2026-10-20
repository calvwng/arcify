# Little Arc paired-browser acceptance candidate

Status: unpublished, locally prepared acceptance source and manual CI wiring. No native run has been performed. No workflow has been dispatched. This candidate does not authorize publication, installation, dispatch, deployment, or product acceptance.

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
node --check scripts/paired-chrome-smoke.mjs
node --check scripts/paired-chrome-run-plan.mjs
node --test tests/unit/paired-chrome-little-arc.test.js tests/unit/paired-chrome-little-arc-wiring.test.js tests/unit/paired-chrome-little-arc-provenance.test.js tests/unit/paired-chrome-run-plan.test.js
npm run test:unit
npm run build
git diff --check
```

Pure unit fixtures validate assertion rejection paths and run-plan wiring. They are not browser acceptance evidence, even when they contain representative native-looking IDs or input observations.

## Requirements for a later authorized native run

Do not invoke the browser runner on this cloud workspace or the user's computer. The repository restricts it to its dedicated GitHub Actions environment, using a fresh disposable profile, headed installed Chrome under Xvfb, the ordinary non-root runner user, the isolated reviewed Puppeteer runtime, and Chrome's normal namespace sandbox. Keep every existing launch/security guard. A launch denial is a failed check, not permission to change the sandbox.

Both repositories must contain the reviewed Little Arc changes and must be rebuilt together. The eight legacy jobs and all legacy harness modes retain the published companion pin `c13511fd36d56358156c10336b8961b7ef95d5bc`. Only `little-arc` uses the separate literal candidate pin `57032e53559c0b90a4c26bf9351e730fed5167e8`. A pin alone does not establish that a published pair contains the approved changes: verify exact source provenance, the recorded source/build hashes, both production builds, and the real `transientWindowsV1` capability before accepting a result.

### Existing-workflow manual route

The candidate adds two optional inputs to the existing `.github/workflows/paired-extension-smoke.yml`:

- `acceptance_scope` defaults to `legacy`. Omitted/default/legacy dispatches and every existing automatic event retain all eight original jobs with their original pins and body contents. No automatic trigger or watch path is added or removed.
- An explicit manual `acceptance_scope=little-arc` selects only the new `little-arc` job. Its selected cases are exactly `[0, 1, 2, 55]`; the eight legacy jobs are deliberately skipped only for that selection. This result cannot stand in for full-suite required checks.
- `expected_arcify_head` is optional for legacy runs but mandatory for Little Arc. The Little Arc job fails before installation/build/launch unless this is a full 40-character commit SHA equal to the dispatched `github.sha` and the actual Arcify checkout. The companion checkout must match its separate literal SHA. Neither repository is checked out from a mutable branch name by the job.

GitHub documents that an existing workflow can be dispatched against a branch or tag, and the CLI's `--ref` selects the version of the workflow file to run. The CLI reads interactive input definitions from that selected ref, or sends explicit input fields with the selected ref. This permits the candidate version of the existing known workflow to define these inputs without introducing a new workflow file on the default branch. See [GitHub workflow dispatch](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch), [the CLI manual](https://cli.github.com/manual/gh_workflow_run), and [the CLI implementation](https://github.com/cli/cli/blob/trunk/pkg/cmd/workflow/run/run.go).

A future, separately authorized dispatch would use the following shape. `CANDIDATE_REF` and `APPROVED_MAIN_SHA` are placeholders; substitute the verified remote branch/tag and its full approved main commit SHA. This example has not been executed:

```sh
gh workflow run paired-extension-smoke.yml --repo calvwng/arcify \
  --ref CANDIDATE_REF \
  -f acceptance_scope=little-arc \
  -f expected_arcify_head=APPROVED_MAIN_SHA
```

If the existing local companion object `57032e53559c0b90a4c26bf9351e730fed5167e8` is later published unchanged, the literal pin is final. If that commit is rewritten or amended, update the Little Arc-only companion checkout, its declared expected head, and the harness's Little Arc pin together; rerun source/build checks, create a new main review commit, and obtain approval for the resulting exact pair before dispatch. Never retarget the eight legacy jobs or their legacy harness pin to accomplish this.

The candidate is local only. Before any later authorized run, confirm that the existing workflow remains active/dispatch-enabled, both exact reviewed commits are available remotely, and the selected Arcify branch or tag resolves to the approved main commit. Pass `acceptance_scope=little-arc` and that full commit as `expected_arcify_head`. If GitHub rejects the candidate-ref inputs, stop and report the original error; do not edit the default branch, dispatch the legacy suite, relax guards, or run a browser elsewhere as a fallback. No remote availability or successful dispatch is asserted here.

### Runtime and evidence gates

The isolated job retains Ubuntu 24.04, Node 22, all three locked `npm ci` installs, the separate Puppeteer 25.12.0 runtime self-test, installed stable Chrome, headed Xvfb, the ordinary non-root runner, and the existing normal namespace sandbox. It does not use the native-Split browser-update step. Workflow permissions remain only `contents: read`, both checkouts disable persisted credentials, and no secrets or new scopes are added.

Before dependency installation, the job records workflow ref/SHA/run identity, expected and actual repository heads, Git tree/blob identities, and SHA-256 hashes of every tracked source file. Clean source trees are required. After both production builds, it verifies those same source hashes and clean trees again and records SHA-256 hashes of all `dist` files. Separate build logs are retained. The harness independently checks the run-mode-specific companion pin and Little Arc's exact reviewed main SHA before its first browser case. These receipts prove what was used, not native acceptance by themselves.

The existing browser command remains `xvfb-run --auto-servernum npm run test:paired-chrome -- ../arcify-spotlight`, with `ARCIFY_PAIRED_RUN_MODE=little-arc` supplied by the isolated job. This command is for a later separately authorized supported runner only; do not execute it locally. A failed checkout, source check, dependency step, build, runtime self-test, sandbox check, or browser case remains a failure. The job uses `pipefail` and always attempts to upload the evidence gathered so far; no same-profile retry or success fallback is added.

Results belong under `test-results/paired-chrome-little-arc/`. A successful result must include the complete case report, trusted-input and actual message/native-event observations, exact IDs, durable ownership before/after state, reload worker/view replacement proof, live document/form comparisons, required screenshots, and unchanged window B evidence. Missing, failed, skipped, or incomplete evidence cannot pass the selected run.

## Limits even after a successful run

An extension reload is not a full browser restart. This slice does not establish Chromium session-restore ordering, native-tab identity across a full restart, Helium behavior, or missing-controller recovery. It also does not replace the complete paired suite, visual/accessibility review, back/forward/login testing, drag-out/replacement testing, journal-boundary interruption coverage, or client-delivery confirmation when the Spotlight overlay retires before its response.

The approved v1 restart boundary is explicit: after session authority clears, an unmarked restored page follows ordinary restored-tab behavior. The user-facing warning appears up front and explains that Little Arc isolation may no longer hold across a full browser restart. These extension-reload cases do not prove full-browser restart ordering or make an unmarked page identifiable. Do not introduce automatic URL-based recovery, a broad startup adoption hold, or closure of unknown tabs.
