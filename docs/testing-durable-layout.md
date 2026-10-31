# Testing durable layouts

Run unit regressions with `npm run test:unit`. The durable-layout, explicit-Today,
diagnostic, transient-window and real-sidebar tests cover mapping ambiguity,
history preservation, current-incarnation ownership, stale asynchronous evidence,
partial startup, write/readback interruption and compatible fallback transitions.

## Packaged native restart fixture

Build the normal extension, install Puppeteer's test browser if needed, then run:

```sh
npm run build
npx puppeteer browsers install chrome
ARCIFY_EXPECT_BOUNDED_MAPPING=true ARCIFY_PACKAGED_LAYOUT_CASE=extra-startup node scripts/disposable-packaged-layout-restart.mjs
```

The fixture uses the unmodified production manifest/background, real runtime Move
receiver, native pins, synthetic localhost pages and real browser process restarts.
It always creates a fresh profile under the OS temporary directory and never
accepts an existing profile or attaches to a running browser. On Windows set the
environment variables using PowerShell. `ARCIFY_DISPOSABLE_BROWSER` optionally
selects an installed compatible Chromium executable; otherwise Puppeteer's browser
is used. Native New Tab aliases are checked for Chrome and Edge.

Available cases: `baseline`, `extra-startup`, `native-newtab`, `own-launcher`,
`interleaved`, `duplicate-mapping`, `partial-startup`, and `navigation`.
Set `ARCIFY_EXPECT_BOUNDED_MAPPING=true` to assert the expected positive or negative
result. Duplicate mappings and changed saved slots must remain unresolved.
The interleaved case removes its extra tab and verifies another full restart.
Partial startup verifies deferral before the missing native tabs arrive.

Some cases pause only the owned fixture worker at shutdown while modifying its
synthetic native tabs; this preserves a confirmed checkpoint for controlled
startup races. No production module is replaced or API stubbed in this fixture.

By default the script inventories `dist`, verifies the complete copied file set and
hashes, and records that input inventory in its fresh temporary directory. An
optional `ARCIFY_PACKAGED_LAYOUT_RECEIPT` can name an external JSON manifest with
`commit` and `artifacts.forward.inventory` entries containing `path` and `sha256`.
`ARCIFY_TEST_SOURCE_REVISION` labels locally inventoried builds. Outputs are
synthetic receipts and owned-process exit results in the temporary directory;
do not commit generated profiles, logs or receipts.

## Source-module fixture

`node scripts/disposable-layout-restart.mjs` uses actual source modules in a small
MV3 fixture. `ARCIFY_LAYOUT_FIXTURE_CASE` selects `baseline`, `pinned-import`,
`pending-grouping`, or `fresh-choice`. This is useful for controlled legacy history
and query-arrival cases, but is distinct from testing the packaged background.
It uses the same browser override and fresh OS-temporary-profile boundary.

Neither fixture establishes behavior for a particular user's history, Helium, or
real Spotlight integration. Preserve those limitations when reporting results.

## Paired extension reload transition

`node scripts/disposable-paired-layout-transition.mjs /path/to/spotlight/dist`
copies the current Arcify package and the supplied exact Spotlight package into
a fresh temporary directory. Set `ARCIFY_DISPOSABLE_BROWSER` as above. It creates
synthetic windows before pairing, uses the real options UIs and Move receiver,
then reloads each extension after detaching its observed worker debugger.
Assertions require complete cross-window order preservation and normal grouping
of recreated ordinary companion pages. Outputs contain only synthetic fixture
state and must not be committed. Its owned browser closes in `finally`, reporting
exit status. It never attaches to an existing browser or uses a user profile.
This causal reproduction complements, but does not replace, the complete hosted
paired Chrome acceptance matrix or manual Helium verification.
