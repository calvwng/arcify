# Space emoji and icon-only input evidence

This extends mandatory full-suite case 37 in the paired Chrome fixture. It does
not add a quick-only mode, remove cases, renumber identities, or change sandbox
settings: the full suite now requires 49 cases (including the separate saved Move, theme, recovery and initial action additions), Favorite lifecycle 5, and
supplemental native Split View 4. All selected cases must pass exactly once.

The fixture lives in `scripts/paired-chrome-space-icon-input.mjs` and is called
by `scripts/paired-chrome-space-context.mjs`. Importing these modules or running
their unit validators does not launch a browser. Browser entry points require
non-root GitHub Actions with `CI=true`; run real acceptance only through the
existing paired-extension workflow against the combined implementation commit.

## Emoji input

The original preset allowlist, Save/Cancel, reload, second-window, inactive
Space identity, name/color/folder, safe Delete cancellation, screenshot and
focus checks remain. The dialog's genuine Tab loop now passes through Emoji,
Save emoji, and No icon before the existing presets, and wraps both ways.

Additional actions use Chrome keyboard/text input or genuine Ctrl+V. The
clipboard is the disposable CI runner’s OS clipboard, populated through the
extension's existing `clipboardWrite` permission. The fixture does not add a
clipboard-read permission, override permissions, assign input values, dispatch
synthetic events, or replay uncertain input.

Required examples include:

- Keyboard/text input: woman technologist with medium skin tone,
  `U+1F469 U+1F3FD U+200D U+1F4BB`, and modified thumbs-up.
- Clipboard paste: the two-regional-indicator UN flag, airplane with VS16,
  and a rainbow-flag ZWJ sequence surrounded by whitespace.
- A complete family ZWJ sequence is pasted and canceled without writing.
- Two separate emoji are rejected without truncating or saving; clearing that
  invalid draft and pressing Enter resets the saved icon to null.
- A custom ZWJ emoji survives reload, reopens unchanged, and supports button
  cancellation. A preset can then replace it.

Evidence includes the actual input value, saved code points, trusted
beforeinput/input/paste/key events, disabled/validation/accessible-help state,
required screenshots, restored focus, and exact before/after snapshots. A save
may change only the target Space's icon and matching registry entry. Cancel,
invalid submission, and reload must preserve the entire normalized snapshot.
The snapshot includes all Spaces, registry, Favorites, bindings, bookmarks,
window-scoped active Spaces, native tabs, and appearance settings.

## Icon-only switcher

The actual options checkbox is reached by Tab and toggled with Space. The test
requires the opt-in default to be false and permits only the
`sidebarAppearance.hideSpaceNames` field to change. It verifies both windows,
options reload, sidebar reload, explicit disable, re-enable, and the actual
Reset sidebar appearance button.

A custom ZWJ icon is saved before hiding names. Every chip must retain its exact
Space UUID, full name, full native-title text, accessible label, keyboard
shortcuts, draggable/focusable button semantics, and selected state. The fixture
also reads Chrome's accessibility tree for the exact buttons. Names become
visually hidden; custom/preset glyphs remain exact and iconless Spaces retain a
visible decorative dot. Visible targets stay 32 px wide and at least 32 px tall.
The Space headers keep their original names.

The test performs a native drag between adjacent icon-only chips, validates a
fresh accepted trusted dragover on the actual final button, captures the marker,
and checks its actual screenshot pixels before the single mouse release. It
requires trusted dragstart/drop/dragend and an exact order-only persisted
change. Alt+Shift+Right restores the original order and focus. Complete
cross-window projections are polled so a valid asynchronous refresh cannot be
mistaken for stale output.

The existing exact-target chip activation and visible header/folder/theme
screenshots then run while names are hidden. Activation permits only the target
Space, its remembered owned tab, and native active flags in that window to
change. The No icon reset is exercised while icon-only mode remains enabled,
including its fallback dot and reload. The final options reset restores names.

## Evidence limits and acceptance status

Local validator/source tests and a production build are not real-Chrome
acceptance. Hosted results must come from the final combined commit's full
49-case job; lifecycle and split jobs retain their independent obligations.
The report includes every required screenshot and exact-state observation, and
retains failures before cleanup. There are no arbitrary sleeps or synthetic
event substitutes in the new helper.

Chrome text insertion is trusted browser input, not proof of physical keyboard
hardware or an OS emoji picker. OS emoji panels, IME candidate windows, actual
composition ordering, and Helium remain manual checks. Product unit tests cover
composition guards separately; this fixture never synthesizes composition and
labels it as native evidence.

The icon-only implementation uses the browser's native `title` tooltip. The
fixture performs real hover and focus and verifies the exact retained title plus
Chrome accessibility name. Page screenshots do not capture browser-chrome
native tooltip pixels, so visible native tooltip painting remains manual.
The general sidebar fixture is a real extension page in a normal browser tab;
it does not claim native side-panel or OS-specific rendering acceptance.
