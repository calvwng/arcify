# Initial Spotlight Space-action browser acceptance

`scripts/paired-chrome-spotlight-actions.mjs` is an import-safe acceptance module.
It does not import the browser launcher, start Chrome/native helpers, change
permissions, or alter sandbox policy. Its exercise entry point requires the
ordinary, non-root GitHub Actions paired-Chrome harness. Local tests import only
this helper module.

This is a mandatory acceptance case for the initial four actions. Exported case
name: `SPOTLIGHT_ACTION_CASE_NAME`. Exported entry point:
`exerciseSpotlightActions`. Exported HTTP route:
`serveSpotlightActionFixture(request, response)`.

## Harness integration

The route runs before the generic server handler. Mandatory full case 49 uses
the exported case identity and executes after recovery case 48, before the
unchanged Favorite lifecycle receipts and final browser restart. Every previous
47 full case remains mandatory; the exact full/lifecycle/native-split plans are
49/5/4. Existing native sidebar gesture and completeness gates are unchanged.

The runner and all three workflow jobs pin reviewed, published Spotlight commit
`dae17a24d4e3b90cecd42a19ceeb7322b755370b`. Recovery and action evidence remain
separate in the report. The action case receives the current options realms
after the witnessed recovery reloads, not stale pre-reload Page objects.

The entry point takes these existing harness adapters:

- `apiPage`: current Arcify options page, after any witnessed reload
- `spotlightOptions`: current Spotlight options page
- `newTabPage`, `pageForUrl`, `ui`, `screenshot`, `snapshot`, `bridge`, `external`,
  `poll`, `search`, `fixture`, `arcifyId`, `spotlightId`
- `openSavedPage: openSavedMovePage`: the existing exact-new-target saved-page
  adapter; it must not select an older same-address target
- `record`: persist each returned evidence checkpoint in the run report

`external(page, peerId, command, payload, requestId?)` must return the actual
extension-to-extension envelope, including rejection envelopes. It must not
assert success before returning. All positive actions are performed through
actual visible result rows, prompts, clicks, typing and keyboard input. Direct
API calls are restricted to fixture setup/cleanup, read-only context assertions,
and labeled negative probes.

The module creates nonce-bound disposable pages, bookmark roots, a same-address
saved decoy, an exact second-window linked copy, and a separate counterpart-Space
pin. It restores the existing group-sync option, pairing, active Spaces/tabs and
removes only its exact disposable identities in `finally`. It deliberately turns
group sync off for this initial case; immediate preservation is verified without
claiming later group-projection behavior. Existing Move/group-sync cases remain
separate.

## Required evidence

- Real isolated overlay iframe, not an ordinary tab substituting for an overlay
- Bounded-typo action rows visibly ranked first, selected for genuine Enter, with
  web search still present and manually selectable by keyboard
- Exact active source tab/window, selected Space/root, pairing generation and
  captured saved metadata; inactive and wrong-window read requests reject
- Pin creates one new bookmark even when the address already has another saved
  identity; one binding and one confirmed journal receipt, no replay
- Remove displays the exact bookmark and explicit retained-live-copy meaning;
  Cancel initially owns focus; both Escape and Cancel perform zero writes
- Remove retains both linked native pages and their independent document/input
  state, clears only exact bindings/aliases and preserves the same-address decoy
- Named folder input in both overlay and New Tab; cancelled names create nothing;
  committed names create one root folder without changing existing metadata/order
- Settings opens one own options page in the exact originating window and keeps
  the source page and the other window's selected Space/native state intact
- Both the literal owned New Tab URL and browser `chrome://newtab/` alias expose
  folder/settings only; neither may guess the previously active content page
- Alias ownership needs real nonce probes and independently sent, browser-attested
  ACKs from the exact initialized renderer; URL/title matches alone never pass
- Passive actual extension-message and native/bookmark/storage observers; no
  monkey-patched Chrome API, controller invocation, synthetic trusted flag, or
  fabricated successful bridge response
- Real malformed peer messages and untrusted options-source impersonation using
  the existing `evaluateWithoutGesture` mechanism reject without any state write
- Revocation through Arcify's actual settings rejects a previously prepared
  folder confirmation; the test restores the grant through the settings UI
- No action uses the separate physical `arcify-sidebar` transport or opens the
  native panel; the existing sidebar gesture acceptance cases remain unchanged

Every positive checkpoint includes before/after authoritative state, the actual
request, trusted input trace and native/bookmark message trace. Cancellation and
rejection compare native identity, bookmark metadata/order, bindings, aliases,
Favorites, saved snapshots, active Spaces, groups/projection and journal state.
Only volatile snapshot `capturedAt` values are excluded from equality. Mandatory
screenshots cover visible prompts, source pages, helper/alias success and the
revoked-action error.

## Verification and limits

Run locally without launching a browser:

```
node --check scripts/paired-chrome-spotlight-actions.mjs
node --test tests/unit/paired-chrome-spotlight-actions.test.js tests/unit/paired-chrome-spotlight-wiring.test.js
```

The unit tests exercise assertion helpers with counterexamples. They are not
browser acceptance and do not prove Chrome UI behavior. A hosted run is still
required for the final integrated Arcify commit and exact peer pin.

The helper assertion also protects a regression identified in Arcify f42c4d6:
`chrome://newtab/` was assigned Today context even though the literal extension
helper returned null. Keep both routes fail-closed rather than relaxing the
assertion or manufacturing helper success.
