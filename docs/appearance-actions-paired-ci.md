# Supplemental fresh-profile appearance and actions acceptance

The independent `appearance-actions` GitHub Actions job sets
`ARCIFY_PAIRED_RUN_MODE=appearance-actions` and requires exactly eight cases, once
in this order: **0, 1, 2, 33, 46, 47, 48, 49**.

- 0–2: normal namespace-sandboxed installed Chrome, Developer-mode UI bootstrap,
  exact paired identities, options-UI pairing and disposable two-window fixtures
- 33: the unchanged sidebar appearance case, including owned density Favorites
  and bookmarks, their cleanup, and persisted Standard/default appearance
- 46–47: native Space themes and the reviewed Spotlight options collector
- 48–49: native overlay recovery and initial Spotlight actions

Case 33 is a required prerequisite, not a synthetic storage seed. It establishes
persisted appearance defaults through real controls before case 46's strict
before/after comparisons. Each case has one shared runner definition; full mode
retains its exact original order. The independent job prevents failures in older,
unrelated cumulative fixtures from masking these acceptance cases. It does not
retry a failed full-run case or reuse that run's mutated profile.

The full **49**, Favorite lifecycle **5**, and native Split View **4** jobs remain
unchanged mandatory workflow outcomes. The separate
[recovery/actions job](recovery-actions-paired-ci.md) requires five cases and
provides no theme/appearance acceptance. All five jobs use exact read-only
checkouts and Spotlight `9c4462fb0f3cbfe2585757c43f34398e9c906fde`, production
builds, and the existing isolated driver. The new job has no dependency on the
full job, browser update, new secret, security-setting change or error exemption.
Existing sandbox, native input/identity, window-B, screenshot, crash and page-error
guards apply. Missing, duplicate, reordered, failed or skipped evidence fails;
there is no same-profile case retry.

Evidence is separate at `test-results/paired-chrome-appearance-actions/`, including
`report.json`, runner logs and required screenshots, uploaded on success or
failure as `paired-chrome-appearance-actions-<run>-<attempt>`. The report explicitly
labels the eight-case result supplemental rather than a full-suite result.

Local unit/source-orchestration checks, syntax checks and builds do not establish
real browser acceptance. This new job's real hosted outcome is unverified until
it runs on the exact combined commit; all five job results remain required.
The existing physical keyboard/OS appearance, native color-picker and Helium
limitations still apply. No browser or native helper is run locally.
