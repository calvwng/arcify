# Little Arc native reload boundary

The hosted run at Arcify `f735701eeb885e126968b87f6c8dae2047a3a3b8`
proved both trusted launches and the first same-native-tab promotion after the
startup ordering correction. It then failed before orphan recovery: full
`chrome.runtime.reload()` closed the original extension controller tab. Both
the raw target-destroyed event and the subsequent native-tab query establish
its absence; a new driver handle cannot recover a native tab that no longer exists.

Chromium closes ordinary extension tabs on extension unload when other tabs
remain in their window. Chrome also clears `storage.session` on extension
reload. This is different from restarting only the extension service worker.
Sources: [Chromium unload handling](https://chromium.googlesource.com/experimental/chromium/src/+/refs/heads/main/chrome/browser/extensions/extension_browser_window_helper.cc),
[Chrome session storage lifecycle](https://developer.chrome.com/docs/extensions/reference/api/storage#storage-areas).

## Approved test-only correction

Case 55 now explicitly tests **missing-controller reload fallback**, not recovery
with a surviving controller. Its preceding cancellation, trusted click/Enter
launches, exclusion and same-tab/document/form promotion assertions remain.
The full extension reload occurs exactly once. The corrected scenario requires:

- The original controller native ID is absent, with no replacement controller
  marker, registry record or old bridge receipt. No controller is recreated,
  rebound by URL, reloaded or selected for recovery.
- Both original equal-URL HTTP tab IDs remain in their original native window,
  retaining independent server document nonces, time origins, node references,
  and typed unsaved form state. Neither page is cloned, moved, closed or reloaded.
- Each surviving ID independently becomes ordinary Today membership exactly
  once, with matching durable ownership and a real window-scoped bridge snapshot.
  This verifies the already-approved missing-marker boundary, not new product behavior.
- Unrelated saved bookmarks/Favorites/archive/pin bindings, existing ownership,
  and window B remain unchanged. The expected controller/options retirement is
  distinguished from unexpected native mutation. Extra or missing tabs fail.

Native tab/window/group/bookmark listeners live in the unchanged Spotlight
options document, not in Arcify's invalidated document. Capture begins before
reload and continues through final fresh state inspection. Runtime ID, native
peer ID/window, document identity, time origin, listener integrity and bounded
capture are checked before and after. Missing/reset/overflowed capture fails.
This proves native effects, not complete silence of Arcify's internal transport.
The scenario issues no recovery or promotion input after reload.

## Exact onboarding cleanup

An unpacked reload fires the update installation event. The existing background
handler opens onboarding when the saved onboarding version differs from the
manifest version. [Chrome documents this unpacked update behavior](https://developer.chrome.com/docs/extensions/reference/api/runtime#unpacked-extension-behavior).

If that actual pre-reload version condition holds, cleanup ownership requires
no preexisting onboarding tab, exactly one native creation in the reload event
interval, its exact new ID and window, and a matching live extension runtime,
URL, time origin and Chrome document ID. Attribution is passive corroboration
of the known source branch, not an API-caller trace. Its native/document identity
is checked again before one exact removal. No URL sweep, arbitrary-extra
allowlist or final leak-check exception is introduced. If version is already
current, no onboarding creation is accepted.

## Coverage deliberately not claimed

The report always lists these cases with `status: not-run` and
`nativeValidated: false`, outside the executed case count:

- Intact-controller same-window orphan recovery.
- Abandonment of an orphan recovery choice.
- Stale orphan selection rejection.
- Explicit duplicate-ID recovery without movement.
- Chosen-only promotion after orphan recovery.

Their unit assertions remain, but unit fixtures are not native evidence. A green
corrected case must not be described as full recovery acceptance. Real browser
restore with an intact marker needs a separate supported scenario; native IDs
and documents may change across browser restart. Worker restart is not a substitute.

No production runtime, extension permissions, companion pin, installation,
sandbox, workflow selection or legacy case ordering changes are part of this
correction. Only the dedicated hosted job may launch Chrome. Local validation is
source parsing, unit tests and production build; it does not establish native acceptance.
