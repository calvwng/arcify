# Native Today Split View CI

The mandatory `native-split` job uses installed `channel: chrome`, the isolated
locked driver, and the unchanged installed-package/process/namespace, PID, network
and seccomp sandbox checks. Its CI-only preparation leaves Chrome 155+ untouched.
If the runner image has older Chrome, it performs one bounded ordinary update of
`google-chrome-stable` from Google's signed stable repository. Other browser jobs
keep their image's package. Missing `chrome.tabs.createSplit` or `chrome.tabs.unsplit`,
or Chrome older than 155, still fails the positive job; no capability is skipped or
emulated. Unsupported capability belongs in separate pure unit tests.

## Bounded browser preparation

GitHub's [image installer](https://github.com/actions/runner-images/commit/9bd788fe1d795e4faef89bb4925da555df4ccd3e)
removes Chrome's apt source and retains `repo_add_once=false`; a global `apt upgrade`
cannot be assumed to provide Chrome. The preparation uses a temporary, vendor-only
source and fresh isolated apt lists/archive caches. The fixed HTTPS endpoint is
`https://dl.google.com/linux/chrome-stable/deb/`, as specified by the
[pinned vendor installer](https://github.com/chromium/chromium/blob/82de7cdaa0d37a8b1660727cce1165a9b8e06eaa/chrome/installer/linux/common/apt.include).
It requires the existing root-controlled, non-symlink keyring at
`/usr/share/keyrings/google-chrome.gpg` and scopes
`Signed-By` to Google's [published active primary fingerprint](https://www.google.com/linuxrepositories/)
`EB4C1BFD4F042F6DDDCCEC917721F63BD38B4796` and its signing subkeys.
The preinstalled defaults must contain `repo_add_once=false`, both vendor source
files must already be absent, and no legacy global key may remain to migrate.
Defaults and source/legacy-key absence must also match after the update. No key is
fetched/imported and no persistent source is added by the preparation.

Fresh metadata must pass apt signature verification. A candidate must be the exact
stable amd64 package at version 155+, and a simulation must change only the existing
Chrome package. The downloaded archive must match the signed index SHA256 and its
package/version/architecture before a second simulation and exact-version,
`--no-download` install. No dependencies, removals, held-package overrides, security
bypasses, alternate mirrors, channel fallback, or silent skips are permitted.
Missing/unsafe existing keys, an unavailable signed source, an old candidate, a
changed install plan, or any download/install failure stops the job.

This is an ordinary package-manager update, so the authenticated vendor's package
maintainer scripts execute as they normally do, including refreshing the vendor's
existing key, replacing packaged files, and restoring its packaged cron entry.
The existing key must still validate against the same Google fingerprint afterward.
It is not a claim that every package file remains byte-identical. The preparation does not manually install/repair a privileged
helper, change its permissions, import keys, or alter AppArmor/sysctl/host policy.
The existing AppArmor configuration hash, enablement and namespace restriction
must remain unchanged after the update. The later fixture still runs as the ordinary runner
user, checks the exact installed executable and actual process, and requires real
Namespace/PID/network/seccomp evidence before installing extensions.

`chrome-update.json` and `chrome-update.log` are retained in the native job artifact
on success or failure. They record the unchanged-package or update route, existing
key fingerprint/hash, source, exact candidate, signed archive SHA256, command
results, and before/after runtime evidence. Initial installed-package MD5
correspondence is not independent signature proof; the update's signature trust
comes from apt's fresh signed repository metadata. Local tests mock commands and
never install packages or launch Chrome. Only the exact-head CI run can establish
that the live vendor repository, update, sandbox, and native API all work together.

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

- `node --test tests/unit/paired-chrome-native-split.test.js tests/unit/paired-chrome-native-split-update.test.js tests/unit/paired-chrome-run-plan.test.js`
- `python3 tests/unit/paired_chrome_native_split_capture_test.py`
- `npm run test:unit`
- `npm test --prefix scripts/paired-chrome-runtime`

The positive real-Chrome result exists only after the exact head's CI job passes.
