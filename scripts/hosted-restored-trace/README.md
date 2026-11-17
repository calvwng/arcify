# Isolated hosted restored-match trace

Dedicated push workflow: `diagnostic/restored-match-trace-20261117` only. No PR/main/EVOO operation is part of this fixture. Existing installed Chrome, original namespace/PID/network/seccomp checks and normal driver defaults are mandatory. No browser install, sandbox override or security-policy repair is attempted.

The QA build must match all 62 files in `expected-dist.sha256`, copied from the approved QA ZIP (SHA256 `922893c86651934d98d871909fcb89efa2ebdb228797d95f308f5a5eb8ab7a74`). The fixture reads the actual native SIDE_PANEL, not a sidebar.html tab, and never opens worker DevTools.

## Controls

1. Create three fixed loopback fixture documents and a genuine native two-pane split. Use the actual native sidebar Pin Split View menu.
2. Wait for the off-path saved hint, then deliberately remove only this fixture's strong session witness. This is **simulated same-session receipt loss**, never a cold-restoration claim. The original nonce and saved split key remain untouched.
3. Open the actual Attach picker without selecting any candidate. Require the collapsed QA disclosure, exact version marker, `same-or-invalid-session`, no badge, unchecked radios and disabled confirmation. Expand the disclosure for a screenshot, then click Cancel. Verify unchanged native tabs/active selection, persistent/session state and two visible Today rows.
4. With `ARCIFY_TRACE_COLD_RESTORE=1`, close/relaunch the same browser profile with normal `--restore-last-session`, keeping the loopback server alive. Never recreate missing tabs, rewrite storage/nonces, or relink. Synthetic URL documents and a fresh native panel must be observed. URL matching does not independently establish original pane continuity, and browser.close alone does not prove a clean on-disk session exit; both limitations are explicit in the report. A positive badge is required only when the genuinely restored key and observed readiness/session/inventory support that expectation. Other outcomes retain the diagnostic reason. Failure to restore documents or extension produces **inconclusive cold coverage**, not a positive. Assertions or failures once picker measurement begins fail the run.

`passed-same-session-scope` means only the mandatory negative control passed. Inspect the separate `cold.status` for cold evidence. `positive-hint-rendered` means the hint rendered for an observed same-key synthetic URL pair, not verified original-pane continuity or proof of a clean browser shutdown. This is native hosted Chromium evidence, not Helium/Windows acceptance or proof that numeric split IDs establish identity.

Local validation (no browser): `node --check scripts/hosted-restored-trace/run.mjs`; `node --test scripts/hosted-restored-trace/checks.test.mjs`; QA build + `verifyDist`. Browser execution is hosted-only and is not performed merely by importing the pure checks.
