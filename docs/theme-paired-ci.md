# Theme and appearance: mandatory paired Chrome evidence

The full suite retains every previous 45 case and adds two mandatory cases,
46 (Arcify native Space theme) and 47 (Spotlight options appearance), before the
unchanged ordinary-Favorite and browser-restart ending. Recovery and initial
Spotlight action cases 48/49 now follow both theme cases. The full suite requires
49 passing cases exactly once in declared order. Independent Favorite lifecycle
and native Split View jobs still require 5 and 4 cases. The independent
[appearance/actions job](appearance-actions-paired-ci.md) requires 8 shared cases
on a fresh profile and never replaces those outcomes. Missing, failed, skipped,
incomplete or extra evidence fails the existing strict run-plan gates.

All four jobs and the runner pin Spotlight to reviewed, published commit
`dae17a24d4e3b90cecd42a19ceeb7322b755370b`. After verifying that exact checkout,
case 47 imports and executes its unchanged
`test/e2e/options-appearance-evidence.js`. Missing collector code is a failure.
The Arcify adapter adds only passive observation, required-artifact validation
and explicit fixture cleanup around the collector's real mouse/keyboard input.

## Arcify native panel

The existing native sidebar adapter opens the real panel through Spotlight and
requires its actual SIDE_PANEL context, source-window `onOpened` receipt,
224–420 px measured host, no ordinary sidebar tab, unchanged rendered identity
and required native viewport PNG dimensions. The fixture never resizes that
panel, injects DOM input/events, replaces style tokens or calls production theme
helpers to manufacture contrast evidence.

The case explicitly selects `fixture.spaces.work` in window A and enables native
group sync using the foreground Settings checkbox. Before and after every custom
tint or preset change it requires the exact UUID/window projection, one live
Chrome group in that window, live owned members in that same group, and a native
color enum equal to the Space and bridge-v1 color. An empty group list or stale
projection fails, even if identical before/after snapshots would otherwise pass.
Custom tints preserve that same group ID and named color; the purple preset must
change the actual projected group to purple while clearing the custom tint.

Required observations and screenshots cover:

- Real keyboard valid/invalid hex, Cancel, Escape, reset and named preset input
- Light/Dark extreme tints, readable menus, editors, active Favorite and selected Today rows
- Actual sRGB ancestor-background compositing and contrast checks
- Real held Space drag, visible insertion-marker pixels and trusted no-drop cancellation
- Whole emoji graphemes, cleared icon, long editable name and 12/16/20 px header alignment
- Foreground narrow Settings controls, validation notice, disabled range and keyboard outline
- Passive document-start mutation/first-contentful-paint evidence for both explicit Settings modes
- Live System media changes retaining the same mounted focused input and text selection
- Actual native-sidebar and Settings document reloads with durable tint/appearance evidence

The acceptance comparisons preserve all unrelated captured fields. Explicit
setup/cleanup owns nonce-scoped tabs/bookmark/Favorite data and restores the prior
sync setting, original native group IDs/colors/members/order, Space metadata,
active tabs/Spaces and focused window. It fails if an original group/tab has
vanished rather than recreating an identity. Remembered-tab hints changed by the
fixture's deliberate activations are restored through an exact store patch;
only absent versus explicit-null reset values are treated as equivalent in the
cleanup comparison. No full Space/store replacement repairs an acceptance result.

## Spotlight Settings

The reviewed collector requires System on light/dark media, explicit Light/Dark
overrides and reload persistence, a second open Settings page synchronized to
System, an invalid pairing-ID notice that retains unsaved text across appearance
changes, and 390 px mobile controls without horizontal overflow. The adapter
requires every reviewed state/check and all seven actual PNGs; it does not
substitute a text-only success. Every new document also carries passive early
mode and first-contentful-paint observations, including explicit overrides under
opposite media preference.

Pairing configuration/generation, Arcify appearance, existing native tabs,
groups, Space membership and focus are compared after the owned Settings pages
close and the original options preference is restored. Renderer exceptions,
crashed targets, window-B isolation and sandbox assertions remain mandatory.

## Artifacts and limits

The hosted artifact includes `report.json`, required Arcify theme PNGs, and
`spotlight-options-appearance/` with seven companion PNGs and its reviewed JSON
report. The main report retains passive paint records, native group proofs,
cleanup comparisons and failure checkpoints. Failure artifacts upload even if a
required assertion fails.

Local validation is limited to pure validators, mocked adapters, source contracts,
syntax checks and production builds. These checks are not browser acceptance;
the final combined commit still requires successful hosted 49/5/4/8 job results.
No browser, native helper, privileged installation, security flag or host-policy
change is used locally. Hosted Chrome keeps its normal namespace sandbox.

System changes are Chrome rendering-media emulation, not a physical OS setting
change. The OS color-picker dialog, hardware keyboard/IME, Helium, existing user
profiles and physical browser-chrome appearance remain manual. Theme reload
checks are document reloads; the existing separate lifecycle/restart cases keep
their independent obligations.
