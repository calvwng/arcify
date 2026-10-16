# Spotlight Space navigation hosted acceptance

`scripts/paired-chrome-spotlight-navigation.mjs` is import-safe. Importing it or
running the assertion tests cannot start Chrome, a native helper, or a local
browser. `exerciseSpotlightNavigation` fails closed outside a non-root GitHub
Actions CI job. It creates no remote publication and changes no permissions.

## Integration contract

This is prepared acceptance, **not a reported browser pass**. The runner now
wires this module as stable case 50 in the independent
[extended-actions plan](extended-actions-paired-ci.md), ordered 0, 1, 2, 50, 51.
The existing 49-case full, 5-case Favorite lifecycle, 4-case native-split,
8-case appearance/actions and 5-case recovery/actions plans stay unchanged.
The exact reviewed integrated pair still needs authorized hosted acceptance.

Historical module source lineage (the integrated runner/workflow pin is authoritative):

- Arcify base: `3920f5c5a6f0caa9aa637e9c9a370a714905503f`
- Reviewed backend dependency: `d8caed722b965b1684749b0a4690d30acddc7cd5`
- Reviewed separate Spotlight client: `85b81acbcbdd4313ef37f703673761c021365560`
- Case identity: `SPOTLIGHT_NAVIGATION_CASE_NAME`
- Entry point: `exerciseSpotlightNavigation`
- HTTP route, before generic server handler:
  `serveSpotlightNavigationFixture(request, response)`

Provide the existing harness-owned `browser` and `observePage` plus the same real
adapters as the initial actions case: current `apiPage`, `spotlightOptions`, `newTabPage`, `openSavedPage: openSavedMovePage`,
`pageForUrl`, `ui`, `screenshot`, `snapshot`, `bridge`, `external`, `poll`,
`fixture`, `arcifyId`, `spotlightId`, `search`, and evidence-persisting `record`.
`external` must return the actual success or rejection envelope unchanged. No
adapter may fabricate success, invoke a renderer controller, synthesize a trusted
event, or replace an API. `newTabPage` is used only for supported extension helper
URLs/browser aliases; exact saved decoy targets use `openSavedMovePage`.
The import-safe `createNavigationFixturePage` uses the already-running browser,
requires exactly one newly created native ID and one fresh page target, and
attaches every ordinary source/twin by that creation receipt. A same-URL older
target can never substitute for the new document. Attach failure removes only
its created ID through the existing strict fixture helper.

The integrated runner explicitly enables the initial-action helper oracle's
extended-peer expectation: exactly folder/settings plus Switch Space. Its default
legacy expectation stays folder/settings only. Both reject Move/pin/remove and
all tab-command helper rows; the initial case remains mandatory in its original
plans.

## Required real-browser evidence

The module uses nonce-bound loopback documents and three new disposable bookmark
Space roots. The source and destination have independent ordinary native pages;
there is a same-window same-address Today twin and another-window exact saved
same-address decoy. All positive actions come from genuine visible result rows,
Enter/primary clicks, a real native select driven by keyboard, and a separate
picker submission. No positive navigation command is sent directly.

- Genuine isolated overlay iframe and both literal owned New Tab and browser
  `chrome://newtab/` helper surfaces
- Fuzzy discovery ranked first with web search retained and manually selectable
- Exact active source tab/window, selected Space/bookmark root, pairing generation,
  source URL, canonical Today representation and all existing valid destinations
- Picker has no chosen target initially, exact non-source existing choices, and
  ID-disambiguated duplicate display-name labels for two nonce-created targets
- Empty-choice Enter shows the actual error and makes zero mutation; Escape and
  Cancel preserve query, native state, all captured storage and request journal
- Switch to an existing nonempty Space focuses its pre-existing local last tab;
  both truly empty and other-window-only destinations preserve native focus
- Populated Switch with group sync off and on. Sync-on starts from settled exact
  native partitions and permits only the expected source-window group collapse
  changes. Other-window groups/focus and all native IDs/order/URLs stay unchanged.
  Empty Switch requires no transient group or native changes.
- Exact one-ID Today Move at visible destination tail, for all four combinations
  of native group sync off/on and canonical Today orientation normal/inverted
- Move leaves the selected source Space and page/native focus unchanged; it must
  not project groups, even with group sync on. Same-URL twins, saved bindings,
  bookmarks, other windows, page document identities/time origins/input and native
  strip identities/order remain unchanged.
- Actual extension-to-extension request with exact new capability, full captured
  context and target, one confirmed journal receipt, no fallback or late retry
- Fresh authenticated snapshots and actual rendered destination/source chips;
  ordinary web-search keyboard selection survives a real passive bookmark-driven
  result refresh, observed through a read-only MutationObserver
- New Tab helpers expose Switch/settings/folder only, never Move/pin/remove; an
  actual invalid helper Move request fails with INVALID_REQUEST and zero writes
- Browser alias ownership has actual nonce challenge and independently attested
  renderer ACK evidence before it becomes inactive
- A prepared picker rejects changed source selection and receiver-side pairing
  revocation through real settings. Error UI, one internal attempt, no receiver
  mutation and unchanged authoritative raw state are required.

Screenshots are mandatory for visible pickers/no-choice errors, populated and
empty Switch outcomes, moved pages, owned/alias helpers and rejected prepared
actions. Each action includes passive input, extension transport, native tab,
window, tab-group, bookmark and storage traces. Source frames are read without
foregrounding after Switch; background status polling uses timers, not RAF.

## Setup, cleanup and ownership

Direct APIs are restricted to disposable fixture creation/cleanup, read-only
attestation and clearly labeled negative probes. Source selection setup uses the
normal local Space API, not a positive action shortcut. Setup waits longer than
the native 200 ms projection debounce for stable real read-back before measuring.

Only the three exact nonce-created Spaces, exact created tabs and exact created
bookmark leaves are removed. Cleanup restores initial selected Spaces, active
native tabs, focused window, exact presence/value of the group-sync setting and
canonical Today representation. It verifies no owned membership, tab, bookmark
or Space survives and that settings/selections are restored. The original
profile is the harness's disposable profile: normal group projection induced by
fixture setup follows the product's existing behavior. Cleanup does not rewrite
old native group IDs or old action journals to manufacture a pristine snapshot.
All cleanup callbacks run; any cleanup error fails acceptance without masking a
primary failure. A revoked grant is restored via the actual settings UI and has
its naturally new generation, never by restoring an old grant token.

## Clearly separated local evidence

`tests/unit/paired-chrome-spotlight-navigation.test.js` is assertion-counterexample
evidence only. It does not prove real trusted Chrome input or browser behavior.
`tests/unit/spotlight-space-navigation-source-races.test.js` runs the real backend
handler with mocked browser APIs: closed/moved exact sources cannot borrow an
active same-URL twin; restoring the old source then replaying the same request ID
stays UNCERTAIN_RESULT with no further effects.

Existing real-handler mocked tests in `spotlight-space-navigation.test.js` cover
late pairing revocation, changed URL/source/root/target identity, selection and
ordering races, native helpers including query/hash aliases, splits, saved pins,
Favorites, provisional/recovery membership, post-commit partial outcomes and no
replay. The reviewed client's unit/DOM suites separately cover held/repeated and
composing input, stale source reattestation, no mutation fallback, strict response
validation and uncertain-result no automatic retry. None are mislabeled hosted
acceptance; no injected race hook is used to create a fake browser success.

Run locally without any browser launch:

```
node --check scripts/paired-chrome-spotlight-navigation.mjs
node --test tests/unit/paired-chrome-spotlight-navigation.test.js tests/unit/spotlight-space-navigation-source-races.test.js
npm run test:unit
npm run build
```

The final integrated pair still needs the approved hosted CI run and its actual
screenshots/transport/native evidence. Missing observations, missing routes,
changed peer pins or unavailable inputs are failures, never silent skips.
