// Proposal only: project existing inputs, with no browser operations or result authority.
const tri = value => value === true ? 'pass' : value === false ? 'fail' : 'unknown';
const all = (...values) => values.includes(false) ? false : values.every(x => x === true) ? true : undefined;
const bool = value => typeof value === 'boolean' ? value : undefined;
const neg = value => typeof value === 'boolean' ? !value : undefined;
const eq = (a,b) => a == null || b == null ? undefined : a === b;
const numberTest = (value,f) => Number.isFinite(value) ? f(value) : undefined;
const hasRow = value => value === null ? false : value && typeof value === 'object' ? true : undefined;
export function projectPassiveScrollGates({
    before, after, event, view, quietMs, repainted, scrollReveal, unexpectedInput,
    eventCursorValid, eventTimestampConsistent, ambiguousPreEventInput
} = {}) {
    const a=before, b=after;
    return Object.freeze({
        eventSuppliedUrl: tri(bool(event?.eventUrlKnown)),
        samePostQuietExactUrl: tri(bool(event?.exactSettledUrl)),
        oneCreate: tri(numberTest(event?.created,n=>n===1)),
        exactInactiveB: tri(all(bool(event?.exactWindowB),neg(event?.active))),
        postEventCursor: tri(all(bool(eventCursorValid),bool(eventTimestampConsistent))),
        preEventTraceClean: tri(neg(ambiguousPreEventInput)),
        postEventRepaint: tri(bool(repainted)),
        settleQuiet: tri(numberTest(quietMs,n=>n>=500)),
        nativePanel: tri(bool(view?.nativePanel)),
        foregroundEndpoints: tri(bool(view?.sameForeground)),
        foregroundNoExcursion: tri(bool(view?.noForegroundExcursion)),
        sameActiveTab: tri(all(bool(view?.sameActiveTab),eq(a?.activeTabId,b?.activeTabId))),
        sameSpace: tri(bool(view?.sameSpace)),
        sameRemainingTabs: tri(bool(view?.noOtherCreates)),
        inputClean: tri(neg(unexpectedInput)),
        visibleSamePanel: tri(all(eq(a?.panel?.visibility,'visible'),eq(b?.panel?.visibility,'visible'),
            eq(a?.panel?.width,b?.panel?.width),eq(a?.panel?.height,b?.panel?.height))),
        sameAnchor: tri(eq(a?.anchorId,b?.anchorId)),
        beforeAnchorVisible: tri(bool(a?.anchorVisible)),
        beforeActiveOffscreen: tri(neg(a?.activeVisible)),
        beforeActuallyScrolled: tri(numberTest(a?.scrollTop,n=>n>0)),
        sameScrollExtent: tri(Number.isFinite(a?.maxScroll) && Number.isFinite(b?.maxScroll) ? a.maxScroll===b.maxScroll : undefined),
        measurementRowsPresent: tri(all(hasRow(a?.active),hasRow(b?.active),hasRow(b?.anchor))),
        geometryFinite: tri(all(...[a?.scrollTop,b?.scrollTop,a?.anchorOffset,b?.anchorOffset,a?.maxScroll,b?.maxScroll]
            .map(n=>n==null?undefined:Number.isFinite(n)))),
        afterActiveVisible: tri(bool(b?.activeVisible)),
        afterAnchorVisible: tri(bool(b?.anchorVisible)),
        traceActiveReveal: tri(bool(scrollReveal))
    });
}
