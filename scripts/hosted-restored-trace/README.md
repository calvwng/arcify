# Isolated hosted restored-match trace

Dedicated push workflow: `diagnostic/restored-match-trace-20261117` only. No PR/main/EVOO operation is part of this fixture. Existing installed Chrome, original namespace/PID/network/seccomp checks and normal driver defaults are mandatory. No browser install, sandbox override or security-policy repair is attempted.

The QA build must match all 62 files in `expected-dist.sha256`, copied from the approved QA ZIP (SHA256 `922893c86651934d98d871909fcb89efa2ebdb228797d95f308f5a5eb8ab7a74`). The fixture reads the actual native SIDE_PANEL, not a sidebar.html tab, and never opens worker DevTools.

## Controls

1. Create three fixed loopback fixture documents and a genuine native two-pane split. Use the actual native sidebar Pin Split View menu.
2. Wait for the off-path saved hint, then deliberately remove only this fixture's strong session witness. This is **simulated same-session receipt loss**, never a cold-restoration claim. The original nonce and saved split key remain untouched.
3. Open the actual Attach picker without selecting any candidate. Require the collapsed QA disclosure, exact version marker, `same-or-invalid-session`, no badge, unchecked radios and disabled confirmation. Expand the disclosure for a screenshot, then click Cancel. Verify unchanged native tabs/active selection, persistent/session state and two visible Today rows.
4. In this disposable synthetic profile only, remove exactly `splitPinRestoredHintSessionV1`. Compare all observed tabs, native split membership, saved hint and other relevant session/local state to prove that nothing else changed. This is an **explicit simulated session boundary**, not a real browser restart. Open the same actual picker and require `suggested`, exactly one badge, unchecked radios and disabled confirmation. Expand only the disclosure, then Cancel; require unchanged native state/storage/Today again.

`passed-synthetic-negative-and-positive-controls` means both synthetic controls passed in the same actual native Chrome/sidebar/split. No browser relaunch is attempted. This does not test real cold restoration, unloaded panes, original-pane continuity, Helium/Windows acceptance, or prove that numeric split IDs establish identity. The earlier real-cold attempt could not reopen the CDP-installed extension after restart; this control intentionally does not bypass that behavior.

Local validation (no browser): `node --check scripts/hosted-restored-trace/run.mjs`; `node --test scripts/hosted-restored-trace/checks.test.mjs`; QA build + `verifyDist`. Browser execution is hosted-only and is not performed merely by importing the pure checks.
