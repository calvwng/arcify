# Candidate source-dimming focus lifecycle fixture

This fixture is based on Arcify `8e3ada6c6641aa2dab81233429efe3f51a060ae7`. The workflow now pins the published Spotlight candidate `3049c6757ba74dfd20e5383537bb2511fd70bd19` (source tree `7664c7c95e688b92a2198a68f4d4463a7ef31e99`). Native lifecycle qualification remains pending the exact-pair hosted run.

The original source-return/click-through and disabled-source assertions remain. Enabled 55% and 100% cases additionally focus an unrelated existing Little Arc window, select a newly owned sibling tab while the origin window is still unfocused, and then bring that sibling forward. Each state must retain the exact source overlay and document for at least 4.5 seconds, beyond the four-second offer lease. It returns to the unrelated window for another 4.5-second check. These observations require continued renewal; an unrenewed initial overlay cannot satisfy the duration.

The 100% case then closes the exact associated Little Arc page through its native target, while the unrelated window remains foreground. The source overlay must clear before origin focus. The owned sibling tab is removed with ID/window/URL checks. Final cleanup permits only the known surviving controller after this intentional target closure. The 55% case still requires a present overlay immediately before the original source-focus and checkbox click clears it.

All source reads and lease assertions are passive. The sibling tab is ordinary disposable fixture setup; selecting it with the native tab API before foregrounding prevents accidentally focusing the origin and legitimately dismissing the overlay. The fixture does not send product recovery or dimming messages, change clocks, or write dimming preferences behind the UI.

OS application focus, minimization and browser background timer throttling are not exercised. Those limitations remain even if a future hosted browser run passes. Deterministic focus-none and expiry cases belong to Spotlight's module tests. The exact-pair hosted run must pass before claiming native qualification.
