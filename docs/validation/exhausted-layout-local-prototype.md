# Local final-cohort exhaustion prototype

Not published, installed, or browser-tested. Exact base1235c4e4c0e9b5c93596c468d0763e1c7c815ff3.

The old initialization path can make an observed-closed contextSubset empty. The prior d5b1973 capture returned that unreadable checkpoint; current production final validation correctly refuses it. Hosted cleanup attribution remains unproven; a subsequent same-production broad run passed49/49.

This candidate preserves the final committed cohort byte-for-byte, adds fingerprint-covered v4 terminal evidence from exact committed snapshot/current witness and epoch-bound individual-close observations, and validates/fences/readbacks the canonical commit. It neither deletes history nor weakens the nonempty signature validator. Unknown/invalid formats are rejected before new SpaceStore recovery entrypoint writes. Old binaries are NOT made rollback-safe; v4 requires compatible code or separately verified deliberate restoration.

Terminal records retain negative graph and legacy snapshot suppression. Unproven same-URL candidates are conservatively quarantined, including against sibling automatic layout plans and cosmetic group projection; this does not assert identity. Exact independent ownership can release refusal. A cold/new same-URL tab may need an explicit Move. Proven-context repair declines v4 until independently extended, rather than dropping terminal metadata. Missing close proof preserves valid history and defers, not a claim of durable closure.

IMPORTANT BOUND: existing partial-close capture shrinks a cohort. This prototype protects only slots still present in the final committed cohort. Earlier removed URLs are not retroactively recovered or terminally protected. A two-slot sequential-close characterization proves that limitation. Persisted partial-close receipts/survivor succession would be a separate design expansion, not hidden in this fix.

Targeted synthetic tests cover final close, missing/shutdown evidence, exact witness/epoch refusal, committed/native races, event invalidation/listener cleanup, valid schema/fingerprint rejection, history preservation, quarantine and explicit ownership release, ancestor blocking, readback/write failures, cold restart, and the sequential scope limitation. Native/browser actions are forbidden by spies. Full independent review and broader validation are pending.

Review follow-up: v4 diagnostics return `incomplete` until a future diagnostic schema can describe terminal refusals accurately. This deliberately loses detailed v4 counts rather than report false passing guards. Close receipts are invalidated synchronously on intervening create/update/replace/move/attach/detach/removal lifecycle events. Fence observations detect events during awaited validation reads and detach on all exits; this is not a cross-API atomic compare-and-swap or proof against every post-submission native event.
