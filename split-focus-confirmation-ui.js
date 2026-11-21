const FOCUS_CONFIRMATION_DEADLINE_MS = 1100;
const UNCONFIRMED = "Couldn't confirm focus on this split. No new tabs were opened.";

export function createSplitFocusConfirmationUI({send, showPending, getFence, schedule=setTimeout, cancel=clearTimeout}) {
    let sequence=0, watching=null, accepted=false;
    function stop() {
        if(watching?.timer!=null)cancel(watching.timer);
        watching=null;
    }
    return {
        begin(){stop();accepted=false;return ++sequence;},
        observeActivation({windowId,tabId}){
            if(watching?.windowId===windowId&&watching.tabId!==tabId){stop();sequence++;}
        },
        accept(attempt,route,fence,result) {
            if(attempt!==sequence||accepted||fence!==getFence()){return;}
            accepted=true;
            const ticket={windowId:route.windowId,tabId:result.activeTabId,timer:null};
            watching=ticket;
            const clear=showPending(result.pendingMessage);

            const remaining=Math.max(0,Math.min(FOCUS_CONFIRMATION_DEADLINE_MS,result.expiresAt-Date.now()));
            const end=performance.now()+remaining;
            const current=()=>watching===ticket&&attempt===sequence&&fence===getFence();
            const timely=()=>Date.now()<result.expiresAt&&performance.now()<end;
            function finish(confirmed) {
                if(watching!==ticket)return;
                const ownedRoute=current(), success=confirmed&&timely();
                stop();
                if(!ownedRoute){return;}
                if(success)clear?.();
                else clear?.replace?.(UNCONFIRMED);
            }
            ticket.timer=schedule(()=>finish(false),Math.ceil(remaining));
            void Promise.resolve().then(async()=>{
                if(!current()){finish(false);return;}
                if(!timely()){finish(false);return;}

                const reply=await send({...route,action:'confirmFocus',confirmationToken:result.confirmationToken});
                if(watching!==ticket)return;
                const confirmed=reply?.success===true&&reply.confirmed===true;

                finish(confirmed);
            }).catch(()=>{
                if(watching!==ticket)return;

                finish(false);
            });
        }
    };
}
