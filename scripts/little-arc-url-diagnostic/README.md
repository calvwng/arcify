# Little Arc URL diagnostic (not a product change)

This temporary branch runs only in calvwng/arcify on its exact diagnostic branch.
The hosted job uses fresh synthetic profiles and localhost pages. It does not
install or update the user's extensions, change product source, or visit YouTube.

Two exact Spotlight revisions are tested: 76559fbeaacc055ff7f987c0adf5b8b630820ada
(the deployment snapshot used during diagnosis) and
b8b193c1f803179f86ab2e2397e5f1169256f49d (the existing hosted Little Arc pin).
The complete shared directory is copied byte-for-byte and hashed before/after.
The diagnostic extension imports its unmodified peek-broker.js using real Chrome
APIs. A separate synthetic extension answers only the capability request; this
is not a full Arcify pairing or video-opening test.

The fixture observes the actual broker port's sender metadata, tab/frame URL and
document identity; sends hello only; records ready/error/disconnect; and repeats
after pushState, replaceState, reconnection and full refresh. URL and document
identity are observations, never manufactured inputs to the broker. The fixture
requires initial and refreshed handshakes to work, but does not assume whether
SPA sender metadata will be stale. All observed results are kept as JSON.

A stale sender URL with a matching current document and a rejected handshake
supports the proposed mechanism in hosted Chrome. It does not prove the cause
of Calvin's original Helium/YouTube occurrence. Successful current-URL reconnects
would weaken that hypothesis. Timing and capability requests are retained to
avoid assigning a generic error a more specific cause than the data supports.

No screenshots, cookies, user data, browser profiles or credentials are uploaded.
Artifacts contain synthetic observations, source hashes and test logs only.
The existing installed-Chrome sandbox checks remain mandatory; no weakening
flags, browser downloads, OS changes, or launch fallbacks are used.

## Candidate comparison

The candidate mode overlays only candidate/peek-broker.js into the disposable
probe extension, retaining and recording the original and candidate hashes.
The Spotlight checkout remains unchanged in browser-metadata jobs. The synthetic
content receiver uses the same isolated read-only URL response as production;
Chrome routes the request using both documentId and frameId. Every candidate
handshake must reach ready, including stale sender metadata after SPA navigation.
Old-document and wrong-frame routes must reject after refresh.

A separate disposable candidate-validation checkout applies the reviewed broker
and regression test, runs the full unit/integration suite and production build,
and confirms the packaged manifest is unchanged. This publishes a candidate only
inside the diagnostic branch for testing; no product branch, merge or installation
is performed.
