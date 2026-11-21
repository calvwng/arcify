import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {createFavoritesStatus} from '../../favorites-status.js';
import {createSplitFocusConfirmationUI} from '../../split-focus-confirmation-ui.js';
const terminal="Couldn't confirm focus on this split. No new tabs were opened.";
const turn=()=>new Promise(r=>setImmediate(r));
for(const mode of ['settled','expected-activation','foreign-activation','different-tab-aba','notice-superseded-identical','dismissed','route-aba','new-click','pagehide','expired','not-confirmed','transport','hung','expired-before-send','visibility-before-accept','hover-preview','replay','dismiss-focus'])test(`focus notice ${mode}`,async()=>{
    const {document}=parseHTML('<div id="favoritesDropNotice"><span id="favoritesDropStatus"></span><button id="favoritesDropDismiss"></button></div>');
    const button=document.querySelector('button'),text=()=>document.querySelector('span').textContent;
    let returnFocus=0;
    const status=createFavoritesStatus({document,returnFocus:()=>({focus(){returnFocus++;}})});
    let settle, reject, sends=0, fence=0, timer, cancellations=0;
    const ui=createSplitFocusConfirmationUI({
        showPending:text=>status.show(text),getFence:()=>fence,
        schedule:(callback,delay)=>{assert.ok(delay>=0&&delay<=1100);timer=callback;return 22;},
        cancel:id=>{assert.equal(id,22);cancellations++;},
        send:req=>{sends++;assert.equal(req.action,'confirmFocus');return new Promise((a,b)=>{settle=a;reject=b;});}
    });
    const pending={confirmationToken:'ticket',activeTabId:1,expiresAt:Date.now()+1000,pendingMessage:'pending'};
    const attempt=ui.begin(), route={windowId:10,spaceId:'s'};
    if(mode==='expired-before-send')pending.expiresAt=0;
    if(mode==='visibility-before-accept'){fence++;ui.begin();}
    ui.accept(attempt,route,0,pending);
    assert.equal(text(),mode==='visibility-before-accept'?'':'pending');
    await turn();
    if(mode==='expected-activation')ui.observeActivation({windowId:10,tabId:1});
    if(mode==='foreign-activation')ui.observeActivation({windowId:11,tabId:9});
    if(mode==='different-tab-aba'){ui.observeActivation({windowId:10,tabId:9});ui.observeActivation({windowId:10,tabId:1});}
    if(mode==='notice-superseded-identical')status.show('pending',{dismissible:false});
    if(mode==='dismissed')button.click();
    if(mode==='route-aba')fence+=2;
    if(mode==='new-click'||mode==='pagehide')ui.begin();
    if(mode==='hover-preview')status.show('preview',{preview:true});
    if(mode==='dismiss-focus')Object.defineProperty(document,'activeElement',{value:button});
    if(mode==='expired')pending.expiresAt=Date.now()-1;
    if(mode==='hung'){
        timer();
        assert.equal(text(),terminal);
        settle({success:true,confirmed:true}); // A late reply can never clear terminal.
    }else if(mode==='transport')reject(Error('ignored transport details'));
    else settle?.({success:true,confirmed:!['not-confirmed','hover-preview','dismiss-focus','notice-superseded-identical','dismissed','replay'].includes(mode)});
    await turn();
    if(mode==='replay'){ui.accept(attempt,route,0,pending);await turn();}
    if(mode==='hover-preview'){assert.equal(text(),'preview');status.clearPreview();}
    const clear=['settled','expected-activation','foreign-activation','dismissed','visibility-before-accept'].includes(mode);
    const failed=['expired','not-confirmed','transport','hung','expired-before-send','hover-preview','replay','dismiss-focus'].includes(mode);
    assert.equal(text(),clear?'':failed?terminal:'pending');
    if(failed)assert.equal(button.hidden,false);
    if(mode==='notice-superseded-identical')assert.equal(button.hidden,true);
    assert.equal(returnFocus,0);
    assert.equal(sends,['expired-before-send','visibility-before-accept'].includes(mode)?0:1);
    assert.equal(cancellations,mode==='visibility-before-accept'?0:1);
    timer?.(); // Simulate a callback already queued when canceled.
    assert.equal(text(),clear?'':failed?terminal:'pending');
});
