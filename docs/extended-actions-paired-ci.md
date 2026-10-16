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

All eight jobs check out exact read-only Arcify/Spotlight revisions and use the
shared mandatory sandbox, runtime, ordinary Developer Mode UI, identity,
window-isolation, crash/error and evidence guards. The new job uses its own fresh
runner/profile, the installed Chrome package, the existing 20-minute timeout,
and no package-update path. No browser, workflow or publication is performed by
local assertion tests. The reviewed local Spotlight candidate
`b510b3dbe8cfae6441fbc55a23ce19de30805a6d` is pinned in the runner and all eight
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

## Action-surface lifetime and prompt usability

A successful populated local Switch or Duplicate activates a different native tab;
Spotlight intentionally retires the source overlay. Acceptance predicts that
lifetime from the exact pre-action command and native membership, preserves only
passive trusted-input records on the unchanged source parent, and requires the
original overlay host to disappear. Exact request fingerprint, durable successful
receipt, native identity/state and one-dispatch checks run before and after that
completion. Raw dispatch/receipt evidence is saved before validation. No detached
frame error is caught as success, and no replacement surface, refocus, resubmission
or retry retrieves the result. Empty or other-window-only Switch, Move, other tab
commands and whole-page New Tab helpers continue requiring real success status.

Every confirmed prompt must have nonzero visible heading, description, field and
both buttons inside its real viewport and prompt bounds. Prompt text and errors
must not overflow horizontally. Read-only polling allows the actual iframe sizing
to settle; it cannot repair the DOM or waive clipped controls. Initial and selected
Space pickers and initial/edited tab prompts are checked. Long duplicate Space
names retain their complete exact option text and identity routing. These geometry
checks require the companion prompt-bounds CSS repair; only hosted screenshots and
trusted confirmation on the final pinned pair establish rendered acceptance.

Browser-alias helper origin in cases 50–51 is a separate pre-mutation assertion
from case 49's committed-folder-action proof. It requires the actual renderer's
exact Space/tab context-read request and Chrome sender metadata for the current
helper source. Missing sender-tab metadata requires the existing complete nonce
challenge/ACK sequence for that exact source; present mismatched metadata cannot
fall back. Read-only refreshes from other mounted helpers cannot supply evidence
for the tested source. This origin-only trace does not supply a request ID or
Chrome document ID and does not claim one-to-one nonce/request correlation.
Subsequent action evidence remains independently bound to its exact request,
trusted input, durable receipt and native state. Execution regressions run both
actual hosted helper call-site blocks against the real strict origin oracle.
Challenge scoping includes every event naming the tested source or sharing one of
its nonce values. A wrong-source ACK sharing that nonce is fatal. Complete,
independently consistent pairs for other helpers are recorded separately and
cannot satisfy the tested helper's fallback; malformed or ambiguous pairs fail.
Origin collection uses the existing bounded read-only poll for explicitly
incomplete context/challenge observations. Every present malformed or mismatched
entry fails immediately. The trace must remain append-only and helper document
identity/time origin must stay fixed; navigation, dropped evidence or rewritten
records fail. No request, input, focus change or mutation is retried.
