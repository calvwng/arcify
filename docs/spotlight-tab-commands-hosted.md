# Hosted Spotlight tab-command evidence

Status: import-safe module, now wired as stable case 51 in the independent [extended-actions plan](extended-actions-paired-ci.md), ordered 0, 1, 2, 50, 51. The existing 49/5/4/8/5 plans retain all original cases. No browser acceptance result is claimed until the dedicated sandboxed hosted job runs the reviewed integrated pair.

## Module source lineage and integration dependencies

These historical module commits describe its source; the current integrated
runner/workflow pin is authoritative for hosted acceptance.

- Reviewed backend base: Arcify `1b7a90bc3cd7868eaab783965346fc75e62071a6`, the isolated tab + Space-navigation combination. Original tab changes: `c333d82303683b8c482085ac56cc3a4b5224f1a9` and `7a55e178ebcaa18a2525ce3b8254492353b51595`.
- Matching combined Spotlight: `cbca3e50917272752378126fbe7bf9a026a89471`; original tab client `bf5f6fd5b6d235a74f0d69c78bbd4980530e6404`.
- Existing initial hosted evidence supplies `paired-chrome-spotlight-actions.mjs`: `installSpotlightActionApiObservation`, `readSpotlightActionPage`, and `assertSpotlightHelperProof`. Consult the current initial candidate `arcify-actions-hosted` (inspected at `8f677c7`); the reviewed backend base intentionally predates this helper module.
- Space-navigation evidence commit `873a39941e709a5edbf76c8b03e85e31ca031940` supplies `createNavigationFixturePage` and `installNavigationGroupObservation`. Its existing `attachCreatedFixtureTab` dependency from `paired-chrome-ui.mjs` must also be present.
- These two helper modules load dynamically only after the hosted-only guard. Importing this file, running its pure unit tests, or building the reviewed backend never requires Chrome, starts a browser, or changes browser permissions. A missing integration dependency is a failure, never a skipped acceptance case.

The integrated runner registers `serveSpotlightTabFixture(request, response)`
before the generic localhost handler and invokes `exerciseSpotlightTabCommands`
exactly once as case 51 after setup and navigation case 50. It passes the current
harness browser, `observePage`, `apiPage`, `spotlightOptions`, `newTabPage`,
`openSavedPage: openSavedMovePage`, `ui`, `screenshot`, `snapshot`, `bridge`,
`external`, `poll`, `fixture`, `arcifyId`, `spotlightId`, `search`, and an
incremental evidence-saving `record` callback. No positive command uses a direct
mutation shortcut; the real external adapter preserves rejection envelopes.
Existing full/lifecycle/split/appearance/recovery plans are unchanged.

## Hosted checks

All positive commands originate in the actual isolated overlay iframe. Fuzzy visible action selection preserves the ordinary web-search row, and passive capture records trusted native click/Enter, editable input, and one exact confirmation. Each mutation is paired with its precise external request fingerprint, authoritative receipt, browser events, stored state, and both window snapshots.

- Today rename and clearing: native page title stays untouched; exact-ID alias is persisted; same-URL Today twin is unchanged; clearing returns to native title. The already-mounted helper query receives real paired invalidation and repaints without retyping/reload.
- Saved rename: nested exact bookmark ID, parent, index, and same-URL decoys are retained. All linked live copies update their displayed title and clear obsolete aliases; persistence and both snapshots agree.
- Saved URL edit: saved title and bookmark identity stay fixed, both linked bindings persist the new URL, and neither live page navigates/reloads. The fixture switches the saved loopback hostname between `127.0.0.1` and `localhost` solely to make the URL change visible in the existing helper query. It does not open that URL. The saved row keeps its saved title; each divergent live tab retains its native page title.
- Duplicate: starts from a nonempty Today alias, creates exactly one new native ID adjacent to the captured source, inserts it at the corresponding canonical Today position, and activates only the new tab in the same window. It never inherits the source alias or saved identity. The exact receipt ID must finish loading before comparisons/replay. One fresh browser target is attached only after its native creation is proven; a required screenshot shows the active duplicate without foregrounding the old source.
- Mute/unmute: both Today and saved live sources change only their exact native muted state.
- Copy link: the live URL deliberately differs from the saved URL. A genuine `copyToClipboard` message must reach Arcify's existing offscreen document once. Native Ctrl+V into a real cancellable rename prompt must expose exactly that live URL, with trusted paste/input events. The prompt is cancelled and has zero side effects. Clipboard acknowledgment or a fabricated adapter response alone is insufficient. Unsupported clipboard behavior fails visibly; no permission grant/read shortcut is used.
- Exact owned New Tab and browser New Tab alias: no tab commands appear, including under direct command queries. The browser alias must pass the real nonce challenge/renderer attestation. It may never borrow the previous Today, saved, or Favorite source.
- Cancellation: Escape and Cancel preserve all captured native pages, aliases, bookmarks, saved records, windows, groups, selections, and journal. No mutation or clipboard send is dispatched.
- Stale context: a genuine native bookmark title change occurs after a URL prompt is prepared. The client rejects the stale confirmation without a mutation dispatch. Baseline comparison starts after the deliberate external edit settles.
- Revocation: a prepared saved rename fails closed after real receiver-side disconnect through Arcify settings. State is compared after returning focus to the source; the original pairing is restored through the real settings UI during cleanup.
- Replay: successful rename, duplicate, URL edit, and copy requests are replayed with the same immutable request ID. Stored receipts are reused with no additional native mutation, bookmark write, clipboard send, or fallback. This is separate from repeating genuine UI activation.
- Other-window selection is deliberately different during all command baselines. The second window's own Space and focus are preserved. Group projection is disabled only for this isolated fixture and restored exactly, including an originally absent setting.

Favorites are not editable. The fixture preserves Favorite records/session and their projected rows. It does not expand product behavior or treat a saved pin as a Favorite.

## Unit-only boundaries and honest limits

A deterministic hosted partial-commit race would require proving native event ordering at the guarded write. This module does not inject transport failures or claim that an unrelated later edit is a partial commit. Real backend adversarial tests in `tests/unit/spotlight-tab-actions.test.js` retain lost-ack, `PARTIAL_COMMIT`, `UNCERTAIN_RESULT`, receipt replay, pairing revocation at awaited boundaries, closed/moved/split/Favorite targets, and exact-ID decoy coverage. Matching Spotlight client tests retain no-native-fallback and no automatic mutation retry. The browser report explicitly labels these boundary cases unit-only.

The new pure evidence tests reject forged input, repeated/modified dispatch, wrong source IDs, dropped saved leaves, stale other-window snapshots, transferred aliases, changed saved titles/parents, missing persistence, wrong duplicate order/focus, wrong or repeated mute events, missing offscreen evidence, and incorrect pasted text. A request-receipt regression covers different mutations that reuse an identical source context: matching only command/context is insufficient.

Cleanup uses exact owned native and bookmark IDs, rejects unexpected descendants in a fixture bookmark root, restores original active IDs, selected Spaces, focused window, and group-sync setting, and verifies originals survived. A failed or unconfirmed duplicate does not authorize deleting a preexisting tab.

## Local verification

Run the import-safe checks without Chrome:

```sh
node --check scripts/paired-chrome-spotlight-tabs.mjs
node --test tests/unit/paired-chrome-spotlight-tabs.test.js tests/unit/spotlight-tab-actions.test.js tests/unit/tab-menu-actions.test.js tests/unit/paired-chrome-ui.test.js
npm run test:unit
npm run build
```

The complete hosted browser matrix remains unrun until an explicitly authorized hosted job exercises the exact reviewed integrated pair. Local route, adapter and mandatory run-plan checks do not establish a browser pass.
