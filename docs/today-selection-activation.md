# Today selection and delayed activation

A native activation event can first arrive after a newer Ctrl/Shift selection.
Capturing the selection interaction counter only at event delivery treats that
new selection as old and clears it before the Move menu captures its entries.

The sidebar now captures the Today selection fence at its initiating plain-row
click or Space-switch request, before asynchronous preparation. One exact
tab/window activation can consume that fence. Newer selection gestures survive;
an unchanged prior selection still clears. Bookmark selection behavior is unchanged.

Chrome supplies no activation request ID. This is bounded correlation, not
perfect native-event attribution. It requires an inactive exact tab, current
Space/window, and an unsuperseded request. The intent is single-use and expires
one second after the initiating gesture. Blur, hiding, removal, request failure,
or an intervening same-window activation invalidates it. An already-active no-op
cannot claim a later event. Events outside these bounds use the existing clearing
behavior, including events delayed beyond the lifetime. No native events are
suppressed and no Move ownership/selection validation is weakened.

Request validity is separate from correlation expiry: an expired correlation
does not cancel a still-current activation, but a superseded request or context
change during its tab read prevents the stale native call and DOM activation.

Regression coverage includes actual sidebar Space switching with a held native
activation, first event delivery after fresh selection, ordinary row activation,
external activation, held reads overtaken by another Space, no-ops, failure,
blur, menu capture, rerenders, and two-tab round trips through an empty Space.
