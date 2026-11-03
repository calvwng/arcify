# Little Arc source dimming settings

The trusted Little Arc control tab includes Source page dimming under Little Arc settings. The checkbox and 15–90% slider are drafts. The decorative sample previews only these controls; it never changes an originating page. Save commits the draft for future launches. Cancel and Refresh read the current saved settings, including changes made in another controller.

Spotlight remains the sole preference owner: `littleArcDimSource` and `littleArcDimStrength`. An absent strength defaults to 55%; an absent enabled preference remains false. Opening settings never enables dimming. Unsupported, unpaired or older companions disable editing with an update/pairing message. An unconfirmed Save is never retried automatically; editing remains disabled until an explicit read resolves the current preference.

The version-1 cosmetic preferences request carries a UUID and exact expected/new preferences. Arcify admits only its current ready, top-level controller document, verifies browser-owned tab/window/context identity and captures pairing generation. Spotlight serializes compare-and-set requests. Immediately before committing, it asks Arcify for a one-use authorization bound to the exact pending payload. Arcify rechecks controller identity and pairing; navigation, detachment, removal, pairing changes, timeout and disposal revoke pending authority. No controller token is sent to Spotlight and this protocol grants no launch or geometry authority.

The final authorization and storage dispatch cannot form an atomic transaction across extensions. A failure after dispatch therefore reports an uncertain result and requires a fresh read, rather than replaying Save. Existing source-focus cleanup remains independent; changing this preference cannot re-dim an already-cleared source page.

The existing header settings action and `window-size` routing identifier remain compatible. Window-size Preview/Save/Cancel retain their separate transaction and controls. No new permissions are required.
