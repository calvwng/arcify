# Supplemental fresh-profile extended Spotlight actions acceptance

The independent `extended-actions` GitHub Actions job sets
`ARCIFY_PAIRED_RUN_MODE=extended-actions` and requires exactly five cases, once
and in this order:

- 0–2: unchanged sandbox/identity, real pairing UI, and base localhost fixtures
- 50: Spotlight Space navigation with genuine destination pickers, exact Today
  identities, and owned/browser-alias New Tab helper coverage
- 51: Spotlight tab commands with genuine visible input, exact live/saved
  identities, and actual offscreen clipboard/native paste evidence

The new cases use the current harness-owned browser, page observation, options
pages, immutable-source creation helpers, UI input, snapshots, transport, polling
and screenshot adapters. Each module owns its disposable data and restores its
selected Spaces, settings, active tabs and focused window before returning.
Neither depends on a previous appearance, recovery, full-suite, or lifecycle
case. Both dedicated nonce-bearing HTTP routes precede the generic localhost
handler. Evidence is saved incrementally; missing screenshots or failure to save
observations fails the case.

This adds no cases to the existing plans. Full **49**, Favorite lifecycle **5**,
native Split View **4**, appearance/actions **8**, and recovery/actions **5**
retain their original cases and order. Case identities 0–49 remain stable; the
new cases are 50–51. A passing five-case extended result does not claim full-suite,
recovery, appearance, lifecycle or native Split View acceptance. Every selected
case must pass exactly once in its declared order. Missing, skipped, duplicate,
extra, mislabeled or reordered results fail closed. There are no same-profile
retries, isolated-case exemptions, upstream job dependencies or allowed failures.

## Exact peer compatibility and preservation

All six jobs check out exact read-only Arcify/Spotlight revisions and use the
shared mandatory sandbox, runtime, ordinary Developer Mode UI, identity,
window-isolation, crash/error and evidence guards. The new job uses its own fresh
runner/profile, the installed Chrome package, the existing 20-minute timeout,
and no package-update path. No browser, workflow or publication is performed by
local assertion tests. The reviewed local Spotlight candidate
`6379d3a22608507a4865bb44d17344ef8ea1eff6` is pinned in the runner and all six
workflow checkouts. This preparation does not publish it or run any workflow.

The initial action module's default helper oracle still requires exactly Create
folder and Open settings. The integrated runner explicitly enables the reviewed
extended peer expectation, which requires those same rows plus exactly Switch
Space. Move, pin, remove and every tab-command row remain forbidden on helpers.
This is the only added compatibility input to initial case 49; it does not skip
or relax the existing action/alias/transport/native-state checks.

Preservation tests retain the original 0–49 callback/name/option receipts after
removing only the two explicit added HTTP-route lines and that exact compatibility
input. The new wiring has its own executable mocked-adapter tests. Existing job
bodies, shared step gates, recovery/sidebar evidence and terminal failure handling
retain their reviewed checks; any necessary exact companion-pin substitution is
reviewed separately.

## Evidence and remaining acceptance

Evidence is separate at `test-results/paired-chrome-extended-actions/`, including
`report.json`, screenshots and `runner.log`, uploaded on success or failure as
`paired-chrome-extended-actions-<run>-<attempt>`. The report's
`spotlightNavigation` and `spotlightTabCommands` fields preserve each module's
observations independently, including partial failure evidence. A report save
failure or case-50 failure prevents case 51; no automatic retry manufactures a
passing result.

The [navigation evidence contract](spotlight-navigation-paired-ci.md) and
[tab-command evidence contract](spotlight-tab-commands-hosted.md) define each
browser matrix and its pure/mock-only boundary cases. Local checks prove run-plan,
adapter, route, failure and compatibility wiring only. The integrated exact pair
still requires an explicitly authorized, sandboxed hosted run and review of its
actual reports, screenshots, trusted-input, transport and native-state evidence.
Physical keyboard/OS behavior and Helium remain manual; deterministic lost-ack,
late-commit and receiver-boundary races remain labeled unit/mock evidence.

Local checks that do not launch Chrome:

```sh
node --check scripts/paired-chrome-smoke.mjs
node --check scripts/paired-chrome-run-plan.mjs
node --test tests/unit/paired-chrome-run-plan.test.js tests/unit/paired-chrome-extended-wiring.test.js tests/unit/paired-chrome-spotlight-navigation.test.js tests/unit/paired-chrome-spotlight-tabs.test.js tests/unit/paired-chrome-spotlight-actions.test.js
npm run test:unit
```
