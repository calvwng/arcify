# Native Ctrl+W evidence helper

`scripts/paired-chrome-native-close.py` is CI-only and intentionally separate from
product code. Its Node wrapper exports `readExpectedXvfbPid`,
`probeNativeCloseTarget`, and `sendOneNativeClose`. Importing either module opens
no display. Pure tests inject every X library and process observation.

## Integration contract

1. Serve a localhost fixture document with a fresh 32-character lowercase hex
   nonce in its title. Use a real unpinned Favorite tab in the expected window.
   Assert the exact Favorite ID, native tab ID/window, active state and `pinned:
   false`, plus focused/visible document and matching raw page target.
2. Arm real `chrome.tabs.onRemoved` and raw `Target.targetDestroyed` observers.
3. Read the existing Xvfb PID using `readExpectedXvfbPid(process.env.DISPLAY)`.
   Call `probeNativeCloseTarget({ display, xvfbPid, chromePid, nonce })`, using the
   exact `browser.process().pid`. `windowTitle` is optional during this read-only
   probe. The probe discovers the exact native ancestor title by nonce and PID;
   no Chrome suffix is assumed. Save `probe.evidence` in the CI report.
4. Recheck the intended tab and document without bringing another page forward.
   Call `sendOneNativeClose(probe)` exactly once. Save its JSON or
   `error.nativeCloseEvidence`; retain `nativeCloseUncertain` and stderr on
   transport failure. A consumed probe cannot be sent again.
5. Independently require exactly the intended tab/target closure, no unrelated
   closure, unchanged saved Favorite/source/icon, and real UI reopening into a
   distinct unpinned native tab. The helper never claims those browser outcomes.

The helper requires the existing local screen-0 Xvfb display, matching lock PID,
non-root same-user Xvfb/Chrome processes, exact installed executable paths and
process comm/start identities, libX11/libXtst, and XTEST. The foreground X window
must have exactly one matching ancestor. Both probe and send reject held keys,
modifier locks/latches, nonzero keyboard groups or held pointer buttons. Mapping
checks require distinct valid `Control_L`/`w` keycodes, neutral keysyms, Control
modifier membership and a non-modifier `w`.

Send rechecks the exact title, focus ancestry, process identity and key mapping,
then queues only `Control_L down`, `w down`, `w up`, `Control_L up`, all with zero
XTEST delay. It flushes/synchronizes and requires a neutral final keyboard. Xlib
protocol errors are captured; XFlush/XSync return integers are recorded without
pretending they are documented success statuses. Failure cleanup sends releases
only for keys whose down was attempted. There are no key-down retries, tab API
fallbacks, focus changes, installs or security-setting changes. A disconnected X
server, forcibly killed helper or missing output is an uncertain failed action,
never permission to retry.

This is native XTEST input on a disposable CI display, not physical hardware
input. Browser accelerator behavior needs the separate real closure assertions.

## Checks without a browser

- `node --test tests/unit/paired-chrome-native-close.test.js` runs the Node wrapper
  tests and Python fake-library tests. It is also included by `npm run test:unit`.
- `PYTHONDONTWRITEBYTECODE=1 python3 tests/unit/paired_chrome_native_close_test.py`
  runs the Python injected host/native/ctypes-level checks directly.
- `node --check scripts/paired-chrome-native-close.mjs` checks wrapper syntax.

Do not invoke the real helper locally. Actual native input remains unverified
until the dedicated GitHub Actions fixture runs it and proves browser outcomes.

## API references

- [XTEST library](https://www.x.org/releases/X11R7.5/doc/man/man3/XTestFakeKeyEvent.3.html)
- [Xlib reference](https://www.x.org/releases/X11R7.5/doc/libX11/libX11.html)
- [XKB library](https://www.x.org/releases/current/doc/libX11/XKB/xkblib.html)

## Ordinary-Favorites browser scenario

`scripts/paired-chrome-ordinary-favorites.mjs` exports a localhost response
handler and a standalone scenario. Main must register
`serveOrdinaryFavoriteFixture` before its generic response, and pass its real
browser/pages, existing input/screenshot/snapshot helpers, plus strict
`reloadArcify` and `reloadSpotlight` callbacks. Each callback must complete the
existing raw-target destruction/replacement and old-view invalidation checks and
return `{ evidence, arcifyOptions, spotlightOptions }`. The scenario does not
launch a browser or invoke an extension reload itself.

The scenario checks prospective real-options opt-in, preservation of an existing
legacy pin, the one native close, exact saved record/icon/source preservation,
real-click reopening into one distinct ordinary tab, reuse across two Spaces
with group sync off/on, paired Spotlight reuse, and both witnessed same-browser
extension reloads. Independent pure validators reject extra native closures,
wrong bindings, Space/group ownership, duplicate tabs/rows and invalid witness
receipts. All native/runtime assertions remain CI-only and unexecuted locally.

On success it restores default ordinary mode and the original group-sync/Space
selection, closes only its dedicated sidebar fixture surfaces, and returns
`restartFixture: { favoriteId, tabId }`. That exact ordinary Favorite remains
open for main's final full-browser restart no-adoption checks. On failure it
preserves the original error and evidence, removes observation listeners, and
never closes/retries the ordinary target as recovery.
