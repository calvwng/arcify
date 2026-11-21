export const FOCUS_CONFIRMATION_DELAY_MS = 300;
export const FOCUS_CONFIRMATION_DEADLINE_MS = 1100;
const pending = new WeakMap(), intents = new WeakMap();
const keys = ['windowId','spaceId','bookmarkFolderId','bookmarkId'];
export function captureFocusConfirmationIntent(store) {
    const generation = intents.get(store);
    return () => intents.get(store) === generation;
}
export function invalidateFocusConfirmation(store) {
    intents.set(store,(intents.get(store)||0)+1);
    pending.get(store)?.close();
}
export function watchFocusConfirmation(store, request, target) {
    const activation=chrome.tabs.onActivated, focus=chrome.windows.onFocusChanged, storage=chrome.storage.onChanged;
    if ([activation,focus,storage].some(e=>!e?.addListener||!e.removeListener)) return null;
    const scope=Object.fromEntries(keys.map(k=>[k,request[k]]));
    const receiptKey=`${scope.windowId}:${scope.bookmarkId}`;
    let current=true, retained=false, consumed=false, timer, delayTimer, wake, expired;
    const stop=new Promise(resolve=>{expired=resolve;});
    const onActivation=info=>{if(info?.windowId===scope.windowId&&info.tabId!==target)close();};
    const onFocus=windowId=>{if(windowId!==scope.windowId)close();};
    const onStorage=(changes,area)=>{
        if(area!=='session')return;
        const active=changes.activeSpaces, receipts=changes.splitPinFocusLinksV1;
        if(active&&active.oldValue?.[scope.windowId]!==active.newValue?.[scope.windowId])close();
        if(receipts&&JSON.stringify(receipts.oldValue?.[receiptKey])!==JSON.stringify(receipts.newValue?.[receiptKey]))close();
    };
    function close() {
        if(!current)return;
        current=false;clearTimeout(timer);clearTimeout(delayTimer);wake?.();expired(null);
        for(const [event,listener] of listeners)try{event.removeListener(listener);}catch{/* closed context */}
        if(pending.get(store)===ticket)pending.delete(store);
    }
    const listeners=[[activation,onActivation],[focus,onFocus],[storage,onStorage]];
    const ticket={scope,close,
        offer(verify) {
            if(!current||pending.get(store)!==ticket)return null;
            try{ticket.token=crypto.randomUUID();}catch{return null;}
            const expiresAt=Date.now()+FOCUS_CONFIRMATION_DEADLINE_MS, end=performance.now()+FOCUS_CONFIRMATION_DEADLINE_MS;
            const live=()=>current&&Date.now()<expiresAt&&performance.now()<end;
            ticket.run=async()=>{
                if(!live()||consumed)return {confirmed:false};
                consumed=true;
                const proof=async()=>{
                    await new Promise(resolve=>{wake=resolve;delayTimer=setTimeout(resolve,FOCUS_CONFIRMATION_DELAY_MS);});
                    if(!live())return null;
                    // Outside the FIFO, let routine admissions settle within the
                    // existing ticket deadline. Once proof starts, its tail is fixed.
                    while(live()){
                        const chain=store.chain;
                        if(chain)await chain;
                        if(!live())return null;
                        if(store.chain!==chain)continue;
                        return verify(()=>live()&&store.chain===chain);
                    }
                    return null;
                };
                try{
                    const stillVerified=await Promise.race([proof().catch(()=>null),stop]);
                    return {confirmed:typeof stillVerified==='function'&&live()&&stillVerified()};
                }finally{close();}
            };
            retained=true;clearTimeout(timer);timer=setTimeout(close,FOCUS_CONFIRMATION_DEADLINE_MS);
            return {confirmationToken:ticket.token,expiresAt};
        },
        release(){if(!retained)close();}
    };
    try{
        for(const [event,listener] of listeners)event.addListener(listener);
        pending.get(store)?.close();pending.set(store,ticket);
        timer=setTimeout(close,FOCUS_CONFIRMATION_DEADLINE_MS);
        return ticket;
    }catch{close();return null;}
}
export async function confirmSplitFocus(store, request) {
    const ticket=pending.get(store);
    if(!ticket?.run||ticket.token!==request.confirmationToken||!keys.every(k=>ticket.scope[k]===request[k]))return {confirmed:false};
    return ticket.run();
}
