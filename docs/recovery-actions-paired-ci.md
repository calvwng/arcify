# Supplemental fresh-profile recovery and initial actions acceptance

The independent `recovery-actions` GitHub Actions job sets
`ARCIFY_PAIRED_RUN_MODE=recovery-actions` and requires exactly five cases, once
in this order: **0, 1, 2, 48, 49**.

- 0–2: installed Chrome with its namespace sandbox, Developer-mode UI bootstrap,
  exact paired identities, options-UI pairing and disposable two-window fixtures
- 48: the unchanged native overlay recovery case, including all four scenarios,
  real reload/worker lifecycle receipts and recovered-overlay native Sidebar proof
- 49: the unchanged initial Spotlight actions case through the isolated overlay,
  owned New Tab and browser New Tab alias, including rejection and cleanup checks

These cases have one shared runner definition. Their bodies, assertions and full
ordering are unchanged. Recovery owns its nonce-bearing source and target;
actions own their source, pins, folders, helpers and restored options. Setup 0–2
already supplies their fixture routes, Work/Personal/Empty Spaces, paired options
realms and window-B baseline. Actions receive the current Spotlight options realm
after recovery's witnessed reloads.

On a fresh profile, recovery also needs the passive `sidePanel.onOpened` and
`sidePanel.onClosed` observation normally installed by preceding native Sidebar
cases. Only this mode initializes that observer immediately before case 48.
Initialization rejects existing observation state instead of clearing it or
registering a second listener. It creates no helper, opens no panel, changes no
stored settings and synthesizes no events. The original genuine Enter, native
SIDE_PANEL context, onOpened receipt, rendered identity, PNG dimensions and
unchanged-tab assertions remain required. Observer failure stops the run before
either acceptance case, with incomplete evidence rejected.

This supplemental result isolates recovery/actions from unrelated cumulative or
theme fixture failures. It provides no appearance/theme or full-suite acceptance.
It does not retry a failed case or reuse another job's mutated profile. The full
**49**, Favorite lifecycle **5**, native Split View **4**, and appearance/actions
**8** jobs remain unchanged mandatory outcomes. All six jobs must pass on the
exact integrated commit; success here cannot override another job's failure.

All jobs keep exact read-only checkouts with Spotlight pinned to
`7e19bc21906ba241308f766e551874419eb60287`, production builds and the isolated driver.
The new job has no dependency on another job, browser update, new secret,
permission change, security exemption or retry. Sandbox, native input, exact
identity, window-B, screenshot, crash and page-error gates are unchanged.

Evidence lives separately in `test-results/paired-chrome-recovery-actions/`, with
`report.json`, runner logs and required screenshots uploaded on success or
failure as `paired-chrome-recovery-actions-<run>-<attempt>`. The report labels its
five-case scope supplemental, not a full-suite or appearance result. Missing,
duplicate, reordered, skipped, failed or incomplete evidence fails the run.

Unit/source-orchestration tests exercise all five plans without launching Chrome,
including failure at every selected case and the fresh observer boundary. Exact
source digests preserve all 50 case definitions, the four original jobs and the
shared safety/evidence gates. Local tests, syntax checks and builds are not real
browser acceptance; the exact combined commit still needs its hosted results.
Physical keyboard hardware, OS appearance/color pickers and Helium remain manual.
