# Native Today Split View CI

The mandatory `native-split` job uses installed `channel: chrome`, the isolated
locked driver, and the unchanged installed-package/process/namespace, PID, network
and seccomp sandbox checks. Its CI-only preparation leaves Chrome 155+ untouched.
If the image has older Chrome, it uses the explicitly selected official HTTPS
package route below. Other browser jobs keep their image's package. Missing
`chrome.tabs.createSplit` or `chrome.tabs.unsplit`, or Chrome older than 155, still
fails the positive job; unsupported capability belongs in separate pure unit tests.

## Explicit official HTTPS package route

The updater downloads only
`https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb`, the
same fixed Google URL used by the [official runner installer](https://github.com/actions/runner-images/blob/9bd788fe1d795e4faef89bb4925da555df4ccd3e/images/ubuntu/scripts/build/install-google-chrome.sh).
Google also documents [Debian/Ubuntu .deb installation](https://support.google.com/chrome/answer/95346?hl=en&co=GENIE.Platform%3DDesktop).
Normal system TLS certificate verification must succeed. Curl configuration files
are not loaded, redirects are never followed, and the receipt must show HTTP 200,
the exact effective URL, successful certificate verification, and the complete
local byte count. TLS trust/backend environment overrides stop preparation; proxy
routing is preserved. Downloads have explicit time/size limits and no alternate
host or retry fallback.

The package must identify exactly `google-chrome-stable`, amd64, version 155+.
The updater records the received archive's SHA256 and checks the same bytes and
metadata again immediately before installation. Two apt simulations may plan only
the existing Chrome upgrade; apt then installs that exact local file with
`--no-download`, no repository inputs, no new dependencies, no removals, no
held-package overrides and no downgrade. Missing integrity/metadata, old versions,
changed archives/plans, or command failures stop the job.

This route authenticates delivery from the official HTTPS endpoint. It does not
independently verify a repository/package signature. The computed SHA256 is a
receipt and local-change check, not an independently authenticated expected digest.
[APT repository authentication](https://manpages.debian.org/bookworm/apt/apt-secure.8.en.html)
provides a different signature/checksum chain; a local package install must not be
described as proof of that chain.

The runner's existing `repo_add_once=false` defaults and absent vendor source files
are required before and after installation, with no legacy global key to migrate.
The canonical modern vendor key file must already exist and remain a nonempty
root-owned regular file afterward. Its presence/metadata is recorded only to avoid
creating a new key location; its writable path is never treated as a signature
trust anchor.
The authenticated vendor's normal package maintainer scripts may refresh its
existing packaged key, files and cron entry. Preparation adds no signing key or
persistent apt source, changes no trust settings, and does not manually
install/repair a helper, alter permissions, or change AppArmor/sysctl policy.
The AppArmor profile hash, enablement and namespace restriction must remain
unchanged. The later fixture runs as the ordinary runner user, validates the exact
installed package and actual process, and requires real Namespace/PID/network/
seccomp evidence before installing extensions.

`chrome-update.json` and `chrome-update.log` are retained with the native artifact.
They record the selected route, source/TLS/download receipt, package metadata,
SHA256 meaning, command results, and before/after package/policy evidence. Pure local
tests mock downloads and package-manager commands; no local installation or browser
launch is part of validation. The exact-head CI job must still verify the live
vendor package, installation, sandbox and positive native API together.

### Preserved signed-source failure history

The earlier signed-apt route in `paired-chrome-native-split-update.mjs` correctly
[stopped before apt on head cc97e92](https://github.com/calvwng/arcify/actions/runs/38724660703/job/116387416227)
because `/usr/share` was writable. This matches the [official image configuration](https://github.com/actions/runner-images/blob/5ebd98a1ebebec7fe09538a221405e85ee4f42ff/images/ubuntu/scripts/build/configure-system.sh),
which makes that tree recursively writable. Its trusted-keyring guard remains
unchanged, and the workflow no longer selects that route. The new HTTPS updater
never catches that guard's failure or silently retries around it; it is a separate,
explicitly authorized provenance choice. No host permissions or key trust were
changed to make the signed-source route pass.

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

- `node --test tests/unit/paired-chrome-native-split.test.js tests/unit/paired-chrome-native-split-update.test.js tests/unit/paired-chrome-native-split-vendor-update.test.js tests/unit/paired-chrome-run-plan.test.js`
- `python3 tests/unit/paired_chrome_native_split_capture_test.py`
- `npm run test:unit`
- `npm test --prefix scripts/paired-chrome-runtime`

The positive real-Chrome result exists only after the exact head's CI job passes.
