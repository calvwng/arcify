# EVOO source reconciliation, October 29, 2026

This isolated working copy reconciles the manually accepted EVOO sources with
the existing draft pull requests. It is not a release or a claim that remote CI
has tested these changes. No installed extension or normal checkout was changed.

## Source provenance

- Arcify starts at PR #75 head `0995d9a817114b1ba3c17db20c93fd9779149e4e`.
  The complete accepted `selected-close-fix-v2/arcify` manifest is applied,
  including its saved-row-refresh and menu/Delete selection-anchor lineage.
- Spotlight starts at PR #1 head `3b0b178f2c11b3add351c430a1e7734f54f25c8f`.
  The complete accepted `recovery-routing-candidate-v1/spotlight` manifest is
  recorded in published connector commit `56cf43b1f773eab0e7d82d0645b9a48927e05616`.
  This commit provides an exact companion identity for the paired workflow.
- Remote-only editor/planning files remain. Dependency churn, caches and four
  root audit/reproduction files are excluded from the source reconciliation.
- The three incident/deferred-research documents are incorporated separately.
  Original source/test links in the latency postmortem now resolve here;
  historical artifact links still require the retained EVOO audit directories.

The actual PR commits were fetched into separate local repositories before
applying the source manifests. This establishes Git ancestry independently of
the accepted build hashes. Normal checkout edits were not replayed over newer
accepted implementations or removed.

## Artifact comparison

The installed accepted Arcify inventory is
`860426c11095e6b474c4dab569fa63d53a8c58d7e88e46b755299f76621eb388` (53 files).
The installed Spotlight inventory is
`735a36ac9b00c1e415ddc641211464dae852ee28237e08b176d68dc21ddae8fa` (84 files).
Local clean-lockfile builds reproduce all 84 Spotlight files and all 52 Arcify
files other than packaged README.md. That README differs because this
reconciliation adds documentation links and repairs a control character.
There is no runtime bundle difference in this comparison.

## Validation and publication boundary

Run Arcify's full unit suite, Spotlight coverage, and
`node scripts/check-spotlight-pair.mjs ../spotlight` against these exact working
copies. The last is real client/provider/store code with mocked browser APIs;
it does not prove native browser transport or sidebar hosting. Its window mock
now implements getAll for the accepted shared-Today snapshot projection.
Node 25 requires `NODE_OPTIONS=--no-experimental-webstorage` for Spotlight's
jsdom localStorage fixture; use the project CI Node version for remote checks.

Final local results: Arcify 8,183 passes and four skips; Spotlight 2,557 passes
in 85 files with coverage (89.19% statements, 86.81% branches, 88.98% functions,
90.74% lines). Both builds and the mocked pair contract passed. The first
Spotlight run had 58 Node/jsdom localStorage failures and one asynchronous
scope-read failure; the corrected-environment full run and separate five-test
event suite passed. The latter's initial failure is retained as a stability
caveat, not attributed conclusively to the storage issue. Historical Arcify
whitespace warnings in seven accepted-source files remain; no runtime source
was reformatted solely to remove them.

All paired workflow checkouts and runner pins now target the published Spotlight
commit above, including Little Arc. Publication must make that reviewed commit
available before dispatching remote CI. Do not dispatch against an unpublished
pin or substitute the earlier remote head: it lacks the accepted source overlay.

The full native paired runner explicitly requires its dedicated GitHub Actions
job and Linux namespace sandbox checks. It was not run on EVOO, and its gate was
not bypassed. After publication approval, publish Spotlight first, then Arcify's
reviewed reconciliation, run the full paired scopes and standard CI, and update
both draft PR descriptions with the exact tested pair and results. Merge/release
requires a separate decision. Historical green checks and manual acceptance do
not substitute for that final exact-pair qualification.

Native Ctrl+W remains deferred. Menu/Delete closing and faster Today appearance
have qualitative user acceptance; this does not guarantee every browser restart,
focus, multiwindow, native Split, drag, or restoration case.

Publication provenance: connector commit 56cf43b1f773eab0e7d82d0645b9a48927e05616 has the identical tree 3ccbc744ade87369de0df0fa1092931b6bad07b2 as local commit bf62fe9a871b73bd4ffd991fdc1f7049f57a87f3. Commit metadata differs; source content and parent are verified. Native CI remains pending.
