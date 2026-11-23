// Future test-only classifier; no browser or product access.
const known=(value)=>typeof value==='boolean'?value:null;
// A direct trace has no envelope; omitting options declares an untruncated trace.
export function classifyMeasuredPointer(events,{overflow=false}={}) {
    if (!Array.isArray(events)) return {accepted:false,reason:'missing-ledger'};
    if (overflow !== false) return {accepted:false,reason:'overflow'};
    // The recorder subscribes to pointerdown/up/cancel, click, contextmenu,
    // auxclick and keydown. Movement is deliberately out of scope.
    // for...of also visits holes in a sparse array.
    for (const event of events) {
        if (!event || typeof event !== 'object' || Array.isArray(event) ||
            typeof event.type !== 'string') return {accepted:false,reason:'malformed-event'};
    }
    if (events.length!==3 || events[0].type!=='pointerdown' ||
        events[1].type!=='pointerup' || events[2].type!=='click')
        return {accepted:false,reason:'wrong-sequence'};
    const [down,up,click]=events;
    if(!events.every(e=>e.trusted===true&&e.exactArmedRow===true&&
        e.visible===true&&e.button===0))return {accepted:false,reason:'event-provenance'};
    if(![down,up].every(e=>e.pointerInterface===true&&e.mouse===true&&e.primary===true)||
        down.pointerIdKnown!==true||up.samePointerAsDown!==true||
        down.buttons!==1||up.buttons!==0)
        return {accepted:false,reason:'mouse-provenance'};
    if(click.focused!==true||click.buttons!==0||click.detail!==1)
        return {accepted:false,reason:'activation-click'};
    return {accepted:true,reason:'complete'};
}
const nativeKeys=['samePartition','sameOrderedPair','sameDurablePinAndSpace','sameTodayMembership',
    'sameExactFocusReceipt','noStrongReceipt','oneActiveTabAndItIsLeft','owningWindowStillFocused','noWindowSwitch'];
export function preservePostState(native={},trace=[],options={}) {
    // null = unobserved, distinct from observed mismatch. Compute this
    // rail independently before evaluating the input ledger.
    const nativeEvidence=Object.fromEntries(nativeKeys.map(k=>[k,known(native?.[k])]));
    return {native:nativeEvidence,input:classifyMeasuredPointer(trace,options),
        nativeAccepted:nativeKeys.every(k=>nativeEvidence[k]===true)};
}

// Accept only read outcomes, not an active reader. A caller can use
// Promise.allSettled after its quiet window and persist this result before gating.
export function preserveSettledPostState({native,input}={}) {
    const nativeRead=native?.status==='fulfilled'?'fulfilled':native?.status==='rejected'?'rejected':'unobserved';
    const inputRead=input?.status==='fulfilled'?'fulfilled':input?.status==='rejected'?'rejected':'unobserved';
    const receipt=inputRead==='fulfilled'?input.value:null;
    return {...preservePostState(nativeRead==='fulfilled'?native.value:null,receipt?.events??null,
            {overflow:receipt?.overflow!==false}),
        reads:{native:nativeRead,input:inputRead}};
}
