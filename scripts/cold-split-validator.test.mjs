import test from 'node:test';
import assert from 'node:assert/strict';
import {assertSingleLinkedPinClick,assertSplitColdRestart} from './cold-split-validator.mjs';

function fixture() {
    const markers=['fixture-left','fixture-right'];
    const mark=(action,extra={})=>({action,trusted:true,nativeSidebar:true,...extra});
    const pin={bookmarkId:'fixture-bookmark',recipeId:'fixture-recipe',spaceId:'fixture-space'};
    const tabs=(start,windowId,splitViewId)=>[...markers,'neutral'].map((fixtureMarker,index)=>({
        id:start+index,windowId,index,url:'http://127.0.0.1/'+fixtureMarker,pinned:false,incognito:false,groupId:-1,
        splitViewId:index===2?-1:splitViewId,fixtureMarker,active:index===2
    }));
    const restored={tabs:tabs(101,8,11),pin,strongReceipt:false,focusReceipt:null,pinCurrent:false,todayPaneIds:[101,102,103]};
    const before={...structuredClone(restored),tabs:tabs(10,2,4),strongReceipt:true,todayPaneIds:[12]};
    const process={executable:'/opt/google/chrome/chrome',arguments:['--user-data-dir=/tmp/disposable']};
    const restart={status:'passed',userDataDir:'/tmp/disposable',original:{...process,pid:200},restarted:{...process,pid:300},
        originalExit:{pid:200,signalCode:null,exitCode:0},validation:{runtime:true,sandbox:true,registry:true}};
    const chooser={opened:mark('open-chooser'),defaultSelection:null,confirmDisabled:true,candidatePaneIds:[[101,102]]};
    const picked={selection:mark('choose-exact-pair'),submit:mark('link-selected-pair'),paneIds:[101,102]};
    const linked={...structuredClone(restored),focusReceipt:{bookmarkId:pin.bookmarkId,spaceId:pin.spaceId,windowId:8,paneIds:[101,102]}};
    const after={...structuredClone(linked),notice:'neutral-unconfirmed'};
    after.tabs.forEach(t=>{t.active=t.id===101;});
    const click=mark('saved-pin-click',{bookmarkId:pin.bookmarkId,primaryPointer:true,focused:true,visible:true});
    const ledger={pinClicks:1,extraInputs:0,diagnosticReads:0,linkChanges:0,extensionReloads:0,windowSwitches:0,visibilityChanges:0,settingsChanges:0};
    return {before,restored,restart,chooser,picked,linked,after,click,markers,ledger,quietMs:7000};
}

for(const [notice,pinCurrent] of [['none',true],['none',false],['neutral-unconfirmed',false],['pending',false],['unchanged',false],['unchanged-ambiguous',false]])
test(`classifies native activation without claiming proof: ${notice} / badge ${pinCurrent}`,()=>{
    const f=fixture();Object.assign(f.after,{notice,pinCurrent});
    assert.deepEqual(assertSplitColdRestart(f.before,f.restored,f.restart,f.markers),{ids:[101,102],windowId:8,view:11});
    assert.deepEqual(assertSingleLinkedPinClick(f),{nativePairPreserved:true,exactPaneActivated:true,
        remappedIds:true,noNewTabs:true,notice,pinCurrent,confirmationBranch:'not-proven'});
});

for(const [name,change] of Object.entries({
    'same browser process':f=>f.restart.restarted.pid=f.restart.original.pid,
    'unclean exit':f=>f.restart.originalExit.signalCode='SIGKILL',
    'changed launch arguments':f=>{f.restart.restarted.arguments=['--user-data-dir=/tmp/other'];},
    'sandbox or registry unverified':f=>f.restart.validation.sandbox=false,
    'old IDs mistaken for restored':f=>f.restored.tabs[0].id=10,
    'same marker copied to competitor':f=>f.restored.tabs.push({...f.restored.tabs[0],id:900}),
    'native pair dissolved':f=>f.restored.tabs[1].splitViewId=-1,
    'pin changed':f=>f.restored.pin={...f.restored.pin,recipeId:'other'},
    'receipt did not clear':f=>f.restored.focusReceipt=f.linked.focusReceipt,
    'pin masquerades as linked':f=>f.restored.pinCurrent=true,
    'not both Today':f=>f.restored.todayPaneIds.length=1
}))test(`refuses cold witness: ${name}`,()=>{
    const f=fixture();change(f);assert.throws(()=>assertSplitColdRestart(f.before,f.restored,f.restart,f.markers));
});

for(const [name,change] of Object.entries({
    'synthetic click':f=>f.click.trusted=false,
    'extension tab substituted for native sidebar':f=>f.click.nativeSidebar=false,
    'chooser auto-selected':f=>f.chooser.defaultSelection=0,
    'pointer source not primary mouse':f=>f.click.primaryPointer=false,
    'sidebar not focused at click':f=>f.click.focused=false,
    'sidebar not visible at click':f=>f.click.visible=false,
    'wrong candidate confirmed':f=>f.picked.paneIds=[102,101],
    'chooser mutated tabs':f=>f.linked.tabs[2].index=6,
    'target mismatch':f=>f.click.bookmarkId='different',
    'double click':f=>f.ledger.pinClicks=2,
    'diagnostic polling during quiet':f=>f.ledger.diagnosticReads=1,
    'visibility changed':f=>f.ledger.visibilityChanges=1,
    'fixture settings changed during sampling':f=>f.ledger.settingsChanges=1,
    'too early':f=>f.quietMs=1000,
    'new pair':f=>f.after.tabs.push({...f.after.tabs[0],id:900}),
    'native reordering':f=>f.after.tabs[0].index=4,
    'wrong tab focused':f=>{f.after.tabs[0].active=false;f.after.tabs[1].active=true;},
    'receipt changed':f=>f.after.focusReceipt=null,
    'strong ownership accidentally granted':f=>f.after.strongReceipt=true,
    'missing notice capture':f=>delete f.after.notice
}))test(`refuses focus witness: ${name}`,()=>{
    const f=fixture();change(f);assert.throws(()=>assertSingleLinkedPinClick(f));
});
