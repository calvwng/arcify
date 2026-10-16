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
The updater records the received archive's SHA256, stages an exclusive copy under
APT's exact `package_version_arch.deb` basename in the isolated archive cache, and
verifies the staged bytes/metadata against the download. It checks that same cached
file again immediately before installation. Two apt simulations may plan only
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

### Verified transport and archive-path correction

[Head fef648a](https://github.com/calvwng/arcify/actions/runs/38727088293/job/116395518568)
received the exact Google HTTPS URL with HTTP 200 and successful TLS verification,
validated Chrome `155.0.8059.79-1` amd64, and produced two Chrome-only plans.
Installation then stopped before unpack because `--no-download` left APT's internal
archive basename relative when its canonical cache file was absent. This was not a
signature, permission, sandbox or vendor-download failure.

[APT's archive constructor](https://github.com/Debian/apt/blob/2.7.14/apt-pkg/acquire-item.cc#L3274-L3320)
derives `package_version_arch.deb` and resolves it to an absolute completed local
archive when that file already exists in `Dir::Cache::Archives` with the expected
size. The updater now stages and SHA256/metadata-checks that exact cache file before
both plans and installation. `--no-download`, the empty repository inputs, Chrome-only
plan, and every existing provenance/security guard remain in force. Pure tests
verify staging, stale-cache rejection and tampered-copy rejection without executing
apt. The later live installation result below verifies that corrected archive path.

### Verified official-package installation and namespace sandbox

[Head 279d112](https://github.com/calvwng/arcify/actions/runs/38728520703/job/116400220718)
passed the official HTTPS updater and installed Chrome `155.0.8059.79-1` from the
validated cached archive. Its subsequent real Chrome `155.0.8059.79` process passed
the installed-package checks and reported Namespace, PID/network namespaces and
Seccomp-BPF sandboxing. The vendor package refreshed its existing root-owned key
file from mode `0777` to `0644`; no manual permission repair, new trust/source or
AppArmor policy change was made. SHA256 remains a received-byte/change-detection
receipt, not independent repository-signature authentication. That run later
failed the keyboard End case, so it proves installation and sandboxing, not a
complete native Split pass. The full native fixture still requires an exact-head
CI pass, including its final incompatible-group rejection case.

### Preserved signed-source failure history

The earlier signed-apt route in `paired-chrome-native-split-update.mjs` correctly
[stopped before apt on head cc97e92](https://github.com/calvwng/arcify/actions/runs/38724660703/job/116387416227)
because `/usr/share` was writable. This matches the [official image configuration](https://github.com/actions/runner-images/blob/5ebd98a1ebebec7fe09538a221405e85ee4f42ff/images/ubuntu/scripts/build/configure-system.sh),
which makes that tree recursively writable. Its trusted-keyring guard remains
unchanged, and the workflow no longer selects that route. The new HTTPS updater
never catches that guard's failure or silently retries around it; it is a separate,
explicitly authorized provenance choice. No host permissions or key trust were
changed to make the signed-source route pass.

The full 43 cases (the original 39 plus two Today Move and two Today creation-order cases) and fresh-profile
Favorite lifecycle 5 cases remain mandatory, with their original order and
assertions. The supplemental job uses
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
The incompatible-group setup explicitly creates the group in the sidebar's native
window, rather than the API caller's default window. Before any selection or drag,
it records raw before/after state and requires both original pages to remain
ordinary unsplit Today tabs in the same exact Space/window, with distinct native
groups and unchanged documents/inputs. The rejection itself must still preserve
all native tab state and canonical Today membership/order.

Do not run the browser fixture locally. Pure checks are safe:

- `node --test tests/unit/paired-chrome-native-split.test.js tests/unit/paired-chrome-native-split-update.test.js tests/unit/paired-chrome-native-split-vendor-update.test.js tests/unit/paired-chrome-run-plan.test.js`
- `python3 tests/unit/paired_chrome_native_split_capture_test.py`
- `npm run test:unit`
- `npm test --prefix scripts/paired-chrome-runtime`

The positive real-Chrome result exists only after the exact head's CI job passes.
