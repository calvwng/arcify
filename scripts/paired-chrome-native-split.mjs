/** CI-only native Split View proof. Importing this module never launches Chrome. */
import { visibleTodayOrder, installTodayOrderTrace, assertTodayOrderInput, readTodayOrderSidebar } from './paired-chrome-today-order.mjs';
import { assertTodayMoveRejected } from './paired-chrome-today-move.mjs';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { locateFreshDragGeometry } from './paired-chrome-ui.mjs';
import { clickBookmarkFixtureRow, finishBookmarkFixture } from './paired-chrome-bookmark-selection.mjs';
import { favoriteDragInputClient } from './paired-chrome-favorites-marker.mjs';
import { readTodaySelection, assertTodaySelection } from './paired-chrome-today-selection.mjs';

export { NATIVE_SPLIT_CASE_NAME } from './paired-chrome-run-plan.mjs';
export const todayRowSelector = id => `.space.active [data-tab-type="temporary"] .tab[data-tab-id="${id}"]`;
const sorted = values => [...values].sort((a, b) => a - b);
const identity = ({id,windowId,url,pendingUrl,pinned,incognito}) => ({id,windowId,url,pendingUrl,pinned,incognito});
const exactTab = (state,id) => { const matches=state.tabs.filter(tab=>tab.id===id);assert.equal(matches.length,1,`Missing or duplicated exact native tab ${id}.`);return matches[0]; };

export function assertNativeSplitCapability(capability) {
    assert.equal(capability?.createSplit,'function','Positive native Split View coverage requires chrome.tabs.createSplit.');
    assert.equal(capability?.unsplit,'function','Positive native Split View coverage requires chrome.tabs.unsplit.');
    assert.equal(capability?.none,-1,'Use Chrome’s real no-split sentinel.');
    assert(Number.isInteger(capability.major) && capability.major>=155,'Positive native Split View coverage requires installed Chrome 155+.');
    return capability;
}

export function assertNativeSplitPagesPreserved(before,after) {
    assert.deepEqual(after.tabs.map(tab=>tab.id),before.tabs.map(tab=>tab.id),'Split/unsplit cannot open, close, or duplicate any native tab.');
    for(const tab of before.tabs)assert.deepEqual(identity(exactTab(after,tab.id)),identity(tab),`Tab ${tab.id} must retain its page and native identity.`);
    assert(Object.keys(before.pageStates).length>=2,'Native continuity needs both original documents.');
    for(const state of Object.values(before.pageStates)){assert.equal(state.topLevel,true);assert.equal(state.frames,0);assert.equal(typeof state.documentId,'string');assert(state.documentId);assert.equal(typeof state.value,'string');}
    assert.equal(new Set(Object.values(before.pageStates).map(state=>state.documentId)).size,Object.keys(before.pageStates).length,'Same-URL twins must retain distinct documents.');
    assert.deepEqual(after.pageStates,before.pageStates,'Both original documents and typed page input must survive native split/unsplit.');
    for(const field of ['bookmarks','bindings','favorites'])assert.deepEqual(after[field],before[field],`${field} is unrelated to Today Split View.`);
}

export function assertNativeSplitPair(state,{tabIds,windowId,spaceId,splitViewId}) {
    assert.equal(tabIds.length,2);assert.equal(new Set(tabIds).size,2);
    const tabs=tabIds.map(id=>exactTab(state,id)), id=tabs[0].splitViewId;
    assert(Number.isSafeInteger(id)&&id>=0,'A sidebar badge cannot substitute for a native splitViewId.');
    if(splitViewId!==undefined)assert.equal(id,splitViewId,'The existing native split pair identity must survive.');
    assert.equal(tabs[1].splitViewId,id);
    assert.deepEqual(sorted(state.tabs.filter(tab=>tab.splitViewId===id).map(tab=>tab.id)),sorted(tabIds),'Native membership must be exactly the requested two live identities.');
    assert.equal(Math.abs(tabs[0].index-tabs[1].index),1,'Native split members must be adjacent.');
    assert.equal(tabs[0].groupId,tabs[1].groupId,'Native split members retain matching group membership.');
    const space=state.spaces.find(item=>item.id===spaceId);assert(space);
    for(const tab of tabs){assert.equal(tab.windowId,windowId);assert.equal(tab.pinned,false);assert.equal(tab.incognito,false);assert(space.temporaryTabs.includes(tab.id));assert(!space.spaceBookmarks.includes(tab.id));}
    return {tabIds,windowId,spaceId,splitViewId:id,groupId:tabs[0].groupId};
}

/** Positive counterexample to an overbroad whole-window grouping freeze. */
export function assertUnaffectedSpaceProjection(state,{pair,tabId,spaceId,name,color}) {
    assert.notEqual(spaceId,pair.spaceId);
    assert.equal(state.activeSpaceId,pair.spaceId,'Protected Space stays active while the unaffected Space is collapsed.');
    const preserved=assertNativeSplitPair(state,pair);
    assert.equal(preserved.groupId,pair.groupId,'Grouping another Space cannot regroup split members.');
    const tab=exactTab(state,tabId),space=state.spaces.find(item=>item.id===spaceId);
    assert(space);assert.deepEqual(space.temporaryTabs,[tabId]);assert.deepEqual(space.spaceBookmarks,[]);
    assert.equal(tab.windowId,pair.windowId);assert.equal(tab.pinned,false);assert.equal(tab.splitViewId,-1);
    assert(Number.isSafeInteger(tab.groupId)&&tab.groupId>=0,'The unaffected Space must actually receive a native group.');
    const groups=state.groups.filter(group=>group.id===tab.groupId);assert.equal(groups.length,1);
    const group=groups[0];assert.equal(group.windowId,pair.windowId);assert.equal(group.title,name);assert.equal(group.color,color);assert.equal(group.collapsed,true);
    assert.equal(state.projection[`${spaceId}:${pair.windowId}`],group.id,'The group must be owned by this exact Space/window projection.');
    assert.deepEqual(state.tabs.filter(item=>item.groupId===group.id).map(item=>item.id),[tabId],'Only the seeded unaffected tab belongs to its native group.');
    assert.deepEqual(state.deferrals.filter(item=>item.windowId===pair.windowId),[{spaceId:pair.spaceId,windowId:pair.windowId,reason:'native-split'}],'Only the split Space is structurally deferred in this window.');
    return {spaceId,tabId,group,pair:preserved};
}

export function assertNativeSplitCreated(before,after,request) {
    assertNativeSplitPagesPreserved(before,after);
    const proof=assertNativeSplitPair(after,request),members=request.tabIds.map(id=>exactTab(before,id)).sort((a,b)=>a.index-b.index);
    assert(members.every(tab=>tab.splitViewId===-1&&tab.windowId===request.windowId&&tab.groupId===members[0].groupId&&!tab.pinned&&!tab.incognito));
    const relocate=ids=>{const moved=members[1].id,anchor=members[0].id,next=ids.filter(id=>id!==moved);assert(next.includes(anchor)&&ids.includes(moved));next.splice(next.indexOf(anchor)+1,0,moved);return next;};
    for(const windowId of new Set(before.tabs.map(tab=>tab.windowId))){
        const nativeOrder=state=>state.tabs.filter(tab=>tab.windowId===windowId).sort((a,b)=>a.index-b.index).map(tab=>tab.id);
        assert.deepEqual(nativeOrder(after),windowId===request.windowId?relocate(nativeOrder(before)):nativeOrder(before),'Only the later exact tab may move immediately after the earlier member.');
    }
    for(const tab of before.tabs){const next=exactTab(after,tab.id);assert.equal(next.groupId,tab.groupId);assert.equal(next.splitViewId,request.tabIds.includes(tab.id)?proof.splitViewId:tab.splitViewId,'Unrelated native split membership cannot change.');}
    for(const space of before.spaces){const expected=space.id===request.spaceId?{...space,temporaryTabs:relocate(space.temporaryTabs)}:space;assert.deepEqual(after.spaces.find(item=>item.id===space.id),expected,'Canonical Today order follows only the exact pair relocation.');}
    assert.equal(after.spaces.length,before.spaces.length);
    assert.equal(after.activeSpaceId,before.activeSpaceId);
    return proof;
}


/** A trusted child from either pane belongs after the complete exact pair. */
export function assertNativeSplitChild(before, after, { pair, openerId, inverted }) {
    assert(pair.tabIds.includes(openerId)); assertNativeSplitPair(before, pair); assertNativeSplitPair(after, pair);
    const additions = after.tabs.filter(tab => !before.tabs.some(old => old.id === tab.id)); assert.equal(additions.length, 1);
    assert.equal(after.tabs.length, before.tabs.length + 1); const child = additions[0];
    assert.equal(child.windowId, pair.windowId); assert.equal(child.openerTabId, openerId); assert.equal(child.splitViewId, -1);
    assert.equal(child.pinned, false); assert.equal(child.incognito, false); assert.equal(child.pendingUrl, null); assert.equal(child.status, 'complete');
    for (const old of before.tabs) { const live = exactTab(after, old.id); assert.deepEqual(identity(live), identity(old)); assert.equal(live.groupId, old.groupId); assert.equal(live.splitViewId, old.splitViewId); }
    for (const field of ['bookmarks', 'bindings', 'favorites', 'pageStates', 'activeSpaceId', 'groups', 'projection']) assert.deepEqual(after[field], before[field]);
    const original = before.spaces.find(space => space.id === pair.spaceId), visible = visibleTodayOrder(original.temporaryTabs, inverted);
    const positions = pair.tabIds.map(id => visible.indexOf(id)); assert.equal(Math.abs(positions[0] - positions[1]), 1);
    visible.splice(Math.max(...positions) + 1, 0, child.id); const canonical = visibleTodayOrder(visible, inverted);
    for (const old of before.spaces) assert.deepEqual(after.spaces.find(space => space.id === old.id), old.id === pair.spaceId ? { ...old, temporaryTabs: canonical } : old);
    const inWindow = ids => ids.filter(id => after.tabs.some(tab => tab.id === id && tab.windowId === pair.windowId));
    assert.deepEqual(after.snapshot.spaces.find(space => space.id === pair.spaceId).temporaryTabIds, inWindow(canonical));
    assert.equal(after.snapshot.tabs.find(tab => tab.id === child.id)?.spaceId, pair.spaceId);
    assert.equal(after.rendered.spaceId, pair.spaceId); assert.equal(after.rendered.inverted, String(inverted));
    assert.deepEqual(after.rendered.ids, inWindow(visible)); assert(after.rendered.visible.every(Boolean));
    for (const windowId of new Set(before.tabs.map(tab => tab.windowId))) {
        const order = state => state.tabs.filter(tab => tab.windowId === windowId && tab.id !== child.id).sort((a, b) => a.index - b.index).map(tab => tab.id);
        assert.deepEqual(order(after), order(before), 'Opening a child must preserve the original native pair and survivor order.');
    }
    return { childId: child.id, openerId, pair, canonical, visible: inWindow(visible) };
}

export function installNativeSplitInputTrace() {
    const trace=[];globalThis.__nativeSplitInputTrace=trace;
    globalThis.__nativeSplitDomLastChange=performance.now();
    new MutationObserver(()=>{globalThis.__nativeSplitDomLastChange=performance.now();}).observe(document.getElementById('spacesList'),{subtree:true,childList:true,attributes:true});
    for(const type of ['dragstart','dragover','drop','dragend','keydown']) window.addEventListener(type,event=>{
        trace.push({type,trusted:event.isTrusted,tabId:Number(event.target.closest?.('.tab')?.dataset.tabId)||null,action:event.target.closest?.('[data-action]')?.dataset.action||null,key:event.key||null,shift:Boolean(event.shiftKey),ctrl:Boolean(event.ctrlKey),alt:Boolean(event.altKey),meta:Boolean(event.metaKey),dropEffect:event.dataTransfer?.dropEffect||null});
        if(trace.length>400)trace.shift();
    },{capture:true,passive:true});
}

/** Passive failure evidence, captured before fixture tabs are cleaned up. */
export function readNativeSplitSidebarState() {
    const describe = node => node ? {tagName:node.tagName,id:node.id,action:node.dataset.action||null,
        tabId:Number(node.closest?.('.tab')?.dataset.tabId)||null,connected:node.isConnected} : null;
    const menu=document.getElementById('tab-context-menu');
    return {visibility:document.visibilityState,hasFocus:document.hasFocus(),focused:describe(document.activeElement),
        status:document.getElementById('favoritesDropNotice')?.textContent||'',
        selection:document.getElementById('todaySelectionStatus')?.textContent||'',
        menu:menu?{text:menu.textContent,actions:[...menu.querySelectorAll('[data-action]')].map(describe)}:null,
        rows:[...document.querySelectorAll('.space.active [data-tab-type="temporary"] .tab')].map(row=>({
            ...describe(row),url:row.dataset.url,selected:row.getAttribute('aria-selected'),splitBadge:Boolean(row.querySelector('.today-split-badge'))})),
        inputTrace:[...(globalThis.__nativeSplitInputTrace||[])],
        domQuietMs:performance.now()-(globalThis.__nativeSplitDomLastChange||0)};
}

export function assertNativeSplitKeyboardTrace(events,{tabId,actions}) {
    const inputs=events.filter(event=>event.type==='keydown'&&['F10','Enter'].includes(event.key));
    assert.deepEqual(inputs.map(event=>event.key),actions.flatMap(()=>['F10','Enter']),'Every exact menu open must precede its single Enter.');
    const opens=inputs.filter(event=>event.key==='F10');
    const enters=inputs.filter(event=>event.key==='Enter');
    assert.deepEqual(opens.map(event=>event.tabId),actions.map(()=>tabId),'Each keyboard menu opens once on the exact Today row.');
    assert(opens.every(event=>event.trusted&&event.shift&&event.ctrl===false&&event.alt===false&&event.meta===false),'Menu opens must be trusted Shift+F10 input.');
    assert.deepEqual(enters.map(event=>event.action),actions,'Each requested menu action receives exactly one Enter; no replay.');
    assert(enters.every(event=>event.trusted&&event.shift===false&&event.ctrl===false&&event.alt===false&&event.meta===false),'Menu submits must be trusted unmodified Enter input.');
    return events;
}

/** Passive drag-only affordance evidence; no input or native API calls. */
export function readNativeSplitAffordances() {
    return { dragging: document.getElementById('spacesList')?.classList.contains('today-split-dragging') === true,
        rows: [...document.querySelectorAll('.space.active [data-tab-type="temporary"] .tab[data-tab-id]')].map(row => {
            const target=row.querySelector('.today-split-target'),badge=row.querySelector('.today-split-badge');
            const style=target?getComputedStyle(target):null;
            return {tabId:Number(row.dataset.tabId),target:Boolean(target),eligible:target?.dataset.splitEligible||null,
                visible:Boolean(target?.getClientRects().length&&style.display!=='none'&&style.visibility!=='hidden'&&Number(style.opacity)>0),
                outline:row.dataset.splitOutline||null,badge:badge?.textContent||null,label:badge?.getAttribute('aria-label')||null};
        }) };
}
export function assertNativeSplitTargetEligibility(state,{sourceId,targetId,dragging,allowed}) {
    assert.equal(state.dragging,dragging);const exact=id=>{const found=state.rows.filter(row=>row.tabId===id);assert.equal(found.length,1);return found[0];};
    const source=exact(sourceId),target=exact(targetId);
    assert.equal(source.visible,false,'The dragged source never reveals its own target.');assert.equal(source.eligible,null);
    assert.equal(target.visible,dragging&&allowed);assert.equal(target.eligible,dragging&&allowed?'true':null);
    if(!dragging)assert(state.rows.every(row=>!row.visible&&row.eligible===null),'Ordinary hover/selection cannot expose Split drop targets.');
    return state;
}
export function assertNativeSplitOutline(state,{tabIds}) {
    const rows=state.rows.filter(row=>tabIds.includes(row.tabId));assert.equal(rows.length,2);
    assert.deepEqual(rows.map(row=>row.outline),['first','last'],'Adjacent exact native members share the two outer outline edges.');
    assert.match(rows[0].badge,/^Split View [1-9]\d*$/);assert.equal(rows[0].badge,rows[1].badge,'Both members name the same numbered group.');
    rows.forEach((row,index)=>{assert(row.label.includes(row.badge));assert(row.label.includes(`Member ${index+1} of 2, adjacent pair.`));});
    return rows;
}
export function assertNativeSplitCancelled(evidence,{sourceId}) {
    assert.equal(evidence.method,'Input.cancelDragging');assert.equal(evidence.acknowledged,true);assert.equal(evidence.mouseReleased,false);
    const starts=evidence.trace.filter(event=>event.type==='dragstart'),ends=evidence.trace.filter(event=>event.type==='dragend');
    assert.equal(starts.length,1);assert.equal(ends.length,1);
    for(const event of [starts[0],ends[0]]){assert.equal(event.trusted,true);assert.equal(event.tabId,sourceId);}
    assert(evidence.trace.indexOf(starts[0])<evidence.trace.indexOf(ends[0]));assert.equal(ends[0].dropEffect,'none');
    assert(!evidence.trace.some(event=>event.type==='drop'),'Cancellation cannot deliver a drop into a reorder zone.');
    assert.equal(evidence.dragging,false);return evidence;
}
export async function cancelNativeSplitDrag({page,client,poll,sourceId}) {
    await client.send('Input.cancelDragging');
    const observed=await poll(()=>page.evaluate(()=>({trace:[...(globalThis.__nativeSplitInputTrace||[])],
        dragging:Boolean(document.querySelector('.dragging')||document.getElementById('spacesList')?.classList.contains('today-split-dragging'))})),
        state=>!state.dragging&&state.trace.some(event=>event.type==='dragend'&&event.trusted&&event.tabId===sourceId),'trusted Split drag cancellation before release');
    return assertNativeSplitCancelled({method:'Input.cancelDragging',acknowledged:true,mouseReleased:false,...observed},{sourceId});
}

export function assertNativeSplitDragTrace(events,{sourceId,targetId,allowed}) {
    const starts=events.filter(event=>event.type==='dragstart');assert.equal(starts.length,1,'Exactly one genuine dragstart; no replay.');
    assert.equal(starts[0].tabId,sourceId);assert.equal(starts[0].trusted,true);
    const hovers=events.filter(event=>event.type==='dragover'&&event.tabId===targetId&&event.action==='createSplitView');
    assert(hovers.length>0&&hovers.every(event=>event.trusted),'The real pointer must hover the exact explicit Split View target.');
    const drops=events.filter(event=>event.type==='drop');
    if(allowed){assert.equal(drops.length,1);assert.equal(drops[0].tabId,targetId);assert.equal(drops[0].action,'createSplitView');assert.equal(drops[0].trusted,true);}
    else assert(drops.every(event=>event.trusted&&event.tabId===targetId&&event.action==='createSplitView'),'A rejected drop cannot reach a different reorder target.');
    assert.equal(events.filter(event=>event.type==='dragend'&&event.trusted).length,1);
    return events;
}

export function assertNativeSplitEnded(before,after,request) {
    assertNativeSplitPagesPreserved(before,after);
    const proof=assertNativeSplitPair(before,request);
    for(const id of request.tabIds)assert.equal(exactTab(after,id).splitViewId,-1,'End Split View leaves both exact pages open as independent tabs.');
    assert.equal(after.tabs.some(tab=>tab.splitViewId===proof.splitViewId),false);
    for(const tab of before.tabs)if(!request.tabIds.includes(tab.id))assert.equal(exactTab(after,tab.id).splitViewId,tab.splitViewId,'Unsplit cannot change any unrelated native split membership.');
    assert.equal(after.activeSpaceId,before.activeSpaceId,'Unsplit cannot switch the active Space.');
    assert.deepEqual(after.spaces,before.spaces,'Unsplit must not change canonical Today membership/order.');
    assert.deepEqual(after.tabs.map(({id,index,groupId})=>({id,index,groupId})),before.tabs.map(({id,index,groupId})=>({id,index,groupId})),'Unsplit cannot reorder or regroup native tabs.');
    return proof;
}

export function assertNativeSplitRejected(before,after) {
    assertNativeSplitPagesPreserved(before,after);
    assert.deepEqual(after.spaces,before.spaces,'A rejected split drop must not fall through to Today reorder.');
    assert.deepEqual(after.tabs,before.tabs,'A rejected split drop cannot activate, move, group, pin, close or split any native tab.');
    assert.equal(after.activeSpaceId,before.activeSpaceId);
}

/** Fixture seeding only: the API page can live in a different browser window. */
export function createNativeSplitFixtureGroup({tabId,windowId}) {
    return chrome.tabs.group({tabIds:[tabId],createProperties:{windowId}});
}

export function assertNativeSplitIncompatibleSetup(before,after,{sourceId,targetId,windowId,spaceId,groupId}) {
    assert.notEqual(sourceId,targetId);
    assertNativeSplitPagesPreserved(before,after);
    assert.deepEqual(after.spaces,before.spaces,'Native group seeding cannot reassign or reorder canonical Today tabs.');
    assert.equal(before.activeSpaceId,spaceId);assert.equal(after.activeSpaceId,spaceId);
    const source=exactTab(after,sourceId),target=exactTab(after,targetId);
    for(const tab of [source,target]){
        assert.equal(tab.windowId,windowId,'Both incompatible Today rows must remain in the exact sidebar window.');
        assert.equal(tab.pinned,false);assert.equal(tab.incognito,false);assert.equal(tab.splitViewId,-1);
        assert(after.pageStates[tab.id],'Both incompatible rows need their original live document/input evidence.');
        assert.deepEqual(after.spaces.filter(space=>space.temporaryTabs.includes(tab.id)).map(space=>space.id),[spaceId]);
        assert(after.spaces.every(space=>!space.spaceBookmarks.includes(tab.id)));
    }
    assert(Number.isSafeInteger(groupId)&&groupId>=0,'Fixture seeding must return a real native group ID.');
    assert.equal(target.groupId,groupId);assert.notEqual(source.groupId,target.groupId);
    const groups=after.groups.filter(group=>group.id===groupId);assert.equal(groups.length,1);
    assert.equal(groups[0].windowId,windowId,'The new native group must be in the exact sidebar window.');
    assert.deepEqual(after.tabs.filter(tab=>tab.groupId===groupId).map(tab=>tab.id),[targetId]);
    for(const tab of before.tabs){
        const next=exactTab(after,tab.id);assert.equal(next.splitViewId,tab.splitViewId);
        if(tab.id!==targetId)assert.equal(next.groupId,tab.groupId,'Fixture seeding cannot regroup unrelated tabs.');
    }
    return {sourceId,targetId,windowId,spaceId,groupId};
}

export function assertSplitTargetFeedback(state,{sourceId,targetId,allowed}) {
    assert.equal(state.sourceId,sourceId);assert.equal(state.targetId,targetId);
    assert.equal(state.visible,true,'The Split View destination must be visibly painted during real drag.');
    assert.equal(state.draggable,true);
    assert.equal(state.action,'createSplitView');
    assert.equal(state.allowed,allowed);
    assert(state.rect.width>0&&state.rect.height>0);
    assert(state.rect.x>=0&&state.rect.y>=0&&state.rect.x+state.rect.width<=state.viewport.width+1&&state.rect.y+state.rect.height<=state.viewport.height+1);
    return state;
}

export function serveNativeSplitFixture(request,response) {
    const match=/^\/native-split\/([a-f0-9]{32})\/(left|right|middle|twin|blocked)$/.exec(new URL(request.url,'http://127.0.0.1').pathname);
    if(!match)return false;
    const documentId=randomBytes(16).toString('hex'),color=match[2]==='left'?'#f8d7da':match[2]==='right'?'#d3f4e0':'#e8e8ff';
    response.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'none'"});
    response.end(`<!doctype html><html><head><meta charset="utf-8"><title>Split ${match[2]} ${match[2]==='left'?match[1]:documentId}</title><link rel="icon" href="data:,"><style>html,body{margin:0;min-height:100%;background:${color};font:20px system-ui}main{padding:36px}input{font:inherit;width:90%}</style></head><body data-document-id="${documentId}"><main><h1>Native Split ${match[2]}</h1><p>Existing page ${match[1]}</p><label>Preserved input <input id="split-input" value="untouched"></label><p>Real top-level page. No frames.</p><a id="today-order-child" href="/today-order/${match[1]}/${match[2]}-split-child" target="_blank" rel="opener">Open child outside this split pair</a></main></body></html>`);
    return true;
}

export function readNativeSplitPage() {
    return {url:location.href,title:document.title,documentId:document.body.dataset.documentId,value:document.getElementById('split-input')?.value,timeOrigin:performance.timeOrigin,topLevel:window===window.top,frames:document.querySelectorAll('iframe,frame').length};
}

/** Passive DOM read: production actions are focusable DIV menuitems, not buttons. */
export function readNativeSplitMenuAction(node) {
    const menu=node.closest('#tab-context-menu');
    return {tagName:node.tagName,connected:node.isConnected,role:node.getAttribute('role'),action:node.dataset.action,
        tabIndexAttribute:node.getAttribute('tabindex'),menuRole:menu?.getAttribute('role'),disabledProperty:node.disabled,
        disabledAttribute:node.hasAttribute('disabled'),ariaDisabled:node.getAttribute('aria-disabled'),
        blocked:node.closest('[disabled], [inert], [hidden], [aria-disabled]:not([aria-disabled="false"])')!==null};
}

export function assertNativeSplitMenuAction(state,name) {
    assert(['createSplitView','endSplitView'].includes(name));
    assert.equal(state.tagName,'DIV','Expected the production context-menu DIV.');
    assert.equal(state.connected,true);assert.equal(state.menuRole,'menu');
    assert.equal(state.role,'menuitem');assert.equal(state.action,name);assert.equal(state.tabIndexAttribute,'0');
    assert.equal(state.disabledProperty,undefined,'A DIV menuitem must not acquire a disabled property.');
    assert.equal(state.disabledAttribute,false);
    assert(state.ariaDisabled===null||state.ariaDisabled==='false','Menu action must not be ARIA-disabled.');
    assert.equal(state.blocked,false,'Menu action and its ancestors must not be disabled, inert or hidden.');
}

/** Positive actions use trusted input; evaluate is limited to seeding, passive reads and explicit rejection probes. */
export async function exerciseNativeTodaySplit({browser,apiPage,newTabPage,pageForUrl,ui,screenshot,captureNativeWindow,snapshot,poll,fixture,arcifyId,record=async()=>{}}) {
    assert.equal(process.env.GITHUB_ACTIONS,'true');assert.equal(process.env.CI,'true');assert.notEqual(process.getuid?.(),0);
    for(const fn of [newTabPage,pageForUrl,ui,screenshot,captureNativeWindow,snapshot,poll])assert.equal(typeof fn,'function');
    const capability=await apiPage.evaluate(()=>({createSplit:typeof chrome.tabs.createSplit,unsplit:typeof chrome.tabs.unsplit,none:chrome.tabs.SPLIT_VIEW_ID_NONE,major:Number(/(?:Chrome|Chromium)\/(\d+)/.exec(navigator.userAgent)?.[1])}));
    await record({phase:'native-split-method-probe',capability});assertNativeSplitCapability(capability);
    const nonce=randomBytes(16).toString('hex'),windowId=fixture.windowA;
    const initial=await snapshot(windowId),spaceId=initial.activeSpaceId,space=initial.spaces.find(item=>item.id===spaceId);assert(space?.bookmarkFolderId);
    const unaffectedSpace=initial.spaces.find(item=>item.id===fixture.spaces.empty);assert(unaffectedSpace&&unaffectedSpace.id!==spaceId);assert.deepEqual(unaffectedSpace.tabIds,[]);
    const settings=await apiPage.evaluate(()=>chrome.storage.sync.get(['syncTabGroups','invertTabOrder','todayNewTabsAtTop']));
    const representation=await apiPage.evaluate(async()=>(await chrome.storage.local.get('todayOrderRepresentation')).todayOrderRepresentation);
    assert.equal(representation?.version,1);assert.equal(typeof representation.inverted,'boolean');
    const owned=[],pages=new Map(),evidence={capability,nonce,realMouseDrag:true,realKeyboardContext:true,nativeSplit:true,nativePanel:false,checkpoints:[]};
    let sidebar,primaryError;
    const checkpoint=async(phase,data)=>{evidence.checkpoints.push({phase,...data});await record(structuredClone(evidence));};
    const option=async(key,value)=>{await ui(apiPage,`Set ${key} with visible options`,async()=>{if(await apiPage.$eval(`#${key}`,node=>node.checked)!==value)await apiPage.click(`label.toggle-label[for="${key}"]`);});await poll(()=>apiPage.evaluate(key=>chrome.storage.sync.get(key),key),data=>(key==='syncTabGroups'?Boolean(data[key]):data[key]!==false)===value,`${key} saved`);};
    const read=async()=>{
        const state=await apiPage.evaluate(async()=>{const data=await chrome.storage.local.get(['spaces','pinnedTabStatesById','persistentFavorites']);const session=await chrome.storage.session.get(['spaceGroupProjection','spaceGroupSplitDeferrals']);return {
            groups:await chrome.tabGroups.query({}),projection:session.spaceGroupProjection||{},deferrals:session.spaceGroupSplitDeferrals||[],
            tabs:(await chrome.tabs.query({})).map(({id,windowId,index,url,pendingUrl,pinned,incognito,active,groupId,splitViewId,openerTabId,status})=>({id,windowId,index,url,pendingUrl:pendingUrl||null,pinned,incognito,active,groupId,splitViewId:splitViewId??-1,openerTabId:openerTabId??null,status})).sort((a,b)=>a.id-b.id),
            spaces:(data.spaces||[]).map(({id,bookmarkFolderId,temporaryTabs,spaceBookmarks})=>({id,bookmarkFolderId,temporaryTabs,spaceBookmarks})),bookmarks:await chrome.bookmarks.getTree(),bindings:data.pinnedTabStatesById||{},favorites:data.persistentFavorites||[]};});
        state.activeSpaceId=(await snapshot(windowId)).activeSpaceId;state.pageStates=Object.fromEntries(await Promise.all([...pages].map(async([id,page])=>[id,await page.evaluate(readNativeSplitPage)])));return state;
    };
    const awaitPair=async request=>poll(read,state=>{try{assertNativeSplitPair(state,request);return true;}catch{return false;}},'exact native splitViewId membership');
    const clear=()=>ui(sidebar.page,'Clear Today selection with Escape',()=>sidebar.page.keyboard.press('Escape'));
    const select=async ids=>{const state=await read();const ordered=visibleTodayOrder(state.spaces.find(space=>space.id===spaceId).temporaryTabs,representation.inverted).filter(id=>ids.includes(id));assert.equal(ordered.length,ids.length);await clear();await sidebar.page.waitForFunction(()=>performance.now()-globalThis.__nativeSplitDomLastChange>=250,{polling:50});for(const id of ids)await ui(sidebar.page,'Select exact Today row with Control click',()=>clickBookmarkFixtureRow(sidebar.page,todayRowSelector(id),['Control']));return poll(()=>sidebar.page.evaluate(readTodaySelection),state=>{try{assertTodaySelection(state,ordered);return true;}catch{return false;}},'two exact Today selections');};
    const menu=async(id,keyboard=false)=>ui(sidebar.page,keyboard?'Open Today context menu with Shift+F10':'Open exact Today context menu with right click',async()=>{
        const selector=todayRowSelector(id);await sidebar.page.waitForSelector(selector,{visible:true});
        if(keyboard){const row=await sidebar.page.$(selector);try{await row.focus();await sidebar.page.keyboard.down('Shift');try{await sidebar.page.keyboard.press('F10');}finally{await sidebar.page.keyboard.up('Shift');}}finally{await row.dispose();}}
        else await sidebar.page.click(selector,{button:'right'});
        await sidebar.page.waitForSelector('#tab-context-menu',{visible:true});
    });
    const action=async(name,keyboard=false)=>ui(sidebar.page,`Submit ${name} with ${keyboard?'Enter':'mouse'}`,async()=>{
        const selector=`#tab-context-menu [data-action="${name}"]`;await sidebar.page.waitForSelector(selector,{visible:true});
        assertNativeSplitMenuAction(await sidebar.page.$eval(selector,readNativeSplitMenuAction),name);
        if(keyboard){assert.equal(await sidebar.page.$eval(selector,node=>node===document.activeElement),true);await sidebar.page.keyboard.press('Enter');}
        else await sidebar.page.click(selector);
    });
    const focusRetained=async id=>poll(()=>sidebar.page.evaluate(id=>{const row=document.querySelector(`.space.active [data-tab-type="temporary"] .tab[data-tab-id="${id}"]`);return Boolean(row?.isConnected&&document.activeElement===row);},id),Boolean,'keyboard action retains exact connected Today row focus');
    const badges=async ids=>poll(()=>sidebar.page.evaluate(ids=>ids.map(id=>{const row=document.querySelector(`.space.active [data-tab-type="temporary"] .tab[data-tab-id="${id}"]`),badge=row?.querySelector('.today-split-badge');return {id,visible:Boolean(badge?.getClientRects().length),text:badge?.textContent};}),ids),rows=>rows.every(row=>row.visible&&row.text),'two visible native split badges');
    const capture=async label=>ui(sidebar.page,`Capture ${label}`,()=>screenshot(sidebar.page,label,true));
    const drag=async(sourceId,targetId,{allowed=true}={})=>ui(sidebar.page,allowed?'Drag Today row onto explicit native Split View destination':'Reject incompatible Today split drop without reorder',async()=>{
        // Drop-only targets are absent outside a genuine eligible drag. An
        // incompatible-group target stays hidden; never release over a row.
        assertNativeSplitTargetEligibility(await sidebar.page.evaluate(readNativeSplitAffordances),{sourceId,targetId,dragging:false,allowed});
        await sidebar.page.evaluate(()=>{globalThis.__nativeSplitInputTrace.length=0;});
        const rejectedBaseline=allowed?null:await read();
        const geometry=await locateFreshDragGeometry(sidebar.page,todayRowSelector(sourceId),todayRowSelector(targetId));let mouseDown=false;
        try{
            const {from}=geometry;await sidebar.page.mouse.move(from.x+Math.min(80,from.width/3),from.y+from.height/2);await sidebar.page.mouse.down();mouseDown=true;
            await sidebar.page.mouse.move(from.x+Math.min(80,from.width/3)+12,from.y+from.height/2,{steps:6});
            await poll(()=>sidebar.page.evaluate(()=>document.getElementById('spacesList')?.classList.contains('today-split-dragging')),Boolean,'one genuine eligible Split dragstart');
            const affordances=await sidebar.page.evaluate(readNativeSplitAffordances);
            assertNativeSplitTargetEligibility(affordances,{sourceId,targetId,dragging:true,allowed});
            if(!allowed){
                const cancellation=await cancelNativeSplitDrag({page:sidebar.page,client:favoriteDragInputClient(sidebar.page),poll,sourceId});
                const cancelledState=await read();assertNativeSplitRejected(rejectedBaseline,cancelledState);
                await checkpoint('native-incompatible-target-hidden-cancelled-before-release',{affordances,cancellation,before:rejectedBaseline,after:cancelledState,physicalEscapeAsserted:false});
                await sidebar.page.mouse.up();mouseDown=false;
                const released=await sidebar.page.evaluate(()=>globalThis.__nativeSplitInputTrace);
                assert(!released.some(event=>event.type==='drop'),'Release after cancellation cannot deliver a late drop.');
                assertNativeSplitTargetEligibility(await sidebar.page.evaluate(readNativeSplitAffordances),{sourceId,targetId,dragging:false,allowed});
                const releasedState=await read();assertNativeSplitRejected(rejectedBaseline,releasedState);
                await checkpoint('native-incompatible-target-cancelled-after-release',{trace:released,before:rejectedBaseline,after:releasedState});return;
            }
            const target=`${todayRowSelector(targetId)} .today-split-target[data-action="createSplitView"]`;
            await sidebar.page.waitForSelector(target,{visible:true});const handle=await sidebar.page.$(target);let box;
            try{box=await handle.boundingBox();assert(box&&box.width>0&&box.height>0);}finally{await handle.dispose();}
            await sidebar.page.mouse.move(box.x+box.width/2-3,box.y+box.height/2,{steps:20});
            await sidebar.page.mouse.move(box.x+box.width/2,box.y+box.height/2,{steps:2});
            const feedback=await poll(()=>sidebar.page.evaluate(({sourceId,targetId,selector})=>{
                const source=document.querySelector(`.tab[data-tab-id="${sourceId}"]`),target=document.querySelector(selector),rect=target?.getBoundingClientRect();
                return {sourceId:Number(source?.dataset.tabId),targetId:Number(target?.closest('.tab')?.dataset.tabId),draggable:Boolean(source?.draggable),action:target?.dataset.action,allowed:Boolean(target?.classList.contains('today-split-drop-active')),visible:Boolean(target?.getClientRects().length&&getComputedStyle(target).visibility==='visible'&&Number(getComputedStyle(target).opacity)>0),rect:rect?{x:rect.x,y:rect.y,width:rect.width,height:rect.height}:{},viewport:{width:innerWidth,height:innerHeight}};
            },{sourceId,targetId,selector:target}),state=>{try{assertSplitTargetFeedback(state,{sourceId,targetId,allowed});return true;}catch{return false;}},'exact painted native split drop destination');
            await screenshot(sidebar.page,allowed?'native-split-explicit-drag-destination':'native-split-incompatible-drop-destination',true);
            await checkpoint(allowed?'split-drop-feedback':'rejected-split-drop-feedback',{feedback});
            await sidebar.page.mouse.up();mouseDown=false;
            const trace=await poll(()=>sidebar.page.evaluate(()=>globalThis.__nativeSplitInputTrace),events=>events.some(event=>event.type==='dragend'&&event.trusted),'trusted native dragend');
            assertNativeSplitDragTrace(trace,{sourceId,targetId,allowed});await checkpoint(allowed?'native-drag-delivered':'native-rejected-drag-delivered',{trace});
        }finally{
            if(mouseDown){
                // A failed assertion cannot authorize releasing a still-held
                // native drag into an ordinary reorder destination.
                const cancelled=await cancelNativeSplitDrag({page:sidebar.page,client:favoriteDragInputClient(sidebar.page),poll,sourceId}).catch(()=>null);
                if(cancelled)await sidebar.page.mouse.up();
            }
            await geometry.source.dispose();await geometry.target.dispose();
        }
    });
    try{
        await option('syncTabGroups',false);await option('invertTabOrder',false);await option('todayNewTabsAtTop',false);
        await apiPage.evaluate(windowId=>chrome.windows.update(windowId,{state:'normal',left:0,top:0,width:1200,height:900}),windowId);
        const seed=await apiPage.evaluate(async({base,windowId,spaceId})=>{const ids=[];for(const suffix of ['left','middle','right','twin','blocked']){const tab=await chrome.tabs.create({windowId,url:`${base}/${suffix}`,active:false});ids.push(tab.id);const response=await chrome.runtime.sendMessage({type:'spaceStore',action:'assign',tabId:tab.id,spaceId,pinned:false,newTodayTab:true});if(!response.success)throw new Error(response.error);}return ids;},{base:`${fixture.base}/native-split/${nonce}`,windowId,spaceId});owned.push(...seed);
        const unaffected=await apiPage.evaluate(async({url,windowId,spaceId})=>{const tab=await chrome.tabs.create({windowId,url,active:false});const response=await chrome.runtime.sendMessage({type:'spaceStore',action:'assign',tabId:tab.id,spaceId,pinned:false,newTodayTab:true});if(!response.success)throw new Error(response.error);return {id:tab.id,url};},{url:`${fixture.base}/native-split/${nonce}/middle?unaffected`,windowId,spaceId:unaffectedSpace.id});owned.push(unaffected.id);
        await poll(()=>apiPage.evaluate(ids=>Promise.all(ids.map(id=>chrome.tabs.get(id))),[...seed,unaffected.id]),tabs=>tabs.every(tab=>tab.status==='complete'),'all native split and unaffected-Space documents loaded');
        // Resolve each initial URL once, then navigate the same known twin target
        // to the left URL. No host permission or injected content script is needed.
        const targets=await apiPage.evaluate(()=>chrome.tabs.query({}));
        for(const id of seed){const tab=targets.find(item=>item.id===id);pages.set(id,await pageForUrl(tab.url));}
        const twinNavigation=pages.get(seed[3]).waitForNavigation({waitUntil:'domcontentloaded'});
        await apiPage.evaluate(({id,url})=>chrome.tabs.update(id,{url}),{id:seed[3],url:targets.find(tab=>tab.id===seed[0]).url});
        await twinNavigation;
        await poll(()=>pages.get(seed[3]).evaluate(readNativeSplitPage),state=>state.url===targets.find(tab=>tab.id===seed[0]).url&&Boolean(state.documentId),'same known twin target navigated to duplicate URL');
        const cdp=await browser.target().createCDPSession();let infos;
        try{infos=(await cdp.send('Target.getTargets')).targetInfos;}finally{await cdp.detach();}
        assert.equal(pages.size,seed.length);
        for(const[id,page]of pages){await ui(page,'Type unique preserved state in exact native page',()=>page.type('#split-input',`-${id}`));assert.equal(page.frames().length,1);}
        sidebar=await newTabPage(`chrome-extension://${arcifyId}/sidebar.html`);owned.push(sidebar.tab.id);
        await sidebar.page.evaluate(installNativeSplitInputTrace);
        await sidebar.page.waitForFunction(ids=>ids.every(id=>document.querySelector(`.space.active [data-tab-type="temporary"] .tab[data-tab-id="${id}"]`)),{polling:50},seed);
        const request={tabIds:[seed[0],seed[2]],windowId,spaceId};
        const before=await ui(sidebar.page,'Capture baseline before nonadjacent real drag',read);assert(Math.abs(exactTab(before,seed[0]).index-exactTab(before,seed[2]).index)>1);
        await drag(seed[0],seed[2]);const created=await awaitPair(request);const pair=assertNativeSplitCreated(before,created,request);await badges(request.tabIds);const outlines=await sidebar.page.evaluate(readNativeSplitAffordances);assertNativeSplitOutline(outlines,request);await checkpoint('native-split-shared-group-outline',{outlines});await capture('native-split-two-today-badges');
        await ui(pages.get(seed[0]),'Capture both native Split View panes and browser chrome',async()=>{
            const native=await captureNativeWindow({nonce,colors:[[248,215,218],[211,244,224]]});await checkpoint('native-split-window-screenshot',{native,pair});
            const views=await Promise.all(request.tabIds.map(async id=>({id,...await pages.get(id).evaluate(()=>({visibility:document.visibilityState,topLevel:window===window.top,frames:document.querySelectorAll('iframe,frame').length,width:innerWidth,height:innerHeight}))})));assert(views.every(view=>view.visibility==='visible'&&view.topLevel&&view.frames===0&&view.width>0));await checkpoint('native-split-real-visible-panes',{views});
        });
        await checkpoint('native-split-drag-created',{before,after:created,pair,cdpTargets:infos.filter(info=>info.url.startsWith(`${fixture.base}/native-split/${nonce}/`))});
        // Both pane links are served localhost anchors. They require real trusted
        // input and Chrome's observed openerTabId, never a synthetic gesture.
        for (const openerId of pair.tabIds) {
            const page = pages.get(openerId); await ui(page, 'Focus original native split pane for a real child link', async () => {});
            await page.evaluate(installTodayOrderTrace);
            const childBefore = await read();
            await ui(page, 'Click one served child link from the exact native split pane', () => page.click('#today-order-child'));
            const childReceipt = await poll(async () => { const tabs = await apiPage.evaluate(async ids => (await chrome.tabs.query({})).filter(tab => !ids.includes(tab.id)).map(({ id, openerTabId, windowId, status, pendingUrl }) => ({ id, openerTabId, windowId, status, pendingUrl })), childBefore.tabs.map(tab => tab.id)); for (const tab of tabs) if (!owned.includes(tab.id)) owned.push(tab.id); return tabs; },
                tabs => tabs.length === 1 && tabs[0].status === 'complete' && !tabs[0].pendingUrl, 'one completed native child from the trusted split-pane link');
            assert.equal(childReceipt[0].openerTabId, openerId);
            const trace = await page.evaluate(() => globalThis.__todayOrderTrace); assertTodayOrderInput(trace, { type: 'click', elementId: 'today-order-child' });
            const childRead = async () => ({ ...await read(), snapshot: await snapshot(windowId), rendered: await sidebar.page.evaluate(readTodayOrderSidebar) });
            const childAfter = await ui(sidebar.page, 'Inspect actual Today order after split-pane child creation', () => poll(childRead, state => {
                try { assertNativeSplitChild(childBefore, state, { pair, openerId, inverted: representation.inverted }); return true; } catch { return false; }
            }, 'child immediately below the complete native split pair in real rows and authenticated snapshot'));
            const proof = assertNativeSplitChild(childBefore, childAfter, { pair, openerId, inverted: representation.inverted });
            await checkpoint('native-split-trusted-child-after-complete-pair', { before: childBefore, after: childAfter, proof, trace });
            await apiPage.evaluate(id => chrome.tabs.remove(id), proof.childId);
            const childClosed = await poll(read, state => { try { assertNativeSplitPagesPreserved(childBefore, state); assert.deepEqual(state.spaces, childBefore.spaces); assertNativeSplitPair(state, pair); return true; } catch { return false; } }, 'exact child cleanup restores the original split identities and canonical order');
            await checkpoint('native-split-child-cleanup', { childId: proof.childId, state: childClosed });
        }
        // Switching Spaces and group sync are real user paths, with an existing
        // pair identity required throughout. No createSplit reissue is allowed.
        const other=initial.spaces.find(item=>item.id!==spaceId);assert(other);
        // A real native split must never leak into the new ordinary Today Move path.
        await select(request.tabIds); await menu(seed[0]);
        await sidebar.page.waitForSelector('#tab-context-menu [data-action="endSplitView"]',{visible:true});
        assert.equal(await sidebar.page.$('#tab-context-menu [data-action="moveTodayTabsToSpace"]'),null,'Native Split View selection cannot offer ordinary Today Move.');
        await clear();
        const beforeMoveRejection=await read();
        // Negative safety probe only: every successful Move case uses genuine menu input.
        const rejectedMoveRequest={
            type:'moveTodayTabsToSpace',windowId,spaceId,bookmarkFolderId:space.bookmarkFolderId,
            destinationSpaceId:other.id,destinationBookmarkFolderId:other.bookmarkFolderId,inverted:representation.inverted,
            entries:request.tabIds.map(tabId=>({tabId,url:exactTab(beforeMoveRejection,tabId).url}))
        };
        const rejectedMove=await sidebar.page.evaluate(message=>chrome.runtime.sendMessage(message),rejectedMoveRequest);
        assertTodayMoveRejected(rejectedMove,rejectedMoveRequest);
        const afterMoveRejection=await read();assertNativeSplitRejected(beforeMoveRejection,afterMoveRejection);
        await checkpoint('native-split-today-move-rejected',{before:beforeMoveRejection,after:afterMoveRejection,reply:rejectedMove});
        for(const targetSpace of [other.id,spaceId]){await ui(sidebar.page,'Switch Space without breaking native pair',()=>sidebar.page.click(`#spaceSwitcher button[data-space-id="${targetSpace}"]`));await poll(()=>snapshot(windowId),state=>state.activeSpaceId===targetSpace,'requested Space activation');assertNativeSplitPair(await read(),pair);}
        for(const enabled of [true,false]){await option('syncTabGroups',enabled);const state=await poll(read,state=>{try{return assertNativeSplitPair(state,pair).groupId===pair.groupId;}catch{return false;}},'native pair survives group-sync transition without regrouping split members');assertNativeSplitPagesPreserved(before,state);
            const deferred=await poll(()=>apiPage.evaluate(()=>chrome.storage.session.get('spaceGroupSplitDeferrals')),data=>enabled?data.spaceGroupSplitDeferrals?.some(item=>item.windowId===windowId&&item.spaceId===spaceId&&item.reason==='native-split'):!data.spaceGroupSplitDeferrals?.some(item=>item.windowId===windowId&&item.spaceId===spaceId),'explicit native split group-layout deferral');
            await ui(sidebar.page,'Observe native Split View grouping guidance',async()=>{await sidebar.page.waitForFunction(({enabled})=>{const notice=document.getElementById('todaySplitDeferralStatus');return notice&&(enabled?!notice.hidden&&/End Split View/.test(notice.textContent):notice.hidden);},{polling:50},{enabled});if(enabled)await screenshot(sidebar.page,'native-split-group-layout-explicitly-deferred',true);});
            let unaffectedProjection;
            if(enabled){
                const request={pair,tabId:unaffected.id,spaceId:unaffectedSpace.id,name:unaffectedSpace.name,color:unaffectedSpace.color};
                const projected=await poll(read,state=>{try{assertUnaffectedSpaceProjection(state,request);return true;}catch{return false;}},'unaffected same-window Space grouped and collapsed while only native split Space defers');
                assertNativeSplitPagesPreserved(before,projected);unaffectedProjection=assertUnaffectedSpaceProjection(projected,request);
                await checkpoint('native-split-unaffected-space-projected',{seed:unaffected,proof:unaffectedProjection,state:projected});
            }
            await checkpoint(`native-pair-group-sync-${enabled}`,{state,pair,deferred,...(unaffectedProjection?{unaffectedProjection}:{})});}
        await menu(seed[0]);const beforeEnd=await read();await action('endSplitView');const ended=await poll(read,state=>request.tabIds.every(id=>exactTab(state,id).splitViewId===-1),'both exact native pages unsplit');assertNativeSplitEnded(beforeEnd,ended,request);await capture('native-split-ended-both-today-pages-open');await checkpoint('native-split-ended',{before:beforeEnd,after:ended});
        await sidebar.page.evaluate(()=>{globalThis.__nativeSplitInputTrace.length=0;});
        await select(request.tabIds);await menu(seed[0],true);const beforeKeyboard=await read();await action('createSplitView',true);const keyboardCreated=await awaitPair(request);const keyboardPair=assertNativeSplitCreated(beforeKeyboard,keyboardCreated,request);await badges(request.tabIds);await focusRetained(seed[0]);await checkpoint('native-split-keyboard-created',{before:beforeKeyboard,after:keyboardCreated,pair:keyboardPair});
        const keyboardTrace=await sidebar.page.evaluate(()=>globalThis.__nativeSplitInputTrace.filter(event=>event.type==='keydown'));
        assertNativeSplitKeyboardTrace(keyboardTrace,{tabId:seed[0],actions:['createSplitView']});await checkpoint('native-split-trusted-keyboard-input',{keyboardTrace});
        await menu(seed[0],true);const beforeKeyboardEnd=await read();await action('endSplitView',true);
        const afterKeyboardEndInput=await sidebar.page.evaluate(readNativeSplitSidebarState);
        await checkpoint('native-split-keyboard-end-submitted',{sidebar:afterKeyboardEndInput});
        assertNativeSplitKeyboardTrace(afterKeyboardEndInput.inputTrace,{tabId:seed[0],actions:['createSplitView','endSplitView']});
        const keyboardEnded=await poll(read,state=>request.tabIds.every(id=>exactTab(state,id).splitViewId===-1),'keyboard end native split');assertNativeSplitEnded(beforeKeyboardEnd,keyboardEnded,request);await focusRetained(seed[0]);
        await checkpoint('native-split-keyboard-ended',{before:beforeKeyboardEnd,after:keyboardEnded});
        // A three-row selection offers no split action, and Escape cannot mutate
        // native tabs or canonical Today order.
        await select([seed[0],seed[2],seed[1]]);const overSelectedBefore=await read();await menu(seed[0]);
        assert.equal(await sidebar.page.$('#tab-context-menu [data-action="createSplitView"]'),null);
        assert.match(await sidebar.page.$eval('#tab-context-menu',node=>node.textContent),/exactly two Today tabs/);
        await clear();assertNativeSplitRejected(overSelectedBefore,await read());await checkpoint('native-split-three-selection-rejected',{});

        // Mismatched native groups are a real incompatible destination; selecting
        // an incompatible hidden Split target must not become an ordinary reorder.
        // Chrome's default is the API caller's window, not this sidebar's window:
        // https://developer.chrome.com/docs/extensions/reference/api/tabs#method-group
        const beforeGrouping=await read();
        const groupId=await apiPage.evaluate(createNativeSplitFixtureGroup,{tabId:seed[4],windowId});
        const groupRequest={sourceId:seed[0],targetId:seed[4],windowId,spaceId,groupId},afterGrouping=await read();
        await checkpoint('native-split-incompatible-group-setup',{request:groupRequest,before:beforeGrouping,after:afterGrouping});
        assertNativeSplitIncompatibleSetup(beforeGrouping,afterGrouping,groupRequest);
        await select([seed[0],seed[4]]);await menu(seed[0]);
        await sidebar.page.waitForFunction(()=>/same native tab group/.test(document.getElementById('tab-context-menu')?.textContent||''),{polling:50});
        assert.equal(await sidebar.page.$('#tab-context-menu [data-action="createSplitView"]'),null);
        await clear();
        const rejectedBefore=await ui(sidebar.page,'Capture incompatible native group baseline',read);assertNativeSplitIncompatibleSetup(beforeGrouping,rejectedBefore,groupRequest);
        await drag(seed[0],seed[4],{allowed:false});await sidebar.page.waitForFunction(()=>!document.getElementById('spacesList')?.classList.contains('today-split-dragging'),{polling:50});
        const rejectedAfter=await read();assertNativeSplitRejected(rejectedBefore,rejectedAfter);await checkpoint('native-split-incompatible-target-hidden-cancelled',{before:rejectedBefore,after:rejectedAfter});
        return evidence;
    }catch(error){
        primaryError=error;
        const sidebarState=sidebar?await sidebar.page.evaluate(readNativeSplitSidebarState).catch(captureError=>({error:captureError.message})):null;
        await checkpoint('native-split-failed',{error:{message:error.message,stack:error.stack},sidebar:sidebarState}).catch(()=>{});
        // Never foreground a background tab just for failure diagnostics.
        if(sidebarState?.visibility==='visible'&&sidebarState.hasFocus)await screenshot(sidebar.page,'native-split-failure-sidebar',true).catch(()=>{});
        throw error;
    }
    finally{await finishBookmarkFixture([
        ()=>apiPage.evaluate(async ids=>{const live=new Set((await chrome.tabs.query({})).map(tab=>tab.id));const present=ids.filter(id=>live.has(id));if(present.length)await chrome.tabs.remove(present);},owned),
        ()=>option('syncTabGroups',Boolean(settings.syncTabGroups)),()=>option('invertTabOrder',settings.invertTabOrder!==false),()=>option('todayNewTabsAtTop',settings.todayNewTabsAtTop!==false)
    ],primaryError,record);}
}
