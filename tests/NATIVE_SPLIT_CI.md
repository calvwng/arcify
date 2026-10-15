# Native Today Split View CI

The mandatory `native-split` job uses the existing installed `channel: chrome`, the
isolated locked driver, and the unchanged installed-package/process/namespace,
PID, network and seccomp sandbox checks. It adds no browser flags, permissions,
dependencies, downloads, package updates or host-policy changes. Missing
`chrome.tabs.createSplit` or `chrome.tabs.unsplit`, or Chrome older than 155, fails
the positive job. Unsupported capability belongs in separate pure unit tests.

The existing full 39 cases and fresh-profile Favorite lifecycle 5 cases remain
mandatory, with their original order and assertions. The supplemental job uses
setup cases 0–2 plus distinct case 39; its four-case pass is never a full-suite pass.

The positive fixture creates six disposable localhost pages, including two
same-URL pages with distinct document nonces. It preserves every exact native ID
and URL, plus the original five top-level documents and their typed inputs. Real mouse drag onto the labeled Today
Split View target must emit one trusted native drag and create exactly the two
requested `splitViewId` members. Nonadjacent input may relocate only the later
native tab beside the earlier one, with matching canonical Today order.

An X11 read-only screenshot captures the exact nonce-titled Chrome window after
verifying Chrome/Xvfb process identities. Both independent colored page panes
must be painted side by side in the same native window. This is not an iframe,
sidebar-only screenshot, mocked split ID or a claim about Helium.

The fixture also requires real context/Shift+F10/Enter create/end paths, both
original pages remaining open after unsplit, exact pair continuity during Space
switches, explicit group-sync deferral without coercing split members, real grouping and
collapse of a separately seeded unaffected Space in the same window, and
rejected incompatible-group drops without ordinary reorder fallthrough.

Do not run the browser fixture locally. Pure checks are safe:

- `node --test tests/unit/paired-chrome-native-split.test.js tests/unit/paired-chrome-run-plan.test.js`
- `python3 tests/unit/paired_chrome_native_split_capture_test.py`
- `npm run test:unit`
- `npm test --prefix scripts/paired-chrome-runtime`

The positive real-Chrome result exists only after the exact head's CI job passes.
