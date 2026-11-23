/** Test-only evidence validator. Import does not launch a browser or read a profile. */
import assert from 'node:assert/strict';

const trusted=(mark, action)=>assert(mark?.action===action&&mark?.trusted===true&&mark?.nativeSidebar===true,
    'The scenario requires the expected trusted input on the real native sidebar.');
const isId=id=>Number.isSafeInteger(id)&&id>0;
const fixtureIds=(state, markers)=>markers.map(marker=>{
    const rows=state.tabs.filter(t=>t.fixtureMarker===marker);
    assert.equal(rows.length,1,'A controlled synthetic marker must refer to exactly one native tab.');
    assert(isId(rows[0].id),'A live browser tab ID is required.');
    return rows[0].id;
});
function pair(state, markers){
    const ids=fixtureIds(state,markers);
    const a=state.tabs.find(t=>t.id===ids[0]), b=state.tabs.find(t=>t.id===ids[1]);
    assert.notEqual(a.id,b.id);
    assert(isId(a.windowId)&&a.windowId===b.windowId&&a.incognito===false&&b.incognito===false);
    assert(a.pinned===false&&b.pinned===false&&a.groupId===b.groupId);
    assert(Number.isSafeInteger(a.splitViewId)&&a.splitViewId>=0&&a.splitViewId===b.splitViewId);
    assert.equal(b.index,a.index+1,'Exact fixture pane order must survive.');
    assert.equal(state.tabs.filter(t=>t.windowId===a.windowId&&t.splitViewId===a.splitViewId).length,2,
        'No third member can share the pair.');
    return {ids,windowId:a.windowId,view:a.splitViewId};
}
const nativePartition=state=>state.tabs.map(({id,windowId,index,url,pinned,incognito,groupId,splitViewId,fixtureMarker})=>
    ({id,windowId,index,url,pinned,incognito,groupId,splitViewId,fixtureMarker})).sort((a,b)=>a.id-b.id);

export function assertSplitColdRestart(before, restored, restart, markers) {
    assert(Array.isArray(markers)&&markers.length===2&&new Set(markers).size===2&&markers.every(m=>typeof m==='string'&&m.length));
    assert.equal(restart?.status,'passed','Expected full lifecycle proof from restartObservedBrowser.');
    assert(isId(restart.original?.pid)&&isId(restart.restarted?.pid));
    assert.notEqual(restart.original.pid,restart.restarted.pid);
    assert.deepEqual(restart.originalExit,{pid:restart.original.pid,exitCode:0,signalCode:null});
    assert.equal(restart.original.executable,restart.restarted.executable);
    assert.deepEqual(restart.original.arguments,restart.restarted.arguments);
    assert(typeof restart.userDataDir==='string'&&restart.userDataDir.length>0);
    assert.deepEqual(restart.original.arguments.filter(arg=>/^--?user-data-dir(?:=|$)/.test(arg)),
        [`--user-data-dir=${restart.userDataDir}`]);
    for(const kind of ['runtime','sandbox','registry'])assert.equal(restart.validation?.[kind],true);
    const old=pair(before,markers), fresh=pair(restored,markers);
    assert(old.ids.every(id=>!fresh.ids.includes(id)),'Pre/post fixture tabs must have remapped session IDs.');
    assert(before.pin?.bookmarkId&&before.pin?.recipeId&&before.pin?.spaceId,'Pin identity evidentiary fields are required.');
    assert.deepEqual(restored.pin,before.pin,'Same durable marker and recipe must survive.');
    assert.equal(restored.strongReceipt,false);
    assert.equal(restored.focusReceipt,null);
    assert.equal(restored.pinCurrent,false);
    for(const id of fresh.ids)assert(restored.todayPaneIds.includes(id),'Both freshly restored panes must remain visible in Today before explicit linking.');
    return fresh;
}

export function assertSingleLinkedPinClick({ restored, chooser, picked, linked, after, click, markers, ledger, quietMs }) {
    const fresh=pair(restored,markers);
    trusted(chooser?.opened,'open-chooser');
    trusted(picked?.selection,'choose-exact-pair');
    trusted(picked?.submit,'link-selected-pair');
    assert(chooser.defaultSelection===null&&chooser.confirmDisabled===true,'Even a sole candidate must not be selected automatically.');
    assert.equal(chooser.candidatePaneIds.length,1,'Fallback requires one exact candidate in its controlled fixture; unexpected alternatives are inconclusive.');
    assert.deepEqual(chooser.candidatePaneIds[0],fresh.ids);
    assert.deepEqual(picked.paneIds,fresh.ids);
    assert.deepEqual(linked.focusReceipt,{bookmarkId:restored.pin.bookmarkId,spaceId:restored.pin.spaceId,windowId:fresh.windowId,paneIds:fresh.ids});
    assert.equal(linked.strongReceipt,false);
    assert.deepEqual(linked.pin,restored.pin);
    assert.deepEqual(nativePartition(linked),nativePartition(restored),'Open, choose and link cannot change native pair or tab set.');
    assert.deepEqual(linked.todayPaneIds,restored.todayPaneIds);
    const neutral=linked.tabs.filter(t=>t.windowId===fresh.windowId&&t.active===true);
    assert.equal(neutral.length,1);
    assert(!fresh.ids.includes(neutral[0].id),'Before sampling, the native pair must be inactive in its window.');
    trusted(click,'saved-pin-click');
    assert.equal(click.bookmarkId,restored.pin.bookmarkId);
    for(const field of ['primaryPointer','focused','visible'])assert.equal(click[field],true,`Measured click requires ${field} in the exact native panel.`);
    assert.equal(ledger.pinClicks,1);
    for(const key of ['extraInputs','diagnosticReads','linkChanges','extensionReloads','windowSwitches','visibilityChanges','settingsChanges'])assert.equal(ledger[key],0);
    assert(Number.isFinite(quietMs)&&quietMs>=1100,'Observe quietly through at least the existing confirmation deadline.');
    assert.deepEqual(nativePartition(after),nativePartition(linked),'A single click may focus, not open, close, move, navigate, regroup or repin.');
    assert.deepEqual(pair(after,markers),fresh);
    assert.deepEqual(after.pin,linked.pin);
    assert.deepEqual(after.focusReceipt,linked.focusReceipt);
    assert.equal(after.strongReceipt,false);
    assert.deepEqual(after.todayPaneIds,linked.todayPaneIds);
    const active=after.tabs.filter(t=>t.windowId===fresh.windowId&&t.active===true);
    assert.equal(active.length,1);
    assert.equal(active[0].id,fresh.ids[0]);
    const { notice, pinCurrent }=after;
    assert(['none','neutral-unconfirmed','pending','other','unchanged','unchanged-ambiguous'].includes(notice));
    assert.equal(typeof pinCurrent,'boolean');
    // UI observations do not identify the native worker's proof branch.
    return {nativePairPreserved:true,exactPaneActivated:true,remappedIds:true,noNewTabs:true,notice,pinCurrent,
        confirmationBranch:'not-proven'};
}
