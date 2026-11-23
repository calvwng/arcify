// Driver-neutral, test-only integration. Calls are supplied by a separately reviewed
// driver. No Chrome access, browser launch, writes, or dispatch in this module.
import { preserveSettledPostState } from './cold-passive-receipts.mjs';
import { assessNativeSamples } from './cold-native-samples.mjs';

const known = value => typeof value === 'boolean' ? value : null;
const status = outcome => ['fulfilled','rejected','timed-out'].includes(outcome?.status) ? outcome.status : 'unobserved';
const fulfilled = outcome => outcome?.status === 'fulfilled' ? outcome.value : null;

// Browser realm only; serializable callback with no imports. Arm only after
// real SIDE_PANEL hosting/exact picker receipt have been independently proved.
export function installMeasuredInputRecorder({selector, point, limit=12}) {
    const row=document.querySelector(selector);
    if (!row || !row.isConnected || document.querySelectorAll(selector).length!==1 ||
        globalThis.__coldMeasuredInputRecorder || !Number.isSafeInteger(limit) || limit<3 || limit>32)
        return false;
    if(point){
        if(!Number.isFinite(point.x)||!Number.isFinite(point.y))return false;
        const hit=document.elementFromPoint(point.x,point.y);
        if(!hit || hit.closest(selector)!==row || hit.closest('button'))return false;
    }
    const names=['pointerdown','pointerup','pointercancel','click','auxclick','contextmenu','keydown'];
    const records=[];
    let overflow=false, downPointerId=null, visibilityChanged=false, released=false;
    const hide=()=>{visibilityChanged=true;};
    const capture=event=>{
        if(records.length>=limit){overflow=true;return;}
        const target=event.target;
        const exactArmedRow=document.querySelectorAll(selector).length===1 &&
            document.querySelector(selector)===row && row.isConnected && row.dataset.splitBusy!=='true' &&
            target?.closest?.(selector)===row && !target.closest('button');
        const pointerInterface=typeof PointerEvent==='function' && event instanceof PointerEvent;
        const pointerIdKnown=pointerInterface && Number.isSafeInteger(event.pointerId) && event.pointerId>=0;
        if(event.type==='pointerdown'&&downPointerId===null&&pointerIdKnown)downPointerId=event.pointerId;
        records.push({type:event.type,exactArmedRow:Boolean(exactArmedRow),
            trusted:event.isTrusted===true,visible:document.visibilityState==='visible',
            focused:document.hasFocus(),pointerInterface,mouse:event.pointerType==='mouse',primary:event.isPrimary===true,
            pointerIdKnown,samePointerAsDown:pointerIdKnown&&downPointerId!==null&&event.pointerId===downPointerId,
            button:Number.isInteger(event.button)?event.button:null,buttons:Number.isInteger(event.buttons)?event.buttons:null,
            detail:Number.isInteger(event.detail)?event.detail:null});
    };
    function read(){return {events:records.map(record=>({...record})),overflow,visibilityChanged,
        documentVisible:document.visibilityState==='visible'};}
    function release(){
        if(released)return;
        released=true;
        for(const name of names)document.removeEventListener(name,capture,true);
        document.removeEventListener('visibilitychange',hide,true);
        window.removeEventListener('pagehide',hide,true);
        delete globalThis.__coldMeasuredInputRecorder;
    }
    for(const name of names)document.addEventListener(name,capture,true);
    document.addEventListener('visibilitychange',hide,true);
    window.addEventListener('pagehide',hide,true);
    globalThis.__coldMeasuredInputRecorder={read,release};
    return true;
}

export function projectColdEvidence({ pre, post, input, scope, link, quietElapsedMs, dispatchOutcome }={}) {
    const samples=assessNativeSamples({pre,post,link}), extra=fulfilled(scope), observedInput=fulfilled(input);
    // Scope is independent: retain native endpoint comparisons when it fails,
    // never grant a positive native verdict from absent scope/durable evidence.
    const rails=preserveSettledPostState({
        native:{status:'fulfilled',value:{
            samePartition:samples.sameFinalPartition,
            sameOrderedPair:samples.sameExactOrderedPair,
            sameDurablePinAndSpace:known(extra?.sameDurablePinAndSpace),
            sameTodayMembership:known(extra?.sameTodayMembership),
            sameExactFocusReceipt:known(extra?.sameExactFocusReceipt),
            noStrongReceipt:known(extra?.noStrongReceipt),
            oneActiveTabAndItIsLeft:samples.postSoleActiveLeft,
            owningWindowStillFocused:known(extra?.owningWindowStillFocused),
            noWindowSwitch:known(extra?.noWindowSwitch)
        }},
        input
    });
    const context={
        exactPanelBeforeAfter:known(extra?.exactPanelBeforeAfter),
        originalColdFixtureProven:known(extra?.originalColdFixtureProven),
        sameBrowserTabEndpoints:known(extra?.sameBrowserTabEndpoints),
        preNeutral:samples.preSoleActiveUnrelated,
        preExactLinkedPair:samples.preExactLinkedPair,postExactLinkedPair:samples.postExactLinkedPair,
        quiet:typeof quietElapsedMs==='number'&&Number.isFinite(quietElapsedMs)?quietElapsedMs>=7000:null,
        dispatch:dispatchOutcome==='sent'?true:dispatchOutcome==='uncertain'?null:false,
        visibilityStable:observedInput?.visibilityChanged===false&&observedInput?.documentVisible===true
            ? true : observedInput?.visibilityChanged===true||observedInput?.documentVisible===false?false:null
    };
    const notice=extra?.observedNotice;
    const ui={notice:['none','neutral-unconfirmed','pending','other','unchanged','unchanged-ambiguous'].includes(notice)?notice:null,
        pinCurrent:known(extra?.pinCurrent)};
    // Physical endpoint evidence is independent of application ownership,
    // advisory receipt outcome or any presentation. A valid strong receipt
    // conflicts with this experiment's focus-only contract, not native focus.
    const {sameBrowserTabEndpoints,...nativeContext}=context;
    const acceptedNativeEndpointFocus=rails.input.accepted===true && rails.native.samePartition===true &&
        rails.native.sameOrderedPair===true && rails.native.oneActiveTabAndItIsLeft===true &&
        rails.native.owningWindowStillFocused===true && rails.native.noWindowSwitch===true &&
        Object.values(nativeContext).every(x=>x===true);
    return {schema:1,trialSpent:true,reads:{pre:status(pre),post:status(post),input:status(input),scope:status(scope)},
        context,ui,confirmationBranch:'not-observed',
        pointer:rails.input, native:rails.native,
        noIntermediateTabChurn:samples.noIntermediateTabChurn,acceptedNativeEndpointFocus,
        acceptedAdvisoryFocusOnly:acceptedNativeEndpointFocus && rails.nativeAccepted===true && sameBrowserTabEndpoints===true};
}

const bounded = (read,timeoutMs)=>{
    if(typeof read!=='function')return Promise.resolve({status:'unobserved'});
    let timer;
    return Promise.race([
        Promise.resolve().then(read).then(value=>({status:'fulfilled',value}),()=>({status:'rejected'})),
        new Promise(resolve=>{timer=setTimeout(()=>resolve({status:'timed-out'}),timeoutMs);})
    ]).finally(()=>clearTimeout(timer));
};

// Only call once, after sending/attempting the one dispatch and respecting
// the quiet interval. Does not assert success or replay anything if it fails.
export async function collectColdReceiptAfterQuiet({pre,readPost,readInput,readScope,link,quietElapsedMs,
    dispatchOutcome,writeReceipt,timeoutMs=3000}) {
    if(typeof writeReceipt!=='function'||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>5000)
        throw new TypeError('Review exact receipt writer and read bounds first.');
    if(!Number.isFinite(quietElapsedMs)||quietElapsedMs<7000)
        throw new RangeError('No read may occur during the seven-second quiet interval.');
    const [post,input,scope]=await Promise.all([bounded(readPost,timeoutMs),bounded(readInput,timeoutMs),bounded(readScope,timeoutMs)]);
    const evidence=projectColdEvidence({pre,post,input,scope,link,quietElapsedMs,dispatchOutcome});
    await writeReceipt(evidence);
    return evidence;
}

// Dispatch semantics only; a real tail calls this once after durable spent receipt.
export async function observeSingleColdDispatch({dispatch,wait,now,quietMs}) {
    if(!Number.isFinite(quietMs)||quietMs<7000||quietMs>10000)
        throw new RangeError('Invalid isolated observation window.');
    let dispatchOutcome='sent';
    try { await dispatch(); } catch { dispatchOutcome='uncertain'; }
    const from=now();
    await wait(quietMs);
    return {dispatchOutcome,quietElapsedMs:now()-from};
}
